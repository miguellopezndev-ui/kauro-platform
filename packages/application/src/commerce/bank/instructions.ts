/**
 * Transfer-instruction issuance and the sensitive-instructions projection of the bank-transfer route (lane L-ROUTE; ACH-ROUTE r12 §7.2 I1
 * and I2 `Kinstructions`, §7.24 I2Δ, §7.3 I3; D-ACH-04, D-ACH-05, D-ACH-16, DV1-07, K-9).
 *
 * ISSUANCE — CMD028 CreatePaymentOrder with `routeKind: "BANK_TRANSFER"` and `routeId` (its closed request schema), in ONE commerce unit of
 * work of the agency's billing member (TENANT), its locks in the B09 order of the provider CMD028 (D-ACH-04 "locks checkout facts in B09
 * order"; lock-order note of migration 0046; adversary r1 ADV-PV1R-1): the member's access decision (B06: AGENCY_BILLING, identity and
 * membership halves) — before any tenant row is locked or read (ADV-PV1R-10) — the journal, the project row FOR NO KEY UPDATE, the
 * purchased subject's shared halves (agency → capability → approval → source revision → target contract), the route FOR SHARE (it
 * conflicts with Kroute, never with another issuance) and the quote FOR UPDATE last; the effect instant after every wait. A closure of the
 * agency (CMD043: the agency's exclusive half, then the quote) therefore never meets an issuance holding the quote. Preconditions in order:
 * the quote visible (NOT_FOUND) and its terms (STALE_VERSION HASH_MISMATCH); the route ENABLED at its verified current version and open to
 * the agency (CONTROLLED allowlist in force or GENERAL) — else ROUTE_NOT_ENABLED; checkout readiness at the effect instant (an open order
 * of the project: PAYMENT_PENDING OPEN_ORDER_EXISTS; a withdrawn approval: PLAN_WITHDRAWN; the other blockers as CMD028 answers them); the
 * verified details still valid (DETAILS_EXPIRED); the transfer window (TRANSFER_WINDOW_TOO_SHORT) against transferExpiresAt = min(effect +
 * lifetime, price expiry, source availability deadline, details validity) (ADV-PV1R-2). Writes: the quote ACCEPTED_FOR_CHECKOUT (first
 * order), the order INTENT_CREATED (its payment route the bank route's), its PAYMENT_ORDER scope, the immutable snapshot with its
 * 23-character reference (a collision draws another before COMMIT) and frozen sendBy, the snapshot's event; the journaled 201 with the
 * order, the quote and `transfer`. The vendored PaymentOrder machine is not extended: the bank state is the snapshot's `order_state`.
 *
 * PROJECTION — GET /api/v1/payment-orders/{orderId}/transfer-instructions (no-store, no ETag), one unit of work. A first access decision,
 * under a savepoint rolled back at once: a caller who is not a member of the agency it names reads no tenant row and no evidence byte
 * (ADV-PV1R-10). Then the snapshot and the route's evidence reference, the details artifact read from the restricted store and classified (internal
 * store read; no membership lock is held across it, so a withdrawal meanwhile is never blocked by the read), and at the guard instant
 * after it: the member's access again, the caller's session again (ADV-PV1R-6), the route FOR SHARE, the agency still on the allowlist in
 * force (else the foreign answer NOT_FOUND, ADV-PV1R-5), the bank order re-read (served only while AWAITING_TRANSFER,
 * D-ACH-05, ADV-PV1R-12; else INSTRUCTIONS_NOT_AVAILABLE, ADV-PV1R-3) and the effect instant: the details validity
 * (INSTRUCTIONS_NOT_AVAILABLE) and the instruction deadline (INSTRUCTIONS_EXPIRED). Every failure of the evidence is answered after these,
 * and no part of the snapshot is ever answered with a refusal.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommerceUnitOfWork, MembershipId, PaymentOrderId, PaymentOrderRecord, QuoteId, QuoteRecord, ResolvedMembership, TenantContext, UserId } from "@kauro/domain";
import { BANK_TRANSFER_ROUTE_KIND, DomainFailure, NotFoundFailure, StaleVersionFailure, actorOf, blockerFailure, checkoutBlockers, paymentIntentHash, toUtcInstant, transferReferenceOf, transferWindowOf } from "@kauro/domain";
import type { CommandEnvelope, CommandResult } from "../../api/envelope.js";
import { problemOf, type Problem } from "../../api/problems.js";
import type { ReadRequest } from "../../queries/reads.js";
import { CREATE_PAYMENT_ORDER, type CreatePaymentOrderBody } from "../contracts.js";
import type { CreatePaymentOrderView } from "../views.js";
import { checkoutFactsOf, quoteIsPaid, quoteViewOf, readCheckoutPrerequisites } from "../request/checkout.js";
import { paymentOrderView } from "../request/projections.js";
import { CommerceAccessDenied, recordCommerceDenial, runCommerceCommand, tenantContextOf, type CommerceRequestCollaborators, type CommerceRequestRuntime } from "../request/runtime.js";
import type { BankRouteCollaborators } from "./ports.js";
import { bankPayeeDigest, evidenceUnavailable, readRouteDetails } from "./route-config.js";

export interface BankTransferView {
  readonly routeId: string;
  readonly routeVersion: number;
  readonly bankState: string;
  readonly reference: string;
  readonly amountCents: string;
  readonly currency: "USD";
  readonly transferExpiresAt: UtcInstant;
  readonly sendBy: UtcInstant;
}

export interface TransferInstructionsView {
  readonly instructions: {
    readonly beneficiaryName: string;
    readonly bankName: string;
    readonly routingNumber: string;
    readonly accountNumber: string;
    readonly accountType: string;
    readonly amountCents: string;
    readonly currency: "USD";
    readonly reference: string;
    readonly sendBy: UtcInstant;
    readonly transferExpiresAt: UtcInstant;
    readonly routeVersion: number;
  };
}

const routeNotEnabled = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the bank route is not enabled for this buyer", { reason: "ROUTE_NOT_ENABLED" });
const openOrderExists = (): DomainFailure => new DomainFailure("PAYMENT_PENDING", "the project already has an open order", { reason: "OPEN_ORDER_EXISTS" }, true);
const MAX_REFERENCE_DRAWS = 8;

/**
 * The source availability deadline a transfer may not outlive (D-ACH-04; 07 "a fourteen-day price lifetime does not extend seven-day
 * source retention"): the quote's own promise, and the source lifecycle's effective deadline when its reader is bound (the earlier one).
 * NaN (nothing issuable) when the bound reader names no sealed revision; checkout readiness has refused such a quote already.
 */
