/**
 * Repository ports (07 "Aggregate ownership" / "Transaction discipline"). Every repository lives inside a unit of work and
 * therefore inside the tenant context bound to it: a read returns null for a row the row-level security policies hide, and a
 * write of a row outside the context fails at the database (WITH CHECK). Versioned writes are compare-and-swap on the
 * aggregate version: a stale expectation returns the current safe version and state instead of overwriting (10 "Concurrency
 * and preconditions"). Implementations belong to @kauro/persistence.
 */
import type { Agency, Capability, Membership, Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  AgencyRecord,
  ApprovalRecord,
  CapabilityRecord,
  DatasetRevisionRecord,
  EndClientRecord,
  MembershipRecord,
  PlanBody,
  PlanRecord,
  ProcessingAuthorityRecord,
  ProjectRecord,
  ProjectState,
  ServiceMode,
  TargetContractRecord,
  ValidationReceiptRecord,
} from "../model/aggregates.js";
import type {
  AgencyId,
  ApprovalId,
  AssuranceProofId,
  CapabilityId,
  ClientId,
  CorrelationId,
  MembershipId,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  TargetContractId,
  TargetInstanceRef,
  UserId,
  ValidationReceiptId,
} from "../model/ids.js";
import type { MembershipRole } from "../model/roles.js";
import type { ActorRef, IdentityFacts } from "../model/tenant.js";

/** Outcome of a compare-and-swap write on a versioned aggregate. */
export type VersionedWrite<T> =
  | { readonly kind: "APPLIED"; readonly record: T }
  | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string };

// --- identity ---------------------------------------------------------------------------------------------------------

export interface AssuranceProof {
  readonly proofId: AssuranceProofId;
  readonly userId: UserId;
  readonly kind: "STEP_UP";
  readonly method: "TOTP" | "WEBAUTHN" | "IDP_REAUTH";
  readonly issuedAt: UtcInstant;
  readonly expiresAt: UtcInstant;
}

export interface IdentityRepository {
  /** The caller's own identity facts (rows of other users are not visible under the self policy). */
  getOwn(userId: UserId): Promise<IdentityFacts | null>;
  /** Upserts the caller's own identity facts from the authenticator (08: authentication produces assurance facts). */
  syncOwn(facts: IdentityFacts, provider: string, subjectHash: Sha256Hex, now: UtcInstant): Promise<IdentityFacts>;
  /** A step-up proof of the caller (null when not visible or unknown). */
  getOwnProof(userId: UserId, proofId: AssuranceProofId): Promise<AssuranceProof | null>;
  recordProof(proof: AssuranceProof, correlationId: CorrelationId): Promise<void>;
}

// --- agency and membership --------------------------------------------------------------------------------------------

export interface NewAgency {
  readonly agencyId: AgencyId;
  readonly displayName: string;
  readonly createdByUserId: UserId;
  readonly createdAt: UtcInstant;
}

export interface AgencyRepository {
  get(agencyId: AgencyId): Promise<AgencyRecord | null>;
  /** SELECT ... FOR UPDATE: serializes concurrent commands on the aggregate for the rest of the unit of work. */
  lock(agencyId: AgencyId): Promise<AgencyRecord | null>;
  /** Inserts a DRAFT agency at version 1 (the caller publishes agency.created.v1 in the same unit of work). */
  insert(agency: NewAgency): Promise<AgencyRecord>;
  /** Applies a listed transition (state and the columns it carries) at expectedVersion + 1. */
  transition(agencyId: AgencyId, expectedVersion: number, change: Partial<Pick<Agency, "state" | "termsVersion" | "privacyAgreementVersion" | "legalProfileRef" | "firstQualifyingCaptureId">>, now: UtcInstant): Promise<VersionedWrite<AgencyRecord>>;
  /** Agencies where the caller holds an ACTIVE or SUSPENDED membership (GET /agencies lists only actual memberships). */
  listOwnAgencies(userId: UserId): Promise<ReadonlyArray<Pick<AgencyRecord, "agencyId" | "displayName" | "state">>>;
}

export interface NewMembership {
  readonly membershipId: MembershipId;
  readonly agencyId: AgencyId;
  readonly userId: UserId;
  readonly role: MembershipRole;
  readonly state: Membership["state"];
  readonly assurancePolicy: string;
  readonly acceptedAt?: UtcInstant;
  readonly createdAt: UtcInstant;
}

