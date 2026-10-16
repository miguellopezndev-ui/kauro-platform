#!/usr/bin/env node
// One campaign stage, executed from the CLEAN directory the runner installed the packed tarball into (B04-CAMPAIGN, D4-CAMP-5).
// Layout there: node_modules/kauro-intelligence-core (the tarball's bytes), node_modules/kauro-migration-core (the vendored release),
// and a copy of tools/campaign and tools/corpus/bind.mjs. Nothing points back at the repository and nothing links into the package.
// The package is imported by name only: its public index (surface checked below) and its declared entry `kauro-intelligence-core/benchmark`. Modes:
//   rehearse  the recorded SIMULATED transport (the truth-following answers, every exchange recorded as a receipt), three runs,
//             no grant, no network; the reports are TEST_ONLY and are never labelled QUALIFICATION evidence.
//   live      the Bedrock gateway (owner decision A9) over temporary AWS credentials, under the campaign admission (grant, stop
//             rule); EXECUTED_PROVIDER. Over the test seam (a stand-in endpoint) the same path is SIMULATED and never live evidence
//             (Codex B04-R8); a seam that offers only a Vertex token is the retired wire, SIMULATED only.
// Every fixture score is appended to <out>/scores.jsonl and fsync'd before the next dispatch, and before its STOP; a restart
// reads the earlier invocations' scores.jsonl and rebuilds a STOP the ledger lacks before any new hold (G50). The pilot measures
// Sonnet 5.5 first, so an Opus stop can never block the only B-funded candidate's measurement (G51, D4-CAMP-11).
// The admission loads the grant's durable ledger (grant-ledger.mjs, D4-CAMP-6): the cap is spent once across invocations. Every
// physical request is scanned before it is sent (contamination.mjs, D4-CAMP-7). The pilot runs the sealed PILOT partition and
// qualification the FINAL one (selection.mjs).
// Input: one JSON config file. Output: files under config.outDir, and one summary line on stdout. A refused stage writes
// refusal.json ({ code, detail }) in config.outDir and exits 5.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { CampaignAdmission, HARD_GATES, MODEL_POLICY_V1, VirtualClock, MemoryDispatchAdmission, OPUS_5_5_US, SONNET_5_5_US, SystemClock, admitCandidate, alwaysAbstainAnswer, candidatePolicyOf, createContaminationGuard, digestOf, benchmarkReport, bindRun, observeEgress, projectedRunMicros, selectFromPilot, qualifyThreeRuns, requestReceipt, responseReceipt, scoreFixture, sealedObject, tariffForProfile, truthFollowingAnswer, verifyCorpus, vertexGateway, bedrockGateway } from 'kauro-intelligence-core/benchmark';
import { pathToFileURL } from 'node:url';
import { awsCredentialProvider } from './aws-credentials.mjs';
import { fundedContaminationGuard, latchedCorpus } from './contamination.mjs';
import { openGrantLedger } from './grant-ledger.mjs';
import { selectionOf } from './selection.mjs';
import { campaignEnvelopes, requestBytesOfFixtures } from './envelope-lib.mjs';
import { loadCorpus, materialise, runThroughCore, runThroughPublicCore } from './validity-run.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// The test seam of the funded path: a module that stands in for the provider endpoint and the credential. The command line sets it only with --stage rehearse (the chaos rehearsal, SIMULATED).
const seam = config.seamModule === undefined || config.seamModule === null ? null : (await import(pathToFileURL(config.seamModule).href)).default({ alwaysAbstainAnswer, parseProviderRequestPayload: (await import('kauro-intelligence-core')).parseProviderRequestPayload, outDir: config.outDir, VirtualClock, options: config.seamOptions ?? {} });
/** D4-CHAOS-1: the stop rule. A stage stops durably only on a registered hard gate (HARD_GATES, the one shared list); any other violation on a score (budget_ceiling_exceeded) is reported and makes the fixture incorrect, never a STOP. */
const stopsTheStage = (violations) => Array.isArray(violations) && violations.some((violation) => HARD_GATES.includes(violation));
const progress = (text) => process.stderr.write(`${text}\n`);
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const light = (receipt) => (receipt.kind === 'REQUEST' ? { ...receipt, bodyBytes: '' } : { ...receipt, bodyText: '' });
/** What a live-mode run is: a provider run, or a run over the stand-in endpoint of the test seam (never live evidence). */
const LIVE_EVIDENCE = seam === null ? 'EXECUTED_PROVIDER' : 'SIMULATED';
let openLedger = null;
/** A refused stage: the ledger lock is released, the refusal is written for the runner, and the stage exits 5. */
function refuseStage(code, detail) {
  openLedger?.close();
  mkdirSync(config.outDir, { recursive: true });
  write(join(config.outDir, 'refusal.json'), { code, detail });
  process.stderr.write(`stage refused ${code}: ${detail}\n`);
  process.exit(5);
}

