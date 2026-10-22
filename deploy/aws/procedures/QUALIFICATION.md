# Tests that need real AWS (PENDING_PROVIDER)

Everything below is **not proved** by this repository: the offline evaluator, the static guards and the mocked plans prove what the
configuration asks for, never what AWS does. Each row runs in the qualification window (ACTIVATION.md gates 5–8), in the owner's
session or an identity the row names, with **synthetic data only**, and records: date, account, request id or CloudTrail event id,
result. A row fails closed: an unexpected ALLOW stops the qualification and becomes an incident.

## A. The organization's guards (D-19, D-21; AUTHORITY-MATRIX.md live)

| # | Test | Expected |
|---|---|---|
| A1 | Every DENY row of AUTHORITY-MATRIX.md executed live with the named principal against a synthetic object | `AccessDenied`; the message names the layer the matrix names (AWS states "explicit deny in a service control policy / resource control policy / resource-based policy") |
| A2 | Every ALLOW row of the matrix executed live | success |
| A3 | The Identity Center session roles' ARNs match the guards' patterns (`aws-reserved/sso.amazonaws.com/[region/]AWSReservedSSO_<set>_…`) in each member account | the owner's admin and publisher sessions pass the exceptions; nothing else does |
| A4 | Identity Center asks for MFA at every sign-in (aws:MultiFactorAuthPresent is absent for federated sessions, so no policy checks it) | a sign-in without the second factor is refused |
| A5 | A role created at `aws-reserved/…` by a member-account administrator | refused (SCP and AWS's reserved path) |
| A6 | RCPs enabled and effective: the management account's administrator calls `s3:GetObject` and `sts:AssumeRole` into the data account | denied by the RCP |
| A7 | `aws:ResourceAccount` is present for the workload's cross-account S3 calls (the workload guard relies on it) | the workload guard's denies apply; record any S3 operation where the key is absent |
| A8 | The spend stop: a test budget of USD 0.01 with `MANUAL` approval; the owner approves; `ecs:RunTask` by the control plane is denied; the owner detaches | as stated; then delete the test budget |
| A9 | The GitHub image publisher: assumed from `environment:aws-qualification` of the repository (allowed); from a branch, a pull request, a fork, another environment (denied) | as stated; the role can push to the one repository and nothing else |

## B. The worker host (B14-A qualification §6; G-CLOUD S073, R2-072)

| # | Test | Expected |
|---|---|---|
| B1 | `RunTask` with `clientToken = attemptId`: lost-answer retries inside the hour, `ConflictException` on a different request, `ListTasks(startedBy)` and `DescribeTasks` of the recorded ARN under load; observed consistency delays | B14-A §3 holds; delays recorded |
| B2 | Chromium's sandbox starts as user 10001 on Fargate (no extra capabilities) | PDF printed with the sandbox on; else the host stays NOT qualified for the report |
| B3 | Per-attempt role life cycle under IAM's eventual consistency (create → RunTask → assume → delete), the launcher only within the boundary | as stated; a role without the boundary is refused |
| B4 | The bucket policy rejects an unconditional PUT on staging/ticket/claim/result keys; multipart steps pass; the gateway endpoint limits the task to the platform's buckets and ECR's layer bucket | as stated |
| B5 | A conditional claim on a **versioned** bucket: second `If-None-Match` claim → 412; a claim whose current version is a delete marker → succeeds (AWS: conditional writes) — so no delete marker may be placed on claims within the creation horizon | as documented; recorded |
| B6 | Image pull time and size through the endpoints; real `peakScratchBytes` against 72 GiB; memory against 8 GiB | MEASURED values replace the cost ASSUMPTIONs |
| B7 | A task stopped by Fargate retirement observed as `FAILED WORKER_CRASHED` and taken over | as stated |
| B8 | B15's S3 `ObjectStoragePort` and the generation grammar mapping (B14-A §6 item 7) against the real bucket | built and reviewed by B15 first |

## C. The network (B14-A §4; G-CLOUD S072, S074)

| # | Test | Expected |
|---|---|---|
| C1 | From a worker task: HTTPS to an internet host, DNS of an external name, any port other than 443 | all fail |
| C2 | From a worker task: ECR pull, CloudWatch logs, S3 of the platform's bucket through the gateway | succeed; S3 of any other bucket fails (endpoint policy) |
| C3 | No public IPv4 is in use in any account (the VPC IP address manager / Cost Explorer `PublicIPv4`) | none |

## D. Retention, deletion, encryption (D-19; legal checklist A-20)

| # | Test | Expected |
|---|---|---|
| D1 | Every object version reports SSE-S3 (`ServerSideEncryption: AES256`) | yes |
| D2 | A version under GOVERNANCE retention: delete by the control plane, the owner's admin session and the data administrator | denied |
| D3 | The same by the deletion identity with `x-amz-bypass-governance-retention: true` | deleted; the `kauro-guard-retention-bypass` alarm e-mails the owner |
| D4 | `PutObjectRetention` with `COMPLIANCE` by any principal | denied by the bucket policy |
| D5 | **A-20**: the lag between a version becoming noncurrent and its removal by the lifecycle rule (several samples, with dates) | measured and recorded; the legal texts state the measured or AWS-documented maximum, never "one day" |
| D6 | A locked version is not removed by the lifecycle rule before its retention ends | not removed |
| D7 | The deletion function's publication, signing enforcement and refusal of unsigned code (DELETION-FUNCTION.md checks) | as stated |
| D8 | The journal bucket refuses an overwrite of an existing entry | 412 or AccessDenied |

## E. Audit and alarms

| # | Test | Expected |
|---|---|---|
| E1 | The data account, as CloudTrail delegated administrator, owns the organization trail; files from every account arrive in the audit bucket (Object Lock with default GOVERNANCE retention) | delivered, retention set, log file validation passes |
| E2 | S3 data events of cross-account calls (the workload's control plane on the data bucket) reach the trail | recorded |
| E3 | Each `kauro-guard-*` rule fires on its event and the SNS e-mail arrives; whether cross-account data events reach the data account's EventBridge bus | as stated; record the gaps |
| E4 | `StopLogging` by the data administrator | denied |

## F. Database (only once the runtime is decided: B14-B §5)

| # | Test | Expected |
|---|---|---|
| F1 | The platform's migrations and test suites against RDS PostgreSQL 17 (RLS FORCE, transaction advisory locks, the migrator's session advisory lock, `SET LOCAL transaction_timeout`, `pg_terminate_backend` on a direct connection, `server_now`) | the same results as the local PostgreSQL 17 |
| F2 | TLS with certificate verification against the RDS CA bundle (`KAURO_DB_TLS_CA_FILE`), `rds.force_ssl = 1` refusing plaintext | as stated |
| F3 | The connection budget measured (R2-073): the declared pools against `max_connections` | within the budget; the plan refuses a breach |
| F4 | Point-in-time restore into an isolated instance, the recovery runner S1–S8, the journal replay (G-RECOVERY, R2-074, R2-076) | RPO and RTO MEASURED |
| F5 | No statement text in the database's logs after a failing statement with a synthetic customer value | absent |

## G. Cost (Order 25 §6)

| # | Test | Expected |
|---|---|---|
| G1 | Seven days idle after step 3 of PROVISIONING.md: Cost Explorer by service and usage type | only the fixed lines of the idle scenario; no NAT, no public IPv4, no interface endpoint |
| G2 | The qualification month's bill against COST-ESTIMATE.md's qualification scenario | every ASSUMPTION replaced by a MEASURED value in `cost/assumptions.json`, the estimate regenerated |
| G3 | The anomaly subscription and the budget e-mails arrive | yes |

## Zero resources and zero spend before activation

Until gate 2 there is no AWS account, so there is nothing to list and no bill: the evidence of zero resources is the absence of an
account (A9 §5) together with the repository's guards (no workflow holds AWS credentials or runs `apply`; every root refuses any
plan without the owner's activation reference). From the first apply on, G1 is the check.
