/**
 * Import stages and their receipts over `pg` (package B17: CMD040 SubmitStageReceipt, CMD041 ContinueStage; migration 0052). The stage
 * rows are the stage compiler's; here the request handlers read them, serialize on them (FOR NO KEY UPDATE: the one serialization point of a
 * receipt or a continuation), append receipt revisions and advance a stage under its version fence. The database stamps every instant
 * (validated_at, continued_at) and its guard refuses an unlisted edge, a changed binding and a second continuation.
 */
import type { Sha256Hex } from "@kauro/contracts";
import {
  DomainFailure,
  RECEIPT_VALIDATOR_VERSION,
  type AgencyId,
  type ArtifactRef,
  type ImportStageRecord,
  type ImportStageState,
  type ImportStageStore,
  type MembershipId,
  type NewStageReceipt,
  type NewStageReceiptReconciliation,
  type PlanId,
  type ProjectId,
  type ReceiptMappingRow,
  type ReceiptResult,
  type StageParentEdge,
  type StageReceiptReconciliationRecord,
  type StageReceiptRecord,
  type StageReceiptStatus,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, withOptional, type Queryable } from "../sql.js";

interface StageRow {
  stage_id: string;
  agency_id: string;
  project_id: string;
  plan_id: string;
  sequence: number | string;
  object_api_name: string;
  operation: ImportStageRecord["operation"];
  state: ImportStageState;
  parent_stage_ids: string[];
  package_hash: string;
  receipt_required: boolean;
  expires_at: Date;
  instance_id: string;
  source_ids: string[];
  parent_edges: StageParentEdge[];
  version: number | string;
  continued_at: Date | null;
  continued_by_membership_id: string | null;
  continuation_receipt_hash: string | null;
}

const STAGE_COLUMNS =
  "stage_id, agency_id, project_id, plan_id, sequence, object_api_name, operation, state, parent_stage_ids, package_hash, receipt_required, expires_at, instance_id, source_ids, parent_edges, version, continued_at, continued_by_membership_id, continuation_receipt_hash";

function stageRecord(r: StageRow): ImportStageRecord {
  const base: ImportStageRecord = {
    stageId: r.stage_id,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    planId: r.plan_id as PlanId,
    sequence: int(r.sequence),
    objectApiName: r.object_api_name,
    operation: r.operation,
    state: r.state,
    parentStageIds: r.parent_stage_ids,
    packageHash: r.package_hash as Sha256Hex,
    receiptRequired: r.receipt_required,
    expiresAt: instant(r.expires_at),
    instanceId: r.instance_id,
    sourceIds: r.source_ids,
    parentEdges: r.parent_edges,
    version: int(r.version),
  };
  const continuedAt = optionalInstant(r.continued_at);
  const a = withOptional(base, "continuedAt", continuedAt);
  const b = withOptional(a, "continuedByMembershipId", optionalText(r.continued_by_membership_id));
  return withOptional(b, "continuationReceiptHash", optionalText(r.continuation_receipt_hash) as Sha256Hex | undefined);
}

interface ReceiptRow {
  receipt_id: string;
  agency_id: string;
  project_id: string;
  stage_id: string;
  revision: number | string;
  instance_id: string;
  source_package_hash: string;
  receipt_upload_ref: string;
  receipt_file_hash: string;
  identity_mapping_hash: string;
  matched_rows: number | string;
  failed_rows: number | string;
  unresolved_rows: number | string;
  result: ReceiptResult;
  mapping: ReceiptMappingRow[];
  validated_at: Date | string;
  validator_version: string;
  submitted_by_membership_id: string;
}

const RECEIPT_COLUMNS =
  "receipt_id, agency_id, project_id, stage_id, revision, instance_id, source_package_hash, receipt_upload_ref, receipt_file_hash, identity_mapping_hash, matched_rows, failed_rows, unresolved_rows, result, mapping, validated_at, validator_version, submitted_by_membership_id";

function receiptRecord(r: ReceiptRow): StageReceiptRecord {
  return {
    receiptId: r.receipt_id,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    stageId: r.stage_id,
    revision: int(r.revision),
    instanceId: r.instance_id,
    sourcePackageHash: r.source_package_hash as Sha256Hex,
    receiptUploadRef: r.receipt_upload_ref as ArtifactRef,
    receiptFileHash: r.receipt_file_hash as Sha256Hex,
    identityMappingHash: r.identity_mapping_hash as Sha256Hex,
    matchedRows: int(r.matched_rows),
    failedRows: int(r.failed_rows),
    unresolvedRows: int(r.unresolved_rows),
    result: r.result,
    mapping: r.mapping,
    validatedAt: instant(r.validated_at),
    validatorVersion: r.validator_version,
    submittedByMembershipId: r.submitted_by_membership_id,
  };
}

