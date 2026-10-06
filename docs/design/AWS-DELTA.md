# AWS-DELTA — every Google Cloud assumption in the current code, and its AWS substitute

Package B14 (cloud foundation), amendment A9 (AWS primary cloud, owner decision 2026-10-05). Branch `b14/aws-foundation`.
Base: `main` at `a7315df`. Date: 2026-10-06. Author: parallel session (B14 lane). Readers: B (builder), S-B, Codex.

**Evidence class of this document: DESIGN.** Nothing here was executed against AWS: there is no AWS account (D-14). Every
AWS fact is either cited to an official page with its retrieval date, or marked **VERIFY** with the deliverable that will
close it. No case, threshold or evidence class of R2 changes (A9 §2); this document only says which contract each
substitution puts at risk and who must re-qualify it.

Legend for the "Owner" column: **B14** = this lane (infra/, Terraform, docs); **B15** = live adapters (B builds them in
`packages/**` / `apps/**`); **B** = a change in `apps/**` or `packages/**` that this lane may not touch and requests in §6.

## 1. Summary table

| # | GCP assumption | AWS substitute | Files that assume GCP today | R2 contract at stake | Owner | Risk |
|---|---|---|---|---|---|---|
| 1 | Cloud Run (HTTP server, many requests per instance, SIGTERM + 10 s grace, `run.app` URL) | Lambda + API Gateway (REST, regional) + WAF; HTTP server kept via Lambda Web Adapter **or** a handler entry | `apps/api/src/main.ts`, `apps/api/src/config.ts:130-139` (pool ceiling, 9 s shutdown ceiling), `apps/api/src/server.ts:216` (trusted proxy hops), `apps/api/README.md:69`, `apps/api/test/operability.test.ts:223`, `docs/design/B06-review/E-transport-operability.md` E-ADDR-1, E-OPS-2 | S072 (ingress bypass), R2-073 (connection budget), 07 "Connection budget" R43, E-OPS-2 drain, I-ADM-1 admission limiter | B14 + B | **High** |
| 2 | Cloud Batch (VM + disk per job, job id unique per project) | AWS Batch on Fargate (ephemeral storage 20–200 GiB) | `packages/data-plane/src/testing/worker-host.ts` (contract fake; "the real host is B14's (Cloud Batch)"), `packages/application/src/ports/worker-host.ts`, `docs/design/B08-audit-approval-jobs.md` §10 | S073, S074, R2-072, D8-HOST-1 (create by identity, ALREADY_EXISTS), D8-ATT-2, D8-JAN-1 | B14 (design) + B (host) | **High** |
| 3 | Cloud SQL for PostgreSQL over the `pg` wire protocol | Aurora PostgreSQL Serverless v2 **with `pg`**, or RDS PostgreSQL 17 (fallback); Data API evaluated and **not** a drop-in (§3.4) | `packages/persistence/src/pool.ts:134`, `packages/persistence/src/migrations/runner.ts:299` (no TLS options), `apps/api/src/config.ts` (`KAURO_DB_PASSWORD`, `KAURO_DB_ASSURANCE_PASSWORD` plain env), `packages/persistence/migrations/0001_schema_roles_helpers.sql` (roles) | 08 "Database isolation" (roles, RLS, SET LOCAL), 07 "Transaction discipline", D-CLOCK-1 (`server_now()`), migrator lock, SQLSTATE mapping (`sqlstate.ts`) | B14 decides; B adapts | **High** |
| 4 | Cloud Storage (int64 generation, `ifGenerationMatch`, metageneration, temporary holds, soft delete, resumable sessions) | S3 (VersionId, conditional writes `If-None-Match`/`If-Match`, Object Lock legal hold, versioning + noncurrent expiration, presigned PUT / multipart) | `packages/application/src/ports/source-providers.ts:53-175` (`ObjectStoragePort`), `packages/domain/src/model/source/records.ts:130` (provider token "gcs"), `docs/design/B07-upload-source-lifecycle.md` D-HOLD-1..4, D-OBJ-2 | S053, D-HOLD-4 (release fenced by metageneration), D-OBJ-2 (soft delete/versioning read-back), 09 "Resumable session security", 09 "Soft delete, versioning and holds" | B15 adapter; B14 bucket config | **High** |
| 5 | Cloud Tasks (S055 dispatch "repeated on Cloud Tasks under G-CLOUD") | SQS standard queue + DLQ, EventBridge Scheduler for sweepers | `docs/design/B08-case-map.md:51` (S055 note), `apps/control/src/dispatcher.ts` (outbox dispatcher; no process entry yet) | S055, 10 "Idempotency contract", outbox/inbox at-least-once | B14 + B (control entry) | Medium |
| 6 | Secret Manager (mounted as files) | Secrets Manager, delivered as files to `readSecretFile` | `apps/api/src/config.ts:224` (`readSecretFile`), `*_FILE` variables, `packages/domain/src/commerce/provider.ts:44`, `packages/application/test/commerce-fakes.test.ts:81` (`secret-manager://` ref) | 08 "Secrets and supply chain" (§111-119), N7 (owner credential never in the serving env) | B14 | Medium |
| 7 | Identity Platform (Firebase ID tokens: `iss https://securetoken.google.com/<project>`, x509 cert document, `firebase.sign_in_second_factor`) | Cognito user pool (ID token `iss https://cognito-idp.<region>.amazonaws.com/<poolId>`, JWKS) | `apps/api/src/identity-verifier.ts` (whole file), `apps/api/src/config.ts:97-99,306-309`, `apps/api/src/bootstrap.ts:37,58`, `apps/api/src/composition.ts:469,511`, `packages/application/src/ports/sessions.ts:18-26`, `packages/application/src/testing/identity-issuer.ts`, `apps/web/src/client/identity/*`, `apps/web/test/security-headers.test.ts:26` (CSP `identitytoolkit`/`securetoken` origins) | D-AUTH-1..5, D-ID-2, I-AUTH-1, I-INT-3, D-EVID-1 (step-up evidence), assurance facts (second factor) | B15 + B | **High** |
| 8 | Artifact Registry | ECR (immutable tags, scan on push) | none in code (no IaC existed) | 08 "Secrets and supply chain" (provenance/SBOM) | B14 | Low |
| 9 | Workload Identity Federation | IAM OIDC provider for GitHub (`token.actions.githubusercontent.com`), roles per workload | none in code; `packages/application/src/commerce/ports.ts:234` and `.../testing/evidence-and-services.ts:11` ("Google OIDC verifier" for internal command auth) | S073, 08 §111-119 (separate build/deploy/runtime identities), 10 "Internal command authentication" | B14 + B15 | Medium |
| 10 | Vertex AI Model Garden | Amazon Bedrock (Claude Sonnet 5.5 / Opus 5.5) | IC ports (`packages/application/src/ports/core-ports.ts:345` `ModelTaskJournalPort`, model dispatch); no Vertex client in code | A9 §4 (B04 grants ≤ USD 40 / 120), S074 (IC regional endpoint route), R2-075 | B15 (adapter) + B14 (network, IAM, logging off) | Medium |
| 11 | Cloud Logging / Monitoring / Billing budgets | CloudWatch Logs (retention), alarms, AWS Budgets | none in code | R2-075 (alerts are observability, not the cap), 08 (no secrets in logs) | B14 | Low |
| 12 | Serverless VPC access / Cloud SQL connector / Private Google Access (free egress to Google APIs) | No free equivalent for most AWS APIs inside a VPC: S3 (and DynamoDB) have **gateway** endpoints (free); everything else needs NAT or **interface** endpoints (fixed cost) | implicit in every adapter that calls a provider from a DB-attached process | S074 (separate permitted routes), A9 "no NAT / no interface endpoints unless justified" | B14 | **High** (§4) |

