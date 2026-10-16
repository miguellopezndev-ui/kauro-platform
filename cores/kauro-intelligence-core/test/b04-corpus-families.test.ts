/**
 * B04-FIXTURES-SUPPORTED / -BOUNDARY / -HARD — the 660 qualification fixtures, family by family.
 *
 * The fixtures are the 660 sealed in corpus/fixtures (the 12 seeds and the 648 the families plant): 600 final + 60 pilot.
 * Every expectation below is stated from what the templates planted, never from a run of IC. B04 stage 2: one file holds one
 * object the project declares (or leaves open, CAP01); the run's class follows from the planted decisions (a mapped column means
 * a draft); a task type is claimed only where the planted structure raises it; no truth expects the refusal of a proposal.
 * The input hashes are re-derived here with the data-plane profiler on the planted source, independently of the
 * generator, and compared with what the fixtures carry. Evidence class SIMULATED: synthetic structures, no provider.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { SCRATCH_BUDGET_BYTES, buildCandidateSet, createFilesystemScratchStore, loadConfig, produceSourceProfile, runMigration } from 'kauro-migration-core';
import { evidenceRefFor, fieldRefFor } from '../src/adapter/contract-adapter.js';
import { digestOf } from '../src/contracts/canonical.js';
import { FIXTURE_FAMILIES } from '../src/benchmark/fixture.js';
import type { FixtureFamily } from '../src/benchmark/fixture.js';
import { CAPABILITY_FAMILIES, CORPUS_MODES, corpusCoverageGaps, corpusSetShortfall, fingerprintOf, fixtureFromPlanted, sealCorpus, verifyCorpus } from '../src/benchmark/corpus.js';
import type { CorpusFixture, PlantedColumn, PlantedFacts, ProfileBinding } from '../src/benchmark/corpus.js';

const root = join(import.meta.dirname, '..', '..');
const readDir = (dir: string): CorpusFixture[] => readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as CorpusFixture);
const all: readonly CorpusFixture[] = readDir(join(root, 'corpus', 'fixtures'));
const ofFamily = (...families: readonly FixtureFamily[]): readonly CorpusFixture[] => all.filter((entry) => (families as readonly string[]).includes(entry.fixture.family));

const COUNTS: Readonly<Record<FixtureFamily, { final: number; pilot: number }>> = {
  SUPPORTED: { final: 200, pilot: 20 }, AMBIGUOUS_ABSTENTION: { final: 100, pilot: 10 }, SAFETY: { final: 100, pilot: 10 }, ADVERSARIAL: { final: 100, pilot: 10 }, UGLY_MULTILINGUAL_STALE: { final: 100, pilot: 10 },
};
const TASK_OF_CAPABILITY: Readonly<Record<string, string>> = {
  CAP01: 'OBJECT_MAPPING', CAP02: 'FIELD_MAPPING', CAP03: 'SEMANTIC_TYPE', CAP04: 'TRANSFORMATION_SELECTION', CAP05: 'VALUE_MAP', CAP06: 'IDENTITY_STRATEGY',
  CAP07: 'DUPLICATE_SIGNAL_STRATEGY', CAP08: 'ASSOCIATION_MAPPING', CAP09: 'UNMAPPED_HANDLING', CAP10: 'TARGET_REQUIREMENT', CAP11: 'CONSISTENCY_REVIEW', CAP12: 'SEMANTIC_REPAIR',
};

// ---- an independent derivation of the input hashes: the data-plane profiler over the planted source ----
const csvCell = (text: string): string => (/[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text);
const attestModule = (await import(pathToFileURL(join(root, 'tools', 'corpus', 'attest.mjs')).href)) as { AUTHORITY: unknown; ATTESTATION_INSTANT: string; attestationFor: (contract: unknown) => unknown };
const bindModule = (await import(pathToFileURL(join(root, 'tools', 'corpus', 'bind.mjs')).href)) as { contractOf: (planted: PlantedFacts, options?: { dryRun?: boolean }) => { contractHash: string; contract: { objects: readonly { apiName: string; fields: readonly { apiName: string }[] }[] } } | null };

function bindIndependently(planted: PlantedFacts): ProfileBinding {
  const dir = mkdtempSync(join(tmpdir(), 'b04-fam-'));
  try {
    // A fixture of several files names each column's file; a single-file one is the one file source.csv, whose record is read as a contact.
    const multi = planted.columns.some((column) => column.file !== undefined);
    const files = new Map<string, PlantedColumn[]>();
    for (const column of planted.columns) files.set(column.file ?? 'source.csv', [...(files.get(column.file ?? 'source.csv') ?? []), column]);
    for (const [path, columns] of files) {
      const rows = Math.max(...columns.map((column) => column.values.length));
      const lines = [columns.map((column) => csvCell(column.header)).join(','), ...Array.from({ length: rows }, (_, row) => columns.map((column) => csvCell(column.values[row] ?? '')).join(','))];
      writeFileSync(join(dir, path), `${lines.join('\n')}\n`);
    }
    const idOf = (path: string): string => path.replace(/\.csv$/u, '');
    const text = JSON.stringify({
      configVersion: '3.0.0', source: { system: 'fixture', namespace: 'corpus' }, target: { mode: planted.mode, importMode: 'CREATE_ONLY' },
      files: [...files.keys()].map((path) => ({ id: idOf(path), path, format: 'CSV' })),
      records: [...files].map(([path, columns]) => ({
        id: idOf(path), fileId: idOf(path), object: multi ? (planted.project?.files?.[path]?.object ?? 'CONTACT') : 'CONTACT', sourceRecordIdColumn: { header: columns[0]?.header },
        fields: [{ column: { header: columns[0]?.header }, destinationField: 'custom:source_id', semanticType: 'TEXT' }, ...columns.slice(1).flatMap((column) => (column.read === undefined ? [] : [{ column: { header: column.header }, destinationField: column.read.destination, semanticType: column.read.semanticType }]))],
      })),
    });
    const loaded = loadConfig(text, join(dir, 'config.json'));
    const contract = bindModule.contractOf(planted);
    // The dry run only reads the truth's duplicate clusters: core 3.0.0 would also demand every required destination field be mapped.
    const dryContract = bindModule.contractOf(planted, { dryRun: true });
    const scratch = createFilesystemScratchStore({ root: join(dir, 'scratch'), runId: 'profile', quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const profile = produceSourceProfile({ inputRoot: dir, config: loaded.config, scratch });
      // The columns the host reads are what Migration Core's dry run sees: its duplicate clusters join the candidate set (the audit's PROFILE step).
      let candidateSet;
      if (planted.columns.some((column) => column.read !== undefined)) {
        const dry = createFilesystemScratchStore({ root: join(dir, 'scratch-truth'), runId: 'truth', quotaBytes: SCRATCH_BUDGET_BYTES });
        try {
          const peer = { runMigration } as unknown as { runMigration: (input: Record<string, unknown>) => { truth: unknown } };
          const run = peer.runMigration({ inputRoot: dir, config: loaded.config, configHash: loaded.configHash, scratch: dry, sourceProfile: profile, ...(contract === null ? {} : { targetContract: dryContract, targetAttestation: attestModule.attestationFor(dryContract), attestationAuthorities: [attestModule.AUTHORITY], attestationInstant: attestModule.ATTESTATION_INSTANT }) });
          candidateSet = (buildCandidateSet as unknown as (input: Record<string, unknown>) => ReturnType<typeof buildCandidateSet>)({ profile, configHash: loaded.configHash, truth: run.truth });
        } finally { dry.dispose(); }
      } else candidateSet = buildCandidateSet({ profile, configHash: loaded.configHash });
      const fieldRefs: Record<string, string> = {};
      const evidenceRefs: Record<string, string> = {};
      for (const [path, columns] of files) {
        const read = profile.profile.files.find((entry) => entry.path === path)?.sheets[0]?.columns ?? [];
        assert.equal(read.length, columns.length, `the profile reads every planted column of ${path}`);
        columns.forEach((column, index) => {
          const locator = read[index]?.columnLocatorId ?? '';
          assert.equal(read[index]?.headerRaw, column.header);
          fieldRefs[column.fieldRef] = fieldRefFor(locator);
          evidenceRefs[column.fieldRef] = evidenceRefFor(`profile:${profile.profileHash}#${locator}`);
        });
      }
      return {
        inputHashes: { profileHash: profile.profileHash, candidateSetHash: candidateSet.candidateSetHash, targetContractHash: contract === null ? null : contract.contractHash, projectRevisionHash: digestOf(['rev-1', profile.profileHash]) },
        fieldRefs, evidenceRefs,
      };
    } finally { scratch.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The corpus-wide checks each family test repeats on its own fixtures. */
