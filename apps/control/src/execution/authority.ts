/**
 * The authority an execution edge relies on, judged from the facts the execution store read after their transition locks (package
 * B08; docs/design/B08-audit-approval-jobs.md §4.2, §5, D8-STALE-1, D8-AUTH-1, D8-XPKG-8, D8-CANCEL-2). The reasons are the closed
 * tokens a lost authority cancels a job with (the job's cancel reason, the package's revocation reason): they name the fact, never
 * a customer value.
 */
import type { ExecutionAuthorityFacts, ProcessingJobRecord } from "@kauro/domain";
import { microsOfInstant } from "./work.js";

export const LOST_AUTHORITY_REASONS = [
  "AGENCY_NOT_ACTIVE",
  "PROJECT_NOT_OPEN",
  "AUTHORIZATION_REVOKED",
  "AUTHORIZATION_NOT_ACTIVE",
  "APPROVAL_WITHDRAWN",
  "PLAN_WITHDRAWN",
  "PLAN_SUPERSEDED",
  "PLAN_NOT_APPROVED",
  "SOURCE_SUPERSEDED",
  "SOURCE_EXPIRED",
  "SOURCE_ADMISSION_REVOKED",
  "TARGET_STALE",
  "CAPABILITY_UNAVAILABLE",
] as const;
export type LostAuthorityReason = (typeof LOST_AUTHORITY_REASONS)[number];

/**
 * Why the job may not take its next edge, or null when its authority holds. `entitlement` is the state the job's authorization must
 * be in for that edge: ACTIVE before admission (CMD036 binds, admission consumes), CONSUMED by this job before the publication,
 * DELIVERED by this job once the publication wrote it (the last atomic check, D8-PUB-2).
 */
export function lostAuthority(job: ProcessingJobRecord, facts: ExecutionAuthorityFacts, entitlement: "ACTIVE" | "CONSUMED" | "DELIVERED"): LostAuthorityReason | null {
  if (facts.agencyState !== "ACTIVE") return "AGENCY_NOT_ACTIVE";
  if (facts.projectState !== "OPEN") return "PROJECT_NOT_OPEN";
  if (facts.authorizationState !== entitlement || (entitlement !== "ACTIVE" && facts.authorizationJobRef !== job.jobId)) {
    return facts.authorizationState === "REVOKED" ? "AUTHORIZATION_REVOKED" : "AUTHORIZATION_NOT_ACTIVE";
  }
  if (facts.captureCompletedAt === null) return "AUTHORIZATION_NOT_ACTIVE";
  if (!facts.approvalLive) return "APPROVAL_WITHDRAWN";
  if (facts.planState !== "APPROVED") return facts.planState === "WITHDRAWN" ? "PLAN_WITHDRAWN" : facts.planState === "SUPERSEDED" ? "PLAN_SUPERSEDED" : "PLAN_NOT_APPROVED";
  if (facts.revisionState !== "SEALED") return facts.revisionState === "SUPERSEDED" ? "SOURCE_SUPERSEDED" : "SOURCE_EXPIRED";
  // B08-R1: the revision stays SEALED when an included file's admission is revoked; the job's source is lost all the same
  if (!facts.sourceFilesAdmitted) return "SOURCE_ADMISSION_REVOKED";
  // D8-XPKG-8: once the revision has a PAID_ORDINARY record, the governing record ahead is read against the job's delivery deadline
  if (facts.paidOrdinaryRetentionId !== null && (facts.retentionEffectiveDeadline === null || microsOfInstant(facts.retentionEffectiveDeadline) < microsOfInstant(job.deliveryDeadlineAt))) {
    return "SOURCE_EXPIRED";
  }
  if (!facts.targetCurrent) return "TARGET_STALE";
  if (!facts.capabilityOffered) return "CAPABILITY_UNAVAILABLE";
  return null;
}
