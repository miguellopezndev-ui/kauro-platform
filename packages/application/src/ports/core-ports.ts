/**
 * Ports of the two cores (design docs/design/B08-audit-approval-jobs.md §10; mandate B08-CORE-PORTS).
 *
 * Migration and Intelligence are reached only through these ports (D8-PORT-1): a deployment that binds no adapter answers
 * INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE, never a stub standing in for a core. Every result carries `evidenceClass`
 * (21 "Evidence classes"): a fake reports SIMULATED (D8-FAKE-1); the real thin adapter of `b05/cores` reports EXECUTED_LOCAL —
 * the cores are embedded packages the platform calls in-process, never an external provider, so EXECUTED_PROVIDER never
 * applies to them.
 *
 * These signatures were checked against the two cores actually being released, not invented from the manual alone
 * (manual 04 "Architecture and dependency boundary", "executePlan", "verifyPackage"; 06 "Intelligence engine"):
 *   - kauro-migration-core 3.0.0 (`kauro-migration-core-release`, `src/index.ts`) exports `runMigration(input: RunInput):
 *     RunResult` (synchronous) and `writePackage` / `promotePackage` / `verifyPackage(packageDir: string, options)`
 *     (synchronous, filesystem-directory calls) rather than the manual's separate `profileSources` / `validatePlan` /
 *     `dryRun` / `executePlan` methods threaded through an injected `ArtifactWriter`. Only `ScratchStore` is truly
 *     host-injected as an object (`src/scratch/scratch-store.ts`, contract version "1.0.0"); `ScratchStore` below is that
 *     same contract, so a thin adapter can hand `io.scratch` straight to `runMigration`/`verifyPackage` with no translation
 *     shim. `SourceReader` and `ArtifactWriter` are the platform's own abstraction over the core's plain `inputRoot`/
 *     `outputDir` directories — the adapter materializes one from the other (D8-PORT-2).
 *   - kauro-intelligence-core (`kauro-intelligence-core-privacy`, `src/index.ts`, `src/api/intelligence-core.ts`) exports
 *     `createIntelligenceCore(deps): { run(input, context), cancel(runId, reason), readRun(runId) }`; the coarse
 *     COMPILED/NEEDS_DECISION/UNSUPPORTED/FAILED vocabulary of `InterpretResult` collapses the core's own
 *     `DraftMigrationPlan.status` (SYSTEM_DRAFT/NOT_DRAFTABLE) and per-task `TaskOutcome`/terminal-cause vocabulary
 *     (manual 06 "SYSTEM_DRAFT ... NEEDS_AGENCY_DECISION ... UNSUPPORTED ... FAILED_PROVIDER, FAILED_COMPILER,
 *     FAILED_VALIDATION, BUDGET_EXCEEDED, CANCELLED and DEADLINE_EXCEEDED"). `planTasks` and `resolveDeterministically`
 *     (`src/planner/task-planner.ts`, `src/resolver/deterministic-resolver.ts`) are exported separately from `run`, which is
 *     what makes `planCandidates` (no model dispatch, no spend) satisfiable apart from `interpret` (dispatches, spends).
 *     The core's host-injected journal, `LedgerStore` (`src/kernel/ledger.ts`), is a plain synchronous
 *     `append(runId, event, expectedLength): AppendOutcome` / `read(runId): LedgerEvent[]` fenced log — `ModelTaskJournalPort`
 *     below is deliberately shaped the same way, because that is the narrowest surface the core actually needs; a
 *     synchronous host store is a stronger claim than this async, Postgres-backed port can make in one call, so the
 *     adapter must buffer/replay around one `run()` invocation rather than pass the port straight through (D8-PORT-3).
 *
 * `PlanCompilerPort` returns `PatchCompilation` (B06 `ports/plan-services.ts`) so CMD022's compiler reasons
 * (UNKNOWN_CANDIDATE, UNKNOWN_FIELD, EFFECT_NOT_PERMITTED, MALFORMED_PATCH) are the same vocabulary CMD023 already uses,
 * never a second one invented for the audit path.
 */
