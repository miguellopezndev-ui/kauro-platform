/**
 * LocalProcessWorkerHost — the local executor of B14-A (docs/design/B14-A-worker-executor.md, B14-A-recovery.md): a `WorkerHostPort`
 * that runs each processing attempt as one worker process on this machine. EXECUTED_LOCAL: real processes, the real cores and browser,
 * real storage capability; never a cloud provider (EXECUTED_PROVIDER belongs to the cloud host alone).
 *
 * Its trust model is stated, not implied (`isolation: "SINGLE_TENANT_QUALIFICATION"`): it runs the platform's own worker code on
 * synthetic data for one tenant. Malicious input is contained where B05 and B13 contain it (the core's child under the permission
 * model without child processes; Chromium sandboxed, offline, JavaScript off). Containment of a compromised worker, and hard memory
 * and disk limits against code that bypasses the in-process quotas, are the cloud task's (B14-A-recovery.md §6), not this host's.
 *
 * Every guarantee below rests on something the operating system or a single thread provides:
 *
 *   - One live host per root (root-lock.ts): all decisions about the root's jobs are this process's, made in one thread; files are a
 *     write-through journal (job-journal.ts) read only when the root is opened. A host that opens the root knows the previous one is
 *     gone, and ends its unfinished jobs FAILED WORKER_CRASHED (HOST_RESTARTED): their workers lost their broker with their host, so
 *     none can produce an effect, and B08 takes the lease over at fence + 1.
 *   - Creation by identity (D8-HOST-1): a second launch of an identity answers ALREADY_EXISTS (a concurrent one waits for the first's
 *     answer); REFUSED creates nothing; a launch's read of the control plane's records is bounded by half the creation horizon and
 *     creates nothing once that passed or once its identity was terminated; a termination of an absent identity leaves a durable
 *     tombstone, so the NOT_FOUND it answers stays true.
 *   - The worker: an empty environment (SystemRoot on Windows only), no database connection, every object through the attempt's
 *     broker (no credential, no session reference), the Node permission model (read the code, the browser and its own attempt; write
 *     its own attempt), the network preload, the V8 heap cap; its channel is a pipe on fd 3 in the protocol's own frames (framing.ts).
 *   - The channel: the host holds at most CALLS_HELD calls from the moment it reads one until its reply has left the process, and
 *     reads nothing more meanwhile; a frame outside the protocol ends the attempt, never this process.
 *   - Its end: only this host signals the worker, while it is this host's unreaped child (process-tree.ts) — at a termination, at the
 *     deadline, on a protocol violation, at stop. If this host dies, the kernel ends the worker: on Windows it is in this process's
 *     kill-on-close job object; on Linux it is started under a parent-death signal (util-linux `setpriv --pdeathsig KILL`). What the
 *     worker started ends with it (Windows: the worker's own job object) or when it next finds its parent's pipe closed (the core's
 *     child at its next report, the browser on its debugging pipe).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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
  type WorkerHostEvidenceClass,
  type WorkerHostPort,
  type WorkerLaunchResult,
  type WorkerLaunchSpec,
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
import { encodeFrame, FrameDecoder } from "./framing.js";
import { CANCELLED_BEFORE_CREATE, JobJournal, LOCAL_PROCESS_HOST, TERMINAL, type LocalJobRecord } from "./job-journal.js";
import { killProcessTree } from "./process-tree.js";
import { WORKER_PROTOCOL_VERSION, normalizeWorkerMessage, type HostMessage, type InvalidWorkerMessage, type WorkerCall, type WorkerMessage, type WorkerResultReport, type WorkerStage } from "./protocol.js";
import { acquireHostRootLock, type HostRootLock } from "./root-lock.js";
import { attemptTicketBytesOf, attemptTicketDigestOf, attemptTicketProblems, executionLimitsProblems, type AttemptTicket } from "./ticket.js";

export { HostRecordUnreadable, LOCAL_PROCESS_HOST, type LocalJobRecord } from "./job-journal.js";
export { HostRootInUse } from "./root-lock.js";
export const LOCAL_PROCESS_MACHINE_TYPE = "local-process";
/** The one trust model this host runs under (B14-A-recovery.md §6, §7); a composition names it. */
export const LOCAL_HOST_ISOLATION = "SINGLE_TENANT_QUALIFICATION";
const EVIDENCE: WorkerHostEvidenceClass = "EXECUTED_LOCAL";
const NETWORK_PRELOAD = join(SANDBOX_CODE_ROOT, "sandbox", "preload.js");
const MIB = 1024 * 1024;

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
/**
 * Files Playwright reads when it loads on Linux (is-wsl, is-inside-container: kernel and container markers, none a secret). Under the
 * permission model an unreadable path makes `existsSync` throw instead of answering false, so the worker may read exactly these.
 */
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
}

