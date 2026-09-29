/**
 * Row plumbing of the audit adapters (package B08, mandate B08-PERSISTENCE-AUDIT; migration 0021). Every instant is read back exactly
 * as the database stamped it (B07's `exact`, microseconds; D8-CLOCK-1), never through a JavaScript Date; money arrives as the text of a
 * BIGINT and is read as bigint (like package B09's); records omit absent optional members (exactOptionalPropertyTypes).
 */
import type { Id, Sha256Hex } from "@kauro/contracts";
import type {
  AgencyId,
  ArtifactRef,
  AuditId,
  AuditRecord,
  AuditState,
  AuditStepId,
  AuditStepKind,
  AuditStepOutcome,
  AuditStepRecord,
  CostGrantId,
  CostGrantKind,
  CostGrantRecord,
  CostGrantState,
  DecisionArtifactKind,
  DecisionArtifactRecord,
  MembershipId,
  ModelTaskId,
  ModelTaskJournalEntry,
  ModelTaskRecord,
  PlanId,
  PlanValidationId,
  PlanValidationOrigin,
  PlanValidationRecord,
  PlanValidationResult,
  ProjectId,
  RevisionId,
  TargetContractId,
} from "@kauro/domain";
import { int } from "../sql.js";
import { exact, instantText, jsonArray, jsonObject, opt, optionalInstantText, optionalString, str } from "../source/rows.js";

export type Row = Record<string, unknown>;

/** A selected column: a plain expression, or an instant read back exactly (B07 `exact`) under its own name. */
type ColumnSpec = string | { readonly instant: string };

function columnsOf(specs: ReadonlyArray<ColumnSpec>, alias?: string): string {
  const q = (c: string): string => (alias === undefined ? c : `${alias}.${c}`);
  return specs.map((c) => (typeof c === "string" ? q(c) : exact(q(c.instant), c.instant))).join(", ");
}

/** A BIGINT money column read as its text (the select lists cast it) into bigint cents. */
export function cents(v: unknown): bigint {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError("expected an integer money column value");
}

// --- cost grants ------------------------------------------------------------------------------------------------------------

const GRANT_SPECS: ReadonlyArray<ColumnSpec> = [
  "grant_id",
  "agency_id",
  "grant_kind",
  "pool_grant_id",
  "currency",
  "ceiling_cents::text AS ceiling_cents",
  "reserved_cents::text AS reserved_cents",
  "reconciled_spend_cents::text AS reconciled_spend_cents",
  "price_profile_hash",
  "authorization_ref",
  { instant: "expires_at" },
  "version::text AS version",
  "state",
  { instant: "authorized_at" },
  { instant: "expired_at" },
  { instant: "closed_at" },
  { instant: "created_at" },
  { instant: "updated_at" },
];
export const GRANT_COLUMNS = columnsOf(GRANT_SPECS);
export function grantColumnsOf(alias: string): string {
  return columnsOf(GRANT_SPECS, alias);
}

