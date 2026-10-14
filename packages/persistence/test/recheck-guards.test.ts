// The database boundaries the re-check of the integrated branch (e05d47a) found missing, each proven as the runtime role that
// would cross it, beside the legitimate write that still commits (21 "Positive and negative symmetry"; 07 "Application checks
// improve messages but cannot be the sole protection"; 08 "Database isolation"): N1 (the security status of an identity is
// not the request handlers' to write), N5 (an APPROVED plan never loses its live approval silently), N6 (a label refuses
// exactly the control characters the request schema refuses, on any cluster, and names the field when refused), N9 (a plan's
// source and target are its own project's), N11 (the membership, agency and approval write boundary of the acting session).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, type ClientId, type MembershipId, type ProcessingAuthorityId, type UserId } from "@kauro/domain";
import { clock, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { event, ids, invite, plan, planBody, project, sealedSource, sha, sqlState, stepUpProof, targetContract, tx, type PlanFixture } from "./support.js";

let h: Harness;
let app: Client;
// the control plane seals sources through the B07 lifecycle (its inspection and evaluation writes; support.ts sealedSource)
let control: Client;
let validator: Client;
let assurance: Client;
let owner: UserId;
let admin: UserId;
let viewer: UserId;
let approver: UserId;
let A: AgencyFixture;
let adminMembership: MembershipId;
let viewerMembership: MembershipId;
let approverMembership: MembershipId;
let clientA: ClientId;
let projectA: string;
let projectB: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  validator = await h.pg.connect("kauro_validator_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  owner = await h.person("owner-recheck");
  admin = await h.person("admin-recheck");
  viewer = await h.person("viewer-recheck");
  approver = await h.person("approver-recheck");
  A = await h.createAgency(owner, "Recheck A");
  adminMembership = await h.addMember(A, admin, "ADMIN");
  viewerMembership = await h.addMember(A, viewer, "VIEWER");
  approverMembership = await h.addMember(A, approver, "APPROVER");
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  const capability = await h.offeredCapability("CLEAN");
  projectA = (await project(app, A, clientA, capability)).projectId;
  projectB = (await project(app, A, clientA, capability)).projectId;
});
after(async () => {
  await app.end();
  await control.end();
  await validator.end();
  await assurance.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean =>
  sqlState(e) === code && (constraint === undefined || (typeof e === "object" && e !== null && (e as { constraint?: string }).constraint === constraint));

function ctx(userId: string): { readonly agencyId: string; readonly userId: string } {
  return { agencyId: A.agencyId, userId };
}

/** A membership change as the session `actor` writes it: the version bump and its event, so only the boundary can refuse it. */
async function changeMembership(c: Client, actor: string, membershipId: string, set: string, eventType: string): Promise<void> {
  const r = await c.query<{ version: string }>(`UPDATE kauro.memberships SET ${set}, version = version + 1 WHERE membership_id = $1 RETURNING version`, [membershipId]);
  const version = Number(r.rows[0]?.version);
  await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: version, agencyId: A.agencyId, eventType, actorUserId: actor, payload: { membershipId, agencyId: A.agencyId } });
}

