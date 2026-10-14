/**
 * The download authorization store over `pg` (package B16 lane L5, CMD038 AuthorizeDownload; @kauro/domain DownloadAuthorizationStore;
 * migration 0074, provisional). The request session's reads and writes of one grant; the database re-proves every precondition of a
 * grant (KA094, B16_L5_DOWNLOAD_AUTHORIZATION) and orders a grant against the project's and the package's state changes through their
 * transition locks (`awaitProject`, `awaitPackage`).
 *
 * Instants are read exactly (microseconds, `exact`); the lifetime is computed in SQL from the effect instant the caller read after its
 * last lock and the governing record's effective deadline, so the stored expiry is exactly least(issued_at + 900 s, deadline).
 */
import { DomainFailure, type AgencyId, type DownloadArtifactRow, type DownloadAuthorizationRow, type DownloadAuthorizationStore, type DownloadPackageRow, type DownloadRecheck, type DownloadSignState, type GoverningRetentionRow, type IssueDownloadInput, type MembershipId, type PackageVersionId, type ProjectId, type UserId } from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { exact, instantText, str } from "../source/rows.js";

type Row = Record<string, unknown>;

const EXACT = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const EFFECT_NOW_EXACT = `to_char(kauro.effect_now() AT TIME ZONE 'UTC', ${EXACT})`;

/** The governing PAID record of a package's source revision (the job's revision: same project, same manifest hash). */
const GOVERNING = `
  FROM kauro.package_versions p
  JOIN kauro.processing_jobs j ON j.agency_id = p.agency_id AND j.job_id = p.job_id
  JOIN kauro.dataset_revisions d ON d.agency_id = j.agency_id AND d.project_id = j.project_id AND d.manifest_hash = j.revision_hash
  JOIN kauro.retention_records r ON r.agency_id = d.agency_id AND r.revision_id = d.revision_id AND r.class IN ('PAID_ORDINARY', 'PAID_STAGED')
 WHERE p.package_version_id = $1`;

const ARTIFACT_COLUMNS = `x.object_id::text AS artifact_id, x.object_name, x.generation, x.role, x.sha256, x.byte_length::text AS byte_length, o.state AS object_state`;

function artifactRow(r: Row): DownloadArtifactRow {
  return {
    artifactId: str(r["artifact_id"]),
    objectName: str(r["object_name"]),
    generation: str(r["generation"]),
    role: str(r["role"]),
    sha256: str(r["sha256"]),
    byteLength: int(r["byte_length"]),
    objectState: str(r["object_state"]),
  };
}

function retentionRow(r: Row): GoverningRetentionRow {
  return { retentionId: str(r["retention_id"]), state: str(r["state"]), effectiveDeadline: instantText(r["effective_deadline"]) };
}

const AUTHORIZATION_COLUMNS = [
  "a.authorization_id",
  "a.agency_id",
  "a.project_id",
  "a.package_version_id",
  "a.membership_id",
  "a.membership_version::text AS membership_version",
  "a.user_id",
  "a.version::text AS version",
  exact("a.issued_at"),
  exact("a.expires_at"),
  "floor(extract(epoch FROM (a.expires_at - a.issued_at)))::int AS lifetime_seconds",
  "a.sign_state",
].join(", ");

export class PgDownloadAuthorizationStore implements DownloadAuthorizationStore {
  constructor(private readonly db: Queryable) {}

  async findPackage(packageVersionId: PackageVersionId): Promise<DownloadPackageRow | null> {
    const r = await execute<Row>(this.db, "SELECT package_version_id, agency_id, project_id, state FROM kauro.package_versions WHERE package_version_id = $1", [packageVersionId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    return { packageVersionId: str<PackageVersionId>(row["package_version_id"]), agencyId: str<AgencyId>(row["agency_id"]), projectId: str<ProjectId>(row["project_id"]), state: str(row["state"]) };
  }

  async awaitProject(projectId: ProjectId): Promise<string | null> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.projects', $1::text)", [projectId]);
    const r = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.projects WHERE project_id = $1", [projectId]);
    return r.rows[0]?.state ?? null;
  }

  async awaitPackage(packageVersionId: PackageVersionId): Promise<string | null> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.package_versions', $1::text)", [packageVersionId]);
    const r = await execute<{ state: string }>(this.db, "SELECT state FROM kauro.package_versions WHERE package_version_id = $1", [packageVersionId]);
    return r.rows[0]?.state ?? null;
  }

  async lockGoverningRetention(packageVersionId: PackageVersionId): Promise<GoverningRetentionRow | null> {
    const r = await execute<Row>(
      this.db,
      `SELECT r.retention_id, r.state, ${exact("r.effective_deadline")} ${GOVERNING}
        ORDER BY (r.state = 'ACTIVE') DESC, r.effective_deadline DESC LIMIT 1 FOR SHARE OF r`,
      [packageVersionId],
    );
    const row = r.rows[0];
    return row === undefined ? null : retentionRow(row);
  }

