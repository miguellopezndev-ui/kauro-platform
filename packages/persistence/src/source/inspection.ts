/**
 * Inspection receipts, admitted source files (the SourceFile aggregate) and their frozen table inventory over `pg` (B07; migration
 * 0010; decisions D-INSP-2, D-INSP-4, D-FILE-1, D-FILE-2, D-SEL-4, D-SEAL-1, D-CLOCK-1).
 *
 * A receipt is accepted only from the current attempt of a VERIFYING upload and only if it describes the recorded observation
 * (KA071, KA072); its recording stamp is kauro.server_now(), and its attempt instants — the start (the claim the database stamped),
 * the scan and the completion, which the worker read from the database clock — are bounded by the database (D-INSP-4). A file is
 * born ADMITTED at the server's instant with the exact generation, digest and length its receipt promoted (composite key); its
 * inventory is appended with it and frozen once the upload leaves VERIFYING. A revocation takes the file's transition lock first
 * and is re-checked by the database after it (INTAKE_EXPIRED refused once a real seal included the file or while its window is
 * open; RETENTION_EXPIRED refused while an including revision holds an ACTIVE record ahead; KA072). The control plane reads no
 * worksheet name or header label (D-CTRL-1).
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  type AdmissionRevocationReason,
  type AgencyId,
  type DetectedTableRow,
  type InspectionProblem,
  type InspectionReceiptId,
  type InspectionReceiptRecord,
  type InspectionReceiptRepository,
  type PartCoverage,
  type ProjectId,
  type RevisionId,
  type SourceColumnRecord,
  type SourceFileId,
  type SourceFileRecord,
  type SourceFileRepository,
  type SourcePage,
  type SourceTableId,
  type SourceTableRecord,
  type StoredObjectId,
  type UploadId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { bool, exact, instantText, jsonArray, missedWrite, notAvailable, one, opt, optionalInstantText, optionalInt, optionalString, pageLimit, str, type SourceAudience } from "./rows.js";

type Row = Record<string, unknown>;

// --- inspection receipts -----------------------------------------------------------------------------------------------------------

const RECEIPT_COLUMNS = [
  "receipt_id",
  "agency_id",
  "upload_id",
  "revision_id",
  "receipt_hash",
  "inspection_fence",
  "quarantine_object_id",
  "observed_generation",
  "observed_bytes::text AS observed_bytes",
  "sha256",
  "completion_claim_digest",
  "claim_consistent",
  "declared_format",
  "detected_format",
  "structure_status",
  "scan_state",
  "semantic_status",
  "scanner_engine",
  "scanner_engine_version",
  "signature_version",
  exact("signatures_published_at"),
  "signature_max_age_seconds",
  "scanner_config_hash",
  "scanner_exit_code",
  "scanner_verdict",
  exact("scanned_at"),
  "expected_parts",
  "expected_bytes::text AS expected_bytes",
  "scanned_parts",
  "scanned_bytes::text AS scanned_bytes",
  "coverage",
  "problems",
  "parser_profile_hash",
  "inspector_version",
  "outcome",
  "rejection_class",
  "accepted_object_id",
  "accepted_generation",
  "accepted_sha256",
  exact("started_at"),
  exact("completed_at"),
].join(", ");

function receiptRecord(r: Row): InspectionReceiptRecord {
  const engine = optionalString(r["scanner_engine"]);
  const acceptedObjectId = optionalString<StoredObjectId>(r["accepted_object_id"]);
  return {
    receiptId: str<InspectionReceiptId>(r["receipt_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    uploadId: str<UploadId>(r["upload_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    receiptHash: str<Sha256Hex>(r["receipt_hash"]),
    inspectionFence: int(r["inspection_fence"]),
    quarantineObjectId: str<StoredObjectId>(r["quarantine_object_id"]),
    observedGeneration: str(r["observed_generation"]),
    observedBytes: int(r["observed_bytes"]),
    ...opt("sha256", optionalString<Sha256Hex>(r["sha256"])),
    completionClaimDigest: str<Sha256Hex>(r["completion_claim_digest"]),
    claimConsistent: bool(r["claim_consistent"]),
    declaredFormat: str<InspectionReceiptRecord["declaredFormat"]>(r["declared_format"]),
    detectedFormat: str<InspectionReceiptRecord["detectedFormat"]>(r["detected_format"]),
    structureStatus: str<InspectionReceiptRecord["structureStatus"]>(r["structure_status"]),
    scanState: str<InspectionReceiptRecord["scanState"]>(r["scan_state"]),
    semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
    ...opt(
      "scanner",
      engine === undefined
        ? undefined
        : {
            engine,
            engineVersion: str(r["scanner_engine_version"]),
            signatureVersion: str(r["signature_version"]),
            signaturesPublishedAt: instantText(r["signatures_published_at"]),
            signatureMaxAgeSeconds: int(r["signature_max_age_seconds"]),
            configHash: str<Sha256Hex>(r["scanner_config_hash"]),
            scannedAt: instantText(r["scanned_at"]),
            ...opt("exitCode", optionalInt(r["scanner_exit_code"])),
            ...opt("verdict", optionalString<"CLEAN" | "INFECTED" | "ERROR">(r["scanner_verdict"])),
          },
    ),
    expectedParts: int(r["expected_parts"]),
    expectedBytes: int(r["expected_bytes"]),
    scannedParts: int(r["scanned_parts"]),
    scannedBytes: int(r["scanned_bytes"]),
    coverage: jsonArray<PartCoverage>(r["coverage"]),
    problems: jsonArray<InspectionProblem>(r["problems"]),
    ...opt("parserProfileHash", optionalString<Sha256Hex>(r["parser_profile_hash"])),
    inspectorVersion: str(r["inspector_version"]),
    outcome: str<InspectionReceiptRecord["outcome"]>(r["outcome"]),
    ...opt("rejectionClass", optionalString<NonNullable<InspectionReceiptRecord["rejectionClass"]>>(r["rejection_class"])),
    ...opt(
      "accepted",
      acceptedObjectId === undefined ? undefined : { objectId: acceptedObjectId, generation: str(r["accepted_generation"]), sha256: str<Sha256Hex>(r["accepted_sha256"]) },
    ),
    startedAt: instantText(r["started_at"]),
    completedAt: instantText(r["completed_at"]),
  };
}

export class PgInspectionReceiptRepository implements InspectionReceiptRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Recorded at the server's transaction time. `startedAt` must be exactly the attempt's claim instant (as claimInspectionAttempt
   * returned it), the scan must follow the provider observation within the attempt and the completion must not be ahead of the
   * server clock — the database refuses anything else (KA072), and a stale attempt (KA071).
   */
  async append(receipt: InspectionReceiptRecord): Promise<void> {
    const s = receipt.scanner;
    await execute(
      this.db,
      `INSERT INTO kauro.inspection_receipts (receipt_id, agency_id, upload_id, revision_id, receipt_hash, inspection_fence, quarantine_object_id, observed_generation, observed_bytes, sha256,
          completion_claim_digest, claim_consistent, declared_format, detected_format, structure_status, scan_state, semantic_status, scanner_engine, scanner_engine_version, signature_version,
          signatures_published_at, signature_max_age_seconds, scanner_config_hash, scanned_at, expected_parts, expected_bytes, scanned_parts, scanned_bytes, coverage, problems,
          parser_profile_hash, inspector_version, outcome, rejection_class, accepted_object_id, accepted_generation, accepted_sha256, started_at, completed_at, scanner_exit_code, scanner_verdict, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::timestamptz, $22, $23, $24::timestamptz, $25, $26, $27, $28, $29::jsonb, $30::jsonb,
          $31, $32, $33, $34, $35, $36, $37, $38::timestamptz, $39::timestamptz, $40, $41, kauro.server_now())`,
      [
        receipt.receiptId,
        receipt.agencyId,
        receipt.uploadId,
        receipt.revisionId,
        receipt.receiptHash,
        receipt.inspectionFence,
        receipt.quarantineObjectId,
        receipt.observedGeneration,
        receipt.observedBytes,
        receipt.sha256 ?? null,
        receipt.completionClaimDigest,
        receipt.claimConsistent,
        receipt.declaredFormat,
        receipt.detectedFormat,
        receipt.structureStatus,
        receipt.scanState,
        receipt.semanticStatus,
        s?.engine ?? null,
        s?.engineVersion ?? null,
        s?.signatureVersion ?? null,
        s?.signaturesPublishedAt ?? null,
        s?.signatureMaxAgeSeconds ?? null,
        s?.configHash ?? null,
        s?.scannedAt ?? null,
        receipt.expectedParts,
        receipt.expectedBytes,
        receipt.scannedParts,
        receipt.scannedBytes,
        JSON.stringify(receipt.coverage),
        JSON.stringify(receipt.problems),
        receipt.parserProfileHash ?? null,
        receipt.inspectorVersion,
        receipt.outcome,
        receipt.rejectionClass ?? null,
        receipt.accepted?.objectId ?? null,
        receipt.accepted?.generation ?? null,
        receipt.accepted?.sha256 ?? null,
        receipt.startedAt,
        receipt.completedAt,
        s?.exitCode ?? null,
        s?.verdict ?? null,
      ],
    );
  }

  async getByHash(receiptHash: Sha256Hex): Promise<InspectionReceiptRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${RECEIPT_COLUMNS} FROM kauro.inspection_receipts WHERE receipt_hash = $1`, [receiptHash]);
    return r.rows[0] ? receiptRecord(r.rows[0]) : null;
  }

  async forUpload(uploadId: UploadId): Promise<ReadonlyArray<InspectionReceiptRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${RECEIPT_COLUMNS} FROM kauro.inspection_receipts WHERE upload_id = $1 ORDER BY inspection_fence`, [uploadId]);
    return r.rows.map(receiptRecord);
  }
}

