// Order 20 — the in-force behaviour with the O19A candidate's activation OFF (the default of every deployment): the served StartAudit still
// requires targetContractId (400 SCHEMA_VIOLATION, the closed schema, as before CP-02), a CLEAN project's audit with a confirmed target is
// queued on that target exactly as before, and the served validator admits neither candidate reason. The candidate behaviour is
// o20-clean-candidate.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { OPERATIONAL_ROUTES, createSchemaValidator, type ContractSchemaBundle } from "@kauro/application";
import { CANDIDATE_FAILURE_REASONS, CLEAN_ONLY_TARGET_HASH, FAILURE_REASONS } from "@kauro/domain";
import { auditEvents, auditIdOf, auditRow, auditWorld, footprint, fundPool, getAudit, startAudit, subjectOf, viewOf, type AuditWorld } from "./audit-support.js";
import { outcome } from "./support.js";
import { assembleApi } from "../src/index.js";

let aw: AuditWorld;
before(async () => {
  aw = await auditWorld();
  await fundPool(aw);
});
after(async () => {
  await aw.stop();
});

test("activation off: a StartAudit without targetContractId is the closed schema's 400 SCHEMA_VIOLATION and writes nothing; with its target a CLEAN audit binds that target as before", async () => {
  const { w } = aw;
  const subject = await subjectOf(w);
  const written = await footprint(w);
  const omitted = await startAudit(w, subject.revisionId, {});
  assert.equal(outcome(w, omitted), "400 INVALID_REQUEST SCHEMA_VIOLATION");
  assert.deepEqual(await footprint(w), written, "nothing written");

  const started = await startAudit(w, subject.revisionId, { targetContractId: subject.contractId });
  const auditId = auditIdOf(started);
  const row = await auditRow(w, auditId);
  assert.equal(row.target_contract_id, subject.contractId);
  assert.equal(row.target_contract_hash, subject.targetContractHash);
  assert.notEqual(row.target_contract_hash, CLEAN_ONLY_TARGET_HASH);
  const [queued] = await auditEvents(w, auditId);
  assert.equal(queued?.payload["targetContractId"], subject.contractId, "audit.queued.v1 carries its target as before");
  assert.equal(viewOf(await getAudit(w, auditId)).targetContractId, subject.contractId, "the served AuditView carries its target as before");
});

test("activation off: the served schemas are the in-force ones — CMD020 requires its target and the Problem reasons exclude the candidate's", () => {
  const bundle = JSON.parse(readFileSync(new URL(import.meta.resolve("@kauro/contracts/schemas.json")), "utf8")) as ContractSchemaBundle;
  const served = createSchemaValidator(bundle, OPERATIONAL_ROUTES);
  const candidate = createSchemaValidator(bundle, OPERATIONAL_ROUTES, { cleanWithoutTarget: true });
  const body = { auditPolicyVersion: "R2-INITIAL" };
  assert.equal(served.validate("urn:kauro:api:v1:request:CMD020", body).kind, "INVALID");
  assert.equal(candidate.validate("urn:kauro:api:v1:request:CMD020", body).kind, "VALID");
  for (const reason of CANDIDATE_FAILURE_REASONS) assert.equal((FAILURE_REASONS as ReadonlyArray<string>).includes(reason), false, `${reason} stays out of the served reasons`);
  const problem = { type: "urn:kauro:problem:INVALID_REQUEST", title: "Invalid request", status: 400, code: "INVALID_REQUEST", reason: "TARGET_NOT_APPLICABLE", correlationId: "c-1", retryable: false, nextActions: [] };
  assert.equal(served.validate("Problem", problem).kind, "INVALID");
  assert.equal(candidate.validate("Problem", problem).kind, "VALID");
});

test("review M-6: assembleApi itself refuses the candidate switch outside LOCAL (defence in depth beside the configuration)", () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    assert.throws(() => assembleApi({ environment, candidate: { cleanWithoutTarget: true } } as never), /LOCAL environment only/, environment);
  }
});
