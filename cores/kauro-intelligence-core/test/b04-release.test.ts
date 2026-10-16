/**
 * B04-RELEASE-PREP: the release candidate 0.6.0-rc.1 with the UNQUALIFIED policy (B04-design D4-REL-2: before the three runs pass the
 * release is a release candidate with an unqualified policy; the flag INTELLIGENCE_CORE_RELEASE_CANDIDATE stays FALSE until evidence
 * computes it). Nothing here is qualification evidence: the policy is pinned, it is not qualified.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MODEL_POLICY_V1 } from '../src/gateway/model-gateway.js';
import { INTELLIGENCE_CORE_VERSION, MODEL_POLICY_QUALIFICATION, compatibilityMatrix } from '../src/contracts/versions.js';

const root = join(import.meta.dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

describe('B04-RELEASE-PREP: 0.6.0-rc.1 with the UNQUALIFIED policy', () => {
  it('the version is 0.6.0-rc.1 in package.json, the lockfile and versions.ts, and the compatibility matrix carries it', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version?: string }> };
    assert.equal(INTELLIGENCE_CORE_VERSION, '0.6.0');
    assert.equal(pkg.version, INTELLIGENCE_CORE_VERSION);
    assert.equal(lock.version, INTELLIGENCE_CORE_VERSION);
    assert.equal(lock.packages['']?.version, INTELLIGENCE_CORE_VERSION);
    assert.equal(compatibilityMatrix().intelligenceCoreVersion, '0.6.0');
  });

  it('the policy is pinned to Sonnet 5.5 and declared UNQUALIFIED until the three funded runs pass on the release subject', () => {
    assert.equal(MODEL_POLICY_V1.primaryModel, 'claude-sonnet-5-5');
    assert.equal(MODEL_POLICY_QUALIFICATION, 'UNQUALIFIED');
    assert.equal(compatibilityMatrix().modelPolicyQualification, 'UNQUALIFIED');
  });

  it('the compatibility matrix and the readiness page say rc.1, UNQUALIFIED and the flag FALSE, and name the pilot selection as the way the pinned policy changes', () => {
    const matrix = read('docs', 'COMPATIBILITY_MATRIX.md');
    assert.match(matrix, /^## Intelligence Core 0\.6\.0$/mu);
    assert.match(matrix, /INTELLIGENCE_CORE_VERSION \| 0\.6\.0 \|/u);
    assert.match(matrix, /UNQUALIFIED/u);
    assert.match(matrix, /kauro-intelligence-core\/benchmark/u, 'the declared campaign entry point is documented');
    const readiness = read('docs', 'IC2_READINESS.md');
    assert.match(readiness, /0\.6\.0-rc\.1/u);
    assert.match(readiness, /UNQUALIFIED/u);
    assert.match(readiness, /\| INTELLIGENCE_CORE_RELEASE_CANDIDATE \| FALSE by construction \|/u);
    assert.doesNotMatch(readiness, /INTELLIGENCE_CORE_RELEASE_CANDIDATE \| TRUE/u);
  });
});
