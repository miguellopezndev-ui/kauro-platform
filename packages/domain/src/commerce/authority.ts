/**
 * Commercial authority predicates (07 "Quote and checkout states": checkout readiness is a derived predicate — valid quote,
 * current approved plan, available immutable data, usable legal/PSP/fiscal configuration, agency capability and deliverable
 * capacity; a fourteen-day price lifetime does not extend seven-day source retention. 07 "CommercialAuthorization": every
 * prerequisite binds the same source and policy. 15 "Price and source expiry races". S060: a price-valid quote whose source was
 * deleted blocks checkout).
 *
 * The facts are read by the command inside its unit of work (row locks where the command edits); these functions only decide.
 * Every blocker is a stable token (QuoteView.checkoutBlockers) and maps to the failure a command answers (`blockerFailure`).
 * The order of the list is the order of the checks: the first blocker is the answer of a command.
 */
import type { Capability, UtcInstant } from "@kauro/contracts";
import type { AgencyState } from "../model/agency.js";
import type { PlanRecord } from "../model/aggregates.js";
import { OFFERED_CAPABILITY_STATES } from "../model/aggregates.js";
import { DomainFailure, type FailureCode, type FailureReason } from "../model/errors.js";
import { instantMs } from "../model/fields.js";
import { quotableTaxRule, sameTaxRule } from "./fiscal.js";
import type { CommercialAuthorizationRecord, DeliveryPhase, FiscalProfileRecord, PaymentOrderState, QuoteRecord, RevocationPhase, RouteState } from "./records.js";

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
  "PAYMENT_ROUTE_UNQUALIFIED",
  "FISCAL_ROUTE_UNQUALIFIED",
  "FISCAL_TREATMENT_UNREVIEWED",
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
  /** The revision whose manifest hash is the quoted revisionHash (null when none exists any more). */
  readonly revision: { readonly state: string } | null;
  /** The target contract whose body hash is the quoted targetContractHash. */
  readonly target: { readonly confirmed: boolean; readonly superseded: boolean } | null;
  /** The mode capability of the project. */
  readonly capability: Pick<Capability, "state"> | null;
}

/** Checkout adds the payment and fiscal routes, the current fiscal profile and the payment state of the project. */
export interface CheckoutFacts extends SubjectFacts {
  readonly paymentRoute: { readonly state: RouteState } | null;
  readonly fiscalIssuerRoute: { readonly state: RouteState } | null;
  readonly fiscalProfile: FiscalProfileRecord | null;
  /** The open (non-terminal) payment order of the project, if any. */
  readonly openOrder: { readonly state: PaymentOrderState } | null;
  /** True when a live CommercialAuthorization already exists for this quote. */
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
  if (f.paymentRoute === null || f.paymentRoute.state !== "QUALIFIED") out.push("PAYMENT_ROUTE_UNQUALIFIED");
  if (f.fiscalIssuerRoute === null || f.fiscalIssuerRoute.state !== "QUALIFIED") out.push("FISCAL_ROUTE_UNQUALIFIED");
  const rule = quotableTaxRule(f.fiscalProfile, f.now);
  if (rule.kind === "BLOCKED" || !sameTaxRule(rule.snapshot, f.quote.tax)) out.push("FISCAL_TREATMENT_UNREVIEWED");
  return out;
}

/**
 * The prerequisites a completed capture must still meet for the server to create the CommercialAuthorization in the same
 * transaction (07 "CommercialAuthorization"; transitions "Cross-aggregate finalization": capture confirmation can create
 * financial facts even when source expiry prevents execution). Price expiry is not a blocker here: a capture completed after
 * the price expiry is honored when the same scope is still valid (07 "Quote and checkout states"), and the authorization
 * records it (`honoredAfterPriceExpiry`). Fiscal treatment is not a blocker either: TaxDocument is independent of payment
 * confirmation (07 "Aggregate ownership"; R2-128 "preserving capture reconciliation").
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

const BLOCKER_FAILURE: Readonly<Record<CheckoutBlocker, { readonly code: FailureCode; readonly reason: FailureReason }>> = Object.freeze({
  AGENCY_NOT_ACTIVE: { code: "PRECONDITION_FAILED", reason: "AGENCY_NOT_ACTIVE" },
  QUOTE_NOT_ACTIVE: { code: "PRECONDITION_FAILED", reason: "QUOTE_NOT_ACTIVE" },
  QUOTE_EXPIRED: { code: "PRECONDITION_FAILED", reason: "QUOTE_EXPIRED" },
  ALREADY_PAID: { code: "PRECONDITION_FAILED", reason: "ALREADY_PAID" },
  PAYMENT_UNCERTAIN: { code: "PAYMENT_UNCERTAIN", reason: "CAPTURE_UNCERTAIN" },
  PAYMENT_IN_PROGRESS: { code: "PAYMENT_PENDING", reason: "CAPTURE_IN_PROGRESS" },
  SOURCE_EXPIRED: { code: "SOURCE_EXPIRED", reason: "REVISION_NOT_AVAILABLE" },
  APPROVAL_NOT_CURRENT: { code: "PRECONDITION_FAILED", reason: "APPROVAL_NOT_CURRENT" },
  TARGET_STALE: { code: "TARGET_STALE", reason: "HASH_MISMATCH" },
  CAPABILITY_RESTRICTED: { code: "CAPABILITY_UNAVAILABLE", reason: "MODE_NOT_OFFERED" },
  PAYMENT_ROUTE_UNQUALIFIED: { code: "CAPABILITY_UNAVAILABLE", reason: "PAYMENT_ROUTE_UNQUALIFIED" },
  FISCAL_ROUTE_UNQUALIFIED: { code: "CAPABILITY_UNAVAILABLE", reason: "FISCAL_ROUTE_UNQUALIFIED" },
  FISCAL_TREATMENT_UNREVIEWED: { code: "PRECONDITION_FAILED", reason: "FISCAL_TREATMENT_UNREVIEWED" },
});

/** The failure a command answers for its first blocker (PAYMENT_PENDING is the one retryable answer). */
export function blockerFailure(blocker: CheckoutBlocker): DomainFailure {
  const f = BLOCKER_FAILURE[blocker];
  return new DomainFailure(f.code, `commercial prerequisite not met: ${blocker}`, { reason: f.reason });
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
