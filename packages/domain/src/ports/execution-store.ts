/**
 * The execution store (package B08, mandate B08-PERSISTENCE-EXECUTION; docs/design/B08-audit-approval-jobs.md §4..§7, §9, §10):
 * the port over migrations 0021 and 0022 through which the request handlers queue and cancel jobs (CMD036, CMD037) and the control
 * plane admits, launches, stages, verifies, publishes, cancels and cleans them. It extends the B06/B07/B09 foundation and never
 * forks it: an ExecutionUnitOfWork IS a CommerceUnitOfWork (D8-XPKG-10) — the same transaction, context binding, event publisher,
 * journals, leases and commerce repositories on one connection — with this store on that connection.
 *
 * Every write is one listed edge (or one evidence row) with the event of each aggregate version it makes; the database is the
 * authority: its guards refuse a stale fence (KA080), a lost authority or a cancelled job (KA081), a ledger edited around its jobs
 * (KA082) and a publication without its evidence (KA084), and it stamps every lifecycle instant with kauro.server_now() (D8-CLOCK-1)
 * — no method takes an instant from its caller. Lease operations pass the server instant in SQL. The publication is the last atomic
 * check (D8-CANCEL-1, D8-PUB-2): `publish` takes the locks in the order of D8-LOCK-1 and writes the edges; the deferred guard decides
 * at COMMIT, so a refusal surfaces as the unit of work's failure (EXECUTION_FENCED, EXECUTION_AUTHORITY_LOST,
 * PUBLICATION_EVIDENCE_MISSING). The pg implementation is @kauro/persistence's.
 */
import type { Sha256Hex } from "@kauro/contracts";
import type { AgencyId, MembershipId } from "../model/ids.js";
import type { ExecutionContext } from "../model/tenant.js";
import type { StoredObjectId } from "../model/source/ids.js";
import type { CommercialAuthorizationId } from "../commerce/records.js";
import type { ArtifactReadbackId, AttemptCleanupId, PackageVerificationId, PackageVersionId, ProcessingAttemptId, ProcessingJobId } from "../model/execution/ids.js";
import type {
  ArtifactReadbackRecord,
  AttemptCleanupRecord,
  CancellationActor,
  CleanupResources,
  DeliveryArtifactRecord,
  ExecutionCapacitySnapshot,
  JobExecutionSubject,
  LaunchState,
  PackageVerificationRecord,
  PackageVersionRecord,
  ProcessingAttemptRecord,
  ProcessingJobRecord,
  ReadbackKind,
  ReadbackResult,
  StagedArtifactRecord,
  StagedManifestRecord,
  TerminationResult,
  VerificationEvidenceClass,
  VerificationResult,
} from "../model/execution/records.js";
import type { AdmissionCandidate } from "../model/execution/scheduler.js";
import type { CommerceUnitOfWork, CommerceUnitOfWorkFactory } from "./commerce.js";
import type { ExecutionDiscovery } from "./execution-discovery.js";
import type { LeaseRecord } from "./lease-store.js";
import type { VersionedWrite } from "./repositories.js";
import type { UnitOfWorkOptions } from "./unit-of-work.js";

/**
 * A fact an execution edge relies on without changing it (B06 D-TX-2; D8-LOCK-1): the shared half of its transition lock orders the
 * edge with the fact's own transitions. PROJECT is the project's state (0021), AUTHORIZATION B09's entitlement, APPROVAL the live
 * approval, REVISION the sealed source, TARGET_CONTRACT the confirmed target, CAPABILITY the offered capability of a mode, AGENCY the
 * agency's state.
 */
export type TransitionSubject =
  | { readonly kind: "PROJECT"; readonly key: string }
  | { readonly kind: "AUTHORIZATION"; readonly key: string }
  | { readonly kind: "APPROVAL"; readonly key: string }
  | { readonly kind: "REVISION"; readonly key: string }
  | { readonly kind: "TARGET_CONTRACT"; readonly key: string }
  | { readonly kind: "CAPABILITY"; readonly key: string }
  | { readonly kind: "AGENCY"; readonly key: string };

