/**
 * Request admission (10 "Request envelope": the server validates content type, byte size, JSON syntax, duplicate keys, schema,
 * authenticated subject and authorization before application execution; database queries occur after structural validation).
 *
 * This module is transport-neutral: the HTTP adapter hands it the lowercased headers, the route parameters and the raw body
 * text, and receives either a structurally admitted request or the safe problem to send. It never touches a database and never
 * echoes a value: field errors name fields, problems name codes. Authentication is the transport's asynchronous step between
 * `admitStructure` and `envelopeOf`; a request without a subject is AUTHENTICATION_REQUIRED at the edge.
 */
import type { CommandId } from "@kauro/contracts";
import type { AgencyId, Clock, CorrelationId, Environment, FieldError, IdGenerator, UserId } from "@kauro/domain";
import { DomainFailure, IDEMPOTENCY_KEY, isUuid } from "@kauro/domain";
import type { CommandSpec } from "../ports/command-handler.js";
import type { SchemaValidator } from "../ports/schema-validator.js";
import { HEADERS, REQUEST_LIMITS, type AuthenticatedSubject, type CommandEnvelope } from "./envelope.js";
import { problemOf, type Problem } from "./problems.js";
import { requestSchemaId, type RequestSchemaCommand } from "./request-schemas.js";
import { StrictJsonError, parseStrictJson } from "./strict-json.js";

export interface RawRequest {
  /** Header names lowercased; a repeated header is refused by the transport before admission. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly params: Readonly<Record<string, string | undefined>>;
  /** The body as text (UTF-8 decoded by the transport); null when the request carried none. */
  readonly bodyText: string | null;
  readonly bodyBytes: number;
}

export interface StructuralAdmission<Body> {
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly agencyId: AgencyId | null;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
  readonly receivedAt: string;
}

export type AdmissionOutcome<Body> =
  | { readonly kind: "ADMITTED"; readonly admission: StructuralAdmission<Body> }
  | { readonly kind: "PROBLEM"; readonly correlationId: CorrelationId; readonly problem: Problem };

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The correlation id of a request: the client's when well-formed, else a fresh server id (10: every request receives one). */
export function correlationIdOf(headers: RawRequest["headers"], ids: IdGenerator): { readonly id: CorrelationId; readonly invalid: boolean } {
  const given = headers[HEADERS.correlationId];
  if (given === undefined || given === "") return { id: ids.next() as CorrelationId, invalid: false };
  if (!REQUEST_LIMITS.correlationIdPattern.test(given)) return { id: ids.next() as CorrelationId, invalid: true };
  return { id: given as CorrelationId, invalid: false };
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
 * Structural admission of one command request, in the order of manual 10. The first failure is the answer; the handler and
 * the database are never reached by a request that fails here.
 */
export function admitStructure<Body>(spec: CommandSpec<Body>, raw: RawRequest, validator: SchemaValidator, ids: IdGenerator, clock: Clock): AdmissionOutcome<Body> {
  const correlation = correlationIdOf(raw.headers, ids);
  const correlationId = correlation.id;
  const fail = (f: DomainFailure): AdmissionOutcome<Body> => ({ kind: "PROBLEM", correlationId, problem: problemOf(f, correlationId) });
  try {
    if (correlation.invalid) throw invalid("CORRELATION_ID_INVALID");
    // 1. content type
    if (!isJsonContentType(raw.headers["content-type"])) throw invalid("CONTENT_TYPE_UNSUPPORTED");
    // 2. byte size
    if (raw.bodyBytes > REQUEST_LIMITS.jsonBytes) throw invalid("BODY_TOO_LARGE");
    // 3. JSON syntax, duplicate keys, depth, string length
    if (raw.bodyText === null) throw invalid("JSON_SYNTAX");
    let parsed: unknown;
    try {
      parsed = parseStrictJson(raw.bodyText);
    } catch (e) {
      if (e instanceof StrictJsonError) throw invalid(e.reason);
      throw e;
    }
    // 4. closed schema (no coercion, no defaults, unknown members refused: R2-058, R2-059)
    const outcome = validator.validate<Body>(requestSchemaId(spec.id as RequestSchemaCommand), parsed);
    if (outcome.kind === "INVALID") throw invalid("SCHEMA_VIOLATION", outcome.fields);
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
      admission: { correlationId, idempotencyKey: key, agencyId, path, body: outcome.value, receivedAt: clock.now() },
    };
  } catch (e) {
    if (e instanceof DomainFailure) return fail(e);
    throw e;
  }
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
    path: admission.path,
    body: admission.body,
    receivedAt: admission.receivedAt,
  };
}
