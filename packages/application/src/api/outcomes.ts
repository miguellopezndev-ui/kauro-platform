/**
 * The closed outcome catalogue of every served route (re-check finding N13; 10 "Contract tests and compatibility": "The release
 * includes an API compatibility report, route/schema inventory, command state matrix, error catalogue ..."; 10 "Responses and
 * safe errors": frontend control flow uses the code, the reason and the typed fields; 07 "Acceptance obligations": "The handoff
 * to UI includes every state, safe field, permitted action and error").
 *
 * Every problem a route may answer is one entry: its code (whose HTTP status PROBLEM_STATUS fixes), its reason or none, the
 * field codes its `errors` may carry, and whether it carries the current safe version (`current`). The lists are derived from
 * the DomainFailure sites of the pipeline (transport, admission, authentication, the authorizer, the idempotency journal, the
 * assurance verifier), of each handler and of the adapters it reaches; a test keeps every handler's failure sites inside its
 * command's list (packages/application/test/outcome-catalogue.test.ts). The api's send guard refuses any other problem on the
 * route (checkReply: RESPONSE_CONTRACT_VIOLATION, handed to the internal-error sink), tools/openapi.mjs documents the entries
 * per status, and docs/design/B06-state-command-event-matrix.md is generated from them.
 *
 * Deliberately absent: the reasons a database refusal carries only when a handler broke the schema's discipline
 * (VERSION_DISCIPLINE, EVENT_MISSING, IMMUTABLE_COLUMN, LIVE_APPROVAL_UNBOUND, UNLISTED_TRANSITION raised by a trigger) and a
 * CHECK violation with no known field. Such an answer is a defect of the route, not one of its outcomes, so the guard replaces
 * it with RESPONSE_CONTRACT_VIOLATION and the sink receives the violation under the correlation id.
 */
import type { B06CommandId, TeamCommandId } from "../commands/contracts.js";
import { AUDIT_COMMAND_OUTCOMES, AUDIT_INTAKE_OUTCOMES, AUDIT_ROUTE_OUTCOMES, CORE_SERVICES_UNAVAILABLE } from "../audit/outcomes.js";
import { EXECUTION_COMMAND_OUTCOMES, EXECUTION_ROUTE_OUTCOMES } from "../execution/outcomes.js";
import { SOURCE_COMMAND_OUTCOMES, SOURCE_ROUTE_OUTCOMES } from "../sources/outcomes.js";
import { OUTCOME_BLOCKS, closedCatalogue, problemOutcome as outcome, type ProblemOutcome } from "./outcome-kit.js";
import type { IntakeOperationId, ReadOperationId, ServedCommandId } from "./response-schemas.js";

// the outcome kit (api/outcome-kit) is part of this module's public surface, as it was before the B07 catalogues joined
export { OUTCOME_BLOCKS, problemOutcome, closedCatalogue, outcomeOf, outcomesByStatus } from "./outcome-kit.js";
export type { ProblemOutcome, OutcomeLayer, FieldCode } from "./outcome-kit.js";

const { EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY, PAGINATED, COOKIE_CSRF } = OUTCOME_BLOCKS;

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's agency`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const BODY_DIGEST = outcome("COMMAND", "INTEGRITY_FAILURE", "BODY_DIGEST_MISMATCH", "a plan body is not the body its KAURO_PLAN_BODY_V1 hash names (N10)");
/** The text a support case would keep looks like a secret or customer records: 422, and the next action is the secure upload (B11 D-SUP-2). */
const CONTENT_REFUSED: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "CONTENT_REFUSED", "SECRET_LIKE_CONTENT", "the summary holds a private key, a cloud or API key, a token or a name-and-value credential; nothing was stored, sent or logged"),
  outcome("COMMAND", "CONTENT_REFUSED", "RECORD_LIKE_CONTENT", "the summary holds rows of records (three delimited lines) or three e-mail addresses; nothing was stored, sent or logged"),
]);
/** The step-up the authorizer needs for CMD005 and CMD007 (the same three refusals as CMD025's). */
const STEP_UP_REFUSALS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
  outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
]);
/** The role set the request names is the domain's closed set: anything else changes nothing (CMD005 failure: "a client-invented privileged role makes no change"). */
const ROLE_UNKNOWN = outcome("COMMAND", "INVALID_REQUEST", null, "the role is not one of the closed membership roles; nothing changed", { fieldCodes: ["ENUM"] });
/** The reason code of a revocation is a short token; a value that is not one changes nothing (CMD006). */
const REASON_CODE_INVALID = outcome("COMMAND", "INVALID_REQUEST", null, "the reason code is not a reason token; nothing changed", { fieldCodes: ["FORMAT", "TYPE"] });
const NOT_CONTROLLER = outcome("COMMAND", "NOT_AUTHORIZED", "NOT_APPROVAL_CONTROLLER", "only the approving actor or an OWNER ends an approval's future use (D-AUTHZ-3)");

