/**
 * The included pre-execution source replacement of CMD027 (design §3.5; decisions D10-QUOTE-3, D10-QUOTE-4; registry R2-092, R2-093; 16
 * "Scope changes and credits"; COMMERCIAL_LEDGER_WORKED_EXAMPLES §18): on a project whose live quote is paid and whose entitlement is
 * ACTIVE, a new approved plan of the same project, mode, target and band re-binds the purchase to a replacement quote — no order, no new
 * fee, the old entitlement REVOKED SOURCE_REPLACED, the one included allowance spent.
 *
 * Three steps, each its own transaction, joined by the command's journal entry:
 *  - INTENT (the agency member's unit of work, kauro_app): the replacement quote DRAFT → ISSUED carrying exactly the paid terms (B09
 *    quotes_replacement_terms_fk), its snapshot a copy of the paid one, and `quote_issuances` naming the entry, the quote and the quote it
 *    replaces. The journal entry stays RESERVED at COMMIT: a retry under the same key finds it PENDING and resumes from the issuance.
 *  - SETTLE (the payment service's unit of work, kauro_payment, SERVICE): the unit adopts the paid order's scope (D-M3-B6) and B09's
 *    PurchaseRebinder records the re-binding, revokes the old entitlement, supersedes the paid quote, accepts the replacement and issues its
 *    entitlement on the same capture. A replacement already accepted is a re-binding already made, never made twice.
 *  - COMPLETE (the agency member's unit of work): from what became durable — a re-bound replacement is answered; a refused one is WITHDRAWN
 *    (quote.withdrawn.v1) and answered with the blockers that refused it. The journal entry commits with the answer.
 */
import type { UtcInstant } from "@kauro/contracts";
import type {
  AgencyId,
  ExecutionContext,
  CausationId,
  CorrelationId,
  CommerceUnitOfWork,
  CommercialAuthorizationRecord,
  JournalEntryId,
  MembershipId,
  NewQuote,
  PriceEligibilitySnapshotRecord,
  ProjectId,
  QuoteIssuanceRecord,
  QuoteRecord,
  ResolvedMembership,
  MembershipRole,
  EligibilitySnapshotId,
  QuoteId,
  PlanRecord,
  IdempotencyIdentity,
  TenantContext,
} from "@kauro/domain";
import { DomainFailure, NotFoundFailure, baseServiceCents, quoteTermsHash, registryPricePolicy, termsMoney } from "@kauro/domain";
import type { CommandEnvelope } from "../../api/envelope.js";
import { quoteViewOf } from "../../commerce/request/checkout.js";
import { providerServicesUnavailable, type CommerceRequestRuntime } from "../../commerce/request/runtime.js";
import { applied } from "../agency/shared.js";
import { withinCallBound, type Bounded } from "../call-bound.js";
import type { CreateQuoteBody } from "../contracts.js";
import type { CreateQuoteView } from "../views.js";
import type { QuotedSubject } from "./create-quote.js";
import type { QuoteCollaborators } from "./runtime.js";

/** What the later steps of a replacement need, all of it durable from the intent on (so a resume rebuilds it from the journal entry). */
export interface ReplacementContext {
  readonly entryId: JournalEntryId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly toQuoteId: QuoteId;
  readonly fromQuoteId: QuoteId;
  readonly orderId: CommercialAuthorizationRecord["orderId"];
  readonly captureId: CommercialAuthorizationRecord["captureId"];
  readonly membershipId: MembershipId;
}

/** What the payment service concluded; PENDING: its re-binding did not answer within its bound (nothing concluded, answer 202). */
export type Concluded = { readonly kind: "REBOUND" } | { readonly kind: "REFUSED"; readonly blockers: ReadonlyArray<string> };
export type SettledReplacement = Concluded | { readonly kind: "PENDING" };

const refuse = (reason: NonNullable<DomainFailure["details"]["reason"]>, message: string, details: Partial<DomainFailure["details"]> = {}): DomainFailure =>
  new DomainFailure("PRECONDITION_FAILED", message, { reason, ...details });

