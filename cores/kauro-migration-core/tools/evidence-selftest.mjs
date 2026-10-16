#!/usr/bin/env node
/**
 * The evidence rules, proved to fire.
 *
 * `tools/evidence-schema.mjs`, `tools/universe-inventory.mjs`,
 * `qualification/oracles.mjs`, `tools/invalidation-policy.mjs` and
 * `tools/version-floors.mjs` are the shapes every gate reads a record through.
 * They are the answer to the MC-2 ledger's recurring defect — a gate reading a
 * record without anything having said what the record is — and they are
 * therefore exactly the code whose failure would be silent: a rule that never
 * fires looks identical to a rule with nothing to find.
 *
 * So each rule is exercised twice here, on a well-formed record and on one with
 * exactly one thing wrong, and the case fails unless the well-formed one is
 * accepted and the broken one is refused *for the stated reason*. A phrase, not
 * a count: a rule that fires for a different reason than the one it is named
 * for is a rule that will stop firing when that other reason is fixed.
 *
 * This runs in about a second and needs no network, no vendor and no campaign,
 * which is why it is a universe step and a CI job rather than something folded
 * into the release gate's own self-test.
 *
 *   node tools/evidence-selftest.mjs [--evidence <path>]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { canonical, subjectValue } from './execution-subject.mjs';
import { PRODUCERS, closureDiff, evidenceReuseProblems, fingerprintProducer, traceClosure } from './producer-closure.mjs';
import { measureTree } from './candidate-provenance.mjs';
import {
  CAPACITY_STAGES,
  capacityEvidenceProblems,
  captureProblems,
  factsProblems,
  instantProblems,
  matrixEntryProblems,
  unitFieldProblems,
} from './evidence-schema.mjs';
import { UNIVERSE_SCHEMA_VERSION, UNIVERSE_STEP_IDS, universeReportProblems } from './universe-inventory.mjs';
import { CAPACITY_EVIDENCE_SCHEMA_VERSION } from './capacity-profiles.mjs';
import { VERSION_FLOORS, semverAtLeast, versionFloorProblems } from './version-floors.mjs';
import { CHANGE_CLASSES, classifyPath, consequenceOf, SUBJECT_CLASSES } from './invalidation-policy.mjs';
import { SF_OCR_CASES, oracleProblems } from '../qualification/oracles.mjs';

const NOW = '2026-09-08T12:00:00Z';
const SUBJECT = 'a'.repeat(64);
const CAMPAIGN = 'c_0123456789abcdef';
const PRODUCER = 'qualification/hubspot/run-import-qualification.mjs';
const FINGERPRINT = 'f'.repeat(64);
const FINGERPRINTS = { [PRODUCER]: FINGERPRINT, 'tools/capacity.mjs': 'c'.repeat(64) };

const cases = [];

/**
 * One rule, on a good record and a broken one.
 *
 * @param {string} id
 * @param {() => string[]} good must return no problems
 * @param {() => string[]} broken must return a problem containing `expect`
 * @param {string} expect the phrase only this defect produces
 */
function rule(id, good, broken, expect) {
  const problems = [];
  let accepted = [];
  let refused = [];
  try {
    accepted = good();
  } catch (error) {
    problems.push(`the well-formed record threw: ${String(error && error.message ? error.message : error)}`);
  }
  try {
    refused = broken();
  } catch (error) {
    problems.push(`the broken record threw: ${String(error && error.message ? error.message : error)}`);
  }
  if (accepted.length > 0) problems.push(`the well-formed record was refused: ${accepted.join('; ')}`);
  if (refused.length === 0) problems.push('the broken record was accepted');
  else if (!refused.some((problem) => problem.includes(expect))) {
    problems.push(`the refusal did not say "${expect}"; it said ${refused.join('; ')}`);
  }
  cases.push({ id, ok: problems.length === 0, expected: expect, observed: refused.join('; ').slice(0, 240), detail: problems.join('; ') || null });
}

// ---------------------------------------------------------------- captures

const capture = (overrides = {}) => ({
  captureVersion: '2.0.0',
  producer: PRODUCER,
  producerFingerprint: FINGERPRINT,
  producerFingerprintAtEnd: FINGERPRINT,
  campaignId: CAMPAIGN,
  subjectDigestAtStart: SUBJECT,
  subjectDigestAtEnd: SUBJECT,
  startedAt: '2026-09-08T11:00:00Z',
  endedAt: '2026-09-08T11:10:00Z',
  valid: true,
  invalidation: null,
  environment: { node: 'v24', platform: 'win32' },
  ...overrides,
});
const captureOf = (overrides) => captureProblems(capture(overrides), { campaignId: CAMPAIGN, producerFingerprints: FINGERPRINTS, now: NOW, label: 'e.json' });

