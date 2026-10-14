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
  InvitationRecord,
  MembershipRecord,
  PlanBody,
  PlanRecord,
  ProcessingAuthorityRecord,
  ProjectRecord,
  ProjectState,
  ServiceMode,
  SupportCaseRecord,
  SupportCategory,
  SupportSeverity,
  TargetContractRecord,
  ValidationReceiptRecord,
} from "../model/aggregates.js";
import type {
  AgencyId,
  ApprovalId,
  ArtifactRef,
  AssuranceProofId,
  CapabilityId,
  ClientId,
  CorrelationId,
  InvitationId,
  MembershipId,
  PlanId,
  ProcessingAuthorityId,
  ProjectId,
  RevisionId,
  SupportCaseId,
  TargetContractId,
  TargetInstanceRef,
  UserId,
  ValidationReceiptId,
} from "../model/ids.js";
import type { AssuranceProof } from "../model/identity.js";
import type { NewTargetContract, TargetArtifactRecord, TargetBody, TargetContractLifecycle } from "../model/target-contract.js";
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
   * platform has never synced the identity. Read after the identity's transition lock, held until the unit of work ends
   * (decision D-TX-2): a disable issued while the command runs waits for it, one committed first is read. The authorizer reads
   * it beside the token's facts: Identity owns the security status (07 "Aggregate ownership"), so a DISABLED row refuses
   * whatever the token says.
   */
  getOwn(userId: UserId): Promise<IdentityFacts | null>;
  /**
   * Records the caller's own identity reference on first sight and keeps the token's verification facts current (08:
   * authentication produces assurance facts). Never the security status: the stored state is the identity boundary's, and a
   * sync never re-enables a DISABLED identity (re-check finding N1). Returns the stored facts.
   */
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
   * The agency state a command relies on without changing the agency (CMD009, CMD011: DRAFT or ACTIVE), read after the
   * agency's transition lock, held until the unit of work ends (decision D-TX-2): a transition of the agency (to RESTRICTED,
   * CLOSING, ...) issued meanwhile waits until this unit of work ends, one committed first is read here, and commands arriving
   * after a queued transition wait behind it (re-check finding N3); commands that only read the state do not serialize among
   * themselves (07 "Transaction discipline": preconditions are rechecked under an explicit lock).
   */
  lockShared(agencyId: AgencyId): Promise<AgencyRecord | null>;
  /** Inserts a DRAFT agency at version 1 (the caller publishes agency.created.v1 in the same unit of work). */
  insert(agency: NewAgency): Promise<AgencyRecord>;
  /** Applies a listed transition (state and the columns it carries) at expectedVersion + 1. */
  transition(agencyId: AgencyId, expectedVersion: number, change: Partial<Pick<Agency, "state" | "termsVersion" | "privacyAgreementVersion" | "legalProfileRef" | "firstQualifyingCaptureId">>, now: UtcInstant): Promise<VersionedWrite<AgencyRecord>>;
  /** Agencies where the caller holds an ACTIVE or SUSPENDED membership (GET /agencies lists only actual memberships). */
  listOwnAgencies(userId: UserId): Promise<ReadonlyArray<Pick<AgencyRecord, "agencyId" | "displayName" | "state">>>;
  /**
   * A page of the caller's actual memberships (ACTIVE or SUSPENDED) with their agencies, in the total order (agency createdAt,
   * agencyId), under the identity's own policies (memberships_self_read, agencies_member_read) — GET /agencies (re-check finding
   * N16; 10 "GET /agencies lists only actual memberships").
   */
  pageOwnMemberships(userId: UserId, page: KeysetPage<AgencyId>): Promise<ReadonlyArray<{ readonly agency: AgencyRecord; readonly membership: MembershipRecord }>>;
}

/**
 * A keyset page (07 "Pagination uses a total ordering"): the rows strictly after `after` in (createdAt, id) order, at most
 * `limit` (the R2 policy's api.pageMaximum bounds it). Rows inserted before the position are not revisited and rows inserted
 * after it appear on a later page; a removed row never shifts the page after it (the consistency model of the reads, N16).
 */
