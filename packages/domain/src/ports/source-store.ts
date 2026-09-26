/**
 * Source-lifecycle repository ports (B07; tables of migrations 0009..0012). They extend the B06 foundation without forking it:
 * every repository lives inside a unit of work and its bound context (RLS decides visibility; a write outside the context fails
 * WITH CHECK), versioned writes are compare-and-swap returning VersionedWrite, a new aggregate version is published by the caller
 * through the same EventPublisher, and the command journal is the same table. Implementations belong to @kauro/persistence
 * (mandate B07-PERSISTENCE, docs/design/B07-upload-source-lifecycle.md §15).
 *
 * `SourceUnitOfWork` is the B06 UnitOfWork plus `sources`. The factory gains `runSource` instead of changing `run`, so the B06
 * handlers and adapters compile untouched; at integration `sources` folds into UnitOfWork (one member, design §13).
 *
 * Database refusals surface as typed failures (sqlstate translation, mandate B07-PERSISTENCE; the B07 range KA070..KA072 is
 * decision D-SQL-1): the quota CHECKs are PRECONDITION_FAILED / REVISION_QUOTA_EXCEEDED or REVISION_FILE_LIMIT, the per-file CHECK
 * is PRECONDITION_FAILED / FILE_TOO_LARGE, the capacity CHECK is ADMISSION_LIMITED / UPLOAD_CONCURRENCY_LIMITED, KA070 is
 * INTEGRITY_FAILURE / QUOTA_LEDGER, KA071 is PRECONDITION_FAILED / FENCE_DISCIPLINE, KA072 is INTEGRITY_FAILURE /
 * LIFECYCLE_BINDING_MISSING (a handler that checked its preconditions first never meets it), dataset_revisions_one_mutable_per_project
 * and dataset_revisions_supersedes_once are PRECONDITION_FAILED / REVISION_NOT_MUTABLE and PREDECESSOR_NOT_CURRENT.
 *
 * Lock order (decision D-LOCK-1, design §5): project row → revision row (FOR NO KEY UPDATE, the lock every revision transition
 * takes first) → revision transition lock (the guard's, then B06's trigger) → upload rows → quota ledgers (revision, then agency
 * capacity) → object registry rows → a file's transition lock. A reservation takes the revision row itself (the BEFORE INSERT
 * trigger), so every writer of a revision's intake is ordered on that row. The control plane follows the same order (D-LOCK-2,
 * B07-F14): a unit of work that changes an upload, a file or the revision locks the revision row first (`revisions.lock`), then
 * the upload (`uploads.lock`) — never an upload before its revision.
 *
 * Instants (decision D-CLOCK-1, B07-F2): every instant a deadline is computed from or compared with — an upload's creation, a
 * session issue, a completion report or observation, an admission, a rejection, a cancellation, an expiry, a seal, a
 * supersession, a retention anchor, a revocation, a deletion — is the database's transaction time `kauro.server_now()`, written by
 * the adapter in SQL (never a caller-supplied instant, which the database refuses, KA072) and returned in the record. The ports
 * below therefore take no such instant; `SourceUnitOfWork.serverInstant()` reads it (exact to the microsecond) when a digest must
 * cover it (KAURO_RETENTION_ANCHOR_V1). Deadlines derive from it in SQL (application_expires_at = created_at + 86,400 s; an UNPAID
 * hard deadline = the bytes' first seal + 1,209,600 s, D-RET-3).
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProjectRecord } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, ClientId, JournalEntryId, MembershipId, PlanId, ProjectId, RevisionId, UserId } from "../model/ids.js";
import type { RevisionInventory } from "../model/source/digests.js";
import type { EvaluationId, RetentionAnchorId, RetentionId, SelectionManifestId, SourceFileId, SourceTableId, StoredObjectId, UploadId } from "../model/source/ids.js";
import type {
  AdmissionRevocationReason,
  CompletionClaim,
  DataClass,
  DeclaredFormat,
  DeletionResult,
  InspectionReceiptRecord,
  ProviderCancellationState,
  RejectionClass,
  RetentionAnchorRecord,
  RetentionRecordRow,
  RevisionQuota,
  SealedManifestRecord,
  SealedSessionSecret,
  SelectionEvaluationRecord,
  SelectionManifestRecord,
  SourceColumnRecord,
  SourceFileRecord,
  SourcePopulations,
  SourceRevisionRecord,
  SourceTableRecord,
  StorageLocationPolicyRecord,
  StorageZone,
  StoredObjectRecord,
  UploadCapacity,
  UploadSessionRecord,
  UploadState,
} from "../model/source/records.js";
import type { SelectionManifestDocument } from "../model/source/selection.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { VersionedWrite } from "./repositories.js";
import type { UnitOfWork, UnitOfWorkFactory, UnitOfWorkOptions } from "./unit-of-work.js";

/** A page of a list read (07: pagination uses a total ordering with a unique tie-breaker and never crosses the agency). */
export interface SourcePage<Cursor> {
  readonly after?: Cursor;
  readonly limit: number;
}

