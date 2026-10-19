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
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
import { killProcessTree, linuxAttemptProcesses, linuxProcessOf, linuxStartOf, processCommandLine, processExists, processRunning, sweepAttemptProcesses } from "./process-tree.js";
import { SUPERVISOR_READY, readVerdict, standDownOrVerdict, type SupervisorConfig } from "./supervisor.js";
import { WORKER_PROTOCOL_VERSION, normalizeWorkerMessage, type HostMessage, type InvalidWorkerMessage, type WorkerCall, type WorkerMessage, type WorkerResultReport, type WorkerStage } from "./protocol.js";
import { attemptTicketBytesOf, attemptTicketDigestOf, attemptTicketProblems, executionLimitsProblems, type AttemptTicket } from "./ticket.js";

export const LOCAL_PROCESS_HOST = "kauro-local-process-host";
export const LOCAL_PROCESS_MACHINE_TYPE = "local-process";
const EVIDENCE: WorkerHostEvidenceClass = "EXECUTED_LOCAL";
const NETWORK_PRELOAD = join(SANDBOX_CODE_ROOT, "sandbox", "preload.js");
const PROCESS_PRELOAD = join(SANDBOX_CODE_ROOT, "host", "worker-preload.js");
const SUPERVISOR = join(SANDBOX_CODE_ROOT, "host", "supervisor.js");
const MIB = 1024 * 1024;
/**
 * Files Playwright reads when it loads on Linux (is-wsl, is-inside-container: kernel and container markers, none a secret). Under the
 * permission model an unreadable path makes `existsSync` throw instead of answering false, so the worker may read exactly these.
 */
/**
 * A browser's own temporary directory for one attempt, beside the attempts' scratch (the worker never opens it; the browser does). On
 * POSIX the browser binds its singleton socket at `<this>/<app id>.XXXXXX/SingletonSocket`, and a socket's path is at most 107 bytes:
 * the name is short, and so must the scratch root be (BROWSER_SOCKET_ROOT_MAX_BYTES).
 */
export function browserTempDirectoryOf(scratchRoot: string, attemptId: string): string {
  return join(scratchRoot, `kb-${createHash("sha256").update(attemptId).digest("hex").slice(0, 12)}`);
}
/** 107 bytes less `/kb-<12>` (16), `/<app id>.XXXXXX` (at most 30: org.chromium.Chromium is 29) and `/SingletonSocket` (16). */
export const BROWSER_SOCKET_ROOT_MAX_BYTES = 45;
const LINUX_RUNTIME_PROBES = ["/proc/version", "/proc/sys/fs/binfmt_misc/WSLInterop", "/run/WSL", "/run/.containerenv", "/.dockerenv", "/proc/self/cgroup"];

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
  /** Awaited between a job's create and its start's claim (a test's pause of a creator; without it the two are one step). */
  afterCreate?(identity: string): Promise<void> | void;
  /** Awaited between the records' read and the create's publication (a test's pause of a creator; without it they are one step). */
  beforePublish?(identity: string): Promise<void> | void;
  /** Awaited between the supervisor's word and the ticket's delivery claim (a test's pause of a creator). */
  beforeTicket?(identity: string): Promise<void> | void;
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
  /** How often each worker's supervisor reads the tree's memory and the attempt's scratch (milliseconds; default 500). */
  readonly supervisorPollMs?: number;
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
  /**
   * The worker process's own identity beside its pid (Linux: its start in clock ticks since boot, which the process cannot change; a pid
   * can be reused, and a command line is the process's to rewrite). Null elsewhere: on Windows the identity is the command line, which a
   * worker without native code cannot rewrite.
   */
  pidStart?: string | null;
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
  persistedBeatMs: number;
  ended: EndReason | null;
  stderrTail: string;
  readonly settled: Promise<void>;
  timer: NodeJS.Timeout | null;
  supervisor: ChildProcess | null;
  /** Messages sent to the worker and not yet written out, and the bytes they carry (review round 19, R19-1). */
  outbound: number;
  outboundBytes: number;
}

const TERMINAL: ReadonlySet<RecordState> = new Set(["SUCCEEDED", "FAILED", "TERMINATED"]);
/** Why the host itself ends a job: a termination, the deadline, or a supervisor that could not start or did not stay (review R4-1). */
type EndReason = "TERMINATED" | "DEADLINE" | "SUPERVISOR_LOST" | "IDENTITY_UNREADABLE" | "CHANNEL_NOT_DRAINED" | "CHANNEL_PROTOCOL_VIOLATION";
/** What the host may hold for one worker in messages not yet written to its channel. */
const OUTBOUND_MESSAGES = 64;
const OUTBOUND_BYTES = 128 * 1024 * 1024;
/** How long a supervisor has to say it is watching before the worker gets its ticket. */
const SUPERVISOR_READY_MS = 15_000;
/** The note of a cancelled identity's tombstone: terminated before any create, so never a job (observe answers NOT_FOUND). */
const CANCELLED_BEFORE_CREATE = "CANCELLED_BEFORE_CREATE";
/** Written in a job's directory by an instance that ends another instance's worker, before it kills it. */
const TERMINATION_REQUEST = "terminate.request";
/** Taken once per job, exclusively: by its creator before the worker is spawned, or by an instance that ends the queued job for good. */
const START_CLAIM = "start.claim";
/** A pending creation's prepared directory, beside the jobs: `<prefix><identity>-<pid>-<n>`. */
const PENDING_PREFIX = ".creating-";
/** In a pending creation's directory: when the creation began (milliseconds, its creator's clock). */
const PENDING_FILE = "pending.json";
/** Taken once per job, exclusively: by its creator before the worker gets its ticket, or by an instance that ends the job before that. */
const TICKET_CLAIM = "ticket.claim";
/** How often an instance says it is alive, and how long another instance's silence means it is gone. */
const INSTANCE_BEAT_MS = 5_000;
const INSTANCE_LOST_MS = 30_000;
/** How often a running job's heartbeat reaches its durable record (another instance reads it there). */
const RECORD_BEAT_MS = 10_000;

