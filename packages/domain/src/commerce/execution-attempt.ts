/**
 * The outbound execution attempt of the bank-transfer route (Payments V1, docs/design/ACH-ROUTE.md r12 §7.21-§7.22, DV1-08; lane L-REFUND): one
 * V1 outbound movement the corporate owner declares (X1, X4), records (G2, G4) or that lapses past its manual execution window (X2). Its events
 * carry references, hashes, tokens, instants and counts only: never the execution id or the reference string, never a number or a holder name
 * of the destination (the destination stays in its own row). Pure: no clock, no I/O.
 */
export const OUTBOUND_ATTEMPT_AGGREGATE_KINDS = ["outbound_execution_attempt"] as const;
export const OUTBOUND_ATTEMPT_EVENT_TYPES = ["outbound.declared.v1", "outbound.uncertain.v1", "outbound.recorded.v1", "outbound.not_executed.v1", "outbound.bounced.v1", "outbound.resent.v1"] as const;
export type OutboundAttemptEventType = (typeof OUTBOUND_ATTEMPT_EVENT_TYPES)[number];

export const OUTBOUND_ATTEMPT_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<OutboundAttemptEventType, ReadonlyArray<string>>> = Object.freeze({
  "outbound.declared.v1": ["attemptId", "kind", "state", "sourceKind", "sourceId", "refundId", "treasuryRefundId", "attemptNumber", "amountCents", "declaredAt", "destinationFingerprint"],
  "outbound.uncertain.v1": ["attemptId", "kind", "state", "previousState", "sourceKind", "sourceId", "refundId", "treasuryRefundId"],
  "outbound.recorded.v1": ["attemptId", "kind", "state", "previousState", "sourceKind", "sourceId", "refundId", "treasuryRefundId", "evidenceHash", "destinationProof"],
  // X3 NOT_EXECUTED: the owner attests no effect under NX-LAG, NX-COVERAGE and NX-NO-POTENTIAL
  "outbound.not_executed.v1": ["attemptId", "kind", "state", "previousState", "sourceKind", "sourceId", "refundId", "treasuryRefundId"],
  // G3 RecordReturnBounce: the recorded transfer's money came back (B cents); the attempt stays RECORDED, its version moves
  "outbound.bounced.v1": ["attemptId", "kind", "state", "sourceKind", "sourceId", "refundId", "treasuryRefundId", "bounceId", "bouncedCents", "evidenceHash"],
  // G4 of a RESEND attempt (instead of outbound.recorded.v1): the resend recorded, the REFUND_PAYABLE of its bounce settled by amountCents
  "outbound.resent.v1": ["attemptId", "kind", "state", "previousState", "sourceKind", "sourceId", "refundId", "treasuryRefundId", "parentBounceId", "amountCents", "evidenceHash", "destinationProof"],
});

/** The owner learns of every attempt change (no account data in any of them). */
export const OUTBOUND_ATTEMPT_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: OutboundAttemptEventType; readonly consumer: "NOTIFICATIONS" }> = Object.freeze(
  OUTBOUND_ATTEMPT_EVENT_TYPES.map((eventType) => Object.freeze({ eventType, consumer: "NOTIFICATIONS" as const })),
);

/** `kauro-refund-<refundId>-<n>`: the reference the owner puts on the transfer (attempt n of that refund; 0045's CHECK). */
export function outboundReference(refundId: string, attemptNumber: number): string {
  return `kauro-refund-${refundId}-${attemptNumber}`;
}
