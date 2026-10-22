// The synthetic organization the offline checks evaluate: three accounts with fixture ids, every guard and grant rendered from the
// same templates Terraform renders, and the principals that exist (or could be made to exist) in each account. Ids are fixtures,
// never real accounts.
import { renderPolicy } from "./render.mjs";

export const IDS = Object.freeze({
  org: "o-abcdefghij",
  management: "000000000000",
  data: "222222222222",
  workload: "111111111111",
  foreign: "999999999999",
  environment: "qualification",
  endpoint: "vpce-0123456789abcdef0",
  region: "us-east-1",
});

export const OWNER_ADMIN_SET = "KauroOwnerAdministrator";
export const DELETION_PUBLISHER_SET = "KauroDeletionPublisher";
const ssoPattern = (set) => `arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_${set}_${"?".repeat(16)}`;
const ssoRole = (account, set) => `arn:aws:iam::${account}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_${set}_0123456789abcdef`;

export const BUCKETS = Object.freeze({
  object: `kauro-${IDS.environment}-customer-data-${IDS.data}`,
  journal: `kauro-${IDS.environment}-journal-${IDS.data}`,
  audit: `kauro-audit-${IDS.data}`,
});

export const ATTEMPT = Object.freeze({
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  agency: "a1b2c3d4-0000-4000-8000-000000000001",
  project: "a1b2c3d4-0000-4000-8000-000000000002",
  job: "a1b2c3d4-0000-4000-8000-000000000003",
  sealedObject: "accepted/a1b2c3d4-0000-4000-8000-000000000001/a1b2c3d4-0000-4000-8000-000000000002/source.csv",
  sealedVersion: "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY",
});

export const TEMPLATE_VARS = Object.freeze({
  ACCOUNT_ID: IDS.workload,
  ALLOWED_REGION: IDS.region,
  ATTEMPT_BOUNDARY_POLICY_ARN: `arn:aws:iam::${IDS.workload}:policy/kauro-guard/kauro-attempt-boundary`,
  ATTEMPT_ID: ATTEMPT.id,
  AGENCY_ID: ATTEMPT.agency,
  AUDIT_BUCKET: BUCKETS.audit,
  CLUSTER_ARN: `arn:aws:ecs:${IDS.region}:${IDS.workload}:cluster/kauro-${IDS.environment}`,
  CLUSTER_NAME: `kauro-${IDS.environment}`,
  DATA_ACCOUNT_ID: IDS.data,
  DELETION_PUBLISHER_ROLE_PATTERN: ssoPattern(DELETION_PUBLISHER_SET),
  ECR_REPOSITORY_ARN: `arn:aws:ecr:${IDS.region}:${IDS.workload}:repository/kauro/migration-worker`,
  ECR_REPOSITORY_URI: `${IDS.workload}.dkr.ecr.${IDS.region}.amazonaws.com/kauro/migration-worker`,
  ENVIRONMENT: IDS.environment,
  EXECUTION_ROLE_ARN: `arn:aws:iam::${IDS.workload}:role/kauro-runtime/kauro-${IDS.environment}-worker-execution`,
  IMAGE_DIGEST: `sha256:${"0".repeat(64)}`,
  JOB_ID: ATTEMPT.job,
  JOURNAL_BUCKET: BUCKETS.journal,
  MANAGEMENT_ACCOUNT_ID: IDS.management,
  OBJECT_BUCKET: BUCKETS.object,
  ORG_ID: IDS.org,
  OWNER_ADMIN_ROLE_PATTERN: ssoPattern(OWNER_ADMIN_SET),
  PRIVATE_SUBNET_ID: "subnet-0123456789abcdef0",
  PROJECT_ID: ATTEMPT.project,
  REGION: IDS.region,
  S3_GATEWAY_ENDPOINT_ID: IDS.endpoint,
  SEALED_GENERATION_1: ATTEMPT.sealedVersion,
  SEALED_OBJECT_NAME_1: ATTEMPT.sealedObject,
  SIGNING_BUCKET: `kauro-signing-${IDS.data}`,
  TASK_DEFINITION_ARN: `arn:aws:ecs:${IDS.region}:${IDS.workload}:task-definition/kauro-migration-worker:1`,
  TASK_DEFINITION_ARN_WITHOUT_REVISION: `arn:aws:ecs:${IDS.region}:${IDS.workload}:task-definition/kauro-migration-worker`,
  TICKET_SHA256: "a".repeat(64),
  TRAIL_ARN: `arn:aws:cloudtrail:${IDS.region}:${IDS.management}:trail/kauro-organization`,
  WORKER_SECURITY_GROUP_ID: "sg-0123456789abcdef0",
  WORKLOAD_ACCOUNT_ID: IDS.workload,
});

const render = (paths) => renderPolicy(paths, TEMPLATE_VARS);

