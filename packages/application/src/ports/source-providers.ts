/**
 * Ports of the source lifecycle to what the platform does not own (B07; docs/design/B07-upload-source-lifecycle.md §6).
 *
 * External providers — object storage, the malware scanner, the key service that seals provider session references and the
 * external authority journal that survives a database restore — are reached only through these ports. Until the real integration
 * package (B15) binds provider adapters, tests bind contract-faithful fakes that report `evidenceClass: "SIMULATED"` and are
 * labelled as such in code and evidence (21 "Evidence classes": SIMULATED demonstrates a local contract with fakes; it is never
 * EXECUTED_PROVIDER). Each fake has one owner (design §15): the scanner's is mandate B07-DATA-PLANE's (`@kauro/data-plane/testing`),
 * object storage's, the session vault's and the authority journal's are mandate B07-PROVIDER-FAKES' (`@kauro/application/testing`),
 * both test-only subpaths. A deployment of this edition binds no fake: the edition answers INTEGRITY_FAILURE /
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
  /**
   * The location's effective soft-delete retention and object versioning, read back from the provider (09 "Soft delete, versioning
   * and holds": customer-data buckets disable both unless a disclosed design is approved, and the effective setting is verified
   * after provisioning; D-OBJ-2). The control plane records every read-back (kauro.storage_location_policies); a deletion at a
   * location never read back cannot be recorded.
   */
  readRetentionPolicy(location: StorageLocation): Promise<{ readonly softDeleteRetentionSeconds: number; readonly objectVersioning: boolean; readonly evidenceHash: Sha256Hex; readonly observedAt: UtcInstant }>;
  /**
   * Generations of a prefix the provider still holds soft-deleted, with the expiry the provider reports for each (09: inventory
   * pre-existing soft-deleted generations and record their actual expiry rather than claiming they vanished).
   */
  listSoftDeleted(location: StorageLocation, prefix: string, page?: string): Promise<{ readonly objects: ReadonlyArray<{ readonly objectName: string; readonly generation: string; readonly softDeletedAt: UtcInstant; readonly expiresAt: UtcInstant }>; readonly next?: string }>;
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
 * How one inspection was isolated and what its observers recorded (decision D-ISO-1, B07-F6; S024 "Reject without outside writes,
 * network access or unbounded decompression"; 09 "Scanner coverage": a restricted environment without customer-triggered network
 * fetching). The mechanism is observable on every host the platform verifies on, Windows included:
 *
 * - NODE_PERMISSION_CHILD: @kauro/data-plane runs the inspection in a child process started with the Node permission model
 *   (`node --permission --allow-fs-read=<the attempt input and the inspector's own code> --allow-fs-write=<the attempt scratch>`;
 *   no `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`), so a write outside the scratch, a child
 *   process, a worker or a native addon is refused by Node itself (ERR_ACCESS_DENIED) and counted here; and with a preload module
 *   that replaces every network entry point (net and tls connections, dgram sockets, dns lookups and resolvers, http(s) requests,
 *   fetch, WebSocket) by a function that records the attempt and throws — Node 24's permission model does not govern the network,
 *   so the hook is the observer, and a probe that tries to connect is its negative control.
 * - The OS-level network denial of the worker host (an egress-denied sandbox, a network namespace or firewall) is not observable
 *   on the Windows verify host: it is qualified with the cloud host (LATER: B15, EXECUTED_PROVIDER) and reported as
 *   `osNetworkDenied` only where the host measured it.
 */
export interface InspectionIsolation {
  readonly mechanism: "NODE_PERMISSION_CHILD";
  /** Writes outside the attempt scratch that the permission model refused, as the child recorded them (0 for a clean run). */
  readonly outsideWriteAttempts: number;
  /** Connections or name resolutions the network hooks refused (0 for a clean run). */
  readonly networkAttempts: number;
  /** Child processes, workers, addons or WASI the permission model refused. */
  readonly processAttempts: number;
  /** Bytes decompressed in total, never above InspectionLimits.xlsxExpandedTotalBytes (the bound stopped the rest). */
  readonly decompressedBytes: number;
  /** Measured OS-level egress denial of the host; absent where the host cannot measure it (a development or verify host). */
  readonly osNetworkDenied?: boolean;
}

/**
 * The result of one bounded structural inspection (04 inspectContainer: "Inspection alone does not certify the entire source as
 * parsed or virus-free. ... The result identifies which checks completed").
 */
