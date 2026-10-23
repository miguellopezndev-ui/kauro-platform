// The reproducible cost estimate of Order 25 §6: prices.json (AWS's Price List, by SKU) × assumptions.json (each quantity marked
// CONTRACT, DESIGN or ASSUMPTION) → deploy/aws/cost/COST-ESTIMATE.md. Deterministic: the same inputs give the same bytes, and the
// test fails when the committed estimate is stale.
//
//   node deploy/aws/cost/estimate.mjs           print
//   node deploy/aws/cost/estimate.mjs --write   regenerate COST-ESTIMATE.md
//   node deploy/aws/cost/estimate.mjs --check   fail if COST-ESTIMATE.md is stale
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const prices = JSON.parse(readFileSync(join(HERE, "prices.json"), "utf8"));
const assumptions = JSON.parse(readFileSync(join(HERE, "assumptions.json"), "utf8"));
const q = Object.fromEntries(Object.entries(assumptions.quantities).map(([k, v]) => [k, v.value]));
const price = (id) => {
  const item = prices.items[id];
  if (!item) throw new Error(`no price ${id}`);
  return item.usd;
};

/** Fargate cost of one hour of the worker task (2 vCPU, 8 GB, 52 GB of billed ephemeral storage). */
export const workerTaskHour = () =>
  q.workerVcpu * price("fargate_vcpu_hour") + q.workerMemoryGb * price("fargate_gb_hour") + q.workerEphemeralBilledGb * price("fargate_ephemeral_gb_hour");

/** The lines of one scenario: [account, component, quantity text, price id, monthly USD, fixed?, provenance]. */
export function linesOf(name) {
  const s = assumptions.scenarios[name];
  const lines = [];
  const add = (account, component, quantity, priceId, usd, fixed, provenance) => lines.push({ account, component, quantity, priceId, usd, fixed, provenance });

  // Management account: organization, SCP/RCP, Identity Center, Budgets, anomaly detection: no charge.
  add("management", "Organizations, SCPs, RCPs, Identity Center", "—", "—", 0, true, "no charge (owner card D-21)");
  add("management", "Budgets (monitoring, 1 action-enabled budget), anomaly detection", "—", "budgets_monitoring", 0, true, "AWS Budgets pricing page, read 2026-10-22");

  // Data account: audit trail and buckets.
  add("data", "Organization trail, first copy of management events", "all events", "cloudtrail_first_copy_management_event", 0, true, "price list");
  const auditStorage = q.auditLogGbPerMonth * price("s3_standard_gb_month") * (180 / 30);
  add("data", "Audit bucket storage (180 days kept)", `${q.auditLogGbPerMonth} GB/month × 6 months`, "s3_standard_gb_month", auditStorage, true, "ASSUMPTION auditLogGbPerMonth");
  add("data", "Audit log deliveries (PUT)", `${q.auditLogDeliveriesPerMonth} PUT`, "s3_tier1_request", q.auditLogDeliveriesPerMonth * price("s3_tier1_request"), true, "ASSUMPTION auditLogDeliveriesPerMonth");
  add("data", "Customer and journal objects (S3 Standard)", `${s.s3RetainedGb.value} GB`, "s3_standard_gb_month", s.s3RetainedGb.value * price("s3_standard_gb_month"), false, `${s.s3RetainedGb.kind} s3RetainedGb`);

  const attempts = name === "qualification" ? q.qualificationAttempts : s.jobsPerMonth.value * q.attemptsPerJob;
  const jobs = s.jobsPerMonth.value;
  const requests = attempts * q.s3RequestsPerAttempt + jobs * q.controlPlaneRequestsPerJob;
  add("data", "Object requests (worker and control plane), half PUT half GET", `${Math.round(requests)} requests`, "s3_tier1_request", (requests / 2) * (price("s3_tier1_request") + price("s3_tier2_request")), false, "ASSUMPTION s3RequestsPerAttempt, controlPlaneRequestsPerJob");
  add("data", "CloudTrail S3 data events of the protected buckets (D-19)", `${Math.round(requests)} events`, "cloudtrail_data_event", requests * price("cloudtrail_data_event"), false, "same requests");
  add("data", "Guard alarms (EventBridge rules on AWS events, SNS e-mail)", "—", "—", 0, true, "AWS service events on the default bus; first SNS e-mails free (not priced: ASSUMPTION)");

  // Workload account.
  const endpointHours = s.workerEndpoints === true ? q.hoursPerMonth : s.workerEndpoints === "qualification" ? q.qualificationEndpointHours : 0;
  add("workload", "Interface endpoints ecr.api, ecr.dkr, logs (one AZ)", `${q.interfaceEndpoints} × ${endpointHours} h`, "vpce_interface_hour", q.interfaceEndpoints * endpointHours * price("vpce_interface_hour"), true, "DESIGN interfaceEndpoints; worker_enabled");
  add("workload", "Interface endpoint data processed", `${(attempts * q.endpointGbPerAttempt).toFixed(2)} GB`, "vpce_interface_gb", attempts * q.endpointGbPerAttempt * price("vpce_interface_gb"), false, "ASSUMPTION endpointGbPerAttempt");
  add("workload", "S3 gateway endpoint", "—", "s3_gateway_endpoint", 0, true, "no charge (VPC user guide)");
  add("workload", "Worker image in ECR", s.image ? `${q.ecrStoredGb} GB` : "0", "ecr_storage_gb_month", s.image ? q.ecrStoredGb * price("ecr_storage_gb_month") : 0, true, "ASSUMPTION ecrStoredGb");
  const taskHours = (attempts * q.attemptMinutes) / 60;
  add("workload", "Fargate worker tasks (2 vCPU, 8 GB, 72 GiB)", `${attempts.toFixed(1)} attempts × ${q.attemptMinutes} min`, "fargate_vcpu_hour", taskHours * workerTaskHour(), false, "CONTRACT task size; ASSUMPTION attemptMinutes, attemptsPerJob");
  const workerLogGb = attempts * 0.001;
  const logGb = workerLogGb + s.platformLogGb.value;
  add("workload", "CloudWatch Logs ingestion and storage (30 days)", `${logGb.toFixed(3)} GB`, "logs_ingest_gb", logGb * (price("logs_ingest_gb") + price("logs_storage_gb_month")), false, `${s.platformLogGb.kind} platformLogGb; 1 MB per attempt (ASSUMPTION)`);
  add("workload", "RDS PostgreSQL 17 db.t4g.micro Single-AZ (PROPOSED)", s.database ? `${q.hoursPerMonth} h` : "disabled", "rds_pg_t4g_micro_hour", s.database ? q.hoursPerMonth * price("rds_pg_t4g_micro_hour") : 0, true, "DESIGN modules/database");
  add("workload", "RDS gp3 storage", s.database ? `${q.rdsStorageGb} GB` : "disabled", "rds_gp3_gb_month", s.database ? q.rdsStorageGb * price("rds_gp3_gb_month") : 0, true, "DESIGN allocated_storage_gib; backups within the free allocation (equal to the storage)");
  const secrets = s.secrets ? q.appSecrets + 1 : 0;
  add("workload", "Secrets Manager (RDS-managed master + application secrets)", `${secrets} secrets`, "secrets_manager_secret_month", secrets * price("secrets_manager_secret_month"), true, "ASSUMPTION appSecrets");
  add("workload", "API / web / control runtime", "NOT ESTIMATED", "—", 0, true, "R-A1 (Lambda vs ECS) is undecided: docs/design/B14-B-aws-infrastructure.md §5");
  return lines;
}

