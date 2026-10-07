# B15 case map (draft)

Cases of R2 program B15 (`packages/contracts/registry/program.json` caseIds) and what the provider-adapter lane contributes. No case
closes on this lane's evidence: the adapters' tests are EXECUTED_LOCAL (recorded wire); every B15 case requires the live integrated
candidate (requiredEvidence includes `external_effect_identity` and `independent_review`). Status values: `ADAPTER_LOCAL` (the adapter
behaviour the case needs is built and tested on the recorded wire), `PENDING` (adapter not yet built), `LIVE` (B15 run, B).

| Case | Title | Adapter | Lane status | Local evidence (file :: title) | Left for live |
|---|---|---|---|---|---|
| R2-061 | Webhook reordering | PayPal | ADAPTER_LOCAL | `packages/adapters-paypal/test/contract.test.ts :: "OK a signed refund event is VERIFIED as REFUND_COMPLETED naming the platform refund id" [PROVIDER]`; `:: "OK observe an order with a refund: the refund is listed against its capture with the platform refund id" [PROVIDER]` (the order read by id is the reconciler's instrument for the identities) | refund webhook before the capture webhook on the sandbox, reconciled (L-PP-3, L-PP-4) |
| R2-085 | Held funds and withdrawal | PayPal (funds state); Wise (withdrawal) | ADAPTER_LOCAL (PayPal part) | `packages/adapters-paypal/test/contract.test.ts :: "OK capture: CAPTURE_OBSERVED COMPLETED with the provider's fee, the route's payee, the order and a completion instant" [PROVIDER]` (disbursement absent → UNKNOWN; DELAYED → HELD in `src/normalize.ts`) | L-PP-2 `disbursement_mode`; withdrawal through Wise after KYC |
| R2-082 | Tax treatment unresolved | Alegra | PENDING | — | — |
| R2-083 | Alegra cheapest plan lacks verified API | Alegra | PENDING | — | — |
| R2-084 | Issued invoice missing from first page | Alegra | PENDING | — | — |
| CMD035-OK / DENY / RACE | IssueTaxDocument | Alegra | PENDING | — | — |
| R2-133 | Notification quota and authenticity | Resend | PENDING | — | — |
