/**
 * The payment service's commands (docs/design/B09-payments-fiscal.md §8 CMD033, CMD034; §3.4, §6.1, §6.3; stage-2 mandate M3):
 *
 *  ExecuteRefund (CMD033, POST /api/v1/refunds/{refundId}/execute) — the provider-effect protocol of M2 (runProviderCommand) with
 *    the payment service as the principal of every phase: access (authorizeService, then the stored operation's scope, adopted in
 *    every unit of work) → journal reserve → T1 the REFUND attempt PREPARED with its exact request hash → T2 the claim (refund
 *    SUBMITTING, attempt DISPATCHING with the database's deadline) → the provider call under `kauro-<attemptId>` → T3 the settle
 *    through the reconciler → T4 the journal COMMITTED (200 ExecuteRefundView) or UNCERTAIN (202 with the durable operation).
 *  ReconcilePayment (CMD034, POST /api/v1/payment-orders/{orderId}/reconcile) — one SERVICE unit of work: access → the order's
 *    scope → journal reserve → the stored, authenticated provider query (read from the restricted store before the transaction)
 *    must exist and be about this order, provider and environment → the reconciler applies it under the order's row lock →
 *    200 ReconcilePaymentView, journaled.
 *
 * Both answer only with their closed outcome catalogue (COMMERCE_COMMAND_OUTCOMES): a verified service identity without the
 * PAYMENT_SERVICE role or issued for another environment is NOT_AUTHORIZED (SERVICE_NOT_PERMITTED / SERVICE_ENVIRONMENT_MISMATCH),
 * a stored operation the scope index does not hold is NOT_FOUND alike for foreign and unknown, and every denial is a durable
 * security fact of the service stream (agency NULL, actor SERVICE; D-FACT-B1). The watchdog's settlement (a stored provider query
 * applied through CMD034 under the payment service's own identity, D-PROTO-B4) lives here too.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommandResult, ExecuteRefundBody, ExecuteRefundView, ProviderCommandHooks, ProviderOrderObservation, ReconcilePaymentBody, ReconcilePaymentView, StoredEvidence } from "@kauro/application";
import { EXECUTE_REFUND, RECONCILE_PAYMENT, operationOf, prepareProviderAttempt, problemOf, providerEffectPhases, runProviderCommand } from "@kauro/application";
import type {
  AgencyId,
  CausationId,
  CommerceUnitOfWork,
  CorrelationId,
  EvidenceArtifactRef,
  IdempotencyIdentity,
  JournalEntryId,
  PaymentAttemptId,
  PaymentAttemptRecord,
  PaymentOrderId,
  RefundId,
  ServiceContext,
  ServiceIdentity,
} from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, IdempotencyConflictFailure, NotFoundFailure, StaleVersionFailure, commandRequestDigest } from "@kauro/domain";
import type { PaymentRuntime } from "./runtime.js";
import { causedBy } from "./runtime.js";
import { authorizationView, captureView, paymentOrderView, refundView } from "./views.js";

/** A service command as the route admitted it: the verified service identity, the idempotency key, the path ids and the closed body. */
export interface ServiceCommandRequest<Body> {
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly identity: ServiceIdentity;
  readonly path: Readonly<Record<string, string>>;
  readonly body: Body;
}

type Rejection<View> = Extract<CommandResult<View>, { kind: "CONFLICT" | "REJECTED" | "UNAVAILABLE" }>;

const CONFLICT_CODES = new Set(["STALE_VERSION", "IDEMPOTENCY_CONFLICT", "PRECONDITION_FAILED", "PAYMENT_PENDING", "PAYMENT_UNCERTAIN", "OPERATION_CANCELLED"]);

function rejection<View>(failure: DomainFailure, correlationId: string): Rejection<View> {
  const problem = problemOf(failure, correlationId);
  if (CONFLICT_CODES.has(failure.code)) return { kind: "CONFLICT", problem };
  if (failure.code === "CAPACITY_UNAVAILABLE") return { kind: "UNAVAILABLE", problem };
  return { kind: "REJECTED", problem };
}

