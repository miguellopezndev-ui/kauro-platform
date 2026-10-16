#!/usr/bin/env node
// The campaign runner (B04-CAMPAIGN; B04-campaign-envelope §8). Stages: smoke, pilot, qualify (funded) and rehearse (offline).
// Amazon Bedrock (owner decision A9): a us. geography inference profile called from us-east-1 (or us-west-2 when probe P2 says so),
// temporary credentials (aws sso login; aws-credentials.mjs), and the free probes P1-P8 before the first paid byte (aws-probes.mjs).
//   npm run campaign -- --stage smoke   --aws-account <12 digits> --grant <grant.json> --retention-evidence <json> [--region us-east-1] [--aws-profile <p>] [--candidate SONNET_5_5_US|OPUS_5_5_US]
//   npm run campaign -- --stage pilot   --aws-account <12 digits> --grant <grant.json> --retention-evidence <json> [--candidate ...]   # no --candidate: every admitted candidate, Sonnet first (G51), one grant, one stop rule, then the selection record
//   npm run campaign -- --stage qualify --aws-account <12 digits> --grant <grant.json> --retention-evidence <json> --candidate SONNET_5_5_US --run 1|2|3 --pilot-summary <pilot summary.json>   # only the candidate the pilot selected, under the pinned policy
//   npm run campaign -- --stage rehearse            # no grant, no network, recorded SIMULATED transport, never qualification evidence
//   npm run campaign -- --stage rehearse --seam tools/campaign/chaos-seam.mjs --shape pilot|qualification [--limit N] [--kill-at-fixture K]   # the chaos rehearsal (docs/work/CHAOS_REHEARSAL.md), SIMULATED
// A funded stage is refused (nothing installed, nothing written, nothing sent) without a grant that funds it, without the
// scorer-validity record of the current scorer and corpus, and without the probes P1-P8 (model invocation logging OFF among them).
// A grant is spent through its durable ledger beside the grant file (<grant>.ledger.jsonl, locked while a stage runs): smoke and
// pilot on grant A, and the three qualification runs on grant B, share one cap each. A contaminated corpus (the latch in
// campaign/state/) is not funded again until it is resealed.
// Run `npm run build` first. The package is packed and installed in a clean directory; the stage runs from there (stage-child.mjs).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MODEL_POLICY_V1 } from 'kauro-intelligence-core/benchmark';
import { awsCredentialProvider } from './aws-credentials.mjs';
import { ledgerPathOf } from './grant-ledger.mjs';
import { auditGrantLedger } from './ledger-audit.mjs';
import { packAndInstall } from './clean-install.mjs';
import { DEFAULT_LATCH_PATH, STAGE_OF, preflight, rerunValidity } from './preflight.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const MODELS = Object.freeze({ SONNET_5_5_US: 'claude-sonnet-5-5', OPUS_5_5_US: 'claude-opus-5-5' });

export { packAndInstall } from './clean-install.mjs';

/** Every earlier invocation's scores.jsonl under the output root (G50): a violation scored there and not yet a STOP in the ledger is rebuilt before any hold. */
function priorScoreJournals(outRoot, outDir) {
  const found = [];
  if (!existsSync(outRoot)) return found;
  for (const stageName of readdirSync(outRoot)) {
    const stageDir = join(outRoot, stageName);
    let runs;
    try { runs = readdirSync(stageDir); } catch { continue; }
    for (const run of runs) {
      const path = join(stageDir, run, 'scores.jsonl');
      if (join(stageDir, run) !== outDir && existsSync(path)) found.push(path);
    }
  }
  return found.sort();
}

const stamp = () => new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14);

/** The two shapes of the chaos rehearsal (mandate 4.4): the grant each runs under is plainly a rehearsal, notional, no money. */
export const CHAOS_SHAPES = Object.freeze({
  pilot: Object.freeze({ stage: 'pilot', stages: ['PILOT'], capMicros: 55_000_000, candidates: ['SONNET_5_5_US', 'OPUS_5_5_US'], maxRuns: null }),
  qualification: Object.freeze({ stage: 'qualify', stages: ['QUALIFICATION'], capMicros: 120_000_000, candidates: ['SONNET_5_5_US'], maxRuns: 4 }),
});

/**
 * `--stage rehearse --seam <module> --shape pilot|qualification`: the funded stage over a stand-in seam, under a rehearsal grant that
 * lives beside the output (reused on a restart: the ledger binds to the whole grant), with the AWS reads skipped (no account is behind
 * a seam). Always SIMULATED. After the stage the summary's grant totals are held against the ledger's own settlements.
 * @param {Record<string, any>} options as runCampaign plus shape, seamOptions ({ killAtFixture, ... } for the seam), capMicros (a smaller notional cap)
 */
