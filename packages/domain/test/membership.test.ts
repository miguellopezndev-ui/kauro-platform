// Membership aggregate (07 "Agency and membership states"; 08 "Invitation, recovery and ownership transfer"; registry machine
// Membership; R2-043). Oracle: the vendored registry for the edges; the manual sentences for the guards ("the last active
// agency owner cannot remove their own ownership without a valid successor or an explicit agency-closure procedure").
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { STATE_MACHINES } from "@kauro/contracts";
import {
  type AgencyId,
  EVENT_PAYLOAD_ALLOWLIST,
  MEMBERSHIP_ROLES,
  type MembershipOutcome,
  type MembershipRecord,
  type MembershipRole,
  type UserId,
  acceptInvitation,
  changeMembershipRole,
  createOwnerMembership,
  eventsOf,
  expireInvitation,
  grantableRoles,
  hashInvitationToken,
  inviteMember,
  isActiveOwner,
  isLiveMembership,
  mintInvitationToken,
  reactivateMembership,
  revokeInvitation,
  revokeMembership,
  statesOf,
  suspendMembership,
  tokenHashesEqual,
  transferOwnership,
  wouldLeaveNoActiveOwner,
} from "../src/index.js";
import { NOW, activeAgency, agency, at, id, invited, membership, refused, users, verified } from "./fixtures.js";

const TOKEN = mintInvitationToken((n) => new Uint8Array(randomBytes(n)));
const TOKEN_HASH = hashInvitationToken(TOKEN);
const DAY = 86_400_000;

function world(agencyState: "DRAFT" | "ACTIVE" | "RESTRICTED" | "CLOSING" | "CLOSED" = "ACTIVE") {
  const ag = agencyState === "DRAFT" ? agency() : activeAgency({ state: agencyState });
  const owner = membership(ag.agencyId, "OWNER", users.owner);
  const admin = membership(ag.agencyId, "ADMIN", users.admin);
  const operator = membership(ag.agencyId, "OPERATOR", users.operator);
  return { ag, owner, admin, operator };
}

test("CMD001: the founding owner membership is ACTIVE OWNER at version 1 with an acceptance and membership.created.v1", () => {
  const agencyId = id() as AgencyId;
  const { membership: m, event } = createOwnerMembership({ membershipId: id() as MembershipRecord["membershipId"], agencyId, userId: users.owner, assurancePolicy: "MFA_REQUIRED", now: NOW });
  assert.equal(m.role, "OWNER");
  assert.equal(m.state, "ACTIVE");
  assert.equal(m.version, 1);
  assert.equal(m.acceptedAt, NOW);
  assert.equal(m.revokedAt, undefined);
  assert.ok(isActiveOwner(m) && isLiveMembership(m));
  assert.equal(event.eventType, "membership.created.v1");
  assert.deepEqual(event.payload, { membershipId: m.membershipId, agencyId, userId: users.owner, role: "OWNER", state: "ACTIVE" });
  refused(() => createOwnerMembership({ membershipId: m.membershipId, agencyId, userId: users.owner, assurancePolicy: "", now: NOW }), "INVALID_REQUEST");
});

