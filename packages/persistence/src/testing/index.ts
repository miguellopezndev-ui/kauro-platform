/**
 * @kauro/persistence/testing — the test-only surface of the persistence package: the temporary PostgreSQL 17 cluster
 * (initdb/pg_ctl on a free 127.0.0.1 port, the migrations applied as the owner, one login role in each runtime group:
 * kauro_app, kauro_control, kauro_assurance, kauro_validator, kauro_ingress and kauro_payment), the harness of verified pools and
 * fixtures written through the adapters and the evidence recorders (with the commerce unit-of-work factory of package B09 and the
 * control plane's commerce configuration), the B07 source-lifecycle fixture (a revision sealed through the real upload,
 * inspection, selection, evaluation and seal path), the B09 purchase fixtures, the B08 execution fixtures (a job queued from a paid
 * purchase, admitted, launched, staged, verified and published), the B08 audit fixture (the platform's funded model pool) and the
 * deterministic interleaving helpers
 * (lock-wait observation, barrier).
 *
 * It is a separate export subpath so that no production import graph carries process-spawning test code: the package's
 * main entry (`@kauro/persistence`) exports none of it, and the architecture gate refuses an import of this subpath from any
 * production source file (architecture.rules.json `testOnlySubpaths`). Tests of this package and of the entrypoints import
 * it; nothing is ever wired into a deployment.
 */
export { startTemporaryPostgres, ROLES, TEST_CLOCK_OFFSET_SETTING, TEST_CLOCK_FUNCTION, TEST_CLOCK_COMMENT } from "./temporary-postgres.js";
export type { TemporaryPostgres, StartOptions, LoginRole } from "./temporary-postgres.js";
export { start as startHarness, waitForLockWait, settlesOrWaits, backendPid, barrier, handled, CAPABILITY_PUBLICATION_PATH } from "./harness.js";
export type { Harness, AgencyFixture, CapabilityPublicationState, LockObservation } from "./harness.js";
export {
  admitSourceFile,
  bindSourceSelection,
  countSourceSelection,
  readySourceRevision,
  sealReadyRevision,
  sealStatements,
  sealedManifestOf,
  sealSourceRevision,
  expireSealedRevision,
  appendFixtureEvent,
  appendFixtureAnchor,
  fixtureSelection,
  clockAt,
  serverInstant,
  FIXTURE_SERVICE,
  FIXTURE_STORAGE_PROVIDER,
  FIXTURE_SCANNER,
  FIXTURE_SCANNER_ENGINE_VERSION,
  FIXTURE_SIGNATURE_VERSION,
  FIXTURE_INSPECTOR_VERSION,
  FIXTURE_EVALUATOR_VERSION,
} from "./source-lifecycle.js";
export type {
  SqlSession,
  SourceFixtureScope,
  SourceFixtureSessions,
  AdmittedSourceFixture,
  BoundSourceFixture,
  CountedSourceSelection,
  SourceCounts,
  ReadySourceFixture,
  SealedSourceFixture,
  SealSourceOptions,
  FixtureEvent,
} from "./source-lifecycle.js";
export { recordQualifiedPaymentRoute, recordQualifiedFiscalIssuer, grantCorporateRole, revokeCorporateRole } from "./commerce-fixtures.js";
export type { QualifiedRoute } from "./commerce-fixtures.js";
export { activateAgency, recordReviewedFiscalProfile, issueQuote, checkoutOrder, paidPurchase } from "./commerce-purchases.js";
export type { ReviewedTreatment, QuoteInput, IssuedQuote, PurchaseInput, CheckoutOrder, PaidPurchase, ProviderIdentities } from "./commerce-purchases.js";
export { commercialUnits, commissionUnitsAhead, issueCommercialQuote, foundingQuote, qualifyingHistory } from "./commercial-recurrence.js";
export type { CommercialQuoteInput, QualifyingPurchase } from "./commercial-recurrence.js";
export { recordActiveSeller, recordProspect, recordClaim, recordFrozenAllocation, recordConversion, recordServiceAssignment, recordAssistanceAgreement } from "./sales-fixtures.js";
export type { RecordedSeller, RecordedProspect, SellerTerms } from "./sales-fixtures.js";
export { recordAccruedLine, recordEligibleLine, recordHold, recordIssuedStatement } from "./ledger-fixtures.js";
export type { LedgerLineInput, RecordedLine } from "./ledger-fixtures.js";
// the agency lifecycle of package B10 (mandate B10-AGENCY-LIFECYCLE): the agreement versions the control plane publishes, the founding
// reservation of a quote and the commission lines of a closing agency
export { publishAgreementVersions, reserveFoundingSlot, recordAcquisition, recordFirstPurchaseLine, makeLineEligible } from "./agency-fixtures.js";
export type { PublishedAgreement, PublishedAgreements, AcquiredAgency, RecordedLine as AgencyRecordedLine } from "./agency-fixtures.js";
// processing authority (package B08, mandate B08-PERSISTENCE-EXECUTION): a job walked from a paid purchase along its edges
export {
  EXECUTION_FIXTURE_SERVICE,
  EXECUTION_STAGING_LOCATION,
  EXECUTION_DELIVERY_LOCATION,
  EXECUTION_FIXTURE_CORE_VERSION,
  controlOf,
  queueJob,
  admitJob,
  launchJob,
  fixtureGeneration,
  fixtureArtifacts,
  stageJob,
  verifyJob,
  publishJob,
  endJob,
} from "./execution-fixtures.js";
export type { FixtureArtifact } from "./execution-fixtures.js";
// audit authority (package B08, mandate B08-PERSISTENCE-AUDIT): the owner's funding act of the platform's model pool (Q8-1)
export { fundPlatformPool } from "./audit-fixtures.js";
export type { FundedPoolOptions } from "./audit-fixtures.js";
