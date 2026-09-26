/**
 * The request side of the payments workflow (package B09, implementation mandate M4; design §14): the agency member's commands
 * CMD028 CreatePaymentOrder, CMD029 CapturePayment and CMD031 RequestRefund, the corporate owner's CMD032 ApproveRefund, and the
 * reads GetQuote, GetPaymentOrder, GetRefund and GetRefundReview — assembled over one runtime and the collaborators a deployment
 * binds (D-REQ-B1). The provider-effect commands settle through the commerce core's one reconciler in the payment service's units
 * of work; the api composition registers every handler returned here.
 */
import type { CapturePaymentBody, CreatePaymentOrderBody, RequestRefundBody, ApproveRefundBody } from "../contracts.js";
import { createCommerceReconciler } from "../core/reconciler.js";
import type { ApproveRefundView, CapturePaymentView, CreatePaymentOrderView, RequestRefundView } from "../views.js";
import { approveRefundHandler } from "./approve-refund.js";
import { capturePaymentHandler } from "./capture-payment.js";
import { createPaymentOrderHandler } from "./create-payment-order.js";
import { createCommerceReadHandlers, type CommerceReadHandlers } from "./reads.js";
import { requestRefundHandler } from "./request-refund.js";
import type { CommerceRequestCollaborators, CommerceRequestRuntime } from "./runtime.js";
import type { CommerceCommandHandler } from "./unbound.js";

export interface CommerceRequestHandlers {
  readonly commands: {
    readonly CMD028: CommerceCommandHandler<CreatePaymentOrderBody, CreatePaymentOrderView>;
    readonly CMD029: CommerceCommandHandler<CapturePaymentBody, CapturePaymentView>;
    readonly CMD031: CommerceCommandHandler<RequestRefundBody, RequestRefundView>;
    readonly CMD032: CommerceCommandHandler<ApproveRefundBody, ApproveRefundView>;
  };
  readonly reads: CommerceReadHandlers;
}

export function createCommerceRequestHandlers(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators): CommerceRequestHandlers {
  // the one reconciler of every capture path (design §6.3), over the purchased subject as the payment service reads it (D-CORE-B2)
  const reconciler = createCommerceReconciler({ subjects: co.subjects, approvalHosts: co.provider?.approvalHosts ?? [] });
  return Object.freeze({
    commands: Object.freeze({
      CMD028: createPaymentOrderHandler(runtime, co, reconciler),
      CMD029: capturePaymentHandler(runtime, co, reconciler),
      CMD031: requestRefundHandler(runtime, co),
      CMD032: approveRefundHandler(runtime, co),
    }),
    reads: createCommerceReadHandlers(runtime, co),
  });
}

export type { CommerceRequestQueries, CommerceRequestCollaborators, CommerceRequestRuntime, CommerceOutcome, CommerceCommandRun, CommerceReadSpec, ReadCaller, ProtocolHold } from "./runtime.js";
export {
  CommerceAccessDenied,
  providerServicesUnavailable,
  runCommerceCommand,
  runCommerceRead,
  recordCommerceDenial,
  recordOperatorDenial,
  admissionSpecOf,
  readAdmissionSpecOf,
  commerceIdentityOf,
  commerceDigestOf,
  tenantContextOf,
  operatorContextOf,
  versionOfView,
} from "./runtime.js";
export type { CommerceCommandHandler, CommerceReadHandler } from "./unbound.js";
export { unboundProvider, unboundPaymentService } from "./unbound.js";
export type { CheckoutPrerequisites } from "./checkout.js";
export { readCheckoutPrerequisites, revisionForCheckout, capacityForCheckout, quoteIsPaid, checkoutFactsOf, quoteViewOf } from "./checkout.js";
export { componentsView, discountBasisOf, quoteView, paymentStatusOf, paymentOrderView, captureView, authorizationView, refundView, refundEffectsView, taxDocumentView } from "./projections.js";
export { createPaymentOrderHandler } from "./create-payment-order.js";
export { capturePaymentHandler } from "./capture-payment.js";
export { requestRefundHandler } from "./request-refund.js";
export { approveRefundHandler, refundEffectsOf, STANDING_POLICY_APPLIED } from "./approve-refund.js";
export type { CommerceReadHandlers } from "./reads.js";
export { createCommerceReadHandlers, commerceReadSpecOf } from "./reads.js";
