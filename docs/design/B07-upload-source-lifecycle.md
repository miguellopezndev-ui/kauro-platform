# B07 — Upload, inspection and source lifecycle: design

Branch `b07/design`, built on `main` at `02c0bd2` (B05 and the final B06). Package B07 of the build program (22 "B07 — Upload,
inspection and source lifecycle": implement upload reservations, resumable cancellation, scan coverage, immutable accepted
generations, selection, projection, sealing and deletion inventory; prove late uploads cannot resurrect cancelled data, scanner
skips do not pass, all selected files and tables are counted and retention anchors survive failure). Gate G-UPLOAD (owner 09).
Owning manuals 03, 04, 08, 09, 10, with 07 (aggregates, transaction discipline, outbox) and 21 (evidence). Contracts and cases
come from the vendored R2 registry under `packages/contracts/registry` (provenance-checked; quoted, never edited).

This design **extends** the B06 foundation and does not fork it: the pipeline order of D-PIPE-1 (authenticate → access decision →
journal reserve → execute), the runtime roles and their verified pools (`kauro_app`, `kauro_control`, `kauro_assurance`,
`kauro_validator`, `kauro_ingress`), forced RLS, initial-state guards and listed transitions (D-INIT-1, KA008), version and event
discipline (D-VER-1, D-EVT-1, D-EVT-2), transition locks (D-TX-2), the command journal (D-IDEM-1..3), security facts (D-FACT-1),
the closed response contract and outcome catalogues (D-RESP-1, D-OUT-1) and the test helpers of `@kauro/persistence/testing`.
Everything here is either quoted from the authority (section named) or a recorded decision (`D-*`); where the authority is silent
the decision states its rationale and §14 lists the question for the authority. English only; the brand is Kauro (amendment A2).

| delivered on this branch | left to the implementation mandates (§15) |
|---|---|
| `packages/persistence/migrations/0008..0011` — the complete B07 schema on PostgreSQL 17: revision lifecycle and lineage, upload sessions, quota and capacity ledgers, the object registry with the retention read-back, encrypted session secrets, inspection receipts, admitted files and table inventory, selection manifests and evaluations, sealed manifests and file sets, retention anchors and records, the B07 event types; RLS under the B06 roles; applied from empty by the B06 runner | the `pg` adapters of the source store (`SourceUnitOfWorkFactory.runSource`) and the SQLSTATE translation of the B07 refusals (B07-PERSISTENCE) |
| `packages/persistence/test/source-migrations.test.ts` — 21 real-database tests of the B07 schema through the runtime login roles (R2-052, S053, S054 and R2-051 at the database, cancellation races, lock-order interleavings, role boundaries, NULL-safety) | the bounded container inspector, the selection evaluator and the preview reader of `@kauro/data-plane` (B07-DATA-PLANE) |
| `@kauro/persistence/testing` — the shared source-lifecycle fixture (`admitSourceFile`, `bindSourceSelection`, `countSourceSelection`, `readySourceRevision`, `sealStatements`, `sealReadyRevision`, `sealSourceRevision`, `expireSealedRevision`): a revision sealed through the real pipeline, each write by the role that owns it; B06's plan and approval tests use it | the six handlers, the two-phase runtime, the auxiliary routes and their api tests (B07-COMMANDS) |
| `@kauro/domain` — ids, records, the four platform machines, policy values, the selection manifest document, scan-coverage evaluation, digests, deadline arithmetic, object names; the source-store ports | the control-plane consumers and sweepers and the labelled contract fakes of the provider ports (B07-CONTROL) |
| `@kauro/application` — the six command contracts, closed request schemas, the selection manifest document schema, the response views (registry-derived) and the closed outcome catalogues of every B07 route, the provider ports, the orchestration contracts | the 23 cases end to end (`docs/design/B07-case-map.md` names each test) |
| `tools/matrix.mjs` — the state/command/event matrix covers the four B07 machines, the revised DatasetRevision owners and the specified B07 commands and routes with their catalogues | OpenAPI for the B07 routes: generated from the same objects once the routes are registered (§9.5) |

## 1. Decisions register

