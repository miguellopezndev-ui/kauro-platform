# B10 kit: invariant oracle and parametrized family suites (design r3, after Codex design r2)

Repo `kauro-platform`, base `main` a7315df, branch `b10/kit`. r1 e816e95 (REJECT, B10-KIT-R1..R12), r2 7bae306 (REJECT, 1 BLOCKING,
10 MAJOR, most PARTIALLY_FIXED: the oracle kept failing on history-dependent checks). r3 steps back: the ORACLE is narrowed to
invariants that hold at ANY committed state and are computable from base facts alone; every history- or approval-time property
leaves the oracle and is owned by the dedicated cell that already proves it (section 2.3). Resolution table: section 8.
Governing docs: `FAILURE-MATRIX-TEMPLATE.md` (columns, rules 1-10), `FAULT-HARNESS.md`, `B10-failure-matrix.md`, `B10-commercial-domain.md`.

## 1. Goals and non-goals

- G1. Oracle: independent SQL, zero rows required, after every B10 DB test and after every family cell. A predicate is admitted
  only if (a) it reads base facts (immutable rows, or current rows together with the immutable rows that determine them) and (b) no
  legal sequence of committed transactions can falsify it. No witnesses, no triggers, no exemption API (r1 R5 stays fixed).
- G2. Runner: members declare data, boundary receipts and postconditions; the runner owns orchestration so no member manufactures
  its proof. G3 families unchanged: CMD_TMO (+BUYER_TMO), CMD_CRA, TEN_REV, SWEEP_*, CONS_*, LEASE (106 matrix cells).
- Non-goals: `packages/persistence/src/testing/faults/*` frozen (`mustWait`, `observeBlocked`, `settlesOrWaits` unchanged; the race
  statement allowance stays; the 1500 ms statement timeout only inside an explicit timeout attempt, restored in `finally`; SETTLED
  from `settlesOrWaits` never counts as a required wait). PAY_, CLOSE_, FUNDS_, CONV_, REPL_, QUOTE_PAR keep dedicated tests.
- Independence: no `payoutCash`, `payout_lines_unpayable`, `composeStatement`, `lineDueForEligibility`, `eligibility_findings`,
  `commission_offsets_authorized`, `ledger_entries_balanced`, domain helpers or product views; arithmetic re-implemented in SQL and
  checked on the worked examples' integer cents (1, 2, 5, 6, 7, 8, 19, 20, 25).

## 2. Oracle (`packages/persistence/src/testing/invariants.ts`)

```ts
export interface Invariant { readonly id: `INV-${string}`; readonly decision: string; readonly sql: string; }
export const B10_INVARIANTS: ReadonlyArray<Invariant>;
export async function assertInvariants(oracle: Client, opts?: { readonly label?: string }): Promise<void>; // all ids, LIMIT 5 rows each
export function invariantsAfterEach(oracle: () => Client): void;  // one top-level line per B10 DB test file
```
Superuser oracle connection, READ COMMITTED, read-only. Forbidden-state guard fixtures run inside a superuser transaction they roll
back, or restore their rows, before the test ends (the kit converts the existing ones, named in its commit).

### 2.1 Admitted invariants (any committed state, base facts)

