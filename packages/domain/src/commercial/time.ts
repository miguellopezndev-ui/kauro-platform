/**
 * The time rules of the commission domain (design D10-ATTR-2, D10-RATE-1, D10-ELIG-1, D10-CAL-1, D10-CLOCK-1; 17 "First qualifying
 * project", "Recurring entitlement", "Accrual, eligibility and payout", "Business-day calendar"; examples 10, 11, 14, 15 and 21).
 * Every instant a caller passes is the database clock's (`kauro.server_now()`); these functions never read a clock themselves.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { FundsState } from "../commerce/records.js";
import { addCalendarMonths, addHours, assertCanonicalInstant, bankingDayAfterMonthEnd, monthStartsAt, nextMonth, type BankingDays } from "./calendar.js";
import type { CommissionPolicy } from "./policy.js";
import type { CompletionKind } from "./records.js";

/**
 * The exclusive end of a recurring window (D10-ATTR-2; policy windowAnchor FIRST_DURABLE_CAPTURE_CONFIRMATION): the first
 * qualifying confirmation plus twelve calendar months at the same America/Bogota wall time, the day clamped. R2-094: 2028-02-29
 * 10:00 in Bogota ends at 2029-02-28 10:00.
 */
export function recurrenceWindowEndsAt(windowStartsAt: UtcInstant, terms: Pick<CommissionPolicy, "recurrenceCalendarMonths" | "operationalTimeZone">): UtcInstant {
  return addCalendarMonths(windowStartsAt, terms.recurrenceCalendarMonths, terms.operationalTimeZone);
}

/** The facts the acquisition rate of a purchase is decided on (§6 "Rate"). */
export interface AcquisitionRateFacts {
  /** The purchase's confirmation sequence in its agency (1 is the sticky first designation). */
  readonly confirmationSeq: number;
  /** The durable confirmation (the authorization's server instant). */
  readonly confirmedAt: UtcInstant;
  readonly orderCreatedAt: UtcInstant;
  /** The authenticated provider completion, or null when the provider reported none. */
  readonly providerCompletedAt: UtcInstant | null;
  /** The acquisition entitlement's exclusive window end. */
  readonly windowEndsAt: UtcInstant;
}

export type AcquisitionRateDecision =
  | { readonly kind: "FIRST"; readonly rateBps: number }
  | { readonly kind: "REPEAT"; readonly rateBps: number }
  /** The subsequent cutoff cannot be decided: the line is born HELD at the repeat rate, the only rate the cutoff can grant. */
  | { readonly kind: "HELD"; readonly rateBps: number; readonly reason: "PROVIDER_TIME_UNVERIFIED" }
  | { readonly kind: "NONE"; readonly reason: "WINDOW_ENDED" };

/**
 * A provider completion is plausible when it exists, is not after the purchase's own confirmation and not before its order's
 * creation (example 10: "missing, malformed or implausibly inconsistent" holds the cutoff decision).
 */
export function providerTimePlausible(facts: Pick<AcquisitionRateFacts, "confirmedAt" | "orderCreatedAt" | "providerCompletedAt">): boolean {
  if (facts.providerCompletedAt === null) return false;
  const completed = assertCanonicalInstant(facts.providerCompletedAt, "providerCompletedAt");
  return completed <= assertCanonicalInstant(facts.confirmedAt, "confirmedAt") && completed >= assertCanonicalInstant(facts.orderCreatedAt, "orderCreatedAt");
}

/**
 * The acquisition rate of a qualifying purchase (D10-RATE-1; policy subsequentCutoff VERIFIED_PROVIDER_COMPLETION_BEFORE_EXCLUSIVE_END):
 * sequence 1 earns the first rate; a later sequence earns the repeat rate iff its verified provider completion precedes the
 * exclusive window end — never the quote, confirmation or notification instant (R2-138) — and otherwise no acquisition line
 * (R2-098). The provider instant decides only that cutoff, so an implausible or missing one holds a later purchase's line
 * PROVIDER_TIME_UNVERIFIED instead of guessing from another instant (example 10). `terms` are the policy's or the beneficiary's
 * signed agreement's rates.
 */
export function acquisitionRate(terms: { readonly firstBps: number; readonly repeatBps: number }, facts: AcquisitionRateFacts): AcquisitionRateDecision {
  if (!Number.isSafeInteger(facts.confirmationSeq) || facts.confirmationSeq < 1) throw new RangeError("a confirmation sequence starts at 1");
  const windowEnd = assertCanonicalInstant(facts.windowEndsAt, "windowEndsAt");
  if (facts.confirmationSeq === 1) return { kind: "FIRST", rateBps: terms.firstBps };
  if (!providerTimePlausible(facts)) return { kind: "HELD", rateBps: terms.repeatBps, reason: "PROVIDER_TIME_UNVERIFIED" };
  return Date.parse(facts.providerCompletedAt as UtcInstant) < windowEnd ? { kind: "REPEAT", rateBps: terms.repeatBps } : { kind: "NONE", reason: "WINDOW_ENDED" };
}

