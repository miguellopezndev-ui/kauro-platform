/**
 * Event publisher port (07 "Outbox, inbox and event ordering"): appends a domain event and its outbox records inside the
 * current unit of work. Publishing is not delivery — the outbox dispatcher (control plane) claims the records through the
 * OutboxDispatchStore port and delivers at least once; consumers deduplicate by their own inbox identity (inbox-outbox.ts).
 */
import type { DomainEventRecord, NewDomainEvent } from "../model/events.js";
import type { EventId, OutboxId } from "../model/ids.js";

export interface PublishedEvent {
  readonly event: DomainEventRecord;
  /** One outbox record per registered consumer of the event type (EVENT_SUBSCRIPTIONS); empty when none is registered. */
  readonly outbox: ReadonlyArray<{ readonly outboxId: OutboxId; readonly consumer: string }>;
}

export interface EventPublisher {
  /**
   * Validates the payload against the allowlist of the event type (assertAllowlistedPayload), mints eventId and createdAt,
   * computes payloadArtifactHash, inserts the domain_events row and the outbox rows. Throws INTEGRITY_FAILURE when the
   * (aggregateKind, aggregateId, aggregateVersion) sequence number already exists.
   */
  publish(event: NewDomainEvent): Promise<PublishedEvent>;
  /** Events already appended in this unit of work, in append order (for the journal response and for tests). */
  readonly appended: ReadonlyArray<DomainEventRecord>;
  /** Reads one event of the current tenant (null when not visible). */
  get(eventId: EventId): Promise<DomainEventRecord | null>;
}
