/**
 * Membership aggregate (07 "Aggregate ownership": Membership owns role, capabilities, invitation and revocation;
 * 07 "Agency and membership states": invitation acceptance binds the invited identity and intended agency, an expired invite
 * cannot be revived by changing a browser timestamp, revocation is effective server-side immediately, the last active owner
 * cannot remove their own ownership without a valid successor or an explicit closure procedure, concurrent owner removals
 * are serialized; 08 "Invitation, recovery and ownership transfer"; registry machine Membership).
 *
 * Every operation is pure and follows the same order: expected version (10), listed edge (registry; an unlisted edge is
 * PRECONDITION_FAILED / UNLISTED_TRANSITION), actor authority over the target, the guard the edge names, then the record at
 * version + 1 with its event. The last-owner rule is evaluated here on the facts the handler read under the agency row lock
 * and enforced again by the database trigger maintain_active_owner_count (KA001), which is what serializes two removers
 * (R2-043, decision D-OWN-1): the pure rule gives the message, the trigger gives the guarantee.
 *
 * Decisions recorded here (authority cited; see packages/domain/README.md):
 * - D-MEM-1 grantable subset (CMD003 precondition): an OWNER may invite any role; an ADMIN may invite any role except OWNER
 *   (08 "Granting a capability is itself an owner action").
 * - D-MEM-2 an ADMIN has no authority over an OWNER membership (suspend, revoke, revoke invitation): 08 default deny and
 *   least privilege; otherwise team management by an ADMIN would be an escalation path over the owner.
 * - D-MEM-3 acceptance by an identity other than the intended one is NOT_FOUND without a reason (08: a forwarded token cannot
 *   grant membership to a different person; foreign and nonexistent resources look alike); a wrong token presented by the
 *   intended identity is NOT_AUTHORIZED / INVITATION_TOKEN_MISMATCH.
 * - D-MEM-4 ownership transfer (CMD007) is one outcome with three versioned records: the successor becomes OWNER, the
 *   current owner becomes ADMIN, the agency records the transfer; the count of active owners never passes through zero.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Membership, Sha256Hex, UtcInstant } from "@kauro/contracts";
import { isSha256Hex } from "@kauro/contracts";
import type { AgencyRecord, InvitationRecord, MembershipRecord } from "./aggregates.js";
import { isAgencyOpen, isUnderClosureAuthority } from "./agency.js";
import { DomainFailure, InvalidRequestFailure, NotAuthorizedFailure, NotFoundFailure, PreconditionFailure } from "./errors.js";
import { type AggregateEvent, aggregateEvent } from "./events.js";
import { assertLabel, assertReasonCode, instantMs } from "./fields.js";
import { assertVerifiedIdentity } from "./identity.js";
import type { AgencyId, InvitationId, MembershipId, UserId } from "./ids.js";
import { MEMBERSHIP_ROLES, type MembershipRole } from "./roles.js";
import { transition } from "./state-machines.js";
import type { IdentityFacts } from "./tenant.js";
import { assertExpectedVersion, nextVersion } from "./versioning.js";
import type { RandomBytes } from "../ports/id-generator.js";

export type MembershipState = Membership["state"];

/** States in which a membership row is the person's membership in the agency (one per person per agency, migration 0002). */
export const LIVE_MEMBERSHIP_STATES: ReadonlySet<MembershipState> = new Set<MembershipState>(["INVITED", "ACTIVE", "SUSPENDED"]);

/** Roles that manage the team (capability MANAGE_TEAM; command role AGENCY_OWNER_OR_ADMIN of CMD003/CMD006). */
export const TEAM_MANAGER_ROLES: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["OWNER", "ADMIN"]);

export function isLiveMembership(m: Pick<MembershipRecord, "state">): boolean {
  return LIVE_MEMBERSHIP_STATES.has(m.state);
}

export function isActiveOwner(m: Pick<MembershipRecord, "role" | "state">): boolean {
  return m.role === "OWNER" && m.state === "ACTIVE";
}

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as ReadonlyArray<string>).includes(value);
}

export function assertMembershipRole(field: string, value: unknown): MembershipRole {
  if (typeof value !== "string") throw new InvalidRequestFailure([{ field, code: "TYPE" }]);
  if (!isMembershipRole(value)) throw new InvalidRequestFailure([{ field, code: "ENUM" }]);
  return value;
}

