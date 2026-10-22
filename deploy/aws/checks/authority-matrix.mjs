// The authority matrix of Order 25 §3, §4 and §8: who can do what to the protected data and to the guards themselves, evaluated
// offline over the rendered documents (VERIFIED_STATIC). Every row states the expected decision and why; the test
// (tools/test/aws-infrastructure.test.mjs) fails on any difference, and `node deploy/aws/checks/authority-matrix.mjs --write`
// regenerates deploy/aws/AUTHORITY-MATRIX.md from these rows.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./iam-eval.mjs";
import { AWS_DIR } from "./render.mjs";
import { ATTEMPT, BUCKETS, IDS, PRINCIPALS as P, WORLD, WORLD_SPEND_STOPPED } from "./world.mjs";

const object = (key) => `arn:aws:s3:::${BUCKETS.object}/${key}`;
const bucket = (name) => `arn:aws:s3:::${name}`;
const accepted = object(ATTEMPT.sealedObject);
const staging = object(`staging/${ATTEMPT.agency}/${ATTEMPT.project}/${ATTEMPT.job}/${ATTEMPT.id}/package.zip`);
const otherStaging = object(`staging/${ATTEMPT.agency}/${ATTEMPT.project}/${ATTEMPT.job}/1d2e3f40-0000-4000-8000-000000000009/package.zip`);
const viaEndpoint = { "aws:SourceVpce": IDS.endpoint };
const createOnce = { "s3:if-none-match": "*", "s3:ObjectCreationOperation": "true" };
const deletionFunction = `arn:aws:lambda:${IDS.region}:${IDS.data}:function:kauro-${IDS.environment}-retention-deletion`;
const deletionRoleArn = P.deletionRole.arn;

