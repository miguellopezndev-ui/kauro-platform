# B16 lane L3 failure-mode matrix (CMD042 RequestDeletion + DELETION_EXECUTOR)

Source rows: `.kauro/mandates/B16-REST-PLAN.md` section 2 "CMD042 RequestDeletion + deletion executor (L3)" (GAP-DEL-P1..P4,
GAP-DEL-1..8, R2-056, R2-057, R2-125) and CHECKLIST A-15. Template and columns: `docs/design/FAILURE-MATRIX-TEMPLATE.md`. Tests were
written first (base edb7543: no route, no `deletion_requests` / `deletion_receipts`, no DELETION_EXECUTOR, no prevention guard). Every
cell names its test as `file :: "exact title"`. A cell moves from **GAP (red)** to **C** in the builder's commit, which names the
red-proof (`node tools/builder/red-proof.mjs <base> <head> --tests <file>`) in its message.

Rows: **R1** = the request's COMMIT (route, authorizer, one transaction). **R2** = the executor's steps: tombstone, cancel attempts
and provider sessions, enumerate, delete by generation, compare inventory, receipt, close.

Test files: `A` = `apps/api/test/cmd042-request-deletion.test.ts`, `X` = `apps/control/test/b16-deletion-executor.test.ts`.

## Contract the tests bind (decided here, from the plan and the registry; the builder implements it)

- **Route** (registry CMD042): `POST /api/v1/projects/{projectId}/deletion-requests`. Role AGENCY_OWNER_OR_ADMIN. Idempotency
  REQUIRED. Answer **200** `COMPLETED`. Body `{ expectedVersion (project version), reasonCode, assuranceProofRef }`. The reason
  codes are the contract's RETENTION, AGENCY_REQUEST, ACCOUNT_CLOSURE and INCIDENT, plus **END_OF_SERVICE** (A-15; the builder adds
  it to the contract).
- **View `data`**: `deletionId, projectId, state "REQUESTED", reasonCode, requestedAt, projectState "DELETION_REQUESTED",
  projectVersion` (the next version), and `scope { revisionIds, retentionIds, packageVersionIds }`. It also carries
  `receiptScope "COMPLETE_FOR_MANAGED_SCOPE"` and `excludedFromManagedScope ["CUSTOMER_DOWNLOADED_COPIES", "EXTERNAL_CRM_IMPORTS"]`.
- **One COMMIT** (as kauro_app) writes all of the following:
  - The project moves OPEN/CLOSED -> DELETION_REQUESTED at version + 1, with `project.deletion_requested.v1`. Its payload is
    `{ projectId, agencyId, deletionId, reasonCode }`. It is routed to **DELETION_EXECUTOR** and **AUTHORITY_JOURNAL**.
    `AUTHORITY_TOMBSTONES["project.deletion_requested.v1"] = { kind: "PROJECT_DELETION_REQUESTED", state: "DELETION_REQUESTED" }`.
    The tombstone kind and state unions grow accordingly.
  - One `kauro.deletion_requests` row. Columns used by the tests: `deletion_id, agency_id, project_id, state` (default
    `REQUESTED`), `reason_code, requested_by_membership_id, requested_by_user_id, assurance_proof_ref, requested_at` (default
    server_now). The row is unique on `(agency_id, project_id)`. The states are the DeletionRequest contract's.
  - Every ACTIVE or EXPIRED retention record of the project moves to DELETING at version + 1, each with
    `retention_record.deleting.v1` `{ retentionId, agencyId, projectId, deletionId }`.
  - The CMD042 journal entry, COMMITTED 200.
  - No stored object is touched: the request tombstones authority, and the executor deletes.
- **Step-up re-judged at COMMIT** (0040 pattern): a proof past its expiry at the COMMIT is KC020, answered
  `403 ASSURANCE_REQUIRED STEP_UP_STALE`.
- **Refusals**:
  - `409 PRECONDITION_FAILED PROJECT_DELETION_REQUESTED`: the project is already DELETION_REQUESTED, or a prevention guard fires.
  - `404 NOT_FOUND -`: a foreign or nonexistent project.
  - `403 NOT_AUTHORIZED ROLE_INSUFFICIENT`: VIEWER or OPERATOR.
  - `403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED`.
  - `403 ASSURANCE_REQUIRED STEP_UP_STALE / STEP_UP_NOT_OWNED`.
  - `409 STALE_VERSION -`.
  - `409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS`.