export interface MembershipOutcome {
  readonly membership: MembershipRecord;
  readonly event: AggregateEvent;
}

// --- invitation tokens ---------------------------------------------------------------------------------------------------

/** Mints a one-use opaque token (32 random bytes, base64url). The adapter hands the raw token to the invitee once. */
export function mintInvitationToken(random: RandomBytes): string {
  const bytes = random(32);
  if (bytes.length !== 32) throw new RangeError("invitation token needs 32 random bytes");
  return Buffer.from(bytes).toString("base64url");
}

/** The only form of the token the platform stores or compares (08: stored token material is hashed). */
export function hashInvitationToken(rawToken: string): Sha256Hex {
  if (rawToken.length < 16 || rawToken.length > 512) throw new TypeError("invitation token has an unexpected length");
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Constant-time comparison of two token digests. */
export function tokenHashesEqual(a: Sha256Hex, b: Sha256Hex): boolean {
  if (!isSha256Hex(a) || !isSha256Hex(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// --- ownership invariant (07 "Agency and membership states"; R2-043) ----------------------------------------------------------

export interface OwnershipFacts {
  readonly agency: Pick<AgencyRecord, "agencyId" | "state">;
  /** Active owners of the agency as read under the agency row lock (agencies.active_owner_count). */
  readonly activeOwnerCount: number;
}

/**
 * True when applying `next` to `current` would leave the agency with no ACTIVE OWNER while the closure procedure is not the
 * authority. The database trigger recomputes the same predicate after serializing on the agency row (KA001).
 */
export function wouldLeaveNoActiveOwner(current: Pick<MembershipRecord, "role" | "state">, next: Pick<MembershipRecord, "role" | "state">, facts: OwnershipFacts): boolean {
  if (!Number.isSafeInteger(facts.activeOwnerCount) || facts.activeOwnerCount < 0) throw new RangeError("activeOwnerCount must be a non-negative integer");
  if (!isActiveOwner(current) || isActiveOwner(next)) return false;
  if (isUnderClosureAuthority(facts.agency)) return false;
  return facts.activeOwnerCount - 1 < 1;
}

export function assertOwnershipPreserved(current: MembershipRecord, next: Pick<MembershipRecord, "role" | "state">, facts: OwnershipFacts): void {
  if (wouldLeaveNoActiveOwner(current, next, facts)) {
    throw new PreconditionFailure("LAST_OWNER_PROTECTED", `membership ${current.membershipId} is the last active owner of agency ${facts.agency.agencyId}`, {
      currentState: current.state,
      currentVersion: current.version,
    });
  }
}

// --- actor authority over a target membership (08 "Role and capability model") --------------------------------------------------

export interface TeamAction {
  readonly actor: MembershipRecord;
  readonly target: MembershipRecord;
  readonly agency: Pick<AgencyRecord, "agencyId" | "state">;
}

/**
 * Team management: the actor must be an ACTIVE OWNER or ADMIN of the same agency as the target; an ADMIN never acts on an
 * OWNER (D-MEM-2). A target of another agency is not visible under the tenant context, so it is NOT_FOUND, not a role error.
 */
export function assertTeamAuthority(action: TeamAction): void {
  const { actor, target, agency } = action;
  if (target.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "CROSS_AGENCY");
  if (actor.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "NOT_A_MEMBER");
  assertActiveActor(actor);
  if (!TEAM_MANAGER_ROLES.has(actor.role)) throw new NotAuthorizedFailure("ROLE_INSUFFICIENT", `membership ${actor.membershipId} (${actor.role}) cannot manage the team`);
  if (actor.role === "ADMIN" && target.role === "OWNER") throw new NotAuthorizedFailure("OWNER_PROTECTED", `membership ${actor.membershipId} (ADMIN) cannot act on an OWNER`);
}

function assertActiveActor(actor: MembershipRecord): void {
  if (actor.state === "SUSPENDED") throw new NotAuthorizedFailure("MEMBERSHIP_SUSPENDED", `membership ${actor.membershipId} is suspended`);
  if (actor.state !== "ACTIVE") throw new NotAuthorizedFailure("MEMBERSHIP_NOT_ACTIVE", `membership ${actor.membershipId} is ${actor.state}`);
}

/** The roles an inviter may grant (D-MEM-1). */
export function grantableRoles(inviterRole: MembershipRole): ReadonlySet<MembershipRole> {
  if (inviterRole === "OWNER") return new Set(MEMBERSHIP_ROLES);
  if (inviterRole === "ADMIN") return new Set(MEMBERSHIP_ROLES.filter((r) => r !== "OWNER"));
  return new Set();
}

// --- creation (CMD001) -------------------------------------------------------------------------------------------------------

export interface CreateOwnerMembershipInput {
  readonly membershipId: MembershipId;
  readonly agencyId: AgencyId;
  readonly userId: UserId;
  /** Required authentication strength of the membership (contract Membership.assurancePolicy; the launch policy value). */
  readonly assurancePolicy: string;
  readonly now: UtcInstant;
}

/** The founding owner: ACTIVE at version 1 with an implicit acceptance (the creator is the intended identity). */
export function createOwnerMembership(input: CreateOwnerMembershipInput): MembershipOutcome {
  const assurancePolicy = assertLabel("assurancePolicy", input.assurancePolicy);
  const membership: MembershipRecord = Object.freeze({
    membershipId: input.membershipId,
    agencyId: input.agencyId,
    userId: input.userId,
    role: "OWNER",
    state: "ACTIVE",
    version: 1,
    assurancePolicy,
    acceptedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return {
    membership,
    event: membershipEvent(membership, "membership.created.v1", { userId: membership.userId, role: membership.role, state: membership.state }),
  };
}

// --- invitation (CMD003, CMD004, expiry, inviter_revokes) ------------------------------------------------------------------------

export interface InviteMemberInput {
  readonly membershipId: MembershipId;
  readonly invitationId: InvitationId;
  readonly intendedUserId: UserId;
  readonly role: string;
  readonly assurancePolicy: string;
  /** SHA-256 of the raw token the adapter minted (hashInvitationToken); the raw token is never given to the domain. */
  readonly tokenHash: Sha256Hex;
  readonly expiresAt: UtcInstant;
  readonly now: UtcInstant;
}

export interface InviteContext {
  readonly agency: AgencyRecord;
  readonly inviter: MembershipRecord;
  /** The intended identity's live membership in this agency, if any (memberships.findLive). */
  readonly existingLiveMembership: MembershipRecord | null;
}

export interface InvitationOutcome extends MembershipOutcome {
  readonly invitation: InvitationRecord;
}

/**
 * CMD003 effect: one expiring invitation with a hashed single-use token and explicit agency scope. The membership starts
 * INVITED (registry initial state) at version 1; the intended identity is fixed now and acceptance binds to it.
 */
export function inviteMember(input: InviteMemberInput, ctx: InviteContext): InvitationOutcome {
  const { agency, inviter } = ctx;
  if (inviter.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "NOT_A_MEMBER");
  assertActiveActor(inviter);
  if (!TEAM_MANAGER_ROLES.has(inviter.role)) throw new NotAuthorizedFailure("ROLE_INSUFFICIENT", `membership ${inviter.membershipId} (${inviter.role}) cannot invite`);
  const role = assertMembershipRole("role", input.role);
  if (!grantableRoles(inviter.role).has(role)) throw new NotAuthorizedFailure("ROLE_NOT_GRANTABLE", `membership ${inviter.membershipId} (${inviter.role}) cannot grant ${role}`);
  if (!isAgencyOpen(agency)) throw new PreconditionFailure("AGENCY_NOT_OPEN", `agency ${agency.agencyId} is ${agency.state}: no new access grants`, { currentState: agency.state });
  if (input.intendedUserId === inviter.userId) throw new PreconditionFailure("SELF_TARGET", `membership ${inviter.membershipId} cannot invite its own identity`);
  if (ctx.existingLiveMembership !== null) {
    if (ctx.existingLiveMembership.agencyId !== agency.agencyId || ctx.existingLiveMembership.userId !== input.intendedUserId) throw new DomainFailure("INTEGRITY_FAILURE", "existing membership does not belong to the intended identity in this agency");
    throw new PreconditionFailure("MEMBER_ALREADY_LIVE", `identity already holds membership ${ctx.existingLiveMembership.membershipId} in agency ${agency.agencyId}`, {
      currentState: ctx.existingLiveMembership.state,
    });
  }
  const assurancePolicy = assertLabel("assurancePolicy", input.assurancePolicy);
  if (!isSha256Hex(input.tokenHash)) throw new DomainFailure("INTEGRITY_FAILURE", "invitation token hash is not a SHA-256 digest");
  if (instantMs(input.expiresAt) <= instantMs(input.now)) throw new InvalidRequestFailure([{ field: "expiresAt", code: "RANGE" }]);

  const membership: MembershipRecord = Object.freeze({
    membershipId: input.membershipId,
    agencyId: agency.agencyId,
    userId: input.intendedUserId,
    role,
    state: "INVITED",
    version: 1,
    assurancePolicy,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const invitation: InvitationRecord = Object.freeze({
    invitationId: input.invitationId,
    agencyId: agency.agencyId,
    membershipId: membership.membershipId,
    tokenHash: input.tokenHash,
    role,
    invitedByMembershipId: inviter.membershipId,
    expiresAt: input.expiresAt,
    createdAt: input.now,
  });
  return {
    membership,
    invitation,
    event: membershipEvent(membership, "membership.invited.v1", { role, invitedByMembershipId: inviter.membershipId }),
  };
}

export interface AcceptInvitationInput {
  readonly membership: MembershipRecord;
  readonly invitation: InvitationRecord;
  /** The authenticated identity presenting the token (VERIFIED_USER; CMD004). */
  readonly acceptor: IdentityFacts;
  /** SHA-256 of the token the caller presented (the raw token is hashed at the edge and never logged). */
  readonly presentedTokenHash: Sha256Hex;
  readonly now: UtcInstant;
}

/**
 * Edge INVITED -> ACTIVE (intended_identity_accepts). Guard: "Single-use invitation is unexpired, unrevoked and matches
 * authenticated identity." Effect: "Consume token atomically and enable only the invited role."
 */
export function acceptInvitation(input: AcceptInvitationInput): InvitationOutcome {
  const { membership, invitation, acceptor } = input;
  assertInvitationOf(membership, invitation);
  // D-MEM-3: another person learns nothing about this invitation, not even its state.
  if (acceptor.userId !== membership.userId) throw new NotFoundFailure("invitation");
  const to = transition("Membership", membership.state, "intended_identity_accepts") as MembershipState;
  if (invitation.revokedAt !== undefined) throw new PreconditionFailure("INVITATION_REVOKED", `invitation ${invitation.invitationId} was revoked`, { currentState: membership.state });
  if (invitation.consumedAt !== undefined) throw new PreconditionFailure("INVITATION_CONSUMED", `invitation ${invitation.invitationId} was already consumed`, { currentState: membership.state });
  if (instantMs(input.now) >= instantMs(invitation.expiresAt)) throw new PreconditionFailure("INVITATION_EXPIRED", `invitation ${invitation.invitationId} expired`, { currentState: membership.state });
  if (!tokenHashesEqual(invitation.tokenHash, input.presentedTokenHash)) throw new NotAuthorizedFailure("INVITATION_TOKEN_MISMATCH", `invitation ${invitation.invitationId}: presented token does not match`);
  assertVerifiedIdentity(acceptor);
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), acceptedAt: input.now, updatedAt: input.now });
  return {
    membership: next,
    invitation: Object.freeze({ ...invitation, consumedAt: input.now }),
    event: membershipEvent(next, "membership.accepted.v1", { userId: next.userId, role: next.role }),
  };
}

/**
 * Edge INVITED -> EXPIRED (invitation_deadline). Guard: "Server time reaches the invitation endpoint" — the platform clock,
 * never a client timestamp (07). Effect: "Refuse acceptance; a new invitation has a new identity/token."
 */
export function expireInvitation(input: { readonly membership: MembershipRecord; readonly invitation: InvitationRecord; readonly now: UtcInstant }): MembershipOutcome {
  const { membership, invitation } = input;
  assertInvitationOf(membership, invitation);
  const to = transition("Membership", membership.state, "invitation_deadline") as MembershipState;
  if (instantMs(input.now) < instantMs(invitation.expiresAt)) throw new PreconditionFailure("INVITATION_NOT_EXPIRED", `invitation ${invitation.invitationId} has not reached its deadline`, { currentState: membership.state });
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), updatedAt: input.now });
  return { membership: next, event: membershipEvent(next, "membership.expired.v1", {}) };
}

export interface RevokeInvitationInput {
  readonly membership: MembershipRecord;
  readonly invitation: InvitationRecord;
  readonly expectedVersion: number;
  readonly actor: MembershipRecord;
  readonly agency: AgencyRecord;
  readonly reasonCode: string;
  readonly now: UtcInstant;
}

/** Edge INVITED -> REVOKED (inviter_revokes). Guard: "Authorized scoped inviter/owner." Effect: token acceptance is invalidated. */
export function revokeInvitation(input: RevokeInvitationInput): InvitationOutcome {
  const { membership, invitation } = input;
  assertInvitationOf(membership, invitation);
  assertExpectedVersion(membership, input.expectedVersion);
  const to = transition("Membership", membership.state, "inviter_revokes") as MembershipState;
  assertTeamAuthority({ actor: input.actor, target: membership, agency: input.agency });
  const reasonCode = assertReasonCode("reasonCode", input.reasonCode);
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), revokedAt: input.now, updatedAt: input.now });
  return {
    membership: next,
    invitation: Object.freeze({ ...invitation, revokedAt: input.now }),
    event: membershipEvent(next, "membership.revoked.v1", { byMembershipId: input.actor.membershipId, reasonCode }),
  };
}

