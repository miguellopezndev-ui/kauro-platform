/**
 * The wire contract of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §10.3): the closed
 * view definitions of every DTO the B09 routes answer, the COMPLETED envelopes of the seven commands, the READ envelopes of
 * the four reads and the provider acknowledgement — in the exact form of the B06 response contract (decision D-RESP-1): a view
 * that projects a registry contract (Quote, PaymentOrder, CaptureFact, CommercialAuthorization, Refund, TaxDocument) takes
 * every selected member from the generated registry bundle and withholds every other member with its reason; platform members
 * are declared in the field vocabulary of reference/FIELD_CONTRACTS.md; every object is closed.
 *
 * These definitions are compiled by `buildCommerceResponseSchemas` with the same derivation rules the B06 views use
 * (`viewSchemaOf`), refuse a forbidden member, and are proven compilable by the strict validator in the application tests. When
 * implementation mandate M3 serves the routes, it adds them to the served inventory (COMMAND_RESPONSES, READ_RESPONSES and the
 * route list), which makes the api's send guard, tools/openapi.mjs and the OpenAPI check cover them exactly as the B06 routes.
 */
import type { ContractName } from "@kauro/contracts";
import { DomainFailure, SERVICE_MODES } from "@kauro/domain";
import { LABEL_PATTERN } from "../api/request-schemas.js";
import {
  FORBIDDEN_RESPONSE_FIELDS,
  RESPONSE_FIELD_VOCABULARY,
  RESPONSE_SCHEMA_PREFIX,
  declaredMembers,
  openObjects,
  viewSchemaOf,
  type JsonSchema,
  type RegistryBundle,
  type ViewDefinition,
} from "../api/response-schemas.js";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const { ID, VERSION, HASH, UTC, LABEL, COUNT, UUID_PATTERN } = RESPONSE_FIELD_VOCABULARY;
/** MoneyMinorUnits inside the platform's exact envelope 0..2^53-1 (D-MONEY-B1; the request schemas use the same shape). */
export const MONEY_PATTERN = "^(0|[1-9][0-9]{0,15})$";
const MONEY = Object.freeze({ type: "string", pattern: MONEY_PATTERN });
const TOKEN = Object.freeze({ type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" });
const VERSION_TOKEN_PATTERN = "^[A-Z][A-Z0-9_.-]{0,63}$";
const BPS = Object.freeze({ type: "integer", minimum: 0, maximum: 10000 });
const enumOf = (values: ReadonlyArray<string>): JsonSchema => ({ type: "string", enum: [...values] });
const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });

// view member constructors (the ViewDefinition member shapes of api/response-schemas)
const registry = (required: boolean, narrow?: JsonSchema, from?: readonly [ContractName, string]) => ({
  kind: "registry" as const,
  required,
  ...(narrow !== undefined ? { narrow } : {}),
  ...(from !== undefined ? { from } : {}),
});
const platform = (required: boolean, schema: JsonSchema, description: string) => ({ kind: "platform" as const, required, schema, description });
const NARROW_ID = Object.freeze({ pattern: UUID_PATTERN });
const NARROW_VERSION_TOKEN = Object.freeze({ pattern: VERSION_TOKEN_PATTERN });
const NARROW_MONEY = Object.freeze({ maxLength: 16 });

export const QUOTE_STATES = ["DRAFT", "ISSUED", "ACCEPTED_FOR_CHECKOUT", "EXPIRED", "SUPERSEDED", "WITHDRAWN"] as const;
export const PAYMENT_STATUSES = ["NOT_STARTED", "PENDING", "CONFIRMED", "FAILED", "CHECKING"] as const;
export const PAYMENT_NEXT_ACTIONS = ["APPROVE_AT_PROVIDER", "CAPTURE", "REFRESH_STATUS", "CONTACT_SUPPORT", "REQUEST_NEW_QUOTE", "REQUEST_NEW_REVIEW"] as const;
export const CHECKOUT_BLOCKER_TOKENS = [
  "AGENCY_NOT_ACTIVE", "QUOTE_NOT_ACTIVE", "QUOTE_EXPIRED", "ALREADY_PAID", "PAYMENT_UNCERTAIN", "PAYMENT_IN_PROGRESS", "SOURCE_EXPIRED", "APPROVAL_NOT_CURRENT",
  "TARGET_STALE", "CAPABILITY_RESTRICTED", "PAYMENT_ROUTE_UNQUALIFIED", "FISCAL_ROUTE_UNQUALIFIED", "FISCAL_TREATMENT_UNREVIEWED", "FISCAL_TREATMENT_CHANGED",
] as const;
export const COMMERCE_RESOURCE_ACTIONS = ["CMD028", "CMD029", "CMD031"] as const;

