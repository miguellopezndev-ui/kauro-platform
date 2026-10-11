# ACH / bank-transfer route — case map (Payments V1)

Design-time map for [ACH-ROUTE r12](ACH-ROUTE.md) under the owner decision Payments V1
(`docs/authority/decisions/2026-10-07-PAYMENTS-V1.md`, "PV1"). Every proposed bank-route case and every registry case whose
remainder PV1 re-targets is listed with its **target evidence class**, its current status and the tests that will carry it, as
`file :: "exact title"`. No test exists yet: every row is **PLANNED** until its lane lands; the lane then rewrites the status
cell to the verified class on the exact commit. Matrix cells are titled `<VERB> <code> (<family>): <row label>` (ACH-ROUTE §7);
this map cites rows by id and one case-level title per case. No registry edit: no registry case names PayPal, and the vendored
R2 registry is not altered (ACH-ROUTE §8).

Evidence classes (as in the B09 map, plus two PV1 classes):
- **EXECUTED_LOCAL** — every clause demonstrated on real PostgreSQL with the fault harness; no simulated half.
- **PARTIAL** — local contract demonstrated; a named half (CONTRACT_FAKE bank-artifact format, a live account) remains with the
  named package/case. Cases that classify bank artifacts stay PARTIAL until ACH-LIVE-01 proves the real format (K-8).
- **LIVE** — a real, restricted-evidence exercise on the real account (no CONTRACT_FAKE, no screenshot).
- **LATER 2026-11-30** — a designed path not built for V1; status GAP; unreachable in V1, proven by a fail-closed cell (§7.27).
- **DEFERRED** — the live half of an automated-provider rail parked by PV1 §1 (DV1-09); no date; needs a new owner authorisation.

Lanes (PAYMENTS-V1-REPLAN §9): KIT, L-ROUTE, L-INBOUND, L-REFUND, L-SETTLE, S-B (`packages/adapters-wise`), S-E (`apps/web`).

## 1. Proposed bank-route cases (ACH-ROUTE §8)

