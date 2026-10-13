/**
 * MigrationCoreAdapter — the real thin adapter of the Migration Core 3.0.0 behind the platform ports (B05 D5-2..D5-10; S045).
 * Implements ExecutionEnvelopePort, ProfilePort, ValidatePort and PackageVerifierPort with evidence class EXECUTED_LOCAL.
 *
 * Execute, in order: E0 guard and directories -> E1 materialize the revision's sealed generations (reserved at their declared
 * length, cut past it, digest verified) -> E2 the core child under the permission model and the metered fs (loadConfig, run,
 * writePackage, verifyPackage(stagingDir), promotePackage) -> E3/E4 the parent re-hashes every package file and stages each one
 * through the ArtifactWriter -> E5 removes the call directory. One deadline fixed at entry; every await raced; the child is
 * SIGKILLed at the deadline, on CANCELLED or FENCED; late results are dropped. The adapter never sets attestationPolicy.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Id, RowCounts, Sha256Hex } from "@kauro/contracts";
import type {
  CancellationChannel,
  CoreCallControls,
  CoreDocumentPort,
  CoreEvidenceClass,
  CoreInputRef,
  CoreInputResolver,
  CoreRefusal,
  ExecutionEnvelopePort,
  ExecutionLimits,
  ExecutionOutcome,
  ExecutionSubject,
  ExecutionTerminalCause,
  ExpectedAuthority,
  HostIo,
  PackageCandidate,
  PackageVerificationResult,
  PackageVerifierPort,
  ProfilePort,
  ProfileRequest,
  ProfileResult,
  SourceReader,
  StagedArtifact,
  ValidatePort,
  ValidateRequest,
  ValidateResult,
} from "@kauro/application";
import { AttemptEnvelopeFailure } from "../attempt/failure.js";
import { ATTEMPT_SCRATCH_DIRECTORY_PREFIX, attemptScratchDirectoryOf } from "../attempt/scratch-store.js";
import { AttemptByteLedger } from "./attempt-byte-ledger.js";
import type { CoreChildHandle, CoreChildResult } from "./core-child-runner.js";
import { runCoreChild } from "./core-child-runner.js";
import type { CoreTaskPayload, CoreTaskRecord } from "./child-task.js";
import { Operation, OperationEnded, SYSTEM_TIMERS, type CoreTimers } from "./operation.js";

export const MIGRATION_CORE_VERSION = "3.0.0";
export const CORE_RUN_DIRECTORY = "kauro-core-run";
const CHILD_TASK = fileURLToPath(new URL("./child-task.js", import.meta.url));
const CRM_MODES = new Set(["HUBSPOT", "SALESFORCE"]);
const STAGE_CHUNK_BYTES = 1 << 20;

/** Test hooks (FaultPoints pattern): named holds in the parent and at the child's progress points. */
export interface CoreAdapterHooks {
  /** Awaited at a named parent point (E0, E1:open:k, E4:open:k, E4:close:k, ...). */
  at?(point: string): Promise<void> | void;
  /** Progress points the child is held at until `child` returns. */
  readonly childPausePoints?: readonly string[];
  child?(point: string, child: CoreChildHandle): Promise<void> | void;
  /** Replaces the call-directory removal (a failing removal must not replace the primary cause). */
  removeTree?(path: string): void;
}

export interface MigrationCoreAdapterOptions {
  readonly attemptId: Id;
  /** The root the host's AttemptScratchStore lives under. */
  readonly scratchRoot: string;
  readonly inputs: CoreInputResolver;
  readonly documents?: CoreDocumentPort;
  /** sha256 of the vendored kauro-migration-core tarball actually consumed (ValidationReceipt.corePackageHash). */
  readonly corePackageHash: Sha256Hex;
  readonly timers?: CoreTimers;
  readonly pollIntervalMs?: number;
  readonly heapMegabytes?: number;
  readonly hooks?: CoreAdapterHooks;
}

/** The platform target mode and the core's: one enum-only bridge (D5-7). */
export function coreTargetModeOf(platformMode: "CLEAN" | "CLEAN_ONLY" | "HUBSPOT" | "SALESFORCE"): "CLEAN_ONLY" | "HUBSPOT" | "SALESFORCE" {
  return platformMode === "CLEAN" ? "CLEAN_ONLY" : platformMode;
}

