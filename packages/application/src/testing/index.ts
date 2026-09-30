/**
 * `@kauro/application/testing` — the TEST-ONLY subpath of the labelled contract fakes of the provider ports of the source lifecycle
 * (B07 mandate B07-PROVIDER-FAKES; design docs/design/B07-upload-source-lifecycle.md §2, §15, §17 item 15).
 *
 * Architecture rule `testOnlySubpaths`: only files under a package's `test/` directory may import this subpath, so no deployable
 * import graph — no composition root of `apps/api` or `apps/control` — can bind one of these fakes (a deployment answers
 * SOURCE_SERVICES_UNAVAILABLE until B15 binds the real adapters, D-SAPI-6). Every fake here has exactly one owner, implements its
 * port's documented contract, reports `evidenceClass: "SIMULATED"` and names a `contract-fake-*` provider token in every record it
 * produces (21 "Evidence classes": a contract fake is never EXECUTED_PROVIDER). The malware scanner's fake is B07-DATA-PLANE's
 * (`@kauro/data-plane/testing`); B06's in-memory ports stay where they are (the main entry, pure orchestration tests).
 *
 * The two cores' labelled fakes (B08 mandate B08-CORE-PORTS) are the separate test-only subpath `@kauro/application/testing/cores`
 * (`./cores.ts`), not this one: this barrel and its closed inventory (`tools/test/b07-stage-one.test.mjs`) are B07-PROVIDER-FAKES'
 * own invariant, fixed at three fakes, and are never extended by a later package.
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

/** One labelled contract fake of this subpath: the port it implements, its provider token, its evidence class and its one owner. */
export interface ContractFakeEntry {
  readonly port: "ObjectStoragePort" | "SessionVaultPort" | "AuthorityJournalPort";
  readonly fake: string;
  readonly provider: string;
  readonly evidenceClass: ProviderEvidenceClass;
  readonly owner: "B07-PROVIDER-FAKES";
}

/** Every contract fake this subpath publishes (the integrator keeps one list per owner, §17 item 15). */
export const CONTRACT_FAKES: ReadonlyArray<ContractFakeEntry> = Object.freeze([
  Object.freeze({ port: "ObjectStoragePort", fake: "ContractFakeObjectStorage", provider: CONTRACT_FAKE_STORAGE_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
  Object.freeze({ port: "SessionVaultPort", fake: "ContractFakeSessionVault", provider: CONTRACT_FAKE_VAULT_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
  Object.freeze({ port: "AuthorityJournalPort", fake: "ContractFakeAuthorityJournal", provider: CONTRACT_FAKE_JOURNAL_PROVIDER, evidenceClass: "SIMULATED", owner: "B07-PROVIDER-FAKES" }),
] as const);

// Package B09's labelled contract fakes (payments and fiscal workflow; design docs/design/B09-payments-fiscal.md §14 M2, decision
// D-FAKE-B1): one test-only subpath, one index re-exporting both packages' sets (B07 design §17 item 15). Each fake keeps its single
// owner and its label (CONTRACT_FAKE, evidence class SIMULATED); no composition root binds any of them.
export * from "../commerce/testing/index.js";
