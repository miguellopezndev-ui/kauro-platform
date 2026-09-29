/**
 * Commerce ports (package B09; docs/design/B09-payments-fiscal.md §5): the repositories of migrations 0013..0017, the scope
 * index and the commerce unit of work. They extend the B06 foundation, never fork it: a CommerceUnitOfWork IS a UnitOfWork (the
 * same transaction on the same connection, the same context binding, event publisher, command journal and security events),
 * with the commerce repositories on that connection and one more capability — adopting the scope of a stored operation
 * (`adoptScope`, D-SCOPE-B1), as B06's CreateAgency adopts the agency it mints.
 *
 * Every repository lives inside the unit of work and its context: a read returns null for a row the policies hide, a write
 * outside the context fails at the database. Versioned writes are compare-and-swap on the aggregate version and answer STALE with
 * the current safe version and state (B06 D-VER-1). A read of a fact a command relies on without changing it (a route's state,
 * a corporate grant, the current fiscal profile) happens after that fact's transition lock (B06 D-TX-2). Money crosses these
 * ports as `bigint` minor units. The `pg` implementations belong to @kauro/persistence (implementation mandate M1).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { PostingLine } from "../commerce/ledger.js";
import type {
  CaptureFactRecord,
  CaptureId,
  CaptureStatus,
  CommercialAuthorizationId,
  CommercialAuthorizationRecord,
  CommercialAuthorizationState,
  CorporateGrantRecord,
  CorporateRole,
  DeliveryPhase,
  EligibilitySnapshotId,
  EvidenceArtifactRef,
  EvidenceRef,
  FiscalIssuerRecord,
  FiscalIssuerRef,
  FiscalProfileId,
  FiscalProfileRecord,
  FundsState,
  JobRef,
  LedgerEntryRecord,
  LedgerSourceKind,
  ObservationEffect,
  ObservationSource,
  PaymentAttemptId,
  PaymentAttemptRecord,
  PaymentAttemptState,
  PaymentEnvironment,
  PaymentOperation,
  PaymentOrderId,
  PaymentOrderRecord,
  PaymentOrderState,
  PaymentRouteId,
  PaymentRouteRecord,
  PriceEligibilitySnapshotRecord,
  PricePolicyRecord,
  ProviderEventExceptionRecord,
  PurchaseRebindingId,
  PurchaseRebindingRecord,
  ProviderObservationRecord,
  QuoteId,
  QuoteRecord,
  QuoteState,
  ReconciliationCaseId,
  ReconciliationCaseKind,
  ReconciliationCaseRecord,
  RefundApprovalRecord,
  RefundComponents,
  RefundId,
  RefundOrigin,
  RefundPolicyId,
  RefundPolicyRecord,
  RefundRecord,
  RefundState,
  RevocationPhase,
  ScopeEntry,
  ScopeKind,
  SettlementId,
  SettlementRecord,
  TaxDocumentId,
  TaxDocumentKind,
  TaxDocumentRecord,
  TaxDocumentState,
  TaxRuleSnapshot,
  TaxTreatment,
} from "../commerce/records.js";
import type { ServiceMode } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, CapabilityId, EventId, InboxId, JournalEntryId, MembershipId, PlanId, ProjectId, UserId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { VersionedWrite } from "./repositories.js";
import type { UnitOfWork, UnitOfWorkFactory, UnitOfWorkOptions } from "./unit-of-work.js";

// --- platform configuration and principals ---------------------------------------------------------------------------------------

export interface PaymentRouteRepository {
  get(routeId: PaymentRouteId): Promise<PaymentRouteRecord | null>;
  /**
   * The one QUALIFIED route of a provider and environment (unique by index), read after the route's transition lock (a
   * suspension issued while a checkout is in flight waits for it; one committed first is read), or null.
   */
  findQualified(provider: string, environment: PaymentEnvironment): Promise<PaymentRouteRecord | null>;
}

/** A reviewed version to record; `recordedAt` is its created_at and exactly the superseded version's superseded_at (fiscal_profiles_successor_fk; B09-N5). */
export type NewFiscalProfile = Omit<FiscalProfileRecord, "supersededAt">;