export interface LocalProcessWorkerHostOptions {
  /** The trust model, named by the composition: the only one this host runs under. */
  readonly isolation: typeof LOCAL_HOST_ISOLATION;
  /** The worker's entry module (the @kauro/migration-worker main, or a container image's). */
  readonly workerEntry: string;
  /** The code the worker may read (the workspace or the image's application directory). Never holds the host's or scratch roots. */
  readonly codeRoots: readonly string[];
  /** The host's durable job records (one live host per root). */
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

interface Live {
  readonly record: LocalJobRecord;
  readonly child: ChildProcess;
  /** The worker's channel: its fd 3, read in the protocol's own frames. */
  readonly channel: Socket | null;
  readonly decoder: FrameDecoder;
  readonly broker: AttemptStorageBroker;
  result: WorkerResultReport | null;
  ended: EndReason | null;
  stderrTail: string;
  readonly settled: Promise<void>;
  timer: NodeJS.Timeout | null;
  /** Calls read from the channel whose replies have not yet left this process (at most CALLS_HELD). */
  held: number;
  /** The cancellation state last mirrored to the worker (each state is written once). */
  signalled: "CANCELLED" | "FENCED" | null;
}

interface PendingLaunch {
  abandoned: boolean;
  readonly answer: Promise<WorkerLaunchResult>;
}

/** Why the host itself ends a job. */
type EndReason = "TERMINATED" | "DEADLINE" | "CHANNEL_PROTOCOL_VIOLATION";
/** How long a worker's exit waits for the rest of its channel (what it wrote before it exited) before the channel is closed. */
const CHANNEL_DRAIN_MS = 2_000;
/** The calls one worker may have the host hold at once, from their reading until their replies have left this process. */
export const CALLS_HELD = 16;
/** How long `stop` waits for its workers' ends. */
const STOP_WAIT_MS = 15_000;

function isInside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Whether the worker is still this host's unreaped child: only then are its pid and its group its own (process-tree.ts). */
function unreaped(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

interface Roots {
  readonly hostRoot: string;
  readonly scratchRoot: string;
  readonly codeRoots: readonly string[];
  /** Linux: the program that starts the worker under a parent-death signal (null on Windows, where the job object does it). */
  readonly setpriv: string | null;
}

/** Where util-linux's setpriv is found on Linux. */
const SETPRIV = ["/usr/bin/setpriv", "/bin/setpriv"];

/** Refuses an incomplete or unsafe configuration before anything is opened (B14-A §5); answers the roots as real paths. */
function configured(options: LocalProcessWorkerHostOptions): Roots {
  const problems: string[] = [];
  if (options.isolation !== LOCAL_HOST_ISOLATION) problems.push(`isolation is not ${LOCAL_HOST_ISOLATION}`);
  if (process.platform !== "win32" && process.platform !== "linux") problems.push(`the platform ${process.platform} is not Windows or Linux`);
  for (const [name, path] of [["workerEntry", options.workerEntry], ["chromiumExecutable", options.chromiumExecutable], ["hostRoot", options.hostRoot], ["scratchRoot", options.scratchRoot]] as const) {
    if (typeof path !== "string" || !isAbsolute(path)) problems.push(`${name} is not an absolute path`);
  }
  if (!Array.isArray(options.codeRoots) || options.codeRoots.length === 0 || !options.codeRoots.every((p) => typeof p === "string" && isAbsolute(p) && existsSync(p))) problems.push("codeRoots are not existing absolute paths");
  if (problems.length === 0 && !existsSync(options.workerEntry)) problems.push("the worker entry does not exist");
  if (problems.length === 0 && !existsSync(options.chromiumExecutable)) problems.push("the browser executable does not exist");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(options.sessionOrigin ?? "")) problems.push("sessionOrigin is not an https origin");
  const setpriv = process.platform === "linux" ? (SETPRIV.find((p) => existsSync(p)) ?? null) : null;
  if (process.platform === "linux" && setpriv === null) problems.push("setpriv (util-linux) is missing: a worker's end could not be bound to its host's");
  if (typeof options.corePackageHash !== "string" || !/^[0-9a-f]{64}$/.test(options.corePackageHash)) problems.push("corePackageHash is not a SHA-256 hex digest");
  const horizon = options.creationHorizonSeconds ?? 60;
  if (!Number.isSafeInteger(horizon) || horizon < 1) problems.push("creationHorizonSeconds is a positive whole number");
  const heaps = [options.workerHeapMegabytes ?? 1024, options.coreHeapMegabytes ?? 2048];
  const reserve = options.browserReserveBytes ?? 1024 * MIB;
  if (!heaps.every((n) => Number.isSafeInteger(n) && n >= 64) || !Number.isSafeInteger(reserve) || reserve < 0) problems.push("heap sizes are whole megabytes of at least 64");
  if (problems.length > 0) throw new TypeError(`${LOCAL_PROCESS_HOST}: ${problems.join("; ")}`);
  mkdirSync(join(options.hostRoot, "jobs"), { recursive: true });
  mkdirSync(options.scratchRoot, { recursive: true });
  const hostRoot = realpathSync.native(options.hostRoot);
  const scratchRoot = realpathSync.native(options.scratchRoot);
  const codeRoots = options.codeRoots.map((p) => realpathSync.native(p));
  // a worker reads its code roots: neither the host's records nor any attempt's scratch may be inside one, nor one inside the other
  for (const root of codeRoots) {
    for (const [name, private_] of [["hostRoot", hostRoot], ["scratchRoot", scratchRoot]] as const) {
      if (isInside(root, private_) || isInside(private_, root)) throw new TypeError(`${LOCAL_PROCESS_HOST}: ${name} overlaps a code root the worker reads`);
    }
  }
  if (isInside(hostRoot, scratchRoot) || isInside(scratchRoot, hostRoot)) throw new TypeError(`${LOCAL_PROCESS_HOST}: hostRoot and scratchRoot overlap`);
  if (process.platform !== "win32" && Buffer.byteLength(scratchRoot) > BROWSER_SOCKET_ROOT_MAX_BYTES) {
    throw new TypeError(`${LOCAL_PROCESS_HOST}: scratchRoot is longer than ${BROWSER_SOCKET_ROOT_MAX_BYTES} bytes, too long for the browser's socket path`);
  }
  return { hostRoot, scratchRoot, codeRoots, setpriv };
}

export class LocalProcessWorkerHost implements WorkerHostPort {
  readonly evidenceClass: WorkerHostEvidenceClass = EVIDENCE;
  readonly host = LOCAL_PROCESS_HOST;
  readonly creationHorizonSeconds: number;
  readonly #o: LocalProcessWorkerHostOptions;
  readonly #roots: Roots;
  readonly #lock: HostRootLock;
  readonly #journal: JobJournal;
  readonly #live = new Map<string, Live>();
  readonly #pending = new Map<string, PendingLaunch>();
  readonly #workerHeap: number;
  readonly #coreHeap: number;
  readonly #browserReserve: number;
  #stopped = false;