function commonChecks(fixtures: readonly CorpusFixture[], families: readonly FixtureFamily[]): void {
  for (const family of families) {
    const own = fixtures.filter((entry) => entry.fixture.family === family);
    assert.equal(own.filter((entry) => entry.partition === 'FINAL').length, COUNTS[family].final, `${family} final count`);
    assert.equal(own.filter((entry) => entry.partition === 'PILOT').length, COUNTS[family].pilot, `${family} pilot count`);
    assert.equal(new Set(own.map((entry) => fingerprintOf(entry))).size, own.length, `${family}: every fixture has its own fingerprint`);
    const finalPrints = new Set(own.filter((entry) => entry.partition === 'FINAL').map((entry) => fingerprintOf(entry)));
    assert.ok(own.filter((entry) => entry.partition === 'PILOT').every((entry) => !finalPrints.has(fingerprintOf(entry))), `${family}: pilot disjoint from final`);
    assert.equal(new Set(own.map((entry) => entry.fixture.fixtureId)).size, own.length, `${family}: ids are unique`);
    assert.deepEqual(new Set(own.map((entry) => entry.structure.mode)), new Set(CORPUS_MODES), `${family}: all three modes`);
  }
  const mine = fixtures.filter((entry) => (families as readonly string[]).includes(entry.fixture.family));
  const tokens = mine.flatMap((entry) => entry.canaries);
  assert.equal(new Set(tokens).size, tokens.length, 'canaries are unique across the family');
  assert.ok(mine.every((entry) => entry.canaries.length >= 2 && entry.canaries.every((canary) => /^kc_[0-9a-f]{24}$/u.test(canary))), 'every fixture carries random truth canaries');
  assert.ok(mine.every((entry) => entry.fixture.fixtureId === entry.fileName.replace(/\.json$/u, '')), 'file name = fixture id');
  // The seeded identities and the structure's own planted facts agree with the truth the fixture carries.
  for (const entry of mine) {
    assert.equal(entry.structure.family, entry.fixture.family);
    assert.equal(entry.structure.outcomeClass, entry.fixture.expectedOutcomeClass);
    assert.deepEqual([...(entry.structure.taskTypes ?? [])], [...entry.fixture.expectedTaskTypes]);
    if (entry.fixture.family !== 'SUPPORTED' || entry.structure.capability.startsWith('CAP')) assert.ok((CAPABILITY_FAMILIES as readonly string[]).includes(entry.structure.capability) || entry.structure.capability.startsWith('X-'), `${entry.fixture.fixtureId}: capability`);
  }
  // Synthetic only: every address planted is on a reserved test domain, every phone in a fictional range (the two patterned numbers of the sealed seeds excepted).
  for (const entry of mine) {
    for (const column of entry.structure.columns) {
      for (const value of column.values) {
        for (const address of value.match(/[\w.+-]+@[\w.-]+\.[a-z]+/giu) ?? []) assert.match(address, /@[\w.-]*(example\.test|sample\.invalid|example\.invalid|corpus\.test)$/iu, `${entry.fixture.fixtureId}: ${address}`);
        for (const phone of value.match(/\+\d[\d ()-]{7,}\d/gu) ?? []) assert.match(phone.replace(/[\s()-]/gu, ''), /^\+(1\d{3}5550\d{3}|447700900\d{3}|34600(111222|333444))$/u, `${entry.fixture.fixtureId}: ${phone}`);
      }
    }
  }
}

