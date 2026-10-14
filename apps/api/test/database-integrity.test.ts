// Database integrity at the command boundary (B06 review, database-integrity findings whose symptom showed through the routes:
// R3, R4, R11, and the evidence CMD025 checks, R14/R30). Real routes, real composition root, real PostgreSQL 17 (the fixture
// of support.ts); every forbidden write is performed as the runtime role that would perform it and refused, and the command
// that the forbidden write used to break is then answered through its route.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ArchiveClientView, EndClientView } from "@kauro/application";
import type { ProjectId } from "@kauro/domain";
import { approveThroughRoute, call, completed, freshKey, ids, rawEvent, routes, sha, world, type World } from "./support.js";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world();
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

function sqlStateOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

function constraintOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "constraint" in e ? String((e as { constraint: unknown }).constraint) : undefined;
}

test("R3: agency A's runtime role cannot occupy the next version of B's client; B's owner then archives it through CMD010 (200, version 2)", async () => {
  // the refuter's F7: under A's tenant context, an end_client.archived.v1 event naming B's client at version 2
  await assert.rejects(
    w.asTenant(w.A, (c) =>
      rawEvent(c, { aggregateKind: "end_client", aggregateId: w.clientB, aggregateVersion: 2, agencyId: w.A.agencyId, eventType: "end_client.archived.v1", actorUserId: w.owner.userId, payload: { clientId: w.clientB } }),
    ),
    (e: unknown) => sqlStateOf(e) === "KA006",
  );
  assert.equal(await w.count("domain_events", "aggregate_id = $1", [w.clientB]), 1, "only B's own created event names B's client");
  const archived = completed<ArchiveClientView>(await call(w, { url: routes.archiveClient(w.clientB), token: w.stranger.token, agency: w.B.agencyId, key: freshKey("r3-archive"), body: { expectedVersion: 1 } }), 200);
  assert.deepEqual({ state: archived.data.client.state, version: archived.data.client.version }, { state: "ARCHIVED", version: 2 });
  const events = await w.events("end_client", w.clientB);
  assert.deepEqual(events.map((e) => [e.version, e.type]), [[1, "end_client.created.v1"], [2, "end_client.archived.v1"]]);
  assert.equal(w.internalErrors.length, 0);
});

test("R4: a client created through CMD009 journals its label; the control pool reads the journal's metadata of that entry but never its response", async () => {
  const key = freshKey("r4-confidential");
  const created = completed<EndClientView>(await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, key, body: { displayName: "Confidential End Client Label", processingAuthorityRef: w.authorityA } }), 201);
  const c = await w.h.controlPool.connectUnverified();
  try {
    const meta = await c.query("SELECT state, operation, response_status, resource_kind FROM kauro.command_journal WHERE resource_id = $1", [created.data.clientId]);
    assert.deepEqual(meta.rows, [{ state: "COMMITTED", operation: "CMD009", response_status: 201, resource_kind: "end_client" }]);
    // the refuter's F3
    await assert.rejects(c.query("SELECT response_body->>'displayName' AS label FROM kauro.command_journal WHERE response_body->>'displayName' IS NOT NULL"), (e: unknown) => sqlStateOf(e) === "42501");
    await assert.rejects(c.query("SELECT display_name FROM kauro.end_clients"), (e: unknown) => sqlStateOf(e) === "42501");
  } finally {
    c.release();
  }
  // the label is still what the replay answers: the journal keeps the response for its own identity
  const replay = await call(w, { url: routes.createClient(w.A.agencyId), token: w.operator.token, agency: null, key, body: { displayName: "Confidential End Client Label", processingAuthorityRef: w.authorityA } });
  assert.equal(completed<EndClientView>(replay, 201).data.displayName, "Confidential End Client Label");
});

test("R11: plan X approved through CMD025; plan Y cannot be pointed at X's approval, and CMD025 then approves Y with an approval of its own", async () => {
  const x = await w.approvable(w.A, projectId, "r11-route-x");
  // one current contract per project (migration 0073 rule (c)): Y has a project of its own, so X's target stays current
  const yProjectId = (await w.project(w.A, w.clientA)).projectId;
  const y = await w.approvable(w.A, yProjectId, "r11-route-y");
  const ax = await approveThroughRoute(w, x);
  // the review's PROBE-4
  await assert.rejects(
    w.asTenant(w.A, async (c) => {
      await c.query("UPDATE kauro.plans SET state = 'APPROVED', approval_id = $2, version = version + 1 WHERE plan_id = $1", [y.planId, ax.data.approval.approvalId]);
      await rawEvent(c, { aggregateKind: "plan", aggregateId: y.planId, aggregateVersion: 5, agencyId: w.A.agencyId, eventType: "plan.approved.v1", actorUserId: w.owner.userId, payload: { planId: y.planId, agencyId: w.A.agencyId, approvalId: ax.data.approval.approvalId, approvalHash: ax.data.approval.approvalHash } });
    }),
    (e: unknown) => sqlStateOf(e) === "23503" && constraintOf(e) === "plans_approval_fk",
  );
  const stillY = await w.row<{ state: string; version: string; approval_id: string | null }>("plans", "plan_id = $1", [y.planId]);
  assert.deepEqual(stillY && { state: stillY.state, version: stillY.version, approval: stillY.approval_id }, { state: "VALIDATED", version: "4", approval: null });
  const ay = await approveThroughRoute(w, y);
  assert.notEqual(ay.data.approval.approvalId, ax.data.approval.approvalId);
  const approvedY = await w.row<{ approval_id: string }>("plans", "plan_id = $1", [y.planId]);
  assert.equal(approvedY?.approval_id, ay.data.approval.approvalId);
});

test("R14/R30: the request-handler role cannot mint the evidence CMD025 checks — a step-up proof or a VALID receipt — while the verifier's proof and the validator's receipt admit the approval", async () => {
  const plan = await w.approvable(w.A, projectId, "r14-r30-route");
  await assert.rejects(
    w.asTenant(w.A, (c) =>
      c.query(
        `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
         VALUES ($1, $2, 'STEP_UP', 'TOTP', now(), now() + interval '15 minutes', $3, now())`,
        [ids.next(), w.owner.userId, ids.next()],
      ),
    ),
    (e: unknown) => sqlStateOf(e) === "42501",
  );
  await assert.rejects(
    w.asTenant(w.A, (c) =>
      c.query(
        `INSERT INTO kauro.validation_receipts (receipt_id, agency_id, plan_id, receipt_hash, revision_hash, target_contract_hash, plan_hash, core_package_hash, profile_evidence_hash, disposition_evidence_hash, artifact_evidence_hash, started_at, completed_at, result, counts, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8, now() - interval '1 minute', now(), 'VALID', '{}'::jsonb, now())`,
        [ids.next(), w.A.agencyId, plan.planId, sha("minted-receipt"), plan.revisionHash, plan.targetContractHash, plan.bodyHash, sha("x")],
      ),
    ),
    (e: unknown) => sqlStateOf(e) === "42501",
  );
  assert.equal(await w.count("validation_receipts", "plan_id = $1", [plan.planId]), 1, "only the validator's receipt exists");
  const approved = await approveThroughRoute(w, plan);
  assert.equal(approved.data.plan.state, "APPROVED");
  assert.equal(approved.data.approval.validationReceiptHash, plan.receiptHash);
});