function serviceContext(identity: ServiceIdentity, correlationId: CorrelationId): ServiceContext {
  return { kind: "SERVICE", serviceId: identity.serviceId, correlationId };
}

/**
 * The durable DENY fact of a service command, in its own transaction so the command's rollback cannot erase it: the service stream
 * (no agency, actor SERVICE; migration 0009 security_events_payment_write; D-FACT-B1).
 */
export async function recordServiceDenial(rt: PaymentRuntime, context: ServiceContext, action: string, failure: DomainFailure): Promise<void> {
  await rt.assembly.commerce.run(context, (uow) =>
    uow.securityEvents.append({
      agencyId: null,
      requestedAgencyId: null,
      actor: { kind: "SERVICE", serviceId: context.serviceId },
      action,
      outcome: "DENY",
      reasonCode: failure.details.reason ?? failure.code,
      policyVersion: COMMERCE_POLICY_VERSION,
      assuranceClass: "SESSION",
      correlationId: context.correlationId,
      occurredAt: rt.clock.now(),
    }),
  );
}

/**
 * The access decision of a service command (design §3.4): the verified identity holds PAYMENT_SERVICE in this deployment's
 * environment, then the stored operation resolves through the scope index. Returns the adopted agency, or the recorded refusal.
 */
async function serviceAccess<View>(rt: PaymentRuntime, action: string, request: ServiceCommandRequest<unknown>, stored: { readonly kind: "REFUND" | "PAYMENT_ORDER"; readonly key: string }): Promise<{ readonly agencyId: AgencyId } | Rejection<View>> {
  const context = serviceContext(request.identity, request.correlationId);
  const decision = rt.authorizer.authorizeService({ identity: request.identity, role: "PAYMENT_SERVICE", deploymentEnvironment: rt.environment });
  if (decision.kind === "DENY") {
    const failure = new DomainFailure(decision.code, `${action} denied: ${String(decision.reason)}`, decision.reason !== null ? { reason: decision.reason } : {});
    await recordServiceDenial(rt, context, action, failure);
    return rejection(failure, request.correlationId);
  }
  const agencyId = await rt.assembly.commerce.run(context, (uow) => uow.adoptScope(stored.kind, stored.key));
  if (agencyId === null) {
    // a foreign and a nonexistent stored operation look alike: nothing is adopted, nothing written but the denial
    const failure = new NotFoundFailure(stored.kind === "REFUND" ? "refund" : "payment_order");
    await recordServiceDenial(rt, context, action, failure);
    return rejection(failure, request.correlationId);
  }
  return { agencyId };
}

function identityOf(rt: PaymentRuntime, request: ServiceCommandRequest<unknown>, agencyId: AgencyId, operation: "CMD033" | "CMD034"): IdempotencyIdentity {
  return { environment: rt.environment, actor: { kind: "SERVICE", serviceId: request.identity.serviceId }, agencyId, operation, key: request.idempotencyKey };
}

// --- CMD033 ExecuteRefund ------------------------------------------------------------------------------------------------------

