/**
 * Checkout readiness as the request side reads it (design §8 CMD028, CMD029, §8.3; 07 "Quote and checkout states": readiness is a
 * derived predicate; commerce/authority checkoutBlockers decides). The facts are read inside the caller's unit of work, each after
 * its transition lock in the platform's order (design §6.2): the purchased subject (agency → capability → approval → source
 * revision → target contract, PurchasedSubjectReader), then the merchant route, the fiscal issuer and the agency's fiscal profile;
 * the caller takes the quote's own lock after them. The platform ports are read in the same unit of work (never outside a
 * transaction): B07's source availability for the effective deadline of the sealed revision and B08's admission for deliverable
 * capacity (D-QUOTE-B7, D-CAP-B1; D-REQ-B1 when a port is not bound).
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  CheckoutBlocker,
  CheckoutFacts,
  CommerceUnitOfWork,
  FiscalIssuerRecord,
  FiscalProfileRecord,
  MembershipRole,
  PaymentEnvironment,
  PaymentOrderRecord,
  PaymentRouteRecord,
  QuoteRecord,
} from "@kauro/domain";
import { checkoutBlockers, instantMs } from "@kauro/domain";
import type { QuoteView } from "../views.js";
import type { PurchasedSubject } from "../core/subject.js";
import { quoteView } from "./projections.js";
import type { CommerceRequestCollaborators } from "./runtime.js";

/** What a checkout relies on without changing it, read after the shared halves of its transition locks. */
export interface CheckoutPrerequisites {
  readonly subject: PurchasedSubject | null;
  /** The QUALIFIED merchant route of the provider and environment the checkout would use; null when none (or none is bound). */
  readonly route: PaymentRouteRecord | null;
  readonly issuer: FiscalIssuerRecord | null;
  readonly profile: FiscalProfileRecord | null;
}

/**
 * Reads the prerequisites in the lock order: the purchased subject, then the payment route of `routeOf` (the bound adapter's provider
 * and environment for a new checkout, the order's own for a capture), the quote's fiscal issuer and the agency's current fiscal profile.
 */
export async function readCheckoutPrerequisites(
  uow: CommerceUnitOfWork,
  co: Pick<CommerceRequestCollaborators, "subjects">,
  quote: QuoteRecord,
  routeOf: { readonly provider: string; readonly environment: PaymentEnvironment } | null,
): Promise<CheckoutPrerequisites> {
  const c = uow.commerce;
  const subject = await co.subjects.subjectOf(uow, quote);
  const route = routeOf === null ? null : await c.routes.findQualified(routeOf.provider, routeOf.environment);
  const issuer = await c.fiscal.getIssuer(quote.issuerRef);
  const profile = await c.fiscal.currentProfile(quote.agencyId);
  return { subject, route, issuer, profile };
}

/**
 * The quoted revision as a checkout may rely on it (S060; 07 "A fourteen-day price lifetime does not extend seven-day source
 * retention"): SEALED and within its effective deadline — the source lifecycle's (SourceAvailabilityReader, B07) when the reader is
 * bound, else the quote's own promise, which the reader set at issuance (D-QUOTE-B7, D-REQ-B1). A revision past its deadline is
 * expired for checkout whatever its row still says.
 */
export async function revisionForCheckout(
  uow: CommerceUnitOfWork,
  co: Pick<CommerceRequestCollaborators, "sources">,
  quote: QuoteRecord,
  revision: PurchasedSubject["revision"],
  now: UtcInstant,
): Promise<PurchasedSubject["revision"]> {
  if (revision === null || revision.state !== "SEALED") return revision;
  if (co.sources === null) return instantMs(now) >= instantMs(quote.sourceAvailableUntil) ? { state: "EXPIRED" } : revision;
  const availability = await co.sources.availabilityOf(uow, { agencyId: quote.agencyId, projectId: quote.projectId, revisionHash: quote.revisionHash });
  if (availability === null) return { state: "EXPIRED" };
  if (availability.state !== "SEALED") return { state: availability.state };
  return instantMs(now) >= instantMs(availability.effectiveDeadline) ? { state: "EXPIRED" } : revision;
}

