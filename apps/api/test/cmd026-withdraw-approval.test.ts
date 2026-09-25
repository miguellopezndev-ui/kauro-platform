// CMD026 WithdrawApproval — POST /api/v1/plans/{planId}/withdraw — AGENCY_APPROVER (registry cases CMD026-OK / -DENY / -RACE;
// design §8, D-AUTHZ-3; Plan machine edge withdraw_approval APPROVED -> WITHDRAWN "Current organization authority withdraws
// future use. Cancel/reconcile active work under its own state machine"; catalogue precondition "The actor controls this
// approval; already completed external/customer actions are identified separately"; failure "Do not delete history or
// promise rollback of an agency-performed CRM import"; 10 "POST /plans/{planId}/withdraw revokes future use without deleting
// history"). Real route over real plan, receipt and approval rows; every approval here is created through the CMD025 route.
//
// Completed external actions: no ImportStage or PackageVersion aggregate exists in the B06 schema, so the edition's inspector
// reports none (edition.ts). This file binds an ExternalActionInspector that adds the completed stages a test registers for a
// plan — the facts the import and delivery packages will feed through the same port — to show that they are identified
// separately, carried by approval.withdrawn.v1 and never promised reversible. It is an application port of
// @kauro/application, not a fake of the database; the edition's own inspector still runs underneath (and passes the
// `collaborator` hold point the RACE test uses).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ApprovalView, CompletedExternalAction, WithdrawApprovalView } from "@kauro/application";
import type { Id } from "@kauro/contracts";
import type { ProjectId } from "@kauro/domain";
import {
  SimulatedCrash,
  approvalBodyOf,
  approveThroughRoute,
  asProblem,
  call,
  completed,
  effectCounts,
  freshKey,
  ids,
  outcome,
  replayTextOf,
  rootCause,
  routes,
  sortedFacts,
  waitForApiLockWait,
  world,
  type Person,
  type PlanFixture,
  type World,
} from "./support.js";

let w: World;
let projectId: ProjectId;
const completedActions = new Map<string, ReadonlyArray<CompletedExternalAction>>();

before(async () => {
  w = await world({
    collaborators: (base) => ({
      ...base,
      externalActions: {
        async completedForPlan(uow, planId) {
          const edition = await base.externalActions.completedForPlan(uow, planId);
          return [...edition, ...(completedActions.get(planId) ?? [])];
        },
      },
    }),
  });
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

/** A VALIDATED plan of agency A approved through the CMD025 route: plan APPROVED at version 5, approval at version 1. */
async function approvedPlan(seed: string, approver: Person = w.approver): Promise<{ plan: PlanFixture; approval: ApprovalView }> {
  const plan = await w.approvable(w.A, projectId, seed);
  const approved = await approveThroughRoute(w, plan, approver);
  assert.equal(approved.data.plan.state, "APPROVED");
  assert.equal(approved.data.plan.version, 5);
  return { plan, approval: approved.data.approval };
}

interface ApprovalRow extends Record<string, unknown> {
  version: string;
  withdrawn_at: Date | null;
  withdrawn_by_membership_id: string | null;
  withdraw_reason_code: string | null;
}

/** Every member name of a JSON document, at any depth. */
function memberNames(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) memberNames(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      memberNames(v, out);
    }
  }
  return out;
}

/** The immutable part of an approval row: identity, actor, assurance and the five bound hashes. */
const IMMUTABLE_APPROVAL_COLUMNS = ["approval_id", "agency_id", "plan_id", "actor_id", "actor_membership_id", "actor_membership_version", "assurance_proof_ref", "plan_hash", "revision_hash", "target_contract_hash", "validation_receipt_hash", "disclosures_hash", "approval_hash", "created_at"] as const;

function immutablePart(row: Record<string, unknown> | null): Record<string, unknown> {
  if (row === null) throw new Error("approval row missing");
  return Object.fromEntries(IMMUTABLE_APPROVAL_COLUMNS.map((c) => [c, row[c] instanceof Date ? (row[c] as Date).toISOString() : row[c]]));
}

