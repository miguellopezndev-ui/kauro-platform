/**
 * Request admission (10 "Request envelope": the server validates content type, byte size, JSON syntax, duplicate keys, schema,
 * authenticated subject and authorization before application execution; database queries occur after structural validation).
 *
 * This module is transport-neutral: the HTTP adapter hands it the lowercased headers, the names of the header fields the
 * request repeated, the correlation id it resolved once for the request, the route parameters, the raw body bytes and the
 * keyed hash of the client address, and receives either a structurally admitted request or the safe problem to send. It
 * never touches a database and never echoes a value: field errors name fields, problems name codes. Authentication is the
 * transport's asynchronous step between `admitStructure` and `envelopeOf`; a request without a subject is
 * AUTHENTICATION_REQUIRED at the edge.
 */
import type { CommandId, Sha256Hex } from "@kauro/contracts";
import type { AgencyId, Clock, CorrelationId, Environment, FieldError, IdGenerator, UserId } from "@kauro/domain";
import { DomainFailure, IDEMPOTENCY_KEY, isUuid } from "@kauro/domain";
import type { CommandSpec } from "../ports/command-handler.js";
import type { KnownSchemaId, SchemaValidator } from "../ports/schema-validator.js";
import { HEADERS, REQUEST_LIMITS, SINGLE_VALUED_HEADERS, type AuthenticatedSubject, type CommandEnvelope } from "./envelope.js";
import { problemOf, type Problem } from "./problems.js";
import { requestSchemaId, type RequestSchemaCommand } from "./request-schemas.js";
import { operationalRequestSchemaId, type OperationalRoute } from "./response-schemas.js";
import { StrictJsonError, parseStrictJson } from "./strict-json.js";

/** What admission needs from the head of a request, before any body byte is read. */
export interface RequestHead {
  /** Header names lowercased, one value per field (the transport's single-valued view). */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Lowercased names of the header fields the request carried more than once (the transport's raw header list). */
  readonly repeatedHeaders: ReadonlyArray<string>;
  /** The request's correlation id, resolved once by the transport with `correlationIdOf` and used for every answer. */
  readonly correlationId: CorrelationId;
}

export interface RawRequest extends RequestHead {
  readonly params: Readonly<Record<string, string | undefined>>;
  /**
   * The body bytes exactly as received; null when the request carried none. Admission decodes them as strict UTF-8 (RFC 8259
   * §8.1: JSON exchanged between systems is UTF-8): an invalid byte sequence is JSON_SYNTAX, never replaced (review R40).
   */
  readonly body: Uint8Array | null;
  /** Keyed SHA-256 of the client address the transport established (08 "Abuse controls"); null when it has none. */
  readonly clientAddressHash: Sha256Hex | null;
}

export interface StructuralAdmission<Body> {
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly agencyId: AgencyId | null;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly receivedAt: string;
  readonly clientAddressHash: Sha256Hex | null;
}

export type AdmissionOutcome<Body> =
  | { readonly kind: "ADMITTED"; readonly admission: StructuralAdmission<Body> }
  | { readonly kind: "PROBLEM"; readonly correlationId: CorrelationId; readonly problem: Problem };

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Strict UTF-8: a malformed sequence throws instead of becoming U+FFFD; a byte order mark is kept, so the strict parser refuses it. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The correlation id of a request (10 "Every request receives an opaque correlation ID"): the client's when it is an `id`,
 * otherwise — absent, or any other value — a fresh server UUIDv7. A malformed client value never refuses the request and is
 * never echoed (review finding R28): a proxy's own request id or a token with control characters simply does not become the
 * request's correlation id. A transport calls this once per request and uses the result for the log, the answer and the
 * durable records alike.
 */
export function correlationIdOf(headers: RequestHead["headers"], ids: IdGenerator): CorrelationId {
  const given = headers[HEADERS.correlationId];
  if (given !== undefined && REQUEST_LIMITS.correlationIdPattern.test(given)) return given as CorrelationId;
  return ids.next() as CorrelationId;
}

/**
 * The lowercased names of the fields a raw header list (name, value, name, value, ...: Node's `rawHeaders`) carries more
 * than once, each named once.
 */
export function repeatedHeaderNames(rawHeaders: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? "").toLowerCase();
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated];
}