rule('capture.absent', () => captureOf({}), () => captureProblems(undefined, { campaignId: CAMPAIGN, producerFingerprints: FINGERPRINTS, now: NOW, label: 'e.json' }), 'carries no producer capture');
// The binding is the producer's closure. A capture whose producer read
// different files is refused; a capture taken while a *different* producer's
// files moved is not, which is the whole point of the change.
rule('capture.producerInputsMoved', () => captureOf({}), () => captureOf({ producerFingerprint: 'b'.repeat(64), producerFingerprintAtEnd: 'b'.repeat(64) }), 'something the measurement depended on has moved');
rule('capture.producerInputsMovedDuringRun', () => captureOf({}), () => captureOf({ producerFingerprintAtEnd: 'b'.repeat(64) }), "saw its producer's inputs change while it ran");
rule('capture.noProducerFingerprint', () => captureOf({}), () => captureOf({ producerFingerprint: undefined }), 'carries no producer fingerprint');
rule('capture.unknownProducer', () => captureOf({}), () => captureOf({ producer: 'tools/not-a-producer.mjs', producerFingerprint: 'd'.repeat(64), producerFingerprintAtEnd: 'd'.repeat(64) }), 'whose closure this tree cannot fingerprint');
cases.push({
  id: 'capture.otherHarnessMovedIsAccepted',
  ok: captureProblems(capture({ subjectDigestAtStart: 'b'.repeat(64), subjectDigestAtEnd: 'b'.repeat(64) }), { campaignId: CAMPAIGN, producerFingerprints: FINGERPRINTS, now: NOW, label: 'e.json' }).length === 0,
  expected: 'a capture whose whole-subject digest differs but whose producer fingerprint matches is accepted',
  observed: 'checked',
  detail: null,
});
rule('capture.otherCampaign', () => captureOf({}), () => captureOf({ campaignId: 'c_ffffffffffffffff' }), 'was produced in campaign c_ffffffffffffffff');
rule('capture.noProducer', () => captureOf({}), () => captureOf({ producer: '' }), 'names no producer');
rule('capture.endedBeforeItStarted', () => captureOf({}), () => captureOf({ endedAt: '2026-09-08T10:00:00Z' }), 'ended (2026-09-08T10:00:00Z) before it started');
rule('capture.markedInvalid', () => captureOf({}), () => captureOf({ valid: false, invalidation: 'SUBJECT_UNMEASURABLE_AT_END' }), 'capture is marked invalid');
rule('capture.futureStart', () => captureOf({}), () => captureOf({ startedAt: '2099-01-01T00:00:00Z', endedAt: '2099-01-01T00:10:00Z' }), 'is in the future relative to');

// --------------------------------------------------------------- instants

rule('instant.notAnInstant', () => instantProblems(NOW, { now: NOW, label: 'x' }), () => instantProblems('2026-09-08', { now: NOW, label: 'x' }), 'is not an ISO-8601 UTC instant');
rule('instant.future', () => instantProblems('2026-09-08T11:59:00Z', { now: NOW, label: 'x' }), () => instantProblems('2026-09-09T00:00:00Z', { now: NOW, label: 'x' }), 'is in the future relative to');

// ------------------------------------------------------------------ units

rule(
  'units.camelCase',
  () => unitFieldProblems({ measured: { peakRssBytes: 1 } }),
  () => unitFieldProblems({ measured: { peakMB: 1 } }),
  'measured.peakMB is denominated in a display unit',
);
rule(
  'units.snakeCase',
  () => unitFieldProblems({ measured: { peak_rss_bytes: 1 } }),
  () => unitFieldProblems({ measured: { peak_mib: 1 } }),
  'measured.peak_mib is denominated in a display unit',
);
rule(
  'units.nested',
  () => unitFieldProblems({ a: { b: { c: { bytes: 1 } } } }),
  () => unitFieldProblems({ a: { b: { c: { sizeGiB: 1 } } } }),
  'a.b.c.sizeGiB is denominated in a display unit',
);
rule(
  'units.insideAnArray',
  () => unitFieldProblems({ stages: [{ wallMs: 1 }] }),
  () => unitFieldProblems({ stages: [{ peakKb: 1 }] }),
  'stages[0].peakKb is denominated in a display unit',
);

// --------------------------------------------------------------- capacity

const stage = (name) => ({
  stage: name,
  wallMs: 1,
  peakRssBytes: 1,
  peakRssBytesReason: null,
  maxRssDeltaBytes: 1,
  maxRssDeltaBytesReason: null,
  scratchLiveBytesAtEnd: 0,
  scratchLiveBytesAtEndReason: null,
  scratchPeakLiveBytesSoFar: 1,
  scratchPeakLiveBytesSoFarReason: null,
  scratchSampledBytesAtEnd: 0,
  scratchSampledBytesAtEndReason: null,
});
const capacityRecord = (overrides = {}) => ({
  evidenceSchemaVersion: CAPACITY_EVIDENCE_SCHEMA_VERSION,
  gate: 'CAPACITY-FOUNDING',
  mode: 'HUBSPOT',
  profile: 'FOUNDING-HUBSPOT-1M',
  sourceRows: 1_003_750,
  observedAt: '2026-09-08T11:30:00Z',
  result: 'PASS',
  capture: capture({ producer: 'tools/capacity.mjs' }),
  measured: {
    peakRssBytes: 1,
    peakScratchBytes: 1,
    scratchPeakLiveBytes: 1,
    scratchBytesWritten: 1,
    sourceBytes: 1,
    packageBytes: 1,
    wallClockMs: 1,
    maxRssUnit: 'KiB',
  },
  stages: CAPACITY_STAGES.map(stage),
  reproductions: [
    { packageDigest: 'a'.repeat(64), wallClockMs: 1, stages: CAPACITY_STAGES.map(stage) },
    { packageDigest: 'a'.repeat(64), wallClockMs: 2, stages: CAPACITY_STAGES.map(stage) },
  ],
  reconciliation: { equationHolds: true, rowsIngested: 1_003_750 },
  verification: { ok: true, checksRun: 55, problems: [], attestationOk: true },
  environment: { node: 'v24', platform: 'win32', arch: 'x64', cpuCount: 12, totalMemoryBytes: 1, samplingIntervalMs: 50, maxRssCalibration: 'measured' },
  ...overrides,
});
const capacityOf = (overrides) => capacityEvidenceProblems(capacityRecord(overrides), { schemaVersion: CAPACITY_EVIDENCE_SCHEMA_VERSION, now: NOW, label: 'c.json' });

