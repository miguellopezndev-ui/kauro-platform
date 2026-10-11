/**
 * Plumbing shared by the `pg` adapters of the commerce ports (package B09; docs/design/B09-payments-fiscal.md §5, §9, §14 M1).
 *
 * Every versioned commerce write is a compare-and-swap on the aggregate version that publishes, in the same unit of work and
 * through B06's EventPublisher, exactly the event `commerceVersionEventType` names for what the version records (D-EVT-B3;
 * B09-N1), with the payload of COMMERCE_EVENT_PAYLOAD_ALLOWLIST built from the stored row: the database refuses any other type
 * (kauro.require_commerce_event_type, KA003), and the publisher addresses the outbox records to exactly the type's registered
 * consumers (COMMERCE_EVENT_SUBSCRIPTIONS; the database refuses any other consumer, 42501). The write context carries the
 * publisher and the provenance (actor, causation, correlation) of the unit of work, so an adapter never invents an actor.
 *
 * Money columns are `bigint` minor units; the payloads carry them as non-negative JSON integers (kauro.is_money bounds every
 * amount by 2^53 - 1, D-MONEY-B1, so the conversion is exact).
 */
import type { Id, UtcInstant } from "@kauro/contracts";
import {
  COMMERCE_EVENT_PAYLOAD_ALLOWLIST,
  DomainFailure,
  commerceVersionEventType,
  type AgencyId,
  type Clock,
  type CommerceAggregateKind,
  type CommerceEventType,
  type CommerceVersionChange,
  type EventPayload,
  type EventProvenance,
  type EventPublisher,
  type IdGenerator,
  type PublishedEvent,
  type SafePayloadValue,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";

/** What a commerce adapter needs beside its connection: ids, the clock, the event sink and the provenance of the unit of work. */
export interface CommerceWriteContext {
  readonly db: Queryable;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** B06's PgEventPublisher of the unit of work (the event row and its outbox records to the type's subscribers). */
  readonly events: Pick<EventPublisher, "publish">;
  /** The actor, causation and correlation of the events this unit of work publishes. */
  provenance(): EventProvenance;
}

// --- row mapping ------------------------------------------------------------------------------------------------------------------

/** A money column (bigint arrives as a decimal string) as `bigint` minor units. */
export function cents(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new TypeError("expected a non-negative integer money column value");
}

export function optionalCents(v: unknown): bigint | undefined {
  return v === null || v === undefined ? undefined : cents(v);
}

/** A jsonb array of SHA-256 hex digests (qualification evidence). */
export function hashList(v: unknown): ReadonlyArray<string> {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new DomainFailure("INTEGRITY_FAILURE", "stored evidence list is not a list of digests");
  return v as string[];
}

/** Adds every defined member of `extra` (records omit absent optional members under exactOptionalPropertyTypes). */
export function defined<T extends object>(base: T, extra: Readonly<Record<string, unknown>>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) out[k] = v;
  return out as T;
}

// --- transition locks (B06 D-TX-2; D-TX-B1) -----------------------------------------------------------------------------------------

/** The transition subjects the commerce adapters read after their shared half (design §6.2). */
export type CommerceTransitionSubject =
  | "kauro.agencies"
  | "kauro.payment_routes"
  | "kauro.fiscal_issuers"
  | "kauro.fiscal_profiles"
  | "kauro.corporate_roles"
  | "kauro.quotes"
  | "kauro.capture_facts"
  | "kauro.commercial_authorizations";

/**
 * Takes the shared half of a subject's transition lock (migration 0001 kauro.await_transition), held to COMMIT: a transition
 * committed first is what the next statement reads, one issued later waits for this unit of work.
 */
export async function awaitCommerceTransition(db: Queryable, kind: CommerceTransitionSubject, subject: string): Promise<void> {
  await execute(db, `SELECT kauro.await_transition('${kind}', $1)`, [subject]);
}

// --- compare-and-swap ---------------------------------------------------------------------------------------------------------------

export type Stale = { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string };

/**
 * The current safe version and state of a row a compare-and-swap missed (10 "returns the current safe version"; B06 D-VER-1);
 * NOT_FOUND when the row is not visible in this context (a foreign and a nonexistent row look alike).
 */
export async function staleOf(db: Queryable, table: string, idColumn: string, stateColumn: string, id: string, what: string): Promise<Stale> {
  const r = await execute<{ version: string; state: string }>(db, `SELECT version, ${stateColumn} AS state FROM kauro.${table} WHERE ${idColumn} = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new DomainFailure("NOT_FOUND", `${what} is not visible in this context`);
  return { kind: "STALE", currentVersion: int(row.version), currentState: row.state };
}

// --- events -------------------------------------------------------------------------------------------------------------------------

type CandidateValue = string | number | bigint | boolean | null | undefined;

/**
 * The payload of `eventType` taken from a candidate map of what the writer knows: exactly the allowlisted keys that carry a value
 * (ids, hashes, tokens, booleans, amounts as JSON integers). A key outside the type's allowlist never enters the payload.
 */
export function payloadOf(eventType: CommerceEventType, candidate: Readonly<Record<string, CandidateValue>>): EventPayload {
  const out: Record<string, SafePayloadValue> = {};
  for (const key of COMMERCE_EVENT_PAYLOAD_ALLOWLIST[eventType]) {
    const v = candidate[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "bigint") {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < 0) throw new DomainFailure("INTEGRITY_FAILURE", `${eventType}: ${key} is not a representable amount`);
      out[key] = n;
    } else {
      out[key] = v;
    }
  }
  return out;
}

/** The event type of a version, or INTEGRITY_FAILURE for a change the database would refuse (KA003). */
export function versionEventType(kind: CommerceAggregateKind, change: CommerceVersionChange): CommerceEventType {
  try {
    return commerceVersionEventType(kind, change);
  } catch (e) {
    throw new DomainFailure("INTEGRITY_FAILURE", e instanceof Error ? e.message : `no admissible event for this ${kind} version`, { reason: "EVENT_MISSING" });
  }
}

/**
 * Publishes the event of one commerce aggregate version (D-EVT-B3): the type `commerceVersionEventType` names for the change,
 * the allowlisted payload of the candidate, the provenance of the unit of work.
 */
export async function publishVersion(
  ctx: CommerceWriteContext,
  kind: CommerceAggregateKind,
  aggregate: { readonly id: string; readonly agencyId: AgencyId; readonly version: number },
  change: CommerceVersionChange,
  candidate: Readonly<Record<string, CandidateValue>>,
): Promise<PublishedEvent> {
  const eventType = versionEventType(kind, change);
  const p = ctx.provenance();
  return ctx.events.publish({
    aggregateKind: kind,
    aggregateId: aggregate.id as Id,
    aggregateVersion: aggregate.version,
    agencyId: aggregate.agencyId,
    eventType,
    actor: p.actor,
    causationId: p.causationId,
    correlationId: p.correlationId,
    payload: payloadOf(eventType, candidate),
  });
}

/** An instant parameter: the caller's UtcInstant, or the clock of the unit of work when the port names none. */
export function nowOf(ctx: Pick<CommerceWriteContext, "clock">, at?: UtcInstant): UtcInstant {
  return at ?? ctx.clock.now();
}