// The packed package, through its public index only.
const bare = await import('kauro-intelligence-core');
const matrix = bare.compatibilityMatrix();
const importedPublicIndex = typeof bare.createIntelligenceCore === 'function' && typeof bare.parseProviderRequestPayload === 'function' && matrix.intelligenceCoreVersion === config.expectedVersion;

const corpus = loadCorpus(config.corpusDir);
const sealProblems = verifyCorpus(corpus.manifest, corpus.fixtures);
if (sealProblems.length > 0) { process.stderr.write(`the corpus is not what its manifest sealed: ${sealProblems.slice(0, 5).join('; ')}\n`); process.exit(2); }
const limit = config.limit ?? null;
// The sealed partitions decide (Codex B04-R7): the pilot is the 60 PILOT fixtures, qualification the 600 FINAL ones.
let chosen = (() => { try { return selectionOf(corpus.fixtures, config.stage, limit); } catch (error) { return refuseStage('PARTITION_NOT_SEALED', error instanceof Error ? error.message : String(error)); } })();
const fullSelection = chosen;
const declaredObjectOf = (entry) => (entry.structure.project !== undefined ? entry.structure.project.object : entry.fixture.expectedTaskTypes.includes('OBJECT_MAPPING') ? null : sealedObject(entry.fixture));

const subjectOf = (profile, scorerDigest) => ({
  servedModel: profile.modelId, location: profile.location, modelPolicyHash: digestOf(candidatePolicyOf(profile)), promptBundleHash: bare.PROMPT_BUNDLE_HASH,
  compilerContractVersion: matrix.compilerContractVersion, migrationCoreVersion: matrix.vendoredMigrationCore.coreVersion,
  icPackageDigest: config.icPackageDigest, scorerDigest, corpusDigest: corpus.manifest.corpusDigest,
});

const stats = (scores) => ({
  fixtures: scores.length, correct: scores.filter((score) => score.correct === true).length,
  hardGateViolations: scores.reduce((sum, score) => sum + score.hardGateViolations.length, 0), scorerFailures: scores.filter((score) => score.scorerFailure !== null).length,
});

/** One finished run's files: scores, receipts (already appended), the report in its mode, the bound run record. */
function finishRun(dir, { runNo, campaignRunId, evidence, mode, profile, scores, lightReceipts, offline, extra }) {
  const report = benchmarkReport(chosen.map((entry) => entry.fixture), scores, campaignRunId, mode);
  // offline: the runs the core decided without sending a request (D4-CAMP-8); every other run is backed by its own exchanges.
  const record = bindRun(report, { subject: subjectOf(profile, config.scorerDigest), evidence, receipts: lightReceipts, offline, runFixtures: scores.filter((score) => score.runId !== null).map((score) => ({ runId: score.runId, fixtureId: score.fixtureId })) });
  write(join(dir, 'scores.json'), scores);
  write(join(dir, 'report.json'), report);
  write(join(dir, 'run-record.json'), record);
  write(join(dir, 'selection.json'), chosen);
  write(join(dir, 'run.json'), { runNo, campaignRunId, stage: config.stage, evidence, reportMode: mode, candidate: profile.profileId, fixtures: chosen.length, ...extra });
  return { report, record };
}