export function grantRecord(r: Row): CostGrantRecord {
  return {
    grantId: str<CostGrantId>(r["grant_id"]),
    ...opt("agencyId", optionalString<AgencyId>(r["agency_id"])),
    kind: str<CostGrantKind>(r["grant_kind"]),
    ...opt("poolGrantId", optionalString<CostGrantId>(r["pool_grant_id"])),
    currency: str<"USD">(r["currency"]),
    ceilingCents: cents(r["ceiling_cents"]),
    reservedCents: cents(r["reserved_cents"]),
    reconciledSpendCents: cents(r["reconciled_spend_cents"]),
    priceProfileHash: str<Sha256Hex>(r["price_profile_hash"]),
    ...opt("authorizationRef", optionalString<Id>(r["authorization_ref"])),
    expiresAt: instantText(r["expires_at"]),
    version: int(r["version"]),
    state: str<CostGrantState>(r["state"]),
    ...opt("authorizedAt", optionalInstantText(r["authorized_at"])),
    ...opt("expiredAt", optionalInstantText(r["expired_at"])),
    ...opt("closedAt", optionalInstantText(r["closed_at"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

// --- audits -------------------------------------------------------------------------------------------------------------------

const AUDIT_SPECS: ReadonlyArray<ColumnSpec> = [
  "audit_id",
  "agency_id",
  "project_id",
  "revision_id",
  "revision_hash",
  "target_contract_id",
  "target_contract_hash",
  "audit_policy_version",
  "requested_by_membership_id",
  "grant_id",
  "version::text AS version",
  "state",
  "fence::text AS fence",
  "cancel_version::text AS cancel_version",
  "cancel_actor_kind",
  "cancel_actor_id",
  { instant: "started_at" },
  { instant: "absolute_deadline_at" },
  { instant: "interpretation_deadline_at" },
  "profile_evidence_hash",
  "candidate_manifest_hash",
  "draft_plan_id",
  "finding_codes",
  "terminal_reason",
  { instant: "profiling_at" },
  { instant: "interpreting_at" },
  { instant: "validating_at" },
  { instant: "terminal_at" },
  { instant: "created_at" },
  { instant: "updated_at" },
];
export const AUDIT_COLUMNS = columnsOf(AUDIT_SPECS);
export function auditColumnsOf(alias: string): string {
  return columnsOf(AUDIT_SPECS, alias);
}

export function auditRecord(r: Row): AuditRecord {
  const cancelKind = optionalString<"USER" | "SERVICE">(r["cancel_actor_kind"]);
  const cancelId = optionalString(r["cancel_actor_id"]);
  return {
    auditId: str<AuditId>(r["audit_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    revisionId: str<RevisionId>(r["revision_id"]),
    revisionHash: str<Sha256Hex>(r["revision_hash"]),
    targetContractId: str<TargetContractId>(r["target_contract_id"]),
    targetContractHash: str<Sha256Hex>(r["target_contract_hash"]),
    auditPolicyVersion: str(r["audit_policy_version"]),
    requestedByMembershipId: str<MembershipId>(r["requested_by_membership_id"]),
    grantId: str<CostGrantId>(r["grant_id"]),
    state: str<AuditState>(r["state"]),
    version: int(r["version"]),
    fence: int(r["fence"]),
    cancelVersion: int(r["cancel_version"]),
    ...opt("cancelActor", cancelKind === undefined || cancelId === undefined ? undefined : cancelKind === "USER" ? { kind: "USER" as const, userId: cancelId } : { kind: "SERVICE" as const, serviceId: cancelId }),
    startedAt: instantText(r["started_at"]),
    absoluteDeadlineAt: instantText(r["absolute_deadline_at"]),
    ...opt("interpretationDeadlineAt", optionalInstantText(r["interpretation_deadline_at"])),
    ...opt("profileEvidenceHash", optionalString<Sha256Hex>(r["profile_evidence_hash"])),
    ...opt("candidateManifestHash", optionalString<Sha256Hex>(r["candidate_manifest_hash"])),
    ...opt("draftPlanId", optionalString<PlanId>(r["draft_plan_id"])),
    findingCodes: jsonArray<string>(r["finding_codes"]),
    ...opt("terminalReason", optionalString(r["terminal_reason"])),
    ...opt("profilingAt", optionalInstantText(r["profiling_at"])),
    ...opt("interpretingAt", optionalInstantText(r["interpreting_at"])),
    ...opt("validatingAt", optionalInstantText(r["validating_at"])),
    ...opt("terminalAt", optionalInstantText(r["terminal_at"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

// --- steps, model tasks and the journal -----------------------------------------------------------------------------------------

export const STEP_COLUMNS = columnsOf([
  "step_id",
  "agency_id",
  "audit_id",
  "kind",
  "fence::text AS fence",
  "outcome",
  "evidence_hash",
  "evidence_class",
  { instant: "claimed_at" },
  { instant: "recorded_at" },
]);

export function stepRecord(r: Row): AuditStepRecord {
  return {
    stepId: str<AuditStepId>(r["step_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    auditId: str<AuditId>(r["audit_id"]),
    kind: str<AuditStepKind>(r["kind"]),
    fence: int(r["fence"]),
    claimedAt: instantText(r["claimed_at"]),
    ...opt("outcome", optionalString<AuditStepOutcome>(r["outcome"])),
    ...opt("evidenceHash", optionalString<Sha256Hex>(r["evidence_hash"])),
    ...opt("evidenceClass", optionalString<"EXECUTED_LOCAL" | "SIMULATED">(r["evidence_class"])),
    ...opt("recordedAt", optionalInstantText(r["recorded_at"])),
  };
}

export const MODEL_TASK_COLUMNS = columnsOf([
  "model_task_id",
  "agency_id",
  "audit_id",
  "grant_id",
  "step_fence::text AS step_fence",
  "task_key",
  "candidate_manifest_hash",
  "policy_hash",
  "minimized_request_hash",
  "provider_profile_id",
  "maximum_cost_cents::text AS maximum_cost_cents",
  { instant: "interpretation_deadline_at" },
  { instant: "audit_deadline_at" },
  { instant: "created_at" },
]);

export function modelTaskRecord(r: Row): ModelTaskRecord {
  return {
    modelTaskId: str<ModelTaskId>(r["model_task_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    auditId: str<AuditId>(r["audit_id"]),
    grantId: str<CostGrantId>(r["grant_id"]),
    stepFence: int(r["step_fence"]),
    taskKey: str<Sha256Hex>(r["task_key"]),
    candidateManifestHash: str<Sha256Hex>(r["candidate_manifest_hash"]),
    policyHash: str<Sha256Hex>(r["policy_hash"]),
    minimizedRequestHash: str<Sha256Hex>(r["minimized_request_hash"]),
    providerProfileId: str<Id>(r["provider_profile_id"]),
    maximumCostCents: cents(r["maximum_cost_cents"]),
    interpretationDeadlineAt: instantText(r["interpretation_deadline_at"]),
    auditDeadlineAt: instantText(r["audit_deadline_at"]),
    createdAt: instantText(r["created_at"]),
  };
}

export const JOURNAL_COLUMNS = columnsOf(["run_id", "position", "audit_id", "step_fence::text AS step_fence", "event", "event_hash", { instant: "appended_at" }]);

export function journalEntry(r: Row): ModelTaskJournalEntry {
  return {
    runId: str<Id>(r["run_id"]),
    position: int(r["position"]),
    auditId: str<AuditId>(r["audit_id"]),
    stepFence: int(r["step_fence"]),
    event: jsonObject<Readonly<Record<string, unknown>>>(r["event"]),
    eventHash: str<Sha256Hex>(r["event_hash"]),
    appendedAt: instantText(r["appended_at"]),
  };
}

// --- decision artifacts and validation intents -----------------------------------------------------------------------------------

export const ARTIFACT_COLUMNS = columnsOf(["artifact_id", "agency_id", "audit_id", "kind", "document", "content_hash", "created_by_membership_id", { instant: "created_at" }]);

export function artifactRecord(r: Row): DecisionArtifactRecord {
  return {
    artifactRef: str<ArtifactRef>(r["artifact_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    auditId: str<AuditId>(r["audit_id"]),
    kind: str<DecisionArtifactKind>(r["kind"]),
    document: jsonObject<Readonly<Record<string, unknown>>>(r["document"]),
    contentHash: str<Sha256Hex>(r["content_hash"]),
    createdByMembershipId: str<MembershipId>(r["created_by_membership_id"]),
    createdAt: instantText(r["created_at"]),
  };
}

const VALIDATION_SPECS: ReadonlyArray<ColumnSpec> = [
  "validation_id",
  "agency_id",
  "plan_id",
  "plan_hash",
  "revision_hash",
  "target_contract_hash",
  "fence::text AS fence",
  "origin",
  "requested_by_membership_id",
  "audit_id",
  { instant: "requested_at" },
  "result",
  "receipt_hash",
  { instant: "settled_at" },
];
export const VALIDATION_COLUMNS = columnsOf(VALIDATION_SPECS);

export function validationRecord(r: Row): PlanValidationRecord {
  return {
    validationId: str<PlanValidationId>(r["validation_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    planId: str<PlanId>(r["plan_id"]),
    planHash: str<Sha256Hex>(r["plan_hash"]),
    revisionHash: str<Sha256Hex>(r["revision_hash"]),
    targetContractHash: str<Sha256Hex>(r["target_contract_hash"]),
    fence: int(r["fence"]),
    origin: str<PlanValidationOrigin>(r["origin"]),
    ...opt("requestedByMembershipId", optionalString<MembershipId>(r["requested_by_membership_id"])),
    ...opt("auditId", optionalString<AuditId>(r["audit_id"])),
    requestedAt: instantText(r["requested_at"]),
    ...opt("result", optionalString<PlanValidationResult>(r["result"])),
    ...opt("receiptHash", optionalString<Sha256Hex>(r["receipt_hash"])),
    ...opt("settledAt", optionalInstantText(r["settled_at"])),
  };
}