## 2. Per-concern delta

### 2.1 Cloud Run → Lambda + API Gateway + WAF (`apps/api`)

What the code assumes today:

- A long-lived Node HTTP server (`apps/api/src/main.ts`, `server.ts`) that `listen`s, serves many concurrent requests per
  process, and drains on SIGTERM within `KAURO_SHUTDOWN_DEADLINE_MS` (default 8 000, ceiling 9 000 —
  `config.ts:139`), because "Cloud Run sends SIGKILL ten seconds after SIGTERM" (`config.ts:136`, review R35).
- "07 Connection budget: the API runs at most two instances with four connections each (R43)" — `API_POOL_CEILING = 4`,
  `ASSURANCE_POOL_CEILING = 2` (`config.ts:130-133`).
- A process-local admission limiter keyed by HMAC of the client network (E-ADDR-1, I-ADM-1) and
  `KAURO_HTTP_TRUSTED_PROXY_HOPS` = the hops of "the HTTPS load balancer in front of Cloud Run" (`server.ts:216`).
- S072 is literally about `run.app`, revision tags and forged `Host` reaching a private surface.

AWS facts and consequences:

| Topic | AWS fact (source) | Consequence for the contract |
|---|---|---|
| Shutdown | Lambda's Shutdown phase lasts 0 ms with no extension, 500 ms with an internal extension, 2 000 ms with one or more external extensions; then SIGKILL. A crashed/timed-out invoke "resets" the environment like a Shutdown. (https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html, retrieved 2026-10-06) | The 8–9 s drain of E-OPS-2/R35 cannot exist on Lambda. Lambda never sends a second request into an environment while one runs, so there is nothing to drain *between* requests; what remains is the pool. Contract kept by: each request finishes or the invoke times out (function timeout < API Gateway timeout), and a timed-out invoke leaves an open transaction that PostgreSQL rolls back when the socket closes (see failure matrix, B14-case-map, "Lambda timeout mid unit of work"). `SHUTDOWN_DEADLINE_CEILING_MS` must accept the Lambda budget (≤ 1 500 ms with the Web Adapter extension) — **B change, §6 I-1**. |
| Concurrency model | One request per execution environment at a time (standard Lambda). (same page: Invoke phase) | A process-local admission limiter (I-ADM-1) sees one request at a time and limits nothing. The per-client limit moves to a **WAF rate-based rule** (per IP / forwarded IP) plus **reserved concurrency** as the hard ceiling; the in-process limiter stays (harmless) but is no longer the control. E-ADDR-1 is re-qualified, not dropped. |
| Connection budget (R2-073) | Each concurrent environment holds its own pool; frozen environments keep their sockets open. | Total connections = reserved concurrency × (runtime pool + assurance pool). With Lambda the pool per environment must be 1 (+1 assurance, lazily opened); the budget formula is checked at deploy time by `infra/` (deliverable 4/8) **before** rollout, which is exactly REQ-R2-073. `API_POOL_CEILING`'s meaning changes from "per instance of 2" to "per environment"; the invariant (sum ≤ budget) is what R43 protects. |
| WAF attachment | AWS WAF protects API Gateway **REST** APIs (and CloudFront, ALB, AppSync, Cognito, App Runner, Verified Access); HTTP APIs are not a WAF resource type. **VERIFY** (deliverable 4, with URL). | Choose a **regional REST API** (not HTTP API) — or CloudFront in front of an HTTP API. Cost difference goes to AWS-COST.md. |
| Ingress bypass (S072) | API Gateway exposes a default `execute-api` endpoint unless `disableExecuteApiEndpoint = true`; Lambda function URLs exist only if created. | S072 on AWS = "a request reaches the API through `*.execute-api.*.amazonaws.com`, a stage name, a function URL or a forged `Host`". Terraform disables the default endpoint, creates no function URL, gives the Lambda resource policy only `apigateway.amazonaws.com` with `SourceArn` = this API, and serves only the custom domain behind WAF. Evidence script in `infra/evidence/` (deliverable 10). |
| Limits | API Gateway REST: integration timeout 29 s default (raisable for regional REST APIs), payload 10 MB; Lambda synchronous payload 6 MB. **VERIFY** with URL (deliverable 4). | Uploads already go browser → storage directly (resumable session), so request bodies stay JSON (`REQUEST_LIMITS.jsonBytes`). Any route that needs > 29 s goes to Batch/SQS, never the API. |
| Trusted proxy hops | API Gateway → Lambda passes the client address in the event (`requestContext.identity.sourceIp`) and `X-Forwarded-For`. | With the Web Adapter, the adapter turns the event into an HTTP request; the hop count becomes "API Gateway = 1" (plus 1 if CloudFront is added). Value set by Terraform, not code. |
| HTTP server on Lambda | Two options: (a) **AWS Lambda Web Adapter** (an extension layer that runs the existing `node dist/src/main.js` and proxies events to it: no code change in `apps/api`); (b) a handler entry in `apps/api` that calls the router directly. | Recommend (a) for the first apply: keeps `server.ts` and every transport test as the single code path; costs the external-extension shutdown budget (2 s). (b) is a B decision later. Layer must be pinned by ARN+version; **VERIFY** current version (deliverable 4). |

