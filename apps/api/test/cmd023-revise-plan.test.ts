// CMD023 RevisePlan — POST /api/v1/plans/{planId}/revisions — AGENCY_OPERATOR (registry cases CMD023-OK / -DENY / -RACE and
// S051 at the command level; design §8, D-PLAN-1; Plan machine edge new_plan_revision "Keep predecessor history",
// "Invalidate only dependent evidence with impact map", "Old approval cannot attach to new content"; catalogue failure "A
// stale UI cannot edit or approve the previous version as if current"). Real route over real plan rows; the typed patch
// resolver and compiler are the test-bound ports of this edition (I-INT-2).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RevisePlanView, UnreconciledConsequence } from "@kauro/application";
import type { Id } from "@kauro/contracts";
import type { ProjectId } from "@kauro/domain";
import {
  SimulatedCrash,
  approveThroughRoute,
  asProblem,
  bodyHashOf,
  call,
  completed,
  effectCounts,
  freshKey,
  ids,
  outcome,
  rawEvent,
  rootCause,
  routes,
  waitForApiLockWait,
  world,
  type PlanFixture,
  type World,
} from "./support.js";

/**
 * Unreconciled commercial/execution facts a test registers for a plan (the facts the quote, payment and job packages will
 * report through the same port); the edition's own inspector (none in B06) runs underneath.
 */
const unreconciled = new Map<string, ReadonlyArray<UnreconciledConsequence>>();

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world({
    collaborators: (base) => ({
      ...base,
      // the edition-bound test compiler, plus a candidate name that makes it answer a chosen rejection (a real compiler's
      // UNKNOWN_FIELD and EFFECT_NOT_PERMITTED need decision evidence this fixture does not model)
      patchCompiler: {
        async apply(current, patch) {
          const candidate = (patch.document as { readonly candidate?: unknown }).candidate;
          const forced = typeof candidate === "string" && candidate.startsWith("reject:") ? candidate.slice("reject:".length) : null;
          if (forced === "UNKNOWN_CANDIDATE" || forced === "UNKNOWN_FIELD" || forced === "EFFECT_NOT_PERMITTED" || forced === "MALFORMED_PATCH") return { kind: "REJECTED", reason: forced };
          return base.patchCompiler.apply(current, patch);
        },
      },
      commercialConsequences: {
        async unreconciledForPlan(uow, planId) {
          return [...(unreconciled.get(planId) ?? []), ...(await base.commercialConsequences.unreconciledForPlan(uow, planId))];
        },
      },
    }),
  });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

function patchBody(plan: PlanFixture, candidate = "Phone", reasonCode = "AGENCY_DECISION") {
  return { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate, reasonCode }) };
}

