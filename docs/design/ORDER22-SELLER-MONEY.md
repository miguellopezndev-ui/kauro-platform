# Order 22: seller money, statements balance, claim refusals and alerts (candidate, activation OFF)

Built in the Stage A sprint against REISSUE-CANDIDATE-01 (build profile) with the CP-01.04, .05, .06, .07, .13 and .14 decisions of the
owner's resolution of 2026-10-22. Nothing is adopted: the registry, `apps/api/openapi.json` and the generated clients are unchanged, and
every route is unregistered unless `KAURO_O22_CANDIDATE=on` (`o22Activation`). The claim rules keep `PENDING_COUNSEL` (CP-01.14): every
refusal row records it and nothing can change it.

## What is built

| Layer | Where | What |
|---|---|---|
| Domain | `packages/domain/src/commercial/o22/` | Candidate values (drift-checked against the CP-01 delta), the four figures per seller and in total, the retainer rule, the statement balance, refusal validation (seven codes, evidence, notes, owner rules never retroactive), the review rules, alerts (thresholds, precedence, one per subject, material progress only). |
| Database | `packages/persistence/migrations/0120_o22_seller_money_claims.sql` | Pool basis history (by trigger), retainer accruals held to the agreement in force, refusal reasons, owner rules, refusals, reviews, decisions, the seller-safe decision log; seller reads of periods and of its own pools' basis. |
| Adapter | `packages/persistence/src/o22-access.ts` | `o22Of(uow)`: every read under the caller's own row policies. |
| API | `apps/api/src/o22/` | Ten candidate operations (handlers and a route module that registers nothing while OFF). |

## The figures (CP-01.13)

- A collection counts in the period its capture was confirmed: the pool is born at the capture's durable confirmation, and its basis
  history starts there. A refusal-free refund counts in the period the ledger recorded the basis fall. Earlier periods are never rewritten.
- Each capture counts once in the total, even when an acquisition and an assistance pool commission it or sellers split it; a seller's
  revenue is its share of the basis, rounded half up once on the cumulative basis, so a capture's periods add up exactly.
- Generated: the first posting in its period plus each signed adjustment in its period. An offset is reported apart
  (`refundOffsetCents`) and never subtracts again from generated (the refund already did).
- Held: accruing and held lines, and OPEN holds; payable: eligible and payable lines net of holds and live offsets; paid: SETTLED payouts
  in the period. Pending = held + payable.
- Statement balance: payable = earned − offsets + retainer − held from the statement's own items; an offset counts once (from the line it
  is applied against), a hold once.
- Retainer: USD 0.00 by default; the signed agreement in force at the month's start (signed by then) prevails; one accrual per month,
  append-only, its amount checked by the database.

## Gaps for the owner (D-34), found while building against the candidate

| Id | Severity | Gap | Proposal |
|---|---|---|---|
| G-O22-01 | FUNCTIONAL | CMD072 CHANGE "returns the claim to review", but neither the registry nor the candidate lists an AttributionClaim edge out of REJECTED (and the transition log refuses an unlisted edge). Built: CHANGE withdraws the refusal and the claim stays REJECTED; the seller no longer sees the refusal's message. | Add `REJECTED -> SUBMITTED` (refusal withdrawn by a CHANGED review only) to the machine at the re-issue. |
| G-O22-02 | FUNCTIONAL | SellerMoneySummary carries non-negative amounts only; a refund in a later period than its collection makes that period's revenue or generated negative. Built: the read refuses `FIGURE_NEGATIVE_IN_CANDIDATE_CONTRACT` rather than clip. | Allow signed per-period figures (or split collections and refunds) in CP-02.09. |
| G-O22-03 | MINOR | A refusal whose code is not OWNER_RULE but names an owner rule: the candidate has no outcome. Built: refused `OWNER_RULE_NOT_ALLOWED`. | Add the outcome to CMD071. |
| G-O22-04 | FUNCTIONAL (partial) | Owner alerts: project and pilot subjects have no bound source yet (their facts are other orders' reads); the owner's list holds claim alerts. | Bind the project dates and material-progress acts when their reads exist. |
| G-O22-05 | FUNCTIONAL (activation) | The retainer accrues and the balance reads it, but CMD051 (period close) does not yet put a RETAINER item in the statement's payable. | Wire it into the close with the adoption of CP-02.10. |
| G-O22-06 | MINOR | Candidate pages: at most 100 items, no cursor yet. | Add cursors with the served pages. |

## Proof

- `packages/domain/test/o22-seller-money.test.ts`, `o22-claims-alerts.test.ts` (21 tests): zero double counting, periods never rewritten,
  a 300-trial rounding property, offsets and holds counted once, the retainer rule, the seven codes, adversarial refusals, reviews,
  alert thresholds and precedence, and the drift guard against the CP-01 delta.
- `packages/persistence/test/o22-seller-money-claims.test.ts` (3 tests, real PostgreSQL 17): the same figures from the database's own rows,
  seller and owner computing the same row, no leakage between sellers, agencies or roles, append-only history and accruals, the
  database's own refusal of every adversarial refusal and review.
- `apps/api/test/o22-handlers.test.ts` (4 tests): routes absent while OFF, standing refused before any effect, replays, what a seller reads.

## Review fixes (reviews/O22.md, 2026-10-22)

- **F-1.** The pool's birth is stamped with its qualifying purchase's `confirmed_at` (`kauro.commission_pool_born_at`) and each fall
  with the completion of the refund that took the capture's service down to it, or the capture's reversal at zero
  (`kauro.commission_pool_fell_at`); the processing instant only when neither is visible. The backfill rebuilds one fall per distinct
  adjusted basis (M-2).
- **F-2.** An UPHOLD keeps the refusal's own code, in the domain (`decideReview(state, decision, refusalCode)`) and in the database
  (`claim_review_decisions_keep_code`).
- **F-3.** Held and payable follow the close's own classification: an ELIGIBLE line whose capture's funds are not AVAILABLE is held
  (AWAITING_FUNDS), a settled line's seller credit not yet itemized is payable (CREDIT). A seller reads the funds of its own captures
  (`capture_funds_observations_seller_read` through `kauro.seller_holds_capture`).
- **M-4.** The retainer of a month is the signed agreement in force at the month's first instant; a mid-month start is not prorated
  here (an agreement whose terms prorate needs that term recorded first).
