# B10 lane 6c, round 2 plan, rev 2 (Codex lane REJECT on 5e37366: 6C-R1..R4 BLOCKING, R5 MAJOR, R6 MINOR)

Plan only: no product code. Base `b10/gaps-6c@5e37366` (PR #24). Findings: `tools/review/out/b10-6c-lane-5e373664171a/review.json`. Rev 2 answers the plan adversary on 76ea08d
(`.kauro/reviews/b10-6c-76ea08d-plan-adversary.json`, ADV-1..7) with the coordinator's rulings: the process-clock guard and its 503 (old D10-6C-3) are DROPPED; the order side
is judged in the database at the order insert. Matrix rows: `docs/design/B10-failure-matrix.md` (CMD046/047/049 rows; sections "CMD028 order insert" and "Owner agreement
withdrawal"). Cell ledger: `6c.md` (GAP lines, prospar46 PARTIAL).

## 1. Authority first (R2 lines, then the input-only predicate and its census)

- R2 17 "Attribution subject": "A claim must be submitted before the first paid order and normally before the audit invitation. Backdated notes do not create retroactive
  entitlement."
- R2 17 "Claim validity and conflicts": "A split must be agreed and recorded before the qualifying payment where feasible, with shares summing to 100% of the applicable
  commission pool. The pool does not become 10% for each seller."
- R2 17 "Attribution subject": "Existing inbound opportunities can be assigned to a seller with an explicit compensation assignment before the seller performs the agreed
  work."
- R2 17 "Recurring entitlement": "The residual belongs to the accepted attribution agreement and can continue after operational reassignment or termination, subject to the
  signed lawful terms".
- R2 17 "Activation prerequisites": "ACTIVE requires a signed reviewed relationship agreement, ...".
- R2 08 "Role and capability model": "Agency Owner can manage its agency, client workspaces, projects, team, billing and branding. ... It cannot access other agencies or
  Kauro's seller records."

Predicate P1 (input-only): a beneficiary claim c and a payment order o of the allocation's agency may both stand iff `c.submitted_at < o.created_at` (strict, microseconds;
equality is not "before"). Census of every comparison of a claim submission with an order instant (`packages/**/src`, `apps/api/src`, migrations; grep `submitted_at`) on
5e37366, then the rev 2 additions:
1. `commercial-prospect-access.ts:17-19` (acceptance, `po.created_at < submitted_at`, NAMED claim only via `accept-attribution.ts:91`): **violates P1** (equality admitted;
   other beneficiaries unchecked) -> fixed: `<=` refusal per beneficiary (2.1).
2. `0029_sales_attribution.sql:1093` conversion guard (`OLD.submitted_at >= first.order_created_at` refuses): conforms.
3. `commercial-attribution.ts:269-270` `convertibleAtFirstPurchase` (`c.submitted_at < q.order_created_at`): conforms.
4. NEW 0049 `payment_orders_attribution_cutoff` (order side): refuses `NEW.created_at <= cutoff_at`: conforms.
5. NEW 0049 `attribution_allocations_order_cutoff` (freeze COMMIT backstop, ADV-2): refuses an order with `created_at <= cutoff`: conforms.
No other comparison exists.

D10-6C-1 (order set): P1 ranges over EVERY order of the agency, whatever its state (a late capture can make an unpaid order the first qualifying purchase, 0029:1093 compares
with that order). Conservative reading; the seller's remedy is R2 17's explicit compensation assignment (quoted). Existing sequential cell
`cmd047-accept-attribution.test.ts:174` keeps it.

D10-6C-2 (agreement in force): `signed_at IS NOT NULL AND (ends_at IS NULL OR ends_at > kauro.effect_now())` after the last lock wait AND at COMMIT (template rules 15/16;
0040/0048 precedent). The authority order is the COMMIT order, made total by the seller lock (2.2); stored values are made consistent by the withdrawal's value check (2.2,
ADV-3).

D10-6C-3 (rev 2, replaces the dropped process-clock rule): `payment_orders.created_at` is the process clock (`provider-effects.ts:434`, `runtime.ts:314`), `submitted_at` the
database's (`commercial-attribution.ts:226`). R2 does not decide a clock source, so no correctness rests on their agreement: the database judges the STORED instants at the
order insert (P1 item 4) under the agency-orders subject, and at the freeze's COMMIT (item 5). Nothing compares a process clock with a database clock; an agency with no frozen
allocation is never judged.