// --- suspension, reactivation, revocation ---------------------------------------------------------------------------------------

export interface MembershipChangeInput {
  readonly membership: MembershipRecord;
  readonly expectedVersion: number;
  readonly actor: MembershipRecord;
  readonly agency: AgencyRecord;
  readonly activeOwnerCount: number;
  readonly now: UtcInstant;
}

/** Edge ACTIVE -> SUSPENDED (authorized_suspension). Guard: "Actor has authority and final-owner invariant remains safe." */
export function suspendMembership(input: MembershipChangeInput): MembershipOutcome {
  const { membership } = input;
  assertExpectedVersion(membership, input.expectedVersion);
  const to = transition("Membership", membership.state, "authorized_suspension") as MembershipState;
  assertTeamAuthority({ actor: input.actor, target: membership, agency: input.agency });
  assertOwnershipPreserved(membership, { role: membership.role, state: to }, { agency: input.agency, activeOwnerCount: input.activeOwnerCount });
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), updatedAt: input.now });
  return { membership: next, event: membershipEvent(next, "membership.suspended.v1", { byMembershipId: input.actor.membershipId }) };
}

export interface ReactivateMembershipInput {
  readonly membership: MembershipRecord;
  readonly expectedVersion: number;
  readonly actor: MembershipRecord;
  readonly agency: AgencyRecord;
  /** The member's current identity facts: reactivation rechecks identity, never a cached grant (edge effect). */
  readonly memberIdentity: IdentityFacts;
  readonly now: UtcInstant;
}