async function sourceDeadlineMs(uow: CommerceUnitOfWork, co: Pick<CommerceRequestCollaborators, "sources">, quote: QuoteRecord): Promise<number> {
  const promised = Date.parse(quote.sourceAvailableUntil);
  if (co.sources === null) return promised;
  const availability = await co.sources.availabilityOf(uow, { agencyId: quote.agencyId, projectId: quote.projectId, revisionHash: quote.revisionHash });
  return availability === null ? Number.NaN : Math.min(promised, Date.parse(availability.effectiveDeadline));
}

/** CMD028 with routeKind BANK_TRANSFER (I1 + I2). */
export async function issueBankTransfer(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators, envelope: CommandEnvelope<CreatePaymentOrderBody>): Promise<CommandResult<CreatePaymentOrderView>> {
  const bank = co.bank ?? null;
  const context = tenantContextOf(envelope);
  const agencyId = context.agencyId;
  const quoteId = envelope.path["quoteId"] as QuoteId;
  const routeId = envelope.body.routeId ?? "";
  let membership: ResolvedMembership | null = null;
  return runCommerceCommand<CreatePaymentOrderBody, CreatePaymentOrderView>(runtime, {
    command: CREATE_PAYMENT_ORDER,
    envelope,
    context,
    async access(uow) {
      // the member's access decision first, as the provider CMD028 (B09 order): nothing of the agency is locked for a caller who is not
      // its member (ADV-PV1R-10); the membership halves are held to COMMIT, so a revocation is ordered before or after the issuance
      const decision = await runtime.authorizer.authorize(uow, { command: "CMD028", identity: envelope.subject.identity, agencyId });
      if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD028", decision);
      membership = decision.membership;
    },
    async body(uow, causationId, now) {
      if (bank === null) throw evidenceUnavailable();
      const c = uow.commerce;
      const repo = bank.routes(uow);
      const seen = await c.quotes.get(quoteId);
      if (seen === null || seen.agencyId !== agencyId || seen.replacesQuoteId !== undefined) throw new NotFoundFailure("quote");
      // the lock order of migration 0046 (D-ACH-04, B09): project, the purchased subject's shared halves, the route, the quote last
      if (!(await repo.lockProject(agencyId, seen.projectId))) throw new NotFoundFailure("quote");
      const read = await readCheckoutPrerequisites(uow, co, seen, null);
      const r = await repo.lockShare(routeId);
      const q: QuoteRecord | null = await c.quotes.lock(quoteId);
      if (q === null || q.agencyId !== agencyId || q.replacesQuoteId !== undefined) throw new NotFoundFailure("quote");
      if (envelope.body.termsHash !== q.termsHash) throw new StaleVersionFailure(q.version, q.state, { reason: "HASH_MISMATCH", mismatch: ["termsHash"] });
      if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an issuance was authorized without a membership");
      const member: ResolvedMembership = membership;
      // I1: the route, then the purchased subject, capacity and payment state, all judged at the effect instant read after the waits
      if (r === null || r.state !== "ENABLED" || r.rollout === null) throw routeNotEnabled();
      if (r.rollout === "CONTROLLED" && !(await repo.isParticipant(r, agencyId))) throw routeNotEnabled();
      const version = await repo.version(r.routeId, r.currentVersion);
      if (version === null || version.verifiedAt === null || version.detailsValidUntil === null) throw routeNotEnabled();
      const openOrder = await c.orders.findOpenForProject(q.projectId);
      const paid = await quoteIsPaid(uow, co, q);
      const effect = await bank.effectNow(uow);
      const facts = await checkoutFactsOf(uow, co, q, read, { openOrder, paid }, effect);
      // the bank route stands for the merchant route of a provider checkout (checked above)
      const blockers = checkoutBlockers({ ...facts, paymentRoute: { state: "QUALIFIED" } });
      const first = blockers[0];
      if (first !== undefined) {
        if (first === "PAYMENT_IN_PROGRESS" || first === "PAYMENT_UNCERTAIN") throw openOrderExists();
        if (first === "APPROVAL_NOT_CURRENT" && (read.subject?.approval?.withdrawnAt !== undefined || read.subject?.plan?.state === "WITHDRAWN")) {
          throw new DomainFailure("PRECONDITION_FAILED", "the plan's approval was withdrawn", { reason: "PLAN_WITHDRAWN" });
        }
        if (first === "QUOTE_NOT_ACTIVE" || first === "QUOTE_EXPIRED") throw new DomainFailure("PRECONDITION_FAILED", `commercial prerequisite not met: ${first}`, { reason: first, currentVersion: q.version, currentState: q.state });
        if (first === "AGENCY_NOT_ACTIVE") {
          // answered as the provider CMD028 answers it (outcome catalogue: the agency's current version and state)
          const agency = await uow.agencies.get(q.agencyId);
          if (agency === null) throw new DomainFailure("INTEGRITY_FAILURE", "the agency of a visible quote is not visible");
          throw new DomainFailure("PRECONDITION_FAILED", "the agency is not ACTIVE", { reason: "AGENCY_NOT_ACTIVE", currentVersion: agency.version, currentState: agency.state });
        }
        throw blockerFailure(first);
      }
      // the verified details' validity, then the window against every fixed deadline (D-ACH-04, DV1-07; ADV-PV1R-2)
      const effectMs = Date.parse(effect);
      const detailsValidUntilMs = Date.parse(version.detailsValidUntil);
      if (!(effectMs < detailsValidUntilMs)) throw new DomainFailure("PRECONDITION_FAILED", "the route's verified account details expired", { reason: "DETAILS_EXPIRED" });
      const window = transferWindowOf(effectMs, [Date.parse(q.expiresAt), await sourceDeadlineMs(uow, co, q), detailsValidUntilMs], version);
      if (window.kind === "TOO_SHORT") throw new DomainFailure("PRECONDITION_FAILED", "the transfer window left is shorter than the route's minimum", { reason: "TRANSFER_WINDOW_TOO_SHORT" });
      // I2 (Kinstructions)
      if (q.state === "ISSUED") {
        const accepted = await c.quotes.transition(quoteId, q.version, { state: "ACCEPTED_FOR_CHECKOUT" }, now);
        if (accepted.kind === "STALE") throw new StaleVersionFailure(accepted.currentVersion, accepted.currentState);
      }
      const orderId = uow.ids.next() as PaymentOrderId;
      let order: PaymentOrderRecord;
      try {
        order = await c.orders.insert({
          orderId,
          agencyId,
          projectId: q.projectId,
          quoteId,
          approvalId: q.approvalId,
          route: { routeId: r.paymentRouteId as never, provider: r.provider as never, environment: r.environment, merchantRef: r.routeId as never, payeeDigest: bankPayeeDigest(r.environment, r.accountRef), currency: "USD" },
          expectedAmountCents: q.totalCents,
          expectedServiceCents: q.serviceCents,
          expectedTaxCents: q.taxCents,
          termsHash: q.termsHash,
          idempotencyHash: paymentIntentHash({ quoteId, termsHash: q.termsHash, expectedAmountCents: q.totalCents.toString(), currency: "USD", routeId: r.paymentRouteId as never, provider: r.provider as never, environment: r.environment }),
          createdByMembershipId: member.membershipId as MembershipId,
          intentEntryId: causationId as never,
          createdAt: now,
        });
      } catch (e) {
        if (e instanceof DomainFailure && e.details.reason === "CREATION_IN_PROGRESS") throw openOrderExists();
        throw e;
      }
      await uow.scopes.record({ kind: "PAYMENT_ORDER", key: orderId, agencyId, orderId }, now);
      let snapshot = null;
      for (let draw = 0; draw < MAX_REFERENCE_DRAWS && snapshot === null; draw++) {
        snapshot = await repo.insertInstructions({
          orderId,
          agencyId,
          routeId: r.routeId,
          routeVersion: r.currentVersion,
          environment: r.environment,
          accountRef: r.accountRef,
          reference: transferReferenceOf(bank.random(20)),
          amountCents: q.totalCents,
          transferExpiresAt: toUtcInstant(window.transferExpiresAtMs),
          sendBy: toUtcInstant(window.sendByMs),
          issuedAt: effect,
        });
      }
      if (snapshot === null) throw new DomainFailure("CAPACITY_UNAVAILABLE", "no free transfer reference was drawn", {}, true);
      await uow.events.publish({
        aggregateKind: "bank_transfer_instruction",
        aggregateId: orderId as never,
        aggregateVersion: snapshot.version,
        agencyId,
        eventType: "bank_transfer_instruction.issued.v1",
        actor: actorOf(context),
        causationId,
        correlationId: context.correlationId,
        payload: { orderId, agencyId, routeId: r.routeId, routeVersion: r.currentVersion, state: snapshot.orderState },
      });
      const view: CreatePaymentOrderView = {
        order: paymentOrderView(order, []),
        quote: await quoteViewOf(uow, co, (await c.quotes.get(quoteId)) ?? q, member.role, now),
        transfer: {
          routeId: r.routeId,
          routeVersion: snapshot.routeVersion,
          bankState: snapshot.orderState,
          reference: snapshot.reference,
          amountCents: snapshot.amountCents.toString(),
          currency: "USD",
          transferExpiresAt: snapshot.transferExpiresAt as UtcInstant,
          sendBy: snapshot.sendBy as UtcInstant,
        },
      };
      return { status: 201, view, version: order.version, resourceKind: "payment_order", resourceId: orderId };
    },
  });
}

