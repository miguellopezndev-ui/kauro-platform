# B10 lane 6c, round 2 plan, rev 3 (Codex lane REJECT on 5e37366: 6C-R1..R4 BLOCKING, R5 MAJOR, R6 MINOR)

Plan only: no product code. Base `b10/gaps-6c@5e37366` (PR #24). Findings: `tools/review/out/b10-6c-lane-5e373664171a/review.json`. Rev 2 (5dab987) answered plan adversary r1 (ADV-1..7); rev 3
answers plan adversary r2 (`.kauro/reviews/b10-6c-5dab987-plan-adversary.json`, ADV-8..15) with the coordinator's rulings: ONE clock for P1 (a database instant stamped by the order-insert trigger
after the agency-orders shared half; the claim's instant stamped after CMD046's last wait); the cutoff table, its agency grant and the CMD028 refusal ORDER_PRECEDES_ATTRIBUTION are REMOVED;
KC023-KC026 reserved for 6c, with a uniqueness test. Every round-1 fix stays. Matrix: `docs/design/B10-failure-matrix.md` (CMD046/047/049 rows; "CMD028 order insert"; "Owner agreement
withdrawal"). Ledger: `6c.md` (Round 2).

## 1. Authority first (R2 lines, then the input-only predicate and its census)

- R2 17 "Attribution subject": "A claim must be submitted before the first paid order and normally before the audit invitation. Backdated notes do not create retroactive entitlement."
- R2 17 "Claim validity and conflicts": "A split must be agreed and recorded before the qualifying payment where feasible, with shares summing to 100% of the applicable commission pool. The pool
  does not become 10% for each seller."
- R2 17 "Attribution subject": "Existing inbound opportunities can be assigned to a seller with an explicit compensation assignment before the seller performs the agreed work."
- R2 17 (line 75): "If Kauro wants a seller to perform new account-development or closing work, it creates a prospective project-specific assistance assignment before that work".
- R2 17 "Activation prerequisites": "ACTIVE requires a signed reviewed relationship agreement, ...".
- R2 08 "Role and capability model": "Agency Owner can manage its agency, client workspaces, projects, team, billing and branding. ... It cannot access other agencies or Kauro's seller records."

Predicate P1 (input-only): a beneficiary claim c and a payment order o of the allocation's agency may both stand iff `c.submitted_at < o.db_created_at` (strict, microseconds), both stamped by the
database (D10-6C-3). Census of every comparison of a claim submission with an order instant (grep `submitted_at`, `order_created_at`, `created_at` in `packages/**/src`, `apps/api/src`,
migrations) on 5e37366, with the rev 3 change:
1. `packages/persistence/src/commercial-prospect-access.ts:17-19` (CMD047 via `accept-attribution.ts:91`, `po.created_at < submitted_at`, NAMED claim only): **violates P1** (process clock;
   equality admitted; other shares unchecked) -> `po.db_created_at <= c.submitted_at` refuses, for EVERY share's claim.
2. `0029:1093` conversion guard (`OLD.submitted_at >= first.order_created_at` refuses) and 3. `commercial-attribution.ts:269-270` (`c.submitted_at < q.order_created_at`): operators conform; the
   operand was the process clock (`kauro.designate_qualifying_purchase`, 0028:488, copies `o.created_at` at :502) -> 0049 replaces the function to copy `o.db_created_at`.
4. NEW freeze COMMIT backstop (2.1 d), `db_created_at <= max(submitted_at)` refuses: conforms.
No other P1 comparison exists. Same column, same family, now one clock too: 0030:333 and `commercial-ledger.ts:693` (assistance `signed_at`, a server instant 0029:817, vs the order instant; R2 17
line 75; cell 27), `domain/src/commercial/time.ts:45-48` (plausibility), `ledger-effects.ts:221,238`, `commercial-recurrence.ts:60-80` (reads).

D10-6C-1 (order set): P1 ranges over EVERY order of the agency, whatever its state (0029:1093 compares with the first qualifying one, which a late capture can make any order). Conservative; the
seller's remedy is R2 17's explicit compensation assignment. Kept by `cmd047-accept-attribution.test.ts:174`.

D10-6C-2 (agreement in force): `signed_at IS NOT NULL AND (ends_at IS NULL OR ends_at > kauro.effect_now())` after the last lock wait AND at COMMIT (rules 15/16; 0040/0048 precedent); COMMIT
order made total by the seller lock (2.2), stored values kept consistent by the withdrawal's value trigger (2.2).

D10-6C-3 (rev 3, ADV-10/11, one clock): R2 names no clock; it forbids backdating ("Backdated notes do not create retroactive entitlement"). Both P1 instants are `kauro.effect_now()` =
`server_now() + (clock_timestamp() - transaction_timestamp())` (0038:12-14): in deployment `server_now()` is `transaction_timestamp()` (0009:42-44), so `effect_now()` IS `clock_timestamp()` (the
ruling's clock); in tests it keeps the labelled test-clock offset the fixtures set (`commission-support.ts:494`), so fixture instants stay ordered. (a) Order: NEW column
`payment_orders.db_created_at`, set by BEFORE INSERT trigger `payment_orders_order_instant` AFTER it takes the shared half of `kauro.agency_orders` (a supplied value is overwritten). (b) Claim:
`attribution_claims_server_instant` (0029:756, `require_server_instant('submitted_at')`) is DROPPED for `attribution_claims_submission_instant`: `submitted_at := kauro.effect_now()`,
`review_deadline_at := submitted_at + interval '2160 hours'` (CHECK 0029:457). Its name sorts after `..._claimant` (0029:1035) and `..._claims_lock` (0029:1018), so it runs after the claims-lock
wait; CMD046 inserts after `lockProspect` (claim-prospect.ts:57), its last application wait. The INSERT at `commercial-attribution.ts:226` stops passing the instants. `payment_orders.created_at`
stays the process instant for B09; no P1 comparison reads it. Residual (decided; ADV-11 caveat): an instant is the row's write after every wait, not its COMMIT. The claim's insert->COMMIT gap
holds no lock wait (`attribution_claims_history`, the DISPUTED update of the same row, the journal result on its locked row, deferred reads); an order stamped inside it is after the claim (cell
26 pins it). The order's gap is conservative (stamp before COMMIT). Rejected alternative: re-stamping the claim at COMMIT by a deferred UPDATE (re-fires the version/immutability triggers; the
journaled 201 would differ from the stored row).

D10-6C-4 (rev 3, ADV-8/9, R2 08 quoted): the agency observes nothing derived from seller records. The order trigger reads nothing: shared half, then the stamp of the agency's own order. No cutoff
table, no new grant, no new CMD028 reason. `db_created_at` gets no UPDATE grant (0015:905, :909 grant columns, not the table) and a BEFORE UPDATE trigger `payment_orders_db_instant_immutable`
(`kauro.forbid_column_change('db_created_at')`, as 0015:87-88); no order projection or response gains it. The only observable is a checkout waiting for at most one acceptance transaction (bounded
by statement_timeout; B09 TIMEOUT rows); latency is not a record. Cell 24.

D10-6C-5 (rev 3): no CMD028 outcome is added; `commerce/outcomes.ts:70`, bank lines :84-86 and ACH-ROUTE §7.2/§7.24 (pv1/docs) are unchanged. An order inserted after an acceptance is stamped
after every share's submission (the acceptance read them committed), so P1 never refuses it.

## 2. Lock and commit-instant design (acquisitions verified by Read on 5e37366)

Shared `kauro.await_transition` (0001:271-273); exclusive `take_transition_lock` (0001:277-293) or `holdSalesTransition` (commercial-sales-rows.ts:60-62); all held to COMMIT; plpgsql statements
after a lock read a fresh READ COMMITTED snapshot (0028:888-890).

### 2.1 R1 + R2: subject `kauro.agency_orders`, database instants, freeze backstop
- Order side (0049): `ADD COLUMN db_created_at timestamptz`; backfill `= created_at` with `payment_orders_version` and `payment_orders_touch` disabled around that UPDATE only (runner.ts:122-127:
  one transaction per file; no production order exists before go-live; NOTICE with the count); `SET NOT NULL`. Trigger `payment_orders_order_instant`: `PERFORM
  kauro.await_transition('kauro.agency_orders', NEW.agency_id::text)` then `NEW.db_created_at := kauro.effect_now()`; no read, no refusal. Insert sites: `commerce-orders.ts:185` (only product
  writer; callers `create-payment-order.ts:124`, `bank/instructions.ts:180`), test `b09-migrations.test.ts:220`.
- CMD047 (`accept-attribution.ts:64`): after `lockAgencies` (`kauro.agency_commissions` exclusive, commercial-attribution.ts:248) NEW `attribution.lockAgencyOrders(agencyId)` = EXCLUSIVE
  `kauro.agency_orders`; then census item 1 at :91 for EVERY share. Refusal before any write: 409 CLAIM_AFTER_FIRST_ORDER.
- Freeze backstop (0049): one function, two constraint triggers DEFERRABLE INITIALLY DEFERRED, `attribution_allocations_order_instant` AFTER UPDATE OF frozen_at WHEN (OLD.frozen_at IS NULL AND
  NEW.frozen_at IS NOT NULL) and `..._order_instant_born` AFTER INSERT WHEN (NEW.frozen_at IS NOT NULL) (a later shift of frozen_at, cmd048 test :199, fires neither): (a) EXCLUSIVE
  `kauro.agency_orders` (re-entrant for CMD047); (b) an RLS-subject session (`pg_roles` rolsuper, rolbypassrls false) with `NOT kauro.in_finance_scope(NEW.agency_id)` (0013:541) -> KC026 (fail
  closed); (c) m = max `submitted_at` of the share claims (NULL -> KC003); (d) any order of the agency with `db_created_at <= m` -> KC024. Reads: claims by the owner policies, orders by
  `payment_orders_finance_read` (0015:841) in the finance scope CMD047 adopts at :90 (`unit-of-work.ts:741`). NO new grant.
- Both orders: order first -> it holds the shared half from its stamp to COMMIT; CMD047 waits at lockAgencyOrders, then :91 reads the committed instant -> 409 if at/before a share. CMD047 first
  -> the order's trigger waits and stamps after CMD047's COMMIT, hence after every share's `submitted_at` (each claim committed before CMD047 read it) -> 201, and the capture converts. A raw
  freeze bypassing :91 meets (d) under (a).
- Lock order: CMD028 (both routes): identity/membership/agency shared -> journal row -> [bank: project FOR NO KEY UPDATE] -> quote (`create-payment-order.ts:100`) -> **agency_orders SHARED
  (insert trigger)** -> order row -> scope, attempt/instructions, outbox, [bank: session row FOR SHARE at beforeCommit]. CMD047: corporate grant shared -> journal row -> seller SHARED (2.2) ->
  agency_commissions -> **agency_orders EXCLUSIVE** -> claims (`lockClaim` :252-256) -> allocation, claim rows -> deferred (a) (held). Raw freeze: allocation row -> deferred (a). No other holder.
  CMD028 takes no seller, agency_commissions, claims or allocation lock; CMD047 no quote, project, agency or session-row lock in a conflicting mode (buyerTypeOf unbound; adoptFinanceScope is
  set_config). No cycle. Losers: CMD047 409; CMD028 waits, then 201.

### 2.2 R3: CMD047 takes each beneficiary seller's SHARED half; the withdrawal's value trigger (rev 2; KC renumbered)
- Withdrawal (owner `UPDATE seller_agreements SET ends_at`, policy 0029:1297): EXCLUSIVE seller half by `seller_agreements_transition_lock` (0048:61-63 -> 0001:291).
- CMD047: before `lockAgencies` (:63-64) NEW `sales.holdSellersShared(share sellerIds ascending)` (as commercial-sales.ts:339); a share seller outside the held set after the re-read at :74 ->
  INTEGRITY_FAILURE; agreements judged at `kauro.effect_now()` after the last lock (near :104-106) -> 409 SHARES_NOT_WHOLE.
- BEFORE UPDATE OF ends_at trigger `seller_agreements_withdrawal_after_acceptance` (sorts after `..._transition_lock`): `NEW.ends_at IS NOT NULL` and a frozen allocation share naming (seller_id,
  agreement_id, agreement_version) with `frozen_at >= NEW.ends_at` -> KC025.
- Order: corporate grant -> seller -> agency_commissions -> claim; CMD050 `terminate-seller.ts:62` lockSeller, `:69` lockAgencies. Exclusive seller holders commercial-sales.ts:372, 0029:695-696,
  0035:16, 0048:58-59, 0048:61-63 never wait on a lock CMD047 holds before its seller request. No cycle.

### 2.3 R4: commit-instant rules and codes (0049)
- CMD046: `claim-prospect.ts:59` -> `agreementInForceAtEffect` after `lockProspect` (:57); claimant trigger (0029:1027-1031) adds `ends_at > kauro.effect_now()`; deferred
  `attribution_claims_agreement_in_force` (AFTER INSERT) raises check_violation -> COMMERCIAL_CONSTRAINT_FAILURES -> 409 AGREEMENT_VERSION_MISMATCH. Instant: D10-6C-3 (b).
- CMD049: `activate-seller.ts:64` -> `agreementInForceAtEffect` as the last await before `transitionSeller` (:85); KC005 (0029:851) `server_now()` -> `effect_now()`; deferred
  `sellers_activation_agreement_at_commit` with EXACTLY KC005's WHEN (0029:889-890).
- CMD047: app check (2.2); `attribution_allocations_whole` (0029:1163) `frozen_at` -> `kauro.effect_now()` -> KC003 at COMMIT.
- Migration `0049_b10g6c_r2_ordering.sql` (provisional; `tools/renumber-migration.mjs` renumbers FILES on the rebase, never SQLSTATEs). Codes (ADV-13; census on 5e37366: KC001-KC021, gaps
  004/008/012/013, 42 raises, one message token per code, no token on two codes, 17 MAP keys and 17 SQLSTATE values, no duplicate): KC023 RESERVED for 6c, never raised (the dropped order
  refusal); KC024 CLAIM_AFTER_FIRST_ORDER -> PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER; KC025 AGREEMENT_ENDS_BEFORE_ACCEPTANCE -> PRECONDITION_FAILED (new reason); KC026
  FREEZE_OUTSIDE_FINANCE_SCOPE -> INTEGRITY_FAILURE (new reason; every MAP entry names its own, sqlstate.ts:96-120). B10-OFFSET keeps KC022 COMMISSION_LINE_NOT_FOUND and moves its KC021 to KC027
  LOCK_ORDER_CONTENTION (coordinator routes); 6c's KC021 CLAIM_EXPIRED is code in PR #24 (sqlstate.ts:72,157; 0048:109).
- NEW `docs/design/KC-CODES.md` (code, message token, SQLSTATE name, MAP code/reason, lane, RAISED/RESERVED; OFFSET's KC022/KC027 as RESERVED) and `tools/test/kc-codes.test.mjs`: each migration
  `ERRCODE = 'KCnnn'` has one `TOKEN:` message prefix; no token names two codes; each raised code is a MAP key and a SQLSTATE value exactly once (source-text parse, so a duplicate object key is
  seen) and has its table row with the same token; a RESERVED code is never raised.

## 3. Failure-mode rows (summary; full rows in B10-failure-matrix.md)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-B | CRASH-A | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| CMD046 W | C a46race; GAP CLAIM_INSTANT (t1) | GAP CMD_TMO (t3) | GAP AGREEMENT_END46 (t1) | C | GAP CMD_CRA | C | C actrace46 | GAP PROS_DISP (t1) |
| CMD047 W | C a47race; GAP ORDER_ACCEPT (t1) | GAP CMD_TMO | GAP AGREEMENT_END47 (t1) | C | GAP CMD_CRA | C | GAP AGREE_WD47 (t1) | C attrpar47 |
| CMD047 R-order | GAP CLAIM_ORDER (t1) | N/A read | N/A stored instants | N/A | N/A | N/A | N/A | N/A; GAP FREEZE_SCOPE |
| CMD049 W | C a49race | GAP CMD_TMO | GAP AGREEMENT_END49 (t1) | C | GAP CMD_CRA | C | C corprev49 | N/A one row |
| CMD028 order insert | GAP ORDER_ACCEPT (t1) | B09 | GAP ORDER_CLOCK, ORDER_INSTANT, AGENCY_BLIND (t1) | B09 | B09 | B09 | N/A | B09 |
| Agreement withdrawal | GAP AGREE_WD47 (t1) | N/A owner SQL | N/A | N/A | N/A | N/A | itself | N/A one row |

Not written: CMD046 vs a withdrawal committed first (old code refuses too: not red-provable; cell 11 is the red-provable form).

## 4. Cells (`apps/api/test/b10-failure-cells-6c-r2.test.ts`, NEW; cell 28 in `tools/test/kc-codes.test.mjs`)

EXECUTED_LOCAL (PG17 WSL). Cases: CMD047-DENY/RACE, R2-097, R2-099, CMD046-DENY/RACE, CMD049-DENY/RACE, CMD028-DENY (B10 edge). faultCell title `ID [fault] step -> expect` (matrix.ts:53-56);
sequential DENYs plain `it`. SqlSteps in the file (as sales test :374): ORDER_INSERT /INSERT INTO kauro\.payment_orders/, FREEZE /UPDATE kauro\.attribution_allocations SET frozen_at/,
CLAIM_INSERT /INSERT INTO kauro\.attribution_claims/. Actors: O=CMD028, A=CMD047, C=CMD046, V=CMD049, W=withdrawal, H=raw holder. Equal instants (cells 2, 3, 20): oracle UPDATE `submitted_at :=
order.db_created_at` under `SET LOCAL session_replication_role = replica` (precedent `b10-failure-cells-quote.test.ts:363`). API clock (ADV-15): `shiftingClock()` (`commerce-support.ts:47`,
signed offsetMs) passed by kit K through `paymentWorld({ clock })` (payment-support.ts:137, into `assembleApi` at :193, which today passes the support.ts:90 constant) and `commissionWorld({ clock
})` (commission-support.ts:153-154); the app takes it as `ApiAssembly.clock` (composition.ts:253, read at :335 `assembly.clock ?? systemClock`; :51 is only the default), the seam
`WorldOptions.clock` uses (support.ts:549, :621). Process instants: provider `provider-effects.ts:434`, bank `runtime.ts:257`. Ledger ids (6c.md, g6c-r2-): 1 order-split, 2 order-equal, 3
order-sole, 4 orderacc-prov, 5 orderacc-bank, 6 orderacc-early, 7 orderacc-first, 8 orderclock, 9 wd-sole, 10 wd-split, 11 end46-wait, 12 end46-commit, 13 end49-wait, 14 end49-stmt, 15
end49-commit, 16 end47-wait, 17 end47-commit, 18 prosdisp, 19 fixture, 20 order-db, 21 order-instant, 22 end49-switch, 23 freeze-scope, 24 agency-blind, 25 claim-instant, 26 claim-gap, 27
assist-clock, 28 kc-codes.

1. (`it`) "CLAIM_ORDER CMD047 AcceptAttribution / R-order: DENY: a 6000/4000 split accepted through X (submitted before the agency's order) whose share Y was submitted after that order is 409
   PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER: both claims unchanged, the allocation unfrozen, no COMMITTED journal". Red on 5e37366: 200 (only X checked).
2. (`it`) "CLAIM_ORDER ... DENY: share Y submitted exactly at the order's database instant (microsecond equal) refuses the split 409 CLAIM_AFTER_FIRST_ORDER; nothing written". Red: 200.
3. (`it`) "CLAIM_ORDER ... DENY: a sole claim submitted exactly at the order's database instant is 409 CLAIM_AFTER_FIRST_ORDER; one submitted one millisecond before it is accepted 200". Red:
   equality leg 200.
4. ORDER_ACCEPT [race] "CMD047 AcceptAttribution / RACE: W against CMD028 CreatePaymentOrder (provider) inserting the agency's order" -> "RACE: the order paused after its insert holds the
   agency's order subject; the acceptance of a claim submitted after the order's database instant waits (observed) and, once the order commits, is 409 CLAIM_AFTER_FIRST_ORDER before any write
   (FREEZE never sent)". Trace: O identity/agency shared -> journal -> quote :100 -> insert commerce-orders.ts:185 -> trigger SHARED, stamp T0 -> pause ORDER_INSERT.after. C (seller shared :339,
   lockProspect :607, stamp S > T0) commits. A: grant shared -> journal -> seller shared -> agency_commissions :248 -> lockAgencyOrders EXCL WAITS (`pg_blocking_pids(A) = [pid O]`) -> O COMMIT ->
   :91 reads T0 <= S -> 409. Red: the trigger's shared half (or lockAgencyOrders) removed -> no wait (InterleavingNotObserved); A commits 200 (deferred (d) cannot see uncommitted O).
5. ORDER_ACCEPT [race] as 4 on the bank route (`instructions.ts:180` insert). Red: same.
6. ORDER_ACCEPT [race] "CMD047 AcceptAttribution / RACE: W against CMD028 CreatePaymentOrder paused after its process instant and before its insert" -> "RACE: the acceptance of a claim submitted
   meanwhile commits 200 first; the order then inserts with a database instant after the claim, answers 201, and at its capture the COMMISSIONS consumer converts the claim into exactly one
   acquisition pool". Trace: O samples T_p (provider-effects.ts:434), pause ORDER_INSERT.before (holds journal, quote; nothing of the subject); C submits S > T_p; A whole 200 (agency_orders
   free). O: trigger SHARED (free) -> stamp T1 > S -> 201; capture + runConsumer (b10-cells-support.ts:70), convertedFor/rightsOf (:176, :163). Red on 5e37366: `order_created_at` = T_p < S ->
   conversion refused (0029:1093), no pool (6C-R2 money loss). Fix: the stamp + the 0028:502 copy.
