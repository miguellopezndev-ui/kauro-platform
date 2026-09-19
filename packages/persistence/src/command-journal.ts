/**
 * Command journal over `pg` (10 "Idempotency contract": identity = environment, authenticated subject or trusted system actor,
 * agency, operation and key; the stored request digest covers every material field; reuse with another digest is
 * IDEMPOTENCY_CONFLICT and performs no new effect; the first accepted request records its intent first; a concurrent
 * duplicate receives the same durable result; a response lost after commit is recovered by the same key).
 *
 * Reservation is one statement: INSERT ... ON CONFLICT ON THE IDENTITY INDEX DO NOTHING. PostgreSQL makes a second inserter of
 * the same identity wait for the first transaction to end: if it committed, the conflict is detected, nothing is inserted and
 * the committed row is read — REPLAY (same digest) or CONFLICT (another digest); if it rolled back, the insert proceeds and
 * the duplicate becomes the first request (decision D-IDEM-2: rejections leave no row). A row still RESERVED or UNCERTAIN
 * with the same digest is PENDING (a multi-transaction operation of a later package); a FAILED row is final and replays as
 * FAILED so the client sees the recorded outcome rather than repeating the effect.
 */
import type { CommandId, Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type Clock,
  type CommandJournal,
  type CommandJournalEntry,
  type IdGenerator,
  type IdempotencyIdentity,
  type JournalCommit,
  type JournalEntryId,
  type JournalState,
  type ReservationOutcome,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, withOptional, type Queryable } from "./sql.js";

interface JournalRow {
  entry_id: string;
  environment: IdempotencyIdentity["environment"];
  actor_kind: "USER" | "SERVICE";
  actor_id: string;
  agency_id: string | null;
  operation: string;
  idempotency_key: string;
  request_digest: string;
  state: JournalState;
  correlation_id: string;
  response_status: number | null;
  response_body: unknown;
  resource_kind: string | null;
  resource_id: string | null;
  reserved_at: Date;
  committed_at: Date | null;
}

const JOURNAL_COLUMNS = "entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, state, correlation_id, response_status, response_body, resource_kind, resource_id, reserved_at, committed_at";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function actorOfIdentity(identity: IdempotencyIdentity): { readonly kind: "USER" | "SERVICE"; readonly id: string } {
  switch (identity.actor.kind) {
    case "USER":
      return { kind: "USER", id: identity.actor.userId };
    case "SERVICE":
      return { kind: "SERVICE", id: identity.actor.serviceId };
    case "SYSTEM":
      throw new DomainFailure("INTEGRITY_FAILURE", "an idempotency identity needs an authenticated subject or a trusted service actor, not SYSTEM");
  }
}

function entryOf(r: JournalRow): CommandJournalEntry {
  const base = {
    entryId: r.entry_id as JournalEntryId,
    identity: {
      environment: r.environment,
      actor: r.actor_kind === "USER" ? ({ kind: "USER", userId: r.actor_id } as const) : ({ kind: "SERVICE", serviceId: r.actor_id } as const),
      agencyId: r.agency_id as AgencyId | null,
      operation: r.operation as CommandId,
      key: r.idempotency_key,
    } as IdempotencyIdentity,
    requestDigest: r.request_digest,
    state: r.state,
    correlationId: r.correlation_id,
    reservedAt: instant(r.reserved_at),
  };
  const a = withOptional(base, "responseStatus", r.response_status === null ? undefined : int(r.response_status));
  const b = withOptional(a, "responseBody", r.response_body === null ? undefined : r.response_body);
  const c = withOptional(b, "resourceKind", r.resource_kind ?? undefined);
  const d = withOptional(c, "resourceId", r.resource_id ?? undefined);
  return withOptional(d, "committedAt", optionalInstant(r.committed_at));
}

export class PgCommandJournal implements CommandJournal {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async reserve(identity: IdempotencyIdentity, requestDigest: Sha256Hex, correlationId: string): Promise<ReservationOutcome> {
    const actor = actorOfIdentity(identity);
    const entryId = this.ids.next() as JournalEntryId;
    const now = this.clock.now();
    const inserted = await execute<{ entry_id: string }>(
      this.db,
      `INSERT INTO kauro.command_journal (entry_id, environment, actor_kind, actor_id, agency_id, operation, idempotency_key, request_digest, state, correlation_id, reserved_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RESERVED', $9, $10, $10)
       ON CONFLICT (environment, actor_kind, actor_id, coalesce(agency_id, '${NIL_UUID}'::uuid), operation, idempotency_key) DO NOTHING
       RETURNING entry_id`,
      [entryId, identity.environment, actor.kind, actor.id, identity.agencyId, identity.operation, identity.key, requestDigest, correlationId, now],
    );
    if (inserted.rows[0]) return { kind: "RESERVED", entryId };
    const existing = await this.find(identity);
    if (!existing) throw new DomainFailure("INTEGRITY_FAILURE", "idempotency identity is reserved by a row this context cannot read");
    if (existing.requestDigest !== requestDigest) return { kind: "CONFLICT", entry: existing };
    if (existing.state === "RESERVED" || existing.state === "UNCERTAIN") return { kind: "PENDING", entry: existing };
    return { kind: "REPLAY", entry: existing };
  }

  async commit(entryId: JournalEntryId, result: JournalCommit): Promise<void> {
    if (!Number.isInteger(result.responseStatus) || result.responseStatus < 200 || result.responseStatus > 299) throw new DomainFailure("INTEGRITY_FAILURE", "a committed command records a 2xx status");
    if (result.responseBody === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a committed command records its response body");
    const r = await execute(
      this.db,
      `UPDATE kauro.command_journal SET state = 'COMMITTED', response_status = $2, response_body = $3::jsonb, resource_kind = $4, resource_id = $5, committed_at = $6
       WHERE entry_id = $1 AND state = 'RESERVED'`,
      [entryId, result.responseStatus, JSON.stringify(result.responseBody), result.resourceKind, result.resourceId, this.clock.now()],
    );
    if (r.rowCount !== 1) throw new DomainFailure("INTEGRITY_FAILURE", "journal commit found no RESERVED entry to complete");
  }

  async markUncertain(entryId: JournalEntryId): Promise<void> {
    const r = await execute(this.db, "UPDATE kauro.command_journal SET state = 'UNCERTAIN' WHERE entry_id = $1 AND state = 'RESERVED'", [entryId]);
    if (r.rowCount !== 1) throw new DomainFailure("INTEGRITY_FAILURE", "journal markUncertain found no RESERVED entry");
  }

  async find(identity: IdempotencyIdentity): Promise<CommandJournalEntry | null> {
    const actor = actorOfIdentity(identity);
    const r = await execute<JournalRow>(
      this.db,
      `SELECT ${JOURNAL_COLUMNS} FROM kauro.command_journal
       WHERE environment = $1 AND actor_kind = $2 AND actor_id = $3 AND coalesce(agency_id, '${NIL_UUID}'::uuid) = coalesce($4::uuid, '${NIL_UUID}'::uuid) AND operation = $5 AND idempotency_key = $6`,
      [identity.environment, actor.kind, actor.id, identity.agencyId, identity.operation, identity.key],
    );
    return r.rows[0] ? entryOf(r.rows[0]) : null;
  }
}