/** [group, principal key, action, resource, resource account, context, expected, reason] */
export const ROWS = [
  // ---- D-19 condition 1: only the deletion identity bypasses retention -----------------------------------------------------
  ["Retention bypass", "deletionRole", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "ALLOW", "the one identity D-19 grants it"],
  ["Retention bypass", "ownerAdminData", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "even the owner's admin session: D-19 grants no other role"],
  ["Retention bypass", "dataAdmin", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "an administrator of the data account"],
  ["Retention bypass", "dataRoot", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "the data account's root user"],
  ["Retention bypass", "workloadAdmin", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "an administrator of the workload account"],
  ["Retention bypass", "deployRole", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "the GitHub deploy identity"],
  ["Retention bypass", "controlPlane", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "the control plane"],
  ["Retention bypass", "forgedAttemptRole", "s3:BypassGovernanceRetention", accepted, IDS.data, viaEndpoint, "DENY", "a role forged at the attempts' path with every permission"],
  ["Retention bypass", "managementAdmin", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "the management account (no SCP binds it; the RCP and the bucket do)"],
  ["Retention bypass", "foreignAdmin", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "an account outside the organization"],

  // ---- Deletion of protected objects -------------------------------------------------------------------------------------------
  ["Object deletion", "deletionRole", "s3:DeleteObjectVersion", accepted, IDS.data, {}, "ALLOW", "the deletion identity"],
  ["Object deletion", "ownerAdminData", "s3:DeleteObjectVersion", accepted, IDS.data, {}, "DENY", "outside staging/ only the deletion identity deletes"],
  ["Object deletion", "controlPlane", "s3:DeleteObjectVersion", accepted, IDS.data, {}, "DENY", "the control plane outside staging/"],
  ["Object deletion", "controlPlane", "s3:DeleteObjectVersion", staging, IDS.data, {}, "ALLOW", "STAGING_JANITOR (Object Lock still protects any retained version)"],
  ["Object deletion", "workloadAdmin", "s3:DeleteObjectVersion", staging, IDS.data, {}, "DENY", "a workload administrator is not the control plane"],
  ["Object deletion", "attemptRole", "s3:DeleteObject", staging, IDS.data, viaEndpoint, "DENY", "attempts never delete (worker contract)"],
  ["Object deletion", "deployRole", "s3:DeleteObject", staging, IDS.data, {}, "DENY", "the deploy identity"],
  ["Object deletion", "deletionRole", "s3:DeleteObject", object("claims/kauro-attempt-x"), IDS.data, {}, "ALLOW", "the deletion identity (a delete marker reopens If-None-Match: B16 deletes protocol keys only after the creation horizon)"],
  ["Object deletion", "controlPlane", "s3:DeleteObject", object("claims/kauro-attempt-x"), IDS.data, {}, "DENY", "no delete marker on a claim from the workload"],

  // ---- Retention and holds ---------------------------------------------------------------------------------------------------
  ["Retention and holds", "controlPlane", "s3:PutObjectRetention", accepted, IDS.data, { "s3:object-lock-mode": "GOVERNANCE" }, "ALLOW", "the platform sets or extends GOVERNANCE retention (shortening needs the bypass)"],
  ["Retention and holds", "controlPlane", "s3:PutObjectRetention", accepted, IDS.data, { "s3:object-lock-mode": "COMPLIANCE" }, "DENY", "never COMPLIANCE (D-19)"],
  ["Retention and holds", "deletionRole", "s3:PutObjectRetention", accepted, IDS.data, { "s3:object-lock-mode": "COMPLIANCE" }, "DENY", "never COMPLIANCE, not even the deletion identity"],
  ["Retention and holds", "controlPlane", "s3:PutObjectLegalHold", accepted, IDS.data, {}, "DENY", "legal holds are the deletion identity's"],
  ["Retention and holds", "deletionRole", "s3:PutObjectLegalHold", accepted, IDS.data, {}, "ALLOW", "the deletion identity"],
  ["Retention and holds", "ownerAdminData", "s3:PutObjectRetention", accepted, IDS.data, { "s3:object-lock-mode": "GOVERNANCE" }, "DENY", "inside the data account only the deletion identity sets retention"],

  // ---- The buckets' own guards ------------------------------------------------------------------------------------------------
  ["Bucket guards", "ownerAdminData", "s3:PutBucketPolicy", bucket(BUCKETS.object), IDS.data, {}, "ALLOW", "the owner's administrator session"],
  ["Bucket guards", "dataAdmin", "s3:PutBucketPolicy", bucket(BUCKETS.object), IDS.data, {}, "DENY", "any other administrator"],
  ["Bucket guards", "deletionRole", "s3:PutLifecycleConfiguration", bucket(BUCKETS.object), IDS.data, {}, "DENY", "the deletion identity cannot rewrite the lifecycle"],
  ["Bucket guards", "dataAdmin", "s3:PutBucketObjectLockConfiguration", bucket(BUCKETS.object), IDS.data, {}, "DENY", "no default retention is set by anyone else"],
  ["Bucket guards", "workloadAdmin", "s3:PutBucketPolicy", bucket(BUCKETS.object), IDS.data, {}, "DENY", "the workload account"],
  ["Bucket guards", "managementAdmin", "s3:PutLifecycleConfiguration", bucket(BUCKETS.object), IDS.data, {}, "DENY", "the management account"],
  ["Bucket guards", "ownerAdminData", "s3:DeleteObjectVersion", `arn:aws:s3:::${BUCKETS.audit}/AWSLogs/x.json.gz`, IDS.data, {}, "DENY", "nobody deletes an audit log; the lifecycle expires it"],

  // ---- Identity in the data account -------------------------------------------------------------------------------------------
  ["Data account identity", "dataAdmin", "iam:CreateRole", `arn:aws:iam::${IDS.data}:role/new-role`, IDS.data, {}, "DENY", "no new principal can be made to reach the bypass"],
  ["Data account identity", "dataAdmin", "iam:UpdateAssumeRolePolicy", deletionRoleArn, IDS.data, {}, "DENY", "nobody else may assume the deletion role"],
  ["Data account identity", "dataAdmin", "iam:PassRole", deletionRoleArn, IDS.data, { "iam:PassedToService": "lambda.amazonaws.com" }, "DENY", "nobody else hands the deletion role to a function"],
  ["Data account identity", "ownerAdminData", "iam:CreateRole", `arn:aws:iam::${IDS.data}:role/new-role`, IDS.data, {}, "ALLOW", "the owner's administrator session"],
  ["Data account identity", "workloadAdmin", "sts:AssumeRole", deletionRoleArn, IDS.data, {}, "DENY", "no role of the data account is assumed from the workload"],
  ["Data account identity", "managementAdmin", "sts:AssumeRole", `arn:aws:iam::${IDS.data}:role/OrganizationAccountAccessRole`, IDS.data, {}, "DENY", "nor from the management account (RCP)"],

  // ---- The deletion function -------------------------------------------------------------------------------------------------
  ["Deletion function", "ownerPublisherData", "lambda:UpdateFunctionCode", deletionFunction, IDS.data, {}, "ALLOW", "the owner's publisher session"],
  ["Deletion function", "ownerPublisherData", "iam:PassRole", deletionRoleArn, IDS.data, { "iam:PassedToService": "lambda.amazonaws.com" }, "ALLOW", "the publisher passes the deletion role to the function"],
  ["Deletion function", "ownerPublisherData", "s3:BypassGovernanceRetention", accepted, IDS.data, {}, "DENY", "publishing grants no data access"],
  ["Deletion function", "dataAdmin", "lambda:UpdateFunctionCode", deletionFunction, IDS.data, {}, "DENY", "any other administrator"],
  ["Deletion function", "dataAdmin", "lambda:UpdateCodeSigningConfig", `arn:aws:lambda:${IDS.region}:${IDS.data}:code-signing-config:csc-0123456789abcdef0`, IDS.data, {}, "DENY", "nobody else relaxes code signing"],
  ["Deletion function", "dataAdmin", "signer:StartSigningJob", `arn:aws:signer:${IDS.region}:${IDS.data}:/signing-profiles/kauroqualificationdeletion`, IDS.data, {}, "DENY", "nobody else signs"],
  ["Deletion function", "deletionRole", "lambda:UpdateFunctionCode", deletionFunction, IDS.data, {}, "DENY", "the function cannot rewrite itself"],

  // ---- Audit and alarms -------------------------------------------------------------------------------------------------------
  ["Audit and alarms", "dataAdmin", "cloudtrail:StopLogging", `arn:aws:cloudtrail:${IDS.region}:${IDS.data}:trail/kauro-organization`, IDS.data, {}, "DENY", "the trail stays on"],
  ["Audit and alarms", "dataAdmin", "events:DisableRule", `arn:aws:events:${IDS.region}:${IDS.data}:rule/kauro-guard-iam`, IDS.data, {}, "DENY", "the alarms stay on"],
  ["Audit and alarms", "ownerAdminData", "cloudtrail:UpdateTrail", `arn:aws:cloudtrail:${IDS.region}:${IDS.data}:trail/kauro-organization`, IDS.data, {}, "ALLOW", "the owner's administrator session"],

  // ---- The worker's attempt capability (B14-A contracts) ----------------------------------------------------------------------
  ["Attempt capability", "attemptRole", "s3:GetObjectVersion", accepted, IDS.data, { ...viaEndpoint, "s3:VersionId": ATTEMPT.sealedVersion }, "ALLOW", "its sealed generation, through the endpoint"],
  ["Attempt capability", "attemptRole", "s3:GetObjectVersion", accepted, IDS.data, { "s3:VersionId": ATTEMPT.sealedVersion }, "DENY", "not from outside the VPC endpoint"],
  ["Attempt capability", "attemptRole", "s3:GetObjectVersion", accepted, IDS.data, { ...viaEndpoint, "s3:VersionId": "otherVersion" }, "DENY", "not another generation"],
  ["Attempt capability", "attemptRole", "s3:PutObject", staging, IDS.data, { ...viaEndpoint, ...createOnce }, "ALLOW", "its staging prefix, create-once"],
  ["Attempt capability", "attemptRole", "s3:PutObject", staging, IDS.data, { ...viaEndpoint, "s3:ObjectCreationOperation": "true" }, "DENY", "never an overwrite (no If-None-Match)"],
  ["Attempt capability", "attemptRole", "s3:PutObject", otherStaging, IDS.data, { ...viaEndpoint, ...createOnce }, "DENY", "not another attempt's prefix"],
  ["Attempt capability", "attemptRole", "s3:PutObject", object(`heartbeat/kauro-attempt-${ATTEMPT.id}`), IDS.data, { ...viaEndpoint, "s3:ObjectCreationOperation": "true" }, "ALLOW", "its heartbeat, overwritten"],
  ["Attempt capability", "attemptRole", "s3:GetObject", object("accepted/another/agency/file.csv"), IDS.data, viaEndpoint, "DENY", "no other object"],
  ["Attempt capability", "attemptRole", "s3:GetObject", accepted, IDS.data, { ...viaEndpoint, "aws:SecureTransport": "false" }, "DENY", "TLS only"],
  ["Attempt capability", "forgedAttemptRole", "s3:GetObject", object("accepted/another/agency/file.csv"), IDS.data, viaEndpoint, "ALLOW", "RESIDUAL (documented): a role at the attempts' path reads within the attempt ceiling; only the launcher can make one (next rows)"],

  // ---- The workload's own guards ---------------------------------------------------------------------------------------------
  ["Workload guards", "controlPlane", "iam:CreateRole", P.attemptRole.arn, IDS.workload, { "iam:PermissionsBoundary": `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary` }, "ALLOW", "the launcher creates an attempt role within the boundary"],
  ["Workload guards", "controlPlane", "iam:CreateRole", P.attemptRole.arn, IDS.workload, {}, "DENY", "never without the boundary"],
  ["Workload guards", "workloadAdmin", "iam:CreateRole", P.forgedAttemptRole.arn, IDS.workload, { "iam:PermissionsBoundary": `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary` }, "DENY", "nobody but the launcher makes attempt roles"],
  ["Workload guards", "deployRole", "iam:CreateRole", P.forgedAttemptRole.arn, IDS.workload, {}, "DENY", "the deploy identity"],
  ["Workload guards", "workloadAdmin", "iam:CreatePolicyVersion", `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary`, IDS.workload, {}, "DENY", "the attempt ceiling changes only in the owner's session"],
  ["Workload guards", "ownerAdminWorkload", "iam:CreatePolicyVersion", `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary`, IDS.workload, {}, "ALLOW", "the owner's administrator session"],
  ["Workload guards", "workloadAdmin", "iam:UpdateAssumeRolePolicy", P.deployRole.arn, IDS.workload, {}, "DENY", "the GitHub trust changes only in the owner's session"],
  ["Workload guards", "workloadAdmin", "ec2:CreateNatGateway", `arn:aws:ec2:${IDS.region}:${IDS.workload}:natgateway/*`, IDS.workload, {}, "DENY", "no internet path (and no fixed cost) without the owner"],
  ["Workload guards", "ownerAdminWorkload", "ecs:ExecuteCommand", `arn:aws:ecs:${IDS.region}:${IDS.workload}:task/kauro-${IDS.environment}/abc`, IDS.workload, {}, "DENY", "no shell into a task, for anyone"],
  ["Workload guards", "workloadAdmin", "ec2:RunInstances", `arn:aws:ec2:us-west-2:${IDS.workload}:instance/*`, IDS.workload, { "aws:RequestedRegion": "us-west-2" }, "DENY", "one US Region (A-06)"],
  ["Workload guards", "workloadAdmin", "iam:CreateAccessKey", `arn:aws:iam::${IDS.workload}:user/anyone`, IDS.workload, {}, "DENY", "no static keys"],

  // ---- The deploy identity ---------------------------------------------------------------------------------------------------
  ["Deploy identity", "deployRole", "ecr:PutImage", `arn:aws:ecr:${IDS.region}:${IDS.workload}:repository/kauro/migration-worker`, IDS.workload, {}, "ALLOW", "it pushes worker images"],
  ["Deploy identity", "deployRole", "ecs:RegisterTaskDefinition", "*", IDS.workload, {}, "DENY", "it does not deploy infrastructure"],
  ["Deploy identity", "deployRole", "s3:GetObject", accepted, IDS.data, {}, "DENY", "it reads no customer data"],

  // ---- Perimeter -------------------------------------------------------------------------------------------------------------
  ["Perimeter", "foreignAdmin", "s3:GetObject", accepted, IDS.data, {}, "DENY", "outside the organization"],
  ["Perimeter", "controlPlane", "s3:GetObject", accepted, IDS.data, {}, "ALLOW", "the control plane reads the platform's objects"],
  ["Perimeter", "controlPlane", "s3:GetObject", accepted, IDS.data, { "aws:SecureTransport": "false" }, "DENY", "TLS only"],
  ["Perimeter", "dataRoot", "s3:GetObject", accepted, IDS.data, {}, "DENY", "the member root user does nothing"],
];

