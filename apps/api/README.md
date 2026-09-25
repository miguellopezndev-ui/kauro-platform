# @kauro/api

The Kauro HTTP API (manual 10) on Fastify 5. `createApiServer(options)` registers the seven B06 command routes from the
command specs of `@kauro/application` (`POST /api/v1/agencies`, `/agencies/{agencyId}/clients`, `/clients/{clientId}/archive`,
`/clients/{clientId}/projects`, `/plans/{planId}/revisions`, `/plans/{planId}/approve`, `/plans/{planId}/withdraw`).

Every request goes through the admission pipeline of manual 10 in this order, and the first failure answers:
a repeated single-valued envelope header (`Authorization`, `Content-Type`, `Idempotency-Key`, `X-Correlation-Id`,
`X-Kauro-Agency`: `HEADER_REPEATED`) → content type (`application/json`, optional `charset=utf-8`; both decided in an
`onRequest` hook before the body is read) → byte size (1 MiB) → strict UTF-8 and strict JSON (RFC 8259, an invalid byte or a
byte order mark is `JSON_SYNTAX`, duplicate keys refused, depth 16, strings 40 000) → closed request schema (no coercion, no
defaults, unknown members refused) → `Idempotency-Key` → path ids → agency selector (`agencyId` in the path, else
`X-Kauro-Agency`) → authenticated subject (`Authenticator`) → the handler (authorization and preconditions inside the unit of
work). A request refused before the handler opens no transaction.

Every request receives one correlation id, resolved once as the Fastify request id: the client's `X-Correlation-Id` when it is
an `id`, otherwise (absent, or any other value) a server UUIDv7 — a malformed value is never refused and never echoed. The
answer header, the problem body, the request log lines (label `correlationId`), the diagnostics sinks, the journal entry and
the events carry the same value.

Replies are typed: `CompletedResponse` (`{ kind: "COMPLETED", version, replayed, data }`, 200/201), `AcceptedResponse` (202)
or a `Problem` (`application/problem+json`, closed schema, never a stack, SQL text, raw value or foreign-resource existence).
The `data` of a completed command is the record the command journal stored, so a replay of the same key answers the same
bytes with `replayed: true`. Every answer the framework itself would give — an undecodable URL or a path parameter over the
router's length, an HTTP parser error, a request timeout, a body that is not its declared length — is a problem too
(`REQUEST_MALFORMED`, `PATH_ID_INVALID`, `REQUEST_TIMEOUT`), and any unexpected exception is an opaque `INTERNAL_ERROR` by
correlation id, the safe classification handed to `onInternalError`.

Fastify's built-in JSON parser and Ajv are not used for command bodies: the body reaches the route as bytes and is validated by
the dependency-free strict validator of `@kauro/application` compiled from `@kauro/contracts/schemas.json`, the request
schemas and the Problem schema — nothing else can be compiled (S093).

The client address (the socket peer, or the address `KAURO_HTTP_TRUSTED_PROXY_HOPS` trusted proxy hops report) reaches the
CreateAgency admission limiter as a keyed SHA-256 of its network (IPv4 as is, IPv6 as its /64); the address itself never
enters the application.

`GET /livez` (the process alone) and `GET /readyz` (a verified runtime connection reads `kauro_meta.schema_migrations` and
compares it with the migrations this build ships, by version and checksum; 503 when the database is unreachable, the schema
is behind or drifted, or the process is draining) live outside `/api/v1`; `HEALTH_ROUTES` and the response schemas are
exported. Once shutdown begins every answer carries `Connection: close`, a new request on an open connection is a 503
`CAPACITY_UNAVAILABLE` problem and readiness reports `DRAINING`; `bootstrap().shutdown()` gives up at
`KAURO_SHUTDOWN_DEADLINE_MS` (at most 9 000 ms, below Cloud Run's ten-second SIGTERM grace) and closes what remains.

The composition root binds the PostgreSQL adapters: `loadConfig` reads and validates the environment (`KAURO_ENVIRONMENT`,
`KAURO_DB_*` with a required `KAURO_DB_POOL_MAX` of 1..4 — the API's share of the 07 connection budget —,
`KAURO_DB_MIGRATE_ON_START` with its own `KAURO_DB_MIGRATOR_USER` and `KAURO_DB_MIGRATOR_{CONNECT,STATEMENT,LOCK}_TIMEOUT_MS`,
`KAURO_HTTP_HOST`, `KAURO_HTTP_PORT`, `KAURO_HTTP_TRUSTED_PROXY_HOPS` (required outside LOCAL), `KAURO_HTTP_REQUEST_TIMEOUT_MS`,
`KAURO_HTTP_CONNECTION_TIMEOUT_MS`, `KAURO_SHUTDOWN_DEADLINE_MS`, and in LOCAL only `KAURO_AUTH_BEARER_TOKENS_FILE`);
`openDatabase` applies pending migrations as the owner role when configured and opens the verified runtime pool;
`assembleApi` binds the authorizer, the handlers and the server; `startApi` runs both and `bootstrap` adds the authenticator of
the environment and listens (`main.ts` is the process entry). `KAURO_DB_MIGRATOR_PASSWORD` is consumed by `bootstrap`: it is
removed from the environment before anything runs, used for the migration connection only and never part of the retained
configuration; without `KAURO_DB_MIGRATE_ON_START=true` it refuses the start. The cause of every `CAPACITY_UNAVAILABLE` answer
and of every not-ready probe, and every idle-connection error of the pool, reach a sink by correlation id as safe tokens
(class and SQLSTATE/errno, never a message or a credential). `createBearerTokenAuthenticator` binds opaque bearer tokens to
subjects for LOCAL and tests; SANDBOX and LIVE refuse to start until the Identity Platform verifier is bound (design §12c,
I-INT-3). The transport and operability decisions are recorded in `docs/design/B06-review/E-transport-operability.md`.

Tests (`test/`) run the real server, composed by the real composition root, against a PostgreSQL 17 cluster each test file
starts itself: the OK/DENY/RACE triads of the seven commands, idempotency (S052), the schema boundary (S093), request
validation (R2-058, R2-059, the admission order), the transport (`transport.test.ts`), and the deployment path and its
operation (`composition.test.ts`, `operability.test.ts`: bootstrap over a real socket) — see `docs/design/B06-case-map.md`.
