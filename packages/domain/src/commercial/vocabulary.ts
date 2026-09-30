/**
 * The commercial vocabulary of package B10 (docs/design/B10-commercial-domain.md §3–§9; decision D10-STAGE-2): every token set a B10
 * record stores, spelled once as runtime constants. The record types of records.ts are derived from these lists, the platform
 * machines' states equal the state lists (test/commercial-stage-one.test.ts), every enumerated column of migrations 0028..0031 admits
 * exactly its list (persistence test/b10-stage-one.test.ts) and the application's views answer these lists (application
 * test/commercial-stage-one.test.ts), so no layer converts a token and none spells a token another refuses.
 */
export const COMMERCIAL_VOCABULARY = Object.freeze({
  // --- recurrence, founding cohort, quotes (§3; 0028) ---
  /** The agency's recorded buyer type (A3 3.7). */
  buyerTypes: ["AGENCY", "IN_HOUSE"],
  /** qualifying_purchases.founding_basis (D10-REC-3). */
  foundingBases: ["NONE", "RESERVED_SLOT", "UNBACKED"],
  /** CreateQuoteView.eligibility.foundingOffer (§3.4). */
  foundingOffers: ["RESERVED", "NOT_ELIGIBLE", "NONE_AVAILABLE"],
  foundingReservationStates: ["RESERVED", "RECONCILIATION_HOLD", "CONSUMED", "RELEASED"],
  /** founding_slot_reservations.release_reason: 'QUOTE_' and the state its quote ended in (KC014). */
  reservationReleaseReasons: ["QUOTE_SUPERSEDED", "QUOTE_EXPIRED", "QUOTE_WITHDRAWN"],
  /** What kauro.eligibility_findings() reports (D10-REC-3; Q10-1, Q10-7). */
  eligibilityFindings: ["UNSUPPORTED_PROJECT", "MISSING_PROJECT", "PARTLY_REFUNDED_COUNTED", "UNBACKED_FOUNDING_RATE"],
  // --- agency lifecycle (§4; 0028) ---
  serviceAgreementKinds: ["TERMS", "PRIVACY"],
  /** A version is born PUBLISHED and only retires (D10-AGY-1). */
  serviceAgreementStates: ["PUBLISHED", "RETIRED"],
  /** The agency states CMD043 moves to CLOSING (§8.1 owner_requests_closure, owner_abandons_setup). */
  closureFromStates: ["DRAFT", "ACTIVE", "RESTRICTED"],
  /** agency_relationship_decisions.treatment (R2-141; example 24; D10-AGY-3). */
  relationshipTreatments: ["SEPARATE_TENANTS_CONFIRMED", "COMMON_CONTROL_RECORDED", "LEGAL_SUCCESSOR_RECORDED"],
  // --- sellers, prospects, claims, attribution, assignment (§5; 0029) ---
  sellerStates: ["CANDIDATE", "ACTIVE", "SUSPENDED", "TERMINATED"],
  sellerClassifications: ["INDEPENDENT_COLLABORATION", "EMPLOYMENT", "OTHER_REVIEWED"],
  offsetTerms: ["NONE", "SIGNED_FUTURE_OFFSET"],
  /** A legal review confirms the classification's substance or does not (D10-SELL-3). */
  legalReviewOutcomes: ["CONFIRMED", "NOT_CONFIRMED"],
  assessmentOutcomes: ["PASSED", "NOT_PASSED"],
  /** The currencies a payout destination may be held in (seller_payout_destinations.currency). */
  destinationCurrencies: ["USD", "COP"],
  payoutDestinationStates: ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "SUPERSEDED"],
  prospectStates: ["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY", "WON", "LOST", "SUPPRESSED"],
  /** Prospects are agencies only (18 "Prospect qualification" as amended by A3; D58). */
  prospectSegments: ["AGENCY"],
  /** A suppression matches the organization key or the contact key (KC016). */
  suppressionKeyKinds: ["ORGANIZATION", "CONTACT"],
  attributionClaimStates: ["SUBMITTED", "ACCEPTED", "DISPUTED", "REJECTED", "EXPIRED", "CONVERTED"],
  /** Acquisition activity a claim's evidence names; a list import or a tracking link alone is not a claim (17 "Attribution subject"). */
  claimActivityKinds: ["FIRST_MEANINGFUL_CONTACT", "QUALIFIED_NEED", "DISCOVERY_MEETING", "PROPOSAL", "CLOSING_SUPPORT", "LIST_IMPORT", "TRACKING_LINK"],
  entitlementStates: ["ACTIVE", "EXPIRED", "DISPUTED", "TERMINATED_WITH_RESIDUAL"],
  /** An entitlement's and a pool's source (D10-ASSIST-1). */
  commissionSources: ["ACQUISITION", "ASSISTANCE"],
  serviceCompensations: ["NONE", "ASSISTANCE_AGREEMENT"],
  /** Why a link of the assignment chain exists: an assignment, an unassignment, the seller's termination (D10-ASSIGN-2). */
  assignmentReasons: ["ASSIGNED", "UNASSIGNED", "SELLER_TERMINATED"],
  assistanceScopes: ["PROJECT", "NEXT_PURCHASE"],
  // --- the ledger (§6; 0030) ---
  completionKinds: ["STAGE", "FINAL"],
  /** Which binding reported a completion: B09's delivered authorization (D10-BIND-1) or a staged purchase's preparation (B13). */
  completionSources: ["AUTHORIZATION_DELIVERY", "STAGED_PREPARATION"],
  /** A pool's rate: the first designation's, a repeat's inside the window, or an assistance agreement's (D10-RATE-1, D10-ASSIST-2). */
  rateKinds: ["FIRST", "REPEAT", "ASSISTANCE"],
  lineStates: ["ACCRUED_PENDING", "ELIGIBLE", "HELD", "PAYABLE", "PAID", "ADJUSTED", "VOID"],
  adjustmentReasons: ["REFUND", "REVERSAL", "SPLIT_CORRECTION", "AGREED_ERROR_CORRECTION"],
  adjustmentDirections: ["INCREASE", "DECREASE"],
  holdStates: ["OPEN", "RELEASED", "UPHELD"],
  /**
   * Why cents are held (D10-HOLD-1; 8.1): an unverifiable provider instant (example 10), funds the provider holds (example 14), a
   * failed or returned payout, the seller's dispute of part of a line (R2-102), a disputed attribution (its entitlement's lines only).
   */
  holdReasons: ["PROVIDER_TIME_UNVERIFIED", "FUNDS_HELD", "PAYOUT_FAILED", "SELLER_DISPUTE", "ATTRIBUTION_DISPUTED"],
  /** What capture.funds_observed.v1 can tell the ledger (B09 D-EVT-B2): the funds held or available, never unknown. */
  observedFundsStates: ["HELD", "AVAILABLE"],
  // --- periods, statements, payouts (§7; 0031) ---
  calendarJurisdictions: ["CO"],
  calendarSources: ["VERIFIED_FEED", "TEST_FIXTURE"],
  periodStates: ["OPEN", "CLOSED"],
  /** A statement closed on a TEST_FIXTURE calendar is SIMULATED (D10-CAL-1). */
  statementLabels: ["VERIFIED_CALENDAR", "SIMULATED"],
  statementStates: ["DRAFT", "ISSUED", "DISPUTED", "APPROVED", "PAID", "CORRECTED"],
  /** A statement item (D10-STMT-2): a line, an adjustment it reports, a partial hold, an offset, an owner recovery item. */
  statementItemKinds: ["LINE", "ADJUSTMENT", "HOLD", "OFFSET", "RECOVERY"],
  /** What an item does (D10-STMT-2): a LINE is payable, awaiting its final completion or its funds, or held; a RECOVERY is one action. */
  statementItemDispositions: ["PAYABLE", "AWAITING_FINAL_COMPLETION", "AWAITING_FUNDS", "HELD", "REPORTED", "REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"],
  /** The owner's resolutions of a negative balance without signed offset terms (D10-NEG-1; example 7): a RECOVERY item's disposition. */
  recoveryActions: ["REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"],
  payoutIntentStates: ["AUTHORIZED", "SUBMITTED", "UNCERTAIN", "SETTLED", "FAILED", "RETURNED"],
  /** What authenticated payout evidence reports ("Submitting a transfer is not proof"). */
  payoutEvidenceStatuses: ["SUBMITTED", "SETTLED", "FAILED", "RETURNED"],
  /** The currency a payout intent is authorized in (D10-PAY-1; FX of a COP payout is B15's). */
  payoutCurrencies: ["USD"],
  /** Who bears the transfer fee (policy commission.feeBearer, brand-mapped by amendment A2): the company, never the seller. */
  payoutFeeBearers: ["KAURO"],
  guardResults: ["WITHIN_PLANNING_GUARD", "EXCEEDS_PLANNING_GUARD"],
  /** The compensation guard is a business planning guard, never a legal ceiling (D10-GUARD-1). */
  guardLabels: ["BUSINESS_PLANNING_GUARD"],
} as const);

export type CommercialVocabulary = typeof COMMERCIAL_VOCABULARY;