/** Rows evaluated in the world after the spend stop is attached. */
export const SPEND_STOP_ROWS = [
  ["Spend stop", "controlPlane", "ecs:RunTask", `arn:aws:ecs:${IDS.region}:${IDS.workload}:task-definition/kauro-migration-worker:1`, IDS.workload, { "ecs:cluster": `arn:aws:ecs:${IDS.region}:${IDS.workload}:cluster/kauro-${IDS.environment}` }, "DENY", "no new attempt after the ceiling"],
  ["Spend stop", "controlPlane", "s3:GetObject", accepted, IDS.data, {}, "ALLOW", "data stays reachable"],
  ["Spend stop", "ownerAdminWorkload", "ecs:RunTask", `arn:aws:ecs:${IDS.region}:${IDS.workload}:task-definition/kauro-migration-worker:1`, IDS.workload, {}, "ALLOW", "the owner can still run a recovery task"],
];

export function evaluateRows(rows = ROWS, world = WORLD) {
  return rows.map(([group, principalKey, action, resource, resourceAccount, context, expected, reason]) => {
    const result = evaluate(world, { principal: P[principalKey], action, resource, resourceAccount, context });
    return { group, principal: principalKey, action, resource, context, expected, reason, actual: result.decision, layer: result.layer ?? "", sid: result.sid ?? "" };
  });
}

