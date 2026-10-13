// CMD003 InviteMember — POST /api/v1/agencies/{agencyId}/invitations — AGENCY_OWNER_OR_ADMIN (registry cases CMD003-OK / -DENY / -RACE;
// docs/design/B16-team-commands.md D-TEAM-1..3; 08 "Invitation, recovery and ownership transfer": one-use, time-limited, hashed tokens).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { InviteMemberView } from "@kauro/application";
import { SimulatedCrash, deliveredInvitations, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";
import { activePerson, agencyVersion, suspendMember, refusalOf, tokenOf, type Issued } from "./team-support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

test("OK: the OWNER invites an identity; the raw token goes to the delivery channel once and never into the response; the database holds only its SHA-256, an INVITED membership, the event and an expiry seven days out", async () => {
  const person = await w.person("cmd003-ok");
  const key = freshKey("cmd003-ok");
  const before = await w.count("memberships", "agency_id = $1", [w.A.agencyId]);
  const reply = await call(w, { url: routes.inviteMember(w.A.agencyId), key, body: { expectedVersion: await agencyVersion(w), intendedIdentityRef: person.userId, role: "OPERATOR" } });
  const done = completed<Issued>(reply, 201);
  const rawToken = tokenOf(done.data.invitationId);
  assert.equal(JSON.stringify(reply.json()).includes(rawToken), false, "the raw token is not in the response");
  assert.equal(done.replayed, false);
  assert.equal(done.data.state, "INVITED");
  assert.equal(done.data.role, "OPERATOR");
  assert.equal(done.data.version, 1);
  assert.match(rawToken, /^[A-Za-z0-9_-]{32,}$/);
  // oracle: membership INVITED v1 for the intended identity; invitation open; only the digest of the token is stored
  const m = await w.row<{ state: string; version: string; user_id: string; role: string }>("memberships", "membership_id = $1", [done.data.membershipId]);
  assert.deepEqual(m && { state: m.state, version: m.version, user: m.user_id, role: m.role }, { state: "INVITED", version: "1", user: person.userId, role: "OPERATOR" });
  assert.equal(await w.count("memberships", "agency_id = $1", [w.A.agencyId]), before + 1);
  const inv = await w.row<{ token_hash: string; expires_at: Date; created_at: Date; consumed_at: Date | null; revoked_at: Date | null; invited_by_membership_id: string }>("membership_invitations", "invitation_id = $1", [done.data.invitationId]);
  assert.equal(inv?.token_hash, createHash("sha256").update(rawToken).digest("hex"));
  assert.equal(inv!.expires_at.getTime() - inv!.created_at.getTime(), 7 * 24 * 3_600_000);
  assert.deepEqual([inv?.consumed_at, inv?.revoked_at, inv?.invited_by_membership_id], [null, null, w.memberships.owner]);
  assert.equal(new Date(done.data.expiresAt).getTime(), inv!.expires_at.getTime());
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.membership_invitations WHERE token_hash = $1", [rawToken])).rowCount, 0);
  const events = await w.events("membership", done.data.membershipId);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, "membership.invited.v1"]]);
  // the raw token reaches no durable place: not the journal, not the event payload
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "membership", id: done.data.membershipId });
  assert.equal(JSON.stringify(journal?.body).includes(rawToken), false);
  assert.equal(JSON.stringify(events).includes(rawToken), false);
  // an ADMIN may invite below OWNER too
  const second = await w.person("cmd003-ok-admin");
  completed<Issued>(await call(w, { url: routes.inviteMember(w.A.agencyId), token: w.admin.token, body: { expectedVersion: await agencyVersion(w), intendedIdentityRef: second.userId, role: "VIEWER" } }), 201);
});

