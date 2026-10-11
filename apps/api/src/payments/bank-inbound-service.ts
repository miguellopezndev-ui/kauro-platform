/**
 * The payment service's side of the inbound bank-transfer credits (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.9 M1,
 * §7.10 P1, §7.12 E1, §7.28): handlers registered on the bank-transfer seam of consumers.ts and sweep.ts, each one SERVICE unit of
 * work of the payment service's pool. A credit is agency-less; the order a credit names is found by its canonical reference and
 * the service adopts that order's stored operation (D-SCOPE-B1) only after the lookup, never from a payload.
 *
 * Lock order (ACH-ROUTE §7.28): the account's INBOUND stream lock, then the credit identity lock Lc, then the order's own locks.
 */
import type { CommerceEventDelivery } from "@kauro/application";
import { publishCreditEvent } from "@kauro/application";
import type { CausationId, CommerceUnitOfWork, CorrelationId, MatchKeys } from "@kauro/domain";
import { matchDecision } from "@kauro/domain";
import { bankCreditsOf, bankRoutesOf } from "@kauro/persistence";
import { registerBankDeliveryHandler, type ConsumerOutcome } from "./consumers.js";
import { causedBy, type PaymentRuntime } from "./runtime.js";

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
      if (route !== null) {
        await uow.adoptScope("PAYMENT_ORDER", instruction.orderId);
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

registerBankDeliveryHandler("bank_credit.received.v1", matchCredit);
