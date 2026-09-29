/**
 * Safe DTO views of the source lifecycle (B07; 10 "Upload and target routes": POST uploads returns a narrowly scoped provider
 * session through the protected response only; GET returns safe progress without exposing the session URI to unrelated readers;
 * GET inspection lists files, detected worksheets, parser choices and structured problems; 10 "Responses and safe errors":
 * never a bucket name, a session URI or a raw cell value; reference/FIELD_CONTRACTS "Internal records are not automatically safe
 * browser DTOs"; UI14 "Separate upload progress, provider observation, scanner coverage, parser state and accepted bytes"; UI15;
 * UI16 "Present selected files/tables, billable units, edges, parser settings, exclusions and retention").
 *
 * These are the TypeScript shapes of the closed response schemas of sources/response-views.ts (SOURCE_VIEW_DEFINITIONS, derived
 * from the registry bundle where a contract exists); a test keeps the two member for member. No view carries an object name, a
 * provider location, a generation string, a provider session reference or a vault key; ProtectedSessionView alone carries the
 * resumable session URL, to its requester only. Display filenames, worksheet names, header labels and preview cells appear only in
 * views the tenant reads (never in events or logs), always as untrusted display text.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { DeclaredFormat, DetectedFormat, FormulaCacheState, ProviderCancellationState, RejectionClass, ScanState, SourcePopulations, StructureStatus, TableVisibility, UploadState } from "@kauro/domain";
import type { SourceResourceAction } from "./response-views.js";

/** Why a revision cannot move forward right now (read-model facts, recomputed at read time, never stored as a flag). */
export const SOURCE_BLOCKERS = [
  "AGENCY_NOT_ACTIVE",
  "PROJECT_NOT_OPEN",
  "CAPABILITY_RESTRICTED",
  "NO_UPLOADS",
  "UPLOADS_IN_PROGRESS",
  "INSPECTION_PENDING",
  "INPUT_REJECTED_NOT_EXCLUDED",
  "SELECTION_MISSING",
  "SELECTION_STALE",
  "EVALUATION_PENDING",
  "EVALUATION_FAILED",
  "INPUT_ADMISSION_REVOKED",
  "INTAKE_DEADLINE_PASSED",
] as const;
export type SourceBlocker = (typeof SOURCE_BLOCKERS)[number];

/** The inspection outcome of one upload: separate results, never one generic safe flag (09 "Completion and inspection"). */
export interface UploadInspectionView {
  readonly structureStatus: StructureStatus;
  readonly scanState: ScanState;
  readonly semanticStatus: "SEMANTIC_NOT_YET_PROFILED";
  readonly detectedFormat: DetectedFormat;
  readonly claimConsistent: boolean;
  readonly scanCoverage: { readonly expectedParts: number; readonly scannedParts: number; readonly expectedBytes: number; readonly scannedBytes: number };
  readonly problems: ReadonlyArray<string>;
  readonly rejectionClass?: RejectionClass;
}

export interface UploadView {
  readonly uploadId: string;
  readonly revisionId: string;
  readonly version: number;
  readonly state: UploadState;
  readonly reservedBytes: number;
  /** The application acceptance deadline (09: twenty-four hours from initiation; polling never extends it). */
  readonly applicationExpiresAt: UtcInstant;
  readonly providerCancellationState: ProviderCancellationState;
  readonly inspectionReceiptHash?: string;
  readonly agencyId: string;
  readonly projectId: string;
  /** Untrusted display filename (escaped by the UI; never a storage path). */
  readonly displayName: string;
  readonly declaredFormat: DeclaredFormat;
  /** What the provider actually holds once observed (UI14 "provider observation"). */
  readonly observation?: { readonly bytes: number; readonly observedAt: UtcInstant };
  readonly inspection?: UploadInspectionView;
  readonly fileId?: string;
  readonly terminalReason?: string;
  readonly requestedByMembershipId: string;
  readonly createdAt: UtcInstant;
  readonly permittedActions: ReadonlyArray<SourceResourceAction>;
}

export interface UploadPage {
  readonly items: ReadonlyArray<UploadView>;
  readonly nextCursor?: string;
}

/**
 * The provider session, delivered only in the protected response of CMD013 (its replay and the session read) to the requester.
 * delivery PROTECTED_RESPONSE carries the session members; UNAVAILABLE carries the reason only (the producer guarantees it; the
 * closed schema has no conditional keywords).
 */
export interface ProtectedSessionView {
  readonly delivery: "PROTECTED_RESPONSE" | "UNAVAILABLE";
  /** The resumable upload URL: a bearer credential; never journaled, logged, cached or shown to another reader. */
  readonly uploadUrl?: string;
  readonly method?: "PUT";
  readonly chunkMultipleBytes?: number;
  readonly applicationExpiresAt?: UtcInstant;
  readonly unavailableReason?: "SESSION_NOT_ACTIVE" | "NOT_REQUESTER" | "SESSION_PENDING";
}

/**
 * The journaled form of the session member (never on the wire): the command journal stores this placeholder, never the bearer
 * value (09: the session reference is stored encrypted in the temporary control record only); the transport replaces it by a
 * ProtectedSessionView for the requester (D-SESSION-2).
 */
export interface JournaledSessionPlaceholder {
  readonly delivery: "PROTECTED_RESPONSE";
  /** The sealed secret it stands for: UploadSession.providerSessionSecretRef, the upload id (records.ts), never the bearer value. */
  readonly sessionRef: string;
  /** The chunk multiple the provider named when it created the session (not a secret): the hydrated view repeats it. */
  readonly chunkMultipleBytes?: number;
}