- **Prevention guards** (09 "Early deletion": "first prevent"). A DB guard raises **KA087** (B16_L3_DELETION_A ->
  `PRECONDITION_FAILED / PROJECT_DELETION_REQUESTED`) on a DELETION_REQUESTED or DELETED project for:
  - an upload reservation (CMD013, which today answers `PROJECT_NOT_OPEN`);
  - StartAudit;
  - model dispatch (`beginDispatch` and the DISPATCHING edge);
  - payment order creation;
  - publication and download issuance (publication is already refused by 0024 KA081 project OPEN).
- **DELETION_EXECUTOR** (control consumer composed in `plane.consumers`, name `DELETION_EXECUTOR`), in this order:
  1. The tombstone is present in the authority journal before the first `storage.delete`.
  2. Live attempts are cancelled (the CMD037 path, EXECUTION_CONTROL ends them CANCELLED), live audits are cancelled (actor
     SERVICE), and model reservations are released.
  3. Provider sessions are cancelled.
  4. Every `stored_objects` row of the project is deleted by its generation; a missing object counts as an ALREADY_ABSENT success.
     Each result is committed in its own unit before the next delete.
  5. The inventory is compared: `listSoftDeleted` on the project's prefixes, with the provider's own `expiresAt`.
  6. A receipt is appended to `kauro.deletion_receipts`.
- **Receipt row** (`kauro.deletion_receipts`):
  - columns `receipt_id, deletion_id, agency_id, project_id, status, body jsonb, created_at`;
  - `status` is `PARTIAL | COMPLETE_FOR_MANAGED_SCOPE`;
  - `body` holds `objects[{objectId, zone, generation, result}]`, `residuals[{objectId, generation, cause, retry: "DELETION_RETRIES"}]`,
    `providerResiduals[{objectName, generation, expiresAt}]`, `derived[{kind: AUDIT|MODEL_TASK, id}]` and
    `excluded["CUSTOMER_DOWNLOADED_COPIES","EXTERNAL_CRM_IMPORTS"]`.
- **Closing**:
  - On COMPLETE: the package versions become DELETED and the records DELETED, or DELETED_WITH_RESIDUALS when provider residuals
    exist. The request is COMPLETED and the project DELETED. The consumer outcome is DONE.
  - On PARTIAL: the request is FAILED_RETRYABLE, the project stays DELETION_REQUESTED and the records stay DELETING. The outcome is
    RETRY. DELETION_RETRIES closes the object, and the next delivery appends the COMPLETE receipt.
  - A duplicate delivery after COMPLETE deletes nothing and appends nothing (DONE).
- **Receipt guard KA088** (B16_L3_DELETION_B): a `COMPLETE_FOR_MANAGED_SCOPE` receipt is refused while any `stored_objects` row of
  the deletion is not DELETED. A `deleted_at` alone never completes the receipt: the executor compares the provider's state.
- **Request fixture in `X`**: `requestAsHandler` performs exactly the COMMIT writes above, as kauro_app with PgEventPublisher. The
  builder's handler, grants and triggers must accept it.

## Cells

