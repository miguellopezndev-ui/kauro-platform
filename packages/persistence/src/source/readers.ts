/**
 * The read ports the source lifecycle offers the commercial packages (B09 payments, B10 quotes; design §17 items 5-6): the
 * availability of a sealed source and the explicit lineage of a project's revisions, over B07's own tables (the commercial
 * packages never read them). Implemented here; the integrator binds them where B09/B10 consume them.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { type RetentionId, type RevisionId, type RevisionLineageReader, type SourceAvailabilityReader, type SourceRevisionRecord } from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";
import { exact, instantText, optionalInstantText, str } from "./rows.js";

type Row = Record<string, unknown>;

/**
 * 09 "Quotes, reuploads and retention": a quote displays dataAvailableUntil and checkout rechecks it. The answer is read after the
 * revision's shared transition lock (B06 D-TX-2), so a retention_expires in flight is ordered before (and read: nothing is
 * available) or after this unit of work. A SEALED revision is available until the latest effective deadline of its governing
 * records that is still ahead on the server clock — it expires only when no governing record is ACTIVE ahead (D-RET-2) — and
 * `retentionId` names that record; any other state, or no record ahead, makes nothing available.
 */
export class PgSourceAvailabilityReader implements SourceAvailabilityReader {
  constructor(private readonly db: Queryable) {}

  async availabilityOf(revisionId: RevisionId): Promise<{ readonly revisionId: RevisionId; readonly state: SourceRevisionRecord["state"]; readonly manifestHash: Sha256Hex | null; readonly availableUntil: UtcInstant | null; readonly retentionId: RetentionId | null } | null> {
    const visible = await execute<{ revision_id: string }>(this.db, "SELECT revision_id FROM kauro.dataset_revisions WHERE revision_id = $1", [revisionId]);
    if (visible.rows[0] === undefined) return null;
    await execute(this.db, "SELECT kauro.await_transition('kauro.dataset_revisions', $1::uuid::text)", [revisionId]);
    const r = await execute<Row>(
      this.db,
      `SELECT r.revision_id, r.state, r.manifest_hash, g.retention_id, ${exact("g.effective_deadline", "available_until")}
         FROM kauro.dataset_revisions r
         LEFT JOIN LATERAL (
           SELECT x.retention_id, x.effective_deadline FROM kauro.retention_records x
            WHERE r.state = 'SEALED' AND x.agency_id = r.agency_id AND x.revision_id = r.revision_id
              AND x.state = 'ACTIVE' AND x.effective_deadline > kauro.server_now()
            ORDER BY x.effective_deadline DESC, x.retention_id DESC LIMIT 1
         ) g ON true
        WHERE r.revision_id = $1`,
      [revisionId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const availableUntil = optionalInstantText(row["available_until"]) ?? null;
    return {
      revisionId: str<RevisionId>(row["revision_id"]),
      state: str<SourceRevisionRecord["state"]>(row["state"]),
      manifestHash: (row["manifest_hash"] as Sha256Hex | null) ?? null,
      availableUntil,
      retentionId: availableUntil === null ? null : str<RetentionId>(row["retention_id"]),
    };
  }
}

/**
 * CMD012's explicit lineage (D-REV-1): the chain of successors after a revision, oldest first, each with how it replaced its
 * predecessor — SUPERSEDED (a sealed predecessor), CANCELLED (a mutable one CMD012 cancelled naming the successor) or UNCHANGED (a
 * predecessor already terminal: lineage only). The replacement allowance is the commercial package's to count (Q-B07-17).
 */
export class PgRevisionLineageReader implements RevisionLineageReader {
  constructor(private readonly db: Queryable) {}

  async replacementsSince(revisionId: RevisionId): Promise<ReadonlyArray<{ readonly revisionId: RevisionId; readonly supersedesRevisionId: RevisionId; readonly predecessorOutcome: "SUPERSEDED" | "CANCELLED" | "UNCHANGED"; readonly createdAt: UtcInstant }>> {
    const r = await execute<Row>(
      this.db,
      `WITH RECURSIVE chain (revision_id, supersedes_revision_id, created_at, depth) AS (
         SELECT s.revision_id, s.supersedes_revision_id, s.created_at, 1 FROM kauro.dataset_revisions s WHERE s.supersedes_revision_id = $1
         UNION ALL
         SELECT s.revision_id, s.supersedes_revision_id, s.created_at, c.depth + 1 FROM kauro.dataset_revisions s JOIN chain c ON s.supersedes_revision_id = c.revision_id
          WHERE c.depth < 1000
       )
       SELECT c.revision_id, c.supersedes_revision_id, ${exact("c.created_at")},
              CASE WHEN p.superseded_by_revision_id = c.revision_id AND p.superseded_at IS NOT NULL THEN 'SUPERSEDED'
                   WHEN p.superseded_by_revision_id = c.revision_id AND p.cancelled_at IS NOT NULL THEN 'CANCELLED'
                   ELSE 'UNCHANGED' END AS predecessor_outcome
         FROM chain c JOIN kauro.dataset_revisions p ON p.revision_id = c.supersedes_revision_id
        ORDER BY c.depth`,
      [revisionId],
    );
    return r.rows.map((x) => ({
      revisionId: str<RevisionId>(x["revision_id"]),
      supersedesRevisionId: str<RevisionId>(x["supersedes_revision_id"]),
      predecessorOutcome: str<"SUPERSEDED" | "CANCELLED" | "UNCHANGED">(x["predecessor_outcome"]),
      createdAt: instantText(x["created_at"]),
    }));
  }

  async descendsFrom(successorId: RevisionId, ancestorId: RevisionId): Promise<{ readonly successorState: SourceRevisionRecord["state"]; readonly path: ReadonlyArray<RevisionId> } | null> {
    // walked from the successor back to the ancestor over supersedes_revision_id only (ids, state and lineage: B06's columns)
    const r = await execute<Row>(
      this.db,
      `WITH RECURSIVE chain (revision_id, supersedes_revision_id, state, depth) AS (
         SELECT s.revision_id, s.supersedes_revision_id, s.state, 0 FROM kauro.dataset_revisions s WHERE s.revision_id = $1
         UNION ALL
         SELECT p.revision_id, p.supersedes_revision_id, p.state, c.depth + 1 FROM kauro.dataset_revisions p JOIN chain c ON p.revision_id = c.supersedes_revision_id
          WHERE c.depth < 1000 AND c.revision_id <> $2
       )
       SELECT revision_id, state, depth FROM chain ORDER BY depth DESC`,
      [successorId, ancestorId],
    );
    const rows = r.rows;
    const top = rows[0];
    const successor = rows[rows.length - 1];
    if (top === undefined || successor === undefined || rows.length < 2 || str<RevisionId>(top["revision_id"]) !== ancestorId) return null;
    return { successorState: str<SourceRevisionRecord["state"]>(successor["state"]), path: rows.map((x) => str<RevisionId>(x["revision_id"])) };
  }
}