interface ReconciliationRow {
  reconciliation_id: string;
  agency_id: string;
  project_id: string;
  stage_id: string;
  content_hash: string;
  receipt_upload_ref: string;
  state: "OPEN";
  opened_by_membership_id: string;
  opened_at: Date | string;
}

const RECONCILIATION_COLUMNS = "reconciliation_id, agency_id, project_id, stage_id, content_hash, receipt_upload_ref, state, opened_by_membership_id, opened_at";

function reconciliationRecord(r: ReconciliationRow): StageReceiptReconciliationRecord {
  return {
    reconciliationId: r.reconciliation_id,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    stageId: r.stage_id,
    contentHash: r.content_hash as Sha256Hex,
    receiptUploadRef: r.receipt_upload_ref as ArtifactRef,
    state: r.state,
    openedByMembershipId: r.opened_by_membership_id,
    openedAt: instant(r.opened_at),
  };
}

export class PgImportStageStore implements ImportStageStore {
  constructor(private readonly db: Queryable) {}

  async get(stageId: string): Promise<ImportStageRecord | null> {
    const r = await execute<StageRow>(this.db, `SELECT ${STAGE_COLUMNS} FROM kauro.import_stages WHERE stage_id = $1`, [stageId]);
    return r.rows[0] ? stageRecord(r.rows[0]) : null;
  }

  async lock(stageId: string): Promise<ImportStageRecord | null> {
    const r = await execute<StageRow>(this.db, `SELECT ${STAGE_COLUMNS} FROM kauro.import_stages WHERE stage_id = $1 FOR NO KEY UPDATE`, [stageId]);
    return r.rows[0] ? stageRecord(r.rows[0]) : null;
  }