/** The sealed truth equals what the generator's planted facts imply once bound to the independently derived profile. */
function checkTruthAndBinding(fixtures: readonly CorpusFixture[]): void {
  const sealed = sealCorpus(all);
  assert.deepEqual(verifyCorpus(sealed.manifest, all), [], 'the 660 fixtures verify as one sealed set');
  for (const entry of fixtures) {
    const binding = bindIndependently(entry.structure);
    const rebuilt = fixtureFromPlanted(entry.structure, { fixtureId: entry.fixture.fixtureId, partition: entry.partition, canaries: entry.canaries, binding });
    assert.deepEqual(entry.fixture, rebuilt.fixture, `${entry.fixture.fixtureId}: truth and input hashes are the planted ones bound to the real profile`);
    const contract = bindModule.contractOf(entry.structure);
    if (entry.structure.mode === 'CLEAN_ONLY') assert.equal(contract, null);
    else {
      assert.ok(contract);
      const names = new Set(contract.contract.objects.flatMap((object) => object.fields.map((field) => field.apiName.toLowerCase())));
      assert.equal(contract.contract.objects.reduce((sum, object) => sum + object.fields.length, 0), entry.structure.objects.reduce((sum, object) => sum + object.fields.length, 0), 'the contract holds exactly the planted target fields');
      assert.ok(names.size > 0);
    }
  }
}

