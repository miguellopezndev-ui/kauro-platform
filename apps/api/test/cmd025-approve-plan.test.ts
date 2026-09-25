// CMD025 ApprovePlan — POST /api/v1/plans/{planId}/approve — AGENCY_APPROVER (registry cases CMD025-OK / -DENY / -RACE and
// S051 at the command level; design §8, D-PLAN-2, D-PLAN-3; Plan machine edge agency_approval "Authorized actor, current
// assurance and exact disclosed effects match. Create immutable Approval"; catalogue failure "Any changed effect, expired
// source or stale receipt requires new review; generic cleanup approval cannot authorize undisclosed CLEAR"). Real route
// over real plan, receipt, revision and contract rows; the disclosure composer is the test-bound port of this edition.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import type { ApprovePlanView, RevisePlanView } from "@kauro/application";
import type { ProjectId } from "@kauro/domain";
import { SimulatedCrash, approveThroughRoute, asProblem, bodyHashOf, call, completed, disclosureItemsOf, disclosuresHashOf, freshKey, ids, outcome, rawEvent, rootCause, routes, sha, waitForApiLockWait, world, type Person, type PlanFixture, type World } from "./support.js";
import { reachedHold, tenantWriter, waitForWriterLockWait, type HeldTransaction } from "./writers.js";

let w: World;
let projectId: ProjectId;
before(async () => {
  w = await world();
  projectId = (await w.project(w.A, w.clientA)).projectId;
});
after(async () => {
  await w.stop();
});

/**
 * The approval-hash oracle of this file, written from reference/HASHING_AND_ACCOUNTING_RULES and not from the product (21
 * "Independent oracles"): SHA-256 over the UTF-8 bytes of the canonical wrapper {domain, payload, version} with the domain
 * KAURO_PLAN_APPROVAL_V1 (the authority's approval-hash domain as amendment A2 names it), version 1 and exactly the nine preimage members, every key
 * in code-point order, no whitespace. It uses neither approvalHashOf nor the canonical serializer of @kauro/contracts.
 */
function independentApprovalHash(p: Readonly<Record<"approvalId" | "actorId" | "agencyId" | "planHash" | "revisionHash" | "targetContractHash" | "validationReceiptHash" | "disclosuresHash" | "createdAt", string>>): string {
  const s = (v: string): string => JSON.stringify(v);
  const payload =
    `{"actorId":${s(p.actorId)},"agencyId":${s(p.agencyId)},"approvalId":${s(p.approvalId)},"createdAt":${s(p.createdAt)},` +
    `"disclosuresHash":${s(p.disclosuresHash)},"planHash":${s(p.planHash)},"revisionHash":${s(p.revisionHash)},` +
    `"targetContractHash":${s(p.targetContractHash)},"validationReceiptHash":${s(p.validationReceiptHash)}}`;
  return createHash("sha256").update(`{"domain":"KAURO_PLAN_APPROVAL_V1","payload":${payload},"version":1}`, "utf8").digest("hex");
}

/**
 * The golden vector the oracle is checked against before it is trusted: the expected hex was derived outside the product with
 * GNU sha256sum and cross-checked with python3 json + hashlib (derivation recorded in packages/application/test/approval-hash.test.ts).
 */
const GOLDEN = {
  members: {
    approvalId: "01920000-0000-7000-8000-000000000a01",
    actorId: "5c3f2a10-6b7d-5e8f-9a0b-1c2d3e4f5a6b",
    agencyId: "01920000-0000-7000-8000-000000000a02",
    planHash: "1".repeat(64),
    revisionHash: "2".repeat(64),
    targetContractHash: "3".repeat(64),
    validationReceiptHash: "4".repeat(64),
    disclosuresHash: "5".repeat(64),
    createdAt: "2026-09-25T08:30:00.000Z",
  },
  hex: "d7e978a907f91024533df149e1430afbb933936eaf9b8eefc74c1edc70b3fb4b",
} as const;

/** The body an approver sends after reviewing the complete disclosure set the server composes. */
function approvalBody(plan: PlanFixture, proof: string, overrides: Partial<Record<"expectedVersion" | "planHash" | "validationReceiptHash" | "disclosuresHash", string | number>> = {}) {
  if (plan.receiptHash === null) throw new Error("fixture has no receipt");
  return {
    expectedVersion: plan.version,
    planHash: plan.bodyHash,
    validationReceiptHash: plan.receiptHash,
    disclosuresHash: disclosuresHashOf(plan.bodyHash, plan.receiptHash, disclosureItemsOf(plan.body, plan.affectedRows)),
    assuranceProofRef: proof,
    ...overrides,
  };
}

