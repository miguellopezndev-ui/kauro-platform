/**
 * Commercial records as the domain sees them (package B10; docs/design/B10-commercial-domain.md §3–§7; migrations 0028–0031): the
 * registry contracts Agency (its first designation), PriceEligibilitySnapshot (B09's record, extended by B10's founding facts),
 * SellerAgreement, Prospect, AttributionClaim, CommissionEntitlement, CommissionLine, CommissionAdjustment and CommissionStatement,
 * plus the platform records the design adds: qualifying purchases and the recurrence row, founding slots and reservations, quote
 * issuances, agreement acceptances, closures, relationship decisions, sellers and their legal reviews, payout destinations, prospect
 * evidence, contacts and suppressions, claim evidence, allocations and shares, sales accounts and assignments, assistance
 * agreements, terminations and tail entries, completions, pools, holds, funds observations, banking calendar versions, periods,
 * statement items, payout intents and reconciliations, and compensation-guard reviews.
 *
 * Amounts are `bigint` minor units inside the domain (B09 commerce/money, D-MONEY-B1); instants are canonical UTC instants of the
 * database clock (D10-CLOCK-1); durations are exact hours; calendar months are America/Bogota's (commercial/calendar.ts). Every
 * B10 record keys on `agency_id` where it is about an agency, so a display-name change touches none (R2-141, D10-AGY-3).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureId,
  CommercialAuthorizationId,
  EligibilitySnapshotId,
  FundsState,
  PaymentOrderId,
  QuoteId,
  QuoteRecord,
  PriceEligibilitySnapshotRecord,
} from "../commerce/records.js";
import type { AgencyId, AssuranceProofId, Branded, EventId, JournalEntryId, MembershipId, ProjectId, UserId } from "../model/ids.js";
import { COMMERCIAL_VOCABULARY as V } from "./vocabulary.js";

// --- ids ----------------------------------------------------------------------------------------------------------------------

export type QualifyingPurchaseId = Branded<string, "QualifyingPurchaseId">;
export type FoundingReservationId = Branded<string, "FoundingReservationId">;
export type AgreementAcceptanceId = Branded<string, "AgreementAcceptanceId">;
export type AgencyClosureId = Branded<string, "AgencyClosureId">;
export type RelationshipDecisionId = Branded<string, "RelationshipDecisionId">;
export type SellerId = Branded<string, "SellerId">;
export type SellerAgreementId = Branded<string, "SellerAgreementId">;
export type SellerLegalReviewId = Branded<string, "SellerLegalReviewId">;
export type SellerAssessmentId = Branded<string, "SellerAssessmentId">;
export type SellerTaxDocumentationId = Branded<string, "SellerTaxDocumentationId">;
export type PayoutDestinationId = Branded<string, "PayoutDestinationId">;
export type ProspectId = Branded<string, "ProspectId">;
/** A restricted prospect contact record (registry Prospect.businessContactRef: never raw details in a report). */
export type ProspectContactRef = Branded<string, "ProspectContactRef">;
export type ProspectSuppressionId = Branded<string, "ProspectSuppressionId">;
export type AttributionClaimId = Branded<string, "AttributionClaimId">;
export type AttributionAllocationId = Branded<string, "AttributionAllocationId">;
export type CommissionEntitlementId = Branded<string, "CommissionEntitlementId">;
export type AccountAssignmentId = Branded<string, "AccountAssignmentId">;
/** A prepared service assignment stating the compensation for new work (CMD048 serviceAssignmentRef). */
export type ServiceAssignmentRef = Branded<string, "ServiceAssignmentRef">;
export type AssistanceAgreementId = Branded<string, "AssistanceAgreementId">;
/** Prepared termination terms (CMD050 terminationTermsRef). */
export type TerminationTermsRef = Branded<string, "TerminationTermsRef">;
/** The reviewed list of the seller's active opportunities (CMD050 activeOpportunityManifestRef). */
export type TerminationManifestRef = Branded<string, "TerminationManifestRef">;
export type SellerTerminationId = Branded<string, "SellerTerminationId">;
export type TailEntryId = Branded<string, "TailEntryId">;
export type PurchaseCompletionId = Branded<string, "PurchaseCompletionId">;
export type CommissionPoolId = Branded<string, "CommissionPoolId">;
export type CommissionLineId = Branded<string, "CommissionLineId">;
export type CommissionAdjustmentId = Branded<string, "CommissionAdjustmentId">;
export type CommissionHoldId = Branded<string, "CommissionHoldId">;
export type BankingCalendarVersionId = Branded<string, "BankingCalendarVersionId">;
export type CommissionPeriodId = Branded<string, "CommissionPeriodId">;
export type CommissionStatementId = Branded<string, "CommissionStatementId">;
export type StatementItemId = Branded<string, "StatementItemId">;
export type PayoutIntentId = Branded<string, "PayoutIntentId">;
export type PayoutReconciliationId = Branded<string, "PayoutReconciliationId">;
export type GuardReviewId = Branded<string, "GuardReviewId">;
/** An owner-prepared allocation awaiting acceptance (CMD047 shareAllocationRef). */
export type ShareAllocationRef = AttributionAllocationId;