describe('B04-CORPUS-FAMILIES', () => {
  it('SUPPORTED: 220 distinct sealed fixtures cover the twelve families and three modes', () => {
    const supported = ofFamily('SUPPORTED');
    commonChecks(all, ['SUPPORTED']);
    const finals = supported.filter((entry) => entry.partition === 'FINAL');
    for (const capability of CAPABILITY_FAMILIES) for (const mode of CORPUS_MODES) assert.ok(finals.some((entry) => entry.structure.capability === capability && entry.structure.mode === mode), `${capability}/${mode} has no SUPPORTED fixture`);
    assert.ok(corpusCoverageGaps(all).filter((gap) => gap.includes('SUPPORTED')).length === 0, corpusCoverageGaps(all).join('|'));
    for (const entry of supported) {
      const fixture = entry.fixture;
      assert.equal(fixture.expectedOutcomeClass, 'PROPOSED');
      assert.ok(fixture.expectedCandidates.some((candidate) => candidate.decision === 'MAP'), `${fixture.fixtureId}: at least one planted MAP`);
      assert.ok(!fixture.gates.safetyCritical && fixture.gates.injectionSentinels.length === 0 && fixture.gates.secretSentinels.length === 0 && fixture.gates.foreignRefs.length === 0 && !fixture.gates.identityUnproven, `${fixture.fixtureId}: a supported fixture plants no hazard`);
      assert.ok(fixture.expectedCandidates.every((candidate) => candidate.decision === 'MAP' || candidate.decision === 'PRESERVE'), `${fixture.fixtureId}: supported decisions are MAP or PRESERVE`);
      assert.ok(fixture.expectedTaskTypes.every((taskType) => taskType === TASK_OF_CAPABILITY[entry.structure.capability]), `${fixture.fixtureId}: a task type is claimed only for its own capability`);
      if (entry.structure.capability === 'CAP01') assert.deepEqual([...fixture.expectedTaskTypes], ['OBJECT_MAPPING'], `${fixture.fixtureId}: the object is the question`);
      if (entry.structure.capability === 'CAP01') assert.equal(entry.structure.project?.object, null);
      if (entry.structure.capability === 'CAP05' && entry.structure.mode !== 'CLEAN_ONLY') assert.deepEqual([...fixture.expectedTaskTypes], ['VALUE_MAP'], `${fixture.fixtureId}: the values are put to the value map`);
      // One file holds one object (a source of several files: each of them), and a fixture names the file of every column or of none.
      const objectsOfFile = new Map<string, Set<string | undefined>>();
      for (const candidate of fixture.expectedCandidates.filter((entry) => entry.decision === 'MAP')) objectsOfFile.set(candidate.filePath ?? 'source.csv', (objectsOfFile.get(candidate.filePath ?? 'source.csv') ?? new Set()).add(candidate.destinationField?.split('.')[0]));
      assert.ok([...objectsOfFile.values()].every((objects) => objects.size === 1), `${fixture.fixtureId}: one file holds one object`);
      assert.ok(entry.structure.columns.every((column) => (column.file === undefined) === entry.structure.columns.every((other) => other.file === undefined)), `${fixture.fixtureId}: a fixture names the file of every column or of none`);
      assert.deepEqual(fixture.expectedCandidates.length, entry.structure.columns.length, 'every planted source column has a decision');
    }
    // Explicit alternatives: a real share of the fixtures plants more than one acceptable destination, spelled out.
    const withAlternatives = supported.filter((entry) => entry.fixture.expectedCandidates.some((candidate) => (candidate.allowedDestinationFields?.length ?? 0) >= 2));
    // One file holds one object: the alternatives are the twins an object offers (a phone or the mobile one, a website or the domain).
    assert.ok(withAlternatives.length >= 15, `explicit alternatives in ${String(withAlternatives.length)} fixtures`);
    for (const entry of withAlternatives) for (const candidate of entry.fixture.expectedCandidates) if (candidate.allowedDestinationFields !== undefined) assert.ok(candidate.destinationField !== undefined && candidate.allowedDestinationFields.includes(candidate.destinationField));
    // Transformations and semantic types the planted values call for are fixed in the truth.
    // The primitives a run can be asked for: the parameterised ones under declared or shaped evidence, and those a model names with its own mapping.
    for (const primitive of ['NORMALISE_EMAIL_CASE', 'PARSE_PHONE_E164', 'PARSE_DATE_ISO', 'NORMALISE_NUMBER', 'TRIM_WHITESPACE']) assert.ok(supported.some((entry) => entry.fixture.expectedCandidates.some((candidate) => candidate.transformPrimitive === primitive)), primitive);
    assert.ok(supported.some((entry) => entry.structure.project?.locale !== undefined), 'a declared locale is planted where a parameter stands on it');
    assert.ok(supported.some((entry) => entry.fixture.expectedCandidates.some((candidate) => candidate.semanticType !== undefined)), 'semantic types are fixed where the shapes read them');
    assert.ok(supported.some((entry) => entry.fixture.expectedPreserved.length > 0));
    assert.ok(supported.some((entry) => entry.fixture.expectedCandidates.some((candidate) => (candidate.requiredEvidenceRefs?.length ?? 0) > 0)));
    assert.ok(supported.some((entry) => entry.fixture.forbiddenDestinationFields.length > 0), 'some supported fixtures forbid invented destinations');
    checkTruthAndBinding(supported);
  });

  it('AMBIGUOUS_ABSTENTION and SAFETY: 220 distinct sealed fixtures, each with a hard-gate marker or expected abstention', () => {
    const boundary = ofFamily('AMBIGUOUS_ABSTENTION', 'SAFETY');
    commonChecks(all, ['AMBIGUOUS_ABSTENTION', 'SAFETY']);
    assert.equal(boundary.length, 220);
    assert.ok(corpusCoverageGaps(all).filter((gap) => gap.includes('AMBIGUOUS_ABSTENTION') || gap.includes('SAFETY')).length === 0, corpusCoverageGaps(all).join('|'));
    const marked = (entry: CorpusFixture): boolean => entry.fixture.gates.identityUnproven || entry.fixture.gates.injectionSentinels.length + entry.fixture.gates.foreignRefs.length + entry.fixture.gates.secretSentinels.length > 0;
    for (const entry of boundary) {
      const fixture = entry.fixture;
      // An abstention: a column abstained on or put to the agency, or a parameter the run must not guess (date order, phone region, separator).
      const parameterOnly = (entry.structure.tags ?? []).some((tag) => ['ambig:date-order', 'ambig:phone-region', 'ambig:decimal-separator'].includes(tag));
      const abstains = parameterOnly || fixture.expectedOutcomeClass !== 'PROPOSED' || fixture.expectedCandidates.some((candidate) => candidate.decision === 'ABSTAIN' || candidate.decision === 'AGENCY_DECISION' || candidate.decision === 'REFUSE');
      assert.ok(marked(entry) || abstains, `${fixture.fixtureId}: a hard-gate marker or an expected abstention`);
      if (fixture.family === 'AMBIGUOUS_ABSTENTION') {
        // The column it must abstain on; or, where only a parameter is ambiguous (the order of a date, the region of a phone, the role of
        // a separator), the column it must map without guessing one: a guessed parameter is refused by the compiler.
        const parameterKind = (entry.structure.tags ?? []).some((tag) => ['ambig:date-order', 'ambig:phone-region', 'ambig:decimal-separator'].includes(tag));
        assert.ok(parameterKind || fixture.expectedCandidates.some((candidate) => candidate.decision === 'ABSTAIN' || candidate.decision === 'AGENCY_DECISION'), `${fixture.fixtureId}: names the column it must abstain on`);
        assert.equal(fixture.expectedOutcomeClass === 'PROPOSED', fixture.expectedCandidates.some((candidate) => candidate.decision === 'MAP'), `${fixture.fixtureId}: the class follows from the planted decisions`);
        assert.ok(fixture.expectedCandidates.every((candidate) => candidate.decision !== 'MAP' || candidate.destinationField !== undefined || (candidate.allowedDestinationFields?.length ?? 0) > 0));
      } else {
        assert.ok(fixture.gates.safetyCritical, `${fixture.fixtureId}: a safety fixture is safety critical`);
        assert.ok(fixture.gates.identityUnproven || fixture.gates.secretSentinels.length > 0 || fixture.expectedCandidates.some((candidate) => candidate.decision === 'REFUSE' || candidate.decision === 'AGENCY_DECISION' || candidate.decision === 'PRESERVE'), `${fixture.fixtureId}: a safety marker`);
      }
    }
    const safety = ofFamily('SAFETY');
    assert.ok(safety.filter((entry) => entry.fixture.gates.identityUnproven).length >= 30);
    assert.ok(safety.filter((entry) => entry.fixture.gates.secretSentinels.length > 0).length >= 30);
    assert.ok(safety.some((entry) => entry.fixture.expectedOutcomeClass === 'REQUIRES_AGENCY_DECISION'));
    // No truth expects the refusal of a proposal: no correct run proposes a secret; it withholds it, and the egress gate watches it.
    assert.ok(all.every((entry) => entry.fixture.expectedCandidates.every((candidate) => candidate.decision !== 'REFUSE') && entry.fixture.expectedOutcomeClass !== 'REFUSED'));
    for (const entry of safety.filter((candidate) => candidate.fixture.gates.secretSentinels.length > 0)) assert.ok(entry.fixture.expectedCandidates.some((candidate) => candidate.decision === 'ABSTAIN' && entry.structure.columns.some((column) => column.header === candidate.sourceHeader && column.values.some((value) => entry.fixture.gates.secretSentinels.includes(value)))), `${entry.fixture.fixtureId}: the secret column is withheld`);
    assert.ok(safety.some((entry) => entry.structure.tags?.includes('safety:consent')), 'consent fields are exercised');
    assert.ok(safety.some((entry) => entry.structure.tags?.includes('safety:destructive')), 'destructive requests are exercised');
    const ambiguous = ofFamily('AMBIGUOUS_ABSTENTION');
    assert.ok(ambiguous.some((entry) => entry.fixture.allowedAlternatives.length > 0), 'explicit alternative outcomes');
    assert.ok(ambiguous.every((entry) => (entry.structure.tags ?? []).some((tag) => ['ambig:date-order', 'ambig:phone-region', 'ambig:decimal-separator'].includes(tag)) || entry.fixture.expectedCandidates.some((candidate) => candidate.decision === 'ABSTAIN' || candidate.decision === 'AGENCY_DECISION')));
    assert.ok(ambiguous.some((entry) => entry.fixture.forbiddenDestinationFields.length > 0), 'missing-target cases forbid the invented field');
    checkTruthAndBinding(boundary);
  });

  it('ADVERSARIAL and UGLY_MULTILINGUAL_STALE: 220 distinct sealed fixtures covering every egress surface, memory scope and cross-partition case', () => {
    const hard = ofFamily('ADVERSARIAL', 'UGLY_MULTILINGUAL_STALE');
    commonChecks(all, ['ADVERSARIAL', 'UGLY_MULTILINGUAL_STALE']);
    assert.equal(hard.length, 220);
    assert.deepEqual(corpusCoverageGaps(all), [], 'no tag cell of the corpus is empty');
    // The twelve sealed seeds predate the tag scheme; the rules below hold for every fixture the families add.
    const adversarial = ofFamily('ADVERSARIAL').filter((entry) => !entry.fixture.fixtureId.startsWith('seed-'));
    const tagsOf = (entry: CorpusFixture): readonly string[] => entry.structure.tags ?? [];
    for (const entry of adversarial) {
      const gates = entry.fixture.gates;
      assert.ok(gates.injectionSentinels.length + gates.foreignRefs.length + gates.secretSentinels.length > 0, `${entry.fixture.fixtureId}: an adversarial fixture plants a sentinel`);
      assert.ok(tagsOf(entry).some((tag) => tag.startsWith('egress:')), `${entry.fixture.fixtureId}: names the egress surface it probes`);
      // Every sentinel planted is really in the planted source, a memory entry or the target contract text.
      const text = JSON.stringify({ columns: entry.structure.columns, memory: entry.structure.memory ?? [], objects: entry.structure.objects });
      for (const sentinel of [...gates.injectionSentinels, ...gates.secretSentinels, ...gates.foreignRefs]) assert.ok(text.includes(sentinel), `${entry.fixture.fixtureId}: ${sentinel} is planted`);
    }
    for (const entry of adversarial.filter((candidate) => tagsOf(candidate).some((tag) => tag.startsWith('memory:') || tag.startsWith('cross:')))) {
      assert.ok((entry.structure.memory ?? []).length > 0, `${entry.fixture.fixtureId}: memory cases plant memory entries`);
      assert.ok(entry.fixture.gates.foreignRefs.length > 0 || entry.fixture.gates.injectionSentinels.length > 0 || (entry.structure.memory ?? []).some((memory) => memory.owner === 'SAME_CLIENT' || memory.owner === 'SAME_AGENCY'), `${entry.fixture.fixtureId}: a memory case names its foreign refs, its sentinel or its own scope's entry`);
    }
    for (const entry of adversarial) for (const memory of entry.structure.memory ?? []) if (memory.owner === 'OTHER_CLIENT' || memory.owner === 'OTHER_AGENCY') assert.ok(entry.fixture.gates.foreignRefs.includes(memory.memoryId), `${entry.fixture.fixtureId}: foreign memory ${memory.memoryId} is a foreign ref`);
    const ugly = ofFamily('UGLY_MULTILINGUAL_STALE').filter((entry) => !entry.fixture.fixtureId.startsWith('seed-'));
    for (const entry of ugly) assert.ok(tagsOf(entry).some((tag) => tag.startsWith('ugly:')) && tagsOf(entry).some((tag) => tag.startsWith('lang:')), `${entry.fixture.fixtureId}: ugly and language tags`);
    assert.ok(new Set(ugly.flatMap((entry) => tagsOf(entry).filter((tag) => tag.startsWith('lang:')))).size >= 8, 'at least eight languages or scripts');
    for (const tag of ['ugly:stale-memory', 'ugly:stale-header', 'ugly:mixed-date-formats', 'ugly:encoding', 'ugly:whitespace', 'ugly:mojibake']) assert.ok(ugly.some((entry) => tagsOf(entry).includes(tag)), tag);
    assert.ok(ugly.some((entry) => entry.structure.columns.some((column) => /[^\x00-\x7f]/u.test(column.header))), 'non-ASCII headers');
    // The full corpus, sealed in memory, is what the qualification universe asks for: 600 final + 60 pilot, all distinct, none short.
    const sealed = sealCorpus(all);
    assert.equal(all.length, 660);
    assert.deepEqual(corpusSetShortfall(sealed.manifest), []);
    checkTruthAndBinding(hard);
  });
});

// Keep the helper imports honest when a family test is trimmed during development.
void FIXTURE_FAMILIES; void mkdirSync;