test("OK: the approving actor withdraws; approval carries withdrawn_at/by/reason, plan WITHDRAWN; the outbox routes EXECUTION_CONTROL; completed external actions are listed separately", async () => {
  const { plan, approval } = await approvedPlan("withdraw-ok");
  // the agency already verified an import stage of this plan in its own CRM (reported by the import package's inspector)
  const stage: CompletedExternalAction = { kind: "IMPORT_STAGE_VERIFIED", referenceId: ids.next() as Id };
  completedActions.set(plan.planId, [stage]);
  const approvalBefore = await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]);
  const approvalsBefore = await w.count("approvals");
  const key = freshKey("cmd026-ok");

  const reply = await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, key, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } });
  const withdrawn = completed<WithdrawApprovalView>(reply, 200);
  assert.equal(withdrawn.version, 6, "the plan version after the withdrawal");
  assert.equal(withdrawn.replayed, false);
  const { approval: a, plan: p, completedExternalActions } = withdrawn.data;
  // the approval keeps its identity and bindings; the withdrawal is recorded once at version 2: when, by whom, why
  assert.equal(a.approvalId, approval.approvalId);
  assert.equal(a.version, 2);
  assert.ok(a.withdrawnAt);
  assert.equal(a.withdrawnByMembershipId, w.memberships.approver);
  assert.equal(a.withdrawReasonCode, "SCOPE_CHANGED");
  assert.deepEqual(
    [a.planHash, a.revisionHash, a.targetContractHash, a.validationReceiptHash, a.disclosuresHash, a.approvalHash, a.actorMembershipId, a.createdAt],
    [approval.planHash, approval.revisionHash, approval.targetContractHash, approval.validationReceiptHash, approval.disclosuresHash, approval.approvalHash, approval.actorMembershipId, approval.createdAt],
  );
  // the plan is WITHDRAWN at version 6 and still names its receipt and its approval (history, not deletion)
  assert.deepEqual([p.planId, p.state, p.version, p.approvalId, p.validationReceiptHash], [plan.planId, "WITHDRAWN", 6, approval.approvalId, plan.receiptHash]);
  // completed external actions are identified separately; no member of the answer promises a rollback or refund
  assert.deepEqual(completedExternalActions, [stage]);
  assert.deepEqual(Object.keys(withdrawn.data).sort(), ["approval", "completedExternalActions", "plan"]);
  assert.deepEqual(memberNames(withdrawn.data).filter((k) => /rollback|revert|undo|reverse|refund|restore/i.test(k)), []);

  // oracle: the approval row is still there — withdrawn once, by the approving membership — with every binding untouched
  const row = await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]);
  assert.deepEqual(row && { version: row.version, withdrawn: row.withdrawn_at !== null, by: row.withdrawn_by_membership_id, reason: row.withdraw_reason_code }, { version: "2", withdrawn: true, by: w.memberships.approver, reason: "SCOPE_CHANGED" });
  assert.deepEqual(immutablePart(row), immutablePart(approvalBefore));
  assert.equal(await w.count("approvals"), approvalsBefore, "no approval row was deleted");
  assert.equal(await w.count("approvals", "plan_id = $1 AND withdrawn_at IS NULL", [plan.planId]), 0, "no live approval remains: future execution authority is revoked");
  assert.equal(await w.count("validation_receipts", "plan_id = $1", [plan.planId]), 1, "the receipt stays");
  const planRow = await w.row<{ state: string; version: string; approval_id: string | null; validation_receipt_hash: string | null }>("plans", "plan_id = $1", [plan.planId]);
  assert.deepEqual(planRow && { state: planRow.state, version: planRow.version, approval: planRow.approval_id, receipt: planRow.validation_receipt_hash }, { state: "WITHDRAWN", version: "6", approval: approval.approvalId, receipt: plan.receiptHash });
  // events: approval.withdrawn.v1 (approval v2) → NOTIFICATIONS + EXECUTION_CONTROL, carrying the completed stage by reference;
  // plan.withdrawn.v1 (plan v6) → EXECUTION_CONTROL. The EXECUTION_CONTROL rows are pending: the job package consumes them to
  // route active work through cancellation/reconciliation under its own state machine.
  const approvalEvents = await w.events("approval", approval.approvalId);
  assert.deepEqual(approvalEvents.map((e) => [e.version, e.type]), [[1, "approval.created.v1"], [2, "approval.withdrawn.v1"]]);
  assert.deepEqual(approvalEvents[1]?.payload, { approvalId: approval.approvalId, agencyId: w.A.agencyId, planId: plan.planId, withdrawnByMembershipId: w.memberships.approver, completedExternalActions: [stage.referenceId] });
  assert.deepEqual(await w.outbox(approvalEvents[1]!.eventId), ["EXECUTION_CONTROL", "NOTIFICATIONS"]);
  const planEvents = await w.events("plan", plan.planId);
  assert.deepEqual(planEvents.map((e) => [e.version, e.type]).slice(-2), [[5, "plan.approved.v1"], [6, "plan.withdrawn.v1"]]);
  assert.deepEqual(planEvents.at(-1)?.payload, { planId: plan.planId, agencyId: w.A.agencyId, approvalId: approval.approvalId });
  assert.deepEqual(await w.outbox(planEvents.at(-1)!.eventId), ["EXECUTION_CONTROL"]);
  assert.equal(await w.count("outbox_records", "event_id IN ($1, $2) AND state = 'PENDING'", [approvalEvents[1]!.eventId, planEvents.at(-1)!.eventId]), 3);
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 200, kind: "plan", id: plan.planId });
  assert.deepEqual(journal?.body, withdrawn.data);

  // future execution authority is gone: the withdrawn plan cannot be approved again
  const reapproval = await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, body: approvalBodyOf({ ...plan, version: 6 }, await w.stepUp(w.approver)) });
  assert.equal(outcome(w, reapproval), "409 PRECONDITION_FAILED PLAN_WITHDRAWN");
  assert.equal(await w.count("approvals", "plan_id = $1", [plan.planId]), 1);

  // an OWNER controls every approval of the agency (D-AUTHZ-3): the owner withdraws an approval another approver made; the
  // edition's inspector reports no completed action for that plan
  const second = await approvedPlan("withdraw-ok-owner", w.approver2);
  const byOwner = completed<WithdrawApprovalView>(await call(w, { url: routes.withdrawApproval(second.plan.planId), token: w.owner.token, body: { expectedVersion: 5, reasonCode: "OWNER_DECISION" } }), 200);
  assert.equal(byOwner.data.approval.withdrawnByMembershipId, w.memberships.owner);
  assert.equal(byOwner.data.approval.actorMembershipId, w.memberships.approver2);
  assert.deepEqual(byOwner.data.completedExternalActions, []);
});