// --- upload sessions -----------------------------------------------------------------------------------------------------------

export interface NewUploadSession {
  readonly uploadId: UploadId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly displayName: string;
  readonly declaredFormat: DeclaredFormat;
  readonly reservedBytes: number;
  readonly quarantineObjectId: StoredObjectId;
  readonly requestedByMembershipId: MembershipId;
  readonly requestedByUserId: UserId;
  // created_at and application_expires_at are the database's (D-CLOCK-1): the adapter writes kauro.server_now() and + 86,400 s
}

/** The listed UploadSession edges (platform machine, D-UP-1) with the facts each one records; its instant is the server's. */
export type UploadTransition =
  | { readonly event: "session_issued"; readonly sessionAttempt: number; readonly providerSessionDigest: Sha256Hex; readonly providerSessionLifetimeSeconds: number }
  | { readonly event: "completion_reported"; readonly claimDigest: Sha256Hex; readonly claim: CompletionClaim }
  | { readonly event: "completion_not_observed" }
  | { readonly event: "inspection_admitted"; readonly fileId: SourceFileId; readonly receiptHash: Sha256Hex; readonly inspectionFence: number }
  | { readonly event: "inspection_rejected"; readonly receiptHash: Sha256Hex; readonly rejectionClass: RejectionClass; readonly inspectionFence: number }
  /**
   * The request handler's tombstone (CMD015, CMD012). It carries no provider cancellation: the database requests it in the same
   * update when a session was issued (upload_sessions_cancellation_requested), and only the control plane records the provider's
   * answer (D-ROLE-3).
   */
  | { readonly event: "cancel_upload"; readonly byMembershipId: MembershipId; readonly reason: string }
  /** At or after the application deadline on the server clock only (the database refuses an earlier expiry, KA072). */
  | { readonly event: "reservation_expired"; readonly reason: string; readonly providerCancellation: "NOT_REQUESTED" | "REQUESTED" }
  | { readonly event: "intake_deadline_reached"; readonly reason: string };

