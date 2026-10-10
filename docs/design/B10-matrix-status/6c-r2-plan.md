# B10 lane 6c, round 2 plan (Codex lane review REJECT on 5e37366: 6C-R1..R4 BLOCKING, R5 MAJOR, R6 MINOR)

Plan only: no product code in this commit. Base `b10/gaps-6c@5e37366` (PR #24). Findings: `tools/review/out/b10-6c-lane-5e373664171a/review.json`.
Matrix rows: `docs/design/B10-failure-matrix.md` (CMD046, CMD047, CMD049 rows edited; new sections "CMD028 order insert (B10 attribution
edge)" and "Owner agreement withdrawal"). Cell ledger: `6c.md` (new GAP lines, prospar46 back to PARTIAL).

## 1. Authority first (R2 lines, then the input-only predicate and its census)

- R2 17 "Attribution subject" (doc-slice exact): "A claim must be submitted before the first paid order and normally before the audit
  invitation. Backdated notes do not create retroactive entitlement."
- R2 17 "Claim validity and conflicts": "A split must be agreed and recorded before the qualifying payment where feasible, with shares
  summing to 100% of the applicable commission pool. The pool does not become 10% for each seller."
- R2 17 "Attribution subject": "Existing inbound opportunities can be assigned to a seller with an explicit compensation assignment before
  the seller performs the agreed work."
- R2 17 "Recurring entitlement": "The residual belongs to the accepted attribution agreement and can continue after operational
  reassignment or termination, subject to the signed lawful terms".
- R2 17 "Activation prerequisites": "ACTIVE requires a signed reviewed relationship agreement, ...".

Predicate P1 (input-only): a beneficiary claim c is admissible at an acceptance iff for every payment order o of the allocation's agency,
`c.submitted_at < o.created_at` ("before" = strictly before; equality is not before). Census over the inventory (every comparison of a claim's
submission with an order instant in `packages/**/src`, `apps/api/src`, migrations; grep `submitted_at`):
1. `commercial-prospect-access.ts:17-19` acceptance, `po.created_at < submitted_at`: admits equality, and only for the NAMED claim
   (`accept-attribution.ts:91`): **violates P1** (6C-R1).
2. `0029_sales_attribution.sql:1093` conversion guard `OLD.submitted_at >= first.order_created_at` refuses: strict, conforms.
3. `commercial-attribution.ts:269-270` `convertibleAtFirstPurchase` `c.submitted_at < q.order_created_at`: strict, conforms.
No fourth comparison exists. Fix: (1) only, per beneficiary, `<=` refusal.

Order set (decision D10-6C-1): P1 ranges over EVERY order of the agency, whatever its state, not only paid ones. R2 says "first paid order";
an open, expired or cancelled order can still become the first qualifying purchase by a late capture (the conversion compares with the
first qualifying purchase's own order, 0029:1093), so admitting a claim later than an unpaid order can freeze an allocation that never
converts (the 6C-R1 money loss). Conservative reading: any order blocks; the seller's remedy for an agency already in the order funnel is
the explicit compensation assignment R2 17 provides (quoted above). Existing sequential cell `cmd047-accept-attribution.test.ts:174` keeps it.

Agreement in force (decision D10-6C-2): every command resting on an agreement judges `signed_at IS NOT NULL AND (ends_at IS NULL OR
ends_at > kauro.effect_now())` after its last lock wait AND again at COMMIT (template rules 15/16; 0040/0048 precedent). An agreement
ending after a committed acceptance does not touch the accepted rights (R2 17 "Recurring entitlement" quoted above): the authority order is
the COMMIT order, made total by the seller lock (section 2.2). R2 does not decide what a withdrawal may write as `ends_at` (the writer is
the owner's SQL stand-in, ADV-4): deferred to the agreement-lifecycle package (section 7).

Clock source (decision D10-6C-3): `payment_orders.created_at` is the process clock sampled after the journal reserve
(`provider-effects.ts:434`, `runtime.ts:314`); `submitted_at` is the database's (`commercial-attribution.ts:226`). R2 does not decide a
clock source; conservative reading: no correctness may rest on the two being synchronized, so CMD028 refuses retryably when its process
instant stands before the database instant read under its order lock (section 2.1, cell ORDER_CLOCK).

## 2. Lock and commit-instant design (acquisitions verified by Read on 5e37366)

Advisory helpers: shared `kauro.await_transition` (0001:271-273), exclusive `pg_advisory_xact_lock` via `take_transition_lock`
(0001:277-293) or `holdSalesTransition` (commercial-sales-rows.ts:60-62). All held to COMMIT.

### 2.1 R2: new subject `kauro.agency_orders` (agency)
- CMD028 provider (`create-payment-order.ts:173-177` access) and bank issuance (`bank/instructions.ts:101-107` access): after the
  authorizer's ALLOW, NEW `queries.agencyOrdersHeld(uow, agencyId)`: `await_transition('kauro.agency_orders', agencyId)` (SHARED), then in the
  next statement returns `kauro.effect_now()` = L. This runs BEFORE the journal reserve and the `now` sample (`provider-effects.ts:418,434`;
  `runtime.ts:302,314`). Intent (provider, `create-payment-order.ts` intent start) and bank body: `now < L` -> DomainFailure
  CAPACITY_UNAVAILABLE retryable, nothing written (D10-6C-3). Port `runtime.ts:69` union + impl `commerce-request-reads.ts:30`.
- CMD047 (`accept-attribution.ts:64`): right after `lockAgencies([agency])` NEW `attribution.lockAgencyOrders(agencyId)` = EXCLUSIVE
  `pg_advisory_xact_lock(transition_key('kauro.agency_orders', agency))`. The read at :91 (now per beneficiary, `<=`) follows it.
- Why both orders conflict: CMD028 first -> CMD047's exclusive request waits until CMD028 commits; the read at :91 (new READ COMMITTED
  snapshot) sees the order, whose created_at = now <= every claim submitted while CMD028 ran -> CLAIM_AFTER_FIRST_ORDER. CMD047 first ->
  CMD028 waits in access BEFORE sampling `now`; CMD047's beneficiaries were submitted before CMD047 started, so after its COMMIT
  `L > submitted_at` and `now >= L` -> `created_at > submitted_at`: the order is genuinely later and converts. Neither order can produce
  an ACCEPTED claim submitted at/after a committed order (the 6C-R2 interleaving "order sampled before the claim, inserted after the
  acceptance" is unreachable: the shared half is held from before the sample).
- Global order (design §10) position: identity -> membership -> corporate grant -> seller -> agency -> **agency orders** -> ... -> quote ->
  payment order; CMD047's corporate chain: corporate grant -> seller (2.2) -> agency commissions -> **agency orders** -> claim -> allocation.
  Every holder of the new subject: CMD028 provider, CMD028 bank (shared; they hold identity/membership/agency shared halves, the journal
  row, then quote FOR UPDATE `create-payment-order.ts:100`, order/attempt/scope inserts; never a seller, agency-commission, claim,
  allocation or corporate-grant lock) and CMD047 (exclusive; after it only the claims subject (`lockClaim` commercial-attribution.ts:255),
  claim/allocation rows and their FK KEY SHAREs, which CMD028 never holds in a conflicting mode: no FOR UPDATE on agency rows). No cycle.
  Loser: CMD047 re-reads (409 CLAIM_AFTER_FIRST_ORDER); CMD028 waits then proceeds (201) or, under skew, 503 CAPACITY_UNAVAILABLE retryable.
- R1 in the same read: `agencyOrderPrecedesClaim` refuses on `po.created_at <= submitted_at`, called for EVERY share's claim (port and
  composition signature unchanged: `runtime.ts:22-24` of prospects, composition.ts:416 untouched).

### 2.2 R3: CMD047 takes each beneficiary seller's SHARED half
- Withdrawal (owner `UPDATE seller_agreements SET ends_at`) takes the seller's EXCLUSIVE half: trigger `seller_agreements_transition_lock`
  (0048:61-63) -> `take_transition_lock('kauro.sellers','seller_id')` (0001:291).
- CMD047: before `lockAgencies` (`accept-attribution.ts:63-64`), NEW `sales.holdSellersShared(sellerIds of prepared.shares, ascending)`
  (= `awaitSalesTransition(db,'kauro.sellers',id)` as commercial-sales.ts:339). After the re-read at :74, a share whose seller is not in the
  held set -> INTEGRITY_FAILURE (no product writer appends shares; fixtures write allocation+shares together: sales-support.ts:118-131).
- Conflict: acceptance first -> the withdrawal's exclusive request waits until CMD047 commits; withdrawal first -> CMD047 waits at the
  shared half, then judges agreements at `kauro.effect_now()` after its last lock (next to the deadline re-judge, :104-106) -> refuses.
- Global order: corporate grant -> seller -> agency commissions -> claim, exactly CMD050's (`terminate-seller.ts:62` lockSeller exclusive,
  `:69` lockAgencies, then lockClaim). Holders of the seller's EXCLUSIVE half: lockSeller (commercial-sales.ts:372; CMD049, CMD050), state
  trigger 0029:695-696, destination change 0035:16, agreement_id 0048:58-59, ends_at 0048:61-63. None waits for a lock CMD047 holds before
  its seller request (only CMD047's own corporate-grant shared half and journal row). Shared takers (authorizer :339, claimant 0029:1027,
  destination :519, CMD047) never block each other. No cycle. Loser: CMD047 409 PRECONDITION_FAILED SHARES_NOT_WHOLE (KC003's existing
  "under signed agreements" meaning; outcomes.ts:61 description extended); the withdrawal just waits.

### 2.3 R4: commit-instant rules
- CMD046: `claim-prospect.ts:59` `agreementInForce(sellerId, now)` -> NEW `agreementInForceAtEffect(sellerId)` (SQL `kauro.effect_now()`),
  after `lockProspect` (:57, the last wait). DB: claimant trigger (0029:1027-1031) also requires the named agreement signed and
  `ends_at > kauro.effect_now()`; NEW deferred constraint trigger `attribution_claims_agreement_in_force` AFTER INSERT, INITIALLY
  DEFERRED, same predicate at COMMIT, raising check_violation CONSTRAINT `attribution_claims_agreement_in_force` -> sqlstate.ts
  COMMERCIAL_CONSTRAINT_FAILURES -> 409 PRECONDITION_FAILED AGREEMENT_VERSION_MISMATCH (CMD046's own outcome, outcomes.ts:51).
- CMD049: `activate-seller.ts:64` `signed` uses pre-wait `now` -> judged by NEW `sales.agreementInForceAtEffect(sellerId, agreementId)` as
  the last await before `transitionSeller` (:85). KC005 (0029:851) `ends_at <= kauro.server_now()` -> `kauro.effect_now()` (after its
  identity wait 0029:845). NEW deferred trigger `sellers_activation_agreement_at_commit` (AFTER UPDATE OF state WHEN CANDIDATE->ACTIVE)
  raising KC005 SIGNED_AGREEMENT -> 409 SELLER_NOT_ACTIVATABLE.
- CMD047: app check (2.2) after the share locks; `attribution_allocations_whole` (0029:1163) `g.ends_at <= allocation.frozen_at` ->
  `g.ends_at <= kauro.effect_now()` (effect_now >= frozen_at, strictly stronger) -> KC003 at COMMIT.
- All in NEW migration `0049_b10g6c_r2_ordering.sql` (provisional number; renumbered at rebase). Idempotent (CREATE OR REPLACE, DROP IF EXISTS).

## 3. Failure-mode rows (summary; full rows in B10-failure-matrix.md, "6c r2" marks)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-B | CRASH-A | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| CMD046 W | C a46race | GAP CMD_TMO (t3) | GAP AGREEMENT_END46 (t1) | C | GAP CMD_CRA | C | C actrace46; N/A withdrawal leg (3.1) | GAP PROS_DISP (t1) |
| CMD047 W | C a47race; GAP ORDER_ACCEPT (t1) | GAP CMD_TMO | GAP AGREEMENT_END47 (t1) | C | GAP CMD_CRA | C | GAP AGREE_WD47 (t1) | C attrpar47 |
| CMD047 R-order | GAP CLAIM_ORDER (t1) | N/A read | N/A instants stored | N/A no write | N/A | N/A | N/A | N/A |
| CMD049 W | C a49race | GAP CMD_TMO | GAP AGREEMENT_END49 (t1) | C | GAP CMD_CRA | C | C corprev49 | N/A one row |
| CMD028 order insert | GAP ORDER_ACCEPT (t1) | B09 rows | GAP ORDER_CLOCK (t1) | B09 | B09 | B09 | N/A no attribution authority | B09 |
| Agreement withdrawal | GAP AGREE_WD47 (t1) | N/A owner SQL | N/A | N/A | N/A | N/A | itself | N/A one row |

### 3.1 Cells NOT written (unreachable or not red-provable; the family Codex flagged)
- "order sampled before the claim, inserted after the acceptance": unreachable by design (2.1). Not a cell.
- CMD046 vs withdrawal committed first: the stand-in writes `ends_at = now()` (its own start, BEFORE the claim's sample), so the old code
  also refuses: not red-provable. Natural expiry during the wait (cell 11) is the red-provable form.

## 4. Case map skeleton and cells (file for all new cells: `apps/api/test/b10-failure-cells-6c-r2.test.ts`, NEW, faultCell)

Evidence class: all EXECUTED_LOCAL (PG17 WSL). Cases: CMD047-DENY, CMD047-RACE, R2-097 (split pool), CMD046-DENY/RACE, CMD049-DENY/RACE.
faultCell title = `ID [fault] step -> expect` (matrix.ts:53-56); a faultCell must carry its fault evidence (assertInjected), so sequential DENYs are plain `it` with the exact quoted title. Lock traces: O=CMD028 conn, A=CMD047, C=CMD046, V=CMD049, W=owner withdrawal, H=holder.
Ledger ids in 6c.md, by number: 1 g6c-r2-order-split, 2 -order-equal, 3 -order-sole, 4 -orderacc-prov, 5 -orderacc-bank, 6 -orderacc-early, 7 -orderacc-first, 8 -orderclock, 9 -wd-sole, 10 -wd-split, 11 -end46-wait, 12 -end46-commit, 13 -end49-wait, 14 -end49-stmt, 15 -end49-commit, 16 -end47-wait, 17 -end47-commit, 18 -prosdisp, 19 -fixture (prefix g6c-r2).

1. (plain `it`, sequential DENY: no fault to inject, so not a faultCell) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY:
   a 6000/4000 split accepted through X (submitted before the agency's order) whose share Y was submitted after that order is 409
   PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER: both claims unchanged, the allocation unfrozen, no COMMITTED journal". Sequential. Red: 200 on 5e37366.
2. (plain `it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: share Y submitted exactly at the order's created_at (microsecond equal) refuses the split 409
   CLAIM_AFTER_FIRST_ORDER; nothing written". Red: 200.
3. (plain `it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: a sole claim submitted exactly at the order's created_at is 409 CLAIM_AFTER_FIRST_ORDER; one
   submitted one millisecond before it is accepted 200". Red: equality leg 200 (`<` kept); admit leg guards `<=`->`<` over-refusal.
4. ORDER_ACCEPT [race] "CMD047 AcceptAttribution / RACE: W against CMD028 CreatePaymentOrder (provider) inserting the agency's order" ->
   "RACE: CreatePaymentOrder paused after its order insert holds the agency's order subject; AcceptAttribution of a claim submitted after
   the order's instant waits (observed) and, once the order commits, is 409 CLAIM_AFTER_FIRST_ORDER, writing nothing".
   Trace: O access agencyOrdersHeld SHARED (create-payment-order.ts:173+) -> reserve -> now=T0 -> quote lock :100 -> insert
   commerce-orders.ts:185, pause db.order_insert.after. C submits claim (seller shared :339, claims excl lockProspect :607; no conflict).
   Fixture prepares allocation. A: seller shared (new) -> agency_commissions (:248) -> agency_orders EXCLUSIVE (new) WAITS on O (mustWait,
   holder pid O). O released, COMMIT. A: lockClaim :252-256 -> read :91 sees T0 <= T1 -> 409. Red: remove lockAgencyOrders -> no wait.
5. ORDER_ACCEPT [race] same, bank-transfer issuance (`instructions.ts:180` insert, pause after it). Same trace via access :101-107. Red: same.
6. ORDER_ACCEPT [race] "... CMD028 paused BEFORE its order insert (after its instant)" -> "RACE: the acceptance still waits: the order
   subject is held from before the order's instant; after the order commits the acceptance is 409 CLAIM_AFTER_FIRST_ORDER". Trace as 4,
   pause db.order_insert.before. Red: lock moved from access to the insert (or removed) -> A does not wait, commits 200.
7. ORDER_ACCEPT [race] "acceptance first" -> "RACE: AcceptAttribution paused at its COMMIT holds the order subject; CreatePaymentOrder
   waits in its access (observed), then answers 201 with created_at after every beneficiary's submission; at its capture the COMMISSIONS
   consumer converts both claims of the 6000/4000 split and accrues exactly one acquisition pool (shares 6000+4000)". Trace: A holds
   seller shared, agency_commissions, agency_orders EXCL, claims; pause uow.before-commit. O access agencyOrdersHeld WAITS (observed).
   Release A (200). O: L read, now>=L, insert, 201. Capture + runConsumer (b10-cells-support.ts:70), rightsOf/convertedFor (:163,:176).
   Red: remove the shared half in access -> no wait observed.
8. (plain `it`) "ORDER_CLOCK CMD028 CreatePaymentOrder / order instant: DENY: a process clock 5 s behind the database clock is 503 CAPACITY_UNAVAILABLE retryable, no order, the quote ISSUED, no journal
   result; the same key with the clock caught up answers 201". Red: guard removed -> 201 with created_at before L.
9. AGREE_WD47 [revocation] "CMD047 AcceptAttribution / REVOCATION: W against the owner's withdrawal of the sole beneficiary's agreement"
   -> "RACE, both orders, wait observed: acceptance paused at COMMIT -> the withdrawal waits and lands after the 200 (claims ACCEPTED,
   allocation frozen); withdrawal uncommitted -> the acceptance waits on the seller and is 409 SHARES_NOT_WHOLE, nothing written".
   Trace leg1: A seller SHARED (new) ... pause uow.before-commit; W UPDATE ends_at -> 0048:61-63 -> 0001:291 EXCL WAITS. Leg2: W holds
   EXCL; A access, reserve, getAllocation :63, holdSellersShared WAITS; W COMMIT; A ... agreement check at effect_now -> 409. Red: no
   holdSellersShared -> InterleavingNotObserved in both legs.
10. AGREE_WD47 [revocation] same for a 6000/4000 split, the withdrawal of the NON-named beneficiary Y. Same trace on Y's seller key.
11. AGREEMENT_END46 [race] "CMD046 ClaimProspect / EXPIRY: the agreement's end passing during the prospect-lock wait" -> "RACE: 409
    PRECONDITION_FAILED AGREEMENT_VERSION_MISMATCH, no claim, the claim insert never sent". Trace: owner sets ends_at =
    effect_now+margin (commit). H takes claims(P) EXCL (as a competing ClaimProspect/AcceptAttribution/TerminateSeller holds it). C:
    seller shared :339 -> lockProspect :607 WAITS (mustWait) -> crossedWhileWaiting (b10-cells-support.ts:242) -> H COMMIT -> check at
    effect_now -> 409. Red: pre-wait `now` -> insert sent (assert `!points.passed.includes("db.claim_insert.before")`).
12. AGREEMENT_END46 [expiry] "... the end passing between the claim insert and COMMIT" -> "DENY: 409 AGREEMENT_VERSION_MISMATCH at
    COMMIT (attribution_claims_agreement_in_force), no claim, no journal result". Pause uow.before-commit. Red: deferred trigger removed -> 201.
13. AGREEMENT_END49 [race] "CMD049 ActivateSeller / EXPIRY: the end passing during the identity wait of activationFacts" -> "RACE: 409
    SELLER_NOT_ACTIVATABLE, seller CANDIDATE v1, the seller UPDATE never sent". Trace: V lockSeller EXCL :372 -> activationFacts waits on
    identity (H holds identities EXCL via an MFA-withdrawal UPDATE, 0048:47-49, then ROLLBACK) -> crossed -> agreementInForceAtEffect
    -> 409. Red: `signed` on pre-wait now -> UPDATE sent.
14. AGREEMENT_END49 [race] "... the end passing while KC005 waits on the identity" -> "RACE: refused AT the seller UPDATE (KC005 at
    effect_now): db.seller_update.after never reached". Pause db.seller_update.before, H takes identity EXCL, release, UPDATE waits in
    0029:845, crossed, H ROLLBACK. Red: KC005 on server_now -> UPDATE passes (refused later at COMMIT, `.after` reached).
15. AGREEMENT_END49 [expiry] "... between the seller UPDATE and COMMIT" -> "DENY: 409 SELLER_NOT_ACTIVATABLE at COMMIT, seller
    CANDIDATE v1". Pause uow.before-commit. Red: deferred agreement trigger removed -> 200.
16. AGREEMENT_END47 [race] "CMD047 AcceptAttribution / EXPIRY: a share's agreement end passing during the agency-commission wait" ->
    "RACE: 409 SHARES_NOT_WHOLE, the freeze never sent". H takes agency_commissions EXCL (pattern attribution test :457). Red: no app check.
17. AGREEMENT_END47 [expiry] "... share Y's agreement end passing between the writes and COMMIT" -> "DENY: 409 SHARES_NOT_WHOLE (KC003
    at COMMIT), allocation unfrozen, claims unchanged". Red: whole trigger on frozen_at -> 200.
18. PROS_DISP [partial] "CMD046 ClaimProspect / PARTIAL: W claim insert + separate DISPUTED update (one COMMIT)" -> "RACE (partial): with
    another seller's live claim on the prospect, failures after the claim insert (before the DISPUTED update) and after the DISPUTED
    update (before the journal COMMITTED) each roll back totally (no claim, no journal); the retry is DISPUTED at version 2 with its
    conflict reason and the replay answers the journaled 201". Steps: CLAIM_INSERT, CLAIM_DISPUTED (/UPDATE kauro.attribution_claims SET
    state = 'DISPUTED'/, commercial-attribution.ts:232-236). Red: mutation omitting the UPDATE -> FaultNotInjected and retry SUBMITTED v1.
19. FIXTURE_DEADLINE (plain `it`) "acceptAttribution fixture refuses an acceptance exactly at a claim's review deadline before any write"
    -> asserts the descriptive fixture error, no allocation row added. Red: guard `>` (commission-support.ts:298).

Ledger impact (6c.md): prospar46 C -> PARTIAL until cell 18 is C; new GAP lines for cells 1-19; caveat ADV-10 retired (cells 11-17).

## 5. Lanes (file ownership; tests first, then build)

- T (kauro-test-designer, Opus): owns `apps/api/test/b10-failure-cells-6c-r2.test.ts` (new). Writes cells 1-19 RED on 5e37366 (each with
  its failing assertion text). Est 120k tokens, 60 min. Done: 19 cells compile; each fails for its named defect; no other file edited.
- B (kauro-builder, Sonnet): owns `packages/persistence/migrations/0049_b10g6c_r2_ordering.sql` (new), `accept-attribution.ts`,
  `commercial-prospect-access.ts`, `claim-prospect.ts`, `activate-seller.ts`, `commercial-sales.ts`, `commercial-attribution.ts`,
  `packages/domain/src/ports/commercial.ts`, `create-payment-order.ts`, `bank/instructions.ts`, `commerce/request/runtime.ts`,
  `commerce-request-reads.ts`, `sqlstate.ts`, `commercial/outcomes.ts`, `apps/api/test/commission-support.ts` (R6 guard `>=`), docs
  (6c.md red proofs, design §10 order line, D10-6C-1..3). Est 180k tokens, 90 min. Done: 19 cells green; red proof per fix (revert one,
  run its cell, record assertion text); impact inventory: every suite calling CMD028 (B09 payment, bank, statements, commission) run on
  the base first and after (ORDER_CLOCK guard: a fixture with the process clock behind the DB clock is a fixture defect, fixed there,
  never by weakening the guard; stop and report if > 5 suites). No composition.ts edit (else Codex doc-review per CLAUDE.md §2).
- Then kauro-adversary on the candidate; Codex re-check on the delta + R1..R6 only.

## 6. Context packets (each <= 3k tokens; coordinator pastes)

T: worktree `repos/pw-b10-6c`; harness `packages/persistence/src/testing/faults/index.ts` (faultCell, mustWait, connectionPid,
FaultPoints pause/reachedBy, EFFECT_CLOCK_MARGIN_MS) and `apps/api/test/b10-cells-support.ts` (open, contend, observeBlocked(By),
effectClockBefore :230, crossedWhileWaiting :242, runConsumer :70, rightsOf :163, convertedFor :176, Refused); patterns:
attribution test :152-221 (PROS_PAR), :441-482 (wait + crossing), sales test :687 + :755-776 (withdrawal SQL, holdAndWait); fixtures
commission-support.ts:275 claimsOn, :293 acceptAttribution, acquisitionInstants; payment-support.ts:288 checkout; sales-support.ts:118.
Cells: section 4 ids/titles/traces. Budget 120k / 60 min. Report: per cell the red assertion text.
B: section 2 (exact edits), section 4 red column, files of lane B, done criteria above. Budget 180k / 90 min.

## 7. Deferred and caveats

- Deferred (agreement-lifecycle package, binding): the product withdrawal command stamps `ends_at` at its own `kauro.effect_now()` after
  the seller's exclusive half and never before the latest committed acceptance resting on the agreement; the R3 cells then run against it
  unchanged. Until then the writer is the owner's SQL stand-in (ADV-4, as g6c-agrexp46, g6c-corprev49).
- Risk: ORDER_CLOCK may refuse existing B09 fixtures whose process clock trails the test DB clock (measured in lane B's baseline).
- No owner act.
