# @kauro/persistence

PostgreSQL 17 persistence of the Kauro platform (layer `adapter`: it implements the ports of `@kauro/domain`).

- `migrations/0001..0007_*.sql` — the ordered schema: roles and helpers, identities/agencies/memberships, capabilities/
  clients/projects/revisions/target contracts, plans/receipts/approvals, event types/domain events/outbox/inbox, command
  journal/request journal/leases, security events. Every tenant table has row-level security enabled and forced; every
  tenant-owned foreign key is composite `(agency_id, id)`; every aggregate carries a version whose bump requires its event.
- `src/migrations/runner` — `applyMigrations(client)`: one transaction per file, checksum ledger in
  `kauro_meta.schema_migrations`, drift refusal, explicit lock/statement timeouts on every runner statement. Runners of one
  database serialize on the session advisory lock `MIGRATION_RUNNER_LOCK`, taken before the ledger is created and read, so
  concurrent starts both succeed (one applies, the other skips). `applyMigrationsAs(connection, options)` adds a connect
  timeout and session statement/lock timeouts to the dedicated migrator connection. Run as the owner role, never the runtime.
  `readSchemaLedger(pool, ms)` reads the ledger over a verified runtime connection (the runtime roles may SELECT it, nothing
  more) and `compareSchema(ledger, listMigrations())` classifies it COMPATIBLE / DRIFTED / BEHIND for readiness.
- `src/pool` — `createPool(config)`: a `pg` pool with a mandatory connection ceiling (07 "Connection budget") whose every
  physical connection is verified once on first use: not SUPERUSER, not BYPASSRLS, not CREATEROLE/CREATEDB, not the database
  owner, member of exactly one runtime group (`kauro_app` or `kauro_control`). A privileged login is destroyed, never pooled.
  An error of an idle connection reaches `config.onError` (default: one stderr line) as the pool name, the error class and the
  SQLSTATE or errno code (`classifyError`), never the message or a connection parameter.
- `src/unit-of-work` — `createUnitOfWorkFactory(pool, {clock})`: `run(context, work, options)` opens one transaction at the
  requested isolation (READ COMMITTED by default), sets a transaction-local `statement_timeout`, binds the TENANT / IDENTITY /
  SYSTEM context with `set_config(..., true)` (the settings vanish at COMMIT/ROLLBACK, so a connection returns to the pool
  with no context), refuses a context on the wrong pool (SYSTEM needs `kauro_control`, the others `kauro_app`), hands the
  repositories, event publisher, command journal, request journal and lease store to `work`, commits when it returns (the
  deferred constraints fire here and the COMMIT tag is checked — an aborted transaction never passes as committed) and rolls
  back when it throws. A `DomainFailure` is the business outcome; a database refusal becomes the failure of the SQLSTATE
  table; anything else is `INTERNAL_ERROR` with the correlation id (the cause stays server-side). `serialization_failure`
  and `deadlock_detected` are retried with a fresh transaction up to `maxRetries`. `adoptTenant` (CreateAgency) accepts only
  an id minted through `uow.ids` in the same unit of work; `resolveMembership` records the authorizer's decision once.
- `src/repositories/*` — `PgAgencyRepository`, `PgMembershipRepository`, `PgIdentityRepository`, `PgSecurityEventRepository`
  (`tenancy`), `PgProcessingAuthorityRepository`, `PgEndClientRepository`, `PgProjectRepository`, `PgDatasetRevisionRepository`,
  `PgTargetContractRepository`, `PgCapabilityRepository` (`workspace`), `PgPlanRepository`, `PgValidationReceiptRepository`,
  `PgApprovalRepository` (`plans`). Reads return `null` for rows the policies hide; versioned writes are compare-and-swap on
  `version` and answer `STALE` with the current safe version and state, or `NOT_FOUND` for an invisible row; foreign
  references fail on the composite keys as `INVALID_REQUEST / UNKNOWN_REFERENCE`.
- `src/event-publisher` — `PgEventPublisher.publish`: allowlist check, id and time from the ports, canonical payload digest,
  `domain_events` row plus one `outbox_records` row per registered consumer; a second event for an aggregate version is
  `INTEGRITY_FAILURE / VERSION_DISCIPLINE`.
- `src/command-journal` — `PgCommandJournal`: reservation by `INSERT ... ON CONFLICT (identity) DO NOTHING`, so a concurrent
  duplicate waits for the first transaction and then replays (same digest), conflicts (other digest) or proceeds (rollback);
  `commit` stores the 2xx status, body and resource link and returns the entry as stored (the answer of the first execution
  is the journaled record, byte-equal to every replay: D-PORT-2); final entries never change.
- `src/request-journal` — `PgRequestJournal`: fence-scoped dispatch attempts; a full hash, a positive ceiling and a grant are
  required; response before consume; terminal states final.
- `src/lease-store` — `PgLeaseStore` over `kauro.claim_lease / heartbeat_lease / checkpoint_lease / cancel_lease`; a claim
  runs under a savepoint so a refusal (`RESUME_WITHOUT_CHECKPOINT`, `DEADLINE_IMMUTABLE`, `SUBJECT_IMMUTABLE`,
  `DEADLINE_PASSED`) is an outcome, not an aborted transaction. The port's `CANCELLED` reason is not produced by this adapter:
  the schema has no cancellation rule that refuses a claim (cancellation is a generation the owner observes).
- `src/sqlstate` / `src/sql` — the SQLSTATE vocabulary the schema raises (KA001..KA008) and its translation into
  `DomainFailure`; `ConstraintViolation` for a unique constraint the handler must interpret; `LeaseRefusal` for KA005/KA004
  raised by the lease functions.
The test-only surface is the separate export subpath `@kauro/persistence/testing` (`src/testing/index.ts`): the main entry
exports none of it, and the architecture gate refuses an import of the subpath from production source, so no deployment
import graph carries process-spawning test code.

- `src/testing/temporary-postgres` — `startTemporaryPostgres()`: initdb + pg_ctl on a free 127.0.0.1 port, database and
  roles, migrations applied, login roles for `kauro_app` / `kauro_control`; `stop()` removes everything. Binaries from
  `PGBIN`, else `C:\Tools\pgsql17\bin` (Windows) or `/usr/lib/postgresql/17/bin` (Linux).

- `src/testing/harness` — `startHarness()`: the two verified pools and unit-of-work factories on a fresh cluster, the
  superuser oracle, and fixtures written through the adapters under a real context; capabilities are born DESIGN and
  published through the listed Capability edges with each gate's evidence (`offeredCapability`, `publishCapability`: D-CAP-2);
  `waitForLockWait` and `barrier` fix interleavings. Exported (through `@kauro/persistence/testing`) for the entrypoints'
  acceptance tests, never wired into a deployment.

Tests (`test/*.test.ts`) start a real cluster each; there is no fake of PostgreSQL anywhere. `migrations`, `tenant-isolation`,
`discipline`, `last-owner` and `journals-leases` review the SQL directly; `adapters-unit-of-work`, `adapters-tenant-isolation`,
`adapters-journals-outbox` and `adapters-leases` review the adapters; `migration-runner`, `pool-diagnostics`,
`schema-readiness` and `package-surface` review the runner under concurrency and failure, the pool's diagnostics, the
readiness ledger read and the published surface.
