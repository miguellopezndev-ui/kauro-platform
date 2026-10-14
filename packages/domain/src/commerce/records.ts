/**
 * Commerce records as the domain sees them (package B09; migrations 0013..0017): the registry contracts Quote,
 * PriceEligibilitySnapshot, PaymentOrder, PaymentAttempt, CaptureFact, CommercialAuthorization, Refund, Settlement,
 * FiscalProfile, TaxDocument and LedgerEntry plus the columns the platform needs for concurrency, lineage and exact bindings,
 * and the platform records (payment routes, fiscal issuers, corporate grants, standing refund policies, the scope index,
 * provider observations, reconciliation cases, provider event exceptions). Amounts are `bigint` minor units inside the domain
 * (commerce/money); the wire DTOs of @kauro/application carry them as MoneyMinorUnits strings.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { ServiceMode } from "../model/aggregates.js";
import type { AgencyId, ApprovalId, AssuranceProofId, Branded, CapabilityId, EventId, InboxId, JournalEntryId, MembershipId, PlanId, ProjectId, UserId } from "../model/ids.js";

// --- ids --------------------------------------------------------------------------------------------------------------------

export type QuoteId = Branded<string, "QuoteId">;
export type EligibilitySnapshotId = Branded<string, "EligibilitySnapshotId">;
export type FiscalProfileId = Branded<string, "FiscalProfileId">;
export type FiscalIssuerRef = Branded<string, "FiscalIssuerRef">;
export type PaymentRouteId = Branded<string, "PaymentRouteId">;
export type MerchantRef = Branded<string, "MerchantRef">;
export type PaymentOrderId = Branded<string, "PaymentOrderId">;
export type PaymentAttemptId = Branded<string, "PaymentAttemptId">;
export type CaptureId = Branded<string, "CaptureId">;
export type ObservationId = Branded<string, "ObservationId">;
export type CommercialAuthorizationId = Branded<string, "CommercialAuthorizationId">;
export type RefundId = Branded<string, "RefundId">;
export type RefundPolicyId = Branded<string, "RefundPolicyId">;
export type TaxDocumentId = Branded<string, "TaxDocumentId">;
export type LedgerEntryId = Branded<string, "LedgerEntryId">;
export type SettlementId = Branded<string, "SettlementId">;
export type ReconciliationCaseId = Branded<string, "ReconciliationCaseId">;
export type CorporateGrantId = Branded<string, "CorporateGrantId">;
export type ProviderExceptionId = Branded<string, "ProviderExceptionId">;
/** The recorded re-binding of a paid capture to a replacement quote (the included source replacement; D-QUOTE-B6). */
export type PurchaseRebindingId = Branded<string, "PurchaseRebindingId">;
/** A stored provider evidence artifact (the restricted reconciliation store; CMD030 providerEventArtifactRef, CMD034 observationRef). */
export type EvidenceArtifactRef = Branded<string, "EvidenceArtifactRef">;
/** A job of the processing package (B08); B09 records it opaquely on the authorization it consumes. */
export type JobRef = Branded<string, "JobRef">;
/** An evidence reference of the agency's scope (a refund request's evidenceRef; its store is the support/upload package's). */
export type EvidenceRef = Branded<string, "EvidenceRef">;

// --- vocabularies ------------------------------------------------------------------------------------------------------------

export type PaymentEnvironment = "SANDBOX" | "LIVE";
/** A route or adapter is the real provider, or a labelled contract fake that can never carry money (D-FAKE-B1). */
export type IntegrationClass = "PROVIDER" | "CONTRACT_FAKE";
export type Currency = "USD";

export type TaxTreatment = "REVIEW_REQUIRED" | "DOMESTIC_TAXABLE" | "EXEMPT_EXPORT" | "OTHER_REVIEWED";
/** UNRESOLVED carries no rule; RATE_HALF_UP is one reviewed rate rounded half up once; ZERO_REVIEWED is a reviewed zero. */
export type TaxRule = "UNRESOLVED" | "RATE_HALF_UP" | "ZERO_REVIEWED";

