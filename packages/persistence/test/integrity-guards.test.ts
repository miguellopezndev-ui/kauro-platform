// Database integrity guards on real PostgreSQL 17 (B06 review, database-integrity findings R3, R4, R5/R13, R6, R10, R11, R14,
// R20, R30). Each guard is proven by the forbidden write performed AS THE RUNTIME ROLE that would perform it — the request
// handlers (kauro_app_test) or the control plane (kauro_control_test) — and refused, beside the legitimate write that still
// commits (21 "Positive and negative symmetry"; 08 "Database isolation": the runtime role is the boundary, "Application checks
// improve messages but cannot be the sole protection", 07 "Transaction discipline").
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, type ClientId, type MembershipId, type UserId } from "@kauro/domain";
import { PrivilegedRoleError, ROLES, createPool, createUnitOfWorkFactory } from "../src/index.js";
import { clock, start, type AgencyFixture, type Harness } from "../src/testing/harness.js";
import { constraintOf, event, ids, plan, project, sha, sqlState, stepUpProof, tx, validationReceipt, type PlanFixture } from "./support.js";

let h: Harness;
let app: Client;
let control: Client;
let assurance: Client;
let validator: Client;
let alice: UserId;
let bob: UserId;
let approver: UserId;
let A: AgencyFixture;
let B: AgencyFixture;
let approverMembership: MembershipId;
let clientA: ClientId;
let clientB: ClientId;
let projectA: string;

before(async () => {
  h = await start();
  app = await h.pg.connect("kauro_app_test");
  control = await h.pg.connect("kauro_control_test");
  assurance = await h.pg.connect("kauro_assurance_test");
  validator = await h.pg.connect("kauro_validator_test");
  alice = await h.person("alice-guards");
  bob = await h.person("bob-guards");
  approver = await h.person("approver-guards");
  A = await h.createAgency(alice, "Guards A");
  B = await h.createAgency(bob, "Guards B");
  approverMembership = await h.addMember(A, approver, "APPROVER");
  clientA = await h.endClient(A, await h.processingAuthority(A), "Client A");
  clientB = await h.endClient(B, await h.processingAuthority(B), "Client B");
  const capability = await h.offeredCapability("CLEAN");
  projectA = (await project(app, A, clientA, capability)).projectId;
});
after(async () => {
  await app.end();
  await control.end();
  await assurance.end();
  await validator.end();
  await h.stop();
});

const refusedWith = (code: string, constraint?: string) => (e: unknown): boolean => sqlState(e) === code && (constraint === undefined || constraintOf(e) === constraint);

/** The tenant context (agency + acting identity) a raw transaction binds. */
function ctx(agency: AgencyFixture, userId: string): { readonly agencyId: string; readonly userId: string } {
  return { agencyId: agency.agencyId, userId };
}

test("R14: step-up proofs are written only by the step-up verifier — the request handlers cannot mint one, not even their own; the verifier writes only for the identity it binds and reads nothing", async () => {
  const insertProof = (c: Client, userId: string) =>
    c.query(
      `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
       VALUES ($1, $2, 'STEP_UP', 'TOTP', now(), now() + interval '15 minutes', $3, now())`,
      [ids.next(), userId, ids.next()],
    );
  await assert.rejects(tx(app, { userId: approver }, (c) => insertProof(c, approver)), refusedWith("42501"), "IDENTITY context");
  await assert.rejects(tx(app, ctx(A, approver), (c) => insertProof(c, approver)), refusedWith("42501"), "TENANT context");
  const proof = await stepUpProof(assurance, { userId: approver });
  const own = await tx(app, { userId: approver }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]));
  assert.deepEqual(own.rows, [{ proof_id: proof }], "the request handlers read the proofs of the identity they serve");
  const foreign = await tx(app, { userId: alice }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs WHERE proof_id = $1", [proof]));
  assert.deepEqual(foreign.rows, []);
  await assert.rejects(tx(assurance, { userId: approver }, (c) => insertProof(c, alice)), refusedWith("42501"), "a proof for an identity the verifier did not bind");
  await assert.rejects(tx(assurance, { userId: approver }, (c) => c.query("SELECT proof_id FROM kauro.assurance_proofs")), refusedWith("42501"));
});