| id | zero rows of | why state-valid (code evidence) |
|---|---|---|
| L-01 double entry | per `ledger_entries.event_id` and currency, sum DEBIT != sum CREDIT | B09 entries of one event commit together (deferred balance trigger, mig 0017 361); append-only |
| L-02 reversal | an entry with `reverses_entry_id` not on the same account, currency and amount in the opposite direction; an entry reversed twice | mig 0017 270-300, append-only |
| S-01 item payable derived | a LINE item of disposition PAYABLE with `payable_cents != cumulative_cents - previously_paid_cents - held_cents - offset_cents`, or that difference negative | items immutable (append-only, written DRAFT; mig 0031 167-172 "net of what it withholds and offsets") — the r2 BLOCKING |
| S-02 statement totals | statement `payable_cents` != sum of item `payable_cents`; `held_cents` != sum of item `held_cents` | D10-STMT-2 (mig 0031 comment); items immutable after DRAFT |
| S-03 intent = payable | an intent `amount_cents` != its statement `payable_cents` | D10-PAY-1; statement totals immutable after ISSUED |
| S-04 one live intent | two intents in AUTHORIZED, SUBMITTED, UNCERTAIN, SETTLED for one statement | D10-PAY-2 |
| S-05 paid conservation | a SETTLED intent whose statement is not PAID; a PAID statement without exactly one SETTLED intent; line `paid_cents` != sum of `payable_cents` of its PAYABLE LINE items in PAID statements | CMD053 settles intent, statement and lines in one unit (SETTLE_PAR); line states not judged (R2-104 PAID then ADJUSTED stays legal) |
| S-06 never paid twice | a line itemized PAYABLE in two statements not CORRECTED | mig 0039 rule (KC019) re-expressed independently |
| S-07 offsets | an OFFSET item whose `offset_cents` != its `commission_offsets.amount_cents`; a PAYABLE LINE item whose `offset_cents` != sum of the same statement's OFFSET items against that line; an offset whose `agreement_id` is not the negative line's entitlement agreement or whose `seller_agreements` row lacks signed SIGNED_FUTURE_OFFSET terms; per negative line, sum of offsets > `paid_cents - cumulative_entitlement_cents` | rows append-only (mig 0030 294); the aggregate bound is monotone because no B10 writer issues an INCREASE adjustment (S-09) |
| S-08 pool arithmetic | pool `pool_cents` != `basis_cents` x `rate_bps` rounded once; per pool, the beneficiaries' share split of `pool_cents` (largest remainder by `share_bps`, ties by beneficiary id) minus each line's AGREED_ERROR_CORRECTION decreases != the line's `cumulative_entitlement_cents` | D10-POOL-1, D10-ADJ-1: every basis change recomputes pool and lines in one unit; no exclusion (r2 R3) |
| S-09 corrections evidenced | an INCREASE adjustment; a line whose AGREED_ERROR_CORRECTION decreases exceed the amounts of its UPHELD holds; any SPLIT_CORRECTION row (no B10 writer: grep of `apps/`, `packages/` finds the token only in the CHECK) | D10-ADJ-2 (basis only falls); design 241, 389 (UPHELD posts the correction) — r2 R3 reproduction (chain to 1000 cents) fires here |
| S-10 adjustment chain | per line by `adjustment_seq`: seq 1 `previous_cumulative_cents` != the share split of the pool's `initial_basis_cents`; a later `previous` != prior `new`; `new != previous +/- amount`; last `new` != line cumulative | mig 0030 adjustments immutable; pool `initial_basis_cents` immutable |
| S-11 shares | a frozen allocation (`frozen_at IS NOT NULL`) whose complete `allocation_shares` set does not sum to 10000 bps, read regardless of claim states | r2 R2-05; mig 0029 |
| S-12 founding capacity | live reservations (RESERVED, RECONCILIATION_HOLD, CONSUMED) of a policy above its `founding_slots`; a live reservation not the `live_reservation_id` of exactly one slot whose `live_agency_id` is its agency, or the reverse | r1 R12 (accepted in r2) |
| S-13 holds | a line in HELD with no OPEN hold on it | D10-HOLD-1; legal: OPEN partial hold after the unheld net was paid, OPEN hold on a VOID line (positive controls) |
| S-14 completeness | a pool with no line; a claim-based entitlement whose claim is not CONVERTED, or a CONVERTED claim without one; a qualifying purchase with confirmation seq 1 without the `agency_recurrence` first designation naming its capture; `agencies.first_qualifying_capture_id` neither NULL nor equal to it; a paid purchase with two non-REVOKED authorizations; a CORRECTED statement with an intent not FAILED or RETURNED, a predecessor with two successors | each pair is written in one unit (CONS_PAR, CONV_PAR, D10-FIRST-1, REPL_*, D10-GAP-7); the agencies mirror is asynchronous, so only NULL or equal |

Self-test `packages/persistence/test/invariants.test.ts`: per id one negative control (exactly that id fires) including Codex's
reproductions (r2 R3 chain to 1000 cents -> S-09; r2 R4 item payable 200 on cumulative 100 -> S-01; two 60-cent offsets on a
100-cent negative position -> S-07) and the positive controls named in the table plus R2-102 partial hold, R2-104 negative balance,
example 7 offset; nothing fires on a ledger built by the existing scenario tests.