  async artifactsOf(packageVersionId: PackageVersionId, artifactIds: ReadonlyArray<string>): Promise<ReadonlyArray<DownloadArtifactRow>> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${ARTIFACT_COLUMNS} FROM kauro.delivery_artifacts x
         JOIN kauro.stored_objects o ON o.agency_id = x.agency_id AND o.object_id = x.object_id AND o.generation = x.generation
        WHERE x.package_version_id = $1 AND x.object_id = ANY ($2::uuid[])`,
      [packageVersionId, [...artifactIds]],
    );
    return r.rows.map(artifactRow);
  }

  async effectInstant(): Promise<string> {
    const r = await execute<{ now: string }>(this.db, `SELECT ${EFFECT_NOW_EXACT} AS now`);
    const now = r.rows[0]?.now;
    if (typeof now !== "string") throw new DomainFailure("INTEGRITY_FAILURE", "the effect clock answered nothing");
    return now;
  }

  async issue(input: IssueDownloadInput): Promise<DownloadAuthorizationRow> {
    await execute(
      this.db,
      `INSERT INTO kauro.download_authorizations (authorization_id, agency_id, project_id, package_version_id, membership_id, membership_version, user_id, issued_at, expires_at, artifact_count)
       VALUES ($1, kauro.current_agency_id(), $2, $3, $4, $5, kauro.current_user_id(), $6::timestamptz, least($6::timestamptz + interval '900 seconds', $7::timestamptz), $8)`,
      [input.authorizationId, input.projectId, input.packageVersionId, input.membershipId, input.membershipVersion, input.issuedAt, input.deadline, input.artifacts.length],
    );
    for (const [ordinal, a] of input.artifacts.entries()) {
      await execute(
        this.db,
        `INSERT INTO kauro.download_authorization_artifacts (authorization_id, ordinal, agency_id, package_version_id, object_name, object_id, generation)
         VALUES ($1, $2, kauro.current_agency_id(), $3, $4, $5, $6)`,
        [input.authorizationId, ordinal, input.packageVersionId, a.objectName, a.artifactId, a.generation],
      );
    }
    const stored = await this.#authorization(input.authorizationId);
    if (stored === null) throw new DomainFailure("INTEGRITY_FAILURE", "the download authorization was not recorded");
    return stored;
  }

  async #authorization(authorizationId: string): Promise<DownloadAuthorizationRow | null> {
    const r = await execute<Row>(this.db, `SELECT ${AUTHORIZATION_COLUMNS} FROM kauro.download_authorizations a WHERE a.authorization_id = $1 AND a.user_id = kauro.current_user_id()`, [authorizationId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const artifacts = await execute<Row>(
      this.db,
      `SELECT ${ARTIFACT_COLUMNS} FROM kauro.download_authorization_artifacts g
         JOIN kauro.delivery_artifacts x ON x.package_version_id = g.package_version_id AND x.object_name = g.object_name
         JOIN kauro.stored_objects o ON o.agency_id = g.agency_id AND o.object_id = g.object_id AND o.generation = g.generation
        WHERE g.authorization_id = $1 ORDER BY g.ordinal`,
      [authorizationId],
    );
    return {
      authorizationId: str(row["authorization_id"]),
      agencyId: str<AgencyId>(row["agency_id"]),
      projectId: str<ProjectId>(row["project_id"]),
      packageVersionId: str<PackageVersionId>(row["package_version_id"]),
      membershipId: str<MembershipId>(row["membership_id"]),
      membershipVersion: int(row["membership_version"]),
      userId: str<UserId>(row["user_id"]),
      version: int(row["version"]),
      issuedAt: instantText(row["issued_at"]),
      expiresAt: instantText(row["expires_at"]),
      lifetimeSeconds: int(row["lifetime_seconds"]),
      signState: str<DownloadSignState>(row["sign_state"]),
      artifacts: artifacts.rows.map(artifactRow),
    };
  }

  async recheck(authorizationId: string): Promise<DownloadRecheck | null> {
    const authorization = await this.#authorization(authorizationId);
    if (authorization === null) return null;
    const states = await execute<{ package_state: string; project_state: string }>(
      this.db,
      `SELECT p.state AS package_state, pr.state AS project_state FROM kauro.package_versions p
         JOIN kauro.projects pr ON pr.agency_id = p.agency_id AND pr.project_id = p.project_id WHERE p.package_version_id = $1`,
      [authorization.packageVersionId],
    );
    const s = states.rows[0];
    if (s === undefined) return null;
    const retention = await execute<Row>(
      this.db,
      `SELECT r.retention_id, r.state, ${exact("r.effective_deadline")} ${GOVERNING} ORDER BY (r.state = 'ACTIVE') DESC, r.effective_deadline DESC LIMIT 1`,
      [authorization.packageVersionId],
    );
    const row = retention.rows[0];
    return { authorization, packageState: s.package_state, projectState: s.project_state, retention: row === undefined ? null : retentionRow(row), now: await this.effectInstant() };
  }

  async recordSigning(authorizationId: string, state: "SIGNED" | "ISSUE_UNCERTAIN"): Promise<void> {
    await execute(
      this.db,
      `UPDATE kauro.download_authorizations SET sign_state = $2 WHERE authorization_id = $1 AND user_id = kauro.current_user_id()
          AND (sign_state = 'PENDING' OR (sign_state = 'ISSUE_UNCERTAIN' AND $2 = 'SIGNED'))`,
      [authorizationId, state],
    );
  }
}
