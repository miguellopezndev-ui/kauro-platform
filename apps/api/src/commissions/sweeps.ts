/**
 * The commission service's sweeps (docs/design/B10-commercial-domain.md §3.3, §5, §6, §14; decisions D10-FOUND-4, D10-ATTR-2,
 * D10-ELIG-1, D10-HOLD-1, D10-CONS-1, D10-SVC-1..4): bounded passes over work the database finds due on its own clock
 * (kauro.server_now(), so a test stands a sweep at another instant only through the labelled TEST CLOCK). Each pass reads its work list
 * in a SERVICE unit of work of the commission service, then settles each item in a unit of work of its own that adopts the item's
 * agency (D10-CTX-1); an item that fails is reported and left for the next pass (fail closed), never retried inside the pass.
 *
 *  QUOTE_EXPIRY            a live founding reservation whose end has passed (0033): its quote EXPIRED through B09's price_expiry_reached
 *                          and the reservation RELEASED with its slot; while B09's release guard refuses the expiry (a payment in flight
 *                          or uncertain) the reservation is held in RECONCILIATION_HOLD, which the capture's designation consumes or a
 *                          later pass — once nothing is in flight — releases (D10-FOUND-4, R2-127). A quote without a reservation
 *                          needs no sweep: B09 refuses its checkout past its expiry on the server's clock.
 *  ACCRUAL_RECONCILIATION  for each agency with an ACCEPTED claim or a live entitlement: the claims a first purchase lets convert,
 *                          then each purchase lacking the pools of an applicable entitlement accrued at the capture's current basis
 *                          (an acceptance after the first purchase; D10-SVC-2).
 *  CLAIM_WINDOWS           live claims past their review deadline, acceptance window or tail: EXPIRED — an ACCEPTED claim whose
 *                          agency's first purchase lets it convert converts instead.
 *  ENTITLEMENT_WINDOWS     entitlements whose window has ended: EXPIRED; their earned lines are untouched.
 *  ELIGIBILITY             the completions of purchases still awaiting a FINAL one, asked of PreparationCompletionSource; funds holds
 *                          whose capture's funds became AVAILABLE released; due lines whose funds the provider holds HELD
 *                          FUNDS_HELD; due lines with funds AVAILABLE and no covering hold ELIGIBLE (KC007).
 */
import type { AgencyId, CommissionLineId, CommissionLineRecord } from "@kauro/domain";
import { DomainFailure, addHours } from "@kauro/domain";
import { attributionOf, commissionWorkOf, foundingOf, ledgerOf, recurrenceOf, type PgCommercialUnitOfWork } from "@kauro/persistence";
import { accruePurchase, convertAcceptedClaims, recordCompletions, releaseFundsHold, serverNow } from "./ledger-effects.js";
import { HOLD_REVIEW_HOURS, inAgency, serviceContext, type CommissionRuntime } from "./runtime.js";

/** The sweeps of the commission service, in the order a cycle runs them. */
export const COMMISSION_SWEEPS = ["QUOTE_EXPIRY", "ACCRUAL_RECONCILIATION", "CLAIM_WINDOWS", "ENTITLEMENT_WINDOWS", "ELIGIBILITY"] as const;
export type CommissionSweepName = (typeof COMMISSION_SWEEPS)[number];

/** What one pass of a sweep did, item by item (the subject's id and a token of what happened to it). */
export interface SweepReport {
  readonly sweep: string;
  readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }>;
}

/** A sweep a cycle runs after the commission service's own (PERIODS, entered by B10-INTEGRATION). */
export interface CycleSweep {
  readonly sweep: string;
  run(options: { readonly limit: number }): Promise<SweepReport>;
}

type Items = Array<{ readonly subject: string; readonly outcome: string }>;

/** Runs one item in its own unit of work; a failure is reported, handed to the background sink and left for the next pass. */
async function item(rt: CommissionRuntime, items: Items, subject: string, work: () => Promise<string>): Promise<void> {
  try {
    items.push({ subject, outcome: await work() });
  } catch (e) {
    rt.onBackgroundFailure(subject, e);
    items.push({ subject, outcome: `FAILED ${e instanceof DomainFailure ? e.code : "UNEXPECTED_ERROR"}` });
  }
}

/** The work list of a pass, read in a SERVICE unit of work of the commission service with no agency adopted. */
function list<T>(rt: CommissionRuntime, read: (uow: PgCommercialUnitOfWork) => Promise<T>): Promise<T> {
  return rt.assembly.units.run(serviceContext(rt), read);
}

function isInFlightRefusal(e: unknown): boolean {
  return e instanceof DomainFailure && e.details["reason"] === "UNLISTED_TRANSITION";
}

// --- QUOTE_EXPIRY ----------------------------------------------------------------------------------------------------------------

