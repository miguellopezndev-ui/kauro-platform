/**
 * The Kauro HTTP API (10 "API, contracts and integration seams"): Fastify routes for the seven B06 commands, the six B07
 * source-lifecycle commands and the support package's CMD044 (B11 W4), registered from the command specs of @kauro/application
 * (method, path, scope), with the admission pipeline of manual 10 (content type, byte size, strict JSON, closed schema, envelope
 * headers, authenticated subject) in front of every handler, typed replies (CompletedResponse / AcceptedResponse / Problem) and the
 * safe problem translation of every failure (opaque INTERNAL_ERROR by correlation id; 07 "Command outcomes"); the manual-10 reads,
 * the source reads and the support reads; the selection manifest intake (B07 D-SEL-2: a document stored once per content, STORED
 * 201 or 200); plus the liveness and readiness probes outside /api/v1 (health.ts).
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
import { createHmac, randomBytes } from "node:crypto";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import { isIPv4, isIPv6, type Socket } from "node:net";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { CommandId, Sha256Hex } from "@kauro/contracts";
import type {
  AcceptedResponse,
  ServiceAuthenticator,
  ServiceCommandRequest,
  AuditHandlers,
  AuditIntakeHandlers,
  AuditReadHandlers,
  B06Handlers,
  B07Handlers,
  CommandEnvelope,
  CommandHandler,
  CommandResult,
  CommandSpec,
  CommerceCommandHandler,
  CommerceReadHandler,
  CommercialCommandHandler,
  CommercialReadHandler,
  CompletedResponse,
  ExecutionHandlers,
  ExecutionReadHandlers,
  IntakeHandler,
  IntakeResult,
  Problem,
  RawRequest,
  ReadHandler,
  ReadHandlers,
  ReadRequest,
  ReadResult,
  ReadSpec,
  RouteResponses,
  SchemaValidator,
  SourceIntakeHandlers,
  SourceReadHandlers,
  SupportHandlers,
  UnauthenticatedRequest,
  RequestAuthority,
} from "@kauro/application";
import {
  HEADERS,
  PRIVATE_CACHE_POLICY,
  REQUEST_LIMITS,
  ResponseContractViolation,
  UNROUTED_RESPONSES,
  admitDocument,
  admitHeaders,
  admitRead,
  admitStructure,
  checkReply,
  commandRouteResponses,
  commerceCommandRouteResponses,
  commerceReadRouteResponses,
  commercialCommandRouteResponses,
  commercialReadRouteResponses,
  correlationIdOf,
  envelopeOf,
  internalProblem,
  intakeRouteResponses,
  isServedCommand,
  isServedCommerceCommand,
  isServedCommerceRead,
  isServedCommercialCommand,
  isServedCommercialRead,
  problemOf,
  readRouteResponses,
  repeatedHeaderNames,
  responseIntegrityProblem,
} from "@kauro/application";
import type { Clock, CorrelationId, Environment, FailureReason, IdGenerator } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import { authenticationOf, type Authentication, type AuthenticationRequest, type Authenticator } from "./authenticator.js";
import { requestAuthorityOf } from "./request-authority.js";
import { sendProblem, singleValued } from "./http.js";
import { registerSessionRoutes, type SessionRoutesOptions } from "./sessions.js";
import { registerPublicRoutes, type PublicApiOptions } from "./public-routes.js";
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
  /**
   * The seven B06 commands, the six B07 source-lifecycle commands (B07 design §11), the two B08 execution commands and the four B08
   * audit commands (B08 design §12), and the support package's CMD044 (B11 W4).
   */
  readonly handlers: B06Handlers & B07Handlers & ExecutionHandlers & AuditHandlers & SupportHandlers;
  /**
   * The manual-10 agency, team, client and project reads (re-check finding N16), the two support reads (B11 W4), the source reads
   * (B07 design §9.1), GetJob and GetAudit (B08 design §12).
   */
  readonly reads: ReadHandlers & SourceReadHandlers & ExecutionReadHandlers & AuditReadHandlers;
  /** The document intakes: the selection manifest (B07 D-SEL-2) and the decision artifact (B08 D8-PLAN-1). */
  readonly intakes: SourceIntakeHandlers & AuditIntakeHandlers;
  /**
   * The served routes of the payments workflow (package B09; docs/design/B09-payments-fiscal.md §10, D-REQ-B7): its commands and its
   * reads, each registered with its own admission spec and its declared replies (the 202 ACCEPTED envelope of a provider effect
   * included), under the same admission pipeline, send guard and route inventory as the B06 routes.
   */
  readonly commerce?: {
    readonly commands: ReadonlyArray<CommerceCommandHandler<unknown, unknown>>;
    readonly reads: ReadonlyArray<CommerceReadHandler<unknown>>;
  };
  /**
   * The served routes of the agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md §13): each
   * command registered with its own admission spec and its declared replies, under the same admission pipeline, send guard and route
   * inventory as the B06 and B09 routes. The command lanes of B10 each add the commands they serve (COMMERCIAL_SERVED_COMMAND_IDS).
   */
  readonly commercial?: {
    readonly commands: ReadonlyArray<CommercialCommandHandler<unknown, unknown>>;
    /** The served B10 reads (GetCommissionStatement; COMMERCIAL_SERVED_READ_IDS), each with its admission spec and declared replies. */
    readonly reads?: ReadonlyArray<CommercialReadHandler<unknown>>;
    /**
     * The verified service identities of the operations service (package B18, decision B18-OPS-1): a command whose handler declares a
     * `service` execution (CMD056, CMD059; role OPERATIONS_SERVICE_OR_OWNER) first tries them; a request that carries none is the owner's.
     */
    readonly serviceAuthenticator?: ServiceAuthenticator;
  };
  readonly authenticator: Authenticator;
  /**
   * Answers a structurally admitted command request that carried no authenticated subject: records the durable anonymous
   * DENY fact and returns the problem (AUTHENTICATION_REQUIRED, or the failure that kept the fact from being recorded).
   * The composition root binds the runtime's `refuseUnauthenticated`.
   */
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
  /**
   * Answers a request whose credentials the authenticator refused as such (B11 D-AUTH-5: AMBIGUOUS_CREDENTIALS, ORIGIN_REJECTED,
   * CSRF_TOKEN_INVALID): records the durable anonymous DENY fact and returns the problem. The composition root binds the
   * runtime's refuseAnonymously; without it the refusal is answered without a fact.
   */
  readonly refuseCredentials?: (action: string, request: UnauthenticatedRequest, failure: DomainFailure) => Promise<Problem>;
  /** The routes of the browser session boundary (B11 W2), registered when the boundary is bound. */
  readonly sessions?: Omit<SessionRoutesOptions, "validator" | "refuseUnauthenticated" | "refuseCredentials" | "sink">;
  /** The two public routes of B11 W5b (no authentication), registered when bound; without it neither route exists. */
  readonly publicApi?: PublicApiOptions;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Liveness and readiness (health.ts): the database report, the build's schema version and the not-ready sink. */
  readonly health: Omit<HealthOptions, "draining">;
  /** Fastify logger configuration; off by default (tests), a pino configuration in a deployment. */
  readonly logger?: ApiLogger;
  /** Receives every unexpected exception with its correlation id; the default writes the safe classification to stderr. */
  readonly onInternalError?: (correlationId: string, error: unknown) => void;
  /** Receives the cause of a CAPACITY_UNAVAILABLE answer of a public route by correlation id; the internal-error sink by default. */
  readonly onUnavailable?: (correlationId: string, cause: unknown) => void;
  /**
   * Proxy hops in front of this process whose X-Forwarded-For entries are trusted (14 "Initial architecture": the external
   * HTTPS load balancer in front of Cloud Run). 0 — the default — trusts none: the socket peer is the client and a
   * client-written X-Forwarded-For changes nothing.
   */
  readonly trustedProxyHops?: number;
  /** Key of the client-address hash; a fresh random key per process when absent (the admission limiter is process-local). */
  readonly clientAddressKey?: Uint8Array;
  readonly limits?: HttpLimits;
  /**
   * Registers the payment service's routes (package B09, stage-2 mandate M3: CMD030, CMD033, CMD034; payments/routes.ts) on the
   * server, with the same transport pieces the command routes use (the problem sender, the single-valued header view, the
   * internal-error sink and the framework-error answer). Every route declares its replies and passes the send guard.
   */
  readonly paymentRoutes?: (app: FastifyInstance, kit: RouteKit) => void;
  /**
   * Registers the commission group's service routes (package B10, mandate B10-STATEMENTS-PAYOUTS: CMD051, CMD053; commissions/routes.ts)
   * with the same transport pieces as the payment routes. Every route declares its replies and passes the send guard.
   */
  readonly commissionRoutes?: (app: FastifyInstance, kit: RouteKit) => void;
  /**
   * Registers the agency app's operational commands (package B11 lane A1: CMD101 SetBuyerType; agency-app-routes.ts) with the same
   * transport pieces as the payment routes. Every route declares its replies and passes the send guard.
   */
  readonly agencyRoutes?: (app: FastifyInstance, kit: RouteKit) => void;
}