export interface UploadSessionRepository {
  get(uploadId: UploadId): Promise<UploadSessionRecord | null>;
  /** SELECT ... FOR UPDATE (lock order D-LOCK-1: project, revision, upload). */
  lock(uploadId: UploadId): Promise<UploadSessionRecord | null>;
  /**
   * Inserts a RESERVED upload at version 1. The quota trigger adds its bytes, file and slot to the ledgers under their row locks;
   * a combination beyond the envelope is refused there (R2-052), not by this call's own reads.
   */
  insert(upload: NewUploadSession): Promise<UploadSessionRecord>;
  /** Applies a listed UploadSession edge at expectedVersion + 1; a stale expectation returns the current version and state. */
  transition(uploadId: UploadId, expectedVersion: number, change: UploadTransition): Promise<VersionedWrite<UploadSessionRecord>>;
  /** Advances the session-issue fence of a RESERVED upload unexpired on the server clock (no version bump); null when it no longer qualifies. */
  claimSessionAttempt(uploadId: UploadId): Promise<number | null>;
  /**
   * Advances the inspection fence of a VERIFYING upload (no version bump) and returns it with the claim instant the database stamped
   * (D-INSP-4) — the `startedAt` of the attempt's receipt; null when it is no longer VERIFYING.
   */
  claimInspectionAttempt(uploadId: UploadId): Promise<{ readonly inspectionFence: number; readonly claimedAt: UtcInstant } | null>;
  /** Records what the provider holds for a VERIFYING upload (set once) at expectedVersion + 1 (upload_session.completion_observed.v1). */
  recordObservation(uploadId: UploadId, expectedVersion: number, observation: { readonly generation: string; readonly bytes: number }): Promise<VersionedWrite<UploadSessionRecord>>;
  /** Records the provider cancellation result at expectedVersion + 1 (upload_session.provider_cancellation_recorded.v1). */
  recordProviderCancellation(uploadId: UploadId, expectedVersion: number, result: Exclude<ProviderCancellationState, "NOT_REQUESTED" | "REQUESTED">): Promise<VersionedWrite<UploadSessionRecord>>;
  listByRevision(revisionId: RevisionId, page: SourcePage<{ readonly createdAt: UtcInstant; readonly uploadId: UploadId }>): Promise<ReadonlyArray<UploadSessionRecord>>;
  /** Uploads of the revision in the given states (bounded by the 50-file envelope). */
  inStates(revisionId: RevisionId, states: ReadonlyArray<UploadState>): Promise<ReadonlyArray<UploadSessionRecord>>;
  quota(revisionId: RevisionId): Promise<RevisionQuota>;
  capacity(agencyId: AgencyId): Promise<UploadCapacity>;
  /** Control-plane discovery (unbound SYSTEM context, no customer text): live or unsealed-admitted uploads past their deadline on the server clock. */
  findDeadlinePassed(limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly revisionId: RevisionId; readonly state: UploadState }>>;
  /** Control-plane discovery: provider cancellations REQUESTED or UNCERTAIN whose provider horizon has not passed on the server clock. */
  findProviderReconciliation(limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly revisionId: RevisionId }>>;
}

export interface SessionSecretRepository {
  /** Stores the sealed provider session reference of the requester (RLS: the requester's own row only). */
  store(secret: SealedSessionSecret): Promise<void>;
  /** The requester's own secret while the upload is UPLOADING and unexpired; null otherwise (the database decides, not the caller). */
  readOwn(uploadId: UploadId): Promise<SealedSessionSecret | null>;
  /** Control plane bound to the agency: the secret needed to cancel the provider session. */
  readForRevocation(uploadId: UploadId): Promise<SealedSessionSecret | null>;
  /** Control plane: deletes the temporary control record once the provider cancellation resolved or its horizon passed. */
  purge(uploadId: UploadId): Promise<boolean>;
}

// --- object registry ---------------------------------------------------------------------------------------------------------------

export interface NewStoredObject {
  readonly objectId: StoredObjectId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId?: RevisionId;
  readonly uploadId?: UploadId;
  readonly fileId?: SourceFileId;
  readonly zone: StorageZone;
  readonly dataClass: DataClass;
  readonly provider: string;
  readonly locationRef: string;
  readonly objectName: string;
  readonly createdBy: StoredObjectRecord["createdBy"];
  readonly createdAt: UtcInstant;
  /** A registration of an object already observed (late or orphan residual found by inventory) carries its facts. */
  readonly observed?: { readonly generation: string; readonly bytes: number; readonly observedAt: UtcInstant; readonly late: boolean };
}

/**
 * The object registry (09 "Storage zones and object registry"). Its rows are the deletion inventory, not aggregates (decision
 * D-OBJ-3, B07-F9): no version, no domain event; a lost or changed accepted generation reaches consumers through the SourceFile
 * aggregate it revokes (source_file.admission_revoked.v1), and the deletion package (B16) reads the registry itself.
 */
