/**
 * The audit handlers (design B08 §12): CMD020 StartAudit, CMD021 CancelAudit, CMD022 CreatePlan and CMD024 ValidatePlan on B06's pipeline,
 * the GetAudit read and the decision-artifact intake. The composition root builds them once over the same runtime B06's handlers use
 * (its unit-of-work factory also opens audit units of work) and the core services of the deployment (none: CMD022 answers
 * CORE_SERVICES_UNAVAILABLE, D8-PORT-1).
 */
import type { AuditHandlers } from "../contracts.js";
import type { CoreServices } from "../core-services.js";
import { cancelAuditHandler } from "./cancel-audit.js";
import { confirmTargetContractHandler } from "./confirm-target-contract.js";
import { createTargetContractHandler } from "./create-target-contract.js";
import { continueStageHandler } from "./continue-stage.js";
import { submitStageReceiptHandler } from "./submit-stage-receipt.js";
import { createPlanHandler } from "./create-plan.js";
import { startAuditHandler } from "./start-audit.js";
import { validatePlanHandler } from "./validate-plan.js";
import type { AuditRuntime } from "./shared.js";

export function createAuditHandlers(runtime: AuditRuntime, cores: CoreServices): AuditHandlers {
  return Object.freeze({
    CMD018: createTargetContractHandler(runtime),
    CMD019: confirmTargetContractHandler(runtime),
    CMD020: startAuditHandler(runtime),
    CMD021: cancelAuditHandler(runtime),
    CMD022: createPlanHandler(runtime, cores.planCompiler),
    CMD024: validatePlanHandler(runtime),
    CMD040: submitStageReceiptHandler(runtime),
    CMD041: continueStageHandler(runtime),
  });
}

export type { AuditRuntime } from "./shared.js";
export { createAuditReadHandlers, type AuditReadHandlers } from "./reads.js";
export { AUDIT_INTAKE_ROUTES, DECISION_ARTIFACT_INTAKE_ROLE, DECISION_DOCUMENT_MAX_BYTES, createAuditIntakeHandlers, type AuditIntakeHandlers, type AuditReadRuntime } from "./intake.js";
export { AGENCY_CANCELLED_REASON } from "./cancel-audit.js";
export { auditActions, auditView, importStageActions, importStageView, targetContractActions, targetContractView } from "./projections.js";
