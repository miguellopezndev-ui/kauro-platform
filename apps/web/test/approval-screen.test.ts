// UI22 Approval (design D-A11Y-2, D-OPS-1; cases R2-062, R2-064; CMD025). The gate (what blocks approval), the markup (exact effects, the
// dialog with one acknowledgement per effect, no approve control when blocked) and the one command through the real api client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationRunner } from "../src/client/operation-runner.ts";
import { stateOfProblem } from "../src/client/states.ts";
import { type ApprovalFacts, approvalGate, approvePlan } from "../src/screens/approval/model.ts";
import { ApprovalDetails } from "../src/screens/approval/view.tsx";
import { AGENCY, harness, HASH, PROJECT, problem, respond } from "./support/fixtures.ts";

const PLAN = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb1";
const PROOF = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e5fb2";
const facts = (over: Partial<ApprovalFacts> = {}): ApprovalFacts => ({
  planId: PLAN,
  planVersion: 4,
  planState: "VALIDATED",
  planHash: HASH,
  validationReceiptHash: "d".repeat(64),
  disclosuresHash: "e".repeat(64),
  effects: [
    { id: "clear-1", description: "Clear the phone column on duplicate rows", count: "1200", kind: "CLEAR" },
    { id: "merge-1", description: "Merge 340 company pairs", count: "340", kind: "MERGE" },
  ],
  ...over,
});
const noop = (): void => undefined;
const render = (over: Partial<ApprovalFacts> = {}, approving = false): string => renderToStaticMarkup(createElement(ApprovalDetails, { facts: facts(over), onApprove: noop, approving, reviewHref: "/agencies/a/projects/p/plan/mapping" }));
const fastRunner = (): OperationRunner => new OperationRunner({ now: () => Date.parse("2026-10-14T00:00:00Z"), randomBytes: (n) => new Uint8Array(n).fill(5), wait: async () => undefined });

test("UI22 gate: only a validated plan with a validation receipt and at least one disclosed effect can be approved; a hidden effect blocks", () => {
  assert.equal(approvalGate(facts()).kind, "READY");
  assert.equal(approvalGate(facts({ planState: "DRAFT" })).kind, "NOT_VALIDATED");
  assert.equal(approvalGate(facts({ planState: "VALIDATION_REQUIRED" })).kind, "NOT_VALIDATED");
  assert.equal(approvalGate(facts({ validationReceiptHash: null })).kind, "NOT_VALIDATED");
  assert.equal(approvalGate(facts({ effects: [] })).kind, "HIDDEN_EFFECT");
  assert.equal(approvalGate(facts({ planState: "APPROVED" })).kind, "ALREADY_APPROVED");
});

test("UI22: a ready plan lists every effect with its count and offers Review and approve and the way back; the dialog is not open yet", () => {
  const html = render();
  assert.ok(html.includes("Approve these exact preparation decisions."));
  assert.ok(html.includes("Clear the phone column on duplicate rows (1200 rows are affected)") && html.includes("Merge 340 company pairs (340 rows are affected)"));
  assert.ok(html.includes("Review and approve") && html.includes('href="/agencies/a/projects/p/plan/mapping"') && html.includes("Return to review"));
  assert.ok(!html.includes("Approve this plan"), "the dialog is in the document only while open");
});

test("UI22: a blocked plan shows why and the way back, and no approve control and no dialog", () => {
  const hidden = render({ effects: [] });
  assert.ok(hidden.includes("An effect is not disclosed") && !hidden.includes("Review and approve") && hidden.includes("Return to review"));
  const notValidated = render({ planState: "DRAFT" });
  assert.ok(notValidated.includes("Not saved yet") && !notValidated.includes("Review and approve"));
  assert.ok(!render({ planState: "APPROVED" }).includes("Review and approve"));
});

test("UI22: while approving, Review and approve is disabled", () => {
  assert.match(render({}, true), /<button[^>]*disabled[^>]*>Review and approve<\/button>/);
});