export interface KeysetPage<Id extends string = string> {
  readonly after?: { readonly createdAt: UtcInstant; readonly id: Id };
  readonly limit: number;
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
   * The live (INVITED/ACTIVE/SUSPENDED) membership of a user in the current agency, if any, read after the transition lock of
   * (agency, person), held to the end of the unit of work (decision D-TX-2; the authorizer's read). A suspension, revocation or
   * role change of that membership issued meanwhile waits until this unit of work ends; one committed first is what this read
   * returns (a revoked row is no longer live and is not returned); a command arriving after a queued change waits behind it, so
   * overlapping commands can never starve a revocation (re-check finding N3). The authorization fact is therefore closed by a
   * lock like every other invariant of a command (07 "Agency and membership states": revocation is effective server-side
   * immediately for new commands; 07 "Transaction discipline").
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
  /**
   * A page of the current agency's team in (createdAt, membershipId) order (GET /agencies/{agencyId}/members, re-check finding
   * N16): every membership when `everyState` (a caller with MANAGE_TEAM), the ACTIVE ones otherwise.
   */
  pageTeam(agencyId: AgencyId, everyState: boolean, page: KeysetPage<MembershipId>): Promise<ReadonlyArray<MembershipRecord>>;
}

/** Outcome of issuing an invitation: issued, or refused because the membership already has an open one. */
export type InvitationIssue = { readonly kind: "ISSUED"; readonly invitation: InvitationRecord } | { readonly kind: "OPEN_INVITATION_EXISTS" };

/** Outcome of closing an invitation (consume or revoke): closed now, or already closed (its current record says how). */
export type InvitationClose = { readonly kind: "CLOSED"; readonly invitation: InvitationRecord } | { readonly kind: "ALREADY_CLOSED"; readonly invitation: InvitationRecord };

/**
 * Invitation tokens (08 "Invitation, recovery and ownership transfer"; COMMAND_CATALOGUE CMD003 "one expiring invitation with a
 * hashed single-use token and explicit agency scope", CMD004 "Atomically consume the invitation and activate the intended scoped
 * membership"). Only the SHA-256 of a token is stored or compared (hashInvitationToken). The database decides who may issue,
 * consume and revoke: an invitation names an INVITED membership with that membership's role and is issued by the acting
 * session's own membership with the authority to grant it; only the invited identity consumes it, before its deadline; team
 * authority revokes it; a closed invitation never reopens (migration 0002). The membership's INVITED -> ACTIVE edge requires a
 * consumed invitation of that role.
 */
export interface InvitationRepository {
  insert(invitation: InvitationRecord): Promise<InvitationIssue>;
  get(invitationId: InvitationId): Promise<InvitationRecord | null>;
  /** The invitation whose stored digest is `tokenHash`, visible to its agency or to the invited identity itself. */
  findByTokenHash(tokenHash: Sha256Hex): Promise<InvitationRecord | null>;
  /** The invitation issued for a membership (a membership carries at most one: reissuing creates a new membership), null when none is visible. */
  findByMembership(membershipId: MembershipId): Promise<InvitationRecord | null>;
  consume(invitationId: InvitationId, now: UtcInstant): Promise<InvitationClose>;
  revoke(invitationId: InvitationId, now: UtcInstant): Promise<InvitationClose>;
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
  /** Safe summaries, paginated by (createdAt, clientId) inside the current agency (07 "Pagination uses a total ordering"; GET /agencies/{agencyId}/clients, N16). */
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

export interface NewSupportCase {
  readonly caseId: SupportCaseId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly category: SupportCategory;
  readonly severity: SupportSeverity;
  readonly summary: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  readonly createdByUserId: UserId;
  readonly createdByMembershipId: MembershipId;
  readonly nextReviewAt: UtcInstant;
  readonly createdAt: UtcInstant;
}

/** Support cases of one agency (B11 CMD044 and its two reads); a case is born OPEN at version 1 and this edition never edits one. */
export interface SupportCaseRepository {
  get(caseId: SupportCaseId): Promise<SupportCaseRecord | null>;
  /** Inserts an OPEN case at version 1; a project of another agency fails the composite foreign key, a membership of another agency too. */
  insert(input: NewSupportCase): Promise<SupportCaseRecord>;
  /** One project's cases, paginated by (createdAt, caseId) inside the current agency (07 "Pagination uses a total ordering"). */
  listByProject(agencyId: AgencyId, projectId: ProjectId, page: KeysetPage<SupportCaseId>): Promise<ReadonlyArray<SupportCaseRecord>>;
}

/**
 * A source revision as CMD025 reads it after its transition lock: the revision and how long its data stays available — the
 * latest effective deadline of a governing retention record that is ACTIVE and still ahead on the server clock (B07 decision
 * D-RET-2, the rule of the SourceAvailabilityReader), null when the revision is not SEALED or no governing record lies ahead.
 */
export interface LockedSourceRevision extends DatasetRevisionRecord {
  readonly availableUntil: UtcInstant | null;
}

export interface DatasetRevisionRepository {
  get(revisionId: RevisionId): Promise<DatasetRevisionRecord | null>;
  /**
   * The revision of `projectId` whose manifest hash is `revisionHash` (CMD025 source binding: the plan's own project, re-check
   * finding N9), read after its transition lock, held until the unit of work ends (decision D-TX-2): a transition of that
   * revision (SEALED -> EXPIRED / SUPERSEDED) issued meanwhile waits for this unit of work, one committed first is what is
   * returned, and an approval arriving after a queued transition waits behind it. The caller checks the state is SEALED and
   * that the source is still available (`availableUntil` not null — review finding B06-R2, decision D-SRC-1: a SEALED revision
   * whose retention deadline passed is expired although the sweeper has not yet taken retention_expires): an approval can never
   * commit bound to a source that stopped being SEALED while it was in flight, nor to one whose retention has lapsed (07
   * "Transaction discipline"; CMD025 "expired source ... requires new review").
   */
  lockSealedByHash(agencyId: AgencyId, projectId: ProjectId, revisionHash: Sha256Hex): Promise<LockedSourceRevision | null>;
}

export interface TargetContractRepository {
  get(contractId: TargetContractId): Promise<TargetContractRecord | null>;
  /**
   * The contract of `projectId` with this body hash (CMD025 target binding: the plan's own project, re-check findings N4, N9),
   * read after its transition lock, held until the unit of work ends (decision D-TX-2): a confirmation or supersession issued
   * meanwhile waits, one committed first is what is returned. The caller checks it is confirmed and not superseded.
   */
  lockCurrentByHash(agencyId: AgencyId, projectId: ProjectId, targetContractHash: Sha256Hex): Promise<TargetContractRecord | null>;
  /** The project's most recently observed contract, whatever its confirmation (a project read's readiness facts, N16). */
  findLatestForProject(projectId: ProjectId): Promise<TargetContractRecord | null>;