function refundHooks(rt: PaymentRuntime, refundId: RefundId): ProviderCommandHooks<ExecuteRefundBody, ExecuteRefundView> {
  return {
    async intent(uow, body, causationId, now) {
      const c = uow.commerce;
      const entryId = causationId as string as JournalEntryId;
      // read the refund, its capture and its order; then the refund's row lock (payment order → attempt → capture → refund, §6.2)
      const unlocked = await c.refunds.get(refundId);
      if (unlocked === null) throw new NotFoundFailure("refund");
      const capture = await c.captures.get(unlocked.captureId);
      const order = await c.orders.get(unlocked.orderId);
      if (capture === null || order === null) throw new DomainFailure("INTEGRITY_FAILURE", "a refund's capture and order are visible to its scope");
      const refund = await c.refunds.lock(refundId);
      if (refund === null) throw new NotFoundFailure("refund");
      if (refund.version !== body.expectedVersion) throw new StaleVersionFailure(refund.version, refund.state);
      // "any prior ambiguous submission is reconciled" first: an uncertain refund is never executed again blind (CMD033 failure)
      if (refund.state === "UNCERTAIN") throw new DomainFailure("PAYMENT_UNCERTAIN", "a prior submission of the refund may have refunded; reconcile it first", { reason: "REFUND_UNCERTAIN" });
      if (refund.state === "SUBMITTING") throw new DomainFailure("PAYMENT_PENDING", "a submission of the refund is in flight", { reason: "REFUND_IN_PROGRESS" });
      if (refund.state !== "APPROVED") throw new DomainFailure("PRECONDITION_FAILED", "only an approved refund is executed", { reason: "REFUND_NOT_APPROVED", currentVersion: refund.version, currentState: refund.state });
      // a reversed capture returned the money already: its reconciliation lapsed the APPROVED refunds in the reversal's own
      // transaction (Refund authorization_lapsed); an approved refund of a capture that is not COMPLETED is never dispatched
      if (capture.status !== "COMPLETED") throw new DomainFailure("PRECONDITION_FAILED", "the capture is not refundable", { reason: "CAPTURE_NOT_REFUNDABLE" });
      const live = await c.attempts.findLive({ refundId });
      if (live !== null) {
        if (live.state === "UNCERTAIN") throw new DomainFailure("PAYMENT_UNCERTAIN", "a prior submission of the refund may have refunded; reconcile it first", { reason: "REFUND_UNCERTAIN" });
        throw new DomainFailure("PAYMENT_PENDING", "a submission of the refund is in flight", { reason: "REFUND_IN_PROGRESS" });
      }
      if (rt.assembly.provider.provider !== order.provider || rt.assembly.provider.environment !== order.environment) {
        throw new DomainFailure("INTEGRITY_FAILURE", "no provider adapter of the order's provider and environment is bound", { reason: "PROVIDER_SERVICES_UNAVAILABLE" });
      }
      // a later attempt of the refund follows a proved no-effect of the previous one (D-PROTO-B3; the database bounds it)
      const ordinal = (await c.attempts.countFor({ refundId })) + 1;
      const attempt = await prepareProviderAttempt(uow, { adapter: rt.assembly.provider, subject: { effect: "REFUND", order, refund, capture }, ordinal, intentEntryId: entryId, causationId, now });
      return { kind: "DISPATCH", operation: await operationOf(uow, "REFUND", entryId, attempt) };
    },
    async conclude(serviceUow, operation) {
      const refund = await serviceUow.commerce.refunds.get(operation.resource.id as RefundId);
      const attempt = await serviceUow.commerce.attempts.get(operation.attempt.attemptId);
      if (refund === null || attempt === null) throw new DomainFailure("INTEGRITY_FAILURE", "the executed refund and its attempt are visible to the payment service");
      return { kind: "CONCLUSIVE", status: 200, view: { refund: refundView(refund), attemptState: attempt.state }, version: refund.version, resourceKind: "refund", resourceId: refund.refundId };
    },
  };
}

/** CMD033 ExecuteRefund: the provider-effect protocol with the payment service as its principal (design §8 CMD033). */
export async function executeRefund(rt: PaymentRuntime, request: ServiceCommandRequest<ExecuteRefundBody>): Promise<CommandResult<ExecuteRefundView>> {
  const refundId = request.path["refundId"] as RefundId;
  const access = await serviceAccess<ExecuteRefundView>(rt, EXECUTE_REFUND.id, request, { kind: "REFUND", key: refundId });
  if ("kind" in access) return access;
  const context = serviceContext(request.identity, request.correlationId);
  const adapter = rt.assembly.provider;
  const hold = rt.assembly.hold;
  return runProviderCommand<ExecuteRefundBody, ExecuteRefundView>({
    effect: "REFUND",
    phases: providerEffectPhases("REFUND", { adapter, reconciler: rt.reconciler, clock: rt.clock }, refundHooks(rt, refundId)),
    adapter,
    clock: rt.clock,
    principal: { unitOfWork: rt.assembly.commerce, context, storedOperation: { kind: "REFUND", key: refundId } },
    service: { unitOfWork: rt.assembly.commerce, context },
    identity: identityOf(rt, request, access.agencyId, "CMD033"),
    digest: commandRequestDigest({ operation: EXECUTE_REFUND.id, aggregate: request.path, body: request.body }),
    correlationId: request.correlationId,
    body: request.body,
    async access(uow) {
      // the stored operation's scope, adopted with the access decision (D-SCOPE-B1)
      if (uow.commerceScope === null && (await uow.adoptScope("REFUND", refundId)) === null) throw new NotFoundFailure("refund");
    },
    recordDenial: (failure) => recordServiceDenial(rt, context, EXECUTE_REFUND.id, failure),
    ...(hold !== undefined ? { hold: (point, operation) => hold("CMD033", point, operation) } : {}),
  });
}