/** Every document of the design, rendered: the organization's guards, the buckets' policies, the identities' policies. */
export const DOCUMENTS = Object.freeze({
  scpMemberBaseline: render("policies/organization/scp-member-baseline.json"),
  scpDataRetention: render("policies/organization/scp-data-retention-guard.json"),
  scpDataIdentity: render("policies/organization/scp-data-identity-guard.json"),
  scpWorkloadGuard: render("policies/organization/scp-workload-guard.json"),
  scpSpendStop: render("policies/organization/scp-spend-stop.json"),
  rcpDataPerimeter: render("policies/organization/rcp-data-perimeter.json"),
  customerBucket: render(["policies/data/customer-data-bucket.json", "worker/bucket-policy.template.json"]),
  journalBucket: render("policies/data/journal-bucket.json"),
  auditBucket: render("policies/data/audit-bucket.json"),
  deletionRole: render("policies/data/deletion-role.policy.json"),
  deletionPublisher: render("policies/data/deletion-publisher.policy.json"),
  deployRole: render("policies/workload/deploy-role.policy.json"),
  controlBoundary: render("policies/workload/control-plane-boundary.policy.json"),
  controlStorage: render("policies/workload/control-plane-storage.policy.json"),
  launcher: render("worker/iam/launcher.policy.template.json"),
  executionRole: render("worker/iam/execution-role.policy.template.json"),
  attemptBoundary: render("worker/iam/attempt-boundary.policy.json"),
  attemptRole: render("worker/iam/attempt-role.policy.template.json"),
});

const ADMIN = { Version: "2012-10-17", Statement: [{ Sid: "AdministratorAccess", Effect: "Allow", Action: "*", Resource: "*" }] };

const role = (account, name, path, identityPolicies, extra = {}) => ({
  arn: `arn:aws:iam::${account}:role/${path}${name}`,
  account,
  orgId: account === IDS.foreign ? "o-foreignorg0" : IDS.org,
  type: "role",
  identityPolicies,
  ...extra,
});

/** The principals of the matrix. "admin" roles stand for any identity holding AdministratorAccess in that account. */
export const PRINCIPALS = Object.freeze({
  ownerAdminData: { ...role(IDS.data, "", "", [ADMIN]), arn: ssoRole(IDS.data, OWNER_ADMIN_SET) },
  ownerPublisherData: { ...role(IDS.data, "", "", [DOCUMENTS.deletionPublisher]), arn: ssoRole(IDS.data, DELETION_PUBLISHER_SET) },
  deletionRole: role(IDS.data, `kauro-${IDS.environment}-retention-deletion`, "kauro-deletion/", [DOCUMENTS.deletionRole]),
  dataAdmin: role(IDS.data, "OrganizationAccountAccessRole", "", [ADMIN]),
  dataRoot: { arn: `arn:aws:iam::${IDS.data}:root`, account: IDS.data, orgId: IDS.org, type: "root", identityPolicies: [ADMIN] },
  ownerAdminWorkload: { ...role(IDS.workload, "", "", [ADMIN]), arn: ssoRole(IDS.workload, OWNER_ADMIN_SET) },
  workloadAdmin: role(IDS.workload, "OrganizationAccountAccessRole", "", [ADMIN]),
  deployRole: role(IDS.workload, `kauro-${IDS.environment}-image-publisher`, "kauro-deploy/", [DOCUMENTS.deployRole]),
  controlPlane: role(IDS.workload, `kauro-${IDS.environment}-control-plane`, "kauro-runtime/", [DOCUMENTS.launcher, DOCUMENTS.controlStorage], {
    boundary: DOCUMENTS.controlBoundary,
  }),
  attemptRole: role(IDS.workload, `kauro-attempt-${ATTEMPT.id}`, "kauro-attempts/", [DOCUMENTS.attemptRole], { boundary: DOCUMENTS.attemptBoundary }),
  // A role an attacker with the deploy token or a workload admin could try to make at the attempts' path, with every permission.
  forgedAttemptRole: role(IDS.workload, "kauro-attempt-forged", "kauro-attempts/", [ADMIN]),
  managementAdmin: role(IDS.management, "OwnerManagementAdmin", "", [ADMIN]),
  foreignAdmin: role(IDS.foreign, "Attacker", "", [ADMIN]),
});

const bucketOf = (resource) => /^arn:aws:s3:::([^/]+)/.exec(resource)?.[1];

export const WORLD = Object.freeze({
  managementAccountId: IDS.management,
  scps: {
    [IDS.data]: [DOCUMENTS.scpMemberBaseline, DOCUMENTS.scpDataRetention, DOCUMENTS.scpDataIdentity],
    [IDS.workload]: [DOCUMENTS.scpMemberBaseline, DOCUMENTS.scpWorkloadGuard],
  },
  rcps: {
    [IDS.data]: [DOCUMENTS.rcpDataPerimeter],
  },
  resourcePolicyOf(resource) {
    const bucket = bucketOf(resource);
    if (bucket === BUCKETS.object) return DOCUMENTS.customerBucket;
    if (bucket === BUCKETS.journal) return DOCUMENTS.journalBucket;
    if (bucket === BUCKETS.audit) return DOCUMENTS.auditBucket;
    return null;
  },
});

/** The same world after AWS Budgets attached the spend stop to the Workloads OU. */
export const WORLD_SPEND_STOPPED = Object.freeze({
  ...WORLD,
  scps: { ...WORLD.scps, [IDS.workload]: [...WORLD.scps[IDS.workload], DOCUMENTS.scpSpendStop] },
});
