/**
 * Domain events and the outbox vocabulary (07 "Outbox, inbox and event ordering"; contract DomainEvent, OutboxRecord).
 *
 * A DomainEvent is written in the same transaction as the aggregate change it records (07 "Transaction discipline"); the
 * database refuses to commit an aggregate version without its event (constraint trigger kauro.require_event_for_version).
 * Payloads are allowlisted references and safe counts, never CRM rows, labels or secrets: every event type declares the keys
 * it may carry and every value must be an id, a hash, an uppercase token, a non-negative integer, a boolean or a list of
 * ids/hashes. Consumers are registered destinations; the code-owned subscription table below is the fan-out authority the
 * EventPublisher uses to create outbox records.
 */
import type { DomainEvent, Id, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { canonicalBytes, isSha256Hex, rawDigest } from "@kauro/contracts";
import type { AgencyId, CausationId, CorrelationId, EventId } from "./ids.js";
import { isUuid } from "./ids.js";
import type { ActorRef } from "./tenant.js";

export const EVENT_TYPES = [
  // Agency lifecycle (registry Agency machine: agreements_and_profile_accepted, material_risk_or_account_failure,
  // restriction_remedied, owner_requests_closure, owner_abandons_setup, closure_obligations_completed)
  "agency.created.v1",
  "agency.activated.v1",
  "agency.restricted.v1",
  "agency.restriction_remedied.v1",
  "agency.closing.v1",
  "agency.closed.v1",
  // Membership lifecycle (registry Membership machine)
  "membership.created.v1",
  "membership.invited.v1",
  "membership.accepted.v1",
  "membership.expired.v1",
  "membership.suspended.v1",
  "membership.reactivated.v1",
  "membership.revoked.v1",
  "membership.role_changed.v1",
  "agency.ownership_transferred.v1",
  // End clients
  "end_client.created.v1",
  "end_client.archived.v1",
  // Projects and revisions (registry DatasetRevision machine: one event per target state, registered with the machine the
  // schema seeds, as the Agency and Membership lifecycles are; their commands arrive with B07)
  "project.created.v1",
  "dataset_revision.created.v1",
  "dataset_revision.uploading.v1",
  "dataset_revision.inspecting.v1",
  "dataset_revision.ready_to_seal.v1",
  "dataset_revision.sealed.v1",
  "dataset_revision.rejected.v1",
  "dataset_revision.cancelled.v1",
  "dataset_revision.superseded.v1",
  "dataset_revision.expired.v1",
  "dataset_revision.deleted.v1",
  // Plans and approvals (registry Plan machine)
  "plan.created.v1",
  "plan.validation_required.v1",
  "plan.validating.v1",
  "plan.validated.v1",
  "plan.superseded.v1",
  "plan.approved.v1",
  "plan.withdrawn.v1",
  "approval.created.v1",
  "approval.withdrawn.v1",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const AGGREGATE_KINDS = ["agency", "membership", "end_client", "project", "dataset_revision", "plan", "approval"] as const;
export type AggregateKind = (typeof AGGREGATE_KINDS)[number];

/** Keys each event type may carry (07: references and safe counts only). */
export const EVENT_PAYLOAD_ALLOWLIST: Readonly<Record<EventType, ReadonlyArray<string>>> = Object.freeze({
  "agency.created.v1": ["agencyId", "createdByUserId", "state"],
  "agency.activated.v1": ["agencyId"],
  "agency.restricted.v1": ["agencyId", "incidentId"],
  "agency.restriction_remedied.v1": ["agencyId", "incidentId"],
  "agency.closing.v1": ["agencyId"],
  "agency.closed.v1": ["agencyId"],
  "membership.created.v1": ["membershipId", "agencyId", "userId", "role", "state"],
  "membership.invited.v1": ["membershipId", "agencyId", "role", "invitedByMembershipId"],
  "membership.accepted.v1": ["membershipId", "agencyId", "userId", "role"],
  "membership.expired.v1": ["membershipId", "agencyId"],
  "membership.suspended.v1": ["membershipId", "agencyId", "byMembershipId"],
  "membership.reactivated.v1": ["membershipId", "agencyId", "byMembershipId"],
  "membership.revoked.v1": ["membershipId", "agencyId", "byMembershipId", "reasonCode"],
  "membership.role_changed.v1": ["membershipId", "agencyId", "role", "previousRole", "byMembershipId"],
  "agency.ownership_transferred.v1": ["agencyId", "fromMembershipId", "toMembershipId"],
  "end_client.created.v1": ["clientId", "agencyId", "processingAuthorityRef", "createdByMembershipId"],
  "end_client.archived.v1": ["clientId", "agencyId", "openProjects", "archivedByMembershipId"],
  "project.created.v1": ["projectId", "agencyId", "clientId", "mode", "capabilityId", "capabilityVersion", "initialRevisionId", "createdByMembershipId"],
  "dataset_revision.created.v1": ["revisionId", "agencyId", "projectId", "state"],
  "dataset_revision.uploading.v1": ["revisionId", "agencyId", "projectId"],
  "dataset_revision.inspecting.v1": ["revisionId", "agencyId", "projectId"],
  "dataset_revision.ready_to_seal.v1": ["revisionId", "agencyId", "projectId"],
  "dataset_revision.sealed.v1": ["revisionId", "agencyId", "projectId", "manifestHash", "projectionHash"],
  "dataset_revision.rejected.v1": ["revisionId", "agencyId", "projectId", "reasonCode"],
  "dataset_revision.cancelled.v1": ["revisionId", "agencyId", "projectId"],
  "dataset_revision.superseded.v1": ["revisionId", "agencyId", "projectId", "successorRevisionId"],
  "dataset_revision.expired.v1": ["revisionId", "agencyId", "projectId"],
  "dataset_revision.deleted.v1": ["revisionId", "agencyId", "projectId"],
  "plan.created.v1": ["planId", "agencyId", "projectId", "bodyHash", "supersedesPlanId", "createdByMembershipId"],
  "plan.validation_required.v1": ["planId", "agencyId", "bodyHash"],
  "plan.validating.v1": ["planId", "agencyId", "bodyHash"],
  "plan.validated.v1": ["planId", "agencyId", "bodyHash", "validationReceiptHash"],
  "plan.superseded.v1": ["planId", "agencyId", "successorPlanId", "invalidatedApprovalId", "invalidatedReceiptHash"],
  "plan.approved.v1": ["planId", "agencyId", "approvalId", "approvalHash"],
  "plan.withdrawn.v1": ["planId", "agencyId", "approvalId", "reasonCode"],
  "approval.created.v1": ["approvalId", "agencyId", "planId", "planHash", "revisionHash", "targetContractHash", "validationReceiptHash", "disclosuresHash", "actorMembershipId", "approvalHash"],
  "approval.withdrawn.v1": ["approvalId", "agencyId", "planId", "reasonCode", "withdrawnByMembershipId", "completedExternalActions"],
});

/** Registered destinations (07: "consumer: Registered destination"). Dispatchers arrive with their owning packages. */
export const CONSUMERS = ["NOTIFICATIONS", "EXECUTION_CONTROL"] as const;
export type Consumer = (typeof CONSUMERS)[number];

export const EVENT_SUBSCRIPTIONS: ReadonlyArray<{ readonly eventType: EventType; readonly consumer: Consumer }> = Object.freeze([
  { eventType: "agency.created.v1", consumer: "NOTIFICATIONS" },
  { eventType: "membership.invited.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.created.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.withdrawn.v1", consumer: "NOTIFICATIONS" },
  { eventType: "approval.withdrawn.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "plan.withdrawn.v1", consumer: "EXECUTION_CONTROL" },
  { eventType: "plan.superseded.v1", consumer: "EXECUTION_CONTROL" },
]);

export function consumersOf(eventType: EventType): ReadonlyArray<Consumer> {
  return EVENT_SUBSCRIPTIONS.filter((s) => s.eventType === eventType).map((s) => s.consumer);
}

export type SafePayloadValue = Id | Sha256Hex | string | number | boolean | ReadonlyArray<string>;
export type EventPayload = Readonly<Record<string, SafePayloadValue>>;

const TOKEN = /^[A-Z][A-Z0-9_.-]{0,63}$/;

/** An uppercase machine token (states, roles, modes, reason codes, platform version labels such as R2-INITIAL). */
export function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function isSafeScalar(v: unknown): boolean {
  if (typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0;
  if (typeof v === "string") return isUuid(v) || isSha256Hex(v) || TOKEN.test(v);
  return false;
}

/**
 * Rejects a payload that carries a key outside the allowlist of its event type or a value that is not a safe reference,
 * token, count or boolean. Labels, free text, nested objects and negative numbers never enter the outbox.
 */
export function assertAllowlistedPayload(eventType: EventType, payload: EventPayload): void {
  const allowed = EVENT_PAYLOAD_ALLOWLIST[eventType];
  for (const [k, v] of Object.entries(payload)) {
    if (!allowed.includes(k)) throw new TypeError(`${eventType}: payload key ${k} is not allowlisted`);
    if (Array.isArray(v)) {
      if (!v.every((x) => typeof x === "string" && (isUuid(x) || isSha256Hex(x)))) throw new TypeError(`${eventType}: list ${k} may hold only ids or hashes`);
    } else if (!isSafeScalar(v)) {
      throw new TypeError(`${eventType}: value of ${k} is not a safe reference, token, count or boolean`);
    }
  }
}

/** payloadArtifactHash (contract DomainEvent): SHA-256 of the canonical JSON of the closed payload. */
export function payloadDigest(payload: EventPayload): Sha256Hex {
  return rawDigest(canonicalBytes(payload));
}

export const EVENT_SCHEMA_VERSION = "1";

/** What a command hands to the EventPublisher: everything except the server-minted id, time and digest. */
export interface NewDomainEvent {
  readonly aggregateKind: AggregateKind;
  readonly aggregateId: Id;
  readonly aggregateVersion: number;
  readonly agencyId: AgencyId | null;
  readonly eventType: EventType;
  readonly actor: ActorRef;
  readonly causationId: CausationId;
  readonly correlationId: CorrelationId;
  readonly payload: EventPayload;
}

/**
 * What an aggregate operation yields beside its new record: the event of the new aggregate version without the request
 * provenance (actor, causation, correlation), which the command handler adds with `withProvenance` before publishing.
 * Every aggregate function validates its payload against the allowlist at construction, so an event that reaches the
 * publisher has already been proven free of labels and free text.
 */
export type AggregateEvent = Omit<NewDomainEvent, "actor" | "causationId" | "correlationId">;

export interface EventProvenance {
  readonly actor: ActorRef;
  readonly causationId: CausationId;
  readonly correlationId: CorrelationId;
}

export function aggregateEvent(event: AggregateEvent): AggregateEvent {
  assertAllowlistedPayload(event.eventType, event.payload);
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 1) throw new RangeError(`${event.eventType}: aggregate version must be a positive integer`);
  return Object.freeze({ ...event, payload: Object.freeze({ ...event.payload }) });
}

export function withProvenance(event: AggregateEvent, provenance: EventProvenance): NewDomainEvent {
  return { ...event, actor: provenance.actor, causationId: provenance.causationId, correlationId: provenance.correlationId };
}

/** The durable row: the registry DomainEvent contract plus the columns the platform adds. */
export interface DomainEventRecord extends DomainEvent {
  readonly eventId: EventId;
  readonly aggregateKind: AggregateKind;
  readonly actor: ActorRef;
  readonly payload: EventPayload;
  /** Global append order (identity column); dispatch order within a consumer, never business order across aggregates. */
  readonly sequence: number;
  readonly createdAt: UtcInstant;
}