test("DENY: VIEWER → 403; another APPROVER → 403 NOT_APPROVAL_CONTROLLER; foreign → 404; plan not APPROVED → 409 PRECONDITION_FAILED; stale version → 409 STALE_VERSION", async () => {
  const { plan, approval } = await approvedPlan("withdraw-deny");
  const url = routes.withdrawApproval(plan.planId);
  const body = { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" };
  // subjects in other states and in another agency, prepared before the oracle snapshot
  const validated = await w.approvable(w.A, projectId, "withdraw-deny-validated");
  const toSupersede = await w.approvable(w.A, projectId, "withdraw-deny-superseded");
  const successor = completed<{ plan: { planId: string } }>(
    await call(w, { url: routes.revisePlan(toSupersede.planId), token: w.operator.token, body: { expectedVersion: 4, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "AGENCY_DECISION" }) } }),
    201,
  ).data.plan.planId;
  const projectB = (await w.project(w.B, w.clientB)).projectId;
  const planB = await w.approvable(w.B, projectB, "withdraw-deny-foreign");
  // the stranger owns B (an OWNER approves, D-AUTHZ-1) and approves under B's selector
  const approvedB = await approveThroughRoute(w, planB, w.stranger, w.B.agencyId);
  assert.equal(approvedB.data.plan.state, "APPROVED");

  const denialsBefore = (await w.securityEvents("CMD026")).length;
  const countsBefore = await effectCounts(w);
  const snapshot = async () => ({
    approval: await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]),
    plan: await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [plan.planId]),
  });
  const rowsBefore = await snapshot();
  assert.deepEqual(rowsBefore.approval && [rowsBefore.approval.version, rowsBefore.approval.withdrawn_at], ["1", null]);

  // roles: VIEWER, OPERATOR and ADMIN hold no approval capability (D-AUTHZ-1, D-AUTHZ-2); a suspended member is refused as such
  for (const person of [w.viewer, w.operator, w.admin]) {
    assert.equal(outcome(w, await call(w, { url, token: person.token, body })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT", person.name);
  }
  assert.equal(outcome(w, await call(w, { url, token: w.suspended.token, body })), "403 NOT_AUTHORIZED MEMBERSHIP_SUSPENDED");
  // another APPROVER of the same agency does not control this approval (D-AUTHZ-3)
  assert.equal(outcome(w, await call(w, { url, token: w.approver2.token, body })), "403 NOT_AUTHORIZED NOT_APPROVAL_CONTROLLER");
  // foreign: under B's selector A's plan does not exist; with A's selector the stranger is no member; A's approver naming B's
  // plan under A's context finds nothing either (foreign and nonexistent look alike, D-AUTHZ-4)
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, agency: w.B.agencyId, body })), "404 NOT_FOUND -");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body })), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await call(w, { url: routes.withdrawApproval(planB.planId), token: w.approver.token, body })), "404 NOT_FOUND -");
  assert.equal(outcome(w, await call(w, { url: routes.withdrawApproval(ids.next()), token: w.approver.token, body })), "404 NOT_FOUND -", "a plan that never existed looks the same");
  // state: a VALIDATED plan has no approval to withdraw; a SUPERSEDED plan points at its successor
  const notApproved = await call(w, { url: routes.withdrawApproval(validated.planId), token: w.approver.token, body: { expectedVersion: 4, reasonCode: "SCOPE_CHANGED" } });
  assert.equal(outcome(w, notApproved), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  assert.deepEqual(asProblem(w, notApproved).current, { version: 4, state: "VALIDATED" });
  const supersededReply = await call(w, { url: routes.withdrawApproval(toSupersede.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" } });
  assert.equal(outcome(w, supersededReply), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  assert.deepEqual(asProblem(w, supersededReply).current, { version: 5, state: "SUPERSEDED", successorId: successor });
  // version: the controlling approver at a stale version receives the current safe version and state
  const stale = await call(w, { url, token: w.approver.token, body: { expectedVersion: 4, reasonCode: "SCOPE_CHANGED" } });
  assert.equal(outcome(w, stale), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 5, state: "APPROVED" });
  assert.deepEqual(asProblem(w, stale).nextActions.map((n) => n.action), ["RELOAD", "COMPARE_VERSIONS"]);
  // a reason that is not a label (registry type of CMD026 reasonCode, D-API-1) never reaches the database: a control
  // character, an empty string, more than 200 characters
  const controlCharacter = await call(w, { url, token: w.approver.token, body: { expectedVersion: 5, reasonCode: "scope\u0000changed" } });
  assert.equal(outcome(w, controlCharacter), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.deepEqual(asProblem(w, controlCharacter).errors, [{ field: "reasonCode", code: "FORMAT" }]);
  const empty = await call(w, { url, token: w.approver.token, body: { expectedVersion: 5, reasonCode: "" } });
  assert.equal(outcome(w, empty), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.ok(asProblem(w, empty).errors?.some((e) => e.field === "reasonCode" && e.code === "RANGE"));
  const tooLong = await call(w, { url, token: w.approver.token, body: { expectedVersion: 5, reasonCode: "x".repeat(201) } });
  assert.equal(outcome(w, tooLong), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.deepEqual(asProblem(w, tooLong).errors, [{ field: "reasonCode", code: "RANGE" }]);

  // oracle: no committed state — the approval is live at version 1, the plan APPROVED at version 5, no row added or deleted in
  // any table except the durable denial facts (security_events), no event, no outbox row, no journal row
  assert.deepEqual(await snapshot(), rowsBefore);
  const countsAfter = await effectCounts(w);
  assert.deepEqual({ ...countsAfter, security_events: 0 }, { ...countsBefore, security_events: 0 });
  const denials = (await w.securityEvents("CMD026")).slice(denialsBefore);
  assert.equal(countsAfter.security_events - countsBefore.security_events, denials.length);
  assert.deepEqual(
    sortedFacts(denials.map((d) => [d.reason, d.agencyId, d.actorId])),
    sortedFacts([
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.viewer.userId],
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.operator.userId],
      ["ROLE_INSUFFICIENT", w.A.agencyId, w.admin.userId],
      ["MEMBERSHIP_SUSPENDED", w.A.agencyId, w.suspended.userId],
      ["NOT_APPROVAL_CONTROLLER", w.A.agencyId, w.approver2.userId],
      // the stranger's probe of A is the stranger's own fact, never A's (review R2, R26)
      ["NOT_A_MEMBER", null, w.stranger.userId],
    ]),
  );
  assert.ok(denials.every((d) => d.outcome === "DENY" && d.policyVersion === "B06-1" && d.assuranceClass === "SESSION"));
  // history cannot be deleted by the runtime role at all: request handlers hold no DELETE privilege (D-RLS-2)
  await assert.rejects(
    w.asTenant(w.A, (c) => c.query("DELETE FROM kauro.approvals WHERE approval_id = $1", [approval.approvalId])),
    (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "42501",
  );
  assert.equal(await w.count("approvals", "approval_id = $1", [approval.approvalId]), 1);
});

test("RACE: two withdrawals → one 200, one 409; identical retry replays; a withdrawal cannot be undone (KA004)", async () => {
  const { plan, approval } = await approvedPlan("withdraw-race");
  const url = routes.withdrawApproval(plan.planId);
  const keyA = freshKey("cmd026-race-a");
  const keyB = freshKey("cmd026-race-b");
  const bodyA = { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" };
  // A (the approving actor) locks the plan and holds while completed external actions are identified; B (an OWNER) blocks on
  // the plan row lock (observed in pg_stat_activity); A commits WITHDRAWN v6; B reads version 6 and answers STALE_VERSION
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url, token: w.approver.token, key: keyA, body: bodyA });
  await hold.reached;
  const requestB = call(w, { url, token: w.owner.token, key: keyB, body: { expectedVersion: 5, reasonCode: "OWNER_DECISION" } });
  await waitForApiLockWait(w, "FOR UPDATE");
  hold.release();
  const [a, b] = await Promise.all([requestA, requestB]);
  const winner = completed<WithdrawApprovalView>(a, 200);
  assert.equal(winner.data.plan.state, "WITHDRAWN");
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, b).current, { version: 6, state: "WITHDRAWN" });
  // oracle: exactly one withdrawal — the winner's — with one event of each kind; the loser left no journal row
  const row = await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]);
  assert.deepEqual(row && [row.version, row.withdrawn_by_membership_id, row.withdraw_reason_code], ["2", w.memberships.approver, "SCOPE_CHANGED"]);
  const withdrawalEvents = async () => ({
    approval: await w.count("domain_events", "aggregate_id = $1 AND event_type = 'approval.withdrawn.v1'", [approval.approvalId]),
    plan: await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.withdrawn.v1'", [plan.planId]),
  });
  assert.deepEqual(await withdrawalEvents(), { approval: 1, plan: 1 });
  assert.equal(await w.journal(keyB), null);

  // the identical retry replays the journaled 200 byte for byte, with no second effect
  const replay = await call(w, { url, token: w.approver.token, key: keyA, body: bodyA });
  assert.equal(replay.status, 200);
  assert.equal(replay.text, replayTextOf(a));
  // the same key with another reason is a typed conflict with no effect
  const conflict = await call(w, { url, token: w.approver.token, key: keyA, body: { ...bodyA, reasonCode: "CHANGED_MIND" } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await withdrawalEvents(), { approval: 1, plan: 1 });
  assert.equal((await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]))?.withdraw_reason_code, "SCOPE_CHANGED");

  // a crash at the commit boundary of another withdrawal leaves its approval live and its plan APPROVED; the retry with the same
  // key is then the first execution of that key
  const fresh = await approvedPlan("withdraw-race-crash");
  const crashKey = freshKey("cmd026-crash");
  const crashBody = { expectedVersion: 5, reasonCode: "SCOPE_CHANGED" };
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.withdrawApproval(fresh.plan.planId), token: w.approver.token, key: crashKey, body: crashBody });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  const freshRow = await w.row<ApprovalRow>("approvals", "approval_id = $1", [fresh.approval.approvalId]);
  assert.deepEqual(freshRow && [freshRow.version, freshRow.withdrawn_at], ["1", null]);
  assert.equal((await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [fresh.plan.planId]))?.state, "APPROVED");
  assert.equal(await w.journal(crashKey), null);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'approval.withdrawn.v1'", [fresh.approval.approvalId]), 0);
  const retried = completed<WithdrawApprovalView>(await call(w, { url: routes.withdrawApproval(fresh.plan.planId), token: w.approver.token, key: crashKey, body: crashBody }), 200);
  assert.equal(retried.replayed, false);

  // a withdrawal cannot be undone: the database refuses clearing or rewriting it (approvals_withdraw_once, KA004) and the plan
  // cannot return to APPROVED (unlisted edge, KA008), even for the runtime role writing directly under the tenant context
  const sqlState = (code: string) => (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;
  await assert.rejects(
    w.asTenant(w.A, (c) => c.query("UPDATE kauro.approvals SET withdrawn_at = NULL, withdrawn_by_membership_id = NULL, withdraw_reason_code = NULL, version = version + 1 WHERE approval_id = $1", [approval.approvalId])),
    sqlState("KA004"),
  );
  await assert.rejects(
    w.asTenant(w.A, (c) => c.query("UPDATE kauro.approvals SET withdraw_reason_code = 'OTHER_REASON', version = version + 1 WHERE approval_id = $1", [approval.approvalId])),
    sqlState("KA004"),
  );
  await assert.rejects(w.asTenant(w.A, (c) => c.query("UPDATE kauro.plans SET state = 'APPROVED', version = version + 1 WHERE plan_id = $1", [plan.planId])), sqlState("KA008"));
  // nor through the command: the withdrawn plan is not APPROVED any more, and the first withdrawal stands
  const again = await call(w, { url, token: w.owner.token, body: { expectedVersion: 6, reasonCode: "OWNER_DECISION" } });
  assert.equal(outcome(w, again), "409 PRECONDITION_FAILED PLAN_NOT_APPROVED");
  const final = await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]);
  assert.deepEqual(final && [final.version, final.withdrawn_by_membership_id, final.withdraw_reason_code], ["2", w.memberships.approver, "SCOPE_CHANGED"]);
  assert.deepEqual(await withdrawalEvents(), { approval: 1, plan: 1 });
});


