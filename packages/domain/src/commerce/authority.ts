/**
 * Commercial authority predicates (07 "Quote and checkout states": checkout readiness is a derived predicate — valid quote,
 * current approved plan, available immutable data, usable legal/PSP/fiscal configuration, agency capability and deliverable
 * capacity; a fourteen-day price lifetime does not extend seven-day source retention. 07 "CommercialAuthorization": every
 * prerequisite binds the same source and policy. 15 "Price and source expiry races". S060: a price-valid quote whose source was
 * deleted blocks checkout).
 *
 * The facts are read by the command inside its unit of work — the rows it edits under row locks, the facts it relies on without
 * changing them after their transition locks (B06 D-TX-2) — and these functions only decide. Every blocker is a stable token
 * (QuoteView.checkoutBlockers) and maps to the failure a command answers (`blockerFailure`). The order of the list is the order
 * of the checks: the first blocker is the answer of a command.
 */
import type { Capability, UtcInstant } from "@kauro/contracts";
import type { AgencyState } from "../model/agency.js";
import type { PlanRecord } from "../model/aggregates.js";
import { OFFERED_CAPABILITY_STATES } from "../model/aggregates.js";
import { DomainFailure, type FailureCode, type FailureReason } from "../model/errors.js";
import { instantMs } from "../model/fields.js";
import { quotableTaxRule, sameTaxRule } from "./fiscal.js";
import type { CaptureFactRecord, CommercialAuthorizationRecord, DeliveryPhase, FiscalProfileRecord, PaymentOrderState, QuoteRecord, RefundComponents, RevocationPhase, RouteState } from "./records.js";

export const CHECKOUT_BLOCKERS = [
  "AGENCY_NOT_ACTIVE",
  "QUOTE_NOT_ACTIVE",
  "QUOTE_EXPIRED",
  "ALREADY_PAID",
  "PAYMENT_UNCERTAIN",
  "PAYMENT_IN_PROGRESS",
  "SOURCE_EXPIRED",
  "APPROVAL_NOT_CURRENT",
  "TARGET_STALE",
  "CAPABILITY_RESTRICTED",
  "DELIVERY_CAPACITY_UNAVAILABLE",
  "PAYMENT_ROUTE_UNQUALIFIED",
  "FISCAL_ROUTE_UNQUALIFIED",
  "FISCAL_TREATMENT_UNREVIEWED",
  "FISCAL_TREATMENT_CHANGED",
] as const;
export type CheckoutBlocker = (typeof CHECKOUT_BLOCKERS)[number];

/** The purchased subject as the command read it: the agency, plan, approval, sealed source, target and capability. */
export interface SubjectFacts {
  readonly now: UtcInstant;
  readonly quote: Pick<QuoteRecord, "state" | "expiresAt" | "approvalId" | "planHash" | "revisionHash" | "targetContractHash" | "tax">;
  readonly agencyState: AgencyState;
  /** The quoted plan revision (null when not visible). */
  readonly plan: Pick<PlanRecord, "state" | "approvalId" | "bodyHash"> | null;
  /** The quoted approval (null when not visible). */
  readonly approval: { readonly withdrawnAt?: UtcInstant } | null;
  /** The revision of the quoted project whose manifest hash is the quoted revisionHash (null when none exists any more). */
  readonly revision: { readonly state: string } | null;
  /** The target contract of the quoted project whose body hash is the quoted targetContractHash. */
  readonly target: { readonly confirmed: boolean; readonly superseded: boolean } | null;
  /** The project's own capability (the one its creation snapshotted and a CommercialAuthorization binds). */
  readonly capability: Pick<Capability, "state"> | null;
}

/**
 * Checkout adds the payment and fiscal routes, the current fiscal profile, the payment state of the project and the deliverable
 * capacity the processing package's admission reports for the purchased scope (15 "PaymentOrder and intent": "CreatePaymentOrder
 * first validates the exact quote, approved plan, source availability, capacity, legal profile and agency billing authority"; 07
 * "Payment readiness accounts for realistic delivery capacity; the system does not take unlimited purchases into an unbounded
 * queue"; D-CAP-B1). The capacity is read through the DeliveryCapacityPort, whose adapter is B08's admission; null (no answer)
 * blocks like an explicit refusal.
 */
export interface CheckoutFacts extends SubjectFacts {
  readonly capacity: { readonly available: boolean } | null;
  readonly paymentRoute: { readonly state: RouteState } | null;
  readonly fiscalIssuerRoute: { readonly state: RouteState } | null;
  readonly fiscalProfile: FiscalProfileRecord | null;
  /** The open (non-terminal) payment order of the project, if any. */
  readonly openOrder: { readonly state: PaymentOrderState } | null;
  /** True when a CommercialAuthorization already exists for this quote, or a completed capture already pays an order of it. */
  readonly paid: boolean;
}

