/**
 * CMD029 CapturePayment — POST /api/v1/payment-orders/{orderId}/capture — AGENCY_BILLING — scope AGENCY_HEADER — provider effect
 * CAPTURE (design §8 CMD029; D-PAY-B4, D-PROTO-B1..B6, D-CAP-B1, D-AUTH-B4; implementation mandate M4).
 *
 * The browser's `providerApprovalRef` is compared with the stored provider order and is never evidence of payment (S057, D-PAY-B4):
 * the capture is dispatched by the server, its authenticated result applied by the payment service's settle step (T3, SERVICE on
 * kauro_payment) through the one reconciler, which alone records a capture fact and issues the CommercialAuthorization — the request
 * handlers' role can write neither (B09-F1). A result whose outcome is unknown leaves the order CAPTURE_UNCERTAIN and answers 202;
 * the same key observes the provider order and never dispatches again (D-PROTO-B2).
 *
 * T1: access (B06 authorizer: AGENCY_BILLING) → journal → the order read without a lock → the shared halves in the platform's lock
 * order — the purchased subject of its quote, the order's own merchant route, the fiscal issuer and profile, the quote — then the
 * order FOR UPDATE. Preconditions: order visible (NOT_FOUND); the echo names its provider order (INVALID_REQUEST
 * PROVIDER_REFERENCE_MISMATCH); CREATED or APPROVED (ALREADY_PAID when CAPTURED; PAYMENT_PENDING while CAPTURING; PAYMENT_UNCERTAIN
 * while CAPTURE_UNCERTAIN; ORDER_NOT_CAPTURABLE otherwise, D-REQ-B4); no live or uncertain CAPTURE attempt; the quote
 * ACCEPTED_FOR_CHECKOUT (QUOTE_NOT_ACTIVE) with its price not expired before the capture starts (QUOTE_EXPIRED); every other blocker
 * of checkout readiness without the order's own payment state (the subject, deliverable capacity, the routes, the reviewed tax
 * rule); an adapter of the order's provider and environment and the payment service bound. Writes: the CAPTURE attempt PREPARED
 * with the digest of its exact request. T2: order CAPTURING, attempt DISPATCHING. T3/T4: 200 with the order, the capture fact, the
 * CommercialAuthorization issued in the capture's transaction or the blockers that kept it from issuing — or 202.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CheckoutBlocker, CommerceUnitOfWork, JournalEntryId, PaymentOrderId, PaymentOrderRecord, QuoteRecord, ServiceContext } from "@kauro/domain";
import { DomainFailure, InvalidRequestFailure, NotFoundFailure, blockerFailure, checkoutBlockers, instantMs } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CAPTURE_PAYMENT, type CapturePaymentBody } from "../contracts.js";
import type { CommerceReconciler } from "../ports.js";
import { MAX_ATTEMPTS_PER_OPERATION } from "../protocol.js";
import { operationOf, prepareProviderAttempt, providerEffectPhases, runProviderCommand, type ProviderCommandHooks } from "../core/provider-effects.js";
import { issuanceBlockers } from "../core/subject.js";
import type { CapturePaymentView } from "../views.js";
import { checkoutFactsOf, readCheckoutPrerequisites } from "./checkout.js";
import { authorizationView, captureView, paymentOrderView } from "./projections.js";
import {
  CommerceAccessDenied,
  admissionSpecOf,
  commerceDigestOf,
  commerceIdentityOf,
  providerServicesUnavailable,
  recordCommerceDenial,
  tenantContextOf,
  type CommerceRequestCollaborators,
  type CommerceRequestRuntime,
} from "./runtime.js";
import { unboundPaymentService, unboundProvider, type CommerceCommandHandler } from "./unbound.js";

const current = (order: PaymentOrderRecord) => ({ currentVersion: order.version, currentState: order.state });

/** The failure a capture answers for an order that is not CREATED or APPROVED (D-REQ-B4). */
function orderStateFailure(order: PaymentOrderRecord): DomainFailure | null {
  switch (order.state) {
    case "CREATED":
    case "APPROVED":
      return null;
    case "CAPTURED":
      return new DomainFailure("PRECONDITION_FAILED", "the order is already captured", { reason: "ALREADY_PAID", ...current(order) });
    case "CAPTURING":
      return new DomainFailure("PAYMENT_PENDING", "a capture of this order is in flight", { reason: "CAPTURE_IN_PROGRESS" }, true);
    case "CAPTURE_UNCERTAIN":
      return new DomainFailure("PAYMENT_UNCERTAIN", "a capture of this order may have happened: it is reconciled, never repeated", { reason: "CAPTURE_UNCERTAIN" });
    default:
      return new DomainFailure("PRECONDITION_FAILED", "the order is not capturable", { reason: "ORDER_NOT_CAPTURABLE", ...current(order) });
  }
}

