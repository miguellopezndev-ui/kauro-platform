/**
 * B04-CORPUS — corpus framework, sealing, distinctness, canaries (D4-CORP-2..4; cases S042 and R2-040).
 *
 * Truth is written from what a template planted, never from a run of IC. The expectations below are
 * stated by hand, from the planted facts, not read back from the generator. Evidence class SIMULATED:
 * no provider is called, the 600- and 660-fixture sets are synthetic structural variations.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { corpusShortfall } from '../src/benchmark/harness.js';
import { FIXTURE_FAMILIES } from '../src/benchmark/fixture.js';
import type { FixtureFamily } from '../src/benchmark/fixture.js';
import { CAPABILITY_FAMILIES, CORPUS_MODES, corpusSetShortfall, createContaminationGuard, fingerprintOf, fixtureFromPlanted, scanForContamination, sealCorpus, verifyCorpus } from '../src/benchmark/corpus.js';
import type { CorpusFixture, CorpusManifest, PlantedFacts, ValueClass } from '../src/benchmark/corpus.js';

const VALUE_CLASSES: readonly ValueClass[] = ['TEXT', 'EMAIL', 'PHONE', 'DATE', 'NUMBER', 'IDENTIFIER', 'ENUM'];
const root = join(import.meta.dirname, '..', '..');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** One example, renamed: every name and literal depends on `tag`; the structure depends on `shape` only. */
function planted(family: FixtureFamily, shape: number, tag: string): PlantedFacts {
  const supported = family === 'SUPPORTED';
  // The shape is the count of columns of each value class (base-4 digits of shape + 1): distinct shapes are distinct multisets, not permutations.
  const classes = VALUE_CLASSES.flatMap((valueClass, k) => Array.from({ length: Math.floor((shape + 1) / 4 ** k) % 4 }, () => valueClass));
  const columns = classes.map((valueClass, j) => ({
    header: `${tag}_col${String(j)}`,
    fieldRef: `${tag}:f${String(j)}`,
    valueClass,
    values: [`${tag}-v${String(j)}-a`, `${tag}-v${String(j)}-b`],
  }));
  return {
    family, mode: 'CLEAN_ONLY', capability: 'CAP02',
    outcomeClass: supported ? 'PROPOSED' : 'ABSTAINED',
    objects: [{ name: `${tag}Obj`, fields: columns.map((c, j) => ({ name: `${tag}fld${String(j)}`, valueClass: c.valueClass, required: j === 0 })) }],
    columns: columns.map((c, j) => (supported ? { ...c, decision: 'MAP' as const, destination: `${tag}Obj.${tag}fld${String(j)}` } : { ...c, decision: 'ABSTAIN' as const })),
    forbiddenDestinations: [],
    gates: { identityUnproven: !supported, injectionSentinels: [], foreignRefs: [], secretSentinels: [], safetyCritical: false },
  };
}
const canariesFor = (id: string): readonly string[] => [`kc_${id.replace(/\W/gu, '')}_canary_aaaa1111`];
const build = (p: PlantedFacts, id: string, partition: 'FINAL' | 'PILOT' = 'FINAL'): CorpusFixture => fixtureFromPlanted(p, { fixtureId: id, partition, canaries: canariesFor(id) });

/** Synthetic sealed set: 600 final in the 200/100/100/100/100 proportions plus 60 pilot in 20/10/10/10/10, every structure distinct. */
function syntheticCorpus(): readonly CorpusFixture[] {
  const out: CorpusFixture[] = [];
  const finalCounts: Record<FixtureFamily, number> = { SUPPORTED: 200, AMBIGUOUS_ABSTENTION: 100, SAFETY: 100, ADVERSARIAL: 100, UGLY_MULTILINGUAL_STALE: 100 };
  for (const family of FIXTURE_FAMILIES) {
    for (let i = 0; i < finalCounts[family]; i += 1) out.push(build(planted(family, i, `s${family.slice(0, 3)}${String(i)}`), `fx-${family}-final-${String(i)}`));
    for (let i = 0; i < finalCounts[family] / 10; i += 1) out.push(build(planted(family, 1000 + i, `p${family.slice(0, 3)}${String(i)}`), `fx-${family}-pilot-${String(i)}`, 'PILOT'));
  }
  return out;
}