test("R14/R30: a verifier or validator login is its own runtime group — it runs no request-handler unit of work, and a login in two groups is refused by the verified pool", async () => {
  const proofs = await h.assurancePool.acquire();
  assert.deepEqual(proofs.connection, { role: "kauro_assurance", loginRole: ROLES.assuranceLogin });
  proofs.client.release();
  const receipts = await h.validatorPool.acquire();
  assert.deepEqual(receipts.connection, { role: "kauro_validator", loginRole: ROLES.validatorLogin });
  receipts.client.release();
  for (const pool of [h.assurancePool, h.validatorPool]) {
    const uow = createUnitOfWorkFactory(pool, { clock });
    await assert.rejects(uow.run(h.identity(approver), async () => undefined), (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE");
    await assert.rejects(uow.run(h.system(), async () => undefined), (e: unknown) => isDomainFailure(e) && e.code === "INTEGRITY_FAILURE");
  }
  await h.oracle.query(`CREATE ROLE kauro_dual_test LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}, ${ROLES.assurance}`);
  const dual = createPool({ host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: "kauro_dual_test", max: 1, applicationName: "kauro-test-dual" });
  try {
    await assert.rejects(dual.acquire(), (e: unknown) => e instanceof PrivilegedRoleError && /more than one runtime group/.test(e.message));
    assert.equal(dual.totalCount, 0, "the connection was destroyed, not pooled");
  } finally {
    await dual.end();
  }
});

test("R20: every aggregate is born in its machine's initial state — a row inserted in a later state is refused as the runtime role that would write it (KA008)", async () => {
  const bornLater = (label: string, run: Promise<unknown>) => assert.rejects(run, refusedWith("KA008"), label);
  // Agency born ACTIVE with every agreement present, so only the birth rule refuses it
  const frank = await h.person("frank-guards");
  const agencyId = ids.next();
  await bornLater(
    "Agency ACTIVE",
    tx(app, { agencyId, userId: frank }, (c) =>
      c.query(
        "INSERT INTO kauro.agencies (agency_id, display_name, state, terms_version, privacy_agreement_version, legal_profile_ref, created_by_user_id, created_at, updated_at) VALUES ($1, 'Born active', 'ACTIVE', 'T-1', 'P-1', $2, $3, now(), now())",
        [agencyId, ids.next(), frank],
      ),
    ),
  );
  // Membership born ACTIVE or SUSPENDED in an agency that has members
  const gina = await h.person("gina-guards");
  for (const state of ["ACTIVE", "SUSPENDED"]) {
    await bornLater(
      `Membership ${state}`,
      tx(app, ctx(A, alice), (c) =>
        c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, 'ADMIN', $4, 'MFA_REQUIRED', now(), now(), now())", [ids.next(), A.agencyId, gina, state]),
      ),
    );
  }
  // EndClient born ARCHIVED
  const authority = (await h.oracle.query("SELECT processing_authority_id FROM kauro.processing_authorities WHERE agency_id = $1 LIMIT 1", [A.agencyId])).rows[0].processing_authority_id as string;
  await bornLater(
    "EndClient ARCHIVED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, state, archived_at, created_at, updated_at) VALUES ($1, $2, 'Born archived', $3, $4, 'ARCHIVED', now(), now(), now())",
        [ids.next(), A.agencyId, authority, A.ownerMembershipId],
      ),
    ),
  );
  // Project born CLOSED
  const capability = (await h.oracle.query("SELECT capability_id FROM kauro.capabilities WHERE mode = 'CLEAN' LIMIT 1")).rows[0].capability_id as string;
  await bornLater(
    "Project CLOSED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.projects (project_id, agency_id, client_id, state, mode, purpose, capability_id, capability_version, current_revision_id, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, 'CLOSED', 'CLEAN', 'Born closed', $4, 'R2-INITIAL', $5, $6, now(), now())",
        [ids.next(), A.agencyId, clientA, capability, ids.next(), A.ownerMembershipId],
      ),
    ),
  );
  // DatasetRevision born SEALED (with every sealed binding present)
  await bornLater(
    "DatasetRevision SEALED",
    tx(app, ctx(A, alice), (c) =>
      c.query(
        "INSERT INTO kauro.dataset_revisions (revision_id, agency_id, project_id, state, manifest_hash, projection_hash, sealed_at, created_at, updated_at) VALUES ($1, $2, $3, 'SEALED', $4, $5, now(), now(), now())",
        [ids.next(), A.agencyId, projectA, sha("born-sealed-manifest"), sha("born-sealed-projection")],
      ),
    ),
  );
  // Plan born VALIDATING or WITHDRAWN (the review's reproduction)
  for (const state of ["VALIDATING", "WITHDRAWN"]) {
    await bornLater(
      `Plan ${state}`,
      tx(app, ctx(A, alice), (c) =>
        c.query(
          `INSERT INTO kauro.plans (plan_id, agency_id, project_id, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, '{"mappings":[]}', $8, $9, now(), now())`,
          [ids.next(), A.agencyId, projectA, state, sha("r"), sha("t"), sha("policy"), sha("born-" + state), A.ownerMembershipId],
        ),
      ),
    );
  }
  // Capability born AVAILABLE_LIMITED under a new revision label, with invented evidence, as the control plane
  await bornLater(
    "Capability AVAILABLE_LIMITED",
    control.query(
      `INSERT INTO kauro.capabilities (capability_id, version, kind, mode, state, profile_hash, qualification_evidence_hashes, valid_from, review_trigger, created_at, updated_at)
       VALUES ($1, 'R2-SHORTCUT', 'MODE', 'HUBSPOT', 'AVAILABLE_LIMITED', $2, $3::jsonb, now(), 'VENDOR_OR_ENVELOPE_CHANGE', now(), now())`,
      [ids.next(), sha("profile-shortcut"), JSON.stringify([sha("invented-evidence")])],
    ),
  );
  const counts = await h.oracle.query(
    `SELECT (SELECT count(*)::int FROM kauro.agencies WHERE agency_id = $1) AS agencies,
            (SELECT count(*)::int FROM kauro.memberships WHERE user_id = $2) AS memberships,
            (SELECT count(*)::int FROM kauro.end_clients WHERE agency_id = $3 AND state = 'ARCHIVED') AS archived,
            (SELECT count(*)::int FROM kauro.projects WHERE state <> 'OPEN') AS projects,
            (SELECT count(*)::int FROM kauro.dataset_revisions WHERE state = 'SEALED') AS sealed,
            (SELECT count(*)::int FROM kauro.capabilities WHERE mode = 'HUBSPOT') AS hubspot`,
    [agencyId, gina, A.agencyId],
  );
  assert.deepEqual(counts.rows[0], { agencies: 0, memberships: 0, archived: 0, projects: 0, sealed: 0, hubspot: 0 });
  // the positive symmetry: born in the initial state and walked along the listed edges, the same aggregates commit
  const walked = await h.sealedRevision(A, projectA as never, "SEALED");
  assert.equal(walked.version, 4, "DRAFT v1 -> INSPECTING v2 -> READY_TO_SEAL v3 -> SEALED v4");
  const capabilityId = await h.offeredCapability("HUBSPOT", "AVAILABLE_LIMITED", { version: "R2-WALKED" });
  const published = await h.oracle.query("SELECT state FROM kauro.capabilities WHERE capability_id = $1", [capabilityId]);
  assert.deepEqual(published.rows[0], { state: "AVAILABLE_LIMITED" });
});

