/**
 * EXECUTION_CONTROL's cancellation (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §6, §7;
 * decisions D8-CANCEL-1, D8-CANCEL-2, D8-HOST-1, D8-DUP-1; CMD037-OK, CMD037-DENY, CMD037-RACE, R2-045).
 *
 * A cancellation is a version on the job (CMD037, or this consumer for a lost authority, a SERVICE actor with its reason token), and
 * its continuation here:
 *   1. under the job's row lock, the job's cancellation version mirrored into its JOB_ATTEMPT lease (once: the lease's own version
 *      catching up with the job's is also what marks the first pass);
 *   2. the provider side, outside any transaction: on the first pass the attempt's identity is terminated — exactly that identity —
 *      then observed; on a later pass (an uncertain termination retried, a redelivery) it is observed first and terminated again
 *      only if still live. An UNCERTAIN termination or a job still live is RETRY, never assumed; NOT_FOUND proves absence only for a
 *      launched job or after the host's creation horizon;
 *   3. under the job's row lock again, the attempt ABANDONED, its STAGED or VERIFIED_PRIVATE package REVOKED (publication_denied,
 *      its evidence kept), and CANCEL_REQUESTED -> CANCELLED, which releases the job's slots once (the ledgers' trigger).
 * A job no longer CANCEL_REQUESTED (already CANCELLED, or READY because the publication committed first, S062) is DONE: a second
 * delivery terminates nothing twice and releases nothing twice. Cancellation is never a CRM rollback: nothing outside the platform's
 * own records and the attempt's provider job is touched.
 */
import { type AgencyId, type ExecutionFact, type ProcessingAttemptRecord, type ProcessingJobId, type ProcessingJobRecord } from "@kauro/domain";
import type { JobPipeline } from "./pipeline.js";
import { EXECUTION_SERVICES, StepRefused, applied, microsOfInstant, refusalOf, refused, retry, waiting, type ExecutionStep } from "./work.js";

export interface CancellationDependencies {
  readonly pipeline: JobPipeline;
  readonly retryAfterSeconds: number;
}

const ENDED = new Set(["COMMITTED", "ABANDONED", "FAILED"]);
/** kauro.is_token: a revocation reason is a safe token. */
const TOKEN = /^[A-Z][A-Z0-9_]{2,63}$/;

/** The package's revocation reason: the lost authority's own token, or JOB_CANCELLED for a person's CMD037 (its label stays on the job). */
function revocationReasonOf(job: ProcessingJobRecord): string {
  return job.cancelActor?.kind === "SERVICE" && job.cancelReasonCode !== undefined && TOKEN.test(job.cancelReasonCode) ? job.cancelReasonCode : "JOB_CANCELLED";
}

export class CancellationReconciler {
  constructor(private readonly deps: CancellationDependencies) {}

  /**
   * D8-CANCEL-2: the live, uncancelled jobs of the agency relying on a lost fact are cancelled with its reason (a SERVICE actor of
   * EXECUTION_CONTROL), then reconciled. Returns the steps, one per job.
   */
  async cancelRelying(agencyId: AgencyId, fact: ExecutionFact, reason: string): Promise<ReadonlyArray<ExecutionStep>> {
    const p = this.deps.pipeline;
    const jobs = await p.bound(EXECUTION_SERVICES.EXECUTION_CONTROL, agencyId, (uow) => uow.executionDiscovery.liveJobsRelyingOn(agencyId, fact));
    const steps: ExecutionStep[] = [];
    for (const job of jobs) steps.push(await this.cancelFor(job.jobId, job.agencyId, reason));
    return steps;
  }

