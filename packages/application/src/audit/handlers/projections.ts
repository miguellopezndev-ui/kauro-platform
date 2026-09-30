/**
 * The projection of an audit to its safe view (B08; docs/design/B08-audit-approval-jobs.md §12; 10 "Responses and safe errors"): what a
 * live member of the agency may see of an audit and of the grant that funds it. Built from the audit row and its grant row alone —
 * never the sealed revision's or the target's hash, the requesting membership, the profile evidence, a step, a task, a provider or the
 * pool the grant was carved from — and shared by CancelAudit's answer and the GetAudit read, so the two show the audit the same way.
 */
import type { AuditRecord, CostGrantRecord, MembershipRole } from "@kauro/domain";
import { findTransition, roleSatisfies } from "@kauro/domain";
import { CANCEL_AUDIT, CREATE_PLAN } from "../contracts.js";
import type { AuditResourceAction, AuditView } from "../views.js";
import { utc } from "./shared.js";

/**
 * The commands the caller may issue on the audit (informative, B06 D-PERM-1): CancelAudit while the machine lists cancellation_wins
 * for its state, CreatePlan once it awaits the agency's decisions — for an operating role in both cases.
 */
export function auditActions(role: MembershipRole, audit: Pick<AuditRecord, "state">): ReadonlyArray<AuditResourceAction> {
  const out: AuditResourceAction[] = [];
  if (roleSatisfies(CANCEL_AUDIT.role, role) && findTransition("Audit", audit.state, "cancellation_wins") !== null) out.push("CancelAudit");
  if (roleSatisfies(CREATE_PLAN.role, role) && audit.state === "NEEDS_DECISION") out.push("CreatePlan");
  return out;
}

export function auditView(audit: AuditRecord, grant: CostGrantRecord, role: MembershipRole): AuditView {
  return {
    auditId: audit.auditId,
    revisionId: audit.revisionId,
    targetContractId: audit.targetContractId,
    state: audit.state,
    version: audit.version,
    startedAt: utc(audit.startedAt),
    ...(audit.interpretationDeadlineAt !== undefined ? { interpretationDeadlineAt: utc(audit.interpretationDeadlineAt) } : {}),
    absoluteDeadline: utc(audit.absoluteDeadlineAt),
    grantId: audit.grantId,
    grantClass: "FREE_AUDIT",
    grantState: grant.state,
    ...(audit.candidateManifestHash !== undefined ? { candidateManifestHash: audit.candidateManifestHash } : {}),
    cancelVersion: audit.cancelVersion,
    ...(audit.state === "NEEDS_DECISION" ? { pendingDecisions: [...audit.findingCodes] } : {}),
    ...(audit.state === "UNSUPPORTED" ? { unsupportedCapabilities: [...audit.findingCodes] } : {}),
    ...(audit.terminalReason !== undefined ? { terminalReason: audit.terminalReason } : {}),
    ...(audit.draftPlanId !== undefined ? { draftPlanId: audit.draftPlanId } : {}),
    permittedActions: auditActions(role, audit),
  };
}
