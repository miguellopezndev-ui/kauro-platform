// CMD022 CreatePlan through its route (package B08, mandate B08-COMMANDS-AUDIT; docs/design/B08-audit-approval-jobs.md §7 the plan edges B08
// performs, §8 the decision artifacts, §12 the served route; docs/design/B08-case-map.md CMD022-OK, CMD022-DENY, CMD022-RACE): an OPERATOR of the
// agency compiles the candidate decisions it stored for an audit that needs them into a new plan, VALIDATION_REQUIRED, bound to the audit's
// revision and target contract. The compiler is the Intelligence core's port (PlanCompilerPort), bound to B08-CORE-PORTS' labelled contract fake
// (SIMULATED, D8-PORT-1): the body a plan carries is what the port returned, its digest recomputed by the handler ("a collaborator's claim is
// never taken on trust"). The decisions enter through the content-idempotent intake of the decision artifacts (D8-AUD-3), not through the
// command.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import {
  AUDIT_ROW_LOCK,
  auditRow,
  auditWorld,
  createPlan,
  decidedBody,
  driveTo,
  endLiveAudits,
  footprint,
  fundPool,
  planEvents,
  planRow,
  startedAudit,
  storeDecisionArtifact,
  storedCandidates,
  storedData,
  type AuditWorld,
  type CompilerReason,
  type CreatedPlanView,
} from "./audit-support.js";
import { SimulatedCrash, asProblem, bodyHashOf, completed, freshKey, outcome, planBodyOf, replayTextOf, sha, waitForApiLockWait } from "./support.js";
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

/** An audit of a fresh subject that the control plane left needing the agency's decisions (NEEDS_DECISION, v4). */
async function deciding() {
  const started = await startedAudit(aw);
  await driveTo(aw.w, started, "NEEDS_DECISION");
  const row = await auditRow(aw.w, started.auditId);
  assert.deepEqual([row.state, row.version], ["NEEDS_DECISION", "4"]);
  return started;
}

