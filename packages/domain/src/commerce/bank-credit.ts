/**
 * The inbound side of the bank-transfer route of Payments V1 (docs/design/ACH-ROUTE.md r12 §7.5 C5, §7.6 C4/C6, §7.9 M1/M2, §7.10 P1,
 * §7.12 E1, §7.23 SI2; lane PV1-INBOUND): the credit's states, the aggregates and events of the credit, the statement import and the
 * bank order's state changes, the matching decision (M1) and the bank order state a received credit leads to. Pure: no clock is read here;
 * the caller passes the effect instant it read after its locks.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { BankCreditState } from "./records.js";

/**
 * The rail a bank booked a credit on (DV1-03): ACH and DOMESTIC_WIRE are the rails a route version may accept; OTHER and UNKNOWN are
 * recorded as the bank stated them and always go to review (M1: never in acceptedRails).
 */
export const BANK_CREDIT_RAILS = ["ACH", "DOMESTIC_WIRE", "OTHER", "UNKNOWN"] as const;
export type BankCreditRail = (typeof BANK_CREDIT_RAILS)[number];

/** The credit and statement import are agency-less aggregates (platform scope); an order's bank state change is the agency's. */
// `settlement`: the settlement observation of the route account (0017 kauro.settlements; an aggregate of its own from 0062, lane PV1-SETTLE)
export const BANK_CREDIT_AGGREGATE_KINDS = ["bank_credit", "statement_import", "settlement"] as const;
export const BANK_CREDIT_EVENT_TYPES = [
  "bank_credit.drafted.v1",
  "bank_credit.received.v1",
  "bank_credit.matched.v1",
  "bank_credit.review_required.v1",
  "bank_credit.applied.v1",
  "statement_import.recorded.v1",
  "bank_transfer_instruction.order_state_changed.v1",
  "settlement.recorded.v1",
] as const;
export type BankCreditEventType = (typeof BANK_CREDIT_EVENT_TYPES)[number];

/** References, hashes and states only: never an amount's payer, a reference (a payment secret of the buyer) or an account number. */
export const BANK_CREDIT_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<BankCreditEventType, ReadonlyArray<string>>> = Object.freeze({
  "bank_credit.drafted.v1": ["creditId", "state", "evidenceHash"],
  "bank_credit.received.v1": ["creditId", "state", "previousState", "evidenceHash"],
  "bank_credit.matched.v1": ["creditId", "orderId", "state", "previousState", "decision"],
  "bank_credit.review_required.v1": ["creditId", "state", "previousState", "reason"],
  "bank_credit.applied.v1": ["creditId", "orderId", "captureId", "state", "previousState"],
  "statement_import.recorded.v1": ["importId", "evidenceHash", "lines", "newLines"],
  "bank_transfer_instruction.order_state_changed.v1": ["orderId", "agencyId", "previousState", "orderState", "cause"],
  "settlement.recorded.v1": ["settlementId", "withdrawnCents", "feeCents", "receivedCents", "bankEvidence"],
});

/** The payment service learns of a received and a matched credit; the owner (NOTIFICATIONS) of every credit, import and order-state change. */
export const BANK_CREDIT_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: BankCreditEventType; readonly consumer: "PAYMENT_SERVICE" | "NOTIFICATIONS" }> = Object.freeze([
  ...BANK_CREDIT_EVENT_TYPES.map((eventType) => Object.freeze({ eventType, consumer: "NOTIFICATIONS" as const })),
  Object.freeze({ eventType: "bank_credit.received.v1" as const, consumer: "PAYMENT_SERVICE" as const }),
  Object.freeze({ eventType: "bank_credit.matched.v1" as const, consumer: "PAYMENT_SERVICE" as const }),
]);

