/**
 * The pending-payment hold of CP-01.11 (status CONDITIONAL: parameters approved by the owner on 2026-10-22, activation blocked by PV1).
 * Built against the O19A build profile with its activation OFF (o27a-flags.ts): `requestHold` refuses HOLD_NOT_ACTIVE unless the caller
 * passes an activation that enables it, which only tests do.
 *
 * Values (CP-01.11 patch retention.pendingPaymentHold): route ACH; five US banking days from the valid acceptance of the proof on the
 * FedACH calendar; an absolute ceiling of 24 days from sealing; effective end = the earlier of the two; one hold per quote and per sealed
 * set, never renewable, never added to an extension (the later date applies, within the ceiling); step-up to present the proof; the proof
 * is a transfer already sent with the exact amount and reference; the hold is never a payment and never authorizes execution; ended
 * unpaid -> DELETE; a late credit -> review and refund, never data revival; owner review from the third hold ended unpaid in a rolling
 * 90-day window per organization.
 *
 * Decisions of this order (recorded in O27A-READY.json):
 *  - O27A-HOLD-1: the acceptance day is not counted; the end is the end (00:00 New York of the next day) of the fifth banking day
 *    strictly after the acceptance's New York date (o27a-fedach-calendar.ts, O27A-CAL-1).
 *  - O27A-HOLD-2: "24 days from sealing" is 576 exact hours (the platform's D-TIME-B1: policy days are exact hours).
 *  - O27A-HOLD-3: "owner review from the third hold ended unpaid": a request made while the organization already has two or more
 *    holds ended unpaid inside the rolling 90 days (the request would be the third) needs the owner's review before it is granted.
 *  - O27A-HOLD-4: uniqueness counts every hold ever granted for the quote or the sealed set, whatever its state (never renewable).
 */
import type { BankingDays } from "../commercial/calendar.js";
import { assertMoney } from "./money.js";
import { O27A_ACTIVATION, type O27AActivation } from "./o27a-flags.js";
import { fedAchDateOf, fedAchDayEndsAt, nthBankingDayAfter } from "./o27a-fedach-calendar.js";

export const PENDING_PAYMENT_HOLD_POLICY = Object.freeze({
  route: "ACH" as const,
  businessDaysFromAcceptedProof: 5,
  calendar: "US_FEDERAL_RESERVE_BANKING_DAYS" as const,
  ceilingDaysFromSeal: 24,
  perQuote: 1,
  perSealedSet: 1,
  renewable: false,
  addsToExtension: false,
  stepUpRequired: true,
  isPayment: false,
  authorizesExecution: false,
  endedUnpaid: "DELETE" as const,
  lateCredit: "REVIEW_AND_REFUND_NO_DATA_REVIVAL" as const,
  ownerReview: Object.freeze({ fromEndedUnpaidHold: 3, rollingWindowDays: 90, scope: "ORGANIZATION" as const }),
});

const HOUR = 3_600_000;

export type HoldState = "ACTIVE" | "PAID" | "ENDED_UNPAID";

export interface HoldRecord {
  readonly holdId: string;
  readonly organizationId: string;
  readonly quoteId: string;
  readonly sealedSetId: string;
  readonly state: HoldState;
  readonly effectiveEndAt: string;
  /** When it ended (PAID or ENDED_UNPAID); null while ACTIVE. */
  readonly endedAt: string | null;
}

export interface TransferProof {
  readonly route: string;
  readonly currency: string;
  readonly amountCents: bigint;
  readonly reference: string;
  /** When the customer says the transfer was sent. */
  readonly sentAt: string;
}

export interface QuoteForHold {
  readonly quoteId: string;
  readonly organizationId: string;
  readonly sealedSetId: string;
  readonly amountCents: bigint;
  readonly currency: "USD";
  /** The transfer reference the quote's instructions carry. */
  readonly reference: string;
  readonly sealedAt: string;
  /** The end of an approved retention extension (CP-01.02), if any. */
  readonly extensionEndsAt: string | null;
  /** True when the quote is already paid (a confirmed capture exists). */
  readonly paid: boolean;
}

