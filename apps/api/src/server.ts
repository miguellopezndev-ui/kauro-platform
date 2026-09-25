/**
 * The Kauro HTTP API (10 "API, contracts and integration seams"): Fastify routes for the seven B06 commands, registered from
 * the command specs of @kauro/application (method, path, scope), with the admission pipeline of manual 10 (content type, byte
 * size, strict JSON, closed schema, envelope headers, authenticated subject) in front of every handler, typed replies
 * (CompletedResponse / AcceptedResponse / Problem) and the safe problem translation of every failure, including Fastify's own
 * parser errors and unexpected exceptions (opaque INTERNAL_ERROR by correlation id; 07 "Command outcomes").
 *
 * Fastify's built-in JSON parser and Ajv are not used for command bodies: the body reaches the route as raw text and goes
 * through the strict parser and the closed validator of @kauro/application, so a duplicate key, an unknown member, a string
 * where a boolean is expected or an impossible date is refused before any database work (R2-058, R2-059, S093).
 *
 * Replies: every route declares the replies it may send (`config.responses`, api/response-contract of @kauro/application) —
 * a route without a declaration refuses to register. Every reply, from a route, a hook, the not-found handler or the error
 * handler, is checked against that declaration by the same closed validator before it is serialized (10 "Synchronous success
 * returns a validated DTO"; "TypeScript types alone are insufficient runtime validation"). Fastify's response serializer is not
 * given the schemas: a serializer with other schema semantics would silently drop what a 2020-12 closed schema refuses (10
 * "Version and validation"), so the reply is validated as is and serialized by JSON.stringify. A reply the declaration refuses
 * is never sent: its violation (schema, status, field paths — never a value) goes to the internal-error sink under the
 * correlation id and the client receives INTEGRITY_FAILURE. The registered routes and their declarations are the route
 * inventory tools/openapi.mjs checks the OpenAPI document against.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CommandId } from "@kauro/contracts";
import type {
  AcceptedResponse,
  B06Handlers,
  CommandEnvelope,
  CommandHandler,
  CommandResult,
  CompletedResponse,
  Problem,
  RawRequest,
  RouteResponses,
  SchemaValidator,
} from "@kauro/application";
import {
  HEADERS,
  REQUEST_LIMITS,
  ResponseContractViolation,
  UNROUTED_RESPONSES,
  admitHeaders,
  admitStructure,
  checkReply,
  commandRouteResponses,
  correlationIdOf,
  envelopeOf,
  internalProblem,
  isServedCommand,
  problemOf,
  responseIntegrityProblem,
  unauthenticatedProblem,
} from "@kauro/application";
import type { Clock, Environment, IdGenerator } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { Authenticator } from "./authenticator.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** The replies this route may send; every route declares them (api/response-contract of @kauro/application). */
    responses?: RouteResponses;
  }
}

/** One registered route and the replies it declares: what the OpenAPI checker compares the document with. */
export interface RouteInventoryEntry {
  readonly method: string;
  /** The Fastify path (`/api/v1/plans/:planId/approve`). */
  readonly url: string;
  readonly responses: RouteResponses;
}

const INVENTORIES = new WeakMap<FastifyInstance, RouteInventoryEntry[]>();

/** The routes registered on a server built by createApiServer, in registration order, with their declared replies. */
export function routeInventoryOf(app: FastifyInstance): ReadonlyArray<RouteInventoryEntry> {
  const inventory = INVENTORIES.get(app);
  if (!inventory) throw new Error("the route inventory is recorded by createApiServer; this instance was not built by it");
  return [...inventory];
}

export interface ApiServerOptions {
  readonly environment: Environment;
  readonly handlers: B06Handlers;
  readonly authenticator: Authenticator;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Fastify logger configuration; off by default (tests), a pino configuration in a deployment. */
  readonly logger?: boolean;
  /** Receives every unexpected exception with its correlation id; the default writes the safe classification to stderr. */
  readonly onInternalError?: (correlationId: string, error: unknown) => void;
}

export type CommandReply<View> = CompletedResponse<View> | AcceptedResponse | Problem;

