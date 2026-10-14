/**
 * The payment service's side of the inbound bank-transfer credits (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.9 M1,
 * §7.10 P1, §7.12 E1, §7.28): handlers registered on the bank-transfer seam of consumers.ts and sweep.ts, each one SERVICE unit of
 * work of the payment service's pool. A credit is agency-less; the order a credit names is found by its canonical reference and
 * the service adopts that order's stored operation (D-SCOPE-B1) only after the lookup, never from a payload.
 *
 * Lock order (ACH-ROUTE §7.28): the account's INBOUND stream lock, then the credit identity lock Lc, then the order's own locks.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommerceEventDelivery, ProviderOrderObservation } from "@kauro/application";
import { bankPayeeDigest, fileRemedyReturns, publishCreditEvent, publishOrderStateEvent } from "@kauro/application";
import type { BankApplyJudgment, BankTransferInstructionRecord, CausationId, CommerceUnitOfWork, CorrelationId, MatchKeys, PaymentOrderId } from "@kauro/domain";
import { bankOrderStateAfterApply, DomainFailure, effectNowOf, judgeBankApply, matchDecision } from "@kauro/domain";
import { bankCreditsOf, bankRoutesOf, type BankCheckoutRetirementRecord } from "@kauro/persistence";
import { registerBankDeliveryHandler, type ConsumerOutcome } from "./consumers.js";
import { causedBy, type PaymentRuntime } from "./runtime.js";
import { registerBankSweep } from "./sweep.js";

const serviceContext = (rt: PaymentRuntime) => ({ kind: "SERVICE" as const, serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId });

/** M1 + Kmatch: the lookup of a confirmed credit by its canonical reference and the frozen keys of the order it names. */
export async function matchCredit(rt: PaymentRuntime, delivery: CommerceEventDelivery): Promise<ConsumerOutcome> {
  const creditId = delivery.aggregateId;
  return rt.assembly.commerce.run(serviceContext(rt), async (uow: CommerceUnitOfWork): Promise<ConsumerOutcome> => {
    const repo = bankCreditsOf(uow as never);
    const seen = await repo.credit(creditId);
    if (seen === null) return "NOT_APPLICABLE";
    await repo.lockStream(seen.environment, seen.accountRef, "INBOUND");
    const credit = await repo.lockCredit(creditId);
    // a redelivery after the decision, or a credit an owner already attributed, is the committed outcome
    if (credit === null || credit.state !== "OBSERVED") return "DUPLICATE";
    causedBy(uow, delivery.eventId);
    const causationId = delivery.eventId as unknown as CausationId;
    const instruction = credit.reference === null ? null : await repo.instructionByReference(credit.environment, credit.accountRef, credit.reference);
    let keys: MatchKeys | null = null;
    if (instruction !== null) {
      const route = await bankRoutesOf(uow as never).version(instruction.routeId, instruction.routeVersion);
      const adopted = route === null ? null : await uow.adoptScope("PAYMENT_ORDER", instruction.orderId);
      // the order the reference names must exist in its agency and be the instruction's (a second, independent lookup)
      const order = adopted === null ? null : await uow.commerce.orders.get(instruction.orderId as never);
      if (route !== null && order !== null && adopted === instruction.agencyId) {
        keys = {
          orderId: instruction.orderId,
          reference: instruction.reference,
          expectedAmountCents: instruction.amountCents,
          currency: instruction.currency,
          acceptedPayerDigest: (await repo.acceptedPayerDigestOf(instruction.orderId)) as MatchKeys["acceptedPayerDigest"],
          payeeDigest: route.payeeDigest,
          acceptedRails: route.acceptedRails,
          transferExpiresAt: instruction.transferExpiresAt,
          providerTimeToleranceMs: route.providerTimeToleranceMs,
          accountRef: instruction.accountRef,
        };
      }
    }
    const decision = matchDecision(credit, keys);
    if (decision.kind === "MATCHED" && keys !== null) {
      const written = await repo.transitionCredit(creditId, credit.version, { state: "MATCHED", orderId: keys.orderId });
      if (written.kind === "STALE") return "DUPLICATE";
      await publishCreditEvent(uow, causationId, written.record, "bank_credit.matched.v1", { orderId: keys.orderId, state: written.record.state, previousState: credit.state, decision: "RULE_MATCH" });
      return "APPLIED";
    }
    const reason = decision.kind === "REVIEW" ? decision.reason : "NO_ORDER";
    const written = await repo.transitionCredit(creditId, credit.version, { state: "MATCH_REVIEW" });
    if (written.kind === "STALE") return "DUPLICATE";
    await repo.openCreditCase(uow.ids.next(), "MATCH_REVIEW", credit, reason);
    await publishCreditEvent(uow, causationId, written.record, "bank_credit.review_required.v1", { state: written.record.state, previousState: credit.state, reason });
    return "APPLIED";
  });
}