test("OK: an OPERATOR revises a VALIDATED plan; predecessor SUPERSEDED, successor VALIDATION_REQUIRED with a new body hash; the impact map names the invalidated receipt", async () => {
  const plan = await w.approvable(w.A, projectId, "revise-ok");
  const key = freshKey("cmd023-ok");
  const revised = completed<RevisePlanView>(await call(w, { url: routes.revisePlan(plan.planId), token: w.operator.token, key, body: patchBody(plan) }), 201);
  assert.equal(revised.replayed, false);
  assert.equal(revised.version, 2, "the version of the successor, the resource the command created");
  const { plan: successor, supersededPlan, invalidated } = revised.data;
  assert.equal(successor.state, "VALIDATION_REQUIRED");
  assert.equal(successor.version, 2);
  assert.equal(successor.supersedesPlanId, plan.planId);
  assert.notEqual(successor.bodyHash, plan.bodyHash, "the compiled body has a new hash");
  assert.equal(successor.revisionHash, plan.revisionHash);
  assert.equal(successor.targetContractHash, plan.targetContractHash);
  assert.equal(successor.validationReceiptHash, undefined, "no inherited validation");
  assert.equal(successor.approvalId, undefined);
  assert.deepEqual(supersededPlan, { planId: plan.planId, version: 5, state: "SUPERSEDED" });
  assert.deepEqual(invalidated, { validationReceiptHash: plan.receiptHash });

  // oracle: the predecessor keeps its history (receipt bound, row present, names its successor); the successor has no
  // receipt and no approval; the body stored for the successor hashes to the reported bodyHash
  const predecessor = await w.row<{ state: string; version: string; validation_receipt_hash: string | null; superseded_by_plan_id: string | null; body_hash: string }>("plans", "plan_id = $1", [plan.planId]);
  assert.deepEqual(predecessor && { state: predecessor.state, version: predecessor.version, receipt: predecessor.validation_receipt_hash, successor: predecessor.superseded_by_plan_id, body: predecessor.body_hash }, {
    state: "SUPERSEDED",
    version: "5",
    receipt: plan.receiptHash,
    successor: successor.planId,
    body: plan.bodyHash,
  });
  assert.equal(await w.count("validation_receipts", "plan_id = $1", [plan.planId]), 1, "the receipt survives");
  const stored = await w.row<{ state: string; version: string; validation_receipt_hash: string | null; approval_id: string | null; supersedes_plan_id: string; body: unknown; body_hash: string }>("plans", "plan_id = $1", [successor.planId]);
  assert.equal(stored?.state, "VALIDATION_REQUIRED");
  assert.equal(stored?.version, "2");
  assert.equal(stored?.validation_receipt_hash, null);
  assert.equal(stored?.approval_id, null);
  assert.equal(stored?.supersedes_plan_id, plan.planId);
  assert.equal(bodyHashOf(stored!.body as PlanFixture["body"]), successor.bodyHash);
  assert.equal(await w.count("validation_receipts", "plan_id = $1", [successor.planId]), 0);
  // events: plan.superseded.v1 (predecessor v5, impact map) → EXECUTION_CONTROL; plan.created.v1 (v1) and
  // plan.validation_required.v1 (v2) on the successor
  const predecessorEvents = await w.events("plan", plan.planId);
  assert.deepEqual(predecessorEvents.map((e) => [e.version, e.type]).slice(-1), [[5, "plan.superseded.v1"]]);
  assert.deepEqual(predecessorEvents.at(-1)?.payload, { planId: plan.planId, agencyId: w.A.agencyId, successorPlanId: successor.planId, invalidatedReceiptHash: plan.receiptHash });
  assert.deepEqual(await w.outbox(predecessorEvents.at(-1)!.eventId), ["EXECUTION_CONTROL"]);
  const successorEvents = await w.events("plan", successor.planId);
  assert.deepEqual(successorEvents.map((e) => [e.version, e.type]), [[1, "plan.created.v1"], [2, "plan.validation_required.v1"]]);
  assert.equal(successorEvents[0]?.payload["supersedesPlanId"], plan.planId);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "plan", id: successor.planId });
});

