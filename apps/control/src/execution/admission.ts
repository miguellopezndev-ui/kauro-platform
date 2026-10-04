/**
 * JOB_ADMISSION (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §4.2; decisions D8-SCHED-1,
 * D8-LOCK-1, D8-AUTH-1, D8-RET-1, D8-ATT-1, D8-STALE-1, D8-CANCEL-2; R2-046, CMD036-OK, CMD036-DENY).
 *
 * One admission is one SYSTEM unit of work bound to the job's agency:
 *   1. the platform's ledger row first (JOB_ADMISSION alone takes the global ledger first, D8-LOCK-1), then the QUEUED candidates in
 *      the fair order of D8-SCHED-1 read under it — the agency's held slots, its last admission (never first), the queue instant, the
 *      job id; the first candidate is this unit's only if it is of this unit's agency (else the next unit is bound to its own);
 *   2. every later lock without waiting: the job row SKIP LOCKED, the shared transition locks of project, approval, source, target,
 *      capability and agency and the exclusive one of the entitlement (kauro.try_await_transition, pg_try_advisory_xact_lock) — a
 *      busy job is deferred to the next round, so the ledger is never held while waiting and no cycle through a deletion or a
 *      cancellation can form;
 *   3. the authority re-read after those locks (D8-STALE-1): a job whose entitlement, approval, plan, source, target, capability,
 *      agency or project was lost while QUEUED is cancelled with its reason (a SERVICE actor, D8-CANCEL-2) and consumes nothing;
 *   4. otherwise QUEUED -> ADMITTED (a WAITING slot), the entitlement ACTIVE -> CONSUMED naming the job, the EXECUTION_ADMITTED anchor
 *      and the PAID_ORDINARY record (created, or the revision's kept), the JOB_ATTEMPT lease claimed and attempt 1 CLAIMED at fence 1
 *      — all of it one unit, bound at COMMIT by the database (KA080, KA081, KA082).
 * The round stops when no WAITING slot is free (capacity.heavyQueued) or nothing is left; the sweep then hands the ACTIVE slot to the
 * first admitted job (JOB_EXECUTION's launch).
 */
import type { ExecutionSweeper, ExecutionUnits } from "@kauro/application";
import {
  EXECUTION_POLICY,
  type AgencyId,
  type ExecutionUnitOfWork,
  type IdGenerator,
  type ProcessingAttemptId,
  type ProcessingJobId,
  type TransitionSubject,
} from "@kauro/domain";
import { SweepRun, type SweepResult } from "../sweepers/sweep.js";
import { lostAuthority } from "./authority.js";
import type { JobPipeline } from "./pipeline.js";
import { EXECUTION_SERVICES, microsOfInstant, unboundSystem, boundSystem } from "./work.js";

/** What one admission round did (D8-SCHED-1). */
export interface AdmissionRound {
  readonly admitted: ReadonlyArray<ProcessingJobId>;
  readonly cancelled: ReadonlyArray<{ readonly jobId: ProcessingJobId; readonly reason: string }>;
  /** Jobs whose row or a fact of which was in transition: left QUEUED for the next round, never waited on. */
  readonly deferred: ReadonlyArray<ProcessingJobId>;
}

type OneAdmission =
  | { readonly kind: "ADMITTED"; readonly jobId: ProcessingJobId }
  | { readonly kind: "CANCELLED"; readonly jobId: ProcessingJobId; readonly reason: string }
  | { readonly kind: "DEFERRED"; readonly jobId: ProcessingJobId }
  | { readonly kind: "ANOTHER_AGENCY" }
  | { readonly kind: "FULL" }
  | { readonly kind: "NONE" };

export interface JobAdmissionDependencies {
  readonly units: ExecutionUnits;
  readonly ids: IdGenerator;
  readonly pipeline: JobPipeline;
}

export class JobAdmission implements ExecutionSweeper {
  readonly name = "JOB_ADMISSION" as const;

  constructor(private readonly deps: JobAdmissionDependencies) {}

  /** A round, then the hand-over of the ACTIVE slot to the first admitted job in launch order. */
  async sweep(_units: ExecutionUnits, limit: number): Promise<SweepResult> {
    const run = new SweepRun(EXECUTION_SERVICES.JOB_ADMISSION, this.deps.ids);
    let round: AdmissionRound = { admitted: [], cancelled: [], deferred: [] };
    await run.attempt("admission-round", async () => {
      round = await this.admitRound(limit);
      return round.admitted.length + round.cancelled.length > 0;
    });
    const launched = await run.attempt("launch", async () => (await this.deps.pipeline.launchNext()).kind === "APPLIED");
    return { examined: round.admitted.length + round.cancelled.length + round.deferred.length, acted: round.admitted.length + round.cancelled.length + (launched ? 1 : 0), failed: run.failures };
  }