D10-6C-4 (agency read, R2 08 quoted): the order insert runs in the agency member's session (policy `payment_orders_tenant_intent`, 0015:832, `agency_id =
kauro.current_agency_id()`), which must not read seller records (attribution claims, allocations, shares). It reads ONE new fact: `kauro.agency_attribution_cutoffs` (agency_id
PK, allocation_id, cutoff_at, created_at), no seller id, no terms. Narrowest grant: kauro_app SELECT on that table only, policy `agency_id = kauro.current_agency_id()`
(tenant) or `acting_corporate_owner()`; INSERT policy `acting_corporate_owner()`; no UPDATE/DELETE grant; FORCE RLS. Written only by the freeze's COMMIT trigger (2.1). No
SECURITY DEFINER. Insert-site census (`git grep "INSERT INTO kauro.payment_orders"`): `commerce-orders.ts:185` (only product writer; callers `create-payment-order.ts:124`,
`bank/instructions.ts:180`) and `packages/persistence/test/b09-migrations.test.ts:220` (superuser test: RLS bypassed, reads the cutoff). kauro_payment has no INSERT grant
(0015:908-909).

D10-6C-5 (refused order outcome): KC022 -> 409 PRECONDITION_FAILED reason ORDER_PRECEDES_ATTRIBUTION (new commerce reason; never INTERNAL_ERROR). Raised inside the intent
unit, it rolls the journal reservation back with it (`provider-effects.ts:411-446`; bank body the same unit), so nothing is journaled and a later attempt (same key or new) is
judged anew with a later instant.

## 2. Lock and commit-instant design (acquisitions verified by Read on 5e37366)

Helpers: shared `kauro.await_transition` (0001:271-273); exclusive `pg_advisory_xact_lock` via `take_transition_lock` (0001:277-293) or `holdSalesTransition`
(commercial-sales-rows.ts:60-62). All held to COMMIT. Plpgsql statements after a lock take a fresh READ COMMITTED snapshot (the 0028:888-890 precedent: lock, then read).

### 2.1 R1 + R2: subject `kauro.agency_orders` (agency) and the cutoff
- Order side (0049): BEFORE INSERT trigger `payment_orders_attribution_cutoff` (fires before `payment_orders_initial_state`, alphabetical):
  `await_transition('kauro.agency_orders', NEW.agency_id)` (SHARED), then `IF EXISTS (cutoff row of NEW.agency_id with cutoff_at >= NEW.created_at) RAISE KC022`. No
  application edit on the B09 checkout path.
- CMD047 (`accept-attribution.ts:64`): after `lockAgencies` (= `kauro.agency_commissions` exclusive, commercial-attribution.ts:248) NEW
  `attribution.lockAgencyOrders(agencyId)` = EXCLUSIVE `kauro.agency_orders`. Then R1: `co.orderPrecedesClaim` (:91) called for EVERY share's claim, with `po.created_at <=
  submitted_at` (commercial-prospect-access.ts:19). Refusal before any write: 409 CLAIM_AFTER_FIRST_ORDER.
- Freeze COMMIT (0049, ADV-2): one function, two constraint triggers DEFERRABLE INITIALLY DEFERRED: `attribution_allocations_order_cutoff` AFTER UPDATE OF frozen_at WHEN
  (OLD.frozen_at IS NULL AND NEW.frozen_at IS NOT NULL) and `..._order_cutoff_born` AFTER INSERT WHEN (NEW.frozen_at IS NOT NULL) (a later shift of frozen_at, cmd048 test
  :199, fires neither): (a) EXCLUSIVE `kauro.agency_orders` (re-entrant for CMD047); (b) a session subject to RLS (`pg_roles` rolsuper/rolbypassrls false) and `NOT
  kauro.in_finance_scope(NEW.agency_id)` -> RAISE KC025 fail closed (INTEGRITY_FAILURE) (CMD047 adopts the scope at :90, `unit-of-work.ts:741` set_config, before the freeze at :108); (c) cutoff =
  max `submitted_at` of the allocation's share claims (NULL -> KC003 SHARES_NOT_WHOLE); (d) any `payment_orders` of the agency with `created_at <= cutoff` -> RAISE KC023 (409
  CLAIM_AFTER_FIRST_ORDER); (e) INSERT the cutoff row. Under (a), an order inserted earlier is committed and read by (d); an order inserted later waits on its shared half and
  reads the row from (e).
- Why both orders conflict: order first -> it holds the shared half from its insert to COMMIT; CMD047 waits at lockAgencyOrders, then :91 reads the order -> 409 before
  writing. CMD047 first -> the order's insert waits; after CMD047's COMMIT it reads the cutoff: an instant at/before a beneficiary's submission -> 409
  ORDER_PRECEDES_ATTRIBUTION; later -> 201 and the claim converts. Neither commit order leaves an ACCEPTED claim with `submitted_at >=` a committed order's `created_at`.
- Lock order: CMD028 (both routes): identity/membership/agency shared -> journal row -> [bank: project FOR NO KEY UPDATE] -> quote (`create-payment-order.ts:100`) ->
  **agency_orders SHARED (insert trigger)** -> payment order row -> scope, attempt/instructions, outbox, [bank: session row FOR SHARE at beforeCommit]. CMD047: corporate grant
  shared -> journal row -> seller SHARED (2.2) -> agency_commissions -> **agency_orders EXCLUSIVE** -> claims (`lockClaim` :252-256) -> allocation, claim rows -> deferred (a)
  (held). Holders of agency_orders: only these two and the deferred trigger. CMD028 never takes a seller, agency_commissions, claims or allocation lock; CMD047 never takes a
  quote, project, agency (`kauro.agencies`) or session-row lock in a conflicting mode (adversary Q2 confirmed: buyerTypeOf unbound, adoptFinanceScope is set_config). No cycle.
  Losers: CMD047 409 CLAIM_AFTER_FIRST_ORDER; CMD028 409 or 201.

### 2.2 R3: CMD047 takes each beneficiary seller's SHARED half; the withdrawal's value check
- Withdrawal (owner `UPDATE seller_agreements SET ends_at`; only the owner may, policy 0029:1297): EXCLUSIVE seller half by `seller_agreements_transition_lock` (0048:61-63 ->
  0001:291).
- CMD047: before `lockAgencies` (:63-64) NEW `sales.holdSellersShared(share sellerIds ascending)` (as commercial-sales.ts:339). After the re-read at :74 a share seller outside
  the held set -> INTEGRITY_FAILURE. Agreements judged at `kauro.effect_now()` after the last lock (near :104-106) -> 409 SHARES_NOT_WHOLE.
- NEW (ADV-3) BEFORE UPDATE OF ends_at trigger `seller_agreements_withdrawal_after_acceptance` (name sorts after `..._transition_lock`, so it runs after the lock):
  `NEW.ends_at IS NOT NULL` and a frozen allocation with a share naming (seller_id, agreement_id, agreement_version) and `frozen_at >= NEW.ends_at` -> RAISE KC024
  (PRECONDITION_FAILED AGREEMENT_ENDS_BEFORE_ACCEPTANCE). frozen_at is `kauro.server_now()` of the freeze (commercial-attribution.ts:376), so a withdrawal begun before the
  acceptance and committing after it is refused, never stored with `ends_at <= frozen_at`.
- Order: corporate grant -> seller -> agency_commissions -> claim, CMD050's own (`terminate-seller.ts:62` lockSeller, `:69` lockAgencies). Exclusive seller holders:
  commercial-sales.ts:372 (CMD049, CMD050), 0029:695-696, 0035:16, 0048:58-59, 0048:61-63; none waits on a lock CMD047 holds before its seller request. Shared takers never
  block each other. No cycle.

### 2.3 R4: commit-instant rules (0049)
- CMD046: `claim-prospect.ts:59` -> `agreementInForceAtEffect` after `lockProspect` (:57). Claimant trigger (0029:1027-1031) adds `ends_at > kauro.effect_now()`; deferred
  `attribution_claims_agreement_in_force` (AFTER INSERT) raises check_violation with that constraint name -> COMMERCIAL_CONSTRAINT_FAILURES -> 409 AGREEMENT_VERSION_MISMATCH.
- CMD049: `activate-seller.ts:64` -> `sales.agreementInForceAtEffect` as the last await before `transitionSeller` (:85); KC005 (0029:851) `server_now()` -> `effect_now()`.
  Deferred `sellers_activation_agreement_at_commit` with EXACTLY KC005's WHEN (0029:889-890: `(NEW.state = 'ACTIVE' AND OLD.state IS DISTINCT FROM 'ACTIVE') OR
  NEW.agreement_id IS DISTINCT FROM OLD.agreement_id`; ADV-6, covers SUSPENDED->ACTIVE, machines.ts:53, and agreement switches): the seller's committed-row agreement in force
  at effect_now, else KC005.
- CMD047: app check (2.2); `attribution_allocations_whole` (0029:1163) `frozen_at` -> `kauro.effect_now()` -> KC003 at COMMIT.
- Migration `0049_b10g6c_r2_ordering.sql` (provisional; renumbered at rebase). KC022-KC025 free on origin/main (grep); a parallel lane taking them is renumbered at merge.
  sqlstate.ts MAP: KC022 PRECONDITION_FAILED ORDER_PRECEDES_ATTRIBUTION; KC023 PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER; KC024 PRECONDITION_FAILED
  AGREEMENT_ENDS_BEFORE_ACCEPTANCE; KC025 INTEGRITY_FAILURE (a freeze outside the finance scope, fail closed).

## 3. Failure-mode rows (summary; full rows in B10-failure-matrix.md)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-B | CRASH-A | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| CMD046 W | C a46race | GAP CMD_TMO (t3) | GAP AGREEMENT_END46 (t1) | C | GAP CMD_CRA | C | C actrace46 | GAP PROS_DISP (t1) |
| CMD047 W | C a47race; GAP ORDER_ACCEPT (t1) | GAP CMD_TMO | GAP AGREEMENT_END47 (t1) | C | GAP CMD_CRA | C | GAP AGREE_WD47 (t1) | C attrpar47 |
| CMD047 R-order | GAP CLAIM_ORDER (t1) | N/A read | N/A stored instants | N/A | N/A | N/A | N/A | N/A; GAP FREEZE_SCOPE |
| CMD049 W | C a49race | GAP CMD_TMO | GAP AGREEMENT_END49 (t1) | C | GAP CMD_CRA | C | C corprev49 | N/A one row |
| CMD028 order insert | GAP ORDER_ACCEPT (t1) | B09 | GAP ORDER_CLOCK, ORDER_NO_ATTR, CUTOFF_READ (t1) | B09 | B09 | B09 | N/A | B09 |
| Agreement withdrawal | GAP AGREE_WD47 (t1) | N/A owner SQL | N/A | N/A | N/A | N/A | itself | N/A one row |

3.1 Not written: CMD046 vs a withdrawal committed first (the stand-in's `ends_at = now()` precedes the claim's instant, so the old code refuses too: not red-provable; cell 11
is the red-provable form). The rev-1 claim "order sampled before the claim is unreachable" is WITHDRAWN: it is reachable and is cells 6 and 7b.

## 4. Cells (file: `apps/api/test/b10-failure-cells-6c-r2.test.ts`, NEW)

EXECUTED_LOCAL (PG17 WSL). Cases: CMD047-DENY/RACE, R2-097, CMD046-DENY/RACE, CMD049-DENY/RACE, CMD028-DENY (B10 edge). faultCell title = `ID [fault] step -> expect`
(matrix.ts:53-56); sequential DENYs are plain `it` (assertInjected needs fault evidence). SqlSteps defined in the file as sales test :374: ORDER_INSERT /INSERT INTO
kauro\.payment_orders/, FREEZE /UPDATE kauro\.attribution_allocations SET frozen_at/. Actors: O=CMD028, A=CMD047, C=CMD046, V=CMD049, W=owner withdrawal, H=holder. Ledger ids
(6c.md, prefix g6c-r2-): 1 order-split, 2 order-equal, 3 order-sole, 4 orderacc-prov, 5 orderacc-bank, 6 orderacc-early, 7 orderacc-first, 8 orderclock, 9 wd-sole, 10
wd-split, 11 end46-wait, 12 end46-commit, 13 end49-wait, 14 end49-stmt, 15 end49-commit, 16 end47-wait, 17 end47-commit, 18 prosdisp, 19 fixture, 20 order-db, 21 order-noattr,
22 end49-switch, 23 freeze-scope, 24 cutoff-read.

1. (`it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: a 6000/4000 split accepted through X (submitted before the agency's order) whose share Y was submitted after
   that order is 409 PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER: both claims unchanged, the allocation unfrozen, no COMMITTED journal". Red on 5e37366: 200 (only X checked).
2. (`it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: share Y submitted exactly at the order's created_at (microsecond equal) refuses the split 409
   CLAIM_AFTER_FIRST_ORDER; nothing written". Red: 200.
3. (`it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: a sole claim submitted exactly at the order's created_at is 409 CLAIM_AFTER_FIRST_ORDER; one submitted one
   millisecond before it is accepted 200". Red: equality leg 200; admit leg guards over-refusal.
4. ORDER_ACCEPT [race] "CMD047 AcceptAttribution / RACE: W against CMD028 CreatePaymentOrder (provider) inserting the agency's order" -> "RACE: the order paused after its
   insert holds the agency's order subject; the acceptance of a claim submitted after the order's instant waits (observed) and, once the order commits, is 409
   CLAIM_AFTER_FIRST_ORDER before any write (FREEZE never sent)". Trace: O quote lock :100 -> insert commerce-orders.ts:185 -> trigger SHARED -> pause ORDER_INSERT.after. C
   submits the claim (seller shared :339, lockProspect :607). A: seller shared -> agency_commissions :248 -> lockAgencyOrders EXCL WAITS (mustWait, holder pid O) -> O COMMIT
   -> :91 reads T0 <= S -> 409. Red: lockAgencyOrders removed -> no wait, A refused only at COMMIT by (2.1 d): FREEZE reached.
5. ORDER_ACCEPT [race] as 4 on the bank route (`instructions.ts:180` insert, pause ORDER_INSERT.after). Red: same.
6. ORDER_ACCEPT [race] "CMD047 AcceptAttribution / RACE: W against CMD028 CreatePaymentOrder paused between its instant and its insert" -> "RACE: the acceptance of a claim
   submitted after the order's instant commits 200 first; the order's insert is then 409 PRECONDITION_FAILED ORDER_PRECEDES_ATTRIBUTION with no order, attempt or journal
   result; the next attempt answers 201 and at its capture the COMMISSIONS consumer converts the claim and accrues exactly one acquisition pool". Trace: O samples T0, pause
   ORDER_INSERT.before; C submits at S > T0; A runs whole (no wait: O holds nothing of the subject), 200, cutoff row S. O released: trigger SHARED (free) -> cutoff S >= T0 ->
   KC022. Retry -> 201; capture + runConsumer (b10-cells-support.ts:70), convertedFor/rightsOf (:176, :163). Red: order trigger removed -> 201 at T0 < S, capture, convertedFor
   false and no pool (the 6C-R2 money loss).
7. ORDER_ACCEPT [race] "CMD028 CreatePaymentOrder / RACE: W order insert while AcceptAttribution holds the agency's order subject" -> "RACE: the insert waits (observed); (a)
   an order sampled after every beneficiary's submission answers 201 and its capture converts both claims of the 6000/4000 split into one pool (6000+4000); (b) an order
   sampled before share Y's submission is 409 ORDER_PRECEDES_ATTRIBUTION, nothing written, and its next attempt converts as (a)". Trace: A holds seller shared,
   agency_commissions, agency_orders EXCL, claims; pause uow.before-commit. O insert -> trigger SHARED WAITS (mustWait, holder pid A). A released 200 -> O reads cutoff. Red:
   the trigger's shared half removed -> (a) no wait observed; (b) O reads no cutoff, 201 at T0 < S, A's deferred (d) cannot see the uncommitted order, both commit, no
   conversion.
8. (`it`) "ORDER_CLOCK CMD028 CreatePaymentOrder / order instant: DENY: with an accepted claim submitted at database instant S and the API clock behind it (provider and bank
   routes), the order is 409 ORDER_PRECEDES_ATTRIBUTION with nothing written or journaled; with the clock past S the same key answers 201 and the capture converts the claim to
   exactly one pool". Clock: the app's injected clock (composition.ts:51). Red: trigger removed -> 201 at created_at <= S, convertedFor false, no pool (ADV-5 loss case).
9. AGREE_WD47 [revocation] "CMD047 AcceptAttribution / REVOCATION: W against the owner's withdrawal of the sole beneficiary's agreement" -> "RACE, three legs, waits observed:
   (1) acceptance paused at COMMIT: the withdrawal waits, the acceptance answers 200, the withdrawal is then refused KC024 and ends_at stays unset; (2) withdrawal uncommitted:
   the acceptance waits on the seller and is 409 SHARES_NOT_WHOLE, nothing written; (3) withdrawal transaction begun first, its UPDATE issued while the acceptance holds the
   seller: the acceptance answers 200 and the withdrawal is refused KC024; after every leg no frozen allocation has a share agreement with ends_at <= frozen_at". Leg 1/3
   trace: A seller SHARED -> ... pause uow.before-commit; W UPDATE -> 0048:61 EXCL WAITS; assert `pg_blocking_pids(W) = [pid A]` exactly (rule 16, ADV-7); A COMMIT; W lock
   granted -> value trigger reads frozen_at -> KC024. Leg 2: W holds EXCL; A holdSellersShared WAITS (`pg_blocking_pids(A) = [pid W]`); W COMMIT; A effect_now check -> 409.
   Red: no holdSellersShared -> leg 1/2 InterleavingNotObserved; no value trigger -> legs 1/3 W commits ends_at <= frozen_at.
10. AGREE_WD47 [revocation] as 9 for a 6000/4000 split, the withdrawal of the NON-named beneficiary Y (Y's seller key, Y's pid checks).
11. AGREEMENT_END46 [race] "CMD046 ClaimProspect / EXPIRY: the agreement's end passing during the prospect-lock wait" -> "RACE: 409 PRECONDITION_FAILED
    AGREEMENT_VERSION_MISMATCH, no claim, the claim insert never sent". H holds claims(P) EXCL; C: seller shared :339 -> lockProspect :607 WAITS (mustWait) ->
    crossedWhileWaiting (b10-cells-support.ts:242) -> H COMMIT -> effect_now check -> 409. Red: pre-wait `now` -> insert sent.
12. AGREEMENT_END46 [expiry] "... the end passing between the claim insert and COMMIT" -> "DENY: 409 AGREEMENT_VERSION_MISMATCH at COMMIT
    (attribution_claims_agreement_in_force), no claim, no journal result". Pause uow.before-commit. Red: deferred trigger removed.
13. AGREEMENT_END49 [race] "CMD049 ActivateSeller / EXPIRY: the end passing during the identity wait of activationFacts" -> "RACE: 409 SELLER_NOT_ACTIVATABLE, seller CANDIDATE
    v1, the seller UPDATE never sent". V lockSeller :372 -> identity wait (H: MFA-withdrawal UPDATE 0048:47-49, ROLLBACK) -> crossed -> agreementInForceAtEffect -> 409. Red:
    `signed` on pre-wait now.
14. AGREEMENT_END49 [race] "... the end passing while KC005 waits on the identity" -> "RACE: refused AT the seller UPDATE (KC005 at effect_now): the UPDATE's after point never
    reached". Pause seller_update.before; H identity EXCL; UPDATE waits 0029:845; crossed; H ROLLBACK. Red: KC005 on server_now -> refused only at COMMIT.
15. AGREEMENT_END49 [expiry] "... between the seller UPDATE and COMMIT" -> "DENY: 409 SELLER_NOT_ACTIVATABLE at COMMIT, seller CANDIDATE v1". Red: deferred agreement trigger
    removed -> 200.
16. AGREEMENT_END47 [race] "CMD047 AcceptAttribution / EXPIRY: a share's agreement end passing during the agency-commission wait" -> "RACE: 409 SHARES_NOT_WHOLE, FREEZE never
    sent". H holds agency_commissions (attribution test :457). Red: no app check.
17. AGREEMENT_END47 [expiry] "... share Y's agreement end passing between the writes and COMMIT" -> "DENY: 409 SHARES_NOT_WHOLE (KC003 at COMMIT), allocation unfrozen, claims
    unchanged". Red: whole trigger on frozen_at.
18. PROS_DISP [partial] "CMD046 ClaimProspect / PARTIAL: W claim insert + separate DISPUTED update (one COMMIT)" -> "RACE (partial): with another seller's live claim on the
    prospect, failures after the claim insert and after the DISPUTED update each roll back totally (no claim, no journal); the retry is DISPUTED at version 2 with its conflict
    reason and the replay answers the journaled 201". Steps CLAIM_INSERT, CLAIM_DISPUTED (commercial-attribution.ts:232-236). Red: mutation omitting the UPDATE ->
    FaultNotInjected, retry SUBMITTED v1.
19. (`it`) "FIXTURE_DEADLINE acceptAttribution fixture refuses an acceptance exactly at a claim's review deadline before any write". Red: guard `>`
    (commission-support.ts:298).
20. (`it`) "CLAIM_ORDER AcceptAttribution freeze / COMMIT backstop: DENY: an owner freeze in the finance scope whose share was submitted at the agency's order instant, made
    with the application read bypassed (raw owner SQL), is refused at COMMIT with KC023 mapped to 409 CLAIM_AFTER_FIRST_ORDER; nothing frozen, no cutoff row". Red: deferred
    (d) removed -> COMMIT succeeds.
21. (`it`) "ORDER_NO_ATTR CMD028 CreatePaymentOrder / order instant: an agency without a frozen allocation (none, or one only prepared) is never refused: with the API clock
    one hour behind the database, provider and bank checkouts answer 201". Red (mutation): the trigger compares with `kauro.effect_now()` or ignores the agency -> 409 (the
    dropped D10-6C-3 design, ADV-1).
