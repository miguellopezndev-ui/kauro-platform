/**
 * Import stages and their receipts (package B17; registry commands CMD040 SubmitStageReceipt and CMD041 ContinueStage, manual 05):
 * the stage a Kauro package prepared for the agency to import into its CRM, the receipt the agency uploads (the source-to-target
 * identity mapping the CRM produced), the pure validation of that receipt against the stage's exact membership, and the reasons the
 * two commands refuse with.
 *
 * A stage is a preparation step, not proof the customer imported successfully (ImportStage invariant): only a receipt whose every
 * source identity is accounted for verifies it. The receipt document is DATA in a closed shape; it is hashed, never executed.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DOMAINS, structuredDigest } from "@kauro/contracts";
import type { AgencyId, ArtifactRef, PlanId, ProjectId } from "./ids.js";

export const IMPORT_STAGE_STATES = [
  "PREPARED",
  "RELEASED",
  "AWAITING_AGENCY_IMPORT",
  "RECEIPT_UPLOADED",
  "RECEIPT_VALIDATING",
  "VERIFIED_SUCCESS",
  "VERIFIED_PARTIAL",
  "NEEDS_CORRECTION",
  "CANCELLED",
  "EXPIRED",
] as const;
export type ImportStageState = (typeof IMPORT_STAGE_STATES)[number];

/** The pinned receipt validator (StageReceipt.validatorVersion): a change of the validation rules is a new version. */
export const RECEIPT_VALIDATOR_VERSION = "kauro-stage-receipt-validator-1";

/** The reasons of CMD040 and CMD041 (appended to the closed FAILURE_REASONS of model/errors.ts). */
export const IMPORT_STAGE_FAILURE_REASONS = [
  // CMD040: the stage is not awaiting a receipt
  "STAGE_NOT_AWAITING_RECEIPT",
  // CMD041: the stage is not in a state a continuation acts on
  "STAGE_NOT_CONTINUABLE",
  // CMD040, CMD041: the bounded workflow deadline passed on the database's clock: explicit recovery, never a guessed continuation
  "STAGE_EXPIRED",
  // CMD040: the receipt names another target instance or another package than the stage's
  "RECEIPT_INSTANCE_MISMATCH",
  "RECEIPT_PACKAGE_MISMATCH",
  // CMD040: the receipt document is not the closed shape
  "RECEIPT_INVALID",
  // CMD040: the receipt names source identities that are not members of the stage
  "RECEIPT_FOREIGN_IDS",
  // CMD040: these exact receipt bytes were already submitted for the stage (a correction is new evidence)
  "RECEIPT_ALREADY_SUBMITTED",
  // CMD041: the stored mapping is not the mapping its digest names
  "RECEIPT_DIGEST_MISMATCH",
  // CMD041: the continuation was already recorded
  "STAGE_ALREADY_CONTINUED",
  // CMD041: a required parent stage is not verified
  "PARENT_STAGE_NOT_VERIFIED",
  // CMD041: the stage's child plan is not an APPROVED plan
  "CHILD_PLAN_NOT_APPROVED",
  // CMD041: the stage's target instance is not the project's current target
  "STAGE_TARGET_MISMATCH",
  // CMD040 (R2-024): a receipt row's correlation key is not this stage's for that source identity (a receipt of another stage)
  "RECEIPT_FOREIGN_STAGE",
  // CMD040 (R2-023): the receipt claims MATCHED for a child source one of whose parent identities is not MATCHED (a blocked edge)
  "CHILD_EDGE_BLOCKED",
  // CMD041 (R2-023, R2-025): a parent of the stage holds an open receipt reconciliation: its identity is not settled
  "PARENT_IDENTITY_UNDER_RECONCILIATION",
] as const;
export type ImportStageFailureReason = (typeof IMPORT_STAGE_FAILURE_REASONS)[number];

