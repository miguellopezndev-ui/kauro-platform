/**
 * The audit policy values of package B08 (docs/design/B08-audit-approval-jobs.md D8-AUD-1, D8-GRANT-1, D8-AUD-3), each tied to the
 * vendored registry policy it comes from. Migration 0021 carries the same numbers in its CHECK constraints and guards; the domain
 * test proves these equal the registry's.
 */
export const AUDIT_POLICY = Object.freeze({
  /** intelligence.freeAuditCeilingCents: the ceiling of a free AUDIT grant carved from the platform's pool (D8-GRANT-1). */
  freeAuditCeilingCents: 150,
  /** intelligence.interpretationSeconds: no new semantic dispatch later than this after the first INTERPRETING (D8-AUD-1). */
  interpretationSeconds: 1_200,
  /** intelligence.auditAbsoluteSeconds: no successful finalization later than this after StartAudit (D8-AUD-1). */
  auditAbsoluteSeconds: 86_400,
  /** capacity.agencyAudits: live audits of one agency (D8-AUD-1). */
  agencyAudits: 1,
  /** The MODEL_TASK lease time to live of one dispatch owner (the platform's value, as EXECUTION_POLICY.leaseSeconds). */
  modelTaskLeaseSeconds: 120,
  /** CostGrant.currency (registry enum USD). */
  currency: "USD",
} as const);

export type AuditPolicy = typeof AUDIT_POLICY;