rule('capacity.wrongSchemaVersion', () => capacityOf({}), () => capacityOf({ evidenceSchemaVersion: '2.0.0' }), 'is evidence schema 2.0.0 and the tree declares 3.0.0');
rule('capacity.oneReproduction', () => capacityOf({}), () => capacityOf({ reproductions: [{ packageDigest: 'a'.repeat(64), wallClockMs: 1, stages: [] }] }), 'records 1 reproductions; 2 are required');
rule('capacity.missingStage', () => capacityOf({}), () => capacityOf({ stages: CAPACITY_STAGES.filter((name) => name !== 'cleanup').map(stage) }), 'records no cleanup stage');
rule(
  'capacity.metricAbsentWithoutAReason',
  () => capacityOf({}),
  () => capacityOf({ stages: [{ ...stage('profile'), peakRssBytes: null, peakRssBytesReason: undefined }, ...CAPACITY_STAGES.slice(1).map(stage)] }),
  'peakRssBytes is null without a reason',
);
rule('capacity.stampedBlock', () => capacityOf({}), () => capacityOf({ candidate: { writtenBy: 'tools/candidate-provenance.mjs' } }), 'capacity evidence is bound by its producer capture, not by a stamp');
rule('capacity.displayUnit', () => capacityOf({}), () => capacityOf({ measured: { ...capacityRecord().measured, peakMiB: 1 } }), 'denominated in a display unit');
rule('capacity.unattested', () => capacityOf({}), () => capacityOf({ verification: { ok: true, checksRun: 55, problems: [], attestationOk: false } }), 'attestationOk is false');

// The matrix's declared scale, which used to compare a number with itself.
rule(
  'matrix.belowDeclaredScale',
  () => matrixEntryProblems({ profileId: 'P1', planned: { sourceRows: 1_000_000 }, produced: { sourceRows: 1_000_000, result: 'PASS' }, rung: 1_000_000 }),
  () => matrixEntryProblems({ profileId: 'P1', planned: { sourceRows: 1_000_000 }, produced: { sourceRows: 500_000, result: 'PASS' }, rung: 1_000_000 }),
  'produced 500000 source rows and the declared profile at rung 1000000 yields 1000000',
);
rule(
  'matrix.notRun',
  () => matrixEntryProblems({ profileId: 'P1', planned: { sourceRows: 1 }, produced: { sourceRows: 1, result: 'PASS' }, rung: 1 }),
  () => matrixEntryProblems({ profileId: 'P1', planned: { sourceRows: 1 }, produced: undefined, rung: 1 }),
  'P1 was not run',
);

// --------------------------------------------------------------- universe

const universe = (mutate = () => {}) => {
  const report = {
    schemaVersion: UNIVERSE_SCHEMA_VERSION,
    scope: 'FULL',
    steps: UNIVERSE_STEP_IDS.map((id) => ({ id, ok: true, status: 'ok', skipped: false, exitStatus: 0, outputSha256: 'a'.repeat(64), logPath: `${id}.log` })),
  };
  mutate(report);
  return universeReportProblems(report);
};

rule('universe.missingStep', () => universe(), () => universe((report) => { report.steps = report.steps.filter((step) => step.id !== 'sabotage'); }), 'step "sabotage" is missing from the report');
rule('universe.duplicatedStep', () => universe(), () => universe((report) => { report.steps.push({ ...report.steps[0] }); }), 'appears 2 times');
rule('universe.emptyReport', () => universe(), () => universe((report) => { report.steps = []; }), 'records no steps at all');
rule('universe.skippedStep', () => universe(), () => universe((report) => { report.steps[0].skipped = true; }), 'was skipped');
rule('universe.quickScope', () => universe(), () => universe((report) => { report.scope = 'QUICK'; }), 'only a FULL run qualifies a candidate');
rule('universe.stepWithoutItsOutput', () => universe(), () => universe((report) => { report.steps[0].outputSha256 = null; }), 'records no digest of its full output');
rule('universe.unknownStep', () => universe(), () => universe((report) => { report.steps.push({ id: 'invented', ok: true, status: 'ok', skipped: false, exitStatus: 0, outputSha256: 'a'.repeat(64), logPath: 'x' }); }), 'is not in the normative inventory');

// ----------------------------------------------------------------- oracles

