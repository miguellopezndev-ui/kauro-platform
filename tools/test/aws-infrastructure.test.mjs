// Order 25: the offline checks of the AWS infrastructure (deploy/aws). Evidence class VERIFIED_STATIC: they judge the documents and
// the configuration this repository would send to AWS, never what a real account does (deploy/aws/procedures/QUALIFICATION.md).
// The Terraform plan tests (TESTED_LOCAL, mocked provider) run in .github/workflows/aws-iac.yml.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const { arnLike, evaluate, policyEffect } = await import("../../deploy/aws/checks/iam-eval.mjs");
const { bind, placeholdersOf, minified } = await import("../../deploy/aws/checks/render.mjs");
const world = await import("../../deploy/aws/checks/world.mjs");
const matrix = await import("../../deploy/aws/checks/authority-matrix.mjs");
const guards = await import("../../deploy/aws/checks/static-guards.mjs");
const cost = await import("../../deploy/aws/cost/estimate.mjs");

const { WORLD, WORLD_SPEND_STOPPED, PRINCIPALS: P, DOCUMENTS, IDS, BUCKETS, ATTEMPT } = world;
const accepted = `arn:aws:s3:::${BUCKETS.object}/${ATTEMPT.sealedObject}`;

// ---- The evaluator's own semantics (each a documented IAM rule) ----------------------------------------------------------------

test("evaluator: ARN matching is per segment, wildcards stay inside their segment", () => {
  assert.equal(arnLike("arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_X_*", "arn:aws:iam::222222222222:role/aws-reserved/sso.amazonaws.com/us-east-2/AWSReservedSSO_X_ab"), true);
  assert.equal(arnLike("arn:aws:iam::*:role/kauro-deletion/*", "arn:aws:iam::222222222222:role/other/kauro-deletion/x"), false);
  assert.equal(arnLike("arn:aws:s3:::bucket/staging/*", "arn:aws:s3:::bucket/accepted/x"), false);
  assert.equal(arnLike("arn:aws:iam::111111111111:*", "arn:aws:iam::222222222222:role/x"), false);
});

test("evaluator: an absent key fails a positive operator, satisfies a negated one, and IfExists/Null behave as documented", () => {
  const doc = (Condition) => ({ Statement: [{ Sid: "S", Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition }] });
  const request = (context) => ({ principal: {}, action: "s3:GetObject", resource: "arn:aws:s3:::b/k", context });
  assert.equal(policyEffect(doc({ StringEquals: { "aws:SourceVpce": "vpce-1" } }), request({})), null);
  assert.equal(policyEffect(doc({ StringNotEquals: { "aws:SourceVpce": "vpce-1" } }), request({}))?.effect, "ALLOW");
  assert.equal(policyEffect(doc({ StringEqualsIfExists: { "aws:SourceVpce": "vpce-1" } }), request({}))?.effect, "ALLOW");
  assert.equal(policyEffect(doc({ Null: { "s3:if-none-match": "true" } }), request({}))?.effect, "ALLOW");
  assert.equal(policyEffect(doc({ Null: { "s3:if-none-match": "true" } }), request({ "s3:if-none-match": "*" })), null);
  assert.equal(policyEffect(doc({ ArnNotLike: { "aws:PrincipalArn": ["arn:aws:iam::1:role/a", "arn:aws:iam::1:role/b"] } }), request({ "aws:PrincipalArn": "arn:aws:iam::1:role/b" })), null);
  assert.equal(policyEffect(doc({ "ForAllValues:StringEquals": { "aws:TagKeys": ["a", "b"] } }), request({ "aws:TagKeys": ["a", "c"] })), null);
  assert.equal(policyEffect(doc({ "ForAllValues:StringEquals": { "aws:TagKeys": ["a", "b"] } }), request({ "aws:TagKeys": ["b"] }))?.effect, "ALLOW");
});

test("evaluator: an operator the model does not know throws instead of judging", () => {
  const doc = { Statement: [{ Sid: "S", Effect: "Deny", Action: "*", Resource: "*", Condition: { IpAddress: { "aws:SourceIp": "10.0.0.0/8" } } }] };
  assert.throws(() => policyEffect(doc, { principal: {}, action: "s3:GetObject", resource: "*", context: { "aws:SourceIp": "10.0.0.1" } }), /not modelled/);
});

test("evaluator: across accounts both the identity and the resource must allow; in one account either does", () => {
  const bucketOnly = { ...WORLD, scps: {}, rcps: {} };
  const noIdentity = { ...P.controlPlane, identityPolicies: [], boundary: null };
  assert.equal(evaluate(bucketOnly, { principal: noIdentity, action: "s3:GetObject", resource: accepted, resourceAccount: IDS.data, context: {} }).decision, "DENY");
  assert.equal(evaluate(bucketOnly, { principal: P.controlPlane, action: "s3:GetObject", resource: accepted, resourceAccount: IDS.data, context: {} }).decision, "ALLOW");
});

