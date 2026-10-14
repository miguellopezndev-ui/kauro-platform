/**
 * Commercial records as the domain sees them (package B10; docs/design/B10-commercial-domain.md §3–§7; migrations 0028–0031): the
 * registry contracts Agency (its first designation), PriceEligibilitySnapshot (B09's record, extended by B10's founding facts),
 * SellerAgreement, Prospect, AttributionClaim, CommissionEntitlement, CommissionLine, CommissionAdjustment and CommissionStatement,
 * plus the platform records the design adds: qualifying purchases and the recurrence row, founding slots and reservations, quote
 * issuances, agreement acceptances, closures, relationship decisions, sellers and their legal reviews, assessments, confidentiality
 * acceptances and tax documents, payout destinations, prospect evidence, contacts and suppressions, claim evidence, allocations and
 * shares, sales accounts and the assignment chain, assistance agreements, terminations and tail entries, completions, pools, holds,
 * funds observations, offsets, banking calendar versions, periods, statement items, payout intents and reconciliations, and
 * compensation-guard reviews.
 *
 * Each record is what its table of 0028–0031 holds (D10-STAGE-2): its token sets are COMMERCIAL_VOCABULARY's (vocabulary.ts), which the
 * database's CHECKs equal, and a column the database may leave empty is optional here. Amounts are `bigint` minor units inside the
 * domain (B09 commerce/money, D-MONEY-B1); instants are canonical UTC instants of the database clock (D10-CLOCK-1); durations are exact
 * hours; calendar months are America/Bogota's (commercial/calendar.ts); calendar dates are YYYY-MM-DD. Every B10 record keys on
 * `agency_id` where it is about an agency, so a display-name change touches none (R2-141, D10-AGY-3).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  CaptureId,
  CommercialAuthorizationId,
  EligibilitySnapshotId,
  PaymentOrderId,
  QuoteId,
  QuoteRecord,
  PriceEligibilitySnapshotRecord,
} from "../commerce/records.js";
import type { AgencyId, AssuranceProofId, Branded, EventId, JournalEntryId, MembershipId, ProjectId, UserId } from "../model/ids.js";
import { COMMERCIAL_VOCABULARY as V } from "./vocabulary.js";

// --- ids ----------------------------------------------------------------------------------------------------------------------

/**
 * A qualifying purchase is its original CommercialAuthorization (D10-FIRST-1): qualifying_purchases, purchase_completions, the pools
 * and the lines key a purchase by `authorization_id` (the designation trigger cannot mint a UUIDv7), so its id is that authorization's.
 */
export type QualifyingPurchaseId = CommercialAuthorizationId;
export type FoundingReservationId = Branded<string, "FoundingReservationId">;
export type AgreementAcceptanceId = Branded<string, "AgreementAcceptanceId">;
export type AgencyClosureId = Branded<string, "AgencyClosureId">;
export type RelationshipDecisionId = Branded<string, "RelationshipDecisionId">;
export type SellerId = Branded<string, "SellerId">;
export type SellerAgreementId = Branded<string, "SellerAgreementId">;
export type SellerLegalReviewId = Branded<string, "SellerLegalReviewId">;
export type SellerAssessmentId = Branded<string, "SellerAssessmentId">;
export type SellerConfidentialityAcceptanceId = Branded<string, "SellerConfidentialityAcceptanceId">;
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
export type SellerTerminationId = Branded<string, "SellerTerminationId">;
/** Prepared termination terms (CMD050 terminationTermsRef): the prepared seller_terminations row the termination completes. */
export type TerminationTermsRef = SellerTerminationId;
/** The reviewed list of the seller's active opportunities (CMD050 activeOpportunityManifestRef). */
export type TerminationManifestRef = Branded<string, "TerminationManifestRef">;
export type PurchaseCompletionId = Branded<string, "PurchaseCompletionId">;
export type CommissionPoolId = Branded<string, "CommissionPoolId">;
export type CommissionLineId = Branded<string, "CommissionLineId">;
export type CommissionAdjustmentId = Branded<string, "CommissionAdjustmentId">;
export type CommissionHoldId = Branded<string, "CommissionHoldId">;
export type FundsObservationId = Branded<string, "FundsObservationId">;
export type CommissionOffsetId = Branded<string, "CommissionOffsetId">;
/** A recorded banking calendar version (banking_calendars.calendar_id); its label is `calendarVersion`. */
export type BankingCalendarVersionId = Branded<string, "BankingCalendarVersionId">;
export type CommissionPeriodId = Branded<string, "CommissionPeriodId">;
export type CommissionStatementId = Branded<string, "CommissionStatementId">;
export type StatementItemId = Branded<string, "StatementItemId">;
export type PayoutIntentId = Branded<string, "PayoutIntentId">;
export type PayoutReconciliationId = Branded<string, "PayoutReconciliationId">;
export type GuardReviewId = Branded<string, "GuardReviewId">;
/** An owner-prepared allocation awaiting acceptance (CMD047 shareAllocationRef). */
export type ShareAllocationRef = AttributionAllocationId;

