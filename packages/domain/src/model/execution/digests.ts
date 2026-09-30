/**
 * Digests and names of processing authority (package B08; reference/HASHING_AND_ACCOUNTING_RULES "Hash domain separation": every
 * structured digest is SHA-256 over the canonical {domain, version, payload} wrapper; docs/design/B08-audit-approval-jobs.md
 * D8-JOB-2, D8-STG-5, D8-PUB-2, D8-HOST-1, D8-STG-1, D8-PUB-1, D8-LAND-2).
 *
 * KAURO_JOB_INPUT_BINDING_V1 and KAURO_STAGED_MANIFEST_V1 are platform domains (the authority names the Job.inputBindingHash and a
 * staged manifest but no domain for them), in the same wrapper shape as B07's source digests; KAURO_DELIVERY_MANIFEST_V1 is the
 * authority's own domain (@kauro/contracts DOMAINS.DELIVERY_MANIFEST). The staged manifest's digest is the raw SHA-256 of the
 * manifest object's bytes, which are exactly the canonical wrapper the worker host writes (@kauro/application ports/worker-host.ts
 * stagedManifestBytesOf; D8-STG-5): the domain test pins both to the same vector.
 */
import type { Sha256Hex } from "@kauro/contracts";
import { DOMAINS, canonicalBytes, rawDigest, structuredDigest } from "@kauro/contracts";
import { isUuid } from "../ids.js";
import type { JobExecutionSubject } from "./records.js";

export const EXECUTION_DIGEST_DOMAINS = Object.freeze({
  JOB_INPUT_BINDING: "KAURO_JOB_INPUT_BINDING_V1",
  STAGED_MANIFEST: "KAURO_STAGED_MANIFEST_V1",
  JOB_ATTEMPT_CHECKPOINT: "KAURO_JOB_ATTEMPT_CHECKPOINT_V1",
} as const);

/** What a job's JOB_ATTEMPT checkpoint is taken over: the admitted job, its scope, its entitlement and its input binding. */
export interface AdmittedJobInput {
  readonly jobId: string;
  readonly agencyId: string;
  readonly projectId: string;
  readonly authorizationId: string;
  readonly inputBindingHash: Sha256Hex;
}

/**
 * The checkpoint identity of a job's JOB_ATTEMPT lease (B06 review finding B06-R1, decision D-LEASE-3; D8-LAND-2): the one durable
 * point every attempt of the job starts from — the admitted input (the input binding: sealed source, approved plan, target, receipt
 * and core package) under the entitlement the admission consumed — and nothing an earlier attempt left in scratch or staging (R2-076:
 * rerun under the same authorized job; no ephemeral intermediate recovery). The admission's first claim stores it with the lease and
 * every takeover names it again, recomputed from the job, so an expired lease is resumed only from its stored checkpoint.
 */
export function jobAttemptCheckpointOf(job: AdmittedJobInput): Sha256Hex {
  const payload = {
    jobId: job.jobId,
    agencyId: job.agencyId,
    projectId: job.projectId,
    authorizationId: job.authorizationId,
    inputBindingHash: job.inputBindingHash,
    resumesFrom: "ADMITTED_INPUT",
  };
  return rawDigest(canonicalBytes({ domain: EXECUTION_DIGEST_DOMAINS.JOB_ATTEMPT_CHECKPOINT, version: 1, payload }));
}

/**
 * Job.inputBindingHash ("Source, plan, target, core and policy bundle"): KAURO_JOB_INPUT_BINDING_V1 over the authorization's
 * execution subject and the core package of the receipt the approval names (D8-JOB-2). The JOB_ATTEMPT lease subject.
 */
export function jobInputBindingHashOf(subject: JobExecutionSubject): Sha256Hex {
  const payload = {
    agencyId: subject.agencyId,
    projectId: subject.projectId,
    authorizationId: subject.authorizationId,
    captureId: subject.captureId,
    planId: subject.planId,
    planHash: subject.planHash,
    approvalId: subject.approvalId,
    approvalHash: subject.approvalHash,
    revisionHash: subject.revisionHash,
    targetContractHash: subject.targetContractHash,
    capabilityId: subject.capabilityId,
    capabilityVersion: subject.capabilityVersion,
    mode: subject.mode,
    validationReceiptHash: subject.validationReceiptHash,
    corePackageHash: subject.corePackageHash,
  };
  return rawDigest(canonicalBytes({ domain: EXECUTION_DIGEST_DOMAINS.JOB_INPUT_BINDING, version: 1, payload }));
}