export interface MembershipRepository {
  get(membershipId: MembershipId): Promise<MembershipRecord | null>;
  lock(membershipId: MembershipId): Promise<MembershipRecord | null>;
  /** The live (INVITED/ACTIVE/SUSPENDED) membership of a user in the current agency, if any. */
  findLive(agencyId: AgencyId, userId: UserId): Promise<MembershipRecord | null>;
  /** The caller's memberships across agencies (self policy), for context listing. */
  listOwn(userId: UserId): Promise<ReadonlyArray<MembershipRecord>>;
  insert(membership: NewMembership): Promise<MembershipRecord>;
  /**
   * Applies a listed Membership transition at expectedVersion + 1. Removing the last ACTIVE OWNER of an agency that is not
   * CLOSING/CLOSED fails inside the database (trigger kauro.maintain_active_owner_count, SQLSTATE KA001) and surfaces as
   * PRECONDITION_FAILED / LAST_OWNER_PROTECTED — the invariant is serialized on the agency row, not on this read.
   */
  transition(membershipId: MembershipId, expectedVersion: number, change: Partial<Pick<Membership, "state" | "role" | "acceptedAt">> & { readonly revokedAt?: UtcInstant }, now: UtcInstant): Promise<VersionedWrite<MembershipRecord>>;
  countActiveOwners(agencyId: AgencyId): Promise<number>;
}

// --- clients and projects ---------------------------------------------------------------------------------------------

export interface ProcessingAuthorityRepository {
  get(processingAuthorityId: ProcessingAuthorityId): Promise<ProcessingAuthorityRecord | null>;
  insert(record: ProcessingAuthorityRecord): Promise<ProcessingAuthorityRecord>;
}