test("OK: an APPROVER with a fresh step-up approves a VALIDATED plan whose receipt, source and target are current; the approval hash binds the named preimage", async () => {
  const plan = await w.approvable(w.A, projectId, "approve-ok", "CLEAR");
  const proof = await w.stepUp(w.approver);
  const key = freshKey("cmd025-ok");
  const reply = completed<ApprovePlanView>(await call(w, { url: routes.approvePlan(plan.planId), token: w.approver.token, key, body: approvalBody(plan, proof) }), 201);
  assert.equal(reply.replayed, false);
  assert.equal(reply.version, 5, "the plan version after approval");
  const { approval, plan: approved } = reply.data;
  assert.equal(approved.state, "APPROVED");
  assert.equal(approved.version, 5);
  assert.equal(approved.approvalId, approval.approvalId);
  assert.equal(approval.version, 1);
  assert.equal(approval.planId, plan.planId);
  assert.equal(approval.actorMembershipId, w.memberships.approver);
  assert.equal(approval.planHash, plan.bodyHash);
  assert.equal(approval.revisionHash, plan.revisionHash);
  assert.equal(approval.targetContractHash, plan.targetContractHash);
  assert.equal(approval.validationReceiptHash, plan.receiptHash);
  assert.equal(approval.disclosuresHash, disclosuresHashOf(plan.bodyHash, plan.receiptHash!, disclosureItemsOf(plan.body, plan.affectedRows)));
  assert.equal(approval.withdrawnAt, undefined);
  assert.deepEqual(Object.keys(approval).sort(), ["actorMembershipId", "agencyId", "approvalHash", "approvalId", "createdAt", "disclosuresHash", "planHash", "planId", "revisionHash", "targetContractHash", "validationReceiptHash", "version"], "no token, recovery setting or security evidence in the view");

  // oracle: the approvals row binds the actor's membership version and step-up proof, the five hashes equal the plan and
  // receipt (the disclosures hash the one the test composer computes, CLEAR included), and the approval hash recomputed
  // independently over the named preimage (KAURO_PLAN_APPROVAL_V1) matches — every member read from the superuser oracle's
  // row, the oracle function first checked against the golden vector derived outside the product
  assert.equal(independentApprovalHash(GOLDEN.members), GOLDEN.hex);
  const row = await w.row<{ approval_id: string; agency_id: string; actor_id: string; actor_membership_id: string; actor_membership_version: string; assurance_proof_ref: string; plan_hash: string; revision_hash: string; target_contract_hash: string; validation_receipt_hash: string; disclosures_hash: string; approval_hash: string; created_at: Date; withdrawn_at: Date | null; version: string }>("approvals", "approval_id = $1", [approval.approvalId]);
  assert.ok(row);
  assert.deepEqual(
    { agency: row.agency_id, actor: row.actor_id, membership: row.actor_membership_id, membershipVersion: row.actor_membership_version, proof: row.assurance_proof_ref, plan: row.plan_hash, revision: row.revision_hash, target: row.target_contract_hash, receipt: row.validation_receipt_hash, disclosures: row.disclosures_hash, version: row.version, withdrawn: row.withdrawn_at },
    // the approver's membership is at version 2: invited (v1), then accepted by the approver (v2)
    { agency: w.A.agencyId, actor: w.approver.userId, membership: w.memberships.approver, membershipVersion: "2", proof, plan: plan.bodyHash, revision: plan.revisionHash, target: plan.targetContractHash, receipt: plan.receiptHash, disclosures: disclosuresHashOf(plan.bodyHash, plan.receiptHash!, disclosureItemsOf(plan.body, plan.affectedRows)), version: "1", withdrawn: null },
  );
  const recomputed = independentApprovalHash({
    approvalId: row.approval_id,
    actorId: row.actor_id,
    agencyId: row.agency_id,
    planHash: row.plan_hash,
    revisionHash: row.revision_hash,
    targetContractHash: row.target_contract_hash,
    validationReceiptHash: row.validation_receipt_hash,
    disclosuresHash: row.disclosures_hash,
    createdAt: row.created_at.toISOString(),
  });
  assert.equal(row.approval_hash, recomputed);
  assert.equal(approval.approvalHash, recomputed);
  assert.equal(approval.createdAt, row.created_at.toISOString());
  const planRow = await w.row<{ state: string; version: string; approval_id: string | null; validation_receipt_hash: string | null }>("plans", "plan_id = $1", [plan.planId]);
  assert.deepEqual(planRow && { state: planRow.state, version: planRow.version, approval: planRow.approval_id, receipt: planRow.validation_receipt_hash }, { state: "APPROVED", version: "5", approval: approval.approvalId, receipt: plan.receiptHash });
  // events: approval.created.v1 (v1) → NOTIFICATIONS; plan.approved.v1 (v5)
  const approvalEvents = await w.events("approval", approval.approvalId);
  assert.deepEqual(approvalEvents.map((e) => [e.version, e.type]), [[1, "approval.created.v1"]]);
  assert.equal(approvalEvents[0]?.payload["approvalHash"], recomputed);
  assert.deepEqual(await w.outbox(approvalEvents[0]!.eventId), ["NOTIFICATIONS"]);
  const planEvents = await w.events("plan", plan.planId);
  assert.deepEqual(planEvents.map((e) => [e.version, e.type]).slice(-1), [[5, "plan.approved.v1"]]);
  assert.deepEqual(planEvents.at(-1)?.payload, { planId: plan.planId, agencyId: w.A.agencyId, approvalId: approval.approvalId, approvalHash: recomputed });
  const journal = await w.journal(key);
  assert.deepEqual(journal && { state: journal.state, status: journal.status, kind: journal.resourceKind, id: journal.resourceId }, { state: "COMMITTED", status: 201, kind: "approval", id: approval.approvalId });
  // the proof is reusable inside its freshness window: a second approval (another plan) with the same proof succeeds
  const another = await w.approvable(w.A, projectId, "approve-ok-2");
  completed<ApprovePlanView>(await call(w, { url: routes.approvePlan(another.planId), token: w.approver.token, body: approvalBody(another, proof) }), 201);
});

