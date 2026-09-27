/**
 * Projections of the commerce records into the closed views of commerce/views (design §8.3, §10; B06 D-RESP-1, D-RESP-B1): money as
 * MoneyMinorUnits strings, no provider identifier the view withholds, no evidence, no approver identity, and the derived members —
 * the agency's payment status and next actions (D-PAY-B2), a quote's checkout readiness and discount provenance — computed from
 * durable facts at read time: informative, never authority (10 "A UI readiness flag is informative"). Every reply passes the api's
 * send guard against the same closed schemas.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  CaptureFactRecord,
  CheckoutBlocker,
  CommercialAuthorizationRecord,
  MembershipRole,
  PaymentAttemptRecord,
  PaymentOrderRecord,
  PriceEligibilitySnapshotRecord,
  QuoteRecord,
  RefundComponents,
  RefundEffects,
  RefundRecord,
  TaxDocumentRecord,
} from "@kauro/domain";
import { formatMoney, roleSatisfies } from "@kauro/domain";
import type {
  CaptureView,
  CommerceResourceAction,
  CommercialAuthorizationView,
  MoneyComponentsView,
  PaymentNextAction,
  PaymentOrderView,
  PaymentStatus,
  QuoteView,
  RefundEffectsView,
  RefundView,
  TaxDocumentView,
} from "../views.js";

export function componentsView(c: RefundComponents): MoneyComponentsView {
  return { serviceCents: formatMoney(c.serviceCents), taxCents: formatMoney(c.taxCents), excessCents: formatMoney(c.excessCents) };
}

/** The one applied discount's provenance (16 "the highest eligible rate, never a sum"): the founding slot, the repeat tier, or none. */
export function discountBasisOf(snapshot: Pick<PriceEligibilitySnapshotRecord, "appliedDiscountBps" | "foundingDiscountBps"> | null, discountBps: number): QuoteView["discount"]["basis"] {
  if (discountBps === 0) return "NONE";
  if (snapshot !== null && snapshot.foundingDiscountBps > 0 && snapshot.foundingDiscountBps === snapshot.appliedDiscountBps) return "FOUNDING";
  return "REPEAT";
}

/**
 * The quote the agency reviews and pays: its immutable terms, both expiries, the checkout blockers derived from the facts the
 * caller's unit of work read (commerce/authority checkoutBlockers), and the payment command the caller may issue — CreatePaymentOrder
 * for a member whose role holds AGENCY_BILLING, while the quote is ready and no checkout of its project is open.
 */
export function quoteView(quote: QuoteRecord, snapshot: PriceEligibilitySnapshotRecord | null, blockers: ReadonlyArray<CheckoutBlocker>, options: { readonly role: MembershipRole | null; readonly openCheckout: boolean }): QuoteView {
  const ready = blockers.length === 0;
  const actions: CommerceResourceAction[] = [];
  if (ready && !options.openCheckout && options.role !== null && roleSatisfies("AGENCY_BILLING", options.role)) actions.push("CMD028");
  return {
    quoteId: quote.quoteId,
    agencyId: quote.agencyId,
    projectId: quote.projectId,
    revisionHash: quote.revisionHash,
    planHash: quote.planHash,
    billableUnits: quote.billableUnits,
    mode: quote.mode,
    pricePolicyVersion: quote.pricePolicyVersion,
    discountPolicyVersion: quote.discountPolicyVersion,
    baseServiceCents: formatMoney(quote.baseServiceCents),
    discountCents: formatMoney(quote.discountCents),
    serviceCents: formatMoney(quote.serviceCents),
    taxCents: formatMoney(quote.taxCents),
    totalCents: formatMoney(quote.totalCents),
    currency: quote.currency,
    expiresAt: quote.expiresAt,
    sourceAvailableUntil: quote.sourceAvailableUntil,
    termsHash: quote.termsHash,
    version: quote.version,
    state: quote.state,
    discount: { bps: quote.discountBps, basis: discountBasisOf(snapshot, quote.discountBps) },
    taxTreatment: quote.tax.treatment,
    issuedAt: quote.issuedAt,
    checkoutReady: ready,
    checkoutBlockers: [...blockers],
    permittedActions: actions,
  };
}

