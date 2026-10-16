/**
 * B04 multi-file mandate (B04-design D4-CORP-6, D4-SCORE-9, D4-SCORE-10) — the corpus measures every capability family.
 *
 * Single-file fixtures cannot raise four of the twelve task types: ASSOCIATION_MAPPING (a key column names the record of another file),
 * DUPLICATE_SIGNAL_STRATEGY (Migration Core's dry run reports a cluster of records sharing a signal), IDENTITY_STRATEGY (a column the target
 * contract flags as an external id, in files whose record mappings it keys) and CONSISTENCY_REVIEW (an association key that is also a
 * mapped field). The corpus therefore plants sources of several files in the SUPPORTED family, in place of an equal number of single-file
 * fixtures, so the 660 stay 600 final + 60 pilot and the family quotas hold. Truth is planted and independent of the engine; the
 * generator checks reachability by restating the public rules over planted facts and reading the frozen data plane, never by running IC.
 * The truth-following public run then raises each task, the scorer judges the structure it leaves, and every sabotage of it is caught.
 *
 * The scorer also judges the correspondence of source values to target options of the twelve vendor value-map fixtures (D4-SCORE-9).
 * Evidence class SIMULATED: synthetic data, a scripted gateway, no provider.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, describe, it } from 'node:test';
import type { CorpusFixture, CorpusManifest, PlantedFacts } from '../src/benchmark/corpus.js';
import { FIXTURE_FAMILIES } from '../src/benchmark/fixture.js';
import type { FixtureFamily } from '../src/benchmark/fixture.js';
import { report } from '../src/benchmark/report.js';
import { scoreFixture } from '../src/benchmark/scorer.js';
import type { FixtureScore } from '../src/benchmark/scorer.js';
import { runSabotage } from '../src/benchmark/validity.js';
import type { ControlRun, PublicRunControl } from '../src/benchmark/validity.js';

const root = join(import.meta.dirname, '..', '..');
const corpus: readonly CorpusFixture[] = readdirSync(join(root, 'corpus', 'fixtures')).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', name), 'utf8')) as CorpusFixture);
const manifest = JSON.parse(readFileSync(join(root, 'corpus', 'MANIFEST.json'), 'utf8')) as CorpusManifest;
const isMulti = (entry: CorpusFixture): boolean => entry.structure.columns.some((column) => column.file !== undefined);
const multi = corpus.filter(isMulti);
const claims = (taskType: string): readonly CorpusFixture[] => multi.filter((entry) => entry.fixture.expectedTaskTypes.includes(taskType as never));

/** What the mandate plants per task: how many multi-file fixtures claim it, in which capability family, and in which modes. */
const PLAN = {
  ASSOCIATION_MAPPING: { capability: 'CAP08', count: 9, modes: ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'] },
  DUPLICATE_SIGNAL_STRATEGY: { capability: 'CAP07', count: 9, modes: ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'] },
  IDENTITY_STRATEGY: { capability: 'CAP06', count: 6, modes: ['HUBSPOT', 'SALESFORCE'] },
  CONSISTENCY_REVIEW: { capability: 'CAP11', count: 6, modes: ['CLEAN_ONLY', 'HUBSPOT'] },
} as const;
type PlannedTask = keyof typeof PLAN;
const TASKS = Object.keys(PLAN) as PlannedTask[];

const multiModule = (await import(pathToFileURL(join(root, 'tools', 'corpus', 'multifile.mjs')).href)) as {
  structureProblems: (planted: PlantedFacts) => string[];
  multiFileCell: (capability: string, mode: string, round: number) => boolean;
  multiFilePlanted: (capability: string, mode: string, draw: number) => PlantedFacts;
};
const stagedModule = (await import(pathToFileURL(join(root, 'tools', 'corpus', 'staged-set.mjs')).href)) as {
  FAMILY_PLANS: readonly { family: string; staged: number; pilotFrom: number; pilotCount: number; cell: (index: number) => { capability: string; mode: string; round: number } }[];
};
interface Controls { readonly publicRun: PublicRunControl[]; readonly alwaysAbstainRuns: FixtureScore[][]; readonly truthRuns: Map<string, ControlRun>; readonly repairControls: { fixtureId: string; correct: boolean | null; repairRounds: number }[] }
const runModule = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'validity-run.mjs')).href)) as {
  runPublicControls: (fixtures: readonly CorpusFixture[], options?: { abstainRuns?: number }) => Promise<Controls>;
};

