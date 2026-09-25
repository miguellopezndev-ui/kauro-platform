// The Authorizer against every role of the catalogue for the seven B06 commands (08 "Identity is not permission", "Role and
// capability model"; design §6.1 and D-AUTHZ-1..4). Decisions are read from an in-memory store bound to the tenant context;
// the same decisions against real rows and row-level security are the integration mandate.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssuranceProofId, AgencyId, CorrelationId, IdentityFacts, MembershipId, MembershipRole, UnitOfWorkFactory, UserId } from "@kauro/domain";
import { COMMAND_ROLE_MEMBERS, MEMBERSHIP_ROLES, identityUserId } from "@kauro/domain";
import type { AuthorizationDecision, AuthorizationRequest, Authorizer, InMemoryStore } from "@kauro/application";
import { AUTHORIZATION_POLICY_VERSION, B06_COMMANDS, createInMemoryPorts, emptyStore, fixedClock, sequentialIds } from "@kauro/application";
import { createAssuranceVerifier, createAuthorizer } from "../src/index.js";

const clock = fixedClock();
const ids = sequentialIds(clock);
const AGENCY = "018f0000-0000-7000-8000-00000000a0a0" as AgencyId;
const OTHER = "018f0000-0000-7000-8000-00000000b0b0" as AgencyId;

function facts(name: string, over: Partial<IdentityFacts> = {}): IdentityFacts {
  return { userId: identityUserId("identity-platform", name), emailVerifiedAt: clock.now(), mfaEnrolledAt: clock.now(), state: "ACTIVE", ...over };
}

interface Fixture {
  readonly store: InMemoryStore;
  readonly uow: UnitOfWorkFactory;
  readonly authorizer: Authorizer;
}

function fixture(): Fixture {
  const store = emptyStore();
  const now = clock.now();
  for (const a of [AGENCY, OTHER]) store.agencies.set(a, { agencyId: a, version: 1, displayName: a, state: "ACTIVE", createdAt: now, createdByUserId: identityUserId("identity-platform", "creator") as UserId, updatedAt: now });
  const ports = createInMemoryPorts(clock, ids, store);
  // the ports replace the store on every committed unit of work: read it through the getter, never capture it
  return {
    get store() {
      return ports.store;
    },
    uow: ports.unitOfWork,
    authorizer: createAuthorizer({ clock, assurance: createAssuranceVerifier() }),
  };
}

function member(store: InMemoryStore, agencyId: AgencyId, identity: IdentityFacts, role: MembershipRole, state: "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED" = "ACTIVE"): MembershipId {
  const membershipId = ids.next() as MembershipId;
  store.identities.set(identity.userId, { ...identity, provider: "identity-platform", subjectHash: "0".repeat(64) });
  store.memberships.set(membershipId, { membershipId, agencyId, userId: identity.userId, role, state, version: 1, assurancePolicy: "MFA_REQUIRED", createdAt: clock.now(), updatedAt: clock.now() });
  return membershipId;
}

/** The decision of a new execution, as the runtime takes it: access (steps 1–7), then assurance (step 8) when access allows. */
async function decide(f: Fixture, request: AuthorizationRequest, agencyId: AgencyId | null = request.agencyId): Promise<AuthorizationDecision> {
  const correlationId = ids.next() as CorrelationId;
  const context = agencyId === null ? ({ kind: "IDENTITY", userId: request.identity.userId, correlationId } as const) : ({ kind: "TENANT", agencyId, userId: request.identity.userId, correlationId } as const);
  return f.uow.run(context, async (uow) => {
    const access = await f.authorizer.authorize(uow, request);
    return access.kind === "ALLOW" ? f.authorizer.assure(uow, request, access) : access;
  });
}

/** The access decision alone (steps 1–7): what a replay is answered against. */
async function access(f: Fixture, request: AuthorizationRequest): Promise<AuthorizationDecision> {
  const correlationId = ids.next() as CorrelationId;
  const context = request.agencyId === null ? ({ kind: "IDENTITY", userId: request.identity.userId, correlationId } as const) : ({ kind: "TENANT", agencyId: request.agencyId, userId: request.identity.userId, correlationId } as const);
  return f.uow.run(context, (uow) => f.authorizer.authorize(uow, request));
}

const TENANT_COMMANDS = Object.values(B06_COMMANDS).filter((c) => c.scope !== "NONE");

