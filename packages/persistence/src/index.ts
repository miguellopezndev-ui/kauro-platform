/**
 * @kauro/persistence — PostgreSQL 17 persistence of the Kauro platform: the ordered SQL migrations (schema, roles, tenant
 * constraints, row-level security, outbox/inbox, journals, leases), the checksummed migration runner, the verified pool
 * factory, the unit of work that binds the tenant context, the repositories, event publisher, journals and lease store that
 * implement the @kauro/domain ports, and the SQLSTATE translation. The temporary cluster, the harness and the interleaving
 * helpers of the real-database tests are the separate, test-only subpath `@kauro/persistence/testing` (src/testing/index.ts):
 * nothing here imports it, so no production import graph carries them.
 */
export { MIGRATIONS_DIR, listMigrations, applyMigrations, applyMigrationsAs, appliedMigrations, MigrationDriftError, MigratorRoleError } from "./migrations/runner.js";
export type { MigrationFile, AppliedMigration, ApplyOptions, ApplyResult, MigratorConnection } from "./migrations/runner.js";
export { SQLSTATE, failureOfSqlState } from "./sqlstate.js";
export { createPool, KauroPool, PrivilegedRoleError } from "./pool.js";
export type { PoolConfig, RuntimeRole, VerifiedConnection } from "./pool.js";
export { createUnitOfWorkFactory, PgUnitOfWorkFactory, PgUnitOfWork } from "./unit-of-work.js";
export type { UnitOfWorkDependencies } from "./unit-of-work.js";
export { ConstraintViolation, LeaseRefusal, translateDatabaseError } from "./sql.js";
export { PgEventPublisher } from "./event-publisher.js";
export { PgCommandJournal } from "./command-journal.js";
export { PgLeaseStore } from "./lease-store.js";
export { PgRequestJournal } from "./request-journal.js";
export { PgIdentityRepository, PgAgencyRepository, PgMembershipRepository, PgSecurityEventRepository } from "./repositories/tenancy.js";
export { PgProcessingAuthorityRepository, PgEndClientRepository, PgProjectRepository, PgDatasetRevisionRepository, PgTargetContractRepository, PgCapabilityRepository } from "./repositories/workspace.js";
export { PgPlanRepository, PgValidationReceiptRepository, PgApprovalRepository } from "./repositories/plans.js";
