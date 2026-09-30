/**
 * Platform state machines of the agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md §8.2).
 * The registry lists CommissionLine, which B10 performs exactly as vendored (model/state-machines resolves it from STATE_MACHINES;
 * design §8.1). The registry contracts Prospect, AttributionClaim, CommissionEntitlement and CommissionStatement carry states without
 * a machine, and the records B10 adds (the founding reservation, the seller, the payout intent and destination, the hold, the period)
 * need one; they are declared here in the registry's own shape under the registry's unlisted-transition policy, as B06 declared
 * EndClient and Project and B09 its commerce machines. Migration 0028 seeds FoundingReservation, and 0029..0031 seed the others,
 * with exactly these initial states and edges (the persistence tests prove the seeds equal).
 *
 * Every event name is unique per (machine, from state), so `transition(machine, from, event)` is a function; the guard of each
 * edge is the enforcement column of §8.2, the effect what the edge records.
 */
import type { StateMachine } from "@kauro/contracts";

const POLICY = "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED";

export type CommercialPlatformMachineName =
  | "FoundingReservation"
  | "Seller"
  | "Prospect"
  | "AttributionClaim"
  | "CommissionEntitlement"
  | "CommissionStatement"
  | "PayoutIntent"
  | "PayoutDestination"
  | "CommissionHold"
  | "CommissionPeriod";

const LOST = "A structured lost reason (B12, CMD064).";
const SUPPRESSED = "A suppression row by organization or contact key (B12, CMD064); outreach stops.";