test("every membership role against every tenant command: the decision equals the COMMAND_ROLE_MEMBERS table; OWNER passes everything; every denial names ROLE_INSUFFICIENT and the policy version", async () => {
  const f = fixture();
  for (const role of MEMBERSHIP_ROLES) {
    const identity = facts(`user-${role}`);
    member(f.store, AGENCY, identity, role);
    for (const command of TENANT_COMMANDS) {
      if (command.stepUpRequired) continue; // CMD025 is covered with its proof below
      const d = await decide(f, { command: command.id, identity, agencyId: AGENCY });
      const expected = COMMAND_ROLE_MEMBERS[command.role as keyof typeof COMMAND_ROLE_MEMBERS].has(role);
      assert.equal(d.kind, expected ? "ALLOW" : "DENY", `${role} on ${command.id} (${command.role})`);
      if (d.kind === "DENY") {
        assert.equal(d.code, "NOT_AUTHORIZED");
        assert.equal(d.reason, "ROLE_INSUFFICIENT");
        assert.equal(d.policyVersion, AUTHORIZATION_POLICY_VERSION);
      } else {
        assert.equal(d.membership?.role, role);
        assert.equal(d.membership?.agencyId, AGENCY);
        assert.equal(d.assuranceClass, "SESSION");
      }
    }
  }
});

