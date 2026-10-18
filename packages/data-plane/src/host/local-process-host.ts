/**
 * LocalProcessWorkerHost — the real local executor of B14-A (docs/design/B14-A-worker-executor.md): a `WorkerHostPort` that runs each
 * processing attempt as one isolated worker process on this machine. EXECUTED_LOCAL: real processes, the real cores and browser; never
 * a cloud provider (EXECUTED_PROVIDER belongs to the cloud host alone).
 *
 * Identity and creation (D8-HOST-1). One provider job per `kauro-attempt-<attemptId>` for good: the create is the exclusive creation of
 * the job's directory under the host root, so a second launch of the same identity — a redelivery, a retry after a lost answer, a second
 * host over the same root — finds it and answers ALREADY_EXISTS (adopt), and nothing ever runs twice. The directory holds the job's
 * durable record, so `observe`, `terminate` and `resources` answer by identity after the host itself restarted. A launch that throws
 * created nothing or created exactly one job; `observe` tells which, and the creation horizon (default 60 s) bounds how long a create
 * could still land after a lost answer (here: never, once `launch` has returned or thrown).
 *
 * The worker's confinement (§4, §5):
 *   - a closed ticket (KAURO_ATTEMPT_TICKET_V1) built here from the control plane's records, sent over the child's private IPC
 *     channel, whose SHA-256 the worker is started with;
 *   - no credential: an empty environment (SystemRoot on Windows only); no database connection; every object through the attempt's
 *     storage broker, which admits exactly the capability (sealed generations read, own staging prefix written);
 *   - the Node permission model: read the code roots, the browser's directory and the attempt's own scratch directory; write that
 *     directory only; child processes allowed (the core's isolated child and the sandboxed browser); the network entry points refused;
 *   - limits: the worker's heap and the core child's heap (their sum with the browser's reserve inside the attempt's hard memory), the
 *     scratch quota (AttemptScratchStore), the execution deadline and wall clock, past which the host kills the tree.
 * Termination kills the worker's whole tree (process-tree.ts) and revokes the broker before anything else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  attemptCapabilityProblems,
  attemptIdentityOf,
  isAttemptIdentity,
  type CoreInputRef,
  type CorePlanBinding,
  type ObjectStoragePort,
  type ResumableUploadPort,
  type WorkerFailureCause,
  type WorkerHostEvidenceClass,
  type WorkerHostPort,
  type WorkerLaunchResult,
  type WorkerLaunchSpec,
  type WorkerManifestReference,
  type WorkerObservation,
  type WorkerObservedState,
  type WorkerResourceReport,
  type WorkerResources,
  type WorkerTerminationResult,
} from "@kauro/application";
import type { Clock } from "@kauro/domain";
import { attemptScratchDirectoryOf } from "../attempt/scratch-store.js";
import type { AuthorizedReportInputs } from "../report/facts.js";
import type { ReportRenderConfig } from "../report/stage.js";
import { SANDBOX_CODE_ROOT } from "../sandbox/runner.js";
import { AttemptStorageBroker, callErrorOf } from "./broker.js";
import { killProcessTree } from "./process-tree.js";
import { WORKER_PROTOCOL_VERSION, type HostMessage, type WorkerCall, type WorkerMessage, type WorkerResultReport, type WorkerStage } from "./protocol.js";
import { attemptTicketBytesOf, attemptTicketDigestOf, attemptTicketProblems, executionLimitsProblems, type AttemptTicket } from "./ticket.js";

export const LOCAL_PROCESS_HOST = "kauro-local-process-host";
export const LOCAL_PROCESS_MACHINE_TYPE = "local-process";
const EVIDENCE: WorkerHostEvidenceClass = "EXECUTED_LOCAL";
const NETWORK_PRELOAD = join(SANDBOX_CODE_ROOT, "sandbox", "preload.js");
const MIB = 1024 * 1024;

/** What the control plane reads for one launch (its records, never decided here; a missing record is null). */
export interface AttemptTicketReads {
  readonly planBinding: CorePlanBinding | null;
  readonly inputs: readonly CoreInputRef[];
  readonly reportInputs: AuthorizedReportInputs | null;
}