function invalid(reason: DomainFailure["details"]["reason"], fields?: ReadonlyArray<FieldError>): DomainFailure {
  return new DomainFailure("INVALID_REQUEST", `request refused: ${String(reason)}`, { ...(reason ? { reason } : {}), ...(fields ? { fields } : {}) });
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const [type, ...params] = value.split(";").map((s) => s.trim().toLowerCase());
  if (type !== HEADERS.contentType) return false;
  for (const p of params) {
    if (p === "") continue;
    const [k, v] = p.split("=").map((s) => s.trim());
    if (k === "charset") return v === "utf-8" || v === '"utf-8"';
    // any other media-type parameter is not something the boundary understands
    return false;
  }
  return true;
}

/**
 * The head of the admission order that needs the headers only: a repeated single-valued envelope header (the request's
 * headers cannot be read unambiguously, so nothing that depends on them is decided — R41), then the content type.
 */
function headerFailure(head: Pick<RequestHead, "headers" | "repeatedHeaders">): DomainFailure | null {
  if (head.repeatedHeaders.some((name) => SINGLE_VALUED_HEADERS.has(name))) return invalid("HEADER_REPEATED");
  if (!isJsonContentType(head.headers["content-type"])) return invalid("CONTENT_TYPE_UNSUPPORTED");
  return null;
}

/**
 * The part of the admission a transport decides from the head alone — a repeated envelope header, then the content type —
 * run before the body is read, so neither the size nor the bytes of a body can answer a request whose head already refuses
 * it (10 "Request envelope": content type, byte size, JSON syntax, duplicate keys, schema, in that order). Returns the
 * problem to send, or null to go on reading the body; `admitStructure` repeats both checks, so a transport that skips this
 * step still refuses exactly the same requests.
 */
export function admitHeaders(head: RequestHead): Extract<AdmissionOutcome<never>, { readonly kind: "PROBLEM" }> | null {
  const failure = headerFailure(head);
  return failure === null ? null : { kind: "PROBLEM", correlationId: head.correlationId, problem: problemOf(failure, head.correlationId) };
}

/**
 * Structural admission of one command request, in the order of manual 10. The first failure is the answer; the handler and
 * the database are never reached by a request that fails here.
 */
/**
 * Steps 0-4 of the admission order for a JSON body (a command's, or an operational route's that takes one): a repeated envelope
 * header, the content type, the byte size, strict UTF-8 and strict JSON, then the closed schema. Throws the refusal.
 */
function admitJsonBody<Body>(raw: Pick<RawRequest, "headers" | "repeatedHeaders" | "body">, schemaId: KnownSchemaId, validator: SchemaValidator): Body {
  // 0-1. repeated envelope header, content type (the header-only head, also run by the transport before the body is read)
  const early = headerFailure(raw);
  if (early !== null) throw early;
  // 2. byte size
  if ((raw.body?.byteLength ?? 0) > REQUEST_LIMITS.jsonBytes) throw invalid("BODY_TOO_LARGE");
  // 3. UTF-8, JSON syntax, duplicate keys, depth, string length
  if (raw.body === null) throw invalid("JSON_SYNTAX");
  let text: string;
  try {
    text = UTF8.decode(raw.body);
  } catch (e) {
    if (e instanceof TypeError) throw invalid("JSON_SYNTAX");
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(text);
  } catch (e) {
    if (e instanceof StrictJsonError) throw invalid(e.reason);
    throw e;
  }
  // 4. closed schema (no coercion, no defaults, unknown members refused: R2-058, R2-059)
  const outcome = validator.validate<Body>(schemaId, parsed);
  if (outcome.kind === "INVALID") throw invalid("SCHEMA_VIOLATION", outcome.fields);
  return outcome.value;
}