### 2.2 Removed from the oracle (history or approval-time state; r2 R2, R2-01, R2-02)

Cash coverage at approval (old INV-03), funds AVAILABLE at approval (INV-02), destination VERIFIED at approval (INV-07), tail and
residual legality of post-termination lines (INV-15), eligibility deadline reached at the transition (INV-20), against-line
aggregate offset bound (a later refund of the against line may legally reduce its cumulative below paid plus offsets). Each needs
the instant of a write and the commit order of uncommitted peers, which committed rows cannot reconstruct (r2 R2-01: an AFTER INSERT
witness cannot see an uncommitted peer intent, so it would trust the lock it should audit).

### 2.3 Where each removed check is proven (tags resolve to exact titles in the matrix test index, lines 638-802)

| property | dedicated cells (file :: title prefix) |
|---|---|
| cash coverage, incl. lock removal | `b10-failure-cells-pay.test.ts` :: "PAY_CASH_RACE [race] CMD052 ApproveCommissionPayout, bank-available cash read of two statements" `[gcashrace]`; "PAY_CASH_BASIS [race] ... against a newer bank-evidenced settlement" `[gcashbasis]`; "PAY_INTENT_BASIS [race] ... against CMD053 changing the unsettled authorized intents" `[gintentbasis]` |
| funds at approval | `b10-failure-cells-funds-fence.test.ts` :: "FUNDS_FENCE [race] CMD052 ApproveCommissionPayout (stopped right after its funds read ...)" `[gfundsfencerace]`; "DENY (funds fence at the payout): ..." `[gfundsfencepay]` |
| destination at approval | `b10-failure-cells-pay.test.ts` :: "PAY_DEST_RACE [revocation] CMD052 ApproveCommissionPayout, a payout-destination change racing the payee check" `[gdestrace]` |
| tail and residual | `b10-failure-cells-accrual.test.ts` :: "TERM_ACCRUAL [race] COMMISSIONS consumer capture.completed.v1 ..." `[gtermaccrual]`; "CONS_REV [race] ... and TerminateSeller ..." `[gconsrevterm]`; `b10-failure-cells-conversion.test.ts` :: "CLAIM_TAIL [expiry] Claim conversion and entitlement creation ..." `[gtailc1]` (and `[gtailc2]`, `[gtailw2exp]`, `[gtailrace]`) |
| eligibility deadline | `b10-failure-cells-accrual.test.ts` :: "ELIG_REV [race] ... capture.funds_observed.v1 HELD (F1 ...) and the ELIGIBILITY pass" `[geligfact]`, "(F3 ...)" `[geligline]`; case R2-101 rows of `B10-case-map.md` (the eligibility clock; the database guard) |
| against-line offset bound | case R2-104 rows (`B10-case-map.md`: the offset guard; examples 7 and 25 end to end) |

## 3. Unit routing (kit-owned `apps/api/test/fault-support.ts`)

- Invocation-scoped counter (r1 R6, FIXED): `Route` per `faults.on` / `onRoles` invocation owns `unitSeq` across factory accesses;
  a retried transaction is attempt n of its ordinal; each unit keeps a statement log (label, params, `.before`/`.after`, error code).
- Target unit: `UnitTarget = { ordinal; phase; witness: SqlStep; identity }`, wrapped `crashableFactory(inner, points, "target")`,
  others `"uow"`; the witness with identity params must be in the target unit's log, else "target unit is another phase". Phase
  tables: QUOTE_EXPIRY 1 list (`sweeps.ts` 70) / 2 effect (72-99); ACCRUAL_RECONCILIATION 1 list / 2 conversion / 3 lacking list / 4
  accrual (108-131); CLAIM_WINDOWS, ENTITLEMENT_WINDOWS 1 list / 2 effect; ELIGIBILITY completions, funds-hold release, held-funds
  lines, ELIGIBLE, each a list unit then item units (185-226); PERIODS open / list / propose / close (`periods.ts`); CMD027 replacement
  S1/S2/S3 units (`replacement.ts`), same identity rule.
- `onRoles({ kauro_control, kauro_commission })`: dispatcher control units (`dispatcher.ts` 79, 86, 110) on one connection, consumer
  SERVICE units on the other, one counter.

