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
import type { FailureCode, FailureReason, FieldError } from "@kauro/domain";
import { PROBLEM_STATUS } from "./problems.js";
import type { ReadOperationId, ServedCommandId } from "./response-schemas.js";

/** Where an outcome is decided (design §6.1, the admission order of manual 10). */
export type OutcomeLayer = "TRANSPORT" | "ADMISSION" | "AUTHENTICATION" | "ACCESS" | "IDEMPOTENCY" | "ASSURANCE" | "COMMAND" | "PLATFORM";

export type FieldCode = FieldError["code"];

export interface ProblemOutcome {
  readonly code: FailureCode;
  /** The reason the problem carries, or null for a problem without one. */
  readonly reason: FailureReason | null;
  /** The field codes `errors` may carry; absent when the problem never carries field errors. */
  readonly fieldCodes?: ReadonlyArray<FieldCode>;
  /** Whether the problem carries `current` (the current safe version and state): always, sometimes, or (absent) never. */
  readonly current?: "ALWAYS" | "SOMETIMES";
  readonly layer: OutcomeLayer;
  /** What the outcome means for the caller, in one line (documentation only; never sent). */
  readonly meaning: string;
}

function outcome(layer: OutcomeLayer, code: FailureCode, reason: FailureReason | null, meaning: string, extra: Pick<ProblemOutcome, "fieldCodes" | "current"> = {}): ProblemOutcome {
  return Object.freeze({ code, reason, layer, meaning, ...extra });
}

const SCHEMA_FIELD_CODES: ReadonlyArray<FieldCode> = Object.freeze(["REQUIRED", "UNKNOWN_FIELD", "TYPE", "FORMAT", "RANGE", "ENUM"]);

/** Every route: framing, admission, authentication, identity status, idempotency and the platform's own outcomes. */
const EVERY_ROUTE: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("TRANSPORT", "INVALID_REQUEST", "HEADER_REPEATED", "a single-valued envelope header was sent more than once; nothing that depends on it was decided (R41)"),
  outcome("TRANSPORT", "INVALID_REQUEST", "REQUEST_MALFORMED", "the request's framing cannot be trusted (a body shorter or longer than its Content-Length) or it ended before it was complete (R39, R40)"),
  outcome("ADMISSION", "INVALID_REQUEST", "CONTENT_TYPE_UNSUPPORTED", "the body is not application/json (UTF-8)"),
  outcome("ADMISSION", "INVALID_REQUEST", "BODY_TOO_LARGE", "the body exceeds the policy's api.jsonBytes (1 MiB)"),
  outcome("ADMISSION", "INVALID_REQUEST", "JSON_SYNTAX", "the body is not strict UTF-8 JSON"),
  outcome("ADMISSION", "INVALID_REQUEST", "JSON_DUPLICATE_KEY", "an object of the body repeats a member name"),
  outcome("ADMISSION", "INVALID_REQUEST", "JSON_DEPTH_EXCEEDED", "the body nests deeper than the parser bound"),
  outcome("ADMISSION", "INVALID_REQUEST", "JSON_STRING_TOO_LONG", "a string of the body exceeds the parser bound"),
  outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the body does not satisfy the closed request schema (R2-058, R2-059); each field error names the member and why", { fieldCodes: SCHEMA_FIELD_CODES }),
  outcome("ADMISSION", "INVALID_REQUEST", "IDEMPOTENCY_KEY_MISSING", "the Idempotency-Key header is absent"),
  outcome("ADMISSION", "INVALID_REQUEST", "IDEMPOTENCY_KEY_INVALID", "the Idempotency-Key header is not a key of the accepted shape"),
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", null, "no authenticated subject: the anonymous denial is recorded"),
  outcome("AUTHENTICATION", "AUTHENTICATION_REQUIRED", "SUBJECT_UNAUTHENTICATED", "the subject is not the identity the unit of work is bound to"),
  outcome("ACCESS", "NOT_AUTHORIZED", "IDENTITY_DISABLED", "the token's or the stored identity state is DISABLED"),
  outcome("ACCESS", "NOT_AUTHORIZED", "IDENTITY_UNVERIFIED", "the launch policy needs a verified email and enrolled MFA"),
  outcome("IDEMPOTENCY", "IDEMPOTENCY_CONFLICT", "REQUEST_DIGEST_DIFFERS", "the key was used with another request: nothing was executed again"),
  outcome("IDEMPOTENCY", "PRECONDITION_FAILED", "OPERATION_PENDING", "the first request under this key is still in flight; retry with the same key"),
  outcome("PLATFORM", "CAPACITY_UNAVAILABLE", null, "no database capacity, a serialization or lock conflict, or a draining instance; retry with the same key"),
  outcome("PLATFORM", "INTERNAL_ERROR", null, "an unexpected exception, recorded under the correlation id; retry with the same key"),
  outcome("PLATFORM", "INTEGRITY_FAILURE", null, "a stored fact the command relies on is not what its own records say; nonretryable until the subject or implementation changes"),
  outcome("PLATFORM", "INTEGRITY_FAILURE", "RESPONSE_CONTRACT_VIOLATION", "the reply its route's contract refused was not sent (R23, N13)"),
]);

