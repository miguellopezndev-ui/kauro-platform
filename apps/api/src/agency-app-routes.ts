/**
 * The agency app's operational command (package B11 lane A1; SCREENS-PLAN section 3 rows A1; R2 A3 3.7), declared in OPERATIONAL_ROUTES of
 * @kauro/application (api/response-schemas AGENCY_APP_OPERATIONAL_ROUTES) with its closed problem catalogue (api/outcomes
 * OPERATIONAL_OUTCOMES) and documented under `paths`:
 *
 *   POST /api/v1/agencies/{agencyId}/buyer-type   setBuyerType   (CMD101, AGENCY_OWNER)   201 recorded, 200 the same value again
 *
 * Its reads (GetBuyerType, ListProjects) are READ_ROUTES and served by the server's read registration.
 *
 * Admission, in the order of the bank-route commands (payments/bank-route-routes): the envelope headers, the closed request schema, an
 * Idempotency-Key, the path id; then the person's authentication through the server's shared command boundary with the actual method
 * (an unsafe cookie request's Origin, Sec-Fetch-Site and CSRF rule before any journal reservation); then the command pipeline
 * (agency/buyer-type: access, journal, the agency row lock, the recorded row, journal commit).
 */
import type { AgencyAppHandlers, CommandResult, CompletedResponse, Problem, SchemaValidator, SetBuyerTypeBody } from "@kauro/application";
import { HEADERS, OPERATIONAL_ROUTES, admitHeaders, admitOperationalBody, operationalRouteResponses, problemOf, repeatedHeaderNames } from "@kauro/application";
import type { AgencyId, Clock, CorrelationId, Environment } from "@kauro/domain";
import { DomainFailure, IDEMPOTENCY_KEY } from "@kauro/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RouteKit } from "./server.js";

export interface AgencyAppRouteDependencies {
  readonly handlers: AgencyAppHandlers;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  readonly environment: Environment;
}

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const invalid = (reason: "IDEMPOTENCY_KEY_MISSING" | "IDEMPOTENCY_KEY_INVALID" | "PATH_ID_INVALID", correlationId: string): Problem =>
  problemOf(new DomainFailure("INVALID_REQUEST", `request refused: ${reason}`, reason === "PATH_ID_INVALID" ? { reason, fields: [{ field: "agencyId", code: "FORMAT" }] } : { reason }), correlationId);

export function registerAgencyAppRoutes(app: FastifyInstance, kit: RouteKit, deps: AgencyAppRouteDependencies): void {
  const route = OPERATIONAL_ROUTES.find((r) => r.operationId === "setBuyerType");
  if (route === undefined) throw new Error("the operational route setBuyerType is not declared in OPERATIONAL_ROUTES of @kauro/application");

  const replyOf = (r: FastifyReply, result: CommandResult<unknown>): FastifyReply => {
    if (result.kind === "COMPLETED") {
      const body: CompletedResponse<unknown> = { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view };
      return r.code(result.status).type(HEADERS.contentType).send(body);
    }
    if (result.kind === "ACCEPTED") throw new Error("SetBuyerType never answers ACCEPTED");
    return kit.sendProblem(r, result.problem);
  };

  app.route<{ Params: Record<string, string>; Body: Buffer | undefined }>({
    method: route.method,
    url: route.path.replace(/\{([a-zA-Z]+)\}/g, ":$1"),
    config: { responses: operationalRouteResponses("setBuyerType") },
    onRequest: async (request, r) => {
      const early = admitHeaders({ headers: kit.singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return kit.sendProblem(r, early.problem);
      return undefined;
    },
    handler: async (request, r) => {
      const correlationId = request.id as CorrelationId;
      const headers = kit.singleValued(request.headers);
      const admitted = admitOperationalBody<SetBuyerTypeBody>(route, { headers, repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId, body: Buffer.isBuffer(request.body) ? request.body : null }, deps.validator);
      if (admitted.kind === "PROBLEM") return kit.sendProblem(r, admitted.problem);
      const key = headers[HEADERS.idempotencyKey];
      if (key === undefined || key === "") return kit.sendProblem(r, invalid("IDEMPOTENCY_KEY_MISSING", correlationId));
      if (!IDEMPOTENCY_KEY.test(key)) return kit.sendProblem(r, invalid("IDEMPOTENCY_KEY_INVALID", correlationId));
      const agencyId = request.params["agencyId"];
      if (agencyId === undefined || !UUID_PATH.test(agencyId)) return kit.sendProblem(r, invalid("PATH_ID_INVALID", correlationId));
      // the shared command boundary's authentication with the request's actual method, before the handler runs and before any journal reservation
      const authenticated = await kit.subjectOrRefusal(request, headers, "CMD101", { correlationId, agencyId: agencyId as AgencyId });
      if (authenticated.kind === "PROBLEM") return kit.sendProblem(r, authenticated.problem);
      const subject = authenticated.subject;
      const authority = kit.requestAuthority(request, headers, subject.identity.userId);
      try {
        const result = await deps.handlers.setBuyerType({ environment: deps.environment, correlationId, idempotencyKey: key, subject, path: { agencyId }, body: admitted.body, receivedAt: deps.clock.now(), authority });
        return replyOf(r, result);
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
        kit.sink(correlationId, error);
        return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
      }
    },
  });
}
