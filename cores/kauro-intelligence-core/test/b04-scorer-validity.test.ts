/**
 * B04-SCORER — scorer validity before spending.
 *
 * The scorer is proven on the sealed corpus with no model and no network. The positive control is the public run: the
 * truth-following answer of a fixture (built from sealed truth and the request bytes alone) goes through the real core behind a
 * scripted gateway labelled SIMULATED, and the scorer must score the result correct. Each family's sabotage mutates those real
 * results and must be caught for the reason it intends; a safe but useless candidate must fail the utility thresholds with no gate
 * tripped. The record of all this over the 660 sealed fixtures is committed (corpus/scorer-validity.json) and bound to the digest
 * of the scorer and of the corpus; here the record is checked against the current pair, and the controls are rerun on the twelve
 * sealed seeds. The scorer never reads engine output as truth. Evidence class SIMULATED (A4).
 */
import { strict as assert } from 'node:assert';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { CorpusFixture, CorpusManifest } from '../src/benchmark/corpus.js';
import { verifyCorpus } from '../src/benchmark/corpus.js';
import type { BenchmarkFixture } from '../src/benchmark/fixture.js';
import { FIXTURE_FAMILIES } from '../src/benchmark/fixture.js';
import { QUALITY_THRESHOLDS, report } from '../src/benchmark/report.js';
import { scoreFixture } from '../src/benchmark/scorer.js';
import type { FixtureScore } from '../src/benchmark/scorer.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { SABOTAGE_SET, applySabotage, buildValidityRecord, copiedReportFindings, runSabotage, scorerDigestOf, truthContradictions, usefulnessOf, validityRecordProblems } from '../src/benchmark/validity.js';
import type { ControlRun, PublicRunControl, ValidityRecord } from '../src/benchmark/validity.js';
import { TASK_TYPES } from '../src/contracts/envelope.js';
import { MODEL_POLICY_HASH, PROMPT_BUNDLE_HASH } from '../src/gateway/model-gateway.js';

const root = join(import.meta.dirname, '..', '..');
const corpusFixtures: readonly CorpusFixture[] = readdirSync(join(root, 'corpus', 'fixtures')).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', name), 'utf8')) as CorpusFixture);
const manifest = JSON.parse(readFileSync(join(root, 'corpus', 'MANIFEST.json'), 'utf8')) as CorpusManifest;
const all660: readonly BenchmarkFixture[] = corpusFixtures.map((entry) => entry.fixture);
const seedEntries = corpusFixtures.filter((entry) => entry.fixture.fixtureId.startsWith('seed-'));
const seeds: readonly BenchmarkFixture[] = seedEntries.map((entry) => entry.fixture);
const capabilityOf = new Map(manifest.fixtures.map((entry) => [entry.fixtureId, entry.capability]));

interface Controls { readonly publicRun: PublicRunControl[]; readonly alwaysAbstainRuns: FixtureScore[][]; readonly scoresOfTruth: FixtureScore[]; readonly truthRuns: Map<string, ControlRun> }
const runModule = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'validity-run.mjs')).href)) as {
  runPublicControls: (fixtures: readonly CorpusFixture[], options?: { abstainRuns?: number }) => Promise<Controls>;
  materialise: (fixture: CorpusFixture, options?: { declaredObject?: string | null }) => { dispose: () => void; targets: ReadonlyMap<string, string> };
  runThroughPublicCore: (bundle: unknown, answer: (envelope: unknown, identity: unknown) => unknown, attempt: string) => Promise<{ result: IntelligenceResult; observed: Parameters<typeof scoreFixture>[2] }>;
  currentScorerDigest: () => string;
};
const truthModule = await import('../src/benchmark/truth-answer.js');

/** A release binding for records built in these tests over the seeds (never the committed record's). */
const TEST_RELEASE = { icPackageDigest: 'c'.repeat(64), migrationCoreVersion: '3.0.0', migrationCoreTarballSha256: 'd'.repeat(64), promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyHash: MODEL_POLICY_HASH };
const failedChecks = (score: FixtureScore): string[] => score.checks.filter((check) => !check.pass).map((check) => check.check);

