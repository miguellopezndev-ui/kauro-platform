/**
 * Safe DTO views of the payments and fiscal workflow — the TypeScript shapes of the closed schemas of commerce/response-schemas
 * (10 "Quote and payment routes": GET /quotes/{quoteId} returns price components, tax status, discount provenance, expiry and
 * data availability plus checkoutReady and structured blockers; GET on an order returns the reconciled state and a browser
 * return endpoint only navigates to it. 15 "Payment state transitions": the customer sees "Payment pending", "Payment
 * confirmed", "Payment failed" or "We are checking this payment" with a safe next action, and is discouraged from paying again
 * while uncertain. UI_STATE_AND_COPY_CONTRACT UI23 Quote, UI24 Payment, UI30 Billing).
 *
 * Money is carried as MoneyMinorUnits decimal strings, never floats (15 "The UI must not recalculate totals independently with
 * floating point"). No view carries a provider credential, a raw provider response, a payee id, bank details, an evidence
 * artifact, the approving operator's identity (agency views) or another tenant's existence. The send guard validates every
 * reply against the schema before it is sent (B06 D-RESP-1).
 */
import type { MoneyMinorUnits, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureStatus,
  CheckoutBlocker,
  CommercialAuthorizationState,
  DeliveryPhase,
  PaymentAttemptState,
  PaymentEnvironment,
  PaymentOrderState,
  QuoteState,
  ReconciliationCaseKind,
  RefundAuthorizationKind,
  RefundOrigin,
  RefundState,
  RevocationPhase,
  ServiceMode,
  TaxDocumentKind,
  TaxDocumentState,
  TaxTreatment,
} from "@kauro/domain";

export interface MoneyComponentsView {
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  readonly excessCents: MoneyMinorUnits;
}

/** The payment commands a caller may issue on a resource (informative, never authority). */
export type CommerceResourceAction = "CMD028" | "CMD029" | "CMD031";

export interface QuoteView {
  readonly quoteId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly billableUnits: number;
  readonly mode: ServiceMode;
  readonly pricePolicyVersion: string;
  readonly discountPolicyVersion: string;
  readonly baseServiceCents: MoneyMinorUnits;
  readonly discountCents: MoneyMinorUnits;
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  readonly totalCents: MoneyMinorUnits;
  readonly currency: "USD";
  /** Price expiry and source availability are separate dates (07; 09). */
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
  readonly termsHash: Sha256Hex;
  readonly version: number;
  readonly state: QuoteState;
  /** The one applied discount and its provenance (16: the highest eligible rate, never a sum). */
  readonly discount: { readonly bps: number; readonly basis: "NONE" | "REPEAT" | "FOUNDING" };
  readonly taxTreatment: Exclude<TaxTreatment, "REVIEW_REQUIRED">;
  readonly issuedAt: UtcInstant;
  readonly checkoutReady: boolean;
  readonly checkoutBlockers: ReadonlyArray<CheckoutBlocker>;
  readonly permittedActions: ReadonlyArray<CommerceResourceAction>;
}

/** What the agency is told about a payment: derived from reconciled facts only, never from a browser return. */
export type PaymentStatus = "NOT_STARTED" | "PENDING" | "CONFIRMED" | "FAILED" | "CHECKING";

/** Safe next actions of a payment (tokens the UI maps; 15: discourage paying again while uncertain). */
export type PaymentNextAction = "APPROVE_AT_PROVIDER" | "CAPTURE" | "REFRESH_STATUS" | "CONTACT_SUPPORT" | "REQUEST_NEW_QUOTE" | "REQUEST_NEW_REVIEW";

export interface CheckoutView {
  /** The provider-hosted approval page; its host is checked against the adapter's allowlist (10). */
  readonly approvalUrl: string;
  readonly providerOrderId: string;
}