function subjectBlockers(f: SubjectFacts): CheckoutBlocker[] {
  const out: CheckoutBlocker[] = [];
  // source: only a SEALED revision is executable; EXPIRED, DELETED, SUPERSEDED, ... never come back (07 "SourceRevision")
  if (f.revision === null || f.revision.state !== "SEALED") out.push("SOURCE_EXPIRED");
  // approval: the quoted plan is still APPROVED under the quoted, unwithdrawn approval and the quoted body
  const approvalCurrent =
    f.plan !== null && f.plan.state === "APPROVED" && f.plan.approvalId === f.quote.approvalId && f.plan.bodyHash === f.quote.planHash &&
    f.approval !== null && f.approval.withdrawnAt === undefined;
  if (!approvalCurrent) out.push("APPROVAL_NOT_CURRENT");
  if (f.target === null || !f.target.confirmed || f.target.superseded) out.push("TARGET_STALE");
  if (f.capability === null || !OFFERED_CAPABILITY_STATES.has(f.capability.state)) out.push("CAPABILITY_RESTRICTED");
  return out;
}

/**
 * Checkout readiness (CMD028 precondition "Price and source are independently valid, approval remains exact, live
 * merchant/fiscal route is qualified and charge terms are accepted"; CMD029 precondition "still-valid commercial
 * prerequisites"). An empty list means ready.
 */
export function checkoutBlockers(f: CheckoutFacts): ReadonlyArray<CheckoutBlocker> {
  const out: CheckoutBlocker[] = [];
  if (f.agencyState !== "ACTIVE") out.push("AGENCY_NOT_ACTIVE");
  if (f.quote.state !== "ISSUED" && f.quote.state !== "ACCEPTED_FOR_CHECKOUT") out.push("QUOTE_NOT_ACTIVE");
  else if (instantMs(f.now) >= instantMs(f.quote.expiresAt)) out.push("QUOTE_EXPIRED");
  if (f.paid) out.push("ALREADY_PAID");
  else if (f.openOrder !== null && f.openOrder.state === "CAPTURE_UNCERTAIN") out.push("PAYMENT_UNCERTAIN");
  else if (f.openOrder !== null && (f.openOrder.state === "INTENT_CREATED" || f.openOrder.state === "CREATING" || f.openOrder.state === "CAPTURING")) out.push("PAYMENT_IN_PROGRESS");
  out.push(...subjectBlockers(f));
  if (f.capacity === null || !f.capacity.available) out.push("DELIVERY_CAPACITY_UNAVAILABLE");
  if (f.paymentRoute === null || f.paymentRoute.state !== "QUALIFIED") out.push("PAYMENT_ROUTE_UNQUALIFIED");
  if (f.fiscalIssuerRoute === null || f.fiscalIssuerRoute.state !== "QUALIFIED") out.push("FISCAL_ROUTE_UNQUALIFIED");
  const rule = quotableTaxRule(f.fiscalProfile, f.now);
  if (rule.kind === "BLOCKED") out.push("FISCAL_TREATMENT_UNREVIEWED");
  else if (!sameTaxRule(rule.snapshot, f.quote.tax)) out.push("FISCAL_TREATMENT_CHANGED");
  return out;
}

/**
 * The prerequisites a completed capture must still meet for the server to create the CommercialAuthorization in the same
 * transaction (07 "CommercialAuthorization"; TRANSITIONS "Cross-aggregate finalization": capture confirmation can create
 * financial facts even when source expiry prevents execution). Price expiry is not a blocker here: a capture completed after
 * the price expiry is honored when the same scope is still valid (07 "Quote and checkout states"; 15 "Price and source expiry
 * races"), and the authorization records it (`honoredAfterPriceExpiry`). Fiscal treatment is not a blocker either: TaxDocument
 * is independent of payment confirmation (07 "Aggregate ownership"; R2-128 "preserving capture reconciliation").
 */
export function authorizationBlockers(f: SubjectFacts): ReadonlyArray<CheckoutBlocker> {
  const out: CheckoutBlocker[] = [];
  if (f.agencyState !== "ACTIVE") out.push("AGENCY_NOT_ACTIVE");
  if (f.quote.state !== "ACCEPTED_FOR_CHECKOUT") out.push("QUOTE_NOT_ACTIVE");
  out.push(...subjectBlockers(f));
  return out;
}