describe('B04-SCORER: scorer validity on the sealed corpus, no model, no network (SIMULATED)', () => {
  let controls: Controls;
  let truthScores: Map<string, FixtureScore>;

  before(async () => {
    assert.equal(corpusFixtures.length, 660, 'the sealed corpus holds the 660 fixtures');
    assert.deepEqual(verifyCorpus(manifest, corpusFixtures), [], 'the corpus is exactly what the manifest sealed');
    assert.equal(seedEntries.length, 12);
    controls = await runModule.runPublicControls(seedEntries, { abstainRuns: 3 });
    truthScores = new Map(seeds.map((fixture) => { const run = controls.truthRuns.get(fixture.fixtureId); assert.ok(run !== undefined, fixture.fixtureId); return [fixture.fixtureId, scoreFixture(fixture, run.result, run.observed)] as const; }));
  });

  it('positive controls: the truth-following answer of every sealed seed reaches its truth through the public run and scores correct; no sealed truth contradicts itself', () => {
    assert.equal(controls.publicRun.length, seeds.length);
    assert.deepEqual(controls.publicRun.filter((control) => control.correct !== true).map((control) => `${control.fixtureId}: ${control.failedChecks.join(',')} ${control.engineCodes.join(',')}`), [], 'every seed truth is reached');
    assert.ok(controls.publicRun.every((control) => control.scorerFailure === null));
    assert.deepEqual(all660.filter((fixture) => truthContradictions(fixture).length > 0).map((fixture) => fixture.fixtureId), [], 'no truth of the 660 asks for what no run can be');
  });

  it('IC-10: over the sealed seeds, a real result with an invented field beside its expected fields, or with a receipt of another run, another configuration or older than the run, scores incorrect for that reason', () => {
    for (const fixture of seeds) {
      const base = controls.truthRuns.get(fixture.fixtureId);
      assert.ok(base !== undefined);
      assert.equal(truthScores.get(fixture.fixtureId)?.correct, true, fixture.fixtureId);
      const invented = applySabotage(fixture, base, 'INVENTED_FIELD');
      assert.ok(invented !== null);
      const caught = scoreFixture(fixture, invented.result, invented.observed);
      assert.equal(caught.correct, false, fixture.fixtureId);
      assert.ok(failedChecks(caught).includes('no_extra_field'), `${fixture.fixtureId}: ${failedChecks(caught).join(',')}`);
      assert.ok(caught.hardGateViolations.includes('invented_target_accepted'));
      for (const kind of ['STALE_RECEIPT_OTHER_RUN', 'STALE_RECEIPT_OTHER_CONFIGURATION', 'STALE_RECEIPT_OLDER'] as const) {
        const stale = applySabotage(fixture, base, kind);
        if (base.result.draft.status !== 'SYSTEM_DRAFT') {
          assert.equal(stale, null, `${fixture.fixtureId}: a run without a draft has no receipt to be stale`);
          continue;
        }
        assert.ok(stale !== null);
        const staleScore = scoreFixture(fixture, stale.result, stale.observed);
        assert.equal(staleScore.scorerFailure, null, `${fixture.fixtureId} ${kind}`);
        // On a safety-critical fixture a tripped gate is also the safety failure it is (D4-SCORE-5).
        assert.deepEqual(failedChecks(staleScore).filter((check) => check !== 'safety_critical_correct'), ['receipt_current'], `${fixture.fixtureId} ${kind}: the receipt is the only thing wrong`);
        assert.ok(staleScore.hardGateViolations.includes('malformed_or_out_of_contract_accepted'));
      }
    }
    // A receipt that digests another configuration than the one presented is not scored at all: the scorer refuses to judge it (B03 behaviour kept).
    const proposed = seeds.find((fixture) => controls.truthRuns.get(fixture.fixtureId)?.result.draft.status === 'SYSTEM_DRAFT');
    assert.ok(proposed !== undefined);
    const base = controls.truthRuns.get(proposed.fixtureId)!;
    const digestRun = JSON.parse(JSON.stringify(base.result)) as { draft: { fullValidation: { configurationDigest: string } } };
    digestRun.draft.fullValidation.configurationDigest = 'e'.repeat(64);
    const refused = scoreFixture(proposed, digestRun as unknown as IntelligenceResult, base.observed);
    assert.equal(refused.correct, null);
    assert.match(refused.scorerFailure ?? '', /^RECEIPT_NOT_BOUND_TO_CONFIGURATION/u);
  });

  it('IC-10 offline, through the public run: the real receipt of a real run is current, and the same result with a stale receipt scores incorrect for that reason', async () => {
    const corpusFixture = seedEntries.find((entry) => entry.fixture.fixtureId === 'seed-cap04-transformation');
    assert.ok(corpusFixture !== undefined);
    const fixture = corpusFixture.fixture;
    const bundle = runModule.materialise(corpusFixture);
    try {
      const run = await runModule.runThroughPublicCore(bundle, (envelope, identity) => truthModule.truthFollowingAnswer(fixture, envelope as never, identity as never, bundle.targets), 'attempt-ic10-live-shape');
      assert.equal(run.result.draft.status, 'SYSTEM_DRAFT');
      const genuine = scoreFixture(fixture, run.result, run.observed);
      const receipt = genuine.checks.find((check) => check.check === 'receipt_current');
      assert.ok(receipt !== undefined && receipt.pass, 'the receipt the host issued for this run is current');
      for (const patch of [{ validatedAt: '2000-01-01T00:00:00.000Z' }, { configurationRef: 'cfg_of_another_configuration' }, { profileHash: 'f'.repeat(64) }]) {
        const stale = { ...run.result, draft: { ...run.result.draft, fullValidation: { ...run.result.draft.fullValidation!, ...patch } } } as IntelligenceResult;
        const score = scoreFixture(fixture, stale, run.observed);
        assert.equal(score.scorerFailure, null);
        assert.ok(failedChecks(score).includes('receipt_current'), JSON.stringify(patch));
        assert.equal(score.correct, false);
      }
    } finally { bundle.dispose(); }
  });

  it('S043: an always-abstaining candidate over the sealed seeds has zero hard-gate violations and fails SUPPORTED correctness in every run', () => {
    assert.equal(controls.alwaysAbstainRuns.length, 3, 'three runs');
    const runIds = new Set<string>();
    controls.alwaysAbstainRuns.forEach((scores, index) => {
      assert.equal(scores.length, seeds.length, 'every sealed seed was run');
      assert.ok(scores.every((score) => score.scorerFailure === null), 'the scorer judged every abstaining run');
      for (const score of scores) { if (score.runId !== null) runIds.add(score.runId); }
      assert.deepEqual(scores.filter((score) => score.hardGateViolations.length > 0).map((score) => `${score.fixtureId}:${score.hardGateViolations.join(',')}`), [], 'no seed trips a gate for an abstaining candidate');
      const verdict = usefulnessOf(seeds, scores, `campaign-always-abstain-${String(index + 1)}`);
      assert.deepEqual(verdict.report.reportFailures, [], 'a well-formed report');
      assert.equal(verdict.hardGateViolations, 0, 'run ' + String(index + 1) + ': no hard gate violated');
      const supported = scores.filter((score) => score.family === 'SUPPORTED');
      assert.ok(supported.length > 0);
      assert.ok(supported.every((score) => score.correct === false), 'it is wrong on every SUPPORTED fixture');
      assert.equal(verdict.report.qualityGates.supportedCorrectness, 0);
      assert.equal(verdict.report.qualityGates.supportedPass, false, 'and fails the SUPPORTED threshold');
    });
    assert.equal(runIds.size, 3 * seeds.length, 'three independent runs: distinct run ids');
  });

  it('R2-042: a safe but useless candidate fails the supported utility thresholds independently of its safety score', () => {
    const useless = usefulnessOf(seeds, controls.alwaysAbstainRuns[0] ?? [], 'campaign-useless');
    const perfect = usefulnessOf(seeds, seeds.map((fixture) => truthScores.get(fixture.fixtureId)!), 'campaign-perfect');
    assert.equal(useless.hardGateViolations, 0);
    assert.equal(perfect.hardGateViolations, 0);
    assert.equal(useless.report.qualityGates.supportedPass, false);
    assert.equal(perfect.report.qualityGates.supportedPass, true);
    assert.ok((useless.report.qualityGates.supportedCorrectness ?? 1) < QUALITY_THRESHOLDS.SUPPORTED_CORRECTNESS_PER_RUN);
    assert.ok((perfect.report.qualityGates.supportedCorrectness ?? 0) >= QUALITY_THRESHOLDS.SUPPORTED_CORRECTNESS_PER_RUN);
    assert.equal(useless.report.passing, false, 'a safe but useless candidate does not pass');
  });

  it('sabotage: every mutation of each family\'s set, applied to the real results of the sealed seeds, is caught for the reason it intends; a copied report is refused', () => {
    const outcomes = runSabotage(seeds, controls.truthRuns);
    assert.ok(outcomes.length > 0);
    assert.deepEqual(outcomes.filter((outcome) => !outcome.caught).map((outcome) => `${outcome.family}/${outcome.kind}/${outcome.fixtureId}`), [], 'every mutation scores incorrect');
    assert.deepEqual(outcomes.filter((outcome) => !outcome.forIntendedReason).map((outcome) => `${outcome.family}/${outcome.kind}/${outcome.fixtureId}: ${outcome.failedChecks.join(',')}`), [], 'and for its own reason');
    for (const outcome of outcomes) assert.ok(SABOTAGE_SET[outcome.family].includes(outcome.kind));
    const copied = copiedReportFindings(seeds, truthScores);
    assert.ok(copied.length > 0);
    assert.ok(copied.every((finding) => finding.caught), JSON.stringify(copied.filter((finding) => !finding.caught)));
  });

  it('the committed validity record covers the 660 sealed fixtures, is for the current scorer and corpus, and opens the funded stage', () => {
    const record = JSON.parse(readFileSync(join(root, 'corpus', 'scorer-validity.json'), 'utf8')) as ValidityRecord;
    assert.deepEqual(validityRecordProblems(record, { scorerDigest: runModule.currentScorerDigest(), corpusDigest: manifest.corpusDigest, minimumFixtures: 660 }), [], 'a record for this scorer and this corpus, unedited, nothing blocking');
    assert.equal(record.fixtures, 660);
    assert.equal(record.publicRunControls.fixtures, 660);
    assert.equal(record.publicRunControls.reached, 660, 'every truth reached through the public run');
    assert.equal(record.corpusReachable, true);
    assert.deepEqual(record.contradictoryTruths, []);
    assert.equal(record.sabotage.caughtForIntendedReason, record.sabotage.applied);
    assert.equal(record.sabotage.withoutBase, 0);
    for (const family of FIXTURE_FAMILIES) assert.ok(Object.keys(record.sabotage.byFamily[family] ?? {}).length >= 3, `${family}: at least three kinds of sabotage exercised`);
    assert.ok(record.usefulnessFloor.holds && record.usefulnessFloor.runs === 3);
    assert.deepEqual(record.usefulnessFloor.hardGateViolations, [0, 0, 0]);
    assert.deepEqual(record.usefulnessFloor.supportedPass, [false, false, false]);
    assert.deepEqual(Object.keys(record.publicRunControls.byFamily).sort(), [...FIXTURE_FAMILIES].sort(), 'per-family rates for all five families');
    assert.equal(Object.keys(record.publicRunControls.byCapability).length, 12, 'per-capability rates for the twelve capabilities');
    assert.equal(record.opensFundedStage, true);
    // Every task type the twelve capability families raise is raised by the truth-following public run of some fixtures, and counted (manual 06 §Twelve required capability families).
    assert.equal(record.recordVersion, '4');
    assert.deepEqual(record.unmeasuredTasks, [], 'no capability family unmeasured');
    assert.deepEqual(Object.keys(record.tasksMeasured).sort(), [...TASK_TYPES].sort(), 'a count for each of the twelve task types');
    for (const taskType of TASK_TYPES) assert.ok((record.tasksMeasured[taskType] ?? 0) > 0, `${taskType}: measured`);
    for (const [taskType, count] of [['ASSOCIATION_MAPPING', 15], ['DUPLICATE_SIGNAL_STRATEGY', 9], ['IDENTITY_STRATEGY', 6], ['CONSISTENCY_REVIEW', 6]] as const) assert.ok((record.tasksMeasured[taskType] ?? 0) >= count, `${taskType}: at least ${String(count)} fixtures`);
    assert.equal(record.repairControls.repaired, record.repairControls.fixtures, 'every repair control reached its truth');
    assert.ok(record.repairControls.fixtures >= 40, 'the repair is raised by the CAP12 fixtures');
    // The sabotage of D4-SCORE-9 and D4-SCORE-10 is applied on the corpus and caught for its reason, every kind of the family's set exercised.
    const supportedKinds = record.sabotage.byFamily['SUPPORTED'] ?? {};
    for (const kind of ['WRONG_VALUE_MAP', 'INCOMPLETE_VALUE_MAP', 'INVENTED_VALUE_MAP_ENTRY', 'NO_ASSOCIATION', 'NO_IDENTITY_ADOPTION', 'NO_DUPLICATE_REVIEW']) {
      assert.ok((supportedKinds[kind]?.applied ?? 0) > 0, `${kind}: applied`);
      assert.equal(supportedKinds[kind]?.caught, supportedKinds[kind]?.applied, `${kind}: caught for its reason`);
    }
    // The two the stage 2 record already left unapplied (no fixture of those families where the mutation is not already the truth); none of the new kinds.
    assert.deepEqual(record.sabotage.unexercised, ['AMBIGUOUS_ABSTENTION/IDENTITY_AUTO_MERGE', 'UGLY_MULTILINGUAL_STALE/ALWAYS_PROPOSE']);
  });

  it('a corpus whose public run raises no structure task is blocked: a task type no fixture raises keeps the funded stage closed (when every task must be measured)', () => {
    const inputs = { scorerDigest: 'a'.repeat(64), corpusDigest: manifest.corpusDigest, release: TEST_RELEASE, fixtures: seeds, capabilityOf, publicRun: controls.publicRun, truthRuns: controls.truthRuns, alwaysAbstainRuns: controls.alwaysAbstainRuns };
    const measured = buildValidityRecord({ ...inputs, measureEveryTask: true });
    assert.ok(measured.unmeasuredTasks.includes('ASSOCIATION_MAPPING') && measured.unmeasuredTasks.includes('IDENTITY_STRATEGY'), 'single-file seeds raise neither');
    assert.ok(measured.blockers.some((blocker) => blocker.startsWith('TASKS_UNMEASURED:') && blocker.includes('DUPLICATE_SIGNAL_STRATEGY')));
    assert.equal(measured.opensFundedStage, false);
    const lenient = buildValidityRecord(inputs);
    assert.deepEqual(lenient.blockers, [], 'the seeds alone are not required to measure every task');
    assert.deepEqual(lenient.unmeasuredTasks, measured.unmeasuredTasks, 'what is unmeasured is told either way');
  });

  it('the validity record is bound to the scorer digest and the corpus digest, and a record for another pair, an edited one, or one with an unreached truth opens nothing', () => {
    const scorerFiles = ['src/benchmark/scorer.ts', 'src/benchmark/fixture.ts', 'src/benchmark/report.ts', 'src/benchmark/validity.ts', 'src/benchmark/truth-answer.ts'].map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
    const scorerDigest = scorerDigestOf(scorerFiles);
    assert.equal(scorerDigest, runModule.currentScorerDigest());
    assert.notEqual(scorerDigestOf(scorerFiles.map((file, index) => (index === 0 ? { ...file, text: `${file.text}\n// edited` } : file))), scorerDigest, 'any edit of the scorer changes its digest');
    assert.equal(scorerDigestOf(scorerFiles.map((file) => ({ ...file, text: file.text.replace(/\n/gu, '\r\n') }))), scorerDigest, 'line endings do not');
    const inputs = { scorerDigest, corpusDigest: manifest.corpusDigest, release: TEST_RELEASE, fixtures: seeds, capabilityOf, publicRun: controls.publicRun, truthRuns: controls.truthRuns, alwaysAbstainRuns: controls.alwaysAbstainRuns };
    const record = buildValidityRecord(inputs);
    assert.equal(record.evidenceClass, 'SIMULATED');
    assert.equal(record.scorerValid, true, record.problems.join(','));
    assert.equal(record.sabotage.caughtForIntendedReason, record.sabotage.applied);
    assert.equal(record.usefulnessFloor.holds, true);
    assert.equal(record.fixtures, 12);
    assert.deepEqual(record.blockers, []);
    assert.equal(record.opensFundedStage, true, [...record.problems, ...record.blockers].join(','));
    assert.deepEqual(validityRecordProblems(record, { scorerDigest, corpusDigest: manifest.corpusDigest }), []);
    assert.ok(validityRecordProblems(record, { scorerDigest: 'a'.repeat(64), corpusDigest: manifest.corpusDigest }).includes('RECORD_FOR_ANOTHER_SCORER'));
    assert.ok(validityRecordProblems(record, { scorerDigest, corpusDigest: 'b'.repeat(64) }).includes('RECORD_FOR_ANOTHER_CORPUS'));
    assert.ok(validityRecordProblems({ ...record, sabotage: { ...record.sabotage, caught: 0 } }, { scorerDigest, corpusDigest: manifest.corpusDigest }).includes('RECORD_EDITED_AFTER_WRITING'));
    assert.deepEqual(validityRecordProblems(null, { scorerDigest, corpusDigest: manifest.corpusDigest }), ['NO_VALIDITY_RECORD']);
    assert.ok(validityRecordProblems(record, { scorerDigest, corpusDigest: manifest.corpusDigest, minimumFixtures: 660 }).some((problem) => problem.startsWith('RECORD_COVERS_12_FIXTURES_BELOW_660')), 'a stage that needs the 660 refuses a record over the seeds');
    // A truth the public run does not reach blocks spending: the qualification would measure nothing on it.
    const unreached = buildValidityRecord({ ...inputs, publicRun: controls.publicRun.map((control, index) => (index === 0 ? { ...control, correct: false, failedChecks: ['outcome_class'] } : control)) });
    assert.ok(unreached.blockers.includes('UNREACHABLE_TRUTHS:1'));
    assert.equal(unreached.opensFundedStage, false);
    // No usefulness floor is a blocker, and a scorer that failed to judge a control is not valid: either way the record opens nothing.
    const noFloor = buildValidityRecord({ ...inputs, alwaysAbstainRuns: [] });
    assert.ok(noFloor.blockers.includes('USEFULNESS_FLOOR_NOT_HELD'));
    assert.ok(validityRecordProblems(noFloor, { scorerDigest, corpusDigest: manifest.corpusDigest }).includes('BLOCKED_BY:USEFULNESS_FLOOR_NOT_HELD'));
    const refused = controls.publicRun.map((control, index) => (index === 0 ? { ...control, scorerFailure: 'EXPECTED_TRUTH_EDITED: edited' } : control));
    const invalid = buildValidityRecord({ ...inputs, publicRun: refused });
    assert.equal(invalid.scorerValid, false);
    assert.ok(validityRecordProblems(invalid, { scorerDigest, corpusDigest: manifest.corpusDigest }).some((problem) => problem.startsWith('SCORER_NOT_VALID')));
  });

  it('report arithmetic is not the scorer: a report over the perfect runs counts every fixture and passes only when the corpus is complete', () => {
    const scores = seeds.map((fixture) => truthScores.get(fixture.fixtureId)!);
    assert.equal(report(seeds, scores, 'campaign-perfect').reportFailures.length, 0);
    assert.ok(report(seeds, scores.slice(1), 'campaign-short').missing === 1, 'a fixture without a score is incorrect, not absent');
  });
});

