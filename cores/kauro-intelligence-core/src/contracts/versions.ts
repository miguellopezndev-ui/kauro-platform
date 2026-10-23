/**
 * Every version this core declares, each on its own line, and the ranges of
 * the Migration Core contracts it accepts. A combination that is not declared
 * here fails closed with INCOMPATIBLE_CONTRACT_VERSION; nothing negotiates.
 *
 * The Migration Core figures are read from the frozen package at build time
 * by tools/contracts-check.mjs, which refuses a tree whose ranges do not
 * contain what the vendored release actually declares.
 */
import { CANDIDATE_SET_VERSION, CONFIG_SCHEMA_VERSION, CORE_VERSION, IDENTITY_RULE_VERSION, PACKAGE_FORMAT_VERSION, SOURCE_PROFILE_VERSION, TARGET_CONTRACT_VERSION } from 'kauro-migration-core';

// The closed design of package B03 moves these together, once (D3-VER-1): core 0.5.0, envelope 2.0.0, proposal 2.0.0, prompt bundle 1.2.0, compiler contract 2.0.0, run ledger 2.0.0, configuration 2.0.0, receipt 2.0.0. docs/COMPATIBILITY_MATRIX.md follows.
export const INTELLIGENCE_CORE_VERSION = '0.6.0';
/** The pinned model policy is not qualified until the three funded runs pass on the release subject (B04 D4-REL-2); the release candidate says so, and 0.6.0 is the release that changes it. */
export const MODEL_POLICY_QUALIFICATION = 'UNQUALIFIED' as const;
export const ENVELOPE_SCHEMA_VERSION = '2.0.0';
export const PROPOSAL_SCHEMA_VERSION = '2.0.0';
export const PROMPT_BUNDLE_VERSION = '1.3.0';
export const MODEL_POLICY_VERSION = '2.0.0';
export const MEMORY_CONTRACT_VERSION = '1.0.0';
export const COMPILER_CONTRACT_VERSION = '2.0.0';
export const BENCHMARK_FORMAT_VERSION = '1.1.0';
export const RUN_LEDGER_VERSION = '2.0.0';
/** The CandidateConfiguration the core hands the host's validation port (fragments named by decision and hash; D3-CFG-1). */
export const CANDIDATE_CONFIGURATION_VERSION = '2.0.0';
/** The validation receipt the port answers with (the core's config hash and the closed effects block; D3-CFG-3). */
export const VALIDATION_RECEIPT_VERSION = '2.0.0';

/** The Migration Core contract versions this core was built against and accepts. */
export const SUPPORTED_MIGRATION_CORE = Object.freeze({
  coreVersions: Object.freeze(['3.1.0']),
  packageFormatVersions: Object.freeze(['2.1.0']),
  configSchemaVersions: Object.freeze(['3.0.0']),
  sourceProfileVersions: Object.freeze(['1.0.0']),
  candidateSetVersions: Object.freeze(['1.0.0']),
  targetContractVersions: Object.freeze(['1.0.0']),
  identityRuleVersions: Object.freeze(['1.0.0']),
});

/** What the vendored package actually declares, read from it rather than typed here. */
export const VENDORED_MIGRATION_CORE = Object.freeze({
  coreVersion: CORE_VERSION,
  packageFormatVersion: PACKAGE_FORMAT_VERSION,
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  sourceProfileVersion: SOURCE_PROFILE_VERSION,
  candidateSetVersion: CANDIDATE_SET_VERSION,
  targetContractVersion: TARGET_CONTRACT_VERSION,
  identityRuleVersion: IDENTITY_RULE_VERSION,
});