export interface AttemptTicketSource {
  /** Reads the records of one launch spec's attempt. Throws only on an infrastructure failure. */
  read(spec: WorkerLaunchSpec): Promise<AttemptTicketReads>;
}

export interface LocalProcessHostHooks {
  /** Awaited before the host answers a worker's stage report (a test's hold point; never bound by a deployment). */
  atStage?(identity: string, stage: WorkerStage): Promise<void> | void;
  /** Awaited before the broker answers a worker's storage call. */
  beforeCall?(identity: string, call: WorkerCall): Promise<void> | void;
}

export interface LocalProcessWorkerHostOptions {
  /** The worker's entry module (the @kauro/migration-worker main, or a container image's). */
  readonly workerEntry: string;
  /** The code the worker may read (the workspace or the image's application directory). Never holds the host's or scratch roots. */
  readonly codeRoots: readonly string[];
  /** The host's durable job records. */
  readonly hostRoot: string;
  /** The attempts' scratch (the control plane's `workerScratchRoot`, which STAGING_JANITOR cleans). */
  readonly scratchRoot: string;
  readonly chromiumExecutable: string;
  readonly storage: ObjectStoragePort;
  readonly uploads: ResumableUploadPort;
  readonly tickets: AttemptTicketSource;
  readonly render: ReportRenderConfig;
  readonly corePackageHash: Sha256Hex;
  /** The host's clock (deadlines, heartbeats, runtimes); the composition's injected one. */
  readonly clock: Clock;
  /** The origin every session the broker opens is bound to. */
  readonly sessionOrigin: string;
  readonly creationHorizonSeconds?: number;
  readonly workerHeapMegabytes?: number;
  readonly coreHeapMegabytes?: number;
  /** Memory kept for the browser beside the two heaps (default 1 GiB). */
  readonly browserReserveBytes?: number;
  /** The host's own cap on one attempt's wall clock (default: the attempt's limits alone). */
  readonly maxWallClockMs?: number;
  /** How long past the deadline the host waits for the worker's own end before it kills the tree (default 5 s). */
  readonly terminationGraceMs?: number;
  readonly hooks?: LocalProcessHostHooks;
}

type RecordState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TERMINATED";

/** The durable record of one provider job (the host's, under its directory; ids, tokens, instants and sizes only). */
export interface LocalJobRecord {
  readonly host: typeof LOCAL_PROCESS_HOST;
  readonly identity: string;
  readonly ticketDigest: Sha256Hex;
  readonly instance: string;
  state: RecordState;
  pid: number | null;
  createdAtMs: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  lastHeartbeatMs: number | null;
  cause: WorkerFailureCause | null;
  /** Why the host ended the job, when it did (TERMINATED_BY_HOST, DEADLINE, HOST_RESTARTED, NO_RESULT, MEMORY_EXHAUSTED, ...). */
  note: string | null;
  manifest: WorkerManifestReference | null;
  refusal: string | null;
  peakScratchBytes: number;
  peakMemoryBytes: number;
  readonly flags: readonly string[];
  readonly hardMemoryBytes: number;
  readonly hardScratchBytes: number;
}

interface Live {
  readonly record: LocalJobRecord;
  readonly child: ChildProcess;
  readonly broker: AttemptStorageBroker;
  result: WorkerResultReport | null;
  ended: "TERMINATED" | "DEADLINE" | null;
  stderrTail: string;
  readonly settled: Promise<void>;
  timer: NodeJS.Timeout | null;
}

