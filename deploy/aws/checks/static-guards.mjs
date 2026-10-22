// Static guards over deploy/aws and the repository's workflows (Order 25 §8, VERIFIED_STATIC): dangerous configuration, public
// paths, embedded secrets, unpinned toolchains, accidental deployment, and the worker contracts against the registry's limits.
// Each function returns a list of problems (empty: pass). `node deploy/aws/checks/static-guards.mjs` prints them all.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { AWS_DIR, minified, renderContract } from "./render.mjs";
import { DOCUMENTS, TEMPLATE_VARS } from "./world.mjs";

export const REPO = join(AWS_DIR, "..", "..");
const TERRAFORM_DIR = join(AWS_DIR, "terraform");

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".terraform" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const rel = (path) => relative(REPO, path).replaceAll("\\", "/");
export const terraformFiles = () => walk(TERRAFORM_DIR, (p) => p.endsWith(".tf"));

/** Each Terraform test file with its OpenTofu twin (OpenTofu reads the .tofutest.hcl and ignores the .tftest.hcl of the same name). */
export function terraformTestPairs() {
  return walk(TERRAFORM_DIR, (p) => p.endsWith(".tftest.hcl")).map((path) => {
    const twin = path.replace(/\.tftest\.hcl$/, ".tofutest.hcl");
    return { path: rel(path), tftest: readFileSync(path, "utf8"), tofutest: existsSync(twin) ? readFileSync(twin, "utf8") : "" };
  });
}
const allAwsFiles = () => walk(AWS_DIR, () => true);

