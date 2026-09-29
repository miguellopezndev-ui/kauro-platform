/**
 * @kauro/persistence/testing — the test-only surface of the persistence package: the temporary PostgreSQL 17 cluster
 * (initdb/pg_ctl on a free 127.0.0.1 port, the migrations applied as the owner, one login role in each runtime group:
 * kauro_app, kauro_control, kauro_assurance, kauro_validator, kauro_ingress and kauro_payment), the harness of verified pools and
 * fixtures written through the adapters and the evidence recorders (with the commerce unit-of-work factory of package B09 and the
 * control plane's commerce configuration), the B07 source-lifecycle fixture (a revision sealed through the real upload,
 * inspection, selection, evaluation and seal path), the B09 purchase fixtures and the deterministic interleaving helpers
 * (lock-wait observation, barrier).
 *
 * It is a separate export subpath so that no production import graph carries process-spawning test code: the package's
 * main entry (`@kauro/persistence`) exports none of it, and the architecture gate refuses an import of this subpath from any
 * production source file (architecture.rules.json `testOnlySubpaths`). Tests of this package and of the entrypoints import
 * it; nothing is ever wired into a deployment.
 */
export { startTemporaryPostgres, ROLES, TEST_CLOCK_OFFSET_SETTING, TEST_CLOCK_FUNCTION, TEST_CLOCK_COMMENT } from "./temporary-postgres.js";
export type { TemporaryPostgres, StartOptions, LoginRole } from "./temporary-postgres.js";
export { start as startHarness, waitForLockWait, settlesOrWaits, backendPid, barrier, CAPABILITY_PUBLICATION_PATH } from "./harness.js";
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