const TERMINAL: ReadonlySet<RecordState> = new Set(["SUCCEEDED", "FAILED", "TERMINATED"]);

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function writeAtomically(path: string, bytes: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

export class LocalProcessWorkerHost implements WorkerHostPort {
  readonly evidenceClass: WorkerHostEvidenceClass = EVIDENCE;
  readonly host = LOCAL_PROCESS_HOST;
  readonly creationHorizonSeconds: number;
  /** This host instance (a restarted host is another instance over the same root). */
  readonly instance: string;
  readonly #o: LocalProcessWorkerHostOptions;
  readonly #codeRoots: readonly string[];
  readonly #hostRoot: string;
  readonly #scratchRoot: string;
  readonly #live = new Map<string, Live>();
  readonly #workerHeap: number;
  readonly #coreHeap: number;
  readonly #browserReserve: number;

  /** Refuses an incomplete or unsafe configuration before any attempt can be launched (B14-A §5). */
  constructor(options: LocalProcessWorkerHostOptions) {
    const problems: string[] = [];
    for (const [name, path] of [["workerEntry", options.workerEntry], ["chromiumExecutable", options.chromiumExecutable], ["hostRoot", options.hostRoot], ["scratchRoot", options.scratchRoot]] as const) {
      if (typeof path !== "string" || !isAbsolute(path)) problems.push(`${name} is not an absolute path`);
    }
    if (!Array.isArray(options.codeRoots) || options.codeRoots.length === 0 || !options.codeRoots.every((p) => typeof p === "string" && isAbsolute(p) && existsSync(p))) problems.push("codeRoots are not existing absolute paths");
    if (problems.length === 0 && !existsSync(options.workerEntry)) problems.push("the worker entry does not exist");
    if (problems.length === 0 && !existsSync(options.chromiumExecutable)) problems.push("the browser executable does not exist");
    if (!/^https:\/\/[a-z0-9.-]+$/.test(options.sessionOrigin ?? "")) problems.push("sessionOrigin is not an https origin");
    if (typeof options.corePackageHash !== "string" || !/^[0-9a-f]{64}$/.test(options.corePackageHash)) problems.push("corePackageHash is not a SHA-256 hex digest");
    if (problems.length > 0) throw new TypeError(`${LOCAL_PROCESS_HOST}: ${problems.join("; ")}`);
    mkdirSync(join(options.hostRoot, "jobs"), { recursive: true });
    mkdirSync(options.scratchRoot, { recursive: true });
    this.#hostRoot = realpathSync.native(options.hostRoot);
    this.#scratchRoot = realpathSync.native(options.scratchRoot);
    this.#codeRoots = options.codeRoots.map((p) => realpathSync.native(p));
    // a worker reads its code roots: neither the host's records nor any attempt's scratch may be inside one, nor one inside the other
    for (const root of this.#codeRoots) {
      for (const [name, private_] of [["hostRoot", this.#hostRoot], ["scratchRoot", this.#scratchRoot]] as const) {
        if (isInside(root, private_) || isInside(private_, root)) throw new TypeError(`${LOCAL_PROCESS_HOST}: ${name} overlaps a code root the worker reads`);
      }
    }
    if (isInside(this.#hostRoot, this.#scratchRoot) || isInside(this.#scratchRoot, this.#hostRoot)) throw new TypeError(`${LOCAL_PROCESS_HOST}: hostRoot and scratchRoot overlap`);
    this.creationHorizonSeconds = options.creationHorizonSeconds ?? 60;
    if (!Number.isSafeInteger(this.creationHorizonSeconds) || this.creationHorizonSeconds < 1) throw new TypeError(`${LOCAL_PROCESS_HOST}: creationHorizonSeconds is a positive whole number`);
    this.#workerHeap = options.workerHeapMegabytes ?? 1024;
    this.#coreHeap = options.coreHeapMegabytes ?? 2048;
    this.#browserReserve = options.browserReserveBytes ?? 1024 * MIB;
    if (![this.#workerHeap, this.#coreHeap].every((n) => Number.isSafeInteger(n) && n >= 64) || !Number.isSafeInteger(this.#browserReserve) || this.#browserReserve < 0) throw new TypeError(`${LOCAL_PROCESS_HOST}: heap sizes are whole megabytes of at least 64`);
    this.#o = options;
    this.instance = `${options.clock.nowMs().toString(36)}-${process.pid}`;
  }

  // --- the port -----------------------------------------------------------------------------------------------------------------

  async launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchResult> {
    const identity = spec.identity;
    const answer = (outcome: WorkerLaunchResult["outcome"], reason: string | null): WorkerLaunchResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome, reason });
    const problem = this.#specProblem(spec);
    if (problem !== null) return answer("REFUSED", problem);
    const jobDir = this.#jobDir(identity);
    if (existsSync(jobDir)) return answer("ALREADY_EXISTS", null);

    // the control plane's records for this attempt, read before anything is created (a failed read creates nothing)
    const reads = await this.#o.tickets.read(spec);
    if (reads.planBinding === null) return answer("REFUSED", "PLAN_BINDING_MISSING");
    const ticket: AttemptTicket = {
      identity,
      fence: spec.fence,
      capability: spec.capability,
      subject: spec.subject,
      limits: spec.limits,
      planBinding: reads.planBinding,
      inputs: reads.inputs,
      reportInputs: reads.reportInputs,
      render: this.#o.render,
      corePackageHash: this.#o.corePackageHash,
      issuedAt: this.#o.clock.now(),
    };
    const [ticketProblem] = attemptTicketProblems(ticket);
    if (ticketProblem !== undefined) return answer("REFUSED", ticketProblem);
    const bytes = attemptTicketBytesOf(ticket);

    // the create: one directory per identity, for good
    try {
      mkdirSync(jobDir);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") return answer("ALREADY_EXISTS", null);
      throw error;
    }
    writeAtomically(join(jobDir, "ticket.json"), bytes);
    this.#start(spec, bytes);
    return answer("LAUNCHED", null);
  }

  observe(identity: string): Promise<WorkerObservation> {
    const record = this.#recordOf(identity);
    const observation: WorkerObservation = Object.freeze({
      evidenceClass: EVIDENCE,
      identity,
      state: record === null ? "NOT_FOUND" : (record.state as WorkerObservedState),
      lastHeartbeatAt: record?.lastHeartbeatMs == null ? null : this.#instant(record.lastHeartbeatMs),
      manifest: record?.manifest ?? null,
      cause: record?.cause ?? null,
      resources: record === null || record.startedAtMs === null ? null : this.#resourcesOf(record),
      observedAt: this.#o.clock.now(),
    });
    return Promise.resolve(observation);
  }

  async terminate(identity: string): Promise<WorkerTerminationResult> {
    const answer = (outcome: WorkerTerminationResult["outcome"]): WorkerTerminationResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome });
    const live = this.#live.get(identity);
    if (live !== undefined) {
      if (TERMINAL.has(live.record.state)) return answer("ALREADY_TERMINAL");
      await this.#end(live, "TERMINATED");
      return answer("TERMINATED");
    }
    const record = this.#recordOf(identity);
    if (record === null) return answer("NOT_FOUND");
    if (TERMINAL.has(record.state)) return answer("ALREADY_TERMINAL");
    // a job of an earlier host instance that never reported its end: its worker ended itself when that host's channel closed
    record.state = "TERMINATED";
    record.note = "TERMINATED_BY_HOST";
    record.endedAtMs = this.#o.clock.nowMs();
    this.#persist(record);
    return answer("TERMINATED");
  }

  resources(identity: string): Promise<WorkerResourceReport> {
    const record = this.#recordOf(identity);
    const report: WorkerResourceReport =
      record === null
        ? Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "NOT_FOUND" as const })
        : Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "REPORTED" as const, state: record.state as WorkerObservedState, resources: this.#resourcesOf(record) });
    return Promise.resolve(report);
  }

  // --- beyond the port ------------------------------------------------------------------------------------------------------------

  /** The host's mirror of the lease's cancellation into the worker's channel (D8-CANCEL-1; D8-CEX-7 has no port for it). */
  signal(identity: string, state: "CANCELLED" | "FENCED"): boolean {
    const live = this.#live.get(identity);
    if (live === undefined || !live.child.connected) return false;
    this.#send(live, { t: "signal", state });
    return true;
  }

  /** Resolves when the worker of `identity` has exited (tests; a deployment observes). */
  async settled(identity: string): Promise<LocalJobRecord | null> {
    await this.#live.get(identity)?.settled;
    return this.#recordOf(identity);
  }

  /** The durable record of `identity` (evidence and tests). */
  record(identity: string): LocalJobRecord | null {
    return this.#recordOf(identity);
  }

  /** The broker's refusals for a live or finished job of this instance (evidence: operation and token). */
  refusals(identity: string): readonly { readonly op: string; readonly code: string }[] {
    return this.#live.get(identity)?.broker.refusals() ?? [];
  }

  /** The last lines a worker of this instance wrote to its error stream (in memory only, never recorded: an operator's diagnostic). */
  diagnostics(identity: string): string | null {
    return this.#live.get(identity)?.stderrTail ?? null;
  }

  /** Every job this instance started and that is still running. */
  running(): readonly string[] {
    return [...this.#live.values()].filter((l) => !TERMINAL.has(l.record.state)).map((l) => l.record.identity);
  }

  /** Ends every running worker (shutdown); their records say TERMINATED. */
  async stop(): Promise<void> {
    for (const live of [...this.#live.values()]) if (!TERMINAL.has(live.record.state)) await this.#end(live, "TERMINATED");
  }

  /** The exact command line a worker of `spec` would run (evidence of the confinement). */
  flagsOf(spec: WorkerLaunchSpec, ticketDigest: Sha256Hex): string[] {
    const attemptDir = attemptScratchDirectoryOf(this.#scratchRoot, spec.capability.attemptId);
    const reads = [...this.#codeRoots, dirname(this.#o.chromiumExecutable), attemptDir];
    return [
      "--permission",
      ...reads.map((p) => `--allow-fs-read=${p}`),
      `--allow-fs-write=${attemptDir}`,
      "--allow-child-process",
      `--max-old-space-size=${this.#workerHeap}`,
      "--import",
      pathToFileURL(NETWORK_PRELOAD).href,
      this.#o.workerEntry,
      "--ticket-digest",
      ticketDigest,
      "--scratch-root",
      this.#scratchRoot,
      "--chromium",
      this.#o.chromiumExecutable,
      "--core-heap-mb",
      String(this.#coreHeap),
      "--storage-evidence",
      this.#o.storage.evidenceClass,
    ];
  }

  // --- internals ------------------------------------------------------------------------------------------------------------------

  #jobDir(identity: string): string {
    return join(this.#hostRoot, "jobs", identity);
  }

  #instant(ms: number): UtcInstant {
    return new Date(ms).toISOString() as UtcInstant;
  }

  /** Why a spec is not one attempt's own, complete and within this host's means (null when it is). */
  #specProblem(spec: WorkerLaunchSpec): string | null {
    const { capability, subject, limits } = spec;
    if (!isAttemptIdentity(spec.identity) || spec.identity !== capability.identity || spec.identity !== attemptIdentityOf(subject.attemptId)) return "IDENTITY_NOT_THE_ATTEMPTS";
    const [capabilityProblem] = attemptCapabilityProblems(capability);
    if (capabilityProblem !== undefined) return `CAPABILITY_${capabilityProblem}`;
    if (subject.jobId !== capability.jobId || subject.agencyId !== capability.agencyId || subject.projectId !== capability.projectId) return "SUBJECT_NOT_THE_CAPABILITYS";
    if (!Number.isSafeInteger(spec.fence) || spec.fence < 1) return "FENCE_MALFORMED";
    const [limitsProblem] = executionLimitsProblems(limits);
    if (limitsProblem !== undefined) return limitsProblem;
    if ((this.#workerHeap + this.#coreHeap) * MIB + this.#browserReserve > limits.hardMemoryBytes) return "MEMORY_PLAN_PAST_HARD_LIMIT";
    if (!Number.isFinite(Date.parse(subject.executionDeadlineAt))) return "DEADLINE_MISSING";
    return null;
  }

  #start(spec: WorkerLaunchSpec, bytes: Uint8Array): void {
    const identity = spec.identity;
    const digest = attemptTicketDigestOf(bytes);
    const flags = this.flagsOf(spec, digest);
    const now = this.#o.clock.nowMs();
    const record: LocalJobRecord = {
      host: LOCAL_PROCESS_HOST,
      identity,
      ticketDigest: digest,
      instance: this.instance,
      state: "QUEUED",
      pid: null,
      createdAtMs: now,
      startedAtMs: null,
      endedAtMs: null,
      lastHeartbeatMs: null,
      cause: null,
      note: null,
      manifest: null,
      refusal: null,
      peakScratchBytes: 0,
      peakMemoryBytes: 0,
      flags,
      hardMemoryBytes: spec.limits.hardMemoryBytes,
      hardScratchBytes: spec.limits.hardScratchBytes,
    };
    this.#persist(record);
    const env: Record<string, string> = {};
    // Windows resolves its system libraries through SystemRoot; nothing else of the host's environment reaches the worker
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
    // the attempt's directory exists before the worker starts: the permission model grants a directory's contents only to a path that
    // is a directory when the process starts (the worker's scratch store then empties and re-creates it)
    const attemptDir = attemptScratchDirectoryOf(this.#scratchRoot, spec.capability.attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const child = spawn(process.execPath, flags, {
      // the scratch root, which the worker cannot read: on Windows a process's working directory cannot be removed, and the worker
      // removes its attempt's directory when the attempt ends
      cwd: this.#scratchRoot,
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "advanced",
      // POSIX: the worker leads its own process group, so its tree can be ended even after a re-parenting (process-tree.ts)
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const broker = new AttemptStorageBroker({ capability: spec.capability, storage: this.#o.storage, uploads: this.#o.uploads, origin: this.#o.sessionOrigin, maxObjectBytes: spec.limits.hardScratchBytes });
    let exited: () => void = () => undefined;
    const live: Live = { record, child, broker, result: null, ended: null, stderrTail: "", settled: new Promise<void>((resolve) => (exited = resolve)), timer: null };
    this.#live.set(identity, live);
    record.pid = child.pid ?? null;
    record.state = "RUNNING";
    record.startedAtMs = this.#o.clock.nowMs();
    record.lastHeartbeatMs = record.startedAtMs;
    this.#persist(record);

    child.stderr?.on("data", (chunk: Buffer) => {
      live.stderrTail = (live.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("message", (message: WorkerMessage) => void this.#onMessage(live, message));
    child.on("error", () => {
      // a spawn that failed: the exit below records it (no result)
    });
    child.on("exit", () => {
      if (live.timer !== null) clearTimeout(live.timer);
      void broker.revoke("WORKER_EXITED").finally(() => {
        this.#closeRecord(live);
        exited();
      });
    });
    if (child.pid === undefined) {
      record.state = "FAILED";
      record.cause = "WORKER_ERROR";
      record.note = "SPAWN_FAILED";
      record.endedAtMs = this.#o.clock.nowMs();
      this.#persist(record);
    }

    // the deadline: the earlier of the execution deadline and the wall clock, then a grace for the worker's own end
    const wall = Math.min(spec.limits.wallClockMs, this.#o.maxWallClockMs ?? Number.MAX_SAFE_INTEGER);
    const until = Math.min(Date.parse(spec.subject.executionDeadlineAt) - this.#o.clock.nowMs(), wall) + (this.#o.terminationGraceMs ?? 5_000);
    live.timer = setTimeout(() => void this.#end(live, "DEADLINE"), Math.max(0, Math.min(until, 2_147_483_647)));
    live.timer.unref();
    this.#send(live, { t: "ticket", protocol: WORKER_PROTOCOL_VERSION, bytes });
  }

  #send(live: Live, message: HostMessage): void {
    if (!live.child.connected) return;
    try {
      live.child.send(message);
    } catch {
      // the worker is gone; its exit records it
    }
  }

  async #onMessage(live: Live, message: WorkerMessage): Promise<void> {
    if (message === null || typeof message !== "object") return;
    const record = live.record;
    if (message.t === "beat") {
      record.lastHeartbeatMs = this.#o.clock.nowMs();
      return;
    }
    if (message.t === "result") {
      if (live.result === null) live.result = message.result;
      return;
    }
    if (message.t !== "call" || typeof message.id !== "number") return;
    record.lastHeartbeatMs = this.#o.clock.nowMs();
    const call = message.call;
    try {
      let value: unknown = null;
      if (call?.op === "stage") await this.#o.hooks?.atStage?.(record.identity, call.stage);
      else {
        await this.#o.hooks?.beforeCall?.(record.identity, call);
        value = await live.broker.handle(call);
      }
      this.#send(live, { t: "reply", id: message.id, ok: true, value });
    } catch (error) {
      this.#send(live, { t: "reply", id: message.id, ok: false, error: callErrorOf(error) });
    }
  }

  /** The host ends a job: the broker revoked first, then the worker's whole tree killed, then the record. */
  async #end(live: Live, how: "TERMINATED" | "DEADLINE"): Promise<void> {
    if (live.ended !== null || TERMINAL.has(live.record.state)) return;
    live.ended = how;
    await live.broker.revoke(how === "DEADLINE" ? "DEADLINE_EXCEEDED" : "TERMINATED_BY_HOST");
    if (live.record.pid !== null) killProcessTree(live.record.pid);
    const record = live.record;
    record.endedAtMs = this.#o.clock.nowMs();
    if (how === "DEADLINE") {
      record.state = "FAILED";
      record.cause = "DEADLINE_EXCEEDED";
      record.note = "DEADLINE";
    } else {
      record.state = "TERMINATED";
      record.note = "TERMINATED_BY_HOST";
    }
    this.#persist(record);
  }

  /** The worker exited: its result, or the host's own reading of an end without one. */
  #closeRecord(live: Live): void {
    const record = live.record;
    if (TERMINAL.has(record.state)) return;
    const result = live.result;
    record.endedAtMs = this.#o.clock.nowMs();
    if (result !== null) {
      record.state = result.state;
      record.cause = result.state === "FAILED" ? (result.cause ?? "WORKER_ERROR") : null;
      record.manifest = result.manifest;
      record.refusal = result.refusal;
      record.peakScratchBytes = result.peakScratchBytes;
      record.peakMemoryBytes = result.peakMemoryBytes;
    } else {
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = /heap out of memory|Allocation failed|ERR_WORKER_OUT_OF_MEMORY/i.test(live.stderrTail) ? "MEMORY_EXHAUSTED" : "NO_RESULT";
    }
    this.#persist(record);
  }

  #persist(record: LocalJobRecord): void {
    writeAtomically(join(this.#jobDir(record.identity), "record.json"), JSON.stringify(record));
  }

  #recordOf(identity: string): LocalJobRecord | null {
    const live = this.#live.get(identity);
    if (live !== undefined) return live.record;
    if (!isAttemptIdentity(identity)) return null;
    const dir = this.#jobDir(identity);
    if (!existsSync(dir)) return null;
    let record: LocalJobRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as LocalJobRecord;
    } catch {
      // created, but its record never written: the creating host died between the two (nothing ran)
      const stamp = statSync(dir).mtimeMs;
      record = { host: LOCAL_PROCESS_HOST, identity, ticketDigest: "0".repeat(64), instance: "unknown", state: "FAILED", pid: null, createdAtMs: stamp, startedAtMs: null, endedAtMs: stamp, lastHeartbeatMs: null, cause: "WORKER_CRASHED", note: "CREATE_INTERRUPTED", manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, flags: [], hardMemoryBytes: 0, hardScratchBytes: 0 };
      this.#persist(record);
      return record;
    }
    if (!TERMINAL.has(record.state) && record.instance !== this.instance) {
      // the host that ran it is gone: its worker ended itself when that host's channel closed (main.ts), leaving no result
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = "HOST_RESTARTED";
      record.endedAtMs = this.#o.clock.nowMs();
      this.#persist(record);
    }
    return record;
  }

  #resourcesOf(record: LocalJobRecord): WorkerResources {
    const runtimeMs = record.startedAtMs === null ? 0 : Math.max(0, (record.endedAtMs ?? this.#o.clock.nowMs()) - record.startedAtMs);
    return Object.freeze({
      machineType: LOCAL_PROCESS_MACHINE_TYPE,
      vcpus: availableParallelism(),
      memoryBytes: record.hardMemoryBytes,
      diskBytes: record.hardScratchBytes,
      peakScratchBytes: record.peakScratchBytes,
      runtimeMs,
      costMicros: 0,
      currency: "USD",
    });
  }
}