const DANGEROUS_TERRAFORM = [
  [/resource\s+"aws_internet_gateway"/, "an internet gateway"],
  [/resource\s+"aws_nat_gateway"/, "a NAT gateway (fixed cost, internet egress)"],
  [/resource\s+"aws_eip"/, "an Elastic IP"],
  [/resource\s+"aws_default_vpc"/, "the default VPC"],
  [/resource\s+"aws_iam_user"/, "an IAM user (A9: no static identities)"],
  [/resource\s+"aws_iam_access_key"/, "an access key"],
  [/resource\s+"aws_lb"/, "a load balancer (fixed cost; the API runtime is undecided)"],
  [/map_public_ip_on_launch\s*=\s*true/, "a public IP on launch"],
  [/associate_public_ip_address\s*=\s*true/, "a public IP"],
  [/publicly_accessible\s*=\s*true/, "a public database"],
  [/assign_public_ip\s*=\s*true/, "a public IP for a task"],
  [/cidr_(ipv4|blocks)\s*=\s*\[?\s*"0\.0\.0\.0\/0"/, "a rule open to the internet"],
  [/"::\/0"/, "a rule open to the IPv6 internet"],
  [/force_destroy\s*=\s*true/, "a bucket that can be destroyed with its objects"],
  [/skip_final_snapshot\s*=\s*true/, "a database deleted without a final snapshot"],
  [/deletion_protection\s*=\s*false/, "a database without deletion protection"],
  [/mode\s*=\s*"COMPLIANCE"/, "COMPLIANCE retention (D-19: GOVERNANCE only)"],
  [/block_public_(acls|policy)\s*=\s*false|ignore_public_acls\s*=\s*false|restrict_public_buckets\s*=\s*false/, "a public access block turned off"],
  [/\b(access_key|secret_key|token)\s*=\s*"/, "credentials in a provider"],
  [/close_on_deletion\s*=\s*true/, "an account closed by Terraform"],
  [/containerInsights[\s\S]{0,40}"enabled"/, "Container Insights (a paid feature nobody needs)"],
];

/** What a Terraform text asks for that the design forbids (comments ignored). */
export function scanTerraformText(text) {
  const code = text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  return DANGEROUS_TERRAFORM.filter(([pattern]) => pattern.test(code)).map(([, what]) => what);
}

/** Configuration that would open a public path, an internet route, a fixed cost or an unrecoverable deletion. */
export function dangerousTerraform() {
  return terraformFiles().flatMap((file) => scanTerraformText(readFileSync(file, "utf8")).map((what) => `${rel(file)}: ${what}`));
}

const SECRET_PATTERNS = [
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/aws_secret_access_key|aws_session_token/i, "an AWS secret key or session token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bpassword\s*=\s*"[^"]+"/i, "a literal password"],
];

/** The secrets a text carries. */
export function scanSecretsText(text) {
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

/** No credential, key or private material anywhere under deploy/aws (this file states the patterns themselves). */
export function embeddedSecrets() {
  return allAwsFiles()
    .filter((f) => !f.endsWith("static-guards.mjs"))
    .flatMap((file) => scanSecretsText(readFileSync(file, "utf8")).map((what) => `${rel(file)}: ${what}`));
}

/** Every rendered policy: no Allow to everyone, no Allow of every action, no wildcard NotAction allow; guards within size. */
export function policyShape() {
  const problems = [];
  for (const [name, doc] of Object.entries(DOCUMENTS)) {
    for (const st of doc.Statement) {
      if (st.Effect === "Allow" && (st.Principal === "*" || st.Principal?.AWS === "*")) problems.push(`${name}/${st.Sid}: Allow to every principal`);
      if (st.Effect === "Allow" && [].concat(st.Action ?? []).includes("*")) problems.push(`${name}/${st.Sid}: Allow of every action`);
      if (st.Effect === "Allow" && st.NotAction) problems.push(`${name}/${st.Sid}: Allow with NotAction`);
      if (st.Effect === "Allow" && [].concat(st.Action ?? []).some((a) => /^s3:\*$|^iam:\*$|^sts:\*$/.test(a))) problems.push(`${name}/${st.Sid}: a service-wide Allow`);
    }
  }
  for (const name of ["scpMemberBaseline", "scpDataRetention", "scpDataIdentity", "scpWorkloadGuard", "scpSpendStop", "rcpDataPerimeter"]) {
    const size = minified(DOCUMENTS[name]).length;
    if (size > 5120) problems.push(`${name}: ${size} characters, above the 5,120 of an SCP or RCP`);
  }
  return problems;
}

/** The toolchain is pinned: exact provider in every root, both lock files with hashes, module ranges below the next major. */
export function pinnedToolchain() {
  const problems = [];
  for (const root of ["management", "data", "workload"]) {
    const dir = join(TERRAFORM_DIR, "accounts", root);
    const versions = readFileSync(join(dir, "versions.tf"), "utf8");
    if (!/version\s*=\s*"= \d+\.\d+\.\d+"/.test(versions)) problems.push(`${root}: the aws provider is not pinned exactly`);
    if (!/backend\s+"s3"\s*\{\s*\}/.test(versions)) problems.push(`${root}: the backend names something (it must be a partial configuration)`);
    for (const [lock, host] of [[".terraform.lock.hcl", "registry.opentofu.org"], ["terraform-registry.lock.hcl", "registry.terraform.io"]]) {
      const path = join(dir, lock);
      if (!existsSync(path)) {
        problems.push(`${root}: ${lock} is missing`);
        continue;
      }
      const text = readFileSync(path, "utf8");
      if (!text.includes(`provider "${host}/hashicorp/aws"`)) problems.push(`${root}/${lock}: no ${host} entry`);
      if ((text.match(/"zh:/g) ?? []).length < 4 || !/"h1:/.test(text)) problems.push(`${root}/${lock}: too few hashes`);
      const pinned = /version\s*=\s*"= (\d+\.\d+\.\d+)"/.exec(versions)?.[1];
      if (pinned && !text.includes(`version     = "${pinned}"`)) problems.push(`${root}/${lock}: locks another version than ${pinned}`);
    }
  }
  for (const file of terraformFiles().filter((f) => f.includes(`${join("terraform", "modules")}`) && f.endsWith("main.tf"))) {
    const text = readFileSync(file, "utf8");
    if (/hashicorp\/aws/.test(text) && !/version = ">= \d+\.\d+\.\d+, < \d+\.0\.0"/.test(text)) problems.push(`${rel(file)}: the provider range is open`);
  }
  return problems;
}

/** Nothing in CI or in the repository can deploy: no apply, no AWS credentials, no OIDC role assumed by a workflow. */
export function noAccidentalDeployment() {
  const problems = [];
  const workflows = join(REPO, ".github", "workflows");
  for (const name of existsSync(workflows) ? readdirSync(workflows) : []) {
    const text = readFileSync(join(workflows, name), "utf8");
    if (/\b(terraform|tofu)\s+(apply|destroy|import)\b/.test(text)) problems.push(`.github/workflows/${name}: runs apply, destroy or import`);
    if (/\b(terraform|tofu)\s+plan\b/.test(text) && !/-backend=false/.test(text)) problems.push(`.github/workflows/${name}: plans against a backend`);
    if (/configure-aws-credentials|secrets\.AWS_|AWS_ACCESS_KEY_ID|AWS_ROLE_ARN/.test(text)) problems.push(`.github/workflows/${name}: obtains AWS credentials`);
    if (/id-token:\s*write/.test(text) && /aws/i.test(name)) problems.push(`.github/workflows/${name}: may request an OIDC token`);
  }
  for (const file of terraformFiles()) {
    const text = readFileSync(file, "utf8");
    if (/allowed_account_ids/.test(text) === false && /^provider "aws"/m.test(text)) problems.push(`${rel(file)}: a provider without allowed_account_ids`);
  }
  for (const root of ["management", "data", "workload"]) {
    const main = readFileSync(join(TERRAFORM_DIR, "accounts", root, "main.tf"), "utf8");
    if (!new RegExp(`KAURO-ACT-\\[0-9\\]\\{4\\}-\\[0-9\\]\\{2\\}-\\[0-9\\]\\{2\\}-${root.toUpperCase()}-`).test(main)) problems.push(`${root}: no activation gate`);
  }
  return problems;
}

/** Every template a Terraform file names exists. */
export function templateReferences() {
  const problems = [];
  for (const file of terraformFiles()) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\$\{var\.(policies_dir|contracts_dir)\}\/([A-Za-z0-9_./-]+\.json)|\$\{local\.(policies_dir|contracts_dir)\}\/([A-Za-z0-9_./-]+\.json)/g)) {
      const kind = m[1] ?? m[3];
      const path = m[2] ?? m[4];
      const base = kind === "policies_dir" ? join(AWS_DIR, "policies") : join(AWS_DIR, "worker");
      if (!existsSync(join(base, path))) problems.push(`${rel(file)}: names ${kind}/${path}, which does not exist`);
    }
  }
  return problems;
}

/** The worker's deployment contracts against the registry's limits (packages/contracts/registry/policy.json capacity). */
export function workerContractCompatibility() {
  const problems = [];
  const capacity = JSON.parse(readFileSync(join(REPO, "packages", "contracts", "registry", "policy.json"), "utf8")).capacity;
  const td = renderContract("worker/task-definition.template.json", TEMPLATE_VARS);
  const container = td.containerDefinitions[0];
  const GiB = 1024 ** 3;
  if (Number(td.memory) * 1024 ** 2 !== capacity.ramHardBytes) problems.push(`task memory ${td.memory} MiB is not ramHardBytes ${capacity.ramHardBytes}`);
  if (td.ephemeralStorage.sizeInGiB * GiB < capacity.scratchHardBytes) problems.push("ephemeral storage below the hard scratch");
  if (td.ephemeralStorage.sizeInGiB > 200) problems.push("ephemeral storage above Fargate's 200 GiB");
  if (td.runtimePlatform.cpuArchitecture !== "X86_64" || td.runtimePlatform.operatingSystemFamily !== "LINUX") problems.push("not the selected Linux/x86_64 platform");
  if (!(container.stopTimeout >= 2 && container.stopTimeout <= 120)) problems.push("stopTimeout outside Fargate's 2-120 s");
  if (!container.readonlyRootFilesystem) problems.push("writable root filesystem");
  if (!/^[1-9]\d*:[1-9]\d*$/.test(container.user)) problems.push("the worker runs as root");
  if ("taskRoleArn" in td) problems.push("a task role in the definition (each RunTask names the attempt's own)");
  if (!container.image.includes("@sha256:")) problems.push("the image is not pinned by digest");
  if (container.logConfiguration.options["awslogs-region"] !== "us-east-1") problems.push("logs outside us-east-1");
  if ((container.environment ?? []).some((e) => /SECRET|PASSWORD|TOKEN|KEY$/.test(e.name))) problems.push("a secret-looking variable in the task definition");
  const rt = renderContract("worker/run-task.template.json", TEMPLATE_VARS);
  if (rt.clientToken !== TEMPLATE_VARS.ATTEMPT_ID) problems.push("RunTask's clientToken is not the attempt id");
  if (rt.startedBy !== `kauro-attempt-${TEMPLATE_VARS.ATTEMPT_ID}`) problems.push("RunTask's startedBy is not the identity");
  if (rt.networkConfiguration.awsvpcConfiguration.assignPublicIp !== "DISABLED") problems.push("RunTask assigns a public IP");
  if (rt.overrides.taskRoleArn !== `arn:aws:iam::${TEMPLATE_VARS.ACCOUNT_ID}:role/kauro-attempts/kauro-attempt-${TEMPLATE_VARS.ATTEMPT_ID}`) problems.push("RunTask does not name the attempt's own role");
  if (JSON.stringify(rt.overrides).match(/SECRET|PASSWORD/)) problems.push("a secret in RunTask overrides (DescribeTasks shows them)");
  if (rt.clientToken.length > 64) problems.push("clientToken above 64 characters");
  if (`kauro-attempt-${TEMPLATE_VARS.ATTEMPT_ID}`.length > 64) problems.push("the attempt role's name is above IAM's 64 characters");
  return problems;
}

/** Only the allowed US Region is named in the configuration (A-06). */
export function regions() {
  const problems = [];
  for (const file of terraformFiles()) {
    for (const m of readFileSync(file, "utf8").matchAll(/"((?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-\d)"/g)) {
      if (m[1] !== "us-east-1") problems.push(`${rel(file)}: names ${m[1]}`);
    }
  }
  return problems;
}

export const ALL_GUARDS = {
  dangerousTerraform,
  embeddedSecrets,
  policyShape,
  pinnedToolchain,
  noAccidentalDeployment,
  templateReferences,
  workerContractCompatibility,
  regions,
};

if (process.argv[1]?.endsWith("static-guards.mjs")) {
  let failed = false;
  for (const [name, guard] of Object.entries(ALL_GUARDS)) {
    const problems = guard();
    console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${name}`);
    for (const p of problems) console.log(`  - ${p}`);
    failed ||= problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