/** Routes whose path carries ids. */
const PATH_IDS: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ADMISSION", "INVALID_REQUEST", "PATH_ID_INVALID", "a path parameter is not an id", { fieldCodes: ["FORMAT"] }),
]);

/** Tenant routes: the authorizer's membership decisions (design §6.1 steps 4-7). */
const TENANT: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ACCESS", "NOT_FOUND", "TENANT_CONTEXT_MISSING", "the request is not bound to the agency it selects"),
  outcome("ACCESS", "NOT_FOUND", "NOT_A_MEMBER", "no live membership of the caller in the selected agency: a foreign and a nonexistent agency answer alike"),
  outcome("ACCESS", "NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED", "the caller's membership is SUSPENDED"),
  outcome("ACCESS", "NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE", "the caller's membership is not ACTIVE (INVITED)"),
  outcome("ACCESS", "NOT_AUTHORIZED", "ROLE_INSUFFICIENT", "the caller's role does not hold the route's role"),
]);

/** Routes whose path names no agency: the X-Kauro-Agency selector (D-SCOPE-1). */
const AGENCY_HEADER: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ADMISSION", "INVALID_REQUEST", "AGENCY_SELECTOR_INVALID", "the X-Kauro-Agency selector is absent or not an id"),
]);

const NOT_VISIBLE = (what: string): ProblemOutcome => outcome("COMMAND", "NOT_FOUND", null, `${what} is not visible to the caller's agency`);
const STALE = (what: string): ProblemOutcome => outcome("COMMAND", "STALE_VERSION", null, `expectedVersion is not the ${what}'s current version; the current safe version and state come back`, { current: "ALWAYS" });
const PLAN_SERVICES = outcome("COMMAND", "INTEGRITY_FAILURE", "PLAN_SERVICES_UNAVAILABLE", "the plan services this command needs are not bound in this edition (I-INT-2)");
const BODY_DIGEST = outcome("COMMAND", "INTEGRITY_FAILURE", "BODY_DIGEST_MISMATCH", "a plan body is not the body its KAURO_PLAN_BODY_V1 hash names (N10)");
const NOT_CONTROLLER = outcome("COMMAND", "NOT_AUTHORIZED", "NOT_APPROVAL_CONTROLLER", "only the approving actor or an OWNER ends an approval's future use (D-AUTHZ-3)");

/** The command-specific outcomes, by served command (design §8; reference/COMMAND_CATALOGUE preconditions and failures). */
const COMMAND_SPECIFIC: Readonly<Record<ServedCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
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
    PLAN_SERVICES,
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
    PLAN_SERVICES,
  ],
  CMD026: [
    NOT_VISIBLE("the plan"),
    NOT_CONTROLLER,
    STALE("plan"),
    outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_NOT_APPROVED", "the plan is not APPROVED", { current: "ALWAYS" }),
  ],
});