  /** Admits QUEUED jobs in the fair order while a WAITING slot is free (at most `limit` admissions). */
  async admitRound(limit = 20): Promise<AdmissionRound> {
    const admitted: ProcessingJobId[] = [];
    const cancelled: Array<{ readonly jobId: ProcessingJobId; readonly reason: string }> = [];
    const deferred = new Set<ProcessingJobId>();
    const pageSize = (): number => Math.min(1000, limit + deferred.size + 1);
    for (let turn = 0; turn < 4 * limit + 8 && admitted.length < limit; turn++) {
      // discovery: the first candidate of the fair order not deferred this round, whose agency binds the next unit
      const candidates = await this.deps.units.run(unboundSystem(EXECUTION_SERVICES.JOB_ADMISSION, this.deps.ids), (uow) => uow.execution.admissionCandidates(pageSize()));
      const next = candidates.find((c) => !deferred.has(c.jobId));
      if (next === undefined) break;
      const one = await this.deps.units.run(boundSystem(EXECUTION_SERVICES.JOB_ADMISSION, next.agencyId, this.deps.ids.next() as never), (uow) => this.admitOne(uow, next.agencyId, deferred, pageSize()));
      if (one.kind === "FULL" || one.kind === "NONE") break;
      if (one.kind === "ADMITTED") admitted.push(one.jobId);
      else if (one.kind === "CANCELLED") cancelled.push({ jobId: one.jobId, reason: one.reason });
      else if (one.kind === "DEFERRED") deferred.add(one.jobId);
    }
    return { admitted, cancelled, deferred: [...deferred] };
  }

  /** One admission under the global ledger, bound to `agencyId` (header). */
  private async admitOne(uow: ExecutionUnitOfWork, agencyId: AgencyId, deferred: ReadonlySet<ProcessingJobId>, pageSize: number): Promise<OneAdmission> {
    const x = uow.execution;
    await x.lockGlobalLedger();
    // the fair order under the ledger: the held slots and last admissions may have moved since discovery
    const first = (await x.admissionCandidates(pageSize)).find((c) => !deferred.has(c.jobId));
    if (first === undefined) return { kind: "NONE" };
    if (first.agencyId !== agencyId) return { kind: "ANOTHER_AGENCY" };
    const capacity = await x.capacity(agencyId);
    if (capacity.waitingJobs >= EXECUTION_POLICY.heavyQueued) return { kind: "FULL" };
    const job = await x.lockJob(first.jobId, "SKIP_LOCKED");
    if (job === null) return { kind: "DEFERRED", jobId: first.jobId };
    if (job.state !== "QUEUED" || job.cancelVersion !== 0) return { kind: "DEFERRED", jobId: first.jobId };

    // every lock after the ledger without waiting (D8-LOCK-1); the keys of the facts come from a first read
    const keys = await x.readAuthority(job);
    const shared: TransitionSubject[] = [{ kind: "PROJECT", key: job.projectId }, { kind: "APPROVAL", key: job.approvalId }];
    if (keys.revisionId !== null) shared.push({ kind: "REVISION", key: keys.revisionId });
    if (keys.targetContractId !== null) shared.push({ kind: "TARGET_CONTRACT", key: keys.targetContractId });
    shared.push({ kind: "CAPABILITY", key: job.mode }, { kind: "AGENCY", key: job.agencyId });
    if (!(await x.tryAwaitTransition(shared[0] as TransitionSubject))) return { kind: "DEFERRED", jobId: job.jobId };
    // an ACTIVE entitlement's row, then its exclusive transition half (the consumption is its transition), neither waited for; a
    // row no longer ACTIVE is not moved here (the facts below cancel the job), and one that changes meanwhile defers it
    if (keys.authorizationState === "ACTIVE" && !(await x.tryLockAuthorization(job.authorizationId))) return { kind: "DEFERRED", jobId: job.jobId };
    if (!(await x.tryTransitionExclusive({ kind: "AUTHORIZATION", key: job.authorizationId }))) return { kind: "DEFERRED", jobId: job.jobId };
    for (const subject of shared.slice(1)) if (!(await x.tryAwaitTransition(subject))) return { kind: "DEFERRED", jobId: job.jobId };

    // the authority read after the locks (D8-STALE-1): a lost fact cancels the job with its reason and consumes nothing
    const facts = await x.readAuthority(job);
    const lost = lostAuthority(job, facts, "ACTIVE");
    if (lost !== null) {
      const requested = await x.requestCancellation(job.jobId, job.version, { actor: { kind: "SERVICE", serviceId: EXECUTION_SERVICES.JOB_ADMISSION }, reasonCode: lost });
      if (requested.kind !== "APPLIED") return { kind: "DEFERRED", jobId: job.jobId };
      const done = await x.completeCancellation(job.jobId, requested.record.version);
      if (done.kind !== "APPLIED") return { kind: "DEFERRED", jobId: job.jobId };
      return { kind: "CANCELLED", jobId: job.jobId, reason: lost };
    }
    // a job at or past its delivery deadline is JOB_DEADLINES' (deadline_reached), never admitted
    if (microsOfInstant(job.deliveryDeadlineAt) <= microsOfInstant(await uow.executionDiscovery.serverNow())) return { kind: "DEFERRED", jobId: job.jobId };
    await x.admit(job, uow.ids.next() as ProcessingAttemptId);
    return { kind: "ADMITTED", jobId: job.jobId };
  }
}
