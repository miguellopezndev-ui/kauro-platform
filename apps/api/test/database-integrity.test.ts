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
