/**
 * The reads of the payments workflow (design §8.3, §10; implementation mandate M4): GetQuote, GetPaymentOrder and GetRefund for any
 * member of the agency (AGENCY_HEADER, AGENCY_READER) and GetRefundReview for a corporate owner in the finance scope of the refund
 * (STORED_OPERATION, KAURO_OWNER). B06's read discipline: the access decision first (a foreign and a nonexistent resource answer the
 * same NOT_FOUND), the caller's own policies, a durable fact of a denial, nothing else written; projections by the closed views.
 * Checkout readiness, the payment status and the next actions are derived from durable facts at read time (10 "A UI readiness flag
 * is informative"; D-PAY-B2): a browser return never changes what they say (S057).
 */
import type { CaptureFactRecord, CommercialAuthorizationRecord, PaymentOrderId, QuoteId, RefundComponents, RefundId, TaxDocumentRecord } from "@kauro/domain";
import { COMMITTING_REFUND_STATES, DomainFailure, NotFoundFailure, ZERO_COMPONENTS, deliveryPhaseOf, policyCovers, refundEffectsHash, refundableBalance } from "@kauro/domain";
import type { ReadRequest, ReadResult } from "../../queries/reads.js";
import { COMMERCE_READ_ROUTES, type CommerceReadOperationId } from "../response-schemas.js";
import type { PaymentOrderDetailView, QuoteView, RefundReviewView, RefundView } from "../views.js";
import { refundEffectsOf } from "./approve-refund.js";
import { quoteViewOf } from "./checkout.js";
import { authorizationView, captureView, componentsView, paymentOrderView, refundEffectsView, refundView, taxDocumentView } from "./projections.js";
import { readAdmissionSpecOf, runCommerceRead, type CommerceReadSpec, type CommerceRequestCollaborators, type CommerceRequestRuntime } from "./runtime.js";
import type { CommerceReadHandler } from "./unbound.js";

/** The read specs of COMMERCE_READ_ROUTES (path, scope, action token, summary, authority). */
export function commerceReadSpecOf(operationId: CommerceReadOperationId): CommerceReadSpec {
  const r = COMMERCE_READ_ROUTES[operationId];
  return Object.freeze({ operationId, method: "GET", path: r.path, action: r.action, scope: r.scope, summary: r.summary, authority: r.authority });
}

function subtract(a: RefundComponents, b: RefundComponents): RefundComponents {
  return { serviceCents: a.serviceCents - b.serviceCents, taxCents: a.taxCents - b.taxCents, excessCents: a.excessCents - b.excessCents };
}

export interface CommerceReadHandlers {
  readonly GetQuote: CommerceReadHandler<QuoteView>;
  readonly GetPaymentOrder: CommerceReadHandler<PaymentOrderDetailView>;
  readonly GetRefund: CommerceReadHandler<RefundView>;
  readonly GetRefundReview: CommerceReadHandler<RefundReviewView>;
}

