/**
 * The sealed manifest and its file set, and the first seal of reused bytes, over `pg` (B07; migration 0011; decisions D-SEAL-1,
 * D-HASH-1, D-HASH-4, D-RET-3).
 *
 * A sealed manifest and file set are the record of the seal that writes them: sealed at the server's transaction time and bound at
 * COMMIT to the revision entering SEALED at exactly that instant in the same unit of work (KA072 otherwise). `firstSeals` counts
 * only real seals (kauro.is_real_seal), so a row no seal recorded can never move the bytes' fourteen-day clock.
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  type AgencyId,
  type ProjectId,
  type RetentionAnchorId,
  type RevisionId,
  type SealedFileEntry,
  type SealedManifestRecord,
  type SealedManifestRepository,
  type SealedSubjectDocument,
  type SourceFileId,
  type SourceRevisionManifest,
} from "@kauro/domain";
import { execute, type Queryable } from "../sql.js";
import { exact, instantText, jsonObject, one, str } from "./rows.js";

type Row = Record<string, unknown>;

const SEAL_COLUMNS = `revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, manifest, subject, ${exact("sealed_at")}`;

function sealRecord(r: Row): SealedManifestRecord {
  return {
    revisionId: str<RevisionId>(r["revision_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    manifestHash: str<Sha256Hex>(r["manifest_hash"]),
    projectionHash: str<Sha256Hex>(r["projection_hash"]),
    selectionHash: str<Sha256Hex>(r["selection_hash"]),
    evaluationHash: str<Sha256Hex>(r["evaluation_hash"]),
    subjectHash: str<Sha256Hex>(r["subject_hash"]),
    manifest: jsonObject<SourceRevisionManifest>(r["manifest"]),
    subject: jsonObject<SealedSubjectDocument>(r["subject"]),
    sealedAt: instantText(r["sealed_at"]),
  };
}

export class PgSealedManifestRepository implements SealedManifestRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * The manifest (HASHING's KAURO_SOURCE_REVISION_V1 preimage) and the sealed subject, sealed at the server's transaction time, and
   * the file set: every file the selection disposed, an included one at the exact generation, digest and length of an admitted file
   * of the project, read after the file's transition lock (sealed_revision_files_admitted). The same unit of work takes
   * seal_command at this very instant, or nothing commits.
   */
  async insert(manifest: Omit<SealedManifestRecord, "sealedAt">, files: ReadonlyArray<SealedFileEntry>): Promise<SealedManifestRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.sealed_manifests (revision_id, agency_id, project_id, manifest_hash, projection_hash, selection_hash, evaluation_hash, subject_hash, canonical_version, manifest, subject, sealed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, kauro.server_now()) RETURNING ${SEAL_COLUMNS}`,
      [
        manifest.revisionId,
        manifest.agencyId,
        manifest.projectId,
        manifest.manifestHash,
        manifest.projectionHash,
        manifest.selectionHash,
        manifest.evaluationHash,
        manifest.subjectHash,
        manifest.subject.canonicalVersion,
        JSON.stringify(manifest.manifest),
        JSON.stringify(manifest.subject),
      ],
    );
    const sealed = sealRecord(one(r.rows, "sealed manifest insert"));
    for (const f of files) {
      await execute(
        this.db,
        `INSERT INTO kauro.sealed_revision_files (revision_id, file_id, agency_id, project_id, ordinal, disposition, exclusion_reason, provider_generation, sha256, bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [manifest.revisionId, f.fileId, manifest.agencyId, manifest.projectId, f.ordinal, f.disposition, f.exclusionReason ?? null, f.providerGeneration, f.sha256, f.bytes],
      );
    }
    return sealed;
  }

  async get(revisionId: RevisionId): Promise<SealedManifestRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${SEAL_COLUMNS} FROM kauro.sealed_manifests WHERE revision_id = $1`, [revisionId]);
    return r.rows[0] ? sealRecord(r.rows[0]) : null;
  }

  /**
   * For each file some real seal included, that earliest seal (ties broken by revision id) and its REVISION_SEALED anchor (D-RET-3);
   * a file no real seal ever included is absent (its first seal is the one being taken). Exact instants: the caller compares the
   * bytes' hard cap with the server clock.
   */
  async firstSeals(fileIds: ReadonlyArray<SourceFileId>): Promise<ReadonlyArray<{ readonly fileId: SourceFileId; readonly revisionId: RevisionId; readonly sealedAt: string; readonly anchorId: RetentionAnchorId }>> {
    if (fileIds.length === 0) return [];
    const r = await execute<Row>(
      this.db,
      `SELECT DISTINCT ON (s.file_id) s.file_id, s.revision_id, ${exact("m.sealed_at")}, a.anchor_id
         FROM kauro.sealed_revision_files s
         JOIN kauro.sealed_manifests m ON m.agency_id = s.agency_id AND m.revision_id = s.revision_id
         JOIN kauro.retention_anchors a ON a.agency_id = s.agency_id AND a.revision_id = s.revision_id AND a.anchor_kind = 'REVISION_SEALED' AND a.upload_id IS NULL
        WHERE s.file_id = ANY($1::uuid[]) AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id)
        ORDER BY s.file_id, m.sealed_at, s.revision_id`,
      [[...fileIds]],
    );
    return r.rows.map((x) => ({
      fileId: str<SourceFileId>(x["file_id"]),
      revisionId: str<RevisionId>(x["revision_id"]),
      sealedAt: instantText(x["sealed_at"]),
      anchorId: str<RetentionAnchorId>(x["anchor_id"]),
    }));
  }
}