type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
const clone = <T>(value: T): Writable<T> => JSON.parse(JSON.stringify(value)) as Writable<T>;

describe('B04-MULTIFILE: the corpus measures the four tasks one file cannot raise', () => {
  it('each of the four tasks is claimed by multi-file SUPPORTED fixtures of its own family and the modes that can raise it; the 660 stay 600 final + 60 pilot', () => {
    assert.equal(corpus.length, 660);
    for (const task of TASKS) {
      const own = claims(task);
      const plan = PLAN[task];
      assert.equal(own.length, plan.count, `${task}: ${String(own.length)} multi-file fixtures`);
      assert.ok(own.every((entry) => entry.fixture.family === 'SUPPORTED' && entry.structure.capability === plan.capability), `${task}: SUPPORTED, ${plan.capability}`);
      assert.deepEqual([...new Set(own.map((entry) => entry.structure.mode))].sort(), [...plan.modes].sort(), `${task}: the modes`);
      for (const mode of plan.modes) assert.equal(own.filter((entry) => entry.structure.mode === mode).length, plan.count / plan.modes.length, `${task}/${mode}: an equal share`);
      assert.ok(own.some((entry) => entry.partition === 'PILOT') && own.some((entry) => entry.partition === 'FINAL'), `${task}: in the final and the pilot partition`);
    }
    assert.equal(multi.length, 30, 'thirty sources of several files');
    assert.ok(multi.every((entry) => entry.fixture.family === 'SUPPORTED' && entry.fixture.expectedTaskTypes.length === 1), 'one task claimed by each, all in SUPPORTED');
    assert.ok(multi.every((entry) => new Set(entry.structure.columns.map((column) => column.file)).size >= 2), 'every one has several files');
    const counts: Record<string, number> = {};
    for (const entry of manifest.fixtures) counts[`${entry.family}/${entry.partition}`] = (counts[`${entry.family}/${entry.partition}`] ?? 0) + 1;
    const expected: Record<FixtureFamily, [number, number]> = { SUPPORTED: [200, 20], AMBIGUOUS_ABSTENTION: [100, 10], SAFETY: [100, 10], ADVERSARIAL: [100, 10], UGLY_MULTILINGUAL_STALE: [100, 10] };
    for (const family of FIXTURE_FAMILIES) assert.deepEqual([counts[`${family}/FINAL`], counts[`${family}/PILOT`]], expected[family], `${family}: the quota holds`);
    assert.equal(new Set(manifest.fixtures.map((entry) => entry.fingerprint)).size, 660, 'every fingerprint distinct');
  });

  it('they replace single-file fixtures one for one: the staged plan has the same size per family, and its multi-file cells are exactly the thirty', () => {
    const plans = stagedModule.FAMILY_PLANS;
    assert.deepEqual(plans.map((plan) => [plan.family, plan.staged]), [['SUPPORTED', 214], ['AMBIGUOUS_ABSTENTION', 109], ['SAFETY', 108], ['ADVERSARIAL', 108], ['UGLY_MULTILINGUAL_STALE', 109]], 'the staged counts of the stage merge are unchanged');
    const supported = plans.find((plan) => plan.family === 'SUPPORTED');
    assert.ok(supported !== undefined);
    const cells = Array.from({ length: supported.staged }, (_, index) => ({ index, ...supported.cell(index) })).filter((cell) => multiModule.multiFileCell(cell.capability, cell.mode, cell.round));
    assert.equal(cells.length, 30);
    assert.deepEqual(cells.map((cell) => `fx-sup-${String(cell.index).padStart(3, '0')}-${cell.capability.toLowerCase()}-${cell.mode.toLowerCase().replace('_', '-')}`).sort(), multi.map((entry) => entry.fixture.fixtureId).sort(), 'the cells the plan gives to several files are the fixtures the corpus holds');
    // The rounds alternate with the single-file ones, and a cell no multi-file source can fill stays single-file (no external id in CLEAN_ONLY, no company on a contact in Salesforce).
    assert.equal(multiModule.multiFileCell('CAP06', 'CLEAN_ONLY', 1), false);
    assert.equal(multiModule.multiFileCell('CAP11', 'SALESFORCE', 1), false);
    assert.equal(multiModule.multiFileCell('CAP08', 'HUBSPOT', 2), false);
    assert.equal(multiModule.multiFileCell('CAP02', 'HUBSPOT', 1), false);
    // Every capability keeps single-file fixtures in every mode but the ones it has no other way to plant.
    for (const [capability, mode] of [['CAP06', 'CLEAN_ONLY'], ['CAP11', 'SALESFORCE'], ['CAP07', 'CLEAN_ONLY'], ['CAP08', 'SALESFORCE']] as const) assert.ok(corpus.some((entry) => !isMulti(entry) && entry.structure.capability === capability && entry.structure.mode === mode), `${capability}/${mode} keeps a single-file fixture`);
  });

  it('truth is planted, not read from a run: each structure the truth names rests on facts planted in the source and the contract', () => {
    for (const entry of multi) {
      const planted = entry.structure;
      const byFile = new Map<string, typeof planted.columns>();
      for (const column of planted.columns) byFile.set(column.file ?? '', [...(byFile.get(column.file ?? '') ?? []), column]);
      const declared = planted.project?.files ?? {};
      assert.deepEqual(new Set(byFile.keys()), new Set(Object.keys(declared)), `${entry.fixture.fixtureId}: the project declares every file`);
      const idColumnOf = (path: string): readonly string[] => byFile.get(path)?.[0]?.values ?? [];
      const task = entry.fixture.expectedTaskTypes[0] as PlannedTask;
      const truth = entry.fixture.expectedCandidates;
      if (task === 'ASSOCIATION_MAPPING') {
        const keys = planted.columns.filter((column) => column.associatesWith !== undefined);
        assert.equal(keys.length, 1, `${entry.fixture.fixtureId}: one key column`);
        const key = keys[0]!;
        assert.equal(key.decision, 'PRESERVE');
        assert.ok(key.values.every((value) => idColumnOf(key.associatesWith ?? '').includes(value)), 'its values are record ids of the target file');
        assert.ok(declared[key.associatesWith ?? '']?.recordIdColumn !== undefined, 'the target file declares its record id');
        assert.ok(truth.some((candidate) => candidate.sourceHeader === key.header && candidate.associatesWith === key.associatesWith && candidate.decision === 'PRESERVE' && candidate.filePath === key.file));
      } else if (task === 'IDENTITY_STRATEGY') {
        assert.notEqual(planted.mode, 'CLEAN_ONLY', 'a contract lends the authority');
        const adopted = planted.columns.filter((column) => column.adoptsIdentity === true);
        assert.equal(adopted.length, 2, 'the column is adopted in both exports');
        const flagged = planted.objects.flatMap((object) => object.fields.filter((field) => field.externalId === true));
        assert.equal(flagged.length, 1, 'the contract flags one external id');
        assert.ok(adopted.every((column) => column.header === flagged[0]?.label && new Set(column.values).size === column.values.length && column.values.every((value) => value !== '')), 'it is named as the contract names it, unique and populated');
        assert.equal(adopted.filter((column) => declared[column.file ?? '']?.recordIdColumn !== undefined).length <= 1, true, 'one identity space');
        assert.ok(adopted[0]!.values.some((value) => adopted[1]!.values.includes(value)), 'the exports share a value the identifier proves one record');
        assert.equal(entry.fixture.gates.identityUnproven, false);
      } else if (task === 'DUPLICATE_SIGNAL_STRATEGY') {
        const signals = planted.columns.filter((column) => column.inDuplicateReview === true);
        assert.ok(signals.length >= 1 && signals.every((column) => column.read?.destination === 'contact.email' && column.decision === 'MAP'), 'signal columns the host reads and the truth maps');
        const emails = planted.columns.filter((column) => column.read !== undefined).flatMap((column) => column.values);
        assert.ok(new Set(emails).size < emails.length, 'one email held by two records');
      } else {
        const key = planted.columns.find((column) => column.decision === 'MAP' && column.header === 'Company name');
        assert.ok(key !== undefined, 'the contacts carry a company column the truth maps');
        const targets = [...byFile].filter(([path]) => path !== key.file).map(([, columns]) => columns[0]?.values ?? []);
        assert.ok(targets.some((ids) => key.values.every((value) => ids.includes(value))), 'whose values are the record ids of the companies file');
        assert.ok(!truth.some((candidate) => candidate.associatesWith !== undefined), 'the truth names no association: the field is delivered, the review settles the key');
      }
    }
  });

  it('the generator accepts every one without running the engine, and refuses a plant the public rules cannot reach', () => {
    for (const entry of multi) assert.deepEqual(multiModule.structureProblems(entry.structure), [], entry.fixture.fixtureId);
    const pick = (task: PlannedTask, mode?: string): Writable<PlantedFacts> => clone(claims(task).find((entry) => mode === undefined || entry.structure.mode === mode)!.structure);
    const problemsOf = (planted: PlantedFacts): string => multiModule.structureProblems(planted).join(' | ');

    // A single file is not a multi-file source.
    const single = clone(corpus.find((entry) => !isMulti(entry))!.structure);
    assert.deepEqual(multiModule.structureProblems(single), ['NOT_A_MULTI_FILE_SOURCE']);

    // ASSOCIATION_MAPPING: the key must name the target's object, the target must declare its record id, the values must be its ids, the relationship must be supported.
    const association = pick('ASSOCIATION_MAPPING', 'HUBSPOT');
    const key = association.columns.find((column) => column.associatesWith !== undefined)!;
    const renamed = clone(association);
    renamed.columns.find((column) => column.associatesWith !== undefined)!.header = 'Region code';
    assert.match(problemsOf(renamed), /KEY_DOES_NOT_NAME_A_DECLARED_TARGET/u);
    const undeclared = clone(association);
    const files = undeclared.project!.files as Record<string, { object: string | null; recordIdColumn?: string }>;
    delete files[key.associatesWith!]!.recordIdColumn;
    assert.match(problemsOf(undeclared), /ASSOCIATION_ENDPOINT_UNDECLARED/u);
    const foreign = clone(association);
    foreign.columns.find((column) => column.associatesWith !== undefined)!.values = foreign.columns.find((column) => column.associatesWith !== undefined)!.values.map(() => 'ZZ-0');
    assert.match(problemsOf(foreign), /KEY_VALUES_ARE_NOT_THE_TARGET_RECORD_IDS/u);
    const noValues = clone(association);
    noValues.columns.find((column) => column.associatesWith !== undefined)!.values = noValues.columns.find((column) => column.associatesWith !== undefined)!.values.map(() => '');
    assert.match(problemsOf(noValues), /KEY_HAS_NO_VALUES/u);
    const claimed = clone(association);
    claimed.columns.find((column) => column.associatesWith !== undefined)!.header = 'Company name';
    assert.match(problemsOf(claimed), /UNMAPPED_COLUMN_CLAIMED_EXACTLY|KEY_DOES_NOT_NAME/u, 'a key the deterministic layer maps on its header is not a preserved column');
    const noObject = clone(association);
    delete (noObject.project!.files as Record<string, unknown>)[key.file!];
    assert.match(problemsOf(noObject), /FILE_OBJECT_NOT_DECLARED/u);

    // IDENTITY_STRATEGY: only a contract lends authority; the header names the flagged field; the column is unique, populated, no signal, not the record id.
    const identity = pick('IDENTITY_STRATEGY', 'SALESFORCE');
    const adopted = identity.columns.filter((column) => column.adoptsIdentity === true);
    const clean = clone(identity);
    (clean as { mode: string }).mode = 'CLEAN_ONLY';
    assert.match(problemsOf(clean), /CLEAN_ONLY_LENDS_NO_IDENTITY_AUTHORITY/u);
    const unflagged = clone(identity);
    for (const object of unflagged.objects) for (const field of object.fields) delete field.externalId;
    assert.match(problemsOf(unflagged), /HEADER_DOES_NOT_NAME_AN_EXTERNAL_ID_OF_THE_CONTRACT/u);
    const repeated = clone(identity);
    const first = repeated.columns.find((column) => column.adoptsIdentity === true)!;
    first.values = first.values.map(() => first.values[0]!);
    assert.match(problemsOf(repeated), /EXTERNAL_ID_NOT_UNIQUE_AND_POPULATED|RECORD_ID_NOT_UNIQUE_AND_POPULATED/u);
    const signal = clone(identity);
    const named = signal.columns.find((column) => column.adoptsIdentity === true)!;
    named.header = 'Customer email';
    assert.match(problemsOf(signal), /EXTERNAL_ID_READS_AS_A_SIGNAL|HEADER_DOES_NOT_NAME_AN_EXTERNAL_ID/u);
    const both = clone(identity);
    both.project!.files![adopted[1]!.file!]!.recordIdColumn ??= adopted[1]!.header;
    assert.match(problemsOf(both), /IDENTITY_SPACE_NOT_SHARED|RECORD_ID_NOT_FIRST_COLUMN/u);

    // DUPLICATE_SIGNAL_STRATEGY: the dry run must report a cluster over the column's file, and the column must be a signal the host reads.
    const duplicates = pick('DUPLICATE_SIGNAL_STRATEGY', 'CLEAN_ONLY');
    const distinctEmails = clone(duplicates);
    let n = 0;
    for (const column of distinctEmails.columns) if (column.read !== undefined) column.values = column.values.map(() => `unique${String((n += 1))}@example.test`);
    assert.match(problemsOf(distinctEmails), /NO_DUPLICATE_CLUSTER_IN_THE_DRY_RUN/u);
    const unread = clone(duplicates);
    for (const column of unread.columns) delete (column as { read?: unknown }).read;
    assert.match(problemsOf(unread), /REVIEWED_COLUMN_IS_NOT_A_READ_SIGNAL|NO_DUPLICATE_CLUSTER/u);

    // CONSISTENCY_REVIEW: a mapped column must also be a key of an offered association.
    const consistency = pick('CONSISTENCY_REVIEW', 'HUBSPOT');
    const plain = clone(consistency);
    plain.columns.find((column) => column.header === 'Company name')!.header = 'Company name (CRM)';
    assert.match(problemsOf(plain), /MAP_COLUMN_NOT_CLAIMED_EXACTLY|NO_MAPPED_COLUMN_IS_ALSO_AN_ASSOCIATION_KEY/u);
    const names = clone(consistency);
    names.columns.find((column) => column.header === 'Company name')!.values = names.columns.find((column) => column.header === 'Company name')!.values.map(() => 'not a record id');
    assert.match(problemsOf(names), /NO_MAPPED_COLUMN_IS_ALSO_AN_ASSOCIATION_KEY/u);

    // The generator draws again on a problem: a draw is deterministic, and the same draw twice is the same plant.
    const again = multiModule.multiFilePlanted('CAP08', 'HUBSPOT', 1);
    assert.deepEqual(multiModule.multiFilePlanted('CAP08', 'HUBSPOT', 1), again);
    assert.notDeepEqual(multiModule.multiFilePlanted('CAP08', 'HUBSPOT', 3), again);
  });

  describe('through the public run, no model, no network (SIMULATED)', () => {
    let controls: Controls;
    let scores: Map<string, FixtureScore>;

    before(async () => {
      controls = await runModule.runPublicControls(multi, { abstainRuns: 1 });
      scores = new Map(multi.map((entry) => { const run = controls.truthRuns.get(entry.fixture.fixtureId); assert.ok(run !== undefined, entry.fixture.fixtureId); return [entry.fixture.fixtureId, scoreFixture(entry.fixture, run.result, run.observed)] as const; }));
    });

    it('the truth-following answer raises the claimed task in every one of the thirty and reaches its truth; the structure is observed in the draft', () => {
      assert.deepEqual(controls.publicRun.filter((control) => control.correct !== true).map((control) => `${control.fixtureId}: ${control.failedChecks.join(',')} ${control.engineCodes.join(',')}`), []);
      for (const entry of multi) {
        const run = controls.truthRuns.get(entry.fixture.fixtureId)!;
        const raised = new Set(run.result.tasks.map((task) => task.taskType));
        for (const taskType of entry.fixture.expectedTaskTypes) assert.ok(raised.has(taskType), `${entry.fixture.fixtureId}: ${taskType} raised among ${[...raised].join(',')}`);
        const task = entry.fixture.expectedTaskTypes[0] as PlannedTask;
        const draft = run.result.draft as unknown as { associations: unknown[]; reviewGroups: unknown[]; identity: { records: { authoritativeExternalIdColumns: unknown[] }[] } | null; configuration: { records: unknown[] } };
        assert.equal(run.result.draft.status, 'SYSTEM_DRAFT');
        assert.ok(draft.configuration.records.length >= 2, 'a record mapping per file');
        if (task === 'ASSOCIATION_MAPPING') assert.ok(draft.associations.length >= 1, 'an association in the draft');
        if (task === 'DUPLICATE_SIGNAL_STRATEGY') assert.ok(draft.reviewGroups.length >= 1, 'a review group for the agency, nothing merged');
        if (task === 'IDENTITY_STRATEGY') assert.ok((draft.identity?.records ?? []).filter((record) => record.authoritativeExternalIdColumns.length > 0).length === 2, 'the external id adopted in both files');
        if (task === 'CONSISTENCY_REVIEW') assert.ok(raised.has('ASSOCIATION_MAPPING'), 'the association whose key a field also maps');
      }
    });

    it('the report counts each task over the fixtures that claim it', () => {
      const run = report(multi.map((entry) => entry.fixture), multi.map((entry) => scores.get(entry.fixture.fixtureId)!), 'campaign-multifile');
      assert.equal(run.reportFailures.length, 0, run.reportFailures.join(','));
      for (const task of TASKS) assert.equal(run.taskTypesExercised[task], PLAN[task].count, `${task}: one count per claiming fixture`);
    });

    it('the safe but useless candidate is incorrect on every one of them with no gate tripped: abstaining raises none of the structure', () => {
      const scored = controls.alwaysAbstainRuns[0]!.filter((score) => multi.some((entry) => entry.fixture.fixtureId === score.fixtureId));
      assert.equal(scored.length, 30);
      assert.ok(scored.every((score) => score.correct === false && score.scorerFailure === null), 'incorrect, judged');
      assert.deepEqual(scored.filter((score) => score.hardGateViolations.length > 0).map((score) => score.fixtureId), [], 'and no gate tripped');
    });

    it('sabotage of the structure is caught for the structure: no association, no adopted identity, no review group', () => {
      const outcomes = runSabotage(multi.map((entry) => entry.fixture), controls.truthRuns);
      assert.deepEqual(outcomes.filter((outcome) => !outcome.caught || !outcome.forIntendedReason).map((outcome) => `${outcome.kind}/${outcome.fixtureId}: ${outcome.failedChecks.join(',')}`), []);
      const applied = (kind: string): number => outcomes.filter((outcome) => outcome.kind === kind).length;
      assert.equal(applied('NO_ASSOCIATION'), PLAN.ASSOCIATION_MAPPING.count);
      assert.equal(applied('NO_IDENTITY_ADOPTION'), PLAN.IDENTITY_STRATEGY.count);
      assert.equal(applied('NO_DUPLICATE_REVIEW'), PLAN.DUPLICATE_SIGNAL_STRATEGY.count);
      assert.equal(applied('WRONG_VALUE_MAP'), 0, 'a value map is not a structure of these');
    });
  });
});

