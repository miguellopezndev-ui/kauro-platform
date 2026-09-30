/**
 * The commercial vocabulary of package B10 (docs/design/B10-commercial-domain.md §3–§9): every token set a B10 record stores, spelled
 * once as runtime constants so the database, the platform machines and the views can be compared with it. The record types of
 * records.ts are derived from these lists; nothing else spells a commercial token set.
 */
export const COMMERCIAL_VOCABULARY = Object.freeze({
  buyerTypes: ["AGENCY", "IN_HOUSE"],
  foundingBases: ["NONE", "RESERVED_SLOT", "UNBACKED"],
  foundingOffers: ["RESERVED", "NOT_ELIGIBLE", "NONE_AVAILABLE"],
  foundingReservationStates: ["RESERVED", "RECONCILIATION_HOLD", "CONSUMED", "RELEASED"],
  eligibilityFindings: ["SET_DIFFERS_FROM_FUNCTION", "FOUNDING_RATE_WITHOUT_RESERVATION", "UNBACKED_FOUNDING_PURCHASE"],
  serviceAgreementKinds: ["TERMS", "PRIVACY"],
  serviceAgreementStates: ["DRAFT", "PUBLISHED", "RETIRED"],
  relationshipKinds: ["RELATED_KEPT_SEPARATE", "COMMERCIAL_CONSOLIDATION", "DUPLICATE_ACCOUNTS"],
  sellerStates: ["CANDIDATE", "ACTIVE", "SUSPENDED", "TERMINATED"],
  sellerClassifications: ["INDEPENDENT_COLLABORATION", "EMPLOYMENT", "OTHER_REVIEWED"],
  offsetTerms: ["NONE", "SIGNED_FUTURE_OFFSET"],
  legalReviewOutcomes: ["CONFIRMED", "REJECTED"],
  payoutDestinationStates: ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "SUPERSEDED"],
  prospectStates: ["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY", "WON", "LOST", "SUPPRESSED"],
  prospectSegments: ["AGENCY"],
  attributionClaimStates: ["SUBMITTED", "ACCEPTED", "DISPUTED", "REJECTED", "EXPIRED", "CONVERTED"],
  claimActivityKinds: ["FIRST_MEANINGFUL_CONTACT", "QUALIFIED_NEED", "DISCOVERY_MEETING", "PROPOSAL", "CLOSING_SUPPORT", "LIST_IMPORT", "TRACKING_LINK"],
  entitlementStates: ["ACTIVE", "EXPIRED", "DISPUTED", "TERMINATED_WITH_RESIDUAL"],
  commissionSources: ["ACQUISITION", "ASSISTANCE"],
  serviceCompensations: ["NONE", "ASSISTANCE_AGREEMENT"],
  assistanceScopes: ["PROJECT", "NEXT_PURCHASE"],
  completionKinds: ["STAGE", "FINAL"],
  lineStates: ["ACCRUED_PENDING", "ELIGIBLE", "HELD", "PAYABLE", "PAID", "ADJUSTED", "VOID"],
  adjustmentReasons: ["REFUND", "REVERSAL", "SPLIT_CORRECTION", "AGREED_ERROR_CORRECTION"],
  adjustmentDirections: ["INCREASE", "DECREASE"],
  holdStates: ["OPEN", "RELEASED", "UPHELD"],
  holdReasons: ["PROVIDER_TIME_UNVERIFIED", "FUNDS_HELD", "PAYOUT_FAILED", "SELLER_DISPUTE", "ATTRIBUTION_DISPUTED"],
  calendarSources: ["VERIFIED_FEED", "TEST_FIXTURE"],
  periodStates: ["OPEN", "CLOSED"],
  statementStates: ["DRAFT", "ISSUED", "DISPUTED", "APPROVED", "PAID", "CORRECTED"],
  statementItemKinds: ["PAYABLE_LINE", "HELD_LINE", "PENDING_LINE", "ADJUSTMENT", "OFFSET", "NEGATIVE_BALANCE"],
  recoveryActions: ["REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"],
  payoutIntentStates: ["AUTHORIZED", "SUBMITTED", "UNCERTAIN", "SETTLED", "FAILED", "RETURNED"],
  payoutEvidenceStatuses: ["SUBMITTED", "SETTLED", "FAILED", "RETURNED"],
  payoutFeeBearers: ["KAURO"],
  guardResults: ["WITHIN_PLANNING_GUARD", "EXCEEDS_PLANNING_GUARD"],
} as const);

export type CommercialVocabulary = typeof COMMERCIAL_VOCABULARY;
