# B10 kit: invariant oracle and parametrized family suites (design r2, after Codex design r1)

Repo `kauro-platform`, base `main` a7315df, branch `b10/kit`. r1 = e816e95 (REJECT, 12 findings B10-KIT-R1..R12; resolution table
in section 8). Governing docs: `docs/design/FAILURE-MATRIX-TEMPLATE.md` (columns, family rules 1-10), `docs/design/FAULT-HARNESS.md`
(evidence ownership, per-kind proof), `docs/design/B10-failure-matrix.md` (GAP list 262-637), `docs/design/B10-commercial-domain.md`
(decisions D10-*). Review question: can a member pass without its fault at the named boundary, or can the oracle be silenced or
fire on a legal state?

## 1. Goals and non-goals

- G1. Invariant oracle: independent SQL over committed state, zero rows required, run after every B10 DB test and after every
  family cell. Legal exceptions live in the predicates (with positive controls), never in an exemption API.
- G2. Parametrized runner: a member declares data, the boundary witnesses and its postconditions; the runner owns orchestration
  (pause, crash, clock, lock holder, recovery order) so a member cannot manufacture its proof.
- G3. Families: CMD_TMO (+BUYER_TMO), CMD_CRA, TEN_REV, SWEEP_CRASH/PAR/RACE/TMO, CONS_CRB/CRA/TMO, LEASE (CONS_LEASE_EXP,
  dispatcher CRB/CRA, DELIV_CRASH, DELIV_CLAIM, LEASE_CRASH, LEASE_TMO). 106 matrix cells.
- Non-goals: no change to `packages/persistence/src/testing/faults/*` (frozen; `mustWait`, `observeBlocked`, `settlesOrWaits`
  unchanged; the race statement allowance stays; the 1500 ms statement timeout is set only for an explicit timeout attempt and
  restored in `finally`). PAY_, CLOSE_, FUNDS_, CONV_, REPL_, QUOTE_PAR keep dedicated tests.
- Independence (Q4, mandatory for the whole oracle): no call to `payoutCash`, `kauro.payout_lines_unpayable`, `composeStatement`,
  `lineDueForEligibility`, `kauro.eligibility_findings`, domain allocation helpers or product views. Arithmetic is re-implemented
  in SQL from the decision text and checked on the worked examples' integer cents (examples 1, 2, 5, 6, 7, 8, 19, 20, 25).

## 2. Oracle (`packages/persistence/src/testing/invariants.ts`, exported from `@kauro/persistence/testing`)

```ts
export interface Invariant { readonly id: `INV-${string}`; readonly decision: string; readonly sql: string; readonly kind: "STATE" | "WITNESS"; }
export const B10_INVARIANTS: ReadonlyArray<Invariant>;
export async function installWitnesses(superuser: Client): Promise<void>;   // test database only, idempotent
export async function assertInvariants(oracle: Client, opts?: { readonly label?: string }): Promise<void>; // all ids, LIMIT 5 rows each
export function invariantsAfterEach(oracle: () => Client): void;           // top-level line in each B10 DB test file
```

