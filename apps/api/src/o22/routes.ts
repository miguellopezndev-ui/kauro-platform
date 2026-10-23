/**
 * Order 22's routes (REISSUE-CANDIDATE-01 build profile; CP-02.07, .09, .10, .11, .14), in their own module. registerO22Routes registers
 * NOTHING unless `enabled` (o22Activation: KAURO_O22_CANDIDATE=on), so the served contract, the route inventory and the generated
 * OpenAPI stay exactly as they are. The replies name the candidate's schema ids, which the served validator learns only when Order 19B
 * adopts the items: enabling the flag before that adoption is refused by the send guard, by design (activation = adoption).
 *
 * The one registration line for the composition root (front 3 / integrator), in apps/api/src/composition.ts beside registerCommissionRoutes:
 *   registerO22Routes(app, kit, { enabled: o22Activation(process.env), runAs: o22RunAs(runtime.unitOfWork), refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request) });
 */
import type { Problem, UnauthenticatedRequest, RouteResponses } from "@kauro/application";
import { HEADERS, PROBLEM_RESPONSE, problemOf } from "@kauro/application";
import { DomainFailure, o22, type UnitOfWork } from "@kauro/domain";
import { o22Of, type PgO22Repository } from "@kauro/persistence";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouteKit } from "../server.js";
import { claimHistory, decideClaimReview, getMyMoney, listMyAlerts, listMyClaims, listOwnerAlerts, listSellerMoney, refuseAttribution, requestClaimReview, type O22Result, type O22Store, type RunAs } from "./handlers.js";

export interface O22RouteDependencies {
  readonly enabled: boolean;
  readonly runAs: RunAs;
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
}