// --- CMD034 ReconcilePayment -----------------------------------------------------------------------------------------------------

/** How many times an application that lost a compare-and-swap to a concurrent writer is retried whole (the reconciler's STALE_VERSION). */
const APPLICATION_RETRIES = 3;

function isOrderObservation(value: StoredEvidence["normalized"]): value is ProviderOrderObservation {
  return typeof value === "object" && value !== null && "orderStatus" in value;
}

/** CMD034 ReconcilePayment (design §8 CMD034). */
export async function reconcilePayment(rt: PaymentRuntime, request: ServiceCommandRequest<ReconcilePaymentBody>): Promise<CommandResult<ReconcilePaymentView>> {
  const orderId = request.path["orderId"] as PaymentOrderId;
  const access = await serviceAccess<ReconcilePaymentView>(rt, RECONCILE_PAYMENT.id, request, { kind: "PAYMENT_ORDER", key: orderId });
  if ("kind" in access) return access;
  const context = serviceContext(request.identity, request.correlationId);
  const identity = identityOf(rt, request, access.agencyId, "CMD034");
  const digest = commandRequestDigest({ operation: RECONCILE_PAYMENT.id, aggregate: request.path, body: request.body });
  // the stored observation, read from the restricted store outside any transaction (07: no port call inside a transaction)
  let stored: StoredEvidence | null;
  try {
    stored = await rt.assembly.evidence.get(request.body.observationRef);
  } catch (e) {
    throw e instanceof DomainFailure ? e : new DomainFailure("CAPACITY_UNAVAILABLE", "the evidence store did not answer", { retryAfterSeconds: 1 }, true);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await rt.assembly.commerce.run(context, async (uow): Promise<{ readonly replay: boolean; readonly status: 200; readonly view: ReconcilePaymentView; readonly version: number }> => {
        if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) === null) throw new NotFoundFailure("payment_order");
        const reservation = await uow.journal.reserve(identity, digest, request.correlationId);
        if (reservation.kind === "REPLAY") {
          const body = reservation.entry.responseBody as ReconcilePaymentView | undefined;
          if (reservation.entry.responseStatus !== 200 || body === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
          return { replay: true, status: 200, view: body, version: body.order.version };
        }
        if (reservation.kind === "CONFLICT") throw new IdempotencyConflictFailure();
        if (reservation.kind === "PENDING") throw new DomainFailure("PRECONDITION_FAILED", "the same logical operation is still pending", { reason: "OPERATION_PENDING" }, true);
        const view = await applyStoredQuery(rt, uow, { orderId, stored, observationRef: request.body.observationRef, causationId: reservation.entryId as string as CausationId });
        await rt.assembly.hold?.("CMD034", "INTENT_BEFORE_COMMIT", null);
        const committed = await uow.journal.commit(reservation.entryId, { responseStatus: 200, responseBody: view, resourceKind: "payment_order", resourceId: orderId });
        if (committed.state !== "COMMITTED" || committed.responseStatus !== 200 || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
        return { replay: false, status: 200, view: committed.responseBody as ReconcilePaymentView, version: view.order.version };
      });
      return { kind: "COMPLETED", status: outcome.status, view: outcome.view, version: outcome.version, replayed: outcome.replay };
    } catch (e) {
      if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
      // a concurrent writer of an attempt or a refund won a compare-and-swap: the whole application is retried (nothing committed);
      // one that keeps losing is a conflict the caller retries with the same key
      if (e.code === "STALE_VERSION") {
        if (attempt < APPLICATION_RETRIES) continue;
        return rejection(new DomainFailure("CAPACITY_UNAVAILABLE", "the order kept changing under the application; retry with the same key", { retryAfterSeconds: 1 }, true), request.correlationId);
      }
      return rejection(e, request.correlationId);
    }
  }
}

