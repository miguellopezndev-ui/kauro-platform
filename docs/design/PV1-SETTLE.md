# PV1-SETTLE — settlement observation (ACH-ROUTE r7 §7.25, R2-085)

Lane L-SETTLE of PAYMENTS-V1 (ACH-case-map row R2-085: EXECUTED_LOCAL ST1/ST2; LIVE Wise -> Bancolombia after D-14).
Sources: R2 15 "Settlement and withdrawal"; R2-085 "Held funds and withdrawal" (separate capture / held / withdrawn /
bank-available facts; no payout from imaginary liquidity; never grade from a screenshot); B09 D-SETTLE-B1 (registry Settlement,
platform-level, append-only, bank-available only with bank evidence); B09 D-LEDGER-B5 (bank money is posted only from a settlement
observation); ACH-ROUTE §6 "No incoming credit makes BANK_CASH" and NX-NO-POTENTIAL ("explained = linked by bank transaction id
to another RECORDED attempt or to a recorded settlement (ST2)").

## Decisions

- **D-SET-1 Command.** CMD215 `RecordSettlementObservation`, `POST /api/v1/operations/bank-accounts/{accountRef}/settlements`,
  operationId `recordBankSettlement`; KAURO_OWNER with a fresh step-up, Idempotency-Key in the owner identity's journal; the unit
  runs as `kauro_payment` (the inbound commands' payment pool, PV1-INBOUND). Body: `{ artifactRef, evidenceHash, receipt:
  { artifactRef, evidenceHash } | null, authorizationRef }`. No money figure is typed: every amount, instant and identity comes
  from the classified stored artifacts (ST1). `receipt: null` is R2-085's scenario: the provider released the withdrawal, the
  bank has not credited it (BANK_IN_TRANSIT only, bank-available 0 and no bank evidence).
- **D-SET-2 Evidence (ST1).** Two artifact kinds of the route's evidence port, each pure over hash-verified stored bytes, fail
  closed (UNKNOWN_EVIDENCE, MALFORMED_EVIDENCE, HASH_MISMATCH, UNAUTHENTICATED_EVIDENCE):
  `classifySettlement` -> `SettlementEvidence` (route account, currency, period start/end, the withdrawal's statement-line id on
  the route account = `withdrawalId`, gross / fee / held / withdrawn cents of the period, observedAt) and `classifyBankReceipt`
  -> `BankReceiptEvidence` (receiving account ref, `withdrawalId` it cites, bank transaction id, received cents, currency,
  bank-available balance cents, bookedAt, observedAt). The store read is bounded by the provider-call timeout
  (EVIDENCE_UNAVAILABLE, nothing written). The artifacts are read outside every lock and never cached (as SI1).
- **D-SET-3 Consistency.** Refused PRECONDITION_FAILED with a reason, before any write: currency other than the route's (V1 USD
  only, no FX: `fx_rate` NULL); `period_end > effectNow` (COVERAGE_END_IN_FUTURE, at the DB clock after the last lock wait);
  a receipt citing another withdrawal or account (RECEIPT_MISMATCH); received cents > withdrawn cents; bank-available < received
  (SETTLEMENT_INCONSISTENT).
- **D-SET-4 Identity and conflict.** One settlement per (route, withdrawalId) and one per bank transaction id: a second
  observation of the same withdrawal or of an already-settled bank transaction is 409 PRECONDITION_FAILED
  WITHDRAWAL_ALREADY_SETTLED (ST2-RETRY "other body or a bank transaction id already settled 409"); the same key and body replays.
- **D-SET-5 Funds lock.** The body takes the route's INBOUND stream lock (§7.28 L-order: the provider balance's writers C6/P2 hold
  it) and then the payout-cash lock (`kauro.payout-cash`, CMD052's basis, 0043 fence): CMD052 and ST2 serialize in both orders.
  Under both, `withdrawn + fee <= PSP_AVAILABLE` of the route (ledger balance) or 409 FUNDS_UNAVAILABLE: no settlement of
  imaginary liquidity.
- **D-SET-6 Postings** (source SETTLEMENT, agency NULL, one set, balanced, UNIQUE(event_id,line_no) = idempotent):
  DEBIT BANK_IN_TRANSIT W / CREDIT PSP_AVAILABLE W (the provider's release); if fee F > 0: DEBIT PROCESSOR_EXPENSE F / CREDIT
  PSP_AVAILABLE F (the withdrawal fee only; the period's capture fees are FEE-sourced already); if a receipt R: DEBIT BANK_CASH R /
  CREDIT BANK_IN_TRANSIT R. gross and held are recorded facts, not posted (they are posted by their own sources).
- **D-SET-7 Event.** `settlement.recorded.v1` (aggregate `settlement`, version 1, agency NULL), payload
  `{ settlementId, withdrawalId, withdrawnCents, receivedCents, bankEvidence: boolean }`; an outbox record for FINANCE is not
  needed (the postings are written in the command's unit).
- **D-SET-8 Cells file.** The cells run in `apps/api/test/settlement-cells.test.ts`, not in packages/persistence as §7.25 names:
  ST2 is an owner command (journal, step-up, route) and `@kauro/persistence` cannot reach the application's classifier. The SET-M
  titles are §7.25's exactly.

## Failure matrix (§7.25, 16 cells; N/A cells justified in §7.25)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| ST1 classify | N/A pure | SET-M-ST1-TIMEOUT: EVIDENCE_UNAVAILABLE, nothing | N/A read | N/A | N/A | SET-M-ST1-RETRY: same digest same result; unknown/malformed/hash-mismatch REJECTED | N/A | N/A |
| ST2 record | SET-M-ST2-RACE: same withdrawal twice; vs CMD052 both orders; one settlement; W+F <= PSP_AVAILABLE under the funds lock | SET-M-ST2-TIMEOUT: lock and COMMIT timeout, nothing; same key once | SET-M-ST2-EXPIRY: period end > effectNow refused; stale step-up refused | SET-M-ST2-CRASH-BEFORE: nothing | SET-M-ST2-CRASH-AFTER: replay, one event | SET-M-ST2-RETRY: same key replays; other body or settled bank tx 409 | SET-M-ST2-REVOCATION: grant, identity, step-up NOT_AUTHORIZED | SET-M-ST2-PARTIAL: last posting line fails, rollback, ledger balanced |

## Slices

1. Domain + application: evidence types, the port's two classifiers and the contract fake, `settlementPostings`, the ST1
   read; ST1 cells green; ST2 cells written red-first.
2. Migration (settlement identity columns, uniqueness, `settlement` aggregate kind and event, payment-role policies), repository,
   CMD215 handler and route, generated files; ST2 cells green.