/** The units of work the request handlers run in, as Order 22 uses them (an OPERATOR context of the caller). */
export interface OperatorUnits {
  run<T>(context: { readonly kind: "OPERATOR"; readonly userId: string; readonly correlationId: string }, fn: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

export function o22RunAs(units: OperatorUnits): RunAs {
  return (userId, correlationId, fn) => units.run({ kind: "OPERATOR", userId, correlationId }, (uow) => fn(o22Of(uow) as PgO22Repository as O22Store));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LABEL = /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/;
const TEXT = /^(?=[\s\S]*\S)[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+$/;
const KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** The candidate's problem: the domain's code and status, and Order 22's reason (adopted with the items). */
function problemOfFailure(failure: DomainFailure | o22.O22Failure, correlationId: string): Problem {
  if (failure instanceof o22.O22Failure) return { ...problemOf(new DomainFailure(failure.code, failure.message), correlationId), reason: failure.reason } as unknown as Problem;
  return problemOf(failure, correlationId);
}

function invalid(field: string): DomainFailure {
  return new DomainFailure("INVALID_REQUEST", `the request is not valid at ${field}`, { fields: [{ field, code: "FORMAT" }] } as never);
}

/** A closed JSON object: only `allowed` members, each checked; anything else is refused before any read. */
function closedBody(raw: unknown, allowed: Readonly<Record<string, (v: unknown) => boolean>>, required: ReadonlyArray<string>): Record<string, unknown> {
  let body: unknown;
  try {
    body = Buffer.isBuffer(raw) ? JSON.parse(raw.toString("utf8")) : raw;
  } catch {
    throw invalid("body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("body");
  for (const [k, v] of Object.entries(body)) if (!(k in allowed) || !(allowed[k] as (v: unknown) => boolean)(v)) throw invalid(k);
  for (const k of required) if (!(k in body)) throw invalid(k);
  return body as Record<string, unknown>;
}
const version = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const matches = (re: RegExp, max: number) => (v: unknown): boolean => typeof v === "string" && v.length <= max && re.test(v);

function responses(operationId: string, status: 200 | 201, schemaId: string): RouteResponses {
  return { operationId, declared: { [String(status)]: { contentType: HEADERS.contentType, schemaId } }, problem: PROBLEM_RESPONSE, outcomes: null } as unknown as RouteResponses;
}

/** Registers Order 22's candidate routes, or nothing at all when not enabled. */
export function registerO22Routes(app: FastifyInstance, kit: RouteKit, deps: O22RouteDependencies): void {
  if (!deps.enabled) return;

  const send = <View>(r: FastifyReply, correlationId: string, result: O22Result<View>): FastifyReply => {
    if (result.kind === "FAILURE") return kit.sendProblem(r, problemOfFailure(result.failure, correlationId));
    if (result.kind === "READ") return r.code(200).type(HEADERS.contentType).send({ kind: "READ", data: result.data });
    return r.code(result.status).type(HEADERS.contentType).send({ kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.data });
  };

  const route = (method: "GET" | "POST", url: string, operationId: string, status: 200 | 201, schemaId: string, run: (request: FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Buffer | undefined }>, userId: string, correlationId: string) => Promise<O22Result<unknown>>): void => {
    app.route<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Buffer | undefined }>({
      method,
      url,
      config: { responses: responses(operationId, status, schemaId) },
      handler: async (request, r) => {
        const headers = kit.singleValued(request.headers);
        const correlationId = request.id;
        try {
          const auth = await kit.subjectOrRefusal(request, headers, operationId, { correlationId, agencyId: null } as UnauthenticatedRequest);
          if (auth.kind === "PROBLEM") return kit.sendProblem(r, auth.problem);
          return send(r, correlationId, await run(request, auth.subject.identity.userId, correlationId));
        } catch (error) {
          if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
          kit.sink(correlationId, error);
          return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
        }
      },
    });
  };

  const periodOf = (q: Record<string, string>): string => {
    const id = q["periodId"];
    if (id === undefined || !UUID.test(id)) throw invalid("periodId");
    return id;
  };
  const pathId = (p: Record<string, string>, name: string): string => {
    const id = p[name];
    if (id === undefined || !UUID.test(id)) throw invalid(name);
    return id;
  };
  const keyOf = (request: FastifyRequest): string => {
    const key = kit.singleValued(request.headers)["idempotency-key"];
    if (key === undefined || !KEY.test(key)) throw invalid("Idempotency-Key");
    return key;
  };
  const labels = (store: O22Store, prospectIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, string>> => store.prospectLabels(prospectIds);

  route("GET", "/api/v1/ops/sales/money", "ListSellerMoney", 200, "urn:kauro:api:v1:response:read:ListSellerMoney", (q, u, c) => listSellerMoney(deps.runAs, u, c, periodOf(q.query)));
  route("GET", "/api/v1/sales/money", "GetMyMoney", 200, "urn:kauro:api:v1:response:read:GetMyMoney", (q, u, c) => getMyMoney(deps.runAs, u, c, periodOf(q.query)));
  route("POST", "/api/v1/sales/claims/:claimId/refuse", "RefuseAttribution", 200, "urn:kauro:api:v1:response:CMD071", (q, u, c) => {
    const b = closedBody(q.body, { expectedVersion: version, reasonCode: matches(LABEL, 200), listVersion: matches(LABEL, 200), evidenceRef: matches(UUID, 36), note: matches(TEXT, 4000), ownerRuleRef: matches(LABEL, 200) }, ["expectedVersion", "reasonCode", "listVersion", "evidenceRef"]);
    return refuseAttribution(deps.runAs, u, c, pathId(q.params, "claimId"), b as never, keyOf(q));
  });
  route("POST", "/api/v1/sales/claims/:claimId/review-requests", "RequestClaimReview", 201, "urn:kauro:api:v1:response:CMD068", (q, u, c) => {
    const b = closedBody(q.body, { expectedVersion: version, note: matches(TEXT, 2000) }, ["expectedVersion"]);
    return requestClaimReview(deps.runAs, u, c, pathId(q.params, "claimId"), b as never, keyOf(q));
  });
  route("POST", "/api/v1/sales/claim-reviews/:reviewId/decide", "DecideClaimReview", 200, "urn:kauro:api:v1:response:CMD072", (q, u, c) => {
    const b = closedBody(q.body, { expectedVersion: version, decision: (v) => v === "UPHOLD" || v === "CHANGE", reasonCode: matches(LABEL, 200), note: matches(TEXT, 4000) }, ["expectedVersion", "decision", "reasonCode"]);
    return decideClaimReview(deps.runAs, u, c, pathId(q.params, "reviewId"), b as never, keyOf(q));
  });
  route("GET", "/api/v1/sales/claims", "ListMyClaims", 200, "urn:kauro:api:v1:response:read:ListMyClaims", (_q, u, c) => listMyClaims(deps.runAs, u, c, labels));
  route("GET", "/api/v1/sales/claims/:claimId/history", "GetMyClaimHistory", 200, "urn:kauro:api:v1:response:read:GetMyClaimHistory", (q, u, c) => claimHistory(deps.runAs, u, c, pathId(q.params, "claimId"), "SELLER"));
  route("GET", "/api/v1/ops/sales/claims/:claimId/history", "GetClaimHistory", 200, "urn:kauro:api:v1:response:read:GetClaimHistory", (q, u, c) => claimHistory(deps.runAs, u, c, pathId(q.params, "claimId"), "KAURO_OWNER"));
  route("GET", "/api/v1/ops/alerts", "ListOwnerAlerts", 200, "urn:kauro:api:v1:response:read:ListOwnerAlerts", (_q, u, c) => listOwnerAlerts(deps.runAs, u, c, async () => []));
  route("GET", "/api/v1/sales/alerts", "ListMyAlerts", 200, "urn:kauro:api:v1:response:read:ListMyAlerts", (_q, u, c) => listMyAlerts(deps.runAs, u, c));
}
