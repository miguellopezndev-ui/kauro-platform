/**
 * `@kauro/application/testing/cores` — the TEST-ONLY subpath of the labelled contract fakes of the two cores' ports (B08
 * mandate B08-CORE-PORTS; design docs/design/B08-audit-approval-jobs.md §10, §13 D8-FAKE-1).
 *
 * A separate subpath from `@kauro/application/testing`, deliberately: that one is B07-PROVIDER-FAKES' own closed inventory
 * of exactly three source-lifecycle provider fakes (`tools/test/b07-stage-one.test.mjs`), fixed before B08 existed, and is
 * never a later package's to extend. Architecture rule `testOnlySubpaths` matches any subpath under `/testing`, so this one
 * is bound the same way: only a `test/` file may import it, so no composition root of `apps/api` or `apps/control` can bind
 * a fake (a deployment answers INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE until `b05/cores`' real adapter is bound,
 * D8-PORT-1). Each fake here has exactly one owner, implements its ports' documented contract, reports
 * `evidenceClass: "SIMULATED"` and names a `contract-fake-*` token in every record it produces (21 "Evidence classes").
 */
export {
  CONTRACT_FAKE_MIGRATION_CORE_COUNTS,
  CONTRACT_FAKE_MIGRATION_CORE_PACKAGE_HASH,
  CONTRACT_FAKE_MIGRATION_CORE_TOKEN,
  CONTRACT_FAKE_MIGRATION_CORE_VERSION,
  ContractFakeMigrationCore,
} from "./contract-fake-migration-core.js";
export type {
  MigrationCoreCall,
  MigrationCoreExecuteStep,
  MigrationCoreExecutionFault,
  MigrationCoreHold,
  MigrationCoreOperation,
} from "./contract-fake-migration-core.js";
export {
  CONTRACT_FAKE_INTELLIGENCE_CORE_DEFAULT_COST_CENTS,
  CONTRACT_FAKE_INTELLIGENCE_CORE_RESERVATION,
  CONTRACT_FAKE_INTELLIGENCE_CORE_RESPONSE,
  CONTRACT_FAKE_INTELLIGENCE_CORE_TOKEN,
  ContractFakeIntelligenceCore,
} from "./contract-fake-intelligence-core.js";
export type {
  ContractFakeIntelligenceCoreOptions,
  IntelligenceCoreCall,
  IntelligenceCoreHold,
  IntelligenceCoreOperation,
  IntelligenceCoreStep,
} from "./contract-fake-intelligence-core.js";
export { INTELLIGENCE_PORT_CONTRACT } from "./core-port-contract-intelligence.js";
export type { IntelligencePortBackend, IntelligencePortContractCase, IntelligenceWorld } from "./core-port-contract-intelligence.js";
export { CORE_PORT_CONTRACT } from "./core-port-contract.js";
export type { CorePortBackend, CorePortContractCase } from "./core-port-contract.js";