// --- vocabularies (COMMERCIAL_VOCABULARY) -----------------------------------------------------------------------------------------

type Token<K extends keyof typeof V> = (typeof V)[K][number];

/** The agency's recorded buyer type (A3 3.7; B11 W6 stores `agency` / `in-house`, the BuyerTypeReader maps). */
export type BuyerType = Token<"buyerTypes">;
/** How a qualifying purchase's founding rate is backed: no founding rate, a consumed slot, or a fixture's unbacked rate (D10-REC-3). */
export type FoundingBasis = Token<"foundingBases">;
/** The founding outcome a quote's eligibility view states (§3.4 CreateQuoteView.eligibility.foundingOffer). */
export type FoundingOffer = Token<"foundingOffers">;
export type FoundingReservationState = Token<"foundingReservationStates">;
/** How a reservation was released: 'QUOTE_' and the state its quote ended in (KC014). */
export type ReservationReleaseReason = Token<"reservationReleaseReasons">;
/** What kauro.eligibility_findings() reports (D10-REC-3; Q10-1, Q10-7). */
export type EligibilityFindingKind = Token<"eligibilityFindings">;
/** A published agreement document an agency accepts at activation (CMD002 termsVersion, privacyAgreementVersion). */
export type ServiceAgreementKind = Token<"serviceAgreementKinds">;
export type ServiceAgreementState = Token<"serviceAgreementStates">;
/** The agency states CMD043 moves to CLOSING. */
export type ClosureFromState = Token<"closureFromStates">;
/**
 * A reviewed relationship decision between two agencies (R2-141; example 24): separate tenants confirmed (related agencies kept
 * apart), common control recorded (an approved commercial consolidation), a legal successor recorded (the canonical relationship of
 * confirmed duplicate or succeeding accounts). Each is a recorded decision with no data effect (D10-AGY-3; Q10-3).
 */
export type RelationshipTreatment = Token<"relationshipTreatments">;
export type SellerState = Token<"sellerStates">;
/** registry SellerAgreement.classification: the actual reviewed relationship. */
export type SellerClassification = Token<"sellerClassifications">;
/** Whether a negative balance may be offset against future eligible amounts (D10-NEG-1; KC017). */
export type OffsetTerms = Token<"offsetTerms">;
export type LegalReviewOutcome = Token<"legalReviewOutcomes">;
export type AssessmentOutcome = Token<"assessmentOutcomes">;
export type DestinationCurrency = Token<"destinationCurrencies">;
export type PayoutDestinationState = Token<"payoutDestinationStates">;
export type ProspectState = Token<"prospectStates">;
/** The segment of a prospect's source evidence: an agency or a company (D-33); the evidence table admits no other value (migration 0063). */
export type ProspectSegment = Token<"prospectSegments">;
export type SuppressionKeyKind = Token<"suppressionKeyKinds">;
export type AttributionClaimState = Token<"attributionClaimStates">;
/** Substantive acquisition activity; a list import or a tracking link alone is not a claim (17 "Attribution subject"). */
export type ClaimActivityKind = Token<"claimActivityKinds">;
export type CommissionEntitlementState = Token<"entitlementStates">;
/** A pool's and an entitlement's source: the agency's frozen acquisition allocation, or a prospective assistance agreement (D10-ASSIST-1). */
export type CommissionSource = Token<"commissionSources">;
/** What a prepared service assignment compensates for new work (R2-095; D10-ASSIGN-1). */
export type ServiceCompensation = Token<"serviceCompensations">;
/** Why a link of an agency's assignment chain exists (D10-ASSIGN-2). */
export type AssignmentReason = Token<"assignmentReasons">;
/** An assistance agreement covers one named project or the agency's next purchase (§5 Assistance). */
export type AssistanceScope = Token<"assistanceScopes">;
export type CompletionKind = Token<"completionKinds">;
/** Which binding reported a completion (PreparationCompletionSource; D10-BIND-1). */
export type CompletionSource = Token<"completionSources">;
/** A pool's rate: FIRST for sequence 1, REPEAT inside the window, ASSISTANCE for an assistance agreement's pool. */
export type CommissionRateKind = Token<"rateKinds">;
export type CommissionLineState = Token<"lineStates">;
export type AdjustmentReason = Token<"adjustmentReasons">;
export type AdjustmentDirection = Token<"adjustmentDirections">;
export type CommissionHoldState = Token<"holdStates">;
/** Why cents are held (D10-HOLD-1; 8.1). */
export const HOLD_REASONS = V.holdReasons;
export type HoldReason = (typeof HOLD_REASONS)[number];
/** What a funds observation can say of a capture (capture.funds_observed.v1). */
export type ObservedFundsState = Token<"observedFundsStates">;
export type CalendarJurisdiction = Token<"calendarJurisdictions">;
/** The banking calendar's origin: a verified feed (B15) or the labelled test fixture, which makes a close SIMULATED (D10-CAL-1). */
export type CalendarSource = Token<"calendarSources">;
export type CommissionPeriodState = Token<"periodStates">;
/** VERIFIED_CALENDAR, or SIMULATED when the statement's calendar is the TEST_FIXTURE (D10-CAL-1). */
export type StatementLabel = Token<"statementLabels">;
export type CommissionStatementState = Token<"statementStates">;
/** What a statement item reports (D10-STMT-2). */
export type StatementItemKind = Token<"statementItemKinds">;
export type StatementItemDisposition = Token<"statementItemDispositions">;
/** The owner's resolution of a negative balance without signed offset terms (D10-NEG-1; example 7). */
export type RecoveryAction = Token<"recoveryActions">;
export type PayoutIntentState = Token<"payoutIntentStates">;
/** What authenticated payout evidence reports (PayoutEvidenceVerifier; "Submitting a transfer is not proof"). */
export type PayoutEvidenceStatus = Token<"payoutEvidenceStatuses">;
export type PayoutCurrency = Token<"payoutCurrencies">;
/** Who bears the transfer fee of a payout (policy commission.feeBearer, brand-mapped by amendment A2): the company, never the seller. */
export type PayoutFeeBearer = Token<"payoutFeeBearers">;
export type GuardResult = Token<"guardResults">;
export type GuardLabel = Token<"guardLabels">;

