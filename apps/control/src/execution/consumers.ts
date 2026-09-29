/**
 * The execution consumers of the outbox (package B08, mandate B08-CONTROL-EXECUTION; docs/design/B08-audit-approval-jobs.md §11;
 * decisions D8-CONS-1, D8-DUP-1, D8-CANCEL-2): B07's OutboxConsumer contract over B07's dispatcher — at least once, in SYSTEM units
 * bound to the event's agency, each verifying its subject's state before any effect, so a redelivery is harmless (a spent fence or a
 * moved state is DONE; no redelivery takes a second slot, reservation or attempt).
 *
 *   JOB_EXECUTION      processing_job.queued.v1 -> JOB_ADMISSION's round; .admitted.v1 -> the launch; .verifying.v1 -> the
 *                      verification; package_version.verified_private.v1 -> the delivery copies and the publication. After each, the
 *                      ACTIVE slot is handed to the next admitted job if it is free.
 *   EXECUTION_CONTROL  processing_job.cancel_requested.v1 -> the cancellation's continuation; the loss of a fact a job relies on —
 *                      commercial_authorization.revoked.v1 (B09), approval.withdrawn.v1, plan.withdrawn.v1, plan.superseded.v1 (B06),
 *                      dataset_revision.superseded.v1, .expired.v1, source_file.admission_revoked.v1 (B07) — cancels the live jobs
 *                      relying on it with its reason (a SERVICE actor) and reconciles them; commercial_authorization.issued.v1 is
 *                      DONE (nothing relies on an entitlement before CMD036 binds it).
 * A RETRY or WAITING step (an uncertain termination, a provider's transient failure, an uncertain launch inside its horizon) answers
 * RETRY after its hint; everything else is DONE.
 */
import type { ConsumerOutcome, OutboxConsumer } from "@kauro/application";
import type { AgencyId, ApprovalId, CommercialAuthorizationId, DomainEventRecord, ExecutionFact, PlanId, ProcessingJobId, RevisionId, SystemContext } from "@kauro/domain";
import type { JobAdmission } from "./admission.js";
import type { CancellationReconciler } from "./cancellation.js";
import type { JobPipeline } from "./pipeline.js";
import type { ExecutionStep } from "./work.js";

/** DONE, unless a step is still uncertain or a provider failed transiently (then RETRY after the shortest hint). */
function outcomeOf(steps: ReadonlyArray<ExecutionStep>, retryAfterSeconds: number): ConsumerOutcome {
  const again = steps.filter((s) => s.kind === "RETRY" || s.kind === "WAITING");
  if (again.length === 0) return { kind: "DONE" };
  const afterSeconds = Math.min(...again.map((s) => (s.kind === "RETRY" ? s.afterSeconds : retryAfterSeconds)));
  const first = again[0] as ExecutionStep & { readonly reason: string };
  return { kind: "RETRY", afterSeconds, reason: first.reason };
}

function text(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class JobExecutionConsumer implements OutboxConsumer {
  readonly consumer = "JOB_EXECUTION" as const;

  constructor(private readonly deps: { readonly admission: JobAdmission; readonly pipeline: JobPipeline; readonly retryAfterSeconds: number }) {}

  async handle(event: DomainEventRecord, _context: SystemContext): Promise<ConsumerOutcome> {
    const steps: ExecutionStep[] = [];
    const payload = event.payload as Readonly<Record<string, unknown>>;
    switch (event.eventType) {
      case "processing_job.queued.v1":
        // the queued job's intent reaches admission; the fair round admits whichever job is next, this one or another (D8-SCHED-1)
        await this.deps.admission.admitRound();
        break;
      case "processing_job.admitted.v1":
        break;
      case "processing_job.verifying.v1":
        steps.push(await this.deps.pipeline.verify(event.aggregateId as ProcessingJobId));
        break;
      case "package_version.verified_private.v1": {
        const jobId = text(payload, "jobId");
        if (jobId !== null) steps.push(await this.deps.pipeline.publish(jobId as ProcessingJobId));
        break;
      }
      default:
        return { kind: "DONE" };
    }
    // the ACTIVE slot, if free, goes to the next admitted job in launch order (D8-SCHED-1)
    steps.push(await this.deps.pipeline.launchNext());
    return outcomeOf(steps.filter((s) => !(s.kind === "WAITING" && (s.reason === "NO_ADMITTED_JOB" || s.reason === "ACTIVE_SLOT_TAKEN"))), this.deps.retryAfterSeconds);
  }
}

/** The fact a loss event names, and the reason the jobs relying on it are cancelled with (D8-CANCEL-2). */
function lossOf(event: DomainEventRecord): { readonly facts: ReadonlyArray<ExecutionFact>; readonly reason: string } | null {
  const payload = event.payload as Readonly<Record<string, unknown>>;
  switch (event.eventType) {
    case "commercial_authorization.revoked.v1":
      return { facts: [{ kind: "AUTHORIZATION", authorizationId: event.aggregateId as CommercialAuthorizationId }], reason: "AUTHORIZATION_REVOKED" };
    case "approval.withdrawn.v1":
      return { facts: [{ kind: "APPROVAL", approvalId: event.aggregateId as ApprovalId }], reason: "APPROVAL_WITHDRAWN" };
    case "plan.withdrawn.v1":
      return { facts: [{ kind: "PLAN", planId: event.aggregateId as PlanId }], reason: "PLAN_WITHDRAWN" };
    case "plan.superseded.v1":
      return { facts: [{ kind: "PLAN", planId: event.aggregateId as PlanId }], reason: "PLAN_SUPERSEDED" };
    case "dataset_revision.superseded.v1":
      return { facts: [{ kind: "REVISION", revisionId: event.aggregateId as RevisionId }], reason: "SOURCE_SUPERSEDED" };
    case "dataset_revision.expired.v1":
      return { facts: [{ kind: "REVISION", revisionId: event.aggregateId as RevisionId }], reason: "SOURCE_EXPIRED" };
    case "source_file.admission_revoked.v1": {
      const sealedBy = payload["sealedByRevisionIds"];
      const revisions = Array.isArray(sealedBy) ? sealedBy.filter((r): r is string => typeof r === "string") : [];
      return { facts: revisions.map((revisionId) => ({ kind: "REVISION", revisionId: revisionId as RevisionId })), reason: "SOURCE_ADMISSION_REVOKED" };
    }
    default:
      return null;
  }
}

export class ExecutionControlConsumer implements OutboxConsumer {
  readonly consumer = "EXECUTION_CONTROL" as const;

  constructor(private readonly deps: { readonly cancellations: CancellationReconciler; readonly pipeline: JobPipeline; readonly retryAfterSeconds: number }) {}

  async handle(event: DomainEventRecord, _context: SystemContext): Promise<ConsumerOutcome> {
    const steps: ExecutionStep[] = [];
    if (event.eventType === "processing_job.cancel_requested.v1") {
      steps.push(await this.deps.cancellations.reconcile(event.aggregateId as ProcessingJobId));
    } else {
      const loss = lossOf(event);
      if (loss === null || event.agencyId === undefined || event.agencyId === null) return { kind: "DONE" };
      for (const fact of loss.facts) steps.push(...(await this.deps.cancellations.cancelRelying(event.agencyId as AgencyId, fact, loss.reason)));
    }
    // the slots a cancellation released go to the next admitted job (JOB_EXECUTION's launch)
    if (steps.some((s) => s.kind === "APPLIED")) await this.deps.pipeline.launchNext();
    return outcomeOf(steps, this.deps.retryAfterSeconds);
  }
}
