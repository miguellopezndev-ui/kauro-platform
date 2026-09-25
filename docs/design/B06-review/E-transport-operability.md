# B06 review — fixer E: transport and operability

Branch `b06/fix-e` from `b06/integration` at `e435a9a`. Findings R28, R33–R47 of the five-lens review
(`.claude/b06-review/group-e.json`; none of them is a duplicate, and none is the original of a duplicate). Every section names
the outcome, the decision, the authority it rests on (the section of the R2 authority manuals, read for this record),
the regression test that fails without the fix, what it answered without the fix, and the files changed. The design record
(`docs/design/B06-domain-db-authz.md`) and the case map are left to the integrator; this file is what they fold in (the last
sections list where).

All sixteen findings are FIXED; none is DEFERRED or NOT_A_DEFECT.

| id | outcome | regression tests (file :: test) |
|---|---|---|
| R28 | FIXED | `apps/api/test/transport.test.ts` :: "R28: …"; `packages/application/test/admission.test.ts` :: "R28: …" |
| R45 | FIXED | `apps/api/test/transport.test.ts` :: "R45: …" |
| R34 | FIXED | `apps/api/test/operability.test.ts` :: "R34: …"; `apps/api/test/transport.test.ts` :: "R34: …" |
| R33 | FIXED | `packages/persistence/test/migration-runner.test.ts` :: "R33: …" |
| R35 | FIXED | `apps/api/test/operability.test.ts` :: "R35: shutdown drains …", "R35: the shutdown deadline is kept …" |
| R36 | FIXED | `apps/api/test/operability.test.ts` :: "R36: …" |
| R37 | FIXED | `packages/persistence/test/migration-runner.test.ts` :: "R37: …"; `apps/api/test/operability.test.ts` :: "R37: …" |
| R38 | FIXED | `packages/persistence/test/pool-diagnostics.test.ts` :: both "R38: …"; `apps/api/test/operability.test.ts` :: "R42 and R38: …" |
| R39 | FIXED | `apps/api/test/transport.test.ts` :: "R39: …" |
| R40 | FIXED | `apps/api/test/transport.test.ts` :: "R40: …"; `packages/application/test/admission.test.ts` :: "R40: …" |
| R41 | FIXED | `apps/api/test/transport.test.ts` :: "R41: …"; `packages/application/test/admission.test.ts` :: "the header-only head …" |
| R42 | FIXED | `packages/persistence/test/schema-readiness.test.ts` :: "R42: …"; `apps/api/test/operability.test.ts` :: "R42 and R38: …" |
| R43 | FIXED | `apps/api/test/operability.test.ts` :: "configuration of the operating limits …"; `apps/api/test/composition.test.ts` :: "configuration: …" |
| R44 | FIXED | `apps/api/test/operability.test.ts` :: "R44: …", "configuration of the operating limits …" |
| R46 | FIXED | `packages/persistence/test/package-surface.test.ts` :: "R46: …"; `tools/test/architecture-gate.test.mjs` :: "a test-only subpath …" |
| R47 | FIXED | `packages/persistence/test/package-surface.test.ts` :: "R47: …"; the same gate test; `tools/clean-consume.mjs` (verify) |

## Method

Every regression test runs against real PostgreSQL 17 clusters the test starts (`@kauro/persistence/testing`), through the
real routes and composition root where the finding is at the HTTP boundary (`assembleApi` over the fixture's world, or
`bootstrap()` from an environment over a real socket, the path `main.ts` takes). Waits are bounded and fail loudly
(`within(...)`, `waitForLockWait`); interleavings are fixed by a lock held from a superuser session and observed in
`pg_stat_activity` (the in-flight command of R35, the waiting runners of R33), never by a sleep.

The proof that each test fails without its fix was run mechanically on the committed branch: a mutation removed exactly one
fix (the edit named under "Without the fix"), the touched packages were rebuilt, the named tests were run, and the files were
restored from git and rebuilt. Twenty-seven mutations, every one compiled, every named test failed; the observed failure is
quoted. Then the full `pnpm run verify` ran green on the restored branch.

## Decisions register (for design §12 folding)

