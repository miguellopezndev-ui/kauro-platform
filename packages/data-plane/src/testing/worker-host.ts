/**
 * @kauro/data-plane/testing/worker-host — TEST ONLY (architecture rule testOnlySubpaths; no composition root binds it).
 *
 * CONTRACT FAKE — SIMULATED. The single labelled contract fake of `WorkerHostPort` (owner: mandate B08-WORKER-HOST; design
 * docs/design/B08-audit-approval-jobs.md §10, D8-HOST-1, D8-ATT-2, D8-JAN-1, D8-FAKE-1). Every answer, record and call-log entry
 * reports `evidenceClass: "SIMULATED"` and names the token `contract-fake-worker-host` (21 "Evidence classes": SIMULATED is never
 * EXECUTED_PROVIDER); the real host is B14's (Cloud Batch). A subpath of its own because `@kauro/data-plane/testing` is B07's
 * closed inventory (`tools/test/b07-stage-one.test.mjs`).
 *
 * It is a local executor: each provider job runs the bound `ExecutionEnvelopePort` (tests bind B08-CORE-PORTS'
 * ContractFakeMigrationCore) inside the attempt envelope made of the REAL host I/O of this package — AttemptScratchStore under the
 * job's scratch budget, FencedArtifactWriter and GenerationSourceReader over the bound ObjectStoragePort (tests bind B07's
 * ContractFakeObjectStorage and the holder side of its sessions). It consumes both fakes and copies neither. The host decides the
 * job's cause from its own envelope first (a scratch or writer failure wins over whatever the core answers), and writes the staged
 * manifest itself only after the core COMPLETED with exactly the artifacts the writer closed.
 *
 * What it models (07 "deterministic provider job identity"; 10 "Provider adapter contract"):
 * - create by identity: one job per `kauro-attempt-<attemptId>` for good; a second launch is ALREADY_EXISTS; a spec whose identity,
 *   capability and subject are not one attempt's is REFUSED and creates nothing;
 * - scripted launch answers: REFUSED; TIMEOUT_AFTER_CREATE (AMBIGUOUS, the job exists); TIMEOUT_BEFORE_CREATE (AMBIGUOUS, the create
 *   may still land — `landPendingCreation` — until the creation horizon on the host's clock, never after it);
 * - heartbeats: the worker's last sign of life (every cancellation check and step) on the host's clock;
 * - termination of exactly one identity (a killed worker writes nothing more and leaves its scratch); a scripted UNCERTAIN answer;
 *   an old worker that survives its termination and finishes into its own prefix;
 * - scripted crashes at hold points (the agent dies with its VM up, or the host notices), leaving prefix and scratch;
 * - VM, disk and cost reports from the host's clock: runtime from start to end (or to now while the VM runs);
 * - hold points (`start`, `cancellation`, `manifest`, `finish`) and `settled(identity)`, so tests interleave without sleeping;
 * - the control plane's mirror of cancellation into the lease, as `signal(identity, CANCELLED | FENCED)`.
 */
import { attemptCapabilityProblems, attemptIdentityOf, isAttemptIdentity } from "@kauro/application";
import type {
  CancellationChannel,
  CancellationState,
  ExecutionEnvelopePort,
  ExecutionOutcome,
  ObjectStoragePort,
  ProviderEvidenceClass,
  ResumableUploadPort,
  WorkerFailureCause,
  WorkerHostPort,
  WorkerLaunchResult,
  WorkerLaunchSpec,
  WorkerManifestReference,
  WorkerObservation,
  WorkerObservedState,
  WorkerResourceReport,
  WorkerResources,
  WorkerTerminationResult,
} from "@kauro/application";
import type { UtcInstant } from "@kauro/contracts";
import type { Clock } from "@kauro/domain";
import { toUtcInstant } from "@kauro/domain";
import { FencedArtifactWriter } from "../attempt/artifact-writer.js";
import { terminalCauseOf } from "../attempt/failure.js";
import { AttemptScratchStore } from "../attempt/scratch-store.js";
import { GenerationSourceReader } from "../attempt/source-reader.js";

export const CONTRACT_FAKE_WORKER_HOST_TOKEN = "contract-fake-worker-host";
export const CONTRACT_FAKE_WORKER_HOST_MACHINE_TYPE = "contract-fake-worker-host-standard-8";
export const CONTRACT_FAKE_WORKER_HOST_SESSION_ORIGIN = "https://contract-fake-worker-host.invalid";
const EVIDENCE: ProviderEvidenceClass = "SIMULATED";

