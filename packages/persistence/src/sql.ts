/**
 * Shared query plumbing of the adapters: one `execute` that turns a database refusal into the DomainFailure the taxonomy
 * names (10 "Responses and safe errors": the SQL text never leaves the server; the failure code and reason do), and the row
 * mapping helpers (bigint columns arrive as strings, timestamptz as Date; records carry numbers and UtcInstant strings, and an
 * absent optional member is omitted rather than null — exactOptionalPropertyTypes).
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, toUtcInstant } from "@kauro/domain";
import { DatabaseError, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { SQLSTATE, failureOfSqlState } from "./sqlstate.js";

/** A unique constraint refused a write and no taxonomy code fits without the handler's knowledge (design §4.2 sqlstate). */
export class ConstraintViolation extends DomainFailure {
  readonly constraint: string | undefined;
  readonly sqlState: string;
  constructor(sqlState: string, constraint: string | undefined) {
    super("INTEGRITY_FAILURE", `database constraint refused the write (${sqlState}${constraint ? " " + constraint : ""})`);
    this.name = "ConstraintViolation";
    this.constraint = constraint;
    this.sqlState = sqlState;
  }
}

/** Refusals raised by the lease functions (KA005/KA004) carry the message the adapter classifies; nothing leaves the server. */
export class LeaseRefusal extends DomainFailure {
  readonly sqlState: string;
  readonly serverMessage: string;
  constructor(sqlState: string, serverMessage: string) {
    super("PRECONDITION_FAILED", `lease operation refused (${sqlState})`, { reason: "LEASE_FENCED" });
    this.name = "LeaseRefusal";
    this.sqlState = sqlState;
    this.serverMessage = serverMessage;
  }
}

export function isDatabaseError(e: unknown): e is DatabaseError {
  return e instanceof DatabaseError || (typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string" && "severity" in e);
}

/**
 * Translates a database error into the failure the taxonomy names, or returns null when the error is not a database
 * refusal the adapters understand (the unit of work then reports INTERNAL_ERROR by correlation id).
 */
export function translateDatabaseError(e: unknown): DomainFailure | null {
  if (!isDatabaseError(e)) return null;
  const code = e.code;
  if (code === SQLSTATE.LEASE) return new LeaseRefusal(code, e.message);
  if (code === SQLSTATE.IMMUTABLE_COLUMN && e.message.includes("leases.")) return new LeaseRefusal(code, e.message);
  const mapped = failureOfSqlState(code, e.constraint);
  if (mapped) return mapped;
  if (code === SQLSTATE.UNIQUE_VIOLATION) return new ConstraintViolation(code, e.constraint);
  return null;
}

export type Queryable = Pick<PoolClient, "query">;

/** Runs one statement; a database refusal surfaces as the typed DomainFailure, anything else is rethrown untouched. */
export async function execute<R extends QueryResultRow = QueryResultRow>(client: Queryable, text: string, params: ReadonlyArray<unknown> = []): Promise<QueryResult<R>> {
  try {
    return await client.query<R>(text, params as unknown[]);
  } catch (e) {
    const translated = translateDatabaseError(e);
    if (translated) {
      translated.cause = e;
      throw translated;
    }
    throw e;
  }
}

// --- row mapping -------------------------------------------------------------------------------------------------------

export function int(v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new TypeError(`expected a safe integer, got ${v}`);
    return v;
  }
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new TypeError(`integer column value ${v} exceeds the safe range`);
    return n;
  }
  throw new TypeError(`expected an integer column value, got ${typeof v}`);
}

export function instant(v: unknown): UtcInstant {
  if (v instanceof Date) return toUtcInstant(v.getTime());
  if (typeof v === "string") return toUtcInstant(Date.parse(v));
  throw new TypeError(`expected a timestamptz column value, got ${typeof v}`);
}

export function optionalInstant(v: unknown): UtcInstant | undefined {
  return v === null || v === undefined ? undefined : instant(v);
}

export function text(v: unknown): string {
  if (typeof v !== "string") throw new TypeError(`expected a text column value, got ${typeof v}`);
  return v;
}

export function optionalText(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : text(v);
}

/** Money minor units travel as decimal strings (contract MoneyMinorUnits); bigint columns already arrive that way. */
export function money(v: unknown): string {
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  throw new TypeError("expected a non-negative integer money value");
}

/** Adds `key: value` only when the value is defined (records omit absent optional members). */
export function withOptional<T extends object, K extends string, V>(base: T, key: K, value: V | undefined): T & Partial<Record<K, V>> {
  return value === undefined ? base : { ...base, [key]: value };
}
