/**
 * The durable records of processing authority (package B08; docs/design/B08-audit-approval-jobs.md §4, §5, §9; registry contracts
 * Job, Lease, PackageManifest): what the adapters of migrations 0021 and 0022 read and write. Instants are the server's
 * (kauro.server_now(), D8-CLOCK-1): every lifecycle instant below is stamped by the database, never supplied by a writer. Money
 * never appears here; the entitlement is B09's CommercialAuthorization, bound by composite key (D8-JOB-2).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { CaptureId, CommercialAuthorizationId } from "../../commerce/records.js";
import type { ServiceMode } from "../aggregates.js";
import type { AgencyId, ApprovalId, CapabilityId, MembershipId, PlanId, ProjectId } from "../ids.js";
import type { StoredObjectId } from "../source/ids.js";
import type { ArtifactReadbackId, AttemptCleanupId, PackageVerificationId, PackageVersionId, ProcessingAttemptId, ProcessingJobId } from "./ids.js";

// --- the job ------------------------------------------------------------------------------------------------------------------

/** Registry Job.state ("Honest durable execution phase"). */
export const JOB_STATES = ["QUEUED", "ADMITTED", "RUNNING", "VERIFYING", "READY", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "EXPIRED"] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_JOB_STATES: ReadonlyArray<JobState> = Object.freeze(["READY", "FAILED", "CANCELLED", "EXPIRED"]);
/** The states in which a job holds a live slot of its agency (D8-CAP-1). */
export const LIVE_JOB_STATES: ReadonlyArray<JobState> = Object.freeze(["QUEUED", "ADMITTED", "RUNNING", "VERIFYING", "CANCEL_REQUESTED"]);

/**
 * What a job holds of the capacity ledgers (D8-CAP-1): BACKLOG (queued: its agency's live slot only), WAITING (admitted: a global
 * waiting slot), ACTIVE (launched: the global active slot), NONE (terminal: nothing). BACKLOG -> WAITING -> ACTIVE -> NONE, never
 * back; CANCEL_REQUESTED keeps what the job held. The database derives it from the state except the launch (WAITING -> ACTIVE).
 */
export const JOB_HOLDS = ["BACKLOG", "WAITING", "ACTIVE", "NONE"] as const;
export type JobHolds = (typeof JOB_HOLDS)[number];

/**
 * The execution subject of a job (D8-JOB-2): the authorization's purchased subject, which the job binds by composite key, and the
 * core package of the receipt the approval names. KAURO_JOB_INPUT_BINDING_V1 over it is the job's input binding hash, the
 * JOB_ATTEMPT lease subject (D8-ATT-1).
 */
export interface JobExecutionSubject {
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly authorizationId: CommercialAuthorizationId;
  readonly captureId: CaptureId;
  readonly planId: PlanId;
  readonly planHash: Sha256Hex;
  readonly approvalId: ApprovalId;
  readonly approvalHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly mode: ServiceMode;
  readonly validationReceiptHash: Sha256Hex;
  readonly corePackageHash: Sha256Hex;
}

/** Who asked for a cancellation (CMD037's person, or EXECUTION_CONTROL's service identity for a lost authority, D8-CANCEL-2). */
export type CancellationActor = { readonly kind: "USER"; readonly userId: string } | { readonly kind: "SERVICE"; readonly serviceId: string };