### 2.2 Cloud Batch → AWS Batch on Fargate (worker host, `packages/data-plane`)

The worker host contract (B08 §10, D8-HOST-1) assumes: deterministic provider job identity `kauro-attempt-<attemptId>`
"for good" — a second launch answers `ALREADY_EXISTS`; ambiguous launch (`TIMEOUT_AFTER_CREATE`, `TIMEOUT_BEFORE_CREATE`) is
resolved by looking the identity up; termination of exactly one identity; VM, disk and cost reports.

| Topic | Cloud Batch | AWS Batch on Fargate | Consequence |
|---|---|---|---|
| Idempotent create by identity | Job name unique per project/region → create twice fails | `SubmitJob` `jobName` is **not** unique; **VERIFY** whether `SubmitJob` accepts an idempotency token. ECS `RunTask` documents a `clientToken`; **VERIFY**. | If neither, D8-HOST-1 is preserved by the host: look up by tag `kauro:attempt` (ListJobs filter by job name) *before* submit and *after* an ambiguous answer, fenced by the attempt lease in the DB, and the janitor terminates any second job of an identity (D8-JAN-1). A duplicate can exist for seconds; it cannot write (per-attempt prefix + per-attempt credentials, §2.2 S073) — design in `B14-worker-host.md`. |
| Disk | VM boot/attached disk | Fargate ephemeral storage 20 GiB default, up to 200 GiB per task **VERIFY** | Scratch budget (`AttemptScratchStore`) maps to `ephemeralStorage`; R2-072 (a new "disk" feature in Preview) maps to Lambda `/tmp` (up to 10 240 MB, page above) or ECS/Fargate volume features: recorded as alternatives, Batch retained until measured (exactly REQ-R2-072). |
| Credentials of the worker | Metadata server credentials of the VM service account | Task role credentials via the ECS credentials endpoint (`169.254.170.2`), readable by any process in the task | "Prove metadata credentials cannot bypass per-attempt storage limits" (B14 work line): the **task role gets no S3 data permission at all**; it may only call the capability broker / `sts:AssumeRole` into a per-attempt role with a session policy restricted to `attempts/<attemptId>/*` and the exact source versions. S073 "worker reads foreign objects" is then denied by IAM, not by code. |
| Network routes (S074) | Offline VM + Private Google Access; IC with the Vertex regional endpoint | Fargate task needs ECR (image), CloudWatch Logs, S3; Bedrock for IC | See §4: the offline migration worker and the IC worker get **different** subnets/security groups/roles. |
| Cost/VM reports | VM runtime | Fargate vCPU-second and GB-second billing; task metadata endpoint v4 gives start/stop | Host reports runtime × size from the task's own timestamps (the fake already models "runtime from start to end"). |