| id | decision | authority |
|---|---|---|
| E-CORR-1 (supersedes I-INT-4, amends I-INT-5) | The correlation id is resolved once per request, as the Fastify request id (`genReqId`): the client's `X-Correlation-Id` is adopted when it is an `id` (lowercase RFC 9562 UUID); any other value — a proxy's request id, an uppercase UUID, a token with control characters — is ignored, never refused and never echoed, and the server mints a UUIDv7 exactly as for an absent header. The request log labels it `correlationId` (Fastify's `reqId` counter is gone); the answer header (on every answer, probes and 404s included), the problem body, the diagnostics lines, the journal entry, the events and the security events carry the same value; an answer written below HTTP (parser error, request timeout) logs its minted id. Reason `CORRELATION_ID_INVALID` is withdrawn; `admitHeaders`/`admitStructure` no longer judge the header, they carry the transport's id. | 10 "Request envelope" ("Every request receives an opaque correlation ID"); 07 "Command outcomes and error taxonomy" ("An unexpected exception is recorded with an opaque correlation ID and safe technical classification"); reference/FIELD_CONTRACTS DomainEvent `correlationId | id | Safe operation trace`. |
| E-ADDR-1 | The client address reaches the admission limiter as HMAC-SHA256 (per-process random key; the limiter is process-local, I-ADM-1) of its network: IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 as its /64. The address is the socket peer, or the one `KAURO_HTTP_TRUSTED_PROXY_HOPS` trusted proxy hops report in `X-Forwarded-For` (0 in LOCAL by default; required outside LOCAL, 0..4). `RawRequest` → `StructuralAdmission` → `CommandEnvelope.clientAddressHash`; CMD001 passes it to `AbuseLimiter.admit`. The address itself never enters the application layer and is never persisted. | 08 "Abuse controls" ("Rate limiting combines IP, verified identity, agency and operation"); 14 "Initial architecture" (the external HTTPS load balancer in front of Cloud Run); design 12b I-ADM-1 (twenty creations per address per hour). |
| E-HTTP-1 | Framing reasons at the boundary: `HEADER_REPEATED` (a single-valued envelope header — Authorization, Content-Type, Idempotency-Key, X-Correlation-Id, X-Kauro-Agency — sent more than once; the first check of the admission order), `REQUEST_MALFORMED` (undecodable request target, HTTP parser error, body length not the declared Content-Length), `REQUEST_TIMEOUT` (the request did not arrive completely within the request timeout); an over-long path parameter is `PATH_ID_INVALID`. All are 400 INVALID_REQUEST problems — like I-ERR-1's BODY_TOO_LARGE, to stay inside the closed status table (no 408/414/431). Bodies reach admission as bytes and are decoded as strict UTF-8 (`TextDecoder` fatal, byte order mark kept so the strict parser refuses it): an invalid sequence is `JSON_SYNTAX`. | 10 "Request envelope" ("The server validates content type, byte size, JSON syntax, duplicate keys … A reverse proxy's limit is not the only guard"); 10 "Responses and safe errors" (the problem shape; no raw values); RFC 8259 §8.1 (JSON exchanged between systems is UTF-8). |
| E-OPS-1 | Deadlines and budgets from the environment: `KAURO_HTTP_REQUEST_TIMEOUT_MS` (30 000; 1 000..300 000), `KAURO_HTTP_CONNECTION_TIMEOUT_MS` (60 000; 1 000..600 000), `KAURO_SHUTDOWN_DEADLINE_MS` (8 000; 100..9 000), `KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS` (5 000), `KAURO_DB_MIGRATOR_STATEMENT_TIMEOUT_MS` (120 000), `KAURO_DB_MIGRATOR_LOCK_TIMEOUT_MS` (5 000). `KAURO_DB_POOL_MAX` is 1..4 for the api (`API_POOL_CEILING`); the pool's own 1..24 stays the application-wide ceiling for other entrypoints. | 07 "Connection budget and operating limits" ("API at most two instances with four connections each"); 07 "Restoration and migration" ("Lock timeouts and rollback limits are explicit"); 14 "Deployment and rollback" (explicit environment configuration). |
| E-OPS-2 | Shutdown drains within a deadline below the platform's grace period: from `preClose` on, every answer carries `Connection: close` (Node closes each connection after its answer, so `server.close()` completes with the in-flight work instead of the 72 s keep-alive), a request completed on a still-open connection is a 503 CAPACITY_UNAVAILABLE problem (RETRY_SAME_KEY), `/readyz` reports DRAINING without touching the database; `bootstrap().shutdown()` gives up at `KAURO_SHUTDOWN_DEADLINE_MS`, closes the remaining connections and reports DEADLINE_EXCEEDED, and `main.ts` exits 1 — an open transaction ends with the process and its client retries with the same key. The 9 s ceiling: 14 "Initial architecture" puts the API on Cloud Run, whose container contract (platform documentation, not manual text) sends SIGKILL ten seconds after SIGTERM. | 14 "Initial architecture"; 14 "Monitoring and service health"; 14 "Deployment and rollback"; 10 "Idempotency contract" ("A response lost after commit is recovered by the same key"). |
| E-OPS-3 | Diagnostics: the pool hands every idle-connection error to `PoolConfig.onError` as {pool, error class, SQLSTATE or errno}; the composition root reports the underlying cause of every CAPACITY_UNAVAILABLE outcome (`reportingUnavailability`) and of every NOT_READY probe by correlation id; the defaults are one stderr line of safe tokens (`classifyError`: constructor name and code, never the message, a host, a role or a value). The answers themselves do not change. | 14 "Monitoring and service health" ("A database outage is visible without exposing credentials"); 07 "Command outcomes and error taxonomy" (resource saturation is distinct); 08 "Audit events and retention" (no credentials). |
| E-OPS-4 | `GET /livez` (the process alone) and `GET /readyz` outside `/api/v1`, no credential, no customer row. Readiness reads `kauro_meta.schema_migrations` over a verified runtime connection (read-only transaction, 2 s statement bound) and compares it with `listMigrations()` by version and checksum: COMPATIBLE (a newer version beyond the shipped set is tolerated: expand-only), DRIFTED, BEHIND → 503. Migration 0001 grants the runtime roles USAGE on `kauro_meta` and SELECT on the ledger, nothing more. `HEALTH_ROUTES` (operationId, method, path, summary, authority, replies with their closed schemas — the shape of fixer d's `OperationalRoute`), `LIVENESS_RESPONSE_SCHEMA` and `READINESS_RESPONSE_SCHEMA` are exported. | 14 "Monitoring and service health" ("Liveness checks process health … Readiness checks the minimum dependencies and schema compatibility needed for the service's role"); 14 "Deployment and rollback" ("verifies schema compatibility, readiness and effective digest, then shifts traffic"); 07 "Restoration and migration" (expand, compatible backfill, later contract; checksums and applied versions recorded). |
| E-MIG-1 | Migration runners serialize on a database-scoped session advisory lock (`MIGRATION_RUNNER_LOCK`, the two keys `KAUR`/`MIGR`), taken before the bootstrap DDL; the ledger is created and read under it; each pending file still runs in its own transaction; every runner statement runs with local `lock_timeout` and `statement_timeout`; the wait for a peer's lock is bounded by the statement timeout; the migrator connection has a connect timeout. | 07 "Restoration and migration" (checksums and applied versions; explicit lock timeouts); 07 "Connection budget and operating limits" (two API instances, each may migrate on start). |
| E-SEC-1 | The migrator password is consumed at start: `bootstrap` reads `KAURO_DB_MIGRATOR_PASSWORD`, deletes it from the environment object it was given (`process.env` from `main.ts`) before anything else runs and hands it to the migration connection only; `ApiConfig.migrateOnStart` has no password field; the variable without `KAURO_DB_MIGRATE_ON_START=true` refuses the start. The reviewer's stronger alternative, a one-shot migration job, is not added: this branch has no migrate-only entry point, and the guarantee it gives is that a serving process keeps no owner credential after start and one that does not migrate never receives it. | 07 "Restoration and migration" ("Migration roles are separate from runtime"); 08 "Database isolation" ("privileged migration roles are never used by request handlers"); 08 "Secrets and supply chain"; 14 "Identity matrix". |
| E-PKG-1 | The test helpers are the export subpath `@kauro/persistence/testing`; the architecture gate refuses an import of a `testOnlySubpaths` entry from production source and a declared workspace dependency no file imports; `@types/pg` is a pinned runtime dependency of persistence (its public declarations name pg's Pool, PoolClient and Client); clean-consume type-checks every typed public entry point of the tarballs with `skipLibCheck: false`, with the workspace's pinned pnpm. | 07 "Platform topology" (architecture checks; a directory has real responsibility); 08 "Secrets and supply chain" ("Dependencies are pinned"); S045 "Install, build and consume packages through declared dependencies". |

## R28 — a non-UUID client correlation id rejected the whole command

- **Outcome:** FIXED.
- **Decision:** E-CORR-1. Manual 10 says every request *receives* an opaque correlation id; nothing in manuals 07, 08 or 10
  lets a client trace header refuse a command. The value is not adopted (the journal, events and security events store the
  registry `id` type) and never echoed (log injection); the server mints a UUIDv7. `correlationIdOf(headers, ids)` returns
  the id and is called once, by the transport.
- **Authority:** 10 "Request envelope"; reference/FIELD_CONTRACTS DomainEvent `correlationId`.
- **Regression tests:** `apps/api/test/transport.test.ts` :: "R28: a client correlation id that is not an id never refuses
  the command — the server mints a UUIDv7, answers and records the command under it, and never echoes the client value";
  `packages/application/test/admission.test.ts` :: "R28: a malformed client correlation id is never refused and never
  adopted — the server mints its own; a well-formed one is adopted; a missing one is minted". The existing assertion in
  `apps/api/test/request-validation.test.ts` :: "the correlation id is echoed when supplied, generated otherwise, and present
  on every problem; unknown routes and methods are NOT_FOUND problems" follows (a malformed id now reaches the handler:
  429 DRAFT_AGENCY_EXISTS under a minted id).
- **Without the fix** (the refusal restored in the header head of admission): `expected 201, got 400: {… "code":"INVALID_REQUEST" …}`
  for `x-correlation-id: req-7f3a-proxy`; the admission test answers `PROBLEM` where `ADMITTED` is expected.
- **Files:** `packages/application/src/api/admission.ts`, `packages/application/src/api/envelope.ts`,
  `packages/application/src/index.ts`, `packages/domain/src/model/errors.ts` (reason withdrawn), `apps/api/src/server.ts`.

## R45 — the request log's reqId was Fastify's counter, not the correlation id

- **Outcome:** FIXED.
- **Decision:** E-CORR-1: `genReqId` resolves the correlation id and is the request id; `requestIdHeader: false`;
  `LogController({ requestIdLogLabel: "correlationId" })`. Every problem, the global `onSend` header, the handler envelope and
  every sink use `request.id`. Below HTTP there is no request object: the `clientErrorHandler` logs the id it minted with the
  parser's code (a token, never the raw bytes) before writing the problem.
- **Authority:** 07 "Command outcomes and error taxonomy"; 14 "Monitoring and service health".
- **Regression test:** `apps/api/test/transport.test.ts` :: "R45: the request log's id is the correlation id — supplied or
  minted, every log line of a request carries the id its answer names, the internal-error sink uses the same id, and an
  answer below HTTP is logged under its id too".
- **Without the fix:** with the log label reverted to Fastify's default, "the request 01a0d965-… is found in the log by its
  correlation id" fails (`actual: false`); with the below-HTTP log line removed, "the answer below HTTP is found in the log by
  its correlation id" fails.
- **Files:** `apps/api/src/server.ts`.

## R34 — the per-address creation limit was never applied by the running api

- **Outcome:** FIXED.
- **Decision:** E-ADDR-1. The transport computes the keyed hash of `request.ip`'s network; the envelope carries it
  (`clientAddressHash`, `null` only for a caller without a transport address); `create-agency.ts` passes it to the limiter, so
  the address window of I-ADM-1 is live. The proxy trust is `hop < KAURO_HTTP_TRUSTED_PROXY_HOPS`: with 0 a client-written
  `X-Forwarded-For` changes nothing; with 1 the address the proxy appended is the client and a spoofed entry in front of it is
  ignored.
- **Authority:** 08 "Abuse controls"; 14 "Initial architecture"; design 12b I-ADM-1.
- **Regression tests:** `apps/api/test/operability.test.ts` :: "R34: one client address cannot rotate identities past the
  per-address creation window of the running api — twenty verified identities are admitted, the next is 429
  CREATION_RATE_LIMITED, and a forged X-Forwarded-For moves nothing when no proxy hop is trusted" (`bootstrap()` from a LOCAL
  environment, a real socket, N+1 = 21 distinct verified identities from 127.0.0.1); `apps/api/test/transport.test.ts` ::
  "R34: the client address reaches the creation limiter as a keyed hash of its network — through exactly the configured proxy
  hops; N+1 identities from one client are limited, another client is not, and a forged X-Forwarded-For moves nothing when no
  hop is trusted".
- **Without the fix** (the handler admits without the hash): the 21st identity from one address answers 201 — "the
  twenty-first identity from one client address is limited" (`actual: 201, expected: 429`) in the transport test, and
  `actual: 201, expected: 429` over the real socket in the operability test.
- **Files:** `packages/application/src/commands/handlers/create-agency.ts`, `packages/application/src/api/envelope.ts`,
  `packages/application/src/api/admission.ts`, `apps/api/src/server.ts`, `apps/api/src/config.ts`,
  `apps/api/src/composition.ts`.

## R33 — concurrent migrate-on-start was not serialized

- **Outcome:** FIXED.
- **Decision:** E-MIG-1 (the reviewer's first option; per-file transactions stay the runner's contract). A failed release after
  a failed run reports both (`AggregateError`); a release that finds the lock not held is an error.
- **Authority:** 07 "Restoration and migration"; 07 "Connection budget and operating limits".
- **Regression test:** `packages/persistence/test/migration-runner.test.ts` :: "R33: two runners started at once on a fresh
  database serialize on the runner lock — both succeed, one applies every migration, the other re-reads the ledger under the
  lock and skips them" (three unscripted runners on a fresh database; then two runners observed waiting on a runner lock held
  by a third session, released, both succeed).
