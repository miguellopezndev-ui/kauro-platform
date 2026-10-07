/**
 * PayPal resources → the platform's normalized observations (never the vendor schema). Shared by the dispatch classifier, the
 * observation reader and the webhook classifier, so one capture means one ObservedCapture whichever channel delivered it.
 *
 * Status mapping (Orders v2 / Payments v2 `capture_status`, spec 2.32 / 2.12, retrieved 2026-10-07):
 *  - COMPLETED → COMPLETED, completed at `update_time` (a capture completes on its last update while COMPLETED);
 *  - PENDING → PENDING; DECLINED and FAILED → DENIED (no funds were captured);
 *  - PARTIALLY_REFUNDED and REFUNDED → COMPLETED with an unknown completion instant (the capture did complete; its refunds are
 *    separate resources, and `update_time` is then the refund's time, not the completion's — the reconciler asks for the instant);
 *  - REVERSED (a webhook's status) → REVERSED with an unknown completion instant;
 *  - anything else → null (UNRECOGNIZED, 15 "Unknown provider statuses ... block consequential assumptions").
 * Funds: `disbursement_mode` INSTANT → AVAILABLE, DELAYED → HELD, absent → UNKNOWN (the schema default is never assumed).
 * Fee: `seller_receivable_breakdown.paypal_fee` in the capture's currency (A8: the real fee is the reported one); another currency →
 * null, never converted.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { CaptureStatus, FundsState, ObservedCapture, ObservedRefund, PaymentEnvironment } from "@kauro/domain";
import { amountOf, instantOf, lastSegmentOn, linkOf, obj, sha256Hex, str, type Json } from "./wire.js";

export const PAYPAL_PROVIDER = "paypal";

/** Every PayPal REST API host (an `up` link's capture id is read on either environment's host; the response itself is authenticated). */
export const PAYPAL_API_HOSTS: ReadonlyArray<string> = Object.freeze(["api-m.paypal.com", "api-m.sandbox.paypal.com", "api.paypal.com", "api.sandbox.paypal.com"]);

const CAPTURE_STATUS: Readonly<Record<string, { readonly status: CaptureStatus; readonly completionKnown: boolean }>> = Object.freeze({
  COMPLETED: { status: "COMPLETED", completionKnown: true },
  PENDING: { status: "PENDING", completionKnown: false },
  DECLINED: { status: "DENIED", completionKnown: false },
  FAILED: { status: "DENIED", completionKnown: false },
  PARTIALLY_REFUNDED: { status: "COMPLETED", completionKnown: false },
  REFUNDED: { status: "COMPLETED", completionKnown: false },
  REVERSED: { status: "REVERSED", completionKnown: false },
});

export type CaptureReading = { readonly kind: "CAPTURE"; readonly capture: ObservedCapture } | { readonly kind: "MISSING_PAYEE"; readonly captureId: string } | { readonly kind: "UNRECOGNIZED" };

/**
 * One capture resource. `fallback` carries what the enclosing order names when the capture itself does not (the purchase unit's payee
 * and the order id: Orders v2 nests captures under the unit and the minimal capture representation omits both). A capture that names
 * no payee anywhere is MISSING_PAYEE: the caller reads the capture resource itself (GET /v2/payments/captures/{id}), never assumes it.
 */
export function readCapture(resource: Json, context: { readonly environment: PaymentEnvironment; readonly evidenceHash: Sha256Hex; readonly statusOverride?: CaptureStatus; readonly fallbackPayee?: string | null; readonly fallbackOrderId?: string | null }): CaptureReading {
  const id = str(resource["id"]);
  const amount = amountOf(resource["amount"]);
  const mapped = context.statusOverride !== undefined ? { status: context.statusOverride, completionKnown: context.statusOverride === "COMPLETED" } : CAPTURE_STATUS[str(resource["status"]) ?? ""];
  if (id === null || amount === null || mapped === undefined) return { kind: "UNRECOGNIZED" };
  const merchant = str(obj(resource["payee"])?.["merchant_id"]) ?? context.fallbackPayee ?? null;
  if (merchant === null) return { kind: "MISSING_PAYEE", captureId: id };
  const relatedOrder = str(obj(obj(resource["supplementary_data"])?.["related_ids"])?.["order_id"]) ?? context.fallbackOrderId ?? null;
  const disbursement = str(resource["disbursement_mode"]);
  const funds: FundsState = disbursement === "INSTANT" ? "AVAILABLE" : disbursement === "DELAYED" ? "HELD" : "UNKNOWN";
  const fee = amountOf(obj(resource["seller_receivable_breakdown"])?.["paypal_fee"]);
  return {
    kind: "CAPTURE",
    capture: {
      provider: PAYPAL_PROVIDER,
      environment: context.environment,
      providerOrderId: relatedOrder,
      providerCaptureId: id,
      status: mapped.status,
      amountCents: amount.cents,
      currency: amount.currency,
      payeeDigest: sha256Hex(merchant),
      providerCompletedAt: mapped.completionKnown ? instantOf(resource["update_time"]) : null,
      fundsState: funds,
      feeCents: fee !== null && fee.currency === amount.currency ? fee.cents : null,
      evidenceHash: context.evidenceHash,
    },
  };
}

/** One refund resource; the capture it refunds is its `up` link (or the capture the caller asked about). CANCELLED and unknown → null. */
export function readRefund(resource: Json, context: { readonly environment: PaymentEnvironment; readonly evidenceHash: Sha256Hex; readonly captureId?: string }): ObservedRefund | null {
  const id = str(resource["id"]);
  const amount = amountOf(resource["amount"]);
  const status = str(resource["status"]);
  const captureId = lastSegmentOn(linkOf(resource, ["up"]), PAYPAL_API_HOSTS) ?? context.captureId ?? null;
  if (id === null || amount === null || captureId === null || (status !== "COMPLETED" && status !== "PENDING" && status !== "FAILED")) return null;
  return {
    provider: PAYPAL_PROVIDER,
    environment: context.environment,
    providerCaptureId: captureId,
    providerRefundId: id,
    // the refund's invoice_id is the platform refund id its request carried; a refund made elsewhere names none (B09-R1)
    platformRefundRef: str(resource["invoice_id"]),
    status,
    amountCents: amount.cents,
    currency: amount.currency,
    evidenceHash: context.evidenceHash,
  };
}

