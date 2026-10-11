/**
 * CMD028 CreatePaymentOrder — POST /api/v1/quotes/{quoteId}/payment-orders — AGENCY_BILLING — scope AGENCY_HEADER — provider effect
 * CREATE_ORDER (design §8 CMD028; D-PROTO-B1..B6, D-CAP-B1, D-QUOTE-B7; implementation mandate M4).
 *
 * The provider-effect protocol of the commerce core (runProviderCommand): T1, T2 and T4 in the agency member's own unit of work
 * (TENANT, kauro_app), T3 in a SERVICE unit of work of the payment service (kauro_payment) that adopts the order's agency through the
 * scope index and applies the provider's answer through the one reconciler (D-PROTO-B5, D-AUTH-B4).
 *
 * T1: access (B06 authorizer: AGENCY_BILLING) → journal reserve → the shared halves in the platform's lock order — the purchased
 * subject (agency, capability, approval, source revision, target contract), the QUALIFIED merchant route of the bound adapter's
 * provider and environment, the fiscal issuer, the fiscal profile — then the quote: FOR UPDATE while it is ISSUED (this command
 * accepts it), its shared half once it is ACCEPTED_FOR_CHECKOUT (a later order of the same quote only relies on it; the one-open-
 * order index decides between two first acceptances). Preconditions, the first failure answering: quote visible and not a
 * replacement (NOT_FOUND); termsHash (STALE_VERSION HASH_MISMATCH); then checkout readiness in the domain's order (agency ACTIVE,
 * quote ISSUED or ACCEPTED_FOR_CHECKOUT, price not expired, not already paid, no uncertain or in-progress checkout of the project,
 * source SEALED within its effective deadline, approval and target current, capability offered, deliverable capacity, merchant
 * route and fiscal issuer qualified, the quoted reviewed tax rule still the current one); then an adapter and the payment service
 * bound (INTEGRITY_FAILURE PROVIDER_SERVICES_UNAVAILABLE). Writes: the quote ACCEPTED_FOR_CHECKOUT (first order only), the order
 * INTENT_CREATED with its payment intent hash, the PAYMENT_ORDER scope row, the CREATE_ORDER attempt PREPARED with the digest of its
 * exact request — each version with its event — and COMMIT. T2 claims; the call; T3 settles; T4 answers 201 with the order (its
 * checkout) and the accepted quote, or 202 with the durable operation while the creation's outcome is unknown.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CheckoutBlocker, CommerceUnitOfWork, JournalEntryId, MembershipRole, PaymentOrderId, QuoteId, QuoteRecord, ResolvedMembership, ServiceContext } from "@kauro/domain";
import {
  DomainFailure,
  NotFoundFailure,
  StaleVersionFailure,
  blockerFailure,
  checkoutBlockers,
  paymentIntentHash,
} from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { CREATE_PAYMENT_ORDER, type CreatePaymentOrderBody } from "../contracts.js";
import type { CommerceReconciler } from "../ports.js";
import { operationOf, prepareProviderAttempt, providerEffectPhases, runProviderCommand, type ProviderCommandHooks } from "../core/provider-effects.js";
import type { CreatePaymentOrderView } from "../views.js";
import { checkoutFactsOf, quoteIsPaid, quoteViewOf, readCheckoutPrerequisites } from "./checkout.js";
import { paymentOrderView } from "./projections.js";
import {
  CommerceAccessDenied,
  admissionSpecOf,
  commerceDigestOf,
  commerceIdentityOf,
  providerServicesUnavailable,
  recordCommerceDenial,
  resultOf,
  tenantContextOf,
  type CommerceRequestCollaborators,
  type CommerceRequestRuntime,
} from "./runtime.js";
import { unboundPaymentService, unboundProvider, type CommerceCommandHandler } from "./unbound.js";
import { isBankTransferRequest, issueBankTransfer } from "../bank/instructions.js";

/** The failure CMD028 answers for its first checkout blocker (the quote's and the agency's current state where the catalogue says so). */
async function checkoutFailure(uow: CommerceUnitOfWork, blocker: CheckoutBlocker, quote: QuoteRecord, openOrderState: string | null): Promise<DomainFailure> {
  switch (blocker) {
    case "QUOTE_NOT_ACTIVE":
    case "QUOTE_EXPIRED":
      return new DomainFailure("PRECONDITION_FAILED", `commercial prerequisite not met: ${blocker}`, { reason: blocker, currentVersion: quote.version, currentState: quote.state });
    case "AGENCY_NOT_ACTIVE": {
      const agency = await uow.agencies.get(quote.agencyId);
      if (agency === null) throw new DomainFailure("INTEGRITY_FAILURE", "the agency of a visible quote is not visible");
      return new DomainFailure("PRECONDITION_FAILED", "the agency is not ACTIVE", { reason: "AGENCY_NOT_ACTIVE", currentVersion: agency.version, currentState: agency.state });
    }
    case "PAYMENT_IN_PROGRESS":
      // the project's open checkout is still being created at the provider, or being captured (design §8 CMD028; D-REQ-B3)
      return new DomainFailure("PAYMENT_PENDING", "the project's open order is in progress", { reason: openOrderState === "CAPTURING" ? "CAPTURE_IN_PROGRESS" : "CREATION_IN_PROGRESS" }, true);
    default:
      return blockerFailure(blocker);
  }
}

