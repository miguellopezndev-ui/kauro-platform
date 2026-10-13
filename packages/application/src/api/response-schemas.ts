/**
 * Closed response schemas (JSON Schema 2020-12) of the Kauro API: one definition per DTO view, the COMPLETED envelope of every
 * served command, the ACCEPTED envelope and the operational routes' own replies (10 "Version and validation": "Wire contracts
 * use JSON Schema 2020-12 with closed objects"; "OpenAPI is generated from the owning contract registry and checked against
 * actual routes ... TypeScript types alone are insufficient runtime validation"; 10 "Responses and safe errors": "Synchronous
 * success returns a validated DTO and version"; reference/FIELD_CONTRACTS.md "Internal records are not automatically safe
 * browser DTOs. Responses must select only authorized fields and test serialization against sentinel data").
 *
 * Derivation from the registry. A view that projects a registry contract (Agency, Membership, EndClient, Plan, Approval) takes
 * the schema of every selected member from the generated contract bundle (`@kauro/contracts/schemas.json`, the registry
 * compiled with provenance) at start-up: its type, enum, length, pattern, format and description are the registry's, and a
 * member the registry requires stays required. The platform may only narrow a derived member by adding a keyword the registry
 * member does not carry (an id is a lowercase RFC 9562 UUID because the server mints UUIDv7/UUIDv5 — design D-ID-1, D-ID-2);
 * it can never relax one. Every registry member of the contract is either selected or listed as withheld with its reason, so a
 * new registry member cannot silently appear on, or silently stay off, the wire. Members the registry has no contract for
 * (ProjectView, open question Q4; the version of an EndClient, D-AGG-2; the approval hash) are platform fields in the field
 * vocabulary of reference/FIELD_CONTRACTS.md "Common rules".
 *
 * These schemas are compiled once, by the same strict validator as the request schemas (api/json-schema), into the closed
 * validator of api/schema-validation; every reply of the api is validated against them before it is sent (apps/api), and
 * tools/openapi.mjs publishes them in the OpenAPI document. Nothing here is compiled from a runtime value (S093).
 */
import { AGENCY_CAPABILITIES, DomainFailure, INQUIRY_BUYER_TYPES, INQUIRY_DESTINATIONS, INQUIRY_RECORD_BANDS, INQUIRY_TIMINGS, OFFERED_CAPABILITY_STATES, PROJECT_STATES, SERVICE_MODES } from "@kauro/domain";
import { AUDIT_ROUTES, type AuditCommandId, type AuditIntakeId, type AuditRouteId } from "../audit/contracts.js";
import { AUDIT_COMMAND_RESPONSES, AUDIT_VIEW_DEFINITIONS } from "../audit/response-views.js";
import { EXECUTION_ROUTES, type ExecutionCommandId, type ExecutionRouteId } from "../execution/contracts.js";
import { EXECUTION_COMMAND_RESPONSES, EXECUTION_VIEW_DEFINITIONS } from "../execution/response-views.js";
import { SOURCE_ROUTES } from "../sources/contracts.js";
import type { B07CommandId } from "../sources/contracts.js";
import type { SourceIntakeId, SourceReadId } from "../sources/outcomes.js";
import { SESSION_URL_MEMBER, SESSION_URL_VIEW, SOURCE_COMMAND_RESPONSES, SOURCE_VIEW_DEFINITIONS } from "../sources/response-views.js";
import { LABEL_PATTERN, TEXT_PATTERN } from "./request-schemas.js";
import { READINESS_BLOCKERS } from "./views.js";
import {
  FORBIDDEN_RESPONSE_FIELDS,
  RESPONSE_FIELD_VOCABULARY,
  RESPONSE_SCHEMA_PREFIX,
  VIEW_MEMBER_KIT,
  declaredMembers,
  openObjects,
  viewSchema,
  type JsonSchema,
  type RegistryBundle,
  type ViewDefinition,
} from "./view-kit.js";

// the view kit (api/view-kit) is part of this module's public surface, as it was before the B07 views joined the served ones
export {
  RESPONSE_SCHEMA_PREFIX,
  RESPONSE_FIELD_VOCABULARY,
  VIEW_MEMBER_KIT,
  FORBIDDEN_RESPONSE_FIELDS,
  declaredMembers,
  openObjects,
  viewSchema,
} from "./view-kit.js";
export type { JsonSchema, DerivedMember, PlatformMember, ViewMember, ViewDefinition, RegistryBundle } from "./view-kit.js";

const { ID, VERSION, HASH, UTC, LABEL, COUNT } = RESPONSE_FIELD_VOCABULARY;
const { registry, platform, ref, NARROW_ID, NARROW_LABEL, CURSOR, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION } = VIEW_MEMBER_KIT;

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
/** A registry summary narrowed to what the request schema and the table keep: 20 characters at least, a visible one, no control character (B11 D-SUP-2). */
const NARROW_SUMMARY = Object.freeze({ minLength: 20, pattern: TEXT_PATTERN });

/**
 * The commands this edition serves, by registry id: the seven of B06, since mandate B07-COMMANDS the six of the source lifecycle
 * (docs/design/B07-upload-source-lifecycle.md §9.5: served routes move from x-kauro-planned to paths), and CMD044 of the support
 * package (B11 W4).
 */
