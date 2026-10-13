/**
 * Execution fixtures of processing authority (package B08, mandate B08-PERSISTENCE-EXECUTION; @kauro/persistence/testing), for the
 * real-database tests of this package and of the entrypoints (apps/api CMD036/CMD037, apps/control's pipelines). They start from a
 * paid purchase — B09's paidPurchase (commerce-purchases.ts), an ACTIVE CommercialAuthorization — and walk a job along its edges
 * through the execution unit of work of the harness (Harness.execution), each write by the runtime role that owns it: CMD036's queue
 * by the agency's request handlers (kauro_app, the owner's TENANT context), and admission, launch, staging, verification,
 * publication, failure and cancellation by the control plane (kauro_control, a SYSTEM context bound to the agency, B07 D-CTRL-1).
 * Every instant is the database's (D8-CLOCK-1).
 *
 * The objects are the ones a worker would have written through the labelled storage fake (provider `contract-fake-storage`, the
 * token of B07's ContractFakeObjectStorage; evidence class SIMULATED): names under the attempt's own prefix, generations, digests
 * and lengths a fixture states — nothing is written to a provider, and nothing is claimed EXECUTED_PROVIDER (21 "Evidence classes").
 * The verifier's verdict is stated the same way (evidence class SIMULATED): the fixtures never call a core.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Sha256Hex } from "@kauro/contracts";
import {
  createIdGenerator,
  deliveryManifestHashOf,
  jobInputBindingHashOf,
  stagedManifestHashOf,
  toUtcInstant,
  type AdmissionRecord,
  type AgencyId,
  type CommercialAuthorizationId,
  type ExecutionUnitOfWork,
  type IdGenerator,
  type MembershipId,
  type PackageVerificationId,
  type PackageVersionId,
  type PackageVersionRecord,
  type ProcessingAttemptId,
  type ProcessingAttemptRecord,
  type ProcessingJobId,
  type ProcessingJobRecord,
  type PublicationOutcome,
  type StagingRecord,
  type StoredObjectId,
  type SystemContext,
  type ArtifactReadbackId,
} from "@kauro/domain";
import type { AgencyFixture, Harness } from "./harness.js";
import { FIXTURE_STORAGE_PROVIDER } from "./source-lifecycle.js";

const ids: IdGenerator = createIdGenerator({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() }, (n) => new Uint8Array(randomBytes(n)));

function sha(s: string): Sha256Hex {
  return createHash("sha256").update(s).digest("hex");
}

/** The control plane's service identity in the fixtures (a SYSTEM context acts as this service; D-CTRL-1). */
export const EXECUTION_FIXTURE_SERVICE = "control-plane";
/** Where the fixtures' staged and delivered objects live: registry keys of the labelled storage fake's locations. */
export const EXECUTION_STAGING_LOCATION = Object.freeze({ provider: FIXTURE_STORAGE_PROVIDER, locationRef: "STAGING_PRIMARY" });
export const EXECUTION_DELIVERY_LOCATION = Object.freeze({ provider: FIXTURE_STORAGE_PROVIDER, locationRef: "DELIVERY_PRIMARY" });
/** The verifier the fixtures state (the labelled Migration-core fake's version token; SIMULATED). */
export const EXECUTION_FIXTURE_CORE_VERSION = "contract-fake-migration-core-2.0.3";

/** A control-plane unit of work bound to the agency of its work item (B07 D-CTRL-1). */
export function controlOf(agencyId: string): SystemContext {
  return { kind: "SYSTEM", serviceId: EXECUTION_FIXTURE_SERVICE, correlationId: ids.next() as SystemContext["correlationId"], agencyId: agencyId as AgencyId };
}

function runControl<T>(h: Harness, agencyId: string, work: (uow: ExecutionUnitOfWork) => Promise<T>): Promise<T> {
  return h.execution.run(controlOf(agencyId), work);
}