test("DENY: OPERATOR/APPROVER/VIEWER/BILLING → 403; ADMIN granting OWNER → 403 ROLE_NOT_GRANTABLE; self, live member, bad role, foreign agency, stale version are typed; no state, no journal row", async () => {
  const person = await w.person("cmd003-deny");
  const fresh = async () => ({ expectedVersion: await agencyVersion(w), intendedIdentityRef: person.userId, role: "OPERATOR" });
  const snap = async () => ({ memberships: await w.count("memberships"), invitations: await w.count("membership_invitations"), journal: await w.count("command_journal"), events: await w.count("domain_events") });
  const before = await snap();
  const denialsBefore = (await w.securityEvents("CMD003")).length;
  for (const p of [w.operator, w.approver, w.viewer, w.billing]) {
    const refused = await call(w, { url: routes.inviteMember(w.A.agencyId), token: p.token, body: await fresh() });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refusalOf(w, refused), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(refusalOf(w, await call(w, { url: routes.inviteMember(w.A.agencyId), token: w.admin.token, body: { ...(await fresh()), role: "OWNER" } })), "403 NOT_AUTHORIZED ROLE_NOT_GRANTABLE");
  // a stranger (owner of B) naming A's path under B's selector: the path agency is not the selected one
  assert.equal(refusalOf(w, await call(w, { url: routes.inviteMember(w.A.agencyId), token: w.stranger.token, body: await fresh() })).startsWith("404 NOT_FOUND"), true);
  // domain refusals
  assert.equal(refusalOf(w, await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), intendedIdentityRef: w.owner.userId } })), "409 PRECONDITION_FAILED SELF_TARGET");
  assert.equal(refusalOf(w, await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), intendedIdentityRef: w.viewer.userId } })), "409 PRECONDITION_FAILED MEMBER_ALREADY_LIVE");
  assert.equal(refusalOf(w, await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), intendedIdentityRef: w.invited.userId } })), "409 PRECONDITION_FAILED MEMBER_ALREADY_LIVE");
  const badRole = await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), role: "SUPERUSER" } });
  assert.equal(badRole.status, 400, badRole.text);
  const stale = await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), expectedVersion: 99 } });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.equal(asProblem(w, stale).current?.version, await agencyVersion(w));
  // closed schema: a token member is not a request member
  const extra = await call(w, { url: routes.inviteMember(w.A.agencyId), body: { ...(await fresh()), invitationToken: "x".repeat(32) } });
  assert.equal(extra.status, 400, extra.text);
  assert.deepEqual(await snap(), before, "no membership, invitation, event or journal row from any refusal");
  assert.ok((await w.securityEvents("CMD003")).slice(denialsBefore).every((d) => d.outcome === "DENY"));
});

