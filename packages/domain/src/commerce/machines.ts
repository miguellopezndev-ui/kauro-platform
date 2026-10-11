/**
 * Platform state machines of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §4.2). The
 * registry lists the machines PaymentAttempt and TaxDocument; those are used exactly as vendored (model/state-machines resolves
 * them from STATE_MACHINES). The registry contracts Quote (07 "Quote and checkout states" names its states), PaymentOrder,
 * CaptureFact, Refund and CommercialAuthorization carry states without a machine, and the platform records (payment routes,
 * fiscal issuer routes, corporate grants, standing refund policies, reconciliation cases) need one; decisions D-MACH-B1..B10
 * declare them here in the registry's own shape and under the registry's unlisted-transition policy — exactly as B06 declared
 * EndClient and Project (D-AGG-1, D-AGG-2) — and migrations 0013..0017 seed exactly the same initial states and edges into
 * kauro.state_machines / kauro.state_transitions (the persistence test proves equality).
 *
 * Every event name is unique per (machine, from state), so `transition(machine, from, event)` is a function.
 */
import type { StateMachine } from "@kauro/contracts";

const POLICY = "REJECT_UNLESS_A_NEW_VERSIONED_CONTRACT_IS_ACCEPTED";

export type CommercePlatformMachineName =
  | "Quote"
  | "PaymentOrder"
  | "CaptureFact"
  | "CommercialAuthorization"
  | "Refund"
  | "ReconciliationCase"
  | "PaymentRoute"
  | "FiscalIssuerRoute"
  | "CorporateGrant"
  | "RefundPolicy";

