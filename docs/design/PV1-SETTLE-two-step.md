# PV1-SETTLE two-step: CMD215 records an owner intent on kauro_app, the payment service applies it (D-SET-10)

Status: plan rev 2, 2026-10-14 (coordinator decision, option (a); revised after the adversary FAIL on e68eab34, findings F1-F9).
Supersedes PV1-SETTLE.md D-SET-1 (the unit ran as kauro_payment), D-SET-5 (where the funds locks are taken), D-SET-7 (the command's
event); D-SET-2/3/4/6/8/9 stand. Base: pv1/settle 0312b6ba (merged with main 4b11d71). Main is 3dcce863 (PR #90 took `0070_b05_model_
task_request_key.sql`): the lane's `0070_bank_settlement.sql` becomes **0071** via `tools/renumber-migration.mjs` on the next merge with
origin/main, then clock-gates.json is regenerated (incident MERGED-GENERATED-CENSUS-STALE). All two-step DDL goes into that migration.

## 1. Authority first
R2 lines (exact text):
- R2 15:17 "Captured amount is confirmed by the provider ... Available provider balance is the portion the provider permits withdrawal
  or use. Bank cash is confirmed by the receiving bank. These are separate facts."
- R2 15:99 "Withdrawal records match provider release to bank receipt, date, currency, FX and fees. A provider "completed" withdrawal
  and an actual bank credit are separately reconciled." R2 15:101 "The owner sees available, held, in transit and bank-confirmed funds."
- R2 15:57 "Exhausting retries leaves a visible case with the exact unresolved effect, not a silently abandoned transaction."
- R2 15:153 "Unexplained differences create a case with amount and age."
- R2 08:31 "A service account has only its technical role. It cannot act as a human owner by putting an owner ID in a request. System
  commands name their initiating event and constrained authority."
- R2-085 expected: "Show separate capture/held/withdrawn/bank-available facts; no payout from imaginary liquidity."
- Design (after R2): ACH-ROUTE.md:827-829 D-ACH-16 "the owner writes draft/confirmation/verification decisions; only a service-authorized
  consumption of those decisions writes captures, observations and CommercialAuthorization."

R2 does not decide the pool split, revocation after the record, nor a bound on how long a recorded intent may wait. Readings taken:
- Pool split: D-ACH-16 + R2 08:31: the request pool writes only the intent; the service writes settlement, events, ledger, case, names its
  initiating fact (causation = the request's event) and acts as SERVICE, never as the owner.
- Revocation after the record: conservative reading implementable without `kauro_payment` reading person tables (D-CTX-B1) = the reviewed
  precedent D-INB-CTX-2 / M2→P1 (applyCredit applies an owner's attribution with no owner re-check, bank-inbound-service.ts:82-96),
  **bounded** by REQUEST_STALE (F6): R2 states no bound; N = `STEP_UP_FRESHNESS_SECONDS` = 900 s (assurance-and-admission.ts:14), the
  longest the platform lets a step-up assure a money decision; the dispatcher's whole retry horizon fits inside it (attempts start at 1,
  inbox-outbox.ts:190; delays min(300, 2^a) s for a = 1..9 sum to 810 s, dispatcher.ts:106-108). Conservative: a late apply refuses
  (money untouched, case opened) and the owner re-records under a fresh step-up.
- Refusal at apply is terminal; every refusal opens a review case with amount and age (R2 15:153, 15:57; F3).
- The consumer never trusts the frozen figures (F4): it re-reads and re-classifies the artifacts before any lock.

Input-only predicates, measured on this tree (2026-10-14):
- P1 kauro_app write paths on settlements / ledger_entries: grants 0017:390, 0017:399 (SELECT), 0017:406/408 (GRANT SELECT); writes **0**.
- P2 PSP_AVAILABLE lines on a bank route: ledger.ts:91 (card webhook), ledger.ts:109 (refund/chargeback excess), ledger.ts:217/219
  (settlementPostings); bank-postings.ts:18-20 and return-postings.ts:17-19 return null. Census: **settlement sets only** → a live CMD215
  apply is REFUSED FUNDS_UNAVAILABLE until D-ACH-11 (GAP-SET-AVAIL-PRODUCER).
- P3 lock takers on main: L1 OUTBOUND = SI2 (inbound.ts:452) + settlement; INBOUND = C5 (:267), C6 (:325, :353), M2 (:386), SI2 (:453,
  after L1), M1 (bank-inbound-service.ts:28), P1 (:88); payout-cash (sql.ts:124-126) = CMD052 payoutCash (commercial-statements.ts:888-890,
  after the statement row), CMD053 transitionIntent (:947-949, after the statement row), 0017 record (commerce-finance.ts:437, no V1 caller),
  settlement. Order L1 → INBOUND → payout-cash → request row is acyclic (nobody takes INBOUND→L1 or payout-cash→stream).
- P4 agency-less PAYMENT_SERVICE subscriptions (F1): bank_credit.received.v1, bank_credit.matched.v1 (bank-credit.ts:45-49) + this lane's
  settlement_request.recorded.v1. Today every one dead-letters in the real dispatcher: deliveryOf throws INTEGRITY_FAILURE (non-retryable)
  on a null agency (dispatcher.ts:55-57; retryable predicate :105). The only delivery.agencyId readers: payments/consumers.ts:66
  (adoptDelivery), commissions/consumer.ts:80,90 (its own dispatcher, commissions/dispatcher.ts:59-61, keeps its throw).
- P5 cells that drove M1/P1 without the dispatcher (F1): `deliverToService` (inbound-lane-support.ts:361-370) calls
  paymentServiceEffect().handle with an oracle-built delivery (commission-support.ts:826-835). **SIMULATED delivery**: ACH-M-M1-{RACE,
  TIMEOUT, EXPIRY, RETRY, REVOCATION, PARTIAL} and ACH-M-P1-{RACE, TIMEOUT, EXPIRY, RETRY, REVOCATION, PARTIAL} (ach-inbound-cells.test.ts:
  597-889); E1, E1R, P2, P1D, FC use it as fixture setup only (`paid`/`settleCredit`, :432-441). Case map: the handler is EXECUTED_LOCAL,
  the delivery SIMULATED until the D-cells below (§5) pass.

## 2. Precedent on main
| Part | Precedent (file:line) | Reused as |
|---|---|---|
| Intent row recorded once, consumed once | `bank_checkout_retirements`: comment 0063:239-243, table 0063:244-253, guard 0063:256-276, immutable 0063:277-278, kauro_app INSERT column grant 0063:287, kauro_payment UPDATE (consumed_at, outcome) 0063:290-293; consumeRetirement bank-inbound-service.ts:257-279 | `kauro.settlement_requests` |
| Agency-less owner aggregate + event, versioned | statement_import kind 0063:97, event-per-version 0063:104 (`AFTER INSERT OR UPDATE OF version`, bank_credits) and :106; owner bank events/outbox 0063:185-187 / :188-190; SI2 publish inbound.ts:521-531 | kind `settlement_request`, v1 recorded, v2 consumed |
| Owner decision consumed by the service, which writes money | M2 `bank_credit.matched.v1` (inbound.ts:413) → PAYMENT_SERVICE (bank-credit.ts:47) → consumers.ts:233-236, :258-259 → applyCredit (bank-inbound-service.ts:82-96) | `applySettlement` handler |
| Service opens a review case + publishes the review event in its unit | M1 matchCredit: transitionCredit + openCreditCase + `bank_credit.review_required.v1` (bank-inbound-service.ts:63-67); openCreditCase bank-credits.ts:539-548 (ON CONFLICT DO NOTHING on bank_review_cases_one_open, 0045:334-339); policy 0045:384-385 | refusal case SETTLEMENT_REFUSED |
| Reply and outcome read | CMD214 201 RECORDED (D-INB-CTX-2); getBankCredit ownerRead (inbound.ts:548-552, :622-631; bank-route-routes.ts:179); owner page: TeamPage (response-schemas.ts:285-292, maxItems 100) + sealCursor/openCursor (api/cursor.ts:54, :64) | GET request + in-transit page |
Delivery, not a sweep: a sweep adds a unit to every `runSweepPass` (sweep.ts:105-112) that the E1R crash cells index (ach-inbound-cells.
test.ts:1047-1053); a handler adds nothing to other tests' units, and the dispatcher's bounded retry + DEAD_LETTER (dispatcher.ts:28-29,
:105-108) give R2 15:57 its end state, made visible by the in-transit page (§3.5).

## 3. Shape
### 3.0 K0 first step (F1): agency-less delivery in the payment dispatcher
- `AGENCY_LESS_PAYMENT_EVENT_TYPES` (dispatcher.ts, exported, closed): bank_credit.received.v1, bank_credit.matched.v1,
  settlement_request.recorded.v1. deliveryOf (:55-57): null agency AND type in the set AND consumer PAYMENT_SERVICE → delivery with
  agencyId null; any other null agency throws INTEGRITY_FAILURE as today (never blanket null).
- `CommerceEventDelivery.agencyId: AgencyId | null` (application commerce/ports.ts:358-365); adoptDelivery (consumers.ts:66) refuses null
  (already: `adopted !== null && adopted === agencyId`); commissions/consumer.ts:80,90 get `agencyOf(delivery)` throwing INTEGRITY_FAILURE
  on null (unreachable: its dispatcher throws first); tsc lists every other site, each refuses null the same way.
- Payment adapters (assembly.ts:24-32) gain `bank?: { evidence: () => BankEvidenceStore | null; classifier: () => BankEvidenceClassifier |
  null }` (composition.ts:332's shape); absent → CAPACITY_UNAVAILABLE/EVIDENCE_UNAVAILABLE (retryable, errors.ts:115). Test support binds
  the world's CONTRACT_FAKE store (payment-support.ts, inbound-lane-support.ts `dispatchPayment(consumer)` = createPaymentDispatcher(rt,
  effects).runOnce, and `secondAccountRoute()` in bank-fixtures-support.ts).
### 3.1 Migration (0071)
- `kauro.settlement_requests`: request_id uuid PK (v7); agency_id CHECK NULL; version bigint DEFAULT 1 CHECK (version IN (1, 2)); environment,
  account_ref, withdrawal_id, artifact_ref, evidence_hash, currency CHECK ('USD'), gross/fee/held/withdrawn cents (withdrawn > 0),
  period_start, period_end, observed_at, normalizer_version; receipt group all-or-none (receipt_artifact_ref, receipt_evidence_hash,
  receiving_account_ref, bank_transaction_id, received_cents, bank_available_cents, booked_at, receipt_observed_at), received ≤ withdrawn,
  bank_available ≥ received (0070:35-39); requested_by NOT NULL; requested_at; consumed_at; outcome CHECK IN ('APPLIED','REFUSED');
  refusal_reason CHECK IN ('EVIDENCE_MISMATCH','REQUEST_STALE','COVERAGE_END_IN_FUTURE','CURRENCY_MISMATCH','WITHDRAWAL_ALREADY_SETTLED',
  'FUNDS_UNAVAILABLE'); settlement_id uuid UNIQUE; review_case_id uuid UNIQUE. Named CHECKs, one predicate each (rule 12): consumed_at⇔
  outcome; APPLIED⇔settlement_id; REFUSED⇔refusal_reason; REFUSED⇔review_case_id; version 2⇔consumed_at NOT NULL.
- Unique: `settlement_requests_live_withdrawal` (environment, account_ref, withdrawal_id) and `settlement_requests_live_bank_transaction`
  (environment, receiving_account_ref, bank_transaction_id) WHERE bank_transaction_id IS NOT NULL, both WHERE outcome IS NULL OR 'APPLIED'.
  The first is per account (serialized by INBOUND); the second is **cross-account** (two provider accounts may cite one receiving account):
  an insert can wait on another account's uncommitted entry and get 23505 (F7).
- Guard BEFORE INSERT OR UPDATE (0063:256-276 shape): INSERT sets requested_at := date_trunc('milliseconds', kauro.effect_now()),
  requested_by := kauro.current_user_id() (NULL refused), version := 1, refuses consumed fields (KA006). UPDATE only from consumed_at NULL,
  sets consumed_at := kauro.effect_now(), version := 2 (KA004 otherwise). `forbid_column_change` on facts + requested_by/at; BEFORE DELETE
  refuses; no runtime role holds DELETE/TRUNCATE. Event-per-version CONSTRAINT TRIGGER AFTER INSERT OR UPDATE OF version (0063:104).
- Aggregate kind ('settlement_request','settlement_requests','request_id','B09'); event types settlement_request.recorded.v1 {requestId,
  evidenceHash}, settlement_request.applied.v1 {requestId, settlementId}, settlement_request.refused.v1 {requestId, reason, reviewCaseId,
  withdrawnCents, receivedCents, feeCents}.
- RLS (ENABLE+FORCE) on settlement_requests: kauro_app SELECT/INSERT with acting_corporate_owner() AND agency_id IS NULL, INSERT column
  grant (facts + request_id); kauro_payment SELECT (true), UPDATE USING (consumed_at IS NULL) WITH CHECK (consumed_at IS NOT NULL), column
  grant (consumed_at, outcome, refusal_reason, settlement_id, review_case_id); kauro_control none.
- Events/outbox (F9: kauro_payment never writes the owner's record event): `domain_events_owner_bank`/`outbox_records_owner_bank`
  (0063:185-190) keep their two kinds; new owner policies for kind settlement_request: domain_events FOR SELECT, FOR INSERT WITH CHECK
  event_type = 'settlement_request.recorded.v1'; outbox_records FOR SELECT, FOR INSERT (no UPDATE/DELETE: the owner cannot mark its
  request's delivery). New kauro_payment policies: domain_events FOR SELECT (kind settlement_request), FOR INSERT WITH CHECK event_type IN
  (applied.v1, refused.v1); outbox_records FOR SELECT/INSERT of those two only. `domain_events_payment_bank` (0070:60-67) unchanged.
  The dispatcher reads/settles as kauro_control (0005:270, :278, :308, :311).
- Review case: `bank_review_cases.kind` CHECK (0045:318) + 'SETTLEMENT_REFUSED'; `source_kind` CHECK (0045:324) + 'SETTLEMENT_REQUEST';
  bank_vocabulary rows (0045:33) for both; execution_offer_outcomes.review_case_kind (0045:218) unchanged. Owner resolve policy (0063:179-
  180) unchanged: the case resolves only through an APPLIED request of the same withdrawal (A8).
- settlements: ADD request_id uuid UNIQUE REFERENCES settlement_requests; `settlements_bank_route_identity` (0070:30-33) + request_id
  NOT NULL iff withdrawal_id NOT NULL. Birth binding BEFORE INSERT WHEN (withdrawal_id IS NOT NULL): request exists, unconsumed, every
  copied column equal (recorded_by = requested_by; route_id = the bank route's payment_route_id, provider_balance_ref = bank route_id,
  bank-settlements.ts:100-101; observed_at = request.observed_at if no receipt, else receipt_observed_at: two branches, no COALESCE).
  Deferred both ways (rule 19): a settlement ⇒ its request APPLIED with it; APPLIED ⇒ settlement; REFUSED ⇒ its open case. KA006.
- `kauro.settlement_request_refusal(p_request uuid, p_at timestamptz, p_stale_after interval) RETURNS text` (STABLE, INVOKER, EXECUTE
  kauro_payment only): REQUEST_STALE if p_at > requested_at + p_stale_after; else COVERAGE_END_IN_FUTURE if period_end > p_at, observed_at >
  p_at, or (receipt) booked_at > p_at, receipt_observed_at > p_at — one branch each (rule 12); else NULL. µs-exact, no rounding (F8).
- Every new trigger/function REVOKE EXECUTE FROM PUBLIC (SEC-DEPTH R17, 0063:295-303); `route_provider_available_cents` unchanged.
### 3.2 ST2 CMD215 record (OPERATOR unit, kauro_app; composition.ts:418-419 unchanged)
R1 ST1 + access outside locks (settlement.ts:199-213). R2 `lockStream(env, acct, "INBOUND")` (bank-credits.ts:202-204), first lock (C6's
place, inbound.ts:353). R3 hold `bank:settlement-locked`. R4 authorizeOwner re-judged. R5 routeOfAccount; live request / settlement of the
withdrawal or bank tx → 409 WITHDRAWAL_ALREADY_SETTLED. R6 `at` = assuredAt (route-config.ts:214-223) for the step-up (rounded up:
conservative for expiry); COVERAGE_END_IN_FUTURE advisory at `at` (the apply's µs judgment binds). R7 judgedAtCommit. R8 INSERT request:
may wait on another account's bank-tx entry (§3.1) → 23505 of either live index mapped to 409 WITHDRAWAL_ALREADY_SETTLED as
bank-settlements.ts:128-130 does; publish recorded.v1, outbox (PAYMENT_SERVICE, NOTIFICATIONS), journal. Reply **201** `{ settlement
Request: { requestId, accountRef, withdrawalId, state: "RECORDED", requestedAt } }`. Removed: L1, payout-cash, funds, money writes.
requested_at is stamped by the BEFORE trigger before that index wait; if the holder rolls back the stamp is ≤ the true insert, so
REQUEST_STALE errs toward refusing (rule 15 note).
### 3.3 ST3 apply (SERVICE unit, kauro_payment, new apps/api/src/payments/bank-settlement-service.ts)
A0 lease claim (dispatcher.ts:84-89) and outbox claim (:90) commit in their own kauro_control units (:75); no lock carries over; the lease
fence guards only the settle (:112-118), not handle (:97), so A5 alone stops a double apply. A1 read request (no lock); absent →
NOT_APPLICABLE; consumed → DUPLICATE. A1b re-verify outside locks (F4): readSettlementEvidence (settlement.ts:83-106) with the payment
adapters' bank binding; CAPACITY_UNAVAILABLE propagates (retry); any other DomainFailure or any frozen figure ≠ the re-classified one
(currency, gross, fee, held, withdrawn, withdrawal_id, period, observed_at, normalizer_version, receipt group) → verdict EVIDENCE_MISMATCH.
Facts are immutable (forbid_column_change), so the verdict cannot go stale. A2 L1 OUTBOUND, A3 INBOUND, A4 payout-cash, A5 request row
FOR NO KEY UPDATE: **A5 never waits** (every writer of the row holds A2-A4 first; kauro_app has no UPDATE); the last possible wait is A4.
consumed → DUPLICATE. A6 `at` = new `uow.effectNow()` (exact µs `kauro.effect_now()`, no rounding; the harness repositions it as it does
effectInstant, fault-support.ts:189-205). A7 in order: EVIDENCE_MISMATCH (A1b); `settlement_request_refusal(id, at, 900 s)`;
CURRENCY_MISMATCH; WITHDRAWAL_ALREADY_SETTLED (settledAs, bank-settlements.ts:80-90); FUNDS_UNAVAILABLE (W + F > route_provider_available_
cents, read after A4). Refusal: INSERT case (SETTLEMENT_REFUSED, source SETTLEMENT_REQUEST/request_id, detail_code = reason, evidence_hash),
UPDATE request REFUSED + reason + case id, publish refused.v1 + outbox; COMMIT; return APPLIED. A8 apply: INSERT settlement (request_id,
created_at = date_trunc('milliseconds', at), down: evidence ms ≤ at ⇒ ≤ created_at), settlement.recorded.v1 (actor SERVICE, causedBy the
delivery), ledger set (D-SET-6), UPDATE request APPLIED + settlement_id, applied.v1, resolve OPEN SETTLEMENT_REFUSED cases of earlier
REFUSED requests of the same (environment, account_ref, withdrawal_id); COMMIT (deferred checks). A8 cannot hit 23505: a settlement copies
its request's identity, and live request identities are unique. Unexpected errors propagate → RECORDED, retry, DEAD_LETTER (visible §3.5).
### 3.4 Outcome read
`getBankSettlementRequest` GET `/api/v1/operations/bank-accounts/{accountRef}/settlements/{requestId}` (entry("NONE", false, "KAURO_OWNER"),
READ_BANK_SETTLEMENT, ownerRead as inbound.ts:622-631): 200 `{ settlementRequest: { requestId, accountRef, withdrawalId, state: RECORDED|
APPLIED|REFUSED, reason|null, requestedAt, consumedAt|null, reviewCaseId|null, delivery, settlement: SettlementView|null } }`; other
account's id → 404.
### 3.5 In-transit page (F3, R2 15:101/15:153/15:57)
`listBankSettlementsInTransit` GET `/api/v1/operations/bank-accounts/{accountRef}/settlements?cursor=` (same entry/action): requests with
outcome NULL (whatever its delivery state), or REFUSED while its SETTLEMENT_REFUSED case is not RESOLVED (coordinator decision at build:
a REFUSED request whose case was RESOLVED, by a later apply of the same withdrawal, leaves the page; cell 21), (requested_at, request_id) order, ≤ 100 per page, sealed cursor bound to caller+account (cursor.ts:54/64). Item:
requestId, withdrawalId, state, reason, withdrawnCents, receivedCents|null, feeCents, requestedAt, ageSeconds (SQL `kauro.effect_now() −
requested_at`, one DB clock), delivery (PAYMENT_SERVICE outbox state of its recorded.v1: PENDING|RETRYING|DEAD_LETTER), reviewCaseId|null.
### 3.6 Refusal mapping
| Refusal | Record (HTTP) | Apply (outcome + case) |
|---|---|---|
| NOT_AUTHORIZED, ASSURANCE_REQUIRED | 403, nothing written | never (C1; bounded by REQUEST_STALE) |
| EVIDENCE_UNAVAILABLE | 503 | retry (CAPACITY_UNAVAILABLE) → DEAD_LETTER, page shows it |
| NOT_FOUND / HASH_MISMATCH / UNKNOWN / MALFORMED / RECEIPT_MISMATCH / SETTLEMENT_INCONSISTENT | 404/422/409 | EVIDENCE_MISMATCH |
| CURRENCY_MISMATCH | 409 | CURRENCY_MISMATCH (route) |
| COVERAGE_END_IN_FUTURE | 409 advisory (rounded) | binding, µs (SQL) |
| REQUEST_STALE | n/a | at > requested_at + 900 s |
| WITHDRAWAL_ALREADY_SETTLED | 409 (read, or 23505 mapped) | defence |
| FUNDS_UNAVAILABLE | not judged | terminal |

## 4. Failure-mode matrix (C = cell in §5; files settlement-cells.test.ts (S), ach-dispatch-cells.test.ts (D))
| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| ST1 classify | N/A pure | C 1 | N/A read | N/A no write | N/A | C 1 | N/A | N/A |
| ST2 record | C 2 (1)(2)(3) | C 3 | C 4 | C 5 | C 6 | C 7 | C 8 | C 9 |
| ST3-dl delivery (dispatcher deliveryOf, claim, settle) | C 10(a) takeover | C 11 | N/A no window | N/A claim own unit | C 14 | C D1, 15 | C 16(b) | N/A one write each |
| ST3-rv re-verify (A1b, read) | N/A facts immutable | C 20(c) | N/A | N/A | N/A | C 20(c) | N/A | N/A |
| ST3-rf refusal (case, request, event, outbox) | C 10(b) | C 11 | C 12(i)(iv) | C 13 | C 14 | C 15 | C 16(d) | C 17(r) |
| ST3-ap apply (settlement, events, outbox, ledger ≤ 6, request, case resolve) | C 10(a)(b)(c)(d) | C 11 | C 12(ii)(iii) | C 13 | C 14 | C 15 | C 16(a)(c) | C 17 |
| R-read GET + page | N/A read | N/A | N/A | N/A | N/A | N/A | C 19 (403) | N/A |
Tier-1 GAPs (money, stay in the case map, not this lane's): **GAP-SET-AVAIL-PRODUCER** (D-ACH-11), **GAP-SET-NEG-AVAIL** (rule 11:
FINANCE writers of PSP_AVAILABLE do not take payout-cash; unreachable on a bank route by P2), **GAP-SET-REMAINDER** (D-SET-9).
Rule 22 lifetime: settlement_requests INSERT (guard), facts (forbid_column_change), consumed group NULL→value once (guard + CHECKs +
deferred), DELETE guard, TRUNCATE no grant; bank_review_cases SETTLEMENT_REFUSED: INSERT by kauro_payment only in the refusal unit,
deferred REFUSED⇔case, RESOLVED only in A8. Residual C2: artifact bytes ↔ facts is A1b's (application), the store is not a table.

## 5. Cells (`<VERB> SET-M-<row>-<COL> (<family>): <row label>`; lock traces use §3.2 R / §3.3 A steps)
Shared (S): header 1-14; footprint (197-211) + `requests: [state, reason]`, `cases`; `w.effect()` (183) NONE|RECORDED|SETTLED|REFUSED;
helpers `deliver(requestId)` = `dispatchPayment("PAYMENT_SERVICE")` (real dispatcher), `directRequest(over)` (kauro_app owner INSERT,
no CMD215), `requestOf`, `getRequest`, `inTransit`.
1. ST1-TIMEOUT (292-304), ST1-RETRY (305-337): unchanged + no settlement_requests row.
2. ST2-RACE (354-409): (1) one account, holder paused at R3 (INBOUND held, nothing inserted), waiter mustWaitOn the holder pid → holder 201,
   waiter 409; red without R2 (waiter does not wait: mustWait throws). (2) record vs a consumer refusing the previous request (consumer at
   A3, step pause before its UPDATE), both orders. (3) two accounts (`secondAccountRoute`), one bank tx: holder A at uow.before-commit after
   R8, waiter B blocks in R8 on the index (mustWaitOn), holder COMMIT → waiter 409 WITHDRAWAL_ALREADY_SETTLED; holder crash → waiter 201.
   Red without the 23505 mapping (500). Parts of today's cell move to 10.
3. ST2-TIMEOUT (411-429): waiter times out in R2; 5xx; no request; replay after holder → 409.
4. ST2-EXPIRY (431-454): assertions unchanged; "nothing written" includes no request.
5. ST2-CRASH-BEFORE (456-469): no request/event/outbox/journal.
6. ST2-CRASH-AFTER (471-489): request RECORDED, no settlement/ledger; replay 201 identical; deliver → APPLIED once; again DUPLICATE.
7. ST2-RETRY (491-514): replay 201; other body 409 IDEMPOTENCY_CONFLICT; new key while RECORDED / after APPLIED → 409; after a REFUSED → 201.
8. ST2-REVOCATION (516-541): holdStream INBOUND (line 522 was OUTBOUND); same 403s; no request.
9. ST2-PARTIAL (543-570): first_write `/INSERT INTO kauro\.settlement_requests/`; LATER_WRITES (345-353) = event, outbox, journal.
New (S, row "Apply settlement request"):
10. RACE ST3-RACE: (a) two deliveries of one request. Trace: D1 lease+claim (kauro_control, :84-90, committed) → U1 A2-A5, writes, paused
    at uow.before-commit; lease and claim expire (120 s, :25-27), D2 takes over and claims (:84-90) → U2 blocks at A2 (mustWaitOn U1); U1
    COMMIT → U2 A5 consumed → DUPLICATE; D1's settle refused by the fence, D2 DELIVERED. One settlement/event/set. Red without A5's check.
    (b) L1: two requests of one account (one bank route per payment route, 0046:88), funded for one, both orders: one APPLIED, one REFUSED
    FUNDS_UNAVAILABLE + case, availableOf 0. Red with the funds read moved before A2. (c) vs CMD052: holdPayoutCash held → consumer
    mustWaitOn at A4; consumer at before-commit → fenceRead waits (moved from 389-408). Red without A4. (d) vs CMD053 (statements-support
    intent, transitionIntent → SETTLED): CMD053 at its post-lock hold (statement row → payout-cash) → consumer waits at A4; consumer at
    before-commit → CMD053 waits in lockPayoutCash; both: payoutCash() basis equals the serial result. Red without A4 (no wait).
11. RACE ST3-TIMEOUT (real dispatcher): holdOutboundStream; statementTimeoutMs = LOCK_TIMEOUT_MS; runOnce → outbox FAILED, attempts 1,
    retryAt set (not DEAD_LETTER), request RECORDED; release, clock past retryAt, runOnce → APPLIED, DELIVERED.
12. DENY ST3-EXPIRY: (i) directRequest period_end P; deliver at step clock P − 1 ms → REFUSED COVERAGE_END_IN_FUTURE + case; sibling at P
    → APPLIED. (ii) TIME-AFTER-AWAIT: payout-cash held, clock to T2 during the hold, release: created_at = T2; red if `at` read before A4.
    (iii) DB-level: `settlement_request_refusal(id, T − 500 µs, 900 s)` = COVERAGE_END_IN_FUTURE, at T → NULL; red if rounded (effectInstant).
    (iv) REQUEST_STALE: at = requested_at + 900 s → APPLIED path; + 900 s + 1 ms → REFUSED REQUEST_STALE + case.
13. RACE ST3-CRASH-BEFORE: crash at uow.before-commit after A8 / after the refusal writes: RECORDED, nothing else; next deliver once.
14. RACE ST3-CRASH-AFTER: crash at uow.after-commit (settle lost): redelivery DUPLICATE, outbox DELIVERED; same for REFUSED.
15. RACE ST3-RETRY: sequential redelivery DUPLICATE (APPLIED, REFUSED); funds seeded after a refusal → still REFUSED; unknown id N/A.
16. DENY ST3-REVOCATION: (a) record, revoke grant, deliver within 900 s → APPLIED; recorded_by = owner, actor SERVICE, causation the
    event. (b) dispatcher whose lease was taken over → one application. (c) kauro_app: INSERT settlements / ledger_entries, UPDATE
    settlement_requests, INSERT domain_events applied.v1, UPDATE its outbox record, EXECUTE route_provider_available_cents and
    settlement_request_refusal → each refused (42501 or 0 rows). (d) revoke, deliver after 900 s → REFUSED REQUEST_STALE.
17. RACE ST3-PARTIAL: apply: first_write settlements insert; later event, outbox, first_line, last_line (nth 6), request_update, case
    resolve; (r) refusal: first_write case insert; later request_update, event, outbox. Each asserts the injected step fired (ctx.partial
    record; FaultNotInjected otherwise) before the footprint: whole rollback, RECORDED; then once, `assertBalanced`.
18. DENY ST3-BIND (oracle-forged, kauro_payment): withdrawn +1 vs request → KA006; bank settlement without request; APPLIED without
    settlement; REFUSED without case; consumed fact UPDATE → KA004; INSERT with consumed_at → KA006. OK sibling 19.
19. OK ST3-OK: RECORDED → deliver → APPLIED + SettlementView; receipt-null: BANK_IN_TRANSIT only; non-owner 403, other account 404.
20. DENY ST3-EVIDENCE: (a) directRequest with bank_available_cents inflated → REFUSED EVIDENCE_MISMATCH, case, no settlement/ledger; red
    without A1b (APPLIED). (b) withdrawn changed, artifact of another account → EVIDENCE_MISMATCH. (c) store unbound → CAPACITY_UNAVAILABLE,
    outbox FAILED (retry), not REFUSED.
21. OK ST3-CASE: refusal opens SETTLEMENT_REFUSED; page lists RECORDED and REFUSED with withdrawn/received/fee and ageSeconds = DB
    clock − requested_at; re-record + apply → case RESOLVED, page empty.
D (new apps/api/test/ach-dispatch-cells.test.ts, row "Deliver agency-less bank event"; red with dispatcher.ts:56 restored):
D1. OK SET-M-DSP-OK: settlement_request.recorded.v1 via runOnce → APPLIED, outbox DELIVERED attempts 1.
D2. OK ACH-M-DSP-OK: exact credit: runOnce (received.v1 → MATCHED), runOnce (matched.v1 → APPLIED, capture), both DELIVERED.
D3. DENY SET-M-DSP-DEAD_LETTER: bank binding absent: 10 runs, clock past each retryAt → DEAD_LETTER at attempts 10, code
    CAPACITY_UNAVAILABLE (restored line 56: attempt 1, INTEGRITY_FAILURE), request RECORDED, page delivery DEAD_LETTER.
D4. DENY SET-M-DSP-UNLISTED: agency-less statement_import.recorded.v1 forged onto PAYMENT_SERVICE → DEAD_LETTER INTEGRITY_FAILURE at 1.

## 6. Clocks and codes
Clock sources: `kauro.effect_now()` (0038:12) in the request guard (sanctioned SQL function), the page's ageSeconds (repo statement,
allowlisted file:line), `uow.effectNow()` (new, persistence unit-of-work.ts next to :319, allowlisted) read once in A6; assuredAt (R6,
effectInstant :319-324, rounded up, step-up only). Census rule: bank-settlement-service.ts calls neither effectInstant nor a process clock
for a judgment. Not compared: event created_at (event-publisher.ts:100), dispatcher retryAt/claim (dispatcher.ts:90, :108, process clock,
scheduling only). Inherited C3: session liveAt (authority.ts:49). New codes (grepped main 3dcce863 and every repos/* worktree: 0 hits):
reasons REQUEST_STALE, EVIDENCE_MISMATCH (COMMERCE_FAILURE_REASONS tail, failure-reasons.ts:117-121; uniqueness errors-versioning.test.ts:
62); case kind SETTLEMENT_REFUSED (BANK_CASE_KINDS records.ts:708-719; bank-kit-migrations.test.ts:109, :139 → new OFFER_REVIEW_CASE_
KINDS = the 10, :148); source kind SETTLEMENT_REQUEST (new BANK_CASE_SOURCE_KINDS, test :151 + vocabulary); 3 event types. No KC/KA.

## 7. Files, lanes, estimate
Lanes (one worktree, sequential, file-disjoint): **K0** kit builder (Sonnet 5.5), two commits: K0a test support + types + adapters with
line 56 still throwing; K0b deliveryOf only (red-proof base). Files: dispatcher.ts, application commerce/ports.ts:358-365, commissions/
consumer.ts, payments/assembly.ts:24-32, payments/index.ts:55-60, payment-support.ts, inbound-lane-support.ts, bank-fixtures-support.ts.
~1 h, ~250k. **L0** test-designer (Opus): settlement-cells.test.ts, ach-dispatch-cells.test.ts; ~1.5 h, ~500k. **L1** builder (Sonnet
5.5): 0071 migration (§3.1 after line 96, ~230 lines), bank-settlements.ts:58-134 (+request/case/page/refusal repo), unit-of-work.ts
(effectNow), fault-support.ts:189-205 (reposition effectNow), settlement.ts:108-322, bank-settlement-service.ts (new) + payments/index.ts:10,
bank-credit.ts:17-48, failure-reasons.ts, records.ts:693-719, bank-route-routes.ts:139,179-181, response-schemas.ts:1139-1216,
operational-wire.ts:37-39, inventories (response-contract.test.ts:267, openapi.test.mjs:89/198, response-schemas.test.ts:192,
aggregate-kinds.test.ts, runtime-boundary.json, sec-depth-provenance R17, migrations.test.ts, bank-kit-migrations.test.ts), regenerated
openapi.json + web client, docs (PV1-SETTLE.md pointers, ACH-ROUTE §7.25 rows ST3/D, ACH-case-map R2-085 + P5's SIMULATED marks); ~5 h,
~1.4M. Adversary 45 min. **Total ≈ 8.5 h, ≈ 2.4M tokens.** Done: S 1-21 and D1-D4 green; ach-inbound-cells, b09-payment-service,
bank-kit-migrations, commission dispatcher tests green (focused); red-proofs: D1-D3 base K0a; 2(1), 2(3), 10, 12, 16(c), 18, 20 base
0312b6ba or the fix reverted.
**Hard launch dependency (F2):** no production host runs the payment dispatcher (only payments/index.ts:58-59 builds it). Owner lane
B14-worker-host (board id B14-worker-host, coordinator lane), before B19. R2-085 stays below EXECUTED_LOCAL (PARTIAL → B14-worker-host)
until a runner cell exists; this lane's D-cells prove delivery, not hosting. Deferred: none (no open-PR interface consumed).

## 8. Caveats (decisions, cited; each in the Codex prompt with its cell)
- C1 Revocation after the record does not cancel an apply within 900 s (D-INB-CTX-2; M2→P1, bank-inbound-service.ts:82-96; R2 silent);
  beyond it REQUEST_STALE — 16(a), 16(d).
- C2 Artifact ↔ facts binding is A1b's re-classification; the store is not a table — 20.
- C3 Inherited: session liveAt at the process clock (authority.ts:49), every owner command; out of lane.
- C4 Inherited, B10: CMD053 stamps settled_at = server_now() (transaction start, commercial-statements.ts:955), before its payout-cash
  wait; A4 lengthens that wait. Pair cell 10(d) asserts the basis; the rule-15 question of settled_at is B10's, flagged.
- C5 FUNDS_UNAVAILABLE terminal; every live V1 apply is REFUSED (+ case) until D-ACH-11.
- C6 NOTIFICATIONS of agency-less bank events (all BANK_CREDIT_EVENT_TYPES, bank-credit.ts:45-46) run on another dispatcher; inherited.
- C7 Inherited: `outbox_records_owner_bank` FOR ALL (0063:188-190) lets the owner update its credit/import outbox rows; this lane does
  not extend it to settlement_request (INSERT/SELECT only, 16(c)); the bank_credit half is flagged to the PV1-INBOUND owner.