async function jobOf(uow: ExecutionUnitOfWork, jobId: string): Promise<ProcessingJobRecord> {
  const job = await uow.execution.getJob(jobId as ProcessingJobId);
  if (job === null) throw new Error(`job ${jobId} is not visible`);
  return job;
}

async function currentAttemptOf(uow: ExecutionUnitOfWork, jobId: string): Promise<ProcessingAttemptRecord> {
  const job = await jobOf(uow, jobId);
  if (job.currentAttemptId === undefined) throw new Error(`job ${jobId} has no attempt`);
  const attempt = await uow.execution.getAttempt(job.currentAttemptId);
  if (attempt === null) throw new Error(`attempt ${job.currentAttemptId} is not visible`);
  return attempt;
}

/**
 * CMD036's write as the request handlers perform it (B08-COMMANDS-EXECUTION serves the route): in the owner's TENANT unit of work,
 * the authorization's execution subject and the core package of the receipt its approval names, the job born QUEUED with
 * processing_job.queued.v1 and its JOB_EXECUTION outbox record. `membershipId` is the acting operator's (the owner's by default).
 */
export async function queueJob(h: Harness, agency: AgencyFixture, authorizationId: string, membershipId: string = agency.ownerMembershipId): Promise<ProcessingJobRecord> {
  return h.execution.run(h.tenant(agency.agencyId, agency.ownerUserId), async (uow) => {
    const authorization = await uow.commerce.authorizations.get(authorizationId as CommercialAuthorizationId);
    if (authorization === null) throw new Error(`authorization ${authorizationId} is not visible to the agency`);
    const approval = await uow.approvals.get(authorization.approvalId);
    if (approval === null) throw new Error(`the approval of authorization ${authorizationId} is not visible`);
    const receipt = await uow.receipts.findByHash(agency.agencyId, approval.validationReceiptHash);
    if (receipt === null) throw new Error(`the receipt of approval ${approval.approvalId} is not visible`);
    const subject = {
      agencyId: agency.agencyId,
      projectId: authorization.projectId,
      authorizationId: authorization.authorizationId,
      captureId: authorization.captureId,
      planId: authorization.planId,
      planHash: authorization.planHash,
      approvalId: authorization.approvalId,
      approvalHash: authorization.approvalHash,
      revisionHash: authorization.revisionHash,
      targetContractHash: authorization.targetContractHash,
      capabilityId: authorization.capabilityId,
      capabilityVersion: authorization.capabilityVersion,
      mode: authorization.mode,
      validationReceiptHash: approval.validationReceiptHash,
      corePackageHash: receipt.corePackageHash,
    };
    return uow.execution.queueJob({ ...subject, jobId: uow.ids.next() as ProcessingJobId, inputBindingHash: jobInputBindingHashOf(subject), createdByMembershipId: membershipId as MembershipId });
  });
}

/**
 * JOB_ADMISSION's unit for one job (B08-CONTROL-EXECUTION runs the fair round over many): the platform's ledger first, the job SKIP
 * LOCKED, every transition lock without waiting (D8-LOCK-1), then the admission — the job ADMITTED, the entitlement CONSUMED, the
 * anchor and PAID_ORDINARY record, attempt 1 CLAIMED at lease fence 1.
 */