const cell = (value) => String(value).replaceAll("|", "\\|");

export function renderMarkdown() {
  const rows = [...evaluateRows(ROWS, WORLD), ...evaluateRows(SPEND_STOP_ROWS, WORLD_SPEND_STOPPED)];
  const lines = [
    "# Authority matrix (generated)",
    "",
    "Generated by `node deploy/aws/checks/authority-matrix.mjs --write` from the rendered policy documents (fixture account ids:",
    `management ${IDS.management}, data ${IDS.data}, workload ${IDS.workload}). Evidence class **VERIFIED_STATIC**: an offline model of`,
    "AWS's documented evaluation (deploy/aws/checks/iam-eval.mjs), never proof of a real account's effective permissions",
    "(PENDING_PROVIDER: deploy/aws/procedures/QUALIFICATION.md). `tools/test/aws-infrastructure.test.mjs` fails when this file is stale",
    "or when any row's decision differs from the expected one.",
    "",
    "| Group | Principal | Action | Resource | Expected | Decided by | Why |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const decidedBy = r.actual === "ALLOW" ? "allow" : `${r.layer}${r.sid ? ` \`${r.sid}\`` : ""}`;
    lines.push(`| ${cell(r.group)} | ${cell(r.principal)} | \`${cell(r.action)}\` | \`${cell(r.resource.replace(/^arn:aws:/, ""))}\` | ${r.expected} | ${cell(decidedBy)} | ${cell(r.reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}

export const MATRIX_PATH = join(AWS_DIR, "AUTHORITY-MATRIX.md");

if (import.meta.main ?? process.argv[1]?.endsWith("authority-matrix.mjs")) {
  const markdown = renderMarkdown();
  if (process.argv.includes("--write")) writeFileSync(MATRIX_PATH, markdown);
  else if (process.argv.includes("--check")) {
    if (readFileSync(MATRIX_PATH, "utf8") !== markdown) {
      console.error("deploy/aws/AUTHORITY-MATRIX.md is stale: run node deploy/aws/checks/authority-matrix.mjs --write");
      process.exit(1);
    }
  } else process.stdout.write(markdown);
}