// --- recurrence and the founding cohort (§3; migration 0028) -----------------------------------------------------------------

/**
 * One original CommercialAuthorization whose capture alone paid the whole obligation (D10-FIRST-1; R2-140): the designation
 * trigger records it in the payment service's reconciler transaction. Nothing rewrites a row (KC001).
 */
export interface QualifyingPurchaseRecord {
  /** The original authorization's id (qualifying_purchases.authorization_id). */
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  readonly orderId: PaymentOrderId;
  readonly captureId: CaptureId;
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
  /** The last confirmation sequence assigned (agency_recurrence.confirmation_count); the next qualifying purchase takes the following one. */
  readonly lastConfirmationSeq: number;
  readonly firstPurchaseId: QualifyingPurchaseId;
  readonly firstCaptureId: CaptureId;
  readonly firstProjectId: ProjectId;
  readonly firstConfirmedAt: UtcInstant;
  readonly lastConfirmedAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

/** One slot of a price policy's founding cohort (R2-INITIAL: slots 1..3 = pricing.foundingAgencyCount; D10-FOUND-1). */
export interface FoundingSlotRecord {
  readonly policyVersion: string;
  readonly slotNo: number;
  readonly held: boolean;
  /** The live reservation, where the reading session may see it; the holding agency is never readable here (D10-FOUND-5). */
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
  readonly heldAt?: UtcInstant;
  readonly consumedAt?: UtcInstant;
  readonly consumedByAuthorizationId?: CommercialAuthorizationId;
  readonly releasedAt?: UtcInstant;
  readonly releaseReason?: ReservationReleaseReason;
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
  readonly projectId: ProjectId;
  readonly quoteId: QuoteId;
  /** The issued quote's snapshot (read with the quote; quote_issuances does not repeat it). */
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
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
  readonly finding: EligibilityFindingKind;
  /** The project a set finding is about; absent for UNBACKED_FOUNDING_RATE. */
  readonly projectId?: ProjectId;
}

// --- agency lifecycle (§4; migration 0028) -------------------------------------------------------------------------------------

/** A published service agreement document (service_agreement_versions): the only versions CMD002 accepts (D10-AGY-1). */
export interface ServiceAgreementVersionRecord {
  readonly kind: ServiceAgreementKind;
  readonly version: string;
  readonly documentHash: Sha256Hex;
  readonly state: ServiceAgreementState;
  readonly publishedAt: UtcInstant;
  readonly retiredAt?: UtcInstant;
}

/** An append-only acceptance at activation (agency_agreement_acceptances): no default, no implicit signature. */
export interface AgreementAcceptanceRecord {
  readonly acceptanceId: AgreementAcceptanceId;
  readonly agencyId: AgencyId;
  readonly membershipId: MembershipId;
  readonly userId: UserId;
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
  /** The case's detail code (an UNKNOWN_REFUND is a PROVIDER_INCONSISTENCY whose detail names it; migration 0019). */
  readonly detailCode?: string;
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
  readonly requestedByUserId: UserId;
  readonly assuranceProofId: AssuranceProofId;
  /** The state the agency left for CLOSING. */
  readonly fromState: ClosureFromState;
  readonly obligations: ClosureObligations;
  /** The digest of the stored obligations object (agency_closures.obligations_hash). */
  readonly obligationsHash: Sha256Hex;
  readonly withdrawnQuoteIds: ReadonlyArray<QuoteId>;
  readonly deletionScheduledAt: UtcInstant;
  readonly requestedAt: UtcInstant;
}

/** A reviewed relationship decision between two agencies: recorded evidence, no merged data, no changed eligibility (R2-141). */
export interface RelationshipDecisionRecord {
  readonly decisionId: RelationshipDecisionId;
  readonly agencyId: AgencyId;
  readonly relatedAgencyId: AgencyId;
  readonly treatment: RelationshipTreatment;
  readonly evidenceHash: Sha256Hex;
  readonly reviewedBy: UserId;
  readonly effectiveAt: UtcInstant;
  readonly decidedAt: UtcInstant;
}

// --- sellers (§5; migration 0029) -------------------------------------------------------------------------------------------------

/** A seller (machine Seller) bound to one individually managed corporate identity (D10-CTX-2). */
export interface SellerRecord {
  readonly sellerId: SellerId;
  readonly userId: UserId;
  readonly displayLabel: string;
  readonly state: SellerState;
  readonly version: number;
  /** The agreement the seller was activated on (its compensation version). */
  readonly activeAgreementId?: SellerAgreementId;
  readonly activationAssessmentId?: SellerAssessmentId;
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
  readonly legalReviewId: SellerLegalReviewId;
  readonly startsAt: UtcInstant;
  readonly endsAt?: UtcInstant;
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly recurringMonths: number;
  readonly signedTermsHash: Sha256Hex;
  readonly signedAt?: UtcInstant;
  readonly signatureEvidenceHash?: Sha256Hex;
  readonly offsetTerms: OffsetTerms;
  readonly retainerCentsPerMonth: bigint;
  readonly compensationPolicyVersion: string;
  readonly version: number;
}

/** The substance-based review of a seller's classification (17 "Activation prerequisites"; D10-SELL-3): a label alone never activates. */
export interface SellerLegalReviewRecord {
  readonly reviewId: SellerLegalReviewId;
  readonly sellerId: SellerId;
  readonly classification: SellerClassification;
  readonly outcome: LegalReviewOutcome;
  /** The digest of the reviewed substance of the relationship. */
  readonly substanceHash: Sha256Hex;
  readonly reviewerLabel: string;
  readonly evidenceHash: Sha256Hex;
  readonly reviewedAt: UtcInstant;
}

/** The English and product assessment of a seller (CMD049 assessmentEvidenceRef; D10-SELL-3). */
export interface SellerAssessmentRecord {
  readonly assessmentId: SellerAssessmentId;
  readonly sellerId: SellerId;
  readonly outcome: AssessmentOutcome;
  readonly evidenceHash: Sha256Hex;
  readonly assessedAt: UtcInstant;
}

/** The seller's acceptance of the confidentiality terms (D10-SELL-3). */
export interface SellerConfidentialityAcceptanceRecord {
  readonly acceptanceId: SellerConfidentialityAcceptanceId;
  readonly sellerId: SellerId;
  readonly termsHash: Sha256Hex;
  readonly evidenceHash: Sha256Hex;
  readonly acceptedAt: UtcInstant;
}

/** The seller's verified tax documentation for a jurisdiction (D10-SELL-3; Q10-9). */
export interface SellerTaxDocumentationRecord {
  readonly documentationId: SellerTaxDocumentationId;
  readonly sellerId: SellerId;
  readonly jurisdiction: string;
  readonly requirementsHash: Sha256Hex;
  readonly evidenceHash: Sha256Hex;
  readonly verifiedAt: UtcInstant;
  readonly verifiedBy: UserId;
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
  readonly currency: DestinationCurrency;
  readonly state: PayoutDestinationState;
  readonly version: number;
  readonly changeProofId?: AssuranceProofId;
  readonly changedAt: UtcInstant;
  readonly verifiedAt?: UtcInstant;
  readonly verifiedBy?: UserId;
}

/** The facts CMD049 requires and the database repeats (KC005; D10-SELL-1, D10-SELL-3), read after the seller's transition lock. */
export interface SellerActivationFacts {
  readonly agreement: SellerAgreementRecord | null;
  readonly legalReview: SellerLegalReviewRecord | null;
  readonly assessment: SellerAssessmentRecord | null;
  readonly confidentialityAcceptance: SellerConfidentialityAcceptanceRecord | null;
  readonly taxDocumentation: SellerTaxDocumentationRecord | null;
  readonly verifiedDestination: PayoutDestinationRecord | null;
  /** The seller's identity is ACTIVE with a verified e-mail and a multi-factor method enrolled. */
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
  readonly keyKind: SuppressionKeyKind;
  /** The organization key or the contact key it suppresses. */
  readonly key: Sha256Hex;
  readonly reasonCode: string;
  readonly evidenceHash?: Sha256Hex;
  readonly recordedAt: UtcInstant;
}

/** Substantive acquisition evidence of a claim (registry AttributionClaim.evidenceHash; D10-CLAIM-1). */
export interface ClaimEvidenceRecord {
  readonly evidenceHash: Sha256Hex;
  readonly sellerId: SellerId;
  readonly prospectId: ProspectId;
  readonly sourceChannel: string;
  readonly firstMeaningfulContactAt: UtcInstant;
  /** The digest of the qualified need the seller recorded. */
  readonly qualifiedNeedHash: Sha256Hex;
  readonly activityKinds: ReadonlyArray<ClaimActivityKind>;
  readonly recordedAt: UtcInstant;
}

/** registry AttributionClaim plus its agreement, review deadline (SUBMITTED + 2160 h), conflict reason, ruling and version. */
export interface AttributionClaimRecord {
  readonly claimId: AttributionClaimId;
  readonly prospectId: ProspectId;
  readonly sellerId: SellerId;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly evidenceHash: Sha256Hex;
  readonly state: AttributionClaimState;
  readonly version: number;
  readonly submittedAt: UtcInstant;
  readonly reviewDeadlineAt: UtcInstant;
  /** Why the claim was born DISPUTED (conflict review, D10-CLAIM-1). */
  readonly conflictReason?: string;
  /** The agency and the allocation the owner's ruling named (CMD047). */
  readonly agencyId?: AgencyId;
  readonly allocationId?: AttributionAllocationId;
  readonly acceptedAt?: UtcInstant;
  /**
   * registry AttributionClaim.expiresAt: the review deadline while SUBMITTED or DISPUTED (attribution_claims.expires_at is empty until
   * the acceptance), acceptance + 2160 h once ACCEPTED.
   */
  readonly expiresAt: UtcInstant;
}

/** One beneficiary's share of a frozen allocation; each share's pool terms equal its signed agreement (KC003). */
export interface AllocationShare {
  readonly sellerId: SellerId;
  readonly claimId: AttributionClaimId;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly shareBps: number;
}

/** The owner's acceptance of attribution for one agency (D10-ATTR-1): prepared, then frozen once; shares sum to exactly 10 000 bps. */
export interface AttributionAllocationRecord {
  readonly allocationId: AttributionAllocationId;
  readonly agencyId: AgencyId;
  readonly prospectId: ProspectId;
  /** Evidence that the prospect is this agency. */
  readonly identityEvidenceHash: Sha256Hex;
  /** The claims it rules on (the claims naming this allocation) and the reason (never timestamps alone, 17). */
  readonly ruledClaimIds: ReadonlyArray<AttributionClaimId>;
  readonly rulingReason: string;
  readonly rulingEvidenceHash: Sha256Hex;
  /** The pool terms of the allocation: the first and repeat rates and the recurring months every share's agreement carries. */
  readonly firstBps: number;
  readonly repeatBps: number;
  readonly recurringMonths: number;
  readonly shares: ReadonlyArray<AllocationShare>;
  readonly version: number;
  readonly preparedAt: UtcInstant;
  readonly frozenAt?: UtcInstant;
}

/**
 * registry CommissionEntitlement plus its source (D10-ATTR-2, D10-ASSIST-1, D10-ASSIST-2). An ACQUISITION entitlement is a share of a
 * frozen allocation with its claim, first capture and window (twelve calendar months after the first confirmation at the same
 * America/Bogota wall time); an ASSISTANCE entitlement is its agreement's one entitlement at 10 000 bps, with no first capture and no
 * window. First capture, window, share and agreement are immutable.
 */
export interface CommissionEntitlementRecord {
  readonly entitlementId: CommissionEntitlementId;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly source: CommissionSource;
  readonly allocationId?: AttributionAllocationId;
  readonly claimId?: AttributionClaimId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly firstCaptureId?: CaptureId;
  readonly windowStartsAt?: UtcInstant;
  readonly windowEndsAt?: UtcInstant;
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly shareBps: number;
  readonly state: CommissionEntitlementState;
  readonly version: number;
  readonly createdAt: UtcInstant;
}

/** One sales account per agency (versioned): it names the last link of the agency's assignment chain, never an entitlement (D10-ASSIGN-2). */
export interface SalesAccountRecord {
  readonly agencyId: AgencyId;
  readonly version: number;
  readonly currentAssignmentId: AccountAssignmentId;
  readonly createdAt: UtcInstant;
}

/** A prepared service assignment: the compensation of the new owner's new work (none, or an assistance agreement; R2-095). */
export interface ServiceAssignmentRecord {
  readonly serviceAssignmentRef: ServiceAssignmentRef;
  readonly agencyId: AgencyId;
  readonly sellerId: SellerId;
  readonly compensation: ServiceCompensation;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  readonly termsHash: Sha256Hex;
  readonly preparedAt: UtcInstant;
}

/**
 * A link of the agency's append-only assignment chain (D10-ASSIGN-2): from `effectiveAt` the operational owner is this seller under
 * this service assignment (ASSIGNED), or nobody (UNASSIGNED, SELLER_TERMINATED); each link but the first supersedes one link.
 */
export interface AccountAssignmentRecord {
  readonly assignmentId: AccountAssignmentId;
  readonly agencyId: AgencyId;
  readonly reason: AssignmentReason;
  readonly sellerId?: SellerId;
  readonly serviceAssignmentRef?: ServiceAssignmentRef;
  readonly supersedesAssignmentId?: AccountAssignmentId;
  readonly effectiveAt: UtcInstant;
}

/** A prospective assistance agreement (D10-ASSIST-1): its pool applies only to a purchase whose order was created after signing. */
export interface AssistanceAgreementRecord {
  readonly assistanceAgreementId: AssistanceAgreementId;
  readonly sellerId: SellerId;
  readonly agencyId: AgencyId;
  /** The seller agreement the assistance is signed under. */
  readonly agreementId: SellerAgreementId;
  readonly agreementVersion: string;
  readonly scope: AssistanceScope;
  readonly projectId?: ProjectId;
  /** 400 bps by default; 1000 bps for an inbound buyer's complete closing effort (A3 7.1). */
  readonly rateBps: number;
  readonly termsHash: Sha256Hex;
  readonly signedAt: UtcInstant;
}

/** The reviewed manifest of the seller's active opportunities at termination (CMD050; D10-TERM-1). */
export interface TerminationManifestRecord {
  readonly manifestRef: TerminationManifestRef;
  readonly sellerId: SellerId;
  readonly claimIds: ReadonlyArray<AttributionClaimId>;
  readonly manifestHash: Sha256Hex;
  readonly preparedAt: UtcInstant;
}

/**
 * A seller's termination (seller_terminations): the owner's prepared terms (CMD050 terminationTermsRef), completed once effective with
 * its instant, the manifest it enumerated and the owner who terminated (CAS on its version). One effective termination per seller.
 */
export interface SellerTerminationRecord {
  readonly terminationId: SellerTerminationId;
  readonly sellerId: SellerId;
  readonly termsHash: Sha256Hex;
  readonly preparedAt: UtcInstant;
  readonly manifestRef?: TerminationManifestRef;
  readonly effectiveAt?: UtcInstant;
  readonly terminatedBy?: UserId;
  readonly version: number;
}

/** A 2160-hour tail for one enumerated, accepted, unexpired claim whose agency has no qualifying purchase (KC011; R2-100). */
export interface TerminationTailEntryRecord {
  readonly terminationId: SellerTerminationId;
  readonly claimId: AttributionClaimId;
  readonly sellerId: SellerId;
  readonly agencyId: AgencyId;
  readonly effectiveAt: UtcInstant;
  /** effectiveAt + 2160 h. */
  readonly endsAt: UtcInstant;
}

// --- the commission ledger (§6; migration 0030) -------------------------------------------------------------------------------------

/** A STAGE or FINAL completion of a qualifying purchase (PreparationCompletionSource): one FINAL per purchase and one row per stage. */
export interface PurchaseCompletionRecord {
  readonly completionId: PurchaseCompletionId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly kind: CompletionKind;
  /** The stage a STAGE completion completes; absent for FINAL. */
  readonly stageRef?: string;
  readonly completedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  /** The binding that reported it (B09's delivered authorization, D10-BIND-1; a staged purchase's preparation, B13). */
  readonly source: CompletionSource;
  readonly recordedAt: UtcInstant;
}

/** The capture's funds availability as one capture version observed it (capture.funds_observed.v1, subscribed for COMMISSIONS). */
export interface CaptureFundsObservationRecord {
  readonly observationId: FundsObservationId;
  readonly agencyId: AgencyId;
  readonly captureId: CaptureId;
  /** The capture version that learned it: the latest version is the funds' current state, whatever order the events arrive in. */
  readonly captureVersion: number;
  readonly fundsState: ObservedFundsState;
  /** The provider's review date of held funds. */
  readonly reviewAt?: UtcInstant;
  readonly sourceEventId: EventId;
  readonly observedAt: UtcInstant;
}

/** One pool per (qualifying purchase, source) (D10-POOL-1): pool = round_half_up_bps(basis, rate) once (KC002). */
export interface CommissionPoolRecord {
  readonly poolId: CommissionPoolId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly agencyId: AgencyId;
  readonly captureId: CaptureId;
  readonly confirmationSeq: number;
  /** The purchase's project, so a statement names agency and project without reading the agency's purchases (D10-STMT-2). */
  readonly projectId: ProjectId;
  readonly source: CommissionSource;
  readonly rateKind: CommissionRateKind;
  readonly allocationId?: AttributionAllocationId;
  readonly assistanceAgreementId?: AssistanceAgreementId;
  /** The basis at accrual; `basisCents` only falls after it (D10-ADJ-2). */
  readonly initialBasisCents: bigint;
  readonly basisCents: bigint;
  readonly rateBps: number;
  readonly poolCents: bigint;
  readonly policyVersion: string;
  readonly version: number;
  readonly createdAt: UtcInstant;
}

/** registry CommissionLine plus its pool, beneficiary, share, paid cents and version (one per pool and beneficiary). */
export interface CommissionLineRecord {
  readonly lineId: CommissionLineId;
  readonly agencyId: AgencyId;
  readonly poolId: CommissionPoolId;
  readonly purchaseId: QualifyingPurchaseId;
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
  readonly paidAt?: UtcInstant;
  readonly state: CommissionLineState;
  readonly version: number;
  readonly eligibleAt?: UtcInstant;
  /** The FINAL completion its eligibility stands on (KC007). */
  readonly finalCompletionId?: PurchaseCompletionId;
  /** The reason and review date of the OPEN hold covering a HELD line (commission_holds; the line row carries neither). */
  readonly heldReason?: HoldReason;
  readonly reviewAt?: UtcInstant;
  /** The statement through whose PAYABLE item the line is payable (or was paid): one live payable item per line (0037; B10G-R1). */
  readonly payableStatementId?: CommissionStatementId;
  readonly policyVersion: string;
  readonly createdAt: UtcInstant;
}

/** registry CommissionAdjustment: the cumulative difference of one line for one source event, UNIQUE (line, source event) (KC015). */
export interface CommissionAdjustmentRecord {
  readonly adjustmentId: CommissionAdjustmentId;
  readonly commissionLineId: CommissionLineId;
  readonly sellerId: SellerId;
  /** The line's adjustments in order, from 1. */
  readonly adjustmentSeq: number;
  readonly reason: AdjustmentReason;
  readonly direction: AdjustmentDirection;
  /** |new cumulative - previous cumulative|; the direction carries the sign. */
  readonly amountCents: bigint;
  readonly previousCumulativeCents: bigint;
  readonly newCumulativeEntitlementCents: bigint;
  /** The pool's basis after the change. */
  readonly newBasisCents: bigint;
  readonly sourceEventId: EventId;
  readonly agreementVersion: string;
  readonly createdAt: UtcInstant;
}

/** An amount held on a line (machine CommissionHold; D10-HOLD-1): at most the line's unpaid cents, with reason and review date. */
export interface CommissionHoldRecord {
  readonly holdId: CommissionHoldId;
  readonly lineId: CommissionLineId;
  readonly sellerId: SellerId;
  readonly amountCents: bigint;
  readonly reason: HoldReason;
  readonly reviewAt: UtcInstant;
  readonly state: CommissionHoldState;
  readonly version: number;
  readonly openedAt: UtcInstant;
  readonly resolvedAt?: UtcInstant;
}

/**
 * An offset of a seller's negative position on a paid line against a later unpaid line of the same seller (D10-NEG-2; KC017): only
 * under the SIGNED_FUTURE_OFFSET terms of the agreement the negative line was earned under, within both amounts; it debits nobody.
 */
export interface CommissionOffsetRecord {
  readonly offsetId: CommissionOffsetId;
  readonly sellerId: SellerId;
  readonly negativeLineId: CommissionLineId;
  readonly againstLineId: CommissionLineId;
  readonly amountCents: bigint;
  readonly agreementId: SellerAgreementId;
  readonly recordedAt: UtcInstant;
  /** Cents of the claim released (commission_offset_releases): the live claim is amountCents - releasedCents (OFF-R1). */
  readonly releasedCents: bigint;
}

// --- periods, statements and payouts (§7; migration 0031) ------------------------------------------------------------------------

/**
 * A recorded banking calendar version (BankingCalendarSource; D10-CAL-1): jurisdiction CO, its source, the non-banking dates besides
 * weekends and the dates it covers. A day outside [coversFrom, coversTo] is unknown to it, never a banking day (kauro.banking_day_after).
 */
export interface BankingCalendarRecord {
  readonly calendarVersionId: BankingCalendarVersionId;
  /** The version's label (unique per jurisdiction). */
  readonly calendarVersion: string;
  readonly jurisdiction: CalendarJurisdiction;
  readonly source: CalendarSource;
  /** Calendar dates YYYY-MM-DD that are not banking days besides weekends. */
  readonly nonbankingDates: ReadonlyArray<string>;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly evidenceHash: Sha256Hex;
  readonly recordedAt: UtcInstant;
}

/**
 * One calendar month in America/Bogota, [start, end), opened by the PERIODS sweep; dated once with the close and pay dates of a
 * calendar version (all four together), and CLOSED by CMD051 with the ledger cutoff hash it closed on.
 */
export interface CommissionPeriodRecord {
  readonly periodId: CommissionPeriodId;
  /** YYYY-MM of the month in America/Bogota. */
  readonly month: string;
  readonly startsAt: UtcInstant;
  readonly endsAt: UtcInstant;
  readonly state: CommissionPeriodState;
  readonly version: number;
  readonly calendarVersionId?: BankingCalendarVersionId;
  readonly calendarSource?: CalendarSource;
  /** The 5th banking day after month-end (policy statementBusinessDay), a calendar date. */
  readonly closeDueOn?: string;
  /** The 10th banking day after month-end (policy payBusinessDay), a calendar date. */
  readonly payDueOn?: string;
  readonly cutoffHash?: Sha256Hex;
  readonly closedAt?: UtcInstant;
}

/**
 * registry CommissionStatement plus its period, calendar, totals and label; immutable once ISSUED (D10-STMT-1). The separate totals of
 * example 21: accrued pending, payable (the close's eligible amount), held, paid to date and the negative balance, never one sum; the
 * payable and held totals are the sums of its items (D10-STMT-2).
 */
export interface CommissionStatementRecord {
  readonly statementId: CommissionStatementId;
  readonly periodId: CommissionPeriodId;
  readonly sellerId: SellerId;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  /** The lines its LINE items name. */
  readonly lineIds: ReadonlyArray<CommissionLineId>;
  /**
   * The seller's lines of the ledger it was composed from (migration 0041, D10-GAP-16): the close's input set, carried unchanged by a
   * correcting statement, so a correction recomposes over the same lines, a debt line no item names included. Empty for a statement
   * issued before 0041.
   */
  readonly inputLineIds: ReadonlyArray<CommissionLineId>;
  readonly accruedPendingCents: bigint;
  readonly heldCents: bigint;
  readonly payableCents: bigint;
  readonly paidToDateCents: bigint;
  readonly negativeBalanceCents: bigint;
  readonly state: CommissionStatementState;
  readonly version: number;
  readonly calendarVersionId: BankingCalendarVersionId;
  readonly calendarSource: CalendarSource;
  /** SIMULATED when closed on a TEST_FIXTURE calendar: never a real statement date (D10-CAL-1). */
  readonly label: StatementLabel;
  /** The period's close date and pay date. */
  readonly statementDate: string;
  readonly payDueOn: string;
  readonly cutoffHash: Sha256Hex;
  /** A correcting statement names the one it corrects. */
  readonly correctsStatementId?: CommissionStatementId;
  readonly payoutEvidenceHash?: Sha256Hex;
  readonly issuedAt?: UtcInstant;
}

/**
 * One item of a statement (§7 CMD051; D10-STMT-2): a LINE (PAYABLE, AWAITING_FINAL_COMPLETION, AWAITING_FUNDS or HELD), an ADJUSTMENT
 * or an OFFSET it REPORTED, a partial HOLD it withholds, or a RECOVERY item of a negative balance (REPAYMENT_REVIEW, WRITE_OFF or
 * DISPUTE) — with the agency and project reference, first or repeat, basis, rate, share, cumulative, previously paid, adjustment, hold
 * with reason and review date, and payable; never a customer CRM value (example 25). Only a PAYABLE line item carries payable cents.
 */
export interface StatementItemRecord {
  readonly itemId: StatementItemId;
  readonly statementId: CommissionStatementId;
  readonly sellerId: SellerId;
  /** The item's position in the statement, from 1. */
  readonly itemNo: number;
  readonly kind: StatementItemKind;
  readonly disposition: StatementItemDisposition;
  readonly lineId?: CommissionLineId;
  readonly adjustmentId?: CommissionAdjustmentId;
  readonly holdId?: CommissionHoldId;
  readonly offsetId?: CommissionOffsetId;
  readonly agencyId?: AgencyId;
  readonly projectId?: ProjectId;
  readonly rateKind?: CommissionRateKind;
  readonly basisCents?: bigint;
  readonly rateBps?: number;
  readonly shareBps?: number;
  readonly cumulativeCents?: bigint;
  readonly previouslyPaidCents?: bigint;
  readonly adjustmentDirection?: AdjustmentDirection;
  /** |the adjustment|; the direction carries the sign. */
  readonly adjustmentCents?: bigint;
  readonly heldCents: bigint;
  readonly holdReason?: HoldReason;
  readonly holdReviewAt?: UtcInstant;
  readonly offsetCents: bigint;
  readonly payableCents: bigint;
}

/** One authorized payout of exactly a statement's payable (D10-PAY-1): it keeps its destination whatever changes later (R2-103). */
export interface PayoutIntentRecord {
  readonly intentId: PayoutIntentId;
  readonly statementId: CommissionStatementId;
  readonly sellerId: SellerId;
  readonly amountCents: bigint;
  readonly currency: PayoutCurrency;
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
  /** The evidence of its SETTLED, FAILED or RETURNED state. */
  readonly evidenceHash?: Sha256Hex;
}

/**
 * Authenticated payout evidence (PayoutEvidenceVerifier's answer; D10-PAY-2): what the bank or payout provider reported of one payout —
 * the reference, the digest of the destination it paid, the amount and currency — which CMD053 matches against the intent.
 */
export interface PayoutEvidenceFacts {
  readonly status: PayoutEvidenceStatus;
  readonly reference: string;
  readonly destinationDigest: Sha256Hex;
  readonly amountCents: bigint;
  readonly currency: string;
  /** The provider's own reference of the transfer, when it gives one. */
  readonly providerRef?: string;
  readonly observedAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
}

/** A reconciliation of an intent against matching authenticated evidence (CMD053; D10-PAY-2): failed and returned transfers stay recorded. */
export interface PayoutReconciliationRecord {
  readonly reconciliationId: PayoutReconciliationId;
  readonly intentId: PayoutIntentId;
  readonly evidence: PayoutEvidenceFacts;
  readonly reconciledAt: UtcInstant;
}

/** The owner's compensation-guard review per seller and period (D10-GUARD-1): a business planning guard, never a refusal. */
export interface CompensationGuardReviewRecord {
  readonly reviewId: GuardReviewId;
  readonly periodId: CommissionPeriodId;
  readonly sellerId: SellerId;
  readonly statementId?: CommissionStatementId;
  readonly retainerCents: bigint;
  readonly commissionAccruedCents: bigint;
  readonly attributableNetServiceCents: bigint;
  /** The threshold compared against, 1500 bps (COMPENSATION_PLANNING_GUARD_BPS). */
  readonly guardBps: number;
  /** The ratio in basis points rounded half up for display (commercial compensationGuard); null when there is no attributable service. */
  readonly ratioBps: bigint | null;
  readonly result: GuardResult;
  readonly label: GuardLabel;
  readonly recordedAt: UtcInstant;
}
