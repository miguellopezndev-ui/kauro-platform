# B10 kit: invariant oracle and parametrized family suites (design for Codex review)

Repo `kauro-platform`, base `main` a7315df. Lane `b10/kit` (mandate `C:\Projects\Kauro\.kauro\mandates\B10.md`).
Governing docs: `docs/design/FAILURE-MATRIX-TEMPLATE.md` (8 columns, family rules 1-10), `docs/design/FAULT-HARNESS.md`
(evidence ownership, per-kind proof), `docs/design/B10-failure-matrix.md` (GAP list lines 262-637), audit `platform-code-05`.
Review question for Codex: can any family member pass without its fault at the named boundary, or can the oracle be silenced?

## 1. Goals and non-goals

- G1. One invariant oracle: about 15 SQL queries over committed state that must return zero rows; run after every DB test
  of B10 and after every `runCell` the family runner performs. A money bug any test happens to create then fails that test.
- G2. One parametrized runner per fault family: a family member declares only its data (fixture, step, fault point,
  footprint, recovery); the runner owns the body template, so the proof rules are written once per family, not per cell.
- G3. Families owned here: CMD_TMO (+BUYER_TMO), CMD_CRA, TEN_REV, SWEEP_CRASH/SWEEP_RACE/SWEEP_PAR/SWEEP_TMO,
  CONS_CRB/CONS_CRA/CONS_TMO, LEASE (CONS_LEASE_EXP, DELIV_CRASH, DELIV_CLAIM, LEASE_CRASH, LEASE_TMO). 106 matrix cells.
- Non-goal: no change to `packages/persistence/src/testing/faults/*` (8 Codex rounds; frozen). Everything is built on
  `faultCell`/`runCell`, `FaultRouting` (`apps/api/test/fault-support.ts`) and `b10-cells-support.ts`.
- Non-goal: PAY_, CLOSE_, FUNDS_, CONV_, REPL_, QUOTE_PAR keep dedicated tests (lanes 6a/6b/6c).

## 2. Invariant oracle (`packages/persistence/src/testing/invariants.ts`, exported from `@kauro/persistence/testing`)

```ts
export interface Invariant { readonly id: `INV-${string}`; readonly decision: string; readonly sql: string; }
export const B10_INVARIANTS: ReadonlyArray<Invariant>;
export class InvariantViolated extends Error { readonly violations: ReadonlyArray<{ id: string; rows: unknown[] }>; }
export async function assertInvariants(oracle: Client, opts?: { readonly label?: string }): Promise<void>;
export function invariantsAfterEach(oracle: () => Client): void;        // node:test afterEach, top level of a file
export function allowBreach(id: string, decision: string, why: string): void; // scoped to the running test only
```

- Runs on the superuser ORACLE connection (never a runtime login, never inside a routed unit), READ COMMITTED, one
  statement per invariant, `LIMIT 5` rows each; every failing id is reported together (no early stop).
- Committed state only, so every invariant must hold at ANY instant, not only at rest: the runner may also call it while
  a holder is paused (inside `contend(..., during)`), which is the strongest use. An invariant that is only true at rest
  (e.g. "the accrual sweep has caught up") is excluded by construction.
- `allowBreach` exists for a test that deliberately seeds a forbidden state through the superuser to prove a guard. It
  is valid for the current test only (AsyncLocalStorage of the test), must cite a decision id, and is printed in the
  test output. A money invariant may be allowed only with the D10 decision that makes the state legal. Kit acceptance
  includes a grep listing every `allowBreach` with its reason.
- Self-test `packages/persistence/test/invariants.test.ts`: for EACH invariant, seed one violating row set through the
  superuser in a temporary database and assert that exactly that id fires (negative control), and that a clean seeded
  ledger fires nothing. An invariant without a firing self-test is not shipped.

Invariant set (builder binds the exact SQL to migrations 0028-0044; semantics to the decision cited):