export type ServedCommandId = "CMD001" | "CMD009" | "CMD010" | "CMD011" | "CMD023" | "CMD025" | "CMD026" | B07CommandId | ExecutionCommandId | AuditCommandId | "CMD044";
export type CommandResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}${ServedCommandId}`;
export type AcceptedResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}accepted`;
export type OperationalResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}op:${string}`;
/**
 * The manual-10 reads this edition serves (re-check finding N16), the reads of the source lifecycle (B07), GetJob and GetAudit
 * (B08) and the two support reads (B11 W4), by operation id.
 */
export type ReadOperationId = "ListAgencies" | "GetAgency" | "ListMembers" | "ListClients" | "GetProject" | SourceReadId | ExecutionRouteId | AuditRouteId | "ListSupportCases" | "GetSupportCase";
export type ReadResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}read:${ReadOperationId}`;
/** The document intakes this edition serves (B07 D-SEL-2: the selection manifest; B08 D8-PLAN-1: the decision artifact), by operation id. */
export type IntakeOperationId = SourceIntakeId | AuditIntakeId;
export type IntakeResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}intake:${IntakeOperationId}`;
export type ResponseSchemaId = CommandResponseSchemaId | AcceptedResponseSchemaId | OperationalResponseSchemaId | ReadResponseSchemaId | IntakeResponseSchemaId;

/**
 * Every DTO definition of the B06 routes (and, since B11 W4, the support case views). Order is the order of the OpenAPI
 * components. A view is closed: a member not listed here can never reach the wire, whatever a record or a collaborator
 * carries.
 */
const B06_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "AgencyView",
    description: "The safe agency view (10 \"GET /agencies/{agencyId} returns the safe agency view\"), with the caller's permitted actions.",
    contract: "Agency",
    withheld: {
      legalProfileRef: "Private reviewed customer billing profile (registry description); billing identity is a separate resource (10 \"Branding and billing settings are separate resources\").",
      firstQualifyingCaptureId: "Commercial designation owned by the payment packages; no B06 route decides it.",
    },
    members: {
      agencyId: registry(true, NARROW_ID),
      version: registry(true),
      displayName: registry(true, NARROW_LABEL),
      state: registry(true),
      termsVersion: registry(false),
      privacyAgreementVersion: registry(false),
      createdAt: registry(true),
      permittedActions: platform(true, { type: "array", maxItems: AGENCY_CAPABILITIES.length, items: { type: "string", enum: [...AGENCY_CAPABILITIES] } }, "The caller's capabilities in this agency, derived from the membership role server-side (07 \"The handoff to UI includes every state, safe field, permitted action\")."),
    },
  },
  {
    name: "MembershipView",
    description: "Team information appropriate to the caller: no authentication tokens, recovery settings or security evidence (10 \"Agency and team routes\").",
    contract: "Membership",
    withheld: {},
    members: {
      membershipId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      userId: registry(true, NARROW_ID),
      role: registry(true),
      state: registry(true),
      version: registry(true),
      assurancePolicy: registry(true, NARROW_LABEL),
      acceptedAt: registry(false),
    },
  },
  {
    name: "EndClientView",
    description: "A client workspace with the version its edit commands compare (design D-AGG-2).",
    contract: "EndClient",
    withheld: {},
    members: {
      clientId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      version: platform(true, VERSION, "Concurrency version of the client (design D-AGG-2, open question Q3: the registry contract has no version although CMD010 names expectedVersion)."),
      displayName: registry(true, NARROW_LABEL),
      state: registry(true),
      processingAuthorityRef: registry(true, NARROW_ID),
      createdAt: registry(true),
      archivedAt: platform(false, UTC, "When the client was archived (CMD010); present exactly when the state is ARCHIVED."),
      permittedActions: platform(true, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "RevisionSummary",
    description: "The current dataset revision of a project (10 \"GET /projects/{projectId} returns the current revision summary\").",
    contract: "DatasetRevision",
    withheld: {
      scope: "The tenant scope is the enclosing ProjectView's agencyId, clientId and projectId.",
      files: "Source file manifests are served by the revision routes of the upload package, not by a project summary.",
      manifestHash: "Sealed-source evidence; the plan and approval views carry it as revisionHash once a plan binds it.",
      projectionHash: "Parser/projection evidence of the upload package.",
      sealedAt: "Served by the revision routes of the upload package.",
      supersedesRevisionId: "Lineage is served by the revision routes of the upload package.",
    },
    members: {
      revisionId: registry(true, NARROW_ID),
      state: registry(true),
      version: registry(true),
    },
  },
  {
    name: "ProjectView",
    description: "A project with its current revision summary and the readiness blockers computed from durable facts at read time (CMD011 effect \"visible readiness blockers\"; 10 \"A UI readiness flag is informative, not authority\"). The registry has no Project contract (design D-AGG-1, open question Q4).",
    contract: null,
    withheld: {},
    members: {
      projectId: platform(true, ID, "Project identity."),
      agencyId: platform(true, ID, "Owning agency."),
      clientId: platform(true, ID, "Owning client workspace."),
      version: platform(true, VERSION, "Concurrency version of the project."),
      state: platform(true, { type: "string", enum: [...PROJECT_STATES] }, "Project state (design D-AGG-1)."),
      mode: platform(true, { type: "string", enum: [...SERVICE_MODES] }, "Service mode (02 \"Service modes\")."),
      purpose: platform(true, LABEL, "Declared purpose, an untrusted label."),
      targetInstanceRef: platform(false, ID, "Declared target instance for a CRM mode (design D-CMD-4)."),
      capabilityVersion: registry(true, undefined, ["Capability", "version"]),
      currentRevision: platform(true, ref("RevisionSummary"), "Current revision summary."),
      readinessBlockers: platform(true, { type: "array", maxItems: READINESS_BLOCKERS.length, items: { type: "string", enum: [...READINESS_BLOCKERS] } }, "Readiness blockers in a fixed order."),
      createdAt: platform(true, UTC, "Server creation time."),
      permittedActions: platform(true, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "PlanView",
    description: "A plan revision summary: its lifecycle, its bindings and its lineage. The plan body is not part of a summary.",
    contract: "Plan",
    withheld: {
      mappings: "Plan body (customer field names and decisions, possibly L3/L4 per FIELD_CONTRACTS \"Common rules\"); served by the plan routes of the audit package, never by a command reply.",
      identities: "Plan body; as mappings.",
      transforms: "Plan body; as mappings.",
      relationships: "Plan body; as mappings.",
    },
    members: {
      planId: registry(true, NARROW_ID),
      agencyId: platform(true, ID, "Owning agency."),
      projectId: platform(true, ID, "Owning project."),
      version: registry(true),
      state: registry(true),
      bodyHash: registry(true),
      revisionHash: registry(true),
      targetContractHash: registry(true),
      policyHash: registry(true),
      validationReceiptHash: platform(false, HASH, "The current validation receipt of this revision, once validated."),
      approvalId: platform(false, ID, "The approval of this revision, once approved."),
      supersedesPlanId: platform(false, ID, "The predecessor revision (design D-PLAN-1)."),
      supersededByPlanId: platform(false, ID, "The successor revision once superseded (design D-PLAN-1)."),
      createdAt: platform(true, UTC, "Server creation time."),
      permittedActions: platform(true, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "ApprovalView",
    description: "An approval with every member of its KAURO_PLAN_APPROVAL_V1 preimage, so a consumer recomputes approvalHash (reference/HASHING_AND_ACCOUNTING_RULES \"the consumer recomputes the relevant preimage\").",
    contract: "Approval",
    withheld: {},
    members: {
      approvalId: registry(true, NARROW_ID),
      actorId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      planId: platform(true, ID, "The approved plan revision."),
      version: platform(true, VERSION, "Concurrency version of the approval (1 when created, 2 once withdrawn)."),
      actorMembershipId: platform(true, ID, "The membership the actor approved under (07 \"PlanApproval records actor identity, membership version, assurance evidence\")."),
      planHash: registry(true),
      revisionHash: registry(true),
      targetContractHash: registry(true),
      validationReceiptHash: registry(true),
      disclosuresHash: registry(true),
      approvalHash: platform(true, HASH, "KAURO_PLAN_APPROVAL_V1 digest of approvalId, actorId, agencyId, planHash, revisionHash, targetContractHash, validationReceiptHash, disclosuresHash and createdAt."),
      createdAt: registry(true),
      withdrawnAt: registry(false),
      withdrawnByMembershipId: platform(false, ID, "The membership that withdrew the approval (CMD026)."),
      withdrawReasonCode: platform(false, LABEL, "The reason the withdrawal named (CMD026 field reasonCode, registry type label)."),
      permittedActions: platform(true, RESOURCE_ACTIONS_SCHEMA, RESOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "AgencyMembershipView",
    description: "One of the caller's actual memberships (ACTIVE or SUSPENDED) with its agency (10 \"GET /agencies lists only actual memberships\"; re-check finding N16).",
    contract: null,
    withheld: {},
    members: {
      agencyId: registry(true, NARROW_ID, ["Agency", "agencyId"]),
      displayName: registry(true, NARROW_LABEL, ["Agency", "displayName"]),
      state: registry(true, undefined, ["Agency", "state"]),
      version: registry(true, undefined, ["Agency", "version"]),
      membershipId: registry(true, NARROW_ID, ["Membership", "membershipId"]),
      role: registry(true, undefined, ["Membership", "role"]),
      membershipState: registry(true, undefined, ["Membership", "state"]),
      permittedActions: platform(true, { type: "array", maxItems: AGENCY_CAPABILITIES.length, items: { type: "string", enum: [...AGENCY_CAPABILITIES] } }, "The caller's capabilities in the agency, derived from the membership role server-side; none while the membership is SUSPENDED."),
    },
  },
  {
    name: "TeamMemberView",
    description: "A teammate as the caller may see it (10 \"GET /agencies/{agencyId}/members returns only team information appropriate to the caller. It does not expose authentication provider tokens, recovery settings or another member's private security evidence\"; re-check finding N16). A caller who manages the team sees every membership with its lifecycle times; any other member sees the ACTIVE team's roles.",
    contract: "Membership",
    withheld: {
      agencyId: "The path names the agency every listed membership belongs to.",
      userId: "Another person's identity reference is not team information appropriate to every caller; the caller's own membership is marked self.",
      assurancePolicy: "The membership's authentication-strength configuration is security configuration, not team information (10: no recovery settings or security evidence).",
    },
    members: {
      membershipId: registry(true, NARROW_ID),
      role: registry(true),
      state: registry(true),
      version: registry(true),
      self: platform(true, { type: "boolean" }, "Whether this is the caller's own membership."),
      createdAt: platform(false, UTC, "When the membership was created; shown to a caller who manages the team."),
      acceptedAt: registry(false),
    },
  },
  {
    name: "AgencyPage",
    description: "A page of the caller's actual memberships in (agency createdAt, agencyId) order (10 \"Pagination, search and exports\"; the R2 policy's api.pageDefault and api.pageMaximum).",
    contract: null,
    withheld: {},
    members: {
      items: platform(true, { type: "array", maxItems: 100, items: ref("AgencyMembershipView") }, "The page."),
      nextCursor: platform(false, CURSOR, "The cursor of the next page, when there may be one (opaque, bound to the caller and this list)."),
    },
  },
  {
    name: "TeamPage",
    description: "A page of the agency's team as the caller may see it, in (createdAt, membershipId) order.",
    contract: null,
    withheld: {},
    members: {
      items: platform(true, { type: "array", maxItems: 100, items: ref("TeamMemberView") }, "The page."),
      nextCursor: platform(false, CURSOR, "The cursor of the next page, when there may be one (opaque, bound to the caller, the agency and this list)."),
    },
  },
  {
    name: "ClientPage",
    description: "A page of the agency's safe client summaries in (createdAt, clientId) order (10 \"GET lists safe client summaries with pagination\").",
    contract: null,
    withheld: {},
    members: {
      items: platform(true, { type: "array", maxItems: 100, items: ref("EndClientView") }, "The page."),
      nextCursor: platform(false, CURSOR, "The cursor of the next page, when there may be one (opaque, bound to the caller, the agency and this list)."),
    },
  },
  {
    name: "ActiveWorkSummary",
    description: "What archiving a client retained (10 \"Archiving a client stops new projects but does not delete active paid work implicitly\").",
    contract: null,
    withheld: {},
    members: {
      openProjects: platform(true, COUNT, "Open projects of the client."),
      activeJobs: platform(true, COUNT, "Active jobs of the client."),
      liveCommercialAuthorizations: platform(true, COUNT, "Live commercial authorizations of the client."),
    },
  },
  {
    name: "CompletedExternalAction",
    description: "A completed external or customer action a withdrawal identifies separately and never promises to reverse (CMD026).",
    contract: null,
    withheld: {},
    members: {
      kind: platform(true, { type: "string", enum: ["IMPORT_STAGE_VERIFIED", "IMPORT_STAGE_REPORTED", "PACKAGE_DELIVERED"] }, "Kind of completed action."),
      referenceId: platform(true, ID, "Platform id of the stage or package."),
    },
  },
  {
    name: "SupersededPlanSummary",
    description: "The predecessor revision after RevisePlan: SUPERSEDED at its new version.",
    contract: null,
    withheld: {},
    members: {
      planId: platform(true, ID, "Predecessor revision."),
      version: platform(true, VERSION, "Its version after the supersession."),
      state: platform(true, { type: "string", const: "SUPERSEDED" }, "Always SUPERSEDED."),
    },
  },
  {
    name: "PlanImpactMap",
    description: "Dependent evidence the revision invalidated (Plan machine \"Invalidate only dependent evidence with impact map\").",
    contract: null,
    withheld: {},
    members: {
      validationReceiptHash: platform(false, HASH, "The predecessor's receipt, when it was VALIDATED or APPROVED."),
      approvalId: platform(false, ID, "The predecessor's approval, when it was APPROVED."),
    },
  },
  {
    name: "CreateAgencyView",
    description: "CMD001 CreateAgency result: the DRAFT agency and the creator's OWNER membership.",
    contract: null,
    withheld: {},
    members: {
      agency: platform(true, ref("AgencyView"), "The created agency."),
      membership: platform(true, ref("MembershipView"), "The creator's owner membership."),
    },
  },
  {
    name: "ArchiveClientView",
    description: "CMD010 ArchiveClient result: the archived client and the work archiving retained; no deletion, refund or rollback member.",
    contract: null,
    withheld: {},
    members: {
      client: platform(true, ref("EndClientView"), "The archived client."),
      retainedActiveWork: platform(true, ref("ActiveWorkSummary"), "The retained active work."),
    },
  },
  {
    name: "RevisePlanView",
    description: "CMD023 RevisePlan result: the new revision, the superseded predecessor and the impact map.",
    contract: null,
    withheld: {},
    members: {
      plan: platform(true, ref("PlanView"), "The new revision (VALIDATION_REQUIRED)."),
      supersededPlan: platform(true, ref("SupersededPlanSummary"), "The predecessor after the transition."),
      invalidated: platform(true, ref("PlanImpactMap"), "Dependent evidence invalidated."),
    },
  },
  {
    name: "ApprovePlanView",
    description: "CMD025 ApprovePlan result: the immutable approval and the APPROVED plan.",
    contract: null,
    withheld: {},
    members: {
      approval: platform(true, ref("ApprovalView"), "The created approval."),
      plan: platform(true, ref("PlanView"), "The approved plan."),
    },
  },
  {
    name: "WithdrawApprovalView",
    description: "CMD026 WithdrawApproval result: the withdrawn approval, the WITHDRAWN plan and the completed external actions, identified separately; no rollback or refund member.",
    contract: null,
    withheld: {},
    members: {
      approval: platform(true, ref("ApprovalView"), "The withdrawn approval."),
      plan: platform(true, ref("PlanView"), "The withdrawn plan."),
      completedExternalActions: platform(true, { type: "array", items: ref("CompletedExternalAction") }, "Completed external or customer actions, never promised reversible."),
    },
  },
  {
    name: "SupportCaseView",
    description: "A support case as its agency sees it (owner manual 18: support metadata must not become an unrestricted raw-data channel): the classified case with the covered-hours follow-up. It cites uploads by id only and never the requester's user id (B11 W4).",
    contract: "SupportCase",
    withheld: {},
    members: {
      caseId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      projectId: registry(true, NARROW_ID),
      category: registry(true),
      severity: registry(true),
      state: registry(true),
      summary: registry(true, NARROW_SUMMARY),
      evidenceRefs: registry(true),
      nextReviewAt: registry(true),
      createdByMembershipId: platform(true, ID, "The membership that opened the case (an agency-internal identity the caller already sees in team views)."),
      createdAt: platform(true, UTC, "When the case was opened."),
      version: platform(true, VERSION, "The case version: 1 when opened, one more for every edit."),
    },
  },
  {
    name: "SupportCasePage",
    description: "A page of one project's support cases in (createdAt, caseId) order, oldest first.",
    contract: null,
    withheld: {},
    members: {
      items: platform(true, { type: "array", maxItems: 100, items: ref("SupportCaseView") }, "The page."),
      nextCursor: platform(false, CURSOR, "The cursor of the next page, when there may be one (opaque, bound to the caller, the project and this list)."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

/**
 * Every DTO definition of the served routes: B06's, then the source lifecycle's (sources/response-views, joined when mandate
 * B07-COMMANDS served its routes; design §9.5). A view is closed: a member not listed can never reach the wire.
 */
export const VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([...B06_VIEW_DEFINITIONS, ...SOURCE_VIEW_DEFINITIONS, ...EXECUTION_VIEW_DEFINITIONS, ...AUDIT_VIEW_DEFINITIONS]);

/**
 * The success reply of a served command: a COMPLETED envelope carrying a view at 200 or 201, or — CompleteUpload (CMD014), whose
 * completion remains asynchronous (B07 D-RUN-1) — B06's ACCEPTED envelope at 202 and no view.
 */
export type CommandReply = { readonly status: 200 | 201; readonly view: string } | { readonly status: 202; readonly view: null };

/** The success reply of every served command: status and the view its COMPLETED envelope carries (none for ACCEPTED). */
export const COMMAND_RESPONSES: Readonly<Record<ServedCommandId, CommandReply>> = Object.freeze({
  CMD001: { status: 201, view: "CreateAgencyView" },
  CMD009: { status: 201, view: "EndClientView" },
  CMD010: { status: 200, view: "ArchiveClientView" },
  CMD011: { status: 201, view: "ProjectView" },
  CMD023: { status: 201, view: "RevisePlanView" },
  CMD025: { status: 201, view: "ApprovePlanView" },
  CMD026: { status: 200, view: "WithdrawApprovalView" },
  ...SOURCE_COMMAND_RESPONSES,
  CMD044: { status: 201, view: "SupportCaseView" },
  ...EXECUTION_COMMAND_RESPONSES,
  ...AUDIT_COMMAND_RESPONSES,
});

export const SERVED_COMMAND_IDS = Object.freeze(Object.keys(COMMAND_RESPONSES) as ServedCommandId[]);

/** The COMPLETED envelope of a served command (an ACCEPTED command validates with ACCEPTED_RESPONSE_SCHEMA_ID instead). */
export function commandResponseSchemaId(command: ServedCommandId): CommandResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}${command}`;
}