export function createPaymentOrderHandler(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators, reconciler: CommerceReconciler): CommerceCommandHandler<CreatePaymentOrderBody, CreatePaymentOrderView> {
  const spec = CREATE_PAYMENT_ORDER;
  return {
    spec,
    admission: admissionSpecOf(spec),
    async execute(envelope: CommandEnvelope<CreatePaymentOrderBody>): Promise<CommandResult<CreatePaymentOrderView>> {
      // Payments V1 (lane L-ROUTE): the bank-transfer route issues instructions in one unit of work, no provider effect
      if ((envelope.body.routeKind === undefined) !== (envelope.body.routeId === undefined)) {
        return resultOf(new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: envelope.body.routeKind === undefined ? "routeKind" : "routeId", code: "REQUIRED" }] }), envelope.correlationId);
      }
      if (isBankTransferRequest(envelope.body)) return issueBankTransfer(runtime, co, envelope);
      const context = tenantContextOf(envelope);
      const agencyId = context.agencyId;
      const adapter = co.provider ?? unboundProvider();
      let membership: ResolvedMembership | null = null;

      const hooks: ProviderCommandHooks<CreatePaymentOrderBody, CreatePaymentOrderView> = {
        async intent(uow, body, causationId: CausationId, now: UtcInstant) {
          const c = uow.commerce;
          const quoteId = envelope.path["quoteId"] as QuoteId;
          const seen = await c.quotes.get(quoteId);
          // a replacement quote is never charged: it is accepted only by the payment service's re-binding (D-QUOTE-B6)
          if (seen === null || seen.agencyId !== agencyId || seen.replacesQuoteId !== undefined) throw new NotFoundFailure("quote");
          const read = await readCheckoutPrerequisites(uow, co, seen, co.provider === null ? null : { provider: co.provider.provider, environment: co.provider.environment });
          // the quote after the route, issuer and profile (design §6.2): the writer's row lock while ISSUED, the shared half once accepted
          let quote: QuoteRecord | null;
          if (seen.state === "ISSUED") {
            quote = await c.quotes.lock(quoteId);
          } else {
            await co.queries.awaitTransition(uow, "kauro.quotes", quoteId);
            quote = await c.quotes.get(quoteId);
          }
          if (quote === null) throw new NotFoundFailure("quote");
          if (body.termsHash !== quote.termsHash) throw new StaleVersionFailure(quote.version, quote.state, { reason: "HASH_MISMATCH", mismatch: ["termsHash"] });
          const openOrder = await c.orders.findOpenForProject(quote.projectId);
          const paid = await quoteIsPaid(uow, co, quote);
          const facts = await checkoutFactsOf(uow, co, quote, read, { openOrder, paid }, now, runtime.clock);
          // without a bound adapter no merchant route can be named: its blocker then stands for the unbound adapter, answered last
          const first = checkoutBlockers(facts).find((b) => !(co.provider === null && b === "PAYMENT_ROUTE_UNQUALIFIED"));
          if (first !== undefined) throw await checkoutFailure(uow, first, quote, openOrder?.state ?? null);
          if (co.provider === null || co.payment === null || read.route === null) throw providerServicesUnavailable();
          const route = read.route;
          if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "a checkout was authorized without a membership");
          // writes: the terms accepted for checkout (first order of the quote), the durable intent, its scope row, the prepared attempt
          if (quote.state === "ISSUED") {
            const accepted = await c.quotes.transition(quoteId, quote.version, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
            if (accepted.kind === "STALE") throw new StaleVersionFailure(accepted.currentVersion, accepted.currentState);
          }
          const orderId = uow.ids.next() as PaymentOrderId;
          const intentEntryId = causationId as string as JournalEntryId;
          const order = await c.orders.insert({
            orderId,
            agencyId,
            projectId: quote.projectId,
            quoteId,
            approvalId: quote.approvalId,
            route: { routeId: route.routeId, provider: route.provider, environment: route.environment, merchantRef: route.merchantRef, payeeDigest: route.payeeDigest, currency: route.currency },
            expectedAmountCents: quote.totalCents,
            expectedServiceCents: quote.serviceCents,
            expectedTaxCents: quote.taxCents,
            termsHash: quote.termsHash,
            // KAURO_PAYMENT_INTENT_V1: the quote, its terms, the amount, the currency, the route, the provider and the environment
            idempotencyHash: paymentIntentHash({ quoteId, termsHash: quote.termsHash, expectedAmountCents: quote.totalCents.toString(), currency: "USD", routeId: route.routeId, provider: route.provider, environment: route.environment }),
            createdByMembershipId: membership.membershipId,
            intentEntryId,
            createdAt: now,
          });
          await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId, orderId }, now);
          const attempt = await prepareProviderAttempt(uow, { adapter, subject: { effect: "CREATE_ORDER", order }, ordinal: 1, intentEntryId, causationId, now });
          return { kind: "DISPATCH", operation: await operationOf(uow, "CREATE_ORDER", intentEntryId, attempt) };
        },

        // the conclusive answer, from durable facts in the payment service's unit of work that settled (or re-read) the operation
        async conclude(serviceUow, operation) {
          const c = serviceUow.commerce;
          const order = await c.orders.get(operation.resource.id as PaymentOrderId);
          if (order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the settled order is visible to the payment service");
          const quote = await c.quotes.get(order.quoteId);
          if (quote === null) throw new DomainFailure("INTEGRITY_FAILURE", "the order's quote is visible to the payment service");
          const attempts = await c.attempts.listForOrder(order.orderId);
          const role: MembershipRole | null = membership?.role ?? null;
          const view: CreatePaymentOrderView = { order: paymentOrderView(order, attempts), quote: await quoteViewOf(serviceUow, co, quote, role, runtime.clock.now()) };
          return { kind: "CONCLUSIVE", status: 201, view, version: order.version, resourceKind: "payment_order", resourceId: order.orderId };
        },
      };

      const service: ServiceContext = { kind: "SERVICE", serviceId: co.paymentServiceId, correlationId: envelope.correlationId };
      const hold = co.protocolHold;
      return runProviderCommand<CreatePaymentOrderBody, CreatePaymentOrderView>({
        effect: "CREATE_ORDER",
        phases: providerEffectPhases("CREATE_ORDER", { adapter, reconciler, clock: runtime.clock }, hooks),
        adapter,
        clock: runtime.clock,
        principal: { unitOfWork: runtime.unitOfWork, context },
        service: { unitOfWork: co.payment ?? unboundPaymentService(), context: service },
        identity: commerceIdentityOf(spec, envelope),
        digest: commerceDigestOf(spec, envelope),
        correlationId: envelope.correlationId,
        body: envelope.body,
        async access(uow) {
          const decision = await runtime.authorizer.authorize(uow, { command: "CMD028", identity: envelope.subject.identity, agencyId });
          if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD028", decision);
          membership = decision.membership;
        },
        recordDenial: (failure) => recordCommerceDenial(runtime, context, "CMD028", failure, agencyId),
        ...(hold !== undefined ? { hold: (point, operation) => hold("CMD028", point, operation) } : {}),
      });
    },
  };
}