test("R20: the founding owner of CreateAgency is the one membership born ACTIVE — a founding ADMIN, a founding owner for somebody else, an owner written by another session and a second owner are all refused", async () => {
  const hank = await h.person("hank-guards");
  const ivy = await h.person("ivy-guards");
  const found = (sessionUser: string, member: { readonly userId: string; readonly role: string }) => {
    const agencyId = ids.next();
    return tx(app, { agencyId, userId: sessionUser }, async (c) => {
      await c.query("INSERT INTO kauro.agencies (agency_id, display_name, created_by_user_id, created_at, updated_at) VALUES ($1, 'Founding probe', $2, now(), now())", [agencyId, hank]);
      await c.query(
        "INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, $4, 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())",
        [ids.next(), agencyId, member.userId, member.role],
      );
    });
  };
  await assert.rejects(found(hank, { userId: hank, role: "ADMIN" }), refusedWith("KA008"), "a founding ADMIN");
  await assert.rejects(found(hank, { userId: ivy, role: "OWNER" }), refusedWith("KA008"), "a founding owner who did not create the agency");
  await assert.rejects(found(ivy, { userId: hank, role: "OWNER" }), refusedWith("KA008"), "the creator's owner membership written by another identity's session");
  // a second ACTIVE OWNER born in an agency that already has its founder
  await assert.rejects(
    tx(app, ctx(A, alice), (c) =>
      c.query("INSERT INTO kauro.memberships (membership_id, agency_id, user_id, role, state, assurance_policy, accepted_at, created_at, updated_at) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', 'MFA_REQUIRED', now(), now(), now())", [ids.next(), A.agencyId, ivy]),
    ),
    refusedWith("KA008"),
  );
  // the exemption itself: CreateAgency as the handler performs it (adapter path) founds exactly one ACTIVE OWNER at version 1
  const founded = await h.createAgency(hank, "Founded");
  const row = await h.oracle.query("SELECT role, state, version FROM kauro.memberships WHERE membership_id = $1", [founded.ownerMembershipId]);
  assert.deepEqual(row.rows[0], { role: "OWNER", state: "ACTIVE", version: "1" });
});

