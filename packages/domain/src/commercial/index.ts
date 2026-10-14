/**
 * The agency recurrence and commission domain of package B10 (docs/design/B10-commercial-domain.md): the records of §3–§7, the
 * commission policy, the buyer's recurrence and founding decisions, the prospect organization key, the ledger's arithmetic over
 * B09's money kernel, the time rules (window, rate, eligibility, banking days) and the failure reasons of §12. The platform machines
 * and the event vocabulary (commercial/machines.ts, commercial/events.ts) are exported through lines of their own in src/index.ts.
 */
export type { CommercialFailureReason } from "./failure-reasons.js";
export { COMMERCIAL_FAILURE_REASONS } from "./failure-reasons.js";

export type { OutreachPurpose, SenderRoute, SenderState, DraftState, IntentState, ActivityKind, OutreachSuppressionReason, OutreachFailureReason, OutreachLock } from "./outreach.js";
export {
  OUTREACH_PURPOSES,
  SENDER_ROUTES,
  OUTREACH_ROUTES,
  SENDER_STATES,
  SENDER_EDGES,
  DRAFT_STATES,
  DRAFT_EDGES,
  INTENT_STATES,
  INTENT_EDGES,
  COUNTED_INTENT_STATES,
  intentCounted,
  ACTIVITY_KINDS,
  SUPPRESSION_REASONS,
  OUTREACH_BOUNDS,
  OUTREACH_CADENCE,
  OUTREACH_LOCK_KINDS,
  OUTREACH_LOCK_ORDER,
  PROSPECT_CONTACT_DOMAIN,
  normalizeContactAddress,
  contactKeyOf,
  OUTREACH_BINDING_DOMAIN,
  outreachBindingHash,
  OUTREACH_CONTENT_DOMAIN,
  outreachContentId,
  OUTREACH_FAILURE_REASONS,
} from "./outreach.js";

export type { OutreachEventType } from "./outreach-events.js";
export { OUTREACH_AGGREGATE_KINDS, OUTREACH_CONSUMERS, OUTREACH_EVENT_TYPES, OUTREACH_EVENT_PAYLOAD_ALLOWLIST, OUTREACH_EVENT_SUBSCRIPTIONS } from "./outreach-events.js";

export type { CommercialVocabulary } from "./vocabulary.js";
export { COMMERCIAL_VOCABULARY } from "./vocabulary.js";

export type * from "./records.js";
export { HOLD_REASONS } from "./records.js";

export type { CommissionPolicy } from "./policy.js";
export { COMPENSATION_PLANNING_GUARD_BPS, PROVIDER_TIME_PLAUSIBILITY_TOLERANCE_MS, PROVIDER_TIME_PLAUSIBILITY_TOLERANCE_VERSION, commissionPolicyFrom, registryCommissionPolicy } from "./policy.js";

export type { BankingDays } from "./calendar.js";
export { addCalendarMonths, addHours, assertCanonicalInstant, bankingDayAfterMonthEnd, monthStartsAt, nextMonth, zoneIsKnown } from "./calendar.js";

export type { QualifyingPurchaseFacts, FoundingIneligibility, QuoteEligibility } from "./recurrence.js";
export { remainingServiceBasis, qualifyingProjectsAt, foundingEligibility, quoteEligibility } from "./recurrence.js";

export { PROSPECT_ORGANIZATION_DOMAIN, normalizeOrganizationDomain, organizationKeyOf } from "./prospects.js";

export type {
  CommissionBasisFacts,
  PoolShare,
  PoolLineState,
  CommissionPoolState,
  BasisChange,
  LineAdjustment,
  PoolRecomputation,
  LinePosition,
  NegativeBalanceTreatment,
  CompensationGuardReview,
} from "./ledger.js";
export { commissionBasis, commissionPoolCents, allocatePool, recomputePool, linePosition, RECOVERY_ACTIONS, applyNegativeBalance, compensationGuard } from "./ledger.js";

export type { LineOffsetTerms, CaptureFunds, PeriodLedgerRows, ComposedStatementItem, StatementComposition } from "./statements.js";
export { COMMISSION_CUTOFF_DOMAIN, commissionCutoffHash, composeStatement } from "./statements.js";

export type { AcquisitionRateFacts, AcquisitionRateDecision, EligibilityFacts, EligibilityDecision, CommissionPeriodDates } from "./time.js";
export { recurrenceWindowEndsAt, providerTimePlausible, acquisitionRate, eligibleAtOf, holdCoversLine, eligibilityDecision, commissionPeriodOf } from "./time.js";

export type { B12OperationId } from "./b12-operations.js";
export { B12_OPERATIONS, B12_OUTREACH_OPERATIONS, B12_PRODUCER_OPERATIONS, isB12Operation } from "./b12-operations.js";