export interface ImportStageRecord {
  readonly stageId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly sequence: number;
  readonly objectApiName: string;
  readonly operation: "CREATE_ONLY" | "UPDATE_ONLY" | "UPSERT" | "ASSOCIATION_ONLY";
  readonly state: ImportStageState;
  readonly parentStageIds: ReadonlyArray<string>;
  readonly packageHash: Sha256Hex;
  readonly receiptRequired: boolean;
  readonly expiresAt: UtcInstant;
  /** The destination instance the stage's records were prepared for. */
  readonly instanceId: string;
  /** The child plan this stage belongs to (it must be APPROVED for a continuation). */
  readonly planId: PlanId;
  /** The exact source identities the stage's package contains (its membership). */
  readonly sourceIds: ReadonlyArray<string>;
  /** The parent identity each child source depends on (compiled with the stage, immutable; R2-023). */
  readonly parentEdges: ReadonlyArray<StageParentEdge>;
  readonly version: number;
  readonly continuedAt?: UtcInstant;
  readonly continuedByMembershipId?: string;
  readonly continuationReceiptHash?: Sha256Hex;
}

export interface StageParentEdge {
  readonly childSourceId: string;
  readonly parentStageId: string;
  readonly parentSourceId: string;
}

/**
 * MATCHED, FAILED, UNRESOLVED as the receipt says; BLOCKED_BY_PARENT for a child source one of whose parent identities is not MATCHED in
 * that parent's latest receipt (R2-023: "the omitted dependencies remain explicit exceptions"). A blocked source counts as failed.
 */
export type ReceiptDisposition = "MATCHED" | "FAILED" | "UNRESOLVED" | "BLOCKED_BY_PARENT";
/** What a validated receipt concluded: every identity matched; a fully accounted partition with failures; or unresolved identities. */
export type ReceiptResult = "COMPLETE" | "PARTIAL_ACCOUNTED" | "NEEDS_CORRECTION";

export interface ReceiptMappingRow {
  readonly sourceId: string;
  readonly disposition: ReceiptDisposition;
  /** The CRM identity of a MATCHED row; absent otherwise. */
  readonly targetId?: string;
}

export interface StageReceiptRecord {
  readonly receiptId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly stageId: string;
  readonly revision: number;
  readonly instanceId: string;
  readonly sourcePackageHash: Sha256Hex;
  readonly receiptUploadRef: ArtifactRef;
  readonly receiptFileHash: Sha256Hex;
  readonly identityMappingHash: Sha256Hex;
  readonly matchedRows: number;
  readonly failedRows: number;
  readonly unresolvedRows: number;
  readonly result: ReceiptResult;
  readonly mapping: ReadonlyArray<ReceiptMappingRow>;
  readonly validatedAt: UtcInstant;
  readonly validatorVersion: string;
  readonly submittedByMembershipId: string;
}

export interface NewStageReceipt {
  readonly receiptId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly stageId: string;
  readonly instanceId: string;
  readonly sourcePackageHash: Sha256Hex;
  readonly receiptUploadRef: ArtifactRef;
  readonly receiptFileHash: Sha256Hex;
  readonly identityMappingHash: Sha256Hex;
  readonly matchedRows: number;
  readonly failedRows: number;
  readonly unresolvedRows: number;
  readonly result: ReceiptResult;
  readonly mapping: ReadonlyArray<ReceiptMappingRow>;
  readonly submittedByMembershipId: string;
}

const MAX_ROWS = 5000;
const ID_MAX = 255;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function idText(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
}

