/**
 * Safe DTO views of the payments and fiscal workflow (10 "Quote and payment routes": GET /quotes/{quoteId} returns price
 * components, tax status, discount provenance, expiry and data availability plus checkoutReady and structured blockers; GET on
 * an order returns the reconciled state and a browser return endpoint only navigates to it. 15 "Payment state transitions":
 * the customer sees "Payment pending", "Payment confirmed", "Payment failed" or "We are checking this payment" with a safe next
 * action, and is discouraged from paying again while uncertain. UI_STATE_AND_COPY_CONTRACT UI23 Quote, UI24 Payment, UI30
 * Billing).
 *
 * Money is carried as MoneyMinorUnits decimal strings, never floats (15 "The UI must not recalculate totals independently with
 * floating point"). No view carries a provider credential, a raw provider response, a payee id, bank details, an evidence
 * artifact, the approving operator's identity (agency views) or another tenant's existence.
 */
import type { MoneyMinorUnits, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureStatus,
  CheckoutBlocker,
  CommercialAuthorizationState,
  DeliveryPhase,
  FundsState,
  PaymentEnvironment,
  PaymentOrderState,
  QuoteState,
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

export interface QuoteView {
  readonly quoteId: string;
  readonly projectId: string;
  readonly state: QuoteState;
  readonly version: number;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly pricePolicyVersion: string;
  readonly discountPolicyVersion: string;
  readonly baseServiceCents: MoneyMinorUnits;
  /** The one applied discount and its provenance (16: the highest eligible rate, never a sum). */
  readonly discount: { readonly bps: number; readonly cents: MoneyMinorUnits; readonly basis: "NONE" | "REPEAT" | "FOUNDING" };
  readonly serviceCents: MoneyMinorUnits;
  readonly tax: { readonly treatment: Exclude<TaxTreatment, "REVIEW_REQUIRED">; readonly cents: MoneyMinorUnits };
  readonly totalCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly termsHash: Sha256Hex;
  readonly issuedAt: UtcInstant;
  /** Price expiry and source availability are separate dates (07; 09 "Quotes, reuploads and retention"). */
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
  readonly checkoutReady: boolean;
  readonly checkoutBlockers: ReadonlyArray<CheckoutBlocker>;
}

/** What the agency is told about a payment: derived from reconciled facts only, never from a browser return. */
export type PaymentStatus = "NOT_STARTED" | "PENDING" | "CONFIRMED" | "FAILED" | "CHECKING";

/** Safe next actions of a payment (tokens the UI maps; 15: discourage paying again while uncertain). */
export type PaymentNextAction = "APPROVE_AT_PROVIDER" | "CAPTURE" | "REFRESH_STATUS" | "CONTACT_SUPPORT" | "REQUEST_NEW_QUOTE" | "REQUEST_NEW_REVIEW";

export interface PaymentOrderView {
  readonly orderId: string;
  readonly quoteId: string;
  readonly projectId: string;
  readonly state: PaymentOrderState;
  readonly version: number;
  readonly environment: PaymentEnvironment;
  readonly expectedAmountCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly paymentStatus: PaymentStatus;
  readonly nextActions: ReadonlyArray<PaymentNextAction>;
  /** The provider order reference the checkout widget needs (not a secret); absent until the provider order exists. */
  readonly providerOrderRef?: string;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface CheckoutView {
  /** The provider-hosted approval page; its host is checked against the adapter's allowlist (10 "Return URLs cannot redirect to an arbitrary origin"). */
  readonly approveUrl: string;
  readonly providerOrderRef: string;
}

export interface CaptureView {
  readonly captureId: string;
  readonly orderId: string;
  readonly status: CaptureStatus;
  readonly amountCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly allocated: MoneyComponentsView;
  readonly fundsState: FundsState;
  readonly observedAt: UtcInstant;
}

export interface CommercialAuthorizationView {
  readonly authorizationId: string;
  readonly projectId: string;
  readonly quoteId: string;
  readonly state: CommercialAuthorizationState;
  readonly version: number;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly honoredAfterPriceExpiry: boolean;
  readonly createdAt: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly revocationPhase?: RevocationPhase;
}

export interface RefundView {
  readonly refundId: string;
  readonly projectId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly state: RefundState;
  readonly version: number;
  readonly origin: RefundOrigin;
  readonly reasonCode: string;
  readonly deliveryPhase: DeliveryPhase;
  /** The server's proposal shown for review; never an authorization (CMD031 "visible but not self-approved"). */
  readonly proposed: MoneyComponentsView;
  readonly reviewRequired: boolean;
  readonly approved?: { readonly amounts: MoneyComponentsView; readonly authorizationKind: RefundAuthorizationKind; readonly approvedAt: UtcInstant; readonly creditNoteRequired: boolean };
  readonly completedAt?: UtcInstant;
  readonly failedReason?: string;
  readonly rejectedReason?: string;
}

export interface TaxDocumentView {
  readonly documentId: string;
  readonly kind: TaxDocumentKind;
  readonly state: TaxDocumentState;
  readonly version: number;
  readonly taxTreatment: TaxTreatment;
  readonly serviceCents: MoneyMinorUnits;
  readonly taxCents: MoneyMinorUnits;
  readonly currency: "USD";
  /** Present when the draft cannot be validated; names the concrete fiscal action (R2-082, R2-128). */
  readonly blockedReason?: string;
  /** Only after authenticated issuance (15: a provider PDF is not DIAN acceptance). */
  readonly legalNumber?: string;
  readonly issuedAt?: UtcInstant;
}

/** The answer the provider receives: no business detail, only whether the event was received and how it was disposed. */
export interface WebhookAck {
  readonly received: true;
  readonly inboxState: "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE";
  readonly duplicate: boolean;
}
