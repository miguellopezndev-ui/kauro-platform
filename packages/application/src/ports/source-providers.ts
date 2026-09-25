/**
 * Ports of the source lifecycle to what the platform does not own (B07; docs/design/B07-upload-source-lifecycle.md §6).
 *
 * External providers — object storage, the malware scanner, the key service that seals provider session references and the
 * external authority journal that survives a database restore — are reached only through these ports. Until the real integration
 * package (B15) binds provider adapters, tests bind contract-faithful fakes that report `evidenceClass: "SIMULATED"` and are
 * labelled as such in code and evidence (21 "Evidence classes": SIMULATED demonstrates a local contract with fakes; it is never
 * EXECUTED_PROVIDER). A deployment of this edition binds no fake: the edition answers INTEGRITY_FAILURE /
 * SOURCE_SERVICES_UNAVAILABLE until a provider adapter is bound (like B06's I-INT-2).
 *
 * The container inspector and the selection evaluator are not providers: they are the platform's own bounded parsers
 * (@kauro/data-plane, mandate B07-DATA-PLANE) and are always real in tests (S024 is decided by them).
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  CompletionClaim,
  DeclaredFormat,
  EvaluatedFile,
  EvaluatedProjection,
  EvaluatedTable,
  EvaluationFailure,
  ExpectedScanPart,
  FormulaCacheState,
  InspectionProblem,
  RevisionId,
  ScannerReport,
  SelectionManifestDocument,
  SourceFileRecord,
  SourcePopulations,
  SourceTableRecord,
  StorageZone,
  TableVisibility,
  UploadId,
  UserId,
  UnitOfWork,
} from "@kauro/domain";

/** 21 "Evidence classes": what a result produced through this port may claim. */
export type ProviderEvidenceClass = "EXECUTED_PROVIDER" | "SIMULATED";

// --- object storage ------------------------------------------------------------------------------------------------------------

/** A registered storage location: provider token and registry key (never a bucket name or URI in any record or DTO). */
export interface StorageLocation {
  readonly provider: string;
  readonly locationRef: string;
}

export interface ObjectObservation {
  /** The provider's immutable generation of the object (Cloud Storage int64 as a decimal string). */
  readonly generation: string;
  readonly bytes: number;
  /** Provider-computed checksums when the provider reports them (base64); evidence, never a substitute for the server SHA-256. */
  readonly crc32c?: string;
  readonly md5?: string;
  readonly observedAt: UtcInstant;
}

/** A resumable session: a bearer credential usable until the provider lifetime unless cancelled (09 "Resumable session security"). */
export interface ResumableSession {
  /** The bearer reference (resumable session URI). Only the vault port and the protected response ever see it. */
  readonly sessionRef: string;
  readonly providerExpiresAt: UtcInstant;
  /** The chunk multiple the client must respect when resuming (Cloud Storage: 256 KiB). */
  readonly chunkMultipleBytes: number;
}

export type ProviderCancellationResult = "CONFIRMED" | "UNSUPPORTED" | "UNCERTAIN";

export interface ObjectStoragePort {
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  location(zone: StorageZone): StorageLocation;
  capabilities(): { readonly sessionCancellation: "SUPPORTED" | "UNSUPPORTED"; readonly sessionLifetimeSeconds: number };
  /**
   * Creates a resumable session for exactly `objectName` with a no-overwrite precondition (generation 0), bound to the declared
   * length and the application origin. Called between the two units of work of CMD013, never inside a transaction.
   */
  createResumableSession(request: { readonly location: StorageLocation; readonly objectName: string; readonly declaredBytes: number; readonly contentType: string; readonly origin: string }, timeoutMs: number): Promise<ResumableSession>;
  /** Cancels a session (Cloud Storage: DELETE on the session URI); the result is recorded, never assumed. */
  cancelResumableSession(sessionRef: string, timeoutMs: number): Promise<ProviderCancellationResult>;
  /** The current generation of a name; null when absent (a missing object is a successful absence check, 09). */
  stat(location: StorageLocation, objectName: string): Promise<ObjectObservation | null>;
  /** Streams exactly `generation` (generation precondition); fails when that generation no longer exists. */
  read(location: StorageLocation, objectName: string, generation: string): AsyncIterable<Uint8Array>;
  /** Copies an exact source generation to a destination that must not exist (ifGenerationMatch=0); returns the new generation. */
  copy(from: { readonly location: StorageLocation; readonly objectName: string; readonly generation: string }, to: { readonly location: StorageLocation; readonly objectName: string }): Promise<{ readonly generation: string }>;
  /** Deletes exactly `generation` (generation precondition). */
  delete(location: StorageLocation, objectName: string, generation: string): Promise<"DELETED" | "ALREADY_ABSENT" | "PRECONDITION_FAILED">;
  /** Provider inventory of a prefix (09: periodic inventory detects objects missing from the registry). */
  list(location: StorageLocation, prefix: string, page?: string): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly bytes: number }>; readonly next?: string }>;
  /** Parses a browser-forwarded completion reference (CMD014) into a claim; MALFORMED when it is not this provider's completion. */
  parseCompletionClaim(ref: string): { readonly kind: "CLAIM"; readonly claim: CompletionClaim } | { readonly kind: "MALFORMED" };
}

