// CMD007 TransferOwnership — POST /api/v1/agencies/{agencyId}/ownership-transfers — AGENCY_OWNER with a fresh step-up (registry cases
// CMD007-OK / -DENY / -RACE; docs/design/B16-team-commands.md D-TEAM-6; 08 "Invitation, recovery and ownership transfer": the successor is an
// ACTIVE, verified member; there is never an instant with no owner). Every test builds its own agency: a transfer changes who owns it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { TransferOwnershipView } from "@kauro/application";
import type { AgencyFixture } from "@kauro/persistence/testing";
import { suspendMember } from "./team-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, outcome, rootCause, routes, waitForApiLockWait, world, type Person, type World } from "./support.js";

let w: World;
before(async () => {
  w = await world();
});
after(async () => {
  await w.stop();
});

interface Firm {
  readonly agency: AgencyFixture;
  readonly owner: Person;
  readonly successors: ReadonlyArray<{ person: Person; membershipId: string }>;
}

let n = 0;
async function firm(successorRoles: ReadonlyArray<"ADMIN" | "OPERATOR"> = ["ADMIN", "ADMIN"]): Promise<Firm> {
  n += 1;
  const owner = await w.person(`cmd007-owner-${n}`);
  const agency = await w.h.createAgency(owner.userId, `Transfer ${n}`);
  const successors = [] as Array<{ person: Person; membershipId: string }>;
  for (const [i, role] of successorRoles.entries()) {
    const person = await w.person(`cmd007-s${n}-${i}`);
    successors.push({ person, membershipId: await w.h.addMember(agency, person.userId, role) });
  }
  return { agency, owner, successors };
}

const versionOf = async (agencyId: string) => Number((await w.row<{ version: string }>("agencies", "agency_id = $1", [agencyId]))?.version);
const roleOf = async (membershipId: string) => (await w.row<{ role: string }>("memberships", "membership_id = $1", [membershipId]))?.role;
const ownerCount = async (agencyId: string) => Number((await w.row<{ active_owner_count: string }>("agencies", "agency_id = $1", [agencyId]))?.active_owner_count);

async function transfer(f: Firm, newOwnerMembershipId: string, opts: { token?: string; key?: string; expectedVersion?: number; proof?: string | null; as?: Person } = {}) {
  const who = opts.as ?? f.owner;
  const proof = opts.proof === undefined ? await w.stepUp(who) : opts.proof;
  return call(w, {
    url: routes.transferOwnership(f.agency.agencyId),
    token: opts.token ?? who.token,
    agency: f.agency.agencyId,
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    body: { expectedVersion: opts.expectedVersion ?? (await versionOf(f.agency.agencyId)), newOwnerMembershipId, ...(proof !== null ? { assuranceProofRef: proof } : {}) },
  });
}

test("OK: the OWNER transfers ownership to an ACTIVE member with a fresh step-up; the roles swap in one commit, the agency version moves, and the old owner's authority ends at the next command", async () => {
  const f = await firm();
  const successor = f.successors[0]!;
  const key = freshKey("cmd007-ok");
  const v = await versionOf(f.agency.agencyId);
  const done = completed<TransferOwnershipView>(await transfer(f, successor.membershipId, { key }), 200);
  assert.equal(done.replayed, false);
  assert.equal(done.data.newOwner.membershipId, successor.membershipId);
  assert.deepEqual([done.data.newOwner.role, done.data.previousOwner.role, done.data.previousOwner.membershipId], ["OWNER", "ADMIN", f.agency.ownerMembershipId]);
  assert.equal(done.data.agency.version, v + 1);
  assert.deepEqual([await roleOf(successor.membershipId), await roleOf(f.agency.ownerMembershipId), await ownerCount(f.agency.agencyId)], ["OWNER", "ADMIN", 1]);
  assert.deepEqual((await w.events("agency", f.agency.agencyId)).at(-1)?.type, "agency.ownership_transferred.v1");
  assert.equal((await w.events("membership", successor.membershipId)).at(-1)?.type, "membership.role_changed.v1");
  assert.equal((await w.events("membership", f.agency.ownerMembershipId)).at(-1)?.type, "membership.role_changed.v1");
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "agency", id: f.agency.agencyId });
  assert.ok((await w.securityEvents("CMD007")).some((x) => x.outcome === "ALLOW" && x.reason === "OWNERSHIP_TRANSFERRED" && x.agencyId === f.agency.agencyId && x.actorId === f.owner.userId));
  // the previous owner can no longer do an owner action; the new owner can
  const old = await transfer(f, successor.membershipId, { token: f.owner.token });
  assert.equal(outcome(w, old), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  const back = completed<TransferOwnershipView>(await transfer(f, f.agency.ownerMembershipId, { as: successor.person }), 200);
  assert.equal(back.data.newOwner.membershipId, f.agency.ownerMembershipId);
  assert.equal(await ownerCount(f.agency.agencyId), 1);
});

