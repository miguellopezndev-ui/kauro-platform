/**
 * The versions below which a candidate is not this product.
 *
 * A floor is the one kind of version constant a gate may hold. It states what
 * the canonical documents require of the release (`CORE_VERSION 2.0.0`,
 * `PACKAGE_FORMAT_VERSION 2.0.0`, `SOURCE_PROFILE_VERSION 1.0.0`,
 * `SCRATCH_STORE_CONTRACT 1.0.0`) and what MC-3 added, and a gate compares the
 * versions the tree declares (`tools/versions.mjs`) against it with `>=`. A
 * deliberate bump therefore passes; an accidental downgrade fails; and nothing
 * here has to be edited for the gate to accept a later contract.
 *
 * `capacityEvidenceSchemaVersion` is 3.0.0 and not the 1.0.0 the roadmap named,
 * and the reason is recorded rather than smoothed over: the tree at MC-2 held
 * two different values for it (1.0.0 declared, 2.0.0 written), and MC-3 adds
 * required fields — the producer capture, the campaign, per-stage resources —
 * that no 1.0.0 or 2.0.0 reader validates. A record with new required fields is
 * a new major version, and calling it compatible with either earlier number
 * would be the claim this file exists to refuse.
 */
export const VERSION_FLOORS = Object.freeze({
  coreVersion: '2.0.0',
  packageFormatVersion: '2.0.0',
  configSchemaVersion: '2.0.0',
  sourceProfileVersion: '1.0.0',
  candidateSetVersion: '1.0.0',
  targetContractVersion: '1.0.0',
  attestationContractVersion: '1.0.0',
  scratchStoreContractVersion: '1.0.0',
  capacityProfilesVersion: '1.1.0',
  capacityEvidenceSchemaVersion: '3.0.0',
});

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export function parseSemver(text) {
  const match = SEMVER.exec(String(text));
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `a >= b` over three-part versions; anything unparseable compares as below every floor. */
export function semverAtLeast(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

/**
 * Every floor a set of declared versions fails to clear.
 *
 * @param {Record<string, string>} declared
 * @returns {string[]}
 */
export function versionFloorProblems(declared) {
  const problems = [];
  for (const [key, floor] of Object.entries(VERSION_FLOORS)) {
    const value = declared[key];
    if (value === undefined) problems.push(`${key} is not declared anywhere the tree reads it from`);
    else if (!semverAtLeast(value, floor)) problems.push(`${key} is ${String(value)}, below the floor ${floor}`);
  }
  return problems;
}