7. ORDER_ACCEPT [race] "CMD028 CreatePaymentOrder / RACE: W order insert while AcceptAttribution holds the agency's order subject" -> "RACE: the insert waits (observed), stamps after the
   acceptance commits, answers 201, and its capture converts both claims of the 6000/4000 split into one pool (6000+4000)". A holds seller shared, agency_commissions, agency_orders EXCL, claims;
   pause uow.before-commit. O insert -> trigger SHARED WAITS (`pg_blocking_pids(O) = [pid A]`); A COMMIT 200; O stamps T1. Red: shared half removed -> no wait observed.
8. (`it`) "ORDER_CLOCK CMD028 CreatePaymentOrder / order instant: (a) API clock 2 s ahead of the database: an order committed, then a claim submitted after it in real time: the acceptance is 409
   CLAIM_AFTER_FIRST_ORDER and no pool accrues (provider and bank routes); (b) API clock 1 h behind: a claim submitted and accepted, then an order: 201 and the capture converts the claim to
   exactly one pool". Red on 5e37366: (a) 200, conversion, a pool (ADV-10); (b) no pool.
9. AGREE_WD47 [revocation] "CMD047 AcceptAttribution / REVOCATION: W against the owner's withdrawal of the sole beneficiary's agreement" -> "RACE, three legs, waits observed: (1) acceptance
   paused at COMMIT: the withdrawal waits, the acceptance answers 200, the withdrawal is then refused KC025 and ends_at stays unset; (2) withdrawal uncommitted: the acceptance waits on the seller
   and is 409 SHARES_NOT_WHOLE, nothing written; (3) withdrawal begun first, its UPDATE issued while the acceptance holds the seller: the acceptance answers 200 and the withdrawal is refused
   KC025; after every leg no frozen allocation has a share agreement with ends_at <= frozen_at". Legs 1/3 `pg_blocking_pids(W) = [pid A]` exactly (rule 16); leg 2 `pg_blocking_pids(A) = [pid W]`.
   Red: no holdSellersShared -> legs 1/2 not observed; no value trigger -> legs 1/3 commit ends_at <= frozen_at.