22. (`it`) "AGREEMENT_END49 sellers / COMMIT: the deferred agreement trigger has exactly KC005's WHEN, and an ACTIVE seller's switch to an agreement whose end passes before
    COMMIT is refused KC005 at COMMIT". WHEN compared via `pg_get_triggerdef`. Red: WHEN CANDIDATE->ACTIVE only -> the switch commits.
23. (`it`) "FREEZE_SCOPE attribution freeze / COMMIT: an owner freeze outside the finance scope is refused at COMMIT with KC025 INTEGRITY_FAILURE (fail closed), nothing frozen". Red: guard (b) removed ->
    commits without judging the orders.
24. (`it`) "CUTOFF_READ agency session / read: the agency member's session reads its own agency's cutoff instant and nothing else: no attribution claim, allocation or share
    row, and no other agency's cutoff; it cannot insert one". Red: policy `USING (true)`.

## 5. Lanes (file ownership; tests first, then build)

- T (kauro-test-designer, Opus): owns `apps/api/test/b10-failure-cells-6c-r2.test.ts` (new). Cells 1-24 RED on 5e37366 (record each failing assertion text). 140k tokens, 75
  min. Done: compiles; each red for its named defect; no other file.
- B (kauro-builder, Sonnet): owns 0049 (new), `accept-attribution.ts`, `commercial-prospect-access.ts`, `claim-prospect.ts`, `activate-seller.ts`, `commercial-sales.ts`,
  `commercial-attribution.ts`, `packages/domain/src/ports/commercial.ts`, `sqlstate.ts`, `packages/domain/src/commerce/failure-reasons.ts`,
  `packages/domain/src/commercial/failure-reasons.ts`, `commercial/outcomes.ts`, `commerce/outcomes.ts` (CMD028 :70 list + ORDER_PRECEDES_ATTRIBUTION),
  `apps/api/test/commission-support.ts`, `apps/api/test/statements-support.ts` (freeze fixtures adopt the finance scope, section 7), docs (6c.md, design §10 lock-order line,
  D10-6C-1..5, B09-payments-fiscal.md §8 CMD028 outcome, B09-case-map.md CMD028-DENY note). Generated (regenerated, never hand-edited): `apps/api/openapi.json`,
  `apps/web/src/api/generated.ts`, `docs/design/B06-state-command-event-matrix.md` (`pnpm run openapi:generate`, `web-client:generate`, `matrix:generate`). 200k tokens, 100
  min. No composition.ts edit.
