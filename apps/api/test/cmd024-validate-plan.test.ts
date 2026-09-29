// CMD024 ValidatePlan through its route (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §7 the Plan edge
// validation_admitted, D8-PLAN-2, §12 the served route; docs/design/B08-case-map.md CMD024-OK, CMD024-DENY, CMD024-RACE): an OPERATOR of the
// agency asks for the full-data validation of a plan that requires it, at the version and the body hash it read. The request records ONE
// validation intent of the plan (its own fence, D8-PLAN-2), moves the plan to VALIDATING under the plan row's lock and answers 202; the
// validation itself is PLAN_VALIDATION's, on the control plane (B08-CONTROL-AUDIT), and no core is called by the request.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { accepted } from "./commerce-support.js";
import {
  PLAN_ROW_LOCK,
  auditWorld,
  createPlan,
  decidedBody,
  driveTo,
  endLiveAudits,
  footprint,
  fundPool,
  planEvents,
  planRow,
  requiredPlan,
  startedAudit,
  storedCandidates,
  subjectOf,
  validatePlan,
  validationsOf,
  type AuditWorld,
  type CreatedPlanView,
} from "./audit-support.js";
import { SimulatedCrash, asProblem, completed, freshKey, outcome, sha, waitForApiLockWait } from "./support.js";
import { reachedHold } from "./writers.js";

let aw: AuditWorld;
before(async () => {
  aw = await auditWorld();
  await fundPool(aw);
});
after(async () => {
  await aw.stop();
});
afterEach(async () => {
  await endLiveAudits(aw.w);
});

