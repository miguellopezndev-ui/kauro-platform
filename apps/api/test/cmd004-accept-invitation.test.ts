// CMD004 AcceptInvitation — POST /api/v1/invitations/{invitationId}/accept — VERIFIED_USER (registry cases CMD004-OK / -DENY / -RACE;
// docs/design/B16-team-commands.md D-TEAM-2; 08 "Invitation, recovery and ownership transfer"). The invitee holds no membership yet:
// the route runs in the agency of the caller's OWN invitation, never in an agency the request names.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { MembershipView } from "@kauro/application";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, replayTextOf, rootCause, routes, waitForApiLockWait, world, type World } from "./support.js";
import { invitePerson, plantInvitation } from "./team-support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

const accept = (invitationId: string, token: string, who: { token: string }, key?: string) =>
  call(w, { url: routes.acceptInvitation(invitationId), token: who.token, agency: null, ...(key !== undefined ? { key } : {}), body: { invitationToken: token } });

test("OK: the invitee accepts with the token: the membership is ACTIVE at v2, the invitation consumed, the grant is a durable fact, and the new member acts in the agency", async () => {
  const inv = await invitePerson(w, "cmd004-ok", "OPERATOR");
  const key = freshKey("cmd004-ok");
  const done = completed<MembershipView>(await accept(inv.invitationId, inv.token, inv.person, key), 200);
  assert.equal(done.replayed, false);
  assert.deepEqual([done.data.membershipId, done.data.state, done.data.role, done.data.version], [inv.membershipId, "ACTIVE", "OPERATOR", 2]);
  const m = await w.row<{ state: string; version: string; accepted_at: Date | null }>("memberships", "membership_id = $1", [inv.membershipId]);
  assert.deepEqual(m && { state: m.state, version: m.version, accepted: m.accepted_at !== null }, { state: "ACTIVE", version: "2", accepted: true });
  const row = await w.row<{ consumed_at: Date | null; revoked_at: Date | null }>("membership_invitations", "invitation_id = $1", [inv.invitationId]);
  assert.deepEqual([row?.consumed_at !== null, row?.revoked_at], [true, null]);
  assert.deepEqual((await w.events("membership", inv.membershipId)).map((e) => [e.version, e.type]), [[1, "membership.invited.v1"], [2, "membership.accepted.v1"]]);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "membership", id: inv.membershipId });
  const facts = await w.securityEvents("CMD004");
  assert.deepEqual(facts.filter((f) => f.actorId === inv.person.userId).map((f) => [f.outcome, f.reason, f.agencyId]), [["ALLOW", "ACCESS_GRANTED", w.A.agencyId]]);
  // the grant is real: the new OPERATOR now passes the membership gate of agency A (creates a client)
  const created = await call(w, { url: routes.createClient(w.A.agencyId), token: inv.person.token, agency: null, body: { displayName: "By New Member", processingAuthorityRef: w.authorityA } });
  assert.equal(created.status, 201, created.text);
});