export const COMMERCE_PLATFORM_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    contract: "Quote",
    initial: "DRAFT",
    terminal: ["EXPIRED", "SUPERSEDED", "WITHDRAWN"],
    transitions: [
      { from: "DRAFT", event: "issue_quote", to: "ISSUED", guard: "Saleable scope, exact count, offered capability, customer identity and a reviewed fiscal treatment resolved (CMD027).", effect: "Freeze terms, amounts, the eligibility snapshot and both expiries." },
      { from: "DRAFT", event: "withdraw_quote", to: "WITHDRAWN", guard: "Authorized billing actor.", effect: "The draft never becomes binding." },
      { from: "ISSUED", event: "accept_terms_for_checkout", to: "ACCEPTED_FOR_CHECKOUT", guard: "The agency names the exact termsHash inside CreatePaymentOrder (CMD028) and checkout is ready; or, for a replacement quote, the payment service re-binds the paid capture to it under the included source replacement (D-QUOTE-B6).", effect: "The accepted terms govern every order of this quote (a replacement is never paid again)." },
      { from: "ISSUED", event: "price_expiry_reached", to: "EXPIRED", guard: "Server time passed expiresAt.", effect: "Checkout is blocked; a new quote is required." },
      { from: "ISSUED", event: "superseding_quote_issued", to: "SUPERSEDED", guard: "A new binding quote names this one.", effect: "The old offer stops; its reservation does not extend." },
      { from: "ISSUED", event: "withdraw_quote", to: "WITHDRAWN", guard: "Authorized billing or corporate actor.", effect: "The offer stops." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "price_expiry_reached", to: "EXPIRED", guard: "Nothing in flight or uncertain, and the purchase closed: no live entitlement and every completed capture wholly refunded or reversed (D-QUOTE-B4; 16 Founding incentive).", effect: "Checkout is blocked; only a proven absence (or complete return) of the payment releases what the quote reserved." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "superseding_quote_issued", to: "SUPERSEDED", guard: "Nothing in flight or uncertain; the purchase closed, or re-bound to exactly this replacement (D-QUOTE-B4, D-QUOTE-B6).", effect: "The previous offer is superseded explicitly; a paid purchase continues under its replacement." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "withdraw_quote", to: "WITHDRAWN", guard: "Nothing in flight or uncertain, and the purchase closed (no live entitlement; every completed capture wholly refunded or reversed).", effect: "The offer stops; a new quote may follow (15 Price and source expiry races: refund and issue a new quote)." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "PaymentOrder",
    initial: "INTENT_CREATED",
    terminal: ["CAPTURED", "FAILED", "CANCELLED", "EXPIRED"],
    transitions: [
      { from: "INTENT_CREATED", event: "dispatch_intent_committed", to: "CREATING", guard: "The CREATE_ORDER attempt becomes DISPATCHING in the same transaction.", effect: "Only now may the provider order be created." },
      { from: "INTENT_CREATED", event: "cancel_before_dispatch", to: "CANCELLED", guard: "The attempt is CANCELLED_BEFORE_DISPATCH: no provider effect was possible.", effect: "Release the checkout slot of the project." },
      { from: "CREATING", event: "provider_order_created", to: "CREATED", guard: "Authenticated creation response or query with the recorded request identity, amount, currency, payee and environment.", effect: "Record the provider order identity once." },
      { from: "CREATING", event: "creation_proved_no_effect", to: "FAILED", guard: "Provider evidence proves no order exists for any request identity of this order, and the bounded attempts are spent.", effect: "A new deliberate order may be created for the quote." },
      { from: "CREATED", event: "buyer_approval_observed", to: "APPROVED", guard: "Authenticated provider observation of buyer approval.", effect: "Capture may be dispatched; approval is not payment." },
      { from: "CREATED", event: "capture_dispatch_committed", to: "CAPTURING", guard: "The CAPTURE attempt becomes DISPATCHING; commercial prerequisites rechecked.", effect: "Capture through the server adapter only." },
      { from: "APPROVED", event: "capture_dispatch_committed", to: "CAPTURING", guard: "Same.", effect: "Same." },
      { from: "CREATED", event: "capture_observed", to: "CAPTURED", guard: "An authenticated capture of this order was observed without a local dispatch (webhook or query first).", effect: "Record the real money; authority only if every prerequisite still binds." },
      { from: "APPROVED", event: "capture_observed", to: "CAPTURED", guard: "Same.", effect: "Same." },
      { from: "CAPTURING", event: "capture_observed", to: "CAPTURED", guard: "Authenticated capture matching payee, environment, currency and order.", effect: "Allocate to the obligation; issue CommercialAuthorization when every prerequisite binds." },
      { from: "CAPTURING", event: "capture_ambiguous", to: "CAPTURE_UNCERTAIN", guard: "The capture attempt became UNCERTAIN.", effect: "Discourage another payment; reconcile by provider identity." },
      { from: "CAPTURING", event: "capture_proved_no_effect", to: "APPROVED", guard: "Provider evidence proves no capture; the order is still approved.", effect: "The order remains payable." },
      { from: "CAPTURING", event: "capture_proved_no_effect_unapproved", to: "CREATED", guard: "Provider evidence proves no capture; the buyer approval is not current.", effect: "The buyer must approve again." },
      { from: "CAPTURE_UNCERTAIN", event: "capture_observed", to: "CAPTURED", guard: "Reconciliation found the exact capture.", effect: "Reuse the same order and financial event." },
      { from: "CAPTURE_UNCERTAIN", event: "reconciliation_proves_no_capture", to: "APPROVED", guard: "Reliable evidence excludes the capture; the order is still approved.", effect: "Document why a new attempt is safe." },
      { from: "CAPTURE_UNCERTAIN", event: "reconciliation_proves_no_capture_unapproved", to: "CREATED", guard: "Reliable evidence excludes the capture; the buyer approval is not current.", effect: "Same." },
      { from: "CREATED", event: "order_voided", to: "CANCELLED", guard: "Authenticated provider void or buyer cancellation; no capture possible.", effect: "Release the checkout slot." },
      { from: "APPROVED", event: "order_voided", to: "CANCELLED", guard: "Same.", effect: "Same." },
      { from: "CREATED", event: "order_expired", to: "EXPIRED", guard: "Authenticated provider expiry, or quote expiry after proving no capture is possible.", effect: "No capture under this order." },
      { from: "APPROVED", event: "order_expired", to: "EXPIRED", guard: "Same.", effect: "Same." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CaptureFact",
    initial: "PENDING",
    terminal: ["DENIED", "REVERSED"],
    transitions: [
      { from: "PENDING", event: "provider_completed", to: "COMPLETED", guard: "Authenticated completion of the same provider capture identity.", effect: "Fix the obligation allocation and the excess." },
      { from: "PENDING", event: "provider_denied", to: "DENIED", guard: "Authenticated denial.", effect: "No money was captured." },
      { from: "COMPLETED", event: "provider_reversed", to: "REVERSED", guard: "Authenticated reversal (chargeback) of the same capture identity; a capture first seen reversed, or reversed while known only as pending, completed at the provider and is recorded COMPLETED then REVERSED in one transaction (D-PAY-B5).", effect: "Revoke the authorization with its phase; reverse the unrefunded components; never charge again." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CommercialAuthorization",
    initial: "ACTIVE",
    terminal: ["REVOKED"],
    transitions: [
      { from: "ACTIVE", event: "execution_admitted", to: "CONSUMED", guard: "One logical job binds it (CMD036 ExecuteProject, package B08).", effect: "Technical retries and repairs reuse the same entitlement." },
      { from: "CONSUMED", event: "package_published", to: "DELIVERED", guard: "Atomic publication of the purchased package (package B08).", effect: "Delivery is recorded; history is kept." },
      { from: "ACTIVE", event: "authority_revoked", to: "REVOKED", guard: "Reversal or full service refund before execution, or the re-binding of the paid capture to its replacement quote under the included source replacement (SOURCE_REPLACED, D-QUOTE-B6).", effect: "Prevents launch (phase PRE_EXECUTION); a re-binding issues the replacement's entitlement in the same transaction." },
      { from: "CONSUMED", event: "authority_revoked", to: "REVOKED", guard: "Same, during execution.", effect: "Blocks new publication and opens reconciliation (phase DURING_EXECUTION)." },
      { from: "DELIVERED", event: "authority_revoked", to: "REVOKED", guard: "Same, after delivery.", effect: "Restricts further service; the delivered package and financial history remain (phase POST_DELIVERY)." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "Refund",
    initial: "REQUESTED",
    terminal: ["COMPLETED", "FAILED", "REJECTED"],
    transitions: [
      { from: "REQUESTED", event: "approve_refund", to: "APPROVED", guard: "A KAURO_OWNER with a fresh step-up or an applicable standing policy; amounts within the remaining capture (CMD032).", effect: "Record the immutable refund intent and commit its components." },
      { from: "REQUESTED", event: "reject_refund", to: "REJECTED", guard: "A reviewed KAURO_OWNER decision with a stated code.", effect: "No provider effect; the request remains history." },
      { from: "APPROVED", event: "dispatch_intent_committed", to: "SUBMITTING", guard: "A REFUND attempt becomes DISPATCHING; no earlier attempt of this refund is unreconciled (CMD033).", effect: "Submit once under the recorded provider request identity." },
      { from: "APPROVED", event: "authorization_lapsed", to: "FAILED", guard: "The capture can no longer be refunded (reversed) before any dispatch.", effect: "Release the committed components; no provider effect happened." },
      // Payments V1, manual bank-transfer rail only (DV1-08, ACH-ROUTE r12; the guards are the lanes', not this vocabulary's):
      // an owner-declared execution before any money moves, the window that lapses it, its recording and the owner's attested no-effect
      { from: "APPROVED", event: "manual_execution_declared", to: "SUBMITTING", guard: "BANK_TRANSFER refund only: the owner declares the execution (X1) and its attempt becomes DECLARED in the same transaction; no PaymentAttempt exists.", effect: "Send details are shown only after this commit; the reserved share stays held (NEVER-RESEND, one open attempt per source)." },
      { from: "SUBMITTING", event: "authenticated_completed", to: "COMPLETED", guard: "Authenticated provider refund with the exact amount and identity.", effect: "Keep the commitment; the credit note, commission and ledger consumers follow the event." },
      { from: "SUBMITTING", event: "ambiguous_transport_result", to: "UNCERTAIN", guard: "The attempt became UNCERTAIN.", effect: "No blind duplicate; reconcile by provider refund identity." },
      { from: "SUBMITTING", event: "proved_no_effect", to: "APPROVED", guard: "Provider evidence proves no refund happened for the attempt's request identity.", effect: "The same authorization allows a new deliberate attempt." },
      { from: "SUBMITTING", event: "provider_refused", to: "FAILED", guard: "Authenticated, definitive provider refusal of the refund.", effect: "Release the committed components; the owner chooses another lawful remedy." },
      { from: "SUBMITTING", event: "manual_execution_window_lapsed", to: "UNCERTAIN", guard: "BANK_TRANSFER refund only: the declared attempt passed its manual execution window on the database clock (X2).", effect: "The attempt becomes UNCERTAIN and an UNCERTAIN_EFFECT case opens; the share stays held." },
      { from: "SUBMITTING", event: "manual_return_recorded", to: "COMPLETED", guard: "BANK_TRANSFER refund only: classified execution evidence satisfies every record predicate of the DECLARED attempt (G2).", effect: "Same effects as a completion, once; the attempt becomes RECORDED." },
      { from: "UNCERTAIN", event: "manual_return_recorded", to: "COMPLETED", guard: "BANK_TRANSFER refund only: classified execution evidence satisfies every record predicate of the UNCERTAIN attempt (G2, or X3 EXECUTED).", effect: "Same effects as a completion, once; the attempt becomes RECORDED." },
      { from: "UNCERTAIN", event: "owner_attested_no_effect", to: "FAILED", guard: "BANK_TRANSFER refund only: the owner attests NOT_EXECUTED and the lag, coverage and no-potential-debit predicates hold (X3).", effect: "Release the committed components; the attempt becomes NOT_EXECUTED." },
      { from: "UNCERTAIN", event: "reconciliation_completed", to: "COMPLETED", guard: "Reconciliation found the exact refund.", effect: "Same effects as a completion, once." },
      { from: "UNCERTAIN", event: "reconciliation_proves_no_effect", to: "APPROVED", guard: "Reliable evidence excludes the refund.", effect: "A new deliberate attempt may follow." },
      { from: "UNCERTAIN", event: "reconciliation_proves_refusal", to: "FAILED", guard: "Reliable evidence shows the provider refused the refund.", effect: "Release the committed components." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "ReconciliationCase",
    initial: "OPEN",
    terminal: ["RESOLVED"],
    transitions: [{ from: "OPEN", event: "case_resolved", to: "RESOLVED", guard: "The exact difference is explained by facts or a reviewed decision.", effect: "The resolution is recorded; the facts stay." }],
    unlistedTransition: POLICY,
  },
  {
    contract: "PaymentRoute",
    initial: "CONFIGURED",
    terminal: ["SUSPENDED"],
    transitions: [
      { from: "CONFIGURED", event: "route_qualified", to: "QUALIFIED", guard: "Merchant eligibility, environment, capture, refund and settlement verified with evidence.", effect: "CreatePaymentOrder may use the route." },
      { from: "CONFIGURED", event: "route_suspended", to: "SUSPENDED", guard: "The route cannot be qualified.", effect: "A new route version is required." },
      { from: "QUALIFIED", event: "route_suspended", to: "SUSPENDED", guard: "An incident or account fact invalidates the route.", effect: "No new orders; existing ones are reconciled." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "FiscalIssuerRoute",
    initial: "CONFIGURED",
    terminal: ["SUSPENDED"],
    transitions: [
      { from: "CONFIGURED", event: "route_qualified", to: "QUALIFIED", guard: "Observed or professionally confirmed legal facts, a numbering authorization and verified issuance entitlement.", effect: "Checkout may rely on the issuance route." },
      { from: "CONFIGURED", event: "route_suspended", to: "SUSPENDED", guard: "The route cannot be qualified.", effect: "A new issuer route version is required." },
      { from: "QUALIFIED", event: "route_suspended", to: "SUSPENDED", guard: "An incident or legal fact invalidates the route.", effect: "No new sale relies on it." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "CorporateGrant",
    initial: "ACTIVE",
    terminal: ["REVOKED"],
    transitions: [{ from: "ACTIVE", event: "grant_revoked", to: "REVOKED", guard: "Authorized revocation.", effect: "Effective immediately for new commands; a command in flight is ordered before or after it." }],
    unlistedTransition: POLICY,
  },
  {
    contract: "RefundPolicy",
    initial: "ACTIVE",
    terminal: ["RETIRED"],
    transitions: [{ from: "ACTIVE", event: "policy_retired", to: "RETIRED", guard: "Authorized retirement.", effect: "No new approval may cite the policy; past approvals keep it." }],
    unlistedTransition: POLICY,
  },
]);

// --- Payments V1 bank-transfer machines (docs/design/ACH-ROUTE.md r12; lane KIT) --------------------------------------------------------------
//
// These machines are NOT in COMMERCE_PLATFORM_MACHINES and are not seeded into kauro.state_machines: the registry machine list is a closed
// set that existing persistence tests pin. Their edges are mirrored in kauro.bank_machine_edges (migration 0045; the persistence test proves
// the two equal) and enforced by the guard triggers of the lane that writes each table.
export const BANK_STATE_MACHINES: ReadonlyArray<StateMachine> = Object.freeze([
  {
    contract: "OutboundExecutionAttempt",
    initial: "DECLARED",
    terminal: ["RECORDED", "NOT_EXECUTED"],
    transitions: [
      { from: "DECLARED", event: "manual_execution_window_lapsed", to: "UNCERTAIN", guard: "effectNow >= declaredAt + manualExecutionWindow on the database clock (X2).", effect: "UNCERTAIN_EFFECT case; the reserved share or payable stays held." },
      { from: "DECLARED", event: "execution_recorded", to: "RECORDED", guard: "Every record predicate holds: E-ID, E-AMT, E-TIME, E-DEST, no E-DEST-CONFLICT, no E-REF-CONFLICT (G2, G4).", effect: "RETURN: refund completes; RESEND: payable settled." },
      { from: "DECLARED", event: "execution_not_executed", to: "NOT_EXECUTED", guard: "The owner attests no effect and NX-LAG, NX-COVERAGE, NX-NO-POTENTIAL hold and no execution offer exists (X3).", effect: "RETURN: refund FAILED owner_attested_no_effect, share released; RESEND: payable stays open." },
      { from: "UNCERTAIN", event: "execution_recorded", to: "RECORDED", guard: "Same predicates as DECLARED -> RECORDED (G2, G4, X3 EXECUTED).", effect: "Same." },
      { from: "UNCERTAIN", event: "execution_not_executed", to: "NOT_EXECUTED", guard: "Same predicates as DECLARED -> NOT_EXECUTED (X3).", effect: "Same." },
    ],
    unlistedTransition: POLICY,
  },
  {
    contract: "BankCredit",
    initial: "DRAFT_MANUAL",
    terminal: ["APPLIED"],
    transitions: [
      { from: "DRAFT_MANUAL", event: "credit_confirmed", to: "OBSERVED", guard: "Owner confirmation compares the stored, classified evidence with the draft (C6); a draft alone never creates money.", effect: "The credit is a durable observation." },
      { from: "OBSERVED", event: "credit_needs_review", to: "MATCH_REVIEW", guard: "Unknown, incomplete or mismatching identity (M1).", effect: "No agency is guessed." },
      { from: "OBSERVED", event: "credit_matched", to: "MATCHED", guard: "Exact reference, account, rail and payer rules hold (M1, M2).", effect: "The match records why." },
      { from: "MATCH_REVIEW", event: "credit_matched", to: "MATCHED", guard: "Approved attribution with independent evidence (M2).", effect: "The match records the decision." },
      { from: "MATCHED", event: "credit_returned_to_review", to: "MATCH_REVIEW", guard: "The bound payer authorization is no longer current at apply; no capture is written.", effect: "Back to review." },
      { from: "MATCHED", event: "credit_applied", to: "APPLIED", guard: "One COMMIT: capture, order edge, authority or blockers, link (P1).", effect: "The credit stays historical under later fee, funds and return observations." },
      { from: "MATCH_REVIEW", event: "credit_return_review_opened", to: "RETURN_REVIEW", guard: "A verified unassigned return of the credit.", effect: "The refund workflow becomes the source of return status." },
    ],
    unlistedTransition: POLICY,
  },
]);

/**
 * The PaymentOrder states and edges D-ACH-05 and DV1-06 add for routeKind BANK_TRANSFER. DELIBERATELY NOT WIRED into the PaymentOrder
 * platform machine: that machine's states are pinned to the vendored registry contract (commerce-machines-events.test.ts), its terminal
 * states are closed (EXPIRED -> CAPTURED, the late-honoring edge, leaves one) and its states must equal COMMERCE_STATE_EVENT_TYPES. Wiring
 * it needs a registry amendment and three existing assertions changed; that is the coordinator's decision (see the lane report). Until then
 * this is the single data source the lanes read; migration 0045 mirrors it in kauro.bank_machine_edges as machine 'PaymentOrderBank'.
 */
export const BANK_ORDER_EXTENSION: ReadonlyArray<{ readonly from: string; readonly event: string; readonly to: string }> = Object.freeze([
  { from: "INTENT_CREATED", event: "instructions_issued", to: "AWAITING_TRANSFER" },
  { from: "AWAITING_TRANSFER", event: "partial_credit_applied", to: "PARTIALLY_RECEIVED" },
  { from: "AWAITING_TRANSFER", event: "exact_credit_applied", to: "CAPTURED" },
  { from: "AWAITING_TRANSFER", event: "non_exact_receipt_closed", to: "RECEIVED_REVIEW" },
  { from: "AWAITING_TRANSFER", event: "transfer_deadline_reached", to: "EXPIRED" },
  { from: "AWAITING_TRANSFER", event: "transfer_checkout_retired", to: "EXPIRED" },
  { from: "AWAITING_TRANSFER", event: "on_time_credit_applied_late", to: "CAPTURED" },
  { from: "PARTIALLY_RECEIVED", event: "additional_partial_applied", to: "PARTIALLY_RECEIVED" },
  { from: "PARTIALLY_RECEIVED", event: "non_exact_receipt_closed", to: "RECEIVED_REVIEW" },
  { from: "PARTIALLY_RECEIVED", event: "transfer_deadline_reached", to: "EXPIRED" },
  { from: "PARTIALLY_RECEIVED", event: "transfer_checkout_retired", to: "EXPIRED" },
  { from: "EXPIRED", event: "on_time_credit_applied_late", to: "CAPTURED" },
]);
