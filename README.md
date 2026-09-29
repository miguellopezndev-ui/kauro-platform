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
| `@kauro/persistence` | the PostgreSQL 17 migrations (schema, four runtime roles, composite tenant keys, forced RLS, initial states and listed edges, outbox/inbox, journals, leases, security facts, the shared aggregate-kind registry), the checksummed migration runner serialized on an advisory lock, the readiness ledger read, the verified pool factory with its error sink, the unit of work that binds the tenant context, the `pg` adapters of every domain port (repositories, event publisher, command journal, request journal, lease store), the evidence recorders of the step-up verifier and the validator, the SQLSTATE translation, and — on the test-only subpath `@kauro/persistence/testing` — the temporary-cluster helper and test harness |
| `@kauro/api` (`apps/api`) | the Fastify HTTP API: the seven B06 command routes with the manual-10 admission order, typed replies checked against their declared response contract before they are sent (`openapi.json`, generated and checked in `verify`), safe problems, the `/livez` and `/readyz` probes, and the composition root that binds the PostgreSQL adapters (configuration from the environment, verified pool, optional migrations on start, tenant context per unit of work, bounded shutdown); the command-level B06 cases (the OK/DENY/RACE triads of the seven commands, S051 and S052 at the command level, the HTTP half of S093, R2-058, R2-059) run through its routes against a real PostgreSQL 17, the database-level ones (S051, S052, S089, S090, R2-043) in `@kauro/persistence` — `docs/design/B06-case-map.md` |
| `@kauro/ui` | the design system of the web surfaces: the tokens (`src/tokens.ts`, rendered with the component stylesheet to `tokens.css` and bound by WCAG 2.2 AA contrast checks) and the accessible React 19 primitives built on them (SafeText, ConfirmDialog, CountDenominators, Money, Count, Deadline, PhaseList, DataTable, Field and ErrorSummary, StatusBadge, Banner, NavigationGuard, Button), styled by class only and tested by rendering to static markup — `packages/ui/README.md`, `docs/design/B11-agency-app.md` |
| `@kauro/web` (`apps/web`) | the Next.js public and agency application (B11): per-request nonce CSP and static security headers, the standalone server, and the browser suite (Playwright + axe, `pnpm --filter @kauro/web run e2e`, outside `verify`: the browsers are a host install) — `docs/design/B11-agency-app.md` |

Design documents: `docs/design/B06-domain-db-authz.md` (domain, database and authorization), `docs/design/B06-case-map.md`
(the 29 B06 acceptance cases and the tests that demonstrate them) and `docs/design/FOUNDATION-aggregate-kinds.md` (the shared
aggregate-kind registry of migration 0008 and how a package registers its kinds). Persistence tests start a real PostgreSQL 17
(binaries from `PGBIN`, else `C:\Tools\pgsql17\bin` or `/usr/lib/postgresql/17/bin`); nothing fakes the database.

Migration ownership (`packages/persistence/migrations`): B06 owns `0001`–`0007`; `0008` is the shared aggregate-kind registry
(foundation). Every later package numbers its own migrations from `0009` upward on its branch and references only tables that
exist on `main`, never another unmerged package's; when two packages built in parallel merge, the integrator renumbers the
second (the runner requires contiguous versions from `0001` and records each file's checksum).

## Brand

The R2 text names the product Kavo; the product is Kauro (amendment A2, `docs/BRAND_AMENDMENT_A2.md`). Every identifier this
platform emits is `KAURO_*` / `kauro-*`; the vendored registry files stay byte-identical to the authority.