test("DENY: wrong token → 403 INVITATION_TOKEN_MISMATCH; another person's invitation and an unknown id answer the same 404; a malformed token → 400; an unverified identity is refused; a revoked invitation is closed; no state changes", async () => {
  const inv = await invitePerson(w, "cmd004-deny", "VIEWER");
  const other = await invitePerson(w, "cmd004-deny-other", "VIEWER");
  const snap = async () => ({ m: await w.row("memberships", "membership_id = $1", [inv.membershipId]), i: await w.row("membership_invitations", "invitation_id = $1", [inv.invitationId]), events: await w.count("domain_events") });
  const before = await snap();
  const wrong = await accept(inv.invitationId, "A".repeat(43), inv.person);
  assert.equal(wrong.status, 403, wrong.text);
  assert.equal(asProblem(w, wrong).reason, "INVITATION_TOKEN_MISMATCH");
  // someone else's invitation (valid token in hand) and an id that does not exist: byte-identical NOT_FOUND bodies
  const foreign = await accept(inv.invitationId, inv.token, other.person);
  const unknown = await accept("0198a1f0-0000-7000-8000-0000000000aa", inv.token, other.person);
  assert.equal(outcome(w, foreign), "404 NOT_FOUND -");
  assert.equal(outcome(w, unknown), "404 NOT_FOUND -");
  assert.deepEqual({ ...foreign.json<Record<string, unknown>>(), instance: undefined, correlationId: undefined }, { ...unknown.json<Record<string, unknown>>(), instance: undefined, correlationId: undefined });
  const malformed = await accept(inv.invitationId, "short", inv.person);
  assert.equal(malformed.status, 400, malformed.text);
  const unverifiedInv = await w.person("cmd004-unverified", { verified: false });
  const unverified = await accept(inv.invitationId, inv.token, unverifiedInv);
  assert.ok(unverified.status === 403 || unverified.status === 404, unverified.text);
  assert.deepEqual(await snap(), before, "no refusal wrote the membership, the invitation or an event");
  // the owner revokes the invitation (CMD006): the token no longer opens it
  const rev = await call(w, { url: routes.revokeMembership(inv.membershipId), body: { expectedVersion: 1, reasonCode: "WITHDRAWN" } });
  assert.equal(rev.status, 200, rev.text);
  const closed = await accept(inv.invitationId, inv.token, inv.person);
  assert.equal(outcome(w, closed), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
  assert.equal((await w.row<{ state: string }>("memberships", "membership_id = $1", [inv.membershipId]))?.state, "REVOKED");
});

test("RACE: identical retry replays; same key other body conflicts; two accepts of one invitation → one 200, the other refused 409; expiry is judged at the database clock after the membership lock wait; crash before COMMIT leaves INVITED and the key re-executes; response lost after COMMIT is recovered", async () => {
  // replay and same-key conflict
  const inv = await invitePerson(w, "cmd004-race", "VIEWER");
  const key = freshKey("cmd004-race");
  const first = await accept(inv.invitationId, inv.token, inv.person, key);
  completed<MembershipView>(first, 200);
  const replay = await accept(inv.invitationId, inv.token, inv.person, key);
  assert.equal(replay.text, replayTextOf(first));
  const other = await accept(inv.invitationId, "B".repeat(43), inv.person, key);
  assert.equal(outcome(w, other), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("domain_events", "aggregate_id = $1", [inv.membershipId]), 2);

  // two concurrent accepts (two keys): the second waits on the membership lock and finds the invitation consumed
  const dbl = await invitePerson(w, "cmd004-double", "VIEWER");
  const hold = w.holds.arm("journal.commit");
  const a = accept(dbl.invitationId, dbl.token, dbl.person, freshKey("cmd004-a"));
  await hold.reached;
  const b = accept(dbl.invitationId, dbl.token, dbl.person, freshKey("cmd004-b"));
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const replies = await Promise.all([a, b]);
  const ok = replies.filter((r) => r.status === 200);
  assert.equal(ok.length, 1, replies.map((r) => r.text).join(" / "));
  const lost = replies.find((r) => r.status !== 200)!;
  assert.equal(lost.status, 409, lost.text);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'membership.accepted.v1'", [dbl.membershipId]), 1);

  // expiry at the DB clock: the invitation is valid when the request arrives but expires while it waits on the membership lock
  const soon = await plantInvitation(w, "cmd004-expiry", 3000, "VIEWER");
  await w.h.oracle.query("BEGIN");
  try {
    await w.h.oracle.query("SELECT 1 FROM kauro.memberships WHERE membership_id = $1 FOR UPDATE", [soon.membershipId]);
    const waiting = accept(soon.invitationId, soon.token, soon.person, freshKey("cmd004-exp"));
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
    await new Promise((r) => setTimeout(r, 3500));
    await w.h.oracle.query("COMMIT");
    const expired = await waiting;
    assert.equal(outcome(w, expired), "409 PRECONDITION_FAILED INVITATION_EXPIRED");
  } finally {
    await w.h.oracle.query("ROLLBACK").catch(() => undefined);
  }
  assert.equal((await w.row<{ state: string }>("memberships", "membership_id = $1", [soon.membershipId]))?.state, "INVITED");

  // crash before COMMIT
  const c = await invitePerson(w, "cmd004-crash", "VIEWER");
  const crashKey = freshKey("cmd004-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await accept(c.invitationId, c.token, c.person, crashKey);
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.equal((await w.row<{ state: string }>("memberships", "membership_id = $1", [c.membershipId]))?.state, "INVITED");
  assert.equal((await w.row<{ consumed_at: Date | null }>("membership_invitations", "invitation_id = $1", [c.invitationId]))?.consumed_at, null);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(completed<MembershipView>(await accept(c.invitationId, c.token, c.person, crashKey), 200).replayed, false);

  // response lost after COMMIT
  const l = await invitePerson(w, "cmd004-lost", "VIEWER");
  const lostKey = freshKey("cmd004-lost");
  // the invitee-lookup unit of work of phase 1 commits first: pass it, then crash after the COMMIT of the command itself
  const lookup = w.holds.arm("after.commit");
  const lostReply = accept(l.invitationId, l.token, l.person, lostKey);
  await lookup.reached;
  w.holds.arm("after.commit", { fail: new SimulatedCrash("lost") });
  lookup.release();
  assert.equal(outcome(w, await lostReply), "500 INTERNAL_ERROR -");
  assert.equal((await w.row<{ state: string }>("memberships", "membership_id = $1", [l.membershipId]))?.state, "ACTIVE");
  const rec = completed<MembershipView>(await accept(l.invitationId, l.token, l.person, lostKey), 200);
  assert.equal(rec.replayed, true);
  assert.equal(rec.data.state, "ACTIVE");
});