const UNCERTAIN_ATTEMPT = "UNCERTAIN";

/**
 * The agency's payment status (D-PAY-B2; 15 "Payment state transitions"): CONFIRMED only from a reconciled capture (the order
 * CAPTURED), CHECKING while any effect is uncertain — a capture or a creation whose outcome is unknown — with next actions that never
 * include paying again (15 "discourage paying again while uncertain"), FAILED for an order that failed, was cancelled or expired, and
 * PENDING while the checkout is in flight. A browser return never changes it: it is read from durable facts only (S057).
 *
 * CONFIRMED needs the obligation paid, not only a capture recorded (decision D-INT2-B5; 15 "CONFIRMED requires provider evidence"):
 * a completed capture of the wrong amount moves the order to CAPTURED with only its allocation (S058: real money of the order,
 * never its payment, an AMOUNT_MISMATCH case open and its remedy filed), so an order whose completed captures allocate less than
 * its obligation reads CHECKING with support as its next action — never "Payment confirmed", never "pay again".
 */
export function paymentStatusOf(order: Pick<PaymentOrderRecord, "state" | "allocatedCents" | "expectedAmountCents">, attempts: ReadonlyArray<Pick<PaymentAttemptRecord, "state">>): { readonly paymentStatus: PaymentStatus; readonly nextActions: ReadonlyArray<PaymentNextAction> } {
  if (order.state === "CAPTURED") return order.allocatedCents >= order.expectedAmountCents ? { paymentStatus: "CONFIRMED", nextActions: [] } : { paymentStatus: "CHECKING", nextActions: ["CONTACT_SUPPORT"] };
  if (order.state === "CAPTURE_UNCERTAIN" || attempts.some((a) => a.state === UNCERTAIN_ATTEMPT)) return { paymentStatus: "CHECKING", nextActions: ["REFRESH_STATUS", "CONTACT_SUPPORT"] };
  switch (order.state) {
    case "FAILED":
    case "CANCELLED":
      return { paymentStatus: "FAILED", nextActions: ["CONTACT_SUPPORT"] };
    case "EXPIRED":
      return { paymentStatus: "FAILED", nextActions: ["REQUEST_NEW_QUOTE"] };
    case "CREATED":
      return { paymentStatus: "PENDING", nextActions: ["APPROVE_AT_PROVIDER", "CAPTURE"] };
    case "APPROVED":
      return { paymentStatus: "PENDING", nextActions: ["CAPTURE"] };
    default:
      return { paymentStatus: "PENDING", nextActions: ["REFRESH_STATUS"] };
  }
}

