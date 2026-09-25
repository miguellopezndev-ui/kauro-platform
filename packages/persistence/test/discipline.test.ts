// Transaction discipline on real PostgreSQL 17 (07 "Transaction discipline": a successful command commits state, domain event
// and outbox record atomically; aggregate versions and event sequence numbers establish concurrency order; unique constraints
// close races; reference/TRANSITIONS_AND_EVENT_EFFECTS.md: unlisted edges are rejected; 07 "Audit and plan states": a plan
// revision is immutable after validation/approval; approvals bind exact plan/source/target/receipt hashes; S051: two
// edits/approvals racing on one aggregate version yield one valid transition and a clear stale-version conflict).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { AgencyId, MembershipId, NewPlanRevision, PlanBody, PlanId, ProjectId } from "@kauro/domain";
import { ConstraintViolation, PgPlanRepository } from "../src/index.js";
import { startTemporaryPostgres, waitForLockWait, type TemporaryPostgres } from "../src/testing/index.js";
import { agency, bind, clock, constraintOf, endClient, event, ids, offeredCapability, person, plan, planBody, processingAuthority, project, sealedSource, sha, sqlState, stepUpProof, targetContract, tx, type AgencyFixture, type Person } from "./support.js";

let pg: TemporaryPostgres;
let app: Client;
let control: Client;
let validator: Client;
let assurance: Client;
let oracle: Client;
let owner: Person;
let A: AgencyFixture;
let clientId: string;
let projectId: string;

before(async () => {
  pg = await startTemporaryPostgres();
  app = await pg.connect("kauro_app_test");
  control = await pg.connect("kauro_control_test");
  validator = await pg.connect("kauro_validator_test");
  assurance = await pg.connect("kauro_assurance_test");
  oracle = await pg.connect("postgres");
  owner = await person(app, "owner-discipline");
  A = await agency(app, owner, "Discipline Agency");
  const authority = await processingAuthority(app, A);
  clientId = await endClient(app, A, authority);
  const capability = await offeredCapability(control, "CLEAN");
  projectId = (await project(app, A, clientId, capability)).projectId;
});
after(async () => {
  await app.end();
  await control.end();
  await validator.end();
  await assurance.end();
  await oracle.end();
  await pg.stop();
});

test("an aggregate change without a version bump, a version skip, or a version bump without its event cannot commit", async () => {
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.end_clients SET display_name = 'Renamed' WHERE client_id = $1", [clientId])),
    (e: unknown) => sqlState(e) === "KA002",
  );
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.end_clients SET display_name = 'Renamed', version = 3 WHERE client_id = $1", [clientId])),
    (e: unknown) => sqlState(e) === "KA002",
  );
  // the bump itself succeeds inside the transaction; the deferred constraint refuses the commit without the event (KA003)
  await app.query("BEGIN");
  await bind(app, { agencyId: A.agencyId, userId: owner.userId });
  await app.query("UPDATE kauro.end_clients SET display_name = 'Renamed', version = 2 WHERE client_id = $1", [clientId]);
  await assert.rejects(app.query("COMMIT"), (e: unknown) => sqlState(e) === "KA003");
  const untouched = await oracle.query("SELECT display_name, version FROM kauro.end_clients WHERE client_id = $1", [clientId]);
  assert.deepEqual(untouched.rows[0], { display_name: "Client One", version: "1" });
  // and an insert without its event is refused the same way (CMD009 atomicity)
  await app.query("BEGIN");
  await bind(app, { agencyId: A.agencyId, userId: owner.userId });
  const authority = (await app.query("SELECT processing_authority_id FROM kauro.processing_authorities LIMIT 1")).rows[0].processing_authority_id as string;
  await app.query(
    "INSERT INTO kauro.end_clients (client_id, agency_id, display_name, processing_authority_ref, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, 'No event', $3, $4, now(), now())",
    [ids.next(), A.agencyId, authority, A.ownerMembershipId],
  );
  await assert.rejects(app.query("COMMIT"), (e: unknown) => sqlState(e) === "KA003");
  const count = await oracle.query("SELECT count(*)::int AS n FROM kauro.end_clients WHERE agency_id = $1", [A.agencyId]);
  assert.equal(count.rows[0].n, 1);
});

