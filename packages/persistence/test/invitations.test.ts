// Invitation tokens through the invitation port on real PostgreSQL 17 (re-check finding N19; 08 "Invitation, recovery and
// ownership transfer": one-use, time-limited opaque tokens, stored hashed; the invite records agency, intended identity, role and
// expiry; changing the role after sending invalidates or reissues the invite; COMMAND_CATALOGUE CMD003 "one expiring invitation
// with a hashed single-use token and explicit agency scope", CMD004 "Atomically consume the invitation and activate the intended
// scoped membership", "Concurrent acceptances produce one membership"). Every write runs as the request-handler role under the
// session that would perform it, through PgInvitationRepository; the rules are the database's (migration 0002).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { hashInvitationToken, isDomainFailure, mintInvitationToken, toUtcInstant, type InvitationId, type MembershipId, type UserId } from "@kauro/domain";
import { PgInvitationRepository } from "../src/index.js";
import { clock, ids, start, waitForLockWait, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { bind, event, sqlState, tx } from "./support.js";

let h: Harness;
let app: Client;
let owner: UserId;
let admin: UserId;
let viewer: UserId;
let A: AgencyFixture;
let adminMembership: MembershipId;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  owner = await h.person("owner-invitations");
  admin = await h.person("admin-invitations");
  viewer = await h.person("viewer-invitations");
  A = await h.createAgency(owner, "Invitations A");
  adminMembership = await h.addMember(A, admin, "ADMIN");
  await h.addMember(A, viewer, "VIEWER");
});
after(async () => {
  await app.end();
  await h.stop();
});

const tokenHash = (): string => hashInvitationToken(mintInvitationToken((n) => new Uint8Array(randomBytes(n))));
const inDays = (days: number) => toUtcInstant(Date.now() + days * 86_400_000);

/** The INVITED membership of `invitee` (v1 and its event), inserted by the owner's session. */
async function invitedMembership(invitee: UserId, role: "OPERATOR" | "VIEWER" | "OWNER" | "ADMIN"): Promise<MembershipId> {
  const membershipId = ids.next() as MembershipId;
  await tx(app, { agencyId: A.agencyId, userId: owner }, async (c) => {
    await c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, created_at, updated_at) VALUES ($1, $2, $3, $4, 'INVITED', 'MFA_REQUIRED', now(), now())", [membershipId, A.agencyId, invitee, role]);
    await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "membership.invited.v1", actorUserId: owner, payload: { membershipId } });
  });
  return membershipId;
}

/** The invitation port inside one transaction of the runtime role under (agency A, sessionUser). */
function asSession<T>(sessionUser: UserId, fn: (invitations: PgInvitationRepository, c: Client) => Promise<T>): Promise<T> {
  return tx(app, { agencyId: A.agencyId, userId: sessionUser }, (c) => fn(new PgInvitationRepository(c), c));
}

function invitation(membershipId: MembershipId, role: "OPERATOR" | "VIEWER" | "OWNER" | "ADMIN", invitedBy: MembershipId, expiresAt = inDays(7)) {
  return { invitationId: ids.next() as InvitationId, agencyId: A.agencyId, membershipId, tokenHash: tokenHash(), role, invitedByMembershipId: invitedBy, expiresAt, createdAt: clock.now() };
}