  // --- B17: CMD018 CreateTargetContract, CMD019 ConfirmTargetContract ---------------------------------------------------------
  /** A target artifact (metadata or confirmation evidence) of the caller's agency; another agency's and a nonexistent one answer alike (null). */
  getArtifact(artifactRef: ArtifactRef): Promise<TargetArtifactRecord | null>;
  /** The contract with its lifecycle (version, state, confirmation), without a lock. */
  getLifecycle(contractId: TargetContractId): Promise<TargetContractLifecycle | null>;
  /** The contract's row locked FOR UPDATE: the one serialization point of a confirmation, held until the unit of work ends. */
  lockLifecycle(contractId: TargetContractId): Promise<TargetContractLifecycle | null>;
  /** The stored body of a contract, exactly as its digest was derived (CMD019 recomputes the digest from it). */
  getBody(contractId: TargetContractId): Promise<{ readonly body: TargetBody; readonly bodyHash: Sha256Hex } | null>;
  /**
   * Inserts the contract as a DRAFT (version 1), deriving its bodyHash with targetBodyDigest; null when the project already holds this
   * exact body (one contract per observed body; nothing is written).
   */
  createDraft(input: NewTargetContract): Promise<TargetContractLifecycle | null>;
  /** The DRAFT to CONFIRMED edge at `expectedVersion`: the instant is the database's; a version miss is STALE, nothing changes. */
  confirm(contractId: TargetContractId, expectedVersion: number, confirmation: { readonly membershipId: MembershipId; readonly evidenceRef: ArtifactRef }): Promise<VersionedWrite<TargetContractLifecycle>>;

