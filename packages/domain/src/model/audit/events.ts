/**
 * The events of audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §11, D8-EVT-1,
 * D8-XPKG-7): one event `<kind>.<state>.v1` per version of the two audit aggregates (Audit, CostGrant). model/events.ts appends them
 * to EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS and EVENT_SUBSCRIPTIONS; migration 0021 registers the same types
 * and kinds (the persistence tests prove the lists equal). This module imports nothing from model/events.ts.
 *
 * Payloads carry ids, hashes, tokens and counts only (07; D8-EVT-1): never a prompt, a model response, a decision document or a
 * customer value — the pending decisions of NEEDS_DECISION travel as a count, their tokens stay on the audit's row.
 */

export const AUDIT_EVENT_TYPES = [
  "audit.queued.v1",
  "audit.profiling.v1",
  "audit.interpreting.v1",
  "audit.validating.v1",
  "audit.draft_ready.v1",
  "audit.needs_decision.v1",
  "audit.unsupported.v1",
  "audit.failed.v1",
  "audit.cancelled.v1",
  "audit.expired.v1",
] as const;

export const COST_GRANT_EVENT_TYPES = ["cost_grant.prepared.v1", "cost_grant.authorized.v1", "cost_grant.exhausted.v1", "cost_grant.expired.v1", "cost_grant.closed.v1"] as const;

export const AUDIT_AUTHORITY_EVENT_TYPES = [...AUDIT_EVENT_TYPES, ...COST_GRANT_EVENT_TYPES] as const;
export type AuditAuthorityEventType = (typeof AUDIT_AUTHORITY_EVENT_TYPES)[number];

/** B08's audit aggregate kinds (registered by 0021 in kauro.aggregate_kinds). */
export const AUDIT_AGGREGATE_KINDS = ["audit", "cost_grant"] as const;
export type AuditAggregateKind = (typeof AUDIT_AGGREGATE_KINDS)[number];

const AUDIT_KEYS = ["auditId", "agencyId", "projectId", "revisionId", "targetContractId", "grantId", "fence", "previousState", "state"] as const;

export const AUDIT_EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<AuditAuthorityEventType, ReadonlyArray<string>>> = Object.freeze({
  "audit.queued.v1": ["auditId", "agencyId", "projectId", "revisionId", "revisionHash", "targetContractId", "targetContractHash", "grantId", "state"],
  "audit.profiling.v1": [...AUDIT_KEYS],
  "audit.interpreting.v1": [...AUDIT_KEYS, "profileEvidenceHash", "candidateManifestHash"],
  "audit.validating.v1": [...AUDIT_KEYS],
  "audit.draft_ready.v1": [...AUDIT_KEYS, "draftPlanId"],
  "audit.needs_decision.v1": [...AUDIT_KEYS, "findingCount"],
  "audit.unsupported.v1": [...AUDIT_KEYS, "findingCount"],
  "audit.failed.v1": [...AUDIT_KEYS, "reasonCode"],
  "audit.cancelled.v1": [...AUDIT_KEYS, "cancelVersion", "actorKind", "reasonCode"],
  "audit.expired.v1": [...AUDIT_KEYS, "reasonCode"],
  "cost_grant.prepared.v1": ["grantId", "agencyId", "grantKind", "poolGrantId", "ceilingCents", "state"],
  "cost_grant.authorized.v1": ["grantId", "agencyId", "grantKind", "poolGrantId", "ceilingCents", "previousState", "state"],
  "cost_grant.exhausted.v1": ["grantId", "agencyId", "reservedCents", "reconciledSpendCents", "previousState", "state"],
  "cost_grant.expired.v1": ["grantId", "agencyId", "reservedCents", "reconciledSpendCents", "previousState", "state"],
  "cost_grant.closed.v1": ["grantId", "agencyId", "reservedCents", "reconciledSpendCents", "previousState", "state"],
});

/** The consumers B08-PERSISTENCE-AUDIT adds (D8-XPKG-7, D8-CONS-1): the audit's three steps, and a plan's validation intent. */
export const AUDIT_CONSUMERS = ["AUDIT_ORCHESTRATION", "PLAN_VALIDATION"] as const;
export type AuditConsumer = (typeof AUDIT_CONSUMERS)[number];

/** §11: the registered destinations of the audit events, and the validation intent of a plan (B06's plan.validating.v1). */
export const AUDIT_EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: AuditAuthorityEventType | "plan.validating.v1"; readonly consumer: "NOTIFICATIONS" | AuditConsumer }> = Object.freeze([
  { eventType: "audit.queued.v1", consumer: "AUDIT_ORCHESTRATION" },
  { eventType: "audit.profiling.v1", consumer: "AUDIT_ORCHESTRATION" },
  { eventType: "audit.interpreting.v1", consumer: "AUDIT_ORCHESTRATION" },
  { eventType: "audit.validating.v1", consumer: "AUDIT_ORCHESTRATION" },
  { eventType: "audit.cancelled.v1", consumer: "AUDIT_ORCHESTRATION" },
  { eventType: "audit.draft_ready.v1", consumer: "NOTIFICATIONS" },
  { eventType: "audit.needs_decision.v1", consumer: "NOTIFICATIONS" },
  { eventType: "audit.unsupported.v1", consumer: "NOTIFICATIONS" },
  { eventType: "audit.failed.v1", consumer: "NOTIFICATIONS" },
  { eventType: "audit.expired.v1", consumer: "NOTIFICATIONS" },
  { eventType: "plan.validating.v1", consumer: "PLAN_VALIDATION" },
]);

/**
 * The event types of edges only the control plane performs (kauro.audit_control_event_types(), migration 0021; D8-ROLE-2): the
 * request handlers are refused every one of them by a restrictive policy, and kauro_control appends them under its own domain_events
 * policy. audit.queued.v1 and the AUDIT grant's cost_grant.prepared.v1 / cost_grant.authorized.v1 are StartAudit's (CMD020), and
 * audit.cancelled.v1 is CancelAudit's (CMD021) as well as EXECUTION_CONTROL's for a lost source (D8-CANCEL-2).
 */
export const AUDIT_CONTROL_EVENT_TYPES = [
  "audit.profiling.v1",
  "audit.interpreting.v1",
  "audit.validating.v1",
  "audit.draft_ready.v1",
  "audit.needs_decision.v1",
  "audit.unsupported.v1",
  "audit.failed.v1",
  "audit.expired.v1",
  "cost_grant.exhausted.v1",
  "cost_grant.expired.v1",
  "cost_grant.closed.v1",
] as const;

/** The event of an audit version: `audit.<state>.v1` (the database checks it at COMMIT, D8-EVT-1). */
export function auditEventTypeOf(state: string): (typeof AUDIT_EVENT_TYPES)[number] {
  const type = `audit.${state.toLowerCase()}.v1`;
  if (!(AUDIT_EVENT_TYPES as ReadonlyArray<string>).includes(type)) throw new TypeError(`no audit event records state ${state}`);
  return type as (typeof AUDIT_EVENT_TYPES)[number];
}

/** The event of a cost grant version: `cost_grant.<state>.v1`. */
export function costGrantEventTypeOf(state: string): (typeof COST_GRANT_EVENT_TYPES)[number] {
  const type = `cost_grant.${state.toLowerCase()}.v1`;
  if (!(COST_GRANT_EVENT_TYPES as ReadonlyArray<string>).includes(type)) throw new TypeError(`no cost grant event records state ${state}`);
  return type as (typeof COST_GRANT_EVENT_TYPES)[number];
}
