#!/usr/bin/env node
// Scorer validity before spending (B04-SCORER, D4-SCORE-2). Proves the scorer on a sealed corpus with no model and no network:
// the positive control is the truth-following answer of every fixture through the public core behind a SIMULATED scripted
// transport, the sabotage set per family mutates those real results, the always-abstaining candidate is the usefulness floor;
// then writes the validity record bound to the digest of the scorer and the digest of the corpus. The campaign runner refuses a
// funded stage without a record for the pair.
// Run `npm run build` first: this reads the compiled framework from dist/.
//   node tools/campaign/scorer-validity.mjs [--corpus corpus] [--out <record.json>] [--abstain-runs 3]    run and write
//   node tools/campaign/scorer-validity.mjs --check <record.json> [--corpus corpus]                         is the record valid for the current scorer and corpus?
// Validity v4 (mandate 4.5, S044): the record also binds the package the controls ran on (content digest of its npm pack tarball),
// Migration Core (version and the sha256 of its release tarball), the prompt bundle hash and the model policy hash. In this tree the
// tool packs the tree and binds vendor/ (whose bytes must equal vendor/MANIFEST.json). Inside a clean install (preflight's rerun) it is
// told what was installed:
//   --ic-tarball <tgz> --mc-tarball <tgz> --scorer-digest <hex>    the tarballs the clean install was made of, the scorer digest of the source
//   --binding-only                                                print the release binding as JSON and stop (no control is run)
// The corpus directory holds MANIFEST.json and fixtures/ (a rehearsal reseal into a temp directory has the same shape).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION } from 'kauro-migration-core';
import { MODEL_POLICY_HASH, PROMPT_BUNDLE_HASH, buildValidityRecord, validityRecordProblems, verifyCorpus } from 'kauro-intelligence-core/benchmark';
import { fileSha256, packTree, packageDigestOfTarball } from './package-digest.mjs';
import { currentScorerDigest, loadCorpus, runPublicControls } from './validity-run.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? fallback) : fallback; };