test("invitation tokens: minted from 32 random bytes, stored only as a digest, compared in constant time", () => {
  assert.match(TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.match(TOKEN_HASH, /^[0-9a-f]{64}$/);
  assert.equal(hashInvitationToken(TOKEN), TOKEN_HASH);
  assert.ok(tokenHashesEqual(TOKEN_HASH, hashInvitationToken(TOKEN)));
  assert.ok(!tokenHashesEqual(TOKEN_HASH, hashInvitationToken(TOKEN + "x")));
  assert.ok(!tokenHashesEqual(TOKEN_HASH, "not-a-hash"));
  assert.throws(() => mintInvitationToken(() => new Uint8Array(8)), RangeError);
  assert.throws(() => hashInvitationToken("short"), TypeError);
});

test("CMD003 inviteMember: INVITED membership at version 1 bound to the intended identity, hashed token envelope, membership.invited.v1", () => {
  const { ag, owner } = world();
  const out = inviteMember(
    { membershipId: id() as MembershipRecord["membershipId"], invitationId: id() as never, intendedUserId: users.operator, role: "OPERATOR", assurancePolicy: "MFA_REQUIRED", tokenHash: TOKEN_HASH, expiresAt: at(7 * DAY), now: NOW },
    { agency: ag, inviter: owner, existingLiveMembership: null },
  );
  assert.equal(out.membership.state, "INVITED");
  assert.equal(out.membership.version, 1);
  assert.equal(out.membership.userId, users.operator);
  assert.equal(out.membership.acceptedAt, undefined);
  assert.equal(out.invitation.tokenHash, TOKEN_HASH);
  assert.equal(out.invitation.invitedByMembershipId, owner.membershipId);
  assert.equal(out.invitation.membershipId, out.membership.membershipId);
  assert.equal(out.invitation.consumedAt, undefined);
  assert.equal(out.invitation.revokedAt, undefined);
  assert.equal(out.event.eventType, "membership.invited.v1");
  assert.deepEqual(out.event.payload, { membershipId: out.membership.membershipId, agencyId: ag.agencyId, role: "OPERATOR", invitedByMembershipId: owner.membershipId });
  assert.ok(!JSON.stringify(out.event).includes(TOKEN_HASH), "the token digest never enters the outbox");
});

test("inviteMember guards: grantable subset (D-MEM-1), inviter authority, agency open, self, existing live membership, expiry, invented role", () => {
  const { ag, owner, admin, operator } = world();
  const input = (role: string, intendedUserId: UserId = users.viewer, expiresAt = at(DAY)) => ({
    membershipId: id() as MembershipRecord["membershipId"],
    invitationId: id() as never,
    intendedUserId,
    role,
    assurancePolicy: "MFA_REQUIRED",
    tokenHash: TOKEN_HASH,
    expiresAt,
    now: NOW,
  });
  assert.deepEqual([...grantableRoles("OWNER")].sort(), [...MEMBERSHIP_ROLES].sort());
  assert.deepEqual([...grantableRoles("ADMIN")].sort(), MEMBERSHIP_ROLES.filter((r) => r !== "OWNER").sort());
  for (const r of ["OPERATOR", "APPROVER", "VIEWER", "BILLING"] as const) assert.equal(grantableRoles(r).size, 0);
  // an OWNER grants any role, including OWNER
  assert.equal(inviteMember(input("OWNER", users.second), { agency: ag, inviter: owner, existingLiveMembership: null }).membership.role, "OWNER");
  // an ADMIN grants everything but OWNER (08: granting a capability is an owner action)
  assert.equal(inviteMember(input("APPROVER"), { agency: ag, inviter: admin, existingLiveMembership: null }).membership.role, "APPROVER");
  refused(() => inviteMember(input("OWNER", users.second), { agency: ag, inviter: admin, existingLiveMembership: null }), "NOT_AUTHORIZED", "ROLE_NOT_GRANTABLE");
  // non-managers cannot invite at all
  refused(() => inviteMember(input("VIEWER"), { agency: ag, inviter: operator, existingLiveMembership: null }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  // a suspended or invited inviter has no authority
  refused(() => inviteMember(input("VIEWER"), { agency: ag, inviter: { ...owner, state: "SUSPENDED" }, existingLiveMembership: null }), "NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
  refused(() => inviteMember(input("VIEWER"), { agency: ag, inviter: { ...owner, state: "INVITED" }, existingLiveMembership: null }), "NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE");
  // an inviter of another agency is not a member here
  const other = world();
  refused(() => inviteMember(input("VIEWER"), { agency: ag, inviter: other.owner, existingLiveMembership: null }), "NOT_FOUND", "NOT_A_MEMBER");
  // CLOSING revokes new access grants; RESTRICTED and CLOSED are not open either; DRAFT is
  for (const state of ["RESTRICTED", "CLOSING", "CLOSED"] as const) {
    const w = world(state);
    refused(() => inviteMember(input("VIEWER"), { agency: w.ag, inviter: w.owner, existingLiveMembership: null }), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
  }
  const draft = world("DRAFT");
  assert.equal(inviteMember(input("VIEWER"), { agency: draft.ag, inviter: draft.owner, existingLiveMembership: null }).membership.state, "INVITED");
  // one live membership per person per agency; inviting yourself
  refused(() => inviteMember(input("VIEWER", users.operator), { agency: ag, inviter: owner, existingLiveMembership: operator }), "PRECONDITION_FAILED", "MEMBER_ALREADY_LIVE");
  refused(() => inviteMember(input("VIEWER", users.owner), { agency: ag, inviter: owner, existingLiveMembership: null }), "PRECONDITION_FAILED", "SELF_TARGET");
  refused(() => inviteMember(input("VIEWER", users.viewer), { agency: ag, inviter: owner, existingLiveMembership: operator }), "INTEGRITY_FAILURE");
  // expiry must be in the future; a client-invented privileged role makes no change
  const expiry = refused(() => inviteMember(input("VIEWER", users.viewer, NOW), { agency: ag, inviter: owner, existingLiveMembership: null }), "INVALID_REQUEST");
  assert.deepEqual(expiry.details.fields, [{ field: "expiresAt", code: "RANGE" }]);
  const invented = refused(() => inviteMember(input("SUPERUSER"), { agency: ag, inviter: owner, existingLiveMembership: null }), "INVALID_REQUEST");
  assert.deepEqual(invented.details.fields, [{ field: "role", code: "ENUM" }]);
  refused(() => inviteMember({ ...input("VIEWER"), tokenHash: "abc" }, { agency: ag, inviter: owner, existingLiveMembership: null }), "INTEGRITY_FAILURE");
});

test("CMD004 acceptInvitation: consumes the token atomically, binds the intended identity and enables only the invited role", () => {
  const { ag, owner } = world();
  const { membership: m, invitation } = invited(ag.agencyId, "OPERATOR", users.operator, owner.membershipId, TOKEN_HASH);
  const out = acceptInvitation({ membership: m, invitation, acceptor: verified(users.operator), presentedTokenHash: hashInvitationToken(TOKEN), now: at(DAY) });
  assert.equal(out.membership.state, "ACTIVE");
  assert.equal(out.membership.version, 2);
  assert.equal(out.membership.role, "OPERATOR");
  assert.equal(out.membership.acceptedAt, at(DAY));
  assert.equal(out.invitation.consumedAt, at(DAY));
  assert.equal(out.event.eventType, "membership.accepted.v1");
  assert.deepEqual(out.event.payload, { membershipId: m.membershipId, agencyId: ag.agencyId, userId: users.operator, role: "OPERATOR" });
  // a second acceptance of the consumed invitation is refused (the membership is no longer INVITED)
  refused(() => acceptInvitation({ membership: out.membership, invitation: out.invitation, acceptor: verified(users.operator), presentedTokenHash: TOKEN_HASH, now: at(DAY) }), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("acceptInvitation guards: forwarded token (D-MEM-3), revoked, consumed, expired, wrong token, unverified acceptor, foreign envelope", () => {
  const { ag, owner } = world();
  const { membership: m, invitation } = invited(ag.agencyId, "OPERATOR", users.operator, owner.membershipId, TOKEN_HASH, at(DAY));
  const good = { membership: m, invitation, acceptor: verified(users.operator), presentedTokenHash: TOKEN_HASH, now: NOW };
  // another person with the right token learns nothing, not even the state of the invitation
  const forwarded = refused(() => acceptInvitation({ ...good, acceptor: verified(users.stranger) }), "NOT_FOUND");
  assert.equal(forwarded.reason, undefined);
  refused(() => acceptInvitation({ ...good, acceptor: verified(users.stranger), invitation: { ...invitation, revokedAt: NOW } }), "NOT_FOUND");
  refused(() => acceptInvitation({ ...good, acceptor: verified(users.stranger), now: at(2 * DAY) }), "NOT_FOUND");
  refused(() => acceptInvitation({ ...good, invitation: { ...invitation, revokedAt: NOW } }), "PRECONDITION_FAILED", "INVITATION_REVOKED");
  refused(() => acceptInvitation({ ...good, invitation: { ...invitation, consumedAt: NOW } }), "PRECONDITION_FAILED", "INVITATION_CONSUMED");
  refused(() => acceptInvitation({ ...good, now: at(DAY) }), "PRECONDITION_FAILED", "INVITATION_EXPIRED");
  refused(() => acceptInvitation({ ...good, now: at(DAY + 1) }), "PRECONDITION_FAILED", "INVITATION_EXPIRED");
  assert.equal(acceptInvitation({ ...good, now: at(DAY - 1) }).membership.state, "ACTIVE");
  refused(() => acceptInvitation({ ...good, presentedTokenHash: hashInvitationToken(TOKEN + "x") }), "NOT_AUTHORIZED", "INVITATION_TOKEN_MISMATCH");
  refused(() => acceptInvitation({ ...good, acceptor: { ...verified(users.operator), mfaEnrolledAt: null } }), "NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
  refused(() => acceptInvitation({ ...good, acceptor: { ...verified(users.operator), state: "DISABLED" } }), "NOT_AUTHORIZED", "IDENTITY_DISABLED");
  const foreign = invited(ag.agencyId, "VIEWER", users.viewer, owner.membershipId, TOKEN_HASH).invitation;
  refused(() => acceptInvitation({ ...good, invitation: foreign }), "INTEGRITY_FAILURE");
});

test("expireInvitation follows the server clock only; an expired invite cannot be revived (07)", () => {
  const { ag, owner } = world();
  const { membership: m, invitation } = invited(ag.agencyId, "VIEWER", users.viewer, owner.membershipId, TOKEN_HASH, at(DAY));
  refused(() => expireInvitation({ membership: m, invitation, now: at(DAY - 1) }), "PRECONDITION_FAILED", "INVITATION_NOT_EXPIRED");
  const out = expireInvitation({ membership: m, invitation, now: at(DAY) });
  assert.equal(out.membership.state, "EXPIRED");
  assert.equal(out.membership.version, 2);
  assert.equal(out.event.eventType, "membership.expired.v1");
  assert.deepEqual(out.event.payload, { membershipId: m.membershipId, agencyId: ag.agencyId });
  // a "browser timestamp" earlier than the deadline changes nothing once EXPIRED: the edge is unlisted
  refused(() => acceptInvitation({ membership: out.membership, invitation, acceptor: verified(users.viewer), presentedTokenHash: TOKEN_HASH, now: at(DAY - 1) }), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("revokeInvitation (inviter_revokes): owner or admin of the scope; an admin cannot revoke an OWNER invitation (D-MEM-2)", () => {
  const { ag, owner, admin, operator } = world();
  const { membership: m, invitation } = invited(ag.agencyId, "VIEWER", users.viewer, owner.membershipId, TOKEN_HASH);
  const out = revokeInvitation({ membership: m, invitation, expectedVersion: 1, actor: admin, agency: ag, reasonCode: "INVITE_MISTAKE", now: at(1) });
  assert.equal(out.membership.state, "REVOKED");
  assert.equal(out.membership.revokedAt, at(1));
  assert.equal(out.invitation.revokedAt, at(1));
  assert.equal(out.event.eventType, "membership.revoked.v1");
  assert.deepEqual(out.event.payload, { membershipId: m.membershipId, agencyId: ag.agencyId, byMembershipId: admin.membershipId, reasonCode: "INVITE_MISTAKE" });
  refused(() => acceptInvitation({ membership: out.membership, invitation: out.invitation, acceptor: verified(users.viewer), presentedTokenHash: TOKEN_HASH, now: at(2) }), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
  const ownerInvite = invited(ag.agencyId, "OWNER", users.second, owner.membershipId, TOKEN_HASH);
  refused(() => revokeInvitation({ ...ownerInvite, expectedVersion: 1, actor: admin, agency: ag, reasonCode: "X_Y", now: NOW }), "NOT_AUTHORIZED", "OWNER_PROTECTED");
  assert.equal(revokeInvitation({ ...ownerInvite, expectedVersion: 1, actor: owner, agency: ag, reasonCode: "X_Y", now: NOW }).membership.state, "REVOKED");
  refused(() => revokeInvitation({ membership: m, invitation, expectedVersion: 1, actor: operator, agency: ag, reasonCode: "X_Y", now: NOW }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => revokeInvitation({ membership: m, invitation, expectedVersion: 2, actor: owner, agency: ag, reasonCode: "X_Y", now: NOW }), "STALE_VERSION");
  const badReason = refused(() => revokeInvitation({ membership: m, invitation, expectedVersion: 1, actor: owner, agency: ag, reasonCode: "because", now: NOW }), "INVALID_REQUEST");
  assert.deepEqual(badReason.details.fields, [{ field: "reasonCode", code: "FORMAT" }]);
});

test("every listed edge of the registry Membership machine is performed by exactly one aggregate operation", () => {
  const m = STATE_MACHINES.find((x) => x.contract === "Membership");
  assert.ok(m);
  const { ag, owner, admin } = world();
  /** The token envelope of the target membership itself (whatever its state, so unlisted pairs reach the machine guard). */
  const envelopeOf = (t: MembershipRecord, expiresAt = at(7 * DAY)) => ({ ...invited(ag.agencyId, t.role, t.userId, owner.membershipId, TOKEN_HASH, expiresAt).invitation, membershipId: t.membershipId });
  const OPERATIONS: Readonly<Record<string, (target: MembershipRecord) => MembershipOutcome>> = {
    intended_identity_accepts: (t) => acceptInvitation({ membership: t, invitation: envelopeOf(t), acceptor: verified(t.userId), presentedTokenHash: TOKEN_HASH, now: at(1) }),
    invitation_deadline: (t) => expireInvitation({ membership: t, invitation: envelopeOf(t, at(1)), now: at(1) }),
    inviter_revokes: (t) => revokeInvitation({ membership: t, invitation: envelopeOf(t), expectedVersion: t.version, actor: owner, agency: ag, reasonCode: "REVOKED_BY_TEST", now: at(1) }),
    authorized_suspension: (t) => suspendMembership({ membership: t, expectedVersion: t.version, actor: owner, agency: ag, activeOwnerCount: 1, now: at(1) }),
    authorized_reactivation: (t) => reactivateMembership({ membership: t, expectedVersion: t.version, actor: owner, agency: ag, memberIdentity: verified(t.userId), now: at(1) }),
    authorized_revocation: (t) => revokeMembership({ membership: t, expectedVersion: t.version, actor: admin, agency: ag, activeOwnerCount: 1, reasonCode: "LEFT_COMPANY", now: at(1) }),
  };
  const EVENT_OF: Readonly<Record<string, string>> = { intended_identity_accepts: "membership.accepted.v1", invitation_deadline: "membership.expired.v1", inviter_revokes: "membership.revoked.v1", authorized_suspension: "membership.suspended.v1", authorized_reactivation: "membership.reactivated.v1", authorized_revocation: "membership.revoked.v1" };
  assert.deepEqual([...eventsOf("Membership")].sort(), Object.keys(OPERATIONS).sort());
  let performed = 0;
  for (const edge of m.transitions) {
    // invitation-membership fixtures for the invited target, otherwise an accepted OPERATOR at version 3
    const fixture = invited(ag.agencyId, "OPERATOR", users.operator, owner.membershipId, TOKEN_HASH).membership;
    const before: MembershipRecord = edge.from === "INVITED" ? { ...fixture, version: 3 } : membership(ag.agencyId, "OPERATOR", users.operator, { state: edge.from as MembershipRecord["state"], version: 3 });
    const { membership: after, event } = (OPERATIONS[edge.event] as (t: MembershipRecord) => MembershipOutcome)(before);
    assert.equal(after.state, edge.to, `${edge.from} --${edge.event}--> ${edge.to}`);
    assert.equal(after.version, 4);
    assert.equal(after.role, before.role, "a transition never changes the role");
    assert.equal(event.aggregateKind, "membership");
    assert.equal(event.aggregateVersion, 4);
    assert.equal(event.eventType, EVENT_OF[edge.event]);
    for (const key of Object.keys(event.payload)) assert.ok(EVENT_PAYLOAD_ALLOWLIST[event.eventType].includes(key), `${event.eventType}.${key}`);
    if (edge.to === "REVOKED") assert.equal(after.revokedAt, at(1));
    else assert.equal(after.revokedAt, undefined);
    if (edge.to === "ACTIVE") assert.ok(after.acceptedAt !== undefined);
    performed += 1;
  }
  assert.equal(performed, 7);

  // every unlisted (state, event) pair is refused without a change
  let refusedPairs = 0;
  for (const state of statesOf("Membership")) {
    for (const event of eventsOf("Membership")) {
      if (m.transitions.some((t) => t.from === state && t.event === event)) continue;
      const before = membership(ag.agencyId, "OPERATOR", users.operator, { state: state as MembershipRecord["state"], version: 3 });
      const snapshot = JSON.stringify(before);
      const f = refused(() => (OPERATIONS[event] as (t: MembershipRecord) => MembershipOutcome)(before), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
      assert.equal(f.details.currentState, state);
      assert.equal(JSON.stringify(before), snapshot);
      refusedPairs += 1;
    }
  }
  assert.equal(refusedPairs, statesOf("Membership").length * eventsOf("Membership").length - 7);
  for (const terminal of ["REVOKED", "EXPIRED"]) for (const event of eventsOf("Membership")) refused(() => (OPERATIONS[event] as (t: MembershipRecord) => MembershipOutcome)(membership(ag.agencyId, "VIEWER", users.viewer, { state: terminal as "REVOKED", version: 2 })), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("last-owner rule (07; R2-043): the sole active owner cannot be revoked, suspended or demoted unless the closure procedure is the authority", () => {
  const { ag, owner, admin } = world();
  const facts = (activeOwnerCount: number, state = ag.state) => ({ agency: { agencyId: ag.agencyId, state }, activeOwnerCount });
  // the predicate itself
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "OWNER", state: "REVOKED" }, facts(1)), true);
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "OWNER", state: "SUSPENDED" }, facts(1)), true);
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "ADMIN", state: "ACTIVE" }, facts(1)), true);
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "OWNER", state: "REVOKED" }, facts(2)), false, "another active owner remains");
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "OWNER", state: "REVOKED" }, facts(1, "CLOSING")), false, "explicit closure authority");
  assert.equal(wouldLeaveNoActiveOwner(owner, { role: "OWNER", state: "REVOKED" }, facts(1, "CLOSED")), false);
  assert.equal(wouldLeaveNoActiveOwner(admin, { role: "ADMIN", state: "REVOKED" }, facts(1)), false, "a non-owner never triggers the rule");
  assert.equal(wouldLeaveNoActiveOwner({ role: "OWNER", state: "SUSPENDED" }, { role: "OWNER", state: "REVOKED" }, facts(1)), false, "a suspended owner is not an active owner");
  assert.throws(() => wouldLeaveNoActiveOwner(owner, owner, facts(-1)), RangeError);

  // the sole owner cannot remove their own ownership (07 sentence) — by any operation
  refused(() => revokeMembership({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, reasonCode: "LEAVING", now: NOW }), "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED");
  refused(() => suspendMembership({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, now: NOW }), "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED");
  refused(() => changeMembershipRole({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "ADMIN", now: NOW }), "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED");
  // with a second active owner every operation proceeds
  assert.equal(revokeMembership({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 2, reasonCode: "LEAVING", now: NOW }).membership.state, "REVOKED");
  assert.equal(suspendMembership({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 2, now: NOW }).membership.state, "SUSPENDED");
  assert.equal(changeMembershipRole({ membership: owner, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 2, role: "ADMIN", now: NOW }).membership.role, "ADMIN");
  // closure authority permits the last owner to leave
  const closing = activeAgency({ agencyId: ag.agencyId, state: "CLOSING" });
  assert.equal(revokeMembership({ membership: owner, expectedVersion: 1, actor: owner, agency: closing, activeOwnerCount: 1, reasonCode: "CLOSURE", now: NOW }).membership.state, "REVOKED");

  // R2-043 in pure terms: two owners each remove the other while both read two active owners. Both pass this check —
  // which is exactly why the invariant is serialized on the agency row by the database (D-OWN-1): the second remover
  // re-reads one active owner after the first commit and is refused.
  const second = membership(ag.agencyId, "OWNER", users.second);
  const first = revokeMembership({ membership: second, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 2, reasonCode: "MUTUAL", now: NOW });
  assert.equal(first.membership.state, "REVOKED");
  refused(() => revokeMembership({ membership: owner, expectedVersion: 1, actor: second, agency: ag, activeOwnerCount: 1, reasonCode: "MUTUAL", now: NOW }), "PRECONDITION_FAILED", "LAST_OWNER_PROTECTED");
});

test("team authority: owner/admin of the scope act on the team, an admin never on an owner, a suspended actor never, foreign targets are not found", () => {
  const { ag, owner, admin, operator } = world();
  const viewer = membership(ag.agencyId, "VIEWER", users.viewer);
  const change = (target: MembershipRecord, actor: MembershipRecord, count = 2) => suspendMembership({ membership: target, expectedVersion: target.version, actor, agency: ag, activeOwnerCount: count, now: NOW });
  assert.equal(change(viewer, admin).membership.state, "SUSPENDED");
  assert.equal(change(admin, owner).membership.state, "SUSPENDED");
  refused(() => change(owner, admin), "NOT_AUTHORIZED", "OWNER_PROTECTED");
  refused(() => change(viewer, operator), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => change(viewer, { ...owner, state: "SUSPENDED" }), "NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
  refused(() => change(viewer, { ...owner, state: "INVITED" }), "NOT_AUTHORIZED", "MEMBERSHIP_NOT_ACTIVE");
  const other = world();
  refused(() => change(other.operator, owner), "NOT_FOUND", "CROSS_AGENCY");
  refused(() => change(viewer, other.owner), "NOT_FOUND", "NOT_A_MEMBER");
  // events name the actor
  const out = change(viewer, admin);
  assert.deepEqual(out.event.payload, { membershipId: viewer.membershipId, agencyId: ag.agencyId, byMembershipId: admin.membershipId });
});

test("reactivation rechecks identity and agency readiness instead of reusing a cached grant (edge effect)", () => {
  const { ag, owner } = world();
  const suspended = membership(ag.agencyId, "OPERATOR", users.operator, { state: "SUSPENDED", version: 2 });
  const base = { membership: suspended, expectedVersion: 2, actor: owner, agency: ag, memberIdentity: verified(users.operator), now: NOW };
  const out = reactivateMembership(base);
  assert.equal(out.membership.state, "ACTIVE");
  assert.equal(out.event.eventType, "membership.reactivated.v1");
  refused(() => reactivateMembership({ ...base, memberIdentity: { ...verified(users.operator), mfaEnrolledAt: null } }), "PRECONDITION_FAILED", "IDENTITY_UNVERIFIED");
  refused(() => reactivateMembership({ ...base, memberIdentity: { ...verified(users.operator), emailVerifiedAt: null } }), "PRECONDITION_FAILED", "IDENTITY_UNVERIFIED");
  refused(() => reactivateMembership({ ...base, memberIdentity: { ...verified(users.operator), state: "DISABLED" } }), "PRECONDITION_FAILED", "IDENTITY_DISABLED");
  refused(() => reactivateMembership({ ...base, memberIdentity: verified(users.viewer) }), "INTEGRITY_FAILURE");
  refused(() => reactivateMembership({ ...base, agency: activeAgency({ agencyId: ag.agencyId, state: "CLOSING" }) }), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
  refused(() => reactivateMembership({ ...base, expectedVersion: 1 }), "STALE_VERSION");
});

test("CMD006 revokeMembership: revokes future access with revokedAt and a reason, keeps history, from ACTIVE or SUSPENDED", () => {
  const { ag, owner, admin, operator } = world();
  const out = revokeMembership({ membership: operator, expectedVersion: 1, actor: admin, agency: ag, activeOwnerCount: 1, reasonCode: "CONTRACT_ENDED", now: at(5) });
  assert.equal(out.membership.state, "REVOKED");
  assert.equal(out.membership.revokedAt, at(5));
  assert.equal(out.membership.acceptedAt, operator.acceptedAt, "history is kept");
  assert.equal(out.membership.role, "OPERATOR");
  assert.deepEqual(out.event.payload, { membershipId: operator.membershipId, agencyId: ag.agencyId, byMembershipId: admin.membershipId, reasonCode: "CONTRACT_ENDED" });
  const suspended = membership(ag.agencyId, "VIEWER", users.viewer, { state: "SUSPENDED", version: 2 });
  assert.equal(revokeMembership({ membership: suspended, expectedVersion: 2, actor: owner, agency: ag, activeOwnerCount: 1, reasonCode: "CONTRACT_ENDED", now: NOW }).membership.state, "REVOKED");
  refused(() => revokeMembership({ membership: operator, expectedVersion: 1, actor: admin, agency: ag, activeOwnerCount: 1, reasonCode: "no", now: NOW }), "INVALID_REQUEST");
  refused(() => revokeMembership({ membership: operator, expectedVersion: 2, actor: admin, agency: ag, activeOwnerCount: 1, reasonCode: "CONTRACT_ENDED", now: NOW }), "STALE_VERSION");
  // a revoked membership cannot be revoked, suspended or reactivated again
  refused(() => revokeMembership({ membership: out.membership, expectedVersion: 2, actor: admin, agency: ag, activeOwnerCount: 1, reasonCode: "AGAIN", now: NOW }), "PRECONDITION_FAILED", "UNLISTED_TRANSITION");
});

test("CMD005 changeMembershipRole: owner-only, versioned, audited; invented roles, no-ops, invited targets and last-owner demotion are refused", () => {
  const { ag, owner, admin, operator } = world();
  const out = changeMembershipRole({ membership: operator, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "APPROVER", now: at(3) });
  assert.equal(out.membership.role, "APPROVER");
  assert.equal(out.membership.state, "ACTIVE");
  assert.equal(out.membership.version, 2);
  assert.equal(out.event.eventType, "membership.role_changed.v1");
  assert.deepEqual(out.event.payload, { membershipId: operator.membershipId, agencyId: ag.agencyId, role: "APPROVER", previousRole: "OPERATOR", byMembershipId: owner.membershipId });
  // promoting to OWNER is an owner action and adds an owner
  assert.equal(changeMembershipRole({ membership: operator, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "OWNER", now: NOW }).membership.role, "OWNER");
  refused(() => changeMembershipRole({ membership: operator, expectedVersion: 1, actor: admin, agency: ag, activeOwnerCount: 1, role: "APPROVER", now: NOW }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  const invented = refused(() => changeMembershipRole({ membership: operator, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "AGENCY_OWNER", now: NOW }), "INVALID_REQUEST");
  assert.deepEqual(invented.details.fields, [{ field: "role", code: "ENUM" }]);
  refused(() => changeMembershipRole({ membership: operator, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "OPERATOR", now: NOW }), "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE");
  const invitedTarget = membership(ag.agencyId, "VIEWER", users.viewer, { state: "INVITED" });
  refused(() => changeMembershipRole({ membership: invitedTarget, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "ADMIN", now: NOW }), "PRECONDITION_FAILED", "MEMBERSHIP_NOT_ACTIVE");
  const revoked = membership(ag.agencyId, "VIEWER", users.viewer, { state: "REVOKED", revokedAt: NOW });
  refused(() => changeMembershipRole({ membership: revoked, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "ADMIN", now: NOW }), "PRECONDITION_FAILED", "MEMBERSHIP_NOT_ACTIVE");
  refused(() => changeMembershipRole({ membership: operator, expectedVersion: 7, actor: owner, agency: ag, activeOwnerCount: 1, role: "ADMIN", now: NOW }), "STALE_VERSION");
  const other = world();
  refused(() => changeMembershipRole({ membership: other.operator, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: "ADMIN", now: NOW }), "NOT_FOUND", "CROSS_AGENCY");
});

test("CMD007 transferOwnership: versioned pair of role changes plus the agency record; never ownerless, never an unintended owner", () => {
  const { ag, owner, admin } = world();
  const base = { agency: ag, expectedAgencyVersion: ag.version, currentOwner: owner, successor: admin, successorIdentity: verified(users.admin), successorAcceptance: { acceptedAt: NOW }, now: at(9) };
  const out = transferOwnership(base);
  assert.equal(out.newOwner.role, "OWNER");
  assert.equal(out.newOwner.version, admin.version + 1);
  assert.equal(out.previousOwner.role, "ADMIN");
  assert.equal(out.previousOwner.version, owner.version + 1);
  assert.equal(out.agency.version, ag.version + 1);
  assert.equal(out.agency.state, ag.state);
  assert.deepEqual(out.events.map((e) => [e.eventType, e.aggregateKind, e.aggregateVersion]), [
    ["membership.role_changed.v1", "membership", out.newOwner.version],
    ["membership.role_changed.v1", "membership", out.previousOwner.version],
    ["agency.ownership_transferred.v1", "agency", out.agency.version],
  ]);
  assert.deepEqual(out.events[2]?.payload, { agencyId: ag.agencyId, fromMembershipId: owner.membershipId, toMembershipId: admin.membershipId });
  assert.ok(isActiveOwner(out.newOwner) && !isActiveOwner(out.previousOwner));

  const other = world();
  refused(() => transferOwnership({ ...base, successor: other.admin, successorIdentity: verified(users.admin) }), "NOT_FOUND", "CROSS_AGENCY");
  refused(() => transferOwnership({ ...base, successor: { ...admin, state: "SUSPENDED" } }), "PRECONDITION_FAILED", "RECIPIENT_NOT_ACTIVE");
  refused(() => transferOwnership({ ...base, successor: { ...admin, state: "INVITED" } }), "PRECONDITION_FAILED", "RECIPIENT_NOT_ACTIVE");
  refused(() => transferOwnership({ ...base, successorIdentity: { ...verified(users.admin), mfaEnrolledAt: null } }), "PRECONDITION_FAILED", "RECIPIENT_UNVERIFIED");
  refused(() => transferOwnership({ ...base, successorIdentity: verified(users.viewer) }), "INTEGRITY_FAILURE");
  refused(() => transferOwnership({ ...base, successorAcceptance: null }), "PRECONDITION_FAILED", "RECIPIENT_ACCEPTANCE_MISSING");
  refused(() => transferOwnership({ ...base, successor: owner, successorIdentity: verified(users.owner) }), "PRECONDITION_FAILED", "SELF_TARGET");
  refused(() => transferOwnership({ ...base, currentOwner: admin, successor: owner, successorIdentity: verified(users.owner) }), "NOT_AUTHORIZED", "ROLE_INSUFFICIENT");
  refused(() => transferOwnership({ ...base, currentOwner: { ...owner, state: "SUSPENDED" } }), "NOT_AUTHORIZED", "MEMBERSHIP_SUSPENDED");
  const coOwner = membership(ag.agencyId, "OWNER", users.second);
  refused(() => transferOwnership({ ...base, successor: coOwner, successorIdentity: verified(users.second) }), "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE");
  refused(() => transferOwnership({ ...base, agency: activeAgency({ agencyId: ag.agencyId, state: "CLOSING", version: ag.version }) }), "PRECONDITION_FAILED", "AGENCY_NOT_OPEN");
  const stale = refused(() => transferOwnership({ ...base, expectedAgencyVersion: ag.version + 1 }), "STALE_VERSION");
  assert.equal(stale.details.currentVersion, ag.version);
  refused(() => transferOwnership({ ...base, currentOwner: other.owner }), "NOT_FOUND", "NOT_A_MEMBER");
});

test("membership roles: exactly the registry vocabulary is accepted", () => {
  const { ag, owner } = world();
  const roles: MembershipRole[] = ["OWNER", "ADMIN", "OPERATOR", "APPROVER", "VIEWER", "BILLING"];
  assert.deepEqual([...MEMBERSHIP_ROLES], roles);
  const target = membership(ag.agencyId, "VIEWER", users.viewer);
  for (const role of roles) {
    const change = () => changeMembershipRole({ membership: target, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role, now: NOW });
    if (role === "VIEWER") refused(change, "PRECONDITION_FAILED", "NO_SEMANTIC_CHANGE");
    else assert.equal(change().membership.role, role);
  }
  for (const invented of ["owner", "AGENCY_OWNER", "KAURO_OWNER", "PAYMENT_SERVICE", ""]) {
    const f = refused(() => changeMembershipRole({ membership: target, expectedVersion: 1, actor: owner, agency: ag, activeOwnerCount: 1, role: invented, now: NOW }), "INVALID_REQUEST");
    assert.deepEqual(f.details.fields, [{ field: "role", code: "ENUM" }]);
  }
});
