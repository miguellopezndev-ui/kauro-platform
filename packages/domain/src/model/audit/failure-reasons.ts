/**
 * Safe reason codes of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §9, §12):
 * what the database's audit keys answer when a request meets them — machine tokens that never carry a customer value, appended to
 * the closed FAILURE_REASONS list of model/errors.ts after the execution half (KA080..KA084 and the grant's reasons are there
 * already, decision D8-PEX-10). This module imports nothing: the failure taxonomy depends on it, never the reverse.
 */
export const AUDIT_FAILURE_REASONS = [
  // audits_one_per_subject: one audit per (revision, target contract), for good — a retry is not a new free audit (D8-AUD-1)
  "AUDIT_EXISTS",
  // audits_one_live_per_agency: capacity.agencyAudits live audits of one agency (D8-AUD-1); retryable once it ends
  "AUDIT_CONCURRENCY_LIMITED",
] as const;

export type AuditFailureReason = (typeof AUDIT_FAILURE_REASONS)[number];