| Row | Cell | Status | Proof |
|---|---|---|---|
| R1 | OK (request) | GAP (red) | A :: "CMD042-OK (request): the OWNER with a fresh step-up requests deletion of a project with a published package — 200 with the project DELETION_REQUESTED at the next version, one REQUESTED deletion request, every retention record of the project DELETING, project.deletion_requested.v1 routed to DELETION_EXECUTOR and AUTHORITY_JOURNAL (tombstone PROJECT_DELETION_REQUESTED) and the CMD042 journal entry in one COMMIT; the request deletes no object and discloses the receipt scope COMPLETE_FOR_MANAGED_SCOPE excluding downloaded copies and CRM imports" |
| R1 | DENY | GAP (red) | A :: "CMD042-DENY: foreign 404, VIEWER 403, no step-up, stale version, already DELETION_REQUESTED; a restored database replaying the journal cannot resurrect" |
| R1 | DENY prevention GAP-DEL-P1 | GAP (red) | A :: "CMD042-DENY (prevention): after DELETION_REQUESTED an upload reservation is refused PROJECT_DELETION_REQUESTED" |
| R1 | DENY prevention GAP-DEL-P2 | GAP (red) | A :: "CMD042-DENY (prevention): after DELETION_REQUESTED a StartAudit is refused PROJECT_DELETION_REQUESTED" |
| R2 | DENY prevention GAP-DEL-P3 | GAP (red) | X :: "CMD042-DENY (prevention): after DELETION_REQUESTED a model dispatch is refused PROJECT_DELETION_REQUESTED" |
| R1 | DENY prevention GAP-DEL-P4 | GAP (red) | A :: "CMD042-DENY (prevention): after DELETION_REQUESTED a payment order is refused PROJECT_DELETION_REQUESTED" |
| R1 | RACE GAP-DEL-1 | GAP (red) | X :: "CMD042-RACE: deletion held at the project transition lock against a publication and a job admission, both orders — a package published first is enumerated and deleted, one published second never becomes AVAILABLE" |
| R1 | TIMEOUT | N/A here (C runtime) | A lock or statement timeout becomes a retryable CAPACITY_UNAVAILABLE with no change: `packages/persistence/test/adapters-unit-of-work.test.ts` "statement_timeout is transaction-local ..." |
| R1 | EXPIRY GAP-DEL-3 | GAP (red) | A :: "RACE (expiry): RETENTION expiring a record of the project during the request, both orders — the request holding the records first: the sweeper's CAS misses and the record stays DELETING; the sweeper first: the request waits at the record lock and takes the listed EXPIRED -> DELETING edge" |
| R1 | EXPIRY (step-up at COMMIT) GAP-DEL-7 | GAP (red) | in A REVOCATION (below): the proof's expiry passes while the request waits at the project's transition lock |
| R1 | CRASH-BEFORE GAP-DEL-4 | GAP (red) | A :: "RACE (crash before COMMIT): a crash after the project, the deletion request and the records DELETING are written leaves the project OPEN, the records ACTIVE and nothing tombstoned; the same key then requests the deletion once" |
| R1 | CRASH-AFTER | GAP (red) | A :: "RACE (crash after COMMIT): the request's lost answer is recovered by the key; the project is DELETION_REQUESTED once with one deletion request and one tombstone event" |
| R1 | RETRY GAP-DEL-6 (request) | GAP (red) | A :: "RETRY: an identical replay answers 200 byte for byte and writes nothing; the same key with another reasonCode is 409 IDEMPOTENCY_CONFLICT" |
| R1 | REVOCATION GAP-DEL-7 | GAP (red) | A :: "REVOCATION: an ADMIN demoted to VIEWER before the request is refused ROLE_INSUFFICIENT, an ADMIN suspended in flight makes the request wait on the authorizer and is refused MEMBERSHIP_SUSPENDED, and a step-up that goes stale while the request waits at the project's transition lock is refused at the COMMIT ASSURANCE_REQUIRED STEP_UP_STALE; nothing written" |
| R1 | PARTIAL | GAP (red) | A :: "PARTIAL: a fault at the second record's retention_record.deleting.v1, after the project, the deletion request, both records and the first record's event are written, rolls back the whole footprint and the journal entry; the same key then requests the deletion once" |
| R1 | A-15 | GAP (red) | A :: "A-15: reasonCode END_OF_SERVICE records the customer's return-or-delete choice in deletion_requests" |
| R2 | OK (executor) | GAP (red) | X :: "CMD042-OK: the executor of a requested deletion deletes every registered object of the project by its generation, closes the published package DELETED and the records DELETED, completes the request and the project DELETED — tombstone journaled before any object delete; receipt COMPLETE_FOR_MANAGED_SCOPE excludes downloaded copies and CRM imports" |
| R2 | RACE | GAP (red) | X GAP-DEL-1 (above), executor halves: the package published first is DELETED and its delivery copies are enumerated in the receipt; the queued and admitted jobs end CANCELLED |
| R2 | TIMEOUT GAP-DEL-2 | GAP (red) | X :: "RACE (timeout): a provider delete that times out records DELETION_FAILED with the object as residual; DELETION_RETRIES finishes it" |
| R2 | EXPIRY | N/A | The executor judges no deadline. The provider's own soft-delete expiry is reported, not judged: R2-056 below |
| R2 | CRASH-BEFORE | C by construction of the next cell | A crash before a result's COMMIT is the case GAP-DEL-5 injects (the second object's result unit dies before COMMIT) |
| R2 | CRASH-AFTER GAP-DEL-5 | GAP (red) | X :: "RACE (crash after COMMIT): executor crash between object deletions resumes from recorded results; a missing object is an absence success, never recreated" |
| R2 | RETRY GAP-DEL-6 (redelivery) | GAP (red) | X :: "RETRY (redelivery): a duplicate project.deletion_requested.v1 delivery after the deletion completed deletes nothing twice and appends no second receipt" |
| R2 | REVOCATION | N/A | The executor holds no grant, membership or step-up. Its authority is the committed request; attempts' lease fences are revoked by the CMD037 path (GAP-DEL-1, admission halves) |
| R2 | PARTIAL GAP-DEL-8 (S064) | GAP (red) | X :: "S064: provider refuses one of three generations: receipt PARTIAL names the residual and the retry; never COMPLETE from deleted_at" |
| R2 | R2-056 | GAP (red) | X :: "R2-056 (SIM): noncurrent versions left by an earlier policy are inventoried with their actual expiry, never reported vanished" |
| R2 | R2-057 (deletion half) | GAP (red) | X :: "R2-057 (deletion half): audit model context and derived rows of the project are enumerated and tombstoned" |
| R1 | OK (revisions) | BUILT (green on 0070) | A :: "CMD042-OK (revisions): every mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL) is CANCELLED through cancel_revision in the request's COMMIT with its event; SEALED, REJECTED and EXPIRED are left as they are and no event names them" |
| R2 | CRASH-AFTER-COMMIT-BEFORE-EXECUTOR (revisions) | BUILT (green on 0070) | X :: "CMD042-OK (revisions) and CRASH-AFTER-COMMIT-BEFORE-EXECUTOR: ..." revisions end CANCELLED/EXPIRED after the request, a first delivery that cannot finish leaves them undeleted, the redelivered executor moves exactly those to DELETED and publishes dataset_revision.deleted.v1 for them only |
| R1 | DENY (revisions) | BUILT (green on 0070) | A and X :: "CMD042-DENY (revisions): ..." no tenant or control path takes a SEALED revision to DELETED, nor a CANCELLED one before the project's deletion completed (KA088); a tenant cannot forge dataset_revision.deleted.v1 |
| R2 | SEALED and REJECTED revisions (R2 has no deletion edge) | OPEN GAP (not N/A) | Left in their state and named in the receipt (retainedRevisions); needs a versioned contract to be deleted with the project (see Builder decisions) |
| R1 | R2-125 | PENDING L2 merge | "R2-125: extension vs deletion on one retention version, both orders: one valid transaction wins; an extension after deletion is refused and never revives access" (needs CMD060 from b16/retention on main) |
| R2 | provider-session cancellation step | GAP (no own cell) | Step 3 has no cell of its own in the plan. It is covered only when a project with an open upload session is deleted; L3 builder adds one, or L5 does |