export interface ProcessingJobRecord extends JobExecutionSubject {
  readonly jobId: ProcessingJobId;
  readonly inputBindingHash: Sha256Hex;
  readonly version: number;
  readonly state: JobState;
  readonly holds: JobHolds;
  /** Registry Job.attempt: the ordinal of the current attempt (0 before admission). */
  readonly attemptCount: number;
  readonly currentAttemptId?: ProcessingAttemptId;
  /** Registry Job.fence: the current attempt's JOB_ATTEMPT lease fence (0 before admission). */
  readonly fence: number;
  /** Capture completion + 172,800 s (D8-RET-1); the lease's absolute deadline. */
  readonly deliveryDeadlineAt: UtcInstant;
  /** Set once with the launch intent: launch + 28,800 s, never past the delivery deadline (D8-DL-1). */
  readonly executionDeadlineAt?: UtcInstant;
  readonly queuedAt: UtcInstant;
  readonly admittedAt?: UtcInstant;
  readonly startedAt?: UtcInstant;
  readonly verifyingAt?: UtcInstant;
  readonly readyAt?: UtcInstant;
  readonly cancelRequestedAt?: UtcInstant;
  readonly terminalAt?: UtcInstant;
  readonly terminalReason?: string;
  readonly cancelVersion: number;
  readonly cancelActor?: CancellationActor;
  /** CMD037 reasonCode (a registry label): kept on the row only, never in an event payload. */
  readonly cancelReasonCode?: string;
  readonly publishedPackageId?: PackageVersionId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

// --- the attempt --------------------------------------------------------------------------------------------------------------

export const ATTEMPT_STATES = ["CREATED", "CLAIMED", "STARTING", "RUNNING", "STAGED", "VERIFYING", "COMMITTED", "ABANDONED", "FAILED"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const TERMINAL_ATTEMPT_STATES: ReadonlyArray<AttemptState> = Object.freeze(["COMMITTED", "ABANDONED", "FAILED"]);

/**
 * What the platform knows of the attempt's provider job (D8-HOST-1): nothing launched yet, launched (created or adopted by
 * identity), UNCERTAIN (a timeout: nothing is created again until observe answers; NOT_FOUND after the host's creation horizon
 * returns it to NOT_LAUNCHED), or REFUSED by the host.
 */
export const LAUNCH_STATES = ["NOT_LAUNCHED", "LAUNCHED", "UNCERTAIN", "REFUSED"] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

export interface ProcessingAttemptRecord {
  readonly attemptId: ProcessingAttemptId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly jobId: ProcessingJobId;
  readonly ordinal: number;
  readonly state: AttemptState;
  /** The JOB_ATTEMPT lease fence the attempt claimed (absent while CREATED). */
  readonly fence?: number;
  /** `kauro-attempt-<attemptId>` (D8-HOST-1): the provider job's name, recorded before any launch. */
  readonly identity: string;
  /** `staging/{agency}/{project}/{job}/{attempt}/` (D8-STG-1). */
  readonly stagingPrefix: string;
  readonly manifestObjectName?: string;
  readonly launchState: LaunchState;
  /** The provider job identity the host reported, learned once; the deterministic identity itself. */
  readonly providerJobId?: string;
  readonly claimedAt?: UtcInstant;
  readonly launchIntentAt?: UtcInstant;
  readonly launchRecordedAt?: UtcInstant;
  readonly startedAt?: UtcInstant;
  readonly stagedAt?: UtcInstant;
  readonly verifyingAt?: UtcInstant;
  readonly endedAt?: UtcInstant;
  readonly terminalCause?: string;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

// --- staging, read-back, verification, packages --------------------------------------------------------------------------------

/** One artifact a staged manifest names (the worker host's StagedArtifact, D8-STG-3), registered as a STAGING stored object. */
export interface StagedArtifactRecord {
  readonly attemptId: ProcessingAttemptId;
  readonly jobId: ProcessingJobId;
  readonly agencyId: AgencyId;
  readonly role: string;
  readonly objectName: string;
  readonly objectId: StoredObjectId;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

export interface StagedManifestRecord {
  readonly attemptId: ProcessingAttemptId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly jobId: ProcessingJobId;
  readonly fence: number;
  readonly inputBindingHash: Sha256Hex;
  readonly objectName: string;
  readonly generation: string;
  /** The raw SHA-256 of the manifest object's bytes: the KAURO_STAGED_MANIFEST_V1 digest (D8-STG-5). */
  readonly manifestHash: Sha256Hex;
  readonly artifactCount: number;
  readonly declaredSummaryHash: Sha256Hex;
  readonly submittedAt: UtcInstant;
}

export type ReadbackKind = "STAGING" | "DELIVERY";
export type ReadbackResult = "EQUAL" | "MISMATCH" | "MISSING";

export interface ArtifactReadbackRecord {
  readonly readbackId: ArtifactReadbackId;
  readonly agencyId: AgencyId;
  readonly jobId: ProcessingJobId;
  readonly attemptId: ProcessingAttemptId;
  readonly kind: ReadbackKind;
  readonly packageVersionId?: PackageVersionId;
  readonly objectName: string;
  readonly expected: { readonly generation: string; readonly sha256: Sha256Hex; readonly byteLength: number };
  /** What the storage returned for exactly that object and generation; absent when nothing was found (MISSING). */
  readonly observed?: { readonly generation: string | null; readonly sha256: Sha256Hex | null; readonly byteLength: number | null };
  readonly result: ReadbackResult;
  readonly readAt: UtcInstant;
}

export type VerificationResult = "VALID" | "INVALID" | "ERROR";
export type VerificationEvidenceClass = "EXECUTED_LOCAL" | "SIMULATED";

export interface PackageVerificationRecord {
  readonly verificationId: PackageVerificationId;
  readonly agencyId: AgencyId;
  readonly jobId: ProcessingJobId;
  readonly attemptId: ProcessingAttemptId;
  readonly packageVersionId: PackageVersionId;
  readonly result: VerificationResult;
  readonly problems: ReadonlyArray<string>;
  readonly evidenceClass: VerificationEvidenceClass;
  /** Digest of the ExpectedAuthority the platform supplied (D8-VER-1). */
  readonly expectedAuthorityHash: Sha256Hex;
  readonly coreVersion: string;
  readonly verifiedAt: UtcInstant;
}

export const PACKAGE_STATES = ["STAGED", "VERIFIED_PRIVATE", "AVAILABLE", "RETIRED", "REVOKED", "DELETED"] as const;
export type PackageState = (typeof PACKAGE_STATES)[number];

export interface PackageVersionRecord {
  readonly packageVersionId: PackageVersionId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly jobId: ProcessingJobId;
  readonly attemptId: ProcessingAttemptId;
  readonly version: number;
  readonly state: PackageState;
  readonly manifestHash: Sha256Hex;
  readonly artifactCount: number;
  /** `delivery/{agency}/{project}/{package}/` (D8-PUB-1). */
  readonly deliveryPrefix: string;
  readonly verificationId?: PackageVerificationId;
  /** KAURO_DELIVERY_MANIFEST_V1 over the issued PackageManifest, set by the publication (D8-PUB-2). */
  readonly deliveryManifestHash?: Sha256Hex;
  readonly verifiedAt?: UtcInstant;
  readonly availableAt?: UtcInstant;
  readonly revokedAt?: UtcInstant;
  readonly revocationReason?: string;
  readonly retiredAt?: UtcInstant;
  readonly deletedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
}

export interface DeliveryArtifactRecord {
  readonly packageVersionId: PackageVersionId;
  readonly agencyId: AgencyId;
  readonly jobId: ProcessingJobId;
  readonly attemptId: ProcessingAttemptId;
  readonly role: string;
  readonly sourceObjectName: string;
  readonly objectName: string;
  readonly objectId: StoredObjectId;
  readonly generation: string;
  readonly sha256: Sha256Hex;
  readonly byteLength: number;
}

// --- cleanup and capacity ------------------------------------------------------------------------------------------------------

export type TerminationResult = "TERMINATED" | "ALREADY_TERMINAL" | "NOT_FOUND" | "UNCERTAIN";

/** What the host reported a provider job cost (the worker host's WorkerResources, D8-JAN-1). */
export interface CleanupResources {
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

/**
 * What the host answered for the attempt's resources in a cleanup pass (B08-R4, D8-REV-4): REPORTED with its figures, NOT_FOUND (the
 * host knows nothing of the identity), or UNAVAILABLE (no answer: the pass stays PARTIAL and a later one asks again).
 */
export type CleanupResourceReport = "REPORTED" | "NOT_FOUND" | "UNAVAILABLE";

export interface AttemptCleanupRecord {
  readonly cleanupId: AttemptCleanupId;
  readonly agencyId: AgencyId;
  readonly jobId: ProcessingJobId;
  readonly attemptId: ProcessingAttemptId;
  readonly providerIdentity: string;
  readonly stagingPrefix: string;
  /** Exactly the objects of the attempt's prefix deleted by generation. */
  readonly deletedObjects: ReadonlyArray<{ readonly objectId: StoredObjectId; readonly objectName: string; readonly generation: string }>;
  readonly terminationResult: TerminationResult;
  readonly scratchDeleted: boolean;
  readonly resources?: CleanupResources;
  readonly resourceReport: CleanupResourceReport;
  /** 1 for the first pass; a PARTIAL pass n is followed by pass n + 1, at most EXECUTION_POLICY.cleanupPasses (D8-REV-3). */
  readonly pass: number;
  readonly result: "CLEANED" | "PARTIAL";
  readonly evidenceClass: "EXECUTED_PROVIDER" | "SIMULATED";
  readonly recordedAt: UtcInstant;
}

/** The two ledgers as a reader sees them (D8-CAP-1, D8-CAP-2): the platform's and one agency's. */
export interface ExecutionCapacitySnapshot {
  readonly activeJobs: number;
  readonly waitingJobs: number;
  readonly agencyLiveJobs: number;
}