/** The transport pieces a route registered outside this module answers with (package B09's payment routes). */
export interface RouteKit {
  sendProblem(reply: FastifyReply, problem: Problem): FastifyReply;
  singleValued(headers: FastifyRequest["headers"]): Readonly<Record<string, string | undefined>>;
  readonly sink: (correlationId: string, error: unknown) => void;
  answerFrameworkError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply;
  /**
   * The command boundary's authentication of a person (PV1R-01): the request-aware authenticator with the request's ACTUAL method, so an
   * unsafe cookie request meets the Origin, Sec-Fetch-Site and session CSRF rule, and refused credentials (AMBIGUOUS_CREDENTIALS,
   * ORIGIN_REJECTED, CSRF_TOKEN_INVALID) keep their typed refusal with its anonymous fact; no subject is the anonymous denial. Decided
   * before any handler effect or journal reservation.
   */
  subjectOrRefusal(request: FastifyRequest, headers: Readonly<Record<string, string | undefined>>, action: string, refused: UnauthenticatedRequest): Promise<{ readonly kind: "SUBJECT"; readonly subject: Extract<Authentication, { kind: "SUBJECT" }>["subject"] } | { readonly kind: "PROBLEM"; readonly problem: Problem }>;
  /** The same authenticator's answer for a request as it stands now (a re-authentication at a later guard instant). */
  authentication(request: AuthenticationRequest): Promise<Authentication>;
  /** The request's credential authority for an effect it authorizes (rule 16): the route releases it once its work returned. */
  requestAuthority(request: FastifyRequest, headers: Readonly<Record<string, string | undefined>>, userId: string): RequestAuthority;
}