Red evidence on edb7543 (Windows, PGBIN C:\Tools\pgsql17\bin). Every failure is an AssertionError:
- A, 12 tests: route not registered (`404 NOT_FOUND -` where 200 or the named refusal is expected) for OK, DENY (first non-foreign
  refusal: VIEWER), EXPIRY, CRASH-BEFORE, CRASH-AFTER, PARTIAL, RETRY, REVOCATION and A-15.
- P1 answers `409 PRECONDITION_FAILED PROJECT_NOT_OPEN` (the named refusal is missing).
- P2 queues an audit and P4 creates a payment order (201): the guard is missing.
- X, 9 tests: `migration b16_deletion creates kauro.deletion_requests` for every executor cell. P3 answers `RESERVED`, so the
  dispatch guard is missing.

Notes.
- GAP-DEL-3, 4, 6 and 7 have no exact title in the plan; their titles here are composed in house style.
- The plan's OK title contains "..." and has two halves (A request, X executor).
- The DENY "restored database replaying the journal" half is L6 (restore). L3 asserts that the tombstone is routed to
  AUTHORITY_JOURNAL with the deletion's id, and that the request role cannot move DELETION_REQUESTED -> OPEN.
- The plan's step list puts "append tombstone" after the inventory compare. The OK title and 09 say it comes before any object
  delete, and the tests follow that.
- The plan names KA086 DELETION_AUTHORITY and KA087 DELETION_RECEIPT. The merged `sqlstate.ts` allocates L3 KA087 and KA088
  (KA086 is L2's): KA087 = the prevention guard, KA088 = receipt integrity.

## Builder decisions (2026-10-14, coordinator-approved)

- **Files**: the repository is `packages/persistence/src/source/deletion.ts` (`PgDeletionRepository`), the executor
  `apps/control/src/consumers/deletion-executor.ts`, the migration `0070_b16_deletion.sql` (provisional number).
- **END_OF_SERVICE** is in the request schema, the response view, the migration CHECK and the generated clients. The vendored
  authority registry (`packages/contracts/registry/contracts.json`, DeletionRequest.reason) is hash-pinned by its provenance test
  (`registry provenance verifies and every vendored file is hashed`); editing it breaks that evidence, so it is carried as a
  platform-contract widening and the registry stays as vendored (N/A here; an authority amendment would regenerate it).
- **Uploads in flight** are cancelled in CMD042's COMMIT (revision lock, upload lock, `cancel_upload`, reason
  `PROJECT_DELETION_REQUESTED`, `upload_session.cancelled.v1` routed to STORAGE_LIFECYCLE), which cancels the provider session
  (`cancelProviderSession`, REQUESTED -> recorded). Cell: `CMD042-OK (uploads)` in cmd042-request-deletion.test.ts.
