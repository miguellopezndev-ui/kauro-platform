// Order 20 (review O20 F-1): a CLEAN plan — the canonical CLEAN hash, no target contract (CP-02.01; migrations 0097) — is validated by the
// platform's own PLAN_VALIDATION, not refused TARGET_UNAVAILABLE: AuditDiscovery.validationTarget answers CLEAN_ONLY for a plan of the CLEAN
// hash whose revision has a CLEAN audit, and PlanValidator runs the Migration-core port on it, skipping only the target body digest and the
// importer profile (which have no meaning without a target). A null target with any other hash stays TARGET_UNAVAILABLE. SIMULATED: the
// validator is the labelled Migration-core fake of B08-CORE-PORTS. The superuser is the oracle only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { CLEAN_ONLY_TARGET_HASH } from "@kauro/domain";
import { PlanValidator, planBodyHashOf } from "../src/audit/receipts.js";
import { openAuditWorld, type AuditWorld } from "./support/audit-world.js";
import { sha, startExecutionWorld, type ExecutionWorld } from "./support/execution-world.js";

let w: ExecutionWorld;
let a: AuditWorld;

before(async () => {
  w = await startExecutionWorld("o20-clean-validation");
  a = await openAuditWorld(w);
});

after(async () => {
  await w.stop();
});

test("F-1: PLAN_VALIDATION validates a CLEAN plan (no target contract) to VALIDATED under a VALID receipt binding the canonical CLEAN hash", async () => {
  const s = await w.subject(w.A, "o20-clean", { mode: "CLEAN" });
  assert.equal(s.targetContractHash, CLEAN_ONLY_TARGET_HASH);
  const started = await a.start(s);
  assert.equal(started.audit.targetContractId, undefined, "the CLEAN audit names no target contract");
  const plan = await a.plan(s, "clean");
  await a.requestValidation(s, plan.planId, 2);
  assert.deepEqual(await w.redeliver(w.x.consumers.planValidation, await w.eventOf(plan.planId, "plan.validating.v1")), { kind: "DONE" });
  const validated = await a.plan_(plan.planId);
  const [receipt] = await a.receipts(plan.planId);
  assert.ok(receipt, "the validator recorded a receipt");
  assert.deepEqual([validated.state, validated.validation_receipt_hash], ["VALIDATED", receipt.receipt_hash]);
  assert.deepEqual([receipt.result, receipt.target_contract_hash, receipt.revision_hash], ["VALID", CLEAN_ONLY_TARGET_HASH, s.revisionHash]);
  assert.equal(await w.h.oracle.query("SELECT 1 FROM kauro.target_contracts WHERE project_id = $1", [s.projectId]).then((r) => r.rowCount), 0, "no target contract exists");
});

test("F-1: PlanValidator takes CLEAN_ONLY only with the canonical CLEAN hash; a null target, or CLEAN_ONLY with another hash, is TARGET_UNAVAILABLE before the core", async () => {
  let coreCalled = false;
  const validator = new PlanValidator({ validate: { validate: async () => { coreCalled = true; throw new Error("not reached"); } }, receipts: {} as never, corePackageHash: sha("core"), limits: {} as never, storage: {} as never, scratchRoot: "/tmp" });
  const body = { revisionHash: sha("revision"), targetContractHash: sha("a-crm-target"), policyHash: sha("policy"), mappings: [], identities: [], transforms: [], relationships: [] };
  const run = (target: "CLEAN_ONLY" | null, targetContractHash: string) =>
    validator.run({ subject: { agencyId: "x" as never, planId: "p" as never, planHash: planBodyHashOf({ ...body, targetContractHash } as never), revisionHash: body.revisionHash, targetContractHash: targetContractHash as never }, body: { ...body, targetContractHash } as never, receiptId: "r" as never, startedAt: "2026-10-22T00:00:00.000Z" as never, cancellation: {} as never, source: null, target, completedAt: async () => "2026-10-22T00:00:00.000Z" as never });
  assert.deepEqual(await run(null, CLEAN_ONLY_TARGET_HASH), { kind: "CONTRACT_FAILURE", reason: "TARGET_UNAVAILABLE", evidenceClass: "EXECUTED_LOCAL" });
  assert.deepEqual(await run("CLEAN_ONLY", sha("a-crm-target")), { kind: "CONTRACT_FAILURE", reason: "TARGET_UNAVAILABLE", evidenceClass: "EXECUTED_LOCAL" });
  // CLEAN_ONLY with the canonical hash passes the target checks and reaches the source check (no source here: VALIDATION_SOURCE_UNAVAILABLE)
  assert.deepEqual(await run("CLEAN_ONLY", CLEAN_ONLY_TARGET_HASH), { kind: "CONTRACT_FAILURE", reason: "VALIDATION_SOURCE_UNAVAILABLE", evidenceClass: "EXECUTED_LOCAL" });
  assert.equal(coreCalled, false);
});
