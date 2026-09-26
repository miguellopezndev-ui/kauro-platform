# B07 — case map

Every case of package B07 (registry `program.json` B07 `caseIds`, `node tools/package-brief.mjs B07`: 23 cases, gate G-UPLOAD,
owner 09) mapped to the tests that demonstrate its expected outcome, to what a sealed check observes, and to the later package
that owns any clause B07 cannot demonstrate. Design: `docs/design/B07-upload-source-lifecycle.md` (decisions `D-*`, commands §11,
pipelines §12, critique record §18). The state/command/event matrix, including the four B07 machines and the specified B07
commands and routes with their outcome catalogues, is generated in `docs/design/B06-state-command-event-matrix.md`
(`tools/matrix.mjs`, checked by `pnpm run verify`); every B07 route is an `x-kauro-planned` operation of `apps/api/openapi.json`
(`tools/openapi.mjs`, D-API-1).

Every test is cited as `` `file` :: "exact test title" ``. `tools/test/b07-case-map.test.mjs` (part of `pnpm run verify`) reads this
file: a cited file that exists must contain a test with exactly that title, and a cited file that does not exist yet must be one
of the files the implementation mandates create (§15 of the design) — so no EXECUTED_LOCAL row can name a test that does not run.

Status vocabulary (21 "Evidence classes"; every claim names its class):

- **EXECUTED_LOCAL** — the named test exists on `b07/design` under exactly that title and passed in `pnpm run verify` of this
  branch. Database tests start a real PostgreSQL 17 cluster, drive every write through the runtime login role that owns it
  (`kauro_app_test` as a request handler, `kauro_control_test` as the control plane bound to one agency) and use the superuser as
  the oracle only; they prove what the database refuses and admits whatever the application does. Domain and application tests
  run the pure model and the contracts.
- **SPECIFIED (mandate)** — the command-, pipeline- or parser-level half: the design fixes the exact behaviour (§11, §12) and the
  row names the test the implementation mandate writes (planned file :: planned title). A SPECIFIED row is not claimed.
- **SIMULATED** — a clause demonstrated only through a labelled contract fake of a provider port (object storage, malware scanner,
  session vault, authority journal; provider tokens `contract-fake-*`, evidence class SIMULATED). Until B15 binds the real
  adapters these clauses are never EXECUTED_PROVIDER.
- **LATER** — a clause another package owns, named with the package and its registry case where the registry has one.

No case is PASS by being listed; acceptance is the construction service's independent review. The planned tests follow B06's
placement (command cases through the real HTTP route and composition root in `apps/api/test/`; database facts in
`packages/persistence/test/`; parser facts in `packages/data-plane/test/`; control-plane pipelines in `apps/control/test/`), every
fixture writes as the role that owns the write (`@kauro/persistence/testing` source-lifecycle fixture) at the server's instants
(the labelled TEST CLOCK stands a fixture in the past, D-CLOCK-1), interleavings are fixed by lock-wait observation, never by time,
and the oracle is the superuser reading every table.

## Scenarios

### S024 — XLSX contains traversal, duplicate archive entries, XML entities or excessive expansion

Expected (registry): reject without outside writes, network access or unbounded decompression.

- SPECIFIED (B07-DATA-PLANE): `packages/data-plane/test/container-inspection.test.ts` :: "S024: an XLSX with a traversal entry, duplicate entries, an XML entity or DTD, an external relationship, or an expansion beyond 1 GiB per part / 20 GiB total is refused CORRUPT_STRUCTURE, ACTIVE_CONTENT or RESOURCE_LIMIT — no write outside the attempt scratch, no network attempt, decompression stopped at the bound"
- SPECIFIED (B07-DATA-PLANE): `packages/data-plane/test/container-inspection.test.ts` :: "D-ISO-1 negative controls: a probe that writes outside the attempt scratch is refused by the permission model and counted, a probe that connects or resolves a name is recorded by the network hooks and refused"
- SPECIFIED (B07-CONTROL): `apps/control/test/upload-inspection.test.ts` :: "S024 end to end: the hostile workbook is REJECTED with its class and no accepted generation, file or table exists"
- EXECUTED_LOCAL (a rejection is classified, never admitted): `packages/persistence/test/source-migrations.test.ts` :: "S054 at the database: COVERED_CLEAN requires complete coverage of this object by pinned, fresh signatures — a skipped part or byte, a stale or future signature database, nothing expected, a container shorter than the object, a widened signature age are never clean (B07-F4) — and admission requires every separate result"

A sealed check observes: the receipt's rejection class and problem tokens; no `source_files` row; the attempt scratch holds only
the attempt's files and a sentinel outside it is unchanged; `InspectionIsolation` reports zero outside-write, network and process
attempts and decompressed bytes ≤ the bound; the negative controls show each observer fires. Status: the parser and isolation
halves SPECIFIED; the database half EXECUTED_LOCAL. LATER: B15 — the OS-level network denial of the production worker host (an
egress-denied sandbox; the Windows verify host cannot observe a network namespace, D-ISO-1) qualified with the cloud host
(EXECUTED_PROVIDER).