10. AGREE_WD47 [revocation] as 9 for a 6000/4000 split, withdrawing the NON-named beneficiary Y.
11. AGREEMENT_END46 [race] "CMD046 ClaimProspect / EXPIRY: the agreement's end passing during the prospect-lock wait" -> "RACE: 409 AGREEMENT_VERSION_MISMATCH, no claim, the claim insert never
    sent". H holds claims(P); C seller shared :339 -> lockProspect :607 WAITS -> crossedWhileWaiting (b10-cells-support.ts:242) -> H COMMIT -> effect_now check. Red: pre-wait `now`.
12. AGREEMENT_END46 [expiry] "... between the claim insert and COMMIT" -> "DENY: 409 AGREEMENT_VERSION_MISMATCH at COMMIT, no claim, no journal result". Red: deferred trigger removed.
13. AGREEMENT_END49 [race] "CMD049 ActivateSeller / EXPIRY: the end passing during the identity wait of activationFacts" -> "RACE: 409 SELLER_NOT_ACTIVATABLE, seller CANDIDATE v1, the seller
    UPDATE never sent". V lockSeller :372 -> identity wait (H: MFA-withdrawal UPDATE 0048:47-49, ROLLBACK). Red: pre-wait now.
14. AGREEMENT_END49 [race] "... while KC005 waits on the identity" -> "RACE: refused AT the seller UPDATE (KC005 at effect_now)". Red: KC005 on server_now.
15. AGREEMENT_END49 [expiry] "... between the seller UPDATE and COMMIT" -> "DENY: 409 SELLER_NOT_ACTIVATABLE at COMMIT, seller CANDIDATE v1". Red: deferred trigger removed.
16. AGREEMENT_END47 [race] "CMD047 AcceptAttribution / EXPIRY: a share's agreement end passing during the agency-commission wait" -> "RACE: 409 SHARES_NOT_WHOLE, FREEZE never sent". H holds
    agency_commissions (attribution test :457). Red: no app check.
