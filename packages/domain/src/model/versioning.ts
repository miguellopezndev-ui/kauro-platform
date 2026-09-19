/**
 * Optimistic concurrency (07 "Database representation": aggregate versions establish concurrency order; 10 "Concurrency and
 * preconditions": edits require expectedVersion, a stale edit returns the current safe version and a code directing the UI to
 * reload or compare, it does not overwrite a collaborator's changes; decision D-VER-1: an update bumps the version by exactly
 * one — the database trigger enforce_version_bump refuses anything else).
 *
 * Every aggregate operation that edits a record calls `assertExpectedVersion` first and yields the record at
 * `nextVersion(record)`; the persistence adapter compare-and-swaps on the same expected version, so a race that passed the
 * pure check still ends as STALE_VERSION at the database (S051).
 */
import { type FailureDetails, InvalidRequestFailure, StaleVersionFailure } from "./errors.js";

export interface Versioned {
  readonly version: number;
  readonly state: string;
}

export function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The body member `expectedVersion` must be a positive integer (registry field type `version`). */
export function assertVersionField(field: string, value: unknown): number {
  if (typeof value !== "number") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isVersion(value)) throw new InvalidRequestFailure([{ field, code: "RANGE" }]);
  return value;
}

/**
 * Compares the caller's expectation with the current record. A miss is STALE_VERSION carrying the current safe version and
 * state, plus the successor id when the record was superseded (a stale UI holding an old plan revision learns where the
 * current content lives, CMD023 failure clause).
 */
export function assertExpectedVersion<T extends Versioned>(record: T, expectedVersion: number, extra: Omit<FailureDetails, "currentVersion" | "currentState"> = {}): T {
  if (!isVersion(expectedVersion)) throw new InvalidRequestFailure([{ field: "expectedVersion", code: "RANGE" }]);
  if (record.version !== expectedVersion) throw new StaleVersionFailure(record.version, record.state, extra);
  return record;
}

export function nextVersion(record: Versioned): number {
  if (!isVersion(record.version)) throw new RangeError("record version must be a positive integer");
  return record.version + 1;
}
