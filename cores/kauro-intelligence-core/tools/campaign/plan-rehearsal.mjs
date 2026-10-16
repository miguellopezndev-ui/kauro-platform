#!/usr/bin/env node
// The plan rehearsal runner (B04 design, "plan rehearsal"): the campaign's PILOT path with the plan seam (plan-seam.mjs) as the
// transport, so the pilot can be rehearsed against Sonnet 5.5 / Opus 5.5 through the owner's Claude subscription before the paid
// Bedrock account does. The output is ALWAYS SIMULATED (the stage labels every seam run so, Codex B04-R8) and never counts as
// qualification. It is PILOT-only: the 600 FINAL fixtures are never sent through the plan (the partition and any named fixture are
// checked before anything is installed or sent, and the selection that ran is checked again afterwards).
//   node tools/campaign/plan-rehearsal.mjs --candidate SONNET_5_5_US|OPUS_5_5_US [--limit N] [--out <dir>] [--concurrency N] [--timeout-ms N]
// Run `npm run build` first. The pilot path makes two passes per candidate (D4-CAMP-1): requests = 2 x fixtures x requests per fixture.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCampaign } from './run.mjs';
import { loadCorpus } from './validity-run.mjs';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CANDIDATES = Object.freeze(['SONNET_5_5_US', 'OPUS_5_5_US']);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Refusals found before anything runs; empty when the rehearsal may start. */
export function rehearsalRefusals({ candidate, partition = 'PILOT', fixtures = [], corpusDir }) {
  const refusals = [];
  if (!CANDIDATES.includes(candidate)) refusals.push({ code: 'UNKNOWN_CANDIDATE', detail: `--candidate is one of ${CANDIDATES.join(', ')}` });
  if (partition !== 'PILOT') refusals.push({ code: 'PARTITION_NOT_PILOT', detail: `the plan rehearsal runs the PILOT partition only, not ${String(partition)}: the FINAL fixtures are never sent through the plan` });
  if (fixtures.length > 0) {
    const partitionOf = new Map(loadCorpus(corpusDir).fixtures.map((entry) => [entry.fixture.fixtureId, entry.partition]));
    for (const id of fixtures) {
      if (partitionOf.get(id) !== 'PILOT') refusals.push({ code: 'FIXTURE_NOT_PILOT', detail: `${id} is ${partitionOf.get(id) ?? 'not in the corpus'}: only PILOT fixtures go through the plan` });
      else refusals.push({ code: 'FIXTURE_SELECTION_UNSUPPORTED', detail: `${id}: select pilot fixtures with --limit (the first N in the campaign's own order)` });
    }
  }
  return refusals;
}

/**
 * @param {{ candidate: string, limit?: number, out?: string, partition?: string, fixtures?: string[], corpusDir?: string, claudeCommand?: string[], concurrency?: number, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, refusals: {code: string, detail: string}[], outDir: string | null, evidence: string | null, fidelityPath: string | null, requests: number, candidates: Record<string, any>, families: Record<string, any>[] }>}
 */