/** The capture identity of a credit: its namespaced credit id, never an invented provider order identity (D-ACH-09). */
export const creditCaptureRef = (creditId: string): string => `bank-credit:${creditId}`;

/**
 * P1 Kapply (§7.10, §7.24 P1Δ, DV1-06): a MATCHED credit is applied to its order as an ObservedCapture through the one reconciler
 * (allocation, authorization under the subject guards and KP004, AMOUNT_MISMATCH / EXCESS_CAPTURE / CAPTURE_WITHOUT_VALID_SUBJECT and
 * their server refund requests). Lock order: INBOUND stream, Lc, the route's share lock, the subject's shared halves and the order's row
 * lock (the reconciler), then the instruction's row lock; the transfer deadline, provider time, route and retirement are judged at the
 * database clock read after that last lock. The credit becomes APPLIED with its capture and the bank order takes its next state.
 */
export async function applyCredit(rt: PaymentRuntime, delivery: CommerceEventDelivery): Promise<ConsumerOutcome> {
  const creditId = delivery.aggregateId;
  return rt.assembly.commerce.run(serviceContext(rt), async (uow: CommerceUnitOfWork): Promise<ConsumerOutcome> => {
    const repo = bankCreditsOf(uow as never);
    const seen = await repo.credit(creditId);
    if (seen === null) return "NOT_APPLICABLE";
    await repo.lockStream(seen.environment, seen.accountRef, "INBOUND");
    const credit = await repo.lockCredit(creditId);
    // a redelivery after the application (or after an owner's review) is the committed outcome
    if (credit === null || credit.state !== "MATCHED" || credit.orderId === null) return "DUPLICATE";
    causedBy(uow, delivery.eventId);
    const causationId = delivery.eventId as unknown as CausationId;
    const orderId = credit.orderId;
    const placed = await repo.instruction(orderId);
    if (placed === null || placed.environment !== credit.environment || placed.accountRef !== credit.accountRef) throw new DomainFailure("INTEGRITY_FAILURE", "a matched credit names an order of another account");
    if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) !== placed.agencyId) throw new DomainFailure("INTEGRITY_FAILURE", "the matched order is not in its instruction's agency");
    const routes = bankRoutesOf(uow as never);
    const route = await routes.lockShare(placed.routeId);
    const version = await routes.version(placed.routeId, placed.routeVersion);
    if (route === null || version === null) throw new DomainFailure("INTEGRITY_FAILURE", "the instruction's route version is not readable");
    const confirmedAt = await repo.confirmedAtOf(creditId);
    const captureRef = creditCaptureRef(creditId);
    const observedAt = await effectNowOf(uow);
    const observation: ProviderOrderObservation = {
      providerOrderId: null,
      orderStatus: "COMPLETED",
      captures: [
        {
          provider: route.provider,
          environment: credit.environment,
          providerOrderId: null,
          providerCaptureId: captureRef,
          status: "COMPLETED",
          amountCents: credit.grossCents,
          currency: credit.currency,
          payeeDigest: bankPayeeDigest(credit.environment, credit.accountRef),
          providerCompletedAt: (credit.bookedAt ?? null) as UtcInstant | null,
          fundsState: "UNKNOWN",
          feeCents: credit.feeCents,
          evidenceHash: credit.evidenceHash,
        },
      ],
      refunds: [],
      absenceIsProof: false,
      observedAt,
      evidenceHash: credit.evidenceHash,
    };
    const held: { instruction: BankTransferInstructionRecord | null; judged: BankApplyJudgment | null } = { instruction: null, judged: null };
    const result = await rt.reconciler.applyOrderObservation(uow, {
      orderId: orderId as PaymentOrderId,
      source: "PROVIDER_QUERY",
      observation,
      artifactRef: creditId as never,
      causationId,
      now: observedAt,
      afterLocks: async (order) => {
        const instruction = await repo.instruction(orderId, true);
        if (instruction === null) throw new DomainFailure("INTEGRITY_FAILURE", "the instruction vanished under the order's lock");
        // the effect instant: the database clock after the last lock wait
        const effectNow = await effectNowOf(uow);
        const judged = judgeBankApply({
          orderState: instruction.orderState,
          expiryCause: await repo.expiryCauseOf(orderId),
          transferExpiresAt: instruction.transferExpiresAt,
          issuedAt: instruction.issuedAt,
          toleranceMs: version.providerTimeToleranceMs,
          bookedAt: credit.bookedAt,
          confirmedAt,
          effectNow,
          routeEnabled: route.state === "ENABLED",
          anotherPurchase: await repo.anotherLivePurchase(order.agencyId, order.projectId, order.quoteId),
        });
        held.instruction = instruction;
        held.judged = judged;
        return { now: effectNow, authorityBlocker: judged.blocker };
      },
    });
    const locked = held.instruction;
    const judgment = held.judged;
    if (locked === null || judgment === null) throw new DomainFailure("INTEGRITY_FAILURE", "the apply was planned without its instruction");
    if (!judgment.providerTimeVerified) await repo.openCreditCase(uow.ids.next(), "PROVIDER_TIME_UNVERIFIED", credit, "BOOKED_AT_UNVERIFIED");
    const capture = (await uow.commerce.captures.listForOrder(orderId as PaymentOrderId)).find((c) => c.providerCaptureId === captureRef);
    if (capture === undefined) {
      // the reconciler refused the observation as a capture of this order (an exception it recorded): the owner reviews the credit
      const written = await repo.transitionCredit(creditId, credit.version, { state: "MATCH_REVIEW" });
      if (written.kind === "STALE") return "DUPLICATE";
      await repo.openCreditCase(uow.ids.next(), "MATCH_REVIEW", credit, "CAPTURE_NOT_RECORDED");
      await publishCreditEvent(uow, causationId, written.record, "bank_credit.review_required.v1", { state: written.record.state, previousState: credit.state, reason: "CAPTURE_NOT_RECORDED" });
      return "APPLIED";
    }
    const written = await repo.transitionCredit(creditId, credit.version, { state: "APPLIED", captureId: capture.captureId });
    if (written.kind === "STALE") return "DUPLICATE";
    await publishCreditEvent(uow, causationId, written.record, "bank_credit.applied.v1", { orderId, captureId: capture.captureId, state: written.record.state, previousState: credit.state });
    const received = (await repo.appliedCentsOf(orderId, creditId)) + credit.grossCents;
    const next = bankOrderStateAfterApply(locked.orderState, { authorized: result.authorizationIssued !== null, pastDeadline: judgment.pastDeadline, expectedCents: locked.amountCents, receivedCents: received });
    // PARTIALLY_RECEIVED -> PARTIALLY_RECEIVED is a listed edge: each partial receipt is a version of the bank order of its own
    if (next !== locked.orderState || next === "PARTIALLY_RECEIVED") {
      const after = next === "EXPIRED" ? await repo.expireOrder(orderId, locked.version, "DEADLINE") : await repo.setOrderState(orderId, locked.version, next);
      // an expired bank order releases the project's open checkout (D-ACH-05: no further instructions or payment claims)
      if (next === "EXPIRED") await repo.releaseBankSlot(orderId);
      await publishOrderStateEvent(uow, causationId, after, locked.orderState, next === "EXPIRED" ? "TRANSFER_DEADLINE_REACHED" : "CREDIT_APPLIED");
    }
    return "APPLIED";
  });
}