### S053 — CompleteUpload reports a false size/hash or another object generation

Expected (registry): observe actual bytes/generation before admission or sealing.

- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "S053 at the database: a receipt describes exactly the recorded provider observation, and an admitted file names exactly the generation, digest and length its receipt observed and promoted"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "request handlers never enter the control plane's states and never write its evidence: an admission, a rejection, an expiry, READY_TO_SEAL, a revision's or a record's retention expiry is refused to kauro_app"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "entering a lifecycle state without the facts its registry guard names is refused: all_uploads_completed without the agency's selection, READY_TO_SEAL without a complete evaluation, REJECTED without a failed one, a selection against another inventory or uploads in flight, SEALED without its manifest, seal anchor or retention record, a closed revision with an upload in flight"
- SPECIFIED (B07-CONTROL): `apps/control/test/upload-inspection.test.ts` :: "S053: a completion claiming another generation, a false size or a false hash is REJECTED CLAIM_MISMATCH on the server's own observation; the true neighbour is admitted at the observed generation"
- SPECIFIED (B07-COMMANDS): `apps/api/test/cmd017-seal-revision.test.ts` :: "DENY: an included file whose accepted generation changed after the evaluation is refused GENERATION_CHANGED and nothing is sealed"

A sealed check observes: the upload's observed generation and bytes (set once) equal the receipt's; the file's generation,
sha256 and bytes equal the receipt's promoted ones (composite key); a forged digest, the quarantine generation or the declared size
are refused 23503. Status: database EXECUTED_LOCAL; pipeline SPECIFIED; provider observation SIMULATED. LATER: B15 — observation of
a real Cloud Storage generation (EXECUTED_PROVIDER).

### S054 — Antivirus exits clean because the file exceeded its scan limit

Expected (registry): NOT_SCANNED/BLOCKED; a fully covered harmless file passes.

- EXECUTED_LOCAL: `packages/domain/test/source-model.test.ts` :: "S054: a fully covered harmless file is COVERED_CLEAN; the engine's exit code and verdict never decide"
- EXECUTED_LOCAL: `packages/domain/test/source-model.test.ts` :: "S054: the scanner skipped an oversized part and exited clean -> NOT_SCANNED, never clean with a warning (21: a scanner skip labelled clean)"
- EXECUTED_LOCAL: `packages/domain/test/source-model.test.ts` :: "S054 neighbours: detection is BLOCKED whatever else happened; engine failures are ERROR; stale or unpinned engines are NOT_SCANNED"
- EXECUTED_LOCAL: `packages/domain/test/source-model.test.ts` :: "B07-F4: scan coverage is judged against the object — an expected list without the container, or with the container at another length than observed, is never clean"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "S054 at the database: COVERED_CLEAN requires complete coverage of this object by pinned, fresh signatures — a skipped part or byte, a stale or future signature database, nothing expected, a container shorter than the object, a widened signature age are never clean (B07-F4) — and admission requires every separate result"
- SPECIFIED (B07-DATA-PLANE): `packages/data-plane/test/scan-coverage.test.ts` :: "S054: an oversized part the labelled fake scanner skips with exit code 0 yields NOT_SCANNED INCOMPLETE_SCAN; the harmless file it covers fully, container at its observed length, is COVERED_CLEAN"

A sealed check observes: the receipt's scan state against its coverage document — exactly one CONTAINER part at the observed
length, every part complete, counts and byte sums equal; no COVERED_CLEAN row with scanned < expected, stale or future signatures,
a recorded maximum age other than 86,400 s, an unpinned configuration or nothing expected; the admission CHECK names each missing
result. Status: domain and database EXECUTED_LOCAL; engine behaviour SIMULATED. LATER: B15 — ClamAV with pinned limits and
signatures and the EICAR pattern (EXECUTED_PROVIDER, 09 "Scanner coverage" test list).

### R2-051 — Provider session outlives UI

Expected (registry): tombstone acceptance and cancel the provider session where supported; late objects remain quarantined and
are cleaned.

- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "R2-051 at the database: after the application deadline the session is tombstoned; a late object is registered as a quarantined residual and deleted under its generation; the deletion records the provider residual the location read-back implies; nothing of it is ever admitted"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "B07-F2: every lifecycle instant is the server's — a reservation dated ahead, an expiry at the deadline value before the deadline, a seal dated back, an anchor ahead and a record or revision expiry dated ahead are refused; nothing is accepted after the deadline; only the labelled test clock of a test cluster stands a fixture in the past"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "retention anchors survive failure: a reservation commits with its initiation anchor or not at all, each anchor is written once per subject, the hard cap never moves, and neither an upload, a record nor its revision expires before the governing deadline"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the provider session secret is readable by its requester only while UPLOADING and unexpired, by the control plane only when bound to the agency, and by nobody else"
- SPECIFIED (B07-CONTROL): `apps/control/test/storage-lifecycle.test.ts` :: "R2-051: the deadline sweeper expires a reservation at 24 h on the server clock while the fake provider session stays usable; the provider cancellation is requested and recorded (CONFIRMED, UNSUPPORTED, UNCERTAIN reconciled to the horizon); a late completion through the session is registered RESIDUAL and deleted by generation; the requester's late CompleteUpload is 409 RESERVATION_EXPIRED"

A sealed check observes: the upload EXPIRED at the server instant at or after its deadline, with INTAKE_EXPIRED; no completion
report or admission after the deadline; provider cancellation state and time; the late object's registry row (late, RESIDUAL,
DELETED, result DELETED, deleted at the server instant, residual expiry = deletion + read-back retention); no file; quota released
once. Status: database EXECUTED_LOCAL; pipeline SPECIFIED; provider session SIMULATED. LATER: B15 — a real resumable session
cancelled (or reported unsupported) at the provider (EXECUTED_PROVIDER); B16 — the DeletionReceipt enumerating it (G-DELETE).

### R2-052 — Concurrent byte reservation

Expected (registry): the aggregate transaction admits only the combination within five billion bytes.

- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "R2-052: two reservations that each fit alone serialize on the revision; only a combination within five billion bytes commits, and the per-file envelope holds"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the quota ledgers cannot be edited around the uploads they summarize (KA070 at commit)"
- EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "B07-F10: the ledgers are checked by a write that changed what an upload holds, in one snapshot — a ledger-neutral edge commits even while a ledger disagrees (never a false, nonretryable KA070), a ledger-changing edge is still refused KA070"
- SPECIFIED (B07-COMMANDS): `apps/api/test/cmd013-reserve-upload.test.ts` :: "RACE (R2-052): two ReserveUpload calls that each fit the remaining quota — the second waits on the revision and is answered 409 REVISION_QUOTA_EXCEEDED; the ledger holds exactly the admitted combination"

A sealed check observes: the second reservation waiting in `pg_stat_activity`, then refused by
`revision_quota_bytes_within_envelope`; the ledger equals the sum of held bytes (3.5e9, 2 files); the exact-fit neighbour commits
(5e9). Status: database EXECUTED_LOCAL; command SPECIFIED. No later package.

## Command triads

### CMD012 CreateRevision

- **CMD012-OK** (create new mutable input identity and explicit lineage; preserve sealed predecessor bytes):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "lineage: a successor names a predecessor of its own project, a predecessor is superseded only by the successor that names it, and it is replaced at most once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd012-create-revision.test.ts` :: "OK: an OPERATOR replaces the project's SEALED revision — the predecessor SUPERSEDED with its manifest, files and record intact, a DRAFT successor naming it, the project pointer moved, the impact map naming the plans and approvals bound to the old manifest"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd012-create-revision.test.ts` :: "OK: replacing a mutable revision cancels it with its uploads in flight, their INTAKE_CANCELLED anchors, and releases their quota"
  - Observes: new DRAFT v1 with `supersedes_revision_id`; predecessor SUPERSEDED naming the successor (deferred FK) at the server
    instant; sealed manifest, subject and file set unchanged; `project.current_revision_changed.v1`; `dataset_revision.superseded.v1`
    lists affected plans/approvals. LATER: B09/B10 — the replacement allowance (`pricing.customerPreExecutionSourceReplacementsIncluded = 1`)
    counted against the quote through `RevisionLineageReader` (design Q-B07-17, §17 item 6).
- **CMD012-DENY** (do not carry old validation, approval or paid execution authority onto changed bytes; no unauthorized committed
  state or external effect):
  - EXECUTED_LOCAL (a predecessor of another project refused `dataset_revisions_lineage_in_project`): `packages/persistence/test/source-migrations.test.ts` :: "lineage: a successor names a predecessor of its own project, a predecessor is superseded only by the successor that names it, and it is replaced at most once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd012-create-revision.test.ts` :: "DENY: VIEWER → 403 ROLE_INSUFFICIENT; foreign project → 404; stale project version → 409 STALE_VERSION; a predecessor of another project → 400 UNKNOWN_REFERENCE; not the current revision → 409 PREDECESSOR_NOT_CURRENT; nothing committed"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd012-create-revision.test.ts` :: "DENY: after the replacement, ApprovePlan of a plan bound to the superseded source is 422 SOURCE_EXPIRED and no plan, receipt or approval names the new revision"
  - Observes: no row, event or journal entry after each denial; DENY security facts; plans' `revision_hash` still names the old
    manifest (FK `plans_source_fk`); the CMD025 answer. LATER: B08 — EXECUTION_CONTROL revokes queued execution on
    `dataset_revision.superseded.v1`; B09 — commercial authorizations bound to the old revision (`CommercialScopeInspector`, §17 item 7).
