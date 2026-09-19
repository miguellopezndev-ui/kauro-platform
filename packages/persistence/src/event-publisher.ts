/**
 * Event publisher over `pg` (07 "Transaction discipline": a successful command commits state, domain event and outbox record
 * atomically; 07 "Outbox, inbox and event ordering": the event carries references and safe counts, never CRM rows or
 * secrets; dispatch is at least once and consumers deduplicate). The publisher writes inside the caller's unit of work: the
 * allowlist is asserted in code (decision D-EVT-2), the id and time are minted by the ports, the payload digest is the
 * canonical SHA-256, and the outbox rows come from the code-owned subscription table. Ordering: `sequence` (identity column)
 * is the global append order and (aggregate_kind, aggregate_id, aggregate_version) is unique — a second event for the same
 * aggregate version is INTEGRITY_FAILURE, which is how the event-per-version rule stays one-to-one.
 */
import {
  DomainFailure,
  EVENT_SCHEMA_VERSION,
  assertAllowlistedPayload,
  consumersOf,
  payloadDigest,
  type ActorRef,
  type AggregateKind,
  type Clock,
  type DomainEventRecord,
  type EventId,
  type EventPayload,
  type EventPublisher,
  type EventType,
  type IdGenerator,
  type NewDomainEvent,
  type OutboxId,
  type PublishedEvent,
  type UserId,
} from "@kauro/domain";
import { actorColumns } from "./repositories/tenancy.js";
import { ConstraintViolation, execute, instant, int, withOptional, type Queryable } from "./sql.js";

interface EventRow {
  event_id: string;
  sequence: string;
  aggregate_kind: AggregateKind;
  aggregate_id: string;
  aggregate_version: string;
  agency_id: string | null;
  event_type: EventType;
  actor_kind: "USER" | "SERVICE" | "SYSTEM";
  actor_id: string | null;
  causation_id: string;
  correlation_id: string;
  payload: unknown;
  payload_hash: string;
  schema_version: string;
  created_at: Date;
}

export const EVENT_COLUMNS = "event_id, sequence, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at";

export function eventRecord(r: EventRow): DomainEventRecord {
  if (typeof r.payload !== "object" || r.payload === null || Array.isArray(r.payload)) throw new DomainFailure("INTEGRITY_FAILURE", "stored event payload is not an object");
  if ((r.actor_kind === "USER" || r.actor_kind === "SERVICE") && r.actor_id === null) throw new DomainFailure("INTEGRITY_FAILURE", "stored event actor has no id");
  const actor: ActorRef = r.actor_kind === "USER" ? { kind: "USER", userId: r.actor_id as UserId } : r.actor_kind === "SERVICE" ? { kind: "SERVICE", serviceId: r.actor_id as string } : { kind: "SYSTEM" };
  const base = {
    eventId: r.event_id as EventId,
    sequence: int(r.sequence),
    aggregateKind: r.aggregate_kind,
    aggregateId: r.aggregate_id,
    aggregateVersion: int(r.aggregate_version),
    eventType: r.event_type,
    actor,
    causationId: r.causation_id,
    correlationId: r.correlation_id,
    payload: r.payload as EventPayload,
    payloadArtifactHash: r.payload_hash,
    schemaVersion: r.schema_version,
    createdAt: instant(r.created_at),
  };
  return withOptional(base, "agencyId", r.agency_id ?? undefined);
}

export class PgEventPublisher implements EventPublisher {
  readonly #appended: DomainEventRecord[] = [];

  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  get appended(): ReadonlyArray<DomainEventRecord> {
    return this.#appended;
  }

  async publish(event: NewDomainEvent): Promise<PublishedEvent> {
    try {
      assertAllowlistedPayload(event.eventType, event.payload);
    } catch (e) {
      // a label, free text or nested object in a payload is a programming error, not a request error: the event is refused
      // before any row is written and the unit of work rolls back (07 "never CRM rows or secrets")
      throw new DomainFailure("INTEGRITY_FAILURE", e instanceof Error ? e.message : "event payload is not allowlisted");
    }
    if (!Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1) throw new DomainFailure("INTEGRITY_FAILURE", "aggregate version must be a positive integer");
    const eventId = this.ids.next() as EventId;
    const createdAt = this.clock.now();
    const actor = actorColumns(event.actor);
    const payloadHash = payloadDigest(event.payload);
    let inserted: EventRow | undefined;
    try {
      const r = await execute<EventRow>(
        this.db,
        `INSERT INTO kauro.domain_events (event_id, aggregate_kind, aggregate_id, aggregate_version, agency_id, event_type, actor_kind, actor_id, causation_id, correlation_id, payload, payload_hash, schema_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14) RETURNING ${EVENT_COLUMNS}`,
        [eventId, event.aggregateKind, event.aggregateId, event.aggregateVersion, event.agencyId, event.eventType, actor.kind, actor.id, event.causationId, event.correlationId, JSON.stringify(event.payload), payloadHash, EVENT_SCHEMA_VERSION, createdAt],
      );
      inserted = r.rows[0];
    } catch (e) {
      if (e instanceof ConstraintViolation && e.constraint === "domain_events_aggregate_kind_aggregate_id_aggregate_version_key") {
        throw new DomainFailure("INTEGRITY_FAILURE", `${event.aggregateKind} ${event.aggregateId} already has an event for version ${event.aggregateVersion}`, { reason: "VERSION_DISCIPLINE" });
      }
      throw e;
    }
    if (!inserted) throw new DomainFailure("INTEGRITY_FAILURE", "event insert returned no row");
    const record = eventRecord(inserted);
    const outbox: Array<{ readonly outboxId: OutboxId; readonly consumer: string }> = [];
    for (const consumer of consumersOf(event.eventType)) {
      const outboxId = this.ids.next() as OutboxId;
      await execute(
        this.db,
        `INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'PENDING', 0, $4, $4, $4)`,
        [outboxId, eventId, consumer, createdAt],
      );
      outbox.push({ outboxId, consumer });
    }
    this.#appended.push(record);
    return { event: record, outbox };
  }

  async get(eventId: EventId): Promise<DomainEventRecord | null> {
    const r = await execute<EventRow>(this.db, `SELECT ${EVENT_COLUMNS} FROM kauro.domain_events WHERE event_id = $1`, [eventId]);
    return r.rows[0] ? eventRecord(r.rows[0]) : null;
  }
}