/**
 * Edge SUSPENDED -> ACTIVE (authorized_reactivation). Guard: "Current role, identity, assurance and agency readiness are
 * rechecked." Effect: "do not reuse stale cached grants" — the identity must be verified now and the agency must be open.
 */
export function reactivateMembership(input: ReactivateMembershipInput): MembershipOutcome {
  const { membership, memberIdentity } = input;
  assertExpectedVersion(membership, input.expectedVersion);
  const to = transition("Membership", membership.state, "authorized_reactivation") as MembershipState;
  assertTeamAuthority({ actor: input.actor, target: membership, agency: input.agency });
  if (memberIdentity.userId !== membership.userId) throw new DomainFailure("INTEGRITY_FAILURE", "identity facts do not belong to the member");
  if (memberIdentity.state === "DISABLED") throw new PreconditionFailure("IDENTITY_DISABLED", `member identity ${memberIdentity.userId} is disabled`, { currentState: membership.state });
  if (memberIdentity.emailVerifiedAt === null || memberIdentity.mfaEnrolledAt === null) throw new PreconditionFailure("IDENTITY_UNVERIFIED", `member identity ${memberIdentity.userId} is not verified`, { currentState: membership.state });
  if (!isAgencyOpen(input.agency)) throw new PreconditionFailure("AGENCY_NOT_OPEN", `agency ${input.agency.agencyId} is ${input.agency.state}: no new access grants`, { currentState: input.agency.state });
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), updatedAt: input.now });
  return { membership: next, event: membershipEvent(next, "membership.reactivated.v1", { byMembershipId: input.actor.membershipId }) };
}