/** One artifact of a staged manifest, as the worker host's writer closed and re-read it. */
export interface StagedManifestArtifact {
  readonly role: string;
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

export interface StagedManifestDocument {
  readonly jobId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly inputBindingHash: Sha256Hex;
  readonly artifacts: ReadonlyArray<StagedManifestArtifact>;
  readonly declaredSummary: unknown;
}

/**
 * The KAURO_STAGED_MANIFEST_V1 digest of a staged manifest: the artifacts reduced to their five members and ordered by object name,
 * inside the canonical wrapper — the raw SHA-256 of the bytes the worker host writes (D8-STG-5).
 */
export function stagedManifestHashOf(document: StagedManifestDocument): Sha256Hex {
  const artifacts = document.artifacts
    .map((a) => ({ role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }))
    .sort((a, b) => (a.objectName < b.objectName ? -1 : a.objectName > b.objectName ? 1 : 0));
  const { jobId, attemptId, fence, inputBindingHash, declaredSummary } = document;
  return rawDigest(canonicalBytes({ domain: EXECUTION_DIGEST_DOMAINS.STAGED_MANIFEST, version: 1, payload: { jobId, attemptId, fence, inputBindingHash, artifacts, declaredSummary } }));
}

/** An artifact of an issued package (registry PackageManifest.artifacts): its delivery object and exact generation. */
export interface DeliveryManifestArtifact {
  readonly role: string;
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

/** Registry PackageManifest, as the publication issues it (D8-PUB-2): the bindings of the authority chain and the artifacts. */
export interface DeliveryPackageManifest {
  readonly packageId: string;
  readonly revisionHash: Sha256Hex;
  readonly planHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly corePackageHash: Sha256Hex;
  readonly validationReceiptHash: Sha256Hex;
  readonly artifacts: ReadonlyArray<DeliveryManifestArtifact>;
  readonly counts: unknown;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly manifestVersion: string;
}

/** KAURO_DELIVERY_MANIFEST_V1 over the issued PackageManifest (the authority's domain), artifacts ordered by object name. */
export function deliveryManifestHashOf(manifest: DeliveryPackageManifest): Sha256Hex {
  const artifacts = manifest.artifacts
    .map((a) => ({ role: a.role, objectName: a.objectName, generation: a.generation, sha256: a.sha256, byteLength: a.byteLength }))
    .sort((a, b) => (a.objectName < b.objectName ? -1 : a.objectName > b.objectName ? 1 : 0));
  return structuredDigest(DOMAINS.DELIVERY_MANIFEST, 1, { ...manifest, artifacts });
}

// --- names (the database checks the same shapes, migrations 0021 and 0022) ------------------------------------------------------

/** The deterministic provider identity of an attempt, `kauro-attempt-<attemptId>` (D8-HOST-1). */
export function jobAttemptIdentityOf(attemptId: string): string {
  if (!isUuid(attemptId)) throw new TypeError("an attempt id is a canonical UUID");
  return `kauro-attempt-${attemptId}`;
}

/** `staging/{agency}/{project}/{job}/{attempt}/` — ends with the separator, so no other attempt can match it (D8-STG-1). */
export function jobAttemptStagingPrefixOf(agencyId: string, projectId: string, jobId: string, attemptId: string): string {
  for (const id of [agencyId, projectId, jobId, attemptId]) if (!isUuid(id)) throw new TypeError("a staging prefix is built from canonical UUIDs");
  return `staging/${agencyId}/${projectId}/${jobId}/${attemptId}/`;
}

/** `delivery/{agency}/{project}/{package}/` (D8-PUB-1). */
export function packageDeliveryPrefixOf(agencyId: string, projectId: string, packageVersionId: string): string {
  for (const id of [agencyId, projectId, packageVersionId]) if (!isUuid(id)) throw new TypeError("a delivery prefix is built from canonical UUIDs");
  return `delivery/${agencyId}/${projectId}/${packageVersionId}/`;
}