export type CommandReply<View> = CompletedResponse<View> | AcceptedResponse | Problem;

/** `/api/v1/plans/{planId}/approve` → `/api/v1/plans/:planId/approve`. */
export function fastifyPath(cataloguePath: string): string {
  return cataloguePath.replace(/\{([a-zA-Z]+)\}/g, ":$1");
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
 * INTEGRITY_FAILURE; its violation goes to the sink under the request's correlation id. The one answer written without a
 * Fastify reply — the problem of an error below HTTP (clientErrorHandler) — is checked against the same contract before it
 * is written.
 */
function installResponseGuard(app: FastifyInstance, options: ApiServerOptions, sink: (correlationId: string, error: unknown) => void): void {
  const checked = new WeakSet<FastifyReply>();

  const refuse = (request: FastifyRequest, reply: FastifyReply, violation: ResponseContractViolation): Problem => {
    // the request's correlation id: the request id, resolved once (E-CORR-1), which every answer's header and problem carry
    const correlationId = request.id;
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
    if (payload === undefined || payload === null || payload === "") {
      // a reply without a body (204): checked against its declaration like any other — declared without a body, no media type
      try {
        checkReply(options.validator, responses, reply.statusCode, headerText(reply.getHeader("content-type")), undefined);
        return payload;
      } catch (e) {
        const violation = e instanceof ResponseContractViolation ? e : new ResponseContractViolation(responses.operationId, reply.statusCode, null, "the response check could not run", [], { cause: e });
        return JSON.stringify(refuse(request, reply, violation));
      }
    }
    const violation = new ResponseContractViolation(responses.operationId, reply.statusCode, null, "the reply was sent without passing the response check (not a JSON object body)");
    return JSON.stringify(refuse(request, reply, violation));
  });
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
      // a framework error (an undecodable URL, an asynchronous constraint) is answered before routing, outside the request
      // life cycle whose end Fastify logs, so its completion line is written here once the answer is finished: every request
      // is found in the log by its correlation id with what it was answered (R45, re-check finding N8)
      reply.raw.once("finish", () => request.log.info({ res: reply, responseTime: reply.elapsedTime }, "request completed"));
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
      let problem = problemFor(reason, correlationId);
      try {
        // the send guard's rule holds below HTTP as well: a reply its contract refuses is never written (R23)
        checkReply(options.validator, UNROUTED_RESPONSES, problem.status, HEADERS.problemContentType, problem);
      } catch (violation) {
        sink(correlationId, violation);
        problem = responseIntegrityProblem(correlationId);
      }
      app.log.info({ correlationId, errorCode: error.code, reason }, "request refused below HTTP: answered with a problem and closed");
      const body = JSON.stringify(problem);
      if (socket.writable) {
        socket.write(
          `HTTP/1.1 ${problem.status} ${STATUS_CODES[problem.status] ?? "Error"}\r\nContent-Type: ${HEADERS.problemContentType}; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
            `X-Correlation-Id: ${correlationId}\r\nCache-Control: ${PRIVATE_CACHE_POLICY}\r\nConnection: close\r\n\r\n${body}`,
        );
      }
      socket.destroy(error);
    },
  });

  // every route declares the replies it may send, and every reply is checked against that declaration before it is sent (R23)
  recordRouteInventory(app);
  installResponseGuard(app, options, sink);

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
    // every reply is private: success views, problems and probes alike are never stored by any cache (N15)
    reply.header(HEADERS.cacheControl, PRIVATE_CACHE_POLICY);
    // once shutdown began, no connection is kept alive past its current answer: close() then ends with the in-flight requests
    if (draining) reply.header("connection", "close");
    return payload;
  });

  app.setNotFoundHandler((request, reply) => sendProblem(reply, problemOf(new DomainFailure("NOT_FOUND", "no such route"), request.id)));
  app.setErrorHandler((error: unknown, request, reply) => answerFrameworkError(error, request, reply));

  registerHealthRoutes(app, { ...options.health, draining: () => draining });
  for (const handler of Object.values(options.handlers) as ReadonlyArray<CommandHandler<unknown, unknown>>) {
    const spec = handler.spec;
    if (!isServedCommand(spec.id)) throw new Error(`${spec.id} has a handler but no declared response contract (COMMAND_RESPONSES of @kauro/application)`);
    // the operation id is the registry command name (commands.json), as the OpenAPI document names it
    registerCommand(app, options, spec, commandRouteResponses(spec.id, spec.name), (envelope) => handler.execute(envelope), sink, hashAddress);
  }
  for (const handler of Object.values(options.reads) as ReadonlyArray<ReadHandler<unknown>>) {
    registerRead(app, options, handler.spec, readRouteResponses(handler.spec.operationId), (request) => handler.execute(request), sink);
  }
  for (const handler of Object.values(options.intakes) as ReadonlyArray<IntakeHandler<unknown>>) {
    registerIntake(app, options, handler, sink);
  }
  // package B09: each served command with the spec its admission reads and its declared replies (202 for a provider effect)
  for (const handler of options.commerce?.commands ?? []) {
    const spec = handler.spec;
    if (!isServedCommerceCommand(spec.id)) throw new Error(`${spec.id} has a handler but is not a served B09 command (COMMERCE_SERVED_COMMAND_IDS of @kauro/application)`);
    registerCommand(app, options, handler.admission, commerceCommandRouteResponses(spec.id), (envelope) => handler.execute(envelope), sink, hashAddress);
  }
  for (const handler of options.commerce?.reads ?? []) {
    const spec = handler.spec;
    if (!isServedCommerceRead(spec.operationId)) throw new Error(`${spec.operationId} has a handler but is not a served B09 read (COMMERCE_SERVED_READ_IDS of @kauro/application)`);
    registerRead(app, options, handler.admission, commerceReadRouteResponses(spec.operationId), (request) => handler.execute(request), sink);
  }
  // package B10: each served commercial command with the spec its admission reads and the replies its closed catalogue declares
  for (const handler of options.commercial?.commands ?? []) {
    const spec = handler.spec;
    if (!isServedCommercialCommand(spec.id)) throw new Error(`${spec.id} has a handler but is not a served B10 command (COMMERCIAL_SERVED_COMMAND_IDS of @kauro/application)`);
    registerCommand(app, options, handler.admission, commercialCommandRouteResponses(spec.id), (envelope) => handler.execute(envelope), sink, hashAddress, handler.service !== undefined && options.commercial?.serviceAuthenticator !== undefined ? { authenticator: options.commercial.serviceAuthenticator, run: handler.service } : undefined);
  }
  for (const handler of options.commercial?.reads ?? []) {
    if (!isServedCommercialRead(handler.operationId)) throw new Error(`${handler.operationId} has a handler but is not a served B10 read (COMMERCIAL_SERVED_READ_IDS of @kauro/application)`);
    registerRead(app, options, handler.admission, commercialReadRouteResponses(handler.operationId), (request) => handler.execute(request), sink);
  }
  const kit: RouteKit = {
    sendProblem,
    singleValued,
    sink,
    answerFrameworkError,
    subjectOrRefusal: (request, headers, action, refused) => subjectOrRefusal(options, request, headers, action, refused, sink),
    authentication: (request) => authenticationOf(options.authenticator, request),
    requestAuthority: (request, headers, userId) => requestAuthorityOf(options.authenticator, { method: request.method, headers }, userId),
  };
  options.paymentRoutes?.(app, kit);
  options.commissionRoutes?.(app, kit);
  options.agencyRoutes?.(app, kit);
  if (options.sessions !== undefined) {
    registerSessionRoutes(app, { ...options.sessions, validator: options.validator, refuseUnauthenticated: options.refuseUnauthenticated, refuseCredentials: refusalOfCredentials(options), sink });
  }
  if (options.publicApi !== undefined) {
    registerPublicRoutes(app, {
      ...options.publicApi,
      validator: options.validator,
      clock: options.clock,
      ids: options.ids,
      clientNetwork: (address) => (address === undefined || address === "" ? null : clientNetworkOf(address)),
      sink,
      onUnavailable: options.onUnavailable ?? sink,
    });
  }
  return app;
}

/** The answer to refused credentials: the bound refusal (with its durable fact), or the problem alone. */
function refusalOfCredentials(options: ApiServerOptions): (action: string, request: UnauthenticatedRequest, failure: DomainFailure) => Promise<Problem> {
  return options.refuseCredentials ?? (async (_action, request, failure) => problemOf(failure, request.correlationId));
}

/**
 * The subject of a request, or the answer that refuses it: refused credentials (their anonymous fact), or no subject at all (the
 * anonymous fact of an unauthenticated request). An authenticator's failure to decide (its store unavailable) is its failure.
 */
async function subjectOrRefusal(
  options: ApiServerOptions,
  request: FastifyRequest,
  headers: Readonly<Record<string, string | undefined>>,
  action: string,
  refused: UnauthenticatedRequest,
  sink: (correlationId: string, error: unknown) => void,
): Promise<{ readonly kind: "SUBJECT"; readonly subject: Extract<Authentication, { kind: "SUBJECT" }>["subject"] } | { readonly kind: "PROBLEM"; readonly problem: Problem }> {
  let authentication: Authentication;
  try {
    authentication = await authenticationOf(options.authenticator, { method: request.method, headers });
  } catch (error) {
    if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return { kind: "PROBLEM", problem: problemOf(error, refused.correlationId) };
    sink(refused.correlationId, error);
    return { kind: "PROBLEM", problem: internalProblem(refused.correlationId) };
  }
  if (authentication.kind === "SUBJECT") return { kind: "SUBJECT", subject: authentication.subject };
  try {
    return { kind: "PROBLEM", problem: authentication.kind === "REFUSED" ? await refusalOfCredentials(options)(action, refused, authentication.failure) : await options.refuseUnauthenticated(action, refused) };
  } catch (error) {
    sink(refused.correlationId, error);
    return { kind: "PROBLEM", problem: internalProblem(refused.correlationId) };
  }
}

/** The body of an intake's 201 or 200 (the STORED envelope of @kauro/application's intake response schemas). */
export interface StoredReply<View> {
  readonly kind: "STORED";
  readonly data: View;
}

/**
 * A document intake (B07 D-SEL-2): POST with a JSON document and no idempotency key — the intake is content-idempotent, so the
 * same document again answers the stored record (200) and a new one is stored (201). Admission as a command's (repeated envelope
 * header and content type from the head before the body is read; then size, strict UTF-8 JSON and the closed document schema; path
 * ids; the agency selector), then the authenticated subject — refused with its anonymous fact like every route — then the handler,
 * whose access decision (the reads' ACTIVE live membership and the intake's own role) belongs to @kauro/application.
 */
function registerIntake<View>(app: FastifyInstance, options: ApiServerOptions, handler: IntakeHandler<View>, sink: (correlationId: string, error: unknown) => void): void {
  const spec = handler.spec;
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined; Reply: StoredReply<View> | Problem }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses: intakeRouteResponses(spec.operationId) },
    onRequest: async (request, reply) => {
      const early = admitHeaders({ headers: singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return sendProblem(reply, early.problem);
      return undefined;
    },
    handler: async (request, reply) => {
      const headers = singleValued(request.headers);
      const admission = admitDocument(
        spec,
        {
          headers,
          repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders),
          correlationId: request.id as CorrelationId,
          params: request.params,
          body: Buffer.isBuffer(request.body) ? request.body : null,
          clientAddressHash: null,
        },
        options.validator,
      );
      if (admission.kind === "PROBLEM") return sendProblem(reply, admission.problem);
      const { correlationId, agencyId, path, body } = admission.admission;
      // refused credentials (B11 D-AUTH-5: an ambiguous credential, or an unsafe cookie request failing the CSRF rule) and a request
      // without a subject are refused with their anonymous fact, as a command's are, before the handler runs
      const authenticated = await subjectOrRefusal(options, request, headers, spec.action, { correlationId, agencyId }, sink);
      if (authenticated.kind === "PROBLEM") return sendProblem(reply, authenticated.problem);
      const subject = authenticated.subject;
      let result: IntakeResult<View>;
      try {
        result = await handler.execute({ correlationId, subject, agencyId, path, body });
      } catch (error) {
        sink(correlationId, error);
        return sendProblem(reply, internalProblem(correlationId));
      }
      if (result.kind === "PROBLEM") return sendProblem(reply, result.problem);
      const stored: StoredReply<View> = { kind: "STORED", data: result.view };
      return reply.code(result.created ? 201 : 200).type(HEADERS.contentType).send(stored);
    },
  });
}

/**
 * A manual-10 read (N16): GET, no body, no idempotency key. Admission (repeated envelope header, path ids, the closed query, the
 * agency selector), then the authenticated subject — a request without one is refused with its anonymous fact like a
 * command's — then the read, whose access decision and projection belong to @kauro/application (queries/reads). The reply is
 * the READ envelope, validated against the route's declared schema before it is sent like every reply.
 */
function registerRead<View>(
  app: FastifyInstance,
  options: ApiServerOptions,
  spec: ReadSpec<string>,
  responses: RouteResponses,
  execute: (request: ReadRequest) => Promise<ReadResult<View>>,
  sink: (correlationId: string, error: unknown) => void,
): void {
  app.route<{ Params: Record<string, string>; Querystring: Record<string, unknown>; Reply: ReadReply<View> | Problem }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses },
    handler: async (request, reply) => {
      const headers = singleValued(request.headers);
      const admission = admitRead(spec, {
        headers,
        repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders),
        correlationId: request.id as CorrelationId,
        params: request.params,
        query: request.query,
      });
      if (admission.kind === "PROBLEM") return sendProblem(reply, admission.problem);
      const correlationId = admission.correlationId;
      const authenticated = await subjectOrRefusal(options, request, headers, spec.action, { correlationId, agencyId: admission.agencyId }, sink);
      if (authenticated.kind === "PROBLEM") return sendProblem(reply, authenticated.problem);
      const subject = authenticated.subject;
      let result: ReadResult<View>;
      try {
        result = await execute({ correlationId, subject, agencyId: admission.agencyId, path: admission.path, query: admission.query });
      } catch (error) {
        sink(correlationId, error);
        return sendProblem(reply, internalProblem(correlationId));
      }
      if (result.kind === "PROBLEM") return sendProblem(reply, result.problem);
      const body: ReadReply<View> = { kind: "READ", data: result.view };
      return reply.code(200).type(HEADERS.contentType).send(body);
    },
  });
}

/** The body of a read's 200 (the READ envelope of @kauro/application's read response schemas). */
export interface ReadReply<View> {
  readonly kind: "READ";
  readonly data: View;
}

function registerCommand<Body, View>(
  app: FastifyInstance,
  options: ApiServerOptions,
  spec: CommandSpec<Body>,
  responses: RouteResponses,
  execute: (envelope: CommandEnvelope<Body>) => Promise<CommandResult<View>>,
  sink: (correlationId: string, error: unknown) => void,
  hashAddress: (ip: string | undefined) => Sha256Hex | null,
  /** The second principal of a dual-principal route (OPERATIONS_SERVICE_OR_OWNER): a verified service identity runs `run`, else the person's path. */
  service?: { readonly authenticator: ServiceAuthenticator; readonly run: (request: ServiceCommandRequest<Body>) => Promise<CommandResult<View>> },
): void {
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined; Reply: CommandReply<View> }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses },
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
      const answer = (result: CommandResult<View>): FastifyReply => {
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
      };
      // the operations service, when it presented a verified service identity (a person's credential is no service identity: null)
      if (service !== undefined) {
        const identity = await service.authenticator.authenticate(headers);
        if (identity !== null) {
          const correlationId = admission.admission.correlationId;
          try {
            return answer(await service.run({ correlationId, idempotencyKey: admission.admission.idempotencyKey, identity, path: admission.admission.path, body: admission.admission.body as Body }));
          } catch (error) {
            sink(correlationId, error);
            return sendProblem(reply, internalProblem(correlationId));
          }
        }
      }
      // the refusal of an unauthenticated consequential command — or of refused credentials (B11 D-AUTH-5: decided here, before
      // the journal is reserved, so no idempotency key is consumed) — is a durable fact before it is an answer (08 "Audit events")
      const authenticated = await subjectOrRefusal(options, request, headers, spec.id as CommandId, { correlationId: admission.admission.correlationId, agencyId: admission.admission.agencyId }, sink);
      if (authenticated.kind === "PROBLEM") return sendProblem(reply, authenticated.problem);
      const subject = authenticated.subject;
      // the request's credential, fenced by an effect inside its own unit of work and judged at its COMMIT (rule 16, PV1R-07 r4)
      const authority = requestAuthorityOf(options.authenticator, { method: request.method, headers }, subject.identity.userId);
      const envelope: CommandEnvelope<Body> = { ...envelopeOf(spec.id as CommandId, options.environment, admission.admission, subject), authority };
      let result: CommandResult<View>;
      try {
        result = await execute(envelope);
      } catch (error) {
        sink(envelope.correlationId, error);
        return sendProblem(reply, internalProblem(envelope.correlationId));
      }
      return answer(result);
    },
  });
}
