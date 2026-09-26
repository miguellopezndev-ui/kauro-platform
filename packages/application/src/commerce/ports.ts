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
  CaptureId,
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
  MembershipId,
  NormalizedProviderEvent,
  ObservationEffect,
  ObservationSource,
  ObservedCapture,
  ObservedRefund,
  PaymentAttemptId,
  PaymentEnvironment,
  PaymentOrderId,
  ProjectId,
  ProviderExceptionKind,
  PurchaseRebindingId,
  QuoteId,
  ProviderRequest,
  ReconciliationCaseId,
  ReconciliationCaseKind,
  RefundPolicyId,
  ReplacementBlocker,
  ServiceIdentity,
  ServiceMode,
  ServiceRole,
  TaxDocumentRecord,
  UnitOfWork,
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
  /**
   * The provider-hosted approval page of the order, when the provider's view names one (the order's approve link); a creation whose
   * response was lost is learned from this view with it (the reconciler keeps it only on an allowlisted host; D-CORE-B3).
   */
  readonly approvalUrl?: string;
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
  /**
   * `storedOperation`, when the command is keyed by one (CMD032: the refund; GetRefundReview), is resolved through the scope index
   * after the grant and adopted as the operator's finance scope — NOT_FOUND alike for a foreign and an unknown key (design §3.4).
   */
  authorizeOperator(uow: CommerceUnitOfWork, request: { readonly identity: IdentityFacts; readonly role: "KAURO_OWNER"; readonly storedOperation?: { readonly kind: "REFUND"; readonly key: string } }): Promise<OperatorDecision>;
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
  /**
   * D-PAY-B6 (residual FINAL-N2): the observation reported a completion without the provider's completion instant — the sale's tax
   * point — so nothing of it was applied; the caller obtains a stored provider query of the order and applies it (CMD034). A stored
   * query that lacks the instant too opens PROVIDER_INCONSISTENCY instead, and this stays false.
   */
  readonly providerQueryRequired: boolean;
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

// --- ports of the packages B09 meets at integration (design §15 "Integration obligations") --------------------------------------------
//
// These are platform components, not external providers: B09 declares the shape it needs, the owning package implements it over its
// own tables inside the caller's unit of work (never a call outside a transaction), and until that package is on main the tests bind
// a labelled contract fake (binding CONTRACT_FAKE, never counted as the owner's behaviour; D-FAKE-B1). B09's SQL never references
// their tables (FOUNDATION D-AGGK-5); the database bounds what it can see in B06 columns and the port supplies the owner's exact fact.

/** Who implements a platform port in this deployment: the owning package's adapter, or a labelled contract fake in tests. */
export type PlatformBinding = "PLATFORM" | "CONTRACT_FAKE";

/**
 * Deliverable capacity for a purchase (15 "PaymentOrder and intent": CreatePaymentOrder "first validates the exact quote, approved
 * plan, source availability, capacity, legal profile and agency billing authority"; 07 "Quote and checkout states": checkout
 * readiness includes deliverable capacity; 07 "Job and attempt states": "Payment readiness accounts for realistic delivery capacity;
 * the system does not take unlimited purchases into an unbounded queue"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §14). The adapter belongs
 * to the processing package's admission and capacity reservation (B08). CMD028 reads it in T1 and CMD029 in T1 before the capture
 * is dispatched; unavailable (or no answer) is CAPACITY_UNAVAILABLE / DELIVERY_CAPACITY_UNAVAILABLE and nothing is written (D-CAP-B1,
 * B09-F5). B09 never reserves capacity: the reservation is B08's, when the entitlement is consumed (CMD036).
 */
export interface DeliveryCapacityPort {
  readonly binding: PlatformBinding;
  checkoutCapacity(
    uow: UnitOfWork,
    request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly mode: ServiceMode; readonly billableUnits: number; readonly at: UtcInstant },
  ): Promise<{ readonly available: true; readonly evidenceHash: Sha256Hex } | { readonly available: false; readonly reason: "ADMISSION_QUEUE_FULL" | "OUTSIDE_QUALIFIED_ENVELOPE" | "EXECUTION_UNFUNDED" }>;
}

/**
 * The availability of a sealed source (09 retention; reference/HASHING "Retention formulas"; 07: "A fourteen-day price lifetime does
 * not extend seven-day source retention"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §16). Provided by the source lifecycle (B07) over its
 * retention records: the effective deadline is the minimum of the record's anchors, the hard deadline the policy cap from the seal.
 * CMD027 (B10) sets Quote.sourceAvailableUntil to the effective deadline; CMD028 and CMD029 refuse SOURCE_EXPIRED when the revision is
 * no longer SEALED or its effective deadline has passed (D-QUOTE-B7, B09-F10). The database bounds the promise by the B06 seal instant
 * and the policy's hard cap (quotes_source_binding) until the integrator binds the exact deadline.
 */
export interface SourceAvailabilityReader {
  readonly binding: PlatformBinding;
  availabilityOf(
    uow: UnitOfWork,
    request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly revisionHash: Sha256Hex },
  ): Promise<{ readonly revisionId: string; readonly state: string; readonly sealedAt: UtcInstant; readonly effectiveDeadline: UtcInstant; readonly hardDeadline: UtcInstant; readonly evidenceHash: Sha256Hex } | null>;
}

/**
 * The lineage of a replacement source (B07 D-REV-1, Q-B07-17: the source lifecycle records lineage and the impact map; the allowance
 * is counted against the quote by B09). The re-binding of a paid capture (D-QUOTE-B6) records the evidence hash it returns; the
 * database re-checks the lineage over B06's dataset_revisions.supersedes_revision_id (purchase_rebindings_guard).
 */
export interface SourceLineageReader {
  readonly binding: PlatformBinding;
  replacementOf(
    uow: UnitOfWork,
    request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly replacedRevisionHash: Sha256Hex; readonly replacementRevisionHash: Sha256Hex },
  ): Promise<{ readonly replacedRevisionId: string; readonly replacementRevisionId: string; readonly replacementSealed: boolean; readonly evidenceHash: Sha256Hex } | null>;
}

/**
 * The included pre-execution source replacement (16 "Scope changes and credits"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18; registry
 * R2-092, owned by the recurrence package B10): implemented by B09 (the stage-2 mandate M3, design §14) and called by B10's replacement flow once the new
 * revision is sealed, its plan approved and the replacement quote issued. It runs in a SERVICE unit of work under kauro_payment (only
 * the payment service revokes and issues entitlements, B09-F1): records the re-binding, revokes the replaced entitlement
 * (SOURCE_REPLACED, PRE_EXECUTION), supersedes the replaced quote, accepts the replacement and issues its entitlement bound to the same
 * capture — one transaction; refused with its blockers otherwise (commerce/authority replacementBlockers; SQLSTATE KP013).
 */
export interface PurchaseRebinder {
  rebind(
    serviceUow: CommerceUnitOfWork,
    input: {
      readonly captureId: CaptureId;
      readonly fromQuoteId: QuoteId;
      readonly toQuoteId: QuoteId;
      readonly requestedByMembershipId: MembershipId;
      readonly causationId: CausationId;
      readonly now: UtcInstant;
    },
  ): Promise<{ readonly kind: "REBOUND"; readonly rebindingId: PurchaseRebindingId; readonly authorizationId: CommercialAuthorizationId } | { readonly kind: "REFUSED"; readonly blockers: ReadonlyArray<ReplacementBlocker> }>;
}