// --- malware scanner -----------------------------------------------------------------------------------------------------------

export interface MalwareScannerPort {
  readonly engine: string;
  readonly evidenceClass: ProviderEvidenceClass;
  /** The accepted configuration digest (09: pinned engine, signature databases, file/scan size, recursion, timeout, memory). */
  readonly pinnedConfigHash: Sha256Hex;
  /**
   * Scans the quarantined generation and reports per expected part what it covered. The report's exit code and verdict are
   * evidence only; the scan state is derived by the domain (evaluateScanCoverage), never taken from the engine (S054).
   */
  scan(subject: { readonly location: StorageLocation; readonly objectName: string; readonly generation: string; readonly parts: ReadonlyArray<ExpectedScanPart> }): Promise<ScannerReport>;
}

// --- container inspection (the platform's bounded preflight; @kauro/data-plane) -----------------------------------------------------

/** Conjunctive inspection limits (registry policy.input; 04 "XLSX parser requirements"). */
export interface InspectionLimits {
  readonly fileBytes: number;
  readonly xlsxExpandedTotalBytes: number;
  readonly xlsxExpandedPartBytes: number;
  readonly maxArchiveEntries: number;
  readonly maxCompressionRatio: number;
  readonly maxXmlDepth: number;
  readonly columns: number;
  readonly decodedCellBytes: number;
  readonly decodedRecordBytes: number;
  readonly wallClockMs: number;
}

export interface DetectedColumn {
  readonly ordinal: number;
  /** Untrusted header text as decoded (display only; stored only for the tenant, digested everywhere else). */
  readonly label?: string;
  readonly labelState: "PRESENT" | "EMPTY" | "DUPLICATE_LABEL" | "DISPLAY_TRUNCATED" | "UNDECODABLE" | "NO_HEADER";
}

export interface DetectedTable {
  readonly ordinal: number;
  readonly kind: "CSV_TABLE" | "WORKSHEET";
  /** Untrusted worksheet name (display only). */
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
  readonly columns: ReadonlyArray<DetectedColumn>;
}

/**
 * The result of one bounded structural inspection (04 inspectContainer: "Inspection alone does not certify the entire source as
 * parsed or virus-free. ... The result identifies which checks completed").
 */
export interface ContainerInspection {
  readonly detectedFormat: DeclaredFormat | "UNSUPPORTED";
  readonly structureStatus: "STRUCTURE_VALID" | "STRUCTURE_INVALID";
  /** SHA-256 recomputed over every byte read; the byte count actually read. */
  readonly sha256: Sha256Hex;
  readonly bytes: number;
  readonly problems: ReadonlyArray<InspectionProblem>;
  /** Classifies a refusal: hostile archive, active content, resource limit (decides the receipt's rejection class). */
  readonly refusal?: "CORRUPT_STRUCTURE" | "ACTIVE_CONTENT" | "RESOURCE_LIMIT" | "UNSUPPORTED_FORMAT";
  /** The container and every allowed part the scanner must cover, with its verified expanded length (09 "Scanner coverage"). */
  readonly expectedScanParts: ReadonlyArray<ExpectedScanPart>;
  readonly tables: ReadonlyArray<DetectedTable>;
  /** The pinned configuration and detected container facts that parserProfileHash digests. */
  readonly parserProfile: Readonly<Record<string, string | number | boolean>>;
  readonly checksCompleted: ReadonlyArray<string>;
}

export interface ContainerInspectorPort {
  readonly version: string;
  /**
   * Inspects one immutable generation under hard limits, without network access and without writing outside its attempt scratch
   * (S024: reject traversal, duplicate entries, XML entities or excessive expansion without outside writes, network access or
   * unbounded decompression). `open` streams the exact generation; the inspector must read it to the end to report sha256.
   */
  inspect(input: { readonly open: () => AsyncIterable<Uint8Array>; readonly declaredFormat: DeclaredFormat; readonly observedBytes: number; readonly limits: InspectionLimits }): Promise<ContainerInspection>;
}

// --- selection evaluation (the counting pass; @kauro/data-plane) ------------------------------------------------------------------

