/**
 * Field vocabulary the aggregates enforce on their own inputs (reference/FIELD_CONTRACTS.md "Common rules": application ids
 * are opaque server identities; labels are untrusted presentation; UTC instants include Z; unknown fields reject). The
 * database repeats the same checks (migration 0001: kauro.is_label, kauro.is_token, kauro.is_uuid_v7) — application checks
 * improve messages but cannot be the sole protection (07 "Transaction discipline").
 *
 * A refusal names the field and a structural code, never the value (10 "Responses and safe errors").
 */
import type { UtcInstant } from "@kauro/contracts";
import { InvalidRequestFailure } from "./errors.js";
import { isUuid, isUuidV5, isUuidV7 } from "./ids.js";
import { isUtcInstant } from "../ports/clock.js";

/** A safe label: 1..200 characters, no control characters (kauro.is_label). It is presentation, never identity. */
export function isLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 200) return false;
  for (const ch of value) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}

/** A machine reason code: uppercase token of 3..64 characters (design §7 reasonCode; kauro.is_token). */
const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
export function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE.test(value);
}

export function assertLabel(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isLabel(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

export function assertReasonCode(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isReasonCode(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

/** A server-minted aggregate id (UUIDv7); anything else cannot become an aggregate identity (07). */
export function assertAggregateId(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isUuidV7(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

/** A person identity reference (UUIDv5, D-ID-2). */
export function assertIdentityId(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isUuidV5(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

/** An opaque external reference the platform did not mint (any lowercase RFC 9562 UUID). */
export function assertExternalRef(field: string, value: unknown): string {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isUuid(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

export function assertInstant(field: string, value: unknown): UtcInstant {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isUtcInstant(value)) throw new InvalidRequestFailure([{ field, code: "FORMAT" }]);
  return value;
}

/** Epoch milliseconds of a canonical instant (both operands of every time comparison in the aggregates go through here). */
export function instantMs(value: UtcInstant): number {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new TypeError("not a UTC instant");
  return t;
}

export function isBefore(a: UtcInstant, b: UtcInstant): boolean {
  return instantMs(a) < instantMs(b);
}