export interface RevisionQuotaView {
  readonly reservedBytes: number;
  readonly fileCount: number;
  readonly revisionBytesLimit: number;
  readonly revisionFileLimit: number;
  readonly fileBytesLimit: number;
  readonly agencyActiveSessions: number;
  readonly agencySessionLimit: number;
}

/** B06's RevisionSummary (revision id, state, version). */
export interface RevisionSummaryView {
  readonly revisionId: string;
  readonly version: number;
  readonly state: string;
}

export interface RetentionView {
  readonly retentionId: string;
  readonly class: string;
  readonly anchorEvidenceHash: string;
  readonly softDeadline?: UtcInstant;
  readonly hardDeadline: UtcInstant;
  readonly effectiveDeadline: UtcInstant;
  readonly policyVersion: string;
  readonly providerResiduals: ReadonlyArray<string>;
  readonly state: string;
}

export interface SourceRevisionView {
  readonly revisionId: string;
  readonly version: number;
  readonly state: string;
  readonly sealedAt?: UtcInstant;
  readonly supersedesRevisionId?: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly supersededByRevisionId?: string;
  readonly selection?: { readonly selectionManifestId: string; readonly selectionHash: string; readonly inventoryHash: string; readonly selectedAt: UtcInstant };
  readonly evaluationHash?: string;
  /** The frozen populations once evaluated (READY_TO_SEAL) and sealed. */
  readonly populations?: SourcePopulations;
  readonly seal?: { readonly manifestHash: string; readonly projectionHash: string; readonly fileCount: number; readonly bytes: number };
  readonly retention?: ReadonlyArray<RetentionView>;
  /** 09 "Notifications and customer action": dataAvailableUntil is shown on every source screen once a record governs it. */
  readonly dataAvailableUntil?: UtcInstant;
  readonly terminalReason?: string;
  readonly blockers: ReadonlyArray<SourceBlocker>;
  readonly createdAt: UtcInstant;
  readonly permittedActions: ReadonlyArray<SourceResourceAction>;
}

export interface InspectionColumnView {
  readonly ordinal: number;
  readonly label?: string;
  readonly labelState: "PRESENT" | "EMPTY" | "DUPLICATE_LABEL" | "DISPLAY_TRUNCATED" | "UNDECODABLE" | "NO_HEADER";
}

export interface InspectionTableView {
  readonly tableId: string;
  readonly ordinal: number;
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  readonly name?: string;
  readonly visibility: TableVisibility;
  readonly columnCount: number;
  readonly rowEstimate?: number;
  readonly hasFormulas: boolean;
  readonly formulaCache: FormulaCacheState;
  readonly mergedCellCount: number;
  readonly hiddenRowCount: number;
  readonly hiddenColumnCount: number;
  readonly issues: ReadonlyArray<string>;
  readonly structureHash: string;
  readonly columns: ReadonlyArray<InspectionColumnView>;
}

export interface InspectionFileView {
  readonly fileId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly format: DeclaredFormat;
  readonly scanState: ScanState;
  readonly parserProfileHash: string;
  readonly admitted: boolean;
  readonly origin: "THIS_REVISION" | "REUSABLE";
  readonly uploadId: string;
  readonly tables: ReadonlyArray<InspectionTableView>;
}

/** GET /api/v1/revisions/{revisionId}/inspection (10): the facts a selection is made against, with their inventory hash. */
export interface InspectionView {
  readonly revision: SourceRevisionView;
  readonly inventoryHash: string;
  readonly uploads: ReadonlyArray<UploadView>;
  readonly files: ReadonlyArray<InspectionFileView>;
  /** The current selection as bound (choices only; the manifest document is its own resource). */
  readonly selection?: {
    readonly selectionManifestId: string;
    readonly selectionHash: string;
    readonly tables: ReadonlyArray<{ readonly tableId: string; readonly disposition: "INCLUDE" | "EXCLUDE"; readonly exclusionReason?: string }>;
  };
  readonly evaluation?: {
    readonly evaluationHash: string;
    readonly result: "COMPLETE" | "ADMISSION_FAILED" | "ERROR";
    readonly populations?: SourcePopulations;
    readonly failures: ReadonlyArray<{ readonly code: string; readonly tableId?: string }>;
  };
}

/** The impact map of CMD012 (SEALED -> SUPERSEDED guard: "affected approval/payment scope analysis are recorded"). */
export interface RevisionImpactView {
  readonly planIds: ReadonlyArray<string>;
  readonly approvalIds: ReadonlyArray<string>;
  readonly commercialAuthorizationIds: ReadonlyArray<string>;
}

export interface ProjectRevisionPointerView {
  readonly projectId: string;
  readonly version: number;
  readonly currentRevisionId: string;
}

/** A bounded preview sample (10 "A preview endpoint returns a bounded authorized sample"; D-SAPI-7). */
export interface TablePreviewView {
  readonly tableId: string;
  readonly fileId: string;
  readonly columns: ReadonlyArray<InspectionColumnView>;
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
  readonly truncated: boolean;
}

export interface SelectionManifestView {
  readonly selectionManifestId: string;
  readonly revisionId: string;
  readonly bodyHash: string;
  readonly createdByMembershipId: string;
  readonly createdAt: UtcInstant;
  readonly document: unknown;
}