- **Without the fix** (the lock and unlock statements neutralized): `[ [7, 0], 'rejected: duplicate key value violates unique
  constraint "pg_namespace_nspname_index"', 'rejected: migration 0003_capabilities_clients_projects.sql failed: relation
  "capabilities" already exists' ]` — the reviewer's failure exactly.
- **Files:** `packages/persistence/src/migrations/runner.ts`, `packages/persistence/src/index.ts`.

## R35 — graceful shutdown waited for the keep-alive timeout, with no deadline

- **Outcome:** FIXED.
- **Decision:** E-OPS-2.
- **Authority:** 14 "Initial architecture"; 14 "Monitoring and service health"; 10 "Idempotency contract".
- **Regression tests:** `apps/api/test/operability.test.ts` :: "R35: shutdown drains — the in-flight command is answered with
  Connection: close, a request completed on an open connection meanwhile is a 503 problem, readiness reports DRAINING, and
  close() ends with the in-flight work instead of waiting for keep-alive sockets"; :: "R35: the shutdown deadline is kept — a
  command blocked past it has its connection closed and shutdown() returns DEADLINE_EXCEEDED; the close completes once the
  database lets the command go". The in-flight command is held by `LOCK TABLE kauro.agencies` from a superuser session and
  observed waiting in `pg_stat_activity`.