// --- vocabularies ---------------------------------------------------------------------------------------------------------------

type Token<K extends keyof typeof V> = (typeof V)[K][number];

/** The agency's recorded buyer type (A3 3.7; B11 W6 stores `agency` / `in-house`, the BuyerTypeReader maps). */
export type BuyerType = Token<"buyerTypes">;
/** How a qualifying purchase's founding rate is backed: no founding rate, a consumed slot, or a fixture's unbacked rate (D10-REC-3). */
export type FoundingBasis = Token<"foundingBases">;
/** The founding outcome a quote's eligibility view states (§3.4 CreateQuoteView.eligibility.foundingOffer). */
export type FoundingOffer = Token<"foundingOffers">;
export type FoundingReservationState = Token<"foundingReservationStates">;
/** A published agreement document an agency accepts at activation (CMD002 termsVersion, privacyAgreementVersion). */
export type ServiceAgreementKind = Token<"serviceAgreementKinds">;
export type ServiceAgreementState = Token<"serviceAgreementStates">;
/**
 * A reviewed relationship between two agencies (R2-141; example 24): kept separate although related, a commercial consolidation
 * approved, or confirmed duplicate accounts. Each is a recorded decision with no data effect (D10-AGY-3; Q10-3).
 */
export type RelationshipKind = Token<"relationshipKinds">;
export type SellerState = Token<"sellerStates">;
/** registry SellerAgreement.classification: the actual reviewed relationship. */
export type SellerClassification = Token<"sellerClassifications">;
/** Whether a negative balance may be offset against future eligible amounts (D10-NEG-1; KC017). */
export type OffsetTerms = Token<"offsetTerms">;
export type LegalReviewOutcome = Token<"legalReviewOutcomes">;
export type PayoutDestinationState = Token<"payoutDestinationStates">;
export type ProspectState = Token<"prospectStates">;
/** Prospects are agencies only (18 "Prospect qualification" as amended by A3; D58): the only segment the evidence table admits. */
export type ProspectSegment = Token<"prospectSegments">;
export type AttributionClaimState = Token<"attributionClaimStates">;
/** Substantive acquisition activity; a list import or a tracking link alone is not a claim (17 "Attribution subject"). */
export type ClaimActivityKind = Token<"claimActivityKinds">;
export type CommissionEntitlementState = Token<"entitlementStates">;
/** A pool's and an entitlement's source: the agency's frozen acquisition allocation, or a prospective assistance agreement (D10-ASSIST-1). */
export type CommissionSource = Token<"commissionSources">;
/** What a prepared service assignment compensates for new work (R2-095; D10-ASSIGN-1). */
export type ServiceCompensation = Token<"serviceCompensations">;
/** An assistance agreement covers one named project or the agency's next purchase (§5 Assistance). */
export type AssistanceScope = Token<"assistanceScopes">;
export type CompletionKind = Token<"completionKinds">;
export type CommissionLineState = Token<"lineStates">;
export type AdjustmentReason = Token<"adjustmentReasons">;
export type AdjustmentDirection = Token<"adjustmentDirections">;
export type CommissionHoldState = Token<"holdStates">;
/**
 * Why cents are held (D10-HOLD-1; 8.1): an unverifiable provider instant (example 10), funds the provider holds (example 14), a
 * failed or returned payout, the seller's dispute of part of a line (R2-102), a disputed attribution (its entitlement's lines only).
 */
export const HOLD_REASONS = V.holdReasons;
export type HoldReason = (typeof HOLD_REASONS)[number];
/** The banking calendar's origin: a verified feed (B15) or the labelled test fixture, which makes a close SIMULATED (D10-CAL-1). */
export type CalendarSource = Token<"calendarSources">;
export type CommissionPeriodState = Token<"periodStates">;
export type CommissionStatementState = Token<"statementStates">;
/** What a statement item reports (§7 CMD051 items; example 21 "separate totals"). */
export type StatementItemKind = Token<"statementItemKinds">;
/** The owner's resolution of a negative balance without signed offset terms (D10-NEG-1; example 7). */
export type RecoveryAction = Token<"recoveryActions">;
export type PayoutIntentState = Token<"payoutIntentStates">;
/** What authenticated payout evidence reports (PayoutEvidenceVerifier; "Submitting a transfer is not proof"). */
export type PayoutEvidenceStatus = Token<"payoutEvidenceStatuses">;
/** Who bears the transfer fee of a payout (policy commission.feeBearer, brand-mapped by amendment A2): the company, never the seller. */
export type PayoutFeeBearer = Token<"payoutFeeBearers">;
export type GuardResult = Token<"guardResults">;

