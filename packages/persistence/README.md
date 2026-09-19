# @kauro/persistence

PostgreSQL 17 persistence of the Kauro platform.

- `migrations/0001..0007_*.sql` — the ordered schema: roles and helpers, identities/agencies/memberships, capabilities/
  clients/projects/revisions/target contracts, plans/receipts/approvals, event types/domain events/outbox/inbox, command
  journal/request journal/leases, security events. Every tenant table has row-level security enabled and forced; every
  tenant-owned foreign key is composite `(agency_id, id)`; every aggregate carries a version whose bump requires its event.
- `src/migrations/runner` — `applyMigrations(client)`: one transaction per file, checksum ledger in
  `kauro_meta.schema_migrations`, drift refusal, explicit lock/statement timeouts. Run as the owner role, never the runtime.
- `src/testing/temporary-postgres` — `startTemporaryPostgres()`: initdb + pg_ctl on a free 127.0.0.1 port, database and
  roles, migrations applied, login roles for `kauro_app` / `kauro_control`; `stop()` removes everything. Binaries from
  `PGBIN`, else `C:\Tools\pgsql17\bin` (Windows) or `/usr/lib/postgresql/17/bin` (Linux).
- `src/sqlstate` — the SQLSTATE vocabulary the schema raises (KA001..KA008) and its translation into `DomainFailure`.

Tests (`test/*.test.ts`) start a real cluster each; there is no fake of PostgreSQL anywhere. Repository, unit-of-work,
event-publisher, journal and lease adapters are the B06 implementation mandate (`docs/design/B06-domain-db-authz.md` §12).
