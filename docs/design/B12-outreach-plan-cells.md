# B12 outreach plan rev 2, companion: kit tables, forged controls, non-registry routes, producers (planner 2026-10-14)
Read with docs/design/B12-outreach-plan.md (lock numbers L1..L13, rulings A1..A17, decisions D-B12O-*). Template rules 12, 17, 20, 22 applied here.
Cell syntax: C = title given; "not needed because <fact>"; every DENY has its OK sibling through the production writer (rule 20).

## §K Kit: rule-22 lifetime matrix (0082; extractor: K1 adds the B12 tables to the read-only table/column extractor the B10 kit uses,
packages/persistence/test/b10-ledger-migrations.test.ts:410 list shape; the list below is checked against it, never assembled by hand)
TRUNCATE (fires no row trigger) for every table below: guard = no runtime role holds TRUNCATE (census test "B12 TRUNCATE: kauro_app,
kauro_outreach, kauro_control hold no TRUNCATE on any B12 table"). DELETE: append-only trigger kauro.forbid_change (0002 pattern) unless stated.
| Table | INSERT (birth binding) | UPDATE per guarded column | DELETE / reparent | Deferred |
|---|---|---|---|---|
| sender_identities | owner only, step-up; user_id = bound person; route GMAIL_API needs consent_evidence_ref; state born PENDING_VERIFICATION (KA095) | state PENDING->VERIFIED (owner, evidence), ->REVOKED (owner or D4 AUTH_REVOKED); terminal REVOKED; address, user_id, route immutable (KA095) | forbid; user_id/route reparent forbidden | none |
| outreach_contents | content-addressed (sha256 = id), recorder = session person, size/NFC CHECKs | immutable | forbid | none |
| sales_resources (+ sales_resource_capabilities) | owner publisher; version n+1 of a family; capability claims rows born with it | state CURRENT->SUPERSEDED only by the publisher of n+1 in the same transaction | forbid; family reparent forbidden | "one CURRENT per family" deferred unique check at COMMIT, queued per family on INSERT and UPDATE |
| outreach_channel_policies | seed only (migration DML, listed in clock-gates MIGRATION_DML); no runtime INSERT grant | state IN_FORCE->WITHDRAWN (owner) | forbid | none |
| outreach_calendar_days | seed only (2026-2028), version column | none (new version = new rows) | forbid | none |
| outreach_drafts | CMD061 writer; sender/prospect/purpose/content hash/provenance bound (KA095); version 1 | state per A2 edges only (KA096); version +1 per edge; content columns immutable | forbid; prospect/sender reparent forbidden | none |
| outreach_reviews | PrepareOutreachReview; issued_at = effect_now, expires = issued_at + 15 min, proof bound (KA095) | consumed_at only via grant INSERT (deferred check: every consumed review has exactly one grant, every grant one review) | forbid | per review and per grant at COMMIT |
| outreach_authorizations (+ _hashes) | CMD062; review_id UNIQUE; hashes all DRAFT of the sender at birth; max <= distinct hashes; window <= 14 d (KC030) | revoked false->true only (owner); everything else immutable | forbid | "grant has >= 1 hash" per grant at COMMIT |
| outreach_send_intents | CMD063 only; trigger takes L3, L4, L9 and judges counts at effect_now (KC030, KC032, KC034, KC036, KC037); route not RESEND (KC028) | state edges KA096; counted_at only at birth and at QUEUED->SUBMITTING; claim_fence only with that edge; payload_hash, grant, draft immutable | forbid | none |
| sales_activities | CMD064 writer (person or service), dedup identities per kind (KA097), occurredAt <= effect_now | immutable | forbid | none |
| outreach_diagnoses | RecordOutreachDiagnosis, owner, step-up, evidence hash | immutable | forbid | none |
| prospect_contact_addresses | L-SOURCE writer; sha256(KAURO_PROSPECT_CONTACT_V1(addr)) = prospect_contacts.contact_key (KA095) | immutable | forbid | none |
| prospect_suppressions (ALTER) | num_nonnulls(recorded_by_user_id, recorded_by_service) = 1; kauro_outreach only CONTACT + OPT_OUT | append-only (0029) | append-only (0029) | none |
| prospects (UPDATE path) | n/a (0029) | non-owner UPDATE: only state/suppressed/version/updated_at, to SUPPRESSED, with a suppression row reaching it (KA098) | n/a | none |
Rule-12 forged controls (packages/persistence/test/b12-outreach-migrations.test.ts; each "<code> (<predicate>): forged ... refused; OK sibling
through the production writer"): KA095 (a) intent sender != draft sender, (b) grant sender != draft sender, (c) draft prospect not the sender's
person's assigned prospect, (d) content hash not bound to recipient/sender/purpose/body, (e) review proof of another person, (f) contact address hash
!= contact key, (g) sender address change; KA096 (a) SEND_UNCERTAIN->SUBMITTING, (b) SUBMITTING->QUEUED, (c) SUBMITTING->SUBMITTING, (d) NOT_SENT->
QUEUED, (e) OBSERVED_NOT_SENT->any, (f) counted_at change outside the claim edge, (g) claim_fence without the edge; KA097 (a) second PROVIDER_ACCEPTED
of an intent, (b) second HUMAN_SEND_OBSERVED of an intent, (c) second REPLIED of one inbound ref, (d) REPLIED with NONE, (e) BOUNCED with NONE, (f)
second SUPPRESSED of (prospect, key), (g) PROVIDER_ACCEPTED by a person, (h) occurredAt after effect_now, (i) REPLIED ref equal to an outbound ref;
KA098 (a) non-owner UPDATE of organization_label, (b) to a state other than SUPPRESSED, (c) SUPPRESSED without a reaching suppression row; KC028 RESEND
route intent; KC029 open SEND_UNCERTAIN of the prospect; KC030 (a) reserved over max, (b) revoked, (c) before validFrom, (d) at expiresAt, (e) hash
not sealed; KC031 unverified sender; KC032 (a) 11th person first contact in 24 h, (b) second active sequence, (c) third message, (d) follow-up before
5 business days, (e) at first + 14 days, (f) before last + 90 days, (g) after a stop trigger; KC033 (a) resource SUPERSEDED, (b) capability
SUSPENDED; KC034 (a) one bounce in latest 50, (b) one complaint, (c) after a diagnosis: OK; KC035 (a) consumed, (b) expired, (c) other proof, (d)
version moved; KC036 draft OBSERVED_SENT; KC037 date outside the seeded years; absent-row predicates (rule 12/23) each their own control: "no grant row",
"no review row", "no calendar row", "no policy row". Plus the recorder XOR: "both recorders null" and "both recorders set". GAP-SUP-1 lives here too.
ka-codes.test.mjs / kc-codes.test.mjs: "every raised KA/KC code has one prefix, one sqlstate.ts entry, one KC-CODES.md row and no other lane's claim".

## §S Static and census cells (tools/test)
- b12-d33.test.mjs :: "D-33: no B12 file reads segment or buyer type, names AGENCY/COMPANY literals in a rule, cap, copy or fixture, or orders prospects
  or evidence by any attribute but id/created_at; a planted ORDER BY segment and a planted 'AGENCY' cap in a copy of a B12 file each fail".
- b12-imports.test.mjs :: "B12 imports no tenant data-plane, staging, target adapter, connector or CRM write module, and kauro_outreach holds no grant on
  any table with agency_id; a planted import of @kauro/data-plane fails".
- b12-producers.test.mjs :: "every table a B10/B12 command reads has a non-fixture writer or a named owner lane (census of INSERT INTO kauro.<t> in
  packages/*/src and apps/*/src outside testing); a planted reader of an unwritten table fails".
- b12-case-map.test.mjs :: "B12 case map: 20 ids, each with class, lane and existing test title".

## §R Non-registry stateful routes (8 columns each; owner routes step-up where marked; all journaled REQUIRED idempotency)
| Route (lane, GAP-API) | RACE | TIMEOUT | EXPIRY | CRASH-B/A | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|
| PublishSalesResource (L-DRAFT, B12-7; owner, step-up): L1 -> L2 -> L5 -> L6 old FOR NO KEY UPDATE -> insert n+1, old SUPERSEDED | C R2-135 + GAP-PU-1 "RACE: two publishes of one family held at L6: one n+1, one 409 stale" | runtime 503 | N/A no deadline | "PUBLISH crash after the UPDATE before COMMIT: old stays CURRENT; after: replay" | replay | GAP-PU-2 owner grant revoked at L1 both orders | GAP-PU-3 "failure at the capability-claim INSERT rolls back n+1 and the SUPERSEDED edge" |
| PutOutreachContent (L-DRAFT, B12-8; seller/owner) content-addressed INSERT ON CONFLICT DO NOTHING | GAP-PC-1 "two puts of one body: one row, both 201 same id" | runtime | N/A | idempotent by hash | C GAP-PC-1 | GAP-PC-2 TERMINATED seller 403 (L1) | N/A one row |
| RegisterSenderIdentity (L-SEND, B12-9; owner, step-up) | GAP-RS-1 "two registrations of one address: one row, one 409" | runtime | GAP-RS-2 consent evidence older than its stated validity refused | crash/replay | replay | GAP-RS-3 seller TERMINATED at L1 both orders: refused | N/A one row |
| VerifySenderIdentity (L-SEND, B12-10; owner) PENDING->VERIFIED | GAP-VS-1 "verify vs revoke held at L7: one terminal answer" | runtime | N/A | crash/replay | replay | C GAP-VS-1 | N/A |
| RecordSenderRevocation (L-SEND, B12-11; owner) L1 -> L2 -> L7 FOR NO KEY UPDATE | C GAP-DR-4, GAP-SE-6, GAP-VS-1 | runtime | N/A | crash/replay | replay | n/a (it is the revoker) | N/A one row; queued intents CANCELLED by D2 (R2-132) |
| RecordProspectSource (L-SOURCE, B12-1; ACTIVE seller or owner, policy 0029:1335-1336) | GAP-PS-1 "seller TERMINATED by CMD050 held at L1 both orders" | runtime | GAP-PS-2 "observation dated after effect_now refused" | crash/replay | replay | C GAP-PS-1 | N/A one row |
| RecordProspectContact (L-SOURCE, B12-2; policy 0029:1343-1344) writes prospect_contacts + prospect_contact_addresses | GAP-PK-1 "the same address recorded by two sellers concurrently: two contact rows, one key" | runtime | N/A | crash/replay | replay | GAP-PK-2 TERMINATED at L1 | GAP-PK-3 "failure at the address INSERT rolls back the contact" |
| PrepareOutreachReview (L-AUTH, B12-6; owner, step-up) | GAP-RV-1 "CMD063 authorizing a draft held at L10 vs the review: review refused non-DRAFT, or issued and then CMD062 refused" | runtime | GAP-AU-5 | crash/replay | replay | GAP-RV-2 owner revoked at L1 | GAP-RV-3 "failure at the second draft line rolls back the review" |
| RecordOutreachDiagnosis (L-ACT, B12-12; owner, step-up) | GAP-DG-1 "diagnosis vs CMD063 of the paused person: sequential, gate monotone (§G N/A reason)" | runtime | N/A | crash/replay | replay | GAP-DG-2 owner revoked at L1 | N/A one row |
| RevokeOutreachAuthorization (L-AUTH, B12-5) | plan §2 | | | | | | |
| Public opt-out GET/POST (L-ACT, B12-3/4) | plan §2 | | | | | | |
Reimport/survival titles (L-SOURCE, b12-prospect-sources.test.ts): "DENY (reimport): after an opt-out the same address in other case recorded by
another seller yields the same contact key and CMD045 409 PROSPECT_SUPPRESSED"; "DENY (reassignment): after CMD050 unassigns and the owner registers the
organization again, the suppressed contact refuses CMD061 and CMD063"; "DENY (provider change): a MANUAL_MAILBOX sender of another person is refused
for the suppressed contact"; "DENY (CRM): a provenance or contact naming a tenant record id is 404 like unknown".

## §P B12-owned producers (rule 1b; census 2026-10-14: 0 product writers for each, fixtures sales-fixtures.ts:81-280, sellers-support.ts:64-125)
Authority: each producer writes exactly the row 0029 and its consuming command already define (B10 design, accepted rules; the 0029 comment names
the R2 section); no new truth rule. Lane L-OWNER; owner routes take step-up; seller routes the seller's own ACTIVE session unless stated.
| Table (0029 line, policy) | Route / consumer | Cells (test b12-owner-tools.test.ts; 8 columns: RACE at the row or L1, TIMEOUT runtime, EXPIRY, CRASH/RETRY replay, REVOCATION L1, PARTIAL) |
|---|---|---|
| sellers (133, 1280) | RegisterSellerCandidate (owner) -> CMD049 | OK/DENY/RACE "two candidates of one person: one row"; EXPIRY N/A |
| seller_legal_reviews (184, 1289) | RecordSellerLegalReview (owner) -> KC005 | OK/DENY ("label is not classification", 17 "Legal engagement packet"); RACE vs CMD049 at L1 both orders |
| seller_agreements (202, 1295/1297) | PrepareSellerAgreement + RecordAgreementSignature (owner) -> CMD049 | signed once; RACE signature vs CMD049 at L1; PARTIAL "failure after the terms row rolls back" |
| seller_assessments (233, 1304) | RecordSellerAssessment (owner) | OK/DENY/RACE at L1 |
| seller_confidentiality_acceptances (244, 1310) | RecordConfidentialityAcceptance (owner records the seller's evidence) | OK/DENY; RACE at L1 |
| seller_tax_documents (255, 1316) | RecordSellerTaxDocument (owner, content-addressed) | OK/DENY (profile requirements); RACE at L1 |
| seller_payout_destinations (275, 1327/1322) TIER 1 money | ChangePayoutDestination (seller, own fresh step-up) + VerifyPayoutDestination (owner, step-up) | full 8 columns; RACE change vs verify at the row FOR NO KEY UPDATE both orders; EXPIRY step-up at COMMIT (0040 shape); REVOCATION seller TERMINATED keeps the change right (1328, tail); Codex lane review |
| service_assignments (584, 1428) | PrepareServiceAssignment (owner) -> CMD048 | OK/DENY; RACE vs CMD048 at its lock both orders |
| assistance_agreements (503, 1412) | RecordAssistanceAgreement (owner) | signed before work; OK/DENY/RACE |
| seller_terminations terms (649, 1454) | PrepareTerminationTerms (owner) -> CMD050 terminationTermsRef | one effective per seller; RACE vs CMD050 at L1 |
| termination_manifests (636, 1448) | PrepareTerminationManifest (owner) -> CMD050 | claims enumerated = accepted claims at preparation; RACE vs CMD047 at the prospect claims lock (commercial-sales.ts:607) both orders |
Done for L-OWNER: every fixture insert of these tables in sellers-support.ts/sales-fixtures.ts used by a B10 OK test has a twin through the product route
(the fixture stays for unit setup); b12-producers.test.mjs green.

## §T Context packets (coordinator copies; each <= 3k tokens; harness: packages/persistence/src/testing/faults/{interleave.ts mustWait:151,
bothOrders:384, inOrder:350, concurrently:393; clock.ts ControlledClock:17; points.ts; matrix.ts}, apps/api/test/b10-cells-support.ts {contend:92,
settled:80, open:38}; every RACE title carries its actor lock trace (§2 L-numbers with file:line) and names the lock whose removal turns it red)
TD-K1/B-K1: 0029:133-372 (tables), 0029:988-1004, 0029:1280-1372 (policies), 0048 (21 lines), 0059:1-40 (service principal), 0005:108-140 (outbox),
0006:162-215 (leases), 0054/0067 claim_lease, 0002:43-58, 0040, sqlstate.ts, kc-codes.test.mjs, ka-codes.test.mjs, KC-CODES.md, b05-clock-gates
.test.ts:164,185,337,407, support/holidays.ts:93-142, sales-fixtures.ts. Cells companion §K/§S. Done: each control red alone with its guard dropped,
OK sibling green; CK1 regenerated. Budget §3.
TD-DRAFT/B-DRAFT: outreach-support.ts, register-prospect.ts (shape), authorizer.ts:66-80, commercial-sales.ts:330-372, capability-governance.ts:54,117;
§0 A1, A5, A8, A9, A17; content checks: subject <= 200 chars, no CR/LF/NUL/control, NFC; body <= 20,000; amounts within 8 words of save/savings;
"guarantee"; AI in subject; > 1 AI sentence; resources CURRENT. Cells CMD061, R2-068, R2-135, GAP-DR-*, §R publish/put.
TD-AUTH/B-AUTH: authorize-recovery.ts (step-up), 0040, 0002:43-58, kit grant/review methods; §0 A16; cells CMD062, GAP-AU-*, §R review.
TD-SEND/B-SEND: commissions/dispatcher.ts, payments/dispatcher.ts:1-30, lease-store.ts, 0048, 0054:1-40, commission-service-access.ts:166-180;
GmailSendPort.submit(mime, sender) -> ACCEPTED{ref} | AUTH_REVOKED | REJECTED_DEFINITIVE{status} | NOT_ATTEMPTED | HTTP_5XX{status} | RESET | TIMEOUT |
UNKNOWN (fake counts submissions by payload hash, can lose the answer after accepting, records the MIME); §0 A3-A6, A10-A15; D2 list; KA096.
TD-ACT/B-ACT: kit activity/suppression methods, 0029:988-1004, 0029:1364-1367, register-prospect.ts:60-72, public-routes.ts:1-70,
public/inquiries.ts:95-115; dedup identities and actors §2 CMD064; metrics members; §0 A12, A14; diagnosis route §R.
TD-HOME/B-HOME: authorizer.ts, get-statement.ts:85-122 (on main after batch-b), 0029:160-177, 1326-1366, 0031:610-624; impact inventory §2. Home view:
{sellerState, permittedActions, statements[], supportRoute (KAURO_SELLER_SUPPORT_ROUTE or null "not configured")}; never cash, CRM or other sellers.
TD-SOURCE/B-SOURCE and TD-OWNER/B-OWNER: companion §R/§P rows, 0029 policy lines named there, sales-fixtures.ts:81-280 (the fixture shapes to replace).