test("evaluator: in one account a grant to the account root only delegates; RCPs bind AWS service principals; ForAnyValue on an absent key is false", () => {
  const rootGrant = { Statement: [{ Sid: "Root", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${IDS.data}:root` }, Action: "s3:GetObject", Resource: "*" }] };
  const w = { managementAccountId: IDS.management, scps: {}, rcps: {}, resourcePolicyOf: () => rootGrant };
  const noIdentity = { arn: `arn:aws:iam::${IDS.data}:role/x`, account: IDS.data, orgId: IDS.org, type: "role", identityPolicies: [] };
  assert.equal(evaluate(w, { principal: noIdentity, action: "s3:GetObject", resource: accepted, resourceAccount: IDS.data, context: {} }).decision, "DENY");
  const service = { account: undefined, type: "service", service: "cloudtrail.amazonaws.com", identityPolicies: [] };
  const r = evaluate({ ...WORLD, resourcePolicyOf: () => null }, { principal: service, action: "s3:GetObject", resource: accepted, resourceAccount: IDS.data, context: { "aws:SecureTransport": "false" } });
  assert.equal(r.layer, "RCP");
  const doc = { Statement: [{ Sid: "S", Effect: "Allow", Action: "s3:GetObject", Resource: "*", Condition: { "ForAnyValue:StringNotEquals": { "aws:TagKeys": ["a"] } } }] };
  assert.equal(policyEffect(doc, { principal: {}, action: "s3:GetObject", resource: "*", context: {} }), null);
});

// ---- Rendering --------------------------------------------------------------------------------------------------------------------

test("render: an unbound placeholder fails, as Terraform's templatefile() does", () => {
  assert.throws(() => bind('{"a":"${MISSING}"}', {}), /unbound placeholder/);
  assert.deepEqual(placeholdersOf('"${B}" "${A}" "${B}"'), ["A", "B"]);
});

test("every SCP and RCP fits the 5,120-character limit with room to spare", () => {
  for (const name of ["scpMemberBaseline", "scpDataRetention", "scpDataIdentity", "scpWorkloadGuard", "scpSpendStop", "rcpDataPerimeter"]) {
    const size = minified(DOCUMENTS[name]).length;
    assert.ok(size <= 5120, `${name}: ${size}`);
  }
});

// ---- The authority matrix ------------------------------------------------------------------------------------------------------

test("authority matrix: every row decides as the design states (D-19, D-21, B14-A)", () => {
  const rows = [...matrix.evaluateRows(matrix.ROWS, WORLD), ...matrix.evaluateRows(matrix.SPEND_STOP_ROWS, WORLD_SPEND_STOPPED)];
  const wrong = rows.filter((r) => r.actual !== r.expected).map((r) => `${r.group}: ${r.principal} ${r.action} ${r.resource} expected ${r.expected}, got ${r.actual} ${r.layer} ${r.sid}`);
  assert.deepEqual(wrong, []);
  assert.ok(rows.length >= 70);
});

test("authority matrix: deploy/aws/AUTHORITY-MATRIX.md is regenerated from the rows", () => {
  assert.equal(readFileSync(matrix.MATRIX_PATH, "utf8"), matrix.renderMarkdown(), "run node deploy/aws/checks/authority-matrix.mjs --write");
});

test("D-19: only the deletion identity can bypass retention, from every account and principal the organization has", () => {
  const holders = Object.entries(P)
    .filter(([, principal]) => evaluate(WORLD, { principal, action: "s3:BypassGovernanceRetention", resource: accepted, resourceAccount: IDS.data, context: { "aws:SourceVpce": IDS.endpoint } }).decision === "ALLOW")
    .map(([name]) => name);
  assert.deepEqual(holders, ["deletionRole"]);
});

test("negative control: the retention bypass is held by at least two independent layers, and falls only when all are removed", () => {
  const bypass = (w, principal) => evaluate(w, { principal, action: "s3:BypassGovernanceRetention", resource: accepted, resourceAccount: IDS.data, context: {} }).decision;
  const bucketWithoutDeny = { ...DOCUMENTS.customerBucket, Statement: DOCUMENTS.customerBucket.Statement.filter((s) => s.Sid !== "GovernanceBypassAndLegalHoldOnlyByTheDeletionIdentity") };
  const noScp = { ...WORLD, scps: { ...WORLD.scps, [IDS.data]: [DOCUMENTS.scpMemberBaseline, DOCUMENTS.scpDataIdentity] } };
  const noRcp = { ...WORLD, rcps: {} };
  const noBucketDeny = { ...WORLD, resourcePolicyOf: (r) => (r.includes(BUCKETS.object) ? bucketWithoutDeny : WORLD.resourcePolicyOf(r)) };
  const none = { ...noScp, rcps: {}, resourcePolicyOf: noBucketDeny.resourcePolicyOf };
  for (const w of [noScp, noRcp, noBucketDeny]) assert.equal(bypass(w, P.dataAdmin), "DENY");
  assert.equal(bypass(none, P.dataAdmin), "ALLOW", "with every guard removed an administrator would hold it: the guards, not the model, deny");
});

test("negative control: without the workload SCP a workload administrator could forge an attempt role", () => {
  const create = (w) => evaluate(w, { principal: P.workloadAdmin, action: "iam:CreateRole", resource: P.forgedAttemptRole.arn, resourceAccount: IDS.workload, context: { "iam:PermissionsBoundary": `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary` } }).decision;
  assert.equal(create(WORLD), "DENY");
  assert.equal(create({ ...WORLD, scps: { ...WORLD.scps, [IDS.workload]: [DOCUMENTS.scpMemberBaseline] } }), "ALLOW");
});

test("the management account: no SCP binds it (AWS Organizations), so the data account's RCP and bucket policies are what deny it", () => {
  const r = evaluate(WORLD, { principal: P.managementAdmin, action: "s3:BypassGovernanceRetention", resource: accepted, resourceAccount: IDS.data, context: {} });
  assert.equal(r.decision, "DENY");
  assert.notEqual(r.layer, "SCP");
});

// ---- Static guards ---------------------------------------------------------------------------------------------------------------

for (const [name, guard] of Object.entries(guards.ALL_GUARDS)) {
  test(`static guard: ${name}`, () => {
    assert.deepEqual(guard(), []);
  });
}

test("static guards detect what they forbid (negative controls)", () => {
  assert.deepEqual(guards.scanTerraformText('resource "aws_nat_gateway" "x" {}'), ["a NAT gateway (fixed cost, internet egress)"]);
  assert.deepEqual(guards.scanTerraformText("  publicly_accessible = true"), ["a public database"]);
  assert.deepEqual(guards.scanTerraformText('  cidr_ipv4 = "0.0.0.0/0"'), ["a rule open to the internet"]);
  assert.deepEqual(guards.scanTerraformText('      mode = "COMPLIANCE"'), ["COMPLIANCE retention (D-19: GOVERNANCE only)"]);
  assert.deepEqual(guards.scanTerraformText('# resource "aws_nat_gateway" "commented" {}'), []);
  assert.deepEqual(guards.scanSecretsText("key AKIAABCDEFGHIJKLMNOP"), ["an AWS access key id"]);
  assert.deepEqual(guards.scanSecretsText('password = "hunter2"'), ["a literal password"]);
  assert.deepEqual(guards.scanSecretsText("manage_master_user_password = true"), []);
});

test("Terraform and OpenTofu run the same plan tests: each .tofutest.hcl is its .tftest.hcl without override_during", () => {
  const tests = guards.terraformTestPairs();
  assert.ok(tests.length >= 6);
  for (const { tftest, tofutest, path } of tests) {
    const strip = (text) => text.split("\n").filter((line) => !line.trim().startsWith("override_during") && !line.startsWith("#")).map((line) => line.replace(/\s+/g, " ").trim()).join("\n");
    assert.equal(strip(tofutest), strip(tftest), path);
  }
});

// ---- Cost --------------------------------------------------------------------------------------------------------------------

test("cost: deploy/aws/cost/COST-ESTIMATE.md is regenerated from prices.json and assumptions.json", () => {
  assert.equal(readFileSync(cost.ESTIMATE_PATH, "utf8"), cost.renderMarkdown(), "run node deploy/aws/cost/estimate.mjs --write");
});

test("cost: every catalogued price was extracted, and every price traces to its offer file", () => {
  const catalog = JSON.parse(readFileSync(join(root, "deploy/aws/cost/catalog.json"), "utf8"));
  const prices = JSON.parse(readFileSync(join(root, "deploy/aws/cost/prices.json"), "utf8"));
  assert.deepEqual(Object.keys(prices.items).sort(), catalog.items.map((i) => i.id).sort());
  for (const item of Object.values(prices.items)) {
    assert.ok(prices.offers[item.offer]?.sha256?.match(/^[0-9a-f]{64}$/), item.offer);
    assert.ok(/^[A-Z0-9]{16}$/.test(item.sku), item.sku);
  }
});

test("cost: at rest the worker costs nothing fixed; enabled, its endpoints are the documented fixed cost", () => {
  const idle = cost.linesOf("idle").find((l) => l.component.startsWith("Interface endpoints"));
  const live = cost.linesOf("firstCustomer").find((l) => l.component.startsWith("Interface endpoints"));
  assert.equal(idle.usd, 0);
  assert.equal(Number(live.usd.toFixed(2)), 21.9);
  assert.ok(cost.totalsOf("idle").total < 1, "an idle organization costs less than a dollar a month");
  assert.equal(Number(cost.workerTaskHour().toFixed(6)), 0.122292);
});

test("cost: no quantity claims to be measured before an AWS account exists", () => {
  const assumptions = JSON.parse(readFileSync(join(root, "deploy/aws/cost/assumptions.json"), "utf8"));
  const kinds = new Set(Object.values(assumptions.quantities).map((q) => q.kind));
  assert.ok(!kinds.has("MEASURED"));
  for (const q of Object.values(assumptions.quantities)) assert.ok(["CONTRACT", "DESIGN", "ASSUMPTION"].includes(q.kind));
});