test("DENY: APPROVER → 403; foreign plan → 404; expectedVersion of a superseded plan → 409 STALE_VERSION with successorId; patch naming an unknown candidate → 400", async () => {
  const plan = await w.approvable(w.A, projectId, "revise-deny");
  const plansBefore = await w.count("plans");
  const journalBefore = await w.count("command_journal");
  const denialsBefore = (await w.securityEvents("CMD023")).length;
  const url = routes.revisePlan(plan.planId);

  for (const person of [w.approver, w.viewer]) {
    assert.equal(outcome(w, await call(w, { url, token: person.token, body: patchBody(plan) })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT");
  }
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, agency: w.B.agencyId, body: patchBody(plan) })), "404 NOT_FOUND -", "A's plan is invisible under B's context");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body: patchBody(plan) })), "404 NOT_FOUND NOT_A_MEMBER");
  // a patch naming a candidate the plan does not have: the compiler refuses, nothing is written
  const unknownCandidate = await call(w, { url, token: w.operator.token, body: patchBody(plan, "Fax") });
  assert.equal(outcome(w, unknownCandidate), "400 INVALID_REQUEST PATCH_UNKNOWN_CANDIDATE");
  assert.deepEqual(asProblem(w, unknownCandidate).errors, [{ field: "decisionPatchArtifactRef", code: "PATCH_UNKNOWN_CANDIDATE" }]);
  // an artifact of another agency (or none at all) is unknown, never revealed
  const foreignArtifact = await call(w, { url, token: w.operator.token, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.B.agencyId, { candidate: "Phone", reasonCode: "X" }) } });
  assert.equal(outcome(w, foreignArtifact), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  // a patch that changes nothing is not a new revision
  const noChange = await call(w, { url, token: w.operator.token, body: patchBody(plan, "Phone", "MAPPED") });
  assert.equal(outcome(w, noChange), "409 PRECONDITION_FAILED NO_SEMANTIC_CHANGE");
  assert.equal(await w.count("plans"), plansBefore, "no new plan row from any denied call");
  assert.equal((await w.row<{ version: string; state: string }>("plans", "plan_id = $1", [plan.planId]))?.version, "4");

  // a stale UI: after a real revision, the predecessor's old version answers STALE_VERSION pointing at the live revision
  const revised = completed<RevisePlanView>(await call(w, { url, token: w.operator.token, body: patchBody(plan) }), 201);
  const stale = await call(w, { url, token: w.operator.token, body: patchBody(plan) });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 5, state: "SUPERSEDED", successorId: revised.data.plan.planId });
  // even with the right version, a SUPERSEDED plan cannot be revised: the edge is not listed
  const superseded = await call(w, { url, token: w.operator.token, body: { ...patchBody(plan), expectedVersion: 5 } });
  assert.equal(outcome(w, superseded), "409 PRECONDITION_FAILED PLAN_SUPERSEDED");
  assert.equal(asProblem(w, superseded).current?.successorId, revised.data.plan.planId);
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [plan.planId]), 1);
  assert.equal(await w.count("command_journal"), journalBefore + 1, "only the successful revision journaled");
  const denials = (await w.securityEvents("CMD023")).slice(denialsBefore);
  assert.deepEqual(denials.map((d) => d.reason), ["ROLE_INSUFFICIENT", "ROLE_INSUFFICIENT", "NOT_A_MEMBER"]);
});

test("RACE: two RevisePlan calls with expectedVersion 2 — one 201, one 409 STALE_VERSION carrying successorId", async () => {
  // S051 at the command level: two edits race on one aggregate version (a VALIDATION_REQUIRED plan at version 2)
  const source = await w.revision(w.A, projectId);
  const target = await w.targetContract(w.A, projectId);
  const plan = await w.plan(w.A, projectId, { revisionHash: source.revisionHash, targetContractHash: target.targetContractHash, seed: "s051", state: "VALIDATION_REQUIRED" });
  assert.equal(plan.version, 2);
  const url = routes.revisePlan(plan.planId);
  // A locks the predecessor and holds while resolving its patch; B blocks on the row lock; A supersedes the plan; B reads
  // version 3 SUPERSEDED and answers STALE_VERSION with the successor id
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url, token: w.operator.token, key: freshKey("s051-a"), body: patchBody(plan, "Phone", "EDIT_A") });
  await hold.reached;
  const requestB = call(w, { url, token: w.owner.token, key: freshKey("s051-b"), body: patchBody(plan, "Phone", "EDIT_B") });
  try {
    await waitForApiLockWait(w, "FOR UPDATE");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const winner = completed<RevisePlanView>(a, 201);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, b).current, { version: 3, state: "SUPERSEDED", successorId: winner.data.plan.planId });
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [plan.planId]), 1, "exactly one successor (plans_supersedes_once)");
  assert.deepEqual((await w.events("plan", plan.planId)).map((e) => e.type), ["plan.created.v1", "plan.validation_required.v1", "plan.superseded.v1"]);
  // no approval of unseen new content: a stale UI approving the predecessor at the version it displayed is told where the
  // live content is; the predecessor at its true version is SUPERSEDED (unlisted edge); the successor was never validated
  const proof = await w.stepUp(w.approver);
  const approval = (expectedVersion: number) => ({ expectedVersion, planHash: plan.bodyHash, validationReceiptHash: "0".repeat(64), disclosuresHash: "0".repeat(64), assuranceProofRef: proof });
  const staleApproval = await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, body: approval(2) });
  assert.equal(outcome(w, staleApproval), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleApproval).current, { version: 3, state: "SUPERSEDED", successorId: winner.data.plan.planId });
  const supersededApproval = await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, body: approval(3) });
  assert.equal(outcome(w, supersededApproval), "409 PRECONDITION_FAILED PLAN_SUPERSEDED");
  const successorApproval = await call(w, { url: routes.approvePlan(winner.data.plan.planId), token: w.approver.token, body: { ...approval(2), planHash: winner.data.plan.bodyHash } });
  assert.equal(outcome(w, successorApproval), "422 PLAN_NOT_VALIDATED -");
  assert.equal(await w.count("approvals", "plan_id IN ($1, $2)", [plan.planId, winner.data.plan.planId]), 0);
});