const usd = (n) => `${n.toFixed(2)}`;

export function totalsOf(name) {
  const lines = linesOf(name);
  const fixed = lines.filter((l) => l.fixed).reduce((a, l) => a + l.usd, 0);
  const variable = lines.filter((l) => !l.fixed).reduce((a, l) => a + l.usd, 0);
  return { fixed, variable, total: fixed + variable };
}

export function renderMarkdown() {
  const out = [];
  const P = prices.items;
  out.push("# AWS cost estimate (generated)", "");
  out.push("Generated by `node deploy/aws/cost/estimate.mjs --write` from `prices.json` (AWS Price List bulk API, us-east-1, OnDemand) and");
  out.push("`assumptions.json`. **No quantity is MEASURED**: there is no AWS account. Every ASSUMPTION is replaced by a measurement during the");
  out.push("qualification (deploy/aws/procedures/QUALIFICATION.md). Prices are USD before tax; the free tier is ignored (a new company account");
  out.push("may receive credits or free-tier allowances, but this estimate does not count on them).", "");
  out.push("## Price sources", "", "| Offer | Publication date | SHA-256 of the offer file read |", "|---|---|---|");
  for (const [offer, o] of Object.entries(prices.offers)) out.push(`| ${offer} | ${o.publicationDate} | \`${o.sha256.slice(0, 16)}…\` |`);
  out.push("", "| Price | USD | Unit | SKU |", "|---|---|---|---|");
  for (const [id, item] of Object.entries(P)) out.push(`| ${id} | ${item.usd} | ${item.unit} | ${item.sku} |`);
  out.push("", "## Summary (USD per month)", "", "| Scenario | Fixed | Variable | Total |", "|---|---:|---:|---:|");
  out.push("| Repository only (today) | 0.00 | 0.00 | 0.00 |");
  for (const name of Object.keys(assumptions.scenarios)) {
    const t = totalsOf(name);
    out.push(`| ${assumptions.scenarios[name].title} | ${usd(t.fixed)} | ${usd(t.variable)} | ${usd(t.total)} |`);
  }
  out.push("", "Not included in any total: the API/web/control runtime (undecided, R-A1), the ingress and DNS in front of it, e-mail (Resend),");
  out.push("Bedrock (Order 26, grants B04-A ≤ USD 40, B04-B ≤ USD 120), taxes, and support plans.", "");

  out.push("## Bounds that follow from the contracts", "");
  const taskHour = workerTaskHour();
  out.push(`- One worker task-hour: 2 × ${P.fargate_vcpu_hour.usd} + 8 × ${P.fargate_gb_hour.usd} + 52 × ${P.fargate_ephemeral_gb_hour.usd} = **USD ${taskHour.toFixed(6)}** (USD ${(taskHour / 60).toFixed(5)} per minute, one-minute minimum).`);
  out.push(`- One attempt at its 8 h wall: USD ${(taskHour * q.executionWallHours).toFixed(2)}; one job at three attempts: USD ${(taskHour * q.executionWallHours * q.maxAttemptsPerJob).toFixed(2)}.`);
  out.push(`- With heavyActive = 1 the worker can never run more than one task at a time: at most USD ${(taskHour * q.hoursPerMonth).toFixed(2)} of Fargate in a month even if it never stopped. That is above a plausible early ceiling, which is why R2-075 makes the application's reservations and job limits the cap and the budget only a lagging backstop.`);
  const endpointsMonth = q.interfaceEndpoints * q.hoursPerMonth * P.vpce_interface_hour.usd;
  out.push(`- The worker's interface endpoints cost USD ${endpointsMonth.toFixed(2)} a month whether or not a task runs (PrivateLink bills per endpoint-hour). They exist only while \`worker_enabled = true\`; with it false no task can pull its image or log, so the worker fails closed rather than costing money.`);
  out.push(`- A public IP instead (USD ${P.public_ipv4_hour.usd}/h only while a task runs) would be cheaper and is rejected: it gives code that handles customer data an open path to the internet (B14-A qualification §4).`);
  const rds = q.hoursPerMonth * P.rds_pg_t4g_micro_hour.usd + q.rdsStorageGb * P.rds_gp3_gb_month.usd;
  const aurora = q.auroraMinAcu * q.hoursPerMonth * P.aurora_pg_serverless_v2_acu_hour.usd + q.rdsStorageGb * P.aurora_storage_gb_month.usd;
  out.push(`- Database floor: RDS PostgreSQL 17 db.t4g.micro with 20 GB gp3 = USD ${rds.toFixed(2)}; Aurora PostgreSQL Serverless v2 kept awake at 0.5 ACU with 20 GB = USD ${aurora.toFixed(2)} plus I/O. Aurora pauses only with no open connection, which a pooled control plane never gives it.`);
  out.push("");

  for (const name of Object.keys(assumptions.scenarios)) {
    const s = assumptions.scenarios[name];
    out.push(`## ${s.title}`, "", "| Account | Component | Quantity | Price | USD/month | Kind | Provenance |", "|---|---|---|---|---:|---|---|");
    for (const l of linesOf(name)) out.push(`| ${l.account} | ${l.component} | ${l.quantity} | ${l.priceId} | ${usd(l.usd)} | ${l.fixed ? "fixed" : "variable"} | ${l.provenance} |`);
    const t = totalsOf(name);
    out.push(`| | **Total** | | | **${usd(t.total)}** | | |`, "");
  }

  out.push("## Assumptions", "", "| Quantity | Value | Kind | Source |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(assumptions.quantities)) out.push(`| ${k} | ${v.value} | ${v.kind} | ${v.source} |`);
  return `${out.join("\n")}\n`;
}

export const ESTIMATE_PATH = join(HERE, "COST-ESTIMATE.md");

if (process.argv[1]?.endsWith("estimate.mjs")) {
  const markdown = renderMarkdown();
  if (process.argv.includes("--write")) writeFileSync(ESTIMATE_PATH, markdown);
  else if (process.argv.includes("--check")) {
    if (readFileSync(ESTIMATE_PATH, "utf8") !== markdown) {
      console.error("deploy/aws/cost/COST-ESTIMATE.md is stale: run node deploy/aws/cost/estimate.mjs --write");
      process.exit(1);
    }
  } else process.stdout.write(markdown);
}
