/**
 * O26A: the Bedrock preparation, checked in the platform's verify (ubuntu and windows). The infrastructure's offline checks
 * (deploy/aws/bedrock/checks/bedrock-guards.mjs: the invocation contract against A9 §4, the Terraform module, and the authority rows
 * over Order 25's evaluator) must pass, and the deployment must stay switched off. No AWS account, credential or network:
 * VERIFIED_STATIC only. The contract's agreement with what Intelligence Core does on the wire (`bedrockDeploymentProblems`) is the
 * core's own test until the core is re-vendored; the vendored 0.6.0 tarball predates it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const BEDROCK = join(REPO, "deploy", "aws", "bedrock");

interface Guards {
  readonly allProblems: () => readonly string[];
  readonly evaluateBedrockRows: () => readonly { readonly expected: string; readonly actual: string; readonly reason: string }[];
}

test("O26A: the Bedrock deployment is switched off and names no activation", () => {
  const contract = JSON.parse(readFileSync(join(BEDROCK, "bedrock-contract.json"), "utf8")) as Record<string, unknown>;
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
