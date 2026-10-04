/**
 * CMD037 CancelJob — POST /api/v1/jobs/{jobId}/cancel — AGENCY_OPERATOR (design B08 §5, §6, §12; D8-CANCEL-1, D8-CANCEL-2, D8-PUB-2,
 * D8-STALE-1; case map CMD037-OK, CMD037-DENY, CMD037-RACE, S062; catalogue "Cancel a live job; the control plane completes it").
 *
 * Order: authorize → reserve → the job row under its lock (FOR UPDATE: the one serialization point CancelJob shares with the
 * publication commit, so exactly one of the two wins, never both — S062; a job of another agency answers as one that never existed) →
 * the job decided on the locked record:
 *
 *   - READY: the output was delivered, so the job is no longer cancellable — 409 PRECONDITION_FAILED JOB_ALREADY_READY, naming the
 *     package (Q8-8) and promising no rollback of what the client's CRM took (10);
 *   - CANCELLED, FAILED or EXPIRED: 409 PRECONDITION_FAILED JOB_TERMINAL naming where the job stands;
 *   - a version other than the one read: 409 STALE_VERSION naming the current version and state;
 *   - already CANCEL_REQUESTED at that version: the job as it is — a cancellation is recorded once, nothing is written and no
 *     second event is published, whatever the reason the retry names;
 *   - otherwise one cancel_command at that version: the cancellation version + 1, the reason label on the row only, and the store's
 *     processing_job.cancel_requested.v1 to EXECUTION_CONTROL (the control plane reconciles the provider and completes the
 *     cancellation; the platform slot stays held until it does, D8-CANCEL-1) → journal 200 with the job.
 *
 * A terminal or delivered job is answered before the version is compared, so a retry that read the job before it ended is told
 * what became of it rather than that it is stale. The handler holds no project or transition lock: the job row is the fence.
 */
import type { MembershipRole, ProcessingJobId, ProcessingJobRecord } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { applied, checkExpectedVersion, requireMembership } from "../../commands/handlers/shared.js";
import { CANCEL_JOB, type CancelJobBody, type CancelJobHandler } from "../contracts.js";
import type { JobView } from "../views.js";
import { jobView } from "./projections.js";
import { runExecutionCommand, versionAt, type ExecutionRuntime } from "./shared.js";

export function cancelJobHandler(runtime: ExecutionRuntime): CancelJobHandler {
  return {
    spec: CANCEL_JOB,
    execute: (envelope) =>
      runExecutionCommand<CancelJobBody, JobView>(
        CANCEL_JOB,
        runtime,
        envelope,
        async (uow, ctx) => {
          const membership = requireMembership(ctx);
          const x = uow.execution;
          const jobId = envelope.path["jobId"] as ProcessingJobId;

          // the job row under its lock; a job of another agency is the answer of one that never existed
          const found = await x.getJob(jobId);
          if (!found || found.agencyId !== membership.agencyId) throw new DomainFailure("NOT_FOUND", "job not visible");
          const job = await x.lockJob(jobId, "WAIT");
          if (!job) throw new DomainFailure("NOT_FOUND", "job not visible");

          if (job.state === "READY") {
            throw new DomainFailure("PRECONDITION_FAILED", "the job's package was already published", {
              reason: "JOB_ALREADY_READY",
              currentVersion: job.version,
              currentState: job.state,
              ...(job.publishedPackageId !== undefined ? { successorId: job.publishedPackageId } : {}),
            });
          }
          if (job.state === "CANCELLED" || job.state === "FAILED" || job.state === "EXPIRED") {
            throw new DomainFailure("PRECONDITION_FAILED", "the job already ended", { reason: "JOB_TERMINAL", currentVersion: job.version, currentState: job.state });
          }
          checkExpectedVersion(job, envelope.body.expectedVersion);

          // a cancellation is recorded once: at the version that recorded it the job is answered as it is
          if (job.state === "CANCEL_REQUESTED") return answered(job, membership.role);

          const cancelled = applied(
            await x.requestCancellation(jobId, envelope.body.expectedVersion, { actor: { kind: "USER", userId: envelope.userId }, reasonCode: envelope.body.reasonCode }),
          );
          return answered(cancelled, membership.role);
        },
        versionAt(),
      ),
  };
}

function answered(job: ProcessingJobRecord, role: MembershipRole) {
  return { status: 200 as const, view: jobView(job, role), version: job.version, resourceKind: "processing_job", resourceId: job.jobId };
}