| id | zero rows of | decision |
|---|---|---|
| INV-01 | a commission line with more than one live payable statement item | mig 0039, D10-GAP-8 |
| INV-02 | a PAYABLE line whose capture's latest funds observation is not AVAILABLE (PAID judged at paid_at) | D10-GAP-21, mig 0043 |
| INV-03 | sum of AUTHORIZED+SUBMITTED intents above the bank-available cash of the latest settlement | D10-PAY-1, D10-GAP-1 |
| INV-04 | more than one live (AUTHORIZED, SUBMITTED, SETTLED) intent per statement | D10-PAY-2 |
| INV-05 | a SETTLED intent whose statement is not PAID or whose items' lines are not PAID (and the reverse) | D10-GAP-5 |
| INV-06 | a HELD line without an OPEN hold covering its whole unpaid amount; an OPEN hold on a PAID or VOID line | D10-HOLD-1, D10-GAP-4 |
| INV-07 | an intent bound to a destination not VERIFIED at the intent's version | D10-GAP-3, mig 0035 |
| INV-08 | a claim-based entitlement whose claim is not CONVERTED; a CONVERTED claim without its entitlement | D10-TERM-1, CONV_* |
| INV-09 | line cumulative_entitlement_cents differing from the pool rule plus the signed sum of its adjustments | D10-ADJ-1 |
| INV-10 | allocation shares of one allocation not summing to 10000 bps; a pool whose lines' shares do not | D10-POOL-1 |
| INV-11 | live founding reservations (RESERVED, HELD, CONSUMED) above the policy's slots; a reservation CONSUMED twice | D10-FOUND-1..5 |
| INV-12 | an agency first designation missing for a purchase with confirmation_seq 1, or naming another capture | D10-FIRST-1/2, R2-137 |
| INV-13 | a paid purchase with two ACTIVE authorizations after replacement, or two spent allowances | D10-QUOTE-3/4 |
| INV-14 | a CORRECTED statement with a non-terminal intent; a predecessor with two successors | D10-GAP-7 |
| INV-15 | a line of a TERMINATED seller accrued on a capture after the termination outside a tail entry | D10-TERM-1, D10-GAP-22 |

Wiring: `bindCells(iw)` cannot register hooks (it runs inside `before`), so every B10 DB test file gets one top-level line
`invariantsAfterEach(() => world.h.oracle)` (kit owns that one-line edit in the existing files listed in the mandate).
The family runner calls `assertInvariants` itself after each member body, inside the cell, so a violation is attributed
to the member, not to the file.

## 3. Family runner (`apps/api/test/b10-family-runner.ts`)

A member is data plus three functions. The runner turns each member into one `faultCell` whose title is
`cellTitle({ id: code, step, fault, at, expect })`, so the case-map/matrix citation stays `file :: "exact title"`.

```ts
export interface Member<F> {
  readonly code: string;                 // GAP code: "CMD_TMO"
  readonly cell: string;                 // matrix row/column verbatim: "CMD047 AcceptAttribution / TIMEOUT"
  readonly variant?: string;             // which of two cells of one row/column ("the claim lock", "the allocation lock")
  readonly tag: string;                  // test-index tag, unique: "[ftmo047a]"
  readonly login: Login;                 // the route's login (kauro_app_test | kauro_commission_test)
  fixture(label: string): Promise<F>;    // fresh state, unique ids (label = tag)
  act(ctx: FaultContext, conn: HarnessConnection, f: F, key: string): Promise<Outcome>;   // the step, routed on conn
  footprint(f: F): Promise<unknown>;     // every row the step may write (journal included), read by the oracle
  readonly point: FaultPoint<F>;
  readonly expect: string;               // cell expect text (DENY ... / RACE ...)
  refusal?: RegExp;                      // e.g. /^503 CAPACITY_UNAVAILABLE/ ; /^403 NOT_AUTHORIZED/
}
export type FaultPoint<F> =
  | { kind: "lock-timeout"; hold(holder: HarnessConnection, f: F): Promise<void> }              // CMD_TMO, SWEEP lock waits
  | { kind: "port-timeout"; port: PortName }                                                 // BUYER_TMO, CONS_TMO, SWEEP_TMO
  | { kind: "crash-before"; unit?: number }                                                  // uow.before-commit of the nth unit
  | { kind: "crash-after"; unit?: number }                                                   // uow.after-commit of the nth unit
  | { kind: "partial"; after: SqlStep }                                                      // fail at the write AFTER this step
  | { kind: "twice"; holdAt: "uow.before-commit" | `db.${string}.after` }                    // SWEEP_RACE: second pass waits on the first
  | { kind: "revocation"; holdAt: string; revoke(f: F): Promise<void>; refusal: RegExp }     // TEN_REV
  | { kind: "lease"; scenario: LeaseScenario };                                              // LEASE family (section 5)
```