export type QuoteState = "DRAFT" | "ISSUED" | "ACCEPTED_FOR_CHECKOUT" | "EXPIRED" | "SUPERSEDED" | "WITHDRAWN";
export type PaymentOrderState = "INTENT_CREATED" | "CREATING" | "CREATED" | "APPROVED" | "CAPTURING" | "CAPTURE_UNCERTAIN" | "CAPTURED" | "FAILED" | "CANCELLED" | "EXPIRED";
/** WITHDRAW is in the registry vocabulary; merchant withdrawals are the settlement integration's (B15) and B09 creates none. */
export type PaymentOperation = "CREATE_ORDER" | "CAPTURE" | "REFUND" | "WITHDRAW";
export type PaymentAttemptState = "PREPARED" | "DISPATCHING" | "PROVIDER_PENDING" | "CONFIRMED" | "FAILED_NO_EFFECT" | "UNCERTAIN" | "CANCELLED_BEFORE_DISPATCH";
export type CaptureStatus = "COMPLETED" | "PENDING" | "DENIED" | "REVERSED";
/** Provider-reported availability of captured funds; AVAILABLE only from the provider, never derived from a status (CMD034). */
export type FundsState = "UNKNOWN" | "HELD" | "AVAILABLE";
export type CommercialAuthorizationState = "ACTIVE" | "CONSUMED" | "DELIVERED" | "REVOKED";
export type RevocationPhase = "PRE_EXECUTION" | "DURING_EXECUTION" | "POST_DELIVERY";
export type RefundState = "REQUESTED" | "APPROVED" | "SUBMITTING" | "UNCERTAIN" | "COMPLETED" | "FAILED" | "REJECTED";
/** Who asked: the agency (CMD031), the reconciler for an excess capture (R2-140), or Kauro's own remedy of a verified defect. */
export type RefundOrigin = "CUSTOMER_REQUEST" | "EXCESS_CAPTURE" | "KAURO_REMEDY";
export type DeliveryPhase = RevocationPhase | "NO_AUTHORIZATION";
/** A refund intent is authorized by the approving owner's fresh step-up or by a standing policy that applies (CMD032). */
export type RefundAuthorizationKind = "OWNER_STEP_UP" | "STANDING_POLICY";
export type TaxDocumentKind = "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";
export type TaxDocumentState = "DRAFT" | "VALIDATED" | "SUBMITTING" | "UNCERTAIN" | "ISSUED" | "REJECTED" | "CORRECTED";
export type RouteState = "CONFIGURED" | "QUALIFIED" | "SUSPENDED";
/** 19 "BusinessProfile and legal facts": every fact carries its status. */
export type LegalFactStatus = "OBSERVED" | "OWNER_DECLARED" | "PROFESSIONALLY_CONFIRMED" | "PENDING" | "EXPIRED";
/**
 * The kinds of reconciliation case, in the order of migration 0016's reconciliation_cases.kind CHECK (the persistence test proves
 * the two equal) and of ReconcilePaymentView.openCases (the application's view schema is derived from this list; B09-N2).
 * DISPUTE_OPEN is a dispute in progress whose funds the provider holds; the capture stays COMPLETED until actually reversed
 * (D-DISPUTE-B1).
 */
export const RECONCILIATION_CASE_KINDS = [
  "AMOUNT_MISMATCH",
  "EXCESS_CAPTURE",
  "CAPTURE_WITHOUT_VALID_SUBJECT",
  "UNCERTAIN_EFFECT",
  "UNRECOGNIZED_PROVIDER_STATE",
  "PROVIDER_INCONSISTENCY",
  "REVERSAL",
  "FEE_MISMATCH",
  "DISPUTE_OPEN",
] as const;
export type ReconciliationCaseKind = (typeof RECONCILIATION_CASE_KINDS)[number];
/**
 * Why an authenticated provider observation became an exception instead of a fact (migration 0016 provider_event_exceptions): every
 * CaptureMismatch of commerce/capture (WRONG_PROVIDER, WRONG_ENVIRONMENT, WRONG_ORDER, WRONG_PAYEE, WRONG_CURRENCY) plus the
 * ingress's own kinds (an unknown reference or a conflicting body of a delivered event) and an unrecognized status (B09-F9).
 */
export type ProviderExceptionKind =
  | "UNKNOWN_PROVIDER_REFERENCE"
  | "WRONG_PROVIDER"
  | "WRONG_ORDER"
  | "WRONG_PAYEE"
  | "WRONG_CURRENCY"
  | "WRONG_ENVIRONMENT"
  | "UNRECOGNIZED_PROVIDER_STATE"
  | "BODY_CONFLICT";
export type ObservationSource = "DISPATCH_RESPONSE" | "WEBHOOK" | "PROVIDER_QUERY";
export type ObservationEffect = "ADVANCED" | "NO_CHANGE" | "STALE_IGNORED" | "DUPLICATE" | "MISMATCH" | "UNRECOGNIZED";
/** The scope index kinds (migration 0013 commerce_scopes; D-SCOPE-B1). */
export type ScopeKind = "PAYMENT_ORDER" | "REFUND" | "PROVIDER_ORDER" | "PROVIDER_CAPTURE" | "PROVIDER_REFUND";
/** Corporate roles of the command catalogue this package authorizes (the catalogue's owner role, brand-mapped by amendment A2). */
export type CorporateRole = "KAURO_OWNER";

