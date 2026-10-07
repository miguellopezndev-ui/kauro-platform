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

## To ALL sessions — 2026-10-07 (owner decision: less round-trips at merge)
- **R-ALL-1 Registering a NEW package in your own PR (append-only).** When your block creates a new workspace package, your PR
  itself adds (a) its suite line to `SUITES` in `tools/evidence.mjs`, written exactly as the package's `test` script runs
  (same shape as the existing lines; the evidence check refuses a drifted script), and (b) its layer under `"layers"` in
  `architecture.rules.json` (an existing layer name; never edit `allowedDependencies`). Rules: only ADD lines for YOUR new
  package; never modify, reorder or delete an existing entry, never touch other keys of either file. B reviews these lines
  at merge (and resolves any conflict between two sessions' additions). Anything else in these files stays a request to B.
- **R-ALL-2 Cloud verify.** Use `docs/sessions/CLOUD-VERIFY.md` (non-root user for initdb, proxy + its CA for pnpm and
  clean-consume, PGBIN) for every verify in a cloud container, unchanged; report its `CLOUD-VERIFY exit` line and the first
  failing test title in your PR. Container problems go to "Open" in your PR; B fixes the script.

## To S-B (B15 PayPal, PR #19) — 2026-10-07
- **R-B1 F-PP-1 is priority (money).** B changes the port (I-PP-3) and the contract fake (I-PP-4) so the core recovers a
  refund whose response was lost without assuming anything: B writes the failure-matrix rows and the port design first, Codex
  reviews it, then you adapt the adapter to the new port. Until then do not build further on `observeRefund` by request id;
  keep F-PP-1's test as is (it documents the gap).
- **R-B2 F-PP-3** (refund CANCELLED): decided by B in the same design (see the I-PP-3 section when it lands on this branch);
  keep throwing UNRECOGNIZED_PROVIDER_STATE until the port expresses it.
- **R-B3 (tier 1, blocks merging PR #19 as is).** B's plan (PP-REFUND-RECOVERY) found that the adapter's order view claims
  absence proof (`orders-adapter.ts:168-169`), which nothing in PayPal's specs supports; with the core's watchdog
  (`observation.ts:833-840`) a refund PayPal received but has not listed yet could be retried under a new request id after
  60 s = a second refund. Until the new port (I-PP-3) lands, every PayPal "absence" the adapter reports must be
  `absenceIsProof: false` (orders view included), with a contract-table row asserting it per binding. Same for captures.
- **R-B4 (F-PP-6).** The official specs give the "6 h (72 h on request)" PayPal-Request-Id retention for Orders create only;
  the refund endpoint documents none. Correct B15-adapters.md §2.1 so no call relies on a retention window it does not document.
- **R-B5** Record in your fixtures (spec URL + sha256), when available: the refund `status` enum meanings (CANCELLED, FAILED),
  whether the order view echoes the refund `invoice_id`, the refund webhook payload fields, and the Transaction Search
  spec (visibility delay). B's plan treats each as "unknown = no proof" until recorded.
- **R-B6 (tier 1).** `client.ts:96-101` (b15/adapters-paypal) repeats a POST after a 401 (token renewal). For money-moving POSTs
  (refund, capture, order create) that is a possible second effect. Allowed repeats only: the token call itself, and a 401
  renew-and-repeat on READS (GET). A money POST is sent at most once; a 401 on it surfaces as an ambiguous/unauthorized result
  to the core, never repeated. Add a contract row counting wire calls per POST (B's plan test S5 counts wire calls separately
  from core dispatches). B tracks the capture/create side as PP-CAPTURE-ABSENCE / PP-CREATE-RECOVERY.
