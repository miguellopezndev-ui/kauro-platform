/**
 * The entries every closed outcome catalogue is composed from (re-check finding N13): an outcome's shape and constructor, the
 * pipeline's shared entries (framing, admission, authentication, access, idempotency, platform; the reads' own) and the catalogue
 * helpers. Kept apart from api/outcomes (the served catalogues) so a later package composes the catalogues of its own routes from
 * the same entries — the B07 source lifecycle, sources/outcomes — and the served catalogues join them without a module cycle.
 */
import type { FailureCode, FailureReason, FieldError } from "@kauro/domain";
import { PROBLEM_STATUS } from "./problems.js";

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
  outcome("AUTHENTICATION", "INVALID_REQUEST", "AMBIGUOUS_CREDENTIALS", "a session cookie beside an Authorization header, or two session cookies: nothing is decided for either (B11 D-AUTH-5); the anonymous denial is recorded"),
  outcome("ACCESS", "NOT_AUTHORIZED", "IDENTITY_DISABLED", "the token's or the stored identity state is DISABLED"),
  outcome("ACCESS", "NOT_AUTHORIZED", "IDENTITY_UNVERIFIED", "the launch policy needs a verified email and enrolled MFA"),
  outcome("IDEMPOTENCY", "IDEMPOTENCY_CONFLICT", "REQUEST_DIGEST_DIFFERS", "the key was used with another request: nothing was executed again"),
  outcome("IDEMPOTENCY", "PRECONDITION_FAILED", "OPERATION_PENDING", "the first request under this key is still in flight; retry with the same key"),
  outcome("PLATFORM", "CAPACITY_UNAVAILABLE", null, "no database capacity, a serialization or lock conflict, or a draining instance; retry with the same key"),
  outcome("PLATFORM", "INTERNAL_ERROR", null, "an unexpected exception, recorded under the correlation id; retry with the same key"),
  outcome("PLATFORM", "INTEGRITY_FAILURE", null, "a stored fact the command relies on is not what its own records say; nonretryable until the subject or implementation changes"),
  outcome("PLATFORM", "INTEGRITY_FAILURE", "RESPONSE_CONTRACT_VIOLATION", "the reply its route's contract refused was not sent (R23, N13)"),
]);

/**
 * The CSRF rule of an unsafe request authenticated by the session cookie (B11 D-AUTH-5), decided at authentication, before the
 * journal is reserved: no idempotency key is consumed and the anonymous denial is recorded. A read (GET) never reaches it; every
 * unsafe route a person authenticates for — a command, a document intake — answers it.
 */
const COOKIE_CSRF: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("AUTHENTICATION", "NOT_AUTHORIZED", "ORIGIN_REJECTED", "the request's Origin is not exactly an application origin (or absent), or the browser reports a cross-site request: nothing is executed and the key is not consumed"),
  outcome("AUTHENTICATION", "NOT_AUTHORIZED", "CSRF_TOKEN_INVALID", "the request does not carry the session's CSRF token (X-Kauro-CSRF): nothing is executed and the key is not consumed"),
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

/**
 * The pipeline's shared outcome lists and the entry constructor, exported so a later package composes the closed catalogues of its
 * own routes from the same entries instead of restating them (the B07 source lifecycle: @kauro/application sources/outcomes).
 */
export const OUTCOME_BLOCKS = Object.freeze({ EVERY_ROUTE, PATH_IDS, TENANT, AGENCY_HEADER, EVERY_READ, TENANT_READ, NO_QUERY, PAGINATED, COOKIE_CSRF });
export { outcome as problemOutcome };

/** A closed catalogue from its entries: refuses an entry listed twice (by code and reason). */
export function closedCatalogue(route: string, entries: ReadonlyArray<ProblemOutcome>): ReadonlyArray<ProblemOutcome> {
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.code}/${e.reason ?? "-"}`;
    if (seen.has(key)) throw new TypeError(`${route}: the outcome ${key} is listed twice`);
    seen.add(key);
  }
  return Object.freeze([...entries]);
}

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
