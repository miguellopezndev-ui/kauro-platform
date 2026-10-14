/**
 * The payment service's side of the bank-route settlement (Payments V1, lane PV1-SETTLE two-step; docs/design/PV1-SETTLE-two-step.md
 * D-SET-10 §3.3, ACH-ROUTE r12 §7.25 ST3): the PAYMENT_SERVICE handler of settlement_request.recorded.v1, one SERVICE unit of work of
 * the payment service's pool (kauro_payment). CMD215 only records the owner's intent (kauro_app writes no money state, D-ACH-16); this
 * handler applies it (the settlement, its event, its posting set) or refuses it with a review case (applySettlementRequest).
 *
 * The intent is agency-less: the dispatcher hands it over with agency null (AGENCY_LESS_PAYMENT_EVENT_TYPES), and no agency is ever
 * adopted. Lock order (§7.28): the account's OUTBOUND stream (L1), its INBOUND stream, the payout cash lock, the intent's row.
 * The bank evidence binding is the payment adapters' `bank` (absent, or either half null: CAPACITY_UNAVAILABLE, retried, then DEAD_LETTER,
 * which the owner's in-transit page shows). The effect instant is the unit's exact database clock read after the last lock (A6).
 */
import type { CommerceEventDelivery } from "@kauro/application";
import { applySettlementRequest, realProviderCallTimer } from "@kauro/application";
import type { CommerceUnitOfWork, CorrelationId } from "@kauro/domain";
import { bankCreditsOf, bankSettlementsOf, exactEffectNowOf } from "@kauro/persistence";
import { registerBankDeliveryHandler, type ConsumerOutcome } from "./consumers.js";
import { causedBy, type PaymentRuntime } from "./runtime.js";

const serviceContext = (rt: PaymentRuntime) => ({ kind: "SERVICE" as const, serviceId: rt.self.serviceId, correlationId: rt.ids.next() as CorrelationId });

/** ST3 Kapply-settlement: the intent the delivered recorded.v1 names, applied or refused once. */
export async function applySettlement(rt: PaymentRuntime, delivery: CommerceEventDelivery): Promise<ConsumerOutcome> {
  const requestId = delivery.aggregateId;
  const bank = rt.assembly.bank;
  return rt.assembly.commerce.run(serviceContext(rt), async (uow: CommerceUnitOfWork): Promise<ConsumerOutcome> => {
    causedBy(uow, delivery.eventId);
    const credits = bankCreditsOf(uow as never);
    return applySettlementRequest(
      uow,
      {
        settlements: bankSettlementsOf(uow as never),
        lockStream: (environment, accountRef, stream) => credits.lockStream(environment, accountRef, stream),
        effectNow: () => exactEffectNowOf(uow as never),
        evidence: { evidence: bank?.evidence ?? (() => null), settlementClassifier: bank?.classifier ?? (() => null), timer: realProviderCallTimer },
      },
      { eventId: delivery.eventId, requestId },
    );
  });
}

registerBankDeliveryHandler("settlement_request.recorded.v1", applySettlement);