export interface FiscalRepository {
  /** The current (unsuperseded) reviewed version of an agency's fiscal profile, read after its transition lock, or null (quotes, checkout). */
  currentProfile(agencyId: AgencyId): Promise<FiscalProfileRecord | null>;
  /**
   * The version every document of a sale takes (commerce/fiscal saleProfileAt; D-FISC-B4, D-FISC-B6; B09-F4, B09-N5), read after the
   * profile's transition lock: among the agency's versions in force at the sale's tax point — the capture's completion, never a
   * refund's — the version current then (recorded by the tax point, not superseded by it) when it carries a reviewed treatment,
   * else the latest-recorded reviewed version in force at it (a later review that resolves the unknown for the sale), else the
   * unknown, else null. The FISCAL consumer drafts the invoice under it; a credit note carries exactly the fiscal snapshot of the
   * invoice it corrects (D-FISC-B5) and never asks again. A later version never replaces a reviewed treatment for an earlier sale,
   * however its validity is dated (a retroactive change is a professional correction, Q-B09-20).
   */
  saleProfileAt(agencyId: AgencyId, taxPoint: UtcInstant): Promise<FiscalProfileRecord | null>;
  getProfile(profileId: FiscalProfileId): Promise<FiscalProfileRecord | null>;
  /** An issuer route, read after its transition lock (a suspension orders itself with a checkout in flight). */
  getIssuer(issuerRef: FiscalIssuerRef): Promise<FiscalIssuerRecord | null>;
  /**
   * Records a reviewed version (an OPERATOR with an ACTIVE KAURO_OWNER grant in the agency's finance scope; the database checks
   * the grant): supersedes the current one once, in the same unit of work, at exactly the new version's recordedAt
   * (fiscal_profiles_one_current / supersedes_once close the race of two reviews; fiscal_profiles_successor_fk and
   * fiscal_profiles_supersession_lineage keep the lineage gap-free). To withdraw a treatment, record a REVIEW_REQUIRED version.
   */
  recordProfile(profile: NewFiscalProfile): Promise<FiscalProfileRecord>;
}

export interface CorporateGrantRepository {
  /**
   * The caller's own ACTIVE grant of `role` (self policy), read after the grant's transition lock so a revocation issued while
   * a command is in flight waits for it and one committed first is read (B06 D-TX-2); null when absent. Never another person's.
   */
  activeGrant(userId: UserId, role: CorporateRole): Promise<CorporateGrantRecord | null>;
}

export interface RefundPolicyRepository {
  get(policyId: RefundPolicyId): Promise<RefundPolicyRecord | null>;
}

/** The known price policies (migration 0014 price_policies; B09-F10): read-only reference data. */
export interface PricePolicyRepository {
  get(policyVersion: string): Promise<PricePolicyRecord | null>;
}

// --- scope index (D-SCOPE-B1) -----------------------------------------------------------------------------------------------------

export interface ScopeIndex {
  /**
   * Appends the scope of a new stored operation or of a newly learned provider identity (written by the operation's writer): the
   * request handlers record PAYMENT_ORDER and REFUND rows, the payment service REFUND rows of the requests it files and the provider
   * keys it learns — a provider key must be the identity its object learned (commerce_scopes_bind_key, D-SCOPE-B2).
   */
  record(entry: ScopeEntry, now: UtcInstant): Promise<void>;
  /**
   * Reads one entry: the owning tenant (its own rows), the payment service (any row) or an operator holding an ACTIVE corporate
   * grant (REFUND rows) before it adopts a scope; null when unknown to this reader (a foreign and a nonexistent key look alike).
   */
  resolve(kind: ScopeKind, key: string): Promise<ScopeEntry | null>;
}

// --- quotes (the issuance command CMD027 belongs to the recurrence package B10; D-QUOTE-B1) -------------------------------------------

export interface NewQuote {
  readonly quoteId: QuoteId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly billableUnits: number;
  readonly mode: ServiceMode;
  readonly pricePolicyVersion: string;
  readonly discountPolicyVersion: string;
  readonly baseServiceCents: bigint;
  readonly discountBps: number;
  readonly discountCents: bigint;
  readonly serviceCents: bigint;
  readonly fiscalProfileId: FiscalProfileId;
  readonly issuerRef: FiscalIssuerRef;
  readonly tax: TaxRuleSnapshot;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly eligibilitySnapshotId: EligibilitySnapshotId;
  readonly termsHash: Sha256Hex;
  readonly termsVersion: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  /** The promised source availability: the SourceAvailabilityReader's effective deadline of the sealed revision (D-QUOTE-B7). */
  readonly sourceAvailableUntil: UtcInstant;
  /** A replacement quote of the included source replacement: the paid quote whose terms it carries exactly (D-QUOTE-B6). */
  readonly replacesQuoteId?: QuoteId;
  readonly createdByMembershipId: MembershipId;
}

