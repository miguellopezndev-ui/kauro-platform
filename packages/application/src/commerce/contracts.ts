/**
 * The seven payment commands of package B09 (registry commands CMD028..CMD034; reference/COMMAND_CATALOGUE): body (exactly the
 * registry fields), result view, and the spec the transport, the authorizer and the runtime consume. Behaviour — reads, locks,
 * preconditions in order, writes, events, provider effects and OK/DENY/RACE — is specified in docs/design/B09-payments-fiscal.md
 * §8; the handlers implementing these contracts are implementation mandate M3.
 *
 * B09 needs three things the B06 CommandSpec does not describe, so its spec is its own type:
 * - the principal: an agency member (AGENCY_BILLING), a corporate operator (KAURO_OWNER), a payment service (PAYMENT_SERVICE)
 *   or an authenticated provider (AUTHENTICATED_PROVIDER);
 * - the scope: the active-agency header (B06 D-SCOPE-1), the stored operation (COMMAND_CATALOGUE "Service commands require a
 *   verified service identity and audience, with scope derived from the stored operation") or the provider ingress;
 * - the external effect and the idempotency store: the command journal, or the provider inbox for the webhook (D-IDEM-B1).
 */
import type { MoneyMinorUnits } from "@kauro/contracts";
import type { CheckoutBlocker } from "@kauro/domain";
import type { CaptureView, CheckoutView, CommercialAuthorizationView, MoneyComponentsView, PaymentOrderView, RefundView, WebhookAck } from "./views.js";

export type CommerceCommandId = "CMD028" | "CMD029" | "CMD030" | "CMD031" | "CMD032" | "CMD033" | "CMD034";

export type CommercePrincipalKind = "AGENCY_MEMBER" | "CORPORATE_OPERATOR" | "PAYMENT_SERVICE" | "PROVIDER";

export type CommerceScope = "AGENCY_HEADER" | "STORED_OPERATION" | "PROVIDER_INGRESS";

export type ExternalEffect = "NONE" | "PROVIDER_CREATE_ORDER" | "PROVIDER_CAPTURE" | "PROVIDER_REFUND";

export interface CommerceCommandSpec<Body> {
  readonly id: CommerceCommandId;
  readonly name: string;
  readonly method: "POST";
  readonly path: string;
  /** The catalogue role (commands.json through @kauro/contracts, brand-mapped: KAURO_OWNER). */
  readonly role: "AGENCY_BILLING" | "KAURO_OWNER" | "PAYMENT_SERVICE" | "AUTHENTICATED_PROVIDER";
  readonly principal: CommercePrincipalKind;
  readonly scope: CommerceScope;
  /** The path parameter naming the aggregate (or, for the webhook, the provider label). */
  readonly aggregateParam: string;
  /** STORED_OPERATION: the scope-index kind the path id resolves through (D-SCOPE-B1). */
  readonly scopeKind: "PAYMENT_ORDER" | "REFUND" | null;
  readonly expectedVersionRequired: boolean;
  /** Fields whose values are hashes the server recomputes and compares (10: high-impact commands name exact authority hashes). */
  readonly authorityHashFields: ReadonlyArray<keyof Body & string>;
  /** Registry field names in catalogue order (a test proves it against commands.json). */
  readonly fields: ReadonlyArray<keyof Body & string>;
  readonly externalEffect: ExternalEffect;
  /** Where the idempotency identity lives (D-IDEM-B1): the B06 command journal, or the provider inbox identity. */
  readonly idempotencyStore: "COMMAND_JOURNAL" | "PROVIDER_INBOX";
  /**
   * Whose journal row it is: the agency's (TENANT, and SERVICE after scope adoption) or the operator's own identity-owned row
   * (OPERATOR: the finance scope never binds kauro.agency_id, D-IDEM-B2); NONE for the inbox.
   */
  readonly journalScope: "TENANT" | "OPERATOR_IDENTITY" | "NONE";
}

function spec<Body>(s: CommerceCommandSpec<Body>): CommerceCommandSpec<Body> {
  return Object.freeze(s);
}

// --- CMD028 CreatePaymentOrder -----------------------------------------------------------------------------------------------------

export interface CreatePaymentOrderBody {
  /** The terms the agency accepts: must equal the quote's termsHash (a mismatch is STALE_VERSION mismatch [termsHash]). */
  readonly termsHash: string;
}
export interface CreatePaymentOrderView {
  readonly order: PaymentOrderView;
  readonly quote: { readonly quoteId: string; readonly state: "ACCEPTED_FOR_CHECKOUT"; readonly version: number };
  /** Present once the provider order exists (201); absent while creation is pending or uncertain (202). */
  readonly checkout?: CheckoutView;
}
export const CREATE_PAYMENT_ORDER = spec<CreatePaymentOrderBody>({
  id: "CMD028",
  name: "CreatePaymentOrder",
  method: "POST",
  path: "/api/v1/quotes/{quoteId}/payment-orders",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  scope: "AGENCY_HEADER",
  aggregateParam: "quoteId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: ["termsHash"],
  fields: ["termsHash"],
  externalEffect: "PROVIDER_CREATE_ORDER",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
});

// --- CMD029 CapturePayment ---------------------------------------------------------------------------------------------------------

