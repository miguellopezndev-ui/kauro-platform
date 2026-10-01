/**
 * Row plumbing of B10's sales and attribution adapters (mandate B10-ADAPTERS-SALES; docs/design/B10-commercial-domain.md §5, §9,
 * §10; decision D10-CLOCK-1).
 *
 * Instants. Every instant these adapters record is the database's (`kauro.server_now()`, written in SQL): the guards of migration
 * 0029 compare a submission, a signing, an assignment, a freeze, a ruling, a lapse, a conversion or a termination with the server
 * clock exactly, to the microsecond, so no instant is ever carried through JavaScript into a write. What a record carries back is
 * the domain's canonical instant (UTC, milliseconds, `YYYY-MM-DDTHH:mm:ss.sssZ`), formatted by the database, which the domain's time
 * rules read (commercial/time.ts). A comparison that must be exact — an entitlement's window against the agency's first designation
 * — is made in SQL against the stored instant, never against a canonical instant fed back.
 */
import type { UtcInstant } from "@kauro/contracts";
import { DomainFailure, isUtcInstant } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** SQL expression: a timestamptz column as the domain's canonical instant (UTC, milliseconds), aliased to the column's name. */
export function canonical(column: string, alias: string = column.includes(".") ? (column.split(".").pop() as string) : column): string {
  return `to_char(${column} AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS ${alias}`;
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

/** The current safe version and state of a row a compare-and-swap missed (B06 D-VER-1); NOT_FOUND when it is not visible here. */
export async function staleRow(db: Queryable, sql: string, id: string, what: string): Promise<{ readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string }> {
  const r = await execute<{ version: string; state: string }>(db, sql, [id]);
  const row = r.rows[0];
  if (row === undefined) throw new DomainFailure("NOT_FOUND", `${what} is not visible in this context`);
  return { kind: "STALE", currentVersion: int(row.version), currentState: row.state };
}

/**
 * The transition subjects of the sales and attribution records (design §10, D10-TX-1): a seller (keyed by seller), the claims of one
 * prospect (keyed by prospect) and an entitlement. Readers take the shared half, held to COMMIT (B06 D-TX-2).
 */
export type SalesTransitionSubject = "kauro.sellers" | "kauro.attribution_claims" | "kauro.commission_entitlements" | "kauro.identities" | "kauro.corporate_roles";

export async function awaitSalesTransition(db: Queryable, kind: SalesTransitionSubject, subject: string): Promise<void> {
  await execute(db, `SELECT kauro.await_transition('${kind}', $1)`, [subject]);
}

/**
 * The writer's half of a subject, taken by the unit of work that is about to change it (the triggers of 0029 take the same key at
 * the state change): a reader's shared half waits for it, and a later writer waits for it too, as pg_stat_activity shows.
 */
export async function holdSalesTransition(db: Queryable, kind: SalesTransitionSubject, subject: string): Promise<void> {
  await execute(db, `SELECT pg_advisory_xact_lock(kauro.transition_key('${kind}', $1))`, [subject]);
}