test("N1: the request-handler role holds no privilege on an identity's security status — it cannot lift a DISABLED row, its own included, nor be born anything but ACTIVE; its sync keeps only the verification facts current", async () => {
  const dora = await h.person("dora-recheck");
  await h.oracle.query("UPDATE kauro.identities SET state = 'DISABLED' WHERE user_id = $1", [dora]);
  // the re-checker's V-R16b: the identity's own session re-enables its DISABLED row with one UPDATE
  await assert.rejects(tx(app, { userId: dora }, (c) => c.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [dora])), refusedWith("42501"));
  await assert.rejects(tx(app, ctx(dora), (c) => c.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [dora])), refusedWith("42501"));
  // a sync through the adapter (what CMD001 runs) records the token's verification facts and leaves the status alone
  const verifiedAt = clock.now();
  const synced = await h.app.run(h.identity(dora), (uow) => uow.identities.syncOwn({ userId: dora, state: "ACTIVE", emailVerifiedAt: verifiedAt, mfaEnrolledAt: verifiedAt }, "identity-platform", sha("dora-recheck"), clock.now()));
  assert.equal(synced.state, "DISABLED", "the sync answers the stored status, which the token cannot overwrite");
  const row = await h.oracle.query("SELECT state FROM kauro.identities WHERE user_id = $1", [dora]);
  assert.deepEqual(row.rows[0], { state: "DISABLED" });
  // an identity is born ACTIVE only: naming a status at birth is refused (the column is not the handlers')
  const eli = ids.next();
  await assert.rejects(
    tx(app, { userId: eli }, (c) => c.query("INSERT INTO kauro.identities (user_id, provider, subject_hash, state, created_at, updated_at) VALUES ($1, 'identity-platform', $2, 'DISABLED', now(), now())", [eli, sha("eli")])),
    refusedWith("42501"),
  );
  // the positive neighbour: the platform's security operations (here the superuser) lift it, and the verification facts of the
  // identity's own sync stay writable by the handlers
  await h.oracle.query("UPDATE kauro.identities SET state = 'ACTIVE' WHERE user_id = $1", [dora]);
  const later = clock.now();
  await tx(app, { userId: dora }, (c) => c.query("UPDATE kauro.identities SET mfa_enrolled_at = $2 WHERE user_id = $1", [dora, later]));
});