export interface StoredObjectRepository {
  get(objectId: StoredObjectId): Promise<StoredObjectRecord | null>;
  /**
   * Registers an intent (INTENDED) before any provider write. Every row is born INTENDED (B06 D-INIT-1): an object found by a stat
   * or by inventory (a late or orphan residual) is registered and then observed in the same unit of work (`register` + `observe`).
   */
  register(object: NewStoredObject): Promise<StoredObjectRecord>;
  /** INTENDED -> PRESENT with generation and length (set once); `late` marks an object observed after acceptance was tombstoned. */
  observe(objectId: StoredObjectId, observed: { readonly generation: string; readonly bytes: number; readonly observedAt: UtcInstant; readonly late: boolean }): Promise<StoredObjectRecord>;
  /** PRESENT -> VERIFIED with the SHA-256 the server recomputed over the complete generation. */
  verify(objectId: StoredObjectId, sha256: Sha256Hex, verifiedAt: UtcInstant): Promise<StoredObjectRecord>;
  /**
   * -> DELETION_REQUESTED for each object not already requested or deleted, at the server's transaction time; returns how many moved.
   * An accepted generation whose file's admission still stands — retained by a seal's record or by its intake window — is refused
   * (PRECONDITION_FAILED): its admission is revoked first (decision D-PERS-4).
   */
  requestDeletion(objectIds: ReadonlyArray<StoredObjectId>, reason: string, at: UtcInstant): Promise<number>;
  /**
   * Records the provider result at the server's transaction time: DELETED / ALREADY_ABSENT -> DELETED with the provider residual
   * (D-OBJ-2: the adapter writes basis LOCATION_POLICY and the residual the location's latest read-back implies — the database
   * refuses any other value, a deletion at a location never read back, and a deletion instant that is not its clock, D-CLOCK-1);
   * PRECONDITION_FAILED / PROVIDER_ERROR -> DELETION_FAILED.
   */
  recordDeletion(objectId: StoredObjectId, result: DeletionResult): Promise<StoredObjectRecord>;
  /**
   * Records a generation that provider inventory found already soft-deleted (09: record the actual expiry rather than claiming it
   * vanished): registered, requested and DELETED (ALREADY_ABSENT) in one unit of work, with the expiry the provider reported
   * (basis PROVIDER_REPORTED).
   */
  recordProviderResidual(object: NewStoredObject & { readonly generation: string; readonly softDeletedAt: UtcInstant; readonly providerExpiresAt: UtcInstant }): Promise<StoredObjectRecord>;
  retryDeletion(objectId: StoredObjectId, at: UtcInstant): Promise<StoredObjectRecord>;
  /** Appends a retention read-back of a location (control plane; append-only), observed at the server's transaction time (D-CLOCK-1). */
  recordLocationPolicy(observation: Omit<StorageLocationPolicyRecord, "observedAt">): Promise<StorageLocationPolicyRecord>;
  /** The latest read-back of a location at or before an instant, or null when it was never read back. */
  locationPolicyAt(provider: string, locationRef: string, at: UtcInstant): Promise<StorageLocationPolicyRecord | null>;
  /** The deletion inventory of a scope: every registered object with its zone, class, state and result (raw/derived/residual). */
  inventory(scope: { readonly projectId: ProjectId; readonly revisionId?: RevisionId; readonly uploadId?: UploadId }): Promise<ReadonlyArray<StoredObjectRecord>>;
  findByName(provider: string, locationRef: string, objectName: string): Promise<ReadonlyArray<StoredObjectRecord>>;
  /** Control-plane discovery: objects awaiting a deletion attempt. */
  pendingDeletion(limit: number): Promise<ReadonlyArray<{ readonly objectId: StoredObjectId; readonly agencyId: AgencyId }>>;
}

// --- inspection, files, inventory ------------------------------------------------------------------------------------------------

export interface InspectionReceiptRepository {
  /**
   * Appends the receipt of the current attempt of a VERIFYING upload (a stale attempt is refused by the database, KA071), recorded at
   * the server's transaction time. Its instants are bounded by the server's (D-INSP-4, KA072 otherwise): `startedAt` is the attempt's
   * claim instant (`UploadSessionRepository.claimInspectionAttempt`), the scan lies between the provider observation and
   * `completedAt`, and `completedAt` is not ahead of the server clock — the worker reads them from `SourceUnitOfWork.serverInstant()`.
   */
  append(receipt: InspectionReceiptRecord): Promise<void>;
  getByHash(receiptHash: Sha256Hex): Promise<InspectionReceiptRecord | null>;
  forUpload(uploadId: UploadId): Promise<ReadonlyArray<InspectionReceiptRecord>>;
}