- **Without the fix:** without `Connection: close` while draining, the in-flight answer keeps its connection alive
  (`actual: 'keep-alive', expected: 'close'`); without the deadline, `shutdown()` resolves only when the blocked statement hits
  the runtime statement timeout (10 s, past Cloud Run's grace) and answers `CLOSED` where `DEADLINE_EXCEEDED` at 300 ms is
  expected.
- **Files:** `apps/api/src/server.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/main.ts`, `apps/api/src/config.ts`,
  `apps/api/src/health.ts`.

## R36 — no request or connection timeout

- **Outcome:** FIXED.
- **Decision:** E-OPS-1. Fastify `requestTimeout` and `connectionTimeout` from the configuration; Node's
  `connectionsCheckingInterval` is `min(1 s, requestTimeout)` (its 30 s default would let a short deadline slip by up to
  30 s) and `headersTimeout` `min(60 s, requestTimeout)`. A timed-out request is answered on the socket with a 400
  REQUEST_TIMEOUT problem and closed; the aborted body stream that then reaches the error handler is logged at info under its
  correlation id, not reported as an internal error.
- **Authority:** 10 "Request envelope" ("A reverse proxy's limit is not the only guard").
- **Regression test:** `apps/api/test/operability.test.ts` :: "R36: a request that stalls is not held forever — past the
  request timeout it is answered REQUEST_TIMEOUT and closed; a silent socket is closed past the connection timeout".
- **Without the fix:** the running server's `requestTimeout` is 0 (`actual: 0, expected: 1000`), the reviewer's observation.
- **Files:** `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/composition.ts`.

## R37 — the migrator connection had no connect timeout

- **Outcome:** FIXED.
- **Decision:** E-MIG-1 and E-OPS-1: `applyMigrationsAs` sets `connectionTimeoutMillis` (the whole start-up to
  ReadyForQuery) and session `statement_timeout` / `lock_timeout`; every runner transaction sets both locally, the bootstrap
  and the ledger read included. The api reads the three limits from the environment when migrating on start.
- **Authority:** 07 "Restoration and migration".
- **Regression tests:** `packages/persistence/test/migration-runner.test.ts` :: "R37: the migrator is bounded — a host that
  accepts and never answers refuses within the connect timeout, and a lock held on the ledger refuses within the lock timeout
  instead of hanging the start"; `apps/api/test/operability.test.ts` :: "R37: with migrations on start, a database host that
  accepts and never answers refuses the start within the migrator's connect timeout".
- **Without the fix:** without the connect timeout, "migrator connecting to a silent host: still pending after 10000 ms"; with
  the api not passing `KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS`, "refused after 5012 ms" (the runner's default) where the
  configured 300 ms must bound it.
- **Files:** `packages/persistence/src/migrations/runner.ts`, `apps/api/src/config.ts`, `apps/api/src/composition.ts`.

## R38 — pool errors were discarded; an outage left no trace

- **Outcome:** FIXED.
- **Decision:** E-OPS-3.
- **Authority:** 14 "Monitoring and service health"; 07 "Command outcomes and error taxonomy".
- **Regression tests:** `packages/persistence/test/pool-diagnostics.test.ts` :: "R38: an idle connection the server
  terminates reaches the pool's error sink as pool name, class and SQLSTATE — never the message or a connection parameter";
  :: "R38: without a configured sink the classification is written to stderr, one line, and nothing is swallowed";
  `apps/api/test/operability.test.ts` :: "R42 and R38: …" (the cluster is stopped under a running api: the pool sink, the
  unavailable sink under the 503's correlation id with the underlying pg error — not the translated DomainFailure — and the
  not-ready sink; no password, role or port in any of it).
- **Without the fix:** with the pool's error listener discarding again, "the pool error sink: still pending after 10000 ms"
  and "the default pool error line: still pending after 10000 ms"; without `reportingUnavailability`, the unavailable sink is
  empty (`actual: [], expected: ['01a0d968-…']`).
- **Files:** `packages/persistence/src/pool.ts`, `packages/persistence/src/index.ts`, `apps/api/src/composition.ts`,
  `apps/api/src/bootstrap.ts`.

## R39 — Fastify framework errors bypassed the problem contract

- **Outcome:** FIXED.
- **Decision:** E-HTTP-1. `frameworkErrors` routes FST_ERR_BAD_URL (REQUEST_MALFORMED: routing never happened, so no path
  segment is named) and FST_ERR_MAX_PARAM_LENGTH (PATH_ID_INVALID) through the same translation as the error handler;
  `clientErrorHandler` writes a problem (REQUEST_MALFORMED / REQUEST_TIMEOUT, minted correlation id, `Connection: close`) for
  errors below HTTP. An unknown framework error is INTERNAL_ERROR through the sink.
- **Authority:** 10 "Responses and safe errors".
- **Regression test:** `apps/api/test/transport.test.ts` :: "R39: framework errors are problems — an undecodable URL is
  REQUEST_MALFORMED, an over-long path parameter PATH_ID_INVALID, an unreadable request line REQUEST_MALFORMED; each with a
  correlation id and nothing echoed".
- **Without the fix:** without `frameworkErrors`, `POST /api/v1/clients/%zz/archive` answers Fastify's own JSON, which the
  Problem schema refuses ("not a Problem: … {"field":"error","code":"UNKNOWN_FIELD"} …"); with Fastify's default client-error
  answer in place of the `clientErrorHandler`, the unreadable header line is answered `application/json` (`actual:
  'application/json', expected: /^application\/problem\+json/`).
- **Files:** `apps/api/src/server.ts`, `packages/domain/src/model/errors.ts` (reasons added).

## R40 — invalid UTF-8 was replaced and persisted (chunked) or refused under the wrong reason

- **Outcome:** FIXED.
- **Decision:** E-HTTP-1. The content-type parser hands the body as bytes (`parseAs: "buffer"`); `RawRequest.body` is a
  `Uint8Array`; admission decodes it with `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` at the JSON-syntax step.
  FST_ERR_CTP_INVALID_CONTENT_LENGTH is REQUEST_MALFORMED (the framing cannot be trusted); the unreachable INVALID_MEDIA_TYPE /
  EMPTY_JSON_BODY mappings are gone (the '*' parser never raises them, and the content type is decided before the body).
- **Authority:** 10 "Request envelope"; RFC 8259 §8.1.
- **Regression tests:** `apps/api/test/transport.test.ts` :: "R40: the body is strict UTF-8 — invalid bytes are JSON_SYNTAX
  with Content-Length and when chunked, nothing is stored with U+FFFD; a body shorter or longer than its Content-Length is
  REQUEST_MALFORMED"; `packages/application/test/admission.test.ts` :: "R40: the body is decoded as strict UTF-8 — an invalid
  byte sequence or a byte order mark is JSON_SYNTAX, never replaced; valid multi-byte text is admitted unchanged".
- **Without the fix:** with a non-fatal decoder the bytes 0xFF 0xFE become U+FFFD and the command is admitted (`actual: 201,
  expected: 400`); the admission test reaches the schema step (`400 INVALID_REQUEST SCHEMA_VIOLATION` where `JSON_SYNTAX` is
  expected). With the old mapping of FST_ERR_CTP_INVALID_CONTENT_LENGTH, a declared length of 40 answers
  `400 INVALID_REQUEST CONTENT_TYPE_UNSUPPORTED` where `REQUEST_MALFORMED` is expected.
- **Files:** `packages/application/src/api/admission.ts`, `apps/api/src/server.ts`.

## R41 — repeated Content-Type and Authorization were silently accepted

- **Outcome:** FIXED.
- **Decision:** E-HTTP-1. The transport reports repeated field names from `request.raw.rawHeaders`
  (`repeatedHeaderNames`); admission refuses any of `SINGLE_VALUED_HEADERS` repeated as the first header check, in
  `admitHeaders` (before the body is read) and again in `admitStructure`. Other repeated headers (Accept, Via) are not
  admission's concern.
- **Authority:** 10 "Request envelope"; 08 "Identity is not permission" (the acting subject is the one authenticated, not
  whichever of two tokens a parser keeps).
- **Regression tests:** `apps/api/test/transport.test.ts` :: "R41: a repeated Authorization, Content-Type, Idempotency-Key,
  X-Correlation-Id or X-Kauro-Agency is refused as HEADER_REPEATED before any value is used — a second bearer token cannot
  choose the acting subject"; `packages/application/test/admission.test.ts` :: "the header-only head of the order (a repeated
  envelope header, then the content type) is decided before a body exists; everything else waits for the body".
- **Without the fix** (the transport reports no repeated field): `Authorization: Bearer <second>` then `Bearer <owner>` is
  served as the first subject (`authorization: actual: 201, expected: 400`); the admission test's raw-header scan returns
  `[]` where `['authorization']` is expected.
- **Files:** `packages/application/src/api/admission.ts`, `packages/application/src/api/envelope.ts`,
  `apps/api/src/server.ts`, `packages/domain/src/model/errors.ts`.

## R42 — no liveness or readiness endpoint; no schema-compatibility check

- **Outcome:** FIXED (not deferred: manual 14 requires readiness with schema compatibility for the service's role, and the
  api is the deployment path of B06).
- **Decision:** E-OPS-4 (`apps/api/src/health.ts`).
- **Authority:** 14 "Monitoring and service health"; 14 "Deployment and rollback"; 07 "Restoration and migration".
- **Regression tests:** `packages/persistence/test/schema-readiness.test.ts` :: "R42: the runtime roles read the ledger (and
  cannot write it); compared with the shipped migrations it is COMPATIBLE, DRIFTED on a changed checksum, BEHIND on a missing
  version, and tolerates a newer expand migration"; `apps/api/test/operability.test.ts` :: "R42 and R38: /livez and /readyz
  outside /api/v1 — readiness verifies a connection and the schema against the shipped migrations (503 when drifted or behind,
  tolerant of a newer expand); a database outage is visible by correlation id in the unavailable and not-ready sinks and in
  the pool sink, never with a credential". The probe bodies are validated by the application's strict validator compiled from
  the exported schemas.
- **Without the fix:** without the route registration, `/livez` is no registered route (`hasRoute` false; the reviewer saw
  404); without the two GRANTs of 0001, the runtime role's ledger read fails with `permission denied for schema kauro_meta`.
- **Files:** `apps/api/src/health.ts` (new), `apps/api/src/server.ts`, `apps/api/src/composition.ts`,
  `apps/api/src/index.ts`, `packages/persistence/src/migrations/runner.ts`, `packages/persistence/src/index.ts`,
  `packages/persistence/migrations/0001_schema_roles_helpers.sql` (two GRANTs, fixed in place).

## R43 — the api pool ceiling accepted 24

- **Outcome:** FIXED.
- **Decision:** E-OPS-1: `KAURO_DB_POOL_MAX` is 1..`API_POOL_CEILING` (4); a value above is refused by name.
- **Authority:** 07 "Connection budget and operating limits".
- **Regression tests:** `apps/api/test/operability.test.ts` :: "configuration of the operating limits: the api pool stays
  inside the four-connection budget (R43), the proxy hop count is explicit outside LOCAL (R34), request, socket and shutdown
  deadlines are bounded (R35, R36), the migrator's limits are read with migrations on start (R37), and its password is never
  configuration (R44)"; `apps/api/test/composition.test.ts` :: "configuration: every variable is validated and a missing or
  malformed one refuses the start by name, never by value; the pool ceiling is a required input" ("5" and "24" added).
- **Without the fix** (ceiling back to 24): "Missing expected exception: 5" in both tests.
- **Files:** `apps/api/src/config.ts`.

## R44 — the migrator password stayed in the runtime process

- **Outcome:** FIXED.
- **Decision:** E-SEC-1.
- **Authority:** 07 "Restoration and migration"; 08 "Database isolation"; 08 "Secrets and supply chain"; 14 "Identity matrix".
- **Regression tests:** `apps/api/test/operability.test.ts` :: "R44: bootstrap consumes the migrator password — it leaves the
  environment before anything runs and is no part of the configuration the running process keeps"; :: "configuration of the
  operating limits: …" (the password is not configuration; without migrations on start it refuses the start by name, never by
  value).