export interface ContainerInspection {
  /** The isolation of this inspection and its observers (D-ISO-1): a result without it is not admission evidence. */
  readonly isolation: InspectionIsolation;
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
   * Inspects one immutable generation under hard limits, isolated as InspectionIsolation describes (S024: reject traversal,
   * duplicate entries, XML entities or excessive expansion without outside writes, network access or unbounded decompression).
   * `open` streams the exact generation; the inspector must read it to the end to report sha256. `scratchDir` is the attempt-owned
   * scratch (09 "Derived data and worker scratch": cleanup targets only that ownership scope) and the only writable path.
   */
  inspect(input: { readonly open: () => AsyncIterable<Uint8Array>; readonly declaredFormat: DeclaredFormat; readonly observedBytes: number; readonly limits: InspectionLimits; readonly scratchDir: string }): Promise<ContainerInspection>;
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

/**
 * The terminal authority facts of the source lifecycle that must survive a database restore (09 "Deletion receipts and
 * restoration": restoration applies tombstones and current revocation facts before traffic; the registry's SEALED -> EXPIRED
 * effect "Revoke reads/execution"). B07-F8: an expired revision (and a rejected one, whose selected input failed the admission
 * contract) is a tombstone like a cancelled, superseded or deleted one — a restore must not re-enable any of them. Re-check N5: a
 * file whose admission was revoked (its retention ended, its intake window closed unsealed, or its generation was lost or changed)
 * is one too — a restore must not re-admit its bytes (09: restoring must not "recreate source data").
 */
export type AuthorityTombstoneKind =
  | "UPLOAD_ACCEPTANCE_REVOKED"
  | "REVISION_CANCELLED"
  | "REVISION_SUPERSEDED"
  | "REVISION_REJECTED"
  | "REVISION_EXPIRED"
  | "REVISION_DELETED"
  | "FILE_ADMISSION_REVOKED";

/**
 * The state a tombstoned subject reached, named exactly as the subject's own machine names it (closed: a tombstone never records
 * a live state): UploadSession CANCELLED, EXPIRED, REJECTED; DatasetRevision CANCELLED, SUPERSEDED, REJECTED, EXPIRED, DELETED;
 * SourceFile ADMISSION_REVOKED. Decision D-RESTORE-2 (residual FINAL-N1): the AUTHORITY_JOURNAL consumer compares this state with
 * the subject's current state before appending, so a name the machine does not have would dead-letter every such tombstone.
 */
export type AuthorityTombstoneState = "CANCELLED" | "EXPIRED" | "REJECTED" | "SUPERSEDED" | "DELETED" | "ADMISSION_REVOKED";

/**
 * Which tombstone each event routed to AUTHORITY_JOURNAL produces (EVENT_SUBSCRIPTIONS): the AUTHORITY_JOURNAL consumer appends
 * exactly this kind and state; the application test proves the keys are exactly the routed event types, so an event routed there
 * without a tombstone kind (the gap of B07-F8) fails the build's tests.
 */
export const AUTHORITY_TOMBSTONES = Object.freeze({
  "upload_session.cancelled.v1": { kind: "UPLOAD_ACCEPTANCE_REVOKED", state: "CANCELLED" },
  "upload_session.expired.v1": { kind: "UPLOAD_ACCEPTANCE_REVOKED", state: "EXPIRED" },
  "upload_session.rejected.v1": { kind: "UPLOAD_ACCEPTANCE_REVOKED", state: "REJECTED" },
  "dataset_revision.cancelled.v1": { kind: "REVISION_CANCELLED", state: "CANCELLED" },
  "dataset_revision.superseded.v1": { kind: "REVISION_SUPERSEDED", state: "SUPERSEDED" },
  "dataset_revision.rejected.v1": { kind: "REVISION_REJECTED", state: "REJECTED" },
  "dataset_revision.expired.v1": { kind: "REVISION_EXPIRED", state: "EXPIRED" },
  "dataset_revision.deleted.v1": { kind: "REVISION_DELETED", state: "DELETED" },
  "source_file.admission_revoked.v1": { kind: "FILE_ADMISSION_REVOKED", state: "ADMISSION_REVOKED" },
} as const satisfies Readonly<Record<string, { readonly kind: AuthorityTombstoneKind; readonly state: AuthorityTombstoneState }>>);

/** A minimal durable fact (14: scoped ids, deadlines, sequence and evidence hashes; no CRM payload). */
export interface AuthorityTombstone {
  /** The domain event id that produced it (idempotent append). */
  readonly tombstoneId: Id;
  readonly kind: AuthorityTombstoneKind;
  readonly agencyId: AgencyId;
  /** The revision whose authority the subject belonged to (for a file: the revision it was admitted from). */
  readonly revisionId: RevisionId;
  /** The tombstoned subject: the upload, the revision, or the file. */
  readonly subjectId: Id;
  /** The terminal state the subject reached. */
  readonly state: AuthorityTombstoneState;
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
