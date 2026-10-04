/**
 * The response contract of a route and its runtime check (10 "Responses and safe errors": "Synchronous success returns a
 * validated DTO and version"; 10 "Version and validation": "TypeScript types alone are insufficient runtime validation"; 07
 * "Command outcomes and error taxonomy": an unexpected failure "is recorded with an opaque correlation ID and safe technical
 * classification", and integrity failure is its own outcome).
 *
 * Every route declares the replies it may send: its success statuses with their schema, and the Problem document for every
 * status >= 400 it does not declare otherwise. The transport checks each reply against that declaration with the same strict
 * validator that admits requests, before a byte is sent. A reply the declaration refuses — an undeclared status, another
 * content type, a member the closed schema does not name, a value outside its shape, a problem whose status differs from the
 * HTTP status, or, on a route with an outcome catalogue, a problem the catalogue does not list (re-check finding N13) — is
 * never sent: the transport hands a ResponseContractViolation (schema, status and field paths; never a value)
 * to the internal-error sink under the correlation id and answers INTEGRITY_FAILURE instead.
 */
import type { FieldError } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { KnownSchemaId, SchemaValidator } from "../ports/schema-validator.js";
import { HEADERS } from "./envelope.js";
import { COMMAND_OUTCOMES, INTAKE_OUTCOMES, OPERATIONAL_OUTCOMES, READ_OUTCOMES, outcomeOf, type ProblemOutcome } from "./outcomes.js";
import { problemOf, type Problem } from "./problems.js";
import {
  ACCEPTED_RESPONSE_SCHEMA_ID,
  COMMAND_RESPONSES,
  OPERATIONAL_ROUTES,
  commandResponseSchemaId,
  intakeResponseSchemaId,
  operationalResponseSchemaId,
  readResponseSchemaId,
  type IntakeOperationId,
  type OperationalRoute,
  type ReadOperationId,
  type ServedCommandId,
} from "./response-schemas.js";

/** A declared reply: its media type and schema, or both null for a reply without a body (204). */
export interface DeclaredResponse {
  readonly contentType: string | null;
  readonly schemaId: KnownSchemaId | null;
}

/** What a route may answer: its declared replies by status, and the Problem document for every other status >= 400. */
export interface RouteResponses {
  readonly operationId: string;
  readonly declared: Readonly<Record<string, DeclaredResponse>>;
  readonly problem: DeclaredResponse;
  /**
   * The closed catalogue of the problems the route may answer (api/outcomes), or null for a route whose problems are any the
   * Problem schema admits (the operational probes, and replies sent outside any route).
   */
  readonly outcomes: ReadonlyArray<ProblemOutcome> | null;
}

export const PROBLEM_RESPONSE: DeclaredResponse = Object.freeze({ contentType: HEADERS.problemContentType, schemaId: "Problem" });

/**
 * The contract of replies sent outside any declared route (unknown routes and methods, framework errors before routing):
 * problems only; a success there is a violation.
 */
export const UNROUTED_RESPONSES: RouteResponses = Object.freeze({ operationId: "unrouted", declared: Object.freeze({}), problem: PROBLEM_RESPONSE, outcomes: null });

/**
 * The declared replies of a served command route: its COMPLETED status and schema — or, for a command whose completion remains
 * asynchronous (CMD014, B07 D-RUN-1), 202 and the ACCEPTED envelope — and problems otherwise.
 */
export function commandRouteResponses(command: ServedCommandId, operationId: string): RouteResponses {
  const success = COMMAND_RESPONSES[command];
  const schemaId = success.view === null ? ACCEPTED_RESPONSE_SCHEMA_ID : commandResponseSchemaId(command);
  return Object.freeze({
    operationId,
    declared: Object.freeze({ [String(success.status)]: Object.freeze({ contentType: HEADERS.contentType, schemaId }) }),
    problem: PROBLEM_RESPONSE,
    outcomes: COMMAND_OUTCOMES[command],
  });
}

/** The declared replies of a served read (N16): 200 with its READ envelope, problems from its catalogue otherwise. */
export function readRouteResponses(operationId: ReadOperationId): RouteResponses {
  return Object.freeze({
    operationId,
    declared: Object.freeze({ "200": Object.freeze({ contentType: HEADERS.contentType, schemaId: readResponseSchemaId(operationId) }) }),
    problem: PROBLEM_RESPONSE,
    outcomes: READ_OUTCOMES[operationId],
  });
}

/**
 * The declared replies of a served document intake (B07 D-SEL-2): 201 when this request stored the document, 200 when the same
 * document was already stored — both the STORED envelope — and problems from its catalogue otherwise.
 */
export function intakeRouteResponses(operationId: IntakeOperationId): RouteResponses {
  const stored = Object.freeze({ contentType: HEADERS.contentType, schemaId: intakeResponseSchemaId(operationId) });
  return Object.freeze({
    operationId,
    declared: Object.freeze({ "200": stored, "201": stored }),
    problem: PROBLEM_RESPONSE,
    outcomes: INTAKE_OUTCOMES[operationId],
  });
}