export function platformTargetModeOf(coreMode: string): "CLEAN" | "HUBSPOT" | "SALESFORCE" {
  if (coreMode === "CLEAN_ONLY") return "CLEAN";
  if (coreMode === "HUBSPOT" || coreMode === "SALESFORCE") return coreMode;
  throw new TypeError(`unknown core target mode ${coreMode}`);
}

/** The path of an input relative to the call's input directory (the core's input root) (D5-5): the generation is part of it, so identical bytes never share a path. */
export function coreInputPathOf(objectName: string, generation: string): string {
  const canonical = JSON.stringify({ domain: "KAURO_CORE_INPUT_PATH_V1", generation, objectName });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface Reconciliationish {
  readonly sourceRows: { readonly total: number; readonly byDisposition: Readonly<Record<string, number>>; readonly withoutDisposition: number };
  readonly associations: { readonly sourceEdges: number; readonly withoutDisposition: number };
}

/** ROWCOUNTS producer: the registry RowCounts of a core run (B13 mapping; billable units come from the frozen quote). */
export function rowCountsOf(input: { readonly reconciliation: Reconciliationish; readonly lineageRecordRows: number; readonly emittedArtifactRows: number; readonly billableSourceUnits: number }): RowCounts {
  const r = input.reconciliation;
  const d = r.sourceRows.byDisposition;
  return Object.freeze({
    physicalSourceRows: r.sourceRows.total,
    logicalSourceRecords: input.lineageRecordRows,
    billableSourceUnits: input.billableSourceUnits,
    associationEdges: r.associations.sourceEdges,
    emittedRepresentatives: d["OUTPUT"] ?? 0,
    mergedNonSurvivors: d["MERGED_PROVEN"] ?? 0,
    rejected: d["REJECTED_INPUT"] ?? 0,
    withheld: (d["ISOLATED"] ?? 0) + (d["LEFTOVER"] ?? 0),
    unresolved: r.sourceRows.withoutDisposition + r.associations.withoutDisposition,
    emittedArtifactRows: input.emittedArtifactRows,
  }) as RowCounts;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUtcMs(instant: string): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new TypeError(`not an instant: ${instant}`);
  return ms;
}

const ENVELOPE_AS_OUTCOME = new Set<string>(["SCRATCH_EXHAUSTED", "SHORT_WRITE", "CORRUPT_INTERMEDIATE", "CANCELLED", "FENCED"]);

/** Removes every call directory of an attempt's step scratch that is not live (a dead step's profile or validate scratch). */
export function removeOrphanStepScratch(root: string, attemptId: Id, isLive: (callId: string) => boolean): string[] {
  const runs = join(attemptScratchDirectoryOf(root, attemptId), CORE_RUN_DIRECTORY);
  if (!existsSync(runs)) return [];
  const removed: string[] = [];
  for (const callId of readdirSync(runs)) {
    if (isLive(callId)) continue;
    rmSync(join(runs, callId), { recursive: true, force: true });
    removed.push(callId);
  }
  return removed;
}

interface Call {
  readonly callId: string;
  readonly callDir: string;
  readonly inputRoot: string;
  readonly ledger: AttemptByteLedger;
}

export class MigrationCoreAdapter implements ExecutionEnvelopePort, ProfilePort, ValidatePort, PackageVerifierPort {
  readonly evidenceClass: CoreEvidenceClass = "EXECUTED_LOCAL";
  readonly coreVersion = MIGRATION_CORE_VERSION;
  get attemptId(): Id {
    return this.#o.attemptId;
  }
  readonly #o: MigrationCoreAdapterOptions;
  readonly #timers: CoreTimers;
  readonly #residual: string[] = [];

  constructor(options: MigrationCoreAdapterOptions) {
    this.#o = options;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
    attemptScratchDirectoryOf(options.scratchRoot, options.attemptId);
  }

  /** Directories whose removal failed (residual inventory); never replaces a primary terminal cause. */
  residualInventory(): readonly string[] {
    return [...this.#residual];
  }

  async #hold(point: string): Promise<void> {
    await this.#o.hooks?.at?.(point);
  }

  #attemptDir(): string {
    return attemptScratchDirectoryOf(this.#o.scratchRoot, this.#o.attemptId);
  }

  // --- E0 -------------------------------------------------------------------------------------------------------------------

  #openCall(callId: string, budget: number): Call {
    const attemptDir = this.#attemptDir();
    if (!existsSync(attemptDir)) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "ATTEMPT_SCRATCH_MISSING", `attempt ${this.#o.attemptId} has no scratch directory`);
    const runs = join(attemptDir, CORE_RUN_DIRECTORY);
    mkdirSync(runs, { recursive: true });
    const nominal = join(runs, callId);
    try {
      mkdirSync(nominal);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "ATTEMPT_SCRATCH_EXISTS", `attempt ${this.#o.attemptId} already has the core call ${callId}`);
      throw error;
    }
    // the permission model compares the path the child opens with its grants: grant the real path, never a short (8.3) alias
    const callDir = realpathSync.native(nominal);
    const inputRoot = join(callDir, "input");
    mkdirSync(inputRoot);
    return { callId, callDir, inputRoot, ledger: new AttemptByteLedger(budget) };
  }

  #cleanup(call: Call): void {
    try {
      if (this.#o.hooks?.removeTree !== undefined) this.#o.hooks.removeTree(call.callDir);
      else rmSync(call.callDir, { recursive: true, force: true });
      if (existsSync(call.callDir)) this.#residual.push(call.callDir);
    } catch {
      this.#residual.push(call.callDir);
    }
  }

  // --- E1 -------------------------------------------------------------------------------------------------------------------

  async #materialize(call: Call, op: Operation, source: SourceReader, refs: readonly CoreInputRef[], extraLive: () => number): Promise<void> {
    let k = 0;
    for (const ref of refs) {
      if (ref.byteLength === 0) continue;
      k += 1;
      await this.#hold(`E1:open:${k}`);
      op.assertLive();
      const handle = await op.race(source.open({ objectName: ref.objectName, generation: ref.generation }));
      if (handle.byteLength !== ref.byteLength || handle.sha256 !== ref.sha256) {
        throw new AttemptEnvelopeFailure("SOURCE_INTEGRITY_FAILED", "CAPABILITY_MISMATCH", `${ref.objectName}#${ref.generation} does not match the revision's seal`);
      }
      const path = join(call.inputRoot, coreInputPathOf(ref.objectName, ref.generation));
      mkdirSync(join(call.callDir, "input"), { recursive: true });
      try {
        call.ledger.chargeTo(path, ref.byteLength, extraLive());
      } catch {
        throw new AttemptEnvelopeFailure("SCRATCH_EXHAUSTED", "QUOTA", `input ${k} (${ref.byteLength} bytes) passes the scratch budget`);
      }
      const fd = openSync(path, "wx");
      const hash = createHash("sha256");
      let seen = 0;
      try {
        const iterator = handle.read()[Symbol.asyncIterator]();
        for (;;) {
          await this.#hold(`E1:chunk:${k}`);
          const next = await op.race(iterator.next());
          if (next.done === true) break;
          const chunk = next.value;
          if (seen + chunk.length > ref.byteLength) throw new AttemptEnvelopeFailure("SOURCE_INTEGRITY_FAILED", "LENGTH", `${ref.objectName}#${ref.generation} is longer than its seal`);
          writeSync(fd, chunk);
          seen += chunk.length;
          hash.update(chunk);
        }
      } finally {
        closeSync(fd);
      }
      if (seen !== ref.byteLength) throw new AttemptEnvelopeFailure("SOURCE_INTEGRITY_FAILED", "LENGTH", `${ref.objectName}#${ref.generation} is shorter than its seal`);
      if (hash.digest("hex") !== ref.sha256) throw new AttemptEnvelopeFailure("SOURCE_INTEGRITY_FAILED", "DIGEST", `${ref.objectName}#${ref.generation} does not match its seal`);
    }
  }

  /** The configuration the child loads: the plan's document with each file path rewritten to its input path (D5-2, D5-5). */
  #configFor(document: unknown, refs: readonly CoreInputRef[]): { original: string; run: string } {
    const config = JSON.parse(JSON.stringify(document)) as { files?: Array<Record<string, unknown>> };
    const byName = new Map(refs.map((r) => [r.objectName, r] as const));
    for (const file of config.files ?? []) {
      const ref = byName.get(String(file["path"]));
      if (ref === undefined) throw new RefusedBeforeRun("INPUT_NOT_IN_REVISION", `the configuration names ${String(file["path"])}, which the revision does not hold`);
      file["path"] = coreInputPathOf(ref.objectName, ref.generation);
      file["format"] = ref.readConfig.format;
      if (file["encoding"] === undefined || file["encoding"] === null) file["encoding"] = ref.readConfig.encoding;
      if (file["delimiter"] === undefined || file["delimiter"] === null) file["delimiter"] = ref.readConfig.delimiter;
      if (file["sheets"] === undefined || file["sheets"] === null) file["sheets"] = ref.readConfig.sheets === null ? null : [...ref.readConfig.sheets];
    }
    return { original: JSON.stringify(document), run: JSON.stringify(config) };
  }

  async #child(call: Call, op: Operation, payload: Omit<CoreTaskPayload, "runDir" | "verifyDir" | "packageDir" | "attemptId" | "inputRoot" | "quotaBytes">, quotaBytes: number): Promise<CoreChildResult> {
    if (quotaBytes <= 0) throw new AttemptEnvelopeFailure("SCRATCH_EXHAUSTED", "QUOTA", "no scratch budget is left for the core child");
    const full: CoreTaskPayload = {
      ...payload,
      inputRoot: call.inputRoot,
      runDir: join(call.callDir, "run"),
      verifyDir: join(call.callDir, "verify"),
      packageDir: join(call.callDir, "package"),
      attemptId: this.#o.attemptId,
      quotaBytes,
    };
    const hooks = this.#o.hooks;
    const running = runCoreChild({
      task: CHILD_TASK,
      payload: full,
      readPaths: [call.inputRoot],
      callDir: call.callDir,
      quotaBytes,
      heapMegabytes: this.#o.heapMegabytes ?? 1024,
      pausePoints: hooks?.childPausePoints ?? [],
      ...(hooks?.child === undefined ? {} : { onProgress: (point: string, child: CoreChildHandle) => hooks.child?.(point, child) }),
      signal: op.abort.signal,
    });
    try {
      return await op.race(running);
    } catch (error) {
      op.abort.abort();
      await running.catch(() => undefined);
      throw error;
    }
  }

  // --- execute --------------------------------------------------------------------------------------------------------------

  async execute(subject: ExecutionSubject, io: HostIo): Promise<ExecutionOutcome> {
    const timers = this.#timers;
    const startMs = timers.nowMs();
    const deadlineAt = Math.min(isUtcMs(subject.executionDeadlineAt), startMs + io.limits.wallClockMs);
    const terminal = (terminalCause: ExecutionTerminalCause, extra: { refusal?: CoreRefusal } = {}): ExecutionOutcome => ({
      evidenceClass: this.evidenceClass,
      coreVersion: this.coreVersion,
      terminalCause,
      ...extra,
      stagedArtifacts: [],
      reconciliationSummary: null,
      resourceMetrics: { peakMemoryBytes: 0, peakScratchBytes: 0, wallClockMs: timers.nowMs() - startMs },
    });
    if (subject.attemptId !== this.#o.attemptId) throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "NOT_THIS_ATTEMPT", "the subject is not this adapter's attempt");
    const op = new Operation(timers, deadlineAt, io.cancellation, this.#o.pollIntervalMs ?? 1000);
    let call: Call | null = null;
    try {
      await this.#hold("E0:cancellation");
      const first = await op.race(io.cancellation.check());
      if (first !== "CONTINUE") return terminal(first === "FENCED" ? "FENCED" : "CANCELLED");
      const mode = (subject.configDocument as { target?: { mode?: unknown } } | null)?.target?.mode;
      if (typeof mode === "string" && CRM_MODES.has(mode)) return terminal("REFUSED", { refusal: { code: "ATTESTATION_NOT_PROVIDED", message: `${mode} needs the subject's host attestation, which this subject does not carry` } });
      call = this.#openCall("execute", io.limits.scratchBudgetBytes);
      await this.#hold("E0");
      const live = (): number => io.scratch.usage().bytes;
      const refs = await op.race(this.#o.inputs.resolve(subject.revisionHash));
      let configText: { original: string; run: string };
      try {
        configText = this.#configFor(subject.configDocument, refs);
      } catch (error) {
        if (error instanceof RefusedBeforeRun) return terminal("REFUSED", { refusal: { code: error.code, message: error.message } });
        throw error;
      }
      await this.#materialize(call, op, io.source, refs, live);
      op.assertLive();
      await this.#hold("E2");
      const inputBytes = call.ledger.live;
      const quota = io.limits.scratchBudgetBytes - call.ledger.live - live();
      const res = await this.#child(call, op, { mode: "execute", configText: configText.original, runConfigText: configText.run, expectedConfigHash: subject.configHash, profileFiles: [] }, quota);
      const record = this.#recordOf(res);
      if (record.kind === "REFUSED") return terminal("REFUSED", { refusal: record.refusal });
      if (record.kind === "ENVELOPE") return terminal(record.cause);
      if (record.value.kind === "CONFIG_MISMATCH") return terminal("REFUSED", { refusal: { code: "CONFIG_BINDING_MISMATCH", message: "the configuration does not hash to the plan's bound coreConfigHash" } });
      if (record.value.kind === "CORRUPT") return terminal("CORRUPT_INTERMEDIATE");
      if (record.value.kind !== "PACKAGE") throw new Error("the core child answered no package");
      const pkg = record.value;
      call.ledger.adopt(pkg.residual);
      // inputs are deleted before staging (release order, D5-2c (3))
      rmSync(call.inputRoot, { recursive: true, force: true });
      call.ledger.creditTree(call.inputRoot);
      await this.#hold("E3");
      op.assertLive();
      const staged = await this.#stage(call, op, io, pkg);
      if (staged === "CORRUPT") return terminal("CORRUPT_INTERMEDIATE");
      return {
        evidenceClass: this.evidenceClass,
        coreVersion: this.coreVersion,
        terminalCause: "COMPLETED",
        stagedArtifacts: staged,
        reconciliationSummary: pkg.reconciliation,
        resourceMetrics: { peakMemoryBytes: pkg.maxRssBytes, peakScratchBytes: Math.max(call.ledger.peak, inputBytes + pkg.peakLedgerBytes), wallClockMs: timers.nowMs() - startMs },
      };
    } catch (error) {
      if (error instanceof OperationEnded) return terminal(error.reason);
      if (error instanceof AttemptEnvelopeFailure && ENVELOPE_AS_OUTCOME.has(error.terminalCause)) return terminal(error.terminalCause as ExecutionTerminalCause);
      throw error;
    } finally {
      op.close();
      if (call !== null) this.#cleanup(call);
    }
  }

  /** Maps the child's record or failure to a refusal, an envelope cause, or its value; anything else rejects. */
  #recordOf(res: CoreChildResult): { kind: "VALUE"; value: CoreTaskRecord } | { kind: "REFUSED"; refusal: CoreRefusal } | { kind: "ENVELOPE"; cause: ExecutionTerminalCause } {
    const outcome = res.outcome;
    if (outcome === undefined) {
      if (res.memoryExhausted) throw new Error("CORE_CHILD_OUT_OF_MEMORY");
      throw new Error("CORE_CHILD_LOST");
    }
    if (outcome.ok) return { kind: "VALUE", value: outcome.value as CoreTaskRecord };
    const error = outcome.error;
    if (error.code === "OUTSIDE_CAPABILITY" || error.code === "ERR_ACCESS_DENIED") throw new AttemptEnvelopeFailure("OUTSIDE_CAPABILITY", "CHILD_FS", `the core child reached outside its capability: ${error.message}`);
    if (error.code === "ENOSPC") return { kind: "ENVELOPE", cause: "SCRATCH_EXHAUSTED" };
    if (error.name === "AttemptEnvelopeFailure") {
      const cause = /^(\w+) \(/.exec(error.message)?.[1];
      if (cause === "SCRATCH_EXHAUSTED" || cause === "SHORT_WRITE" || cause === "CORRUPT_INTERMEDIATE") return { kind: "ENVELOPE", cause };
    }
    if (error.name === "MigrationError") {
      if (error.code === "SCRATCH_QUOTA_EXCEEDED") return { kind: "ENVELOPE", cause: "SCRATCH_EXHAUSTED" };
      return { kind: "REFUSED", refusal: { code: error.code ?? "MIGRATION_ERROR", message: error.message } };
    }
    throw new Error(`the core child failed: ${error.name}${error.code === undefined ? "" : ` ${error.code}`}`);
  }

  // --- E3/E4 ----------------------------------------------------------------------------------------------------------------

  async #stage(call: Call, op: Operation, io: HostIo, pkg: Extract<CoreTaskRecord, { kind: "PACKAGE" }>): Promise<readonly StagedArtifact[] | "CORRUPT"> {
    const files = listFiles(pkg.packageDir);
    const expected = new Map(pkg.artifacts.map((a) => [a.path, a] as const));
    const hashes = new Map<string, { sha256: string; byteLength: number }>();
    // preflight: every file is re-hashed before anything is staged; a mismatch stages nothing
    for (const file of files) {
      op.assertLive();
      const digest = hashFile(join(pkg.packageDir, file));
      const claim = expected.get(file);
      if (claim !== undefined && (claim.sha256 !== digest.sha256 || claim.byteLength !== digest.byteLength)) return "CORRUPT";
      if (file === "manifest.json" && digest.sha256 !== pkg.manifestSha256) return "CORRUPT";
      hashes.set(file, digest);
    }
    const remaining = new Map(files.map((f) => [f, hashes.get(f)?.byteLength ?? 0] as const));
    const budget = io.limits.scratchBudgetBytes;
    const staged: StagedArtifact[] = [];
    let k = 0;
    for (const file of files) {
      k += 1;
      await this.#hold(`E4:open:${k}`);
      op.assertLive();
      const digest = hashes.get(file);
      if (digest === undefined) continue;
      const parentLive = call.ledger.live + io.scratch.usage().bytes;
      if (parentLive + digest.byteLength > budget) throw new AttemptEnvelopeFailure("SCRATCH_EXHAUSTED", "SPOOL", `spooling ${file} (${digest.byteLength} bytes) passes the scratch budget`);
      const handle = io.writer.open(roleOf(file), sha256Hex(file));
      const fd = openSync(join(pkg.packageDir, file), "r");
      try {
        const buffer = Buffer.allocUnsafe(Math.min(STAGE_CHUNK_BYTES, Math.max(1, digest.byteLength)));
        for (;;) {
          const n = readSync(fd, buffer, 0, buffer.length, null);
          if (n === 0) break;
          await op.race(handle.write(Uint8Array.prototype.slice.call(buffer, 0, n)));
        }
      } finally {
        closeSync(fd);
      }
      await this.#hold(`E4:close:${k}`);
      op.assertLive();
      const artifact = await op.race(handle.close());
      staged.push(artifact);
      if (artifact.byteLength < digest.byteLength) throw new AttemptEnvelopeFailure("SHORT_WRITE", "STAGED_SHORT", `${file} staged ${artifact.byteLength} of ${digest.byteLength} bytes`);
      if (artifact.byteLength !== digest.byteLength || artifact.sha256 !== digest.sha256) throw new AttemptEnvelopeFailure("CORRUPT_INTERMEDIATE", "STAGED_DIGEST", `${file} staged other bytes than the package holds`);
      const path = join(pkg.packageDir, file);
      rmSync(path, { force: true });
      call.ledger.creditTree(path);
      remaining.delete(file);
    }
    return staged;
  }

  // --- profile --------------------------------------------------------------------------------------------------------------

  async profile(request: ProfileRequest): Promise<ProfileResult> {
    const rejected = (): ProfileResult => ({ evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "REJECTED", profileHash: null, profileDocument: null });
    const op = new Operation(this.#timers, this.#timers.nowMs() + request.limits.wallClockMs, request.cancellation, this.#o.pollIntervalMs ?? 1000);
    let call: Call | null = null;
    try {
      const first = await op.race(request.cancellation.check());
      if (first !== "CONTINUE") return { ...rejected(), outcome: "CANCELLED" };
      call = this.#openCall(`profile-${randomUUID()}`, request.limits.scratchBudgetBytes);
      const live = (): number => request.scratch.usage().bytes;
      const refs = await op.race(this.#o.inputs.resolve(request.revisionHash));
      await this.#materialize(call, op, request.source, refs, live);
      const files = refs.filter((r) => r.byteLength > 0).map((r) => ({ path: coreInputPathOf(r.objectName, r.generation), format: r.readConfig.format }));
      const res = await this.#child(call, op, { mode: "profile", configText: "", expectedConfigHash: null, profileFiles: files }, request.limits.scratchBudgetBytes - call.ledger.live - live());
      const record = this.#recordOf(res);
      if (record.kind === "REFUSED") return rejected();
      if (record.kind === "ENVELOPE") throw new AttemptEnvelopeFailure(record.cause === "SCRATCH_EXHAUSTED" ? "SCRATCH_EXHAUSTED" : "CORRUPT_INTERMEDIATE", "PROFILE", "the profile child failed");
      if (record.value.kind !== "PROFILE") throw new Error("the core child answered no profile");
      const parsed = JSON.parse(record.value.profileText) as { profile?: unknown };
      return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "PROFILED", profileHash: record.value.profileHash, profileDocument: parsed.profile ?? parsed };
    } catch (error) {
      if (error instanceof OperationEnded) {
        if (error.reason === "DEADLINE_EXCEEDED") throw error;
        return { ...rejected(), outcome: "CANCELLED" };
      }
      throw error;
    } finally {
      op.close();
      if (call !== null) this.#cleanup(call);
    }
  }

  // --- validate -------------------------------------------------------------------------------------------------------------

  async validate(request: ValidateRequest): Promise<ValidateResult> {
    const controls = request.controls;
    if (controls === undefined || controls.source === undefined || controls.billableSourceUnits === undefined) throw new TypeError("validate needs controls (limits, source, billableSourceUnits)");
    if (this.#o.documents === undefined) throw new TypeError("validate needs the plan binding store");
    const error = (problem: string): ValidateResult => ({ evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "ERROR", receipt: null, problems: [problem] });
    const deadline = controls.deadlineAt !== undefined ? isUtcMs(controls.deadlineAt) : this.#timers.nowMs() + controls.limits.wallClockMs;
    const op = new Operation(this.#timers, deadline, request.cancellation, this.#o.pollIntervalMs ?? 1000);
    let call: Call | null = null;
    try {
      const binding = await op.race(this.#o.documents.planBinding(request.planHash));
      if (binding === null) return error("PLAN_BINDING_MISSING");
      call = this.#openCall(`validate-${randomUUID()}`, controls.limits.scratchBudgetBytes);
      const live = (): number => request.scratch.usage().bytes;
      const refs = await op.race(this.#o.inputs.resolve(request.revisionHash));
      let configText: { original: string; run: string };
      try {
        configText = this.#configFor(binding.configDocument, refs);
      } catch (e) {
        if (e instanceof RefusedBeforeRun) return error(e.code);
        throw e;
      }
      await this.#materialize(call, op, controls.source, refs, live);
      const res = await this.#child(call, op, { mode: "validate", configText: configText.original, runConfigText: configText.run, expectedConfigHash: binding.coreConfigHash, profileFiles: [] }, controls.limits.scratchBudgetBytes - call.ledger.live - live());
      const record = this.#recordOf(res);
      if (record.kind === "REFUSED") return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "INVALID", receipt: null, problems: [record.refusal.code] };
      if (record.kind === "ENVELOPE") throw new AttemptEnvelopeFailure(record.cause === "SCRATCH_EXHAUSTED" ? "SCRATCH_EXHAUSTED" : "CORRUPT_INTERMEDIATE", "VALIDATE", "the validation child failed");
      const value = record.value;
      if (value.kind === "CONFIG_MISMATCH") return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "INVALID", receipt: null, problems: ["CONFIG_BINDING_MISMATCH"] };
      if (value.kind === "CORRUPT") return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, outcome: "INVALID", receipt: null, problems: [...value.problems] };
      if (value.kind !== "PACKAGE" || value.profileHash === null) throw new Error("the core child answered no validated package");
      const reconciliationArtifact = value.artifacts.find((a) => a.path.endsWith("reconciliation.json"));
      if (reconciliationArtifact === undefined) throw new Error("the package holds no reconciliation");
      return {
        evidenceClass: this.evidenceClass,
        coreVersion: this.coreVersion,
        outcome: "VALID",
        receipt: {
          revisionHash: request.revisionHash,
          targetContractHash: request.targetContractHash,
          planHash: request.planHash,
          corePackageHash: this.#o.corePackageHash,
          profileEvidenceHash: value.profileHash,
          dispositionEvidenceHash: reconciliationArtifact.sha256,
          artifactEvidenceHash: value.manifestSha256,
          counts: rowCountsOf({ reconciliation: value.reconciliation as unknown as Reconciliationish, lineageRecordRows: value.lineageRecordRows, emittedArtifactRows: value.emittedArtifactRows, billableSourceUnits: controls.billableSourceUnits }),
        },
        problems: [],
      };
    } catch (e) {
      if (e instanceof OperationEnded) {
        if (e.reason === "DEADLINE_EXCEEDED") throw e;
        return error(e.reason);
      }
      throw e;
    } finally {
      op.close();
      if (call !== null) this.#cleanup(call);
    }
  }

  // --- verify ---------------------------------------------------------------------------------------------------------------

  async verify(candidate: PackageCandidate, expected: ExpectedAuthority, controls?: CoreCallControls): Promise<PackageVerificationResult> {
    if (controls === undefined) throw new TypeError("verify needs controls (limits)");
    const deadline = controls.deadlineAt !== undefined ? isUtcMs(controls.deadlineAt) : this.#timers.nowMs() + controls.limits.wallClockMs;
    const op = new Operation(this.#timers, deadline, controls.cancellation ?? null, this.#o.pollIntervalMs ?? 1000);
    try {
      const keyOf = (a: StagedArtifact): string => `${a.role}:${a.objectName}:${a.generation}`;
      const wanted = new Map(expected.requiredArtifacts.map((a) => [keyOf(a), a] as const));
      const seen = new Set<string>();
      const problems: string[] = [];
      for (const artifact of candidate.artifacts) {
        const key = keyOf(artifact);
        if (seen.has(key)) {
          problems.push(`DUPLICATE_ARTIFACT:${key}`);
          continue;
        }
        seen.add(key);
        const w = wanted.get(key);
        if (w === undefined) {
          problems.push(`EXTRA_ARTIFACT:${key}`);
          continue;
        }
        if (w.sha256 !== artifact.sha256 || w.byteLength !== artifact.byteLength) problems.push(`FOREIGN_ARTIFACT:${key}`);
        else if (controls.readArtifact !== undefined) {
          const digest = createHash("sha256");
          let bytes = 0;
          const iterator = controls.readArtifact(artifact)[Symbol.asyncIterator]();
          for (;;) {
            const next = await op.race(iterator.next());
            if (next.done === true) break;
            digest.update(next.value);
            bytes += next.value.length;
          }
          if (bytes !== artifact.byteLength || digest.digest("hex") !== artifact.sha256) problems.push(`FOREIGN_ARTIFACT:${key}`);
        }
      }
      for (const key of wanted.keys()) if (!seen.has(key)) problems.push(`MISSING_ARTIFACT:${key}`);
      const declared = candidate.declaredSummary as { readonly ok?: unknown } | null;
      if (declared !== null && declared?.ok === true && problems.length > 0) problems.push("FALSE_SUMMARY");
      return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, verdict: problems.length === 0 ? "VALID" : "INVALID", problems };
    } catch (e) {
      if (e instanceof OperationEnded) {
        if (e.reason === "DEADLINE_EXCEEDED") throw e;
        return { evidenceClass: this.evidenceClass, coreVersion: this.coreVersion, verdict: "ERROR", problems: [e.reason] };
      }
      throw e;
    } finally {
      op.close();
    }
  }
}

class RefusedBeforeRun extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function roleOf(file: string): string {
  if (file === "manifest.json") return "package-manifest";
  const area = file.split("/")[0] ?? "";
  const map: Record<string, string> = { "01_IMPORT": "import", "02_EXCEPTIONS": "exceptions", "03_TRACEABILITY": "traceability", "04_DOCUMENTATION": "documentation" };
  return map[area] ?? "package-file";
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(p.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return out;
}

function hashFile(path: string): { sha256: string; byteLength: number } {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(STAGE_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
      total += n;
    }
    return { sha256: hash.digest("hex"), byteLength: total };
  } finally {
    closeSync(fd);
  }
}

export { ATTEMPT_SCRATCH_DIRECTORY_PREFIX };
export type { CancellationChannel, ExecutionLimits };