| Case | Target class | Status | Lane | Matrix rows | Case-level test |
|---|---|---|---|---|---|
| ACH-01 | EXECUTED_LOCAL | PLANNED | L-ROUTE | R1–R2, I1, I3 | `packages/persistence/test/ach-route-cells.test.ts` :: "ACH-01 OK: a route reaches ENABLED only through PENDING_VERIFICATION and VERIFIED with real evidence; withdrawn details disable it; with no ENABLED route no details and no order exist" |
| ACH-02 | EXECUTED_LOCAL | PLANNED | L-ROUTE, S-E | I1–I3 | `packages/persistence/test/ach-route-cells.test.ts` :: "ACH-02 DENY: disabled, expired or foreign reads expose no account details; USD only; no subscription, BILL or Melio dependency" |
| ACH-03 | EXECUTED_LOCAL | PLANNED | L-ROUTE | I2, M1 | `packages/persistence/test/ach-route-cells.test.ts` :: "ACH-03 RACE: one immutable intent and 23-character reference per order; collisions retried before commit; a conflicting key is refused" |
| ACH-04 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-INBOUND | C4–C6, M2, P1 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-04 DENY: a manual draft is never confirmed money; confirmation rereads stored bytes under owner step-up; agency billing is refused; unknown, malformed or hash-mismatched evidence changes nothing" |
| ACH-05 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-INBOUND | C4–C6, S3, SI1–SI2, P2 (C1–C3, C7–C8, S1, S2, S4 LATER) | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-05 RACE: duplicate manual entries and overlapping statement imports book each receipt once; an immutable conflict is PROVIDER_INCONSISTENCY; orphan debits persist before coverage" |
| ACH-06 | EXECUTED_LOCAL | PLANNED | L-INBOUND | M1–M2, P1 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-06 DENY: a missing, foreign or truncated reference or a payer other than the accepted billing identity goes to MATCH_REVIEW; no agency is guessed" |
| ACH-07 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-INBOUND | P1–P2 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-07 OK: one exact USD credit applied while valid gives one capture, CAPTURED, one authorization, exact ledger, fee and funds" + `apps/api/test/b10-commission-service.test.ts` :: "OK rail parity: an exact bank-transfer capture accrues, holds and adjusts commission exactly as a provider capture of the same cents" |
| ACH-08 | EXECUTED_LOCAL | PLANNED | L-INBOUND, L-REFUND | P1–P2, F1–F2, G1–G2, P3 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-08 DENY: 400 + 600 against 1,000 and 1,010 against 1,000 are recorded with exact allocations, reviewed, returned by the owner, and never authorize" |
| ACH-09 | EXECUTED_LOCAL | PLANNED | L-INBOUND, L-REFUND | P1–P2, F1–F2, G1–G2, P3 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-09 OK (R2-140): two distinct exact receipts give one authorization, all money recorded, the excess returned, the commission basis capped" |
| ACH-10 | EXECUTED_LOCAL | PLANNED | L-INBOUND | I1–I3, P1, P1Δ, E1 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-10 RACE: before, at and after expiry with delayed observation and revoked source, approval or route, money is recorded, nothing is resurrected, the remedy is reviewed" |
| ACH-11 | EXECUTED_LOCAL | PLANNED | L-ROUTE, L-INBOUND | I2, M2, P1, E1 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-11 DENY: an explicitly retired checkout keeps its reference bound and a later credit on it is return-only" |
| ACH-12 | EXECUTED_LOCAL | PLANNED | L-INBOUND, L-REFUND | M1–M2, P2, F1–F2, G2, G6 | `packages/persistence/test/ach-refund-cells.test.ts` :: "ACH-12 OK: an unassigned receipt is booked in treasury, attribution moves it atomically to the agency, a return claim excludes attribution, a treasury refund is recorded in route scope" |
| ACH-13 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-ROUTE, L-INBOUND, L-REFUND | R2, P1–P2, G2–G4, P3 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-13 OK: fees are versioned data with source and access date; null fee differs from observed zero; gross equals net plus fee; outbound fees are recorded" |
| ACH-14 | EXECUTED_LOCAL | PLANNED | L-REFUND | F1–F2 (V3 LATER) | `packages/persistence/test/ach-refund-cells.test.ts` :: "ACH-14 DENY: owner approval binds source components, reserves the refundable balance, requires the payer's destination digest and requester segregation, and expires with its proof" |
| ACH-15 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-REFUND | G1–G2, G4, SI2 (G5, C2, S1–S4 LATER) | `packages/persistence/test/ach-refund-cells.test.ts` :: "ACH-15 DENY: no provider outbound call exists; a record is idempotent by bank execution id across scopes; above-refundable and above-payable resends are refused; an unrecorded debit keeps the period open" |
| ACH-16 | EXECUTED_LOCAL | PLANNED | L-REFUND | G2–G4, G6, P3 (G5, P4 LATER) | `packages/persistence/test/ach-refund-cells.test.ts` :: "ACH-16 RACE: record, reversal, bounce and resend in every order leave exact cents in both scopes; credit notes and commissions move only from capture refund completion" |
| ACH-17 | V1 rows EXECUTED_LOCAL; LATER rows LATER 2026-11-30 | PLANNED | all bank lanes | V1: 22 rows / 176 cells + §7.21–§7.25 (80 cells); LATER: 13 rows / 104 cells | each cell's own title (ACH-ROUTE §7) |
| ACH-18 | LATER 2026-11-30 | GAP | — | V1–V3 | V1 replacement: `packages/persistence/test/ach-inbound-cells.test.ts` :: "DENY ACH-M-FC-V (payer authorization LATER): a credit whose payer is not the order's accepted billing identity goes to MATCH_REVIEW and can only be returned; no payer-authorization command is served" |
| ACH-19 | EXECUTED_LOCAL | PLANNED | L-REFUND | G2, NR | `apps/api/test/refund-generic-v1.test.ts` :: "DENY CMD033 on a manual-rail refund: 409 MANUAL_RAIL_NO_AUTOMATED_OUTBOUND, nothing written" |
| ACH-20 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-INBOUND | SI1–SI2, S3, G2, X3 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-20 OK: an imported statement covers its interval once by bank transaction id, links recorded debits, keeps orphans open and is BALANCED only with zero orphans" |
| ACH-21 | EXECUTED_LOCAL | PLANNED | L-INBOUND | P1Δ, E1 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-21 OK (R2 15 expiry race): a credit booked by the deadline plus the route's provider-time tolerance and confirmed later is honored whether or not the expiry sweep ran, only with every subject guard valid and no other purchase; otherwise it is recorded and returned" |
| ACH-22 | PARTIAL (format: ACH-LIVE-01) | PLANNED | L-INBOUND | M1–M2, P1–P2 | `packages/persistence/test/ach-inbound-cells.test.ts` :: "ACH-22 OK: a domestic wire to the same details matches exactly like ACH on gross; its fee is observed separately; other rails go to review" |
| RFG-01 | EXECUTED_LOCAL | PLANNED | L-REFUND | F2, X1, G2, P3 | `apps/api/test/refund-generic-v1.test.ts` :: "RFG-01 OK: a manual-rail refund is declared, executed outside Kauro and recorded once with its evidence - refund.completed once, revenue/cash, seller commission and credit-note draft adjusted by exact cents, receipt kept" |
| RFG-02 | EXECUTED_LOCAL | PLANNED | L-REFUND | G1–G2, X1–X3, NR | `apps/api/test/refund-generic-v1.test.ts` :: "RFG-02 DENY: no path marks a refund COMPLETED without classified execution evidence, and no execution id completes two refunds" |
| RFG-03 | EXECUTED_LOCAL | PLANNED | L-REFUND | X2–X3 | `apps/api/test/refund-generic-v1.test.ts` :: "RFG-03 OK (D-24 A): an UNCERTAIN refund stays reserved until the owner resolves it with evidence" |
| RFG-04 | EXECUTED_LOCAL | PLANNED | L-REFUND | G3, X4, G2Δ/G4Δ, X2, X3, NR | `apps/api/test/refund-generic-v1.test.ts` :: "RFG-04 RACE: a bounced refund is re-sent only through a new declared attempt after the bounce is recorded, never while an attempt of the source is DECLARED or UNCERTAIN" |
| DV1-01 | EXECUTED_LOCAL | PLANNED | KIT | — | `packages/application/test/bank-route-genericity.test.ts` :: "DENY DV1-01 genericity: no type, table, column, enum value or event type added for the bank-transfer route names a provider" |
| K-9 | EXECUTED_LOCAL | PLANNED | S-E | — | `apps/web/test/checkout-bank-transfer.test.ts` :: "DENY no enabled route for the buyer: no instructions, no order" |
| ACH-LIVE-01 | LIVE | BLOCKED_OWNER (D-14, D-13, D-25) | B15 | I2, C4–C6, M1–M2, P1–P2 | the qualification payment (route ENABLED, rollout CONTROLLED): its ACH credit received and reconciled in Kauro; restricted evidence per `docs/payments/ACH-REAL-TEST-PLAN-2026-10-07.md` |
| ACH-REFUND-LIVE-01 | LIVE | BLOCKED_OWNER (after ACH-LIVE-01) | B15 | F1–F2, X1, G1–G2, P3 | the refund of **that same payment** declared (X1), SENT from Wise and recorded (G2) with Wise's send evidence proving the destination by DP-FULL or DP-RECIPIENT (ACH-ROUTE DV1-10; partial details leave it UNCERTAIN and GENERAL off); arrival at the payer is not awaited; a later bounce follows G3 then X4. ACH-LIVE-01 + ACH-REFUND-LIVE-01 = the CONTROLLED→GENERAL enable condition (ACH-ROUTE DV1-04; `ach-route-cells.test.ts` :: "DENY ACH-M-R2-GENERAL …") |