test("OK, DENY and RACE: ValidatePlan moves a VALIDATION_REQUIRED plan to VALIDATING with one validation intent and answers 202; a stale planHash is 409 STALE_VERSION, a VIEWER 403, and two requests on one version yield one intent", async () => {
  const { w, core } = aw;

  // --- OK: a plan at VALIDATION_REQUIRED (v2) is put under validation at the version and hash the caller read ---
  const subject = await subjectOf(w);
  const plan = await requiredPlan(w, subject, "cmd024-ok");
  assert.deepEqual([plan.state, plan.version], ["VALIDATION_REQUIRED", 2]);
  assert.deepEqual(await validationsOf(w, plan.planId), []);
  const key = freshKey("cmd024-ok");
  const first = await validatePlan(w, plan.planId, { expectedVersion: plan.version, planHash: plan.bodyHash }, { key });
  assert.equal(first.status, 202);
  assert.deepEqual(accepted(first), { kind: "ACCEPTED", operationId: plan.planId, state: "VALIDATING", statusPath: `/api/v1/plans/${plan.planId}`, pollAfterSeconds: 10 });
  // oracle: the plan is VALIDATING at v3 with its body untouched; ONE intent of the plan's body, on the fence 1, by the caller's membership,
  // unsettled (the receipt is the validator's)
  const row = await planRow(w, plan.planId);
  assert.deepEqual([row.state, row.version, row.body_hash, row.revision_hash, row.target_contract_hash], ["VALIDATING", "3", plan.bodyHash, subject.revisionHash, subject.targetContractHash]);
  const intents = await validationsOf(w, plan.planId);
  assert.equal(intents.length, 1, "one validation intent");
  assert.deepEqual(
    [intents[0]?.plan_hash, intents[0]?.fence, intents[0]?.origin, intents[0]?.requested_by_membership_id, intents[0]?.audit_id, intents[0]?.result],
    [plan.bodyHash, "1", "COMMAND", w.memberships.operator, null, null],
  );
  assert.equal(await w.count("validation_receipts", "plan_id = $1", [plan.planId]), 0, "no receipt: the request validates nothing");
  // one plan.validating.v1 at v3, delivered to PLAN_VALIDATION alone
  const emitted = (await planEvents(w, plan.planId)).filter((e) => e.type === "plan.validating.v1");
  assert.deepEqual(emitted.map((e) => [e.version, e.consumers]), [[3, ["PLAN_VALIDATION"]]]);
  assert.deepEqual(emitted[0]?.payload, { planId: plan.planId, agencyId: w.A.agencyId, bodyHash: plan.bodyHash });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 202, "plan", plan.planId]);
  assert.deepEqual(core.calls(), [], "the request calls no core: the validation is the control plane's");
  // an identical retry replays the journaled 202 and records nothing again; the same key with another hash is a typed conflict
  const replay = await validatePlan(w, plan.planId, { expectedVersion: plan.version, planHash: plan.bodyHash }, { key });
  assert.deepEqual(accepted(replay), accepted(first));
  assert.equal((await validationsOf(w, plan.planId)).length, 1);
  assert.equal(outcome(w, await validatePlan(w, plan.planId, { expectedVersion: plan.version, planHash: sha("another body") }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await validationsOf(w, plan.planId)).length, 1);

  // the plan CreatePlan compiled is validated the same way, from the audit that needed the decisions
  const started = await startedAudit(aw);
  await driveTo(w, started, "NEEDS_DECISION");
  const stored = await storedCandidates(w, started.auditId, decidedBody(started.subject, "cmd024-chain"));
  const created = completed<CreatedPlanView>(await createPlan(w, started.auditId, { candidateDecisionArtifactRef: stored.artifactRef }), 201).data;
  const chained = await validatePlan(w, created.planId, { expectedVersion: created.version, planHash: created.bodyHash });
  assert.deepEqual([accepted(chained).operationId, accepted(chained).state], [created.planId, "VALIDATING"]);
  assert.deepEqual((await validationsOf(w, created.planId)).map((v) => [v.fence, v.origin, v.plan_hash]), [["1", "COMMAND", created.bodyHash]]);

  // --- DENY ---
  const target = await requiredPlan(w, await subjectOf(w), "cmd024-deny");
  const untouched = async (): Promise<readonly [string, string, number]> => {
    const r = await planRow(w, target.planId);
    return [r.state, r.version, (await validationsOf(w, target.planId)).length];
  };
  const refused = async (what: string, body: { readonly expectedVersion: number; readonly planHash: string }, options: Parameters<typeof validatePlan>[3], expected: string, planId: string = target.planId) => {
    const written = await footprint(w);
    const state = planId === target.planId ? await untouched() : null;
    const reply = await validatePlan(w, planId, body, options);
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(w), written, `${what}: nothing written`);
    if (state !== null) assert.deepEqual(await untouched(), state, `${what}: the plan is untouched`);
    return reply;
  };
  const good = { expectedVersion: target.version, planHash: target.bodyHash };
  // roles: a VIEWER and an APPROVER are not operators; the denial is a durable fact of the agency's stream
  const denied = (await w.securityEvents("CMD024")).length;
  await refused("viewer", good, { token: w.viewer.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", good, { token: w.approver.token }, "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD024")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
  ]);
  // another agency's plan is 404, the answer of a plan that never existed
  const foreign = await refused("foreign plan", good, { token: w.stranger.token, agency: w.B.agencyId }, "404 NOT_FOUND -");
  const unknown = await validatePlan(w, "00000000-0000-4000-8000-000000000000", good, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" });
  // a stale planHash: the plan the caller read is not the plan that is there (the body was revised, or the hash is another plan's); the answer
  // names where the plan is and which member differs
  const staleHash = await refused("stale planHash", { expectedVersion: target.version, planHash: sha("the body the caller read") }, {}, "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleHash).current, { version: 2, state: "VALIDATION_REQUIRED", mismatch: ["planHash"] });
  assert.deepEqual(asProblem(w, staleHash).nextActions, [{ action: "RELOAD" }, { action: "COMPARE_VERSIONS" }]);
  // a stale version: the plan moved since the caller read it
  const staleVersion = await refused("stale version", { expectedVersion: target.version + 1, planHash: target.bodyHash }, {}, "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleVersion).current, { version: 2, state: "VALIDATION_REQUIRED" });
  // a plan that is not waiting for validation is 409 PLAN_NOT_VALIDATABLE, at the version and hash it has: VALIDATING (put there above), VALIDATED
  const validating = await planRow(w, plan.planId);
  const notValidatable = await refused("a VALIDATING plan", { expectedVersion: Number(validating.version), planHash: plan.bodyHash }, {}, "409 PRECONDITION_FAILED PLAN_NOT_VALIDATABLE", plan.planId);
  assert.deepEqual(asProblem(w, notValidatable).current, { version: 3, state: "VALIDATING" });
  assert.equal((await validationsOf(w, plan.planId)).length, 1, "still one intent");
  const validated = await w.plan(w.A, subject.projectId as never, { revisionHash: subject.revisionHash as never, targetContractHash: subject.targetContractHash as never, seed: "cmd024-validated", state: "VALIDATED" });
  const done = await refused("a VALIDATED plan", { expectedVersion: validated.version, planHash: validated.bodyHash }, {}, "409 PRECONDITION_FAILED PLAN_NOT_VALIDATABLE", validated.planId);
  assert.deepEqual(asProblem(w, done).current, { version: 4, state: "VALIDATED" });
  assert.deepEqual(asProblem(w, done).nextActions, [{ action: "RELOAD" }]);
  assert.equal((await validationsOf(w, validated.planId)).length, 0);

  // --- RACE ---
  // two requests on one version: the first held before its journal commit with the plan row locked, the second observed waiting on that row; once
  // the first commits the second finds the plan moved and answers 409 STALE_VERSION at the version the first reached — one intent, one event
  const raced = await requiredPlan(w, await subjectOf(w), "cmd024-race");
  const request = { expectedVersion: raced.version, planHash: raced.bodyHash };
  const hold = w.holds.arm("journal.commit");
  const winner = validatePlan(w, raced.planId, request);
  let loser: ReturnType<typeof validatePlan> | undefined;
  try {
    await reachedHold(hold, winner);
    loser = validatePlan(w, raced.planId, request);
    await waitForApiLockWait(w, PLAN_ROW_LOCK);
  } finally {
    hold.release();
  }
  const [victor, beaten] = await Promise.all([winner, loser as ReturnType<typeof validatePlan>]);
  assert.equal(accepted(victor).state, "VALIDATING");
  assert.equal(outcome(w, beaten), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, beaten).current, { version: 3, state: "VALIDATING" });
  assert.equal((await validationsOf(w, raced.planId)).length, 1, "one intent");
  assert.equal((await planEvents(w, raced.planId)).filter((e) => e.type === "plan.validating.v1").length, 1, "one event");

  // a crash before COMMIT leaves the plan as it was: the intent, the move and the event were written and never committed; the same key then
  // records the intent once
  const crashing = await requiredPlan(w, await subjectOf(w), "cmd024-crash");
  const crashKey = freshKey("cmd024-crash");
  const beforeCrash = await footprint(w);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await validatePlan(w, crashing.planId, { expectedVersion: crashing.version, planHash: crashing.bodyHash }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(w), beforeCrash, "nothing left behind");
  const still = await planRow(w, crashing.planId);
  assert.deepEqual([still.state, still.version, (await validationsOf(w, crashing.planId)).length], ["VALIDATION_REQUIRED", "2", 0]);
  assert.equal(await w.journal(crashKey), null);
  const retried = await validatePlan(w, crashing.planId, { expectedVersion: crashing.version, planHash: crashing.bodyHash }, { key: crashKey });
  assert.equal(accepted(retried).state, "VALIDATING");
  assert.equal((await validationsOf(w, crashing.planId)).length, 1);
});