export interface DetectedTableRow extends SourceTableRecord {
  readonly columns: ReadonlyArray<SourceColumnRecord>;
}

export interface SourceFileRepository {
  /**
   * Inserts the admitted file (version 1, admitted at the server's transaction time; the caller publishes source_file.admitted.v1)
   * and its immutable table inventory — the upload must still be VERIFYING, trigger-enforced, and once it left VERIFYING no table
   * or column can be appended (B07-F11).
   */
  admit(file: Omit<SourceFileRecord, "state" | "admitted" | "revokedAt" | "revocationReason" | "version" | "admittedAt">, tables: ReadonlyArray<DetectedTableRow>): Promise<SourceFileRecord>;
  get(fileId: SourceFileId): Promise<SourceFileRecord | null>;
  /** Files admitted from this revision's own uploads. */
  listForRevision(revisionId: RevisionId): Promise<ReadonlyArray<SourceFileRecord>>;
  /** Admitted files of the project that a new revision may reuse (registry edge previously_admitted_inputs_selected). */
  listReusable(projectId: ProjectId): Promise<ReadonlyArray<SourceFileRecord>>;
  tables(fileId: SourceFileId): Promise<ReadonlyArray<SourceTableRecord>>;
  columns(tableId: SourceTableId): Promise<ReadonlyArray<SourceColumnRecord>>;
  /**
   * ADMITTED -> ADMISSION_REVOKED at expectedVersion + 1 and the server's transaction time (the caller publishes
   * source_file.admission_revoked.v1 naming the revisions whose selection or seal names the file). Takes the file's transition
   * lock first; the database refuses INTAKE_EXPIRED for a file any seal included, and RETENTION_EXPIRED while an including
   * revision holds an ACTIVE record ahead (KA072, D-RET-1, D-RET-3).
   */
  revokeAdmission(fileId: SourceFileId, expectedVersion: number, reason: AdmissionRevocationReason): Promise<VersionedWrite<SourceFileRecord>>;
  /** Revisions whose bound selection includes the file (the ids source_file.admission_revoked.v1 carries). */
  selectedBy(fileId: SourceFileId): Promise<ReadonlyArray<RevisionId>>;
  /** Sealed revisions whose manifest includes the file (they retain its accepted generation). */
  sealedBy(fileId: SourceFileId): Promise<ReadonlyArray<RevisionId>>;
}

// --- selection, evaluation, seal -------------------------------------------------------------------------------------------------

export interface SelectionManifestRepository {
  /** Stores a manifest once per (revision, body hash); the same body again returns the stored record with created = false. */
  put(manifest: Omit<SelectionManifestRecord, "body"> & { readonly body: SelectionManifestDocument }): Promise<{ readonly record: SelectionManifestRecord; readonly created: boolean }>;
  get(revisionId: RevisionId, selectionManifestId: SelectionManifestId): Promise<SelectionManifestRecord | null>;
}

export interface SelectionEvaluationRepository {
  append(evaluation: SelectionEvaluationRecord): Promise<void>;
  get(evaluationId: EvaluationId): Promise<SelectionEvaluationRecord | null>;
  latestFor(revisionId: RevisionId, selectionHash: Sha256Hex): Promise<SelectionEvaluationRecord | null>;
}

export interface SelectionBinding {
  readonly selectionManifestId: SelectionManifestId;
  readonly selectionHash: Sha256Hex;
  /** The settled inventory the manifest was made against; must equal the manifest's own inventoryHash (D-SEL-3). */
  readonly inventoryHash: Sha256Hex;
  // selected_at is the server's transaction time (D-CLOCK-1)
}

/**
 * The registry DatasetRevision edges B07 drives, with the facts each target state requires (migration 0011 guard); each records the
 * server's transaction time (D-CLOCK-1). all_uploads_completed is the agency's explicit act (D-INTAKE-1, B07-F1): CMD016 binding a
 * selection on an UPLOADING revision whose uploads are all settled — never a side effect of an observation, an inspection
 * outcome, a cancellation or a deadline.
 */
