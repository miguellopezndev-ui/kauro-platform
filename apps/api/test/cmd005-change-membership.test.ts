// CMD005 ChangeMembership — POST /api/v1/memberships/{membershipId}/capabilities — AGENCY_OWNER with a fresh step-up (registry cases
// CMD005-OK / -DENY / -RACE; docs/design/B16-team-commands.md D-TEAM-4; 08 "Granting a capability is itself an owner action with audit evidence").
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

const change = async (membershipId: string, body: Record<string, unknown>, opts: { token?: string; key?: string; proof?: boolean } = {}) =>
  call(w, {
    url: routes.changeMembership(membershipId),
    token: opts.token ?? w.owner.token,
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    body: opts.proof === false ? body : { assuranceProofRef: await w.stepUp(w.owner), ...body },
  });

const versionOf = async (membershipId: string) => Number((await w.row<{ version: string }>("memberships", "membership_id = $1", [membershipId]))?.version);
const roleOf = async (membershipId: string) => (await w.row<{ role: string }>("memberships", "membership_id = $1", [membershipId]))?.role;

test("OK: the OWNER changes a role with a fresh step-up; version moves, the event and the ALLOW fact are written, and the old authority ends at the next command", async () => {
  const m = await activePerson(w, "cmd005-ok", "ADMIN");
  const person = await w.person("cmd005-ok-target");
  // as ADMIN the member can invite
  const before = await call(w, { url: routes.inviteMember(w.A.agencyId), token: m.person.token, body: { expectedVersion: 1, intendedIdentityRef: person.userId, role: "VIEWER" } });
  assert.equal(before.status, 201, before.text);
  const key = freshKey("cmd005-ok");
  const version = await versionOf(m.membershipId);
  const done = completed<MembershipView>(await change(m.membershipId, { expectedVersion: version, role: "VIEWER" }, { key }), 200);
  assert.deepEqual([done.data.role, done.data.state, done.data.version, done.replayed], ["VIEWER", "ACTIVE", version + 1, false]);
  assert.equal(await roleOf(m.membershipId), "VIEWER");
  const events = await w.events("membership", m.membershipId);
  assert.equal(events.at(-1)?.type, "membership.role_changed.v1");
  assert.equal(events.at(-1)?.payload["role"], "VIEWER");
  assert.equal(events.at(-1)?.payload["previousRole"], "ADMIN");
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, id: journal.resourceId }, { state: "COMMITTED", status: 200, id: m.membershipId });
  assert.ok((await w.securityEvents("CMD005")).some((f) => f.outcome === "ALLOW" && f.reason === "ROLE_CHANGED" && f.agencyId === w.A.agencyId && f.actorId === w.owner.userId));
  // revocation of the authority is visible on the very next command
  const after = await call(w, { url: routes.inviteMember(w.A.agencyId), token: m.person.token, body: { expectedVersion: 1, intendedIdentityRef: (await w.person("cmd005-ok-late")).userId, role: "VIEWER" } });
  assert.equal(outcome(w, after), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
});