  /** cancel_command for a lost authority (D8-CANCEL-2), under the job's row lock, then the continuation. */
  async cancelFor(jobId: ProcessingJobId, agencyId: AgencyId, reason: string): Promise<ExecutionStep> {
    const p = this.deps.pipeline;
    try {
      await p.bound(EXECUTION_SERVICES.EXECUTION_CONTROL, agencyId, async (uow) => {
        const job = await uow.execution.lockJob(jobId);
        if (job === null || job.cancelVersion !== 0 || !["QUEUED", "ADMITTED", "RUNNING", "VERIFYING"].includes(job.state)) return;
        const requested = await uow.execution.requestCancellation(job.jobId, job.version, { actor: { kind: "SERVICE", serviceId: EXECUTION_SERVICES.EXECUTION_CONTROL }, reasonCode: reason });
        if (requested.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
      });
    } catch (e) {
      const why = refusalOf(e);
      if (why === null) throw e;
      return refused(why);
    }
    return this.reconcile(jobId);
  }

  /** The continuation of a committed cancellation (header). */
  async reconcile(jobId: ProcessingJobId): Promise<ExecutionStep> {
    const p = this.deps.pipeline;
    const service = EXECUTION_SERVICES.EXECUTION_CONTROL;
    try {
      const agencyId = await p.agencyOf(jobId);
      if (agencyId === null) return refused("JOB_NOT_FOUND");
      // 1. the cancellation mirrored into the lease, once
      const first = await p.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const job = await x.lockJob(jobId);
        if (job === null) throw new StepRefused("JOB_NOT_FOUND");
        if (job.state !== "CANCEL_REQUESTED") return { job, attempt: null, firstPass: false, now: "", done: true };
        const lease = await x.jobLease(jobId);
        const firstPass = lease !== null && lease.cancelVersion < job.cancelVersion;
        if (firstPass) await x.mirrorCancellation(jobId);
        const attempt = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
        return { job, attempt, firstPass, now: await uow.executionDiscovery.serverNow(), done: false };
      });
      if (first.done) return applied(first.job.state === "CANCELLED" ? "ALREADY_CANCELLED" : `NOT_CANCELLING_${first.job.state}`);
      const { attempt, firstPass, now } = first;

      // 2. the provider side, when a provider job of the attempt may exist
      if (attempt !== null && !ENDED.has(attempt.state) && attempt.state !== "CLAIMED") {
        const settled = await this.providerEnded(attempt, firstPass, now);
        if (settled.kind !== "APPLIED") return settled;
      }

      // 3. the attempt abandoned, the private package revoked, CANCEL_REQUESTED -> CANCELLED (the slots released once)
      return await p.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const locked = await x.lockJob(jobId);
        if (locked === null) throw new StepRefused("JOB_NOT_FOUND");
        if (locked.state !== "CANCEL_REQUESTED") return applied(locked.state === "CANCELLED" ? "ALREADY_CANCELLED" : `NOT_CANCELLING_${locked.state}`);
        const current = locked.currentAttemptId === undefined ? null : await x.getAttempt(locked.currentAttemptId);
        if (current !== null && !ENDED.has(current.state)) {
          // after cancel_command an attempt only ends (the database refuses every forward edge, KA081): the live one is the one
          // whose provider job was reconciled above
          if (attempt === null || current.attemptId !== attempt.attemptId) throw new StepRefused("ATTEMPT_MOVED");
          await x.abandonAttempt(current.attemptId, "CANCELLED");
        }
        if (current !== null) {
          const pkg = await x.packageOfAttempt(current.attemptId);
          if (pkg !== null && (pkg.state === "STAGED" || pkg.state === "VERIFIED_PRIVATE")) await x.revokePackage(pkg.packageVersionId, pkg.version, revocationReasonOf(locked));
        }
        const done = await x.completeCancellation(locked.jobId, locked.version);
        if (done.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
        return applied("CANCELLED");
      });
    } catch (e) {
      const why = refusalOf(e);
      if (why === null) throw e;
      return refused(why);
    }
  }

  /** Terminate by identity and observe until terminal or proved absent (header, step 2). */
  private async providerEnded(attempt: ProcessingAttemptRecord, firstPass: boolean, now: string): Promise<ExecutionStep> {
    const host = this.deps.pipeline.host;
    const again = retry("PROVIDER_JOB_LIVE", this.deps.retryAfterSeconds);
    try {
      if (firstPass) {
        const termination = await host.terminate(attempt.identity);
        if (termination.outcome === "UNCERTAIN") return retry("TERMINATION_UNCERTAIN", this.deps.retryAfterSeconds);
      }
      let observed = await host.observe(attempt.identity);
      if ((observed.state === "QUEUED" || observed.state === "RUNNING") && !firstPass) {
        const termination = await host.terminate(attempt.identity);
        if (termination.outcome === "UNCERTAIN") return retry("TERMINATION_UNCERTAIN", this.deps.retryAfterSeconds);
        observed = await host.observe(attempt.identity);
      }
      if (observed.state === "QUEUED" || observed.state === "RUNNING") return again;
      if (observed.state === "NOT_FOUND" && attempt.launchState !== "LAUNCHED") {
        // an absence proves nothing until the host's creation horizon has passed since the create was asked for (D8-HOST-1)
        const since = attempt.launchState === "UNCERTAIN" ? attempt.launchRecordedAt : attempt.launchIntentAt;
        if (since === undefined || microsOfInstant(now) < microsOfInstant(since) + BigInt(host.creationHorizonSeconds) * 1_000_000n) return waiting("LAUNCH_UNCERTAIN");
      }
      return applied("PROVIDER_JOB_ENDED");
    } catch (e) {
      if (typeof e === "object" && e !== null && (e as { transient?: unknown }).transient === true) return retry("PROVIDER_UNAVAILABLE", this.deps.retryAfterSeconds);
      throw e;
    }
  }
}
