/**
 * Plan revisions, validation receipts and approvals over `pg` (07 "Audit and plan states": edits create a new version;
 * APPROVED requires exact source/target/plan bindings; PlanApproval records actor identity, membership version, assurance
 * evidence and the hashes; a later revocation does not rewrite the approval record. Decision D-PLAN-1: a revision is its own
 * row; D-PLAN-2: the bindings are foreign keys — the repositories write the columns and let the database refuse a stale or
 * foreign hash (23503 → INVALID_REQUEST / UNKNOWN_REFERENCE) or a second live approval (23505 approvals_one_live_per_plan)).
 */
import type { Plan, RowCounts, Sha256Hex, UtcInstant, ValidationReceipt } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import {
  DomainFailure,
  type AgencyId,
  type ApprovalId,
  type ApprovalRecord,
  type ApprovalRepository,
  type AssuranceProofId,
  type MembershipId,
  type NewApproval,
  type NewPlanRevision,
  type PlanBody,
  type PlanId,
  type PlanRecord,
  type PlanRepository,
  type ProjectId,
  type UserId,
  type ValidationReceiptId,
  type ValidationReceiptRecord,
  type ValidationReceiptRepository,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, withOptional, type Queryable } from "../sql.js";
import { staleOrMissing } from "./tenancy.js";

// --- plans ------------------------------------------------------------------------------------------------------------

interface PlanRow {
  plan_id: string;
  agency_id: string;
  project_id: string;
  version: string;
  state: Plan["state"];
  revision_hash: string;
  target_contract_hash: string;
  policy_hash: string;
  body_hash: string;
  validation_receipt_hash: string | null;
  approval_id: string | null;
  supersedes_plan_id: string | null;
  superseded_by_plan_id: string | null;
  created_by_membership_id: string;
  created_at: Date;
  updated_at: Date;
}

const PLAN_COLUMNS = "plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body_hash, validation_receipt_hash, approval_id, supersedes_plan_id, superseded_by_plan_id, created_by_membership_id, created_at, updated_at";

function planRecord(r: PlanRow): PlanRecord {
  const base = {
    planId: r.plan_id as PlanId,
    agencyId: r.agency_id as AgencyId,
    projectId: r.project_id as ProjectId,
    version: int(r.version),
    state: r.state,
    revisionHash: r.revision_hash,
    targetContractHash: r.target_contract_hash,
    policyHash: r.policy_hash,
    bodyHash: r.body_hash,
    createdByMembershipId: r.created_by_membership_id as MembershipId,
    createdAt: instant(r.created_at),
    updatedAt: instant(r.updated_at),
  };
  const a = withOptional(base, "validationReceiptHash", optionalText(r.validation_receipt_hash));
  const b = withOptional(a, "approvalId", optionalText(r.approval_id) as ApprovalId | undefined);
  const c = withOptional(b, "supersedesPlanId", optionalText(r.supersedes_plan_id) as PlanId | undefined);
  return withOptional(c, "supersededByPlanId", optionalText(r.superseded_by_plan_id) as PlanId | undefined);
}

function isPlanBody(v: unknown): v is PlanBody {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return ["revisionHash", "targetContractHash", "policyHash"].every((k) => typeof o[k] === "string") && ["mappings", "identities", "transforms", "relationships"].every((k) => Array.isArray(o[k]));
}

/**
 * The Plan bodyHash: the KAURO_PLAN_BODY_V1 digest of the closed body (reference/HASHING_AND_ACCOUNTING_RULES; the preimage
 * excludes planId, version and state). The repository computes it for every revision it stores, so the stored body_hash is the
 * digest of the stored body whatever a collaborator claimed (re-check finding N10).
 */
export function planBodyHash(body: PlanBody): Sha256Hex {
  return structuredDigest(DOMAINS.PLAN_BODY, 1, body);
}

export class PgPlanRepository implements PlanRepository {
  constructor(private readonly db: Queryable) {}

  async get(planId: PlanId): Promise<PlanRecord | null> {
    const r = await execute<PlanRow>(this.db, `SELECT ${PLAN_COLUMNS} FROM kauro.plans WHERE plan_id = $1`, [planId]);
    return r.rows[0] ? planRecord(r.rows[0]) : null;
  }

  /** FOR NO KEY UPDATE: the plan row serializes the plan's writers without blocking the FOR KEY SHARE that a child row's foreign key takes (CreateQuote holds the approval half, then inserts a row that references the plan: FOR UPDATE here deadlocked with WithdrawApproval). */
  async lock(planId: PlanId): Promise<PlanRecord | null> {
    const r = await execute<PlanRow>(this.db, `SELECT ${PLAN_COLUMNS} FROM kauro.plans WHERE plan_id = $1 FOR NO KEY UPDATE`, [planId]);
    return r.rows[0] ? planRecord(r.rows[0]) : null;
  }

