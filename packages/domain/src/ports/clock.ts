/**
 * Clock port. Every instant a command persists comes from here, never from `new Date()` inside domain or application code, so
 * deterministic interleaving tests can fix time (21 "Concurrency and crash matrix") and the database never decides business
 * time on its own (07: embedded time does not establish business ordering; the clock only stamps).
 */
import type { UtcInstant } from "@kauro/contracts";

export interface Clock {
  /** Current UTC instant as YYYY-MM-DDTHH:mm:ss.sssZ (10 "Schema format execution": at most three fractional digits). */
  now(): UtcInstant;
  /** Milliseconds since the Unix epoch, for UUIDv7 minting and duration arithmetic. */
  nowMs(): number;
}

const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Formats an epoch millisecond value as the canonical UTC instant. */
export function toUtcInstant(epochMs: number): UtcInstant {
  if (!Number.isInteger(epochMs) || epochMs < 0) throw new RangeError("epochMs must be a non-negative integer");
  return new Date(epochMs).toISOString();
}

export function isUtcInstant(v: unknown): v is UtcInstant {
  if (typeof v !== "string" || !UTC_MS.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === v;
}