export interface CompatibilityMatrix {
  readonly intelligenceCoreVersion: string;
  readonly envelopeSchemaVersion: string;
  readonly proposalSchemaVersion: string;
  readonly promptBundleVersion: string;
  readonly modelPolicyVersion: string;
  readonly modelPolicyQualification: typeof MODEL_POLICY_QUALIFICATION;
  readonly memoryContractVersion: string;
  readonly compilerContractVersion: string;
  readonly benchmarkFormatVersion: string;
  readonly runLedgerVersion: string;
  readonly candidateConfigurationVersion: string;
  readonly validationReceiptVersion: string;
  readonly supportedMigrationCore: typeof SUPPORTED_MIGRATION_CORE;
  readonly vendoredMigrationCore: typeof VENDORED_MIGRATION_CORE;
}

export function compatibilityMatrix(): CompatibilityMatrix {
  return {
    intelligenceCoreVersion: INTELLIGENCE_CORE_VERSION,
    envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
    proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
    promptBundleVersion: PROMPT_BUNDLE_VERSION,
    modelPolicyVersion: MODEL_POLICY_VERSION,
    modelPolicyQualification: MODEL_POLICY_QUALIFICATION,
    memoryContractVersion: MEMORY_CONTRACT_VERSION,
    compilerContractVersion: COMPILER_CONTRACT_VERSION,
    benchmarkFormatVersion: BENCHMARK_FORMAT_VERSION,
    runLedgerVersion: RUN_LEDGER_VERSION,
    candidateConfigurationVersion: CANDIDATE_CONFIGURATION_VERSION,
    validationReceiptVersion: VALIDATION_RECEIPT_VERSION,
    supportedMigrationCore: SUPPORTED_MIGRATION_CORE,
    vendoredMigrationCore: VENDORED_MIGRATION_CORE,
  };
}

export interface DeclaredVersions {
  readonly envelopeSchemaVersion?: string;
  readonly proposalSchemaVersion?: string;
  readonly sourceProfileVersion?: string;
  readonly candidateSetVersion?: string;
  readonly targetContractVersion?: string | null;
  readonly configSchemaVersion?: string;
  readonly coreVersion?: string;
}

/**
 * The problems with a set of declared versions, each naming the field, what
 * was declared and what is accepted. Empty means compatible.
 */
export function compatibilityProblems(declared: DeclaredVersions): readonly string[] {
  const problems: string[] = [];
  const accept = (field: string, value: string | null | undefined, accepted: readonly string[], required: boolean): void => {
    if (value === undefined || value === null) {
      if (required) problems.push(`${field} is not declared`);
      return;
    }
    if (!accepted.includes(value)) problems.push(`${field} ${value} is not one this core accepts (${accepted.join(', ')})`);
  };
  accept('envelopeSchemaVersion', declared.envelopeSchemaVersion, [ENVELOPE_SCHEMA_VERSION], true);
  accept('proposalSchemaVersion', declared.proposalSchemaVersion, [PROPOSAL_SCHEMA_VERSION], false);
  accept('sourceProfileVersion', declared.sourceProfileVersion, SUPPORTED_MIGRATION_CORE.sourceProfileVersions, true);
  accept('candidateSetVersion', declared.candidateSetVersion, SUPPORTED_MIGRATION_CORE.candidateSetVersions, true);
  accept('targetContractVersion', declared.targetContractVersion, SUPPORTED_MIGRATION_CORE.targetContractVersions, false);
  accept('configSchemaVersion', declared.configSchemaVersion, SUPPORTED_MIGRATION_CORE.configSchemaVersions, false);
  accept('coreVersion', declared.coreVersion, SUPPORTED_MIGRATION_CORE.coreVersions, false);
  return problems;
}

/** The vendored package against the ranges; a build fails when this is not empty. */
export function vendoredCompatibilityProblems(): readonly string[] {
  return compatibilityProblems({
    envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
    sourceProfileVersion: VENDORED_MIGRATION_CORE.sourceProfileVersion,
    candidateSetVersion: VENDORED_MIGRATION_CORE.candidateSetVersion,
    targetContractVersion: VENDORED_MIGRATION_CORE.targetContractVersion,
    configSchemaVersion: VENDORED_MIGRATION_CORE.configSchemaVersion,
    coreVersion: VENDORED_MIGRATION_CORE.coreVersion,
  });
}