const ocr = (mutate = (list) => list) => oracleProblems('sf-ocr.json', mutate(SF_OCR_CASES.map((id) => ({ id, ok: true }))));

rule('oracle.missingCase', () => ocr(), () => ocr((list) => list.filter((entry) => entry.id !== 'O1')), 'is missing the declared cases O1');
rule('oracle.duplicateCase', () => ocr(), () => ocr((list) => [...list, { id: 'O1', ok: true }]), 'records O1 2 times');
rule('oracle.emptyCases', () => ocr(), () => ocr(() => []), 'records no cases');
rule('oracle.undeclaredCase', () => ocr(), () => ocr((list) => [...list, { id: 'Z9.invented', ok: true }]), 'records cases the oracle does not declare: Z9.invented');
rule(
  'oracle.familiesFloor',
  () => oracleProblems('sf-target-contract.json', [...Array.from({ length: 10 }, (unused, index) => ({ id: `contract.check${String(index)}`, ok: true })), { id: 'matching.one', ok: true }]),
  () => oracleProblems('sf-target-contract.json', [{ id: 'contract.only', ok: true }]),
  'below the 10 a real capture exercises',
);

// ------------------------------------------------------------------- facts

rule(
  'facts.booleanInsteadOfEnvelope',
  () => factsProblems({ a: { value: true, by: 'EXECUTED' } }, 'g').problems,
  () => factsProblems({ a: true }, 'g').problems,
  'rather than {value, by, observed}',
);
rule(
  'facts.decidedElsewhereCarriesAValue',
  () => factsProblems({ a: { value: null, by: 'DECIDED_ELSEWHERE' } }, 'g').problems,
  () => factsProblems({ a: { value: false, by: 'DECIDED_ELSEWHERE' } }, 'g').problems,
  'is decided elsewhere and still carries the value',
);

// ---------------------------------------------------------------- versions

rule(
  'versions.belowFloor',
  () => versionFloorProblems({ ...VERSION_FLOORS }),
  () => versionFloorProblems({ ...VERSION_FLOORS, coreVersion: '1.9.9' }),
  'coreVersion is 1.9.9, below the floor 2.0.0',
);
rule(
  'versions.undeclared',
  () => versionFloorProblems({ ...VERSION_FLOORS }),
  () => versionFloorProblems({ ...VERSION_FLOORS, packageFormatVersion: undefined }),
  'packageFormatVersion is not declared anywhere the tree reads it from',
);
rule(
  'versions.aboveFloorIsAccepted',
  () => versionFloorProblems({ ...VERSION_FLOORS, coreVersion: '3.1.0' }),
  () => versionFloorProblems({ ...VERSION_FLOORS, coreVersion: 'not-a-version' }),
  'coreVersion is not-a-version, below the floor',
);

// ------------------------------------------------------- invalidation graph
//
// The two directions the policy exists for: an editorial change must not move
// the subject, and a change to a runner, an oracle, a mapper, a contract or the
// engine must.

const editorialPaths = ['README.md', 'docs/CONTRACT.md', 'docs/work/MC2_EXECUTION_STATE.md', 'qualification/hubspot/README.md', 'bench/README.md'];
const semanticPaths = [
  ['src/run/run-migration.ts', 'SEMANTIC_RUNTIME'],
  ['src/adapters/specs.ts', 'SEMANTIC_CONTRACT'],
  ['src/target/contract.ts', 'SEMANTIC_CONTRACT'],
  ['tools/capacity.mjs', 'SEMANTIC_HARNESS'],
  ['qualification/hubspot/run-import-qualification.mjs', 'SEMANTIC_HARNESS'],
  ['qualification/hubspot/EXPECTED_TRUTH.md', 'SEMANTIC_ORACLE'],
  ['qualification/hubspot/corpus/Q1/contacts.csv', 'SEMANTIC_ORACLE'],
  ['qualification/capacity/profiles.json', 'SEMANTIC_ORACLE'],
  ['test/fixtures/golden/G01/input/contacts.csv', 'SEMANTIC_ORACLE'],
  ['package-lock.json', 'SEMANTIC_RUNTIME'],
  ['.github/workflows/ci.yml', 'WORKFLOW'],
  // The launchers. Both were EDITORIAL, which is how a launcher that swallowed a
  // failed gate could change without anything noticing.
  ['bench/prepare-universe.sh', 'SEMANTIC_HARNESS'],
  ['bench/campaign.sh', 'SEMANTIC_HARNESS'],
];