export const ACCEPTED_RESPONSE_SCHEMA_ID: AcceptedResponseSchemaId = `${RESPONSE_SCHEMA_PREFIX}accepted`;

/** The reply of every served read (N16; the source lifecycle's reads, B07): 200 and the view it carries. */
export const READ_RESPONSES: Readonly<Record<ReadOperationId, { readonly view: string }>> = Object.freeze({
  ListAgencies: { view: "AgencyPage" },
  GetAgency: { view: "AgencyView" },
  ListMembers: { view: "TeamPage" },
  ListClients: { view: "ClientPage" },
  GetProject: { view: "ProjectView" },
  GetSelectionManifest: { view: SOURCE_ROUTES.GetSelectionManifest.view },
  GetRevision: { view: SOURCE_ROUTES.GetRevision.view },
  GetInspection: { view: SOURCE_ROUTES.GetInspection.view },
  ListUploads: { view: SOURCE_ROUTES.ListUploads.view },
  GetUpload: { view: SOURCE_ROUTES.GetUpload.view },
  GetUploadSession: { view: SOURCE_ROUTES.GetUploadSession.view },
  PreviewTable: { view: SOURCE_ROUTES.PreviewTable.view },
  ListSupportCases: { view: "SupportCasePage" },
  GetSupportCase: { view: "SupportCaseView" },
  GetJob: { view: EXECUTION_ROUTES.GetJob.view },
  GetAudit: { view: AUDIT_ROUTES.GetAudit.view },
});

export const READ_OPERATION_IDS = Object.freeze(Object.keys(READ_RESPONSES) as ReadOperationId[]);

export function readResponseSchemaId(operationId: ReadOperationId): ReadResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}read:${operationId}`;
}

/** The reply of every served document intake (B07 D-SEL-2, B08 D8-PLAN-1): 201 when stored, 200 when the same document was already stored. */
export const INTAKE_RESPONSES: Readonly<Record<IntakeOperationId, { readonly view: string }>> = Object.freeze({
  SubmitSelectionManifest: { view: SOURCE_ROUTES.SubmitSelectionManifest.view },
  SubmitDecisionArtifact: { view: "DecisionArtifactIntakeView" },
});

export const INTAKE_OPERATION_IDS = Object.freeze(Object.keys(INTAKE_RESPONSES) as IntakeOperationId[]);

export function intakeResponseSchemaId(operationId: IntakeOperationId): IntakeResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}intake:${operationId}`;
}

