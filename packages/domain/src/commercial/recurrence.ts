/**
 * The buyer's recurrence and founding decisions (16 "Recurrence decision", "Founding incentive", "Quote calculation"; design
 * D10-REC-1, D10-FOUND-3, D10-QUOTE-1; examples 2, 3, 4, 5 and 17). The buyer's discount is decided here from the agency's
 * qualifying history at the quote's issuance instant; the seller's residual is decided apart, from the entitlement's window and the
 * verified provider completion (commercial/time.ts acquisitionRate): example 3's two clocks, never one `isRecurring` flag.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CaptureStatus } from "../commerce/records.js";
import { lookbackStartsAt, selectDiscount, type PricePolicy } from "../commerce/pricing.js";
import { assertMoney } from "../commerce/money.js";
import type { AgencyId, ProjectId } from "../model/ids.js";
import { assertCanonicalInstant } from "./calendar.js";
import type { BuyerType, FoundingOffer } from "./records.js";

/** The facts of one qualifying purchase the eligibility set reads (qualifying_purchases joined to its capture and refunds). */
export interface QualifyingPurchaseFacts {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly confirmedAt: UtcInstant;
  /** The capture's allocated service. */
  readonly allocatedServiceCents: bigint;
  /** The sum of the capture's COMPLETED refunds' service components. */
  readonly completedServiceRefundCents: bigint;
  readonly captureStatus: CaptureStatus;
}

/** A purchase's remaining service basis: allocated service less completed service refunds, zero once the capture is REVERSED. */
export function remainingServiceBasis(p: Pick<QualifyingPurchaseFacts, "allocatedServiceCents" | "completedServiceRefundCents" | "captureStatus">): bigint {
  assertMoney(p.allocatedServiceCents);
  assertMoney(p.completedServiceRefundCents);
  if (p.completedServiceRefundCents > p.allocatedServiceCents) throw new RangeError("completed service refunds exceed the allocated service");
  if (p.captureStatus === "REVERSED") return 0n;
  if (p.captureStatus !== "COMPLETED") throw new RangeError("a qualifying purchase's capture is COMPLETED or REVERSED");
  return p.allocatedServiceCents - p.completedServiceRefundCents;
}

/**
 * The domain mirror of `kauro.qualifying_projects_at(agency, as_of, project)` (D10-REC-1), the one definition being the SQL
 * function: the distinct projects of the agency, other than the quoted one, with a qualifying purchase confirmed in
 * [as_of - 8760 h, as_of) whose remaining service basis is positive. Whatever the end client (R2-086); one count per project however
 * many purchases (R2-087); a fully refunded or reversed purchase leaves the set while its designation stays (R2-089). Ascending ids.
 */
export function qualifyingProjectsAt(purchases: ReadonlyArray<QualifyingPurchaseFacts>, at: { readonly agencyId: AgencyId; readonly asOf: UtcInstant; readonly projectId: ProjectId }): ReadonlyArray<ProjectId> {
  const asOf = assertCanonicalInstant(at.asOf, "asOf");
  const from = asOf - 8760 * 3_600_000;
  const set = new Set<ProjectId>();
  for (const p of purchases) {
    const confirmed = assertCanonicalInstant(p.confirmedAt, "confirmedAt");
    if (p.agencyId !== at.agencyId || p.projectId === at.projectId) continue;
    if (confirmed < from || confirmed >= asOf) continue;
    if (remainingServiceBasis(p) > 0n) set.add(p.projectId);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Why an agency is not founding-eligible (D10-FOUND-3). */
export type FoundingIneligibility = "QUALIFYING_PURCHASE_EXISTS" | "COHORT_RESERVATION_EXISTS" | "BUYER_TYPE_UNSET";

/**
 * Founding eligibility (D10-FOUND-1, D10-FOUND-3; A3 3.7): no qualifying purchase, no founding reservation of the agency in the
 * cohort ever (no revival, example 16), and a recorded buyer type of either value (agencies and admitted in-house tenants alike).
 */
export function foundingEligibility(facts: { readonly hasQualifyingPurchase: boolean; readonly hasCohortReservation: boolean; readonly buyerType: BuyerType | null }): { readonly eligible: true } | { readonly eligible: false; readonly reason: FoundingIneligibility } {
  if (facts.buyerType === null) return { eligible: false, reason: "BUYER_TYPE_UNSET" };
  if (facts.hasQualifyingPurchase) return { eligible: false, reason: "QUALIFYING_PURCHASE_EXISTS" };
  if (facts.hasCohortReservation) return { eligible: false, reason: "COHORT_RESERVATION_EXISTS" };
  return { eligible: true };
}

/** The eligibility facts a quote snapshot records (registry PriceEligibilitySnapshot plus the founding offer; §3.4). */
export interface QuoteEligibility {
  readonly asOf: UtcInstant;
  readonly lookbackStartsAt: UtcInstant;
  readonly qualifyingProjectIds: ReadonlyArray<ProjectId>;
  readonly qualifyingCount: number;
  readonly repeatDiscountBps: number;
  readonly foundingOffer: FoundingOffer;
  readonly foundingDiscountBps: number;
  /** The maximum eligible rate, never a sum (MAX_NOT_STACKED). */
  readonly appliedDiscountBps: number;
  readonly policyVersion: string;
}

/**
 * The buyer's discount at a quote's issuance instant (16 "Recurrence decision"; R2-086..R2-088): the tier of the snapshot's
 * distinct qualifying set (0 / 1–9 / 10–24 / 25+ → 0 / 500 / 1000 / 1500 bps, policy repeatTiers) and the founding rate only with a
 * reserved slot, the applied rate their maximum (example 17: the unsuccessful contender is quoted at its own tier, NONE_AVAILABLE).
 */
export function quoteEligibility(prices: PricePolicy, facts: { readonly asOf: UtcInstant; readonly qualifyingProjectIds: ReadonlyArray<ProjectId>; readonly founding: { readonly eligible: boolean; readonly slotReserved: boolean } }): QuoteEligibility {
  assertCanonicalInstant(facts.asOf, "asOf");
  if (new Set(facts.qualifyingProjectIds).size !== facts.qualifyingProjectIds.length) throw new RangeError("the qualifying set names each project once");
  if (facts.founding.slotReserved && !facts.founding.eligible) throw new RangeError("a founding slot is reserved only for an eligible agency");
  const selection = selectDiscount(prices, { qualifyingCount: facts.qualifyingProjectIds.length, foundingSlotReserved: facts.founding.slotReserved });
  const foundingOffer: FoundingOffer = !facts.founding.eligible ? "NOT_ELIGIBLE" : facts.founding.slotReserved ? "RESERVED" : "NONE_AVAILABLE";
  return {
    asOf: facts.asOf,
    lookbackStartsAt: lookbackStartsAt(prices, facts.asOf),
    qualifyingProjectIds: [...facts.qualifyingProjectIds],
    qualifyingCount: facts.qualifyingProjectIds.length,
    repeatDiscountBps: selection.repeatDiscountBps,
    foundingOffer,
    foundingDiscountBps: selection.foundingDiscountBps,
    appliedDiscountBps: selection.appliedDiscountBps,
    policyVersion: prices.version,
  };
}
