/**
 * The enumerations the commercial views answer (docs/design/B10-commercial-domain.md §4 states, §6 statements and adjustments, §8
 * commission periods, §9 payout intents), for the closed response schemas and the TypeScript DTOs of this package.
 *
 * Each is the domain's stored vocabulary (COMMERCIAL_VOCABULARY; D10-STAGE-2), never a second spelling: B10-PORTS-FAKES first declared
 * them here beside B10-MODEL, and the stage-1 integration found two that had drifted from what the database stores (a sales account's
 * new-work compensation, a statement line's rate kind), so a view built from a stored row would have been refused by its own schema.
 * The command lanes that serve these views convert nothing (application test/commercial-stage-one.test.ts keeps them equal).
 */
import { COMMERCIAL_VOCABULARY as V } from "@kauro/domain";

export const COMMERCIAL_VIEW_VOCABULARY = Object.freeze({
  /** Prospect stages (registry Prospect.state; design §4). */
  prospectStates: V.prospectStates,
  /** Attribution claim states (registry AttributionClaim.state). */
  claimStates: V.attributionClaimStates,
  /** Seller lifecycle (design §4): only ACTIVE may act. */
  sellerStates: V.sellerStates,
  /** The reviewed classification of a seller agreement (design §4; a classification of EMPLOYMENT is never activated as a collaboration). */
  sellerClassifications: V.sellerClassifications,
  /** Commission statement lifecycle (registry CommissionStatement.state). */
  statementStates: V.statementStates,
  /** Payout intent lifecycle (design §9): AUTHORIZED by the owner, then the provider's word decides. */
  payoutIntentStates: V.payoutIntentStates,
  /** What the founding offer did for a quote (design §3.3): reserved a slot, the agency was not eligible, or the cohort was full. */
  foundingOffers: V.foundingOffers,
  /** A statement line's rate: the agency's first qualifying purchase, a repeat, or a prospective assistance agreement's pool (§6; D10-ASSIST-2). */
  commissionSequences: V.rateKinds,
  /** The direction of a statement adjustment. */
  adjustmentDirections: V.adjustmentDirections,
  /** Commission period lifecycle (design §8). */
  periodStates: V.periodStates,
  /** Where the calendar a period was closed against came from (D10-CAL-1). */
  calendarSources: V.calendarSources,
  /** Whether a reassigned account earns its new seller anything for new work: its service assignment's compensation (design §5). */
  newWorkCompensation: V.serviceCompensations,
  /** What an unrecovered balance of a statement is waiting on: an OFFSET item or a RECOVERY item's action (design §6; D10-STMT-2). */
  balanceItemKinds: ["OFFSET", ...V.recoveryActions] as const,
});

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
