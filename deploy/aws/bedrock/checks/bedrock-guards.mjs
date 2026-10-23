// Order 26A: the offline checks of the Bedrock preparation (VERIFIED_STATIC; never proof of what a real account does). Each function
// returns a list of problems (empty: pass); `node deploy/aws/bedrock/checks/bedrock-guards.mjs` prints them all and exits 1 on any.
// The authority rows run Order 25's evaluator (deploy/aws/checks/iam-eval.mjs) over the same rendered documents Terraform sends,
// inside Order 25's synthetic organization, with this order's SCP and the campaign runner's role added to the workload account.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluate } from "../../checks/iam-eval.mjs";
import { renderPolicy } from "../../checks/render.mjs";
import { DOCUMENTS, IDS, PRINCIPALS, TEMPLATE_VARS, WORLD } from "../../checks/world.mjs";

export const BEDROCK_DIR = join(import.meta.dirname, "..");
const US = /^us-(east|west)-[12]$/;
const GRANT_CAPS_USD = Object.freeze({ "B04-A": 40, "B04-B": 120 });
const RETRYABLE = new Set([429, 503, 529]);

export const readContract = () => JSON.parse(readFileSync(join(BEDROCK_DIR, "bedrock-contract.json"), "utf8"));

/** What the invocation contract states that A9 §4 or the IC wire does not allow. */
export function contractProblems(contract) {
  const problems = [];
  const p = (ok, text) => ok || problems.push(text);
  p(contract.contractVersion === "1.0.0", "contractVersion is not 1.0.0");
  p(contract.enabled === false || (typeof contract.activationReference === "string" && contract.activationReference.length >= 8), "enabled without an owner activation reference");
  p(US.test(contract.sourceRegion ?? ""), `source Region ${String(contract.sourceRegion)} is not a US Region`);
  p(contract.geography === "us", "the geography is not us");
  p(Array.isArray(contract.destinationRegions) && contract.destinationRegions.length > 0 && contract.destinationRegions.every((r) => US.test(r)), "a destination Region outside the US");
  p(contract.invocation?.operation === "InvokeModel" && contract.invocation?.streaming === false, "an invocation other than non-streaming InvokeModel");
  p(contract.retention?.invocationLogging === "OFF", "invocation logging is not OFF");
  p(contract.retention?.providerStoresPromptsOrOutputs === false, "the contract lets the provider store prompts or outputs");
  const models = contract.models ?? [];
  const granted = models.filter((m) => m.status === "GRANTED");
  p(granted.length >= 1, "no granted model");
  for (const m of granted) {
    p(/^us\.anthropic\.claude-sonnet-/.test(m.inferenceProfileId), `${m.capability}: ${m.inferenceProfileId} is granted but is not a us. Sonnet profile (A9 §4)`);
    p(m.grants.length > 0 && m.grants.every((g) => Object.hasOwn(GRANT_CAPS_USD, g)), `${m.capability}: names a grant that does not exist`);
  }
  for (const m of models.filter((x) => /opus/.test(x.inferenceProfileId))) p(m.status === "BLOCKED_OWNER" && m.grants.length === 0, `${m.inferenceProfileId} is not BLOCKED_OWNER (A9 §4: Opus needs a new approval)`);
  const q = contract.quotas ?? {};
  p(q.maxConcurrency === 1, "more than one request in flight (the campaign grant holds one run at a time)");
  p(Number.isInteger(q.maxRequestsPerMinute) && q.maxRequestsPerMinute > 0 && q.maxRequestsPerMinute <= 60, "requests per minute unbounded or above 60");
  p(Number.isInteger(q.maxTokensPerMinute) && q.maxTokensPerMinute > 0, "tokens per minute unbounded");
  const b = contract.backoff ?? {};
  p(Array.isArray(b.retryableStatuses) && b.retryableStatuses.every((s) => RETRYABLE.has(s)), "a retry on a status other than 429, 503 or 529");
  p(Number.isInteger(b.maxAttempts) && b.maxAttempts >= 1 && b.maxAttempts <= 3, "more than three attempts");
  p(Array.isArray(b.waitsMs) && b.waitsMs.length === b.maxAttempts - 1 && b.waitsMs.every((w, i) => w > 0 && w <= 60_000 && (i === 0 || w >= b.waitsMs[i - 1])), "the waits are not bounded, increasing and one fewer than the attempts");
  const grants = contract.budget?.grants ?? [];
  for (const g of grants) {
    p(Object.hasOwn(GRANT_CAPS_USD, g.grantId) && g.capUsd <= GRANT_CAPS_USD[g.grantId], `grant ${g.grantId} above the owner's cap`);
    p(g.candidates.every((c) => c === "SONNET_5_5_US"), `grant ${g.grantId} funds a candidate other than Sonnet`);
  }
  const total = grants.reduce((sum, g) => sum + g.capUsd, 0);
  p(contract.budget?.awsBudgetCeilingUsd > 0 && contract.budget.awsBudgetCeilingUsd <= total, "the AWS budget is above the sum of the grants");
  return problems;
}