/** The release binding (v4): of the tarballs named, or of this tree packed now and its vendored Migration Core. */
function releaseBinding() {
  let icTarball = option('--ic-tarball', null);
  let mcTarball = option('--mc-tarball', null);
  let scratch = null;
  try {
    if (icTarball === null) { scratch = mkdtempSync(join(tmpdir(), 'kauro-ic-validity-pack-')); icTarball = packTree(repo, scratch); }
    if (mcTarball === null) {
      const manifest = JSON.parse(readFileSync(join(repo, 'vendor', 'MANIFEST.json'), 'utf8'));
      mcTarball = join(repo, manifest.file);
      if (fileSha256(mcTarball) !== manifest.sha256 || manifest.version !== CORE_VERSION) { process.stderr.write(`${manifest.file} is not the release vendor/MANIFEST.json names (sha256 ${manifest.sha256}, version ${manifest.version}) or not the installed core ${CORE_VERSION}
`); process.exit(2); }
    }
    return { icPackageDigest: packageDigestOfTarball(resolve(icTarball)), migrationCoreVersion: CORE_VERSION, migrationCoreTarballSha256: fileSha256(resolve(mcTarball)), promptBundleHash: PROMPT_BUNDLE_HASH, modelPolicyHash: MODEL_POLICY_HASH };
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}
const release = releaseBinding();
if (args.includes('--binding-only')) { process.stdout.write(`${JSON.stringify(release)}
`); process.exit(0); }
const scorerDigest = option('--scorer-digest', null) ?? currentScorerDigest();

const corpusDir = resolve(repo, option('--corpus', 'corpus'));
const corpus = loadCorpus(corpusDir);
const problems = verifyCorpus(corpus.manifest, corpus.fixtures);
if (problems.length > 0) { process.stderr.write(`the corpus in ${corpusDir} is not what its manifest sealed:\n  ${problems.slice(0, 10).join('\n  ')}\n`); process.exit(2); }

if (args.includes('--check')) {
  const record = JSON.parse(readFileSync(resolve(option('--check', '')), 'utf8'));
  const found = validityRecordProblems(record, { scorerDigest, corpusDigest: corpus.manifest.corpusDigest, release });
  process.stdout.write(found.length === 0 ? 'validity record is valid for the current scorer and corpus\n' : `validity record refused: ${found.join('; ')}\n`);
  process.exit(found.length === 0 ? 0 : 1);
}

const started = Date.now();
const controls = await runPublicControls(corpus.fixtures, { abstainRuns: Number(option('--abstain-runs', '3')), onProgress: (done, total) => { if (done % 50 === 0 || done === total) process.stderr.write(`  ${String(done)}/${String(total)} fixtures run (${String(Math.round((Date.now() - started) / 1000))}s)\n`); } });
const record = buildValidityRecord({
  scorerDigest, corpusDigest: corpus.manifest.corpusDigest, release, fixtures: corpus.fixtures.map((entry) => entry.fixture),
  capabilityOf: new Map(corpus.manifest.fixtures.map((entry) => [entry.fixtureId, entry.capability])), publicRun: controls.publicRun, truthRuns: controls.truthRuns, alwaysAbstainRuns: controls.alwaysAbstainRuns,
  repairControls: controls.repairControls, measureEveryTask: corpus.fixtures.length >= 600,
});
const out = resolve(repo, option('--out', join(corpusDir, 'scorer-validity.json')));
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
const unreachable = record.publicRunControls.unreachable;
process.stdout.write([
  `scorer validity (${record.evidenceClass}) over ${String(record.fixtures)} fixtures, corpus ${record.corpusDigest.slice(0, 12)}, scorer ${record.scorerDigest.slice(0, 12)}`,
  `  scorerValid=${String(record.scorerValid)}${record.problems.length > 0 ? ` problems=${record.problems.join(',')}` : ''}; opensFundedStage=${String(record.opensFundedStage)}${record.blockers.length > 0 ? ` blockers=${record.blockers.join(',')}` : ''}`,
  `  positive control, public run (truth-following, scripted SIMULATED transport): ${String(record.publicRunControls.reached)}/${String(record.publicRunControls.fixtures)} reached their sealed truth and scored correct; corpusReachable=${String(record.corpusReachable)}; unreachable ${String(unreachable.length)}; contradictory truths ${String(record.contradictoryTruths.length)}`,
  `  sabotage of those results: ${String(record.sabotage.caughtForIntendedReason)}/${String(record.sabotage.applied)} caught for the intended reason (${String(record.sabotage.withoutBase)} fixtures without a base); copied reports ${String(record.sabotage.copiedReports.caught)}/${String(record.sabotage.copiedReports.applied)}; unexercised ${String(record.sabotage.unexercised.length)}`,
  `  tasks measured by the truth-following public run (SEMANTIC_REPAIR: repair controls repaired to truth): ${Object.entries(record.tasksMeasured).map(([task, count]) => `${task}=${String(count)}`).join(' ')}; unmeasured [${record.unmeasuredTasks.join(', ')}]`,
  `  always-abstain floor: holds=${String(record.usefulnessFloor.holds)} gate violations ${record.usefulnessFloor.hardGateViolations.join('/')} supported correctness ${record.usefulnessFloor.supportedCorrectness.join('/')}`,
  `  bound to: package ${release.icPackageDigest.slice(0, 12)} (content of its npm pack), Migration Core ${release.migrationCoreVersion} tarball ${release.migrationCoreTarballSha256.slice(0, 12)}, prompt bundle ${release.promptBundleHash.slice(0, 12)}, model policy ${release.modelPolicyHash.slice(0, 12)}`,
  `  record: ${out}`,
].join('\n') + '\n');
process.exit(record.opensFundedStage ? 0 : 1);
