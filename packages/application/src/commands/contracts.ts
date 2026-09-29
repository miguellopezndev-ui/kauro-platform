/**
 * The seven B06 command contracts: input body (exactly the registry fields), result view, and the spec the transport and the
 * authorizer consume. Behaviour (reads, locks, preconditions in order, writes, events, OK/DENY/RACE) is specified in
 * docs/design/B06-domain-db-authz.md §7; handlers implementing these contracts belong to the B06 implementation mandate.
 */
import type { ServiceMode, SupportCategory } from "@kauro/domain";
import type { AgencyView, ApprovalView, EndClientView, MembershipView, PlanView, ProjectView, SupportCaseView } from "../api/views.js";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { ActiveWorkSummary, CompletedExternalAction } from "../ports/work-inspectors.js";

function spec<Body>(s: CommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze(s);
}

// --- CMD001 CreateAgency ---------------------------------------------------------------------------------------------

export interface CreateAgencyBody {
  readonly displayName: string;
}
export interface CreateAgencyView {
  readonly agency: AgencyView;
  readonly membership: MembershipView;
}
export const CREATE_AGENCY: CommandSpec<CreateAgencyBody> = spec<CreateAgencyBody>({
  id: "CMD001",
  name: "CreateAgency",
  method: "POST",
  path: "/api/v1/agencies",
  role: "VERIFIED_USER",
  scope: "NONE",
  aggregateParam: null,
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["displayName"],
});
export type CreateAgencyHandler = CommandHandler<CreateAgencyBody, CreateAgencyView>;

// --- CMD009 CreateClient ---------------------------------------------------------------------------------------------

export interface CreateClientBody {
  readonly displayName: string;
  readonly processingAuthorityRef: string;
}
export const CREATE_CLIENT: CommandSpec<CreateClientBody> = spec<CreateClientBody>({
  id: "CMD009",
  name: "CreateClient",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/clients",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["displayName", "processingAuthorityRef"],
});
export type CreateClientHandler = CommandHandler<CreateClientBody, EndClientView>;

// --- CMD010 ArchiveClient --------------------------------------------------------------------------------------------

export interface ArchiveClientBody {
  readonly expectedVersion: number;
}
export interface ArchiveClientView {
  readonly client: EndClientView;
  /** What archiving retained (07 "Archiving a client stops new projects but does not delete active paid work implicitly"). */
  readonly retainedActiveWork: ActiveWorkSummary;
}
export const ARCHIVE_CLIENT: CommandSpec<ArchiveClientBody> = spec<ArchiveClientBody>({
  id: "CMD010",
  name: "ArchiveClient",
  method: "POST",
  path: "/api/v1/clients/{clientId}/archive",
  role: "AGENCY_ADMIN",
  scope: "AGENCY_HEADER",
  aggregateParam: "clientId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion"],
});
export type ArchiveClientHandler = CommandHandler<ArchiveClientBody, ArchiveClientView>;

// --- CMD011 CreateProject --------------------------------------------------------------------------------------------

export interface CreateProjectBody {
  readonly mode: ServiceMode;
  readonly purpose: string;
  readonly targetInstanceRef?: string;
}
export const CREATE_PROJECT: CommandSpec<CreateProjectBody> = spec<CreateProjectBody>({
  id: "CMD011",
  name: "CreateProject",
  method: "POST",
  path: "/api/v1/clients/{clientId}/projects",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "clientId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["mode", "purpose", "targetInstanceRef"],
});
export type CreateProjectHandler = CommandHandler<CreateProjectBody, ProjectView>;

// --- CMD023 RevisePlan -----------------------------------------------------------------------------------------------

export interface RevisePlanBody {
  readonly expectedVersion: number;
  readonly decisionPatchArtifactRef: string;
}
export interface RevisePlanView {
  /** The new revision (VALIDATION_REQUIRED). */
  readonly plan: PlanView;
  /** The predecessor after the transition (SUPERSEDED, version + 1). */
  readonly supersededPlan: { readonly planId: string; readonly version: number; readonly state: "SUPERSEDED" };
  /** Impact map (Plan machine "Invalidate only dependent evidence with impact map"). */
  readonly invalidated: { readonly validationReceiptHash?: string; readonly approvalId?: string };
}
export const REVISE_PLAN: CommandSpec<RevisePlanBody> = spec<RevisePlanBody>({
  id: "CMD023",
  name: "RevisePlan",
  method: "POST",
  path: "/api/v1/plans/{planId}/revisions",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "planId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "decisionPatchArtifactRef"],
});
export type RevisePlanHandler = CommandHandler<RevisePlanBody, RevisePlanView>;

