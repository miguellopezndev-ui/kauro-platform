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
import type { ContractName } from "@kauro/contracts";
import { AGENCY_CAPABILITIES, DomainFailure, INQUIRY_BUYER_TYPES, INQUIRY_DESTINATIONS, INQUIRY_RECORD_BANDS, INQUIRY_TIMINGS, OFFERED_CAPABILITY_STATES, PROJECT_STATES, SERVICE_MODES } from "@kauro/domain";
import { CURSOR_PATTERN } from "./cursor.js";
import { RESOURCE_ACTIONS } from "./permitted-actions.js";
import { LABEL_PATTERN } from "./request-schemas.js";
import { READINESS_BLOCKERS } from "./views.js";

export const RESPONSE_SCHEMA_PREFIX = "urn:kauro:api:v1:response:";
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The B06 commands this edition serves, by registry id. */
export type ServedCommandId = "CMD001" | "CMD009" | "CMD010" | "CMD011" | "CMD023" | "CMD025" | "CMD026";
export type CommandResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}${ServedCommandId}`;
export type AcceptedResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}accepted`;
export type OperationalResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}op:${string}`;
/** The manual-10 reads this edition serves (re-check finding N16), by operation id. */
export type ReadOperationId = "ListAgencies" | "GetAgency" | "ListMembers" | "ListClients" | "GetProject";
export type ReadResponseSchemaId = `${typeof RESPONSE_SCHEMA_PREFIX}read:${ReadOperationId}`;
export type ResponseSchemaId = CommandResponseSchemaId | AcceptedResponseSchemaId | OperationalResponseSchemaId | ReadResponseSchemaId;

export type JsonSchema = Readonly<Record<string, unknown>>;

// --- field vocabulary (reference/FIELD_CONTRACTS.md "Common rules"; the request schemas use the same shapes) -----------------

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
/** A server identity the platform minted (UUIDv7) or derived (UUIDv5): "Application IDs are opaque server identities". */
const ID = Object.freeze({ type: "string", pattern: UUID_PATTERN });
/** A version the platform assigns: an aggregate starts at 1 and every edit adds one (design D-VER-1). */
const VERSION = Object.freeze({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** "SHA-256 is lowercase hexadecimal". */
const HASH = Object.freeze({ type: "string", pattern: "^[0-9a-f]{64}$" });
/** "UTC instants include Z"; the calendar assertion is the validator's `date-time` format (10 "Schema format execution"). */
const UTC = Object.freeze({ type: "string", format: "date-time", pattern: "Z$" });
/**
 * The registry `label` shape (FIELD_CONTRACTS: labels are untrusted text, bounded), with the control-character rule of the
 * request schemas and kauro.is_label: a label the api could not have admitted is never answered either (re-check finding N6).
 */
const LABEL = Object.freeze({ type: "string", minLength: 1, maxLength: 200, pattern: LABEL_PATTERN });
/** A non-negative exact count. */
const COUNT = Object.freeze({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

/** The shapes above, exported so a test can prove each equals the registry vocabulary it claims to be. */
export const RESPONSE_FIELD_VOCABULARY = Object.freeze({ ID, VERSION, HASH, UTC, LABEL, COUNT, UUID_PATTERN });

// --- view definitions ----------------------------------------------------------------------------------------------------

/**
 * A member taken from the registry, optionally narrowed by keywords the registry member lacks: from the view's own contract
 * (same name), or — `from` — from the named member of another contract (a reference such as a project's capability version).
 */
interface DerivedMember {
  readonly kind: "registry";
  readonly required: boolean;
  readonly narrow?: JsonSchema;
  readonly from?: readonly [ContractName, string];
}
/** A member the registry has no contract for; its schema is platform vocabulary and its rationale is recorded. */
interface PlatformMember {
  readonly kind: "platform";
  readonly required: boolean;
  readonly schema: JsonSchema;
  readonly description: string;
}
type ViewMember = DerivedMember | PlatformMember;

export interface ViewDefinition {
  readonly name: string;
  readonly description: string;
  /** The registry contract the view projects, or null when the registry has none (the members are then all platform). */
  readonly contract: ContractName | null;
  /** Registry members of `contract` the view deliberately does not select, each with the reason (FIELD_CONTRACTS). */
  readonly withheld: Readonly<Record<string, string>>;
  readonly members: Readonly<Record<string, ViewMember>>;
}

const registry = (required: boolean, narrow?: JsonSchema, from?: readonly [ContractName, string]): DerivedMember => ({
  kind: "registry",
  required,
  ...(narrow !== undefined ? { narrow } : {}),
  ...(from !== undefined ? { from } : {}),
});
const platform = (required: boolean, schema: JsonSchema, description: string): PlatformMember => ({ kind: "platform", required, schema, description });
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const NARROW_ID = Object.freeze({ pattern: UUID_PATTERN });
/** A registry label narrowed by the platform's control-character rule (the request schemas and kauro.is_label; N6). */
const NARROW_LABEL = Object.freeze({ pattern: LABEL_PATTERN });
/** The served commands a caller may issue on a resource, derived server-side (api/permitted-actions; N16). */
const RESOURCE_ACTIONS_SCHEMA = Object.freeze({ type: "array", maxItems: RESOURCE_ACTIONS.length, items: { type: "string", enum: [...RESOURCE_ACTIONS] } });
const RESOURCE_ACTIONS_DESCRIPTION =
  "The served commands the caller may issue on this resource, derived server-side from the caller's role, the resource's state and, for an approval, its control (07 \"The handoff to UI includes every state, safe field, permitted action\"); informative, never authority (re-check finding N16).";
/** An opaque list cursor (api/cursor): integrity-protected and bound to the caller, the scope, the filter and the order. */
const CURSOR = Object.freeze({ type: "string", pattern: CURSOR_PATTERN, maxLength: 600 });

/**
 * Every DTO definition of the served routes. Order is the order of the OpenAPI components. A view is closed: a member not
 * listed here can never reach the wire, whatever a record or a collaborator carries.
 */
export const VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
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
] satisfies ReadonlyArray<ViewDefinition>);

/** The success reply of every served command: status and the view its COMPLETED envelope carries. */
export const COMMAND_RESPONSES: Readonly<Record<ServedCommandId, { readonly status: 200 | 201; readonly view: string }>> = Object.freeze({
  CMD001: { status: 201, view: "CreateAgencyView" },
  CMD009: { status: 201, view: "EndClientView" },
  CMD010: { status: 200, view: "ArchiveClientView" },
  CMD011: { status: 201, view: "ProjectView" },
  CMD023: { status: 201, view: "RevisePlanView" },
  CMD025: { status: 201, view: "ApprovePlanView" },
  CMD026: { status: 200, view: "WithdrawApprovalView" },
});

export const SERVED_COMMAND_IDS = Object.freeze(Object.keys(COMMAND_RESPONSES) as ServedCommandId[]);

export function commandResponseSchemaId(command: ServedCommandId): CommandResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}${command}`;
}

