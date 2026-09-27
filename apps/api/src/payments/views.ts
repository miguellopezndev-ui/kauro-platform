/**
 * The DTO projections the payment service's routes answer with (docs/design/B09-payments-fiscal.md §10, D-RESP-B1): the closed
 * views of @kauro/application commerce/views.ts built from durable records only — money as MoneyMinorUnits strings, provider
 * identities and evidence withheld exactly as the view definitions withhold them (the api's send guard validates every reply
 * against the compiled closed schemas before it is sent). `paymentStatus` and `nextActions` are derived at read time from
 * reconciled facts and are never authority (D-PAY-B2; 10 "A UI readiness flag is informative"): CHECKING while any effect of the
 * order is uncertain, never "pay again" then (15 "We are checking this payment").
 */
import type { CaptureView, CommercialAuthorizationView, MoneyComponentsView, PaymentNextAction, PaymentOrderView, PaymentStatus, RefundView } from "@kauro/application";
import type { CaptureFactRecord, CommercialAuthorizationRecord, PaymentAttemptRecord, PaymentOrderRecord, RefundComponents, RefundRecord } from "@kauro/domain";
import { formatMoney } from "@kauro/domain";

export function componentsView(c: RefundComponents): MoneyComponentsView {
  return { serviceCents: formatMoney(c.serviceCents), taxCents: formatMoney(c.taxCents), excessCents: formatMoney(c.excessCents) };
}

const UNCERTAIN_ATTEMPT = new Set(["UNCERTAIN"]);

/** D-PAY-B2: the agency's payment status of an order, from its reconciled state and its attempts. */
export function paymentStatusOf(order: Pick<PaymentOrderRecord, "state">, attempts: ReadonlyArray<Pick<PaymentAttemptRecord, "state" | "operation" | "refundId">>): PaymentStatus {
  if (order.state === "CAPTURE_UNCERTAIN" || attempts.some((a) => a.refundId === undefined && UNCERTAIN_ATTEMPT.has(a.state))) return "CHECKING";
  switch (order.state) {
    case "CAPTURED":
      return "CONFIRMED";
    case "FAILED":
    case "CANCELLED":
    case "EXPIRED":
      return "FAILED";
    default:
      return "PENDING";
  }
}

function nextActionsOf(order: PaymentOrderRecord, status: PaymentStatus): ReadonlyArray<PaymentNextAction> {
  if (status === "CHECKING") return ["REFRESH_STATUS", "CONTACT_SUPPORT"];
  switch (order.state) {
    case "CREATED":
      return ["APPROVE_AT_PROVIDER"];
    case "APPROVED":
      return ["CAPTURE"];
    case "INTENT_CREATED":
    case "CREATING":
    case "CAPTURING":
      return ["REFRESH_STATUS"];
    case "FAILED":
    case "CANCELLED":
    case "EXPIRED":
      return ["REQUEST_NEW_QUOTE"];
    default:
      return [];
  }
}

export function paymentOrderView(order: PaymentOrderRecord, attempts: ReadonlyArray<PaymentAttemptRecord>): PaymentOrderView {
  const status = paymentStatusOf(order, attempts);
  const checkout = (order.state === "CREATED" || order.state === "APPROVED") && order.providerOrderId !== undefined && order.providerApprovalUrl !== undefined ? { approvalUrl: order.providerApprovalUrl, providerOrderId: order.providerOrderId } : undefined;
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
    paymentStatus: status,
    nextActions: nextActionsOf(order, status),
    ...(checkout !== undefined ? { checkout } : {}),
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

export function refundView(r: RefundRecord): RefundView {
  const amounts = r.approved?.amounts ?? r.proposed;
  return {
    refundId: r.refundId,
    captureId: r.captureId,
    serviceCents: formatMoney(amounts.serviceCents),
    taxCents: formatMoney(amounts.taxCents),
    reasonCode: r.reasonCode,
    state: r.state,
    amountsBasis: r.approved !== undefined ? "APPROVED" : "PROPOSED",
    version: r.version,
    projectId: r.projectId,
    orderId: r.orderId,
    origin: r.origin,
    deliveryPhase: r.deliveryPhase,
    excessCents: formatMoney(amounts.excessCents),
    reviewRequired: r.state === "REQUESTED",
    requestedAt: r.requestedAt,
    ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
    ...(r.failureCode !== undefined ? { failureCode: r.failureCode } : {}),
    ...(r.rejected !== undefined ? { rejectionCode: r.rejected.code } : {}),
  };
}
