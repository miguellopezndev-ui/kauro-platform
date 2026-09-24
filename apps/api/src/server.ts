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
  SchemaValidator,
} from "@kauro/application";
import { HEADERS, REQUEST_LIMITS, admitStructure, correlationIdOf, envelopeOf, internalProblem, problemOf, unauthenticatedProblem } from "@kauro/application";
import type { Clock, Environment, IdGenerator } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { Authenticator } from "./authenticator.js";

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

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: REQUEST_LIMITS.jsonBytes, exposeHeadRoutes: false });
  const sink = options.onInternalError ?? defaultInternalErrorSink;

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
  app.route<{ Params: Record<string, string>; Body: string | undefined; Reply: CommandReply<View> }>({
    method: spec.method,
    url: fastifyPath(spec.path),
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
