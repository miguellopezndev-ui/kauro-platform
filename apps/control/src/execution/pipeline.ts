/**
 * JOB_EXECUTION's steps and ATTEMPT_MONITOR's observation of one job (package B08, mandate B08-CONTROL-EXECUTION;
 * docs/design/B08-audit-approval-jobs.md §4.3, §5, §6, §7; decisions D8-HOST-1, D8-ATT-1, D8-ATT-2, D8-STG-1..3, D8-VER-1, D8-PUB-1,
 * D8-PUB-2, D8-STALE-1, D8-CANCEL-1, D8-DUP-1).
 *
 * Every step is a unit of work that records an intent, a call outside any transaction, and a unit that re-reads the job under its row
 * lock and records the answer only if nothing moved (§6): a cancellation committed at any await wins, because the next unit reads it
 * and refuses. The database is the last word — a stale fence (KA080), a lost authority or a cancellation (KA081), a publication
 * without its evidence (KA084) refuse the edge whatever this code believed.
 *
 *   launch     the launch intent (the attempt STARTING with its deterministic identity, prefix and manifest name; the job's ACTIVE
 *              slot and execution deadline), `WorkerHostPort.launch` by identity, the launch record (LAUNCHED, UNCERTAIN on a lost
 *              answer, REFUSED); a cancellation committed meanwhile terminates the identity at once.
 *   observe    ATTEMPT_MONITOR's pass over one job: a CLAIMED attempt is launched; an uncertain launch is reconciled by observing the
 *              identity before any other create (NOT_FOUND proves nothing inside the host's creation horizon); a live worker with a
 *              fresh heartbeat heartbeats the lease under the attempt's fence, a silent one whose lease lapsed is terminated, observed
 *              terminal and abandoned, and the lease taken over at fence + 1 (at most three attempts, inside the execution deadline);
 *              a finished worker's manifest is submitted, a failed one ends the job with its classified cause.
 *   submit     the control plane reads the manifest object itself from the attempt's prefix at its generation and records it under the
 *              fence (attempt STAGED, job VERIFYING, package STAGED; D8-STG-3); an invalid manifest fails the attempt and the job.
 *   verify     every artifact read back by its exact generation, then `PackageVerifierPort` against the authority the platform
 *              supplies (D8-VER-1): VALID -> VERIFIED_PRIVATE; a partial, foreign or overwritten blob or INVALID fails the job by
 *              verification_failure with the exact problem and revokes the package, its evidence kept.
 *   publish    the authority re-read after its locks (a stale fact cancels the job with its reason and revokes the package), the
 *              delivery copies with generation-0 preconditions, each read back (D8-PUB-1), then the publication transaction of
 *              D8-PUB-2 with the authority read once more after the publication's own locks, before COMMIT.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import {
  readStagedManifest,
  stagedManifestObjectNameOf,
  type AttemptCapability,
  type ExecutionLimits,
  type ExecutionSubject,
  type ExpectedAuthority,
  type ExecutionUnits,
  type ObjectStoragePort,
  type PackageVerifierPort,
  type StagedArtifact,
  type StorageLocation,
  type WorkerFailureCause,
  type WorkerHostPort,
  type WorkerLaunchResult,
  type WorkerLaunchSpec,
  type WorkerManifestReference,
  type WorkerObservation,
} from "@kauro/application";
import {
  EXECUTION_POLICY,
  deliveryManifestHashOf,
  type AgencyId,
  type ArtifactReadbackId,
  type ExecutionInput,
  type ExecutionUnitOfWork,
  type IdGenerator,
  type LaunchState,
  type PackageVerificationId,
  type PackageVersionId,
  type PackageVersionRecord,
  type ProcessingAttemptId,
  type ProcessingAttemptRecord,
  type ProcessingJobId,
  type ProcessingJobRecord,
  type StoredObjectId,
  type TransitionSubject,
} from "@kauro/domain";
import { lostAuthority } from "./authority.js";
import { deliveryObjectNameOf, expectedAuthorityHashOf } from "./names.js";
import { EXECUTION_SERVICES, StepRefused, applied, boundSystem, microsOfInstant, problemToken, refusalOf, refused, retry, unboundSystem, waiting, type ExecutionStep } from "./work.js";

export interface PipelineDependencies {
  readonly units: ExecutionUnits;
  readonly ids: IdGenerator;
  readonly host: WorkerHostPort;
  readonly verifier: PackageVerifierPort;
  readonly storage: ObjectStoragePort;
  /** The core version the platform expects the verifier to be (ExpectedAuthority.coreVersion; D8-VER-1). */
  readonly coreVersion: string;
  readonly limits: ExecutionLimits;
  /** When a transient provider failure or an uncertain answer is retried (seconds). */
  readonly retryAfterSeconds: number;
}

/** The causes a worker ends with that are the job's classified end (S035's and the envelope's); any other is retried by a takeover. */
const TERMINAL_CAUSES: ReadonlySet<WorkerFailureCause> = new Set(["SCRATCH_EXHAUSTED", "SHORT_WRITE", "CORRUPT_INTERMEDIATE", "READBACK_MISMATCH", "ARTIFACT_CLOSE_FAILED", "OUTSIDE_CAPABILITY", "SOURCE_INTEGRITY_FAILED", "DEADLINE_EXCEEDED", "REFUSED"]);

const LIVE_ATTEMPT = new Set(["STARTING", "RUNNING", "STAGED", "VERIFYING"]);

/** A read of one object back from the storage: exactly the generation asked for, what the name holds now, or nothing. */
interface Observed {
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

/** A provider call failed transiently: the step is retried, never assumed (09: only genuinely transient failures retry). */
class ProviderTransient extends Error {
  constructor(readonly what: string) {
    super(`${what}: transient provider failure`);
    this.name = "ProviderTransient";
  }
}

function isTransient(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { transient?: unknown }).transient === true;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** The problem of one read-back, exact (S061): nothing under the name, a shorter blob, other bytes, or another generation of them. */
export function readbackProblem(expected: Observed, observed: Observed | null): string | null {
  if (observed === null) return "READBACK_MISSING";
  if (observed.byteLength < expected.byteLength) return "READBACK_PARTIAL_BLOB";
  if (observed.sha256 !== expected.sha256 || observed.byteLength !== expected.byteLength) return "READBACK_FOREIGN_CONTENT";
  if (observed.generation !== expected.generation) return "READBACK_GENERATION_CHANGED";
  return null;
}

export class JobPipeline {
  constructor(private readonly deps: PipelineDependencies) {}

