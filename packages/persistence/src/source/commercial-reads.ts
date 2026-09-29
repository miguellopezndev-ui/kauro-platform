/**
 * The source lifecycle's answers to the payments workflow (the B07 + B09 merge, docs/design/B07-B09-merge.md; B07 design §17 items
 * 5-7, B09 design §15 items 5-6): the availability of a quoted source and the lineage of a replacement, as package B09's ports ask
 * for them — by the revision hash a quote carries — computed over B07's own readers on the caller's connection:
 *
 * - availability: B07's SourceAvailabilityReader (the revision read after its shared transition lock, B06 D-TX-2, so a concurrent
 *   retention_expires is ordered before or after) and the deadlines of the revision's governing retention records. The effective
 *   deadline is B07's availableUntil while a governing record is ACTIVE ahead on the server clock, else the latest effective deadline
 *   a governing record had (already past: nothing is available); the hard deadline is that record's. Both reads name only the
 *   record columns the payment service holds (its quote views answer checkout readiness too, in its SERVICE unit of work: migration
 *   0018, D-MERGE-3).
 * - lineage: CMD012's explicit lineage (RevisionLineageReader.descendsFrom over dataset_revisions.supersedes_revision_id, B06's
 *   column), which the payment service's column grant covers — B09 reads no B07 column (B07 design §17 item 4).
 *
 * Each answer carries a domain-separated evidence hash of exactly the facts it states (KAURO_SOURCE_AVAILABILITY_V1,
 * KAURO_SOURCE_LINEAGE_V1), which the payments workflow records beside what it decided (a re-binding's lineageEvidenceHash).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { sourceAvailabilityHashOf, sourceLineageHashOf, type AgencyId, type ProjectId, type RevisionId } from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";
import type { PgSourceStore } from "./store.js";
import { exact, instantText, str } from "./rows.js";

/** The availability of a quoted source, as B09's SourceAvailabilityReader states it (D-QUOTE-B7). */
export interface CommercialSourceAvailability {
  readonly revisionId: RevisionId;
  readonly state: string;
  readonly sealedAt: UtcInstant;
  readonly effectiveDeadline: UtcInstant;
  readonly hardDeadline: UtcInstant;
  readonly evidenceHash: Sha256Hex;
}

/** The lineage of a replacement revision, as B09's SourceLineageReader states it (D-QUOTE-B6). */
export interface CommercialSourceLineage {
  readonly replacedRevisionId: RevisionId;
  readonly replacementRevisionId: RevisionId;
  readonly replacementSealed: boolean;
  readonly evidenceHash: Sha256Hex;
}

export class PgCommercialSourceReads {
  /** On the connection of a source unit of work, over the readers of its B07 source store (the same transaction and context). */
  constructor(
    private readonly db: Queryable,
    private readonly sources: Pick<PgSourceStore, "availability" | "lineage">,
  ) {}

  /** The revision of the project whose manifest hash is `revisionHash`, visible under the caller's policies, or null. */
  async #revisionOf(agencyId: AgencyId, projectId: ProjectId, revisionHash: Sha256Hex): Promise<{ readonly revisionId: RevisionId; readonly state: string; readonly sealedAt: UtcInstant | null } | null> {
    const r = await execute<Record<string, unknown>>(
      this.db,
      `SELECT revision_id, state, ${exact("sealed_at")} FROM kauro.dataset_revisions WHERE agency_id = $1 AND project_id = $2 AND manifest_hash = $3`,
      [agencyId, projectId, revisionHash],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    return { revisionId: str<RevisionId>(row["revision_id"]), state: str<string>(row["state"]), sealedAt: row["sealed_at"] === null ? null : instantText(row["sealed_at"]) };
  }

  /**
   * B09 SourceAvailabilityReader.availabilityOf: null when the quoted revision is not visible or was never sealed; otherwise its state,
   * its seal instant and the deadlines of its governing retention (a state other than SEALED, or an effective deadline behind the
   * clock, is SOURCE_EXPIRED to checkout and capture).
   */
  async availabilityOf(request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly revisionHash: Sha256Hex }): Promise<CommercialSourceAvailability | null> {
    const revision = await this.#revisionOf(request.agencyId, request.projectId, request.revisionHash);
    if (revision === null || revision.sealedAt === null) return null;
    const available = await this.sources.availability.availabilityOf(revision.revisionId);
    if (available === null) return null;
    // the governing records' deadlines, latest effective deadline first (the record B07's reader named, when one is ACTIVE ahead)
    const records = await execute<Record<string, unknown>>(
      this.db,
      `SELECT retention_id, ${exact("effective_deadline")}, ${exact("hard_deadline")} FROM kauro.retention_records
        WHERE agency_id = $1 AND revision_id = $2 ORDER BY effective_deadline DESC, retention_id DESC`,
      [request.agencyId, revision.revisionId],
    );
    const rows = records.rows.map((x) => ({ retentionId: str<string>(x["retention_id"]), effectiveDeadline: instantText(x["effective_deadline"]), hardDeadline: instantText(x["hard_deadline"]) }));
    const governing = (available.retentionId !== null ? rows.find((x) => x.retentionId === available.retentionId) : undefined) ?? rows[0];
    if (governing === undefined) return null;
    const effectiveDeadline = available.availableUntil ?? governing.effectiveDeadline;
    const answer = {
      revisionId: revision.revisionId,
      state: available.state,
      sealedAt: revision.sealedAt,
      effectiveDeadline,
      hardDeadline: governing.hardDeadline,
    };
    return { ...answer, evidenceHash: sourceAvailabilityHashOf({ ...answer, manifestHash: request.revisionHash, retentionId: governing.retentionId }) };
  }

  /**
   * B09 SourceLineageReader.replacementOf: null unless both hashes name revisions of the project and the replacement descends from the
   * replaced revision through CMD012's lineage; `replacementSealed` is the replacement's SEALED state.
   */
  async replacementOf(request: { readonly agencyId: AgencyId; readonly projectId: ProjectId; readonly replacedRevisionHash: Sha256Hex; readonly replacementRevisionHash: Sha256Hex }): Promise<CommercialSourceLineage | null> {
    const replaced = await this.#revisionOf(request.agencyId, request.projectId, request.replacedRevisionHash);
    const replacement = await this.#revisionOf(request.agencyId, request.projectId, request.replacementRevisionHash);
    if (replaced === null || replacement === null) return null;
    const chain = await this.sources.lineage.descendsFrom(replacement.revisionId, replaced.revisionId);
    if (chain === null) return null;
    const answer = { replacedRevisionId: replaced.revisionId, replacementRevisionId: replacement.revisionId, replacementSealed: chain.successorState === "SEALED" };
    return {
      ...answer,
      evidenceHash: sourceLineageHashOf({ ...answer, replacedRevisionHash: request.replacedRevisionHash, replacementRevisionHash: request.replacementRevisionHash, path: chain.path }),
    };
  }
}
