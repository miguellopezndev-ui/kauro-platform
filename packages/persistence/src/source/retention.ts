/**
 * Retention anchors and retention records over `pg` (B07; migration 0012; decisions D-ANCH-1, D-ANCH-2, D-RET-2, D-RET-3,
 * D-CLOCK-1, D-EXP-1).
 *
 * An anchor records the server's transaction time and its KAURO_RETENTION_ANCHOR_V1 digest over exactly that instant; the database
 * binds it at COMMIT to the transition it records, once per subject and kind (a retry returns the stored anchor and never moves
 * it), and admits each kind only to its producer. The UNPAID record of a seal is anchored on the first seal of its bytes with the
 * hard deadline computed in SQL from that anchor (+ 1,209,600 s, D-RET-3); it expires at the server's transaction time and never
 * before its effective deadline (retention_records_expiry_not_early, typed LIFECYCLE_BINDING_MISSING).
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  retentionAnchorHashOf,
  type AgencyId,
  type ClientId,
  type NewRetentionAnchor,
  type ProjectId,
  type RetentionAnchorId,
  type RetentionAnchorKind,
  type RetentionAnchorRecord,
  type RetentionId,
  type RetentionRecordRow,
  type RetentionRepository,
  type RevisionId,
  type UploadId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { exact, instantText, jsonArray, missedWrite, notAvailable, one, opt, optionalInstantText, optionalString, pageLimit, serverInstantOf, str } from "./rows.js";

type Row = Record<string, unknown>;

const ANCHOR_COLUMNS = `anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, ${exact("occurred_at")}, evidence_hash`;

function anchorRecord(r: Row): RetentionAnchorRecord {
  return {
    anchorId: str<RetentionAnchorId>(r["anchor_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    ...opt("uploadId", optionalString<UploadId>(r["upload_id"])),
    kind: str<RetentionAnchorKind>(r["anchor_kind"]),
    occurredAt: instantText(r["occurred_at"]),
    evidenceHash: str<Sha256Hex>(r["evidence_hash"]),
  };
}

const RECORD_COLUMNS = [
  "retention_id",
  "agency_id",
  "client_id",
  "project_id",
  "revision_id",
  "version::text AS version",
  "class",
  "anchor_id",
  "anchor_evidence_hash",
  exact("soft_deadline"),
  exact("hard_deadline"),
  exact("effective_deadline"),
  "policy_version",
  "provider_residuals",
  "state",
  exact("expired_at"),
].join(", ");

function retentionRecord(r: Row): RetentionRecordRow {
  return {
    retentionId: str<RetentionId>(r["retention_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    clientId: str<ClientId>(r["client_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    ...opt("revisionId", optionalString<RevisionId>(r["revision_id"])),
    anchorId: str<RetentionAnchorId>(r["anchor_id"]),
    version: int(r["version"]),
    class: str<RetentionRecordRow["class"]>(r["class"]),
    anchorEvidenceHash: str<Sha256Hex>(r["anchor_evidence_hash"]),
    ...opt("softDeadline", optionalInstantText(r["soft_deadline"])),
    hardDeadline: instantText(r["hard_deadline"]),
    effectiveDeadline: instantText(r["effective_deadline"]),
    policyVersion: str(r["policy_version"]),
    providerResiduals: [...jsonArray<string>(r["provider_residuals"])],
    state: str<RetentionRecordRow["state"]>(r["state"]),
    ...opt("expiredAt", optionalInstantText(r["expired_at"])),
  };
}

export class PgRetentionRepository implements RetentionRepository {
  constructor(private readonly db: Queryable) {}

  async appendAnchor(anchor: NewRetentionAnchor): Promise<RetentionAnchorRecord> {
    // the digest covers the exact instant the row records: this transaction's server clock, read on the same connection
    const occurredAt = await serverInstantOf(this.db);
    const uploadId = anchor.uploadId ?? null;
    const evidenceHash = retentionAnchorHashOf({
      kind: anchor.kind,
      agencyId: anchor.agencyId,
      projectId: anchor.projectId,
      revisionId: anchor.revisionId,
      uploadId,
      occurredAt,
      sourceEvidenceHash: anchor.sourceEvidenceHash,
    });
    const conflict = uploadId === null ? "(revision_id, anchor_kind) WHERE upload_id IS NULL" : "(upload_id, anchor_kind) WHERE upload_id IS NOT NULL";
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.retention_anchors (anchor_id, agency_id, project_id, revision_id, upload_id, anchor_kind, occurred_at, evidence_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), $7, kauro.server_now())
       ON CONFLICT ${conflict} DO NOTHING RETURNING ${ANCHOR_COLUMNS}`,
      [anchor.anchorId, anchor.agencyId, anchor.projectId, anchor.revisionId, uploadId, anchor.kind, evidenceHash],
    );
    const inserted = r.rows[0];
    if (inserted) {
      const record = anchorRecord(inserted);
      if (record.occurredAt !== occurredAt) throw new DomainFailure("INTEGRITY_FAILURE", "the anchor's instant is not the instant its digest covers");
      return record;
    }
    // one anchor of a kind per subject: a retry, a second report or a replay returns the stored anchor, never a later one
    const stored = await execute<Row>(
      this.db,
      uploadId === null
        ? `SELECT ${ANCHOR_COLUMNS} FROM kauro.retention_anchors WHERE revision_id = $1 AND anchor_kind = $2 AND upload_id IS NULL`
        : `SELECT ${ANCHOR_COLUMNS} FROM kauro.retention_anchors WHERE upload_id = $1 AND anchor_kind = $2`,
      [uploadId ?? anchor.revisionId, anchor.kind],
    );
    return anchorRecord(one(stored.rows, "stored retention anchor"));
  }

  async anchorsOf(revisionId: RevisionId): Promise<ReadonlyArray<RetentionAnchorRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${ANCHOR_COLUMNS} FROM kauro.retention_anchors WHERE revision_id = $1 ORDER BY occurred_at, anchor_id`, [revisionId]);
    return r.rows.map(anchorRecord);
  }

  /**
   * The UNPAID record of the seal in this unit of work, at version 1: anchored on `anchorId` — the REVISION_SEALED anchor of the
   * first seal of the bytes (SealedManifestRepository.firstSeals, or this seal's own for new bytes) — with its evidence hash, hard =
   * effective deadline = that anchor's instant + 1,209,600 s, computed in SQL; no soft deadline. The caller publishes
   * retention_record.created.v1; the database checks the whole binding at COMMIT (dataset_revisions_sealed_subject).
   */
  async insertUnpaidRecord(record: { readonly retentionId: RetentionId; readonly agencyId: AgencyId; readonly clientId: ClientId; readonly projectId: ProjectId; readonly revisionId: RevisionId; readonly anchorId: RetentionAnchorId; readonly policyVersion: string }): Promise<RetentionRecordRow> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.retention_records (retention_id, agency_id, client_id, project_id, revision_id, version, class, anchor_id, anchor_evidence_hash, soft_deadline, hard_deadline,
          effective_deadline, policy_version, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, 1, 'UNPAID', a.anchor_id, a.evidence_hash, NULL, a.occurred_at + interval '1209600 seconds', a.occurred_at + interval '1209600 seconds', $7,
              kauro.server_now(), kauro.server_now()
         FROM kauro.retention_anchors a WHERE a.agency_id = $2 AND a.anchor_id = $6 AND a.anchor_kind = 'REVISION_SEALED'
       RETURNING ${RECORD_COLUMNS}`,
      [record.retentionId, record.agencyId, record.clientId, record.projectId, record.revisionId, record.anchorId, record.policyVersion],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INVALID_REQUEST", "the UNPAID record is anchored on a REVISION_SEALED anchor of this agency", { reason: "UNKNOWN_REFERENCE" });
    return retentionRecord(row);
  }

  async recordFor(revisionId: RevisionId, retentionClass: RetentionRecordRow["class"]): Promise<RetentionRecordRow | null> {
    const r = await execute<Row>(this.db, `SELECT ${RECORD_COLUMNS} FROM kauro.retention_records WHERE revision_id = $1 AND class = $2`, [revisionId, retentionClass]);
    return r.rows[0] ? retentionRecord(r.rows[0]) : null;
  }

  async recordsFor(revisionId: RevisionId): Promise<ReadonlyArray<RetentionRecordRow>> {
    const r = await execute<Row>(this.db, `SELECT ${RECORD_COLUMNS} FROM kauro.retention_records WHERE revision_id = $1 ORDER BY created_at, retention_id`, [revisionId]);
    return r.rows.map(retentionRecord);
  }

  async expireRecord(retentionId: RetentionId, expectedVersion: number): Promise<VersionedWrite<RetentionRecordRow>> {
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.retention_records SET state = 'EXPIRED', expired_at = kauro.server_now(), version = $2 + 1 WHERE retention_id = $1 AND version = $2 RETURNING ${RECORD_COLUMNS}`,
      [retentionId, expectedVersion],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: retentionRecord(row) };
    return missedWrite(this.db, "retention_records", "retention_id", retentionId, expectedVersion, "retention record", ({ state }) => notAvailable("the retention record", state));
  }

  async findDue(limit: number): Promise<ReadonlyArray<{ readonly retentionId: RetentionId; readonly agencyId: AgencyId; readonly revisionId?: RevisionId }>> {
    const r = await execute<{ retention_id: string; agency_id: string; revision_id: string | null }>(
      this.db,
      "SELECT retention_id, agency_id, revision_id FROM kauro.retention_records WHERE state = 'ACTIVE' AND effective_deadline <= kauro.server_now() ORDER BY effective_deadline, retention_id LIMIT $1",
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ retentionId: x.retention_id as RetentionId, agencyId: x.agency_id as AgencyId, ...opt("revisionId", x.revision_id as RevisionId | null) }));
  }
}
