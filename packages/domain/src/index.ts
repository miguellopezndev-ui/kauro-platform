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
  SupportCaseId,
  RevisionId,
  TargetContractId,
  PlanId,
  ValidationReceiptId,
  ApprovalId,
  AssuranceProofId,
  CapabilityId,
  EventId,
  InquiryId,
  OutboxId,
  InboxId,
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

export type { FailureCode, FailureReason, FieldError, FailureDetails, FailureContract, TypedPatchFieldCode } from "./model/errors.js";
export {
  FAILURE_CODES,
  AUTHORITY_FAILURE_CODES,
  FAILURE_REASONS,
  FAILURE_HTTP_STATUS,
  FAILURE_TITLES,
  RETRYABLE_FAILURE_CODES,
  DomainFailure,
  StaleVersionFailure,
  LiveQuoteChangedFailure,
  IdempotencyConflictFailure,
  PreconditionFailure,
  InvalidRequestFailure,
  NotAuthorizedFailure,
  NotFoundFailure,
  isDomainFailure,
  describeFailure,
} from "./model/errors.js";

export { isLabel, isReasonCode, assertLabel, assertReasonCode, assertAggregateId, assertIdentityId, assertExternalRef, assertInstant, instantMs, isBefore } from "./model/fields.js";

export type { Versioned } from "./model/versioning.js";
export { isVersion, assertVersionField, assertExpectedVersion, nextVersion } from "./model/versioning.js";

export type { MembershipRole, AgencyCommandRole, AgencyCapability } from "./model/roles.js";
export { MEMBERSHIP_ROLES, AGENCY_COMMAND_ROLES, COMMAND_ROLE_MEMBERS, AGENCY_CAPABILITIES, ROLE_CAPABILITIES, isAgencyCommandRole, roleSatisfies, commandRole, capabilitiesOf } from "./model/roles.js";

export type { MachineName, RegistryMachineName, PlatformMachineName } from "./model/state-machines.js";
export { PLATFORM_STATE_MACHINES, UNLISTED_TRANSITION_POLICY, machine, statesOf, eventsOf, findTransition, isListed, isTerminal, transition } from "./model/state-machines.js";

export type { EventType, AggregateKind, Consumer, EventPayload, SafePayloadValue, NewDomainEvent, DomainEventRecord, AggregateEvent, EventProvenance } from "./model/events.js";
export {
  EVENT_TYPES,
  AGGREGATE_KINDS,
  EVENT_PAYLOAD_ALLOWLIST,
  CONSUMERS,
  EVENT_SUBSCRIPTIONS,
  EVENT_SCHEMA_VERSION,
  consumersOf,
  assertAllowlistedPayload,
  isSafeToken,
  payloadDigest,
  aggregateEvent,
  withProvenance,
} from "./model/events.js";

export type {
  ActorRef,
  SecurityActor,
  TenantContext,
  IdentityContext,
  SystemContext,
  AnonymousContext,
  ServiceContext,
  OperatorContext,
  ActingContext,
  ExecutionContext,
  IdentityFacts,
  ResolvedMembership,
  TenantScope,
} from "./model/tenant.js";
export { actorOf, userIdOf, isVerifiedIdentity, tenantScopeOf, assertInScope, assertSameScope } from "./model/tenant.js";

export type { IdentityState, IdentityRecord, AuthenticatedSubject, AssuranceMethod, AssuranceProof, StepUpOutcome, StepUpCheck } from "./model/identity.js";
export { IDENTITY_STATES, ASSURANCE_METHODS, subjectDigest, registerIdentity, syncIdentity, identityFacts, assertVerifiedIdentity, evaluateStepUp, assertFreshStepUp } from "./model/identity.js";

export type { AgencyState, AgencyOutcome, CreateAgencyInput, ActivateAgencyInput } from "./model/agency.js";
export {
  AGENCY_CLOSURE_STATES,
  createAgency,
  activateAgency,
  restrictAgency,
  remedyRestriction,
  requestClosure,
  abandonSetup,
  completeClosure,
  isAgencyOpen,
  assertAgencyOpen,
  assertAgencyActive,
  isUnderClosureAuthority,
} from "./model/agency.js";