### 2.3 Cloud SQL → Aurora PostgreSQL Serverless v2 / RDS PostgreSQL 17 (`packages/persistence`)

What the persistence layer depends on (inventory of the current code, grep at `a7315df`):

- `pg` `Pool`/`Client` with a **dedicated connection per unit of work**: `BEGIN ISOLATION LEVEL …` (READ COMMITTED,
  SERIALIZABLE with bounded retries), `SET LOCAL statement_timeout`, `set_config('kauro.agency_id', $1, true)` and
  `set_config('kauro.finance_agency_id', $1, true)` for RLS, COMMIT **with the command tag checked** (`commit.command !==
  "COMMIT"` → integrity failure) — `unit-of-work.ts:426-443`, `runtime-transaction.ts:55-64`.
- The pool verifies `current_user` against the context's expected role (`unit-of-work.ts:422`) — one login per runtime group
  (`kauro_api` IN `kauro_app`, `kauro_control`, `kauro_assurance`, `kauro_validator`, `kauro_ingress`, `kauro_payment`,
  `kauro_commission`; migration `0001`).
- Transaction-scoped advisory locks: `pg_advisory_xact_lock` ×24, `_shared` ×2, `pg_try_advisory_xact_lock` ×1,
  `_shared` ×1. **Session-scoped** `pg_advisory_lock`/`pg_advisory_unlock` in the migrator only (`runner.ts:155-168`).
- `SELECT … FOR UPDATE` across repositories; `FOR UPDATE SKIP LOCKED` in `inbox-outbox.ts` and `repositories/tenancy.ts`.
- 583 `CREATE TRIGGER` statements; deferred constraints firing at COMMIT; `kauro.server_now()` (D-CLOCK-1) everywhere a
  lifecycle instant is stamped; the fault harness overrides the clock (`testing/faults/clock.ts`).
- SQLSTATE mapping by `err.code` (`sqlstate.ts`: `40001`, `40P01` → retryable `CAPACITY_UNAVAILABLE`, others typed).
- **No** `LISTEN`/`NOTIFY`, **no** `SET ROLE` (grep: zero hits).
- **No TLS options** on `Pool`/`Client` (`pool.ts:134`, `runner.ts:299`).
- Runtime passwords from plain env `KAURO_DB_PASSWORD`, `KAURO_DB_ASSURANCE_PASSWORD`; only the migrator has `_FILE`.

**Data API (preliminary finding; the contract-by-contract table with local PG17 tests is `B14-database-decision.md`, 07-oct):**

| Fact (official source, retrieved 2026-10-06) | Effect on the contracts above |
|---|---|
| Data API is an HTTPS API (`ExecuteStatement`, `BatchExecuteStatement`, `BeginTransaction`, `CommitTransaction`, `RollbackTransaction`); credentials come from a Secrets Manager secret per call. (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.html, …/data-api-operations.html) | Not the PostgreSQL wire protocol: `pg` cannot use it. Every `PoolClient` call in `packages/persistence` would need a new driver — a rewrite of the persistence layer's transport, not a configuration change. |
| `BeginTransaction` takes no isolation level; a transaction "times out if no calls use its transaction ID in three minutes" and is rolled back; max 24 h. (https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html) | SERIALIZABLE units of work would need `SET TRANSACTION ISOLATION LEVEL` as the first statement — **to be tested** in deliverable 2 (not documented either way). |
| Errors are `DatabaseErrorException` (HTTP 400) with a `message`; no SQLSTATE field is documented. `DatabaseResumingException` when a paused Serverless v2 instance is resuming. (same page) | `sqlstate.ts` classification (40001/40P01 retries, 23xxx integrity, the KA-codes of triggers) would depend on parsing message text — a weaker contract than `err.code`. |
| Default statement timeout 45 s; `continueAfterTimeout` lets the statement continue while the caller gets a timeout. (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-timeouts.html) | Ambiguous outcomes (the call times out but the statement commits) are exactly what 10 "Idempotency contract" forbids hiding; the unit of work would have to treat every Data API timeout as AMBIGUOUS. |
| Response limit 1 MiB; writer instance only; not on T instance classes; PG ≥ 14 requires `scram-sha-256`. (https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.limitations.html) | 1 MiB caps any read (exports, list pages with JSON payloads) — must be measured against current route limits. |
| Supported PG types exclude UUID arrays ("Data API doesn't support arrays of UUIDs"); `TIMESTAMPTZ` is always returned as a UTC string. (…/data-api-operations.html) | `packages/persistence/src` binds `$n::uuid[]` parameters 21 times (grep at `a7315df`): each breaks; instants come back as strings (they already are ISO strings in the domain, but parsing moves). |
| Session-level state between calls outside a transaction is not documented to persist. | The migrator's **session** advisory lock (`pg_advisory_lock` held across several transactions, `runner.ts:110-168`) cannot be expressed without a persistent session. |