import type { Id, Sha256Hex, UtcInstant, ValidationReceipt } from "@kauro/contracts";
import type { AgencyId, PlanBody, ProjectId } from "@kauro/domain";
import type { PatchCompilation } from "./plan-services.js";

/** 21 "Evidence classes": EXECUTED_LOCAL records the real core running in-process; SIMULATED is a labelled contract fake. */
export type CoreEvidenceClass = "EXECUTED_LOCAL" | "SIMULATED";

// --- host I/O (manual 04 "Architecture and dependency boundary"; design §10) ---------------------------------------------------

/** Opens exactly the sealed ACCEPTED generation a manifest names; never quietly follows a newer object under the same name. */
export interface SourceHandle {
  readonly byteLength: number;
  readonly sha256: Sha256Hex;
  read(): AsyncIterable<Uint8Array>;
}

export interface SourceReader {
  open(ref: { readonly objectName: string; readonly generation: string }): Promise<SourceHandle>;
}

/** A sealed, immutable, self-describing scratch segment (kauro-migration-core-release `src/scratch/scratch-store.ts`). */
export interface ScratchSegmentManifest {
  readonly segmentId: string;
  readonly schema: string;
  readonly schemaVersion: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
  readonly rowCount: number;
  readonly firstKey: string | null;
  readonly lastKey: string | null;
  readonly sorted: boolean;
}

export interface ScratchSegmentSpec {
  readonly schema: string;
  readonly schemaVersion: string;
  readonly sorted?: boolean;
  readonly pass?: number;
}

export interface ScratchSegmentWriter {
  readonly segmentId: string;
  append(line: string, key?: string): void;
  seal(): ScratchSegmentManifest;
  abort(): void;
}

/** What a scratch family is for, as its producer declared it (every field null until declared). */
export interface ScratchFamilyDeclaration {
  readonly purpose: string | null;
  readonly producer: string | null;
  readonly consumer: string | null;
}

export interface ScratchSortFormat {
  readonly keyTerminatorBytes: number;
  readonly sequenceBytes: number;
  readonly keySeparatorBytes: number;
}

/** One external sort the run performed, as the algorithm reports its own parameters (never a measurement). */
export interface ScratchSortRecord {
  readonly records: number;
  readonly payloadBytes: number;
  readonly keyBytes: number;
  readonly runSize: number;
  readonly fanIn: number;
  readonly initialRuns: number;
  readonly mergePasses: number;
  readonly initialRunBytes: readonly number[];
  readonly initialRunRecords: readonly number[];
  readonly format: ScratchSortFormat;
  readonly resultSegmentId: string | null;
  readonly resultBytes: number;
  readonly resultRows: number;
  readonly resultDigest: string | null;
}

export interface ScratchFamilyUsage {
  readonly family: string;
  readonly bytesWritten: number;
  readonly peakBytes: number;
  readonly liveBytes: number;
  readonly segments: number;
  readonly released: number;
  readonly declaration: ScratchFamilyDeclaration;
  readonly segmentsSealed: number;
  readonly linesWritten: number;
  readonly framingBytes: number;
  readonly bytesWrittenByPass: readonly number[];
  readonly bytesWrittenUnattributed: number;
  readonly openedAt: number | null;
  readonly closedAt: number | null;
  readonly sorts: readonly ScratchSortRecord[];
}

export interface ScratchUsage {
  readonly bytes: number;
  readonly peakBytes: number;
  readonly quotaBytes: number;
  readonly segmentCount: number;
  readonly bytesWritten: number;
  readonly byFamily: readonly ScratchFamilyUsage[];
  readonly framingBytesPerLine: number;
}

/**
 * Attempt-owned segments with a byte quota and a checksum per segment (D8-STG-2). Structurally the same contract
 * kauro-migration-core 3.0.0 requires of its own host-injected `ScratchStore` (contract version "1.0.0"), so the real
 * implementer (`AttemptScratchStore`, B08-WORKER-HOST) can be handed to the core with no translation.
 */
