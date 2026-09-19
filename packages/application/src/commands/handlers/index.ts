/**
 * The seven B06 command handlers assembled over one runtime and the collaborators they need. The handlers depend on ports only
 * (unit of work, repositories, event publisher, journal, authorizer, plan services, inspectors); the persistence adapter and the
 * authorization implementation are wired at the entrypoint.
 */
import type { AbuseLimiter } from "../../ports/assurance-and-admission.js";
import type { ArtifactResolver, DisclosureComposer, PlanPatchCompiler } from "../../ports/plan-services.js";
import type { ActiveWorkInspector, ExternalActionInspector } from "../../ports/work-inspectors.js";
import type {
  ApprovePlanHandler,
  ArchiveClientHandler,
  CreateAgencyHandler,
  CreateClientHandler,
  CreateProjectHandler,
  RevisePlanHandler,
  WithdrawApprovalHandler,
} from "../contracts.js";
import type { CommandRuntime } from "../runtime.js";
import { approvePlanHandler } from "./approve-plan.js";
import { archiveClientHandler } from "./archive-client.js";
import { createAgencyHandler } from "./create-agency.js";
import { createClientHandler } from "./create-client.js";
import { createProjectHandler } from "./create-project.js";
import { revisePlanHandler } from "./revise-plan.js";
import { withdrawApprovalHandler } from "./withdraw-approval.js";

export interface B06Collaborators {
  readonly abuseLimiter: AbuseLimiter;
  readonly activeWork: ActiveWorkInspector;
  readonly artifacts: ArtifactResolver;
  readonly patchCompiler: PlanPatchCompiler;
  readonly disclosures: DisclosureComposer;
  readonly externalActions: ExternalActionInspector;
}

export interface B06Handlers {
  readonly CMD001: CreateAgencyHandler;
  readonly CMD009: CreateClientHandler;
  readonly CMD010: ArchiveClientHandler;
  readonly CMD011: CreateProjectHandler;
  readonly CMD023: RevisePlanHandler;
  readonly CMD025: ApprovePlanHandler;
  readonly CMD026: WithdrawApprovalHandler;
}

export function createB06Handlers(runtime: CommandRuntime, collaborators: B06Collaborators): B06Handlers {
  return Object.freeze({
    CMD001: createAgencyHandler(runtime, collaborators.abuseLimiter),
    CMD009: createClientHandler(runtime),
    CMD010: archiveClientHandler(runtime, collaborators.activeWork),
    CMD011: createProjectHandler(runtime),
    CMD023: revisePlanHandler(runtime, collaborators.artifacts, collaborators.patchCompiler),
    CMD025: approvePlanHandler(runtime, collaborators.disclosures),
    CMD026: withdrawApprovalHandler(runtime, collaborators.externalActions),
  });
}

export { createAgencyHandler, LAUNCH_ASSURANCE_POLICY } from "./create-agency.js";
export { createClientHandler } from "./create-client.js";
export { archiveClientHandler } from "./archive-client.js";
export { createProjectHandler } from "./create-project.js";
export { revisePlanHandler } from "./revise-plan.js";
export { approvePlanHandler, approvalHashOf } from "./approve-plan.js";
export type { ApprovalPreimage } from "./approve-plan.js";
export { withdrawApprovalHandler } from "./withdraw-approval.js";
