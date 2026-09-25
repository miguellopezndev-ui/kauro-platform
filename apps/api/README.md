# @kauro/api

The Kauro HTTP API (manual 10) on Fastify 5. `createApiServer(options)` registers the seven B06 command routes from the
command specs of `@kauro/application` (`POST /api/v1/agencies`, `/agencies/{agencyId}/clients`, `/clients/{clientId}/archive`,
`/clients/{clientId}/projects`, `/plans/{planId}/revisions`, `/plans/{planId}/approve`, `/plans/{planId}/withdraw`).

Every request goes through the admission pipeline of manual 10 in this order, and the first failure answers:
correlation id (an `id` when supplied, else minted) → content type (`application/json`, optional `charset=utf-8`; decided in
an `onRequest` hook before the body is read) → byte size (1 MiB) → strict JSON (RFC 8259, duplicate keys refused, depth 16,
strings 40 000) → closed request schema (no coercion, no defaults, unknown members refused) → `Idempotency-Key` → path ids →
agency selector (`agencyId` in the path, else `X-Kauro-Agency`) → authenticated subject (`Authenticator`) → the handler
(authorization and preconditions inside the unit of work). A request refused before the handler opens no transaction.

Replies are typed: `CompletedResponse` (`{ kind: "COMPLETED", version, replayed, data }`, 200/201), `AcceptedResponse` (202)
or a `Problem` (`application/problem+json`, closed schema, never a stack, SQL text, raw value or foreign-resource existence).
The `data` of a completed command is the record the command journal stored, so a replay of the same key answers the same
bytes with `replayed: true`. `X-Correlation-Id` is echoed when it is an `id` and generated otherwise. Fastify's own parser
errors and any unexpected exception become problems too (opaque `INTERNAL_ERROR` by correlation id, the safe classification
handed to `onInternalError`).

Fastify's built-in JSON parser and Ajv are not used for command bodies: the body reaches the route as text and is validated by
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

The composition root binds the PostgreSQL adapters: `loadConfig` reads and validates the environment (`KAURO_ENVIRONMENT`,
`KAURO_DB_*` with a required `KAURO_DB_POOL_MAX`, `KAURO_DB_MIGRATE_ON_START` with its own `KAURO_DB_MIGRATOR_USER`,
`KAURO_HTTP_*`, and in LOCAL only `KAURO_AUTH_BEARER_TOKENS_FILE`); `openDatabase` applies pending migrations as the owner role
when configured and opens the verified runtime pool; `assembleApi` binds the authorizer, the handlers and the server;
`startApi` runs both and `bootstrap` adds the authenticator of the environment and listens (`main.ts` is the process entry).
`createBearerTokenAuthenticator` binds opaque bearer tokens to subjects for LOCAL and tests; SANDBOX and LIVE refuse to start
until the Identity Platform verifier is bound (design §12c, I-INT-3).

Tests (`test/`) run the real server, composed by the real composition root, against a PostgreSQL 17 cluster each test file
starts itself: the OK/DENY/RACE triads of the seven commands, idempotency (S052), the schema boundary (S093), request
validation (R2-058, R2-059, the admission order), the response contract and the sentinel serialization of the seven routes,
and the deployment path — see `docs/design/B06-case-map.md`.