/** The declared replies of an operational route of OPERATIONAL_ROUTES (or of the given list), for its `config.responses`. */
export function operationalRouteResponses(operationId: string, routes: ReadonlyArray<OperationalRoute> = OPERATIONAL_ROUTES): RouteResponses {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) throw new DomainFailure("INTEGRITY_FAILURE", `no operational route ${operationId} is declared`);
  const declared: Record<string, DeclaredResponse> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    declared[status] = Object.freeze(response.schema === null ? { contentType: null, schemaId: null } : { contentType: response.contentType, schemaId: operationalResponseSchemaId(operationId, status) });
  }
  return Object.freeze({ operationId, declared: Object.freeze(declared), problem: PROBLEM_RESPONSE, outcomes: OPERATIONAL_OUTCOMES[operationId] ?? null });
}

export function isServedCommand(id: string): id is ServedCommandId {
  return Object.prototype.hasOwnProperty.call(COMMAND_RESPONSES, id);
}

/** A reply its route's contract refuses. Names the schema, the status and the offending paths and codes, never a value. */
export class ResponseContractViolation extends Error {
  readonly operationId: string;
  readonly status: number;
  readonly schemaId: string | null;
  readonly fields: ReadonlyArray<FieldError>;
  constructor(operationId: string, status: number, schemaId: string | null, problem: string, fields: ReadonlyArray<FieldError> = [], options?: { readonly cause?: unknown }) {
    super(`response of ${operationId} with status ${status} violates ${schemaId ?? "its route contract"}: ${problem}${fields.length > 0 ? ` [${fields.map((f) => `${f.field || "(root)"} ${f.code}`).join(", ")}]` : ""}`, options);
    this.name = "ResponseContractViolation";
    this.operationId = operationId;
    this.status = status;
    this.schemaId = schemaId;
    this.fields = fields;
  }
}

/** The media type of a Content-Type header value, lowercased, without parameters. */
export function mediaTypeOf(contentType: string | undefined): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Checks one reply against its route's contract and throws ResponseContractViolation when the contract refuses it. The body
 * is the object the transport is about to serialize; it is validated as is (no coercion, no default, no removal).
 */
export function checkReply(validator: SchemaValidator, responses: RouteResponses, status: number, contentType: string | undefined, body: unknown): void {
  const declared = responses.declared[String(status)];
  const expected = declared ?? (status >= 400 && status <= 599 ? responses.problem : null);
  if (expected === null) throw new ResponseContractViolation(responses.operationId, status, null, `status ${status} is not declared`);
  if (expected.schemaId === null || expected.contentType === null) {
    // a reply declared without a body (204) carries none, and no media type
    if (body !== undefined && body !== null && body !== "") throw new ResponseContractViolation(responses.operationId, status, null, `status ${status} is declared without a body`);
    if (mediaTypeOf(contentType) !== "") throw new ResponseContractViolation(responses.operationId, status, null, `status ${status} is declared without a body; it names the media type ${mediaTypeOf(contentType)}`);
    return;
  }
  if (body === undefined || body === null || body === "") throw new ResponseContractViolation(responses.operationId, status, expected.schemaId, "the reply has no body");
  if (mediaTypeOf(contentType) !== expected.contentType) {
    throw new ResponseContractViolation(responses.operationId, status, expected.schemaId, `content type ${mediaTypeOf(contentType) || "(none)"} is not ${expected.contentType}`);
  }
  const outcome = validator.validate(expected.schemaId, body);
  if (outcome.kind === "INVALID") throw new ResponseContractViolation(responses.operationId, status, expected.schemaId, "the body does not satisfy the schema", outcome.fields);
  if (expected.schemaId === "Problem" && (body as Problem).status !== status) {
    throw new ResponseContractViolation(responses.operationId, status, "Problem", `the problem states status ${(body as Problem).status}`);
  }
  if (expected.schemaId === "Problem" && responses.outcomes !== null) checkOutcome(responses.operationId, responses.outcomes, status, body as Problem);
}

/**
 * A problem on a route with a catalogue must be one of its entries (N13): the (code, reason) pair is listed, its field errors
 * carry only the entry's field codes, and it carries `current` exactly as the entry says. The violation names tokens only.
 */
function checkOutcome(operationId: string, outcomes: ReadonlyArray<ProblemOutcome>, status: number, problem: Problem): void {
  const entry = outcomeOf(outcomes, problem.code, problem.reason);
  const name = `${problem.code}/${problem.reason ?? "-"}`;
  if (entry === null) throw new ResponseContractViolation(operationId, status, "Problem", `the outcome ${name} is not in the route's catalogue`);
  for (const error of problem.errors ?? []) {
    if (!(entry.fieldCodes ?? []).includes(error.code)) throw new ResponseContractViolation(operationId, status, "Problem", `the outcome ${name} carries a field error its catalogue entry does not list`, [{ field: error.field, code: error.code }]);
  }
  if (problem.current !== undefined && entry.current === undefined) throw new ResponseContractViolation(operationId, status, "Problem", `the outcome ${name} carries current, which its catalogue entry never does`);
  if (problem.current === undefined && entry.current === "ALWAYS") throw new ResponseContractViolation(operationId, status, "Problem", `the outcome ${name} lacks current, which its catalogue entry always carries`);
}

/** The problem sent in place of a reply its contract refused: INTEGRITY_FAILURE, nonretryable, only the correlation id. */
export function responseIntegrityProblem(correlationId: string): Problem {
  return problemOf(new DomainFailure("INTEGRITY_FAILURE", "response contract violation", { reason: "RESPONSE_CONTRACT_VIOLATION" }), correlationId);
}
