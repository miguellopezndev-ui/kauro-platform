/**
 * @kauro/persistence — PostgreSQL 17 persistence of the Kauro platform: the ordered SQL migrations (schema, roles, tenant
 * constraints, row-level security, outbox/inbox, journals, leases), the checksummed migration runner, the verified pool
 * factory, the unit of work that binds the tenant context, the repositories, event publisher, journals and lease store that
 * implement the @kauro/domain ports, and the SQLSTATE translation. The temporary cluster, the harness and the interleaving
 * helpers of the real-database tests are the separate, test-only subpath `@kauro/persistence/testing` (src/testing/index.ts):
 * nothing here imports it, so no production import graph carries them.
 */
export {
  MIGRATIONS_DIR,
  MIGRATION_RUNNER_LOCK,
  DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS,
  DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS,
  DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS,
  listMigrations,
  applyMigrations,
  applyMigrationsAs,
  appliedMigrations,
  compareSchema,
  readSchemaLedger,
  MigrationDriftError,
  MigratorRoleError,
} from "./migrations/runner.js";
export type { MigrationFile, AppliedMigration, ApplyOptions, ApplyAsOptions, ApplyResult, MigratorConnection, LedgerEntry, SchemaCompatibility } from "./migrations/runner.js";
export { SQLSTATE, failureOfSqlState, SOURCE_CONSTRAINT_FAILURES } from "./sqlstate.js";
export { createPool, classifyError, KauroPool, PrivilegedRoleError, RUNTIME_ROLES } from "./pool.js";
export type { PoolConfig, PoolErrorEvent, PoolErrorSink, RuntimeRole, SafeErrorClassification, VerifiedConnection } from "./pool.js";
export { PgAssuranceProofRecorder, PgValidationReceiptRecorder } from "./evidence.js";
export { createUnitOfWorkFactory, PgUnitOfWorkFactory, PgUnitOfWork, PgSourceUnitOfWork } from "./unit-of-work.js";
export type { UnitOfWorkDependencies } from "./unit-of-work.js";
export { ConstraintViolation, LeaseRefusal, translateDatabaseError } from "./sql.js";
export { PgEventPublisher } from "./event-publisher.js";
export { PgCommandJournal } from "./command-journal.js";
export { PgLeaseStore } from "./lease-store.js";
export { PgRequestJournal } from "./request-journal.js";
export { PgInboxIngress, PgInboxConsumerStore, PgOutboxDispatchStore } from "./inbox-outbox.js";
export { PgIdentityRepository, PgAgencyRepository, PgMembershipRepository, PgInvitationRepository, PgSecurityEventRepository } from "./repositories/tenancy.js";
export { PgProcessingAuthorityRepository, PgEndClientRepository, PgProjectRepository, PgDatasetRevisionRepository, PgTargetContractRepository, PgCapabilityRepository } from "./repositories/workspace.js";
export { PgPlanRepository, PgValidationReceiptRepository, PgApprovalRepository } from "./repositories/plans.js";
export {
  PgSourceStore,
  PgUploadSessionRepository,
  PgSessionSecretRepository,
  PgStoredObjectRepository,
  PROVIDER_SOFT_DELETED_REASON,
  PgInspectionReceiptRepository,
  PgSourceFileRepository,
  PgSelectionManifestRepository,
  PgSelectionEvaluationRepository,
  PgSourceRevisionRepository,
  PgProjectRevisionPointer,
  PgRevisionAuthorityInspector,
  PgPendingOperationJournal,
  PgSealedManifestRepository,
  PgRetentionRepository,
  PgSourceAvailabilityReader,
  PgRevisionLineageReader,
  serverInstantOf,
} from "./source/index.js";
export type { SourceAudience } from "./source/index.js";