export type RevisionTransition =
  | { readonly event: "upload_reserved"; readonly firstUploadId: UploadId }
  | { readonly event: "all_uploads_completed"; readonly selection: SelectionBinding }
  | { readonly event: "previously_admitted_inputs_selected"; readonly selection: SelectionBinding }
  | { readonly event: "selection_changes"; readonly selection: SelectionBinding }
  /** A new selection bound while INSPECTING: no state change, version + 1 (dataset_revision.selection_changed.v1). */
  | { readonly event: "selection_rebound"; readonly selection: SelectionBinding }
  | { readonly event: "all_selected_inputs_admitted"; readonly evaluationId: EvaluationId; readonly evaluationHash: Sha256Hex; readonly populations: SourcePopulations }
  | { readonly event: "fatal_input_rejection"; readonly reason: string }
  | { readonly event: "seal_command"; readonly manifestHash: Sha256Hex; readonly projectionHash: Sha256Hex; readonly sealedFileCount: number; readonly sealedBytes: number }
  | { readonly event: "new_revision_explicitly_supersedes"; readonly successorRevisionId: RevisionId }
  | { readonly event: "cancel_revision"; readonly reason: string; readonly successorRevisionId?: RevisionId }
  /**
   * SEALED -> EXPIRED once no governing record is ACTIVE ahead of the server clock; REJECTED -> EXPIRED once every intake window
   * closed. A revision's terminal facts are set once (KA004): `reason` is recorded only by an expiry of a revision that has no
   * terminal reason yet (SEALED -> EXPIRED); from REJECTED the rejection's reason stays and `reason` is not recorded (re-check
   * residual FINAL-N2, decision D-PERS-3).
   */
  | { readonly event: "retention_expires"; readonly reason: string }
  | { readonly event: "managed_cleanup_verified" };

export interface SourceRevisionRepository {
  get(revisionId: RevisionId): Promise<SourceRevisionRecord | null>;
  /**
   * SELECT ... FOR NO KEY UPDATE: the revision row lock every revision transition takes before its transition lock (D-LOCK-1). A
   * command that changes the revision or its intake takes it first (CMD012 on the predecessor, CMD013 before its reservation,
   * CMD015, CMD016, CMD017), and so does every control-plane unit of work that changes an upload, a file or the revision (D-LOCK-2):
   * two first reservations of a DRAFT revision serialize here instead of deadlocking on the transition lock, and a cancellation
   * and an inspection outcome of the same revision are ordered here, never upload-first.
   */
  lock(revisionId: RevisionId): Promise<SourceRevisionRecord | null>;
  /** Inserts the successor DRAFT revision at version 1 with its explicit lineage (CMD012). */
  insertSuccessor(revision: { readonly revisionId: RevisionId; readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly supersedesRevisionId: RevisionId; readonly createdByMembershipId: MembershipId; readonly createdAt: UtcInstant }): Promise<SourceRevisionRecord>;
  /** Applies a listed DatasetRevision edge (or the in-place selection rebind) at expectedVersion + 1. */
  transition(revisionId: RevisionId, expectedVersion: number, change: RevisionTransition): Promise<VersionedWrite<SourceRevisionRecord>>;
  /** The revision's own uploads, files and detected tables in inventory-hash order. */
  inventory(revisionId: RevisionId): Promise<RevisionInventory>;
  /** Control-plane discovery on the server clock: SEALED revisions with no ACTIVE record ahead, and REJECTED ones whose intake windows closed (§12.5). */
  findRetentionDue(limit: number): Promise<ReadonlyArray<{ readonly revisionId: RevisionId; readonly agencyId: AgencyId }>>;
}