/**
 * Deliverable capacity for the purchased scope (D-CAP-B1): B08's admission answers inside the caller's unit of work; a refusal, an
 * admission that answers nothing (a failure) and an unbound port are alike — no capacity (null), which blocks checkout.
 */
export async function capacityForCheckout(uow: CommerceUnitOfWork, co: Pick<CommerceRequestCollaborators, "capacity">, quote: QuoteRecord, now: UtcInstant): Promise<CheckoutFacts["capacity"]> {
  if (co.capacity === null) return null;
  try {
    const answer = await co.capacity.checkoutCapacity(uow, { agencyId: quote.agencyId, projectId: quote.projectId, mode: quote.mode, billableUnits: quote.billableUnits, at: now });
    return { available: answer.available };
  } catch {
    // an admission that could not answer is "unanswered" (D-CAP-B1): no capacity, retried later with the same key
    return null;
  }
}

/** Whether the quote is already paid: an entitlement of it exists, or a completed capture pays one of its orders (ALREADY_PAID). */
export async function quoteIsPaid(uow: CommerceUnitOfWork, co: Pick<CommerceRequestCollaborators, "queries">, quote: QuoteRecord): Promise<boolean> {
  if ((await uow.commerce.authorizations.findByQuote(quote.quoteId)) !== null) return true;
  return (await co.queries.completedCaptureOfQuote(uow, quote.quoteId)) !== null;
}

/** The domain's CheckoutFacts from what the caller read. */
export async function checkoutFactsOf(
  uow: CommerceUnitOfWork,
  co: Pick<CommerceRequestCollaborators, "sources" | "capacity">,
  quote: QuoteRecord,
  read: CheckoutPrerequisites,
  payment: { readonly openOrder: Pick<PaymentOrderRecord, "state"> | null; readonly paid: boolean },
  now: UtcInstant,
): Promise<CheckoutFacts> {
  const subject = read.subject;
  return {
    now,
    quote,
    agencyState: subject?.agencyState ?? "CLOSED",
    plan: subject?.plan ?? null,
    approval: subject?.approval ?? null,
    revision: await revisionForCheckout(uow, co, quote, subject?.revision ?? null, now),
    target: subject?.target ?? null,
    capability: subject?.capability ?? null,
    capacity: await capacityForCheckout(uow, co, quote, now),
    paymentRoute: read.route === null ? null : { state: read.route.state },
    fiscalIssuerRoute: read.issuer === null ? null : { state: read.issuer.routeState },
    fiscalProfile: read.profile,
    openOrder: payment.openOrder === null ? null : { state: payment.openOrder.state },
    paid: payment.paid,
  };
}

/**
 * The QuoteView of a quote as the caller's unit of work sees it now (GetQuote; CMD028's answer): its terms and the checkout blockers
 * derived from the durable facts, read in the lock order, with the merchant route of the bound provider adapter.
 */
export async function quoteViewOf(uow: CommerceUnitOfWork, co: CommerceRequestCollaborators, quote: QuoteRecord, role: MembershipRole | null, now: UtcInstant): Promise<QuoteView> {
  const read = await readCheckoutPrerequisites(uow, co, quote, co.provider === null ? null : { provider: co.provider.provider, environment: co.provider.environment });
  const openOrder = await uow.commerce.orders.findOpenForProject(quote.projectId);
  const paid = await quoteIsPaid(uow, co, quote);
  const blockers: ReadonlyArray<CheckoutBlocker> = checkoutBlockers(await checkoutFactsOf(uow, co, quote, read, { openOrder, paid }, now));
  const snapshot = await uow.commerce.quotes.snapshot(quote.quoteId);
  return quoteView(quote, snapshot, blockers, { role, openCheckout: openOrder !== null });
}