test("identity is not permission: a disabled or unverified identity is denied before any membership is read; CreateAgency needs no membership", async () => {
  const f = fixture();
  const owner = facts("owner");
  member(f.store, AGENCY, owner, "OWNER");
  const disabled = await decide(f, { command: "CMD009", identity: { ...owner, state: "DISABLED" }, agencyId: AGENCY });
  assert.deepEqual(disabled, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_DISABLED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const noMfa = await decide(f, { command: "CMD009", identity: { ...owner, mfaEnrolledAt: null }, agencyId: AGENCY });
  assert.deepEqual(noMfa, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_UNVERIFIED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const noEmail = await decide(f, { command: "CMD001", identity: { ...owner, emailVerifiedAt: null }, agencyId: null });
  assert.equal(noEmail.kind, "DENY");
  const create = await decide(f, { command: "CMD001", identity: facts("brand-new"), agencyId: null });
  assert.deepEqual(create, { kind: "ALLOW", membership: null, assuranceClass: "SESSION", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const notV5 = await decide(f, { command: "CMD001", identity: { ...owner, userId: "018f0000-0000-7000-8000-000000000001" as UserId }, agencyId: null });
  assert.equal(notV5.kind, "DENY");
  if (notV5.kind === "DENY") assert.equal(notV5.code, "AUTHENTICATION_REQUIRED");
});

test("scope: a caller without a live membership in the selected agency gets NOT_FOUND (foreign and nonexistent alike); a SUSPENDED member is NOT_AUTHORIZED / MEMBERSHIP_SUSPENDED; an INVITED one MEMBERSHIP_NOT_ACTIVE; a REVOKED one NOT_FOUND", async () => {
  const f = fixture();
  const owner = facts("owner");
  member(f.store, AGENCY, owner, "OWNER");
  const foreign = await decide(f, { command: "CMD009", identity: owner, agencyId: OTHER });
  assert.deepEqual(foreign, { kind: "DENY", code: "NOT_FOUND", reason: "NOT_A_MEMBER", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const nobody = await decide(f, { command: "CMD009", identity: facts("nobody"), agencyId: AGENCY });
  assert.equal(nobody.kind, "DENY");
  if (nobody.kind === "DENY") assert.equal(nobody.code, "NOT_FOUND");
  const suspended = facts("suspended");
  member(f.store, AGENCY, suspended, "ADMIN", "SUSPENDED");
  const s = await decide(f, { command: "CMD010", identity: suspended, agencyId: AGENCY });
  assert.deepEqual(s, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "MEMBERSHIP_SUSPENDED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const invited = facts("invited");
  member(f.store, AGENCY, invited, "OPERATOR", "INVITED");
  const i = await decide(f, { command: "CMD011", identity: invited, agencyId: AGENCY });
  assert.deepEqual(i, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "MEMBERSHIP_NOT_ACTIVE", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const revoked = facts("revoked");
  member(f.store, AGENCY, revoked, "OWNER", "REVOKED");
  const r = await decide(f, { command: "CMD009", identity: revoked, agencyId: AGENCY });
  assert.equal(r.kind, "DENY");
  if (r.kind === "DENY") assert.equal(r.code, "NOT_FOUND");
  // a unit of work bound to another agency than the selector never yields a membership (server-derived scope)
  const mismatched = await decide(f, { command: "CMD009", identity: owner, agencyId: AGENCY }, OTHER);
  assert.deepEqual(mismatched, { kind: "DENY", code: "NOT_FOUND", reason: "TENANT_CONTEXT_MISSING", policyVersion: AUTHORIZATION_POLICY_VERSION });
  const missing = await decide(f, { command: "CMD009", identity: owner, agencyId: null });
  assert.equal(missing.kind, "DENY");
  if (missing.kind === "DENY") assert.equal(missing.reason, "TENANT_CONTEXT_MISSING");
});

test("no cached grant: a SUSPENDED member reactivated in the store is allowed on the next decision, and a revoked one is refused on the next decision", async () => {
  const f = fixture();
  const admin = facts("admin");
  const membershipId = member(f.store, AGENCY, admin, "ADMIN");
  assert.equal((await decide(f, { command: "CMD010", identity: admin, agencyId: AGENCY })).kind, "ALLOW");
  f.store.memberships.set(membershipId, { ...f.store.memberships.get(membershipId)!, state: "SUSPENDED", version: 2 });
  assert.equal((await decide(f, { command: "CMD010", identity: admin, agencyId: AGENCY })).kind, "DENY");
  f.store.memberships.set(membershipId, { ...f.store.memberships.get(membershipId)!, state: "ACTIVE", version: 3 });
  const back = await decide(f, { command: "CMD010", identity: admin, agencyId: AGENCY });
  assert.equal(back.kind, "ALLOW");
  if (back.kind === "ALLOW") assert.equal(back.membership?.version, 3, "the decision carries the current membership version");
});

test("step-up (CMD025): a fresh proof of the actor allows with assurance class STEP_UP; missing, foreign, expired or stale proofs are ASSURANCE_REQUIRED with the exact reason", async () => {
  const f = fixture();
  const approver = facts("approver");
  const other = facts("other-approver");
  member(f.store, AGENCY, approver, "APPROVER");
  member(f.store, AGENCY, other, "APPROVER");
  const fresh = ids.next() as AssuranceProofId;
  f.store.proofs.set(fresh, { proofId: fresh, userId: approver.userId, kind: "STEP_UP", method: "TOTP", issuedAt: clock.now(), expiresAt: new Date(clock.nowMs() + 600_000).toISOString() });
  const stale = ids.next() as AssuranceProofId;
  f.store.proofs.set(stale, { proofId: stale, userId: approver.userId, kind: "STEP_UP", method: "WEBAUTHN", issuedAt: new Date(clock.nowMs() - 901_000).toISOString(), expiresAt: new Date(clock.nowMs() + 600_000).toISOString() });
  const expired = ids.next() as AssuranceProofId;
  f.store.proofs.set(expired, { proofId: expired, userId: approver.userId, kind: "STEP_UP", method: "TOTP", issuedAt: new Date(clock.nowMs() - 10_000).toISOString(), expiresAt: new Date(clock.nowMs() - 1_000).toISOString() });
  const theirs = ids.next() as AssuranceProofId;
  f.store.proofs.set(theirs, { proofId: theirs, userId: other.userId, kind: "STEP_UP", method: "TOTP", issuedAt: clock.now(), expiresAt: new Date(clock.nowMs() + 600_000).toISOString() });

  const ok = await decide(f, { command: "CMD025", identity: approver, agencyId: AGENCY, assuranceProofRef: fresh });
  assert.equal(ok.kind, "ALLOW");
  if (ok.kind === "ALLOW") assert.equal(ok.assuranceClass, "STEP_UP");
  const expect = async (ref: AssuranceProofId | undefined, reason: string) => {
    const d = await decide(f, { command: "CMD025", identity: approver, agencyId: AGENCY, ...(ref !== undefined ? { assuranceProofRef: ref } : {}) });
    assert.deepEqual(d, { kind: "DENY", code: "ASSURANCE_REQUIRED", reason, policyVersion: AUTHORIZATION_POLICY_VERSION }, reason);
  };
  await expect(undefined, "STEP_UP_MISSING");
  await expect(stale, "STEP_UP_STALE");
  await expect(expired, "STEP_UP_STALE");
  await expect(theirs, "STEP_UP_NOT_OWNED");
  await expect(ids.next() as AssuranceProofId, "STEP_UP_NOT_OWNED");
  // the role check precedes the assurance check: an OPERATOR with a fresh proof is still ROLE_INSUFFICIENT
  const operator = facts("operator");
  member(f.store, AGENCY, operator, "OPERATOR");
  const p = ids.next() as AssuranceProofId;
  f.store.proofs.set(p, { proofId: p, userId: operator.userId, kind: "STEP_UP", method: "TOTP", issuedAt: clock.now(), expiresAt: new Date(clock.nowMs() + 600_000).toISOString() });
  const d = await decide(f, { command: "CMD025", identity: operator, agencyId: AGENCY, assuranceProofRef: p });
  assert.deepEqual(d, { kind: "DENY", code: "NOT_AUTHORIZED", reason: "ROLE_INSUFFICIENT", policyVersion: AUTHORIZATION_POLICY_VERSION });
});

test("commands whose role is not a membership (corporate, service) are denied by default", async () => {
  const f = fixture();
  const owner = facts("owner");
  member(f.store, AGENCY, owner, "OWNER");
  const d = await decide(f, { command: "CMD058", identity: owner, agencyId: AGENCY });
  assert.equal(d.kind, "DENY");
  if (d.kind === "DENY") assert.equal(d.reason, "ROLE_INSUFFICIENT");
});

test("R16: the stored identity row is consulted beside the token — a DISABLED row refuses a token that says ACTIVE, for a member and for CreateAgency; a stored row never verifies a token that is not, and no stored row leaves the token's facts to decide", async () => {
  const f = fixture();
  const operator = facts("stored-disabled-member");
  member(f.store, AGENCY, operator, "OPERATOR");
  assert.equal((await decide(f, { command: "CMD009", identity: operator, agencyId: AGENCY })).kind, "ALLOW");
  f.store.identities.set(operator.userId, { ...f.store.identities.get(operator.userId)!, state: "DISABLED" });
  assert.deepEqual(await decide(f, { command: "CMD009", identity: operator, agencyId: AGENCY }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_DISABLED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  assert.deepEqual(await decide(f, { command: "CMD001", identity: operator, agencyId: null }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_DISABLED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  // a verified row does not verify an unverified token (the token is the fresher source of verification facts)
  const lapsed = facts("stored-verified-token-not");
  member(f.store, AGENCY, lapsed, "OPERATOR");
  assert.deepEqual(await decide(f, { command: "CMD009", identity: { ...lapsed, mfaEnrolledAt: null }, agencyId: AGENCY }), { kind: "DENY", code: "NOT_AUTHORIZED", reason: "IDENTITY_UNVERIFIED", policyVersion: AUTHORIZATION_POLICY_VERSION });
  // never synced: the token decides
  assert.equal((await decide(f, { command: "CMD001", identity: facts("never-synced"), agencyId: null })).kind, "ALLOW");
});

test("access and assurance are two decisions (R7): access never reads a proof — the replay of a step-up command is answered to a current member whose proof has aged; assurance is step 8 of a new execution only; a unit of work bound to another person decides nothing", async () => {
  const f = fixture();
  const approver = facts("split-approver");
  member(f.store, AGENCY, approver, "APPROVER");
  const stale = ids.next() as AssuranceProofId;
  f.store.proofs.set(stale, { proofId: stale, userId: approver.userId, kind: "STEP_UP", method: "TOTP", issuedAt: new Date(clock.nowMs() - 3_600_000).toISOString(), expiresAt: new Date(clock.nowMs() - 2_700_000).toISOString() });
  const allowed = await access(f, { command: "CMD025", identity: approver, agencyId: AGENCY, assuranceProofRef: stale });
  assert.equal(allowed.kind, "ALLOW");
  if (allowed.kind === "ALLOW") assert.equal(allowed.assuranceClass, "SESSION", "access carries no assurance claim");
  assert.deepEqual(await decide(f, { command: "CMD025", identity: approver, agencyId: AGENCY, assuranceProofRef: stale }), { kind: "DENY", code: "ASSURANCE_REQUIRED", reason: "STEP_UP_STALE", policyVersion: AUTHORIZATION_POLICY_VERSION });
  // a command without step-up passes assurance with its access decision unchanged
  const operator = facts("split-operator");
  member(f.store, AGENCY, operator, "OPERATOR");
  const plain = await decide(f, { command: "CMD009", identity: operator, agencyId: AGENCY });
  assert.equal(plain.kind === "ALLOW" && plain.assuranceClass, "SESSION");
  // the unit of work runs for another person than the authenticated subject: nobody is authorized in it
  const correlationId = ids.next() as CorrelationId;
  const foreignContext = await f.uow.run({ kind: "TENANT", agencyId: AGENCY, userId: approver.userId, correlationId }, (uow) => f.authorizer.authorize(uow, { command: "CMD009", identity: operator, agencyId: AGENCY }));
  assert.deepEqual(foreignContext, { kind: "DENY", code: "AUTHENTICATION_REQUIRED", reason: "SUBJECT_UNAUTHENTICATED", policyVersion: AUTHORIZATION_POLICY_VERSION });
});