test("R30: validation receipts are written only by the validator, under the plan's own tenant; a plan binds only a VALID receipt of its own body and subjects", async () => {
  const p = await plan(app, A, projectA, "VALIDATING", "r30-p");
  const insertReceipt = (c: Client, of: PlanFixture, receiptHash: string) =>
    c.query(
      `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - interval '1 minute', now(), 'VALID', '{"physicalSourceRows": 10}', now())`,
      [ids.next(), A.agencyId, of.planId, receiptHash, of.revisionHash, of.targetContractHash, of.bodyHash, sha("core"), sha("profile"), sha("disposition"), sha("artifact")],
    );
  // the review's reproduction: the request handlers mint a VALID receipt for their own tenant's plan
  await assert.rejects(tx(app, ctx(A, alice), (c) => insertReceipt(c, p, sha("minted"))), refusedWith("42501"));
  // the validator writes under the plan's tenant only, and reads nothing
  await assert.rejects(tx(validator, { agencyId: B.agencyId }, (c) => insertReceipt(c, p, sha("wrong-tenant"))), refusedWith("42501"));
  await assert.rejects(tx(validator, { agencyId: A.agencyId }, (c) => c.query("SELECT receipt_id FROM kauro.validation_receipts")), refusedWith("42501"));
  const receiptOfP = sha("r30-p-receipt");
  await validationReceipt(validator, A, p, receiptOfP);
  // plans_receipt_fk binds the plan: another plan cannot name p's receipt
  const q = await plan(app, A, projectA, "VALIDATING", "r30-q");
  const validate = (of: PlanFixture, receiptHash: string) =>
    tx(app, ctx(A, alice), async (c) => {
      await c.query("UPDATE kauro.plans SET state = 'VALIDATED', version = 4, validation_receipt_hash = $2 WHERE plan_id = $1 AND version = 3", [of.planId, receiptHash]);
      await event(c, { aggregateKind: "plan", aggregateId: of.planId, aggregateVersion: 4, agencyId: A.agencyId, eventType: "plan.validated.v1", actorUserId: alice, payload: { planId: of.planId, agencyId: A.agencyId, validationReceiptHash: receiptHash } });
    });
  await assert.rejects(validate(q, receiptOfP), refusedWith("23503", "plans_receipt_fk"));
  // an INVALID receipt of q is q's own, yet it cannot validate q (valid_receipt needs a complete VALID receipt)
  const invalidOfQ = sha("r30-q-invalid");
  await validationReceipt(validator, A, q, invalidOfQ, "INVALID");
  await assert.rejects(validate(q, invalidOfQ), refusedWith("KA008"));
  // the legitimate edge: p binds its own VALID receipt
  await validate(p, receiptOfP);
  const rows = await h.oracle.query("SELECT plan_id, state, validation_receipt_hash FROM kauro.plans WHERE plan_id = ANY($1::uuid[]) ORDER BY state", [[p.planId, q.planId]]);
  assert.deepEqual(rows.rows, [
    { plan_id: p.planId, state: "VALIDATED", validation_receipt_hash: receiptOfP },
    { plan_id: q.planId, state: "VALIDATING", validation_receipt_hash: null },
  ]);
});