/**
 * The application of one stored provider query to its order, inside the caller's SERVICE unit of work that adopted the order's
 * agency: the evidence must exist, be a provider query about this order, provider and environment, and classify through the
 * provider adapter (pure); the reconciler then applies it under the order's row lock (design §6.3).
 */
async function applyStoredQuery(rt: PaymentRuntime, uow: CommerceUnitOfWork, input: { readonly orderId: PaymentOrderId; readonly stored: StoredEvidence | null; readonly observationRef: string; readonly causationId: CausationId }): Promise<ReconcilePaymentView> {
  const c = uow.commerce;
  const stored = input.stored;
  if (stored === null || stored.kind !== "PROVIDER_QUERY" || stored.authenticatedBy !== "PROVIDER_API_RESPONSE") {
    throw new DomainFailure("NOT_FOUND", "no stored, authenticated provider query under this reference", { reason: "EVIDENCE_NOT_FOUND" });
  }
  const order = await c.orders.get(input.orderId);
  if (order === null) throw new NotFoundFailure("payment_order");
  const mismatch = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the stored observation is about another order, provider or environment", { reason: "OBSERVATION_SUBJECT_MISMATCH" });
  const adapter = rt.assembly.provider;
  if (stored.provider !== order.provider || stored.environment !== order.environment || adapter.provider !== order.provider || adapter.environment !== order.environment || !isOrderObservation(stored.normalized)) throw mismatch();
  let observation: ProviderOrderObservation;
  try {
    observation = adapter.classifyOrderObservation(stored);
  } catch {
    throw mismatch();
  }
  // the query names this order's provider identity (a view by request identity of an order still being created names none yet)
  if (observation.providerOrderId !== null && observation.providerOrderId !== order.providerOrderId && !(order.providerOrderId === undefined && order.state === "CREATING")) throw mismatch();
  if (observation.providerOrderId === null && order.providerOrderId !== undefined) throw mismatch();
  causedBy(uow, input.causationId);
  const result = await rt.reconciler.applyOrderObservation(uow, {
    orderId: order.orderId,
    source: "PROVIDER_QUERY",
    observation,
    artifactRef: input.observationRef as EvidenceArtifactRef,
    causationId: input.causationId,
    now: rt.clock.now(),
  });
  return reconcileView(uow, order.orderId, result.effects);
}

async function reconcileView(uow: CommerceUnitOfWork, orderId: PaymentOrderId, effects: ReconcilePaymentView["effects"]): Promise<ReconcilePaymentView> {
  const c = uow.commerce;
  const order = await c.orders.get(orderId);
  if (order === null) throw new NotFoundFailure("payment_order");
  const attempts = await c.attempts.listForOrder(orderId);
  const captures = await c.captures.listForOrder(orderId);
  let authorization = await c.authorizations.findByQuote(order.quoteId);
  if (authorization === null) {
    for (const capture of captures) {
      authorization = await c.authorizations.findLiveByCapture(capture.captureId);
      if (authorization !== null) break;
    }
  }
  const openCases = await c.cases.listOpenForOrder(orderId);
  return {
    order: paymentOrderView(order, attempts),
    captures: captures.map(captureView),
    ...(authorization !== null ? { commercialAuthorization: authorizationView(authorization) } : {}),
    effects: effects.map((e) => ({ about: e.about, effect: e.effect })),
    openCases: openCases.map((k) => ({ caseId: k.caseId, kind: k.kind })),
  };
}

// --- the watchdog's settlement (D-PROTO-B4) ----------------------------------------------------------------------------------------