/** The command-specific outcomes, by served command (design §8; reference/COMMAND_CATALOGUE preconditions and failures). */
/** The commands this module catalogues itself: B06's seven and B11's CMD044 (B07's come composed from sources/outcomes). */
type CatalogueCommandId = B06CommandId | "CMD044" | TeamCommandId;

const COMMAND_SPECIFIC: Readonly<Record<CatalogueCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD001: [
    outcome("COMMAND", "ADMISSION_LIMITED", "CREATION_RATE_LIMITED", "the creation limit of the identity or of the client network is reached (08 Abuse controls, R34)"),
    outcome("COMMAND", "ADMISSION_LIMITED", "DRAFT_AGENCY_EXISTS", "the identity already created an agency that is still DRAFT (D-CMD-1)"),
  ],
  CMD009: [
    NOT_VISIBLE("the agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency accepts no new client (not DRAFT or ACTIVE)", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the processing authority is recorded by another agency", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
  ],
  CMD010: [
    NOT_VISIBLE("the client"),
    STALE("client"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLIENT_ARCHIVED", "the client is already archived", { current: "ALWAYS" }),
  ],
  CMD011: [
    NOT_VISIBLE("the client or its agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "CLIENT_ARCHIVED", "the client is archived", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency accepts no new project (not DRAFT or ACTIVE)", { current: "ALWAYS" }),
    outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED", "the requested mode is not offered (AVAILABLE_LIMITED or AVAILABLE) before any quote or charge"),
    outcome("COMMAND", "INVALID_REQUEST", "TARGET_INSTANCE_REQUIRED", "a CRM mode declares its target instance", { fieldCodes: ["REQUIRED"] }),
  ],
  CMD023: [
    NOT_VISIBLE("the plan"),
    NOT_CONTROLLER,
    STALE("plan"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_SUPERSEDED", "the plan was superseded; current names its successor", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_WITHDRAWN", "the plan's approval was withdrawn", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the plan's state lists no new_plan_revision edge (VALIDATING)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "CONSEQUENCES_UNRECONCILED", "commercial or execution consequences of the approval are not reconciled (edge guard)", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE", "the patch compiles to the body the plan already has", { current: "ALWAYS" }),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the decision patch artifact is not visible to the agency", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_UNKNOWN_CANDIDATE", "the typed patch names a candidate the plan does not have", { fieldCodes: ["PATCH_UNKNOWN_CANDIDATE"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_UNKNOWN_FIELD", "the typed patch names a field the plan does not have", { fieldCodes: ["PATCH_UNKNOWN_FIELD"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_EFFECT_NOT_PERMITTED", "the typed patch asks for an effect the plan does not permit, or would move the plan's source, target or policy (N10)", { fieldCodes: ["PATCH_EFFECT_NOT_PERMITTED"] }),
    outcome("COMMAND", "INVALID_REQUEST", "PATCH_MALFORMED", "the typed patch is not a patch document", { fieldCodes: ["PATCH_MALFORMED"] }),
    BODY_DIGEST,
    CORE_SERVICES_UNAVAILABLE,
  ],
  CMD025: [
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "no step-up proof, or not a step-up proof"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the proof is not the caller's"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the step-up is older than the freshness window or expired"),
    NOT_VISIBLE("the plan"),
    STALE("plan"),
    outcome("COMMAND", "STALE_VERSION", "HASH_MISMATCH", "planHash is not the plan's body hash; current.mismatch names it", { current: "ALWAYS" }),
    outcome("COMMAND", "STALE_VERSION", "DISCLOSURES_INCOMPLETE", "disclosuresHash is not the hash of the complete server-composed disclosure set; current.mismatch names it", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_SUPERSEDED", "the plan was superseded; current names its successor", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_WITHDRAWN", "the plan's approval was withdrawn", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the plan is already APPROVED", { current: "ALWAYS" }),
    outcome("COMMAND", "PLAN_NOT_VALIDATED", null, "the plan is not VALIDATED", { current: "ALWAYS" }),
    outcome("COMMAND", "PLAN_NOT_VALIDATED", "RECEIPT_NOT_CURRENT", "the named receipt is not the plan's current receipt of exactly this body, source and target", { current: "SOMETIMES" }),
    outcome("COMMAND", "PLAN_NOT_VALIDATED", "RECEIPT_BLOCKING", "the receipt is not VALID or carries blocking issues"),
    outcome("COMMAND", "SOURCE_EXPIRED", null, "the plan's source revision of its own project is no longer SEALED (N9)"),
    outcome("COMMAND", "TARGET_STALE", null, "the plan's target contract of its own project is not confirmed and current (N4, N9)"),
    BODY_DIGEST,
  ],
  CMD026: [
    NOT_VISIBLE("the plan"),
    NOT_CONTROLLER,
    STALE("plan"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_NOT_APPROVED", "the plan is not APPROVED", { current: "ALWAYS" }),
  ],
  CMD003: [
    NOT_VISIBLE("the agency"),
    STALE("agency"),
    ROLE_UNKNOWN,
    outcome("COMMAND", "NOT_AUTHORIZED", "ROLE_NOT_GRANTABLE", "the requested role is outside the inviter's grantable subset (an ADMIN never grants OWNER)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency grants no new access (not DRAFT or ACTIVE)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "SELF_TARGET", "the inviter named its own identity"),
    outcome("COMMAND", "PRECONDITION_FAILED", "MEMBER_ALREADY_LIVE", "the identity already holds a live membership of the agency (invited, active or suspended)"),
    outcome("COMMAND", "INVALID_REQUEST", "UNKNOWN_REFERENCE", "the intended identity is not known to the platform", { fieldCodes: ["UNKNOWN_REFERENCE"] }),
  ],
  CMD004: [
    NOT_VISIBLE("the invitation (another person's invitation answers alike)"),
    STALE("membership"),
    outcome("COMMAND", "NOT_AUTHORIZED", "INVITATION_TOKEN_MISMATCH", "the presented token is not the invitation's"),
    outcome("COMMAND", "PRECONDITION_FAILED", "INVITATION_REVOKED", "the inviter revoked the invitation"),
    outcome("COMMAND", "PRECONDITION_FAILED", "INVITATION_CONSUMED", "the invitation was already consumed"),
    outcome("COMMAND", "PRECONDITION_FAILED", "INVITATION_EXPIRED", "the invitation reached its deadline on the database clock"),
    outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the membership is no longer INVITED (accepted, revoked or expired)"),
  ],
  CMD005: [
    NOT_VISIBLE("the membership"),
    STALE("membership"),
    ...STEP_UP_REFUSALS,
    ROLE_UNKNOWN,
    outcome("COMMAND", "PRECONDITION_FAILED", "MEMBERSHIP_NOT_ACTIVE", "the target is not a live accepted membership (an INVITED one is reissued instead)"),
    outcome("COMMAND", "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE", "the membership already has the requested role", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED", "the change would leave the agency without an active owner", { current: "ALWAYS" }),
  ],
  CMD006: [
    NOT_VISIBLE("the membership"),
    REASON_CODE_INVALID,
    STALE("membership"),
    outcome("COMMAND", "NOT_AUTHORIZED", "OWNER_PROTECTED", "an ADMIN never acts on an OWNER"),
    outcome("COMMAND", "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED", "the revocation would leave the agency without an active owner", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the membership is already revoked or expired"),
    outcome("COMMAND", "PRECONDITION_FAILED", "INVITATION_CONSUMED", "the invitation was consumed while the revocation ran", { current: "ALWAYS" }),
  ],
  CMD007: [
    NOT_VISIBLE("the agency or the successor's membership"),
    STALE("agency"),
    ...STEP_UP_REFUSALS,
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency is under closure authority"),
    outcome("COMMAND", "PRECONDITION_FAILED", "SELF_TARGET", "the owner named its own membership"),
    outcome("COMMAND", "PRECONDITION_FAILED", "RECIPIENT_NOT_ACTIVE", "the successor's membership is not ACTIVE"),
    outcome("COMMAND", "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE", "the successor already owns the agency"),
  ],
  CMD044: [
    NOT_VISIBLE("the project"),
    ...CONTENT_REFUSED,
    outcome("COMMAND", "CAPACITY_UNAVAILABLE", "SUPPORT_CALENDAR_UNAVAILABLE", "the versioned holiday calendar does not cover the year of the follow-up, so no next review can be promised; retry with the same key"),
  ],
});

const TENANT_COMMANDS: ReadonlySet<CatalogueCommandId> = new Set(["CMD003", "CMD005", "CMD006", "CMD007", "CMD009", "CMD010", "CMD011", "CMD023", "CMD025", "CMD026", "CMD044"]);
const HEADER_COMMANDS: ReadonlySet<CatalogueCommandId> = new Set(["CMD005", "CMD006", "CMD010", "CMD011", "CMD023", "CMD025", "CMD026", "CMD044"]);
/** Routes with an id in the path and no tenant selector at all: CMD004 (the invitation names its agency, never the request). */
const PATH_ONLY_COMMANDS: ReadonlySet<CatalogueCommandId> = new Set(["CMD004"]);

function catalogueOf(command: CatalogueCommandId): ReadonlyArray<ProblemOutcome> {
  const entries = [
    ...EVERY_ROUTE,
    ...COOKIE_CSRF,
    ...(TENANT_COMMANDS.has(command) ? [...PATH_IDS, ...TENANT] : []),
    ...(PATH_ONLY_COMMANDS.has(command) ? PATH_IDS : []),
    ...(HEADER_COMMANDS.has(command) ? AGENCY_HEADER : []),
    ...COMMAND_SPECIFIC[command],
  ];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.code}/${e.reason ?? "-"}`;
    if (seen.has(key)) throw new TypeError(`${command}: the outcome ${key} is listed twice`);
    seen.add(key);
  }
  return Object.freeze(entries);
}

/**
 * The closed problem catalogue of each served command: B06's, and the source lifecycle's (sources/outcomes, joined when mandate
 * B07-COMMANDS served its routes; design §9.5).
 */
export const COMMAND_OUTCOMES: Readonly<Record<ServedCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD001: catalogueOf("CMD001"),
  CMD003: catalogueOf("CMD003"),
  CMD004: catalogueOf("CMD004"),
  CMD005: catalogueOf("CMD005"),
  CMD006: catalogueOf("CMD006"),
  CMD007: catalogueOf("CMD007"),
  CMD009: catalogueOf("CMD009"),
  CMD010: catalogueOf("CMD010"),
  CMD011: catalogueOf("CMD011"),
  CMD023: catalogueOf("CMD023"),
  CMD025: catalogueOf("CMD025"),
  CMD026: catalogueOf("CMD026"),
  ...SOURCE_COMMAND_OUTCOMES,
  CMD044: catalogueOf("CMD044"),
  ...EXECUTION_COMMAND_OUTCOMES,
  ...AUDIT_COMMAND_OUTCOMES,
});

// --- the manual-10 reads (re-check finding N16) -----------------------------------------------------------------------------

/** The reads this module catalogues itself: B06's five manual-10 reads and B11's two support reads (W4). */
type B06ReadOperationId = "ListAgencies" | "GetAgency" | "ListMembers" | "ListClients" | "GetProject" | "ListSupportCases" | "GetSupportCase" | "GetBuyerType" | "ListProjects";

/** The dashboard's closed query (B11 lane A1): limit and cursor as every list's, and filter, one of the five R2 filters. */
const DASHBOARD_QUERY: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the query is not filter (active, awaiting_agency, delivered, failed or archived; default active), limit (1..100, default 25) and cursor, or a member was repeated or malformed", { fieldCodes: ["UNKNOWN_FIELD", "TYPE", "FORMAT", "RANGE", "ENUM"] }),
  ...PAGINATED.filter((o) => o.reason !== "SCHEMA_VIOLATION"),
]);

const READ_SPECIFIC: Readonly<Record<B06ReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  ListAgencies: [...PAGINATED],
  GetAgency: [...PATH_IDS, ...TENANT_READ, NO_QUERY],
  ListMembers: [...PATH_IDS, ...TENANT_READ, ...PAGINATED],
  ListClients: [...PATH_IDS, ...TENANT_READ, ...PAGINATED],
  GetProject: [...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the project")],
  ListSupportCases: [...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, ...PAGINATED, NOT_VISIBLE("the project")],
  GetSupportCase: [...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the case")],
  GetBuyerType: [...PATH_IDS, ...TENANT_READ, NO_QUERY],
  ListProjects: [...PATH_IDS, ...TENANT_READ, ...DASHBOARD_QUERY],
});

function readCatalogueOf(operationId: B06ReadOperationId): ReadonlyArray<ProblemOutcome> {
  const entries = [...EVERY_READ, ...READ_SPECIFIC[operationId]];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.code}/${e.reason ?? "-"}`;
    if (seen.has(key)) throw new TypeError(`${operationId}: the outcome ${key} is listed twice`);
    seen.add(key);
  }
  return Object.freeze(entries);
}

/** The closed problem catalogue of each served read: B06's manual-10 reads and the source lifecycle's (B07). */
export const READ_OUTCOMES: Readonly<Record<ReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  ListAgencies: readCatalogueOf("ListAgencies"),
  GetAgency: readCatalogueOf("GetAgency"),
  ListMembers: readCatalogueOf("ListMembers"),
  ListClients: readCatalogueOf("ListClients"),
  GetProject: readCatalogueOf("GetProject"),
  GetSelectionManifest: SOURCE_ROUTE_OUTCOMES.GetSelectionManifest,
  GetRevision: SOURCE_ROUTE_OUTCOMES.GetRevision,
  GetInspection: SOURCE_ROUTE_OUTCOMES.GetInspection,
  ListUploads: SOURCE_ROUTE_OUTCOMES.ListUploads,
  GetUpload: SOURCE_ROUTE_OUTCOMES.GetUpload,
  GetUploadSession: SOURCE_ROUTE_OUTCOMES.GetUploadSession,
  PreviewTable: SOURCE_ROUTE_OUTCOMES.PreviewTable,
  ListSupportCases: readCatalogueOf("ListSupportCases"),
  GetSupportCase: readCatalogueOf("GetSupportCase"),
  GetBuyerType: readCatalogueOf("GetBuyerType"),
  ListProjects: readCatalogueOf("ListProjects"),
  GetJob: EXECUTION_ROUTE_OUTCOMES.GetJob,
  GetAudit: AUDIT_ROUTE_OUTCOMES.GetAudit,
});

/** The closed problem catalogue of each served document intake (B07 D-SEL-2; B08 D8-PLAN-1). */
export const INTAKE_OUTCOMES: Readonly<Record<IntakeOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  SubmitSelectionManifest: SOURCE_ROUTE_OUTCOMES.SubmitSelectionManifest,
  SubmitDecisionArtifact: AUDIT_INTAKE_OUTCOMES.SubmitDecisionArtifact,
});