export interface SelectionEvaluationInput {
  readonly selection: SelectionManifestDocument;
  readonly files: ReadonlyArray<{ readonly file: SourceFileRecord; readonly tables: ReadonlyArray<SourceTableRecord>; readonly open: () => AsyncIterable<Uint8Array> }>;
  readonly limits: InspectionLimits & { readonly associationCandidates: number; readonly revisionBytes: number; readonly files: number };
  readonly pricingDefinition: string;
}

export type SelectionEvaluationOutcome =
  | {
      readonly result: "COMPLETE";
      readonly populations: SourcePopulations;
      readonly files: ReadonlyArray<EvaluatedFile>;
      readonly tables: ReadonlyArray<EvaluatedTable>;
      readonly projections: ReadonlyArray<EvaluatedProjection>;
      readonly associations: ReadonlyArray<{ readonly associationKey: string; readonly edges: number }>;
    }
  | {
      /** A selected table violates the admission contract (fatal_input_rejection: no silent removal from the source set). */
      readonly result: "ADMISSION_FAILED";
      readonly files: ReadonlyArray<EvaluatedFile>;
      readonly tables: ReadonlyArray<EvaluatedTable>;
      readonly failures: ReadonlyArray<EvaluationFailure>;
    }
  | { readonly result: "ERROR"; readonly failures: ReadonlyArray<EvaluationFailure> };

export interface SelectionEvaluatorPort {
  readonly version: string;
  /**
   * Opens every included table's accepted generation by exact generation, re-verifies its digest while parsing under the selected
   * parser choices, applies the projection and counts the four populations exactly (03 "Count the correct population"; 04
   * "Facts used as proof must be exact"). Bounded memory: distinct referenced-entity keys spill to attempt-owned scratch.
   */
  evaluate(input: SelectionEvaluationInput): Promise<SelectionEvaluationOutcome>;
}

// --- session vault -----------------------------------------------------------------------------------------------------------

/** Additional authenticated data binding a sealed session reference to exactly one upload, requester and issuance attempt. */
export interface SessionSecretBinding {
  readonly agencyId: AgencyId;
  readonly uploadId: UploadId;
  readonly requestedByUserId: UserId;
  readonly sessionAttempt: number;
}

export interface SessionVaultPort {
  /** Key identity (name/version) recorded with each sealed secret — never key material. */
  readonly keyRef: string;
  seal(sessionRef: string, binding: SessionSecretBinding): Promise<{ readonly keyRef: string; readonly nonce: Uint8Array; readonly ciphertext: Uint8Array }>;
  /** Fails (never returns another upload's plaintext) when the binding does not match the one the secret was sealed with. */
  open(sealed: { readonly keyRef: string; readonly nonce: Uint8Array; readonly ciphertext: Uint8Array }, binding: SessionSecretBinding): Promise<string>;
}

// --- external authority journal (tombstones outside the restore boundary) -------------------------------------------------------

export type AuthorityTombstoneKind = "UPLOAD_ACCEPTANCE_REVOKED" | "REVISION_CANCELLED" | "REVISION_SUPERSEDED" | "REVISION_DELETED";

/** A minimal durable fact (14: scoped ids, deadlines, sequence and evidence hashes; no CRM payload). */
export interface AuthorityTombstone {
  /** The domain event id that produced it (idempotent append). */
  readonly tombstoneId: Id;
  readonly kind: AuthorityTombstoneKind;
  readonly agencyId: AgencyId;
  readonly revisionId: RevisionId;
  readonly subjectId: Id;
  /** The terminal state the subject reached (CANCELLED, EXPIRED, REJECTED, SUPERSEDED, DELETED). */
  readonly state: string;
  readonly occurredAt: UtcInstant;
  /** The domain event sequence: restore reconciliation applies tombstones in this order. */
  readonly sequence: number;
  /** KAURO_AUTHORITY_TOMBSTONE_V1 digest of the other members. */
  readonly evidenceHash: Sha256Hex;
}

export interface AuthorityJournalPort {
  readonly evidenceClass: ProviderEvidenceClass;
  append(tombstone: AuthorityTombstone): Promise<"APPENDED" | "ALREADY_PRESENT">;
  /** Every tombstone of an agency after a sequence (restore reconciliation, D-RESTORE-1). */
  list(agencyId: AgencyId, afterSequence: number): Promise<ReadonlyArray<AuthorityTombstone>>;
}

// --- commercial scope (CMD012 impact map; B09 binds the real inspector) -----------------------------------------------------------

export interface CommercialScopeInspector {
  /** Live commercial authorizations bound to the revision (none exist before the payments package, B09). */
  authorizationsBoundTo(uow: UnitOfWork, agencyId: AgencyId, revisionId: RevisionId): Promise<ReadonlyArray<Id>>;
}