test("RACE: two revisions on one version → one successor; identical retry replays; the same key with another patch → 409 IDEMPOTENCY_CONFLICT; crash leaves the predecessor unsuperseded and the same key then revises it once", async () => {
  const plan = await w.approvable(w.A, projectId, "revise-race");
  const url = routes.revisePlan(plan.planId);
  const keyA = freshKey("cmd023-race-a");
  const bodyA = patchBody(plan, "Phone", "EDIT_A");
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url, token: w.operator.token, key: keyA, body: bodyA });
  await hold.reached;
  const requestB = call(w, { url, token: w.operator.token, key: freshKey("cmd023-race-b"), body: patchBody(plan, "Phone", "EDIT_B") });
  try {
    await waitForApiLockWait(w, "FOR UPDATE");
  } finally {
    // a wait that never happens fails the test above; the held request is let go either way, so no transaction outlives it
    hold.release();
  }
  const [a, b] = await Promise.all([requestA, requestB]);
  const winner = completed<RevisePlanView>(a, 201);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.equal(asProblem(w, b).current?.successorId, winner.data.plan.planId);
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [plan.planId]), 1);
  // identical retry of the winner replays the journaled 201 without a second successor
  const replay = completed<RevisePlanView>(await call(w, { url, token: w.operator.token, key: keyA, body: bodyA }), 201);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, winner.data);
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [plan.planId]), 1);
  // the same key with another patch (a different decision artifact) is a typed conflict with no effect
  const conflict = await call(w, { url, token: w.operator.token, key: keyA, body: patchBody(plan, "Phone", "EDIT_C") });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [plan.planId]), 1);
  assert.equal(await w.count("command_journal", "idempotency_key = $1", [keyA]), 1);
  // crash before COMMIT on a fresh plan: the predecessor stays VALIDATED at its version, no successor row exists
  const fresh = await w.approvable(w.A, projectId, "revise-crash");
  const crashKey = freshKey("cmd023-crash");
  const crashBody = patchBody(fresh);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.revisePlan(fresh.planId), token: w.operator.token, key: crashKey, body: crashBody });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(asProblem(w, crashed).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  const row = await w.row<{ state: string; version: string; superseded_by_plan_id: string | null }>("plans", "plan_id = $1", [fresh.planId]);
  assert.deepEqual(row && { state: row.state, version: row.version, successor: row.superseded_by_plan_id }, { state: "VALIDATED", version: "4", successor: null });
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [fresh.planId]), 0);
  assert.equal(await w.journal(crashKey), null);
  // the same key is then the first execution of that logical operation: one successor, not replayed
  const retried = completed<RevisePlanView>(await call(w, { url: routes.revisePlan(fresh.planId), token: w.operator.token, key: crashKey, body: crashBody }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("plans", "supersedes_plan_id = $1", [fresh.planId]), 1);
});