const COMPONENTS = platform(true, ref("MoneyComponents"), "Service, tax and excess amounts in exact minor units.");

/** Every B09 DTO definition, in OpenAPI component order. Each is closed; a member not listed never reaches the wire. */
export const COMMERCE_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "MoneyComponents",
    description: "The three components of a capture or a refund in MoneyMinorUnits (15 \"A partial refund names the affected service component and allocates tax consistently\"; the excess is an overpayment, never service).",
    contract: null,
    withheld: {},
    members: {
      serviceCents: platform(true, MONEY, "Service component."),
      taxCents: platform(true, MONEY, "Tax component, separately allocated."),
      excessCents: platform(true, MONEY, "Amount above the order's obligation (R2-140); refundable, never service revenue or commission basis."),
    },
  },
  {
    name: "QuoteView",
    description: "The quote the agency reviews and pays (10 \"GET /quotes/{quoteId} returns price components, tax status, discount provenance, expiry and data availability. It also returns checkoutReady and structured blockers\").",
    contract: "Quote",
    withheld: {},
    members: {
      quoteId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      projectId: registry(true, NARROW_ID),
      revisionHash: registry(true),
      planHash: registry(true),
      billableUnits: registry(true),
      mode: registry(true),
      pricePolicyVersion: registry(true, NARROW_VERSION_TOKEN),
      discountPolicyVersion: registry(true, NARROW_VERSION_TOKEN),
      baseServiceCents: registry(true, NARROW_MONEY),
      discountCents: registry(true, NARROW_MONEY),
      serviceCents: registry(true, NARROW_MONEY),
      taxCents: registry(true, NARROW_MONEY),
      totalCents: registry(true, NARROW_MONEY),
      currency: registry(true),
      expiresAt: registry(true),
      sourceAvailableUntil: registry(true),
      termsHash: registry(true),
      version: platform(true, VERSION, "Quote version (the terms are immutable; the state moves)."),
      state: platform(true, enumOf(QUOTE_STATES), "07 \"Quote and checkout states\"."),
      discount: platform(true, { type: "object", additionalProperties: false, required: ["bps", "basis"], properties: { bps: BPS, basis: enumOf(["NONE", "REPEAT", "FOUNDING"]) } }, "The one applied discount and its provenance (16: the highest eligible rate, never a sum)."),
      taxTreatment: platform(true, enumOf(["DOMESTIC_TAXABLE", "EXEMPT_EXPORT", "OTHER_REVIEWED"]), "The reviewed treatment the quote was issued under (an unreviewed treatment never issues a quote)."),
      issuedAt: platform(true, UTC, "Server issuance instant."),
      checkoutReady: platform(true, { type: "boolean" }, "Derived at read time from the durable facts; informative, never authority (10 \"A UI readiness flag is informative\")."),
      checkoutBlockers: platform(true, { type: "array", maxItems: CHECKOUT_BLOCKER_TOKENS.length, items: enumOf(CHECKOUT_BLOCKER_TOKENS) }, "Why checkout is not ready, in check order (07 \"Checkout readiness is a derived predicate\")."),
      permittedActions: platform(true, { type: "array", maxItems: COMMERCE_RESOURCE_ACTIONS.length, items: enumOf(COMMERCE_RESOURCE_ACTIONS) }, "The payment commands the caller may issue here, derived from role and state; informative, never authority."),
    },
  },
  {
    name: "CheckoutView",
    description: "What the browser needs to send the buyer to the provider's approval page; the page's host is allowlisted by the adapter (10 \"Return URLs cannot redirect to an arbitrary attacker-controlled origin\").",
    contract: null,
    withheld: {},
    members: {
      approvalUrl: platform(true, { type: "string", pattern: "^https://[^\\s]+$", maxLength: 2048 }, "Provider-hosted buyer approval page."),
      providerOrderId: platform(true, { type: "string", pattern: "^[A-Za-z0-9._:-]{1,256}$" }, "The provider order reference the checkout widget needs; not a secret, never authority."),
    },
  },
  {
    name: "PaymentOrderView",
    description: "The reconciled payment order (10 \"GET returns reconciled state. A browser return endpoint only navigates to that state\"; 15 \"Payment pending\", \"Payment confirmed\", \"Payment failed\", \"We are checking this payment\").",
    contract: "PaymentOrder",
    withheld: {
      merchantRef: "The receiving merchant is server configuration (15 \"Merchant identity and environment are fixed by server configuration\"), not an agency fact.",
      idempotencyHash: "The intent binding is the server's idempotency record (10 \"Read endpoints return safe projections\").",
    },
    members: {
      orderId: registry(true, NARROW_ID),
      quoteId: registry(true, NARROW_ID),
      provider: registry(true, { pattern: "^[a-z][a-z0-9_-]{1,63}$" }),
      environment: registry(true),
      providerOrderId: registry(false, { pattern: "^[A-Za-z0-9._:-]{1,256}$" }),
      expectedAmountCents: registry(true, NARROW_MONEY),
      currency: registry(true),
      state: registry(true),
      version: platform(true, VERSION, "Order version."),
      projectId: platform(true, ID, "The paid project."),
      paymentStatus: platform(true, enumOf(PAYMENT_STATUSES), "Derived from reconciled facts only (15 \"Payment state transitions\"); CHECKING while an effect is uncertain."),
      nextActions: platform(true, { type: "array", maxItems: PAYMENT_NEXT_ACTIONS.length, items: enumOf(PAYMENT_NEXT_ACTIONS) }, "Safe next actions; while uncertain the platform discourages paying again (15)."),
      checkout: platform(false, ref("CheckoutView"), "Present while the buyer can approve at the provider."),
      createdAt: platform(true, UTC, "Order creation."),
      updatedAt: platform(true, UTC, "Latest reconciled change."),
    },
  },
  {
    name: "CaptureView",
    description: "A capture fact as the agency may see it: an authenticated provider observation, never a browser claim (CaptureFact invariant).",
    contract: "CaptureFact",
    withheld: {
      providerCaptureId: "Provider identities stay in the restricted reconciliation domain (10 \"Provider adapter contract\"); the agency refers to the capture by captureId.",
      merchantRef: "Server configuration, not an agency fact.",
      evidenceHash: "Finance evidence reference of the reconciliation store.",
    },
    members: {
      captureId: registry(true, NARROW_ID),
      orderId: registry(true, NARROW_ID),
      environment: registry(true),
      amountCents: registry(true, NARROW_MONEY),
      currency: registry(true),
      status: registry(true),
      observedAt: registry(true),
      allocated: COMPONENTS,
      version: platform(true, VERSION, "Capture fact version (one per observed status)."),
    },
  },
  {
    name: "CommercialAuthorizationView",
    description: "The one logical processing entitlement of the purchased subject (07 \"CommercialAuthorization\"), created by the server only.",
    contract: "CommercialAuthorization",
    withheld: {},
    members: {
      authorizationId: registry(true, NARROW_ID),
      agencyId: registry(true, NARROW_ID),
      projectId: registry(true, NARROW_ID),
      approvalHash: registry(true),
      quoteId: registry(true, NARROW_ID),
      captureId: registry(true, NARROW_ID),
      revisionHash: registry(true),
      planHash: registry(true),
      capabilityVersion: registry(true, NARROW_VERSION_TOKEN),
      createdAt: registry(true),
      revokedAt: registry(false),
      version: platform(true, VERSION, "Authorization version."),
      state: platform(true, enumOf(["ACTIVE", "CONSUMED", "DELIVERED", "REVOKED"]), "ACTIVE until one job consumes it (B08); REVOKED by a reversal or a full service refund."),
      mode: platform(true, enumOf(SERVICE_MODES), "The purchased mode."),
      billableUnits: platform(true, COUNT, "The purchased scope's exact count."),
      honoredAfterPriceExpiry: platform(true, { type: "boolean" }, "The capture completed after the price expiry and the same still-valid scope was honored (07 \"Quote and checkout states\")."),
      revocationPhase: platform(false, enumOf(["PRE_EXECUTION", "DURING_EXECUTION", "POST_DELIVERY"]), "The phase a revocation happened in (07 \"CommercialAuthorization\")."),
    },
  },
  {
    name: "RefundView",
    description: "A refund as the agency may see it: the request, its review state and the reconciled effect (15 \"Refund policy and calculation\"); never the approver's identity or the provider's refund id.",
    contract: "Refund",
    withheld: {
      providerRefundId: "Provider identities stay in the restricted reconciliation domain.",
      authorizationHash: "Absent until approval; the approval appears as its own member once recorded (the registry requires the member of an approved refund).",
      evidenceHash: "Finance evidence reference of the reconciliation store.",
    },
    members: {
      refundId: registry(true, NARROW_ID),
      captureId: registry(true, NARROW_ID),
      serviceCents: registry(true, NARROW_MONEY),
      taxCents: registry(true, NARROW_MONEY),
      reasonCode: registry(true, { pattern: LABEL_PATTERN }),
      state: registry(true),
      amountsBasis: platform(true, enumOf(["PROPOSED", "APPROVED"]), "serviceCents and taxCents are the reviewer-visible proposal until approval, then the immutable approved intent."),
      version: platform(true, VERSION, "Refund version."),
      projectId: platform(true, ID, "The refunded project."),
      orderId: platform(true, ID, "The paid order."),
      origin: platform(true, enumOf(["CUSTOMER_REQUEST", "EXCESS_CAPTURE", "KAURO_REMEDY"]), "Who asked: the agency, the reconciler for an excess capture, or Kauro's remedy."),
      deliveryPhase: platform(true, enumOf(["PRE_EXECUTION", "DURING_EXECUTION", "POST_DELIVERY", "NO_AUTHORIZATION"]), "The processing/delivery state recorded with the request (15)."),
      excessCents: platform(true, MONEY, "The excess component (an overpayment return carries only excess)."),
      reviewRequired: platform(true, { type: "boolean" }, "True while the request awaits the corporate owner's review; a request is never itself permission for a provider transfer."),
      requestedAt: platform(true, UTC, "Request instant."),
      completedAt: platform(false, UTC, "Reconciled completion."),
      failureCode: platform(false, TOKEN, "Why a refund failed (a server token)."),
      rejectionCode: platform(false, TOKEN, "The reviewed rejection code."),
    },
  },
  {
    name: "RefundEffectsView",
    description: "The prepared commission and fiscal effects an approval commits to (CMD032 precondition \"commission/fiscal effects are prepared\"; 10 \"The owner sees the exact amount, reason, provider effect and commission/tax consequences\").",
    contract: null,
    withheld: {},
    members: {
      creditNoteRequired: platform(true, { type: "boolean" }, "A service or tax component is refunded, so a credit note follows the completion."),
      serviceBasisAfterCents: platform(true, MONEY, "The capture's service basis after this refund: commission recomputes cumulatively from it (R2-081)."),
      revokesAuthorization: platform(true, { type: "boolean" }, "The refund leaves no service basis and the authorization is revoked at completion."),
      remaining: platform(true, ref("MoneyComponents"), "What stays refundable after this refund."),
      effectsHash: platform(true, HASH, "KAURO_REFUND_EFFECTS_V1 digest of the prepared effects."),
    },
  },
  {
    name: "RefundReviewView",
    description: "The corporate owner's review packet of one refund (GET /api/v1/operations/refunds/{refundId}): exact amounts, reason, provider effect and commission/tax consequences — commerce facts only, no customer workspace data (08 \"Private Owner ... has no automatic customer-record bypass\").",
    contract: null,
    withheld: {},
    members: {
      refund: platform(true, ref("RefundView"), "The refund."),
      capture: platform(true, ref("CaptureView"), "The capture it refunds."),
      refundable: platform(true, ref("MoneyComponents"), "What the capture still allows, given every committed refund."),
      termsHash: platform(true, HASH, "The accepted terms of the purchase."),
      applicablePolicies: platform(true, { type: "array", maxItems: 20, items: ID }, "Standing policies that cover the proposed refund as it stands (a reference, never invented)."),
      proposedEffects: platform(true, ref("RefundEffectsView"), "The effects approving the proposal would commit to."),
    },
  },
  {
    name: "TaxDocumentView",
    description: "A fiscal document of the order (15 \"TaxDocument state machine\": a provider PDF is not acceptance; the legal number appears only after authenticated issuance).",
    contract: "TaxDocument",
    withheld: {
      fiscalProfileId: "The reviewed fiscal facts are the operator's private record.",
      providerDocumentId: "Provider identities stay in the restricted reconciliation domain.",
      evidenceHash: "Finance evidence reference of the reconciliation store.",
    },
    members: {
      documentId: registry(true, NARROW_ID),
      paymentOrderId: registry(true, NARROW_ID),
      kind: registry(true),
      state: registry(true),
      legalNumber: registry(false, { pattern: "^[A-Z0-9][A-Z0-9-]{0,63}$" }),
      serviceCents: registry(true, NARROW_MONEY),
      taxCents: registry(true, NARROW_MONEY),
      version: platform(true, VERSION, "Document version."),
      taxTreatment: platform(true, enumOf(["REVIEW_REQUIRED", "DOMESTIC_TAXABLE", "EXEMPT_EXPORT", "OTHER_REVIEWED"]), "The treatment of the draft or of the issued document."),
      blockedReason: platform(false, TOKEN, "Why a draft cannot be validated: the concrete fiscal action (R2-082, R2-128)."),
      issuedAt: platform(false, UTC, "Authenticated issuance instant."),
    },
  },
  {
    name: "CreatePaymentOrderView",
    description: "CMD028: the durable order and the accepted quote; the checkout once the provider order exists.",
    contract: null,
    withheld: {},
    members: {
      order: platform(true, ref("PaymentOrderView"), "The order."),
      quote: platform(true, ref("QuoteView"), "The quote, ACCEPTED_FOR_CHECKOUT."),
    },
  },
  {
    name: "CapturePaymentView",
    description: "CMD029: the reconciled order, the capture fact and — only when every prerequisite binds — the CommercialAuthorization created in the same transaction.",
    contract: null,
    withheld: {},
    members: {
      order: platform(true, ref("PaymentOrderView"), "The order."),
      capture: platform(false, ref("CaptureView"), "The capture fact the server observed (absent when the provider proved no capture)."),
      commercialAuthorization: platform(false, ref("CommercialAuthorizationView"), "Issued with a completed capture that alone pays the order while every prerequisite binds."),
      authorizationBlockers: platform(true, { type: "array", maxItems: CHECKOUT_BLOCKER_TOKENS.length, items: enumOf(CHECKOUT_BLOCKER_TOKENS) }, "Why money captured carries no entitlement (the documented revalidation or refund path follows)."),
    },
  },
  {
    name: "WebhookAck",
    description: "CMD030's answer to the provider: whether the authenticated event was recorded and how it was disposed; no business detail.",
    contract: null,
    withheld: {},
    members: {
      received: platform(true, { type: "boolean", const: true }, "The authenticated event is durably recorded."),
      inboxState: platform(true, enumOf(["RECEIVED", "APPLIED", "IGNORED", "REJECTED", "RETRYABLE"]), "The consumer outcome of the recorded event."),
      duplicate: platform(true, { type: "boolean" }, "The same event (identity and body) was recorded before; nothing was applied again."),
      conflict: platform(true, { type: "boolean" }, "A delivery of this event identity carried another body; it is recorded and never applied (B06 D-ING-1)."),
    },
  },
  {
    name: "RequestRefundView",
    description: "CMD031: the reviewable request.",
    contract: null,
    withheld: {},
    members: { refund: platform(true, ref("RefundView"), "The refund request.") },
  },
  {
    name: "ApproveRefundView",
    description: "CMD032: the immutable refund intent and the effects it committed to.",
    contract: null,
    withheld: {},
    members: {
      refund: platform(true, ref("RefundView"), "The approved refund."),
      effects: platform(true, ref("RefundEffectsView"), "The prepared commission and fiscal effects."),
      authorizationKind: platform(true, enumOf(["OWNER_STEP_UP", "STANDING_POLICY"]), "What authorized the intent."),
    },
  },
  {
    name: "ExecuteRefundView",
    description: "CMD033: the refund after its submission was reconciled.",
    contract: null,
    withheld: {},
    members: {
      refund: platform(true, ref("RefundView"), "The refund."),
      attemptState: platform(true, enumOf(["PREPARED", "DISPATCHING", "PROVIDER_PENDING", "CONFIRMED", "FAILED_NO_EFFECT", "UNCERTAIN", "CANCELLED_BEFORE_DISPATCH"]), "The state of the refund's provider attempt."),
    },
  },
  {
    name: "ReconcilePaymentView",
    description: "CMD034: the order after the authenticated observation was applied, with what it did and the open cases.",
    contract: null,
    withheld: {},
    members: {
      order: platform(true, ref("PaymentOrderView"), "The order."),
      captures: platform(true, { type: "array", maxItems: 20, items: ref("CaptureView") }, "Every capture fact of the order."),
      commercialAuthorization: platform(false, ref("CommercialAuthorizationView"), "The order's authorization, if any."),
      effects: platform(true, { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["about", "effect"], properties: { about: enumOf(["ORDER", "CAPTURE", "REFUND"]), effect: enumOf(["ADVANCED", "NO_CHANGE", "STALE_IGNORED", "DUPLICATE", "MISMATCH", "UNRECOGNIZED"]) } } }, "What the observation did, per fact it was about (the member is not named subject: that name is reserved for the provider subject of the authenticator)."),
      openCases: platform(true, { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false, required: ["caseId", "kind"], properties: { caseId: ID, kind: enumOf(["AMOUNT_MISMATCH", "EXCESS_CAPTURE", "CAPTURE_WITHOUT_VALID_SUBJECT", "UNCERTAIN_EFFECT", "UNRECOGNIZED_PROVIDER_STATE", "PROVIDER_INCONSISTENCY", "REVERSAL", "FEE_MISMATCH"]) } } }, "Reconciliation cases still open for the order."),
    },
  },
  {
    name: "PaymentOrderDetailView",
    description: "GET /api/v1/payment-orders/{orderId}: the reconciled order with its captures, its authorization and its fiscal documents.",
    contract: null,
    withheld: {},
    members: {
      order: platform(true, ref("PaymentOrderView"), "The order."),
      captures: platform(true, { type: "array", maxItems: 20, items: ref("CaptureView") }, "Every capture fact of the order."),
      commercialAuthorization: platform(false, ref("CommercialAuthorizationView"), "The order's authorization, if any."),
      taxDocuments: platform(true, { type: "array", maxItems: 20, items: ref("TaxDocumentView") }, "The order's fiscal documents."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

/** The success reply of each B09 command: status and the view its COMPLETED envelope carries; ACCEPTED where long work applies. */
export const COMMERCE_COMMAND_RESPONSES = Object.freeze({
  CMD028: { status: 201, view: "CreatePaymentOrderView", accepted: true },
  CMD029: { status: 200, view: "CapturePaymentView", accepted: true },
  CMD030: { status: 200, view: "WebhookAck", accepted: false },
  CMD031: { status: 201, view: "RequestRefundView", accepted: false },
  CMD032: { status: 200, view: "ApproveRefundView", accepted: false },
  CMD033: { status: 200, view: "ExecuteRefundView", accepted: true },
  CMD034: { status: 200, view: "ReconcilePaymentView", accepted: false },
} as const);
export type CommerceServedCommandId = keyof typeof COMMERCE_COMMAND_RESPONSES;

/** The B09 reads (10 "Quote and payment routes"; the owner's review of 10 "Refund request, review, execute and reconcile"). */
export const COMMERCE_READ_ROUTES = Object.freeze({
  GetQuote: {
    path: "/api/v1/quotes/{quoteId}",
    scope: "AGENCY_HEADER",
    role: "AGENCY_READER",
    view: "QuoteView",
    action: "READ_QUOTE",
    summary: "The quote with its price components, tax status, discount provenance, both expiries, checkout readiness and blockers",
    authority: '10 "Quote and payment routes": "GET /quotes/{quoteId} returns price components, tax status, discount provenance, expiry and data availability. It also returns checkoutReady and structured blockers"',
  },
  GetPaymentOrder: {
    path: "/api/v1/payment-orders/{orderId}",
    scope: "AGENCY_HEADER",
    role: "AGENCY_READER",
    view: "PaymentOrderDetailView",
    action: "READ_PAYMENT_ORDER",
    summary: "The reconciled payment state of an order, its captures, its authorization and its fiscal documents",
    authority: '10 "Quote and payment routes": "A browser return endpoint only navigates to server-side reconciliation"; 15 "Payment state transitions"',
  },
  GetRefund: {
    path: "/api/v1/refunds/{refundId}",
    scope: "AGENCY_HEADER",
    role: "AGENCY_READER",
    view: "RefundView",
    action: "READ_REFUND",
    summary: "The agency's refund request, its reviewed intent and its execution state",
    authority: '10 "Refund request, review, execute and reconcile"; 15 "Refund policy and calculation"',
  },
  GetRefundReview: {
    path: "/api/v1/operations/refunds/{refundId}",
    scope: "STORED_OPERATION",
    role: "KAURO_OWNER",
    view: "RefundReviewView",
    action: "READ_REFUND_REVIEW",
    summary: "What the corporate owner reviews: the request, the capture, the refundable balance, the applicable standing policies and the prepared effects",
    authority: '10 "The owner sees the exact amount, reason, provider effect and commission/tax consequences"; COMMAND_CATALOGUE CMD032 precondition',
  },
} as const);
export type CommerceReadOperationId = keyof typeof COMMERCE_READ_ROUTES;

export function commerceCommandResponseSchemaId(command: CommerceServedCommandId): string {
  return `${RESPONSE_SCHEMA_PREFIX}${command}`;
}

export function commerceReadResponseSchemaId(operationId: CommerceReadOperationId): string {
  return `${RESPONSE_SCHEMA_PREFIX}read:${operationId}`;
}

function refuse(message: string): never {
  throw new DomainFailure("INTEGRITY_FAILURE", `commerce response schemas: ${message}`);
}

function completedEnvelope(command: CommerceServedCommandId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: commerceCommandResponseSchemaId(command),
    title: `${command} COMPLETED`,
    description: "Synchronous success: the validated DTO and the version of the aggregate the command edited or created (10 \"Responses and safe errors\"); replayed is true when an idempotent replay returned the journaled result (10 \"Idempotency contract\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "version", "replayed", "data"],
    properties: {
      kind: { type: "string", const: "COMPLETED" },
      version: VERSION,
      replayed: { type: "boolean" },
      data: ref(COMMERCE_COMMAND_RESPONSES[command].view),
    },
  };
}

function readEnvelope(operationId: CommerceReadOperationId): JsonSchema {
  return {
    $schema: DIALECT,
    $id: commerceReadResponseSchemaId(operationId),
    title: `${operationId} READ`,
    description: "A read: the safe projection the caller may see, with the version of every resource that edits compare (10).",
    type: "object",
    additionalProperties: false,
    required: ["kind", "data"],
    properties: { kind: { type: "string", const: "READ" }, data: ref(COMMERCE_READ_ROUTES[operationId].view) },
  };
}

/** The B09 schemas, derived and checked under the B06 rules; refuses a forbidden member and an open object. */
export function buildCommerceResponseSchemas(bundle: RegistryBundle): { readonly defs: Readonly<Record<string, JsonSchema>>; readonly roots: Readonly<Record<string, JsonSchema>> } {
  const defs: Record<string, JsonSchema> = {};
  for (const view of COMMERCE_VIEW_DEFINITIONS) {
    if (view.name in bundle.$defs) refuse(`view ${view.name} collides with a registry definition`);
    if (view.name in defs) refuse(`view ${view.name} is defined twice`);
    defs[view.name] = viewSchemaOf(bundle, view);
  }
  const roots: Record<string, JsonSchema> = {};
  for (const command of Object.keys(COMMERCE_COMMAND_RESPONSES) as CommerceServedCommandId[]) {
    if (!(COMMERCE_COMMAND_RESPONSES[command].view in defs)) refuse(`${command} names an unknown view`);
    roots[commerceCommandResponseSchemaId(command)] = completedEnvelope(command);
  }
  for (const operationId of Object.keys(COMMERCE_READ_ROUTES) as CommerceReadOperationId[]) {
    if (!(COMMERCE_READ_ROUTES[operationId].view in defs)) refuse(`${operationId} names an unknown view`);
    roots[commerceReadResponseSchemaId(operationId)] = readEnvelope(operationId);
  }
  for (const [where, schema] of [...Object.entries(defs), ...Object.entries(roots)]) {
    for (const member of declaredMembers(schema)) {
      if (member.name in FORBIDDEN_RESPONSE_FIELDS) refuse(`${where}${member.path} declares the forbidden member ${member.name}`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${where} is not closed at ${open.join(", ")}`);
  }
  return { defs, roots };
}

/** The label shape of the vocabulary, re-exported for the request schemas of this package. */
export const COMMERCE_LABEL = LABEL;