async function rehearse() {
  const profile = profileOf(config.candidates[0]);
  const runs = [1, 2, 3];
  const dirs = runs.map((n) => { const dir = join(config.outDir, `run-${String(n)}`); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'receipts.jsonl'), ''); return dir; });
  const scoresOf = runs.map(() => []);
  const lightOf = runs.map(() => []);
  const offlineOf = runs.map(() => []);
  const started = Date.now();
  const scan = createContaminationGuard(corpus.manifest);
  const contamination = { scannedRequests: 0, hits: 0 };
  for (const entry of chosen) {
    const fixture = entry.fixture;
    const bundle = materialise(entry, { declaredObject: declaredObjectOf(entry) });
    try {
      for (const [slot, n] of runs.entries()) {
        const campaignRunId = `${config.campaignRunId}-run${String(n)}`;
        let seq = 0;
        const sink = (receipt) => { appendFileSync(join(dirs[slot], 'receipts.jsonl'), `${JSON.stringify(receipt)}\n`); lightOf[slot].push(light(receipt)); };
        const attempt = `${campaignRunId}-${fixture.fixtureId}`;
        const { result, observed } = await runThroughPublicCore(bundle, (envelope, identity) => truthFollowingAnswer(fixture, envelope, identity, bundle.targets), attempt, (request, bytes) => {
          seq += 1;
          contamination.scannedRequests += 1;
          if (scan.checkRequestReceipt(fixture.fixtureId, bytes).hits.length > 0) contamination.hits += 1;
          const runId = bare.parseProviderRequestPayload(bytes).runId;
          const idempotencyRef = `${attempt}:${String(seq)}`;
          sink(requestReceipt({ url: 'recorded://rehearsal/simulated-transport', headers: { 'content-type': 'application/json' }, bodyBytes: bytes, idempotencyRef, runId }));
          sink(responseReceipt({ status: 200, headers: {}, bodyText: JSON.stringify({ id: `rehearsal-${campaignRunId}-${fixture.fixtureId}-${String(seq)}`, model: profile.modelId, stop_reason: 'end_turn', usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: 0 } }), bodyLength: 0, truncated: false, latencyMs: 0, idempotencyRef, runId }));
        });
        const score = scoreFixture(fixture, result, observed);
        scoresOf[slot].push(score);
        if (seq === 0 && score.runId !== null) offlineOf[slot].push({ runId: score.runId, fixtureId: fixture.fixtureId });
      }
    } finally {
      bundle.dispose();
      if (scoresOf[0].length % 50 === 0 || scoresOf[0].length === chosen.length) progress(`  ${String(scoresOf[0].length)}/${String(chosen.length)} fixtures x3 (${String(Math.round((Date.now() - started) / 1000))}s)`);
    }
  }
  const finished = runs.map((n, slot) => {
    const campaignRunId = `${config.campaignRunId}-run${String(n)}`;
    const scores = scoresOf[slot];
    return finishRun(dirs[slot], { runNo: n, campaignRunId, evidence: 'SIMULATED', mode: 'TEST_ONLY', profile, scores, lightReceipts: lightOf[slot], offline: offlineOf[slot], extra: { note: 'recorded SIMULATED transport; never qualification evidence' } });
  });
  const qualification = qualifyThreeRuns(finished.map((one) => one.record), lightOf);
  return {
    evidence: 'SIMULATED', fixtures: chosen.length,
    runs: finished.map((one, slot) => ({ evidence: one.record.evidence, reportMode: one.report.mode, ...stats(scoresOf[slot]), passing: one.report.passing, receipts: lightOf[slot].length })),
    qualification: { qualified: qualification.qualified, reasons: qualification.reasons }, labelledQualification: finished.some((one) => one.report.mode === 'QUALIFICATION'), contamination,
  };
}

const profileOf = (id) => (id === 'OPUS_5_5_US' ? OPUS_5_5_US : SONNET_5_5_US);

