/**
 * The enumerations the commercial views answer (docs/design/B10-commercial-domain.md §4 states, §6 statements and adjustments, §8
 * commission periods, §9 payout intents), spelled once for the closed response schemas and the TypeScript DTOs of this package.
 *
 * They are declared here, not imported from the B10 domain model, on purpose: B10-MODEL is built beside this lane, so a view never
 * depends on a vocabulary another lane may still be changing. The model lane's own enumerations are the same design tables; the
 * command lanes that serve these views convert nothing, so a token that drifts fails the send guard's schema check at once.
 */

export const COMMERCIAL_VIEW_VOCABULARY = Object.freeze({
  /** Prospect stages (registry Prospect.state; design §4). */
  prospectStates: ["RESEARCHED", "QUALIFIED", "CONTACTED", "ENGAGED", "OPPORTUNITY", "WON", "LOST", "SUPPRESSED"],
  /** Attribution claim states (registry AttributionClaim.state). */
  claimStates: ["SUBMITTED", "ACCEPTED", "DISPUTED", "REJECTED", "EXPIRED", "CONVERTED"],
  /** Seller lifecycle (design §4): only ACTIVE may act. */
  sellerStates: ["CANDIDATE", "ACTIVE", "SUSPENDED", "TERMINATED"],
  /** The reviewed classification of a seller agreement (design §4; a classification of EMPLOYMENT is never activated as a collaboration). */
  sellerClassifications: ["INDEPENDENT_COLLABORATION", "EMPLOYMENT", "OTHER_REVIEWED"],
  /** Commission statement lifecycle (registry CommissionStatement.state). */
  statementStates: ["DRAFT", "ISSUED", "DISPUTED", "APPROVED", "PAID", "CORRECTED"],
  /** Payout intent lifecycle (design §9): AUTHORIZED by the owner, then the provider's word decides. */
  payoutIntentStates: ["AUTHORIZED", "SUBMITTED", "UNCERTAIN", "SETTLED", "FAILED", "RETURNED"],
  /** What the founding offer did for a quote (design §3.3): reserved a slot, the agency was not eligible, or the cohort was full. */
  foundingOffers: ["RESERVED", "NOT_ELIGIBLE", "NONE_AVAILABLE"],
  /** Whether a purchase is the agency's first qualifying one or a repeat (design §7). */
  commissionSequences: ["FIRST", "REPEAT"],
  /** The direction of a statement adjustment. */
  adjustmentDirections: ["INCREASE", "DECREASE"],
  /** Commission period lifecycle (design §8). */
  periodStates: ["OPEN", "CLOSED"],
  /** Where the calendar a period was closed against came from (D10-CAL-1). */
  calendarSources: ["VERIFIED_FEED", "TEST_FIXTURE"],
  /** Whether a reassigned account earns its new seller anything for new work (design §5). */
  newWorkCompensation: ["NONE", "ASSISTANCE"],
  /** What an unrecovered balance of a statement is waiting on (design §6). */
  balanceItemKinds: ["OFFSET", "REPAYMENT_REVIEW", "WRITE_OFF", "DISPUTE"],
} as const);

type Vocabulary = typeof COMMERCIAL_VIEW_VOCABULARY;

export type ProspectState = Vocabulary["prospectStates"][number];
export type ClaimState = Vocabulary["claimStates"][number];
export type SellerState = Vocabulary["sellerStates"][number];
export type SellerClassification = Vocabulary["sellerClassifications"][number];
export type StatementState = Vocabulary["statementStates"][number];
export type PayoutIntentState = Vocabulary["payoutIntentStates"][number];
export type FoundingOfferOutcome = Vocabulary["foundingOffers"][number];
export type CommissionSequence = Vocabulary["commissionSequences"][number];
export type AdjustmentDirection = Vocabulary["adjustmentDirections"][number];
export type CommissionPeriodState = Vocabulary["periodStates"][number];
export type CalendarSourceKind = Vocabulary["calendarSources"][number];
export type NewWorkCompensation = Vocabulary["newWorkCompensation"][number];
export type StatementBalanceKind = Vocabulary["balanceItemKinds"][number];