/** The facts a line's payout eligibility is decided on (§6 "Completion and eligibility"). */
export interface EligibilityFacts {
  /** The purchase's recorded completions: at most one per kind. */
  readonly completions: ReadonlyArray<{ readonly kind: CompletionKind; readonly completedAt: UtcInstant }>;
  /** The capture's observed funds availability. */
  readonly fundsState: FundsState;
  /** The line's unpaid cents (cumulative entitlement less paid). */
  readonly unpaidCents: bigint;
  /** The OPEN holds on the line, summed; never more than the unpaid cents. */
  readonly openHoldCents: bigint;
}

export type EligibilityDecision =
  | { readonly state: "AWAITING_FINAL_COMPLETION"; readonly eligibleAt: null }
  | { readonly state: "NOT_DUE"; readonly eligibleAt: UtcInstant }
  | { readonly state: "FUNDS_NOT_AVAILABLE"; readonly eligibleAt: UtcInstant; readonly fundsState: Exclude<FundsState, "AVAILABLE"> }
  | { readonly state: "HELD"; readonly eligibleAt: UtcInstant }
  | { readonly state: "ELIGIBLE"; readonly eligibleAt: UtcInstant };

/** The instant a purchase's lines become due: FINAL + 720 h, or null while no FINAL completion exists (a STAGE starts nothing). */
export function eligibleAtOf(terms: Pick<CommissionPolicy, "eligibilityHoursAfterFinalCompletion">, completions: EligibilityFacts["completions"]): UtcInstant | null {
  const finals = completions.filter((c) => c.kind === "FINAL");
  if (finals.length > 1) throw new RangeError("a purchase has at most one FINAL completion");
  const final = finals[0];
  return final === undefined ? null : addHours(final.completedAt, terms.eligibilityHoursAfterFinalCompletion);
}

/** A hold covers a line when the OPEN held cents are the whole unpaid amount (D10-HOLD-1: a partial hold leaves it on its path). */
export function holdCoversLine(openHoldCents: bigint, unpaidCents: bigint): boolean {
  if (openHoldCents < 0n || unpaidCents < 0n) throw new RangeError("held and unpaid cents are non-negative");
  if (openHoldCents > unpaidCents) throw new RangeError("a hold never exceeds the line's unpaid cents");
  return openHoldCents > 0n && openHoldCents === unpaidCents;
}

/**
 * The eligibility decision of an ACCRUED_PENDING or HELD line at `now` (D10-ELIG-1; KC007): due 720 hours after a FINAL completion,
 * the capture's funds AVAILABLE, and no hold covering the line. A STAGE completion starts no clock (R2-101; example 15); funds held
 * by the provider keep a due line from ELIGIBLE (example 14).
 */
export function eligibilityDecision(terms: Pick<CommissionPolicy, "eligibilityHoursAfterFinalCompletion">, facts: EligibilityFacts, now: UtcInstant): EligibilityDecision {
  const at = assertCanonicalInstant(now, "now");
  const covered = holdCoversLine(facts.openHoldCents, facts.unpaidCents);
  const eligibleAt = eligibleAtOf(terms, facts.completions);
  if (eligibleAt === null) return { state: "AWAITING_FINAL_COMPLETION", eligibleAt: null };
  if (at < Date.parse(eligibleAt)) return { state: "NOT_DUE", eligibleAt };
  if (facts.fundsState !== "AVAILABLE") return { state: "FUNDS_NOT_AVAILABLE", eligibleAt, fundsState: facts.fundsState };
  if (covered) return { state: "HELD", eligibleAt };
  return { state: "ELIGIBLE", eligibleAt };
}

/** A commission period: one calendar month of the operational zone, [start, end), with its close and pay dates (D10-CAL-1). */
export interface CommissionPeriodDates {
  readonly month: string;
  readonly startsAt: UtcInstant;
  readonly endsAt: UtcInstant;
  readonly closeDueOn: string;
  readonly payDueOn: string;
}

/**
 * The period of a month (YYYY-MM) under the policy and an explicit calendar: it starts at 00:00 on the month's first day in America/
 * Bogota and ends at the next month's; its statement is due on the 5th and its payout on the 10th banking day after month-end.
 */
export function commissionPeriodOf(month: string, terms: Pick<CommissionPolicy, "operationalTimeZone" | "statementBankingDay" | "payBankingDay">, calendar: BankingDays): CommissionPeriodDates {
  return {
    month,
    startsAt: monthStartsAt(month, terms.operationalTimeZone),
    endsAt: monthStartsAt(nextMonth(month), terms.operationalTimeZone),
    closeDueOn: bankingDayAfterMonthEnd(month, terms.statementBankingDay, calendar),
    payDueOn: bankingDayAfterMonthEnd(month, terms.payBankingDay, calendar),
  };
}