test("N19: an invitation is issued by the acting session's own membership with the authority to grant its role, for an INVITED membership of exactly that role, one open at a time", async () => {
  const ida = await h.person("ida-invitations");
  const m = await invitedMembership(ida, "OPERATOR");
  // the role differs from the membership's (08: an invitation names the role it would enable)
  await assert.rejects(asSession(owner, (inv) => inv.insert(invitation(m, "ADMIN", A.ownerMembershipId))), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  // issued in the owner's name by another session, or by a VIEWER
  await assert.rejects(asSession(admin, (inv) => inv.insert(invitation(m, "OPERATOR", A.ownerMembershipId))), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  const viewerMembership = (await h.oracle.query("SELECT membership_id FROM kauro.memberships WHERE agency_id = $1 AND user_id = $2", [A.agencyId, viewer])).rows[0].membership_id as MembershipId;
  await assert.rejects(asSession(viewer, (inv) => inv.insert(invitation(m, "OPERATOR", viewerMembership))), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  // an ADMIN grants any role but OWNER
  const owed = await invitedMembership(await h.person("oscar-invitations"), "OWNER");
  await assert.rejects(asSession(admin, (inv) => inv.insert(invitation(owed, "OWNER", adminMembership))), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  // the legitimate issue, then a second open invitation of the same membership is an outcome, not a crash
  const first = await asSession(admin, (inv) => inv.insert(invitation(m, "OPERATOR", adminMembership)));
  assert.equal(first.kind, "ISSUED");
  const second = await asSession(owner, (inv) => inv.insert(invitation(m, "OPERATOR", A.ownerMembershipId)));
  assert.deepEqual(second, { kind: "OPEN_INVITATION_EXISTS" });
  // an invitation's envelope never changes and it is issued open
  if (first.kind !== "ISSUED") throw new Error("unreachable");
  await assert.rejects(tx(app, { agencyId: A.agencyId, userId: owner }, (c) => c.query("UPDATE kauro.membership_invitations SET role = 'ADMIN' WHERE invitation_id = $1", [first.invitation.invitationId])), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(tx(h.oracle, { agencyId: A.agencyId, userId: owner }, (c) => c.query("UPDATE kauro.membership_invitations SET expires_at = now() + interval '30 days' WHERE invitation_id = $1", [first.invitation.invitationId])), (e: unknown) => sqlState(e) === "KA004");
  // the role of an INVITED membership cannot change: the open invitation always names the role it enables
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner }, async (c) => {
      await c.query("UPDATE kauro.memberships SET role = 'ADMIN', version = 2 WHERE membership_id = $1", [m]);
      await event(c, { aggregateKind: "membership", aggregateId: m, aggregateVersion: 2, agencyId: A.agencyId, eventType: "membership.role_changed.v1", actorUserId: owner, payload: { membershipId: m } });
    }),
    (e: unknown) => sqlState(e) === "KA010",
  );
});

test("N19: only the invited identity consumes its invitation, once, before its deadline; the stored token is only a digest; a closed invitation never reopens; the invitee finds it by token without a tenant context", async () => {
  const jo = await h.person("jo-invitations");
  const m = await invitedMembership(jo, "VIEWER");
  const issued = await asSession(owner, (inv) => inv.insert(invitation(m, "VIEWER", A.ownerMembershipId)));
  if (issued.kind !== "ISSUED") throw new Error("the invitation was not issued");
  const id = issued.invitation.invitationId;
  // another identity presents the token: the owner, the admin
  await assert.rejects(asSession(owner, (inv) => inv.consume(id, clock.now())), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  // the invitee finds its invitation by the digest of its token under its own identity context (CMD004 is VERIFIED_USER)
  const found = await tx(app, { userId: jo }, (c) => new PgInvitationRepository(c).findByTokenHash(issued.invitation.tokenHash));
  assert.equal(found?.invitationId, id);
  const hidden = await tx(app, { userId: admin }, (c) => new PgInvitationRepository(c).findByTokenHash(issued.invitation.tokenHash));
  assert.equal(hidden, null, "another identity without the tenant context finds nothing");
  // consumed once by the invitee and accepted in the same transaction
  await asSession(jo, async (inv, c) => {
    assert.equal((await inv.consume(id, clock.now())).kind, "CLOSED");
    await c.query("UPDATE kauro.memberships SET state = 'ACTIVE', accepted_at = now(), version = 2 WHERE membership_id = $1", [m]);
    await event(c, { aggregateKind: "membership", aggregateId: m, aggregateVersion: 2, agencyId: A.agencyId, eventType: "membership.accepted.v1", actorUserId: jo, payload: { membershipId: m } });
  });
  const again = await asSession(jo, (inv) => inv.consume(id, clock.now()));
  assert.equal(again.kind, "ALREADY_CLOSED");
  // a closed invitation's outcome never changes, even for the superuser
  await assert.rejects(tx(h.oracle, {}, (c) => c.query("UPDATE kauro.membership_invitations SET consumed_at = NULL WHERE invitation_id = $1", [id])), (e: unknown) => sqlState(e) === "KA011");
  await assert.rejects(tx(h.oracle, {}, (c) => c.query("UPDATE kauro.membership_invitations SET revoked_at = now() WHERE invitation_id = $1", [id])), (e: unknown) => sqlState(e) === "KA011");
  // the stored token material is a SHA-256 digest (08: stored token material is hashed)
  const stored = await h.oracle.query("SELECT token_hash ~ '^[0-9a-f]{64}$' AS digest FROM kauro.membership_invitations WHERE invitation_id = $1", [id]);
  assert.deepEqual(stored.rows[0], { digest: true });
  // past its deadline an invitation cannot be consumed (the server clock decides, 07 "An expired invite cannot be revived")
  const kim = await h.person("kim-invitations");
  const late = await invitedMembership(kim, "VIEWER");
  // an invitation is issued only by a session's own membership: a writer with no acting session (the superuser) is refused too
  await assert.rejects(
    h.oracle.query(
      "INSERT INTO kauro.membership_invitations (invitation_id, agency_id, membership_id, token_hash, role, invited_by_membership_id, expires_at, created_at) VALUES ($1, $2, $3, $4, 'VIEWER', $5, now() + interval '1 day', now())",
      [ids.next(), A.agencyId, late, tokenHash(), A.ownerMembershipId],
    ),
    (e: unknown) => sqlState(e) === "KA010",
  );
  // the owner's session issues one whose deadline has already passed (issued two days ago, expired an hour ago)
  const lateId = ids.next() as InvitationId;
  await tx(app, { agencyId: A.agencyId, userId: owner }, (c) =>
    c.query("INSERT INTO kauro.membership_invitations (invitation_id, agency_id, membership_id, token_hash, role, invited_by_membership_id, expires_at, created_at) VALUES ($1, $2, $3, $4, 'VIEWER', $5, now() - interval '1 hour', now() - interval '2 days')", [lateId, A.agencyId, late, tokenHash(), A.ownerMembershipId]),
  );
  await assert.rejects(asSession(kim, (inv) => inv.consume(lateId, clock.now())), (e: unknown) => isDomainFailure(e) && e.code === "PRECONDITION_FAILED" && e.reason === "INVITATION_NOT_OPEN");
  // and its membership then expires on the server clock, which a revocation-free expiry needs
  await tx(app, { agencyId: A.agencyId, userId: owner }, async (c) => {
    await c.query("UPDATE kauro.memberships SET state = 'EXPIRED', version = 2 WHERE membership_id = $1", [late]);
    await event(c, { aggregateKind: "membership", aggregateId: late, aggregateVersion: 2, agencyId: A.agencyId, eventType: "membership.expired.v1", actorUserId: owner, payload: { membershipId: late } });
  });
});

test("N19: team authority revokes an open invitation (an ADMIN never one of an OWNER role); concurrent consumptions produce one acceptance", async () => {
  const lu = await h.person("lu-invitations");
  const m = await invitedMembership(lu, "OPERATOR");
  const issued = await asSession(owner, (inv) => inv.insert(invitation(m, "OPERATOR", A.ownerMembershipId)));
  if (issued.kind !== "ISSUED") throw new Error("the invitation was not issued");
  await assert.rejects(asSession(viewer, (inv) => inv.revoke(issued.invitation.invitationId, clock.now())), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  assert.equal((await asSession(admin, (inv) => inv.revoke(issued.invitation.invitationId, clock.now()))).kind, "CLOSED");
  assert.equal((await asSession(lu, (inv) => inv.consume(issued.invitation.invitationId, clock.now()))).kind, "ALREADY_CLOSED", "a revoked invitation is closed for its invitee");
  // an OWNER-role invitation is out of an ADMIN's reach
  const mo = await h.person("mo-invitations");
  const om = await invitedMembership(mo, "OWNER");
  const ownerInvite = await asSession(owner, (inv) => inv.insert(invitation(om, "OWNER", A.ownerMembershipId)));
  if (ownerInvite.kind !== "ISSUED") throw new Error("the owner invitation was not issued");
  await assert.rejects(asSession(admin, (inv) => inv.revoke(ownerInvite.invitation.invitationId, clock.now())), (e: unknown) => isDomainFailure(e) && e.code === "NOT_AUTHORIZED");
  // two consumptions of one invitation at once: the second waits on the row and finds it closed (one acceptance)
  const ned = await h.person("ned-invitations");
  const nm = await invitedMembership(ned, "VIEWER");
  const nIssued = await asSession(owner, (inv) => inv.insert(invitation(nm, "VIEWER", A.ownerMembershipId)));
  if (nIssued.kind !== "ISSUED") throw new Error("not issued");
  const c1 = await h.pg.connect("kauro_app_test");
  const c2 = await h.pg.connect("kauro_app_test");
  try {
    await c2.query("SET application_name = 'kauro-test-n19-second'");
    for (const c of [c1, c2]) {
      await c.query("BEGIN");
      await bind(c, { agencyId: A.agencyId, userId: ned });
    }
    assert.equal((await new PgInvitationRepository(c1).consume(nIssued.invitation.invitationId, clock.now())).kind, "CLOSED");
    const second = new PgInvitationRepository(c2).consume(nIssued.invitation.invitationId, clock.now());
    await waitForLockWait(h.oracle, "kauro-test-n19-second", "UPDATE kauro.membership_invitations");
    await c1.query("COMMIT");
    assert.equal((await second).kind, "ALREADY_CLOSED");
    await c2.query("ROLLBACK");
  } finally {
    await c1.end();
    await c2.end();
  }
});
