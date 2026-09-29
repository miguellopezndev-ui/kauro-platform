/**
 * The provider holds of accepted generations over `pg` (B07-R1; migration 0020; decisions D-HOLD-1..D-HOLD-3, D-CLOCK-1). An intent
 * and a release decision take the object's hold lock first (`kauro.lock_object_holds`, a transaction-level advisory lock the
 * database's guards take as well) and read what they decide on after it; a unit of work that intends or releases the holds of
 * several objects does so in object-id order, so two of them never wait on each other in a cycle. A seal, a close and a recorded
 * release change rows under their row locks only (migration 0020 explains why that suffices). Every instant is
 * kauro.server_now() in SQL. The database refuses what the adapter's own reads would have refused (a hold of a revoked file, a seal
 * past the bound, a release while an attempt is in flight or a seal retains the generation): the adapter answers the expected races
 * with typed results, the guards are the backstop.
 */
import {
  SEAL_HOLD_ATTEMPT_SECONDS,
  type AgencyId,
  type HoldReleaseDecision,
  type NewObjectHold,
  type ObjectHoldId,
  type ObjectHoldRecord,
  type ObjectHoldRepository,
  type ProjectId,
  type RevisionId,
  type SealAttemptId,
  type SourceFileId,
  type StoredObjectId,
  type UserId,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";
import { exact, instantText, one, opt, optionalInstantText, optionalString, pageLimit, str } from "./rows.js";

const HOLD_COLUMNS = [
  "hold_id",
  "attempt_id",
  "agency_id",
  "project_id",
  "revision_id",
  "file_id",
  "object_id",
  "generation",
  "hold_kind",
  "reason",
  "placed_by_user_id",
  "state",
  exact("intended_at"),
  exact("attempt_expires_at"),
  exact("sealed_at"),
  exact("closed_at"),
  "close_reason",
  exact("release_requested_at"),
  exact("released_at"),
  "release_result",
].join(", ");

type Row = Record<string, unknown>;

function holdRecord(r: Row): ObjectHoldRecord {
  return {
    holdId: str<ObjectHoldId>(r["hold_id"]),
    attemptId: str<SealAttemptId>(r["attempt_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    fileId: str<SourceFileId>(r["file_id"]),
    objectId: str<StoredObjectId>(r["object_id"]),
    generation: str(r["generation"]),
    holdKind: "TEMPORARY",
    reason: "SEAL_INTEGRITY",
    placedByUserId: str<UserId>(r["placed_by_user_id"]),
    state: str<ObjectHoldRecord["state"]>(r["state"]),
    intendedAt: instantText(r["intended_at"]),
    attemptExpiresAt: instantText(r["attempt_expires_at"]),
    ...opt("sealedAt", optionalInstantText(r["sealed_at"])),
    ...opt("closedAt", optionalInstantText(r["closed_at"])),
    ...opt("closeReason", optionalString<NonNullable<ObjectHoldRecord["closeReason"]>>(r["close_reason"])),
    ...opt("releaseRequestedAt", optionalInstantText(r["release_requested_at"])),
    ...opt("releasedAt", optionalInstantText(r["released_at"])),
    ...opt("releaseResult", optionalString<NonNullable<ObjectHoldRecord["releaseResult"]>>(r["release_result"])),
  };
}

/** The attempt bound as an SQL interval (migration 0020 checks attempt_expires_at = intended_at + this). */
const BOUND = `make_interval(secs => ${SEAL_HOLD_ATTEMPT_SECONDS})`;

export class PgObjectHoldRepository implements ObjectHoldRepository {
  constructor(private readonly db: Queryable) {}

  /** The object's hold lock, held to the end of the unit of work (the guards take the same one). */
  async #lock(objectId: StoredObjectId): Promise<void> {
    await execute(this.db, "SELECT kauro.lock_object_holds($1::uuid)", [objectId]);
  }

  async intend(hold: NewObjectHold): Promise<{ readonly kind: "INTENDED"; readonly record: ObjectHoldRecord } | { readonly kind: "RELEASE_PENDING" }> {
    await this.#lock(hold.objectId);
    const releasing = await execute(this.db, "SELECT 1 FROM kauro.object_holds WHERE object_id = $1 AND state = 'RELEASING' LIMIT 1", [hold.objectId]);
    if (releasing.rows.length > 0) return { kind: "RELEASE_PENDING" };
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.object_holds (hold_id, attempt_id, agency_id, project_id, revision_id, file_id, object_id, generation, hold_kind, reason, placed_by_user_id,
                                       state, intended_at, attempt_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TEMPORARY', 'SEAL_INTEGRITY', $9, 'INTENDED', kauro.server_now(), kauro.server_now() + ${BOUND}, kauro.server_now(), kauro.server_now())
       RETURNING ${HOLD_COLUMNS}`,
      [hold.holdId, hold.attemptId, hold.agencyId, hold.projectId, hold.revisionId, hold.fileId, hold.objectId, hold.generation, hold.placedByUserId],
    );
    return { kind: "INTENDED", record: holdRecord(one(r.rows, "object hold intent")) };
  }

  async seal(holdId: ObjectHoldId): Promise<{ readonly kind: "APPLIED"; readonly record: ObjectHoldRecord } | { readonly kind: "STALE"; readonly currentState: ObjectHoldRecord["state"] | null }> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.object_holds SET state = 'SEALED', sealed_at = kauro.server_now()
        WHERE hold_id = $1 AND state = 'INTENDED' AND attempt_expires_at > kauro.server_now() RETURNING ${HOLD_COLUMNS}`,
      [holdId],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: holdRecord(row) };
    const after = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.object_holds WHERE hold_id = $1", [holdId]);
    return { kind: "STALE", currentState: (after.rows[0]?.state as ObjectHoldRecord["state"] | undefined) ?? null };
  }

  async closeAttempt(attemptId: SealAttemptId): Promise<ReadonlyArray<ObjectHoldRecord>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.object_holds SET state = 'CLOSED', closed_at = kauro.server_now(), close_reason = 'REFUSED'
        WHERE attempt_id = $1 AND state = 'INTENDED' RETURNING ${HOLD_COLUMNS}`,
      [attemptId],
    );
    return r.rows.map(holdRecord);
  }

  async abandon(holdId: ObjectHoldId): Promise<boolean> {
    const r = await execute(
      this.db,
      `UPDATE kauro.object_holds SET state = 'CLOSED', closed_at = kauro.server_now(), close_reason = 'ABANDONED'
        WHERE hold_id = $1 AND state = 'INTENDED' AND attempt_expires_at <= kauro.server_now()`,
      [holdId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async requestRelease(objectId: StoredObjectId): Promise<HoldReleaseDecision> {
    await this.#lock(objectId);
    const needed = await execute<{ needed: boolean }>(this.db, "SELECT kauro.object_hold_needed($1::uuid) AS needed", [objectId]);
    if (needed.rows[0]?.needed === true) return { kind: "NEEDED" };
    const releasing = await execute<{ generation: string; stale: boolean; holds: string }>(
      this.db,
      `SELECT generation, bool_and(release_requested_at + ${BOUND} <= kauro.server_now()) AS stale, count(*)::text AS holds
         FROM kauro.object_holds WHERE object_id = $1 AND state = 'RELEASING' GROUP BY generation`,
      [objectId],
    );
    const pending = releasing.rows[0];
    if (pending !== undefined) return pending.stale ? { kind: "RELEASE", generation: pending.generation, holds: Number(pending.holds) } : { kind: "IN_FLIGHT" };
    const moved = await execute<{ generation: string }>(
      this.db,
      "UPDATE kauro.object_holds SET state = 'RELEASING', release_requested_at = kauro.server_now() WHERE object_id = $1 AND state IN ('CLOSED', 'SEALED') RETURNING generation",
      [objectId],
    );
    const first = moved.rows[0];
    return first === undefined ? { kind: "NONE" } : { kind: "RELEASE", generation: first.generation, holds: moved.rows.length };
  }

  async recordRelease(objectId: StoredObjectId, result: "RELEASED" | "ABSENT"): Promise<number> {
    const r = await execute(
      this.db,
      "UPDATE kauro.object_holds SET state = 'RELEASED', released_at = kauro.server_now(), release_result = $2 WHERE object_id = $1 AND state = 'RELEASING'",
      [objectId, result],
    );
    return r.rowCount ?? 0;
  }

  async forAttempt(attemptId: SealAttemptId): Promise<ReadonlyArray<ObjectHoldRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${HOLD_COLUMNS} FROM kauro.object_holds WHERE attempt_id = $1 ORDER BY object_id`, [attemptId]);
    return r.rows.map(holdRecord);
  }

  async forObject(objectId: StoredObjectId): Promise<ReadonlyArray<ObjectHoldRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${HOLD_COLUMNS} FROM kauro.object_holds WHERE object_id = $1 ORDER BY intended_at, hold_id`, [objectId]);
    return r.rows.map(holdRecord);
  }

  async findAbandoned(limit: number): Promise<ReadonlyArray<{ readonly holdId: ObjectHoldId; readonly agencyId: AgencyId }>> {
    const r = await execute<{ hold_id: string; agency_id: string }>(
      this.db,
      "SELECT hold_id, agency_id FROM kauro.object_holds WHERE state = 'INTENDED' AND attempt_expires_at <= kauro.server_now() ORDER BY attempt_expires_at, hold_id LIMIT $1",
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ holdId: x.hold_id as ObjectHoldId, agencyId: x.agency_id as AgencyId }));
  }

  async findReleasable(limit: number): Promise<ReadonlyArray<{ readonly objectId: StoredObjectId; readonly agencyId: AgencyId }>> {
    const r = await execute<{ object_id: string; agency_id: string }>(
      this.db,
      `SELECT DISTINCT h.object_id, h.agency_id FROM kauro.object_holds h
        WHERE (h.state IN ('CLOSED', 'SEALED') AND NOT kauro.object_hold_needed(h.object_id))
           OR (h.state = 'RELEASING' AND h.release_requested_at + ${BOUND} <= kauro.server_now())
        ORDER BY h.object_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ objectId: x.object_id as StoredObjectId, agencyId: x.agency_id as AgencyId }));
  }
}