// --- recurrence and the founding cohort (§3; migration 0028) -----------------------------------------------------------------

/**
 * One original CommercialAuthorization whose capture alone paid the whole obligation (D10-FIRST-1; R2-140): the designation
 * trigger records it in the payment service's reconciler transaction. Nothing rewrites a row (KC001).
 */
export interface QualifyingPurchaseRecord {
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
  readonly authorizationId: CommercialAuthorizationId;
  /** 1 is the sticky first designation (policy firstProjectDesignation STICKY_AFTER_FIRST_CAPTURE); later purchases count up. */
  readonly confirmationSeq: number;
  /** The authorization's server instant: the durable confirmation that anchors the window (policy windowAnchor). */
  readonly confirmedAt: UtcInstant;
  /** The capture's authenticated provider completion, recorded apart; absent when the provider reported none (example 10). */
  readonly providerCompletedAt?: UtcInstant;
  readonly orderCreatedAt: UtcInstant;
  /** The capture's allocated service (never tax, excess or a fee): the commission basis before refunds. */
  readonly allocatedServiceCents: bigint;
  readonly foundingReservationId?: FoundingReservationId;
  readonly foundingBasis: FoundingBasis;
}

/** One row per agency serializing designations (the recurrence lock's exclusive half; D10-REC-2). */
export interface AgencyRecurrenceRecord {
  readonly agencyId: AgencyId;
  /** The last confirmation sequence assigned; the next qualifying purchase takes the following one. */
  readonly lastConfirmationSeq: number;
  readonly firstPurchaseId: QualifyingPurchaseId;
  readonly firstCaptureId: CaptureId;
  readonly firstConfirmedAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** One slot of a price policy's founding cohort (R2-INITIAL: slots 1..3 = pricing.foundingAgencyCount; D10-FOUND-1). */
export interface FoundingSlotRecord {
  readonly policyVersion: string;
  readonly slotNo: number;
  readonly held: boolean;
  readonly liveReservationId?: FoundingReservationId;
}

/** A founding reservation (machine FoundingReservation): one per agency per cohort, ever; it ends at its quote's expiry (D10-FOUND-3). */
export interface FoundingReservationRecord {
  readonly reservationId: FoundingReservationId;
  readonly policyVersion: string;
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
  readonly slotNo: number;
  readonly state: FoundingReservationState;
  readonly version: number;
  /** The quote's `expires_at`: never extended by a superseding or replacement quote. */
  readonly endsAt: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** What a public pricing page may know of the cohort: counts, never an agency (FoundingOfferReader; R2-091, R2-127). */
export interface FoundingOfferView {
  readonly policyVersion: string;
  readonly slots: number;
  readonly reservableSlots: number;
  readonly discountBps: number;
}

/** The record binding a CMD027 journal entry to what it issued (quote_issuances; D10-QUOTE-1, D10-QUOTE-4). */
export interface QuoteIssuanceRecord {
  readonly journalEntryId: JournalEntryId;
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
  readonly snapshotId: EligibilitySnapshotId;
  readonly reservationId?: FoundingReservationId;
  readonly supersededQuoteId?: QuoteId;
  /** A replacement issuance (§3.5): the paid quote whose terms the replacement carries. */
  readonly replacesQuoteId?: QuoteId;
  readonly issuedAt: UtcInstant;
}

/** B09's snapshot with B10's founding facts (the snapshot names its reservation; the reservation names its quote). */
export interface CommercialEligibilitySnapshot {
  readonly snapshot: PriceEligibilitySnapshotRecord;
  readonly foundingOffer: FoundingOffer;
  readonly reservation: FoundingReservationRecord | null;
}

/** One quote issuance's outcome (§3.4): the quote and snapshot, the reservation taken, and the unpaid quote it superseded. */
export interface QuoteIssuance {
  readonly quote: QuoteRecord;
  readonly eligibility: CommercialEligibilitySnapshot;
  readonly superseded: { readonly quote: QuoteRecord; readonly releasedReservation: FoundingReservationRecord | null } | null;
  readonly issuance: QuoteIssuanceRecord;
}

/** A divergence kauro.eligibility_findings() reports (D10-REC-3; Q10-1, Q10-7): the product's writer never produces one. */
export interface EligibilityFinding {
  readonly quoteId: QuoteId;
  readonly agencyId: AgencyId;
  readonly finding: Token<"eligibilityFindings">;
}

// --- agency lifecycle (§4; migration 0028) -------------------------------------------------------------------------------------

/** A published service agreement document (service_agreement_versions): the only versions CMD002 accepts (D10-AGY-1). */
export interface ServiceAgreementVersionRecord {
  readonly kind: ServiceAgreementKind;
  readonly version: string;
  readonly documentHash: Sha256Hex;
  readonly state: ServiceAgreementState;
  readonly publishedAt?: UtcInstant;
}

/** An append-only acceptance at activation (agency_agreement_acceptances): no default, no implicit signature. */
export interface AgreementAcceptanceRecord {
  readonly acceptanceId: AgreementAcceptanceId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly termsVersion: string;
  readonly termsDocumentHash: Sha256Hex;
  readonly privacyAgreementVersion: string;
  readonly privacyDocumentHash: Sha256Hex;
  /** The reviewed billing profile the activation names (the agency's legal_profile_ref). */
  readonly legalProfileRef: string;
  readonly acceptedAt: UtcInstant;
}

/** One open reconciliation case of the agency, as the closure inventories it (D10-AGY-4): kind, amount and age. */
export interface ClosureCaseEntry {
  readonly caseId: string;
  readonly kind: string;
  readonly amountCents?: bigint;
  readonly openedAt: UtcInstant;
}

/** The obligations inventory of a closure request (§4 CMD043), read after the agency's row lock. */
export interface ClosureObligations {
  /** A payment order or refund in flight or uncertain: the request itself is refused CLOSURE_OBLIGATIONS_UNRECONCILED. */
  readonly inFlight: { readonly paymentOrderIds: ReadonlyArray<PaymentOrderId>; readonly refundIds: ReadonlyArray<string> };
  readonly openQuoteIds: ReadonlyArray<QuoteId>;
  readonly liveAuthorizationIds: ReadonlyArray<CommercialAuthorizationId>;
  readonly openRefundIds: ReadonlyArray<string>;
  readonly nonTerminalTaxDocumentIds: ReadonlyArray<string>;
  readonly openCases: ReadonlyArray<ClosureCaseEntry>;
  /** B06's ActiveWorkInspector answer: live work of the agency, by count. */
  readonly activeWork: number;
}

/** The closure record (agency_closures): the inventory at the request and the managed-deletion schedule (the CLOSED edge is B16's). */
export interface AgencyClosureRecord {
  readonly closureId: AgencyClosureId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly assuranceProofId: AssuranceProofId;
  readonly obligations: ClosureObligations;
  readonly withdrawnQuoteIds: ReadonlyArray<QuoteId>;
  readonly deletionScheduledAt: UtcInstant;
  readonly requestedAt: UtcInstant;
}

/** A reviewed relationship decision between two agencies: recorded evidence, no merged data, no changed eligibility (R2-141). */
export interface RelationshipDecisionRecord {
  readonly decisionId: RelationshipDecisionId;
  readonly agencyIds: readonly [AgencyId, AgencyId];
  readonly kind: RelationshipKind;
  /** The enumerated treatment of each area (quote eligibility, orders, attribution, access, legal records), as a reviewed token. */
  readonly treatmentCode: string;
  readonly evidenceHash: Sha256Hex;
  readonly reviewedBy: UserId;
  readonly effectiveAt: UtcInstant;
  readonly recordedAt: UtcInstant;
}

// --- sellers (§5; migration 0029) -------------------------------------------------------------------------------------------------

/** A seller (machine Seller) bound to one individually managed corporate identity (D10-CTX-2). */
export interface SellerRecord {
  readonly sellerId: SellerId;
  readonly userId: UserId;
  readonly state: SellerState;
  readonly version: number;
  /** The agreement the seller was activated on (its compensation version). */
  readonly activeAgreementId?: SellerAgreementId;
  readonly createdAt: UtcInstant;
  readonly activatedAt?: UtcInstant;
  readonly terminatedAt?: UtcInstant;
}

/** registry SellerAgreement plus the terms the ledger needs (D10-SELL-1; D10-NEG-1; D10-GUARD-1). */
export interface SellerAgreementRecord {
  readonly agreementId: SellerAgreementId;
  readonly sellerId: SellerId;
  /** The version string claims and entitlements cite (registry AttributionClaim.agreementVersion). */
  readonly agreementVersion: string;
  readonly classification: SellerClassification;
  readonly startsAt: UtcInstant;
  readonly endsAt?: UtcInstant;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly recurringMonths: number;
  readonly signedTermsHash: Sha256Hex;
  readonly signedAt?: UtcInstant;
  readonly legalReviewRef: SellerLegalReviewId;
  readonly offsetTerms: OffsetTerms;
  readonly retainerCentsPerMonth: bigint;
  readonly compensationPolicyVersion: string;
}

/** The substance-based review of a seller's classification (17 "Activation prerequisites"): a label alone never activates. */
export interface SellerLegalReviewRecord {
  readonly reviewId: SellerLegalReviewId;
  readonly sellerId: SellerId;
  readonly agreementId: SellerAgreementId;
  readonly classification: SellerClassification;
  readonly outcome: LegalReviewOutcome;
  readonly reviewerRef: string;
  readonly evidenceHash: Sha256Hex;
  readonly reviewedAt: UtcInstant;
}

/** Assessment evidence and tax documentation records of a seller (CMD049 prerequisites; Q10-9). */
export interface SellerAssessmentRecord {
  readonly assessmentId: SellerAssessmentId;
  readonly sellerId: SellerId;
  readonly evidenceHash: Sha256Hex;
  readonly confidentialityAcceptedAt: UtcInstant;
  readonly recordedAt: UtcInstant;
}

export interface SellerTaxDocumentationRecord {
  readonly documentationId: SellerTaxDocumentationId;
  readonly sellerId: SellerId;
  readonly evidenceHash: Sha256Hex;
  readonly recordedAt: UtcInstant;
}

/**
 * A versioned payout destination (machine PayoutDestination): VERIFIED only with the seller's own step-up proof at the change and an
 * owner verification at least 172 800 s later (D10-SELL-2; Q10-5). The account itself is never here: a masked label and a digest.
 */
export interface PayoutDestinationRecord {
  readonly destinationId: PayoutDestinationId;
  readonly sellerId: SellerId;
  readonly destinationVersion: number;
  readonly maskedLabel: string;
  readonly destinationDigest: Sha256Hex;
  readonly currency: string;
  readonly state: PayoutDestinationState;
  readonly version: number;
  readonly changeProofId?: AssuranceProofId;
  readonly changedAt: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly verifiedBy?: UserId;
}

/** The facts CMD049 requires and the database repeats (KC005; D10-SELL-1), read after the seller's transition lock. */
export interface SellerActivationFacts {
  readonly agreement: SellerAgreementRecord | null;
  readonly legalReview: SellerLegalReviewRecord | null;
  readonly assessment: SellerAssessmentRecord | null;
  readonly taxDocumentation: SellerTaxDocumentationRecord | null;
  readonly verifiedDestination: PayoutDestinationRecord | null;
  /** The seller's identity is VERIFIED with a multi-factor method enrolled. */
  readonly identityVerifiedWithMfa: boolean;
}

// --- prospects, claims and attribution (§5; migration 0029) ------------------------------------------------------------------------

/** Lawful, dated evidence of where and why a prospect was collected (registry Prospect.sourceEvidenceHash; D10-PROS-1). */
export interface ProspectSourceEvidenceRecord {
  readonly evidenceHash: Sha256Hex;
  /** The seller (or null: the owner) who recorded it; CMD045 accepts only the caller's own evidence. */
  readonly recordedBySellerId?: SellerId;
  readonly recordedByUserId: UserId;
  readonly sourceUrlDigest: Sha256Hex;
  /** The observation date, a calendar date YYYY-MM-DD. */
  readonly observedOn: string;
  readonly lawfulBasis: string;
  readonly segment: ProspectSegment;
  readonly recordedAt: UtcInstant;
}

/** A restricted business contact: only its suppression key leaves the table. */
export interface ProspectContactRecord {
  readonly contactRef: ProspectContactRef;
  /** A digest of the normalized contact identity, the key suppression matches (KC016). */
  readonly contactKey: Sha256Hex;
  readonly recordedAt: UtcInstant;
}

/** registry Prospect plus the platform's key, ownership and version (born RESEARCHED, minimized; §5 Prospects). */
export interface ProspectRecord {
  readonly prospectId: ProspectId;
  readonly organizationLabel: string;
  /** KAURO_PROSPECT_ORGANIZATION_V1 of the normalized business domain (commercial/prospects.ts): one live prospect per key. */
  readonly organizationKey: Sha256Hex;
  readonly businessContactRef?: ProspectContactRef;
  readonly sourceEvidenceHash: Sha256Hex;
  readonly jurisdiction: string;
  readonly state: ProspectState;
  readonly suppressed: boolean;
  readonly ownerSellerId?: SellerId;
  readonly registeredByUserId: UserId;
  readonly version: number;
  readonly createdAt: UtcInstant;
}

/** A suppression by organization key or contact key; it survives spelling and re-import (KC016; CMD045-DENY). */
export interface ProspectSuppressionRecord {
  readonly suppressionId: ProspectSuppressionId;
  readonly organizationKey?: Sha256Hex;
  readonly contactKey?: Sha256Hex;
  readonly reasonCode: string;
  readonly recordedAt: UtcInstant;
}

/** Substantive acquisition evidence of a claim (registry AttributionClaim.evidenceHash; D10-CLAIM-1). */
export interface ClaimEvidenceRecord {
  readonly evidenceHash: Sha256Hex;
  readonly sellerId: SellerId;
  readonly prospectId: ProspectId;
  readonly firstMeaningfulContactAt?: UtcInstant;
  readonly qualifiedNeed: boolean;
  readonly activityKinds: ReadonlyArray<ClaimActivityKind>;
  readonly recordedAt: UtcInstant;
}

/** registry AttributionClaim plus its review deadline (SUBMITTED + 2160 h) and version. */
export interface AttributionClaimRecord {
  readonly claimId: AttributionClaimId;
  readonly prospectId: ProspectId;
  readonly sellerId: SellerId;
  readonly agreementVersion: string;
  readonly evidenceHash: Sha256Hex;
  readonly state: AttributionClaimState;
  readonly version: number;
  readonly submittedAt: UtcInstant;
  readonly reviewDeadlineAt: UtcInstant;
  readonly acceptedAt?: UtcInstant;
  /** The review deadline while SUBMITTED or DISPUTED; acceptance + 2160 h once ACCEPTED (registry AttributionClaim.expiresAt). */
  readonly expiresAt: UtcInstant;
}

/** One beneficiary's share of a frozen allocation; each share's pool terms equal its signed agreement (KC003). */
export interface AllocationShare {
  readonly sellerId: SellerId;
  readonly claimId: AttributionClaimId;
  readonly agreementId: SellerAgreementId;
  readonly shareBps: number;
}

/** The owner's acceptance of attribution for one agency (D10-ATTR-1): prepared, then frozen once; shares sum to exactly 10 000 bps. */
export interface AttributionAllocationRecord {
  readonly allocationId: AttributionAllocationId;
  readonly agencyId: AgencyId;
  readonly prospectId: ProspectId;
  /** Evidence that the prospect is this agency. */
  readonly identityEvidenceHash: Sha256Hex;
  /** The claims it rules on and the reason (never timestamps alone, 17). */
  readonly ruledClaimIds: ReadonlyArray<AttributionClaimId>;
  readonly decisionReasonCode: string;
  readonly shares: ReadonlyArray<AllocationShare>;
  readonly preparedAt: UtcInstant;
  readonly frozenAt?: UtcInstant;
}

/**
 * registry CommissionEntitlement plus its source (D10-ATTR-2, D10-ASSIST-1). The first capture, window, share and agreement are
 * immutable; the window ends twelve calendar months after the first confirmation at the same America/Bogota wall time.
 */
export interface CommissionEntitlementRecord {
  readonly entitlementId: CommissionEntitlementId;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly source: CommissionSource;
  readonly allocationId?: AttributionAllocationId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly firstCaptureId: CaptureId;
  readonly windowStartsAt: UtcInstant;
  readonly windowEndsAt: UtcInstant;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly shareBps: number;
  readonly state: CommissionEntitlementState;
  readonly version: number;
  readonly createdAt: UtcInstant;
}

/** One sales account per agency (versioned): the current operational owner, never an entitlement (D10-ASSIGN-1). */
export interface SalesAccountRecord {
  readonly agencyId: AgencyId;
  readonly version: number;
  readonly currentAssignmentId?: AccountAssignmentId;
  readonly createdAt: UtcInstant;
}

/** A prepared service assignment: the compensation of the new owner's new work (none, or an assistance agreement; R2-095). */
export interface ServiceAssignmentRecord {
  readonly serviceAssignmentRef: ServiceAssignmentRef;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly compensation: ServiceCompensation;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly preparedAt: UtcInstant;
}

/** An append-only account assignment; one is current per agency. */
export interface AccountAssignmentRecord {
  readonly assignmentId: AccountAssignmentId;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly serviceAssignmentRef: ServiceAssignmentRef;
  readonly startsAt: UtcInstant;
  readonly endsAt?: UtcInstant;
}

/** A prospective assistance agreement (D10-ASSIST-1): its pool applies only to a purchase whose order was created after signing. */
export interface AssistanceAgreementRecord {
  readonly assistanceAgreementId: AssistanceAgreementId;
  readonly sellerId: SellerId;
  readonly agencyId: AgencyId;
  readonly scope: AssistanceScope;
  readonly projectId?: ProjectId;
  /** 400 bps by default; 1000 bps for an inbound buyer's complete closing effort (A3 7.1). */
  readonly rateBps: number;
  readonly signedTermsHash: Sha256Hex;
  readonly signedAt: UtcInstant;
}

/** The reviewed manifest of the seller's active opportunities at termination (CMD050; D10-TERM-1). */
export interface TerminationManifestRecord {
  readonly manifestRef: TerminationManifestRef;
  readonly sellerId: SellerId;
  readonly claimIds: ReadonlyArray<AttributionClaimId>;
  readonly preparedAt: UtcInstant;
}

export interface TerminationTermsRecord {
  readonly termsRef: TerminationTermsRef;
  readonly sellerId: SellerId;
  readonly termsHash: Sha256Hex;
  readonly effectiveAt: UtcInstant;
  readonly preparedAt: UtcInstant;
}

export interface SellerTerminationRecord {
  readonly terminationId: SellerTerminationId;
  readonly sellerId: SellerId;
  readonly termsRef: TerminationTermsRef;
  readonly manifestRef: TerminationManifestRef;
  readonly effectiveAt: UtcInstant;
  readonly recordedAt: UtcInstant;
}

/** A 2160-hour tail for one enumerated, accepted, unexpired claim whose agency has no qualifying purchase (KC011; R2-100). */
export interface TerminationTailEntryRecord {
  readonly entryId: TailEntryId;
  readonly terminationId: SellerTerminationId;
  readonly sellerId: SellerId;
  readonly claimId: AttributionClaimId;
  readonly prospectId: ProspectId;
  readonly endsAt: UtcInstant;
}

// --- the commission ledger (§6; migration 0030) -------------------------------------------------------------------------------------

/** A STAGE or FINAL completion of a qualifying purchase (PreparationCompletionSource); one per purchase and kind. */
export interface PurchaseCompletionRecord {
  readonly completionId: PurchaseCompletionId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly kind: CompletionKind;
  readonly completedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  /** The source that reported it (e.g. B09's delivered authorization, B13's stages, a labelled fake). */
  readonly source: string;
  readonly recordedAt: UtcInstant;
}

/** The capture's funds availability as observed (capture.funds_observed.v1, subscribed for COMMISSIONS). */
export interface CaptureFundsObservationRecord {
  readonly captureId: CaptureId;
  readonly fundsState: FundsState;
  readonly sourceEventId: EventId;
  readonly observedAt: UtcInstant;
}

/** One pool per (qualifying purchase, source) (D10-POOL-1): pool = round_half_up_bps(basis, rate) once (KC002). */
export interface CommissionPoolRecord {
  readonly poolId: CommissionPoolId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly captureId: CaptureId;
  readonly source: CommissionSource;
  readonly allocationId?: AttributionAllocationId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly basisCents: bigint;
  readonly rateBps: number;
  readonly poolCents: bigint;
  readonly policyVersion: string;
  readonly createdAt: UtcInstant;
}

/** registry CommissionLine plus its pool, beneficiary, share, paid cents and version (one per pool and beneficiary). */
export interface CommissionLineRecord {
  readonly lineId: CommissionLineId;
  readonly poolId: CommissionPoolId;
  readonly entitlementId: CommissionEntitlementId;
  readonly sellerId: SellerId;
  readonly captureId: CaptureId;
  readonly shareBps: number;
  readonly rateBps: number;
  readonly netServiceBasisCents: bigint;
  readonly cumulativeEntitlementCents: bigint;
  /** The first posting: the accrual before any adjustment (registry "Prior positive total before explicit adjustments"). */
  readonly previousPostedCents: bigint;
  readonly paidCents: bigint;
  readonly state: CommissionLineState;
  readonly version: number;
  readonly eligibleAt?: UtcInstant;
  readonly heldReason?: HoldReason;
  readonly reviewAt?: UtcInstant;
  readonly policyVersion: string;
  readonly createdAt: UtcInstant;
}

/** registry CommissionAdjustment: the cumulative difference of one line for one source event, UNIQUE (line, source event) (KC015). */
export interface CommissionAdjustmentRecord {
  readonly adjustmentId: CommissionAdjustmentId;
  readonly commissionLineId: CommissionLineId;
  readonly reason: AdjustmentReason;
  readonly direction: AdjustmentDirection;
  /** |new cumulative - previous cumulative|; the direction carries the sign. */
  readonly amountCents: bigint;
  readonly newCumulativeEntitlementCents: bigint;
  readonly sourceEventId: EventId;
  readonly agreementVersion: string;
  readonly createdAt: UtcInstant;
}

/** An amount held on a line (machine CommissionHold; D10-HOLD-1): at most the line's unpaid cents, with reason and review date. */
export interface CommissionHoldRecord {
  readonly holdId: CommissionHoldId;
  readonly lineId: CommissionLineId;
  readonly amountCents: bigint;
  readonly reason: HoldReason;
  readonly reviewAt: UtcInstant;
  readonly state: CommissionHoldState;
  readonly version: number;
  readonly openedAt: UtcInstant;
  readonly resolvedAt?: UtcInstant;
}

// --- periods, statements and payouts (§7; migration 0031) ------------------------------------------------------------------------

/** A recorded banking calendar version (BankingCalendarSource): jurisdiction CO, its source, its non-banking dates (D10-CAL-1). */
export interface BankingCalendarRecord {
  readonly calendarVersionId: BankingCalendarVersionId;
  readonly jurisdiction: "CO";
  readonly source: CalendarSource;
  /** Calendar dates YYYY-MM-DD that are not banking days besides weekends. */
  readonly nonbankingDates: ReadonlyArray<string>;
  readonly evidenceHash: Sha256Hex;
  readonly recordedAt: UtcInstant;
}

/** One calendar month in America/Bogota, [start, end), with its close and pay dates and the calendar version they came from. */
export interface CommissionPeriodRecord {
  readonly periodId: CommissionPeriodId;
  /** YYYY-MM of the month in America/Bogota. */
  readonly month: string;
  readonly startsAt: UtcInstant;
  readonly endsAt: UtcInstant;
  readonly state: CommissionPeriodState;
  readonly version: number;
  /** The 5th banking day after month-end (policy statementBusinessDay), a calendar date. */
  readonly closeDueOn: string;
  /** The 10th banking day after month-end (policy payBusinessDay), a calendar date. */
  readonly payDueOn: string;
  readonly calendarVersionId: BankingCalendarVersionId;
  readonly closedAt?: UtcInstant;
}

/** registry CommissionStatement plus its period, calendar, totals and label; immutable once ISSUED (D10-STMT-1). */
export interface CommissionStatementRecord {
  readonly statementId: CommissionStatementId;
  readonly periodId: CommissionPeriodId;
  readonly sellerId: SellerId;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  readonly lineIds: ReadonlyArray<CommissionLineId>;
  readonly payableCents: bigint;
  readonly heldCents: bigint;
  /** The separate totals of example 21: accrued pending, eligible, held, paid and the negative balance, never one sum. */
  readonly accruedPendingCents: bigint;
  readonly eligibleCents: bigint;
  readonly paidCents: bigint;
  readonly negativeBalanceCents: bigint;
  readonly state: CommissionStatementState;
  readonly version: number;
  readonly calendarVersionId: BankingCalendarVersionId;
  /** Closed on a TEST_FIXTURE calendar: labelled SIMULATED, never a real statement date (D10-CAL-1). */
  readonly simulated: boolean;
  readonly payDueOn: string;
  readonly cutoffHash: Sha256Hex;
  readonly payoutEvidenceHash?: Sha256Hex;
  readonly issuedAt: UtcInstant;
}

/**
 * One item of a statement (§7 CMD051): the agency and project reference, first or repeat, basis, rate, share, cumulative,
 * previously paid, adjustment, hold with reason and review date, and payable — without customer CRM values (example 25).
 */
export interface StatementItemRecord {
  readonly itemId: StatementItemId;
  readonly statementId: CommissionStatementId;
  readonly kind: StatementItemKind;
  readonly lineId?: CommissionLineId;
  readonly adjustmentId?: CommissionAdjustmentId;
  readonly holdId?: CommissionHoldId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly firstOrRepeat: "FIRST" | "REPEAT" | "ASSISTANCE";
  readonly basisCents: bigint;
  readonly rateBps: number;
  readonly shareBps: number;
  readonly cumulativeCents: bigint;
  readonly previouslyPaidCents: bigint;
  /** Signed: a decrease is negative. */
  readonly adjustmentCents: bigint;
  readonly heldCents: bigint;
  readonly holdReason?: HoldReason;
  readonly reviewAt?: UtcInstant;
  readonly payableCents: bigint;
  /** Only on a NEGATIVE_BALANCE item without signed offset terms: the owner's concrete resolution actions (D10-NEG-1). */
  readonly recoveryActions?: ReadonlyArray<RecoveryAction>;
}

/** One authorized payout of exactly a statement's payable (D10-PAY-1): it keeps its destination whatever changes later (R2-103). */
export interface PayoutIntentRecord {
  readonly intentId: PayoutIntentId;
  readonly statementId: CommissionStatementId;
  readonly sellerId: SellerId;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly feeBearer: PayoutFeeBearer;
  readonly destinationId: PayoutDestinationId;
  readonly destinationVersion: number;
  readonly destinationDigest: Sha256Hex;
  /** The stable reference `kauro-payout-<intentId>` the evidence must name. */
  readonly reference: string;
  readonly state: PayoutIntentState;
  readonly version: number;
  readonly authorizedBy: UserId;
  readonly authorizationProofId: AssuranceProofId;
  readonly authorizedAt: UtcInstant;
}

/** A reconciliation of an intent against authenticated evidence (CMD053; D10-PAY-2): failed and returned transfers stay recorded. */
export interface PayoutReconciliationRecord {
  readonly reconciliationId: PayoutReconciliationId;
  readonly intentId: PayoutIntentId;
  readonly evidenceStatus: PayoutEvidenceStatus;
  readonly evidenceHash: Sha256Hex;
  readonly reconciledAt: UtcInstant;
}

/** The owner's compensation-guard review per seller and period (D10-GUARD-1): a business planning guard, never a refusal. */
export interface CompensationGuardReviewRecord {
  readonly reviewId: GuardReviewId;
  readonly periodId: CommissionPeriodId;
  readonly sellerId: SellerId;
  readonly retainerCents: bigint;
  readonly commissionAccruedCents: bigint;
  readonly attributableNetServiceCents: bigint;
  /** The ratio in basis points rounded half up for display; null when there is no attributable service. */
  readonly ratioBps: bigint | null;
  readonly result: GuardResult;
  readonly recordedAt: UtcInstant;
}
