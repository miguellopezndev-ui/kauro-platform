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
export { SQLSTATE, failureOfSqlState, SOURCE_CONSTRAINT_FAILURES, commerceReplayOf, COMMERCE_REPLAY_CONSTRAINTS, COMMERCE_INTEGRITY_CONSTRAINTS } from "./sqlstate.js";
export { createPool, classifyError, KauroPool, PrivilegedRoleError, RUNTIME_ROLES } from "./pool.js";
export type { PoolConfig, PoolErrorEvent, PoolErrorSink, RuntimeRole, SafeErrorClassification, VerifiedConnection } from "./pool.js";
export { PgAssuranceProofRecorder, PgValidationReceiptRecorder } from "./evidence.js";
export { PgWebSessionStore, WEB_SESSION_STATEMENT_TIMEOUT_MS } from "./web-sessions.js";
export type { StoredWebSession, NewStoredWebSession } from "./web-sessions.js";
export { createUnitOfWorkFactory, PgUnitOfWorkFactory, PgUnitOfWork, PgSourceUnitOfWork, createCommerceUnitOfWorkFactory, PgCommerceUnitOfWorkFactory, PgCommerceUnitOfWork, commercialInspectionsOf, purchasedSubjectsOf, paymentSweepsOf, commerceRequestReadsOf, commercialSourceReadsOf, sourceStoreOf, commercialAuthorizationsOf } from "./unit-of-work.js";
export type { UnitOfWorkDependencies, CommercePools } from "./unit-of-work.js";
export { ConstraintViolation, LeaseRefusal, translateDatabaseError } from "./sql.js";
export { PgEventPublisher } from "./event-publisher.js";
export { PgCommandJournal } from "./command-journal.js";
export { PgLeaseStore } from "./lease-store.js";
export { PgRequestJournal } from "./request-journal.js";
export { PgInquiryStore } from "./inquiries.js";
export { PgCapabilityPublication } from "./capability-publication.js";
export { PgInboxIngress, PgInboxConsumerStore, PgOutboxDispatchStore } from "./inbox-outbox.js";
export { PgIdentityRepository, PgAgencyRepository, PgMembershipRepository, PgInvitationRepository, PgSecurityEventRepository } from "./repositories/tenancy.js";
export { PgProcessingAuthorityRepository, PgEndClientRepository, PgProjectRepository, PgDatasetRevisionRepository, PgTargetContractRepository, PgCapabilityRepository } from "./repositories/workspace.js";
export { PgSupportCaseRepository } from "./repositories/support-cases.js";
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
// payments and fiscal workflow (package B09; docs/design/B09-payments-fiscal.md §5, §14 M1)
export { createCommerceRepositories } from "./repositories/commerce-repositories.js";
export type { CommerceWriteContext } from "./repositories/commerce-shared.js";
export { PgPaymentRouteRepository, PgFiscalRepository, PgCorporateGrantRepository, PgRefundPolicyRepository, PgPricePolicyRepository, PgScopeIndex } from "./repositories/commerce-platform.js";
export { PgQuoteRepository } from "./repositories/commerce-quotes.js";
export { PgPaymentOrderRepository, PgPaymentAttemptRepository, PgProviderObservationRepository } from "./repositories/commerce-orders.js";
export { PgCaptureFactRepository, PgCommercialAuthorizationRepository, PgPurchaseRebindingRepository } from "./repositories/commerce-captures.js";
export { PgRefundRepository, PgReconciliationCaseRepository, PgProviderExceptionRepository } from "./repositories/commerce-refunds.js";
export { PgTaxDocumentRepository, PgLedgerRepository, PgSettlementRepository, PgPaymentInboxRepository } from "./repositories/commerce-finance.js";
export { PgCommercialInspections } from "./repositories/commerce-inspections.js";
export type { CommercialConsequence } from "./repositories/commerce-inspections.js";
// the payment service's side (package B09, stage-2 mandate M3): the column-scoped purchased subject (D-CORE-B2), the periodic
// pass's queries (D-PROTO-B4) and the provider ingress's own security facts (D-FACT-B1)
export { PgPurchasedSubjects } from "./repositories/commerce-subject.js";
export type { PurchasedSubjectFacts, QuotedSubject } from "./repositories/commerce-subject.js";
export { PgPaymentSweeps } from "./repositories/commerce-sweeps.js";
export type { AgencyWithPayments, SweptAttempt } from "./repositories/commerce-sweeps.js";
export { PgIngressFactRecorder } from "./ingress-facts.js";
export type { IngressFact, IngressFactRecorder } from "./ingress-facts.js";
// the request side's reads (implementation mandate M4; D-REQ-B2); its purchased subject is PgPurchasedSubjects above (D-INT2-B2)
export { PgCommerceRequestReads } from "./repositories/commerce-request-reads.js";
export type { RequestTransitionSubject } from "./repositories/commerce-request-reads.js";
// the seams of the B07 + B09 merge: the source lifecycle's answers to the payments workflow (docs/design/B07-B09-merge.md)
export { PgCommercialSourceReads } from "./source/commercial-reads.js";
export type { CommercialSourceAvailability, CommercialSourceLineage } from "./source/commercial-reads.js";