test("unlisted transitions and immutable columns are refused; archiving (CMD010) is the listed edge and deletes nothing", async () => {
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
      await c.query("UPDATE kauro.agencies SET state = 'CLOSED', version = 2 WHERE agency_id = $1", [A.agencyId]);
    }),
    (e: unknown) => sqlState(e) === "KA008",
  );
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
      await c.query("UPDATE kauro.end_clients SET processing_authority_ref = $2, version = 2 WHERE client_id = $1", [clientId, ids.next()]);
    }),
    (e: unknown) => sqlState(e) === "KA004",
  );
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    const r = await c.query("UPDATE kauro.end_clients SET state = 'ARCHIVED', archived_at = now(), version = version + 1 WHERE client_id = $1 AND version = 1 RETURNING version", [clientId]);
    assert.equal(r.rowCount, 1);
    await event(c, { aggregateKind: "end_client", aggregateId: clientId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "end_client.archived.v1", actorUserId: owner.userId, payload: { clientId, agencyId: A.agencyId, openProjects: 1 } });
  });
  const after = await oracle.query("SELECT (SELECT state FROM kauro.end_clients WHERE client_id = $1) AS client_state, (SELECT count(*)::int FROM kauro.projects WHERE client_id = $1) AS projects, (SELECT count(*)::int FROM kauro.dataset_revisions WHERE project_id = $2) AS revisions", [clientId, projectId]);
  assert.deepEqual(after.rows[0], { client_state: "ARCHIVED", projects: 1, revisions: 1 });
  // a stale expected version touches nothing and the current safe version is readable (10 "Concurrency and preconditions")
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    const stale = await c.query("UPDATE kauro.end_clients SET state = 'ARCHIVED', version = version + 1 WHERE client_id = $1 AND version = 1", [clientId]);
    assert.equal(stale.rowCount, 0);
    const current = await c.query("SELECT version, state FROM kauro.end_clients WHERE client_id = $1", [clientId]);
    assert.deepEqual(current.rows[0], { version: "2", state: "ARCHIVED" });
  });
});

