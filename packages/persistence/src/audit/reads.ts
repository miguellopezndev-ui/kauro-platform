/**
 * The readings of audit authority that B06's ports bind (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-
 * jobs.md §10, D8-PLAN-1): the ArtifactResolver of CMD023 over the content-idempotent decision artifacts of migration 0023, in the
 * caller's unit of work under its policies (the request handlers read their own agency's artifacts; another agency's reference is
 * unknown, never revealed). The shapes are @kauro/application's own (ArtifactResolver, DecisionPatch), written structurally here
 * because the persistence adapter does not depend on the application package (like the execution readings, D8-XPKG-3);
 * B08-COMMANDS-AUDIT binds them in apps/api.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { isUuid, type AgencyId, type ArtifactRef } from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";
import { jsonObject, str } from "../source/rows.js";

/** @kauro/application DecisionPatch: the typed patch a decisionPatchArtifactRef resolves to. */
export interface ResolvedDecisionPatch {
  readonly artifactRef: ArtifactRef;
  readonly patchHash: Sha256Hex;
  readonly document: unknown;
}

export class PgAuditReads {
  constructor(private readonly db: Queryable) {}

  /** A DECISION_PATCH artifact of the agency, by reference; null for an unknown, malformed or foreign one (CMD023: UNKNOWN_REFERENCE). */
  async resolveDecisionPatch(agencyId: AgencyId, artifactRef: ArtifactRef): Promise<ResolvedDecisionPatch | null> {
    if (!isUuid(artifactRef)) return null;
    const r = await execute<{ artifact_id: string; content_hash: string; document: unknown }>(
      this.db,
      "SELECT artifact_id, content_hash, document FROM kauro.decision_artifacts WHERE agency_id = $1 AND artifact_id = $2 AND kind = 'DECISION_PATCH'",
      [agencyId, artifactRef],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { artifactRef: str<ArtifactRef>(row.artifact_id), patchHash: str<Sha256Hex>(row.content_hash), document: jsonObject(row.document) };
  }
}
