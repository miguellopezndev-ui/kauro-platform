/**
 * Commerce ports (package B09; docs/design/B09-payments-fiscal.md §5): the repositories of migrations 0008..0011, the scope index
 * and the commerce unit of work. They extend the B06 foundation, never fork it: a CommerceUnitOfWork IS a UnitOfWork (same
 * transaction, same context binding, same event publisher, command journal and security events), with the commerce
 * repositories on the same connection and one more capability — adopting the scope of a stored operation (D-CTX-B3).
 *
 * Every repository lives inside the unit of work and its context: a read returns null for a row the policies hide, a write
 * outside the context fails at the database. Versioned writes are compare-and-swap on the aggregate version and answer STALE
 * with the current safe version and state (B06 D-VER-1). Money crosses these ports as `bigint` minor units. Implementations
 * belong to @kauro/persistence (implementation mandate M1).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureFactRecord,
  CaptureId,
  CaptureStatus,
  CommercialAuthorizationId,
  CommercialAuthorizationRecord,
  CommercialAuthorizationState,
  CorporateRoleRecord,
  DeliveryPhase,
  EligibilitySnapshotId,
  EvidenceRef,
  FiscalIssuerRecord,
  FiscalIssuerRef,
  FiscalProfileId,
  FiscalProfileRecord,
  FundsState,
  InboxId,
  JobRef,
  LedgerEntryRecord,
  LedgerSourceKind,
  MerchantRef,
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
  ProviderEventExceptionRecord,
  ProviderExceptionKind,
  ProviderObservationRecord,
  QuoteId,
  QuoteRecord,
  QuoteState,
  ReconciliationCaseId,
  ReconciliationCaseKind,
  ReconciliationCaseRecord,
  RefundAuthorizationKind,
  RefundComponents,
  RefundId,
  RefundOrigin,
  RefundPolicyId,
  RefundPolicyRecord,
  RefundRecord,
  RefundState,
  RevocationPhase,
  ScopeKind,
  SettlementRecord,
  TaxDocumentId,
  TaxDocumentKind,
  TaxDocumentRecord,
  TaxDocumentState,
  TaxRuleSnapshot,
  TaxTreatment,
} from "../commerce/records.js";
import type { PostingLine } from "../commerce/ledger.js";
import type { ServiceMode } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, AssuranceProofId, CapabilityId, JournalEntryId, MembershipId, PlanId, ProjectId, UserId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { VersionedWrite } from "./repositories.js";
import type { UnitOfWork, UnitOfWorkFactory, UnitOfWorkOptions } from "./unit-of-work.js";

// --- platform configuration ----------------------------------------------------------------------------------------------------

export interface PaymentRouteRepository {
  get(routeId: PaymentRouteId): Promise<PaymentRouteRecord | null>;
  /** The one QUALIFIED route of a provider and environment (unique by index), or null. */
  findQualified(provider: string, environment: PaymentEnvironment): Promise<PaymentRouteRecord | null>;
}

export interface NewFiscalProfile extends Omit<FiscalProfileRecord, "supersededAt"> {
  readonly createdAt: UtcInstant;
}

export interface FiscalRepository {
  /** The current (unsuperseded) reviewed version of an agency's fiscal profile, or null. */
  currentProfile(agencyId: AgencyId): Promise<FiscalProfileRecord | null>;
  getProfile(profileId: FiscalProfileId): Promise<FiscalProfileRecord | null>;
  getIssuer(issuerRef: FiscalIssuerRef): Promise<FiscalIssuerRecord | null>;
  /**
   * Records a reviewed version (OPERATOR finance scope or control plane): supersedes the current one once, in the same unit of
   * work (fiscal_profiles_one_current / supersedes_once close the race of two reviews).
   */
  recordProfile(profile: NewFiscalProfile): Promise<FiscalProfileRecord>;
}

export interface CorporateRoleRepository {
  /** The caller's own ACTIVE corporate grants (self policy); never another person's. */
  activeRolesOf(userId: UserId): Promise<ReadonlyArray<CorporateRoleRecord>>;
}

export interface RefundPolicyRepository {
  get(policyId: RefundPolicyId): Promise<RefundPolicyRecord | null>;
}

// --- scope index (D-SCOPE-B1) -----------------------------------------------------------------------------------------------------

export interface ScopeEntry {
  readonly kind: ScopeKind;
  readonly key: string;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId | null;
}

export interface ScopeIndex {
  /** Appends the scope of a new stored operation or a newly learned provider identity (the agency's own context writes it). */
  record(entry: ScopeEntry, now: UtcInstant): Promise<void>;
  /** Reads one entry: the owning tenant, or a SERVICE/OPERATOR principal before it adopts a scope; null when unknown. */
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
  readonly tax: TaxRuleSnapshot;
  readonly taxCents: bigint;
  readonly totalCents: bigint;
  readonly eligibilitySnapshotId: EligibilitySnapshotId;
  readonly termsHash: Sha256Hex;
  readonly termsVersion: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
  readonly createdByMembershipId: MembershipId;
}

