/**
 * Source-lifecycle repository ports (B07; tables of migrations 0008..0011). They extend the B06 foundation without forking it:
 * every repository lives inside a unit of work and its bound context (RLS decides visibility; a write outside the context fails
 * WITH CHECK), versioned writes are compare-and-swap returning VersionedWrite, a new aggregate version is published by the caller
 * through the same EventPublisher, and the command journal is the same table. Implementations belong to @kauro/persistence
 * (mandate B07-PERSISTENCE, docs/design/B07-upload-source-lifecycle.md §13).
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
 * trigger), so every writer of a revision's intake is ordered on that row.
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ProjectRecord } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, JournalEntryId, MembershipId, PlanId, ProjectId, RevisionId, UserId } from "../model/ids.js";
import type { RevisionInventory } from "../model/source/digests.js";
import type { EvaluationId, RetentionId, SelectionManifestId, SourceFileId, SourceTableId, StoredObjectId, UploadId } from "../model/source/ids.js";
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
  readonly applicationExpiresAt: UtcInstant;
  readonly createdAt: UtcInstant;
}

/** The listed UploadSession edges (platform machine, D-UP-1) with the facts each one records. */
export type UploadTransition =
  | { readonly event: "session_issued"; readonly sessionAttempt: number; readonly issuedAt: UtcInstant; readonly providerSessionDigest: Sha256Hex; readonly providerSessionExpiresAt: UtcInstant }
  | { readonly event: "completion_reported"; readonly reportedAt: UtcInstant; readonly claimDigest: Sha256Hex; readonly claim: CompletionClaim }
  | { readonly event: "completion_not_observed" }
  | { readonly event: "inspection_admitted"; readonly admittedAt: UtcInstant; readonly fileId: SourceFileId; readonly receiptHash: Sha256Hex; readonly inspectionFence: number }
  | { readonly event: "inspection_rejected"; readonly rejectedAt: UtcInstant; readonly receiptHash: Sha256Hex; readonly rejectionClass: RejectionClass; readonly inspectionFence: number }
  | { readonly event: "cancel_upload"; readonly cancelledAt: UtcInstant; readonly byMembershipId: MembershipId; readonly reason: string; readonly providerCancellation: "NOT_REQUESTED" | "REQUESTED" }
  | { readonly event: "reservation_expired"; readonly expiredAt: UtcInstant; readonly reason: string; readonly providerCancellation: "NOT_REQUESTED" | "REQUESTED" }
  | { readonly event: "intake_deadline_reached"; readonly expiredAt: UtcInstant; readonly reason: string };

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
  transition(uploadId: UploadId, expectedVersion: number, change: UploadTransition, now: UtcInstant): Promise<VersionedWrite<UploadSessionRecord>>;
  /** Advances the session-issue fence of a RESERVED, unexpired upload (no version bump); null when it no longer qualifies. */
  claimSessionAttempt(uploadId: UploadId, now: UtcInstant): Promise<number | null>;
  /** Advances the inspection fence of a VERIFYING upload (no version bump); null when it is no longer VERIFYING. */
  claimInspectionAttempt(uploadId: UploadId): Promise<number | null>;
  /** Records what the provider holds for a VERIFYING upload (set once) at expectedVersion + 1 (upload_session.completion_observed.v1). */
  recordObservation(uploadId: UploadId, expectedVersion: number, observation: { readonly generation: string; readonly bytes: number; readonly observedAt: UtcInstant }): Promise<VersionedWrite<UploadSessionRecord>>;
  /** Records the provider cancellation result at expectedVersion + 1 (upload_session.provider_cancellation_recorded.v1). */
  recordProviderCancellation(uploadId: UploadId, expectedVersion: number, result: Exclude<ProviderCancellationState, "NOT_REQUESTED" | "REQUESTED">, at: UtcInstant): Promise<VersionedWrite<UploadSessionRecord>>;
  listByRevision(revisionId: RevisionId, page: SourcePage<{ readonly createdAt: UtcInstant; readonly uploadId: UploadId }>): Promise<ReadonlyArray<UploadSessionRecord>>;
  /** Uploads of the revision in the given states (bounded by the 50-file envelope). */
  inStates(revisionId: RevisionId, states: ReadonlyArray<UploadState>): Promise<ReadonlyArray<UploadSessionRecord>>;
  quota(revisionId: RevisionId): Promise<RevisionQuota>;
  capacity(agencyId: AgencyId): Promise<UploadCapacity>;
  /** Control-plane discovery (unbound SYSTEM context, no customer text): live or unsealed-admitted uploads past their deadline. */
  findDeadlinePassed(now: UtcInstant, limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId; readonly state: UploadState }>>;
  /** Control-plane discovery: provider cancellations REQUESTED or UNCERTAIN whose provider horizon has not passed. */
  findProviderReconciliation(now: UtcInstant, limit: number): Promise<ReadonlyArray<{ readonly uploadId: UploadId; readonly agencyId: AgencyId }>>;
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
  /** -> DELETION_REQUESTED for each object (a VERIFIED object retained by a sealed revision is refused, design §7.4). */
  requestDeletion(objectIds: ReadonlyArray<StoredObjectId>, reason: string, at: UtcInstant): Promise<number>;
  /**
   * Records the provider result: DELETED / ALREADY_ABSENT -> DELETED with the provider residual (D-OBJ-2: the adapter writes
   * basis LOCATION_POLICY and the residual the location's latest read-back at or before `at` implies — the database refuses any
   * other value and refuses a deletion at a location never read back); PRECONDITION_FAILED / PROVIDER_ERROR -> DELETION_FAILED.
   */
  recordDeletion(objectId: StoredObjectId, result: DeletionResult, at: UtcInstant): Promise<StoredObjectRecord>;
  /**
   * Records a generation that provider inventory found already soft-deleted (09: record the actual expiry rather than claiming it
   * vanished): registered, requested and DELETED (ALREADY_ABSENT) in one unit of work, with the expiry the provider reported
   * (basis PROVIDER_REPORTED).
   */
  recordProviderResidual(object: NewStoredObject & { readonly generation: string; readonly softDeletedAt: UtcInstant; readonly providerExpiresAt: UtcInstant }): Promise<StoredObjectRecord>;
  retryDeletion(objectId: StoredObjectId, at: UtcInstant): Promise<StoredObjectRecord>;
  /** Appends a retention read-back of a location (control plane; append-only). */
  recordLocationPolicy(observation: StorageLocationPolicyRecord): Promise<void>;
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
  /** Appends the receipt of the current attempt of a VERIFYING upload (a stale attempt is refused by the database, KA071). */
  append(receipt: InspectionReceiptRecord): Promise<void>;
  getByHash(receiptHash: Sha256Hex): Promise<InspectionReceiptRecord | null>;
  forUpload(uploadId: UploadId): Promise<ReadonlyArray<InspectionReceiptRecord>>;
}

