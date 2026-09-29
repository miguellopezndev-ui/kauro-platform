/**
 * The provider holds of accepted generations over `pg` (B07-R1; migration 0020; decisions D-HOLD-1..D-HOLD-4, D-CLOCK-1). An intent,
 * a release decision (with its claim) and a recorded answer take the object's hold lock first (`kauro.lock_object_holds`, a
 * transaction-level advisory lock the database's guards take as well) and read what they decide on after it; a unit of work that
 * intends or releases the holds of several objects does so in object-id order, so two of them never wait on each other in a cycle.
 * A seal and a close change rows under their row locks only (migration 0020 explains why that suffices). Every instant is
 * kauro.server_now() in SQL. The database refuses what the adapter's own reads would have refused (a hold of a revoked file, a seal
 * past the bound, a release while an attempt is in flight or a seal retains the generation, an intent while a release may still land,
 * a second live claim, an answer under a superseded claim, a claim that does not name the recorded metageneration, a re-observed one
 * under a claim that lapsed or was superseded): the adapter answers the expected races with typed results, the guards are the backstop.
 * Metagenerations are int8 at the database and decimal strings here (Cloud Storage's int64 as the JSON API writes it, D-HOLD-4).
 */
import {
  HOLD_RELEASE_CLAIM_SECONDS,
  PROVIDER_CALL_TIMEOUT_MS,
  SEAL_HOLD_ATTEMPT_SECONDS,
  type AgencyId,
  type HoldReassertionId,
  type HoldReleaseAnswer,
  type HoldReleaseRebase,
  type HoldReassertionResult,
  type HoldReleaseDecision,
  type HoldReleaseId,
  type HoldReleaseRecording,
  type NewHoldReassertion,
  type NewObjectHold,
  type ObjectHoldId,
  type ObjectHoldReassertionRecord,
  type ObjectHoldRecord,
  type ObjectHoldReleaseRecord,
  type ObjectHoldRepository,
  type ProjectId,
  type RevisionId,
  type SealAttemptId,
  type SourceFileId,
  type StoredObjectId,
  type UnconfirmedSealedHold,
  type UserId,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
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
  "released_by",
  "metageneration::text AS metageneration",
].join(", ");

const RELEASE_COLUMNS = [
  "release_id",
  "agency_id",
  "object_id",
  "generation",
  "sequence",
  exact("claimed_at"),
  exact("claim_expires_at"),
  exact("in_flight_until"),
  "metageneration::text AS metageneration",
  exact("answered_at"),
  "release_result",
].join(", ");

const REASSERTION_COLUMNS = ["reassertion_id", "hold_id", "agency_id", "object_id", "generation", "result", "reasserted_by", exact("observed_at"), "metageneration::text AS metageneration"].join(", ");

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
    ...opt("releasedBy", optionalString<HoldReleaseId>(r["released_by"])),
    ...opt("metageneration", optionalString(r["metageneration"])),
  };
}