export interface ParsedReceiptRow {
  readonly sourceId: string;
  readonly status: "MATCHED" | "FAILED";
  readonly targetId?: string;
  /** stageCorrelationKey(stageId, packageHash, sourceId): binds the row to the stage it was produced for (R2-024). */
  readonly correlationKey: string;
}
export interface ParsedReceipt {
  readonly rows: ReadonlyArray<ParsedReceiptRow>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The closed check of an uploaded receipt document: exactly `rows`, each row exactly sourceId + status + correlationKey (+ targetId,
 * required for MATCHED and refused for FAILED). Returns the typed document or null (a verified flag or any other member is refused).
 */
export function parseStageReceipt(document: unknown): ParsedReceipt | null {
  if (!isRecord(document) || Object.keys(document).length !== 1 || !Array.isArray(document["rows"])) return null;
  const rows = document["rows"] as unknown[];
  if (rows.length > MAX_ROWS) return null;
  const out: ParsedReceiptRow[] = [];
  for (const r of rows) {
    if (!isRecord(r) || !Object.keys(r).every((k) => k === "sourceId" || k === "status" || k === "targetId" || k === "correlationKey")) return null;
    if (!idText(r["sourceId"]) || (r["status"] !== "MATCHED" && r["status"] !== "FAILED")) return null;
    const correlationKey = r["correlationKey"];
    if (typeof correlationKey !== "string" || !SHA256_HEX.test(correlationKey)) return null;
    if (r["status"] === "MATCHED") {
      if (!idText(r["targetId"])) return null;
      out.push({ sourceId: r["sourceId"], status: "MATCHED", targetId: r["targetId"], correlationKey });
    } else {
      if ("targetId" in r) return null;
      out.push({ sourceId: r["sourceId"], status: "FAILED", correlationKey });
    }
  }
  return { rows: out };
}

/**
 * KAURO_STAGE_CORRELATION_V1 (R2-024, 05:103 "Kauro validates that the receipt belongs to the purchased stage"): the key a stage's package
 * gives each of its source identities; a receipt row carries it back, so a receipt of another stage with the same rows never validates.
 */
export function stageCorrelationKey(stageId: string, packageHash: Sha256Hex, sourceId: string): Sha256Hex {
  return structuredDigest(DOMAINS.STAGE_CORRELATION, 1, { stageId, packageHash, sourceId });
}

/** Whether some row's correlation key is not the stage's key for that row's source identity (row r foreign iff r.correlationKey != key). */
export function receiptOfAnotherStage(stage: Pick<ImportStageRecord, "stageId" | "packageHash">, parsed: ParsedReceipt): boolean {
  return parsed.rows.some((r) => r.correlationKey !== stageCorrelationKey(stage.stageId, stage.packageHash, r.sourceId));
}

/**
 * The child sources of a stage that are blocked by a parent (R2-023: "Dependent stages can proceed only for an approved subset with complete
 * parent identities"): a child source is admitted iff every edge of it names a parent source that is MATCHED in that parent's latest receipt
 * mapping. `parentMappings` holds the latest mapping of each parent stage (a parent with none blocks every edge into it).
 */
export function blockedChildSources(edges: ReadonlyArray<StageParentEdge>, parentMappings: ReadonlyMap<string, ReadonlyArray<ReceiptMappingRow>>): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const e of edges) {
    const row = parentMappings.get(e.parentStageId)?.find((m) => m.sourceId === e.parentSourceId);
    if (row?.disposition !== "MATCHED") blocked.add(e.childSourceId);
  }
  return blocked;
}

export type ReceiptValidation =
  | { readonly kind: "FOREIGN_IDS"; readonly count: number }
  | { readonly kind: "CHILD_EDGE_BLOCKED"; readonly sourceIds: ReadonlyArray<string> }
  | {
      readonly kind: "VALIDATED";
      readonly mapping: ReadonlyArray<ReceiptMappingRow>;
      readonly matchedRows: number;
      readonly failedRows: number;
      readonly unresolvedRows: number;
      readonly result: ReceiptResult;
    };

/**
 * Validates a receipt against the stage's exact membership (CMD040 effect "Validate exact membership and source-to-target IDs, including
 * failed and missing records"). A source identity the stage does not contain refuses the whole receipt (FOREIGN_IDS). A child source whose
 * parent identity is blocked (`blocked`) is BLOCKED_BY_PARENT, counted as failed, whether the receipt names it FAILED or omits it; a receipt
 * that claims MATCHED for it is refused (CHILD_EDGE_BLOCKED). Within the membership every other identity gets one disposition: MATCHED (one
 * row, a target identity no other source claimed), FAILED (one explicit failure row) or UNRESOLVED (missing, named twice, or mapped to a
 * target identity that another source also claims): an ambiguous identity is never guessed, it blocks the child edges that need it.
 */