/** The replacement the journal entry's issuance names, with the purchase it re-binds (a resume rebuilds the context from here). */
export async function replacementContextOf(uow: CommerceUnitOfWork, _co: QuoteCollaborators, issuance: QuoteIssuanceRecord): Promise<ReplacementContext> {
  const c = uow.commerce;
  const fromQuoteId = issuance.replacesQuoteId;
  if (fromQuoteId === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the issuance of a replacement names the quote it replaces");
  const authorization = await c.authorizations.findByQuote(fromQuoteId);
  const to = await c.quotes.get(issuance.quoteId);
  if (authorization === null || to === null) throw new DomainFailure("INTEGRITY_FAILURE", "the purchase a replacement re-binds is not visible to its agency");
  return { entryId: issuance.journalEntryId, agencyId: issuance.agencyId, projectId: issuance.projectId, toQuoteId: issuance.quoteId, fromQuoteId, orderId: authorization.orderId, captureId: authorization.captureId, membershipId: to.createdByMembershipId };
}

/**
 * INTENT: refuses what the included replacement does not cover (EXECUTION_STARTED, REPLACEMENT_SCOPE_CHANGED with the band comparison,
 * REPLACEMENT_ALLOWANCE_SPENT) writing nothing, then issues the replacement quote and records its issuance. The paid quote stays the live
 * one until the payment service's re-binding supersedes it.
 */
export async function issueReplacement(
  uow: CommerceUnitOfWork,
  co: QuoteCollaborators,
  input: {
    readonly entryId: JournalEntryId;
    readonly envelope: Pick<CommandEnvelope<CreateQuoteBody>, "correlationId">;
    readonly membership: ResolvedMembership;
    readonly subject: QuotedSubject;
    readonly live: QuoteRecord;
    readonly authorization: CommercialAuthorizationRecord;
  },
): Promise<ReplacementContext> {
  const { live, authorization, subject } = input;
  if (co.rebinder === null || co.request.payment === null) throw providerServicesUnavailable();
  const c = uow.commerce;
  const reads = co.reads(uow);
  const { agencyId, projectId } = live;
  if (authorization.state !== "ACTIVE") {
    throw refuse("EXECUTION_STARTED", "the paid execution has started: the entitlement can no longer be re-bound", { currentVersion: authorization.version, currentState: authorization.state });
  }
  // the same project, mode, target and band (equal base): any other scope is charged only after a refund and a new accepted quote
  const policy = registryPricePolicy();
  const base = baseServiceCents(policy, subject.project.mode, subject.units);
  if (subject.project.mode !== live.mode || subject.plan.targetContractHash !== live.targetContractHash || base === null || base !== live.baseServiceCents) {
    const mismatch = subject.plan.targetContractHash !== live.targetContractHash ? ["targetContractHash"] : subject.project.mode !== live.mode ? ["mode"] : ["baseServiceCents", `paid${live.baseServiceCents}`, `replacement${base ?? 0n}`];
    throw refuse("REPLACEMENT_SCOPE_CHANGED", "the replacement is not of the paid mode, target and band", { currentVersion: live.version, currentState: live.state, mismatch });
  }
  const allowance = (await c.pricePolicies.get(live.pricePolicyVersion))?.preExecutionReplacementsIncluded ?? 0;
  if ((await c.rebindings.listForCapture(authorization.captureId)).length >= allowance) {
    throw refuse("REPLACEMENT_ALLOWANCE_SPENT", "the one included pre-execution source replacement is spent", { currentVersion: live.version, currentState: live.state });
  }
  if ((await reads.pendingReplacementOf(agencyId, live.quoteId)) !== null) throw refuse("OPERATION_PENDING", "a replacement of the paid quote is still pending");

  const paidSnapshot = await c.quotes.snapshot(live.quoteId);
  if (paidSnapshot === null) throw new DomainFailure("INTEGRITY_FAILURE", "the paid quote has no eligibility snapshot");
  const issuedAt = subject.issuedAt;
  const bounds = await reads.boundsAt(issuedAt, policy.quoteDays * 86_400, policy.repeatLookbackDays * 86_400, subject.sourceDeadline);
  const quoteId = uow.ids.next() as QuoteId;
  const snapshotId = uow.ids.next() as EligibilitySnapshotId;
  const approvalId = subject.plan.approvalId as NonNullable<PlanRecord["approvalId"]>;
  const termsHash = quoteTermsHash({
    quoteId,
    agencyId,
    projectId,
    planId: subject.plan.planId,
    approvalId,
    planHash: subject.plan.bodyHash,
    revisionHash: subject.plan.revisionHash,
    targetContractHash: subject.plan.targetContractHash,
    mode: live.mode,
    billableUnits: subject.units,
    pricePolicyVersion: live.pricePolicyVersion,
    discountPolicyVersion: live.discountPolicyVersion,
    eligibilitySnapshotId: snapshotId,
    ...termsMoney({ baseServiceCents: live.baseServiceCents, discountBps: live.discountBps, discountCents: live.discountCents, serviceCents: live.serviceCents, taxCents: live.taxCents, totalCents: live.totalCents }),
    fiscalProfileId: live.fiscalProfileId,
    issuerRef: live.issuerRef,
    taxTreatment: live.tax.treatment,
    taxRule: live.tax.rule,
    taxRateBps: live.tax.rateBps,
    currency: "USD",
    issuedAt,
    expiresAt: bounds.expiresAt,
    sourceAvailableUntil: bounds.sourceAvailableUntil,
    termsVersion: live.termsVersion,
  });
  const replacement: NewQuote = {
    quoteId,
    agencyId,
    projectId,
    planId: subject.plan.planId,
    approvalId,
    revisionHash: subject.plan.revisionHash,
    planHash: subject.plan.bodyHash,
    targetContractHash: subject.plan.targetContractHash,
    billableUnits: subject.units,
    mode: live.mode,
    pricePolicyVersion: live.pricePolicyVersion,
    discountPolicyVersion: live.discountPolicyVersion,
    baseServiceCents: live.baseServiceCents,
    discountBps: live.discountBps,
    discountCents: live.discountCents,
    serviceCents: live.serviceCents,
    fiscalProfileId: live.fiscalProfileId,
    issuerRef: live.issuerRef,
    tax: live.tax,
    taxCents: live.taxCents,
    totalCents: live.totalCents,
    eligibilitySnapshotId: snapshotId,
    termsHash,
    termsVersion: live.termsVersion,
    issuedAt,
    expiresAt: bounds.expiresAt,
    sourceAvailableUntil: bounds.sourceAvailableUntil,
    replacesQuoteId: live.quoteId,
    createdByMembershipId: input.membership.membershipId as MembershipId,
  };
  // the snapshot copies the paid facts (the set, the tiers and the founding rate with the reservation the paid purchase consumed)
  const snapshot: PriceEligibilitySnapshotRecord = {
    snapshotId,
    agencyId,
    quoteId,
    projectId,
    asOf: issuedAt,
    lookbackStartsAt: bounds.lookbackStartsAt,
    qualifyingProjectIds: paidSnapshot.qualifyingProjectIds,
    qualifyingCount: paidSnapshot.qualifyingCount,
    repeatDiscountBps: paidSnapshot.repeatDiscountBps,
    ...(paidSnapshot.foundingSlotRef !== undefined ? { foundingSlotRef: paidSnapshot.foundingSlotRef } : {}),
    foundingDiscountBps: paidSnapshot.foundingDiscountBps,
    appliedDiscountBps: paidSnapshot.appliedDiscountBps,
    policyVersion: paidSnapshot.policyVersion,
  };
  await c.quotes.issue(replacement, snapshot);
  await co.recurrence(uow).recordIssuance({ journalEntryId: input.entryId, agencyId, projectId, quoteId, snapshotId, issuedAt, replacesQuoteId: live.quoteId });
  return { entryId: input.entryId, agencyId, projectId, toQuoteId: quoteId, fromQuoteId: live.quoteId, orderId: authorization.orderId, captureId: authorization.captureId, membershipId: input.membership.membershipId as MembershipId };
}

/**
 * SETTLE: the payment service re-binds the purchase in a unit of work that adopted the paid order's scope. Safe to run again: a replacement
 * a former pass already accepted is answered REBOUND without a second re-binding, and one no longer ISSUED is refused.
 */
export async function settleReplacement(runtime: CommerceRequestRuntime, co: QuoteCollaborators, ctx: ReplacementContext, correlationId: string): Promise<SettledReplacement> {
  const factory = co.request.payment;
  const rebinder = co.rebinder;
  if (factory === null || rebinder === null) throw providerServicesUnavailable();
  // bounded by PROVIDER_CALL_TIMEOUT_MS (D10-GAP-6a): a re-binding that does not answer leaves the replacement ISSUED with its journal entry
  // open (nothing is concluded), and the request answers the retriable 202 — the same key resumes and observes the re-binding by its identity
  const service = { kind: "SERVICE", serviceId: co.request.paymentServiceId, correlationId: correlationId as CorrelationId } as const;
  let bounded: Bounded<Concluded>;
  try {
    bounded = await withinCallBound(co.providerTimer, () =>
      factory.run(service, async (svc: CommerceUnitOfWork): Promise<Concluded> => {
        if ((await svc.adoptScope("PAYMENT_ORDER", ctx.orderId)) === null) throw new NotFoundFailure("payment_order");
        const to = await svc.commerce.quotes.get(ctx.toQuoteId);
        if (to === null) throw new NotFoundFailure("quote");
        if (to.state === "ACCEPTED_FOR_CHECKOUT") return { kind: "REBOUND" };
        if (to.state !== "ISSUED") return { kind: "REFUSED", blockers: ["NOT_A_REPLACEMENT"] };
        const rebound = await rebinder.rebind(svc, { captureId: ctx.captureId, fromQuoteId: ctx.fromQuoteId, toQuoteId: ctx.toQuoteId, requestedByMembershipId: ctx.membershipId, causationId: ctx.entryId as unknown as CausationId, now: runtime.clock.now() });
        return rebound.kind === "REBOUND" ? { kind: "REBOUND" } : { kind: "REFUSED", blockers: rebound.blockers };
      }),
      // no abandon: the re-binding is its own SERVICE unit of work and keeps running to its COMMIT or ROLLBACK, whose outcome the same key observes
      { call: "CMD027.rebind", ...(co.onLateFailure !== undefined ? { onLateFailure: co.onLateFailure } : {}) },
    );
  } catch (e) {
    // A re-binding that lost a race on the database's own guard (an abandoned unit of this very replacement committed first, or is committing
    // while this one waited on its locks) failed on a state that is no failure: observe it by the replacement's identity, never repeat it.
    if (e instanceof DomainFailure && (e.details.reason === "REPLACEMENT_NOT_ALLOWED" || e.code === "STALE_VERSION")) {
      if (await reboundByIdentity(factory, service, ctx)) return { kind: "REBOUND" };
    }
    throw e;
  }
  if (bounded.timedOut) return { kind: "PENDING" };
  // The same recovery for a NORMAL refusal (Codex F1): an abandoned unit of this very replacement that committed between the retry's ordinary
  // reads makes the rebinder answer REFUSED (ALLOWANCE_USED, PURCHASE_NOT_INTACT) over a purchase that IS re-bound. A refusal is never
  // answered before the replacement's identity is observed. (completeReplacement repeats the observation under the quote's lock.)
  if (bounded.value.kind === "REFUSED" && (await reboundByIdentity(factory, service, ctx))) return { kind: "REBOUND" };
  return bounded.value;
}

/** The replacement was re-bound: accepted for checkout with a re-binding recorded for it, read in the payment service's own unit. */
async function reboundByIdentity(factory: NonNullable<QuoteCollaborators["request"]["payment"]>, service: ExecutionContext, ctx: ReplacementContext): Promise<boolean> {
  return factory.run(service, async (svc: CommerceUnitOfWork): Promise<boolean> => {
    if ((await svc.adoptScope("PAYMENT_ORDER", ctx.orderId)) === null) throw new NotFoundFailure("payment_order");
    const to = await svc.commerce.quotes.get(ctx.toQuoteId);
    return to !== null && to.state === "ACCEPTED_FOR_CHECKOUT" && (await svc.commerce.rebindings.findTo(ctx.toQuoteId)) !== null;
  });
}

/**
 * COMPLETE: answers from the durable facts. A re-bound replacement is answered with the entitlement it revoked; a refused one is withdrawn
 * and answered with its blockers. The journal entry commits with the answer (a retry then replays it). Safe to run again.
 */
export async function completeReplacement(
  runtime: CommerceRequestRuntime,
  co: QuoteCollaborators,
  ctx: ReplacementContext,
  settled: Concluded,
  input: { readonly context: TenantContext; readonly identity: IdempotencyIdentity; readonly role: MembershipRole | null },
): Promise<{ readonly view: CreateQuoteView; readonly replayed: boolean }> {
  return runtime.unitOfWork.run(input.context, async (uow) => {
    const entry = await uow.journal.find(input.identity);
    if (entry !== null && entry.state === "COMMITTED") {
      if (entry.responseStatus !== 201 || entry.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "journaled entry is COMMITTED without a complete response");
      return { view: entry.responseBody as CreateQuoteView, replayed: true };
    }
    const c = uow.commerce;
    const now: UtcInstant = runtime.clock.now();
    let quote = await c.quotes.get(ctx.toQuoteId);
    if (quote === null) throw new NotFoundFailure("quote");
    if (settled.kind === "REFUSED" && quote.state === "ISSUED") {
      const locked = await c.quotes.lock(ctx.toQuoteId);
      if (locked === null) throw new NotFoundFailure("quote");
      // the lock waits for an abandoned re-binding that is committing: what it left is read under the lock, and a replacement it accepted is
      // never withdrawn (the withdrawal would be an unlisted transition over a re-bound purchase)
      quote = locked.state === "ISSUED" ? applied(await c.quotes.transition(ctx.toQuoteId, locked.version, { state: "WITHDRAWN" }, now)) : locked;
    }
    // the outcome comes from the durable facts, not from the refusal alone (Codex F1): a refused answer over a replacement that a late COMMIT
    // accepted with its re-binding recorded is REBOUND
    const rebound = settled.kind === "REBOUND" || (quote.state === "ACCEPTED_FOR_CHECKOUT" && (await c.rebindings.findTo(ctx.toQuoteId)) !== null);
    if (rebound && quote.state !== "ACCEPTED_FOR_CHECKOUT") throw new DomainFailure("INTEGRITY_FAILURE", "a re-bound replacement is not accepted for checkout");
    const snapshot = await c.quotes.snapshot(ctx.toQuoteId);
    if (snapshot === null) throw new DomainFailure("INTEGRITY_FAILURE", "the replacement has no eligibility snapshot");
    const revoked = rebound ? await c.authorizations.findByQuote(ctx.fromQuoteId) : null;
    const view: CreateQuoteView = {
      quote: await quoteViewOf(uow, co.request, quote, input.role, now),
      eligibility: {
        qualifyingProjectCount: snapshot.qualifyingCount,
        repeatDiscountBps: snapshot.repeatDiscountBps,
        foundingOffer: "NOT_ELIGIBLE",
        appliedDiscountBps: snapshot.appliedDiscountBps,
        lookbackStartsAt: snapshot.lookbackStartsAt,
      },
      replacement: {
        replacedQuoteId: ctx.fromQuoteId,
        ...(revoked !== null ? { revokedAuthorizationId: revoked.authorizationId } : {}),
        approvalRequired: false,
        outcome: rebound ? "REBOUND" : "WITHDRAWN",
        ...(!rebound && settled.kind === "REFUSED" ? { reason: settled.blockers[0] ?? "NOT_A_REPLACEMENT" } : {}),
      },
    };
    const committed = await uow.journal.commit(ctx.entryId, { responseStatus: 201, responseBody: view, resourceKind: "quote", resourceId: ctx.toQuoteId });
    if (committed.state !== "COMMITTED" || committed.responseStatus !== 201 || committed.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "the journal did not record the response of this command");
    return { view: committed.responseBody as CreateQuoteView, replayed: false };
  });
}