// --- platform records ----------------------------------------------------------------------------------------------------------

export interface PaymentRouteRecord {
  readonly routeId: PaymentRouteId;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly merchantRef: MerchantRef;
  /** SHA-256 of the provider merchant/payee id; an observed payee is compared by digest (S058). */
  readonly payeeDigest: Sha256Hex;
  readonly currency: Currency;
  readonly integrationClass: IntegrationClass;
  readonly state: RouteState;
  readonly qualificationEvidenceHashes: ReadonlyArray<Sha256Hex>;
  readonly validFrom?: UtcInstant;
}

export interface FiscalIssuerRecord {
  readonly issuerRef: FiscalIssuerRef;
  readonly jurisdiction: string;
  readonly legalIdentityHash: Sha256Hex;
  readonly legalFactStatus: LegalFactStatus;
  readonly routeKind: "PROVIDER_API" | "MANUAL_BRIDGE";
  readonly integrationClass: IntegrationClass;
  readonly routeState: RouteState;
  readonly numberingAuthorizationRef?: string;
  readonly entitlementEvidenceHash?: Sha256Hex;
  readonly validFrom?: UtcInstant;
  readonly validUntil?: UtcInstant;
}

export interface CorporateGrantRecord {
  readonly grantId: CorporateGrantId;
  readonly userId: UserId;
  readonly role: CorporateRole;
  readonly state: "ACTIVE" | "REVOKED";
  readonly evidenceHash: Sha256Hex;
  readonly grantedAt: UtcInstant;
  readonly revokedAt?: UtcInstant;
}

export interface RefundPolicyRecord {
  readonly policyId: RefundPolicyId;
  readonly policyKind: "PRE_EXECUTION_CANCELLATION" | "UNREMEDIED_KAURO_DEFECT" | "EXCESS_CAPTURE_RETURN";
  readonly policyVersion: string;
  /** What the policy authorizes: the whole remaining service and tax, only an excess return, or an amount up to a ceiling. */
  readonly refundScope: "FULL_REMAINING" | "EXCESS_ONLY" | "BOUNDED";
  readonly maxRefundCents?: bigint;
  readonly appliesToPhase: "PRE_EXECUTION" | "ANY";
  readonly appliesToOrigin: RefundOrigin;
  readonly conditionsHash: Sha256Hex;
  readonly authorizedByUserId: UserId;
  readonly authorizationProofRef: AssuranceProofId;
  readonly state: "ACTIVE" | "RETIRED";
  readonly validFrom: UtcInstant;
  readonly validUntil?: UtcInstant;
}

/**
 * One row of the scope index: the agency of a stored operation or of a provider identity (identifiers only). Every row names its
 * order, and its capture (PROVIDER_CAPTURE) or refund (REFUND, PROVIDER_REFUND); a provider key is the identity that object learned
 * (migration 0016 commerce_scopes_bind_key; B09-F11, D-SCOPE-B2).
 */
export interface ScopeEntry {
  readonly kind: ScopeKind;
  readonly key: string;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly captureId?: CaptureId;
  readonly refundId?: RefundId;
}

/**
 * A known price policy (migration 0014 price_policies; B09-F10): durations in exact seconds (reference/HASHING "Retention formulas":
 * a duration day is 86400 s), the founding rate and the included pre-execution source replacements.
 */
export interface PricePolicyRecord {
  readonly policyVersion: string;
  readonly quoteSeconds: number;
  readonly repeatLookbackSeconds: number;
  readonly foundingDiscountBps: number;
  readonly preExecutionReplacementsIncluded: number;
  readonly unpaidSourceHardSeconds: number;
}

// --- fiscal profile ---------------------------------------------------------------------------------------------------------------

export interface FiscalProfileRecord {
  readonly profileId: FiscalProfileId;
  readonly agencyId: AgencyId;
  readonly operatorLegalRef: FiscalIssuerRef;
  /** The purchaser identity (the agency's reviewed billing profile, Agency.legalProfileRef); opaque here. */
  readonly customerLegalRef: string;
  readonly serviceClassification: string;
  readonly territory: string;
  readonly taxTreatment: TaxTreatment;
  readonly taxRule: TaxRule;
  readonly taxRateBps: number;
  readonly evidenceHash: Sha256Hex;
  /** Required for EXEMPT_EXPORT: the reviewed export facts (use abroad), never a currency or an email address (R2-128). */
  readonly exportEvidenceHash?: Sha256Hex;
  readonly reviewedByUserId?: UserId;
  readonly validFrom: UtcInstant;
  readonly validUntil?: UtcInstant;
  readonly supersedesProfileId?: FiscalProfileId;
  /**
   * The instant the version was recorded (fiscal_profiles.created_at): the version current at an instant is the one recorded by
   * then and not superseded by then — the version a sale's documents take while it carries a reviewed treatment (saleProfileAt;
   * D-FISC-B6; B09-N5).
   */
  readonly recordedAt: UtcInstant;
  /** The instant its successor was recorded: exactly the successor's recordedAt (migration 0014 fiscal_profiles_successor_fk). */
  readonly supersededAt?: UtcInstant;
}