  get host(): WorkerHostPort {
    return this.deps.host;
  }

  // --- units of work ---------------------------------------------------------------------------------------------------------------

  /** A SYSTEM unit of `service` bound to the agency (D-CTRL-1). */
  bound<T>(service: string, agencyId: AgencyId, work: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T> {
    return this.deps.units.run(boundSystem(service, agencyId, this.deps.ids.next() as never), work);
  }

  /** An unbound SYSTEM unit of cross-agency discovery (ids and states only). */
  discover<T>(service: string, work: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T> {
    return this.deps.units.run(unboundSystem(service, this.deps.ids), work);
  }

  /** The job's agency, read by discovery (the control plane reads every agency's jobs); null when no such job exists. */
  async agencyOf(jobId: ProcessingJobId): Promise<AgencyId | null> {
    return this.discover(EXECUTION_SERVICES.JOB_EXECUTION, async (uow) => (await uow.execution.getJob(jobId))?.agencyId ?? null);
  }

  /** Runs a step whose units may be refused because the subject moved: the refusal is the step's answer (D8-DUP-1). */
  private async guarded(work: () => Promise<ExecutionStep>): Promise<ExecutionStep> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ProviderTransient) return retry(`PROVIDER_${e.what}`, this.deps.retryAfterSeconds);
      const reason = refusalOf(e);
      if (reason === null) throw e;
      return refused(reason);
    }
  }

  private get staging(): StorageLocation {
    return this.deps.storage.location("STAGING");
  }

  private get delivery(): StorageLocation {
    return this.deps.storage.location("DELIVERY");
  }

  // --- launch (D8-HOST-1, D8-STG-1) ------------------------------------------------------------------------------------------------

  /** Hands the free ACTIVE slot to the next admitted job in launch order (D8-SCHED-1); WAITING when the slot is taken or none waits. */
  async launchNext(): Promise<ExecutionStep> {
    const next = await this.discover(EXECUTION_SERVICES.JOB_EXECUTION, async (uow) => {
      const [candidate] = await uow.executionDiscovery.launchCandidates(1);
      if (candidate === undefined) return null;
      const capacity = await uow.execution.capacity(candidate.agencyId);
      return capacity.activeJobs >= EXECUTION_POLICY.heavyActive ? "BUSY" : candidate;
    });
    if (next === null) return waiting("NO_ADMITTED_JOB");
    if (next === "BUSY") return waiting("ACTIVE_SLOT_TAKEN");
    return this.launch(next.jobId, next.agencyId, EXECUTION_SERVICES.JOB_EXECUTION);
  }