export interface DetectedTableRow extends SourceTableRecord {
  readonly columns: ReadonlyArray<SourceColumnRecord>;
}

export interface SourceFileRepository {
  /** Inserts the admitted file and its immutable table inventory (the upload must still be VERIFYING, trigger-enforced). */
  admit(file: Omit<SourceFileRecord, "state" | "admitted" | "revokedAt" | "revocationReason">, tables: ReadonlyArray<DetectedTableRow>): Promise<SourceFileRecord>;
  get(fileId: SourceFileId): Promise<SourceFileRecord | null>;
  /** Files admitted from this revision's own uploads. */
  listForRevision(revisionId: RevisionId): Promise<ReadonlyArray<SourceFileRecord>>;
  /** Admitted files of the project that a new revision may reuse (registry edge previously_admitted_inputs_selected). */
  listReusable(projectId: ProjectId): Promise<ReadonlyArray<SourceFileRecord>>;
  tables(fileId: SourceFileId): Promise<ReadonlyArray<SourceTableRecord>>;
  columns(tableId: SourceTableId): Promise<ReadonlyArray<SourceColumnRecord>>;
  /**
   * ADMITTED -> ADMISSION_REVOKED (the accepted generation was lost or its unsealed intake expired). Takes the file's transition
   * lock first; an INTAKE_EXPIRED revocation of a file a SEALED or SUPERSEDED revision includes is refused (KA072, D-RET-1).
   */
  revokeAdmission(fileId: SourceFileId, reason: AdmissionRevocationReason, at: UtcInstant): Promise<SourceFileRecord>;
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
  readonly selectedAt: UtcInstant;
}

/** The registry DatasetRevision edges B07 drives, with the facts each target state requires (migration 0010 guard). */
export type RevisionTransition =
  | { readonly event: "upload_reserved"; readonly firstUploadId: UploadId }
  | { readonly event: "all_uploads_completed" }
  | { readonly event: "previously_admitted_inputs_selected"; readonly selection: SelectionBinding }
  | { readonly event: "selection_changes"; readonly selection: SelectionBinding }
  /** A new selection bound while INSPECTING: no state change, version + 1 (dataset_revision.selection_changed.v1). */
  | { readonly event: "selection_rebound"; readonly selection: SelectionBinding }
  | { readonly event: "all_selected_inputs_admitted"; readonly evaluationId: EvaluationId; readonly evaluationHash: Sha256Hex; readonly populations: SourcePopulations }
  | { readonly event: "fatal_input_rejection"; readonly rejectedAt: UtcInstant; readonly reason: string }
  | { readonly event: "seal_command"; readonly manifestHash: Sha256Hex; readonly projectionHash: Sha256Hex; readonly sealedAt: UtcInstant; readonly sealedFileCount: number; readonly sealedBytes: number }
  | { readonly event: "new_revision_explicitly_supersedes"; readonly successorRevisionId: RevisionId; readonly supersededAt: UtcInstant }
  | { readonly event: "cancel_revision"; readonly cancelledAt: UtcInstant; readonly reason: string; readonly successorRevisionId?: RevisionId }
  | { readonly event: "retention_expires"; readonly expiredAt: UtcInstant; readonly reason: string }
  | { readonly event: "managed_cleanup_verified"; readonly deletedAt: UtcInstant };