/** The credit as the tables hold it (money as integer cents; the payer as a digest only). */
export interface BankCreditRecord {
  readonly creditId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly bankTransactionId: string;
  readonly state: BankCreditState;
  readonly version: number;
  readonly rail: BankCreditRail;
  readonly currency: "USD";
  readonly grossCents: bigint;
  readonly netCents: bigint | null;
  readonly feeCents: bigint | null;
  readonly reference: string | null;
  readonly bookedAt: string | null;
  readonly evidenceHash: Sha256Hex;
  readonly payerDigest: Sha256Hex | null;
  readonly payeeDigest: Sha256Hex | null;
  readonly artifactRef: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
}

export interface StatementImportRecord {
  readonly importId: string;
  readonly environment: "SANDBOX" | "LIVE";
  readonly accountRef: string;
  readonly artifactRef: string;
  readonly evidenceHash: Sha256Hex;
  readonly version: number;
}

/** What M1 compares: the order's frozen instruction and its route version (D-ACH-08 rule 3). */
export interface MatchKeys {
  readonly orderId: string;
  readonly reference: string;
  readonly expectedAmountCents: bigint;
  readonly currency: "USD";
  readonly acceptedPayerDigest: Sha256Hex | null;
  readonly payeeDigest: Sha256Hex | null;
  readonly acceptedRails: ReadonlyArray<string>;
  readonly transferExpiresAt: string;
  readonly providerTimeToleranceMs: number;
  readonly accountRef: string;
}

export type MatchDecision =
  | { readonly kind: "MATCHED" }
  | { readonly kind: "REVIEW"; readonly reason: "NO_ORDER" | "PAYER_MISMATCH" | "PAYEE_MISMATCH" | "CURRENCY_MISMATCH" | "RAIL_NOT_ACCEPTED" | "REFERENCE_MISSING" };

/** M1: a credit is matched only when every key the instruction froze agrees; anything else goes to review with its first reason. */
export function matchDecision(credit: Pick<BankCreditRecord, "reference" | "currency" | "rail" | "payerDigest" | "payeeDigest">, keys: MatchKeys | null): MatchDecision {
  if (credit.reference === null) return { kind: "REVIEW", reason: "REFERENCE_MISSING" };
  if (keys === null) return { kind: "REVIEW", reason: "NO_ORDER" };
  if (credit.currency !== keys.currency) return { kind: "REVIEW", reason: "CURRENCY_MISMATCH" };
  if (!(keys.acceptedRails as ReadonlyArray<string>).includes(credit.rail)) return { kind: "REVIEW", reason: "RAIL_NOT_ACCEPTED" };
  if (keys.payeeDigest !== null && credit.payeeDigest !== null && keys.payeeDigest !== credit.payeeDigest) return { kind: "REVIEW", reason: "PAYEE_MISMATCH" };
  if (keys.acceptedPayerDigest === null || credit.payerDigest === null || keys.acceptedPayerDigest !== credit.payerDigest) return { kind: "REVIEW", reason: "PAYER_MISMATCH" };
  return { kind: "MATCHED" };
}

/** What P1 judges at its effect instant, under the instruction's row lock (ACH-ROUTE §7.10 P1, §7.24 P1Δ, DV1-06). */
export interface BankApplyFacts {
  /** The bank order state the instruction holds now, and why an EXPIRED one expired. */
  readonly orderState: string;
  readonly expiryCause: "DEADLINE" | "RETIRED" | null;
  readonly transferExpiresAt: string;
  readonly issuedAt: string;
  /** The route version's named provider-time tolerance (data, never a constant). */
  readonly toleranceMs: number;
  /** The bank's booking instant of the credit, and the instant the database stamped at its confirmation. */
  readonly bookedAt: string | null;
  readonly confirmedAt: string | null;
  /** The database clock after the last lock wait. */
  readonly effectNow: string;
  readonly routeEnabled: boolean;
  /** Another quote of the same project holds a live entitlement (another purchase). */
  readonly anotherPurchase: boolean;
}

