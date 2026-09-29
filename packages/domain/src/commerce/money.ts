/**
 * Exact money (reference/HASHING_AND_ACCOUNTING_RULES "Exact money"; 15 "Exact representation and rounding"; registry policy
 * money: currency USD, minor unit 2, rounding HALF_UP_ON_NONNEGATIVE_RATIONAL).
 *
 * Every amount is an integer number of minor units. Inside the domain it is a `bigint`, so no multiplication can overflow or
 * drift ("Use an arbitrary-precision integer internally where necessary"); on the wire and in contracts it is the decimal
 * string of contract type MoneyMinorUnits; in event payloads it is a non-negative safe integer. The representable envelope is
 * 0..2^53-1 minor units, the exactly representable JSON integer range (the database checks the same bound, kauro.is_money).
 *
 * The one rounding primitive is the authority's formula for a non-negative basis B and a rate r in basis points:
 *   rounded = floor((B x r + 5000) / 10000)
 * which is half-up (equivalently half-away-from-zero, 15, since every operand is non-negative). A value is rounded once, at the
 * named boundary: the discount from the undiscounted base, the tax from the service by the reviewed rule, a provider fee in an
 * illustration, a cumulative entitlement from its cumulative basis. Differences are never re-rounded.
 */
import type { MoneyMinorUnits } from "@kauro/contracts";
import { InvalidRequestFailure } from "../model/errors.js";

/** Largest representable amount in minor units (2^53 - 1). */
export const MONEY_MAX = 9_007_199_254_740_991n;

const MONEY_TEXT = /^(0|[1-9][0-9]{0,15})$/;

export function isMoney(value: bigint): boolean {
  return value >= 0n && value <= MONEY_MAX;
}

/** Throws a RangeError for an amount outside 0..MONEY_MAX (a programming error, never a request error). */
export function assertMoney(value: bigint): bigint {
  if (!isMoney(value)) throw new RangeError("amount outside the representable minor-unit envelope");
  return value;
}

/** True for a MoneyMinorUnits decimal string inside the envelope (no sign, no leading zeros, no fraction). */
export function isMoneyText(value: unknown): value is MoneyMinorUnits {
  return typeof value === "string" && MONEY_TEXT.test(value) && BigInt(value) <= MONEY_MAX;
}

/** Parses a request member of type money; a refusal names the field, never the value (10 "Responses and safe errors"). */
export function parseMoney(field: string, value: unknown): bigint {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!MONEY_TEXT.test(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  const parsed = BigInt(value);
  if (parsed > MONEY_MAX) throw new InvalidRequestFailure([{ field, code: "RANGE" }]);
  return parsed;
}

export function formatMoney(value: bigint): MoneyMinorUnits {
  return assertMoney(value).toString(10);
}

/** An amount as an event-payload count (07: payloads carry safe counts, never labels). */
export function moneyCount(value: bigint): number {
  return Number(assertMoney(value));
}

function assertBps(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("a rate is an integer number of basis points between 0 and 10000");
  return BigInt(bps);
}

/** floor((basis x bps + 5000) / 10000) for a non-negative basis: the single rounding primitive of the platform. */
export function roundHalfUpBps(basis: bigint, bps: number): bigint {
  assertMoney(basis);
  return (basis * assertBps(bps) + 5_000n) / 10_000n;
}

/** Discount amount of an undiscounted base (16 "round the discount amount once in minor units"). */
export function discountCents(baseServiceCents: bigint, discountBps: number): bigint {
  return roundHalfUpBps(baseServiceCents, discountBps);
}

/**
 * A processor fee under an illustrative profile (rate in basis points plus a fixed amount; 15 "Fee reference and example").
 * R2-078: 97125 at 540 bps + 30 is fee 5275, net 91850. The illustration never posts to the ledger: the actual fee is the one
 * the provider reports for the capture ("actual statement fees replace the illustration").
 */
export interface FeeProfile {
  readonly rateBps: number;
  readonly fixedCents: bigint;
}

export function illustrativeProcessorFee(amountCents: bigint, profile: FeeProfile): { readonly feeCents: bigint; readonly netCents: bigint } {
  const feeCents = roundHalfUpBps(amountCents, profile.rateBps) + assertMoney(profile.fixedCents);
  if (feeCents > amountCents) throw new RangeError("fee exceeds the amount");
  return { feeCents, netCents: amountCents - feeCents };
}

/**
 * Deterministic allocation of an already rounded total over weighted parts (15 "any rounding remainder follows a
 * deterministic rule recorded in the allocation"; policy commission.splitRemainder LARGEST_FRACTION_THEN_BENEFICIARY_ID_ASC):
 * floor every proportional share, then give the remaining units one by one in descending fractional remainder, ties broken by
 * ascending key (code-point order). The shares always sum to the total.
 */
export function allocateLargestRemainder(total: bigint, parts: ReadonlyArray<{ readonly key: string; readonly weight: bigint }>): ReadonlyMap<string, bigint> {
  assertMoney(total);
  if (parts.length === 0) throw new RangeError("an allocation needs at least one part");
  const keys = new Set<string>();
  let weightSum = 0n;
  for (const p of parts) {
    if (p.weight < 0n) throw new RangeError("allocation weights are non-negative");
    if (keys.has(p.key)) throw new RangeError("allocation keys are unique");
    keys.add(p.key);
    weightSum += p.weight;
  }
  const out = new Map<string, bigint>();
  if (weightSum === 0n) {
    if (total !== 0n) throw new RangeError("a positive total cannot be allocated over zero weights");
    for (const p of parts) out.set(p.key, 0n);
    return out;
  }
  const rows = parts.map((p) => {
    const product = total * p.weight;
    return { key: p.key, floor: product / weightSum, remainder: product % weightSum };
  });
  let assigned = 0n;
  for (const r of rows) assigned += r.floor;
  let left = total - assigned;
  const order = [...rows].sort((a, b) => (a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.remainder > b.remainder ? -1 : 1));
  for (const r of order) {
    if (left === 0n) break;
    r.floor += 1n;
    left -= 1n;
  }
  for (const r of rows) out.set(r.key, r.floor);
  return out;
}

/**
 * Cumulative entitlement on a cumulative basis (reference/HASHING "For a partial refund, compute new cumulative commission from
 * the remaining service basis and post the difference from the previous cumulative entitlement"). Recomputing from the
 * cumulative basis — never rounding each refund on its own — is what makes a sequence of partial refunds end at exactly zero
 * (R2-081).
 */
export function cumulativeEntitlement(basisCents: bigint, rateBps: number): bigint {
  return roundHalfUpBps(basisCents, rateBps);
}

/** The signed adjustment that moves a previously posted cumulative entitlement to the one of the new basis. */
export function entitlementAdjustment(previousCumulativeCents: bigint, basisAfterCents: bigint, rateBps: number): bigint {
  assertMoney(previousCumulativeCents);
  return cumulativeEntitlement(basisAfterCents, rateBps) - previousCumulativeCents;
}

export function sumMoney(values: ReadonlyArray<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += assertMoney(v);
  return assertMoney(total);
}
