/**
 * Row plumbing of the source-lifecycle adapters (B07).
 *
 * Instants (decision D-CLOCK-1). Every lifecycle instant is the database's transaction time, written by the adapters as
 * kauro.server_now() in SQL, and the guards compare instants for exact equality (an anchor with its transition, a receipt's start
 * with its attempt's claim, a deletion with its read-back). The adapters therefore read every instant back exactly as stored — an
 * ISO-8601 UTC string with microseconds, formatted by the database (`exact`) — never through a JavaScript Date, which keeps
 * milliseconds only. A caller that feeds an instant back (a receipt's startedAt, a read-back's observedAt, a list cursor) passes
 * exactly what it read. A view that must carry the millisecond utc primitive of manual 10 truncates it itself
 * (`toUtcInstant(Date.parse(instant))`).
 *
 * The audience of a unit of work decides which columns a read names: the control plane holds no grant on customer text (display
 * names, worksheet names, header labels; D-CTRL-1), so its reads omit them and its records leave those optional members absent.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, type FailureReason } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

/** Who reads: the request handlers (kauro_app) or the control plane (kauro_control, never customer text). */
export type SourceAudience = "REQUEST" | "CONTROL";

const EXACT_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** SQL expression: a timestamptz column as its exact UTC ISO-8601 text (microseconds), aliased to the column name. */
export function exact(column: string, alias: string = column.includes(".") ? (column.split(".").pop() as string) : column): string {
  return `to_char(${column} AT TIME ZONE 'UTC', ${EXACT_FORMAT}) AS ${alias}`;
}

/** SQL expression of the server clock of this transaction, exactly (D-CLOCK-1). */
export const SERVER_NOW_EXACT = `to_char(kauro.server_now() AT TIME ZONE 'UTC', ${EXACT_FORMAT})`;

/** The database's transaction time as the B07 guards read it (kauro.server_now()), exact to the microsecond. */
export async function serverInstantOf(db: Queryable): Promise<string> {
  const r = await execute<{ now: string }>(db, `SELECT ${SERVER_NOW_EXACT} AS now`);
  const now = r.rows[0]?.now;
  if (typeof now !== "string") throw new DomainFailure("INTEGRITY_FAILURE", "the server clock answered nothing");
  return now;
}

export function instantText(v: unknown): UtcInstant {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v)) throw new TypeError("expected an exact instant column value");
  return v;
}

export function optionalInstantText(v: unknown): UtcInstant | undefined {
  return v === null || v === undefined ? undefined : instantText(v);
}

export function optionalInt(v: unknown): number | undefined {
  return v === null || v === undefined ? undefined : int(v);
}

export function optionalString<T extends string = string>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "string") throw new TypeError(`expected a text column value, got ${typeof v}`);
  return v as T;
}

export function str<T extends string = string>(v: unknown): T {
  if (typeof v !== "string") throw new TypeError(`expected a text column value, got ${typeof v}`);
  return v as T;
}

export function bool(v: unknown): boolean {
  if (typeof v !== "boolean") throw new TypeError(`expected a boolean column value, got ${typeof v}`);
  return v;
}

/** bytea arrives as a Buffer; records carry a plain Uint8Array. */
export function bytes(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new TypeError("expected a bytea column value");
  return new Uint8Array(v);
}

/** A jsonb column that holds an array (a closed document list). */
export function jsonArray<T>(v: unknown): ReadonlyArray<T> {
  if (!Array.isArray(v)) throw new DomainFailure("INTEGRITY_FAILURE", "a stored document list is not an array");
  return v as ReadonlyArray<T>;
}

/** A jsonb column that holds an object (a closed document). */
export function jsonObject<T>(v: unknown): T {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new DomainFailure("INTEGRITY_FAILURE", "a stored document is not an object");
  return v as T;
}

/** `{ key: value }` when the value is present, `{}` otherwise (records omit absent optional members: exactOptionalPropertyTypes). */
export function opt<K extends string, V>(key: K, value: V | null | undefined): { readonly [P in K]?: V } {
  return (value === null || value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
}

export function one<R>(rows: ReadonlyArray<R>, what: string): R {
  const row = rows[0];
  if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", `${what} returned no row`);
  return row;
}

/** A page size of a list read (07: bounded pages; the B06 policy api bound). */
export function pageLimit(limit: number, max = 100): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new DomainFailure("INVALID_REQUEST", `page limit must be 1..${max}`);
  return limit;
}

/** An edge the aggregate's current state does not offer (the caller named an edge its expectation cannot take). */
export function notAvailable(what: string, state: string, reason: FailureReason = "UNLISTED_TRANSITION"): DomainFailure {
  return new DomainFailure("PRECONDITION_FAILED", `${what} is ${state}; the edge is not available`, { reason, currentState: state });
}

/**
 * After a compare-and-swap that changed nothing: STALE with the current version and state when the version moved, or the given
 * refusal when the version is still the expected one (the row is there, but not in the state or fence the write required).
 */
export async function missedWrite(
  db: Queryable,
  table: string,
  idColumn: string,
  id: string,
  expectedVersion: number,
  what: string,
  refusal: (current: { readonly state: string; readonly row: Readonly<Record<string, unknown>> }) => DomainFailure,
  extraColumns: ReadonlyArray<string> = [],
): Promise<{ readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }> {
  const columns = ["version::text AS version", "state", ...extraColumns].join(", ");
  const r = await execute<Record<string, unknown>>(db, `SELECT ${columns} FROM kauro.${table} WHERE ${idColumn} = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new DomainFailure("NOT_FOUND", `${what} is not visible in this context`);
  const currentVersion = int(row["version"]);
  const currentState = str(row["state"]);
  if (currentVersion !== expectedVersion) return { kind: "STALE", currentVersion, currentState };
  throw refusal({ state: currentState, row });
}