  /** The launch of the job's current CLAIMED attempt: the intent under the job row, the create by identity, the record. */
  async launch(jobId: ProcessingJobId, agencyId: AgencyId, service: string): Promise<ExecutionStep> {
    return this.guarded(async () => {
      const intent = await this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const job = await x.lockJob(jobId);
        if (job === null) throw new StepRefused("JOB_NOT_FOUND");
        if (job.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
        if (job.state !== "ADMITTED" && job.state !== "RUNNING") throw new StepRefused("JOB_NOT_LAUNCHABLE");
        const attempt = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
        if (attempt === null || attempt.state !== "CLAIMED") throw new StepRefused("NO_CLAIMED_ATTEMPT");
        const launched = await x.recordLaunchIntent(attempt.attemptId, { manifestObjectName: stagedManifestObjectNameOf(attempt.stagingPrefix, attempt.attemptId) });
        return { job: launched.job, attempt: launched.attempt, input: await uow.executionDiscovery.executionInput(launched.job) };
      });
      return this.createByIdentity(intent.job, intent.attempt, intent.input, service);
    });
  }

  /** The create by the attempt's identity, outside any transaction, and its record under the job row. */
  private async createByIdentity(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, input: ExecutionInput, service: string): Promise<ExecutionStep> {
    let answer: WorkerLaunchResult | null;
    try {
      answer = await this.deps.host.launch(this.specOf(job, attempt, input));
    } catch {
      // no answer: the create may or may not have landed (UNCERTAIN; observe answers before anything is created again)
      answer = null;
    }
    const launchState: LaunchState = answer === null || answer.outcome === "AMBIGUOUS" ? "UNCERTAIN" : answer.outcome === "REFUSED" ? "REFUSED" : "LAUNCHED";
    const recorded = await this.bound(service, job.agencyId, async (uow) => {
      const x = uow.execution;
      const locked = await x.lockJob(job.jobId);
      const current = await x.getAttempt(attempt.attemptId);
      if (locked === null || current === null) throw new StepRefused("JOB_NOT_FOUND");
      if (current.launchState === "NOT_LAUNCHED" || (current.launchState === "UNCERTAIN" && launchState !== "UNCERTAIN")) {
        await x.recordLaunch(attempt.attemptId, launchState, launchState === "LAUNCHED" ? attempt.identity : null);
      }
      if (locked.cancelVersion !== 0) return "CANCELLED" as const;
      if (launchState === "REFUSED" && current.state === "STARTING" && current.attemptId === locked.currentAttemptId) {
        // unrecoverable_start_error (ADMITTED -> FAILED), or a takeover's refusal while RUNNING: the job ends with the host's refusal
        await x.failAttempt(attempt.attemptId, "HOST_REFUSED");
        const failed = await x.failJob(locked.jobId, locked.version, "HOST_REFUSED");
        if (failed.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
        return "FAILED" as const;
      }
      return "RECORDED" as const;
    });
    if (recorded === "CANCELLED") {
      // a cancellation committed while the launch was in flight: the identity is terminated at once (§6); EXECUTION_CONTROL
      // reconciles the rest
      if (launchState !== "REFUSED") await this.deps.host.terminate(attempt.identity).catch(() => undefined);
      return refused("JOB_CANCELLED");
    }
    if (recorded === "FAILED") return applied("LAUNCH_REFUSED");
    return applied(launchState === "LAUNCHED" ? "LAUNCHED" : "LAUNCH_UNCERTAIN");
  }

  /** The launch spec of an attempt: exactly its capability, its subject and the platform's envelope (D8-STG-1; manual 04). */
  private specOf(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, input: ExecutionInput): WorkerLaunchSpec {
    if (attempt.fence === undefined || attempt.manifestObjectName === undefined || job.executionDeadlineAt === undefined) throw new StepRefused("ATTEMPT_NOT_LAUNCHABLE");
    const capability: AttemptCapability = {
      agencyId: job.agencyId,
      projectId: job.projectId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      identity: attempt.identity,
      stagingPrefix: attempt.stagingPrefix,
      manifestObjectName: attempt.manifestObjectName,
      acceptedGenerations: input.acceptedGenerations.map((g) => ({ objectName: g.objectName, generation: g.generation, sha256: g.sha256, byteLength: g.byteLength })),
    };
    const subject: ExecutionSubject = {
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      agencyId: job.agencyId,
      projectId: job.projectId,
      inputBindingHash: job.inputBindingHash,
      revisionHash: job.revisionHash,
      targetContractHash: job.targetContractHash,
      planHash: job.planHash,
      configDocument: input.planBody,
      configHash: job.planHash,
      executionDeadlineAt: job.executionDeadlineAt,
    };
    return { identity: attempt.identity, capability, subject, limits: this.deps.limits, fence: attempt.fence };
  }

  // --- ATTEMPT_MONITOR's pass over one job (D8-ATT-1, D8-ATT-2, D8-HOST-1) --------------------------------------------------------

  async observe(jobId: ProcessingJobId, agencyId: AgencyId): Promise<ExecutionStep> {
    const service = EXECUTION_SERVICES.ATTEMPT_MONITOR;
    return this.guarded(async () => {
      const seen = await this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const job = await x.getJob(jobId);
        const attempt = job?.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
        return { job, attempt, lease: await x.jobLease(jobId), now: await uow.executionDiscovery.serverNow() };
      });
      const { job, attempt, lease, now } = seen;
      if (job === null || attempt === null || job.cancelVersion !== 0 || (job.state !== "ADMITTED" && job.state !== "RUNNING")) return waiting("NOT_MONITORED");
      if (attempt.state === "CLAIMED") return this.launch(jobId, agencyId, service);
      if (attempt.state === "ABANDONED" || attempt.state === "FAILED") return this.takeOver(job, attempt.attemptId);
      if (attempt.state !== "STARTING" && attempt.state !== "RUNNING") return waiting("NOT_MONITORED");

      let observation: WorkerObservation;
      try {
        observation = await this.deps.host.observe(attempt.identity);
      } catch (e) {
        if (isTransient(e)) throw new ProviderTransient("HOST_OBSERVE");
        throw e;
      }
      const uncertain = attempt.launchState !== "LAUNCHED";
      if (observation.state === "NOT_FOUND") {
        if (uncertain) {
          // only NOT_FOUND after the host's creation horizon proves no effect (D8-HOST-1): until then nothing is created again
          const since = attempt.launchState === "UNCERTAIN" ? attempt.launchRecordedAt : attempt.launchIntentAt;
          if (since === undefined || microsOfInstant(now) < microsOfInstant(since) + BigInt(this.deps.host.creationHorizonSeconds) * 1_000_000n) return waiting("LAUNCH_UNCERTAIN");
          return this.relaunch(job, attempt, service);
        }
        // a launched provider job the host no longer knows: proved absent, the attempt is abandoned and the lease taken over later
        return this.endAttempt(job, attempt, "ABANDONED", "PROVIDER_JOB_LOST", service);
      }
      // found: an uncertain launch is adopted (the identity's provider job exists; nothing was created twice)
      if (uncertain) {
        await this.bound(service, agencyId, async (uow) => {
          const current = await uow.execution.getAttempt(attempt.attemptId);
          if (current !== null && current.launchState !== "LAUNCHED") await uow.execution.recordLaunch(attempt.attemptId, "LAUNCHED", attempt.identity);
        });
      }
      switch (observation.state) {
        case "QUEUED":
          return this.heartbeat(job, attempt, service);
        case "RUNNING":
          if (this.alive(observation)) return this.running(job, attempt, service);
          if (lease === null || microsOfInstant(lease.expiresAt) <= microsOfInstant(now)) return this.lapse(job, attempt, service);
          return waiting("WORKER_SILENT");
        case "SUCCEEDED": {
          const started = await this.started(job, attempt, service);
          if (started.kind !== "APPLIED") return started;
          if (observation.manifest === null) return this.failFor(job.jobId, attempt.attemptId, "MANIFEST_MISSING", service);
          return this.submit(attempt.attemptId, observation.manifest);
        }
        case "FAILED": {
          const started = await this.started(job, attempt, service);
          if (started.kind !== "APPLIED") return started;
          const cause = observation.cause ?? "WORKER_ERROR";
          if (TERMINAL_CAUSES.has(cause)) return this.failFor(job.jobId, attempt.attemptId, cause, service);
          return this.endAttempt(job, attempt, "ABANDONED", cause, service);
        }
        case "TERMINATED":
          return this.endAttempt(job, attempt, "ABANDONED", "PROVIDER_JOB_TERMINATED", service);
      }
    });
  }

  /** The worker's last sign of life is within a lease's time to live of the host's own observation instant (D8-ATT-2). */
  private alive(observation: WorkerObservation): boolean {
    if (observation.lastHeartbeatAt === null) return false;
    return Date.parse(observation.observedAt) - Date.parse(observation.lastHeartbeatAt) < EXECUTION_POLICY.leaseSeconds * 1000;
  }

  /** provider_start_observed (STARTING -> RUNNING; the job ADMITTED -> RUNNING), under the job row; nothing after a cancellation. */
  private async started(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, service: string): Promise<ExecutionStep> {
    if (attempt.state === "RUNNING") return applied("RUNNING");
    return this.bound(service, job.agencyId, async (uow) => {
      const x = uow.execution;
      const locked = await x.lockJob(job.jobId);
      if (locked === null || locked.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
      const current = await x.getAttempt(attempt.attemptId);
      if (current === null || current.attemptId !== locked.currentAttemptId) throw new StepRefused("ATTEMPT_FENCED");
      if (current.state === "STARTING") await x.observeStart(attempt.attemptId);
      return applied("RUNNING");
    });
  }

  /** A live worker: provider_start_observed once, then the lease's heartbeat under the attempt's fence, on the server clock. */
  private async running(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, service: string): Promise<ExecutionStep> {
    const started = await this.started(job, attempt, service);
    if (started.kind !== "APPLIED") return started;
    return this.heartbeat(job, attempt, service);
  }

  private async heartbeat(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, service: string): Promise<ExecutionStep> {
    if (attempt.fence === undefined) return waiting("NOT_FENCED");
    const lease = await this.bound(service, job.agencyId, (uow) => uow.execution.heartbeat(job.jobId, attempt.attemptId, attempt.fence as number));
    return lease === null ? waiting("LEASE_NOT_HELD") : applied("HEARTBEAT");
  }

  /**
   * A silent worker whose lease lapsed (D8-ATT-2): its identity terminated and observed terminal, then the attempt abandoned and the
   * lease taken over at fence + 1 in one unit (D8-ATT-1). An uncertain termination or a job still live is retried, never assumed.
   */
  private async lapse(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, service: string): Promise<ExecutionStep> {
    const terminal = await this.terminateAndObserve(attempt.identity);
    if (terminal !== "TERMINAL") return retry(terminal, this.deps.retryAfterSeconds);
    return this.bound(service, job.agencyId, async (uow) => {
      const x = uow.execution;
      const locked = await x.lockJob(job.jobId);
      if (locked === null || locked.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
      const current = await x.getAttempt(attempt.attemptId);
      if (current === null || current.attemptId !== locked.currentAttemptId || !LIVE_ATTEMPT.has(current.state)) throw new StepRefused("ATTEMPT_FENCED");
      await x.abandonAttempt(attempt.attemptId, "LEASE_LAPSED");
      return this.takeOverIn(uow, locked);
    });
  }

  /** The takeover of a job whose current attempt ended while the job lives: attempt n + 1 at fence + 1, or the job fails. */
  private async takeOver(job: ProcessingJobRecord, endedAttemptId: ProcessingAttemptId): Promise<ExecutionStep> {
    return this.bound(EXECUTION_SERVICES.ATTEMPT_MONITOR, job.agencyId, async (uow) => {
      const locked = await uow.execution.lockJob(job.jobId);
      if (locked === null || locked.cancelVersion !== 0 || locked.currentAttemptId !== endedAttemptId) throw new StepRefused("JOB_MOVED");
      return this.takeOverIn(uow, locked);
    });
  }

  private async takeOverIn(uow: ExecutionUnitOfWork, job: ProcessingJobRecord): Promise<ExecutionStep> {
    const x = uow.execution;
    const now = await uow.executionDiscovery.serverNow();
    const withinWall = job.executionDeadlineAt === undefined || microsOfInstant(now) < microsOfInstant(job.executionDeadlineAt);
    if (job.attemptCount >= EXECUTION_POLICY.maxAttempts || !withinWall) {
      // attempts exhausted inside the original deadlines (Q8-3): unrecoverable_start_error or fatal_resource_or_integrity_error
      const failed = await x.failJob(job.jobId, job.version, "ATTEMPTS_EXHAUSTED");
      if (failed.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
      return applied("ATTEMPTS_EXHAUSTED");
    }
    const taken = await x.takeOver(job.jobId, uow.ids.next() as ProcessingAttemptId);
    return taken.kind === "CLAIMED" ? applied("TAKEN_OVER") : waiting("LEASE_HELD");
  }

  /** An uncertain launch proved absent after the creation horizon: back to NOT_LAUNCHED, then created by identity again. */
  private async relaunch(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, service: string): Promise<ExecutionStep> {
    const intent = await this.bound(service, job.agencyId, async (uow) => {
      const x = uow.execution;
      const locked = await x.lockJob(job.jobId);
      if (locked === null || locked.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
      const current = await x.getAttempt(attempt.attemptId);
      if (current === null || current.attemptId !== locked.currentAttemptId || current.state !== "STARTING") throw new StepRefused("ATTEMPT_FENCED");
      const reset = current.launchState === "UNCERTAIN" ? await x.recordLaunch(attempt.attemptId, "NOT_LAUNCHED", null) : current;
      return { job: locked, attempt: reset, input: await uow.executionDiscovery.executionInput(locked) };
    });
    return this.createByIdentity(intent.job, intent.attempt, intent.input, service);
  }

  /**
   * Whether an attempt's create can no longer land (D8-HOST-1): its launch was recorded LAUNCHED or REFUSED, the host knows its
   * identity, or the host's creation horizon has passed on the server clock since the create was asked for.
   */
  async creationSettled(attempt: ProcessingAttemptRecord, now: UtcInstant): Promise<boolean> {
    if (attempt.launchState === "LAUNCHED" || attempt.launchState === "REFUSED") return true;
    const observed = await this.deps.host.observe(attempt.identity);
    if (observed.state !== "NOT_FOUND") return true;
    const since = attempt.launchState === "UNCERTAIN" ? attempt.launchRecordedAt : attempt.launchIntentAt;
    return since !== undefined && microsOfInstant(now) >= microsOfInstant(since) + BigInt(this.deps.host.creationHorizonSeconds) * 1_000_000n;
  }

  /** Terminates an identity and observes it: TERMINAL once it is over (or proved absent), else why it is not yet. */
  async terminateAndObserve(identity: string): Promise<"TERMINAL" | "TERMINATION_UNCERTAIN" | "PROVIDER_JOB_LIVE"> {
    let termination;
    try {
      termination = await this.deps.host.terminate(identity);
    } catch (e) {
      if (isTransient(e)) throw new ProviderTransient("HOST_TERMINATE");
      throw e;
    }
    if (termination.outcome === "UNCERTAIN") return "TERMINATION_UNCERTAIN";
    const observed = await this.deps.host.observe(identity);
    return observed.state === "QUEUED" || observed.state === "RUNNING" ? "PROVIDER_JOB_LIVE" : "TERMINAL";
  }

  /** The attempt ends (ABANDONED or FAILED) with its cause while the job lives on (a later pass takes the lease over). */
  private async endAttempt(job: ProcessingJobRecord, attempt: ProcessingAttemptRecord, state: "ABANDONED", cause: string, service: string): Promise<ExecutionStep> {
    return this.bound(service, job.agencyId, async (uow) => {
      const x = uow.execution;
      const locked = await x.lockJob(job.jobId);
      if (locked === null || locked.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
      const current = await x.getAttempt(attempt.attemptId);
      if (current === null || current.attemptId !== locked.currentAttemptId || !LIVE_ATTEMPT.has(current.state)) throw new StepRefused("ATTEMPT_FENCED");
      if (state === "ABANDONED") await x.abandonAttempt(attempt.attemptId, cause);
      return applied(`ATTEMPT_${state}`);
    });
  }

  /** The attempt and the job fail with the attempt's classified cause (fatal_resource_or_integrity_error; S035). */
  private async failFor(jobId: ProcessingJobId, attemptId: ProcessingAttemptId, cause: string, service: string): Promise<ExecutionStep> {
    const agencyId = await this.agencyOf(jobId);
    if (agencyId === null) return refused("JOB_NOT_FOUND");
    return this.bound(service, agencyId, async (uow) => {
      const x = uow.execution;
      const job = await x.lockJob(jobId);
      if (job === null || job.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
      const attempt = await x.getAttempt(attemptId);
      if (attempt === null || attempt.attemptId !== job.currentAttemptId || !LIVE_ATTEMPT.has(attempt.state)) throw new StepRefused("ATTEMPT_FENCED");
      await x.failAttempt(attemptId, cause);
      const pkg = await x.packageOfAttempt(attemptId);
      if (pkg !== null && (pkg.state === "STAGED" || pkg.state === "VERIFIED_PRIVATE")) await x.revokePackage(pkg.packageVersionId, pkg.version, "VERIFICATION_FAILED");
      const failed = await x.failJob(jobId, job.version, cause);
      if (failed.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
      return applied("FAILED");
    });
  }

  // --- submission (D8-STG-3) ---------------------------------------------------------------------------------------------------

  /** The manifest the host reported, read by the control plane itself from the attempt's prefix and recorded under its fence. */
  async submit(attemptId: ProcessingAttemptId, reference: WorkerManifestReference): Promise<ExecutionStep> {
    const service = EXECUTION_SERVICES.JOB_EXECUTION;
    return this.guarded(async () => {
      const found = await this.discover(service, async (uow) => uow.execution.getAttempt(attemptId));
      if (found === null) return refused("ATTEMPT_NOT_FOUND");
      const check = (uow: ExecutionUnitOfWork) => this.submissionCheck(uow, found);
      const { job, attempt } = await this.bound(service, found.agencyId, check);
      if (reference.objectName !== attempt.manifestObjectName) return this.failFor(job.jobId, attempt.attemptId, "MANIFEST_NOT_THE_ATTEMPTS", service);
      let bytes: Buffer;
      try {
        bytes = await collect(this.deps.storage.read(this.staging, reference.objectName, reference.generation));
      } catch (e) {
        if (isTransient(e)) throw new ProviderTransient("STORAGE_READ");
        return this.failFor(job.jobId, attempt.attemptId, "MANIFEST_UNREADABLE", service);
      }
      const reading = readStagedManifest(bytes, {
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        fence: attempt.fence as number,
        inputBindingHash: job.inputBindingHash,
        stagingPrefix: attempt.stagingPrefix,
        manifestObjectName: attempt.manifestObjectName as string,
      });
      if (!reading.ok) return this.failFor(job.jobId, attempt.attemptId, `MANIFEST_${reading.problem}`, service);
      return this.bound(service, found.agencyId, async (uow) => {
        await check(uow);
        await uow.execution.submitManifest(attempt.attemptId, {
          packageVersionId: uow.ids.next() as PackageVersionId,
          location: this.staging,
          manifest: { objectName: reference.objectName, generation: reference.generation, manifestHash: reading.manifestHash, declaredSummaryHash: rawDigest(canonicalBytes(reading.payload.declaredSummary ?? null)) },
          artifacts: reading.payload.artifacts.map((a) => ({ objectId: uow.ids.next() as StoredObjectId, role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength })),
        });
        return applied("SUBMITTED");
      });
    });
  }

  /** The job under its row lock still RUNNING this very attempt at its fence, uncancelled (§6: the check after the manifest read). */
  private async submissionCheck(uow: ExecutionUnitOfWork, attempt: ProcessingAttemptRecord): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }> {
    const x = uow.execution;
    const job = await x.lockJob(attempt.jobId);
    if (job === null) throw new StepRefused("JOB_NOT_FOUND");
    if (job.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
    const current = await x.getAttempt(attempt.attemptId);
    if (current === null || current.attemptId !== job.currentAttemptId || current.state !== "RUNNING" || current.fence !== job.fence || current.manifestObjectName === undefined) throw new StepRefused("ATTEMPT_FENCED");
    if (job.state !== "RUNNING") throw new StepRefused("JOB_NOT_RUNNING");
    return { job, attempt: current };
  }

  // --- verification (D8-VER-1) ---------------------------------------------------------------------------------------------------

  /** Reads one object back: exactly `generation`, or — when that generation is no longer held — what the name holds now, or null. */
  private async readBack(location: StorageLocation, objectName: string, generation: string): Promise<Observed | null> {
    try {
      const bytes = await collect(this.deps.storage.read(location, objectName, generation));
      return { generation, sha256: rawDigest(bytes), byteLength: bytes.length };
    } catch (e) {
      if (isTransient(e)) throw new ProviderTransient("STORAGE_READ");
    }
    let now;
    try {
      now = await this.deps.storage.stat(location, objectName);
      if (now === null) return null;
      const bytes = await collect(this.deps.storage.read(location, objectName, now.generation));
      return { generation: now.generation, sha256: rawDigest(bytes), byteLength: bytes.length };
    } catch (e) {
      if (isTransient(e)) throw new ProviderTransient("STORAGE_READ");
      return null;
    }
  }

  /** The job under its row lock still VERIFYING this very attempt, uncancelled (§6: the check after each read-back and the verifier). */
  private async verificationCheck(uow: ExecutionUnitOfWork, jobId: ProcessingJobId): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord; readonly pkg: PackageVersionRecord }> {
    const x = uow.execution;
    const job = await x.lockJob(jobId);
    if (job === null) throw new StepRefused("JOB_NOT_FOUND");
    if (job.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
    if (job.state !== "VERIFYING") throw new StepRefused("JOB_NOT_VERIFYING");
    const attempt = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
    const pkg = attempt === null ? null : await x.packageOfAttempt(attempt.attemptId);
    if (attempt === null || pkg === null || (attempt.state !== "STAGED" && attempt.state !== "VERIFYING")) throw new StepRefused("ATTEMPT_FENCED");
    return { job, attempt, pkg };
  }

  async verify(jobId: ProcessingJobId): Promise<ExecutionStep> {
    const service = EXECUTION_SERVICES.JOB_EXECUTION;
    return this.guarded(async () => {
      const agencyId = await this.agencyOf(jobId);
      if (agencyId === null) return refused("JOB_NOT_FOUND");
      // verification_started under the fence; the artifacts the manifest named, as recorded
      const start = await this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const { job, attempt, pkg } = await this.verificationCheck(uow, jobId);
        if (pkg.state === "VERIFIED_PRIVATE") return { job, attempt, pkg, artifacts: [], manifest: null, done: true };
        if (pkg.state !== "STAGED") throw new StepRefused("PACKAGE_NOT_STAGED");
        const verifying = attempt.state === "STAGED" ? await x.startVerification(attempt.attemptId) : attempt;
        return { job, attempt: verifying, pkg, artifacts: await x.stagedArtifactsOf(attempt.attemptId), manifest: await x.stagedManifestOf(attempt.attemptId), done: false };
      });
      if (start.done) return applied("ALREADY_VERIFIED");
      const { job, attempt, pkg, artifacts, manifest } = start;
      if (manifest === null) throw new StepRefused("ATTEMPT_FENCED");

      // every artifact read back by its exact generation from the attempt's own prefix (outside any transaction)
      const readbacks: Array<{ readonly artifact: (typeof artifacts)[number]; readonly observed: Observed | null; readonly problem: string | null }> = [];
      for (const artifact of artifacts) {
        const observed = await this.readBack(this.staging, artifact.objectName, artifact.generation);
        readbacks.push({ artifact, observed, problem: readbackProblem({ generation: artifact.generation, sha256: artifact.sha256, byteLength: artifact.byteLength }, observed) });
      }
      const expected: ExpectedAuthority = {
        revisionHash: job.revisionHash,
        planHash: job.planHash,
        targetContractHash: job.targetContractHash,
        coreVersion: this.deps.coreVersion,
        requiredArtifacts: readbacks.map((r) => ({ role: r.artifact.role, objectName: r.artifact.objectName, generation: r.observed?.generation ?? r.artifact.generation, sha256: r.observed?.sha256 ?? r.artifact.sha256, byteLength: r.observed?.byteLength ?? r.artifact.byteLength })),
      };
      const problems = [...new Set(readbacks.map((r) => r.problem).filter((p): p is string => p !== null))];
      const record = async (uow: ExecutionUnitOfWork): Promise<void> => {
        for (const r of readbacks) {
          await uow.execution.recordReadback({
            readbackId: uow.ids.next() as ArtifactReadbackId,
            attemptId: attempt.attemptId,
            kind: "STAGING",
            objectName: r.artifact.objectName,
            expected: { generation: r.artifact.generation, sha256: r.artifact.sha256, byteLength: r.artifact.byteLength },
            observed: r.observed,
          });
        }
      };
      if (problems.length > 0) {
        // a partial blob, another attempt's object or an overwritten generation: the read-back is the verification's verdict (S061)
        return this.bound(service, agencyId, async (uow) => {
          await this.verificationCheck(uow, jobId);
          await record(uow);
          return this.verificationFailed(uow, job, attempt, pkg, problems, this.deps.storage.evidenceClass === "EXECUTED_PROVIDER" ? "EXECUTED_LOCAL" : "SIMULATED", expectedAuthorityHashOf(expected));
        });
      }
      await this.bound(service, agencyId, async (uow) => {
        await this.verificationCheck(uow, jobId);
        await record(uow);
      });

      // the verifier, against the authority the platform supplies (a package cannot establish its own expected source; manual 04)
      const declared = readStagedManifest(await this.readManifestBytes(manifest.objectName, manifest.generation), {
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        fence: manifest.fence,
        inputBindingHash: job.inputBindingHash,
        stagingPrefix: attempt.stagingPrefix,
        manifestObjectName: manifest.objectName,
      });
      const candidateArtifacts: StagedArtifact[] = artifacts.map((a) => ({ role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }));
      const verdict = await this.deps.verifier.verify({ jobId: job.jobId, attemptId: attempt.attemptId, artifacts: candidateArtifacts, declaredSummary: declared.ok ? declared.payload.declaredSummary : null }, expected);
      if (verdict.verdict === "ERROR") return retry("VERIFIER_ERROR", this.deps.retryAfterSeconds);
      return this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const checked = await this.verificationCheck(uow, jobId);
        if (verdict.verdict === "INVALID") {
          const tokens = [...new Set(verdict.problems.map(problemToken))];
          return this.verificationFailed(uow, checked.job, attempt, checked.pkg, tokens.length > 0 ? tokens : ["VERIFIER_INVALID"], verdict.evidenceClass, expectedAuthorityHashOf(expected));
        }
        const verification = await x.recordVerification({
          verificationId: uow.ids.next() as PackageVerificationId,
          attemptId: attempt.attemptId,
          packageVersionId: pkg.packageVersionId,
          result: "VALID",
          problems: [],
          evidenceClass: verdict.evidenceClass,
          expectedAuthorityHash: expectedAuthorityHashOf(expected),
          coreVersion: this.deps.coreVersion,
        });
        await x.markVerifiedPrivate(pkg.packageVersionId, verification.verificationId);
        return applied("VERIFIED_PRIVATE");
      });
    });
  }

  private async readManifestBytes(objectName: string, generation: string): Promise<Buffer> {
    try {
      return await collect(this.deps.storage.read(this.staging, objectName, generation));
    } catch (e) {
      if (isTransient(e)) throw new ProviderTransient("STORAGE_READ");
      return Buffer.alloc(0);
    }
  }

  /** verification_failure: the INVALID verification with its exact problems, the attempt FAILED, the package REVOKED, the job FAILED. */
  private async verificationFailed(
    uow: ExecutionUnitOfWork,
    job: ProcessingJobRecord,
    attempt: ProcessingAttemptRecord,
    pkg: PackageVersionRecord,
    problems: ReadonlyArray<string>,
    evidenceClass: "EXECUTED_LOCAL" | "SIMULATED",
    expectedAuthorityHash: Sha256Hex,
  ): Promise<ExecutionStep> {
    const x = uow.execution;
    const exact = problems.slice(0, 64);
    const first = exact[0] as string;
    await x.recordVerification({
      verificationId: uow.ids.next() as PackageVerificationId,
      attemptId: attempt.attemptId,
      packageVersionId: pkg.packageVersionId,
      result: "INVALID",
      problems: exact,
      evidenceClass,
      expectedAuthorityHash,
      coreVersion: this.deps.coreVersion,
    });
    await x.failAttempt(attempt.attemptId, first);
    const current = await x.getPackage(pkg.packageVersionId);
    if (current !== null && (current.state === "STAGED" || current.state === "VERIFIED_PRIVATE")) await x.revokePackage(current.packageVersionId, current.version, "VERIFICATION_FAILED");
    const locked = await x.getJob(job.jobId);
    if (locked === null) throw new StepRefused("JOB_NOT_FOUND");
    const failed = await x.failJob(job.jobId, locked.version, first);
    if (failed.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
    return applied("VERIFICATION_FAILED");
  }

  // --- delivery copies and publication (D8-PUB-1, D8-PUB-2) ---------------------------------------------------------------------

  /** The facts' transition locks, shared and waiting, in the platform's order (D8-LOCK-1), then the facts read after them. */
  private async authorityAfterLocks(uow: ExecutionUnitOfWork, job: ProcessingJobRecord) {
    const x = uow.execution;
    const keys = await x.readAuthority(job);
    const subjects: TransitionSubject[] = [{ kind: "APPROVAL", key: job.approvalId }];
    if (keys.revisionId !== null) subjects.push({ kind: "REVISION", key: keys.revisionId });
    if (keys.targetContractId !== null) subjects.push({ kind: "TARGET_CONTRACT", key: keys.targetContractId });
    subjects.push({ kind: "CAPABILITY", key: job.mode }, { kind: "AGENCY", key: job.agencyId });
    for (const subject of subjects) await x.awaitTransition(subject);
    return x.readAuthority(job);
  }

  async publish(jobId: ProcessingJobId): Promise<ExecutionStep> {
    const service = EXECUTION_SERVICES.JOB_EXECUTION;
    return this.guarded(async () => {
      const agencyId = await this.agencyOf(jobId);
      if (agencyId === null) return refused("JOB_NOT_FOUND");
      // the authority re-read after its locks: a stale fact refuses the publication, cancels the job and revokes the package
      const ready = await this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const peek = await x.getJob(jobId);
        if (peek === null) throw new StepRefused("JOB_NOT_FOUND");
        await x.awaitTransition({ kind: "PROJECT", key: peek.projectId });
        const checked = await this.publicationCheck(uow, jobId);
        const facts = await this.authorityAfterLocks(uow, checked.job);
        const lost = lostAuthority(checked.job, facts, "CONSUMED");
        if (lost !== null) return { stale: await this.cancelForStaleAuthority(uow, checked.job, checked.pkg, lost) };
        return { stale: null, ...checked, staged: await x.stagedArtifactsOf(checked.attempt.attemptId), copies: await x.deliveryArtifactsOf(checked.pkg.packageVersionId) };
      });
      if (ready.stale !== null) return refused(ready.stale);
      const { job, attempt, pkg, staged, copies } = ready;

      // the delivery copies, generation-0 preconditions, each read back (outside any transaction)
      const copied = new Set(copies.map((c) => c.sourceObjectName));
      const made: Array<{ readonly source: (typeof staged)[number]; readonly objectName: string; readonly generation: string; readonly observed: Observed | null }> = [];
      for (const artifact of staged) {
        if (copied.has(artifact.objectName)) continue;
        const objectName = deliveryObjectNameOf(pkg.deliveryPrefix, artifact.objectName);
        let generation: string;
        try {
          generation = (await this.deps.storage.copy({ location: this.staging, objectName: artifact.objectName, generation: artifact.generation }, { location: this.delivery, objectName })).generation;
        } catch (e) {
          if (isTransient(e)) throw new ProviderTransient("STORAGE_COPY");
          // the destination already holds a copy (an interrupted earlier run): observed and verified, never assumed
          const existing = await this.deps.storage.stat(this.delivery, objectName);
          if (existing === null) throw e;
          generation = existing.generation;
        }
        made.push({ source: artifact, objectName, generation, observed: await this.readBack(this.delivery, objectName, generation) });
      }
      const copyProblem = made.map((m) => readbackProblem({ generation: m.generation, sha256: m.source.sha256, byteLength: m.source.byteLength }, m.observed)).find((p) => p !== null);
      await this.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        await this.publicationCheck(uow, jobId);
        for (const m of made) {
          const copy = await x.recordDeliveryCopy({ packageVersionId: pkg.packageVersionId, location: this.delivery, sourceObjectName: m.source.objectName, objectId: uow.ids.next() as StoredObjectId, objectName: m.objectName, generation: m.generation });
          await x.recordReadback({
            readbackId: uow.ids.next() as ArtifactReadbackId,
            attemptId: attempt.attemptId,
            kind: "DELIVERY",
            packageVersionId: pkg.packageVersionId,
            objectName: copy.objectName,
            expected: { generation: copy.generation, sha256: copy.sha256, byteLength: copy.byteLength },
            observed: m.observed,
          });
        }
      });
      if (copyProblem !== undefined && copyProblem !== null) return this.failFor(job.jobId, attempt.attemptId, `DELIVERY_${copyProblem}`, service);

      // the publication transaction (D8-PUB-2): the store takes project, job, authorization, facts, lease and package in order; the
      // authority is read once more after those locks, before COMMIT, and the deferred guard decides at COMMIT
      try {
        return await this.bound(service, agencyId, async (uow) => {
          const x = uow.execution;
          const current = await x.getJob(jobId);
          const copiesNow = await x.deliveryArtifactsOf(pkg.packageVersionId);
          const facts = current === null ? null : await x.readAuthority(current);
          if (current === null || facts === null || facts.captureCompletedAt === null) throw new StepRefused("JOB_NOT_FOUND");
          const createdAt = await uow.executionDiscovery.serverNow();
          const deliveryManifestHash = deliveryManifestHashOf({
            packageId: pkg.packageVersionId,
            revisionHash: current.revisionHash,
            planHash: current.planHash,
            targetContractHash: current.targetContractHash,
            corePackageHash: current.corePackageHash,
            validationReceiptHash: current.validationReceiptHash,
            artifacts: copiesNow.map((c) => ({ role: c.role, objectName: c.objectName, generation: c.generation, sha256: c.sha256, byteLength: c.byteLength })),
            counts: { artifacts: copiesNow.length },
            createdAt,
            expiresAt: this.packageExpiry(createdAt, facts.captureCompletedAt),
            manifestVersion: "1",
          });
          const outcome = await x.publish({ jobId, packageVersionId: pkg.packageVersionId, deliveryManifestHash, anchorId: uow.ids.next() });
          if (outcome.kind === "REFUSED") throw new StepRefused(outcome.reason);
          const after = await x.readAuthority(outcome.job);
          const lost = lostAuthority(outcome.job, after, "DELIVERED");
          if (lost !== null) throw new StaleAuthority(lost);
          return applied("PUBLISHED");
        });
      } catch (e) {
        const stale = e instanceof StaleAuthority ? e.reason : e instanceof Error && e.cause instanceof StaleAuthority ? e.cause.reason : null;
        if (stale === null) throw e;
        const reason = await this.bound(service, agencyId, async (uow) => {
          const checked = await this.publicationCheck(uow, jobId);
          return this.cancelForStaleAuthority(uow, checked.job, checked.pkg, stale);
        });
        return refused(reason);
      }
    });
  }

  /** The job under its row lock still VERIFYING its current attempt with a VERIFIED_PRIVATE package, uncancelled. */
  private async publicationCheck(uow: ExecutionUnitOfWork, jobId: ProcessingJobId): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord; readonly pkg: PackageVersionRecord }> {
    const x = uow.execution;
    const job = await x.lockJob(jobId);
    if (job === null) throw new StepRefused("JOB_NOT_FOUND");
    if (job.cancelVersion !== 0) throw new StepRefused("JOB_CANCELLED");
    if (job.state !== "VERIFYING") throw new StepRefused("JOB_NOT_VERIFYING");
    const attempt = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
    if (attempt === null || attempt.state !== "VERIFYING") throw new StepRefused("ATTEMPT_FENCED");
    const pkg = await x.packageOfAttempt(attempt.attemptId);
    if (pkg === null || pkg.state !== "VERIFIED_PRIVATE") throw new StepRefused("PACKAGE_NOT_VERIFIED");
    return { job, attempt, pkg };
  }

  /** A stale fact at publication (D8-STALE-1): the job's cancellation requested with the reason, the package REVOKED with it. */
  private async cancelForStaleAuthority(uow: ExecutionUnitOfWork, job: ProcessingJobRecord, pkg: PackageVersionRecord, reason: string): Promise<string> {
    const x = uow.execution;
    const cancelled = await x.requestCancellation(job.jobId, job.version, { actor: { kind: "SERVICE", serviceId: EXECUTION_SERVICES.JOB_EXECUTION }, reasonCode: reason });
    if (cancelled.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
    const revoked = await x.revokePackage(pkg.packageVersionId, pkg.version, reason);
    if (revoked.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
    return reason;
  }

  /** PackageManifest.expiresAt: the first package's soft deadline (+ 604,800 s), never past the PAID_ORDINARY hard cap (D8-RET-1). */
  private packageExpiry(createdAt: UtcInstant, captureCompletedAt: string): UtcInstant {
    const soft = microsOfInstant(createdAt) + BigInt(EXECUTION_POLICY.paidOrdinarySoftSeconds) * 1_000_000n;
    const hard = microsOfInstant(captureCompletedAt) + BigInt(EXECUTION_POLICY.paidOrdinaryHardSeconds) * 1_000_000n;
    const at = soft < hard ? soft : hard;
    const ms = Number(at / 1000n);
    const micros = Number(at % 1_000_000n);
    return `${new Date(ms).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}Z`;
  }
}

/** The publication's own re-read found a fact lost after its locks: the unit rolls back and the job is cancelled with the reason. */
class StaleAuthority extends Error {
  constructor(readonly reason: string) {
    super(`the publication's authority is stale: ${reason}`);
    this.name = "StaleAuthority";
  }
}
