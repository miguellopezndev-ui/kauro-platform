/**
 * The remedy return of an order's money that carries no authority (Payments V1, lane PV1-INBOUND; docs/design/ACH-ROUTE.md r12 §7.12
 * E1): when a bank order expires, every completed capture of it without a live entitlement is returned to the payer through a server
 * KAURO_REMEDY request of its unreturned service, tax and excess — the request the reconciler files for the same capture (D-REF-B1),
 * filed ON CONFLICT DO NOTHING per capture and origin, so a capture whose return is already open is never asked for twice.
 *
 * It runs inside the caller's SERVICE unit of work, after the caller took the order's row lock.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CausationId, CommerceUnitOfWork, NewRefundRequest, PaymentOrderRecord, RefundComponents, RefundId } from "@kauro/domain";
import { ZERO_COMPONENTS, proposeRefund, refundableBalance } from "@kauro/domain";
import { publishVersionEvent, versionEvent } from "./events.js";

const sum = (list: ReadonlyArray<RefundComponents>): RefundComponents =>
  list.reduce<RefundComponents>((a, c) => ({ serviceCents: a.serviceCents + c.serviceCents, taxCents: a.taxCents + c.taxCents, excessCents: a.excessCents + c.excessCents }), ZERO_COMPONENTS);

/** Files the KAURO_REMEDY request of each completed capture of `order` that has no live entitlement; answers how many were filed. */
export async function fileRemedyReturns(uow: CommerceUnitOfWork, order: PaymentOrderRecord, causationId: CausationId, now: UtcInstant, reasonCode: string): Promise<number> {
  const c = uow.commerce;
  let filed = 0;
  for (const capture of await c.captures.listForOrder(order.orderId)) {
    if (capture.status !== "COMPLETED") continue;
    if ((await c.authorizations.findLiveByCapture(capture.captureId)) !== null) continue;
    const refunds = await c.refunds.listForCapture(capture.captureId);
    const committed = sum(refunds.filter((r) => (r.state === "APPROVED" || r.state === "SUBMITTING" || r.state === "UNCERTAIN" || r.state === "COMPLETED") && r.approved !== undefined).map((r) => r.approved!.amounts));
    const proposed = proposeRefund("KAURO_REMEDY", refundableBalance(capture, committed));
    if (proposed.serviceCents + proposed.taxCents + proposed.excessCents === 0n) continue;
    const refundId = uow.ids.next() as RefundId;
    const request: NewRefundRequest = {
      refundId,
      agencyId: order.agencyId,
      projectId: order.projectId,
      orderId: order.orderId,
      captureId: capture.captureId,
      origin: "KAURO_REMEDY",
      reasonCode,
      termsHash: order.termsHash,
      deliveryPhase: "NO_AUTHORIZATION",
      proposed,
      requestedAt: now,
    };
    const result = await c.refunds.fileServerRequest(request);
    if (!result.filed) continue;
    await publishVersionEvent(
      uow,
      versionEvent("refund", refundId, 1, order.agencyId, { previousState: null, state: "REQUESTED" }, {
        refundId,
        agencyId: order.agencyId,
        projectId: order.projectId,
        orderId: order.orderId,
        captureId: capture.captureId,
        origin: "KAURO_REMEDY",
        deliveryPhase: "NO_AUTHORIZATION",
        proposedServiceCents: proposed.serviceCents,
        proposedTaxCents: proposed.taxCents,
        proposedExcessCents: proposed.excessCents,
      }),
      causationId,
    );
    await uow.scopes.record({ kind: "REFUND", key: refundId, agencyId: order.agencyId, orderId: order.orderId, refundId }, now);
    filed++;
  }
  return filed;
}