test("DENY: non-owner → 403; missing/stale/foreign step-up → 403 ASSURANCE_REQUIRED; self, SUSPENDED, INVITED and REVOKED successors, stale version and foreign membership are typed; nothing changes", async () => {
  const f = await firm(["ADMIN", "OPERATOR", "OPERATOR"]);
  const [admin, suspendee, revokee] = f.successors as [Firm["successors"][number], Firm["successors"][number], Firm["successors"][number]];
  const invitee = await w.person("cmd007-invitee");
  const invited = await w.h.inviteMember(f.agency, invitee.userId, "VIEWER");
  await suspendMember(w, suspendee.membershipId, { agencyId: f.agency.agencyId, ownerUserId: f.owner.userId, ownerMembershipId: f.agency.ownerMembershipId });
  const revokedReply = await call(w, { url: routes.revokeMembership(revokee.membershipId), token: f.owner.token, agency: f.agency.agencyId, body: { expectedVersion: Number((await w.row<{ version: string }>("memberships", "membership_id = $1", [revokee.membershipId]))?.version), reasonCode: "OFFBOARDED" } });
  assert.equal(revokedReply.status, 200, revokedReply.text);
  const snap = async () => ({ roles: [await roleOf(f.agency.ownerMembershipId), await roleOf(admin.membershipId)], v: await versionOf(f.agency.agencyId), count: await ownerCount(f.agency.agencyId), events: await w.count("domain_events"), journal: await w.count("command_journal") });
  const before = await snap();
  assert.equal(outcome(w, await transfer(f, admin.membershipId, { as: admin.person })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await transfer(f, admin.membershipId, { proof: null })), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.equal(outcome(w, await transfer(f, admin.membershipId, { proof: await w.stepUp(f.owner, "STALE") })), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.equal(outcome(w, await transfer(f, admin.membershipId, { proof: await w.stepUp(admin.person) })), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  assert.equal(outcome(w, await transfer(f, f.agency.ownerMembershipId)), "409 PRECONDITION_FAILED SELF_TARGET");
  assert.equal(outcome(w, await transfer(f, invited.membershipId)), "409 PRECONDITION_FAILED RECIPIENT_NOT_ACTIVE");
  const stale = await transfer(f, admin.membershipId, { expectedVersion: before.v + 4 });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.equal(asProblem(w, stale).current?.version, before.v);
  assert.equal(outcome(w, await transfer(f, w.memberships.operator)), "404 NOT_FOUND -");
  assert.equal((await transfer(f, "not-an-id")).status, 400);
  assert.equal(outcome(w, await transfer(f, suspendee.membershipId)), "409 PRECONDITION_FAILED RECIPIENT_NOT_ACTIVE");
  assert.equal(outcome(w, await transfer(f, revokee.membershipId)), "409 PRECONDITION_FAILED RECIPIENT_NOT_ACTIVE");
  assert.deepEqual(await snap(), before);
});

test("RACE: two transfers at once → exactly one wins and the agency keeps exactly one owner; replay and same-key conflict; crash before COMMIT keeps the owner; response lost after COMMIT leaves the transfer durable (the former owner then reads state, a retry is refused); a successor revoked first is refused", async () => {
  const f = await firm();
  const [s1, s2] = f.successors as [Firm["successors"][number], Firm["successors"][number]];
  const v = await versionOf(f.agency.agencyId);
  const keyA = freshKey("cmd007-a");
  const proofA = await w.stepUp(f.owner);
  const proofB = await w.stepUp(f.owner);
  const hold = w.holds.arm("journal.commit");
  const a = transfer(f, s1.membershipId, { key: keyA, expectedVersion: v, proof: proofA });
  await hold.reached;
  const b = transfer(f, s2.membershipId, { key: freshKey("cmd007-b"), expectedVersion: v, proof: proofB });
  try {
    await waitForApiLockWait(w, "await_transition");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([a, b]);
  const done = completed<TransferOwnershipView>(ra, 200);
  assert.ok(rb.status === 409 || rb.status === 403, rb.text);
  assert.deepEqual([await roleOf(s1.membershipId), await roleOf(s2.membershipId), await roleOf(f.agency.ownerMembershipId), await ownerCount(f.agency.agencyId)], ["OWNER", "ADMIN", "ADMIN", 1]);
  assert.equal((await w.events("agency", f.agency.agencyId)).filter((e) => e.type === "agency.ownership_transferred.v1").length, 1);
  assert.equal(done.data.newOwner.membershipId, s1.membershipId);
  const replay = await call(w, { url: routes.transferOwnership(f.agency.agencyId), token: f.owner.token, agency: f.agency.agencyId, key: keyA, body: { expectedVersion: v, newOwnerMembershipId: s1.membershipId, assuranceProofRef: proofA } });
  // authorization precedes the journal: the replay of a transfer by the now-former owner is refused, and has no effect
  assert.equal(outcome(w, replay), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  const other = await call(w, { url: routes.transferOwnership(f.agency.agencyId), token: f.owner.token, agency: f.agency.agencyId, key: keyA, body: { expectedVersion: v, newOwnerMembershipId: s2.membershipId, assuranceProofRef: proofA } });
  assert.equal(outcome(w, other), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(await ownerCount(f.agency.agencyId), 1);

  // crash before COMMIT: the owner stays
  const c = await firm();
  const crashKey = freshKey("cmd007-crash");
  const cproof = await w.stepUp(c.owner);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(w, await transfer(c, c.successors[0]!.membershipId, { key: crashKey, proof: cproof })), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  assert.deepEqual([await roleOf(c.agency.ownerMembershipId), await roleOf(c.successors[0]!.membershipId), await ownerCount(c.agency.agencyId), await w.journal(crashKey)], ["OWNER", "ADMIN", 1, null]);
  assert.equal(completed<TransferOwnershipView>(await transfer(c, c.successors[0]!.membershipId, { key: crashKey, proof: cproof }), 200).replayed, false);

  // response lost after COMMIT
  const l = await firm();
  const lostKey = freshKey("cmd007-lost");
  const lproof = await w.stepUp(l.owner);
  const lv = await versionOf(l.agency.agencyId);
  w.holds.arm("after.commit", { fail: new SimulatedCrash("lost") });
  assert.equal(outcome(w, await transfer(l, l.successors[0]!.membershipId, { key: lostKey, proof: lproof, expectedVersion: lv })), "500 INTERNAL_ERROR -");
  assert.equal(await roleOf(l.successors[0]!.membershipId), "OWNER");
  // the caller lost the owner role with that commit: the same key answers 403 (authorization precedes the journal) and changes nothing; the transfer is read back, not repeated
  const rec = await transfer(l, l.successors[0]!.membershipId, { key: lostKey, proof: lproof, expectedVersion: lv });
  assert.equal(outcome(w, rec), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal((await w.events("agency", l.agency.agencyId)).filter((e) => e.type === "agency.ownership_transferred.v1").length, 1);
  assert.equal(await ownerCount(l.agency.agencyId), 1);

  // the successor revoked first (CMD006 committed): the transfer is refused and no owner changes
  const r = await firm();
  const target = r.successors[0]!;
  const rv = Number((await w.row<{ version: string }>("memberships", "membership_id = $1", [target.membershipId]))?.version);
  const revoked = await call(w, { url: routes.revokeMembership(target.membershipId), token: r.owner.token, agency: r.agency.agencyId, body: { expectedVersion: rv, reasonCode: "OFFBOARDED" } });
  assert.equal(revoked.status, 200, revoked.text);
  assert.equal(outcome(w, await transfer(r, target.membershipId)), "409 PRECONDITION_FAILED RECIPIENT_NOT_ACTIVE");
  assert.deepEqual([await roleOf(r.agency.ownerMembershipId), await ownerCount(r.agency.agencyId)], ["OWNER", 1]);
});