function releaseRecord(r: Row): ObjectHoldReleaseRecord {
  return {
    releaseId: str<HoldReleaseId>(r["release_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    objectId: str<StoredObjectId>(r["object_id"]),
    generation: str(r["generation"]),
    sequence: int(r["sequence"]),
    claimedAt: instantText(r["claimed_at"]),
    claimExpiresAt: instantText(r["claim_expires_at"]),
    inFlightUntil: instantText(r["in_flight_until"]),
    ...opt("metageneration", optionalString(r["metageneration"])),
    ...opt("answeredAt", optionalInstantText(r["answered_at"])),
    ...opt("releaseResult", optionalString<NonNullable<ObjectHoldReleaseRecord["releaseResult"]>>(r["release_result"])),
  };
}

function reassertionRecord(r: Row): ObjectHoldReassertionRecord {
  return {
    reassertionId: str<HoldReassertionId>(r["reassertion_id"]),
    holdId: str<ObjectHoldId>(r["hold_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    objectId: str<StoredObjectId>(r["object_id"]),
    generation: str(r["generation"]),
    result: str<HoldReassertionResult>(r["result"]),
    reassertedBy: str<ObjectHoldReassertionRecord["reassertedBy"]>(r["reasserted_by"]),
    observedAt: instantText(r["observed_at"]),
    ...opt("metageneration", optionalString(r["metageneration"])),
  };
}

/** The attempt bound as an SQL interval (migration 0020 checks attempt_expires_at = intended_at + this). */
const BOUND = `make_interval(secs => ${SEAL_HOLD_ATTEMPT_SECONDS})`;

/** A release claim's bound, and the bound after which none of its provider calls can land (migration 0020 checks both). */
const CLAIM = `make_interval(secs => ${HOLD_RELEASE_CLAIM_SECONDS})`;
const IN_FLIGHT = `make_interval(secs => ${HOLD_RELEASE_CLAIM_SECONDS + PROVIDER_CALL_TIMEOUT_MS / 1000})`;

/** A claim of the object neither answered nor past its in-flight bound: a provider release of it is still expected (D-HOLD-3). */
const RELEASE_MAY_LAND = "SELECT 1 FROM kauro.object_hold_releases r WHERE r.object_id = $1 AND r.answered_at IS NULL AND r.in_flight_until > kauro.server_now() LIMIT 1";

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
    const landing = await execute(this.db, RELEASE_MAY_LAND, [hold.objectId]);
    if (landing.rows.length > 0) return { kind: "RELEASE_PENDING" };
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

  async seal(holdId: ObjectHoldId, metageneration: string): Promise<{ readonly kind: "APPLIED"; readonly record: ObjectHoldRecord } | { readonly kind: "STALE"; readonly currentState: ObjectHoldRecord["state"] | null }> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.object_holds SET state = 'SEALED', sealed_at = kauro.server_now(), metageneration = $2::bigint
        WHERE hold_id = $1 AND state = 'INTENDED' AND attempt_expires_at > kauro.server_now() RETURNING ${HOLD_COLUMNS}`,
      [holdId, metageneration],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: holdRecord(row) };
    const after = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.object_holds WHERE hold_id = $1", [holdId]);
    return { kind: "STALE", currentState: (after.rows[0]?.state as ObjectHoldRecord["state"] | undefined) ?? null };
  }

  async closeAttempt(attemptId: SealAttemptId, placed: ReadonlyArray<{ readonly holdId: ObjectHoldId; readonly metageneration: string }> = []): Promise<ReadonlyArray<ObjectHoldRecord>> {
    // each placed hold's metageneration is recorded by the edge that closes it (D-HOLD-4); an unanswered placement records none
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.object_holds h SET state = 'CLOSED', closed_at = kauro.server_now(), close_reason = 'REFUSED',
              metageneration = (SELECT p.m FROM unnest($2::uuid[], $3::bigint[]) AS p(hold_id, m) WHERE p.hold_id = h.hold_id)
        WHERE h.attempt_id = $1 AND h.state = 'INTENDED' RETURNING ${HOLD_COLUMNS}`,
      [attemptId, placed.map((x) => x.holdId), placed.map((x) => x.metageneration)],
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

  async requestRelease(objectId: StoredObjectId, releaseId: HoldReleaseId): Promise<HoldReleaseDecision> {
    await this.#lock(objectId);
    const needed = await execute<{ needed: boolean }>(this.db, "SELECT kauro.object_hold_needed($1::uuid) AS needed", [objectId]);
    if (needed.rows[0]?.needed === true) return { kind: "NEEDED" };
    const releasing = await execute<{ agency_id: string; generation: string; holds: string }>(
      this.db,
      "SELECT agency_id, generation, count(*)::text AS holds FROM kauro.object_holds WHERE object_id = $1 AND state = 'RELEASING' GROUP BY agency_id, generation",
      [objectId],
    );
    let pending = releasing.rows[0];
    if (pending !== undefined) {
      // a decided release: left to its claimant while its claim holds; a lapsed, unanswered claim is claimed again
      const live = await execute(this.db, "SELECT 1 FROM kauro.object_hold_releases WHERE object_id = $1 AND answered_at IS NULL AND claim_expires_at > kauro.server_now() LIMIT 1", [objectId]);
      if (live.rows.length > 0) return { kind: "IN_FLIGHT" };
    } else {
      const moved = await execute<{ agency_id: string; generation: string }>(
        this.db,
        "UPDATE kauro.object_holds SET state = 'RELEASING', release_requested_at = kauro.server_now() WHERE object_id = $1 AND state IN ('CLOSED', 'SEALED') RETURNING agency_id, generation",
        [objectId],
      );
      const first = moved.rows[0];
      if (first === undefined) return { kind: "NONE" };
      pending = { agency_id: first.agency_id, generation: first.generation, holds: String(moved.rows.length) };
    }
    // the claim names the greatest metageneration recorded for the holds it releases: the incarnation its release clears (D-HOLD-4)
    const claim = await execute<Row>(
      this.db,
      `INSERT INTO kauro.object_hold_releases (release_id, agency_id, object_id, generation, sequence, claimed_at, claim_expires_at, in_flight_until, metageneration, created_at, updated_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, coalesce(max(sequence), 0) + 1, kauro.server_now(), kauro.server_now() + ${CLAIM}, kauro.server_now() + ${IN_FLIGHT},
              kauro.object_hold_recorded_metageneration($3::uuid, $4::text), kauro.server_now(), kauro.server_now()
         FROM kauro.object_hold_releases WHERE object_id = $3
       RETURNING ${RELEASE_COLUMNS}`,
      [releaseId, pending.agency_id, objectId, pending.generation],
    );
    const record = releaseRecord(one(claim.rows, "release claim"));
    return {
      kind: "RELEASE",
      releaseId: record.releaseId,
      generation: record.generation,
      ...opt("metageneration", record.metageneration),
      holds: Number(pending.holds),
      claimedAt: record.claimedAt,
      claimExpiresAt: record.claimExpiresAt,
    };
  }

  async rebaseRelease(releaseId: HoldReleaseId, metageneration: string): Promise<HoldReleaseRebase> {
    const claimed = await execute<{ object_id: string }>(this.db, "SELECT object_id FROM kauro.object_hold_releases WHERE release_id = $1", [releaseId]);
    const objectId = claimed.rows[0]?.object_id as StoredObjectId | undefined;
    if (objectId === undefined) return { kind: "STALE" };
    await this.#lock(objectId);
    // only the object's latest claim, unanswered and live, and only a newer metageneration (D-HOLD-4; the guard refuses the rest)
    const r = await execute(
      this.db,
      `UPDATE kauro.object_hold_releases c SET metageneration = $2::bigint
        WHERE c.release_id = $1 AND c.answered_at IS NULL AND c.claim_expires_at > kauro.server_now()
          AND (c.metageneration IS NULL OR c.metageneration < $2::bigint)
          AND NOT EXISTS (SELECT 1 FROM kauro.object_hold_releases l WHERE l.object_id = c.object_id AND l.sequence > c.sequence)`,
      [releaseId, metageneration],
    );
    return (r.rowCount ?? 0) > 0 ? { kind: "REBASED" } : { kind: "STALE" };
  }

  async recordRelease(releaseId: HoldReleaseId, result: HoldReleaseAnswer): Promise<HoldReleaseRecording> {
    const claimed = await execute<{ object_id: string }>(this.db, "SELECT object_id FROM kauro.object_hold_releases WHERE release_id = $1", [releaseId]);
    const objectId = claimed.rows[0]?.object_id as StoredObjectId | undefined;
    if (objectId === undefined) return { kind: "STALE" };
    await this.#lock(objectId);
    // only the object's latest claim, unanswered: its claimant's answer (the fence)
    const answered = await execute<{ generation: string }>(
      this.db,
      `UPDATE kauro.object_hold_releases c SET answered_at = kauro.server_now(), release_result = $2
        WHERE c.release_id = $1 AND c.answered_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM kauro.object_hold_releases l WHERE l.object_id = c.object_id AND l.sequence > c.sequence)
        RETURNING c.generation`,
      [releaseId, result],
    );
    const generation = answered.rows[0]?.generation;
    if (generation === undefined) return { kind: "STALE" };
    const r = await execute(
      this.db,
      "UPDATE kauro.object_holds SET state = 'RELEASED', released_at = kauro.server_now(), release_result = $3, released_by = $4 WHERE object_id = $1 AND generation = $2 AND state = 'RELEASING'",
      [objectId, generation, result, releaseId],
    );
    return { kind: "RECORDED", holds: r.rowCount ?? 0 };
  }

  async releasesOf(objectId: StoredObjectId): Promise<ReadonlyArray<ObjectHoldReleaseRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${RELEASE_COLUMNS} FROM kauro.object_hold_releases WHERE object_id = $1 ORDER BY sequence`, [objectId]);
    return r.rows.map(releaseRecord);
  }

  async recordReassertion(reassertion: NewHoldReassertion): Promise<ObjectHoldReassertionRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.object_hold_reassertions (reassertion_id, hold_id, agency_id, object_id, generation, result, reasserted_by, observed_at, metageneration, created_at)
       SELECT $1::uuid, h.hold_id, h.agency_id, h.object_id, h.generation, $3::text, $4::text, kauro.server_now(), $5::bigint, kauro.server_now() FROM kauro.object_holds h WHERE h.hold_id = $2::uuid
       RETURNING ${REASSERTION_COLUMNS}`,
      [reassertion.reassertionId, reassertion.holdId, reassertion.result, reassertion.reassertedBy, reassertion.metageneration ?? null],
    );
    return reassertionRecord(one(r.rows, "hold re-assertion"));
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
           OR (h.state = 'RELEASING' AND NOT EXISTS (
                 SELECT 1 FROM kauro.object_hold_releases c WHERE c.object_id = h.object_id AND c.answered_at IS NULL AND c.claim_expires_at > kauro.server_now()))
        ORDER BY h.object_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ objectId: x.object_id as StoredObjectId, agencyId: x.agency_id as AgencyId }));
  }

  async findUnconfirmed(limit: number): Promise<ReadonlyArray<UnconfirmedSealedHold>> {
    const r = await execute<{ hold_id: string; agency_id: string; object_id: string; generation: string; file_id: string; origin_revision_id: string; last_result: string | null }>(
      this.db,
      `SELECT h.hold_id, h.agency_id, h.object_id, h.generation, h.file_id, f.origin_revision_id, last.result AS last_result
         FROM kauro.object_holds h
         JOIN kauro.source_files f ON f.agency_id = h.agency_id AND f.file_id = h.file_id
         LEFT JOIN LATERAL (
           SELECT a.result FROM kauro.object_hold_reassertions a WHERE a.hold_id = h.hold_id ORDER BY a.observed_at DESC, a.reassertion_id DESC LIMIT 1
         ) last ON true
        WHERE h.state = 'SEALED' AND f.state = 'ADMITTED'
          AND (last.result = 'GENERATION_NOT_LIVE' OR (last.result IS NULL AND h.sealed_at + ${BOUND} <= kauro.server_now()))
        ORDER BY h.sealed_at, h.hold_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({
      holdId: x.hold_id as ObjectHoldId,
      agencyId: x.agency_id as AgencyId,
      objectId: x.object_id as StoredObjectId,
      generation: x.generation,
      fileId: x.file_id as SourceFileId,
      originRevisionId: x.origin_revision_id as RevisionId,
      lastResult: (x.last_result as HoldReassertionResult | null) ?? null,
    }));
  }
}