for (const path of editorialPaths) {
  const id = `invalidation.editorial(${path})`;
  const observed = classifyPath(path);
  const consequence = consequenceOf([path]);
  cases.push({
    id,
    ok: observed === 'EDITORIAL' && !consequence.subjectMoved && !consequence.requalify && consequence.editorialOnly,
    expected: 'EDITORIAL, and the subject unmoved',
    observed: `${observed}, subjectMoved=${String(consequence.subjectMoved)}`,
    detail: null,
  });
}
for (const [path, expected] of semanticPaths) {
  const id = `invalidation.semantic(${path})`;
  const observed = classifyPath(path);
  const consequence = consequenceOf([path]);
  const requalifies = expected !== 'WORKFLOW';
  cases.push({
    id,
    ok: observed === expected && consequence.subjectMoved && consequence.requalify === requalifies,
    expected: `${expected}, and the subject moved`,
    observed: `${observed}, subjectMoved=${String(consequence.subjectMoved)}, requalify=${String(consequence.requalify)}`,
    detail: null,
  });
}
cases.push({
  id: 'invalidation.everyClassIsReachable',
  ok: CHANGE_CLASSES.every((name) => name === 'GENERATED' || name === 'EVIDENCE' || [...editorialPaths.map(classifyPath), ...semanticPaths.map(([path]) => classifyPath(path))].includes(name)),
  expected: 'every class this test does not exercise by construction is exercised',
  observed: CHANGE_CLASSES.join(', '),
  detail: null,
});
cases.push({
  id: 'invalidation.evidenceIsNotAnInput',
  ok:
    classifyPath('qualification/evidence/hs-import.json') === 'EVIDENCE' &&
    classifyPath('qualification/capacity/hubspot.json') === 'EVIDENCE' &&
    // The release provenance record, by the name the tree actually writes. The
    // pattern carried the v1 name the file had before it was renamed, so this
    // classified as EDITORIAL and a regenerated provenance reported
    // "editorial only, the campaign stands" — about the document that describes
    // the campaign.
    classifyPath('migration-core-provenance.json') === 'EVIDENCE' &&
    !consequenceOf(['migration-core-provenance.json']).editorialOnly &&
    !consequenceOf(['qualification/evidence/hs-import.json']).subjectMoved,
  expected: 'a measurement is an output of the subject, never part of it',
  observed: classifyPath('qualification/evidence/hs-import.json'),
  detail: null,
});
cases.push({
  id: 'invalidation.semverComparison',
  ok: semverAtLeast('2.0.0', '2.0.0') && semverAtLeast('2.0.1', '2.0.0') && semverAtLeast('3.0.0', '2.9.9') && !semverAtLeast('1.9.9', '2.0.0') && !semverAtLeast('x', '2.0.0'),
  expected: 'a floor is cleared by equal and by later, and never by earlier or unparseable',
  observed: 'checked',
  detail: null,
});

/**
 * The subject digest holds still for what a campaign produces, and moves for
 * what a campaign measures.
 *
 * This is the rule the whole campaign rests on and it was wrong: the digest was
 * taken over the full class census, so a producer writing its own evidence
 * moved the subject and the *next* producer of the same campaign refused to
 * start. One vendor gate per campaign, and the refusal reads like an operator
 * error. Exercised here on a synthetic subject rather than on the tree, so the
 * case is deterministic and cannot be made to pass by editing a file.
 */
{
  const subjectOf = (overrides) => ({
    subjectVersion: '1.0.0',
    digestSerialisationVersion: '2.0.0',
    codeDigest: 'c'.repeat(64),
    classes: {
      SEMANTIC_RUNTIME: { files: 51, bytes: 1000, digest: 'r'.repeat(64), inSubject: true },
      SEMANTIC_ORACLE: { files: 210, bytes: 2000, digest: 'o'.repeat(64), inSubject: true },
      EVIDENCE: { files: 13, bytes: 3000, digest: 'e'.repeat(64), inSubject: false },
      EDITORIAL: { files: 23, bytes: 4000, digest: 'd'.repeat(64), inSubject: false },
      GENERATED: { files: 139, bytes: 5000, digest: 'g'.repeat(64), inSubject: false },
      ...overrides,
    },
    subjectFileCount: 261,
    dependencies: { lockfileVersion: 3, packageCount: 7, closureDigest: 'p'.repeat(64), packages: [] },
    versions: { core: '2.0.0' },
  });
  const digestOf = (subject) => createHash('sha256').update(canonical(subjectValue(subject)), 'utf8').digest('hex');
  const base = digestOf(subjectOf({}));
  const afterEvidence = digestOf(subjectOf({ EVIDENCE: { files: 14, bytes: 3100, digest: 'E'.repeat(64), inSubject: false } }));
  const afterEditorial = digestOf(subjectOf({ EDITORIAL: { files: 23, bytes: 4100, digest: 'D'.repeat(64), inSubject: false } }));
  const afterGenerated = digestOf(subjectOf({ GENERATED: { files: 140, bytes: 5100, digest: 'G'.repeat(64), inSubject: false } }));
  const afterRuntime = digestOf(subjectOf({ SEMANTIC_RUNTIME: { files: 51, bytes: 1001, digest: 'R'.repeat(64), inSubject: true } }));
  const afterOracle = digestOf(subjectOf({ SEMANTIC_ORACLE: { files: 211, bytes: 2000, digest: 'O'.repeat(64), inSubject: true } }));
  cases.push({
    id: 'subject.evidenceDoesNotMoveTheSubject',
    ok: afterEvidence === base && afterEditorial === base && afterGenerated === base,
    expected: 'writing evidence, prose or a generated document leaves the subject digest where it was',
    observed: `evidence ${afterEvidence === base ? 'held' : 'moved'}, editorial ${afterEditorial === base ? 'held' : 'moved'}, generated ${afterGenerated === base ? 'held' : 'moved'}`,
    detail:
      afterEvidence === base && afterEditorial === base && afterGenerated === base
        ? null
        : 'a producer that writes evidence would invalidate the campaign for every producer after it',
  });
  cases.push({
    id: 'subject.semanticChangeMovesTheSubject',
    ok: afterRuntime !== base && afterOracle !== base,
    expected: 'a change to the engine or to what it is judged against moves the subject digest',
    observed: `runtime ${afterRuntime === base ? 'held' : 'moved'}, oracle ${afterOracle === base ? 'held' : 'moved'}`,
    detail: afterRuntime !== base && afterOracle !== base ? null : 'evidence taken before the change would still be accepted',
  });
}

