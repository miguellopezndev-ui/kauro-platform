/**
 * The events of processing authority (package B08; docs/design/B08-audit-approval-jobs.md §11, D8-EVT-1, D8-XPKG-6, D8-XPKG-7):
 * one event `<kind>.<state>.v1` per version of the two execution aggregates (ProcessingJob, PackageVersion), and the
 * soft-deadline version of a PAID_ORDINARY retention record that publication writes (D8-RET-1). model/events.ts appends them to
 * EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS and EVENT_SUBSCRIPTIONS; migrations 0021 and 0022 register the
 * same types and kinds (the persistence tests prove the lists equal). This module imports nothing from model/events.ts.
 *
 * Payloads carry ids, hashes, tokens and counts only (07; D8-EVT-1): never an object name, a provider identity, a generation or
 * the cancellation's reason label (which stays on the job row, like B06's withdrawal reason).
 */

export const JOB_EVENT_TYPES = [
  "processing_job.queued.v1",
  "processing_job.admitted.v1",
  "processing_job.running.v1",
  "processing_job.verifying.v1",
  "processing_job.ready.v1",
  "processing_job.failed.v1",
  "processing_job.cancel_requested.v1",
  "processing_job.cancelled.v1",
  "processing_job.expired.v1",
] as const;

export const PACKAGE_EVENT_TYPES = [
  "package_version.staged.v1",
  "package_version.verified_private.v1",
  "package_version.available.v1",
  "package_version.retired.v1",
  "package_version.revoked.v1",
  "package_version.deleted.v1",
] as const;

/** The soft-deadline version of a PAID_ORDINARY record, written by the publication (D8-RET-1; migration 0022). */
export const RETENTION_SOFT_DEADLINE_EVENT_TYPE = "retention_record.soft_deadline_set.v1" as const;

export const EXECUTION_EVENT_TYPES = [...JOB_EVENT_TYPES, ...PACKAGE_EVENT_TYPES, RETENTION_SOFT_DEADLINE_EVENT_TYPE] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

/** B08's execution aggregate kinds (registered by 0021 and 0022 in kauro.aggregate_kinds). The audit kinds are 0023's. */
export const EXECUTION_AGGREGATE_KINDS = ["processing_job", "package_version"] as const;
export type ExecutionAggregateKind = (typeof EXECUTION_AGGREGATE_KINDS)[number];

export const EXECUTION_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<ExecutionEventType, ReadonlyArray<string>>> = Object.freeze({
  "processing_job.queued.v1": ["jobId", "agencyId", "projectId", "authorizationId", "inputBindingHash", "state"],
  "processing_job.admitted.v1": ["jobId", "agencyId", "projectId", "authorizationId", "attemptId", "fence", "state"],
  "processing_job.running.v1": ["jobId", "agencyId", "attemptId", "fence", "state"],
  "processing_job.verifying.v1": ["jobId", "agencyId", "attemptId", "fence", "packageVersionId", "manifestHash", "state"],
  "processing_job.ready.v1": ["jobId", "agencyId", "projectId", "attemptId", "packageVersionId", "deliveryManifestHash", "state"],
  "processing_job.failed.v1": ["jobId", "agencyId", "attemptId", "reasonCode", "previousState", "state"],
  "processing_job.cancel_requested.v1": ["jobId", "agencyId", "cancelVersion", "previousState", "actorKind", "state"],
  "processing_job.cancelled.v1": ["jobId", "agencyId", "cancelVersion", "packageVersionId", "state"],
  "processing_job.expired.v1": ["jobId", "agencyId", "reasonCode", "previousState", "state"],
  "package_version.staged.v1": ["packageVersionId", "agencyId", "jobId", "attemptId", "manifestHash", "artifactCount", "state"],
  "package_version.verified_private.v1": ["packageVersionId", "agencyId", "jobId", "attemptId", "verificationId", "state"],
  "package_version.available.v1": ["packageVersionId", "agencyId", "jobId", "projectId", "deliveryManifestHash", "artifactCount", "state"],
  "package_version.retired.v1": ["packageVersionId", "agencyId", "jobId", "replacedByPackageVersionId", "state"],
  "package_version.revoked.v1": ["packageVersionId", "agencyId", "jobId", "reasonCode", "previousState", "state"],
  "package_version.deleted.v1": ["packageVersionId", "agencyId", "jobId", "state"],
  "retention_record.soft_deadline_set.v1": ["retentionId", "agencyId", "projectId", "revisionId", "retentionClass", "anchorEvidenceHash"],
});

