/**
 * Row plumbing of B10's commission ledger and statement adapters (mandate B10-ADAPTERS-LEDGER; docs/design/B10-commercial-domain.md
 * §6, §7; decision D10-CLOCK-1).
 *
 * Instants. Every instant these adapters record is the database's (`kauro.server_now()`, written in SQL): the guards of migrations
 * 0030 and 0031 compare a recording, an adjustment, a hold, a close, an approval or a payout with the server clock exactly, to the
 * microsecond, so no instant is carried through JavaScript into a write — except the instants a source states about itself (a
 * completion's, an observation's, a hold's review date, a statement's reported dates), which are canonical and bound as given. What a
 * record carries back is the domain's canonical instant (UTC, milliseconds, `YYYY-MM-DDTHH:mm:ss.sssZ`), formatted by the database.
 * Dates (`YYYY-MM-DD`) are formatted by the database too, never parsed through a JavaScript time zone.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, isUtcInstant } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** SQL expression: a timestamptz column as the domain's canonical instant (UTC, milliseconds), aliased to the column's name. */
export function canonical(column: string, alias: string = column.includes(".") ? (column.split(".").pop() as string) : column): string {
  return `to_char(${column} AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS ${alias}`;
}

/** SQL expression: a date column as `YYYY-MM-DD`, aliased to the column's name. */
export function calendarDate(column: string, alias: string = column.includes(".") ? (column.split(".").pop() as string) : column): string {
  return `to_char(${column}, 'YYYY-MM-DD') AS ${alias}`;
}

export function instantOf(v: unknown): UtcInstant {
  if (typeof v !== "string" || !isUtcInstant(v)) throw new TypeError("expected a canonical instant column value");
  return v;
}

export function optionalInstantOf(v: unknown): UtcInstant | undefined {
  return v === null || v === undefined ? undefined : instantOf(v);
}

export function optionalString<T extends string>(v: unknown): T | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "string") throw new TypeError("expected a text column value");
  return v as T;
}

/** A nullable money column as bigint cents, zero for NULL (an unpaid line's paid cents). */
export function centsOrZero(v: unknown): bigint {
  return v === null || v === undefined ? 0n : money(v);
}

export function money(v: unknown): bigint {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError("expected an integer money column value");
}

export function optionalMoney(v: unknown): bigint | undefined {
  return v === null || v === undefined ? undefined : money(v);
}

/** Adds every defined member of `extra` (records omit absent optional members under exactOptionalPropertyTypes). */
export function defined<T extends object>(base: T, extra: Readonly<Record<string, unknown>>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) out[k] = v;
  return out as T;
}

/** The current safe version and state of a row a compare-and-swap missed (B06 D-VER-1); NOT_FOUND when it is not visible here. */
export async function staleRow(db: Queryable, sql: string, id: string, what: string): Promise<{ readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }> {
  const r = await execute<{ version: string; state: string }>(db, sql, [id]);
  const row = r.rows[0];
  if (row === undefined) throw new DomainFailure("NOT_FOUND", `${what} is not visible in this context`);
  return { kind: "STALE", currentVersion: int(row.version), currentState: row.state };
}
