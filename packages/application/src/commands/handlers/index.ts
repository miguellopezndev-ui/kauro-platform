/**
 * The seven B06 command handlers assembled over one runtime and the collaborators they need. The handlers depend on ports only
 * (unit of work, repositories, event publisher, journal, authorizer, plan services, inspectors); the persistence adapter and the
 * authorization implementation are wired at the entrypoint.
 */
import type { RandomBytes } from "@kauro/domain";
import type { AbuseLimiter } from "../../ports/assurance-and-admission.js";
import type { ArtifactResolver, DisclosureComposer, PlanPatchCompiler } from "../../ports/plan-services.js";
import type { ActiveWorkInspector, CommercialConsequenceInspector, ExternalActionInspector } from "../../ports/work-inspectors.js";
import type {
  AcceptInvitationHandler,
  ApprovePlanHandler,
  ArchiveClientHandler,
  ChangeMembershipHandler,
  InviteMemberHandler,
  RevokeMembershipHandler,
  TransferOwnershipHandler,
  CreateAgencyHandler,
  CreateClientHandler,
  CreateProjectHandler,
  CreateSupportCaseHandler,
  RevisePlanHandler,
  WithdrawApprovalHandler,
} from "../contracts.js";
import type { CommandRuntime } from "../runtime.js";
import { acceptInvitationHandler } from "./accept-invitation.js";
import { approvePlanHandler } from "./approve-plan.js";
import { changeMembershipHandler } from "./change-membership.js";
import { inviteMemberHandler } from "./invite-member.js";
import { revokeMembershipHandler } from "./revoke-membership.js";
import { transferOwnershipHandler } from "./transfer-ownership.js";
import { archiveClientHandler } from "./archive-client.js";
import { createAgencyHandler } from "./create-agency.js";
import { createClientHandler } from "./create-client.js";
import { createProjectHandler } from "./create-project.js";
import { createSupportCaseHandler, type SupportOptions } from "./create-support-case.js";
import { revisePlanHandler } from "./revise-plan.js";
import { withdrawApprovalHandler } from "./withdraw-approval.js";

export interface B06Collaborators {
  readonly abuseLimiter: AbuseLimiter;
  readonly activeWork: ActiveWorkInspector;
  readonly artifacts: ArtifactResolver;
  readonly patchCompiler: PlanPatchCompiler;
  readonly disclosures: DisclosureComposer;
  readonly externalActions: ExternalActionInspector;
  readonly commercialConsequences: CommercialConsequenceInspector;
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

/** The support package's commands (B11 W4): served beside the seven of B06, which stay a closed set. */
export interface SupportHandlers {
  readonly CMD044: CreateSupportCaseHandler;
}

/** The team package's commands (B16, G-TENANT): CMD003..CMD007, served beside B06's seven. */
export interface TeamHandlers {
  readonly CMD003: InviteMemberHandler;
  readonly CMD004: AcceptInvitationHandler;
  readonly CMD005: ChangeMembershipHandler;
  readonly CMD006: RevokeMembershipHandler;
  readonly CMD007: TransferOwnershipHandler;
}

export interface TeamOptions {
  /** The random source of the invitation token (32 bytes). */
  readonly random: RandomBytes;
}

export function createTeamHandlers(runtime: CommandRuntime, options: TeamOptions): TeamHandlers {
  return Object.freeze({
    CMD003: inviteMemberHandler(runtime, { random: options.random }),
    CMD004: acceptInvitationHandler(runtime),
    CMD005: changeMembershipHandler(runtime),
    CMD006: revokeMembershipHandler(runtime),
    CMD007: transferOwnershipHandler(runtime),
  });
}

export function createSupportHandlers(runtime: CommandRuntime, options: SupportOptions = {}): SupportHandlers {
  return Object.freeze({ CMD044: createSupportCaseHandler(runtime, options) });
}

export function createB06Handlers(runtime: CommandRuntime, collaborators: B06Collaborators): B06Handlers {
  return Object.freeze({
    CMD001: createAgencyHandler(runtime, collaborators.abuseLimiter),
    CMD009: createClientHandler(runtime),
    CMD010: archiveClientHandler(runtime, collaborators.activeWork),
    CMD011: createProjectHandler(runtime),
    CMD023: revisePlanHandler(runtime, collaborators.artifacts, collaborators.patchCompiler, collaborators.commercialConsequences),
    CMD025: approvePlanHandler(runtime, collaborators.disclosures),
    CMD026: withdrawApprovalHandler(runtime, collaborators.externalActions),
  });
}

export { createAgencyHandler, LAUNCH_ASSURANCE_POLICY } from "./create-agency.js";
export { createClientHandler } from "./create-client.js";
export { archiveClientHandler } from "./archive-client.js";
export { createProjectHandler } from "./create-project.js";
export { createSupportCaseHandler } from "./create-support-case.js";
export type { SupportOptions } from "./create-support-case.js";
export { revisePlanHandler } from "./revise-plan.js";
export { approvePlanHandler, approvalHashOf } from "./approve-plan.js";
export type { ApprovalPreimage } from "./approve-plan.js";
export { withdrawApprovalHandler } from "./withdraw-approval.js";
export { inviteMemberHandler, INVITATION_TTL_MS } from "./invite-member.js";
export { acceptInvitationHandler } from "./accept-invitation.js";
export { changeMembershipHandler } from "./change-membership.js";
export { revokeMembershipHandler } from "./revoke-membership.js";
export { transferOwnershipHandler } from "./transfer-ownership.js";