export interface NewEndClient {
  readonly clientId: ClientId;
  readonly agencyId: AgencyId;
  readonly displayName: string;
  readonly processingAuthorityRef: ProcessingAuthorityId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

export interface EndClientRepository {
  get(clientId: ClientId): Promise<EndClientRecord | null>;
  lock(clientId: ClientId): Promise<EndClientRecord | null>;
  /** Inserts an ACTIVE client at version 1; a processingAuthorityRef of another agency fails the composite foreign key. */
  insert(client: NewEndClient): Promise<EndClientRecord>;
  archive(clientId: ClientId, expectedVersion: number, now: UtcInstant): Promise<VersionedWrite<EndClientRecord>>;
  /** Safe summaries, paginated by (createdAt, clientId) inside the current agency (07 "Pagination uses a total ordering"). */
  list(agencyId: AgencyId, page: { readonly after?: { readonly createdAt: UtcInstant; readonly clientId: ClientId }; readonly limit: number }): Promise<ReadonlyArray<EndClientRecord>>;
  countOpenProjects(clientId: ClientId): Promise<number>;
}

export interface NewProject {
  readonly projectId: ProjectId;
  readonly agencyId: AgencyId;
  readonly clientId: ClientId;
  readonly mode: ServiceMode;
  readonly purpose: string;
  readonly targetInstanceRef?: TargetInstanceRef;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly initialRevisionId: RevisionId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

export interface ProjectRepository {
  get(projectId: ProjectId): Promise<ProjectRecord | null>;
  lock(projectId: ProjectId): Promise<ProjectRecord | null>;
  /** Inserts the project and its draft revision (both at version 1) in one statement sequence; atomic with the unit of work. */
  insertWithDraftRevision(project: NewProject): Promise<{ readonly project: ProjectRecord; readonly revision: DatasetRevisionRecord }>;
  transition(projectId: ProjectId, expectedVersion: number, change: { readonly state: ProjectState }, now: UtcInstant): Promise<VersionedWrite<ProjectRecord>>;
}

export interface DatasetRevisionRepository {
  get(revisionId: RevisionId): Promise<DatasetRevisionRecord | null>;
  /** The sealed revision whose manifest hash is `revisionHash`, if it exists in the current agency (CMD025 source binding). */
  findSealedByHash(agencyId: AgencyId, revisionHash: Sha256Hex): Promise<DatasetRevisionRecord | null>;
}

export interface TargetContractRepository {
  get(contractId: TargetContractId): Promise<TargetContractRecord | null>;
  /** The confirmed, unsuperseded contract with this body hash in the current agency (CMD025 target binding). */
  findCurrentByHash(agencyId: AgencyId, targetContractHash: Sha256Hex): Promise<TargetContractRecord | null>;
}

// --- plans and approvals ----------------------------------------------------------------------------------------------

export interface NewPlanRevision {
  readonly planId: PlanId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly body: PlanBody;
  readonly bodyHash: Sha256Hex;
  readonly supersedesPlanId?: PlanId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

export interface PlanRepository {
  get(planId: PlanId): Promise<PlanRecord | null>;
  lock(planId: PlanId): Promise<PlanRecord | null>;
  getBody(planId: PlanId): Promise<PlanBody | null>;
  /** Inserts a DRAFT plan revision at version 1 (state DRAFT; the caller applies compiled_or_edited next). */
  insert(plan: NewPlanRevision): Promise<PlanRecord>;
  /** Applies a listed Plan transition at expectedVersion + 1, carrying the bindings the target state requires. */
  transition(
    planId: PlanId,
    expectedVersion: number,
    change: { readonly state: PlanRecord["state"]; readonly supersededByPlanId?: PlanId; readonly validationReceiptHash?: Sha256Hex | null; readonly approvalId?: ApprovalId | null },
    now: UtcInstant,
  ): Promise<VersionedWrite<PlanRecord>>;
}

export interface ValidationReceiptRepository {
  get(receiptId: ValidationReceiptId): Promise<ValidationReceiptRecord | null>;
  findByHash(agencyId: AgencyId, receiptHash: Sha256Hex): Promise<ValidationReceiptRecord | null>;
}

export interface NewApproval {
  readonly approvalId: ApprovalId;
  readonly agencyId: AgencyId;
  readonly planId: PlanId;
  readonly actorId: UserId;
  readonly actorMembershipId: MembershipId;
  readonly actorMembershipVersion: number;
  readonly assuranceProofRef: AssuranceProofId;
  readonly planHash: Sha256Hex;
  readonly revisionHash: Sha256Hex;
  readonly targetContractHash: Sha256Hex;
  readonly validationReceiptHash: Sha256Hex;
  readonly disclosuresHash: Sha256Hex;
  readonly approvalHash: Sha256Hex;
  readonly createdAt: UtcInstant;
}

export interface ApprovalRepository {
  get(approvalId: ApprovalId): Promise<ApprovalRecord | null>;
  /** The live (not withdrawn) approval of a plan, if any; the partial unique index guarantees at most one. */
  findLiveByPlan(planId: PlanId): Promise<ApprovalRecord | null>;
  /** Inserts the immutable approval at version 1; a second live approval of the same plan fails the unique index. */
  insert(approval: NewApproval): Promise<ApprovalRecord>;
  /** The only permitted mutation: records withdrawal once (immutability trigger refuses anything else). */
  withdraw(approvalId: ApprovalId, expectedVersion: number, by: { readonly membershipId: MembershipId; readonly reasonCode: string }, now: UtcInstant): Promise<VersionedWrite<ApprovalRecord>>;
}

// --- capabilities and security events ---------------------------------------------------------------------------------

export interface CapabilityRepository {
  get(capabilityId: CapabilityId): Promise<CapabilityRecord | null>;
  /** The mode capability for a service mode (CMD011: the requested mode must be offered), null when none is published. */
  findMode(mode: ServiceMode): Promise<CapabilityRecord | null>;
  list(filter?: { readonly state?: Capability["state"] }): Promise<ReadonlyArray<CapabilityRecord>>;
}

/** 08 "Audit events and retention": actor, scope, action, outcome, policy version, assurance class, correlation and time. */
export interface SecurityEvent {
  readonly agencyId: AgencyId | null;
  readonly actor: ActorRef;
  readonly action: string;
  readonly outcome: "ALLOW" | "DENY";
  readonly reasonCode: string | null;
  readonly policyVersion: string;
  readonly assuranceClass: "NONE" | "SESSION" | "STEP_UP";
  readonly correlationId: CorrelationId;
  readonly occurredAt: UtcInstant;
}

export interface SecurityEventRepository {
  append(event: SecurityEvent): Promise<void>;
}
