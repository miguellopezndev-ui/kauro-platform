# B12 outreach plan: CMD061..CMD064, R2-066..068, R2-129..132, R2-135 (planner 2026-10-14)
Base origin/main 8354d7be, branch b12/outreach. Registry B12 = 20 ids (program.json B12.caseIds = gates.json G-UX_PRIVATE.caseIds); census
2026-10-14: none has a test on main. Sources read by slice only: R2 12 "Role-specific home", "Seller onboarding and access lifecycle", "Prospect
record", "Outreach workspace", "Commission statement", "Owner commercial dashboard", "Finance and cost controls", "Resources and training",
"Acceptance"; 18 "Initial channel decision", "Prospect qualification", "Outreach cadence and health", "Communication compliance", "Acceptance";
reference/MESSAGING_AND_SENDER_OPERATIONS.md (all six sections; R2 12/18 "Messaging adapter and sender boundary" make it binding: "They apply to
this manual and its implementation packages"); 17 "Assignment changes", "Termination and tail", "Business-day calendar"; 08 "Role and capability
model"; 10 "Idempotency contract", "Support and operations routes", "Provider adapter contract", "Notifications and event consumers"; 24 OA16,
OA17; reference/COMMAND_CATALOGUE.md CMD061..064; registry contracts OutreachDraft/OutreachAuthorization/SalesActivity/Prospect, policy.messaging,
screens UI33/34/49/53/54. Classes: EL = EXECUTED_LOCAL (real PostgreSQL + contract fakes), SIM = SIMULATED (labelled contract fake),
PART(x) = local half here, live half in package x. Template: docs/design/FAILURE-MATRIX-TEMPLATE.md columns + rules 1-23.

## 0. Authority first (rulings, each: R2 text -> input-only predicate -> census measured 2026-10-14 on 8354d7be)
- A1 draft is not send. Ref "Draft, authority and send intent": "`OutreachDraft` ... The draft is a proposal."; 12 "Outreach workspace": "Draft
  generation is not a send authorization."; OA16 "Drafting does not authorize tool-based external sending." Predicate: a provider call exists only
  for an intent row born by CMD063 under a live grant. Census: provider send ports on main = 0 (git grep "gmail|Resend" src = 0 hits).
- A2 states. Ref: "`DRAFT`, `AUTHORIZED`, `SUBMITTING`, `PROVIDER_ACCEPTED`, `SEND_UNCERTAIN`, `BOUNCED`, `REPLIED`, `SUPPRESSED` and `CANCELLED` have
  different meanings" = registry OutreachDraft.state. 12 lists "DRAFT, APPROVED_TO_SEND, SENT, DELIVERED, ...". Conflict decided D-B12O-1: the
  reference + registry enum govern (12's own boundary section delegates "draft/send, uncertainty" to the reference); DELIVERED is never produced
  (ref "Measurement": "Do not label this count delivered").
- A3 uncertain = reconcile. Ref: "If submission may have succeeded but its response was lost, retain `SEND_UNCERTAIN`; do not automatically send
  again."; policy.messaging.uncertainSubmission = "RECONCILE_BEFORE_REPEAT"; 10 "An ambiguous external effect requires reconciliation, not blind
  retry." Predicate: an intent leaves SUBMITTING only to PROVIDER_ACCEPTED | SEND_UNCERTAIN | NOT_SENT(no-effect proof); never back to QUEUED.
- A4 suppression wins. Ref "Notification reliability": "Honor a marketing opt-out ... immediately after validation, before queued sends are
  claimed. Do not require login"; ref "Draft, authority": "Before dispatch recheck the suppression registry, sender grant, current recipient,
  expiry ... remaining campaign count."; 18 "A contact's opt-out survives reassignment, list reimport and provider change." Census of suppression
  writers on main: 0 product writers (only apps/api/test/sales-support.ts:93); readers: commercial-sales.ts:558, trigger 0029:991-1000.
- A5 no cold outreach via Resend. Ref "Selected routes": "Kauro must therefore never route cold prospects, purchased lists or scraped contacts
  through this adapter."; policy.messaging.coldOutreachViaResend = false. Predicate: route(sender) = RESEND_TRANSACTIONAL => no intent for ANY
  OutreachDraft purpose (all three purposes are sales correspondence; Resend is "customer-requested transactional notifications" only).
- A6 sender. Ref "Account and DNS": "A sender identity cannot be selected from arbitrary browser input. All `From` identities are registry entries
  bound to the authorized person"; 12 "The owner mailbox is never shared as a shortcut." Predicate: sender.user_id = actor (seller) or owner-bound
  (owner); intent.sender = draft.sender = grant.sender (DB binding, KA095).
- A7 former seller. 12 "Suspension ... preserving the seller's permitted historical statement and dispute path. Termination revokes operational
  access"; 12 "An inactive seller retains access to an appropriate statement"; ref "Measurement": "surviving commission rights do not grant
  perpetual access to prospect correspondence." MEASURED DEFECTS on main: (a) get-statement.ts:101 admits a seller only through authorizeSeller,
  which refuses any non-ACTIVE row (authorizer.ts:70) -> a TERMINATED seller cannot read its own statement; (b) policies on prospect data use
  kauro.current_seller_id() (any state, 0029:164-166): prospects_seller_read 0029:1352, prospect_suppressions_read 0029:1365; contacts and source
  evidence self-read by recorded_by_user_id 0029:1341-1342, 1346-1347 -> a TERMINATED seller still SELECTs its prospects and contacts. Census of
  seller-state-blind policies: 24 (git grep "current_seller_id()" migrations); financial ones (statements, lines, adjustments, holds, offsets,
  payouts, credit, agreements, destinations, entitlements, claims, tail) stay; prospect-data ones (prospects, contacts, source evidence,
  suppressions read, every new outreach table) become ACTIVE-only.
- A8 resources. 12 "Resources and training": "Each has version, effective date and owner. Retired copy cannot be used to promise an old feature.";
  UI53 "Obsolete claims cannot be silently reused in a new campaign." Predicate: a draft/grant/intent cites resource versions all CURRENT and every
  capability they claim in AVAILABLE|AVAILABLE_LIMITED (0003:17 states), judged under FOR SHARE locks.
- A9 scope (D-33, owner 2026-10-13, .kauro/decisions/2026-10-13-COMMERCIAL-SCOPE.md item 1) supersedes 18 "Prospect qualification" ("Prospects are
  agencies. A non-agency company ... is never researched ... or contacted") and A3 3.7, as 0064_d33_company_prospects already does. Predicate: no
  B12 rule, cap, copy, fixture or ordering reads `segment` (prospect_source_evidence.segment). Census: B12 files reading segment = 0 (new files).
  The internal channel priority is category C: never coded, never in copy/fixtures/tests.
- A10 cadence. Ref: "ten newly contacted recipients per authorized sender per business day, one active sequence per prospect, no more than three
  total messages over fourteen calendar days, and no follow-up after a reply, refusal, bounce or opt-out"; 18: "at most two follow-ups, at five and
  twelve business days, then stop for ninety days". Conflict decided D-B12O-6 (conservative intersection, never looser than either): new-recipient
  cap 10 per sender per ROLLING 24 h (no calendar exists for outreach; a rolling window is never looser than a business day); per prospect at most
  2 sends (first + one follow-up: 12 business days > 14 calendar days makes the second follow-up unreachable under both), the follow-up >= 10
  calendar days after the first (>= 5 US business days with <= 3 holidays) and < 14 calendar days; then 90 days with no new sequence.
- A11 jurisdiction. 18 "Other markets require a separate channel/legal review before equivalent outreach. A US policy is not assumed sufficient";
  "a real postal contact and a working opt-out". D-B12O-7: kauro.outreach_channel_policies seeded ('US', each purpose, policy v1, cite 18); any
  other jurisdiction refused OUTREACH_JURISDICTION_UNREVIEWED; CMD063 refuses OUTREACH_COMPLIANCE_UNCONFIGURED unless the deployment binds a postal
  address and the opt-out origin (owner fact D-16: address not given -> BLOCKED_OWNER for live, §6).
Not decided by R2 (conservative choice recorded): grant max window 14 days (= policy.sequenceCalendarDays); validFrom earlier than the birth
instant is clamped to it (rule 23: the DB clock opens the window); step-up required for CMD062 (08 "authorize supported high-impact decisions
after step-up"; OA16 is an owner act).

## 1. Case table (exact titles; file :: "title"; one title per file, unique)
| Case | Class | Lane | Test |
|---|---|---|---|
| CMD061-OK | EL | L-DRAFT | apps/api/test/cmd061-prepare-outreach-draft.test.ts :: "CMD061-OK: an assigned ACTIVE seller prepares a DRAFT for its US prospect from stored content and a CURRENT resource, sender its own GMAIL_API identity, provenance its prospect's source evidence: 201 version 1, content hash bound to recipient/sender/purpose/body, no intent, outbox record, activity or provider call" |
| CMD061-DENY | EL | L-DRAFT | same :: "CMD061-DENY: an agency tenant session and a TERMINATED seller are 403, another seller's prospect is 404 like an unknown id (no contact label in the problem); then one missing prerequisite at a time: other sender, REVOKED sender, provenance not the prospect's, unreviewed jurisdiction, suppressed prospect, superseded resource, savings amount, AI in subject, CR/LF in subject; no row, no event" |
| CMD061-RACE | EL | L-DRAFT | same :: "CMD061-RACE: identical retry replays the 201, same key other content is 409 IDEMPOTENCY_CONFLICT, the seller's termination held at the seller lock in both orders (draft then TERMINATED, or 403), a resource superseded held at its row lock in both orders, crash before COMMIT leaves nothing and crash after COMMIT replays one draft" |
| CMD062-OK | EL | L-AUTH | apps/api/test/cmd062-authorize-outreach.test.ts :: "CMD062-OK: the owner with a fresh step-up seals two DRAFT hashes of one sender for 14 days, maximumSends 2, evidence equal to the server's review digest: 201 one grant, revoked false, policyVersion recorded, validFrom clamped to the database instant, no draft state changed and no send queued" |
| CMD062-DENY | EL | L-AUTH | same :: "CMD062-DENY: a seller and an agency member are 403, a stale step-up is ASSURANCE_REQUIRED; then expired, empty, duplicate or non-DRAFT hash, another sender's draft, maximumSends 0 or above the sealed drafts, window over 14 days, evidence not the review digest, superseded resource: each 409 with nothing written" |
| CMD062-RACE | EL | L-AUTH | same :: "CMD062-RACE: identical retry replays one grant, same key other hashes is 409, a draft re-bound or a resource superseded held at its lock in both orders, the owner grant revoked held at its transition lock in both orders, crash before COMMIT nothing and after COMMIT one grant replayed" |
| CMD063-OK | EL+SIM | L-SEND | apps/api/test/cmd063-send-authorized-outreach.test.ts :: "CMD063-OK: the assigned seller sends a sealed draft under a live grant: 200 one QUEUED intent (draft AUTHORIZED) with payload hash and grant reference, one outbox record; the dispatcher submits once through the Gmail contract fake and records PROVIDER_ACCEPTED with the provider id, never DELIVERED" |
| CMD063-DENY | EL+SIM | L-SEND | same :: "CMD063-DENY: foreign and TERMINATED callers 403; then stale version, changed content hash, revoked, expired, exhausted or uncovering grant, suppressed contact, RESEND sender, unresolved SEND_UNCERTAIN of the prospect, cadence cap and missing compliance configuration: 409, no intent, no outbox, zero provider calls" |
| CMD063-RACE | EL+SIM | L-SEND | same :: "CMD063-RACE: identical retry replays one intent, same key other hash is 409, two drafts on a one-send grant held at the grant lock give one 200 and one 409 OUTREACH_GRANT_INVALID, grant revocation held at the grant lock in both orders, crash before COMMIT no intent and after COMMIT one intent replayed" |
| CMD064-OK | EL | L-ACT | apps/api/test/cmd064-record-sales-activity.test.ts :: "CMD064-OK: the reconciler records PROVIDER_ACCEPTED then BOUNCED, the seller records REPLIED with the inbound message ref and the owner records SUPPRESSED with opt-out evidence: one activity each, queued follow-ups of the prospect NOT_SENT, the contact suppressed, prospect SUPPRESSED, metrics accepted 1 less known bounces 1" |
| CMD064-DENY | EL | L-ACT | same :: "CMD064-DENY: a seller of another prospect is 404, a TERMINATED seller 403, REPLIED on a DRAFT, REPLIED whose ref is the outbound provider id, PROVIDER_ACCEPTED by a person, a duplicate external identity and an activity dated after the database instant are refused; nothing counts twice" |
| CMD064-RACE | EL | L-ACT | same :: "CMD064-RACE: identical retry replays one activity, same key other kind is 409, two reconcilers with one provider ref held at the prospect lock give one row, SUPPRESSED against a dispatcher claim held at the suppression key in both orders, crash before COMMIT nothing and after COMMIT one activity" |
| R2-066 | EL (web half PART(B12-WEB)) | L-HOME | apps/api/test/b12-seller-home.test.ts :: "R2-066: a TERMINATED seller reads its home (statements and the support route only) and its own statement, while every prospect, contact, source, draft, activity and resource read and CMD045/046/061/063/064 refuse it, and its session sees zero prospect-data rows" |
| R2-067 | PARTIAL(b12/owner-screens O2 + DEFERRED O4 after PV1-SETTLE) | - | no title here: §7 Deferred (binding requirements) |
| R2-068 | EL | L-DRAFT | apps/api/test/cmd061-prepare-outreach-draft.test.ts :: "R2-068: a draft prepared without a grant stays DRAFT through reads, the dispatcher pass and a forged activity: no intent, no activity, metrics zero, and no projection has a delivered member" |
| R2-129 | EL+SIM (live PART(B15/B19)) | L-SEND | apps/api/test/b12-dispatch-cells.test.ts :: "R2-129: the Gmail fake accepts but the answer is lost (timeout, reset, crash after SUBMITTING, lease taken over during the call): SEND_UNCERTAIN, exactly one provider submission, redelivery and recovery never submit again, CMD063 refuses a repeat until CMD064 HUMAN_SEND_OBSERVED closes it" |
| R2-130 | EL | L-SEND | same :: "R2-130: an opt-out recorded after the grant and before the claim blocks the send — the public opt-out and CMD064 SUPPRESSED each held at the suppression key against the claim in both orders; the sealed grant never overrides the later refusal" |
| R2-131 | EL+SIM | L-SEND | same :: "R2-131: a sales draft on a RESEND_TRANSACTIONAL sender is refused at send despite valid fake credentials and spare quota: zero Resend calls, the draft stays DRAFT at its version, the grant unconsumed; the database refuses a forged intent on that route" |
| R2-132 | EL+SIM | L-SEND | same :: "R2-132: the sender's OAuth grant revoked with three queued drafts: the first claim observes AUTH_REVOKED (no effect), the sender becomes REVOKED, the other two are CANCELLED unsubmitted, past PROVIDER_ACCEPTED and SEND_UNCERTAIN activity is kept, and no intent is ever sent from the owner's identity" |
| R2-135 | EL | L-DRAFT | apps/api/test/b12-resources.test.ts :: "R2-135: a seller opening a superseded offer sheet sees SUPERSEDED and the current resource; a new draft citing it, a grant over a draft citing it and a send are refused, a capability suspended by CMD059 makes its resource unusable too, and the historical draft, intent and activity rows stay readable" |
Kit/DB cells (K): packages/persistence/test/b12-outreach-migrations.test.ts :: "B12 at the database: forged births refused (draft, grant, intent, activity, suppression) — KA095/KA096/KA097/KC028..KC033 each fired alone with its OK sibling through the production writer"; tools/test/ka-codes.test.mjs :: "KA codes: every raised KA code has one prefix, one sqlstate.ts entry and no other lane's claim"; packages/application/test/outreach-content.test.ts :: "safe claim and header checks: savings amounts, guarantees, AI in subject or more than one AI sentence, CR/LF/NUL, non-NFC text, over-long fields refused; plain permitted text admitted"; tools/test/b12-d33.test.mjs :: "D-33: no outreach rule, cap, copy or fixture reads or ranks the prospect segment".

## 2. Failure-mode matrices (C = test above or new title; GAP code = written first; N/A reason)
Global lock order B12 (rules 13/21; every actor in this order, every pair a RACE cell): [1] journal reserve (commerce/request/runtime.ts:306) ->
[2] principal: owner grant shared transition 'kauro.corporate_roles' (commercial-sales.ts:857) | seller shared 'kauro.sellers' (commercial-sales.ts:339;
CMD050 holds the exclusive half :372 after the row FOR NO KEY UPDATE :369) -> [3] prospect exclusive 'kauro.outreach_prospects' (NEW transition
subject; readers shared) -> [4] capabilities FOR SHARE ascending (CMD059 takes FOR NO KEY UPDATE capability-governance.ts:54 then UPDATE :117) ->
[5] resource versions FOR SHARE (publisher UPDATE) -> [6] sender identity FOR SHARE (commands) / FOR NO KEY UPDATE (dispatcher claim, revoker) ->
[7] suppression keys 'kauro.prospect_suppressions' ORGANIZATION then CONTACT key (readers shared, writers exclusive; NEW; also taken shared by
the 0029:991 registration trigger, GAP-SUP-1) -> [8] grant FOR SHARE (CMD061 none, CMD062 none) / FOR NO KEY UPDATE (CMD063, revoke) -> [9] draft
FOR NO KEY UPDATE -> [10] intent FOR NO KEY UPDATE -> [11] dispatcher lease row FOR SHARE as LAST statement (0048 pattern,
commission-service-access.ts:174) -> COMMIT. Clock: every judgment = kauro.effect_now() (0038:12) in a statement AFTER the last lock (rule 15/16);
birth stamps kauro.server_now() (0009:42); app `now` (commerce/request/runtime.ts:318) is passed but never judged; the dispatcher's lease instant is
judged GREATEST(p_now, effect_now()) exactly as 0054/0067 claim_lease. Clock-source census: CK1 (b05-clock-gates.test.ts:337) covers 0082/0083
automatically (regenerate the gates file at rebase); kit adds the B12 src paths to CK3_PATHS (:407).
### CMD061 PrepareOutreachDraft (L-DRAFT). One COMMIT: draft row + content binding + journal. Lock trace: [1] -> [2] seller shared (or owner) ->
[3] prospect shared -> [4] capabilities of the resource FOR SHARE -> [5] resource FOR SHARE -> [6] sender FOR SHARE -> [7] suppression keys shared
-> SELECT effect_now() -> judge (assignment = prospects.owner_seller_id, sender state/binding, provenance = prospect source_evidence_hash,
channel policy, content checks) -> INSERT draft. Actors: B=CMD050 (seller exclusive :372, unassignProspects :617), C=PublishSalesResource
(UPDATE old version SUPERSEDED), D=CMD059 (capability), E=suppression writer, F=second CMD061.
| RACE | C CMD061-RACE (B both orders; C both orders); GAP-DR-1 "RACE (capability): CMD059 restricting the resource's capability held at the capability lock in both orders — draft then SUSPENDED, or 409 RESOURCE_NOT_CURRENT" (fix: FOR SHARE [4]; red without it); E: GAP-DR-2 "RACE (suppression): a suppression of the prospect's contact held at the key lock in both orders — draft refused PROSPECT_SUPPRESSED or born before it (dispatch then refuses, R2-130)" |
| TIMEOUT | C runtime lock/statement timeout -> retryable CAPACITY_UNAVAILABLE, nothing (adapters-unit-of-work "statement_timeout is transaction-local"); GAP-DR-3 "RACE (timeout): CMD061 waiting at the resource lock past the statement timeout answers 503 retryable and writes nothing" |
| EXPIRY | N/A: a draft has no deadline; the resource/capability state is judged after [4]/[5] (rule 15) and the grant window belongs to CMD062/063 |
| CRASH-BEFORE | C CMD061-RACE (crash after INSERT draft, before COMMIT: no draft, no journal entry) |
| CRASH-AFTER | C CMD061-RACE (lost answer replayed by the key; one draft) |
| RETRY | C CMD061-RACE (replay 201 identical; same key other body 409) |
| REVOCATION | C CMD061-RACE (seller terminated); GAP-DR-4 "RACE (revocation): the sender REVOKED by the revoker held at the sender row in both orders" (rule 8: sender, assignment, resource, owner grant each a prerequisite) |
| PARTIAL | GAP-DR-5 "RACE (partial): a failure injected at the content-binding INSERT after the draft INSERT rolls back the draft and the journal reservation" |
### CMD062 AuthorizeOutreach (L-AUTH). One COMMIT: grant + sealed hash rows + journal + allow fact. Trace: [1] -> [2] owner shared -> step-up
proof read -> [5] resources of every draft FOR SHARE -> [6] sender FOR SHARE -> [9] drafts FOR SHARE ascending (NOT NO KEY: the grant's FK
inserts take KEY SHARE; drafts are not written) -> effect_now() -> judge (each hash = a DRAFT of this sender, max <= distinct drafts, window <= 14 d,
expiresAt > effect_now, evidence = review digest, step-up at COMMIT per 0040). Actors: B=revoke owner grant, C=publisher, D=sender revoker,
E=second CMD062 with an overlapping hash (allowed: two grants may seal one draft; consumption is per intent).
| RACE | C CMD062-RACE (B, C, D both orders) | TIMEOUT | C runtime 503 (GAP-AU-1 "RACE (timeout): ... at the draft lock") | EXPIRY | GAP-AU-2 "RACE (expiry): the step-up and expiresAt crossed while waiting at the draft lock are judged at effect_now after it: ASSURANCE_REQUIRED / OUTREACH_GRANT_INVALID, nothing written" | CRASH-BEFORE | C CMD062-RACE | CRASH-AFTER | C CMD062-RACE | RETRY | C CMD062-RACE | REVOCATION | C CMD062-RACE (owner grant) + GAP-AU-3 "DENY: a sender REVOKED after the drafts were prepared" | PARTIAL | GAP-AU-4 "RACE (partial): failure at the second sealed-hash INSERT rolls back grant, first hash, fact and journal" |
RevokeOutreachAuthorization (L-AUTH, owner route, GAP-API-B12-5): [1] -> [2] owner -> [8] grant FOR NO KEY UPDATE -> UPDATE revoked; queued intents
of the grant -> NOT_SENT(GRANT_REVOKED) under [10] ascending. Cells: RACE vs dispatcher claim both orders (in R2-130 file: "RACE (revocation):
grant revoked against a claim held at the grant row in both orders — claim refused, or SUBMITTING completes and the revoke leaves it"), RETRY replay,
PARTIAL failure at the second intent update rolls back the revoke; TIMEOUT/CRASH C by the runtime shape; EXPIRY N/A (revocation has no deadline).
### CMD063 SendAuthorizedOutreach (L-SEND). One COMMIT: intent QUEUED + draft AUTHORIZED + domain event outreach.send_intended.v1 + outbox
record (consumer OUTREACH) + journal. Trace: [1] -> [2] seller/owner shared -> [3] prospect exclusive (cadence + uncertain) -> [4][5] FOR SHARE ->
[6] sender FOR SHARE -> [7] keys shared -> [8] grant FOR NO KEY UPDATE (guarded aggregate: sends reserved = intents not NOT_SENT; rule 17 writers:
CMD063 birth +1, NOT_SENT -1, revoke) -> [9] draft FOR NO KEY UPDATE -> effect_now() -> judge -> INSERTs.
| RACE | C CMD063-RACE (two drafts one grant; revoke both orders); GAP-SE-1 "RACE (cadence): two sends to one prospect held at the prospect lock: one 200, one 409 OUTREACH_CAP_REACHED"; GAP-SE-2 "RACE (rolling cap): the 11th new recipient of one sender in 24 h refused, held at the sender lock" (rule 11 writer pair: CMD063 x CMD063) |
| TIMEOUT | C runtime 503; GAP-SE-3 at the grant lock |
| EXPIRY | GAP-SE-4 "RACE (expiry): the grant's expiresAt crossed while CMD063 waits at the grant lock: OUTREACH_GRANT_INVALID at effect_now after the lock, nothing written" (fix: clock after [8]; red with server_now) |
| CRASH-BEFORE | C CMD063-RACE (after the outbox INSERT, before COMMIT: no intent, no outbox, draft DRAFT) |
| CRASH-AFTER | C CMD063-RACE (replay; one intent; the outbox record dispatches once) |
| RETRY | C CMD063-RACE |
| REVOCATION | C CMD063-RACE (grant); GAP-SE-5 "RACE (revocation): seller TERMINATED held at the seller lock in both orders" ; GAP-SE-6 sender REVOKED both orders |
| PARTIAL | GAP-SE-7 "RACE (partial): failure at the outbox INSERT (third write) rolls back intent, draft AUTHORIZED, event and journal" |
### Dispatcher (L-SEND; apps/api/src/outreach/dispatcher.ts, commissions/dispatcher.ts shape; lease OUTBOX_DISPATCH, v5 UUID "b12-outreach-dispatcher").
Rows: D1 claim outbox (kauro_control, 0067 claim_lease); D2 SUBMITTING COMMIT (kauro_outreach SERVICE unit: [2] seller shared -> [3] prospect shared
-> [6] sender NO KEY UPDATE -> [7] keys shared -> [8] grant FOR SHARE -> [9] draft -> [10] intent NO KEY UPDATE -> recheck all of A4 at effect_now ->
QUEUED->SUBMITTING with claim_fence -> [11] lease FOR SHARE -> COMMIT); D3 provider call OUTSIDE any transaction, bounded (provider-call bound <
lease TTL); D4 outcome COMMIT (intent + draft + activity PROVIDER_ACCEPTED|SEND_UNCERTAIN + [11] lease FOR SHARE); D5 recovery: SUBMITTING whose
claim_fence < current fence -> SEND_UNCERTAIN, no call (KA096 refuses SUBMITTING->SUBMITTING, SUBMITTING->QUEUED, SEND_UNCERTAIN->SUBMITTING);
D6 outbox settle (DELIVERED/RETRYABLE only for a QUEUED intent; never RETRYABLE once SUBMITTING committed).
| D2 RACE | C R2-130 (opt-out writers x claim both orders); C R2-132; GAP-DI-1 "RACE (termination): CMD050 against the claim held at the seller lock in both orders — NOT_SENT(SELLER_NOT_ACTIVE) or SUBMITTING then terminated" | D2 TIMEOUT | GAP-DI-2 claim lock wait timeout: intent stays QUEUED, outbox RETRYABLE, zero calls | D2 EXPIRY | GAP-DI-3 "RACE (expiry): grant expiry crossed while the claim waits at the grant row: NOT_SENT(GRANT_EXPIRED), zero calls" | D2 CRASH-BEFORE | GAP-DI-4 crash after the SUBMITTING UPDATE, before COMMIT: QUEUED, redelivery submits once | D2 CRASH-AFTER | C R2-129 (crash after SUBMITTING COMMIT: D5 -> SEND_UNCERTAIN, zero further calls) | D2 RETRY | C R2-129 (redelivery) | D2 REVOCATION | C R2-132; GAP-DI-5 lease taken over before [11]: unit rolls back, intent QUEUED | D2 PARTIAL | GAP-DI-6 failure at the draft UPDATE after the intent UPDATE rolls both back |
| D3 port | RACE N/A (no lock held; D4 is fenced) | TIMEOUT C R2-129 | EXPIRY C R2-129 (lease taken over during the call: old outcome fenced, SEND_UNCERTAIN) | CRASH C R2-129 | RETRY C R2-129 (one submission; fake counts calls by payload hash) | REVOCATION C R2-132 (AUTH_REVOKED = NO_EFFECT -> NOT_SENT + sender REVOKED) | PARTIAL N/A single call |
| D4 outcome | RACE GAP-DI-7 "RACE (fence): D4 of the old owner against D5 of the new owner held at the lease row, both orders: exactly one outcome" | TIMEOUT GAP-DI-8 outcome COMMIT timeout -> D5 later SEND_UNCERTAIN | EXPIRY C (GAP-DI-7) | CRASH-BEFORE C R2-129 | CRASH-AFTER C R2-129 (settle lost: redelivery sees PROVIDER_ACCEPTED, no call) | RETRY C | REVOCATION N/A (effect already happened; recorded as observed) | PARTIAL GAP-DI-9 failure at activity INSERT rolls back intent/draft outcome; D5 then SEND_UNCERTAIN |
### CMD064 RecordSalesActivity (L-ACT). One COMMIT: activity + draft/intent edge + (SUPPRESSED) suppression row + prospect SUPPRESSED + queued
intents of the prospect NOT_SENT + journal. Trace: [1] -> [2] actor -> [3] prospect exclusive -> [7] keys EXCLUSIVE (SUPPRESSED only) -> [9] draft
-> [10] intent -> effect_now() (occurredAt <= it) -> INSERTs. Writers of the dedup identity: CMD064 x CMD064, dispatcher D4 x CMD064 (both insert
activities with a provider ref; UNIQUE (provider_message_ref, kind) WHERE ref <> 'NONE' + [3]).
| RACE | C CMD064-RACE; GAP-AC-1 "RACE (dispatcher): D4 PROVIDER_ACCEPTED and a reconciler's PROVIDER_ACCEPTED of one ref held at the prospect lock: one row"; GAP-SUP-1 "RACE: RegisterProspect against a suppression of its organization key held at the key lock in both orders — 409 PROSPECT_SUPPRESSED or the new prospect SUPPRESSED by the writer" (0029:991 trigger takes the shared key lock: whole-lane sweep, rule 17) | TIMEOUT | C runtime | EXPIRY | N/A no deadline; occurredAt judged <= effect_now after locks (DENY) | CRASH-BEFORE | C CMD064-RACE | CRASH-AFTER | C CMD064-RACE | RETRY | C CMD064-RACE | REVOCATION | GAP-AC-2 seller TERMINATED both orders | PARTIAL | GAP-AC-3 "RACE (partial): failure at the queued-intent NOT_SENT update rolls back suppression, prospect state and activity" |
Public opt-out POST /api/v1/public/outreach/opt-out/{token} (L-ACT, GAP-API-B12-3; UI49 backend): token = HMAC(secret version, intent id), stored
sha256 on the intent; anonymous, rate-limited, answers the same 200 for unknown tokens (no disclosure). Trace: lookup -> [7] keys exclusive -> INSERT
suppression (CONTACT, purpose MARKETING) -> prospect SUPPRESSED -> queued intents NOT_SENT. Cells: RACE C R2-130; RETRY "RACE: the same token twice
and concurrently: one suppression"; PARTIAL GAP-OO-1; TIMEOUT C runtime; EXPIRY N/A (tokens do not expire: an opt-out must keep working);
CRASH-AFTER replay = same 200 (idempotent by key); REVOCATION N/A (anonymous).
### Reads and owner routes (EL; N/A columns: read-only single unit unless stated)
GetOutreachDraft, ListSalesActivities, GetOutreachMetrics (L-ACT), GetSalesResource + PublishSalesResource (L-DRAFT; publish RACE vs CMD061/062/063
in R2-135), PutOutreachContent (L-DRAFT; content-addressed, not journaled, D-B12S-2 shape), RegisterSenderIdentity + RecordSenderRevocation (L-SEND;
owner, step-up; GMAIL_API needs consentEvidenceRef), GetSellerHome (L-HOME). Each read: DENY cell (wrong role 403, foreign 404 identical to
unknown) + REVOCATION cell (judged under the principal's shared lock, rule 16, same transaction).
L-HOME migration 0083: prospects_seller_read, prospect_contacts_self_read, prospect_source_evidence_self_read, prospect_suppressions_read and every
B12 table use kauro.acting_seller_id() (0029:169, ACTIVE only); GetCommissionStatement admits ACTIVE|SUSPENDED|TERMINATED own seller via new
authorizer.authorizeStatementSeller (shared seller lock, state read after it). Cells: R2-066 title; GAP-HO-1 "RACE (revocation): CMD050 against a
seller's prospect read held at the seller lock in both orders — rows then 0, never rows after TERMINATED"; impact inventory (run on base first):
apps/api/test/{b10-failure-cells-sales,b10-scenarios,cmd045-register-prospect,cmd049-activate-seller,cmd050-terminate-seller}.test.ts,
sellers-support.ts, packages/persistence/test/{b10-ledger-migrations,b10-sales-migrations}.test.ts.

## 3. Lanes (file ownership; no two lanes edit one file; API-REG = commercial/{contracts,request-schemas,response-schemas,views,outcomes,served,
vocabulary}.ts + apps/api/src/composition.ts + openapi/web generated: KIT only, once; regenerated files are regenerated by the coordinator at merge)
| Lane | Branch | Owns | Cells | Est. (tokens, min, model) |
|---|---|---|---|---|
| K kit (first) | b12/kit | migration 0082_b12_outreach.sql (tables sender_identities, outreach_contents, sales_resources(+capability claims), outreach_channel_policies seed, outreach_drafts, outreach_authorizations(+sealed hashes), outreach_send_intents, sales_activities, prospect_contact_addresses; machine rows in kauro.aggregate machine registry; RLS ACTIVE-only; role kauro_outreach + 0048-style lease FOR SHARE grant; narrow lock-only grants for FOR SHARE on capabilities/resources; 0029:991 trigger takes the key lock; guards KA095-097, KC028-033); packages/domain/src/commercial/outreach.ts + machines.ts + principals.ts (OUTREACH_SERVICE); persistence repositories/commercial-outreach.ts, outreach-access.ts, pool.ts/testing harness login kauro_outreach_test, sqlstate.ts, index.ts; application commercial/outreach/{ports,runtime,index}.ts + ContractFakeGmailSend/ContractFakeResend (testing, SIMULATED); every handler file as a stub answering INTEGRITY_FAILURE NOT_BUILT; API-REG for all 4 commands + 11 routes; docs/design/KC-CODES.md rows (PLANNED); tools/test/ka-codes.test.mjs; b05-clock-gates CK3_PATHS; apps/api/test/outreach-support.ts | K cells (§1), GAP-SUP-1 | TD 150k/60 Opus; B 450k/150 Sonnet |
| L-DRAFT | b12/draft | application commercial/outreach/{prepare-draft,put-content,content-checks,resources,get-draft}.ts; tests cmd061-*, b12-resources, packages/application/test/outreach-content.test.ts | CMD061 x3, R2-068, R2-135, GAP-DR-1..5 | TD 120k/45; B 250k/90 |
| L-AUTH | b12/auth | commercial/outreach/{authorize,revoke-authorization}.ts; test cmd062-* | CMD062 x3, GAP-AU-1..4, revoke cells | TD 80k/30; B 150k/60 |
| L-SEND (tier 1 authority) | b12/send | commercial/outreach/{send,sender-identity}.ts; apps/api/src/outreach/{dispatcher,recovery,mime}.ts; tests cmd063-*, b12-dispatch-cells | CMD063 x3, R2-129..132, GAP-SE-*, GAP-DI-* | TD 180k/75 Opus; B 400k/150 Sonnet |
| L-ACT | b12/activity | commercial/outreach/{record-activity,opt-out,metrics,list-activities}.ts; apps/api/src/outreach/opt-out-route.ts; test cmd064-* | CMD064 x3, GAP-AC-*, GAP-OO-1 | TD 120k/45; B 250k/90 |
| L-HOME | b12/home | migration 0083_b12_seller_scope.sql; commercial/authorizer.ts; statements/get-statement.ts; sellers/seller-home.ts; test b12-seller-home | R2-066, GAP-HO-1 | TD 60k/25; B 120k/45 |
| L-SOURCE (rule 1b) | b12/source | commercial/prospects/{record-source,record-contact}.ts (the owner/seller producers commercial-sales.ts:14 says B12 owns; contact address bound sha256 -> contact_key); test b12-prospect-sources | DENY/OK/RACE of the two routes | TD 50k/20; B 100k/40 |
Order: K -> {L-DRAFT, L-AUTH, L-SEND, L-ACT, L-HOME, L-SOURCE} in parallel (5 max per quota-pace) -> one batch branch batch/<date>-b12 (all
lanes together: the stubs never reach main alone) -> adversary per lane (L-SEND tier 1: Codex lane review) -> red-proof per new test -> one PR.
Done per lane: every title of its cells exists and is red on the kit head with the lane's product files reverted (red-proof.mjs), green after;
ci-local green on the merge with origin/main; matrix cells rewritten GAP -> C in the same commit. Total ~2.9M agent tokens; wall ~3.5 h kit + ~3 h lanes.
Codes claimed (census main + 167 worktrees 2026-10-14: KA max KA094 (B16 reserved KA085-094), KC max KC027, gaps KC004/008/012/013 never reused):
KA095 OUTREACH_BINDING, KA096 SEND_FENCE, KA097 ACTIVITY_EVIDENCE; KC028 OUTREACH_ROUTE_FORBIDDEN, KC029 SEND_UNCERTAIN_UNRESOLVED, KC030
OUTREACH_GRANT_INVALID, KC031 SENDER_NOT_VERIFIED, KC032 OUTREACH_CAP_REACHED, KC033 RESOURCE_NOT_CURRENT; dispatch suppression reuses KC016
PROSPECT_SUPPRESSED (same prefix, kc-codes allows one prefix raised by many functions). Migrations provisional 0082 (K), 0083 (L-HOME).

## 4. Context packets (coordinator copies; each <= 3k tokens)
TD-K: goal: failing kit DB tests + ka-codes test. Files: 0029:321-372 (contacts, prospects, suppressions), 0029:988-1000, 0029:1338-1370 (RLS),
0048 whole (21 lines), 0005:108-140 (outbox), 0006:162-215 (leases), 0054/0067 claim_lease, sqlstate.ts:1-130, tools/test/kc-codes.test.mjs, docs/
design/KC-CODES.md. Harness: @kauro/persistence/testing faults (bothOrders, mustWait, crashableFactory, controlledClock, runCell), sales-fixtures
recordActiveSeller. Cells: K titles + GAP-SUP-1. Done: each forged control red alone on 8354d7be+schema-without-guard. Budget 150k/60.
B-K: goal: §3 K files. Contracts: registry contracts OutreachDraft/OutreachAuthorization/SalesActivity (fields verbatim), policy.messaging, §0 A2-A11,
lock order §2, codes §3. Patterns: operations-recovery.ts + 0059 (service principal), commissions/dispatcher.ts:1-130, commission-service-access.ts:
166-180 (lease fence, but judge GREATEST(p_now, effect_now()) like 0054), D-B12S-2 (content-addressed upload). Stubs answer INTEGRITY_FAILURE NOT_BUILT.
Done: kit tests green, existing suite green, CK1 gates regenerated, openapi regenerated. Budget 450k/150.
TD-DRAFT / B-DRAFT: files: kit outreach-support.ts, commercial/prospects/register-prospect.ts (handler shape), authorizer.ts:66-80, commercial-sales.ts:
330-372, 596-610, capability-governance.ts:54,117. Rules: 12 "Outreach workspace" + 18 "Initial channel decision" quotes (§0 A1, A8, A9). Content
checks: subject <= 200 chars, no CR/LF/NUL/control, NFC; body text <= 20,000; refuse any currency/percentage amount within 8 words of "save"/"savings";
"guarantee"; "AI"/"artificial intelligence" in subject; more than one sentence naming AI; every resourceRef CURRENT. Cells §1/§2 CMD061, R2-068, R2-135.
Done: §3. Budget TD 120k/45, B 250k/90.
TD-AUTH / B-AUTH: files: authorize-recovery.ts (step-up pattern), 0040 step-up at COMMIT, kit repository grant methods. Review digest =
sha256(canonical JSON {senderIdentityRef, sorted allowedContentHashes, validFrom, expiresAt, maximumSends}). Cells CMD062 + revoke. Budget 80k/30, 150k/60.
TD-SEND / B-SEND: files: commissions/dispatcher.ts whole, payments/dispatcher.ts:1-30, lease-store.ts, 0048, 0054:1-40, kit ports (GmailSendPort:
submit(mime, sender) -> ACCEPTED{providerMessageRef} | REJECTED{code} | AUTH_REVOKED | TIMEOUT | RESET | UNKNOWN; fake counts submissions by payload
hash, can lose the answer after accepting). Rules: §0 A3-A6, A10, A11; D5 recovery; KA096. Every RACE cell: actor lock trace of §2 in the test
comment with file:line, held via mustWait at the named lock, both orders; the fix whose removal turns it red named in the title comment.
Cells: CMD063 x3, R2-129..132, GAP-SE-*, GAP-DI-*. Budget TD 180k/75 (Opus), B 400k/150.
TD-ACT / B-ACT: files: kit repository activity/suppression methods, 0029:988-1000, register-prospect.ts:60-72, policy.messaging. Kinds and their
admitted actors: PROVIDER_ACCEPTED/SEND_UNCERTAIN service only; BOUNCED service or person with evidence on an accepted intent; REPLIED person with an
inbound ref distinct from every outbound ref of the draft; SUPPRESSED any; HUMAN_SEND_OBSERVED person, closes SEND_UNCERTAIN. Metrics: accepted,
uncertain, bounced, replied and "accepted less known bounces"; no member named delivered. Budget TD 120k/45, B 250k/90.
TD-HOME / B-HOME: files: authorizer.ts whole, get-statement.ts:85-122, 0029:164-177, 1338-1366, 0031:610-624; impact inventory list §2. Home view:
{sellerState, permittedActions (closed set), statements [{statementId, periodStart, periodEnd, state}], supportRoute (deployment KAURO_SELLER_SUPPORT_ROUTE
or null, labelled "not configured")}; never cash, CRM or other sellers. Budget TD 60k/25, B 120k/45.

## 5. Conflicts decided (authority quoted in §0)
D-B12O-1 states (A2). D-B12O-2 dispatch = outbox intent + OUTBOX_DISPATCH lease + fenced outcome, NOT the D-TEAM-1 oneTimeDelivery seam: that seam
drops a failed delivery after COMMIT (server.ts:772-779 "a failing channel is an internal error") and has no uncertain state, which violates A3.
D-B12O-3 a separate kauro_outreach group: contact addresses are personal data and the ref "Measurement" keeps the sales store "separate ... from
private personal finance"; reusing kauro_commission (B18-OPS-1) would let the commission pool read them; policies cannot scope by service id (0059:28).
D-B12O-4 manual route: MANUAL_MAILBOX senders (ref "Selected routes": "sent by its authorized human in the native mailbox and recorded with evidence;
it remains an explicit manual delivery route") get the same claim rechecks; D3 releases the payload to the human (no provider call); CMD064
HUMAN_SEND_OBSERVED closes it. This is the V1 operable route while Gmail consent is BLOCKED_OWNER. D-B12O-5 cancellation: no cancel command exists in
the registry; CANCELLED is reached only by the dispatcher (sender REVOKED, seller not ACTIVE, grant revoked/expired) — recorded, not invented.
D-B12O-6 cadence, D-B12O-7 jurisdiction/compliance (§0). D-B12O-8 grant consumption = reserved intents under the grant row lock; NOT_SENT returns it.
D-B12O-9 R2-066 support route = deployment value (no seller support command exists in the registry; 12 "Seller dispute flow" has none either):
null is shown as not configured, never a fabricated address. D-B12O-10 an opt-out is contact-level MARKETING suppression; essential notices are not
outreach and are out of this boundary (10 "Marketing opt-out does not suppress legally necessary payment or security notices").
Caveats turned into cells: post-claim opt-out cannot recall an in-flight submission (ref: "before queued sends are claimed") -> R2-130 asserts the
order; a provider-accepted message whose answer was lost stays SEND_UNCERTAIN even if the fake later shows it sent (never inferred) -> R2-129.

## 6. BLOCKED_OWNER parts (build continues on fakes; live halves PART)
Gmail API OAuth app verification and per-seller consent (ref "Selected routes"; OA06/OA16) -> live R2-129/131/132/CMD063 PART(B15/B19); Workspace
seats per seller (OA17, "licence ... separately provisioned and budgeted"); domain + SPF/DKIM/DMARC read-back (OA03, B14); Resend account (B15);
postal address for the CAN-SPAM footer (D-16: address not given); opt-out HMAC secret and support alias are B14 provisioning (not owner).

## 7. Deferred (rule 7: moving interfaces)
R2-067 owner finance unknowns: O2 part is lane b12/owner-screens (open); O4 needs PV1-SETTLE (pv1/settle 5134439a, open). Binding requirements for the
O4 lane: captured, provider-held, provider-available, bank-available, refundable, tax, commission-payable each a separate member with observedAt and
source; absent observation = UNKNOWN (never 0, 12 "Unknown balances are labelled unknown, never zero"); no spendable-cash member exists unless a
verified bank settlement row backs it; seller sessions 403. Web screens UI33/UI53/UI54 (browser halves of R2-066/068/135) follow the API lanes'
merge (SCREENS-PLAN: OPS screens DEFERRED): copy word for word from registry primaryCopy; "A draft is not sent; provider acceptance is not delivery".