test("S051: two revisions racing on one plan version through the plan adapter — one compare-and-swap applies, the loser waits on the row lock and reads STALE with the current version; a second successor of the same predecessor is refused by plans_supersedes_once", async () => {
  // S051 "Two edits/approvals race on one aggregate version" → "One valid transition and a clear stale-version conflict"
  // (07 "Transaction discipline": compare-and-swap on the expected version, unique constraints close races; design §5 "one
  // revision supersedes a predecessor: CAS on the predecessor version + plans_supersedes_once"). The subject is the product's
  // PgPlanRepository (transition = the CAS, insert = the successor) on two real connections of the runtime role.
  const p = await plan(app, A, projectId, "VALIDATION_REQUIRED", "race");
  assert.equal(p.version, 2);
  const ctx = { agencyId: A.agencyId, userId: owner.userId };
  // the repository derives the body hash from the body (re-check finding N10); the label only names the successor in the test
  const successorOf = (planId: string, _label: string): NewPlanRevision => {
    const body: PlanBody = { revisionHash: p.revisionHash, targetContractHash: p.targetContractHash, policyHash: sha("policy"), mappings: [], identities: [], transforms: [], relationships: [] };
    return { planId: planId as PlanId, agencyId: A.agencyId as AgencyId, projectId: projectId as ProjectId, body, supersedesPlanId: p.planId as PlanId, createdByMembershipId: A.ownerMembershipId as MembershipId, createdAt: clock.now() };
  };
  const successor1 = ids.next();
  const successor2 = ids.next();
  const c1 = await pg.connect("kauro_app_test");
  const c2 = await pg.connect("kauro_app_test");
  try {
    await c2.query("SET application_name = 'kauro-test-s051-loser'");
    await c1.query("BEGIN");
    await c2.query("BEGIN");
    await bind(c1, ctx);
    await bind(c2, ctx);
    const plansA = new PgPlanRepository(c1);
    const plansB = new PgPlanRepository(c2);
    // A: the CAS on version 2 applies (SUPERSEDED v3 naming its successor) and holds the row lock
    const a = await plansA.transition(p.planId as PlanId, 2, { state: "SUPERSEDED", supersededByPlanId: successor1 as PlanId }, clock.now());
    assert.equal(a.kind, "APPLIED");
    if (a.kind === "APPLIED") assert.deepEqual([a.record.version, a.record.state, a.record.supersededByPlanId], [3, "SUPERSEDED", successor1]);
    // B: the same CAS on version 2 blocks on the row lock (observed; a wait that never happens fails the test here)
    const b = plansB.transition(p.planId as PlanId, 2, { state: "SUPERSEDED", supersededByPlanId: successor2 as PlanId }, clock.now());
    await waitForLockWait(oracle, "kauro-test-s051-loser", "UPDATE kauro.plans");
    // A inserts the successor through the adapter, publishes the events of both versions and commits
    await plansA.insert(successorOf(successor1, "body-2"));
    await event(c1, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: 3, agencyId: A.agencyId, eventType: "plan.superseded.v1", actorUserId: owner.userId, payload: { planId: p.planId, agencyId: A.agencyId, successorPlanId: successor1 } });
    await event(c1, { aggregateKind: "plan", aggregateId: successor1, aggregateVersion: 1, agencyId: A.agencyId, eventType: "plan.created.v1", actorUserId: owner.userId, payload: { planId: successor1, agencyId: A.agencyId, projectId, bodyHash: sha("body-2"), supersedesPlanId: p.planId } });
    await c1.query("COMMIT");
    // B re-evaluates its predicate against the committed row: nothing applies, and the answer is the current safe version
    assert.deepEqual(await b, { kind: "STALE", currentVersion: 3, currentState: "SUPERSEDED" });
    await c2.query("ROLLBACK");
  } finally {
    await c1.end();
    await c2.end();
  }
  // plans_supersedes_once: even a writer that skipped the CAS cannot attach a second successor to the predecessor. The insert
  // is refused at the statement (23505 on the index), with the event of its version present so that nothing but the index
  // could refuse the transaction.
  await assert.rejects(
    tx(app, ctx, async (c) => {
      await new PgPlanRepository(c).insert(successorOf(successor2, "body-3"));
      await event(c, { aggregateKind: "plan", aggregateId: successor2, aggregateVersion: 1, agencyId: A.agencyId, eventType: "plan.created.v1", actorUserId: owner.userId, payload: { planId: successor2, agencyId: A.agencyId, projectId, bodyHash: sha("body-3"), supersedesPlanId: p.planId } });
    }),
    (e: unknown) => e instanceof ConstraintViolation && e.sqlState === "23505" && e.constraint === "plans_supersedes_once",
  );
  const lineage = await oracle.query("SELECT plan_id FROM kauro.plans WHERE supersedes_plan_id = $1", [p.planId]);
  assert.deepEqual(lineage.rows, [{ plan_id: successor1 }]);
  const predecessor = await oracle.query("SELECT version, state, superseded_by_plan_id FROM kauro.plans WHERE plan_id = $1", [p.planId]);
  assert.deepEqual(predecessor.rows[0], { version: "3", state: "SUPERSEDED", superseded_by_plan_id: successor1 });
});

