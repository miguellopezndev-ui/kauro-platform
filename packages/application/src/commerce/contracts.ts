/**
 * The seven payment commands of package B09 (registry commands CMD028..CMD034; reference/COMMAND_CATALOGUE): body (exactly the
 * registry fields), result view, and the spec the transport, the authorizers and the runtime consume. Behaviour — reads, locks,
 * preconditions in order, writes, events, provider effects and OK/DENY/RACE — is specified in docs/design/B09-payments-fiscal.md
 * §8; the handlers implementing these contracts are implementation mandates M2 and M3.
 *
 * B09 needs things the B06 CommandSpec does not describe, so its spec is its own type:
 * - the principal: an agency member (AGENCY_BILLING), a corporate operator (KAURO_OWNER), the payment service (PAYMENT_SERVICE)
 *   or an authenticated provider (AUTHENTICATED_PROVIDER), and the runtime role its unit of work runs under (D-CTX-B1, D-CTX-B2);
 * - the scope: the active-agency header (B06 D-SCOPE-1), the stored operation (COMMAND_CATALOGUE "Service commands require a
 *   verified service identity and audience, with scope derived from the stored operation"; D-SCOPE-B1) or the provider ingress;
 * - the external effect, which decides the protocol (one unit of work, or intent / claim / call / settle; D-PROTO-B1);
 * - the idempotency store: the B06 command journal, or the provider inbox for the webhook (D-IDEM-B1), and whose journal row it
 *   is (the agency's, or the operator's own identity-owned row; D-IDEM-B2);
 * - the assurance: CMD032 needs a fresh step-up of the approver unless it references a standing policy that applies (D-REF-B4).
 */
import type { MoneyMinorUnits } from "@kauro/contracts";
import type { ApproveRefundView, CapturePaymentView, CreatePaymentOrderView, ExecuteRefundView, ReconcilePaymentView, RequestRefundView, WebhookAck } from "./views.js";

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
  /**
   * The database role of the command's units of work (TENANT and OPERATOR: request handlers; SERVICE: the payment service). The
   * webhook (CMD030) has two halves: the ingress records the authenticated event under kauro_ingress (B06 D-ING-1, PgInboxIngress)
   * and the payment service applies the inbox record under kauro_payment (D-ING-B1); this names the applying half.
   */
  readonly runtimeRole: "kauro_app" | "kauro_payment";
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
  /** NEVER, or UNLESS_STANDING_POLICY: a fresh step-up of the approver unless authorizationRef names an applicable policy. */
  readonly stepUp: "NEVER" | "UNLESS_STANDING_POLICY";
}

function spec<Body>(s: CommerceCommandSpec<Body>): CommerceCommandSpec<Body> {
  return Object.freeze(s);
}

// --- CMD028 CreatePaymentOrder -----------------------------------------------------------------------------------------------------

export interface CreatePaymentOrderBody {
  /** The terms the agency accepts: must equal the quote's termsHash (a mismatch is STALE_VERSION / HASH_MISMATCH [termsHash]). */
  readonly termsHash: string;
}
export type CreatePaymentOrderResult = CreatePaymentOrderView;
export const CREATE_PAYMENT_ORDER = spec<CreatePaymentOrderBody>({
  id: "CMD028",
  name: "CreatePaymentOrder",
  method: "POST",
  path: "/api/v1/quotes/{quoteId}/payment-orders",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_HEADER",
  aggregateParam: "quoteId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: ["termsHash"],
  fields: ["termsHash"],
  externalEffect: "PROVIDER_CREATE_ORDER",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
  stepUp: "NEVER",
});

// --- CMD029 CapturePayment ---------------------------------------------------------------------------------------------------------

export interface CapturePaymentBody {
  /** The browser's echo of the provider approval; must name the stored provider order and is never evidence of payment. */
  readonly providerApprovalRef: string;
}
export type CapturePaymentResult = CapturePaymentView;
export const CAPTURE_PAYMENT = spec<CapturePaymentBody>({
  id: "CMD029",
  name: "CapturePayment",
  method: "POST",
  path: "/api/v1/payment-orders/{orderId}/capture",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_HEADER",
  aggregateParam: "orderId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["providerApprovalRef"],
  externalEffect: "PROVIDER_CAPTURE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
  stepUp: "NEVER",
});

// --- CMD030 ReceivePaymentWebhook ----------------------------------------------------------------------------------------------------

