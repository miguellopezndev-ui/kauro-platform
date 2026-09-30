/**
 * Processing authority (package B08, mandate B08-PERSISTENCE-EXECUTION; docs/design/B08-audit-approval-jobs.md §4, §5, §8.2, §9):
 * identities, records, the two platform machines, the policy values, the digests, the fair scheduler and the failure reasons of job
 * admission, fenced attempts, staging, verification and publication. The port is ports/execution-store.ts; the pg adapters are
 * @kauro/persistence's over migrations 0021 and 0022.
 */
export type { ProcessingJobId, ProcessingAttemptId, PackageVersionId, PackageVerificationId, ArtifactReadbackId, AttemptCleanupId } from "./ids.js";
export { EXECUTION_POLICY } from "./policy.js";
export type { ExecutionPolicy } from "./policy.js";
export { EXECUTION_FAILURE_REASONS } from "./failure-reasons.js";
export type { ExecutionFailureReason } from "./failure-reasons.js";
export { EXECUTION_PLATFORM_MACHINES } from "./machines.js";
export type { ExecutionPlatformMachineName } from "./machines.js";
export {
  JOB_EVENT_TYPES,
  PACKAGE_EVENT_TYPES,
  RETENTION_SOFT_DEADLINE_EVENT_TYPE,
  EXECUTION_EVENT_TYPES,
  EXECUTION_AGGREGATE_KINDS,
  EXECUTION_EVENT_PAYLOAD_ALLOWLIST,
  EXECUTION_CONSUMERS,
  EXECUTION_EVENT_SUBSCRIPTIONS,
  EXECUTION_CONTROL_EVENT_TYPES,
  jobEventTypeOf,
  packageEventTypeOf,
} from "./events.js";
export type { ExecutionEventType, ExecutionAggregateKind, ExecutionConsumer } from "./events.js";
export {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  LIVE_JOB_STATES,
  JOB_HOLDS,
  ATTEMPT_STATES,
  TERMINAL_ATTEMPT_STATES,
  LAUNCH_STATES,
  PACKAGE_STATES,
} from "./records.js";
export type {
  JobState,
  JobHolds,
  JobExecutionSubject,
  CancellationActor,
  ProcessingJobRecord,
  AttemptState,
  LaunchState,
  ProcessingAttemptRecord,
  StagedArtifactRecord,
  StagedManifestRecord,
  ReadbackKind,
  ReadbackResult,
  ArtifactReadbackRecord,
  VerificationResult,
  VerificationEvidenceClass,
  PackageVerificationRecord,
  PackageState,
  PackageVersionRecord,
  DeliveryArtifactRecord,
  TerminationResult,
  CleanupResources,
  AttemptCleanupRecord,
  ExecutionCapacitySnapshot,
} from "./records.js";
export {
  EXECUTION_DIGEST_DOMAINS,
  jobInputBindingHashOf,
  stagedManifestHashOf,
  deliveryManifestHashOf,
  jobAttemptIdentityOf,
  jobAttemptStagingPrefixOf,
  packageDeliveryPrefixOf,
} from "./digests.js";
export type { StagedManifestArtifact, StagedManifestDocument, DeliveryManifestArtifact, DeliveryPackageManifest } from "./digests.js";
export { compareAdmissionCandidates, fairAdmissionOrder } from "./scheduler.js";
export type { AdmissionCandidate } from "./scheduler.js";
