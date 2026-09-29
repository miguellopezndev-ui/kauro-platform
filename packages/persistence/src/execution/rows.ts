/**
 * Row plumbing of the execution adapters (package B08, mandate B08-PERSISTENCE-EXECUTION; migrations 0019 and 0020). Every instant
 * is read back exactly as the database stamped it (B07's `exact`, microseconds; D8-CLOCK-1), never through a JavaScript Date; records
 * omit absent optional members (exactOptionalPropertyTypes).
 */
import type { Sha256Hex } from "@kauro/contracts";
import type {
  AgencyId,
  ApprovalId,
  ArtifactReadbackId,
  ArtifactReadbackRecord,
  AttemptCleanupId,
  AttemptCleanupRecord,
  AttemptState,
  CapabilityId,
  CaptureId,
  CommercialAuthorizationId,
  DeliveryArtifactRecord,
  JobHolds,
  JobState,
  LaunchState,
  MembershipId,
  PackageState,
  PackageVerificationId,
  PackageVerificationRecord,
  PackageVersionId,
  PackageVersionRecord,
  PlanId,
  ProcessingAttemptId,
  ProcessingAttemptRecord,
  ProcessingJobId,
  ProcessingJobRecord,
  ProjectId,
  ReadbackKind,
  ReadbackResult,
  ServiceMode,
  StagedArtifactRecord,
  StagedManifestRecord,
  StoredObjectId,
  TerminationResult,
  VerificationEvidenceClass,
  VerificationResult,
} from "@kauro/domain";
import { int } from "../sql.js";
import { exact, instantText, jsonArray, opt, optionalInstantText, optionalInt, optionalString, str } from "../source/rows.js";

export type Row = Record<string, unknown>;

/** A selected column: a plain expression, or an instant read back exactly (B07 `exact`) under its own name. */
type ColumnSpec = string | { readonly instant: string };

/** The select list of `specs`, each column qualified by `alias` when given. */
function columnsOf(specs: ReadonlyArray<ColumnSpec>, alias?: string): string {
  const q = (c: string): string => (alias === undefined ? c : `${alias}.${c}`);
  return specs.map((c) => (typeof c === "string" ? q(c) : exact(q(c.instant), c.instant))).join(", ");
}

const JOB_SPECS: ReadonlyArray<ColumnSpec> = [
  "job_id",
  "agency_id",
  "project_id",
  "authorization_id",
  "capture_id",
  "plan_id",
  "plan_hash",
  "approval_id",
  "approval_hash",
  "revision_hash",
  "target_contract_hash",
  "capability_id",
  "capability_version",
  "mode",
  "validation_receipt_hash",
  "core_package_hash",
  "input_binding_hash",
  "version::text AS version",
  "state",
  "holds",
  "attempt_count",
  "current_attempt_id",
  "fence::text AS fence",
  { instant: "delivery_deadline_at" },
  { instant: "execution_deadline_at" },
  { instant: "queued_at" },
  { instant: "admitted_at" },
  { instant: "started_at" },
  { instant: "verifying_at" },
  { instant: "ready_at" },
  { instant: "cancel_requested_at" },
  { instant: "terminal_at" },
  "terminal_reason",
  "cancel_version::text AS cancel_version",
  "cancel_actor_kind",
  "cancel_actor_id",
  "cancel_reason_code",
  "published_package_id",
  "created_by_membership_id",
  { instant: "created_at" },
  { instant: "updated_at" },
];
export const JOB_COLUMNS = columnsOf(JOB_SPECS);

/** The job columns qualified by an alias (for UPDATE ... RETURNING through a self-join). */
export function jobColumnsOf(alias: string): string {
  return columnsOf(JOB_SPECS, alias);
}

