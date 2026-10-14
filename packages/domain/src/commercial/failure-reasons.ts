/**
 * Safe reason codes of the agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md §12). They
 * narrow the stable failure codes exactly like the B06, B07 and B09 reasons — machine tokens that never carry a customer value —
 * and are appended once to the closed FAILURE_REASONS list of model/errors.ts, after B09's, so the Problem schema, the outcome
 * catalogues and the acceptance harness enumerate them. This module imports nothing: the failure taxonomy depends on it, never
 * the reverse.
 *
 * The list is §12's new reasons in their order, then the reasons its KC translations name that the list does not repeat
 * (decision D10-ERR-1): each stage-2 adapter translates its KC SQLSTATE into a registered reason, as B09's KP integrity names are.
 */
export const COMMERCIAL_FAILURE_REASONS = [
  // quotes (CMD027; 16 "Price schedule", "Quote calculation", "Scope changes and credits"; A3 3.7)
  "BUYER_TYPE_UNSET",
  "NO_BILLABLE_UNITS",
  "ENVELOPE_NOT_OFFERED",
  "BILLING_PROFILE_MISMATCH",
  // agency lifecycle (CMD002, CMD043; 16 "Agency lifecycle")
  "AGREEMENT_VERSION_NOT_PUBLISHED",
  "AGENCY_NOT_DRAFT",
  "CLOSURE_OBLIGATIONS_UNRECONCILED",
  // KC006: CLOSING -> CLOSED while a payment, refund, authorization, tax document or reconciliation case is open (D10-AGY-4)
  "CLOSURE_RESIDUALS_OPEN",
  // the included replacement (D10-QUOTE-3)
  "REPLACEMENT_SCOPE_CHANGED",
  "REPLACEMENT_ALLOWANCE_SPENT",
  "EXECUTION_STARTED",
  // sellers (CMD048..CMD050; 12 "Seller onboarding and access lifecycle"; KC005)
  "SELLER_NOT_ACTIVE",
  "SELLER_NOT_ACTIVATABLE",
  "AGREEMENT_VERSION_MISMATCH",
  // prospects and claims (CMD045, CMD046; 18 "Prospect qualification"; 17 "Claim validity and conflicts"; KC016)
  "PROSPECT_EXISTS",
  "PROSPECT_SUPPRESSED",
  "SOURCE_EVIDENCE_INVALID",
  "CLAIM_EVIDENCE_INSUFFICIENT",
  "CLAIM_EXISTS",
  "CLAIM_NOT_REVIEWABLE",
  "CLAIM_AFTER_FIRST_ORDER",
  // attribution (CMD047; 17 "The default is one attribution owner"; A3 7.1; KC003)
  "ATTRIBUTION_EXISTS",
  "SHARES_NOT_WHOLE",
  // assignment and termination (CMD048, CMD050; 17 "Assignment changes", "Termination and tail"; KC011)
  "SERVICE_ASSIGNMENT_UNPREPARED",
  "TAIL_NOT_ENUMERATED",
  "TERMINATION_TERMS_UNPREPARED",
  // the period close (CMD051; 17 "Business-day calendar")
  "INPUTS_UNRECONCILED",
  "LEDGER_CHANGED",
  "PERIOD_NOT_DUE",
  // payouts (CMD052, CMD053; 15 "Commission integration"; KC009, KC010, KC017)
  "PAYEE_UNVERIFIED",
  "NOTHING_PAYABLE",
  "FUNDS_UNAVAILABLE",
  "PAYOUT_EVIDENCE_MISMATCH",
  "PAYOUT_NOT_SETTLED",
  "OFFSET_NOT_AUTHORIZED",
  // the platform bindings of D10-BIND-1 (no verified calendar recorded; no payout evidence verifier bound)
  "CALENDAR_UNAVAILABLE",
  "PAYOUT_EVIDENCE_UNAVAILABLE",
  // integrity: the KC SQLSTATEs a handler that respects the schema never meets (KC001, KC002, KC007, KC015 -> INTEGRITY_FAILURE;
  // KC014 -> PRECONDITION_FAILED)
  "DESIGNATION_REWRITE",
  "COMMISSION_POOL_MISMATCH",
  "ELIGIBILITY_WITHOUT_FINAL_COMPLETION",
  "ADJUSTMENT_NOT_CUMULATIVE",
  "RESERVATION_RELEASE_REFUSED",
] as const;

export type CommercialFailureReason = (typeof COMMERCIAL_FAILURE_REASONS)[number];