- **CMD012-RACE** (preserve one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority):
  - EXECUTED_LOCAL (`dataset_revisions_one_mutable_per_project`): `packages/persistence/test/source-migrations.test.ts` :: "revisions accept uploads only while DRAFT or UPLOADING, a project holds one mutable revision, and object names are opaque and scoped to their zone and agency"
  - EXECUTED_LOCAL (`dataset_revisions_supersedes_once`): `packages/persistence/test/source-migrations.test.ts` :: "lineage: a successor names a predecessor of its own project, a predecessor is superseded only by the successor that names it, and it is replaced at most once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd012-create-revision.test.ts` :: "RACE: two CreateRevision calls on one project version → one 201, one 409 STALE_VERSION; identical retry replays; the same key with another predecessor → 409 IDEMPOTENCY_CONFLICT; a crash between the inserts commits nothing"
  - Observes: one successor per predecessor; one mutable revision per project; the journal row of the winner; replay bytes equal.

### CMD013 ReserveUpload

- **CMD013-OK** (reserve bytes and create a narrowly scoped resumable session with an application acceptance deadline):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the legitimate lifecycle passes every guard — reserve, issue, report, observe, inspect, promote, admit, select, evaluate, seal, anchor and retain — each write by the runtime role that owns it"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "an agency holds two concurrent upload sessions: the third is refused by the capacity ledger, two racing reservations for the last slot serialize on it, and a tombstoned upload frees its slot exactly once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd013-reserve-upload.test.ts` :: "OK: an OPERATOR reserves 1 MB on a DRAFT revision — RESERVED then UPLOADING with the protected session delivered to the requester only, the revision UPLOADING, the quota and slot held, the deadline exactly 24 h after the initiation anchor at the server instant, the session sealed and never journaled"
  - Observes: the upload row (fence, created at the server instant, deadline = anchor + 86,400 s), ledgers, `upload_session_secrets`
    ciphertext bound to the requester, the journal's placeholder (no bearer value in `command_journal.response_body`), ALLOW fact
    SESSION_DELIVERED. Provider session SIMULATED. LATER: B15 — a real Cloud Storage resumable session (EXECUTED_PROVIDER).
- **CMD013-DENY** (a provider session is returned only to its authorized requester; quota races cannot oversubscribe the revision):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the provider session secret is readable by its requester only while UPLOADING and unexpired, by the control plane only when bound to the agency, and by nobody else"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "R2-052: two reservations that each fit alone serialize on the revision; only a combination within five billion bytes commits, and the per-file envelope holds"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "revisions accept uploads only while DRAFT or UPLOADING, a project holds one mutable revision, and object names are opaque and scoped to their zone and agency"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd013-reserve-upload.test.ts` :: "DENY: VIEWER → 403; foreign revision → 404; INSPECTING revision → 409 REVISION_NOT_ACCEPTING_UPLOADS; 2e9 + 1 bytes → 409 FILE_TOO_LARGE; a third session → 429 UPLOAD_CONCURRENCY_LIMITED; DRAFT agency → 409 AGENCY_NOT_ACTIVE; another member's session read → UNAVAILABLE NOT_REQUESTER — no provider call made"
  - Observes: no upload, object, ledger change or provider session after each denial (the fake storage's call log is empty); the
    other member reads no secret row (RLS).
- **CMD013-RACE**:
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "a reservation and a revision transition are ordered by the revision row: a cancellation in flight makes a later reservation wait and refuses it; a reservation in flight makes the cancellation wait, which then must tombstone it"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "an agency holds two concurrent upload sessions: the third is refused by the capacity ledger, two racing reservations for the last slot serialize on it, and a tombstoned upload frees its slot exactly once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd013-reserve-upload.test.ts` :: "RACE: identical retry → the same reservation and the session re-delivered; the same key with another declaration → 409; a retry while the first is pending → 409 OPERATION_PENDING; a crash after the intent resumes under a new fence and issues one session; a crash after the provider call cancels the undelivered session"
  - Observes: one upload per key; the journal RESERVED then COMMITTED; `session_attempt` fences; the fake storage records exactly one
    delivered session and the cancellation of an abandoned one. Provider SIMULATED.

### CMD014 CompleteUpload

- **CMD014-OK** (observe provider generation/length/hash, scan coverage and structure before admission; completion remains
  asynchronous):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the legitimate lifecycle passes every guard — reserve, issue, report, observe, inspect, promote, admit, select, evaluate, seal, anchor and retain — each write by the runtime role that owns it"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "S053 at the database: a receipt describes exactly the recorded provider observation, and an admitted file names exactly the generation, digest and length its receipt observed and promoted"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd014-complete-upload.test.ts` :: "OK: the requester reports completion → 202 ACCEPTED (operationId = uploadId, VERIFYING, status path, poll after 5 s); nothing is admitted by the request"
  - SPECIFIED (B07-CONTROL): `apps/control/test/upload-inspection.test.ts` :: "OK: UPLOAD_INSPECTION observes, hashes, inspects, scans, promotes and admits the file (source_file.admitted.v1); the revision stays UPLOADING until the agency's selection closes the intake"
  - Observes: the 202 body equals the journaled one; the upload VERIFYING with the claim; later the receipt, the accepted generation
    (copy with precondition, digest re-read), the file and tables, ADMITTED; the revision still UPLOADING (D-INTAKE-1). Provider
    SIMULATED. LATER: B15 (EXECUTED_PROVIDER observation and scan).
- **CMD014-DENY** (declared size/hash or browser completion alone cannot mark the file ready):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "request handlers never enter the control plane's states and never write its evidence: an admission, a rejection, an expiry, READY_TO_SEAL, a revision's or a record's retention expiry is refused to kauro_app"
  - EXECUTED_LOCAL (no completion report after the deadline): `packages/persistence/test/source-migrations.test.ts` :: "B07-F2: every lifecycle instant is the server's — a reservation dated ahead, an expiry at the deadline value before the deadline, a seal dated back, an anchor ahead and a record or revision expiry dated ahead are refused; nothing is accepted after the deadline; only the labelled test clock of a test cluster stands a fixture in the past"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd014-complete-upload.test.ts` :: "DENY: another member's upload → 403 UPLOAD_NOT_OWNED; RESERVED → 409 SESSION_NOT_ISSUED; CANCELLED → 409 UPLOAD_CANCELLED; past the deadline → 409 RESERVATION_EXPIRED; a malformed reference → 400 COMPLETION_REF_MALFORMED; a claimed size and hash never mark the file ready"
  - Observes: no state change after each denial; a handler's UPDATE of the observation or ADMITTED is 42501.
- **CMD014-RACE**:
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "cancellation wins while verification races: a stale inspection attempt can attach no receipt and admit no file; fences never move backwards; the provider cancellation result only moves forward; the quota is released once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd014-complete-upload.test.ts` :: "RACE: identical retry → the same 202; the same key with another reference → 409; a duplicate completion under another key → the same 202 (D-SAPI-5), another claim → 409 COMPLETION_CLAIM_CONFLICT; CompleteUpload racing CancelUpload serializes on the revision row"
  - Observes: one completion_reported event; the second request observed waiting on the revision row; the loser's answer.

### CMD015 CancelUpload

- **CMD015-OK** (tombstone application acceptance, cancel provider session where supported and clean late objects):
  - EXECUTED_LOCAL (a tombstoned upload frees its slot exactly once): `packages/persistence/test/source-migrations.test.ts` :: "an agency holds two concurrent upload sessions: the third is refused by the capacity ledger, two racing reservations for the last slot serialize on it, and a tombstoned upload frees its slot exactly once"
  - EXECUTED_LOCAL (the cancelled last open upload leaves the revision closable): `packages/persistence/test/source-migrations.test.ts` :: "B07-F1: the last open upload cancelled (CMD015), expired (the deadline sweeper) or rejected (an inspection outcome) never strands the revision: each leaves it UPLOADING and closable by the selection of what was admitted"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "R2-051 at the database: after the application deadline the session is tombstoned; a late object is registered as a quarantined residual and deleted under its generation; the deletion records the provider residual the location read-back implies; nothing of it is ever admitted"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd015-cancel-upload.test.ts` :: "OK: the requester cancels an UPLOADING upload — CANCELLED, quota and slot released once, provider cancellation REQUESTED, the INTAKE_CANCELLED anchor; the revision stays UPLOADING"
  - SPECIFIED (B07-CONTROL): `apps/control/test/storage-lifecycle.test.ts` :: "OK: STORAGE_LIFECYCLE cancels the provider session, records the result, purges the secret and deletes the quarantine objects by generation"
  - Observes: CANCELLED with reason and INTAKE_CANCELLED anchor at the server instant; ledgers; provider cancellation state; objects
    DELETED with results and residuals; tombstone appended. Provider SIMULATED. LATER: B15 (real session cancellation); B16
    (DeletionReceipt).
- **CMD015-DENY** (late finalization cannot resurrect the cancelled file or consume freed quota twice):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "cancellation wins while verification races: a stale inspection attempt can attach no receipt and admit no file; fences never move backwards; the provider cancellation result only moves forward; the quota is released once"
  - EXECUTED_LOCAL (no edge leaves CANCELLED; the freed slot is usable exactly once): `packages/persistence/test/source-migrations.test.ts` :: "an agency holds two concurrent upload sessions: the third is refused by the capacity ledger, two racing reservations for the last slot serialize on it, and a tombstoned upload frees its slot exactly once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd015-cancel-upload.test.ts` :: "DENY: another member → 403 UPLOAD_NOT_OWNED; ADMITTED → 409 UPLOAD_ADMITTED; already cancelled → 409 UPLOAD_TERMINAL; foreign → 404"
  - Observes: KA071 for the stale receipt and file; KA008 for every edge out of CANCELLED; ledger totals.
- **CMD015-RACE**:
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "D-LOCK-2 (B07-F14): a cancellation and an inspection outcome of the same revision are ordered by the revision row, never upload-first — whichever comes first, the other waits on the revision and then acts on the settled upload; neither deadlocks"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "cancellation wins while verification races: a stale inspection attempt can attach no receipt and admit no file; fences never move backwards; the provider cancellation result only moves forward; the quota is released once"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd015-cancel-upload.test.ts` :: "RACE: two cancels on one version → one 200, one 409 STALE_VERSION; identical retry replays; the same key with another version → 409; a cancellation committed while UPLOAD_INSPECTION holds the revision row waits and then finds the upload settled"
  - Observes: one cancellation event; the waiting writer in `pg_stat_activity`; the stale receipt refused; no 40P01.

### CMD016 SelectInputTables

- **CMD016-OK** (persist explicit selected/excluded tables and parser choices in the mutable revision):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "the legitimate lifecycle passes every guard — reserve, issue, report, observe, inspect, promote, admit, select, evaluate, seal, anchor and retain — each write by the runtime role that owns it"
  - EXECUTED_LOCAL (the selection is the agency's explicit closing of an UPLOADING intake): `packages/persistence/test/source-migrations.test.ts` :: "B07-F1: the intake closes only by the agency's explicit selection — with two concurrent sessions per agency a three-file intake stays UPLOADING across the gap between reservations, the control plane can never close it, and the selection closes it once every upload is settled"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd016-select-input-tables.test.ts` :: "OK: an OPERATOR stores a selection manifest (201, then the same body again → created false) and binds it on the UPLOADING revision — all_uploads_completed, the revision INSPECTING with the selection and inventory hashes, uncounted; SELECTION_EVALUATION then counts it READY_TO_SEAL"
  - SPECIFIED (B07-DATA-PLANE): `packages/data-plane/test/selection-evaluation.test.ts` :: "every selected file and table is counted: physical rows, logical records after projection, billable units, association edges — exact, per table and per projection"
  - Observes: the stored manifest and body hash; the revision's selection, inventory hash, version and `previousState`; the
    evaluation's counts equal an independent count of the fixture files. LATER: B03/B08 — profiling of the sealed manifest (no
    B07 clause).
