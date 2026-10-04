/**
 * The projection of a processing job to its safe view (B08; docs/design/B08-audit-approval-jobs.md §12, Q8-8; 10 "Responses and
 * safe errors"): what a live member of the agency may see of a job. Built from the job row alone — never a provider identity, an
 * object name, the fence or the lease — and shared by CancelJob's answer and the GetJob read, so the two show the same job the same way.
 */
import type { MembershipRole, ProcessingJobRecord } from "@kauro/domain";
import { findTransition, roleSatisfies } from "@kauro/domain";
import { CANCEL_JOB } from "../contracts.js";
import type { ActiveProviderState, ExecutionResourceAction, JobView } from "../views.js";
import { utc } from "./shared.js";

/**
 * What the provider is doing for the live attempt, from the job's own record: LAUNCHING once admitted and not yet started, RUNNING
 * while it runs (a cancellation requested meanwhile leaves the provider running until the control plane reconciles it), FINISHED once
 * its output is being verified. Absent while QUEUED and once the job ended: nothing is live to report.
 */
export function activeProviderStateOf(job: ProcessingJobRecord): ActiveProviderState | undefined {
  switch (job.state) {
    case "ADMITTED":
      return "LAUNCHING";
    case "RUNNING":
    case "VERIFYING":
    case "CANCEL_REQUESTED": {
      // a cancellation requested while QUEUED found no attempt: nothing of the provider is live
      if (job.currentAttemptId === undefined) return undefined;
      if (job.verifyingAt !== undefined) return "FINISHED";
      return job.startedAt !== undefined ? "RUNNING" : "LAUNCHING";
    }
    default:
      return undefined;
  }
}

/** The commands the caller may issue on the job: an operating role, and a state whose machine lists cancel_command (informative, B06 D-PERM-1). */
export function jobActions(role: MembershipRole, job: Pick<ProcessingJobRecord, "state">): ReadonlyArray<ExecutionResourceAction> {
  return roleSatisfies(CANCEL_JOB.role, role) && findTransition("Job", job.state, "cancel_command") !== null ? ["CancelJob"] : [];
}

export function jobView(job: ProcessingJobRecord, role: MembershipRole): JobView {
  const providerState = activeProviderStateOf(job);
  return {
    jobId: job.jobId,
    projectId: job.projectId,
    authorizationId: job.authorizationId,
    state: job.state,
    attempt: job.attemptCount,
    version: job.version,
    queuedAt: utc(job.queuedAt),
    deliveryDeadlineAt: utc(job.deliveryDeadlineAt),
    ...(job.executionDeadlineAt !== undefined ? { executionDeadlineAt: utc(job.executionDeadlineAt) } : {}),
    cancelVersion: job.cancelVersion,
    ...(job.cancelRequestedAt !== undefined ? { cancelRequestedAt: utc(job.cancelRequestedAt) } : {}),
    ...(providerState !== undefined ? { activeProviderState: providerState } : {}),
    ...(job.publishedPackageId !== undefined ? { publishedPackageId: job.publishedPackageId } : {}),
    permittedActions: jobActions(role, job),
  };
}