// S044 v4 (mandate 4.5): the record binds what a funded stage runs, not only the scorer and the corpus. The package digest is the
// content digest of the `npm pack` tarball (path and sha256 of every file it carries): the tarball's own bytes carry file modes, which
// differ between a checkout on NTFS read through WSL and a native one for the same tree, and must not make one tree two packages.
interface Binding { readonly icPackageDigest: string; readonly migrationCoreVersion: string; readonly migrationCoreTarballSha256: string; readonly promptBundleHash: string; readonly modelPolicyHash: string }
interface Rerun { readonly stale: boolean; readonly refusals: readonly { readonly code: string; readonly detail: string }[]; readonly binding: Binding | null; readonly fresh: ValidityRecord | null }
const digestModule = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'package-digest.mjs')).href)) as { packageDigestOfTarball: (path: string) => string; packTree: (dir: string, destination: string) => string };
const preflightModule = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'preflight.mjs')).href)) as { rerunValidity: (options: { record: ValidityRecord; corpusDir: string; icTarball: string; bindingOnly?: boolean }) => Rerun };
const vendorManifest = JSON.parse(readFileSync(join(root, 'vendor', 'MANIFEST.json'), 'utf8')) as { version: string; sha256: string };

describe('S044 v4: the validity record binds the package, Migration Core, the prompt bundle and the model policy (SIMULATED, no network)', () => {
  const work = mkdtempSync(join(tmpdir(), 'b04-validity-v4-'));
  after(() => { rmSync(work, { recursive: true, force: true }); });
  /** A copy of what `npm pack` takes from this tree (package.json, README, LICENSE, dist/src), packed; `edit` changes the copy first. */
  const packCopy = (name: string, edit?: (dir: string) => void): string => {
    const dir = join(work, name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // README and LICENSE are packed when present (a sabotage copy may carry only what its runner copies); both copies of a test pack the same files.
    for (const file of ['package.json', 'README.md', 'LICENSE']) if (file === 'package.json' || existsSync(join(root, file))) cpSync(join(root, file), join(dir, file));
    cpSync(join(root, 'dist', 'src'), join(dir, 'dist', 'src'), { recursive: true });
    edit?.(dir);
    const out = join(work, `${name}-tgz`);
    mkdirSync(out, { recursive: true });
    return digestModule.packTree(dir, out);
  };
  const record = (): ValidityRecord => JSON.parse(readFileSync(join(root, 'corpus', 'scorer-validity.json'), 'utf8')) as ValidityRecord;

  // Whether the committed record is for this very tree (the content digest of its npm pack, and every control rerun inside the clean
  // install) is checked by `npm run consumer:check` over the tarball it packs, not here: a test of the suite that compared this tree's
  // package digest with the committed record would fail for every mutation of src/, and so kill every sabotage for a reason none intends.
  it('S044 v4: the committed record is version 4 and binds Migration Core 3.0.0 and its release tarball, the prompt bundle hash and the model policy hash; a record for another member of the binding is refused', () => {
    const committed = record() as ValidityRecord & Binding;
    assert.equal(committed.recordVersion, '4');
    assert.match(committed.icPackageDigest, /^[0-9a-f]{64}$/u, 'a package content digest');
    assert.equal(committed.migrationCoreVersion, '3.0.0');
    assert.equal(committed.migrationCoreVersion, vendorManifest.version);
    assert.equal(committed.migrationCoreTarballSha256, vendorManifest.sha256, 'the published release tarball');
    assert.equal(committed.promptBundleHash, PROMPT_BUNDLE_HASH);
    assert.equal(committed.modelPolicyHash, MODEL_POLICY_HASH);
    const binding: Binding = { icPackageDigest: committed.icPackageDigest, migrationCoreVersion: committed.migrationCoreVersion, migrationCoreTarballSha256: committed.migrationCoreTarballSha256, promptBundleHash: committed.promptBundleHash, modelPolicyHash: committed.modelPolicyHash };
    const expected = { scorerDigest: committed.scorerDigest, corpusDigest: committed.corpusDigest };
    assert.deepEqual(validityRecordProblems(committed, { ...expected, release: binding }), []);
    for (const [member, code] of [['icPackageDigest', 'RECORD_FOR_ANOTHER_PACKAGE'], ['migrationCoreVersion', 'RECORD_FOR_ANOTHER_MIGRATION_CORE'], ['migrationCoreTarballSha256', 'RECORD_FOR_ANOTHER_MIGRATION_CORE_TARBALL'], ['promptBundleHash', 'RECORD_FOR_ANOTHER_PROMPT_BUNDLE'], ['modelPolicyHash', 'RECORD_FOR_ANOTHER_MODEL_POLICY']] as const) {
      assert.ok(validityRecordProblems(committed, { ...expected, release: { ...binding, [member]: member === 'migrationCoreVersion' ? '3.0.1' : 'f'.repeat(64) } }).includes(code), member);
    }
    // A v3 record (no binding) is a format this core does not read.
    const { icPackageDigest: _package, ...v3 } = committed;
    assert.ok(validityRecordProblems({ ...v3, recordVersion: '3' } as unknown as ValidityRecord, expected).includes('RECORD_FORMAT_UNKNOWN'));
  });

  it('S044 v4: one byte changed in dist/src of the package the clean install is made of refuses the funded stage VALIDITY_STALE, before any control is rerun', { timeout: 600_000 }, () => {
    // The record stands for the unchanged copy of this tree's package (its binding as the clean install computes it), whatever the committed record says.
    const unchanged = packCopy('unchanged');
    const standing = { ...record(), icPackageDigest: digestModule.packageDigestOfTarball(unchanged), migrationCoreVersion: vendorManifest.version, migrationCoreTarballSha256: vendorManifest.sha256, promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyHash: MODEL_POLICY_HASH } as ValidityRecord;
    const scorerJs = join('dist', 'src', 'benchmark', 'scorer.js');
    const changed = packCopy('one-byte', (dir) => {
      const bytes = readFileSync(join(dir, scorerJs));
      assert.equal(bytes[bytes.length - 1], 0x0a);
      bytes[bytes.length - 1] = 0x20;
      writeFileSync(join(dir, scorerJs), bytes);
    });
    assert.notEqual(digestModule.packageDigestOfTarball(changed), digestModule.packageDigestOfTarball(unchanged), 'one byte is another package');
    const rerun = preflightModule.rerunValidity({ record: standing, corpusDir: join(root, 'corpus'), icTarball: changed });
    assert.equal(rerun.stale, true);
    assert.deepEqual(rerun.refusals.map((refusal) => refusal.code), ['VALIDITY_STALE']);
    assert.match(rerun.refusals[0]?.detail ?? '', /icPackageDigest/u);
    assert.doesNotMatch(rerun.refusals[0]?.detail ?? '', /migrationCore|promptBundleHash|modelPolicyHash/u, 'only the package differs');
    assert.equal(rerun.fresh, null, 'the binding differs: no control was rerun');
    // The control: the unchanged copy, installed clean, binds exactly as the record says.
    const same = preflightModule.rerunValidity({ record: standing, corpusDir: join(root, 'corpus'), icTarball: unchanged, bindingOnly: true });
    assert.deepEqual(same.refusals, []);
    assert.equal(same.stale, false);
    assert.deepEqual(same.binding, { icPackageDigest: standing.icPackageDigest, migrationCoreVersion: standing.migrationCoreVersion, migrationCoreTarballSha256: standing.migrationCoreTarballSha256, promptBundleHash: standing.promptBundleHash, modelPolicyHash: standing.modelPolicyHash });
  });
});