Templates (one per kind; each ends with `assertInvariants(oracle, { label: tag })`):

| kind | harness proof | body template |
|---|---|---|
| lock-timeout | `race` (mustWait on the holder) | snapshot footprint; holder BEGIN + `hold`; `ctx.mustWait` runs `act` on the waiter with `faults.statementTimeoutMs = 1500`; assert `refusal` and `retryable`; footprint unchanged; holder ROLLBACK; same key `act` completes once; footprint = one effect. (Pattern: close2.test.ts 463-530.) |
| port-timeout | `timeout` | port wrapper installed through the kit's `FaultRouting.ports` hook (new, mirrors `timer`): the port never answers, the clock crosses the APPLICATION's bound inside the running operation (family check note, matrix line 846); assert retriable refusal, nothing written, next attempt once. If the product has no bound, the member is RED and is a product GAP for the owning lane. |
| crash-before | `crash-before-commit` at `uow` | `ctx.points.crash("uow.before-commit")` armed for the nth unit only (counted by the routing, not by the body); assert footprint unchanged and delivery/journal unsettled; recovery (same key, redelivery, next pass) yields the effect once. |
| crash-after | `crash-after-commit` at `uow` | crash at `uow.after-commit`; footprint = committed effect; recovery returns the SAME answer (command: replay body equal; consumer: delivery settles, adds no row; sweep: next pass reports it done). Rule 5: the injected loss is proven, not only the replay. |
| partial | `partial` | `ctx.partial(what, "db.<next>.before" crash, ...)` after a completed `db.<after>.after` of the same unit; footprint (journal included) unchanged; recovery once. Rule 4: one member per second-or-later write. |
| twice | `race` | `contend(ctx, holder = pass A paused at holdAt, waiter = pass B)`, then the reverse order as a second member (rule 1, both orders); exactly one effect; the loser reports done/skipped, never FAILED. |
| revocation | `revocation` | pause `act` at `holdAt` (after the guard, before COMMIT); `ctx.revoked(what, () => revoke(f))`; release; `ctx.fenced(what, outcome, refusal)`; footprint unchanged; journal holds the refusal or nothing. Rule 8: one member per prerequisite (membership, step-up, grant). |

Fault point declaration rules (what Codex should check):
1. A member never moves the clock, crashes or pauses by hand; only the template does, so a member cannot fake proof.
2. `crash-*` and `partial` are armed on the member's own routed unit (`faults.on(conn, ...)`), never on a fixture unit;
   the nth-unit counter lives in `FaultRouting`, so a command that opens two units (replacement S1/S2/S3) names the unit.
3. `partial.after` must be a step the unit actually passes before the failing write; the runner asserts the `.after`
   point is in the operation's scope (harness `partial` already refuses otherwise).
4. Each member's `footprint` must include the journal row and the outbox rows; the runner refuses a footprint function
   that returns the same value before the fixture and after a successful `act` (a footprint that sees nothing).
5. Unique `tag` and unique title per file; the runner exports `MEMBERS` so the matrix fold prints the test index lines
   (`code | cell | tag | file :: "title"`) from code, never by hand.