export interface PaymentOrderView {
  readonly orderId: string;
  readonly quoteId: string;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerOrderId?: string;
  readonly expectedAmountCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly state: PaymentOrderState;
  readonly version: number;
  readonly projectId: string;
  readonly paymentStatus: PaymentStatus;
  readonly nextActions: ReadonlyArray<PaymentNextAction>;
  readonly checkout?: CheckoutView;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface CaptureView {
  readonly captureId: string;
  readonly orderId: string;
  readonly environment: PaymentEnvironment;
  readonly amountCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly status: CaptureStatus;
  readonly observedAt: UtcInstant;
  readonly allocated: MoneyComponentsView;
  readonly version: number;
}

export interface CommercialAuthorizationView {
  readonly authorizationId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly approvalHash: Sha256Hex;
  readonly quoteId: string;
  readonly captureId: string;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly capabilityVersion: string;
  readonly createdAt: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly version: number;
  readonly state: CommercialAuthorizationState;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly honoredAfterPriceExpiry: boolean;
  readonly revocationPhase?: RevocationPhase;
}

export interface RefundView {
  readonly refundId: string;
  readonly captureId: string;
  /** The proposal until approval, then the immutable approved intent (amountsBasis says which). */
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  /** The agency's reason: a label, answered verbatim to the agency and never copied into an event. */
  readonly reasonCode: string;
  readonly state: RefundState;
  readonly amountsBasis: "PROPOSED" | "APPROVED";
  readonly version: number;
  readonly projectId: string;
  readonly orderId: string;
  readonly origin: RefundOrigin;
  readonly deliveryPhase: DeliveryPhase;
  readonly excessCents: MoneyMinorUnits;
  readonly reviewRequired: boolean;
  readonly requestedAt: UtcInstant;
  readonly completedAt?: UtcInstant;
  readonly failureCode?: string;
  readonly rejectionCode?: string;
}

export interface RefundEffectsView {
  readonly creditNoteRequired: boolean;
  readonly serviceBasisAfterCents: MoneyMinorUnits;
  readonly revokesAuthorization: boolean;
  readonly remaining: MoneyComponentsView;
  readonly effectsHash: Sha256Hex;
}

export interface RefundReviewView {
  readonly refund: RefundView;
  readonly capture: CaptureView;
  readonly refundable: MoneyComponentsView;
  readonly termsHash: Sha256Hex;
  readonly applicablePolicies: ReadonlyArray<string>;
  readonly proposedEffects: RefundEffectsView;
}

export interface TaxDocumentView {
  readonly documentId: string;
  readonly paymentOrderId: string;
  readonly kind: TaxDocumentKind;
  readonly state: TaxDocumentState;
  /** Only after authenticated issuance (15: a provider PDF is not DIAN acceptance). */
  readonly legalNumber?: string;
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  readonly version: number;
  readonly taxTreatment: TaxTreatment;
  /** Present when the draft cannot be validated; names the concrete fiscal action (R2-082, R2-128). */
  readonly blockedReason?: string;
  readonly issuedAt?: UtcInstant;
}

/** The answer the provider receives: no business detail, only whether the event was recorded and how it was disposed. */
export interface WebhookAck {
  readonly received: true;
  readonly inboxState: "RECEIVED" | "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE";
  readonly duplicate: boolean;
  readonly conflict: boolean;
}

export interface PaymentOrderDetailView {
  readonly order: PaymentOrderView;
  readonly captures: ReadonlyArray<CaptureView>;
  readonly commercialAuthorization?: CommercialAuthorizationView;
  readonly taxDocuments: ReadonlyArray<TaxDocumentView>;
}

export interface CreatePaymentOrderView {
  readonly order: PaymentOrderView;
  readonly quote: QuoteView;
}

export interface CapturePaymentView {
  readonly order: PaymentOrderView;
  readonly capture?: CaptureView;
  readonly commercialAuthorization?: CommercialAuthorizationView;
  readonly authorizationBlockers: ReadonlyArray<CheckoutBlocker>;
}

export interface RequestRefundView {
  readonly refund: RefundView;
}

export interface ApproveRefundView {
  readonly refund: RefundView;
  readonly effects: RefundEffectsView;
  readonly authorizationKind: RefundAuthorizationKind;
}

export interface ExecuteRefundView {
  readonly refund: RefundView;
  readonly attemptState: PaymentAttemptState;
}

export interface ReconcilePaymentView {
  readonly order: PaymentOrderView;
  readonly captures: ReadonlyArray<CaptureView>;
  readonly commercialAuthorization?: CommercialAuthorizationView;
  readonly effects: ReadonlyArray<{ readonly about: "ORDER" | "CAPTURE" | "REFUND"; readonly effect: "ADVANCED" | "NO_CHANGE" | "STALE_IGNORED" | "DUPLICATE" | "MISMATCH" | "UNRECOGNIZED" }>;
  readonly openCases: ReadonlyArray<{ readonly caseId: string; readonly kind: ReconciliationCaseKind }>;
}