- **Without the fix:** three mutations, three failures. The variable left in the environment: "removed from the environment
  the process was given" fails. The password carried in the retained configuration: `migrateOnStart` shows
  `password: 'migrator-secret-value'`. No refusal without migrations on start: "Missing expected exception: an instance that
  does not migrate never receives owner credentials".
- **Files:** `apps/api/src/config.ts`, `apps/api/src/bootstrap.ts`, `apps/api/src/composition.ts`, `apps/api/src/main.ts`.

## R46 — test-only helpers shipped in the production entry point

- **Outcome:** FIXED.
- **Decision:** E-PKG-1: `packages/persistence/src/testing/index.ts` is the `./testing` export; every test import follows.
- **Authority:** 07 "Platform topology"; 08 "Secrets and supply chain".
- **Regression tests:** `packages/persistence/test/package-surface.test.ts` :: "R46: the production entry point exports no
  test helper; the test-only subpath @kauro/persistence/testing does"; `tools/test/architecture-gate.test.mjs` :: "a test-only
  subpath is importable from a test file only, never from production source; a declared workspace dependency nothing imports
  is refused".
- **Without the fix:** the helpers re-exported from the main entry: "@kauro/persistence exports startTemporaryPostgres" (the
  package-surface test also refuses any production file of the package that reaches into `testing/`; the gate does not see
  an in-package relative import, which is why this test exists). A production file of the api importing
  `@kauro/persistence/testing`: the gate fails with `apps/api/src/composition.ts:29: [test-only] production source imports
  the test-only subpath @kauro/persistence/testing; only files under test/ may`.
