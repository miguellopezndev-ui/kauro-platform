/**
 * The seven B06 command contracts: input body (exactly the registry fields), result view, and the spec the transport and the
 * authorizer consume. Behaviour (reads, locks, preconditions in order, writes, events, OK/DENY/RACE) is specified in
 * docs/design/B06-domain-db-authz.md §7; handlers implementing these contracts belong to the B06 implementation mandate.
 */
import type { ServiceMode, SupportCategory } from "@kauro/domain";
import type { AcceptInvitationView, AgencyView, ApprovalView, EndClientView, InviteMemberView, MembershipView, PlanView, ProjectView, RetentionExtensionView, SupportCaseView, TransferOwnershipView } from "../api/views.js";
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

// --- CMD060 RequestRetentionExtension (B16 lane L2; docs/design/B16-L2-failure-matrix.md) -----------------------------------

export interface RequestRetentionExtensionBody {
  readonly expectedVersion: number;
  /** 1..259200 (registry: at most 259200 seconds within the original hard cap). */
  readonly requestedSeconds: number;
  readonly purpose: string;
  /** The terms version the requester accepts; it must be the version the agency accepted. */
  readonly termsVersion: string;
}
export const REQUEST_RETENTION_EXTENSION: CommandSpec<RequestRetentionExtensionBody> = spec<RequestRetentionExtensionBody>({
  id: "CMD060",
  name: "RequestRetentionExtension",
  method: "POST",
  path: "/api/v1/projects/{projectId}/retention-extensions",
  role: "AGENCY_OWNER_OR_ADMIN",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "requestedSeconds", "purpose", "termsVersion"],
});
export type RequestRetentionExtensionHandler = CommandHandler<RequestRetentionExtensionBody, RetentionExtensionView>;

/** The retention package's commands (B16): served beside the others, which stay closed sets. */
export const RETENTION_COMMANDS = Object.freeze({
  CMD060: REQUEST_RETENTION_EXTENSION,
} as const);
export type RetentionCommandId = keyof typeof RETENTION_COMMANDS;

// --- the team commands of package B16 (G-TENANT): CMD003..CMD007 ------------------------------------------------------------
// Behaviour: docs/design/B16-team-commands.md (decisions D-TEAM-n and the failure matrix); domain rules are
// packages/domain/src/model/membership.ts, database rules migration 0002 (enforce_membership_authority, enforce_invitation_rules).

export interface InviteMemberBody {
  readonly expectedVersion: number;
  readonly intendedIdentityRef: string;
  readonly role: string;
}
export const INVITE_MEMBER: CommandSpec<InviteMemberBody> = spec<InviteMemberBody>({
  id: "CMD003",
  name: "InviteMember",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/invitations",
  role: "AGENCY_OWNER_OR_ADMIN",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "intendedIdentityRef", "role"],
});
export type InviteMemberHandler = CommandHandler<InviteMemberBody, InviteMemberView>;

export interface AcceptInvitationBody {
  readonly invitationToken: string;
}
/** CMD004 is VERIFIED_USER: the caller holds no membership yet; the agency it runs in is the one its own invitation names. */
export const ACCEPT_INVITATION: CommandSpec<AcceptInvitationBody> = spec<AcceptInvitationBody>({
  id: "CMD004",
  name: "AcceptInvitation",
  method: "POST",
  path: "/api/v1/invitations/{invitationId}/accept",
  role: "VERIFIED_USER",
  scope: "NONE",
  aggregateParam: "invitationId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["invitationToken"],
});
export type AcceptInvitationHandler = CommandHandler<AcceptInvitationBody, AcceptInvitationView>;

export interface ChangeMembershipBody {
  readonly expectedVersion: number;
  readonly role: string;
  readonly assuranceProofRef: string;
}
export const CHANGE_MEMBERSHIP: CommandSpec<ChangeMembershipBody> = spec<ChangeMembershipBody>({
  id: "CMD005",
  name: "ChangeMembership",
  method: "POST",
  path: "/api/v1/memberships/{membershipId}/capabilities",
  role: "AGENCY_OWNER",
  scope: "AGENCY_HEADER",
  aggregateParam: "membershipId",
  expectedVersionRequired: true,
  stepUpRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "role", "assuranceProofRef"],
});
export type ChangeMembershipHandler = CommandHandler<ChangeMembershipBody, MembershipView>;

export interface RevokeMembershipBody {
  readonly expectedVersion: number;
  readonly reasonCode: string;
}
export const REVOKE_MEMBERSHIP: CommandSpec<RevokeMembershipBody> = spec<RevokeMembershipBody>({
  id: "CMD006",
  name: "RevokeMembership",
  method: "POST",
  path: "/api/v1/memberships/{membershipId}/revoke",
  role: "AGENCY_OWNER_OR_ADMIN",
  scope: "AGENCY_HEADER",
  aggregateParam: "membershipId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "reasonCode"],
});
export type RevokeMembershipHandler = CommandHandler<RevokeMembershipBody, MembershipView>;

export interface TransferOwnershipBody {
  readonly expectedVersion: number;
  readonly newOwnerMembershipId: string;
  readonly assuranceProofRef: string;
}
export const TRANSFER_OWNERSHIP: CommandSpec<TransferOwnershipBody> = spec<TransferOwnershipBody>({
  id: "CMD007",
  name: "TransferOwnership",
  method: "POST",
  path: "/api/v1/agencies/{agencyId}/ownership-transfers",
  role: "AGENCY_OWNER",
  scope: "AGENCY_PATH",
  aggregateParam: "agencyId",
  expectedVersionRequired: true,
  stepUpRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "newOwnerMembershipId", "assuranceProofRef"],
});
export type TransferOwnershipHandler = CommandHandler<TransferOwnershipBody, TransferOwnershipView>;

/** The team package's commands (B16): served beside the seven of B06, which stay a closed set. */
export const TEAM_COMMANDS = Object.freeze({
  CMD003: INVITE_MEMBER,
  CMD004: ACCEPT_INVITATION,
  CMD005: CHANGE_MEMBERSHIP,
  CMD006: REVOKE_MEMBERSHIP,
  CMD007: TRANSFER_OWNERSHIP,
} as const);
export type TeamCommandId = keyof typeof TEAM_COMMANDS;

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