// ---------------------------------------------------------------- closures

{
  const measured = measureTree();
  const records = measured.records ?? [];
  const capacity = traceClosure('tools/capacity.mjs', records);
  const has = (path) => capacity.files.includes(path);
  const excluded = ['tools/sabotage.mjs', 'tools/freeze-verdict.mjs', 'tools/universe.mjs', 'tools/release-candidate-gate.mjs', 'tools/evidence-schema.mjs'].filter(has);
  const required = ['tools/capacity.mjs', 'tools/capacity-profiles.mjs', 'tools/capacity-stages.mjs', 'qualification/capacity/profiles.json', 'src/version.ts', 'src/run/run-migration.ts', 'package-lock.json'].filter((path) => !has(path));
  cases.push({
    id: 'closure.capacityExcludesOtherGates',
    ok: excluded.length === 0 && capacity.unresolved.length === 0,
    expected: 'the capacity producer does not depend on the sabotage harness, the freeze verdict, the universe, the release gate or the validator',
    observed: excluded.length === 0 ? `${String(capacity.files.length)} files, none of them` : `includes ${excluded.join(', ')}`,
    detail: excluded.length === 0 ? null : 'a change to another gate would invalidate capacity evidence it could not have affected',
  });
  cases.push({
    id: 'closure.capacityIncludesWhatItReads',
    ok: required.length === 0,
    expected: 'the capacity producer depends on its own harness, the profiles it scales by, and the whole engine',
    observed: required.length === 0 ? 'all present' : `missing ${required.join(', ')}`,
    detail: null,
  });
  // A hole refuses. Remove one file the producer imports from the records and
  // the fingerprint must come back null rather than a digest over what is left.
  const withoutStages = records.filter((entry) => entry.path !== 'tools/capacity-stages.mjs');
  const holed = fingerprintProducer('tools/capacity.mjs', withoutStages);
  cases.push({
    id: 'closure.unresolvedImportRefusesToFingerprint',
    ok: holed.fingerprint === null && holed.unresolved.includes('tools/capacity-stages.mjs'),
    expected: 'a producer whose import resolves to nothing tracked has no fingerprint',
    observed: holed.fingerprint === null ? `null, unresolved ${holed.unresolved.join(', ')}` : 'a fingerprint was computed over a closure with a hole in it',
    detail: null,
  });
  // A file inside the closure moves the fingerprint; a file outside it does not.
  const base = fingerprintProducer('tools/capacity.mjs', records).fingerprint;
  const bump = (path) => records.map((entry) => (entry.path === path ? { ...entry, sha256: 'e'.repeat(64) } : entry));
  const insideMoved = fingerprintProducer('tools/capacity.mjs', bump('src/run/run-migration.ts')).fingerprint;
  const outsideMoved = fingerprintProducer('tools/capacity.mjs', bump('tools/sabotage.mjs')).fingerprint;
  cases.push({
    id: 'closure.onlyItsOwnInputsMoveTheFingerprint',
    ok: base !== null && insideMoved !== base && outsideMoved === base,
    expected: 'changing the engine moves the capacity fingerprint; changing the sabotage harness does not',
    observed: `engine change ${insideMoved === base ? 'held' : 'moved'}, sabotage change ${outsideMoved === base ? 'held' : 'moved'}`,
    detail: null,
  });
  // S092. Only a scorer changes. The scorer (the validator the gates judge
  // evidence with) is not something any producer imports, so the fingerprint of
  // every measuring producer holds: the evidence they recorded is still about
  // the bytes they measured.
  const measuring = Object.keys(PRODUCERS).filter((producer) => PRODUCERS[producer].kind !== 'UNIVERSE');
  {
    const scorer = 'tools/evidence-schema.mjs';
    const imported = measuring.filter((producer) => traceClosure(producer, records).files.includes(scorer));
    const held = measuring.filter((producer) => fingerprintProducer(producer, bump(scorer)).fingerprint === fingerprintProducer(producer, records).fingerprint);
    cases.push({
      id: 'closure.scorerOnlyChangeKeepsProducerFingerprint',
      ok: records.some((entry) => entry.path === scorer) && imported.length === 0 && held.length === measuring.length,
      expected: `a change to ${scorer}, which no measuring producer imports, leaves every measuring producer's fingerprint where it was`,
      observed: `${String(held.length)} of ${String(measuring.length)} held; imported by ${imported.length === 0 ? 'none' : imported.join(', ')}`,
      detail: null,
    });
  }
  // The control. A scorer the producer DOES import (the vendor oracle
  // module the runners read their expected cases from) is an input: changing
  // it moves the fingerprint of exactly the producers that import it, and
  // evidence recorded under the old fingerprint is not reusable without an
  // equivalence record that names the change.
  {
    const scorer = 'qualification/oracles.mjs';
    const importing = measuring.filter((producer) => traceClosure(producer, records).files.includes(scorer));
    const moved = measuring.filter((producer) => fingerprintProducer(producer, bump(scorer)).fingerprint !== fingerprintProducer(producer, records).fingerprint);
    cases.push({
      id: 'closure.scorerInsideAProducerImportMovesTheFingerprint',
      ok: importing.length > 0 && moved.length === importing.length && importing.every((producer) => moved.includes(producer)),
      expected: `a change to ${scorer} moves the fingerprint of every producer that imports it, and of no other`,
      observed: `imported by ${String(importing.length)}, moved ${String(moved.length)}`,
      detail: null,
    });
    const producer = importing[0] ?? 'qualification/hubspot/run-import-qualification.mjs';
    const before = fingerprintProducer(producer, records);
    const after = fingerprintProducer(producer, bump(scorer));
    const difference = closureDiff(before.closure, after.closure);
    const recorded = { fingerprint: before.fingerprint, closure: before.closure };
    const current = { fingerprint: after.fingerprint, closure: after.closure };
    const refusedBare = evidenceReuseProblems({ producer, recorded, current, equivalence: null });
    const heldSame = evidenceReuseProblems({ producer, recorded, current: recorded, equivalence: null });
    const sound = { producer, from: before.fingerprint, to: after.fingerprint, changed: difference.changed, added: difference.added, removed: difference.removed, argument: 'The oracle module gained a case the runner does not execute; the measured path imports only the cases it names, none of which changed.' };
    const accepted = evidenceReuseProblems({ producer, recorded, current, equivalence: sound });
    const blanket = evidenceReuseProblems({ producer, recorded, current, equivalence: { ...sound, changed: [], argument: 'still fine' } });
    const foreign = evidenceReuseProblems({ producer, recorded, current, equivalence: { ...sound, to: 'd'.repeat(64) } });
    cases.push({
      id: 'reuse.withoutEquivalenceRecordRefused',
      ok:
        heldSame.length === 0 &&
        refusedBare.length === 1 && refusedBare[0].includes('no equivalence record') &&
        accepted.length === 0 &&
        blanket.length > 0 &&
        foreign.length > 0,
      expected: 'unchanged fingerprint: reusable; moved fingerprint with no record: refused; a record that names the change and the argument: accepted; a blanket or foreign record: refused',
      observed: `held ${heldSame.length}, bare ${refusedBare.length}, sound ${accepted.length}, blanket ${blanket.length}, foreign ${foreign.length}`,
      detail: [...refusedBare, ...accepted, ...blanket, ...foreign].join('; ') || null,
    });
  }
  // The universe reads the whole subject and nothing outside it. Its own
  // report, the campaign seal, the manifest and the evidence files are what
  // the subject produces; a fingerprint that covered them would move when the
  // campaign was sealed and again when the universe wrote its report.
  {
    const universe = traceClosure('tools/universe.mjs', records);
    const outputsInside = universe.files.filter((path) => !SUBJECT_CLASSES.includes(classifyPath(path)));
    const sealMoves = fingerprintProducer('tools/universe.mjs', bump('qualification/candidate/campaign.json')).fingerprint !== fingerprintProducer('tools/universe.mjs', records).fingerprint;
    const reportMoves = fingerprintProducer('tools/universe.mjs', bump('qualification/candidate/universe.json')).fingerprint !== fingerprintProducer('tools/universe.mjs', records).fingerprint;
    const engineMoves = fingerprintProducer('tools/universe.mjs', bump('src/run/run-migration.ts')).fingerprint !== fingerprintProducer('tools/universe.mjs', records).fingerprint;
    cases.push({
      id: 'closure.universeReadsTheSubjectNotItsOutputs',
      ok: outputsInside.length === 0 && !sealMoves && !reportMoves && engineMoves,
      expected: 'the universe fingerprint covers every subject file and no evidence, record or prose; sealing and writing its report leave it alone, the engine moves it',
      observed: outputsInside.length === 0 ? `${String(universe.files.length)} subject files; seal ${sealMoves ? 'moved' : 'held'}, report ${reportMoves ? 'moved' : 'held'}, engine ${engineMoves ? 'moved' : 'held'}` : `includes ${outputsInside.slice(0, 5).join(', ')}`,
      detail: null,
    });
  }
  // The batch the recovery audit asks for, as one table: one changed path per
  // row, and for each producer whether its fingerprint must move or must
  // hold. A class is a diagnostic; the unit of invalidation is the producer,
  // and this is where the two are shown to differ — a change to the sabotage
  // harness or the release verifier moves the subject and no measurement.
  {
    const producersAll = Object.keys(PRODUCERS).filter((producer) => PRODUCERS[producer].kind !== 'UNIVERSE');
    const CAPACITY = ['tools/capacity.mjs'];
    const VENDORS = producersAll.filter((producer) => PRODUCERS[producer].kind === 'VENDOR');
    const HUBSPOT = VENDORS.filter((producer) => producer.includes('/hubspot/'));
    const SALESFORCE = VENDORS.filter((producer) => producer.includes('/salesforce/'));
    const NONE = [];
    const ALL = producersAll;
    const batch = [
      ['editorial only', 'README.md', NONE, false],
      ['executable launcher', 'bench/campaign.sh', NONE, true],
      ['capacity runner', 'tools/capacity.mjs', CAPACITY, true],
      ['capacity oracle', 'qualification/capacity/profiles.json', CAPACITY, true],
      ['shared contract', 'src/domain/config.ts', ALL, true],
      ['serializer/version', 'src/version.ts', ALL, true],
      ['dependency', 'package-lock.json', ALL, true],
      ['workflow', '.github/workflows/ci.yml', NONE, true],
      ['isolated sabotage', 'tools/sabotage.mjs', NONE, true],
      ['release verifier', 'tools/freeze-verdict.mjs', NONE, true],
      ['dossier verifier', 'tools/release-dossier.mjs', NONE, true],
      ['vendor oracle (HubSpot)', 'qualification/hubspot/EXPECTED_TRUTH.md', HUBSPOT, true],
      ['vendor corpus (HubSpot)', 'qualification/hubspot/corpus/Q1-create/config.json', HUBSPOT.filter((producer) => producer.includes('run-import')), true],
      ['vendor oracle (Salesforce)', 'qualification/salesforce/EXPECTED_TRUTH.md', SALESFORCE, true],
      ['instance allowlist', 'qualification/authorized-instances.json', VENDORS, true],
      ['campaign binding', 'qualification/campaign.mjs', ALL, true],
      ['closure tracer', 'tools/producer-closure.mjs', ALL, true],
    ];
    const baseline = Object.fromEntries(producersAll.map((producer) => [producer, fingerprintProducer(producer, records).fingerprint]));
    for (const [label, path, mustMove, subjectMoves] of batch) {
      if (!records.some((entry) => entry.path === path)) {
        cases.push({ id: `batch.${label}`, ok: false, expected: `${path} is tracked so the row can be exercised`, observed: 'not in the tree', detail: null });
        continue;
      }
      const moved = bump(path);
      const movedNow = producersAll.filter((producer) => fingerprintProducer(producer, moved).fingerprint !== baseline[producer]);
      const wrongMoved = movedNow.filter((producer) => !mustMove.includes(producer));
      const wrongHeld = mustMove.filter((producer) => !movedNow.includes(producer));
      const consequence = consequenceOf([path]);
      cases.push({
        id: `batch.${label}`,
        ok: wrongMoved.length === 0 && wrongHeld.length === 0 && consequence.subjectMoved === subjectMoves,
        expected: `${path}: moves ${mustMove.length === 0 ? 'no producer' : mustMove.length === producersAll.length ? 'every producer' : mustMove.map((producer) => producer.split('/').pop()).join(', ')}; subject ${subjectMoves ? 'moves' : 'holds'}`,
        observed: `moved ${movedNow.length === 0 ? 'none' : movedNow.map((producer) => producer.split('/').pop()).join(', ')}; subject ${consequence.subjectMoved ? 'moved' : 'held'}`,
        detail: wrongMoved.length > 0 ? `moved without reading it: ${wrongMoved.join(', ')}` : wrongHeld.length > 0 ? `held although it reads it: ${wrongHeld.join(', ')}` : null,
      });
    }
  }
  cases.push({
    id: 'closure.everyProducerIsDeclaredAndResolves',
    ok: Object.keys(PRODUCERS).every((producer) => fingerprintProducer(producer, records).fingerprint !== null),
    expected: 'every declared producer fingerprints over this tree',
    observed: Object.keys(PRODUCERS).map((producer) => `${producer.split('/').pop()}=${fingerprintProducer(producer, records).fingerprint === null ? 'UNRESOLVED' : 'ok'}`).join(' '),
    detail: null,
  });
}

