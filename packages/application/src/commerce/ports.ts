/**
 * Orchestration ports of the payments and fiscal workflow (package B09). The payment processor, the fiscal authority, the
 * restricted evidence store and service authentication are reached only through these interfaces (10 "Provider adapter
 * contract"; 15 "PaymentOrder and intent", "Webhooks and reconciliation", "Accounting integration decision"; 08 "Identity is
 * not permission"). Until the real integration package (B15) binds provider adapters, tests bind contract-faithful fakes that
 * declare `integrationClass: "CONTRACT_FAKE"` and are labelled so in code and in evidence — never counted as integration
 * (21 "Evidence classes": SIMULATED is not EXECUTED_PROVIDER).
 *
 * No port call happens inside a database transaction (07 "No database transaction remains open across ... payment API calls").
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  AmbiguityReason,
  AssuranceProofId,
  CommerceUnitOfWork,
  FailureCode,
  FailureReason,
  FiscalIssuerRecord,
  FiscalProfileRecord,
  IdentityFacts,
  IntegrationClass,
  NormalizedProviderEvent,
  ObservedCapture,
  ObservedRefund,
  PaymentEnvironment,
  ProviderRequest,
  TaxDocumentRecord,
} from "@kauro/domain";

// --- payment processor --------------------------------------------------------------------------------------------------------

export interface CreateOrderIntent {
  readonly orderId: string;
  readonly attemptId: string;
  readonly providerRequestId: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
  /** Only necessary business/payment fields (15: no raw CRM records, filenames or private target metadata). */
  readonly description: "KAURO_PROJECT_PREPARATION";
  /** Official return/cancel paths of the web surface; the adapter resolves them against its configured allowlisted origin. */
  readonly returnPath: string;
  readonly cancelPath: string;
}

export interface CaptureIntent {
  readonly orderId: string;
  readonly attemptId: string;
  readonly providerRequestId: string;
  readonly providerOrderId: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
}

export interface RefundIntent {
  readonly refundId: string;
  readonly attemptId: string;
  readonly providerRequestId: string;
  readonly providerCaptureId: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
}

/** What one dispatch proved (10: timeout, reset, rejection, pending, unknown and confirmed are distinct). */
export type ProviderDispatchResult =
  | { readonly kind: "ORDER_CREATED"; readonly providerOrderId: string; readonly approveUrl: string; readonly evidenceHash: Sha256Hex }
  | { readonly kind: "CAPTURE_OBSERVED"; readonly capture: ObservedCapture }
  | { readonly kind: "REFUND_OBSERVED"; readonly refund: ObservedRefund }
  /** Authenticated provider evidence that the intended effect did not happen (never a network exception). */
  | { readonly kind: "PROVED_NO_EFFECT"; readonly reason: string; readonly evidenceHash: Sha256Hex }
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  /** A provider status the adapter does not recognize: never coerced (15 UNRECOGNIZED_PROVIDER_STATE). */
  | { readonly kind: "UNRECOGNIZED"; readonly evidenceHash: Sha256Hex };

/** An authenticated read of the provider's current state of an order (the reconciler's only instrument). */
export interface ProviderOrderObservation {
  readonly providerOrderId: string | null;
  readonly orderStatus: "CREATED" | "APPROVED" | "VOIDED" | "EXPIRED" | "COMPLETED" | "NOT_FOUND" | "UNRECOGNIZED";
  readonly captures: ReadonlyArray<ObservedCapture>;
  readonly refunds: ReadonlyArray<ObservedRefund>;
  /** When the observation can prove absence (the provider's documented lookup by request identity), NOT_FOUND is proof. */
  readonly absenceIsProof: boolean;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
}