  async findCurrentForProject(projectId: ProjectId): Promise<PlanRecord | null> {
    const r = await execute<PlanRow>(this.db, `SELECT ${PLAN_COLUMNS} FROM kauro.plans WHERE project_id = $1 AND superseded_by_plan_id IS NULL ORDER BY created_at DESC, plan_id DESC LIMIT 1`, [projectId]);
    return r.rows[0] ? planRecord(r.rows[0]) : null;
  }

  async getBody(planId: PlanId): Promise<PlanBody | null> {
    const r = await execute<{ body: unknown }>(this.db, "SELECT body FROM kauro.plans WHERE plan_id = $1", [planId]);
    const row = r.rows[0];
    if (!row) return null;
    if (!isPlanBody(row.body)) throw new DomainFailure("INTEGRITY_FAILURE", "stored plan body is not a closed plan body");
    return row.body;
  }

  async insert(plan: NewPlanRevision): Promise<PlanRecord> {
    const r = await execute<PlanRow>(
      this.db,
      `INSERT INTO kauro.plans (plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, supersedes_plan_id, created_by_membership_id, created_at, updated_at)
       VALUES ($1, $2, $3, 1, 'DRAFT', $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $11) RETURNING ${PLAN_COLUMNS}`,
      [plan.planId, plan.agencyId, plan.projectId, plan.body.revisionHash, plan.body.targetContractHash, plan.body.policyHash, JSON.stringify(plan.body), planBodyHash(plan.body), plan.supersedesPlanId ?? null, plan.createdByMembershipId, plan.createdAt],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "plan insert returned no row");
    return planRecord(row);
  }

  async transition(
    planId: PlanId,
    expectedVersion: number,
    change: { readonly state: PlanRecord["state"]; readonly supersededByPlanId?: PlanId; readonly validationReceiptHash?: Sha256Hex | null; readonly approvalId?: ApprovalId | null },
    _now: UtcInstant,
  ): Promise<VersionedWrite<PlanRecord>> {
    const sets: string[] = ["version = $2 + 1", "state = $3"];
    const params: unknown[] = [planId, expectedVersion, change.state];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (change.supersededByPlanId !== undefined) add("superseded_by_plan_id", change.supersededByPlanId);
    if (change.validationReceiptHash !== undefined) add("validation_receipt_hash", change.validationReceiptHash);
    if (change.approvalId !== undefined) add("approval_id", change.approvalId);
    const r = await execute<PlanRow>(this.db, `UPDATE kauro.plans SET ${sets.join(", ")} WHERE plan_id = $1 AND version = $2 RETURNING ${PLAN_COLUMNS}`, params);
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: planRecord(row) };
    return staleOrMissing(this.db, "plans", "plan_id", planId, "plan");
  }
}

// --- validation receipts ------------------------------------------------------------------------------------------------

interface ReceiptRow {
  receipt_id: string;
  agency_id: string;
  plan_id: string;
  receipt_hash: string;
  revision_hash: string;
  target_contract_hash: string;
  plan_hash: string;
  core_package_hash: string;
  profile_evidence_hash: string;
  disposition_evidence_hash: string;
  artifact_evidence_hash: string;
  started_at: Date;
  completed_at: Date;
  result: ValidationReceipt["result"];
  counts: unknown;
  blocking_issue_codes: unknown;
}

const RECEIPT_COLUMNS = "receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, blocking_issue_codes";

function receiptRecord(r: ReceiptRow): ValidationReceiptRecord {
  const codes = r.blocking_issue_codes;
  if (!Array.isArray(codes) || !codes.every((c) => typeof c === "string")) throw new DomainFailure("INTEGRITY_FAILURE", "receipt blocking codes are not a list of tokens");
  if (typeof r.counts !== "object" || r.counts === null || Array.isArray(r.counts)) throw new DomainFailure("INTEGRITY_FAILURE", "receipt counts are not an object");
  return {
    receiptId: r.receipt_id as ValidationReceiptId,
    agencyId: r.agency_id as AgencyId,
    planId: r.plan_id as PlanId,
    receiptHash: r.receipt_hash,
    revisionHash: r.revision_hash,
    targetContractHash: r.target_contract_hash,
    planHash: r.plan_hash,
    corePackageHash: r.core_package_hash,
    profileEvidenceHash: r.profile_evidence_hash,
    dispositionEvidenceHash: r.disposition_evidence_hash,
    artifactEvidenceHash: r.artifact_evidence_hash,
    startedAt: instant(r.started_at),
    completedAt: instant(r.completed_at),
    result: r.result,
    counts: r.counts as RowCounts,
    blockingIssueCodes: codes as string[],
  };
}

export class PgValidationReceiptRepository implements ValidationReceiptRepository {
  constructor(private readonly db: Queryable) {}

  async get(receiptId: ValidationReceiptId): Promise<ValidationReceiptRecord | null> {
    const r = await execute<ReceiptRow>(this.db, `SELECT ${RECEIPT_COLUMNS} FROM kauro.validation_receipts WHERE receipt_id = $1`, [receiptId]);
    return r.rows[0] ? receiptRecord(r.rows[0]) : null;
  }