const TENANT_COMMANDS: ReadonlySet<ServedCommandId> = new Set(["CMD009", "CMD010", "CMD011", "CMD023", "CMD025", "CMD026"]);
const HEADER_COMMANDS: ReadonlySet<ServedCommandId> = new Set(["CMD010", "CMD011", "CMD023", "CMD025", "CMD026"]);

function catalogueOf(command: ServedCommandId): ReadonlyArray<ProblemOutcome> {
  const entries = [
    ...EVERY_ROUTE,
    ...(TENANT_COMMANDS.has(command) ? [...PATH_IDS, ...TENANT] : []),
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

/** The closed problem catalogue of each served command. */
export const COMMAND_OUTCOMES: Readonly<Record<ServedCommandId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  CMD001: catalogueOf("CMD001"),
  CMD009: catalogueOf("CMD009"),
  CMD010: catalogueOf("CMD010"),
  CMD011: catalogueOf("CMD011"),
  CMD023: catalogueOf("CMD023"),
  CMD025: catalogueOf("CMD025"),
  CMD026: catalogueOf("CMD026"),
});

// --- the manual-10 reads (re-check finding N16) -----------------------------------------------------------------------------

/** Every read: a GET without a body or an idempotency key, so no body admission outcome applies. */
const EVERY_READ: ReadonlyArray<ProblemOutcome> = Object.freeze(
  EVERY_ROUTE.filter((o) => o.layer !== "ADMISSION" && o.layer !== "IDEMPOTENCY"),
);

/** Tenant reads: the authorizer's membership decisions; every membership role reads its agency (AGENCY_READER). */
const TENANT_READ: ReadonlyArray<ProblemOutcome> = Object.freeze(TENANT.filter((o) => o.reason !== "ROLE_INSUFFICIENT"));

/** A read that takes no query parameter refuses any (the query is a closed schema too). */
const NO_QUERY = outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the read takes no query parameter, or one was repeated", { fieldCodes: ["UNKNOWN_FIELD", "TYPE"] });

/** A list read: its closed query (limit, cursor) and its cursor. */
const PAGINATED: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the query is not limit (1..100, default 25) and cursor, or a member was repeated or malformed", { fieldCodes: ["UNKNOWN_FIELD", "TYPE", "FORMAT", "RANGE"] }),
  outcome("ADMISSION", "INVALID_REQUEST", "CURSOR_INVALID", "the cursor is not one this server issued for this caller, scope, list, filter and order (R2-060): nothing of another scope is read or disclosed"),
]);

const READ_SPECIFIC: Readonly<Record<ReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  ListAgencies: [...PAGINATED],
  GetAgency: [...PATH_IDS, ...TENANT_READ, NO_QUERY],
  ListMembers: [...PATH_IDS, ...TENANT_READ, ...PAGINATED],
  ListClients: [...PATH_IDS, ...TENANT_READ, ...PAGINATED],
  GetProject: [...PATH_IDS, ...TENANT_READ, ...AGENCY_HEADER, NO_QUERY, NOT_VISIBLE("the project")],
});