// ---------------------------------------------------------------- report

const failures = cases.filter((entry) => !entry.ok);
const evidenceIndex = process.argv.indexOf('--evidence');
if (evidenceIndex !== -1 && process.argv[evidenceIndex + 1] !== undefined) {
  writeFileSync(
    process.argv[evidenceIndex + 1],
    `${JSON.stringify(
      {
        gate: 'EVIDENCE-RULES-01',
        observedAt: `${new Date().toISOString().slice(0, 19)}Z`,
        checksRun: cases.length,
        cases,
        failures: failures.map((entry) => `${entry.id}: ${String(entry.detail)}`),
        result: failures.length === 0 ? 'PASS' : 'FAIL',
      },
      null,
      2,
    )}\n`,
  );
}

process.stderr.write(`\nEVIDENCE-RULES-01: ${String(cases.length)} rules, each proved to fire\n\n`);
for (const entry of failures) process.stderr.write(`  FAIL ${entry.id}: ${String(entry.detail)}\n`);
process.stderr.write(`\nEVIDENCE-RULES-01 = ${failures.length === 0 ? 'PASS' : 'FAIL'}\n\n`);
process.stdout.write(`${JSON.stringify({ gate: 'EVIDENCE-RULES-01', checksRun: cases.length, failures: failures.length, passed: failures.length === 0 }, null, 2)}\n`);
process.exit(failures.length === 0 ? 0 : 1);