  async findByHash(agencyId: AgencyId, receiptHash: Sha256Hex): Promise<ValidationReceiptRecord | null> {
    const r = await execute<ReceiptRow>(this.db, `SELECT ${RECEIPT_COLUMNS} FROM kauro.validation_receipts WHERE agency_id = $1 AND receipt_hash = $2`, [agencyId, receiptHash]);
    return r.rows[0] ? receiptRecord(r.rows[0]) : null;
  }
}

// --- approvals ---------------------------------------------------------------------------------------------------------

interface ApprovalRow {
  approval_id: string;
  agency_id: string;
  plan_id: string;
  version: string;
  actor_id: string;
  actor_membership_id: string;
  actor_membership_version: string;
  assurance_proof_ref: string;
  plan_hash: string;
  revision_hash: string;
  target_contract_hash: string;
  validation_receipt_hash: string;
  disclosures_hash: string;
  approval_hash: string;
  created_at: Date;
  withdrawn_at: Date | null;
  withdrawn_by_membership_id: string | null;
  withdraw_reason_code: string | null;
}

const APPROVAL_COLUMNS = "approval_id, agency_id, plan_id, version, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, withdrawn_at, withdrawn_by_membership_id, withdraw_reason_code";

function approvalRecord(r: ApprovalRow): ApprovalRecord {
  const base = {
    approvalId: r.approval_id as ApprovalId,
    agencyId: r.agency_id as AgencyId,
    planId: r.plan_id as PlanId,
    version: int(r.version),
    actorId: r.actor_id as UserId,
    actorMembershipId: r.actor_membership_id as MembershipId,
    actorMembershipVersion: int(r.actor_membership_version),
    assuranceProofRef: r.assurance_proof_ref as AssuranceProofId,
    planHash: r.plan_hash,
    revisionHash: r.revision_hash,
    targetContractHash: r.target_contract_hash,
    validationReceiptHash: r.validation_receipt_hash,
    disclosuresHash: r.disclosures_hash,
    approvalHash: r.approval_hash,
    createdAt: instant(r.created_at),
  };
  const a = withOptional(base, "withdrawnAt", optionalInstant(r.withdrawn_at));
  const b = withOptional(a, "withdrawnByMembershipId", optionalText(r.withdrawn_by_membership_id) as MembershipId | undefined);
  return withOptional(b, "withdrawReasonCode", optionalText(r.withdraw_reason_code));
}

export class PgApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Queryable) {}

  async get(approvalId: ApprovalId): Promise<ApprovalRecord | null> {
    const r = await execute<ApprovalRow>(this.db, `SELECT ${APPROVAL_COLUMNS} FROM kauro.approvals WHERE approval_id = $1`, [approvalId]);
    return r.rows[0] ? approvalRecord(r.rows[0]) : null;
  }

  async findLiveByPlan(planId: PlanId): Promise<ApprovalRecord | null> {
    const r = await execute<ApprovalRow>(this.db, `SELECT ${APPROVAL_COLUMNS} FROM kauro.approvals WHERE plan_id = $1 AND withdrawn_at IS NULL`, [planId]);
    return r.rows[0] ? approvalRecord(r.rows[0]) : null;
  }

  async insert(approval: NewApproval): Promise<ApprovalRecord> {
    const r = await execute<ApprovalRow>(
      this.db,
      `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, version, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING ${APPROVAL_COLUMNS}`,
      [
        approval.approvalId,
        approval.agencyId,
        approval.planId,
        approval.actorId,
        approval.actorMembershipId,
        approval.actorMembershipVersion,
        approval.assuranceProofRef,
        approval.planHash,
        approval.revisionHash,
        approval.targetContractHash,
        approval.validationReceiptHash,
        approval.disclosuresHash,
        approval.approvalHash,
        approval.createdAt,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new DomainFailure("INTEGRITY_FAILURE", "approval insert returned no row");
    return approvalRecord(row);
  }

  async withdraw(approvalId: ApprovalId, expectedVersion: number, by: { readonly membershipId: MembershipId; readonly reasonCode: string }, now: UtcInstant): Promise<VersionedWrite<ApprovalRecord>> {
    const r = await execute<ApprovalRow>(
      this.db,
      `UPDATE kauro.approvals SET withdrawn_at = $3, withdrawn_by_membership_id = $4, withdraw_reason_code = $5, version = $2 + 1
       WHERE approval_id = $1 AND version = $2 AND withdrawn_at IS NULL RETURNING ${APPROVAL_COLUMNS}`,
      [approvalId, expectedVersion, now, by.membershipId, by.reasonCode],
    );
    const row = r.rows[0];
    if (row) return { kind: "APPLIED", record: approvalRecord(row) };
    const current = await execute<{ version: string; withdrawn_at: Date | null }>(this.db, "SELECT version, withdrawn_at FROM kauro.approvals WHERE approval_id = $1", [approvalId]);
    const c = current.rows[0];
    if (!c) throw new DomainFailure("NOT_FOUND", "approval is not visible in this context");
    return { kind: "STALE", currentVersion: int(c.version), currentState: c.withdrawn_at === null ? "LIVE" : "WITHDRAWN" };
  }
}
