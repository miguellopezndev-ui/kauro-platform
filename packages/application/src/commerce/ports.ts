/**
 * Orchestration ports of the payments and fiscal workflow (package B09). The payment processor, the fiscal authority, the
 * restricted evidence store and service authentication are reached only through these interfaces (10 "Provider adapter
 * contract"; 15 "PaymentOrder and intent", "Webhooks and reconciliation", "Accounting integration decision"; 08 "Identity is
 * not permission"). Until the real integration package (B15) binds provider adapters, tests bind contract-faithful fakes that
 * declare `integrationClass: "CONTRACT_FAKE"` and are labelled so in code and in evidence — never counted as integration
 * (21 "Evidence classes": SIMULATED is not EXECUTED_PROVIDER; decision D-FAKE-B1).
 *
 * No port call happens inside a database transaction (07 "No database transaction remains open across ... payment API calls").
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  AmbiguityReason,
  AssuranceProofId,
  CausationId,
  CommerceUnitOfWork,
  CommercialAuthorizationId,
  EventId,
  EvidenceArtifactRef,
  FailureCode,
  FailureReason,
  FiscalIssuerRecord,
  FiscalProfileRecord,
  IdentityFacts,
  InboxId,
  IntegrationClass,
  NormalizedProviderEvent,
  ObservationEffect,
  ObservationSource,
  ObservedCapture,
  ObservedRefund,
  PaymentAttemptId,
  PaymentEnvironment,
  PaymentOrderId,
  ProviderExceptionKind,
  ProviderRequest,
  ReconciliationCaseId,
  ReconciliationCaseKind,
  RefundPolicyId,
  ServiceIdentity,
  ServiceRole,
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
  | { readonly kind: "ORDER_CREATED"; readonly providerOrderId: string; readonly approvalUrl: string; readonly evidenceHash: Sha256Hex }
  | { readonly kind: "CAPTURE_OBSERVED"; readonly capture: ObservedCapture }
  | { readonly kind: "REFUND_OBSERVED"; readonly refund: ObservedRefund }
  /** Authenticated provider evidence that the intended effect did not happen (never a network exception). */
  | { readonly kind: "PROVED_NO_EFFECT"; readonly outcomeCode: string; readonly evidenceHash: Sha256Hex }
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
  /** Maximum raw body accepted (bytes, at most the policy's api.jsonBytes); larger bodies are refused before verification. */
  readonly maxBodyBytes: number;
  /** Freshness window of the transmission time (seconds; open question Q-B09-4). */
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
  /** How the store authenticated the bytes before accepting them (a verified signature, an authenticated provider response). */
  readonly authenticatedBy: "WEBHOOK_SIGNATURE" | "PROVIDER_API_RESPONSE";
  /** The normalized event or observation the adapter classified from the bytes (never the vendor schema). */
  readonly normalized: NormalizedProviderEvent | ProviderOrderObservation;
  readonly integrationClass: IntegrationClass;
}

/**
 * The restricted reconciliation store (10 "Raw sensitive provider responses stay in a restricted reconciliation store if
 * necessary, with a minimized domain fact emitted afterward"). Evidence is immutable and addressed by an opaque reference; a
 * domain row carries only its SHA-256. `put` is idempotent by content: the same bytes return the same reference.
 */
