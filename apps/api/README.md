# @kauro/api

The Kauro HTTP API (manual 10) on Fastify 5. `createApiServer(options)` registers the seven B06 command routes from the
command specs of `@kauro/application` (`POST /api/v1/agencies`, `/agencies/{agencyId}/clients`, `/clients/{clientId}/archive`,
`/clients/{clientId}/projects`, `/plans/{planId}/revisions`, `/plans/{planId}/approve`, `/plans/{planId}/withdraw`).

Every request goes through the admission pipeline of manual 10 in this order, and the first failure answers:
content type (`application/json`, optional `charset=utf-8`) → byte size (1 MiB) → strict JSON (RFC 8259, duplicate keys
refused, depth 16, strings 40 000) → closed request schema (no coercion, no defaults, unknown members refused) →
`Idempotency-Key` → path ids → agency selector (`agencyId` in the path, else `X-Kauro-Agency`) → authenticated subject
(`Authenticator`) → the handler (authorization and preconditions inside the unit of work).

Replies are typed: `CompletedResponse` (`{ kind: "COMPLETED", version, replayed, data }`, 200/201), `AcceptedResponse` (202)
or a `Problem` (`application/problem+json`, closed schema, never a stack, SQL text, raw value or foreign-resource existence).
`X-Correlation-Id` is echoed when well-formed and generated otherwise. Fastify's own parser errors and any unexpected
exception become problems too (opaque `INTERNAL_ERROR` by correlation id, the safe classification handed to `onInternalError`).

Fastify's built-in JSON parser and Ajv are not used for command bodies: the body reaches the route as text and is validated by
the dependency-free strict validator of `@kauro/application` compiled from `@kauro/contracts/schemas.json`, the request
schemas and the Problem schema — nothing else can be compiled (S093).

`createBearerTokenAuthenticator` binds opaque bearer tokens to authenticated subjects for the LOCAL environment and tests;
the Identity Platform token verifier implements the same `Authenticator` interface in the identity package. The process
bootstrap that binds the PostgreSQL adapters (unit of work, repositories, journals) and that verifier into `createApiServer`
is the integration step of the B06 mandate; tests here run the real server over the in-memory ports of `@kauro/application`.