function readCatalogueOf(operationId: ReadOperationId): ReadonlyArray<ProblemOutcome> {
  const entries = [...EVERY_READ, ...READ_SPECIFIC[operationId]];
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.code}/${e.reason ?? "-"}`;
    if (seen.has(key)) throw new TypeError(`${operationId}: the outcome ${key} is listed twice`);
    seen.add(key);
  }
  return Object.freeze(entries);
}

/** The closed problem catalogue of each served read. */
export const READ_OUTCOMES: Readonly<Record<ReadOperationId, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  ListAgencies: readCatalogueOf("ListAgencies"),
  GetAgency: readCatalogueOf("GetAgency"),
  ListMembers: readCatalogueOf("ListMembers"),
  ListClients: readCatalogueOf("ListClients"),
  GetProject: readCatalogueOf("GetProject"),
});

// --- the operational routes with a closed catalogue (B11: the session boundary W2, the public routes W5b) -----------------------

const TRANSPORT_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "TRANSPORT"));
const PLATFORM_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "PLATFORM"));
/** A body admitted like a command's, without an idempotency key: content type, size, strict JSON, closed schema. */
const BODY_ADMISSION: ReadonlyArray<ProblemOutcome> = Object.freeze(EVERY_ROUTE.filter((o) => o.layer === "ADMISSION" && o.reason !== "IDEMPOTENCY_KEY_MISSING" && o.reason !== "IDEMPOTENCY_KEY_INVALID"));
const NO_BODY = outcome("ADMISSION", "INVALID_REQUEST", "SCHEMA_VIOLATION", "the route takes no body and no query parameter", { fieldCodes: ["UNKNOWN_FIELD"] });

function sessionCatalogue(operationId: string, entries: ReadonlyArray<ProblemOutcome>): ReadonlyArray<ProblemOutcome> {
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.code}/${e.reason ?? "-"}`;
    if (seen.has(key)) throw new TypeError(`${operationId}: the outcome ${key} is listed twice`);
    seen.add(key);
  }
  return Object.freeze([...entries]);
}

/**
 * The closed problem catalogues of the operational routes that have one. The api's send guard refuses any other problem on these
 * routes, like a command's; the probes (liveness, readiness) answer any problem the Problem schema admits.
 */
export const OPERATIONAL_OUTCOMES: Readonly<Record<string, ReadonlyArray<ProblemOutcome>>> = Object.freeze({
  getCapabilityPublication: sessionCatalogue("getCapabilityPublication", [...TRANSPORT_OUTCOMES, NO_BODY, ...PLATFORM_OUTCOMES]),
  createInquiry: sessionCatalogue("createInquiry", [
    ...TRANSPORT_OUTCOMES,
    outcome("ACCESS", "NOT_AUTHORIZED", "ORIGIN_REJECTED", "the request's Origin is absent or is not exactly the public or the application origin: decided before the body is read, nothing is stored or counted (D-PUB-2)"),
    ...BODY_ADMISSION,
    outcome("COMMAND", "CONTENT_REFUSED", "SECRET_LIKE_CONTENT", "the description looks like a credential, a key or a token: nothing is stored or counted, and the next action is the secure upload (D-PUB-4)"),
    outcome("COMMAND", "CONTENT_REFUSED", "RECORD_LIKE_CONTENT", "the description looks like customer records: nothing is stored or counted, and the next action is the secure upload (D-PUB-4)"),
    outcome("COMMAND", "ADMISSION_LIMITED", "INQUIRY_RATE_LIMITED", "the client-address hash has 5 accepted inquiries in the trailing hour, or the e-mail hash has 3 in the trailing day; retryAfterSeconds says when the first leaves the window (D-PUB-3)"),
    ...PLATFORM_OUTCOMES,
  ]),
});

/** The catalogue entry a problem is an instance of, or null. */
export function outcomeOf(outcomes: ReadonlyArray<ProblemOutcome>, code: string, reason: string | undefined): ProblemOutcome | null {
  return outcomes.find((o) => o.code === code && o.reason === (reason ?? null)) ?? null;
}

/** The entries of a catalogue grouped by the HTTP status their code fixes, in ascending status order. */
export function outcomesByStatus(outcomes: ReadonlyArray<ProblemOutcome>): ReadonlyArray<readonly [number, ReadonlyArray<ProblemOutcome>]> {
  const byStatus = new Map<number, ProblemOutcome[]>();
  for (const o of outcomes) {
    const status = PROBLEM_STATUS[o.code];
    const list = byStatus.get(status) ?? [];
    list.push(o);
    byStatus.set(status, list);
  }
  return [...byStatus.entries()].sort(([a], [b]) => a - b);
}