registerBankDeliveryHandler("bank_credit.received.v1", matchCredit);
registerBankDeliveryHandler("bank_credit.matched.v1", applyCredit);

/** The most bank orders one E1 pass expires (the next pass takes the rest). */
const EXPIRY_PASS_LIMIT = 500;

type ExpiryCursor = { readonly transferExpiresAt: string; readonly orderId: string };
type RetirementCursor = { readonly requestedAt: string; readonly orderId: string };

/**
 * E1 (§7.12): one pass of the payment service. FIRST it consumes the checkout retirements CMD214 recorded (D-INB-CTX-2), oldest first:
 * each in its own SERVICE unit of work that adopts the order's agency, takes the order's row lock, the instruction's, then the
 * retirement's, and applies it once: an order still open becomes EXPIRED with cause RETIRED and releases the project's open checkout
 * (one CHECKOUT_RETIRED event; outcome RETIRED); an order a credit closed first is left as it is (outcome NOT_OPEN, the apply before the
 * consumption is honored). A retirement consumed meanwhile (a concurrent pass) changes nothing. THEN Kexpiry: the bank orders whose
 * transfer deadline has passed at the database clock, oldest deadline first. Each order is its own SERVICE unit of work that takes the
 * next candidate after the pass's cursor, adopts the order's stored operation, takes the order's row lock then the instruction's (the
 * suffix of P1's lock order, §7.28) and judges the deadline again at the effect instant read after those locks: an order a P1 settled
 * meanwhile (CAPTURED, EXPIRED) is left as it is. The order becomes EXPIRED with cause DEADLINE, releasing the project's open checkout,
 * and every completed capture of it without a live entitlement is returned (KAURO_REMEDY, at most one request per capture and origin).
 * The quote is never touched: the price clock is never extended. The unit that finds no retirement left goes straight on to the first
 * deadline candidate (no empty unit precedes it). A failed unit is reported to the background-failure sink and the pass goes on past it
 * (one failing order never holds the others back).
 */