## 4. Member contract

```ts
export interface Member<F, A> {
  readonly code: string; readonly cell: MatrixRef; readonly variant?: string; readonly tag: string;    // MatrixRef = { table, row, column }
  readonly roles: Partial<Record<RouteRole, Login>>;
  fixture(label: string): Promise<F>;
  act(ctx: FaultContext, f: F, key: string): Promise<A>;                 // non-2xx -> throw Refused(status, code)
  readonly point: FaultPoint<F>;
  readonly tables: ReadonlyArray<string>;                               // + command_journal + outbox_records always
  earlier(f: F): Promise<RowSet>;                                       // EXACT rows committed by units before the target (empty for one-unit steps)
  failed(f: F, failure: unknown): Promise<void>;                        // refusal + what survives (CMD027 S2r/S3: RESERVED journal, intent work)
  committed?(f: F, answer: A): Promise<void>;                           // REQUIRED for crash-after (registration refuses otherwise)
  recover(ctx: FaultContext, f: F, key: string): Promise<unknown>;       // same key | redelivery | next pass | takeover
  recovered(f: F, recovery: unknown): Promise<void>;                    // exactly-once by durable identity; earlier commits preserved
  readonly expect: string;
}
export type FaultPoint<F> =
  | { kind: "lock-timeout"; hold(holder: HarnessConnection, f: F): Promise<void>; waits: Receipt<F> }
  | { kind: "port-timeout"; port: PortName; boundMs: number }
  | { kind: "crash-before" | "crash-after"; unit: UnitTarget<F> }
  | { kind: "partial"; unit: UnitTarget<F>; completed: Receipt<F>; failing: Receipt<F> }
  | { kind: "twice"; holder: { unit: UnitTarget<F>; holdAfter: Receipt<F> }; waiter: { unit: UnitTarget<F>; blocks: Receipt<F> } }
  | { kind: "membership"; holdAfter: Receipt<F>; revoke(c: HarnessConnection, f: F): Promise<void>; refusal: (e: unknown) => boolean }
  | { kind: "step-up-expiry"; waitOn(holder: HarnessConnection, f: F): Promise<void>; proofExpiresAt(f: F): string }
  | { kind: "lease"; obligation: DispatcherObligation };
type Receipt<F> = SqlStep & { identity(f: F): (params: ReadonlyArray<unknown>) => boolean };
```
Footprint rule (r2 R8): after a fault, footprint = before + `earlier(f)` exactly; the target unit's writes absent. Never "whole
footprint unchanged" when earlier units committed (ACCRUAL_RECONCILIATION conversion survives an accrual crash; a
released funds hold survives a failing ELIGIBLE unit). Before recovery: both raced reports via `mustHaveSettled`, the sink checked;
sweep recovery judged on rows, never on the report. After every cell: `assertInvariants`.

## 5. Templates (each ends with `assertInvariants`)

5.1 lock-timeout (`race`): holder BEGIN + `hold`; `mustWait` runs `act`; the routing shows `waits.before` with identity params, no
`waits.after`, SQLSTATE 57014 from that call; `waits` must be the FIRST statement of the act that conflicts with `hold` (a member
naming a later one is unreachable and fails: r2 R9 QUOTE_EXPIRY). QUOTE_EXPIRY SWEEP_TMO therefore waits at `quotes.lock`
(`sweeps.ts` 75), the release guard being SQL of the same unit (83); claim conversion waits at its first claim/agency lock. Then
`failed`, footprint rule, holder ROLLBACK, `recover`, `recovered`. Pattern: `b10-failure-cells-close2.test.ts` 463-530.