  /**
   * Opens a host over its roots: refuses an incomplete or unsafe configuration, takes the root's lock (HostRootInUse while another
   * live host holds it), reads the root's records and ends the previous host's unfinished jobs (HOST_RESTARTED).
   */
  static async open(options: LocalProcessWorkerHostOptions): Promise<LocalProcessWorkerHost> {
    const roots = configured(options);
    const lock = await acquireHostRootLock(roots.hostRoot);
    try {
      return new LocalProcessWorkerHost(options, roots, lock, new JobJournal(join(roots.hostRoot, "jobs")));
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  private constructor(options: LocalProcessWorkerHostOptions, roots: Roots, lock: HostRootLock, journal: JobJournal) {
    this.#o = options;
    this.#roots = roots;
    this.#lock = lock;
    this.#journal = journal;
    this.creationHorizonSeconds = options.creationHorizonSeconds ?? 60;
    this.#workerHeap = options.workerHeapMegabytes ?? 1024;
    this.#coreHeap = options.coreHeapMegabytes ?? 2048;
    this.#browserReserve = options.browserReserveBytes ?? 1024 * MIB;
    // the previous holder of the root is gone (its lock is released only by its end): what it left unfinished ends here
    for (const record of journal.unfinished()) {
      record.state = "FAILED";
      record.cause = "WORKER_CRASHED";
      record.note = "HOST_RESTARTED";
      record.endedAtMs = options.clock.nowMs();
      journal.write(record);
      this.#removeBrowserTemp(record.identity);
    }
  }

  // --- the port -----------------------------------------------------------------------------------------------------------------

  async launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchResult> {
    this.#serving();
    const identity = spec.identity;
    const answer = (outcome: WorkerLaunchResult["outcome"], reason: string | null): WorkerLaunchResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome, reason });
    const problem = this.#specProblem(spec);
    if (problem !== null) return answer("REFUSED", problem);
    const known = this.#journal.get(identity);
    if (known !== null) return known.note === CANCELLED_BEFORE_CREATE ? answer("REFUSED", "IDENTITY_TERMINATED") : answer("ALREADY_EXISTS", null);
    // a launch of the same identity already under way: this one is its redelivery, answered by what the first one did
    const under = this.#pending.get(identity);
    if (under !== undefined) {
      const first = await under.answer;
      return first.outcome === "LAUNCHED" ? answer("ALREADY_EXISTS", null) : first;
    }
    const pending: PendingLaunch = { abandoned: false, answer: this.#create(spec, this.#o.clock.nowMs(), () => pending.abandoned, answer) };
    this.#pending.set(identity, pending);
    try {
      return await pending.answer;
    } finally {
      this.#pending.delete(identity);
    }
  }

  /**
   * Reads the control plane's records for the launch, bounded by half the creation horizon from the launch's own start, then — in one
   * synchronous step, so nothing interleaves — creates the job durably and starts its worker. A read that fails, outlasts its bound or
   * whose identity was terminated meanwhile creates nothing (B08 then observes, and only NOT_FOUND past the horizon proves no effect).
   */
  async #create(spec: WorkerLaunchSpec, began: number, abandoned: () => boolean, answer: (outcome: WorkerLaunchResult["outcome"], reason: string | null) => WorkerLaunchResult): Promise<WorkerLaunchResult> {
    const identity = spec.identity;
    const boundMs = Math.floor((this.creationHorizonSeconds * 1000) / 2);
    const reads = await new Promise<AttemptTicketReads>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${LOCAL_PROCESS_HOST}: the attempt's records were not read within ${boundMs} ms; nothing was created`)), boundMs);
      timer.unref();
      this.#o.tickets.read(spec).then(
        (r) => (clearTimeout(timer), resolve(r)),
        (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
      );
    });
    if (abandoned() || this.#stopped || this.#o.clock.nowMs() - began >= boundMs) throw new Error(`${LOCAL_PROCESS_HOST}: the launch was abandoned before its create; nothing was created`);
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
    // the create: durable before the worker exists (a write that throws created nothing), then the start
    const record = this.#firstRecord(spec, bytes);
    this.#journal.write(record);
    try {
      this.#start(spec, bytes, record);
    } catch {
      // nothing could be started (the attempt's directory, the spawn): the job ends here rather than stay queued
      this.#close(record, "FAILED", "WORKER_ERROR", "START_FAILED");
    }
    return answer("LAUNCHED", null);
  }