Preliminary recommendation (to be confirmed with tests on 07-oct): **keep `pg` over the wire protocol** — Aurora
PostgreSQL Serverless v2 (to keep the scale-to-zero option) or RDS PostgreSQL 17 — and **not** Data API for the
application. Data API may still be used *only* by out-of-band tooling (evidence scripts, query editor). This forces Lambdas
that touch the database into the VPC, which is the network tension of §4.

Other database deltas regardless of the engine:

- **TLS**: RDS/Aurora PostgreSQL may require SSL (`rds.force_ssl`); **VERIFY** the default for PG 17 / Aurora PG 17. The
  `pg` pool and the migrator `Client` pass no `ssl` option today → request to B (§6 I-2): `ssl: { ca: <RDS CA bundle>,
  rejectUnauthorized: true }` behind config, with the CA bundle baked in the image (no runtime download).
- **Credentials as files**: add `KAURO_DB_PASSWORD_FILE` and `KAURO_DB_ASSURANCE_PASSWORD_FILE` (§6 I-3), refusing the plain
  variables outside LOCAL, as the migrator already does. IAM database authentication (15-minute tokens) is an alternative
  considered in deliverable 5; it needs `rds-db:connect` and a token refresher, and it does not remove the need for the
  migrator's owner credential.
- **Roles**: the master user on RDS/Aurora is a member of `rds_superuser`, not a superuser; migration `0001` creates roles
  with `NOLOGIN … NOBYPASSRLS`, which `rds_superuser` can do. The migrator's own check (`runner.ts:313`, refuses
  `rolsuper`/`rolbypassrls`) holds as long as the migrator login is **not** the master user. Terraform creates the master
  user, stores it in Secrets Manager and uses it only for the bootstrap of the owner role (deliverable 4/5).