async function quoteExpiry(rt: CommissionRuntime, limit: number): Promise<SweepReport> {
  const items: Items = [];
  for (const due of await list(rt, (uow) => commissionWorkOf(uow).dueReservations(limit))) {
    await item(rt, items, due.reservationId, () =>
      inAgency(rt, due.agencyId, null, async (uow) => {
        const now = await serverNow(uow);
        // lock order (§10): the quote, then the founding reservation
        const quote = await uow.commerce.quotes.lock(due.quoteId);
        const reservation = await foundingOf(uow).lockReservation(due.reservationId);
        if (quote === null || reservation === null) throw new DomainFailure("INTEGRITY_FAILURE", "a due reservation's quote is not visible in its agency");
        if (reservation.state !== "RESERVED" && reservation.state !== "RECONCILIATION_HOLD") return "SETTLED";
        if (Date.parse(reservation.endsAt) > Date.parse(now)) return "NOT_DUE";
        let quoteState = quote.state;
        if (quoteState === "ISSUED" || quoteState === "ACCEPTED_FOR_CHECKOUT") {
          // B09's price_expiry_reached; its release guard refuses while a payment of the quote is in flight or uncertain
          const tried = await commissionWorkOf(uow).attempt(() => uow.commerce.quotes.transition(quote.quoteId, quote.version, { state: "EXPIRED" }, now));
          if (tried.kind === "REFUSED") {
            if (!isInFlightRefusal(tried.error)) throw tried.error;
            if (reservation.state === "RECONCILIATION_HOLD") return "IN_FLIGHT";
            const held = await foundingOf(uow).holdForReconciliation(reservation.reservationId, reservation.version, now);
            if (held.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the reservation changed while it was held", {}, true);
            return "RECONCILIATION_HOLD";
          }
          if (tried.value.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the quote changed while it expired", {}, true);
          quoteState = tried.value.record.state;
        }
        if (quoteState !== "EXPIRED" && quoteState !== "SUPERSEDED" && quoteState !== "WITHDRAWN") return "QUOTE_LIVE";
        const released = await foundingOf(uow).release(reservation.reservationId, reservation.version, now);
        if (released.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the reservation changed while it was released", {}, true);
        return "RELEASED";
      }),
    );
  }
  return { sweep: "QUOTE_EXPIRY", items };
}

// --- ACCRUAL_RECONCILIATION ---------------------------------------------------------------------------------------------------

async function accrualReconciliation(rt: CommissionRuntime, limit: number): Promise<SweepReport> {
  const items: Items = [];
  for (const agencyId of await list(rt, (uow) => commissionWorkOf(uow).agenciesToReconcile(limit, null))) {
    await item(rt, items, agencyId, () =>
      inAgency(rt, agencyId, null, async (uow) => {
        const converted = await convertAcceptedClaims(rt, uow, agencyId, await serverNow(uow));
        return converted > 0 ? `CONVERTED ${converted}` : "NOTHING_TO_CONVERT";
      }),
    );
    let lacking: Awaited<ReturnType<ReturnType<typeof ledgerOf>["purchasesLackingPools"]>> = [];
    await item(rt, items, agencyId, async () => {
      lacking = await inAgency(rt, agencyId, null, (uow) => ledgerOf(uow).purchasesLackingPools(limit));
      return `LACKING ${lacking.length}`;
    });
    for (const purchase of lacking) {
      await item(rt, items, purchase.purchaseId, () =>
        inAgency(rt, agencyId, null, async (uow) => {
          await attributionOf(uow).lockAgencies([agencyId]);
          const current = await recurrenceOf(uow).getPurchase(purchase.purchaseId);
          if (current === null) return "NOT_FOUND";
          const accrual = await accruePurchase(rt, uow, current, await serverNow(uow), "CURRENT");
          return accrual.created > 0 ? `ACCRUED ${accrual.created}` : "NOTHING_TO_ACCRUE";
        }),
      );
    }
  }
  return { sweep: "ACCRUAL_RECONCILIATION", items };
}

// --- CLAIM_WINDOWS, ENTITLEMENT_WINDOWS ---------------------------------------------------------------------------------------

async function claimWindows(rt: CommissionRuntime, limit: number): Promise<SweepReport> {
  const items: Items = [];
  for (const claim of await list(rt, async (uow) => attributionOf(uow).lapsedClaims(await serverNow(uow), limit))) {
    await item(rt, items, claim.claimId, async () => {
      const lapse = async (uow: PgCommercialUnitOfWork): Promise<string> => {
        const now = await serverNow(uow);
        const locked = await attributionOf(uow).lockClaim(claim.claimId);
        if (locked === null || (locked.state !== "SUBMITTED" && locked.state !== "DISPUTED" && locked.state !== "ACCEPTED")) return "SETTLED";
        const written = await attributionOf(uow).transitionClaim(claim.claimId, locked.version, { state: "EXPIRED" }, now);
        if (written.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the claim changed while it lapsed", {}, true);
        return "EXPIRED";
      };
      if (claim.state !== "ACCEPTED" || claim.agencyId === undefined) return rt.assembly.units.run(serviceContext(rt), lapse);
      // an ACCEPTED claim whose agency bought before its end converts instead of lapsing
      return inAgency(rt, claim.agencyId, null, async (uow) => {
        await convertAcceptedClaims(rt, uow, claim.agencyId as AgencyId, await serverNow(uow));
        const after = await attributionOf(uow).getClaim(claim.claimId);
        return after?.state === "CONVERTED" ? "CONVERTED" : lapse(uow);
      });
    });
  }
  return { sweep: "CLAIM_WINDOWS", items };
}

async function entitlementWindows(rt: CommissionRuntime, limit: number): Promise<SweepReport> {
  const items: Items = [];
  for (const entitlement of await list(rt, async (uow) => attributionOf(uow).endedEntitlements(await serverNow(uow), limit))) {
    await item(rt, items, entitlement.entitlementId, () =>
      inAgency(rt, entitlement.agencyId, null, async (uow) => {
        const current = await attributionOf(uow).getEntitlement(entitlement.entitlementId);
        if (current === null || current.state === "EXPIRED") return "SETTLED";
        const written = await attributionOf(uow).transitionEntitlement(entitlement.entitlementId, current.version, "EXPIRED", await serverNow(uow));
        if (written.kind !== "APPLIED") throw new DomainFailure("STALE_VERSION", "the entitlement changed while it expired", {}, true);
        return "EXPIRED";
      }),
    );
  }
  return { sweep: "ENTITLEMENT_WINDOWS", items };
}

// --- ELIGIBILITY -------------------------------------------------------------------------------------------------------------------

async function eligibility(rt: CommissionRuntime, limit: number): Promise<SweepReport> {
  const items: Items = [];
  // the completions of purchases still awaiting a FINAL one (a STAGE starts nothing)
  for (const awaiting of await list(rt, (uow) => commissionWorkOf(uow).purchasesAwaitingFinal(limit))) {
    await item(rt, items, awaiting.purchaseId, () =>
      inAgency(rt, awaiting.agencyId, null, async (uow) => {
        const purchase = await recurrenceOf(uow).getPurchase(awaiting.purchaseId);
        if (purchase === null) throw new DomainFailure("INTEGRITY_FAILURE", "a line's purchase is not visible in its agency");
        const recorded = await recordCompletions(rt, uow, purchase, await serverNow(uow));
        return recorded > 0 ? `COMPLETIONS ${recorded}` : "NO_COMPLETION";
      }),
    );
  }
  // funds the provider released: their holds released
  for (const hold of await list(rt, (uow) => commissionWorkOf(uow).releasableFundsHolds(limit))) {
    await item(rt, items, hold.holdId, () => inAgency(rt, hold.agencyId, null, async (uow) => ((await releaseFundsHold(uow, hold.holdId, hold.version, await serverNow(uow))) ? "RELEASED" : "SETTLED")));
  }
  // lines that fell due while the provider holds their funds
  for (const line of await list(rt, (uow) => commissionWorkOf(uow).dueLinesOnHeldFunds(limit))) {
    await item(rt, items, line.lineId, () =>
      inAgency(rt, line.agencyId, null, async (uow) => {
        const now = await serverNow(uow);
        const written = await ledgerOf(uow).transitionLine(line.lineId, line.version, { state: "HELD", heldReason: "FUNDS_HELD", reviewAt: line.reviewAt ?? addHours(now, HOLD_REVIEW_HOURS) }, now);
        return written.kind === "APPLIED" ? "HELD" : "SETTLED";
      }),
    );
  }
  // due, funds AVAILABLE, no covering hold: ELIGIBLE (the database repeats every condition, KC007)
  const due = await list(rt, async (uow) => ledgerOf(uow).linesDueForEligibility(await serverNow(uow), limit));
  for (const line of due) {
    await item(rt, items, line.lineId, () =>
      inAgency(rt, line.agencyId, null, async (uow) => {
        const locked: CommissionLineRecord | null = await ledgerOf(uow).lockLine(line.lineId as CommissionLineId);
        if (locked === null || (locked.state !== "ACCRUED_PENDING" && locked.state !== "HELD")) return "SETTLED";
        const written = await ledgerOf(uow).transitionLine(locked.lineId, locked.version, { state: "ELIGIBLE" }, await serverNow(uow));
        return written.kind === "APPLIED" ? "ELIGIBLE" : "SETTLED";
      }),
    );
  }
  return { sweep: "ELIGIBILITY", items };
}

/** One bounded pass of one sweep. */
export async function runSweep(rt: CommissionRuntime, sweep: CommissionSweepName, options: { readonly limit?: number } = {}): Promise<SweepReport> {
  const limit = options.limit ?? 100;
  switch (sweep) {
    case "QUOTE_EXPIRY":
      return quoteExpiry(rt, limit);
    case "ACCRUAL_RECONCILIATION":
      return accrualReconciliation(rt, limit);
    case "CLAIM_WINDOWS":
      return claimWindows(rt, limit);
    case "ENTITLEMENT_WINDOWS":
      return entitlementWindows(rt, limit);
    case "ELIGIBILITY":
      return eligibility(rt, limit);
  }
}