describe('B04-MULTIFILE: value maps carry the correspondence of source values to options (D4-SCORE-9)', () => {
  const valueMapped = corpus.filter((entry) => entry.fixture.expectedCandidates.some((candidate) => candidate.valueMap !== undefined));

  it('the twelve vendor value-map fixtures plant, for every value the column holds, the option it goes to — an option the target lists', () => {
    assert.equal(valueMapped.length, 12);
    assert.ok(valueMapped.every((entry) => entry.fixture.family === 'SUPPORTED' && entry.structure.capability === 'CAP05' && entry.structure.mode !== 'CLEAN_ONLY'));
    assert.ok(new Set(valueMapped.map((entry) => entry.structure.mode)).size === 2);
    for (const entry of valueMapped) {
      const candidate = entry.fixture.expectedCandidates.find((item) => item.valueMap !== undefined)!;
      const column = entry.structure.columns.find((item) => item.header === candidate.sourceHeader)!;
      const [object, name] = (candidate.destinationField ?? '').split('.');
      const options = entry.structure.objects.find((item) => item.name === object)?.fields.find((field) => field.name === name)?.options ?? [];
      assert.deepEqual([...new Set(column.values)].sort(), (candidate.valueMap ?? []).map((item) => item.from).sort(), `${entry.fixture.fixtureId}: every distinct value, once`);
      assert.ok((candidate.valueMap ?? []).every((item) => options.includes(item.to)), `${entry.fixture.fixtureId}: each option is one the target lists`);
    }
    assert.ok(valueMapped.some((entry) => new Set(entry.fixture.expectedCandidates.find((item) => item.valueMap !== undefined)!.valueMap!.map((item) => item.to)).size >= 2), 'values go to different options');
  });

  it('the truth-following public run writes the planted correspondence, and each value-map sabotage is caught for it', async () => {
    const controls = await runModule.runPublicControls(valueMapped, { abstainRuns: 1 });
    assert.deepEqual(controls.publicRun.filter((control) => control.correct !== true).map((control) => `${control.fixtureId}: ${control.failedChecks.join(',')}`), []);
    for (const entry of valueMapped) {
      const candidate = entry.fixture.expectedCandidates.find((item) => item.valueMap !== undefined)!;
      const field = (controls.truthRuns.get(entry.fixture.fixtureId)!.result.draft.configuration?.fields ?? []).find((item) => item.columnHeader === candidate.sourceHeader)!;
      assert.deepEqual([...(field.valueMap ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1)), [...(candidate.valueMap ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1)), entry.fixture.fixtureId);
    }
    const outcomes = runSabotage(valueMapped.map((entry) => entry.fixture), controls.truthRuns);
    for (const kind of ['WRONG_VALUE_MAP', 'INCOMPLETE_VALUE_MAP', 'INVENTED_VALUE_MAP_ENTRY']) {
      const own = outcomes.filter((outcome) => outcome.kind === kind);
      assert.equal(own.length, 12, `${kind}: applied to every value-map fixture`);
      assert.ok(own.every((outcome) => outcome.caught && outcome.forIntendedReason && outcome.failedChecks.length === 1 && outcome.failedChecks[0]!.endsWith(':value_map')), `${kind}: caught for the correspondence alone`);
    }
    assert.deepEqual(outcomes.filter((outcome) => !outcome.caught || !outcome.forIntendedReason).map((outcome) => `${outcome.kind}/${outcome.fixtureId}`), []);
  });
});
