/**
 * Application contracts of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md): the seven command
 * specs, the DTO views and their closed response schemas, the closed request schemas, the outcome catalogues, the
 * provider/fiscal/evidence/service ports, the commerce authorizer port and the provider-effect protocol; and the commerce core
 * (implementation mandate M2: the planners, the reconciler, the provider-effect runtime, the commerce authorizer). The command
 * halves, the consumers and the routes are implementation mandates M3 and M4; the labelled contract fakes are the test-only subpath
 * @kauro/application/testing.
 */
export type {
  CommerceCommandId,
  CommercePrincipalKind,
  CommerceScope,
  ExternalEffect,
  CommerceCommandSpec,
  CreatePaymentOrderBody,
  CreatePaymentOrderResult,
  CapturePaymentBody,
  CapturePaymentResult,
  ReceivePaymentWebhookBody,
  ReceivePaymentWebhookResult,
  RequestRefundBody,
  RequestRefundResult,
  ApproveRefundBody,
  ApproveRefundResult,
  ExecuteRefundBody,
  ExecuteRefundResult,
  ReconcilePaymentBody,
  ReconcilePaymentResult,
} from "./contracts.js";
export { CREATE_PAYMENT_ORDER, CAPTURE_PAYMENT, RECEIVE_PAYMENT_WEBHOOK, REQUEST_REFUND, APPROVE_REFUND, EXECUTE_REFUND, RECONCILE_PAYMENT, COMMERCE_COMMANDS } from "./contracts.js";
export type {
  MoneyComponentsView,
  CommerceResourceAction,
  QuoteView,
  PaymentStatus,
  PaymentNextAction,
  CheckoutView,
  PaymentOrderView,
  CaptureView,
  CommercialAuthorizationView,
  RefundView,
  RefundEffectsView,
  RefundReviewView,
  TaxDocumentView,
  WebhookAck,
  PaymentOrderDetailView,
  CreatePaymentOrderView,
  CapturePaymentView,
  RequestRefundView,
  ApproveRefundView,
  ExecuteRefundView,
  ReconcilePaymentView,
} from "./views.js";
export type { CommerceServedCommandId, CommerceReadOperationId } from "./response-schemas.js";
export {
  MONEY_PATTERN,
  QUOTE_STATES,
  PAYMENT_STATUSES,
  PAYMENT_NEXT_ACTIONS,
  CHECKOUT_BLOCKER_TOKENS,
  RECONCILIATION_CASE_KIND_TOKENS,
  COMMERCE_RESOURCE_ACTIONS,
  COMMERCE_VIEW_DEFINITIONS,
  COMMERCE_COMMAND_RESPONSES,
  COMMERCE_READ_ROUTES,
  commerceCommandResponseSchemaId,
  commerceReadResponseSchemaId,
  buildCommerceResponseSchemas,
} from "./response-schemas.js";
export type { CommerceRequestSchemaCommand } from "./request-schemas.js";
export { COMMERCE_REQUEST_SCHEMAS } from "./request-schemas.js";
export { COMMERCE_COMMAND_OUTCOMES, COMMERCE_READ_OUTCOMES } from "./outcomes.js";
export type {
  CreateOrderIntent,
  CaptureIntent,
  RefundIntent,
  ProviderDispatchResult,
  ProviderOrderObservation,
  PaymentProviderAdapter,
  WebhookVerification,
  WebhookVerifier,
  EvidenceKind,
  StoredEvidence,
  ProviderEvidenceStore,
  FiscalIssuancePacket,
  FiscalSubmissionResult,
  FiscalDocumentBridge,
  ServiceAuthenticator,
  CommerceDenial,
  OperatorDecision,
  OperatorAssurance,
  ServiceDecision,
  CommerceAuthorizer,
  AdoptedScope,
  ReconcileResult,
  CommerceReconciler,
  CommerceEventDelivery,
  CommerceEventConsumer,
  PlatformBinding,
  DeliveryCapacityPort,
  SourceAvailabilityReader,
  SourceLineageReader,
  PurchaseRebinder,
} from "./ports.js";
export type { ProviderEffect, DurableOperation, IntentOutcome, DispatchTicket, SettleInput, SettleOutcome, ProviderCommandPhases } from "./protocol.js";
export { DISPATCH_TIMEOUT_SECONDS, DISPATCH_WATCHDOG_MARGIN_SECONDS, MAX_ATTEMPTS_PER_OPERATION, PENDING_POLL_AFTER_SECONDS } from "./protocol.js";

// the commerce core (implementation mandate M2; design §5, §6, §8.1)
export * from "./core/index.js";

// the served payment routes (stage-2 mandate M3: the payment service's side; D-API-B1)
export { COMMERCE_SERVED_COMMAND_IDS, isServedCommerceCommand, commerceCommandRouteResponses } from "./served.js";