export async function admitJob(h: Harness, agency: AgencyFixture, jobId: string): Promise<AdmissionRecord> {
  return runControl(h, agency.agencyId, async (uow) => {
    const x = uow.execution;
    await x.lockGlobalLedger();
    const job = await x.lockJob(jobId as ProcessingJobId, "SKIP_LOCKED");
    if (job === null) throw new Error(`job ${jobId} is locked or not visible`);
    const facts = await x.readAuthority(job);
    const locked = [
      await x.tryAwaitTransition({ kind: "PROJECT", key: job.projectId }),
      await x.tryTransitionExclusive({ kind: "AUTHORIZATION", key: job.authorizationId }),
      await x.tryAwaitTransition({ kind: "APPROVAL", key: job.approvalId }),
      facts.revisionId === null ? false : await x.tryAwaitTransition({ kind: "REVISION", key: facts.revisionId }),
      facts.targetContractId === null ? false : await x.tryAwaitTransition({ kind: "TARGET_CONTRACT", key: facts.targetContractId }),
      await x.tryAwaitTransition({ kind: "CAPABILITY", key: job.mode }),
      await x.tryAwaitTransition({ kind: "AGENCY", key: job.agencyId }),
    ];
    if (locked.includes(false)) throw new Error(`a fact of job ${jobId} is in transition; the admission defers it`);
    return x.admit(job, uow.ids.next() as ProcessingAttemptId);
  });
}

/**
 * JOB_EXECUTION's launch intent (the ACTIVE slot, the attempt STARTING with its manifest name), the host's answer LAUNCHED by the
 * attempt's identity, and ATTEMPT_MONITOR's provider_start_observed (the attempt and the job RUNNING) — three units, as the control
 * plane takes them around the host's calls.
 */
export async function launchJob(h: Harness, agency: AgencyFixture, jobId: string): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }> {
  const attempt = await runControl(h, agency.agencyId, async (uow) => {
    const current = await currentAttemptOf(uow, jobId);
    return (await uow.execution.recordLaunchIntent(current.attemptId, { manifestObjectName: `${current.stagingPrefix}${uow.ids.next()}` })).attempt;
  });
  await runControl(h, agency.agencyId, (uow) => uow.execution.recordLaunch(attempt.attemptId, "LAUNCHED", attempt.identity));
  return runControl(h, agency.agencyId, (uow) => uow.execution.observeStart(attempt.attemptId));
}