/** The authority a job relies on, read after the transition locks of its facts (D8-STALE-1, D8-XPKG-5, D8-XPKG-8). */
export interface ExecutionAuthorityFacts {
  readonly agencyState: string | null;
  readonly projectState: string | null;
  readonly projectClientId: string | null;
  readonly authorizationState: string | null;
  readonly authorizationJobRef: string | null;
  readonly approvalLive: boolean;
  readonly planState: string | null;
  readonly revisionId: string | null;
  readonly revisionState: string | null;
  readonly targetContractId: string | null;
  readonly targetCurrent: boolean;
  readonly capabilityOffered: boolean;
  /** capture_facts.provider_completed_at (D8-XPKG-5): the anchor of the delivery and retention deadlines. */
  readonly captureCompletedAt: string | null;
  /** The ACTIVE retention records governing the revision: the latest effective deadline among them, or null. */
  readonly retentionEffectiveDeadline: string | null;
  readonly paidOrdinaryRetentionId: string | null;
}

export interface NewProcessingJob extends JobExecutionSubject {
  readonly jobId: ProcessingJobId;
  /** KAURO_JOB_INPUT_BINDING_V1 of the subject (jobInputBindingHashOf). */
  readonly inputBindingHash: Sha256Hex;
  readonly createdByMembershipId: MembershipId;
}

export interface JobCancellation {
  readonly actor: CancellationActor;
  /** CMD037 reasonCode (a registry label) or EXECUTION_CONTROL's reason token (D8-CANCEL-2); kept on the row only. */
  readonly reasonCode: string;
}

/** What an admission unit wrote (D8-AUTH-1, D8-RET-1, D8-ATT-1): all of it commits together or not at all. */
export interface AdmissionRecord {
  readonly job: ProcessingJobRecord;
  readonly attempt: ProcessingAttemptRecord;
  readonly lease: LeaseRecord;
  readonly anchorId: string;
  /** The PAID_ORDINARY record the admission created, or the one of the revision it kept (D8-XPKG-8). */
  readonly retentionId: string;
  readonly retentionCreated: boolean;
}

export interface LaunchIntent {
  /** The attempt's one manifest object name inside its prefix (the capability names it; D8-STG-1). */
  readonly manifestObjectName: string;
}

/** Where staged and delivered objects live (a registry key and a provider token, never a bucket name; B07 D-OBJ-1). */
export interface ObjectLocation {
  readonly provider: string;
  readonly locationRef: string;
}

export interface ManifestSubmission {
  readonly packageVersionId: PackageVersionId;
  readonly location: ObjectLocation;
  readonly manifest: { readonly objectName: string; readonly generation: string; readonly manifestHash: Sha256Hex; readonly declaredSummaryHash: Sha256Hex };
  /** Every artifact the manifest names; each is registered as a STAGING stored object at its generation (D8-STG-3). */
  readonly artifacts: ReadonlyArray<{ readonly objectId: StoredObjectId; readonly role: string; readonly objectName: string; readonly generation: string; readonly sha256: Sha256Hex; readonly byteLength: number }>;
}

export interface StagingRecord {
  readonly job: ProcessingJobRecord;
  readonly attempt: ProcessingAttemptRecord;
  readonly manifest: StagedManifestRecord;
  readonly artifacts: ReadonlyArray<StagedArtifactRecord>;
  readonly packageVersion: PackageVersionRecord;
}

export interface ReadbackInput {
  readonly readbackId: ArtifactReadbackId;
  readonly attemptId: ProcessingAttemptId;
  readonly kind: ReadbackKind;
  readonly packageVersionId?: PackageVersionId;
  readonly objectName: string;
  readonly expected: { readonly generation: string; readonly sha256: Sha256Hex; readonly byteLength: number };
  readonly observed: { readonly generation: string | null; readonly sha256: Sha256Hex | null; readonly byteLength: number | null } | null;
}

export interface VerificationInput {
  readonly verificationId: PackageVerificationId;
  readonly attemptId: ProcessingAttemptId;
  readonly packageVersionId: PackageVersionId;
  readonly result: VerificationResult;
  readonly problems: ReadonlyArray<string>;
  readonly evidenceClass: VerificationEvidenceClass;
  readonly expectedAuthorityHash: Sha256Hex;
  readonly coreVersion: string;
}