## 2. Registry cases re-targeted by PV1 (titles of accepted tests unchanged)

| Case (package) | Accepted status | V1 remainder → class | Carried by |
|---|---|---|---|
| S057, S058, S059, R2-078, R2-128 (B09) | PARTIAL, remaining B15 | bank-route half EXECUTED_LOCAL (ACH-04..09, 16) + LIVE in ACH-LIVE-01 / ACH-REFUND-LIVE-01 (B15) | existing B09 titles + §1 rows; R2-128 issuance stays B15 (CMD035, R2-082..084, S-B) |
| R2-081, R2-140 (B09) | PARTIAL, remaining B10 | unchanged B10 remainder; bank half EXECUTED_LOCAL (ACH-08, ACH-09, RFG-01) | existing titles + §1 |
| CMD028-OK/DENY/RACE (B09) | PARTIAL, remaining B15 (DENY also B08) | bank intent EXECUTED_LOCAL (ACH-03, I2 cells) + LIVE ACH-LIVE-01 | existing titles + ACH-03 |
| CMD029-*, CMD030-*, CMD033-*, CMD034-* (B09) | PARTIAL, remaining B15 (some B08/B10) | **DEFERRED** automated rail (DV1-09); the bank equivalents are C6/P1, C5/C6, X1/G2/NR, SI2/C6; CMD034-DENY's R2-085 half → ST1/ST2 | existing titles; `refund-generic-v1.test.ts` NR/FC-RAIL titles |
| S060 (B09) | PARTIAL, remaining B10 | unchanged | B09 map |
| R2-061 (B15) | — | local reordering EXECUTED_LOCAL: `packages/persistence/test/ach-refund-cells.test.ts` :: "RACE ACH-M-G6-RACE (reorder): Apply incoming-credit reversal", "RACE ACH-M-P3-RACE (reorder): FINANCE return-booking consumer", `ach-inbound-cells.test.ts` :: "RACE ACH-M-SI2-RACE (both orders): Import statement coverage"; webhook half **DEFERRED** | §1 |
| R2-085 (B15) | — | EXECUTED_LOCAL ST1/ST2 (`packages/persistence/test/settlement-cells.test.ts`, SET-M titles in ACH-ROUTE §7.25); LIVE Wise → Bancolombia after D-14 | L-SETTLE |
| R2-082..R2-084, CMD035-* (B15) | — | unchanged (fiscal adapter, S-B) | B15 map |
| S066 (B11) | per B11 map | EXECUTED_LOCAL `apps/web/test/operation-runner.test.ts` S066 title + "RACE ACH-M-I2-CRASH-AFTER (lost answer): Issue transfer instructions"; LIVE in ACH-LIVE-01 issuance | B11 map (S-E) |
| CMD052, CMD053, R2-103, R2-104 (B10) | per B10 map | unchanged EXECUTED_LOCAL; live payout → lane PAYOUT-MANUAL, LATER 2026-11-30 (first PAYABLE line ≥ Dec-2026, R2 17) | B10 map |
| S086, S081, S083 (B19) | — | S086: ACH-02 visibility cells (no production without collection, DV1-04); S081, S083 unchanged | ACH-02, `ach-route-cells.test.ts` I3 titles |
| S065, R2-074, R2-126 (B16); B18 walk | — | nonprod manual records: provider half SIMULATED, restore EXECUTED | B16/B18 maps |

Simulator self-tests kept in `packages/application/test/commerce-fakes.test.ts` ("PayPal Orders v2 contract fake: …",
"WebhookVerifier contract fake: …", "R2-080 (Windows flake …)") are labelled **"simulator self-test, not V1 rail evidence"**; they
stay because every accepted B09/B10 test uses the simulator (deleting them would edit accepted B09 files).

## 3. Gates (r8, PV1 Addendum)

- **Production (B19)** requires the bank route ENABLED with rollout GENERAL; there is no production with collection closed.
  Production date = max(2026-10-17, the day GENERAL is enabled); V1 cells EXECUTED_LOCAL on main by checkpoint CP-V1 (14-oct 20:00).
- **GENERAL** = ACH-LIVE-01 and ACH-REFUND-LIVE-01 on one payment (credit reconciled; its refund sent and recorded with the send
  receipt). If the Wise USD details are not live by 2026-10-12 20:00, the production date moves; PayPal is not reintroduced.
- **"Commercially live"** (R2 15 §Initial payment decision paragraph 3) additionally needs delivery and the fiscal evidence on a
  real order (the test's invoice and credit note). [SUPERSEDED r8: the r7 G-PRODUCTION-with-route-not-ENABLED text.]