  async getMany(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<ImportStageRecord>> {
    if (stageIds.length === 0) return [];
    const r = await execute<StageRow>(this.db, `SELECT ${STAGE_COLUMNS} FROM kauro.import_stages WHERE stage_id = ANY($1::uuid[]) ORDER BY stage_id`, [[...stageIds]]);
    return r.rows.map(stageRecord);
  }

  async lockParents(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<ImportStageRecord>> {
    if (stageIds.length === 0) return [];
    const r = await execute<StageRow>(this.db, `SELECT ${STAGE_COLUMNS} FROM kauro.import_stages WHERE stage_id = ANY($1::uuid[]) ORDER BY stage_id FOR SHARE`, [[...new Set(stageIds)]]);
    return r.rows.map(stageRecord);
  }

  async latestReceipts(stageIds: ReadonlyArray<string>): Promise<ReadonlyMap<string, StageReceiptRecord>> {
    if (stageIds.length === 0) return new Map();
    const r = await execute<ReceiptRow>(
      this.db,
      `SELECT DISTINCT ON (stage_id) ${RECEIPT_COLUMNS} FROM kauro.stage_receipts WHERE stage_id = ANY($1::uuid[]) ORDER BY stage_id, revision DESC`,
      [[...new Set(stageIds)]],
    );
    return new Map(r.rows.map((row) => [row.stage_id, receiptRecord(row)]));
  }

  async stagesUnderReconciliation(stageIds: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
    if (stageIds.length === 0) return [];
    const r = await execute<{ stage_id: string }>(
      this.db,
      "SELECT DISTINCT stage_id FROM kauro.stage_receipt_reconciliations WHERE stage_id = ANY($1::uuid[]) AND state = 'OPEN' ORDER BY stage_id",
      [[...new Set(stageIds)]],
    );
    return r.rows.map((row) => row.stage_id);
  }

  async receiptStatus(stageId: string, contentHash: Sha256Hex): Promise<StageReceiptStatus> {
    const r = await execute<{ receipt: ReceiptRow | null; reconciliation: ReconciliationRow | null }>(
      this.db,
      `SELECT (SELECT to_jsonb(x) FROM (SELECT ${RECEIPT_COLUMNS} FROM kauro.stage_receipts WHERE stage_id = $1 AND receipt_file_hash = $2) x) AS receipt,
              (SELECT to_jsonb(y) FROM (SELECT ${RECONCILIATION_COLUMNS} FROM kauro.stage_receipt_reconciliations WHERE stage_id = $1 AND content_hash = $2) y) AS reconciliation`,
      [stageId, contentHash],
    );
    const row = r.rows[0];
    const receipt = row?.receipt ? receiptRecord(row.receipt) : null;
    const reconciliation = row?.reconciliation ? reconciliationRecord(row.reconciliation) : null;
    return { receipt, reconciliation };
  }

  async openReconciliation(input: NewStageReceiptReconciliation): Promise<StageReceiptReconciliationRecord> {
    const r = await execute<ReconciliationRow>(
      this.db,
      `INSERT INTO kauro.stage_receipt_reconciliations (reconciliation_id, agency_id, project_id, stage_id, content_hash, receipt_upload_ref, opened_by_membership_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${RECONCILIATION_COLUMNS}`,
      [input.reconciliationId, input.agencyId, input.projectId, input.stageId, input.contentHash, input.receiptUploadRef, input.openedByMembershipId],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "the receipt reconciliation was not recorded");
    return reconciliationRecord(row);
  }

  async latestReceipt(stageId: string): Promise<StageReceiptRecord | null> {
    const r = await execute<ReceiptRow>(this.db, `SELECT ${RECEIPT_COLUMNS} FROM kauro.stage_receipts WHERE stage_id = $1 ORDER BY revision DESC LIMIT 1`, [stageId]);
    return r.rows[0] ? receiptRecord(r.rows[0]) : null;
  }

  async hasReceiptFile(stageId: string, receiptFileHash: Sha256Hex): Promise<boolean> {
    const r = await execute(this.db, "SELECT 1 FROM kauro.stage_receipts WHERE stage_id = $1 AND receipt_file_hash = $2", [stageId, receiptFileHash]);
    return r.rows.length > 0;
  }

  async appendReceipt(input: NewStageReceipt): Promise<StageReceiptRecord> {
    // the revision is the stage's latest + 1, computed under the stage's row lock the caller holds (the unique key backstops it)
    const r = await execute<ReceiptRow>(
      this.db,
      `INSERT INTO kauro.stage_receipts (receipt_id, agency_id, project_id, stage_id, revision, instance_id, source_package_hash, receipt_upload_ref, receipt_file_hash, identity_mapping_hash,
                                         matched_rows, failed_rows, unresolved_rows, result, mapping, validator_version, submitted_by_membership_id)
       SELECT $1, $2, $3, $4, COALESCE(MAX(revision), 0) + 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16
         FROM kauro.stage_receipts WHERE stage_id = $4
       RETURNING ${RECEIPT_COLUMNS}`,
      [
        input.receiptId,
        input.agencyId,
        input.projectId,
        input.stageId,
        input.instanceId,
        input.sourcePackageHash,
        input.receiptUploadRef,
        input.receiptFileHash,
        input.identityMappingHash,
        input.matchedRows,
        input.failedRows,
        input.unresolvedRows,
        input.result,
        JSON.stringify(input.mapping),
        RECEIPT_VALIDATOR_VERSION,
        input.submittedByMembershipId,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "the receipt revision was not recorded");
    return receiptRecord(row);
  }

  async advance(stageId: string, expectedVersion: number, to: ImportStageState): Promise<VersionedWrite<ImportStageRecord>> {
    const r = await execute<StageRow>(
      this.db,
      `UPDATE kauro.import_stages SET state = $3, version = $2 + 1 WHERE stage_id = $1 AND version = $2 AND continued_at IS NULL RETURNING ${STAGE_COLUMNS}`,
      [stageId, expectedVersion, to],
    );
    return this.settle(stageId, r.rows[0]);
  }

  async recordContinuation(
    stageId: string,
    expectedVersion: number,
    to: ImportStageState,
    continuation: { readonly membershipId: MembershipId; readonly receiptHash: Sha256Hex },
  ): Promise<VersionedWrite<ImportStageRecord>> {
    // continued_at is stamped by the database (and its stamp trigger re-stamps it)
    const r = await execute<StageRow>(
      this.db,
      `UPDATE kauro.import_stages
          SET state = $3, version = $2 + 1, continued_at = kauro.server_now(), continued_by_membership_id = $4, continuation_receipt_hash = $5
        WHERE stage_id = $1 AND version = $2 AND continued_at IS NULL RETURNING ${STAGE_COLUMNS}`,
      [stageId, expectedVersion, to, continuation.membershipId, continuation.receiptHash],
    );
    return this.settle(stageId, r.rows[0]);
  }

  private async settle(stageId: string, row: StageRow | undefined): Promise<VersionedWrite<ImportStageRecord>> {
    if (row) return { kind: "APPLIED", record: stageRecord(row) };
    const now = await this.get(stageId);
    if (!now) throw new DomainFailure("NOT_FOUND", "import stage is not visible in this context");
    return { kind: "STALE", currentVersion: now.version, currentState: now.state };
  }
}