| id | decision | why (authority) |
|---|---|---|
| D-SQL-1 | B07 raises its own SQLSTATE range: KA070 QUOTA_LEDGER (a quota ledger disagrees with the uploads it summarizes), KA071 FENCE_DISCIPLINE (a fence moved backwards or a stale attempt wrote), KA072 LIFECYCLE_BINDING (a transition lacks the facts its target state requires, or leaves its scope inconsistent). Mapped in `@kauro/persistence` `sqlstate.ts` to INTEGRITY_FAILURE / QUOTA_LEDGER, PRECONDITION_FAILED / FENCE_DISCIPLINE and INTEGRITY_FAILURE / LIFECYCLE_BINDING_MISSING. A range of its own means packages built in parallel (B09 also starts at 0008) cannot collide. | 07 "Command outcomes and error taxonomy" (authentication, authorization, stale version, invalid input and integrity are distinct); B06 D-ERR-1..3. |
| D-MIG-1 | Aggregate kinds become a registered table (`kauro.aggregate_kinds`, FK from `domain_events`) instead of B06's CHECK list; `kauro.domain_events_bind_aggregate` gains the arms `upload_session` and `retention_record`; retention anchor kinds are registered the same way. A later package inserts its kinds; nobody rewrites another package's list. The persistence test proves the seed equals the domain's `AGGREGATE_KINDS` and that every registered kind has an arm. | 07 "Outbox, inbox and event ordering" (registered, versioned event types); B06 D-EVT-2 (an event names an aggregate of its own agency). |
| D-UP-1 | UploadSession is a platform machine (the registry contract has states, no machine): RESERVED → UPLOADING (session_issued) → VERIFYING (completion_reported) → ADMITTED (inspection_admitted) or REJECTED (inspection_rejected); VERIFYING → UPLOADING (completion_not_observed); RESERVED/UPLOADING/VERIFYING → CANCELLED (cancel_upload) or EXPIRED (reservation_expired); ADMITTED → EXPIRED (intake_deadline_reached). Initial RESERVED; CANCELLED, EXPIRED and REJECTED are terminal: nothing leaves an acceptance tombstone. | registry UploadSession ("Application acceptance and provider session lifetime are independent"); 09 "Upload reservation", "Resumable session security", "Completion and inspection". |
| D-UP-2 | Byte and file quota is a per-revision ledger (`revision_quota`: bytes ≤ 5,000,000,000, files ≤ 50) maintained only by the `upload_sessions` trigger. An upload holds its reservation while in flight, its observed bytes once admitted and nothing once acceptance is tombstoned, so freed quota is released exactly once. The ledger UPDATE takes the row lock: two reservations that each fit alone serialize there, and the CHECK refuses the combination on the committed total. A direct edit of a ledger is refused at COMMIT (KA070). | R2-052 ("the aggregate transaction admits only the combination within five billion bytes"); 09 "Initial intake envelope" (conjunctive limits); 07 "Transaction discipline" (unique constraints and row locks close races; application checks cannot be the sole protection); CMD015 failure ("consume freed quota twice"). |
| D-UP-3 | Concurrency is an agency ledger (`upload_capacity`: active sessions ≤ `session_limit`, default 2 = policy `capacity.agencyUploads`); a session slot is held while RESERVED, UPLOADING or VERIFYING. Only the control plane (operations) writes the limit; request handlers hold column grants on the counter only. | 09 "Upload reservation" (the initial concurrent limit is two sessions per agency). |
| D-SESSION-1 | The provider session reference is sealed (AEAD, key reference, nonce, bound to agency, upload, requester and issuance attempt by the vault port) in `upload_session_secrets`, apart from the upload row. The requester reads it only while the upload is UPLOADING and before the application deadline; the control plane reads it only bound to that agency (to cancel it) and deletes it once the cancellation resolved or the provider lifetime ended; nobody updates it. | 09 "Resumable session security" (a bearer credential; stored encrypted in the temporary control record, bound to one destination, returned only through the authenticated upload flow). |
| D-SESSION-2 | The command journal never stores the session: CMD013's journaled view carries a placeholder the transport hydrates for the requester (answer and replay); any other reader gets `UNAVAILABLE`. `GET /api/v1/uploads/{uploadId}/session` re-delivers it to the requester under the same rule. | 09 (never in logs, email, error reports or executor handoffs); 10 "Upload and target routes" (through the protected response; GET progress never exposes the session URI to unrelated readers); 10 "Idempotency contract" (a lost response is recovered by the same key). |
| D-SESSION-3 | A provider session lifetime the adapter does not report is taken as 604,800 s; reconciliation of an UNCERTAIN or UNSUPPORTED cancellation runs until that horizon. | 09: a Cloud Storage resumable session URI can remain usable for up to a week unless cancelled. Open question Q-B07-4. |
| D-SESSION-4 | Delivering a provider session (the CMD013 answer, its replay, the session read) records an ALLOW security fact in the agency's stream (action `CMD013` or `READ_UPLOAD_SESSION`, reason `SESSION_DELIVERED`, assurance SESSION); a refused delivery is a DENY fact like every other (D-FACT-1). | 08 "Audit events and retention" (every trust boundary has an audit event); 09 (the session is a bearer credential). |
| D-RUN-1 | CompleteUpload answers 202 with B06's ACCEPTED envelope (operationId = the upload id, state VERIFYING, statusPath `/api/v1/uploads/{uploadId}`, pollAfterSeconds 5): the request records the browser's claim and schedules verification; the provider observation, hashing, inspection and scan run in the control plane (UPLOAD_INSPECTION). The journal stores the 202 and a replay answers it again. | catalogue CMD014 effect ("completion remains asynchronous"); 10 "Responses and safe errors" (long work returns 202 with operationId, state, status URL and polling guidance); 07 (no transaction spans an external call). 09 says CompleteUpload "reads provider metadata" — open question Q-B07-1. |
| D-RUN-2 | ReserveUpload is a two-phase command: unit of work 1 (access decision, journal reserve, the revision row lock, the intent: quarantine object INTENDED, upload RESERVED holding issuance fence 1, the initiation anchor, DRAFT → UPLOADING for the first upload; the journal entry stays RESERVED, linked to the upload) → one bounded provider call outside any transaction (10 s) → unit of work 2 (access decision again, fence and state check, the sealed secret, RESERVED → UPLOADING, journal commit). A retry with the same key finds the entry PENDING: younger than 30 s it answers OPERATION_PENDING; older, it resumes under a new fence (a stale attempt cannot issue a session, KA071), or — when the upload is already terminal — commits the journal with the terminal upload view. A session created by an abandoned attempt was never delivered and is cancelled best-effort. | catalogue shared contract (external calls through recoverable intent/journal boundaries); 10 "Idempotency contract" (intent before external dispatch; pending, rejected or uncertain is reported); 07 (no transaction across an external call); 10 "Provider adapter contract" (prepared intent is durable before dispatch). |
| D-CTRL-1 | Control-plane work runs in SYSTEM units of work bound to the agency of the work item (`kauro.agency_id` set, no user). Bound, it writes that agency's rows only; unbound it only discovers work through the columns granted to it, which never include customer text (display names, worksheet names, header labels). | 08 "Database isolation" (tenant context transaction-local; fail closed); 07 "The sweeper repairs ... stale inspection and overdue deletion". |
| D-CTRL-2 | The control plane appends exactly the events of the edges it owns — completion observed or not observed, admitted, rejected, expired, provider cancellation recorded, revision inspecting / ready to seal / rejected / expired, retention record expired — bound to the agency, as a SERVICE actor, of a B07 aggregate kind (policy `domain_events_control_source_lifecycle`). This is a narrow amendment of B06 review R3 (the control plane appended no event) for the source lifecycle only: a new aggregate version cannot commit without its event (D-EVT-1), and these edges have no request. | 07 "A successful command commits state, domain event and outbox record atomically"; 09 "Completion and inspection". Open question Q-B07-13. |
| D-ROLE-2 | The role boundary of the source lifecycle is in the database: request handlers enter only RESERVED, UPLOADING, VERIFYING and CANCELLED uploads and UPLOADING, INSPECTING, SEALED, SUPERSEDED and CANCELLED revisions (restrictive policies); the control plane enters INSPECTING, READY_TO_SEAL, REJECTED and EXPIRED revisions; request handlers hold column grants on uploads that exclude the provider observation, the inspection fence and outcome and the deadline expiry; they cannot insert receipts, files, tables or evaluations, or write retention records after creating them. | 08 "Role and capability model"; B06 D-EVID-1 (evidence is written by its producer, never by the request handlers whose gate it satisfies); catalogue CMD014 failure ("declared size/hash or browser completion alone cannot mark the file ready"). |
| D-LOCK-1 | Lock order: project row → revision row (`FOR NO KEY UPDATE`) → revision transition lock → upload rows → quota ledgers (revision, then agency capacity) → object registry rows → a file's transition lock. A reservation reads its revision under the revision's row lock (the BEFORE INSERT trigger), and the revision lifecycle guard takes the revision's transition lock before it reads any fact (B06's trigger takes the same lock but fires after the guard). A transition in flight makes a reservation wait and read its result; a reservation in flight makes a transition wait and then see it; a guard never decides on a view taken before it waited. A command that changes a revision's intake takes the revision row first (CMD013 before its reservation, CMD015, CMD016, CMD017, CMD012 on the predecessor), so two first reservations of a DRAFT revision serialize instead of deadlocking on the transition lock. | 07 "Transaction discipline" (preconditions rechecked inside the transaction; multi-row invariants use explicit locking; the chosen isolation is documented); B06 D-TX-2. |
| D-OBJ-1 | The object registry (`stored_objects`) is a platform machine StoredObject: INTENDED → PRESENT → VERIFIED; INTENDED/PRESENT/VERIFIED → DELETION_REQUESTED → DELETED or DELETION_FAILED → DELETION_REQUESTED. Every row is born INTENDED (a name is reserved before any provider write; an object found by a stat or by inventory is registered and observed in one unit of work). A generation, its length and its digest are set once; a late object is RESIDUAL for good; a provider generation is registered once; rows are never deleted (DELETED is the absence evidence a DeletionReceipt enumerates). Names are opaque — a zone prefix and two to five canonical UUIDs, the zone and the owning agency checked against the row. | 09 "Storage zones and object registry" (every object registered with scope, class, location, opaque name, generation, bytes, hash, creator, state, retention anchor and deletion status; never a filename in a path; generation preconditions; the registry is authoritative for intended objects); 08 (a prefix of one scope never matches another). |
| D-OBJ-2 | The effective soft-delete retention and versioning of every storage location are read back from the provider and recorded (`storage_location_policies`, append-only, evidence class SIMULATED for a contract fake). A deletion cannot be recorded at a location never read back; a deletion the platform performs records the residual the latest read-back implies (`LOCATION_POLICY`: deletion + retention, NULL when retention is 0), and a generation inventory finds already soft-deleted records the provider's own reported expiry (`PROVIDER_REPORTED`). | 09 "Soft delete, versioning and holds" (the effective setting is verified after provisioning; record the actual expiry rather than claiming the object vanished; a policy change does not shorten retention already applied). Open question Q-B07-12. |
| D-FILE-1 | An admitted file is a platform machine SourceFile: born ADMITTED only while its upload is VERIFYING under the current inspection attempt, with the exact accepted generation, digest and length its receipt promoted (composite key to the receipt); ADMITTED → ADMISSION_REVOKED with reason INTAKE_EXPIRED (the unsealed intake window closed), GENERATION_MISSING or GENERATION_CHANGED (inventory). The revocation takes the file's transition lock and refuses INTAKE_EXPIRED for a file a SEALED or SUPERSEDED revision includes; a seal reads the admission after the same lock. | registry FileManifest ("Only provider-observed bytes and generations may be admitted"; admitted is a derived server decision); 09 "Accepted immutability and sealing". |
| D-SEL-1 | The selection is a closed document (`SelectionManifestDocument`): every candidate file and table with an explicit disposition (INCLUDE/EXCLUDE with a reason), the parser choice of every included table (CSV dialect and header, worksheet header row, formula policy, hidden rows and columns, merged cells as observed), selected columns (≤ 800), the object projections (row or referenced entity, field ordinals, confirmed keys) and the associations — ids, digests, tokens and positions only, never customer text. | catalogue CMD016 (explicit selected/excluded tables and parser choices; no hidden-sheet silent inclusion); 03 "Source identity" and "Count the correct population"; 04 "XLSX parser requirements"; 09 "Accepted immutability and sealing". |
| D-SEL-2 | The document is stored by an auxiliary, non-journaled, content-idempotent route (`POST /api/v1/revisions/{revisionId}/selection-manifests`: the same body again answers the stored manifest with `created: false`); CMD016 binds it by the reference its catalogue field names. The intake changes no aggregate, so it needs no command journal entry (whose operation is a catalogue id, B06 `command_journal.operation ^CMD[0-9]{3}$`) and no version. | catalogue CMD016 fields (`selectionManifestRef: id`); 10 "Upload and target routes" (selection edits require the revision version — the version is compared by CMD016). Open question Q-B07-10. |
| D-SEL-3 | A selection binds only a settled inventory: no reservation, session or verification of the revision is open, and the revision records the inventory hash (KAURO_SOURCE_INVENTORY_V1 over its uploads, files and detected tables) that the manifest names; a manifest made against another inventory is SELECTION_STALE. Binding a selection always leaves the revision INSPECTING and uncounted; only SELECTION_EVALUATION binds counts. | catalogue CMD016 failure ("Missing or newly changed tables invalidate previous selection"); registry selection_changes ("invalidate selected-scope readiness and recompute affected facts"). |
| D-REV-1 | Lineage stays inside the project: a predecessor is a revision of the same project (`dataset_revisions_lineage_in_project`), a superseded revision names the successor that names it (deferred `dataset_revisions_successor_fk`), a predecessor is replaced at most once (`dataset_revisions_supersedes_once`), and the project's current revision is one of its own (deferred `projects_current_revision_in_project_fk`). CMD012 requires `supersedesRevisionId` to be the project's current revision, so lineage is linear. | registry DatasetRevision ("Sealing is immutable; replacement creates lineage and invalidates dependent authority"; supersedesRevisionId "Explicit predecessor, never an in-place overwrite"); 10 "Client and project routes" (no in-place edit of sealed source bytes). |
| D-REV-2 | A project holds at most one mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL; partial unique index). CMD012 replacing a mutable predecessor cancels it (cancel_revision) together with its uploads in flight; replacing a SEALED one supersedes it. | registry DatasetRevision cancel_revision and new_revision_explicitly_supersedes; 07 "Transaction discipline". |
| D-RET-1 | Unsealed intake data follows its upload's window: an admitted file that no sealed revision includes expires with its upload at the application deadline (upload ADMITTED → EXPIRED, file revoked INTAKE_EXPIRED, objects deleted); a REJECTED revision expires once every intake window of it closed. Sealing moves the data under the sealed revision's record. | HASHING "Retention formulas" ("abandoned unsealed upload data follows its independent session/inspection cleanup policy rather than waiting forever for a seal"); 09 "Retention schedule" (incomplete upload and quarantine: twenty-four hours from initiation); registry REJECTED retention_expires ("Rejected-input cleanup deadline"). Open question Q-B07-11. |
| D-RET-2 | RetentionRecord is a platform machine (ACTIVE → EXPIRED, ACTIVE/EXPIRED → DELETING → DELETED or DELETED_WITH_RESIDUALS). SealRevision creates the UNPAID record anchored on the seal: hard deadline = sealed_at + 1,209,600 s (fourteen exact days), effective deadline = the hard deadline until the audit package sets the soft deadline (only earlier). The hard deadline never moves; a record expires no earlier than its effective deadline; a sealed revision expires only when no governing record is ACTIVE with a later effective deadline. | 09 "Retention schedule" (unpaid audit sources: seven days after DRAFT_READY or terminal failure, no later than fourteen days from sealing); registry RetentionRecord ("The effective deadline is a minimum of named anchors; retries do not extend it"); policy `retention.unpaidDaysHardFromSeal`, `retention.extendHardCap = false`; HASHING (a day is an exact 86,400-second duration). |
| D-HASH-1 | The manifest hash (KAURO_SOURCE_REVISION_V1, amendment A2 of the R2 domain) binds the revision id: identical bytes sealed again in a new revision are a new authority chain with a distinct manifest hash. | 09 "Quotes, reuploads and retention" ("a new authority chain, not restoration"); HASHING "Hash domain separation". |
| D-HASH-2 | Platform digest domains for what the authority names no domain for, in the same `{domain, version, payload}` wrapper: KAURO_SOURCE_SELECTION_V1, KAURO_SOURCE_PROJECTION_V1, KAURO_SOURCE_INVENTORY_V1, KAURO_SOURCE_TABLE_V1, KAURO_PARSER_PROFILE_V1. | HASHING (every structured digest uses a named domain and version); B06 D-IDEM-1 (KAURO_COMMAND_REQUEST_V1). |
| D-HASH-3 | Evidence digests: KAURO_INSPECTION_RECEIPT_V1, KAURO_SELECTION_EVALUATION_V1, KAURO_RETENTION_ANCHOR_V1, KAURO_AUTHORITY_TOMBSTONE_V1. | as D-HASH-2. |
| D-SCAN-1 | The scan state is derived by the domain (`evaluateScanCoverage`) from what the scanner reports per expected part — the container and every allowed part the bounded preflight expanded, with their verified lengths; the engine's exit code and verdict are recorded as evidence and never decide. COVERED_CLEAN needs every expected part and byte scanned (at least one part) by a pinned configuration with fresh signatures published before the scan; a skip, a short read, a limit or a timeout is NOT_SCANNED (INCOMPLETE_SCAN), a detection BLOCKED. The database repeats the rule (`inspection_receipts_clean_means_covered`). | 09 "Scanner coverage" (a zero exit code alone is not admission evidence; expected parts and bytes are compared to actual coverage; incomplete coverage is rejection, not "clean with warning"); S054; 21 (a scanner skip labelled clean must be detected). |
| D-SCAN-2 | Signatures older than 86,400 s at scan time are stale (STALE_SIGNATURES, NOT_SCANNED). | 09 ("stale signatures beyond the recorded policy block new admission"); the registry records no value — open question Q-B07-3. |
| D-INSP-1 | UPLOAD_INSPECTION runs, under one attempt fence: observe the object (stat) → record the observation → read the exact generation, recomputing SHA-256 → bounded container inspection → scan coverage → promotion (copy with a generation precondition, re-read and compare the digest) → one receipt → admit or reject. | 09 "Completion and inspection", "Scanner coverage", "Accepted immutability and sealing"; 04 inspectContainer. |
| D-INSP-2 | The inspection fence: an attempt claims `inspection_fence + 1` while the upload is VERIFYING; a receipt is accepted only from the current attempt of a VERIFYING upload and only if it describes the recorded observation (KA071, KA072); one receipt per attempt. A cancellation that won the upload row leaves a stale attempt nothing to attach. | catalogue CMD015 ("cancellation remains valid while verification races"; "late finalization cannot resurrect the cancelled file"); 07 "Job and attempt states" (fences). |
| D-INSP-3 | Rejection classes: the nine of 09 (UNSUPPORTED_FORMAT, CORRUPT_STRUCTURE, ACTIVE_CONTENT, DETECTED_MALWARE, INCOMPLETE_SCAN, STALE_SIGNATURES, RESOURCE_LIMIT, TRANSIENT_INFRASTRUCTURE, CANCELLED_AUTHORITY) plus FORMAT_MISMATCH, CLAIM_MISMATCH, SIZE_EXCEEDS_RESERVATION, EMPTY_OBJECT and PROMOTION_UNVERIFIED. Only TRANSIENT_INFRASTRUCTURE retries, inside the deadline. | 09 "Completion and inspection" (the precise classes; only genuinely transient failures retry within the original deadline). |
| D-RESTORE-1 | Terminal authority facts (upload acceptance revoked, revision cancelled, superseded, expired, deleted) are appended as minimal tombstones to an external journal (`AuthorityJournalPort`, idempotent by event) by the AUTHORITY_JOURNAL consumer; restore reconciliation applies them in sequence order before traffic resumes. | 09 "Deletion receipts and restoration" (tombstones survive separately; restoration applies them first); 14 (restore). |
| D-SRC-1 | CMD013 requires an ACTIVE agency, an OPEN project and the project's mode still offered; CMD012 requires the agency DRAFT or ACTIVE and the project OPEN. | B06 D-CMD-2 ("uploads and execution require ACTIVE"); 07 (DRAFT permits no customer-data execution); 09 "Upload reservation" (checks project capability). Open question Q-B07-16. |
| D-SRC-2 | CompleteUpload and CancelUpload act only on the caller's own upload (UPLOAD_NOT_OWNED otherwise); an abandoned upload of another member is tombstoned by the deadline sweeper. CMD012 cancels a replaced revision's uploads whoever requested them. | catalogue CMD014 ("the upload belongs to the caller"), CMD015 ("the operation belongs to the caller"). Open question Q-B07-6. |
| D-SAPI-1 | The source reads (revision, inspection, uploads, upload, selection manifest, preview) need a live ACTIVE membership in the selected agency (AGENCY_READER); the selection intake and the session read follow the commands' role (AGENCY_OPERATOR); every route is scope AGENCY_HEADER (B06 D-SCOPE-1). | 10 "Upload and target routes"; B06 D-READ-1, D-AUTHZ-1. |
| D-SAPI-2 | `providerCompletionRef` (registry type `text`) is 1..4,096 characters with the label control-character rule. | registry field vocabulary; B06 D-LABEL-1. |
| D-SAPI-3 | The ACCEPTED answer of CompleteUpload advises polling after 5 s. | 10 (allowed polling guidance). |
| D-SAPI-4 | `declaredFormat` (registry type `label`) is narrowed to the supported formats CSV and XLSX, as B06 narrows CMD011 `mode`. | registry FileManifest.format; B06 request schemas. Open question Q-B07-14. |
| D-SAPI-5 | CompleteUpload is idempotent by upload and claim: the same claim on a VERIFYING upload answers the same 202 without a new effect; another claim is COMPLETION_CLAIM_CONFLICT. | 09 ("CompleteUpload is idempotent by upload ID and observed generation"; duplicate completion is a qualification case). |
| D-SAPI-6 | Until an object-storage adapter is bound, a command that needs it answers INTEGRITY_FAILURE / SOURCE_SERVICES_UNAVAILABLE; a deployment binds no fake. | 21 "Evidence classes" (a contract fake is SIMULATED, never EXECUTED_PROVIDER); B06 I-INT-2. |
| D-SAPI-7 | The preview route returns at most 20 rows of at most 50 columns, each cell at most 200 characters of decoded text the UI escapes, only to the agency's members, never cached (Cache-Control no-store, B06 E-CACHE-1) or logged. | 10 "Upload and target routes" (a bounded authorized sample with safe display escaping and no shared caching). Open question Q-B07-9. |
| D-EXP-1 | Nothing expires early: an upload expires no earlier than its application deadline (`upload_sessions_expiry_not_early`), a retention record no earlier than its effective deadline (`retention_records_expiry_not_early`); a CHECK never passes on a missing member (every B07 CHECK is written NULL-safe; tests prove the refusals). | 09 "Upload reservation" (twenty-four hours from initiation); registry RetentionRecord; 07 (application checks cannot be the sole protection). |