export const COMMERCIAL_PLATFORM_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    contract: "FoundingReservation",
    initial: "RESERVED",
    terminal: ["CONSUMED", "RELEASED"],
    transitions: [
      { from: "RESERVED", event: "slot_consumed", to: "CONSUMED", guard: "The agency's qualifying purchase of the reservation's own quote (the payment service's designation trigger on the authorization; D10-FIRST-1).", effect: "The slot is consumed for ever; no refund frees it (R2-096)." },
      { from: "RESERVED", event: "reservation_released", to: "RELEASED", guard: "The quote EXPIRED, SUPERSEDED or WITHDRAWN (B09 release guard), the slot freed in the same transaction (KC014).", effect: "The slot is reservable again; the agency never takes another of the cohort (D10-FOUND-1)." },
      { from: "RESERVED", event: "end_with_payment_in_flight", to: "RECONCILIATION_HOLD", guard: "ends_at passed with the quote still ACCEPTED_FOR_CHECKOUT and a payment in flight (QUOTE_EXPIRY sweep; D10-FOUND-4).", effect: "The slot stays held, visibly, until the capture resolves." },
      { from: "RECONCILIATION_HOLD", event: "slot_consumed", to: "CONSUMED", guard: "The capture in flight completed: the designation of the reservation's own quote, as from RESERVED.", effect: "The slot is consumed for ever." },
      { from: "RECONCILIATION_HOLD", event: "reservation_released", to: "RELEASED", guard: "The quote expired after a proved no-capture, the slot freed in the same transaction (KC014).", effect: "The slot is reservable again." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "Seller",
    initial: "CANDIDATE",
    terminal: ["TERMINATED"],
    transitions: [
      { from: "CANDIDATE", event: "seller_activated", to: "ACTIVE", guard: "Signed agreement, legal review of the classification, assessment, confidentiality, verified payment and tax facts, verified identity with MFA and the owner's step-up (CMD049; KC005).", effect: "Least-privilege seller access under the agreement's compensation version." },
      { from: "ACTIVE", event: "seller_suspended", to: "SUSPENDED", guard: "The owner's decision (B12).", effect: "New seller work stops; earned rights stay." },
      { from: "SUSPENDED", event: "seller_reinstated", to: "ACTIVE", guard: "The owner's decision (B12) while the activation facts still hold (KC005).", effect: "Seller access resumes." },
      { from: "ACTIVE", event: "seller_terminated", to: "TERMINATED", guard: "Termination terms and the enumerated tail entries (CMD050; KC011).", effect: "Access ends; residuals and the tail are kept (R2-100)." },
      { from: "SUSPENDED", event: "seller_terminated", to: "TERMINATED", guard: "Same as from ACTIVE (CMD050; KC011).", effect: "Access ends; residuals and the tail are kept." },
      { from: "CANDIDATE", event: "candidate_not_engaged", to: "TERMINATED", guard: "No agreement was signed (B12).", effect: "The candidate never gains access." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "Prospect",
    initial: "RESEARCHED",
    terminal: ["SUPPRESSED"],
    transitions: [
      { from: "RESEARCHED", event: "qualification_recorded", to: "QUALIFIED", guard: "Evidence of need, mode, timing and contact (B12, CMD064).", effect: "The prospect may be contacted." },
      { from: "QUALIFIED", event: "contact_recorded", to: "CONTACTED", guard: "An observed send (B12, CMD063 or CMD064).", effect: "Outreach is on record." },
      { from: "CONTACTED", event: "engagement_recorded", to: "ENGAGED", guard: "An observed reply (B12, CMD064).", effect: "A conversation is on record." },
      { from: "ENGAGED", event: "opportunity_recorded", to: "OPPORTUNITY", guard: "An issued quote or audit invitation (B12, CMD064).", effect: "A concrete opportunity is on record." },
      { from: "OPPORTUNITY", event: "won_recorded", to: "WON", guard: "The agency's qualifying purchase (B12, CMD064).", effect: "The prospect became a customer; attribution follows its own claim." },
      { from: "RESEARCHED", event: "lost_recorded", to: "LOST", guard: LOST, effect: "The prospect rests until a new signal." },
      { from: "QUALIFIED", event: "lost_recorded", to: "LOST", guard: LOST, effect: "The prospect rests until a new signal." },
      { from: "CONTACTED", event: "lost_recorded", to: "LOST", guard: LOST, effect: "The prospect rests until a new signal." },
      { from: "ENGAGED", event: "lost_recorded", to: "LOST", guard: LOST, effect: "The prospect rests until a new signal." },
      { from: "OPPORTUNITY", event: "lost_recorded", to: "LOST", guard: LOST, effect: "The prospect rests until a new signal." },
      { from: "LOST", event: "new_signal_recorded", to: "RESEARCHED", guard: "A legitimate new business signal (B12, CMD064; 16 Agency lifecycle).", effect: "Research may start again." },
      { from: "RESEARCHED", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "QUALIFIED", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "CONTACTED", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "ENGAGED", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "OPPORTUNITY", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "LOST", event: "suppression_recorded", to: "SUPPRESSED", guard: SUPPRESSED, effect: "Registration and outreach are refused however the label is spelled (KC016)." },
      { from: "WON", event: "suppression_recorded", to: "SUPPRESSED", guard: "Same; transactional notices stay separate (B12, CMD064).", effect: "Prospecting stops; the customer relationship is untouched." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "AttributionClaim",
    initial: "SUBMITTED",
    terminal: ["REJECTED", "EXPIRED", "CONVERTED"],
    transitions: [
      { from: "SUBMITTED", event: "claim_conflict_found", to: "DISPUTED", guard: "A live accepted or competing claim, or customer history, found in the same transaction (CMD046).", effect: "The claim goes to conflict review and owns nothing." },
      { from: "SUBMITTED", event: "claim_accepted", to: "ACCEPTED", guard: "A frozen allocation naming the claim with shares of exactly 10000 bps (CMD047; KC003).", effect: "The claim runs for 2160 hours unless converted." },
      { from: "DISPUTED", event: "claim_accepted", to: "ACCEPTED", guard: "The allocation's decision reason resolves the conflict (CMD047; KC003).", effect: "The claim runs for 2160 hours unless converted." },
      { from: "SUBMITTED", event: "claim_rejected", to: "REJECTED", guard: "A competing claim's allocation rules against it (CMD047).", effect: "The claim ends without rights." },
      { from: "DISPUTED", event: "claim_rejected", to: "REJECTED", guard: "Same as from SUBMITTED (CMD047).", effect: "The claim ends without rights." },
      { from: "SUBMITTED", event: "claim_lapsed", to: "EXPIRED", guard: "The review deadline passed, or its seller was terminated (CLAIM_WINDOWS sweep; CMD050).", effect: "The claim ends without rights." },
      { from: "DISPUTED", event: "claim_lapsed", to: "EXPIRED", guard: "Same as from SUBMITTED (CLAIM_WINDOWS sweep; CMD050).", effect: "The claim ends without rights." },
      { from: "ACCEPTED", event: "claim_lapsed", to: "EXPIRED", guard: "expires_at (or its tail end) passed with no first purchase, or unlisted at its seller's termination (CLAIM_WINDOWS sweep; CMD050).", effect: "The claim ends without an entitlement." },
      { from: "ACCEPTED", event: "first_purchase_confirmed", to: "CONVERTED", guard: "The agency's first purchase confirmed before the claim's (or tail's) end, the claim before the first order (COMMISSIONS consumer).", effect: "One entitlement per beneficiary of the frozen allocation." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CommissionEntitlement",
    initial: "ACTIVE",
    terminal: ["EXPIRED"],
    transitions: [
      { from: "ACTIVE", event: "window_ended", to: "EXPIRED", guard: "window_ends_at passed (ENTITLEMENT_WINDOWS sweep).", effect: "No new acquisition line; earned lines are unaffected." },
      { from: "ACTIVE", event: "seller_terminated", to: "TERMINATED_WITH_RESIDUAL", guard: "The seller's termination (CMD050).", effect: "Lines keep accruing inside the window." },
      { from: "ACTIVE", event: "attribution_disputed", to: "DISPUTED", guard: "A seller or owner dispute of the attribution (B12).", effect: "Only this entitlement's lines are held." },
      { from: "DISPUTED", event: "dispute_resolved", to: "ACTIVE", guard: "A reviewed resolution (B12).", effect: "The held lines resume their path." },
      { from: "DISPUTED", event: "seller_terminated", to: "TERMINATED_WITH_RESIDUAL", guard: "Same as from ACTIVE (CMD050).", effect: "Lines keep accruing inside the window." },
      { from: "DISPUTED", event: "window_ended", to: "EXPIRED", guard: "Same as from ACTIVE (ENTITLEMENT_WINDOWS sweep).", effect: "No new acquisition line; earned lines are unaffected." },
      { from: "TERMINATED_WITH_RESIDUAL", event: "window_ended", to: "EXPIRED", guard: "Same as from ACTIVE (ENTITLEMENT_WINDOWS sweep).", effect: "No new acquisition line; earned lines are unaffected." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CommissionStatement",
    initial: "DRAFT",
    terminal: ["PAID", "CORRECTED"],
    transitions: [
      { from: "DRAFT", event: "statement_issued", to: "ISSUED", guard: "The same transaction as its items (CMD051).", effect: "An immutable itemized statement with its pay date." },
      { from: "ISSUED", event: "payout_approved", to: "APPROVED", guard: "One live intent to a VERIFIED payee (CMD052; KC009).", effect: "An authorized payout intent of exactly the payable." },
      { from: "APPROVED", event: "payout_settled", to: "PAID", guard: "Settled evidence of its intent (CMD053; KC010).", effect: "The statement is paid with its evidence hash." },
      { from: "APPROVED", event: "payout_not_settled", to: "ISSUED", guard: "The intent FAILED or RETURNED (CMD053).", effect: "The statement is payable again; its lines are held." },
      { from: "ISSUED", event: "statement_disputed", to: "DISPUTED", guard: "The seller's dispute of the whole statement (B12).", effect: "Payout waits for the dispute." },
      { from: "DISPUTED", event: "dispute_scoped", to: "ISSUED", guard: "The dispute became line holds (B12).", effect: "The undisputed payable proceeds." },
      { from: "DISPUTED", event: "correction_issued", to: "CORRECTED", guard: "A correcting statement supersedes it (CMD051).", effect: "The corrected statement is history." },
      { from: "ISSUED", event: "correction_issued", to: "CORRECTED", guard: "Same as from DISPUTED (CMD051).", effect: "The corrected statement is history." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "PayoutIntent",
    initial: "AUTHORIZED",
    terminal: ["SETTLED", "FAILED", "RETURNED"],
    transitions: [
      { from: "AUTHORIZED", event: "transfer_submitted", to: "SUBMITTED", guard: "The payout adapter's durable submission (B15).", effect: "Submission is not settlement." },
      { from: "SUBMITTED", event: "transfer_ambiguous", to: "UNCERTAIN", guard: "A lost response (B15).", effect: "No blind resubmission; reconcile by the stable reference." },
      { from: "AUTHORIZED", event: "settled_evidence", to: "SETTLED", guard: "Matching SETTLED evidence (CMD053).", effect: "The statement is paid." },
      { from: "SUBMITTED", event: "settled_evidence", to: "SETTLED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The statement is paid." },
      { from: "UNCERTAIN", event: "settled_evidence", to: "SETTLED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The statement is paid." },
      { from: "AUTHORIZED", event: "failed_evidence", to: "FAILED", guard: "Matching FAILED evidence (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
      { from: "SUBMITTED", event: "failed_evidence", to: "FAILED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
      { from: "UNCERTAIN", event: "failed_evidence", to: "FAILED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
      { from: "AUTHORIZED", event: "returned_evidence", to: "RETURNED", guard: "Matching RETURNED evidence (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
      { from: "SUBMITTED", event: "returned_evidence", to: "RETURNED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
      { from: "UNCERTAIN", event: "returned_evidence", to: "RETURNED", guard: "Same as from AUTHORIZED (CMD053).", effect: "The intent is kept; the lines are held PAYOUT_FAILED." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "PayoutDestination",
    initial: "PENDING_VERIFICATION",
    terminal: ["REJECTED", "SUPERSEDED"],
    transitions: [
      { from: "PENDING_VERIFICATION", event: "destination_verified", to: "VERIFIED", guard: "The seller's own step-up at the change and an owner verification at least 172800 seconds later (B12; D10-SELL-2).", effect: "Payouts may be approved to this version." },
      { from: "PENDING_VERIFICATION", event: "destination_rejected", to: "REJECTED", guard: "The owner's decision (B12).", effect: "No payout ever reaches this version." },
      { from: "VERIFIED", event: "destination_superseded", to: "SUPERSEDED", guard: "A later version VERIFIED (B12).", effect: "Intents approved earlier keep this version and digest." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CommissionHold",
    initial: "OPEN",
    terminal: ["RELEASED", "UPHELD"],
    transitions: [
      { from: "OPEN", event: "hold_released", to: "RELEASED", guard: "Funds AVAILABLE, or the dispute resolved for the seller (ELIGIBILITY sweep; B12).", effect: "The held cents resume their path." },
      { from: "OPEN", event: "hold_upheld", to: "UPHELD", guard: "A reviewed decision (B12).", effect: "An AGREED_ERROR_CORRECTION adjustment posts the difference." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CommissionPeriod",
    initial: "OPEN",
    terminal: ["CLOSED"],
    transitions: [{ from: "OPEN", event: "period_closed", to: "CLOSED", guard: "Inputs reconciled and the cutoff hash equal (CMD051).", effect: "One immutable statement per seller, dated by the recorded calendar version." }],
    unlistedTransition: POLICY,
  },
]);