- **CMD016-DENY** (missing or newly changed tables invalidate previous selection; no hidden-sheet silent inclusion):
  - EXECUTED_LOCAL (the database compares the manifest with the inventory rows): `packages/persistence/test/source-migrations.test.ts` :: "B07-F11: the database compares a selection with the revision's current inventory row by row — a manifest omitting an admitted file of the revision, omitting or mis-hashing a table of an included file, naming a table of no file it names, a file of another origin or a revoked file is refused; no table or column is appended once the file's upload left VERIFYING"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "entering a lifecycle state without the facts its registry guard names is refused: all_uploads_completed without the agency's selection, READY_TO_SEAL without a complete evaluation, REJECTED without a failed one, a selection against another inventory or uploads in flight, SEALED without its manifest, seal anchor or retention record, a closed revision with an upload in flight"
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "no CHECK passes on a missing member: a selection manifest without its revision, inventory or file list, a COMPLETE evaluation without its counts, a sealed subject that names no revision and a manifest preimage beyond HASHING's four members are refused"
  - EXECUTED_LOCAL (a hidden sheet acknowledged only with `true`; no sheet name travels): `packages/application/test/source-contracts.test.ts` :: "the B07 schemas compile under the strict validator; unknown members, coercible strings and oversized manifests are refused"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd016-select-input-tables.test.ts` :: "DENY: a manifest made against another inventory → 409 SELECTION_STALE; a hidden worksheet included without acknowledgement → 400 HIDDEN_SHEET_NOT_ACKNOWLEDGED; an undisposed table → 400 SELECTION_INCOMPLETE; uploads in flight → 409 UPLOADS_UNRESOLVED; VIEWER → 403; foreign → 404"
  - Observes: no binding after each denial; KA072 at the database for a manifest whose files or tables differ from the current
    inventory rows, for a live upload, and for an inventory hash the revision does not record; the hash equality itself
    (SELECTION_STALE) is the handler's (SPECIFIED).
- **CMD016-RACE**:
  - EXECUTED_LOCAL (the guard reads after the transition lock): `packages/persistence/test/source-migrations.test.ts` :: "a reservation and a revision transition are ordered by the revision row: a cancellation in flight makes a later reservation wait and refuses it; a reservation in flight makes the cancellation wait, which then must tombstone it"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd016-select-input-tables.test.ts` :: "RACE: two selections on one version → one 200, one 409 STALE_VERSION; identical retry replays; the same key with another manifest → 409; a selection racing the admission of the last open upload waits on the revision row and binds the settled inventory; a crash leaves the previous selection bound"
  - Observes: one selection event per version; the journal row; the waiting writer in `pg_stat_activity`.