  async observe(identity: string): Promise<WorkerObservation> {
    this.#serving();
    const record = this.#job(identity);
    return Object.freeze({
      evidenceClass: EVIDENCE,
      identity,
      state: record === null ? "NOT_FOUND" : (record.state as WorkerObservedState),
      lastHeartbeatAt: record?.lastHeartbeatMs == null ? null : this.#instant(record.lastHeartbeatMs),
      manifest: record?.manifest ?? null,
      cause: record?.cause ?? null,
      resources: record === null || record.startedAtMs === null ? null : this.#resourcesOf(record),
      observedAt: this.#o.clock.now(),
    });
  }

  async terminate(identity: string): Promise<WorkerTerminationResult> {
    this.#serving();
    const answer = (outcome: WorkerTerminationResult["outcome"]): WorkerTerminationResult => Object.freeze({ evidenceClass: EVIDENCE, identity, outcome });
    // no launch accepts anything but an attempt's identity, so nothing exists, or can ever exist, under another name
    if (!isAttemptIdentity(identity)) return answer("NOT_FOUND");
    const live = this.#live.get(identity);
    if (live !== undefined) {
      if (TERMINAL.has(live.record.state)) return answer("ALREADY_TERMINAL");
      this.#end(live, "TERMINATED");
      return answer("TERMINATED");
    }
    const record = this.#journal.get(identity);
    if (record !== null) {
      if (record.note === CANCELLED_BEFORE_CREATE) return answer("NOT_FOUND");
      if (TERMINAL.has(record.state)) return answer("ALREADY_TERMINAL");
      // a record that is neither ended nor live cannot stand (every create starts or ends in its own step): ended here all the same
      this.#close(record, "TERMINATED", null, "TERMINATED_BY_HOST");
      return answer("TERMINATED");
    }
    // absent: a launch still reading its records is abandoned (it then creates nothing), and the identity is taken for good, durably,
    // before NOT_FOUND is answered — no launch can create it afterwards, on this host or a later one
    const pending = this.#pending.get(identity);
    if (pending !== undefined) pending.abandoned = true;
    const now = this.#o.clock.nowMs();
    this.#journal.write({ host: LOCAL_PROCESS_HOST, identity, ticketDigest: "0".repeat(64), state: "TERMINATED", pid: null, createdAtMs: now, startedAtMs: null, endedAtMs: now, lastHeartbeatMs: null, cause: null, note: CANCELLED_BEFORE_CREATE, manifest: null, refusal: null, peakScratchBytes: 0, peakMemoryBytes: 0, flags: [], hardMemoryBytes: 0, hardScratchBytes: 0 });
    return answer("NOT_FOUND");
  }

