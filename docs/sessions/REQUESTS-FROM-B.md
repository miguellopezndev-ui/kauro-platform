# Requests from B (builder) to the parallel sessions

Read this file at the start of each block (`git fetch origin docs/b-requests`). Answer in your own branch/PR; never edit this file.

## To S-A (B14) — 2026-10-07
- **R-A1 Lambda vs ECS Fargate for `apps/api`** (AWS-DELTA §2.1, Q-AWS-7). Compare both against the three contracts Lambda changes:
  (1) drain on shutdown (`SHUTDOWN_DEADLINE_CEILING_MS`, R35 operability: in-flight requests finish or are refused retriable;
  per-request drain on Lambda), (2) the admission limiter (R2-046 fair order, `execution_capacity`, per-process concurrency vs
  Lambda concurrency), (3) the PostgreSQL connection budget (pool per process vs one connection per Lambda instance; direct
  connection required, no transaction pooler — B10 D10-GAP-6a; PG17 `transaction_timeout` required). Include monthly cost at
  launch volume and at 10x, cold-start effect on the 202/503 contracts, and choose one with justification in
  `docs/design/B14-api-runtime.md`. Needed by 08-oct (I-1 and the B14 network decision depend on it).
- **R-A2** B (builder) is doing I-2 (DB TLS with certificate verification) and I-3 (`*_PASSWORD_FILE`) now as a separate PR;
  confirm the CA bundle path and `rds.force_ssl` (Q-AWS-8) so the config names match (`KAURO_DB_TLS_CA_FILE`).
- **R-A3** Q-AWS-3/Q-AWS-5: B designs the replacement for the D-HOLD-4 provider fence (fence in Kauro's database) and the
  Cognito second-factor proof; send any Cognito/S3 capability facts you verify (Object Lock modes, legal hold API, Cognito
  `amr`/MFA claims in ID/access tokens) to `docs/design/B14-facts-for-B.md` in your branch.

## To S-A (B14) — 2026-10-07, owner decision D-19 (customer-data buckets)
- **R-A4** Customer-data buckets: versioning ON, Object Lock ON in **GOVERNANCE mode only (never COMPLIANCE)**, no default
  retention, noncurrent-version expiration 1 day. `s3:BypassGovernanceRetention` granted ONLY to the retention/deletion identity,
  with CloudTrail data events on the bucket; no other role (deploy included). Add an IAM policy test (Terraform plan / policy
  simulator) proving no other principal holds it. In the real-account qualification, measure the actual lag between a
  noncurrent version becoming eligible and its removal (legal texts will state the documented/measured maximum, never "1 day").