export async function expireTransfers(rt: PaymentRuntime): Promise<void> {
  let retiring = true;
  let retired: RetirementCursor | null = null;
  let after: ExpiryCursor | null = null;
  for (let taken = 0; taken < EXPIRY_PASS_LIMIT; taken++) {
    const cursor: ExpiryCursor | null = after;
    const retiredCursor: RetirementCursor | null = retired;
    const named: { retirement: RetirementCursor | null; retirementsDone: boolean; next: ExpiryCursor | null } = { retirement: null, retirementsDone: !retiring, next: null };
    try {
      await rt.assembly.commerce.run(serviceContext(rt), async (uow: CommerceUnitOfWork): Promise<void> => {
        const repo = bankCreditsOf(uow as never);
        if (!named.retirementsDone) {
          const [pending] = await repo.pendingRetirements(1, retiredCursor);
          if (pending !== undefined) {
            named.retirement = { requestedAt: pending.requestedAt, orderId: pending.orderId };
            await consumeRetirement(uow, pending);
            return;
          }
          named.retirementsDone = true;
        }
        const [candidate] = await repo.expiredCandidates(await effectNowOf(uow), 1, cursor);
        if (candidate === undefined) return;
        named.next = { transferExpiresAt: candidate.transferExpiresAt, orderId: candidate.orderId };
        await expireOne(uow, candidate);
      });
    } catch (e) {
      rt.onBackgroundFailure(rt.ids.next(), e);
    }
    if (retiring) {
      const r = named.retirement;
      // a retirement unit moves the retirement cursor (past a failed one too); a cursor that does not move ends the retirements
      if (r !== null && (retiredCursor === null || r.orderId !== retiredCursor.orderId)) {
        retired = r;
        continue;
      }
      retiring = false;
      if (!named.retirementsDone) continue;
    }
    // a cursor that does not move (no candidate left, or a unit that failed before naming one) ends the pass
    const next = named.next;
    if (next === null || (cursor !== null && next.orderId === cursor.orderId)) return;
    after = next;
  }
}

