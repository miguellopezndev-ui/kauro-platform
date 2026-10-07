/**
 * The bank-transfer route's operational routes (Payments V1, lane L-ROUTE; ACH-ROUTE r12 §7.1-§7.3), declared in OPERATIONAL_ROUTES of
 * @kauro/application (api/response-schemas) and documented under `paths`:
 *
 *   POST /api/v1/operations/bank-routes                         configureBankRoute       (KAURO_OWNER)  201
 *   POST /api/v1/operations/bank-routes/{routeId}/verify        verifyBankRoute          (KAURO_OWNER)  200
 *   POST /api/v1/operations/bank-routes/{routeId}/enable        enableBankRoute          (KAURO_OWNER)  200
 *   POST /api/v1/operations/bank-routes/{routeId}/disable       disableBankRoute         (KAURO_OWNER)  200
 *   POST /api/v1/operations/bank-routes/{routeId}/details       replaceBankRouteDetails  (KAURO_OWNER)  200
 *   GET  /api/v1/operations/bank-routes/{routeId}               getBankRoute             (KAURO_OWNER)  200
 *   GET  /api/v1/payment-orders/{orderId}/transfer-instructions getTransferInstructions  (agency member, X-Kauro-Agency) 200
 *
 * Admission of a POST: the envelope headers, the closed request schema, an Idempotency-Key, the path ids; then the person's
 * authentication (none: the anonymous denial, AUTHENTICATION_REQUIRED). Every reply carries Cache-Control: no-store (the server's hook);
 * the instructions never carry an ETag.
 */
import type { BankRouteCollaborators, BankRouteHandlers, BankRouteRequest, CommandResult, CompletedResponse, Problem, SchemaValidator, UnauthenticatedRequest } from "@kauro/application";
import { HEADERS, OPERATIONAL_ROUTES, admitEmptyRequest, admitHeaders, admitOperationalBody, operationalRouteResponses, problemOf, readTransferInstructions, repeatedHeaderNames, type CommerceRequestRuntime } from "@kauro/application";
import type { Clock, CorrelationId, Environment } from "@kauro/domain";
import { DomainFailure, IDEMPOTENCY_KEY, isUuid } from "@kauro/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Authenticator } from "../authenticator.js";
import type { RouteKit } from "../server.js";

export interface BankRouteRouteDependencies {
  readonly handlers: BankRouteHandlers;
  readonly runtime: CommerceRequestRuntime;
  readonly bank: BankRouteCollaborators | null;
  readonly authenticator: Authenticator;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly environment: Environment;
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
}

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function routeOf(operationId: string) {
  const route = OPERATIONAL_ROUTES.find((r) => r.operationId === operationId);
  if (route === undefined) throw new Error(`the operational route ${operationId} is not declared in OPERATIONAL_ROUTES of @kauro/application`);
  return route;
}

const fastifyPath = (path: string): string => path.replace(/\{([a-zA-Z]+)\}/g, ":$1");
const invalid = (reason: "IDEMPOTENCY_KEY_MISSING" | "IDEMPOTENCY_KEY_INVALID" | "PATH_ID_INVALID" | "AGENCY_SELECTOR_INVALID", correlationId: string): Problem =>
  problemOf(new DomainFailure("INVALID_REQUEST", `request refused: ${reason}`, { reason }), correlationId);

function replyOf<View>(kit: RouteKit, r: FastifyReply, result: CommandResult<View>): FastifyReply {
  if (result.kind === "COMPLETED") {
    const body: CompletedResponse<View> = { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view };
    return r.code(result.status).type(HEADERS.contentType).send(body);
  }
  if (result.kind === "ACCEPTED") throw new Error("a bank route command never answers ACCEPTED");
  return kit.sendProblem(r, result.problem);
}