5.2 port-timeout (`timeout`), classified by the binding the path actually CALLS, regardless of process location (r2 R9): BuyerTypeReader
(CMD027, CMD047 `accept-attribution.ts` 79; bound to `ContractFakeBuyerTypeReader`, an in-process map, or `UnrecordedBuyerTypeReader`);
PreparationCompletionSource only in `recordCompletions` (`ledger-effects.ts` 318: `commercial_authorization.delivered.v1`, ELIGIBILITY
phase 1; `ContractFakePreparationCompletion`); ActiveWorkInspector (`close-agency.ts` 81, 6a); PurchaseRebinder (`replacement.ts`
214, 6a). The port hook holds the call after its recorded arrival (`.before` in the operation scope) and never answers; the
application's own bound is the deadline (`ctx.deadline`, crossed while the call is in flight, consumed by the operation). No bound
exists today -> the member is RED and a product GAP for the owning lane; a mutation removing the bound must turn it RED again; a
statement timeout, injected rejection or node:test timeout never turns it green. A binding that also issues SQL gets an extra 5.1
member. Paths that never call a port use their own first conflicting lock (5.1).

5.3 crash-before / crash-after (`target`): witness = the effect's last write (rule 2); before: footprint rule, unsettled delivery or
journal; after: `committed`; then `recover`, `recovered`. Rule 5: the crash is mandatory per member.

5.4 partial: `ctx.partial(what, "db.<failing>.before", act)`; `completed` and `failing` are writes, both in the target unit's log,
`completed.after` with identity before `failing.before`; footprint rule. Cross-unit pairs are not partial: the ELIGIBILITY row's
"line ELIGIBLE and hold released" is two units (196-226), so SWEEP_PAR ELIGIBILITY becomes (a) partial inside the release unit and
(b) crash-before of the ELIGIBLE unit with the release in `earlier`; the kit restates the matrix cell in its fold (kit owns the doc).

5.5 twice (`race`; r2 R7): A pauses after `holder.holdAfter.after` in its target unit; B runs; the runner requires `mustWait` observed
and, at that moment, B's last dispatched statement = `waiter.blocks` with identity params in B's target unit (receipt binding B's
wait to the same item and boundary); release; reverse order as a second member. A losing actor may write nothing; one durable effect.

5.6 membership revocation, three phases as PAY_REV (`b10-failure-cells-pay.test.ts` 275-330), FIXED in r2. 5.7 CMD043 step-up
expiry with its own declared deadline, FIXED in r2.

## 6. Dispatcher obligations (exact crosswalk; registration fails on a missing or substituted member; r2 R2-03, R11, R2-04)

Matrix table "COMMISSIONS dispatcher lease" (`B10-failure-matrix.md` 196-205), rows L1 (lease claim), D (batch claim), L2 (heartbeat,
settle). Deadlines: lease TTL and delivery claim (`OUTBOX_CLAIM_SECONDS`) declared, consumed through the port hook by B's
`leases.claim` / `outboxDispatch.claim` (instant argument). A and B: two `createCommissionDispatcher` with distinct owner ids.

