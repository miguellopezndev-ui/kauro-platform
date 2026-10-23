/**
 * Order 22's refusals. The candidate's reasons are not in the served FAILURE_REASONS (they are adopted only by Order 19B), so they are a
 * closed list of their own; the application answers each with the failure code it carries and the reason as the problem's reason.
 */
import type { FailureCode } from "../../model/errors.js";

export const O22_FAILURE_REASONS = [
  "REFUSAL_REASON_UNKNOWN",
  "REFUSAL_LIST_VERSION_STALE",
  "NOTE_REQUIRED",
  "REFUSAL_EVIDENCE_REQUIRED",
  "OWNER_RULE_REFERENCE_REQUIRED",
  "OWNER_RULE_NOT_IN_FORCE",
  "OWNER_RULE_NOT_ALLOWED",
  "CLAIM_NOT_REFUSABLE",
  "CLAIM_NOT_REVIEWABLE",
  "REVIEW_ALREADY_REQUESTED",
  "REVIEW_NOT_OPEN",
  "FIGURE_NEGATIVE_IN_CANDIDATE_CONTRACT",
  "CANDIDATE_NOT_ACTIVE",
] as const;
export type O22FailureReason = (typeof O22_FAILURE_REASONS)[number];

export class O22Failure extends Error {
  readonly code: FailureCode;
  readonly reason: O22FailureReason;
  constructor(code: FailureCode, reason: O22FailureReason, message: string) {
    super(message);
    this.name = "O22Failure";
    this.code = code;
    this.reason = reason;
  }
}