export function validateStageReceipt(sourceIds: ReadonlyArray<string>, parsed: ParsedReceipt, blocked: ReadonlySet<string> = new Set()): ReceiptValidation {
  const members = new Set(sourceIds);
  const foreign = new Set(parsed.rows.filter((r) => !members.has(r.sourceId)).map((r) => r.sourceId));
  if (foreign.size > 0) return { kind: "FOREIGN_IDS", count: foreign.size };
  const claimedBlocked = [...new Set(parsed.rows.filter((r) => r.status === "MATCHED" && blocked.has(r.sourceId)).map((r) => r.sourceId))].sort();
  if (claimedBlocked.length > 0) return { kind: "CHILD_EDGE_BLOCKED", sourceIds: claimedBlocked };

  const bySource = new Map<string, ParsedReceiptRow[]>();
  for (const r of parsed.rows) bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);
  const claimants = new Map<string, Set<string>>();
  for (const r of parsed.rows) {
    if (r.status === "MATCHED" && r.targetId !== undefined) claimants.set(r.targetId, (claimants.get(r.targetId) ?? new Set<string>()).add(r.sourceId));
  }

  const mapping: ReceiptMappingRow[] = [];
  let matched = 0;
  let failed = 0;
  let unresolved = 0;
  for (const sourceId of [...members].sort()) {
    const rows = bySource.get(sourceId) ?? [];
    const only = rows.length === 1 ? rows[0] : undefined;
    if (blocked.has(sourceId)) {
      mapping.push({ sourceId, disposition: "BLOCKED_BY_PARENT" });
      failed += 1;
    } else if (only === undefined) {
      mapping.push({ sourceId, disposition: "UNRESOLVED" });
      unresolved += 1;
    } else if (only.status === "FAILED") {
      mapping.push({ sourceId, disposition: "FAILED" });
      failed += 1;
    } else if ((claimants.get(only.targetId as string)?.size ?? 0) > 1) {
      mapping.push({ sourceId, disposition: "UNRESOLVED" });
      unresolved += 1;
    } else {
      mapping.push({ sourceId, disposition: "MATCHED", targetId: only.targetId as string });
      matched += 1;
    }
  }
  const result: ReceiptResult = unresolved > 0 ? "NEEDS_CORRECTION" : failed > 0 ? "PARTIAL_ACCOUNTED" : "COMPLETE";
  return { kind: "VALIDATED", mapping, matchedRows: matched, failedRows: failed, unresolvedRows: unresolved, result };
}
/**
 * KAURO_STAGE_IDENTITY_MAPPING_V1: the stage, its destination instance, its exact package and the complete source-to-target disposition
 * of every member bind together; a continuation names this digest, so it can only continue the identities that were validated.
 */
export function stageIdentityMappingDigest(input: {
  readonly stageId: string;
  readonly instanceId: string;
  readonly sourcePackageHash: Sha256Hex;
  readonly mapping: ReadonlyArray<ReceiptMappingRow>;
}): Sha256Hex {
  return structuredDigest(DOMAINS.STAGE_IDENTITY_MAPPING, 1, {
    stageId: input.stageId,
    instanceId: input.instanceId,
    sourcePackageHash: input.sourcePackageHash,
    mapping: input.mapping.map((m) => (m.targetId === undefined ? { sourceId: m.sourceId, disposition: m.disposition } : { sourceId: m.sourceId, disposition: m.disposition, targetId: m.targetId })),
  });
}

/**
 * The stage state a validated receipt leaves (registry ImportStage: receipt_complete, receipt_missing_or_ambiguous, and the fully accounted
 * partition awaiting the approver's approved_partial_scope_accounted): COMPLETE verifies the stage, PARTIAL_ACCOUNTED keeps it
 * RECEIPT_VALIDATING until CMD041 approves the partial scope, anything unresolved needs a correction.
 */
export function applyReceiptOutcome(result: ReceiptResult): ImportStageState {
  return result === "COMPLETE" ? "VERIFIED_SUCCESS" : result === "PARTIAL_ACCOUNTED" ? "RECEIPT_VALIDATING" : "NEEDS_CORRECTION";
}

/**
 * A receipt reconciliation (R2-025, 05:115 "A different receipt for a finalized stage becomes a reconciliation request, not an overwrite"):
 * one per (stage, content hash), born OPEN, append-only; the stage's identity and receipts stay as they were (migration 0072).
 */
export interface StageReceiptReconciliationRecord {
  readonly reconciliationId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly stageId: string;
  readonly contentHash: Sha256Hex;
  readonly receiptUploadRef: ArtifactRef;
  readonly state: "OPEN";
  readonly openedByMembershipId: string;
  readonly openedAt: UtcInstant;
}

export interface NewStageReceiptReconciliation {
  readonly reconciliationId: string;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly stageId: string;
  readonly contentHash: Sha256Hex;
  readonly receiptUploadRef: ArtifactRef;
  readonly openedByMembershipId: string;
}

/** What the stage already holds for one content hash: the receipt revision with those bytes, or the reconciliation opened for them. */
export interface StageReceiptStatus {
  readonly receipt: StageReceiptRecord | null;
  readonly reconciliation: StageReceiptReconciliationRecord | null;
}
