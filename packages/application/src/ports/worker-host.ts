/**
 * The worker host and the attempt envelope (design docs/design/B08-audit-approval-jobs.md §4, §5, §10; D8-HOST-1, D8-ATT-2,
 * D8-STG-1..5; mandate B08-WORKER-HOST).
 *
 * `WorkerHostPort` runs one processing attempt as one provider job keyed by the attempt's deterministic identity
 * `kauro-attempt-<attemptId>`, recorded before launch (07 "deterministic provider job identity"; 10 "Provider adapter contract"):
 * launch creates by identity (ALREADY_EXISTS adopts), a timeout is AMBIGUOUS and nothing is created again until `observe`
 * answers, and only NOT_FOUND after the host's creation horizon proves no effect. The hosts are B14's: LocalProcessWorkerHost of
 * @kauro/data-plane (B14-A, EXECUTED_LOCAL) and, under A9, Amazon ECS RunTask on Fargate (selected, not qualified until its live proofs,
 * docs/design/B14-A-aws-host-qualification.md); tests bind
 * the labelled ContractFakeWorkerHost (`@kauro/data-plane/testing/worker-host`, D8-FAKE-1). Every answer carries `evidenceClass`:
 * EXECUTED_PROVIDER only from a cloud provider's real answer, EXECUTED_LOCAL from the local process host of B14-A (a real isolated
 * process on this machine, never a provider), SIMULATED from a contract fake.
 *
 * `AttemptCapability` is everything an attempt may touch (D8-STG-1): exactly its staging prefix
 * `staging/{agency}/{project}/{job}/{attempt}/`, the manifest name inside it and the sealed ACCEPTED generations it reads.
 * `ResumableUploadPort` is the holder side of a resumable session, which B07's ObjectStoragePort leaves to the browser; the
 * FencedArtifactWriter creates the session through ObjectStoragePort (the generation-0 precondition) and writes through this
 * (D8-STG-4). The object names and the KAURO_STAGED_MANIFEST_V1 bytes here are pure functions (D8-STG-5), so the control plane
 * and the worker compute the same names and digests.
 */
import type { Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, isSha256Hex, parseCanonical, rawDigest } from "@kauro/contracts";
import type { AgencyId, ProjectId } from "@kauro/domain";
import { isObjectName, isUuid } from "@kauro/domain";
import type { ExecutionLimits, ExecutionSubject, StagedArtifact } from "./core-ports.js";
import type { ProviderEvidenceClass } from "./source-providers.js";

// --- identities and names -------------------------------------------------------------------------------------------------------

export const ATTEMPT_IDENTITY_PREFIX = "kauro-attempt-";
/** Platform domain of a staged object's name component (D8-STG-4): the object grammar allows only UUID components. */
export const STAGED_OBJECT_NAME_DOMAIN = "KAURO_STAGED_OBJECT_NAME_V1";
/** The staged manifest the worker writes and the control plane submits (D8-STG-3). */
export const STAGED_MANIFEST_DOMAIN = "KAURO_STAGED_MANIFEST_V1";
/** An artifact role: a short lowercase token chosen by the core; `manifest` is the host's own. */
export const ARTIFACT_ROLE = /^[a-z][a-z0-9-]{0,62}$/;
export const MANIFEST_ROLE = "manifest";
const GENERATION = /^[1-9][0-9]{0,19}$/;

/** The deterministic provider identity of an attempt (D8-HOST-1). */
export function attemptIdentityOf(attemptId: Id): string {
  if (!isUuid(attemptId)) throw new TypeError("an attempt id is a canonical UUID");
  return `${ATTEMPT_IDENTITY_PREFIX}${attemptId}`;
}

export function isAttemptIdentity(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ATTEMPT_IDENTITY_PREFIX) && isUuid(value.slice(ATTEMPT_IDENTITY_PREFIX.length));
}

/** `staging/{agency}/{project}/{job}/{attempt}/` — ends with the separator, so no other attempt can match it (D8-STG-1). */
export function attemptStagingPrefixOf(agencyId: AgencyId, projectId: ProjectId, jobId: Id, attemptId: Id): string {
  for (const id of [agencyId, projectId, jobId, attemptId]) if (!isUuid(id)) throw new TypeError("a staging prefix is built from canonical UUIDs");
  return `staging/${agencyId}/${projectId}/${jobId}/${attemptId}/`;
}