  // --- B17 L1: CMD019's supersession of the project's current contracts (R2-026, decision D-R3-1) ------------------------------
  /**
   * The project's current contracts (confirmed, not superseded) other than `except`, locked FOR NO KEY UPDATE in ascending contract_id
   * (one statement): the contracts a confirmation of `except` supersedes.
   */
  lockCurrentOfProject(agencyId: AgencyId, projectId: ProjectId, except: TargetContractId): Promise<ReadonlyArray<TargetContractRecord>>;
  /**
   * The exclusive transition half of each listed contract, taken in ascending contract_id and held until the unit of work ends: every
   * reader of a contract's currency (its shared half: issuance, admission, publication, StartAudit, lockCurrentByHash) is ordered with it.
   */
  holdTransitions(contractIds: ReadonlyArray<TargetContractId>): Promise<void>;
  /**
   * Every plan of the project bound to one of the listed target body hashes, FOR SHARE in ascending plan_id, taken BEFORE the exclusive
   * halves: a reader that holds a plan row and then waits on a contract's shared half (CMD041, ApprovePlan) is ordered before the
   * supersession instead of deadlocking with it (the re-check plan's birth references the bound plan, a FOR KEY SHARE on its row).
   */
  lockPlansBoundTo(agencyId: AgencyId, projectId: ProjectId, targetContractHashes: ReadonlyArray<Sha256Hex>): Promise<void>;
  /** The APPROVED plans of the project bound to one of the listed target body hashes, with their bodies, ascending plan_id (a plain read). */
  approvedPlansBoundTo(agencyId: AgencyId, projectId: ProjectId, targetContractHashes: ReadonlyArray<Sha256Hex>): Promise<ReadonlyArray<BoundPlan>>;
  /** Supersedes a current contract by `by` (confirmed in this same unit of work): the instant is the database's; learned once. */
  supersede(contractId: TargetContractId, by: TargetContractId): Promise<TargetContractRecord>;
  /**
   * Inserts the re-check plan of `recheckOf` as a DRAFT: its body is the re-checked plan's body with only targetContractHash replaced
   * (the database refuses any other body and any target but the contract that superseded the re-checked plan's).
   */
  insertRecheckPlan(input: NewRecheckPlan): Promise<{ readonly planId: PlanId; readonly version: number; readonly bodyHash: Sha256Hex }>;
}

/** An APPROVED plan bound to a contract being superseded, as CMD019 reads it to birth its re-check plan. */
export interface BoundPlan {
  readonly planId: PlanId;
  readonly version: number;
  readonly targetContractHash: Sha256Hex;
  readonly body: PlanBody;
}

export interface NewRecheckPlan {
  readonly planId: PlanId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  readonly recheckOfPlanId: PlanId;
  readonly body: PlanBody;
  readonly createdByMembershipId: MembershipId;
}

// --- plans and approvals ----------------------------------------------------------------------------------------------

export interface NewPlanRevision {
  readonly planId: PlanId;
  readonly agencyId: AgencyId;
  readonly projectId: ProjectId;
  /** The closed body; the repository derives its bodyHash (KAURO_PLAN_BODY_V1 digest), never a caller (re-check finding N10). */
  readonly body: PlanBody;
  readonly supersedesPlanId?: PlanId;
  readonly createdByMembershipId: MembershipId;
  readonly createdAt: UtcInstant;
}

export interface PlanRepository {
  get(planId: PlanId): Promise<PlanRecord | null>;
  lock(planId: PlanId): Promise<PlanRecord | null>;
  getBody(planId: PlanId): Promise<PlanBody | null>;
  /**
   * Inserts a DRAFT plan revision at version 1 (state DRAFT; the caller applies compiled_or_edited next). Its bodyHash is the
   * KAURO_PLAN_BODY_V1 digest of the body, computed here (reference/HASHING_AND_ACCOUNTING_RULES: the consumer recomputes the
   * relevant preimage); its source, target and policy columns are the body's own members (the database checks that too).
   */
  insert(plan: NewPlanRevision): Promise<PlanRecord>;
  /** Applies a listed Plan transition at expectedVersion + 1, carrying the bindings the target state requires. */
  transition(
    planId: PlanId,
    expectedVersion: number,
    change: { readonly state: PlanRecord["state"]; readonly supersededByPlanId?: PlanId; readonly validationReceiptHash?: Sha256Hex | null; readonly approvalId?: ApprovalId | null },
    now: UtcInstant,
  ): Promise<VersionedWrite<PlanRecord>>;
  /** The project's current plan revision: the newest one no revision superseded (a project read's readiness facts, N16). */
  findCurrentForProject(projectId: ProjectId): Promise<PlanRecord | null>;
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
   * findMode after the mode's transition lock, held until the unit of work ends (decision D-TX-2; CMD011 relies on the
   * capability being offered when the project commits): a control-plane transition of a capability of that mode (e.g.
   * AVAILABLE_LIMITED -> SUSPENDED) issued meanwhile waits for this unit of work, one committed first is what this call
   * returns, and project creations arriving after a queued transition wait behind it (re-check finding N3).
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
