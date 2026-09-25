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
import type { AssuranceProof } from "../model/identity.js";
import type { MembershipRole } from "../model/roles.js";
import type { IdentityFacts, SecurityActor } from "../model/tenant.js";

/** Outcome of a compare-and-swap write on a versioned aggregate. */
export type VersionedWrite<T> =
  | { readonly kind: "APPLIED"; readonly record: T }
  | { readonly kind: "STALE"; readonly currentVersion: number; readonly currentState: string };

// --- identity ---------------------------------------------------------------------------------------------------------

export type { AssuranceProof };

export interface IdentityRepository {
  /**
   * The caller's own stored identity facts (rows of other users are not visible under the self policy); null when the
   * platform has never synced the identity. The authorizer reads it beside the token's facts: Identity owns the security
   * status (07 "Aggregate ownership"), so a DISABLED row refuses whatever the token says.
   */
  getOwn(userId: UserId): Promise<IdentityFacts | null>;
  /** Upserts the caller's own identity facts from the authenticator (08: authentication produces assurance facts). */
  syncOwn(facts: IdentityFacts, provider: string, subjectHash: Sha256Hex, now: UtcInstant): Promise<IdentityFacts>;
  /**
   * A step-up proof of the caller (null when not visible or unknown). Reading only: a proof is recorded by the step-up verifier
   * (08 "Authentication and assurance"), never by a unit of work of the request handlers whose step-up gate it satisfies.
   */
  getOwnProof(userId: UserId, proofId: AssuranceProofId): Promise<AssuranceProof | null>;
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
  /**
   * SELECT ... FOR SHARE: the agency state a command relies on without changing the agency (CMD011: DRAFT or ACTIVE). A
   * concurrent transition of the agency (to RESTRICTED, CLOSING, ...) waits until this unit of work ends, or — when it
   * committed first — is read here; commands that only read the state do not serialize among themselves (07 "Transaction
   * discipline": preconditions are rechecked under an explicit lock).
   */
  lockShared(agencyId: AgencyId): Promise<AgencyRecord | null>;
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
  /**
   * The live (INVITED/ACTIVE/SUSPENDED) membership of a user in the current agency, if any, read with a share lock held to the
   * end of the unit of work (SELECT ... FOR SHARE; the authorizer's read). A concurrent suspension, revocation or role change
   * of that row waits until this unit of work ends; one committed first is what this read returns (a revoked row is no longer
   * live and is not returned). The authorization fact is therefore closed by a lock like every other invariant of a command
   * (07 "Agency and membership states": revocation is effective server-side immediately for new commands; 07 "Transaction
   * discipline"). Only a TENANT context of that agency can take the lock.
   */
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
  /**
   * Records the agency's processing authority under the evidence reference it names (CMD009), unless the reference is
   * already recorded: returns the current agency's record — RECORDED now, or EXISTING from an earlier client of the same
   * agency — or null when another agency recorded the reference (its row is invisible under RLS and the primary key refuses a
   * second one: "a foreign authority reference rejects"). Concurrent recordings of one reference serialize on the key.
   */
  record(record: ProcessingAuthorityRecord): Promise<{ readonly kind: "RECORDED" | "EXISTING"; readonly record: ProcessingAuthorityRecord } | null>;
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
  /**
   * The sealed revision whose manifest hash is `revisionHash` in the current agency, read under a share lock held until the
   * unit of work ends (CMD025 source binding). A concurrent transition of that revision (SEALED -> EXPIRED / SUPERSEDED)
   * either waits for this unit of work, or committed first and the revision is no longer returned: an approval can never
   * commit bound to a source that stopped being SEALED while it was in flight (07 "Transaction discipline").
   */
  lockSealedByHash(agencyId: AgencyId, revisionHash: Sha256Hex): Promise<DatasetRevisionRecord | null>;
}

export interface TargetContractRepository {
  get(contractId: TargetContractId): Promise<TargetContractRecord | null>;
  /**
   * The confirmed, unsuperseded contract with this body hash in the current agency, read under a share lock held until the
   * unit of work ends (CMD025 target binding): a concurrent supersession of that contract waits, or committed first and the
   * contract is no longer returned.
   */
  lockCurrentByHash(agencyId: AgencyId, targetContractHash: Sha256Hex): Promise<TargetContractRecord | null>;
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
  /**
   * findMode under a share lock on the returned row, held until the unit of work ends (CMD011 relies on the capability being
   * offered when the project commits): a concurrent control-plane transition of that capability (e.g. AVAILABLE_LIMITED ->
   * SUSPENDED) waits for this unit of work, or committed first and its new state is what this call returns.
   */
  lockMode(mode: ServiceMode): Promise<CapabilityRecord | null>;
  list(filter?: { readonly state?: Capability["state"] }): Promise<ReadonlyArray<CapabilityRecord>>;
}

/**
 * 08 "Audit events and retention": actor, scope, action, outcome, policy version, assurance class, correlation and time. The
 * scope is one of: an agency's stream (`agencyId`; only a caller holding a live membership there may write it), the actor's
 * own identity stream (`agencyId` null, naming the agency the request selected in `requestedAgencyId`, if any), or no
 * stream at all for the anonymous denial of a request without an authenticated subject (migration 0007).
 */
export interface SecurityEvent {
  readonly agencyId: AgencyId | null;
  /** The agency selector of a request whose fact belongs to no agency stream; a name, never a reference. Null when `agencyId` is set. */
  readonly requestedAgencyId: AgencyId | null;
  readonly actor: SecurityActor;
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
