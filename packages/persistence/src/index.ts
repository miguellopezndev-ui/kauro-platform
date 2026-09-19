/**
 * @kauro/persistence — PostgreSQL 17 persistence of the Kauro platform: the ordered SQL migrations (schema, roles, tenant
 * constraints, row-level security, outbox/inbox, journals, leases), the checksummed migration runner and the temporary
 * cluster helper for real-database tests. Repository, unit-of-work and journal adapters implementing the @kauro/domain ports
 * are the B06 implementation mandate; their contracts and the SQL they run against are fixed here.
 */
export { MIGRATIONS_DIR, listMigrations, applyMigrations, appliedMigrations, MigrationDriftError } from "./migrations/runner.js";
export type { MigrationFile, AppliedMigration, ApplyOptions, ApplyResult } from "./migrations/runner.js";
export { startTemporaryPostgres, ROLES } from "./testing/temporary-postgres.js";
export type { TemporaryPostgres, StartOptions } from "./testing/temporary-postgres.js";
export { SQLSTATE, failureOfSqlState } from "./sqlstate.js";