export function jobRecord(r: Row): ProcessingJobRecord {
  const cancelKind = optionalString<"USER" | "SERVICE">(r["cancel_actor_kind"]);
  const cancelId = optionalString(r["cancel_actor_id"]);
  return {
    jobId: str<ProcessingJobId>(r["job_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    authorizationId: str<CommercialAuthorizationId>(r["authorization_id"]),
    captureId: str<CaptureId>(r["capture_id"]),
    planId: str<PlanId>(r["plan_id"]),
    planHash: str<Sha256Hex>(r["plan_hash"]),
    approvalId: str<ApprovalId>(r["approval_id"]),
    approvalHash: str<Sha256Hex>(r["approval_hash"]),
    revisionHash: str<Sha256Hex>(r["revision_hash"]),
    targetContractHash: str<Sha256Hex>(r["target_contract_hash"]),
    capabilityId: str<CapabilityId>(r["capability_id"]),
    capabilityVersion: str(r["capability_version"]),
    mode: str<ServiceMode>(r["mode"]),
    validationReceiptHash: str<Sha256Hex>(r["validation_receipt_hash"]),
    corePackageHash: str<Sha256Hex>(r["core_package_hash"]),
    inputBindingHash: str<Sha256Hex>(r["input_binding_hash"]),
    version: int(r["version"]),
    state: str<JobState>(r["state"]),
    holds: str<JobHolds>(r["holds"]),
    attemptCount: int(r["attempt_count"]),
    ...opt("currentAttemptId", optionalString<ProcessingAttemptId>(r["current_attempt_id"])),
    fence: int(r["fence"]),
    deliveryDeadlineAt: instantText(r["delivery_deadline_at"]),
    ...opt("executionDeadlineAt", optionalInstantText(r["execution_deadline_at"])),
    queuedAt: instantText(r["queued_at"]),
    ...opt("admittedAt", optionalInstantText(r["admitted_at"])),
    ...opt("startedAt", optionalInstantText(r["started_at"])),
    ...opt("verifyingAt", optionalInstantText(r["verifying_at"])),
    ...opt("readyAt", optionalInstantText(r["ready_at"])),
    ...opt("cancelRequestedAt", optionalInstantText(r["cancel_requested_at"])),
    ...opt("terminalAt", optionalInstantText(r["terminal_at"])),
    ...opt("terminalReason", optionalString(r["terminal_reason"])),
    cancelVersion: int(r["cancel_version"]),
    ...opt("cancelActor", cancelKind === undefined || cancelId === undefined ? undefined : cancelKind === "USER" ? { kind: "USER" as const, userId: cancelId } : { kind: "SERVICE" as const, serviceId: cancelId }),
    ...opt("cancelReasonCode", optionalString(r["cancel_reason_code"])),
    ...opt("publishedPackageId", optionalString<PackageVersionId>(r["published_package_id"])),
    createdByMembershipId: str<MembershipId>(r["created_by_membership_id"]),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

export const ATTEMPT_COLUMNS = [
  "attempt_id",
  "agency_id",
  "project_id",
  "job_id",
  "ordinal",
  "state",
  "fence::text AS fence",
  "identity",
  "staging_prefix",
  "manifest_object_name",
  "launch_state",
  "provider_job_id",
  exact("claimed_at"),
  exact("launch_intent_at"),
  exact("launch_recorded_at"),
  exact("started_at"),
  exact("staged_at"),
  exact("verifying_at"),
  exact("ended_at"),
  "terminal_cause",
  exact("created_at"),
  exact("updated_at"),
].join(", ");

export function attemptRecord(r: Row): ProcessingAttemptRecord {
  return {
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    ordinal: int(r["ordinal"]),
    state: str<AttemptState>(r["state"]),
    ...opt("fence", optionalInt(r["fence"])),
    identity: str(r["identity"]),
    stagingPrefix: str(r["staging_prefix"]),
    ...opt("manifestObjectName", optionalString(r["manifest_object_name"])),
    launchState: str<LaunchState>(r["launch_state"]),
    ...opt("providerJobId", optionalString(r["provider_job_id"])),
    ...opt("claimedAt", optionalInstantText(r["claimed_at"])),
    ...opt("launchIntentAt", optionalInstantText(r["launch_intent_at"])),
    ...opt("launchRecordedAt", optionalInstantText(r["launch_recorded_at"])),
    ...opt("startedAt", optionalInstantText(r["started_at"])),
    ...opt("stagedAt", optionalInstantText(r["staged_at"])),
    ...opt("verifyingAt", optionalInstantText(r["verifying_at"])),
    ...opt("endedAt", optionalInstantText(r["ended_at"])),
    ...opt("terminalCause", optionalString(r["terminal_cause"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

export const MANIFEST_COLUMNS = `attempt_id, agency_id, project_id, job_id, fence::text AS fence, input_binding_hash, object_name, generation, manifest_hash, artifact_count, declared_summary_hash, ${exact("submitted_at")}`;

export function manifestRecord(r: Row): StagedManifestRecord {
  return {
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    fence: int(r["fence"]),
    inputBindingHash: str<Sha256Hex>(r["input_binding_hash"]),
    objectName: str(r["object_name"]),
    generation: str(r["generation"]),
    manifestHash: str<Sha256Hex>(r["manifest_hash"]),
    artifactCount: int(r["artifact_count"]),
    declaredSummaryHash: str<Sha256Hex>(r["declared_summary_hash"]),
    submittedAt: instantText(r["submitted_at"]),
  };
}

export const ARTIFACT_COLUMNS = "attempt_id, job_id, agency_id, role, object_name, object_id, generation, sha256, byte_length::text AS byte_length";

export function artifactRecord(r: Row): StagedArtifactRecord {
  return {
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    role: str(r["role"]),
    objectName: str(r["object_name"]),
    objectId: str<StoredObjectId>(r["object_id"]),
    generation: str(r["generation"]),
    sha256: str<Sha256Hex>(r["sha256"]),
    byteLength: int(r["byte_length"]),
  };
}

export const READBACK_COLUMNS = `readback_id, agency_id, job_id, attempt_id, kind, package_version_id, object_name, expected_generation, expected_sha256, expected_bytes::text AS expected_bytes,
  observed_generation, observed_sha256, observed_bytes::text AS observed_bytes, result, ${exact("read_at")}`;

export function readbackRecord(r: Row): ArtifactReadbackRecord {
  const result = str<ReadbackResult>(r["result"]);
  const observedBytes = optionalInt(r["observed_bytes"]);
  return {
    readbackId: str<ArtifactReadbackId>(r["readback_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    kind: str<ReadbackKind>(r["kind"]),
    ...opt("packageVersionId", optionalString<PackageVersionId>(r["package_version_id"])),
    objectName: str(r["object_name"]),
    expected: { generation: str(r["expected_generation"]), sha256: str<Sha256Hex>(r["expected_sha256"]), byteLength: int(r["expected_bytes"]) },
    ...opt(
      "observed",
      result === "MISSING"
        ? undefined
        : { generation: optionalString(r["observed_generation"]) ?? null, sha256: optionalString<Sha256Hex>(r["observed_sha256"]) ?? null, byteLength: observedBytes ?? null },
    ),
    result,
    readAt: instantText(r["read_at"]),
  };
}

export const VERIFICATION_COLUMNS = `verification_id, agency_id, job_id, attempt_id, package_version_id, result, problems, evidence_class, expected_authority_hash, core_version, ${exact("verified_at")}`;

export function verificationRecord(r: Row): PackageVerificationRecord {
  return {
    verificationId: str<PackageVerificationId>(r["verification_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    packageVersionId: str<PackageVersionId>(r["package_version_id"]),
    result: str<VerificationResult>(r["result"]),
    problems: [...jsonArray<string>(r["problems"])],
    evidenceClass: str<VerificationEvidenceClass>(r["evidence_class"]),
    expectedAuthorityHash: str<Sha256Hex>(r["expected_authority_hash"]),
    coreVersion: str(r["core_version"]),
    verifiedAt: instantText(r["verified_at"]),
  };
}

const PACKAGE_SPECS: ReadonlyArray<ColumnSpec> = [
  "package_version_id",
  "agency_id",
  "project_id",
  "job_id",
  "attempt_id",
  "version::text AS version",
  "state",
  "manifest_hash",
  "artifact_count",
  "delivery_prefix",
  "verification_id",
  "delivery_manifest_hash",
  { instant: "verified_at" },
  { instant: "available_at" },
  { instant: "revoked_at" },
  "revocation_reason",
  { instant: "retired_at" },
  { instant: "deleted_at" },
  { instant: "created_at" },
  { instant: "updated_at" },
];
export const PACKAGE_COLUMNS = columnsOf(PACKAGE_SPECS);

/** The package columns qualified by an alias (for UPDATE ... RETURNING through a self-join). */
export function packageColumnsOf(alias: string): string {
  return columnsOf(PACKAGE_SPECS, alias);
}

export function packageRecord(r: Row): PackageVersionRecord {
  return {
    packageVersionId: str<PackageVersionId>(r["package_version_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    projectId: str<ProjectId>(r["project_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    version: int(r["version"]),
    state: str<PackageState>(r["state"]),
    manifestHash: str<Sha256Hex>(r["manifest_hash"]),
    artifactCount: int(r["artifact_count"]),
    deliveryPrefix: str(r["delivery_prefix"]),
    ...opt("verificationId", optionalString<PackageVerificationId>(r["verification_id"])),
    ...opt("deliveryManifestHash", optionalString<Sha256Hex>(r["delivery_manifest_hash"])),
    ...opt("verifiedAt", optionalInstantText(r["verified_at"])),
    ...opt("availableAt", optionalInstantText(r["available_at"])),
    ...opt("revokedAt", optionalInstantText(r["revoked_at"])),
    ...opt("revocationReason", optionalString(r["revocation_reason"])),
    ...opt("retiredAt", optionalInstantText(r["retired_at"])),
    ...opt("deletedAt", optionalInstantText(r["deleted_at"])),
    createdAt: instantText(r["created_at"]),
    updatedAt: instantText(r["updated_at"]),
  };
}

export const DELIVERY_COLUMNS = "package_version_id, agency_id, job_id, attempt_id, role, source_object_name, object_name, object_id, generation, sha256, byte_length::text AS byte_length";

export function deliveryRecord(r: Row): DeliveryArtifactRecord {
  return {
    packageVersionId: str<PackageVersionId>(r["package_version_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    role: str(r["role"]),
    sourceObjectName: str(r["source_object_name"]),
    objectName: str(r["object_name"]),
    objectId: str<StoredObjectId>(r["object_id"]),
    generation: str(r["generation"]),
    sha256: str<Sha256Hex>(r["sha256"]),
    byteLength: int(r["byte_length"]),
  };
}

export const CLEANUP_COLUMNS = `cleanup_id, agency_id, job_id, attempt_id, provider_identity, staging_prefix, deleted_objects, termination_result, scratch_deleted, machine_type, vcpus,
  memory_bytes::text AS memory_bytes, disk_bytes::text AS disk_bytes, peak_scratch_bytes::text AS peak_scratch_bytes, runtime_ms::text AS runtime_ms,
  cost_micros::text AS cost_micros, currency, result, evidence_class, ${exact("recorded_at")}`;

export function cleanupRecord(r: Row): AttemptCleanupRecord {
  const machineType = optionalString(r["machine_type"]);
  return {
    cleanupId: str<AttemptCleanupId>(r["cleanup_id"]),
    agencyId: str<AgencyId>(r["agency_id"]),
    jobId: str<ProcessingJobId>(r["job_id"]),
    attemptId: str<ProcessingAttemptId>(r["attempt_id"]),
    providerIdentity: str(r["provider_identity"]),
    stagingPrefix: str(r["staging_prefix"]),
    deletedObjects: jsonArray<{ objectId: StoredObjectId; objectName: string; generation: string }>(r["deleted_objects"]).map((o) => ({ objectId: o.objectId, objectName: o.objectName, generation: o.generation })),
    terminationResult: str<TerminationResult>(r["termination_result"]),
    scratchDeleted: r["scratch_deleted"] === true,
    ...opt(
      "resources",
      machineType === undefined
        ? undefined
        : {
            machineType,
            vcpus: int(r["vcpus"]),
            memoryBytes: int(r["memory_bytes"]),
            diskBytes: int(r["disk_bytes"]),
            peakScratchBytes: int(r["peak_scratch_bytes"]),
            runtimeMs: int(r["runtime_ms"]),
            costMicros: int(r["cost_micros"]),
            currency: str(r["currency"]),
          },
    ),
    result: str<"CLEANED" | "PARTIAL">(r["result"]),
    evidenceClass: str<"EXECUTED_PROVIDER" | "SIMULATED">(r["evidence_class"]),
    recordedAt: instantText(r["recorded_at"]),
  };
}