export interface ScratchStore {
  readonly contractVersion: string;
  createSegment(spec: ScratchSegmentSpec): ScratchSegmentWriter;
  readLines(segmentId: string): IterableIterator<string>;
  manifest(segmentId: string): ScratchSegmentManifest;
  list(): readonly ScratchSegmentManifest[];
  delete(segmentId: string): void;
  declareFamily(family: string, declaration: ScratchFamilyDeclaration): void;
  recordSort(family: string, sort: ScratchSortRecord): void;
  usage(): ScratchUsage;
  dispose(): void;
}

/** One artifact written under the attempt's own staging prefix, closed, hashed and re-read before it exists (D8-STG-1). */
export interface StagedArtifact {
  readonly role: string;
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

export interface ArtifactHandle {
  write(chunk: Uint8Array): Promise<void>;
  /** Closes, hashes and re-reads before resolving; a failed close, short write or mismatch is never a staged artifact. */
  close(): Promise<StagedArtifact>;
}

export interface ArtifactWriter {
  /** Opens a new artifact under the attempt's prefix with a generation-0 precondition; `pathHash` names it deterministically. */
  open(role: string, pathHash: Sha256Hex): ArtifactHandle;
}

export type CancellationState = "CONTINUE" | "CANCELLED" | "FENCED";

export interface CancellationChannel {
  check(): Promise<CancellationState>;
}

/** Manual 04 "Resources": the qualification host envelope (8 GiB hard memory, 64 GiB hard scratch, 8 h execution wall). */
export interface ExecutionLimits {
  readonly hardMemoryBytes: number;
  readonly memoryBudgetBytes: number;
  readonly hardScratchBytes: number;
  readonly scratchBudgetBytes: number;
  readonly wallClockMs: number;
}

/**
 * The bounds a bounded core call runs under (B05 D5-2b). The real adapter requires them on every call that has no `HostIo`
 * (validate, verify) and rejects without them; the contract fake ignores them. `deadlineAt` defaults to now + `limits.wallClockMs`.
 */
export interface CoreCallControls {
  readonly limits: ExecutionLimits;
  readonly deadlineAt?: UtcInstant;
  /** Where the revision's sealed generations are read from (validate). */
  readonly source?: SourceReader;
  /** The frozen quote's billable units (validate): not in the package, so the caller states them (RowCounts). */
  readonly billableSourceUnits?: number;
  /** Cancellation of a call that has none of its own (verify). */
  readonly cancellation?: CancellationChannel;
  /** Re-reads a staged artifact's bytes (verify); absent, only the metadata is compared. */
  readonly readArtifact?: (artifact: StagedArtifact) => AsyncIterable<Uint8Array>;
}

export interface HostIo {
  readonly source: SourceReader;
  readonly scratch: ScratchStore;
  readonly writer: ArtifactWriter;
  readonly cancellation: CancellationChannel;
  readonly limits: ExecutionLimits;
}

// --- ExecutionEnvelopePort (executePlan; design §9 Job/ProcessingAttempt owns the durable record) ------------------------------

/**
 * The immutable inputs of one execution attempt. The durable record (Job, ProcessingAttempt) is B08-PERSISTENCE-EXECUTION's;
 * this is the minimal subset the envelope passes to the core.
 */
export interface ExecutionSubject {
  readonly jobId: Id;
  readonly attemptId: Id;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  /** KAURO_JOB_INPUT_BINDING_V1 over the authorization's execution subject and the receipt's core package hash (D8-JOB-2). */
  readonly inputBindingHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex | null;
  readonly planHash: Sha256Hex;
  /** The closed migration configuration body the plan compiled to (kauro-migration-core `MigrationConfig`); opaque here. */
  readonly configDocument: unknown;
  readonly configHash: Sha256Hex;
  readonly executionDeadlineAt: UtcInstant;
}

export type ExecutionTerminalCause =
  | "COMPLETED"
  | "SCRATCH_EXHAUSTED"
  | "SHORT_WRITE"
  | "CORRUPT_INTERMEDIATE"
  | "CANCELLED"
  | "FENCED"
  | "DEADLINE_EXCEEDED"
  | "REFUSED";

/** A core refusal (a MigrationError of the core, or a binding the adapter refuses): the code is the core's or the adapter's own token. */
export interface CoreRefusal {
  readonly code: string;
  readonly message: string;
}

export interface ExecutionOutcome {
  readonly evidenceClass: CoreEvidenceClass;
  /** The core version the record names (3.0.0 for the real core, the fake's own token for the fake). */
  readonly coreVersion?: string;
  /** Present when terminalCause is REFUSED. */
  readonly refusal?: CoreRefusal;
  readonly terminalCause: ExecutionTerminalCause;
  readonly stagedArtifacts: readonly StagedArtifact[];
  /** The reconciled row/edge counts and issue totals (kauro-migration-core `Reconciliation`); opaque beyond its hash here. */
  readonly reconciliationSummary: unknown;
  readonly resourceMetrics: { readonly peakMemoryBytes: number; readonly peakScratchBytes: number; readonly wallClockMs: number };
}

export interface ExecutionEnvelopePort {
  execute(subject: ExecutionSubject, io: HostIo): Promise<ExecutionOutcome>;
}

// --- ProfilePort (profileSources / buildSourceProfile) --------------------------------------------------------------------------

export interface ProfileRequest {
  readonly source: SourceReader;
  readonly revisionHash: Sha256Hex;
  readonly scratch: ScratchStore;
  readonly limits: ExecutionLimits;
  readonly cancellation: CancellationChannel;
}

export interface ProfileResult {
  readonly evidenceClass: CoreEvidenceClass;
  readonly coreVersion?: string;
  readonly outcome: "PROFILED" | "REJECTED" | "CANCELLED";
  readonly profileHash: Sha256Hex | null;
  /** The closed profile document (kauro-migration-core `SourceProfileV1`); opaque beyond its hash here. */
  readonly profileDocument: unknown;
}

export interface ProfilePort {
  profile(request: ProfileRequest): Promise<ProfileResult>;
}

// --- PackageVerifierPort (verifyPackage) ------------------------------------------------------------------------------------

/** Independently supplied expectation a package is checked against; it cannot establish its own expected source (manual 04). */
export interface ExpectedAuthority {
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex | null;
  readonly coreVersion: string;
  readonly requiredArtifacts: readonly StagedArtifact[];
}

export interface PackageCandidate {
  readonly jobId: Id;
  readonly attemptId: Id;
  readonly artifacts: readonly StagedArtifact[];
  /** The candidate's own claimed disposition summary; a false one is rejected even when every artifact is present (manual 04). */
  readonly declaredSummary: unknown;
}

export type PackageVerificationVerdict = "VALID" | "INVALID" | "ERROR";

export interface PackageVerificationResult {
  readonly evidenceClass: CoreEvidenceClass;
  readonly coreVersion?: string;
  readonly verdict: PackageVerificationVerdict;
  readonly problems: readonly string[];
}

export interface PackageVerifierPort {
  verify(candidate: PackageCandidate, expected: ExpectedAuthority, controls?: CoreCallControls): Promise<PackageVerificationResult>;
}

// --- ValidatePort (validatePlan / dryRun) -----------------------------------------------------------------------------------

export interface ValidateRequest {
  readonly revisionHash: Sha256Hex;
  readonly planBody: PlanBody;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex | null;
  readonly scratch: ScratchStore;
  readonly cancellation: CancellationChannel;
  readonly controls?: CoreCallControls;
}

/**
 * The registry ValidationReceipt fields this port establishes; receiptId/planId/agencyId/timestamps are persistence's
 * (B08-PERSISTENCE-AUDIT). `targetContractHash` is nullable here for CLEAN_ONLY, where the registry's own `ValidationReceipt`
 * requires one (D8-PORT-4): persistence supplies the row's canonical "no target" hash when it writes a CLEAN_ONLY receipt.
 * `counts` are the receipt's independent denominators and dispositions, which only the validator can establish (decision D8-CAU-6).
 */
export type CoreValidationReceipt = Omit<
  Pick<ValidationReceipt, "revisionHash" | "targetContractHash" | "planHash" | "corePackageHash" | "profileEvidenceHash" | "dispositionEvidenceHash" | "artifactEvidenceHash" | "counts">,
  "targetContractHash"
> & { readonly targetContractHash: Sha256Hex | null };

export interface ValidateResult {
  readonly evidenceClass: CoreEvidenceClass;
  readonly coreVersion?: string;
  readonly outcome: "VALID" | "INVALID" | "ERROR";
  readonly receipt: CoreValidationReceipt | null;
  readonly problems: readonly string[];
}

export interface ValidatePort {
  validate(request: ValidateRequest): Promise<ValidateResult>;
}

// --- ModelTaskJournalPort (the host store kauro-intelligence-core dispatches under; D8-AUD-3) -----------------------------------

/** One journal event, opaque to the platform: the core's own `LedgerEvent` is versioned and read only by the core. */
export type ModelTaskJournalEvent = Readonly<Record<string, unknown>>;

export type ModelTaskJournalAppendOutcome =
  | { readonly ok: true; readonly length: number }
  | { readonly ok: false; readonly conflict: "LENGTH_MISMATCH"; readonly actualLength: number };

export interface ModelTaskJournalPort {
  /** Fenced append: lands only when `expectedLength` matches the journal's current length for `runId`. */
  append(runId: Id, event: ModelTaskJournalEvent, expectedLength: number): Promise<ModelTaskJournalAppendOutcome>;
  read(runId: Id): Promise<readonly ModelTaskJournalEvent[]>;
}

// --- InterpretPort (planCandidates / interpret; kauro-intelligence-core `run`) ---------------------------------------------------

export interface PlanCandidatesRequest {
  readonly agencyId: AgencyId;
  readonly revisionHash: Sha256Hex;
  readonly sourceProfileHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex | null;
}

export interface CandidateManifest {
  readonly evidenceClass: CoreEvidenceClass;
  readonly candidateSetHash: Sha256Hex;
  /** The closed candidate-set document (kauro-migration-core `CandidateSetV1`); opaque beyond its hash here. */
  readonly document: unknown;
}

export interface InterpretRequest {
  readonly auditAttemptId: Id;
  readonly agencyId: AgencyId;
  /** The audit's project and sealed revision: the tenant of the run is {agencyId, clientId: projectId} (D5-13). */
  readonly projectId: ProjectId;
  readonly revisionId: Id;
  readonly candidateManifest: CandidateManifest;
  readonly journal: ModelTaskJournalPort;
  /** The AUDIT grant's remaining cents; interpretation reserves under it and never spends past it (D8-GRANT-1, D8-GRANT-2). */
  readonly fundedCeilingCents: number;
  readonly interpretationDeadlineAt: UtcInstant;
  readonly cancellation: CancellationChannel;
}

/** Manual 06's outcome vocabulary collapsed to the four the platform records (SYSTEM_DRAFT, NEEDS_AGENCY_DECISION, UNSUPPORTED, and every FAILED_PROVIDER, FAILED_COMPILER, FAILED_VALIDATION, BUDGET_EXCEEDED, CANCELLED and DEADLINE_EXCEEDED cause folded into FAILED). */
export type InterpretOutcome = "COMPILED" | "NEEDS_DECISION" | "UNSUPPORTED" | "FAILED";

export interface InterpretResult {
  readonly evidenceClass: CoreEvidenceClass;
  readonly outcome: InterpretOutcome;
  /** The compiled candidate decisions (kauro-intelligence-core `DraftMigrationPlan`); present only for COMPILED or NEEDS_DECISION. */
  readonly candidateDecisions: unknown | null;
  readonly reservedCents: number;
  readonly spentCents: number;
}

export interface InterpretPort {
  /** No model dispatch, no spend (kauro-intelligence-core `planTasks`/`resolveDeterministically`, exported apart from `run`). */
  planCandidates(request: PlanCandidatesRequest): Promise<CandidateManifest>;
  interpret(request: InterpretRequest): Promise<InterpretResult>;
}

// --- PlanCompilerPort (CMD022 CreatePlan) -----------------------------------------------------------------------------------

export interface PlanCompilerPort {
  /** Compiles the audit's candidate decisions into a plan body under the candidate/field/effect permissions (D8-PLAN-1). */
  compile(candidateDecisions: unknown, current: PlanBody | null): Promise<PatchCompilation>;
}
