/**
 * The breakglass records of package B16 lane L4 over `pg` (migration 0071; registry CMD054 OpenBreakglass, CMD055 RevokeBreakglass and the
 * breakglass preview). Every statement runs under the corporate owner's own request session (kauro_app, OPERATOR context): the policies of
 * 0071 decide what it reads. The scope a session names (kauro.breakglass_project_id, kauro.breakglass_grant_id) is transaction-local and
 * grants nothing by itself; every instant is the database's (opened_at, expires_at, revoked_at by trigger, judgments at effect_now()).
 *
 * Lock order (GAP-BG-1): the grant row is the one lock. A revocation takes it FOR NO KEY UPDATE, a read under the grant FOR SHARE in both of
 * its units (the metadata read and the release of the rows), and each judges the grant in a statement AFTER its lock, so a revocation that
 * commits first is seen by the read that waited on it, and a read that holds the lock first completes before the revocation lands.
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  isUtcInstant,
  type AgencyId,
  type AssuranceProofId,
  type BreakglassAuthorizationKind,
  type BreakglassGrantId,
  type BreakglassGrantRecord,
  type BreakglassGrantState,
  type BreakglassPreviewSubject,
  type DeclaredFormat,
  type BreakglassRepository,
  type JudgedBreakglassGrant,
  type ProjectId,
  type SourceFileId,
  type SourceTableId,
  type UserId,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";

const CANONICAL_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const at = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', ${CANONICAL_FORMAT}) AS ${column}`;
const GRANT_COLUMNS = ["grant_id", "holder_user_id", "agency_id", "project_id", "purpose", "authorization_kind", "authorization_ref", "state", "revision", at("opened_at"), at("expires_at"), at("revoked_at")].join(", ");

interface GrantRow {
  grant_id: string;
  holder_user_id: string;
  agency_id: string;
  project_id: string;
  purpose: string;
  authorization_kind: BreakglassAuthorizationKind;
  authorization_ref: string;
  state: BreakglassGrantState;
  revision: number;
  opened_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function instantOf(v: unknown): UtcInstant {
  if (typeof v !== "string" || !isUtcInstant(v)) throw new TypeError("expected a canonical instant column value");
  return v;
}

function grantOf(row: GrantRow): BreakglassGrantRecord {
  return {
    grantId: row.grant_id as BreakglassGrantId,
    holderUserId: row.holder_user_id as UserId,
    agencyId: row.agency_id as AgencyId,
    projectId: row.project_id as ProjectId,
    purpose: row.purpose,
    authorizationKind: row.authorization_kind,
    authorizationRef: row.authorization_ref,
    state: row.state,
    revision: Number(row.revision),
    openedAt: instantOf(row.opened_at),
    expiresAt: instantOf(row.expires_at),
    revokedAt: row.revoked_at === null ? null : instantOf(row.revoked_at),
  };
}

export class PgBreakglassRepository implements BreakglassRepository {
  constructor(private readonly db: Queryable) {}

  async #nameScope(projectId: string, grantId: string | null): Promise<void> {
    await execute(this.db, "SELECT set_config('kauro.breakglass_project_id', $1, true), set_config('kauro.breakglass_grant_id', $2, true)", [projectId, grantId ?? ""]);
  }

  async scopeOf(projectId: ProjectId): Promise<{ readonly agencyId: AgencyId; readonly projectId: ProjectId } | null> {
    await this.#nameScope(projectId, null);
    const r = await execute<{ agency_id: string; project_id: string }>(this.db, "SELECT agency_id, project_id FROM kauro.projects WHERE project_id = $1", [projectId]);
    const row = r.rows[0];
    return row ? { agencyId: row.agency_id as AgencyId, projectId: row.project_id as ProjectId } : null;
  }

  async authorizationKindOf(ref: string): Promise<BreakglassAuthorizationKind | null> {
    const r = await execute<{ support_case: boolean; incident: boolean }>(
      this.db,
      `SELECT EXISTS (SELECT 1 FROM kauro.support_cases WHERE case_id = $1 AND project_id = kauro.breakglass_scope_project()) AS support_case,
              EXISTS (SELECT 1 FROM kauro.incidents WHERE incident_id = $1) AS incident`,
      [ref],
    );
    const row = r.rows[0];
    if (row?.support_case === true) return "SUPPORT_CASE";
    if (row?.incident === true) return "INCIDENT";
    return null;
  }

  async lapseExpired(projectId: ProjectId): Promise<number> {
    const r = await execute(this.db, "UPDATE kauro.breakglass_grants SET state = 'EXPIRED', revision = revision + 1 WHERE project_id = $1 AND state = 'ACTIVE' AND expires_at <= kauro.effect_now()", [projectId]);
    return r.rowCount ?? 0;
  }

  async liveGrantOf(projectId: ProjectId): Promise<BreakglassGrantRecord | null> {
    const r = await execute<GrantRow>(this.db, `SELECT ${GRANT_COLUMNS} FROM kauro.breakglass_grants WHERE project_id = $1 AND state = 'ACTIVE'`, [projectId]);
    const row = r.rows[0];
    return row ? grantOf(row) : null;
  }

  async open(input: {
    readonly grantId: BreakglassGrantId;
    readonly holderUserId: UserId;
    readonly agencyId: AgencyId;
    readonly projectId: ProjectId;
    readonly purpose: string;
    readonly authorizationKind: BreakglassAuthorizationKind;
    readonly authorizationRef: string;
    readonly assuranceProofRef: AssuranceProofId;
  }): Promise<BreakglassGrantRecord> {
    const r = await execute<GrantRow>(
      this.db,
      `INSERT INTO kauro.breakglass_grants (grant_id, holder_user_id, agency_id, project_id, purpose, authorization_kind, authorization_ref, assurance_proof_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${GRANT_COLUMNS}`,
      [input.grantId, input.holderUserId, input.agencyId, input.projectId, input.purpose, input.authorizationKind, input.authorizationRef, input.assuranceProofRef],
    );
    return grantOf(r.rows[0]!);
  }

  async #judge(row: GrantRow | undefined): Promise<JudgedBreakglassGrant | null> {
    if (row === undefined) return null;
    // after the lock, in its own statement: the instant of the judgment is the instant the lock was granted or later (effect_now())
    const judged = await execute<{ expired: boolean; live: boolean }>(
      this.db,
      `SELECT g.expires_at <= kauro.effect_now() AS expired, kauro.breakglass_scope_live(g.agency_id, g.project_id, g.authorization_kind, g.authorization_ref) AS live
         FROM kauro.breakglass_grants g WHERE g.grant_id = $1`,
      [row.grant_id],
    );
    const j = judged.rows[0];
    return { grant: grantOf(row), expired: j?.expired === true, live: j?.live === true };
  }

  async lockForRevocation(grantId: BreakglassGrantId): Promise<JudgedBreakglassGrant | null> {
    const r = await execute<GrantRow>(this.db, `SELECT ${GRANT_COLUMNS} FROM kauro.breakglass_grants WHERE grant_id = $1 FOR NO KEY UPDATE`, [grantId]);
    const row = r.rows[0];
    if (row !== undefined) await this.#nameScope(row.project_id, null);
    return this.#judge(row);
  }

  async lockForRead(grantId: BreakglassGrantId, holderUserId: UserId): Promise<JudgedBreakglassGrant | null> {
    const r = await execute<GrantRow>(this.db, `SELECT ${GRANT_COLUMNS} FROM kauro.breakglass_grants WHERE grant_id = $1 AND holder_user_id = $2 FOR SHARE`, [grantId, holderUserId]);
    const row = r.rows[0];
    if (row !== undefined) await this.#nameScope(row.project_id, row.grant_id);
    return this.#judge(row);
  }

  async revoke(grant: BreakglassGrantRecord, by: UserId, reasonCode: string): Promise<BreakglassGrantRecord> {
    const r = await execute<GrantRow>(
      this.db,
      `UPDATE kauro.breakglass_grants SET state = 'REVOKED', revision = revision + 1, revoked_by_user_id = $3, revoke_reason = $4, revoked_at = kauro.server_now()
        WHERE grant_id = $1 AND revision = $2 AND state = 'ACTIVE'
        RETURNING ${GRANT_COLUMNS}`,
      [grant.grantId, grant.revision, by, reasonCode],
    );
    const row = r.rows[0];
    if (row === undefined) throw new TypeError("the grant moved under the lock this unit holds");
    return grantOf(row);
  }

  async previewSubject(tableId: SourceTableId): Promise<BreakglassPreviewSubject | null> {
    // every row through its breakglass policy: the admitted file of the covered project, its table, its accepted object
    const r = await execute<{ table_id: string; file_id: string; ordinal: number; column_count: number; sha256: string; bytes: string; format: string; provider_generation: string; provider: string; location_ref: string; object_name: string }>(
      this.db,
      `SELECT t.table_id, t.file_id, t.ordinal, t.column_count, f.sha256, f.bytes::text AS bytes, f.format, f.provider_generation, o.provider, o.location_ref, o.object_name
         FROM kauro.source_tables t
         JOIN kauro.source_files f ON f.file_id = t.file_id AND f.agency_id = t.agency_id
         JOIN kauro.stored_objects o ON o.object_id = f.accepted_object_id AND o.agency_id = f.agency_id
        WHERE t.table_id = $1`,
      [tableId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      tableId: row.table_id as SourceTableId,
      fileId: row.file_id as SourceFileId,
      ordinal: Number(row.ordinal),
      columnCount: Number(row.column_count),
      sha256: row.sha256 as BreakglassPreviewSubject["sha256"],
      bytes: Number(row.bytes),
      format: row.format as DeclaredFormat,
      providerGeneration: row.provider_generation,
      provider: row.provider,
      locationRef: row.location_ref,
      objectName: row.object_name,
    };
  }

  async recordAccess(input: { readonly accessId: string; readonly grant: BreakglassGrantRecord; readonly subject: BreakglassPreviewSubject; readonly by: UserId }): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.breakglass_accesses (access_id, grant_id, agency_id, project_id, file_id, table_id, accessed_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [input.accessId, input.grant.grantId, input.grant.agencyId, input.grant.projectId, input.subject.fileId, input.subject.tableId, input.by],
    );
  }
}