function intakeEnvelope(operationId: IntakeOperationId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: intakeResponseSchemaId(operationId),
    title: `${operationId} STORED`,
    description:
      "A document intake (B07 D-SEL-2, B08 D8-PLAN-1): the stored document's identity; created false (200) when the same body was already stored for this revision or audit (content-idempotent, no journal entry, no aggregate version), created true (201) when this request stored it.",
    type: "object",
    additionalProperties: false,
    required: ["kind", "data"],
    properties: {
      kind: { type: "string", const: "STORED" },
      data: ref(INTAKE_RESPONSES[operationId].view),
    },
  };
}

function readEnvelope(operationId: ReadOperationId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: readResponseSchemaId(operationId),
    title: `${operationId} READ`,
    description: "A read: the safe projection the caller may see, with the version of every resource that edits compare (10 \"Read endpoints return safe projections\", \"Resource reads return a version or ETag where edits are supported\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "data"],
    properties: {
      kind: { type: "string", const: "READ" },
      data: ref(READ_RESPONSES[operationId].view),
    },
  };
}

function completedEnvelope(command: ServedCommandId): JsonSchema {
  const reply = COMMAND_RESPONSES[command];
  if (reply.view === null) throw new TypeError(`${command} answers the ACCEPTED envelope, not a COMPLETED one`);
  return {
    $schema: DIALECT,
    $id: commandResponseSchemaId(command),
    title: `${command} COMPLETED`,
    description: "Synchronous success: the validated DTO and the version of the aggregate the command edited or created (10 \"Responses and safe errors\"); replayed is true when an idempotent replay returned the journaled result (10 \"Idempotency contract\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "version", "replayed", "data"],
    properties: {
      kind: { type: "string", const: "COMPLETED" },
      version: VERSION,
      replayed: { type: "boolean" },
      data: ref(reply.view),
    },
  };
}

/** Long work (10: "Long work returns 202 with operationId, current state, status URL and allowed polling guidance"). */
export const ACCEPTED_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  $schema: DIALECT,
  $id: ACCEPTED_RESPONSE_SCHEMA_ID,
  title: "ACCEPTED",
  description:
    "Accepted long work: the durable operation reference, its current state, the status path and the polling guidance. CompleteUpload (CMD014) answers it: the completion is a claim, verified asynchronously by the control plane (B07 D-RUN-1); none of the B06 commands does.",
  type: "object",
  additionalProperties: false,
  required: ["kind", "operationId", "state", "statusPath", "pollAfterSeconds"],
  properties: {
    kind: { type: "string", const: "ACCEPTED" },
    operationId: ID,
    state: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" },
    statusPath: { type: "string", pattern: "^/api/v1/[^\\s]*$", maxLength: 512 },
    pollAfterSeconds: { type: "integer", minimum: 1, maximum: 86400 },
  },
});

// --- operational routes (non-registry) ---------------------------------------------------------------------------------------

/** One declared reply of an operational route. */
export interface OperationalResponse {
  readonly description: string;
  /** The media type of the reply's body, or null for a reply without one (204). */
  readonly contentType: string | null;
  /**
   * A closed JSON Schema literal in the vocabulary of api/json-schema; compiled once at start-up, never from a runtime value.
   * Null exactly when the reply has no body.
   */
  readonly schema: JsonSchema | null;
}

/** The body an operational route admits (B11 W2: the identity token of a sign-in or a step-up). */
export interface OperationalRequest {
  readonly contentType: "application/json";
  /** A closed JSON Schema literal, compiled under `urn:kauro:api:v1:request:op:<operationId>`. */
  readonly schema: JsonSchema;
}

/**
 * A route the api serves that is not a registry command (for example liveness and readiness, 14 "Monitoring and service
 * health"). It is documented, registered and validated exactly like a command route: the OpenAPI generator documents it, the
 * checker matches it against the registered routes, the validator compiles each declared reply under
 * `urn:kauro:api:v1:response:op:<operationId>:<status>`, and the route registers `config.responses =
 * operationalRouteResponses(operationId)` so the send guard validates its replies.
 */
export interface OperationalRoute {
  readonly operationId: string;
  readonly method: "GET" | "POST";
  /** OpenAPI path template (e.g. `/livez`). */
  readonly path: string;
  readonly summary: string;
  /** The manual section that requires the route. */
  readonly authority: string;
  /** Declared replies by HTTP status; a status >= 400 that is not declared answers a Problem. */
  readonly responses: Readonly<Record<string, OperationalResponse>>;
  /** The body the route admits, when it takes one (strict JSON, closed schema, admitted like a command's body). */
  readonly request?: OperationalRequest;
}

/** The reply of GET /livez: the process is live; nothing else is checked (14 "Monitoring and service health"). */
export const LIVENESS_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["LIVE"] } },
});

/**
 * The reply of GET /readyz, READY (200) and NOT_READY (503) alike: the process state, whether the database could be read, the
 * schema compatibility of its migration ledger with the migrations this build ships, and both schema versions. It names
 * states, never an error text, a host or a role (14 "Monitoring and service health": a database outage is visible without
 * exposing credentials).
 */
export const READINESS_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "checks", "schemaVersion"],
  properties: {
    status: { type: "string", enum: ["READY", "NOT_READY"] },
    checks: {
      type: "object",
      additionalProperties: false,
      required: ["process", "database", "schema"],
      properties: {
        process: { type: "string", enum: ["SERVING", "DRAINING"] },
        database: { type: "string", enum: ["AVAILABLE", "UNAVAILABLE", "NOT_CHECKED"] },
        schema: { type: "string", enum: ["COMPATIBLE", "BEHIND", "DRIFTED", "NOT_CHECKED"] },
      },
    },
    schemaVersion: {
      type: "object",
      additionalProperties: false,
      required: ["code", "database"],
      properties: {
        code: { type: "integer", minimum: 0 },
        database: { type: ["integer", "null"], minimum: 0 },
      },
    },
  },
});

const JSON_CONTENT_TYPE = "application/json";

// --- the browser session boundary (B11 design D-AUTH-1..5) -------------------------------------------------------------------

/** An identity provider's ID token as the browser hands it over: visible ASCII, bounded (the verifier bounds it further). */
const ID_TOKEN = Object.freeze({ type: "string", minLength: 1, maxLength: 16_384, pattern: "^[\\u0021-\\u007e]+$" });
/** A nullable UTC instant. */
const UTC_OR_NULL = Object.freeze({ type: ["string", "null"], format: "date-time", pattern: "Z$" });

/** The body of POST /api/v1/sessions and POST /api/v1/assurance/step-ups: the one ID token, nothing else. */
export const IDENTITY_TOKEN_REQUEST_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["idToken"],
  properties: { idToken: ID_TOKEN },
});

/**
 * SessionView (D-AUTH-4): the person and the session, and the CSRF token the page sends on unsafe requests. No provider token,
 * subject, e-mail address or secret: the cookie carries the secret and the page never reads it.
 */
export const SESSION_VIEW_SCHEMA: JsonSchema = Object.freeze({
  title: "SessionView",
  description: "The signed-in person and the session: verification facts as flags, the deadlines of the session, the freshness of its latest step-up and its CSRF token (B11 design D-AUTH-4).",
  type: "object",
  additionalProperties: false,
  required: ["userId", "emailVerified", "mfaEnrolled", "mfaAt", "stepUpFreshUntil", "idleExpiresAt", "absoluteExpiresAt", "csrfToken"],
  properties: {
    userId: ID,
    emailVerified: { type: "boolean" },
    mfaEnrolled: { type: "boolean" },
    mfaAt: UTC_OR_NULL,
    stepUpFreshUntil: UTC_OR_NULL,
    idleExpiresAt: UTC,
    absoluteExpiresAt: UTC,
    csrfToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  },
});

/** The reply of a step-up: the B06 STEP_UP proof CMD025 cites as assuranceProofRef, and when it stops being fresh. */
export const STEP_UP_PROOF_SCHEMA: JsonSchema = Object.freeze({
  title: "StepUpProofView",
  type: "object",
  additionalProperties: false,
  required: ["proofId", "expiresAt"],
  properties: { proofId: ID, expiresAt: UTC },
});

/** Which IdentityClient adapter the page loads (D-AUTH-2); the contract fake is announced in LOCAL only. */
export const IDENTITY_CONFIG_SCHEMA: JsonSchema = Object.freeze({
  title: "IdentityConfigView",
  type: "object",
  additionalProperties: false,
  required: ["adapter", "projectId"],
  properties: {
    adapter: { type: "string", enum: ["IDENTITY_PLATFORM", "CONTRACT_FAKE"] },
    projectId: { type: "string", pattern: "^[a-z][a-z0-9-]{4,28}[a-z0-9]$" },
    // the contract fake's address: a path of the application's own origin the edge routes to the fake (D-SEC-1 connect-src 'self')
    endpoint: { type: "string", pattern: "^(/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$", maxLength: 200 },
  },
});

