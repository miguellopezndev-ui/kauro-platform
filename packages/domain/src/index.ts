/**
 * @kauro/domain — the domain layer of the Kauro platform (07 "Platform topology": contracts → domain ports → application →
 * adapters). It owns aggregate identity, tenant context, the role/capability model, state-machine guards over the registry,
 * registered domain events, the failure taxonomy, the idempotency identity and the ports every adapter implements.
 * It depends on @kauro/contracts only; it never imports persistence, payments, a framework or UI.
 */
export type {
  Branded,
  AgencyId,
  UserId,
  MembershipId,
  InvitationId,
  ProcessingAuthorityId,
  ClientId,
  ProjectId,
  RevisionId,
  TargetContractId,
  PlanId,
  ValidationReceiptId,
  ApprovalId,
  AssuranceProofId,
  CapabilityId,
  EventId,
  OutboxId,
  CorrelationId,
  CausationId,
  JournalEntryId,
  RequestId,
  TaskId,
  LeaseOwnerId,
  ResourceId,
  ArtifactRef,
  TargetInstanceRef,
} from "./model/ids.js";
export { isUuidV7, isUuidV5, isUuid, encodeUuidV7, uuidV7Timestamp, identityUserId, IDENTITY_NAMESPACE } from "./model/ids.js";

export type { FailureCode, FailureReason, FieldError, FailureDetails } from "./model/errors.js";
export { FAILURE_CODES, AUTHORITY_FAILURE_CODES, FAILURE_REASONS, DomainFailure, StaleVersionFailure, IdempotencyConflictFailure, isDomainFailure } from "./model/errors.js";

export type { MembershipRole, AgencyCommandRole, AgencyCapability } from "./model/roles.js";
export { MEMBERSHIP_ROLES, AGENCY_COMMAND_ROLES, COMMAND_ROLE_MEMBERS, AGENCY_CAPABILITIES, ROLE_CAPABILITIES, isAgencyCommandRole, roleSatisfies, commandRole, capabilitiesOf } from "./model/roles.js";

export type { MachineName } from "./model/state-machines.js";
export { machine, statesOf, findTransition, isTerminal, transition } from "./model/state-machines.js";

export type { EventType, AggregateKind, Consumer, EventPayload, SafePayloadValue, NewDomainEvent, DomainEventRecord } from "./model/events.js";
export { EVENT_TYPES, AGGREGATE_KINDS, EVENT_PAYLOAD_ALLOWLIST, CONSUMERS, EVENT_SUBSCRIPTIONS, EVENT_SCHEMA_VERSION, consumersOf, assertAllowlistedPayload, payloadDigest } from "./model/events.js";

export type { ActorRef, TenantContext, IdentityContext, SystemContext, ExecutionContext, IdentityFacts, ResolvedMembership } from "./model/tenant.js";
export { actorOf, isVerifiedIdentity } from "./model/tenant.js";

export type {
  AgencyRecord,
  MembershipRecord,
  ProcessingAuthorityRecord,
  EndClientRecord,
  ServiceMode,
  ProjectState,
  ProjectRecord,
  DatasetRevisionRecord,
  TargetContractRecord,
  PlanRecord,
  PlanBody,
  ValidationReceiptRecord,
  ApprovalRecord,
  CapabilityRecord,
} from "./model/aggregates.js";
export { SERVICE_MODES, PROJECT_STATES, OFFERED_CAPABILITY_STATES, isOffered, AGENCY_OPEN_STATES } from "./model/aggregates.js";

export type { Environment, IdempotencyIdentity, CommandRequestSubject, JournalState, CommandJournalEntry } from "./model/idempotency.js";
export { ENVIRONMENTS, IDEMPOTENCY_KEY, COMMAND_REQUEST_DOMAIN, commandRequestDigest } from "./model/idempotency.js";

export * from "./ports/index.js";