/** The normalized inbox command after raw signature verification (COMMAND_CATALOGUE: not the vendor's payload schema). */
export interface ReceivePaymentWebhookBody {
  /** The stored raw event (restricted evidence store) whose exact bytes were verified. */
  readonly providerEventArtifactRef: string;
}
export type ReceivePaymentWebhookResult = WebhookAck;
export const RECEIVE_PAYMENT_WEBHOOK = spec<ReceivePaymentWebhookBody>({
  id: "CMD030",
  name: "ReceivePaymentWebhook",
  method: "POST",
  path: "/api/v1/payments/webhooks/{provider}",
  role: "AUTHENTICATED_PROVIDER",
  principal: "PROVIDER",
  runtimeRole: "kauro_payment",
  scope: "PROVIDER_INGRESS",
  aggregateParam: "provider",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["providerEventArtifactRef"],
  externalEffect: "NONE",
  idempotencyStore: "PROVIDER_INBOX",
  journalScope: "NONE",
  stepUp: "NEVER",
});

// --- CMD031 RequestRefund --------------------------------------------------------------------------------------------------------------

export interface RequestRefundBody {
  /** A label (CMD031; B06 D-API-1): customer text, stored on the refund and answered to the agency, never in an event. */
  readonly reasonCode: string;
  readonly evidenceRef: string;
}
export type RequestRefundResult = RequestRefundView;
export const REQUEST_REFUND = spec<RequestRefundBody>({
  id: "CMD031",
  name: "RequestRefund",
  method: "POST",
  path: "/api/v1/projects/{projectId}/refund-requests",
  role: "AGENCY_BILLING",
  principal: "AGENCY_MEMBER",
  runtimeRole: "kauro_app",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  scopeKind: null,
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["reasonCode", "evidenceRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
  stepUp: "NEVER",
});

// --- CMD032 ApproveRefund --------------------------------------------------------------------------------------------------------------

export interface ApproveRefundBody {
  readonly expectedVersion: number;
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  /** A fresh step-up proof of the approving owner, or an applicable standing refund policy (D-REF-B4). */
  readonly authorizationRef: string;
}
export type ApproveRefundResult = ApproveRefundView;
export const APPROVE_REFUND = spec<ApproveRefundBody>({
  id: "CMD032",
  name: "ApproveRefund",
  method: "POST",
  path: "/api/v1/refunds/{refundId}/approve",
  role: "KAURO_OWNER",
  principal: "CORPORATE_OPERATOR",
  runtimeRole: "kauro_app",
  scope: "STORED_OPERATION",
  aggregateParam: "refundId",
  scopeKind: "REFUND",
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion", "serviceCents", "taxCents", "authorizationRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "OPERATOR_IDENTITY",
  stepUp: "UNLESS_STANDING_POLICY",
});

// --- CMD033 ExecuteRefund --------------------------------------------------------------------------------------------------------------

export interface ExecuteRefundBody {
  readonly expectedVersion: number;
}
export type ExecuteRefundResult = ExecuteRefundView;
export const EXECUTE_REFUND = spec<ExecuteRefundBody>({
  id: "CMD033",
  name: "ExecuteRefund",
  method: "POST",
  path: "/api/v1/refunds/{refundId}/execute",
  role: "PAYMENT_SERVICE",
  principal: "PAYMENT_SERVICE",
  runtimeRole: "kauro_payment",
  scope: "STORED_OPERATION",
  aggregateParam: "refundId",
  scopeKind: "REFUND",
  expectedVersionRequired: true,
  authorityHashFields: [],
  fields: ["expectedVersion"],
  externalEffect: "PROVIDER_REFUND",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
  stepUp: "NEVER",
});

// --- CMD034 ReconcilePayment -----------------------------------------------------------------------------------------------------------

export interface ReconcilePaymentBody {
  /** A stored, authenticated provider observation about this order (restricted evidence store). */
  readonly observationRef: string;
}
export type ReconcilePaymentResult = ReconcilePaymentView;
export const RECONCILE_PAYMENT = spec<ReconcilePaymentBody>({
  id: "CMD034",
  name: "ReconcilePayment",
  method: "POST",
  path: "/api/v1/payment-orders/{orderId}/reconcile",
  role: "PAYMENT_SERVICE",
  principal: "PAYMENT_SERVICE",
  runtimeRole: "kauro_payment",
  scope: "STORED_OPERATION",
  aggregateParam: "orderId",
  scopeKind: "PAYMENT_ORDER",
  expectedVersionRequired: false,
  authorityHashFields: [],
  fields: ["observationRef"],
  externalEffect: "NONE",
  idempotencyStore: "COMMAND_JOURNAL",
  journalScope: "TENANT",
  stepUp: "NEVER",
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