- **Files:** `packages/persistence/src/index.ts`, `packages/persistence/src/testing/index.ts` (new),
  `packages/persistence/package.json`, `architecture.rules.json`, `tools/architecture-gate.mjs`,
  `tools/test/architecture-gate.test.mjs`, `packages/persistence/README.md`, and the test imports listed under shared changes.

## R47 — an unused dependency, and the pg types only as a devDependency

- **Outcome:** FIXED.
- **Decision:** E-PKG-1. clean-consume also runs the consumer with the workspace's pinned pnpm (`packageManager`): a newer
  global pnpm ignores `pnpm.overrides` in package.json and resolved the sibling packages from the public registry.
- **Authority:** 08 "Secrets and supply chain" ("Dependencies are pinned"); S045.
- **Regression tests:** `packages/persistence/test/package-surface.test.ts` :: "R47: every declared workspace dependency is
  imported, and the pg types the public declarations name are a pinned runtime dependency"; the gate test of R46 (`unused`);
  `tools/clean-consume.mjs` (run by `pnpm run verify`).
- **Without the fix:** `@kauro/application` declared again: the gate reports `packages/persistence/package.json:1: [unused]
  @kauro/application is declared in @kauro/persistence/package.json dependencies but never imported` and the surface test
  "@kauro/application is declared but never imported". `@types/pg` back among the devDependencies: "@types/pg is a runtime
  dependency pinned exactly" fails, and clean-consume stops with `error TS7016: Could not find a declaration file for module
  'pg'` in six persistence declaration files (migrations/runner, pool, sql, unit-of-work, testing/harness,
  testing/temporary-postgres).
- **Files:** `packages/persistence/package.json`, `pnpm-lock.yaml`, `tools/architecture-gate.mjs`, `tools/clean-consume.mjs`.

## For the integrator: what the design record and case map must say after this branch

- Design §6.5: `AbuseLimiter.admit(operation, {userId, agencyId, clientAddressHash?})`; CMD001 passes the transport's keyed
  address hash (E-ADDR-1).
- Design §7 "Envelope": `X-Correlation-Id` — adopted when an `id`, otherwise (absent or malformed) minted; never refused, never
  echoed (E-CORR-1, replacing the I-INT-4 wording). Validation order: a repeated single-valued envelope header first, then
  content type, size, UTF-8 + JSON syntax, … (E-HTTP-1).
- Design 12b I-ERR-1: the reason list loses `CORRELATION_ID_INVALID` and gains `HEADER_REPEATED`, `REQUEST_MALFORMED`,
  `REQUEST_TIMEOUT` (the Problem schema's `reason` enum is `FAILURE_REASONS`, so it follows).
- Design 12c: I-INT-4 is superseded by E-CORR-1; I-INT-5's header-only head is "a repeated envelope header, then the content
  type"; I-INT-1 gains the operating limits (E-OPS-1), the drain (E-OPS-2), the diagnostics (E-OPS-3), the probes (E-OPS-4),
  the migrator lock (E-MIG-1) and the consumed migrator secret (E-SEC-1); the paragraph saying the harness is "exported beside
  `startTemporaryPostgres`" becomes "exported by the test-only subpath `@kauro/persistence/testing`" (E-PKG-1).
- Design §13 and the case-map inventory: this branch alone moves the counts to application 46, persistence 63 (13 files),
  api 53 (13 files), tools 4 — 240 tests with contracts 12, domain 53, authorization 9.
- Case map "Beyond the 29 cases": the correlation-id row reads "adopted when an `id`, minted otherwise (never refused or
  echoed: E-CORR-1)"; add `apps/api/test/transport.test.ts` (R28, R34, R39, R40, R41, R45) and
  `apps/api/test/operability.test.ts` (R34–R38, R42–R44) rows.
- Fixer d's OpenAPI checker reads `OPERATIONAL_ROUTES` from `@kauro/application` and refuses an undocumented registered route:
  `/livez` and `/readyz` must be connected — `HEALTH_ROUTES` already has the `OperationalRoute` shape (operationId `getLiveness`
  / `getReadiness`, method, path, summary, authority, replies by status with description, content type and a schema in the
  strict validator's vocabulary), so its entries move to `OPERATIONAL_ROUTES` and each probe route registers
  `config.responses = operationalRouteResponses(<operationId>)`.
- The per-address window is live in every test world: all `inject` calls of one `world()` come from 127.0.0.1, so one
  assembled app admits at most twenty CreateAgency creations per hour across its identities (today's heaviest file,
  `cmd001-create-agency.test.ts`, stays below). A merged test that needs more should pass its own `remoteAddress`.
- Migration 0001 is also edited by fixers b and f; the two GRANTs of this branch sit right after
  `GRANT USAGE ON SCHEMA kauro TO kauro_app, kauro_control;` and name only `kauro_app` and `kauro_control` (fixer b's new
  evidence roles need no readiness read).

## Shared changes (outside this fixer's area)

- `packages/domain/src/model/errors.ts`: `FAILURE_REASONS` loses `CORRELATION_ID_INVALID` and gains `HEADER_REPEATED`,
  `REQUEST_MALFORMED`, `REQUEST_TIMEOUT`.
- `packages/application/src/api/envelope.ts`: `CommandEnvelope.clientAddressHash` (required, `Sha256Hex | null`),
  `SINGLE_VALUED_HEADERS`; `admission.ts`: `RequestHead`, `RawRequest.body: Uint8Array | null` (no `bodyText`/`bodyBytes`),
  `RawRequest.repeatedHeaders`, `RawRequest.correlationId`, `RawRequest.clientAddressHash`, `admitHeaders(head)`,
  `admitStructure(spec, raw, validator, clock)` (no `ids`), `correlationIdOf` returns the id, `repeatedHeaderNames`.
- `packages/application/test/support.ts`: `envelope()` accepts an optional `clientAddressHash` (default null).
- `apps/api/test/support.ts`: `openDatabase({ database, migrateOnStart })` (the narrowed `DatabaseConfig`),
  `assembleApi({ …, database: db })`, the testing imports from `@kauro/persistence/testing`.
- `packages/persistence/migrations/0001_schema_roles_helpers.sql`: two GRANTs (readiness), fixed in place.
- Test imports moved to the testing subpath: `packages/persistence/test/{adapters-unit-of-work,discipline,journals-leases,
  last-owner,migrations,tenant-isolation}.test.ts`, `apps/api/test/composition.test.ts`.
- `apps/api/test/request-validation.test.ts`: the malformed-correlation assertion follows R28 (test name unchanged).
- `architecture.rules.json` (`testOnlySubpaths`, `/testing` public subpath), `tools/architecture-gate.mjs`,
  `tools/test/architecture-gate.test.mjs`, `tools/clean-consume.mjs`, `pnpm-lock.yaml`.
