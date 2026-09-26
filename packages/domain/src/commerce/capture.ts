/**
 * Capture facts (15 "Capture and authority": before accepting capture evidence, verify order identity, payee/merchant,
 * environment, amount, currency, transaction status and finality; a successful redirect is not capture evidence. 15 "Webhooks
 * and reconciliation": facts are added monotonically; an old pending event cannot roll back a confirmed terminal capture.
 * R2-140: account for every real capture, deduplicate repeated events, keep one service entitlement and cap the basis to the
 * obligation. S058: a wrong amount, currency, payee, environment or signature yields no CommercialAuthorization).
 *
 * Four pure decisions the reconciler (every capture path: CapturePayment, the webhook, ReconcilePayment) applies in the same
 * order: does the observation belong to this order (`matchCapture`), how does its status move (`captureStatusStep`), how much
 * of a completing capture pays the obligation and how much is excess (`allocateCapture`), and may it carry the purchased
 * entitlement (`authorizesObligation`).
 */
import { allocateLargestRemainder, assertMoney } from "./money.js";
import type { ObservedCapture } from "./provider.js";
import type { CaptureFactRecord, CaptureStatus, PaymentOrderRecord, RefundComponents } from "./records.js";

export type CaptureMismatch = "WRONG_PROVIDER" | "WRONG_ENVIRONMENT" | "WRONG_ORDER" | "WRONG_PAYEE" | "WRONG_CURRENCY";

export type CaptureMatch = { readonly kind: "MATCH" } | { readonly kind: "MISMATCH"; readonly reason: CaptureMismatch };

/**
 * A capture belongs to an order only when provider, environment, provider order identity (when the observation names one),
 * payee and currency all match (S058). An amount difference is not a mismatch of identity: the money is real and is recorded
 * with its allocation, but it never carries the entitlement (`authorizesObligation`) and opens an AMOUNT_MISMATCH case.
 */
export function matchCapture(order: Pick<PaymentOrderRecord, "provider" | "environment" | "providerOrderId" | "payeeDigest" | "currency">, observed: ObservedCapture): CaptureMatch {
  if (observed.provider !== order.provider) return { kind: "MISMATCH", reason: "WRONG_PROVIDER" };
  if (observed.environment !== order.environment) return { kind: "MISMATCH", reason: "WRONG_ENVIRONMENT" };
  if (observed.providerOrderId !== null && observed.providerOrderId !== order.providerOrderId) return { kind: "MISMATCH", reason: "WRONG_ORDER" };
  if (observed.payeeDigest !== order.payeeDigest) return { kind: "MISMATCH", reason: "WRONG_PAYEE" };
  if (observed.currency !== order.currency) return { kind: "MISMATCH", reason: "WRONG_CURRENCY" };
  return { kind: "MATCH" };
}

export type CaptureStatusStep =
  | { readonly kind: "INSERT"; readonly status: CaptureStatus }
  | { readonly kind: "ADVANCE"; readonly next: CaptureStatus; readonly event: "provider_completed" | "provider_denied" | "provider_reversed" }
  | { readonly kind: "SAME" }
  | { readonly kind: "STALE" }
  | { readonly kind: "INCONSISTENT" };

/**
 * The monotonic lattice of provider capture states (CaptureFact machine, commerce/machines): PENDING → COMPLETED | DENIED |
 * REVERSED, COMPLETED → REVERSED. A fact is born in the status of its first authenticated observation (D-INIT-B1). An
 * observation behind the current state is STALE (kept as history, no change); one that contradicts a terminal state (DENIED
 * after COMPLETED, COMPLETED after DENIED) is INCONSISTENT and opens a PROVIDER_INCONSISTENCY case instead of moving anything.
 */
