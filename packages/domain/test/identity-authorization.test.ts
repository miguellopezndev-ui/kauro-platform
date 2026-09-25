// Identity aggregate and the authorization kernel (08 "Identity is not permission", "Authentication and assurance",
// "Role and capability model"; design §6.1; D-ASSUR-1/2; D-AUTHZ-1..4). Oracle: the command catalogue roles for the seven
// B06 commands (plus CMD004/CMD005/CMD007 for step-up and VERIFIED_USER paths) crossed with every membership role and state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS, type CommandId } from "@kauro/contracts";
import {
  type AccessDecision,
  type AssuranceProof,
  type AssuranceProofId,
  MEMBERSHIP_ROLES,
  type MembershipRecord,
  assertFreshStepUp,
  assertVerifiedIdentity,
  commandRequiresStepUp,
  commandRole,
  decideCommandAccess,
  evaluateStepUp,
  identityFacts,
  isUuidV5,
  registerIdentity,
  roleSatisfies,
  subjectDigest,
  syncIdentity,
} from "../src/index.js";
import { NOW, activeAgency, at, id, membership, refused, users, verified } from "./fixtures.js";

type CmdId = CommandId;

test("registerIdentity derives the UUIDv5 reference, keeps only the subject digest, and syncIdentity follows the authenticator", () => {
  const subject = { provider: "identity-platform", subject: "auth0|abc123", emailVerifiedAt: at(-1000), mfaEnrolledAt: null, state: "ACTIVE" as const };
  const rec = registerIdentity(subject, NOW);
  assert.ok(isUuidV5(rec.userId));
  assert.equal(rec.subjectHash, subjectDigest("auth0|abc123"));
  assert.ok(!JSON.stringify(rec).includes("auth0|abc123"), "the raw subject never enters the record");
  assert.equal(rec.mfaEnrolledAt, null);
  assert.deepEqual(identityFacts(rec), { userId: rec.userId, emailVerifiedAt: at(-1000), mfaEnrolledAt: null, state: "ACTIVE" });
  const synced = syncIdentity(rec, { ...subject, mfaEnrolledAt: NOW }, at(5));
  assert.equal(synced.userId, rec.userId);
  assert.equal(synced.mfaEnrolledAt, NOW);
  assert.equal(synced.createdAt, NOW);
  assert.equal(synced.updatedAt, at(5));
  // an un-enrolled MFA is reported as such: no stale grant survives a sync
  assert.equal(syncIdentity(synced, { ...subject, mfaEnrolledAt: null }, at(6)).mfaEnrolledAt, null);
  refused(() => syncIdentity(rec, { ...subject, subject: "auth0|other" }, at(7)), "INTEGRITY_FAILURE");
});