## 2. Packages and ports

Dependencies flow as in B06 (contracts → domain ports → application → adapters; `architecture.rules.json`):

```
@kauro/domain        model/source/{ids, records, machines, policy, selection, scan-coverage, digests, retention, object-names}
                     ports/source-store (SourceUnitOfWorkFactory.runSource and the source repositories)
@kauro/application   sources/{contracts, request-schemas, views, response-views, outcomes, pipeline-contracts}
                     ports/source-providers (ObjectStoragePort, MalwareScannerPort, ContainerInspectorPort, SelectionEvaluatorPort,
                     SessionVaultPort, AuthorityJournalPort, CommercialScopeInspector)
@kauro/persistence   migrations/0008..0011, sqlstate (KA070..KA072), testing/source-lifecycle (the shared fixture)
```

External providers — object storage, the malware scanner, the key service that seals session references, the external authority
journal — are reached only through `@kauro/application` ports. Until the integration package (B15) binds real adapters, tests
bind contract-faithful fakes that report `evidenceClass: "SIMULATED"` and carry `contract-fake-*` provider tokens in every record
they produce (21 "Evidence classes"); they are never counted as real integration. The container inspector and the selection
evaluator are not providers: they are the platform's own bounded parsers (`@kauro/data-plane`), always real in tests — S024 is
decided by them.