- B done: cells 1-24 green; red proof per fix (revert one, run its cell, record the assertion); baseline-then-candidate runs of the five 6c cell files, cmd045-cmd050 suites,
  cmd028/bank/statement/commission suites, `packages/persistence/test/b09-migrations.test.ts`, `packages/application/test/commerce-contracts.test.ts`,
  `tools/test/openapi.test.mjs`; stop and report if > 5 suites change outcome.
- Accepted-package touch (by hand: acceptance-touch.mjs is in PR #18, not on main). B09 (REVIEW_ACCEPTED 4b33e26): `commerce/outcomes.ts` (CMD028 catalogue),
  `commerce/failure-reasons.ts`, a trigger on `kauro.payment_orders` (0015), the CMD028 rows of B09 design §8 and case map (CMD028-DENY gains a B10 cross-reference; class
  unchanged PARTIAL); cases re-run: those citing `b09-migrations.test.ts` (17) and `cmd028-create-payment-order.test.ts` (4) in B09-case-map.md. B07: `sqlstate.ts`,
  `openapi.json` cited once each in B07-case-map.md (re-run `source-adapters.test.ts` :461 and openapi check). B06: the generated matrix. The Codex prompt names this scope:
  B09 CMD028 outcome + insert trigger, B07 sqlstate MAP additions, regenerated artifacts.
- Moved lock traces (ADV-7; re-run on base and candidate, update the trace text in 6c.md): sales test :198, :240 (TERM_ACCEPT: CMD047 now meets CMD050 at the seller half),
  :554, :631, :689, :780 (CMD049 agreement read last, KC005 at effect_now), :866 and attribution :723 (CMD046 check after lockProspect), attribution :350, :441, :490, :532,
  :660 (CMD047 gains seller shared and agency_orders; wait points unchanged), `cmd047-accept-attribution.test.ts:217`, `cmd046-claim-prospect.test.ts:156`,
  `cmd049-activate-seller.test.ts:135`.
- Then kauro-adversary on the candidate; Codex re-check on the delta + R1..R6 + the B09/B07 touch above.

## 6. Context packets (each <= 3k tokens; coordinator pastes)

T: worktree `repos/pw-b10-6c`; harness `packages/persistence/src/testing/faults/index.ts` (faultCell, mustWait, connectionPid, FaultPoints pause/reachedBy,
EFFECT_CLOCK_MARGIN_MS), `apps/api/test/b10-cells-support.ts` (open, contend, observeBlocked(By), effectClockBefore :230, crossedWhileWaiting :242, runConsumer :70, rightsOf
:163, convertedFor :176); patterns: attribution test :152-221, :441-482; sales test :374 (SqlStep), :687 + :755-776 (withdrawal SQL); fixtures commission-support.ts:275
claimsOn, :293 acceptAttribution; payment-support.ts:288 checkout; sales-support.ts:118. Cells: section 4. Budget 140k / 75 min. Report: per cell the red assertion. B:
sections 1 (D10-6C-3..5), 2, 4 red column, 5. Budget 200k / 100 min.

## 7. Deferred and caveats

- Deferred (agreement-lifecycle package, binding): the product withdrawal command stamps `ends_at` at its own `kauro.effect_now()` after the seller's exclusive half and
  answers KC024 as 409 AGREEMENT_ENDS_BEFORE_ACCEPTANCE; the R3 cells run against it unchanged.
- Risk: a B09 fixture inserting an order whose created_at is at/before an agency cutoff now gets 409 (measured in B's baseline; a fixture defect, fixed in the fixture, never
  by weakening the trigger).
- Fixture change (B): the freeze fixtures `commission-support.ts:317` and `statements-support.ts:376` (owner sessions) adopt the allocation agency's finance scope in the same
  transaction (`set_config('kauro.finance_agency_id', agency, true)`, as `unit-of-work.ts:741`), mirroring CMD047; without it (b) refuses them by design.
- The cutoff instant is visible to the agency's own session (D10-6C-4): no seller identity or term; R2 08 forbids seller records, not this agency fact. Codex is asked to
  confirm.
- No owner act.