export interface QuoteRepository {
  get(quoteId: QuoteId): Promise<QuoteRecord | null>;
  lock(quoteId: QuoteId): Promise<QuoteRecord | null>;
  /** The eligibility snapshot of a quote (immutable). */
  snapshot(quoteId: QuoteId): Promise<PriceEligibilitySnapshotRecord | null>;
  /**
   * Births the quote DRAFT (version 1) and issues it (issue_quote, version 2) with its snapshot in the caller's transaction; the
   * caller publishes quote.drafted.v1 and quote.issued.v1. The database re-checks the arithmetic and the bindings.
   */
  issue(quote: NewQuote, snapshot: PriceEligibilitySnapshotRecord): Promise<QuoteRecord>;
  transition(quoteId: QuoteId, expectedVersion: number, change: { readonly state: QuoteState; readonly supersededByQuoteId?: QuoteId }, now: UtcInstant): Promise<VersionedWrite<QuoteRecord>>;
}

// --- payment orders and attempts ---------------------------------------------------------------------------------------------------

export interface NewPaymentOrder {
  readonly orderId: PaymentOrderId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly approvalId: ApprovalId;
  readonly route: Pick<PaymentRouteRecord, "routeId" | "provider" | "environment" | "merchantRef" | "payeeDigest" | "currency">;
  readonly expectedAmountCents: bigint;
  readonly expectedServiceCents: bigint;
  readonly expectedTaxCents: bigint;
  readonly termsHash: Sha256Hex;
  readonly idempotencyHash: Sha256Hex;
  readonly createdByMembershipId: MembershipId;
  readonly intentEntryId: JournalEntryId;
  readonly createdAt: UtcInstant;
}

export interface PaymentOrderChange {
  readonly state: PaymentOrderState;
  /** Learned once (provider_order_created); never re-pointed (the database refuses a change, KA004). */
  readonly providerOrderId?: string;
  readonly providerApprovalUrl?: string;
}

