/**
 * The command-layer outcomes of CMD027 CreateQuote (design §3.4, §3.5, §12; decisions D10-QUOTE-1..4): the first failure of its
 * preconditions in the design's order, the stale live quote of two keys racing, and the three refusals of the included replacement. The
 * route's catalogue composes them with the pipeline's shared fragments (commercial/outcomes).
 */
import { problemOutcome as outcome, type ProblemOutcome } from "../../api/outcome-kit.js";

export const CREATE_QUOTE_OUTCOMES: ReadonlyArray<ProblemOutcome> = Object.freeze([
  outcome("COMMAND", "NOT_FOUND", null, "the project or the plan is not visible to the caller's agency: a foreign and a nonexistent id answer alike"),
  outcome("COMMAND", "STALE_VERSION", null, "the project's live quote changed under this request (two requests for one project): the current safe version and state come back", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "AGENCY_NOT_ACTIVE", "the agency is not ACTIVE (DRAFT, RESTRICTED, CLOSING or CLOSED sell nothing)", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "AGREEMENTS_INCOMPLETE", "the agency has accepted no terms version", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_NOT_APPROVED", "the plan is not APPROVED", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_SUPERSEDED", "the plan was superseded by a newer revision", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "PLAN_WITHDRAWN", "the plan's approval was withdrawn", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "APPROVAL_NOT_CURRENT", "the plan has no live, unwithdrawn approval"),
  outcome("COMMAND", "PRECONDITION_FAILED", "NO_BILLABLE_UNITS", "the sealed source freezes no billable units: there is no minimum-price sale"),
  outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "ENVELOPE_NOT_OFFERED", "the billable units are beyond the offered launch envelope (a band above capacity.launchSourceUnits)"),
  outcome("COMMAND", "CAPABILITY_UNAVAILABLE", "MODE_NOT_OFFERED", "the project's mode capability is not offered"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BUYER_TYPE_UNSET", "no buyer type is recorded for the agency (A3 3.7): the quote waits for the recorded type"),
  outcome("COMMAND", "SOURCE_EXPIRED", null, "the plan's source revision is not SEALED or its effective deadline has passed on the database clock"),
  outcome("COMMAND", "TARGET_STALE", null, "the plan's target contract is not confirmed and current"),
  outcome("COMMAND", "PRECONDITION_FAILED", "BILLING_PROFILE_MISMATCH", "billingProfileRef is not the agency's current fiscal profile"),
  outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_UNREVIEWED", "the agency's current fiscal profile carries no reviewed treatment (R2-082): incomplete tax facts block issuance"),
  outcome("COMMAND", "PRECONDITION_FAILED", "FISCAL_TREATMENT_CHANGED", "the reviewed tax rule is not the one the paid terms were priced with"),
  outcome("COMMAND", "PRECONDITION_FAILED", "EXECUTION_STARTED", "the paid execution has started: the entitlement can no longer be re-bound to a replacement (R2-092)", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "REPLACEMENT_SCOPE_CHANGED", "the replacement is not of the paid mode, target and band: current.mismatch carries the base comparison; a larger scope is charged only after a refund and a new accepted quote (R2-093)", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "REPLACEMENT_ALLOWANCE_SPENT", "the one included pre-execution source replacement of this purchase is spent", { current: "ALWAYS" }),
  outcome("COMMAND", "PRECONDITION_FAILED", "UNLISTED_TRANSITION", "the live quote cannot be superseded: a purchase of it still stands (a capture of it is in flight, or its refunds have not returned every service and tax cent); nothing is written and the refusal is final until the purchase is settled"),
  outcome("COMMAND", "INTEGRITY_FAILURE", "PROVIDER_SERVICES_UNAVAILABLE", "no payment service or re-binder is bound in this edition: a replacement of a paid purchase writes nothing"),
  outcome("COMMAND", "INTEGRITY_FAILURE", "PLAN_SERVICES_UNAVAILABLE", "no source availability reader is bound in this edition"),
]);
