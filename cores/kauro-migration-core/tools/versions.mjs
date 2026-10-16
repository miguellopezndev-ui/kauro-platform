/**
 * Every version the tree declares, read from where it is declared.
 *
 * Nothing here is a literal. The architecture gate used to assert
 * `scratch_contract_version === '1.0.0'` and `package_format_version === '2.0.0'`
 * as strings inside the gate (MC-2 item 26), which meant a deliberate bump of a
 * contract failed the gate for a reason unrelated to the architecture, and an
 * accidental change to the constant could not be told from a deliberate one.
 * What a gate may hold is a *floor* — see `tools/version-floors.mjs` — and what
 * it compares against the floor is read here, from the built module that the
 * engine itself imports.
 *
 * The capacity versions come from `tools/capacity-profiles.mjs`, which is the
 * single declaration of both the profiles version and the evidence schema
 * version; `tools/capacity.mjs` used to write a second, different evidence
 * schema version as a literal (MC-2 item 6 family), and this is where that
 * disagreement became impossible.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function distUrl(relative) {
  return new URL(`../dist/src/${relative}`, import.meta.url).href;
}

/**
 * @returns {Promise<Record<string, string>>} every declared version, by a stable key
 */
export async function readVersions() {
  const version = await import(distUrl('version.js'));
  const config = await import(distUrl('domain/config.js'));
  const profile = await import(distUrl('profile/source-profile.js'));
  const candidateSet = await import(distUrl('profile/candidate-set.js'));
  const contract = await import(distUrl('target/contract.js'));
  const attestation = await import(distUrl('target/attestation.js'));
  const scratch = await import(distUrl('scratch/scratch-store.js'));
  const capacity = await import(new URL('capacity-profiles.mjs', import.meta.url).href);
  return {
    coreVersion: version.CORE_VERSION,
    packageFormatVersion: version.PACKAGE_FORMAT_VERSION,
    sourceRegistryVersion: version.SOURCE_REGISTRY_VERSION,
    configSchemaVersion: config.CONFIG_SCHEMA_VERSION,
    sourceProfileVersion: profile.SOURCE_PROFILE_VERSION,
    candidateSetVersion: candidateSet.CANDIDATE_SET_VERSION,
    targetContractVersion: contract.TARGET_CONTRACT_VERSION,
    targetParserVersion: contract.TARGET_PARSER_VERSION,
    attestationContractVersion: attestation.ATTESTATION_CONTRACT_VERSION,
    scratchStoreContractVersion: scratch.SCRATCH_STORE_CONTRACT_VERSION,
    capacityProfilesVersion: capacity.CAPACITY_PROFILES_VERSION,
    capacityEvidenceSchemaVersion: capacity.CAPACITY_EVIDENCE_SCHEMA_VERSION,
  };
}

export { repoRoot };