async function rehearseOverSeam(options) {
  const shape = options.shape ?? 'pilot';
  const spec = CHAOS_SHAPES[shape];
  if (spec === undefined) return { stage: 'rehearse', ok: false, refusals: [{ code: 'UNKNOWN_SHAPE', detail: `--shape is pilot or qualification, not ${String(shape)}` }], outDir: null, summary: null };
  const outRoot = resolve(options.outRoot ?? join(repo, 'campaign', 'out', 'chaos'));
  mkdirSync(outRoot, { recursive: true });
  const grantPath = join(outRoot, `CHAOS-REHEARSAL-grant-no-money-${shape}.json`);
  const grant = { grantId: `CHAOS-REHEARSAL-${shape.toUpperCase()}-NO-MONEY`, stages: spec.stages, capMicros: options.capMicros ?? spec.capMicros, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), approvalRef: 'chaos rehearsal: SIMULATED, notional cap, no money, not an owner grant', candidates: spec.candidates, maxRuns: spec.maxRuns };
  if (!existsSync(grantPath)) writeFileSync(grantPath, `${JSON.stringify(grant, null, 2)}
`);
  const onDisk = JSON.parse(readFileSync(grantPath, 'utf8'));
  const ran = await runCampaign({
    ...options, stage: spec.stage, simulatedPreflight: true, grantPath, outRoot, rehearsalShape: shape, seamModule: resolve(options.seamModule),
    seamOptions: { ...(options.seamOptions ?? {}), shape }, latchPath: options.latchPath ?? join(outRoot, 'contamination-latch.json'),
    ...(shape === 'qualification' ? { candidate: 'SONNET_5_5_US', runNo: options.runNo ?? 1 } : {}),
  });
  if (ran.summary === null || ran.outDir === null) return ran;
  const audit = auditGrantLedger(ledgerPathOf(grantPath), onDisk, ran.summary);
  const summary = { ...ran.summary, rehearsal: { ...ran.summary.rehearsal, ledgerAudit: audit } };
  writeFileSync(join(ran.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}
`);
  if (!audit.equal) return { ...ran, ok: false, summary, refusals: [{ code: 'LEDGER_TOTALS_MISMATCH', detail: audit.problems.join('; ') }] };
  return { ...ran, summary };
}

/**
 * @param {Record<string, any>} options stage, region, location, awsAccountId, awsProfile, grantPath, validityPath, corpusDir, outRoot, candidate,
 *   candidates (smoke/pilot: several; the pilot runs Sonnet first whatever the order), runNo, pilotSummaryPath, retentionEvidencePath, limit,
 *   credentialProvider, fetchImpl, now, latchPath (tests only: where the contamination latch is kept)
 * @returns {Promise<{ stage: string, ok: boolean, refusals: {code: string, detail: string}[], outDir: string | null, summary: Record<string, any> | null }>}
 */
export async function runCampaign(options) {
  if (options.stage === 'rehearse' && options.seamModule !== undefined && options.seamModule !== null) return rehearseOverSeam(options);
  const stage = options.stage;
  const refusals = [];
  const refuse = (code, detail) => { if (!refusals.some((one) => one.code === code && one.detail === detail)) refusals.push({ code, detail }); };
  const pinnedId = Object.keys(MODELS).find((id) => MODELS[id] === MODEL_POLICY_V1.primaryModel);
  // Smoke and pilot run every ADMITTED candidate unless one is named (D4-CAMP-1); qualification runs the one candidate, and only the pinned one.
  const named = Array.isArray(options.candidates) && options.candidates.length > 0 ? [...options.candidates] : options.candidate === undefined ? null : [options.candidate];
  const candidates = stage === 'qualify' ? [options.candidate ?? pinnedId] : named ?? Object.keys(MODELS);
  if (stage !== 'rehearse') {
    if (STAGE_OF[stage] === undefined) return { stage, ok: false, refusals: [{ code: 'UNKNOWN_STAGE', detail: String(stage) }], outDir: null, summary: null };
    if (options.location !== undefined && options.location !== 'us') refuse('LOCATION_NOT_US', `${String(options.location)}: the campaign is pinned to the US geography inference profile`);
    if (stage === 'qualify' && named !== null && named.length > 1) refuse('ONE_CANDIDATE_PER_QUALIFICATION_RUN', named.join(','));
    for (const candidate of candidates) {
      if (MODELS[candidate] === undefined) refuse('UNKNOWN_CANDIDATE', String(candidate));
      else if (stage === 'qualify' && MODELS[candidate] !== MODEL_POLICY_V1.primaryModel) refuse('CANDIDATE_NOT_THE_PINNED_POLICY', `${candidate} is not the model the pinned policy names (${MODEL_POLICY_V1.primaryModel}); qualification runs the selected candidate under the pinned policy, which only the release that follows the selection changes`);
    }
  }
  // A rehearsal over a stand-in seam skips the AWS reads (no account is behind a seam); it is SIMULATED by construction and never without a seam.
  const simulated = options.simulatedPreflight === true;
  if (simulated && (options.seamModule === undefined || options.seamModule === null)) refuse('SIMULATED_PREFLIGHT_NEEDS_SEAM', 'the AWS reads are skipped only over a stand-in seam, never against the provider');
  let grant = null;
  const loggingReadBacks = {};
  const probeRecords = {};
  const region = options.region ?? 'us-east-1';
  const latchPath = resolve(options.latchPath ?? DEFAULT_LATCH_PATH);
  if (stage !== 'rehearse') {
    const credentialProvider = options.credentialProvider ?? awsCredentialProvider({ ...(options.awsProfile === undefined ? {} : { profile: options.awsProfile }) });
    for (const candidate of candidates.filter((id) => MODELS[id] !== undefined)) {
      const checked = await preflight({ stage, region, candidate, awsAccountId: options.awsAccountId, simulated, grantPath: options.grantPath ?? null, latchPath, validityPath: options.validityPath ?? join(repo, 'corpus', 'scorer-validity.json'), corpusDir: options.corpusDir ?? 'corpus', credentialProvider, retentionEvidencePath: options.retentionEvidencePath, ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }), ...(options.now === undefined ? {} : { now: options.now }) });
      for (const one of checked.refusals) refuse(one.code, one.detail);
      grant = checked.grant;
      loggingReadBacks[candidate] = checked.loggingReadBack;
      probeRecords[candidate] = checked.probes;
    }
  }
  let perFixtureMicros;
  if (stage === 'qualify') {
    if (![1, 2, 3].includes(options.runNo)) refuse('RUN_NOT_1_2_3', 'a qualification run is numbered 1, 2 or 3');
    // Over a stand-in seam there is no pilot measurement to follow: the cost per fixture is the stage's own estimate unless the rehearsal names one.
    if (simulated) perFixtureMicros = options.perFixtureMicros;
    else {
      const pilot = options.pilotSummaryPath === undefined ? null : (() => { try { return JSON.parse(readFileSync(options.pilotSummaryPath, 'utf8')); } catch { return null; } })();
      const candidate = candidates[0];
      perFixtureMicros = pilot?.candidates?.[candidate]?.measured?.perFixtureMicros;
      if (pilot?.stage !== 'pilot' || pilot?.evidence !== 'EXECUTED_PROVIDER') refuse('NO_PILOT_MEASUREMENT', 'a qualification run follows the pilot\'s selection (--pilot-summary of an EXECUTED_PROVIDER pilot)');
      else if (pilot?.selection?.selected !== candidate) refuse('CANDIDATE_NOT_SELECTED', `the pilot selected ${String(pilot?.selection?.selected ?? 'no candidate')}, not ${String(candidate)}: qualification runs only the selected candidate`);
      else if (!(Number.isSafeInteger(perFixtureMicros) && perFixtureMicros > 0)) refuse('NO_PILOT_MEASUREMENT', 'a qualification run is projected from the pilot\'s measured cost per fixture of the selected candidate');
    }
  }
  if (refusals.length > 0) return { stage, ok: false, refusals, outDir: null, summary: null };

  const corpusDir = resolve(repo, options.corpusDir ?? 'corpus');
  const outRoot = resolve(options.outRoot ?? join(repo, 'campaign', 'out'));
  const campaignRunId = `${stage}${stage === 'qualify' ? `-run${String(options.runNo)}` : ''}-${stamp()}-${randomBytes(3).toString('hex')}`;
  const outDir = join(outRoot, stage, campaignRunId);
  mkdirSync(outDir, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'kauro-ic-campaign-'));
  try {
    const installed = packAndInstall({ work });
    // Validity v4 (S044): a funded stage reruns scorer validity inside this clean install and refuses VALIDITY_STALE on any difference.
    // A rehearsal over a stand-in seam is not funded and is not rerun; a test may inject the rerun (validityRerun), and preflight.json says which ran.
    let validityRerun = null;
    if (stage !== 'rehearse' && !simulated) {
      const validityPath = options.validityPath ?? join(repo, 'corpus', 'scorer-validity.json');
      const record = (() => { try { return JSON.parse(readFileSync(validityPath, 'utf8')); } catch { return null; } })();
      const rerun = (options.validityRerun ?? rerunValidity)({ record, corpusDir, icTarball: installed.tarball, project: installed.project, outPath: join(outDir, 'validity-rerun.json') });
      validityRerun = { by: options.validityRerun === undefined ? 'scorer-validity.mjs in the clean install' : 'INJECTED_TEST_STAND_IN', stale: rerun.stale, binding: rerun.binding, freshRecordDigest: rerun.fresh?.recordDigest ?? null, refusals: rerun.refusals };
      if (rerun.refusals.length > 0) {
        writeFileSync(join(outDir, 'preflight.json'), `${JSON.stringify({ region, probes: probeRecords, loggingReadBacks, validityRerun }, null, 2)}\n`);
        return { stage, ok: false, refusals: rerun.refusals, outDir, summary: null };
      }
    }
    const scorerDigest = (await import(pathToFileURL(join(repo, 'tools', 'campaign', 'validity-run.mjs')).href)).currentScorerDigest();
    const config = {
      mode: stage === 'rehearse' ? 'rehearse' : 'live', stage, campaignRunId, corpusDir, outDir, limit: options.limit ?? null, candidates: stage === 'rehearse' ? [pinnedId] : candidates, region, location: 'us',
      awsProfile: options.awsProfile, grant, priorScoreJournals: stage === 'rehearse' ? [] : priorScoreJournals(outRoot, outDir), ledgerPath: stage === 'rehearse' ? null : ledgerPathOf(options.grantPath), latchPath, loggingReadBacks, runNo: options.runNo, perFixtureMicros, icPackageDigest: installed.packageDigest, icTarballSha256: installed.tarballSha256, scorerDigest,
      seamModule: options.seamModule ?? null, seamOptions: options.seamOptions ?? {}, rehearsal: options.rehearsalShape === undefined ? null : { shape: options.rehearsalShape }, expectedVersion: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version,
    };
    if (stage !== 'rehearse') writeFileSync(join(outDir, 'preflight.json'), `${JSON.stringify({ region, probes: probeRecords, loggingReadBacks, validityRerun }, null, 2)}\n`);
    const configPath = join(work, 'stage-config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const ran = spawnSync(process.execPath, [join('tools', 'campaign', 'stage-child.mjs'), configPath], { cwd: installed.project, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    if (ran.status !== 0) {
      // A stage that refused itself (ledger locked or of another grant, corpus latched, run not fundable) says why in refusal.json.
      const refusal = existsSync(join(outDir, 'refusal.json')) ? JSON.parse(readFileSync(join(outDir, 'refusal.json'), 'utf8')) : null;
      return { stage, ok: false, refusals: [refusal ?? { code: 'STAGE_FAILED', detail: `the stage exited ${String(ran.status)}` }], outDir, summary: null };
    }
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    return { stage, ok: summary.complete !== false, refusals: [], outDir, summary };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const run = option('--run');
  const limit = option('--limit');
  const result = await runCampaign({
    stage: option('--stage'), region: option('--region'), location: option('--location'), awsAccountId: option('--aws-account'), awsProfile: option('--aws-profile'), retentionEvidencePath: option('--retention-evidence'),
    grantPath: option('--grant') ?? null, validityPath: option('--validity'), corpusDir: option('--corpus'),
    outRoot: option('--out'), candidate: option('--candidate'), seamModule: option('--stage') === 'rehearse' ? option('--seam') : undefined, shape: option('--shape'), seamOptions: option('--kill-at-fixture') === undefined ? undefined : { killAtFixture: Number(option('--kill-at-fixture')) }, runNo: run === undefined ? undefined : Number(run), pilotSummaryPath: option('--pilot-summary'),
    limit: limit === undefined ? undefined : Number(limit),
  });
  if (result.refusals.length > 0) {
    for (const refusal of result.refusals) process.stderr.write(`REFUSED ${refusal.code}: ${refusal.detail}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ stage: result.stage, ok: result.ok, outDir: result.outDir, summary: result.summary }, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