/** One fixture score, appended and fsync'd before the next dispatch (G50): what a restart reads when the ledger has no STOP for it. */
function appendScore(line) {
  const fd = openSync(join(config.outDir, 'scores.jsonl'), 'a');
  try { writeSync(fd, `${JSON.stringify(line)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * G50: the earlier invocations' scores.jsonl of this grant. A violation there that the ledger never stopped for (the process died
 * between the fsync of the score and the STOP) is the STOP the restart owes; a torn or unreadable journal proves nothing either way
 * and refuses the stage until the owner reads it. Returns the journal that holds the violation, or null.
 */
function pendingStopIn(paths) {
  for (const path of paths ?? []) {
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { refuseStage('SCORES_JOURNAL_UNREADABLE', `${path} cannot be read; a violation it may hold is unknown`); }
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') refuseStage('SCORES_JOURNAL_TORN', `${path} ends inside a line: a crash cut a score; read it before the grant is spent again`);
    for (const raw of lines.slice(0, -1)) {
      let line;
      try { line = JSON.parse(raw); } catch { refuseStage('SCORES_JOURNAL_TORN', `${path} holds a line that is not JSON`); }
      if (line?.grantId === config.grant.grantId && stopsTheStage(line.hardGateViolations)) return path;
    }
  }
  return null;
}
const median = (numbers) => { if (numbers.length === 0) return 0; const sorted = [...numbers].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };

/**
 * One candidate under the shared admission (D4-CAMP-1). The grant, the stop rule and the request budget are the same for every
 * candidate; the receipts, the gateway (and so the served-model subject) and the reports are the candidate's own.
 * @returns the candidate's summary, with `comparison` holding what the pilot's selection reads.
 */
async function liveCandidate(id, admission, contamination, { dir, passes, nested }) {
  const base = profileOf(id);
  const readBack = config.loggingReadBacks[id];
  const profile = { ...base, eligibility: { evidenceClass: LIVE_EVIDENCE, termsAccepted: true, requestResponseLogging: readBack.requestResponseLogging, promptCacheSent: false, batch: false, tools: false, fallback: false } };
  const admitted = admitCandidate(profile);
  if (!admitted.admitted) {
    if (!nested) refuseStage('CANDIDATE_REFUSED', admitted.reason);
    return { evidence: LIVE_EVIDENCE, stage: config.stage, candidate: id, complete: false, stopped: null, ineligible: admitted.reason, fixtures: 0, selected: 0, measured: null, run: null, refusals: 0, subjectBroken: [], comparison: { admitted: false, complete: false, stopped: null, hardGateViolations: 0, scorerFailures: 0, supportedPass: false, abstentionPass: false, accepted: 0, chargedMicros: 0, p50LatencyMs: 0 } };
  }
  chosen = fullSelection;
  const tariff = tariffForProfile(profile, Math.ceil(500 * profile.inputMicroUsdPerToken));
  const candidatePolicy = candidatePolicyOf(profile);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'receipts.jsonl'), '');
  const lightReceipts = [];
  let bodies = [];
  let currentFixture = null;
  const common = {
    profile, sink: (receipt) => { appendFileSync(join(dir, 'receipts.jsonl'), `${JSON.stringify(receipt)}\n`); lightReceipts.push(light(receipt)); }, evidenceClass: LIVE_EVIDENCE,
    // Every physical request, its exact bytes, before the credentials, the receipt and the fetch (D4-CAMP-7).
    beforeSend: (bytes) => { contamination.beforeSend(currentFixture ?? 'NO_FIXTURE', bytes); },
    wrapTransport: (inner) => async (request, deadlineAt, correlation) => { bodies.push(JSON.stringify(request)); return inner(request, deadlineAt, correlation); },
  };
  // Amazon Bedrock (A9). Only a stand-in seam that offers a Vertex token alone runs the retired wire, and it is SIMULATED (LIVE_EVIDENCE).
  const gateway = seam !== null && seam.credentialProvider === undefined && seam.tokenProvider !== undefined
    ? vertexGateway({ ...common, project: config.project ?? 'kauro-sim-project', tokenProvider: seam.tokenProvider, fetchImpl: seam.fetch })
    : bedrockGateway({ ...common, region: config.region ?? 'us-east-1', credentialProvider: seam === null ? awsCredentialProvider({ ...(config.awsProfile === undefined || config.awsProfile === null ? {} : { profile: config.awsProfile }) }) : seam.credentialProvider, fetchImpl: seam === null ? globalThis.fetch : seam.fetch, ...(seam?.now === undefined ? {} : { now: seam.now }) });
  const planned = config.perFixtureMicros ?? Math.ceil((await (async () => {
    const bytes = await requestBytesOfFixtures(chosen, { truthFollowingAnswer, sealedObject });
    const envelopes = campaignEnvelopes(bytes, [profile]);
    return envelopes.candidates[profile.profileId].perFixtureMicros;
  })()));
  const before = admission.balance();
  const allScores = [];
  const passRuns = [];
  let stopped = null;
  let capReached = false;
  let requestsBudget = config.stage === 'smoke' ? 40 : Number.POSITIVE_INFINITY;
  for (let pass = 1; pass <= passes && stopped === null; pass += 1) {
    chosen = fullSelection;
    const campaignRunId = nested ? `${config.campaignRunId}-${id}${passes > 1 ? `-p${String(pass)}` : ''}` : config.campaignRunId;
    const passDir = passes > 1 ? join(dir, `pass-${String(pass)}`) : dir;
    mkdirSync(passDir, { recursive: true });
    const start = admission.beginRun({ runId: campaignRunId, candidate: id, runNo: config.runNo ?? null, fixtures: chosen.length, perFixtureMicros: planned });
    if (!start.started) {
      if (!nested) refuseStage('RUN_NOT_STARTED', `the run does not start: ${String(start.reason)} (projected ${String(projectedRunMicros(planned, chosen.length))} micros, ${String(admission.balance().remainingMicros)} left on the grant)`);
      stopped = `RUN_NOT_STARTED:${String(start.reason)}`;
      break;
    }
    // A seam may inject the clock and the sleep (the chaos rehearsal: no wall time passes); the provider path never does.
    const clock = seam?.clock ?? new SystemClock();
    const scores = [];
    const offline = [];
    for (const entry of chosen) {
      if (admission.halted() !== null) { stopped = admission.halted(); break; }
      if (requestsBudget < 7) { capReached = true; break; }
      const fixture = entry.fixture;
      currentFixture = fixture.fixtureId;
      const bundle = materialise(entry, { declaredObject: declaredObjectOf(entry) });
      bodies = [];
      seam?.beforeFixture?.({ candidate: id, pass, fixtureId: fixture.fixtureId, index: scores.length });
      const beforeReceipts = lightReceipts.length;
      try {
        const result = await runThroughCore(bundle, { gateway, dispatchAdmission: admission, tariff, clock, candidatePolicy, sleep: seam?.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))), attempt: `${campaignRunId}-${fixture.fixtureId}` });
        const scored = scoreFixture(fixture, result, observeEgress(result.runId, bodies));
        // The stand-in's own judgement (test seam only; never on the provider path, whose runs are EXECUTED_PROVIDER).
        const score = seam !== null && typeof seam.scoreOverride === 'function' ? seam.scoreOverride(scored, { candidate: id, pass, fixtureId: fixture.fixtureId }) : scored;
        scores.push(score);
        appendScore({ grantId: config.grant.grantId, campaignRunId, stage: config.stage, candidate: id, pass, fixtureId: fixture.fixtureId, runId: score.runId, correct: score.correct, hardGateViolations: score.hardGateViolations, scorerFailure: score.scorerFailure });
        seam?.afterScore?.({ candidate: id, pass, fixtureId: fixture.fixtureId, scoreCount: scores.length, score });
        if (bodies.length === 0 && score.runId !== null) offline.push({ runId: score.runId, fixtureId: fixture.fixtureId });
        const own = lightReceipts.slice(beforeReceipts);
        requestsBudget -= own.filter((receipt) => receipt.kind === 'REQUEST').length;
        if (stopsTheStage(score.hardGateViolations)) admission.stopFor('HARD_GATE_VIOLATION');
        if (gateway.subject.broken) admission.stopFor('SERVED_MODEL_CHANGE');
        if (scores.length % 50 === 0 && admission.checkpoint(scores.length) === 'STOP') { stopped = admission.halted(); break; }
      } finally { bundle.dispose(); }
      progress(`  ${id} pass ${String(pass)}: ${String(scores.length)}/${String(chosen.length)} fixtures, charged ${String(admission.balance().chargedMicros)} held ${String(admission.balance().heldMicros)} micros`);
    }
    admission.endRun(campaignRunId);
    allScores.push(...scores);
    // The smoke ends at its request cap, not at the end of the selection: what ran is the smoke.
    if (capReached && stopped === null) chosen = chosen.slice(0, scores.length);
    const complete = stopped === null && scores.length === chosen.length;
    const mode = config.stage === 'qualify' ? 'QUALIFICATION' : 'TEST_ONLY';
    if (complete) {
      const measuredSoFar = { grantId: config.grant.grantId };
      const finished = finishRun(passDir, { runNo: config.runNo ?? pass, campaignRunId, evidence: LIVE_EVIDENCE, mode, profile, scores, lightReceipts, offline, extra: { ...measuredSoFar, loggingReadBack: readBack } });
      passRuns.push({ complete: true, report: finished.report, stats: { ...stats(scores), passing: finished.report.passing, reportDigest: finished.report.reportDigest, runDigest: finished.record.runDigest } });
    } else {
      write(join(passDir, 'selection.json'), chosen);
      write(join(passDir, 'scores.json'), scores);
      write(join(passDir, 'run.json'), { runNo: config.runNo ?? pass, campaignRunId, stage: config.stage, evidence: LIVE_EVIDENCE, candidate: profile.profileId, complete: false, stopped, grantId: config.grant.grantId, loggingReadBack: readBack });
      passRuns.push({ complete: false, report: null, stats: null });
    }
  }
  const balance = admission.balance();
  const charged = balance.chargedMicros - before.chargedMicros;
  const complete = stopped === null && passRuns.length === passes && passRuns.every((run) => run.complete);
  const responses = lightReceipts.filter((receipt) => receipt.kind === 'RESPONSE');
  const served = [...new Set(responses.filter((receipt) => receipt.status === 200).map((receipt) => receipt.servedModel ?? 'UNREPORTED'))];
  const usage = responses.filter((receipt) => typeof receipt.usage === 'object' && receipt.usage !== null).reduce((sum, receipt) => ({ inputTokens: sum.inputTokens + receipt.usage.inputTokens, outputTokens: sum.outputTokens + receipt.usage.outputTokens }), { inputTokens: 0, outputTokens: 0 });
  const requests = lightReceipts.filter((receipt) => receipt.kind === 'REQUEST');
  const bytes = requests.reduce((sum, receipt) => sum + receipt.bodyLength, 0);
  const measured = { requests: requests.length, requestBytes: bytes, ...usage, servedModels: served, chargedMicros: charged, heldMicros: balance.heldMicros, liabilityMicros: balance.liabilityMicros, perFixtureMicros: allScores.length === 0 ? 0 : Math.ceil(charged / allScores.length), inputTokensPerByte: bytes === 0 ? null : usage.inputTokens / bytes };
  const comparison = {
    admitted: true, complete, stopped, hardGateViolations: allScores.reduce((sum, score) => sum + score.hardGateViolations.length, 0), scorerFailures: allScores.filter((score) => score.scorerFailure !== null).length,
    supportedPass: complete && passRuns.every((run) => run.report.qualityGates.supportedPass === true), abstentionPass: complete && passRuns.every((run) => run.report.qualityGates.abstentionPass === true),
    accepted: allScores.filter((score) => score.correct === true).length, chargedMicros: charged, p50LatencyMs: median(responses.filter((receipt) => receipt.status === 200).map((receipt) => receipt.latencyMs)),
  };
  const done = passRuns.filter((run) => run.complete).map((run) => run.stats);
  return { evidence: LIVE_EVIDENCE, stage: config.stage, candidate: id, complete, stopped, fixtures: allScores.length, selected: chosen.length, plannedPerFixtureMicros: planned, stageFixtures: selectionOf(corpus.fixtures, config.stage, null).length, measured, run: done.length === 0 ? null : done[done.length - 1], ...(passes > 1 ? { runs: done } : {}), refusals: admission.refusals.length, subjectBroken: gateway.subject.causes, comparison };
}

async function live() {
  const stage = { smoke: 'SMOKE', pilot: 'PILOT', qualify: 'QUALIFICATION' }[config.stage];
  // A contaminated corpus is not funded again until it is resealed (its digest changes).
  const latch = latchedCorpus(config.latchPath, corpus.manifest.corpusDigest);
  if (latch !== null) refuseStage(latch.code, latch.detail);
  // The grant's durable ledger, exclusively locked for this invocation: what earlier invocations charged, held and stopped stands.
  try { openLedger = openGrantLedger(config.ledgerPath, config.grant); } catch (error) { refuseStage(error.code ?? 'GRANT_LEDGER_REFUSED', error instanceof Error ? error.message : String(error)); }
  try { return await liveUnderLedger(stage, openLedger); } finally { openLedger.close(); }
}

async function liveUnderLedger(stage, journal) {
  const admission = new CampaignAdmission({ grant: config.grant, stage, inner: new MemoryDispatchAdmission({ fundedMicros: config.grant.capMicros }), now: Date.now, journal });
  const contamination = fundedContaminationGuard({ manifest: corpus.manifest, latchPath: config.latchPath, onHit: (reason) => { admission.stopFor(reason); } });
  const scanned = () => ({ scannedRequests: contamination.scanned, hits: contamination.hits });
  // G50: a violation an earlier invocation scored and never stopped for is stopped now, before any hold of this one.
  const pending = admission.halted() === null ? pendingStopIn(config.priorScoreJournals) : null;
  if (pending !== null) {
    admission.stopFor('HARD_GATE_VIOLATION');
    refuseStage('GRANT_STOPPED', `HARD_GATE_VIOLATION rebuilt from ${pending} (scores.jsonl): the earlier invocation scored it and died before its STOP reached the ledger`);
  }
  // G51: the pilot measures Sonnet 5.5 first, whatever order the candidates were named in.
  const ids = config.stage === 'pilot' ? [...config.candidates].sort((a, b) => (a === SONNET_5_5_US.profileId ? -1 : b === SONNET_5_5_US.profileId ? 1 : 0)) : config.candidates;
  // The pilot always writes a directory per candidate and the selection; so does any stage that runs more than one candidate. Qualification and a single-candidate smoke keep the flat layout.
  const nested = ids.length > 1 || config.stage === 'pilot';
  const passes = config.stage === 'pilot' ? 2 : 1;
  const results = {};
  for (const id of ids) {
    const halted = admission.halted();
    if (halted !== null) {
      results[id] = { evidence: LIVE_EVIDENCE, stage: config.stage, candidate: id, complete: false, stopped: halted, notRun: true, fixtures: 0, selected: 0, measured: null, run: null, refusals: 0, subjectBroken: [], comparison: { admitted: true, complete: false, stopped: halted, hardGateViolations: 0, scorerFailures: 0, supportedPass: false, abstentionPass: false, accepted: 0, chargedMicros: 0, p50LatencyMs: 0 } };
      continue;
    }
    results[id] = await liveCandidate(id, admission, contamination, { dir: nested ? join(config.outDir, id) : config.outDir, passes, nested });
  }
  const balance = admission.balance();
  const grantTotals = { grantChargedMicros: balance.chargedMicros, grantHeldMicros: balance.heldMicros, grantLiabilityMicros: balance.liabilityMicros };
  if (!nested) { const { comparison: _comparison, ...single } = results[ids[0]]; return { ...single, ...grantTotals, contamination: scanned() }; }
  const selection = config.stage === 'pilot'
    ? selectFromPilot(ids.map((id) => ({ profileId: id, modelId: profileOf(id).modelId, ...results[id].comparison })), MODEL_POLICY_V1.primaryModel)
    : null;
  if (selection !== null) write(join(config.outDir, 'selection.json'), selection);
  return { evidence: LIVE_EVIDENCE, stage: config.stage, complete: ids.every((id) => results[id].complete), stopped: admission.halted(), candidates: results, selection, ...grantTotals, contamination: scanned() };
}

/**
 * A rehearsal over a stand-in seam (the chaos layer) says what it is in its own summary: SIMULATED, never qualification, what the
 * seam did, and the arithmetic of the grant for the FULL stage (the run itself may have been limited), so it is read for what it proves.
 */
function rehearsalBlock(summaryOfLive) {
  const ran = summaryOfLive.candidates === undefined ? [summaryOfLive] : Object.values(summaryOfLive.candidates);
  const measured = ran.find((one) => typeof one.plannedPerFixtureMicros === 'number');
  const per = measured?.plannedPerFixtureMicros ?? null;
  const stageFixtures = measured?.stageFixtures ?? null;
  const projectedFullRunMicros = per === null || stageFixtures === null ? null : projectedRunMicros(per, stageFixtures);
  return {
    shape: config.rehearsal.shape, label: 'SIMULATED: a chaos rehearsal over a stand-in endpoint; no provider, no money, not qualification evidence', countsAsQualification: false,
    seam: typeof seam?.report === 'function' ? seam.report() : null,
    grantArithmetic: { capMicros: config.grant.capMicros, perFixtureMicros: per, stageFixtures, projectedFullRunMicros, fullRunsThatFitFresh: projectedFullRunMicros === null || projectedFullRunMicros === 0 ? null : Math.floor(config.grant.capMicros / projectedFullRunMicros), maxRuns: config.grant.maxRuns },
  };
}
const liveSummary = config.mode === 'live' ? await live() : null;
const summary = { ...(liveSummary ?? await rehearse()), ...(config.rehearsal === undefined || config.rehearsal === null || liveSummary === null ? {} : { rehearsal: rehearsalBlock(liveSummary) }), consumedFrom: { tarballSha256: config.icTarballSha256, packageDigest: config.icPackageDigest, importedPublicIndex, version: matrix.intelligenceCoreVersion }, campaignRunId: config.campaignRunId };
write(join(config.outDir, 'summary.json'), summary);
process.stdout.write(`${JSON.stringify(summary)}\n`);
