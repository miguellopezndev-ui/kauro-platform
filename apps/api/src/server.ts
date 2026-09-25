/**
 * The Kauro HTTP API (10 "API, contracts and integration seams"): Fastify routes for the seven B06 commands, registered from
 * the command specs of @kauro/application (method, path, scope), with the admission pipeline of manual 10 (content type, byte
 * size, strict JSON, closed schema, envelope headers, authenticated subject) in front of every handler, typed replies
 * (CompletedResponse / AcceptedResponse / Problem) and the safe problem translation of every failure (opaque INTERNAL_ERROR by
 * correlation id; 07 "Command outcomes"), plus the liveness and readiness probes outside /api/v1 (health.ts).
 *
 * Fastify's built-in JSON parser and Ajv are not used for command bodies: the body reaches the route as raw bytes and goes
 * through the strict UTF-8 decoding, the strict parser and the closed validator of @kauro/application, so an invalid byte, a
 * duplicate key, an unknown member, a string where a boolean is expected or an impossible date is refused before any
 * database work (R2-058, R2-059, S093, review R40).
 *
 * Transport decisions of the review (docs/design/B06-review/E-transport-operability.md):
 *  - every request's correlation id is resolved once, as the Fastify request id (genReqId), so the request log lines, the
 *    answer header, the problem body, the diagnostics lines and the durable records carry the same value; a malformed client
 *    value is never echoed nor refused (R28, R45);
 *  - every answer the framework itself would produce — an undecodable URL, a parameter over the router's length, an HTTP
 *    parser error, a request timeout, a body whose length is not the declared one — is a problem+json with a correlation
 *    id and no echoed input (R39, R40);
 *  - a repeated single-valued envelope header is refused before its first value is used (R41);
 *  - the client address, taken from the socket or from the configured number of trusted proxy hops, reaches the admission
 *    limiter as a keyed SHA-256 of its network (R34);
 *  - requests and idle sockets are bounded by the request and connection timeouts (R36);
 *  - once shutdown begins every answer carries Connection: close and new requests on open connections are 503 problems, so
 *    close() completes when the in-flight requests do, not when keep-alive sockets time out (R35).
 */
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIPv4, isIPv6, type Socket } from "node:net";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CommandId, Sha256Hex } from "@kauro/contracts";
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
import { HEADERS, REQUEST_LIMITS, admitHeaders, admitStructure, correlationIdOf, envelopeOf, internalProblem, problemOf, repeatedHeaderNames, unauthenticatedProblem } from "@kauro/application";
import type { Clock, CorrelationId, Environment, FailureReason, IdGenerator } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { Authenticator } from "./authenticator.js";
import { HEALTH_PATHS, registerHealthRoutes, type HealthOptions } from "./health.js";