/**
 * Edges ACTIVE/SUSPENDED -> REVOKED (authorized_revocation; CMD006). Guard: "Scoped authority and last-owner protection hold
 * transactionally." Effect: "Revoke future access" — the record keeps its history and gains revokedAt.
 */
export function revokeMembership(input: MembershipChangeInput & { readonly reasonCode: string }): MembershipOutcome {
  const { membership } = input;
  assertExpectedVersion(membership, input.expectedVersion);
  const to = transition("Membership", membership.state, "authorized_revocation") as MembershipState;
  assertTeamAuthority({ actor: input.actor, target: membership, agency: input.agency });
  const reasonCode = assertReasonCode("reasonCode", input.reasonCode);
  assertOwnershipPreserved(membership, { role: membership.role, state: to }, { agency: input.agency, activeOwnerCount: input.activeOwnerCount });
  const next: MembershipRecord = Object.freeze({ ...membership, state: to, version: nextVersion(membership), revokedAt: input.now, updatedAt: input.now });
  return { membership: next, event: membershipEvent(next, "membership.revoked.v1", { byMembershipId: input.actor.membershipId, reasonCode }) };
}

// --- role change (CMD005) ----------------------------------------------------------------------------------------------------------

export interface ChangeRoleInput extends MembershipChangeInput {
  readonly role: string;
}

