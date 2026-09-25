/**
 * Records of the source lifecycle as the domain sees them (B07; tables of migrations 0008..0011). A record is the registry
 * contract (UploadSession, FileManifest, DatasetRevision, RetentionRecord) plus the columns the platform needs for tenancy,
 * concurrency, lineage and evidence. Wire DTOs select from these (application views), never the reverse; customer text
 * (display names, worksheet names, header labels) appears only in the records that the tenant reads, never in events.
 */
import type { FileManifest, RetentionRecord, Sha256Hex, UploadSession, UtcInstant } from "@kauro/contracts";
import type { DatasetRevisionRecord } from "../aggregates.js";
import type { AgencyId, ClientId, MembershipId, ProjectId, RevisionId, UserId } from "../ids.js";
import type { PartCoverage, ScanPartKind } from "./scan-coverage.js";
import type { SelectionManifestDocument } from "./selection.js";
import type {
  EvaluationId,
  InspectionReceiptId,
  ProjectionId,
  RetentionAnchorId,
  RetentionId,
  SelectionManifestId,
  SourceFileId,
  SourceTableId,
  StoredObjectId,
  UploadId,
} from "./ids.js";

// --- upload sessions -------------------------------------------------------------------------------------------------------

export type UploadState = UploadSession["state"];
export type ProviderCancellationState = UploadSession["providerCancellationState"];
export type DeclaredFormat = FileManifest["format"];

/** The completion claim a browser forwarded (CMD014 providerCompletionRef), parsed by the storage port; never authority. */
export interface CompletionClaim {
  readonly generation?: string;
  readonly bytes?: number;
  /** Base64 CRC32C / MD5 as the provider reports them. */
  readonly crc32c?: string;
  readonly md5?: string;
}