test("RACE: lock wait on the agency; identical retry replays WITHOUT the token; same key other body conflicts; two concurrent invitations of one identity → one 201 and one MEMBER_ALREADY_LIVE; crash before COMMIT leaves nothing and the key re-executes; response lost after COMMIT is recovered without a token", async () => {
  const person = await w.person("cmd003-race");
  const keyA = freshKey("cmd003-race-a");
  const keyB = freshKey("cmd003-race-b");
  const bodyA = { expectedVersion: await agencyVersion(w), intendedIdentityRef: person.userId, role: "OPERATOR" };
  const hold = w.holds.arm("journal.commit");
  const requestA = call(w, { url: routes.inviteMember(w.A.agencyId), key: keyA, body: bodyA });
  await hold.reached;
  const requestB = call(w, { url: routes.inviteMember(w.A.agencyId), token: w.admin.token, key: keyB, body: bodyA });
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const winners = [a, b].filter((r) => r.status === 201);
  assert.equal(winners.length, 1, `${a.text} / ${b.text}`);
  const loser = [a, b].find((r) => r.status !== 201)!;
  assert.equal(outcome(w, loser), "409 PRECONDITION_FAILED MEMBER_ALREADY_LIVE");
  const win = completed<Issued>(winners[0]!, 201);
  const winToken = tokenOf(win.data.invitationId);
  assert.equal(await w.count("memberships", "agency_id = $1 AND user_id = $2", [w.A.agencyId, person.userId]), 1);
  assert.equal(await w.count("membership_invitations", "membership_id = $1", [win.data.membershipId]), 1);
  const winnerKey = winners[0] === a ? keyA : keyB;
  const winnerToken = winners[0] === a ? w.owner.token : w.admin.token;
  assert.equal(await w.journal(winnerKey === keyA ? keyB : keyA), null);

  // identical retry: the journaled 201 without the token (D-TEAM-1) and no second invitation
  const replay = await call(w, { url: routes.inviteMember(w.A.agencyId), token: winnerToken, key: winnerKey, body: bodyA });
  assert.equal(replay.status, 201);
  const replayed = completed<InviteMemberView>(replay, 201);
  assert.equal(replayed.replayed, true);
  assert.equal(replay.text.includes(winToken), false);
  assert.equal(replayTextOf(winners[0]!).includes(winToken), false, "the first answer did not carry it either");
  assert.equal([...deliveredInvitations.values()].filter((t) => t === winToken).length, 1, "delivered exactly once");
  assert.equal(await w.count("membership_invitations", "membership_id = $1", [win.data.membershipId]), 1);
  const conflict = await call(w, { url: routes.inviteMember(w.A.agencyId), token: winnerToken, key: winnerKey, body: { ...bodyA, role: "VIEWER" } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  // crash before COMMIT: nothing durable, the key is then a first execution
  const crashee = await w.person("cmd003-crash");
  const crashKey = freshKey("cmd003-crash");
  const cb = { expectedVersion: await agencyVersion(w), intendedIdentityRef: crashee.userId, role: "VIEWER" };
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.inviteMember(w.A.agencyId), key: crashKey, body: cb });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal(await w.count("memberships", "user_id = $1", [crashee.userId]), 0);
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<Issued>(await call(w, { url: routes.inviteMember(w.A.agencyId), key: crashKey, body: cb }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("memberships", "user_id = $1", [crashee.userId]), 1);

  // response lost after COMMIT: durable; the retry replays the journaled answer, which has no token (revoke and reissue is the recovery)
  const lostPerson = await w.person("cmd003-lost");
  const lostKey = freshKey("cmd003-lost");
  const lb = { expectedVersion: await agencyVersion(w), intendedIdentityRef: lostPerson.userId, role: "VIEWER" };
  w.holds.arm("after.commit", { fail: new SimulatedCrash("response lost after COMMIT") });
  const lost = await call(w, { url: routes.inviteMember(w.A.agencyId), key: lostKey, body: lb });
  assert.equal(outcome(w, lost), "500 INTERNAL_ERROR -");
  assert.equal(await w.count("memberships", "user_id = $1", [lostPerson.userId]), 1);
  const rec = completed<InviteMemberView>(await call(w, { url: routes.inviteMember(w.A.agencyId), key: lostKey, body: lb }), 201);
  assert.equal(rec.replayed, true);
  assert.equal(deliveredInvitations.has(rec.data.invitationId), false, "a crash after COMMIT happens before the delivery and a replay never delivers: the recovery is revoke and reissue (D-TEAM-1)");
  assert.equal(await w.count("memberships", "user_id = $1", [lostPerson.userId]), 1);
});

test("RACE (revocation): an ADMIN suspended before the call is refused at the next command; nothing is written", async () => {
  const mgr = await activePerson(w, "cmd003-mgr", "ADMIN");
  const person = await w.person("cmd003-rev");
  await suspendMember(w, mgr.membershipId);
  const reply = await call(w, { url: routes.inviteMember(w.A.agencyId), token: mgr.person.token, body: { expectedVersion: await agencyVersion(w), intendedIdentityRef: person.userId, role: "VIEWER" } });
  assert.equal(reply.status, 403, reply.text);
  assert.equal(await w.count("memberships", "user_id = $1", [person.userId]), 0);
});