- **Pause/resume (Aurora Serverless v2 at 0 ACU)**: the first connection after a pause waits for resume. Connect timeouts
  (`KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS`, pool connect timeout) and the readiness probe must tolerate it; whether the API
  answers `503 CAPACITY_UNAVAILABLE` (retryable) during resume is a behaviour to qualify (failure matrix row "Aurora
  pause/resume").
- **`server_now()`**: a SQL function on the database clock; unaffected by the engine choice (D-CLOCK-1 holds as long as one
  writer exists, which is true for both).
- **RDS Proxy**: not proposed — fixed cost, and its connection pinning on session state would fight `set_config` and
  advisory locks. Recorded as rejected alternative in deliverable 2.

### 2.4 Cloud Storage → S3 (`ObjectStoragePort`, B07/B15)

`ObjectStoragePort` (`packages/application/src/ports/source-providers.ts:115-175`) is written in Cloud Storage terms. Method
by method:

| Port member | GCS semantics assumed | S3 mapping | Contract gap |
|---|---|---|---|
| `generation: string` ("Cloud Storage int64 as a decimal string", `:53`) | immutable, increasing, exists without versioning | `VersionId` (opaque string; exists only with versioning **enabled**; `null` otherwise) | Port comment and any ordering assumption on generations must go; S3 requires versioning for a stable id → collides with 09 (below). |
| `createResumableSession` with no-overwrite precondition (generation 0), declared length, origin | resumable session URI, cancellable by DELETE | presigned `PUT` with `If-None-Match: *` and `Content-Length` signed, or multipart upload (> 5 GB) with `If-None-Match` on `CompleteMultipartUpload`; **VERIFY** conditional-write support for both | Session **cancellation**: a presigned URL cannot be revoked before expiry → `capabilities().sessionCancellation = "UNSUPPORTED"` (the port already allows it; D-CTRL-7 handles UNSUPPORTED); multipart *can* be aborted (`AbortMultipartUpload`) → SUPPORTED for that mode. Presign lifetime ≤ the signing credentials' lifetime: sign with a role session sized for `sessionLifetimeSeconds`. |
| `stat` / `read` / `copy` with generation preconditions | `ifGenerationMatch` | `HeadObject`/`GetObject` with `versionId`; `CopyObject` with `x-amz-copy-source …?versionId=` and `If-None-Match: *` on the destination (**VERIFY** for CopyObject) | Equivalent if versioning is on. |
| `delete(generation)` | delete exactly that generation | `DeleteObject` with `versionId` (permanent delete of that version) | Equivalent; a held version is refused (403) by Object Lock. |
| `placeHold` / `releaseHold(…, metageneration)` | temporary hold flag; metageneration increments on each patch; `ifMetagenerationMatch` fences a late release (D-HOLD-4) | Object Lock **legal hold** per version (`PutObjectLegalHold` ON/OFF); requires Object Lock enabled on the bucket (which requires versioning) | **No metageneration and no conditional on `PutObjectLegalHold`** (**VERIFY**). D-HOLD-4's provider-side fence of a late release does not exist on S3. D-HOLD-3's DB claim + `in_flight_until` (already "defense in depth") would become the only fence. **Material contract gap → B07/B15 must re-qualify D-HOLD-4; this lane does not change the design, it reports it.** |
| `readRetentionPolicy` (soft delete seconds, versioning) / `listSoftDeleted` | GCS soft delete; 09 says customer-data buckets **disable** soft delete and versioning "unless a disclosed design is approved" | S3 has no soft delete; versioning + a lifecycle rule `NoncurrentVersionExpiration` is the equivalent; `ListObjectVersions` shows noncurrent versions and delete markers | Because S3 needs versioning for stable ids and for Object Lock, the customer-data buckets need the **disclosed design** 09 allows: versioning ON, noncurrent versions expired after N days (N = the shortest value 09 allows; B14 proposes 1 day), Object Lock ON with **no default retention** (legal holds only, so lawful early deletion stays possible). `readRetentionPolicy` reports `objectVersioning: true` and `softDeleteRetentionSeconds` = the noncurrent expiration. Owner approval of the disclosed design may be needed → flagged in §5. |
| `list(prefix)` | objects + generation | `ListObjectsV2` (current) / `ListObjectVersions` | Equivalent. |
| `parseCompletionClaim` | GCS completion reference | the browser forwards `ETag` + `x-amz-version-id` of the PUT response | B15 adapter detail; CORS must expose `ETag` and `x-amz-version-id`. |
| provider token `"gcs"` (`records.ts:130`) | comment only | `"s3"` | Comment; stored tokens are values written by the adapter. |

Bucket-level (B14): Block Public Access on, SSE (SSE-S3 or SSE-KMS — cost decision in AWS-COST.md), TLS-only bucket policy,
lifecycle per object class (staging, accepted, artifacts, evidence, logs), Object Lock where R2 requires retention
(evidence/audit) — deliverable 4.

### 2.5 Cloud Tasks → SQS (+ EventBridge Scheduler)

- Today the outbox dispatcher (`apps/control/src/dispatcher.ts`, `PgOutboxDispatcher`) claims rows with `FOR UPDATE SKIP
  LOCKED` and leases; `apps/control` has **no process entry** yet (no `main.ts`). S055's evidence note says B14 "repeats
  the dispatch on Cloud Tasks under G-CLOUD".
- AWS: the dispatch target becomes an SQS standard queue (at-least-once, possible duplicates and reordering) with a DLQ
  (`maxReceiveCount`), consumed by the control Lambda (event source mapping) or polled by Batch; sweepers run from
  EventBridge Scheduler (one schedule per sweeper family). The inbox's idempotency (dedupe by message identity) already
  assumes at-least-once, so the contract holds; FIFO queues are not needed and cost more.
- Visibility timeout must exceed the control function timeout (× 6 is the AWS recommendation for event source mappings —
  **VERIFY**), so a slow consumer is not redelivered while still running; failure rows in B14-case-map.md.
- Control entry (handler for SQS batch + scheduled sweeps) is **B's** (`apps/control/**`) — §6 I-4.

### 2.6 Secret Manager → Secrets Manager

- The code already reads secrets **as files** (`readSecretFile`, `readKeyFile`; `*_FILE` variables), which is
  provider-neutral. Current `*_FILE` variables: `KAURO_API_CURSOR_KEY_FILE`, `KAURO_PUBLIC_HASH_KEY_FILE`,
  `KAURO_DB_MIGRATOR_PASSWORD_FILE`, `KAURO_AUTH_BEARER_TOKENS_FILE` (LOCAL only), `KAURO_IDENTITY_FAKE_JWKS_FILE` (LOCAL
  only). Missing: runtime DB passwords (§2.3) and every provider credential (PayPal, Alegra, Resend, Cloudflare, Wise) which
  B15 will add.
- Delivery to a file: Lambda has no secret volume mount. Options (deliverable 5 decides, with cost): (a) the *AWS
  Parameters and Secrets Lambda Extension* (local HTTP cache) + a tiny pre-start step writing `/tmp/secrets/<name>`
  (mode 0600) before `main.js` reads it; (b) Fargate: ECS `secrets` → environment variable, written to a file by the
  entrypoint, or the same pre-start fetch. Both need a network route to Secrets Manager → §4.
- `credentialRef` values use the scheme `secret-manager://` (test `commerce-fakes.test.ts:81`, domain `provider.ts:44`). It
  is a name, not a GCP API; B decides whether to keep the scheme or rename to `secretsmanager://` (cosmetic, no request).

### 2.7 Identity Platform → Cognito

The session boundary is coded against Firebase/Identity Platform token shape:

| Element | Today | Cognito ID token | Gap |
|---|---|---|---|
| Issuer | `https://securetoken.google.com/<project>` (`identity-verifier.ts:179`) | `https://cognito-idp.<region>.amazonaws.com/<userPoolId>` | Config: `KAURO_IDENTITY_PROJECT_ID` (regex of a GCP project id, `config.ts:309`) → user pool id + region + app client id. |
| Audience | `<project>` | `aud` = app client id (ID token); access token uses `client_id` + `token_use` | Verifier must check `token_use = "id"`. |
| Keys | x509 cert document from googleapis, cached by `Cache-Control` (`identity-verifier.ts:30-31,95`) | JWKS at `<issuer>/.well-known/jwks.json` | A JWKS key source already exists (`jwksResolver`, CONTRACT_FAKE); a `COGNITO_JWKS` source reuses it with a fetch + cache. |
| Second factor | `firebase.sign_in_second_factor` (`sessions.ts:26`, `identity-verifier.ts:225-227`) | Cognito ID tokens carry no documented "second factor used" claim for native user-pool sign-in; **VERIFY** (`amr` is documented for identity-pool/federated flows) | **Material**: the assurance facts (step-up, D-EVID-1) need a proof the sign-in used TOTP. Options to qualify: MFA "required" on the pool (every sign-in is 2FA — fact by configuration, recorded as such), or a Pre Token Generation trigger adding a claim (Lambda, Essentials tier+). B15/B decide; this lane reports. |
| Email verified, auth_time | `email_verified`, `auth_time` | present in Cognito ID tokens | ok |
| Browser client | Identity Platform JS SDK, `inMemoryPersistence` (B11 D-AUTH-2), CSP `connect-src` `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` | Cognito `InitiateAuth`/`RespondToAuthChallenge` (no SDK needed: `fetch` to `cognito-idp.<region>.amazonaws.com`) | CSP origin changes; `IdentityClient` port keeps its shape; new live adapter (B15). |
| Contract fake | `ContractFakeIdentityIssuer` mints Google-shaped tokens | a Cognito-shaped profile | The fake (B's) must mint the shape the live verifier checks, or SIMULATED evidence proves the wrong contract. |

Cognito tier and price (Lite/Essentials/Plus, MAU) go to AWS-COST.md.

### 2.8 Artifact Registry → ECR; 2.9 WIF → GitHub OIDC

- ECR: one repository per image (`kauro-api`, `kauro-control`, `kauro-worker-migration`, `kauro-worker-intelligence`), tag
  immutability, scan on push, lifecycle keeping N untagged; images referenced **by digest** in Lambda/Batch definitions.
- GitHub OIDC provider limited to `repo:miguellopezndev-ui/kauro-platform:ref:refs/heads/main` and
  `…:environment:production` for the deployer; pull_request runs get **no** AWS role (S073 "an external PR requests
  workload identity" → denied by the trust policy's `sub` condition). Roles per workload: api, control, batch-worker
  (migration), batch-worker (intelligence), migrator, deployer (deliverable 6).
- Internal command authentication ("Google OIDC verifier", `commerce/ports.ts:234`): on AWS the equivalent is IAM-signed
  invocation (SigV4 to an IAM-authorized API route or direct `lambda:InvokeFunction` by role) — B15 decides; recorded.

### 2.10 Vertex → Bedrock

- No Vertex client exists in code; the IC model dispatch is behind ports. A9 §4 governs: before any paid call verify region,
  in-region vs cross-region inference profile, data residency, invocation logging **off**, quotas and prices.
- B14 provides: an IAM policy allowing `bedrock:InvokeModel` only on the approved model/profile ARNs for the intelligence
  worker role; no model invocation logging configuration (default off — **VERIFY**); the network route (§4).

### 2.11 Cloud Logging/Billing → CloudWatch + Budgets

- Log groups with explicit retention per workload; no secret values in logs (already a code rule: errors by class and
  variable name).
- AWS Budgets alerts are **observability only** (R2-075): the hard caps stay in the application (reservations, job limits,
  B04 grants) and in AWS limits we control (reserved concurrency, Batch compute environment max vCPU, Aurora max ACU).

## 3. Things that do not change

Provider-independent and kept as is: cores (MC, IC), domain, contracts registry, RLS policies, triggers, migrations,
outbox/inbox, leases and fences, `server_now()`, idempotency journals, the fault harness, the contract fakes' role
(SIMULATED, never EXECUTED_PROVIDER), Cloudflare, Resend, Google Workspace (mail), PayPal/Wise/Alegra integrations (A8).

## 4. The network tension (input to deliverable 2)

`pg` over the wire means the database is in a VPC and every process that talks to it is in that VPC. A9 forbids NAT
gateways and interface endpoints unless a contract requires them. Inside a VPC without NAT, a Lambda/Fargate task reaches
**only** S3 (and DynamoDB) through free gateway endpoints. Everything else the processes call — Secrets Manager, SQS,
Cognito JWKS, Bedrock, ECR (image pull for Fargate), CloudWatch Logs (Fargate `awslogs`), STS, and the external providers
(PayPal, Wise, Alegra, Resend) — needs a route.

Options to compare in `B14-database-decision.md` (cost and security, then choose):

1. **Split by function**: DB-touching code in VPC (private subnets, no egress except S3 gateway endpoint and the DB);
   provider-calling code outside the VPC; the two talk through SQS/the outbox. Requires secrets for DB-touching Lambdas to
   arrive without a Secrets Manager call at runtime (see 2), and B to split adapters that today run in the same process.
2. **Secrets delivered at init without network**: not possible for Secrets Manager inside a no-egress VPC; Lambda
   environment variables encrypted with a customer KMS key are readable via `GetFunctionConfiguration` and land in
   Terraform state — rejected unless justified.
3. **Interface endpoints, justified**: Secrets Manager, SQS, STS, Logs, ECR (api + dkr) at ~USD 7–8/month per endpoint per
   AZ (**VERIFY** price) — a fixed cost A9 allows only with written justification (08 §111-119 "no long-lived keys" and
   S074 "separate permitted routes" are candidate justifications).
4. **Fargate tasks in public subnets with a public IPv4 and an egress-only security group**: free of NAT, but the public
   IPv4 address is billed per hour while the task runs (**VERIFY** price), and egress is not restricted by hostname.
5. **IPv6 egress-only internet gateway** (free) for dual-stack Lambda/Fargate: works only for destinations with IPv6
   endpoints; **VERIFY** per service and per provider — likely partial.
6. **Data API from Lambdas outside the VPC**: removes the tension but fails the persistence contracts (§2.3).

The S074 split is natural on AWS: the **offline migration worker** gets a subnet with only the S3 gateway endpoint (plus the
minimum to pull its image and ship logs), and the **IC worker** gets the Bedrock route; the evidence script proves each
route is the only one (deliverable 10).

## 5. Open items and who closes them

| Id | Item | Closes | Date |
|---|---|---|---|
| Q-AWS-1 | Data API vs `pg` contract-by-contract with local PG17 tests | B14 (`B14-database-decision.md`) | 07-oct |
| Q-AWS-2 | Network route choice (§4) with cost | B14 (`B14-database-decision.md`, `AWS-COST.md`) | 07/10-oct |
| Q-AWS-3 | D-HOLD-4 has no provider fence on S3 (no metageneration, no conditional legal hold) | B07/B15 re-qualify; B14 reports | B |
| Q-AWS-4 | 09 disclosed design for versioning + noncurrent expiration + Object Lock (no default retention) on customer-data buckets | B14 proposes in Terraform docs; owner approval if 09 requires it | 08-oct |
| Q-AWS-5 | Cognito second-factor proof for assurance facts | B15/B | B |
| Q-AWS-6 | Idempotent create by identity on AWS Batch / ECS RunTask (`clientToken`) | B14 (`B14-worker-host.md`) | 09-oct |
| Q-AWS-7 | Lambda shutdown budget vs `SHUTDOWN_DEADLINE_CEILING_MS`; Web Adapter vs handler | B (I-1) | B |
| Q-AWS-8 | `rds.force_ssl` defaults and CA bundle; `pg` TLS options | B14 verifies; B implements (I-2) | 07-oct |
| Q-AWS-9 | WAF on REST API vs HTTP API + CloudFront (cost) | B14 (`AWS-COST.md`) | 10-oct |

## 6. Integration that B14 requests from B (no code touched by this lane)

Exact diffs come with the deliverable that needs each one (rule 2); this is the list so B can schedule them.

- **I-1** `apps/api/src/config.ts` — allow a Lambda profile of the shutdown deadline (ceiling ≤ 1 500 ms when
  `KAURO_RUNTIME=LAMBDA`), and document that on Lambda the drain is per request. Test `operability.test.ts:223` keeps the
  Cloud-Run-era assertion only for the container profile.
- **I-2** `packages/persistence/src/pool.ts:134`, `packages/persistence/src/migrations/runner.ts:299` — `ssl` option from
  config (`KAURO_DB_TLS_CA_FILE`, `rejectUnauthorized: true`), required outside LOCAL.
- **I-3** `apps/api/src/config.ts` — `KAURO_DB_PASSWORD_FILE`, `KAURO_DB_ASSURANCE_PASSWORD_FILE`; the plain variables
  refused outside LOCAL (same rule as N7 for the migrator).
- **I-4** `apps/control` — a process entry for (a) SQS batch events and (b) scheduled sweeps, each bounded below the function
  timeout.
- **I-5** identity: Cognito key source and claim profile in `identity-verifier.ts`, `config.ts`, the contract fake, the web
  `IdentityClient` adapter and CSP origins (B15 scope).
- **I-6** `ObjectStoragePort` doc comments that say "Cloud Storage int64" and the hold/metageneration contract (B07/B15 scope,
  after Q-AWS-3).