test("OK (reason label): the withdrawal reason is the registry's label — 'Customer asked us to stop' is accepted, stored and answered verbatim, and never copied into an event payload", async () => {
  // registry commands.json CMD026 fields: reasonCode type "label"; reference/FIELD_CONTRACTS types every reasonCode as a
  // label. Review findings R17/R27 (before: 400 SCHEMA_VIOLATION for this body). Labels may carry customer information
  // (FIELD_CONTRACTS "Common rules"), so the reason stays on the approval row and in the tenant's own answer; the events carry
  // references only (D-EVT-2).
  const { plan, approval } = await approvedPlan("withdraw-label");
  const reasonCode = "Customer asked us to stop";
  const withdrawn = completed<WithdrawApprovalView>(await call(w, { url: routes.withdrawApproval(plan.planId), token: w.approver.token, body: { expectedVersion: 5, reasonCode } }), 200);
  assert.equal(withdrawn.data.approval.withdrawReasonCode, reasonCode);
  assert.equal((await w.row<ApprovalRow>("approvals", "approval_id = $1", [approval.approvalId]))?.withdraw_reason_code, reasonCode);
  const payloads = [...(await w.events("approval", approval.approvalId)), ...(await w.events("plan", plan.planId))].map((e) => JSON.stringify(e.payload));
  assert.equal(payloads.filter((p) => p.includes("Customer") || p.includes("reasonCode")).length, 0, "no event payload carries the reason");
});
