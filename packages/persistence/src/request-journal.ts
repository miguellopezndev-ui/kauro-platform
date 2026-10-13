/**
 * Request journal over `pg` (registry contract RequestJournal, owner manual 06; 10 "Provider adapter contract": prepared
 * intent is durable before a potentially billable dispatch; 21 "Concurrency and crash matrix": unknown external effects
 * remain uncertain and reserved, never free retries; decision D-IDEM-3: one committed command may produce several journaled
 * dispatch attempts, each under its own fence). Every state change names the fence the caller holds: a caller fenced out by
 * a later attempt matches no row and receives null, exactly as the lease store does. The database guard refuses a terminal
 * state change, a replaced response artifact or CONSUMED before RESPONSE_STORED (KA007 → PRECONDITION_FAILED); the
 * reservation columns are immutable (KA004 → INTEGRITY_FAILURE / IMMUTABLE_COLUMN). A reservation naming an upstream that is
 * not CONSUMED, unknown or of another tenant scope is refused by the guard request_journal_upstream_resolved (S089; KA009 →
 * PRECONDITION_FAILED / UPSTREAM_UNRESOLVED), which reads the upstream rows FOR SHARE. `updated_at` is transaction time
 * (trigger touch_updated_at), the port's `now` stamps nothing else on this table and is accepted for interface symmetry.
 */
import type { MoneyMinorUnits, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, NON_ACCEPTANCE_EVIDENCES, type NonAcceptanceEvidence, type RequestId, type RequestJournal, type RequestJournalRecord, type RequestReservation, type TaskId } from "@kauro/domain";
import { execute, instant, int, money, optionalText, withOptional, type Queryable } from "./sql.js";

interface RequestRow {
  request_id: string;
  task_id: string;
  request_hash: string;
  fence: string;
  state: RequestJournalRecord["state"];
  provider_request_id: string | null;
  response_artifact_hash: string | null;
  usage_state: RequestJournalRecord["usageState"];
  reserved_cents: string;
  actual_cents: string | null;
  updated_at: Date;
}

const REQUEST_COLUMNS = "request_id, task_id, request_hash, fence, state, provider_request_id, response_artifact_hash, usage_state, reserved_cents, actual_cents, updated_at";

function requestRecord(r: RequestRow): RequestJournalRecord {
  const base = {
    requestId: r.request_id as RequestId,
    taskId: r.task_id as TaskId,
    requestHash: r.request_hash,
    fence: int(r.fence),
    state: r.state,
    usageState: r.usage_state,
    reservedCents: money(r.reserved_cents),
    updatedAt: instant(r.updated_at),
  };
  const a = withOptional(base, "providerRequestId", optionalText(r.provider_request_id));
  const b = withOptional(a, "responseArtifactHash", optionalText(r.response_artifact_hash));
  return withOptional(b, "actualCents", r.actual_cents === null ? undefined : money(r.actual_cents));
}

function assertMoney(v: MoneyMinorUnits, what: string): string {
  if (!/^\d{1,18}$/.test(v)) throw new DomainFailure("INVALID_REQUEST", `${what} must be a non-negative integer number of minor units`);
  return v;
}

export class PgRequestJournal implements RequestJournal {
  constructor(private readonly db: Queryable) {}

  async reserve(reservation: RequestReservation): Promise<RequestJournalRecord> {
    const r = await execute<RequestRow>(
      this.db,
      `INSERT INTO kauro.request_journal (request_id, task_id, agency_id, request_hash, fence, state, usage_state, reserved_cents, cost_grant_id, upstream_request_ids, reserved_at, updated_at,
                                          step_fence, core_run_id, core_reservation_id, core_request_key, max_charge_micros)
       VALUES ($1, $2, $3, $4, $5, 'RESERVED', 'UNKNOWN', $6, $7, $8::uuid[], $9, $9, $10, $11, $12, $13, $14) RETURNING ${REQUEST_COLUMNS}`,
      [
        reservation.requestId,
        reservation.taskId,
        reservation.agencyId,
        reservation.requestHash,
        reservation.fence,
        assertMoney(reservation.reservedCents, "reservedCents"),
        reservation.costGrantId,
        [...reservation.upstreamRequestIds],
        reservation.reservedAt,
        reservation.stepFence ?? null,
        reservation.core?.runId ?? null,
        reservation.core?.reservationId ?? null,
        reservation.core?.requestKey ?? null,
        reservation.core === undefined ? null : reservation.core.maxChargeMicros.toString(),
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "request reservation returned no row");
    return requestRecord(row);
  }

  async #transition(requestId: RequestId, fence: number, sets: string, params: ReadonlyArray<unknown>): Promise<RequestJournalRecord | null> {
    const r = await execute<RequestRow>(this.db, `UPDATE kauro.request_journal SET ${sets} WHERE request_id = $1 AND fence = $2 RETURNING ${REQUEST_COLUMNS}`, [requestId, fence, ...params]);
    return r.rows[0] ? requestRecord(r.rows[0]) : null;
  }