/**
 * CMD005 effect: change the role with an audit event. Precondition: "the operation cannot remove the final active owner or
 * grant an unauthorized capability"; failure: "a client-invented privileged role makes no change". Only an OWNER changes
 * roles (command role AGENCY_OWNER). A role change is not a state transition: the state is unchanged, the version moves.
 */
export function changeMembershipRole(input: ChangeRoleInput): MembershipOutcome {
  const { membership, actor, agency } = input;
  assertExpectedVersion(membership, input.expectedVersion);
  if (membership.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "CROSS_AGENCY");
  if (actor.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "NOT_A_MEMBER");
  assertActiveActor(actor);
  if (actor.role !== "OWNER") throw new NotAuthorizedFailure("ROLE_INSUFFICIENT", `membership ${actor.membershipId} (${actor.role}) cannot change roles`);
  const role = assertMembershipRole("role", input.role);
  if (membership.state === "INVITED") throw new PreconditionFailure("MEMBERSHIP_NOT_ACTIVE", `membership ${membership.membershipId} is INVITED: reissue the invitation instead`, { currentState: membership.state });
  if (!LIVE_MEMBERSHIP_STATES.has(membership.state)) throw new PreconditionFailure("MEMBERSHIP_NOT_ACTIVE", `membership ${membership.membershipId} is ${membership.state}`, { currentState: membership.state });
  if (role === membership.role) throw new PreconditionFailure("NO_SEMANTIC_CHANGE", `membership ${membership.membershipId} already has role ${role}`, { currentState: membership.state, currentVersion: membership.version });
  assertOwnershipPreserved(membership, { role, state: membership.state }, { agency, activeOwnerCount: input.activeOwnerCount });
  const next: MembershipRecord = Object.freeze({ ...membership, role, version: nextVersion(membership), updatedAt: input.now });
  return { membership: next, event: membershipEvent(next, "membership.role_changed.v1", { role, previousRole: membership.role, byMembershipId: actor.membershipId }) };
}

// --- ownership transfer (CMD007) -------------------------------------------------------------------------------------------------

export interface TransferOwnershipInput {
  readonly agency: AgencyRecord;
  readonly expectedAgencyVersion: number;
  readonly currentOwner: MembershipRecord;
  readonly successor: MembershipRecord;
  readonly successorIdentity: IdentityFacts;
  /** The recorded acceptance of the successor (CMD007 precondition: required recipient acceptance is recorded). */
  readonly successorAcceptance: { readonly acceptedAt: UtcInstant } | null;
  readonly now: UtcInstant;
}

export interface OwnershipTransferOutcome {
  readonly agency: AgencyRecord;
  readonly previousOwner: MembershipRecord;
  readonly newOwner: MembershipRecord;
  readonly events: ReadonlyArray<AggregateEvent>;
}

/**
 * 08: "Agency ownership transfer requires an active verified successor, acceptance, recent step-up by the current owner and
 * an audit record. The current owner remains until the transfer commits. Concurrent transfers cannot leave zero owners or
 * create an unintended owner." The step-up is the authorizer's; everything else is decided here (D-MEM-4).
 */
