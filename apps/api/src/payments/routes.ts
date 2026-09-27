/**
 * The payment service's routes (docs/design/B09-payments-fiscal.md §10, D-API-B1; stage-2 mandate M3), registered on the api's
 * server with their declared replies (commerceCommandRouteResponses: the COMPLETED envelope, the ACCEPTED envelope where a provider
 * effect may stay unknown, and the Problem document constrained to the closed outcome catalogue), which the send guard enforces
 * and tools/openapi.mjs documents under `paths`:
 *
 *  POST /api/v1/payments/webhooks/{provider}  CMD030 — no Idempotency-Key and no bearer token: its identity is the provider inbox
 *    (D-IDEM-B1) and its authentication the provider's signature over the exact raw bytes, which reach the verifier untouched (the
 *    route never parses them as a Kauro schema). Admission: a repeated single-valued envelope header (HEADER_REPEATED), then the
 *    provider, the body bound (a body beyond the transport's own limit is PROVIDER_BODY_TOO_LARGE too), the verification.
 *  POST /api/v1/refunds/{refundId}/execute     CMD033 — the manual-10 admission of a command (content type, size, strict JSON, the
 *  POST /api/v1/payment-orders/{orderId}/reconcile  CMD034   closed request schema, Idempotency-Key, path ids), then the verified
 *    service identity (the ServiceAuthenticator: issuer, audience, identity, environment); none is AUTHENTICATION_REQUIRED with the
 *    anonymous denial recorded, as for a person.
 *
 * Without a bound payment service (an edition before the integration package binds the provider adapters) the routes are served
 * all the same: the webhook knows no provider (PROVIDER_UNKNOWN) and the service routes find no verified service identity.
 */
import type { CommandResult, CompletedResponse, AcceptedResponse, CommandSpec, Problem, SchemaValidator, UnauthenticatedRequest, WebhookAck } from "@kauro/application";
import { EXECUTE_REFUND, HEADERS, RECEIVE_PAYMENT_WEBHOOK, RECONCILE_PAYMENT, REQUEST_LIMITS, SINGLE_VALUED_HEADERS, admitHeaders, admitStructure, commerceCommandRouteResponses, problemOf, repeatedHeaderNames } from "@kauro/application";
import type { Clock, CorrelationId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { FastifyInstance } from "fastify";
import type { RouteKit } from "../server.js";
import type { PaymentService } from "./index.js";

export interface PaymentRouteDependencies {
  /** The bound payment service, or null in an edition that binds none. */
  readonly payments: PaymentService | null;
  readonly validator: SchemaValidator;
  readonly clock: Clock;
  /** The runtime's refusal of an unauthenticated request: the anonymous DENY fact, then AUTHENTICATION_REQUIRED (B06 R26). */
  readonly refuseUnauthenticated: (action: string, request: UnauthenticatedRequest) => Promise<Problem>;
}

/** `/api/v1/refunds/{refundId}/execute` → `/api/v1/refunds/:refundId/execute`. */
function fastifyPath(cataloguePath: string): string {
  return cataloguePath.replace(/\{([a-zA-Z]+)\}/g, ":$1");
}

function reply<View>(kit: RouteKit, r: import("fastify").FastifyReply, result: CommandResult<View>): import("fastify").FastifyReply {
  switch (result.kind) {
    case "COMPLETED": {
      const body: CompletedResponse<View> = { kind: "COMPLETED", version: result.version, replayed: result.replayed, data: result.view };
      return r.code(result.status).type(HEADERS.contentType).send(body);
    }
    case "ACCEPTED": {
      const body: AcceptedResponse = { kind: "ACCEPTED", operationId: result.operationId, state: result.state, statusPath: result.statusPath, pollAfterSeconds: result.pollAfterSeconds };
      return r.code(202).type(HEADERS.contentType).send(body);
    }
    default:
      return kit.sendProblem(r, result.problem);
  }
}

export function registerPaymentRoutes(app: FastifyInstance, kit: RouteKit, deps: PaymentRouteDependencies): void {
  registerWebhookRoute(app, kit, deps);
  registerServiceCommand(app, kit, deps, EXECUTE_REFUND, (payments, request) => payments.executeRefund(request as never));
  registerServiceCommand(app, kit, deps, RECONCILE_PAYMENT, (payments, request) => payments.reconcilePayment(request as never));
}

function registerWebhookRoute(app: FastifyInstance, kit: RouteKit, deps: PaymentRouteDependencies): void {
  const spec = RECEIVE_PAYMENT_WEBHOOK;
  const providerProblem = (reason: "PROVIDER_BODY_TOO_LARGE", correlationId: string): Problem => problemOf(new DomainFailure("INVALID_REQUEST", `webhook refused: ${reason}`, { reason }), correlationId);
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses: commerceCommandRouteResponses(spec.id) },
    bodyLimit: REQUEST_LIMITS.jsonBytes,
    onRequest: async (request, r) => {
      // a repeated single-valued envelope header decides nothing (B06 R41); the provider's content type is its own business
      const repeated = repeatedHeaderNames(request.raw.rawHeaders).filter((name) => SINGLE_VALUED_HEADERS.has(name));
      if (repeated.length > 0) return kit.sendProblem(r, problemOf(new DomainFailure("INVALID_REQUEST", "request refused: HEADER_REPEATED", { reason: "HEADER_REPEATED" }), request.id));
      return undefined;
    },
    errorHandler: (error, request, r) => {
      // a body beyond the transport's own bound never reaches a verifier: it is beyond every provider's bound too
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return kit.sendProblem(r, providerProblem("PROVIDER_BODY_TOO_LARGE", request.id));
      return kit.answerFrameworkError(error, request, r);
    },
    handler: async (request, r) => {
      const correlationId = request.id as CorrelationId;
      const payments = deps.payments;
      if (payments === null) return kit.sendProblem(r, problemOf(new DomainFailure("NOT_FOUND", "webhook refused: PROVIDER_UNKNOWN", { reason: "PROVIDER_UNKNOWN" }), correlationId));
      let outcome;
      try {
        outcome = await payments.receiveWebhook(deps.validator, {
          provider: request.params["provider"] ?? "",
          bytes: Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : new Uint8Array(0),
          headers: kit.singleValued(request.headers),
          correlationId,
        });
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
        kit.sink(correlationId, error);
        return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
      }
      if (outcome.kind === "PROBLEM") return kit.sendProblem(r, outcome.problem);
      // the inbox record carries no aggregate version: the acknowledgement's envelope names the record's own, which never changes
      const body: CompletedResponse<WebhookAck> = { kind: "COMPLETED", version: 1, replayed: outcome.ack.duplicate, data: outcome.ack };
      return r.code(200).type(HEADERS.contentType).send(body);
    },
  });
}

