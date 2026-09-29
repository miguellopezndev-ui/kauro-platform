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
| `@kauro/application` | command contracts of the seven B06 commands and their handlers (one unit of work each: journal reserve, authorization, locked preconditions, state + events, journal commit), request envelope and admission pipeline, safe problem contract, closed request schemas with the dependency-free strict validator, DTO projections, the orchestration ports (authorizer, assurance, admission, schema validation, plan services), and the in-memory ports for pure orchestration tests; the B07 source-lifecycle contracts (six command contracts, request schemas, response views, outcome catalogues, the provider ports) and — on the test-only subpath `@kauro/application/testing` — the labelled contract fakes of object storage, the session vault and the authority journal (SIMULATED, never bound by a composition root) |
| `@kauro/authorization` | the Authorizer (identity status, live membership, agency scope, role, step-up; default deny with safe reason and policy version), the step-up assurance verifier and the admission limiter |
| `@kauro/persistence` | the PostgreSQL 17 migrations (schema, four runtime roles, composite tenant keys, forced RLS, initial states and listed edges, outbox/inbox, journals, leases, security facts, the shared aggregate-kind registry), the checksummed migration runner serialized on an advisory lock, the readiness ledger read, the verified pool factory with its error sink, the unit of work that binds the tenant context, the `pg` adapters of every domain port (repositories, event publisher, command journal, request journal, lease store), the evidence recorders of the step-up verifier and the validator, the `pg` adapters of the B07 source store (`runSource`, `serverInstant()`, migrations `0009`–`0012`), the SQLSTATE translation, and — on the test-only subpath `@kauro/persistence/testing` — the temporary-cluster helper, the test harness, the labelled TEST CLOCK and the source-lifecycle fixture |
| `@kauro/data-plane` | the platform's own bounded parsers of untrusted source files, always real, each run in an isolated child process under the Node permission model with network hooks (B07 D-ISO-1): the container inspector (hardened ZIP/XML reader, CSV dialect facts, worksheet inventory, expected scan parts), the selection evaluator (exact counts in bounded memory) and the preview reader; and — on the test-only subpath `@kauro/data-plane/testing` — the labelled contract fake of the malware scanner (SIMULATED) |
| `@kauro/api` (`apps/api`) | the Fastify HTTP API: the seven B06 command routes and the six B07 source-lifecycle command routes (CMD012..CMD017, with the source reads and the selection manifest intake; the provider adapters and the preview reader are collaborators this edition leaves unbound, B07 D-SAPI-6) with the manual-10 admission order, typed replies checked against their declared response contract before they are sent (`openapi.json`, generated and checked in `verify`), safe problems, the `/livez` and `/readyz` probes, and the composition root that binds the PostgreSQL adapters (configuration from the environment, verified pool, optional migrations on start, tenant context per unit of work, bounded shutdown); the command-level B06 cases (the OK/DENY/RACE triads of the seven commands, S051 and S052 at the command level, the HTTP half of S093, R2-058, R2-059) run through its routes against a real PostgreSQL 17, the database-level ones (S051, S052, S089, S090, R2-043) in `@kauro/persistence` — `docs/design/B06-case-map.md`; the B07 command halves (the OK/DENY/RACE triads of CMD012..CMD017, R2-052, the HTTP halves of S053 and R2-051) run through its routes with the labelled storage and vault fakes of `@kauro/application/testing` — `docs/design/B07-case-map.md` |
| `@kauro/control` (`apps/control`) | the control plane of the source lifecycle (B07 §12, mandate B07-CONTROL): the outbox dispatcher over B06's dispatch store and OUTBOX_DISPATCH leases; the consumers UPLOAD_INSPECTION (observation, bounded inspection, scan coverage on the database clock, promotion, admission or rejection under one attempt fence), SELECTION_EVALUATION, STORAGE_LIFECYCLE (provider session cancellation recorded, bearer record purged, deletion by exact generation with its residual) and AUTHORITY_JOURNAL (restore tombstones, only for a subject in the tombstone's terminal state); the sweepers of `SOURCE_SWEEPERS` — each unit of work a SYSTEM context bound to the work item's agency, revision row first, server instants only; the composition root binds the `pg` adapters and the platform's own parsers, and takes the provider ports from its caller (no deployment binds a fake; the real adapters are B15's). Its tests run against a real PostgreSQL 17 with the labelled contract fakes (SIMULATED) |

Design documents: `docs/design/B06-domain-db-authz.md` (domain, database and authorization), `docs/design/B06-case-map.md`
(the 29 B06 acceptance cases and the tests that demonstrate them) and `docs/design/FOUNDATION-aggregate-kinds.md` (the shared
aggregate-kind registry of migration 0008 and how a package registers its kinds); B07: `docs/design/B07-upload-source-lifecycle.md`
(upload, inspection and source lifecycle) and `docs/design/B07-case-map.md` (its 23 cases, with their status on `b07/stage-1`). Persistence tests start a real PostgreSQL 17
(binaries from `PGBIN`, else `C:\Tools\pgsql17\bin` or `/usr/lib/postgresql/17/bin`); nothing fakes the database.

Migration ownership (`packages/persistence/migrations`): B06 owns `0001`–`0007`; `0008` is the shared aggregate-kind registry
(foundation). Every later package numbers its own migrations from `0009` upward on its branch and references only tables that
exist on `main`, never another unmerged package's; when two packages built in parallel merge, the integrator renumbers the
second (the runner requires contiguous versions from `0001` and records each file's checksum).

## Brand

The R2 text names the product Kavo; the product is Kauro (amendment A2, `docs/BRAND_AMENDMENT_A2.md`). Every identifier this
platform emits is `KAURO_*` / `kauro-*`; the vendored registry files stay byte-identical to the authority.