test("DENY: OPERATOR → 403; foreign → 404; stale/missing step-up → 403 ASSURANCE_REQUIRED; stale receipt → 422 PLAN_NOT_VALIDATED; disclosuresHash computed without the CLEAR set → 409 STALE_VERSION mismatch [disclosuresHash]; EXPIRED source → 422 SOURCE_EXPIRED; superseded target → 422 TARGET_STALE", async () => {
  const plan = await w.approvable(w.A, projectId, "approve-deny", "CLEAR");
  const proof = await w.stepUp(w.approver);
  const url = routes.approvePlan(plan.planId);
  const approvalsBefore = await w.count("approvals");
  const journalBefore = await w.count("command_journal");
  const denialsBefore = (await w.securityEvents("CMD025")).length;
  const planSnapshot = () => w.row<{ state: string; version: string; approval_id: string | null }>("plans", "plan_id = $1", [plan.planId]);
  const before = await planSnapshot();
  assert.deepEqual(before, { ...before, state: "VALIDATED", version: "4", approval_id: null });

  // roles: OPERATOR, ADMIN and VIEWER do not approve (D-AUTHZ-2); the stranger is not a member; B's context hides the plan
  for (const person of [w.operator, w.admin, w.viewer]) {
    const proofOf = await w.stepUp(person);
    assert.equal(outcome(w, await call(w, { url, token: person.token, body: approvalBody(plan, proofOf) })), "403 NOT_AUTHORIZED ROLE_INSUFFICIENT", person.name);
  }
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, body: approvalBody(plan, await w.stepUp(w.stranger)) })), "404 NOT_FOUND NOT_A_MEMBER");
  assert.equal(outcome(w, await call(w, { url, token: w.stranger.token, agency: w.B.agencyId, body: approvalBody(plan, await w.stepUp(w.stranger)) })), "404 NOT_FOUND -");

  // assurance: a stale proof, a proof of another person (invisible under the self policy), an unknown reference
  const stale = await call(w, { url, token: w.approver.token, body: approvalBody(plan, await w.stepUp(w.approver, "STALE")) });
  assert.equal(outcome(w, stale), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  assert.deepEqual(asProblem(w, stale).nextActions, [{ action: "STEP_UP" }]);
  const notOwned = await call(w, { url, token: w.approver.token, body: approvalBody(plan, await w.stepUp(w.approver2)) });
  assert.equal(outcome(w, notOwned), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  const unknownProof = await call(w, { url, token: w.approver.token, body: approvalBody(plan, ids.next()) });
  assert.equal(outcome(w, unknownProof), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  const malformedProof = await call(w, { url, token: w.approver.token, body: approvalBody(plan, "00000000-0000-4000-8000-000000000000") });
  assert.equal(outcome(w, malformedProof), "403 ASSURANCE_REQUIRED STEP_UP_MISSING", "a well-formed id that is not a platform proof id");

  // bindings: a stale receipt, a changed body, an approval displayed without the CLEAR set
  const staleReceipt = await call(w, { url, token: w.approver.token, body: approvalBody(plan, proof, { validationReceiptHash: sha("another receipt") }) });
  assert.equal(outcome(w, staleReceipt), "422 PLAN_NOT_VALIDATED RECEIPT_NOT_CURRENT");
  assert.deepEqual(asProblem(w, staleReceipt).nextActions, [{ action: "REQUEST_NEW_REVIEW" }]);
  const changedBody = await call(w, { url, token: w.approver.token, body: approvalBody(plan, proof, { planHash: sha("another body") }) });
  assert.equal(outcome(w, changedBody), "409 STALE_VERSION HASH_MISMATCH");
  assert.deepEqual(asProblem(w, changedBody).current, { version: 4, state: "VALIDATED", mismatch: ["planHash"] });
  const withoutClear = disclosuresHashOf(plan.bodyHash, plan.receiptHash!, disclosureItemsOf(plan.body, plan.affectedRows).filter((i) => !i.startsWith("CLEAR:")));
  assert.notEqual(withoutClear, disclosuresHashOf(plan.bodyHash, plan.receiptHash!, disclosureItemsOf(plan.body, plan.affectedRows)));
  const undisclosedClear = await call(w, { url, token: w.approver.token, body: approvalBody(plan, proof, { disclosuresHash: withoutClear }) });
  assert.equal(outcome(w, undisclosedClear), "409 STALE_VERSION DISCLOSURES_INCOMPLETE");
  assert.deepEqual(asProblem(w, undisclosedClear).current, { version: 4, state: "VALIDATED", mismatch: ["disclosuresHash"] });
  const staleVersion = await call(w, { url, token: w.approver.token, body: approvalBody(plan, proof, { expectedVersion: 3 }) });
  assert.equal(outcome(w, staleVersion), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleVersion).current, { version: 4, state: "VALIDATED" });

  // subjects: an EXPIRED source revision and a superseded target contract each require a new review
  const expiredSource = await w.revision(w.A, projectId, "EXPIRED");
  const currentTarget = await w.targetContract(w.A, projectId);
  const onExpired = await w.plan(w.A, projectId, { revisionHash: expiredSource.revisionHash, targetContractHash: currentTarget.targetContractHash, seed: "expired-source" });
  const expired = await call(w, { url: routes.approvePlan(onExpired.planId), token: w.approver.token, body: approvalBody(onExpired, proof) });
  assert.equal(outcome(w, expired), "422 SOURCE_EXPIRED -");
  const sealedSource = await w.revision(w.A, projectId, "SEALED");
  const supersededTarget = await w.targetContract(w.A, projectId, { superseded: true });
  const onSuperseded = await w.plan(w.A, projectId, { revisionHash: sealedSource.revisionHash, targetContractHash: supersededTarget.targetContractHash, seed: "superseded-target" });
  const superseded = await call(w, { url: routes.approvePlan(onSuperseded.planId), token: w.approver.token, body: approvalBody(onSuperseded, proof) });
  assert.equal(outcome(w, superseded), "422 TARGET_STALE -");

  // oracle: no approvals row anywhere; the plan is still VALIDATED at version 4 without an approval; no journal row; the
  // authorization and assurance denials are durable security facts with their assurance class
  assert.equal(await w.count("approvals"), approvalsBefore);
  assert.deepEqual(await planSnapshot(), before);
  assert.equal(await w.count("command_journal"), journalBefore);
  const denials = (await w.securityEvents("CMD025")).slice(denialsBefore);
  assert.deepEqual(
    denials.map((d) => `${d.reason}:${d.assuranceClass}`).sort(),
    ["NOT_A_MEMBER:SESSION", "ROLE_INSUFFICIENT:SESSION", "ROLE_INSUFFICIENT:SESSION", "ROLE_INSUFFICIENT:SESSION", "STEP_UP_MISSING:STEP_UP", "STEP_UP_NOT_OWNED:STEP_UP", "STEP_UP_NOT_OWNED:STEP_UP", "STEP_UP_STALE:STEP_UP"],
  );

  // the database independently refuses an approval with a stale hash (23503): the bindings are foreign keys, not only checks
  await assert.rejects(
    w.h.app.run(w.h.tenant(w.A.agencyId, w.approver.userId), (uow) =>
      uow.approvals.insert({
        approvalId: uow.ids.next() as never,
        agencyId: w.A.agencyId,
        planId: plan.planId,
        actorId: w.approver.userId,
        actorMembershipId: w.memberships.approver,
        actorMembershipVersion: 1,
        assuranceProofRef: proof as never,
        planHash: sha("another body"),
        revisionHash: plan.revisionHash,
        targetContractHash: plan.targetContractHash,
        validationReceiptHash: plan.receiptHash!,
        disclosuresHash: sha("d"),
        approvalHash: sha("a"),
        createdAt: new Date().toISOString() as never,
      }),
    ),
    (e: unknown) => typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "INVALID_REQUEST" && (e as unknown as { details: { reason?: string } }).details.reason === "UNKNOWN_REFERENCE",
  );
  assert.equal(await w.count("approvals"), approvalsBefore);
});

