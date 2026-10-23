/**
 * O26A: the Bedrock preparation, checked in the platform's verify (ubuntu and windows). The deployment contract the infrastructure
 * declares (deploy/aws/bedrock/bedrock-contract.json) must be what the vendored Intelligence Core does on the wire, and the
 * infrastructure's own offline checks (deploy/aws/bedrock/checks/bedrock-guards.mjs: the contract, the Terraform module and the
 * authority rows over Order 25's evaluator) must pass. No AWS account, credential or network: VERIFIED_STATIC only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bedrockDeploymentProblems } from "../src/index.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const BEDROCK = join(REPO, "deploy", "aws", "bedrock");

interface Guards {
  readonly allProblems: () => readonly string[];
  readonly evaluateBedrockRows: () => readonly { readonly expected: string; readonly actual: string; readonly reason: string }[];
}

test("O26A: the deployment contract agrees with the vendored Intelligence Core and is switched off", () => {
  const contract = JSON.parse(readFileSync(join(BEDROCK, "bedrock-contract.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(bedrockDeploymentProblems(contract), []);
  assert.equal(contract["enabled"], false);
  assert.equal(contract["activationReference"], null);
  const terraform = readFileSync(join(BEDROCK, "terraform", "main.tf"), "utf8");
  assert.match(terraform, /variable "enabled" \{[^}]*default\s*=\s*false/su);
});

test("O26A: the Bedrock guards pass (contract, Terraform module, authority rows over Order 25's evaluator)", async () => {
  const guards = (await import(pathToFileURL(join(BEDROCK, "checks", "bedrock-guards.mjs")).href)) as Guards;
  assert.deepEqual(guards.allProblems(), []);
  const rows = guards.evaluateBedrockRows();
  assert.ok(rows.length >= 16);
  for (const row of rows) assert.equal(row.actual, row.expected, row.reason);
});