/** CMD214's consumption (D-INB-CTX-2): the retirement applied once, under the order's, the instruction's and its own row locks. */
async function consumeRetirement(uow: CommerceUnitOfWork, pending: BankCheckoutRetirementRecord): Promise<void> {
  const repo = bankCreditsOf(uow as never);
  const orderId = pending.orderId;
  if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) !== pending.agencyId) throw new DomainFailure("INTEGRITY_FAILURE", "the retired order is not in its retirement's agency");
  const order = await uow.commerce.orders.lock(orderId as PaymentOrderId);
  if (order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the retirement names no order");
  const instruction = await repo.instruction(orderId, true);
  if (instruction === null) throw new DomainFailure("INTEGRITY_FAILURE", "the retired order has no instruction");
  const retirement = await repo.retirementOf(orderId, true);
  // a concurrent pass consumed it first: its outcome stands
  if (retirement === null || retirement.consumedAt !== null) return;
  if (instruction.orderState !== "AWAITING_TRANSFER" && instruction.orderState !== "PARTIALLY_RECEIVED") {
    await repo.consumeRetirement(orderId, "NOT_OPEN");
    return;
  }
  const causationId = orderId as unknown as CausationId;
  causedBy(uow, orderId);
  const after = await repo.expireOrder(orderId, instruction.version, "RETIRED");
  await repo.releaseBankSlot(orderId);
  await publishOrderStateEvent(uow, causationId, after, instruction.orderState, "CHECKOUT_RETIRED");
  await repo.consumeRetirement(orderId, "RETIRED");
}

async function expireOne(uow: CommerceUnitOfWork, candidate: BankTransferInstructionRecord): Promise<void> {
  const repo = bankCreditsOf(uow as never);
  const orderId = candidate.orderId;
  if ((await uow.adoptScope("PAYMENT_ORDER", orderId)) !== candidate.agencyId) throw new DomainFailure("INTEGRITY_FAILURE", "the expiring order is not in its instruction's agency");
  const order = await uow.commerce.orders.lock(orderId as PaymentOrderId);
  if (order === null) throw new DomainFailure("INTEGRITY_FAILURE", "the expiring instruction has no order");
  const instruction = await repo.instruction(orderId, true);
  if (instruction === null) throw new DomainFailure("INTEGRITY_FAILURE", "the instruction vanished under the order's lock");
  // the effect instant: the database clock after the last lock wait
  const now = await effectNowOf(uow);
  if (instruction.orderState !== "AWAITING_TRANSFER" && instruction.orderState !== "PARTIALLY_RECEIVED") return;
  if (Date.parse(now) < Date.parse(instruction.transferExpiresAt)) return;
  const causationId = orderId as unknown as CausationId;
  causedBy(uow, orderId);
  const after = await repo.expireOrder(orderId, instruction.version, "DEADLINE");
  await repo.releaseBankSlot(orderId);
  await publishOrderStateEvent(uow, causationId, after, instruction.orderState, "TRANSFER_DEADLINE_REACHED");
  await fileRemedyReturns(uow, order, causationId, now, "KAURO_REMEDY: the transfer deadline passed without a complete payment");
}

registerBankSweep("TRANSFER_EXPIRY", expireTransfers);