test("APPROVED: revising an approved plan takes the approval's controller and reconciled consequences; the approval is withdrawn with its own event in the same transaction, so no live approval remains on the SUPERSEDED plan", async () => {
  // Registry Plan edge APPROVED -new_plan_revision-> SUPERSEDED: guard "Commercial/execution consequences are reconciled",
  // effect "Pause affected future work pending new approval"; CMD026 precondition "The actor controls this approval";
  // reference/HASHING_AND_ACCOUNTING_RULES "Withdrawal is a separately recorded authority event". Review finding R21.
  const plan = await w.approvable(w.A, projectId, "revise-approved");
  const approval = (await approveThroughRoute(w, plan)).data.approval;
  const url = routes.revisePlan(plan.planId);
  const body = () => ({ expectedVersion: 5, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "SECOND_THOUGHTS" }) });
  const denialsBefore = (await w.securityEvents("CMD023")).length;
  const countsBefore = await effectCounts(w);

  // an OPERATOR or an ADMIN may revise plans (AGENCY_OPERATOR) but controls no approval: superseding the approved plan would
  // end the approval's future use, which only its actor or an OWNER may do (D-AUTHZ-3)
  for (const person of [w.operator, w.admin]) {
    assert.equal(outcome(w, await call(w, { url, token: person.token, body: body() })), "403 NOT_AUTHORIZED NOT_APPROVAL_CONTROLLER", person.name);
  }
  // the OWNER controls it, but a commercial authorization still rests on the approval: the edge guard refuses until the
  // owning package reconciles it
  unreconciled.set(plan.planId, [{ kind: "COMMERCIAL_AUTHORIZATION", referenceId: ids.next() as Id }]);
  const blocked = await call(w, { url, token: w.owner.token, body: body() });
  assert.equal(outcome(w, blocked), "409 PRECONDITION_FAILED CONSEQUENCES_UNRECONCILED");
  assert.deepEqual(asProblem(w, blocked).current, { version: 5, state: "APPROVED" });
  unreconciled.delete(plan.planId);
  // nothing committed by the refusals: the approval is live at version 1, the plan APPROVED at version 5, no row in any
  // table but the durable denial facts
  assert.deepEqual({ ...(await effectCounts(w)), security_events: 0 }, { ...countsBefore, security_events: 0 });
  assert.deepEqual((await w.securityEvents("CMD023")).slice(denialsBefore).map((d) => [d.reason, d.actorId]), [
    ["NOT_APPROVAL_CONTROLLER", w.operator.userId],
    ["NOT_APPROVAL_CONTROLLER", w.admin.userId],
  ]);

  // the OWNER revises once the consequences are reconciled
  const key = freshKey("cmd023-approved");
  const revised = completed<RevisePlanView>(await call(w, { url, token: w.owner.token, key, body: body() }), 201);
  assert.deepEqual(revised.data.supersededPlan, { planId: plan.planId, version: 6, state: "SUPERSEDED" });
  assert.deepEqual(revised.data.invalidated, { validationReceiptHash: plan.receiptHash, approvalId: approval.approvalId });
  // the approval is withdrawn in the same transaction (version 2, by the owner, reason PLAN_SUPERSEDED); its immutable part
  // stays; no live approval remains on the superseded plan or attaches to the successor
  const row = await w.row<{ version: string; withdrawn_at: Date | null; withdrawn_by_membership_id: string | null; withdraw_reason_code: string | null; plan_hash: string }>("approvals", "approval_id = $1", [approval.approvalId]);
  assert.ok(row?.withdrawn_at instanceof Date);
  assert.deepEqual(row && { version: row.version, by: row.withdrawn_by_membership_id, reason: row.withdraw_reason_code, planHash: row.plan_hash }, { version: "2", by: w.A.ownerMembershipId, reason: "PLAN_SUPERSEDED", planHash: plan.bodyHash });
  assert.equal(await w.count("approvals", "plan_id IN ($1, $2) AND withdrawn_at IS NULL", [plan.planId, revised.data.plan.planId]), 0);
  const predecessor = await w.row<{ state: string; version: string; approval_id: string | null; superseded_by_plan_id: string | null }>("plans", "plan_id = $1", [plan.planId]);
  assert.deepEqual(predecessor && { state: predecessor.state, version: predecessor.version, approval: predecessor.approval_id, successor: predecessor.superseded_by_plan_id }, { state: "SUPERSEDED", version: "6", approval: approval.approvalId, successor: revised.data.plan.planId });
  // the withdrawal is its own recorded authority event, routed like CMD026's (NOTIFICATIONS + EXECUTION_CONTROL), naming the
  // successor that caused it; the supersession's impact map names the invalidated approval
  const approvalEvents = await w.events("approval", approval.approvalId);
  assert.deepEqual(approvalEvents.map((e) => [e.version, e.type]), [[1, "approval.created.v1"], [2, "approval.withdrawn.v1"]]);
  assert.deepEqual(approvalEvents[1]?.payload, { approvalId: approval.approvalId, agencyId: w.A.agencyId, planId: plan.planId, withdrawnByMembershipId: w.A.ownerMembershipId, supersededByPlanId: revised.data.plan.planId });
  assert.deepEqual(await w.outbox(approvalEvents[1]!.eventId), ["EXECUTION_CONTROL", "NOTIFICATIONS"]);
  const planEvents = await w.events("plan", plan.planId);
  assert.deepEqual(planEvents.at(-1)?.payload, { planId: plan.planId, agencyId: w.A.agencyId, successorPlanId: revised.data.plan.planId, invalidatedApprovalId: approval.approvalId, invalidatedReceiptHash: plan.receiptHash });
  assert.deepEqual(await w.outbox(planEvents.at(-1)!.eventId), ["EXECUTION_CONTROL"]);
  // nothing is left to withdraw, and the superseded plan cannot be withdrawn as if it still carried authority
  const late = await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 6, reasonCode: "SCOPE_CHANGED" } });
  assert.equal(late.status, 409);
  assert.deepEqual(asProblem(w, late).current, { version: 6, state: "SUPERSEDED", successorId: revised.data.plan.planId });
  assert.equal((await w.events("approval", approval.approvalId)).length, 2, "no second withdrawal");
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, id: journal.resourceId }, { state: "COMMITTED", status: 201, id: revised.data.plan.planId });

  // the database holds the invariant on its own: a writer that supersedes an approved plan without withdrawing its approval
  // (bypassing the handler, as the runtime role) is refused at COMMIT (KA020, constraint trigger plans_live_approval_binding)
  const other = await w.approvable(w.A, projectId, "revise-approved-raw");
  const otherApproval = (await approveThroughRoute(w, other)).data.approval;
  const successorId = ids.next();
  await assert.rejects(
    w.asTenant(w.A, async (c) => {
      await c.query(
        `INSERT INTO kauro.plans (plan_id, agency_id, project_id, version, state, revision_hash, target_contract_hash, policy_hash, body, body_hash, supersedes_plan_id, created_by_membership_id, created_at, updated_at)
         SELECT $1, agency_id, project_id, 1, 'DRAFT', revision_hash, target_contract_hash, policy_hash, body, body_hash, plan_id, created_by_membership_id, now(), now() FROM kauro.plans WHERE plan_id = $2`,
        [successorId, other.planId],
      );
      await rawEvent(c, { aggregateKind: "plan", aggregateId: successorId, aggregateVersion: 1, agencyId: w.A.agencyId, eventType: "plan.created.v1", actorUserId: w.A.ownerUserId, payload: { planId: successorId, agencyId: w.A.agencyId } });
      await c.query("UPDATE kauro.plans SET state = 'SUPERSEDED', superseded_by_plan_id = $2, version = version + 1 WHERE plan_id = $1", [other.planId, successorId]);
      await rawEvent(c, { aggregateKind: "plan", aggregateId: other.planId, aggregateVersion: 6, agencyId: w.A.agencyId, eventType: "plan.superseded.v1", actorUserId: w.A.ownerUserId, payload: { planId: other.planId, agencyId: w.A.agencyId, successorPlanId: successorId } });
    }),
    (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "KA020",
  );
  assert.equal((await w.row<{ state: string }>("plans", "plan_id = $1", [other.planId]))?.state, "APPROVED");
  assert.equal(await w.count("approvals", "approval_id = $1 AND withdrawn_at IS NULL", [otherApproval.approvalId]), 1);
});