export interface CapturePaymentBody {
  /** The browser's echo of the provider approval; must name the stored provider order and is never evidence of payment. */
  readonly providerApprovalRef: string;
}
export interface CapturePaymentView {
  readonly order: PaymentOrderView;
  readonly capture: CaptureView | null;
  /** Issued in the same transaction as a completed, matching, fully allocating capture whose prerequisites still bind. */
  readonly commercialAuthorization: CommercialAuthorizationView | null;
  /** Why no authorization was issued although money was captured (the documented revalidation or refund path follows). */
  readonly authorizationBlockers: ReadonlyArray<CheckoutBlocker>;
}
export const CAPTURE_PAYMENT = spec<CapturePaymentBody>({
  id: "CMD029",
  name: "CapturePayment",
  method: "POST",
  path: "/api/v1/payment-orders/{orderId}/capture",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  scope: "AGENCY_HEADER",
  aggregateParam: "orderId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["providerApprovalRef"],
  externalEffect: "PROVIDER_CAPTURE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
});

// --- CMD030 ReceivePaymentWebhook ----------------------------------------------------------------------------------------------------

/** The normalized inbox command after raw signature verification (COMMAND_CATALOGUE: not the vendor's payload schema). */
export interface ReceivePaymentWebhookBody {
  /** The stored raw event (restricted evidence store) whose exact bytes were verified. */
  readonly providerEventArtifactRef: string;
}
export type ReceivePaymentWebhookView = WebhookAck;
export const RECEIVE_PAYMENT_WEBHOOK = spec<ReceivePaymentWebhookBody>({
  id: "CMD030",
  name: "ReceivePaymentWebhook",
  method: "POST",
  path: "/api/v1/payments/webhooks/{provider}",
  role: "AUTHENTICATED_PROVIDER",
  principal: "PROVIDER",
  scope: "PROVIDER_INGRESS",
  aggregateParam: "provider",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["providerEventArtifactRef"],
  externalEffect: "NONE",
  idempotencyStore: "PROVIDER_INBOX",
  journalScope: "NONE",
});

// --- CMD031 RequestRefund --------------------------------------------------------------------------------------------------------------

export interface RequestRefundBody {
  readonly reasonCode: string;
  readonly evidenceRef: string;
}
export interface RequestRefundView {
  readonly refund: RefundView;
}
export const REQUEST_REFUND = spec<RequestRefundBody>({
  id: "CMD031",
  name: "RequestRefund",
  method: "POST",
  path: "/api/v1/projects/{projectId}/refund-requests",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["reasonCode", "evidenceRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
});

// --- CMD032 ApproveRefund --------------------------------------------------------------------------------------------------------------

export interface ApproveRefundBody {
  readonly expectedVersion: number;
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  /** A fresh step-up proof of the approving owner, or an applicable standing refund policy (D-REF-B4). */
  readonly authorizationRef: string;
}
export interface ApproveRefundView {
  readonly refund: RefundView;
  /** The prepared commission and fiscal effects the approval committed to (CMD032 precondition). */
  readonly effects: { readonly creditNoteRequired: boolean; readonly serviceBasisAfterCents: MoneyMinorUnits; readonly revokesAuthorization: boolean; readonly remaining: MoneyComponentsView };
}
export const APPROVE_REFUND = spec<ApproveRefundBody>({
  id: "CMD032",
  name: "ApproveRefund",
  method: "POST",
  path: "/api/v1/refunds/{refundId}/approve",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  scope: "STORED_OPERATION",
  aggregateParam: "refundId",
  scopeKind: "REFUND",
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "serviceCents", "taxCents", "authorizationRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "OPERATOR_IDENTITY",
});

// --- CMD033 ExecuteRefund --------------------------------------------------------------------------------------------------------------

export interface ExecuteRefundBody {
  readonly expectedVersion: number;
}
export interface ExecuteRefundView {
  readonly refund: RefundView;
  readonly attempt: { readonly attemptId: string; readonly state: string };
}
export const EXECUTE_REFUND = spec<ExecuteRefundBody>({
  id: "CMD033",
  name: "ExecuteRefund",
  method: "POST",
  path: "/api/v1/refunds/{refundId}/execute",
  role: "PAYMENT_SERVICE",
  principal: "PAYMENT_SERVICE",
  scope: "STORED_OPERATION",
  aggregateParam: "refundId",
  scopeKind: "REFUND",
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion"],
  externalEffect: "PROVIDER_REFUND",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
});

// --- CMD034 ReconcilePayment -----------------------------------------------------------------------------------------------------------

export interface ReconcilePaymentBody {
  /** A stored, authenticated provider query result about this order (restricted evidence store). */
  readonly observationRef: string;
}
export interface ReconcilePaymentView {
  readonly order: PaymentOrderView;
  readonly captures: ReadonlyArray<CaptureView>;
  readonly commercialAuthorization: CommercialAuthorizationView | null;
  /** What the observation did, per subject (ADVANCED, NO_CHANGE, STALE_IGNORED, MISMATCH, UNRECOGNIZED). */
  readonly effects: ReadonlyArray<{ readonly subject: "ORDER" | "CAPTURE" | "REFUND"; readonly effect: string }>;
  readonly openCases: ReadonlyArray<{ readonly caseId: string; readonly kind: string }>;
}
export const RECONCILE_PAYMENT = spec<ReconcilePaymentBody>({
  id: "CMD034",
  name: "ReconcilePayment",
  method: "POST",
  path: "/api/v1/payment-orders/{orderId}/reconcile",
  role: "PAYMENT_SERVICE",
  principal: "PAYMENT_SERVICE",
  scope: "STORED_OPERATION",
  aggregateParam: "orderId",
  scopeKind: "PAYMENT_ORDER",
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["observationRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
});

export const COMMERCE_COMMANDS = Object.freeze({
  CMD028: CREATE_PAYMENT_ORDER,
  CMD029: CAPTURE_PAYMENT,
  CMD030: RECEIVE_PAYMENT_WEBHOOK,
  CMD031: REQUEST_REFUND,
  CMD032: APPROVE_REFUND,
  CMD033: EXECUTE_REFUND,
  CMD034: RECONCILE_PAYMENT,
} as const);