  async resources(identity: string): Promise<WorkerResourceReport> {
    this.#serving();
    const record = this.#job(identity);
    return record === null
      ? Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "NOT_FOUND" as const })
      : Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "REPORTED" as const, state: record.state as WorkerObservedState, resources: this.#resourcesOf(record) });
  }

  // --- beyond the port ------------------------------------------------------------------------------------------------------------

  /** The host's mirror of the lease's cancellation into the worker's channel (D8-CANCEL-1; D8-CEX-7 has no port for it). */
  signal(identity: string, state: "CANCELLED" | "FENCED"): boolean {
    const live = this.#live.get(identity);
    if (live === undefined || live.ended !== null || TERMINAL.has(live.record.state) || !this.#writable(live)) return false;
    if (live.signalled !== state) {
      live.signalled = state;
      this.#write(live, { t: "signal", state });
    }
    return true;
  }

  /** Resolves when the worker of `identity` has exited (tests; a deployment observes). */
  async settled(identity: string): Promise<LocalJobRecord | null> {
    await this.#live.get(identity)?.settled;
    return this.#job(identity);
  }

  /** The record of `identity` (evidence and tests). */
  record(identity: string): LocalJobRecord | null {
    return this.#job(identity);
  }

  /** The broker's refusals for a live or finished job of this host (evidence: operation and token). */
  refusals(identity: string): readonly { readonly op: string; readonly code: string }[] {
    return this.#live.get(identity)?.broker.refusals() ?? [];
  }

  /** The last lines a worker of this host wrote to its error stream (in memory only, never recorded: an operator's diagnostic). */
  diagnostics(identity: string): string | null {
    return this.#live.get(identity)?.stderrTail ?? null;
  }

  /** How many calls of a live worker the host holds now (evidence and tests: never more than CALLS_HELD). */
  heldCalls(identity: string): number | null {
    return this.#live.get(identity)?.held ?? null;
  }

  /** Every job this host started that is still running. */
  running(): readonly string[] {
    return [...this.#live.values()].filter((l) => !TERMINAL.has(l.record.state)).map((l) => l.record.identity);
  }

  /** Ends every running worker (their records say TERMINATED), waits for their ends, and releases the root. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const pending of this.#pending.values()) pending.abandoned = true;
    const lives = [...this.#live.values()];
    for (const live of lives) if (!TERMINAL.has(live.record.state)) this.#end(live, "TERMINATED");
    const waited = Promise.all(lives.map((l) => l.settled));
    await Promise.race([waited, new Promise((r) => setTimeout(r, STOP_WAIT_MS).unref())]);
    await this.#lock.release();
  }

  /** The exact command line a worker of `spec` would run (evidence of the confinement). */
  flagsOf(spec: WorkerLaunchSpec, ticketDigest: Sha256Hex): string[] {
    const attemptDir = attemptScratchDirectoryOf(this.#roots.scratchRoot, spec.capability.attemptId);
    const browser = [dirname(this.#o.chromiumExecutable), dirname(realpathSync.native(this.#o.chromiumExecutable))];
    const probes = process.platform === "linux" ? LINUX_RUNTIME_PROBES : [];
    const reads = [...new Set([...this.#roots.codeRoots, ...browser, ...probes]), attemptDir];
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
      this.#roots.scratchRoot,
      "--chromium",
      this.#o.chromiumExecutable,
      "--browser-temp",
      browserTempDirectoryOf(this.#roots.scratchRoot, spec.capability.attemptId),
      "--core-heap-mb",
      String(this.#coreHeap),
      "--storage-evidence",
      this.#o.storage.evidenceClass,
    ];
  }

  // --- internals ------------------------------------------------------------------------------------------------------------------

  /** A stopped host answers nothing more about the root: another host may hold it now (a transient failure for its caller). */
  #serving(): void {
    if (this.#stopped) throw Object.assign(new Error(`${LOCAL_PROCESS_HOST}: the host is stopped; another host may hold its root`), { code: "HOST_STOPPED", transient: true });
  }

  /** A job's record: null for an absent identity or a tombstone; throws HostRecordUnreadable for one the root could not read. */
  #job(identity: string): LocalJobRecord | null {
    if (!isAttemptIdentity(identity)) return null;
    const record = this.#journal.get(identity);
    return record === null || record.note === CANCELLED_BEFORE_CREATE ? null : record;
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
    const digest = attemptTicketDigestOf(bytes);
    return {
      host: LOCAL_PROCESS_HOST,
      identity: spec.identity,
      ticketDigest: digest,
      state: "QUEUED",
      pid: null,
      createdAtMs: this.#o.clock.nowMs(),
      startedAtMs: null,
      endedAtMs: null,
      lastHeartbeatMs: null,
      cause: null,
      note: null,
      manifest: null,
      refusal: null,
      peakScratchBytes: 0,
      peakMemoryBytes: 0,
      flags: this.flagsOf(spec, digest),
      hardMemoryBytes: spec.limits.hardMemoryBytes,
      hardScratchBytes: spec.limits.hardScratchBytes,
    };
  }

  #start(spec: WorkerLaunchSpec, bytes: Uint8Array, record: LocalJobRecord): void {
    const env: Record<string, string> = {};
    // Windows resolves its system libraries through SystemRoot; nothing else of the host's environment reaches the worker
    const systemRoot = process.env["SystemRoot"];
    if (systemRoot !== undefined) env["SystemRoot"] = systemRoot;
    // the attempt's directory exists before the worker starts: the permission model grants a directory's contents only to a path that
    // is a directory when the process starts (the worker's scratch store then empties and re-creates it)
    mkdirSync(attemptScratchDirectoryOf(this.#roots.scratchRoot, spec.capability.attemptId), { recursive: true });
    mkdirSync(browserTempDirectoryOf(this.#roots.scratchRoot, spec.capability.attemptId), { recursive: true, mode: 0o700 });
    // Linux: setpriv sets the parent-death signal and executes Node in place (the pid stays the worker's)
    const [command, args] = this.#roots.setpriv === null ? [process.execPath, record.flags] : [this.#roots.setpriv, ["--pdeathsig", "KILL", "--", process.execPath, ...record.flags]];
    const child = spawn(command, args, {
      // the scratch root, which the worker cannot read: on Windows a process's working directory cannot be removed, and the worker
      // removes its attempt's directory when the attempt ends
      cwd: this.#roots.scratchRoot,
      env,
      // fd 3: the worker's channel, a plain pipe the host reads in its own frames (never Node's IPC). Windows: an overlapped pipe, or
      // the worker's pending read would hold its own writes back (synchronous I/O on one pipe handle is serialized)
      stdio: ["ignore", "ignore", "pipe", process.platform === "win32" ? "overlapped" : "pipe"],
      // POSIX: the worker leads its own process group, which this host ends while the worker is its unreaped child. Windows: not
      // detached, so the worker is in this process's kill-on-close job object and ends with it
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.on("error", () => {
      // a spawn that failed: its exit (or the missing pid below) records it
    });
    if (child.pid === undefined) throw new Error("the worker could not be spawned");
    const channel = (child.stdio[3] ?? null) as Socket | null;
    const broker = new AttemptStorageBroker({ capability: spec.capability, storage: this.#o.storage, uploads: this.#o.uploads, origin: this.#o.sessionOrigin, maxObjectBytes: spec.limits.hardScratchBytes });
    let exited: () => void = () => undefined;
    const live: Live = { record, child, channel, decoder: new FrameDecoder(), broker, result: null, ended: null, stderrTail: "", settled: new Promise<void>((resolve) => (exited = resolve)), timer: null, held: 0, signalled: null };
    this.#live.set(spec.identity, live);
    record.pid = child.pid;
    record.state = "RUNNING";
    record.startedAtMs = this.#o.clock.nowMs();
    record.lastHeartbeatMs = record.startedAtMs;
    this.#persist(record);

    child.stderr?.on("data", (chunk: Buffer) => {
      live.stderrTail = (live.stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    channel?.on("data", (chunk: Buffer) => {
      try {
        live.decoder.push(chunk);
      } catch {
        return this.#violation(live);
      }
      this.#pump(live);
    });
    channel?.on("error", () => channel.destroy());
    // the worker's end, once what it wrote before it exited has been read (its channel closed, or after CHANNEL_DRAIN_MS: a process it
    // started may hold the pipe and cannot hold the end back)
    child.on("exit", () => {
      // the worker is reaped now: what it left in its process group goes (POSIX). Its group's number stays its own while any member
      // lives; it could name another group only once every member is gone and the number has been reused (B14-A-recovery.md §8)
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // no member left
        }
      }
      if (channel === null || channel.destroyed || channel.readableEnded) return this.#exited(live, exited);
      const drained = setTimeout(() => channel.destroy(), CHANNEL_DRAIN_MS);
      channel.once("close", () => {
        clearTimeout(drained);
        this.#exited(live, exited);
      });
    });

    // the deadline: the earlier of the execution deadline and the wall clock, then a grace for the worker's own end
    const wall = Math.min(spec.limits.wallClockMs, this.#o.maxWallClockMs ?? Number.MAX_SAFE_INTEGER);
    const until = Math.min(Date.parse(spec.subject.executionDeadlineAt) - this.#o.clock.nowMs(), wall) + (this.#o.terminationGraceMs ?? 5_000);
    live.timer = setTimeout(() => this.#end(live, "DEADLINE"), Math.max(0, Math.min(until, 2_147_483_647)));
    live.timer.unref();
    this.#write(live, { t: "ticket", protocol: WORKER_PROTOCOL_VERSION, bytes });
  }

  /**
   * Reads the worker's messages while it holds fewer than CALLS_HELD calls; with that many held it reads nothing more — its pipe is
   * paused, so neither the channel nor the decoder holds more than one frame and one read beyond them — until a reply leaves.
   */
  #pump(live: Live): void {
    if (live.channel === null || live.channel.destroyed) return;
    while (live.held < CALLS_HELD) {
      let raw: Record<string, unknown> | null;
      try {
        raw = live.decoder.next();
      } catch {
        return this.#violation(live);
      }
      if (raw === null) break;
      // normalized at once: only the protocol's own fields are kept while a call waits
      const message = normalizeWorkerMessage(raw);
      if (message === null) return this.#violation(live);
      if (message.t === "beat") this.#heartbeat(live);
      else if (message.t === "result") live.result ??= message.result;
      else {
        live.held += 1;
        void this.#onCall(live, message);
      }
    }
    if (live.held >= CALLS_HELD) live.channel.pause();
    else if (live.channel.isPaused()) live.channel.resume();
  }

  /** A frame or message outside the protocol: the attempt ends (FAILED WORKER_ERROR), never this process. */
  #violation(live: Live): void {
    live.channel?.destroy();
    this.#end(live, "CHANNEL_PROTOCOL_VIOLATION");
  }

  async #onCall(live: Live, message: Extract<WorkerMessage, { t: "call" }> | InvalidWorkerMessage): Promise<void> {
    if (message.t === "invalid") {
      live.broker.noteMalformed();
      return this.#reply(live, { t: "reply", id: message.id, ok: false, error: { code: message.problem, message: "the call is not one of the protocol's", transient: false } });
    }
    this.#heartbeat(live);
    const call = message.call;
    try {
      let value: unknown = null;
      if (call.op === "stage") await this.#o.hooks?.atStage?.(live.record.identity, call.stage);
      else {
        await this.#o.hooks?.beforeCall?.(live.record.identity, call);
        value = await live.broker.handle(call);
      }
      this.#reply(live, { t: "reply", id: message.id, ok: true, value });
    } catch (error) {
      this.#reply(live, { t: "reply", id: message.id, ok: false, error: callErrorOf(error) });
    }
  }

  /** Answers a held call; the call is released when its reply has left this process (or cannot), and reading goes on. */
  #reply(live: Live, message: HostMessage): void {
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      live.held -= 1;
      this.#pump(live);
    };
    if (!this.#writable(live)) return release();
    this.#write(live, message, release);
  }

  #writable(live: Live): boolean {
    return live.channel !== null && !live.channel.destroyed && live.channel.writable;
  }

  /** Writes one message to the worker's channel; `written` once it has left this process, or failed to. */
  #write(live: Live, message: HostMessage, written: () => void = () => undefined): void {
    let frame: Buffer;
    try {
      frame = encodeFrame(message);
    } catch {
      // a reply the protocol cannot carry (a provider's answer past a frame): the call fails, never this process
      if (message.t !== "reply") return written();
      frame = encodeFrame({ t: "reply", id: message.id, ok: false, error: { code: "PROVIDER_ERROR", message: "the answer does not fit the channel", transient: false } });
    }
    try {
      live.channel?.write(frame, () => written());
    } catch {
      // the worker is gone; its exit records it
      written();
    }
  }

  /** The worker's sign of life (in memory: a restarted host ends the job anyway). */
  #heartbeat(live: Live): void {
    live.record.lastHeartbeatMs = this.#o.clock.nowMs();
  }

  /**
   * The host ends a job: the broker refuses everything at once, the worker's whole tree is killed at once (it is still this host's
   * unreaped child), the end is recorded, and only then is the provider's side cleaned (bounded, in the background).
   */
  #end(live: Live, how: EndReason): void {
    if (live.ended !== null || TERMINAL.has(live.record.state)) return;
    live.ended = how;
    live.broker.close(how === "DEADLINE" ? "DEADLINE_EXCEEDED" : "TERMINATED_BY_HOST");
    if (unreaped(live.child)) {
      killProcessTree(live.child.pid as number);
      try {
        live.child.kill("SIGKILL");
      } catch {
        // already ending
      }
    }
    if (how === "DEADLINE") this.#close(live.record, "FAILED", "DEADLINE_EXCEEDED", "DEADLINE");
    else if (how === "CHANNEL_PROTOCOL_VIOLATION") this.#close(live.record, "FAILED", "WORKER_ERROR", how);
    else this.#close(live.record, "TERMINATED", null, "TERMINATED_BY_HOST");
    void live.broker.revoke(how === "DEADLINE" ? "DEADLINE_EXCEEDED" : "TERMINATED_BY_HOST");
  }

  /** The worker exited: its result, or the host's own reading of an end without one; then its browser's directory goes. */
  #exited(live: Live, settle: () => void): void {
    if (live.timer !== null) clearTimeout(live.timer);
    live.broker.close("WORKER_EXITED");
    const record = live.record;
    if (!TERMINAL.has(record.state)) {
      const result = live.result;
      if (result !== null) {
        record.manifest = result.manifest;
        record.refusal = result.refusal;
        record.peakScratchBytes = result.peakScratchBytes;
        record.peakMemoryBytes = result.peakMemoryBytes;
        // a success names its manifest, or it is no success
        if (result.state === "SUCCEEDED" && result.manifest !== null) this.#close(record, "SUCCEEDED", null, null);
        else this.#close(record, "FAILED", result.state === "FAILED" ? (result.cause ?? "WORKER_ERROR") : "WORKER_ERROR", result.state === "FAILED" ? null : "RESULT_WITHOUT_MANIFEST");
      } else {
        const heap = /heap out of memory|Allocation failed|ERR_WORKER_OUT_OF_MEMORY/i.test(live.stderrTail);
        this.#close(record, "FAILED", "WORKER_CRASHED", heap ? "MEMORY_EXHAUSTED" : "NO_RESULT");
      }
    }
    this.#removeBrowserTemp(record.identity);
    settle();
    void live.broker.revoke("WORKER_EXITED");
  }

  /** Records a job's end, once: the first end stands (every caller checks; this is the one place an end is written). */
  #close(record: LocalJobRecord, state: "SUCCEEDED" | "FAILED" | "TERMINATED", cause: LocalJobRecord["cause"], note: string | null): void {
    if (TERMINAL.has(record.state)) return;
    record.state = state;
    record.cause = cause;
    record.note = note;
    record.endedAtMs = this.#o.clock.nowMs();
    this.#persist(record);
  }

  /**
   * Writes a held record's change. The change already holds here (this host answers from it); a write that fails leaves the previous
   * version on disk, which only a later host reads — and a later host ends whatever that version left unfinished.
   */
  #persist(record: LocalJobRecord): void {
    try {
      this.#journal.write(record);
    } catch {
      // the previous version stands on disk; see above
    }
  }

  /** The browser's temporary directory of a job, once its tree is gone (the host's own; the janitor knows only the attempt's scratch). */
  #removeBrowserTemp(identity: string): void {
    try {
      rmSync(browserTempDirectoryOf(this.#roots.scratchRoot, identity.slice("kauro-attempt-".length)), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // still held by a browser process ending: the scratch root's own cleanup takes it later
    }
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