| row/column | code | member | proof | expected (matrix) |
|---|---|---|---|---|
| L1 TIMEOUT | LEASE_TMO | holder `SELECT ... FROM kauro.leases ... FOR UPDATE` on the resource row; `waits` = `claim_lease` (lease-store.ts 73-76); second variant: crash at control unit 1 `target.after-commit`, retry reads the committed fence | race; crash-after | retriable, no ownership assumed |
| L1 CRASH-BEFORE | LEASE_CRASH | stop after the claim committed, before the first heartbeat's COMMIT: crash at control unit 1 `target.after-commit` (the COMMIT it straddles is the heartbeat's, rule 2) | crash-after-commit | B takes over after TTL at fence n+1 |
| D RACE | DELIV_CLAIM | A paused before its batch COMMIT; TTL and claim deadline crossed; B claims; A released | race | A's late batch refused by its stale fence: `outboxDispatch.claim` takes no owner or fence (inbox-outbox.ts 178-190) -> RED, product gap |
| D TIMEOUT | LEASE_TMO | holder `LOCK TABLE kauro.outbox_records IN EXCLUSIVE MODE` (conflicts with the claim's ROW SHARE; a row lock is skipped by SKIP LOCKED, r2 R11); `waits` = the claim CTE; variant: answer lost (unit 2 `target.after-commit`) | race; crash-after | retriable, nothing assumed claimed; lost answer reclaimed after the claim deadline |
| D EXPIRY | DELIV_CLAIM | TTL crossed while A holds at unit 2 `target.before-commit` | expiry | claims fenced -> RED (same gap) |
| D CRASH-BEFORE | DELIV_CRASH | unit 2 `target.before-commit` | crash-before | nothing claimed; B claims |
| D CRASH-AFTER | DELIV_CRASH | unit 2 `target.after-commit`, before any effect | crash-after | B reclaims after the claim deadline, none stranded |
| D RETRY | DELIV_CRASH | consumer unit k committed, crash before settle; B reclaims and redelivers (`ctx.attempt` per redelivery) | retry | redelivered once, effect adds nothing |
| D REVOCATION | DELIV_CLAIM | A's heartbeat refused (B took over), then A's next run | revocation | A claims no further record |
| D PARTIAL | DELIV_CRASH | the batch claim is ONE statement (CTE, inbox-outbox.ts 181-190): no write can fail after another inside it (rule 4); cell restated N/A with DENY member "crash after the claim statement answered, before COMMIT, leaves no record CLAIMED" | crash-before | all or nothing |
| L2 RACE | CONS_LEASE_EXP | see below | race | late COMMIT fenced -> RED (no fence on the effect unit, dispatcher.ts 109-114) |
| L2 TIMEOUT | LEASE_CRASH | A paused after its effect committed and before its heartbeat (`DELIVERY_BEFORE_SETTLE`, 108); TTL crossed; B takes over | timeout | A's heartbeat refused, settles nothing; B redelivers once, adds nothing |
| L2 CRASH-BEFORE / CRASH-AFTER | CONS_CRB / CONS_CRA | consumer unit k `target.before-commit` / `.after-commit`, witness = its effect write | crash | effect once / adds nothing |

CONS_LEASE_EXP ordering (r2 R2-04): A paused at consumer unit k `target.before-commit` (holding its locks); cross TTL and the claim
deadline; start B.runOnce; observe B's effect statement (receipt with the delivery's identity) waiting on A; release A; then assert
A's COMMIT outcome (matrix: refused) and B's result (effect once, settled by B). `finally` releases and drains both. RED cells (D RACE,
D EXPIRY, L2 RACE) need a fix in B06/B09 files or a governing decision: routed to the coordinator, never weakened here.

## 7. Families, files, budget

`apps/api/test/b10-family-{cmd,sweeps,consumer,lease}.test.ts`; runner `b10-family-runner.ts` exports `MEMBERS` for the test index.
~106 cells x 2-4 s on Linux, four processes; oracle < 40 ms per call (measured in its self-test).

## 8. Codex r2 findings -> resolution

| finding | r3 | evidence |
|---|---|---|
| R1 (FIXED r2) | moved out of the oracle (2.2), proven by `[gcashrace]` `[gcashbasis]` `[gintentbasis]` | `commercial-statements.ts` 878-895 |
| R2 residual legality | INV-15 removed; dedicated cells 2.3 | D10-GAP-19, 22 |
| R3 correction exclusions | S-08 without exclusion + S-09 evidenced corrections + S-10 chain | design 241, 389; mig 0030 |
| R4 BLOCKING payable derivation, offsets | S-01 per-item derivation, S-05 paid, S-07 offset equality, binding, aggregate | mig 0031 167-212; mig 0030 555-585 |
| R7 twice receipt | `waiter.blocks` receipt (5.5) | |
| R8 earlier commits | `earlier(f)` footprint rule, `committed` required, ELIGIBILITY restated (4, 5.4) | `sweeps.ts` 108-131, 196-226 |
| R9 port classification, QUOTE_EXPIRY | by called binding (5.2); first conflicting lock (5.1) | `ContractFakeBuyerTypeReader`, `sweeps.ts` 75 |
| R11 batch timeout, stale claim | EXCLUSIVE table lock; DELIV_CLAIM RED (6) | inbox-outbox.ts 178-190 |
| R2-01 witness trust | witnesses removed (2.2) | |
| R2-02 eligibility deadline | removed; `[geligfact]` `[geligline]`, R2-101 (2.3) | |
| R2-03 lease crosswalk | exact table (6) | matrix 196-205 |
| R2-04 late COMMIT ordering | 6 | dispatcher.ts 79-114 |
| R2-05 frozen allocation | S-11 `frozen_at IS NOT NULL` | mig 0029 |

Disagreements: none. Note: D PARTIAL is restated N/A under rule 4 (single statement) with a DENY member rather than left GAP.
