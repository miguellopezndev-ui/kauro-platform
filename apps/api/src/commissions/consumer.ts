/**
 * The COMMISSIONS consumer (docs/design/B10-commercial-domain.md §6, §14; decisions D10-CONS-1, D10-FIRST-2, D10-ATTR-2, D10-RATE-1,
 * D10-ADJ-2, D10-ELIG-1, D10-BIND-1, D10-SVC-2; registered destinations: 0013's and 0028's commerce_event_subscriptions). It receives,
 * at least once and in any order, the outbox records of its event types from the COMMISSIONS dispatcher, and applies each in one SERVICE
 * unit of work of the commission service that adopts the event's agency and names the event as its cause:
 *
 *  capture.completed.v1    the first designation mirrored once (agencies.first_qualifying_capture_id, agency.first_purchase_designated.v1);
 *                          the frozen allocation's accepted claims converted into entitlements; the purchase's pools and lines, one pool
 *                          per purchase and source, at its allocated service (a capture that designated no qualifying purchase — an
 *                          excess capture, a re-bound one — accrues nothing);
 *  refund.completed.v1     the purchase accrued if it was not yet (the same as above), then its pools recomputed at the smaller of their
 *  capture.reversed.v1     basis and what the event names — serviceBasisAfterCents, or zero for the reversal — one adjustment per changed
 *                          line and event (D10-ADJ-2): whatever the delivery order, the events of one capture end at the same cumulative
 *                          entitlements;
 *  capture.funds_observed.v1  the capture version's funds fact; HELD holds the capture's due lines (FUNDS_HELD);
 *  commercial_authorization.delivered.v1  the purchase's completions as PreparationCompletionSource reports them.
 *
 * Every effect is idempotent by its durable identity (ledger-effects.ts): a replay answers DUPLICATE and writes nothing.
 */
import type { CommerceEventDelivery } from "@kauro/application";
import type { AgencyId, CaptureId, EventId, QualifyingPurchaseId } from "@kauro/domain";
import { COMMERCE_EVENT_SUBSCRIPTIONS, COMMERCIAL_EVENT_SUBSCRIPTIONS, DomainFailure } from "@kauro/domain";
import { commissionWorkOf, recurrenceOf, type PgCommercialUnitOfWork } from "@kauro/persistence";
import type { ConsumerOutcome } from "../payments/index.js";
import { accruePurchase, applyBasisChange, convertAcceptedClaims, mirrorDesignation, observeFunds, recordCompletions, serverNow } from "./ledger-effects.js";
import { COMMISSIONS_CONSUMER, inAgency, type CommissionRuntime } from "./runtime.js";

export interface CommissionsConsumer {
  readonly consumer: typeof COMMISSIONS_CONSUMER;
  /** The event types COMMISSIONS is registered for (B09's COMMERCE_EVENT_SUBSCRIPTIONS and B10's COMMERCIAL_EVENT_SUBSCRIPTIONS). */
  readonly eventTypes: ReadonlyArray<string>;
  handle(delivery: CommerceEventDelivery): Promise<ConsumerOutcome>;
}

function text(delivery: CommerceEventDelivery, key: string): string {
  const v = delivery.payload[key];
  if (typeof v !== "string" || v.length === 0) throw new DomainFailure("INTEGRITY_FAILURE", `${delivery.eventType} ${delivery.eventId} carries no ${key}`);
  return v;
}

function cents(delivery: CommerceEventDelivery, key: string): bigint {
  const v = delivery.payload[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new DomainFailure("INTEGRITY_FAILURE", `${delivery.eventType} ${delivery.eventId} carries no integer ${key}`);
  return BigInt(v);
}

/** The purchase's first accrual, as each of its events makes it when it is the first to arrive: mirror, conversions, pools. */
async function accrueOnEvent(rt: CommissionRuntime, uow: PgCommercialUnitOfWork, agencyId: AgencyId, captureId: CaptureId): Promise<{ readonly found: boolean; readonly applied: boolean; readonly applicable: boolean }> {
  const now = await serverNow(uow);
  const mirrored = await mirrorDesignation(uow, agencyId, now);
  const purchase = await recurrenceOf(uow).purchaseOfCapture(captureId);
  if (purchase === null) return { found: false, applied: mirrored, applicable: false };
  const converted = await convertAcceptedClaims(rt, uow, agencyId, now);
  const accrual = await accruePurchase(rt, uow, purchase, now, "ALLOCATED");
  return { found: true, applied: mirrored || converted > 0 || accrual.created > 0, applicable: accrual.applicable };
}

export function commissionsConsumer(rt: CommissionRuntime): CommissionsConsumer {
  const eventTypes = [...COMMERCE_EVENT_SUBSCRIPTIONS, ...COMMERCIAL_EVENT_SUBSCRIPTIONS].filter((s) => s.consumer === COMMISSIONS_CONSUMER).map((s) => s.eventType);
  return {
    consumer: COMMISSIONS_CONSUMER,
    eventTypes,
    handle(delivery) {
      return inAgency(rt, delivery.agencyId, delivery.eventId, async (uow): Promise<ConsumerOutcome> => {
        const agencyId = delivery.agencyId;
        switch (delivery.eventType) {
          case "capture.completed.v1": {
            const accrued = await accrueOnEvent(rt, uow, agencyId, text(delivery, "captureId") as CaptureId);
            if (accrued.applied) return "APPLIED";
            return accrued.found && accrued.applicable ? "DUPLICATE" : "NOT_APPLICABLE";
          }
          case "refund.completed.v1":
          case "capture.reversed.v1": {
            const captureId = text(delivery, "captureId") as CaptureId;
            // a basis change takes the open periods first, before any pool or line of the purchase (D10-STMT-4): it serializes with a close
            await commissionWorkOf(uow).shareOpenPeriods();
            const accrued = await accrueOnEvent(rt, uow, agencyId, captureId);
            if (!accrued.found) return "NOT_APPLICABLE";
            const change = delivery.eventType === "capture.reversed.v1" ? ({ kind: "CAPTURE_REVERSED" } as const) : ({ kind: "REFUND_COMPLETED", serviceBasisAfterCents: cents(delivery, "serviceBasisAfterCents") } as const);
            const changed = await applyBasisChange(uow, captureId, change, delivery.eventId as EventId, await serverNow(uow));
            return accrued.applied || changed > 0 ? "APPLIED" : "DUPLICATE";
          }
          case "capture.funds_observed.v1": {
            const fundsState = delivery.payload["fundsState"];
            if (fundsState !== "HELD" && fundsState !== "AVAILABLE") return "NOT_APPLICABLE";
            const written = await observeFunds(uow, { agencyId, captureId: text(delivery, "captureId") as CaptureId, captureVersion: delivery.aggregateVersion, fundsState, sourceEventId: delivery.eventId as EventId }, await serverNow(uow));
            return written ? "APPLIED" : "DUPLICATE";
          }
          case "commercial_authorization.delivered.v1": {
            const purchase = await recurrenceOf(uow).getPurchase((typeof delivery.payload["authorizationId"] === "string" ? delivery.payload["authorizationId"] : delivery.aggregateId) as QualifyingPurchaseId);
            if (purchase === null) return "NOT_APPLICABLE";
            return (await recordCompletions(rt, uow, purchase, await serverNow(uow))) > 0 ? "APPLIED" : "DUPLICATE";
          }
          default:
            return "NOT_APPLICABLE";
        }
      });
    },
  };
}
