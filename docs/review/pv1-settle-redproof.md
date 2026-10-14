# PV1-SETTLE red-proof of the guards behind each cell (ADV-3)

Method: on the code of 9885c959 (plus the uncommitted comment move in settlement.ts), one guard at a time is reverted in a disposable WSL
scratch copy (never in the worktree), the cell file is rebuilt and run (--test-concurrency=1, --test-timeout), the failing assertion
is recorded, the guard is restored. Control: settlement-cells 31/31 and ach-dispatch-cells 5/5 green with every guard in place.
Scratch tooling is not committed. 22 of 22 provable mutants are red; 3 guards are redundant by design (below).

| Cell | Guard reverted (file) | Failing assertion under the mutant |
|---|---|---|
| 10(a) | A5 re-check of the locked intent removed (settlement.ts applySettlementRequest) | the rival's U2 found the intent consumed at A5 |
| 10(b) | funds read before the locks, not after A4 (settlement.ts) | first holds: the waiter judged the balance the holder left (read after A4) (21 cells red; the run then wedged on its held lock) |
| 10(c)(d) | payout-cash lock (lockFunds) removed (settlement.ts) | 7 cells red (the CMD052/CMD053 fence cells and the L1 funded-for-one cell) |
| 12(ii) | effectNow read before the first lock (settlement.ts) | created_at is the instant after the wait (T2), never one read before A4 (T1) |
| 20(a) | A1b evidence re-read disabled (mismatch = false) | bank_available_cents inflated: the frozen facts are not the artifacts' |
| 20(b) | withdrawn figure dropped from factsMatch | withdrawn_cents changed: the frozen facts are not the artifacts' |
| 16(c) | owner events policy widened to settlement_request.% (0071) | kauro_app: INSERT applied.v1 at version 1 is refused ..., got error 23502 |
| 16(c) | kauro_app may UPDATE/consume the intent (0071) | kauro_app: UPDATE the intent is refused ..., got error 23514 |
| 16(c) | kauro_app may UPDATE its outbox records (0071) | kauro_app: UPDATE its outbox record is refused ..., got rows 2 |
| 18 | settlements_request_birth no longer compares withdrawn_cents (0071) | withdrawn + 1 vs its intent |
| 18 | bank settlement CHECK no longer requires request_id (0071) | a bank settlement without its intent |
| 18 | pair: settlement_requests_immutable fires only on consumed_at, and the consumed-once guard off | a consumed intent's fact never changes |
| 18 | pair: settlement_requests_applied_settlement CHECK and the outcome_bound APPLIED branch off | APPLIED without a settlement |
| 18 | pair: settlement_requests_refused_case CHECK and the outcome_bound REFUSED branch off | REFUSED without a case |
| D1-D3 | agency-less delivery always throws (dispatcher.ts deliveryOf) | the agency-less intent is delivered to the service: ... DEAD_LETTER INTEGRITY_FAILURE (9 red) |
| D4 | blanket null agency | an unlisted agency-less type is never delivered: ... NOT_APPLICABLE |
| D4 | type allowlist unchecked | an unlisted agency-less type is never delivered: ... NOT_APPLICABLE |
| D5 (ADV-5) | PAYMENT_SERVICE-only half of the predicate dropped | settlement_request.recorded.v1 on FISCAL is never delivered: ... NOT_APPLICABLE |
| 20 (ADV-7) | resolveRefusedCases resolves EVIDENCE_MISMATCH cases | the mismatch case is not auto-resolved |
| 19/21 (ADV-8) | in-transit page hides receipt-less APPLIED | an applied receipt-less settlement stays on the in-transit page |
| OK (ADV-9) | exactCents returns n + 1 | settlement.recorded.v1: exact numbers |
| all DB cells (ADV-2) | ledger fee posted twice (ledger.ts) | 25 cells red from INV-SET-1 (settlement oracle) |

Findings of the proof:
- **10(a) was vacuous for the consumedAt disjunct.** Removing only `|| request.consumedAt !== null` leaves all 31 cells green, and a probe
  shows lockRequest never returns a consumed row: the payment role's UPDATE policy (USING consumed_at IS NULL) hides it from FOR NO KEY
  UPDATE, so the live A5 guard is the `request === null` branch. The cell is red when that branch is removed (row above). The disjunct is
  defence in depth, unreachable by construction.
- **Redundant guards (single revert stays green, pair reverts red):** the consumed-once trigger vs settlement_requests_immutable (both raise
  KA004), and the deferred outcome_bound branches vs the CHECKs settlement_requests_applied_settlement / _refused_case (the CHECK answers 23514 first).
  The cell asserts the first-line error, so each pair is proven together.
