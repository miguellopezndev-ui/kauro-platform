/**
 * The route-scope refund of an unassigned bank credit (Payments V1, docs/design/ACH-ROUTE.md r12 D-ACH-19; lane L-REFUND): an aggregate of the
 * Refund machine without an agency (decision #1 of lane L-ROUTE: its events are agency-less and owner-only), excess-only (D-ACH-13: one
 * amount, no service or tax component). Pure: no clock, no I/O.
 */
export const TREASURY_REFUND_AGGREGATE_KINDS = ["treasury_refund"] as const;
export const TREASURY_REFUND_EVENT_TYPES = ["treasury_refund.approved.v1", "treasury_refund.submitting.v1", "treasury_refund.uncertain.v1", "treasury_refund.completed.v1"] as const;
export type TreasuryRefundEventType = (typeof TREASURY_REFUND_EVENT_TYPES)[number];

/** References, hashes and tokens only: never an account or routing number, never a holder name (the destination stays in its own row). */
export const TREASURY_REFUND_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<TreasuryRefundEventType, ReadonlyArray<string>>> = Object.freeze({
  "treasury_refund.approved.v1": ["treasuryRefundId", "routeId", "bankCreditId", "amountCents", "authorizationHash", "destinationFingerprint", "previousState"],
  // X1 declares its execution, X2 lapses it, G2 records it (lane L-REFUND slice 2); evidenceHash is the recorded execution artifact's
  "treasury_refund.submitting.v1": ["treasuryRefundId", "bankCreditId", "attemptId", "previousState"],
  "treasury_refund.uncertain.v1": ["treasuryRefundId", "bankCreditId", "attemptId", "previousState"],
  "treasury_refund.completed.v1": ["treasuryRefundId", "bankCreditId", "attemptId", "amountCents", "evidenceHash", "previousState"],
});

/** The owner learns of every treasury refund change (no account data in any of them). */
export const TREASURY_REFUND_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: TreasuryRefundEventType; readonly consumer: "NOTIFICATIONS" }> = Object.freeze(
  TREASURY_REFUND_EVENT_TYPES.map((eventType) => Object.freeze({ eventType, consumer: "NOTIFICATIONS" as const })),
);
