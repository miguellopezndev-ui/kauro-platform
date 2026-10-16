import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { buildSourceProfile } from '../../src/profile/source-profile.js';
import {
  CANDIDATE_SET_VERSION,
  assertCandidateSetMatches,
  buildCandidateSet,
  candidatesOf,
  hashCandidateSet,
  loadCandidateSet,
  serializeCandidateSet,
} from '../../src/profile/candidate-set.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { canonicalJsonText } from '../../src/util/json.js';
import { GOLDEN_ROOT, caseScratch, listCases, repoRoot, runFixture } from '../support/harness.js';

/**
 * CandidateSetV1: the space a proposal may choose inside, bound to one reading
 * and carrying no authority.
 *
 * The cases here are about the three properties the seam rests on: that a set
 * is derived from deterministic facts and is the same bytes twice; that no
 * candidate can carry authority and a reader refuses one that tries; and that a
 * set about another bundle, profile, configuration or revision is refused
 * rather than partly honoured.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');

function profileOf(name: string) {
  const configPath = join(FIXTURES, 'clean-only.json');
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  const profiled = buildSourceProfile({ inputRoot: join(FIXTURES, 'input'), config: loaded.config, scratch: caseScratch(name) });
  return { loaded, profiled };
}

const refused = (code: string, fragment?: string) => (error: unknown) =>
  isMigrationError(error) && error.code === code && (fragment === undefined || error.message.includes(fragment));

describe('a candidate set is derived from the profile, deterministically', () => {
  it('names key candidates and ambiguous shapes from the profile alone', () => {
    const { loaded, profiled } = profileOf('cs-basic');
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });
    assert.equal(set.candidateSet.candidateSetVersion, CANDIDATE_SET_VERSION);
    const types = new Set([...candidatesOf(set)].map((candidate) => candidate.candidateType));
    assert.ok(types.has('KEY_CANDIDATE'));
    // One per column the profile itself marks as a key candidate, and no other:
    // the set is derived from the profile rather than from a second opinion.
    const keyRefs = [...candidatesOf(set)].filter((c) => c.candidateType === 'KEY_CANDIDATE').flatMap((c) => c.sourceRefs);
    const fromProfile = profiled.profile.files.flatMap((file) =>
      file.sheets.flatMap((sheet) =>
        sheet.candidateKeyColumns.map((index) => sheet.columns.find((column) => column.columnIndex === index)?.columnLocatorId ?? ''),
      ),
    );
    assert.ok(fromProfile.length >= 2);
    assert.deepEqual([...keyRefs].sort(), [...fromProfile].sort());
    for (const candidate of candidatesOf(set)) {
      assert.equal(candidate.constraints.authority, 'NONE');
      assert.equal(candidate.constraints.destructiveAllowed, false);
      assert.equal(candidate.constraints.identityAutoMergeAllowed, false);
      assert.match(candidate.candidateRef, /^cand_[0-9a-f]{16}$/u);
    }
    assert.equal(set.candidateSet.refs.bundleId, profiled.profile.bundleId);
    assert.equal(set.candidateSet.refs.profileHash, profiled.profileHash);
    assert.equal(set.candidateSet.refs.configHash, loaded.configHash);
    assert.equal(set.candidateSet.limits.truncated, false);
  });

  it('is the same bytes twice, and sorted by reference', () => {
    const a = profileOf('cs-det-a');
    const b = profileOf('cs-det-b');
    const first = buildCandidateSet({ profile: a.profiled, configHash: a.loaded.configHash });
    const second = buildCandidateSet({ profile: b.profiled, configHash: b.loaded.configHash });
    assert.equal(first.candidateSetHash, second.candidateSetHash);
    assert.equal(serializeCandidateSet(first), serializeCandidateSet(second));
    const refs = first.candidateSet.candidates.map((candidate) => candidate.candidateRef);
    assert.deepEqual(refs, [...refs].sort());
  });

  it('adds duplicate clusters from a run, as candidates and never as merges', () => {
    const caseId = listCases(GOLDEN_ROOT).find((id) => id.startsWith('G06-'));
    assert.ok(caseId !== undefined);
    const run = runFixture(GOLDEN_ROOT, caseId, { scratchName: 'cs-duplicates' });
    const configPath = join(GOLDEN_ROOT, caseId, 'config.json');
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
    const profiled = buildSourceProfile({ inputRoot: join(GOLDEN_ROOT, caseId, 'input'), config: loaded.config, scratch: caseScratch('cs-duplicates-profile') });
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash, truth: run.result.truth });
    const clusters = [...candidatesOf(set)].filter((candidate) => candidate.candidateType === 'DUPLICATE_CLUSTER');
    assert.equal(clusters.length, run.result.truth.duplicateCandidateClusters);
    for (const cluster of clusters) {
      assert.equal(cluster.allowedPrimitiveRefs.join(','), 'REVIEW_ONLY');
      assert.equal(cluster.constraints.identityAutoMergeAllowed, false);
      assert.ok((cluster.impactCounts['rows'] ?? 0) >= 2);
    }
    assert.equal(run.result.reconciliation.identity.provenMerges, 0, 'the false duplicates did not merge in the run either');
  });

  it('bounds the set and says when it was cut', () => {
    const { loaded, profiled } = profileOf('cs-bounded');
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash, maxItems: 1 });
    assert.equal(set.candidateSet.candidates.length, 1);
    assert.equal(set.candidateSet.limits.truncated, true);
    assert.ok(set.candidateSet.limits.produced > 1);
    assert.throws(() => buildCandidateSet({ profile: profiled, configHash: loaded.configHash, maxItems: 0 }), refused('CANDIDATE_SET_INVALID'));
  });
});

describe('a candidate set is read back only when it is what it claims', () => {
  it('survives serialisation and refuses a tampered hash', () => {
    const { loaded, profiled } = profileOf('cs-roundtrip');
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });
    const text = serializeCandidateSet(set);
    const reloaded = loadCandidateSet(text, 'candidate-set.json');
    assert.equal(reloaded.candidateSetHash, set.candidateSetHash);
    assert.deepEqual(reloaded.candidateSet, set.candidateSet);

    const tampered = text.replace(set.candidateSetHash, `${'0'.repeat(63)}1`);
    assert.throws(() => loadCandidateSet(tampered, 'candidate-set.json'), refused('CANDIDATE_SET_INVALID', 'does not hash'));
  });

  it('refuses a candidate that carries authority, by shape and by value', () => {
    const { loaded, profiled } = profileOf('cs-authority');
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });
    const first = set.candidateSet.candidates[0];
    assert.ok(first !== undefined);

    // An unknown key that would carry a permission: refused by the closed schema.
    const widened = {
      ...set.candidateSet,
      candidates: [{ ...first, mergeAuthority: 'PROVEN' }, ...set.candidateSet.candidates.slice(1)],
    };
    const widenedText = canonicalJsonText({ candidateSetHash: hashCandidateSet(widened as never), candidateSet: JSON.parse(JSON.stringify(widened)) });
    assert.throws(() => loadCandidateSet(widenedText, 'candidate-set.json'), refused('CANDIDATE_SET_INVALID', 'schema'));

    // A known key with the wrong value: refused before the hash is even compared.
    const flipped = {
      ...set.candidateSet,
      candidates: [
        { ...first, constraints: { ...first.constraints, identityAutoMergeAllowed: true } },
        ...set.candidateSet.candidates.slice(1),
      ],
    };
    const flippedText = canonicalJsonText({ candidateSetHash: hashCandidateSet(flipped as never), candidateSet: JSON.parse(JSON.stringify(flipped)) });
    assert.throws(() => loadCandidateSet(flippedText, 'candidate-set.json'), refused('CANDIDATE_SET_INVALID', 'invariants'));
  });

  it('refuses null, an array, prose and a bare version', () => {
    for (const text of ['null', '[]', 'not json', '{"candidateSetVersion":"1.0.0"}', '{"candidateSet":{"candidateSetVersion":"1.0.0"}}']) {
      assert.throws(() => loadCandidateSet(text, 'candidate-set.json'), refused('CANDIDATE_SET_INVALID'), text);
    }
  });

  it('refuses a set built for another revision, and one about another reading', () => {
    const { loaded, profiled } = profileOf('cs-refs');
    const set = buildCandidateSet({ profile: profiled, configHash: loaded.configHash });

    const otherCore = { ...set.candidateSet, refs: { ...set.candidateSet.refs, coreVersion: '9.9.9' } };
    const otherCoreText = canonicalJsonText({ candidateSetHash: hashCandidateSet(otherCore), candidateSet: JSON.parse(JSON.stringify(otherCore)) });
    assert.throws(() => loadCandidateSet(otherCoreText, 'candidate-set.json'), (error: unknown) =>
      isMigrationError(error) && error.code === 'CANDIDATE_SET_INVALID' && error.details['reason'] === 'REVISION_MISMATCH');

    assert.doesNotThrow(() => assertCandidateSetMatches(set, { bundleId: profiled.profile.bundleId, profileHash: profiled.profileHash, configHash: loaded.configHash }));
    assert.throws(
      () => assertCandidateSetMatches(set, { bundleId: 'B-0000000000000000', profileHash: profiled.profileHash }),
      (error: unknown) => isMigrationError(error) && error.code === 'CANDIDATE_SET_INVALID' && error.details['reason'] === 'REFS_MISMATCH',
    );
    assert.throws(
      () => assertCandidateSetMatches(set, { bundleId: profiled.profile.bundleId, profileHash: '0'.repeat(64) }),
      (error: unknown) => isMigrationError(error) && error.code === 'CANDIDATE_SET_INVALID' && error.details['reason'] === 'REFS_MISMATCH',
    );
    assert.throws(
      () => assertCandidateSetMatches(set, { bundleId: profiled.profile.bundleId, profileHash: profiled.profileHash, configHash: '1'.repeat(64) }),
      (error: unknown) => isMigrationError(error) && error.code === 'CANDIDATE_SET_INVALID' && error.details['reason'] === 'REFS_MISMATCH',
    );
  });
});
