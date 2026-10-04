// PLAN_VALIDATION (package B08, mandate B08-CONTROL-AUDIT; docs/design/B08-audit-approval-jobs.md §3, §8.1, §11; decisions D8-PLAN-2,
// D8-PAU-6; supporting B01's CMD024 and B03's IC-03) on a real PostgreSQL 17 through this package's own control plane: ValidatePlan's
// intent (the request handlers' write through the audit store; the route is B08-COMMANDS-AUDIT's) reaches PLAN_VALIDATION with
// plan.validating.v1; PLAN_VALIDATION runs the Migration-core port on exactly the intent's plan body, source and target, checks the
// answer against them and the core the platform binds, has the validator's own pool (kauro_validator_test) write the receipt, and
// settles only the plan's current intent — VALIDATED under a VALID receipt of exactly its subjects, back to VALIDATION_REQUIRED
// otherwise. SIMULATED: the validator is the labelled Migration-core fake of B08-CORE-PORTS; a validator answering for other inputs,
// null or incomplete, and a validation held in flight, are test decorators of that fake's answer (IC-03's faults), never a fake of
// their own. A redelivery is the same event handed to another control-plane process. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ValidateResult } from "@kauro/application";
import { CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH } from "@kauro/application/testing/cores";
import { heldValidate, openAuditWorld, validatorAnswering, type AuditWorld } from "./support/audit-world.js";
import { sha, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;

before(async () => {
  w = await startExecutionWorld("plan-validation");
  a = await openAuditWorld(w);
});

after(async () => {
  await w.stop();
});

test("PLAN_VALIDATION validates only the current intent: a receipt for another body, source, target or core, a null or incomplete receipt and a receipt after the plan was revised never make it VALIDATED", async () => {
  const s = await w.subject(w.A, "plan-validation");
  const validation = w.x.consumers.planValidation;
  const deliver = async (plane: typeof validation, planId: string): Promise<unknown> => w.redeliver(plane, await w.eventOf(planId, "plan.validating.v1"));
  const planeValidating = (answer: Parameters<typeof validatorAnswering>[1]) => {
    const plane = w.planeWith({ validate: validatorAnswering(w.core, answer) }).execution;
    assert.ok(plane !== null);
    return plane.consumers.planValidation;
  };

  // --- the valid neighbour: the fake validates exactly the intent's subjects, and the plan is VALIDATED under its receipt -----------
  const good = await a.plan(s, "good");
  const intent = await a.requestValidation(s, good.planId, 2);
  assert.deepEqual([intent.fence, intent.origin, intent.planHash], [1, "COMMAND", good.bodyHash]);
  assert.deepEqual(await deliver(validation, good.planId), { kind: "DONE" });
  const validated = await a.plan_(good.planId);
  const [receipt] = await a.receipts(good.planId);
  assert.ok(receipt);
  assert.deepEqual([validated.state, validated.version, validated.validation_receipt_hash], ["VALIDATED", "4", receipt.receipt_hash]);
  assert.deepEqual(
    [receipt.result, receipt.plan_hash, receipt.revision_hash, receipt.target_contract_hash, receipt.core_package_hash],
    ["VALID", good.bodyHash, s.revisionHash, s.targetContractHash, CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH],
  );
  assert.deepEqual(await a.validations(good.planId), [[1, "COMMAND", "VALID", receipt.receipt_hash]]);
  assert.deepEqual((await a.events(good.planId)).slice(-1), [["plan.validated.v1", "SERVICE", "plan-validation"]]);
  // a redelivery of the settled intent validates nothing again
  assert.deepEqual(await deliver(validation, good.planId), { kind: "DONE" });
  assert.equal((await a.receipts(good.planId)).length, 1);

  // --- the validator's faulty answers (IC-03): a typed contract failure, the intent settled ERROR, never VALIDATED ------------------
  const altered = (change: (r: NonNullable<ValidateResult["receipt"]>) => unknown): Parameters<typeof validatorAnswering>[1] =>
    async (request, inner) => {
      const out = await inner.validate(request);
      assert.ok(out.receipt !== null);
      return { ...out, receipt: change(out.receipt) as ValidateResult["receipt"] };
    };
  const faults: ReadonlyArray<readonly [string, Parameters<typeof validatorAnswering>[1]]> = [
    ["a receipt for another body", (request, inner) => inner.validate({ ...request, planHash: sha("another-plan-body") })],
    ["a receipt for another source", (request, inner) => inner.validate({ ...request, revisionHash: sha("another-source-revision") })],
    ["a receipt for another target", (request, inner) => inner.validate({ ...request, targetContractHash: sha("another-target-contract") })],
    ["a receipt for another core", altered((r) => ({ ...r, corePackageHash: sha("another-migration-core-package") }))],
    ["a null receipt", async (request, inner) => ({ ...(await inner.validate(request)), receipt: null })],
    ["an incomplete receipt (a hash missing)", altered(({ artifactEvidenceHash: _missing, ...rest }) => rest)],
    ["an incomplete receipt (a malformed hash)", altered((r) => ({ ...r, dispositionEvidenceHash: "not-a-sha256" }))],
  ];
  for (const [label, answer] of faults) {
    const p = await a.plan(s, label);
    await a.requestValidation(s, p.planId, 2);
    assert.deepEqual(await deliver(planeValidating(answer), p.planId), { kind: "DONE" }, label);
    const after = await a.plan_(p.planId);
    assert.deepEqual([after.state, after.version, after.validation_receipt_hash], ["VALIDATION_REQUIRED", "4", null], `${label}: never VALIDATED`);
    assert.deepEqual(await a.validations(p.planId), [[1, "COMMAND", "ERROR", null]], `${label}: the intent settled as a contract failure`);
    assert.deepEqual(await a.receipts(p.planId), [], `${label}: no receipt of other inputs is recorded for the plan`);
    assert.ok(!(await a.events(p.planId)).some(([type]) => type === "plan.validated.v1"), label);
    // the good validator's later delivery of the same record finds the intent settled: nothing changes
    assert.deepEqual(await deliver(validation, p.planId), { kind: "DONE" }, `${label}: redelivered`);
    assert.equal((await a.plan_(p.planId)).state, "VALIDATION_REQUIRED", label);
  }

  // --- only the current intent validates: a late VALID answer for an intent the plan moved past --------------------------------------
  {
    const p = await a.plan(s, "stale-intent");
    await a.requestValidation(s, p.planId, 2);
    const first = await w.eventOf(p.planId, "plan.validating.v1");
    const held = heldValidate(w.core);
    const slowPlane = w.planeWith({ validate: held.port }).execution;
    assert.ok(slowPlane !== null);
    // delivery A validates intent 1 correctly, its answer held in flight
    const late = w.redeliver(slowPlane.consumers.planValidation, first);
    await held.hold.reached;
    // delivery B of the same intent meets a null answer: intent 1 ERROR, the plan needs validation again (v4)
    assert.deepEqual(await w.redeliver(planeValidating(async (request, inner) => ({ ...(await inner.validate(request)), receipt: null })), first), { kind: "DONE" });
    assert.deepEqual(await a.validations(p.planId), [[1, "COMMAND", "ERROR", null]]);
    // ValidatePlan again: intent 2 is the plan's current one (v5, VALIDATING)
    const second = await a.requestValidation(s, p.planId, 4);
    assert.equal(second.fence, 2);
    held.hold.release();
    assert.deepEqual(await late, { kind: "DONE" }, "the late answer of intent 1 is refused");
    const stillValidating = await a.plan_(p.planId);
    assert.deepEqual([stillValidating.state, stillValidating.version, stillValidating.validation_receipt_hash], ["VALIDATING", "5", null], "intent 1's receipt never moves the plan");
    const lateReceipts = await a.receipts(p.planId);
    assert.deepEqual(lateReceipts.map((r) => r.result), ["VALID"], "the late VALID receipt stays evidence of what the validator saw");
    assert.deepEqual(await a.validations(p.planId), [[1, "COMMAND", "ERROR", null], [2, "COMMAND", null, null]]);
    // the current intent's own validation makes it VALIDATED, under its own receipt, not the late one
    assert.deepEqual(await w.redeliver(validation, await w.eventOf(p.planId, "plan.validating.v1")), { kind: "DONE" });
    const current = await a.plan_(p.planId);
    const receipts = await a.receipts(p.planId);
    assert.equal(receipts.length, 2);
    const own = receipts[1];
    assert.ok(own);
    assert.deepEqual([current.state, current.validation_receipt_hash], ["VALIDATED", own.receipt_hash]);
    assert.notEqual(own.receipt_hash, lateReceipts[0]?.receipt_hash);
    assert.deepEqual(await a.validations(p.planId), [[1, "COMMAND", "ERROR", null], [2, "COMMAND", "VALID", own.receipt_hash]]);
  }

  // --- a receipt after the plan was revised: the predecessor is SUPERSEDED and its late VALID receipt validates nothing ------------
  {
    const p = await a.plan(s, "revised");
    await a.requestValidation(s, p.planId, 2);
    const event = await w.eventOf(p.planId, "plan.validating.v1");
    const held = heldValidate(w.core);
    const slowPlane = w.planeWith({ validate: held.port }).execution;
    assert.ok(slowPlane !== null);
    const late = w.redeliver(slowPlane.consumers.planValidation, event);
    await held.hold.reached;
    assert.deepEqual(await w.redeliver(planeValidating(async (request, inner) => ({ ...(await inner.validate(request)), receipt: null })), event), { kind: "DONE" });
    // CMD023: the agency revises the plan (SUPERSEDED at v5, a successor DRAFT with another body)
    const successor = await a.revise(s, p.planId, 4);
    held.hold.release();
    assert.deepEqual(await late, { kind: "DONE" });
    const revised = await a.plan_(p.planId);
    assert.deepEqual([revised.state, revised.superseded_by_plan_id, revised.validation_receipt_hash], ["SUPERSEDED", successor, null], "the revised plan is never VALIDATED");
    assert.ok(!(await a.events(p.planId)).some(([type]) => type === "plan.validated.v1"));
    assert.deepEqual((await a.receipts(p.planId)).map((r) => r.result), ["VALID"], "the late VALID receipt stays evidence, bound by no plan");
    assert.deepEqual(await a.validations(p.planId), [[1, "COMMAND", "ERROR", null]]);
    const next = await a.plan_(successor);
    assert.deepEqual([next.state, next.validation_receipt_hash], ["DRAFT", null], "the successor is untouched by its predecessor's receipt");
    assert.deepEqual(await a.receipts(successor), []);
  }
});