test("RACE: two approvers on one version → one 201, one 409; identical retry replays; conflicting → 409 IDEMPOTENCY_CONFLICT; a crash before COMMIT leaves the plan VALIDATED with no approval and the same key then approves it once", async () => {
  const plan = await w.approvable(w.A, projectId, "approve-race");
  const url = routes.approvePlan(plan.planId);
  const proofA = await w.stepUp(w.approver);
  const proofB = await w.stepUp(w.approver2);
  const keyA = freshKey("cmd025-race-a");
  const bodyA = approvalBody(plan, proofA);
  // A locks the plan and holds while the disclosure set is composed; B blocks on the row lock; A commits APPROVED v5; B reads
  // version 5 and answers STALE_VERSION — one approval, never two (approvals_one_live_per_plan is the database's guard)
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url, token: w.approver.token, key: keyA, body: bodyA });
  await hold.reached;
  const requestB = call(w, { url, token: w.approver2.token, key: freshKey("cmd025-race-b"), body: approvalBody(plan, proofB) });
  await waitForApiLockWait(w, "FOR UPDATE");
  hold.release();
  const [a, b] = await Promise.all([requestA, requestB]);
  const winner = completed<ApprovePlanView>(a, 201);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, b).current, { version: 5, state: "APPROVED" });
  assert.equal(await w.count("approvals", "plan_id = $1 AND withdrawn_at IS NULL", [plan.planId]), 1);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.approved.v1'", [plan.planId]), 1);
  assert.equal((await w.row<{ actor_id: string }>("approvals", "plan_id = $1", [plan.planId]))?.actor_id, w.approver.userId);
  // the identical retry replays; the same key with another body is a typed conflict
  const replay = completed<ApprovePlanView>(await call(w, { url, token: w.approver.token, key: keyA, body: bodyA }), 201);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, winner.data);
  const conflict = await call(w, { url, token: w.approver.token, key: keyA, body: { ...bodyA, disclosuresHash: sha("other") } });
  assert.equal(outcome(w, conflict), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("approvals", "plan_id = $1", [plan.planId]), 1);

  // crash at the intent/commit boundary, before COMMIT: the approval row, the plan transition to APPROVED and both events were
  // written inside the transaction, then the process dies where the journal entry would complete. Nothing is committed — the
  // plan is VALIDATED at version 4 with no approval, no event and no journal row — and the same key is then the first
  // execution of that logical operation, which approves the plan exactly once
  const fresh = await w.approvable(w.A, projectId, "approve-race-crash");
  const crashKey = freshKey("cmd025-crash");
  const crashBody = approvalBody(fresh, await w.stepUp(w.approver));
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await call(w, { url: routes.approvePlan(fresh.planId), token: w.approver.token, key: crashKey, body: crashBody });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(asProblem(w, crashed).nextActions, [{ action: "RETRY_SAME_KEY" }]);
  assert.equal(rootCause(w.internalErrors.at(-1)?.error) instanceof SimulatedCrash, true);
  const crashedPlan = await w.row<{ state: string; version: string; approval_id: string | null }>("plans", "plan_id = $1", [fresh.planId]);
  assert.deepEqual(crashedPlan && [crashedPlan.state, crashedPlan.version, crashedPlan.approval_id], ["VALIDATED", "4", null]);
  assert.equal(await w.count("approvals", "plan_id = $1", [fresh.planId]), 0);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.approved.v1'", [fresh.planId]), 0);
  assert.equal(await w.journal(crashKey), null);
  const retried = completed<ApprovePlanView>(await call(w, { url: routes.approvePlan(fresh.planId), token: w.approver.token, key: crashKey, body: crashBody }), 201);
  assert.equal(retried.replayed, false);
  assert.equal(await w.count("approvals", "plan_id = $1", [fresh.planId]), 1);
  assert.equal(await w.count("domain_events", "aggregate_id = $1 AND event_type = 'plan.approved.v1'", [fresh.planId]), 1);
});