/** The failure CMD029 answers for a checkout blocker (the agency's current state where the catalogue says so). */
async function blockerFailureOf(uow: CommerceUnitOfWork, blocker: CheckoutBlocker, quote: QuoteRecord): Promise<DomainFailure> {
  if (blocker === "AGENCY_NOT_ACTIVE") {
    const agency = await uow.agencies.get(quote.agencyId);
    if (agency === null) throw new DomainFailure("INTEGRITY_FAILURE", "the agency of a visible order is not visible");
    return new DomainFailure("PRECONDITION_FAILED", "the agency is not ACTIVE", { reason: "AGENCY_NOT_ACTIVE", currentVersion: agency.version, currentState: agency.state });
  }
  return blockerFailure(blocker);
}

export function capturePaymentHandler(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators, reconciler: CommerceReconciler): CommerceCommandHandler<CapturePaymentBody, CapturePaymentView> {
  const spec = CAPTURE_PAYMENT;
  return {
    spec,
    admission: admissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<CapturePaymentBody>): Promise<CommandResult<CapturePaymentView>> {
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      const adapter = co.provider ?? unboundProvider();

      const hooks: ProviderCommandHooks<CapturePaymentBody, CapturePaymentView> = {
        async intent(uow, body, causationId: CausationId, now: UtcInstant) {
          const c = uow.commerce;
          const orderId = envelope.path["orderId"] as PaymentOrderId;
          const seen = await c.orders.get(orderId);
          if (seen === null || seen.agencyId !== agencyId) throw new NotFoundFailure("payment_order");
          const quoteSeen = await c.quotes.get(seen.quoteId);
          if (quoteSeen === null) throw new DomainFailure("INTEGRITY_FAILURE", "the quote of a visible order is not visible");
          // the shared halves in the lock order (design §6.2), then the order's row lock
          const read = await readCheckoutPrerequisites(uow, co, quoteSeen, { provider: seen.provider, environment: seen.environment });
          await co.queries.awaitTransition(uow, "kauro.quotes", quoteSeen.quoteId);
          const quote = await c.quotes.get(seen.quoteId);
          if (quote === null) throw new NotFoundFailure("payment_order");
          // the order as it stands: the request handlers may lock it only in a claimable state (payment_orders_tenant_claim: a
          // provider-reported state is the payment service's to change, D-AUTH-B4), so a state they may not act on is answered
          // from the committed row, and a claimable one is locked FOR UPDATE and read again
          const standing = await c.orders.get(orderId);
          if (standing === null) throw new NotFoundFailure("payment_order");
          // the browser's echo names the stored provider order, or nothing is done (S057: a browser claim is never payment)
          if (standing.providerOrderId === undefined || body.providerApprovalRef !== standing.providerOrderId) {
            throw new InvalidRequestFailure([{ field: "providerApprovalRef", code: "UNKNOWN_REFERENCE" }], "PROVIDER_REFERENCE_MISMATCH");
          }
          const standingFailure = orderStateFailure(standing);
          if (standingFailure !== null) throw standingFailure;
          const order = await c.orders.lock(orderId);
          // a concurrent writer moved the order out of the claimable states while this command waited: answer its new state
          if (order === null) throw orderStateFailure((await c.orders.get(orderId)) ?? standing) ?? new NotFoundFailure("payment_order");
          const stateFailure = orderStateFailure(order);
          if (stateFailure !== null) throw stateFailure;
          const live = await c.attempts.findLive({ orderId, operation: "CAPTURE" });
          if (live !== null) {
            if (live.state === "UNCERTAIN") throw new DomainFailure("PAYMENT_UNCERTAIN", "a capture of this order may have happened: it is reconciled, never repeated", { reason: "CAPTURE_UNCERTAIN" });
            throw new DomainFailure("PAYMENT_PENDING", "a capture of this order is in flight under another key", { reason: "CAPTURE_IN_PROGRESS" }, true);
          }
          // the quote still governs checkout, and its price had not expired when the capture starts (15 "If the quote expires before
          // provider capture starts, checkout is blocked")
          if (quote.state !== "ACCEPTED_FOR_CHECKOUT") throw new DomainFailure("PRECONDITION_FAILED", "the quote no longer governs checkout", { reason: "QUOTE_NOT_ACTIVE" });
          if (instantMs(now) >= instantMs(quote.expiresAt)) throw new DomainFailure("PRECONDITION_FAILED", "the price expired before the capture started", { reason: "QUOTE_EXPIRED" });
          const facts = await checkoutFactsOf(uow, co, quote, read, { openOrder: null, paid: false }, now, runtime.clock);
          const first = checkoutBlockers(facts)[0];
          if (first !== undefined) throw await blockerFailureOf(uow, first, quote);
          if (co.provider === null || co.payment === null || co.provider.provider !== order.provider || co.provider.environment !== order.environment) throw providerServicesUnavailable();
          const tried = await c.attempts.countFor({ orderId, operation: "CAPTURE" });
          if (tried >= MAX_ATTEMPTS_PER_OPERATION) throw new DomainFailure("PRECONDITION_FAILED", "the capture attempts of this order are spent", { reason: "ORDER_NOT_CAPTURABLE", ...current(order) });
          const intentEntryId = causationId as string as JournalEntryId;
          const attempt = await prepareProviderAttempt(uow, { adapter, subject: { effect: "CAPTURE", order }, ordinal: tried + 1, intentEntryId, causationId, now });
          return { kind: "DISPATCH", operation: await operationOf(uow, "CAPTURE", intentEntryId, attempt) };
        },

        // the conclusive answer, from durable facts in the payment service's unit of work that settled (or re-read) the operation
        async conclude(serviceUow, operation) {
          const c = serviceUow.commerce;
          const order = await c.orders.get(operation.resource.id as PaymentOrderId);
          if (order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the settled order is visible to the payment service");
          const attempts = await c.attempts.listForOrder(order.orderId);
          const captures = await c.captures.listForOrder(order.orderId);
          // the capture this command's attempt observed; a capture first learned from another source (its webhook) otherwise
          const capture = captures.find((x) => x.attemptId === operation.attempt.attemptId) ?? [...captures].sort((a, b) => instantMs(b.firstObservedAt) - instantMs(a.firstObservedAt))[0] ?? null;
          const authorization = capture === null ? null : await c.authorizations.findLiveByCapture(capture.captureId);
          let blockers: ReadonlyArray<CheckoutBlocker> = [];
          if (capture !== null && capture.status === "COMPLETED" && authorization === null) {
            // why the money captured carries no entitlement (the documented revalidation or refund path follows)
            const quote = await c.quotes.get(order.quoteId);
            if (quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "the order's quote is visible to the payment service");
            const now = runtime.clock.now();
            blockers = issuanceBlockers(quote, await co.subjects.subjectOf(serviceUow, quote), await c.fiscal.currentProfile(quote.agencyId), capture.providerCompletedAt ?? now, now);
          }
          const view: CapturePaymentView = {
            order: paymentOrderView(order, attempts),
            ...(capture !== null ? { capture: captureView(capture) } : {}),
            ...(authorization !== null ? { commercialAuthorization: authorizationView(authorization) } : {}),
            authorizationBlockers: [...blockers],
          };
          return { kind: "CONCLUSIVE", status: 200, view, version: order.version, resourceKind: "payment_order", resourceId: order.orderId };
        },
      };

      const service: ServiceContext = { kind: "SERVICE", serviceId: co.paymentServiceId, correlationId: envelope.correlationId };
      const hold = co.protocolHold;
      return runProviderCommand<CapturePaymentBody, CapturePaymentView>({
        effect: "CAPTURE",
        phases: providerEffectPhases("CAPTURE", { adapter, reconciler, clock: runtime.clock }, hooks),
        adapter,
        clock: runtime.clock,
        principal: { unitOfWork: runtime.unitOfWork, context },
        service: { unitOfWork: co.payment ?? unboundPaymentService(), context: service },
        identity: commerceIdentityOf(spec, envelope),
        digest: commerceDigestOf(spec, envelope),
        correlationId: envelope.correlationId,
        body: envelope.body,
        async access(uow) {
          const decision = await runtime.authorizer.authorize(uow, { command: "CMD029", identity: envelope.subject.identity, agencyId });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD029", decision);
        },
        recordDenial: (failure) => recordCommerceDenial(runtime, context, "CMD029", failure, agencyId),
        ...(hold !== undefined ? { hold: (point, operation) => hold("CMD029", point, operation) } : {}),
      });
    },
  };
}