/** True when CMD028's body names the bank-transfer route. */
export function isBankTransferRequest(body: CreatePaymentOrderBody): boolean {
  return body.routeKind === BANK_TRANSFER_ROUTE_KIND;
}

/**
 * The bank order states whose instructions stay readable (D-ACH-05): EXPIRED stops them, RECEIVED_REVIEW and CAPTURED are closed.
 * PARTIALLY_RECEIVED is excluded until L-INBOUND E1 provides the remaining amount (ADV-PV1R-12): the snapshot carries only the full obligation,
 * which must never be shown as the amount to send once a partial credit landed. Fails closed: INSTRUCTIONS_NOT_AVAILABLE.
 */
const OPEN_BANK_ORDER_STATES: ReadonlySet<string> = new Set(["AWAITING_TRANSFER"]);
const instructionsNotAvailable = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "the transfer instructions are not available", { reason: "INSTRUCTIONS_NOT_AVAILABLE" });

/** The caller's session ended (revoked or expired) before the guard instant: answered as an unauthenticated request (the unit of work returns it: a throw would be an internal error). */
const SESSION_ENDED = Symbol("SESSION_ENDED");

/** I3: the authorized projection of the order's transfer instructions. */
export async function readTransferInstructions(
  runtime: CommerceRequestRuntime,
  bank: BankRouteCollaborators | null,
  request: Pick<ReadRequest, "subject" | "agencyId" | "correlationId"> & {
    readonly orderId: string;
    /** Re-authenticates the request's own credentials at the guard instant (a cookie session revoked or expired meanwhile: false). */
    readonly stillAuthenticated?: () => Promise<boolean>;
  },
): Promise<{ readonly kind: "READ"; readonly view: TransferInstructionsView } | { readonly kind: "PROBLEM"; readonly problem: Problem } | { readonly kind: "UNAUTHENTICATED" }> {
  const action = "READ_TRANSFER_INSTRUCTIONS";
  if (request.agencyId === null) return { kind: "PROBLEM", problem: problemOf(new DomainFailure("INVALID_REQUEST", `${action} needs an agency selector`, { reason: "TENANT_CONTEXT_MISSING" }), request.correlationId) };
  const context: TenantContext = { kind: "TENANT", agencyId: request.agencyId, userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
  let accessDenied = false;
  const authorize = async (uow: CommerceUnitOfWork): Promise<void> => {
    const access = await runtime.authorizer.authorizeRead(uow, { identity: request.subject.identity, agencyId: context.agencyId });
    if (access.kind === "DENY") {
      accessDenied = true;
      throw CommerceAccessDenied.of(action, access);
    }
  };
  try {
    const view = await runtime.unitOfWork.run(context, async (uow): Promise<TransferInstructionsView | typeof SESSION_ENDED> => {
      if (bank === null) throw evidenceUnavailable();
      const repo = bank.routes(uow);
      // the caller's membership first, read under a savepoint rolled back at once: a caller with no ACTIVE membership in the agency it names
      // reads no tenant row and no evidence byte (ADV-PV1R-10) and gets the access decision's own answer now; no membership half is held
      // across the store read, so a withdrawal meanwhile is never blocked by the read. The decision that judges the answer is the one taken
      // at the guard instant below.
      const member = await repo.released(() => uow.memberships.findLive(context.agencyId, context.userId));
      // (a membership that became ACTIVE between the two reads is then allowed here: the unit resolves it once, and it is not re-decided)
      let decided = false;
      if (member === null || member.state !== "ACTIVE") {
        await authorize(uow);
        decided = true;
      }
      // the snapshot and the evidence it was issued under (plain reads: no lock is held across the store read)
      const snapshot = await repo.instructionsOf(request.orderId);
      const seen = snapshot === null ? null : await repo.read(snapshot.routeId);
      const version = snapshot === null ? null : await repo.version(snapshot.routeId, snapshot.routeVersion);
      let details: Awaited<ReturnType<typeof readRouteDetails>>["details"] | null = null;
      let evidenceFailure: DomainFailure | null = null;
      if (snapshot !== null && version !== null && seen !== null) {
        try {
          // bound to the snapshot's account and the route's provider and integration class (ADV-PV1R-11)
          details = (await readRouteDetails(bank, version.detailsArtifactRef, version.detailsEvidenceHash, { accountRef: snapshot.accountRef, environment: snapshot.environment, provider: seen.provider, integrationClass: seen.integrationClass })).details;
        } catch (e) {
          if (!(e instanceof DomainFailure)) throw e;
          evidenceFailure = e;
        }
      }
      // the guard instant, after the store read: the member's access, the session, the route guard, the bank order and the effect instant
      if (!decided) await authorize(uow);
      if (request.stillAuthenticated !== undefined && !(await request.stillAuthenticated())) return SESSION_ENDED;
      if (snapshot === null || version === null || seen === null) throw new NotFoundFailure("payment order");
      const route = await repo.lockShare(snapshot.routeId);
      // an agency dropped from the CONTROLLED allowlist in force gets the foreign agency's answer (ADV-PV1R-5, ruling RR-3)
      if (route !== null && route.state === "ENABLED" && route.rollout === "CONTROLLED" && !(await repo.isParticipant(route, context.agencyId))) throw new NotFoundFailure("payment order");
      if (route === null || route.state !== "ENABLED" || route.currentVersion !== snapshot.routeVersion) throw routeNotEnabled();
      // the bank order as it stands at the guard (the payment service moves it): served only while open (D-ACH-05; ADV-PV1R-3, ruling RR-2)
      const current = await repo.instructionsOf(request.orderId);
      if (current === null) throw new NotFoundFailure("payment order");
      if (!OPEN_BANK_ORDER_STATES.has(current.orderState)) throw instructionsNotAvailable();
      const effect = Date.parse(await bank.effectNow(uow));
      if (details !== null && !(effect < Date.parse(details.validUntil))) throw instructionsNotAvailable();
      if (effect >= Date.parse(current.transferExpiresAt)) throw new DomainFailure("PRECONDITION_FAILED", "the transfer instructions expired", { reason: "INSTRUCTIONS_EXPIRED" });
      if (evidenceFailure !== null) throw evidenceFailure;
      if (details === null) throw evidenceUnavailable();
      // PV1R-02: the session judged again after the last blocking wait (the route share lock, the order and deadline guards) and
      // immediately before the secret-bearing view: a session revoked or expired during those waits gets the authentication refusal
      if (request.stillAuthenticated !== undefined && !(await request.stillAuthenticated())) return SESSION_ENDED;
      const view: TransferInstructionsView = {
        instructions: {
          beneficiaryName: details.beneficiaryName,
          bankName: details.bankName,
          routingNumber: details.routingNumber,
          accountNumber: details.accountNumber,
          accountType: details.accountType,
          amountCents: current.amountCents.toString(),
          currency: "USD",
          reference: current.reference,
          sendBy: current.sendBy as UtcInstant,
          transferExpiresAt: current.transferExpiresAt as UtcInstant,
          routeVersion: current.routeVersion,
        },
      };
      return view;
    });
    if (view === SESSION_ENDED) return { kind: "UNAUTHENTICATED" };
    return { kind: "READ", view };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (accessDenied || e.code === "NOT_AUTHORIZED" || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, action, e, request.agencyId);
    return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
  }
}
