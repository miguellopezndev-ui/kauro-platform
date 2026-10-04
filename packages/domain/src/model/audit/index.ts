/**
 * Audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1, §9): identities,
 * records, grant arithmetic, audit deadlines, the policy values, the digests, the events and the failure reasons of cost grants,
 * audits, their steps, model tasks, decision artifacts and validation intents. The registry machines Audit and CostGrant are used as
 * vendored (model/state-machines resolves them from STATE_MACHINES). The port is ports/audit-store.ts; the pg adapters are
 * @kauro/persistence's over migration 0023.
 */
export type { AuditId, CostGrantId, AuditStepId, ModelTaskId, PlanValidationId } from "./ids.js";
export { AUDIT_POLICY, AUDIT_PRICE_PROFILE_HASH } from "./policy.js";
export type { AuditPolicy } from "./policy.js";
export { AUDIT_FAILURE_REASONS } from "./failure-reasons.js";
export type { AuditFailureReason } from "./failure-reasons.js";
export {
  COST_GRANT_STATES,
  COST_GRANT_KINDS,
  AUDIT_STATES,
  LIVE_AUDIT_STATES,
  TERMINAL_AUDIT_STATES,
  AUDIT_STEP_KINDS,
  AUDIT_STEP_OUTCOMES,
  DECISION_ARTIFACT_KINDS,
  PLAN_VALIDATION_ORIGINS,
  PLAN_VALIDATION_RESULTS,
} from "./records.js";
export type {
  CostGrantState,
  CostGrantKind,
  CostGrantRecord,
  AuditState,
  AuditRecord,
  AuditStepKind,
  AuditStepOutcome,
  AuditStepRecord,
  ModelTaskRecord,
  ModelTaskJournalEntry,
  DecisionArtifactKind,
  DecisionArtifactRecord,
  PlanValidationOrigin,
  PlanValidationResult,
  PlanValidationRecord,
} from "./records.js";
export { grantAvailableCents, grantFunds, poolFundsAudit, auditAbsoluteDeadlineOf, interpretationDeadlineOf } from "./grants.js";
export { AUDIT_DIGEST_DOMAINS, decisionArtifactHashOf, modelTaskCheckpointOf, modelTaskJournalEventHashOf } from "./digests.js";
export type { PlannedModelTask } from "./digests.js";
export {
  AUDIT_EVENT_TYPES,
  COST_GRANT_EVENT_TYPES,
  AUDIT_AUTHORITY_EVENT_TYPES,
  AUDIT_AGGREGATE_KINDS,
  AUDIT_EVENT_PAYLOAD_ALLOWLIST,
  AUDIT_CONSUMERS,
  AUDIT_EVENT_SUBSCRIPTIONS,
  AUDIT_CONTROL_EVENT_TYPES,
  auditEventTypeOf,
  costGrantEventTypeOf,
} from "./events.js";
export type { AuditAuthorityEventType, AuditAggregateKind, AuditConsumer } from "./events.js";