17. AGREEMENT_END47 [expiry] "... share Y's agreement end passing between the writes and COMMIT" -> "DENY: 409 SHARES_NOT_WHOLE (KC003 at COMMIT)". Red: whole trigger on frozen_at.
18. PROS_DISP [partial] "CMD046 ClaimProspect / PARTIAL: W claim insert + separate DISPUTED update (one COMMIT)" -> "RACE (partial): failures after the claim insert and after the DISPUTED update
    each roll back totally; the retry is DISPUTED at version 2 with its conflict reason and the replay answers the journaled 201". Steps CLAIM_INSERT, CLAIM_DISPUTED
    (commercial-attribution.ts:232-236). Red: mutation omitting the UPDATE.
19. (`it`) "FIXTURE_DEADLINE acceptAttribution fixture refuses an acceptance exactly at a claim's review deadline before any write". Red: guard `>` (commission-support.ts:298).
20. (`it`) "CLAIM_ORDER AcceptAttribution freeze / COMMIT backstop: DENY: an owner freeze in the finance scope whose share was submitted at the agency's order database instant, made with the
    application read bypassed (raw owner SQL), is refused at COMMIT with KC024 mapped to 409 CLAIM_AFTER_FIRST_ORDER; nothing frozen". Red: deferred (d) removed.
