/**
 * Transfer-instruction issuance and the sensitive-instructions projection of the bank-transfer route (lane L-ROUTE; ACH-ROUTE r12 §7.2 I1
 * and I2 `Kinstructions`, §7.24 I2Δ, §7.3 I3; D-ACH-04, D-ACH-16, DV1-07, K-9).
 *
 * ISSUANCE — CMD028 CreatePaymentOrder with `routeKind: "BANK_TRANSFER"` and `routeId` (its closed request schema), in ONE commerce unit of
 * work of the agency's billing member (TENANT): the quote row FOR UPDATE (the purchased subject's lock), then the route FOR SHARE (it
 * conflicts with Kroute, never with another issuance), both BEFORE the member's access decision so a revocation committed while the
 * issuance waits is never blocked by it (lock-order note of migration 0046); then access (B06: AGENCY_BILLING), the journal, the B09 subject
 * reads and the effect instant AFTER every wait. Preconditions in order: the quote visible (NOT_FOUND) and its terms (STALE_VERSION
 * HASH_MISMATCH); the route ENABLED at its verified current version and open to the agency (CONTROLLED allowlist or GENERAL) — else
 * ROUTE_NOT_ENABLED; checkout readiness at the effect instant (an open order of the project: PAYMENT_PENDING OPEN_ORDER_EXISTS; a
 * withdrawn approval: PLAN_WITHDRAWN; the other blockers as CMD028 answers them); the transfer window (TRANSFER_WINDOW_TOO_SHORT).
 * Writes: the quote ACCEPTED_FOR_CHECKOUT (first order), the order INTENT_CREATED (its payment route the bank route's), its PAYMENT_ORDER
 * scope, the immutable snapshot with its 23-character reference (a collision draws another before COMMIT) and frozen sendBy, the
 * snapshot's event; the journaled 201 with the order, the quote and `transfer`. The vendored PaymentOrder machine is not extended: the bank
 * state is the snapshot's `order_state`.
 *
 * PROJECTION — GET /api/v1/payment-orders/{orderId}/transfer-instructions (no-store, no ETag): one unit of work. The snapshot and the
 * route's evidence reference are read, the details artifact is read from the restricted store and classified (internal store read, no
 * external call-out; before the access decision so a withdrawal meanwhile is never blocked by the read), then the member's access, the route
 * FOR SHARE and the effect instant. Served only while the route is ENABLED at the snapshot's version and the deadline has not passed; every
 * failure of the evidence is answered after the access decision and the route guard, and no part of the snapshot is ever answered with it.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { MembershipId, PaymentOrderId, PaymentOrderRecord, QuoteId, QuoteRecord, ResolvedMembership, TenantContext, UserId } from "@kauro/domain";
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

/** CMD028 with routeKind BANK_TRANSFER (I1 + I2). */
export async function issueBankTransfer(runtime: CommerceRequestRuntime, co: CommerceRequestCollaborators, envelope: CommandEnvelope<CreatePaymentOrderBody>): Promise<CommandResult<CreatePaymentOrderView>> {
  const bank = co.bank ?? null;
  const context = tenantContextOf(envelope);
  const agencyId = context.agencyId;
  const quoteId = envelope.path["quoteId"] as QuoteId;
  const routeId = envelope.body.routeId ?? "";
  let quote: QuoteRecord | null = null;
  let route: Awaited<ReturnType<ReturnType<BankRouteCollaborators["routes"]>["lockShare"]>> = null;
  let membership: ResolvedMembership | null = null;
  return runCommerceCommand<CreatePaymentOrderBody, CreatePaymentOrderView>(runtime, {
    command: CREATE_PAYMENT_ORDER,
    envelope,
    context,
    async access(uow) {
      // the subject (quote) and the route locks first, then the member's access decision (lock-order note, migration 0046)
      quote = await uow.commerce.quotes.lock(quoteId);
      route = bank === null ? null : await bank.routes(uow).lockShare(routeId);
      const decision = await runtime.authorizer.authorize(uow, { command: "CMD028", identity: envelope.subject.identity, agencyId });
      if (decision.kind === "DENY") throw CommerceAccessDenied.of("CMD028", decision);
      membership = decision.membership;
    },
    async body(uow, causationId, now) {
      if (bank === null) throw evidenceUnavailable();
      const c = uow.commerce;
      const repo = bank.routes(uow);
      const q = quote;
      if (q === null || q.agencyId !== agencyId || q.replacesQuoteId !== undefined) throw new NotFoundFailure("quote");
      if (envelope.body.termsHash !== q.termsHash) throw new StaleVersionFailure(q.version, q.state, { reason: "HASH_MISMATCH", mismatch: ["termsHash"] });
      if (membership === null) throw new DomainFailure("INTEGRITY_FAILURE", "an issuance was authorized without a membership");
      const member: ResolvedMembership = membership;
      // I1: the route, then the purchased subject, capacity and payment state, all judged at the effect instant read after the waits
      const r = route;
      if (r === null || r.state !== "ENABLED" || r.rollout === null) throw routeNotEnabled();
      if (r.rollout === "CONTROLLED" && !(await repo.isParticipant(r, agencyId))) throw routeNotEnabled();
      const version = await repo.version(r.routeId, r.currentVersion);
      if (version === null || version.verifiedAt === null) throw routeNotEnabled();
      const read = await readCheckoutPrerequisites(uow, co, q, null);
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
        throw blockerFailure(first);
      }
      const window = transferWindowOf(Date.parse(effect), Date.parse(q.expiresAt), version);
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

/** I3: the authorized projection of the order's transfer instructions. */
export async function readTransferInstructions(
  runtime: CommerceRequestRuntime,
  bank: BankRouteCollaborators | null,
  request: Pick<ReadRequest, "subject" | "agencyId" | "correlationId"> & { readonly orderId: string },
): Promise<{ readonly kind: "READ"; readonly view: TransferInstructionsView } | { readonly kind: "PROBLEM"; readonly problem: Problem }> {
  const action = "READ_TRANSFER_INSTRUCTIONS";
  if (request.agencyId === null) return { kind: "PROBLEM", problem: problemOf(new DomainFailure("INVALID_REQUEST", `${action} needs an agency selector`, { reason: "TENANT_CONTEXT_MISSING" }), request.correlationId) };
  const context: TenantContext = { kind: "TENANT", agencyId: request.agencyId, userId: request.subject.identity.userId as UserId, correlationId: request.correlationId };
  let accessDenied = false;
  try {
    const view = await runtime.unitOfWork.run(context, async (uow) => {
      if (bank === null) throw evidenceUnavailable();
      const repo = bank.routes(uow);
      // the snapshot and the evidence it was issued under (plain reads: no lock is held across the store read)
      const snapshot = await repo.instructionsOf(request.orderId);
      const seen = snapshot === null ? null : await repo.read(snapshot.routeId);
      const version = snapshot === null ? null : await repo.version(snapshot.routeId, snapshot.routeVersion);
      let details: Awaited<ReturnType<typeof readRouteDetails>>["details"] | null = null;
      let evidenceFailure: DomainFailure | null = null;
      if (snapshot !== null && version !== null) {
        try {
          details = (await readRouteDetails(bank, version.detailsArtifactRef, version.detailsEvidenceHash, snapshot)).details;
        } catch (e) {
          if (!(e instanceof DomainFailure)) throw e;
          evidenceFailure = e;
        }
      }
      // the member's access, the route guard and the effect instant, all after the store read
      const access = await runtime.authorizer.authorizeRead(uow, { identity: request.subject.identity, agencyId: context.agencyId });
      if (access.kind === "DENY") {
        accessDenied = true;
        throw CommerceAccessDenied.of(action, access);
      }
      if (snapshot === null || version === null || seen === null) throw new NotFoundFailure("payment order");
      const route = await repo.lockShare(snapshot.routeId);
      if (route === null || route.state !== "ENABLED" || route.currentVersion !== snapshot.routeVersion) throw routeNotEnabled();
      const effect = await bank.effectNow(uow);
      if (Date.parse(effect) >= Date.parse(snapshot.transferExpiresAt)) throw new DomainFailure("PRECONDITION_FAILED", "the transfer instructions expired", { reason: "INSTRUCTIONS_EXPIRED" });
      if (evidenceFailure !== null) throw evidenceFailure;
      if (details === null) throw evidenceUnavailable();
      const view: TransferInstructionsView = {
        instructions: {
          beneficiaryName: details.beneficiaryName,
          bankName: details.bankName,
          routingNumber: details.routingNumber,
          accountNumber: details.accountNumber,
          accountType: details.accountType,
          amountCents: snapshot.amountCents.toString(),
          currency: "USD",
          reference: snapshot.reference,
          sendBy: snapshot.sendBy as UtcInstant,
          transferExpiresAt: snapshot.transferExpiresAt as UtcInstant,
          routeVersion: snapshot.routeVersion,
        },
      };
      return view;
    });
    return { kind: "READ", view };
  } catch (e) {
    if (!(e instanceof DomainFailure) || e.code === "INTERNAL_ERROR") throw e;
    if (accessDenied || e.code === "NOT_AUTHORIZED" || e.code === "AUTHENTICATION_REQUIRED") await recordCommerceDenial(runtime, context, action, e, request.agencyId);
    return { kind: "PROBLEM", problem: problemOf(e, request.correlationId) };
  }
}
