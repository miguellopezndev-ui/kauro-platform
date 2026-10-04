/**
 * The commission policy (registry policy `commission`; 17 "Seller lifecycle and compensation"; design D10-RATE-1, D10-ELIG-1,
 * D10-ATTR-2, D10-CAL-1, D10-GUARD-1, D10-CLOCK-1). Every number the ledger and the time rules use comes from here, validated once:
 * a registry whose rule tokens differ from the ones this code implements refuses to compute, rather than computing another rule
 * under the same name (as B09's pricePolicyFrom refuses a discount combination it does not implement).
 *
 * Durations are exact hours (policy days x 24, B09 D-TIME-B1); calendar months are counted in the operational time zone.
 */
import { policy } from "@kauro/contracts";
import { zoneIsKnown } from "./calendar.js";

/**
 * The compensation planning guard (17 "Performance and compensation evolution": "total commercial compensation at most 15% of
 * attributable net service collections"; example 23). A business planning guard the owner reviews, never a legal ceiling and never
 * a refusal (D10-GUARD-1); the registry's policy file carries no value for it.
 */
export const COMPENSATION_PLANNING_GUARD_BPS = 1500;

export interface CommissionPolicy {
  /** The registry policy version the calculation follows (pricing.scheduleVersion, e.g. R2-INITIAL), recorded on every line. */
  readonly version: string;
  /** First qualifying project rate (commission.firstBps: 1000). */
  readonly firstBps: number;
  /** Subsequent project rate inside the window (commission.repeatBps: 400). */
  readonly repeatBps: number;
  /** The recurring window in calendar months of the operational time zone (commission.recurrenceCalendarMonths: 12). */
  readonly recurrenceCalendarMonths: number;
  /** An accepted claim's life and a claim's review deadline (commission.acceptedClaimDays 90 = 2160 h). */
  readonly acceptedClaimHours: number;
  /** The termination tail of an enumerated opportunity (commission.terminationOpportunityTailDays 90 = 2160 h). */
  readonly terminationTailHours: number;
  /** Payout eligibility after the FINAL completion (commission.eligibilityDaysAfterFinalCompletion 30 = 720 h). */
  readonly eligibilityHoursAfterFinalCompletion: number;
  /** The ordinal banking day after month-end on which a statement is due (commission.statementBusinessDay: 5). */
  readonly statementBankingDay: number;
  /** The ordinal banking day after month-end on which its payout is due (commission.payBusinessDay: 10). */
  readonly payBankingDay: number;
  /** The only payout floor (commission.minimumPayoutCents: 0; CMD052 NOTHING_PAYABLE is the zero payable). */
  readonly minimumPayoutCents: bigint;
  /** commission.operationalTimezone: America/Bogota. */
  readonly operationalTimeZone: string;
  readonly planningGuardBps: number;
}

/** The rule tokens this code implements; the registry must name exactly these. */
const RULES = {
  firstProjectDesignation: "STICKY_AFTER_FIRST_CAPTURE",
  base: "SERVICE_COLLECTED_AFTER_DISCOUNT_NET_OF_REFUND_EXCLUDING_TAX",
  calendarMonthRollover: "CLAMP_DAY_TO_LAST_DAY_OF_DESTINATION_MONTH",
  windowAnchor: "FIRST_DURABLE_CAPTURE_CONFIRMATION",
  subsequentCutoff: "VERIFIED_PROVIDER_COMPLETION_BEFORE_EXCLUSIVE_END",
  splitRemainder: "LARGEST_FRACTION_THEN_BENEFICIARY_ID_ASC",
} as const;

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError(`commission policy: ${where} is not an object`);
  return v as Record<string, unknown>;
}

function integer(v: unknown, where: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new TypeError(`commission policy: ${where} is not an integer in ${min}..${max}`);
  return v;
}

/** Validates the registry's `commission` section (and the schedule version it is versioned with) into a CommissionPolicy. */
export function commissionPolicyFrom(rawPolicy: unknown): CommissionPolicy {
  const root = record(rawPolicy, "policy");
  const c = record(root["commission"], "commission");
  for (const [key, token] of Object.entries(RULES)) {
    if (c[key] !== token) throw new TypeError(`commission policy: ${key} must be ${token}`);
  }
  const version = record(root["pricing"], "pricing")["scheduleVersion"];
  if (typeof version !== "string" || !/^[A-Z][A-Z0-9_.-]{0,63}$/.test(version)) throw new TypeError("commission policy: the schedule version is not a version token");
  const zone = c["operationalTimezone"];
  if (typeof zone !== "string" || !zoneIsKnown(zone)) throw new TypeError("commission policy: operationalTimezone is not a known time zone");
  const minimum = integer(c["minimumPayoutCents"], "minimumPayoutCents", 0);
  const statementBankingDay = integer(c["statementBusinessDay"], "statementBusinessDay", 1, 23);
  const payBankingDay = integer(c["payBusinessDay"], "payBusinessDay", 1, 23);
  if (payBankingDay < statementBankingDay) throw new TypeError("commission policy: the pay day precedes the statement day");
  return {
    version,
    firstBps: integer(c["firstBps"], "firstBps", 0, 10_000),
    repeatBps: integer(c["repeatBps"], "repeatBps", 0, 10_000),
    recurrenceCalendarMonths: integer(c["recurrenceCalendarMonths"], "recurrenceCalendarMonths", 1, 120),
    acceptedClaimHours: integer(c["acceptedClaimDays"], "acceptedClaimDays", 1, 3650) * 24,
    terminationTailHours: integer(c["terminationOpportunityTailDays"], "terminationOpportunityTailDays", 1, 3650) * 24,
    eligibilityHoursAfterFinalCompletion: integer(c["eligibilityDaysAfterFinalCompletion"], "eligibilityDaysAfterFinalCompletion", 0, 3650) * 24,
    statementBankingDay,
    payBankingDay,
    minimumPayoutCents: BigInt(minimum),
    operationalTimeZone: zone,
    planningGuardBps: COMPENSATION_PLANNING_GUARD_BPS,
  };
}

/** The commission policy of the vendored registry (provenance-checked by @kauro/contracts). */
export function registryCommissionPolicy(): CommissionPolicy {
  return commissionPolicyFrom(policy());
}