/** UploadSession + tenancy, requester, fences, claim, observation and lifecycle stamps (table kauro.upload_sessions). */
export interface UploadSessionRecord extends Omit<UploadSession, "providerSessionSecretRef" | "observedGeneration" | "inspectionReceiptHash"> {
  readonly uploadId: UploadId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  /** Untrusted display filename; tenant reads only; never in an event, a log or a storage path. */
  readonly displayName: string;
  readonly declaredFormat: DeclaredFormat;
  readonly quarantineObjectId: StoredObjectId;
  readonly requestedByMembershipId: MembershipId;
  readonly requestedByUserId: UserId;
  /** The encrypted provider session reference is keyed by the upload id (UploadSession.providerSessionSecretRef = uploadId). */
  readonly sessionAttempt: number;
  readonly sessionIssuedAt?: UtcInstant;
  readonly providerSessionDigest?: Sha256Hex;
  readonly providerSessionExpiresAt?: UtcInstant;
  readonly providerCancellationAt?: UtcInstant;
  readonly completionReportedAt?: UtcInstant;
  readonly completionClaimDigest?: Sha256Hex;
  readonly claim?: CompletionClaim;
  readonly completionObservedAt?: UtcInstant;
  readonly observedGeneration?: string;
  readonly observedBytes?: number;
  readonly inspectionFence: number;
  readonly inspectionReceiptHash?: Sha256Hex;
  readonly fileId?: SourceFileId;
  readonly terminalReason?: string;
  readonly cancelledByMembershipId?: MembershipId;
  readonly admittedAt?: UtcInstant;
  readonly rejectedAt?: UtcInstant;
  readonly cancelledAt?: UtcInstant;
  readonly expiredAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** The sealed provider session reference (table kauro.upload_session_secrets); plaintext exists only inside the vault port. */
export interface SealedSessionSecret {
  readonly uploadId: UploadId;
  readonly agencyId: AgencyId;
  readonly requestedByUserId: UserId;
  readonly sessionAttempt: number;
  readonly keyRef: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly createdAt: UtcInstant;
}

/** Quota ledgers (tables kauro.revision_quota and kauro.upload_capacity), read for messages and views; the database decides. */
export interface RevisionQuota {
  readonly revisionId: RevisionId;
  readonly reservedBytes: number;
  readonly fileCount: number;
}

export interface UploadCapacity {
  readonly agencyId: AgencyId;
  readonly activeSessions: number;
  readonly sessionLimit: number;
}

// --- object registry ----------------------------------------------------------------------------------------------------------

export type StorageZone = "QUARANTINE" | "ACCEPTED" | "PROFILE" | "MINIMIZED" | "STAGING" | "DELIVERY" | "IMPORT_RECEIPT" | "LEGAL_FINANCE" | "SECURITY";
export type DataClass = "RAW" | "DERIVED" | "RESIDUAL";
export type StoredObjectState = "INTENDED" | "PRESENT" | "VERIFIED" | "DELETION_REQUESTED" | "DELETED" | "DELETION_FAILED";
export type DeletionResult = "DELETED" | "ALREADY_ABSENT" | "PRECONDITION_FAILED" | "PROVIDER_ERROR";

/** One registered object generation or intent (table kauro.stored_objects; 09 "Storage zones and object registry"). */
export interface StoredObjectRecord {
  readonly objectId: StoredObjectId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId?: RevisionId;
  readonly uploadId?: UploadId;
  readonly fileId?: SourceFileId;
  readonly zone: StorageZone;
  readonly dataClass: DataClass;
  /** Provider token (e.g. gcs, contract-fake-storage) and the registry key of its location; never a bucket name or URI. */
  readonly provider: string;
  readonly locationRef: string;
  /** Opaque name: zone and canonical ids only (09: never an original filename). */
  readonly objectName: string;
  readonly generation?: string;
  readonly bytes?: number;
  readonly sha256?: Sha256Hex;
  readonly state: StoredObjectState;
  readonly late: boolean;
  readonly createdBy: { readonly kind: "MEMBERSHIP"; readonly membershipId: MembershipId } | { readonly kind: "SERVICE"; readonly serviceId: string };
  readonly observedAt?: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly deletionRequestedAt?: UtcInstant;
  readonly deletionReason?: string;
  readonly deletedAt?: UtcInstant;
  readonly deletionResult?: DeletionResult;
  readonly deletionAttempts: number;
  readonly createdAt: UtcInstant;
}

// --- inspection -----------------------------------------------------------------------------------------------------------

export type ScanState = FileManifest["scanState"];
export type StructureStatus = "STRUCTURE_VALID" | "STRUCTURE_INVALID" | "NOT_EVALUATED";
export type DetectedFormat = DeclaredFormat | "UNSUPPORTED" | "NOT_EVALUATED";

/** 09 "Completion and inspection" failure classes plus the claim, size, emptiness and promotion refusals of this design. */
export type RejectionClass =
  | "UNSUPPORTED_FORMAT"
  | "FORMAT_MISMATCH"
  | "CORRUPT_STRUCTURE"
  | "ACTIVE_CONTENT"
  | "DETECTED_MALWARE"
  | "INCOMPLETE_SCAN"
  | "STALE_SIGNATURES"
  | "RESOURCE_LIMIT"
  | "TRANSIENT_INFRASTRUCTURE"
  | "CANCELLED_AUTHORITY"
  | "CLAIM_MISMATCH"
  | "SIZE_EXCEEDS_RESERVATION"
  | "EMPTY_OBJECT"
  | "PROMOTION_UNVERIFIED";

/** A stable problem code of the inspection (container, archive, XML, encoding, limit), optionally tied to a part digest. */
export interface InspectionProblem {
  readonly code: string;
  readonly partDigest?: Sha256Hex;
}

/** One completed inspection attempt (table kauro.inspection_receipts; UploadSession.inspectionReceiptHash). */
export interface InspectionReceiptRecord {
  readonly receiptId: InspectionReceiptId;
  readonly agencyId: AgencyId;
  readonly uploadId: UploadId;
  readonly revisionId: RevisionId;
  readonly receiptHash: Sha256Hex;
  readonly inspectionFence: number;
  readonly quarantineObjectId: StoredObjectId;
  readonly observedGeneration: string;
  readonly observedBytes: number;
  readonly sha256?: Sha256Hex;
  readonly completionClaimDigest: Sha256Hex;
  readonly claimConsistent: boolean;
  readonly declaredFormat: DeclaredFormat;
  readonly detectedFormat: DetectedFormat;
  readonly structureStatus: StructureStatus;
  readonly scanState: ScanState;
  readonly semanticStatus: "SEMANTIC_NOT_YET_PROFILED";
  readonly scanner?: {
    readonly engine: string;
    readonly engineVersion: string;
    readonly signatureVersion: string;
    readonly signaturesPublishedAt: UtcInstant;
    readonly signatureMaxAgeSeconds: number;
    readonly configHash: Sha256Hex;
    readonly scannedAt: UtcInstant;
  };
  readonly expectedParts: number;
  readonly expectedBytes: number;
  readonly scannedParts: number;
  readonly scannedBytes: number;
  readonly coverage: ReadonlyArray<PartCoverage>;
  readonly problems: ReadonlyArray<InspectionProblem>;
  readonly parserProfileHash?: Sha256Hex;
  readonly inspectorVersion: string;
  readonly outcome: "ADMITTED" | "REJECTED";
  readonly rejectionClass?: RejectionClass;
  readonly accepted?: { readonly objectId: StoredObjectId; readonly generation: string; readonly sha256: Sha256Hex };
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
}

/** FileManifest + tenancy and lineage (table kauro.source_files): one admitted, immutable, provider-observed generation. */
export interface SourceFileRecord extends Omit<FileManifest, "fileId" | "storageRef"> {
  readonly fileId: SourceFileId;
  /** FileManifest.storageRef: the registry object of the accepted generation, never a bucket URI. */
  readonly storageRef: StoredObjectId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly originRevisionId: RevisionId;
  readonly originUploadId: UploadId;
  readonly inspectionReceiptHash: Sha256Hex;
  readonly state: "ADMITTED" | "ADMISSION_REVOKED";
  readonly admittedAt: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly revocationReason?: string;
}

export type TableVisibility = "VISIBLE" | "HIDDEN" | "VERY_HIDDEN";
export type FormulaCacheState = "NOT_APPLICABLE" | "ALL_PRESENT" | "SOME_MISSING" | "ERROR_VALUES" | "EXTERNAL_DEPENDENCY";

/** One detected table of an admitted file (table kauro.source_tables). */
export interface SourceTableRecord {
  readonly tableId: SourceTableId;
  readonly agencyId: AgencyId;
  readonly fileId: SourceFileId;
  readonly ordinal: number;
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  /** Untrusted worksheet name for display (absent when it is not a safe label); tenant reads only. */
  readonly nameDisplay?: string;
  readonly nameDigest: Sha256Hex;
  readonly visibility: TableVisibility;
  readonly columnCount: number;
  readonly rowEstimate?: number;
  readonly hasFormulas: boolean;
  readonly formulaCache: FormulaCacheState;
  readonly mergedCellCount: number;
  readonly hiddenRowCount: number;
  readonly hiddenColumnCount: number;
  readonly issues: ReadonlyArray<string>;
  readonly structureHash: Sha256Hex;
}

/** One positional column of a detected table (table kauro.source_table_columns; SourceField's positional identity). */
export interface SourceColumnRecord {
  readonly tableId: SourceTableId;
  readonly ordinal: number;
  /** Untrusted header label for display (tenant reads only). */
  readonly labelDisplay?: string;
  readonly labelDigest: Sha256Hex;
  readonly labelState: "PRESENT" | "EMPTY" | "DUPLICATE_LABEL" | "DISPLAY_TRUNCATED" | "UNDECODABLE" | "NO_HEADER";
}

// --- selection, evaluation, seal ------------------------------------------------------------------------------------------

export interface SelectionManifestRecord {
  readonly selectionManifestId: SelectionManifestId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly body: SelectionManifestDocument;
  /** KAURO_SOURCE_SELECTION_V1 digest of `body`: the selectionHash CMD017 confirms. */
  readonly bodyHash: Sha256Hex;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

/** RowCounts populations frozen by an evaluation (03 "Count the correct population"; the remaining RowCounts are execution counts). */
export interface SourcePopulations {
  readonly physicalSourceRows: number;
  readonly logicalSourceRecords: number;
  readonly billableSourceUnits: number;
  readonly associationEdges: number;
}

export interface EvaluatedFile {
  readonly fileId: SourceFileId;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly bytes: number;
}

export interface EvaluatedTable {
  readonly tableId: SourceTableId;
  readonly physicalRows: number;
  readonly columnCount: number;
  readonly excludedHiddenRows: number;
  readonly issues: ReadonlyArray<string>;
}

export interface EvaluatedProjection {
  readonly projectionKey: string;
  readonly objectKind: string;
  readonly logicalRecords: number;
  readonly billable: boolean;
}

export interface EvaluationFailure {
  readonly code: string;
  readonly tableId?: SourceTableId;
}

/** One counting pass over one selection (table kauro.selection_evaluations). */
export interface SelectionEvaluationRecord {
  readonly evaluationId: EvaluationId;
  readonly agencyId: AgencyId;
  readonly revisionId: RevisionId;
  readonly selectionManifestId: SelectionManifestId;
  readonly selectionHash: Sha256Hex;
  readonly evaluationHash: Sha256Hex;
  readonly result: "COMPLETE" | "ADMISSION_FAILED" | "ERROR";
  readonly populations?: SourcePopulations;
  readonly fileCount?: number;
  readonly totalBytes?: number;
  readonly files: ReadonlyArray<EvaluatedFile>;
  readonly tables: ReadonlyArray<EvaluatedTable>;
  readonly projections: ReadonlyArray<EvaluatedProjection>;
  readonly failures: ReadonlyArray<EvaluationFailure>;
  readonly pricingDefinition: string;
  readonly evaluatorVersion: string;
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
}

/** DatasetRevisionRecord + the B07 lifecycle columns (migration 0008). */
export interface SourceRevisionRecord extends DatasetRevisionRecord {
  readonly createdByMembershipId?: MembershipId;
  readonly selectionManifestId?: SelectionManifestId;
  readonly selectionHash?: Sha256Hex;
  readonly selectedAt?: UtcInstant;
  readonly evaluationId?: EvaluationId;
  readonly evaluationHash?: Sha256Hex;
  readonly populations?: SourcePopulations;
  readonly sealedFileCount?: number;
  readonly sealedBytes?: number;
  readonly supersededByRevisionId?: RevisionId;
  readonly supersededAt?: UtcInstant;
  readonly cancelledAt?: UtcInstant;
  readonly rejectedAt?: UtcInstant;
  readonly expiredAt?: UtcInstant;
  readonly deletedAt?: UtcInstant;
  readonly terminalReason?: string;
}

/** A sealed projection: the draft declaration with the ProjectionId the seal minted (SourceLocator.projectionId). */
export interface SealedProjection {
  readonly projectionId: ProjectionId;
  readonly projectionKey: string;
  readonly tableId: SourceTableId;
  readonly objectKind: string;
  readonly kind: "ROW" | "REFERENCED_ENTITY";
  readonly fieldOrdinals: ReadonlyArray<number>;
  readonly keyOrdinals?: ReadonlyArray<number>;
  readonly logicalRecords: number;
  readonly billable: boolean;
}

/**
 * The sealed manifest document (table kauro.sealed_manifests.manifest), hashed under KAURO_SOURCE_REVISION_V1
 * (reference/HASHING_AND_ACCOUNTING_RULES: ordered accepted file ids, generations, hashes, lengths, table selection, parser profile
 * and projection; excluded: UI labels, mutable upload states and audit status). The revision id is part of the payload
 * (decision D-HASH-1): identical bytes sealed again in a new revision are a new authority chain with a distinct manifest hash.
 */
export interface SealedManifestDocument {
  readonly canonicalVersion: 1;
  readonly revisionId: RevisionId;
  readonly projectId: ProjectId;
  readonly supersedesRevisionId: RevisionId | null;
  readonly files: ReadonlyArray<{
    readonly fileId: SourceFileId;
    readonly disposition: "INCLUDED" | "EXCLUDED";
    readonly exclusionReason: string | null;
    readonly providerGeneration: string;
    readonly sha256: Sha256Hex;
    readonly bytes: number;
    readonly format: DeclaredFormat;
    readonly parserProfileHash: Sha256Hex;
    readonly inspectionReceiptHash: Sha256Hex;
    readonly tables: ReadonlyArray<{
      readonly tableId: SourceTableId;
      readonly ordinal: number;
      readonly structureHash: Sha256Hex;
      readonly visibility: TableVisibility;
      readonly disposition: "INCLUDED" | "EXCLUDED";
      readonly exclusionReason: string | null;
      /** The selected parser choice as the selection manifest stated it (null for an excluded table). */
      readonly parser: unknown;
      readonly selectedColumns: ReadonlyArray<number> | null;
      readonly physicalRows: number | null;
    }>;
  }>;
  /** Uploads of this revision that inspection rejected: listed with their class, never silently dropped (07). */
  readonly rejectedUploads: ReadonlyArray<{ readonly uploadId: UploadId; readonly rejectionClass: RejectionClass }>;
  readonly projections: ReadonlyArray<SealedProjection>;
  readonly associations: ReadonlyArray<{ readonly associationKey: string; readonly tableId: SourceTableId; readonly fromProjectionId: ProjectionId; readonly toProjectionId: ProjectionId; readonly relationType: string; readonly edges: number }>;
  readonly populations: SourcePopulations;
  readonly selectionHash: Sha256Hex;
  readonly evaluationHash: Sha256Hex;
  readonly projectionHash: Sha256Hex;
  readonly pricingDefinition: string;
  readonly inputEnvelope: { readonly files: number; readonly fileBytes: number; readonly revisionBytes: number };
}

export interface SealedManifestRecord {
  readonly revisionId: RevisionId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly manifestHash: Sha256Hex;
  readonly projectionHash: Sha256Hex;
  readonly selectionHash: Sha256Hex;
  readonly evaluationHash: Sha256Hex;
  readonly manifest: SealedManifestDocument;
  readonly sealedAt: UtcInstant;
}

// --- retention --------------------------------------------------------------------------------------------------------------

export type RetentionAnchorKind = "UPLOAD_INITIATED" | "INPUT_ADMITTED" | "REVISION_SEALED" | "INTAKE_CANCELLED" | "INTAKE_REJECTED" | "INTAKE_EXPIRED";

/** One immutable anchor fact (table kauro.retention_anchors). */
export interface RetentionAnchorRecord {
  readonly anchorId: RetentionAnchorId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly revisionId: RevisionId;
  readonly uploadId?: UploadId;
  readonly kind: RetentionAnchorKind;
  readonly occurredAt: UtcInstant;
  /** KAURO_RETENTION_ANCHOR_V1 digest (RetentionRecord.anchorEvidenceHash). */
  readonly evidenceHash: Sha256Hex;
}

/** RetentionRecord + tenancy, revision, anchor and version (table kauro.retention_records). */
export interface RetentionRecordRow extends Omit<RetentionRecord, "retentionId" | "scope"> {
  readonly retentionId: RetentionId;
  readonly agencyId: AgencyId;
  readonly clientId: ClientId;
  readonly projectId: ProjectId;
  readonly revisionId?: RevisionId;
  readonly anchorId: RetentionAnchorId;
  readonly version: number;
}

/** A part the preflight expects the scanner to cover, as recorded (re-exported for receipts). */
export type ExpectedPartKind = ScanPartKind;