export interface PaymentProviderAdapter {
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly integrationClass: IntegrationClass;
  /** Pure: the exact normalized request an attempt may send (its digest is PaymentAttempt.requestHash). */
  prepareCreateOrder(intent: CreateOrderIntent): ProviderRequest;
  prepareCapture(intent: CaptureIntent): ProviderRequest;
  prepareRefund(intent: RefundIntent): ProviderRequest;
  /** Network: sends exactly the prepared request under its provider request identity, bounded by the deadline. */
  dispatch(request: ProviderRequest, deadline: UtcInstant): Promise<ProviderDispatchResult>;
  /** Network, read-only: the order by provider id, or a creation by the request identity it was dispatched under. */
  observeOrder(ref: { readonly providerOrderId: string } | { readonly providerRequestId: string }): Promise<ProviderOrderObservation>;
  /** Network, read-only: a refund by provider id, or by the request identity it was dispatched under. */
  observeRefund(ref: { readonly providerRefundId: string } | { readonly providerCaptureId: string; readonly providerRequestId: string }): Promise<ObservedRefund | { readonly kind: "NOT_FOUND"; readonly absenceIsProof: boolean; readonly evidenceHash: Sha256Hex }>;
  /** Pure: re-classifies stored query evidence (CMD034 observationRef) into the same observation, without the network. */
  classifyOrderObservation(evidence: StoredEvidence): ProviderOrderObservation;
  /** Allowlisted hosts of provider approval pages (10: redirects never go to an arbitrary origin). */
  readonly approvalHosts: ReadonlyArray<string>;
}

// --- provider ingress -----------------------------------------------------------------------------------------------------------

export type WebhookVerification =
  | { readonly kind: "VERIFIED"; readonly event: NormalizedProviderEvent }
  | { readonly kind: "REJECTED"; readonly reason: Extract<FailureReason, "PROVIDER_SIGNATURE_INVALID" | "PROVIDER_EVENT_STALE" | "PROVIDER_ENVIRONMENT_MISMATCH"> };

/**
 * Verifies a provider event over its exact raw bytes before anything is stored or trusted (CMD030 precondition "Ingress
 * authenticates provider-specific signature, freshness, environment and bounded raw body before event acceptance"; 07 "A
 * webhook is authenticated before its content can establish authority"). A provider whose verification calls the provider's
 * own API does so here, outside any transaction.
 */
export interface WebhookVerifier {
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly integrationClass: IntegrationClass;
  /** Maximum raw body accepted (bytes); larger bodies are refused before verification. */
  readonly maxBodyBytes: number;
  /** Freshness window of the transmission time (seconds); open question Q-B09-3 for the authority. */
  readonly freshnessSeconds: number;
  verify(raw: { readonly bytes: Uint8Array; readonly headers: Readonly<Record<string, string | undefined>>; readonly receivedAt: UtcInstant }): Promise<WebhookVerification>;
}

// --- restricted evidence store (object storage port) ------------------------------------------------------------------------------

export type EvidenceKind = "WEBHOOK_BODY" | "PROVIDER_RESPONSE" | "PROVIDER_QUERY" | "FISCAL_RESPONSE";

export interface StoredEvidence {
  readonly artifactRef: string;
  readonly kind: EvidenceKind;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  /** SHA-256 of the exact bytes (RAW_BYTES); equals InboxRecord.bodyHash for a webhook body. */
  readonly sha256: Sha256Hex;
  readonly capturedAt: UtcInstant;
  readonly bytes: Uint8Array;
}

/**
 * The restricted reconciliation store (10 "Raw sensitive provider responses stay in a restricted reconciliation store if
 * necessary, with a minimized domain fact emitted afterward"). Evidence is immutable and addressed by an opaque reference; a
 * domain row carries only its SHA-256.
 */
export interface ProviderEvidenceStore {
  readonly integrationClass: IntegrationClass;
  put(evidence: Omit<StoredEvidence, "artifactRef" | "sha256">): Promise<{ readonly artifactRef: string; readonly sha256: Sha256Hex }>;
  get(artifactRef: string): Promise<StoredEvidence | null>;
}

// --- fiscal document adapter / bridge ------------------------------------------------------------------------------------------------

/** The exact issuance request of one document (its digest is tax_documents.issue_request_hash). */
export interface FiscalIssuancePacket {
  readonly documentId: string;
  readonly issueRequestHash: Sha256Hex;
  readonly kind: TaxDocumentRecord["kind"];
  readonly treatment: TaxDocumentRecord["taxTreatment"];
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly currency: "USD";
  readonly correctsLegalNumber?: string;
}

export type FiscalSubmissionResult =
  | { readonly kind: "ISSUED"; readonly providerDocumentId: string; readonly legalNumber: string; readonly evidenceHash: Sha256Hex; readonly issuedAt: UtcInstant }
  | { readonly kind: "REJECTED"; readonly reason: string; readonly evidenceHash: Sha256Hex }
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  /** The manual-assisted bridge: an owner/accountant action was prepared; the legal number arrives by observation. */
  | { readonly kind: "ACTION_PREPARED"; readonly actionRef: string };