/** A UUIDv8 (RFC 9562 §5.8) from the first 16 bytes of a domain-separated digest. */
function uuidOfDigest(payload: unknown): string {
  const hex = rawDigest(canonicalBytes({ domain: STAGED_OBJECT_NAME_DOMAIN, version: 1, payload }));
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = 0x80 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The object an artifact of `role` and `pathHash` is written to, inside the prefix (deterministic: a rewrite meets generation 0). */
export function stagedArtifactObjectNameOf(stagingPrefix: string, role: string, pathHash: Sha256Hex): string {
  if (!ARTIFACT_ROLE.test(role) || role === MANIFEST_ROLE) throw new TypeError("an artifact role is a short lowercase token other than manifest");
  if (!isSha256Hex(pathHash)) throw new TypeError("a path hash is a SHA-256 hex digest");
  return `${stagingPrefix}${uuidOfDigest({ kind: "ARTIFACT", role, pathHash })}`;
}

/** The one manifest name of an attempt, inside its prefix. */
export function stagedManifestObjectNameOf(stagingPrefix: string, attemptId: Id): string {
  return `${stagingPrefix}${uuidOfDigest({ kind: "MANIFEST", attemptId })}`;
}

// --- the capability ------------------------------------------------------------------------------------------------------------

/** One sealed ACCEPTED generation the attempt may read, with the digest and length the seal recorded. */
export interface AcceptedGeneration {
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

export interface AttemptCapability {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly jobId: Id;
  readonly attemptId: Id;
  readonly identity: string;
  readonly stagingPrefix: string;
  readonly manifestObjectName: string;
  readonly acceptedGenerations: readonly AcceptedGeneration[];
}

/** Every way a capability departs from the canonical one of its attempt; empty when it is exactly that. */
export function attemptCapabilityProblems(capability: AttemptCapability): readonly string[] {
  const problems: string[] = [];
  const { agencyId, projectId, jobId, attemptId } = capability;
  if (![agencyId, projectId, jobId, attemptId].every(isUuid)) return ["IDS_NOT_CANONICAL"];
  if (capability.identity !== attemptIdentityOf(attemptId)) problems.push("IDENTITY_NOT_THE_ATTEMPTS");
  const prefix = attemptStagingPrefixOf(agencyId, projectId, jobId, attemptId);
  if (capability.stagingPrefix !== prefix) problems.push("PREFIX_NOT_THE_ATTEMPTS");
  if (capability.manifestObjectName !== stagedManifestObjectNameOf(prefix, attemptId)) problems.push("MANIFEST_NOT_THE_ATTEMPTS");
  const seen = new Set<string>();
  for (const g of capability.acceptedGenerations) {
    const key = `${g.objectName}#${g.generation}`;
    if (!isObjectName(g.objectName) || !g.objectName.startsWith(`accepted/${agencyId}/${projectId}/`)) problems.push("SOURCE_NOT_THE_PROJECTS_ACCEPTED_OBJECT");
    if (!GENERATION.test(g.generation)) problems.push("SOURCE_GENERATION_MALFORMED");
    if (!isSha256Hex(g.sha256) || !Number.isSafeInteger(g.byteLength) || g.byteLength < 1) problems.push("SOURCE_DIGEST_MALFORMED");
    if (seen.has(key)) problems.push("SOURCE_DUPLICATED");
    seen.add(key);
  }
  return problems;
}

// --- the staged manifest (KAURO_STAGED_MANIFEST_V1) -------------------------------------------------------------------------------

export interface StagedManifestPayload {
  readonly jobId: Id;
  readonly attemptId: Id;
  readonly fence: number;
  readonly inputBindingHash: Sha256Hex;
  /** Every artifact the host's writer closed and re-read, ordered by object name. */
  readonly artifacts: readonly StagedArtifact[];
  /** The core's own disposition summary, verified later against the platform's authority (PackageCandidate.declaredSummary). */
  readonly declaredSummary: unknown;
}

/** The manifest object's bytes: the canonical wrapper, so the object's raw SHA-256 is the KAURO_STAGED_MANIFEST_V1 digest. */
export function stagedManifestBytesOf(payload: StagedManifestPayload): Uint8Array {
  const artifacts = payload.artifacts
    .map((a) => ({ role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }))
    .sort((a, b) => (a.objectName < b.objectName ? -1 : a.objectName > b.objectName ? 1 : 0));
  const { jobId, attemptId, fence, inputBindingHash, declaredSummary } = payload;
  return canonicalBytes({ domain: STAGED_MANIFEST_DOMAIN, version: 1, payload: { jobId, attemptId, fence, inputBindingHash, artifacts, declaredSummary } });
}

export type StagedManifestReading =
  | { readonly ok: true; readonly manifestHash: Sha256Hex; readonly payload: StagedManifestPayload }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a manifest object the control plane fetched itself (D8-STG-3): the closed wrapper, the attempt, fence and input binding
 * it expects, and every artifact inside that attempt's prefix, once, in order. Never trusts the worker's word for any of them.
 */
export function readStagedManifest(
  bytes: Uint8Array,
  expected: { readonly jobId: Id; readonly attemptId: Id; readonly fence: number; readonly inputBindingHash: Sha256Hex; readonly stagingPrefix: string; readonly manifestObjectName: string },
): StagedManifestReading {
  const refuse = (problem: string): StagedManifestReading => ({ ok: false, problem });
  let doc: unknown;
  try {
    doc = parseCanonical(Buffer.from(bytes).toString("utf8"));
  } catch {
    return refuse("NOT_CANONICAL");
  }
  const wrapper = doc as { readonly domain?: unknown; readonly version?: unknown; readonly payload?: unknown } | null;
  if (wrapper === null || typeof wrapper !== "object" || Object.keys(wrapper).sort().join() !== "domain,payload,version") return refuse("NOT_A_WRAPPER");
  if (wrapper.domain !== STAGED_MANIFEST_DOMAIN || wrapper.version !== 1) return refuse("FOREIGN_DOMAIN");
  const p = wrapper.payload as Record<string, unknown> | null;
  if (p === null || typeof p !== "object" || Object.keys(p).sort().join() !== "artifacts,attemptId,declaredSummary,fence,inputBindingHash,jobId") return refuse("PAYLOAD_NOT_CLOSED");
  if (p["jobId"] !== expected.jobId || p["attemptId"] !== expected.attemptId) return refuse("FOREIGN_ATTEMPT");
  if (p["fence"] !== expected.fence) return refuse("FOREIGN_FENCE");
  if (p["inputBindingHash"] !== expected.inputBindingHash) return refuse("FOREIGN_INPUT_BINDING");
  const artifacts = p["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length === 0) return refuse("NO_ARTIFACTS");
  let previous = "";
  for (const a of artifacts as Array<Record<string, unknown>>) {
    if (a === null || typeof a !== "object" || Object.keys(a).sort().join() !== "byteLength,generation,objectName,role,sha256") return refuse("ARTIFACT_NOT_CLOSED");
    const { role, objectName, generation, sha256, byteLength } = a;
    if (typeof role !== "string" || !ARTIFACT_ROLE.test(role) || role === MANIFEST_ROLE) return refuse("ARTIFACT_ROLE");
    if (typeof objectName !== "string" || !isObjectName(objectName) || !objectName.startsWith(expected.stagingPrefix) || objectName === expected.manifestObjectName) return refuse("ARTIFACT_OUTSIDE_PREFIX");
    if (objectName <= previous) return refuse("ARTIFACTS_NOT_ORDERED_ONCE");
    previous = objectName;
    if (typeof generation !== "string" || !GENERATION.test(generation)) return refuse("ARTIFACT_GENERATION");
    if (!isSha256Hex(sha256) || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 1) return refuse("ARTIFACT_DIGEST");
  }
  return { ok: true, manifestHash: rawDigest(bytes), payload: p as unknown as StagedManifestPayload };
}

// --- the holder side of a resumable session ------------------------------------------------------------------------------------

export type ResumableUploadAnswer =
  | { readonly outcome: "IN_PROGRESS"; readonly receivedBytes: number }
  | { readonly outcome: "FINALIZED"; readonly generation: string; readonly bytes: number }
  | { readonly outcome: "REFUSED"; readonly reason: string };

/**
 * Writes one chunk through a session at its current offset (a non-final chunk a multiple of the session's chunk multiple; the
 * final chunk completing exactly the declared length, where the session's generation-0 precondition applies). The session
 * reference is a bearer credential: it stays in the writer's memory and is never logged or stored.
 */
export interface ResumableUploadPort {
  writeChunk(sessionRef: string, chunk: Uint8Array, options: { readonly final: boolean }): Promise<ResumableUploadAnswer>;
}

/** Where a worker host's answer came from (21 "Evidence classes"): a provider's, a real local process host's, or a fake's. */
export type WorkerHostEvidenceClass = ProviderEvidenceClass | "EXECUTED_LOCAL";

// --- WorkerHostPort ------------------------------------------------------------------------------------------------------------

export interface WorkerLaunchSpec {
  readonly identity: string;
  readonly capability: AttemptCapability;
  readonly subject: ExecutionSubject;
  readonly limits: ExecutionLimits;
  /** The attempt's JOB_ATTEMPT lease fence, named by the staged manifest (D8-ATT-1, D8-STG-3). */
  readonly fence: number;
}

export type WorkerLaunchOutcome = "LAUNCHED" | "ALREADY_EXISTS" | "REFUSED" | "AMBIGUOUS";
export type WorkerObservedState = "NOT_FOUND" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TERMINATED";
export type WorkerTerminationOutcome = "TERMINATED" | "ALREADY_TERMINAL" | "NOT_FOUND" | "UNCERTAIN";

/** Why an attempt's provider job failed: S035's exact causes first, then the writer's, the source's and the host's. */
export type WorkerFailureCause =
  | "SCRATCH_EXHAUSTED"
  | "SHORT_WRITE"
  | "CORRUPT_INTERMEDIATE"
  | "READBACK_MISMATCH"
  | "ARTIFACT_CLOSE_FAILED"
  | "OUTSIDE_CAPABILITY"
  | "SOURCE_INTEGRITY_FAILED"
  | "CANCELLED"
  | "FENCED"
  | "DEADLINE_EXCEEDED"
  | "REFUSED"
  | "WORKER_CRASHED"
  | "WORKER_ERROR";

export interface WorkerManifestReference {
  readonly objectName: string;
  readonly generation: string;
}

/** What the host reports a provider job cost (D8-JAN-1): the machine, its disk, the scratch it used, runtime and cost. */
export interface WorkerResources {
  readonly machineType: string;
  readonly vcpus: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  readonly peakScratchBytes: number;
  readonly runtimeMs: number;
  /** Millionths of the currency unit, as the host bills them. */
  readonly costMicros: number;
  readonly currency: string;
}

export interface WorkerLaunchResult {
  readonly evidenceClass: WorkerHostEvidenceClass;
  readonly identity: string;
  readonly outcome: WorkerLaunchOutcome;
  readonly reason: string | null;
}

export interface WorkerObservation {
  readonly evidenceClass: WorkerHostEvidenceClass;
  readonly identity: string;
  readonly state: WorkerObservedState;
  /** The host's instant of the worker's last sign of life; the lease heartbeat is the monitor's, on the server clock (D8-ATT-2). */
  readonly lastHeartbeatAt: UtcInstant | null;
  readonly manifest: WorkerManifestReference | null;
  readonly cause: WorkerFailureCause | null;
  readonly resources: WorkerResources | null;
  readonly observedAt: UtcInstant;
}

export interface WorkerTerminationResult {
  readonly evidenceClass: WorkerHostEvidenceClass;
  readonly identity: string;
  readonly outcome: WorkerTerminationOutcome;
}

export type WorkerResourceReport =
  | { readonly evidenceClass: WorkerHostEvidenceClass; readonly identity: string; readonly outcome: "REPORTED"; readonly state: WorkerObservedState; readonly resources: WorkerResources }
  | { readonly evidenceClass: WorkerHostEvidenceClass; readonly identity: string; readonly outcome: "NOT_FOUND" };

export interface WorkerHostPort {
  readonly evidenceClass: WorkerHostEvidenceClass;
  /** After this long past a create request the host guarantees it can no longer land: only then does NOT_FOUND prove no effect. */
  readonly creationHorizonSeconds: number;
  launch(spec: WorkerLaunchSpec): Promise<WorkerLaunchResult>;
  observe(identity: string): Promise<WorkerObservation>;
  /** Acts on exactly this identity; never on another job of the same attempt's job. */
  terminate(identity: string): Promise<WorkerTerminationResult>;
  resources(identity: string): Promise<WorkerResourceReport>;
}