test("RACE: RevisePlan of an APPROVED plan and WithdrawApproval serialize on the plan lock — one of them ends the approval, once", async () => {
  // The OWNER's revision holds the plan lock while it resolves its patch; the approver's withdrawal is observed waiting on
  // that lock; the revision commits (approval withdrawn by the supersession, version 2); the withdrawal then reads the plan
  // SUPERSEDED at version 6 and is refused — there is exactly one withdrawal event and no live approval. Review finding R21.
  const plan = await w.approvable(w.A, projectId, "revise-approved-race");
  const approval = (await approveThroughRoute(w, plan)).data.approval;
  const hold = w.holds.arm("collaborator");
  const revision = call(w, { url: routes.revisePlan(plan.planId), token: w.owner.token, body: { expectedVersion: 5, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "RACED" }) } });
  await hold.reached;
  const withdrawal = call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } });
  try {
    await waitForApiLockWait(w, "FOR UPDATE");
  } finally {
    hold.release();
  }
  const [revised, refused] = await Promise.all([revision, withdrawal]);
  const winner = completed<RevisePlanView>(revised, 201);
  assert.equal(refused.status, 409);
  assert.deepEqual(asProblem(w, refused).current, { version: 6, state: "SUPERSEDED", successorId: winner.data.plan.planId });
  const withdrawals = (await w.events("approval", approval.approvalId)).filter((e) => e.type === "approval.withdrawn.v1");
  assert.equal(withdrawals.length, 1);
  assert.equal(withdrawals[0]?.payload["supersededByPlanId"], winner.data.plan.planId);
  assert.equal(await w.count("approvals", "plan_id = $1 AND withdrawn_at IS NULL", [plan.planId]), 0);
  assert.equal((await w.row<{ withdraw_reason_code: string }>("approvals", "approval_id = $1", [approval.approvalId]))?.withdraw_reason_code, "PLAN_SUPERSEDED");
});