/** One artifact a fixture worker wrote under its attempt's prefix (through the labelled storage fake). */
export interface FixtureArtifact {
  readonly objectId: StoredObjectId;
  readonly role: string;
  readonly objectName: string;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

let generationCounter = 0;
/** A provider generation no other fixture object carries (the storage fake's int64 form). */
export function fixtureGeneration(): string {
  generationCounter += 1;
  return String(1_700_000_000_000_000 + Date.now() * 10 + generationCounter);
}

/** `count` artifacts of an attempt, named under its own prefix. */
export function fixtureArtifacts(attempt: ProcessingAttemptRecord, count = 2): FixtureArtifact[] {
  return Array.from({ length: count }, (_, i) => {
    const objectName = `${attempt.stagingPrefix}${ids.next()}`;
    return { objectId: ids.next() as StoredObjectId, role: i === 0 ? "import" : `records-${i}`, objectName, generation: fixtureGeneration(), sha256: sha(`artifact-${objectName}`), byteLength: 1000 + i };
  });
}

/**
 * JOB_EXECUTION's manifest submission (D8-STG-3): the control plane read the attempt's manifest (its KAURO_STAGED_MANIFEST_V1 digest)
 * and records it under the fence — the artifacts registered STAGING, the attempt STAGED, the job VERIFYING, the package STAGED.
 */
export async function stageJob(h: Harness, agency: AgencyFixture, jobId: string, artifacts?: ReadonlyArray<FixtureArtifact>): Promise<StagingRecord> {
  return runControl(h, agency.agencyId, async (uow) => {
    const job = await jobOf(uow, jobId);
    const attempt = await currentAttemptOf(uow, jobId);
    if (attempt.manifestObjectName === undefined || attempt.fence === undefined) throw new Error(`attempt ${attempt.attemptId} was not launched`);
    const staged = artifacts ?? fixtureArtifacts(attempt);
    const declaredSummary = { rows: staged.length };
    const manifestHash = stagedManifestHashOf({ jobId, attemptId: attempt.attemptId, fence: attempt.fence, inputBindingHash: job.inputBindingHash, artifacts: staged, declaredSummary });
    return uow.execution.submitManifest(attempt.attemptId, {
      packageVersionId: uow.ids.next() as PackageVersionId,
      location: EXECUTION_STAGING_LOCATION,
      manifest: { objectName: attempt.manifestObjectName, generation: fixtureGeneration(), manifestHash, declaredSummaryHash: sha(JSON.stringify(declaredSummary)) },
      artifacts: staged,
    });
  });
}

/**
 * The verification (D8-VER-1) and the private delivery copies (D8-PUB-1), as JOB_EXECUTION records them: verification_started, a
 * read-back EQUAL of every staged artifact at its generation, a VALID verification (SIMULATED), VERIFIED_PRIVATE; then — unless
 * `deliver` is false — one delivery copy per artifact under the package's prefix, each read back EQUAL.
 */
export async function verifyJob(h: Harness, agency: AgencyFixture, jobId: string, options: { readonly deliver?: boolean } = {}): Promise<PackageVersionRecord> {
  const verified = await runControl(h, agency.agencyId, async (uow) => {
    const x = uow.execution;
    const job = await jobOf(uow, jobId);
    const attempt = await currentAttemptOf(uow, jobId);
    await x.startVerification(attempt.attemptId);
    for (const a of await x.stagedArtifactsOf(attempt.attemptId)) {
      await x.recordReadback({
        readbackId: uow.ids.next() as ArtifactReadbackId,
        attemptId: attempt.attemptId,
        kind: "STAGING",
        objectName: a.objectName,
        expected: { generation: a.generation, sha256: a.sha256, byteLength: a.byteLength },
        observed: { generation: a.generation, sha256: a.sha256, byteLength: a.byteLength },
      });
    }
    const pkg = await packageOfJob(uow, job);
    const verification = await x.recordVerification({
      verificationId: uow.ids.next() as PackageVerificationId,
      attemptId: attempt.attemptId,
      packageVersionId: pkg.packageVersionId,
      result: "VALID",
      problems: [],
      evidenceClass: "SIMULATED",
      expectedAuthorityHash: sha(`expected-authority-${job.inputBindingHash}`),
      coreVersion: EXECUTION_FIXTURE_CORE_VERSION,
    });
    return x.markVerifiedPrivate(pkg.packageVersionId, verification.verificationId);
  });
  if (options.deliver === false) return verified;
  await runControl(h, agency.agencyId, async (uow) => {
    const x = uow.execution;
    for (const a of await x.stagedArtifactsOf(verified.attemptId)) {
      const copy = await x.recordDeliveryCopy({
        packageVersionId: verified.packageVersionId,
        location: EXECUTION_DELIVERY_LOCATION,
        sourceObjectName: a.objectName,
        objectId: uow.ids.next() as StoredObjectId,
        objectName: `${verified.deliveryPrefix}${uow.ids.next()}`,
        generation: fixtureGeneration(),
      });
      await x.recordReadback({
        readbackId: uow.ids.next() as ArtifactReadbackId,
        attemptId: verified.attemptId,
        kind: "DELIVERY",
        packageVersionId: verified.packageVersionId,
        objectName: copy.objectName,
        expected: { generation: copy.generation, sha256: copy.sha256, byteLength: copy.byteLength },
        observed: { generation: copy.generation, sha256: copy.sha256, byteLength: copy.byteLength },
      });
    }
  });
  return verified;
}

async function packageOfJob(uow: ExecutionUnitOfWork, job: ProcessingJobRecord): Promise<PackageVersionRecord> {
  if (job.currentAttemptId === undefined) throw new Error(`job ${job.jobId} has no attempt`);
  const pkg = await uow.execution.packageOfAttempt(job.currentAttemptId);
  if (pkg === null) throw new Error(`attempt ${job.currentAttemptId} has no package version`);
  return pkg;
}

/** The publication transaction of D8-PUB-2, as JOB_EXECUTION takes it (the issued PackageManifest's KAURO_DELIVERY_MANIFEST_V1). */
export async function publishJob(h: Harness, agency: AgencyFixture, jobId: string): Promise<PublicationOutcome> {
  return runControl(h, agency.agencyId, async (uow) => {
    const job = await jobOf(uow, jobId);
    const pkg = await packageOfJob(uow, job);
    const copies = await uow.execution.deliveryArtifactsOf(pkg.packageVersionId);
    const deliveryManifestHash = deliveryManifestHashOf({
      packageId: pkg.packageVersionId,
      revisionHash: job.revisionHash,
      planHash: job.planHash,
      targetContractHash: job.targetContractHash,
      corePackageHash: job.corePackageHash,
      validationReceiptHash: job.validationReceiptHash,
      artifacts: copies.map((c) => ({ role: c.role, objectName: c.objectName, generation: c.generation, sha256: c.sha256, byteLength: c.byteLength })),
      // the store records the manifest's digest and never reads its contents: a fixed, labelled RowCounts stands in for the one
      // the control plane issues (ROWCOUNTS-PRODUCER, apps/control pipeline.ts issuedDeliveryManifestOf)
      counts: FIXTURE_ISSUED_COUNTS,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      manifestVersion: "1",
    });
    return uow.execution.publish({ jobId: job.jobId, packageVersionId: pkg.packageVersionId, deliveryManifestHash, anchorId: uow.ids.next() });
  });
}

/**
 * Releases what a live job holds, as the control plane ends it: a QUEUED job cancelled for a lost authority (EXECUTION_CONTROL, a
 * SERVICE actor) and CANCELLED; an admitted, running or verifying job's attempt abandoned and the job FAILED with `reason`; a
 * CANCEL_REQUESTED job CANCELLED. A test frees the platform's one ACTIVE and three WAITING slots with it (R2-046).
 */
export async function endJob(h: Harness, agency: AgencyFixture, jobId: string, reason = "WORKER_CRASHED"): Promise<ProcessingJobRecord> {
  return runControl(h, agency.agencyId, async (uow) => {
    const x = uow.execution;
    let job = await x.lockJob(jobId as ProcessingJobId);
    if (job === null) throw new Error(`job ${jobId} is not visible`);
    if (job.currentAttemptId !== undefined) {
      const attempt = await x.getAttempt(job.currentAttemptId);
      if (attempt !== null && !["COMMITTED", "ABANDONED", "FAILED"].includes(attempt.state)) await x.abandonAttempt(attempt.attemptId, reason);
    }
    if (job.state === "QUEUED") {
      const cancelled = await x.requestCancellation(job.jobId, job.version, { actor: { kind: "SERVICE", serviceId: EXECUTION_FIXTURE_SERVICE }, reasonCode: reason });
      if (cancelled.kind !== "APPLIED") throw new Error(`job ${jobId} moved while it was ended`);
      job = cancelled.record;
    }
    if (job.state === "CANCEL_REQUESTED") {
      const done = await x.completeCancellation(job.jobId, job.version);
      if (done.kind !== "APPLIED") throw new Error(`job ${jobId} moved while it was ended`);
      return done.record;
    }
    if (job.state === "ADMITTED" || job.state === "RUNNING" || job.state === "VERIFYING") {
      const failed = await x.failJob(job.jobId, job.version, reason);
      if (failed.kind !== "APPLIED") throw new Error(`job ${jobId} moved while it was ended`);
      return failed.record;
    }
    return job;
  });
}

/** A labelled fixture RowCounts for publications a fixture makes as JOB_EXECUTION (the store never reads the manifest's contents). */
const FIXTURE_ISSUED_COUNTS = Object.freeze({ physicalSourceRows: 10, logicalSourceRecords: 10, billableSourceUnits: 10, associationEdges: 0, emittedRepresentatives: 10, mergedNonSurvivors: 0, rejected: 0, withheld: 0, unresolved: 0, emittedArtifactRows: 10 });