test("the launch policy: ACTIVE with verified email and enrolled MFA; DISABLED beats UNVERIFIED", () => {
  assert.deepEqual(assertVerifiedIdentity(verified(users.owner)), verified(users.owner));
  refused(() => assertVerifiedIdentity({ ...verified(users.owner), emailVerifiedAt: null }), "NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
  refused(() => assertVerifiedIdentity({ ...verified(users.owner), mfaEnrolledAt: null }), "NOT_AUTHORIZED", "IDENTITY_UNVERIFIED");
  refused(() => assertVerifiedIdentity({ ...verified(users.owner), state: "DISABLED" }), "NOT_AUTHORIZED", "IDENTITY_DISABLED");
  refused(() => assertVerifiedIdentity({ ...verified(users.owner), state: "DISABLED", mfaEnrolledAt: null }), "NOT_AUTHORIZED", "IDENTITY_DISABLED");
});

test("step-up evaluation (D-ASSUR-1): bound to the actor, fresh inside the window, never in the future, never after expiry", () => {
  const proof: AssuranceProof = { proofId: id() as AssuranceProofId, userId: users.owner, kind: "STEP_UP", method: "TOTP", issuedAt: NOW, expiresAt: at(3_600_000) };
  const check = (overrides: Partial<{ proof: AssuranceProof | null; now: string; freshnessSeconds: number }>) => evaluateStepUp({ proof, userId: users.owner, now: at(60_000), freshnessSeconds: 900, ...overrides });
  assert.deepEqual(check({}), { kind: "FRESH", proofId: proof.proofId, issuedAt: NOW });
  assert.deepEqual(check({ now: at(900_000) }), { kind: "FRESH", proofId: proof.proofId, issuedAt: NOW }, "the window is inclusive");
  assert.deepEqual(check({ now: at(900_001) }), { kind: "STALE", reason: "STEP_UP_STALE" });
  assert.deepEqual(check({ now: at(-1) }), { kind: "STALE", reason: "STEP_UP_STALE" }, "a proof issued in the future is not recent");
  assert.deepEqual(check({ now: at(3_600_000), freshnessSeconds: 10_000 }), { kind: "STALE", reason: "STEP_UP_STALE" }, "expiry caps the window");
  assert.deepEqual(check({ proof: null }), { kind: "MISSING", reason: "STEP_UP_MISSING" });
  assert.deepEqual(check({ proof: { ...proof, userId: users.admin } }), { kind: "MISSING", reason: "STEP_UP_NOT_OWNED" });
  assert.throws(() => check({ freshnessSeconds: 0 }), RangeError);
  const f = refused(() => assertFreshStepUp({ proof: null, userId: users.owner, now: NOW, freshnessSeconds: 900 }), "ASSURANCE_REQUIRED", "STEP_UP_MISSING");
  assert.equal(f.status, 403);
  assert.equal(assertFreshStepUp({ proof, userId: users.owner, now: at(1), freshnessSeconds: 900 }).proofId, proof.proofId);
});

test("step-up is required exactly for the catalogue commands that carry assuranceProofRef", () => {
  const expected = COMMANDS.filter((c) => c.fields.some((f) => f.name === "assuranceProofRef")).map((c) => c.id);
  assert.ok(expected.includes("CMD025") && expected.includes("CMD005") && expected.includes("CMD007"));
  assert.ok(!expected.includes("CMD009") && !expected.includes("CMD026"));
  for (const c of COMMANDS) assert.equal(commandRequiresStepUp(c.id as CmdId), expected.includes(c.id), c.id);
});

const B06: ReadonlyArray<{ id: CmdId; allowed: ReadonlyArray<string> }> = [
  { id: "CMD001", allowed: [] },
  { id: "CMD009", allowed: ["OWNER", "ADMIN", "OPERATOR"] },
  { id: "CMD010", allowed: ["OWNER", "ADMIN"] },
  { id: "CMD011", allowed: ["OWNER", "ADMIN", "OPERATOR"] },
  { id: "CMD023", allowed: ["OWNER", "ADMIN", "OPERATOR"] },
  { id: "CMD025", allowed: ["OWNER", "APPROVER"] },
  { id: "CMD026", allowed: ["OWNER", "APPROVER"] },
];

test("decideCommandAccess: every role's boundary for the seven B06 commands, in the order of design §6.1", () => {
  const ag = activeAgency();
  const proof: AssuranceProof = { proofId: id() as AssuranceProofId, userId: users.owner, kind: "STEP_UP", method: "WEBAUTHN", issuedAt: NOW, expiresAt: at(3_600_000) };
  const decide = (command: CmdId, m: MembershipRecord | null, identityUserId = m?.userId ?? users.owner, extra: Partial<Parameters<typeof decideCommandAccess>[0]> = {}): AccessDecision =>
    decideCommandAccess({ command, identity: verified(identityUserId), agencyId: ag.agencyId, membership: m, ...(commandRequiresStepUp(command) ? { stepUp: { proof: { ...proof, userId: identityUserId }, now: at(1000), freshnessSeconds: 900 } } : {}), ...extra });

  for (const { id: command, allowed } of B06) {
    const role = commandRole(command);
    if (command === "CMD001") {
      const d = decide(command, null);
      assert.equal(d.kind, "ALLOW");
      if (d.kind === "ALLOW") {
        assert.equal(d.membership, null);
        assert.equal(d.assuranceClass, "SESSION");
        assert.equal(d.commandRole, "VERIFIED_USER");
      }
      continue;
    }
    for (const mRole of MEMBERSHIP_ROLES) {
      const m = membership(ag.agencyId, mRole, users.owner);
      const d = decide(command, m);
      if (allowed.includes(mRole)) {
        assert.equal(d.kind, "ALLOW", `${command} ${mRole}`);
        if (d.kind === "ALLOW") {
          assert.deepEqual(d.membership, { membershipId: m.membershipId, agencyId: ag.agencyId, userId: users.owner, role: mRole, version: 1, assurancePolicy: "MFA_REQUIRED" });
          assert.equal(d.assuranceClass, command === "CMD025" ? "STEP_UP" : "SESSION");
        }
      } else {
        assert.deepEqual(d, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" }, `${command} ${mRole}`);
      }
      assert.equal(roleSatisfies(role, mRole), allowed.includes(mRole));
      // a SUSPENDED or INVITED membership never passes, whatever the role; REVOKED/EXPIRED are not memberships at all
      assert.deepEqual(decide(command, { ...m, state: "SUSPENDED" }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "MEMBERSHIP_SUSPENDED" });
      assert.deepEqual(decide(command, { ...m, state: "INVITED" }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "MEMBERSHIP_NOT_ACTIVE" });
      assert.deepEqual(decide(command, { ...m, state: "REVOKED", revokedAt: NOW }), { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER" });
      assert.deepEqual(decide(command, { ...m, state: "EXPIRED" }), { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER" });
    }
    // no membership, a membership of another agency or of another person: NOT_FOUND (D-AUTHZ-4), never NOT_AUTHORIZED
    const owner = membership(ag.agencyId, "OWNER", users.owner);
    assert.deepEqual(decide(command, null), { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER" });
    assert.deepEqual(decide(command, membership(id() as typeof ag.agencyId, "OWNER", users.owner)), { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER" });
    assert.deepEqual(decide(command, owner, users.admin), { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER" });
    // no selector at all
    assert.deepEqual(decide(command, owner, users.owner, { agencyId: null }), { kind: "DENY", code: "INVALID_REQUEST", reason: "TENANT_CONTEXT_MISSING" });
  }
});

test("decideCommandAccess: identity checks precede membership; step-up denials name the narrowing reason; corporate roles are denied by default", () => {
  const ag = activeAgency();
  const owner = membership(ag.agencyId, "OWNER", users.owner);
  const base = { command: "CMD009" as CmdId, identity: verified(users.owner), agencyId: ag.agencyId, membership: owner };
  assert.deepEqual(decideCommandAccess({ ...base, identity: null }), { kind: "DENY", code: "AUTHENTICATION_REQUIRED", reason: "SUBJECT_UNAUTHENTICATED" });
  assert.deepEqual(decideCommandAccess({ ...base, identity: { ...verified(users.owner), state: "DISABLED" } }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_DISABLED" });
  assert.deepEqual(decideCommandAccess({ ...base, identity: { ...verified(users.owner), mfaEnrolledAt: null } }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_UNVERIFIED" });
  // CreateAgency needs a verified identity too (CMD001-DENY: unverified identity → NOT_AUTHORIZED)
  assert.deepEqual(decideCommandAccess({ command: "CMD001", identity: { ...verified(users.owner), emailVerifiedAt: null }, agencyId: null, membership: null }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_UNVERIFIED" });
  assert.equal(decideCommandAccess({ command: "CMD001", identity: verified(users.owner), agencyId: null, membership: null }).kind, "ALLOW");
  // step-up (CMD025): missing, foreign, stale
  const approver = membership(ag.agencyId, "APPROVER", users.approver);
  const proof: AssuranceProof = { proofId: id() as AssuranceProofId, userId: users.approver, kind: "STEP_UP", method: "TOTP", issuedAt: NOW, expiresAt: at(3_600_000) };
  const stepUp = (p: AssuranceProof | null, now = at(1000)) => decideCommandAccess({ command: "CMD025", identity: verified(users.approver), agencyId: ag.agencyId, membership: approver, stepUp: { proof: p, now, freshnessSeconds: 900 } });
  assert.deepEqual(decideCommandAccess({ command: "CMD025", identity: verified(users.approver), agencyId: ag.agencyId, membership: approver }), { kind: "DENY", code: "ASSURANCE_REQUIRED", reason: "STEP_UP_MISSING" });
  assert.deepEqual(stepUp(null), { kind: "DENY", code: "ASSURANCE_REQUIRED", reason: "STEP_UP_MISSING" });
  assert.deepEqual(stepUp({ ...proof, userId: users.owner }), { kind: "DENY", code: "ASSURANCE_REQUIRED", reason: "STEP_UP_NOT_OWNED" });
  assert.deepEqual(stepUp(proof, at(901_000)), { kind: "DENY", code: "ASSURANCE_REQUIRED", reason: "STEP_UP_STALE" });
  const ok = stepUp(proof);
  assert.equal(ok.kind, "ALLOW");
  if (ok.kind === "ALLOW") assert.equal(ok.assuranceClass, "STEP_UP");
  // an OPERATOR with a perfectly fresh proof is still refused on role, before assurance is even considered
  assert.deepEqual(decideCommandAccess({ command: "CMD025", identity: verified(users.operator), agencyId: ag.agencyId, membership: membership(ag.agencyId, "OPERATOR", users.operator), stepUp: { proof: { ...proof, userId: users.operator }, now: at(1), freshnessSeconds: 900 } }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" });
  // corporate and service roles are not memberships: default deny
  const corporate = COMMANDS.filter((c) => !c.role.startsWith("AGENCY_") && c.role !== "VERIFIED_USER");
  assert.ok(corporate.length > 0);
  for (const c of corporate) assert.deepEqual(decideCommandAccess({ ...base, command: c.id as CmdId }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT" }, c.id);
  // VERIFIED_USER commands with a step-up field (none in the catalogue today) would still be evaluated: CMD004 has none
  assert.equal(decideCommandAccess({ command: "CMD004", identity: verified(users.viewer), agencyId: null, membership: null }).kind, "ALLOW");
});