/** `/api/v1/plans/{planId}/approve` → `/api/v1/plans/:planId/approve`. */
export function fastifyPath(cataloguePath: string): string {
  return cataloguePath.replace(/\{([a-zA-Z]+)\}/g, ":$1");
}

function singleValued(headers: FastifyRequest["headers"]): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = typeof v === "string" ? v : undefined;
  return out;
}

function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).header(HEADERS.correlationId, problem.correlationId).type(HEADERS.problemContentType).send(problem);
}

/** The safe classification of an unexpected exception: class names only (the adapter attaches the original error as cause). */
export function classifyInternalError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined ? name : `${name} cause=${cause instanceof Error ? cause.name : typeof cause}`;
}

function defaultInternalErrorSink(correlationId: string, error: unknown): void {
  process.stderr.write(`kauro-api internal error correlation=${correlationId} class=${classifyInternalError(error)}\n`);
}

function headerText(value: string | number | ReadonlyArray<string> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * Records every route with its declared replies, and refuses to register a route that declares none: a route whose replies
 * are not declared could not be documented, checked or validated.
 */
function recordRouteInventory(app: FastifyInstance): void {
  const inventory: RouteInventoryEntry[] = [];
  INVENTORIES.set(app, inventory);
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const responses = route.config?.responses;
    if (responses === undefined) {
      throw new Error(
        `route ${methods.join(",")} ${route.url} declares no response contract: pass config.responses — commandRouteResponses(<command>, <name>) for a registry command, or declare the route in OPERATIONAL_ROUTES and pass operationalRouteResponses(<operationId>) (@kauro/application api/response-schemas, api/response-contract); then run pnpm run openapi:generate`,
      );
    }
    for (const method of methods) inventory.push({ method: String(method).toUpperCase(), url: route.url, responses });
  });
}

/**
 * The send guard: every object reply is checked against its route's declared replies before serialization (preSerialization
 * runs for route handlers, hooks, the not-found handler and the error handler alike), and a reply whose body never reached
 * that check — a string, buffer or stream sent directly — is refused when it is sent (onSend). A refused reply is replaced by
 * INTEGRITY_FAILURE; its violation goes to the sink under the reply's correlation id.
 */
function installResponseGuard(app: FastifyInstance, options: ApiServerOptions, sink: (correlationId: string, error: unknown) => void): void {
  const checked = new WeakSet<FastifyReply>();

  const refuse = (request: FastifyRequest, reply: FastifyReply, violation: ResponseContractViolation): Problem => {
    // the correlation id the reply already carries (every send path of this server sets one), else the request's own
    const given = headerText(reply.getHeader(HEADERS.correlationId));
    const correlationId = given !== undefined && given !== "" ? given : correlationIdOf(singleValued(request.headers), options.ids).id;
    sink(correlationId, violation);
    const problem = responseIntegrityProblem(correlationId);
    // the replacement is built from constants and a correlation id the admission produced; it is checked like any reply, and a
    // refusal here is a defect of this module that must not be answered with an unchecked body
    checkReply(options.validator, UNROUTED_RESPONSES, problem.status, HEADERS.problemContentType, problem);
    reply.code(problem.status).header(HEADERS.correlationId, correlationId).header("content-type", `${HEADERS.problemContentType}; charset=utf-8`);
    return problem;
  };

  app.addHook("preSerialization", async (request, reply, payload: unknown) => {
    checked.add(reply);
    const responses = request.routeOptions.config.responses ?? UNROUTED_RESPONSES;
    try {
      checkReply(options.validator, responses, reply.statusCode, headerText(reply.getHeader("content-type")), payload);
      return payload;
    } catch (e) {
      // a check that cannot run (a declared schema the validator does not know) refuses the reply the same way
      const violation = e instanceof ResponseContractViolation ? e : new ResponseContractViolation(responses.operationId, reply.statusCode, null, "the response check could not run", [], { cause: e });
      return refuse(request, reply, violation);
    }
  });

  app.addHook("onSend", async (request, reply, payload: unknown) => {
    if (checked.has(reply)) return payload;
    const responses = request.routeOptions.config.responses ?? UNROUTED_RESPONSES;
    checked.add(reply);
    const violation = new ResponseContractViolation(responses.operationId, reply.statusCode, null, "the reply was sent without passing the response check (not a JSON object body)");
    return JSON.stringify(refuse(request, reply, violation));
  });
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: REQUEST_LIMITS.jsonBytes, exposeHeadRoutes: false });
  const sink = options.onInternalError ?? defaultInternalErrorSink;
  recordRouteInventory(app);
  installResponseGuard(app, options, sink);

  // every body reaches the route as text; admission decides content type, size, syntax and schema in the order of manual 10
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.setNotFoundHandler((request, reply) => {
    const correlationId = correlationIdOf(singleValued(request.headers), options.ids).id;
    return sendProblem(reply, problemOf(new DomainFailure("NOT_FOUND", "no such route"), correlationId));
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    const correlationId = correlationIdOf(singleValued(request.headers), options.ids).id;
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendProblem(reply, problemOf(new DomainFailure("INVALID_REQUEST", "body too large", { reason: "BODY_TOO_LARGE" }), correlationId));
    }
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH" || code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return sendProblem(reply, problemOf(new DomainFailure("INVALID_REQUEST", "unparseable body", { reason: "CONTENT_TYPE_UNSUPPORTED" }), correlationId));
    }
    if (error instanceof DomainFailure) return sendProblem(reply, problemOf(error, correlationId));
    sink(correlationId, error);
    return sendProblem(reply, internalProblem(correlationId));
  });

  for (const handler of Object.values(options.handlers) as ReadonlyArray<CommandHandler<unknown, unknown>>) {
    registerCommand(app, options, handler, sink);
  }
  return app;
}