- **Revisions (coordinator decision 2026-10-14; R2 `registry/state_transitions.json` DatasetRevision, never a direct SEALED -> DELETED
  edge).** (1) CMD042's COMMIT moves every mutable revision (DRAFT, UPLOADING, INSPECTING, READY_TO_SEAL) to CANCELLED through
  `cancel_revision` (reason `PROJECT_DELETION_REQUESTED`, `dataset_revision.cancelled.v1` with `previousState` and the cancelled
  upload ids) in the one transaction, so a project is never half deleted; an UPLOADING revision's sessions are cancelled first.
  (2) SEALED and REJECTED have no deletion edge, and R2 does not say a deletion request makes their effective deadline "now" (09
  "Early deletion" and the retention text were read for it): they stay SEALED or REJECTED, their reads and execution end through the
  project's DELETION_REQUESTED fact, and the receipt names them in `retainedRevisions` (`NO_DELETION_EDGE_FROM_SEALED`,
  `NO_DELETION_EDGE_FROM_REJECTED`). **OPEN GAP, not N/A**: if the owner or R2 wants their data gone with the project, that needs a
  versioned contract (a deadline-now rule, then `retention_expires`, then `managed_cleanup_verified`); it is not invented here.
  SUPERSEDED is out of scope (the retention lane owns it) and is named `SUPERSEDED_OWNED_BY_RETENTION` if present.
  (3) The executor, after the cleanup is verified (a complete receipt), applies `managed_cleanup_verified` in the closing unit to every
  CANCELLED and EXPIRED revision and publishes `dataset_revision.deleted.v1` (`deletedObjectCount`, `residualObjectCount`,
  `tombstoneHash` = sha256 of deletion id, revision id, previous state and the exact generations deleted for it) for those only.
  The database guard `dataset_revisions_deleted_guard` (KA088) refuses DELETED from any other state or without the completed
  deletion of the same transaction; the control role has a policy and a `deleted_at` grant for it and no other path. Lock order:
  deletion row, project, revisions, records, packages (the receipt unit takes the first four before it reads, so a retention sweep
  cannot move a SEALED revision to EXPIRED between the receipt and the close). Cells: `CMD042-OK (revisions)` (api, one revision per
  state), `CMD042-OK (revisions) and CRASH-AFTER-COMMIT-BEFORE-EXECUTOR` (control), `CMD042-DENY (revisions)` (api and control).
- **LEGAL_FINANCE and SECURITY** are outside the managed scope by 09 ("LEGAL_FINANCE and SECURITY contain separately classified
  residual records"; "Financial evidence storage can use a different retention design under the legal profile"). The receipt names
  the project's registered objects of those zones in `retainedByPolicy` (`objectId, zone, basis`), never deleting them. Cell:
  `CMD042-OK (retained by policy)`.
- **RETRY** is an honest `{kind: "RETRY", afterSeconds, reason}`; the S064 cell asserts kind, `afterSeconds > 0` and the reason.
- **Project deletion never clears a hold it did not place**: the stray-hold release of `releaseBeforeDeletion` is skipped for a managed
  deletion (the platform's own seal holds are released as before); the provider's refusal is the residual and DELETION_RETRIES its retry.
- **Job cancellation**: `liveJobsRelyingOn({kind: "PROJECT"})` also returns CANCEL_REQUESTED jobs, so the deletion finishes the
  reconciliation (slot, private package) a refused publication left pending.
- **Test defects fixed (each proven, no assertion weakened)**: the fault sequence of the CMD042 fixture needed `GRANT USAGE ON SEQUENCE`
  for kauro_app; the stale-version probe used version 0 (400 at the schema minimum) and now uses `version + 1`; the executor fixture
  registered QUARANTINE and ACCEPTED objects with no provider bytes (only two live generations, S064 needs three), so `published()` now
  plants them at their registered generations (`plantGeneration`); S064's forged `deleted_at` needs `provider_residual_basis` to satisfy
  `stored_objects_residual_basis`; CMD042-RACE waits on the publication's `kauro.await_transition` statement (the project's shared transition
  lock, taken before any package statement), not on a `package_versions` statement; `command-contracts` lacked CMD060/CMD042 in WITH_SUPPORT.