export interface PaymentOrderRepository {
  get(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null>;
  lock(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null>;
  /** The order a command journal entry created (resume after a lost response or a crash; D-PROTO-B2). */
  findByIntentEntry(entryId: JournalEntryId): Promise<PaymentOrderRecord | null>;
  /** The open (non-terminal) order of a project, if any (payment_orders_one_open_per_project guarantees at most one). */
  findOpenForProject(projectId: ProjectId): Promise<PaymentOrderRecord | null>;
  /** Inserts INTENT_CREATED at version 1; a second open order of the project fails the unique index (PAYMENT_PENDING). */
  insert(order: NewPaymentOrder): Promise<PaymentOrderRecord>;
  transition(orderId: PaymentOrderId, expectedVersion: number, change: PaymentOrderChange, now: UtcInstant): Promise<VersionedWrite<PaymentOrderRecord>>;
}

export interface NewPaymentAttempt {
  readonly attemptId: PaymentAttemptId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly refundId?: RefundId;
  readonly operation: Exclude<PaymentOperation, "WITHDRAW">;
  /** 1 for the first attempt of the logical operation; a later attempt follows only a proved no-effect (D-PROTO-B3). */
  readonly ordinal: number;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly requestHash: Sha256Hex;
  readonly providerRequestId: string;
  readonly intentEntryId?: JournalEntryId;
  readonly startedAt: UtcInstant;
}

export interface AttemptChange {
  readonly state: PaymentAttemptState;
  /** Set once, with dispatch_intent_committed: the bounded call's deadline after which the watchdog observes (D-PROTO-B4). */
  readonly dispatchDeadlineAt?: UtcInstant;
  readonly lastObservedAt: UtcInstant;
  readonly evidenceHash?: Sha256Hex;
  /** A server token (PROVIDER_DECLINED, TIMEOUT, NOT_FOUND_BY_REQUEST_ID, ...); never provider prose. */
  readonly outcomeCode?: string;
}

export interface PaymentAttemptRepository {
  get(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null>;
  lock(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null>;
  findByIntentEntry(entryId: JournalEntryId): Promise<PaymentAttemptRecord | null>;
  /** The live (PREPARED, DISPATCHING, PROVIDER_PENDING, UNCERTAIN) attempt of an order operation or of a refund. */
  findLive(target: { readonly orderId: PaymentOrderId; readonly operation: "CREATE_ORDER" | "CAPTURE" } | { readonly refundId: RefundId }): Promise<PaymentAttemptRecord | null>;
  /** How many attempts the logical operation already has (the next ordinal; the database bounds it). */
  countFor(target: { readonly orderId: PaymentOrderId; readonly operation: "CREATE_ORDER" | "CAPTURE" } | { readonly refundId: RefundId }): Promise<number>;
  listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<PaymentAttemptRecord>>;
  /** Inserts PREPARED at version 1: the durable intent, before any provider call is possible. */
  prepare(attempt: NewPaymentAttempt): Promise<PaymentAttemptRecord>;
  transition(attemptId: PaymentAttemptId, expectedVersion: number, change: AttemptChange, now: UtcInstant): Promise<VersionedWrite<PaymentAttemptRecord>>;
}

// --- captures and observations -----------------------------------------------------------------------------------------------------

export interface NewCaptureFact {
  readonly captureId: CaptureId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  /**
   * The status of the first authenticated observation (D-INIT-B1): PENDING, COMPLETED or DENIED. A capture first seen REVERSED is
   * inserted COMPLETED and then advanced to REVERSED in the same unit of work (captureStatusStep; D-PAY-B5; B09-N3).
   */
  readonly status: Exclude<CaptureStatus, "REVERSED">;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerCaptureId: string;
  readonly merchantRef: PaymentOrderRecord["merchantRef"];
  readonly payeeDigest: Sha256Hex;
  readonly amountCents: bigint;
  /** Required for COMPLETED (fixed at completion); zero components otherwise. */
  readonly allocation: RefundComponents;
  /** Always UNKNOWN at birth: an observed availability is the next version's fact (observeFunds, capture.funds_observed.v1; D-EVT-B3). */
  readonly fundsState: "UNKNOWN";
  /** Only with a COMPLETED birth (capture.completed.v1 carries it); otherwise learned later (observeFee). */
  readonly providerFeeCents?: bigint;
  readonly providerCompletedAt?: UtcInstant;
  readonly firstObservationSource: ObservationSource;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly attemptId?: PaymentAttemptId;
}

export interface CaptureAdvance {
  readonly status: CaptureStatus;
  /** Only on PENDING → COMPLETED (the database refuses it anywhere else, KP005 FACT_REGRESSION). */
  readonly allocation?: RefundComponents;
  /** Only on PENDING → COMPLETED (capture.completed.v1 carries it); a later fee is observeFee's. */
  readonly providerFeeCents?: bigint;
  readonly providerCompletedAt?: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly attemptId?: PaymentAttemptId;
}

export interface CaptureFactRepository {
  get(captureId: CaptureId): Promise<CaptureFactRecord | null>;
  lock(captureId: CaptureId): Promise<CaptureFactRecord | null>;
  /** The fact of a provider capture identity in the current scope (the economic identity of R2-140). */
  findByProviderCapture(provider: string, environment: PaymentEnvironment, providerCaptureId: string): Promise<CaptureFactRecord | null>;
  listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<CaptureFactRecord>>;
  /** What the refunds of a capture commit (APPROVED, SUBMITTING, UNCERTAIN, COMPLETED), summed per component. */
  committedRefunds(captureId: CaptureId): Promise<RefundComponents>;
  /** Inserts the fact at its first observed status (version 1); an over-allocation of the order fails KP002. */
  insert(fact: NewCaptureFact): Promise<CaptureFactRecord>;
  /** A listed status move at expectedVersion + 1 (KA008 for an unlisted one, KP005 for a regression). */
  advance(captureId: CaptureId, expectedVersion: number, change: CaptureAdvance, now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>>;
  /**
   * A provider-reported change of the funds' availability (HELD, AVAILABLE) at expectedVersion + 1; the caller publishes
   * capture.funds_observed.v1 (FINANCE only; D-EVT-B2, B09-F15). Known availability never becomes unknown (KP005).
   */
  observeFunds(captureId: CaptureId, expectedVersion: number, change: { readonly fundsState: Exclude<FundsState, "UNKNOWN">; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }, now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>>;
  /**
   * The fee the provider reported after the completion, learned once at expectedVersion + 1; the caller publishes
   * capture.fee_observed.v1 (FINANCE only), never a second capture.completed.v1 (domain_events_capture_completed_once; B09-F8).
   */
  observeFee(captureId: CaptureId, expectedVersion: number, change: { readonly providerFeeCents: bigint; readonly observedAt: UtcInstant; readonly evidenceHash: Sha256Hex }, now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>>;
}

export interface NewProviderObservation {
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly source: ObservationSource;
  readonly inboxId?: InboxId;
  readonly attemptId?: PaymentAttemptId;
  readonly artifactRef?: EvidenceArtifactRef;
  readonly subjectKind: "ORDER" | "CAPTURE" | "REFUND";
  readonly providerRef: string;
  readonly observedStatus: string;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly payeeDigest?: Sha256Hex;
  readonly providerEventAt?: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly effect: ObservationEffect;
}

export interface ProviderObservationRepository {
  append(observation: NewProviderObservation): Promise<ProviderObservationRecord>;
  listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<ProviderObservationRecord>>;
  /** The latest observation time already applied to a subject (a staler observation is kept as history only). */
  latestAppliedAt(orderId: PaymentOrderId, subjectKind: "ORDER" | "CAPTURE" | "REFUND", providerRef: string): Promise<UtcInstant | null>;
}

// --- commercial authorizations -------------------------------------------------------------------------------------------------------

export interface NewCommercialAuthorization {
  readonly authorizationId: CommercialAuthorizationId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  /** The quote the capturing order charged (quoteId itself unless the entitlement is re-bound). */
  readonly orderQuoteId: QuoteId;
  readonly captureId: CaptureId;
  /** The re-binding a replacement's entitlement is issued under (D-QUOTE-B6). */
  readonly rebindingId?: PurchaseRebindingId;
  readonly approvalId: ApprovalId;
  readonly approvalHash: Sha256Hex;
  readonly planId: PlanId;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly mode: ServiceMode;
  readonly billableUnits: number;
  readonly honoredAfterPriceExpiry: boolean;
  readonly createdAt: UtcInstant;
}

export interface AuthorizationChange {
  readonly state: CommercialAuthorizationState;
  readonly jobRef?: JobRef;
  readonly consumedAt?: UtcInstant;
  readonly deliveredAt?: UtcInstant;
  readonly revocation?: { readonly at: UtcInstant; readonly phase: RevocationPhase; readonly code: string };
}

/**
 * The recorded re-bindings of paid captures to replacement quotes (migration 0015 purchase_rebindings; D-QUOTE-B6). Payment service
 * only; append-only. `record` inserts the row (the guard KP013 checks the allowance, the intact purchase, the replacement's terms
 * and the source lineage); the same unit of work then revokes the replaced entitlement (SOURCE_REPLACED), supersedes the replaced
 * quote, accepts the replacement and issues its entitlement — all four checked at COMMIT.
 */
export interface PurchaseRebindingRepository {
  record(rebinding: PurchaseRebindingRecord): Promise<PurchaseRebindingRecord>;
  listForCapture(captureId: CaptureId): Promise<ReadonlyArray<PurchaseRebindingRecord>>;
  findTo(quoteId: QuoteId): Promise<PurchaseRebindingRecord | null>;
}

export interface CommercialAuthorizationRepository {
  get(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null>;
  lock(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null>;
  findByQuote(quoteId: QuoteId): Promise<CommercialAuthorizationRecord | null>;
  /** The live (non-revoked) entitlement of a capture, if any (commercial_authorizations_one_live_per_capture). */
  findLiveByCapture(captureId: CaptureId): Promise<CommercialAuthorizationRecord | null>;
  /**
   * The live (non-revoked) entitlements of an agency bound to a sealed source revision, by its manifest hash
   * (commercial_authorizations.revision_hash): the B09-owned query behind the source lifecycle's impact map. The integrator binds
   * B07's CommercialScopeInspector to it when both packages are on main (design §15 item 6); B09 never reads B07's tables.
   */
  findLiveByRevisionHash(agencyId: AgencyId, revisionHash: Sha256Hex): Promise<ReadonlyArray<CommercialAuthorizationRecord>>;
  /**
   * Payment service only (B09-F1): inserts ACTIVE at version 1; the database refuses it without a completed capture that alone pays
   * the order (KP004), and a re-bound one without its re-binding and the revocation of the entitlement it replaces.
   */
  issue(authorization: NewCommercialAuthorization): Promise<CommercialAuthorizationRecord>;
  transition(authorizationId: CommercialAuthorizationId, expectedVersion: number, change: AuthorizationChange, now: UtcInstant): Promise<VersionedWrite<CommercialAuthorizationRecord>>;
}

// --- refunds -------------------------------------------------------------------------------------------------------------------------

export interface NewRefundRequest {
  readonly refundId: RefundId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly origin: RefundOrigin;
  /** A label (CMD031) or a server token (the reconciler's EXCESS_CAPTURE request); stored, never copied into an event. */
  readonly reasonCode: string;
  readonly evidenceRef?: EvidenceRef;
  readonly termsHash: Sha256Hex;
  readonly deliveryPhase: DeliveryPhase;
  readonly proposed: RefundComponents;
  readonly requestedByMembershipId?: MembershipId;
  readonly requestedByUserId?: UserId;
  readonly requestedAt: UtcInstant;
}

export interface RefundChange {
  readonly state: RefundState;
  readonly providerRefundId?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly completedAt?: UtcInstant;
  readonly failureCode?: string;
  readonly rejected?: { readonly code: string; readonly byUserId: UserId; readonly at: UtcInstant };
}

export interface RefundRepository {
  get(refundId: RefundId): Promise<RefundRecord | null>;
  lock(refundId: RefundId): Promise<RefundRecord | null>;
  listForCapture(captureId: CaptureId): Promise<ReadonlyArray<RefundRecord>>;
  /** The REQUESTED refund of a capture and origin, if any (refunds_one_requested_per_origin guarantees at most one; D-REF-B1). */
  findOpenForCapture(captureId: CaptureId, origin: RefundOrigin): Promise<RefundRecord | null>;
  /**
   * CMD031: inserts a CUSTOMER_REQUEST REQUESTED at version 1; a second open customer request of the capture fails the unique index
   * (REFUND_REQUEST_OPEN).
   */
  request(refund: NewRefundRequest): Promise<RefundRecord>;
  /**
   * The reconciler's server-originated request (EXCESS_CAPTURE, KAURO_REMEDY): INSERT ... ON CONFLICT DO NOTHING against
   * refunds_one_requested_per_origin, so an open request of the same capture and origin is the answer (filed false) and a repeated
   * or concurrent filing can never abort the transaction that records the capture fact it follows (B09-F3).
   */
  fileServerRequest(refund: NewRefundRequest): Promise<{ readonly filed: boolean; readonly record: RefundRecord }>;
  /**
   * REQUESTED → APPROVED with the immutable intent. The database takes the capture's commitment lock and refuses an amount
   * above the remaining components (KP003 → REFUND_EXCEEDS_REMAINING; READ COMMITTED only, KP009), an approver without an ACTIVE
   * KAURO_OWNER grant (KP007), an approver who requested the refund (segregation, KP008, D-AUTHZ-B2), and a cited standing
   * policy that does not cover the refund (KP010).
   */
  approve(refundId: RefundId, expectedVersion: number, approval: RefundApprovalRecord, now: UtcInstant): Promise<VersionedWrite<RefundRecord>>;
  transition(refundId: RefundId, expectedVersion: number, change: RefundChange, now: UtcInstant): Promise<VersionedWrite<RefundRecord>>;
}

// --- fiscal documents ------------------------------------------------------------------------------------------------------------

export interface NewTaxDocument {
  readonly documentId: TaxDocumentId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly refundId?: RefundId;
  readonly kind: TaxDocumentKind;
  readonly fiscalProfileId: FiscalProfileId;
  readonly issuerRef: FiscalIssuerRef;
  readonly taxTreatment: TaxTreatment;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly correctsDocumentId?: TaxDocumentId;
  readonly supersedesDocumentId?: TaxDocumentId;
  readonly blockedReason?: string;
  readonly createdAt: UtcInstant;
}

export interface TaxDocumentChange {
  readonly state: TaxDocumentState;
  readonly issueRequestHash?: Sha256Hex;
  readonly providerDocumentId?: string;
  readonly legalNumber?: string;
  readonly rejectionCode?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly issuedAt?: UtcInstant;
}

export interface TaxDocumentRepository {
  get(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null>;
  lock(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null>;
  findLiveInvoice(captureId: CaptureId): Promise<TaxDocumentRecord | null>;
  findLiveCreditNote(refundId: RefundId): Promise<TaxDocumentRecord | null>;
  /** Blocked DRAFT documents of an agency (the fiscal consumer re-evaluates them when the reviewed facts change). */
  listBlockedDrafts(limit: number): Promise<ReadonlyArray<TaxDocumentRecord>>;
  draft(document: NewTaxDocument): Promise<TaxDocumentRecord>;
  /** DRAFT only: re-points the draft at the reviewed profile, issuer and tax, or records why it stays blocked (version + 1). */
  redraft(documentId: TaxDocumentId, expectedVersion: number, change: { readonly fiscalProfileId: FiscalProfileId; readonly issuerRef: FiscalIssuerRef; readonly taxTreatment: TaxTreatment; readonly taxCents: bigint; readonly blockedReason: string | null }, now: UtcInstant): Promise<VersionedWrite<TaxDocumentRecord>>;
  transition(documentId: TaxDocumentId, expectedVersion: number, change: TaxDocumentChange, now: UtcInstant): Promise<VersionedWrite<TaxDocumentRecord>>;
}

// --- ledger, settlements, cases, provider inbox ----------------------------------------------------------------------------------------

export interface PostingSet {
  /** The agency of the source event, or null for a platform-level movement (a settlement observation). */
  readonly agencyId: AgencyId | null;
  /** The source: exactly one of a domain event (capture, fee, refund, chargeback) or a settlement observation. */
  readonly source: { readonly kind: "EVENT"; readonly eventId: EventId } | { readonly kind: "SETTLEMENT"; readonly settlementId: SettlementId };
  readonly sourceKind: LedgerSourceKind;
  readonly sourceRef: string;
  readonly currency: string;
  /** The economic date of the movement. */
  readonly effectiveAt: UtcInstant;
  /** When the platform observed the fact it posts (15 "Operational ledger"; never after the posting). */
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly lines: ReadonlyArray<PostingLine>;
  /** For a CORRECTION: the entry each reversing line mirrors (reverses_entry_id), by line position. */
  readonly reverses?: Readonly<Record<number, LedgerEntryRecord["entryId"]>>;
}

export interface LedgerRepository {
  /**
   * Appends a balanced set (checked in code and at commit, KP001). The source is the idempotency identity: a second set for the
   * same source returns the entries already posted and writes nothing (a replayed consumer delivery posts once).
   */
  post(set: PostingSet, now: UtcInstant): Promise<{ readonly posted: boolean; readonly entries: ReadonlyArray<LedgerEntryRecord> }>;
  listForSource(sourceKind: LedgerSourceKind, sourceRef: string): Promise<ReadonlyArray<LedgerEntryRecord>>;
}

export interface SettlementRepository {
  /** SERVICE principal without an agency scope: appends a balance observation; bank-available needs bank evidence. */
  record(settlement: SettlementRecord): Promise<SettlementRecord>;
  latest(routeId: PaymentRouteId): Promise<SettlementRecord | null>;
}

export interface NewReconciliationCase {
  readonly caseId: ReconciliationCaseId;
  readonly agencyId: AgencyId;
  readonly orderId?: PaymentOrderId;
  readonly captureId?: CaptureId;
  readonly refundId?: RefundId;
  readonly kind: ReconciliationCaseKind;
  readonly detailCode: string;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly evidenceHash: Sha256Hex;
  readonly openedAt: UtcInstant;
}

export interface ReconciliationCaseRepository {
  /**
   * Opens a case, or returns the open case of the same kind and subject (reconciliation_cases_one_open): a repeated observation
   * adds history, never a second case. `opened` tells whether this call created it (and must publish its event).
   */
  open(entry: NewReconciliationCase): Promise<{ readonly opened: boolean; readonly record: ReconciliationCaseRecord }>;
  resolve(caseId: ReconciliationCaseId, expectedVersion: number, resolutionCode: string, now: UtcInstant): Promise<VersionedWrite<ReconciliationCaseRecord>>;
  listOpenForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<ReconciliationCaseRecord>>;
}

/** An inbox row of a payment provider's event (B06 table inbox_records; contract InboxRecord), as its consumer sees it. */
export interface PaymentInboxEntry {
  readonly inboxId: InboxId;
  readonly provider: string;
  readonly environment: "LOCAL" | "SANDBOX" | "LIVE";
  readonly externalEventId: string;
  readonly bodyHash: Sha256Hex;
  readonly state: "RECEIVED" | "PROCESSING" | "APPLIED" | "IGNORED" | "RETRYABLE" | "REJECTED";
  readonly receivedAt: UtcInstant;
  readonly appliedAt?: UtcInstant;
  readonly resultEventId?: EventId;
  /** Deliveries of the same event carried other bodies: the record cannot be APPLIED before reconciliation (B06 D-ING-1). */
  readonly conflictingBodies: number;
}

/**
 * The payment service's consumer side of the B06 inbox (D-ING-B1): the payment service is the consumer of the events of payment
 * providers and settles them in the transaction that applies them, so an application and its inbox settlement commit together.
 * The ingress half stays B06's InboxIngress (kauro_ingress).
 */
export interface PaymentInboxRepository {
  /** Locks the record FOR UPDATE (a concurrent delivery of the same event waits here) and returns it, or null when unknown. */
  lockForApply(inboxId: InboxId): Promise<PaymentInboxEntry | null>;
  /** The consumer outcome, once: APPLIED (with its result event), IGNORED, REJECTED or RETRYABLE (B06 guards apply). */
  settle(inboxId: InboxId, outcome: { readonly state: "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE"; readonly resultEventId?: EventId }, now: UtcInstant): Promise<PaymentInboxEntry>;
}

/**
 * Authenticated observations no order can take (the owner's finance review; S058, CMD030-DENY; B09-F9, D-ING-B3), from any source:
 * a delivered webhook (with no agency adopted when it cannot be attributed), a dispatch response of a stored operation or a stored
 * provider query (in the adopted agency of that operation). Idempotent per source and kind.
 */
export interface ProviderExceptionRepository {
  record(exception: Omit<ProviderEventExceptionRecord, "exceptionId">): Promise<{ readonly recorded: boolean; readonly record: ProviderEventExceptionRecord }>;
}

// --- the commerce unit of work -----------------------------------------------------------------------------------------------------

export interface CommerceRepositories {
  readonly routes: PaymentRouteRepository;
  readonly fiscal: FiscalRepository;
  readonly corporateGrants: CorporateGrantRepository;
  readonly refundPolicies: RefundPolicyRepository;
  readonly pricePolicies: PricePolicyRepository;
  readonly quotes: QuoteRepository;
  readonly orders: PaymentOrderRepository;
  readonly attempts: PaymentAttemptRepository;
  readonly captures: CaptureFactRepository;
  readonly observations: ProviderObservationRepository;
  readonly authorizations: CommercialAuthorizationRepository;
  readonly rebindings: PurchaseRebindingRepository;
  readonly refunds: RefundRepository;
  readonly taxDocuments: TaxDocumentRepository;
  readonly ledger: LedgerRepository;
  readonly settlements: SettlementRepository;
  readonly cases: ReconciliationCaseRepository;
  readonly inbox: PaymentInboxRepository;
  readonly exceptions: ProviderExceptionRepository;
}

export interface CommerceUnitOfWork extends UnitOfWork {
  readonly commerce: CommerceRepositories;
  readonly scopes: ScopeIndex;
  /**
   * SERVICE and OPERATOR contexts only, at most once per unit of work (D-SCOPE-B1, like B06 adoptTenant): resolves the stored
   * operation through the scope index and binds its agency — kauro.agency_id for SERVICE (one agency, commerce rows and the
   * column-scoped prerequisites only, by the grants of kauro_payment), kauro.finance_agency_id for OPERATOR (finance scope:
   * commerce rows only, while the operator's corporate grant is ACTIVE). Returns null when the key is unknown to the reader (the
   * command answers NOT_FOUND: foreign and nonexistent look alike). Any other use is INTEGRITY_FAILURE.
   */
  adoptScope(kind: ScopeKind, key: string): Promise<AgencyId | null>;
  /**
   * OPERATOR contexts only, at most once per unit of work, and never after adoptScope: binds kauro.finance_agency_id to an
   * agency the corporate owner names for a review that is not keyed by a stored operation — recording a reviewed fiscal profile
   * version (FiscalRepository.recordProfile) or resolving a reconciliation case. The finance scope admits rows only while the
   * session's person holds an ACTIVE KAURO_OWNER grant (kauro.in_finance_scope), so naming an agency grants nothing by itself; no
   * catalogue command of B09 uses it (open question Q-B09-3). Any other use is INTEGRITY_FAILURE.
   */
  adoptFinanceScope(agencyId: AgencyId): Promise<void>;
  /** The agency adopted by adoptScope, or the TENANT agency; null before adoption and for platform-level SERVICE work. */
  readonly commerceScope: AgencyId | null;
}

export interface CommerceUnitOfWorkFactory extends UnitOfWorkFactory {
  run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