export type WorkerHostOperation = "launch" | "observe" | "terminate" | "resources";
/** Where a worker can be held or crashed: before it starts, at each cancellation check, before its manifest, before it reports. */
export type WorkerHostPoint = "start" | "cancellation" | "manifest" | "finish";
export type ScriptedLaunch = "REFUSED" | "TIMEOUT_AFTER_CREATE" | "TIMEOUT_BEFORE_CREATE";

export interface WorkerHostMachine {
  readonly machineType: string;
  readonly vcpus: number;
  readonly memoryBytes: number;
  /** The VM's price, millionths of the currency per hour. */
  readonly vmMicrosPerHour: number;
  /** The disk's price per GiB, millionths of the currency per hour. */
  readonly diskMicrosPerGibHour: number;
  readonly currency: string;
}

export interface ContractFakeWorkerHostOptions {
  readonly core: ExecutionEnvelopePort;
  readonly storage: ObjectStoragePort;
  readonly uploads: ResumableUploadPort;
  /** A real directory: each job's AttemptScratchStore lives under it. */
  readonly scratchRoot: string;
  /** The host's clock (default the system clock); never a platform lifecycle instant. */
  readonly clock?: Clock;
  readonly creationHorizonSeconds?: number;
  readonly machine?: Partial<WorkerHostMachine>;
  readonly uploadChunkBytes?: number;
}

export interface WorkerHostCall {
  readonly sequence: number;
  readonly operation: WorkerHostOperation;
  readonly identity: string;
  readonly outcome: string;
  readonly at: UtcInstant;
  readonly host: typeof CONTRACT_FAKE_WORKER_HOST_TOKEN;
  readonly evidenceClass: ProviderEvidenceClass;
}

export interface WorkerHostHold {
  readonly reached: Promise<void>;
  release(): void;
}

/** One provider job as the host holds it (test inspection). */
export interface WorkerJobView {
  readonly identity: string;
  readonly state: WorkerObservedState;
  /** Launch requests of this identity that were not refused, the one that created it included. */
  readonly createRequests: number;
  readonly cause: WorkerFailureCause | null;
  readonly manifest: WorkerManifestReference | null;
  readonly lastHeartbeatAt: UtcInstant | null;
  readonly host: typeof CONTRACT_FAKE_WORKER_HOST_TOKEN;
  readonly evidenceClass: ProviderEvidenceClass;
}

const DEFAULT_MACHINE: WorkerHostMachine = Object.freeze({
  machineType: CONTRACT_FAKE_WORKER_HOST_MACHINE_TYPE,
  vcpus: 8,
  memoryBytes: 32 * 2 ** 30,
  vmMicrosPerHour: 268_000,
  diskMicrosPerGibHour: 55,
  currency: "USD",
});

const SYSTEM_CLOCK: Clock = Object.freeze({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() });

interface HoldRecord {
  readonly signal: () => void;
  readonly release: () => void;
  readonly released: Promise<void>;
}

interface Job {
  readonly identity: string;
  readonly spec: WorkerLaunchSpec;
  state: WorkerObservedState;
  cause: WorkerFailureCause | null;
  manifest: WorkerManifestReference | null;
  startedMs: number | null;
  endedMs: number | null;
  lastHeartbeatMs: number | null;
  killed: boolean;
  scratch: AttemptScratchStore | null;
  peakScratchBytes: number;
  settled: Promise<void>;
}

/** Thrown inside a run the host killed or crashed: it unwinds the run and is never a job's cause. */
class RunStopped extends Error {
  constructor(readonly how: "KILLED" | "CRASHED") {
    super(`${CONTRACT_FAKE_WORKER_HOST_TOKEN}: the worker was ${how.toLowerCase()}`);
  }
}

