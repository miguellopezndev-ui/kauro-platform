# B14-B — Kauro's AWS infrastructure, built and tested offline (Order 25)

Order 25, the second part of B14, after B14-A (Order 9: the worker, its host selection and its deployment contracts). Base: `main`
`58dda63f40c2f4f3f315ebdbdc5b393d66cb8492` (merge of PR #120, Order 14). No AWS account exists (A9 §5): nothing here was created,
applied, registered, pushed or billed, and no credential was used. Everything is Terraform (run with OpenTofu 1.13.1 locally and
in CI, and with Terraform 1.16.5 in CI), policy documents and offline checks. **Nothing here is qualified for production**; the live
proofs are listed in [deploy/aws/procedures/QUALIFICATION.md](../../deploy/aws/procedures/QUALIFICATION.md).

## 1. Authorities read

| Authority | What it fixes here |
|---|---|
| [A9](../authority/amendments/A9_CLOUD_AWS.md) | AWS primary; Terraform, GitHub OIDC with no static keys; no NAT, interface endpoints or permanent HA unless a contract requires them; RDS PostgreSQL 17 as the fallback when Aurora cannot keep the contracts; recompute cost from current prices |
| D-19 (`docs/sessions/REQUESTS-FROM-B.md` R-A4, `docs/legal/CHECKLIST.md` A-20) | Customer buckets: versioning, Object Lock GOVERNANCE only, no default retention, noncurrent expiry one day; `s3:BypassGovernanceRetention` only for the deletion identity; CloudTrail data events; an IAM test proving it; the expiry lag measured live, never promised as one day |
| D-21 A and the owner's adjustments (`docs/owner/OWNER_CARDS.md`) | Three accounts (management empty, data, workload); the deletion function deployed only in the owner's MFA session, enforced by an SCP, with code signing in Enforce mode |
| [B14-A host qualification](B14-A-aws-host-qualification.md), [executor](B14-A-worker-executor.md), [recovery](B14-A-recovery.md), [deploy/aws/worker](../../deploy/aws/worker/README.md) | ECS RunTask on Fargate, Linux/x86_64, per attempt: `SELECTED_NOT_QUALIFIED`; its task, role, boundary, launcher and bucket contracts |
| `packages/contracts/registry/policy.json` | capacity (8 GiB, 64 GiB, 8 h, heavyActive 1), retention (logs 30 days, security logs 180), funding (USD 220/month) |
| R2-073, R2-075 (`registry/cases.json`) | The connection budget checked before rollout; budget alerts are observability, the application's limits are the cap |
| Legal checklist A-06, A-20 | US Regions only; the deleted-copy lag measured in the real account |

AWS facts were re-read from AWS's documentation on 2026-10-22 (§9); prices come from AWS's Price List bulk API of that day.

## 2. Inventory: what existed, what was reused, what is new

| Piece | Before Order 25 | Now |
|---|---|---|
| Worker task definition, RunTask, attempt role and boundary, launcher, execution role, bucket statements, Dockerfile (`deploy/aws/worker`) | Contracts (Order 9) | **Reused unchanged** (one comment reworded: it contained a literal `${...}`, which a template engine reads as a placeholder). Terraform renders them; the offline checks render the same files |
| B14-A host decision and its §6 live probes | `SELECTED_NOT_QUALIFIED` | Unchanged; the probes are QUALIFICATION.md part B |
| Organization, accounts, SCPs, RCP, Identity Center | Owner decision only (D-21 A) | `terraform/modules/organization`, `identity-center`; `policies/organization/*` |
| Customer-data bucket, authority-journal bucket, audit trail, alarms | Decision only (D-19), journal "Object Lock bucket outside the restore boundary" (B16 L6) | `modules/protected-bucket`, `audit-trail`; `policies/data/*` |
| Deletion identity and its publication | Decision only (D-21 A) | `modules/deletion-function` (role, signing profile, code-signing configuration, signing bucket; **not** the function); `procedures/DELETION-FUNCTION.md` |
| Network, cluster, repository, roles | Contracts only | `modules/network` (zones pinned by zone ID), `worker`, `deploy-identity` |
| Database | A9 candidates only | `modules/database`: RDS PostgreSQL 17, **PROPOSED_NOT_QUALIFIED**, disabled by default |
| Budgets, spend stop, anomaly detection | — | `modules/cost-guardrails`, `policies/organization/scp-spend-stop.json` |
| State | — | `modules/state-backend` (one bucket per account, S3 lock file) |
| Offline checks | — | `deploy/aws/checks` (IAM/SCP/RCP evaluator, authority matrix, static guards), `tools/test/aws-infrastructure.test.mjs`, Terraform tests, `.github/workflows/aws-iac.yml` |
| Cost | A9's historical figures, B14-A §7 (worker only) | `deploy/aws/cost` (prices by SKU, labelled assumptions, generated estimate) |

## 3. Organization and resources per account

The management account holds the organization and billing only. SCPs and RCPs **never restrict the management account** (AWS
Organizations user guide: "SCPs don't affect users or roles in the management account"; "RCPs don't affect resources in the
management account"), so no guarantee here rests on them for that account: its protection is that only the owner signs in to it,
with MFA, and that every resource it could reach in the data account is also guarded by that account's RCP and bucket policies
(the RCP binds callers from any account, the management account's included).

| Account | Resources (Terraform root) | Automated identity |
|---|---|---|
| management | organization (all features; SCP and RCP types; CloudTrail and SSO service access), OUs `Data` and `Workloads`, the two member accounts (`close_on_deletion = false`, `prevent_destroy`), 4 SCPs + 1 RCP and their attachments, CloudTrail delegated administrator = data account, permission sets `KauroOwnerAdministrator`, `KauroDeletionPublisher`, `KauroOwnerReadOnly`, budget `kauro-monthly-ceiling` with the spend-stop action, anomaly monitor and subscription, alarms on the organization trail and the guard policies (SNS e-mail), state bucket | none |
| data | `kauro-<env>-customer-data-<id>` and `kauro-<env>-journal-<id>` (Object Lock, versioning, GOVERNANCE only, no default retention, noncurrent 1 day, abort MPU 1 day, SSE-S3, public access blocked, ACLs disabled), `kauro-audit-<id>` (Object Lock, default GOVERNANCE 180 days), the organization trail it manages as delegated administrator (owned by the management account; management events of every account, S3 data events of the two protected buckets, log-file validation), SNS `kauro-guard-alarms` + six EventBridge rules, deletion role `kauro-deletion/kauro-<env>-retention-deletion`, log group, signing profile, code-signing configuration (Enforce), `kauro-signing-<id>`, state bucket | none: every apply is the owner's session |
| workload | VPC (no IGW, no NAT, no public IP), one worker subnet (one AZ) and two database subnets, one private route table, S3 gateway endpoint (policy: the platform's buckets and ECR's layer bucket), security groups (worker, platform, endpoints, database; default SG empty), interface endpoints `ecr.api`, `ecr.dkr`, `logs` **only while `worker_enabled`**, ECR `kauro/migration-worker` (immutable tags, scan on push, lifecycle), cluster `kauro-<env>` (Container Insights off), log group (30 days), execution role, control-plane role with its boundary, launcher and storage policies, attempt boundary `kauro-guard/kauro-attempt-boundary`, task definition **only with a pinned digest**, GitHub OIDC provider and image publisher, PROPOSED database (disabled), state bucket | `kauro-deploy/kauro-<env>-image-publisher`: GitHub OIDC from one repository's one deployment environment; can push worker images, nothing else |

One environment per account pair: the worker contracts name attempt roles `kauro-attempts/kauro-attempt-<id>` with no environment,
so two environments in one workload account could reach each other's bucket. Production gets its own activation (ACTIVATION.md
gate 9); whether it also gets its own pair of accounts (no fixed cost) is the owner's decision at that gate (BLOCKED_OWNER).

## 4. Authority: who can do what

The complete matrix, evaluated offline over the rendered documents, is [deploy/aws/AUTHORITY-MATRIX.md](../../deploy/aws/AUTHORITY-MATRIX.md)
(92 rows, generated). Its conclusions:

| Guarantee | Held by (each layer alone suffices unless stated) | Evidence |
|---|---|---|
| Only the deletion identity bypasses governance retention (D-19 condition 1) | data SCP `DenyGovernanceBypassExceptDeletionIdentity` (data-account principals); RCP `OnlyTheDeletionIdentityBypassesGovernance` (any caller, any account, root users included); bucket policy `GovernanceBypassAndLegalHoldOnlyByTheDeletionIdentity`; workload SCP `DenyDataAccountGuardActions` | VERIFIED_STATIC: every principal of the model tried, only `deletionRole` allowed; removing one layer keeps the denial, removing all three flips it (negative control) |
| The deploy identity — or any workload administrator — cannot reach retention or the platform's data by an indirect path | the deploy identity can only push images; Terraform is applied in the owner's session; the workload SCP reserves attempt roles to the launcher, and the guard and runtime roles and policies (the control plane's above all: its trust, boundary, policies, and passing it to a task or function), its own role and the OIDC trust to the owner's session; no role of the data account is assumable from the workload (SCP and RCP); the data account has no automated identity | VERIFIED_STATIC rows "Deploy identity", "Workload guards", "Data account identity" (each step of the escalation the independent review found is a denied row) |
| No new principal in the data account can be made to reach the bypass | data SCP `DenyIamChangesExceptOwnerSessions`, `DenyPassingTheDeletionRoleExceptOwnerSessions`; the bypass exceptions name the role path `kauro-deletion/`, which only the owner's sessions can create | VERIFIED_STATIC |
| The deletion function changes only in the owner's MFA session, signed | data SCP `DenyDeletionFunctionChangesExceptOwnerSessions`, `DenyCodeSigningChangesExceptOwnerSessions`; `TheDeletionFunctionAlwaysRequiresSignedCode` and `CodeSigningIsNeverRelaxed` bind the owner's sessions too (no creation without a code-signing configuration, no detaching, no relaxing); the configuration is in `Enforce` mode | VERIFIED_STATIC (SCP); PENDING_PROVIDER (signing enforcement, MFA prompt) |
| The buckets' guards (policy, lock, lifecycle, versioning, access, CORS, replication) change only in the owner's administrator session | data SCP `DenyProtectedBucketGuardChangesExceptOwnerAdministrator`; each bucket's `BucketGuardsChangeOnlyInTheOwnerSession`; workload SCP | VERIFIED_STATIC |
| Never COMPLIANCE mode | bucket policies `NeverComplianceMode`; bucket default retention changes only in the owner's session; static guard on the Terraform | VERIFIED_STATIC, TESTED_LOCAL |
| Deletion outside `staging/` only by the deletion identity; staging cleaned only by the control plane (STAGING_JANITOR); no object retired by overwriting it (every creation but a heartbeat carries If-None-Match, so no unretained version becomes noncurrent and expires) | bucket policy `DeletesOutsideStagingOnlyByTheDeletionIdentity`, `NoOverwriteOutsideHeartbeats`; workload SCP `DenyDataAccountDeletesOutsideStaging` | VERIFIED_STATIC |
| An attempt reads only its sealed versions, writes only its prefix once, never deletes, only through the VPC endpoint | the B14-A contracts, unchanged, plus the cross-account grant `AttemptRolesWithinTheirCeiling` | VERIFIED_STATIC |
| Attempt roles exist only as the launcher makes them, within the boundary | workload SCP `AttemptRolesOnlyWithinTheBoundary`, `AttemptRolesOnlyByTheLauncher`; the boundary is changed only in the owner's session | VERIFIED_STATIC |
| The trail and the alarms stay on, against every principal but the owner's | data SCP `DenyAuditAndAlarmTamperingExceptOwnerAdministrator` (data-account principals, alarm subscriptions included); the audit bucket denies every deletion. The organization trail is a management-account resource (CloudTrail makes the management account its owner even when the delegated administrator manages it): the management account's own principals, outside every SCP, could stop it, so the management root alarms on trail and guard-policy changes (`modules/management-alarms`) | VERIFIED_STATIC; PENDING_PROVIDER (delivery, alarms) |
| No internet path, no fixed-cost gateway, no shell into a task, one US Region, no static keys | workload and baseline SCPs; the network module; static guards | VERIFIED_STATIC, TESTED_LOCAL |

Stated limits (not hidden by any of the above):

1. **The management account's own principals and resources are outside every SCP and RCP.** It is protected by being the
   owner's alone, and it holds nothing but the organization and billing.
2. **MFA is Identity Center's guarantee, not a policy condition**: `aws:MultiFactorAuthPresent` is absent for federated sessions
   (IAM condition-keys reference), so the guards recognise the owner's sessions by their reserved role names, which only AWS can
   create (and `scp-member-baseline` closes `aws-reserved/*` to everyone else). PENDING_PROVIDER: QUALIFICATION A3–A5.
3. **The owner can change any guard** (detach an SCP from the management account, edit a bucket policy in the admin session). D-21
   puts human authorization at the root of trust; the guards stop accidents, stolen tokens and every non-owner principal, not the owner.
4. **Residual inside the workload**: a principal that is the launcher (the control plane) can create attempt roles within the attempt
   ceiling, which reaches every object of the `accepted/` zone — as the control plane itself already can. Retention, deletion outside
   staging and the bucket's guards stay out of its reach.
5. **Service-linked roles** are bound by neither SCPs nor RCPs; none of them has S3 data access to these buckets by design.
6. **The offline evaluator models the documented logic**, not AWS's code: an IAM or Terraform simulation does not prove the effective
   permissions of a real account (QUALIFICATION part A executes every row live).

## 5. The rest of the platform's infrastructure

Only what a contract determines is built. Open decisions are prepared, not taken.

| Need | Contract state | Order 25 |
|---|---|---|
| API (`apps/api`, Node server, port 3000, drain ≤ 9 s, pool ≤ 4 per process, at most two instances), web (`apps/web`, Next.js standalone server), control plane (`apps/control`, a library with `runCycle`, no process yet), migration job (`apps/api/src/migrate.ts`, before traffic) | **Runtime undecided**: R-A1 (Lambda vs ECS) asked for `docs/design/B14-api-runtime.md`, which does not exist; the 9 s shutdown ceiling is Cloud Run's; no sweep frequency is specified | **NOT_IMPLEMENTED.** Prepared: the control plane's role (trust ECS tasks, PROPOSED), its boundary and grants; the `platform` security group; the R2-073 budget check. Design input for the decision, from the contracts: a long-running, pooled, direct-connection process that drains in ≤ 9 s fits ECS on Fargate as an always-on service (USD 9.01/month at 0.25 vCPU / 0.5 GB, us-east-1 price list) better than Lambda (one connection per instance against a 24-connection application ceiling; per-request drain), but the choice needs R-A1's comparison and its owner, and an ingress (load balancer or API Gateway with a private integration) whose cost and contract are not settled |
| PostgreSQL 17, direct connection, no transaction pooler, RLS FORCE, advisory locks, `SET LOCAL transaction_timeout`, `pg_terminate_backend` on the backend's pid, TLS with CA verification, passwords from files | Determined by code (`packages/persistence`) | `modules/database`: RDS PostgreSQL 17 db.t4g.micro Single-AZ, gp3 20 GB, encrypted, private, `rds.force_ssl = 1`, no statement text in logs, deletion protection, final snapshot, PITR on, with the retention days and backup window as **owner activation inputs** (`database_backup`, no default: enabling the database without them fails at plan, tested), fixed `max_connections` and the R2-073 budget precondition. **PROPOSED_NOT_QUALIFIED**, disabled by default |
| Aurora PostgreSQL Serverless v2 (+ Data API) | A9's first candidate | **Not chosen and not disqualified**: Data API does not run VERIFY_SQL and is not a direct connection; with a direct connection Aurora is still a fork whose locks, RLS, `transaction_timeout` and `pg_terminate_backend` semantics must be proved; and it pauses only with no open connection (Aurora user guide), which a pooled control plane never gives it, so its floor (0.5 ACU, USD 43.80/month + storage) is above RDS's (USD 13.98). QUALIFICATION part F would qualify either |
| Queues | The outbox is in PostgreSQL (`apps/control/src/dispatcher.ts`); no code uses SQS | **Not needed** by any current contract; nothing built |
| Scheduled jobs | `runCycle` exists; frequency unspecified (C-25: deletion runs at least weekly) | **NOT_IMPLEMENTED** with the runtime; EventBridge Scheduler is free for the first 14 million invocations (price list) |
| Identity | The code verifies Google Identity Platform tokens; Cognito is A9's candidate; Q-AWS-5 open (`ORDER11-FUNCTIONAL-GAPS.md`) | **NOT_IMPLEMENTED**; no Cognito pool is created before the provider decision (Order 16's governance / the identity owner) |
| Secrets | Read from files (`*_PASSWORD_FILE`, `KAURO_API_CURSOR_KEY_FILE`, `KAURO_PUBLIC_HASH_KEY_FILE`, `KAURO_DB_TLS_CA_FILE`) | Only the RDS-managed master secret (Secrets Manager) when the database is enabled; how files are mounted depends on the runtime: NOT_IMPLEMENTED |
| Object storage port | GCS-shaped (`ifGenerationMatch`, generation int64 grammar, resumable URIs up to 7 days) | Buckets ready; the S3 adapter and the generation mapping are **B15's** (B14-A §6 item 7); browser upload CORS is not set until B15 defines the upload path |
| E-mail, DNS, public site | Resend, Cloudflare, Cloudflare Pages (D-27) | Outside AWS; nothing built |
| Bedrock | Order 26's live campaign | Kept separate. One dependency recorded: the baseline SCP allows one Region (`us-east-1`); `us.` cross-Region inference profiles route to other US Regions, so Order 26 must either confirm in-Region inference or add the profile's Regions to `allowed_region` in a reviewed change (A-06 still holds: all US) |

## 6. Cost (summary; the full estimate is generated)

[deploy/aws/cost/COST-ESTIMATE.md](../../deploy/aws/cost/COST-ESTIMATE.md), from AWS's Price List (us-east-1, offers published
2026-09-11 to 2026-10-20, each file's SHA-256 recorded) and [assumptions](../../deploy/aws/cost/assumptions.json) each marked
CONTRACT, DESIGN or ASSUMPTION — none MEASURED.

| Scenario | USD/month |
|---|---:|
| Repository only (today) | 0.00 |
| Accounts open, platform idle, no customer | 0.48 |
| Worker qualification month | 3.68 |
| Platform live, first customer (runtime excluded) | 39.96 |
| Growth ×10 (runtime excluded) | 44.55 |

The fixed cost is dominated by the worker's three interface endpoints (USD 21.90: PrivateLink bills per endpoint-hour whether or not
a task runs) and the database (USD 13.98). Both are off until needed (`worker_enabled`, `database_enabled`), and the worker fails
closed without its endpoints. A public IP would be cheaper and is rejected (an open internet path for code that handles customer
data). With heavyActive = 1 Fargate cannot exceed USD 89.27 in a month; that is why the application's limits are the cap (R2-075)
and the budget's spend stop only a lagging backstop. The monthly ceiling and the spend stop's approval mode (AUTOMATIC or MANUAL) are
owner activation inputs with no default (BLOCKED_OWNER; the Terraform
refuses a value above the USD 220 funding row).

## 7. Offline tests and results

| Check | Class | Result (this branch) |
|---|---|---|
| `tools/test/aws-infrastructure.test.mjs` (in `pnpm run verify`): evaluator semantics (5), rendering (2), authority matrix (92 rows) and its freshness, D-19 exhaustive bypass check, negative controls (3), static guards (8) and their detectors (with workflow and provider-binding negative controls), the Terraform/OpenTofu test twins, cost freshness and invariants (4) | VERIFIED_STATIC | 28 tests pass |
| `tofu test` and `terraform test` — management (8 runs), data (7), workload (11), modules protected-bucket (5), database (5), network (4), mocked provider. OpenTofu reads `*.tofutest.hcl`, Terraform `*.tftest.hcl`: the same runs, Terraform's with `override_during = plan` (an argument OpenTofu refuses) | TESTED_LOCAL | 40 runs pass with OpenTofu 1.13.1 and with Terraform 1.16.5 (aws provider 6.68.0, each from its own locked registry), locally and in CI |
| `tofu validate` and `tofu fmt -check`, every root | VERIFIED_STATIC | pass |
| Checkov 3.3.26 with the reviewed exceptions of `deploy/aws/terraform/.checkov.yaml` (each justified by a contract) | VERIFIED_STATIC | locally file by file (the directory scan hangs on Windows): 282 checks passed, 0 failed; directory scan in CI (`aws-iac.yml`). Three findings were fixed rather than excepted: zones pinned by zone ID, the signing bucket's lifecycle, the budget action's policy narrowed to its policy and OU |

What the static guards cover: internet gateways, NAT, Elastic IPs, default VPC, IAM users and keys, load balancers, public IPs,
open CIDRs, force-destroy, final snapshots, deletion protection, COMPLIANCE mode, public access blocks, provider credentials,
account closure, Container Insights; secrets (AWS keys, private keys, GitHub tokens, literal passwords); policy shape (no Allow to
`*` principals, of `*` actions, with NotAction, or service-wide); SCP/RCP size; exact provider pins and both lock files; no
workflow that applies, destroys, imports, plans against a backend or obtains AWS credentials; every root's provider bound to one
account and gated by the activation reference; every template a Terraform file names exists; the worker contracts against
`policy.json` capacity and Fargate's limits; only `us-east-1` named.

## 8. Security and recovery configuration

- Encryption: SSE-S3 everywhere (no KMS key: no fixed cost and no `kms` endpoint; B14-A §4); RDS storage encrypted with the AWS
  managed key; TLS required by the RCP, the bucket policies and `rds.force_ssl`.
- Retention: customer and journal buckets GOVERNANCE without default retention (the platform sets or extends retention per object;
  shortening needs the bypass); audit logs GOVERNANCE 180 days then expired; noncurrent versions one day after (lag measured: A-20).
- Logging: worker logs identifiers only (B14-A); database logs no statement text; application logs 30 days, security logs 180
  (policy.json); CloudTrail management events of every account and data events of the protected buckets.
- Recovery: RDS PITR (retention and window are owner activation inputs, BLOCKED_OWNER), S3 versions (no in-place restore: every creation is create-once), the authority journal outside the restore boundary, the restore and
  rollback steps of [PROVISIONING.md](../../deploy/aws/procedures/PROVISIONING.md); executed live at ACTIVATION gate 8.

## 9. AWS sources read on 2026-10-22

- SCPs: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html — "SCPs don't affect users or roles
  in the management account"; "SCPs do not affect any service-linked role".
- RCPs: https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_rcps.html — supported services (S3, STS,
  KMS, SQS, Secrets Manager, …); "RCPs don't affect resources in the management account"; root users included; service-linked roles excluded.
- Condition keys: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html — `aws:MultiFactorAuthPresent`
  "is not present for federated identities".
- Conditional writes: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html — "For buckets with versioning
  enabled, if there's no current object version with the same name, or if the current object version is a delete marker, the write
  operation succeeds."
- Object Lock: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html — bypass needs the permission and the
  header; Object Lock cannot be disabled nor versioning suspended; "a locked version of an object cannot be deleted by a S3 Lifecycle
  expiration policy"; delete markers are not WORM-protected.
- Aurora auto-pause: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html — "If any
  user-initiated connections are open to an Aurora serverless instance, the instance won't pause"; RDS Proxy prevents pausing.
- Budgets pricing: https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/ — monitoring free; first two action-enabled budgets free.
- Price List bulk API: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json (offers and hashes in `deploy/aws/cost/prices.json`).
- B14-A §8 for ECS, Fargate, ECR endpoints, task roles and IAM quotas (read 2026-10-18).

## 10. Independent review

A separate reviewer, given the code and the owner's decisions but not this document's conclusions, attacked the guards, the
Terraform and the evaluator at commit `030f8d4c`. Its findings and what was done:

| # | Finding | Resolution |
|---|---|---|
| C1 | An organization trail created by a delegated administrator is owned by the management account: the bucket policy named the data account in the trail ARN and log prefix, so delivery would fail; and "the trail stays on" overclaimed | Fixed: the trail ARN and `AWSLogs/<management>/` name the management account (test added); the claim is restated; the management account alarms on trail and guard-policy changes |
| C2 | An unretained object could be retired by overwriting it (its noncurrent version expires in a day); a workload administrator could take over the control plane's role (lift its boundary, change its trust, pass it to a task) | Fixed: create-once on every object creation but heartbeats; the runtime roles and policies, and passing the control plane's role, are owner-only in the workload SCP; each step is a matrix row |
| M1 | Code signing was not enforced by policy: a function created without a code-signing configuration, or a configuration detached or relaxed, would run unsigned code | Fixed: the data SCP denies creating the function without `lambda:CodeSigningConfigArn` and denies detaching or updating a configuration, to everyone |
| M2 | `aws:SourceArn` in the deletion role's trust is not documented as sent by Lambda: the role might never be assumable | Fixed: `aws:SourceAccount` only; PassRole (owner-only) and code signing decide which function runs with it; QUALIFICATION D7 |
| M3 | The evaluator exempted AWS service principals from RCPs | Fixed (only service-linked roles are exempt), with a test |
| minor | Same-account account-root grants and `ForAnyValue` on an absent key (evaluator); five bucket-guard events and alarm-subscription changes missing from the alarms and the SCP; Converse actions and a scale-down block in the spend stop; ECR count expiry able to expire the pinned image; an owner-role pattern loose at its suffix; QUALIFICATION A6's GetObject proving nothing about the RCP; the Budgets role without a confused-deputy condition | All fixed as stated; COMPLIANCE mode set at CreateMultipartUpload is added to QUALIFICATION D4 |

## 11. Dependencies on other orders

| Order | Dependency | Owner | Proof expected |
|---|---|---|---|
| 15 (security/authorization audit) | None on `packages/authorization` or RLS. Its findings on the database roles (one login per group, no BYPASSRLS) bind the RDS provisioning of logins, which is not built here | Order 15 | its audit's role matrix applied when the runtime is built |
| 16 (functional governance, PR #122) | The open decisions this order prepares but does not take: the API runtime (R-A1), the identity provider (its B-13, F-07; Q-AWS-5), the object generation grammar for S3 (B15), the backup window and RPO/RTO, the monthly ceiling, one pair of accounts per environment. CP-01.02 (17-day ceiling, 72-hour extension) needs no infrastructure change: the customer buckets carry no default retention; the platform sets retention per object | Order 16 / the owner | an owner decision per item |
| 17 (API contracts CP-02, PR #123) | None: CP-02 changes the API's contract, not where it runs. The runtime that serves it is R-A1's | — | — |
| 26 (Bedrock qualification) | The baseline SCP's single Region and US cross-Region inference profiles (§5); Bedrock's own IAM, retention and logging probes stay in Order 26 | Order 26 | a reviewed change of `allowed_region` or in-Region inference proved |
| 18, 28 | No dependency found; their scope is not recorded in this repository | — | — |
