/**
 * The inbox and outbox adapters over `pg` (07 "Outbox, inbox and event ordering"; 15 "Webhooks and reconciliation"; review
 * re-check findings N2 and N20; ports in @kauro/domain ports/inbox-outbox.ts).
 *
 * - PgInboxIngress runs on a pool of the provider-webhook ingress group (kauro_ingress), in a short transaction of its own, like
 *   the evidence recorders: the request handlers of agency users hold no privilege on the inbox (migration 0005), so no tenant
 *   code path can pre-insert an event id and suppress the genuine delivery. A delivery whose identity is already recorded is a
 *   DUPLICATE when its body hash is the recorded one and a BODY_CONFLICT otherwise: the conflict is recorded (append-only) and
 *   the event cannot be applied until reconciled — a different body is never absorbed as a duplicate.
 * - PgInboxConsumerStore and PgOutboxDispatchStore run inside a control-plane unit of work (SYSTEM context, kauro_control):
 *   claims use FOR UPDATE SKIP LOCKED so concurrent workers take disjoint records; an outbox settlement names the attempt it
 *   claimed, so a claim that expired and was taken again by another dispatcher settles nothing (FENCED).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type AggregateKind,
  type ClaimedInboxRecord,
  type CorrelationId,
  type Environment,
  type EventId,
  type EventPayload,
  type EventType,
  type InboxConsumerStore,
  type InboxDelivery,
  type InboxId,
  type InboxIngress,
  type InboxSettlement,
  type IngressOutcome,
  type OutboxDelivery,
  type OutboxDispatchStore,
  type OutboxId,
  type OutboxSettlement,
} from "@kauro/domain";
import type { PoolClient } from "pg";
import type { KauroPool } from "./pool.js";
import { execute, instant, int, type Queryable } from "./sql.js";

// --- ingress (kauro_ingress) -----------------------------------------------------------------------------------------------

export class PgInboxIngress implements InboxIngress {
  constructor(
    private readonly pool: KauroPool,
    private readonly mintConflictId: () => string,
  ) {}

  async record(delivery: InboxDelivery): Promise<IngressOutcome> {
    const { client, connection } = await this.pool.acquire();
    if (connection.role !== "kauro_ingress") {
      client.release();
      throw new DomainFailure("INTEGRITY_FAILURE", `provider events are recorded only by kauro_ingress; this pool is ${connection.role} (08 Database isolation)`);
    }
    let destroy: Error | undefined;
    try {
      await execute(client, "BEGIN");
      const outcome = await this.#recordIn(client, delivery);
      const commit = await execute(client, "COMMIT");
      if (commit.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the ingress transaction was aborted by an earlier refusal and did not commit");
      return outcome;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw e;
    } finally {
      client.release(destroy);
    }
  }

  async #recordIn(client: PoolClient, d: InboxDelivery): Promise<IngressOutcome> {
    // a concurrent delivery of the same identity waits on the unique index until the first commits, then finds its row
    const inserted = await execute<{ inbox_id: string }>(
      client,
      `INSERT INTO kauro.inbox_records (inbox_id, provider, environment, external_event_id, body_hash, state, received_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'RECEIVED', $6, $6)
       ON CONFLICT (provider, environment, external_event_id) DO NOTHING RETURNING inbox_id`,
      [d.inboxId, d.provider, d.environment, d.externalEventId, d.bodyHash, d.receivedAt],
    );
    const fresh = inserted.rows[0];
    if (fresh) return { kind: "RECORDED", inboxId: fresh.inbox_id as InboxId };
    const existing = await execute<{ inbox_id: string; body_hash: string }>(
      client,
      "SELECT inbox_id, body_hash FROM kauro.inbox_records WHERE provider = $1 AND environment = $2 AND external_event_id = $3",
      [d.provider, d.environment, d.externalEventId],
    );
    const row = existing.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "the inbox identity conflicted but its record is not visible to the ingress");
    if (row.body_hash === d.bodyHash) return { kind: "DUPLICATE", inboxId: row.inbox_id as InboxId };
    await execute(
      client,
      `INSERT INTO kauro.inbox_body_conflicts (conflict_id, inbox_id, body_hash, received_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (inbox_id, body_hash) DO NOTHING`,
      [this.mintConflictId(), row.inbox_id, d.bodyHash, d.receivedAt],
    );
    return { kind: "BODY_CONFLICT", inboxId: row.inbox_id as InboxId };
  }
}

// --- inbox consumer (kauro_control) -------------------------------------------------------------------------------------

interface InboxRow {
  inbox_id: string;
  provider: string;
  environment: Environment;
  external_event_id: string;
  body_hash: string;
  received_at: Date;
  conflicts: string;
}

export class PgInboxConsumerStore implements InboxConsumerStore {
  constructor(private readonly db: Queryable) {}

  async claim(limit: number, staleClaimSeconds: number): Promise<ReadonlyArray<ClaimedInboxRecord>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainFailure("INVALID_REQUEST", "claim limit must be 1..100");
    if (!Number.isInteger(staleClaimSeconds) || staleClaimSeconds < 0 || staleClaimSeconds > 86_400) throw new DomainFailure("INVALID_REQUEST", "a stale claim age is 0..86400 seconds");
    const r = await execute<InboxRow>(
      this.db,
      `WITH due AS (
         SELECT inbox_id FROM kauro.inbox_records
          WHERE state IN ('RECEIVED', 'RETRYABLE') OR (state = 'PROCESSING' AND updated_at <= now() - make_interval(secs => $2))
          ORDER BY received_at, inbox_id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE kauro.inbox_records r SET state = 'PROCESSING' FROM due WHERE r.inbox_id = due.inbox_id
       RETURNING r.inbox_id, r.provider, r.environment, r.external_event_id, r.body_hash, r.received_at,
                 (SELECT count(*) FROM kauro.inbox_body_conflicts c WHERE c.inbox_id = r.inbox_id)::text AS conflicts`,
      [limit, staleClaimSeconds],
    );
    return r.rows
      .map((x) => ({
        inboxId: x.inbox_id as InboxId,
        provider: x.provider,
        environment: x.environment,
        externalEventId: x.external_event_id,
        bodyHash: x.body_hash as Sha256Hex,
        receivedAt: instant(x.received_at),
        conflictingBodies: int(x.conflicts),
      }))
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.inboxId < b.inboxId ? -1 : 1));
  }

  async settle(inboxId: InboxId, outcome: InboxSettlement, now: UtcInstant, resultEventId?: EventId): Promise<boolean> {
    const r = await execute(
      this.db,
      `UPDATE kauro.inbox_records SET state = $2, applied_at = CASE WHEN $2 = 'APPLIED' THEN $3::timestamptz END, result_event_id = $4
        WHERE inbox_id = $1 AND state = 'PROCESSING'`,
      [inboxId, outcome, now, resultEventId ?? null],
    );
    return r.rowCount === 1;
  }
}

// --- outbox dispatch (kauro_control) --------------------------------------------------------------------------------------

interface ClaimRow {
  outbox_id: string;
  consumer: string;
  attempts: number;
  event_id: string;
  event_type: EventType;
  aggregate_kind: AggregateKind;
  aggregate_id: string;
  aggregate_version: string;
  agency_id: string | null;
  correlation_id: string;
  payload: unknown;
}

export class PgOutboxDispatchStore implements OutboxDispatchStore {
  constructor(private readonly db: Queryable) {}

  async claim(consumer: string, limit: number, now: UtcInstant, claimSeconds: number): Promise<ReadonlyArray<OutboxDelivery>> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainFailure("INVALID_REQUEST", "claim limit must be 1..100");
    if (!Number.isInteger(claimSeconds) || claimSeconds < 1 || claimSeconds > 3600) throw new DomainFailure("INVALID_REQUEST", "a claim lasts 1..3600 seconds");
    const r = await execute<ClaimRow>(
      this.db,
      `WITH due AS (
         SELECT outbox_id FROM kauro.outbox_records
          WHERE consumer = $1 AND state IN ('PENDING', 'RETRYABLE', 'CLAIMED') AND next_attempt_at <= $3
          ORDER BY next_attempt_at, outbox_id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE kauro.outbox_records o
            SET state = 'CLAIMED', attempts = o.attempts + 1, next_attempt_at = $3::timestamptz + make_interval(secs => $4)
           FROM due WHERE o.outbox_id = due.outbox_id
         RETURNING o.outbox_id, o.consumer, o.attempts, o.event_id, o.next_attempt_at
       )
       SELECT c.outbox_id, c.consumer, c.attempts, e.event_id, e.event_type, e.aggregate_kind, e.aggregate_id, e.aggregate_version,
              e.agency_id, e.correlation_id, e.payload
         FROM claimed c JOIN kauro.domain_events e ON e.event_id = c.event_id
        ORDER BY e.sequence`,
      [consumer, limit, now, claimSeconds],
    );
    return r.rows.map((x) => {
      if (typeof x.payload !== "object" || x.payload === null || Array.isArray(x.payload)) throw new DomainFailure("INTEGRITY_FAILURE", "stored event payload is not an object");
      return {
        outboxId: x.outbox_id as OutboxId,
        consumer: x.consumer,
        attempt: x.attempts,
        event: {
          eventId: x.event_id as EventId,
          eventType: x.event_type,
          aggregateKind: x.aggregate_kind,
          aggregateId: x.aggregate_id,
          aggregateVersion: int(x.aggregate_version),
          agencyId: x.agency_id as AgencyId | null,
          correlationId: x.correlation_id as CorrelationId,
          payload: x.payload as EventPayload,
        },
      };
    });
  }

  async delivered(outboxId: OutboxId, attempt: number, now: UtcInstant): Promise<OutboxSettlement> {
    const r = await execute(
      this.db,
      "UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = $3, last_error_code = NULL WHERE outbox_id = $1 AND state = 'CLAIMED' AND attempts = $2",
      [outboxId, attempt, now],
    );
    return r.rowCount === 1 ? "SETTLED" : "FENCED";
  }

  async failed(outboxId: OutboxId, attempt: number, errorCode: string, retryAt: UtcInstant | null, _now: UtcInstant): Promise<OutboxSettlement> {
    const r = await execute(
      this.db,
      `UPDATE kauro.outbox_records
          SET state = CASE WHEN $4::timestamptz IS NULL THEN 'DEAD_LETTER' ELSE 'RETRYABLE' END,
              next_attempt_at = coalesce($4::timestamptz, next_attempt_at), last_error_code = $3
        WHERE outbox_id = $1 AND state = 'CLAIMED' AND attempts = $2`,
      [outboxId, attempt, errorCode, retryAt],
    );
    return r.rowCount === 1 ? "SETTLED" : "FENCED";
  }
}