test("CMD025: approval sends the three hashes of the plan read and the fresh proof, under one key per plan version", async () => {
  const planView = { planId: PLAN, agencyId: AGENCY, projectId: PROJECT, version: 5, state: "APPROVED", bodyHash: HASH, revisionHash: HASH, targetContractHash: HASH, policyHash: HASH, validationReceiptHash: "d".repeat(64), approvalId: PROOF, createdAt: "2026-10-13T12:00:00Z", permittedActions: ["WithdrawApproval"] };
  const approvalView = { approvalId: PROOF, actorId: PROOF, agencyId: AGENCY, planId: PLAN, version: 1, actorMembershipId: PROOF, planHash: HASH, revisionHash: HASH, targetContractHash: HASH, validationReceiptHash: "d".repeat(64), disclosuresHash: "e".repeat(64), approvalHash: HASH, createdAt: "2026-10-14T00:00:00Z", permittedActions: ["WithdrawApproval"] };
  const approved = { kind: "COMPLETED", version: 5, replayed: false, data: { approval: approvalView, plan: planView } };
  const { client, sent } = harness(async () => respond(201, approved));
  const outcome = await approvePlan(client, fastRunner(), facts(), PROOF);
  assert.equal(outcome.kind, "COMPLETED", "a reply that is a valid ApprovePlanView is the only success");
  const forged = await approvePlan(harness(async () => respond(201, { kind: "COMPLETED", version: 5, replayed: false, data: {} })).client, fastRunner(), facts(), PROOF);
  assert.equal(forged.kind, "INTEGRITY", "a body that is not an ApprovePlanView is an integrity failure, never a success");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, `/api/v1/plans/${PLAN}/approve`);
  assert.deepEqual(JSON.parse(sent[0]?.init.body ?? "{}"), { expectedVersion: 4, planHash: HASH, validationReceiptHash: "d".repeat(64), disclosuresHash: "e".repeat(64), assuranceProofRef: PROOF });
  const again = harness(async () => respond(201, approved));
  await approvePlan(again.client, fastRunner(), facts(), PROOF);
  await approvePlan(again.client, fastRunner(), facts({ planVersion: 5 }), PROOF);
  const keys = [sent[0], ...again.sent].map((entry) => entry?.init.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1], "the same plan version is the same intent");
  assert.notEqual(keys[0], keys[2]);
});

test("CMD025: a blocked plan is refused before any request, and a missing or stale step-up is the DENIED/STEP_UP state that keeps the person's edits", async () => {
  const { client, sent } = harness(async () => respond(200, {}));
  await assert.rejects(() => approvePlan(client, fastRunner(), facts({ effects: [] }), PROOF), /approval is blocked: HIDDEN_EFFECT/);
  await assert.rejects(() => approvePlan(client, fastRunner(), facts({ planState: "DRAFT" }), PROOF), /NOT_VALIDATED/);
  assert.equal(sent.length, 0);
  const stepUp = harness(async () => respond(403, problem(403, "ASSURANCE_REQUIRED", { reason: "STEP_UP_STALE" })));
  const outcome = await approvePlan(stepUp.client, fastRunner(), facts(), PROOF);
  assert.equal(outcome.kind, "PROBLEM");
  if (outcome.kind === "PROBLEM") {
    const decision = stateOfProblem(outcome.problem);
    assert.equal(decision.next, "STEP_UP");
    assert.equal(decision.keepsLocalEdits, true);
  }
});

test("CMD025: a stale plan version or hash mismatch is the stale state, never an approval", async () => {
  const { client } = harness(async () => respond(409, problem(409, "STALE_VERSION", { reason: "HASH_MISMATCH", current: { version: 6, state: "VALIDATED", mismatch: ["planHash"] } })));
  const outcome = await approvePlan(client, fastRunner(), facts(), PROOF);
  assert.equal(outcome.kind, "PROBLEM");
  if (outcome.kind === "PROBLEM") assert.equal(stateOfProblem(outcome.problem).state, "STALE");
});