export function admitStructure<Body>(spec: CommandSpec<Body>, raw: RawRequest, validator: SchemaValidator, clock: Clock): AdmissionOutcome<Body> {
  const correlationId = raw.correlationId;
  const fail = (f: DomainFailure): AdmissionOutcome<Body> => ({ kind: "PROBLEM", correlationId, problem: problemOf(f, correlationId) });
  try {
    // 0-4. repeated envelope header, content type, byte size, strict UTF-8 JSON, closed schema
    const body = admitJsonBody<Body>(raw, requestSchemaId(spec.id as RequestSchemaCommand), validator);
    // 5. envelope: idempotency key, path ids, agency selector
    const key = raw.headers[HEADERS.idempotencyKey];
    if (key === undefined || key === "") throw invalid("IDEMPOTENCY_KEY_MISSING");
    if (!IDEMPOTENCY_KEY.test(key)) throw invalid("IDEMPOTENCY_KEY_INVALID");
    const path: Record<string, string> = {};
    for (const name of spec.path.match(/\{([a-zA-Z]+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
      const value = raw.params[name];
      if (value === undefined || !UUID_PATH.test(value)) throw invalid("PATH_ID_INVALID", [{ field: name, code: "FORMAT" }]);
      path[name] = value;
    }
    let agencyId: AgencyId | null = null;
    if (spec.scope === "AGENCY_PATH") {
      agencyId = path["agencyId"] as AgencyId;
    } else if (spec.scope === "AGENCY_HEADER") {
      const selector = raw.headers[HEADERS.agency];
      if (selector === undefined || !isUuid(selector)) throw invalid("AGENCY_SELECTOR_INVALID");
      agencyId = selector as AgencyId;
    }
    return {
      kind: "ADMITTED",
      admission: { correlationId, idempotencyKey: key, agencyId, path, body, receivedAt: clock.now(), clientAddressHash: raw.clientAddressHash },
    };
  } catch (e) {
    if (e instanceof DomainFailure) return fail(e);
    throw e;
  }
}

/**
 * Admission of an operational route's body (B11 W2: POST /api/v1/sessions and POST /api/v1/assurance/step-ups): the same order
 * as a command's steps 0-4 against the route's closed request schema; no idempotency key (these routes journal nothing), no
 * path id, no agency selector.
 */
export function admitOperationalBody<Body>(route: OperationalRoute, raw: Pick<RawRequest, "headers" | "repeatedHeaders" | "correlationId" | "body">, validator: SchemaValidator): { readonly kind: "ADMITTED"; readonly body: Body } | Extract<AdmissionOutcome<never>, { readonly kind: "PROBLEM" }> {
  if (route.request === undefined) throw new TypeError(`the operational route ${route.operationId} takes no body`);
  try {
    return { kind: "ADMITTED", body: admitJsonBody<Body>(raw, operationalRequestSchemaId(route.operationId), validator) };
  } catch (e) {
    if (e instanceof DomainFailure) return { kind: "PROBLEM", correlationId: raw.correlationId, problem: problemOf(e, raw.correlationId) };
    throw e;
  }
}

/**
 * Admission of an operational route that takes neither a body nor a query (GET /api/v1/sessions/current, the logout, the
 * identity configuration): a repeated envelope header, then any body byte or query parameter is refused (a closed request).
 */
export function admitEmptyRequest(raw: Pick<RawRequest, "headers" | "repeatedHeaders" | "correlationId" | "body"> & { readonly query: Readonly<Record<string, unknown>> }): Extract<AdmissionOutcome<never>, { readonly kind: "PROBLEM" }> | null {
  const fail = (f: DomainFailure) => ({ kind: "PROBLEM" as const, correlationId: raw.correlationId, problem: problemOf(f, raw.correlationId) });
  if (raw.repeatedHeaders.some((name) => SINGLE_VALUED_HEADERS.has(name))) return fail(invalid("HEADER_REPEATED"));
  const names = Object.keys(raw.query);
  if (names.length > 0) return fail(invalid("SCHEMA_VIOLATION", [{ field: "query", code: "UNKNOWN_FIELD" }]));
  if ((raw.body?.byteLength ?? 0) > 0) return fail(invalid("SCHEMA_VIOLATION", [{ field: "body", code: "UNKNOWN_FIELD" }]));
  return null;
}

/** The problem for a request whose subject could not be authenticated (401, next action REAUTHENTICATE). */
export function unauthenticatedProblem(correlationId: CorrelationId): Problem {
  return problemOf(new DomainFailure("AUTHENTICATION_REQUIRED", "no authenticated subject"), correlationId);
}

/** Completes the envelope once the subject is authenticated. */
export function envelopeOf<Body>(command: CommandId, environment: Environment, admission: StructuralAdmission<Body>, subject: AuthenticatedSubject): CommandEnvelope<Body> {
  return {
    command,
    environment,
    correlationId: admission.correlationId,
    idempotencyKey: admission.idempotencyKey,
    userId: subject.identity.userId as UserId,
    subject,
    agencyId: admission.agencyId,
    clientAddressHash: admission.clientAddressHash,
    path: admission.path,
    body: admission.body,
    receivedAt: admission.receivedAt,
  };
}