No `allowBreach` (R5). A test that seeds a forbidden state through the superuser to prove a guard does it inside a superuser
transaction it rolls back, or restores the rows, before its end; the kit converts the existing such fixtures (list produced by a
first run of the oracle over all B10 files; each conversion in the kit's commit, named in its message). A violation that is not
such a fixture is a finding, not an exemption.

Two kinds of invariant (R1, R2: current state vs historical legality):
- STATE: must hold at every instant on committed rows (also callable while a holder is paused).
- WITNESS: legality at the instant of a write. `installWitnesses` creates schema `kauro_test` and AFTER INSERT ROW triggers on
  `kauro.payout_intents` that copy, from the inserting transaction's own snapshot, the facts the approval was licensed on:
  latest bank-evidenced settlement (`kauro.settlements`, `bank_evidence_hash IS NOT NULL ORDER BY observed_at DESC, settlement_id
  DESC`), the claimed set recomputed independently, the destination row, and per itemized line its latest funds observation and
  OPEN holds. CMD052 holds the cash lock (`lockPayoutCash`, D10-GAP-1) and the line subjects' shared halves (D10-GAP-8, 24) from
  before its reads to COMMIT, so the trigger's snapshot is exactly the basis the approval serialized against; a rolled-back
  approval rolls its witness back. Triggers only read and insert into `kauro_test` (SECURITY DEFINER, owned by the superuser,
  never in a migration, never in production: architecture gate covers `testing/`).

| id | kind | zero rows of | decision / legal cases kept (positive control) |
|---|---|---|---|
| INV-01 | STATE | a line with more than one LINE item of disposition PAYABLE in statements not CORRECTED | mig 0039, D10-GAP-8 |
| INV-02 | WITNESS | an intent whose witness shows an itemized PAYABLE line with latest funds not AVAILABLE (none = not available) | D10-GAP-23/24; legal: HELD fact after the approval (FUNDS_FENCE approval-first order) |
| INV-03 | WITNESS | an intent whose witness shows claimed + amount > bank_available of the witnessed settlement, claimed = AUTHORIZED, SUBMITTED, UNCERTAIN, plus SETTLED with no bank-evidenced settlement observed strictly after `settled_at` (excluding the new intent) | D10-GAP-1 (B10G-R3); legal: lowering settlement after the approval (PAY_CASH_BASIS) |
| INV-04 | STATE | more than one intent in AUTHORIZED, SUBMITTED, UNCERTAIN, SETTLED per statement | D10-PAY-2 |
| INV-05 | STATE | a SETTLED intent whose statement is not PAID; a PAID statement without exactly one SETTLED intent (line states not judged) | D10-GAP-5; legal: PAID line later ADJUSTED (R2-104) |
| INV-06 | STATE | a line in HELD with no OPEN hold on it | D10-HOLD-1; legal: OPEN partial hold on a line whose unheld net was paid (R2-102); OPEN hold on a VOID line |
| INV-07 | WITNESS | an intent whose witnessed destination row at (`destination_id`, `destination_version`) was not VERIFIED or not the seller's | D10-PAY-3, D10-GAP-3; legal: destination later SUPERSEDED |
| INV-08 | STATE | a claim-based entitlement whose claim is not CONVERTED; a CONVERTED claim without its entitlement | D10-TERM-1; CONV_* |
| INV-09a | STATE | adjustment chain broken: per line by `adjustment_seq`, seq 1 `previous_cumulative_cents` = the line's first posting, each next `previous` = prior `new_cumulative_entitlement_cents`, `new = previous ± amount`, last `new` = line `cumulative_entitlement_cents` | D10-ADJ-1 (R3) |
| INV-09b | STATE | current arithmetic: pool `pool_cents` != basis x rate rounded once; per pool with a frozen allocation, lines' cumulative != largest-remainder split by `share_bps`, ties by beneficiary id; lines with SPLIT_CORRECTION or AGREED_ERROR_CORRECTION adjustments excluded (corrections, checked by INV-14) | D10-POOL-1 (R3); control: 100 posted, -20 refund -> pool 80, line 80 |
| INV-10 | STATE | shares of a frozen allocation not summing to 10000 bps | D10-POOL-1; only allocations ACCEPTED (frozen) |
| INV-11 | STATE | live reservations (RESERVED, RECONCILIATION_HOLD, CONSUMED) of a policy above its `founding_slots`; a live reservation not the `live_reservation_id` of exactly one slot with `live_agency_id` = its agency, or the reverse | D10-FOUND-1..5 (R12) |
| INV-12 | STATE | `agency_recurrence.first_capture_id` missing while the agency has a qualifying purchase with confirmation seq 1, or naming another capture; `agencies.first_qualifying_capture_id` neither NULL nor equal to it | D10-FIRST-1/2: recurrence atomic, agencies mirror asynchronous (R2) |
| INV-13 | STATE | a paid purchase with two non-REVOKED authorizations after replacement; two spent allowances for one purchase | D10-QUOTE-3/4 |
| INV-14 | STATE | a CORRECTED statement with an intent not FAILED/RETURNED; a predecessor with two successors | D10-GAP-7 |
| INV-15 | STATE | a line of a TERMINATED seller whose capture confirmed after `terminated_at` and whose entitlement was not ACTIVE at that confirmation (window covers it, created before termination) and has no `termination_tail_entries` row covering it | D10-TERM-1, D10-GAP-22; legal: existing residual entitlement (R2) |
| INV-16 | STATE | statement `payable_cents` != sum of its items' `payable_cents`; `held_cents` != sum of `held_cents`; `accrued_pending_cents` != sum over AWAITING_* items | D10-STMT-1 (R4) |
| INV-17 | STATE | an intent `amount_cents` != its statement's `payable_cents` | D10-PAY-1 (R4) |
| INV-18 | STATE | line `paid_cents` != sum of `payable_cents` of its LINE items in PAID statements | D10-PAY-2 (R4); control: R2-104 ADJUSTED after paid |
| INV-19 | STATE | an OFFSET item or `commission_offsets` row without signed offset terms (`agreement_id` with offset terms), or an offset above the negative line's negative position | D10-NEG-1, KC017 (R4) |
| INV-20 | STATE | a line ELIGIBLE, PAYABLE or PAID whose `final_completion_id` is not a FINAL `purchase_completions` row of its purchase, or `eligible_at` < that completion + 720 h | D10-ELIG-1 (R4) |

Self-test `packages/persistence/test/invariants.test.ts`: per id one negative control (isolated rows seeded in a superuser
transaction, exactly that id fires) and each listed legal case as a positive control (nothing fires); WITNESS ids prove that a
rolled-back approval leaves no witness. Codex's reproductions R1-R4 are tests there verbatim.

## 3. Unit routing (kit-owned `apps/api/test/fault-support.ts`; frozen harness untouched)

- Invocation-scoped counter (R6): `Route` (one per `faults.on` / `onRoles` invocation) owns `unitSeq`; every `run` of the routed
  factory, whichever proxy access created it, takes the next ordinal; a retried transaction inside one run is attempt n of that
  ordinal. Each unit gets its own statement log (step label, params, `.before`/`.after`, 57014 or other error).
- Target unit: a member names `unit: { ordinal, phase, witness: SqlStep & { identity } }`. The routing wraps that ordinal with
  `crashableFactory(inner, points, "target")` (cell `at: "target"`), every other unit with `"uow"`. After the body the runner
  asserts the target unit's log passed `witness.after` with params matching `identity(fixture)`; absent or in another unit ->
  the cell fails "target unit is another phase". Phase tables, from the code: QUOTE_EXPIRY ordinal 1 = `dueReservations` list
  (`sweeps.ts` 70), 2 = item effect (72-99: quote transition, `founding.release`/`holdForReconciliation`); ACCRUAL_RECONCILIATION
  1 list, 2 conversion, 3 lacking list, 4 accrual (108-131); CLAIM_WINDOWS, ENTITLEMENT_WINDOWS 1 list, 2 effect; ELIGIBILITY
  phases completions / funds-hold release / held-funds lines / ELIGIBLE (185-226), each with its own list unit; PERIODS open /
  list / propose / close (`periods.ts`). Fixtures hold exactly one due item so the ordinal is fixed; the witness proves it.
- `onRoles({ kauro_control: c1, kauro_commission: c2 }, points, steps, fn)` (R11): the dispatcher's `units.run(control(), ...)`
  (`dispatcher.ts` 79, 86, 110) route to c1, the consumer's SERVICE units to c2; one counter across both.
- Port hook `FaultRouting.ports`: wraps a bound port with `instrumentPort` so its `.before` (arrival) is recorded in the operation
  scope; a never-answering variant is used only when the binding is out of process.

## 4. Member contract (R7, R8)

```ts
export interface Member<F, A> {
  readonly code: string; readonly cell: string; readonly variant?: string; readonly tag: string;   // matrix row/column verbatim; unique tag
  readonly roles: Partial<Record<RouteRole, Login>>;
  fixture(label: string): Promise<F>;
  act(ctx: FaultContext, f: F, key: string): Promise<A>;              // the step; HTTP replies normalized: non-2xx -> throw Refused(status, code)
  readonly point: FaultPoint<F>;
  readonly tables: ReadonlyArray<string>;                            // footprint: every table the matrix row writes + command_journal + outbox
  failed(f: F, failure: unknown): Promise<void>;                     // asserts the refusal AND what must survive (e.g. CMD027 S2r/S3: RESERVED journal, the intent's durable work)
  committed?(f: F, answer: A): Promise<void>;                        // crash-after: cents, beneficiaries, states, versions, journal answer
  recover(ctx: FaultContext, f: F, key: string): Promise<unknown>;    // same key | redelivery of the same delivery | next pass | takeover
  recovered(f: F, recovery: unknown): Promise<void>;                 // exactly-once effect by durable identity, earlier commits preserved
  readonly expect: string;
}
type Id<F> = (f: F) => (params: ReadonlyArray<unknown>) => boolean;
export type FaultPoint<F> =
  | { kind: "lock-timeout"; hold(holder: HarnessConnection, f: F): Promise<void>; waits: SqlStep; identity: Id<F> }
  | { kind: "port-timeout"; port: PortName; boundMs: number; waits?: SqlStep }               // see 5.2
  | { kind: "crash-before" | "crash-after"; unit: UnitTarget<F> }
  | { kind: "partial"; unit: UnitTarget<F>; completed: SqlStep; failing: SqlStep; identity: Id<F> }
  | { kind: "twice"; unit: UnitTarget<F>; holdAfter: SqlStep; identity: Id<F> }
  | { kind: "membership"; holdAfter: SqlStep; revoke(c: HarnessConnection, f: F): Promise<void>; refusal: (e: unknown) => boolean }
  | { kind: "step-up-expiry"; waitOn(holder: HarnessConnection, f: F): Promise<void>; proofExpiresAt(f: F): string }
  | { kind: "lease"; scenario: LeaseScenario };
```

Runner checks independent of the member: footprint = rows of `tables` keyed by primary key, snapshot before `act`; a success
path must change at least one declared money or state table (refuses a journal-only footprint); before any recovery both raced
reports are checked with `mustHaveSettled` and the background sink (`failures`) must hold no new entry unless the member expects
one; sweep recovery is judged by `recovered` on rows, never by the report (an already-done item may be absent from it); after
every cell, `assertInvariants`.

## 5. Templates (each ends with `assertInvariants(oracle, { label: tag })`)

5.1 lock-timeout (`race`): holder BEGIN + `hold`; `ctx.mustWait` runs `act` on the waiter; the routing records `waits.before` with
matching params in the act's scope, no `waits.after`, and the act's error chain carries SQLSTATE 57014 from that call (R7: a
member whose `waits` is not the statement that waited fails, so two members on one early lock cannot both pass); `failed`;
footprint unchanged except what `failed` declares surviving; holder ROLLBACK; `recover` with the same key; `recovered`.
Pattern: `b10-failure-cells-close2.test.ts` 463-530.

5.2 port-timeout (`timeout`), only where the path calls the port (R9; code evidence): `BuyerTypeReader.buyerTypeOf(uow, ...)` in
CMD047 (`accept-attribution.ts` 79) and CMD027; `PreparationCompletionSource.completionsOf(uow, ...)` only in `recordCompletions`
(`ledger-effects.ts` 318), reached by `commercial_authorization.delivered.v1` and ELIGIBILITY phase 1; `ActiveWorkInspector.
inspectClient` (CMD043, `close-agency.ts` 81, 6a); `PurchaseRebinder.rebind` (`replacement.ts` 214, 6a). The ports take `uow`, so
the B10 bindings are database reads: the member is a lock-timeout on the table the binding reads, with `waits` = the binding's
statement and the arrival `.before` of the instrumented port recorded first. For an out-of-process binding the application's own
bound is the deadline (`ctx.deadline`, crossed while the call is in flight, consumed by the operation); none exists today, so such
a member is RED and a product GAP (6a/6b/6c owner), with a mutation removing the bound that turns it RED again.
Cells whose path never calls a port (R9) use their own boundary: CONS_TMO capture.completed (pool/line insert waiting on the
capture's line subjects), refund/reversal (adjustment write on the line lock), funds_observed HELD/AVAILABLE (`fenceLinesOfCapture`
advisory wait, D10-GAP-24), claim conversion (claim row lock); SWEEP_TMO QUOTE_EXPIRY = lock-timeout on the quote row at
`uow.commerce.quotes.transition` (the release guard is SQL, `sweeps.ts` 83), CLAIM_WINDOWS/ENTITLEMENT_WINDOWS/ACCRUAL/PERIODS on
their effect statements.

5.3 crash-before / crash-after (`crash-before-commit` / `crash-after-commit` at `target`): arm `target.before-commit` (or
`.after-commit`); witness check (section 3); `failed` (before: footprint unchanged, delivery/journal unsettled) or `committed`
(after: the effect is durable); `recover`; `recovered` (before: effect once; after: identical replay answer or no new row).
Rule 2: the witness is the effect's last write. Rule 5: the crash is mandatory; a replay alone is not a member.

5.4 partial (`partial`): `ctx.partial(what, "db.<failing>.before", act)`; the runner requires `completed` and `failing` to be writes
(INSERT/UPDATE/DELETE regex), both in the target unit's log, `completed.after` with the identity params before `failing.before`;
footprint unchanged including journal; `recover`; `recovered`. Pattern: `b10-failure-cells-accrual.test.ts` 61-120.

5.5 twice (`race`, Q3 accepted with Codex's conditions): pass A pauses at `holdAfter.after` in the target unit (identity params),
pass B is observed waiting (`mustWait`) on A; release; then the reverse order as a second member (rule 1). Both reports through
`mustHaveSettled`, sink checked, then the durable footprint shows one effect; no recovery is credited.

5.6 membership revocation (`revocation`, R10), three phases as PAY_REV does (`b10-failure-cells-pay.test.ts` 275-330):
(a) the revocation holds first: control connection BEGIN + `revoke`; the command waits on the membership's shared transition lock
(`kauro.await_transition`, `tenancy.ts` 69-76), observed with `mustWait`; `ctx.revoked(() => COMMIT)`; the command is refused
403 NOT_AUTHORIZED, writes nothing. (b) the command holds first: paused at `holdAfter` (after its guard, holding the shared half),
the revocation is observed waiting on it, the command commits, then the revocation commits (credited with `ctx.revoked`); the
effect stands (authority valid at its commit). (c) `ctx.fenced` a later call, `refusal` built from `Refused`.
5.7 step-up expiry (`expiry`): CMD043 only. `ctx.deadline(proofExpiresAt)`; the command waits on `waitOn`'s lock; the clock crosses
the deadline while it waits; consumed by the unit via `faults.clock = op.clock` (`onServer`); 403 ASSURANCE_REQUIRED STEP_UP_STALE
as CMD052's `[gstepupwait]` (D10-GAP-11/14). TEN_REV = CMD002 (a, b), CMD043 membership (a, b) and step-up, CMD027 OWNER and
AGENCY_BILLING (a, b).

## 6. Lease scenarios (R11)

`LeaseScenario = { stop: Stop; expire: boolean; takeover: boolean; delivery?: number }`, dispatcher A on `onRoles`, B a second
`createCommissionDispatcher` with its own owner id. Deadlines: lease TTL (`DISPATCH_LEASE_SECONDS`) and delivery claim
(`OUTBOX_CLAIM_SECONDS`) declared with `ctx.deadline`, consumed by B's `uow.leases.claim` / `uow.outboxDispatch.claim` through the
port hook (instant argument), as B06-R1 does.

| member | stop (code) | proof | expected |
|---|---|---|---|
| LEASE_CRASH crb | control unit 1 (lease claim) `target.before-commit` | crash-before | no lease row change; B claims at fence n |
| DELIV_CRASH cra-lease | control unit 1 `target.after-commit` | crash-after | lease held by dead A; B takes over after TTL at fence n+1 |
| DELIV_CRASH crb-batch | control unit 2 (`outboxDispatch.claim`, 86) `target.before-commit` | crash-before | no record CLAIMED |
| DELIV_CRASH cra-batch | control unit 2 `target.after-commit` | crash-after | records CLAIMED by A; reclaimed by B after the claim deadline, each delivered once |
| CONS_CRB dispatcher | consumer SERVICE unit of delivery k `target.before-commit`, witness = its effect write | crash-before | no effect; record redelivered; effect once |
| CONS_CRA dispatcher | consumer unit k `target.after-commit` (before `DELIVERY_BEFORE_SETTLE`, 108) | crash-after | effect durable; redelivery adds nothing; record settled once |
| DELIV_CRASH partial | after delivery 1 settled, crash before delivery 2's effect | partial | 1 settled, 2 reclaimed and delivered once |
| CONS_LEASE_EXP | consumer unit k paused at `target.before-commit`; TTL crossed; B takes over and delivers k; A released | race | A's late effect COMMIT: matrix expects refusal by stale fence; code has no fence on the effect unit (only heartbeat/settle, 109-114). Member asserts the matrix expectation; if RED, owner lane 6b decides: fence the effect, or decision D10-GAP-(6b range) amending the row to "adds nothing by durable identity (D10-CONS-1)", amounts asserted (rule 10) |
| DELIV_CLAIM race/expiry/revocation | A between lease claim and batch claim; TTL crossed; B claims lease and batch; A's batch claim and heartbeat refused | race, expiry, revocation | each record CLAIMED by one fenced owner |
| LEASE_TMO lease | lock-timeout holding the lease row, `waits` = `leases.claim` | race | retriable, no ownership assumed |
| LEASE_TMO batch | lock-timeout holding the COMMISSIONS outbox rows `FOR UPDATE`, `waits` = `outboxDispatch.claim` | race | retriable, records unclaimed |

Durable effects asserted once (pools, lines, adjustments, holds, facts by durable identity) while repeated delivery is permitted.

## 7. Families, files, budget

CMD_TMO, BUYER_TMO, CMD_CRA, TEN_REV -> `apps/api/test/b10-family-cmd.test.ts`; SWEEP_* -> `b10-family-sweeps.test.ts`;
CONS_* -> `b10-family-consumer.test.ts`; LEASE -> `b10-family-lease.test.ts`. Runner `apps/api/test/b10-family-runner.ts` exports
`MEMBERS` so the matrix test index (`code | cell | tag | file :: "title"`) is printed from code. ~106 cells x 2-4 s on Linux, four
processes; oracle target < 40 ms per call (measured in its self-test).

## 8. Codex r1 findings -> resolution

| finding | resolution (section) | code evidence |
|---|---|---|
| R1 INV-03 set and time | WITNESS at intent insert, full unsettled set (2, INV-03) | `commercial-statements.ts` 878-895 (`payoutCash`), D10-GAP-1 |
| R2 current vs historical | INV-02, 07 as WITNESS; 05, 06, 12, 15 rewritten with positive controls (2) | mig 0043, D10-GAP-23/24; R2-104; D10-FIRST-1 |
| R3 INV-09 | split 09a chain / 09b current split (2) | `commission_adjustments` previous/new cumulative, mig 0030 |
| R4 conservation | INV-16..20 (2) | `statement_items` kinds/dispositions mig 0031 178-212; `commission_offsets` |
| R5 allowBreach | removed; rolled-back fixtures (2) | |
| R6 sweep unit 1 | ordinal + witness, phase tables (3) | `sweeps.ts` 58-59, 70-99, 108-131, 185-226 |
| R7 boundary witness | `waits`, `completed`+`failing`, `holdAfter`, identity (4, 5.1, 5.4, 5.5) | `fault-support.ts` SqlStep 22-29 |
| R8 postconditions | `failed`/`committed`/`recover`/`recovered`, sink check (4) | `b10-cells-support.ts` 57-74, 121-130 |
| R9 port mapping | 5.2 per path | `ledger-effects.ts` 318, `accept-attribution.ts` 79, `sweeps.ts` 83 |
| R10 TEN_REV | three phases + separate step-up expiry (5.6, 5.7) | `tenancy.ts` 69-76; `b10-failure-cells-pay.test.ts` 275-330 |
| R11 lease | stop table, two roles, claim boundaries (3, 6) | `dispatcher.ts` 79, 86, 93, 108-114 |
| R12 INV-11 | RECONCILIATION_HOLD + slot ownership (2) | design 8.2 FoundingReservation; `founding_slots.live_reservation_id` |

Disagreement: none on substance. Note on R11/CONS_LEASE_EXP: the matrix's "late COMMIT refused by its stale fence" is not what the
code does; the kit tests the matrix text and routes the outcome to a 6b decision rather than weakening the cell.
