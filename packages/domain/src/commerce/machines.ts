/**
 * Platform state machines of the payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §4.2). The
 * registry lists the machines PaymentAttempt and TaxDocument; those are used exactly as vendored (model/state-machines resolves
 * them from STATE_MACHINES). The registry contracts Quote (07 "Quote and checkout states" names its states), PaymentOrder,
 * CaptureFact, Refund and CommercialAuthorization carry states without a machine, and the platform records (payment routes,
 * fiscal issuer routes, corporate grants, standing refund policies, reconciliation cases) need one; decisions D-MACH-B1..B10
 * declare them here in the registry's own shape and under the registry's unlisted-transition policy — exactly as B06 declared
 * EndClient and Project (D-AGG-1, D-AGG-2) — and migrations 0008..0012 seed exactly the same initial states and edges into
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
      { from: "ISSUED", event: "accept_terms_for_checkout", to: "ACCEPTED_FOR_CHECKOUT", guard: "The agency names the exact termsHash inside CreatePaymentOrder (CMD028) and checkout is ready.", effect: "The accepted terms govern every order of this quote." },
      { from: "ISSUED", event: "price_expiry_reached", to: "EXPIRED", guard: "Server time passed expiresAt.", effect: "Checkout is blocked; a new quote is required." },
      { from: "ISSUED", event: "superseding_quote_issued", to: "SUPERSEDED", guard: "A new binding quote names this one.", effect: "The old offer stops; its reservation does not extend." },
      { from: "ISSUED", event: "withdraw_quote", to: "WITHDRAWN", guard: "Authorized billing or corporate actor.", effect: "The offer stops." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "price_expiry_reached", to: "EXPIRED", guard: "No capture completed, in flight or uncertain (16 Founding incentive).", effect: "Checkout is blocked; only a proven absence of capture releases what the quote reserved." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "superseding_quote_issued", to: "SUPERSEDED", guard: "No capture completed; pending attempts reconciled first.", effect: "The previous unpaid offer is superseded explicitly." },
      { from: "ACCEPTED_FOR_CHECKOUT", event: "withdraw_quote", to: "WITHDRAWN", guard: "No capture completed, in flight or uncertain.", effect: "The offer stops." },
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
      { from: "PENDING", event: "provider_reversed", to: "REVERSED", guard: "The next authenticated observation after pending is already a reversal.", effect: "Record the reversal; no authority." },
      { from: "COMPLETED", event: "provider_reversed", to: "REVERSED", guard: "Authenticated reversal (chargeback) of the same capture identity.", effect: "Revoke the authorization with its phase; reverse the unrefunded components; never charge again." },
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
      { from: "ACTIVE", event: "authority_revoked", to: "REVOKED", guard: "Reversal or full service refund before execution.", effect: "Prevents launch (phase PRE_EXECUTION)." },
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
      { from: "SUBMITTING", event: "authenticated_completed", to: "COMPLETED", guard: "Authenticated provider refund with the exact amount and identity.", effect: "Keep the commitment; the credit note, commission and ledger consumers follow the event." },
      { from: "SUBMITTING", event: "ambiguous_transport_result", to: "UNCERTAIN", guard: "The attempt became UNCERTAIN.", effect: "No blind duplicate; reconcile by provider refund identity." },
      { from: "SUBMITTING", event: "proved_no_effect", to: "APPROVED", guard: "Provider evidence proves no refund happened for the attempt's request identity.", effect: "The same authorization allows a new deliberate attempt." },
      { from: "SUBMITTING", event: "provider_refused", to: "FAILED", guard: "Authenticated, definitive provider refusal of the refund.", effect: "Release the committed components; the owner chooses another lawful remedy." },
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