test("RACE: two ApprovePlan calls — one 201, one 409; no approval of a superseded body", async () => {
  // S051 at the approval command: two approvals race on one plan version, then the approved body is superseded by a
  // revision and the old approval can no longer attach to anything current
  const plan = await w.approvable(w.A, projectId, "s051-approve");
  const url = routes.approvePlan(plan.planId);
  const hold = w.holds.arm("collaborator");
  const requestA = call(w, { url, token: w.approver.token, body: approvalBody(plan, await w.stepUp(w.approver)) });
  await hold.reached;
  const requestB = call(w, { url, token: w.owner.token, body: approvalBody(plan, await w.stepUp(w.owner)) });
  await waitForApiLockWait(w, "FOR UPDATE");
  hold.release();
  const [a, b] = await Promise.all([requestA, requestB]);
  const approved = completed<ApprovePlanView>(a, 201);
  assert.equal(outcome(w, b), "409 STALE_VERSION -");
  // the revision supersedes the approved body and names the invalidated approval in its impact map; superseding an approved
  // plan ends the approval, so it is revised by who controls the approval — here an OWNER (D-AUTHZ-3, design D-PLAN-4)
  const revised = completed<RevisePlanView>(await call(w, { url: routes.revisePlan(plan.planId), token: w.owner.token, body: { expectedVersion: 5, decisionPatchArtifactRef: w.plans.registerPatch(w.A.agencyId, { candidate: "Phone", reasonCode: "SECOND_THOUGHTS" }) } }), 201);
  assert.deepEqual(revised.data.invalidated, { validationReceiptHash: plan.receiptHash, approvalId: approved.data.approval.approvalId });
  assert.deepEqual((await w.events("plan", plan.planId)).at(-1)?.payload, { planId: plan.planId, agencyId: w.A.agencyId, successorPlanId: revised.data.plan.planId, invalidatedApprovalId: approved.data.approval.approvalId, invalidatedReceiptHash: plan.receiptHash });
  // a stale UI approving the superseded body at the version it saw is told where the content went; the successor was never
  // validated; the old approval row stays as history and is not live authority for the successor
  const staleApproval = await call(w, { url, token: w.approver.token, body: approvalBody(plan, await w.stepUp(w.approver), { expectedVersion: 5 }) });
  assert.equal(outcome(w, staleApproval), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, staleApproval).current, { version: 6, state: "SUPERSEDED", successorId: revised.data.plan.planId });
  const successorApproval = await call(w, { url: routes.approvePlan(revised.data.plan.planId), token: w.approver.token, body: { ...approvalBody(plan, await w.stepUp(w.approver)), expectedVersion: 2, planHash: revised.data.plan.bodyHash } });
  assert.equal(outcome(w, successorApproval), "422 PLAN_NOT_VALIDATED -");
  assert.equal(await w.count("approvals", "plan_id = $1", [plan.planId]), 1);
  assert.equal(await w.count("approvals", "plan_id = $1 AND withdrawn_at IS NULL", [plan.planId]), 0, "the superseded body keeps no live approval");
  assert.equal(await w.count("approvals", "plan_id = $1", [revised.data.plan.planId]), 0);
});