## 4. Families and their members (counts are matrix cells)

- CMD_TMO (26) + BUYER_TMO (2) -> `apps/api/test/b10-family-cmd.test.ts`. One member per matrix cell; the `hold` is the row
  or table lock the command waits on first (CMD002 agency row; CMD027 quote/slot rows, replacement journal; CMD043 agency,
  quotes; CMD045-050 seller/prospect/claim/allocation rows; CMD051 correction statement; CMD052 statement and cash;
  CMD053 intent; trigger: qualifying purchase). Expectation: retriable 503 CAPACITY_UNAVAILABLE, nothing written, same
  key completes once. BUYER_TMO: port-timeout on BuyerTypeReader (CMD027, CMD047).
- CMD_CRA (15) -> same file. crash-after at the command's unit; replay returns the identical status and body.
- TEN_REV (5) -> same file. CMD002 membership; CMD043 membership and step-up (expiry at the database instant, judged at
  effect as D10-GAP-11/14 do for CMD052); CMD027 membership (OWNER, AGENCY_BILLING).
- SWEEP_CRASH (16), SWEEP_PAR (2), SWEEP_RACE (5), SWEEP_TMO (7) -> `apps/api/test/b10-family-sweeps.test.ts`. Members
  per sweep: QUOTE_EXPIRY, CLAIM_WINDOWS (two effects: lapse, tail end), ENTITLEMENT_WINDOWS, ACCRUAL_RECONCILIATION,
  ELIGIBILITY, PERIODS (open month, close period). Each effect is its own SERVICE unit, so `unit` is 1 with the fixture
  holding exactly one due item. SWEEP_TMO port members: QUOTE_EXPIRY release guard, PreparationCompletionSource.
- CONS_CRB (4), CONS_CRA (4), CONS_TMO (6) -> `apps/api/test/b10-family-consumer.test.ts`. Members per event:
  capture.completed.v1, refund.completed.v1/capture.reversed.v1, capture.funds_observed.v1 (HELD and AVAILABLE),
  commercial_authorization.delivered.v1. Recovery = redelivery of the same delivery through `runConsumer`.
- LEASE (CONS_LEASE_EXP 1, CONS_CRB/CRA dispatcher 2, DELIV_CRASH 4, DELIV_CLAIM 3, LEASE_CRASH 2, LEASE_TMO 2) ->
  `apps/api/test/b10-family-lease.test.ts`.

## 5. Lease scenarios

`LeaseScenario = { stopAt: "after-lease" | "after-batch-claim" | "mid-batch" | "before-heartbeat"; expire: boolean;
takeover: boolean; lateCommit?: boolean }`. Template: dispatcher A runs on a routed conn and is stopped at `stopAt`
(pause or crash); the controlled clock crosses the lease's time to live (declared with `ctx.deadline`, consumed by the
lease store call through `instrumentPort(uow.leases, ...)`, as B06-R1 does); dispatcher B takes over under the next
fence; A's late heartbeat/settle/COMMIT is fenced (`ctx.fenced`); every CLAIMED record is delivered exactly once (outbox
rows + ledger footprint) and no record stays CLAIMED by a dead owner. LEASE_TMO uses lock-timeout on the lease row.

## 6. Cost and run budget

~106 cells, 2-4 s each on Linux -> 4-7 min, split over 4 files (one process each). Oracle: 15 queries per test; target
< 40 ms per call on the test database (measure in the self-test; add indexes only in a migration if needed, never skip).

## 7. Open questions for Codex

Q1. Is `allowBreach` scoped tightly enough, or should it be refused for INV-01..07 outright?
Q2. Is the nth-unit counter in `FaultRouting` (kit-owned `fault-support.ts`) acceptable, or must it live in the harness?
Q3. SWEEP_RACE cells are RETRY-column cells; the runner proves them as `race` (both orders, wait observed). Accept?
Q4. INV-03 must use SQL independent of the product's cash function (independent truth, G-COMMERCIAL rule 21). Agree?