/**
 * The fiscal document adapter/bridge (15 "Accounting integration decision": a verified provider API such as Alegra, or the
 * lawful DIAN/manual-assisted bridge with a documented owner/accountant action; R2-083: entitlement is verified, never assumed).
 * `prepare` is the local boundary of package B09 and is pure; `submit` and `observe` are the issuance command's (CMD035,
 * package B15), which must find an exact identity through the provider's supported query and pagination before any retry
 * (R2-084).
 */
export interface FiscalDocumentBridge {
  readonly routeKind: "PROVIDER_API" | "MANUAL_BRIDGE";
  readonly integrationClass: IntegrationClass;
  prepare(document: TaxDocumentRecord, context: { readonly profile: FiscalProfileRecord; readonly issuer: FiscalIssuerRecord; readonly original?: TaxDocumentRecord }): FiscalIssuancePacket;
  submit(packet: FiscalIssuancePacket, deadline: UtcInstant): Promise<FiscalSubmissionResult>;
  observe(identity: { readonly issueRequestHash: Sha256Hex; readonly providerDocumentId?: string }): Promise<FiscalSubmissionResult | { readonly kind: "NOT_FOUND"; readonly absenceIsProof: boolean }>;
}

// --- principals beyond agency membership -------------------------------------------------------------------------------------------

/** A verified service identity (10 "Internal command authentication": issuer, audience, expected service identity, environment). */
export interface ServicePrincipal {
  readonly serviceId: string;
  readonly audience: string;
  readonly environment: PaymentEnvironment;
}

export interface ServiceAuthenticator {
  authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<ServicePrincipal | null>;
}

export const COMMERCE_POLICY_VERSION = "B09-1";

export type CommerceDenial = {
  readonly kind: "DENY";
  readonly code: Extract<FailureCode, "AUTHENTICATION_REQUIRED" | "ASSURANCE_REQUIRED" | "NOT_AUTHORIZED" | "NOT_FOUND">;
  readonly reason: FailureReason;
  readonly policyVersion: string;
};

export type OperatorDecision =
  | { readonly kind: "ALLOW"; readonly userId: string; readonly agencyId: AgencyId; readonly assuranceClass: "SESSION" | "STEP_UP"; readonly policyVersion: string }
  | CommerceDenial;

export type ServiceDecision = { readonly kind: "ALLOW"; readonly serviceId: string; readonly agencyId: AgencyId; readonly policyVersion: string } | CommerceDenial;

/**
 * Authorization of the principals the B06 Authorizer denies by default (08; B06 design §6.2 "their authorizers arrive with
 * their packages"). Implemented by @kauro/authorization inside the commerce unit of work, after scope adoption:
 * - operator (KAURO_OWNER, CMD032): identity ACTIVE and verified; an ACTIVE corporate grant KAURO_OWNER read under the self
 *   policy; no live membership of the operator in the refund's agency (segregation, D-AUTHZ-B2); when the authorization
 *   reference is an assurance proof it must be the operator's own fresh step-up — whether a standing policy applies instead is
 *   decided by the handler on the locked refund;
 * - service (PAYMENT_SERVICE, CMD033/CMD034): the service id holds the role in the code-owned service role table and its
 *   environment is the operation's (D-AUTHZ-B3).
 * A DENY is recorded as a durable security event by the runtime, as in B06 (I-DENY-1).
 */
export interface CommerceAuthorizer {
  authorizeOperator(uow: CommerceUnitOfWork, request: { readonly identity: IdentityFacts; readonly agencyId: AgencyId; readonly stepUpProofRef?: AssuranceProofId }): Promise<OperatorDecision>;
  authorizeService(uow: CommerceUnitOfWork, request: { readonly principal: ServicePrincipal; readonly role: "PAYMENT_SERVICE"; readonly agencyId: AgencyId; readonly operationEnvironment: PaymentEnvironment }): Promise<ServiceDecision>;
}

/** Code-owned service role table (D-AUTHZ-B3): a service account has only its technical role (08). */
export const SERVICE_ROLES: Readonly<Record<string, ReadonlyArray<"PAYMENT_SERVICE" | "FISCAL_SERVICE">>> = Object.freeze({
  "payment-service": ["PAYMENT_SERVICE"],
  "fiscal-service": ["FISCAL_SERVICE"],
});