export interface DeliveryCopyInput {
  readonly packageVersionId: PackageVersionId;
  readonly location: ObjectLocation;
  readonly sourceObjectName: string;
  readonly objectId: StoredObjectId;
  readonly objectName: string;
  readonly generation: string;
}

export interface PublicationInput {
  readonly jobId: ProcessingJobId;
  readonly packageVersionId: PackageVersionId;
  readonly deliveryManifestHash: Sha256Hex;
  readonly anchorId: string;
}

/**
 * The publication's answer before COMMIT: PUBLISHED (the edges are written; the deferred guard still decides at COMMIT), or REFUSED
 * without a write when the locked job or package is not where a publication starts (a committed cancellation wins, S062).
 */
export type PublicationOutcome =
  | { readonly kind: "PUBLISHED"; readonly job: ProcessingJobRecord; readonly packageVersion: PackageVersionRecord; readonly attempt: ProcessingAttemptRecord }
  | { readonly kind: "REFUSED"; readonly reason: "JOB_NOT_VERIFYING" | "JOB_CANCELLED" | "PACKAGE_NOT_VERIFIED" | "NOT_THE_JOBS_PACKAGE"; readonly job: ProcessingJobRecord | null; readonly packageVersion: PackageVersionRecord | null };

export interface CleanupInput {
  readonly cleanupId: AttemptCleanupId;
  readonly attemptId: ProcessingAttemptId;
  readonly deletedObjects: ReadonlyArray<{ readonly objectId: StoredObjectId; readonly objectName: string; readonly generation: string }>;
  readonly terminationResult: TerminationResult;
  readonly scratchDeleted: boolean;
  readonly resources: CleanupResources | null;
  readonly result: "CLEANED" | "PARTIAL";
  readonly evidenceClass: "EXECUTED_PROVIDER" | "SIMULATED";
}

/** A takeover's answer: the lease is still live under another owner (HELD), or the new attempt claimed it at fence + 1. */
export type TakeoverOutcome = { readonly kind: "HELD"; readonly lease: LeaseRecord } | { readonly kind: "CLAIMED"; readonly attempt: ProcessingAttemptRecord; readonly lease: LeaseRecord };

export interface ExecutionStore {
  // --- reads -------------------------------------------------------------------------------------------------------------------
  getJob(jobId: ProcessingJobId): Promise<ProcessingJobRecord | null>;
  /** The job row under its row lock (FOR UPDATE): the serialization point of CMD037 and the publication (S062); SKIP_LOCKED for admission. */
  lockJob(jobId: ProcessingJobId, mode?: "WAIT" | "SKIP_LOCKED"): Promise<ProcessingJobRecord | null>;
  /** The one job of an authorization, in whatever state (D8-JOB-1). */
  findJobByAuthorization(authorizationId: CommercialAuthorizationId): Promise<ProcessingJobRecord | null>;
  getAttempt(attemptId: ProcessingAttemptId): Promise<ProcessingAttemptRecord | null>;
  attemptsOf(jobId: ProcessingJobId): Promise<ReadonlyArray<ProcessingAttemptRecord>>;
  getPackage(packageVersionId: PackageVersionId): Promise<PackageVersionRecord | null>;
  /** The one package version of an attempt (born with its manifest submission), or null. */
  packageOfAttempt(attemptId: ProcessingAttemptId): Promise<PackageVersionRecord | null>;
  stagedManifestOf(attemptId: ProcessingAttemptId): Promise<StagedManifestRecord | null>;
  stagedArtifactsOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<StagedArtifactRecord>>;
  readbacksOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<ArtifactReadbackRecord>>;
  deliveryArtifactsOf(packageVersionId: PackageVersionId): Promise<ReadonlyArray<DeliveryArtifactRecord>>;
  verificationsOf(attemptId: ProcessingAttemptId): Promise<ReadonlyArray<PackageVerificationRecord>>;
  cleanupOf(attemptId: ProcessingAttemptId): Promise<AttemptCleanupRecord | null>;
  /** The job's JOB_ATTEMPT lease (resource = the job id). */
  jobLease(jobId: ProcessingJobId): Promise<LeaseRecord | null>;
  /** The platform's ledger and the agency's (D8-CAP-1); zero for an agency that never queued a job. */
  capacity(agencyId: AgencyId): Promise<ExecutionCapacitySnapshot>;
  /** QUEUED jobs of every agency in the fair order of D8-SCHED-1 (the pure fairAdmissionOrder mirrored in SQL). */
  admissionCandidates(limit: number): Promise<ReadonlyArray<AdmissionCandidate>>;