test("DENY (typed patch): each compiler rejection answers its own reason and the same code on the field; only a reference that does not resolve is UNKNOWN_REFERENCE", async () => {
  // 10 "Responses and safe errors": "frontend control flow uses the code and typed fields"; CMD023 precondition "The typed
  // patch names existing candidates/fields and permitted effects". Review finding R31: before, every compiler rejection
  // carried {decisionPatchArtifactRef, UNKNOWN_REFERENCE} although the reference had resolved.
  const plan = await w.approvable(w.A, projectId, "revise-patch-codes");
  const url = routes.revisePlan(plan.planId);
  const plansBefore = await w.count("plans");
  const cases = [
    ["UNKNOWN_CANDIDATE", "PATCH_UNKNOWN_CANDIDATE"],
    ["UNKNOWN_FIELD", "PATCH_UNKNOWN_FIELD"],
    ["EFFECT_NOT_PERMITTED", "PATCH_EFFECT_NOT_PERMITTED"],
    ["MALFORMED_PATCH", "PATCH_MALFORMED"],
  ] as const;
  for (const [compilerReason, reason] of cases) {
    const refused = await call(w, { url, token: w.operator.token, body: patchBody(plan, `reject:${compilerReason}`) });
    assert.equal(outcome(w, refused), `400 INVALID_REQUEST ${reason}`, compilerReason);
    assert.deepEqual(asProblem(w, refused).errors, [{ field: "decisionPatchArtifactRef", code: reason }], compilerReason);
  }
  // the reference itself does not resolve (another agency's artifact): that, and only that, is UNKNOWN_REFERENCE
  const unresolved = await call(w, { url, token: w.operator.token, body: { expectedVersion: plan.version, decisionPatchArtifactRef: w.plans.registerPatch(w.B.agencyId, { candidate: "Phone", reasonCode: "X" }) } });
  assert.equal(outcome(w, unresolved), "400 INVALID_REQUEST UNKNOWN_REFERENCE");
  assert.deepEqual(asProblem(w, unresolved).errors, [{ field: "decisionPatchArtifactRef", code: "UNKNOWN_REFERENCE" }]);
  assert.equal(await w.count("plans"), plansBefore);
});
