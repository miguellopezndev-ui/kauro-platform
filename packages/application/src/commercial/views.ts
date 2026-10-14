/**
 * Safe DTO views of the commercial commands and of the commission statement read (design §13; D10-API-1) — the TypeScript shapes of
 * the closed schemas of commercial/response-schemas. Money is a MoneyMinorUnits decimal string, never a float. No view carries a
 * prospect's contact details (a reference to the restricted contact record is stored, never answered), a payout destination's
 * digest, a bank account, another seller's rows, an agency's CRM data or a guard finding: the statement a seller reads is the
 * seller's own, and the owner's answers are counts and identities, never a list of sellers.
 */
import type { MoneyMinorUnits, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { DraftState, IntentState, OutreachPurpose, SenderRoute, SenderState, ServiceMode } from "@kauro/domain";
import type { AgencyView } from "../api/views.js";
import type { QuoteView } from "../commerce/views.js";
import type {
  AdjustmentDirection,
  CalendarSourceKind,
  ClaimState,
  CommissionPeriodState,
  CommissionSequence,
  FoundingOfferOutcome,
  NewWorkCompensation,
  PayoutIntentState,
  ProspectState,
  SellerClassification,
  SellerState,
  StatementBalanceKind,
  StatementState,
} from "./vocabulary.js";

/** A calendar date (YYYY-MM-DD) in the jurisdiction's calendar, as a payment due date is stated. */
export type CalendarDate = string;

// --- CMD002 ActivateAgency ---------------------------------------------------------------------------------------------------------

export interface AgencyActivationView {
  readonly agency: AgencyView;
  readonly acceptedAt: UtcInstant;
  /** The service modes the activated agency may be sold (design §3.1: the offer follows the activation). */
  readonly offeredModes: ReadonlyArray<ServiceMode>;
}

// --- CMD027 CreateQuote ----------------------------------------------------------------------------------------------------------------

/** How the quote's discount was decided: the repeat lookback and the founding offer (design §3.2, §3.3; 16 "the highest eligible rate, never a sum"). */
export interface QuoteEligibilityView {
  readonly qualifyingProjectCount: number;
  readonly repeatDiscountBps: number;
  readonly foundingOffer: FoundingOfferOutcome;
  readonly appliedDiscountBps: number;
  readonly lookbackStartsAt: UtcInstant;
}

/** A replaced quote and the authorization its replacement revoked, when a new quote supersedes a paid one (design §3.4). */
export interface QuoteReplacementView {
  readonly replacedQuoteId: string;
  /** The entitlement the re-binding revoked (SOURCE_REPLACED); absent when the payment service refused the re-binding. */
  readonly revokedAuthorizationId?: string;
  readonly approvalRequired: boolean;
  /** REBOUND: the purchase now stands on the replacement; WITHDRAWN: the payment service refused the re-binding (D10-QUOTE-6). */
  readonly outcome: "REBOUND" | "WITHDRAWN";
  /** The first blocker that refused the re-binding, as the payment service names it. */
  readonly reason?: string;
}

export interface CreateQuoteView {
  readonly quote: QuoteView;
  readonly eligibility: QuoteEligibilityView;
  readonly supersededQuoteId?: string;
  readonly replacement?: QuoteReplacementView;
}

// --- CMD043 CloseAgency ------------------------------------------------------------------------------------------------------------------

/** What closing the agency left open, as counts only: the owner sees how much remains, never another party's records (design §3.5). */
export interface AgencyClosureObligationsView {
  readonly openQuotesWithdrawn: number;
  readonly liveAuthorizations: number;
  readonly openRefunds: number;
  readonly nonTerminalTaxDocuments: number;
  readonly openReconciliationCases: number;
  readonly activeWorkItems: number;
  readonly openReconciliationCents: MoneyMinorUnits;
}

export interface AgencyClosureView {
  readonly agency: AgencyView;
  readonly closureId: string;
  readonly requestedAt: UtcInstant;
  readonly obligations: AgencyClosureObligationsView;
  readonly deletionScheduledFor?: UtcInstant;
}

// --- CMD045 RegisterProspect, CMD046 ClaimProspect, CMD047 AcceptAttribution -------------------------------------------------

/** A prospect. The restricted contact record it refers to is deliberately not a member (D10-API-1). */
export interface ProspectView {
  readonly prospectId: string;
  readonly organizationLabel: string;
  readonly sourceEvidenceHash: Sha256Hex;
  readonly jurisdiction: string;
  readonly state: ProspectState;
  readonly suppressed: boolean;
  readonly ownerSellerId?: string;
}

export interface AttributionClaimView {
  readonly claimId: string;
  readonly prospectId: string;
  readonly sellerId: string;
  readonly acceptedAt?: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly state: ClaimState;
  readonly agreementVersion: string;
  readonly version: number;
}

/** The owner's acceptance: the accepted claim, the allocation it created and how many claims lost or were beneficiaries (counts, never the other claims). */
export interface AttributionView {
  readonly claim: AttributionClaimView;
  readonly allocationId: string;
  readonly agencyId: string;
  readonly decisionReason: string;
  readonly beneficiaryCount: number;
  readonly rejectedClaimCount: number;
}

// --- CMD048 AssignAccount, CMD049 ActivateSeller, CMD050 TerminateSeller ----------------------------------------------------------

export interface SalesAccountView {
  readonly agencyId: string;
  readonly version: number;
  readonly sellerId: string;
  readonly assignedAt: UtcInstant;
  readonly newWorkCompensation: NewWorkCompensation;
  readonly assistanceAgreementId?: string;
}

export interface SellerView {
  readonly sellerId: string;
  readonly version: number;
  readonly state: SellerState;
  readonly agreementId: string;
  readonly classification: SellerClassification;
  readonly activatedAt?: UtcInstant;
  /** Whether a payout destination is verified; never the destination or its digest. */
  readonly payoutDestinationVerified: boolean;
}

export interface SellerTerminationView {
  readonly sellerId: string;
  readonly version: number;
  readonly state: SellerState;
  readonly effectiveAt: UtcInstant;
  readonly tailEndsAt: UtcInstant;
  readonly tailEntries: number;
  readonly entitlementsResidual: number;
  readonly claimsExpired: number;
  readonly prospectsUnassigned: number;
  readonly assignmentsEnded: number;
}

// --- CMD051 CloseCommissionPeriod -------------------------------------------------------------------------------------------------

export interface CommissionPeriodView {
  readonly periodId: string;
  readonly version: number;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  readonly state: CommissionPeriodState;
  readonly closeDueOn: CalendarDate;
  readonly payDueOn: CalendarDate;
  readonly calendarVersion: string;
  readonly calendarSource: CalendarSourceKind;
  /** True when the calendar was the controlled test fixture: the period's dates are then a simulation, never a promise (D10-CAL-1). */
  readonly simulated: boolean;
}

/** The close's totals. Per-seller rows are not a member: a seller reads only their own statement. */
export interface PeriodCloseView {
  readonly period: CommissionPeriodView;
  readonly ledgerCutoffHash: Sha256Hex;
  readonly statementCount: number;
  readonly payableTotalCents: MoneyMinorUnits;
  readonly heldTotalCents: MoneyMinorUnits;
  readonly guardReviewCount: number;
}

// --- GetCommissionStatement ---------------------------------------------------------------------------------------------------------

export interface StatementItemView {
  readonly lineId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly sequence: CommissionSequence;
  readonly netServiceBasisCents: MoneyMinorUnits;
  readonly rateBps: number;
  readonly shareBps: number;
  readonly cumulativeEntitlementCents: MoneyMinorUnits;
  readonly previouslyPaidCents: MoneyMinorUnits;
  readonly adjustmentCents: MoneyMinorUnits;
  readonly adjustmentDirection?: AdjustmentDirection;
  readonly heldCents: MoneyMinorUnits;
  readonly holdReason?: string;
  readonly holdReviewOn?: CalendarDate;
  readonly payableCents: MoneyMinorUnits;
}

/** An unrecovered balance carried by the statement and what it waits on. */
export interface StatementBalanceItemView {
  readonly kind: StatementBalanceKind;
  readonly lineId: string;
  readonly amountCents: MoneyMinorUnits;
}

export interface CommissionStatementView {
  readonly statementId: string;
  readonly sellerId: string;
  readonly periodStart: UtcInstant;
  readonly periodEnd: UtcInstant;
  readonly lineIds: ReadonlyArray<string>;
  readonly payableCents: MoneyMinorUnits;
  readonly heldCents: MoneyMinorUnits;
  readonly state: StatementState;
  readonly payoutEvidenceHash?: Sha256Hex;
  readonly version: number;
  readonly periodId: string;
  readonly items: ReadonlyArray<StatementItemView>;
  readonly balanceItems: ReadonlyArray<StatementBalanceItemView>;
  readonly calendarVersion: string;
  readonly payDueOn: CalendarDate;
  readonly simulated: boolean;
  readonly issuedAt: UtcInstant;
}

// --- CMD052 ApproveCommissionPayout, CMD053 ReconcileCommissionPayout ---------------------------------------------------------

/** The payout the owner authorized: the statement's own amount, one reference, no destination and no destination digest (D10-PAY-1). */
export interface PayoutIntentView {
  readonly intentId: string;
  readonly statementId: string;
  readonly state: PayoutIntentState;
  readonly amountCents: MoneyMinorUnits;
  readonly currency: "USD";
  readonly feeBearer: "KAURO";
  readonly reference: string;
  readonly destinationVersion: number;
  readonly authorizedAt: UtcInstant;
  readonly version: number;
  readonly statementState: StatementState;
}

export interface PayoutReconciliationView {
  readonly intentId: string;
  readonly statementId: string;
  readonly intentState: PayoutIntentState;
  readonly statementState: StatementState;
  readonly payoutEvidenceHash?: Sha256Hex;
  readonly settledAt?: UtcInstant;
  readonly linesPaid: number;
  readonly linesHeld: number;
  readonly reviewOn?: CalendarDate;
  readonly version: number;
}

// --- CMD051 correcting statement (no route: D10-GAP-7) --------------------------------------------------------------------------------

/** A correction: the predecessor now CORRECTED (its new version) and the correcting statement that supersedes it. */
export interface StatementCorrectionView {
  readonly correctedStatementId: string;
  readonly correctedVersion: number;
  readonly statement: CommissionStatementView;
}

// --- CMD056 RecordIncident, CMD057 AuthorizeRecovery (package B16) ---------------------------------------------------------------

/** CMD056: the incident as recorded. A false positive is CLOSED with no responsibility and its severity says so; an actual one is DETECTED. */
export interface IncidentView {
  readonly incidentId: string;
  readonly severity: "S1" | "S2" | "S3" | "S4" | "FALSE_POSITIVE";
  readonly state: "DETECTED" | "CLOSED";
  readonly affectedScopeRefs: ReadonlyArray<string>;
  readonly communicationState: "NOT_REQUIRED" | "REVIEW_REQUIRED";
  /** The responsibilities opened and still to be evidenced (CONTAINMENT, RECOVERY and, for S1 and S2, COMMUNICATION). */
  readonly openResponsibilities: ReadonlyArray<"CONTAINMENT" | "RECOVERY" | "COMMUNICATION">;
  readonly startedAt: UtcInstant;
  /** The next accountable checkpoint (the database's instant plus the severity's hours). */
  readonly reviewAt: UtcInstant;
}

/** CMD057: the recovery authorized for a restore candidate. The restore itself is run and released by the control plane after its checks. */
export interface RecoveryAuthorizationView {
  readonly recoveryId: string;
  readonly restoreCandidateRef: string;
  readonly state: "AUTHORIZED";
  readonly authorizedAt: UtcInstant;
  readonly version: number;
}

// --- CMD058 ChangeCapability, CMD059 RestrictCapability (package B18) ------------------------------------------------------------

/** The capability states a view names (registry Capability machine). */
export type CapabilityStateName = "DESIGN" | "IMPLEMENTED_UNACCEPTED" | "QUALIFIED_INTERNAL" | "AVAILABLE_LIMITED" | "AVAILABLE" | "SUSPENDED";

/** CMD058: the PROSPECTIVE version recorded, the capability version (revision) it reached and the capability state, which the command never moves. */
export interface CapabilityVersionView {
  readonly capabilityId: string;
  readonly version: number;
  readonly status: "PROSPECTIVE";
  readonly state: CapabilityStateName;
  readonly profileHash: Sha256Hex;
  readonly qualificationEvidenceCount: number;
  readonly createdAt: UtcInstant;
}

/** CMD059: the capability SUSPENDED, the state it left, the restriction evidence and that admission of new work is closed. */
export interface CapabilityRestrictionView {
  readonly capabilityId: string;
  readonly version: number;
  readonly state: "SUSPENDED";
  readonly priorState: CapabilityStateName;
  readonly restrictionId: string;
  readonly incidentRef: string;
  readonly restrictedAt: UtcInstant;
  readonly newAdmissionBlocked: true;
}

// --- package B12 (outreach; K2): the TypeScript shapes of B12_VIEW_DEFINITIONS in commercial/response-schemas --------------------------
// No view carries a recipient address, a subject, a body, a preview or a token (plan A17).

export type SalesActivityKind = "REPLIED" | "BOUNCED" | "SUPPRESSED" | "HUMAN_SEND_OBSERVED" | "PROVIDER_ACCEPTED" | "SEND_UNCERTAIN";

export interface OutreachDraftView {
  readonly draftId: string;
  readonly prospectId: string;
  readonly senderIdentityRef: string;
  readonly purpose: OutreachPurpose;
  readonly contentHash: Sha256Hex;
  readonly contentRef: Sha256Hex;
  readonly provenanceEvidenceHash: Sha256Hex;
  readonly version: number;
  readonly state: DraftState;
  readonly createdAt: UtcInstant;
}

export interface OutreachAuthorizationView {
  readonly authorizationId: string;
  readonly grantingActorId: string;
  readonly senderIdentityRef: string;
  readonly allowedContentHashes: ReadonlyArray<Sha256Hex>;
  readonly validFrom: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly maximumSends: number;
  readonly permissionEvidenceHash: Sha256Hex;
  readonly policyVersion: string;
  readonly revoked: boolean;
}

export interface OutreachSendView {
  readonly draftId: string;
  readonly draftState: DraftState;
  readonly intentId: string;
  readonly intentState: IntentState;
  readonly authorizationId: string;
  readonly payloadHash: Sha256Hex;
  readonly queuedAt: UtcInstant;
}

export interface SalesActivityView {
  readonly activityId: string;
  readonly prospectId: string;
  readonly draftId?: string;
  readonly authorizationId?: string;
  readonly kind: SalesActivityKind;
  readonly occurredAt: UtcInstant;
  readonly evidenceHash: Sha256Hex;
  readonly providerMessageRef: string;
  readonly recordedAt: UtcInstant;
}

export interface SalesActivityListView {
  readonly items: ReadonlyArray<SalesActivityView>;
}

export interface OutreachContentView {
  readonly contentRef: Sha256Hex;
  readonly createdAt: UtcInstant;
}

export interface SalesResourceView {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: "CURRENT" | "SUPERSEDED";
  /** The CURRENT resource of the family (the resource itself while it is CURRENT): a retired copy names its replacement (R2-135). */
  readonly currentResourceId: string;
  readonly contentRef: Sha256Hex;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly createdAt: UtcInstant;
}

export interface SenderIdentityView {
  readonly senderId: string;
  readonly userId: string;
  readonly route: SenderRoute;
  readonly state: SenderState;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface OutreachReviewItemView {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly contentHash: Sha256Hex;
  readonly contactLabel: string;
}

export interface OutreachReviewView {
  readonly reviewId: string;
  readonly senderIdentityRef: string;
  readonly digest: Sha256Hex;
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
  readonly items: ReadonlyArray<OutreachReviewItemView>;
}

export interface OutreachChannelPolicyView {
  readonly jurisdiction: string;
  readonly purpose: OutreachPurpose;
  readonly version: number;
  readonly state: "IN_FORCE" | "WITHDRAWN";
}

export interface OutreachDiagnosisView {
  readonly diagnosisId: string;
  readonly personUserId: string;
  readonly recordedAt: UtcInstant;
}

export interface OutreachMetricsView {
  readonly accepted: number;
  readonly uncertain: number;
  readonly observedSent: number;
  readonly bounced: number;
  readonly replied: number;
  readonly acceptedLessKnownBounces: number;
  readonly pauseNumerator: number;
  readonly pauseDenominator: number;
}

export interface ProspectSourceView {
  readonly evidenceId: string;
  readonly evidenceHash: Sha256Hex;
  readonly observedOn: CalendarDate;
  readonly segment: "AGENCY" | "COMPANY";
  readonly createdAt: UtcInstant;
}

export interface ProspectContactView {
  readonly contactId: string;
  readonly channel: string;
  readonly createdAt: UtcInstant;
}
