/**
 * Selection manifests (the agency's closed selection document, content-idempotent intake; D-SEL-1, D-SEL-2) and selection
 * evaluations (the control plane's counting pass) over `pg` (B07; migration 0011). Both are append-only.
 *
 * `put` stores a manifest once per (revision, body hash): the same body again answers the stored record with created = false,
 * whoever sent it and whatever id it minted. The body hash is the KAURO_SOURCE_SELECTION_V1 digest of the body; the adapter
 * recomputes it (the database cannot) and refuses a manifest whose claimed hash is not its body's, so a stored hash always names
 * its document. The manifest is recorded at the server's transaction time.
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  selectionHashOf,
  type AgencyId,
  type EvaluatedFile,
  type EvaluatedProjection,
  type EvaluatedTable,
  type EvaluationFailure,
  type EvaluationId,
  type MembershipId,
  type ProjectId,
  type RevisionId,
  type SelectionEvaluationRecord,
  type SelectionEvaluationRepository,
  type SelectionManifestDocument,
  type SelectionManifestId,
  type SelectionManifestRecord,
  type SelectionManifestRepository,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { exact, instantText, jsonArray, jsonObject, one, opt, optionalInt, str } from "./rows.js";

type Row = Record<string, unknown>;

const MANIFEST_COLUMNS = `selection_manifest_id, agency_id, project_id, revision_id, body, body_hash, created_by_membership_id, ${exact("created_at")}`;

function manifestRecord(r: Row): SelectionManifestRecord {
  return {
    selectionManifestId: str<SelectionManifestId>(r["selection_manifest_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    body: jsonObject<SelectionManifestDocument>(r["body"]),
    bodyHash: str<Sha256Hex>(r["body_hash"]),
    createdByMembershipId: str<MembershipId>(r["created_by_membership_id"]),
    createdAt: instantText(r["created_at"]),
  };
}

export class PgSelectionManifestRepository implements SelectionManifestRepository {
  constructor(private readonly db: Queryable) {}

  async put(manifest: Omit<SelectionManifestRecord, "body"> & { readonly body: SelectionManifestDocument }): Promise<{ readonly record: SelectionManifestRecord; readonly created: boolean }> {
    if (selectionHashOf(manifest.body) !== manifest.bodyHash) {
      throw new DomainFailure("INTEGRITY_FAILURE", "a selection manifest is stored under the KAURO_SOURCE_SELECTION_V1 digest of its own body", { reason: "HASH_MISMATCH" });
    }
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.selection_manifests (selection_manifest_id, agency_id, project_id, revision_id, schema_version, body, body_hash, created_by_membership_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, kauro.server_now())
       ON CONFLICT (agency_id, revision_id, body_hash) DO NOTHING RETURNING ${MANIFEST_COLUMNS}`,
      [manifest.selectionManifestId, manifest.agencyId, manifest.projectId, manifest.revisionId, manifest.body.schemaVersion, JSON.stringify(manifest.body), manifest.bodyHash, manifest.createdByMembershipId],
    );
    const inserted = r.rows[0];
    if (inserted) return { record: manifestRecord(inserted), created: true };
    // the same body was stored before (or by a concurrent intake that committed first): answer that manifest
    const stored = await execute<Row>(this.db, `SELECT ${MANIFEST_COLUMNS} FROM kauro.selection_manifests WHERE agency_id = $1 AND revision_id = $2 AND body_hash = $3`, [
      manifest.agencyId,
      manifest.revisionId,
      manifest.bodyHash,
    ]);
    return { record: manifestRecord(one(stored.rows, "stored selection manifest")), created: false };
  }

  async get(revisionId: RevisionId, selectionManifestId: SelectionManifestId): Promise<SelectionManifestRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${MANIFEST_COLUMNS} FROM kauro.selection_manifests WHERE revision_id = $1 AND selection_manifest_id = $2`, [revisionId, selectionManifestId]);
    return r.rows[0] ? manifestRecord(r.rows[0]) : null;
  }
}

const EVALUATION_COLUMNS = [
  "evaluation_id",
  "agency_id",
  "revision_id",
  "selection_manifest_id",
  "selection_hash",
  "evaluation_hash",
  "result",
  "physical_source_rows::text AS physical_source_rows",
  "logical_source_records::text AS logical_source_records",
  "billable_source_units::text AS billable_source_units",
  "association_edges::text AS association_edges",
  "file_count",
  "total_bytes::text AS total_bytes",
  "files",
  "tables",
  "projections",
  "failures",
  "pricing_definition",
  "evaluator_version",
  exact("started_at"),
  exact("completed_at"),
].join(", ");

function evaluationRecord(r: Row): SelectionEvaluationRecord {
  const physical = optionalInt(r["physical_source_rows"]);
  return {
    evaluationId: str<EvaluationId>(r["evaluation_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    selectionManifestId: str<SelectionManifestId>(r["selection_manifest_id"]),
    selectionHash: str<Sha256Hex>(r["selection_hash"]),
    evaluationHash: str<Sha256Hex>(r["evaluation_hash"]),
    result: str<SelectionEvaluationRecord["result"]>(r["result"]),
    ...opt(
      "populations",
      physical === undefined
        ? undefined
        : {
            physicalSourceRows: physical,
            logicalSourceRecords: int(r["logical_source_records"]),
            billableSourceUnits: int(r["billable_source_units"]),
            associationEdges: int(r["association_edges"]),
          },
    ),
    ...opt("fileCount", optionalInt(r["file_count"])),
    ...opt("totalBytes", optionalInt(r["total_bytes"])),
    files: jsonArray<EvaluatedFile>(r["files"]),
    tables: jsonArray<EvaluatedTable>(r["tables"]),
    projections: jsonArray<EvaluatedProjection>(r["projections"]),
    failures: jsonArray<EvaluationFailure>(r["failures"]),
    pricingDefinition: str(r["pricing_definition"]),
    evaluatorVersion: str(r["evaluator_version"]),
    startedAt: instantText(r["started_at"]),
    completedAt: instantText(r["completed_at"]),
  };
}

export class PgSelectionEvaluationRepository implements SelectionEvaluationRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Appended by the control plane and recorded at the server's transaction time; the pass's own start and completion are the
   * instants the evaluator read from the database clock around its work (outside any transaction).
   */
  async append(evaluation: SelectionEvaluationRecord): Promise<void> {
    const p = evaluation.populations;
    await execute(
      this.db,
      `INSERT INTO kauro.selection_evaluations (evaluation_id, agency_id, revision_id, selection_manifest_id, selection_hash, evaluation_hash, result, physical_source_rows, logical_source_records,
          billable_source_units, association_edges, file_count, total_bytes, files, tables, projections, failures, pricing_definition, evaluator_version, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20::timestamptz, $21::timestamptz, kauro.server_now())`,
      [
        evaluation.evaluationId,
        evaluation.agencyId,
        evaluation.revisionId,
        evaluation.selectionManifestId,
        evaluation.selectionHash,
        evaluation.evaluationHash,
        evaluation.result,
        p?.physicalSourceRows ?? null,
        p?.logicalSourceRecords ?? null,
        p?.billableSourceUnits ?? null,
        p?.associationEdges ?? null,
        evaluation.fileCount ?? null,
        evaluation.totalBytes ?? null,
        JSON.stringify(evaluation.files),
        JSON.stringify(evaluation.tables),
        JSON.stringify(evaluation.projections),
        JSON.stringify(evaluation.failures),
        evaluation.pricingDefinition,
        evaluation.evaluatorVersion,
        evaluation.startedAt,
        evaluation.completedAt,
      ],
    );
  }

  async get(evaluationId: EvaluationId): Promise<SelectionEvaluationRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${EVALUATION_COLUMNS} FROM kauro.selection_evaluations WHERE evaluation_id = $1`, [evaluationId]);
    return r.rows[0] ? evaluationRecord(r.rows[0]) : null;
  }

  async latestFor(revisionId: RevisionId, selectionHash: Sha256Hex): Promise<SelectionEvaluationRecord | null> {
    const r = await execute<Row>(
      this.db,
      `SELECT ${EVALUATION_COLUMNS} FROM kauro.selection_evaluations WHERE revision_id = $1 AND selection_hash = $2 ORDER BY created_at DESC, evaluation_id DESC LIMIT 1`,
      [revisionId, selectionHash],
    );
    return r.rows[0] ? evaluationRecord(r.rows[0]) : null;
  }
}
