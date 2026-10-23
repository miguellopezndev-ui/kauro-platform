/**
 * The projection of an audit to its safe view (B08; docs/design/B08-audit-approval-jobs.md §12; 10 "Responses and safe errors"): what a
 * live member of the agency may see of an audit and of the grant that funds it. Built from the audit row and its grant row alone —
 * never the sealed revision's or the target's hash, the requesting membership, the profile evidence, a step, a task, a provider or the
 * pool the grant was carved from — and shared by CancelAudit's answer and the GetAudit read, so the two show the audit the same way.
 */
import type { AuditRecord, CostGrantRecord, ImportStageRecord, MembershipRole, StageReceiptReconciliationRecord, StageReceiptRecord, TargetContractLifecycle, TargetContractRecord } from "@kauro/domain";
import { findTransition, roleSatisfies } from "@kauro/domain";
import { CANCEL_AUDIT, CONFIRM_TARGET_CONTRACT, CONTINUE_STAGE, CREATE_PLAN, SUBMIT_STAGE_RECEIPT } from "../contracts.js";
import type { AuditResourceAction, AuditView, ImportStageAction, ImportStageView, TargetContractAction, TargetContractView } from "../views.js";
import { TARGET_DRIFT_PATHS } from "../views.js";
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
    // absent for a CLEAN audit (CP-02.01: AuditView serves targetContractId as optional; candidate activation only)
    ...(audit.targetContractId === undefined ? {} : { targetContractId: audit.targetContractId }),
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

/** The commands the caller may issue on a target contract (informative, B06 D-PERM-1): ConfirmTargetContract on a DRAFT, for an approving role. */
export function targetContractActions(role: MembershipRole, contract: Pick<TargetContractLifecycle, "state">): ReadonlyArray<TargetContractAction> {
  return roleSatisfies(CONFIRM_TARGET_CONTRACT.role, role) && contract.state === "DRAFT" ? ["ConfirmTargetContract"] : [];
}

export function targetContractView(
  contract: TargetContractLifecycle,
  objectCount: number,
  role: MembershipRole,
  supersession: { readonly superseded: ReadonlyArray<TargetContractRecord>; readonly recheckPlanIds: ReadonlyArray<string> } | null = null,
): TargetContractView {
  return {
    contractId: contract.contractId,
    projectId: contract.projectId,
    mode: contract.mode,
    instanceId: contract.instanceId,
    importerProfileId: contract.importerProfileId,
    importerVersion: contract.importerVersion,
    bodyHash: contract.bodyHash,
    observedAt: utc(contract.observedAt),
    ...(contract.confirmedAt !== undefined ? { confirmedAt: utc(contract.confirmedAt) } : {}),
    authorityEvidenceHash: contract.authorityEvidenceHash,
    capabilityVersion: contract.capabilityVersion,
    version: contract.version,
    state: contract.state,
    objectCount,
    ...(supersession !== null && supersession.superseded.length > 0
      ? {
          supersedes: supersession.superseded.map((c) => ({ contractId: c.contractId, supersededAt: utc(c.supersededAt as NonNullable<typeof c.supersededAt>) })),
          recheckPlanIds: [...supersession.recheckPlanIds],
          includedPaths: [...TARGET_DRIFT_PATHS],
        }
      : {}),
    permittedActions: targetContractActions(role, contract),
  };
}

/**
 * The commands the caller may issue on an import stage (informative, B06 D-PERM-1): SubmitStageReceipt while the stage awaits a receipt
 * (or needs a correction), for an operating role; ContinueStage on a verified stage not yet continued, or one whose fully accounted
 * partial receipt awaits the approver, for an approving role.
 */
export function importStageActions(role: MembershipRole, stage: Pick<ImportStageRecord, "state" | "continuedAt">): ReadonlyArray<ImportStageAction> {
  const out: ImportStageAction[] = [];
  if (roleSatisfies(SUBMIT_STAGE_RECEIPT.role, role) && (stage.state === "AWAITING_AGENCY_IMPORT" || stage.state === "NEEDS_CORRECTION")) out.push("SubmitStageReceipt");
  if (roleSatisfies(CONTINUE_STAGE.role, role) && stage.continuedAt === undefined && (stage.state === "VERIFIED_SUCCESS" || stage.state === "RECEIPT_VALIDATING")) out.push("ContinueStage");
  return out;
}

export function importStageView(stage: ImportStageRecord, receipt: StageReceiptRecord | null, role: MembershipRole, reconciliation: StageReceiptReconciliationRecord | null = null): ImportStageView {
  return {
    stageId: stage.stageId,
    projectId: stage.projectId,
    sequence: stage.sequence,
    objectApiName: stage.objectApiName,
    operation: stage.operation,
    state: stage.state,
    parentStageIds: stage.parentStageIds,
    packageHash: stage.packageHash,
    receiptRequired: stage.receiptRequired,
    expiresAt: utc(stage.expiresAt),
    version: stage.version,
    ...(receipt !== null
      ? {
          receiptRevision: receipt.revision,
          receiptResult: receipt.result,
          identityMappingHash: receipt.identityMappingHash,
          matchedRows: receipt.matchedRows,
          failedRows: receipt.failedRows,
          unresolvedRows: receipt.unresolvedRows,
        }
      : {}),
    ...(stage.continuedAt !== undefined ? { continuedAt: utc(stage.continuedAt) } : {}),
    ...(reconciliation !== null
      ? { reconciliation: { reconciliationId: reconciliation.reconciliationId, state: reconciliation.state, contentHash: reconciliation.contentHash, openedAt: utc(reconciliation.openedAt) } }
      : {}),
    permittedActions: importStageActions(role, stage),
  };
}