export function createCommerceReadHandlers(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators): CommerceReadHandlers {
  const handler = <View>(operationId: CommerceReadOperationId, execute: (request: ReadRequest, spec: CommerceReadSpec) => Promise<ReadResult<View>>): CommerceReadHandler<View> => {
    const spec = commerceReadSpecOf(operationId);
    return { spec, admission: readAdmissionSpecOf(spec), execute: (request) => execute(request, spec) };
  };

  const getQuote = handler<QuoteView>("GetQuote", (request, spec) =>
    runCommerceRead(runtime, spec, request, async (uow, caller) => {
      const quote = await uow.commerce.quotes.get(request.path["quoteId"] as QuoteId);
      if (quote === null || quote.agencyId !== request.agencyId) throw new NotFoundFailure("quote");
      return quoteViewOf(uow, co, quote, caller.kind === "MEMBER" ? caller.membership.role : null, runtime.clock.now());
    }),
  );

  const getPaymentOrder = handler<PaymentOrderDetailView>("GetPaymentOrder", (request, spec) =>
    runCommerceRead(runtime, spec, request, async (uow) => {
      const c = uow.commerce;
      const order = await c.orders.get(request.path["orderId"] as PaymentOrderId);
      if (order === null || order.agencyId !== request.agencyId) throw new NotFoundFailure("payment_order");
      const attempts = await c.attempts.listForOrder(order.orderId);
      const captures: ReadonlyArray<CaptureFactRecord> = await c.captures.listForOrder(order.orderId);
      let authorization: CommercialAuthorizationRecord | null = null;
      const documents: TaxDocumentRecord[] = [];
      for (const capture of captures) {
        authorization ??= await c.authorizations.findLiveByCapture(capture.captureId);
        const invoice = await c.taxDocuments.findLiveInvoice(capture.captureId);
        if (invoice !== null) documents.push(invoice);
        for (const refund of await c.refunds.listForCapture(capture.captureId)) {
          const creditNote = await c.taxDocuments.findLiveCreditNote(refund.refundId);
          if (creditNote !== null) documents.push(creditNote);
        }
      }
      // a revoked entitlement of the order's purchase is still its history (a reversal or a full refund revoked it)
      if (authorization === null) {
        const ofQuote = await c.authorizations.findByQuote(order.quoteId);
        if (ofQuote !== null && ofQuote.orderId === order.orderId) authorization = ofQuote;
      }
      return {
        order: paymentOrderView(order, attempts),
        captures: captures.map(captureView),
        ...(authorization !== null ? { commercialAuthorization: authorizationView(authorization) } : {}),
        taxDocuments: documents.map(taxDocumentView),
      };
    }),
  );

  const getRefund = handler<RefundView>("GetRefund", (request, spec) =>
    runCommerceRead(runtime, spec, request, async (uow) => {
      const refund = await uow.commerce.refunds.get(request.path["refundId"] as RefundId);
      if (refund === null || refund.agencyId !== request.agencyId) throw new NotFoundFailure("refund");
      return refundView(refund);
    }),
  );

  const getRefundReview = handler<RefundReviewView>("GetRefundReview", (request, spec) =>
    runCommerceRead(runtime, spec, request, async (uow, caller) => {
      const c = uow.commerce;
      const refund = await c.refunds.get(request.path["refundId"] as RefundId);
      if (refund === null || caller.kind !== "OPERATOR" || refund.agencyId !== caller.agencyId) throw new NotFoundFailure("refund");
      const capture = await c.captures.get(refund.captureId);
      const order = await c.orders.get(refund.orderId);
      if (capture === null || order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the capture and order of a visible refund are visible to its finance scope");
      const committed = await c.captures.committedRefunds(capture.captureId);
      // what the other refunds of the capture commit: this refund's own approved intent, once it commits, is not "another"
      const own = refund.approved !== undefined && COMMITTING_REFUND_STATES.has(refund.state) ? refund.approved.amounts : ZERO_COMPONENTS;
      const others = subtract(committed, own);
      const refundable = refundableBalance(capture, others);
      const live = await c.authorizations.findLiveByCapture(capture.captureId);
      const phase = deliveryPhaseOf(live ?? (await c.authorizations.findByQuote(order.quoteId)));
      const proposal = refund.approved?.amounts ?? refund.proposed;
      const now = runtime.clock.now();
      const applicable: string[] = [];
      for (const policyId of await co.queries.activeRefundPolicies(uow, 20)) {
        const policy = await c.refundPolicies.get(policyId);
        if (policy !== null && policyCovers(policy, { at: now, origin: refund.origin, phase, balance: refundable, requested: proposal })) applicable.push(policyId);
      }
      const { effects, remaining } = refundEffectsOf(refund, capture.allocation, others, proposal, phase, live !== null);
      return {
        refund: refundView(refund),
        capture: captureView(capture),
        refundable: componentsView(refundable),
        termsHash: refund.termsHash,
        applicablePolicies: applicable,
        proposedEffects: refundEffectsView(effects, remaining, refundEffectsHash(effects)),
      };
    }),
  );

  return Object.freeze({ GetQuote: getQuote, GetPaymentOrder: getPaymentOrder, GetRefund: getRefund, GetRefundReview: getRefundReview });
}