  // --- locks (D8-LOCK-1) ---------------------------------------------------------------------------------------------------------
  /** The shared transition lock of a fact, waiting (request handlers and publication). */
  awaitTransition(subject: TransitionSubject): Promise<void>;
  /** The shared transition lock without waiting (kauro.try_await_transition): false when a transition holds it (JOB_ADMISSION). */
  tryAwaitTransition(subject: TransitionSubject): Promise<boolean>;
  /** The exclusive transition lock without waiting: admission's consumption of the authorization never waits under the ledger. */
  tryTransitionExclusive(subject: TransitionSubject): Promise<boolean>;
  /**
   * The entitlement's row lock without waiting (FOR UPDATE SKIP LOCKED): false when another transaction holds it (a revocation in
   * flight) — or when the row is not one the control plane may move (only ACTIVE or CONSUMED rows are, 0021's update policy).
   * JOB_ADMISSION takes it on an ACTIVE entitlement before its exclusive transition lock, so it never waits under the ledger for a
   * row whose holder waits for that lock (D8-LOCK-1; mandate B08-CONTROL-EXECUTION).
   */
  tryLockAuthorization(authorizationId: CommercialAuthorizationId): Promise<boolean>;
  /** The global ledger row under its lock (JOB_ADMISSION takes it first, D8-SCHED-1). */
  lockGlobalLedger(): Promise<void>;
  /**
   * The facts a job relies on, read in this statement's snapshot (call after the transition locks). It takes the execution subject, not
   * the job row: ExecuteProject (CMD036) reads them before any job exists (D8-CMD-1); a ProcessingJobRecord is one.
   */
  readAuthority(subject: JobExecutionSubject): Promise<ExecutionAuthorityFacts>;

  // --- request handlers (CMD036, CMD037) -------------------------------------------------------------------------------------------
  /** CMD036: the job born QUEUED with processing_job.queued.v1 and its JOB_EXECUTION outbox record; the database stamps its instants. */
  queueJob(job: NewProcessingJob): Promise<ProcessingJobRecord>;
  /** CMD037 (or EXECUTION_CONTROL for a lost authority): cancel_command at expectedVersion, cancel version + 1, recorded once. */
  requestCancellation(jobId: ProcessingJobId, expectedVersion: number, cancellation: JobCancellation): Promise<VersionedWrite<ProcessingJobRecord>>;

