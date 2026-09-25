/**
 * Inbox and outbox ports (07 "Outbox, inbox and event ordering": outbox dispatch is at least once; consumers deduplicate by
 * their own durable inbox identity and verify state before an effect; a webhook is authenticated before its content can establish
 * authority; inbox identity includes provider and environment; 15 "Webhooks and reconciliation": ingress stores a minimized
 * immutable event reference and deduplicates by provider, environment and event ID). Review re-check findings N2 and N20.
 *
 * Three boundaries, three runtime groups (08 "Every boundary has a schema, identity, authorization predicate, replay behavior and
 * audit event"):
 *  - InboxIngress — the provider-webhook ingress (COMMAND_CATALOGUE CMD030, authorized role AUTHENTICATED_PROVIDER, package B09)
 *    records an authenticated delivery; it runs as kauro_ingress, never as the request handlers of agency users;
 *  - InboxConsumerStore — the consumer (control plane) claims recorded events and settles them;
 *  - OutboxDispatchStore — the dispatcher (control plane) claims due outbox records of one consumer, then records the delivery
 *    or the failure under the attempt it claimed (the attempt count is the fence: a stale claim settles nothing).
 * The dispatcher process that loops over these stores and the consumers that act on the events (NOTIFICATIONS, EXECUTION_CONTROL)
 * belong to their packages (the control service of B14, the job package B08, the notification route of B14/B15); B06 owns the
 * durable records and these primitives, tested against PostgreSQL.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { AggregateKind, EventPayload, EventType } from "../model/events.js";
import type { Environment } from "../model/idempotency.js";
import type { AgencyId, CorrelationId, EventId, InboxId, OutboxId } from "../model/ids.js";

/** One authenticated provider delivery, minimized to its reference (15: the raw body stays with the ingress). */
export interface InboxDelivery {
  /** A fresh id minted by the ingress (UUIDv7); kept only when the delivery is new. */
  readonly inboxId: InboxId;
  /** Provider label (e.g. paypal); part of the dedupe identity. */
  readonly provider: string;
  readonly environment: Environment;
  /** The provider's own event id; part of the dedupe identity. */
  readonly externalEventId: string;
  /** SHA-256 of the authenticated raw body. */
  readonly bodyHash: Sha256Hex;
  readonly receivedAt: UtcInstant;
}

/**
 * RECORDED: a new event reference. DUPLICATE: the same event with the same body was recorded before (a provider retry; nothing
 * changes). BODY_CONFLICT: the same event identity arrived with another body; the conflict is recorded beside the event and the
 * event cannot be applied until the consumer reconciles it — it is never silently absorbed.
 */
export type IngressOutcome =
  | { readonly kind: "RECORDED"; readonly inboxId: InboxId }
  | { readonly kind: "DUPLICATE"; readonly inboxId: InboxId }
  | { readonly kind: "BODY_CONFLICT"; readonly inboxId: InboxId };

export interface InboxIngress {
  record(delivery: InboxDelivery): Promise<IngressOutcome>;
}

export type InboxState = "RECEIVED" | "PROCESSING" | "APPLIED" | "IGNORED" | "RETRYABLE" | "REJECTED";

export interface ClaimedInboxRecord {
  readonly inboxId: InboxId;
  readonly provider: string;
  readonly environment: Environment;
  readonly externalEventId: string;
  readonly bodyHash: Sha256Hex;
  readonly receivedAt: UtcInstant;
  /** Deliveries of the same event carried other bodies: the record cannot be APPLIED before reconciliation. */
  readonly conflictingBodies: number;
}

export type InboxSettlement = "APPLIED" | "IGNORED" | "REJECTED" | "RETRYABLE";

export interface InboxConsumerStore {
  /**
   * Claims up to `limit` recorded events (RECEIVED or RETRYABLE, or PROCESSING whose claim is older than `staleClaimSeconds`)
   * and moves them to PROCESSING; concurrent consumers claim disjoint records (SKIP LOCKED).
   */
  claim(limit: number, staleClaimSeconds: number): Promise<ReadonlyArray<ClaimedInboxRecord>>;
  /**
   * Settles a PROCESSING record. APPLIED is refused while a conflicting body is recorded (PRECONDITION_FAILED /
   * INBOX_BODY_CONFLICT). Returns false when the record is no longer PROCESSING (another consumer settled it).
   */
  settle(inboxId: InboxId, outcome: InboxSettlement, now: UtcInstant, resultEventId?: EventId): Promise<boolean>;
}

/** A due outbox record and the event it carries (references and safe counts only, 07). */
export interface OutboxDelivery {
  readonly outboxId: OutboxId;
  readonly consumer: string;
  /** The attempt this claim is: the fence the settlement must present. */
  readonly attempt: number;
  readonly event: {
    readonly eventId: EventId;
    readonly eventType: EventType;
    readonly aggregateKind: AggregateKind;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly agencyId: AgencyId | null;
    readonly correlationId: CorrelationId;
    readonly payload: EventPayload;
  };
}

export type OutboxSettlement = "SETTLED" | "FENCED";

export interface OutboxDispatchStore {
  /**
   * Claims up to `limit` due records of `consumer` — PENDING or RETRYABLE whose next attempt is due, or CLAIMED whose claim
   * expired — in (next attempt, id) order: each becomes CLAIMED with attempts + 1 and a claim deadline `claimSeconds` ahead.
   * Concurrent dispatchers claim disjoint records (SKIP LOCKED). Delivery is at least once: an expired claim is claimed again.
   */
  claim(consumer: string, limit: number, now: UtcInstant, claimSeconds: number): Promise<ReadonlyArray<OutboxDelivery>>;
  /** DELIVERED (final) — only under the claim `attempt` still holds; FENCED when the record was claimed again since. */
  delivered(outboxId: OutboxId, attempt: number, now: UtcInstant): Promise<OutboxSettlement>;
  /** RETRYABLE at `retryAt`, or DEAD_LETTER when `retryAt` is null, recording a safe error token; FENCED as for delivered. */
  failed(outboxId: OutboxId, attempt: number, errorCode: string, retryAt: UtcInstant | null, now: UtcInstant): Promise<OutboxSettlement>;
}