/** The consumer B08-PERSISTENCE-EXECUTION adds (D8-XPKG-7); AUDIT_ORCHESTRATION and PLAN_VALIDATION are the audit mandate's. */
export const EXECUTION_CONSUMERS = ["JOB_EXECUTION"] as const;
export type ExecutionConsumer = (typeof EXECUTION_CONSUMERS)[number];

/** §11: the registered destinations of the execution events (the commerce half, delivered.v1, is in COMMERCE_EVENT_SUBSCRIPTIONS). */
export const EXECUTION_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: ExecutionEventType; readonly consumer: "NOTIFICATIONS" | "EXECUTION_CONTROL" | ExecutionConsumer }> = Object.freeze([
  { eventType: "processing_job.queued.v1", consumer: "JOB_EXECUTION" },
  { eventType: "processing_job.admitted.v1", consumer: "JOB_EXECUTION" },
  { eventType: "processing_job.verifying.v1", consumer: "JOB_EXECUTION" },
  { eventType: "package_version.verified_private.v1", consumer: "JOB_EXECUTION" },
  { eventType: "processing_job.cancel_requested.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "processing_job.ready.v1", consumer: "NOTIFICATIONS" },
  { eventType: "processing_job.failed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "processing_job.cancelled.v1", consumer: "NOTIFICATIONS" },
  { eventType: "processing_job.expired.v1", consumer: "NOTIFICATIONS" },
  { eventType: "package_version.available.v1", consumer: "NOTIFICATIONS" },
]);

/**
 * The event types of edges only the control plane performs (kauro.execution_control_event_types(), migrations 0021 and 0022;
 * D8-ROLE-2, D8-XPKG-6): the request handlers are refused every one of them by a restrictive policy, and kauro_control appends
 * them under its own domain_events policy. processing_job.queued.v1 (CMD036) and processing_job.cancel_requested.v1 (CMD037, and
 * EXECUTION_CONTROL for a lost authority) are the request handlers' own; retention_record.created.v1 stays B07's shared type.
 */
export const EXECUTION_CONTROL_EVENT_TYPES = [
  "processing_job.admitted.v1",
  "processing_job.running.v1",
  "processing_job.verifying.v1",
  "processing_job.ready.v1",
  "processing_job.failed.v1",
  "processing_job.cancelled.v1",
  "processing_job.expired.v1",
  "commercial_authorization.consumed.v1",
  "commercial_authorization.delivered.v1",
  ...PACKAGE_EVENT_TYPES,
  RETENTION_SOFT_DEADLINE_EVENT_TYPE,
] as const;

/** The event of a job version: `processing_job.<state>.v1` (the database checks it at COMMIT, D8-EVT-1). */
export function jobEventTypeOf(state: string): (typeof JOB_EVENT_TYPES)[number] {
  const type = `processing_job.${state.toLowerCase()}.v1`;
  if (!(JOB_EVENT_TYPES as ReadonlyArray<string>).includes(type)) throw new TypeError(`no job event records state ${state}`);
  return type as (typeof JOB_EVENT_TYPES)[number];
}

/** The event of a package version's version: `package_version.<state>.v1`. */
export function packageEventTypeOf(state: string): (typeof PACKAGE_EVENT_TYPES)[number] {
  const type = `package_version.${state.toLowerCase()}.v1`;
  if (!(PACKAGE_EVENT_TYPES as ReadonlyArray<string>).includes(type)) throw new TypeError(`no package event records state ${state}`);
  return type as (typeof PACKAGE_EVENT_TYPES)[number];
}