export type BankApplyBlocker = "CHECKOUT_RETIRED" | "ORDER_NOT_CAPTURABLE" | "PROVIDER_TIME_UNVERIFIED" | "TRANSFER_DEADLINE_PASSED" | "ROUTE_NOT_ENABLED" | "ANOTHER_PURCHASE";

export interface BankApplyJudgment {
  /** The first reason the credit cannot carry authority, null when only the purchased subject's guards remain to be judged. */
  readonly blocker: BankApplyBlocker | null;
  /** The effect instant is at or after the transfer deadline (the order cannot stay open). */
  readonly pastDeadline: boolean;
  /** issuedAt - tolerance <= bookedAt <= confirmedAt + tolerance; otherwise a PROVIDER_TIME_UNVERIFIED review case is opened. */
  readonly providerTimeVerified: boolean;
}

/**
 * DV1-06: a credit carries authority only when it was booked by the deadline plus the route version's tolerance (DEADLINE), its booking
 * instant is credible against the instructions' issuance and its own confirmation (PROVIDER-TIME), the route is still enabled, the
 * checkout was not retired, no other purchase of the project holds the entitlement, and — judged by the caller's subject guards —
 * the purchased subject still binds. Whether the sweep already expired the order does not change the answer.
 */
export function judgeBankApply(f: BankApplyFacts): BankApplyJudgment {
  const tol = f.toleranceMs;
  const booked = f.bookedAt === null ? null : Date.parse(f.bookedAt);
  const providerTimeVerified = booked !== null && f.confirmedAt !== null && booked >= Date.parse(f.issuedAt) - tol && booked <= Date.parse(f.confirmedAt) + tol;
  const pastDeadline = Date.parse(f.effectNow) >= Date.parse(f.transferExpiresAt);
  let blocker: BankApplyBlocker | null = null;
  if (f.orderState === "EXPIRED" && f.expiryCause === "RETIRED") blocker = "CHECKOUT_RETIRED";
  else if (f.orderState !== "AWAITING_TRANSFER" && f.orderState !== "PARTIALLY_RECEIVED" && f.orderState !== "EXPIRED") blocker = "ORDER_NOT_CAPTURABLE";
  else if (!providerTimeVerified) blocker = "PROVIDER_TIME_UNVERIFIED";
  else if (!creditOnTime(f.bookedAt!, f.transferExpiresAt, tol)) blocker = "TRANSFER_DEADLINE_PASSED";
  else if (!f.routeEnabled) blocker = "ROUTE_NOT_ENABLED";
  else if (f.anotherPurchase) blocker = "ANOTHER_PURCHASE";
  return { blocker, pastDeadline, providerTimeVerified };
}

/**
 * The bank order state after a credit was applied: CAPTURED only by the one exact capture that issued the purchase's authority; an
 * order already CAPTURED or under review stays; one whose deadline passed (or already EXPIRED) is EXPIRED; otherwise an amount still
 * owed is PARTIALLY_RECEIVED and anything else (the sum of partials, an excess, a capture without authority) is RECEIVED_REVIEW.
 */
export function bankOrderStateAfterApply(current: string, o: { readonly authorized: boolean; readonly pastDeadline: boolean; readonly expectedCents: bigint; readonly receivedCents: bigint }): string {
  if (o.authorized) return "CAPTURED";
  if (current === "CAPTURED" || current === "RECEIVED_REVIEW" || current === "EXPIRED") return current;
  if (o.pastDeadline) return "EXPIRED";
  return o.receivedCents < o.expectedCents ? "PARTIALLY_RECEIVED" : "RECEIVED_REVIEW";
}
/** A credit booked at or before the deadline plus the route version's named provider-time tolerance arrived on time (P1Δ). */
export function creditOnTime(bookedAt: string, transferExpiresAt: string, toleranceMs: number): boolean {
  return Date.parse(bookedAt) <= Date.parse(transferExpiresAt) + toleranceMs;
}
