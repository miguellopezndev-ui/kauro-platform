# Stage A operations: local deployment, rollback, backups, alerts, egress (O28A)

**Status:** built and tested offline. Nothing here touches AWS, a provider, money or a secret. The AWS side is Order 25
(`deploy/aws/`); its activation is the owner's (`deploy/aws/procedures/ACTIVATION.md`). Evidence class of everything below:
`TESTED_LOCAL` (real Node and PostgreSQL 17 processes on the loopback, contract fakes for every provider).

## 1. Reproducible local deployment

The deployment is declared in [deploy/local/stack.json](../../deploy/local/stack.json): runtime pins, build commands, the
entrypoint and the exact environment of the api process. Nothing else configures it.

1. Build: `pnpm install --frozen-lockfile --offline`, `pnpm run generate`, `pnpm -r --workspace-concurrency=1 run build`.
2. Database: a fresh PostgreSQL 17 cluster on 127.0.0.1 with the runtime roles and every migration applied by the migrator role
   (the test harness `startTemporaryPostgres` does exactly this).
3. Process: `node apps/api/dist/src/main.js` with the declared environment; it is ready when `GET /readyz` answers 200.

Proof: `apps/api/test/o28a/local-deploy.test.ts` deploys the declaration, probes liveness and readiness over HTTP, checks an
anonymous read is 401, redeploys and checks the migration ledger did not change.

## 2. Rollback

Migrations are forward-only (no down migrations). Readiness compares the ledger with the migrations the build ships, by version and
checksum (`apps/api/src/health.ts`):

| Situation | Readiness of the previous build | Rollback |
|---|---|---|
| The database has newer migrations than the previous build ships, its own unchanged | 200 COMPATIBLE | Redeploy the previous build |
| A migration the previous build ships is missing or its checksum differs | 503 BEHIND or DRIFTED: kept out of traffic | Restore the pre-deploy backup (section 3), then redeploy the previous build |

Rule for every deployment: take the backup immediately before applying a new migration. Proof: the rollback-guard test in
`local-deploy.test.ts` (a newer recorded migration keeps serving; a drifted one is 503; restored, ready again).

## 3. Backups and restore

- Backup: `pg_dumpall --roles-only` (roles are cluster-wide) and `pg_dump -Fc -d kauro`.
- Restore: `initdb`, apply the roles file, `pg_restore -C -d postgres`.
- Checks after a restore: the migration ledger (version and checksum), the row count of every effect table, ENABLE and FORCE row
  security of every table and every policy are equal to the source; under agency B's context no row of agency A is visible.

Proof: `apps/api/test/o28a/continuity.test.ts`. RPO and RTO are not claimed: they depend on the backup schedule and the managed
database chosen at activation (O25 `database` module is PROPOSED).

## 4. Node failure and retry

When the api's database is unreachable every request answers 503 `CAPACITY_UNAVAILABLE` with `retryable: true`, nothing is
written, and once the database returns the same idempotent command (same key, same body) completes exactly once; a further retry
replays it. Proof: `continuity.test.ts` (the api's login refused and its connections cut while the server keeps running).

## 5. Alerts

Rules: [deploy/local/alerts.json](../../deploy/local/alerts.json), over the api's own stderr lines (they carry correlation ids,
classes and codes, never a customer value). Evaluator: `node tools/ci/alerts.mjs <log>` (each line `<ISO-8601> <stderr line>`).
A rule fires once per episode and again only after a quiet window. Proof: `tools/test/o28a-alerts.test.mjs` (synthetic and
verbatim lines; every pattern is a line the shipped source writes) and `local-deploy.test.ts` (a real outage pages
`API_NOT_READY`; the healthy deployments page nothing). Paging routes are the deployment's (O25 `management-alarms`).

## 6. Egress

The api opens no connection beyond the loopback: its database and listener are 127.0.0.1 and every provider port is a labelled
contract fake or unbound. Proof: `apps/api/test/o28a/cross-tenant-sweep.test.ts` observes every outbound socket of the process while
it serves every route. The OS-level egress denial of a production host is O25's network module (private subnets, endpoints) and
its live qualification; it is not claimed here.

## 7. Cross-tenant data

`cross-tenant-sweep.test.ts` reads the served route list from `apps/api/openapi.json`, so a route added by any order is swept
without editing the test. Agency A holds real resources behind the route ids: a project, a sealed revision with its confirmed target
contract and approved plan, an issued quote, a paid payment order and its capture, and what A's owner creates through the routes
(support case, invitation, upload, refund request). A member of agency B calls every route with those ids, under B's agency header and
under A's forged one. No answer is 2xx (except B's own agency list), no reply carries A's facts, no row of any `kauro` table is written
(read from the catalog at run time; the refusal's own records aside), and every foreign read is refused by authorization (403) or not
disclosed (404). A customer route whose id the fixture cannot fill with an A-owned resource fails the sweep unless it is listed in
`RANDOM_ID_ROUTES` with its reason (audits, jobs, packages, import stages, selection manifests, table previews and the seller-side
sales resources: each needs the control plane, the inspection pipeline or a seller principal, and is proved by its own tests).
Corporate routes (`/operations`, `/ops`) are refused by role whatever the id. Commands get a minimal body generated from their request
schema; at least three quarters of the command calls are refused by authority, not by their schema.

Readiness and rollback: DRIFTED and BEHIND turn `/readyz` to 503; business routes keep serving, so "kept out of traffic" (section 2)
holds behind a router that honours readiness, which the local stack does not have.