describe('B04-CORPUS', () => {
  it('S042: six hundred renamings of one example have one fingerprint and fail corpusShortfall; the sealed corpus has 600 distinct fingerprints in the five families and 60 disjoint pilot fixtures', () => {
    // Renaming: 600 fixtures, same structure, different names, literals and ids.
    const renamed = Array.from({ length: 600 }, (_, i) => build(planted('SUPPORTED', 5, `r${String(i)}`), `fx-renamed-${String(i)}`));
    assert.equal(new Set(renamed.map((f) => fingerprintOf(f))).size, 1);
    assert.equal(new Set(renamed.map((f) => f.fixture.expectedTruthDigest)).size, 600, 'the fixtures differ byte for byte; only the structure is the same');
    const shortfall = corpusSetShortfall(sealCorpus(renamed).manifest);
    assert.ok(shortfall.some((line) => line.includes('fixtures=1<600')), `shortfall must count distinct fingerprints: ${shortfall.join('|')}`);
    assert.ok(shortfall.some((line) => line.startsWith('SUPPORTED=1<200')));
    assert.deepEqual(corpusShortfall(1, { SUPPORTED: 1 }).slice(0, 1), ['fixtures=1<600']);

    // The same fixture with other names, literals and column order has the same fingerprint; a structural change does not.
    const base = planted('SUPPORTED', 9, 'base');
    const other = planted('SUPPORTED', 9, 'other');
    const reordered: PlantedFacts = { ...other, columns: [...other.columns].reverse() };
    assert.equal(fingerprintOf(build(base, 'a')), fingerprintOf(build(reordered, 'b')));
    assert.notEqual(fingerprintOf(build(base, 'a')), fingerprintOf(build(planted('SUPPORTED', 10, 'base'), 'c')));
    assert.notEqual(fingerprintOf(build(base, 'a')), fingerprintOf(build(planted('SAFETY', 9, 'base'), 'a')));

    // The synthetic sealed corpus of 600 + 60.
    const corpus = syntheticCorpus();
    assert.equal(corpus.length, 660);
    const sealed = sealCorpus(corpus);
    assert.deepEqual(corpusSetShortfall(sealed.manifest), []);
    const finals = sealed.manifest.fixtures.filter((e) => e.partition === 'FINAL');
    const pilots = sealed.manifest.fixtures.filter((e) => e.partition === 'PILOT');
    assert.equal(new Set(finals.map((e) => e.fingerprint)).size, 600);
    assert.equal(pilots.length, 60);
    const finalPrints = new Set(finals.map((e) => e.fingerprint));
    assert.ok(pilots.every((e) => !finalPrints.has(e.fingerprint)), 'pilot fixtures are disjoint from the final set by fingerprint');
    for (const family of FIXTURE_FAMILIES) assert.equal(finals.filter((e) => e.family === family).length, family === 'SUPPORTED' ? 200 : 100);
    assert.deepEqual(verifyCorpus(sealed.manifest, corpus), []);

    // A pilot fixture that repeats a final structure, or a final one repeated, is reported.
    const pilotIndex = corpus.findIndex((f) => f.partition === 'PILOT');
    const dupPilot = corpus.map((f, i) => (i === pilotIndex ? build(planted('SUPPORTED', 0, 'dup'), 'fx-dup-pilot', 'PILOT') : f));
    assert.ok(corpusSetShortfall(sealCorpus(dupPilot).manifest).some((line) => /pilot/u.test(line)));
    const dupFinal = corpus.map((f, i) => (i === 1 ? build(planted('SUPPORTED', 0, 'dup2'), 'fx-dup-final') : f));
    assert.ok(corpusSetShortfall(sealCorpus(dupFinal).manifest).length > 0);
  });

  it('S042 seed: the committed corpus is sealed, the 660 fixtures with the twelve seeds among them, every fingerprint distinct, truth intact, nothing short', () => {
    const manifestBytes = readFileSync(join(root, 'corpus', 'MANIFEST.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as CorpusManifest;
    assert.equal(readFileSync(join(root, 'corpus', 'MANIFEST.sha256'), 'utf8').trim(), sha256(manifestBytes));
    assert.equal(manifest.fixtures.length, 660);
    assert.equal(new Set(manifest.fixtures.map((e) => e.fingerprint)).size, 660);
    const seedEntries = manifest.fixtures.filter((e) => e.fixtureId.startsWith('seed-'));
    assert.deepEqual(seedEntries.map((e) => e.capability).sort(), [...CAPABILITY_FAMILIES].sort(), 'one seed per capability family');
    assert.deepEqual(new Set(manifest.fixtures.map((e) => e.family)), new Set(FIXTURE_FAMILIES));
    assert.deepEqual(new Set(manifest.fixtures.map((e) => e.mode)), new Set(CORPUS_MODES));
    const files = manifest.fixtures.map((e) => JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', e.fileName), 'utf8')) as CorpusFixture);
    assert.deepEqual(verifyCorpus(manifest, files), []);
    assert.deepEqual(corpusSetShortfall(manifest), [], 'the sealed set is the qualification universe: 600 final + 60 pilot, all distinct');
    // A hand-checked planted fact: the identity-strategy seed plants no unique column and expects no auto-merge.
    const identity = files.find((f) => f.structure.capability === 'CAP06');
    assert.ok(identity);
    assert.equal(identity.fixture.gates.identityUnproven, true);
    assert.notEqual(identity.fixture.expectedOutcomeClass, 'PROPOSED');
    // Tamper: an edited truth no longer verifies.
    const tampered = files.map((f, i) => (i === 0 ? { ...f, fixture: { ...f.fixture, forbiddenDestinationFields: [...f.fixture.forbiddenDestinationFields, 'Evil.field'] } } : f));
    assert.ok(verifyCorpus(manifest, tampered).length > 0);
  });

  it('S042 independence: the corpus module and the generator import nothing that decides (resolver, compiler, planner, kernel, gateway, oracle)', () => {
    for (const file of ['src/benchmark/corpus.ts', 'tools/corpus/generate.mjs', 'tools/corpus/seed-templates.mjs', 'tools/corpus/multifile.mjs', 'tools/corpus/bind.mjs', 'tools/corpus/attest.mjs']) {
      const text = readFileSync(join(root, file), 'utf8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/gu)].map((m) => m[1] ?? '');
      for (const spec of imports) assert.ok(!/resolver|compiler|planner|kernel|gateway|oracle|adapter|memory|classifier/u.test(spec), `${file} imports ${spec}`);
    }
  });

  it('R2-040: a request receipt carrying a truth canary or a corpus file name invalidates that evaluation and blocks further funded dispatch until the corpus is resealed', () => {
    const corpus = syntheticCorpus().slice(0, 12);
    const { manifest } = sealCorpus(corpus);
    const target = manifest.fixtures[3];
    assert.ok(target);
    const canary = canariesFor(target.fixtureId)[0] as string;

    assert.deepEqual(scanForContamination('{"messages":[{"role":"user","content":"map these columns"}]}', manifest), { clean: true, hits: [] });
    const hit = scanForContamination(Buffer.from(JSON.stringify({ messages: [{ content: `see ${canary} here` }] })), manifest);
    assert.equal(hit.clean, false);
    assert.deepEqual(hit.hits.map((h) => [h.fixtureId, h.kind]), [[target.fixtureId, 'CANARY']]);
    assert.ok(!JSON.stringify(hit).includes(canary), 'the finding names the fixture and a digest, never the token');
    const named = scanForContamination(`path corpus/fixtures/${target.fileName} leaked`, manifest);
    assert.deepEqual(named.hits.map((h) => [h.fixtureId, h.kind]), [[target.fixtureId, 'FILE_NAME']]);

    const guard = createContaminationGuard(manifest);
    guard.assertMayDispatch();
    const verdict = guard.checkRequestReceipt(target.fixtureId, `x ${canary} y`);
    assert.equal(verdict.evaluationValid, false);
    assert.deepEqual(guard.invalidatedFixtures(), [target.fixtureId]);
    assert.throws(() => guard.assertMayDispatch(), /contamination|reseal/iu);
    assert.equal(guard.checkRequestReceipt(manifest.fixtures[0]?.fixtureId ?? '', 'clean').evaluationValid, true);
    assert.throws(() => guard.assertMayDispatch(), /contamination|reseal/iu, 'a clean receipt does not lift the latch');
    assert.throws(() => guard.reseal(manifest), /reseal|digest/iu);
    assert.throws(() => guard.assertMayDispatch());
    const resealed = sealCorpus(corpus.map((f) => (f.fixture.fixtureId === target.fixtureId ? { ...f, canaries: ['kc_fresh_canary_9999zzzz'] } : f)));
    guard.reseal(resealed.manifest);
    guard.assertMayDispatch();
    assert.deepEqual(guard.invalidatedFixtures(), []);
    assert.equal(scanForContamination(canary, resealed.manifest).clean, true, 'the resealed corpus no longer carries the old canary');
  });
});
