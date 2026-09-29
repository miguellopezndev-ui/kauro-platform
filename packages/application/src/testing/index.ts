/**
 * `@kauro/application/testing` — the TEST-ONLY subpath of the labelled contract fakes of the provider ports of the source lifecycle
 * (B07 mandate B07-PROVIDER-FAKES; design docs/design/B07-upload-source-lifecycle.md §2, §15, §17 item 15) and of the two cores'
 * ports (B08 mandate B08-CORE-PORTS; design docs/design/B08-audit-approval-jobs.md §10, §13 D8-FAKE-1).
 *
 * Architecture rule `testOnlySubpaths`: only files under a package's `test/` directory may import this subpath, so no deployable
 * import graph — no composition root of `apps/api` or `apps/control` — can bind one of these fakes (a deployment answers
 * SOURCE_SERVICES_UNAVAILABLE, or for the cores INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE, until the real adapters are bound).
 * Every fake here has exactly one owner, implements its port's documented contract, reports `evidenceClass: "SIMULATED"` and names
 * a `contract-fake-*` token in every record it produces (21 "Evidence classes": a contract fake is never EXECUTED_PROVIDER or
 * EXECUTED_LOCAL). The malware scanner's fake is B07-DATA-PLANE's (`@kauro/data-plane/testing`); B06's in-memory ports stay where
 * they are (the main entry, pure orchestration tests).
 */
import type { ProviderEvidenceClass } from "../ports/source-providers.js";
import { CONTRACT_FAKE_JOURNAL_PROVIDER } from "./contract-fake-authority-journal.js";
import { CONTRACT_FAKE_STORAGE_PROVIDER } from "./contract-fake-object-storage.js";
import { CONTRACT_FAKE_VAULT_PROVIDER } from "./contract-fake-session-vault.js";

export {
  CONTRACT_FAKE_CHUNK_MULTIPLE_BYTES,
  CONTRACT_FAKE_COMPLETION_KIND,
  CONTRACT_FAKE_DEFAULT_RETENTION,
  CONTRACT_FAKE_SESSION_REF_PREFIX,
  CONTRACT_FAKE_STORAGE_PROVIDER,
  ContractFakeObjectStorage,
  ContractFakeStorageError,
  completionRefOf,
} from "./contract-fake-object-storage.js";
export type {
  ContractFakeObjectStorageOptions,
  ContractFakeStorageErrorCode,
  GenerationOrigin,
  GenerationStatus,
  ProviderCall,
  ProviderHold,
  ResumableSessionState,
  ResumableSessionView,
  RetentionPolicy,
  RetentionReadBackDocument,
  ScriptedCancellation,
  ScriptedFault,
  SessionWriteRefusal,
  SessionWriteResult,
  StorageOperation,
  StoredGenerationView,
} from "./contract-fake-object-storage.js";
export {
  CONTRACT_FAKE_VAULT_AAD_PURPOSE,
  CONTRACT_FAKE_VAULT_KEY_REF,
  CONTRACT_FAKE_VAULT_PROVIDER,
  ContractFakeSessionVault,
  ContractFakeVaultRefusal,
  contractFakeVaultTestKey,
} from "./contract-fake-session-vault.js";
export type { ContractFakeSessionVaultOptions, ContractFakeVaultRefusalReason, VaultCall } from "./contract-fake-session-vault.js";
export { CONTRACT_FAKE_JOURNAL_PROVIDER, ContractFakeAuthorityJournal, ContractFakeJournalError } from "./contract-fake-authority-journal.js";
export type { ContractFakeAuthorityJournalOptions, ContractFakeJournalErrorCode, JournalCall, JournalHold } from "./contract-fake-authority-journal.js";
export { crc32cOf, providerChecksumsOf } from "./provider-checksums.js";
export {
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

/**
 * One labelled contract fake of B07-PROVIDER-FAKES: the port it implements, its provider token, its evidence class and its
 * one owner. B08-CORE-PORTS' fakes (`ContractFakeMigrationCore`, `ContractFakeIntelligenceCore`) are exported above and
 * are SIMULATED with their own `contract-fake-*` tokens (D8-FAKE-1), but are not rows of this list: this list, and its
 * fixed length of three, is B07's own invariant (`source-provider-fakes.test.ts`), not B08's to extend.
 */
export interface ContractFakeEntry {
  readonly port: "ObjectStoragePort" | "SessionVaultPort" | "AuthorityJournalPort";
  readonly fake: string;
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly owner: "B07-PROVIDER-FAKES";
}

/** Every contract fake of B07-PROVIDER-FAKES (the integrator keeps one list per owner, §17 item 15). */
export const CONTRACT_FAKES: ReadonlyArray<ContractFakeEntry> = Object.freeze([
  Object.freeze({ port: "ObjectStoragePort", fake: "ContractFakeObjectStorage", provider: CONTRACT_FAKE_STORAGE_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
  Object.freeze({ port: "SessionVaultPort", fake: "ContractFakeSessionVault", provider: CONTRACT_FAKE_VAULT_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
  Object.freeze({ port: "AuthorityJournalPort", fake: "ContractFakeAuthorityJournal", provider: CONTRACT_FAKE_JOURNAL_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
] as const);