/**
 * The route-level fragments later packages compose their catalogues from (package B09: the payment routes; design
 * docs/design/B09-payments-fiscal.md §10.4): the outcome kit's blocks (OUTCOME_BLOCKS) — the outcomes every route answers, those
 * of a path id, of a tenant's membership, of the agency selector, and their read-side forms. A composed catalogue is still closed
 * and duplicate-free.
 */
export const ROUTE_OUTCOME_FRAGMENTS = Object.freeze({
  EVERY_ROUTE,
  PATH_IDS,
  TENANT,
  AGENCY_HEADER,
  EVERY_READ,
  TENANT_READ,
  NO_QUERY: Object.freeze([NO_QUERY]) as ReadonlyArray<ProblemOutcome>,
  COOKIE_CSRF,
});

// --- the operational routes with a closed catalogue (B11: the session boundary W2, the public routes W5b) -----------------------

const TRANSPORT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "TRANSPORT"));
const PLATFORM_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "PLATFORM"));
/** A body admitted like a command's, without an idempotency key: content type, size, strict JSON, closed schema. */
const BODY_ADMISSION: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "ADMISSION" && o.reason !== "IDEMPOTENCY_KEY_MISSING" && o.reason !== "IDEMPOTENCY_KEY_INVALID"));
const AMBIGUOUS = EVERY_ROUTE.find((o) => o.reason === "AMBIGUOUS_CREDENTIALS") as ProblemOutcome;
const ANONYMOUS = EVERY_ROUTE.find((o) => o.code === "AUTHENTICATION_REQUIRED" && o.reason === null) as ProblemOutcome;
const TOKEN_INVALID = outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", "IDENTITY_TOKEN_INVALID", "the identity token failed verification — shape, algorithm, key, signature, issuer, audience, lifetime or subject — one answer for every defect, which never says whether an account exists (D-AUTH-4)");
const NO_BODY = outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the route takes no body and no query parameter", { fieldCodes: ["UNKNOWN_FIELD"] });