/** The reconciled payment order; the checkout (the provider's approval page) while the buyer can approve at the provider. */
export function paymentOrderView(order: PaymentOrderRecord, attempts: ReadonlyArray<Pick<PaymentAttemptRecord, "state">>): PaymentOrderView {
  const { paymentStatus, nextActions } = paymentStatusOf(order, attempts);
  const checkoutOpen = (order.state === "CREATED" || order.state === "APPROVED") && order.providerOrderId !== undefined && order.providerApprovalUrl !== undefined;
  return {
    orderId: order.orderId,
    quoteId: order.quoteId,
    provider: order.provider,
    environment: order.environment,
    ...(order.providerOrderId !== undefined ? { providerOrderId: order.providerOrderId } : {}),
    expectedAmountCents: formatMoney(order.expectedAmountCents),
    currency: order.currency,
    state: order.state,
    version: order.version,
    projectId: order.projectId,
    paymentStatus,
    nextActions: [...nextActions],
    ...(checkoutOpen ? { checkout: { approvalUrl: order.providerApprovalUrl as string, providerOrderId: order.providerOrderId as string } } : {}),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function captureView(capture: CaptureFactRecord): CaptureView {
  return {
    captureId: capture.captureId,
    orderId: capture.orderId,
    environment: capture.environment,
    amountCents: formatMoney(capture.amountCents),
    currency: capture.currency,
    status: capture.status,
    observedAt: capture.observedAt,
    allocated: componentsView(capture.allocation),
    version: capture.version,
  };
}

export function authorizationView(a: CommercialAuthorizationRecord): CommercialAuthorizationView {
  return {
    authorizationId: a.authorizationId,
    agencyId: a.agencyId,
    projectId: a.projectId,
    approvalHash: a.approvalHash,
    quoteId: a.quoteId,
    captureId: a.captureId,
    revisionHash: a.revisionHash,
    planHash: a.planHash,
    capabilityVersion: a.capabilityVersion,
    createdAt: a.createdAt,
    ...(a.revokedAt !== undefined ? { revokedAt: a.revokedAt } : {}),
    version: a.version,
    state: a.state,
    mode: a.mode,
    billableUnits: a.billableUnits,
    honoredAfterPriceExpiry: a.honoredAfterPriceExpiry,
    ...(a.revocationPhase !== undefined ? { revocationPhase: a.revocationPhase } : {}),
  };
}

/**
 * A refund as the agency may see it: the reviewer-visible proposal until approval, then the immutable approved intent (amountsBasis
 * says which; Q-B09-2), the reason verbatim (a label, answered to the agency and never in an event), never the approver or the
 * provider's refund id.
 */
export function refundView(refund: RefundRecord): RefundView {
  const amounts = refund.approved?.amounts ?? refund.proposed;
  return {
    refundId: refund.refundId,
    captureId: refund.captureId,
    serviceCents: formatMoney(amounts.serviceCents),
    taxCents: formatMoney(amounts.taxCents),
    reasonCode: refund.reasonCode,
    state: refund.state,
    amountsBasis: refund.approved !== undefined ? "APPROVED" : "PROPOSED",
    version: refund.version,
    projectId: refund.projectId,
    orderId: refund.orderId,
    origin: refund.origin,
    deliveryPhase: refund.deliveryPhase,
    excessCents: formatMoney(amounts.excessCents),
    reviewRequired: refund.state === "REQUESTED",
    requestedAt: refund.requestedAt,
    ...(refund.completedAt !== undefined ? { completedAt: refund.completedAt } : {}),
    ...(refund.failureCode !== undefined ? { failureCode: refund.failureCode } : {}),
    ...(refund.rejected !== undefined ? { rejectionCode: refund.rejected.code } : {}),
  };
}

/** The prepared effects of an approval (CMD032 precondition "commission/fiscal effects are prepared"): what stays refundable after it. */
export function refundEffectsView(effects: RefundEffects, remaining: RefundComponents, effectsHash: RefundEffectsView["effectsHash"]): RefundEffectsView {
  return {
    creditNoteRequired: effects.creditNoteRequired,
    serviceBasisAfterCents: effects.serviceBasisAfterCents,
    revokesAuthorization: effects.revokesAuthorization,
    remaining: componentsView(remaining),
    effectsHash,
  };
}

export function taxDocumentView(d: TaxDocumentRecord): TaxDocumentView {
  return {
    documentId: d.documentId,
    paymentOrderId: d.orderId,
    kind: d.kind,
    state: d.state,
    ...(d.legalNumber !== undefined ? { legalNumber: d.legalNumber } : {}),
    serviceCents: formatMoney(d.serviceCents),
    taxCents: formatMoney(d.taxCents),
    version: d.version,
    taxTreatment: d.taxTreatment,
    ...(d.blockedReason !== undefined ? { blockedReason: d.blockedReason } : {}),
    ...(d.issuedAt !== undefined ? { issuedAt: d.issuedAt as UtcInstant } : {}),
  };
}
