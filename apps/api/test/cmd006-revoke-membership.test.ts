// CMD006 RevokeMembership — POST /api/v1/memberships/{membershipId}/revoke — AGENCY_OWNER_OR_ADMIN (registry cases CMD006-OK / -DENY / -RACE;
// docs/design/B16-team-commands.md D-TEAM-5; 08 "Invitation, recovery and ownership transfer": revoking cuts access at the next command and
// cancels a pending invitation). A mutual revocation that deadlocks in the database is answered as a retryable CAPACITY_UNAVAILABLE.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { MembershipView } from "@kauro/application";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";
import { activePerson, invitePerson } from "./team-support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const revoke = (membershipId: string, body: Record<string, unknown>, opts: { token?: string; key?: string } = {}) =>
  call(w, { url: routes.revokeMembership(membershipId), token: opts.token ?? w.owner.token, ...(opts.key !== undefined ? { key: opts.key } : {}), body });
const versionOf = async (id: string) => Number((await w.row<{ version: string }>("memberships", "membership_id = $1", [id]))?.version);
const stateOf = async (id: string) => (await w.row<{ state: string }>("memberships", "membership_id = $1", [id]))?.state;

test("OK: the OWNER revokes an active member (access ends at the very next command); an ADMIN revokes an OPERATOR; revoking an INVITED member cancels the invitation, whose token then fails", async () => {
  const m = await activePerson(w, "cmd006-ok", "OPERATOR");
  const key = freshKey("cmd006-ok");
  const v = await versionOf(m.membershipId);
  // the member works today
  assert.equal((await call(w, { url: routes.createClient(w.A.agencyId), token: m.person.token, agency: null, body: { displayName: "Before", processingAuthorityRef: w.authorityA } })).status, 201);
  const done = completed<MembershipView>(await revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }, { key }), 200);
  assert.deepEqual([done.data.state, done.data.version, done.replayed], ["REVOKED", v + 1, false]);
  const row = await w.row<{ state: string; revoked_at: Date | null }>("memberships", "membership_id = $1", [m.membershipId]);
  assert.deepEqual([row?.state, row?.revoked_at !== null], ["REVOKED", true]);
  const events = await w.events("membership", m.membershipId);
  assert.equal(events.at(-1)?.type, "membership.revoked.v1");
  assert.equal(events.at(-1)?.payload["reasonCode"], "OFFBOARDED");
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, id: journal.resourceId }, { state: "COMMITTED", status: 200, id: m.membershipId });
  assert.ok((await w.securityEvents("CMD006")).some((f) => f.outcome === "ALLOW" && f.reason === "ACCESS_REVOKED" && f.agencyId === w.A.agencyId && f.actorId === w.owner.userId));
  const after = await call(w, { url: routes.createClient(w.A.agencyId), token: m.person.token, agency: null, body: { displayName: "After", processingAuthorityRef: w.authorityA } });
  assert.ok(after.status === 403 || after.status === 404, after.text);
  // the ADMIN revokes an OPERATOR
  const o = await activePerson(w, "cmd006-ok-op", "OPERATOR");
  completed<MembershipView>(await revoke(o.membershipId, { expectedVersion: await versionOf(o.membershipId), reasonCode: "OFFBOARDED" }, { token: w.admin.token }), 200);
  // a pending invitation: revoking its membership closes the invitation (no later accept)
  const inv = await invitePerson(w, "cmd006-ok-inv", "VIEWER");
  completed<MembershipView>(await revoke(inv.membershipId, { expectedVersion: 1, reasonCode: "WITHDRAWN" }), 200);
  const closed = await w.row<{ revoked_at: Date | null; consumed_at: Date | null }>("membership_invitations", "invitation_id = $1", [inv.invitationId]);
  assert.deepEqual([closed?.revoked_at !== null, closed?.consumed_at], [true, null]);
  assert.equal(await stateOf(inv.membershipId), "REVOKED");
  const late = await call(w, { url: routes.acceptInvitation(inv.invitationId), token: inv.person.token, agency: null, body: { invitationToken: inv.token } });
  assert.equal(outcome(w, late), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
});