export function honoredAfterPriceExpiry(quote: Pick<QuoteRecord, "expiresAt">, providerCompletedAt: UtcInstant): boolean {
  return instantMs(providerCompletedAt) >= instantMs(quote.expiresAt);
}

const BLOCKER_FAILURE: Readonly<Record<CheckoutBlocker, { readonly code: FailureCode; readonly reason: FailureReason | null }>> = Object.freeze({
  AGENCY_NOT_ACTIVE: { code: "PRECONDITION_FAILED", reason: "AGENCY_NOT_ACTIVE" },
  QUOTE_NOT_ACTIVE: { code: "PRECONDITION_FAILED", reason: "QUOTE_NOT_ACTIVE" },
  QUOTE_EXPIRED: { code: "PRECONDITION_FAILED", reason: "QUOTE_EXPIRED" },
  ALREADY_PAID: { code: "PRECONDITION_FAILED", reason: "ALREADY_PAID" },
  PAYMENT_UNCERTAIN: { code: "PAYMENT_UNCERTAIN", reason: "CAPTURE_UNCERTAIN" },
  PAYMENT_IN_PROGRESS: { code: "PAYMENT_PENDING", reason: "CAPTURE_IN_PROGRESS" },
  SOURCE_EXPIRED: { code: "SOURCE_EXPIRED", reason: null },
  APPROVAL_NOT_CURRENT: { code: "PRECONDITION_FAILED", reason: "APPROVAL_NOT_CURRENT" },
  TARGET_STALE: { code: "TARGET_STALE", reason: null },
  CAPABILITY_RESTRICTED: { code: "CAPABILITY_UNAVAILABLE", reason: "MODE_NOT_OFFERED" },
  DELIVERY_CAPACITY_UNAVAILABLE: { code: "CAPACITY_UNAVAILABLE", reason: "DELIVERY_CAPACITY_UNAVAILABLE" },
  PAYMENT_ROUTE_UNQUALIFIED: { code: "CAPABILITY_UNAVAILABLE", reason: "PAYMENT_ROUTE_UNQUALIFIED" },
  FISCAL_ROUTE_UNQUALIFIED: { code: "CAPABILITY_UNAVAILABLE", reason: "FISCAL_ROUTE_UNQUALIFIED" },
  FISCAL_TREATMENT_UNREVIEWED: { code: "PRECONDITION_FAILED", reason: "FISCAL_TREATMENT_UNREVIEWED" },
  FISCAL_TREATMENT_CHANGED: { code: "PRECONDITION_FAILED", reason: "FISCAL_TREATMENT_CHANGED" },
});

/** The failure a command answers for its first blocker (PAYMENT_PENDING and CAPACITY_UNAVAILABLE are the retryable answers). */
export function blockerFailure(blocker: CheckoutBlocker): DomainFailure {
  const f = BLOCKER_FAILURE[blocker];
  return new DomainFailure(f.code, `commercial prerequisite not met: ${blocker}`, f.reason === null ? {} : { reason: f.reason }, f.code === "PAYMENT_PENDING" || f.code === "CAPACITY_UNAVAILABLE");
}

/** What the quote's release guard reads (migration 0016 kauro.quotes_release_guard; D-QUOTE-B4, B09-F2). */
export interface QuoteReleaseFacts {
  /** An order of the quote CREATING, CAPTURING or CAPTURE_UNCERTAIN, a PENDING capture of it, or a live CREATE_ORDER/CAPTURE attempt. */
  readonly paymentInFlight: boolean;
  /** An entitlement of the quote that is not REVOKED. */
  readonly liveAuthorization: boolean;
  /** Every capture paying the quote (its orders' captures and a capture re-bound to it) with what its COMPLETED refunds returned. */
  readonly captures: ReadonlyArray<{ readonly status: CaptureFactRecord["status"]; readonly allocation: RefundComponents; readonly returned: RefundComponents }>;
  /** The replacement a re-binding of this quote's purchase names, if any (D-QUOTE-B6). */
  readonly reboundTo: QuoteRecord["quoteId"] | null;
}

export type QuoteRelease = { readonly kind: "RELEASABLE" } | { readonly kind: "BLOCKED"; readonly because: "PAYMENT_IN_FLIGHT" | "PURCHASE_STANDS" };

/**
 * Whether an ACCEPTED_FOR_CHECKOUT quote may leave for EXPIRED, SUPERSEDED or WITHDRAWN (Quote machine guards; D-QUOTE-B4): never
 * while its payment is in flight or uncertain; to SUPERSEDED by exactly the replacement its purchase was re-bound to; otherwise
 * only once the purchase is closed — no live entitlement and every completed capture's whole service and tax returned by completed
 * refunds (a reversed capture's money already went back). 15 "Price and source expiry races": "otherwise refund and issue a new
 * quote"; TRANSITIONS "Cross-aggregate finalization": "offer the documented reupload/reapproval or refund path".
 */