/** The reviewed tax rule a quote and a document snapshot from their profile. */
export interface TaxRuleSnapshot {
  readonly treatment: Exclude<TaxTreatment, "REVIEW_REQUIRED">;
  readonly rule: Exclude<TaxRule, "UNRESOLVED">;
  readonly rateBps: number;
}

// --- quotes ----------------------------------------------------------------------------------------------------------------------

export interface QuoteRecord {
  readonly quoteId: QuoteId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly planId: PlanId;
  readonly approvalId: ApprovalId;
  readonly version: number;
  readonly state: QuoteState;
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
  readonly currency: Currency;
  readonly eligibilitySnapshotId: EligibilitySnapshotId;
  readonly termsHash: Sha256Hex;
  readonly termsVersion: string;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly sourceAvailableUntil: UtcInstant;
  readonly supersededByQuoteId?: QuoteId;
  /** A replacement quote names the paid quote it replaces and carries exactly its commercial terms (D-QUOTE-B6). */
  readonly replacesQuoteId?: QuoteId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface PriceEligibilitySnapshotRecord {
  readonly snapshotId: EligibilitySnapshotId;
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
  readonly projectId: ProjectId;
  readonly asOf: UtcInstant;
  readonly lookbackStartsAt: UtcInstant;
  readonly qualifyingProjectIds: ReadonlyArray<ProjectId>;
  readonly qualifyingCount: number;
  readonly repeatDiscountBps: number;
  readonly foundingSlotRef?: string;
  readonly foundingDiscountBps: number;
  readonly appliedDiscountBps: number;
  readonly policyVersion: string;
}

// --- payment orders, attempts, captures, observations ----------------------------------------------------------------------------

export interface PaymentOrderRecord {
  readonly orderId: PaymentOrderId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly approvalId: ApprovalId;
  readonly version: number;
  readonly state: PaymentOrderState;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly routeId: PaymentRouteId;
  readonly merchantRef: MerchantRef;
  readonly payeeDigest: Sha256Hex;
  readonly providerOrderId?: string;
  /** The provider-hosted approval page of the buyer (host allowlisted by the adapter); present once the provider order exists. */
  readonly providerApprovalUrl?: string;
  readonly expectedAmountCents: bigint;
  readonly expectedServiceCents: bigint;
  readonly expectedTaxCents: bigint;
  readonly currency: Currency;
  readonly termsHash: Sha256Hex;
  readonly idempotencyHash: Sha256Hex;
  /** Obligation allocated by COMPLETED captures (maintained by the database's single writer; never above the obligation). */
  readonly allocatedCents: bigint;
  readonly createdByMembershipId: MembershipId;
  readonly intentEntryId: JournalEntryId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface PaymentAttemptRecord {
  readonly attemptId: PaymentAttemptId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly refundId?: RefundId;
  readonly operation: Exclude<PaymentOperation, "WITHDRAW">;
  /** The ordinal of this attempt among the attempts of its logical operation (1, 2, ...; bounded, D-PROTO-B3). */
  readonly ordinal: number;
  readonly version: number;
  readonly state: PaymentAttemptState;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly requestHash: Sha256Hex;
  readonly providerRequestId: string;
  readonly dispatchDeadlineAt?: UtcInstant;
  readonly startedAt: UtcInstant;
  readonly lastObservedAt: UtcInstant;
  readonly evidenceHash?: Sha256Hex;
  readonly outcomeCode?: string;
  readonly intentEntryId?: JournalEntryId;
}

export interface CaptureFactRecord {
  readonly captureId: CaptureId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly version: number;
  readonly status: CaptureStatus;
  readonly provider: string;
  readonly environment: PaymentEnvironment;
  readonly providerCaptureId: string;
  readonly merchantRef: MerchantRef;
  readonly payeeDigest: Sha256Hex;
  readonly amountCents: bigint;
  readonly currency: Currency;
  /** Fixed when the capture is first observed COMPLETED (or REVERSED): service and tax paid toward the obligation, and excess. */
  readonly allocation: RefundComponents;
  readonly fundsState: FundsState;
  readonly providerFeeCents?: bigint;
  readonly providerCompletedAt?: UtcInstant;
  /** The source of the first authenticated observation the fact was born from (D-INIT-B1). */
  readonly firstObservationSource: ObservationSource;
  readonly firstObservedAt: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly attemptId?: PaymentAttemptId;
}

export interface ProviderObservationRecord {
  readonly observationId: ObservationId;
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

// --- commercial authorization -------------------------------------------------------------------------------------------------------

export interface CommercialAuthorizationRecord {
  readonly authorizationId: CommercialAuthorizationId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  /** The quote the capturing order charged: quoteId itself, or the replaced quote of a re-bound entitlement (D-QUOTE-B6). */
  readonly orderQuoteId: QuoteId;
  readonly captureId: CaptureId;
  /** The re-binding that allocated the capture to this (replacement) quote, when the entitlement is a re-bound one. */
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
  readonly version: number;
  readonly state: CommercialAuthorizationState;
  readonly honoredAfterPriceExpiry: boolean;
  readonly jobRef?: JobRef;
  readonly consumedAt?: UtcInstant;
  readonly deliveredAt?: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly revocationPhase?: RevocationPhase;
  /** A server token (CAPTURE_REVERSED, SERVICE_FULLY_REFUNDED, SOURCE_REPLACED); never customer text. */
  readonly revocationCode?: string;
  readonly createdAt: UtcInstant;
}

/**
 * The recorded allocation of one paid capture from the quote it paid to a replacement quote under the included pre-execution source
 * replacement (16 "Scope changes and credits"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18; migration 0015 purchase_rebindings).
 */
export interface PurchaseRebindingRecord {
  readonly rebindingId: PurchaseRebindingId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly fromQuoteId: QuoteId;
  readonly fromAuthorizationId: CommercialAuthorizationId;
  readonly toQuoteId: QuoteId;
  /** 1 for the first included replacement of the capture; bounded by the price policy's included replacements. */
  readonly allowanceOrdinal: number;
  readonly reasonCode: "PRE_EXECUTION_SOURCE_REPLACEMENT";
  /** The source lifecycle's lineage evidence (SourceLineageReader, provided by the upload package B07). */
  readonly lineageEvidenceHash: Sha256Hex;
  readonly requestedByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

// --- refunds ------------------------------------------------------------------------------------------------------------------------

/** The three refundable components of a capture: its allocated service, its allocated tax, and its excess over the obligation. */
export interface RefundComponents {
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly excessCents: bigint;
}

export interface RefundApprovalRecord {
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

export interface RefundRecord {
  readonly refundId: RefundId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly version: number;
  readonly state: RefundState;
  readonly origin: RefundOrigin;
  /** CMD031 reasonCode: a registry label (customer text, decision D-API-1 of B06); stored here, never in an event payload. */
  readonly reasonCode: string;
  readonly evidenceRef?: EvidenceRef;
  readonly termsHash: Sha256Hex;
  readonly deliveryPhase: DeliveryPhase;
  readonly proposed: RefundComponents;
  readonly requestedByMembershipId?: MembershipId;
  readonly requestedByUserId?: UserId;
  readonly requestedAt: UtcInstant;
  /** The immutable intent, present from APPROVED on. */
  readonly approved?: RefundApprovalRecord;
  readonly rejected?: { readonly code: string; readonly byUserId: UserId; readonly at: UtcInstant };
  readonly providerRefundId?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly completedAt?: UtcInstant;
  readonly failureCode?: string;
}

// --- fiscal documents, ledger, settlements, cases ----------------------------------------------------------------------------------

export interface TaxDocumentRecord {
  readonly documentId: TaxDocumentId;
  readonly agencyId: AgencyId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly refundId?: RefundId;
  readonly kind: TaxDocumentKind;
  readonly version: number;
  readonly state: TaxDocumentState;
  readonly fiscalProfileId: FiscalProfileId;
  readonly issuerRef: FiscalIssuerRef;
  readonly taxTreatment: TaxTreatment;
  readonly serviceCents: bigint;
  readonly taxCents: bigint;
  readonly currency: Currency;
  readonly correctsDocumentId?: TaxDocumentId;
  readonly supersedesDocumentId?: TaxDocumentId;
  readonly blockedReason?: string;
  readonly issueRequestHash?: Sha256Hex;
  readonly providerDocumentId?: string;
  readonly legalNumber?: string;
  readonly rejectionCode?: string;
  readonly evidenceHash?: Sha256Hex;
  readonly issuedAt?: UtcInstant;
}

export type LedgerAccount =
  | "PSP_RECEIVABLE"
  | "PSP_HELD"
  | "PSP_AVAILABLE"
  | "BANK_IN_TRANSIT"
  | "BANK_CASH"
  | "CONTRACT_LIABILITY"
  | "SERVICE_REVENUE"
  | "TAX_PAYABLE"
  | "CUSTOMER_OVERPAYMENT"
  | "REFUND_PAYABLE"
  | "PROCESSOR_EXPENSE"
  | "COMMISSION_PAYABLE"
  | "COMMISSION_EXPENSE"
  | "OWNER_CONTRIBUTION"
  | "OWNER_DISTRIBUTION";
/**
 * The kind of movement a posting set records and the event that may source it (migration 0017 ledger_entries_source_event): CAPTURE
 * capture.completed.v1, FEE capture.fee_observed.v1, FUNDS capture.funds_observed.v1, CHARGEBACK capture.reversed.v1, REFUND
 * refund.completed.v1, CORRECTION reconciliation_case.resolved.v1 (or a settlement's own correction), SETTLEMENT a settlement.
 */
export type LedgerSourceKind = "CAPTURE" | "REFUND" | "FEE" | "FUNDS" | "CHARGEBACK" | "SETTLEMENT" | "CORRECTION";

export interface LedgerEntryRecord {
  readonly entryId: LedgerEntryId;
  /** The agency whose commercial event the posting records; null for platform-level movements (settlement, withdrawal). */
  readonly agencyId: AgencyId | null;
  /** The source domain event (the posting set's idempotency identity); null for a settlement observation's posting. */
  readonly eventId: EventId | null;
  readonly settlementId?: SettlementId;
  readonly lineNo: number;
  readonly accountCode: LedgerAccount;
  readonly accountVersion: string;
  readonly direction: "DEBIT" | "CREDIT";
  readonly amountCents: bigint;
  readonly currency: string;
  readonly sourceKind: LedgerSourceKind;
  readonly sourceRef: string;
  readonly reversesEntryId?: LedgerEntryId;
  /** The economic date of the movement. */
  readonly effectiveAt: UtcInstant;
  /** When the platform observed the fact it posts (15 "Operational ledger": every posting includes its observed date). */
  readonly observedAt: UtcInstant;
  readonly postedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly policyVersion: string;
}

export interface SettlementRecord {
  readonly settlementId: SettlementId;
  readonly routeId: PaymentRouteId;
  readonly providerBalanceRef: string;
  readonly currency: string;
  readonly grossCents: bigint;
  readonly feeCents: bigint;
  readonly heldCents: bigint;
  readonly withdrawnCents: bigint;
  /** Actually available under an observed bank statement; never derived from a provider balance or a capture status. */
  readonly bankAvailableCents: bigint;
  readonly bankEvidenceHash?: Sha256Hex;
  readonly fxRate?: string;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
}

export interface ReconciliationCaseRecord {
  readonly caseId: ReconciliationCaseId;
  readonly agencyId: AgencyId;
  readonly orderId?: PaymentOrderId;
  readonly captureId?: CaptureId;
  readonly refundId?: RefundId;
  /** The provider object the case is about when no local fact holds it (a provider refund no local refund explains; 0019). */
  readonly providerRef?: string;
  readonly kind: ReconciliationCaseKind;
  readonly version: number;
  readonly state: "OPEN" | "RESOLVED";
  readonly detailCode: string;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly evidenceHash: Sha256Hex;
  readonly openedAt: UtcInstant;
  readonly resolvedAt?: UtcInstant;
  readonly resolutionCode?: string;
}

/**
 * An authenticated observation no order can take (B09-F9, D-ING-B3): its source is exactly one of a delivered webhook (its inbox
 * record; possibly unattributed), a dispatch response of a stored operation (its attempt) or a stored provider query (its
 * artifact); the latter two are attributed to the stored operation's order and agency.
 */
export interface ProviderEventExceptionRecord {
  readonly exceptionId: ProviderExceptionId;
  readonly source: ObservationSource;
  readonly agencyId?: AgencyId;
  readonly orderId?: PaymentOrderId;
  readonly inboxId?: InboxId;
  readonly attemptId?: PaymentAttemptId;
  readonly artifactRef?: EvidenceArtifactRef;
  readonly provider: string;
  readonly environment: "LOCAL" | "SANDBOX" | "LIVE";
  readonly kind: ProviderExceptionKind;
  readonly providerRef?: string;
  readonly amountCents?: bigint;
  readonly currency?: string;
  readonly evidenceHash: Sha256Hex;
  readonly observedAt: UtcInstant;
}

// --- bank-transfer route vocabulary (Payments V1, docs/design/ACH-ROUTE.md r12; lane KIT) -----------------------------------------------
//
// Rail- and provider-agnostic (DV1-01): no name below, in a table or in an event names a provider; `ProviderId` is route-version data
// ("wise" is configuration, never a type literal). These are shared types and closed vocabularies only; the guards and the behaviour
// that use them belong to the lanes L-ROUTE, L-INBOUND, L-REFUND and L-SETTLE. Migration 0045 mirrors every closed list below in
// kauro.bank_vocabulary (the persistence test proves the two equal).

/** The route kind of the V1 bank-transfer route (D-ACH-02; PaymentRouteRecord keeps its provider kinds untouched). */
export type PaymentRouteKind = "PROVIDER_CHECKOUT" | "BANK_TRANSFER";
/** The immutable account/profile/balance mapping of the receiving account at the provider; carries no credential (D-ACH-15). */
export type BankAccountRef = Branded<string, "BankAccountRef">;
/** The provider of a route version, as data (DV1-01). */
export type ProviderId = string;
/** The account-scoped provider identity of an incoming credit, never the reference or memo (D-ACH-07). */
export type BankCreditId = Branded<string, "BankCreditId">;
/** The provider-side identity of one outbound execution (r6 "Wise transfer ID"; DV1-01 `bankExecutionId`). */
export type BankExecutionId = Branded<string, "BankExecutionId">;
export type ExecutionAttemptId = Branded<string, "ExecutionAttemptId">;
export type ExecutionOfferId = Branded<string, "ExecutionOfferId">;
export type StatementImportId = Branded<string, "StatementImportId">;
export type TreasuryRefundId = Branded<string, "TreasuryRefundId">;

/** The rails a route version accepts (DV1-03); the version carries its own subset as data. */
export const BANK_RAILS = ["ACH", "DOMESTIC_WIRE"] as const;
export type BankRail = (typeof BANK_RAILS)[number];
/** A rail as observed: anything outside the accepted set stays a review exception (DV1-03). */
export type ObservedBankRail = BankRail | "OTHER" | "UNKNOWN";

/** The route's integration class. OWNER_MANUAL is the V1 mode (DV1-02): the owner enters and imports, Kauro classifies stored evidence. */
export type BankIntegrationClass = IntegrationClass | "OWNER_MANUAL";
/** D-ACH-02 / DV1-04. */
export type BankRouteState = "PENDING_VERIFICATION" | "VERIFIED" | "ENABLED" | "DISABLED";
export type BankRollout = "CONTROLLED" | "GENERAL";

/** D-ACH-05, DV1-06: the customer-facing order states added for BANK_TRANSFER (not part of the PaymentOrder registry contract; see machines.ts BANK_ORDER_EXTENSION). */
export const BANK_ORDER_STATES = ["AWAITING_TRANSFER", "PARTIALLY_RECEIVED", "RECEIVED_REVIEW"] as const;
export type BankOrderState = (typeof BANK_ORDER_STATES)[number];

/** D-ACH-07: the operational states of an observed incoming credit. */
export const BANK_CREDIT_STATES = ["DRAFT_MANUAL", "OBSERVED", "MATCH_REVIEW", "MATCHED", "APPLIED", "RETURN_REVIEW"] as const;
export type BankCreditState = (typeof BANK_CREDIT_STATES)[number];
/** Where a credit observation came from (D-ACH-07; OWNER_MANUAL in addition to PROVIDER_QUERY). */
export const BANK_CREDIT_SOURCES = ["OWNER_MANUAL", "PROVIDER_QUERY"] as const;
export type BankCreditSource = (typeof BANK_CREDIT_SOURCES)[number];
/** The status of a credit or debit as the evidence shows it (never coerced; UNRECOGNIZED blocks consequences). */
export const BANK_CREDIT_STATUSES = ["PENDING", "COMPLETED", "DENIED", "REVERSED", "UNRECOGNIZED"] as const;
export type BankCreditStatus = (typeof BANK_CREDIT_STATUSES)[number];

/** DV1-08: one V1 outbound movement of route money. RETURN is a refund or treasury refund, RESEND the re-send of a bounced return. */
export const EXECUTION_ATTEMPT_KINDS = ["RETURN", "RESEND"] as const;
export type ExecutionAttemptKind = (typeof EXECUTION_ATTEMPT_KINDS)[number];
/** DV1-08 machine: DECLARED -> UNCERTAIN; DECLARED or UNCERTAIN -> RECORDED or NOT_EXECUTED. */
export const EXECUTION_ATTEMPT_STATES = ["DECLARED", "UNCERTAIN", "RECORDED", "NOT_EXECUTED"] as const;
export type ExecutionAttemptState = (typeof EXECUTION_ATTEMPT_STATES)[number];
/** The states in which an attempt is open: at most one per source (the NEVER-RESEND fence, DV1-08). */
export const EXECUTION_ATTEMPT_OPEN_STATES: ReadonlyArray<ExecutionAttemptState> = Object.freeze(["DECLARED", "UNCERTAIN"]);
/** D-ACH-13 / D-ACH-19: the closed source union of a refund of route money. */
export const EXECUTION_SOURCE_KINDS = ["CAPTURE", "BANK_CREDIT"] as const;
export type ExecutionSourceKind = (typeof EXECUTION_SOURCE_KINDS)[number];
/** DV1-10: what proved "sent to the approved destination". Anything else is DESTINATION_UNPROVEN. */
export const DESTINATION_PROOFS = ["DP_FULL", "DP_RECIPIENT"] as const;
export type DestinationProof = (typeof DESTINATION_PROOFS)[number];
/** DV1-11: the commands whose request writes an execution offer first (Koffer): G2, G4 and X3-EXECUTED. */
export const EXECUTION_OFFER_COMMANDS = ["RECORD_RETURN", "RECORD_RESEND", "RESOLVE_EXECUTED"] as const;
export type ExecutionOfferCommand = (typeof EXECUTION_OFFER_COMMANDS)[number];
/** DV1-11: the gate outcome of the evidence read of one offer (the four rejections of §6 plus a classified result and the store's own failure). */
export const EXECUTION_GATE_OUTCOMES = ["CLASSIFIED", "UNKNOWN_EVIDENCE", "MALFORMED_EVIDENCE", "HASH_MISMATCH", "UNAUTHENTICATED_EVIDENCE", "EVIDENCE_UNAVAILABLE"] as const;
export type ExecutionGateOutcome = (typeof EXECUTION_GATE_OUTCOMES)[number];
/** DV1-10 correlation of a debit with an attempt; any one of them blocks NOT_EXECUTED. */
export const DEBIT_CORRELATIONS = ["CORR_REF", "CORR_RECIPIENT", "CORR_OFFERED", "CORR_DF"] as const;
export type DebitCorrelation = (typeof DEBIT_CORRELATIONS)[number];
/** DV1-08/10: the review cases the manual outbound path opens (kinds of the bank review cases; the lane that opens one adds its row). */
export const BANK_CASE_KINDS = [
  "UNCERTAIN_EFFECT",
  "DESTINATION_UNPROVEN",
  "REFUND_TERMINAL_CONTRADICTED",
  "UNDECLARED_OUTBOUND",
  "POTENTIAL_MATCH_UNRESOLVED",
  "RETURN_BOUNCED",
  "DOUBLE_RETURN_RISK",
  "MATCH_REVIEW",
  "PROVIDER_TIME_UNVERIFIED",
  "RECORD_REQUIRED",
  // the apply of a recorded settlement intent refused it (lane PV1-SETTLE two-step §3.3; R2 15:153 a case with amount and age)
  "SETTLEMENT_REFUSED",
] as const;
export type BankCaseKind = (typeof BANK_CASE_KINDS)[number];
/** The subject a bank review case names (0045 source_kind): a source of route money, or a recorded settlement intent (PV1-SETTLE). */
export const BANK_CASE_SOURCE_KINDS = ["CAPTURE", "BANK_CREDIT", "SETTLEMENT_REQUEST"] as const;
export type BankCaseSourceKind = (typeof BANK_CASE_SOURCE_KINDS)[number];
/** The kinds of line an imported statement carries (SI2): an incoming credit or an outgoing debit. */
export const STATEMENT_LINE_KINDS = ["CREDIT", "DEBIT"] as const;
export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];
/** The two independent coverage streams of an account (DV1-02; completing one never covers the other). */
export const COVERAGE_STREAMS = ["INBOUND", "OUTBOUND"] as const;
export type CoverageStream = (typeof COVERAGE_STREAMS)[number];

/** The version of the destination normalization and canonical encoding (DV1-11); a fingerprint is comparable only under the same four values. */
export const DESTINATION_NORM_VERSION = "destination-norm-v1";
/** What a stored destination fingerprint is: the keyed HMAC, never the numbers (DV1-10). */
export interface DestinationFingerprintRecord {
  /** Lower-case hex HMAC-SHA256 under the key named below. */
  readonly fingerprint: Sha256Hex;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly normVersion: string;
}