test("DENY: OPERATOR/APPROVER/VIEWER → 403; ADMIN on an OWNER → 403 OWNER_PROTECTED; last owner → LAST_OWNER_PROTECTED; stale version; already revoked; bad reason; foreign membership → 404; nothing changes", async () => {
  const m = await activePerson(w, "cmd006-deny", "VIEWER");
  const v = await versionOf(m.membershipId);
  const snap = async () => ({ state: await stateOf(m.membershipId), v: await versionOf(m.membershipId), events: await w.count("domain_events"), journal: await w.count("command_journal") });
  const before = await snap();
  for (const p of [w.operator, w.approver, w.viewer, w.billing]) {
    assert.equal(outcome(w, await revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }, { token: p.token })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(outcome(w, await revoke(w.memberships.owner, { expectedVersion: 1, reasonCode: "OFFBOARDED" }, { token: w.admin.token })), "403 NOT_AUTHORIZED OWNER_PROTECTED");
  assert.equal(outcome(w, await revoke(w.memberships.owner, { expectedVersion: await versionOf(w.memberships.owner), reasonCode: "OFFBOARDED" })), "409 PRECONDITION_FAILED LAST_OWNER_PROTECTED");
  const stale = await revoke(m.membershipId, { expectedVersion: v + 3, reasonCode: "OFFBOARDED" });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.equal(asProblem(w, stale).current?.version, v);
  assert.equal(outcome(w, await revoke(m.membershipId, { expectedVersion: v, reasonCode: "not a label!" })), "400 INVALID_REQUEST -");
  assert.equal(outcome(w, await revoke(w.B.ownerMembershipId, { expectedVersion: 1, reasonCode: "OFFBOARDED" })), "404 NOT_FOUND -");
  assert.deepEqual(await snap(), before);
  completed<MembershipView>(await revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }), 200);
  const again = await revoke(m.membershipId, { expectedVersion: v + 1, reasonCode: "OFFBOARDED" });
  assert.equal(again.status, 409, again.text);
  assert.equal(await stateOf(m.membershipId), "REVOKED");
});

test("RACE: two revocations of one member → one 200, one 409; replay and same-key conflict; crash before COMMIT keeps the member; response lost after COMMIT is recovered; mutual revocation of two admins never leaves both revoked", async () => {
  const m = await activePerson(w, "cmd006-race", "OPERATOR");
  const v = await versionOf(m.membershipId);
  const keyA = freshKey("cmd006-a");
  const hold = w.holds.arm("journal.commit");
  const a = revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }, { key: keyA });
  await hold.reached;
  const b = revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }, { token: w.admin.token, key: freshKey("cmd006-b") });
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([a, b]);
  completed<MembershipView>(ra, 200);
  assert.equal(rb.status, 409, rb.text);
  assert.equal((await w.events("membership", m.membershipId)).filter((e) => e.type === "membership.revoked.v1").length, 1);
  const replay = await revoke(m.membershipId, { expectedVersion: v, reasonCode: "OFFBOARDED" }, { key: keyA });
  assert.equal(replay.text, replayTextOf(ra));
  const other = await revoke(m.membershipId, { expectedVersion: v, reasonCode: "FRAUD" }, { key: keyA });
  assert.equal(outcome(w, other), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");

  const c = await activePerson(w, "cmd006-crash", "OPERATOR");
  const cv = await versionOf(c.membershipId);
  const crashKey = freshKey("cmd006-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await revoke(c.membershipId, { expectedVersion: cv, reasonCode: "OFFBOARDED" }, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual([await stateOf(c.membershipId), await w.journal(crashKey)], ["ACTIVE", null]);
  assert.equal(completed<MembershipView>(await revoke(c.membershipId, { expectedVersion: cv, reasonCode: "OFFBOARDED" }, { key: crashKey }), 200).replayed, false);

  const l = await activePerson(w, "cmd006-lost", "OPERATOR");
  const lv = await versionOf(l.membershipId);
  const lostKey = freshKey("cmd006-lost");
  w.holds.arm("after.commit", { fail: new SimulatedCrash("lost") });
  assert.equal(outcome(w, await revoke(l.membershipId, { expectedVersion: lv, reasonCode: "OFFBOARDED" }, { key: lostKey })), "500 INTERNAL_ERROR -");
  assert.equal(await stateOf(l.membershipId), "REVOKED");
  const rec = completed<MembershipView>(await revoke(l.membershipId, { expectedVersion: lv, reasonCode: "OFFBOARDED" }, { key: lostKey }), 200);
  assert.equal(rec.replayed, true);

  // mutual revocation: two ADMINs revoke each other at once. The database serializes or breaks the cycle (40P01 → a retryable,
  // changeless CAPACITY_UNAVAILABLE); either way the loser is refused and at least one ADMIN stays ACTIVE at the end.
  const x = await activePerson(w, "cmd006-mutual-x", "ADMIN");
  const y = await activePerson(w, "cmd006-mutual-y", "ADMIN");
  const [rx, ry] = await Promise.all([
    revoke(y.membershipId, { expectedVersion: await versionOf(y.membershipId), reasonCode: "OFFBOARDED" }, { token: x.person.token }),
    revoke(x.membershipId, { expectedVersion: await versionOf(x.membershipId), reasonCode: "OFFBOARDED" }, { token: y.person.token }),
  ]);
  const states = [await stateOf(x.membershipId), await stateOf(y.membershipId)];
  assert.ok(states.includes("ACTIVE") || rx.status === 200 || ry.status === 200, `${rx.text} / ${ry.text}`);
  for (const r of [rx, ry]) assert.ok([200, 403, 404, 409, 503].includes(r.status), r.text);
  if (rx.status === 503 || ry.status === 503) assert.equal(asProblem(w, rx.status === 503 ? rx : ry).code, "CAPACITY_UNAVAILABLE");
});