export interface ProviderEvidenceStore {
  readonly integrationClass: IntegrationClass;
  put(evidence: Omit<StoredEvidence, "artifactRef" | "sha256"> & { readonly bytes: Uint8Array }): Promise<{ readonly artifactRef: string; readonly sha256: Sha256Hex }>;
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
  | { readonly kind: "REJECTED"; readonly rejectionCode: string; readonly evidenceHash: Sha256Hex }
  | { readonly kind: "AMBIGUOUS"; readonly reason: AmbiguityReason }
  /** The manual-assisted bridge: an owner/accountant action was prepared; the legal number arrives by observation. */
  | { readonly kind: "ACTION_PREPARED"; readonly actionRef: string };

/**
 * The fiscal document adapter/bridge (15 "Accounting integration decision": a verified provider API such as Alegra, or the
 * lawful DIAN/manual-assisted bridge with a documented owner/accountant action; R2-083: entitlement is verified, never assumed).
 * `prepare` is the local boundary of package B09 and is pure (R2-128: it receives the reviewed treatment and nothing it could
 * infer an exemption from); `submit` and `observe` are the issuance command's (CMD035, package B15), which must find an exact
 * identity through the provider's supported query and pagination before any retry (R2-084).
 */
export interface FiscalDocumentBridge {
  readonly routeKind: "PROVIDER_API" | "MANUAL_BRIDGE";
  readonly integrationClass: IntegrationClass;
  prepare(document: TaxDocumentRecord, context: { readonly profile: FiscalProfileRecord; readonly issuer: FiscalIssuerRecord; readonly original?: TaxDocumentRecord }): FiscalIssuancePacket;
  submit(packet: FiscalIssuancePacket, deadline: UtcInstant): Promise<FiscalSubmissionResult>;
  observe(identity: { readonly issueRequestHash: Sha256Hex; readonly providerDocumentId?: string }): Promise<FiscalSubmissionResult | { readonly kind: "NOT_FOUND"; readonly absenceIsProof: boolean }>;
}

// --- principals beyond agency membership -------------------------------------------------------------------------------------------

/**
 * Verifies a service caller (10 "Internal command authentication": issuer, audience, expected service identity and environment;
 * the Google OIDC verifier of the integration package B15; a labelled contract fake before it).
 */
export interface ServiceAuthenticator {
  readonly integrationClass: IntegrationClass;
  authenticate(headers: Readonly<Record<string, string | undefined>>): Promise<ServiceIdentity | null>;
}

export type CommerceDenial = {
  readonly kind: "DENY";
  readonly code: Extract<FailureCode, "AUTHENTICATION_REQUIRED" | "ASSURANCE_REQUIRED" | "NOT_AUTHORIZED" | "NOT_FOUND">;
  readonly reason: FailureReason | null;
  readonly policyVersion: string;
};

export type OperatorDecision = { readonly kind: "ALLOW"; readonly userId: string; readonly policyVersion: string } | CommerceDenial;

export type OperatorAssurance =
  | { readonly kind: "ALLOW"; readonly assuranceClass: "STEP_UP"; readonly proofRef: AssuranceProofId; readonly policyVersion: string }
  | { readonly kind: "ALLOW"; readonly assuranceClass: "STANDING_POLICY"; readonly policyId: RefundPolicyId; readonly policyVersion: string }
  | CommerceDenial;

export type ServiceDecision = { readonly kind: "ALLOW"; readonly serviceId: string; readonly role: ServiceRole; readonly policyVersion: string } | CommerceDenial;

/**
 * Authorization of the principals the B06 Authorizer denies by default (08; B06 design §6.2 "their authorizers arrive with their
 * packages"). Implemented by @kauro/authorization inside the commerce unit of work, in the B06 pipeline order (D-PIPE-1): access
 * before the journal reservation, assurance after it for a new execution only.
 * - operator (KAURO_OWNER; CMD032, GetRefundReview): identity ACTIVE and verified (token and stored row, as B06 step 2); an
 *   ACTIVE corporate grant read after its transition lock (the database checks the same grant for every finance-scoped row);
 *   then, for CMD032 after the reservation, `assureOperator`: the authorizationRef is a standing policy that covers the locked
 *   refund, or a fresh step-up proof of this operator (08 "High-impact actions require recent step-up ... significant refund").
 * - service (PAYMENT_SERVICE; CMD033, CMD034 — and AUTHENTICATED_PROVIDER for the provider ingress of CMD030): the verified
 *   service identity holds the role in the code-owned table (commerce/principals) and was issued for this environment.
 * Every DENY is recorded as a durable security fact by the runtime (B06 D-FACT-1; D-FACT-B1 for the new streams).
 */
export interface CommerceAuthorizer {
  authorizeOperator(uow: CommerceUnitOfWork, request: { readonly identity: IdentityFacts; readonly role: "KAURO_OWNER" }): Promise<OperatorDecision>;
  assureOperator(uow: CommerceUnitOfWork, request: { readonly userId: string; readonly authorizationRef: string; readonly covers: (policyId: RefundPolicyId) => Promise<boolean> }): Promise<OperatorAssurance>;
  authorizeService(request: { readonly identity: ServiceIdentity; readonly role: ServiceRole; readonly deploymentEnvironment: "LOCAL" | "SANDBOX" | "LIVE" }): ServiceDecision;
}

/** The agency a stored operation belongs to, as adoption returned it (D-SCOPE-B1). */
export interface AdoptedScope {
  readonly agencyId: AgencyId;
}

// --- the reconciler and the consumers (the seam between implementation mandates M2 and M3) ---------------------------------------

/** What one authenticated observation did (design §6.3): its effect per subject, the cases it opened, the authority it issued. */
export interface ReconcileResult {
  readonly effects: ReadonlyArray<{ readonly about: "ORDER" | "CAPTURE" | "REFUND"; readonly effect: ObservationEffect }>;
  readonly openedCases: ReadonlyArray<{ readonly caseId: ReconciliationCaseId; readonly kind: ReconciliationCaseKind }>;
  readonly authorizationIssued: CommercialAuthorizationId | null;
  /** The event of the first fact the observation changed (the inbox record's result event when it is APPLIED), or null. */
  readonly resultEventId: EventId | null;
}

/**
 * The one reconciliation algorithm of design §6.3, inside the caller's commerce unit of work and in its lock order: attribute,
 * order the locks, match, order the observation, step the facts, apply the consequences (order edges, the CommercialAuthorization,
 * cases, excess and remedy refund requests, reversal revocation and lapses), publish. CMD029's settle step, the application of a
 * webhook (CMD030) and CMD034 call it (M3); M2 implements it. It never calls a provider: every observation arrives authenticated.
 */
export interface CommerceReconciler {
  /** An observation of one order, from a dispatch response (CMD028, CMD029, CMD033) or a stored provider query (CMD034). */
  applyOrderObservation(
    uow: CommerceUnitOfWork,
    input: {
      readonly orderId: PaymentOrderId;
      readonly source: Exclude<ObservationSource, "WEBHOOK">;
      readonly observation: ProviderDispatchResult | ProviderOrderObservation;
      readonly attemptId?: PaymentAttemptId;
      readonly artifactRef?: EvidenceArtifactRef;
      readonly causationId: CausationId;
      readonly now: UtcInstant;
    },
  ): Promise<ReconcileResult>;
  /**
   * A verified provider event of a locked inbox record: attributed through the scope index (the SERVICE unit of work adopts its
   * agency here); one no order can take is a provider event exception and the record is settled REJECTED or IGNORED (D-ING-B2).
   */
  applyProviderEvent(
    uow: CommerceUnitOfWork,
    input: { readonly event: NormalizedProviderEvent; readonly inboxId: InboxId; readonly causationId: CausationId; readonly now: UtcInstant },
  ): Promise<{ readonly kind: "APPLIED"; readonly result: ReconcileResult } | { readonly kind: "EXCEPTION"; readonly exceptionKind: ProviderExceptionKind }>;
}

/** A dispatched outbox record as a B09 consumer receives it (B06 D-OUTBOX-1: at least once; the consumer deduplicates). */
export interface CommerceEventDelivery {
  readonly eventId: EventId;
  readonly eventType: string;
  readonly agencyId: AgencyId;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The payment service's consumers (design §8.1, D-CONS-B1): FINANCE posts the ledger, FISCAL drafts and validates fiscal
 * documents, PAYMENT_SERVICE runs the watchdog and the refund executor. Each runs in a SERVICE commerce unit of work that adopts
 * the delivery's agency through its stored operation, and is idempotent by its own durable identity (a posting set's source, a
 * document's one-live-per-subject index, an attempt's state): a replayed delivery answers DUPLICATE and writes nothing.
 */
export interface CommerceEventConsumer {
  readonly consumer: "FINANCE" | "FISCAL" | "PAYMENT_SERVICE";
  readonly eventTypes: ReadonlyArray<string>;
  consume(uow: CommerceUnitOfWork, delivery: CommerceEventDelivery, now: UtcInstant): Promise<"APPLIED" | "DUPLICATE" | "NOT_APPLICABLE">;
}