/** Closes a handle a worker sent over its channel (any kind Node may hand over); never throws. */
function closeHandle(handle: unknown): void {
  try {
    (handle as { close?: () => void } | null | undefined)?.close?.();
  } catch {
    // already closed
  }
}

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function writeAtomically(path: string, bytes: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

/** A job's durable record could not be read: the host knows nothing about the job, so it answers nothing (a transient failure). */
export class HostRecordUnreadable extends Error {
  readonly code = "HOST_RECORD_UNREADABLE";
  readonly transient = true;
  constructor(identity: string, cause: unknown) {
    super(`${LOCAL_PROCESS_HOST}: the record of ${identity} could not be read`, { cause });
    this.name = "HostRecordUnreadable";
  }
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
  readonly #beat: NodeJS.Timeout;
  #creations = 0;
  /** Launches between their first check and their create: a termination of the identity abandons one (it then creates nothing). */
  readonly #launching = new Map<string, Set<{ abandoned: boolean }>>();

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
    mkdirSync(join(options.hostRoot, "instances"), { recursive: true });
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
    if (process.platform !== "win32" && Buffer.byteLength(this.#scratchRoot) > BROWSER_SOCKET_ROOT_MAX_BYTES) {
      throw new TypeError(`${LOCAL_PROCESS_HOST}: scratchRoot is longer than ${BROWSER_SOCKET_ROOT_MAX_BYTES} bytes, too long for the browser's socket path`);
    }
    this.creationHorizonSeconds = options.creationHorizonSeconds ?? 60;
    if (!Number.isSafeInteger(this.creationHorizonSeconds) || this.creationHorizonSeconds < 1) throw new TypeError(`${LOCAL_PROCESS_HOST}: creationHorizonSeconds is a positive whole number`);
    this.#workerHeap = options.workerHeapMegabytes ?? 1024;
    this.#coreHeap = options.coreHeapMegabytes ?? 2048;
    this.#browserReserve = options.browserReserveBytes ?? 1024 * MIB;
    if (![this.#workerHeap, this.#coreHeap].every((n) => Number.isSafeInteger(n) && n >= 64) || !Number.isSafeInteger(this.#browserReserve) || this.#browserReserve < 0) throw new TypeError(`${LOCAL_PROCESS_HOST}: heap sizes are whole megabytes of at least 64`);
    this.#o = options;
    this.instance = `${options.clock.nowMs().toString(36)}-${process.pid}`;
    // this instance's sign of life: another instance over the same root judges this one's running jobs by it
    const alive = (): void => writeAtomically(this.#instanceFile(this.instance), String(options.clock.nowMs()));
    alive();
    this.#beat = setInterval(alive, INSTANCE_BEAT_MS);
    this.#beat.unref();
  }

  // --- the port -----------------------------------------------------------------------------------------------------------------

  async launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchResult> {
    const identity = spec.identity;
    const answer = (outcome: WorkerLaunchResult["outcome"], reason: string | null): WorkerLaunchResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome, reason });
    const problem = this.#specProblem(spec);
    if (problem !== null) return answer("REFUSED", problem);
    const jobDir = this.#jobDir(identity);
    if (existsSync(jobDir)) return this.#cancelled(identity) ? answer("REFUSED", "IDENTITY_TERMINATED") : answer("ALREADY_EXISTS", null);
    // the creation is pending, durably, from here (review round 7, R7-1): its prepared directory exists before anything is read, so an
    // instance that would answer the identity absent past the creation horizon sees it, and takes the identity's name first (#absent)
    const n = ++this.#creations;
    const prepared = join(this.#hostRoot, "jobs", `${PENDING_PREFIX}${identity}-${process.pid}-${n}`);
    // made aside with its stamp (when it began, on this instance's clock: the horizon runs from here), then renamed into view, so a
    // pending creation is never visible without its stamp (review round 8, R8-3)
    const stamping = join(this.#hostRoot, "jobs", `.stamping-${identity}-${process.pid}-${n}`);
    const began = this.#o.clock.nowMs();
    mkdirSync(stamping);
    writeFileSync(join(stamping, PENDING_FILE), String(began));
    try {
      renameSync(stamping, prepared);
    } catch (error) {
      rmSync(stamping, { recursive: true, force: true });
      throw error;
    }
    let published = false;
    try {
      return await this.#create(spec, prepared, began, answer, () => (published = true));
    } finally {
      if (!published) rmSync(prepared, { recursive: true, force: true });
    }
  }

  async #create(spec: WorkerLaunchSpec, prepared: string, began: number, answer: (outcome: WorkerLaunchResult["outcome"], reason: string | null) => WorkerLaunchResult, publish: () => void): Promise<WorkerLaunchResult> {
    const identity = spec.identity;
    const jobDir = this.#jobDir(identity);

    // the control plane's records for this attempt, read before anything is created (a failed read creates nothing). The read is
    // bounded well inside the creation horizon, and a launch abandoned meanwhile (its identity terminated, or the bound passed)
    // creates nothing when the read lands: no create can land after the horizon
    const pending = { abandoned: false };
    const pendingOfIdentity = this.#launching.get(identity) ?? new Set<{ abandoned: boolean }>();
    pendingOfIdentity.add(pending);
    this.#launching.set(identity, pendingOfIdentity);
    const boundMs = Math.floor((this.creationHorizonSeconds * 1000) / 2);
    // the bound runs from the launch's own beginning, stamped before anything: a creator resuming late cannot start a new bound
    const startedMs = began;
    let reads: AttemptTicketReads;
    try {
      reads = await new Promise<AttemptTicketReads>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${LOCAL_PROCESS_HOST}: the attempt's records were not read within ${boundMs} ms; nothing was created`)), boundMs);
        timer.unref();
        this.#o.tickets.read(spec).then(
          (r) => (clearTimeout(timer), resolve(r)),
          (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
        );
      });
    } finally {
      pendingOfIdentity.delete(pending);
      if (pendingOfIdentity.size === 0 && this.#launching.get(identity) === pendingOfIdentity) this.#launching.delete(identity);
    }
    if (pending.abandoned || this.#o.clock.nowMs() - startedMs >= boundMs) throw new Error(`${LOCAL_PROCESS_HOST}: the launch was abandoned before its create; nothing was created`);
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

    // the create: one directory per identity, for good — prepared aside with its ticket and its first record, then renamed into
    // place, so the identity never exists without its record and a second create finds it taken (rename refuses a non-empty target).
    // A termination of the absent identity takes the same name first (#cancel), from this instance or any other: then nothing is created
    if (this.#o.hooks?.beforePublish !== undefined) await this.#o.hooks.beforePublish(identity);
    const record = this.#firstRecord(spec, bytes);
    writeFileSync(join(prepared, "ticket.json"), bytes);
    writeFileSync(join(prepared, "record.json"), JSON.stringify(record));
    try {
      renameSync(prepared, jobDir);
      publish();
    } catch (error) {
      if (existsSync(jobDir)) return this.#cancelled(identity) ? answer("REFUSED", "IDENTITY_TERMINATED") : answer("ALREADY_EXISTS", null);
      throw error;
    }
    if (this.#o.hooks?.afterCreate !== undefined) await this.#o.hooks.afterCreate(identity);
    // the start's claim (review round 5, R5-1): another instance that judged this queued job ended took it first, and then the job,
    // created and ended, never starts
    if (this.#claimOnce(identity, START_CLAIM, `start:${this.instance}`)) {
      try {
        this.#start(spec, bytes, record);
      } catch {
        // nothing could be started (the attempt's directory, the spawn): the job ends here rather than stay queued
        record.state = "FAILED";
        record.cause = "WORKER_ERROR";
        record.note = "START_FAILED";
        record.endedAtMs = this.#o.clock.nowMs();
        this.#persist(record);
      }
    }
    return answer("LAUNCHED", null);
  }

  async observe(identity: string): Promise<WorkerObservation> {
    const record = this.#existing(identity) ?? this.#absent(identity);
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
    return observation;
  }

  async terminate(identity: string): Promise<WorkerTerminationResult> {
    const answer = (outcome: WorkerTerminationResult["outcome"]): WorkerTerminationResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome });
    const live = this.#live.get(identity);
    if (live !== undefined) {
      if (TERMINAL.has(live.record.state)) return answer("ALREADY_TERMINAL");
      this.#end(live, "TERMINATED");
      return answer("TERMINATED");
    }
    let record = this.#existing(identity);
    if (record === null) {
      // every launch of this instance still reading its records is abandoned, and the identity's name is taken for good, so no launch
      // of any instance can create it afterwards: the identity is proved absent and stays absent
      for (const pending of this.#launching.get(identity) ?? []) pending.abandoned = true;
      if (this.#cancel(identity)) return answer("NOT_FOUND");
      // a create took the name first: what it created is ended like any other job
      record = this.#existing(identity);
      // the name is taken, by a job that cannot be read as one: no answer can be given on it
      if (record === null) throw new HostRecordUnreadable(identity, new Error("the identity's name is taken by no readable job"));
      const created = this.#live.get(identity);
      if (created !== undefined) {
        if (TERMINAL.has(created.record.state)) return answer("ALREADY_TERMINAL");
        this.#end(created, "TERMINATED");
        return answer("TERMINATED");
      }
    }
    if (TERMINAL.has(record.state)) return answer("ALREADY_TERMINAL");
    // a job of another instance, live or lost: its tree is ended by the worker's pid once that pid is proved the worker's (its command
    // line names the job's ticket digest), and the job is recorded ended only once its tree is known to have ended
    if (!(await this.#endForeignTree(record))) return answer("UNCERTAIN");
    record.state = "TERMINATED";
    record.note = "TERMINATED_BY_HOST";
    record.endedAtMs = this.#o.clock.nowMs();
    this.#persist(record);
    return answer("TERMINATED");
  }

  async resources(identity: string): Promise<WorkerResourceReport> {
    const record = this.#existing(identity) ?? this.#absent(identity);
    const report: WorkerResourceReport =
      record === null
        ? Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "NOT_FOUND" as const })
        : Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "REPORTED" as const, state: record.state as WorkerObservedState, resources: this.#resourcesOf(record) });
    return report;
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

  /** The pid of the supervisor watching a running job of this instance (evidence and tests), null when none watches. */
  supervisorPid(identity: string): number | null {
    return this.#live.get(identity)?.supervisor?.pid ?? null;
  }

  /** Every job this instance started and that is still running. */
  running(): readonly string[] {
    return [...this.#live.values()].filter((l) => !TERMINAL.has(l.record.state)).map((l) => l.record.identity);
  }

  /** Ends every running worker (shutdown); their records say TERMINATED. */
  async stop(): Promise<void> {
    clearInterval(this.#beat);
    for (const live of [...this.#live.values()]) {
      if (!TERMINAL.has(live.record.state)) this.#end(live, "TERMINATED");
      this.#standDown(live);
    }
    try {
      unlinkSync(this.#instanceFile(this.instance));
    } catch {
      // already gone
    }
  }

  /** The exact command line a worker of `spec` would run (evidence of the confinement). */
  flagsOf(spec: WorkerLaunchSpec, ticketDigest: Sha256Hex): string[] {
    const attemptDir = attemptScratchDirectoryOf(this.#scratchRoot, spec.capability.attemptId);
    const browser = [dirname(this.#o.chromiumExecutable), dirname(realpathSync.native(this.#o.chromiumExecutable))];
    const probes = process.platform === "linux" ? LINUX_RUNTIME_PROBES : [];
    const reads = [...new Set([...this.#codeRoots, ...browser, ...probes]), attemptDir];
    return [
      "--permission",
      ...reads.map((p) => `--allow-fs-read=${p}`),
      `--allow-fs-write=${attemptDir}`,
      "--allow-child-process",
      `--max-old-space-size=${this.#workerHeap}`,
      "--import",
      pathToFileURL(NETWORK_PRELOAD).href,
      "--import",
      pathToFileURL(PROCESS_PRELOAD).href,
      this.#o.workerEntry,
      "--ticket-digest",
      ticketDigest,
      "--scratch-root",
      this.#scratchRoot,
      "--chromium",
      this.#o.chromiumExecutable,
      "--browser-temp",
      browserTempDirectoryOf(this.#scratchRoot, spec.capability.attemptId),
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
    const own = typeof subject.attemptId === "string" && isAttemptIdentity(`kauro-attempt-${subject.attemptId}`) ? attemptIdentityOf(subject.attemptId) : null;
    if (!isAttemptIdentity(spec.identity) || spec.identity !== capability.identity || spec.identity !== own) return "IDENTITY_NOT_THE_ATTEMPTS";
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

  /** The job's record as it is created (QUEUED: no process yet). */
  #firstRecord(spec: WorkerLaunchSpec, bytes: Uint8Array): LocalJobRecord {
    const identity = spec.identity;
    const digest = attemptTicketDigestOf(bytes);
    const flags = this.flagsOf(spec, digest);
    const now = this.#o.clock.nowMs();
    return {
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
  }

  #start(spec: WorkerLaunchSpec, bytes: Uint8Array, record: LocalJobRecord): void {
    const identity = spec.identity;
    const flags = record.flags;
    const env: Record<string, string> = {};
    // Windows resolves its system libraries through SystemRoot; nothing else of the host's environment reaches the worker
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
    // the attempt's directory exists before the worker starts: the permission model grants a directory's contents only to a path that
    // is a directory when the process starts (the worker's scratch store then empties and re-creates it)
    const attemptDir = attemptScratchDirectoryOf(this.#scratchRoot, spec.capability.attemptId);
    mkdirSync(attemptDir, { recursive: true });
    const browserTemp = browserTempDirectoryOf(this.#scratchRoot, spec.capability.attemptId);
    mkdirSync(browserTemp, { recursive: true, mode: 0o700 });
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
    const live: Live = { record, child, broker, result: null, persistedBeatMs: 0, ended: null, stderrTail: "", settled: new Promise<void>((resolve) => (exited = resolve)), timer: null, supervisor: null, outbound: 0, outboundBytes: 0 };
    this.#live.set(identity, live);
    record.pid = child.pid ?? null;
    record.pidStart = child.pid !== undefined && process.platform === "linux" ? this.#startOfChild(child.pid) : null;
    record.state = "RUNNING";
    record.startedAtMs = this.#o.clock.nowMs();
    record.lastHeartbeatMs = record.startedAtMs;
    this.#persist(record);

    child.stderr?.on("data", (chunk: Buffer) => {
      live.stderrTail = (live.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    if (child.pid !== undefined) this.#guardChannel(live);
    // normalized at once, in the listener itself: only the protocol's own fields are kept while a call waits (review round 18, R18-1)
    child.on("message", (raw: unknown) => {
      const message = normalizeWorkerMessage(raw);
      if (message !== null) void this.#onMessage(live, message);
    });
    child.on("error", () => {
      // a spawn that failed: the exit below records it (no result)
    });
    child.on("exit", () => {
      if (live.timer !== null) clearTimeout(live.timer);
      broker.close("WORKER_EXITED");
      const close = (): void => {
        this.#standDown(live);
        this.#closeRecord(live);
        this.#removeBrowserTemp(spec.capability.attemptId);
        exited();
        void broker.revoke("WORKER_EXITED");
      };
      // the worker's end is not yet the attempt's: what it started and left (Linux: re-parented, or in a session of its own) is ended
      // and found gone before the end is recorded or the browser's directory removed; a process that outlives every sweep is left to
      // the supervisor, which sweeps again
      const pid = record.pid;
      // the worker is reaped: its group is named only while its pid names no process (a pid is not reused while a group holds it, and a
      // process now holding it is not the worker's — review round 6, R6-2)
      const sweep = (): number[] => sweepAttemptProcesses(pid !== null && !processExists(pid) ? pid : null, [attemptDir, browserTemp]);
      if (sweep().length === 0) return close();
      void (async () => {
        for (let round = 0; round < 25 && sweep().length > 0; round++) await new Promise((r) => setTimeout(r, 200));
        close();
      })();
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
    const deadlineInMs = Math.max(0, Math.min(until, 2_147_483_647));
    live.timer = setTimeout(() => this.#end(live, "DEADLINE"), deadlineInMs);
    live.timer.unref();
    // the ticket only once the supervisor watches (review R4-1): no worker runs its attempt unsupervised, and a supervisor that fails to
    // start, or ends while the worker runs, ends the attempt
    if (child.pid !== undefined && process.platform === "linux" && record.pidStart === null) {
      // the worker's identity could not be read: without it nothing may watch or signal it by pid (review round 9, R9-2); it is still
      // this host's unreaped child, so it is ended now, before it has its ticket
      this.#end(live, "IDENTITY_UNREADABLE");
    } else if (child.pid !== undefined) {
      live.supervisor = this.#supervise(live, child.pid, [attemptDir, browserTemp], deadlineInMs + 1_000, spec, async () => {
        if (this.#o.hooks?.beforeTicket !== undefined) await this.#o.hooks.beforeTicket(identity);
        if (TERMINAL.has(live.record.state)) return;
        // the ticket's delivery is claimed once (review round 6, R6-1): an instance that ended this job meanwhile, judging this one
        // lost, claimed it first, and then the worker never gets its ticket and is ended; an end recorded meanwhile stands too
        if (!this.#claimOnce(identity, TICKET_CLAIM, `deliver:${this.instance}`) || existsSync(join(this.#jobDir(identity), "end.json"))) return this.#end(live, "TERMINATED");
        this.#send(live, { t: "ticket", protocol: WORKER_PROTOCOL_VERSION, bytes });
      });
    }
  }

  /**
   * Node's own IPC commands (`NODE_*`) and handles are never part of this protocol (review round 20, R20-1). Node answers them itself, in
   * an `internalMessage` listener of its own that trusts the other side (an unsolicited `NODE_HANDLE_ACK` fails an internal assertion
   * and throws in this process). This host sends no handle, so Node's listener is removed and replaced: any internal command, and any
   * handle arriving on the channel (closed at once), ends the attempt (`CHANNEL_PROTOCOL_VIOLATION`). A runtime whose channel cannot
   * be guarded so starts nothing: the worker is ended before it has its ticket.
   */
  #guardChannel(live: Live): void {
    const child = live.child;
    const violation = (): void => this.#end(live, "CHANNEL_PROTOCOL_VIOLATION");
    child.removeAllListeners("internalMessage");
    child.on("internalMessage", (_message: unknown, handle: unknown) => {
      closeHandle(handle);
      violation();
    });
    const symbol = Object.getOwnPropertySymbols(child).find((s) => s.description === "kChannelHandle");
    const channel = symbol === undefined ? undefined : (child as unknown as Record<symbol, { onread?: (...args: unknown[]) => unknown; pendingHandle?: unknown } | null>)[symbol];
    if (channel === undefined || channel === null || typeof channel.onread !== "function") {
      violation();
      return;
    }
    const onread = channel.onread;
    channel.onread = function guardedRead(this: unknown, ...args: unknown[]): unknown {
      // a handle sent with any message: closed before Node keeps it, and the attempt ended
      if (channel.pendingHandle != null) {
        closeHandle(channel.pendingHandle);
        channel.pendingHandle = null;
        violation();
      }
      return onread.apply(this, args);
    };
  }

  /** Linux: the start of this host's own child, just spawned (so not yet reaped): read again a few times before it is given up. */
  #startOfChild(pid: number): string | null {
    for (let tries = 0; tries < 5; tries++) {
      const start = linuxStartOf(pid);
      if (start !== null) return start;
    }
    return null;
  }

  /**
   * Sends one message to the worker, counted until it is written out: a worker that stops reading its channel cannot make the host
   * queue replies without bound (review round 19, R19-1) — past OUTBOUND_MESSAGES or OUTBOUND_BYTES waiting, the attempt is ended
   * (FAILED WORKER_ERROR, CHANNEL_NOT_DRAINED) and nothing more is queued for it.
   */
  #send(live: Live, message: HostMessage): void {
    if (!live.child.connected || live.ended !== null) return;
    const bytes = message.t === "ticket" ? message.bytes.byteLength : message.t === "reply" && message.ok && message.value instanceof Uint8Array ? message.value.byteLength : 0;
    if (live.outbound + 1 > OUTBOUND_MESSAGES || live.outboundBytes + bytes > OUTBOUND_BYTES) {
      this.#end(live, "CHANNEL_NOT_DRAINED");
      return;
    }
    live.outbound += 1;
    live.outboundBytes += bytes;
    const written = (): void => {
      live.outbound -= 1;
      live.outboundBytes -= bytes;
    };
    try {
      live.child.send(message, undefined, {}, written);
    } catch {
      // the worker is gone; its exit records it
      written();
    }
  }

  async #onMessage(live: Live, message: WorkerMessage | InvalidWorkerMessage): Promise<void> {
    const record = live.record;
    if (message.t === "invalid") {
      live.broker.noteMalformed();
      this.#send(live, { t: "reply", id: message.id, ok: false, error: { code: message.problem, message: "the call is not one of the protocol's", transient: false } });
      return;
    }
    if (message.t === "beat") {
      this.#heartbeat(live);
      return;
    }
    if (message.t === "result") {
      // normalized already: a result outside the protocol's closed, bounded shape is a worker error with its problem (review R17-1)
      if (live.result === null) live.result = message.result;
      return;
    }
    this.#heartbeat(live);
    const call = message.call;
    try {
      let value: unknown = null;
      if (call.op === "stage") await this.#o.hooks?.atStage?.(record.identity, call.stage);
      else {
        await this.#o.hooks?.beforeCall?.(record.identity, call);
        value = await live.broker.handle(call);
      }
      this.#send(live, { t: "reply", id: message.id, ok: true, value });
    } catch (error) {
      this.#send(live, { t: "reply", id: message.id, ok: false, error: callErrorOf(error) });
    }
  }

  /** The worker's sign of life: in memory at once, in the durable record at most every RECORD_BEAT_MS (another instance reads it there). */
  #heartbeat(live: Live): void {
    const now = this.#o.clock.nowMs();
    live.record.lastHeartbeatMs = now;
    if (now - live.persistedBeatMs >= RECORD_BEAT_MS && !TERMINAL.has(live.record.state)) {
      live.persistedBeatMs = now;
      this.#persist(live.record);
    }
  }

  /**
   * The supervisor of one worker (supervisor.ts): a process of its own, outside the worker's confinement, that ends the worker's tree if
   * this host dies, at the deadline whether or not this host lives, and past the attempt's hard memory or scratch.
   */
  #supervise(live: Live, workerPid: number, scratchDirs: readonly string[], deadlineInMs: number, spec: WorkerLaunchSpec, ready: () => Promise<void>): ChildProcess {
    const config: SupervisorConfig = {
      workerPid,
      workerStart: live.record.pidStart ?? null,
      ticketDigest: live.record.ticketDigest,
      jobDir: this.#jobDir(live.record.identity),
      scratchDirs,
      deadlineInMs,
      hardMemoryBytes: spec.limits.hardMemoryBytes,
      hardScratchBytes: spec.limits.hardScratchBytes,
      pollMs: this.#o.supervisorPollMs ?? 500,
    };
    const env: Record<string, string> = {};
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
    // detached on every platform: on Windows a child that is not detached is in the host's job object and dies with the host, before it
    // could record why (the worker and its tree die with it there too: libuv's kill-on-close job); its working directory is the code's
    const supervisor = spawn(process.execPath, [SUPERVISOR, JSON.stringify(config)], { cwd: SANDBOX_CODE_ROOT, env, stdio: ["pipe", "pipe", "ignore"], detached: true, windowsHide: true });
    let watching = false;
    // lost: it could not start, did not say it watches in time, or ended while this worker still runs (a standing down clears it first)
    const lost = (): void => {
      // a supervisor leaving after the worker, or after a standing down, is not lost
      if (live.supervisor !== supervisor || TERMINAL.has(live.record.state) || live.child.exitCode !== null || live.child.signalCode !== null) return;
      // one that recorded a verdict may have died before ending the tree (review round 6, R6-3): the host ends it now, and the verdict
      // classifies the worker's exit; without a verdict the supervisor is lost
      if (readVerdict(this.#jobDir(live.record.identity)) !== null) {
        // still this host's unreaped child (checked above), so the pid is the worker's
        if (live.record.pid !== null) killProcessTree(live.record.pid);
        return;
      }
      this.#end(live, "SUPERVISOR_LOST");
    };
    const timer = setTimeout(() => (watching ? undefined : lost()), SUPERVISOR_READY_MS);
    timer.unref();
    let said = "";
    supervisor.stdout?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (!watching && said.includes(SUPERVISOR_READY)) {
        watching = true;
        clearTimeout(timer);
        if (live.supervisor === supervisor && !TERMINAL.has(live.record.state)) void ready();
      }
    });
    supervisor.stdout?.on("error", () => undefined);
    supervisor.stdin?.on("error", () => undefined);
    supervisor.on("error", lost);
    supervisor.on("exit", lost);
    supervisor.unref();
    (supervisor.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    return supervisor;
  }

  /**
   * The browser's temporary directory, once the attempt's tree is gone (the host's own; the janitor knows only the attempt's scratch). A
   * browser process still ending may hold a file a moment longer: removal retries, and a later end of the same job tries again.
   */
  #removeBrowserTemp(attemptId: string): void {
    try {
      rmSync(browserTempDirectoryOf(this.#scratchRoot, attemptId), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // still held: a later answer for the job tries again
    }
  }

  /** The worker ended: its supervisor stands down. */
  #standDown(live: Live): void {
    const supervisor = live.supervisor;
    live.supervisor = null;
    if (supervisor === null) return;
    try {
      supervisor.stdin?.end("EXITED\n");
    } catch {
      // the supervisor is gone
    }
  }

  /**
   * The host ends a job: the broker refuses everything at once, the worker's whole tree is killed at once, the end is recorded, and only
   * then is the provider's side cleaned (bounded, in the background): no cleanup can hold a termination or a deadline back.
   */
  #end(live: Live, how: EndReason): void {
    if (live.ended !== null || TERMINAL.has(live.record.state)) return;
    live.ended = how;
    live.broker.close(how === "DEADLINE" ? "DEADLINE_EXCEEDED" : "TERMINATED_BY_HOST");
    // the pid is still this host's child (not yet reaped), so it is the worker's
    if (live.record.pid !== null && live.child.exitCode === null && live.child.signalCode === null) killProcessTree(live.record.pid);
    const record = live.record;
    record.endedAtMs = this.#o.clock.nowMs();
    if (how === "DEADLINE") {
      record.state = "FAILED";
      record.cause = "DEADLINE_EXCEEDED";
      record.note = "DEADLINE";
    } else if (how === "SUPERVISOR_LOST") {
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = "SUPERVISOR_LOST";
    } else if (how === "IDENTITY_UNREADABLE" || how === "CHANNEL_NOT_DRAINED" || how === "CHANNEL_PROTOCOL_VIOLATION") {
      record.state = "FAILED";
      record.cause = "WORKER_ERROR";
      record.note = how;
    } else {
      record.state = "TERMINATED";
      record.note = "TERMINATED_BY_HOST";
    }
    this.#persist(record);
    void live.broker.revoke(how === "DEADLINE" ? "DEADLINE_EXCEEDED" : "TERMINATED_BY_HOST");
  }

  /** The worker exited: its result, or the host's own reading of an end without one. */
  #closeRecord(live: Live): void {
    const record = live.record;
    if (TERMINAL.has(record.state)) return;
    // the supervisor's verdict and this standing down are one exclusive file (review round 7, R7-2): a verdict written first decides the
    // end whatever the worker answered (an attempt past its hard limits never succeeds); written first here, no verdict can follow
    const verdict = standDownOrVerdict(this.#jobDir(record.identity));
    if (verdict !== null && verdict !== "HOST_LOST") {
      record.endedAtMs = this.#o.clock.nowMs();
      record.state = "FAILED";
      record.cause = verdict === "SCRATCH_EXHAUSTED" ? "SCRATCH_EXHAUSTED" : verdict === "DEADLINE" ? "DEADLINE_EXCEEDED" : "WORKER_CRASHED";
      record.note = verdict;
      record.peakScratchBytes = live.result?.peakScratchBytes ?? record.peakScratchBytes;
      record.peakMemoryBytes = live.result?.peakMemoryBytes ?? record.peakMemoryBytes;
      this.#persist(record);
      return;
    }
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
      // no result (and no verdict of exhaustion or deadline, above): a termination another instance asked for; else the host's own
      // reading of the exit
      if (existsSync(join(this.#jobDir(record.identity), TERMINATION_REQUEST))) {
        record.state = "TERMINATED";
        record.note = "TERMINATED_BY_HOST";
        this.#persist(record);
        return;
      }
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = verdict ?? (/heap out of memory|Allocation failed|ERR_WORKER_OUT_OF_MEMORY/i.test(live.stderrTail) ? "MEMORY_EXHAUSTED" : "NO_RESULT");
    }
    this.#persist(record);
  }

  /**
   * Writes the job's record. A job's end is written once, for good: `end.json` is created exclusively (a hard link to a complete file,
   * which fails if it exists), so of two instances, or of a result and a termination, the first end wins and every later one adopts it.
   */
  #persist(record: LocalJobRecord): void {
    const dir = this.#jobDir(record.identity);
    if (TERMINAL.has(record.state)) {
      const end = join(dir, "end.json");
      const temporary = `${end}.${process.pid}.${++this.#creations}.tmp`;
      writeFileSync(temporary, JSON.stringify(record));
      try {
        linkSync(temporary, end);
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        Object.assign(record, JSON.parse(readFileSync(end, "utf8")) as LocalJobRecord);
      } finally {
        unlinkSync(temporary);
      }
    }
    writeAtomically(join(dir, "record.json"), JSON.stringify(record));
  }

  /**
   * Whether the tree of a job whose host is gone has ended: its supervisor recorded ending it (HOST_LOST, or any verdict), or its worker
   * no longer exists, or its pid now names another process; and (Linux) no process the attempt's directories mark is left. While that
   * does not hold, the job is answered as its record stands (RUNNING), never as ended.
   */
  #treeEnded(_dir: string, record: LocalJobRecord): boolean {
    if (process.platform === "linux" && linuxAttemptProcesses(this.#attemptDirsOf(record.identity)).length > 0) return false;
    const who = this.#workerIdentity(record);
    return who === "GONE" || who === "OTHER";
  }

  /**
   * Whether the job's pid is still its worker (review round 3, R3-2): GONE (no such process), OTHER (the pid now names another
   * process), WORKER, or UNKNOWN (its identity cannot be read — never taken for an end). Linux compares the start recorded at spawn,
   * which the process cannot change; Windows the command line, which names the job's ticket digest.
   */
  #workerIdentity(record: LocalJobRecord): "GONE" | "OTHER" | "WORKER" | "UNKNOWN" {
    if (record.pid === null) return "GONE";
    if (process.platform === "linux") {
      // a /proc entry that cannot be read is UNKNOWN, never GONE (review round 10, R10-1)
      const seen = linuxProcessOf(record.pid);
      if (seen.state !== "RUNNING") return seen.state;
      if (record.pidStart == null) return "UNKNOWN";
      return seen.start === record.pidStart ? "WORKER" : "OTHER";
    }
    if (!processRunning(record.pid)) return "GONE";
    const line = processCommandLine(record.pid);
    return line === null ? "GONE" : line === undefined ? "UNKNOWN" : line.includes(record.ticketDigest) ? "WORKER" : "OTHER";
  }

  /** The attempt's directory and its browser's temporary one (the marks of its processes). */
  #attemptDirsOf(identity: string): string[] {
    const attemptId = identity.slice("kauro-attempt-".length);
    return [attemptScratchDirectoryOf(this.#scratchRoot, attemptId), browserTempDirectoryOf(this.#scratchRoot, attemptId)];
  }

  /**
   * Ends the tree of a job this instance did not start, and answers whether it is known to have ended. The worker's pid is killed only
   * once it is proved the worker's (#workerIdentity; a pid can be reused); then the attempt's marked processes are swept (Linux) and the
   * end awaited, bounded. Unknown (the identity cannot be read, or the tree outlives the bound): false, and the job stays as it is.
   */
  async #endForeignTree(record: LocalJobRecord): Promise<boolean> {
    const dirs = this.#attemptDirsOf(record.identity);
    if (record.pid === null) {
      // never started: ended for good only if this instance takes the start's claim first, so its creator never starts it (R5-1);
      // otherwise its creator is starting it this moment (UNCERTAIN)
      return this.#queuedEnded(record.identity);
    }
    const pid = record.pid;
    if (this.#workerIdentity(record) === "UNKNOWN") return false;
    // the owning instance, reading the worker's exit without a result, records the termination asked for, not a crash
    writeFileSync(join(this.#jobDir(record.identity), TERMINATION_REQUEST), this.instance);
    // the pid's identity is read again before every signal (review round 5, R5-2): the worker's pid is killed, and its group swept, only
    // while it is the worker's (or, for the group, names no process); once it names another process only marked processes are swept
    for (let round = 0; round < 50; round++) {
      const who = this.#workerIdentity(record);
      if (who === "UNKNOWN") return false;
      if (who === "WORKER") killProcessTree(pid);
      const left = sweepAttemptProcesses(who === "WORKER" || who === "GONE" ? pid : null, dirs);
      // ended only when the pid is known not to be the worker's: UNKNOWN is no end (review round 11, R11-1)
      const after = this.#workerIdentity(record);
      if (after === "UNKNOWN") return false;
      if (left.length === 0 && (after === "GONE" || after === "OTHER")) {
        this.#removeBrowserTemp(record.identity.slice("kauro-attempt-".length));
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /**
   * Takes a job's start, once: its creator before it spawns the worker (`start:`), or another instance that ends a queued job for good
   * (`never:`). Exclusive, so of a creator resuming late and an instance ending its job, exactly one goes on.
   */
  #claimOnce(identity: string, name: string, claim: string): boolean {
    try {
      writeFileSync(join(this.#jobDir(identity), name), claim, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether a queued job (no pid recorded) is ended for good. Its start's claim taken here first: its creator never starts it. Taken by
   * its creator, whose instance has since been lost for longer than the creation horizon: a creator that spawned would have recorded
   * the pid at once (the claim, the spawn and the record are one synchronous step), and one resuming later finds this end before it
   * gives the worker its ticket, and ends it. The ticket's delivery is itself claimed once (`ticket.claim`), so a decision to end and a
   * resumed creator's delivery cannot both go on.
   */
  #queuedEnded(identity: string): boolean {
    if (this.#claimOnce(identity, START_CLAIM, `never:${this.instance}`)) return true;
    try {
      const path = join(this.#jobDir(identity), START_CLAIM);
      const claim = readFileSync(path, "utf8");
      if (claim.startsWith("never:")) return true;
      const owner = claim.slice("start:".length);
      if (this.#instanceAlive(owner) || this.#o.clock.nowMs() - statSync(path).mtimeMs <= this.creationHorizonSeconds * 1000) return false;
      // its creator was lost after claiming the start: the job is ended only if this instance also takes the ticket's delivery, so a
      // creator that resumes can never give a worker its ticket (a worker without its ticket runs nothing and ends) — R6-1
      return this.#claimOnce(identity, TICKET_CLAIM, `never:${this.instance}`) || readFileSync(join(this.#jobDir(identity), TICKET_CLAIM), "utf8").startsWith("never:");
    } catch {
      return false;
    }
  }

  /**
   * Called where the identity would be answered absent (observe, resources): a creation still pending past the creation horizon (its
   * prepared directory older than the horizon) can no longer publish — this instance takes the identity's name for good first, as a
   * termination does — so the absence answered stays true (review round 7, R7-1). A creation pending within the horizon may still
   * publish, which is what the horizon allows. Answers null (absent) unless a create took the name meanwhile.
   */
  #absent(identity: string): LocalJobRecord | null {
    let pending: string[];
    try {
      pending = readdirSync(join(this.#hostRoot, "jobs")).filter((name) => name.startsWith(`${PENDING_PREFIX}${identity}-`));
    } catch (error) {
      // a scan that failed proves no absence (review round 10, R10-2): the host's own failure, transient
      throw new HostRecordUnreadable(identity, error);
    }
    const now = this.#o.clock.nowMs();
    const expired = pending.some((name) => {
      const dir = join(this.#hostRoot, "jobs", name);
      try {
        const began = Number(readFileSync(join(dir, PENDING_FILE), "utf8"));
        // a stamp that cannot be read as an instant is taken for an expired one (review round 8, R8-3)
        return !Number.isFinite(began) || now - began > this.creationHorizonSeconds * 1000;
      } catch {
        // published or abandoned meanwhile (its directory gone): the reconciliation below finds a published job; a directory still
        // there without a readable stamp is taken for an expired one
        return existsSync(dir);
      }
    });
    if (expired) this.#cancel(identity);
    // whatever the scan saw, a job published meanwhile is answered as it stands (review round 8, R8-1)
    return this.#existing(identity);
  }

  /** A record that is a job's (a cancelled identity's tombstone is no job: the identity was never created). */
  #existing(identity: string): LocalJobRecord | null {
    const record = this.#recordOf(identity);
    return record === null || record.note === CANCELLED_BEFORE_CREATE ? null : record;
  }

  #cancelled(identity: string): boolean {
    return this.#recordOf(identity)?.note === CANCELLED_BEFORE_CREATE;
  }

  /**
   * Takes an absent identity's name for good, as a create would (the same rename of a prepared directory holding a record), so that no
   * launch of any instance creates it afterwards. True when this call took it; false when a create, or another cancel, came first.
   */
  #cancel(identity: string): boolean {
    const jobDir = this.#jobDir(identity);
    if (this.#present(identity, jobDir)) return this.#cancelled(identity);
    const stamp = this.#o.clock.nowMs();
    const record: LocalJobRecord = { host: LOCAL_PROCESS_HOST, identity, ticketDigest: "0".repeat(64), instance: this.instance, state: "TERMINATED", pid: null, createdAtMs: stamp, startedAtMs: null, endedAtMs: stamp, lastHeartbeatMs: null, cause: null, note: CANCELLED_BEFORE_CREATE, manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, flags: [], hardMemoryBytes: 0, hardScratchBytes: 0 };
    const prepared = join(this.#hostRoot, "jobs", `.cancelling-${identity}-${process.pid}-${++this.#creations}`);
    try {
      mkdirSync(prepared);
      writeFileSync(join(prepared, "end.json"), JSON.stringify(record));
      writeFileSync(join(prepared, "record.json"), JSON.stringify(record));
      renameSync(prepared, jobDir);
      return true;
    } catch (error) {
      rmSync(prepared, { recursive: true, force: true });
      // the name was taken by a create or another cancellation: that is the answer. Taken by nobody, the cancellation itself failed,
      // and no absence may be answered on it (review round 12, R12-1): the host's transient failure
      if (!this.#present(identity, jobDir)) throw new HostRecordUnreadable(identity, error);
      return this.#cancelled(identity);
    }
  }

  /** Whether a path exists: false only for ENOENT; any other failure to look is the host's transient failure (HostRecordUnreadable). */
  #present(identity: string, path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return false;
      throw new HostRecordUnreadable(identity, error);
    }
  }

  #instanceFile(instance: string): string {
    return join(this.#hostRoot, "instances", instance.replace(/[^a-z0-9-]/g, "_"));
  }

  /** Whether an instance over this root said it was alive within INSTANCE_LOST_MS (on this host's clock); this one always is. */
  #instanceAlive(instance: string): boolean {
    if (instance === this.instance) return true;
    try {
      return this.#o.clock.nowMs() - Number(readFileSync(this.#instanceFile(instance), "utf8")) < INSTANCE_LOST_MS;
    } catch {
      return false;
    }
  }

  #recordOf(identity: string): LocalJobRecord | null {
    const live = this.#live.get(identity);
    if (live !== undefined) return live.record;
    if (!isAttemptIdentity(identity)) return null;
    const dir = this.#jobDir(identity);
    // absent only when the filesystem says so (ENOENT); any other failure is the host's, never an absence (review round 11, R11-3)
    if (!this.#present(identity, dir)) return null;
    let record: LocalJobRecord;
    try {
      const end = join(dir, "end.json");
      record = JSON.parse(readFileSync(this.#present(identity, end) ? end : join(dir, "record.json"), "utf8")) as LocalJobRecord;
    } catch (error) {
      // a record that cannot be read is no proof of anything (review round 9, R9-1): the host's own failure, transient, answered as
      // such and never as an end (a create renames a directory that holds its record, so a host never leaves one without it)
      throw new HostRecordUnreadable(identity, error);
    }
    // a queued job (no pid yet) is ended here only if its creator will never start it (#queuedEnded)
    if (!TERMINAL.has(record.state) && !this.#instanceAlive(record.instance) && this.#treeEnded(dir, record) && (record.pid !== null || this.#queuedEnded(identity))) {
      // the host that ran it is gone (it no longer says it is alive): its worker ended itself when that host's channel closed (main.ts),
      // leaving no result. A job of another live instance is answered from that instance's record as it stands.
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = "HOST_RESTARTED";
      record.endedAtMs = this.#o.clock.nowMs();
      this.#persist(record);
    }
    if (TERMINAL.has(record.state) && record.instance !== this.instance) {
      // the tree has ended: what its browser left in its temporary directory goes (a job ended by its own instance was cleaned there)
      this.#removeBrowserTemp(identity.slice("kauro-attempt-".length));
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