/** An attempt the watchdog found not yet due: its outbox delivery is rescheduled at the deadline. */
export class NotDueYet extends Error {
  constructor(readonly retryAt: UtcInstant) {
    super(`not due before ${retryAt}`);
    this.name = "NotDueYet";
  }
}

const LIVE = new Set(["DISPATCHING", "PROVIDER_PENDING", "UNCERTAIN"]);

/** The exact bytes of a stored observation: its JSON with money as decimal strings (the store keeps them content-addressed). */
function observationBytes(observation: ProviderOrderObservation): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(observation, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value)));
}

/**
 * The payment service queries the provider for the order of an attempt whose effect is unknown, outside any transaction, stores
 * the authenticated answer in the restricted store (PROVIDER_QUERY) and returns its reference: by the attempt's request identity
 * for a creation that never learned its provider order, by the provider order otherwise (15 "The adapter does not create another
 * order under a new local identity"; 10 "Provider adapter contract").
 */
export async function storeProviderQuery(rt: PaymentRuntime, input: { readonly providerOrderId?: string; readonly providerRequestId: string }): Promise<string> {
  const adapter = rt.assembly.provider;
  const observation = await adapter.observeOrder(input.providerOrderId !== undefined ? { providerOrderId: input.providerOrderId } : { providerRequestId: input.providerRequestId });
  const stored = await rt.assembly.evidence.put({
    kind: "PROVIDER_QUERY",
    provider: adapter.provider,
    environment: adapter.environment,
    capturedAt: observation.observedAt,
    authenticatedBy: "PROVIDER_API_RESPONSE",
    normalized: observation,
    integrationClass: adapter.integrationClass,
    bytes: observationBytes(observation),
  });
  return stored.artifactRef;
}

/**
 * The watchdog of one attempt (D-PROTO-B4): an attempt whose dispatch deadline passed while its effect is still unknown is
 * observed at the provider and the stored observation applied through CMD034 under the payment service's own identity, with a
 * journal key derived from the stored query (the same artifact is applied once). An attempt that settled meanwhile needs nothing;
 * one whose deadline has not come throws NotDueYet with it.
 */
export async function watchAttempt(rt: PaymentRuntime, orderId: PaymentOrderId, attemptId: PaymentAttemptId): Promise<"APPLIED" | "NOT_APPLICABLE"> {
  const context: ServiceContext = { kind: "SERVICE", serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId };
  const found = await rt.assembly.commerce.run(context, async (uow): Promise<{ readonly attempt: PaymentAttemptRecord; readonly providerOrderId?: string } | null> => {
    if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) === null) return null;
    const attempt = await uow.commerce.attempts.get(attemptId);
    const order = await uow.commerce.orders.get(orderId);
    if (attempt === null || order === null) return null;
    return { attempt, ...(order.providerOrderId !== undefined ? { providerOrderId: order.providerOrderId } : {}) };
  });
  if (found === null || !LIVE.has(found.attempt.state)) return "NOT_APPLICABLE";
  const deadline = found.attempt.dispatchDeadlineAt;
  if (deadline !== undefined && Date.parse(deadline) > rt.clock.nowMs()) throw new NotDueYet(deadline);
  const observationRef = await storeProviderQuery(rt, { ...(found.providerOrderId !== undefined ? { providerOrderId: found.providerOrderId } : {}), providerRequestId: found.attempt.providerRequestId });
  const result = await reconcilePayment(rt, {
    correlationId: context.correlationId,
    idempotencyKey: `watchdog-${observationRef}`,
    identity: rt.self,
    path: { orderId },
    body: { observationRef },
  });
  if (result.kind === "COMPLETED" || result.kind === "ACCEPTED") return "APPLIED";
  throw new DomainFailure(result.problem.code, `the watchdog's reconciliation of ${orderId} was answered ${result.problem.code}`, result.problem.reason !== undefined ? { reason: result.problem.reason } : {}, result.problem.retryable);
}

export type { ExecuteRefundBody, ReconcilePaymentBody };