export function captureStatusStep(current: CaptureStatus | null, observed: CaptureStatus): CaptureStatusStep {
  if (current === null) return { kind: "INSERT", status: observed };
  if (current === observed) return { kind: "SAME" };
  switch (current) {
    case "PENDING":
      if (observed === "COMPLETED") return { kind: "ADVANCE", next: "COMPLETED", event: "provider_completed" };
      if (observed === "DENIED") return { kind: "ADVANCE", next: "DENIED", event: "provider_denied" };
      return { kind: "ADVANCE", next: "REVERSED", event: "provider_reversed" };
    case "COMPLETED":
      if (observed === "REVERSED") return { kind: "ADVANCE", next: "REVERSED", event: "provider_reversed" };
      if (observed === "PENDING") return { kind: "STALE" };
      return { kind: "INCONSISTENT" };
    case "DENIED":
      return observed === "PENDING" ? { kind: "STALE" } : { kind: "INCONSISTENT" };
    case "REVERSED":
      return observed === "DENIED" ? { kind: "INCONSISTENT" } : { kind: "STALE" };
  }
}

/** The service/tax split of a cumulative amount paid toward an obligation (largest remainder, service first on a tie). */
export function splitObligation(order: Pick<PaymentOrderRecord, "expectedServiceCents" | "expectedTaxCents">, cumulativeCents: bigint): { readonly serviceCents: bigint; readonly taxCents: bigint } {
  const shares = allocateLargestRemainder(cumulativeCents, [
    { key: "service", weight: order.expectedServiceCents },
    { key: "tax", weight: order.expectedTaxCents },
  ]);
  return { serviceCents: shares.get("service") as bigint, taxCents: shares.get("tax") as bigint };
}

/**
 * The allocation of a capture observed COMPLETED (or first observed REVERSED; D-PAY-B5): the part that pays what is still owed
 * on the order goes to the obligation — split into service and tax cumulatively, so several partial captures always add up to
 * exactly the quoted service and tax — and the rest is excess, an overpayment to return (R2-140). The database re-checks the
 * sum (capture_facts_allocation) and the cap (kauro.capture_facts_allocate, migration 0010, SQLSTATE KP002).
 */
export function allocateCapture(order: Pick<PaymentOrderRecord, "expectedAmountCents" | "expectedServiceCents" | "expectedTaxCents" | "allocatedCents">, amountCents: bigint): RefundComponents {
  assertMoney(amountCents);
  if (order.expectedServiceCents + order.expectedTaxCents !== order.expectedAmountCents) throw new RangeError("order obligation split does not add up");
  const owed = order.expectedAmountCents - order.allocatedCents;
  if (owed < 0n) throw new RangeError("order is over-allocated");
  const applied = amountCents < owed ? amountCents : owed;
  const before = splitObligation(order, order.allocatedCents);
  const after = splitObligation(order, order.allocatedCents + applied);
  return { serviceCents: after.serviceCents - before.serviceCents, taxCents: after.taxCents - before.taxCents, excessCents: amountCents - applied };
}

/**
 * Whether a capture carries the purchased entitlement (07 "CommercialAuthorization is issued only once for the purchased subject
 * after the required verified payment fact"; S058): it is COMPLETED, its amount is exactly the order's expected amount, and it
 * alone allocated the whole obligation. A partial, excess-only, pending, denied or reversed capture never does; the database
 * refuses the authorization otherwise (kauro.commercial_authorizations_require_capture, SQLSTATE KP004).
 */
export function authorizesObligation(order: Pick<PaymentOrderRecord, "expectedAmountCents" | "expectedServiceCents" | "expectedTaxCents">, capture: Pick<CaptureFactRecord, "status" | "amountCents" | "allocation">): boolean {
  return (
    capture.status === "COMPLETED" &&
    capture.amountCents === order.expectedAmountCents &&
    capture.allocation.serviceCents === order.expectedServiceCents &&
    capture.allocation.taxCents === order.expectedTaxCents &&
    capture.allocation.excessCents === 0n
  );
}

/** True when the order's obligation is fully allocated by completed captures. */
export function isFullyPaid(order: Pick<PaymentOrderRecord, "expectedAmountCents" | "allocatedCents">): boolean {
  return order.allocatedCents === order.expectedAmountCents;
}