/** Request and socket deadlines (10 "Request envelope": a reverse proxy's limit is not the only guard; review R36). */
export interface HttpLimits {
  /** Whole-request deadline, headers and body (Node's requestTimeout); a request still arriving then is answered and closed. */
  readonly requestTimeoutMs: number;
  /** Socket inactivity deadline (Node's server timeout): a socket silent this long is destroyed. */
  readonly connectionTimeoutMs: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = Object.freeze({ requestTimeoutMs: 30_000, connectionTimeoutMs: 60_000 });

/** Fastify's pino logger: off, on (stdout), or on with a caller-owned line sink (tests read the lines). */
export type ApiLogger = boolean | { readonly level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace"; readonly stream: { write(line: string): void } };

export interface ApiServerOptions {
  readonly environment: Environment;
  readonly handlers: B06Handlers;
  readonly authenticator: Authenticator;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Liveness and readiness (health.ts): the database report, the build's schema version and the not-ready sink. */
  readonly health: Omit<HealthOptions, "draining">;
  /** Fastify logger configuration; off by default (tests), a pino configuration in a deployment. */
  readonly logger?: ApiLogger;
  /** Receives every unexpected exception with its correlation id; the default writes the safe classification to stderr. */
  readonly onInternalError?: (correlationId: string, error: unknown) => void;
  /**
   * Proxy hops in front of this process whose X-Forwarded-For entries are trusted (14 "Initial architecture": the external
   * HTTPS load balancer in front of Cloud Run). 0 — the default — trusts none: the socket peer is the client and a
   * client-written X-Forwarded-For changes nothing.
   */
  readonly trustedProxyHops?: number;
  /** Key of the client-address hash; a fresh random key per process when absent (the admission limiter is process-local). */
  readonly clientAddressKey?: Uint8Array;
  readonly limits?: HttpLimits;
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

/**
 * The network a client address stands for in the per-address admission window: an IPv4 address as is (an IPv4-mapped IPv6
 * address as its IPv4 form), an IPv6 address as its /64 prefix — one subscriber is routinely handed a whole /64, so keying
 * on the full address would let a single client rotate past the limit.
 */
export function clientNetworkOf(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped && isIPv4(mapped[1] as string)) return mapped[1] as string;
  if (!isIPv6(address)) return address;
  const zoneless = address.split("%")[0] as string;
  const [head = "", tail] = zoneless.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill("0"), ...tailGroups];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, "0")).join(":")}::/64`;
}

function problemFor(reason: FailureReason, correlationId: string): Problem {
  return problemOf(new DomainFailure("INVALID_REQUEST", `request refused: ${reason}`, { reason }), correlationId);
}

/** The reason of a Fastify error the transport knows, or null for anything else (answered INTERNAL_ERROR). */
function frameworkReason(error: unknown): FailureReason | null {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return "BODY_TOO_LARGE";
    // the body's length is not the declared Content-Length: the request's framing cannot be trusted (R40)
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
    // the request target is not a decodable URL (R39); routing never happened, so no path segment is named
    case "FST_ERR_BAD_URL":
      return "REQUEST_MALFORMED";
    // a path parameter longer than the router admits cannot be an id (every parameter of every route is one)
    case "FST_ERR_MAX_PARAM_LENGTH":
      return "PATH_ID_INVALID";
    default:
      return null;
  }
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  const sink = options.onInternalError ?? defaultInternalErrorSink;
  const limits = options.limits ?? DEFAULT_HTTP_LIMITS;
  const hops = options.trustedProxyHops ?? 0;
  if (!Number.isInteger(hops) || hops < 0) throw new RangeError("trustedProxyHops must be a non-negative integer");
  const addressKey = options.clientAddressKey ?? new Uint8Array(randomBytes(32));
  const hashAddress = (ip: string | undefined): Sha256Hex | null =>
    ip === undefined || ip === "" ? null : (createHmac("sha256", addressKey).update(clientNetworkOf(ip), "utf8").digest("hex") as Sha256Hex);
  let draining = false;

  const answerFrameworkError = (error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply => {
    if (request.raw.socket?.destroyed === true) {
      // the connection is gone before the request completed — the request timeout closed it (and answered on the socket), or
      // the client went away: not a server fault and nobody to answer; the request log records it under its correlation id
      request.log.info({ errorClass: error instanceof Error ? error.name : typeof error }, "request ended before it was complete: the connection is closed");
      return sendProblem(reply, problemFor("REQUEST_MALFORMED", request.id));
    }
    const reason = frameworkReason(error);
    if (reason !== null) return sendProblem(reply, problemFor(reason, request.id));
    if (error instanceof DomainFailure) return sendProblem(reply, problemOf(error, request.id));
    sink(request.id, error);
    return sendProblem(reply, internalProblem(request.id));
  };

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: REQUEST_LIMITS.jsonBytes,
    exposeHeadRoutes: false,
    // the correlation id is the request id: resolved once from the header (adopted when an `id`, minted otherwise)
    requestIdHeader: false,
    logController: new LogController({ requestIdLogLabel: "correlationId" }),
    genReqId: (req: IncomingMessage) => {
      const given = req.headers[HEADERS.correlationId];
      return correlationIdOf({ [HEADERS.correlationId]: typeof given === "string" ? given : undefined }, options.ids);
    },
    // trust exactly `hops` proxies: the address the nearest untrusted hop reported is the client (the socket peer when 0)
    trustProxy: (_address: string, hop: number) => hop < hops,
    requestTimeout: limits.requestTimeoutMs,
    connectionTimeout: limits.connectionTimeoutMs,
    // Node checks request deadlines every connectionsCheckingInterval (30 s by default); check often enough to honour them
    http: { connectionsCheckingInterval: Math.min(1_000, limits.requestTimeoutMs), headersTimeout: Math.min(60_000, limits.requestTimeoutMs) },
    // a request arriving on an open connection while draining is answered by the hook below with a problem, not Fastify's JSON
    return503OnClosing: false,
    frameworkErrors: (error, request, reply) => {
      answerFrameworkError(error, request, reply);
    },
    // errors below HTTP (parser errors, header overflow, the request timeout): a problem written on the socket, then closed.
    // No request object exists, so the minted correlation id is logged here with the parser's code (a token such as
    // HPE_INVALID_HEADER_TOKEN, never the raw bytes): the answer the client holds is found in the log like any other (R45).
    clientErrorHandler: (error: NodeJS.ErrnoException, socket: Socket) => {
      if (error.code === "ECONNRESET" || socket.destroyed) {
        // the peer reset or already closed the connection: there is no request and nobody to answer
        app.log.debug({ errorCode: error.code }, "connection ended by the peer before a request was read");
        return;
      }
      const correlationId = options.ids.next() as CorrelationId;
      const reason: FailureReason = error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "REQUEST_TIMEOUT" : "REQUEST_MALFORMED";
      const problem = problemFor(reason, correlationId);
      app.log.info({ correlationId, errorCode: error.code, reason }, "request refused below HTTP: answered with a problem and closed");
      const body = JSON.stringify(problem);
      if (socket.writable) {
        socket.write(
          `HTTP/1.1 ${problem.status} Bad Request\r\nContent-Type: ${HEADERS.problemContentType}; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
            `X-Correlation-Id: ${correlationId}\r\nConnection: close\r\n\r\n${body}`,
        );
      }
      socket.destroy(error);
    },
  });

  // every body reaches the route as bytes; admission decides content type, size, UTF-8, syntax and schema in the order of manual 10
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));

  app.addHook("preClose", async () => {
    draining = true;
  });
  app.addHook("onRequest", async (request, reply) => {
    // draining: a new request on a connection that is still open goes elsewhere (the probes report DRAINING themselves)
    if (draining && !HEALTH_PATHS.has(request.routeOptions.url ?? "")) {
      return sendProblem(reply, problemOf(new DomainFailure("CAPACITY_UNAVAILABLE", "the instance is draining", { retryAfterSeconds: 1 }, true), request.id));
    }
    return undefined;
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(HEADERS.correlationId, request.id);
    // once shutdown began, no connection is kept alive past its current answer: close() then ends with the in-flight requests
    if (draining) reply.header("connection", "close");
    return payload;
  });

  app.setNotFoundHandler((request, reply) => sendProblem(reply, problemOf(new DomainFailure("NOT_FOUND", "no such route"), request.id)));
  app.setErrorHandler((error: unknown, request, reply) => answerFrameworkError(error, request, reply));

  registerHealthRoutes(app, { ...options.health, draining: () => draining });
  for (const handler of Object.values(options.handlers) as ReadonlyArray<CommandHandler<unknown, unknown>>) {
    registerCommand(app, options, handler, sink, hashAddress);
  }
  return app;
}

function registerCommand<Body, View>(
  app: FastifyInstance,
  options: ApiServerOptions,
  handler: CommandHandler<Body, View>,
  sink: (correlationId: string, error: unknown) => void,
  hashAddress: (ip: string | undefined) => Sha256Hex | null,
): void {
  const spec = handler.spec;
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined; Reply: CommandReply<View> }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    // manual 10 decides the content type before the byte size: the head is admitted before the body is read, so the parser's
    // body limit cannot answer first for a request whose head already refuses it
    onRequest: async (request, reply) => {
      const early = admitHeaders({ headers: singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return sendProblem(reply, early.problem);
      return undefined;
    },
    handler: async (request, reply) => {
      const headers = singleValued(request.headers);
      const raw: RawRequest = {
        headers,
        repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders),
        correlationId: request.id as CorrelationId,
        params: request.params,
        body: Buffer.isBuffer(request.body) ? request.body : null,
        clientAddressHash: hashAddress(request.ip),
      };
      const admission = admitStructure(spec, raw, options.validator, options.clock);
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
