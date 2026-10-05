# Amendment A8 — payment routing: ACH USD (Wise Business) first, PayPal Business second

Status: owner decision of 2026-10-05 (chat instruction, recorded verbatim in substance by the builder). Amends manual 15
(Payments and tax) §"PayPal Business is the initial USD collection candidate", decision D25 and the B09/B15/B19 payment
scope where they treat PayPal as the primary or default route. Everything else in R2, A3, A4, A6 stands. Not yet hashed in
PROVENANCE.md: it is added with the A7 re-issue, together with A7.

## 1. Collection hierarchy

| Rank | Route | Role | State on 2026-10-05 |
|---|---|---|---|
| 1 | **ACH USD received through Wise Business account details** | Preferred route for US B2B customers | **PENDING_VERIFICATION**: Wise Business is not opened or approved. Official Wise material indicates receiving support for Colombia and that a business account with USD details can receive US domestic ACH; this is a capability only once Kauro's real KYC confirms it. |
| 2 | **PayPal Business** | Secondary / fallback: card or PayPal, and customers who prefer an immediate checkout | Existing work (B09 Orders API, webhooks, refunds, withdrawal) is kept intact; only its role changes from primary/default to secondary/fallback. |
| 3 | **Bancolombia empresarial** | Treasury and Colombian banking operation of Kauro Data S.A.S. | Not a customer checkout route for international customers. |

## 2. Rules

1. **Nothing built is removed.** PayPal stays, with every accepted case and live clause it already carries (B09, B15 OA09/OA10,
   R2-085). No accepted package is reopened by this amendment; a later diff that touches their files is re-verified only for
   that diff (A6).
2. **Wise does not block launch.** If Wise is not verified when the rest of Kauro is production-ready, production launches with
   PayPal only; ACH is activated when the Wise route is VERIFIED. The ACH route must therefore be switchable by configuration
   (route state PENDING_VERIFICATION → VERIFIED → ENABLED), never assumed present.
3. **Customer presentation (US customers).** Recommended: "US bank transfer / ACH". Alternative: "PayPal / card". ACH is shown
   only while its route is ENABLED.
4. **Project-based, no subscriptions.** No automatic recurring charge; Kauro remains project-based as A3 states.
5. **AP platforms.** A customer paying through BILL, Melio or another AP platform pays to the accepted bank details. No
   BILL/Melio integration is built before launch.
6. **Currencies.** No COP is shown to foreign customers. Colombian customers settle in COP by their own route, which is not
   mixed with the international USD checkout.
7. **Fees are data, not truth.** External fees (e.g. PayPal Colombia, about 5.40% plus a fixed fee at the initial range per
   manual 15 S35; Wise receiving fees) are versioned configuration with source and access date, verified against the provider,
   never hard-coded as permanent facts. The platform already records the provider fee observed per capture
   (`providerFeeCents`); estimates shown before payment come from that versioned configuration.
8. **Optimisation target is routing**, not hiding a PayPal conversion behind Wise.

## 3. Consequences for construction (builder)

- **New, bounded scope (post-B09, inside B15/B19):** a bank-transfer (ACH) payment route on the existing provider-neutral
  route model: payment instructions with a unique reference per order, reconciliation of the incoming credit (manual entry by
  the owner role first; Wise API only after the account exists and its API is verified), the order paid only on a reconciled
  credit of the exact amount and currency, refunds as outbound transfers under owner approval. Its failure matrix and cases are
  written before code and reviewed by Codex; it reuses the commerce ledger and authorization paths, not a parallel ledger.
- **B11/B12 copy and checkout** order the routes as in rule 3; the D-08b legal texts (terms) describe both routes.
- **Owner acts (cards):** open Wise Business and pass KYC (PENDING); PayPal Business KYC continues unchanged.
- **Launch gate:** B19 may activate with PayPal alone; ACH enabling later is a configuration change plus its own live
  verification (one real ACH credit reconciled end to end), not a re-release.