const FORBIDDEN_RESOURCES = [
  [/resource\s+"aws_bedrock_model_invocation_logging_configuration"/, "an invocation logging configuration (inputs and outputs would be stored)"],
  [/resource\s+"aws_bedrock_provisioned_model_throughput"/, "provisioned throughput (a committed cost)"],
  [/resource\s+"aws_bedrock_custom_model"/, "a custom model"],
  [/resource\s+"aws_bedrockagent_/, "an agent, knowledge base or flow"],
  [/resource\s+"aws_bedrock_inference_profile"/, "an application inference profile"],
  [/resource\s+"aws_iam_user"|resource\s+"aws_iam_access_key"/, "a static identity"],
];

/** What the module asks for that the design forbids, and whether everything it creates waits for enabled + an activation reference. */
export function terraformProblems(text = readFileSync(join(BEDROCK_DIR, "terraform", "main.tf"), "utf8")) {
  const code = text.replace(/#.*$/gm, "");
  const problems = FORBIDDEN_RESOURCES.filter(([re]) => re.test(code)).map(([, what]) => `the module creates ${what}`);
  if (!/variable\s+"enabled"\s*\{[^}]*default\s*=\s*false/s.test(code)) problems.push("enabled does not default to false");
  if (!/on\s*=\s*var\.enabled\s*&&\s*var\.activation_reference\s*!=\s*null/.test(code)) problems.push("creation does not wait for enabled and an activation reference");
  const resources = [...code.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g)];
  for (const match of resources) {
    const body = code.slice(match.index, code.indexOf("\n}", match.index));
    if (!/count\s*=\s*local\.on\s*\?\s*1\s*:\s*0/.test(body)) problems.push(`${match[1]}.${match[2]} is created whether or not the module is on`);
  }
  if (!/var\.budget_ceiling_usd\s*<=\s*160/.test(code)) problems.push("the budget ceiling is not held to the grants (USD 160)");
  return problems;
}

// --------------------------------------------------------------------------------------------- the authority rows (VERIFIED_STATIC)
export const BEDROCK_VARS = Object.freeze({
  ...TEMPLATE_VARS,
  SOURCE_REGION: IDS.region,
  GRANTED_PROFILE_ID: "us.anthropic.claude-sonnet-5-5",
  GRANTED_MODEL_ID: "anthropic.claude-sonnet-5-5*",
});
const ROOT = join("bedrock", "policies");
export const BEDROCK_DOCUMENTS = Object.freeze({
  invoke: renderPolicy(join(ROOT, "bedrock-invoke.policy.json"), BEDROCK_VARS),
  guard: renderPolicy(join(ROOT, "scp-bedrock-guard.json"), BEDROCK_VARS),
});

const RUNNER = Object.freeze({
  arn: `arn:aws:iam::${IDS.workload}:role/kauro-runtime/kauro-${IDS.environment}-ic-campaign-runner`,
  account: IDS.workload,
  orgId: IDS.org,
  type: "role",
  identityPolicies: [BEDROCK_DOCUMENTS.invoke],
});
const P = { ...PRINCIPALS, runner: RUNNER };

/** Order 25's organization with this order's guard on the workload account; `patchedBaseline` applies the requested exception. */
export function bedrockWorld({ patchedBaseline = false } = {}) {
  const baseline = patchedBaseline
    ? {
        ...DOCUMENTS.scpMemberBaseline,
        Statement: DOCUMENTS.scpMemberBaseline.Statement.map((s) => (s.Sid === "DenyOutsideTheAllowedRegion" ? { ...s, NotAction: [...s.NotAction, "bedrock:InvokeModel"] } : s)),
      }
    : DOCUMENTS.scpMemberBaseline;
  return {
    ...WORLD,
    scps: { ...WORLD.scps, [IDS.workload]: [baseline, ...WORLD.scps[IDS.workload].slice(1), BEDROCK_DOCUMENTS.guard] },
  };
}

const profileArn = (id, region = IDS.region) => `arn:aws:bedrock:${region}:${IDS.workload}:inference-profile/${id}`;
const modelArn = (region, id = "anthropic.claude-sonnet-5-5-v1:0") => `arn:aws:bedrock:${region}::foundation-model/${id}`;
const SONNET = "us.anthropic.claude-sonnet-5-5";
const OPUS = "us.anthropic.claude-opus-5-5";
const viaProfile = (region) => ({ "bedrock:InferenceProfileArn": profileArn(SONNET), "aws:RequestedRegion": region });

/** [group, principal, action, resource, context, world, expected, reason] */
export const BEDROCK_ROWS = [
  ["Invoke", "runner", "bedrock:InvokeModel", profileArn(SONNET), {}, "base", "ALLOW", "the granted us. Sonnet profile from the source Region"],
  ["Invoke", "runner", "bedrock:InvokeModel", modelArn("us-east-1"), viaProfile("us-east-1"), "base", "ALLOW", "the model in the source Region, routed by the profile"],
  ["Invoke", "runner", "bedrock:InvokeModel", modelArn("us-west-2"), viaProfile("us-west-2"), "base", "DENY", "KNOWN DEPENDENCY: Order 25's baseline SCP allows one Region, so a us. profile routed to us-west-2 is refused there"],
  ["Invoke", "runner", "bedrock:InvokeModel", modelArn("us-west-2"), viaProfile("us-west-2"), "patched", "ALLOW", "with the requested baseline exception (dispatch/sprint/REQUESTS.md), the routed call is allowed"],
  ["Invoke", "runner", "bedrock:InvokeModel", modelArn("eu-west-1"), viaProfile("eu-west-1"), "patched", "DENY", "never outside the US, even with the exception"],
  ["Invoke", "runner", "bedrock:InvokeModel", modelArn("us-east-1"), { "aws:RequestedRegion": "us-east-1" }, "base", "DENY", "the model directly, not through the granted profile"],
  ["Invoke", "runner", "bedrock:InvokeModel", profileArn(OPUS), {}, "patched", "DENY", "Opus 5.5 (A9 §4: a new approval first)"],
  ["Invoke", "workloadAdmin", "bedrock:InvokeModel", profileArn(OPUS), {}, "patched", "DENY", "Opus, even for a workload administrator"],
  ["Invoke", "runner", "bedrock:InvokeModelWithResponseStream", profileArn(SONNET), {}, "patched", "DENY", "streaming is not the contract's operation"],
  ["Invoke", "runner", "bedrock:Converse", profileArn(SONNET), {}, "patched", "DENY", "Converse is not the contract's operation"],
  ["Invoke", "controlPlane", "bedrock:InvokeModel", profileArn(SONNET), {}, "patched", "DENY", "the control plane is not the campaign runner"],
  ["Retention", "ownerAdminWorkload", "bedrock:PutModelInvocationLoggingConfiguration", "*", {}, "patched", "DENY", "nobody turns invocation logging on, the owner's session included"],
  ["Cost", "ownerAdminWorkload", "bedrock:CreateProvisionedModelThroughput", "*", {}, "patched", "DENY", "no committed cost"],
  ["Cost", "workloadAdmin", "aws-marketplace:Subscribe", "*", {}, "patched", "DENY", "no model subscription by anyone but the owner"],
  ["Cost", "ownerAdminWorkload", "aws-marketplace:Subscribe", "*", {}, "patched", "ALLOW", "the owner's model access step of the activation"],
  ["Cost", "workloadAdmin", "bedrock:CreateModelCustomizationJob", "*", {}, "patched", "DENY", "no customization"],
];

export function evaluateBedrockRows(rows = BEDROCK_ROWS) {
  const worlds = { base: bedrockWorld(), patched: bedrockWorld({ patchedBaseline: true }) };
  return rows.map(([group, principal, action, resource, context, world, expected, reason]) => {
    const result = evaluate(worlds[world], { principal: P[principal], action, resource, resourceAccount: IDS.workload, context });
    return { group, principal, action, resource, world, expected, reason, actual: result.decision, layer: result.layer ?? "", sid: result.sid ?? "" };
  });
}

export function authorityProblems() {
  return evaluateBedrockRows()
    .filter((row) => row.actual !== row.expected)
    .map((row) => `${row.group}: ${row.principal} ${row.action} on ${row.resource} (${row.world}) is ${row.actual}, expected ${row.expected}: ${row.reason}`);
}

export function allProblems() {
  return [...contractProblems(readContract()), ...terraformProblems(), ...authorityProblems()];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const row of evaluateBedrockRows()) process.stdout.write(`${row.actual === row.expected ? "ok " : "BAD"} ${row.expected.padEnd(5)} ${row.principal} ${row.action} ${row.resource} [${row.world}] ${row.layer}:${row.sid}\n`);
  const problems = allProblems();
  for (const problem of problems) process.stdout.write(`PROBLEM ${problem}\n`);
  process.stdout.write(`bedrock guards: ${problems.length === 0 ? "PASS" : `${String(problems.length)} problem(s)`}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