export const ACCEPTED_RESPONSE_SCHEMA_ID: AcceptedResponseSchemaId = `${RESPONSE_SCHEMA_PREFIX}accepted`;

/** The reply of every served read (N16): 200 and the view it carries. */
export const READ_RESPONSES: Readonly<Record<ReadOperationId, { readonly view: string }>> = Object.freeze({
  ListAgencies: { view: "AgencyPage" },
  GetAgency: { view: "AgencyView" },
  ListMembers: { view: "TeamPage" },
  ListClients: { view: "ClientPage" },
  GetProject: { view: "ProjectView" },
});

export const READ_OPERATION_IDS = Object.freeze(Object.keys(READ_RESPONSES) as ReadOperationId[]);

export function readResponseSchemaId(operationId: ReadOperationId): ReadResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}read:${operationId}`;
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
      data: ref(COMMAND_RESPONSES[command].view),
    },
  };
}

/** Long work (10: "Long work returns 202 with operationId, current state, status URL and allowed polling guidance"). */
export const ACCEPTED_RESPONSE_SCHEMA: JsonSchema = Object.freeze({
  $schema: DIALECT,
  $id: ACCEPTED_RESPONSE_SCHEMA_ID,
  title: "ACCEPTED",
  description: "Accepted long work: the durable operation reference, its current state, the status path and the polling guidance. None of the B06 commands answers it.",
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
 * R42, decision E-OPS-4). apps/api/src/health.ts serves them and registers each with `operationalRouteResponses(<operationId>)`
 * as its `config.responses`, so the send guard validates their replies like any command's, the validator compiles each
 * declared reply, and the OpenAPI document and its checker cover them (R23).
 */
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
] satisfies ReadonlyArray<OperationalRoute>);

export function operationalResponseSchemaId(operationId: string, status: string): OperationalResponseSchemaId {
  return `${RESPONSE_SCHEMA_PREFIX}op:${operationId}:${status}`;
}

export const OPERATIONAL_REQUEST_SCHEMA_PREFIX = "urn:kauro:api:v1:request:op:";
export type OperationalRequestSchemaId = `${typeof OPERATIONAL_REQUEST_SCHEMA_PREFIX}${string}`;

/** The request schema id of an operational route that takes a body. */
export function operationalRequestSchemaId(operationId: string): OperationalRequestSchemaId {
  return `${OPERATIONAL_REQUEST_SCHEMA_PREFIX}${operationId}`;
}

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

// --- forbidden response members ----------------------------------------------------------------------------------------------

/**
 * Member names no response schema may declare, with the authority that forbids them. The schemas are closed, so a member that
 * no schema declares can never reach the wire; this list proves no schema declares one (start-up and the OpenAPI checker).
 */
export const FORBIDDEN_RESPONSE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  token: "10 \"Agency and team routes\": no authentication provider tokens",
  tokenHash: "08 \"Invitation, recovery and ownership transfer\": stored token material is protected",
  accessToken: "10 \"Agency and team routes\": no authentication provider tokens",
  refreshToken: "10 \"Agency and team routes\": no authentication provider tokens",
  idToken: "10 \"Agency and team routes\": no authentication provider tokens",
  sessionToken: "08 \"Authentication and assurance\": session tokens never leave the secure flow",
  bearerToken: "10 \"Agency and team routes\": no authentication provider tokens",
  invitationToken: "08 \"Invitation, recovery and ownership transfer\": one-use opaque tokens",
  subject: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  subjectHash: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  providerSubject: "08 \"Identity is not permission\": the provider subject stays with the authenticator",
  password: "08 \"Authentication and assurance\": passwords never leave the secure flow",
  passwordHash: "08 \"Authentication and assurance\": passwords never leave the secure flow",
  recoveryCodes: "10 \"Agency and team routes\": no recovery settings",
  recoverySettings: "10 \"Agency and team routes\": no recovery settings",
  mfaSeed: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  mfaSecret: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  totpSecret: "08 \"Authentication and assurance\": MFA seeds never leave the secure flow",
  secret: "10 \"Responses and safe errors\": no internal secrets",
  clientSecret: "10 \"Responses and safe errors\": no internal secrets",
  privateKey: "10 \"Responses and safe errors\": no internal secrets",
  apiKey: "10 \"Responses and safe errors\": no internal secrets",
  credentials: "08 \"Authentication and assurance\": provider credentials never leave the secure flow",
  assuranceProofRef: "10 \"Agency and team routes\": no private security evidence (the step-up proof)",
  emailVerifiedAt: "10 \"Agency and team routes\": no private security evidence (identity verification facts)",
  mfaEnrolledAt: "10 \"Agency and team routes\": no private security evidence (identity verification facts)",
  stack: "10 \"Responses and safe errors\": no stack traces",
  stackTrace: "10 \"Responses and safe errors\": no stack traces",
  sql: "10 \"Responses and safe errors\": no SQL",
  bucket: "10 \"Responses and safe errors\": no bucket names",
  bucketName: "10 \"Responses and safe errors\": no bucket names",
  sessionUri: "10 \"Responses and safe errors\": no session URIs",
  requestDigest: "10 \"Read endpoints return safe projections\": the idempotency journal is an internal record",
  responseBody: "10 \"Read endpoints return safe projections\": the idempotency journal is an internal record",
  createdByUserId: "10 \"Read endpoints return safe projections\": internal column",
  activeOwnerCount: "10 \"Read endpoints return safe projections\": internal column",
  legalProfileRef: "registry Agency.legalProfileRef \"Private reviewed customer billing profile\"",
});

// --- building the schemas from the registry bundle ---------------------------------------------------------------------------

/** The generated registry bundle, as @kauro/contracts/schemas.json ships it. */
export interface RegistryBundle {
  readonly $defs: Readonly<Record<string, unknown>>;
}

interface RegistryContractSchema {
  readonly properties: Readonly<Record<string, JsonSchema>>;
  readonly required?: ReadonlyArray<string>;
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

function registryContract(bundle: RegistryBundle, name: ContractName): RegistryContractSchema {
  const def = bundle.$defs[name];
  if (typeof def !== "object" || def === null || typeof (def as { properties?: unknown }).properties !== "object") refuse(`the registry bundle has no contract ${name}`);
  return def as RegistryContractSchema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every member name any object schema in `schema` declares, with its path; `$ref`s are not followed. */
export function declaredMembers(schema: unknown, at = ""): ReadonlyArray<{ readonly name: string; readonly path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const walk = (s: unknown, path: string): void => {
    if (Array.isArray(s)) {
      s.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(s)) return;
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && isPlainObject(v)) {
        for (const [name, sub] of Object.entries(v)) {
          out.push({ name, path: `${path}/properties/${name}` });
          walk(sub, `${path}/properties/${name}`);
        }
      } else if (k !== "enum" && k !== "const") {
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(schema, at);
  return out;
}

/** Paths of object schemas that are not closed (`additionalProperties: false`); a wire contract is closed (10). */
export function openObjects(schema: unknown, at = ""): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (s: unknown, path: string): void => {
    if (Array.isArray(s)) {
      s.forEach((x, i) => walk(x, `${path}/${i}`));
      return;
    }
    if (!isPlainObject(s)) return;
    const isObject = s["type"] === "object" || (Array.isArray(s["type"]) && (s["type"] as unknown[]).includes("object")) || "properties" in s;
    if (isObject && s["additionalProperties"] !== false) out.push(path || "/");
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && isPlainObject(v)) {
        for (const [name, sub] of Object.entries(v)) walk(sub, `${path}/properties/${name}`);
      } else if (k !== "enum" && k !== "const") {
        walk(v, `${path}/${k}`);
      }
    }
  };
  walk(schema, at);
  return out;
}

function viewSchema(bundle: RegistryBundle, view: ViewDefinition): JsonSchema {
  const contract = view.contract === null ? null : registryContract(bundle, view.contract);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, member] of Object.entries(view.members)) {
    if (member.kind === "registry") {
      const [sourceName, sourceMember] = member.from ?? [view.contract, name];
      if (sourceName === null) refuse(`${view.name}.${name} is derived from the registry but names no contract`);
      const source = sourceName === view.contract && contract !== null ? contract : registryContract(bundle, sourceName);
      const base = source.properties[sourceMember];
      if (base === undefined) refuse(`${view.name}.${name}: the registry contract ${sourceName} has no member ${sourceMember}`);
      if ((source.required ?? []).includes(sourceMember) && !member.required) refuse(`${view.name}.${name}: the registry requires ${sourceName}.${sourceMember}; a view cannot make it optional`);
      const narrowed: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(member.narrow ?? {})) {
        if (k in base) refuse(`${view.name}.${name}: narrowing may only add keywords the registry member lacks (${k} is already set)`);
        narrowed[k] = v;
      }
      properties[name] = narrowed;
    } else {
      if (contract !== null && name in contract.properties) refuse(`${view.name}.${name} is a registry member of ${view.contract}; it must be derived, not redeclared`);
      properties[name] = { ...member.schema, description: member.description };
    }
    if (member.required) required.push(name);
  }
  if (contract !== null) {
    for (const name of Object.keys(contract.properties)) {
      if (!(name in view.members) && !(name in view.withheld)) refuse(`${view.name}: registry member ${view.contract}.${name} is neither selected nor withheld with a reason`);
    }
    for (const name of Object.keys(view.withheld)) {
      if (!(name in contract.properties)) refuse(`${view.name}: withheld member ${name} is not a registry member of ${view.contract}`);
      if (name in view.members) refuse(`${view.name}: ${name} is both selected and withheld`);
    }
  }
  const withheld = Object.entries(view.withheld);
  return {
    title: view.name,
    description: view.description,
    ...(view.contract !== null ? { $comment: `Projection of registry contract ${view.contract}.${withheld.length > 0 ? ` Withheld: ${withheld.map(([k, why]) => `${k} (${why})`).join("; ")}` : " Every registry member is selected."}` } : {}),
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
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
    if (!(COMMAND_RESPONSES[command].view in defs)) refuse(`${command} names an unknown view ${COMMAND_RESPONSES[command].view}`);
    roots[commandResponseSchemaId(command)] = completedEnvelope(command);
  }
  roots[ACCEPTED_RESPONSE_SCHEMA_ID] = ACCEPTED_RESPONSE_SCHEMA;
  for (const operationId of READ_OPERATION_IDS) {
    if (!(READ_RESPONSES[operationId].view in defs)) refuse(`${operationId} names an unknown view ${READ_RESPONSES[operationId].view}`);
    roots[readResponseSchemaId(operationId)] = readEnvelope(operationId);
  }
  Object.assign(roots, operationalRoots(operational));
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots)]) {
    for (const member of declaredMembers(schema)) {
      if (member.name in FORBIDDEN_RESPONSE_FIELDS) refuse(`${where}${member.path} declares the forbidden member ${member.name} (${FORBIDDEN_RESPONSE_FIELDS[member.name]})`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${where} is not closed at ${open.join(", ")} (additionalProperties must be false)`);
  }
  return { defs, roots };
}