  // --- control plane ---------------------------------------------------------------------------------------------------------------
  /**
   * JOB_ADMISSION's unit (the job locked QUEUED, the global ledger and the transition locks held): QUEUED -> ADMITTED, the
   * authorization ACTIVE -> CONSUMED naming the job, the EXECUTION_ADMITTED anchor, the PAID_ORDINARY record unless the revision
   * has one, the JOB_ATTEMPT lease claimed at fence 1 and attempt 1 CREATED -> CLAIMED.
   */
  admit(job: ProcessingJobRecord, attemptId: ProcessingAttemptId): Promise<AdmissionRecord>;
  /** A takeover after the previous attempt ended or lapsed: the lease claimed by a new attempt at fence + 1 (D8-ATT-1). */
  takeOver(jobId: ProcessingJobId, attemptId: ProcessingAttemptId): Promise<TakeoverOutcome>;
  /** CLAIMED -> STARTING with the manifest name; the job takes the ACTIVE slot (WAITING -> ACTIVE) and its execution deadline. */
  recordLaunchIntent(attemptId: ProcessingAttemptId, intent: LaunchIntent): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }>;
  /** What the host answered a launch (D8-HOST-1); a provider job id is learned once and is the deterministic identity. */
  recordLaunch(attemptId: ProcessingAttemptId, launchState: LaunchState, providerJobId: string | null): Promise<ProcessingAttemptRecord>;
  /** STARTING -> RUNNING, and the job ADMITTED -> RUNNING with processing_job.running.v1 when it was not running yet. */
  observeStart(attemptId: ProcessingAttemptId): Promise<{ readonly job: ProcessingJobRecord; readonly attempt: ProcessingAttemptRecord }>;
  /** The monitor's heartbeat of the lease under the attempt's fence, on the server clock; null when fenced out (D8-ATT-2). */
  heartbeat(jobId: ProcessingJobId, attemptId: ProcessingAttemptId, fence: number): Promise<LeaseRecord | null>;
  /** EXECUTION_CONTROL mirrors the job's cancellation into the lease (D8-CANCEL-1). */
  mirrorCancellation(jobId: ProcessingJobId): Promise<LeaseRecord | null>;
  /** The manifest the control plane read, recorded under the fence (D8-STG-3): attempt STAGED, job VERIFYING, package STAGED. */
  submitManifest(attemptId: ProcessingAttemptId, submission: ManifestSubmission): Promise<StagingRecord>;
  /** STAGED -> VERIFYING under the fence. */
  startVerification(attemptId: ProcessingAttemptId): Promise<ProcessingAttemptRecord>;
  recordReadback(readback: ReadbackInput): Promise<ArtifactReadbackRecord>;
  recordVerification(verification: VerificationInput): Promise<PackageVerificationRecord>;
  /** STAGED -> VERIFIED_PRIVATE on a VALID verification with every staging read-back equal (KA084). */
  markVerifiedPrivate(packageVersionId: PackageVersionId, verificationId: PackageVerificationId): Promise<PackageVersionRecord>;
  /** A delivery copy registered DELIVERY under the package's prefix, still private (D8-PUB-1). */
  recordDeliveryCopy(copy: DeliveryCopyInput): Promise<DeliveryArtifactRecord>;
  /** The publication transaction of D8-PUB-2 (see PublicationOutcome). */
  publish(publication: PublicationInput): Promise<PublicationOutcome>;
  /** publication_denied (STAGED | VERIFIED_PRIVATE -> REVOKED) with its reason token; the evidence stays. */
  revokePackage(packageVersionId: PackageVersionId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<PackageVersionRecord>>;
  abandonAttempt(attemptId: ProcessingAttemptId, cause: string): Promise<ProcessingAttemptRecord>;
  failAttempt(attemptId: ProcessingAttemptId, cause: string): Promise<ProcessingAttemptRecord>;
  /** ADMITTED | RUNNING | VERIFYING -> FAILED with its classified cause; the job's slots are released. */
  failJob(jobId: ProcessingJobId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<ProcessingJobRecord>>;
  /** CANCEL_REQUESTED -> CANCELLED once the provider and artifacts are reconciled; the job's slots are released once. */
  completeCancellation(jobId: ProcessingJobId, expectedVersion: number): Promise<VersionedWrite<ProcessingJobRecord>>;
  /** deadline_reached on the server clock, never early (the database refuses an early expiry, KA081). */
  expireJob(jobId: ProcessingJobId, expectedVersion: number, reasonCode: string): Promise<VersionedWrite<ProcessingJobRecord>>;
  /** STAGING_JANITOR's one record of an attempt: exactly its prefix, its identity and the host-reported cost and result (D8-JAN-1). */
  recordCleanup(cleanup: CleanupInput): Promise<AttemptCleanupRecord>;
}

/**
 * A unit of work of processing authority: the commerce unit of work with the execution store on the same connection, and the control
 * plane's discovery reads of execution work (ports/execution-discovery.ts; mandate B08-CONTROL-EXECUTION, D8-CEX-1).
 */
export interface ExecutionUnitOfWork extends CommerceUnitOfWork {
  readonly execution: ExecutionStore;
  readonly executionDiscovery: ExecutionDiscovery;
  /**
   * The database's transaction time, kauro.server_now(), as an exact ISO-8601 instant with microseconds (D8-CLOCK-1): the clock a
   * request handler compares a deadline against (CMD036's source deadline), never the process clock. The same reading as
   * SourceUnitOfWork.serverInstant on the same connection.
   */
  serverInstant(): Promise<string>;
}

export interface ExecutionUnitOfWorkFactory extends CommerceUnitOfWorkFactory {
  run<T>(context: ExecutionContext, work: (uow: ExecutionUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}
