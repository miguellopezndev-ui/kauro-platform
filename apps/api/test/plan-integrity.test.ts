// RevisePlan never trusts the plan-side collaborator with the hash or the subject of the revision it stores (re-check finding
// N10; reference/HASHING_AND_ACCOUNTING_RULES: "the consumer recomputes the relevant preimage"; design §8 CMD023 step 8: the
// successor keeps the predecessor's revision, target and policy hashes; S051 "no approval of unseen new content"). The world
// binds a PlanPatchCompiler that lies on request — about the hash of the body it compiled, or by moving the body to another
// source — and otherwise delegates to the deterministic test compiler. Real routes, real composition root, real PostgreSQL 17.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PatchCompilation, RevisePlanView } from "@kauro/application";
import type { PlanBody, ProjectId } from "@kauro/domain";
import { bodyHashOf, call, completed, effectCounts, outcome, routes, sha, world, type World } from "./support.js";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world({
    collaborators: (base) => ({
      ...base,
      patchCompiler: {
        async apply(current: PlanBody, patch): Promise<PatchCompilation> {
          const candidate = (patch.document as { readonly candidate?: unknown }).candidate;
          if (candidate === "lie:hash") {
            // a changed body, answered with a hash that is not its digest
            const body: PlanBody = { ...current, mappings: current.mappings.map((m) => ({ ...m, intent: { ...m.intent, reasonCode: "LIED" } })) };
            return { kind: "COMPILED", body, bodyHash: sha("not-the-digest-of-the-body") };
          }
          if (typeof candidate === "string" && candidate.startsWith("lie:source:")) {
            // an honest hash of a body moved to another source
            const body: PlanBody = { ...current, revisionHash: candidate.slice("lie:source:".length) as PlanBody["revisionHash"] };
            return { kind: "COMPILED", body, bodyHash: bodyHashOf(body) };
          }
          return base.patchCompiler.apply(current, patch);
        },
      },
    }),
  });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

test("N10: a compiled body whose claimed hash is not its KAURO_PLAN_BODY_V1 digest is refused 422 INTEGRITY_FAILURE BODY_DIGEST_MISMATCH — no successor, nothing superseded, no journal row", async () => {
  const plan = await w.approvable(w.A, projectId, "n10-lie-hash");
  const before = await effectCounts(w);
  const reply = await call(w, { url: routes.revisePlan(plan.planId), token: w.operator.token, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "lie:hash", reasonCode: "X" }) } });
  assert.equal(outcome(w, reply), "422 INTEGRITY_FAILURE BODY_DIGEST_MISMATCH");
  assert.deepEqual(await effectCounts(w), before, "nothing was committed");
  const row = await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]);
  assert.deepEqual(row && { state: row.state, version: row.version }, { state: "VALIDATED", version: "4" });
});

test("N10: a compiled body moved to another source is refused 400 INVALID_REQUEST PATCH_EFFECT_NOT_PERMITTED on decisionPatchArtifactRef — a typed patch edits decisions, never the plan's subject", async () => {
  const other = await w.project(w.A, w.clientA);
  const otherSource = await w.revision(w.A, other.projectId);
  const plan = await w.approvable(w.A, projectId, "n10-lie-source");
  const before = await effectCounts(w);
  const reply = await call(w, { url: routes.revisePlan(plan.planId), token: w.operator.token, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: `lie:source:${otherSource.revisionHash}`, reasonCode: "X" }) } });
  assert.equal(outcome(w, reply), "400 INVALID_REQUEST PATCH_EFFECT_NOT_PERMITTED");
  assert.deepEqual((reply.json() as { errors?: unknown }).errors, [{ field: "decisionPatchArtifactRef", code: "PATCH_EFFECT_NOT_PERMITTED" }]);
  assert.deepEqual(await effectCounts(w), before, "nothing was committed");
});

test("N10 positive neighbour: an honest compilation is stored with the digest the repository computes, and the successor keeps the predecessor's subjects", async () => {
  const plan = await w.approvable(w.A, projectId, "n10-honest");
  const revised = completed<RevisePlanView>(
    await call(w, { url: routes.revisePlan(plan.planId), token: w.operator.token, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "HONEST" }) } }),
    201,
  );
  const stored = await w.row<{ body: PlanBody; body_hash: string; revision_hash: string; target_contract_hash: string }>("plans", "plan_id = $1", [revised.data.plan.planId]);
  assert.ok(stored);
  assert.equal(stored.body_hash, bodyHashOf(stored.body), "the stored hash is the digest of the stored body");
  assert.equal(revised.data.plan.bodyHash, stored.body_hash);
  assert.deepEqual([stored.revision_hash, stored.target_contract_hash], [plan.revisionHash, plan.targetContractHash]);
});