export function quoteRelease(f: QuoteReleaseFacts, target: { readonly state: "EXPIRED" | "SUPERSEDED" | "WITHDRAWN"; readonly supersededBy?: QuoteRecord["quoteId"] }): QuoteRelease {
  if (f.paymentInFlight) return { kind: "BLOCKED", because: "PAYMENT_IN_FLIGHT" };
  if (target.state === "SUPERSEDED" && f.reboundTo !== null && target.supersededBy === f.reboundTo) return { kind: "RELEASABLE" };
  if (f.liveAuthorization) return { kind: "BLOCKED", because: "PURCHASE_STANDS" };
  const stands = f.captures.some((c) => c.status === "COMPLETED" && (c.returned.serviceCents < c.allocation.serviceCents || c.returned.taxCents < c.allocation.taxCents));
  return stands ? { kind: "BLOCKED", because: "PURCHASE_STANDS" } : { kind: "RELEASABLE" };
}

/** What the re-binding guard reads (migration 0015 kauro.purchase_rebindings_guard; D-QUOTE-B6). */
export interface ReplacementFacts {
  readonly authorizationState: CommercialAuthorizationRecord["state"];
  /** The capture is COMPLETED and alone pays its order's whole obligation with no excess. */
  readonly captureAlonePays: boolean;
  /** A refund of the capture awaits review or commits (REQUESTED, APPROVED, SUBMITTING, UNCERTAIN, COMPLETED). */
  readonly refundOpenOrCommitted: boolean;
  readonly replacedQuoteState: QuoteRecord["state"];
  readonly replacement: { readonly state: QuoteRecord["state"]; readonly replacesTheQuote: boolean };
  readonly replacementsUsed: number;
  /** price_policies.pre_execution_replacements_included of the replaced quote's policy (R2-INITIAL: 1). */
  readonly replacementsIncluded: number;
  /** The replacement revision is SEALED and its lineage in the project reaches the replaced revision (SourceLineageReader, B07). */
  readonly lineageReachesReplaced: boolean;
}

export type ReplacementBlocker = "EXECUTION_STARTED" | "PURCHASE_NOT_INTACT" | "NOT_A_REPLACEMENT" | "ALLOWANCE_USED" | "LINEAGE_MISSING";

/**
 * The included pre-execution source replacement (16 "Scope changes and credits": one replacement after revalidation, provided no
 * paid execution has started and the new scope stays in the same band — the same band and terms are the replacement quote's
 * composite key to the replaced one; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18). An empty list means the paid capture may be re-bound.
 */
export function replacementBlockers(f: ReplacementFacts): ReadonlyArray<ReplacementBlocker> {
  const out: ReplacementBlocker[] = [];
  if (f.authorizationState !== "ACTIVE") out.push("EXECUTION_STARTED");
  if (!f.captureAlonePays || f.refundOpenOrCommitted) out.push("PURCHASE_NOT_INTACT");
  if (f.replacedQuoteState !== "ACCEPTED_FOR_CHECKOUT" || f.replacement.state !== "ISSUED" || !f.replacement.replacesTheQuote) out.push("NOT_A_REPLACEMENT");
  if (f.replacementsUsed >= f.replacementsIncluded) out.push("ALLOWANCE_USED");
  if (!f.lineageReachesReplaced) out.push("LINEAGE_MISSING");
  return out;
}

/** The phase a revocation happens in is the state it leaves (07 "CommercialAuthorization"). */
export function revocationPhaseOf(state: CommercialAuthorizationRecord["state"]): RevocationPhase {
  switch (state) {
    case "ACTIVE":
      return "PRE_EXECUTION";
    case "CONSUMED":
      return "DURING_EXECUTION";
    case "DELIVERED":
      return "POST_DELIVERY";
    case "REVOKED":
      throw new DomainFailure("PRECONDITION_FAILED", "the authorization is already revoked", { reason: "UNLISTED_TRANSITION" });
  }
}

/** The delivery phase a refund request records (CMD031 "delivery, terms and evidence references"). */
export function deliveryPhaseOf(authorization: Pick<CommercialAuthorizationRecord, "state" | "revocationPhase"> | null): DeliveryPhase {
  if (authorization === null) return "NO_AUTHORIZATION";
  if (authorization.state === "REVOKED") return authorization.revocationPhase ?? "PRE_EXECUTION";
  return revocationPhaseOf(authorization.state);
}