`SourceUnitOfWork` is the B06 `UnitOfWork` plus `sources: SourceStore`; the factory gains `runSource` next to `run`, so every B06
handler and adapter compiles untouched; at integration `sources` folds into the unit of work.

## 3. Aggregates, contracts and tables

Schema `kauro`, PostgreSQL 17, the B06 conventions: `agency_id` on every tenant row; composite foreign keys bind tenant, project
and revision; uniqueness includes scope; server ids are UUIDv7 (CHECK); instants are `timestamptz`; byte counts and populations
BIGINT (B07 stores no money; B06's BIGINT minor units apply to the packages that do); JSONB only
for closed-schema documents (selection manifests, evaluations' per-file/table/projection facts, sealed manifests, coverage and
problem lists); every aggregate carries `version` (D-VER-1) and every version its event (D-EVT-1).

### 3.1 Tables

| table (migration) | aggregate / contract | key columns and constraints | RLS |
|---|---|---|---|
| `aggregate_kinds` (0008) | registered aggregate kinds (D-MIG-1) | PK kind; FK from `domain_events.aggregate_kind` | read for app and control |
| `dataset_revisions` (+ 0008) | DatasetRevision lifecycle and lineage | B06 identity plus selection (manifest id, hash, inventory hash, time — all or none), evaluation id/hash and the four populations (all or none; billable ≤ logical), sealed counts, successor, terminal instants and reason; READY_TO_SEAL and later need selection, evaluation and counts; SEALED/SUPERSEDED need sealed counts; `(agency, project, revision)` and `(agency, revision, supersedes)` unique; lineage in project, successor FK (deferred), one mutable per project, supersedes once; the lifecycle guard (0010) and the deferred sealed-subject and closed-without-live-uploads checks | B06 tenant; restrictive tenant target states (D-ROLE-2); control read (bound or discovery) and update of its target states and columns |
| `stored_objects` (0008) | object registry, StoredObject (D-OBJ-1) | UUIDv7 PK; zone, data class (RAW, DERIVED, RESIDUAL), provider token, location key, opaque name (`kauro.is_object_name`, zone and agency bound: `stored_objects_name_scope`), generation (set once), bytes, sha256, state, late (RESIDUAL for good), creator (membership or service), observation/verification/deletion stamps, deletion result (never a failure recorded as a deletion), attempts (never decrease), provider residual and its basis (D-OBJ-2); a provider generation registered once; one open intent per name; FKs to project, revision, upload (deferred), file (deferred) | tenant read; tenant insert of exactly the CMD013 quarantine intent; control read, insert (SERVICE), update — bound |
| `storage_location_policies` (0008) | retention read-back (D-OBJ-2) | provider, location, soft-delete retention seconds, versioning, evidence hash and class, observed at; append-only | control only |
| `revision_quota`, `upload_capacity` (0008) | quota ledgers (D-UP-2, D-UP-3) | bytes 0..5e9 and files 0..50 per revision; sessions 0..limit per agency, limit default 2; deferred ledger checks (KA070) | tenant and control, bound; the limit is the control plane's column |
| `upload_sessions` (0008) | UploadSession (D-UP-1) | UUIDv7 PK; revision and project scope; display name (label), declared format, reserved bytes 1..2e9, quarantine object, requester (membership and user), application deadline (exactly creation + 86,400 s, deferred check with the anchor), issuance fence, session stamps and digest, provider cancellation state (forward only) and time, completion claim (set only by the report), observation (set once), inspection fence (forward only, only while VERIFYING), receipt hash and file (set once), terminal instants and reason; no early expiry; the revision-accepts-uploads trigger (revision row lock, DRAFT/UPLOADING only, KA072); quota trigger; initial-state, listed-transition, version and event triggers | tenant (column grants, D-ROLE-2) with restrictive target states; control read of non-text columns and update of its columns, bound |
| `upload_session_secrets` (0008) | sealed session reference (D-SESSION-1) | PK upload; FK `(agency, upload, requester)`; key reference, 12-byte nonce, ciphertext; never updated | requester insert and read (UPLOADING and unexpired only); control read and delete, bound |
| `inspection_receipts` (0009) | one completed inspection attempt | receipt hash; fence ≥ 1 (one per attempt); observation (must equal the upload's), sha256, claim digest and consistency, declared/detected format, structure status, scan state, semantic status (always SEMANTIC_NOT_YET_PROFILED), scanner engine/version/signatures/config/exit code/verdict (evidence), expected and scanned parts and bytes, coverage and problems (digests and tokens), parser profile hash, outcome and rejection class, accepted object/generation/digest; CHECKs: clean means covered, admission needs every separate result, rejections classified, BLOCKED iff detection, incomplete/stale is NOT_SCANNED; append-only; the current-attempt trigger (KA071, KA072) | tenant read; control insert and read, bound |
| `source_files` (0009) | FileManifest, SourceFile (D-FILE-1) | UUIDv7 PK; one per upload; accepted object, generation, sha256, bytes 1..2e9, format, scan state, parser profile, receipt; admitted ⇔ ADMITTED; composite key to the receipt's promoted generation, digest and length; born admitted only while the upload is VERIFYING; revocation guard (file transition lock) | tenant read; control insert, read, update of the revocation columns |
| `source_tables`, `source_table_columns` (0009) | detected inventory | table (file, ordinal), kind, name display (label or NULL) and digest, visibility, columns, row estimate, formulas and cache state, merged/hidden counts, issue codes, structure hash; column ordinal, label display and digest, label state; append-only | tenant read; control insert, reads without the display text |
| `selection_manifests` (0010) | the selection document (D-SEL-1) | UUIDv7 PK; body (closed, ≤ 512 KiB) naming its revision, schema version, inventory hash and files (NULL-safe CHECK); body hash; unique per (revision, body hash); creator membership; append-only | tenant read; insert by the session's own ACTIVE membership; control read, bound |
| `selection_evaluations` (0010) | one counting pass | result COMPLETE (every count, 1..50 files, 1..5e9 bytes, edges ≤ 5e6, no failures), ADMISSION_FAILED or ERROR (failures explained, no counts); per-file generations, per-table and per-projection facts; FK to its manifest; append-only | tenant read; control insert and read |
| `sealed_manifests`, `sealed_revision_files` (0010) | the sealed subject | manifest document (names its revision), manifest, projection, selection and evaluation hashes, sealed at; file set: ordinal, disposition and exclusion reason, the exact generation/digest/length of a file of the same project (FK); admitted-at-seal trigger (file transition lock); append-only | tenant read and insert; control read |
| `retention_anchor_kinds`, `retention_anchors` (0011) | anchor facts | kinds registered (D-MIG-1); anchor: revision scope, upload for intake kinds and none for REVISION_SEALED, occurred at, evidence hash; once per (upload, kind) and per (revision, kind); append-only | tenant read and insert; control read and insert, bound |
| `retention_records` (0011) | RetentionRecord (D-RET-2) | class (registry enum), anchor and its evidence hash (FK), soft/hard/effective deadlines (effective = minimum), policy version, provider residuals, state, expiry (never early); one per (revision, class); hard deadline, anchor, class immutable | tenant read and insert; control read and the expiry update, bound |

### 3.2 Roles, grants, context

No new runtime role: the source lifecycle runs under the B06 groups. `kauro_app` gains the tenant grants above (never DELETE);
`kauro_control` gains the source-lifecycle writes of D-CTRL-1/D-CTRL-2 and DELETE on `upload_session_secrets` only (besides
B06's leases). `kauro_assurance`, `kauro_validator` and `kauro_ingress` gain nothing; provider notifications (a generation or
metadata event, 09: "a notice to inspect current authority, not an instruction to accept the file") arrive through B06's
`kauro_ingress` inbox and are handled by UPLOAD_INSPECTION like a reported completion. The whole matrix is pinned in
`packages/persistence/test/fixtures/runtime-boundary.json`; the B07 diff against B06 changed exactly one B06 entry
(`kauro_control` on `kauro.domain_events`: SELECT → INSERT, SELECT, D-CTRL-2) and added the B07 tables, column grants and policies.

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
| KA072 | INTEGRITY_FAILURE / LIFECYCLE_BINDING_MISSING (a handler that checked its preconditions first never meets it) |

## 4. State machines

Every machine is seeded (`kauro.state_machines`, `kauro.state_transitions`), every row is born in its initial state
(`enforce_initial_state`, KA008) and every other edge is refused (`enforce_listed_transition`, KA008). The persistence test proves
the seeds equal the domain machines. The generated matrix (`docs/design/B06-state-command-event-matrix.md`, §1) lists every edge
with the command or control-plane owner that performs it and its event.

- **DatasetRevision** (registry machine, initial DRAFT; B06 seeds the edges). What each target state requires is checked by
  `dataset_revisions_lifecycle_guard` after the revision's transition lock (D-LOCK-1): upload_reserved needs the reservation in the
  same unit of work; all_uploads_completed needs no reservation or session open and every reported completion observed, with one
  observed input; previously_admitted_inputs_selected and selection_changes need a new selection; all_selected_inputs_admitted needs
  a complete evaluation of the bound selection, no upload in flight and every included file admitted in the project and counted at
  its exact generation, digest and length; fatal_input_rejection needs the failed evaluation of the bound selection; seal_command
  needs the manifest of exactly the scope READY_TO_SEAL exposed and no upload in flight, and at COMMIT the sealed manifest, the file
  set equal to the selection's dispositions with the frozen counts, and the UNPAID record anchored on the seal
  (`dataset_revisions_sealed_subject`); retention_expires needs every governing deadline reached (SEALED) or every intake window
  closed (REJECTED); every closing edge needs, at COMMIT, no upload in flight. A sealed subject never changes (KA004).
- **UploadSession** (D-UP-1), **StoredObject** (D-OBJ-1), **SourceFile** (D-FILE-1), **RetentionRecord** (D-RET-2): platform
  machines of `@kauro/domain` (`SOURCE_LIFECYCLE_STATE_MACHINES`) in the registry's shape and unlisted-transition policy.

## 5. Transaction discipline and lock order

Every command runs B06's pipeline (D-PIPE-1) in READ COMMITTED; CMD013 runs it in two units of work (D-RUN-2). Lock order D-LOCK-1.
Why READ COMMITTED is enough: every multi-row invariant is closed by a lock, a unique index or a deferred check —

| invariant | closed by |
|---|---|
| a revision's bytes ≤ 5e9 and files ≤ 50 across concurrent reservations (R2-052) | the revision row lock of the reservation trigger, then the ledger row lock and its CHECK on the committed total; KA070 at COMMIT for any disagreement |
| at most two live sessions per agency | the capacity row lock and its CHECK (RACE test: two reservations for the last slot) |
| freed quota released exactly once | held bytes are a function of the upload's state; the quota trigger applies deltas under the ledger locks |
| a late completion never resurrects cancelled data | CANCELLED/EXPIRED/REJECTED are terminal (KA008); a receipt and a file only for the current attempt of a VERIFYING upload (KA071, the upload row lock of the receipt trigger); the claim cannot be recorded on a tombstone (KA004); a late object is RESIDUAL for good |
| a reservation never enters a revision a concurrent transition is closing or sealing | the revision row lock taken by the reservation trigger and by every transition (D-LOCK-1; RACE test, both interleavings) |
| a seal never includes a file whose intake expired, and an expiry never revokes a sealed file | the file's transition lock: shared by the seal's file-set insert, exclusive by the revocation, which re-checks after it (RACE test, both interleavings) |
| a selection binds a settled inventory | the lifecycle guard after the revision's transition lock: no upload in flight, the manifest's inventory hash recorded |
| one mutable revision per project; a predecessor replaced once; linear lineage | `dataset_revisions_one_mutable_per_project`, `dataset_revisions_supersedes_once`, the successor FK, CMD012's project CAS |
| every upload commits with its initiation anchor and a deadline exactly 24 h after it | `upload_sessions_initiation_anchored` (deferred) |
| every seal commits with its manifest, file set and UNPAID record | `dataset_revisions_sealed_subject` (deferred) |
| no revision closes with an upload in flight | `dataset_revisions_closed_without_live_uploads` (deferred) |
| one receipt per inspection attempt; a fence never moves backwards | `(upload_id, inspection_fence)` unique; `upload_sessions_guard` (KA071) |
| a provider generation is registered once; one open intent per name | `stored_objects_provider_generation`, `stored_objects_one_intent_per_name` |
| every version has its event, in its own agency | B06 `require_event_for_version`, `domain_events_bind_aggregate` |

No transaction spans a provider call, a scan or a parse: CMD013's provider call sits between its two units of work; the control
plane reads, hashes, inspects, scans and promotes outside a transaction and records the result in one unit of work under the
attempt fence it claimed. A lost response after COMMIT is recovered by the same key.

## 6. Outbox, inbox and consumers

B07 registers 14 event types (0011) and publishes the nine DatasetRevision lifecycle events B06 registered with the machine.
Payloads are allowlisted (`EVENT_PAYLOAD_ALLOWLIST`): ids, hashes, tokens, counts — never a display name, a worksheet name, a
label, an object name, a generation or a session reference (domain test). Fan-out (`EVENT_SUBSCRIPTIONS`):

| event | consumers |
|---|---|
| `upload_session.completion_reported.v1` | UPLOAD_INSPECTION |
| `upload_session.cancelled.v1`, `.expired.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL |
| `upload_session.rejected.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL, NOTIFICATIONS |
| `dataset_revision.selection_changed.v1` | SELECTION_EVALUATION |
| `dataset_revision.ready_to_seal.v1`, `.rejected.v1`, `.sealed.v1` | NOTIFICATIONS |
| `dataset_revision.superseded.v1` | EXECUTION_CONTROL (B08), AUTHORITY_JOURNAL |
| `dataset_revision.cancelled.v1` | STORAGE_LIFECYCLE, AUTHORITY_JOURNAL |
| `dataset_revision.expired.v1` | STORAGE_LIFECYCLE, EXECUTION_CONTROL (B08), AUTHORITY_JOURNAL |
| `dataset_revision.deleted.v1` | AUTHORITY_JOURNAL |

The consumers are control-plane pipelines (§11) dispatched by B06's `PgOutboxDispatchStore` under OUTBOX_DISPATCH leases, at
least once; each is idempotent by its own fences and by the listed transitions (a second delivery finds the state already
moved and is DONE). Provider notifications enter through B06's inbox (`kauro_ingress`), deduplicated by provider event id, and
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
READY_TO_SEAL cannot commit it.

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
| POST /api/v1/revisions/{revisionId}/selection-manifests | SubmitSelectionManifest (D-SEL-2) | AGENCY_OPERATOR | 201 (200 with `created: false` for a body already stored) | SelectionManifestIntakeView |
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
ProjectRevisionPointerView, the four command results, SelectionManifestIntakeView, SelectionManifestView and TablePreviewView.
Every view is closed; every registry member of a projected contract is selected or withheld with its reason; the test builds and
compiles them with the strict validator and validates samples. Views carry `permittedActions` over the six B07 operations
(informative, never authority).

### 9.4 Safe errors

`SOURCE_COMMAND_OUTCOMES` and `SOURCE_ROUTE_OUTCOMES` are the closed catalogues, composed from B06's shared entries (framing,
admission, authentication, access, idempotency, platform) plus each route's own; the generated matrix §2a lists them. Codes are
manual 10's stable codes plus B06's PRECONDITION_FAILED, ADMISSION_LIMITED and INTERNAL_ERROR; reasons are registered
FAILURE_REASONS. No problem carries a bucket, an object name, a session URI, a generation, a cell value or a foreign resource's
existence.

### 9.5 OpenAPI

`tools/openapi.mjs` documents exactly the routes the api registers, from the objects its validator compiles; the B07 routes join
the document when mandate B07-COMMANDS registers them (their request schemas, response views and outcome catalogues are the ones
above, joined to `COMMAND_RESPONSES`, `VIEW_DEFINITIONS`, `COMMAND_OUTCOMES` and `READ_OUTCOMES`), and the check then fails on any
B07 route left undocumented. The matrix already covers the B07 machines, commands and routes (verify).

## 10. Deadlines and retention anchors

| anchor | written with | deadline it governs |
|---|---|---|
| UPLOAD_INITIATED | CMD013's reservation, at `created_at` (deferred check) | the application deadline, exactly 86,400 s later (quarantine and incomplete upload) |
| INPUT_ADMITTED | the admission | — (evidence; the file follows its upload's window until sealed) |
| INTAKE_CANCELLED / INTAKE_REJECTED / INTAKE_EXPIRED | the tombstone of the upload | cleanup of its quarantine and accepted objects |
| REVISION_SEALED | CMD017, at `sealed_at` | the UNPAID record: hard deadline sealed_at + 14 × 86,400 s |

An anchor is written in the transaction of the transition it records, so it survives any later failure; one anchor of a kind per
subject, so a retry, a second report or a replay never moves it; the hard deadline never moves; nothing expires early (D-EXP-1).
The deletion inventory is `stored_objects`: every generation of every zone and class with its state, result and provider
residual, enumerable by project, revision or upload (`StoredObjectRepository.inventory`); a DeletionReceipt (B16) is composed from
it and the provider inventory comparison.

## 11. The six commands

Common to all (B06 D-PIPE-1): the access decision (nothing written), then the journal reservation (first write), then the
command's steps below; `expectedVersion` compared on the locked row (STALE_VERSION with `current`); every new version publishes its
event; identical replay answers the journaled result (`replayed: true`); another digest under the key is IDEMPOTENCY_CONFLICT with
no effect; a crash before COMMIT leaves nothing; every DENY is a durable fact.

### CMD012 CreateRevision — POST /api/v1/projects/{projectId}/revisions

Body `{expectedVersion (the project's), supersedesRevisionId}`.
1. lock the project (NOT_FOUND); 2. project version (STALE_VERSION); 3. project OPEN (PROJECT_NOT_OPEN), agency DRAFT or ACTIVE
after its transition lock (AGENCY_NOT_OPEN); 4. lock the predecessor: a revision of this project (INVALID_REQUEST /
UNKNOWN_REFERENCE) that is the project's current revision (PRECONDITION_FAILED / PREDECESSOR_NOT_CURRENT, `current` naming it);
5. predecessor SEALED → SUPERSEDED with `superseded_by_revision_id` (new_revision_explicitly_supersedes), the impact map from
`RevisionAuthorityInspector.boundTo(manifestHash)` and `CommercialScopeInspector` (plans, live approvals, commercial authorizations
— identified and recorded in `dataset_revision.superseded.v1`, never transferred; B08's EXECUTION_CONTROL routes them, and CMD025
already refuses an approval over a source that is not SEALED: SOURCE_EXPIRED); predecessor mutable → CANCELLED (cancel_revision,
reason REPLACED_BY_NEW_REVISION) with every upload in flight CANCELLED (reason REVISION_REPLACED; provider cancellation REQUESTED
where a session was issued) and their quota released; predecessor terminal → unchanged (lineage only);
6. INSERT the new DRAFT revision (v1, `supersedes_revision_id`, creator) — `dataset_revision.created.v1`; 7. move the project's
current revision (version + 1) — `project.current_revision_changed.v1`; 8. journal commit, 201 CreateRevisionView.

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
(INTENDED, `quarantine/{agency}/{project}/{revision}/{upload}`), insert the upload RESERVED (fence 1, deadline creation + 86,400 s),
the UPLOAD_INITIATED anchor, `upload_session.reserved.v1`; a DRAFT revision → UPLOADING (`dataset_revision.uploading.v1`);
7. attach the journal entry to the upload; COMMIT with the entry RESERVED.
Provider call: `ObjectStoragePort.createResumableSession` (exact name, no-overwrite precondition, declared length, origin; 10 s);
a failure answers 503 CAPACITY_UNAVAILABLE / SESSION_ISSUE_FAILED and the reservation stays pending for a retry with the key.
Unit of work 2: 8. the access decision again (a revoked membership ends it); 9. lock the upload: still RESERVED, still this
attempt's fence, deadline not passed — otherwise the attempt is abandoned, the new session cancelled best-effort, and the journal
committed with the upload's current (terminal) view; 10. seal the session reference (`SessionVaultPort.seal`, bound to agency,
upload, requester, attempt) into `upload_session_secrets`; RESERVED → UPLOADING (issued at, SHA-256 of the reference, provider
horizon) — `upload_session.session_issued.v1`; 11. journal commit, 201 ReserveUploadView with the placeholder, hydrated for the
requester (ALLOW fact D-SESSION-4).

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
1. lock the upload (NOT_FOUND); requested by the caller (NOT_AUTHORIZED / UPLOAD_NOT_OWNED); 2. state: RESERVED → 409
SESSION_NOT_ISSUED; CANCELLED → UPLOAD_CANCELLED; EXPIRED, or UPLOADING past its deadline → RESERVATION_EXPIRED; REJECTED →
UPLOAD_TERMINAL; ADMITTED → UPLOAD_ADMITTED; VERIFYING under the same claim → the same 202 without effect, under another claim →
COMPLETION_CLAIM_CONFLICT (D-SAPI-5); 3. parse the reference into a claim (`ObjectStoragePort.parseCompletionClaim`, pure; MALFORMED
→ 400 COMPLETION_REF_MALFORMED) and digest it; 4. UPLOADING → VERIFYING with the claim — `upload_session.completion_reported.v1`
(→ UPLOAD_INSPECTION); 5. journal commit, 202 ACCEPTED (operationId = uploadId, VERIFYING, `/api/v1/uploads/{uploadId}`, 5 s).

OK: verification scheduled; the provider generation, length and hash, the scan coverage and the structure are observed before
admission by UPLOAD_INSPECTION (§12.1); completion remains asynchronous.
DENY: another member's upload → 403 UPLOAD_NOT_OWNED; a declared size or hash never marks a file ready — the request handler
cannot write the observation, the fence, a receipt, a file or ADMITTED (D-ROLE-2; database tests).
RACE: identical retry → the same 202; same key, another reference → 409 IDEMPOTENCY_CONFLICT; a duplicate completion under another
key → the same 202 (D-SAPI-5); CompleteUpload and CancelUpload serialize on the upload row: a cancellation that commits first is
answered UPLOAD_CANCELLED; a crash before COMMIT leaves the upload UPLOADING.

### CMD015 CancelUpload — POST /api/v1/uploads/{uploadId}/cancel

Body `{expectedVersion (the upload's)}`.
1. lock the revision row, then the upload (NOT_FOUND); requested by the caller (UPLOAD_NOT_OWNED); 2. upload version
(STALE_VERSION); 3. RESERVED, UPLOADING or VERIFYING — ADMITTED → 409 UPLOAD_ADMITTED (its file leaves by an exclusion or a new
revision), a tombstone → UPLOAD_TERMINAL; 4. → CANCELLED (reason CANCELLED_BY_REQUESTER; provider cancellation REQUESTED when a
session was issued): bytes, file and slot released exactly once by the quota trigger; the INTAKE_CANCELLED anchor;
`upload_session.cancelled.v1` (→ STORAGE_LIFECYCLE cancels the provider session and deletes the quarantine objects,
AUTHORITY_JOURNAL records the tombstone); 5. journal commit, 200 CancelUploadView (releasedBytes).

OK: acceptance tombstoned, the provider session cancelled where supported (the result recorded: CONFIRMED, UNSUPPORTED or
UNCERTAIN, reconciled until the provider horizon), late objects cleaned (§12.3).
DENY: another member → 403; admitted → 409; a late completion never resurrects the upload (terminal state, KA008; no claim on a
tombstone, KA004; a stale inspection attempt attaches no receipt and admits no file, KA071) and freed quota is never consumed
twice (database tests).
RACE: cancellation while verification races → the cancellation wins the upload row, the stale attempt is refused; two cancels
with one version → one 200, one 409 STALE_VERSION; identical retry → replay; same key, another version → 409.

### CMD016 SelectInputTables — POST /api/v1/revisions/{revisionId}/selection

Body `{expectedVersion, selectionManifestRef}` (the document stored by the intake, D-SEL-2; the intake validates it structurally
and for internal consistency, and refuses a document naming another revision).
1. lock the revision (NOT_FOUND); 2. version (STALE_VERSION); 3. DRAFT, INSPECTING or READY_TO_SEAL (REVISION_NOT_SELECTABLE);
4. no upload in flight (UPLOADS_UNRESOLVED); 5. the manifest is one of this revision's (UNKNOWN_REFERENCE); 6. the revision's
current inventory hash equals the manifest's (SELECTION_STALE); 7. the manifest against the inventory: every candidate file and
table disposed (SELECTION_INCOMPLETE), known (SELECTION_UNKNOWN_TABLE), included files admitted in the project
(SELECTION_FILE_NOT_ADMITTED, REUSE_NOT_AVAILABLE), hidden sheets acknowledged (HIDDEN_SHEET_NOT_ACKNOWLEDGED), formula policy
named (FORMULA_POLICY_REQUIRED), exclusions with reasons, parser choices that fit, projections over included columns with
confirmed keys, ≤ 800 columns, ≤ 50 files and 5e9 bytes (SELECTION_BYTES_LIMIT); 8. bind (manifest id, selection hash = the body's
KAURO_SOURCE_SELECTION_V1 digest, inventory hash, time; version + 1); DRAFT → INSPECTING (previously_admitted_inputs_selected),
READY_TO_SEAL → INSPECTING with the counts cleared (selection_changes), INSPECTING stays — `dataset_revision.selection_changed.v1`
(→ SELECTION_EVALUATION); 9. journal commit, 200 SelectInputTablesView.

OK: explicit selected and excluded tables and parser choices persisted in the mutable revision; detected worksheets, hidden tables,
formulas, parser issues and projections were visible for review (GetInspection, PreviewTable).
DENY: foreign → 404; VIEWER → 403; a changed inventory → 409 SELECTION_STALE; a hidden sheet included without acknowledgement → 400.
RACE: two selections on one version → one 200, one 409; identical retry → replay; same key, another manifest → 409; a crash
leaves the previous selection bound.

### CMD017 SealRevision — POST /api/v1/revisions/{revisionId}/seal

Body `{expectedVersion, selectionHash}`.
1. lock the revision (NOT_FOUND); 2. version (STALE_VERSION); 3. READY_TO_SEAL — SEALED → 409 REVISION_SEALED, otherwise
REVISION_NOT_READY_TO_SEAL; 4. `selectionHash` is the bound selection's (STALE_VERSION / HASH_MISMATCH, `mismatch:
["selectionHash"]`); 5. no upload in flight (UPLOADS_UNRESOLVED); 6. the complete evaluation of the bound selection and every
included file: ADMITTED, at the generation, digest and length the evaluation counted (INPUT_NOT_ADMITTED, GENERATION_CHANGED);
7. compose the sealed manifest (files with generations, digests, lengths, formats, parser profiles and receipts; tables with
dispositions, exclusion reasons, parser choices, selected columns and physical rows; the uploads inspection rejected, with their
classes; projections with the projection ids the seal mints and their logical records; associations; populations; selection,
evaluation and projection hashes; pricing definition; the input envelope) and its hashes; 8. insert the sealed manifest and file
set (each included file read after its transition lock), the REVISION_SEALED anchor, the UNPAID record (hard = seal + 14 days) —
`retention_record.created.v1`; READY_TO_SEAL → SEALED with the manifest, projection and counts — `dataset_revision.sealed.v1`;
9. journal commit, 200 SealRevisionView. At COMMIT the database checks the whole sealed subject (§4).

OK: manifest, bytes, parser settings and billable-unit interpretation sealed atomically; only this manifest can be profiled and
quoted.
DENY: foreign → 404; VIEWER → 403; a changed generation or a revoked admission → 409 and no sealed revision; an incomplete scan
never reached admission (§12.2); a stale version → 409.
RACE: a seal and an intake-expiry revocation of one of its files (both interleavings, the file's transition lock); a late upload
cannot enter (a READY_TO_SEAL revision accepts no reservation and has none in flight); two seals → one 200, one 409; identical
retry → replay; same key, another hash → 409; a crash leaves the revision READY_TO_SEAL.

## 12. Control-plane pipelines (mandate B07-CONTROL)

Each runs in SYSTEM units of work bound to the work item's agency (D-CTRL-1), at least once, idempotent by fences and listed
transitions; provider calls sit outside transactions.

### 12.1 UPLOAD_INSPECTION (`upload_session.completion_reported.v1`, provider notifications)

1. claim the attempt: `inspection_fence + 1` while VERIFYING (anything else: DONE). 2. `stat` the quarantine name: absent → VERIFYING
→ UPLOADING, claim cleared — `completion_not_observed.v1` (the requester may report again before the deadline); present → record
the observation (set once) with the claim's consistency — `completion_observed.v1`; the quarantine object INTENDED → PRESENT; if
the revision is UPLOADING and no reservation, session or unobserved completion remains, UPLOADING → INSPECTING —
`dataset_revision.inspecting.v1`. 3. Outside any transaction: read the exact generation, recomputing SHA-256; the bounded container
inspection (`ContainerInspectorPort`, S024: no outside write, no network, no unbounded decompression); scan the container and every
allowed part (`MalwareScannerPort`), derive the scan state (D-SCAN-1). 4. Admissible → promote: register the accepted intent
(`accepted/{agency}/{project}/{file}`), copy the exact generation with a no-overwrite precondition, observe and re-read, compare the
digest (else PROMOTION_UNVERIFIED). 5. One unit of work: the receipt of this attempt (KA071 if a cancellation won; KA072 if it does
not describe the observation) and either the file, its tables and columns, ADMITTED — `upload_session.admitted.v1`, INPUT_ADMITTED
— or REJECTED with its class — `upload_session.rejected.v1`, INTAKE_REJECTED; then the revision's progress. A TRANSIENT_INFRASTRUCTURE
failure retries within the deadline; the deadline sweeper ends what never finishes.

### 12.2 SELECTION_EVALUATION (`dataset_revision.selection_changed.v1`)

If the revision still binds that selection and is INSPECTING: `SelectionEvaluatorPort.evaluate` opens every included table's
accepted generation by exact generation, re-verifies its digest while parsing under the selected parser choices, applies the
projection and counts physical rows, logical records, billable units and association edges exactly (03 "Count the correct
population"; 04 "Facts used as proof must be exact"; bounded memory, attempt-owned scratch). COMPLETE → the evaluation and
INSPECTING → READY_TO_SEAL with its counts — `dataset_revision.ready_to_seal.v1`; ADMISSION_FAILED → the evaluation and INSPECTING →
REJECTED — `dataset_revision.rejected.v1` (no silent removal); ERROR → retry or dead letter.

### 12.3 STORAGE_LIFECYCLE (upload cancelled, expired, rejected; revision cancelled, expired)

Open the sealed secret and cancel the provider session (`cancelResumableSession` → CONFIRMED, UNSUPPORTED or UNCERTAIN, recorded
with `upload_session.provider_cancellation_recorded.v1`; UNCERTAIN is reconciled until the provider horizon; the secret is purged
once resolved); request deletion of the upload's quarantine objects and, for expired unsealed intake or an expired revision, its
accepted generations; delete each exact generation and record the result with its residual (D-OBJ-2). A late object observed after
the tombstone (a stat, a notification or inventory) is registered RESIDUAL, late, and deleted the same way — it never enters a
revision.

### 12.4 AUTHORITY_JOURNAL

Appends the tombstone of every terminal authority fact to `AuthorityJournalPort` (idempotent by event id, KAURO_AUTHORITY_TOMBSTONE_V1)
(D-RESTORE-1).

### 12.5 Sweepers

UPLOAD_DEADLINES (live uploads past their deadline → EXPIRED with INTAKE_EXPIRED, provider cancellation REQUESTED when a session
was issued; admitted uploads past it whose file no sealed revision includes → EXPIRED and the file revoked INTAKE_EXPIRED — the
database refuses the revocation of a sealed file); PROVIDER_SESSION_RECONCILIATION; RETENTION (ACTIVE records past their effective
deadline → EXPIRED; SEALED revisions with no ACTIVE record ahead and REJECTED revisions whose windows closed → EXPIRED); OBJECT_INVENTORY
(provider listing against the registry: orphans registered RESIDUAL and deleted; soft-deleted generations recorded with the
provider's expiry; a missing or changed accepted generation revokes its file — GENERATION_MISSING, GENERATION_CHANGED);
DELETION_RETRIES; LOCATION_POLICY (reads back every location's retention and versioning at start and daily). 09 "Acceptance and
operating checks": overdue inspection, abandoned reservations, unknown provider sessions, orphan blobs, unregistered generations,
failed deletion and retained bytes by class are each one of these sweeps' reports.

## 13. The scenario cases in B07 terms

- **S024** (XLSX with traversal, duplicate entries, XML entities or excessive expansion → reject without outside writes, network
  access or unbounded decompression): decided by the container inspector under the conjunctive limits (1 GiB per part, 20 GiB
  total, entries, ratio, XML depth, no DTD/entities, no external relationships, normalized paths inside the archive root); the
  receipt records CORRUPT_STRUCTURE / ACTIVE_CONTENT / RESOURCE_LIMIT with problem tokens; nothing is written outside the attempt
  scratch and no network is used (the inspector runs sandboxed; the test observes the scratch and the network namespace).
- **S053** (a false size/hash or another generation → observe actual bytes/generation before admission or sealing): the claim is a
  claim; the server's stat is the observation (set once); a receipt must describe that observation and a file names exactly the
  promoted generation, digest and length of its receipt (database tests); the seal re-checks the evaluation's generations.
- **S054** (the antivirus exits clean because the file exceeded its scan limit → NOT_SCANNED/BLOCKED; a fully covered harmless file
  passes): D-SCAN-1 in the domain (tests) and in the database (`inspection_receipts_clean_means_covered`, tests: skipped part, short
  read, stale or future signatures, nothing expected, unpinned configuration; the covered neighbour).
- **R2-051** (the reservation expires at twenty-four hours while the provider session stays usable → tombstone acceptance, cancel
  the provider session where supported, late objects stay quarantined and are cleaned): the deadline sweeper, STORAGE_LIFECYCLE and
  the registry (database test: no early expiry, the late report refused, the late object RESIDUAL and deleted with its residual).
- **R2-052** (two files each fit → only the combination within 5e9 bytes): D-UP-2 (database test with the lock-wait interleaving).

## 14. Open questions for the authority

| # | question | interim decision |
|---|---|---|
| Q-B07-1 | 09 says CompleteUpload "reads provider metadata, verifies no-overwrite behavior, records actual size"; the catalogue says completion remains asynchronous. Must the request read the provider synchronously? | D-RUN-1: the request records the claim and answers 202; the control plane observes. The observation columns and event exist, so a synchronous stat can move into the command without a schema change. |
| Q-B07-2 | Manual 10 names `POST /revisions/{revisionId}/supersede`; the catalogue has no supersede command and gives lineage to CMD012. | CMD012 carries lineage (supersede or cancel the predecessor); no supersede route. |
| Q-B07-3 | The signature freshness policy (09 "stale signatures beyond the recorded policy") has no registry value. | 86,400 s (D-SCAN-2). |
| Q-B07-4 | The provider session lifetime when the adapter reports none. | 604,800 s (D-SESSION-3). |
| Q-B07-5 | Is 09's "checks MFA" the launch policy's enrolled MFA, or a fresh step-up? The catalogue CMD013 names no proof. | Enrolled MFA and verified email (B06 VERIFIED_USER); no step-up. |
| Q-B07-6 | May an OWNER cancel another member's upload? | Requester only (D-SRC-2); the deadline sweeper tombstones abandoned uploads within 24 h. |
| Q-B07-7 | UploadSession has no display name, declared format or requester members although CMD013 carries displayName and declaredFormat. | Platform columns and view members. |
| Q-B07-8 | DatasetRevision requires manifestHash and projectionHash, which a mutable revision cannot have. | SourceRevisionView withholds them and serves them in `seal`; propose making them optional in the contract. |
| Q-B07-9 | The preview bounds (09/10 give none). | 20 rows × 50 columns × 200 characters (D-SAPI-7). |
| Q-B07-10 | CMD016 names a `selectionManifestRef`, but no catalogue command stores the manifest. | The non-journaled, content-idempotent intake route (D-SEL-2). |
| Q-B07-11 | The registry's "Rejected-input cleanup deadline" has no value. | The upload's own 24-hour window (D-RET-1). |
| Q-B07-12 | How a soft-deleted generation's expiry is recorded when the policy changed after its deletion. | The provider-reported expiry (PROVIDER_REPORTED); our own deletions use the latest read-back (D-OBJ-2). |
| Q-B07-13 | B06 review R3 kept the control plane from appending events; the source lifecycle's control-plane edges need them. | D-CTRL-2 (listed types, SERVICE actor, bound agency, B07 kinds only). |
| Q-B07-14 | CMD013 `declaredFormat` is typed `label`. | Narrowed to CSV or XLSX (D-SAPI-4), as B06 narrows `mode`. |
| Q-B07-15 | A mutable revision whose intake all expired has no command that closes it (the catalogue has no CancelRevision). | It stays mutable with the INTAKE_DEADLINE_PASSED blocker until CMD012 replaces it (cancel_revision). |
| Q-B07-16 | Whether uploads need an ACTIVE agency (07: DRAFT permits no customer-data execution). | Yes (D-SRC-1; B06 D-CMD-2). |
| Q-B07-17 | CMD012's "replacement allowance is evaluated separately": policy `pricing.customerPreExecutionSourceReplacementsIncluded = 1` belongs to the commercial scope. | B07 records lineage and the impact map; the allowance is counted by the payments package (B09) against the quote. |

## 15. Handoff: the implementation mandates

Four mandates run in parallel worktrees from this branch; each is self-contained (its files, cases and done criteria), each keeps
`pnpm run verify` green, and an integration step merges them in the order PERSISTENCE → DATA-PLANE → CONTROL → COMMANDS (the api
tests of COMMANDS and the end-to-end tests of CONTROL run against the merged adapters). Real PostgreSQL 17 everywhere; provider
fakes are labelled SIMULATED; the tests carry exactly the titles `docs/design/B07-case-map.md` names; no sleep synchronizes
anything; migrations 0008–0011 change only for a defect a test finds, with the runtime boundary matrix re-reviewed.

| mandate | builds | demonstrates |
|---|---|---|
| **B07-PERSISTENCE** | the `pg` adapters of every source-store repository (`packages/persistence/src/source/*`), `runSource` on the B06 unit of work with the SYSTEM context bound to an agency (D-CTRL-1), the refusal translation of §3.3 in `sqlstate.ts`, the exports | `packages/persistence/test/source-adapters.test.ts`: every repository method through the runtime roles; R2-052 and the capacity race through `UploadSessionRepository.insert` (lock-wait observed, typed losers); CAS and fences; `recordDeletion` computing the residual from `locationPolicyAt` (refused at a location never read back); `recordProviderResidual`; `revokeAdmission` (KA072 when sealed); content-idempotent `SelectionManifestRepository.put`; no early `expireRecord`; tenant isolation of `runSource` |
| **B07-DATA-PLANE** | `packages/data-plane` (`@kauro/data-plane`, layer adapter): `ContainerInspectorPort` (streaming SHA-256; CSV dialect facts; XLSX through a hardened ZIP/XML reader — no traversal, absolute or duplicate names, no DTD, entities or external relationships, 1 GiB per part and 20 GiB total with a ratio bound, XML depth; worksheet inventory with visibility, formulas and cache, merged cells, hidden rows and columns, positional columns with label states; the expected scan parts; the parser profile hash), `SelectionEvaluatorPort` (exact counts, bounded memory, attempt scratch), the preview reader (D-SAPI-7), the labelled contract fake of `MalwareScannerPort` (skips, timeouts, the EICAR token, stale signatures) | `container-inspection.test.ts` (S024 corpus built in the test, each refused with its class, no write outside the scratch, network denied), `scan-coverage.test.ts` (S054), `selection-evaluation.test.ts` (every selected file and table counted against an independent counter; hidden sheets only when selected; formulas inert) |
| **B07-COMMANDS** | the six handlers (§11) with the two-phase runtime of CMD013 (D-RUN-2) and the ACCEPTED path of CMD014 (D-RUN-1, D-SAPI-5), the selection intake and the reads (SOURCE_ROUTES) with session hydration and its security fact (D-SESSION-2, D-SESSION-4); served in `apps/api` by joining `SOURCE_*` to `SERVED_COMMAND_IDS`, `COMMAND_RESPONSES`, `VIEW_DEFINITIONS`, `COMMAND_OUTCOMES` and `READ_OUTCOMES`; OpenAPI regenerated; the matrix applicability rows of CMD012–CMD017; permitted actions; the storage and vault ports bound to labelled fakes in tests | `apps/api/test/cmd012-create-revision.test.ts` … `cmd017-seal-revision.test.ts` and `source-reads.test.ts`: OK, DENY and RACE of every command through the real route and composition root |
| **B07-CONTROL** | `apps/control` (`@kauro/control`, entrypoint): the consumers UPLOAD_INSPECTION, SELECTION_EVALUATION, STORAGE_LIFECYCLE, AUTHORITY_JOURNAL over B06's dispatch store and leases, the sweepers of §12.5, the labelled fakes of `ObjectStoragePort` (generations, no-overwrite preconditions, sessions usable past the application deadline, cancellation results, soft delete with a configurable read-back, listings), `SessionVaultPort` (AES-256-GCM with a test key, the binding as associated data) and `AuthorityJournalPort` (append-only file) | `apps/control/test/upload-inspection.test.ts` (S053, S024 end to end, CMD014-OK continuation), `storage-lifecycle.test.ts` (R2-051, CMD015-OK), `retention-sweeper.test.ts`, `authority-journal.test.ts` |

## 16. Verification performed on this branch

- `pnpm run verify` (generate, build, typecheck, every package's tests, the tool tests, the architecture gate, OpenAPI, the matrix,
  clean-consume) green on Windows with PostgreSQL 17: contracts 12, domain 62, application 62, persistence 120, authorization 11,
  api 118 (117 passed, 1 skipped: the Linux-only `/proc/<pid>/environ` check of B06), tools 24; architecture gate 6 packages and
  13 edges without violation; OpenAPI equal to the 14 registered routes; the matrix 18 machines and 185 owned edges and initial
  states; clean-consume of every publishable package.
- `packages/persistence/test/source-migrations.test.ts`: 21 tests on a real PostgreSQL 17 cluster; B06's persistence and api
  suites pass on the B07 schema, their sealed sources now built through the source-lifecycle fixture and expired by the retention
  sweeper's role.
- The B07 migrations apply from empty with the B06 runner (11 migrations; `listMigrations().length` asserted instead of a count).
- The runtime boundary matrix was regenerated from a migrated cluster and reviewed entry by entry: the only B06 entry that changed
  is `kauro_control` on `kauro.domain_events` (INSERT, D-CTRL-2); `kauro_app` on `kauro.upload_sessions` holds column grants
  (D-ROLE-2).