21. (`it`) "ORDER_INSTANT payment_orders / insert: the order's database instant is stamped by the insert trigger whatever the caller supplies (provider and bank, API clock 1 h behind:
    db_created_at on the database clock, created_at on the API's), and it never changes (kauro_app and kauro_payment UPDATE refused by grant; an owner UPDATE refused by
    payment_orders_db_instant_immutable)". Red (mutation): a supplied value kept, or the immutability trigger removed.
22. (`it`) "AGREEMENT_END49 sellers / COMMIT: the deferred agreement trigger has exactly KC005's WHEN, and an ACTIVE seller's switch to an agreement whose end passes before COMMIT is refused
    KC005 at COMMIT". Red: WHEN CANDIDATE->ACTIVE only.
23. (`it`) "FREEZE_SCOPE attribution freeze / COMMIT: an owner freeze outside the finance scope is refused at COMMIT with KC026 INTEGRITY_FAILURE (fail closed), nothing frozen". Red: guard (b)
    removed.
24. (`it`) "AGENCY_BLIND agency session / read: the agency owner's and a non-owner member's sessions read the same rows, columns and values from every kauro relation they can select, and the same
    CMD028 response shape, before and after an acceptance of a claim on the agency: nothing derived from a seller record appears". Snapshot: each relation with a kauro_app SELECT grant, `SELECT *
    ORDER BY 1` in the member session, plus the order read body minus volatile ids. Red (mutation): `db_created_at` or an attribution column projected into an agency-readable relation, or `USING
    (true)` on attribution_allocations.
25. CLAIM_INSTANT [race] "CMD046 ClaimProspect / RACE: an order of the agency committed while the claim waits on the prospect's claims lock" -> "RACE: the claim's instant follows the wait, so the
    order counts as before it: the acceptance is 409 CLAIM_AFTER_FIRST_ORDER and no pool accrues". Trace: H (oracle) takes claims(P) EXCL (the commercial-sales.ts:607 key). C: grant/seller shared
    :339 -> journal -> lockProspect WAITS (`pg_blocking_pids(C) = [pid H]`). O commits an order of the agency (stamp T0; O takes no claims lock). H ROLLBACK -> C insert: claimant, claims_lock
    (re-entrant), submission_instant stamps S > T0 -> COMMIT. A -> 409. Red on 5e37366: S = C's transaction start < T0 -> 200, conversion and a pool.
26. CLAIM_INSTANT [race] pin "CMD046 ClaimProspect / RACE: an order inserted after the claim's insert and before its COMMIT" -> "RACE: the claim counts first (its instant is its write after every
    wait): the acceptance answers 200 and the capture converts to one pool". C paused at uow.before-commit after CLAIM_INSERT; O commits (T0 > S); C COMMIT; A 200. Green on base too: it guards
    the D10-6C-3 residual decision (a COMMIT re-stamp turns it red).
27. (`it`) "ASSIST_CLOCK assistance pool / order instant: with the API clock 1 h behind, an order placed after the assistance agreement's signing accrues the assistance pool (R2 17 line 75)". Red
    on 5e37366: process `order_created_at` <= `signed_at` -> no pool (0030:333, commercial-ledger.ts:693).
28. `tools/test/kc-codes.test.mjs` :: "KC codes: each code raised in migrations has one message token, one MAP key, one SQLSTATE name and its KC-CODES.md row; reserved codes are never raised" +
    self-test on synthetic sources (as `fixture-clock-lint.test.mjs`) "a second meaning for KC021 (LOCK_ORDER_CONTENTION) is refused". Red: the checker's token comparison removed.

## 5. Lanes (file ownership; K first, then T, then B)

- K (kauro-builder, Sonnet; kit): owns `apps/api/test/payment-support.ts` (`clock?` option :137 into :193), `apps/api/test/commission-support.ts` (`commissionWorld(options)` :153-154; freeze
  fixture :317), `apps/api/test/statements-support.ts:376`, `packages/persistence/src/testing/agency-fixtures.ts:236`, `packages/persistence/src/testing/sales-fixtures.ts:209`,
  `packages/persistence/test/b10-commission-support.ts:511` (each freeze adopts `set_config('kauro.finance_agency_id', agency, true)` in its transaction, as `unit-of-work.ts:741`),
  `docs/design/KC-CODES.md`, `tools/test/kc-codes.test.mjs` (new). The ADV-12 "Lane B" fixture files go to K: T needs the clock seam in commission-support.ts, which also holds a freeze fixture,
  and one file has one owner. 70k tokens, 45 min. Done: cell 28 green with its self-test red-proven; fixture-clock-lint green; the fixture suites (B done list) unchanged on 5e37366+K.
- T (kauro-test-designer, Opus): owns `apps/api/test/b10-failure-cells-6c-r2.test.ts` (new). Cells 1-27 RED on 5e37366+K (26 a pin; 21, 24 by named mutation), each failing assertion recorded.
  170k tokens, 90 min.
- B (kauro-builder, Sonnet): owns 0049 (new), `accept-attribution.ts`, `packages/persistence/src/commercial-prospect-access.ts`, `claim-prospect.ts`, `activate-seller.ts`, `commercial-sales.ts`,
  `commercial-attribution.ts`, `packages/domain/src/ports/commercial.ts`, `sqlstate.ts`, `packages/domain/src/commercial/failure-reasons.ts` (+AGREEMENT_ENDS_BEFORE_ACCEPTANCE,
  FREEZE_OUTSIDE_FINANCE_SCOPE), `packages/domain/test/commercial-rules.test.ts` (:186 list), `commercial/outcomes.ts`, docs (6c.md, B10 design §10 lock order, §12 reasons, D10-6C-1..5).
  Regenerated, never hand-edited: `apps/api/openapi.json`, `apps/web/src/api/generated.ts`, `docs/design/B06-state-command-event-matrix.md`. No commerce/outcomes.ts, commerce/failure-reasons.ts
  or composition.ts edit. 190k tokens, 100 min.
- B done: cells 1-28 green; red proof per fix (revert one, run its cell, record the assertion); baseline (5e37366+K) then candidate: the five 6c cell files; cmd045-cmd053; apps/api/test
  b10-commission-service, b10-correction-reported-items, b10-correction-unnamed-balance, b10-failure-cells-{accrual,close,close2,conversion,correct,funds-fence,pay,quote,replacement},
  b10-family-templates, b10-fixture-clock-skew, b10-scenarios, commission-statement-reads, cmd028/bank/statement suites, ach-route-cells; packages/persistence/test b10-agency-adapters,
  b10-ledger-adapters, b10-ledger-migrations, b10-offset-bounds, b10-recurrence-adapters, b10-sales-adapters, b10-sales-migrations, invariants, b09-migrations; packages/application/test
  commerce-contracts, response-schemas; packages/domain/test commercial-rules, commercial-time; tools/test openapi, matrix, web-client, kc-codes, b10-case-map, fixture-clock-lint. A changed
  outcome is a fixture defect fixed in the fixture (never the trigger); stop and report if > 5 suites change.
- Accepted-package touch (by hand; Deferred). B09 (REVIEW_ACCEPTED 4b33e26): `kauro.payment_orders` (0015) gains `db_created_at` and two triggers; no CMD028 outcome or reason changes
  (`commerce/outcomes.ts:70`, :84-86, ACH-ROUTE §7.2/§7.24 unchanged); re-run the cases citing `b09-migrations.test.ts` (17) and `cmd028-create-payment-order.test.ts` (4) in B09-case-map.md. B07:
  `sqlstate.ts` MAP +KC024-KC026, re-run `source-adapters.test.ts` :461. B06 (B06-case-map.md:186-187): openapi.json, the web client (generated.ts:904) and the matrix gain the two reasons ->
  re-run `response-schemas.test.ts` (7), `matrix.test.mjs` (3), `openapi.test.mjs` (8), `web-client.test.mjs`. The Codex prompt names this scope.
- Moved lock traces (ADV-7; base and candidate; trace text in 6c.md): sales test :198, :240, :554, :631, :689, :780, :866; attribution :723, :350, :441, :490, :532, :660;
  `cmd047-accept-attribution.test.ts:217`, `cmd046-claim-prospect.test.ts:156`, `cmd049-activate-seller.test.ts:135`. Rev 3: any assertion of a claim's `submitted_at` equal to a fixture instant
  (now + elapsed microseconds) is measured in the baseline.
- Then kauro-adversary on the candidate; Codex re-check on the delta + R1..R6 + this touch.

## 6. Context packets (each <= 3k tokens; coordinator pastes)

K: worktree `repos/pw-b10-6c`; lane K files and lines; pattern `tools/fixture-clock-lint.mjs` + its test; census rules of 2.3. 70k / 45 min. Report: sha, fixture suites before/after. T: harness
`packages/persistence/src/testing/faults/index.ts` (faultCell, mustWait, connectionPid, FaultPoints pause/reachedBy, EFFECT_CLOCK_MARGIN_MS), `apps/api/test/b10-cells-support.ts` (open, contend,
observeBlocked(By), effectClockBefore :230, crossedWhileWaiting :242, runConsumer :70, rightsOf :163, convertedFor :176); patterns attribution test :152-221, :441-482; sales test :374 (SqlStep),
:687 + :755-776 (withdrawal SQL); quote test :363; fixtures commission-support.ts:275 claimsOn, :288 acquisitionInstants, :293 acceptAttribution, :489 checkoutOf, :674 purchase;
payment-support.ts:288; sales-support.ts:118; the clock seam of section 4. 170k / 90 min. Report: per cell the red assertion. B: sections 1 (D10-6C-3..5), 2, 4 red column, 5. 190k / 100 min.

## 7. Deferred and caveats

- Deferred (agreement-lifecycle package, binding): the product withdrawal command stamps `ends_at` at its own `kauro.effect_now()` after the seller's exclusive half and answers KC025 as 409
  AGREEMENT_ENDS_BEFORE_ACCEPTANCE; cells 9-10 run against it unchanged.
- Deferred (PR #18 open, rule 7): `tools/acceptance-touch.mjs` unused; the touch inventory is by hand until #18 merges.
- Routed (coordinator): B10-OFFSET KC021 -> KC027 (KC022 kept), pre-listed RESERVED in KC-CODES.md so OFFSET only adds raises. Rule 15 on `assistance_agreements.signed_at` (its transaction start,
  0029:817) belongs to the assistance writer's lane; 6c only moves the order side.
- Caveat (decided, D10-6C-3): both instants are one wall clock (the database host's); a backward step of it is outside P1 (managed PostgreSQL slews). The claim's insert->COMMIT gap is decided and
  pinned (cell 26).
- Caveat (decided, D10-6C-4): a checkout can wait one acceptance transaction; no value is disclosed (cell 24).
- No owner act.
