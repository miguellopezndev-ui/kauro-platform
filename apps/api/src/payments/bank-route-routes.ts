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
 *   POST /api/v1/payment-orders/{orderId}/retirements          retireBankCheckout       (billing member, X-Kauro-Agency) 200
 *
 * Admission of a POST: the envelope headers, the closed request schema, an Idempotency-Key, the path ids; then the person's
 * authentication through the server's shared command boundary with the actual method (PV1R-01: an unsafe cookie request's Origin,
 * Sec-Fetch-Site and CSRF rule; typed credential refusals; none: the anonymous denial, AUTHENTICATION_REQUIRED). Every reply carries Cache-Control: no-store (the server's hook);
 * the instructions never carry an ETag.
 */
import type { BankInboundHandlers, BankSettlementHandlers, BankRouteCollaborators, BankRouteHandlers, BankRouteRequest, CommandResult, CompletedResponse, Problem, SchemaValidator, UnauthenticatedRequest } from "@kauro/application";
import { HEADERS, OPERATIONAL_ROUTES, admitEmptyRequest, admitHeaders, admitOperationalBody, operationalRouteResponses, problemOf, readTransferInstructions, repeatedHeaderNames, type CommerceRequestRuntime } from "@kauro/application";
import type { AgencyId, Clock, CorrelationId, Environment } from "@kauro/domain";
import { DomainFailure, IDEMPOTENCY_KEY, isUuid } from "@kauro/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteKit } from "../server.js";

export interface BankRouteRouteDependencies {
  readonly handlers: BankRouteHandlers;
  /** The owner's inbound credit commands (lane PV1-INBOUND). */
  readonly inbound?: BankInboundHandlers;
  /** The owner's settlement observation (lane PV1-SETTLE, CMD215). */
  readonly settlement?: BankSettlementHandlers;
  readonly runtime: CommerceRequestRuntime;
  readonly bank: BankRouteCollaborators | null;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly environment: Environment;
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
}

const REF_PATH = /^[A-Za-z0-9._:-]{1,128}$/;
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
      if (value === undefined || !(name.endsWith("Ref") ? REF_PATH : UUID_PATH).test(value)) return invalid("PATH_ID_INVALID", correlationId);
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

  function command(operationId: string, action: string, run: (request: BankRouteRequest<unknown> & { readonly agencyId: AgencyId | null }) => Promise<CommandResult<unknown>>, tenant = false): void {
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
        // a tenant command names its agency (X-Kauro-Agency); an owner command names none
        const selector = tenant ? headers[HEADERS.agency] : undefined;
        if (tenant && (selector === undefined || !isUuid(selector))) return kit.sendProblem(r, invalid("AGENCY_SELECTOR_INVALID", correlationId));
        const agencyId = (selector ?? null) as AgencyId | null;
        // PV1R-01: the shared command boundary's authentication with the request's actual method (the unsafe cookie request's Origin,
        // Sec-Fetch-Site and session CSRF rule; typed credential refusals), before the handler runs and before any journal reservation
        const authenticated = await kit.subjectOrRefusal(request, headers, action, { correlationId, agencyId });
        if (authenticated.kind === "PROBLEM") return kit.sendProblem(r, authenticated.problem);
        const subject = authenticated.subject;
        // rule 16 (PV1R-07 r4): the command fences the caller's credential FOR SHARE in its own unit and judges it at COMMIT (that COMMIT is the release)
        const authority = kit.requestAuthority(request, headers, subject.identity.userId);
        return guarded(r, correlationId, async () => {
          const result: CommandResult<unknown> = await run({ environment: deps.environment, correlationId, idempotencyKey: key, subject, path, body: admitted.body, receivedAt: deps.clock.now(), authority, agencyId });
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

  const inbound = deps.inbound;
  if (inbound !== undefined) {
    command("enterBankCredit", "CMD210", (req) => inbound.enter(req as never));
    command("confirmBankCredit", "CMD211", (req) => inbound.confirm(req as never));
    command("attributeBankCredit", "CMD212", (req) => inbound.attribute(req as never));
    command("importBankStatement", "CMD213", (req) => inbound.importStatement(req as never));
    command("retireBankCheckout", "CMD214", (req) => inbound.retire(req as never), true);
  }
  const settlement = deps.settlement;
  if (settlement !== undefined) command("recordBankSettlement", "CMD215", (req) => settlement.record(req as never));

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

  read("getBankRoute", async (request, correlationId, path, headers) => {
    const authenticated = await kit.subjectOrRefusal(request, headers, "READ_BANK_ROUTE", { correlationId, agencyId: null });
    if (authenticated.kind === "PROBLEM") return authenticated;
    const authority = kit.requestAuthority(request, headers, authenticated.subject.identity.userId);
    return await deps.handlers.get({ correlationId, subject: authenticated.subject, routeId: path["routeId"]!, authority });
  });

  if (inbound !== undefined) {
    const ownerRead = async <View>(headers: Readonly<Record<string, string | undefined>>, request: FastifyRequest<{ Params: Record<string, string> }>, action: string, correlationId: CorrelationId, run: (r: { correlationId: CorrelationId; subject: never; authority: never }) => Promise<FastifyReplyAnswer>): Promise<FastifyReplyAnswer> => {
      const authenticated = await kit.subjectOrRefusal(request, headers, action, { correlationId, agencyId: null });
      if (authenticated.kind === "PROBLEM") return authenticated;
      const authority = kit.requestAuthority(request, headers, authenticated.subject.identity.userId);
      const answer = await run({ correlationId, subject: authenticated.subject as never, authority: authority as never });
      return answer.kind === "READ" ? { kind: "READ", view: { data: answer.view } } : answer;
    };
    read("getBankCredit", (request, correlationId, path, headers) => ownerRead(headers, request, "READ_BANK_CREDIT", correlationId, (r) => inbound.getCredit({ ...r, creditId: path["creditId"]! })));
    read("getBankOrderMatchKeys", (request, correlationId, path, headers) => ownerRead(headers, request, "READ_BANK_ORDER_MATCH_KEYS", correlationId, (r) => inbound.getMatchKeys({ ...r, orderId: path["orderId"]! })));
  }

  read("getTransferInstructions", async (request, correlationId, path, headers) => {
    const selector = headers[HEADERS.agency];
    if (selector !== undefined && !isUuid(selector)) return { kind: "PROBLEM", problem: invalid("AGENCY_SELECTOR_INVALID", correlationId) };
    const authenticated = await kit.subjectOrRefusal(request, headers, "READ_TRANSFER_INSTRUCTIONS", { correlationId, agencyId: null });
    if (authenticated.kind === "PROBLEM") return authenticated;
    const subject = authenticated.subject;
    // the same credentials again at the projection's guard instant before the route (ADV-PV1R-6): a session revoked or expired during the
    // store read is refused exactly as a request after it (the authenticator reads the session as it stands; the bearer token as it stands)
    const stillAuthenticated = async (): Promise<{ readonly liveUntil: string | null } | null> => {
      const again = await kit.authentication({ method: request.method, headers });
      if (again.kind !== "SUBJECT" || again.subject.identity.userId !== subject.identity.userId) return null;
      return { liveUntil: again.liveUntil ?? null };
    };
    // the FINAL judgment under the session row's lock (rule 16, PV1R-02 and PV1R-07 r4): taken FOR SHARE in the read's own unit before the effect
    // clock and held until that unit's COMMIT, after the view is built; a revocation that starts meanwhile waits for it
    const authority = kit.requestAuthority(request, headers, subject.identity.userId);
    const answer = await readTransferInstructions(deps.runtime, deps.bank, { subject, agencyId: (selector ?? null) as never, correlationId, orderId: path["orderId"]!, stillAuthenticated, authority });
    if (answer.kind === "UNAUTHENTICATED") return { kind: "PROBLEM", problem: await deps.refuseUnauthenticated("READ_TRANSFER_INSTRUCTIONS", { correlationId, agencyId: null }) };
    return answer;
  });
}
