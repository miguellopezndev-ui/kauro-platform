/**
 * Grant arithmetic and audit deadlines (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md D8-GRANT-1,
 * D8-GRANT-2, D8-AUD-1; 06 "Budget algebra"; registry CostGrant: availableCents is "derived remaining amount; never browser-provided
 * authority"). Pure functions over bigint cents; migration 0023 enforces the same algebra (cost_grants_within_ceiling, the reservation
 * trigger of request_journal, the audit's deadline CHECK), and the database decides under the grant's row lock — these answer what a
 * caller may expect before it asks.
 */
import type { UtcInstant } from "@kauro/contracts";
import { AUDIT_POLICY } from "./policy.js";
import type { CostGrantRecord } from "./records.js";

type Money = Pick<CostGrantRecord, "ceilingCents" | "reservedCents" | "reconciledSpendCents">;

/** CostGrant.availableCents: the ceiling less what is reserved and what was spent (never negative for a stored grant). */
export function grantAvailableCents(grant: Money): bigint {
  return grant.ceilingCents - grant.reservedCents - grant.reconciledSpendCents;
}

/**
 * Whether a reservation of `cents` fits the grant at `at` (D8-GRANT-2): AUTHORIZED, strictly before its expiry, and within the room
 * under its ceiling. A non-positive reservation fits nothing (a dispatch without a bounded liability is not an intent).
 */
export function grantFunds(grant: Money & Pick<CostGrantRecord, "state" | "expiresAt">, cents: bigint, at: UtcInstant): boolean {
  return cents > 0n && grant.state === "AUTHORIZED" && Date.parse(at) < Date.parse(grant.expiresAt) && cents <= grantAvailableCents(grant);
}

/** Whether a pool can hold a free AUDIT grant of `ceilingCents` at `at` (D8-GRANT-1): the carve StartAudit makes under its row lock. */
export function poolFundsAudit(pool: Money & Pick<CostGrantRecord, "kind" | "state" | "expiresAt">, ceilingCents: bigint, at: UtcInstant): boolean {
  return pool.kind === "PLATFORM_MONTHLY" && ceilingCents <= BigInt(AUDIT_POLICY.freeAuditCeilingCents) && grantFunds(pool, ceilingCents, at);
}

/** The audit's absolute deadline: its logical start + auditAbsoluteSeconds (D8-AUD-1). */
export function auditAbsoluteDeadlineOf(startedAt: UtcInstant): string {
  return new Date(Date.parse(startedAt) + AUDIT_POLICY.auditAbsoluteSeconds * 1000).toISOString();
}

/** The interpretation deadline: the first INTERPRETING + interpretationSeconds, never past the absolute deadline (D8-AUD-1). */
export function interpretationDeadlineOf(interpretingAt: UtcInstant, absoluteDeadlineAt: UtcInstant): string {
  return new Date(Math.min(Date.parse(interpretingAt) + AUDIT_POLICY.interpretationSeconds * 1000, Date.parse(absoluteDeadlineAt))).toISOString();
}

/** Micro-dollars per cent (package B05 D5-11: the Intelligence Core admits and settles in micros, the grants hold cents). */
export const MICROS_PER_CENT = 10_000n;

/** ceil(micros / 10,000): the cents a maximum of `micros` reserves, or a charge of `micros` costs (D5-11). */
export function centsOfMicros(micros: bigint): bigint {
  if (micros < 0n) throw new RangeError("a charge in micros is non-negative");
  return (micros + MICROS_PER_CENT - 1n) / MICROS_PER_CENT;
}

/** COMMITTED posts min(ceil(charge / 10,000), reserved) cents; what lies above the admitted maximum is a liability, never spend (D5-11). */
export function postedCentsOf(chargeMicros: bigint, reservedCents: bigint): bigint {
  const c = centsOfMicros(chargeMicros);
  return c < reservedCents ? c : reservedCents;
}

/** The excess of a charge over the admitted maximum, in micros (0 when within): the rounding slack never absorbs it (D5-11). */
export function excessMicrosOf(chargeMicros: bigint, maxChargeMicros: bigint): bigint {
  const e = chargeMicros - maxChargeMicros;
  return e > 0n ? e : 0n;
}