test("DENY: non-owners → 403; missing/stale/foreign step-up → 403 ASSURANCE_REQUIRED; stale version, same role, INVITED target, last owner, unknown role, foreign membership are typed; nothing changes", async () => {
  const m = await activePerson(w, "cmd005-deny", "OPERATOR");
  const invited = await invitePerson(w, "cmd005-deny-inv", "VIEWER");
  const snap = async () => ({ n: await w.count("memberships"), events: await w.count("domain_events"), journal: await w.count("command_journal") });
  const v = await versionOf(m.membershipId);
  const before = await snap();
  for (const p of [w.admin, w.operator, w.approver, w.viewer, w.billing]) {
    assert.equal(outcome(w, await change(m.membershipId, { expectedVersion: v, role: "VIEWER" }, { token: p.token })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(outcome(w, await change(m.membershipId, { expectedVersion: v, role: "VIEWER", assuranceProofRef: await w.stepUp(w.owner, "STALE") }, { proof: false })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.equal(outcome(w, await change(m.membershipId, { expectedVersion: v, role: "VIEWER", assuranceProofRef: await w.stepUp(w.admin) }, { proof: false })), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  const stale = await change(m.membershipId, { expectedVersion: v + 5, role: "VIEWER" });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.equal(asProblem(w, stale).current?.version, v);
  assert.equal(outcome(w, await change(m.membershipId, { expectedVersion: v, role: "OPERATOR" })), "409 PRECONDITION_FAILED NO_SEMANTIC_CHANGE");
  assert.equal(outcome(w, await change(invited.membershipId, { expectedVersion: 1, role: "ADMIN" })), "409 PRECONDITION_FAILED MEMBERSHIP_NOT_ACTIVE");
  assert.equal(outcome(w, await change(w.memberships.owner, { expectedVersion: await versionOf(w.memberships.owner), role: "ADMIN" })), "409 PRECONDITION_FAILED LAST_OWNER_PROTECTED");
  const invented = await change(m.membershipId, { expectedVersion: v, role: "ROOT" });
  assert.equal(invented.status, 400, invented.text);
  assert.equal(outcome(w, await change(w.B.ownerMembershipId, { expectedVersion: 1, role: "ADMIN" })), "404 NOT_FOUND -");
  assert.equal(await roleOf(m.membershipId), "OPERATOR");
  assert.deepEqual(await snap(), before, "no refusal writes a membership, an event or a journal entry");
});

test("RACE: two changes with one expectedVersion → one 200, one STALE_VERSION; replay and same-key conflict; crash before COMMIT changes nothing; response lost after COMMIT is recovered; a revocation committed first makes the change refuse", async () => {
  const m = await activePerson(w, "cmd005-race", "OPERATOR");
  const v = await versionOf(m.membershipId);
  const keyA = freshKey("cmd005-a");
  const hold = w.holds.arm("journal.commit");
  const a = change(m.membershipId, { expectedVersion: v, role: "APPROVER" }, { key: keyA });
  await hold.reached;
  const b = change(m.membershipId, { expectedVersion: v, role: "VIEWER" }, { key: freshKey("cmd005-b") });
  try {
    await waitForApiLockWait(w, "FOR NO KEY UPDATE");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([a, b]);
  completed<MembershipView>(ra, 200);
  assert.equal(outcome(w, rb), "409 STALE_VERSION -");
  assert.equal(await roleOf(m.membershipId), "APPROVER");
  assert.equal((await w.events("membership", m.membershipId)).filter((e) => e.type === "membership.role_changed.v1").length, 1);
  // identical retry: the journaled answer (a fresh step-up proof is not part of the request identity? the digest covers the body, so reuse the proof)
  const proof = await w.stepUp(w.owner);
  const k2 = freshKey("cmd005-replay");
  const first = await call(w, { url: routes.changeMembership(m.membershipId), key: k2, body: { assuranceProofRef: proof, expectedVersion: v + 1, role: "BILLING" } });
  completed<MembershipView>(first, 200);
  const replay = await call(w, { url: routes.changeMembership(m.membershipId), key: k2, body: { assuranceProofRef: proof, expectedVersion: v + 1, role: "BILLING" } });
  assert.equal(replay.text, replayTextOf(first));
  const other = await call(w, { url: routes.changeMembership(m.membershipId), key: k2, body: { assuranceProofRef: proof, expectedVersion: v + 1, role: "VIEWER" } });
  assert.equal(outcome(w, other), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await roleOf(m.membershipId), "BILLING");

  // crash before COMMIT
  const c = await activePerson(w, "cmd005-crash", "OPERATOR");
  const cv = await versionOf(c.membershipId);
  const crashKey = freshKey("cmd005-crash");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await change(c.membershipId, { expectedVersion: cv, role: "VIEWER" }, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual([await roleOf(c.membershipId), await versionOf(c.membershipId), await w.journal(crashKey)], ["OPERATOR", cv, null]);
  assert.equal(completed<MembershipView>(await change(c.membershipId, { expectedVersion: cv, role: "VIEWER" }, { key: crashKey }), 200).replayed, false);

  // response lost after COMMIT: recover by the same key and the same proof
  const l = await activePerson(w, "cmd005-lost", "OPERATOR");
  const lv = await versionOf(l.membershipId);
  const lostKey = freshKey("cmd005-lost");
  const lostProof = await w.stepUp(w.owner);
  const lostBody = { assuranceProofRef: lostProof, expectedVersion: lv, role: "VIEWER" };
  w.holds.arm("after.commit", { fail: new SimulatedCrash("lost") });
  assert.equal(outcome(w, await call(w, { url: routes.changeMembership(l.membershipId), key: lostKey, body: lostBody })), "500 INTERNAL_ERROR -");
  assert.equal(await roleOf(l.membershipId), "VIEWER");
  const rec = completed<MembershipView>(await call(w, { url: routes.changeMembership(l.membershipId), key: lostKey, body: lostBody }), 200);
  assert.equal(rec.replayed, true);
  assert.equal(await versionOf(l.membershipId), lv + 1);

  // revocation first: the change finds the target REVOKED
  const r = await activePerson(w, "cmd005-revoked", "OPERATOR");
  const rv = await versionOf(r.membershipId);
  const revoked = await call(w, { url: routes.revokeMembership(r.membershipId), body: { expectedVersion: rv, reasonCode: "OFFBOARDED" } });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(outcome(w, await change(r.membershipId, { expectedVersion: rv + 1, role: "VIEWER" })), "409 PRECONDITION_FAILED MEMBERSHIP_NOT_ACTIVE");
});