test("the approval binds its source and target through the planHash the approver names (the interim binding of the manual-10 / catalogue conflict, open question Q9)", async () => {
  // Manual 10 "Approval commands name sourceRevisionHash, planHash and targetContractHash"; the catalogue's CMD025 fields
  // name planHash only. Review finding R32. What the interim binding rests on, observed on the real rows: the planHash is the
  // digest of a body that names the source and the target, the plan row carries exactly those two hashes, and the approval
  // row binds them — so no approval can bind a source or a target its planHash does not commit to.
  const plan = await w.approvable(w.A, projectId, "q9-binding");
  const approval = (await approveThroughRoute(w, plan)).data.approval;
  const stored = await w.row<{ body: PlanFixture["body"]; body_hash: string; revision_hash: string; target_contract_hash: string }>("plans", "plan_id = $1", [plan.planId]);
  assert.ok(stored);
  assert.equal(bodyHashOf(stored.body), approval.planHash, "the planHash is the digest of the stored body");
  assert.deepEqual([stored.body.revisionHash, stored.body.targetContractHash], [stored.revision_hash, stored.target_contract_hash], "the body names the plan's source and target");
  assert.deepEqual([approval.revisionHash, approval.targetContractHash], [stored.revision_hash, stored.target_contract_hash], "the approval binds them");
  // the preimage commits to each of them: another source or another target is another planHash
  assert.notEqual(bodyHashOf({ ...stored.body, revisionHash: sha("another source") }), approval.planHash);
  assert.notEqual(bodyHashOf({ ...stored.body, targetContractHash: sha("another target") }), approval.planHash);
});

