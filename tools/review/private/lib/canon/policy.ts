// The policy numbers the canonical world is checked against. Prices, bands, discounts, quote validity and retention come from the web's
// vendored snapshot (apps/web/src/public/policy-snapshot.ts, itself held equal to the registry by a test); the commission block is not in
// that snapshot, so it is restated here and tools/test/canon.test.mjs holds it equal to packages/contracts/registry/policy.json.
import { POLICY_SNAPSHOT } from "../../../../../apps/web/src/public/policy-snapshot.ts";
import { bandIndexOf, priceOf } from "../../../../../apps/web/src/public/pricing-bands.ts";

export { bandIndexOf, POLICY_SNAPSHOT, priceOf };

export const COMMISSION = Object.freeze({
  firstBps: 1000,
  repeatBps: 400,
  recurrenceCalendarMonths: 12,
  acceptedClaimDays: 90,
  eligibilityDaysAfterFinalCompletion: 30,
  statementBusinessDay: 5,
  payBusinessDay: 10,
});

/** Proposed by the owner's decision of 2026-10-21 (pending-payment hold); named as proposals wherever a screen shows them. */
export const PROPOSED = Object.freeze({
  holdBusinessDays: 5,
  unpaidCeilingDays: 24,
  extendedCeilingDays: 17,
});

/** The owner's alert rules of 2026-10-21. */
export const ALERT_RULES = Object.freeze({
  inactivityDays: 14,
  deadlineDaysBefore: 2,
  claimWarningDays: [14, 3] as readonly number[],
  pilotReviewDaysBefore: 14,
});

/** The legal validation of the claim rules is pending (owner, 2026-10-21): never shown as settled. */
export const CLAIM_RULES_LEGAL_STATUS = "PENDING_LEGAL_VALIDATION" as const;

/** The repeat discount for a count of prior paid projects in the lookback window (0 prior: none). */
export function repeatPercent(prior: number): number {
  return [...POLICY_SNAPSHOT.repeatTiers].reverse().find((tier) => prior >= tier.minimum)?.percent ?? 0;
}

/** A rate in basis points of an amount in minor units, rounded half away from zero to the minor unit. */
export const ofBps = (minor: number, bps: number): number => Math.sign(minor) * Math.round((Math.abs(minor) * bps) / 10_000);