export class ContractFakeWorkerHost implements WorkerHostPort {
  readonly evidenceClass: ProviderEvidenceClass = EVIDENCE;
  readonly contractFake = true;
  readonly host = CONTRACT_FAKE_WORKER_HOST_TOKEN;
  readonly creationHorizonSeconds: number;
  readonly machine: WorkerHostMachine;
  readonly #options: ContractFakeWorkerHostOptions;
  readonly #clock: Clock;
  readonly #jobs = new Map<string, Job>();
  readonly #requests = new Map<string, number>();
  readonly #pending = new Map<string, { readonly spec: WorkerLaunchSpec; readonly requestedMs: number }>();
  readonly #launchScripts = new Map<string, ScriptedLaunch>();
  readonly #terminationScripts = new Map<string, { readonly applied: boolean }>();
  readonly #holds = new Map<string, HoldRecord[]>();
  /** The hold each worker is waiting at right now. */
  readonly #waiting = new Map<string, HoldRecord>();
  readonly #crashes = new Map<string, "RUNNING" | "FAILED">();
  readonly #survivors = new Map<string, "TERMINATED" | "SUCCEEDED">();
  readonly #signals = new Map<string, CancellationState>();
  readonly #calls: WorkerHostCall[] = [];

  constructor(options: ContractFakeWorkerHostOptions) {
    this.#options = options;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.creationHorizonSeconds = options.creationHorizonSeconds ?? 300;
    if (!Number.isSafeInteger(this.creationHorizonSeconds) || this.creationHorizonSeconds < 1) throw new RangeError(`${this.host}: creationHorizonSeconds is a positive whole number`);
    this.machine = Object.freeze({ ...DEFAULT_MACHINE, ...options.machine });
  }

  // --- the port -----------------------------------------------------------------------------------------------------------------

  launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchResult> {
    const identity = spec.identity;
    const answer = (outcome: WorkerLaunchResult["outcome"], reason: string | null, logged: string): Promise<WorkerLaunchResult> => {
      this.#log("launch", identity, logged);
      return Promise.resolve(Object.freeze({ evidenceClass: EVIDENCE, identity, outcome, reason }));
    };
    const problem = specProblem(spec);
    if (problem !== null) return answer("REFUSED", problem, `REFUSED ${problem}`);
    this.#requests.set(identity, (this.#requests.get(identity) ?? 0) + 1);
    if (this.#pending.has(identity)) this.landPendingCreation(identity);
    if (this.#jobs.has(identity)) return answer("ALREADY_EXISTS", null, "ALREADY_EXISTS");
    const script = this.#launchScripts.get(identity);
    this.#launchScripts.delete(identity);
    if (script === "REFUSED") {
      this.#requests.set(identity, (this.#requests.get(identity) ?? 1) - 1);
      return answer("REFUSED", "HOST_REFUSED", "REFUSED HOST_REFUSED");
    }
    if (script === "TIMEOUT_BEFORE_CREATE") {
      this.#pending.set(identity, { spec, requestedMs: this.#clock.nowMs() });
      return answer("AMBIGUOUS", "TIMEOUT", "AMBIGUOUS (not created)");
    }
    this.#create(spec);
    return script === "TIMEOUT_AFTER_CREATE" ? answer("AMBIGUOUS", "TIMEOUT", "AMBIGUOUS (created)") : answer("LAUNCHED", null, "LAUNCHED");
  }

  observe(identity: string): Promise<WorkerObservation> {
    this.#expirePending(identity);
    const job = this.#jobs.get(identity);
    const observation: WorkerObservation = Object.freeze({
      evidenceClass: EVIDENCE,
      identity,
      state: job?.state ?? "NOT_FOUND",
      lastHeartbeatAt: job?.lastHeartbeatMs == null ? null : toUtcInstant(job.lastHeartbeatMs),
      manifest: job?.manifest ?? null,
      cause: job?.cause ?? null,
      resources: job === undefined || job.startedMs === null ? null : this.#resourcesOf(job),
      observedAt: this.#clock.now(),
    });
    this.#log("observe", identity, observation.state);
    return Promise.resolve(observation);
  }

  terminate(identity: string): Promise<WorkerTerminationResult> {
    const job = this.#jobs.get(identity);
    const answer = (outcome: WorkerTerminationResult["outcome"]): Promise<WorkerTerminationResult> => {
      this.#log("terminate", identity, outcome);
      return Promise.resolve(Object.freeze({ evidenceClass: EVIDENCE, identity, outcome }));
    };
    if (job === undefined) return answer("NOT_FOUND");
    if (job.state === "SUCCEEDED" || job.state === "FAILED" || job.state === "TERMINATED") return answer("ALREADY_TERMINAL");
    const scripted = this.#terminationScripts.get(identity);
    this.#terminationScripts.delete(identity);
    if (scripted === undefined || scripted.applied) this.#kill(job);
    return answer(scripted === undefined ? "TERMINATED" : "UNCERTAIN");
  }

  resources(identity: string): Promise<WorkerResourceReport> {
    const job = this.#jobs.get(identity);
    const report: WorkerResourceReport =
      job === undefined
        ? Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "NOT_FOUND" as const })
        : Object.freeze({ evidenceClass: EVIDENCE, identity, outcome: "REPORTED" as const, state: job.state, resources: this.#resourcesOf(job) });
    this.#log("resources", identity, report.outcome);
    return Promise.resolve(report);
  }

  // --- test control and inspection ----------------------------------------------------------------------------------------------

  /** Scripts the answer of the next launch of `identity`. */
  scriptLaunch(identity: string, script: ScriptedLaunch): void {
    this.#launchScripts.set(identity, script);
  }

  /** Scripts the next termination of `identity` to answer UNCERTAIN, with (`applied`) or without its effect. */
  scriptTermination(identity: string, script: { readonly applied: boolean }): void {
    this.#terminationScripts.set(identity, script);
  }

  /** A hold point: the worker of `identity` signals `reached` at the next `point` and waits there until `release()`. */
  holdNext(point: WorkerHostPoint, identity: string): WorkerHostHold {
    let signal: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = holdKey(point, identity);
    this.#holds.set(key, [...(this.#holds.get(key) ?? []), { signal, release, released }]);
    return { reached, release };
  }

  /** The worker of `identity` dies at `point`: its VM stays up without heartbeats (RUNNING) or the host notices (FAILED). */
  crashAt(point: WorkerHostPoint, identity: string, leaves: "RUNNING" | "FAILED"): void {
    this.#crashes.set(holdKey(point, identity), leaves);
  }

  /** The worker of `identity` survives its termination: it keeps running, and after it finishes the host reports `reportsAfterFinish`. */
  survivesTermination(identity: string, script: { readonly reportsAfterFinish: "TERMINATED" | "SUCCEEDED" }): void {
    this.#survivors.set(identity, script.reportsAfterFinish);
  }

  /** What the worker's cancellation channel answers from now on (the control plane's mirror into the lease). */
  signal(identity: string, state: CancellationState): void {
    this.#signals.set(identity, state);
  }

  /** Lands a create that timed out, if its creation horizon has not passed on the host's clock; false when it never will. */
  landPendingCreation(identity: string): boolean {
    this.#expirePending(identity);
    const pending = this.#pending.get(identity);
    if (pending === undefined) return false;
    this.#pending.delete(identity);
    this.#create(pending.spec);
    return true;
  }

  /** Resolves when the worker of `identity` has stopped running (finished, failed, crashed or killed). */
  async settled(identity: string): Promise<WorkerJobView | null> {
    const job = this.#jobs.get(identity);
    if (job === undefined) return null;
    await job.settled;
    return this.#view(job);
  }

  jobs(): readonly WorkerJobView[] {
    return [...this.#jobs.values()].map((job) => this.#view(job));
  }

  calls(operation?: WorkerHostOperation): readonly WorkerHostCall[] {
    return this.#calls.filter((c) => operation === undefined || c.operation === operation);
  }

  // --- the executor ---------------------------------------------------------------------------------------------------------------

  #create(spec: WorkerLaunchSpec): void {
    const job: Job = {
      identity: spec.identity,
      spec,
      state: "QUEUED",
      cause: null,
      manifest: null,
      startedMs: null,
      endedMs: null,
      lastHeartbeatMs: null,
      killed: false,
      scratch: null,
      peakScratchBytes: 0,
      settled: Promise.resolve(),
    };
    this.#jobs.set(spec.identity, job);
    job.settled = this.#run(job);
  }

  async #run(job: Job): Promise<void> {
    const { spec } = job;
    try {
      await this.#at(job, "start");
      job.state = "RUNNING";
      job.startedMs = this.#clock.nowMs();
      this.#beat(job);
      const scratch = new AttemptScratchStore({ root: this.#options.scratchRoot, attemptId: spec.capability.attemptId, quotaBytes: spec.limits.scratchBudgetBytes });
      job.scratch = scratch;
      const cancellation: CancellationChannel = {
        check: async (): Promise<CancellationState> => {
          await this.#at(job, "cancellation");
          this.#beat(job);
          return this.#signals.get(job.identity) ?? "CONTINUE";
        },
      };
      const uploads: ResumableUploadPort = {
        writeChunk: (sessionRef, chunk, options) => {
          if (job.killed && !this.#survivors.has(job.identity)) return Promise.reject(new RunStopped("KILLED"));
          return this.#options.uploads.writeChunk(sessionRef, chunk, options);
        },
      };
      const writer = new FencedArtifactWriter({
        capability: spec.capability,
        storage: this.#options.storage,
        uploads,
        scratch,
        cancellation,
        origin: CONTRACT_FAKE_WORKER_HOST_SESSION_ORIGIN,
        timeoutMs: 30_000,
        ...(this.#options.uploadChunkBytes === undefined ? {} : { uploadChunkBytes: this.#options.uploadChunkBytes }),
      });
      const source = new GenerationSourceReader({ capability: spec.capability, storage: this.#options.storage });
      let outcome: ExecutionOutcome | null = null;
      let thrown: unknown = null;
      try {
        outcome = await this.#options.core.execute(spec.subject, { source, scratch, writer, cancellation, limits: spec.limits });
      } catch (error) {
        if (error instanceof RunStopped) throw error;
        thrown = error;
      }
      this.#stopIfKilled(job);
      // the host's own envelope decides first; then what the core threw; then what it answered
      const envelope = scratch.failure() ?? writer.failure() ?? source.failure();
      const cause: WorkerFailureCause | null =
        envelope !== null ? envelope.terminalCause : thrown !== null ? terminalCauseOf(thrown) : outcome === null || outcome.terminalCause === "COMPLETED" ? null : outcome.terminalCause;
      if (cause === null && outcome !== null && !sameArtifacts(outcome, writer)) {
        this.#finish(job, "FAILED", "WORKER_ERROR", null);
        return;
      }
      if (cause !== null) {
        this.#finish(job, "FAILED", cause, null);
        return;
      }
      await this.#at(job, "manifest");
      let manifest: WorkerManifestReference;
      try {
        manifest = await writer.writeManifest({ fence: spec.fence, inputBindingHash: spec.subject.inputBindingHash, declaredSummary: outcome?.reconciliationSummary ?? null });
      } catch (error) {
        if (error instanceof RunStopped) throw error;
        this.#stopIfKilled(job);
        this.#finish(job, "FAILED", terminalCauseOf(error), null);
        return;
      }
      await this.#at(job, "finish");
      this.#finish(job, "SUCCEEDED", null, manifest);
    } catch (error) {
      if (!(error instanceof RunStopped)) {
        this.#finish(job, "FAILED", terminalCauseOf(error), null);
        return;
      }
      // killed or crashed: a dead process cleans nothing; its handles close and its scratch stays for the janitor
      job.scratch?.abandon();
      this.#notePeak(job);
    }
  }

  /** A step of the worker: a hold point, then a scripted crash, then the kill the host already delivered. */
  async #at(job: Job, point: WorkerHostPoint): Promise<void> {
    const key = holdKey(point, job.identity);
    const hold = this.#holds.get(key)?.shift();
    if (hold !== undefined) {
      this.#waiting.set(job.identity, hold);
      hold.signal();
      await hold.released;
      this.#waiting.delete(job.identity);
    }
    const crash = this.#crashes.get(key);
    if (crash !== undefined) {
      this.#crashes.delete(key);
      if (crash === "FAILED") {
        job.state = "FAILED";
        job.cause = "WORKER_CRASHED";
        job.endedMs = this.#clock.nowMs();
      }
      throw new RunStopped("CRASHED");
    }
    this.#stopIfKilled(job);
  }

  #stopIfKilled(job: Job): void {
    if (job.killed && !this.#survivors.has(job.identity)) throw new RunStopped("KILLED");
  }

  #kill(job: Job): void {
    job.killed = true;
    job.state = "TERMINATED";
    job.endedMs = this.#clock.nowMs();
    if (this.#survivors.has(job.identity)) return;
    // a killed process waits on nothing: its held steps give way at once
    this.#waiting.get(job.identity)?.release();
    for (const point of ["start", "cancellation", "manifest", "finish"] as const) {
      for (const hold of this.#holds.get(holdKey(point, job.identity)) ?? []) hold.release();
    }
  }

  #finish(job: Job, state: "SUCCEEDED" | "FAILED", cause: WorkerFailureCause | null, manifest: WorkerManifestReference | null): void {
    this.#notePeak(job);
    job.scratch?.dispose();
    if (job.killed) {
      // a survivor finished after its termination: the host reports what the script says
      if (this.#survivors.get(job.identity) === "SUCCEEDED" && state === "SUCCEEDED") {
        job.state = "SUCCEEDED";
        job.manifest = manifest;
      }
      return;
    }
    job.state = state;
    job.cause = cause;
    job.manifest = manifest;
    job.endedMs = this.#clock.nowMs();
  }

  #notePeak(job: Job): void {
    if (job.scratch !== null) job.peakScratchBytes = Math.max(job.peakScratchBytes, job.scratch.usage().peakBytes);
  }

  #beat(job: Job): void {
    job.lastHeartbeatMs = this.#clock.nowMs();
  }

  #resourcesOf(job: Job): WorkerResources {
    this.#notePeak(job);
    const m = this.machine;
    const diskBytes = job.spec.limits.hardScratchBytes;
    const runtimeMs = job.startedMs === null ? 0 : Math.max(0, (job.endedMs ?? this.#clock.nowMs()) - job.startedMs);
    const costMicros = Math.ceil((runtimeMs * (m.vmMicrosPerHour + m.diskMicrosPerGibHour * (diskBytes / 2 ** 30))) / 3_600_000);
    return Object.freeze({ machineType: m.machineType, vcpus: m.vcpus, memoryBytes: m.memoryBytes, diskBytes, peakScratchBytes: job.peakScratchBytes, runtimeMs, costMicros, currency: m.currency });
  }

  #expirePending(identity: string): void {
    const pending = this.#pending.get(identity);
    if (pending !== undefined && this.#clock.nowMs() >= pending.requestedMs + this.creationHorizonSeconds * 1000) this.#pending.delete(identity);
  }

  #view(job: Job): WorkerJobView {
    return Object.freeze({
      identity: job.identity,
      state: job.state,
      createRequests: this.#requests.get(job.identity) ?? 0,
      cause: job.cause,
      manifest: job.manifest,
      lastHeartbeatAt: job.lastHeartbeatMs === null ? null : toUtcInstant(job.lastHeartbeatMs),
      host: CONTRACT_FAKE_WORKER_HOST_TOKEN,
      evidenceClass: EVIDENCE,
    });
  }

  #log(operation: WorkerHostOperation, identity: string, outcome: string): void {
    this.#calls.push(Object.freeze({ sequence: this.#calls.length + 1, operation, identity, outcome, at: this.#clock.now(), host: CONTRACT_FAKE_WORKER_HOST_TOKEN, evidenceClass: EVIDENCE }));
  }
}

function holdKey(point: WorkerHostPoint, identity: string): string {
  return `${point}\u0000${identity}`;
}

/** Why a spec is not one attempt's own (null when it is): identity, capability and subject must name the same attempt. */
function specProblem(spec: WorkerLaunchSpec): string | null {
  const { capability, subject } = spec;
  if (!isAttemptIdentity(spec.identity) || spec.identity !== capability.identity || spec.identity !== attemptIdentityOf(subject.attemptId)) return "IDENTITY_NOT_THE_ATTEMPTS";
  const [problem] = attemptCapabilityProblems(capability);
  if (problem !== undefined) return `CAPABILITY_${problem}`;
  if (subject.jobId !== capability.jobId || subject.agencyId !== capability.agencyId || subject.projectId !== capability.projectId) return "SUBJECT_NOT_THE_CAPABILITYS";
  if (!Number.isSafeInteger(spec.fence) || spec.fence < 1) return "FENCE_MALFORMED";
  const { scratchBudgetBytes, hardScratchBytes } = spec.limits;
  if (!Number.isSafeInteger(scratchBudgetBytes) || scratchBudgetBytes < 1 || scratchBudgetBytes > hardScratchBytes) return "LIMITS_MALFORMED";
  return null;
}

/** The core's claimed artifacts are exactly the ones the writer closed and re-read. */
function sameArtifacts(outcome: ExecutionOutcome, writer: FencedArtifactWriter): boolean {
  const key = (a: { readonly objectName: string; readonly generation: string; readonly sha256: string; readonly byteLength: number }): string => `${a.objectName}#${a.generation}#${a.sha256}#${a.byteLength}`;
  const claimed = outcome.stagedArtifacts.map(key).sort();
  const closed = writer.artifacts().map(key).sort();
  return claimed.length === closed.length && claimed.every((k, i) => k === closed[i]);
}
