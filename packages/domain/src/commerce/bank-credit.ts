/**
 * The inbound side of the bank-transfer route of Payments V1 (docs/design/ACH-ROUTE.md r12 §7.5 C5, §7.6 C4/C6, §7.9 M1/M2, §7.10 P1,
 * §7.12 E1, §7.23 SI2; lane PV1-INBOUND): the credit's states, the aggregates and events of the credit, the statement import and the
 * bank order's state changes, the matching decision (M1) and the bank order state a received credit leads to. Pure: no clock is read here;
 * the caller passes the effect instant it read after its locks.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { BankCreditState } from "./records.js";

export const BANK_CREDIT_RAILS = ["ACH", "DOMESTIC_WIRE"] as const;
export type BankCreditRail = (typeof BANK_CREDIT_RAILS)[number];

/** The credit and statement import are agency-less aggregates (platform scope); an order's bank state change is the agency's. */
export const BANK_CREDIT_AGGREGATE_KINDS = ["bank_credit", "statement_import"] as const;
export const BANK_CREDIT_EVENT_TYPES = [
  "bank_credit.drafted.v1",
  "bank_credit.received.v1",
  "bank_credit.matched.v1",
  "bank_credit.review_required.v1",
  "bank_credit.applied.v1",
  "statement_import.recorded.v1",
  "bank_transfer_instruction.order_state_changed.v1",
] as const;
export type BankCreditEventType = (typeof BANK_CREDIT_EVENT_TYPES)[number];

/** References, hashes and states only: never an amount's payer, a reference (a payment secret of the buyer) or an account number. */
export const BANK_CREDIT_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<BankCreditEventType, ReadonlyArray<string>>> = Object.freeze({
  "bank_credit.drafted.v1": ["creditId", "accountRef", "state", "evidenceHash"],
  "bank_credit.received.v1": ["creditId", "accountRef", "state", "previousState", "evidenceHash"],
  "bank_credit.matched.v1": ["creditId", "accountRef", "orderId", "state", "previousState", "decision"],
  "bank_credit.review_required.v1": ["creditId", "accountRef", "state", "previousState", "reason"],
  "bank_credit.applied.v1": ["creditId", "accountRef", "orderId", "captureId", "state", "previousState"],
  "statement_import.recorded.v1": ["importId", "accountRef", "evidenceHash", "lines", "newLines"],
  "bank_transfer_instruction.order_state_changed.v1": ["orderId", "agencyId", "previousState", "orderState", "cause"],
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
  if (!keys.acceptedRails.includes(credit.rail)) return { kind: "REVIEW", reason: "RAIL_NOT_ACCEPTED" };
  if (keys.payeeDigest !== null && credit.payeeDigest !== null && keys.payeeDigest !== credit.payeeDigest) return { kind: "REVIEW", reason: "PAYEE_MISMATCH" };
  if (keys.acceptedPayerDigest === null || credit.payerDigest === null || keys.acceptedPayerDigest !== credit.payerDigest) return { kind: "REVIEW", reason: "PAYER_MISMATCH" };
  return { kind: "MATCHED" };
}

/** The bank order state a received credit of `receivedCents` (in total, this credit included) leads to (BANK_ORDER_EXTENSION). */
export function bankOrderStateAfterReceipt(current: string, expectedCents: bigint, receivedCents: bigint, onTime: boolean): string {
  if (current === "EXPIRED") return onTime && receivedCents === expectedCents ? "CAPTURED" : "EXPIRED";
  if (current !== "AWAITING_TRANSFER" && current !== "PARTIALLY_RECEIVED") return current;
  if (receivedCents === expectedCents) return "CAPTURED";
  if (receivedCents > expectedCents) return "RECEIVED_REVIEW";
  return "PARTIALLY_RECEIVED";
}

/** A credit booked at or before the deadline plus the route version's named provider-time tolerance arrived on time (P1Δ). */
export function creditOnTime(bookedAt: string, transferExpiresAt: string, toleranceMs: number): boolean {
  return Date.parse(bookedAt) <= Date.parse(transferExpiresAt) + toleranceMs;
}
