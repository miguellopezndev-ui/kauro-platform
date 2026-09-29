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
`X-Kauro-Agency`) → authenticated subject (`Authenticator`) → the handler (authorization, then the journal reservation, then
the preconditions, inside one unit of work). A request refused structurally opens no transaction; an unauthenticated one
opens only the ANONYMOUS unit of work that records its durable denial fact before the 401 (review R26).

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
schemas, the response schemas and the Problem schema — nothing else can be compiled (S093).

Every route declares the replies it may send (`config.responses`: `commandRouteResponses` for a registry command,
`operationalRouteResponses` for a route of `OPERATIONAL_ROUTES`); a route without a declaration refuses to register. Every
reply — from a route, a hook, the not-found handler or the error handler — is checked against that declaration by the same
closed validator before it is serialized (status, content type, closed schema; a problem's status equals the HTTP status).
A reply the declaration refuses is never sent: the violation (schema, status, field paths, never a value) goes to
`onInternalError` under the correlation id and the client receives `422 INTEGRITY_FAILURE / RESPONSE_CONTRACT_VIOLATION`.
Fastify's response serializer is not given the schemas (a serializer with other schema semantics would silently drop what a
closed 2020-12 schema refuses). `routeInventoryOf(app)` lists the registered routes with their declarations; `openapi.json`
is the OpenAPI 3.1 document generated from the registry by `tools/openapi.mjs`, and `pnpm run openapi` (part of `verify`)
fails when it is stale or disagrees with those routes.

The client address (the socket peer, or the address `KAURO_HTTP_TRUSTED_PROXY_HOPS` trusted proxy hops report) reaches the
CreateAgency admission limiter as a keyed SHA-256 of its network (IPv4 as is, IPv6 as its /64); the address itself never
enters the application.

`GET /livez` (the process alone) and `GET /readyz` (a verified runtime connection reads `kauro_meta.schema_migrations` and
compares it with the migrations this build ships, by version and checksum; 503 when the database is unreachable, the schema
is behind or drifted, or the process is draining) live outside `/api/v1`; they are the operational routes of
`@kauro/application` (`OPERATIONAL_ROUTES`: operation ids `getLiveness` and `getReadiness`, closed reply schemas), so their
replies are checked, compiled and documented like the commands'; `HEALTH_ROUTES` lists them. Once shutdown begins every
answer carries `Connection: close`, a new request on an open connection is a 503 `CAPACITY_UNAVAILABLE` problem and
readiness reports `DRAINING`; `bootstrap().shutdown()` gives up at `KAURO_SHUTDOWN_DEADLINE_MS` (at most 9 000 ms, below
Cloud Run's ten-second SIGTERM grace) and closes what remains.

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
and of every not-ready probe, and every error a pooled connection raises (idle, or held by a request in flight), reach a sink by correlation id as safe tokens
(class and SQLSTATE/errno, never a message or a credential). `createBearerTokenAuthenticator` binds opaque bearer tokens to
subjects for LOCAL and tests; SANDBOX and LIVE refuse to start until the Identity Platform verifier is bound (design §12c,
I-INT-3). The transport and operability decisions are recorded in `docs/design/B06-review/E-transport-operability.md`.

The browser session boundary (B11 W2, `docs/design/B11-agency-app.md` D-AUTH-1..5, §12) is bound when the configuration
names it (`KAURO_IDENTITY_KEY_SOURCE` = `GOOGLE_X509`, or `CONTRACT_FAKE` in LOCAL only with `KAURO_IDENTITY_FAKE_JWKS_FILE`
and the optional `KAURO_IDENTITY_FAKE_ENDPOINT`; `KAURO_IDENTITY_PROJECT_ID`; `KAURO_APP_ORIGINS`, the exact browser origins;
`KAURO_DB_ASSURANCE_USER`/`_PASSWORD`/`_POOL_MAX`, a login of `kauro_assurance` whose pool shares the four connections of
the budget): `POST /api/v1/sessions`, `GET /api/v1/sessions/current`, `POST /api/v1/sessions/current/revoke`,
`POST /api/v1/assurance/step-ups` and `GET /api/v1/public/identity-config`, and the SessionAuthenticator, which authenticates
the `__Host-kauro_session` cookie of every command and read beside the LOCAL bearer file (a cookie and a bearer token
together are AMBIGUOUS_CREDENTIALS; an unsafe cookie request needs the exact Origin, a same-origin Sec-Fetch-Site and the
session's X-Kauro-CSRF token, decided before the journal). The identity token verifier (`createIdentityTokenVerifier`, jose)
accepts RS256 only and Google's securetoken certificates (Cache-Control max-age) or, in LOCAL, the contract fake's JWKS. No
reply carries a CORS header. Without the session boundary the B06 edition is unchanged (LOCAL: bearer file; SANDBOX and LIVE
refuse to start).

Tests (`test/`) run the real server, composed by the real composition root, against a PostgreSQL 17 cluster each test file
starts itself: the OK/DENY/RACE triads of the seven commands, idempotency (S052), the schema boundary (S093), request
validation (R2-058, R2-059, the admission order), the pipeline order and its authorization (`pipeline-authorization.test.ts`),
the database integrity guards through the routes (`database-integrity.test.ts`), the response contract and the sentinel
serialization of the seven routes (`response-contract.test.ts`, `sentinel-serialization.test.ts`), the transport
(`transport.test.ts`), and the deployment path and its operation (`composition.test.ts`, `operability.test.ts`: bootstrap
over a real socket) — see `docs/design/B06-case-map.md`.