// --- CMD025 ApprovePlan ----------------------------------------------------------------------------------------------

export interface ApprovePlanBody {
  readonly expectedVersion: number;
  readonly planHash: string;
  readonly validationReceiptHash: string;
  readonly disclosuresHash: string;
  readonly assuranceProofRef: string;
}
export interface ApprovePlanView {
  readonly approval: ApprovalView;
  readonly plan: PlanView;
}
export const APPROVE_PLAN: CommandSpec<ApprovePlanBody> = spec<ApprovePlanBody>({
  id: "CMD025",
  name: "ApprovePlan",
  method: "POST",
  path: "/api/v1/plans/{planId}/approve",
  role: "AGENCY_APPROVER",
  scope: "AGENCY_HEADER",
  aggregateParam: "planId",
  expectedVersionRequired: true,
  stepUpRequired: true,
  authorityHashFields: ["planHash", "validationReceiptHash", "disclosuresHash"],
  fields: ["expectedVersion", "planHash", "validationReceiptHash", "disclosuresHash", "assuranceProofRef"],
});
export type ApprovePlanHandler = CommandHandler<ApprovePlanBody, ApprovePlanView>;

// --- CMD026 WithdrawApproval -----------------------------------------------------------------------------------------

export interface WithdrawApprovalBody {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export interface WithdrawApprovalView {
  readonly approval: ApprovalView;
  readonly plan: PlanView;
  /** Completed external/customer actions identified separately (CMD026 precondition); never promised reversible. */
  readonly completedExternalActions: ReadonlyArray<CompletedExternalAction>;
}
export const WITHDRAW_APPROVAL: CommandSpec<WithdrawApprovalBody> = spec<WithdrawApprovalBody>({
  id: "CMD026",
  name: "WithdrawApproval",
  method: "POST",
  path: "/api/v1/plans/{planId}/withdraw",
  role: "AGENCY_APPROVER",
  scope: "AGENCY_HEADER",
  aggregateParam: "planId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "reasonCode"],
});
export type WithdrawApprovalHandler = CommandHandler<WithdrawApprovalBody, WithdrawApprovalView>;

// --- CMD044 CreateSupportCase (B11 W4) -------------------------------------------------------------------------------------

export interface CreateSupportCaseBody {
  readonly category: SupportCategory;
  readonly summary: string;
  /** Upload ids the case cites: an empty list until the upload package serves them (D-SUP-2). */
  readonly evidenceRefs?: ReadonlyArray<string>;
}
export const CREATE_SUPPORT_CASE: CommandSpec<CreateSupportCaseBody> = spec<CreateSupportCaseBody>({
  id: "CMD044",
  name: "CreateSupportCase",
  method: "POST",
  path: "/api/v1/projects/{projectId}/support-cases",
  role: "AGENCY_MEMBER",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["category", "summary", "evidenceRefs"],
});
export type CreateSupportCaseHandler = CommandHandler<CreateSupportCaseBody, SupportCaseView>;

/** The commands of the support package: separate from the seven of B06, which stay a closed set. */
export const SUPPORT_COMMANDS = Object.freeze({
  CMD044: CREATE_SUPPORT_CASE,
} as const);
export type SupportCommandId = keyof typeof SUPPORT_COMMANDS;

export const B06_COMMANDS = Object.freeze({
  CMD001: CREATE_AGENCY,
  CMD009: CREATE_CLIENT,
  CMD010: ARCHIVE_CLIENT,
  CMD011: CREATE_PROJECT,
  CMD023: REVISE_PLAN,
  CMD025: APPROVE_PLAN,
  CMD026: WITHDRAW_APPROVAL,
} as const);
export type B06CommandId = keyof typeof B06_COMMANDS;