function registerCommand<Body, View>(app: FastifyInstance, options: ApiServerOptions, handler: CommandHandler<Body, View>, sink: (correlationId: string, error: unknown) => void): void {
  const spec = handler.spec;
  if (!isServedCommand(spec.id)) throw new Error(`${spec.id} has a handler but no declared response contract (COMMAND_RESPONSES of @kauro/application)`);
  app.route<{ Params: Record<string, string>; Body: string | undefined; Reply: CommandReply<View> }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    // the operation id is the registry command name (commands.json), as the OpenAPI document names it
    config: { responses: commandRouteResponses(spec.id, spec.name) },
    // manual 10 decides the content type before the byte size: the headers are admitted before the body is read, so the
    // parser's body limit cannot answer first for a request whose content type already refuses it
    onRequest: async (request, reply) => {
      const early = admitHeaders(singleValued(request.headers), options.ids);
      if (early !== null) return sendProblem(reply, early.problem);
      return undefined;
    },
    handler: async (request, reply) => {
      const headers = singleValued(request.headers);
      const bodyText = typeof request.body === "string" ? request.body : null;
      const raw: RawRequest = {
        headers,
        params: request.params,
        bodyText,
        bodyBytes: bodyText === null ? 0 : Buffer.byteLength(bodyText, "utf8"),
      };
      const admission = admitStructure(spec, raw, options.validator, options.ids, options.clock);
      if (admission.kind === "PROBLEM") return sendProblem(reply, admission.problem);
      const subject = await options.authenticator.authenticate(headers);
      if (!subject) return sendProblem(reply, unauthenticatedProblem(admission.admission.correlationId));
      const envelope: CommandEnvelope<Body> = envelopeOf(spec.id as CommandId, options.environment, admission.admission, subject);
      let result: CommandResult<View>;
      try {
        result = await handler.execute(envelope);
      } catch (error) {
        sink(envelope.correlationId, error);
        return sendProblem(reply, internalProblem(envelope.correlationId));
      }
      reply.header(HEADERS.correlationId, envelope.correlationId);
      switch (result.kind) {
        case "COMPLETED": {
          const body: CompletedResponse<View> = { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view };
          return reply.code(result.status).type(HEADERS.contentType).send(body);
        }
        case "ACCEPTED": {
          const body: AcceptedResponse = { kind: "ACCEPTED", operationId: result.operationId, state: result.state, statusPath: result.statusPath, pollAfterSeconds: result.pollAfterSeconds };
          return reply.code(result.status).type(HEADERS.contentType).send(body);
        }
        case "CONFLICT":
        case "REJECTED":
        case "UNAVAILABLE":
          return sendProblem(reply, result.problem);
      }
    },
  });
}