export function transferOwnership(input: TransferOwnershipInput): OwnershipTransferOutcome {
  const { agency, currentOwner, successor, successorIdentity } = input;
  assertExpectedVersion(agency, input.expectedAgencyVersion);
  if (currentOwner.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "NOT_A_MEMBER");
  assertActiveActor(currentOwner);
  if (currentOwner.role !== "OWNER") throw new NotAuthorizedFailure("ROLE_INSUFFICIENT", `membership ${currentOwner.membershipId} (${currentOwner.role}) is not an owner`);
  if (isUnderClosureAuthority(agency)) throw new PreconditionFailure("AGENCY_NOT_OPEN", `agency ${agency.agencyId} is ${agency.state}`, { currentState: agency.state });
  if (successor.agencyId !== agency.agencyId) throw new NotFoundFailure("membership", "CROSS_AGENCY");
  if (successor.membershipId === currentOwner.membershipId) throw new PreconditionFailure("SELF_TARGET", `membership ${currentOwner.membershipId} cannot transfer ownership to itself`);
  if (successor.state !== "ACTIVE") throw new PreconditionFailure("RECIPIENT_NOT_ACTIVE", `membership ${successor.membershipId} is ${successor.state}`, { currentState: successor.state });
  if (successorIdentity.userId !== successor.userId) throw new DomainFailure("INTEGRITY_FAILURE", "identity facts do not belong to the successor");
  if (successorIdentity.state === "DISABLED" || successorIdentity.emailVerifiedAt === null || successorIdentity.mfaEnrolledAt === null) {
    throw new PreconditionFailure("RECIPIENT_UNVERIFIED", `member identity ${successorIdentity.userId} is not verified`);
  }
  if (input.successorAcceptance === null) throw new PreconditionFailure("RECIPIENT_ACCEPTANCE_MISSING", `membership ${successor.membershipId} has not accepted the transfer`);
  if (successor.role === "OWNER") throw new PreconditionFailure("NO_SEMANTIC_CHANGE", `membership ${successor.membershipId} already owns agency ${agency.agencyId}`);

  const newOwner: MembershipRecord = Object.freeze({ ...successor, role: "OWNER", version: nextVersion(successor), updatedAt: input.now });
  const previousOwner: MembershipRecord = Object.freeze({ ...currentOwner, role: "ADMIN", version: nextVersion(currentOwner), updatedAt: input.now });
  const nextAgency: AgencyRecord = Object.freeze({ ...agency, version: nextVersion(agency), updatedAt: input.now });
  return {
    agency: nextAgency,
    previousOwner,
    newOwner,
    events: [
      membershipEvent(newOwner, "membership.role_changed.v1", { role: "OWNER", previousRole: successor.role, byMembershipId: currentOwner.membershipId }),
      membershipEvent(previousOwner, "membership.role_changed.v1", { role: "ADMIN", previousRole: "OWNER", byMembershipId: currentOwner.membershipId }),
      aggregateEvent({
        aggregateKind: "agency",
        aggregateId: agency.agencyId,
        aggregateVersion: nextAgency.version,
        agencyId: agency.agencyId,
        eventType: "agency.ownership_transferred.v1",
        payload: { agencyId: agency.agencyId, fromMembershipId: currentOwner.membershipId, toMembershipId: successor.membershipId },
      }),
    ],
  };
}

// --- helpers ------------------------------------------------------------------------------------------------------------------

function assertInvitationOf(membership: MembershipRecord, invitation: InvitationRecord): void {
  if (invitation.membershipId !== membership.membershipId || invitation.agencyId !== membership.agencyId) {
    throw new DomainFailure("INTEGRITY_FAILURE", `invitation ${invitation.invitationId} does not belong to membership ${membership.membershipId}`);
  }
}

function membershipEvent(membership: MembershipRecord, eventType: AggregateEvent["eventType"], extra: Readonly<Record<string, string>>): AggregateEvent {
  return aggregateEvent({
    aggregateKind: "membership",
    aggregateId: membership.membershipId,
    aggregateVersion: membership.version,
    agencyId: membership.agencyId,
    eventType,
    payload: { membershipId: membership.membershipId, agencyId: membership.agencyId, ...extra },
  });
}