test("an approval binds exact plan/source/target/receipt hashes; a foreign or stale hash cannot be recorded; one live approval per plan", async () => {
  const p = await plan(app, A, projectId, "VALIDATED", "approve", validator);
  const proof = await stepUpProof(assurance, owner);
  const insertApproval = (c: Client, id: string, overrides: Partial<Record<"planHash" | "receiptHash" | "revisionHash", string>>) =>
    c.query(
      `INSERT INTO kauro.approvals (approval_id, agency_id, plan_id, actor_id, actor_membership_id, actor_membership_version, assurance_proof_ref, plan_hash, revision_hash, target_contract_hash, validation_receipt_hash, disclosures_hash, approval_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
      [id, A.agencyId, p.planId, owner.userId, A.ownerMembershipId, proof, overrides.planHash ?? p.bodyHash, overrides.revisionHash ?? p.revisionHash, p.targetContractHash, overrides.receiptHash ?? p.receiptHash, sha("disclosures"), sha("approval-" + id)],
    );
  // stale plan hash (the UI approved different content)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => insertApproval(c, ids.next(), { planHash: sha("other body") })),
    (e: unknown) => sqlState(e) === "23503",
  );
  // stale receipt hash (a receipt for different inputs)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => insertApproval(c, ids.next(), { receiptHash: sha("other receipt") })),
    (e: unknown) => sqlState(e) === "23503",
  );
  // the exact bindings commit together with the plan transition and the events (CMD025 effect)
  const approvalId = ids.next();
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    await insertApproval(c, approvalId, {});
    await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = version + 1 WHERE plan_id = $1 AND version = $3", [p.planId, approvalId, p.version]);
    await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "approval.created.v1", actorUserId: owner.userId, payload: { approvalId, agencyId: A.agencyId, planId: p.planId, planHash: p.bodyHash } });
    await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: p.version + 1, agencyId: A.agencyId, eventType: "plan.approved.v1", actorUserId: owner.userId, payload: { planId: p.planId, agencyId: A.agencyId, approvalId } });
  });
  // a second live approval of the same plan is refused by the partial unique index (CMD025-RACE: no duplicate authority)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => insertApproval(c, ids.next(), {})),
    (e: unknown) => sqlState(e) === "23505" && constraintOf(e) === "approvals_one_live_per_plan",
  );
  // the approval record is immutable except its single withdrawal; withdrawal never deletes history (CMD026)
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.approvals SET disclosures_hash = $2, version = 2 WHERE approval_id = $1", [approvalId, sha("x")])),
    (e: unknown) => sqlState(e) === "KA004",
  );
  await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    await c.query("UPDATE kauro.approvals SET withdrawn_at = now(), withdrawn_by_membership_id = $2, withdraw_reason_code = 'SCOPE_CHANGED', version = 2 WHERE approval_id = $1", [approvalId, A.ownerMembershipId]);
    await c.query("UPDATE kauro.plans SET state = 'WITHDRAWN', version = version + 1 WHERE plan_id = $1", [p.planId]);
    await event(c, { aggregateKind: "approval", aggregateId: approvalId, aggregateVersion: 2, agencyId: A.agencyId, eventType: "approval.withdrawn.v1", actorUserId: owner.userId, payload: { approvalId, agencyId: A.agencyId, planId: p.planId, reasonCode: "SCOPE_CHANGED" } });
    await event(c, { aggregateKind: "plan", aggregateId: p.planId, aggregateVersion: p.version + 2, agencyId: A.agencyId, eventType: "plan.withdrawn.v1", actorUserId: owner.userId, payload: { planId: p.planId, agencyId: A.agencyId, approvalId } });
  });
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.approvals SET withdrawn_at = NULL, withdrawn_by_membership_id = NULL, withdraw_reason_code = NULL, version = 3 WHERE approval_id = $1", [approvalId])),
    (e: unknown) => sqlState(e) === "KA004",
  );
  const history = await oracle.query("SELECT state FROM kauro.plans WHERE plan_id = $1", [p.planId]);
  assert.equal(history.rows[0].state, "WITHDRAWN");
  const receipts = await oracle.query("SELECT count(*)::int AS n FROM kauro.validation_receipts WHERE plan_id = $1", [p.planId]);
  assert.equal(receipts.rows[0].n, 1, "receipts survive withdrawal");
  // approving a withdrawn (or superseded) plan is an unlisted edge
  await assert.rejects(
    tx(app, { agencyId: A.agencyId, userId: owner.userId }, (c) => c.query("UPDATE kauro.plans SET state = 'APPROVED', version = version + 1 WHERE plan_id = $1", [p.planId])),
    (e: unknown) => sqlState(e) === "KA008",
  );
});

test("outbox records commit with their event under the tenant policy and can only name events of the bound tenant", async () => {
  const other = await person(app, "other-outbox");
  const B = await agency(app, other, "Other Agency");
  // the plan names a sealed source and a confirmed target of its own project (plans_source_fk, plans_target_fk)
  const source = await sealedSource(app, A, projectId, "outbox");
  const target = await targetContract(app, A, projectId, "outbox");
  const eventId = await tx(app, { agencyId: A.agencyId, userId: owner.userId }, async (c) => {
    // plan.created for a new plan is the simplest fresh event of this agency
    const planId = ids.next();
    await c.query(
      "INSERT INTO kauro.plans (plan_id, agency_id, project_id, revision_hash, target_contract_hash, policy_hash, body, body_hash, created_by_membership_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now(), now())",
      [planId, A.agencyId, projectId, source.manifestHash, target.bodyHash, sha("p"), JSON.stringify(planBody(source.manifestHash, target.bodyHash, sha("p"))), sha("b-" + planId), A.ownerMembershipId],
    );
    const id = await event(c, { aggregateKind: "plan", aggregateId: planId, aggregateVersion: 1, agencyId: A.agencyId, eventType: "plan.created.v1", actorUserId: owner.userId, payload: { planId, agencyId: A.agencyId, projectId, bodyHash: sha("b-" + planId) } });
    await c.query("INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'EXECUTION_CONTROL', now(), now(), now())", [ids.next(), id]);
    return id;
  });
  const pending = await oracle.query("SELECT state, consumer FROM kauro.outbox_records WHERE event_id = $1", [eventId]);
  assert.deepEqual(pending.rows, [{ state: "PENDING", consumer: "EXECUTION_CONTROL" }]);
  // agency B cannot enqueue a record for an event of agency A
  await assert.rejects(
    tx(app, { agencyId: B.agencyId, userId: other.userId }, (c) => c.query("INSERT INTO kauro.outbox_records (outbox_id, event_id, consumer, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'NOTIFICATIONS', now(), now(), now())", [ids.next(), eventId])),
    (e: unknown) => sqlState(e) === "42501",
  );
  // the control plane sees every pending record across tenants and delivers at least once; a delivered record stays delivered
  const seen = await control.query("SELECT count(*)::int AS n FROM kauro.outbox_records WHERE state = 'PENDING'");
  assert.equal(seen.rows[0].n, 1);
  await control.query("UPDATE kauro.outbox_records SET state = 'DELIVERED', delivered_at = now(), attempts = 1 WHERE event_id = $1", [eventId]);
  await assert.rejects(control.query("UPDATE kauro.outbox_records SET state = 'PENDING', delivered_at = NULL WHERE event_id = $1", [eventId]), (e: unknown) => sqlState(e) === "KA007");
  // events are append-only for everyone
  await assert.rejects(control.query("DELETE FROM kauro.domain_events WHERE event_id = $1", [eventId]), (e: unknown) => sqlState(e) === "42501" || sqlState(e) === "KA004");
  await assert.rejects(oracle.query("UPDATE kauro.domain_events SET payload = '{}' WHERE event_id = $1", [eventId]), (e: unknown) => sqlState(e) === "KA004");
});