test("N5: ending an approval moves its plan out of APPROVED in the same transaction — a withdrawal written alone, leaving the plan APPROVED under no live authority, is refused at COMMIT (KA020)", async () => {
  const p = await plan({ app, control }, A, projectA, "VALIDATED", "n5", validator);
  const proof = await stepUpProof(assurance, { userId: approver });
  const approvalId = ids.next();
  await tx(app, ctx(approver), async (c) => {
    await c.query(
      `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
      [approvalId, A.agencyId, p.planId, approver, approverMembership, proof, p.bodyHash, p.revisionHash, p.targetContractHash, p.receiptHash, sha("disclosures-n5"), sha("approval-n5")],
    );
    await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actorUserId: approver, payload: { approvalId } });
    await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = 5 WHERE plan_id = $1 AND version = 4", [p.planId, approvalId]);
    await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: approver, payload: { planId: p.planId, approvalId } });
  });
  const withdrawAlone = (c: Client) =>
    c
      .query("UPDATE kauro.approvals SET withdrawn_at = now(), withdrawn_by_membership_id = $2, withdraw_reason_code = 'RAW', version = 2 WHERE approval_id = $1", [approvalId, A.ownerMembershipId])
      .then(() => event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "approval.withdrawn.v1", actorUserId: owner, payload: { approvalId } }));
  // the re-checker's variant R21 (converse): the owner's own session withdraws the approval and leaves the plan APPROVED
  await assert.rejects(tx(app, ctx(owner), withdrawAlone), refusedWith("KA020"));
  const unchanged = await h.oracle.query("SELECT (SELECT state FROM kauro.plans WHERE plan_id = $1) AS plan, (SELECT withdrawn_at IS NULL FROM kauro.approvals WHERE approval_id = $2) AS live", [p.planId, approvalId]);
  assert.deepEqual(unchanged.rows[0], { plan: "APPROVED", live: true });
  // the legitimate edge: the withdrawal and the plan's APPROVED -> WITHDRAWN commit together
  await tx(app, ctx(owner), async (c) => {
    await withdrawAlone(c);
    await c.query("UPDATE kauro.plans SET state = 'WITHDRAWN', version = 6 WHERE plan_id = $1 AND version = 5", [p.planId]);
    await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 6, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actorUserId: owner, payload: { planId: p.planId, approvalId } });
  });
  const ended = await h.oracle.query("SELECT state FROM kauro.plans WHERE plan_id = $1", [p.planId]);
  assert.deepEqual(ended.rows[0], { state: "WITHDRAWN" });
});

test("N6: a label refuses exactly the Unicode control characters (C0, DEL and C1) by code point, whatever the cluster's locale; a refusal that reaches the database names its field", async () => {
  const isLabel = async (v: string): Promise<boolean> => (await h.oracle.query<{ ok: boolean }>("SELECT kauro.is_label($1) AS ok", [v])).rows[0]!.ok;
  for (const bad of ["a\u0001b", "a\tb", "a\u001fb", "a\u007fb", "a\u0080b", "Stop\u0085now", "a\u009fb", ""]) assert.equal(await isLabel(bad), false, JSON.stringify(bad));
  for (const good of ["Acme", "Cliente pidió parar — 顧客", "a b", "ÿ", "x".repeat(200)]) assert.equal(await isLabel(good), true, JSON.stringify(good));
  assert.equal(await isLabel("x".repeat(201)), false);
  // the definition names code points, never a locale-dependent class
  const def = await h.oracle.query<{ src: string }>("SELECT prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.proname = 'is_label'");
  assert.doesNotMatch(def.rows[0]!.src, /cntrl/);
  // a writer that bypassed the request schema meets the named constraint, and the adapter answers the field instead of a
  // reasonless INVALID_REQUEST (10 "frontend control flow uses the code and typed fields")
  const authority = (await h.oracle.query<{ id: ProcessingAuthorityId }>("SELECT processing_authority_id AS id FROM kauro.processing_authorities WHERE agency_id = $1 LIMIT 1", [A.agencyId])).rows[0]!.id;
  await assert.rejects(
    h.app.run(h.tenant(A.agencyId, owner), (uow) =>
      uow.endClients.insert({ clientId: ids.next() as ClientId, agencyId: A.agencyId, displayName: "Stop\u0085now", processingAuthorityRef: authority, createdByMembershipId: A.ownerMembershipId, createdAt: clock.now() }),
    ),
    (e: unknown) => isDomainFailure(e) && e.code === "INVALID_REQUEST" && e.reason === "SCHEMA_VIOLATION" && JSON.stringify(e.details.fields) === JSON.stringify([{ field: "displayName", code: "FORMAT" }]),
  );
});

test("N9: a plan's source and target are a sealed revision and a target contract of its own project — naming another project's is refused at insert, whatever the hashes; the plan's subject columns are its body's members", async () => {
  const sourceB = await sealedSource({ app, control }, A, projectB, "n9-b");
  const targetB = await targetContract(app, A, projectB, "n9-b");
  const sourceA = await sealedSource({ app, control }, A, projectA, "n9-a");
  const targetA = await targetContract(app, A, projectA, "n9-a");
  const insertPlan = (projectId: string, revisionHash: string, targetContractHash: string, body = planBody(revisionHash, targetContractHash, sha("policy"))) =>
    tx(app, ctx(owner), async (c) => {
      const planId = ids.next();
      await c.query(
        `INSERT INTO kauro.plans (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now(), now())`,
        [planId, A.agencyId, projectId, revisionHash, targetContractHash, sha("policy"), JSON.stringify(body), sha("body-" + planId), A.ownerMembershipId],
      );
      await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "plan.created.v1", actorUserId: owner, payload: { planId } });
      return planId;
    });
  // the re-checker's P4: a plan of project A naming project B's sealed source and confirmed contract
  await assert.rejects(insertPlan(projectA, sourceB.manifestHash, targetA.bodyHash), refusedWith("23503", "plans_source_fk"));
  await assert.rejects(insertPlan(projectA, sourceA.manifestHash, targetB.bodyHash), refusedWith("23503", "plans_target_fk"));
  // a body that names other subjects than the columns
  await assert.rejects(insertPlan(projectA, sourceA.manifestHash, targetA.bodyHash, planBody(sourceB.manifestHash, targetA.bodyHash, sha("policy"))), refusedWith("23514", "plans_body_names_subjects"));
  // the positive neighbour: its own project's subjects
  const planId = await insertPlan(projectA, sourceA.manifestHash, targetA.bodyHash);
  assert.equal((await h.oracle.query("SELECT count(*)::int AS n FROM kauro.plans WHERE plan_id = $1", [planId])).rows[0].n, 1);
  // a target contract body hash is unique within its project, not across projects (one observation of a shared instance)
  const sameBodyInB = await tx(app, ctx(owner), (c) =>
    c.query(
      `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
       VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now(), NULL, $8, 'R2-INITIAL', now())`,
      [ids.next(), A.agencyId, projectB, ids.next(), ids.next(), sha("bundle"), targetA.bodyHash, sha("authority-shared")],
    ),
  );
  assert.equal(sameBodyInB.rowCount, 1);
  await assert.rejects(
    tx(app, ctx(owner), (c) =>
      c.query(
        `INSERT INTO kauro.target_contracts (contract_id, agency_id, project_id, mode, instance_id, importer_profile_id, importer_version, objects, schema_bundle_digest, body_hash, observed_at, confirmed_at, authority_evidence_hash, capability_version, created_at)
         VALUES ($1, $2, $3, 'CLEAN', $4, $5, 'R2-INITIAL', '[]'::jsonb, $6, $7, now(), NULL, $8, 'R2-INITIAL', now())`,
        [ids.next(), A.agencyId, projectA, ids.next(), ids.next(), sha("bundle"), targetA.bodyHash, sha("authority-again")],
      ),
    ),
    refusedWith("23505", "target_contracts_project_body"),
  );
});

test("N11: the membership write boundary — a VIEWER's own session cannot promote itself, an ADMIN cannot grant or touch OWNER, only the invited identity accepts and only with a consumed invitation; the OWNER's changes commit", async () => {
  // the re-checker's P7: the viewer's session makes itself OWNER, with the version bump and its event
  await assert.rejects(tx(app, ctx(viewer), (c) => changeMembership(c, viewer, viewerMembership, "role = 'OWNER'", "membership.role_changed.v1")), refusedWith("KA010"));
  // an ADMIN grants OWNER, or suspends the OWNER
  await assert.rejects(tx(app, ctx(admin), (c) => changeMembership(c, admin, viewerMembership, "role = 'OWNER'", "membership.role_changed.v1")), refusedWith("KA010"));
  await assert.rejects(tx(app, ctx(admin), (c) => changeMembership(c, admin, A.ownerMembershipId, "state = 'SUSPENDED'", "membership.suspended.v1")), refusedWith("KA010"));
  // an ADMIN changes a role at all (CMD005 is AGENCY_OWNER)
  await assert.rejects(tx(app, ctx(admin), (c) => changeMembership(c, admin, viewerMembership, "role = 'OPERATOR'", "membership.role_changed.v1")), refusedWith("KA010"));
  // an ADMIN invites an OWNER; a VIEWER invites anyone
  const inviteAs = (sessionUser: string, role: string) =>
    tx(app, ctx(sessionUser), async (c) => {
      const membershipId = ids.next();
      await c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, created_at, updated_at) VALUES ($1, $2, $3, $4, 'INVITED', 'MFA_REQUIRED', now(), now())", [membershipId, A.agencyId, invitee, role]);
      await event(c, { aggregateKind: "membership", aggregateId: membershipId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "membership.invited.v1", actorUserId: sessionUser, payload: { membershipId } });
    });
  const invitee = await h.person("invitee-recheck");
  await assert.rejects(inviteAs(admin, "OWNER"), refusedWith("KA010"));
  await assert.rejects(inviteAs(viewer, "VIEWER"), refusedWith("KA010"));
  // an invited identity accepts without consuming its invitation, and another identity accepts in its place
  const pending = await invite(app, A, { userId: invitee }, "OPERATOR");
  const accept = (sessionUser: string) => tx(app, ctx(sessionUser), (c) => changeMembership(c, sessionUser, pending.membershipId, "state = 'ACTIVE', accepted_at = now()", "membership.accepted.v1"));
  await assert.rejects(accept(invitee), refusedWith("KA011"));
  await assert.rejects(accept(owner), refusedWith("KA010"));
  // the positive neighbours: the invitee accepts after consuming its invitation, the ADMIN suspends that OPERATOR, the OWNER
  // changes a role
  await tx(app, ctx(invitee), async (c) => {
    await c.query("UPDATE kauro.membership_invitations SET consumed_at = now() WHERE invitation_id = $1", [pending.invitationId]);
    await changeMembership(c, invitee, pending.membershipId, "state = 'ACTIVE', accepted_at = now()", "membership.accepted.v1");
  });
  await tx(app, ctx(admin), (c) => changeMembership(c, admin, pending.membershipId, "state = 'SUSPENDED'", "membership.suspended.v1"));
  await tx(app, ctx(owner), (c) => changeMembership(c, owner, viewerMembership, "role = 'OPERATOR'", "membership.role_changed.v1"));
  const rows = await h.oracle.query("SELECT membership_id, role, state FROM kauro.memberships WHERE membership_id = ANY($1::uuid[]) ORDER BY role, state", [[viewerMembership, pending.membershipId, A.ownerMembershipId, adminMembership]]);
  assert.deepEqual(rows.rows, [
    { membership_id: adminMembership, role: "ADMIN", state: "ACTIVE" },
    { membership_id: viewerMembership, role: "OPERATOR", state: "ACTIVE" },
    { membership_id: pending.membershipId, role: "OPERATOR", state: "SUSPENDED" },
    { membership_id: A.ownerMembershipId, role: "OWNER", state: "ACTIVE" },
  ]);
});

test("N11: the agency's state and agreements are the OWNER's decisions, and an approval is recorded only by an ACTIVE approving membership of the acting session and withdrawn only by its controller", async () => {
  // a non-owner session moves the agency (the version bump and its event are present, so only the boundary refuses it)
  const moveAgency = (sessionUser: string) =>
    tx(app, ctx(sessionUser), async (c) => {
      await c.query("UPDATE kauro.agencies SET terms_version = 'T-PROBE', version = version + 1 WHERE agency_id = $1", [A.agencyId]);
      const v = (await c.query<{ version: string }>("SELECT version FROM kauro.agencies WHERE agency_id = $1", [A.agencyId])).rows[0]!.version;
      await event(c, { aggregateKind: "agency", aggregateId: A.agencyId, aggregateVersion: Number(v), agencyId: A.agencyId, eventType: "agency.activated.v1", actorUserId: sessionUser, payload: { agencyId: A.agencyId } });
    });
  await assert.rejects(moveAgency(admin), refusedWith("KA010"));
  await assert.rejects(moveAgency(viewer), refusedWith("KA010"));
  await moveAgency(owner);
  // an approval by an ACTIVE member whose role does not approve (the ADMIN, with a fresh proof of itself): refused by the
  // insert policy; the APPROVER's own approval commits
  const p: PlanFixture & { receiptHash?: string } = await plan({ app, control }, A, projectA, "VALIDATED", "n11-approval", validator);
  const approveAs = (sessionUser: string, membershipId: string, proof: string) =>
    tx(app, ctx(sessionUser), async (c) => {
      const approvalId = ids.next();
      await c.query(
        `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
        [approvalId, A.agencyId, p.planId, sessionUser, membershipId, proof, p.bodyHash, p.revisionHash, p.targetContractHash, p.receiptHash, sha("d-" + approvalId), sha("a-" + approvalId)],
      );
      await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actorUserId: sessionUser, payload: { approvalId } });
      await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = 5 WHERE plan_id = $1 AND version = 4", [p.planId, approvalId]);
      await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 5, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: sessionUser, payload: { planId: p.planId } });
      return approvalId;
    });
  await assert.rejects(approveAs(admin, adminMembership, await stepUpProof(assurance, { userId: admin })), refusedWith("42501"));
  const approvalId = await approveAs(approver, approverMembership, await stepUpProof(assurance, { userId: approver }));
  // the ADMIN withdraws it under its own membership: it neither approved it nor owns the agency (D-AUTHZ-3)
  const withdrawAs = (sessionUser: string, membershipId: string) =>
    tx(app, ctx(sessionUser), async (c) => {
      await c.query("UPDATE kauro.approvals SET withdrawn_at = now(), withdrawn_by_membership_id = $2, withdraw_reason_code = 'Probe', version = 2 WHERE approval_id = $1", [approvalId, membershipId]);
      await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "approval.withdrawn.v1", actorUserId: sessionUser, payload: { approvalId } });
      await c.query("UPDATE kauro.plans SET state = 'WITHDRAWN', version = 6 WHERE plan_id = $1 AND version = 5", [p.planId]);
      await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 6, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actorUserId: sessionUser, payload: { planId: p.planId } });
    });
  await assert.rejects(withdrawAs(admin, adminMembership), refusedWith("42501"));
  await withdrawAs(approver, approverMembership);
});