function registerServiceCommand<Body, View>(
  app: FastifyInstance,
  kit: RouteKit,
  deps: PaymentRouteDependencies,
  spec: typeof EXECUTE_REFUND | typeof RECONCILE_PAYMENT,
  run: (payments: PaymentService, request: { readonly correlationId: CorrelationId; readonly idempotencyKey: string; readonly identity: import("@kauro/domain").ServiceIdentity; readonly path: Readonly<Record<string, string>>; readonly body: Body }) => Promise<CommandResult<View>>,
): void {
  // the manual-10 admission of a command: the B06 admission over the payment command's closed request schema (no agency selector:
  // the scope is the stored operation's)
  const admissionSpec = { id: spec.id, name: spec.name, method: spec.method, path: spec.path, role: spec.role, scope: "NONE", aggregateParam: spec.aggregateParam, expectedVersionRequired: spec.expectedVersionRequired, stepUpRequired: false, authorityHashFields: [], fields: spec.fields } as unknown as CommandSpec<Body>;
  app.route<{ Params: Record<string, string>; Body: Buffer | undefined }>({
    method: spec.method,
    url: fastifyPath(spec.path),
    config: { responses: commerceCommandRouteResponses(spec.id) },
    onRequest: async (request, r) => {
      const early = admitHeaders({ headers: kit.singleValued(request.headers), repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId });
      if (early !== null) return kit.sendProblem(r, early.problem);
      return undefined;
    },
    handler: async (request, r) => {
      const headers = kit.singleValued(request.headers);
      const admission = admitStructure(admissionSpec, { headers, repeatedHeaders: repeatedHeaderNames(request.raw.rawHeaders), correlationId: request.id as CorrelationId, params: request.params, body: Buffer.isBuffer(request.body) ? request.body : null, clientAddressHash: null }, deps.validator, deps.clock);
      if (admission.kind === "PROBLEM") return kit.sendProblem(r, admission.problem);
      const correlationId = admission.admission.correlationId;
      const identity = deps.payments === null ? null : await deps.payments.runtime.assembly.serviceAuthenticator.authenticate(headers);
      if (identity === null || deps.payments === null) {
        let refusal: Problem;
        try {
          refusal = await deps.refuseUnauthenticated(spec.id, { correlationId, agencyId: null });
        } catch (error) {
          kit.sink(correlationId, error);
          return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
        }
        return kit.sendProblem(r, refusal);
      }
      let result: CommandResult<View>;
      try {
        result = await run(deps.payments, { correlationId, idempotencyKey: admission.admission.idempotencyKey, identity, path: admission.admission.path, body: admission.admission.body });
      } catch (error) {
        if (error instanceof DomainFailure && error.code !== "INTERNAL_ERROR") return kit.sendProblem(r, problemOf(error, correlationId));
        kit.sink(correlationId, error);
        return kit.sendProblem(r, problemOf(new DomainFailure("INTERNAL_ERROR", "unexpected exception", {}, true), correlationId));
      }
      return reply(kit, r, result);
    },
  });
}