  /**
   * RESERVED -> DISPATCHING (package B05 D5-18 edge guard, LOCK-B05-1): the request's model-task audit row FOR SHARE, then its MODEL_TASK
   * lease row FOR SHARE, each in its own statement before the edge (none for a request without a model task), then the edge only from
   * RESERVED; its BEFORE trigger re-checks the audit, the step and lease fences and the clocks, and the COMMIT re-judges under the pool's
   * liability gate. Any other state, or another fence, matches nothing: null.
   */
  async markDispatching(requestId: RequestId, fence: number, providerRequestId: string | null, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    await execute(
      this.db,
      `SELECT 1 FROM kauro.audits a
         JOIN kauro.model_tasks m ON m.agency_id = a.agency_id AND m.audit_id = a.audit_id
         JOIN kauro.request_journal r ON r.task_id = m.model_task_id
        WHERE r.request_id = $1 FOR SHARE OF a`,
      [requestId],
    );
    await execute(
      this.db,
      `SELECT 1 FROM kauro.leases l
         JOIN kauro.model_tasks m ON l.resource_kind = 'MODEL_TASK' AND l.resource_id = m.model_task_id
         JOIN kauro.request_journal r ON r.task_id = m.model_task_id
        WHERE r.request_id = $1 FOR SHARE OF l`,
      [requestId],
    );
    const r = await execute<RequestRow>(
      this.db,
      `UPDATE kauro.request_journal SET state = 'DISPATCHING', provider_request_id = coalesce($3, provider_request_id)
        WHERE request_id = $1 AND fence = $2 AND state = 'RESERVED' RETURNING ${REQUEST_COLUMNS}`,
      [requestId, fence, providerRequestId],
    );
    return r.rows[0] ? requestRecord(r.rows[0]) : null;
  }

  /**
   * RESPONSE_STORED at the request's own fence from DISPATCHING or UNCERTAIN (B05 D5-18 stale owner's response; the B06 contract kept):
   * on no match the row is read back at that fence without a lock: none -> null; RESPONSE_STORED with the same artifact -> the stored
   * row unchanged (a replay; usage is not rewritten); another artifact -> INTEGRITY_FAILURE / IMMUTABLE_COLUMN; any other state ->
   * PRECONDITION_FAILED / UNLISTED_TRANSITION (a response cannot exist for an unsent request, nor change a terminal one).
   */
  async storeResponse(requestId: RequestId, fence: number, responseArtifactHash: Sha256Hex, usage: { readonly usageState: RequestJournalRecord["usageState"]; readonly actualCents?: MoneyMinorUnits }, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    const actual = usage.actualCents === undefined ? null : assertMoney(usage.actualCents, "actualCents");
    const r = await execute<RequestRow>(
      this.db,
      `UPDATE kauro.request_journal SET state = 'RESPONSE_STORED', response_artifact_hash = $3, usage_state = $4, actual_cents = coalesce($5, actual_cents)
        WHERE request_id = $1 AND fence = $2 AND state IN ('DISPATCHING', 'UNCERTAIN') RETURNING ${REQUEST_COLUMNS}`,
      [requestId, fence, responseArtifactHash, usage.usageState, actual],
    );
    if (r.rows[0]) return requestRecord(r.rows[0]);
    const back = await execute<RequestRow>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.request_journal WHERE request_id = $1 AND fence = $2`, [requestId, fence]);
    const row = back.rows[0];
    if (!row) return null;
    if (row.state === "RESPONSE_STORED") {
      if (row.response_artifact_hash === responseArtifactHash) return requestRecord(row);
      throw new DomainFailure("INTEGRITY_FAILURE", `request ${requestId} already stored another response`, { reason: "IMMUTABLE_COLUMN" });
    }
    throw new DomainFailure("PRECONDITION_FAILED", `request ${requestId} is ${row.state} and stores no response`, { reason: "UNLISTED_TRANSITION" });
  }

  markConsumed(requestId: RequestId, fence: number, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    return this.#transition(requestId, fence, "state = 'CONSUMED'", []);
  }

  markUncertain(requestId: RequestId, fence: number, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    return this.#transition(requestId, fence, "state = 'UNCERTAIN'", []);
  }

  markFailed(requestId: RequestId, fence: number, _now: UtcInstant, evidence?: NonAcceptanceEvidence): Promise<RequestJournalRecord | null> {
    if (evidence === undefined) return this.#transition(requestId, fence, "state = 'FAILED'", []);
    if (!NON_ACCEPTANCE_EVIDENCES.includes(evidence)) throw new DomainFailure("INVALID_REQUEST", "non-acceptance evidence is one of the three literals of D5-18");
    return this.#transition(requestId, fence, "state = 'FAILED', non_acceptance_evidence = $3", [evidence]);
  }

  markCancelled(requestId: RequestId, fence: number, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    return this.#transition(requestId, fence, "state = 'CANCELLED'", []);
  }

  async reconcileUsage(requestId: RequestId, actualCents: MoneyMinorUnits, _now: UtcInstant): Promise<RequestJournalRecord | null> {
    const r = await execute<RequestRow>(
      this.db,
      `UPDATE kauro.request_journal SET usage_state = 'RECONCILED', actual_cents = $2 WHERE request_id = $1 RETURNING ${REQUEST_COLUMNS}`,
      [requestId, assertMoney(actualCents, "actualCents")],
    );
    return r.rows[0] ? requestRecord(r.rows[0]) : null;
  }

  async get(requestId: RequestId): Promise<RequestJournalRecord | null> {
    const r = await execute<RequestRow>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.request_journal WHERE request_id = $1`, [requestId]);
    return r.rows[0] ? requestRecord(r.rows[0]) : null;
  }

  async listByTask(taskId: TaskId): Promise<ReadonlyArray<RequestJournalRecord>> {
    const r = await execute<RequestRow>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.request_journal WHERE task_id = $1 ORDER BY fence`, [taskId]);
    return r.rows.map(requestRecord);
  }
}