### CMD017 SealRevision

- **CMD017-OK** (atomically seal manifest, bytes, parser settings and billable-unit interpretation):
  - EXECUTED_LOCAL (the stored manifest is exactly HASHING's preimage; the subject binds the revision; no display name): `packages/persistence/test/source-migrations.test.ts` :: "the legitimate lifecycle passes every guard — reserve, issue, report, observe, inspect, promote, admit, select, evaluate, seal, anchor and retain — each write by the runtime role that owns it"
  - EXECUTED_LOCAL: `packages/domain/test/source-model.test.ts` :: "digests are domain separated; the manifest hash is exactly HASHING's KAURO_SOURCE_REVISION_V1 preimage and the sealed subject binds the revision (B07-F12)"
  - EXECUTED_LOCAL (the UNPAID cap of the bytes): `packages/persistence/test/source-migrations.test.ts` :: "B07-F5: the unpaid hard cap belongs to the bytes — re-sealing reused bytes keeps their first seal's fourteen days, a seal whose bytes' window closed is refused, and neither a superseded revision nor its successor keeps the bytes admitted once their retention ended"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd017-seal-revision.test.ts` :: "OK: an OPERATOR seals a READY_TO_SEAL revision — SEALED v5, the manifest (HASHING's preimage), the sealed subject and the file set with exact generations, the UNPAID record with hard deadline the first seal of the bytes + 14 days, one sealed event"
  - Observes: manifest hash recomputed from the stored manifest by an independent function; subject hash from the stored subject;
    file set = selection dispositions; counts; the retention record and REVISION_SEALED anchor at the server instant; all in one
    commit. LATER: B03 — the soft deadline from DRAFT_READY (the effective deadline only moves earlier).
- **CMD017-DENY** (a changed generation, incomplete scan or version conflict leaves no executable sealed revision):
  - EXECUTED_LOCAL: `packages/persistence/test/source-migrations.test.ts` :: "entering a lifecycle state without the facts its registry guard names is refused: all_uploads_completed without the agency's selection, READY_TO_SEAL without a complete evaluation, REJECTED without a failed one, a selection against another inventory or uploads in flight, SEALED without its manifest, seal anchor or retention record, a closed revision with an upload in flight"
  - EXECUTED_LOCAL (an incomplete scan never admits): `packages/persistence/test/source-migrations.test.ts` :: "S054 at the database: COVERED_CLEAN requires complete coverage of this object by pinned, fresh signatures — a skipped part or byte, a stale or future signature database, nothing expected, a container shorter than the object, a widened signature age are never clean (B07-F4) — and admission requires every separate result"
  - EXECUTED_LOCAL (a seal dated back is refused): `packages/persistence/test/source-migrations.test.ts` :: "B07-F2: every lifecycle instant is the server's — a reservation dated ahead, an expiry at the deadline value before the deadline, a seal dated back, an anchor ahead and a record or revision expiry dated ahead are refused; nothing is accepted after the deadline; only the labelled test clock of a test cluster stands a fixture in the past"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd017-seal-revision.test.ts` :: "DENY: a revoked admission → 409 INPUT_NOT_ADMITTED; a changed generation → 409 GENERATION_CHANGED; reused bytes past their window → 409 REUSE_NOT_AVAILABLE; selectionHash of another selection → 409 STALE_VERSION HASH_MISMATCH; stale version → 409; VIEWER → 403; foreign → 404 — the revision stays READY_TO_SEAL"
  - Observes: no sealed manifest, file set, record or event after each denial; KA072 at COMMIT for a seal without its facts.
- **CMD017-RACE**:
  - EXECUTED_LOCAL (both interleavings): `packages/persistence/test/source-migrations.test.ts` :: "a seal and an intake-expiry revocation of its file are ordered by the file's transition lock: a seal in flight commits and the revocation that waited is refused; a revocation in flight commits and the seal that waited is refused"
  - SPECIFIED (B07-COMMANDS): `apps/api/test/cmd017-seal-revision.test.ts` :: "RACE: two seals on one version → one 200, one 409; identical retry replays; the same key with another hash → 409; a crash leaves the revision READY_TO_SEAL; a seal racing the intake-expiry sweeper through the product"
  - Observes: the waiting writer in `pg_stat_activity`; exactly one of seal or revocation committed.

## Gate G-UPLOAD

Owner 09; evidence rule: exact subject, public consumer, independent truth, complete result, meaningful negative control and
reviewer acceptance; verification clause of every case: "Enumerate raw/derived/residual classes and restore after deletion; an
application boolean is insufficient."

- **Raw/derived/residual classes**: the object registry records every generation with its zone and data class (RAW, DERIVED,
  RESIDUAL), its state, deletion result and provider residual (D-OBJ-1, D-OBJ-2); observed by
  `packages/persistence/test/source-migrations.test.ts` :: "R2-051 at the database: after the application deadline the session is tombstoned; a late object is registered as a quarantined residual and deleted under its generation; the deletion records the provider residual the location read-back implies; nothing of it is ever admitted"
  and `packages/persistence/test/source-migrations.test.ts` :: "B07 tables force row-level security, belong to the migrator, grant no DELETE to request handlers and never show customer text to the control plane".
  The DeletionReceipt that enumerates them for a scope and the comparison with provider inventory are **LATER: B16** (G-DELETE,
  CMD042 RequestDeletion, CMD060; S063–S065, R2-053).
- **Restore after deletion**: every terminal authority fact has a tombstone kind (`packages/application/test/source-contracts.test.ts` :: "B07-F8: every event routed to AUTHORITY_JOURNAL produces exactly one tombstone kind and a terminal state — an expired and a rejected revision included — and nothing else produces one",
  EXECUTED_LOCAL); the tombstones are appended outside the database by the AUTHORITY_JOURNAL consumer —
  SPECIFIED (B07-CONTROL): `apps/control/test/authority-journal.test.ts` :: "tombstones of cancelled, expired, rejected and superseded authority are appended once and listed in sequence order"; restoring a backup and applying them before traffic is **LATER: B16** (09 "Deletion receipts and restoration"; 09
  "Acceptance and operating checks" restoration tests).
- **An application boolean is insufficient**: admission is a receipt with separate results, complete coverage of the object and a
  composite key to the promoted generation (database tests), never a flag; `FileManifest.admitted` is derived and a browser cannot
  set it (request schemas); every lifecycle instant is the server's (D-CLOCK-1).
- **EXECUTED_PROVIDER** evidence of storage, scanner and session cancellation, and the OS-level network denial of the inspection
  host, is **LATER: B15** (real adapters, the production worker sandbox); B07's provider clauses are SIMULATED until then.

## Registry verification clauses answered elsewhere

| clause | answer |
|---|---|
| Retention soft deadline from DRAFT_READY (09 unpaid audit sources) | LATER: B03/B08 (the audit's ready and terminal anchors); B07 creates the record with the hard cap of the bytes only (D-RET-2, D-RET-3). |
| EXECUTION_CONTROL on superseded or expired sources and revoked admissions (registry "Revoke reads/execution") | LATER: B08 (the consumer of `dataset_revision.superseded.v1`, `.expired.v1` and `source_file.admission_revoked.v1`); B07 publishes the events and CMD025 already refuses an approval over a source that is not SEALED. |
| Commercial authorizations bound to a replaced revision; the replacement allowance | LATER: B09/B10 (`CommercialScopeInspector` and `RevisionLineageReader`, design §17). |

## Supporting evidence of this branch (no case of its own)

- `packages/persistence/test/aggregate-kinds.test.ts` :: "every registered kind binds: each aggregate of A was born and walked under the role that owns it with one bound event per version, and an event at or below its version passes the binding (only the one-event-per-version identity refuses a second)" — B07's three kinds bind through the foundation's function (B07-F7).
- `packages/persistence/test/migrations.test.ts` :: "B07 D-CLOCK-1: the shipped kauro.server_now() is the transaction time and nothing else — no setting, no offset — and no runtime role can redefine it" — the shipped clock (B07-F2).
- `tools/test/openapi.test.mjs` :: "B07-F13: the source-lifecycle routes are documented from their contracts as planned operations — every specified command and route, never registered, never also served; a missing planned route, a registered planned route, a repeated operationId and a forbidden DTO member fail the check" — the planned operations (B07-F13).
- `packages/application/test/source-contracts.test.ts` :: "B07-F13: the sweepers of the contracts are exactly the sweepers of design §12.5, LOCATION_POLICY and RETENTION included".
- `packages/persistence/test/source-migrations.test.ts` :: "the control plane writes only the rows of the agency it is bound to, and appends only the events of the source-lifecycle edges it owns, as a service" — D-CTRL-1/D-CTRL-2, including the refusal of `dataset_revision.inspecting.v1` (B07-F1).