test("OK, DENY and RACE: CreatePlan compiles the agency's candidate decision artifact through the Intelligence-core port into a new plan VALIDATION_REQUIRED bound to the audit's revision and target; an unknown, duplicated or invented candidate is 400 with its compiler reason; an identical retry replays", async () => {
  const { w, core, compiler } = aw;
  const compilations = () => core.calls("compile").length;

  // --- OK: the decisions are stored through the intake, then compiled into a plan ---
  const started = await deciding();
  const { subject, auditId } = started;
  const body = decidedBody(subject, "cmd022-ok");
  const stored = await storedCandidates(w, auditId, body);
  assert.equal(stored.kind, "CANDIDATE_DECISIONS");
  assert.equal(stored.auditId, auditId);
  assert.equal(stored.created, true);
  const audit = await auditRow(w, auditId);
  const plansBefore = await w.count("plans", "agency_id = $1", [w.A.agencyId]);
  const arrivals = compiler.arrivals().length;
  const compiled = compilations();
  const key = freshKey("cmd022-ok");
  const first = await createPlan(w, auditId, { candidateDecisionArtifactRef: stored.artifactRef }, { key });
  const done = completed<CreatedPlanView>(first, 201);
  const view = done.data;
  assert.equal(done.replayed, false);
  assert.equal(done.version, 2, "the version of the plan the command created");
  assert.deepEqual([view.projectId, view.state, view.version], [subject.projectId, "VALIDATION_REQUIRED", 2]);
  assert.equal(view.bodyHash, bodyHashOf(body), "the hash is the KAURO_PLAN_BODY_V1 digest of the compiled body");
  assert.equal(view.revisionHash, subject.revisionHash, "bound to the audit's revision");
  assert.equal(view.targetContractHash, subject.targetContractHash, "and to the audit's target contract");
  assert.equal((view as { readonly supersedesPlanId?: string }).supersedesPlanId, undefined, "a first plan supersedes nothing");
  assert.deepEqual(view.permittedActions, ["RevisePlan", "ValidatePlan"], "an OPERATOR revises the plan or asks for its validation");
  // oracle: one plan row, VALIDATION_REQUIRED v2, the compiled body stored under its hash, no receipt and no approval
  assert.equal(await w.count("plans", "agency_id = $1", [w.A.agencyId]), plansBefore + 1);
  const row = await planRow(w, view.planId);
  assert.deepEqual([row.agency_id, row.project_id, row.state, row.version, row.body_hash, row.revision_hash, row.target_contract_hash], [w.A.agencyId, subject.projectId, "VALIDATION_REQUIRED", "2", view.bodyHash, subject.revisionHash, subject.targetContractHash]);
  assert.equal(bodyHashOf(row.body), row.body_hash);
  const extra = await w.row<{ validation_receipt_hash: string | null; approval_id: string | null; supersedes_plan_id: string | null; created_by_membership_id: string }>("plans", "plan_id = $1", [view.planId]);
  assert.deepEqual([extra?.validation_receipt_hash, extra?.approval_id, extra?.supersedes_plan_id], [null, null, null]);
  assert.equal(extra?.created_by_membership_id, w.memberships.operator);
  // the audit is untouched (a plan is the agency's, several may come of one audit) and the port was asked once, with no current body
  const after = await auditRow(w, auditId);
  assert.deepEqual([after.state, after.version, after.draft_plan_id], [audit.state, audit.version, audit.draft_plan_id]);
  assert.equal(compiler.arrivals().length, arrivals + 1);
  assert.deepEqual(compiler.arrivals().at(-1), { current: null });
  assert.equal(compilations(), compiled + 1);
  // events: plan.created.v1 (v1) and plan.validation_required.v1 (v2), neither with a consumer of its own
  const events = await planEvents(w, view.planId);
  assert.deepEqual(events.map((e) => [e.version, e.type, e.consumers]), [
    [1, "plan.created.v1", []],
    [2, "plan.validation_required.v1", []],
  ]);
  assert.deepEqual(events[0]?.payload, { planId: view.planId, agencyId: w.A.agencyId, projectId: subject.projectId, bodyHash: view.bodyHash, createdByMembershipId: w.memberships.operator });
  assert.deepEqual(events[1]?.payload, { planId: view.planId, agencyId: w.A.agencyId, bodyHash: view.bodyHash });
  const journal = await w.journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "plan", view.planId]);

  // the intake is content-idempotent: the same decisions again are the same artifact (200, created false), other decisions are another one
  const again = await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: { body } });
  assert.equal(again.status, 200);
  assert.deepEqual(storedData(again), { ...stored, created: false });
  const other = await storedCandidates(w, auditId, decidedBody(subject, "cmd022-other"));
  assert.notEqual(other.artifactRef, stored.artifactRef);
  assert.notEqual(other.contentHash, stored.contentHash);

  // an identical retry replays the journaled 201 byte for byte and creates nothing; the same key naming another artifact is a typed conflict
  const replay = await createPlan(w, auditId, { candidateDecisionArtifactRef: stored.artifactRef }, { key });
  assert.equal(replay.status, 201);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(await w.count("plans", "agency_id = $1", [w.A.agencyId]), plansBefore + 1);
  assert.equal(compilations(), compiled + 1, "a replay does not compile again");
  assert.equal(outcome(w, await createPlan(w, auditId, { candidateDecisionArtifactRef: other.artifactRef }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("plans", "agency_id = $1", [w.A.agencyId]), plansBefore + 1);

  // --- DENY ---
  const refused = async (what: string, request: () => ReturnType<typeof createPlan>, expected: string) => {
    const written = await footprint(w);
    const plans = await w.count("plans");
    const reply = await request();
    assert.equal(outcome(w, reply), expected, what);
    assert.deepEqual(await footprint(w), written, `${what}: nothing written`);
    assert.equal(await w.count("plans"), plans, `${what}: no plan`);
    return reply;
  };
  const decisions = await storedCandidates(w, auditId, decidedBody(subject, "cmd022-deny"));
  const denied = (await w.securityEvents("CMD022")).length;
  await refused("viewer", () => createPlan(w, auditId, { candidateDecisionArtifactRef: decisions.artifactRef }, { token: w.viewer.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  await refused("approver", () => createPlan(w, auditId, { candidateDecisionArtifactRef: decisions.artifactRef }, { token: w.approver.token }), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.deepEqual((await w.securityEvents("CMD022")).slice(denied).map((f) => [f.outcome, f.reason, f.agencyId, f.actorId]), [
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
    ["DENY", "ROLE_INSUFFICIENT", w.A.agencyId, w.approver.userId],
  ]);
  // another agency's audit is 404, the answer of an audit that never existed
  const foreign = await refused("foreign audit", () => createPlan(w, auditId, { candidateDecisionArtifactRef: decisions.artifactRef }, { token: w.stranger.token, agency: w.B.agencyId }), "404 NOT_FOUND -");
  const unknown = await createPlan(w, "00000000-0000-4000-8000-000000000000", { candidateDecisionArtifactRef: decisions.artifactRef }, { token: w.stranger.token, agency: w.B.agencyId });
  assert.deepEqual({ ...asProblem(w, foreign), correlationId: "" }, { ...asProblem(w, unknown), correlationId: "" });
  // a reference that names no artifact of this audit is 400 UNKNOWN_REFERENCE on the field, whatever it names: nothing, another audit's artifact,
  // or a decision patch (the other kind of artifact, which RevisePlan resolves and CreatePlan does not)
  const field = [{ field: "candidateDecisionArtifactRef", code: "UNKNOWN_REFERENCE" }];
  const nothing = await refused("unknown artifact", () => createPlan(w, auditId, { candidateDecisionArtifactRef: "00000000-0000-4000-8000-0000000000a1" }), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.deepEqual(asProblem(w, nothing).errors, field);
  const elsewhere = await startedAudit(aw);
  await driveTo(w, elsewhere, "NEEDS_DECISION");
  const strangers = await storedCandidates(w, elsewhere.auditId, decidedBody(elsewhere.subject, "cmd022-elsewhere"));
  await refused("another audit's artifact", () => createPlan(w, auditId, { candidateDecisionArtifactRef: strangers.artifactRef }), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  const patch = await storeDecisionArtifact(w, auditId, { kind: "DECISION_PATCH", document: { candidate: "Phone", reasonCode: "AGENCY_DECISION" } });
  assert.equal(patch.status, 201, patch.text);
  await refused("a decision patch", () => createPlan(w, auditId, { candidateDecisionArtifactRef: storedData(patch).artifactRef }), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  // the compiler's four reasons, told to the port one after another, each answered 400 on the field with the reason itself (D-PLAN-1 vocabulary)
  const wire: Readonly<Record<CompilerReason, string>> = {
    UNKNOWN_CANDIDATE: "PATCH_UNKNOWN_CANDIDATE",
    UNKNOWN_FIELD: "PATCH_UNKNOWN_FIELD",
    EFFECT_NOT_PERMITTED: "PATCH_EFFECT_NOT_PERMITTED",
    MALFORMED_PATCH: "PATCH_MALFORMED",
  };
  for (const [reason, code] of Object.entries(wire) as ReadonlyArray<[CompilerReason, string]>) {
    compiler.rejectNext(reason);
    const rejected = await refused(`the port rejects with ${reason}`, () => createPlan(w, auditId, { candidateDecisionArtifactRef: decisions.artifactRef }), `400 INVALID_REQUEST ${code}`);
    assert.deepEqual(asProblem(w, rejected).errors, [{ field: "candidateDecisionArtifactRef", code }]);
  }
  // decisions that are no candidate decisions at all (the fake's port compiles only `{ body }`) are a malformed patch, from the port itself
  const invented = await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: { candidate: "Fax", invented: true } });
  assert.equal(invented.status, 201, invented.text);
  await refused("invented candidate", () => createPlan(w, auditId, { candidateDecisionArtifactRef: storedData(invented).artifactRef }), "400 INVALID_REQUEST PATCH_MALFORMED");
  // a plan of another revision or target is no plan of this audit: a compiled body that names a subject other than the audit's is refused
  const stray = await storedCandidates(w, auditId, planBodyOf(sha("another-revision") as never, subject.targetContractHash as never, "cmd022-stray"));
  await refused("another revision", () => createPlan(w, auditId, { candidateDecisionArtifactRef: stray.artifactRef }), "400 INVALID_REQUEST PATCH_EFFECT_NOT_PERMITTED");
  const wrongTarget = await storedCandidates(w, auditId, planBodyOf(subject.revisionHash as never, sha("another-target") as never, "cmd022-wrong-target"));
  await refused("another target", () => createPlan(w, auditId, { candidateDecisionArtifactRef: wrongTarget.artifactRef }), "400 INVALID_REQUEST PATCH_EFFECT_NOT_PERMITTED");
  // a compiler that claims a hash other than the body's digest is an integrity failure, never a stored hash that describes other content
  compiler.lieNext();
  const lying = await refused("a port that lies about the digest", () => createPlan(w, auditId, { candidateDecisionArtifactRef: decisions.artifactRef }), "422 INTEGRITY_FAILURE BODY_DIGEST_MISMATCH");
  assert.equal(lying.status, 422);
  // an audit that is not waiting for decisions offers no plan: QUEUED, live phases, unsupported, failed and cancelled ones are 409 AUDIT_NOT_DECIDABLE
  const notDeciding = async (what: string, phase: "QUEUED" | "PROFILING" | "INTERPRETING" | "UNSUPPORTED" | "FAILED"): Promise<void> => {
    await endLiveAudits(w);
    const target = await startedAudit(aw);
    await driveTo(w, target, phase);
    const held = await storedCandidates(w, target.auditId, decidedBody(target.subject, `cmd022-${phase}`));
    const problem = await refused(what, () => createPlan(w, target.auditId, { candidateDecisionArtifactRef: held.artifactRef }), "409 PRECONDITION_FAILED AUDIT_NOT_DECIDABLE");
    const current = (await auditRow(w, target.auditId));
    assert.deepEqual(asProblem(w, problem).current, { version: Number(current.version), state: phase });
  };
  await notDeciding("a QUEUED audit", "QUEUED");
  await notDeciding("a PROFILING audit", "PROFILING");
  await notDeciding("an INTERPRETING audit", "INTERPRETING");
  await notDeciding("an UNSUPPORTED audit", "UNSUPPORTED");
  await notDeciding("a FAILED audit", "FAILED");
  // the intake obeys the same roles and the same closed schema: a VIEWER is 403, another agency's audit 404, a document that is no object 400
  assert.equal(outcome(w, await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: { body } }, { token: w.viewer.token })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  assert.equal(outcome(w, await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: { body } }, { token: w.stranger.token, agency: w.B.agencyId })), "404 NOT_FOUND -");
  assert.equal((await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: "text" })).status, 400);
  assert.equal((await storeDecisionArtifact(w, auditId, { kind: "MODEL_RESPONSE", document: {} })).status, 400);
  assert.equal((await storeDecisionArtifact(w, auditId, { kind: "CANDIDATE_DECISIONS", document: {}, extra: true })).status, 400);

  // --- RACE ---
  // two CreatePlan calls on one audit (an audit may yield several plans, D8-CMA-2): the first held before its journal commit with the audit row
  // locked, the second observed waiting on that row; after the release both are 201, with two plans that have nothing to do with each other
  await endLiveAudits(w);
  const raced = await deciding();
  const pair = await storedCandidates(w, raced.auditId, decidedBody(raced.subject, "cmd022-race"));
  const plansOfPair = await w.count("plans", "agency_id = $1", [w.A.agencyId]);
  const hold = w.holds.arm("journal.commit");
  const winner = createPlan(w, raced.auditId, { candidateDecisionArtifactRef: pair.artifactRef });
  let second: ReturnType<typeof createPlan> | undefined;
  try {
    await reachedHold(hold, winner);
    second = createPlan(w, raced.auditId, { candidateDecisionArtifactRef: pair.artifactRef });
    await waitForApiLockWait(w, AUDIT_ROW_LOCK);
  } finally {
    hold.release();
  }
  const [one, two] = await Promise.all([winner, second as ReturnType<typeof createPlan>]);
  const planIds = [completed<CreatedPlanView>(one, 201).data.planId, completed<CreatedPlanView>(two, 201).data.planId];
  assert.notEqual(planIds[0], planIds[1]);
  assert.equal(await w.count("plans", "agency_id = $1", [w.A.agencyId]), plansOfPair + 2);
  // a crash before COMMIT leaves nothing: no plan, no event, no journal entry; the same key then creates the plan once
  const crashKey = freshKey("cmd022-crash");
  const beforeCrash = await footprint(w);
  const plansBeforeCrash = await w.count("plans");
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await createPlan(w, raced.auditId, { candidateDecisionArtifactRef: pair.artifactRef }, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(w), beforeCrash);
  assert.equal(await w.count("plans"), plansBeforeCrash);
  assert.equal(await w.journal(crashKey), null);
  assert.equal(completed<CreatedPlanView>(await createPlan(w, raced.auditId, { candidateDecisionArtifactRef: pair.artifactRef }, { key: crashKey }), 201).data.state, "VALIDATION_REQUIRED");
  assert.equal(await w.count("plans"), plansBeforeCrash + 1);

});
