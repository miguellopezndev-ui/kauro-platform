# PV1-SETTLE two-step: CMD215 records an owner intent on kauro_app, the payment service applies it (D-SET-10)

Status: plan, 2026-10-14 (coordinator decision, option (a)). Supersedes PV1-SETTLE.md D-SET-1 ("the unit runs as kauro_payment"),
D-SET-5 (where the funds locks are taken) and D-SET-7 (the event of the command's unit); D-SET-2/3/4/6/8/9 stand. Base: branch
pv1/settle 0312b6ba (merged with main 4b11d71). Main is now 3dcce863 (PR #90 took `0070_b05_model_task_request_key.sql`): the lane's
`0070_bank_settlement.sql` becomes **0071** via `tools/renumber-migration.mjs` on the next merge with origin/main, then regenerate
clock-gates.json (incident MERGED-GENERATED-CENSUS-STALE). All two-step DDL goes into that same lane migration (unmerged, no 0072).

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

R2 does not decide which pool writes, nor whether a revocation after the record cancels the consumption. Readings taken:
- Pool split: D-ACH-16 + R2 08:31 → the request pool writes only the intent; the service writes settlement, event and ledger, names its
  initiating fact (the request id as causation) and acts as SERVICE (event actor), never as the owner.
- Revocation after the record: R2 silent; the conservative reading that is implementable without `kauro_payment` reading person tables
  (D-CTX-B1) is the reviewed precedent PV1-INBOUND.md D-INB-CTX-2 / ACH-M-E1R-REVOCATION: "the decision was authorized at its effect
  instant". Made a cell (SET-M-ST3-REVOCATION (a)), listed as caveat C1 for Codex.
- Refusal at apply is terminal (conservative for "no payout from imaginary liquidity"): a REFUSED request never applies later.

Input-only predicates, measured on this tree (2026-10-14):
- P1 "kauro_app can write settlements or ledger_entries": grants/policies naming kauro_app on those tables = 0017:390 (SELECT), 0017:399
  (SELECT), 0017:406/408 (GRANT SELECT). Write paths: **0**. 0071 must keep 0 (fixture runtime-boundary.json + ST3-REVOCATION (c)).
- P2 "PSP_AVAILABLE lines attributable to a bank payment route": sources ledger.ts:91 (fundsAccountOf AVAILABLE, from
  capture.funds_observed.v1, a card webhook), ledger.ts:109 (refund/chargeback excess, postings.ts:117/124), ledger.ts:217/219
  (settlementPostings). Bank events post nothing: bank-postings.ts:18-20 and return-postings.ts:17-19 return null; bank code publishes
  no `capture.*` event (grep of bank-inbound-service.ts and commerce/bank/*.ts: 0 hits). Census on a bank route: **settlement sets
  only** (+ the cells' 0017 fixture). Hence the D-SET-5 GAP stands: a live CMD215 is REFUSED FUNDS_UNAVAILABLE until D-ACH-11 lands.
- P3 lock takers on main: L1 OUTBOUND = SI2 (inbound.ts:452) + settlement; INBOUND = C5 (inbound.ts:267), C6 (:325, :353), M2 (:386),
  SI2 (:453, after L1), M1 (bank-inbound-service.ts:28), P1 (:88); payout-cash = CMD052 payoutCash (commercial-statements.ts:888-890,
  after the statement row), CMD053 transitionIntent (:946-949, after the statement row), 0017 record (commerce-finance.ts:437, no V1
  caller), settlement. Nobody takes INBOUND→L1 or payout-cash→stream: the order L1 → INBOUND → payout-cash → request row is acyclic.

## 2. Precedent on main (reused part by part; no single precedent covers all four parts)

| Part | Precedent (file:line) | Reused as |
|---|---|---|
| Intent row, recorded once, consumed once | 0063:239-293 `bank_checkout_retirements` (requested_at by trigger at `effect_now()`, `consumed_at`/`outcome` set once, kauro_app INSERT column grant, kauro_payment UPDATE (consumed_at, outcome)); consumeRetirement bank-inbound-service.ts:257-279 | `kauro.settlement_requests`, same guard shape |
| Agency-less owner aggregate with its recorded event, on kauro_app | 0063:94-107 (statement_import kind, version CHECK 1, event-per-version AFTER INSERT), 0063:185-190 (owner bank events/outbox, `acting_corporate_owner()`), SI2 publish inbound.ts:521-531 | kind `settlement_request`, `settlement_request.recorded.v1` |
| Owner decision on kauro_app consumed by the payment service, which writes money | M2 publishes `bank_credit.matched.v1` (inbound.ts:413) → PAYMENT_SERVICE subscription (bank-credit.ts:47-48) → `registerBankDeliveryHandler` (consumers.ts:233-236, dispatch :258-259) → applyCredit SERVICE unit (bank-inbound-service.ts:82-84, :189) | `applySettlement` delivery handler |
| Reply and outcome read | CMD214 201 `{ retirement: { state: "RECORDED" } }` (PV1-INBOUND.md D-INB-CTX-2: a 202 is the ACCEPTED envelope with a status path; the journal stores 200/201); getBankCredit ownerRead (inbound.ts:548-552, :622-631; bank-route-routes.ts:179) | 201 RECORDED + `getBankSettlementRequest` |

Why delivery and not CMD214's sweep: a new bank sweep adds a unit to every `runSweepPass` (sweep.ts:105-112), which the E1R crash cells
("the cell's own retirement is the pass's first unit", ach-inbound-cells.test.ts:1047-1053), b09-payment-service and three b10 cell
files drive with unit-indexed faults. A delivery handler adds nothing to any other test's units, and the dispatcher's bounded retry and
DEAD_LETTER (dispatcher.ts:28-29, :105-108) give R2 15:57 its visible end state.

## 3. Shape

### 3.1 Migration (lane migration, renumbered 0071)
- `kauro.settlement_requests`: request_id uuid PK; agency_id uuid CHECK NULL; version bigint DEFAULT 1 CHECK (=1); environment,
  account_ref, withdrawal_id, artifact_ref, evidence_hash, currency CHECK ('USD'), gross/fee/held/withdrawn cents (withdrawn > 0),
  period_start, period_end, observed_at, normalizer_version; receipt group all-or-none (receipt_artifact_ref, receipt_evidence_hash,
  receiving_account_ref, bank_transaction_id, received_cents, bank_available_cents, booked_at, receipt_observed_at) with
  received ≤ withdrawn and bank_available ≥ received (0070:35-39's rule); requested_by uuid NOT NULL; requested_at; consumed_at, outcome
  CHECK IN ('APPLIED','REFUSED'), refusal_reason CHECK IN ('COVERAGE_END_IN_FUTURE','FUNDS_UNAVAILABLE','WITHDRAWAL_ALREADY_SETTLED',
  'CURRENCY_MISMATCH'), settlement_id uuid UNIQUE; CHECKs (consumed_at IS NULL) = (outcome IS NULL); (outcome = 'APPLIED') =
  (settlement_id IS NOT NULL); (outcome = 'REFUSED') = (refusal_reason IS NOT NULL) — each its own named constraint (rule 12).
- Indexes: `settlement_requests_live_withdrawal` UNIQUE (environment, account_ref, withdrawal_id) WHERE outcome IS NULL OR outcome =
  'APPLIED'; `settlement_requests_live_bank_transaction` UNIQUE (environment, receiving_account_ref, bank_transaction_id) WHERE
  bank_transaction_id IS NOT NULL AND (outcome IS NULL OR outcome = 'APPLIED'). A REFUSED request leaves both: the owner may re-record.
- Guard `settlement_requests_guard` BEFORE INSERT OR UPDATE (0063:256-276 shape): INSERT sets requested_at := date_trunc('milliseconds',
  kauro.effect_now()) and requested_by := kauro.current_user_id() (refuse NULL; rule 18: the RLS check is not the binding), refuses any
  consumed field at birth (KA006). UPDATE: only from consumed_at NULL, sets consumed_at := kauro.effect_now(); KA004 otherwise.
  `forbid_column_change` on every fact column + requested_by/at. BEFORE DELETE refuses; no runtime role holds DELETE/TRUNCATE.
- Aggregate kind ('settlement_request','settlement_requests','request_id','B09'); event type `settlement_request.recorded.v1`;
  CONSTRAINT TRIGGER event-per-version AFTER INSERT (0063:105-106 shape).
- RLS (ENABLE + FORCE). kauro_app: SELECT USING acting_corporate_owner(); INSERT WITH CHECK (acting_corporate_owner() AND agency_id IS
  NULL); GRANT SELECT + INSERT (fact columns + request_id only). kauro_payment: SELECT USING (true); UPDATE USING (consumed_at IS NULL)
  WITH CHECK (consumed_at IS NOT NULL); GRANT SELECT + UPDATE (consumed_at, outcome, refusal_reason, settlement_id). kauro_control: none.
- Events/outbox: DROP/CREATE `domain_events_owner_bank` and `outbox_records_owner_bank` (0063:185-190) adding 'settlement_request';
  DROP/CREATE `domain_events_payment_bank`/`outbox_records_payment_bank` (0070:60-67) adding 'settlement_request' (the dispatcher reads
  and settles it). kauro_app gets **no** 'settlement' kind.
- settlements: ADD request_id uuid REFERENCES settlement_requests UNIQUE; `settlements_bank_route_identity` (0070:30-33) also requires
  request_id NOT NULL iff withdrawal_id NOT NULL. Birth binding `settlements_request_birth` BEFORE INSERT WHEN (NEW.withdrawal_id IS
  NOT NULL): the request exists, is unconsumed, and every copied column equals it (recorded_by = requested_by; route_id/
  provider_balance_ref = the account's bank route; observed_at = request.observed_at when bank_transaction_id IS NULL, else
  receipt_observed_at — two branches, no COALESCE, rule 12). Deferred both ways (rule 19): AFTER INSERT on settlements → request APPLIED
  with this settlement_id at COMMIT; AFTER UPDATE OF outcome on requests → APPLIED has its settlement. KA006, no new code.
- Unchanged: `route_provider_available_cents` EXECUTE kauro_payment only (0070:95-96); every new trigger function REVOKE EXECUTE FROM
  PUBLIC (SEC-DEPTH R17, 0063:296-302 shape). No SECURITY DEFINER added.

### 3.2 ST2 CMD215 record (OPERATOR unit on kauro_app, `commerceRuntime`, composition.ts:418-419 unchanged)
R1 access (settlement.ts:199-213 kept): environmentsOfAccount (bank-credits.ts:406, no lock); authorizeOwner in `released`
(bank-credits.ts:556-562); ST1 outside every lock. R2 body: `lockStream(env, acct, "INBOUND")` (bank-credits.ts:202-204) — first
lock, nothing held (C6's position, inbound.ts:353). R3 `co.hold("bank:settlement-locked")`. R4 authorizeOwner re-judged. R5 deferred
ST1 refusal; routeOfAccount (route/currency, kauro_app reads bank_routes as CMD201-205 do); a live request or a settlement of the
withdrawal or bank transaction → 409 WITHDRAWAL_ALREADY_SETTLED (reads, serialized by INBOUND). R6 `at` = assuredAt (route-config.ts:
214-223: proof read, then DB effect instant); COVERAGE_END_IN_FUTURE at `at` (settlement.ts:235 logic). R7 judgedAtCommit
(route-config.ts:229-235). R8 INSERT request (never waits on its unique indexes: every writer of their entries holds this account's
INBOUND — R2 here, A3 below), publish `settlement_request.recorded.v1` (payload `{ requestId, evidenceHash }`), outbox, journal.
Reply **201** `{ settlementRequest: { requestId, accountRef, withdrawalId, state: "RECORDED", requestedAt } }`, resourceKind
`settlement_request`. Removed from the command: L1, payout-cash, providerAvailableCents, settlement/ledger/settlement event writes.

### 3.3 ST3 apply (delivery handler on `settlement_request.recorded.v1`, SERVICE unit on kauro_payment, new bank-settlement-service.ts)
A0 the dispatcher's claim commits in its own unit (dispatcher.ts:84-89); no lock carries into A1. A1 read request (no lock), absent →
NOT_APPLICABLE. A2 L1 OUTBOUND, A3 INBOUND, A4 payout-cash (sql.ts:124-126). A5 request row `FOR NO KEY UPDATE` (rule 11a: the only
referencing insert is A8's own FK KEY SHARE); consumed → DUPLICATE. A6 `at` = effectNowOf (unit-of-work.ts:319-324), after the last
lock wait (A5), no await between it and the judgments. A7 judgments in order, each refusal = `UPDATE ... outcome 'REFUSED', reason` +
COMMIT, return APPLIED: COVERAGE_END_IN_FUTURE (any evidence instant > at), CURRENCY_MISMATCH (route currency), WITHDRAWAL_ALREADY_SETTLED
(settledAs, bank-settlements.ts:80-90), FUNDS_UNAVAILABLE (W + F > route_provider_available_cents). A8 INSERT settlement (request_id,
created_at = at), publish `settlement.recorded.v1` (actor SERVICE, causation = request id via causedBy), ledger set (D-SET-6, `at`),
UPDATE request APPLIED + settlement_id; COMMIT (deferred: event-per-version ×2, ledger balanced, request⇔settlement). Unexpected
errors propagate: unit rolled back, request stays RECORDED, dispatcher retries (dispatcher.ts:105-108) then DEAD_LETTER.

### 3.4 Outcome read
`getBankSettlementRequest` GET `/api/v1/operations/bank-accounts/{accountRef}/settlements/{requestId}` (wire entry("NONE", false,
"KAURO_OWNER"), action READ_BANK_SETTLEMENT, ownerRead as inbound.ts:622-631 replicated in settlement.ts): 200 `{ settlementRequest:
{ requestId, accountRef, withdrawalId, state: RECORDED|APPLIED|REFUSED, reason: string|null, requestedAt, consumedAt|null,
settlement: SettlementView|null } }`; another account's id → 404. kauro_app reads the settlement through 0017:390.

### 3.5 Refusal mapping
| Refusal | Record (ST2, HTTP) | Apply (ST3, outcome) |
|---|---|---|
| NOT_AUTHORIZED grant/identity, ASSURANCE_REQUIRED step-up | 403, nothing written | never (decision C1) |
| EVIDENCE_UNAVAILABLE / NOT_FOUND / HASH_MISMATCH / UNKNOWN / MALFORMED | 503/404/422 as today | never (facts frozen) |
| CURRENCY_MISMATCH, RECEIPT_MISMATCH, SETTLEMENT_INCONSISTENT | 409 | CURRENCY_MISMATCH only (route) |
| COVERAGE_END_IN_FUTURE | 409 at record `at` | REFUSED at apply `at` (clock step-back) |
| WITHDRAWAL_ALREADY_SETTLED | 409 (live request or settlement) | REFUSED (defence; forged control) |
| FUNDS_UNAVAILABLE | not judged (no EXECUTE on the definer) | REFUSED, terminal |
| IDEMPOTENCY_CONFLICT | 409 same key other body | n/a |

## 4. Failure-mode matrix (C = cell in §5; file `apps/api/test/settlement-cells.test.ts`)

| Step | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| ST1 classify | N/A pure | C ST1-TIMEOUT | N/A read | N/A no write | N/A no write | C ST1-RETRY | N/A no authority | N/A no write |
| ST2 record (request, event, outbox, journal) | C ST2-RACE | C ST2-TIMEOUT | C ST2-EXPIRY | C ST2-CRASH-BEFORE | C ST2-CRASH-AFTER | C ST2-RETRY | C ST2-REVOCATION | C ST2-PARTIAL |
| ST3a refusal record (one UPDATE) | C ST3-RACE (b) | C ST3-TIMEOUT | C ST3-EXPIRY (i) | C ST3-CRASH-BEFORE (refusal) | C ST3-CRASH-AFTER (refusal) | C ST3-RETRY (b) | C ST3-REVOCATION | N/A single statement; invariant DENY ST3-BIND |
| ST3b apply (settlement, event, outbox, ledger ×≤6, request UPDATE) | C ST3-RACE (a)(b)(c) | C ST3-TIMEOUT | C ST3-EXPIRY (ii) | C ST3-CRASH-BEFORE | C ST3-CRASH-AFTER | C ST3-RETRY (a) | C ST3-REVOCATION | C ST3-PARTIAL |
| ST3c delivery settle (dispatcher) | N/A lease-fenced (dispatcher.ts:112-118) | N/A covered by ST3-TIMEOUT retry | N/A | N/A | C ST3-CRASH-AFTER | C ST3-RETRY | C ST3-REVOCATION (b) | N/A one write |
| R-read getBankSettlementRequest | N/A read | N/A | N/A | N/A | N/A | N/A | C ST3-OK (403 non-owner) | N/A |

Tier 1 GAPs (money): **GAP-SET-AVAIL-PRODUCER** (D-SET-5, no bank PSP_AVAILABLE producer; owner lane D-ACH-11), **GAP-SET-NEG-AVAIL**
(rule 11: refund/chargeback excess (ledger.ts:109) and FUNDS out of AVAILABLE are FINANCE writers that cannot be refused and do not
take payout-cash; unreachable on a bank route today by P2; when D-ACH-11 lands a negative PSP_AVAILABLE must open the R2 15:153 case —
that lane's cell), **GAP-SET-REMAINDER** (D-SET-9: W − R stays in transit). Not this lane's to close; all three stay in the case map.

Lifetime binding (rule 22), settlement_requests: INSERT bound by guard (requested_at, requested_by, consumed fields NULL); fact columns
bound by forbid_column_change; consumed_at/outcome/refusal_reason/settlement_id NULL→value once by guard + CHECKs + deferred relation;
DELETE guard; TRUNCATE no grant. Residual (decision C2): the facts' binding to the artifact bytes is ST1's (application), as C5's
bank_credits facts (0063:147-148); the artifact store is not a table.

## 5. Cells (titles: `<VERB> SET-M-<row>-<COL> (<family>): <row label>`; ST1/ST2 titles unchanged, §7.25)
Shared test changes: header contract (lines 1-14); `footprint` (197-211) adds `requests: [state, reason]` per account, journal by request
id; `w.effect()` (183) reports NONE|RECORDED|SETTLED|REFUSED; new local helpers `deliver(requestId)` (paymentServiceEffect+deliveryOf,
as inbound-lane-support.ts:361-366), `requestOf`, `getRequest`; LOSER stays. Each lock trace below uses §3.2 R-steps / §3.3 A-steps.

1. ST1-TIMEOUT (292-304), ST1-RETRY (305-337): assertions unchanged + "no settlement_requests row".
2. **ST2-RACE** (354-409, rewritten): (1) two owners, one withdrawal, holder at `bank:settlement-locked` (holder R2 INBOUND held; waiter
   blocks at R2): holder 201 RECORDED, waiter 409 WITHDRAWAL_ALREADY_SETTLED, one request, both orders. Red without the R5 read under
   INBOUND: the waiter's insert hits the unique index → 500 instead of 409 (index is the backstop, not the answer). (2) record vs a
   consumer refusing the previous request of the same withdrawal: consumer holds A3 INBOUND (step pause before its UPDATE); record waits
   at R2; consumer REFUSED commits → record 201; other order: record holds R2, consumer waits at A3, record sees the live request → 409.
   Parts (2)/(3) of today's cell move to ST3-RACE.
3. **ST2-TIMEOUT** (411-429): waiter times out at R2 INBOUND (holder at the hold point): 5xx, no request; same key after the holder
   committed → 409 LOSER; footprint unchanged. Trace: holder R2→R3 held; waiter blocked in R2 past statement_timeout.
4. **ST2-EXPIRY** (431-454): unchanged assertions (COVERAGE_END_IN_FUTURE ×4 at the record's `at`, STEP_UP_STALE +1 ms); "nothing
   written" now includes no request. The proof-read is R6's last await (rule 15).
5. **ST2-CRASH-BEFORE** (456-469): crash at uow.before-commit of the record: no request, event, outbox, journal; nothing to deliver.
6. **ST2-CRASH-AFTER** (471-489): answer lost; request RECORDED, **no settlement, no ledger** (the request pool wrote no money); replay
   201 RECORDED identical; `deliver` → APPLIED, one settlement, one event, `postingsOf(w)`; second deliver → DUPLICATE, footprint same.
7. **ST2-RETRY** (491-514): same key replays 201 RECORDED; other body 409 IDEMPOTENCY_CONFLICT; new key while RECORDED → LOSER; after
   apply new key → LOSER; other withdrawal citing a requested bank tx → LOSER; after a FUNDS_UNAVAILABLE refusal a new key → 201 (re-record).
8. **ST2-REVOCATION** (516-541): `holdStream(acct, "INBOUND")` replaces "OUTBOUND" (line 522); grant/identity/step-up revoked while
   held → same 403s; no request; billing member refused.
9. **ST2-PARTIAL** (543-570): first_write `/INSERT INTO kauro\.settlement_requests/`; LATER_WRITES (345-353) for ST2 = event_insert,
   outbox_insert, journal_final (ledger steps move to ST3); each → whole rollback; same key then 201 once.
New (row label "Apply settlement request", same file, after ST2):
10. **RACE SET-M-ST3-RACE (both orders)**: (a) two deliveries of one request, holder paused at uow.before-commit (A8 done), waiter
    blocked at A2 L1: one settlement/event/set, waiter DUPLICATE; red without A5's consumed check (two settlements → unique 500 or two
    sets). (b) two requests of one route funded for one, both orders, holder at before-commit, waiter at A2: one APPLIED, other REFUSED
    FUNDS_UNAVAILABLE, `availableOf` = 0; red without A4 or with A7 before A4. (c) vs CMD052: `holdPayoutCash` held, consumer blocked
    at A4 (mustWaitOn), release → APPLIED; consumer at before-commit, `fenceRead` waits on payout-cash, reads settled 1 (moved from
    ST2-RACE 389-408). Traces: consumer A2→A3→A4 vs CMD052 statement row→payout-cash (commercial-statements.ts:888-890).
11. **RACE SET-M-ST3-TIMEOUT (lock timeout)**: `holdStream(acct,"OUTBOUND")`; `statementTimeoutMs` = LOCK_TIMEOUT_MS; deliver throws a
    retryable error (dispatcher.ts:105 predicate true); request RECORDED, no settlement; after release deliver → APPLIED once.
12. **DENY SET-M-ST3-EXPIRY (effect instant after the last lock wait)**: (i) record at T with periodEnd = T; DB clock set T − 1 ms for
    the apply (onClock) → REFUSED COVERAGE_END_IN_FUTURE, no settlement/ledger; at T → APPLIED (red if A7 drops the instant check).
    (ii) payout-cash held, clock moved to T2 during the hold, release: settlement.created_at = T2 (red if `at` is read before A4/A5).
13. **RACE SET-M-ST3-CRASH-BEFORE (crash before the apply COMMIT)**: apply and refusal variants: crash at uow.before-commit after
    A8/A7 writes: request RECORDED, no settlement/event/ledger, no outcome; next deliver applies (or refuses) once.
14. **RACE SET-M-ST3-CRASH-AFTER (settle lost)**: crash at uow.after-commit of the apply unit (the dispatcher's settle never runs);
    redelivery DUPLICATE; one settlement/event/set; same for a REFUSED request (stays REFUSED, no settlement).
15. **RACE SET-M-ST3-RETRY (duplicate delivery)**: sequential redelivery DUPLICATE (APPLIED and REFUSED); funds seeded after a FUNDS
    refusal + redelivery → still REFUSED (terminal); a delivery of an unknown request id → NOT_APPLICABLE.
16. **DENY SET-M-ST3-REVOCATION (record authority and service authority)**: (a) record, revoke the owner's grant, deliver → APPLIED;
    settlement.recorded_by = owner, event actor SERVICE, causation = request id (decision C1). (b) a dispatcher whose lease was taken over
    delivers → one application. (c) kauro_app login: INSERT settlements, INSERT ledger_entries, UPDATE settlement_requests.consumed_at,
    SELECT route_provider_available_cents → each 42501.
17. **RACE SET-M-ST3-PARTIAL (later write fails)**: first_write settlements insert; later: event_insert, outbox_insert, first_line,
    last_line (nth 6), request_update `/UPDATE kauro\.settlement_requests/` → whole rollback each, request RECORDED; then APPLIED once,
    `assertBalanced`.
18. **DENY SET-M-ST3-BIND (forged birth and orphan)** (oracle-forged rows, kauro_payment login): settlement with withdrawn +1 vs its
    request → KA006; bank-route settlement without request → refused; request set APPLIED without settlement → refused at COMMIT;
    UPDATE of a consumed request's fact → KA004; INSERT request with consumed_at set → KA006. OK sibling: ST3-OK.
19. **OK SET-M-ST3-OK: CMD215 records (201 RECORDED, no money written); the payment service applies it once; the owner reads the
    outcome**: GET RECORDED → deliver → GET APPLIED with the SettlementView; receipt-null variant: BANK_IN_TRANSIT only, bank-available 0;
    REFUSED variant GET shows the reason; non-owner GET 403, other account 404.

## 6. Clocks and codes
Clock sources touched: `kauro.effect_now()` (0038:12) in the request guard (INSERT, UPDATE) — sanctioned function; app instant
`effectInstant` (unit-of-work.ts:320) via assuredAt (R6) and effectNowOf (A6). Comparisons: evidence instants (data frozen in the row) vs
`at` (DB). Not compared here: event created_at (event-publisher.ts:100, process), dispatcher retryAt (dispatcher.ts:108). Inherited, not
this lane: session liveAt at the process clock (authority.ts:49) in judgedAtCommit — listed caveat C3. Codes: no new KCxxx/KAxxx/reason
(KA004, KA006, COVERAGE_END_IN_FUTURE, FUNDS_UNAVAILABLE (commercial/failure-reasons.ts:53), lane's WITHDRAWAL_ALREADY_SETTLED/
CURRENCY_MISMATCH). Regenerate clock-gates.json after the renumber.

## 7. Files, lanes, estimate
| File | Change |
|---|---|
| packages/persistence/migrations/0071_bank_settlement.sql (renumbered from 0070) | header 1-14 fixed; §3.1 appended after line 96 (~170 lines) |
| packages/persistence/src/repositories/bank-settlements.ts (58-134) | insertRequest, liveRequestFor, requestOf(id, lock), consumeRequest, insert(+request_id), requestView |
| packages/application/src/commerce/bank/settlement.ts (108-322) | record → R1-R8; getRequest; drop funds/settlement writes; views |
| apps/api/src/payments/bank-settlement-service.ts (new) + payments/index.ts:10 import | applySettlement A0-A8, registerBankDeliveryHandler |
| packages/domain/src/commerce/bank-credit.ts:17-49 | kind, event type, allowlist ["requestId","evidenceHash"], PAYMENT_SERVICE subscription |
| apps/api/src/payments/bank-route-routes.ts:139,179-181 | read("getBankSettlementRequest") |
| packages/application/src/api/{response-schemas.ts:1139-1216, operational-wire.ts:37-39} | RECORDED schema, GET schema + wire |
| tests: response-contract.test.ts:267, openapi.test.mjs:89/198, response-schemas.test.ts:192, aggregate-kinds.test.ts, runtime-boundary.json, sec-depth-provenance R17, migrations.test.ts | inventories + regenerated openapi.json / web client |
| docs: PV1-SETTLE.md D-SET-1/5/7 pointer to D-SET-10; ACH-ROUTE.md §7.25 adds row ST3 (cells 10-19); ACH-case-map row R2-085 | |
| apps/api/test/settlement-cells.test.ts | §5 (test-designer only) |

Lanes (one worktree, sequential, file-disjoint): L0 test-designer (Opus) owns settlement-cells.test.ts: cells red-first, ~45 min,
~300k tokens. L1 builder (Sonnet 5.5) owns every other file: ~3.5 h, ~900k tokens; done = the 20 settlement cells + ach-inbound-cells +
b09-payment-service green on focused runs, red-proof of cells 2, 10, 12, 16(c), 18 against the one-step head 0312b6ba. Adversary 30 min.
Total ≈ 5 h, ≈ 1.3M tokens. Deferred: none (dispatcher, registerBankDeliveryHandler and the harness are on main).

## 8. Caveats (decisions, cited; Codex prompt lists each with its cell)
- C1 Revocation after the record does not cancel the apply (D-INB-CTX-2 REVOCATION row; D-ACH-16; R2 silent) — SET-M-ST3-REVOCATION (a).
- C2 The service trusts the classified facts frozen in the request (C5/bank_credits precedent 0063:147-148); the consumer does not
  re-classify (the payment assembly's store is ProviderEvidenceStore, assembly.ts:29, not BankEvidenceStore) — ST1 cells + ST3-BIND.
- C3 Inherited: session judged at the process clock (authority.ts:49), shared by every owner command; out of lane, flagged.
- C4 Production driver: no host loop in apps/*/src calls the payment dispatcher or runSweepPass (grep: only payments/index.ts:58-59);
  shared with P1/E1; the payment worker host lane owns it. Until then a RECORDED request is applied only by the service API's dispatch.
- C5 FUNDS_UNAVAILABLE is terminal; every live V1 request is REFUSED until D-ACH-11 (GAP-SET-AVAIL-PRODUCER).
