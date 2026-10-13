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
export { COMMERCIAL_UNIQUE_FAILURES } from "./sqlstate.js";
export { SQLSTATE, failureOfSqlState, SOURCE_CONSTRAINT_FAILURES, EXECUTION_CONSTRAINT_FAILURES, AUDIT_CONSTRAINT_FAILURES, commerceReplayOf, COMMERCE_REPLAY_CONSTRAINTS, COMMERCE_INTEGRITY_CONSTRAINTS } from "./sqlstate.js";
export { createPool, classifyError, KauroPool, PrivilegedRoleError, RUNTIME_ROLES } from "./pool.js";
export { claimEnvironmentMinter } from "./environment.js";
export type { DatabaseEnvironment, DatabaseEnvironmentName } from "./environment.js";
export type { PoolConfig, PoolErrorEvent, PoolErrorSink, RuntimeRole, SafeErrorClassification, VerifiedConnection } from "./pool.js";
export { PgAssuranceProofRecorder, PgValidationReceiptRecorder } from "./evidence.js";
export { PgWebSessionStore, WEB_SESSION_STATEMENT_TIMEOUT_MS } from "./web-sessions.js";
export type { StoredWebSession, NewStoredWebSession } from "./web-sessions.js";
export { PgSessionFence } from "./session-fence.js";
export type { LockedSession } from "./session-fence.js";
export { createUnitOfWorkFactory, PgUnitOfWorkFactory, PgUnitOfWork, PgSourceUnitOfWork, createCommerceUnitOfWorkFactory, PgCommerceUnitOfWorkFactory, PgCommerceUnitOfWork, commercialInspectionsOf, purchasedSubjectsOf, paymentSweepsOf, commerceRequestReadsOf, commercialSourceReadsOf, sourceStoreOf, commercialAuthorizationsOf, bankRoutesOf, bankRefundsOf, sessionFenceOf, effectInstantOf } from "./unit-of-work.js";
export { PgBankRoutes } from "./repositories/bank-routes.js";
export type { NewBankRoute, NewBankRouteVersion, NewTransferInstructions } from "./repositories/bank-routes.js";
export { PgBankRefunds } from "./repositories/bank-refunds.js";
export type { OwnerAuthorityRow, TreasuryRefundRow, NewRefundDestination, TreasuryApproval } from "./repositories/bank-refunds.js";
// processing authority (package B08, mandate B08-PERSISTENCE-EXECUTION; docs/design/B08-audit-approval-jobs.md §9, §10)
export { createExecutionUnitOfWorkFactory, PgExecutionUnitOfWorkFactory, PgExecutionUnitOfWork, executionReadsOf } from "./unit-of-work.js";
export { PgExecutionStore, PgExecutionReads, PgExecutionDiscovery, EXECUTION_CAPACITY_DOMAIN } from "./execution/index.js";
export type { ExecutionWriteContext, CheckoutCapacity } from "./execution/index.js";
// audit authority (package B08, mandate B08-PERSISTENCE-AUDIT; docs/design/B08-audit-approval-jobs.md §9, §10)
export { createAuditUnitOfWorkFactory, PgAuditUnitOfWorkFactory, PgAuditUnitOfWork, auditReadsOf, decisionArtifactResolver } from "./unit-of-work.js";
export { PgAuditStore, PgAuditReads, PgAuditDiscovery, modelTaskJournalOf } from "./audit/index.js";
export type { AuditWriteContext, ResolvedDecisionPatch, ModelTaskJournalBinding, PgModelTaskJournal } from "./audit/index.js";
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
  PgObjectHoldRepository,
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
// package B10 (docs/design/B10-commercial-domain.md; mandate B10-ADAPTERS-RECURRENCE): the commercial unit of work and the recurrence and founding adapters
export { PgCommercialUnitOfWork, PgCommercialUnitOfWorkFactory, createCommercialUnitOfWorkFactory, recurrenceOf, foundingOf } from "./commercial-unit-of-work.js";
export type { CommercialDependencies } from "./commercial-unit-of-work.js";
export { PgRecurrenceRepository } from "./repositories/commercial-recurrence.js";
export { PgFoundingRepository } from "./repositories/commercial-founding.js";
export { PgFoundingOfferReader } from "./repositories/commercial-offer.js";
export type { FoundingOffer } from "./repositories/commercial-offer.js";
// the sales and attribution records of package B10 (mandate B10-ADAPTERS-SALES; docs/design/B10-commercial-domain.md §5, §11): the
// SalesRepository and AttributionRepository adapters, the CommercialPrincipalReader, and their accessors over a unit of work
export { PgSalesRepository, PgCommercialPrincipalReader } from "./repositories/commercial-sales.js";
export type { SellerPrincipalFacts, OwnerGrantFacts } from "./repositories/commercial-sales.js";
export { PgAttributionRepository } from "./repositories/commercial-attribution.js";
export { salesOf, attributionOf, commercialPrincipalsOf } from "./commercial-sales-access.js";
export { agencyOrderPrecedesClaim } from "./commercial-prospect-access.js";
// the commission ledger, periods, statements and payouts of package B10 (mandate B10-ADAPTERS-LEDGER; docs/design/B10-commercial-domain.md
// section 6, 7, 11): the CommissionLedgerRepository and StatementRepository adapters, their accessors over a unit of work and the platform
// bindings of the recorded ports (D10-BIND-1)
export { PgCommissionLedgerRepository } from "./repositories/commercial-ledger.js";
export { PgStatementRepository } from "./repositories/commercial-statements.js";
export { ledgerOf, statementsOf } from "./commercial-ledger-access.js";
export { RecordedBankingCalendarSource, AuthorizationDeliveryCompletionSource, AUTHORIZATION_DELIVERY_EVIDENCE_DOMAIN } from "./commercial-bindings.js";
export type { RecordedCalendarVersion, RecordedCompletion } from "./commercial-bindings.js";
// the agency lifecycle of package B10 (mandate B10-AGENCY-LIFECYCLE; docs/design/B10-commercial-domain.md §4, §8.1, §11): the published
// agreement versions and acceptances CMD002 records, the closure CMD043 records with its obligations inventory, the relationship decisions
// of R2-141, and the accessor over a unit of work
export { PgAgencyLifecycleRepository } from "./repositories/commercial-agency-lifecycle.js";
export { agencyLifecycleOf } from "./commercial-agency-access.js";
// package B18: capability governance (CMD058, CMD059)
export { PgCapabilityGovernanceRepository } from "./repositories/capability-governance.js";
export { capabilityGovernanceOf } from "./capability-governance-access.js";
// CMD027's reads (mandate B10-COMMANDS-QUOTE; design §3.4, §3.5): the sealed revision's billable population, the project's live quote
export { PgQuoteReads, quoteReadsOf } from "./commercial-quote-access.js";
// the commission service's work lists (mandate B10-COMMISSION-SERVICE; docs/design/B10-commercial-domain.md §14; D10-SVC-1, D10-SVC-2):
// what its sweeps find across agencies before each item is settled in a unit of work that adopts the item's agency
export { PgCommissionWork, commissionWorkOf } from "./commission-service-access.js";
export type { DueReservation, LedgerPurchase, ReleasableFundsHold, LineOnHeldFunds } from "./commission-service-access.js";
export { ConnectionSecurityError, connectionSecurityOf, sslOptionsOf } from "./tls.js";
export type { ConnectionSecurityInput, DatabaseTls, VerifiedSslOptions } from "./tls.js";