export function registerBankRouteRoutes(app: FastifyInstance, kit: RouteKit, deps: BankRouteRouteDependencies): void {
  const pathIds = (path: string, params: Readonly<Record<string, string>>, correlationId: string): Readonly<Record<string, string>> | Problem => {
    const out: Record<string, string> = {};
    for (const name of path.match(/\{([a-zA-Z]+)\}/g)?.map((m) => m.slice(1, -1)) ?? []) {
      const value = params[name];
      if (value === undefined || !UUID_PATH.test(value)) return invalid("PATH_ID_INVALID", correlationId);
      out[name] = value;
    }
    return out;
  };
  const isProblem = (v: unknown): v is Problem => typeof v === "object" && v !== null && "code" in v && "status" in v;

  async function guarded(r: FastifyReply, correlationId: string, work: () => Promise<FastifyReply>): Promise<FastifyReply> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
      kit.sink(correlationId, error);
      return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
    }
  }

  function command(operationId: string, action: string, run: (request: BankRouteRequest<unknown>) => Promise<CommandResult<unknown>>): void {
    const route = routeOf(operationId);
    app.route<{ Params: Record<string, string>; Body: Buffer | undefined }>({
      method: route.method,
      url: fastifyPath(route.path),
      config: { responses: operationalRouteResponses(operationId) },
      onRequest: async (request, r) => {
        const early = admitHeaders({ headers: kit.singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
        if (early !== null) return kit.sendProblem(r, early.problem);
        return undefined;
      },
      handler: async (request, r) => {
        const correlationId = request.id as CorrelationId;
        const headers = kit.singleValued(request.headers);
        const admitted = admitOperationalBody<unknown>(route, { headers, repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId, body: Buffer.isBuffer(request.body) ? request.body : null }, deps.validator);
        if (admitted.kind === "PROBLEM") return kit.sendProblem(r, admitted.problem);
        const key = headers[HEADERS.idempotencyKey];
        if (key === undefined || key === "") return kit.sendProblem(r, invalid("IDEMPOTENCY_KEY_MISSING", correlationId));
        if (!IDEMPOTENCY_KEY.test(key)) return kit.sendProblem(r, invalid("IDEMPOTENCY_KEY_INVALID", correlationId));
        const path = pathIds(route.path, request.params, correlationId);
        if (isProblem(path)) return kit.sendProblem(r, path);
        return guarded(r, correlationId, async () => {
          const subject = await deps.authenticator.authenticate(headers);
          if (subject === null) return kit.sendProblem(r, await deps.refuseUnauthenticated(action, { correlationId, agencyId: null }));
          const result = await run({ environment: deps.environment, correlationId, idempotencyKey: key, subject, path, body: admitted.body, receivedAt: deps.clock.now() });
          return replyOf(kit, r, result);
        });
      },
    });
  }

  command("configureBankRoute", "CMD201", (req) => deps.handlers.configure(req as never));
  command("verifyBankRoute", "CMD202", (req) => deps.handlers.verify(req as never));
  command("enableBankRoute", "CMD203", (req) => deps.handlers.enable(req as never));
  command("disableBankRoute", "CMD204", (req) => deps.handlers.disable(req as never));
  command("replaceBankRouteDetails", "CMD205", (req) => deps.handlers.replaceDetails(req as never));

  function read(operationId: string, run: (request: FastifyRequest<{ Params: Record<string, string> }>, correlationId: CorrelationId, path: Readonly<Record<string, string>>, headers: Readonly<Record<string, string | undefined>>) => Promise<FastifyReplyAnswer>): void {
    const route = routeOf(operationId);
    app.route<{ Params: Record<string, string> }>({
      method: route.method,
      url: fastifyPath(route.path),
      config: { responses: operationalRouteResponses(operationId) },
      handler: async (request, r) => {
        const correlationId = request.id as CorrelationId;
        const headers = kit.singleValued(request.headers);
        const refusal = admitEmptyRequest({ headers, repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId, body: Buffer.isBuffer(request.body) ? request.body : null, query: request.query as Readonly<Record<string, unknown>> });
        if (refusal !== null) return kit.sendProblem(r, refusal.problem);
        const path = pathIds(route.path, request.params, correlationId);
        if (isProblem(path)) return kit.sendProblem(r, path);
        return guarded(r, correlationId, async () => {
          const answer = await run(request, correlationId, path, headers);
          if (answer.kind === "PROBLEM") return kit.sendProblem(r, answer.problem);
          return r.code(200).type(HEADERS.contentType).send(answer.view);
        });
      },
    });
  }
  type FastifyReplyAnswer = { readonly kind: "READ"; readonly view: unknown } | { readonly kind: "PROBLEM"; readonly problem: Problem };

  read("getBankRoute", async (_request, correlationId, path, headers) => {
    const subject = await deps.authenticator.authenticate(headers);
    if (subject === null) return { kind: "PROBLEM", problem: await deps.refuseUnauthenticated("READ_BANK_ROUTE", { correlationId, agencyId: null }) };
    return deps.handlers.get({ correlationId, subject, routeId: path["routeId"]! });
  });

  read("getTransferInstructions", async (_request, correlationId, path, headers) => {
    const selector = headers[HEADERS.agency];
    if (selector !== undefined && !isUuid(selector)) return { kind: "PROBLEM", problem: invalid("AGENCY_SELECTOR_INVALID", correlationId) };
    const subject = await deps.authenticator.authenticate(headers);
    if (subject === null) return { kind: "PROBLEM", problem: await deps.refuseUnauthenticated("READ_TRANSFER_INSTRUCTIONS", { correlationId, agencyId: null }) };
    return readTransferInstructions(deps.runtime, deps.bank, { subject, agencyId: (selector ?? null) as never, correlationId, orderId: path["orderId"]! });
  });
}
