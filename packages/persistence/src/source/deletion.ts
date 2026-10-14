/**
 * The managed deletion of a project over `pg` (B16 lane L3; migration 0071; docs/design/B16-L3-failure-matrix.md). CMD042's half runs
 * as the request handlers' role (kauro_app) and the DELETION_EXECUTOR's half as the control plane (kauro_control); the database owns
 * the evidence rules: the step-up re-judged at COMMIT (KC020), a retention record DELETING only with the request of this transaction
 * and closed only with the completed deletion of this one (KA088), a COMPLETE receipt only while every managed object is DELETED
 * (KA088), and nothing new entering a deleting project (KA087).
 */
import {
  DomainFailure,
  type AgencyId,
  type DeletionDerivedRows,
  type DeletionId,
  type DeletionPackageRef,
  type DeletionReceiptBody,
  type DeletionReceiptId,
  type DeletionRecordRef,
  type DeletionRepository,
  type DeletionRequestRow,
  type DeletionRequestState,
  type DeletionScope,
  type MembershipId,
  type ProjectId,
  type RetentionId,
  type RevisionId,
  type SourceRevisionRecord,
  type StoredObjectId,
  type StoredObjectRecord,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { OBJECT_COLUMNS, objectRecord } from "./objects.js";
import { REVISION_COLUMNS, revisionRecord } from "./revisions.js";
import { exact, instantText, opt, optionalInstantText, str } from "./rows.js";

type Row = Record<string, unknown>;

const REQUEST_COLUMNS = `deletion_id, agency_id, project_id, state, reason_code, requested_by_membership_id, assurance_proof_ref::text AS assurance_proof_ref, ${exact("requested_at")}, ${exact("completed_at")}`;

/** The zones whose copies are lawful residuals of a deletion (09: financial and security records outlive it, named in the receipt). */
const RESIDUAL_ZONES = "('LEGAL_FINANCE', 'SECURITY')";

function requestRow(r: Row): DeletionRequestRow {
  return {
    deletionId: str<DeletionId>(r["deletion_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    state: str<DeletionRequestState>(r["state"]),
    reasonCode: str(r["reason_code"]),
    requestedByMembershipId: str<MembershipId>(r["requested_by_membership_id"]),
    assuranceProofRef: str(r["assurance_proof_ref"]),
    requestedAt: instantText(r["requested_at"]),
    ...opt("completedAt", optionalInstantText(r["completed_at"])),
  };
}

const recordRef = (r: Row): DeletionRecordRef => ({ retentionId: str<RetentionId>(r["retention_id"]), state: str(r["state"]), version: int(r["version"]) });
const packageRef = (r: Row): DeletionPackageRef => ({ packageVersionId: str(r["package_version_id"]), jobId: str(r["job_id"]), state: str(r["state"]), version: int(r["version"]) });

export class PgDeletionRepository implements DeletionRepository {
  constructor(private readonly db: Queryable) {}

  async insertRequest(input: { readonly deletionId: DeletionId; readonly projectId: ProjectId; readonly reasonCode: string; readonly membershipId: MembershipId; readonly assuranceProofRef: string }): Promise<DeletionRequestRow> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.deletion_requests (deletion_id, agency_id, project_id, reason_code, requested_by_membership_id, requested_by_user_id, assurance_proof_ref)
       VALUES ($1, kauro.current_agency_id(), $2, $3, $4, kauro.current_user_id(), $5) RETURNING ${REQUEST_COLUMNS}`,
      [input.deletionId, input.projectId, input.reasonCode, input.membershipId, input.assuranceProofRef],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "the deletion request was not written");
    return requestRow(row);
  }

  async lockRecordsOfProject(projectId: ProjectId): Promise<ReadonlyArray<DeletionRecordRef>> {
    const r = await execute<Row>(this.db, "SELECT retention_id, state, version::text AS version FROM kauro.retention_records WHERE project_id = $1 ORDER BY retention_id FOR NO KEY UPDATE", [projectId]);
    return r.rows.map(recordRef);
  }

  async moveRecordToDeleting(retentionId: RetentionId, expectedVersion: number): Promise<DeletionRecordRef | null> {
    const r = await execute<Row>(
      this.db,
      "UPDATE kauro.retention_records SET state = 'DELETING', version = $2 + 1 WHERE retention_id = $1 AND version = $2 AND state IN ('ACTIVE', 'EXPIRED') RETURNING retention_id, state, version::text AS version",
      [retentionId, expectedVersion],
    );
    return r.rows[0] ? recordRef(r.rows[0]) : null;
  }

  async scopeOf(projectId: ProjectId): Promise<DeletionScope> {
    const ids = async (sql: string): Promise<ReadonlyArray<string>> => (await execute<{ id: string }>(this.db, sql, [projectId])).rows.map((x) => x.id);
    return {
      revisionIds: await ids("SELECT revision_id::text AS id FROM kauro.dataset_revisions WHERE project_id = $1 ORDER BY revision_id"),
      retentionIds: await ids("SELECT retention_id::text AS id FROM kauro.retention_records WHERE project_id = $1 ORDER BY retention_id"),
      packageVersionIds: await ids("SELECT package_version_id::text AS id FROM kauro.package_versions WHERE project_id = $1 ORDER BY package_version_id"),
    };
  }

  async forProject(projectId: ProjectId): Promise<DeletionRequestRow | null> {
    const r = await execute<Row>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.deletion_requests WHERE project_id = $1`, [projectId]);
    return r.rows[0] ? requestRow(r.rows[0]) : null;
  }

  async lock(deletionId: DeletionId): Promise<DeletionRequestRow | null> {
    const r = await execute<Row>(this.db, `SELECT ${REQUEST_COLUMNS} FROM kauro.deletion_requests WHERE deletion_id = $1 FOR UPDATE`, [deletionId]);
    return r.rows[0] ? requestRow(r.rows[0]) : null;
  }

  async advance(deletionId: DeletionId, from: ReadonlyArray<DeletionRequestState>, to: DeletionRequestState): Promise<DeletionRequestRow | null> {
    const r = await execute<Row>(this.db, `UPDATE kauro.deletion_requests SET state = $3 WHERE deletion_id = $1 AND state = ANY($2::text[]) RETURNING ${REQUEST_COLUMNS}`, [deletionId, [...from], to]);
    return r.rows[0] ? requestRow(r.rows[0]) : null;
  }

  async managedObjects(projectId: ProjectId): Promise<ReadonlyArray<StoredObjectRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${OBJECT_COLUMNS} FROM kauro.stored_objects WHERE project_id = $1 AND zone NOT IN ${RESIDUAL_ZONES} ORDER BY object_id`, [projectId]);
    return r.rows.map(objectRecord);
  }

  async retainedObjects(projectId: ProjectId): Promise<ReadonlyArray<StoredObjectRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${OBJECT_COLUMNS} FROM kauro.stored_objects WHERE project_id = $1 AND zone IN ${RESIDUAL_ZONES} ORDER BY object_id`, [projectId]);
    return r.rows.map(objectRecord);
  }

  async requestManagedDeletion(objectIds: ReadonlyArray<StoredObjectId>, reason: string): Promise<number> {
    if (objectIds.length === 0) return 0;
    const r = await execute(
      this.db,
      `UPDATE kauro.stored_objects SET state = 'DELETION_REQUESTED', deletion_requested_at = kauro.server_now(), deletion_reason = $2
        WHERE object_id = ANY($1::uuid[]) AND state IN ('INTENDED', 'PRESENT', 'VERIFIED') AND zone NOT IN ${RESIDUAL_ZONES}`,
      [[...objectIds], reason],
    );
    return r.rowCount ?? 0;
  }

  async derivedOf(projectId: ProjectId): Promise<DeletionDerivedRows> {
    const audits = await execute<Row>(this.db, "SELECT audit_id, revision_id, grant_id, state FROM kauro.audits WHERE project_id = $1 ORDER BY audit_id", [projectId]);
    const tasks = await execute<{ id: string }>(
      this.db,
      "SELECT m.model_task_id::text AS id FROM kauro.model_tasks m JOIN kauro.audits a ON a.agency_id = m.agency_id AND a.audit_id = m.audit_id WHERE a.project_id = $1 ORDER BY m.model_task_id",
      [projectId],
    );
    return {
      audits: audits.rows.map((a) => ({ auditId: str(a["audit_id"]), revisionId: str(a["revision_id"]), grantId: str(a["grant_id"]), state: str(a["state"]) })),
      modelTaskIds: tasks.rows.map((t) => t.id),
    };
  }

  async lockRevisionsOfProject(projectId: ProjectId): Promise<ReadonlyArray<SourceRevisionRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${REVISION_COLUMNS} FROM kauro.dataset_revisions WHERE project_id = $1 ORDER BY revision_id FOR NO KEY UPDATE`, [projectId]);
    return r.rows.map(revisionRecord);
  }

  async lockPackagesOfProject(projectId: ProjectId): Promise<ReadonlyArray<DeletionPackageRef>> {
    const r = await execute<Row>(this.db, "SELECT package_version_id, job_id, state, version::text AS version FROM kauro.package_versions WHERE project_id = $1 ORDER BY package_version_id FOR NO KEY UPDATE", [projectId]);
    return r.rows.map(packageRef);
  }

  async movePackage(packageVersionId: string, expectedVersion: number, to: "REVOKED" | "DELETED", reason: string): Promise<DeletionPackageRef | null> {
    const r = await execute<Row>(
      this.db,
      to === "REVOKED"
        ? "UPDATE kauro.package_versions SET state = 'REVOKED', revocation_reason = $3, version = $2 + 1 WHERE package_version_id = $1 AND version = $2 RETURNING package_version_id, job_id, state, version::text AS version"
        : "UPDATE kauro.package_versions SET state = 'DELETED', version = $2 + 1 WHERE package_version_id = $1 AND version = $2 RETURNING package_version_id, job_id, state, version::text AS version",
      to === "REVOKED" ? [packageVersionId, expectedVersion, reason] : [packageVersionId, expectedVersion],
    );
    return r.rows[0] ? packageRef(r.rows[0]) : null;
  }

  async closeRecord(retentionId: RetentionId, expectedVersion: number, withResiduals: boolean): Promise<DeletionRecordRef | null> {
    const r = await execute<Row>(
      this.db,
      "UPDATE kauro.retention_records SET state = $3, version = $2 + 1 WHERE retention_id = $1 AND version = $2 AND state = 'DELETING' RETURNING retention_id, state, version::text AS version",
      [retentionId, expectedVersion, withResiduals ? "DELETED_WITH_RESIDUALS" : "DELETED"],
    );
    return r.rows[0] ? recordRef(r.rows[0]) : null;
  }

  async markProjectDeleted(projectId: ProjectId, expectedVersion: number): Promise<{ readonly version: number } | null> {
    const r = await execute<Row>(this.db, "UPDATE kauro.projects SET state = 'DELETED', version = $2 + 1 WHERE project_id = $1 AND version = $2 AND state = 'DELETION_REQUESTED' RETURNING version::text AS version", [projectId, expectedVersion]);
    return r.rows[0] ? { version: int(r.rows[0]["version"]) } : null;
  }

  async projectState(projectId: ProjectId, lock = false): Promise<{ readonly state: string; readonly version: number; readonly currentRevisionId: RevisionId } | null> {
    const r = await execute<Row>(this.db, `SELECT state, version::text AS version, current_revision_id FROM kauro.projects WHERE project_id = $1${lock ? " FOR NO KEY UPDATE" : ""}`, [projectId]);
    return r.rows[0] ? { state: str(r.rows[0]["state"]), version: int(r.rows[0]["version"]), currentRevisionId: str<RevisionId>(r.rows[0]["current_revision_id"]) } : null;
  }

  async appendReceipt(input: { readonly receiptId: DeletionReceiptId; readonly deletionId: DeletionId; readonly projectId: ProjectId; readonly status: "PARTIAL" | "COMPLETE_FOR_MANAGED_SCOPE"; readonly body: DeletionReceiptBody }): Promise<void> {
    await execute(
      this.db,
      "INSERT INTO kauro.deletion_receipts (receipt_id, deletion_id, agency_id, project_id, status, body) VALUES ($1, $2, kauro.current_agency_id(), $3, $4, $5::jsonb)",
      [input.receiptId, input.deletionId, input.projectId, input.status, JSON.stringify(input.body)],
    );
  }
}
