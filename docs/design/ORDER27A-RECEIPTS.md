# Order 27A: generic USD receipt, reconciliation, pending-payment hold, uncertain refunds (offline, simulators only)

Stage A sprint build. Everything here runs on simulators; nothing reaches Wise, PayPal, DIAN, a bank or any network, and no money moves.
Every activation is OFF (`packages/domain/src/commerce/o27a-flags.ts`); the served contract, the registry and the generated clients are
unchanged.

## What exists

| Piece | Where | What it proves |
|---|---|---|
| FedACH calendar `FEDACH-RULE-1` | `domain/src/commerce/o27a-fedach-calendar.ts` | Federal Reserve holidays by statute; Saturday holiday closes nothing, Sunday holiday closes Monday; 2026 equals the published FedACH schedule |
| Pending-payment hold (CP-01.11) | `domain/src/commerce/o27a-pending-hold.ts`, migration `0135_o27a_pending_payment_holds.sql` | five banking days vs 576 h ceiling, the later of hold and extension within the ceiling, one per quote and per sealed set ever, exact proof, step-up, owner review for the third, ends once, DELETE when unpaid, late credit refunded without revival; the table has no runtime write grant |
| Generic USD receipt + simulator | `domain/src/commerce/o27a-receipts.ts` | idempotent by (account, bank id); conflicting evidence is a review, never an overwrite; only COMPLETED USD credits are money; exact / partial / excess; late or unassigned credits refunded; balanced postings; deterministic non-fiscal receipt |
| Refund execution, never resend | `domain/src/commerce/o27a-refund-execution.ts`, `application/src/commerce/o27a/services.ts` | one POST per refund behind a compare-and-set fence; SUBMITTING/UNCERTAIN only GET; NOT_FOUND is no proof; owner's manual resolution; ledger only on COMPLETED |
| Invoice rules | `domain/src/commerce/o27a-invoice-rules.ts` | a receipt is never an invoice; DIAN needs activation, RUT, qualified issuer, numbering and verification; excess never invoiced; credit note only for service or tax |

## Decisions of this order (implementing-order choices CP-01.11 leaves open)

- **O27A-CAL-1.** Days are New York calendar days (FedACH's zone); a day ends at 00:00 New York of the next day.
- **O27A-HOLD-1.** The acceptance day does not count; the end is the end of the fifth banking day strictly after it.
- **O27A-HOLD-2.** "24 days from sealing" is 576 exact hours (D-TIME-B1).
- **O27A-HOLD-3.** A hold requested while the agency has two or more holds ended unpaid in the rolling 90 days (it would be the third)
  needs the owner's review; the database refuses it without `owner_review_ref`.
- **O27A-HOLD-4.** Uniqueness counts every hold ever granted for the quote or the sealed set (never renewable).
- **O27A-RCPT-1.** A booked COMPLETED bank credit moves receivable to available in the same posting set (no provider hold on the route).

## Effects matrix

| Area | Effect |
|---|---|
| Policy / contracts | none served; builds against the O19A build profile (CP-01.11, CP-02.17 values) |
| Backend | pure domain modules and two application services with ports; no route |
| Data | one table, read-only for runtime roles, RLS enabled and forced |
| Security | no write path exists; tenant isolation tested; the simulator refuses LIVE |
| Cost | 0 (no provider, no network) |
| Experience | none until activation |

## What unlocks each flag

- `pendingPaymentHold`: Wise Business enabled and the ACH route qualified with real evidence (PV1, O27B/O31), LR-02 counsel review,
  O19B adopting CP-02.17; then the activating order adds the write grant and policy to `pending_payment_holds`.
- `realReceiptSource`: PV1 with real Wise ACH receiving details and statements (PayPal stays parked).
- `dianIssuance`: RUT, a QUALIFIED fiscal issuer with numbering authorization, and the DIAN verification recorded.
