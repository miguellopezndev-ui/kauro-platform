# B07 — Upload, inspection and source lifecycle: design

Branch `b07/design`, rebased on `main` at `ac44af6` (B05, the final B06, and the shared aggregate-kind registry of
`docs/design/FOUNDATION-aggregate-kinds.md`, migration 0008). Package B07 of the build program (22 "B07 — Upload, inspection and
source lifecycle": implement upload reservations, resumable cancellation, scan coverage, immutable accepted generations,
selection, projection, sealing and deletion inventory; prove late uploads cannot resurrect cancelled data, scanner skips do not
pass, all selected files and tables are counted and retention anchors survive failure). Gate G-UPLOAD (owner 09). Owning manuals
03, 04, 08, 09, 10, with 07 (aggregates, transaction discipline, outbox) and 21 (evidence). Contracts and cases come from the
vendored R2 registry under `packages/contracts/registry` (provenance-checked; quoted, never edited).

This design **extends** the B06 foundation and does not fork it: the pipeline order of D-PIPE-1 (authenticate → access decision →
journal reserve → execute), the runtime roles and their verified pools (`kauro_app`, `kauro_control`, `kauro_assurance`,
`kauro_validator`, `kauro_ingress`), forced RLS, initial-state guards and listed transitions (D-INIT-1, KA008), version and event
discipline (D-VER-1, D-EVT-1, D-EVT-2 — through the foundation's table-driven binding), transition locks (D-TX-2), the command
journal (D-IDEM-1..3), security facts (D-FACT-1), the closed response contract and outcome catalogues (D-RESP-1, D-OUT-1) and the
test helpers of `@kauro/persistence/testing`. Everything here is either quoted from the authority (section named) or a recorded
decision (`D-*`); where the authority is silent the decision states its rationale and §14 lists the question for the authority.
English only; the brand is Kauro (amendment A2). This revision applies the adversarial critique of `bfac6b1` (findings B07-F1 …
B07-F14) and the independent re-check of `f243248` (residuals N1 … N5); §18 records the disposition of every finding, and §18.2
the closure of the final re-check's residuals (N5, FINAL-N1 … FINAL-N3) on `b07/stage-1`, where the three stage-1 mandates are
merged (§15, §16.2).

| delivered on this branch | left to the implementation mandates (§15) |
|---|---|
| `packages/persistence/migrations/0009..0012` — the complete B07 schema on PostgreSQL 17: the server clock of every lifecycle instant, revision lifecycle and lineage, upload sessions, quota and capacity ledgers, the object registry with the retention read-back, encrypted session secrets, inspection receipts, admitted files (an aggregate) and their frozen table inventory, selection manifests and evaluations, the sealed manifest (HASHING's exact preimage) and sealed subject, retention anchors (owned and bound) and records (the hard cap of the bytes), the B07 event types; B07's aggregate kinds as rows of the foundation registry; RLS under the B06 roles; applied from empty by the B06 runner | the `pg` adapters of the source store (`SourceUnitOfWorkFactory.runSource`) and the SQLSTATE translation of the B07 refusals (B07-PERSISTENCE, stage 1) |
| `packages/persistence/test/source-migrations.test.ts` — 33 real-database tests of the B07 schema through the runtime login roles, among them one per observable critique finding (F1 ×2, F2, F3, F4, F5, F9, F10, F11, F14) and one per re-check residual (N1, N2, N4; N3 inside the S054 and R2-051 tests) reproducing the attack and showing it refused | the bounded container inspector in its isolated child process, the selection evaluator and the preview reader of `@kauro/data-plane`, and the labelled scanner fake (B07-DATA-PLANE, stage 1); the labelled fakes of object storage, the session vault and the authority journal (B07-PROVIDER-FAKES, stage 1) |
| `@kauro/persistence/testing` — the labelled TEST CLOCK of the temporary clusters (D-CLOCK-1) and the source-lifecycle fixture (`admitSourceFile`, `bindSourceSelection`, `countSourceSelection`, `readySourceRevision`, `sealStatements`, `sealReadyRevision`, `sealSourceRevision`, `expireSealedRevision`, `clockAt`): a revision sealed through the real pipeline, each write by the role that owns it, never back-dated | the six handlers, the two-phase runtime, the auxiliary routes and their api tests (B07-COMMANDS, stage 2) |
| `@kauro/domain` — ids, records, the four platform machines, policy values, the selection manifest document, scan-coverage evaluation against the object, digests (the authority manifest preimage and the sealed subject), deadline arithmetic of the bytes' first seal, object names; the source-store ports and the read ports B09/B10 consume (`SourceAvailabilityReader`, `RevisionLineageReader`) | the control-plane consumers and sweepers (B07-CONTROL, stage 2) |
| `@kauro/application` — the six command contracts, closed request schemas, the selection manifest document schema, the response views and planned reply envelopes, the closed outcome catalogues of every B07 route, the provider ports (the inspection isolation contract, the tombstone kinds of every AUTHORITY_JOURNAL event), the orchestration contracts (`SOURCE_SWEEPERS`) | the 23 cases end to end (`docs/design/B07-case-map.md` names each test) |
| `tools/matrix.mjs` and `tools/openapi.mjs` — the matrix covers the four B07 machines and the specified B07 commands and routes; the OpenAPI document lists every B07 route as an `x-kauro-planned` operation generated from the same contracts (D-API-1) | serving the routes moves them into `paths` (B07-COMMANDS) |

## 1. Decisions register

| id | decision | why (authority) |
|---|---|---|
| D-SQL-1 | B07 raises its own SQLSTATE range: KA070 QUOTA_LEDGER (a quota ledger disagrees with the uploads it summarizes), KA071 FENCE_DISCIPLINE (a fence moved backwards or a stale attempt wrote, including an inventory append after admission), KA072 LIFECYCLE_BINDING (a transition lacks the facts its target state requires, leaves its scope inconsistent, records an instant other than the server's, or takes a deadline edge on the wrong side of its deadline). Mapped in `@kauro/persistence` `sqlstate.ts` to INTEGRITY_FAILURE / QUOTA_LEDGER, PRECONDITION_FAILED / FENCE_DISCIPLINE and INTEGRITY_FAILURE / LIFECYCLE_BINDING_MISSING. B09 uses the KP class, so the two packages cannot collide. | 07 "Command outcomes and error taxonomy" (authentication, authorization, stale version, invalid input and integrity are distinct); B06 D-ERR-1..3. |
| D-KIND-1 | B07's aggregate kinds are rows of the foundation registry `kauro.aggregate_kinds` (0008): `upload_session` (0009), `source_file` (0010), `retention_record` (0012), each registered with one INSERT by the migration that creates its table, owner `B07`. B07 never edits 0008, the foreign key or `kauro.domain_events_bind_aggregate`. The control plane, which appends events (D-CTRL-2), gets `SELECT` on the registry and its own read policy `aggregate_kinds_read_b07_control`; the foundation test's list of event inserters is extended to it. (Replaces the former D-MIG-1, which created a competing registry: B07-F7.) | FOUNDATION-aggregate-kinds.md D-AGGK-1..5 and §4 "How a package registers its kinds"; 07 "Outbox, inbox and event ordering"; B06 D-EVT-2. |
| D-CLOCK-1 | Every instant a deadline is computed from or compared with — an upload's creation, a session issue, a completion report or observation, an admission, a rejection, a cancellation, an expiry, a seal, a supersession, a selection, a retention anchor, a record expiry, a revocation, a deletion — is the database's transaction time, read through `kauro.server_now()` (defined `transaction_timestamp()`); the guards refuse any other value (KA072) and decide every deadline on it: nothing is accepted at or after an upload's application deadline (no session issue, completion report, retried observation or admission), nothing expires before its deadline, a revision expires only when no governing record is ACTIVE ahead of the server clock. Temporary test clusters replace the function, as the migration owner, by a labelled TEST CLOCK that adds a transaction-local offset (`@kauro/persistence/testing`), so fixtures stand in the past without any production role back-dating a row; the migrations test proves the shipped body. (B07-F2.) The facts a transition records are set once: an upload's admission, rejection, cancellation and expiry instants, terminal reason and canceller, and a revision's supersession (with its successor), cancellation, rejection, expiry and deletion instants and terminal reason are never re-dated or re-explained by a later update (KA004); a provider retention read-back is observed at the server's time (re-checks N2, N3; D-INSP-4 bounds the receipt's instants). | 09 "Upload reservation" (twenty-four hours from initiation; polling and browser refresh do not extend it); 09 "Resumable session security" (refusing acceptance after expiry); HASHING "Retention formulas" (price validity, retries, support activity or a display label cannot move a source retention anchor; extensions never reset a hard clock); registry RetentionRecord.anchorEvidenceHash ("Actual seal/capture/ready/stage/terminal facts"); 07 "Transaction discipline" (application checks cannot be the sole protection). |
| D-UP-1 | UploadSession is a platform machine (the registry contract has states, no machine): RESERVED → UPLOADING (session_issued) → VERIFYING (completion_reported) → ADMITTED (inspection_admitted) or REJECTED (inspection_rejected); VERIFYING → UPLOADING (completion_not_observed); RESERVED/UPLOADING/VERIFYING → CANCELLED (cancel_upload) or EXPIRED (reservation_expired); ADMITTED → EXPIRED (intake_deadline_reached). Initial RESERVED; CANCELLED, EXPIRED and REJECTED are terminal: nothing leaves an acceptance tombstone. | registry UploadSession ("Application acceptance and provider session lifetime are independent"); 09 "Upload reservation", "Resumable session security", "Completion and inspection". |
| D-UP-2 | Byte and file quota is a per-revision ledger (`revision_quota`: bytes ≤ 5,000,000,000, files ≤ 50) maintained only by the `upload_sessions` trigger. An upload holds its reservation while in flight, its observed bytes once admitted and nothing once acceptance is tombstoned, so freed quota is released exactly once. The ledger UPDATE takes the row lock: two reservations that each fit alone serialize there, and the CHECK refuses the combination on the committed total. A direct edit of a ledger is refused at COMMIT (KA070). The deferred check is queued only by a write that changed what an upload holds, and reads the uploads and the ledger in one statement, i.e. one snapshot, so a concurrent reservation can never make it raise a false, nonretryable KA070 on an unrelated transaction (B07-F10). | R2-052 ("the aggregate transaction admits only the combination within five billion bytes"); 09 "Initial intake envelope" (conjunctive limits); 07 "Transaction discipline" (unique constraints and row locks close races; typed conflicts); CMD015 failure ("consume freed quota twice"); B06 D-ERR (INTEGRITY_FAILURE is nonretryable). |
| D-UP-3 | Concurrency is an agency ledger (`upload_capacity`: active sessions ≤ `session_limit`, default 2 = policy `capacity.agencyUploads`); a session slot is held while RESERVED, UPLOADING or VERIFYING. Only the control plane (operations) writes the limit; request handlers hold column grants on the counter only. | 09 "Upload reservation" (the initial concurrent limit is two sessions per agency). |
| D-INTAKE-1 | all_uploads_completed (UPLOADING → INSPECTING) is the agency's explicit act, never a side effect: CMD016 SelectInputTables binds its selection on the UPLOADING revision — once no upload of it is RESERVED, UPLOADING or VERIFYING and every included file is admitted — and takes the edge in the same update. No observation, inspection outcome, cancellation or deadline closes the intake (the control plane cannot enter INSPECTING at all): a revision fed by two concurrent sessions stays UPLOADING across the gaps between reservations, up to fifty files. The edge is serialized: CMD016 locks the revision row first (D-LOCK-1) and the guard reads the sibling uploads after the revision's transition lock; every settle point — CMD015, the deadline sweeper, an inspection outcome — takes the same revision row first (D-LOCK-1, D-LOCK-2), so the selection always reads a settled result, and after any of them the revision is closable by the selection of what was admitted. (B07-F1.) | registry DatasetRevision all_uploads_completed guard ("Actual provider completion is observed for selected uploads"); 09 "Accepted immutability and sealing" ("The agency selects tables and confirms parsing and projection"); 09 "Initial intake envelope" (fifty files per revision) with 09 "Upload reservation" (two concurrent sessions per agency); CMD013 precondition ("Revision is mutable"); 07 "Transaction discipline" (multi-row invariants use explicit locking). Open question Q-B07-19. |
| D-SESSION-1 | The provider session reference is sealed (AEAD, key reference, nonce, bound to agency, upload, requester and issuance attempt by the vault port) in `upload_session_secrets`, apart from the upload row. The requester reads it only while the upload is UPLOADING and before the application deadline on the server clock; the control plane reads it only bound to that agency (to cancel it) and deletes it once the cancellation resolved or the provider lifetime ended; nobody updates it. | 09 "Resumable session security" (a bearer credential; stored encrypted in the temporary control record, bound to one destination, returned only through the authenticated upload flow). |
| D-SESSION-2 | The command journal never stores the session: CMD013's journaled view carries a placeholder the transport hydrates for the requester (answer and replay); any other reader gets `UNAVAILABLE`. `GET /api/v1/uploads/{uploadId}/session` re-delivers it to the requester under the same rule. | 09 (never in logs, email, error reports or executor handoffs); 10 "Upload and target routes" (through the protected response; GET progress never exposes the session URI to unrelated readers); 10 "Idempotency contract" (a lost response is recovered by the same key). |
| D-SESSION-3 | A provider session lifetime the adapter does not report is taken as 604,800 s; reconciliation of an UNCERTAIN or UNSUPPORTED cancellation runs until that horizon. | 09: a Cloud Storage resumable session URI can remain usable for up to a week unless cancelled. Open question Q-B07-4. |
| D-SESSION-4 | Delivering a provider session (the CMD013 answer, its replay, the session read) records an ALLOW security fact in the agency's stream (action `CMD013` or `READ_UPLOAD_SESSION`, reason `SESSION_DELIVERED`, assurance SESSION); a refused delivery is a DENY fact like every other (D-FACT-1). | 08 "Audit events and retention" (every trust boundary has an audit event); 09 (the session is a bearer credential). |
| D-RUN-1 | CompleteUpload answers 202 with B06's ACCEPTED envelope (operationId = the upload id, state VERIFYING, statusPath `/api/v1/uploads/{uploadId}`, pollAfterSeconds 5): the request records the browser's claim and schedules verification; the provider observation, hashing, inspection and scan run in the control plane (UPLOAD_INSPECTION). The journal stores the 202 and a replay answers it again. | catalogue CMD014 effect ("completion remains asynchronous"); 10 "Responses and safe errors" (long work returns 202 with operationId, state, status URL and polling guidance); 07 (no transaction spans an external call). 09 says CompleteUpload "reads provider metadata" — open question Q-B07-1. |
| D-RUN-2 | ReserveUpload is a two-phase command: unit of work 1 (access decision, journal reserve, the revision row lock, the intent: quarantine object INTENDED, upload RESERVED holding issuance fence 1, the initiation anchor, DRAFT → UPLOADING for the first upload; the journal entry stays RESERVED, linked to the upload) → one bounded provider call outside any transaction (10 s) → unit of work 2 (access decision again, fence and state check, the sealed secret, RESERVED → UPLOADING, journal commit). A retry with the same key finds the entry PENDING: younger than 30 s it answers OPERATION_PENDING; older, it resumes under a new fence (a stale attempt cannot issue a session, KA071), or — when the upload is already terminal or its deadline passed on the server clock — commits the journal with the terminal upload view. A session created by an abandoned attempt was never delivered and is cancelled best-effort. | catalogue shared contract (external calls through recoverable intent/journal boundaries); 10 "Idempotency contract" (intent before external dispatch; pending, rejected or uncertain is reported); 07 (no transaction across an external call); 10 "Provider adapter contract" (prepared intent is durable before dispatch). |
| D-CTRL-1 | Control-plane work runs in SYSTEM units of work bound to the agency of the work item (`kauro.agency_id` set, no user). Bound, it writes that agency's rows only; unbound it only discovers work through the columns granted to it, which never include customer text (display names, worksheet names, header labels). | 08 "Database isolation" (tenant context transaction-local; fail closed); 07 "The sweeper repairs ... stale inspection and overdue deletion". |
| D-CTRL-2 | The control plane appends exactly the events of the edges it owns — completion observed or not observed, admitted, rejected, expired, provider cancellation recorded, a file admitted or its admission revoked, revision ready to seal / rejected / expired, retention record expired — bound to the agency, as a SERVICE actor, of a B07 aggregate kind or `dataset_revision` (policy `domain_events_control_source_lifecycle`). Their event types are one list, `kauro.source_control_event_types()`: the control plane's policy admits exactly it and the request handlers' restrictive policy `domain_events_tenant_not_source_control` refuses it (re-check N2), so no request handler publishes a control-plane fact on a version bump of its own. It never appends `dataset_revision.inspecting.v1` (D-INTAKE-1). A narrow amendment of B06 review R3 (the control plane appended no event) for the source lifecycle only: a new aggregate version cannot commit without its event (D-EVT-1), and these edges have no request. | 07 "A successful command commits state, domain event and outbox record atomically"; 09 "Completion and inspection". Open question Q-B07-13. |
| D-ROLE-2 | The role boundary of the source lifecycle is in the database: request handlers enter only RESERVED, UPLOADING, VERIFYING and CANCELLED uploads and UPLOADING, INSPECTING, SEALED, SUPERSEDED and CANCELLED revisions (restrictive policies); the control plane enters READY_TO_SEAL, REJECTED and EXPIRED revisions — never INSPECTING; request handlers hold column grants on uploads that exclude the provider observation, the inspection fence and outcome and the deadline expiry; they cannot insert receipts, files, tables or evaluations, write the control plane's retention anchors, or create any retention record but the UNPAID one of their own seal (D-ANCH-2); they record neither the provider cancellation result nor an unobserved completion (D-ROLE-3). | 08 "Role and capability model"; B06 D-EVID-1 (evidence is written by its producer, never by the request handlers whose gate it satisfies); catalogue CMD014 failure ("declared size/hash or browser completion alone cannot mark the file ready"). |
| D-ROLE-3 | The provider-session evidence is the control plane's (re-check N2). A request handler's tombstone (CMD015; CMD012 replacing a revision) requests the provider cancellation, but the handler does not write it: the database stamps REQUESTED at the server's instant in the same update when a session was issued (`upload_sessions_cancellation_requested`). The result — CONFIRMED, UNSUPPORTED or UNCERTAIN, and an UNCERTAIN one resolved — and the unobserved completion that reopens a bearer session (completion_not_observed, VERIFYING → UPLOADING, which needs the control plane's negative observation `completion_not_observed_at` in the same update and never follows a recorded observation) are recorded only by the control plane: request handlers hold no column grant on them, and the event types of every control-plane edge (`kauro.source_control_event_types()`, D-CTRL-2) are refused to them by the restrictive policy `domain_events_tenant_not_source_control`. | 09 "Resumable session security" ("The provider cancellation result is recorded. If cancellation cannot be confirmed, the system records SESSION_REVOCATION_PENDING and continues reconciliation until the provider lifetime ends"); R2-051; B06 D-EVID-1; 07 "Outbox, inbox and event ordering". |
| D-PAIR-1 | Tenant-scope pairs are composite keys (re-check N4): an upload's requester is one membership of the agency and the person holding it (`upload_sessions_requester_fk` → `memberships (agency_id, membership_id, user_id)`), and a request handler reserves only as the acting person through their own live OWNER, ADMIN or OPERATOR membership (`upload_sessions_tenant_requester`, as B06 binds an approval to its actor); a retention record's client is its project's client (`retention_records_project_client_fk` → the new key `projects_client_scope (agency_id, client_id, project_id)`; B06 keeps `projects.client_id` immutable). | 07 "Database representation" (composite foreign keys prevent a row of one scope from referencing another's); 08 "Database isolation" ("Foreign keys bind tenant and parent identity"); registry RetentionRecord TenantScope; B06 `approvals_act`. |
| D-LOCK-1 | Lock order: project row → revision row (`FOR NO KEY UPDATE`) → revision transition lock → upload rows → quota ledgers (revision, then agency capacity) → object registry rows → a file's transition lock. A reservation reads its revision under the revision's row lock (the BEFORE INSERT trigger), and the revision lifecycle guard takes the revision's transition lock before it reads any fact (B06's trigger takes the same lock but fires after the guard). A transition in flight makes a reservation wait and read its result; a reservation in flight makes a transition wait and then see it; a guard never decides on a view taken before it waited. A command that changes a revision's intake takes the revision row first (CMD013 before its reservation, CMD015, CMD016, CMD017, CMD012 on the predecessor). | 07 "Transaction discipline" (preconditions rechecked inside the transaction; multi-row invariants use explicit locking; the chosen isolation is documented); B06 D-TX-2. |
| D-LOCK-2 | The control plane follows the same order: a unit of work that changes an upload, a file or the revision — the observation, an admission or rejection, a completion not observed, an expiry, a provider cancellation record, a revocation, an evaluation, a retention expiry — locks the revision row (`FOR NO KEY UPDATE`) first, then the upload, never an upload before its revision. A cancellation (CMD015) and an inspection outcome of one revision therefore serialize on the revision row in either order and neither deadlocks; the triggers that lock an upload (the receipt's current-attempt check, the file's admitting-upload check) re-lock what the unit of work already holds. (B07-F14.) | 07 "Transaction discipline" (the chosen isolation and locking are documented); B06 D-TX-2. |
| D-OBJ-1 | The object registry (`stored_objects`) is a platform machine StoredObject: INTENDED → PRESENT → VERIFIED; INTENDED/PRESENT/VERIFIED → DELETION_REQUESTED → DELETED or DELETION_FAILED → DELETION_REQUESTED. Every row is born INTENDED (a name is reserved before any provider write; an object found by a stat or by inventory is registered and observed in one unit of work). A generation, its length and its digest are set once; a late object is RESIDUAL for good; a provider generation is registered once; rows are never deleted (DELETED is the absence evidence a DeletionReceipt enumerates). Names are opaque — a zone prefix and two to five canonical UUIDs, the zone and the owning agency checked against the row. | 09 "Storage zones and object registry" (every object registered with scope, class, location, opaque name, generation, bytes, hash, creator, state, retention anchor and deletion status; never a filename in a path; generation preconditions; the registry is authoritative for intended objects); 08 (a prefix of one scope never matches another). |
| D-OBJ-2 | The effective soft-delete retention and versioning of every storage location are read back from the provider and recorded (`storage_location_policies`, append-only, evidence class SIMULATED for a contract fake). A deletion cannot be recorded at a location never read back; a deletion the platform performs records, at the server's transaction time, the residual the latest read-back implies (`LOCATION_POLICY`: deletion + retention, NULL when retention is 0), and a generation inventory finds already soft-deleted records the provider's own reported expiry (`PROVIDER_REPORTED`). | 09 "Soft delete, versioning and holds" (the effective setting is verified after provisioning; record the actual expiry rather than claiming the object vanished; a policy change does not shorten retention already applied). Open question Q-B07-12. |
| D-OBJ-3 | Registry rows are not aggregates: `stored_objects` carries no version and publishes no domain event. Its consumer is the deletion inventory (B16), which reads the registry itself; a lost or changed accepted generation reaches the execution consumer and the agency through the SourceFile aggregate it revokes (D-FILE-2). (B07-F9, the StoredObject half.) | 09 "Storage zones and object registry" (the registry is authoritative for intended objects); 07 "Aggregate ownership" (one table per noun is not required); B06 D-VER-1 applies to aggregates. |
| D-FILE-1 | An admitted file is a platform machine SourceFile: born ADMITTED only while its upload is VERIFYING under the current inspection attempt, at the server's transaction time, with the exact accepted generation, digest and length its receipt promoted (composite key to the receipt); ADMITTED → ADMISSION_REVOKED for INTAKE_EXPIRED (a file no seal ever included, once its upload's window closed on the server clock), RETENTION_EXPIRED (a sealed file whose including revisions hold no ACTIVE record ahead, D-RET-3), GENERATION_MISSING or GENERATION_CHANGED (inventory). The revocation takes the file's transition lock and re-checks its reason after it; a seal reads the admission after the same lock. | registry FileManifest ("Only provider-observed bytes and generations may be admitted"; admitted is a derived server decision); 09 "Accepted immutability and sealing". |
| D-FILE-2 | The admitted file is an aggregate (kind `source_file`, D-KIND-1): it carries a version, and its birth and its revocation each commit with their event — `source_file.admitted.v1` and `source_file.admission_revoked.v1` (routed to EXECUTION_CONTROL and NOTIFICATIONS, naming the revisions whose selection or seal named the file, and to AUTHORITY_JOURNAL as a restore tombstone, D-RESTORE-1) — so a READY_TO_SEAL or sealed revision that lost a generation is surfaced. (B07-F9, re-check N5.) | B06 D-VER-1, D-EVT-1; 07 "A successful command commits state, domain event and outbox record atomically"; registry DatasetRevision SEALED effect (revoke execution on stale authority). |
| D-SEL-1 | The selection is a closed document (`SelectionManifestDocument`): every candidate file and table with an explicit disposition (INCLUDE/EXCLUDE with a reason), the parser choice of every included table (CSV dialect and header, worksheet header row, formula policy, hidden rows and columns, merged cells as observed), selected columns (≤ 800), the object projections (row or referenced entity, field ordinals, confirmed keys) and the associations — ids, digests, tokens and positions only, never customer text. | catalogue CMD016 (explicit selected/excluded tables and parser choices; no hidden-sheet silent inclusion); 03 "Source identity" and "Count the correct population"; 04 "XLSX parser requirements"; 09 "Accepted immutability and sealing". |
| D-SEL-2 | The document is stored by an auxiliary, non-journaled, content-idempotent route (`POST /api/v1/revisions/{revisionId}/selection-manifests`: the same body again answers the stored manifest with `created: false`); CMD016 binds it by the reference its catalogue field names. The intake changes no aggregate, so it needs no command journal entry (whose operation is a catalogue id, B06 `command_journal.operation ^CMD[0-9]{3}$`) and no version. | catalogue CMD016 fields (`selectionManifestRef: id`); 10 "Upload and target routes" (selection edits require the revision version — the version is compared by CMD016). Open question Q-B07-10. |
| D-SEL-3 | A selection binds only a settled inventory: no reservation, session or verification of the revision is open, and the revision records the inventory hash (KAURO_SOURCE_INVENTORY_V1 over its uploads, files and detected tables) that the manifest names; a manifest made against another inventory is SELECTION_STALE (the handler compares the hash). Binding a selection always leaves the revision INSPECTING and uncounted; only SELECTION_EVALUATION binds counts. | catalogue CMD016 failure ("Missing or newly changed tables invalidate previous selection"); registry selection_changes ("invalidate selected-scope readiness and recompute affected facts"). |
| D-SEL-4 | The database compares the manifest with the inventory row by row at binding (`kauro.check_selection_inventory`), the backstop a handler cannot skip: every admitted file of the revision's own uploads is disposed; every file named is a file of the project of the origin stated (THIS_REVISION ⇔ admitted from this revision) and an included one is ADMITTED now; at least one file is included; the tables listed are exactly the detected tables of the files named at their current structure hash, every table of an included file disposed. The inventory of an admitted generation is frozen: tables and columns are appended only while the file's upload is VERIFYING (KA071 afterwards). (B07-F11.) | catalogue CMD016 failure; 21 "Evidence classes" (claims name what they prove); 07 "application checks cannot be the sole protection". |
| D-SEAL-1 | A sealed manifest and its file set are the record of the seal that writes them (re-check N1): the manifest records the server's transaction time as its seal instant (`sealed_manifests_server_clock`), and at COMMIT the revision of every sealed manifest and sealed file row has entered SEALED in the same transaction at exactly that instant (`sealed_manifests_bound`, `sealed_revision_files_bound`, the pattern of `retention_anchors_bound`); the seal's facts on the revision (seal instant, manifest and projection hashes, sealed counts) are written only by seal_command. The readers count only real seals (`kauro.is_real_seal`: a revision that went through SEALED at its manifest's instant — SUPERSEDED, EXPIRED and DELETED keep it): the revocation guard's "was sealed" (INTAKE_EXPIRED) and "retained by" (RETENTION_EXPIRED), and the first seal of the bytes (D-RET-3). A row a request handler adds later, or to a revision that is not sealing, never commits, so it can neither keep bytes admitted past their window nor move their first-seal clock. | B06 D-EVID-1 and D-ANCH-2 (evidence is bound at COMMIT to the transition it records); 09 "Retention schedule" (incomplete upload: 24 h from initiation; unpaid sources: no later than fourteen days from sealing); HASHING "Retention formulas" (abandoned unsealed data follows its own cleanup; nothing resets a hard clock); 07 "Transaction discipline" (application checks cannot be the sole protection). |
| D-REV-1 | Lineage stays inside the project: a predecessor is a revision of the same project (`dataset_revisions_lineage_in_project`), a superseded revision names the successor that names it (deferred `dataset_revisions_successor_fk`), a predecessor is replaced at most once (`dataset_revisions_supersedes_once`), and the project's current revision is one of its own (deferred `projects_current_revision_in_project_fk`). CMD012 requires `supersedesRevisionId` to be the project's current revision, so lineage is linear. | registry DatasetRevision ("Sealing is immutable; replacement creates lineage and invalidates dependent authority"; supersedesRevisionId "Explicit predecessor, never an in-place overwrite"); 10 "Client and project routes" (no in-place edit of sealed source bytes). |
| D-REV-2 | A project holds at most one mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL; partial unique index). CMD012 replacing a mutable predecessor cancels it (cancel_revision) together with its uploads in flight; replacing a SEALED one supersedes it. | registry DatasetRevision cancel_revision and new_revision_explicitly_supersedes; 07 "Transaction discipline". |
| D-RET-1 | Unsealed intake data follows its upload's window: an admitted file that no seal ever included expires with its upload at the application deadline (upload ADMITTED → EXPIRED, file revoked INTAKE_EXPIRED, objects deleted); a REJECTED revision expires once every intake window of it closed on the server clock. Sealing moves the data under the retention of the sealed bytes (D-RET-3). | HASHING "Retention formulas" ("abandoned unsealed upload data follows its independent session/inspection cleanup policy rather than waiting forever for a seal"); 09 "Retention schedule" (incomplete upload and quarantine: twenty-four hours from initiation); registry REJECTED retention_expires ("Rejected-input cleanup deadline"). Open question Q-B07-11. |
| D-RET-2 | RetentionRecord is a platform machine (ACTIVE → EXPIRED, ACTIVE/EXPIRED → DELETING → DELETED or DELETED_WITH_RESIDUALS). SealRevision creates the UNPAID record: hard deadline = the bytes' first seal + 1,209,600 s (fourteen exact days, D-RET-3), effective deadline = the hard deadline until the audit package sets the soft deadline (only earlier). The hard deadline never moves; a record expires no earlier than its effective deadline, at the server's transaction time; a sealed revision expires only when no governing record is ACTIVE with a later effective deadline than the server clock. | 09 "Retention schedule" (unpaid audit sources: seven days after DRAFT_READY or terminal failure, no later than fourteen days from sealing); registry RetentionRecord ("The effective deadline is a minimum of named anchors; retries do not extend it"); policy `retention.unpaidDaysHardFromSeal`, `retention.extendHardCap = false`; HASHING (a day is an exact 86,400-second duration). |
| D-RET-3 | The unpaid hard cap belongs to the bytes, not to each seal: the UNPAID record of a seal is anchored on the REVISION_SEALED anchor of the first seal that ever included any of its included files (this seal for new bytes, an earlier revision's for reused ones), with hard deadline = that first seal + fourteen days — checked at COMMIT (`dataset_revisions_sealed_subject`). A seal whose bytes' window already closed is refused (the record would be born expired): reuse after the window needs a new upload. The retention sweeper revokes the admission of a sealed file once no including revision holds an ACTIVE record ahead (RETENTION_EXPIRED), so a SUPERSEDED revision, which never expires itself, does not keep the bytes admitted and reusable. (B07-F5.) | 09 "Retention schedule" (no later than fourteen days from sealing); 09 "Quotes, reuploads and retention" (a new revision is "a new authority chain, not restoration"; extensions "never beyond the original hard cap"); HASHING "Retention formulas" ("Extensions never ... revive an expired source or reset a hard clock"); registry previously_admitted_inputs_selected ("immutable generations still exist"). Open question Q-B07-20. |
| D-ANCH-1 | Retention anchor kinds are rows of `kauro.retention_anchor_kinds` (a table, not a CHECK list), so later packages add AUDIT_READY, CAPTURE_CONFIRMED, … without rewriting 0012 — the pattern of the foundation's aggregate-kind registry. | 07 "Outbox, inbox and event ordering" (registered vocabularies); FOUNDATION-aggregate-kinds.md D-AGGK-1. |
| D-ANCH-2 | Retention evidence is written by its producer and bound to the transition it records: the request handlers write UPLOAD_INITIATED, INTAKE_CANCELLED and REVISION_SEALED; the control plane INPUT_ADMITTED, INTAKE_REJECTED and INTAKE_EXPIRED (row policies per role and kind). An anchor records the server's transaction time and, at COMMIT, its subject must have taken that transition in the same transaction (the stamp equals the anchor's instant; `retention_anchors_bound`). The request handlers insert only the UNPAID record of the seal they commit — no soft deadline, effective = hard = a REVISION_SEALED anchor of the project + fourteen days, for a revision whose own seal anchor is this transaction's; every other class belongs to its producer (the audit, payment, delivery and deletion packages). (B07-F3.) | B06 D-EVID-1 (evidence is written by its producer, never by the request handlers whose gate it satisfies); policy `retention.extendHardCap = false`; 09 "Retention schedule"; HASHING "Retention formulas". |
| D-HASH-1 | The manifest hash is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage (amendment A2 of KAVO_SOURCE_REVISION_V1): the ordered accepted files (ids, generations, hashes, lengths), the table selection, the parser profile and the projection — no revision id, no population, no mutable upload state; `sealed_manifests.manifest` admits exactly these four members (CHECK). Two seals of identical bytes still have distinct manifest hashes, as B06's unique source hash requires, because the projection carries the ProjectionIds each seal mints (SourceLocator.projectionId). (B07-F12; replaces the former revision-bound preimage.) | HASHING "Hash domain separation" (exact payload and excluded envelope); BRAND_AMENDMENT_A2 rule 2 (one-to-one rename, same semantics); registry SourceLocator.projectionId ("Declared object projection within the physical row"). Open question Q-B07-18. |
| D-HASH-2 | Platform digest domains for what the authority names no domain for, in the same `{domain, version, payload}` wrapper: KAURO_SOURCE_SELECTION_V1, KAURO_SOURCE_PROJECTION_V1, KAURO_SOURCE_INVENTORY_V1, KAURO_SOURCE_TABLE_V1, KAURO_PARSER_PROFILE_V1. | HASHING (every structured digest uses a named domain and version); B06 D-IDEM-1 (KAURO_COMMAND_REQUEST_V1). |
| D-HASH-3 | Evidence digests: KAURO_INSPECTION_RECEIPT_V1, KAURO_SELECTION_EVALUATION_V1, KAURO_RETENTION_ANCHOR_V1 (over the anchor's exact server instant), KAURO_AUTHORITY_TOMBSTONE_V1. | as D-HASH-2. |
| D-HASH-4 | The sealed subject — the revision, its predecessor, the manifest, projection, selection and evaluation hashes, the frozen populations with the per-table and per-projection counts, the admitting receipts, the uploads inspection rejected and the input envelope — is its own document (`sealed_manifests.subject`) under the platform domain KAURO_SOURCE_SEALED_SUBJECT_V1 (`subject_hash`, unique per agency; served as `sealedSubjectHash`). It binds the manifest to the revision: identical bytes sealed in two revisions are two subjects. (B07-F12.) | 09 "Quotes, reuploads and retention" ("a new authority chain, not restoration"); HASHING "Hash domain separation" (a domain per authority class). |
| D-SCAN-1 | The scan state is derived by the domain (`evaluateScanCoverage`) from what the scanner reports per expected part — the container at the object's observed length and every allowed part the bounded preflight expanded, with their verified lengths; the engine's exit code and verdict are recorded as evidence and never decide. COVERED_CLEAN needs exactly one CONTAINER part whose length is the observed length, every expected part and byte scanned by a pinned configuration with fresh signatures published before the scan; a skip, a short read, a limit, a timeout or an expected set that is not the object's is NOT_SCANNED (INCOMPLETE_SCAN, CONTAINER_NOT_COVERED), a detection BLOCKED. The database repeats the rule against the receipt's own coverage document (`kauro.scan_coverage_complete`, `inspection_receipts_clean_means_covered`). (B07-F4.) | 09 "Scanner coverage" (a zero exit code alone is not admission evidence; expected parts and bytes are compared to actual coverage; demonstrate coverage for every admitted container; splitting into chunks is not equivalent; incomplete coverage is rejection, not "clean with warning"); S054; 21 (a scanner skip labelled clean must be detected). |
| D-SCAN-2 | Signatures older than 86,400 s at scan time are stale (STALE_SIGNATURES, NOT_SCANNED). The age is pinned, never chosen per scan: the domain uses `SIGNATURE_MAX_AGE_SECONDS`, and the database admits only 86,400 as a receipt's recorded maximum age. (B07-F4.) | 09 ("stale signatures beyond the recorded policy block new admission"); the registry records no value — open question Q-B07-3. |
| D-INSP-1 | UPLOAD_INSPECTION runs, under one attempt fence: observe the object (stat) → record the observation → read the exact generation, recomputing SHA-256 → bounded container inspection (D-ISO-1) → scan coverage → promotion (copy with a generation precondition, re-read and compare the digest) → one receipt → admit or reject. It never moves the revision (D-INTAKE-1). | 09 "Completion and inspection", "Scanner coverage", "Accepted immutability and sealing"; 04 inspectContainer. |
| D-INSP-2 | The inspection fence: an attempt claims `inspection_fence + 1` while the upload is VERIFYING; a receipt is accepted only from the current attempt of a VERIFYING upload and only if it describes the recorded observation (KA071, KA072); one receipt per attempt. A cancellation that won the upload row leaves a stale attempt nothing to attach. | catalogue CMD015 ("cancellation remains valid while verification races"; "late finalization cannot resurrect the cancelled file"); 07 "Job and attempt states" (fences). |
| D-INSP-3 | Rejection classes: the nine of 09 (UNSUPPORTED_FORMAT, CORRUPT_STRUCTURE, ACTIVE_CONTENT, DETECTED_MALWARE, INCOMPLETE_SCAN, STALE_SIGNATURES, RESOURCE_LIMIT, TRANSIENT_INFRASTRUCTURE, CANCELLED_AUTHORITY) plus FORMAT_MISMATCH, CLAIM_MISMATCH, SIZE_EXCEEDS_RESERVATION, EMPTY_OBJECT and PROMOTION_UNVERIFIED. Only TRANSIENT_INFRASTRUCTURE retries, inside the deadline. | 09 "Completion and inspection" (the precise classes; only genuinely transient failures retry within the original deadline). |
| D-INSP-4 | The receipt's instants are bounded by the server's (re-check N3, D-CLOCK-1): claiming an attempt (the fence advance) is stamped by the database at the server's instant (`upload_sessions.inspection_claimed_at`, `upload_sessions_attempt_claimed`; no role writes it); a receipt of that attempt starts exactly at the claim, scans no earlier than the provider observation and within the attempt, completes no later than the server clock and is recorded at the server's transaction time (`inspection_receipts_current_attempt`, KA072). The pinned signature age (D-SCAN-2) is therefore measured at an instant between two server instants of the attempt — never at one set back to before the upload existed. The worker reads its scan instant from the database clock (`SourceUnitOfWork.serverInstant()`). | 09 "Scanner coverage" ("Stale signatures beyond the recorded policy block new admission"); S054; D-CLOCK-1. |
| D-ISO-1 | The container inspection runs isolated, with observers that work on every verify host: `@kauro/data-plane` starts a child process under the Node permission model (`node --permission`, `--allow-fs-read` = the attempt input and the inspector's code, `--allow-fs-write` = the attempt scratch; no child processes, workers, addons or WASI), so any write outside the scratch is refused by Node (ERR_ACCESS_DENIED) and counted; a preload module replaces every network entry point (net/tls connections, dgram, dns, http(s), fetch, WebSocket) by a recording refusal, because Node 24's permission model does not govern the network. The result carries `InspectionIsolation` (outside-write, network and process attempts, bytes decompressed). The tests prove the observers with negative controls: a probe that writes outside the scratch is refused and counted, a probe that connects is recorded and refused. The OS-level egress denial of the worker host (network namespace, firewall) is not observable on the Windows verify host and is LATER: B15 (EXECUTED_PROVIDER); nothing here claims it. (B07-F6.) | S024 ("Reject without outside writes, network access or unbounded decompression"); 09 "Scanner coverage" (restricted environment without customer-triggered network fetching); 09 "Derived data and worker scratch" (each attempt owns a scratch; cleanup targets only that scope); 21 evidence rule (independent truth, meaningful negative control). |
| D-DP-1 | (Mandate B07-DATA-PLANE.) The archive and runtime bounds the registry names but does not number: at most 4,000 archive entries (a coverage document holds at most 4,096 parts, the container included); a part that expands beyond 1 MiB at most 250 times its compressed size (deflate's ceiling is about 1,032; spreadsheet XML compresses 5–100 times); XML nesting at most 64 elements (SpreadsheetML needs about ten); one markup token at most the larger of 64 KiB and the decoded-cell bound; a central directory of at most 16 MiB; at most 100,000 inventory columns per file; ten minutes of wall clock and a 512 MiB V8 heap per isolated child, which gets an empty environment, the scratch as its working directory, `--disallow-code-generation-from-strings`, and read access to its own scratch besides the attempt input and this package's code (the spilled keys and the shared-string index are read back; nothing outside the scratch is writable). The registry's envelope (2e9 bytes per file, 1 GiB per expanded part, 20 GiB of cumulative expansion, 1 MiB per decoded cell, 8 MiB per record — a CSV record, and a worksheet row across its values and formula texts — 800 selected columns) is used as is (`inspectionLimits()` reads `INPUT_ENVELOPE`). Expansion is bounded twice: on the central directory's declared sizes before a byte is decompressed (PART_EXPANSION_LIMIT, TOTAL_EXPANSION_LIMIT, COMPRESSION_RATIO_LIMIT), and on the bytes actually produced — a part stops at the smaller of its declared size and the part bound, the ratio is measured on the compressed bytes consumed, length and CRC-32 must equal the directory's — and the counter counts only the bytes delivered to the inspection, so `InspectionIsolation.decompressedBytes` never exceeds the bound. | 04 "XLSX parser requirements" (entry count, per-entry size, cumulative expanded bytes, compression ratio, XML depth and time limits; ZIP64 is supported only within the envelope and does not waive limits); 09 "Initial intake envelope" (conjunctive limits); S024. |
| D-DP-2 | (Mandate B07-DATA-PLANE.) Hostile structure and active content are refused with a precise class and token, never ignored. Before any expansion: traversal, absolute, backslash, empty-segment and Windows-aliasing names, names colliding after NFC and case folding (DUPLICATE_ENTRY), a file that is also a directory prefix, a symlink, a Unicode-path extra field, multi-disk archives, encryption (ACTIVE_CONTENT), a compression method other than stored or deflate, local headers or data descriptors that disagree with the central directory, and a layout that is not contiguous from offset 0 to the central directory (prefix data, gaps, overlapping entries). During the parse: any DTD or markup declaration is ACTIVE_CONTENT (XML_DTD) and an entity other than the five predefined ones is CORRUPT_STRUCTURE (XML_UNDEFINED_ENTITY), so no entity is ever defined, expanded or fetched; active parts by name (VBA project, embeddings, ActiveX, external links, connections, query tables, macro and dialog sheets, custom UI), macro-enabled content types, embedded-object references in a sheet and every external relationship are ACTIVE_CONTENT, except a worksheet hyperlink, which is inert metadata never followed and disclosed on its table (EXTERNAL_HYPERLINKS); an internal relationship target that leaves the package root is CORRUPT_STRUCTURE. Several findings: CORRUPT_STRUCTURE before ACTIVE_CONTENT before RESOURCE_LIMIT before UNSUPPORTED_FORMAT. The detected format is the bytes' (ZIP magic: the OOXML inspection; a compound file — a legacy or encrypted workbook — UNSUPPORTED_FORMAT; anything else: the CSV inspection), never the declaration's. A problem names a part by the SHA-256 of its normalized path, never the path or a value. An isolation observer that fires in a production run refuses the file (ISOLATION_VIOLATION_OBSERVED, ACTIVE_CONTENT): a clean inspection never tries a write outside its scratch, a connection or a process. | 04 "XLSX parser requirements" (reject traversal paths, absolute paths, duplicate normalized names, symlinks, path collisions and inconsistent archive metadata; XXE and DTD processing disabled; external links, macros, OLE objects and encryption are not executed or transparently ignored as harmless — the inspection policy identifies the precise rejection); 09 "Completion and inspection" (declared versus detected format; precise failure classes); 10 "Responses and safe errors"; S024. |
| D-DP-3 | (Mandate B07-DATA-PLANE.) The inventory. A worksheet's used range spans the rows from the first to the last row holding a value or a formula and the columns from A to the rightmost such cell (positional ordinals count from column A, so a column's identity never depends on its label); the header candidate is the used range's first row; `rowEstimate` is the used range's row count; hidden rows are the span's rows marked hidden or, under a zero-height default, absent; hidden columns are those declared hidden within the span; formulas are reported with their cache state (EXTERNAL_DEPENDENCY before ERROR_VALUES before SOME_MISSING). A label is shown only in a safe display form (control characters replaced by U+FFFD, cut at 200 UTF-16 units: DISPLAY_TRUNCATED); labels colliding after NFKC, trimming, whitespace folding and case folding are DUPLICATE_LABEL. Shared strings are never one global array: the inventory resolves only the header cells it shows, the counting pass writes a disk-backed index into the attempt scratch. A CSV's encoding is decided by the byte-order mark, else by UTF-8 validity, else Windows-1252 (ENCODING_AMBIGUOUS when a byte 0x80–0x9F makes it differ from Latin-1); a NUL outside UTF-16 is refused. Its delimiter is the one candidate among comma, semicolon, tab and pipe whose records of a 1 MiB sample all have one width of at least two (several: DELIMITER_AMBIGUOUS, reported with the first in that fixed order, never the widest; none: DELIMITER_INCONSISTENT); every record of the file is then tokenized to the end, so a limit or an unclosed quote anywhere is found. The expected scan parts are the container at the length read, identified by its SHA-256, and every file entry of an admissible archive at its verified expanded length. | 04 "CSV parser requirements" (delimiter discovery reports ambiguity rather than the interpretation with the most columns; invalid bytes never become replacement characters silently), "XLSX parser requirements" (bounded shared-string index; far-away coordinates allocate nothing; hidden worksheets remain in the inventory; hidden rows and columns disclosed; merged cells as observed); 03 "Source identity" (positional headers; duplicate, empty, Unicode-equivalent and whitespace-only-different labels surfaced); 09 "Scanner coverage". |
| D-DP-4 | (Mandate B07-DATA-PLANE.) The counting pass. A worksheet's physical rows are the used-range rows after the chosen header row up to the last row holding a value or a formula — rows written empty and rows absent between value rows included (the grid's row positions, so a logical row ordinal is positional), a hidden row excluded and counted as excluded when the choice excludes hidden rows; a CSV's are its records after the header record (FIRST_RECORD) or all of them (NONE), blank lines counted or skipped as chosen, a quoted record spanning lines one record. ROW: each physical row is one occurrence; REFERENCED_ENTITY: the distinct non-empty confirmed key tuples (exact string equality; in memory up to a budget, then partitioned to the attempt scratch by a routing hash with exact comparison) plus each row whose key is empty but whose field group is not (an unkeyed occurrence stays a distinct candidate); an association edge per physical row whose target key is present, before any deduplication; billable units under R2-INITIAL are the logical records of every declared projection. Formulas are inert: under USE_PRESENT_CACHED_VALUES_WITH_DISCLOSURE the stored cache is the value and a counted formula without a cache, with an error cache or with an external dependency fails its table; REJECT_FORMULAS fails a counted formula; NOT_PRESENT fails any. A counted cell is one of a counted row, in a selected column, outside an excluded hidden column; only counted cells feed a projection, and a projection whose key or fields name a column the choice excludes as hidden fails its table PROJECTION_COLUMN_HIDDEN (B07-R3, §19: the hidden columns are known only from the worksheet part, so the counting pass refuses it). The manifest is re-checked against the files it is evaluated over (an included file admitted, a parser of the table's kind, a hidden worksheet acknowledged, columns in range and within 800, projection columns selected, a confirmed key, ROW → REFERENCED_ENTITY associations within one table, the file and byte envelope): a violation is ADMISSION_FAILED before a byte is parsed; bytes that are not the admitted generation's digest and length, or an unknown pricing definition, are ERROR; edges beyond the association ceiling are ADMISSION_FAILED. | 03 "Count the correct population" (empty-but-structurally-present rows according to parser policy; referenced-entity projection with a confirmed key; edges before deduplication; the association ceiling blocks admission); 04 "Facts used as proof must be exact", "Full-data profile and exact indexes" (bounded algorithms with spills; hashes only as grouping accelerators with exact equality), "XLSX parser requirements" (formula text is inert; missing caches, error caches and external dependencies are unresolved or rejected); §12.2. |
| D-DP-5 | (Mandate B07-DATA-PLANE.) The preview (D-SAPI-7) shows the table's own top rows — a worksheet's used-range rows from the first row holding a value (empty rows as empty rows), a CSV's records from the first — so the agency sees the header candidates it chooses among; a cell is its stored text (a shared or inline string, the stored number or boolean text, a formula's cached value; without a cache the cell is empty); the reader re-verifies the admitted digest and length, parses in the isolated child and stops once the window is full. | 10 "Upload and target routes" (a bounded authorized sample with safe display escaping); D-SAPI-7. |
| D-DP-6 | (Mandate B07-DATA-PLANE.) The labelled scanner fake (`ContractFakeMalwareScanner`, `@kauro/data-plane/testing`, SIMULATED, `contract-fake-*` engine, version and signature tokens in every report and call record) models the engine's hazards under its pinned limits — a part above MaxFileSize is SKIPPED_SIZE_LIMIT, a spent MaxScanSize leaves a partially read "clean" part and SKIPPED_SCAN_LIMIT after it, both with exit code 0 and verdict CLEAN — and, as scripted, timeouts, encrypted and failing parts, signatures at an age before the scan and configuration drift; it reads the container's bytes and matches the EICAR test token (assembled at run time, never stored in a file) across chunks; its limits are part of its pinned configuration digest; it reads the scan instant from the clock the caller binds, after the bytes (D-INSP-4). The data-plane tests bind that clock to a real PostgreSQL 17 cluster they start themselves (`initdb`, `pg_ctl`, `psql`; `transaction_timestamp()`, the body of the shipped `kauro.server_now()`), because an adapter may not import `@kauro/persistence` (architecture.rules.json); no dependency is added. | 21 "Evidence classes" (SIMULATED is never EXECUTED_PROVIDER); 09 "Scanner coverage" (a zero exit code alone is not admission evidence; the test list with the EICAR pattern); D-INSP-4; §15 (one owner per fake). |
| D-RESTORE-1 | Terminal authority facts — upload acceptance revoked (cancelled, expired, rejected), revision cancelled, superseded, rejected, expired, deleted, and a file's admission revoked (FILE_ADMISSION_REVOKED, state ADMISSION_REVOKED — the SourceFile machine's own terminal state, D-RESTORE-2: its retention ended, its unsealed intake window closed, or its generation was lost or changed) — are appended as minimal tombstones to an external journal (`AuthorityJournalPort`, idempotent by event) by the AUTHORITY_JOURNAL consumer, one closed kind and terminal state per routed event (`AUTHORITY_TOMBSTONES`, tested equal to the routing); restore reconciliation applies them in sequence order before traffic resumes. The consumer verifies the subject before the effect: it appends a tombstone only when the subject's current state is the terminal state the tombstone names (07 "consumers ... verify state before an effect"); a routed event whose subject is not in that state is dead-lettered as an integrity incident. (B07-F8, re-check N5.) | 09 "Deletion receipts and restoration" (tombstones survive separately; restoration applies them first; must not re-enable deleted data); 14 (restore); registry SEALED → EXPIRED effect ("Revoke reads/execution"). |
| D-RESTORE-2 | (Implementation, mandate B07-PROVIDER-FAKES; closes residual FINAL-N1 of the final re-check.) A tombstone names the state exactly as the subject's own machine names it: FILE_ADMISSION_REVOKED carries `ADMISSION_REVOKED`, the SourceFile machine's terminal state and the only state `source_files` records for a revoked admission — the design's `REVOKED` was no SourceFile state, so the consumer rule of D-RESTORE-1 would have dead-lettered every file tombstone. `AuthorityTombstoneState` and `AUTHORITY_TOMBSTONES` (`packages/application/src/ports/source-providers.ts`) name it; the B07-F8 test derives every routed event's state from its subject's machine (UploadSession, DatasetRevision, SourceFile) instead of a literal set — a state the machine enters, from which every reachable state is itself a tombstoned state of that subject, every terminal state of the machine tombstoned — and with the former pair restored both it ("REVOKED is a state SourceFile enters") and the N5 test fail (revert proof, run when the fix was made); the labelled journal fake refuses any pair `AUTHORITY_TOMBSTONES` does not name. | 09 "Deletion receipts and restoration" (restoration applies tombstones and current revocation facts before traffic; a restore must not recreate source data); 07 (consumers verify state before an effect); machines.ts SourceFile (terminal `ADMISSION_REVOKED`); residual FINAL-N1 (fix option 1). |
| D-FAKE-1 | (Implementation, mandate B07-PROVIDER-FAKES.) The labelled contract fakes of `@kauro/application/testing` — `ContractFakeObjectStorage` (provider token `contract-fake-storage`, the token the persistence fixture already records), `ContractFakeSessionVault` (`contract-fake-vault`, key ref `contract-fake-vault/aes-256-gcm/test-key-1`) and `ContractFakeAuthorityJournal` (`contract-fake-journal`) — each report `evidenceClass: "SIMULATED"` and fix what the stage-2 mandates consume: the storage fake runs on an injected provider clock (never a platform instant, D-CLOCK-1), answers a finalized browser session with the completion reference its `parseCompletionClaim` reads (`completionRefOf` builds a forged one for S053), keeps a session usable until its horizon unless a cancellation took effect (an UNCERTAIN answer states separately whether it did), scripts faults (UNAVAILABLE before any effect; TIMEOUT with or without the effect) and hold points, and never logs a bearer reference (its SHA-256 only); the vault's associated data is the canonical {purpose, key ref, agency, upload, requester, attempt}; the journal is a JSON-lines file appended and never rewritten, answers ALREADY_PRESENT to a replay and refuses CONFLICT to a divergent replay or a reused sequence, refuses INVALID_TOMBSTONE when the evidence hash is not the KAURO_AUTHORITY_TOMBSTONE_V1 digest (`authorityTombstoneHashOf`) of the other eight members, and lists per agency in sequence order. No composition root binds any of them (architecture rule `testOnlySubpaths`; the subpath test scans every production source). | 21 "Evidence classes" (a contract fake is SIMULATED, never EXECUTED_PROVIDER); 09 "Resumable session security", "Soft delete, versioning and holds", "Deletion receipts and restoration"; design §2, §15. |
| D-STAGE1-1 | (The `b07/stage-1` integrator.) The three stage-1 mandates, built in parallel worktrees, merge as one implementation. The source-lifecycle fixture of `@kauro/persistence/testing` records the tokens the labelled fakes and the real parsers report — `contract-fake-storage`, `contract-fake-malware-scanner` with `contract-fake-malware-scanner-1.0.0` and `contract-fake-signatures-1`, `kauro-container-inspector-1.0.0`, `kauro-selection-evaluator-1.0.0` (exported as `FIXTURE_*`) — instead of the design's placeholders (`contract-fake-scanner`, `SIMULATED-1`, `SIG-FIXTURE`, `data-plane-0.1.0`), which no fake or parser emits; the persistence package may not import the data plane (`architecture.rules.json`), so `tools/test/b07-stage-one.test.mjs` pins the fixture's tokens to the owners' exports. The same test keeps one owner per fake: each provider port (`ObjectStoragePort`, `SessionVaultPort`, `AuthorityJournalPort`, `MalwareScannerPort`) is implemented by exactly one class in the whole tree, its owner's labelled fake, and the only `ContractFake*` exports are the four fakes on their owners' test-only subpaths — a stage-2 test binds them and creates none. `packages/data-plane/test/stage-one-composition.test.ts` binds the storage fake, the real inspector and preview reader and the scanner fake through their ports as UPLOAD_INSPECTION will (§12.1), so a mismatch between the parallel mandates surfaces before stage 2. The domain and migration tests keep their own synthetic tokens: they write rows directly and claim no fake. | design §15 ("Every provider fake has exactly one owner"; the integrator merges the stage and runs `pnpm run verify` there); 21 "Evidence classes" (every claim names its class and producer); D-FAKE-1, D-DP-6. |
| D-SRC-1 | CMD013 requires an ACTIVE agency, an OPEN project and the project's mode still offered; CMD012 requires the agency DRAFT or ACTIVE and the project OPEN. | B06 D-CMD-2 ("uploads and execution require ACTIVE"); 07 (DRAFT permits no customer-data execution); 09 "Upload reservation" (checks project capability). Open question Q-B07-16. |
| D-SRC-2 | CompleteUpload and CancelUpload act only on the caller's own upload (UPLOAD_NOT_OWNED otherwise); an abandoned upload of another member is tombstoned by the deadline sweeper. CMD012 cancels a replaced revision's uploads whoever requested them. | catalogue CMD014 ("the upload belongs to the caller"), CMD015 ("the operation belongs to the caller"). Open question Q-B07-6. |
| D-SAPI-1 | The source reads (revision, inspection, uploads, upload, selection manifest, preview) need a live ACTIVE membership in the selected agency (AGENCY_READER); the selection intake and the session read follow the commands' role (AGENCY_OPERATOR); every route is scope AGENCY_HEADER (B06 D-SCOPE-1). | 10 "Upload and target routes"; B06 D-READ-1, D-AUTHZ-1. |
| D-SAPI-2 | `providerCompletionRef` (registry type `text`) is 1..4,096 characters with the label control-character rule. | registry field vocabulary; B06 D-LABEL-1. |
| D-SAPI-3 | The ACCEPTED answer of CompleteUpload advises polling after 5 s. | 10 (allowed polling guidance). |
| D-SAPI-4 | `declaredFormat` (registry type `label`) is narrowed to the supported formats CSV and XLSX, as B06 narrows CMD011 `mode`. | registry FileManifest.format; B06 request schemas. Open question Q-B07-14. |
| D-SAPI-5 | CompleteUpload is idempotent by upload and claim: the same claim on a VERIFYING upload answers the same 202 without a new effect; another claim is COMPLETION_CLAIM_CONFLICT. | 09 ("CompleteUpload is idempotent by upload ID and observed generation"; duplicate completion is a qualification case). |
| D-SAPI-6 | Until an object-storage adapter is bound, a command that needs it answers INTEGRITY_FAILURE / SOURCE_SERVICES_UNAVAILABLE; a deployment binds no fake. | 21 "Evidence classes" (a contract fake is SIMULATED, never EXECUTED_PROVIDER); B06 I-INT-2. |
| D-SAPI-7 | The preview route returns at most 20 rows of at most 50 columns, each cell at most 200 characters of decoded text the UI escapes, only to the agency's members, never cached (Cache-Control no-store, B06 E-CACHE-1) or logged. | 10 "Upload and target routes" (a bounded authorized sample with safe display escaping and no shared caching). Open question Q-B07-9. |
| D-API-1 | The specified B07 routes are documented now, as `x-kauro-planned` operations of `apps/api/openapi.json` (keyed "METHOD path") generated from the same request schemas, planned reply envelopes (`buildSourceResponseSchemas`) and outcome catalogues; the check refuses a planned route that is registered or also served, a repeated operationId and a forbidden member, and a specified route missing from the document fails the generated-document comparison. B09 plans its payment routes with the same mechanism (one copy at integration, §17). The sweepers of §12.5 are one list in the contracts (`SOURCE_SWEEPERS`), tested equal to §12.5. (B07-F13.) Mandate B07-COMMANDS served every B07 route: they moved from `x-kauro-planned` to `paths`, and the planned block is empty until another package plans routes (D-CMD-11). | 10 "OpenAPI is generated from the owning contract registry and checked against actual routes" (a planned route is not an actual route); engineering rules (the openapi and matrix checks in verify cover the new routes); D-OBJ-2 (LOCATION_POLICY is load-bearing). |
| D-EXP-1 | Nothing expires early, on the server clock (D-CLOCK-1): an upload expires no earlier than its application deadline, a retention record no earlier than its effective deadline, a revision only when no governing record is ahead, an intake revocation only after its window closed; a CHECK never passes on a missing member (every B07 CHECK is written NULL-safe; tests prove the refusals). | 09 "Upload reservation" (twenty-four hours from initiation); registry RetentionRecord; 07 (application checks cannot be the sole protection). |
| D-PERS-1 | (B07-PERSISTENCE) The source adapters read every instant back exactly as the database stored it — an ISO-8601 UTC string with microseconds formatted by the database — never through a JavaScript Date, which keeps milliseconds. The guards compare instants for equality (a receipt's start with its attempt's claim, D-INSP-4; an anchor with its transition and the digest over that instant, D-ANCH-2, D-HASH-3; a deletion with the read-back that governs it, D-OBJ-2; a list cursor with its row), so a caller must feed an instant back exactly as read. A view that carries manual 10's millisecond utc primitive truncates it (`toUtcInstant(Date.parse(instant))`); B06's adapters keep their millisecond records. | D-CLOCK-1; 10 "Schema format execution" (the utc primitive is the wire's, not the store's); 07 "Transaction discipline". |
| D-PERS-2 | (B07-PERSISTENCE) A SYSTEM unit of work's source store reads as the control plane and names no column it holds no grant on (display names, worksheet names, header labels). `UploadSessionRecord.displayName` therefore becomes optional — present on every request-handler read, absent on a control-plane read — as `SourceTableRecord.nameDisplay` and `SourceColumnRecord.labelDisplay` already were. A SYSTEM context binds only a UUIDv7 agency id (INTEGRITY_FAILURE otherwise), and B06's `run` binds it too. | D-CTRL-1; 0009/0010 column grants; 08 "Database isolation". |
| D-PERS-3 | (B07-PERSISTENCE; re-check residual FINAL-N2) retention_expires records its reason only for a revision without a terminal reason (SEALED → EXPIRED); from REJECTED the rejection's reason stays (`terminal_reason = coalesce(terminal_reason, reason)`), since a revision's terminal facts are set once (KA004). The residual's first option; migration 0011 unchanged; the port documents it; `source-adapters.test.ts` "FINAL-N2: …" shows REJECTED → EXPIRED commits once every intake window closed, is refused while one is open, and a re-explained reason is refused KA004. | Registry DatasetRevision REJECTED → EXPIRED (retention_expires, "Rejected-input cleanup deadline is reached"); D-RET-1; D-CLOCK-1 (terminal facts set once). |
| D-PERS-4 | (B07-PERSISTENCE) `StoredObjectRepository.requestDeletion` refuses an ACCEPTED generation whose file's admission still stands — retained by a seal's record or by its intake window — and requests the others idempotently; the admission is revoked first (INTAKE_EXPIRED, RETENTION_EXPIRED, GENERATION_*), never deleted from under it. The port named "a VERIFIED object retained by a sealed revision" and cited a design section that no longer exists; a standing admission is what retains the bytes (D-FILE-1, D-RET-1, D-RET-3). | 09 "Retention schedule"; 09 "Deletion receipts and restoration"; D-FILE-1, D-RET-3. |
| D-PERS-5 | (B07-PERSISTENCE) The refusal translation of §3.3 is one table of constraint names with their SQLSTATE (`SOURCE_CONSTRAINT_FAILURES` in `sqlstate.ts`); UPLOAD_CONCURRENCY_LIMITED is retryable (a slot frees when a live session ends). It adds the two deadline CHECKs a writer on the wrong side of the server clock meets — `retention_records_expiry_not_early`, `upload_sessions_expiry_not_early` — as INTEGRITY_FAILURE / LIFECYCLE_BINDING_MISSING, the class of KA072 (D-EXP-1). | D-SQL-1; §3.3; B06 D-ERR-1..3. |
| D-PERS-6 | (B07-PERSISTENCE) No caller instant reaches a stamp: every recording instant is `kauro.server_now()` in SQL, and the caller instants some ports still carry (`NewStoredObject.createdAt` and `observed.observedAt`, the `at` of `verify`, `requestDeletion` and `retryDeletion`, `insertSuccessor`'s `createdAt`, `switchCurrentRevision`'s `now`, `SealedSessionSecret.createdAt`, a selection manifest's `createdAt`) are ignored. What passes through are evidence instants a worker measured on the database clock and the database bounds (a receipt's start, scan and completion, D-INSP-4; an evaluation's start and completion) and provider facts (the signatures' publication, a provider-reported residual expiry). A retried deletion keeps its first request's instant; a residual found already soft-deleted counts no deletion attempt. | D-CLOCK-1; D-INSP-4; D-OBJ-2. |
| D-PERS-7 | (B07-PERSISTENCE) CMD012's cancel_revision of a mutable predecessor records the successor in `superseded_by_revision_id` (the deferred successor key binds the pair), so `RevisionLineageReader.replacementsSince` reports SUPERSEDED, CANCELLED or UNCHANGED from recorded facts. `SourceAvailabilityReader.availabilityOf` reads after the revision's shared transition lock: a SEALED revision is available until the latest effective deadline of its ACTIVE governing records still ahead on the server clock (it expires only when none is, D-RET-2), `retentionId` naming that record; any other state makes nothing available. | D-REV-1; D-RET-2; §17 items 5–6; B06 D-TX-2. |
| D-PERS-8 | (B07-PERSISTENCE) The receipt records the scanner's own exit code and verdict when the engine reported them (`InspectionReceiptRecord.scanner.exitCode` and `.verdict`, optional members added to the record; columns `scanner_exit_code`, `scanner_verdict` of 0010): evidence only, never decisive. | D-SCAN-1; S054 ("a zero exit code alone is not admission evidence"). |
| D-CMD-6 | (Mandate B07-COMMANDS. The B07-COMMANDS decisions continue the numbering of B06's register, D-CMD-1..5, so no id names two decisions; a B06 decision is cited as "B06 D-CMD-n".) Where the registry catalogue lists no failure for an answer the design specifies, the closed outcome catalogue carries the design's reason: CMD017 `409 REUSE_NOT_AVAILABLE` (§11 CMD017 step 8, D-RET-3: the bytes' first seal is fourteen days old or more, so the UNPAID record would be born expired), and the selection manifest intake refuses a document defect with CMD016's own reason (`PROJECTION_KEY_NOT_CONFIRMED`, `EXCLUSION_REASON_REQUIRED`, `PARSER_CHOICE_INVALID`, `PROJECTION_INVALID`, `SELECTED_COLUMNS_LIMIT`, and `SELECTION_MANIFEST_MISMATCH` for a document naming another revision), since the intake checks the document's internal consistency before CMD016 binds it (D-SEL-2). | 10 "Responses and safe errors" (stable codes and reasons; closed catalogues, B06 D-OUT-1); 03 "Count the correct population" (a referenced entity needs a confirmed key); D-RET-3; D-SEL-2. |
| D-CMD-7 | (Mandate B07-COMMANDS.) `SourceFileRepository.lockShared(fileId)` — a port method added to `@kauro/domain` `source-store.ts` and implemented in `@kauro/persistence` `source/inspection.ts` (`kauro.await_transition('kauro.source_files', …)`, the shared half of the file's transition lock that `sealed_revision_files_admitted` takes, then the read) — is how CMD017 reads "each included file after its transition lock" (§11 CMD017 step 8, D-FILE-1): a revocation committed first is what the seal reads, so it answers `409 INPUT_NOT_ADMITTED` instead of meeting the database's refusal at the file-set insert; a revocation issued later waits for the seal and is then refused by the database. Additive; no migration or grant changes; `source-adapters.test.ts` asserts it returns the same record as `get` and null for an unknown file. | D-FILE-1; D-LOCK-1; 07 "Transaction discipline" (preconditions rechecked inside the transaction; typed conflicts). |
| D-CMD-8 | (Mandate B07-COMMANDS.) The sealed subject's per-association edge counts (D-HASH-4) are taken from what the evaluation measured: the per-table association entries when the evaluator recorded them; with a single declared association, the evaluation's total `associationEdges`; several associations without their split are INTEGRITY_FAILURE — the subject never states a count nobody measured. (B07-R2, §19) The SELECTION_EVALUATION consumer records each declared association's measured edges with its table (`EvaluatedTable.associations`, under the evaluation hash); an outcome that does not measure exactly the declared associations is an ERROR (ASSOCIATION_COUNTS_INCOMPLETE), and the seal refuses a split measured twice or not adding up to the frozen association population. | 04 "Facts used as proof must be exact"; 03 "Count the correct population" (edges before deduplication); D-HASH-4. |
| D-CMD-9 | (Mandate B07-COMMANDS.) CMD017 answers `409 GENERATION_CHANGED` for an included file the object inventory revoked because its accepted generation changed at the provider (revocation reason GENERATION_CHANGED, §12.5 OBJECT_INVENTORY, D-FILE-1), and for a file whose generation, digest or length is not the one the evaluation counted; every other revocation (INTAKE_EXPIRED, RETENTION_EXPIRED, GENERATION_MISSING) is `409 INPUT_NOT_ADMITTED`. An admitted file's generation is set once (the composite key to its receipt) and the database refuses an evaluation counted at another generation (all_selected_inputs_admitted, §4), but the provider can replace or lose the accepted object out of band, which neither the stored file nor the evaluation records until the inventory revokes it (B07-R1, §19): so the seal also, before its unit of work, places a provider hold on the exact accepted generation of every included file with a generation precondition (D-HOLD-1, D-HOLD-2), and answers `409 GENERATION_CHANGED` when the precondition fails (another generation, or none) or the held length is another, and `503 CAPACITY_UNAVAILABLE GENERATION_NOT_OBSERVED` when the provider did not answer (nothing sealed, a retry with the same key executes again) — the case S053 names ("observe actual bytes/generation before … sealing"). From the hold on, the provider refuses to replace or delete that generation, so a replacement after the observation can no longer make the seal commit a generation that vanished (the re-check of B07-R1; before it, such a replacement was left to the inventory). | S053; catalogue CMD017 failure ("a changed generation … leaves no executable sealed revision"); D-FILE-1; §12.5. |
| D-CMD-10 | (Mandate B07-COMMANDS.) B06's pipeline is reused, not forked: `runCommand` becomes `runCommandIn(spec, runtime, envelope, run, body, versionOf)` over any unit-of-work runner (B06's `run`, or `runSource`), whose body may answer COMPLETED or ACCEPTED — a 202 is journaled with exactly its four members (operationId, state, statusPath, pollAfterSeconds) and a replay answers the same ACCEPTED envelope (D-RUN-1); `settleCommandFailure` is the shared failure path (denial facts after the rollback, D-FACT-1) that CMD013's two-phase runtime also uses; `runRead` becomes `runReadIn` over any runner and any access spec, which the source reads and the selection manifest intake use. The api's view and outcome builders are split into `view-kit` and `outcome-kit` to break the module cycle the joined registries would create. B06's behaviour is unchanged (its api tests pass unmodified but for the served inventory). | B06 D-PIPE-1, D-IDEM-1..3, D-FACT-1, D-RESP-1, D-OUT-1; design §11 ("Common to all (B06 D-PIPE-1)"); 10 "Responses and safe errors" (202 with operationId, state, status URL and polling guidance). |
| D-CMD-11 | (Mandate B07-COMMANDS.) Every B07 route is served, so `tools/openapi.mjs` documents the six commands, the seven reads and the selection manifest intake under `paths` from the same contracts (CMD014 with B06's `AcceptedResponse`, the intake with its STORED 201/200 replies and no idempotency key, D-SEL-2) and B07 plans nothing: `x-kauro-planned` is empty. The planned mechanism and its check stay for the packages that plan routes the same way (B09, design §17 item 12). `tools/test/openapi.test.mjs`'s B07-F13 test is retitled accordingly ("… are served and documented under paths …"), the case map's supporting-evidence citation follows, and the negative controls of the mechanism (a planned operation that is registered, also served, repeats an operationId or leaks a forbidden member) are kept. | D-API-1; §9.5 ("When mandate B07-COMMANDS registers a route … it moves from `x-kauro-planned` to `paths`"); 10 "OpenAPI is generated from the owning contract registry and checked against actual routes". |
| D-CMD-12 | (Mandate B07-COMMANDS; a change inside B07-PROVIDER-FAKES' fake, D-FAKE-1.) The labelled storage fake mints its resumable session URI as an https URI on the reserved `.invalid` domain (`CONTRACT_FAKE_SESSION_REF_PREFIX` = `https://contract-fake-storage.invalid/resumable-session/`, RFC 2606) instead of `contract-fake-storage:resumable-session:…`: the ProtectedSessionView carries only an `https://` upload URL (§9.3, enforced by the view builder), so the fake's reference must be one a real provider could return; the `.invalid` domain can never reach a network. The fake keeps its single owner and its SIMULATED label; `source-provider-fakes.test.ts` asserts the new form. | §9.3 (ProtectedSessionView: `https://` only); D-FAKE-1; 21 "Evidence classes". |
| D-CMD-13 | (Mandate B07-COMMANDS; a workspace dependency, no external package.) `apps/api` gains `@kauro/data-plane` (`workspace:*`) in its dependencies — the architecture gate requires every workspace package a package imports, tests included, to be declared there (not in devDependencies) — imported only by `test/source-reads.test.ts`, which binds the platform's own `IsolatedTablePreviewReader` (with `inspectionLimits()` and a per-run scratch) into the test world's source collaborators, so PreviewTable is demonstrated end to end with the real reader reading the admitted generation through the storage port (D-SAPI-7, D-DP-5). The composition root and the edition still bind no preview reader (D-SAPI-6: without a storage adapter there are no bytes to preview; the edition answers SOURCE_SERVICES_UNAVAILABLE, shown by the same file). `pnpm-lock.yaml` gains only the importer's workspace link. The architecture gate allows the edge (entrypoint → adapter); B15, which binds the storage adapter, is where the composition root binds the reader too. | D-SAPI-6, D-SAPI-7; 21 "Evidence classes" (the parsers are not providers: always real in tests, §2); engineering rule (a new dependency is pinned and justified). |
| D-CMD-14 | (Mandate B07-COMMANDS.) GetUploadSession re-delivers the upload URL, the method and the application deadline, but not `chunkMultipleBytes`: the chunk multiple is known only to the answer that created the session (the provider names it then; the journaled placeholder of CMD013 keeps it for a replay), and the vault seals only the reference. ProtectedSessionView makes the member optional. | D-SESSION-1, D-SESSION-2; 09 "Resumable session security". |
| D-CMD-15 | (Mandate B07-COMMANDS; test harness.) The api test world runs the source lifecycle on the real composition root: its unit-of-work factory also opens `runSource` units of work, decorated with B06's hold points plus `source.intent` (after CMD013's intent unit of work attached its journal entry, holding the revision row with the reservation written); the provider ports are the labelled storage and vault fakes of `@kauro/application/testing` (their single owner, D-FAKE-1); the api's process clock is movable (the grace of a pending intent, D-RUN-2) while every lifecycle instant stays the database's. The control plane's steps between the commands (UPLOAD_INSPECTION's admission, SELECTION_EVALUATION's count, UPLOAD_DEADLINES' intake expiry, OBJECT_INVENTORY's revocation) are written by `apps/api/test/source-support.ts` through the product's own adapters in control-plane units of work bound to the agency (D-CTRL-1), revision row first (D-LOCK-2) — the consumers themselves are mandate B07-CONTROL's (`apps/control`), merged at `b07/integration`. A past (an intake window closed, a first seal sixteen days old) is written by the adapters or the source-lifecycle fixture in a transaction whose labelled TEST CLOCK stands there (D-CLOCK-1), never back-dated. A waiting request is recognised in `pg_stat_activity` by the head of its statement, because PostgreSQL keeps 1,024 bytes of a query and the source adapters' row locks name every column before their FROM clause (1,415 bytes for a revision, 2,056 for an upload). | 21 "Concurrency and crash matrix" (interleavings by hold points and observed lock waits, no sleep); design §15; D-CLOCK-1, D-CTRL-1, D-LOCK-2. |
| D-CMD-16 | (Mandate B07-COMMANDS.) The generated matrix (`tools/matrix.mjs`, `docs/design/B06-state-command-event-matrix.md`) treats the six B07 commands as served: their specs join the served specs, the events their handlers publish are read from `packages/application/src/sources/handlers/*` (so every owned edge is checked against its handler), their catalogues are rows of section 3 and their contract-test applicability rows of section 4 cite their own OK / DENY / RACE tests, the role matrix of the six commands (`apps/api/test/source-role-matrix.test.ts`: OWNER, ADMIN, OPERATOR admitted; APPROVER, BILLING, VIEWER, a SUSPENDED and an INVITED member and a member of another agency refused with their facts — B06's N17 test keeps its seven commands) and the shared schema admission; external uncertainty is NOT_APPLICABLE with its reason except for CMD013, whose provider call is cited. Section 2a lists the source routes as served; the source reads are rows of section 5 and the selection manifest intake has its own section 5a. The check refuses a specified B07 command left unserved, a source read that is not a served read and an unserved intake (`tools/test/matrix.test.mjs`, with negative controls). | 10 "Contract tests and compatibility" (the catalogue records applicability and rationale); B06 re-check N13, N17; design §9.5. |
| D-CMD-17 | (Mandate B07-COMMANDS.) GetUploadSession answers a member of the agency who is not the upload's requester 200 with the ProtectedSessionView `{ delivery: UNAVAILABLE, unavailableReason: NOT_REQUESTER }` and records the refused delivery as a DENY fact (reason NOT_REQUESTER), as D-SESSION-2 and §11 CMD013 DENY specify ("another member reading the session → UNAVAILABLE / NOT_REQUESTER"); it is never a 403. The design head's closed catalogue of the route also listed `403 NOT_AUTHORIZED / UPLOAD_NOT_OWNED`, an answer the route never gives: the entry is removed (the send guard would refuse it), and `source-contracts.test.ts` asserts its absence. A caller without an operating role is still refused 403 ROLE_INSUFFICIENT. | D-SESSION-2, D-SESSION-4; §11 CMD013 DENY; 10 "Upload and target routes" (GET progress never exposes the session URI to unrelated readers); B06 D-OUT-1 (closed catalogues). |
| D-CTRL-3 | (Mandate B07-CONTROL.) UPLOAD_INSPECTION registers the accepted intent before the promotion copy (D-OBJ-1) **without a file link**: `stored_objects.file_id` is set once (an immutable column) with a deferred key to `source_files`, and the file exists only once the decision commits, so an intent naming it in its own unit of work cannot commit. The admitted file names its object (`source_files.accepted_object_id`, the composite key to the receipt's promoted generation), and the retained check of `StoredObjectRepository.requestDeletion` (D-PERS-4) follows that reference as well as the object's own link (`packages/persistence/src/source/objects.ts`: `f.file_id = o.file_id OR f.accepted_object_id = o.object_id`); without it an accepted generation of a standing admission registered this way could be requested for deletion. A copy made by an attempt that then loses the upload (a cancellation or an expiry won the upload row, KA071) is observed as a late residual at its generation and deleted (the UploadSession machine: "anything it promoted is registered as residual and deleted"). Migrations unchanged. | 09 "Storage zones and object registry" (the registry is authoritative for intended objects; a name is reserved before any provider write); 09 "Accepted immutability and sealing"; D-OBJ-1, D-PERS-4; machines.ts UploadSession VERIFYING → CANCELLED effect. |
| D-CTRL-4 | (Mandate B07-CONTROL.) The outbox dispatcher (`apps/control/src/dispatcher.ts`) composes B06's primitives: an unbound SYSTEM unit of work claims the due records of one consumer (`OutboxDispatchStore.claim`; attempts + 1 is the settlement fence); per record the OUTBOX_DISPATCH lease is claimed (ttl = the claim window, 300 s by default; absolute deadline = the event's instant + thirty days, fixed by the first claim; subject = the digest of record, event and consumer; no cost authority) and a record whose lease a live owner holds is left to it; the consumer runs in SYSTEM units of work bound to the event's agency (D-CTRL-1), its service token the consumer's name (UPLOAD_INSPECTION → `upload-inspection`). DONE settles DELIVERED; RETRY settles RETRYABLE at the consumer's instant until the eighth attempt and DEAD_LETTER after it; DEAD_LETTER records the consumer's reason token; an exception is a failed attempt (retried, then dead-lettered) recorded by a safe token only. A subject another writer settled first (a lost compare-and-swap, a fence no longer held, KA071) is DONE, never a failure; the unit of work hands such a signal back as the cause of its INTERNAL_ERROR, and the pipelines recognise it there. | 07 "Outbox, inbox and event ordering" (at least once; consumers deduplicate and verify state before an effect); 07 "Job and attempt states" (fences and leases); 10 "Responses and safe errors"; B06 D-LEASE-1. |
| D-CTRL-5 | (Mandate B07-CONTROL.) Two control-plane discovery reads the sweepers of §12.5 need, and the stage-1 port did not offer, are added to `SourceFileRepository` (the `@kauro/domain` source-store port and its `@kauro/persistence` adapter): `findRetentionEnded(limit)` — ADMITTED files some real seal included whose including revisions hold no ACTIVE record ahead, the predicate of `kauro.source_files_revocation_guard` itself (RETENTION's RETENTION_EXPIRED revocations; without it a revocation lost between a record's expiry and the next run would never be found again) — and `admittedGenerations(page)` — admitted files with their accepted object and generation in file-id order (OBJECT_INVENTORY's GENERATION_MISSING and GENERATION_CHANGED comparison). Both read ids and generations only, unbound, through the columns granted to `kauro_control`; no migration or grant changes. | 07 "The sweeper repairs ... overdue deletion"; 09 "periodic provider inventory detects objects missing from that registry"; D-RET-3, D-FILE-1, D-CTRL-1. |
| D-CTRL-6 | (Mandate B07-CONTROL.) UPLOAD_INSPECTION decides in this order, each outcome recorded on the one receipt of the attempt: an observed length of 0 is EMPTY_OBJECT and one above the reservation SIZE_EXCEEDS_RESERVATION; a claim whose stated generation, size or provider checksum (CRC32C, MD5: provider facts compared with provider facts) differs from the observation is CLAIM_MISMATCH, and a claim is never used for anything else (S053); the bounded inspection runs next, and a structural refusal (CORRUPT_STRUCTURE, ACTIVE_CONTENT, RESOURCE_LIMIT, UNSUPPORTED_FORMAT) or a detected format other than the declared one (FORMAT_MISMATCH) is decided **before any scan**: the engine never expands a container the bounded preflight refused (09: "The preflight can scan the original container and safely extracted allowed parts under the bounded inspection pipeline"). The scan instant is the pipeline's own reading of the database clock after the scan (the receipt's `scannedAt`; the engine's report instant is not used, D-INSP-4), and the domain's coverage decides (DETECTED_MALWARE, INCOMPLETE_SCAN, STALE_SIGNATURES; an engine ERROR is transient). A promotion whose copy does not re-read to the inspected digest and length is PROMOTION_UNVERIFIED. Only transient infrastructure failures (a provider or vault call, the isolated child, an engine ERROR) are retried, inside the application deadline; a retried attempt proceeds only while the provider still holds exactly the recorded observation. Once the inspection is terminal the quarantine generation is requested for deletion and deleted (09 "Retention schedule": incomplete upload and quarantine are available "until inspection terminal"), and the bearer record of the finalized session is purged (D-SESSION-1: the session can do nothing more). | 09 "Completion and inspection", "Scanner coverage", "Retention schedule"; S053, S054, S024; D-INSP-1..4, D-SCAN-1, D-ISO-1. |
| D-CTRL-7 | (Mandate B07-CONTROL.) STORAGE_LIFECYCLE and PROVIDER_SESSION_RECONCILIATION. An event whose subject does not carry the tombstone it announces is dead-lettered (SUBJECT_NOT_TOMBSTONED). A provider cancellation is carried out only when the database requested it (REQUESTED, D-ROLE-3) or it is UNCERTAIN, with the reference the vault opens under exactly its sealed binding, and the answer is recorded only when it moves the state forward (an UNCERTAIN answer to UNCERTAIN records nothing and stays pending). The bearer record is purged once the cancellation resolved (CONFIRMED, UNSUPPORTED), once the provider horizon passed on the server clock (the session is dead: no answer is invented and the state stays as recorded; PROVIDER_SESSION_RECONCILIATION finds a pending cancellation's record still held past its horizon, per agency, and purges it — B07-R4, §19), and at once when nothing is to be cancelled (NOT_REQUESTED: a session never issued, or a finalized one of a rejected upload or of an admitted upload past its window). A name the registry reserved but never observed is checked at the provider: an object found there is observed as a late residual and deleted by its generation; an absent one is closed ALREADY_ABSENT, and an object arriving under that name later is an unregistered generation for OBJECT_INVENTORY (registered RESIDUAL, late, in the scope its opaque name states, and deleted). OBJECT_INVENTORY revokes GENERATION_MISSING (the registry row then closed by an absence check) and GENERATION_CHANGED (the live generation under the name is unregistered and handled as one). | 09 "Resumable session security" (the cancellation result is recorded; SESSION_REVOCATION_PENDING is reconciled until the provider lifetime ends), "Soft delete, versioning and holds", "Storage zones and object registry"; R2-051; D-ROLE-3, D-SESSION-1, D-SESSION-3, D-OBJ-1, D-OBJ-2, Q-B07-23. |
| D-CTRL-8 | (Mandate B07-CONTROL.) The members of an AUTHORITY_JOURNAL tombstone: `tombstoneId` is the domain event id (idempotence), `revisionId` the revision the subject's authority belonged to (an upload's revision, a file's origin revision), `occurredAt` the instant the database recorded for the subject's terminal transition, exact to the microsecond (D-CLOCK-1), and `sequence` the event's sequence. The subject's current state must equal the named state (D-RESTORE-1, strictly): a REJECTED revision whose rejection event is dispatched only after the revision EXPIRED is dead-lettered, and its EXPIRED tombstone, which a restore applies too, carries the terminal fact. RETENTION runs the records, then the files (each revocation with the deletion of its accepted generation, which no admission retains any more), then the revisions, so an expired revision's bytes are released before its event is handled; a SUPERSEDED revision's record expires but the revision does not (it never expires itself), and its files are revoked once no including revision holds an ACTIVE record ahead (D-RET-3). | 09 "Deletion receipts and restoration"; 14 "Minimal durable facts outside the primary restore boundary"; 07 (verify state before an effect); D-RESTORE-1, D-RESTORE-2, D-RET-2, D-RET-3, D-PERS-3. |
| D-INT-1 | (The `b07/integration` integrator.) The end-to-end run of both stage-2 halves lives in `apps/control/test/end-to-end.test.ts`: the application's own handlers of CMD012..CMD017, the source reads and the manifest intake (`createB07Handlers`, `createSourceReadHandlers`, `createSourceIntakeHandlers` — what `apps/api`'s `assembleApi` binds) on B06's pipeline with the real Authorizer, each answer checked with `checkReply` against its route's declared contract as the transport does, composed with this package's dispatcher, consumers and sweepers over one cluster and one set of labelled fakes (`test/support/product.ts`). The architecture gate forbids an entrypoint importing another, so the HTTP admission stays `apps/api`'s tests. `@kauro/control` gains `@kauro/authorization` (`workspace:*`) in its dependencies, imported only by its tests (the gate requires every imported workspace package declared there, as D-CMD-13); no external dependency. | §15 ("the end-to-end cases of the case map run there"); 07 "Platform topology"; architecture.rules.json; D-CMD-13. |
| D-HOLD-1 | (The package-close re-check of `6b670e3`, B07-R1 PARTIALLY_FIXED.) The seal binds its accepted generations at the provider with a **temporary object hold** placed under a generation precondition: `ObjectStoragePort.placeHold(location, name, generation)` (Cloud Storage: `objects.patch {temporaryHold: true}` with `ifGenerationMatch` = the accepted generation) answers HELD with the held generation's observation, or GENERATION_NOT_LIVE (412: another live generation; 404: none) and holds nothing; `releaseHold` clears it on exactly that generation (RELEASED, also when not held; ABSENT when it is not the live generation) and never touches another one. While a generation is held the provider refuses to replace or delete it (Cloud Storage "Object holds": an object with a hold cannot be deleted or replaced; 403), so from the placement on the generation a seal names cannot vanish under it, whatever happens between the observation and the commit. The alternatives do not close the gap: a database lock cannot reach the provider and no transaction spans a provider call (07); a second observation inside or after the unit of work leaves the same gap between it and the commit; object versioning keeps a replaced generation only as noncurrent, deletable, and 09 disables versioning and soft delete on customer-data buckets; a bucket retention policy or lock and event-based holds (whose release restarts a bucket retention period) could block the lawful early deletion 09 requires. A temporary hold changes no byte, no access and no retention clock, and its release lets a deletion proceed at once. The contract fake (its single owner B07-PROVIDER-FAKES, D-FAKE-1) models it faithfully: a held live generation refuses the port's `delete`, an out-of-band overwrite (`plantObject` … `overwrite`) and deletion (`deleteOutOfBand`) with OBJECT_HELD and nothing changed; a finalizing session or a copy onto its name is already refused by the no-overwrite precondition; `generationsOf` shows `temporaryHold`. The record of the hold (`kauro.object_holds`, migration 0020, D-HOLD-2) carries what 09 asks of a hold: authority (CMD017 of the acting person, `placed_by_user_id` = the request's user, RLS), reason (`SEAL_INTEGRITY`, never a legal hold), applicable scope (agency, project, revision, file, object and the exact generation, composite keys to the file's accepted generation), start (`intended_at`, `sealed_at`), expiry (the attempt bound, or the retention of the sealed bytes), review owner (the RETENTION sweeper, which releases it) and permitted access (none: the hold grants no read and leaves the ACCEPTED zone's access as it is). Every clause resting on the provider honouring the hold is SIMULATED until B15 binds Cloud Storage. | B07-R1 re-check (`tools/review/out/b07-recheck-6b670e3d6def/review.json`); S053; catalogue CMD017 failure ("a changed generation … leaves no executable sealed revision"); 09 "Storage zones and object registry" (generation preconditions prevent overwrite), "Accepted immutability and sealing", "Soft delete, versioning and holds"; 07 "Transaction discipline"; 14 (storage generation substitution is a fault to inject); 21 "Evidence classes". |
| D-HOLD-2 | (The re-check of B07-R1.) The seal's protocol. Before the unit of work, in one unit of work behind the command's own access decision (nothing when the caller is refused or the revision is not the READY_TO_SEAL revision of the body's version and selection), every included, still ADMITTED file's hold is recorded INTENDED under one attempt id at the server's instant, bounded by `SEAL_HOLD_ATTEMPT_SECONDS` = 900 (`attempt_expires_at`, CHECKed: longer than fifty bounded placements and the unit of work, far shorter than any retention) — the intent is durable before the provider call (D-RUN-2's discipline); then each placement, bounded by PROVIDER_CALL_TIMEOUT_MS. Inside the unit of work each included file must be exactly what the provider held (GENERATION_NOT_LIVE or another length: 409 GENERATION_CHANGED; unanswered, not reached, a release of its object in progress: 503 GENERATION_NOT_OBSERVED), and after the sealed file set the seal marks its holds SEALED in its own transaction, in object-id order — the database refuses SEALED without a sealed file set naming that generation, and past the bound (KA072), and the adapter answers a hold the control plane abandoned as STALE (503). An intent and a release decision of one object serialize on the object's hold lock (`kauro.lock_object_holds`, a transaction-level advisory lock the guard itself takes): no hold is intended while a release is carried out (KA071) and no release is decided while an attempt is INTENDED or a seal retains the generation (KA071); a seal, a close and a recorded release change one row under its row lock only (a seal's hold stays INTENDED, committed, until its own transaction commits, which already keeps every release away), so a second seal of the same revision is ordered by the revision row as before. The hold lock is only ever taken in a unit of work that holds no revision, upload or file lock (the seal's intents, a release decision), so it adds no edge to D-LOCK-1's order. The revision is bound by the guard (READY_TO_SEAL, same agency and project) and by the SEALED edge, not a foreign key: the seal in flight holds its revision row FOR UPDATE (it writes `manifest_hash`, a key column) and a key check would make a concurrent attempt wait on it for the whole seal. Rows are never deleted. | 07 "Transaction discipline" (no transaction across an external call; multi-row invariants use explicit locking; application checks cannot be the sole protection); 10 "Idempotency contract" (intent before external dispatch); D-RUN-2, D-LOCK-1, D-CLOCK-1, D-SEAL-1. |
| D-HOLD-3 | (The re-check of B07-R1.) Releases, bounded. A seal that did not commit — refused, failed (a crash before COMMIT that the process survives) or answered by a replay of another execution — closes its attempt's holds CLOSED/REFUSED and releases, at the provider, every object whose hold nothing else needs any more, recording the answer (`releaseAttemptHolds`, best effort: what it does not finish stays recorded). A sealed subject keeps its holds until the retention of its bytes ends: the RETENTION sweeper revokes the file (RETENTION_EXPIRED, D-RET-3) and the deletion of an accepted generation (`executeDeletion`, every deletion path) first releases the holds nothing needs any more — and, when no hold record awaits a release, still asks the provider to release that exact generation, which clears a placement whose answer was lost and landed after its attempt's release; a generation still held fails the delete (DELETION_FAILED, retried). A crash between the hold and the commit leaves the hold INTENDED: RETENTION abandons it (CLOSED/ABANDONED, refused by the database before its bound, KA072) once its bound passed on the server clock and releases it; a release decided and never answered (RELEASING) is driven again once the bound passed. The request handlers close only REFUSED and never abandon; the control plane places, seals and refuses nothing (row policies). No orphan hold therefore survives past its bound: the attempt's bound for an attempt, the retention of the bytes for a seal, the bound again for an unanswered release. | 09 "Soft delete, versioning and holds" (a hold names its expiry and review owner; lawful early deletion is not blocked), "Retention schedule", "Early deletion" (deletes under generation preconditions and records each result); 07 "The sweeper repairs … overdue deletion"; D-RET-3, D-OBJ-2, D-ROLE-2, D-CTRL-1. |

## 2. Packages and ports

Dependencies flow as in B06 (contracts → domain ports → application → adapters; `architecture.rules.json`):

```
@kauro/domain        model/source/{ids, records, machines, policy, selection, scan-coverage, digests, retention, object-names}
                     ports/source-store (SourceUnitOfWorkFactory.runSource, the source repositories, and the read ports
                     SourceAvailabilityReader and RevisionLineageReader the commercial packages consume)
@kauro/application   sources/{contracts, request-schemas, views, response-views, outcomes, pipeline-contracts}
                     ports/source-providers (ObjectStoragePort, MalwareScannerPort, ContainerInspectorPort with InspectionIsolation,
                     SelectionEvaluatorPort, SessionVaultPort, AuthorityJournalPort with AUTHORITY_TOMBSTONES, CommercialScopeInspector)
@kauro/persistence   migrations/0009..0012, sqlstate (KA070..KA072), testing/{temporary-postgres (the TEST CLOCK), source-lifecycle}
```

External providers — object storage, the malware scanner, the key service that seals session references, the external authority
journal — are reached only through `@kauro/application` ports. Until the integration package (B15) binds real adapters, tests
bind contract-faithful fakes that report `evidenceClass: "SIMULATED"` and carry `contract-fake-*` provider tokens in every record
they produce (21 "Evidence classes"); they are never counted as real integration. Each fake has one owner (§15): the scanner's is
B07-DATA-PLANE's (`@kauro/data-plane/testing`); object storage's, the session vault's and the authority journal's are
B07-PROVIDER-FAKES' (`@kauro/application/testing`); both subpaths are test-only (architecture rule `testOnlySubpaths`). The container inspector and the selection
evaluator are not providers: they are the platform's own bounded parsers (`@kauro/data-plane`), always real in tests — S024 is
decided by them, isolated as D-ISO-1 describes.

`SourceUnitOfWork` is the B06 `UnitOfWork` plus `sources: SourceStore` and `serverInstant()` (the database's transaction time,
exact to the microsecond, D-CLOCK-1); the factory gains `runSource` next to `run`, so every B06 handler and adapter compiles
untouched; at integration `sources` folds into the unit of work. The ports take no caller instant for anything a deadline depends
on: the adapter writes `kauro.server_now()` in SQL and returns the stored value.

## 3. Aggregates, contracts and tables

Schema `kauro`, PostgreSQL 17, the B06 conventions: `agency_id` on every tenant row; composite foreign keys bind tenant, project
and revision; uniqueness includes scope; server ids are UUIDv7 (CHECK); instants are `timestamptz`, the lifecycle ones the
server's (D-CLOCK-1); byte counts and populations BIGINT (B07 stores no money); JSONB only for closed-schema documents (selection
manifests, evaluations' per-file/table/projection facts, the sealed manifest and subject, coverage and problem lists); every
aggregate carries `version` (D-VER-1) and every version its event (D-EVT-1); B07's aggregate kinds are rows of the foundation
registry (D-KIND-1).

### 3.1 Tables

| table (migration) | aggregate / contract | key columns and constraints | RLS |
|---|---|---|---|
| `aggregate_kinds` (0008, foundation) | registered aggregate kinds | B07 inserts `upload_session`, `source_file`, `retention_record` (owner B07) | foundation's; B07 adds `aggregate_kinds_read_b07_control` (control plane reads, it appends events) |
| `dataset_revisions` (+ 0009) | DatasetRevision lifecycle and lineage | B06 identity plus selection (manifest id, hash, inventory hash, time — all or none), evaluation id/hash and the four populations (all or none; billable ≤ logical), sealed counts, successor, terminal instants and reason; READY_TO_SEAL and later need selection, evaluation and counts; SEALED/SUPERSEDED need sealed counts; `(agency, project, revision)` and `(agency, revision, supersedes)` unique; lineage in project, successor FK (deferred), one mutable per project, supersedes once; the lifecycle guard (0011: server clock, the explicit intake closure, the inventory comparison) and the deferred sealed-subject and closed-without-live-uploads checks | B06 tenant; restrictive tenant target states (D-ROLE-2); control read (bound or discovery) and update of READY_TO_SEAL, REJECTED, EXPIRED and its columns |
| `stored_objects` (0009) | object registry, StoredObject (D-OBJ-1, D-OBJ-3: not an aggregate) | UUIDv7 PK; zone, data class (RAW, DERIVED, RESIDUAL), provider token, location key, opaque name (`kauro.is_object_name`, zone and agency bound), generation (set once), bytes, sha256, state, late (RESIDUAL for good), creator, observation/verification/deletion stamps, deletion result (never a failure recorded as a deletion), attempts (never decrease), provider residual and its basis (D-OBJ-2), the deletion at the server's time; a provider generation registered once; one open intent per name; FKs to project, revision, upload (deferred), file (deferred) | tenant read; tenant insert of exactly the CMD013 quarantine intent; control read, insert (SERVICE), update — bound |
| `storage_location_policies` (0009) | retention read-back (D-OBJ-2) | provider, location, soft-delete retention seconds, versioning, evidence hash and class, observed at (the server's time, N3); append-only | control only |
| `revision_quota`, `upload_capacity` (0009) | quota ledgers (D-UP-2, D-UP-3) | bytes 0..5e9 and files 0..50 per revision; sessions 0..limit per agency, limit default 2; deferred ledger checks (KA070), queued only by a holding change, one snapshot | tenant and control, bound; the limit is the control plane's column |
| `upload_sessions` (0009) | UploadSession (D-UP-1) | UUIDv7 PK; revision and project scope; display name (label), declared format, reserved bytes 1..2e9, quarantine object, requester (membership and the person holding it: composite FK `upload_sessions_requester_fk`, D-PAIR-1), application deadline (exactly creation + 86,400 s, creation the server's time), issuance fence, session stamps and digest, provider cancellation state (forward only; REQUESTED stamped by the database with a request handler's tombstone, the result the control plane's, D-ROLE-3) and time, completion claim (set only by the report), observation (set once), negative observation (the control plane's, with completion_not_observed only), inspection fence (forward only, only while VERIFYING) and its claim instant (stamped by the database, D-INSP-4), receipt hash and file (set once), terminal instants, reason and canceller (set once); the server clock and the deadline window (`upload_sessions_window_clock`); the revision-accepts-uploads trigger (revision row lock, DRAFT/UPLOADING only, KA072); quota trigger; initial-state, listed-transition, version and event triggers; aggregate kind `upload_session` | tenant (column grants, D-ROLE-2, D-ROLE-3) with restrictive target states and a restrictive insert policy (the acting person's own live operator membership, D-PAIR-1); control read of non-text columns and update of its columns, bound |
| `upload_session_secrets` (0009) | sealed session reference (D-SESSION-1) | PK upload; FK `(agency, upload, requester)`; key reference, 12-byte nonce, ciphertext; never updated | requester insert and read (UPLOADING and unexpired on the server clock only); control read and delete, bound |
| `inspection_receipts` (0010) | one completed inspection attempt | receipt hash; fence ≥ 1 (one per attempt); observation (must equal the upload's), sha256, claim digest and consistency, declared/detected format, structure status, scan state, semantic status (always SEMANTIC_NOT_YET_PROFILED), scanner engine/version/signatures/config/exit code/verdict (evidence), the pinned signature age (= 86,400), expected and scanned parts and bytes, coverage and problems (digests and tokens), parser profile hash, outcome and rejection class, accepted object/generation/digest; CHECKs: clean means the object covered (`kauro.scan_coverage_complete`), admission needs every separate result, rejections classified, BLOCKED iff detection, incomplete/stale is NOT_SCANNED; append-only; the current-attempt trigger (KA071, KA072; the instants bounded by the attempt's claim, the observation and the server clock, D-INSP-4) | tenant read; control insert and read, bound |
| `source_files` (0010) | FileManifest, SourceFile (D-FILE-1, D-FILE-2) | UUIDv7 PK; version (an aggregate, kind `source_file`, event per version); one per upload; accepted object, generation, sha256, bytes 1..2e9, format, scan state, parser profile, receipt; admitted ⇔ ADMITTED; composite key to the receipt's promoted generation, digest and length; born admitted, at the server's time, only while the upload is VERIFYING; revocation guard (file transition lock; INTAKE_EXPIRED, RETENTION_EXPIRED, GENERATION_* rules) | tenant read; control insert, read, update of the revocation columns and version |
| `source_tables`, `source_table_columns` (0010) | detected inventory | table (file, ordinal), kind, name display (label or NULL) and digest, visibility, columns, row estimate, formulas and cache state, merged/hidden counts, issue codes, structure hash; column ordinal, label display and digest, label state; append-only; appended only while the file's upload is VERIFYING (D-SEL-4) | tenant read; control insert, reads without the display text |
| `selection_manifests` (0011) | the selection document (D-SEL-1) | UUIDv7 PK; body (closed, ≤ 512 KiB) naming its revision, schema version, inventory hash and files (NULL-safe CHECK); body hash; unique per (revision, body hash); creator membership; append-only | tenant read; insert by the session's own ACTIVE membership; control read, bound |
| `selection_evaluations` (0011) | one counting pass | result COMPLETE (every count, 1..50 files, 1..5e9 bytes, edges ≤ 5e6, no failures), ADMISSION_FAILED or ERROR (failures explained, no counts); per-file generations, per-table and per-projection facts; FK to its manifest; append-only | tenant read; control insert and read |
| `sealed_manifests`, `sealed_revision_files` (0011) | the sealed manifest and subject | `manifest` = exactly HASHING's four members (CHECK `sealed_manifests_authority_preimage`), `manifest_hash`; `subject` naming the revision and this row's hashes (CHECK `sealed_manifests_names_revision`), `subject_hash` (unique per agency); projection, selection and evaluation hashes; sealed at; file set: ordinal, disposition and exclusion reason, the exact generation/digest/length of a file of the same project (FK); admitted-at-seal trigger (file transition lock); sealed at the server's time and bound at COMMIT to the revision entering SEALED at that instant in the same transaction (D-SEAL-1); append-only | tenant read and insert (only inside the seal, D-SEAL-1); control read |
| `retention_anchor_kinds`, `retention_anchors` (0012) | anchor facts | kinds registered (D-ANCH-1); anchor: revision scope, upload for intake kinds and none for REVISION_SEALED, occurred at (the server's time), evidence hash; once per (upload, kind) and per (revision, kind); bound at COMMIT to its transition (D-ANCH-2); append-only | tenant read, tenant insert of UPLOAD_INITIATED, INTAKE_CANCELLED, REVISION_SEALED; control read and insert of INPUT_ADMITTED, INTAKE_REJECTED, INTAKE_EXPIRED, bound |
| `retention_records` (0012) | RetentionRecord (D-RET-2, D-RET-3) | aggregate kind `retention_record`; tenant scope (agency, client, project) bound to the project by the composite FK `retention_records_project_client_fk` (D-PAIR-1); class (registry enum), anchor and its evidence hash (FK), soft/hard/effective deadlines (effective = minimum), policy version, provider residuals, state, expiry (at the server's time, never early); one per (revision, class); hard deadline, anchor, class immutable | tenant read and insert of exactly the UNPAID record of its own seal (D-ANCH-2); control read and the expiry update, bound |
| `object_holds` (0020) | the provider hold of a seal's accepted generation (D-HOLD-1..D-HOLD-3; not an aggregate) | UUIDv7 PK; attempt id (unique per object); agency, project, revision, file, object and exact generation (composite keys to the file's accepted generation and the registry row; the revision bound by the guard); `TEMPORARY`, `SEAL_INTEGRITY`, the placing person; INTENDED → SEALED / CLOSED (REFUSED, ABANDONED) → RELEASING → RELEASED, every instant the server's, facts set once; bound = intended + 900 s (CHECK); an intent and a release decision serialized on the object's hold lock (KA071), SEALED only with the seal's file set and before the bound, ABANDONED only after it (KA072); never deleted | tenant: insert as the acting person, SEALED, CLOSED/REFUSED, RELEASING, RELEASED; control: read (unbound discovery), CLOSED/ABANDONED, RELEASING, RELEASED |

### 3.2 Roles, grants, context

No new runtime role: the source lifecycle runs under the B06 groups. `kauro_app` gains the tenant grants above (never DELETE);
`kauro_control` gains the source-lifecycle writes of D-CTRL-1/D-CTRL-2, SELECT on the aggregate-kind registry with its own read
policy (D-KIND-1), and DELETE on `upload_session_secrets` only (besides B06's leases). `kauro_assurance`, `kauro_validator` and
`kauro_ingress` gain nothing; provider notifications (a generation or metadata event, 09: "a notice to inspect current authority,
not an instruction to accept the file") arrive through B06's `kauro_ingress` inbox and are handled by UPLOAD_INSPECTION like a
reported completion. The whole matrix is pinned in `packages/persistence/test/fixtures/runtime-boundary.json`; against the
foundation it changes exactly one B06 entry (`kauro_control` on `kauro.domain_events`: SELECT → INSERT, SELECT, D-CTRL-2), adds
one policy on a B06 table (`domain_events_tenant_not_source_control`, restrictive, `kauro_app`, D-ROLE-3) and adds the B07
tables, column grants and policies and `aggregate_kinds_read_b07_control`. B07 also adds one key to a B06 table
(`projects_client_scope`, D-PAIR-1), which the boundary does not list. This revision's diff against `f243248` was reviewed entry
by entry (§16).

Context binding is B06's (`set_config(..., true)` inside the transaction). A SYSTEM unit of work of the control plane binds
`kauro.agency_id` to the work item's agency and no user (D-CTRL-1); `SystemContext` carries the agency.

### 3.3 Refusal translation

| database refusal | answer |
|---|---|
| `revision_quota_bytes_within_envelope` | PRECONDITION_FAILED / REVISION_QUOTA_EXCEEDED |
| `revision_quota_files_within_envelope` | PRECONDITION_FAILED / REVISION_FILE_LIMIT |
| `upload_sessions_reserved_bytes_check` | PRECONDITION_FAILED / FILE_TOO_LARGE |
| `upload_capacity_within_limit` | ADMISSION_LIMITED / UPLOAD_CONCURRENCY_LIMITED |
| `upload_sessions_display_name_label` | INVALID_REQUEST / SCHEMA_VIOLATION on `displayName` (B06 LABEL_CONSTRAINT_FIELDS) |
| `dataset_revisions_one_mutable_per_project`, `dataset_revisions_supersedes_once` | PRECONDITION_FAILED / REVISION_NOT_MUTABLE, PREDECESSOR_NOT_CURRENT |
| KA070 | INTEGRITY_FAILURE / QUOTA_LEDGER |
| KA071 | PRECONDITION_FAILED / FENCE_DISCIPLINE (a handler that checked its fence never meets it; the control plane treats it as "the attempt lost": DONE) |
| KA072 | INTEGRITY_FAILURE / LIFECYCLE_BINDING_MISSING (a handler that checked its preconditions first and writes the server's instants never meets it; a request that raced a deadline on the server clock is answered with the command's own precondition reason — RESERVATION_EXPIRED — when the handler re-reads the upload) |

## 4. State machines

Every machine is seeded (`kauro.state_machines`, `kauro.state_transitions`), every row is born in its initial state
(`enforce_initial_state`, KA008) and every other edge is refused (`enforce_listed_transition`, KA008). The persistence test proves
the seeds equal the domain machines. The generated matrix (`docs/design/B06-state-command-event-matrix.md`, §1) lists every edge
with the command or control-plane owner that performs it and its event.

- **DatasetRevision** (registry machine, initial DRAFT; B06 seeds the edges). What each target state requires is checked by
  `dataset_revisions_lifecycle_guard` after the revision's transition lock (D-LOCK-1): upload_reserved needs the reservation in the
  same unit of work; all_uploads_completed needs the agency's selection bound in the same update, with no reservation, session or
  verification open and the manifest matching the inventory (D-INTAKE-1, D-SEL-4) — nothing else takes it; previously_admitted_inputs_selected
  and selection_changes need a new selection; all_selected_inputs_admitted needs a complete evaluation of the bound selection, no
  upload in flight and every included file admitted in the project and counted at its exact generation, digest and length;
  fatal_input_rejection needs the failed evaluation of the bound selection; seal_command needs the manifest of exactly the scope
  READY_TO_SEAL exposed and no upload in flight, and at COMMIT the sealed manifest and subject, the file set equal to the
  selection's dispositions with the frozen counts, the seal's own anchor and the UNPAID record of the bytes' first seal
  (`dataset_revisions_sealed_subject`); retention_expires needs every governing deadline reached on the server clock (SEALED) or
  every intake window closed (REJECTED); every closing edge needs, at COMMIT, no upload in flight. Every lifecycle instant is the
  server's (D-CLOCK-1). A sealed subject never changes (KA004); the seal's facts are written by seal_command only and its sealed
  rows are bound to it at COMMIT (D-SEAL-1); a terminal fact is set once (KA004).
- **UploadSession** (D-UP-1), **StoredObject** (D-OBJ-1), **SourceFile** (D-FILE-1, D-FILE-2), **RetentionRecord** (D-RET-2):
  platform machines of `@kauro/domain` (`SOURCE_LIFECYCLE_STATE_MACHINES`) in the registry's shape and unlisted-transition policy.

## 5. Transaction discipline and lock order

Every command runs B06's pipeline (D-PIPE-1) in READ COMMITTED; CMD013 runs it in two units of work (D-RUN-2). Lock order
D-LOCK-1 for the commands and D-LOCK-2 for the control plane. Why READ COMMITTED is enough: every multi-row invariant is closed by
a lock, a unique index or a deferred check —

| invariant | closed by |
|---|---|
| a revision's bytes ≤ 5e9 and files ≤ 50 across concurrent reservations (R2-052) | the revision row lock of the reservation trigger, then the ledger row lock and its CHECK on the committed total; KA070 at COMMIT for any disagreement, read in one snapshot and queued only by a holding change (B07-F10) |
| at most two live sessions per agency | the capacity row lock and its CHECK (RACE test: two reservations for the last slot) |
| freed quota released exactly once | held bytes are a function of the upload's state; the quota trigger applies deltas under the ledger locks |
| a late completion never resurrects cancelled data | CANCELLED/EXPIRED/REJECTED are terminal (KA008); a receipt and a file only for the current attempt of a VERIFYING upload (KA071, the upload row lock of the receipt trigger); the claim cannot be recorded on a tombstone (KA004); nothing is accepted after the deadline on the server clock (KA072); a late object is RESIDUAL for good |
| a reservation never enters a revision a concurrent transition is closing or sealing | the revision row lock taken by the reservation trigger and by every transition (D-LOCK-1; RACE test, both interleavings) |
| the intake closes only by the agency's selection, on a settled inventory | the control plane cannot enter INSPECTING; the guard requires the binding and no live upload after the transition lock; every settle point takes the revision row first (D-INTAKE-1, D-LOCK-2; tests: the three-file intake, the last open upload cancelled, expired or rejected) |
| a cancellation and an inspection outcome never deadlock | both take the revision row first (D-LOCK-2; RACE test, both interleavings) |
| a seal never includes a file whose intake expired, and an expiry never revokes a sealed file | the file's transition lock: shared by the seal's file-set insert, exclusive by the revocation, which re-checks after it (RACE test, both interleavings) |
| a selection binds the current inventory | the lifecycle guard after the revision's transition lock: no upload in flight, the manifest's inventory hash recorded, the manifest's files and tables equal to the detected inventory (D-SEL-4); the inventory of an admitted file never grows |
| one mutable revision per project; a predecessor replaced once; linear lineage | `dataset_revisions_one_mutable_per_project`, `dataset_revisions_supersedes_once`, the successor FK, CMD012's project CAS |
| every upload commits with its initiation anchor and a deadline exactly 24 h after it | `upload_sessions_initiation_anchored` (deferred), `upload_sessions_deadline_policy`, the server clock |
| every anchor is its own transition's, written by its producer | the per-role, per-kind anchor policies and `retention_anchors_bound` (deferred) |
| every seal commits with its manifest, subject, file set, anchor and the UNPAID record of the bytes | `dataset_revisions_sealed_subject` (deferred) |
| no revision closes with an upload in flight | `dataset_revisions_closed_without_live_uploads` (deferred) |
| one receipt per inspection attempt; a fence never moves backwards | `(upload_id, inspection_fence)` unique; `upload_sessions_guard` (KA071) |
| a provider generation is registered once; one open intent per name | `stored_objects_provider_generation`, `stored_objects_one_intent_per_name` |
| every version has its event, in its own agency | B06 `require_event_for_version`, the foundation's `domain_events_bind_aggregate` |
| a sealed manifest or file row exists only as the record of its seal; only real seals keep bytes admitted or start their clock | `sealed_manifests_server_clock`, `sealed_manifests_bound` and `sealed_revision_files_bound` (deferred), the seal facts written by seal_command only, `kauro.is_real_seal` for the readers (D-SEAL-1) |
| the provider cancellation result, the unobserved completion and every control-plane event are the control plane's | column grants, `upload_sessions_cancellation_requested`, the guard's negative-observation rule, `domain_events_tenant_not_source_control` (D-ROLE-3) |
| a receipt's scan instant lies within its attempt | `upload_sessions_attempt_claimed`, `inspection_receipts_current_attempt` (D-INSP-4) |
| an upload's requester and a record's client are pairs of one scope | `upload_sessions_requester_fk` with `upload_sessions_tenant_requester`, `retention_records_project_client_fk` (D-PAIR-1) |
| a decided or tombstoned subject is never re-dated | the set-once rules of `upload_sessions_guard` and `dataset_revisions_lifecycle_guard` (D-CLOCK-1) |

No transaction spans a provider call, a scan or a parse: CMD013's provider call sits between its two units of work; the control
plane reads, hashes, inspects, scans and promotes outside a transaction and records the result in one unit of work under the
attempt fence it claimed. A lost response after COMMIT is recovered by the same key.

## 6. Outbox, inbox and consumers

B07 registers 16 event types (0012) and publishes the DatasetRevision lifecycle events B06 registered with the machine (all but
`dataset_revision.inspecting.v1`, which no B07 edge publishes since D-INTAKE-1: all_uploads_completed publishes
`dataset_revision.selection_changed.v1` with `previousState: UPLOADING`). Payloads are allowlisted (`EVENT_PAYLOAD_ALLOWLIST`): ids,
hashes, tokens, counts — never a display name, a worksheet name, a label, an object name, a generation or a session reference
(domain test). Fan-out (`EVENT_SUBSCRIPTIONS`):

| event | consumers |
|---|---|
| `upload_session.completion_reported.v1` | UPLOAD_INSPECTION |
| `upload_session.cancelled.v1`, `.expired.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL |
| `upload_session.rejected.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL, NOTIFICATIONS |
| `source_file.admission_revoked.v1` | EXECUTION_CONTROL (B08), NOTIFICATIONS, AUTHORITY_JOURNAL (N5) |
| `dataset_revision.selection_changed.v1` | SELECTION_EVALUATION |
| `dataset_revision.ready_to_seal.v1`, `.sealed.v1` | NOTIFICATIONS |
| `dataset_revision.rejected.v1` | NOTIFICATIONS, AUTHORITY_JOURNAL |
| `dataset_revision.superseded.v1` | EXECUTION_CONTROL (B08), AUTHORITY_JOURNAL |
| `dataset_revision.cancelled.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL |
| `dataset_revision.expired.v1` | STORAGE_LIFECYCLE, EXECUTION_CONTROL (B08), AUTHORITY_JOURNAL |
| `dataset_revision.deleted.v1` | AUTHORITY_JOURNAL |

The consumers are control-plane pipelines (§12) dispatched by B06's `PgOutboxDispatchStore` under OUTBOX_DISPATCH leases, at
least once; each is idempotent by its own fences and by the listed transitions (a second delivery finds the state already
moved and is DONE), and each verifies the subject's current state before its effect (07 "consumers deduplicate by their own
durable inbox identity and verify state before an effect"): AUTHORITY_JOURNAL appends a tombstone only for a subject in the
tombstone's terminal state, STORAGE_LIFECYCLE deletes only for an upload or revision whose acceptance is tombstoned. The database
refuses the control plane's event types to the request handlers (D-ROLE-3); an event type the request handlers may append but
whose subject is not in the state it announces (a forged event on a version bump) is dead-lettered by that check — binding every
event type to its transition in the database is a foundation question (Q-B07-22). Provider notifications enter through B06's inbox (`kauro_ingress`), deduplicated by provider event id, and
become an inspection of current authority, never an acceptance.

## 7. Idempotency (10 "Idempotency contract")

Every B07 command is journaled with B06's `CommandJournal` (identity: environment, subject, agency, operation, key; digest
KAURO_COMMAND_REQUEST_V1 over path ids and body). CMD013's first unit of work commits the entry RESERVED and linked to the upload
(`PendingOperationJournal.attach`), so a concurrent duplicate or a retry sees PENDING (OPERATION_PENDING, retry with the same key)
until the grace passes and then resumes (D-RUN-2); its journaled view carries the session placeholder (D-SESSION-2). CMD014
journals its 202 (D-RUN-1). The selection intake is content-idempotent without a journal entry (D-SEL-2). A rejected command
rolls its reservation back (B06 D-IDEM-2); DENY facts are written after the rollback (D-FACT-1).

## 8. Authorization (08)

| command | role (registry) | scope | resource relationship | step-up |
|---|---|---|---|---|
| CMD012 CreateRevision | AGENCY_OPERATOR (OWNER, ADMIN, OPERATOR) | AGENCY_HEADER | project visible under RLS | none |
| CMD013 ReserveUpload | AGENCY_OPERATOR | AGENCY_HEADER | revision visible | none |
| CMD014 CompleteUpload | AGENCY_OPERATOR | AGENCY_HEADER | upload visible and requested by the caller (D-SRC-2) | none |
| CMD015 CancelUpload | AGENCY_OPERATOR | AGENCY_HEADER | upload visible and requested by the caller (D-SRC-2) | none |
| CMD016 SelectInputTables | AGENCY_OPERATOR | AGENCY_HEADER | revision visible | none |
| CMD017 SealRevision | AGENCY_OPERATOR | AGENCY_HEADER | revision visible | none |

Steps 1–7 of B06 §6.1 (identity ACTIVE and verified — the launch policy's verified email and enrolled MFA, which is what 09's
"InitiateUpload ... checks MFA" asks of the actor, open question Q-B07-5; live ACTIVE membership after its transition lock; role),
then the journal, then the command. No B07 command names `assuranceProofRef` (the catalogue carries none), so none takes a
step-up. A foreign and a nonexistent resource answer alike (NOT_FOUND); every DENY is a durable fact; a session delivery is an
ALLOW fact (D-SESSION-4). The database repeats the boundary (D-ROLE-2): a request handler that computed an admission, an expiry or
READY_TO_SEAL cannot commit it, and no role can back-date an instant (D-CLOCK-1).

## 9. API routes, DTOs, response schemas and safe errors (10)

### 9.1 Routes

| route | operation | role | success | view |
|---|---|---|---|---|
| POST /api/v1/projects/{projectId}/revisions | CMD012 CreateRevision | AGENCY_OPERATOR | 201 COMPLETED | CreateRevisionView |
| POST /api/v1/revisions/{revisionId}/uploads | CMD013 ReserveUpload | AGENCY_OPERATOR | 201 COMPLETED | ReserveUploadView (session hydrated for the requester) |
| POST /api/v1/uploads/{uploadId}/complete | CMD014 CompleteUpload | AGENCY_OPERATOR | 202 ACCEPTED | B06 ACCEPTED envelope |
| POST /api/v1/uploads/{uploadId}/cancel | CMD015 CancelUpload | AGENCY_OPERATOR | 200 COMPLETED | CancelUploadView |
| POST /api/v1/revisions/{revisionId}/selection | CMD016 SelectInputTables | AGENCY_OPERATOR | 200 COMPLETED | SelectInputTablesView |
| POST /api/v1/revisions/{revisionId}/seal | CMD017 SealRevision | AGENCY_OPERATOR | 200 COMPLETED | SealRevisionView |
| POST /api/v1/revisions/{revisionId}/selection-manifests | SubmitSelectionManifest (D-SEL-2) | AGENCY_OPERATOR | 201 (200 with `created: false` for a body already stored), STORED envelope | SelectionManifestIntakeView |
| GET /api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId} | GetSelectionManifest | AGENCY_READER | 200 | SelectionManifestView |
| GET /api/v1/revisions/{revisionId} | GetRevision | AGENCY_READER | 200 | SourceRevisionView |
| GET /api/v1/revisions/{revisionId}/inspection | GetInspection | AGENCY_READER | 200 | InspectionView |
| GET /api/v1/revisions/{revisionId}/uploads | ListUploads (keyset, B06 cursor) | AGENCY_READER | 200 | UploadPage |
| GET /api/v1/uploads/{uploadId} | GetUpload (the ACCEPTED status path) | AGENCY_READER | 200 | UploadView |
| GET /api/v1/uploads/{uploadId}/session | GetUploadSession (D-SESSION-2) | AGENCY_OPERATOR, requester only | 200 | ProtectedSessionView |
| GET /api/v1/revisions/{revisionId}/tables/{tableId}/preview | PreviewTable (D-SAPI-7) | AGENCY_READER | 200 | TablePreviewView |

Manual 10 also names `POST /revisions/{revisionId}/supersede`; the catalogue gives lineage to CMD012 (`supersedesRevisionId`) and
has no supersede command, so no such route is served (open question Q-B07-2).

### 9.2 Request schemas

`SOURCE_REQUEST_SCHEMAS` (`urn:kauro:api:v1:request:CMD012..CMD017`): closed 2020-12 objects whose properties are exactly the
catalogue fields, typed by the field vocabulary (version ≥ 1, id = lowercase RFC 9562 UUID, hash = 64 lowercase hex, count ≥ 0,
label with B06's control-character rule, text 1..4,096 — D-SAPI-2), `declaredFormat` narrowed to CSV or XLSX (D-SAPI-4). No schema
exposes a server-owned member (verified, admitted, scanState, state, agencyId, version, sha256, manifestHash, observedGeneration,
bytes). The selection manifest document has its own closed schema (`urn:kauro:api:v1:document:SelectionManifest`): 50 files, 4,096
tables, 800 selected columns, 1,024 projections and associations; `hiddenSheetAcknowledged` and `keyConfirmed` can only be `true`.

### 9.3 Response views

`SOURCE_VIEW_DEFINITIONS` (`@kauro/application` `sources/response-views.ts`), built by B06's `viewSchema`: UploadView
(UploadSession — `providerSessionSecretRef` and `observedGeneration` withheld with reasons), UploadInspectionView (separate
results: structure, scan state, SEMANTIC_NOT_YET_PROFILED, detected format, claim consistency, coverage, problem tokens, rejection
class), UploadPage, ProtectedSessionView (the only view that carries the session URL — `https://` only; enforced by the builder),
RevisionQuotaView, ReserveUploadView, RetentionView (RetentionRecord), SourceRevisionView (DatasetRevision — `manifestHash` and
`projectionHash` withheld because a mutable revision has none and served in `seal`; `scope` and `files` withheld), the inspection
views (InspectionFileView projects FileManifest — `storageRef` and `providerGeneration` withheld), RevisionImpactView,
ProjectRevisionPointerView, the four command results (SealRevisionView carries `manifestHash`, `projectionHash` and
`sealedSubjectHash`), SelectionManifestIntakeView, SelectionManifestView and TablePreviewView. Every view is closed; every registry
member of a projected contract is selected or withheld with its reason; the test builds and compiles them with the strict
validator and validates samples. Views carry `permittedActions` over the six B07 operations (informative, never authority). The
planned reply envelopes (`buildSourceResponseSchemas`): a COMPLETED envelope per command but CMD014 (B06's ACCEPTED), a READ
envelope per read, a STORED envelope for the selection manifest intake.

### 9.4 Safe errors

`SOURCE_COMMAND_OUTCOMES` and `SOURCE_ROUTE_OUTCOMES` are the closed catalogues, composed from B06's shared entries (framing,
admission, authentication, access, idempotency, platform) plus each route's own; the generated matrix §2a lists them. Codes are
manual 10's stable codes plus B06's PRECONDITION_FAILED, ADMISSION_LIMITED and INTERNAL_ERROR; reasons are registered
FAILURE_REASONS. No problem carries a bucket, an object name, a session URI, a generation, a cell value or a foreign resource's
existence.

### 9.5 OpenAPI

`tools/openapi.mjs` documents the routes the api registers under `paths` and every specified B07 route under `x-kauro-planned`
(D-API-1), both from the objects the validator compiles: request schemas, the planned reply envelopes and views, the outcome
catalogues per status, role, scope, idempotency, gate and cases. The check refuses a planned route that is registered or also
served, a repeated operationId and a forbidden member; a specified route missing from the document fails the generated-document
comparison. When mandate B07-COMMANDS registers a route, its views join `VIEW_DEFINITIONS`, its replies `COMMAND_RESPONSES` /
`READ_RESPONSES`, its catalogue `COMMAND_OUTCOMES` / `READ_OUTCOMES`, and it moves from `x-kauro-planned` to `paths`. The matrix
already covers the B07 machines, commands and routes (verify). Mandate B07-COMMANDS did so for all six commands, the seven reads and
the selection manifest intake (`INTAKE_RESPONSES`, `INTAKE_OUTCOMES`), and the matrix records their applicability (D-CMD-11,
D-CMD-16).

## 10. Deadlines and retention anchors

| anchor | written with (producer) | deadline it governs |
|---|---|---|
| UPLOAD_INITIATED | CMD013's reservation (request handler), at the upload's `created_at` | the application deadline, exactly 86,400 s later (quarantine and incomplete upload) |
| INPUT_ADMITTED | the admission (control plane) | — (evidence; the file follows its upload's window until sealed) |
| INTAKE_CANCELLED | the cancellation (request handler: CMD015, CMD012) | cleanup of its quarantine objects |
| INTAKE_REJECTED / INTAKE_EXPIRED | the rejection / the expiry (control plane) | cleanup of its quarantine and accepted objects |
| REVISION_SEALED | CMD017 (request handler), at `sealed_at` | the UNPAID record of every seal whose bytes this seal sealed first: hard deadline = this instant + 14 × 86,400 s (D-RET-3) |

Every anchor records the server's transaction time — the instant of the transition it is written with — and is bound to that
transition at COMMIT, so it survives any later failure and can neither move nor pre-empt another producer's; one anchor of a kind
per subject, so a retry, a second report or a replay never moves it; the hard deadline never moves and belongs to the bytes;
nothing expires early (D-EXP-1). The deletion inventory is `stored_objects`: every generation of every zone and class with its
state, result and provider residual, enumerable by project, revision or upload (`StoredObjectRepository.inventory`); a
DeletionReceipt (B16) is composed from it and the provider inventory comparison.

## 11. The six commands

Common to all (B06 D-PIPE-1): the access decision (nothing written), then the journal reservation (first write), then the
command's steps below; `expectedVersion` compared on the locked row (STALE_VERSION with `current`); every new version publishes its
event; every instant is the server's (D-CLOCK-1: the adapter writes `kauro.server_now()`); identical replay answers the journaled
result (`replayed: true`); another digest under the key is IDEMPOTENCY_CONFLICT with no effect; a crash before COMMIT leaves
nothing; every DENY is a durable fact.

### CMD012 CreateRevision — POST /api/v1/projects/{projectId}/revisions

Body `{expectedVersion (the project's), supersedesRevisionId}`.
1. lock the project (NOT_FOUND); 2. project version (STALE_VERSION); 3. project OPEN (PROJECT_NOT_OPEN), agency DRAFT or ACTIVE
after its transition lock (AGENCY_NOT_OPEN); 4. lock the predecessor: a revision of this project (INVALID_REQUEST /
UNKNOWN_REFERENCE) that is the project's current revision (PRECONDITION_FAILED / PREDECESSOR_NOT_CURRENT, `current` naming it);
5. predecessor SEALED → SUPERSEDED with `superseded_by_revision_id` (new_revision_explicitly_supersedes), the impact map from
`RevisionAuthorityInspector.boundTo(manifestHash)` and `CommercialScopeInspector` (plans, live approvals, commercial authorizations
— identified and recorded in `dataset_revision.superseded.v1`, never transferred; B08's EXECUTION_CONTROL routes them, and CMD025
already refuses an approval over a source that is not SEALED: SOURCE_EXPIRED); predecessor mutable → CANCELLED (cancel_revision,
reason REPLACED_BY_NEW_REVISION) with every upload in flight CANCELLED (reason REVISION_REPLACED; the database requests the
provider cancellation where a session was issued, D-ROLE-3; INTAKE_CANCELLED anchors) and their quota released; predecessor terminal → unchanged (lineage only);
6. INSERT the new DRAFT revision (v1, `supersedes_revision_id`, creator) — `dataset_revision.created.v1`; 7. move the project's
current revision (version + 1) — `project.current_revision_changed.v1`; 8. journal commit, 201 CreateRevisionView. The
replacement allowance is evaluated separately, by the commercial package, through `RevisionLineageReader` (Q-B07-17, §17).

OK: a new mutable input identity with explicit lineage; the sealed predecessor's bytes, manifest and record stay (history).
DENY: VIEWER/APPROVER/BILLING → 403 ROLE_INSUFFICIENT; foreign project → 404; stale project version → 409; predecessor of another
project → 400 UNKNOWN_REFERENCE; not the current revision → 409 PREDECESSOR_NOT_CURRENT; closed project → 409; no plan, approval or
commercial authority attaches to the new revision (the plans' source key names the predecessor's manifest hash; the new revision
has none).
RACE: two CreateRevision calls on one project version → one 201, one 409 STALE_VERSION (the project CAS; the database's
one-mutable and supersedes-once indexes close it too); identical retry → replay; same key, another body → 409; a crash between the
inserts commits nothing (one transaction, deferred FKs).

### CMD013 ReserveUpload — POST /api/v1/revisions/{revisionId}/uploads

Body `{expectedVersion (the revision's), declaredBytes, declaredFormat, displayName}`. Two units of work (D-RUN-2).
Unit of work 1: 1. lock the revision row (NOT_FOUND); 2. revision version (STALE_VERSION); 3. agency ACTIVE after its transition
lock (AGENCY_NOT_ACTIVE), project OPEN (PROJECT_NOT_OPEN), the project's mode still offered after its transition lock
(CAPABILITY_UNAVAILABLE / MODE_NOT_OFFERED); 4. revision DRAFT or UPLOADING (REVISION_NOT_ACCEPTING_UPLOADS); 5. declaredBytes ≥ 1
(EMPTY_DECLARATION on the field), ≤ 2,000,000,000 (FILE_TOO_LARGE); the ledger read for the messages REVISION_QUOTA_EXCEEDED,
REVISION_FILE_LIMIT, UPLOAD_CONCURRENCY_LIMITED — "The server rejects a declared size above the remaining project allowance before
creating the provider session" (09), and the database decides on the committed ledger (R2-052); 6. register the quarantine intent
(INTENDED, `quarantine/{agency}/{project}/{revision}/{upload}`), insert the upload RESERVED (fence 1; created at the server's time,
deadline + 86,400 s; requested by the acting person through their own live operator membership, D-PAIR-1), the UPLOAD_INITIATED anchor, `upload_session.reserved.v1`; a DRAFT revision → UPLOADING
(`dataset_revision.uploading.v1`); 7. attach the journal entry to the upload; COMMIT with the entry RESERVED.
Provider call: `ObjectStoragePort.createResumableSession` (exact name, no-overwrite precondition, declared length, origin; 10 s);
a failure answers 503 CAPACITY_UNAVAILABLE / SESSION_ISSUE_FAILED and the reservation stays pending for a retry with the key.
Unit of work 2: 8. the access decision again (a revoked membership ends it); 9. lock the revision row, then the upload: still
RESERVED, still this attempt's fence, deadline not passed on the server clock — otherwise the attempt is abandoned, the new session
cancelled best-effort, and the journal committed with the upload's current (terminal) view; 10. seal the session reference
(`SessionVaultPort.seal`, bound to agency, upload, requester, attempt) into `upload_session_secrets`; RESERVED → UPLOADING (issued at
the server's time, SHA-256 of the reference, provider horizon) — `upload_session.session_issued.v1`; 11. journal commit, 201
ReserveUploadView with the placeholder, hydrated for the requester (ALLOW fact D-SESSION-4).

OK: reserved bytes and one slot, a narrowly scoped resumable session for exactly one opaque destination, the 24-hour deadline.
DENY: VIEWER → 403; foreign revision → 404; INSPECTING revision → 409 REVISION_NOT_ACCEPTING_UPLOADS; 2e9 + 1 bytes → 409
FILE_TOO_LARGE; a third live session of the agency → 429 UPLOAD_CONCURRENCY_LIMITED; another member reading the session →
`UNAVAILABLE` / NOT_REQUESTER (the session reaches only its requester).
RACE: R2-052 — two reservations that fit alone, together over 5e9 → one 201, one 409 REVISION_QUOTA_EXCEEDED; identical retry →
the same reservation, the session re-delivered to the requester while it is UPLOADING; same key, another body → 409; a crash
after unit of work 1 → the retry resumes under a new fence; a crash after the provider call → the resumed attempt issues a new
session and the undelivered one is cancelled.

### CMD014 CompleteUpload — POST /api/v1/uploads/{uploadId}/complete

Body `{providerCompletionRef}`.
1. lock the revision row, then the upload (NOT_FOUND); requested by the caller (NOT_AUTHORIZED / UPLOAD_NOT_OWNED); 2. state:
RESERVED → 409 SESSION_NOT_ISSUED; CANCELLED → UPLOAD_CANCELLED; EXPIRED, or UPLOADING past its deadline on the server clock →
RESERVATION_EXPIRED; REJECTED → UPLOAD_TERMINAL; ADMITTED → UPLOAD_ADMITTED; VERIFYING under the same claim → the same 202 without
effect, under another claim → COMPLETION_CLAIM_CONFLICT (D-SAPI-5); 3. parse the reference into a claim
(`ObjectStoragePort.parseCompletionClaim`, pure; MALFORMED → 400 COMPLETION_REF_MALFORMED) and digest it; 4. UPLOADING → VERIFYING
with the claim (the database refuses it at or after the deadline, KA072) — `upload_session.completion_reported.v1` (→
UPLOAD_INSPECTION); 5. journal commit, 202 ACCEPTED (operationId = uploadId, VERIFYING, `/api/v1/uploads/{uploadId}`, 5 s).

OK: verification scheduled; the provider generation, length and hash, the scan coverage and the structure are observed before
admission by UPLOAD_INSPECTION (§12.1); completion remains asynchronous.
DENY: another member's upload → 403 UPLOAD_NOT_OWNED; a declared size or hash never marks a file ready — the request handler
cannot write the observation, the fence, a receipt, a file or ADMITTED (D-ROLE-2; database tests).
RACE: identical retry → the same 202; same key, another reference → 409 IDEMPOTENCY_CONFLICT; a duplicate completion under another
key → the same 202 (D-SAPI-5); CompleteUpload and CancelUpload serialize on the revision row, then the upload row: a cancellation
that commits first is answered UPLOAD_CANCELLED; a crash before COMMIT leaves the upload UPLOADING.

### CMD015 CancelUpload — POST /api/v1/uploads/{uploadId}/cancel

Body `{expectedVersion (the upload's)}`.
1. lock the revision row, then the upload (NOT_FOUND); requested by the caller (UPLOAD_NOT_OWNED); 2. upload version
(STALE_VERSION); 3. RESERVED, UPLOADING or VERIFYING — ADMITTED → 409 UPLOAD_ADMITTED (its file leaves by an exclusion or a new
revision), a tombstone → UPLOAD_TERMINAL; 4. → CANCELLED (reason CANCELLED_BY_REQUESTER; the database requests the provider
cancellation in the same update when a session was issued, D-ROLE-3): bytes, file and slot released exactly once by the quota trigger; the INTAKE_CANCELLED anchor;
`upload_session.cancelled.v1` (→ STORAGE_LIFECYCLE cancels the provider session and deletes the quarantine objects,
AUTHORITY_JOURNAL records the tombstone); the revision stays UPLOADING — when this was its last open upload, the agency closes the
intake with its selection (D-INTAKE-1); 5. journal commit, 200 CancelUploadView (releasedBytes).

OK: acceptance tombstoned, the provider session cancelled where supported (the result recorded: CONFIRMED, UNSUPPORTED or
UNCERTAIN, reconciled until the provider horizon), late objects cleaned (§12.3).
DENY: another member → 403; admitted → 409; a late completion never resurrects the upload (terminal state, KA008; no claim on a
tombstone, KA004; a stale inspection attempt attaches no receipt and admits no file, KA071) and freed quota is never consumed
twice (database tests).
RACE: cancellation while verification races → the cancellation and the inspection outcome serialize on the revision row
(D-LOCK-2), the stale attempt is refused; two cancels with one version → one 200, one 409 STALE_VERSION; identical retry → replay;
same key, another version → 409.

### CMD016 SelectInputTables — POST /api/v1/revisions/{revisionId}/selection

Body `{expectedVersion, selectionManifestRef}` (the document stored by the intake, D-SEL-2; the intake validates it structurally
and for internal consistency, and refuses a document naming another revision).
1. lock the revision (NOT_FOUND); 2. version (STALE_VERSION); 3. DRAFT, UPLOADING, INSPECTING or READY_TO_SEAL
(REVISION_NOT_SELECTABLE); 4. no upload in flight (UPLOADS_UNRESOLVED); 5. the manifest is one of this revision's
(UNKNOWN_REFERENCE); 6. the revision's current inventory hash equals the manifest's (SELECTION_STALE); 7. the manifest against the
inventory: every candidate file and table disposed (SELECTION_INCOMPLETE), known (SELECTION_UNKNOWN_TABLE), included files admitted
in the project (SELECTION_FILE_NOT_ADMITTED; a reused file whose bytes' retention ended or whose first seal is more than fourteen
days old: REUSE_NOT_AVAILABLE, D-RET-3), hidden sheets acknowledged (HIDDEN_SHEET_NOT_ACKNOWLEDGED), formula policy named
(FORMULA_POLICY_REQUIRED), exclusions with reasons, parser choices that fit, projections over included columns with confirmed keys,
≤ 800 columns, ≤ 50 files and 5e9 bytes (SELECTION_BYTES_LIMIT); 8. bind (manifest id, selection hash = the body's
KAURO_SOURCE_SELECTION_V1 digest, inventory hash, the server's time; version + 1): UPLOADING → INSPECTING (all_uploads_completed:
the agency's explicit closing of the intake, D-INTAKE-1), DRAFT → INSPECTING (previously_admitted_inputs_selected), READY_TO_SEAL →
INSPECTING with the counts cleared (selection_changes), INSPECTING stays — `dataset_revision.selection_changed.v1` with
`previousState` (→ SELECTION_EVALUATION); the database repeats step 7's file-and-table comparison row by row (D-SEL-4); 9. journal
commit, 200 SelectInputTablesView.

OK: explicit selected and excluded tables and parser choices persisted in the mutable revision; detected worksheets, hidden tables,
formulas, parser issues and projections were visible for review (GetInspection, PreviewTable).
DENY: foreign → 404; VIEWER → 403; a changed inventory → 409 SELECTION_STALE; a hidden sheet included without acknowledgement → 400.
RACE: two selections on one version → one 200, one 409; a selection racing an inspection outcome of the revision's last open upload
→ ordered by the revision row: a selection that waits reads the settled upload (D-INTAKE-1); identical retry → replay; same key,
another manifest → 409; a crash leaves the previous selection bound.

### CMD017 SealRevision — POST /api/v1/revisions/{revisionId}/seal

Body `{expectedVersion, selectionHash}`.
1. lock the revision (NOT_FOUND); 2. version (STALE_VERSION); 3. READY_TO_SEAL — SEALED → 409 REVISION_SEALED, otherwise
REVISION_NOT_READY_TO_SEAL; 4. `selectionHash` is the bound selection's (STALE_VERSION / HASH_MISMATCH, `mismatch:
["selectionHash"]`); 5. no upload in flight (UPLOADS_UNRESOLVED); 6. the complete evaluation of the bound selection and every
included file: ADMITTED, at the generation, digest and length the evaluation counted (INPUT_NOT_ADMITTED, GENERATION_CHANGED), and
at the generation and length the provider holds under its accepted name, held at the provider before the unit of work — the hold
recorded INTENDED, then placed with the counted generation as precondition — (GENERATION_CHANGED; GENERATION_NOT_OBSERVED, 503;
B07-R1, D-CMD-9, D-HOLD-1, D-HOLD-2);
7. compose the revision manifest — HASHING's exact preimage: the accepted files (generations, digests, lengths), the table
selection with dispositions and exclusion reasons, the parser profile and choices, the projection with the projection ids the
seal mints — and its hash (D-HASH-1); compose the sealed subject (the revision and its predecessor, the manifest, projection,
selection and evaluation hashes, the populations with per-table and per-projection counts, the admitting receipts, the uploads
inspection rejected with their classes, the input envelope) and its hash (D-HASH-4); 8. the first seal of the bytes
(`SealedManifestRepository.firstSeals`: this seal, or an earlier seal of a reused file) — a hard cap already behind this seal →
409 REUSE_NOT_AVAILABLE (D-RET-3); insert the sealed manifest and subject and the file set — sealed at the server's time and bound
at COMMIT to this very seal (D-SEAL-1) — (each included file read after its transition lock), each included file's provider hold SEALED (D-HOLD-2), the REVISION_SEALED anchor, the UNPAID record anchored on the first seal (hard = first seal + 14 days) —
`retention_record.created.v1`; READY_TO_SEAL → SEALED with the manifest, projection and counts at the server's time —
`dataset_revision.sealed.v1`; 9. journal commit, 200 SealRevisionView. At COMMIT the database checks the whole sealed subject (§4).

OK: manifest, bytes, parser settings and billable-unit interpretation sealed atomically; only this manifest can be profiled and
quoted.
DENY: foreign → 404; VIEWER → 403; a changed generation or a revoked admission → 409 and no sealed revision; an incomplete scan
never reached admission (§12.2); a stale version → 409.
RACE: a seal and an intake-expiry revocation of one of its files (both interleavings, the file's transition lock); a late upload
cannot enter (a READY_TO_SEAL revision accepts no reservation and has none in flight); two seals → one 200, one 409 (the loser's hold
closed, nothing the winner retains released); identical retry → replay; same key, another hash → 409; a crash leaves the revision
READY_TO_SEAL; a provider replacement of an included generation before the hold lands fails the placement's precondition (409), and
one after the hold and before the commit is refused by the provider (the held generation), so the seal commits the generation the
provider still holds (B07-R1 re-check, D-HOLD-1). A seal that does not commit closes and releases its holds; a crash between the
hold and the commit leaves them INTENDED for RETENTION (D-HOLD-3).

## 12. Control-plane pipelines (mandate B07-CONTROL)

Each runs in SYSTEM units of work bound to the work item's agency (D-CTRL-1), at least once, idempotent by fences and listed
transitions, on the server clock (D-CLOCK-1), taking the revision row before any upload or file of it (D-LOCK-2); provider calls
sit outside transactions.

### 12.1 UPLOAD_INSPECTION (`upload_session.completion_reported.v1`, provider notifications)

1. lock the revision row, then claim the attempt: `inspection_fence + 1` while VERIFYING (anything else: DONE); the database stamps
the claim instant, which `claimInspectionAttempt` returns as the attempt's `startedAt` (D-INSP-4). 2. `stat` the quarantine name:
absent → VERIFYING → UPLOADING, claim cleared, the negative observation recorded (`completion_not_observed_at`, the control plane's
alone, D-ROLE-3) — `completion_not_observed.v1` (the requester may report again before the deadline; refused after it); present → record the observation (set once) with the claim's consistency —
`completion_observed.v1`; the quarantine object INTENDED → PRESENT. The revision is never moved (D-INTAKE-1). 3. Outside any
transaction: read the exact generation, recomputing SHA-256; the bounded container inspection (`ContainerInspectorPort`, isolated
per D-ISO-1: no write outside the attempt scratch, no network, no unbounded decompression, with the isolation evidence in the
result); scan the container at its observed length and every allowed part (`MalwareScannerPort`), derive the scan state against
the object (D-SCAN-1); the scan instant is read from the database clock after the scan (`serverInstant()`), never from the
worker's or the scanner's. 4. Admissible → promote: register the accepted intent (`accepted/{agency}/{project}/{file}`), copy the exact
generation with a no-overwrite precondition, observe and re-read, compare the digest (else PROMOTION_UNVERIFIED). 5. One unit of
work (revision row first): the receipt of this attempt (KA071 if a cancellation won; KA072 if it does not describe the observation,
or if its instants are not the attempt's: started at the claim, scanned after the observation and within the attempt, completed no
later than the server clock, recorded at the server's time — D-INSP-4)
and either the file (`source_file.admitted.v1`), its tables and columns, ADMITTED — `upload_session.admitted.v1`, INPUT_ADMITTED — or
REJECTED with its class — `upload_session.rejected.v1`, INTAKE_REJECTED. An admission at or after the deadline is refused by the
database; the deadline sweeper expires the upload instead. A TRANSIENT_INFRASTRUCTURE failure retries within the deadline.

### 12.2 SELECTION_EVALUATION (`dataset_revision.selection_changed.v1`)

If the revision still binds that selection and is INSPECTING: `SelectionEvaluatorPort.evaluate` opens every included table's
accepted generation by exact generation, re-verifies its digest while parsing under the selected parser choices, applies the
projection and counts physical rows, logical records, billable units and association edges exactly (03 "Count the correct
population"; 04 "Facts used as proof must be exact"; bounded memory, attempt-owned scratch). COMPLETE → the evaluation and
INSPECTING → READY_TO_SEAL with its counts — `dataset_revision.ready_to_seal.v1`; ADMISSION_FAILED → the evaluation and INSPECTING →
REJECTED — `dataset_revision.rejected.v1` (no silent removal); ERROR → retry or dead letter.

### 12.3 STORAGE_LIFECYCLE (upload cancelled, expired, rejected; revision cancelled, expired)

Open the sealed secret and cancel the provider session (`cancelResumableSession` → CONFIRMED, UNSUPPORTED or UNCERTAIN, recorded
by this pipeline only with `upload_session.provider_cancellation_recorded.v1` — a request handler can neither write the result nor
publish the event, D-ROLE-3; UNCERTAIN is reconciled until the provider horizon; the secret is purged once resolved); request deletion of the upload's quarantine objects and, for expired unsealed intake or an expired revision, its
accepted generations; delete each exact generation — an accepted one's seal hold released first when nothing needs it (D-HOLD-3) —
and record the result with its residual at the server's time (D-OBJ-2). A late
object observed after the tombstone (a stat, a notification or inventory) is registered RESIDUAL, late, and deleted the same way —
it never enters a revision.

### 12.4 AUTHORITY_JOURNAL

Appends the tombstone of every terminal authority fact to `AuthorityJournalPort` (idempotent by event id, KAURO_AUTHORITY_TOMBSTONE_V1):
exactly the kind and state `AUTHORITY_TOMBSTONES` names for the routed event — upload acceptance revoked (cancelled, expired,
rejected), revision cancelled, superseded, rejected, expired, deleted, and a file's admission revoked (FILE_ADMISSION_REVOKED,
ADMISSION_REVOKED; re-check N5, D-RESTORE-2) — after reading the subject in that terminal state (a subject found in another state is an integrity
incident, dead-lettered, never tombstoned; D-RESTORE-1).

### 12.5 Sweepers

Sweepers (SOURCE_SWEEPERS): UPLOAD_DEADLINES, PROVIDER_SESSION_RECONCILIATION, RETENTION, OBJECT_INVENTORY, DELETION_RETRIES, LOCATION_POLICY.

UPLOAD_DEADLINES (live uploads past their deadline on the server clock → EXPIRED with INTAKE_EXPIRED, provider cancellation
REQUESTED when a session was issued; admitted uploads past it whose file no seal ever included → EXPIRED and the file revoked
INTAKE_EXPIRED — the database refuses the revocation of a sealed file and of a window still open; the revision stays as it is,
D-INTAKE-1); PROVIDER_SESSION_RECONCILIATION (REQUESTED or UNCERTAIN cancellations until the provider horizon; past it, the bearer
records still held, found per agency and purged, B07-R4); RETENTION (ACTIVE
records past their effective deadline → EXPIRED; SEALED revisions with no ACTIVE record ahead and REJECTED revisions whose windows
closed → EXPIRED; sealed files whose including revisions hold no ACTIVE record ahead → revoked RETENTION_EXPIRED, D-RET-3, their
seal holds released at the provider before the accepted generation is deleted; seal holds still INTENDED past their bound — a crash
between the hold and the commit — abandoned and released, and releases never answered driven again past the bound, D-HOLD-3);
OBJECT_INVENTORY (provider listing against the registry: orphans registered RESIDUAL and deleted; soft-deleted generations recorded
with the provider's expiry; a missing or changed accepted generation revokes its file — GENERATION_MISSING, GENERATION_CHANGED);
DELETION_RETRIES; LOCATION_POLICY (reads back every location's retention and versioning at start and daily, recorded at the
server's time; load-bearing, since a deletion cannot be recorded at a location never read back, D-OBJ-2). 09 "Acceptance and operating checks": overdue inspection,
abandoned reservations, unknown provider sessions, orphan blobs, unregistered generations, failed deletion and retained bytes by
class are each one of these sweeps' reports.

## 13. The scenario cases in B07 terms

- **S024** (XLSX with traversal, duplicate entries, XML entities or excessive expansion → reject without outside writes, network
  access or unbounded decompression): decided by the container inspector under the conjunctive limits (1 GiB per part, 20 GiB
  total, entries, ratio, XML depth, no DTD/entities, no external relationships, normalized paths inside the archive root); the
  receipt records CORRUPT_STRUCTURE / ACTIVE_CONTENT / RESOURCE_LIMIT with problem tokens. The isolation is D-ISO-1: the test
  observes, on the Windows verify host as on Linux, the attempt scratch (nothing outside it), the permission model's refusal count,
  the network hooks' attempt log (empty) and the decompressed-byte counter (≤ the bound), each with its negative control (a probe
  that writes outside is refused and counted, a probe that connects is recorded). The OS-level network denial of the worker host is
  LATER: B15 — not claimed here.
- **S053** (a false size/hash or another generation → observe actual bytes/generation before admission or sealing): the claim is a
  claim; the server's stat is the observation (set once); a receipt must describe that observation and a file names exactly the
  promoted generation, digest and length of its receipt (database tests); the seal re-checks the evaluation's generations.
- **S054** (the antivirus exits clean because the file exceeded its scan limit → NOT_SCANNED/BLOCKED; a fully covered harmless file
  passes): D-SCAN-1/D-SCAN-2 in the domain (tests: skipped part, short read, stale or future signatures, nothing expected, unpinned
  configuration, a container missing or at another length than observed) and in the database (`inspection_receipts_clean_means_covered`
  over the receipt's own coverage document, the pinned signature age measured at a scan instant inside the attempt, D-INSP-4; the
  covered neighbour).
- **R2-051** (the reservation expires at twenty-four hours while the provider session stays usable → tombstone acceptance, cancel
  the provider session where supported, late objects stay quarantined and are cleaned): the deadline sweeper on the server clock,
  STORAGE_LIFECYCLE and the registry (database test: no early expiry, no acceptance after the deadline, the late report refused,
  the late object RESIDUAL and deleted with its residual at the server's time, a read-back dated back refused); the provider
  cancellation requested by the database with a request's tombstone and recorded only by the control plane (D-ROLE-3).
- **R2-052** (two files each fit → only the combination within 5e9 bytes): D-UP-2 (database test with the lock-wait interleaving).

## 14. Open questions for the authority

| # | question | interim decision |
|---|---|---|
| Q-B07-1 | 09 says CompleteUpload "reads provider metadata, verifies no-overwrite behavior, records actual size"; the catalogue says completion remains asynchronous. Must the request read the provider synchronously? | D-RUN-1: the request records the claim and answers 202; the control plane observes. The observation columns and event exist, so a synchronous stat can move into the command without a schema change. |
| Q-B07-2 | Manual 10 names `POST /revisions/{revisionId}/supersede`; the catalogue has no supersede command and gives lineage to CMD012. | CMD012 carries lineage (supersede or cancel the predecessor); no supersede route. |
| Q-B07-3 | The signature freshness policy (09 "stale signatures beyond the recorded policy") has no registry value. | 86,400 s, pinned in the domain and the database (D-SCAN-2). |
| Q-B07-4 | The provider session lifetime when the adapter reports none. | 604,800 s (D-SESSION-3). |
| Q-B07-5 | Is 09's "checks MFA" the launch policy's enrolled MFA, or a fresh step-up? The catalogue CMD013 names no proof. | Enrolled MFA and verified email (B06 VERIFIED_USER); no step-up. |
| Q-B07-6 | May an OWNER cancel another member's upload? | Requester only (D-SRC-2); the deadline sweeper tombstones abandoned uploads within 24 h. |
| Q-B07-7 | UploadSession has no display name, declared format or requester members although CMD013 carries displayName and declaredFormat. | Platform columns and view members. |
| Q-B07-8 | DatasetRevision requires manifestHash and projectionHash, which a mutable revision cannot have. | SourceRevisionView withholds them and serves them in `seal`; propose making them optional in the contract. |
| Q-B07-9 | The preview bounds (09/10 give none). | 20 rows × 50 columns × 200 characters (D-SAPI-7). |
| Q-B07-10 | CMD016 names a `selectionManifestRef`, but no catalogue command stores the manifest. | The non-journaled, content-idempotent intake route (D-SEL-2). |
| Q-B07-11 | The registry's "Rejected-input cleanup deadline" has no value. | The upload's own 24-hour window (D-RET-1). |
| Q-B07-12 | How a soft-deleted generation's expiry is recorded when the location policy changed after its deletion. | The provider-reported expiry (PROVIDER_REPORTED); our own deletions use the latest read-back (D-OBJ-2). |
| Q-B07-13 | B06 review R3 kept the control plane from appending events; the source lifecycle's control-plane edges need them. | D-CTRL-2 (listed types, SERVICE actor, bound agency, B07 kinds and `dataset_revision` only). |
| Q-B07-14 | CMD013 `declaredFormat` is typed `label`. | Narrowed to CSV or XLSX (D-SAPI-4), as B06 narrows `mode`. |
| Q-B07-15 | A mutable revision whose intake all expired has no command that closes it (the catalogue has no CancelRevision). | It stays mutable (UPLOADING, accepting uploads) with the INTAKE_DEADLINE_PASSED blocker until the agency uploads again, selects, or CMD012 replaces it (cancel_revision). |
| Q-B07-16 | Whether uploads need an ACTIVE agency (07: DRAFT permits no customer-data execution). | Yes (D-SRC-1; B06 D-CMD-2). |
| Q-B07-17 | CMD012's "replacement allowance is evaluated separately": policy `pricing.customerPreExecutionSourceReplacementsIncluded = 1` belongs to the commercial scope. Where is it counted, and against which quote? | B07 records explicit lineage and the impact map and offers `RevisionLineageReader.replacementsSince(revisionId)`; the commercial package counts the allowance against the quote bound to the replaced revision (B09's checkout re-check, or B10's quote issuance). `b09/design` does not treat the allowance yet; §17 makes it an integration obligation. |
| Q-B07-18 | HASHING's KAURO_SOURCE_REVISION_V1 preimage names "projection" without saying whether the projection's identity (the minted ProjectionId) is part of it. If it is content-only, two seals of identical reused bytes have one manifest hash, and B06's unique (agency, project, manifest_hash) — the source hash plans bind — refuses the second seal. | The preimage is exactly HASHING's four members; the projection carries the ProjectionIds the seal mints (SourceLocator.projectionId identifies the declared projection of one sealed revision), so every seal is its own manifest; the revision and the populations live in the separate sealed subject (D-HASH-1, D-HASH-4). If the authority rules otherwise, a versioned amendment of the preimage is proposed instead of widening it silently. |
| Q-B07-19 | The registry guard of all_uploads_completed ("Actual provider completion is observed for selected uploads") names no command, and the catalogue has none that closes an intake. | The agency's selection (CMD016 on an UPLOADING revision) is the explicit act (D-INTAKE-1); a dedicated CloseIntake command would need a catalogue entry. |
| Q-B07-20 | 09 caps unpaid sources at "fourteen days from sealing" without saying which seal governs bytes a later revision reuses. | The first seal of the bytes (D-RET-3): a re-seal never restarts the cap; reuse after the window needs a new upload. |
| Q-B07-21 | Whether a revision's rejection (fatal_input_rejection) is an authority fact a restore must re-apply. | Yes: tombstoned as REVISION_REJECTED (D-RESTORE-1), so a restore never brings back an INSPECTING revision whose selected input failed the admission contract. |
| Q-B07-22 | B06 lets a request handler append any registered event type for a version of an aggregate of its tenant; nothing binds an event's type to the transition its version records, for B06's aggregates or B07's. Should the foundation bind them (a registered (kind, event type, target state) table checked at COMMIT)? | B07 refuses the control plane's event types to the request handlers (D-ROLE-3) and every consumer verifies the subject's state before its effect (07; §6, D-RESTORE-1). A foundation-wide binding would be a change to B06's event table for every package and is proposed rather than forked here. |
| Q-B07-23 | 09 names the unconfirmed provider cancellation SESSION_REVOCATION_PENDING; the registry's UploadSession.providerCancellationState has REQUESTED and UNCERTAIN. | REQUESTED (requested, no answer yet) and UNCERTAIN (answered without confirmation) together are SESSION_REVOCATION_PENDING; both are reconciled until the provider horizon (§12.5); the registry vocabulary is kept. |
| Q-B07-24 | 09 "Soft delete, versioning and holds" speaks of holds as exceptional preservation ("a hold requires authority, reason, applicable scope, start, expiry, review owner and permitted access"); the seal's integrity hold (B07-R1) is a provider hold used routinely for every sealed generation, for no longer than the retention of its bytes. | Treated as a technical integrity hold, not a legal or preservation hold: a temporary object hold whose record carries every element 09 names (D-HOLD-1), released by RETENTION when the bytes' admission ends and before any deletion (D-HOLD-3), so it never extends retention or blocks a lawful early deletion; propose the manual name it explicitly, and B15 confirm Cloud Storage's hold semantics and quotas under EXECUTED_PROVIDER. |

## 15. Handoff: the implementation mandates, in two stages

Five mandates in two stages, so a workflow can run each stage in parallel worktrees. Every mandate is self-contained (its files,
cases and done criteria), keeps `pnpm run verify` green, and writes its tests under exactly the titles `docs/design/B07-case-map.md`
names (the case-map check, `tools/test/b07-case-map.test.mjs`, refuses an EXECUTED_LOCAL row whose test does not exist and a planned
file outside this section). Common rules: real PostgreSQL 17 everywhere, never a database fake; no sleep synchronizes anything
(interleavings by hold points and lock waits observed in `pg_stat_activity`); every lifecycle instant is written as
`kauro.server_now()`, and tests stand in the past only through the labelled TEST CLOCK; migrations 0009–0012 change only for a
defect a test finds, with the runtime boundary matrix re-reviewed. Every provider fake has exactly one owner: it implements its
port's documented contract, reports `evidenceClass: "SIMULATED"` and `contract-fake-*` provider tokens in every record it produces,
lives only under a test-only `testing` subpath (architecture rule `testOnlySubpaths`), is bound by no deployable composition root,
and is never counted as real integration (B15 binds the real adapters). The container inspector and the selection evaluator are not
providers: they are the platform's own parsers, always real.

**Stage 1** — three mandates, each branching from `b07/design` at the head that carries this revision; they depend on nothing else
and touch disjoint files. When the three are green, the integrator creates `b07/stage-1` from that same head, merges them in the
order PERSISTENCE → DATA-PLANE → PROVIDER-FAKES (the only shared file is `pnpm-lock.yaml`, regenerated with `pnpm install` after the
merge), and runs `pnpm run verify` there.

**Stage 2** — two mandates, each branching from `b07/stage-1`; they consume the stage-1 adapters and fakes and own no fake. The
integrator merges them into `b07/integration` (from `b07/stage-1`) in the order COMMANDS → CONTROL (the only shared file is
`pnpm-lock.yaml`, regenerated: COMMANDS owns `apps/api` and the application's source handlers, CONTROL owns `apps/control`), runs
`pnpm run verify`, and the end-to-end cases of the case map run there.

| mandate | stage | starts from | builds | owns fakes | demonstrates |
|---|---|---|---|---|---|
| **B07-PERSISTENCE** | 1 | `b07/design` (this revision's head) | the `pg` adapters of every source-store repository (`packages/persistence/src/source/*`), `runSource` and `serverInstant()` on the B06 unit of work with the SYSTEM context bound to an agency (D-CTRL-1), the read ports `SourceAvailabilityReader` and `RevisionLineageReader`, `SealedManifestRepository.firstSeals` over real seals (D-SEAL-1) and `RetentionRepository.insertUnpaidRecord` (D-RET-3), `claimInspectionAttempt` returning the database's claim instant (D-INSP-4), `recordLocationPolicy` returning the server's instant, `cancel_upload` without a provider cancellation (the database stamps it, D-ROLE-3), the refusal translation of §3.3 in `sqlstate.ts`, the exports | none — no provider port is reached | `packages/persistence/test/source-adapters.test.ts`: every repository method through the runtime roles; every stamp the server's (no caller instant reaches SQL); R2-052 and the capacity race through `UploadSessionRepository.insert` (lock-wait observed, typed losers); a reservation as the acting person only (D-PAIR-1); CAS and fences; `recordDeletion` computing the residual from `locationPolicyAt` (refused at a location never read back); `recordProviderResidual`; `revokeAdmission` with its event (KA072 when sealed by a real seal or when the window is open); content-idempotent `SelectionManifestRepository.put`; `firstSeals` of reused bytes; no early `expireRecord`; `availabilityOf` and `replacementsSince`; tenant isolation of `runSource` |
| **B07-DATA-PLANE** | 1 | `b07/design` (this revision's head) | `packages/data-plane` (`@kauro/data-plane`, layer adapter): `ContainerInspectorPort` in its isolated child process (D-ISO-1: Node permission model, network hooks, isolation evidence; streaming SHA-256; CSV dialect facts; XLSX through a hardened ZIP/XML reader — no traversal, absolute or duplicate names, no DTD, entities or external relationships, 1 GiB per part and 20 GiB total with a ratio bound, XML depth; worksheet inventory with visibility, formulas and cache, merged cells, hidden rows and columns, positional columns with label states; the expected scan parts with the container at its verified length; the parser profile hash), `SelectionEvaluatorPort` (exact counts, bounded memory, attempt scratch), the preview reader (D-SAPI-7); the test-only subpath `@kauro/data-plane/testing` with the labelled contract fake of `MalwareScannerPort` (per-part coverage, skips with exit code 0, timeouts, the EICAR token, stale signatures, scan instants read from the database clock) | `MalwareScannerPort` | `container-inspection.test.ts` (the S024 corpus built in the test, each refused with its class; no write outside the scratch, no network attempt, decompression within the bound — each observer with its negative control), `scan-coverage.test.ts` (S054), `selection-evaluation.test.ts` (every selected file and table counted against an independent counter; hidden sheets only when selected; formulas inert) |
| **B07-PROVIDER-FAKES** | 1 | `b07/design` (this revision's head) | the test-only subpath `@kauro/application/testing` (package.json export `./testing`, `src/testing/index.ts`; B06's in-memory ports stay where they are) with the labelled contract fakes of `ObjectStoragePort` (generations with no-overwrite preconditions; resumable sessions usable past the application deadline until a configurable provider horizon; cancellation answering CONFIRMED, UNSUPPORTED or UNCERTAIN as scripted; stat, exact-generation read, copy with a generation precondition; soft delete with a configurable retention read-back; listings; a call log), `SessionVaultPort` (AES-256-GCM with a test key, the binding — agency, upload, requester, attempt — as associated data) and `AuthorityJournalPort` (append-only file, idempotent by event id, listed in sequence order) | `ObjectStoragePort`, `SessionVaultPort`, `AuthorityJournalPort` | `packages/application/test/source-provider-fakes.test.ts`: each fake against its port contract (the storage session outliving the application deadline, the scripted cancellation answers, the refused overwrite, the vault refusing another binding, the journal's idempotence and order), each labelled SIMULATED |
| **B07-COMMANDS** | 2 | `b07/stage-1` | the six handlers (§11) with the two-phase runtime of CMD013 (D-RUN-2), the ACCEPTED path of CMD014 (D-RUN-1, D-SAPI-5) and CMD016's intake closure (D-INTAKE-1), the selection intake and the reads (SOURCE_ROUTES) with session hydration and its security fact (D-SESSION-2, D-SESSION-4); served in `apps/api` by joining `SOURCE_*` to `SERVED_COMMAND_IDS`, `COMMAND_RESPONSES`, `VIEW_DEFINITIONS`, `COMMAND_OUTCOMES` and `READ_OUTCOMES` — the routes move from `x-kauro-planned` to `paths`; the matrix applicability rows of CMD012–CMD017; permitted actions; the pre-B09 `CommercialScopeInspector` (a production implementation answering "no commercial authorization exists", replaced by B09's reader at integration, §17 item 7 — not a fake); in tests the storage and vault fakes of `@kauro/application/testing` | none — consumes PROVIDER-FAKES' | `apps/api/test/cmd012-create-revision.test.ts` … `cmd017-seal-revision.test.ts` and `source-reads.test.ts`: OK, DENY and RACE of every command through the real route and composition root |
| **B07-CONTROL** | 2 | `b07/stage-1` | `apps/control` (`@kauro/control`, entrypoint): the consumers UPLOAD_INSPECTION, SELECTION_EVALUATION, STORAGE_LIFECYCLE, AUTHORITY_JOURNAL over B06's dispatch store and leases, each verifying the subject's state before its effect (§6), the sweepers of `SOURCE_SWEEPERS` (§12.5), each unit of work revision-row first (D-LOCK-2); in tests the scanner fake of `@kauro/data-plane/testing` and the storage, vault and journal fakes of `@kauro/application/testing` | none — consumes DATA-PLANE's and PROVIDER-FAKES' | `apps/control/test/upload-inspection.test.ts` (S053, S024 end to end, CMD014-OK continuation, the revision left UPLOADING), `storage-lifecycle.test.ts` (R2-051, CMD015-OK), `retention-sweeper.test.ts` (records, revisions and RETENTION_EXPIRED revocations never early), `authority-journal.test.ts` (every routed kind, expired and rejected revisions and revoked file admissions included; nothing tombstoned for a subject not in the tombstone's state) |

## 16. Verification performed on this branch

`pnpm run verify` ran at the worktree root on Windows 11 (Node 24, pnpm 10.16.1, PostgreSQL 17 from `C:\Tools\pgsql17\bin`) and
exited 0 on this revision: generate, build, typecheck, test, architecture gate, OpenAPI check, matrix check and clean consume. Test
counts: contracts 12/12, domain 64/64, application 66/66, persistence 141/141, authorization 11/11, api 117 passed and 1 skipped
(the skip is B06's, unchanged), tools 27/27. No temporary PostgreSQL cluster was left running (`tasklist` shows no `postgres.exe`
after the run).

- **Migrations from empty.** `packages/persistence/test/migrations.test.ts` "every migration applied once, in order, with its
  checksum recorded; a second run applies nothing" lists the twelve files `0001..0012` through the B06 runner on a fresh cluster
  (without the TEST CLOCK, `startTemporaryPostgres({ testClock: false })`), and "B07 D-CLOCK-1: the shipped kauro.server_now() is
  the transaction time and nothing else — …" checks the shipped clock function; every other persistence test file starts its own
  cluster from empty through the same runner.
- **Runtime boundary.** `packages/persistence/test/fixtures/runtime-boundary.json` was re-read from a migrated cluster and its ten
  changes against `bfac6b1` reviewed entry by entry — `kauro_control` UPDATE (version) on `source_files` (F9),
  `aggregate_kinds_read_b07_control` (F7), the control plane's revision policy without INSPECTING (F1), its event policy (F1, F9),
  the anchor policies per role and kind (split read/insert for the request handlers and the control plane's kinds, F3), the
  UNPAID-only record policy (F3), and the secret read policy on the server clock (F2); nothing else changed. This revision's
  changes against `f243248`, reviewed entry by entry: `kauro_app` loses UPDATE on `provider_cancellation_state` and
  `provider_cancellation_at` (N2); `kauro_control` gains SELECT on `completion_not_observed_at` and `inspection_claimed_at` and
  UPDATE on `completion_not_observed_at` (N2, N3 — nobody writes the claim instant, the database stamps it); the control plane's
  event policy reads its list from `kauro.source_control_event_types()` (same twelve types, N2); two new restrictive policies,
  `domain_events_tenant_not_source_control` (N2) and `upload_sessions_tenant_requester` (N4); nothing else changed. The boundary
  records a policy's command, roles and expressions, not whether it is permissive or restrictive; the behavioural tests (N2, N4 and
  the role-edges test) prove the restrictive ones restrict.
- **Revert proofs.** Each database fix was re-opened in place in its migration, the test that demonstrates it was run and failed,
  and the file was restored byte for byte (SHA-256 checked). The critique's fixes were proved at `f243248` (prefixes then: 0009
  `991ac07e5e19`, 0010 `96e353e13808`, 0011 `840615f0f679`, 0012 `0a9e8225d0df`):

  | finding | mutation | test (source-migrations.test.ts) | result |
  |---|---|---|---|
  | B07-F1 | 0011: the guard no longer requires the binding for all_uploads_completed | "B07-F1: the intake closes only …" | fails |
  | B07-F2 | 0009: `upload_sessions_window_clock` returns before checking | "B07-F2: every lifecycle instant …" | fails |
  | B07-F3 | 0012: the request handlers' anchor insert policy accepts any kind | "B07-F3: request handlers write no retention evidence …" | fails |
  | B07-F4 | 0010: `clean_means_covered` no longer calls `kauro.scan_coverage_complete` | "S054 at the database: …" | fails |
  | B07-F5 | 0011: the UNPAID record anchored on this revision's own seal | "B07-F5: the unpaid hard cap belongs to the bytes …" | fails |
  | B07-F9 | 0010: `source_files_event_per_version` removed | "B07-F9: an admitted file is an aggregate …" | fails |
  | B07-F10 | 0009: the ledger trigger without its WHEN clause | "B07-F10: the ledgers are checked …" | fails |
  | B07-F11 | 0011: `kauro.check_selection_inventory` not called | "B07-F11: the database compares a selection …" | fails |

  The remaining findings are not a single migration clause to re-open: F7 is resolved by the foundation (the registry rows and
  the control-plane read policy, checked by `aggregate-kinds.test.ts`); F8, F12 and F13 are contract checks whose subject did not
  exist on `bfac6b1` (the tombstone mapping, the authority preimage and sealed subject, the planned operations and sweeper list —
  §18 names each test); F14 is the ordering rule D-LOCK-2, whose test observes the second unit of work waiting on the revision row
  in `pg_stat_activity` in both interleavings; F6 is specified for the DATA-PLANE mandate with its observables and negative
  controls (D-ISO-1), not claimed here.

  The re-check's fixes were proved on this revision (a script re-opened each clause, ran the test by name through
  `node --test --test-name-pattern`, and restored the file; every unmutated test passed afterwards; final prefixes: 0009
  `1f7f8d806a00`, 0010 `a92c87eb064d`, 0011 `33cc8d289fd1`, 0012 `d99488c3603a`):

  | finding | mutation | test (source-migrations.test.ts unless named) | result |
  |---|---|---|---|
  | N1 | 0011: `sealed_revision_files_bound` not created | "N1: sealed manifests and sealed file rows …" | fails (the late INCLUDED row commits) |
  | N1 | 0011: `kauro.sealed_rows_bound` returns before checking and `sealed_manifests_server_clock` not created | "N1: …" | fails |
  | N1 | 0011: the seal-facts rule of the lifecycle guard disabled | "N1: …" | fails (a seal instant on an UPLOADING revision commits) |
  | N1 | 0011: `kauro.is_real_seal` counts any sealed manifest row | "N1: …" | fails (the INTAKE_EXPIRED revocation is refused "was sealed") |
  | N2 | 0009: the request handlers' UPDATE grant on the provider cancellation result restored | "N2: the provider-session evidence …" | fails (CONFIRMED under the handler's own event type commits) |
  | N2 | 0009: `domain_events_tenant_not_source_control` not created | "N2: …" | fails (a control-plane event type commits) |
  | N2 | 0009: completion_not_observed without the negative observation | "N2: …" | fails (the handler reopens the session) |
  | N2 | 0009 / 0011: the set-once rule of an upload's outcome / a revision's terminal facts disabled | "N2: …" | fails, each |
  | N3 | 0010: the receipt's instants no longer bounded | "S054 at the database: …" | fails (the re-checker's receipt commits) |
  | N3 | 0009: `storage_location_policies_server_clock` not created | "R2-051 at the database: …" | fails (a read-back dated back commits) |
  | N4 | 0012: the record's client and project bound by separate keys again | "N4: tenant-scope pairs …" | fails (another client's record commits) |
  | N4 | 0009: `upload_sessions_tenant_requester` made permissive | "N4: …" | fails (the refusal is no longer the policy's; a VIEWER's reservation would commit) |
  | N4 | 0009: `upload_sessions_requester_fk` on the membership alone | "N4: …" | fails (the mismatched pair commits) |
  | N5 | `packages/domain/src/model/events.ts`: the AUTHORITY_JOURNAL routing of `source_file.admission_revoked.v1` removed (domain rebuilt) | `packages/application/test/source-contracts.test.ts` "N5: …" and "B07-F8: …"; `packages/domain/test/source-model.test.ts` "every B07 event type …" | all three fail |

### 16.1 Verify tail

```
✔ B07-F13: the source-lifecycle routes are documented from their contracts as planned operations — every specified command and route, never registered, never also served; a missing planned route, a registered planned route, a repeated operationId and a forbidden DTO member fail the check (35.597ms)
ℹ tests 27
ℹ pass 27
ℹ fail 0

> kauro-platform@0.1.0 arch
> node tools/architecture-gate.mjs
architecture gate: 6 package(s), 13 edge(s), no violation

> kauro-platform@0.1.0 openapi
> node tools/openapi.mjs check
openapi: the document is the generated one and matches the 14 registered routes (14 operations, every operationId present, response schemas equal to the ones the routes validate with, every problem status documenting exactly its route's outcome catalogue, no forbidden field); 14 planned operations, none registered or served

> kauro-platform@0.1.0 matrix
> node tools/matrix.mjs check
matrix: the document is the generated one (18 machines, 185 edges and initial states each owned, 7 commands and 5 reads with their catalogues, every applicability citation resolved)

> kauro-platform@0.1.0 clean-consume
> node tools/clean-consume.mjs
clean consumer ok: 73 contracts, 64 commands, provenance 9608c2de39ae
clean consumer ok: @kauro/application 154 exports
clean consumer ok: @kauro/domain 184 exports
clean consumer ok: @kauro/persistence 49 exports
clean consumer ok: @kauro/persistence/testing 28 exports
clean consumer ok: 10 typed entry points (...) type-check from the tarballs alone
clean-consume: every publishable package installs and works from its tarball alone
VERIFY EXIT 0
```

### 16.2 Verification of `b07/stage-1`

`b07/stage-1` is the design head `ef284df` with the three stage-1 branches merged in the order of §15 — `b07/persistence`
(`f30be87`, merge `816fed5`), `b07/data-plane` (`32ee7eb`, merge `5cf868d`), `b07/provider-fakes` (`f5bd9d0`, merge `df6c20b`) —
and the integrator's commits after them. The first two merged cleanly. The third conflicted only in the two design documents,
where two mandates wrote next to each other: the decisions register after D-ISO-1 (B07-DATA-PLANE's D-DP-1..6 beside
B07-PROVIDER-FAKES' revised D-RESTORE-1, D-RESTORE-2 and D-FAKE-1) and the R2-051 rows of the case map (B07-PERSISTENCE's adapter
rows beside the three SIMULATED rows that replaced the SPECIFIED provider-fake citation). Both were resolved by keeping both sides,
with the revised rows replacing the ones they revise. `pnpm-lock.yaml` merged without conflict. It gains only the
`packages/data-plane` importer (workspace links, no external dependency), and `pnpm install --frozen-lockfile` accepts it
unchanged. No migration, `runtime-boundary.json` entry or dependency changed. The merged tree passed `pnpm run verify` on Windows
before any integrator change (persistence 159/0, data-plane 11/0, api 117 passed and 1 skipped, tools 27/0).

The integrator then made these changes:

- D-STAGE1-1: the fixture's provider and parser tokens, the check that each fake has one owner, and the stage-1 composition test.
- The closure of the final re-check's residuals (§18.2), with each fix's revert proof re-run on the merged tree.
- The case map's rows: B07-DATA-PLANE's rows reclassified as EXECUTED_LOCAL or SIMULATED, and the new rows.
- The case map's status table, which `tools/test/b07-case-map.test.mjs` checks against the sections.
- The `@kauro/data-plane` suite in `tools/evidence.mjs`: the evidence test now requires a suite for every workspace package that
  has tests.
- The README's package table.

`pnpm run verify` at `15cc1a7`, after `pnpm install --frozen-lockfile`:

- **Windows 11** (Node 24, pnpm 10.16.1, `C:\Tools\pgsql17\bin`): exit 0.
  - Tests: contracts 12/12, domain 64/64, application 73/73, persistence 159/159, authorization 11/11, data-plane 12/12, api 117
    passed and 1 skipped (B06's Linux-only test, unchanged), tools 29/29.
  - Checks: architecture gate 7 packages and 16 edges with no violation; OpenAPI 14 registered and 14 planned operations; matrix
    18 machines; clean-consume 13 typed entry points, among them `@kauro/application/testing`, `@kauro/data-plane` and
    `@kauro/data-plane/testing`.
  - No `postgres.exe` of this run was left. A cluster seen running afterwards had been started by another workflow's run in its
    own worktree, and this run did not touch it.
- **Linux** (WSL Ubuntu 24.04 as `miguel`, a fresh clone checked out at `b07/stage-1`, `PGBIN=/usr/lib/postgresql/17/bin`):
  exit 0.
  - Tests: the same counts, except api 118/118 (the Linux-only test runs).
  - No `postgres` process was left, and the clone was removed.

```
architecture gate: 7 package(s), 16 edge(s), no violation
openapi: the document is the generated one and matches the 14 registered routes (14 operations, every operationId present, response schemas equal to the ones the routes validate with, every problem status documenting exactly its route's outcome catalogue, no forbidden field); 14 planned operations, none registered or served
matrix: the document is the generated one (18 machines, 185 edges and initial states each owned, 7 commands and 5 reads with their catalogues, every applicability citation resolved)
clean consumer ok: @kauro/application/testing 19 exports
clean consumer ok: @kauro/data-plane 24 exports
clean consumer ok: @kauro/data-plane/testing 6 exports
clean consumer ok: @kauro/persistence 69 exports
clean consumer ok: @kauro/persistence/testing 32 exports
clean consumer ok: 13 typed entry points (...) type-check from the tarballs alone
clean-consume: every publishable package installs and works from its tarball alone
VERIFY EXIT 0
```

**For the stage-2 mandates** (from `b07/stage-1`):

- **B07-COMMANDS** writes the SPECIFIED (B07-COMMANDS) rows of the case map. Its `cmd014-complete-upload.test.ts` "DENY" title is
  now also cited under R2-051, for the late CompleteUpload.
- **B07-CONTROL** writes the SPECIFIED (B07-CONTROL) rows, including the revised R2-051 title (FINAL-N3). That test asserts the late
  completion at the source store; it does not assert the 409.
- CONTROL's AUTHORITY_JOURNAL appends FILE_ADMISSION_REVOKED only for a file in ADMISSION_REVOKED (D-RESTORE-2).
- CONTROL's RETENTION sweeper expires a REJECTED revision without re-explaining its reason (D-PERS-3).
- `apps/control` needs its own suite in `tools/evidence.mjs`: the evidence test requires one for every workspace package that has
  tests.
- Neither mandate creates a fake. `tools/test/b07-stage-one.test.mjs` refuses a second implementation of any provider port
  anywhere in the tree.
- When a stage-2 mandate writes a cited test, the integrator of `b07/integration` moves that row from SPECIFIED to EXECUTED_LOCAL
  or SIMULATED and updates the status table.

### 16.3 Verification of `b07/commands` (mandate B07-COMMANDS)

`b07/commands` branches from `b07/stage-1` (`cfaf7a4`). Mandate B07-COMMANDS was interrupted by a usage limit after two commits
(`8179411`, the six handlers, the source reads and the selection manifest intake; `5dc3479`, serving them in `apps/api`) with the
OpenAPI move, the CMD013 test and its fixtures uncommitted. The resumed run reviewed that work and kept it, fixed what the tests
found, and wrote the rest of the mandate:

- Every B07-COMMANDS row of the case map has its test under its exact title, through the real route and composition root:
  `apps/api/test/cmd012-create-revision.test.ts` … `cmd017-seal-revision.test.ts` (22 cited titles), plus
  `source-reads.test.ts` and `source-role-matrix.test.ts`. The rows moved from SPECIFIED to EXECUTED_LOCAL, or to SIMULATED where
  the clause rests on the labelled storage or vault fake; the status table counts them (13 EXECUTED_LOCAL, 10 PARTIAL, 0 MISSING —
  five cases wait for B07-CONTROL's pipeline half, five for a later package).
- The matrix serves CMD012..CMD017 with their applicability rows and documents the source routes and the intake (D-CMD-16); the
  OpenAPI document lists every B07 route under `paths` and plans nothing (D-CMD-11).
- Decisions D-CMD-6..D-CMD-17 record what the implementation fixed where the design was silent or had to be corrected, among them
  the answers the route catalogues were missing or listed wrongly (D-CMD-6, D-CMD-17), the file read after its transition lock
  (D-CMD-7), the generation re-check of the seal (D-CMD-9), the storage fake's https session URI (D-CMD-12), the preview reader of
  the tests (D-CMD-13) and the test harness (D-CMD-15).
- Defects the tests found and the run fixed: the lock observation of the RACE tests matched a part of the statement
  `pg_stat_activity` does not keep (a statement is truncated at 1,024 bytes; D-CMD-15); the control-plane fixture published the
  admission revocation under a payload key the allowlist refuses (`revocationReason`); the reservation fixture declared a length
  its bytes did not have (the storage fake refuses it, as a provider does); `source-contracts.test.ts` still asserted the catalogue
  entry D-CMD-17 removes; `@kauro/data-plane` had to be a dependency, not a devDependency, of `apps/api` (the architecture gate).
- No migration, `runtime-boundary.json` entry or external dependency changed; the lockfile gains only the api's workspace link to
  `@kauro/data-plane`. No fake was created (`tools/test/b07-stage-one.test.mjs` passes).

`pnpm run verify` at `1b63f5c`, after `pnpm install --frozen-lockfile`, on **Windows 11** (Node 24, pnpm 10.16.1,
`C:\Tools\pgsql17\bin`): exit 0 — contracts 12/12, domain 64/64, application 73/73, persistence 159/159, authorization 11/11,
data-plane 12/12, api 145 passed and 1 skipped of 146 (B06's Linux-only test), tools 30/30; architecture gate 7 packages and 17
edges with no violation; OpenAPI 28 registered operations and none planned; matrix 18 machines, 13 commands, 12 reads and 1 intake;
clean-consume 13 typed entry points. Every temporary cluster of the run was created under the run's own scratch directory and
stopped and removed afterwards. The commit after `1b63f5c` adds this section only.

**For the `b07/integration` integrator** (merge order COMMANDS, then CONTROL): the shared files this branch edits are listed in the
mandate's report. `b07/control` also appends decisions after D-PERS-8, a section 16.3 before §17, lines at the end of the case map,
a row after the api row of the README and an importer to `pnpm-lock.yaml`; keep both sides and renumber the two 16.3 sections. Then
move B07-CONTROL's rows from SPECIFIED and update the status table (`tools/test/b07-case-map.test.mjs`); B07-CONTROL's pipeline
tests may now drive CMD012..CMD017 through these routes instead of their fixtures, and `apps/api/test/source-support.ts`'s
control-plane writes may give way to the consumers of `apps/control`.

### 16.4 Mandate B07-CONTROL on `b07/control`

`b07/control` branches from `b07/stage-1` (`cfaf7a4`) and adds `apps/control` (`@kauro/control`, layer entrypoint): the outbox
dispatcher over B06's `PgOutboxDispatchStore` and OUTBOX_DISPATCH leases (D-CTRL-4); the consumers UPLOAD_INSPECTION (§12.1,
D-CTRL-6), SELECTION_EVALUATION (§12.2), STORAGE_LIFECYCLE (§12.3, D-CTRL-7) and AUTHORITY_JOURNAL (§12.4, D-CTRL-8); the six
sweepers of `SOURCE_SWEEPERS` (§12.5); and the composition root (`assembleControlPlane`, `openControlDatabase`, `platformParsers`),
which binds the verified `kauro_control` pool and the platform's own parsers and takes the provider ports from its caller. No
production source of the package imports a test-only subpath (checked by `composition.test.ts` and the architecture gate). The tests
bind the scanner fake of `@kauro/data-plane/testing` and the storage, vault and journal fakes of `@kauro/application/testing`
(SIMULATED); no fake is created (`tools/test/b07-stage-one.test.mjs` passes unchanged).

Edits outside `apps/control`, each recorded in the register:

- `packages/domain/src/ports/source-store.ts` and `packages/persistence/src/source/inspection.ts`: the discovery reads
  `SourceFileRepository.findRetentionEnded` and `admittedGenerations` (D-CTRL-5). Additive; no migration or grant changes.
- `packages/persistence/src/source/objects.ts`: the retained check of `requestDeletion` also follows `source_files.accepted_object_id`
  (D-CTRL-3). Revert proof: with the check joined on the object's own file link only, `apps/control/test/upload-inspection.test.ts`
  "OK: …" fails (the control plane's request to delete the accepted generation of a standing admission commits); restored byte for
  byte (SHA-256 `bff05e41…`), it passes.
- `tools/evidence.mjs`: the `control` suite, as `tools/test/evidence.test.mjs` requires for every workspace package with tests.
- `README.md`: the `@kauro/control` row. `pnpm-lock.yaml`: the new importer (workspace links and the already pinned `@types/node`
  and `typescript`; no new external dependency).
- `docs/design/B07-case-map.md`: supporting-evidence citations of the control tests without a case row of their own (the RETENTION
  sweeper, the unobserved completion, the D-LOCK-2 pipeline race, OBJECT_INVENTORY with DELETION_RETRIES, the composition root). The
  six SPECIFIED (B07-CONTROL) rows now name tests that exist under exactly those titles and pass; they stay SPECIFIED for the
  integrator of `b07/integration` to move (§16.2) with the status table.

Migrations `0009`–`0012` and `runtime-boundary.json` are unchanged.

`pnpm run verify`:

- **Windows 11** (Node 24, pnpm 10.16.1, `C:\Tools\pgsql17\bin`) at `d4720fe`: exit 0. Tests: contracts 12/12, domain 64/64,
  application 73/73, persistence 159/159, authorization 11/11, data-plane 12/12, control 11/11, api 117 passed and 1 skipped (B06's
  Linux-only test), tools 29/29. Architecture gate 8 packages and 21 edges with no violation; OpenAPI 14 registered and 14 planned
  operations; matrix 18 machines; clean-consume 13 typed entry points. No `postgres.exe` was left running.
- **Linux** (WSL Ubuntu 24.04, a fresh clone of `b07/control` at `d4720fe`, `PGBIN=/usr/lib/postgresql/17/bin`): exit 0, the same
  counts except api 118/118 (the Linux-only test runs); no `postgres` process was left and the clone was removed. The head
  `bfb879c` adds one assertion to the OK test of `upload-inspection.test.ts` (the revert proof of D-CTRL-3); the control suite
  passed 11/11 there on Linux, and `pnpm run verify` of the branch head on Windows exits 0 with the counts above.

```
apps/control test: ℹ tests 11
apps/control test: ℹ pass 11
apps/control test: ℹ fail 0
architecture gate: 8 package(s), 21 edge(s), no violation
openapi: the document is the generated one and matches the 14 registered routes (14 operations, every operationId present, response schemas equal to the ones the routes validate with, every problem st…
matrix: the document is the generated one (18 machines, 185 edges and initial states each owned, 7 commands and 5 reads with their catalogues, every applicability citation resolved)
clean consumer ok: @kauro/application/testing 19 exports
clean consumer ok: @kauro/data-plane 24 exports
clean consumer ok: @kauro/data-plane/testing 6 exports
clean consumer ok: @kauro/persistence 69 exports
clean consumer ok: @kauro/persistence/testing 32 exports
clean consumer ok: 13 typed entry points (@kauro/application, @kauro/application/testing, @kauro/authorization, @kauro/contracts, @kauro/contracts/canonical, @kauro/contracts/digest, @kauro/contracts/…
clean-consume: every publishable package installs and works from its tarball alone
VERIFY EXIT 0
```

### 16.5 Integration record of `b07/integration`

`b07/integration` = `b07/stage-1` (`cfaf7a4`) + `b07/commands` (`7bec85d`, merge `82fdd1b`, clean) + `b07/control` (`8fbfe11`, merge
`b4d6e44`). Conflicts only in `README.md` (the api row of COMMANDS next to the control row), the case map (both sides'
supporting-evidence lines) and this design (D-CMD-6..17 next to D-CTRL-3..8; CONTROL's §16.3 renumbered §16.4). The shared persistence
edits of both branches (`lockShared` of D-CMD-7; `findRetentionEnded`, `admittedGenerations` of D-CTRL-5; the retained check of D-CTRL-3)
merged without conflict. `pnpm install --frozen-lockfile` passed on the merged lockfile; the merged tree passed the control (11/11) and
api (145 + 1 skipped) suites and the arch, openapi (28 served, none planned) and matrix checks before any integrator change.

Seams (D-INT-1). `apps/control/test/end-to-end.test.ts`, four tests, every request through the application's handler and every
continuation through the control plane: the sealed path and the supersession tombstone; CancelUpload and the mutable replacement
through STORAGE_LIFECYCLE and AUTHORITY_JOURNAL (the vault opens the handler's sealed reference under the handler's binding); FINAL-N3;
S024/S053 rejections read back through GetUpload/GetInspection, then one whole `runCycle` and object inventory that find nothing to
repair. Checked by them: CMD014's and CMD016's payload keys against UPLOAD_INSPECTION and SELECTION_EVALUATION, the recorded claim, the
quarantine name and location CMD013 registers, the session binding and provider horizon, and every read view over rows the real control
plane wrote. No seam failed; negative control: without `revisionId` in CMD014's `upload_session.completion_reported.v1` payload the
first test fails (UPLOAD_INSPECTION dead-letters), restored byte for byte (SHA-256 `b68badad…`) it passes.

Residuals, closed on the merged tree:

| residual | test (b07/integration) | proof |
|---|---|---|
| FINAL-N1 | `packages/application/test/source-contracts.test.ts` "B07-F8: …", "N5: …"; `apps/control/test/authority-journal.test.ts` "tombstones of cancelled, …" (a RETENTION revocation tombstoned FILE_ADMISSION_REVOKED / ADMISSION_REVOKED) | state `REVOKED` restored in `source-providers.ts`: the control test fails (delivered 7, dead-lettered 2); restored (`17cb2523…`) it passes |
| FINAL-N2 | `packages/persistence/test/source-adapters.test.ts` "FINAL-N2: …"; `apps/control/test/retention-sweeper.test.ts` "RETENTION on the server clock, never early: …" (REJECTED → EXPIRED keeps its reason) | `terminal_reason = $3` in `revisions.ts`: the sweeper test fails (INTEGRITY_FAILURE, KA004); restored (`0a083495…`) it passes |
| FINAL-N3 | `apps/control/test/storage-lifecycle.test.ts` "R2-051: …" (source store); `apps/api/test/cmd014-complete-upload.test.ts` "DENY: …" (HTTP 409); both halves together: `apps/control/test/end-to-end.test.ts` "FINAL-N3 on b07/integration: …" | cited under R2-051 in the case map |

Case map: the six B07-CONTROL rows moved from SPECIFIED to SIMULATED; the end-to-end rows added; the status table renamed
"Status at `b07/integration`" and checked with no SPECIFIED row left. 23 cases: 13 EXECUTED_LOCAL, 10 PARTIAL (open only in B15, B16,
B08, B09/B10, B03), 0 MISSING.

`pnpm run verify` at `6484675` after `pnpm install --frozen-lockfile`: **Windows 11** (Node 24.14.1, pnpm 10.16.1,
`C:\Tools\pgsql17\bin`) exit 0 and **Linux** (WSL Ubuntu 24.04, fresh clone of `b07/integration`, Node 24.21.0,
`PGBIN=/usr/lib/postgresql/17/bin`) exit 0. Tests: contracts 12, domain 64, application 73, persistence 159, authorization 11,
data-plane 12, control 15, api 146 (Windows 145 + 1 skipped, B06's Linux-only test), tools 30 — none failed. Architecture gate 8
packages and 23 edges; OpenAPI 28 served operations, none planned; matrix 18 machines, 13 commands, 12 reads, 1 intake; clean-consume
13 typed entry points. No PostgreSQL process left on either host; the clone was removed. The next commit adds this paragraph only.

For the B07 + B09 merge (lane B): §17 items 1–15 stand as written; item 16 is done (B07 lands from `b07/integration`). Additions of
stage 2 it meets: `SourceFileRepository` gained `lockShared` (D-CMD-7), `findRetentionEnded` and `admittedGenerations` (D-CTRL-5),
additive; item 7 also binds CMD012's `CommercialScopeInspector` in `apps/control/test/support/product.ts` (the edition's "none before
B09", as `apps/api` `edition.ts`); item 13's matrix now serves 13 commands, 12 reads and 1 intake; `@kauro/control` depends on
`@kauro/authorization` (tests only, D-INT-1); the evidence suites include `control`.

## 17. Integration obligations (B07 and B09 on main)

B07 and B09 were designed in parallel on the same base (`ac44af6`). Neither references the other's tables; they touch through
ports, shared B06 tables and shared files. When both land, the integrator (done on `integration/b07-b09`; the record, its seam tests and
its one migration of its own, 0018, are `docs/design/B07-B09-merge.md`):

1. **Migrations.** Keeps B07's `0009..0012` and renumbers B09's files after them (or the reverse, whichever merges second),
   contiguous from 0001 (the runner refuses gaps); re-applies from empty; both packages' tests are the proof. B09's own
   `aggregate_kinds` table and binding rewrite (its 0008 on `b09/design`) must be replaced by rows of the foundation registry, as
   B07 did (Q-B09-13 / D-AGGK-5). B07's 0012 adds one key to B06's `projects` (`projects_client_scope`, D-PAIR-1): the from-empty
   run proves B09 adds no constraint of that name.
2. **Aggregate-kind registry.** Both packages register rows (`upload_session`, `source_file`, `retention_record` by B07; the eight
   commerce kinds by B09) and each event-inserting group gets its own read policy: `aggregate_kinds_read_b07_control`
   (`kauro_control`) and B09's for `kauro_payment`. `aggregate-kinds.test.ts`'s expected inserters become
   `[kauro_app, kauro_control, kauro_payment]`, its expected policies both package policies, its `TABLE_OF` every kind; `@kauro/domain`
   `AGGREGATE_KINDS` the union.
3. **`kauro.event_types`, `EVENT_TYPES`, `EVENT_PAYLOAD_ALLOWLIST`, `CONSUMERS`, `EVENT_SUBSCRIPTIONS`** (`packages/domain/src/model/events.ts`):
   concatenate both packages' entries (disjoint prefixes: `upload_session.`, `source_file.`, `retention_record.`, `dataset_revision.selection_changed.v1`,
   `project.current_revision_changed.v1` vs B09's commerce types); both migrations lift FORCE RLS on `event_types` in their own
   transaction (Q-AGGK-2). B07's restrictive policy `domain_events_tenant_not_source_control` (`kauro_app` only, over
   `kauro.source_control_event_types()`, D-ROLE-3) stays as it is: B09's types are not in B07's list and `kauro_payment` is not
   `kauro_app`; if B09 restricts its own service's event types the same way, its list is a function of its own. The new
   subscription `source_file.admission_revoked.v1 → AUTHORITY_JOURNAL` (N5) is B07's.
4. **`dataset_revisions`.** B07 adds lifecycle columns, a lifecycle guard and policies; B09 grants `kauro_payment` column-scoped
   SELECT (ids, state, manifest hash, sealed) and takes the revision's shared transition lock before issuing a commercial
   authorization (its KP004 check "the quoted source revision SEALED"). B07's `retention_expires` takes the exclusive half of the
   same lock (the lifecycle guard), so the two serialize in either order: the integrator adds one cross-package RACE test — a
   retention expiry racing authorization issuance, both interleavings, observed in `pg_stat_activity` — and extends B09's column
   grant with nothing of B07's (B09 reads no B07 column).
5. **Source availability (quotes).** B09's `quotes.source_available_until` is supplied by the quote issuer (B10's CMD027) and
   re-checked at checkout and capture; its source of truth is B07's retention: the integrator binds `SourceAvailabilityReader`
   (`@kauro/domain` ports, implemented by B07-PERSISTENCE) where B10 issues a quote (sourceAvailableUntil ≤ availableUntil) and
   where B09's checkout and capture re-check SOURCE_EXPIRED (state SEALED and availableUntil in the future on the server clock).
   The hard cap belongs to the bytes (D-RET-3): a quote for a revision that reuses bytes inherits the earlier cap. `b09/design`
   binds `SourceAvailabilityReader` and its `SourceLineageReader` to CONTRACT_FAKE implementations until B07 is on main: the
   integrator removes those fakes and binds B07-PERSISTENCE's adapters, and B09's `SourceLineageReader` becomes B07's
   `RevisionLineageReader` (one port under B07's name; item 6).
6. **Replacement allowance (Q-B07-17).** `b09/design` does not count `pricing.customerPreExecutionSourceReplacementsIncluded`; the
   integrator assigns it to the commercial package that re-checks a quote (B09 checkout or B10 issuance), which reads
   `RevisionLineageReader.replacementsSince(quotedRevisionId)`; B07 needs no change.
7. **Commercial scope of CMD012.** `CommercialScopeInspector.authorizationsBoundTo` (`@kauro/application` source-providers) is
   bound to B09's `commercial_authorizations` reader so `dataset_revision.superseded.v1` names affected authorizations; until then
   CMD012 records none.
8. **`packages/persistence/src/sqlstate.ts`.** Merge both ranges (KA070–KA072 for B07, KP001–KP011 for B09) and both
   `LABEL_CONSTRAINT_FIELDS` additions (`upload_sessions_display_name_label`, `refunds_reason_code_label`).
9. **`@kauro/domain` shared files.** `FAILURE_REASONS` (errors.ts: union of both lists), `PlatformMachineName` and `machine()`
   (state-machines.ts: both machine lists), `SystemContext` (tenant.ts: B07's optional bound `agencyId` beside B09's SERVICE and
   OPERATOR contexts), the ports index.
10. **The persistence harness and temporary cluster.** `temporary-postgres.ts`: B09's `kauro_payment_test` login and B07's TEST
    CLOCK (installed after the logins; `testClock: false` for the migrations test); `harness.ts`/`testing/index.ts`: both packages'
    fixtures (B07's `sealedRevision` through the source lifecycle; B09's payment pool, `service()`, `operator()`); `unit-of-work.ts`:
    B09's commerce unit of work and B07's `runSource`/`serverInstant` (mandate B07-PERSISTENCE) on the same B06 factory. B09's
    commerce fixtures that seal a source call B07's fixture (`sealSourceRevision`), which writes the receipt at its attempt's
    claim (D-INSP-4) and the retention record with the project's own client (D-PAIR-1); a B09 fixture that inserts a retention
    record or an upload itself must follow the same keys.
11. **`runtime-boundary.json`.** Re-read from a cluster migrated with both packages and reviewed: the union of both packages'
    reviewed entries, nothing else.
12. **OpenAPI (`tools/openapi.mjs`, `apps/api/openapi.json`, `tools/test/openapi.test.mjs`).** Both packages implement the same
    `x-kauro-planned` mechanism (root member, "METHOD path" keys, identical check rules and messages, the `planned` loop in
    `checkOpenApi`): keep one copy of the mechanism, both packages' planned blocks (B07's commands and source routes; B09's
    commerce commands and reads) and both runtime-schema additions (`buildSourceResponseSchemas`, `buildCommerceResponseSchemas`),
    then regenerate the document; both packages' tests stay.
13. **Matrix (`tools/matrix.mjs`, `tools/test/matrix.test.mjs`).** Union of both owner tables and machine lists (the expected
    machine count becomes 18 + B09's ten), regenerate `docs/design/B06-state-command-event-matrix.md`.
14. **`@kauro/application` index and api registries.** Both `export * from "./sources/index.js"` and the commerce exports;
    `api/outcomes.ts` and `api/response-schemas.ts` exports both packages need.
15. **Test-only subpaths of the provider fakes.** B07-PROVIDER-FAKES adds `@kauro/application/testing` (package.json export
    `./testing`, `src/testing/index.ts`) and B07-DATA-PLANE `@kauro/data-plane/testing`; B09's contract fakes (payment provider,
    webhook verifier, evidence store, fiscal bridge, service authenticator) live under `test/` or a `testing` subpath. If both
    packages publish through `@kauro/application/testing`, the integrator keeps one export and one index re-exporting both sets;
    each fake keeps its single owner and its SIMULATED / CONTRACT_FAKE label, and no composition root binds any of them.
16. **B07's own two stages.** The integration of B07 itself is staged (§15): `b07/stage-1` (PERSISTENCE, DATA-PLANE, PROVIDER-FAKES
    from this design head) and then `b07/integration` (COMMANDS, CONTROL from `b07/stage-1`); B07 lands on main from
    `b07/integration`, and the renumbering of item 1 applies to whichever of B07 and B09 lands second.

## 18. Critique record

Every finding of the adversarial critique of `bfac6b1` (`.claude/b07-b09-design-review/critic_B07.json`), with its disposition.
Test names are in `packages/persistence/test/source-migrations.test.ts` (SM) unless another file is named.

| id | status | disposition and evidence |
|---|---|---|
| B07-F1 (BLOCKING) | FIXED | Confirmed against 09 "Initial intake envelope" + "Upload reservation" and the registry guard. D-INTAKE-1: all_uploads_completed is CMD016's explicit act (the guard requires the binding in the same update; the control plane's policy no longer admits INSPECTING and its event policy no longer lists `dataset_revision.inspecting.v1`); every settle point and the selection take the revision row first (D-LOCK-1, D-LOCK-2). Migrations 0009 (policies), 0011 (guard). Tests: SM "B07-F1: the intake closes only by the agency's explicit selection — …" (the three-file intake with two sessions; fails on `bfac6b1`, whose guard let the control plane close the intake as soon as nothing was open and refused the selection on UPLOADING) and SM "B07-F1: the last open upload cancelled (CMD015), expired (the deadline sweeper) or rejected (an inspection outcome) never strands the revision: …". |
| B07-F2 (MAJOR) | FIXED | Confirmed: every guard compared writer-supplied instants. D-CLOCK-1: `kauro.server_now()`; `upload_sessions_window_clock`, the revision guard's instant check, `retention_anchors_server_clock`, `retention_records_server_clock`, the file admission/revocation and deletion checks; the labelled TEST CLOCK for fixtures (`@kauro/persistence/testing`), the fixture never back-dates. Tests: SM "B07-F2: every lifecycle instant is the server's — …" (the critic's forward-dated reservation, expiry at the deadline value, fifteen-day back-dated seal, 99-day anchor, far-future record and revision expiries, a completion report after the deadline — all refused; negative control on the test clock) and `packages/persistence/test/migrations.test.ts` "B07 D-CLOCK-1: the shipped kauro.server_now() is the transaction time and nothing else — …". |
| B07-F3 (MAJOR) | FIXED | Confirmed against B06 D-EVID-1. D-ANCH-2: anchor policies per role and kind, `retention_anchors_bound` at COMMIT, the UNPAID-only record policy for the request handlers anchored on this transaction's seal. Migration 0012. Test: SM "B07-F3: request handlers write no retention evidence they do not own — …" (the critic's LEGAL_FINANCIAL-until-2100 record and control-plane anchors refused; the sweeper's expiry then commits). |
| B07-F4 (MAJOR) | FIXED | Confirmed against 09 "Scanner coverage" and S054. D-SCAN-1/2: `kauro.scan_coverage_complete` (exactly one CONTAINER part at the observed length, every part complete, counts and sums equal the coverage document), `signature_max_age_seconds = 86400`; the domain's `evaluateScanCoverage` takes the object and pins the age (CONTAINER_NOT_COVERED). Tests: SM "S054 at the database: …" (the critic's 1-of-100-bytes receipt with six-day-old signatures refused, the container missing or short, a widened age) and `packages/domain/test/source-model.test.ts` "B07-F4: scan coverage is judged against the object — …". |
| B07-F5 (MAJOR) | FIXED | Confirmed against 09 "Retention schedule" and HASHING "Retention formulas". D-RET-3: the UNPAID record is anchored on the first seal of the bytes (checked at COMMIT), a seal whose bytes' window closed is refused, the RETENTION_EXPIRED revocation ends the admission of bytes whose governing records all expired; open question Q-B07-20. Tests: SM "B07-F5: the unpaid hard cap belongs to the bytes — …" and `source-model.test.ts` "deadlines: …" (firstSealOfBytes). |
| B07-F6 (MAJOR) | FIXED | Confirmed: the S024 network clause was claimed without an observable on the Windows verify host. D-ISO-1 specifies the mechanism (child process under the Node permission model; network hooks because Node 24's permission model does not govern the network — verified on this host: `node --permission` refuses fs writes and child processes, `process.permission.has("net")` is false) and its observables with negative controls; the OS-level egress denial is LATER: B15. Port contract `InspectionIsolation` (`@kauro/application` source-providers.ts); case map S024 row. The behaviour is the DATA-PLANE mandate's (SPECIFIED, not claimed). |
| B07-F7 (MAJOR) | FIXED | Resolved by the foundation (`ac44af6` "Foundation: the shared aggregate-kind registry (migration 0008)"): B07's own `aggregate_kinds` table, its DROP CONSTRAINT and its CASE rewrite of `domain_events_bind_aggregate` are deleted; B07 inserts `upload_session`, `source_file` and `retention_record` rows (D-KIND-1) and adds `aggregate_kinds_read_b07_control`. Tests: SM "UploadSession, StoredObject, SourceFile and RetentionRecord are seeded exactly as the domain machines, … bound through its unchanged function (B07-F7)" and `packages/persistence/test/aggregate-kinds.test.ts` (extended with the B07 kinds and the control plane as an event inserter). |
| B07-F8 (MAJOR) | FIXED | Confirmed against 09 "Deletion receipts and restoration". `AuthorityTombstoneKind` gains REVISION_EXPIRED and REVISION_REJECTED, `state` is the closed `AuthorityTombstoneState`, `AUTHORITY_TOMBSTONES` maps every event routed to AUTHORITY_JOURNAL (and `dataset_revision.rejected.v1` is routed there, Q-B07-21). Tests: `packages/application/test/source-contracts.test.ts` "B07-F8: every event routed to AUTHORITY_JOURNAL produces exactly one tombstone kind and a terminal state — …" (on `bfac6b1` the port had no REVISION_EXPIRED kind and no mapping to check) and `source-model.test.ts` "every B07 event type carries an allowlist …"; the authority-journal pipeline test (B07-CONTROL) covers the expired case. |
| B07-F9 (MINOR) | FIXED | Confirmed against B06 D-VER-1/D-EVT-1. D-FILE-2: `source_files.version`, event per version, kind `source_file`, `source_file.admitted.v1` and `source_file.admission_revoked.v1` (EXECUTION_CONTROL, NOTIFICATIONS). D-OBJ-3 records why `stored_objects` rows are not aggregates. Test: SM "B07-F9: an admitted file is an aggregate — …" (a revocation without its event fails KA003, without a version bump KA002). |
| B07-F10 (MINOR) | FIXED | Confirmed: two SELECTs under READ COMMITTED. The check reads uploads and ledger in one statement per ledger and is queued only by a holding change (WHEN clause). Test: SM "B07-F10: the ledgers are checked by a write that changed what an upload holds, in one snapshot — …" (a ledger-neutral edge commits beside an adversarial ledger; a ledger-changing edge is refused KA070). The exact two-statement window is not reproducible deterministically without an in-function hold point; the single-statement shape is asserted on the function body. |
| B07-F11 (MINOR) | FIXED | Confirmed: the database compared only two handler-supplied hashes. D-SEL-4: `kauro.check_selection_inventory` compares the manifest with the rows; `kauro.source_inventory_frozen` freezes an admitted file's inventory. Test: SM "B07-F11: the database compares a selection with the revision's current inventory row by row — …". The inventory hash equality remains a handler check (SELECTION_STALE), stated as such in the case map. |
| B07-F12 (MINOR) | FIXED | Confirmed: the preimage departed from HASHING and A2 only renames. D-HASH-1 (the authority preimage exactly, CHECK `sealed_manifests_authority_preimage`), D-HASH-4 (the sealed subject, `subject_hash`), open question Q-B07-18 with the real reason (B06's unique source hash). Tests: `source-model.test.ts` "digests are domain separated; the manifest hash is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage and the sealed subject binds the revision (B07-F12)", SM "the legitimate lifecycle …" and SM "no CHECK passes on a missing member: …". |
| B07-F13 (MINOR) | FIXED | Confirmed. D-API-1: the B07 routes are `x-kauro-planned` operations of `apps/api/openapi.json` (14 planned operations), checked by `tools/openapi.mjs`; `SOURCE_SWEEPERS` equals §12.5. Tests: `tools/test/openapi.test.mjs` "B07-F13: the source-lifecycle routes are documented from their contracts as planned operations — …", `source-contracts.test.ts` "B07-F13: the sweepers of the contracts are exactly the sweepers of design §12.5, …" and "B07-F13: the planned reply envelopes …". |
| B07-F14 (MINOR) | FIXED | Confirmed for the design at `bfac6b1` (the observation moved the revision after locking the upload). With D-INTAKE-1 the inspection no longer moves the revision; D-LOCK-2 fixes the control-plane order (revision row first) for every unit of work that changes an upload, a file or the revision. Test: SM "D-LOCK-2 (B07-F14): a cancellation and an inspection outcome of the same revision are ordered by the revision row, never upload-first — …" (both interleavings, the wait observed in `pg_stat_activity`, no deadlock). |

### 18.1 The independent re-check of `f243248`

The re-checker closed every B07-F finding (open: none) and reported five new findings, each probed on PostgreSQL 17 through the
runtime login roles. Each is confirmed against the authority and fixed with a test that replays the probe; every database fix was
re-opened in place and its test failed (§16, revert proofs).

| id | status | disposition and evidence |
|---|---|---|
| N1 (MAJOR) | FIXED | Confirmed against 09 "Retention schedule" (incomplete upload 24 h from initiation; unpaid sources no later than fourteen days from sealing), HASHING "Retention formulas" (nothing resets a hard clock), B06 D-EVID-1 / D-ANCH-2 and 07 "application checks cannot be the sole protection": `kauro_app` could insert sealed-manifest and sealed-file rows outside any seal (policy FOR ALL, INSERT granted), which the revocation guard read as "was sealed" / "retained by" and the first seal of the bytes counted. D-SEAL-1: the manifest records the server's instant (`sealed_manifests_server_clock`, fix 1); at COMMIT the revision of every sealed manifest and file row entered SEALED in the same transaction at that instant (`sealed_manifests_bound`, `sealed_revision_files_bound`, fix 2); the readers count only real seals (`kauro.is_real_seal`: state SEALED/SUPERSEDED/EXPIRED/DELETED at the manifest's instant — the revocation guard and the first seal, fix 3); and the seal's facts on the revision are written by seal_command only. Migrations 0010, 0011. Test: SM "N1: sealed manifests and sealed file rows are the record of the seal that writes them — …" (probe a: an INCLUDED row for an old file added to a younger sealed revision in a later transaction is refused and the old file's RETENTION_EXPIRED revocation commits; probe b: a manifest dated 2000-01-01 and, at the server's instant, a manifest and file row of an UPLOADING revision are refused, a seal instant outside seal_command is refused, rows planted by the superuser with triggers off are still not a seal, and the file's INTAKE_EXPIRED revocation commits) — fix 4. |
| N2 (MAJOR) | FIXED | Confirmed against 09 "Resumable session security" (the provider cancellation result is recorded; an unconfirmed cancellation stays pending and is reconciled until the provider lifetime ends), R2-051 and B06 D-EVID-1: `kauro_app` held the UPDATE grant on the provider cancellation columns and could append any registered event type. D-ROLE-3: the grant is withdrawn and the database stamps REQUESTED in the tombstoning update when a session was issued (`upload_sessions_cancellation_requested`); the result is the control plane's alone; the unobserved completion that reopens a bearer session needs the control plane's negative observation (`completion_not_observed_at`, no request-handler grant); the control plane's event types are one list (`kauro.source_control_event_types()`), admitted to it and refused to `kauro_app` by the restrictive policy `domain_events_tenant_not_source_control` — the fix the re-checker proposed, taken in its grant form rather than as a restrictive UPDATE policy because a column grant also keeps the handler from naming the columns at all. Hardening of the same class: an upload's and a revision's terminal facts are set once (KA004). Consumers verify state before their effect (§6, D-RESTORE-1); binding every event type to its transition in the database is Q-B07-22. Migrations 0009, 0011. Test: SM "N2: the provider-session evidence is the control plane's — …" (the re-checker's probe and its variant under the handler's own event type refused; the tombstoning update with CONFIRMED refused; the control plane's event types refused on a version bump of the handler's own aggregates; the list pinned; completion_not_observed refused to the handler with and without the observation; a cancellation re-dated or re-explained refused; the control plane records UNCERTAIN, then CONFIRMED, and takes completion_not_observed). |
| N3 (MINOR) | FIXED | Confirmed against D-CLOCK-1, 09 "Scanner coverage" (stale signatures beyond the recorded policy block new admission) and S054: `scanned_at` was writer-chosen, so six-day-old signatures passed the pinned age when the scan was dated back. D-INSP-4: the database stamps the attempt's claim with the fence (`inspection_claimed_at`); a receipt starts exactly at it, scans after the provider observation and within the attempt, completes no later than the server clock and is recorded at the server's instant (`inspection_receipts_current_attempt`); a location read-back is observed at the server's instant (`storage_location_policies_server_clock`). Deviation from the proposed fix, stated: the re-checker proposed `completion_observed_at ≤ started_at`, but an attempt claims its fence before it records the observation (§12.1 steps 1–2); the attempt's own claim instant is the tighter lower bound and holds for retried attempts too. Migrations 0009, 0010. Tests: SM "S054 at the database: …" (the re-checker's receipt — signatures six days old, scanned an hour after their publication — refused KA072; a scan after completion, a start that is not the claim, a completion ahead of the clock and a receipt dated back refused; the claim instant not writable) and SM "R2-051 at the database: …" (a read-back dated back refused). |
| N4 (MINOR) | FIXED | Confirmed against 07 "Database representation" (composite foreign keys), 08 "Database isolation" ("Foreign keys bind tenant and parent identity") and the registry TenantScope of RetentionRecord. D-PAIR-1: `retention_records_project_client_fk` → the new key `projects_client_scope (agency_id, client_id, project_id)`; `upload_sessions_requester_fk` → `memberships (agency_id, membership_id, user_id)` and the restrictive insert policy `upload_sessions_tenant_requester` (the acting person, their own live OWNER/ADMIN/OPERATOR membership, as B06's `approvals_act`). Migrations 0009, 0012. Test: SM "N4: tenant-scope pairs are bound by composite keys — …" (the re-checker's two probes refused; another member's membership, a VIEWER's own membership and — for the superuser as the adversary — the mismatched pair refused; the project's own client and the colleague's own reservation commit). |
| N5 (MINOR) | FIXED | Confirmed against 09 "Deletion receipts and restoration" (restoration applies tombstones and current revocation facts before traffic; a restore must not recreate source data) and 07 "Restoration and migration". `source_file.admission_revoked.v1` is routed to AUTHORITY_JOURNAL with the closed kind FILE_ADMISSION_REVOKED and the terminal state REVOKED (`AUTHORITY_TOMBSTONES`), so the B07-F8 equality test covers it; the consumer tombstones only a subject in that state. Domain `events.ts`, application `source-providers.ts`. Tests: `packages/application/test/source-contracts.test.ts` "N5: a file-admission revocation is a restore tombstone — …" and "B07-F8: every event routed to AUTHORITY_JOURNAL …", `packages/domain/test/source-model.test.ts` "every B07 event type carries an allowlist …" (the routing reverted, all three fail). The final re-check found the state REVOKED is no SourceFile state (FINAL-N1); corrected to ADMISSION_REVOKED by D-RESTORE-2 (mandate B07-PROVIDER-FAKES), the B07-F8 test now deriving each state from the subject's machine. |

The previous fixer of this round, stopped by a usage limit, had left in the worktree the column `completion_not_observed_at`, its
guard, the withdrawn grant and the stamping trigger (uncommitted). They were kept after review — they are N2's fix — renamed from
"residual N1" to N2, and completed with the event restriction, the tests, the updated fixtures and the boundary matrix.

### 18.2 The final re-check of `ef284df`, closed on `b07/stage-1`

The final re-check of this design head left one residual partly fixed (N5) and three new MINOR findings (FINAL-N1..N3). Two
were fixed by the stage-1 mandates on their branches and one belongs to the case map; the `b07/stage-1` integrator re-ran each
fix's revert proof on the merged tree (the file re-opened in place, the named tests run through `node --test
--test-name-pattern`, the file restored byte for byte — SHA-256 checked — and the tests passing again).

| id | status | disposition and evidence |
|---|---|---|
| N5 (was PARTIALLY_FIXED) | FIXED | The routing was already fixed; the remaining defect was FINAL-N1 (the tombstone's state), closed below. |
| FINAL-N1 (MINOR) | FIXED | Confirmed against 09 "Deletion receipts and restoration" and D-RESTORE-1 (the consumer tombstones only a subject in the state the tombstone names): `REVOKED` is no SourceFile state. D-RESTORE-2 (mandate B07-PROVIDER-FAKES, fix option 1): `AuthorityTombstoneState` and `AUTHORITY_TOMBSTONES` name `ADMISSION_REVOKED`, the SourceFile machine's terminal state; the B07-F8 test derives every routed event's state from its subject's machine (a state the machine enters, every state reachable from it tombstoned, every terminal state tombstoned) instead of a literal set; the N5 title, its case-map citation, D-RESTORE-1 and §12.4 follow. Revert proof on `b07/stage-1`: `source-providers.ts` with the former pair (`state: "REVOKED"`) — `packages/application/test/source-contracts.test.ts` "B07-F8: …" fails ("REVOKED is a state SourceFile enters"), "N5: …" fails, and `source-provider-fakes.test.ts` "the labelled authority-journal fake …" fails (the fake refuses a tombstone of the SourceFile state); restored (SHA-256 `84657f23…`), all three pass. |
| FINAL-N2 (MINOR) | FIXED | Confirmed against the registry edge REJECTED → EXPIRED and D-CLOCK-1 (terminal facts set once). D-PERS-3 (mandate B07-PERSISTENCE, the residual's first option): `retention_expires` writes `terminal_reason = coalesce(terminal_reason, reason)`, so an expiry records its reason only for a revision without one (SEALED → EXPIRED) and a REJECTED revision keeps its rejection's reason; migration 0011 unchanged; the port's `RevisionTransition` documents it. Test: `packages/persistence/test/source-adapters.test.ts` "FINAL-N2: retention_expires takes a REJECTED revision to EXPIRED once every intake window closed and keeps the rejection's reason — refused while a window is open — and a re-explained reason is refused KA004". Revert proof on `b07/stage-1`: `packages/persistence/src/source/revisions.ts` writing `terminal_reason = $3` — the test fails ("database refused the write (KA004)"); restored (SHA-256 `0a083495…`), it passes. |
| FINAL-N3 (MINOR) | FIXED | Confirmed against §15 (stage-2 mandates run in parallel from `b07/stage-1`, which carries no CMD014 route) and `tools/test/b07-case-map.test.mjs` (every title cited for an existing file must exist in it): B07-CONTROL could not write its R2-051 title with the clause "the requester's late CompleteUpload is 409 RESERVATION_EXPIRED". The residual's first fix: the CONTROL title now ends "the requester's late completion report through the source store is refused and nothing of it is admitted" — asserted at the source store `b07/stage-1` carries (the adapters refuse a completion report after the deadline, as `source-adapters.test.ts` "the deadline edges on the server clock: …" already shows) — and the R2-051 section cites B07-COMMANDS' existing `cmd014-complete-upload.test.ts` "DENY: … past the deadline → 409 RESERVATION_EXPIRED; …" for the HTTP answer. Each stage-2 mandate can now write its titles alone. |

## 19. Package-close review (amendment A4) of `0f15636`

The independent package-close review (`tools/review/out/b07-0f15636018f1/review.json`, verdict REJECT) raised four findings. Each
has a test under the title below that failed on `0f15636` and passes with its fix (branch `fix/b07-review`).

| id | severity | status | test | commit |
|---|---|---|---|---|
| B07-R1 | BLOCKING | FIXED (re-check of `6b670e3`: PARTIALLY_FIXED, closed below) | `apps/api/test/cmd017-seal-revision.test.ts` :: "DENY (B07-R1): …" (replaced, lost and unobserved generations, no revocation beforehand) and "RACE (B07-R1): …" (the seal's stat held while the provider replaces the object) | `9fb474e` |
| B07-R1 (re-check) | BLOCKING | FIXED | `apps/api/test/cmd017-seal-revision.test.ts` :: "RACE (B07-R1, provider hold): …" (the replacement after the seal's observation and before its commit, at its journal commit and while it waits on the revision row: refused by the held generation; failed on `6b670e3`, where the replacement succeeded and the seal committed a generation the provider no longer held) and "B07-R1 hold record: …"; `apps/control/test/seal-holds.test.ts` :: "B07-R1 RETENTION releases …" and "B07-R1 crash between the provider hold and the commit: …"; `packages/persistence/test/source-adapters.test.ts` :: "B07-R1: the provider hold record of a seal …"; `packages/application/test/source-provider-fakes.test.ts` :: "the labelled object-storage fake places a temporary hold …" — D-HOLD-1..D-HOLD-3, migration 0020 | the re-check commit |
| B07-R2 | MAJOR | FIXED | `apps/control/test/end-to-end.test.ts` :: "B07-R2 end to end: …" (two associations through CMD016, the real SELECTION_EVALUATION consumer and CMD017) | `9fa857e` |
| B07-R3 | MAJOR | FIXED | `packages/data-plane/test/selection-evaluation.test.ts` :: "B07-R3: …" (the reviewer's hidden formula column under REJECT_FORMULAS) | `ac1a382` |
| B07-R4 | MINOR | FIXED | `apps/control/test/storage-lifecycle.test.ts` :: "B07-R4: …" (UNCERTAIN until the horizon; the sweep on transactions whose TEST CLOCK stands past it; a later agency not hidden) | `077cc3e`, `5a39967` |

`pnpm run verify` at `70cc3cf` on Windows 11 (Node 24.14.1, pnpm 10.16.1, `C:\Tools\pgsql17\bin`): VERIFY_EXIT 0 — contracts 12,
domain 107, application 125, persistence 218, authorization 11, data-plane 13, control 17, api 201 + 1 skipped (B06's Linux-only
test), tools 41; 0 failed; architecture gate, OpenAPI (39 operations), matrix and clean-consume green. The next commit adds this
paragraph only.

The re-check of `6b670e3` (`tools/review/out/b07-recheck-6b670e3d6def/review.json`, verdict REJECT) found B07-R2..R4 FIXED and
B07-R1 PARTIALLY_FIXED: the seal observed the provider's generation before its unit of work, but a replacement after that
observation and before the commit still let it commit a generation that no longer existed. No transaction may span a provider call
(07), so the seal now binds the provider itself: a temporary hold with a generation precondition on every included accepted
generation, recorded before the call, SEALED with the seal, released when nothing needs it and reconciled by RETENTION past its
bound (D-HOLD-1..D-HOLD-3, migration 0020, `ObjectStoragePort.placeHold`/`releaseHold` and their contract fake). The RACE test was
written first and run on `6b670e3` unchanged: both interleavings failed at "the sealed generation is the generation the provider
holds live" (the planted replacement was live, the sealed generation soft-deleted, the seal answered 200); with the hold both pass.
The clauses resting on the provider honouring the hold are SIMULATED until B15 binds Cloud Storage (case map: CMD017-RACE is now
PARTIAL, LATER B15). `pnpm run verify` of the tree this commit records (this paragraph aside) on Windows 11 (Node 24.14.1, pnpm
10.16.1, `C:\Tools\pgsql17\bin`): VERIFY_EXIT 0 — contracts 12, domain 107, application 127, persistence 219, authorization 11,
data-plane 13, control 19, api 207 + 1 skipped (B06's Linux-only test), tools 41; 0 failed; architecture gate, OpenAPI (39
operations), matrix and clean-consume green. The Linux run (Ubuntu 24.04, `/usr/lib/postgresql/17/bin`) verifies the commit itself
from a fresh clone.