/** The dataset_revisions row a plan fixture's source hash names (superuser oracle). */
async function sourceRowOf(plan: PlanFixture): Promise<{ revision_id: string; version: string }> {
  const row = await w.row<{ revision_id: string; version: string }>("dataset_revisions", "manifest_hash = $1", [plan.revisionHash]);
  if (!row) throw new Error("the plan fixture has no source revision row");
  return row;
}

/** The target_contracts row a plan fixture's target hash names (superuser oracle). */
async function targetRowOf(plan: PlanFixture): Promise<{ contract_id: string }> {
  const row = await w.row<{ contract_id: string }>("target_contracts", "body_hash = $1", [plan.targetContractHash]);
  if (!row) throw new Error("the plan fixture has no target contract row");
  return row;
}

/**
 * B07's retention_expires edge (SEALED -> EXPIRED), written inside the writer's open transaction. B06 registers no revision
 * lifecycle event beyond creation (B07 registers its own), so the new version is recorded with the registered revision event
 * the database requires for every version (D-EVT-1).
 */
async function expireSource(writer: HeldTransaction, revision: { revision_id: string; version: string }): Promise<void> {
  await writer.query("UPDATE kauro.dataset_revisions SET state = 'EXPIRED', version = version + 1 WHERE revision_id = $1", [revision.revision_id]);
  await rawEvent(writer.client, { aggregateKind: "dataset_revision", aggregateId: revision.revision_id, aggregateVersion: Number(revision.version) + 1, agencyId: w.A.agencyId, eventType: "dataset_revision.created.v1", actorUserId: w.A.ownerUserId, payload: { revisionId: revision.revision_id, agencyId: w.A.agencyId, state: "EXPIRED" } });
}

test("RACE: a source expiry racing ApprovePlan — the sealed revision is held under a share lock to COMMIT: an expiry that comes second waits and then reads the approval; an expiry committed first is refused 422 SOURCE_EXPIRED", async () => {
  // 07 "Transaction discipline": "Multi-row invariants use explicit locking"; catalogue CMD025 failure: "Any changed effect,
  // expired source or stale receipt requires new review". Review findings R15/R19.
  const proof = await w.stepUp(w.approver);

  // (a) the approval first: A holds inside the disclosure composer (after the source and target were read); B07's expiry of
  // that source is observed waiting on A's share lock, so it cannot commit while A decides; A commits 201; the expiry then
  // commits ordered after A and reads the approval its own edge effect ("Revoke reads/execution") has to reach
  const first = await w.approvable(w.A, projectId, "race-expiry-second");
  const firstSource = await sourceRowOf(first);
  const writerA = await tenantWriter(w, w.A);
  try {
    const hold = w.holds.arm("collaborator");
    const request = call(w, { url: routes.approvePlan(first.planId), token: w.approver.token, body: approvalBody(first, proof) });
    await reachedHold(hold, request);
    const expiry = expireSource(writerA, firstSource);
    try {
      await waitForWriterLockWait(w, writerA, "UPDATE kauro.dataset_revisions");
    } finally {
      hold.release();
    }
    const approved = completed<ApprovePlanView>(await request, 201);
    await expiry;
    const seen = await writerA.query<{ approval_id: string }>("SELECT approval_id FROM kauro.approvals WHERE revision_hash = $1 AND withdrawn_at IS NULL", [first.revisionHash]);
    assert.deepEqual(seen.rows.map((r) => r.approval_id), [approved.data.approval.approvalId], "the expiry is serialized after the approval and sees it");
    await writerA.commit();
  } finally {
    await writerA.close();
  }
  assert.equal((await w.row<{ state: string }>("dataset_revisions", "revision_id = $1", [firstSource.revision_id]))?.state, "EXPIRED");

  // (b) the expiry first: it holds its row lock uncommitted; the approval is observed waiting on it for its share lock; the
  // expiry commits; the approval re-reads the committed revision, which is no longer SEALED: 422 SOURCE_EXPIRED, nothing
  // committed — no approval, the plan still VALIDATED v4, no journal row
  const second = await w.approvable(w.A, projectId, "race-expiry-first");
  const secondSource = await sourceRowOf(second);
  const approvalsBefore = await w.count("approvals");
  const key = freshKey("cmd025-race-expiry-first");
  const writerB = await tenantWriter(w, w.A);
  try {
    await expireSource(writerB, secondSource);
    const request = call(w, { url: routes.approvePlan(second.planId), token: w.approver.token, key, body: approvalBody(second, proof) });
    try {
      await waitForApiLockWait(w, "FROM kauro.dataset_revisions");
    } finally {
      await writerB.commit();
    }
    assert.equal(outcome(w, await request), "422 SOURCE_EXPIRED -");
  } finally {
    await writerB.close();
  }
  assert.equal(await w.count("approvals"), approvalsBefore);
  const plan = await w.row<{ state: string; version: string; approval_id: string | null }>("plans", "plan_id = $1", [second.planId]);
  assert.deepEqual(plan && { state: plan.state, version: plan.version, approval: plan.approval_id }, { state: "VALIDATED", version: "4", approval: null });
  assert.equal(await w.journal(key), null);
});