/**
 * The closed problem catalogues of the operational routes that have one (the session boundary's and the public routes'; the
 * probes answer any problem the Problem schema admits). The api's send guard refuses any other problem on these routes, like a
 * command's.
 */
export const OPERATIONAL_OUTCOMES: Readonly<Record<string, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  openSession: closedCatalogue("openSession", [
    ...TRANSPORT_OUTCOMES,
    ...BODY_ADMISSION,
    AMBIGUOUS,
    outcome("AUTHENTICATION", "NOT_AUTHORIZED", "ORIGIN_REJECTED", "the sign-in's Origin is not exactly an application origin, or the browser reports a cross-site request (login CSRF)"),
    TOKEN_INVALID,
    outcome("AUTHENTICATION", "ASSURANCE_REQUIRED", "EMAIL_NOT_VERIFIED", "the token proves the account, whose e-mail is not verified yet: verify it, then sign in again"),
    ...PLATFORM_OUTCOMES,
  ]),
  getCurrentSession: closedCatalogue("getCurrentSession", [...TRANSPORT_OUTCOMES, NO_BODY, AMBIGUOUS, outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", null, "no live session: no cookie, or its session is unknown, revoked or past its idle or absolute deadline"), ...PLATFORM_OUTCOMES]),
  revokeCurrentSession: closedCatalogue("revokeCurrentSession", [...TRANSPORT_OUTCOMES, NO_BODY, AMBIGUOUS, ...COOKIE_CSRF, ...PLATFORM_OUTCOMES]),
  createStepUp: closedCatalogue("createStepUp", [
    ...TRANSPORT_OUTCOMES,
    ...BODY_ADMISSION,
    AMBIGUOUS,
    ...COOKIE_CSRF,
    ANONYMOUS,
    TOKEN_INVALID,
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_NOT_OWNED", "the re-authentication is another person's than the caller's"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_MISSING", "the re-authentication has no second factor"),
    outcome("ASSURANCE", "ASSURANCE_REQUIRED", "STEP_UP_STALE", "the re-authentication is more than 300 s old"),
    ...PLATFORM_OUTCOMES,
  ]),
  getIdentityConfig: closedCatalogue("getIdentityConfig", [...TRANSPORT_OUTCOMES, NO_BODY, ...PLATFORM_OUTCOMES]),
  // the public routes (W5b): no credential, the capability publication and the fit inquiry
  getCapabilityPublication: closedCatalogue("getCapabilityPublication", [...TRANSPORT_OUTCOMES, NO_BODY, ...PLATFORM_OUTCOMES]),
  createInquiry: closedCatalogue("createInquiry", [
    ...TRANSPORT_OUTCOMES,
    outcome("ACCESS", "NOT_AUTHORIZED", "ORIGIN_REJECTED", "the request's Origin is absent or is not exactly the public or the application origin: decided before the body is read, nothing is stored or counted (D-PUB-2)"),
    ...BODY_ADMISSION,
    outcome("COMMAND", "CONTENT_REFUSED", "SECRET_LIKE_CONTENT", "the description looks like a credential, a key or a token: nothing is stored or counted, and the next action is the secure upload (D-PUB-4)"),
    outcome("COMMAND", "CONTENT_REFUSED", "RECORD_LIKE_CONTENT", "the description looks like customer records: nothing is stored or counted, and the next action is the secure upload (D-PUB-4)"),
    outcome("COMMAND", "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED", "the client-address hash has 5 accepted inquiries in the trailing hour, or the e-mail hash has 3 in the trailing day; retryAfterSeconds says when the first leaves the window (D-PUB-3)"),
    ...PLATFORM_OUTCOMES,
  ]),
  // the agency app (B11 lane A1): CMD101 SetBuyerType, a command of the shared pipeline served as an operational route
  setBuyerType: closedCatalogue("setBuyerType", [
    ...EVERY_ROUTE,
    ...COOKIE_CSRF,
    ...PATH_IDS,
    ...TENANT,
    NOT_VISIBLE("the agency"),
    outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_OPEN", "the agency is not DRAFT or ACTIVE (closing or closed): no buyer type is recorded", { current: "ALWAYS" }),
    outcome("COMMAND", "PRECONDITION_FAILED", "BUYER_TYPE_ALREADY_SET", "the agency's buyer type is already recorded with the other value; current.state names the recorded one, which is never overwritten", { current: "ALWAYS" }),
  ]),
});