export interface QuoteRepository {
  get(quoteId: QuoteId): Promise<QuoteRecord | null>;
  lock(quoteId: QuoteId): Promise<QuoteRecord | null>;
  /** The eligibility snapshot of a quote (immutable). */
  snapshot(quoteId: QuoteId): Promise<PriceEligibilitySnapshotRecord | null>;
  /** Inserts an ISSUED quote at version 1 with its snapshot (the caller publishes quote.issued.v1); the database re-checks the arithmetic. */
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

export interface PaymentOrderRepository {
  get(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null>;
  lock(orderId: PaymentOrderId): Promise<PaymentOrderRecord | null>;
  /** The order a command journal entry created (resume after a lost response or a crash; D-PROTO-B2). */
  findByIntentEntry(entryId: JournalEntryId): Promise<PaymentOrderRecord | null>;
  /** The open (non-terminal) order of a project, if any (payment_orders_one_open_per_project guarantees at most one). */
  findOpenForProject(projectId: ProjectId): Promise<PaymentOrderRecord | null>;
  /** Inserts INTENT_CREATED at version 1; a second open order of the project fails the unique index (ORDER_ALREADY_OPEN). */
  insert(order: NewPaymentOrder): Promise<PaymentOrderRecord>;
  transition(orderId: PaymentOrderId, expectedVersion: number, change: { readonly state: PaymentOrderState; readonly providerOrderId?: string }, now: UtcInstant): Promise<VersionedWrite<PaymentOrderRecord>>;
}

export interface NewPaymentAttempt {
  readonly attemptId: PaymentAttemptId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly refundId?: RefundId;
  readonly operation: Exclude<PaymentOperation, "WITHDRAW">;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly requestHash: Sha256Hex;
  readonly providerRequestId: string;
  readonly intentEntryId?: JournalEntryId;
  readonly startedAt: UtcInstant;
}

export interface AttemptChange {
  readonly state: PaymentAttemptState;
  readonly dispatchDeadlineAt?: UtcInstant;
  readonly lastObservedAt: UtcInstant;
  readonly evidenceHash?: Sha256Hex;
  readonly outcomeReason?: string;
}

export interface PaymentAttemptRepository {
  get(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null>;
  lock(attemptId: PaymentAttemptId): Promise<PaymentAttemptRecord | null>;
  findByIntentEntry(entryId: JournalEntryId): Promise<PaymentAttemptRecord | null>;
  /** The live (PREPARED, DISPATCHING, PROVIDER_PENDING, UNCERTAIN) attempt of an order operation or of a refund. */
  findLive(target: { readonly orderId: PaymentOrderId; readonly operation: "CREATE_ORDER" | "CAPTURE" } | { readonly refundId: RefundId }): Promise<PaymentAttemptRecord | null>;
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
  readonly status: CaptureStatus;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerCaptureId: string;
  readonly merchantRef: MerchantRef;
  readonly payeeDigest: Sha256Hex;
  readonly amountCents: bigint;
  /** Required for COMPLETED and REVERSED (fixed at completion); zero components otherwise. */
  readonly allocation: RefundComponents;
  readonly fundsState: FundsState;
  readonly providerFeeCents?: bigint;
  readonly providerCompletedAt?: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly attemptId?: PaymentAttemptId;
}

export interface CaptureAdvance {
  readonly status: CaptureStatus;
  /** Only on PENDING → COMPLETED | REVERSED (the database refuses it anywhere else, KA012). */
  readonly allocation?: RefundComponents;
  readonly providerCompletedAt?: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly attemptId?: PaymentAttemptId;
}

export interface CaptureFactRepository {
  get(captureId: CaptureId): Promise<CaptureFactRecord | null>;
  lock(captureId: CaptureId): Promise<CaptureFactRecord | null>;
  /** The fact of a provider capture identity in the current scope (the economic identity; R2-140). */
  findByProviderCapture(provider: string, environment: PaymentEnvironment, providerCaptureId: string): Promise<CaptureFactRecord | null>;
  listForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<CaptureFactRecord>>;
  /** Inserts the fact at its first observed status (version 1); an over-allocation fails KA011. */
  insert(fact: NewCaptureFact): Promise<CaptureFactRecord>;
  /** A listed status move at expectedVersion + 1 (KA008 for an unlisted one, KA012 for a regression). */
  advance(captureId: CaptureId, expectedVersion: number, change: CaptureAdvance, now: UtcInstant): Promise<VersionedWrite<CaptureFactRecord>>;
  /** Observation-only facts without a new version: provider-reported funds availability, the reported fee (once), the time. */
  observeFunds(captureId: CaptureId, change: { readonly fundsState: FundsState; readonly providerFeeCents?: bigint; readonly observedAt: UtcInstant }): Promise<CaptureFactRecord>;
}

export interface NewProviderObservation {
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly source: ObservationSource;
  readonly inboxId?: InboxId;
  readonly attemptId?: PaymentAttemptId;
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
}

// --- commercial authorizations -------------------------------------------------------------------------------------------------------

export interface NewCommercialAuthorization {
  readonly authorizationId: CommercialAuthorizationId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
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
  readonly revocation?: { readonly at: UtcInstant; readonly phase: RevocationPhase; readonly reason: string };
}

export interface CommercialAuthorizationRepository {
  get(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null>;
  lock(authorizationId: CommercialAuthorizationId): Promise<CommercialAuthorizationRecord | null>;
  findByQuote(quoteId: QuoteId): Promise<CommercialAuthorizationRecord | null>;
  findByCapture(captureId: CaptureId): Promise<CommercialAuthorizationRecord | null>;
  /** Inserts ACTIVE at version 1; the database refuses it without a completed capture that pays the order in full (KA013). */
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
  readonly reasonCode: string;
  readonly evidenceRef?: EvidenceRef;
  readonly termsHash: Sha256Hex;
  readonly deliveryPhase: DeliveryPhase;
  readonly proposed: RefundComponents;
  readonly requestedByMembershipId?: MembershipId;
  readonly requestedAt: UtcInstant;
}

export interface RefundApproval {
  readonly amounts: RefundComponents;
  readonly authorizationKind: RefundAuthorizationKind;
  readonly authorizationProofRef?: AssuranceProofId;
  readonly authorizationPolicyId?: RefundPolicyId;
  readonly authorizationHash: Sha256Hex;
  readonly effectsHash: Sha256Hex;
  readonly creditNoteRequired: boolean;
  readonly approvedByUserId: UserId;
  readonly approvedAt: UtcInstant;
}

export interface RefundChange {
  readonly state: RefundState;
  readonly providerRefundId?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly completedAt?: UtcInstant;
  readonly failedReason?: string;
  readonly rejected?: { readonly reason: string; readonly byUserId: UserId; readonly at: UtcInstant };
}

export interface RefundRepository {
  get(refundId: RefundId): Promise<RefundRecord | null>;
  lock(refundId: RefundId): Promise<RefundRecord | null>;
  listForCapture(captureId: CaptureId): Promise<ReadonlyArray<RefundRecord>>;
  /** Inserts REQUESTED at version 1; a second open request of the capture fails refunds_one_requested_per_capture. */
  request(refund: NewRefundRequest): Promise<RefundRecord>;
  /** REQUESTED → APPROVED with the immutable intent; the capture ceiling is enforced under its row lock (KA010). */
  approve(refundId: RefundId, expectedVersion: number, approval: RefundApproval, now: UtcInstant): Promise<VersionedWrite<RefundRecord>>;
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
  readonly rejectionReason?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly issuedAt?: UtcInstant;
}

export interface TaxDocumentRepository {
  get(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null>;
  lock(documentId: TaxDocumentId): Promise<TaxDocumentRecord | null>;
  findLiveInvoice(captureId: CaptureId): Promise<TaxDocumentRecord | null>;
  findLiveCreditNote(refundId: RefundId): Promise<TaxDocumentRecord | null>;
  draft(document: NewTaxDocument): Promise<TaxDocumentRecord>;
  /** DRAFT only: re-points the draft at the reviewed profile, issuer and tax, or records why it stays blocked (version + 1). */
  redraft(documentId: TaxDocumentId, expectedVersion: number, change: { readonly fiscalProfileId: FiscalProfileId; readonly issuerRef: FiscalIssuerRef; readonly taxTreatment: TaxTreatment; readonly taxCents: bigint; readonly blockedReason: string | null }, now: UtcInstant): Promise<VersionedWrite<TaxDocumentRecord>>;
  transition(documentId: TaxDocumentId, expectedVersion: number, change: TaxDocumentChange, now: UtcInstant): Promise<VersionedWrite<TaxDocumentRecord>>;
}

// --- ledger, settlements, cases, provider ingress -------------------------------------------------------------------------------------

export interface PostingSet {
  readonly agencyId: AgencyId;
  /** The domain event whose economic fact the set records (its idempotency identity). */
  readonly eventId: string;
  readonly sourceKind: LedgerSourceKind;
  readonly sourceRef: string;
  readonly currency: string;
  readonly effectiveAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly lines: ReadonlyArray<PostingLine>;
}

export interface LedgerRepository {
  /** Appends a balanced set (checked in code and at commit, KA009); a second set for the same event fails its unique key. */
  post(set: PostingSet, now: UtcInstant): Promise<ReadonlyArray<LedgerEntryRecord>>;
  listForSource(sourceKind: LedgerSourceKind, sourceRef: string): Promise<ReadonlyArray<LedgerEntryRecord>>;
}

export interface SettlementRepository {
  /** SERVICE principal (the settlement reconciler): appends a balance observation; bank-available needs bank evidence. */
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
  resolve(caseId: ReconciliationCaseId, expectedVersion: number, resolution: string, now: UtcInstant): Promise<VersionedWrite<ReconciliationCaseRecord>>;
  listOpenForOrder(orderId: PaymentOrderId): Promise<ReadonlyArray<ReconciliationCaseRecord>>;
}

/** An inbox row of a provider event (B06 table inbox_records; contract InboxRecord). */
export interface ProviderInboxEntry {
  readonly inboxId: InboxId;
  readonly provider: string;
  readonly environment: "LOCAL" | "SANDBOX" | "LIVE";
  readonly externalEventId: string;
  readonly bodyHash: Sha256Hex;
  readonly state: "RECEIVED" | "PROCESSING" | "APPLIED" | "IGNORED" | "RETRYABLE" | "REJECTED";
  readonly receivedAt: UtcInstant;
  readonly appliedAt?: UtcInstant;
  readonly resultEventId?: string;
}

export type InboxReceipt =
  | { readonly kind: "NEW"; readonly entry: ProviderInboxEntry }
  /** Same provider event id and body: a repeated delivery (no new effect; the recorded outcome answers). */
  | { readonly kind: "DUPLICATE"; readonly entry: ProviderInboxEntry }
  /** Same provider event id, another body: never applied (forged or broken provider event). */
  | { readonly kind: "CONFLICT"; readonly entry: ProviderInboxEntry };

export interface ProviderInboxRepository {
  /** INSERT ... ON CONFLICT (provider, environment, external_event_id) DO NOTHING, then the durable answer (07 inbox identity). */
  receive(entry: Omit<ProviderInboxEntry, "inboxId" | "state" | "appliedAt" | "resultEventId">): Promise<InboxReceipt>;
  /** The consumer outcome, once: APPLIED (with its result event), IGNORED, REJECTED or RETRYABLE. */
  complete(inboxId: InboxId, outcome: { readonly state: "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE"; readonly resultEventId?: string }, now: UtcInstant): Promise<ProviderInboxEntry>;
  /** A verified event no order of any agency can take (platform finance review; S058, CMD030-DENY). */
  recordException(exception: Omit<ProviderEventExceptionRecord, "exceptionId"> & { readonly kind: ProviderExceptionKind }): Promise<ProviderEventExceptionRecord>;
}

// --- the commerce unit of work -----------------------------------------------------------------------------------------------------

export interface CommerceRepositories {
  readonly routes: PaymentRouteRepository;
  readonly fiscal: FiscalRepository;
  readonly corporateRoles: CorporateRoleRepository;
  readonly refundPolicies: RefundPolicyRepository;
  readonly quotes: QuoteRepository;
  readonly orders: PaymentOrderRepository;
  readonly attempts: PaymentAttemptRepository;
  readonly captures: CaptureFactRepository;
  readonly observations: ProviderObservationRepository;
  readonly authorizations: CommercialAuthorizationRepository;
  readonly refunds: RefundRepository;
  readonly taxDocuments: TaxDocumentRepository;
  readonly ledger: LedgerRepository;
  readonly settlements: SettlementRepository;
  readonly cases: ReconciliationCaseRepository;
  readonly inbox: ProviderInboxRepository;
}

export interface CommerceUnitOfWork extends UnitOfWork {
  readonly commerce: CommerceRepositories;
  readonly scopes: ScopeIndex;
  /**
   * SERVICE and OPERATOR contexts only, at most once per unit of work (D-CTX-B3, like B06 adoptTenant): resolves the stored
   * operation through the scope index and binds its agency — kauro.agency_id for SERVICE (tenant scope, one agency),
   * kauro.finance_agency_id for OPERATOR (finance scope: commerce rows only). Returns null when the key is unknown (the
   * command answers NOT_FOUND: foreign and nonexistent look alike). Any other use is INTEGRITY_FAILURE.
   */
  adoptScope(kind: ScopeKind, key: string): Promise<AgencyId | null>;
  /** The agency adopted by adoptScope, or the TENANT agency; null before adoption. */
  readonly commerceScope: AgencyId | null;
}

export interface CommerceUnitOfWorkFactory extends UnitOfWorkFactory {
  run<T>(context: ExecutionContext, work: (uow: CommerceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