test("RACE: a target-contract supersession racing ApprovePlan — the contract is held under a share lock to COMMIT: a supersession that comes second waits and then reads the approval; one committed first is refused 422 TARGET_STALE", async () => {
  // Review findings R15/R19 (target half): CMD025 binds the exact target; B08's supersession of the contract must be ordered
  // against the approval, never interleaved between the check and the approval's COMMIT.
  const proof = await w.stepUp(w.approver);

  // (a) the approval first; the supersession waits on its share lock and, ordered after it, reads the approval
  const first = await w.approvable(w.A, projectId, "race-target-second");
  const firstTarget = await targetRowOf(first);
  const writerA = await tenantWriter(w, w.A);
  try {
    const hold = w.holds.arm("collaborator");
    const request = call(w, { url: routes.approvePlan(first.planId), token: w.approver.token, body: approvalBody(first, proof) });
    await reachedHold(hold, request);
    const supersession = writerA.query("UPDATE kauro.target_contracts SET superseded_at = now() WHERE contract_id = $1", [firstTarget.contract_id]);
    try {
      await waitForWriterLockWait(w, writerA, "UPDATE kauro.target_contracts");
    } finally {
      hold.release();
    }
    const approved = completed<ApprovePlanView>(await request, 201);
    await supersession;
    const seen = await writerA.query<{ approval_id: string }>("SELECT approval_id FROM kauro.approvals WHERE target_contract_hash = $1 AND withdrawn_at IS NULL", [first.targetContractHash]);
    assert.deepEqual(seen.rows.map((r) => r.approval_id), [approved.data.approval.approvalId], "the supersession is serialized after the approval and sees it");
    await writerA.commit();
  } finally {
    await writerA.close();
  }

  // (b) the supersession first: the approval waits on the contract's row lock, then reads it superseded: 422 TARGET_STALE
  const second = await w.approvable(w.A, projectId, "race-target-first");
  const secondTarget = await targetRowOf(second);
  const approvalsBefore = await w.count("approvals");
  const key = freshKey("cmd025-race-target-first");
  const writerB = await tenantWriter(w, w.A);
  try {
    await writerB.query("UPDATE kauro.target_contracts SET superseded_at = now() WHERE contract_id = $1", [secondTarget.contract_id]);
    const request = call(w, { url: routes.approvePlan(second.planId), token: w.approver.token, key, body: approvalBody(second, proof) });
    try {
      await waitForApiLockWait(w, "FROM kauro.target_contracts");
    } finally {
      await writerB.commit();
    }
    assert.equal(outcome(w, await request), "422 TARGET_STALE -");
  } finally {
    await writerB.close();
  }
  assert.equal(await w.count("approvals"), approvalsBefore);
  const plan = await w.row<{ state: string; version: string }>("plans", "plan_id = $1", [second.planId]);
  assert.deepEqual(plan && { state: plan.state, version: plan.version }, { state: "VALIDATED", version: "4" });
  assert.equal(await w.journal(key), null);
});

export type { Person };
