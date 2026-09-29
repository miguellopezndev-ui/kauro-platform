/**
 * nextProtocolStep — the resume table of the provider-effect protocol (design §6.1 "Resume"; D-PROTO-B1..B6): from the durable
 * state of a logical operation's latest attempt and of the aggregate it acts on, what a retry with the same idempotency key does
 * next. A crash anywhere leaves a state from which the same key converges to one effect (07 "The client recovers the same command
 * result by its idempotency identity. It must not repeat the external effect under a new key"):
 *
 *   attempt PREPARED                       CLAIM        the intent is durable and no call was possible: claim (T2), then call
 *   attempt DISPATCHING / PROVIDER_PENDING  OBSERVE      a call may have happened: read the provider by the attempt's request
 *           / UNCERTAIN                                  identity (never a second dispatch) and settle when conclusive, else 202
 *   attempt CONFIRMED                      COMPLETE     settled: complete the journal from the durable facts (T4)
 *   attempt FAILED_NO_EFFECT               NEW_ATTEMPT  a creation still CREATING with attempts left: a new deliberate attempt
 *                                                        (ordinal + 1, a new request identity; D-PROTO-B3)
 *                                          COMPLETE     otherwise (the order failed; a capture or refund proved no effect is the
 *                                                        caller's to retry deliberately under a new command)
 *   attempt CANCELLED_BEFORE_DISPATCH      COMPLETE     the sweep cancelled an intent whose claim never committed (D-PROTO-B4)
 */
import type { PaymentAttemptRecord, PaymentOrderState, RefundState } from "@kauro/domain";
import type { ProviderEffect } from "../protocol.js";

export interface ProtocolState {
  readonly effect: ProviderEffect;
  readonly attempt: Pick<PaymentAttemptRecord, "state" | "ordinal">;
  /** The state of the aggregate the effect acts on: the order (CREATE_ORDER, CAPTURE) or the refund (REFUND). */
  readonly aggregateState: PaymentOrderState | RefundState;
  readonly maxAttempts: number;
}

export type ProtocolStep =
  | { readonly kind: "CLAIM" }
  | { readonly kind: "OBSERVE" }
  | { readonly kind: "NEW_ATTEMPT"; readonly ordinal: number }
  | { readonly kind: "COMPLETE" };

export function nextProtocolStep(s: ProtocolState): ProtocolStep {
  switch (s.attempt.state) {
    case "PREPARED":
      return { kind: "CLAIM" };
    case "DISPATCHING":
    case "PROVIDER_PENDING":
    case "UNCERTAIN":
      return { kind: "OBSERVE" };
    case "FAILED_NO_EFFECT":
      if (s.effect === "CREATE_ORDER" && s.aggregateState === "CREATING" && s.attempt.ordinal < s.maxAttempts) return { kind: "NEW_ATTEMPT", ordinal: s.attempt.ordinal + 1 };
      return { kind: "COMPLETE" };
    case "CONFIRMED":
    case "CANCELLED_BEFORE_DISPATCH":
      return { kind: "COMPLETE" };
  }
}

/**
 * Whether the settled facts answer the command (CONCLUSIVE: the journal commits the 2xx view) or leave the effect unknown or in
 * flight (PENDING: 202 with the durable operation, the journal UNCERTAIN; D-PROTO-B2, D-JOURNAL-B1).
 */
export function settledOutcome(s: ProtocolState): "CONCLUSIVE" | "PENDING" | "NEW_ATTEMPT" {
  const step = nextProtocolStep(s);
  if (step.kind === "NEW_ATTEMPT") return "NEW_ATTEMPT";
  return step.kind === "COMPLETE" ? "CONCLUSIVE" : "PENDING";
}
