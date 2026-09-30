/**
 * Safe reason codes of audit authority (package B08, mandates B08-PERSISTENCE-AUDIT and B08-COMMANDS-AUDIT;
 * docs/design/B08-audit-approval-jobs.md §9, §12): what the database's audit keys and the audit commands' own guards answer when a
 * request meets them — machine tokens that never carry a customer value, appended to the closed FAILURE_REASONS list of
 * model/errors.ts after the execution half (KA080..KA084 and the grant's reasons are there already, decision D8-PEX-10). This module
 * imports nothing: the failure taxonomy depends on it, never the reverse.
 */
export const AUDIT_FAILURE_REASONS = [
  // audits_one_per_subject: one audit per (revision, target contract), for good — a retry is not a new free audit (D8-AUD-1)
  "AUDIT_EXISTS",
  // audits_one_live_per_agency: capacity.agencyAudits live audits of one agency (D8-AUD-1); retryable once it ends
  "AUDIT_CONCURRENCY_LIMITED",
  // StartAudit (CMD020): the revision is not SEALED — a draft, a locked or a rejected one has no immutable manifest to audit (§12)
  "REVISION_NOT_SEALED",
  // CancelAudit (CMD021): the audit already ended — a cancellation has nothing left to stop (§12)
  "AUDIT_TERMINAL",
  // CreatePlan (CMD022): the audit has no candidate decisions awaiting the agency — only a NEEDS_DECISION audit is decidable (§12)
  "AUDIT_NOT_DECIDABLE",
  // ValidatePlan (CMD024): only a VALIDATION_REQUIRED plan takes a validation intent (§12)
  "PLAN_NOT_VALIDATABLE",
  // D8-PORT-1: a deployment that binds no adapter of the cores answers this, never a stub standing in for a core
  "CORE_SERVICES_UNAVAILABLE",
] as const;

export type AuditFailureReason = (typeof AUDIT_FAILURE_REASONS)[number];