export type HoldRefusal =
  | "HOLD_NOT_ACTIVE"
  | "STEP_UP_REQUIRED"
  | "ROUTE_NOT_ACH"
  | "CURRENCY_NOT_USD"
  | "AMOUNT_MISMATCH"
  | "REFERENCE_MISMATCH"
  | "TRANSFER_NOT_SENT_YET"
  | "QUOTE_ALREADY_PAID"
  | "HOLD_EXISTS_FOR_QUOTE"
  | "HOLD_EXISTS_FOR_SEALED_SET"
  | "CEILING_PASSED"
  | "CALENDAR_UNAVAILABLE";

export type HoldDecision =
  | { readonly kind: "REFUSED"; readonly reason: HoldRefusal }
  | { readonly kind: "OWNER_REVIEW_REQUIRED"; readonly endedUnpaidInWindow: number; readonly hold: GrantedHold }
  | { readonly kind: "GRANTED"; readonly hold: GrantedHold };

export interface GrantedHold {
  readonly quoteId: string;
  readonly sealedSetId: string;
  readonly organizationId: string;
  /** The end of the fifth banking day after the acceptance. */
  readonly businessDaysEndAt: string;
  /** sealedAt + 576 hours. */
  readonly ceilingAt: string;
  /** The date the customer sees and the retention follows: min(max(businessDaysEnd, extension), ceiling). */
  readonly effectiveEndAt: string;
  readonly whichApplied: "BUSINESS_DAYS" | "CEILING" | "EXTENSION";
  /** Never a payment, never an authorization to execute or prepare (F-23). */
  readonly isPayment: false;
  readonly authorizesExecution: false;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The hold's dates for a proof accepted at `acceptedAt` (O27A-HOLD-1, -2); null when the calendar does not cover the count. */
export function holdDates(input: { readonly acceptedAt: string; readonly sealedAt: string; readonly extensionEndsAt: string | null; readonly calendar: BankingDays }):
  | Pick<GrantedHold, "businessDaysEndAt" | "ceilingAt" | "effectiveEndAt" | "whichApplied">
  | null {
  const accepted = Date.parse(input.acceptedAt);
  const fifth = nthBankingDayAfter(fedAchDateOf(accepted), PENDING_PAYMENT_HOLD_POLICY.businessDaysFromAcceptedProof, input.calendar);
  if (fifth === null) return null;
  const businessEnd = fedAchDayEndsAt(fifth);
  const ceiling = Date.parse(input.sealedAt) + PENDING_PAYMENT_HOLD_POLICY.ceilingDaysFromSeal * 24 * HOUR;
  const extension = input.extensionEndsAt === null ? null : Date.parse(input.extensionEndsAt);
  // never added to the extension: the later date of the two applies, within the ceiling
  let candidate = businessEnd;
  let which: GrantedHold["whichApplied"] = "BUSINESS_DAYS";
  if (extension !== null && extension > businessEnd) {
    candidate = extension;
    which = "EXTENSION";
  }
  if (ceiling < candidate) {
    candidate = ceiling;
    which = "CEILING";
  }
  return { businessDaysEndAt: iso(businessEnd), ceilingAt: iso(ceiling), effectiveEndAt: iso(candidate), whichApplied: which };
}

/** Holds of the organization that ended unpaid inside the rolling window ending at `now` (O27A-HOLD-3). */
export function endedUnpaidInWindow(holds: ReadonlyArray<HoldRecord>, organizationId: string, now: string): number {
  const to = Date.parse(now);
  const from = to - PENDING_PAYMENT_HOLD_POLICY.ownerReview.rollingWindowDays * 24 * HOUR;
  return holds.filter((h) => h.organizationId === organizationId && h.state === "ENDED_UNPAID" && h.endedAt !== null && Date.parse(h.endedAt) > from && Date.parse(h.endedAt) <= to).length;
}

/**
 * The decision on a request to hold the data of a sealed set while a sent transfer is confirmed. Pure: `now` is the database clock the
 * caller read after its locks; `existing` is every hold ever recorded for the organization, the quote and the sealed set.
 */
export function requestHold(input: {
  readonly quote: QuoteForHold;
  readonly proof: TransferProof;
  readonly stepUpFresh: boolean;
  readonly now: string;
  readonly existing: ReadonlyArray<HoldRecord>;
  readonly calendar: BankingDays;
  readonly activation?: O27AActivation;
}): HoldDecision {
  const activation = input.activation ?? O27A_ACTIVATION;
  const refuse = (reason: HoldRefusal): HoldDecision => ({ kind: "REFUSED", reason });
  if (!activation.pendingPaymentHold) return refuse("HOLD_NOT_ACTIVE");
  if (!input.stepUpFresh) return refuse("STEP_UP_REQUIRED");
  const { quote, proof } = input;
  if (proof.route !== PENDING_PAYMENT_HOLD_POLICY.route) return refuse("ROUTE_NOT_ACH");
  if (proof.currency !== "USD" || quote.currency !== "USD") return refuse("CURRENCY_NOT_USD");
  if (assertMoney(proof.amountCents) !== assertMoney(quote.amountCents)) return refuse("AMOUNT_MISMATCH");
  if (proof.reference !== quote.reference) return refuse("REFERENCE_MISMATCH");
  if (Date.parse(proof.sentAt) > Date.parse(input.now)) return refuse("TRANSFER_NOT_SENT_YET");
  if (quote.paid) return refuse("QUOTE_ALREADY_PAID");
  if (input.existing.some((h) => h.quoteId === quote.quoteId)) return refuse("HOLD_EXISTS_FOR_QUOTE");
  if (input.existing.some((h) => h.sealedSetId === quote.sealedSetId)) return refuse("HOLD_EXISTS_FOR_SEALED_SET");
  const dates = holdDates({ acceptedAt: input.now, sealedAt: quote.sealedAt, extensionEndsAt: quote.extensionEndsAt, calendar: input.calendar });
  if (dates === null) return refuse("CALENDAR_UNAVAILABLE");
  if (Date.parse(dates.effectiveEndAt) <= Date.parse(input.now)) return refuse("CEILING_PASSED");
  const hold: GrantedHold = { quoteId: quote.quoteId, sealedSetId: quote.sealedSetId, organizationId: quote.organizationId, ...dates, isPayment: false, authorizesExecution: false };
  const prior = endedUnpaidInWindow(input.existing, quote.organizationId, input.now);
  if (prior >= PENDING_PAYMENT_HOLD_POLICY.ownerReview.fromEndedUnpaidHold - 1) return { kind: "OWNER_REVIEW_REQUIRED", endedUnpaidInWindow: prior, hold };
  return { kind: "GRANTED", hold };
}

/** What happens when an ACTIVE hold reaches its effective end (or is paid). Never a payment, never execution. */
export type HoldEnding =
  | { readonly kind: "STILL_ACTIVE" }
  | { readonly kind: "PAID" }
  | { readonly kind: "ENDED_UNPAID"; readonly retention: "DELETE" };

export function holdEnding(hold: Pick<HoldRecord, "state" | "effectiveEndAt">, facts: { readonly confirmedPaymentAt: string | null; readonly now: string }): HoldEnding {
  if (hold.state !== "ACTIVE") throw new RangeError("only an ACTIVE hold ends");
  const end = Date.parse(hold.effectiveEndAt);
  // only a payment actually reconciled before the end keeps the data; a declared transfer or a proof never does
  if (facts.confirmedPaymentAt !== null && Date.parse(facts.confirmedPaymentAt) < end) return { kind: "PAID" };
  if (Date.parse(facts.now) >= end) return { kind: "ENDED_UNPAID", retention: "DELETE" };
  return { kind: "STILL_ACTIVE" };
}

/**
 * A credit that arrives after the hold ended unpaid and the data was deleted: review and refund, never data revival (CP-01.11). The
 * decision carries no path back to the deleted project.
 */
export function lateCreditTreatment(hold: Pick<HoldRecord, "state">): { readonly kind: "REVIEW_AND_REFUND"; readonly revivesData: false } | { readonly kind: "NOT_LATE" } {
  return hold.state === "ENDED_UNPAID" ? { kind: "REVIEW_AND_REFUND", revivesData: false } : { kind: "NOT_LATE" };
}