/** The operation ids of the session boundary's routes. */
export const SESSION_OPERATION_IDS = Object.freeze({
  open: "openSession",
  current: "getCurrentSession",
  revoke: "revokeCurrentSession",
  stepUp: "createStepUp",
  identityConfig: "getIdentityConfig",
} as const);

const SESSION_AUTHORITY = '08 "Authentication and assurance"; B11 design D-AUTH-1..5';

/**
 * The routes of the browser session boundary (B11 W2): auxiliary routes, not catalogue commands, served in the OpenAPI
 * document with closed replies and closed outcome catalogues (api/outcomes OPERATIONAL_OUTCOMES). apps/api registers them when
 * the session boundary is bound (apps/api/src/sessions.ts).
 */
export const SESSION_ROUTES: ReadonlyArray<OperationalRoute> = Object.freeze([
  Object.freeze({
    operationId: SESSION_OPERATION_IDS.open,
    method: "POST",
    path: "/api/v1/sessions",
    summary: "Exchange a verified identity token for a browser session (Set-Cookie __Host-kauro_session)",
    authority: SESSION_AUTHORITY,
    request: Object.freeze({ contentType: JSON_CONTENT_TYPE, schema: IDENTITY_TOKEN_REQUEST_SCHEMA }),
    responses: Object.freeze({
      "201": Object.freeze({ description: "The session is open; the cookie carries its secret (Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age = the absolute lifetime).", contentType: JSON_CONTENT_TYPE, schema: SESSION_VIEW_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: SESSION_OPERATION_IDS.current,
    method: "GET",
    path: "/api/v1/sessions/current",
    summary: "The session the cookie names, while it is live",
    authority: SESSION_AUTHORITY,
    responses: Object.freeze({
      "200": Object.freeze({ description: "The live session; last-seen moves at most once a minute.", contentType: JSON_CONTENT_TYPE, schema: SESSION_VIEW_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: SESSION_OPERATION_IDS.revoke,
    method: "POST",
    path: "/api/v1/sessions/current/revoke",
    summary: "Logout: end the session, clear the cookie and the site's cache, cookies and storage (idempotent)",
    authority: `${SESSION_AUTHORITY}; 08 "Browser, API and cache isolation"`,
    responses: Object.freeze({
      "204": Object.freeze({ description: "Ended (or already ended): Set-Cookie clears the session cookie and Clear-Site-Data names cache, cookies and storage.", contentType: null, schema: null }),
    }),
  }),
  Object.freeze({
    operationId: SESSION_OPERATION_IDS.stepUp,
    method: "POST",
    path: "/api/v1/assurance/step-ups",
    summary: "Record a recent second-factor re-authentication of the caller as a STEP_UP proof",
    authority: `${SESSION_AUTHORITY}; B06 D-ASSUR-1, D-EVID-1`,
    request: Object.freeze({ contentType: JSON_CONTENT_TYPE, schema: IDENTITY_TOKEN_REQUEST_SCHEMA }),
    responses: Object.freeze({
      "201": Object.freeze({ description: "The proof, cited by CMD025 (and later CMD005, CMD007, CMD043) as assuranceProofRef until expiresAt.", contentType: JSON_CONTENT_TYPE, schema: STEP_UP_PROOF_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: SESSION_OPERATION_IDS.identityConfig,
    method: "GET",
    path: "/api/v1/public/identity-config",
    summary: "Which identity client the application loads (public, no credential)",
    authority: "B11 design D-AUTH-2",
    responses: Object.freeze({
      "200": Object.freeze({ description: "The identity client adapter and its public configuration.", contentType: JSON_CONTENT_TYPE, schema: IDENTITY_CONFIG_SCHEMA }),
    }),
  }),
] satisfies ReadonlyArray<OperationalRoute>);

// --- the public routes (B11 W5b, design section 5; D-PUB-1..D-PUB-6) ---------------------------------------------------------

/** The reply of GET /api/v1/public/capability-publication: the offered mode capabilities in a public projection (no profile hash, no evidence). */
export const CAPABILITY_PUBLICATION_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["observedAt", "capabilities"],
  properties: {
    observedAt: UTC,
    capabilities: {
      type: "array",
      maxItems: SERVICE_MODES.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["capabilityId", "mode", "version", "state", "validFrom"],
        properties: {
          capabilityId: ID,
          mode: { type: "string", enum: [...SERVICE_MODES] },
          version: LABEL,
          state: { type: "string", enum: [...OFFERED_CAPABILITY_STATES] },
          validFrom: UTC,
        },
      },
    },
  },
});

/** A single-line label of the fit form (the control-character rule of every label). */
const INQUIRY_LABEL = Object.freeze({ type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN });
/** An address of the plain shape local@domain.tld: no quoted local part, no comment, no address literal; at most 254 characters. */
export const INQUIRY_EMAIL_PATTERN = "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";
/** Free text: at least one visible character; line breaks and tabs allowed, every other control character refused. */
export const INQUIRY_TEXT_PATTERN = "^(?=[\\s\\S]*\\S)[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]+$";

/**
 * The body of POST /api/v1/public/inquiries (A3 3.7 "the fit form collects business contact details, buyer type, destination,
 * approximate record band and desired timing", 02 "Intake and project boundaries"): a closed object of strings from closed
 * vocabularies. It carries no agency, client, project, price, quote or third-party CRM name.
 */
export const INQUIRY_REQUEST_SCHEMA: JsonSchema = Object.freeze({
  description: "A fit inquiry from a visitor without an account. The buyer type never changes price or admission (A3 3.7).",
  type: "object",
  additionalProperties: false,
  required: ["buyerType", "contactName", "contactEmail", "companyName", "destination", "recordBand", "timing"],
  properties: {
    buyerType: { type: "string", enum: [...INQUIRY_BUYER_TYPES] },
    contactName: INQUIRY_LABEL,
    contactEmail: { type: "string", minLength: 3, maxLength: 254, pattern: INQUIRY_EMAIL_PATTERN },
    companyName: INQUIRY_LABEL,
    destination: { type: "string", enum: [...INQUIRY_DESTINATIONS] },
    recordBand: { type: "string", enum: [...INQUIRY_RECORD_BANDS] },
    timing: { type: "string", enum: [...INQUIRY_TIMINGS] },
    description: { type: "string", minLength: 1, maxLength: 2000, pattern: INQUIRY_TEXT_PATTERN },
  },
});

/** The reply of POST /api/v1/public/inquiries: the inquiry's identity and the instant it was first received, nothing else. */
export const INQUIRY_RECEIVED_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["inquiryId", "receivedAt"],
  properties: { inquiryId: ID, receivedAt: UTC },
});

/**
 * The operational routes of this edition: the platform's liveness and readiness probes, outside /api/v1, without a credential
 * and without a customer row (14 "Monitoring and service health": "Liveness checks process health ... Readiness checks the
 * minimum dependencies and schema compatibility needed for the service's role"; 14 "Deployment and rollback"; review finding
 * R42, decision E-OPS-4), and the routes of the browser session boundary (SESSION_ROUTES, B11 W2). apps/api/src/health.ts serves
 * the probes and apps/api/src/sessions.ts the session routes, each registered with `operationalRouteResponses(<operationId>)` as
 * its `config.responses`, so the send guard validates their replies like any command's, the validator compiles each declared
 * reply and request body, and the OpenAPI document and its checker cover them (R23).
 */
// --- the bank-transfer route's operational routes (Payments V1, lane L-ROUTE; ACH-ROUTE r12 §7.1-§7.3) ------------------------------
// The corporate owner's configuration and qualification commands (journaled under the owner's identity; COMPLETED envelope like a command)
// and the buyer's sensitive-instructions read (bare `{ instructions }`, Cache-Control: no-store, never an ETag). Documented under `paths`.
const BANK_UUID = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } as const;
const BANK_REF = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" } as const;
const BANK_HASH = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;
const BANK_VERSION = { type: "integer", minimum: 1, maximum: 2147483647 } as const;
const BANK_MS = (min: number): JsonSchema => ({ type: "integer", minimum: min, maximum: 34560000000 });
const BANK_UTC = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" } as const;
const closedObject = (required: ReadonlyArray<string>, properties: Readonly<Record<string, JsonSchema>>): JsonSchema => ({ type: "object", additionalProperties: false, required: [...required], properties });
const BANK_ROUTE_VIEW_SCHEMA: JsonSchema = closedObject(["routeId", "routeVersion", "version", "state", "rollout", "environment", "accountRef", "detailsEvidenceHash", "verified"], {
  routeId: BANK_UUID,
  routeVersion: BANK_VERSION,
  version: { type: "integer", minimum: 1 },
  state: { type: "string", enum: ["PENDING_VERIFICATION", "VERIFIED", "ENABLED", "DISABLED"] },
  rollout: { type: ["string", "null"], enum: ["CONTROLLED", "GENERAL", null] },
  environment: { type: "string", enum: ["SANDBOX", "LIVE"] },
  accountRef: BANK_REF,
  detailsEvidenceHash: BANK_HASH,
  verified: { type: "boolean" },
});
/** The COMPLETED envelope of an owner route command: `{ kind, version, replayed, data: { route } }`. */
export const BANK_ROUTE_COMMAND_RESPONSE_SCHEMA: JsonSchema = closedObject(["kind", "version", "replayed", "data"], {
  kind: { type: "string", enum: ["COMPLETED"] },
  version: { type: "integer", minimum: 1 },
  replayed: { type: "boolean" },
  data: closedObject(["route"], { route: BANK_ROUTE_VIEW_SCHEMA }),
});
export const BANK_ROUTE_READ_RESPONSE_SCHEMA: JsonSchema = closedObject(["route"], { route: BANK_ROUTE_VIEW_SCHEMA });
export const TRANSFER_INSTRUCTIONS_RESPONSE_SCHEMA: JsonSchema = closedObject(["instructions"], {
  instructions: closedObject(["beneficiaryName", "bankName", "routingNumber", "accountNumber", "accountType", "amountCents", "currency", "reference", "sendBy", "transferExpiresAt", "routeVersion"], {
    beneficiaryName: { type: "string", minLength: 1, maxLength: 200 },
    bankName: { type: "string", minLength: 1, maxLength: 200 },
    routingNumber: { type: "string", pattern: "^[0-9]{9}$" },
    accountNumber: { type: "string", pattern: "^[0-9]{4,17}$" },
    accountType: { type: "string", enum: ["CHECKING", "SAVINGS"] },
    amountCents: { type: "string", pattern: "^(0|[1-9][0-9]{0,15})$" },
    currency: { type: "string", enum: ["USD"] },
    reference: { type: "string", pattern: "^K[0-9A-HJKMNP-TV-Z]{22}$" },
    sendBy: BANK_UTC,
    transferExpiresAt: BANK_UTC,
    routeVersion: BANK_VERSION,
  }),
});
const bankCommand = (operationId: string, path: string, summary: string, status: "200" | "201", request: JsonSchema): OperationalRoute =>
  Object.freeze({
    operationId,
    method: "POST" as const,
    path,
    summary,
    authority: "ACH-ROUTE r12 §7.1 (R1, R2), §7.29; KAURO_OWNER with a fresh step-up; Idempotency-Key (journal of the owner identity)",
    request: Object.freeze({ contentType: "application/json" as const, schema: request }),
    responses: Object.freeze({ [status]: Object.freeze({ description: "The route after the command (COMPLETED envelope; an identical replay answers the journaled reply).", contentType: JSON_CONTENT_TYPE, schema: BANK_ROUTE_COMMAND_RESPONSE_SCHEMA }) }),
  });
export const BANK_ROUTE_OPERATIONAL_ROUTES: ReadonlyArray<OperationalRoute> = Object.freeze([
  bankCommand("configureBankRoute", "/api/v1/operations/bank-routes", "Configure a bank-transfer route: the account, its owner-supplied details evidence and the instruction policy (PENDING_VERIFICATION)", "201",
    closedObject(["provider", "environment", "accountRef", "currency", "acceptedRails", "detailsArtifactRef", "detailsEvidenceHash", "minimumTransferWindowMs", "instructionLifetimeMs", "providerTimeToleranceMs", "feePolicyVersion", "timingSource"], {
      provider: { type: "string", pattern: "^[a-z][a-z0-9_-]{1,63}$" },
      environment: { type: "string", enum: ["SANDBOX", "LIVE"] },
      accountRef: BANK_REF,
      currency: { type: "string", enum: ["USD"] },
      acceptedRails: { type: "array", minItems: 1, maxItems: 2, items: { type: "string", enum: ["ACH", "DOMESTIC_WIRE"] } },
      detailsArtifactRef: BANK_REF,
      detailsEvidenceHash: BANK_HASH,
      minimumTransferWindowMs: BANK_MS(1),
      instructionLifetimeMs: BANK_MS(1),
      providerTimeToleranceMs: BANK_MS(0),
      feePolicyVersion: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
      timingSource: closedObject(["url", "accessedOn"], { url: { type: "string", maxLength: 2048, pattern: "^https://[A-Za-z0-9.-]+(/[!-~]*)?$" }, accessedOn: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" } }),
    })),
  bankCommand("verifyBankRoute", "/api/v1/operations/bank-routes/{routeId}/verify", "Qualify a route: its current details evidence read, classified and still valid; the owner verification evidence (VERIFIED)", "200",
    closedObject(["expectedVersion", "verificationEvidenceRef", "authorizationRef"], { expectedVersion: BANK_VERSION, verificationEvidenceRef: BANK_REF, authorizationRef: BANK_UUID })),
  bankCommand("enableBankRoute", "/api/v1/operations/bank-routes/{routeId}/enable", "Enable a verified route for a CONTROLLED allowlist, or GENERAL once its enable condition holds (ENABLED)", "200",
    closedObject(["expectedVersion", "rollout", "participants", "authorizationRef"], {
      expectedVersion: BANK_VERSION,
      rollout: { type: "string", enum: ["CONTROLLED", "GENERAL"] },
      participants: { type: "array", maxItems: 1000, items: BANK_UUID },
      authorizationRef: BANK_UUID,
      qualificationOrderId: BANK_UUID,
    })),
  bankCommand("disableBankRoute", "/api/v1/operations/bank-routes/{routeId}/disable", "Disable an enabled route (VERIFIED): no new instructions, no sensitive details served", "200",
    closedObject(["expectedVersion", "authorizationRef"], { expectedVersion: BANK_VERSION, authorizationRef: BANK_UUID })),
  bankCommand("replaceBankRouteDetails", "/api/v1/operations/bank-routes/{routeId}/details", "Replace the details evidence of a route: a new version, unqualified (PENDING_VERIFICATION); issued orders keep their snapshot", "200",
    closedObject(["expectedVersion", "detailsArtifactRef", "detailsEvidenceHash", "authorizationRef"], { expectedVersion: BANK_VERSION, detailsArtifactRef: BANK_REF, detailsEvidenceHash: BANK_HASH, authorizationRef: BANK_UUID })),
  Object.freeze({
    operationId: "getBankRoute",
    method: "GET" as const,
    path: "/api/v1/operations/bank-routes/{routeId}",
    summary: "A bank-transfer route as the corporate owner sees it",
    authority: "ACH-ROUTE r12 §7.1; KAURO_OWNER",
    responses: Object.freeze({ "200": Object.freeze({ description: "The route.", contentType: JSON_CONTENT_TYPE, schema: BANK_ROUTE_READ_RESPONSE_SCHEMA }) }),
  }),
  Object.freeze({
    operationId: "getTransferInstructions",
    method: "GET" as const,
    path: "/api/v1/payment-orders/{orderId}/transfer-instructions",
    summary: "The bank-transfer instructions of an order, served only while its route is enabled at the snapshot version and before its deadline",
    authority: "ACH-ROUTE r12 §7.3 (I3), D-ACH-16; an agency member (X-Kauro-Agency); never cached",
    responses: Object.freeze({ "200": Object.freeze({ description: "The account details of the route version the order was issued on, with the exact amount, reference and send-by instant of the order.", contentType: JSON_CONTENT_TYPE, schema: TRANSFER_INSTRUCTIONS_RESPONSE_SCHEMA }) }),
  }),
] satisfies ReadonlyArray<OperationalRoute>);

// --- the inbound side of the bank-transfer route (Payments V1, lane PV1-INBOUND; ACH-ROUTE r12 §7.5-§7.12, §7.23) ------------------------------
const BANK_CENTS = { type: "string", pattern: "^(0|[1-9][0-9]{0,15})$" } as const;
const BANK_CREDIT_VIEW_SCHEMA: JsonSchema = closedObject(["creditId", "accountRef", "bankTransactionId", "state", "version", "source", "rail", "grossCents", "feeCents", "currency", "reference", "orderId", "captureId"], {
  creditId: BANK_UUID,
  accountRef: BANK_REF,
  bankTransactionId: { type: "string", minLength: 1, maxLength: 128 },
  state: { type: "string", enum: ["DRAFT_MANUAL", "OBSERVED", "MATCH_REVIEW", "MATCHED", "APPLIED", "RETURN_REVIEW"] },
  version: { type: "integer", minimum: 1 },
  source: { type: "string", enum: ["OWNER_MANUAL"] },
  rail: { type: "string", enum: ["ACH", "DOMESTIC_WIRE", "OTHER", "UNKNOWN"] },
  grossCents: BANK_CENTS,
  feeCents: { type: ["string", "null"], pattern: "^(0|[1-9][0-9]{0,15})$" },
  currency: { type: "string", enum: ["USD"] },
  reference: { type: ["string", "null"], minLength: 1, maxLength: 256 },
  orderId: { type: ["string", "null"], pattern: BANK_UUID.pattern },
  captureId: { type: ["string", "null"], pattern: BANK_UUID.pattern },
});
export const BANK_CREDIT_COMMAND_RESPONSE_SCHEMA: JsonSchema = closedObject(["kind", "version", "replayed", "data"], {
  kind: { type: "string", enum: ["COMPLETED"] },
  version: { type: "integer", minimum: 1 },
  replayed: { type: "boolean" },
  data: closedObject(["credit"], { credit: BANK_CREDIT_VIEW_SCHEMA }),
});
export const BANK_CREDIT_READ_RESPONSE_SCHEMA: JsonSchema = closedObject(["data"], { data: closedObject(["credit"], { credit: BANK_CREDIT_VIEW_SCHEMA }) });
export const BANK_MATCH_KEYS_RESPONSE_SCHEMA: JsonSchema = closedObject(["data"], { data: closedObject(["keys"], { keys: closedObject(["orderId", "reference", "expectedAmountCents", "currency", "acceptedPayerDigest", "transferExpiresAt", "providerTimeToleranceMs", "accountRef"], {
    orderId: BANK_UUID,
    reference: { type: "string", minLength: 1, maxLength: 256 },
    expectedAmountCents: BANK_CENTS,
    currency: { type: "string", enum: ["USD"] },
    acceptedPayerDigest: { type: ["string", "null"], pattern: BANK_HASH.pattern },
    transferExpiresAt: BANK_UTC,
    providerTimeToleranceMs: { type: "integer", minimum: 0 },
    accountRef: BANK_REF,
  }) }) });
const creditCommand = (operationId: string, path: string, summary: string, status: "200" | "201", request: JsonSchema): OperationalRoute =>
  Object.freeze({
    operationId,
    method: "POST" as const,
    path,
    summary,
    authority: "ACH-ROUTE r12 §7.5-§7.9; KAURO_OWNER with a fresh step-up; Idempotency-Key (journal of the owner identity)",
    request: Object.freeze({ contentType: "application/json" as const, schema: request }),
    responses: Object.freeze({ [status]: Object.freeze({ description: "The credit after the command (COMPLETED envelope; an identical replay answers the journaled reply).", contentType: JSON_CONTENT_TYPE, schema: BANK_CREDIT_COMMAND_RESPONSE_SCHEMA }) }),
  });
export const RETIRED_CHECKOUT_RESPONSE_SCHEMA: JsonSchema = closedObject(["kind", "version", "replayed", "data"], {
  kind: { type: "string", enum: ["COMPLETED"] },
  version: { type: "integer", minimum: 1 },
  replayed: { type: "boolean" },
  data: closedObject(["order"], { order: closedObject(["orderId", "bankState", "expiryCause", "version"], { orderId: BANK_UUID, bankState: { type: "string", enum: ["EXPIRED"] }, expiryCause: { type: "string", enum: ["RETIRED"] }, version: { type: "integer", minimum: 1 } }) }),
});
const STATEMENT_COUNT = { type: "integer", minimum: 0 } as const;
export const STATEMENT_IMPORT_RESPONSE_SCHEMA: JsonSchema = closedObject(["kind", "version", "replayed", "data"], {
  kind: { type: "string", enum: ["COMPLETED"] },
  version: { type: "integer", minimum: 1 },
  replayed: { type: "boolean" },
  data: closedObject(["import"], {
    import: closedObject(["importId", "coverage", "lines", "newLines", "orphans", "balanced"], {
      importId: BANK_UUID,
      coverage: { type: "array", minItems: 2, maxItems: 2, items: closedObject(["stream", "from", "to"], { stream: { type: "string", enum: ["INBOUND", "OUTBOUND"] }, from: BANK_UTC, to: BANK_UTC }) },
      lines: STATEMENT_COUNT,
      newLines: STATEMENT_COUNT,
      orphans: STATEMENT_COUNT,
      balanced: { type: "boolean" },
    }),
  }),
});
export const BANK_INBOUND_OPERATIONAL_ROUTES: ReadonlyArray<OperationalRoute> = Object.freeze([
  Object.freeze({
    operationId: "retireBankCheckout",
    method: "POST" as const,
    path: "/api/v1/payment-orders/{orderId}/retirements",
    summary: "Retire an open bank checkout (EXPIRED, cause RETIRED): no further instructions; a later credit is recorded and returned",
    authority: "ACH-ROUTE r12 §7.12 (E1 retirement), D-ACH-05; the agency's billing member (X-Kauro-Agency); Idempotency-Key (the agency's journal)",
    request: Object.freeze({ contentType: "application/json" as const, schema: closedObject(["reasonCode"], { reasonCode: { type: "string", minLength: 1, maxLength: 200 } }) }),
    responses: Object.freeze({ "200": Object.freeze({ description: "The bank order after the retirement (COMPLETED envelope; an identical replay answers the journaled reply).", contentType: JSON_CONTENT_TYPE, schema: RETIRED_CHECKOUT_RESPONSE_SCHEMA }) }),
  }),
  creditCommand("enterBankCredit", "/api/v1/operations/bank-accounts/{accountRef}/credits", "Enter a manual bank credit the owner read in the bank's own artifact (DRAFT_MANUAL: grants nothing until confirmed)", "201",
    closedObject(["bankTransactionId", "rail", "grossCents", "currency", "reference", "bookedAt", "evidence", "authorizationRef"], {
      bankTransactionId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
      rail: { type: "string", enum: ["ACH", "DOMESTIC_WIRE", "OTHER", "UNKNOWN"] },
      grossCents: { type: "string", pattern: "^[1-9][0-9]{0,15}$" },
      currency: { type: "string", enum: ["USD"] },
      reference: { type: ["string", "null"], minLength: 1, maxLength: 256 },
      bookedAt: BANK_UTC,
      evidence: closedObject(["artifactRef", "evidenceHash"], { artifactRef: BANK_REF, evidenceHash: BANK_HASH }),
      authorizationRef: BANK_UUID,
    })),
  creditCommand("confirmBankCredit", "/api/v1/operations/bank-credits/{creditId}/confirmations", "Confirm a manual credit: its stored artifact read, verified and compared with the draft (OBSERVED)", "200",
    closedObject(["expectedVersion", "authorizationRef"], { expectedVersion: BANK_VERSION, authorizationRef: BANK_UUID })),
  creditCommand("attributeBankCredit", "/api/v1/operations/bank-credits/{creditId}/attributions", "Attribute a credit waiting for review to an order with billing evidence (MATCHED; V1: the order's own payer only)", "200",
    closedObject(["expectedVersion", "orderId", "billingEvidenceRef", "reasonCode", "authorizationRef"], {
      expectedVersion: BANK_VERSION,
      orderId: BANK_UUID,
      billingEvidenceRef: BANK_REF,
      reasonCode: { type: "string", minLength: 1, maxLength: 200 },
      authorizationRef: BANK_UUID,
    })),
  Object.freeze({
    operationId: "importBankStatement",
    method: "POST" as const,
    path: "/api/v1/operations/bank-accounts/{accountRef}/statement-imports",
    summary: "Import a statement the owner stored: its coverage per stream, its lines once by bank line id, debit links and orphan exceptions",
    authority: "ACH-ROUTE r12 §7.23 (SI1, SI2), §7.28; KAURO_OWNER with a fresh step-up; Idempotency-Key (journal of the owner identity)",
    request: Object.freeze({ contentType: "application/json" as const, schema: closedObject(["artifactRef", "evidenceHash", "authorizationRef"], { artifactRef: BANK_REF, evidenceHash: BANK_HASH, authorizationRef: BANK_UUID }) }),
    responses: Object.freeze({ "201": Object.freeze({ description: "The import (COMPLETED envelope; an identical replay answers the journaled reply). BALANCED only with zero orphan debits.", contentType: JSON_CONTENT_TYPE, schema: STATEMENT_IMPORT_RESPONSE_SCHEMA }) }),
  }),
  Object.freeze({
    operationId: "getBankCredit",
    method: "GET" as const,
    path: "/api/v1/operations/bank-credits/{creditId}",
    summary: "A bank credit as the corporate owner sees it",
    authority: "ACH-ROUTE r12 §7.5; KAURO_OWNER",
    responses: Object.freeze({ "200": Object.freeze({ description: "The credit.", contentType: JSON_CONTENT_TYPE, schema: BANK_CREDIT_READ_RESPONSE_SCHEMA }) }),
  }),
  Object.freeze({
    operationId: "getBankOrderMatchKeys",
    method: "GET" as const,
    path: "/api/v1/operations/bank-orders/{orderId}/match-keys",
    summary: "The keys the matching compares a credit with: the order's frozen reference, amount, accepted payer and deadline",
    authority: "ACH-ROUTE r12 §7.9; KAURO_OWNER",
    responses: Object.freeze({ "200": Object.freeze({ description: "The match keys.", contentType: JSON_CONTENT_TYPE, schema: BANK_MATCH_KEYS_RESPONSE_SCHEMA }) }),
  }),
] satisfies ReadonlyArray<OperationalRoute>);

export const OPERATIONAL_ROUTES: ReadonlyArray<OperationalRoute> = Object.freeze([
  Object.freeze({
    operationId: "getLiveness",
    method: "GET",
    path: "/livez",
    summary: "Liveness of the api process",
    authority: '14 "Monitoring and service health"',
    responses: Object.freeze({
      "200": Object.freeze({ description: "The process is live; nothing else is checked.", contentType: JSON_CONTENT_TYPE, schema: LIVENESS_RESPONSE_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: "getReadiness",
    method: "GET",
    path: "/readyz",
    summary: "Readiness: a verified database connection and a schema compatible with this build",
    authority: '14 "Monitoring and service health"; 14 "Deployment and rollback"',
    responses: Object.freeze({
      "200": Object.freeze({ description: "Ready: the database is reachable and records every migration this build ships, unchanged.", contentType: JSON_CONTENT_TYPE, schema: READINESS_RESPONSE_SCHEMA }),
      "503": Object.freeze({ description: "Not ready: the process is draining, the database is unreachable, or its schema is behind or drifted.", contentType: JSON_CONTENT_TYPE, schema: READINESS_RESPONSE_SCHEMA }),
    }),
  }),
  ...SESSION_ROUTES,
  Object.freeze({
    operationId: "getCapabilityPublication",
    method: "GET",
    path: "/api/v1/public/capability-publication",
    summary: "The service modes that admit real customers, without authentication",
    authority: '02 "Capability publication contract"; B11 D-PUB-1',
    responses: Object.freeze({
      "200": Object.freeze({ description: "The MODE capabilities in an offered state (AVAILABLE_LIMITED or AVAILABLE), ordered by mode, and the instant they were read. Never cached; never a DESIGN, qualified, suspended or non-mode capability.", contentType: JSON_CONTENT_TYPE, schema: CAPABILITY_PUBLICATION_RESPONSE_SCHEMA }),
    }),
  }),
  Object.freeze({
    operationId: "createInquiry",
    method: "POST",
    path: "/api/v1/public/inquiries",
    summary: "Submit a fit inquiry; the request's Origin must be exactly the public or the application origin",
    authority: '02 "Intake and project boundaries"; A3 3.7; B11 D-PUB-2..D-PUB-6',
    request: Object.freeze({ contentType: JSON_CONTENT_TYPE, schema: INQUIRY_REQUEST_SCHEMA }),
    responses: Object.freeze({
      "201": Object.freeze({ description: "The inquiry was received, or it repeats one received within the last 24 hours and answers the same identity and instant.", contentType: JSON_CONTENT_TYPE, schema: INQUIRY_RECEIVED_RESPONSE_SCHEMA }),
    }),
  }),
  ...BANK_ROUTE_OPERATIONAL_ROUTES,
  ...BANK_INBOUND_OPERATIONAL_ROUTES,
] satisfies ReadonlyArray<OperationalRoute>);

export function operationalResponseSchemaId(operationId: string, status: string): OperationalResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}op:${operationId}:${status}`;
}

/** The request schema id of an operational route that takes a body. */
export function operationalRequestSchemaId(operationId: string): OperationalRequestSchemaId {
  return `${OPERATIONAL_REQUEST_SCHEMA_PREFIX}${operationId}`;
}

export const OPERATIONAL_REQUEST_SCHEMA_PREFIX = "urn:kauro:api:v1:request:op:";
export type OperationalRequestSchemaId = `${typeof OPERATIONAL_REQUEST_SCHEMA_PREFIX}${string}`;

/** The request schemas of the operational routes that take a body, by schema id (compiled by the closed validator). */
export function operationalRequestSchemas(routes: ReadonlyArray<OperationalRoute> = OPERATIONAL_ROUTES): Readonly<Record<OperationalRequestSchemaId, JsonSchema>> {
  const out: Record<OperationalRequestSchemaId, JsonSchema> = {};
  for (const route of routes) {
    if (route.request === undefined) continue;
    const id = operationalRequestSchemaId(route.operationId);
    out[id] = { $schema: DIALECT, $id: id, title: `${route.operationId} request`, ...route.request.schema };
  }
  return out;
}


export interface ResponseSchemaSet {
  /** View definitions by name, referenced from the envelopes as `#/$defs/<name>`. */
  readonly defs: Readonly<Record<string, JsonSchema>>;
  /** Root schemas the validator compiles and the send guard validates with, by response schema id. */
  readonly roots: Readonly<Record<string, JsonSchema>>;
}

function refuse(message: string): never {
  throw new DomainFailure("INTEGRITY_FAILURE", `response schemas: ${message}`);
}

/**
 * The closed schema of one view definition, derived from the registry bundle under the view kit's rules (api/view-kit viewSchema: a
 * registry member selected or withheld with a reason, required stays required, narrowing only adds keywords). Exported so a later
 * package derives its own views with the same rules before its routes are served (package B09, docs/design/B09-payments-fiscal.md
 * §10.3).
 */
export function viewSchemaOf(bundle: RegistryBundle, view: ViewDefinition): JsonSchema {
  return viewSchema(bundle, view);
}

function operationalRoots(routes: ReadonlyArray<OperationalRoute>): Record<OperationalResponseSchemaId, JsonSchema> {
  const roots: Record<OperationalResponseSchemaId, JsonSchema> = {};
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.operationId)) refuse(`operational route ${route.operationId} is declared twice`);
    seen.add(route.operationId);
    for (const [status, response] of Object.entries(route.responses)) {
      if (!/^[1-5][0-9]{2}$/.test(status)) refuse(`operational route ${route.operationId} declares status ${status}`);
      // a reply without a body (204) declares neither a media type nor a schema; any other declares both
      if ((response.schema === null) !== (response.contentType === null)) refuse(`operational route ${route.operationId} ${status} declares a body schema without a media type, or the reverse`);
      if (response.schema === null) {
        if (status !== "204") refuse(`operational route ${route.operationId} declares ${status} without a body; only 204 has none`);
        continue;
      }
      const id = operationalResponseSchemaId(route.operationId, status);
      roots[id] = { $schema: DIALECT, $id: id, title: `${route.operationId} ${status}`, ...response.schema };
    }
  }
  return roots;
}

/**
 * Builds every response schema from the registry bundle and the declarations above; refuses (INTEGRITY_FAILURE) a view that
 * relaxes, invents or silently drops a registry member, a name that collides with a registry definition, and a schema that
 * declares a forbidden member. Deterministic: the same bundle gives the same objects.
 */
export function buildResponseSchemas(bundle: RegistryBundle, operational: ReadonlyArray<OperationalRoute> = OPERATIONAL_ROUTES): ResponseSchemaSet {
  const defs: Record<string, JsonSchema> = {};
  for (const view of VIEW_DEFINITIONS) {
    if (view.name in bundle.$defs) refuse(`view ${view.name} collides with a registry definition`);
    if (view.name in defs) refuse(`view ${view.name} is defined twice`);
    defs[view.name] = viewSchema(bundle, view);
  }
  const roots: Record<string, JsonSchema> = {};
  for (const command of SERVED_COMMAND_IDS) {
    const reply = COMMAND_RESPONSES[command];
    // an ACCEPTED command (CMD014) validates its 202 with the shared ACCEPTED envelope below
    if (reply.view === null) continue;
    if (!(reply.view in defs)) refuse(`${command} names an unknown view ${reply.view}`);
    roots[commandResponseSchemaId(command)] = completedEnvelope(command);
  }
  roots[ACCEPTED_RESPONSE_SCHEMA_ID] = ACCEPTED_RESPONSE_SCHEMA;
  for (const operationId of READ_OPERATION_IDS) {
    if (!(READ_RESPONSES[operationId].view in defs)) refuse(`${operationId} names an unknown view ${READ_RESPONSES[operationId].view}`);
    roots[readResponseSchemaId(operationId)] = readEnvelope(operationId);
  }
  for (const operationId of INTAKE_OPERATION_IDS) {
    if (!(INTAKE_RESPONSES[operationId].view in defs)) refuse(`${operationId} names an unknown view ${INTAKE_RESPONSES[operationId].view}`);
    roots[intakeResponseSchemaId(operationId)] = intakeEnvelope(operationId);
  }
  Object.assign(roots, operationalRoots(operational));
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots)]) {
    for (const member of declaredMembers(schema)) {
      if (member.name in FORBIDDEN_RESPONSE_FIELDS) refuse(`${where}${member.path} declares the forbidden member ${member.name} (${FORBIDDEN_RESPONSE_FIELDS[member.name]})`);
      // the resumable session URL is a bearer credential: one view carries it, to its requester only (B07 D-SESSION-2)
      if (member.name === SESSION_URL_MEMBER && where !== SESSION_URL_VIEW) refuse(`${where}${member.path} carries the session URL outside ${SESSION_URL_VIEW}`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${where} is not closed at ${open.join(", ")} (additionalProperties must be false)`);
  }
  return { defs, roots };
}
