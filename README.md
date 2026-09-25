# Kauro platform

Private monorepo of the Kauro platform: CRM data preparation for agencies (audit, approved plan, deterministic transformation,
verified package, human report, manifest and import guide; never a direct write into the customer's CRM).

The normative authority is the R2 edition of the Kauro manuals (`registry/` vendored under `packages/contracts` with provenance).
Product and source language is English. Build packages are accepted only by the construction service's independent review
against the program's acceptance catalogue; nothing here is "done" because a test is green.

## Topology (07 · Platform topology)

Deployable entrypoints: `api`, `control`, `web`, `ops`, `intelligence-worker`, `migration-worker` (under `apps/`).
Shared packages (under `packages/`): `contracts`, `domain`, `application`, `authorization`, `persistence`, `data-plane`,
`migration-core`, `intelligence-core`, `ui`, `reports`. A directory exists only when it has real responsibility, implementation
and tests — empty folders are not milestones.

Dependencies flow contracts → domain ports → application → adapters; UI consumes HTTP DTOs; the cores depend on no
persistence, payments, framework or UI. `architecture.rules.json` + `tools/architecture-gate.mjs` enforce it.

Stack: Node 24 LTS, strict TypeScript (ESM, NodeNext), pnpm workspace, Fastify, PostgreSQL 17 with `pg` and explicit SQL
migrations, Next.js for the web surfaces.

## Commands

```
pnpm install
pnpm run verify          # generate + build + typecheck + test + architecture gate + openapi + clean-consume
pnpm run arch            # architecture gate alone
pnpm run openapi         # apps/api/openapi.json is the generated document and matches the registered routes (after build)
pnpm run openapi:generate  # regenerate apps/api/openapi.json from the registry and the application schemas
pnpm run clean-consume   # S045: every publishable package installs and works from its tarball alone
```

## Packages

| package | what it owns |
|---|---|
| `@kauro/contracts` | the contract authority: vendored R2 registry (provenance-checked), generated TypeScript types and JSON Schemas, canonical JSON profile, domain-separated digests |
| `@kauro/domain` | aggregate identity (UUIDv7 / UUIDv5), tenant contexts, role and capability model, state-machine guards over the registry, registered domain events, failure taxonomy, idempotency identity, and the ports adapters implement (B06 design) |
| `@kauro/application` | command contracts of the seven B06 commands and their handlers (one unit of work each: journal reserve, authorization, locked preconditions, state + events, journal commit), request envelope and admission pipeline, safe problem contract, closed request schemas with the dependency-free strict validator, DTO projections, the orchestration ports (authorizer, assurance, admission, schema validation, plan services), and the in-memory ports for pure orchestration tests |
| `@kauro/authorization` | the Authorizer (identity status, live membership, agency scope, role, step-up; default deny with safe reason and policy version), the step-up assurance verifier and the admission limiter |
| `@kauro/persistence` | the PostgreSQL 17 migrations (schema, roles, composite tenant keys, forced RLS, outbox/inbox, journals, leases), the checksummed migration runner, the verified pool factory, the unit of work that binds the tenant context, the `pg` adapters of every domain port (repositories, event publisher, command journal, request journal, lease store), the SQLSTATE translation and the temporary-cluster helper and test harness |
| `@kauro/api` (`apps/api`) | the Fastify HTTP API: the seven B06 command routes with the manual-10 admission order, typed replies and safe problems, and the composition root that binds the PostgreSQL adapters (configuration from the environment, verified pool, optional migrations on start, tenant context per unit of work); the command-level B06 cases (the OK/DENY/RACE triads of the seven commands, S051 and S052 at the command level, the HTTP half of S093, R2-058, R2-059) run through its routes against a real PostgreSQL 17, the database-level ones (S051, S052, S089, S090, R2-043) in `@kauro/persistence` — `docs/design/B06-case-map.md` |

Design documents: `docs/design/B06-domain-db-authz.md` (domain, database and authorization) and `docs/design/B06-case-map.md`
(the 29 B06 acceptance cases and the tests that demonstrate them). Persistence tests start a real PostgreSQL 17 (binaries from
`PGBIN`, else `C:\Tools\pgsql17\bin` or `/usr/lib/postgresql/17/bin`); nothing fakes the database.

## Brand

The R2 text names the product Kavo; the product is Kauro (amendment A2, `docs/BRAND_AMENDMENT_A2.md`). Every identifier this
platform emits is `KAURO_*` / `kauro-*`; the vendored registry files stay byte-identical to the authority.