export async function runPlanRehearsal(options) {
  const corpusDir = resolve(repo, options.corpusDir ?? 'corpus');
  const refusals = rehearsalRefusals({ candidate: options.candidate, partition: options.partition ?? 'PILOT', fixtures: options.fixtures ?? [], corpusDir });
  const none = { ok: false, outDir: null, evidence: null, fidelityPath: null, requests: 0, candidates: {}, families: [] };
  if (refusals.length > 0) return { ...none, refusals };
  const out = resolve(options.out ?? join(repo, 'campaign', 'plan-rehearsal', new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)));
  mkdirSync(out, { recursive: true });
  const fidelityPath = join(out, 'fidelity.json');
  // The rehearsal grant is plainly a rehearsal: notional cap, no money, funds the PILOT stage only.
  const grantPath = join(out, 'REHEARSAL-grant-no-money.json');
  writeFileSync(grantPath, `${JSON.stringify({ grantId: 'PLAN-REHEARSAL-NO-MONEY', stages: ['PILOT'], capMicros: 55_000_000, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), approvalRef: 'plan-rehearsal: simulated, notional cap, no money, not an owner grant', candidates: [options.candidate], maxRuns: null }, null, 2)}\n`);
  // The stage runs in a child process that inherits the environment: that is how the seam is configured.
  const env = { KAURO_PLAN_LOG_DIR: join(out, 'cli-logs'), KAURO_PLAN_FIDELITY: fidelityPath, ...(options.claudeCommand === undefined ? {} : { KAURO_PLAN_CLAUDE_CMD: JSON.stringify(options.claudeCommand) }), ...(options.concurrency === undefined ? {} : { KAURO_PLAN_CONCURRENCY: String(options.concurrency) }), ...(options.timeoutMs === undefined ? {} : { KAURO_PLAN_TIMEOUT_MS: String(options.timeoutMs) }) };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let result;
  try {
    result = await runCampaign({
      stage: 'pilot', project: 'plan-rehearsal', location: 'us', grantPath, corpusDir, outRoot: join(out, 'campaign'), candidate: options.candidate, limit: options.limit,
      seamModule: join(repo, 'tools', 'campaign', 'plan-seam.mjs'), latchPath: join(out, 'contamination-latch.json'),
      // The AWS reads of the preflight are not made (no account is behind the plan); the stage records a synthetic read-back and says so in the fidelity record.
      simulatedPreflight: true,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (result.outDir === null) return { ...none, refusals: [...result.refusals], outDir: out, fidelityPath };
  const stageDir = join(result.outDir, options.candidate);
  const families = [];
  const problems = [];
  let evidence = result.summary?.evidence ?? null;
  for (const pass of [1, 2]) {
    let scores;
    let selection;
    let run;
    try { scores = readJson(join(stageDir, `pass-${String(pass)}`, 'scores.json')); selection = readJson(join(stageDir, `pass-${String(pass)}`, 'selection.json')); run = readJson(join(stageDir, `pass-${String(pass)}`, 'run.json')); } catch { continue; }
    if (selection.some((entry) => entry.partition !== 'PILOT')) problems.push({ code: 'SELECTION_NOT_PILOT', detail: `pass ${String(pass)} ran a fixture outside PILOT` });
    if (run.evidence !== 'SIMULATED') { problems.push({ code: 'NOT_SIMULATED', detail: `pass ${String(pass)} is labelled ${String(run.evidence)}` }); evidence = run.evidence; }
    const byFamily = {};
    for (const score of scores) {
      const one = (byFamily[score.family] ??= { family: score.family, correct: 0, total: 0, gateViolations: [] });
      one.total += 1;
      if (score.correct === true) one.correct += 1;
      one.gateViolations.push(...score.hardGateViolations);
    }
    families.push({ pass, complete: run.complete !== false, families: Object.values(byFamily) });
  }
  writeFileSync(join(out, 'PLAN_REHEARSAL.json'), `${JSON.stringify({ evidence: 'SIMULATED', countsAsQualification: false, candidate: options.candidate, partition: 'PILOT', note: 'subscription transport (claude -p); development rehearsal only, never qualification evidence; see fidelity.json' }, null, 2)}\n`);
  const requests = result.summary?.candidates?.[options.candidate]?.measured?.requests ?? 0;
  return { ok: result.ok && problems.length === 0, refusals: [...result.refusals, ...problems], outDir: result.outDir, evidence, fidelityPath, requests, candidates: result.summary?.candidates ?? {}, families };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const number = (name) => { const v = option(name); return v === undefined ? undefined : Number(v); };
  const fixture = option('--fixture');
  const result = await runPlanRehearsal({ candidate: option('--candidate'), limit: number('--limit'), out: option('--out'), partition: option('--partition'), fixtures: fixture === undefined ? [] : [fixture], concurrency: number('--concurrency'), timeoutMs: number('--timeout-ms') });
  if (result.refusals.length > 0) for (const refusal of result.refusals) process.stderr.write(`REFUSED ${refusal.code}: ${refusal.detail}\n`);
  if (result.outDir !== null) {
    process.stdout.write(`evidence ${String(result.evidence)} (SIMULATED by construction; never qualification)\nrequests ${String(result.requests)}\nout ${result.outDir}\nfidelity ${String(result.fidelityPath)}\n`);
    for (const pass of result.families) {
      process.stdout.write(`pass ${String(pass.pass)}${pass.complete ? '' : ' (incomplete)'}:\n`);
      for (const family of pass.families) process.stdout.write(`  ${family.family}: ${String(family.correct)}/${String(family.total)} correct; gate violations: ${family.gateViolations.length === 0 ? 'none' : family.gateViolations.join(', ')}\n`);
    }
  }
  process.exit(result.refusals.length > 0 ? 2 : result.ok ? 0 : 1);
}