export type {
  MembershipState,
  MembershipOutcome,
  OwnershipFacts,
  TeamAction,
  CreateOwnerMembershipInput,
  InviteMemberInput,
  InviteContext,
  InvitationOutcome,
  AcceptInvitationInput,
  RevokeInvitationInput,
  MembershipChangeInput,
  ReactivateMembershipInput,
  ChangeRoleInput,
  TransferOwnershipInput,
  OwnershipTransferOutcome,
} from "./model/membership.js";
export {
  LIVE_MEMBERSHIP_STATES,
  TEAM_MANAGER_ROLES,
  isLiveMembership,
  isActiveOwner,
  isMembershipRole,
  assertMembershipRole,
  mintInvitationToken,
  hashInvitationToken,
  tokenHashesEqual,
  wouldLeaveNoActiveOwner,
  assertOwnershipPreserved,
  assertTeamAuthority,
  grantableRoles,
  createOwnerMembership,
  inviteMember,
  acceptInvitation,
  expireInvitation,
  revokeInvitation,
  suspendMembership,
  reactivateMembership,
  revokeMembership,
  changeMembershipRole,
  transferOwnership,
} from "./model/membership.js";

export type { EndClientOutcome, CreateEndClientInput, CreateEndClientContext, ArchiveEndClientInput } from "./model/end-client.js";
export { createEndClient, archiveEndClient, assertClientActive, assertActorInAgency } from "./model/end-client.js";

export type { CreateProjectInput, CreateProjectContext, ProjectOutcome } from "./model/project.js";
export { isServiceMode, createProject } from "./model/project.js";

export type { StepUpFacts, AccessRequest, AccessDenial, AccessDecision } from "./model/authorization.js";
export { commandRequiresStepUp, decideCommandAccess } from "./model/authorization.js";

export type {
  AgencyRecord,
  MembershipRecord,
  InvitationRecord,
  ProcessingAuthorityRecord,
  EndClientRecord,
  ServiceMode,
  ProjectState,
  ProjectRecord,
  SupportCategory,
  SupportSeverity,
  SupportCaseState,
  SupportCaseRecord,
  DatasetRevisionRecord,
  TargetContractRecord,
  PlanRecord,
  PlanBody,
  ValidationReceiptRecord,
  ApprovalRecord,
  CapabilityRecord,
} from "./model/aggregates.js";
export { SERVICE_MODES, PROJECT_STATES, SUPPORT_CATEGORIES, SUPPORT_SEVERITIES, SUPPORT_CASE_STATES, OFFERED_CAPABILITY_STATES, isOffered, AGENCY_OPEN_STATES } from "./model/aggregates.js";

export type {
  InquiryBuyerType,
  InquiryDestination,
  InquiryRecordBand,
  InquiryTiming,
  InquiryAdmissionKind,
  InquiryContent,
  InquiryAdmissionKeys,
} from "./model/inquiry.js";
export {
  INQUIRY_BUYER_TYPES,
  INQUIRY_DESTINATIONS,
  INQUIRY_RECORD_BANDS,
  INQUIRY_TIMINGS,
  INQUIRY_RECEIVED_EVENT,
  INQUIRY_ADMISSION_KINDS,
  INQUIRY_LIMITS,
} from "./model/inquiry.js";

export type { Environment, IdempotencyIdentity, CommandRequestSubject, JournalState, CommandJournalEntry } from "./model/idempotency.js";
export { ENVIRONMENTS, IDEMPOTENCY_KEY, COMMAND_REQUEST_DOMAIN, commandRequestDigest } from "./model/idempotency.js";

// B07 source lifecycle (docs/design/B07-upload-source-lifecycle.md)
export * from "./model/source/index.js";

export * from "./ports/index.js";

// payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md)
export * from "./commerce/index.js";

// agency recurrence and commissions (package B10; docs/design/B10-commercial-domain.md)
export * from "./commercial/index.js";
// agency recurrence and commission domain (package B10; docs/design/B10-commercial-domain.md): the platform machines of §8.2 and the
// event vocabulary of §9, each seeded by its migration in the commit that declares it
export type { CommercialPlatformMachineName } from "./commercial/machines.js";
export { COMMERCIAL_PLATFORM_MACHINES } from "./commercial/machines.js";
export type { CommercialEventType } from "./commercial/events.js";
export { COMMERCIAL_EVENT_TYPES, COMMERCIAL_EVENT_PAYLOAD_ALLOWLIST, COMMERCIAL_EVENT_SUBSCRIPTIONS } from "./commercial/events.js";

// processing authority (package B08; docs/design/B08-audit-approval-jobs.md)
export * from "./model/execution/index.js";

// audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md)
export * from "./model/audit/index.js";
// target contracts (package B17: CMD018, CMD019)
export * from "./model/target-contract.js";
// capability governance (package B18: CMD058, CMD059)
export * from "./model/capability-governance.js";
// import stages and their receipts (package B17: CMD040, CMD041)
export * from "./model/import-stage.js";