export interface SourceRevisionRepository {
  get(revisionId: RevisionId): Promise<SourceRevisionRecord | null>;
  /**
   * SELECT ... FOR NO KEY UPDATE: the revision row lock every revision transition takes before its transition lock (D-LOCK-1). A
   * command that changes the revision or its intake takes it first (CMD012 on the predecessor, CMD013 before its reservation,
   * CMD015 when it may complete the upload set, CMD016, CMD017), so two first reservations of a DRAFT revision serialize here
   * instead of deadlocking on the transition lock.
   */
  lock(revisionId: RevisionId): Promise<SourceRevisionRecord | null>;
  /** Inserts the successor DRAFT revision at version 1 with its explicit lineage (CMD012). */
  insertSuccessor(revision: { readonly revisionId: RevisionId; readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly supersedesRevisionId: RevisionId; readonly createdByMembershipId: MembershipId; readonly createdAt: UtcInstant }): Promise<SourceRevisionRecord>;
  /** Applies a listed DatasetRevision edge (or the in-place selection rebind) at expectedVersion + 1. */
  transition(revisionId: RevisionId, expectedVersion: number, change: RevisionTransition, now: UtcInstant): Promise<VersionedWrite<SourceRevisionRecord>>;
  /** The revision's own uploads, files and detected tables in inventory-hash order. */
  inventory(revisionId: RevisionId): Promise<RevisionInventory>;
  /** Control-plane discovery: SEALED revisions with no ACTIVE record ahead, and REJECTED ones whose intake windows closed (§7.5). */
  findRetentionDue(now: UtcInstant, limit: number): Promise<ReadonlyArray<{ readonly revisionId: RevisionId; readonly agencyId: AgencyId }>>;
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
  /** Inserts the sealed manifest and its file set in the seal's unit of work (checked against the revision at commit). */
  insert(manifest: SealedManifestRecord, files: ReadonlyArray<SealedFileEntry>): Promise<void>;
  get(revisionId: RevisionId): Promise<SealedManifestRecord | null>;
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

export interface RetentionRepository {
  /** Appends an anchor once per (subject, kind); a repeated anchor returns the one already stored (retries never move it). */
  appendAnchor(anchor: RetentionAnchorRecord): Promise<RetentionAnchorRecord>;
  anchorsOf(revisionId: RevisionId): Promise<ReadonlyArray<RetentionAnchorRecord>>;
  /** Inserts an ACTIVE record at version 1 (the caller publishes retention_record.created.v1). */
  insertRecord(record: RetentionRecordRow): Promise<RetentionRecordRow>;
  recordFor(revisionId: RevisionId, retentionClass: RetentionRecordRow["class"]): Promise<RetentionRecordRow | null>;
  /** Every record governing the revision (the earliest applicable deadline of each governs it, D-RET-2). */
  recordsFor(revisionId: RevisionId): Promise<ReadonlyArray<RetentionRecordRow>>;
  /**
   * ACTIVE -> EXPIRED at expectedVersion + 1 (effective_deadline_reached; control plane, retention_record.expired.v1). The database
   * refuses an expiry before the effective deadline; the hard deadline never moves.
   */
  expireRecord(retentionId: RetentionId, expectedVersion: number, expiredAt: UtcInstant): Promise<VersionedWrite<RetentionRecordRow>>;
  /** Control-plane discovery: ACTIVE records whose effective deadline has passed. */
  findDue(now: UtcInstant, limit: number): Promise<ReadonlyArray<{ readonly retentionId: RetentionId; readonly agencyId: AgencyId; readonly revisionId?: RevisionId }>>;
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
}

/** The B06 unit of work plus the source-lifecycle repositories on the same connection and context. */
export interface SourceUnitOfWork extends UnitOfWork {
  readonly sources: SourceStore;
}

export interface SourceUnitOfWorkFactory extends UnitOfWorkFactory {
  /** Same contract as `run` (one transaction, bound context, commit or rollback), with the source store available. */
  runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
