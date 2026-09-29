/**
 * JOB_DEADLINES (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §8.1 deadline_reached, D8-DL-1,
 * D8-PEX-1, D8-PEX-2): a live, uncancelled job whose delivery deadline — or, once launched, its execution deadline — is at or before
 * the server clock (never early: the discovery compares with kauro.server_now() and the database refuses an early expiry, KA081) is
 * EXPIRED. Its exact provider job is terminated and observed terminal first (an ADMITTED job's uncertain launch is reconciled the same
 * way: nothing is expired while its creation may still land), then in one unit under the job's row lock the attempt is abandoned,
 * a STAGED or VERIFIED_PRIVATE package revoked (the publication is refused after the deadline) and the job EXPIRED, releasing its
 * slots. No retry, worker or takeover restarts a clock.
 */
import type { ExecutionSweeper, ExecutionUnits } from "@kauro/application";
import type { AgencyId, IdGenerator, ProcessingJobId } from "@kauro/domain";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import type { JobPipeline } from "./pipeline.js";
import { EXECUTION_SERVICES, StepRefused, applied, microsOfInstant, refusalOf, refused, retry, waiting, type ExecutionStep } from "./work.js";

const PROVIDER_SIDE = new Set(["STARTING", "RUNNING", "STAGED", "VERIFYING"]);

export class JobDeadlines implements ExecutionSweeper {
  readonly name = "JOB_DEADLINES" as const;

  constructor(private readonly deps: { readonly ids: IdGenerator; readonly pipeline: JobPipeline; readonly retryAfterSeconds: number }) {}

  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(EXECUTION_SERVICES.JOB_DEADLINES, this.deps.ids);
    const p = this.deps.pipeline;
    const due = await p.discover(EXECUTION_SERVICES.JOB_DEADLINES, (uow) => uow.executionDiscovery.jobsPastDeadline(limit));
    let acted = 0;
    for (const job of due) {
      if (await run.attempt(job.jobId, async () => (await this.expire(job.jobId, job.agencyId)).kind === "APPLIED")) acted += 1;
    }
    if (acted > 0) await run.attempt("launch", async () => (await p.launchNext()).kind === "APPLIED");
    return { examined: due.length, acted, failed: run.failures };
  }

  /** deadline_reached for one job (header). */
  async expire(jobId: ProcessingJobId, agencyId: AgencyId): Promise<ExecutionStep> {
    const p = this.deps.pipeline;
    const service = EXECUTION_SERVICES.JOB_DEADLINES;
    try {
      const seen = await p.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const job = await x.lockJob(jobId);
        if (job === null) throw new StepRefused("JOB_NOT_FOUND");
        const now = microsOfInstant(await uow.executionDiscovery.serverNow());
        const deadline = job.executionDeadlineAt !== undefined && microsOfInstant(job.executionDeadlineAt) < microsOfInstant(job.deliveryDeadlineAt) ? job.executionDeadlineAt : job.deliveryDeadlineAt;
        if (job.cancelVersion !== 0 || !["QUEUED", "ADMITTED", "RUNNING", "VERIFYING"].includes(job.state)) throw new StepRefused("JOB_NOT_LIVE");
        if (microsOfInstant(deadline) > now) return null;
        const attempt = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
        return { job, attempt, now: await uow.executionDiscovery.serverNow(), reason: deadline === job.executionDeadlineAt && job.executionDeadlineAt !== job.deliveryDeadlineAt ? "EXECUTION_DEADLINE_REACHED" : "DELIVERY_DEADLINE_REACHED" };
      });
      if (seen === null) return waiting("NOT_DUE");
      const { attempt, reason } = seen;
      if (attempt !== null && PROVIDER_SIDE.has(attempt.state)) {
        // the exact provider job terminated first; an uncertain launch reconciled before anything is expired
        const ended = await p.terminateAndObserve(attempt.identity);
        if (ended !== "TERMINAL") return retry(ended, this.deps.retryAfterSeconds);
        if (!(await p.creationSettled(attempt, seen.now))) return waiting("LAUNCH_UNCERTAIN");
      }
      return await p.bound(service, agencyId, async (uow) => {
        const x = uow.execution;
        const job = await x.lockJob(jobId);
        if (job === null || job.cancelVersion !== 0 || !["QUEUED", "ADMITTED", "RUNNING", "VERIFYING"].includes(job.state)) throw new StepRefused("JOB_NOT_LIVE");
        const current = job.currentAttemptId === undefined ? null : await x.getAttempt(job.currentAttemptId);
        if (current !== null && !["COMMITTED", "ABANDONED", "FAILED"].includes(current.state)) await x.abandonAttempt(current.attemptId, reason);
        if (current !== null) {
          const pkg = await x.packageOfAttempt(current.attemptId);
          if (pkg !== null && (pkg.state === "STAGED" || pkg.state === "VERIFIED_PRIVATE")) await x.revokePackage(pkg.packageVersionId, pkg.version, reason);
        }
        const expired = await x.expireJob(job.jobId, job.version, reason);
        if (expired.kind !== "APPLIED") throw new StepRefused("STALE_VERSION");
        return applied("EXPIRED");
      });
    } catch (e) {
      const why = refusalOf(e);
      if (why === null) throw e;
      return refused(why);
    }
  }
}