// --- source files and their inventory ---------------------------------------------------------------------------------------------

const FILE_COLUMNS = [
  "file_id",
  "agency_id",
  "project_id",
  "version::text AS version",
  "origin_revision_id",
  "origin_upload_id",
  "accepted_object_id",
  "provider_generation",
  "sha256",
  "bytes::text AS bytes",
  "format",
  "scan_state",
  "parser_profile_hash",
  "inspection_receipt_hash",
  "admitted",
  "state",
  exact("admitted_at"),
  exact("revoked_at"),
  "revocation_reason",
].join(", ");

export function fileRecord(r: Row): SourceFileRecord {
  return {
    fileId: str<SourceFileId>(r["file_id"]),
    storageRef: str<StoredObjectId>(r["accepted_object_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    originRevisionId: str<RevisionId>(r["origin_revision_id"]),
    originUploadId: str<UploadId>(r["origin_upload_id"]),
    inspectionReceiptHash: str<Sha256Hex>(r["inspection_receipt_hash"]),
    version: int(r["version"]),
    providerGeneration: str(r["provider_generation"]),
    sha256: str<Sha256Hex>(r["sha256"]),
    bytes: int(r["bytes"]),
    format: str<SourceFileRecord["format"]>(r["format"]),
    scanState: str<SourceFileRecord["scanState"]>(r["scan_state"]),
    parserProfileHash: str<Sha256Hex>(r["parser_profile_hash"]),
    admitted: bool(r["admitted"]),
    state: str<SourceFileRecord["state"]>(r["state"]),
    admittedAt: instantText(r["admitted_at"]),
    ...opt("revokedAt", optionalInstantText(r["revoked_at"])),
    ...opt("revocationReason", optionalString<AdmissionRevocationReason>(r["revocation_reason"])),
  };
}

const TABLE_COLUMNS_CONTROL = [
  "table_id",
  "agency_id",
  "file_id",
  "ordinal",
  "kind",
  "name_digest",
  "visibility",
  "column_count",
  "row_estimate::text AS row_estimate",
  "has_formulas",
  "formula_cache",
  "merged_cell_count",
  "hidden_row_count",
  "hidden_column_count",
  "issues",
  "structure_hash",
].join(", ");
const TABLE_COLUMNS_REQUEST = `${TABLE_COLUMNS_CONTROL}, name_display`;

function tableRecord(r: Row): SourceTableRecord {
  return {
    tableId: str<SourceTableId>(r["table_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    fileId: str<SourceFileId>(r["file_id"]),
    ordinal: int(r["ordinal"]),
    kind: str<SourceTableRecord["kind"]>(r["kind"]),
    ...opt("nameDisplay", optionalString(r["name_display"])),
    nameDigest: str<Sha256Hex>(r["name_digest"]),
    visibility: str<SourceTableRecord["visibility"]>(r["visibility"]),
    columnCount: int(r["column_count"]),
    ...opt("rowEstimate", optionalInt(r["row_estimate"])),
    hasFormulas: bool(r["has_formulas"]),
    formulaCache: str<SourceTableRecord["formulaCache"]>(r["formula_cache"]),
    mergedCellCount: int(r["merged_cell_count"]),
    hiddenRowCount: int(r["hidden_row_count"]),
    hiddenColumnCount: int(r["hidden_column_count"]),
    issues: jsonArray<string>(r["issues"]),
    structureHash: str<Sha256Hex>(r["structure_hash"]),
  };
}

const COLUMN_COLUMNS_CONTROL = "table_id, ordinal, label_digest, label_state";
const COLUMN_COLUMNS_REQUEST = `${COLUMN_COLUMNS_CONTROL}, label_display`;

function columnRecord(r: Row): SourceColumnRecord {
  return {
    tableId: str<SourceTableId>(r["table_id"]),
    ordinal: int(r["ordinal"]),
    ...opt("labelDisplay", optionalString(r["label_display"])),
    labelDigest: str<Sha256Hex>(r["label_digest"]),
    labelState: str<SourceColumnRecord["labelState"]>(r["label_state"]),
  };
}

export class PgSourceFileRepository implements SourceFileRepository {
  readonly #tableColumns: string;
  readonly #columnColumns: string;

  constructor(
    private readonly db: Queryable,
    audience: SourceAudience,
  ) {
    this.#tableColumns = audience === "CONTROL" ? TABLE_COLUMNS_CONTROL : TABLE_COLUMNS_REQUEST;
    this.#columnColumns = audience === "CONTROL" ? COLUMN_COLUMNS_CONTROL : COLUMN_COLUMNS_REQUEST;
  }

  /**
   * The admitted file at version 1, admitted at the server's transaction time, and its table inventory with it (the upload must
   * still be VERIFYING under the current attempt; KA071 otherwise). The caller publishes source_file.admitted.v1.
   */
  async admit(
    file: Omit<SourceFileRecord, "state" | "admitted" | "revokedAt" | "revocationReason" | "version" | "admittedAt">,
    tables: ReadonlyArray<DetectedTableRow>,
  ): Promise<SourceFileRecord> {
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.source_files (file_id, agency_id, project_id, version, origin_revision_id, origin_upload_id, accepted_object_id, provider_generation, sha256, bytes, format, scan_state,
          parser_profile_hash, inspection_receipt_hash, admitted, state, admitted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, 'ADMITTED', kauro.server_now(), kauro.server_now(), kauro.server_now()) RETURNING ${FILE_COLUMNS}`,
      [file.fileId, file.agencyId, file.projectId, file.originRevisionId, file.originUploadId, file.storageRef, file.providerGeneration, file.sha256, file.bytes, file.format, file.scanState, file.parserProfileHash, file.inspectionReceiptHash],
    );
    const admitted = fileRecord(one(r.rows, "source file insert"));
    for (const t of tables) {
      await execute(
        this.db,
        `INSERT INTO kauro.source_tables (table_id, agency_id, file_id, ordinal, kind, name_display, name_digest, visibility, column_count, row_estimate, has_formulas, formula_cache,
            merged_cell_count, hidden_row_count, hidden_column_count, issues, structure_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, kauro.server_now())`,
        [
          t.tableId,
          file.agencyId,
          file.fileId,
          t.ordinal,
          t.kind,
          t.nameDisplay ?? null,
          t.nameDigest,
          t.visibility,
          t.columnCount,
          t.rowEstimate ?? null,
          t.hasFormulas,
          t.formulaCache,
          t.mergedCellCount,
          t.hiddenRowCount,
          t.hiddenColumnCount,
          JSON.stringify(t.issues),
          t.structureHash,
        ],
      );
      if (t.columns.length > 0) {
        await execute(
          this.db,
          `INSERT INTO kauro.source_table_columns (table_id, ordinal, agency_id, label_display, label_digest, label_state)
           SELECT $1, c.ordinal, $2, c.label_display, c.label_digest, c.label_state
             FROM unnest($3::integer[], $4::text[], $5::text[], $6::text[]) AS c (ordinal, label_display, label_digest, label_state)`,
          [t.tableId, file.agencyId, t.columns.map((c) => c.ordinal), t.columns.map((c) => c.labelDisplay ?? null), t.columns.map((c) => c.labelDigest), t.columns.map((c) => c.labelState)],
        );
      }
    }
    return admitted;
  }

  async get(fileId: SourceFileId): Promise<SourceFileRecord | null> {
    const r = await execute<Row>(this.db, `SELECT ${FILE_COLUMNS} FROM kauro.source_files WHERE file_id = $1`, [fileId]);
    return r.rows[0] ? fileRecord(r.rows[0]) : null;
  }

  /**
   * The file after its shared transition lock (kauro.await_transition, the lock sealed_revision_files_admitted takes), held to the
   * end of the unit of work: a revocation in flight is ordered before this read (and read) or after the unit of work (and refused
   * by the database once the file is sealed). Decision D-CMD-7 (mandate B07-COMMANDS).
   */
  async lockShared(fileId: SourceFileId): Promise<SourceFileRecord | null> {
    await execute(this.db, "SELECT kauro.await_transition('kauro.source_files', $1::uuid::text)", [fileId]);
    return this.get(fileId);
  }

  /** Every file admitted from the revision's own uploads, revoked ones included (each record carries its state). */
  async listForRevision(revisionId: RevisionId): Promise<ReadonlyArray<SourceFileRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${FILE_COLUMNS} FROM kauro.source_files WHERE origin_revision_id = $1 ORDER BY admitted_at, file_id`, [revisionId]);
    return r.rows.map(fileRecord);
  }

  /** The project's files whose admission stands (registry edge previously_admitted_inputs_selected; reuse is checked by the seal, D-RET-3). */
  async listReusable(projectId: ProjectId): Promise<ReadonlyArray<SourceFileRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${FILE_COLUMNS} FROM kauro.source_files WHERE project_id = $1 AND state = 'ADMITTED' ORDER BY admitted_at, file_id`, [projectId]);
    return r.rows.map(fileRecord);
  }

  async tables(fileId: SourceFileId): Promise<ReadonlyArray<SourceTableRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${this.#tableColumns} FROM kauro.source_tables WHERE file_id = $1 ORDER BY ordinal`, [fileId]);
    return r.rows.map(tableRecord);
  }

  async columns(tableId: SourceTableId): Promise<ReadonlyArray<SourceColumnRecord>> {
    const r = await execute<Row>(this.db, `SELECT ${this.#columnColumns} FROM kauro.source_table_columns WHERE table_id = $1 ORDER BY ordinal`, [tableId]);
    return r.rows.map(columnRecord);
  }

  /**
   * ADMITTED -> ADMISSION_REVOKED at expectedVersion + 1 and the server's transaction time. The file's transition lock is taken
   * first (a seal of the file in flight commits before, and the database then refuses INTAKE_EXPIRED; D-FILE-1), and the reason is
   * re-checked by the database after it. The caller publishes source_file.admission_revoked.v1 (selectedBy, sealedBy).
   */
  async revokeAdmission(fileId: SourceFileId, expectedVersion: number, reason: AdmissionRevocationReason): Promise<VersionedWrite<SourceFileRecord>> {
    await execute(this.db, "SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.source_files', $1::uuid::text))", [fileId]);
    const r = await execute<Row>(
      this.db,
      `UPDATE kauro.source_files SET state = 'ADMISSION_REVOKED', admitted = false, revoked_at = kauro.server_now(), revocation_reason = $3, version = $2 + 1
        WHERE file_id = $1 AND version = $2 RETURNING ${FILE_COLUMNS}`,
      [fileId, expectedVersion, reason],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: fileRecord(row) };
    return missedWrite(this.db, "source_files", "file_id", fileId, expectedVersion, "source file", ({ state }) => notAvailable("the admission of the file", state));
  }

  async selectedBy(fileId: SourceFileId): Promise<ReadonlyArray<RevisionId>> {
    const r = await execute<{ revision_id: string }>(
      this.db,
      `SELECT DISTINCT r.revision_id FROM kauro.dataset_revisions r
         JOIN kauro.selection_manifests m ON m.agency_id = r.agency_id AND m.selection_manifest_id = r.selection_manifest_id
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(m.body -> 'files') f WHERE f ->> 'fileId' = $1::text AND f ->> 'disposition' = 'INCLUDE')
        ORDER BY r.revision_id`,
      [fileId],
    );
    return r.rows.map((x) => x.revision_id as RevisionId);
  }

  /** Revisions whose real seal included the file (D-SEAL-1: a sealed row no seal recorded is never counted). */
  async sealedBy(fileId: SourceFileId): Promise<ReadonlyArray<RevisionId>> {
    const r = await execute<{ revision_id: string }>(
      this.db,
      "SELECT s.revision_id FROM kauro.sealed_revision_files s WHERE s.file_id = $1 AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id) ORDER BY s.revision_id",
      [fileId],
    );
    return r.rows.map((x) => x.revision_id as RevisionId);
  }

  /**
   * The RETENTION_EXPIRED revocations due on the server clock (D-RET-3): the same predicate as kauro.source_files_revocation_guard —
   * some real seal included the file and no including revision holds an ACTIVE record ahead — so what is found is what the guard
   * admits (it re-checks after the file's transition lock). Ids only (decision D-CTRL-5).
   */
  async findRetentionEnded(limit: number): Promise<ReadonlyArray<{ readonly fileId: SourceFileId; readonly agencyId: AgencyId; readonly originRevisionId: RevisionId }>> {
    const r = await execute<{ file_id: string; agency_id: string; origin_revision_id: string }>(
      this.db,
      `SELECT f.file_id, f.agency_id, f.origin_revision_id FROM kauro.source_files f
        WHERE f.state = 'ADMITTED'
          AND EXISTS (SELECT 1 FROM kauro.sealed_revision_files s
                       WHERE s.agency_id = f.agency_id AND s.file_id = f.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id))
          AND NOT EXISTS (SELECT 1 FROM kauro.sealed_revision_files s JOIN kauro.retention_records rr ON rr.agency_id = s.agency_id AND rr.revision_id = s.revision_id
                           WHERE s.agency_id = f.agency_id AND s.file_id = f.file_id AND s.disposition = 'INCLUDED' AND kauro.is_real_seal(s.agency_id, s.revision_id)
                             AND rr.state = 'ACTIVE' AND rr.effective_deadline > kauro.server_now())
        ORDER BY f.file_id LIMIT $1`,
      [pageLimit(limit, 1000)],
    );
    return r.rows.map((x) => ({ fileId: x.file_id as SourceFileId, agencyId: x.agency_id as AgencyId, originRevisionId: x.origin_revision_id as RevisionId }));
  }

  /** Admitted files and the exact accepted generation each names, in file-id order (OBJECT_INVENTORY's comparison; decision D-CTRL-5). */
  async admittedGenerations(page: SourcePage<SourceFileId>): Promise<ReadonlyArray<{ readonly fileId: SourceFileId; readonly agencyId: AgencyId; readonly originRevisionId: RevisionId; readonly acceptedObjectId: StoredObjectId; readonly providerGeneration: string }>> {
    const r = await execute<{ file_id: string; agency_id: string; origin_revision_id: string; accepted_object_id: string; provider_generation: string }>(
      this.db,
      `SELECT file_id, agency_id, origin_revision_id, accepted_object_id, provider_generation FROM kauro.source_files
        WHERE state = 'ADMITTED' AND ($2::uuid IS NULL OR file_id > $2::uuid) ORDER BY file_id LIMIT $1`,
      [pageLimit(page.limit, 1000), page.after ?? null],
    );
    return r.rows.map((x) => ({
      fileId: x.file_id as SourceFileId,
      agencyId: x.agency_id as AgencyId,
      originRevisionId: x.origin_revision_id as RevisionId,
      acceptedObjectId: x.accepted_object_id as StoredObjectId,
      providerGeneration: x.provider_generation,
    }));
  }
}