export interface SealedFileEntry {
  readonly fileId: SourceFileId;
  readonly ordinal: number;
  readonly disposition: "INCLUDED" | "EXCLUDED";
  readonly exclusionReason?: string;
  readonly providerGeneration: string;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

export interface SealedManifestRepository {
  /**
   * Inserts the sealed manifest (the KAURO_SOURCE_REVISION_V1 preimage and the sealed subject, B07-F12) and its file set in the
   * seal's unit of work, sealed at the server's transaction time. They are the record of that seal (D-SEAL-1): at commit the
   * revision must have entered SEALED in the same unit of work at exactly this instant, otherwise nothing commits (KA072).
   */
  insert(manifest: Omit<SealedManifestRecord, "sealedAt">, files: ReadonlyArray<SealedFileEntry>): Promise<SealedManifestRecord>;
  get(revisionId: RevisionId): Promise<SealedManifestRecord | null>;
  /**
   * The first seal of the bytes a seal would include (D-RET-3, B07-F5): for each file, the earliest seal of any revision that
   * included it, and that revision's REVISION_SEALED anchor. The UNPAID hard deadline is fourteen days from the earliest of them.
   */
  firstSeals(fileIds: ReadonlyArray<SourceFileId>): Promise<ReadonlyArray<{ readonly fileId: SourceFileId; readonly revisionId: RevisionId; readonly sealedAt: UtcInstant; readonly anchorId: RetentionAnchorId }>>;
}

export interface ProjectRevisionPointer {
  /** CMD012: moves projects.current_revision_id at expectedVersion + 1 (project.current_revision_changed.v1). */
  switchCurrentRevision(projectId: ProjectId, expectedVersion: number, revisionId: RevisionId, now: UtcInstant): Promise<VersionedWrite<ProjectRecord>>;
}

/** Authority bound to a sealed revision (CMD012 impact map: "affected approval/payment scope analysis are recorded"). */
export interface RevisionAuthorityInspector {
  /** Plans whose revisionHash is this manifest hash and are not SUPERSEDED or WITHDRAWN, and their live approvals. */
  boundTo(manifestHash: Sha256Hex): Promise<{ readonly planIds: ReadonlyArray<PlanId>; readonly approvalIds: ReadonlyArray<ApprovalId> }>;
}

/** What an anchor records besides its instant; the adapter adds the server instant and its KAURO_RETENTION_ANCHOR_V1 digest. */
export type NewRetentionAnchor = Omit<RetentionAnchorRecord, "occurredAt" | "evidenceHash"> & { readonly sourceEvidenceHash: Sha256Hex | null };

export interface RetentionRepository {
  /**
   * Appends an anchor of this transaction's transition at the server's transaction time, once per (subject, kind); a repeated anchor
   * returns the one already stored (retries never move it). The database binds it to the transition at commit (B07-F3) and admits
   * a request handler's kinds only for the request handlers and the control plane's only for the control plane.
   */
  appendAnchor(anchor: NewRetentionAnchor): Promise<RetentionAnchorRecord>;
  anchorsOf(revisionId: RevisionId): Promise<ReadonlyArray<RetentionAnchorRecord>>;
  /**
   * Inserts the UNPAID record of the seal in its unit of work, at version 1 (the caller publishes retention_record.created.v1):
   * anchored on the first seal of the bytes (firstSeals), hard deadline = that anchor + 1,209,600 s computed in SQL, effective =
   * hard, no soft deadline (D-RET-2, D-RET-3). The request handlers can insert no other class (B07-F3).
   */
  insertUnpaidRecord(record: { readonly retentionId: RetentionId; readonly agencyId: AgencyId; readonly clientId: ClientId; readonly projectId: ProjectId; readonly revisionId: RevisionId; readonly anchorId: RetentionAnchorId; readonly policyVersion: string }): Promise<RetentionRecordRow>;
  recordFor(revisionId: RevisionId, retentionClass: RetentionRecordRow["class"]): Promise<RetentionRecordRow | null>;
  /** Every record governing the revision (the earliest applicable deadline of each governs it, D-RET-2). */
  recordsFor(revisionId: RevisionId): Promise<ReadonlyArray<RetentionRecordRow>>;
  /**
   * ACTIVE -> EXPIRED at expectedVersion + 1 and the server's transaction time (effective_deadline_reached; control plane,
   * retention_record.expired.v1). The database refuses an expiry before the effective deadline; the hard deadline never moves.
   */
  expireRecord(retentionId: RetentionId, expectedVersion: number): Promise<VersionedWrite<RetentionRecordRow>>;
  /** Control-plane discovery: ACTIVE records whose effective deadline has passed on the server clock. */
  findDue(limit: number): Promise<ReadonlyArray<{ readonly retentionId: RetentionId; readonly agencyId: AgencyId; readonly revisionId?: RevisionId }>>;
}

// --- read ports the source lifecycle offers to the commercial packages (B09 payments, B10 quotes) ----------------------------------
// Ports, not table references (design §17 "Integration obligations"): the commercial packages never read B07 tables; B07-PERSISTENCE
// implements these over its own tables, and the integrator binds them where B09/B10 consume them.

/**
 * The availability of a sealed source (09 "Quotes, reuploads and retention": a quote displays dataAvailableUntil and checkout
 * rechecks it; "If sources have been deleted, the user cannot pay the old executable subject"). B10 issues a quote's
 * sourceAvailableUntil from it (it may be no later than availableUntil); B09's checkout, capture and authorization issuance
 * re-read it after the revision's shared transition lock (B06 D-TX-2), so a concurrent retention_expires is ordered before or after.
 */
export interface SourceAvailabilityReader {
  /** null when the revision is not visible; availableUntil is null when the revision is no longer SEALED (nothing is available). */
  availabilityOf(revisionId: RevisionId): Promise<{ readonly revisionId: RevisionId; readonly state: SourceRevisionRecord["state"]; readonly manifestHash: Sha256Hex | null; readonly availableUntil: UtcInstant | null; readonly retentionId: RetentionId | null } | null>;
}

/**
 * The explicit lineage of a project's revisions (CMD012: "predecessor belongs to it and replacement allowance is evaluated
 * separately"). The allowance itself — policy pricing.customerPreExecutionSourceReplacementsIncluded = 1 — is the commercial
 * package's to count against the quote (open question Q-B07-17): it reads the replacements of the quoted revision here.
 */
export interface RevisionLineageReader {
  /** The successors created after `revisionId` in this project, oldest first, with how each replaced its predecessor. */
  replacementsSince(revisionId: RevisionId): Promise<ReadonlyArray<{ readonly revisionId: RevisionId; readonly supersedesRevisionId: RevisionId; readonly predecessorOutcome: "SUPERSEDED" | "CANCELLED" | "UNCHANGED"; readonly createdAt: UtcInstant }>>;
}

/** The two-phase command journal operations (D-RUN-2) over the B06 command_journal table. */
export interface PendingOperationJournal {
  /** Links a RESERVED entry to the durable business object its first phase created (10: records are linked to business objects). */
  attach(entryId: JournalEntryId, resourceKind: string, resourceId: Id): Promise<void>;
}

export interface SourceStore {
  readonly uploads: UploadSessionRepository;
  readonly sessionSecrets: SessionSecretRepository;
  readonly objects: StoredObjectRepository;
  readonly inspections: InspectionReceiptRepository;
  readonly files: SourceFileRepository;
  readonly selections: SelectionManifestRepository;
  readonly evaluations: SelectionEvaluationRepository;
  readonly revisions: SourceRevisionRepository;
  readonly seals: SealedManifestRepository;
  readonly projects: ProjectRevisionPointer;
  readonly authority: RevisionAuthorityInspector;
  readonly retention: RetentionRepository;
  readonly operations: PendingOperationJournal;
  readonly availability: SourceAvailabilityReader;
  readonly lineage: RevisionLineageReader;
}

/** The B06 unit of work plus the source-lifecycle repositories on the same connection and context. */
export interface SourceUnitOfWork extends UnitOfWork {
  readonly sources: SourceStore;
  /**
   * The database's transaction time, kauro.server_now(), as an exact ISO-8601 instant with microseconds (D-CLOCK-1): the instant
   * every B07 write of this unit of work records, read when a digest must cover it (an anchor's evidence hash).
   */
  serverInstant(): Promise<string>;
}

export interface SourceUnitOfWorkFactory extends UnitOfWorkFactory {
  /** Same contract as `run` (one transaction, bound context, commit or rollback), with the source store available. */
  runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
