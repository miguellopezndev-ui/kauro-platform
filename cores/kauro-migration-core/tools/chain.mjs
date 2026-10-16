#!/usr/bin/env node
/**
 * The final chain of MC-3, as a graph the machine walks instead of a list a
 * person remembers.
 *
 * Every node has a stable id, the real command or call it makes, the inputs
 * it reads, the outputs it writes, the nodes it depends on, a timeout, a
 * retry policy, and an oracle that says whether its outputs are right without
 * re-running it. The graph is validated before anything runs: unique ids,
 * declared dependencies, no cycles, no orphans. Nodes run in topological
 * order; a node whose dependency failed is BLOCKED and does not run — nothing
 * downstream is run on invented data to "keep looking" — and every
 * independent failure is collected into the one report at the end.
 *
 *   node tools/chain.mjs --plan
 *   node tools/chain.mjs --check                      every oracle, nothing re-run
 *   node tools/chain.mjs --run [--until <id>] [--allow-mutations]
 *   node tools/chain.mjs --rehearse [--scenario ok|gate-fails|ci-red|tag-exists|mutable|merge-405]
 *   node tools/chain.mjs --barrier                    plan + rehearsals + self-tests → READY_TO_EXECUTE_FINAL_CHAIN
 *
 * `--check` is the second, read-only walk: it verifies the same bytes the
 * producers wrote without repeating a producer. `--run` reuses a node whose
 * oracle already holds and whose recorded input fingerprint is unchanged, and
 * says so as REUSED rather than as PASS. Remote writes — merge, tag, draft,
 * publish — need `--allow-mutations` and never happen in a rehearsal, where
 * `fetch` is replaced by tools/rehearsal/fake-github.mjs and the heavy local
 * producers by stand-ins; the remote nodes themselves are the real code.
 *
 * Events go to a ledger outside the tree, one JSON line each, with the fields
 * the recovery prompt names: node, attempt, campaign, fingerprint, hashes,
 * command, start, end, status, decision. The ledger is not an input to any
 * producer.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

import { measureTree, repoRoot, versions } from './candidate-provenance.mjs';
import { measureProducers } from './producer-closure.mjs';
import { loadProfiles } from './capacity-profiles.mjs';
import { readCampaign } from '../qualification/campaign.mjs';
import { captureProblems } from './evidence-schema.mjs';
import { universeReportProblems } from './universe-inventory.mjs';
import { readWorkflow, requiredJobLegs, requiredJobIds, githubToken } from './receipt-verify.mjs';
import { github, wait as realWait } from './github-api.mjs';
import { DOSSIER_INVENTORY_VERSION, SUMS_NAME, candidateFacts, readDossierDir, readRemoteRelease, sha256, verifyLocalDossier, verifyPublishedRelease } from './release-dossier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RECOVERY_ROOT = process.env.KAURO_CHAIN_ROOT ?? resolve(repoRoot, '..', 'kauro-mc3-recovery');
const REPOSITORY = process.env.KAURO_REPOSITORY ?? 'miguellopezndev-ui/kauro-migration-core';
const rehearsing = process.argv.includes('--rehearse') || process.argv.includes('--barrier');
const BRANCH = process.env.KAURO_BRANCH ?? (rehearsing ? 'release/rehearsal' : '');
const PR_NUMBER = Number(process.env.KAURO_PR ?? (rehearsing ? '16' : ''));
const TAG = process.env.KAURO_TAG ?? `v${versions.coreVersion}`;
const AUTH_DIR = process.env.KAURO_AUTH_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.kauro-mc2-auth');
const VENDOR_FILES = ['hs-target-contract', 'hs-import', 'sf-target-contract', 'sf-dataloader', 'sf-ocr'];
const FOUNDING = ['clean-only', 'hubspot', 'salesforce'];
// Every dimension profile the manifest declares (P1-P14 at capacityProfilesVersion 1.2.1), not a count: a fixed
// length of 12 silently dropped P13 and P14.
const MATRIX_PROFILES = loadProfiles().profiles.map((profile) => profile.id).filter((id) => /^Pd+$/u.test(id));
const nowUtc = () => `${new Date().toISOString().slice(0, 19)}Z`;
const MINUTE = 60_000;

// ------------------------------------------------------------------ helpers

function exec(command, args, { cwd = repoRoot, env = {}, timeoutMs = 10 * MINUTE, log = null } = {}) {
  const shell = process.platform === 'win32' && /^(npm|npx|bash)$/u.test(command);
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: timeoutMs, shell });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (log !== null) {
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `$ ${command} ${args.join(' ')}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit ${String(result.status)} signal ${String(result.signal)} ---\n`);
  }
  const status = result.error ? (result.error.code === 'ETIMEDOUT' ? 124 : 127) : result.status ?? (result.signal ? 128 : 1);
  return { status, stdout, stderr, log, signal: result.signal ?? null, timedOut: result.error?.code === 'ETIMEDOUT' };
}

export function failureDetail(result, label) {
  const line = [result.stdout, result.stderr].flatMap((output) => (output ?? '').split('\n')).find((output) => /FALSE|FAIL|problem|Error/u.test(output));
  return `${label} exited ${String(result.status)}: ${line?.trim() ?? 'no matching diagnostic line'}; full log: ${result.log}`;
}

export function runIdentity({ prNumber = PR_NUMBER, branch = BRANCH } = {}) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('KAURO_PR is required and must be a positive PR number');
  if (typeof branch !== 'string' || branch.trim() === '') throw new Error('KAURO_BRANCH is required');
  return { prNumber, branch };
}

export async function validateRunIdentity(gh, identity = runIdentity()) {
  const { prNumber, branch } = runIdentity(identity);
  const pull = await gh.get(`/repos/${REPOSITORY}/pulls/${String(prNumber)}`);
  if (pull.head?.ref !== branch) throw new Error(`KAURO_BRANCH ${branch} does not match PR #${String(prNumber)} head.ref ${String(pull.head?.ref)}`);
  return pull;
}

export const finalWorkName = ({ branch, prNumber }) => `final-${branch.replaceAll('/', '-')}-pr${String(prNumber)}`;

const git = (args) => exec('git', args).stdout.trim();
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const fileSha = (path) => (existsSync(path) ? sha256(readFileSync(path)) : null);
const ok = (detail, extra = {}) => ({ ok: true, detail, ...extra });
const fail = (detail, extra = {}) => ({ ok: false, detail, ...extra });

// The qualified candidate survives checkout of the merge result. prHead is
// startup information only; it never authorizes a push, checks, or a merge.
function mergedCandidateProblem({ candidate, mergedHead }) {
  return mergedHead !== undefined && mergedHead !== candidate
    ? `QUALIFIED_CANDIDATE_MISMATCH: cached mergedHead ${mergedHead} differs from qualified candidate ${candidate}; refusing the merged PR`
    : null;
}

function pullIdentityProblem(ctx, pull, { beforePush = false } = {}) {
  const { prNumber, branch, candidate, pushedCandidate } = ctx.state;
  runIdentity({ prNumber, branch });
  if (!/^[0-9a-f]{40}$/u.test(String(candidate))) return 'no qualified candidate is bound';
  if (pull.number !== prNumber) return `pull number ${String(pull.number)} differs from bound PR #${String(prNumber)}`;
  if (pull.head?.ref !== branch) return `PR #${String(prNumber)} head.ref does not match bound branch ${branch}`;
  if (pull.base?.ref !== 'main') return `PR #${String(prNumber)} base is ${String(pull.base?.ref)}, expected main`;
  const cachedProblem = mergedCandidateProblem(ctx.state);
  if (cachedProblem !== null) return cachedProblem;
  if (pull.head?.sha === candidate) return null;
  // Only a not-yet-pushed candidate may advance the remote by fast-forward.
  if (beforePush && pull.merged !== true && pushedCandidate !== candidate && isAncestor(pull.head?.sha, candidate)) return null;
  return `${pull.merged === true ? 'QUALIFIED_CANDIDATE_MISMATCH' : 'CANDIDATE_HEAD_MISMATCH'}: PR #${String(prNumber)} ${pull.merged === true ? 'merged ' : ''}head is ${String(pull.head?.sha)}, expected qualified candidate ${candidate}`;
}

function qualifyRecordsHead(ctx) {
  const candidate = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/u.test(candidate)) return fail('no valid records candidate HEAD');
  if (ctx.state.mergedHead !== undefined && ctx.state.mergedHead !== candidate) {
    return fail(`QUALIFIED_CANDIDATE_MISMATCH: cached mergedHead ${ctx.state.mergedHead} differs from records candidate ${candidate}`);
  }
  if (candidate !== ctx.state.candidate) {
    ctx.state.candidate = candidate;
    ctx.state.head = candidate;
    ctx.saveState();
  }
  return ok(`records candidate ${candidate}`);
}

function isAncestor(ancestor, descendant) {
  return /^[0-9a-f]{40}$/u.test(String(ancestor)) && /^[0-9a-f]{40}$/u.test(String(descendant))
    && exec('git', ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

async function readBoundPull(ctx) {
  return ctx.gh.get(`/repos/${REPOSITORY}/pulls/${String(ctx.state.prNumber)}`);
}

// Never trust a cached SHA (or the merge PUT response) as proof of the PR's
// result. This also adopts a merge completed before state.json was saved.
async function verifyMergedCommit(ctx, pull = null, returnedSha = null) {
  pull ??= await readBoundPull(ctx);
  const problem = pullIdentityProblem(ctx, pull);
  if (problem !== null) return fail(problem);
  if (pull.merged !== true) return fail(`PR #${String(ctx.state.prNumber)} is not merged`);
  const sha = pull.merge_commit_sha;
  if (!/^[0-9a-f]{40}$/u.test(String(sha))) return fail('merged PR has no valid merge_commit_sha');
  if (ctx.state.mergedSha !== undefined && ctx.state.mergedSha !== sha) return fail(`cached mergedSha ${String(ctx.state.mergedSha)} differs from PR merge_commit_sha ${sha}`);
  if (returnedSha !== null && returnedSha !== sha) return fail(`merge response SHA ${returnedSha} differs from PR merge_commit_sha ${sha}`);
  if (ctx.state.mergedSha !== sha || ctx.state.mergedHead !== pull.head.sha) {
    ctx.state.mergedHead = pull.head.sha;
    ctx.state.mergedSha = sha;
    ctx.saveState();
  }
  return ok(`PR #${String(ctx.state.prNumber)} merge_commit_sha verified as ${sha}`, { satisfied: true });
}

function digestOfInputs(paths) {
  const measured = measureTree();
  const byPath = new Map((measured.records ?? []).map((entry) => [entry.path, entry.sha256]));
  const lines = paths.map((path) => `${path}:${byPath.get(path) ?? fileSha(join(repoRoot, ...path.split('/'))) ?? 'absent'}`);
  return sha256(lines.sort().join('\n'));
}

/**
 * The vendor credentials the preflight's instance facts ask HubSpot and
 * Salesforce with, read from the auth directory's `env` file — the same
 * contract the qualification runners document — and handed to the child's
 * environment only. Nothing here prints, logs or writes a value; the exec log
 * records the command and its arguments, never the environment.
 */
function vendorEnv() {
  const path = join(AUTH_DIR, 'env');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
    if (match === null) continue;
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  return env;
}

// -------------------------------------------------------------------- nodes
//
// Each node: id, phase, deps, mutation, timeoutMs, retries, inputs(ctx),
// run(ctx) → {ok, detail}, check(ctx) → {ok, detail}. `rehearsal` replaces run
// and check for the heavy local producers when rehearsing; a node without it
// runs its real code against the fake remote.

function vendorEvidenceCheck(ctx) {
  const campaign = readCampaign();
  if (campaign === null) return fail('no campaign is sealed');
  const problems = [];
  for (const name of VENDOR_FILES) {
    const path = join(repoRoot, 'qualification', 'evidence', `${name}.json`);
    const evidence = readJson(path);
    if (evidence === null) {
      problems.push(`${name}.json is missing`);
      continue;
    }
    if (evidence.result !== 'PASS') problems.push(`${name}.json is ${String(evidence.result)}`);
    problems.push(...captureProblems(evidence.capture, { campaignId: campaign.campaignId, producerFingerprints: ctx.producerFingerprints, now: nowUtc(), label: `${name}.json` }));
  }
  return problems.length === 0 ? ok(`5 vendor files, PASS, bound to ${campaign.campaignId}`) : fail(problems.join('; '));
}

function capacityCheck(ctx, kind) {
  const campaign = readCampaign();
  if (campaign === null) return fail('no campaign is sealed');
  const problems = [];
  const bind = (record, label) => {
    if (record === null) return problems.push(`${label} is missing`);
    problems.push(...captureProblems(record.capture, { campaignId: campaign.campaignId, producerFingerprints: ctx.producerFingerprints, now: nowUtc(), label }));
    return undefined;
  };
  if (kind === 'matrix') {
    const matrix = readJson(join(repoRoot, 'qualification', 'capacity', 'matrix.json'));
    bind(matrix, 'matrix.json');
    if (matrix !== null) {
      const rows = Array.isArray(matrix.profiles) ? matrix.profiles : Array.isArray(matrix.results) ? matrix.results : [];
      for (const id of MATRIX_PROFILES) {
        const row = rows.find((entry) => entry.profile === id);
        if (row === undefined) problems.push(`${id} is not in the matrix`);
        else if (row.result !== 'PASS') problems.push(`${id} is ${String(row.result)}: ${String(row.detail ?? '')}`);
        else if (row.declaredRows !== undefined && row.sourceRows !== undefined && row.sourceRows < row.declaredRows) problems.push(`${id} ran ${String(row.sourceRows)} rows below its declared ${String(row.declaredRows)}`);
      }
    }
    return problems.length === 0 ? ok(`matrix ${MATRIX_PROFILES[0]}–${MATRIX_PROFILES[MATRIX_PROFILES.length - 1]} PASS at declared scale, bound to ${campaign.campaignId}`) : fail(problems.join('; '));
  }
  for (const mode of FOUNDING) {
    const record = readJson(join(repoRoot, 'qualification', 'capacity', `${mode}.json`));
    bind(record, `${mode}.json`);
    if (record !== null) {
      if (record.result !== 'PASS' && record.outcome !== 'PASS') problems.push(`${mode}.json is ${String(record.result ?? record.outcome)}`);
      const reproductions = Array.isArray(record.reproductions) ? record.reproductions.length : record.reproductionCount ?? null;
      if (reproductions !== null && reproductions < 2) problems.push(`${mode}.json records ${String(reproductions)} reproduction(s)`);
    }
  }
  return problems.length === 0 ? ok(`founding ${FOUNDING.join(', ')} PASS, bound to ${campaign.campaignId}`) : fail(problems.join('; '));
}

function recordsCheck(ctx) {
  const problems = [];
  const steps = [
    ['candidate-provenance --check', ['tools/candidate-provenance.mjs', '--check']],
    ['provenance:check', ['tools/provenance.mjs', '--check']],
    ['drift-gate', ['tools/drift-gate.mjs']],
  ];
  for (const [label, args] of steps) {
    const result = exec(process.execPath, args, { timeoutMs: 5 * MINUTE, log: join(ctx.work, 'logs', `records-check-${args[0].split('/').pop()}.log`) });
    if (result.status !== 0) problems.push(failureDetail(result, label));
  }
  const dirty = git(['status', '--porcelain', '-uall']);
  if (dirty !== '') problems.push(`the tree has ${String(dirty.split('\n').length)} uncommitted path(s)`);
  return problems.length === 0 ? ok('manifest, release provenance and drift hold; tree clean') : fail(problems.join('; '));
}

function universeCheck() {
  const report = readJson(join(repoRoot, 'qualification', 'candidate', 'universe.json'));
  if (report === null) return fail('no universe report');
  const problems = universeReportProblems(report);
  const measured = measureTree();
  if (report.candidate?.codeDigest !== measured.codeDigest) problems.push(`the report ran against code ${String(report.candidate?.codeDigest).slice(0, 12)}, the tree is ${String(measured.codeDigest).slice(0, 12)}`);
  if (report.candidate?.manifestDigest !== measured.manifestDigest) problems.push(`the report is bound to manifest ${String(report.candidate?.manifestDigest).slice(0, 12)}, the tree is ${String(measured.manifestDigest).slice(0, 12)}`);
  return problems.length === 0 ? ok(`universe FULL, ${String(report.steps.length)} steps, bound to this tree`) : fail(problems.join('; '));
}

async function pollUntil(ctx, label, read, { every = 60_000, timeoutMs }) {
  const started = Date.now();
  let last = null;
  for (;;) {
    last = await read();
    if (last.done) return last;
    if (Date.now() - started > timeoutMs) return { ...last, done: true, ok: false, detail: `${label} did not conclude within ${String(Math.round(timeoutMs / MINUTE))} min: ${last.detail}` };
    ctx.log(`  … ${label}: ${last.detail}`);
    await ctx.wait(every);
  }
}

/**
 * The required legs on a commit, by check-run identity (MCD-R2): a leg's state
 * is that of the latest (by numeric id) GitHub Actions check run of its name —
 * in the workflow run's check suite when it is known — and any other app's
 * check run carrying a leg's name is held to success itself rather than being
 * allowed to stand in for, or be shadowed by, the leg.
 */
export async function readRequiredChecks(ctx, sha, { checkSuiteId = null } = {}) {
  const legs = requiredJobLegs(ctx.workflow).map((leg) => leg.name);
  const runs = await ctx.gh.list(`/repos/${REPOSITORY}/commits/${sha}/check-runs?filter=all`, { key: 'check_runs' });
  const isLeg = (run) => run.app?.slug === 'github-actions' && (checkSuiteId === null || run.check_suite?.id === checkSuiteId);
  const idOf = (run) => { try { return BigInt(run.id); } catch { return -1n; } };
  // The latest attempt per leg decides; earlier attempts are kept in the report.
  const latest = new Map();
  for (const run of runs.filter(isLeg)) {
    const previous = latest.get(run.name);
    if (previous === undefined || idOf(run) > idOf(previous)) latest.set(run.name, run);
  }
  const others = runs.filter((run) => legs.includes(run.name) && !isLeg(run));
  const missing = legs.filter((name) => !latest.has(name));
  const pending = [...new Set([
    ...legs.filter((name) => latest.has(name) && latest.get(name)?.status !== 'completed'),
    ...others.filter((run) => run.status !== 'completed').map((run) => run.name),
  ])];
  const red = [...new Set([
    ...legs.filter((name) => latest.get(name)?.status === 'completed' && latest.get(name)?.conclusion !== 'success'),
    ...others.filter((run) => run.status === 'completed' && run.conclusion !== 'success').map((run) => run.name),
  ])];
  const attempts = [...latest.keys()].map((name) => `${name}×${String(runs.filter((run) => run.name === name && isLeg(run)).length)}`);
  return { legs, runs, missing, pending, red, attempts };
}

const NODES = [
  {
    id: 'seal-check',
    phase: 'LOCAL',
    deps: [],
    timeoutMs: 2 * MINUTE,
    inputs: () => ['qualification/candidate/campaign.json'],
    run: (ctx) => ctx.nodeById('seal-check').check(ctx),
    check: (ctx) => {
      const result = exec(process.execPath, ['tools/seal-campaign.mjs', '--check'], { timeoutMs: 2 * MINUTE, log: join(ctx.work, 'logs', 'seal-check.log') });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
      if (result.status !== 0 || parsed?.matches !== true) return fail(failureDetail(result, 'seal-check'));
      return ok(`campaign ${String(parsed.campaignId)}: ${String(parsed.producersBinding)} binding producers unmoved`);
    },
  },
  {
    id: 'vendor-evidence',
    phase: 'LOCAL',
    deps: ['seal-check'],
    timeoutMs: 40 * MINUTE,
    inputs: () => ['qualification/campaign.mjs', 'qualification/oracles.mjs', 'qualification/authorized-instances.json'],
    run: (ctx) => {
      const auth = AUTH_DIR;
      const commands = [
        ['hs-target', ['qualification/hubspot/run-target-qualification.mjs', join(auth, 'hs-contract-51872453'), '--evidence', 'qualification/evidence/hs-target-contract.json']],
        ['sf-target', ['qualification/salesforce/run-target-qualification.mjs', join(auth, 'sf-bundle'), '--evidence', 'qualification/evidence/sf-target-contract.json']],
        ['sf-ocr', ['qualification/salesforce/run-ocr-qualification.mjs', '--auth', auth, '--evidence', 'qualification/evidence/sf-ocr.json']],
        ['hs-import', ['qualification/hubspot/run-import-qualification.mjs', '--auth', auth, '--bundle', join(auth, 'hs-contract-51872453'), '--evidence', 'qualification/evidence/hs-import.json']],
        ['sf-dataloader', ['qualification/salesforce/run-dataloader-qualification.mjs', '--auth', auth, '--evidence', 'qualification/evidence/sf-dataloader.json']],
      ];
      for (const [label, args] of commands) {
        const result = exec(process.execPath, args, { timeoutMs: 20 * MINUTE, log: join(ctx.work, 'logs', `vendor-${label}.log`) });
        // An authentication failure stops the sequence; it does not start the next runner.
        if (result.status !== 0) return fail(failureDetail(result, label));
      }
      return ctx.nodeById('vendor-evidence').check(ctx);
    },
    check: vendorEvidenceCheck,
    rehearsal: {
      run: (ctx) => (ctx.scenario === 'gate-fails' ? fail('CONTROL_FLOW_TEST_ONLY: the HubSpot import runner exited 7 having printed PASS') : ok('CONTROL_FLOW_TEST_ONLY: five vendor runners stood in')),
      check: (ctx) => (ctx.scenario === 'gate-fails' ? fail('CONTROL_FLOW_TEST_ONLY: hs-import.json is FAIL') : ok('CONTROL_FLOW_TEST_ONLY: vendor evidence stands in')),
    },
  },
  {
    id: 'capacity-matrix',
    phase: 'LOCAL',
    deps: ['seal-check'],
    timeoutMs: 6 * 60 * MINUTE,
    inputs: () => ['tools/capacity.mjs'],
    fingerprint: (ctx) => ctx.producerFingerprints['tools/capacity.mjs'],
    run: (ctx) => {
      const result = exec(process.execPath, ['tools/capacity.mjs', '--profile', MATRIX_PROFILES.join(','), '--rows', '1000000', '--matrix'], { timeoutMs: 6 * 60 * MINUTE, log: join(ctx.work, 'logs', 'capacity-matrix.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'capacity --matrix'));
      return ctx.nodeById('capacity-matrix').check(ctx);
    },
    check: (ctx) => capacityCheck(ctx, 'matrix'),
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: matrix stood in'), check: () => ok('CONTROL_FLOW_TEST_ONLY: matrix stands in') },
  },
  {
    id: 'capacity-founding',
    phase: 'LOCAL',
    deps: ['capacity-matrix'],
    timeoutMs: 6 * 60 * MINUTE,
    inputs: () => ['tools/capacity.mjs'],
    fingerprint: (ctx) => ctx.producerFingerprints['tools/capacity.mjs'],
    run: (ctx) => {
      const result = exec(process.execPath, ['tools/capacity.mjs', '--profile', 'FOUNDING-CLEAN-ONLY-1M,FOUNDING-HUBSPOT-1M,FOUNDING-SALESFORCE-1M', '--rows', '1000000', '--founding'], { timeoutMs: 6 * 60 * MINUTE, log: join(ctx.work, 'logs', 'capacity-founding.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'capacity --founding'));
      return ctx.nodeById('capacity-founding').check(ctx);
    },
    check: (ctx) => capacityCheck(ctx, 'founding'),
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: founding stood in'), check: () => ok('CONTROL_FLOW_TEST_ONLY: founding stands in') },
  },
  {
    id: 'records-pre-universe',
    phase: 'LOCAL',
    deps: ['vendor-evidence', 'capacity-matrix', 'capacity-founding'],
    timeoutMs: 15 * MINUTE,
    inputs: () => ['bench/prepare-universe.sh', 'tools/candidate-provenance.mjs', 'tools/provenance.mjs', 'tools/drift-gate.mjs'],
    run: (ctx) => {
      const result = exec('bash', ['bench/prepare-universe.sh'], { timeoutMs: 15 * MINUTE, log: join(ctx.work, 'logs', 'prepare-universe.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'prepare-universe.sh'));
      return recordsCheck(ctx);
    },
    check: recordsCheck,
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: records regenerated in order'), check: () => ok('CONTROL_FLOW_TEST_ONLY: records stand in') },
  },
  {
    id: 'universe',
    phase: 'LOCAL',
    deps: ['records-pre-universe'],
    timeoutMs: 480 * MINUTE,
    inputs: () => ['tools/universe.mjs'],
    fingerprint: (ctx) => ctx.producerFingerprints['tools/universe.mjs'],
    run: (ctx) => {
      const result = exec('npm', ['run', '--silent', 'universe'], { timeoutMs: 480 * MINUTE, log: join(ctx.work, 'logs', 'universe.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'universe'));
      return universeCheck();
    },
    check: universeCheck,
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: universe stood in'), check: () => ok('CONTROL_FLOW_TEST_ONLY: universe stands in') },
  },
  {
    id: 'records-final',
    phase: 'LOCAL',
    deps: ['universe'],
    timeoutMs: 30 * MINUTE,
    inputs: () => ['tools/candidate-provenance.mjs', 'tools/release-candidate-gate.mjs', 'tools/provenance.mjs'],
    run: (ctx) => {
      // The order the records' own requirements impose, each generator's
      // output committed before the next one that needs a clean tree runs:
      //
      //   universe report            committed (the universe wrote it)
      //   candidate manifest         regenerated, committed
      //   release provenance         regenerated over the old preflight, committed —
      //                              the preflight's drift fact runs provenance:check
      //   preflight                  computed on a clean tree, with the vendor
      //                              credentials the facts ask the instances with, committed
      //   release provenance again   now over the new preflight, committed
      //   every check                manifest, provenance, preflight, drift; tree clean
      //
      // The first draft ran generate-everything-then-commit and the preflight
      // refused the dirty tree, which is the refusal it exists to make.
      const vendor = vendorEnv();
      const commitIfChanged = (paths, message) => {
        const present = paths.filter((path) => existsSync(join(repoRoot, path)));
        if (present.length === 0) return null;
        const staged = exec('git', ['add', '--', ...present], { log: join(ctx.work, 'logs', 'records-final-git-add.log') });
        if (staged.status !== 0) return failureDetail(staged, 'git add');
        if (exec('git', ['diff', '--cached', '--quiet']).status === 0) return null;
        const commit = exec('git', ['commit', '-q', '-m', message], { log: join(ctx.work, 'logs', 'records-final-git-commit.log') });
        return commit.status === 0 ? null : failureDetail(commit, 'git commit');
      };
      const generate = (label, command, args, env = {}) => {
        const result = exec(command, args, { timeoutMs: 15 * MINUTE, env, log: join(ctx.work, 'logs', `records-final-${label}.log`) });
        return result.status === 0 ? null : failureDetail(result, label);
      };
      const steps = [
        () => commitIfChanged(['qualification/candidate/universe.json'], 'records: universe report'),
        () => generate('manifest', process.execPath, ['tools/candidate-provenance.mjs']),
        () => commitIfChanged(['qualification/candidate/manifest.json', 'qualification/candidate/provenance.json'], 'records: candidate manifest and provenance'),
        () => generate('release-provenance-1', 'npm', ['run', '--silent', 'provenance']),
        () => commitIfChanged(['migration-core-provenance.json', 'docs/release/MIGRATION_CORE_PROVENANCE.md'], 'records: release provenance before the preflight'),
        () => generate('preflight', process.execPath, ['tools/release-candidate-gate.mjs', '--preflight'], vendor),
        () => commitIfChanged(['qualification/candidate/preflight.json'], 'records: preflight'),
        () => generate('release-provenance-2', 'npm', ['run', '--silent', 'provenance']),
        () => commitIfChanged(['migration-core-provenance.json', 'docs/release/MIGRATION_CORE_PROVENANCE.md'], 'records: release provenance'),
        () => generate('manifest-check', process.execPath, ['tools/candidate-provenance.mjs', '--check']),
        () => generate('provenance-check', 'npm', ['run', '--silent', 'provenance:check']),
        () => generate('preflight-check', process.execPath, ['tools/release-candidate-gate.mjs', '--preflight', '--check'], vendor),
        () => generate('drift', process.execPath, ['tools/drift-gate.mjs']),
      ];
      for (const step of steps) {
        const problem = step();
        if (problem !== null) return fail(problem);
      }
      const dirty = git(['status', '--porcelain', '-uall']);
      if (dirty !== '') return fail(`the tree has uncommitted paths after the records: ${dirty.split('\n').slice(0, 5).join(', ')}`);
      // Bind the generated commit before the wrapped check can observe a
      // concurrent outside merge of the earlier PR head.
      const qualified = qualifyRecordsHead(ctx);
      if (!qualified.ok) return qualified;
      return ctx.nodeById('records-final').check(ctx);
    },
    check: (ctx) => {
      const base = recordsCheck(ctx);
      if (!base.ok) return base;
      const preflight = exec(process.execPath, ['tools/release-candidate-gate.mjs', '--preflight', '--check'], { timeoutMs: 15 * MINUTE, env: vendorEnv(), log: join(ctx.work, 'logs', 'records-final-preflight-check.log') });
      if (preflight.status !== 0) return fail(failureDetail(preflight, 'preflight --check'));
      const universe = universeCheck();
      if (!universe.ok) return universe;
      const preflightRecord = readJson(join(repoRoot, 'qualification', 'candidate', 'preflight.json'));
      if (preflightRecord?.MIGRATION_CORE_CANDIDATE_PREFLIGHT !== 'TRUE') return fail(`the preflight is ${String(preflightRecord?.MIGRATION_CORE_CANDIDATE_PREFLIGHT)}`);
      return ok('records regenerated in order, preflight TRUE and current, universe bound, tree clean');
    },
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: final records committed'), check: () => ok('CONTROL_FLOW_TEST_ONLY: final records stand in') },
  },
  {
    id: 'push',
    phase: 'LOCAL',
    deps: ['records-final'],
    timeoutMs: 5 * MINUTE,
    inputs: () => [],
    run: async (ctx) => {
      const pull = await readBoundPull(ctx);
      const problem = pullIdentityProblem(ctx, pull, { beforePush: true });
      if (problem !== null) return fail(problem);
      if (pull.merged === true) return verifyMergedCommit(ctx, pull);
      const result = exec('git', ['push', 'origin', `${ctx.state.candidate}:${ctx.state.branch}`], { timeoutMs: 5 * MINUTE, log: join(ctx.work, 'logs', 'push.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'git push'));
      ctx.state.pushedCandidate = ctx.state.candidate;
      ctx.saveState();
      return ctx.nodeById('push').check(ctx);
    },
    check: async (ctx) => {
      const pull = await readBoundPull(ctx);
      const problem = pullIdentityProblem(ctx, pull);
      if (problem !== null) return fail(problem);
      if (pull.merged === true) return verifyMergedCommit(ctx, pull);
      if (ctx.state.pushedCandidate !== ctx.state.candidate) {
        ctx.state.pushedCandidate = ctx.state.candidate;
        ctx.saveState();
      }
      return ok(`PR head is candidate ${ctx.state.candidate}`);
    },
    rehearsal: { run: () => ok('CONTROL_FLOW_TEST_ONLY: pushed'), check: () => ok('CONTROL_FLOW_TEST_ONLY: pushed') },
  },
  {
    id: 'pr-ci',
    phase: 'REMOTE',
    deps: ['push'],
    timeoutMs: 300 * MINUTE,
    inputs: () => ['.github/workflows/ci.yml'],
    run: async (ctx) => {
      const head = ctx.state.candidate;
      const result = await pollUntil(ctx, `PR #${String(ctx.state.prNumber)} checks on ${head.slice(0, 12)}`, async () => {
        const pull = await readBoundPull(ctx);
        const problem = pullIdentityProblem(ctx, pull);
        if (problem !== null) return { done: true, ...fail(problem) };
        if (pull.merged === true) return { done: true, ...await verifyMergedCommit(ctx, pull) };
        const checks = await readRequiredChecks(ctx, head);
        if (checks.pending.length > 0 || checks.missing.length > 0) return { done: false, detail: `pending ${checks.pending.length}, not yet reported ${checks.missing.length}` };
        if (checks.red.length > 0) return { done: true, ok: false, detail: `red: ${checks.red.join(', ')} (attempts ${checks.attempts.join(' ')})` };
        return { done: true, ok: true, detail: `${String(checks.legs.length)} required checks green on ${head.slice(0, 12)} (attempts ${checks.attempts.join(' ')})` };
      }, { every: ctx.rehearsal ? 0 : 60_000, timeoutMs: 300 * MINUTE });
      return result.ok ? ok(result.detail) : fail(result.detail);
    },
    check: async (ctx) => {
      const checks = await readRequiredChecks(ctx, ctx.state.candidate);
      if (checks.missing.length > 0 || checks.pending.length > 0 || checks.red.length > 0) return fail(`missing ${checks.missing.join(', ') || '-'}; pending ${checks.pending.join(', ') || '-'}; red ${checks.red.join(', ') || '-'}`);
      return ok(`${String(checks.legs.length)} required checks green on ${ctx.state.candidate.slice(0, 12)}`);
    },
  },
  {
    id: 'merge',
    phase: 'REMOTE',
    deps: ['pr-ci'],
    mutation: true,
    timeoutMs: 5 * MINUTE,
    inputs: () => [],
    run: async (ctx) => {
      let pull = await readBoundPull(ctx);
      const problem = pullIdentityProblem(ctx, pull);
      if (problem !== null) return fail(problem);
      if (pull.merged === true) return verifyMergedCommit(ctx, pull);
      if (pull.mergeable === false) return fail(`PR #${String(ctx.state.prNumber)} is not mergeable (${String(pull.mergeable_state)})`);
      if (pull.draft === true) {
        if (!pull.node_id) return fail(`PR #${String(ctx.state.prNumber)} is a draft and carries no node id to mark it ready with`);
        await ctx.gh.graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', { id: pull.node_id });
        pull = await readBoundPull(ctx);
        const changed = pullIdentityProblem(ctx, pull);
        if (changed !== null) return fail(changed);
        if (pull.merged === true) return verifyMergedCommit(ctx, pull);
        if (pull.draft !== false) return fail(`PR #${String(ctx.state.prNumber)} is still a draft after being marked ready`);
      }
      let merged;
      try {
        merged = await ctx.gh.put(`/repos/${REPOSITORY}/pulls/${String(ctx.state.prNumber)}/merge`, { merge_method: 'rebase', sha: ctx.state.candidate });
      } catch (error) {
        // The server may have merged despite a lost response. Only the pull
        // record, with this identity, can resolve that ambiguous outcome.
        const again = await readBoundPull(ctx);
        if (again.merged === true) return verifyMergedCommit(ctx, again);
        return fail(`the merge was refused: ${String(error.message)}`);
      }
      if (merged?.merged !== true || !/^[0-9a-f]{40}$/u.test(String(merged.sha))) return fail(`the merge did not answer with a commit: ${JSON.stringify(merged).slice(0, 200)}`);
      return verifyMergedCommit(ctx, null, merged.sha);
    },
    check: (ctx) => verifyMergedCommit(ctx),
  },
  {
    id: 'main-ci',
    phase: 'REMOTE',
    deps: ['merge'],
    timeoutMs: 300 * MINUTE,
    inputs: () => ['.github/workflows/ci.yml'],
    run: async (ctx) => {
      const sha = ctx.state.mergedSha;
      const result = await pollUntil(ctx, `main run on ${sha.slice(0, 12)}`, async () => {
        const runs = await ctx.gh.list(`/repos/${REPOSITORY}/actions/runs?head_sha=${sha}&event=push`, { key: 'workflow_runs' });
        const run = runs.find((entry) => entry.path === '.github/workflows/ci.yml' || entry.name === 'core gate');
        if (run === undefined) return { done: false, detail: 'no push run reported yet' };
        if (run.status !== 'completed') return { done: false, detail: `run ${String(run.id)} ${String(run.status)}` };
        if (run.conclusion !== 'success') return { done: true, ok: false, detail: `run ${String(run.id)} concluded ${String(run.conclusion)}` };
        return { done: true, ok: true, run };
      }, { every: ctx.rehearsal ? 0 : 60_000, timeoutMs: 300 * MINUTE });
      if (!result.ok) return fail(result.detail);
      const run = result.run;
      const checks = await readRequiredChecks(ctx, sha, { checkSuiteId: run.check_suite_id ?? null });
      if (checks.red.length > 0 || checks.missing.length > 0 || checks.pending.length > 0) return fail(`main checks: red ${checks.red.join(', ') || '-'}, missing ${checks.missing.join(', ') || '-'}, pending ${checks.pending.join(', ') || '-'}`);
      const artifacts = await ctx.gh.list(`/repos/${REPOSITORY}/actions/runs/${String(run.id)}/artifacts`, { key: 'artifacts' });
      const artifact = artifacts.find((entry) => entry.name === `ci-receipt-${sha}` && entry.expired !== true);
      if (artifact === undefined) return fail(`run ${String(run.id)} carries no ci-receipt-${sha.slice(0, 12)} artifact (${artifacts.map((entry) => entry.name).join(', ') || 'none'})`);
      // The artifact endpoint answers 415 to Accept: application/octet-stream; it wants the JSON media type and redirects to the archive.
      const zip = await ctx.gh.bytes(`/repos/${REPOSITORY}/actions/artifacts/${String(artifact.id)}/zip`, 'application/vnd.github+json');
      const members = unzipSync(new Uint8Array(zip));
      const receiptBytes = members['ci-receipt.json'];
      if (receiptBytes === undefined) return fail(`artifact ${String(artifact.id)} holds ${Object.keys(members).join(', ')}, not ci-receipt.json`);
      mkdirSync(join(ctx.work, 'receipt'), { recursive: true });
      writeFileSync(ctx.receiptPath, Buffer.from(receiptBytes));
      ctx.state.runId = String(run.id);
      ctx.state.receiptSha256 = sha256(Buffer.from(receiptBytes));
      ctx.saveState();
      return ok(`run ${String(run.id)} green; receipt ${ctx.state.receiptSha256.slice(0, 16)} downloaded from artifact ${String(artifact.id)}`);
    },
    check: (ctx) => {
      const actual = fileSha(ctx.receiptPath);
      if (actual === null) return fail('no receipt downloaded');
      if (actual !== ctx.state.receiptSha256) return fail('the receipt on disk is not the one downloaded');
      const receipt = readJson(ctx.receiptPath);
      return receipt?.sha === ctx.state.mergedSha ? ok(`receipt for ${String(receipt.sha).slice(0, 12)}, run ${String(receipt.runId)}`) : fail(`the receipt attests ${String(receipt?.sha).slice(0, 12)}`);
    },
  },
  {
    id: 'checkout-merged',
    phase: 'REMOTE',
    deps: ['main-ci'],
    timeoutMs: 10 * MINUTE,
    inputs: () => [],
    run: (ctx) => {
      const sha = ctx.state.mergedSha;
      const fetched = exec('git', ['fetch', '-q', 'origin', 'main'], { timeoutMs: 5 * MINUTE, log: join(ctx.work, 'logs', 'fetch-merged.log') });
      if (fetched.status !== 0) return fail(failureDetail(fetched, 'git fetch'));
      const dirty = git(['status', '--porcelain', '-uall']);
      if (dirty !== '') return fail(`the tree is dirty; not checking out over ${dirty.split('\n').length} path(s)`);
      const out = exec('git', ['checkout', '-q', '--detach', sha], { log: join(ctx.work, 'logs', 'checkout-merged.log') });
      if (out.status !== 0) return fail(failureDetail(out, `git checkout ${sha.slice(0, 12)}`));
      const build = exec('npm', ['run', '--silent', 'build'], { timeoutMs: 10 * MINUTE, log: join(ctx.work, 'logs', 'build-merged.log') });
      if (build.status !== 0) return fail(failureDetail(build, 'merged build'));
      return ctx.nodeById('checkout-merged').check(ctx);
    },
    check: (ctx) => {
      const head = git(['rev-parse', 'HEAD']);
      const dirty = git(['status', '--porcelain', '-uall']);
      if (head !== ctx.state.mergedSha) return fail(`the checkout is ${head.slice(0, 12)}, the merged commit is ${String(ctx.state.mergedSha).slice(0, 12)}`);
      if (dirty !== '') return fail('the checkout is dirty');
      return ok(`clean checkout of ${head.slice(0, 12)}`);
    },
    rehearsal: {
      run: (ctx) => (git(['rev-parse', 'HEAD']) === ctx.state.mergedSha && git(['status', '--porcelain', '-uall']) === '' ? ok('CONTROL_FLOW_TEST_ONLY: the checkout already is the rehearsed merged commit') : fail('CONTROL_FLOW_TEST_ONLY: the checkout is not the rehearsed commit or is dirty')),
      check: (ctx) => (git(['rev-parse', 'HEAD']) === ctx.state.mergedSha ? ok('CONTROL_FLOW_TEST_ONLY: checkout is the rehearsed commit') : fail('CONTROL_FLOW_TEST_ONLY: checkout moved')),
    },
  },
  {
    id: 'receipt-observe',
    phase: 'REMOTE',
    deps: ['checkout-merged'],
    timeoutMs: 10 * MINUTE,
    inputs: () => ['tools/receipt-verify.mjs'],
    run: (ctx) => ctx.nodeById('receipt-observe').check(ctx),
    check: (ctx) => {
      if (readJson(ctx.receiptPath)?.sha !== ctx.state.mergedSha) return fail('the receipt does not attest the verified PR merge commit');
      const result = exec(process.execPath, [...ctx.childPreload, 'tools/receipt-verify.mjs', '--observe', '--receipt', ctx.receiptPath], { timeoutMs: 10 * MINUTE, env: ctx.childEnv, log: join(ctx.work, 'logs', 'receipt-observe.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'receipt-verify --observe'));
      return ok(`receipt verified against GitHub: ${result.stdout.trim().split('\n').slice(-1)[0]?.slice(0, 160)}`);
    },
  },
  {
    id: 'dossier-build',
    phase: 'REMOTE',
    deps: ['receipt-observe'],
    timeoutMs: 15 * MINUTE,
    inputs: () => ['tools/release-dossier.mjs'],
    run: (ctx) => {
      if (git(['rev-parse', 'HEAD']) !== ctx.state.mergedSha) return fail('the dossier checkout is not the verified PR merge commit');
      if (readJson(ctx.receiptPath)?.sha !== ctx.state.mergedSha) return fail('the dossier receipt does not attest the verified PR merge commit');
      // In a rehearsal the candidate records are stand-ins written by the
      // rehearsal for this tree, and the dossier says so in its own manifest.
      const records = ctx.rehearsal ? ['--records', join(ctx.work, 'records')] : [];
      const result = exec(process.execPath, ['tools/release-dossier.mjs', '--build', '--out', ctx.dossierDir, '--receipt', ctx.receiptPath, '--tag', TAG, '--repository', REPOSITORY, ...records], { timeoutMs: 15 * MINUTE, env: ctx.childEnv, log: join(ctx.work, 'logs', 'dossier-build.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'release-dossier --build'));
      return ctx.nodeById('dossier-build').check(ctx);
    },
    check: async (ctx) => {
      if (!existsSync(ctx.dossierDir)) return fail('no dossier built');
      const facts = await candidateFacts({ repository: REPOSITORY, tag: TAG });
      if (facts.sha !== ctx.state.mergedSha) return fail('candidate facts are not for the verified PR merge commit');
      if (facts.problems.length > 0) return fail(facts.problems.join('; '));
      const problems = verifyLocalDossier({ dir: ctx.dossierDir, facts: { ...facts, controlFlowTestOnly: ctx.rehearsal }, receiptPath: ctx.receiptPath });
      return problems.length === 0 ? ok(`dossier ${DOSSIER_INVENTORY_VERSION} verified locally: ${String(readDossierDir(ctx.dossierDir).assets.length)} assets`) : fail(problems.join('; '));
    },
  },
  {
    id: 'consumer-check',
    phase: 'REMOTE',
    deps: ['dossier-build'],
    timeoutMs: 15 * MINUTE,
    inputs: () => ['tools/consumer-check.mjs'],
    run: (ctx) => {
      const tarball = join(ctx.dossierDir, `kauro-migration-core-${versions.coreVersion}.tgz`);
      const result = exec(process.execPath, ['tools/consumer-check.mjs', '--tarball', tarball, '--out', join(ctx.work, 'consumer-check.json')], { timeoutMs: 15 * MINUTE, log: join(ctx.work, 'logs', 'consumer-check.log') });
      if (result.status !== 0) return fail(failureDetail(result, 'consumer-check'));
      return ctx.nodeById('consumer-check').check(ctx);
    },
    check: (ctx) => {
      const report = readJson(join(ctx.work, 'consumer-check.json'));
      if (report === null) return fail('no consumer-check report');
      if (report.tarballSha256 !== fileSha(join(ctx.dossierDir, `kauro-migration-core-${versions.coreVersion}.tgz`))) return fail('the consumer report is about a different tarball');
      return report.ok === true ? ok(`TypeScript strict consumer compiled and ran against the tarball (${String(report.checks?.length ?? 0)} checks)`) : fail(`consumer check: ${(report.problems ?? []).join('; ')}`);
    },
  },
  {
    id: 'tag',
    phase: 'REMOTE',
    deps: ['consumer-check', 'receipt-observe'],
    mutation: true,
    timeoutMs: 5 * MINUTE,
    inputs: () => [],
    run: async (ctx) => {
      const sha = ctx.state.mergedSha;
      // The tag must not exist, and neither may a release on it: a deleted
      // immutable release reserves its name, and the only safe answer to
      // "does it exist?" is to read, never to try.
      let existing = null;
      try {
        existing = await ctx.gh.get(`/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(TAG)}`);
      } catch (error) {
        if (error.status !== 404) return fail(`the tag could not be read: ${String(error.message)}`);
      }
      if (existing !== null) {
        return fail(`${TAG} already exists (${String(existing.object?.type)} ${String(existing.object?.sha).slice(0, 12)}); the chain does not overwrite a tag and does not pick another version`);
      }
      const releases = await ctx.gh.list(`/repos/${REPOSITORY}/releases`);
      if (releases.some((release) => release.tag_name === TAG)) return fail(`a release already names ${TAG}`);
      const object = await ctx.gh.post(`/repos/${REPOSITORY}/git/tags`, { tag: TAG, message: `Kauro Migration Core ${TAG}\n\nCommit ${sha}. Dossier inventory ${DOSSIER_INVENTORY_VERSION}.`, object: sha, type: 'commit' });
      await ctx.gh.post(`/repos/${REPOSITORY}/git/refs`, { ref: `refs/tags/${TAG}`, sha: object.sha });
      ctx.state.tagObjectSha = object.sha;
      ctx.saveState();
      return ctx.nodeById('tag').check(ctx);
    },
    check: async (ctx) => {
      let ref;
      try {
        ref = await ctx.gh.get(`/repos/${REPOSITORY}/git/ref/tags/${encodeURIComponent(TAG)}`);
      } catch (error) {
        return fail(`${TAG} could not be read: ${String(error.message)}`);
      }
      if (ref.object?.type !== 'tag') return fail(`${TAG} is ${String(ref.object?.type)}, not an annotated tag`);
      const tag = await ctx.gh.get(`/repos/${REPOSITORY}/git/tags/${String(ref.object.sha)}`);
      return tag.object?.sha === ctx.state.mergedSha ? ok(`${TAG} is annotated and points at ${ctx.state.mergedSha.slice(0, 12)}`) : fail(`${TAG} points at ${String(tag.object?.sha).slice(0, 12)}, not ${String(ctx.state.mergedSha).slice(0, 12)}`);
    },
  },
  {
    id: 'release-draft',
    phase: 'REMOTE',
    deps: ['tag', 'dossier-build'],
    mutation: true,
    timeoutMs: 30 * MINUTE,
    inputs: () => ['tools/release-dossier.mjs'],
    run: async (ctx) => {
      const { assets } = readDossierDir(ctx.dossierDir);
      const release = await ctx.gh.post(`/repos/${REPOSITORY}/releases`, {
        tag_name: TAG,
        name: `Kauro Migration Core ${TAG}`,
        body: `Migration Core ${versions.coreVersion}, package format ${versions.packageFormatVersion}. Commit ${ctx.state.mergedSha}. Dossier inventory ${DOSSIER_INVENTORY_VERSION}; SHA256SUMS covers every other asset. The freeze verdict is published beside this release, not inside it.`,
        draft: true,
        prerelease: false,
        target_commitish: ctx.state.mergedSha,
      });
      ctx.state.releaseId = release.id;
      ctx.saveState();
      const type = (name) => (name.endsWith('.json') ? 'application/json' : name === SUMS_NAME ? 'text/plain' : 'application/gzip');
      for (const asset of assets) {
        const uploaded = await ctx.gh.upload(release.id, REPOSITORY, asset.name, asset.bytes, type(asset.name));
        if (uploaded?.name !== asset.name || uploaded?.size !== asset.bytes.length) return fail(`${asset.name} uploaded as ${String(uploaded?.name)} ${String(uploaded?.size)} bytes`);
      }
      return ctx.nodeById('release-draft').check(ctx);
    },
    check: async (ctx) => {
      if (!ctx.state.releaseId) return fail('no draft recorded');
      const facts = await candidateFacts({ repository: REPOSITORY, tag: TAG });
      if (facts.sha !== ctx.state.mergedSha) return fail('candidate facts are not for the verified PR merge commit');
      if (facts.problems.length > 0) return fail(facts.problems.join('; '));
      const result = await verifyPublishedRelease({ api: ctx.dossierApi, repository: REPOSITORY, tagName: TAG, expectedSha: ctx.state.mergedSha, facts: { ...facts, controlFlowTestOnly: ctx.rehearsal }, receiptSha256: ctx.state.receiptSha256, allowDraft: true, releaseId: ctx.state.releaseId });
      if (!result.assets.value) return fail(`the draft's dossier: ${result.assets.observed}`);
      // Once published, the draft step is done and stays done: its output is
      // the release with these assets, and that is what was verified.
      return ok(`release ${String(ctx.state.releaseId)} ${result.draft === true ? 'draft_ready' : 'published'}: ${result.assets.observed}`);
    },
  },
  {
    id: 'release-publish',
    phase: 'REMOTE',
    deps: ['release-draft'],
    mutation: true,
    timeoutMs: 15 * MINUTE,
    inputs: () => [],
    run: async (ctx) => {
      const ready = await ctx.nodeById('release-draft').check(ctx);
      if (!ready.ok) return fail(`not publishing: ${ready.detail}`);
      // The immutable-releases policy, read from the repository before the one
      // publication rather than assumed from the last time it was checked. A
      // release published while the policy is off would be mutable for good.
      let policy;
      try {
        policy = await ctx.gh.get(`/repos/${REPOSITORY}/immutable-releases`);
      } catch (error) {
        return fail(`the immutable-releases policy could not be read, so nothing is published: ${String(error.message)}`);
      }
      if (policy?.enabled !== true) return fail(`immutable releases are not enabled on ${REPOSITORY} (${JSON.stringify(policy)}); nothing is published`);
      await ctx.gh.patch(`/repos/${REPOSITORY}/releases/${String(ctx.state.releaseId)}`, { draft: false });
      return ctx.nodeById('release-publish').check(ctx);
    },
    check: async (ctx) => {
      const facts = await candidateFacts({ repository: REPOSITORY, tag: TAG });
      if (facts.sha !== ctx.state.mergedSha) return fail('candidate facts are not for the verified PR merge commit');
      if (facts.problems.length > 0) return fail(facts.problems.join('; '));
      const result = await verifyPublishedRelease({ api: ctx.dossierApi, repository: REPOSITORY, tagName: TAG, expectedSha: ctx.state.mergedSha, facts: { ...facts, controlFlowTestOnly: ctx.rehearsal }, receiptSha256: ctx.state.receiptSha256, allowDraft: false });
      if (!result.published.value) return fail(result.published.observed);
      if (!result.assets.value) return fail(result.assets.observed);
      return ok(`${result.published.observed}; ${result.assets.observed}`);
    },
  },
  {
    id: 'freeze-verdict',
    phase: 'REMOTE',
    deps: ['release-publish'],
    timeoutMs: 15 * MINUTE,
    inputs: () => ['tools/freeze-verdict.mjs'],
    run: (ctx) => ctx.nodeById('freeze-verdict').check(ctx),
    check: (ctx) => {
      const out = join(ctx.work, 'freeze-verdict.json');
      const result = exec(process.execPath, [...ctx.childPreload, 'tools/freeze-verdict.mjs', '--sha', ctx.state.mergedSha, '--tag', TAG, '--receipt', ctx.receiptPath, '--repository', REPOSITORY, '--out', out], { timeoutMs: 15 * MINUTE, env: ctx.childEnv, log: join(ctx.work, 'logs', 'freeze-verdict.log') });
      const report = readJson(out);
      if (report === null) return fail(failureDetail(result, 'freeze-verdict (no report)'));
      const flags = ['MIGRATION_CORE_ARCHITECTURE_CLOSED', 'MIGRATION_CORE_RELEASE_CANDIDATE', 'MIGRATION_CORE_IMPLEMENTATION_FROZEN', 'MIGRATION_CORE_V1_FROZEN'].map((name) => `${name}=${String(report[name])}`);
      const falseConditions = report.conditions.filter((entry) => entry.value !== true).map((entry) => entry.name);
      if (ctx.rehearsal) {
        // A rehearsal cannot make the local conditions true — the tree is not
        // the merged commit and no CI ran — so what it proves is that every
        // remote condition was reached and satisfied through the injected
        // transport. The flags are reported as the verdict computed them.
        const remote = ['main_is_the_expected_commit', 'main_protection_in_force', 'no_bypass_actors', 'annotated_tag_on_this_commit', 'release_published_immutable', 'release_assets_verified', 'external_receipt_verified'];
        const remoteFalse = remote.filter((name) => report.conditions.find((entry) => entry.name === name)?.value !== true);
        return remoteFalse.length === 0
          ? ok(`CONTROL_FLOW_TEST_ONLY: every remote condition true through the injected transport; verdict computed ${flags.join(' ')}; false locally: ${falseConditions.join(', ') || 'none'}`)
          : fail(`CONTROL_FLOW_TEST_ONLY: ${failureDetail(result, 'freeze-verdict')}; remote conditions false: ${remoteFalse.map((name) => `${name} (${report.conditions.find((entry) => entry.name === name)?.observed})`).join('; ')}`);
      }
      return result.status === 0 && falseConditions.length === 0 ? ok(`${flags.join(' ')} (${out})`) : fail(`${failureDetail(result, 'freeze-verdict')}; false: ${falseConditions.join(', ')}`);
    },
  },
  {
    id: 'handoff',
    phase: 'REMOTE',
    deps: ['freeze-verdict'],
    timeoutMs: 2 * MINUTE,
    inputs: () => [],
    run: (ctx) => {
      const verdict = readJson(join(ctx.work, 'freeze-verdict.json'));
      const manifest = readJson(join(ctx.dossierDir, 'dossier-manifest.json'));
      const handoff = {
        artifactKind: 'MIGRATION_CORE_HANDOFF',
        writtenAt: nowUtc(),
        controlFlowTestOnly: ctx.rehearsal,
        repository: REPOSITORY,
        sha: ctx.state.mergedSha,
        gitTree: manifest?.gitTree ?? null,
        tag: TAG,
        tagObjectSha: ctx.state.tagObjectSha ?? null,
        releaseId: ctx.state.releaseId ?? null,
        runId: ctx.state.runId ?? null,
        receiptSha256: ctx.state.receiptSha256 ?? null,
        versions: { ...versions },
        codeDigest: manifest?.codeDigest ?? null,
        manifestDigest: manifest?.manifestDigest ?? null,
        campaignId: manifest?.campaignId ?? null,
        producers: manifest?.producers ?? null,
        assets: manifest?.assets ?? null,
        packageSha256: manifest?.assets?.find((entry) => entry.role === 'PACKAGE')?.sha256 ?? null,
        verdict: verdict === null ? null : { decidedAt: verdict.decidedAt, flags: Object.fromEntries(['MIGRATION_CORE_ARCHITECTURE_CLOSED', 'MIGRATION_CORE_RELEASE_CANDIDATE', 'MIGRATION_CORE_IMPLEMENTATION_FROZEN', 'MIGRATION_CORE_V1_FROZEN'].map((name) => [name, verdict[name]])), sha256: fileSha(join(ctx.work, 'freeze-verdict.json')) },
      };
      writeFileSync(join(ctx.work, 'handoff.json'), `${JSON.stringify(handoff, null, 2)}\n`);
      return ok(`handoff written to ${join(ctx.work, 'handoff.json')}`);
    },
    check: (ctx) => {
      const handoff = readJson(join(ctx.work, 'handoff.json'));
      return handoff !== null && handoff.sha === ctx.state.mergedSha ? ok(`handoff for ${String(handoff.sha).slice(0, 12)}`) : fail('no handoff for the merged commit');
    },
  },
];

// A completed merge satisfies these nodes from the PR record, even after
// branch deletion/movement or checkout. No producer, branch lookup, or push
// may run in this path. Keep this on implementations as well as the walk.
const PRE_MERGE = new Set(['records-final', 'push', 'pr-ci', 'merge']);
for (const node of NODES) {
  if (!PRE_MERGE.has(node.id)) continue;
  for (const impl of [node, node.rehearsal].filter(Boolean)) {
    for (const operation of ['run', 'check']) {
      const original = impl[operation];
      impl[operation] = async (ctx) => {
        const pull = await readBoundPull(ctx);
        if (pull.merged === true) return verifyMergedCommit(ctx, pull);
        if (node.id !== 'records-final') {
          const problem = pullIdentityProblem(ctx, pull, { beforePush: node.id === 'push' && operation === 'run' });
          if (problem !== null) return fail(problem);
        } else {
          const problem = pullIdentityProblem(ctx, pull, { beforePush: true });
          if (problem !== null) return fail(problem);
        }
        const result = await original(ctx);
        if (result.ok && node.id === 'records-final') {
          const qualified = qualifyRecordsHead(ctx);
          if (!qualified.ok) return qualified;
          const after = await readBoundPull(ctx);
          const problem = pullIdentityProblem(ctx, after, { beforePush: true });
          if (problem !== null) return fail(problem);
          if (after.merged === true) return verifyMergedCommit(ctx, after);
        }
        return result;
      };
    }
  }
}

// Guard the implementations themselves, not just graph dependencies: an
// isolated oracle or resumed producer must establish the PR's merge result
// before reading local evidence or making a downstream mutation. Rehearsal
// stand-ins obey the same guard.
const MERGED_CONSUMERS = new Set(['main-ci', 'checkout-merged', 'receipt-observe', 'dossier-build', 'consumer-check', 'tag', 'release-draft', 'release-publish', 'freeze-verdict', 'handoff']);
for (const node of NODES) {
  if (!MERGED_CONSUMERS.has(node.id)) continue;
  for (const impl of [node, node.rehearsal].filter(Boolean)) {
    for (const operation of ['run', 'check']) {
      const original = impl[operation];
      impl[operation] = async (ctx) => {
        const verified = await verifyMergedCommit(ctx);
        return verified.ok ? original(ctx) : verified;
      };
    }
  }
}

// ------------------------------------------------------------------- graph

export function validateGraph(nodes) {
  const problems = [];
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) problems.push(`node ${node.id} is declared twice`);
    ids.add(node.id);
  }
  for (const node of nodes) for (const dep of node.deps) if (!ids.has(dep)) problems.push(`${node.id} depends on ${dep}, which is not declared`);
  // Kahn's algorithm; what is left over is a cycle.
  const indegree = new Map(nodes.map((node) => [node.id, node.deps.length]));
  const dependents = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) for (const dep of node.deps) dependents.get(dep)?.push(node.id);
  const ready = nodes.filter((node) => node.deps.length === 0).map((node) => node.id);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== nodes.length) problems.push(`cycle among ${nodes.filter((node) => !order.includes(node.id)).map((node) => node.id).join(', ')}`);
  // An orphan is a node nothing depends on that is not the terminal node.
  const terminal = nodes[nodes.length - 1]?.id;
  for (const node of nodes) if ((dependents.get(node.id) ?? []).length === 0 && node.id !== terminal) problems.push(`${node.id} is an orphan: nothing depends on it and it is not the terminal node`);
  return { order, problems };
}

// ------------------------------------------------------------------ engine

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(fail(`${label} did not finish within ${String(Math.round(ms / MINUTE))} min`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function walk(ctx, { mode, until = null }) {
  const { order, problems } = validateGraph(NODES);
  if (problems.length > 0) throw new Error(`the graph is not valid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  const results = new Map();
  const selected = until === null ? order : order.slice(0, order.indexOf(until) + 1);
  for (const id of selected) {
    const node = ctx.nodeById(id);
    const impl = ctx.rehearsal && node.rehearsal ? node.rehearsal : node;
    const blockedBy = node.deps.filter((dep) => results.get(dep)?.status !== 'PASS' && results.get(dep)?.status !== 'REUSED');
    const started = nowUtc();
    let outcome;
    if (blockedBy.length > 0) {
      outcome = { status: 'BLOCKED', detail: `blocked by ${blockedBy.join(', ')}` };
    } else if (mode === 'check') {
      const checked = await withTimeout(impl.check(ctx), node.timeoutMs, `${id} check`).catch((error) => fail(`check threw: ${String(error.message)}`));
      outcome = { status: checked.ok ? 'PASS' : 'FAIL', detail: checked.detail };
    } else {
      // Reuse when the oracle already holds and the recorded inputs are unchanged.
      const fingerprint = node.fingerprint ? node.fingerprint(ctx) : digestOfInputs(node.inputs(ctx));
      const previous = ctx.ledgerLast(id);
      const already = await withTimeout(impl.check(ctx), node.timeoutMs, `${id} check`).catch((error) => fail(`check threw: ${String(error.message)}`));
      // A node the ledger last saw as PASS or REUSED, with the same inputs, is
      // reused; the second launch re-ran the vendor runners because REUSED was
      // not counted, and an interrupted runner had to be cleaned up by hand.
      const heldBefore = previous !== null && (previous.status === 'PASS' || previous.status === 'REUSED') && previous.fingerprint === fingerprint;
      if (already.ok && already.satisfied) {
        outcome = { status: 'REUSED', detail: `satisfied by merged PR record: ${already.detail}` };
      } else if (already.ok && heldBefore && !node.mutation) {
        outcome = { status: 'REUSED', detail: `oracle holds and inputs unchanged since ${previous.end}: ${already.detail}` };
      } else if (already.ok && previous === null && !node.mutation) {
        // Produced outside this chain — the campaign was launched by
        // bench/campaign.sh and the vendors by hand — and the oracle binds
        // the output to the producer's current fingerprint itself, so the
        // ledger has nothing to add; re-running would repeat hours for
        // nothing and is exactly the "regenerate until it passes" this graph
        // exists to end.
        outcome = { status: 'REUSED', detail: `oracle holds; produced outside the chain: ${already.detail}` };
      } else if (already.ok && node.mutation) {
        outcome = { status: 'REUSED', detail: `already done and verified: ${already.detail}` };
      } else if (node.mutation && !ctx.rehearsal && !ctx.allowMutations) {
        outcome = { status: 'FAIL', detail: `${id} writes to the remote and --allow-mutations was not given` };
      } else {
        ctx.log(`▶ ${id}`);
        const ran = await withTimeout(impl.run(ctx), node.timeoutMs, id).catch((error) => fail(`run threw: ${String(error.message)}`));
        outcome = { status: ran.ok ? 'PASS' : 'FAIL', detail: ran.detail, fingerprint };
      }
      outcome.fingerprint = fingerprint;
    }
    const end = nowUtc();
    results.set(id, { ...outcome, start: started, end });
    ctx.ledger({ node: id, mode, attempt: (ctx.ledgerLast(id)?.attempt ?? 0) + 1, status: outcome.status, detail: outcome.detail, fingerprint: outcome.fingerprint ?? null, start: started, end, blockedBy: blockedBy.length > 0 ? blockedBy : undefined });
    ctx.log(`  ${outcome.status.padEnd(7)} ${id.padEnd(20)} ${outcome.detail.slice(0, 220)}`);
  }
  return { order: selected, results };
}

function summarise(ctx, { mode, order, results }) {
  const rows = order.map((id) => ({ id, ...results.get(id) }));
  const failed = rows.filter((row) => row.status === 'FAIL');
  const blocked = rows.filter((row) => row.status === 'BLOCKED');
  const report = {
    artifactKind: 'MIGRATION_CORE_CHAIN_REPORT',
    controlFlowTestOnly: ctx.rehearsal,
    scenario: ctx.scenario ?? null,
    mode,
    writtenAt: nowUtc(),
    repository: REPOSITORY,
    head: ctx.state.head,
    prHead: ctx.state.prHead,
    candidate: ctx.state.candidate,
    mergedHead: ctx.state.mergedHead ?? null,
    mergedSha: ctx.state.mergedSha ?? null,
    campaignId: readCampaign()?.campaignId ?? null,
    nodes: rows,
    failed: failed.map((row) => row.id),
    blocked: blocked.map((row) => row.id),
    ok: failed.length === 0 && blocked.length === 0,
  };
  writeFileSync(join(ctx.work, `chain-${mode}${ctx.scenario ? `-${ctx.scenario}` : ''}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function makeContext({ rehearsal, scenario = null, allowMutations = false, prNumber = PR_NUMBER, branch = BRANCH, workName = finalWorkName({ prNumber, branch }), recoveryRoot = RECOVERY_ROOT, prHead = null, pull = null }) {
  const work = join(recoveryRoot, 'chain', workName);
  const statePath = join(work, 'state.json');
  const cached = readJson(statePath);
  const identityChanged = cached !== null && (cached.prNumber !== prNumber || cached.branch !== branch);
  const localHead = git(['rev-parse', 'HEAD']);
  const state = { ...((identityChanged ? null : cached) ?? { head: localHead, prNumber, branch }) };
  // Older state used head for the qualified checkout. Migrate that saved value
  // before replacing the informational local head with a downstream checkout.
  state.candidate ??= state.head;
  state.prHead ??= (!identityChanged && cached !== null ? cached.head : prHead) ?? state.head;
  const cachedProblem = mergedCandidateProblem(state);
  if (cachedProblem !== null) throw new Error(cachedProblem);
  state.head = localHead;
  // Validate before deleting state, writing files, or walking any producer.
  if (pull !== null) {
    const problem = pullIdentityProblem({ state }, pull, { beforePush: true });
    if (problem !== null) throw new Error(problem);
    if (pull.merged !== true && localHead !== pull.head?.sha && !isAncestor(pull.head?.sha, localHead)) throw new Error('remote PR head is not an ancestor of local HEAD');
    if (pull.merged === true) {
      const verified = await verifyMergedCommit({ state, saveState: () => {} }, pull);
      if (!verified.ok) throw new Error(verified.detail);
    }
  }
  // A foreign state also invalidates its ledger and artifacts.
  if (identityChanged) rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'logs'), { recursive: true });
  const producers = await measureProducers();
  const ctx = {
    rehearsal,
    scenario,
    allowMutations,
    work,
    state,
    statePath,
    workflow: readWorkflow(),
    producerFingerprints: producers.fingerprints,
    receiptPath: join(work, 'receipt', 'ci-receipt.json'),
    dossierDir: join(work, 'dossier'),
    childPreload: [],
    childEnv: {},
    wait: rehearsal ? async () => {} : realWait,
    gh: null,
    dossierApi: null,
    nodeById: (id) => NODES.find((node) => node.id === id),
    saveState: () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`),
    log: (line) => process.stderr.write(`${line}\n`),
    ledgerPath: join(work, 'ledger.jsonl'),
    ledger(event) {
      appendFileSync(ctx.ledgerPath, `${JSON.stringify({ eventId: sha256(`${event.node}:${event.start}:${String(event.attempt)}`).slice(0, 16), utc: nowUtc(), repo: REPOSITORY, head: state.head, prHead: state.prHead, candidate: state.candidate, mergedHead: state.mergedHead ?? null, campaignId: readCampaign()?.campaignId ?? null, controlFlowTestOnly: rehearsal, ...event })}\n`);
    },
    ledgerLast(id) {
      if (!existsSync(ctx.ledgerPath)) return null;
      const lines = readFileSync(ctx.ledgerPath, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
      const mine = lines.filter((entry) => entry.node === id && entry.mode !== 'check');
      return mine.length === 0 ? null : mine[mine.length - 1];
    },
  };
  if (identityChanged) ctx.log(`Discarded cached chain state: PR/branch ${String(cached.prNumber)}/${String(cached.branch)} differs from ${String(prNumber)}/${branch}; starting fresh`);
  ctx.saveState();
  return ctx;
}

async function attachRemote(ctx) {
  const token = ctx.rehearsal ? 'CONTROL_FLOW_TEST_ONLY' : githubToken();
  ctx.gh = github(token);
  ctx.dossierApi = async (path, accept = 'application/vnd.github+json') => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'kauro-mc3-chain', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GET ${path} returned ${String(response.status)}`);
    return response;
  };
}

// --------------------------------------------------------------- rehearsal

async function prepareRehearsal(scenario) {
  const work = join(RECOVERY_ROOT, 'chain', `rehearsal-${scenario}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'receipt'), { recursive: true });
  const head = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (git(['status', '--porcelain', '-uall']) !== '') throw new Error('a rehearsal needs a clean tree: it emits a receipt and builds a dossier over the checkout');
  const workflow = readWorkflow();
  const legs = requiredJobLegs(workflow).map((leg) => ({ name: leg.name, runsOn: leg.runsOn }));
  // The receipt CI would have emitted for this tree, emitted by the same tool
  // under CONTROL_FLOW_TEST_ONLY, and zipped as the artifact would be.
  const checkRuns = { total_count: legs.length, check_runs: legs.map((leg, index) => ({ id: 2000 + index, html_url: `https://github.com/${REPOSITORY}/runs/${String(2000 + index)}`, name: leg.name, status: 'completed', conclusion: 'success', head_sha: head, started_at: '2026-09-11T03:00:00Z', completed_at: '2026-09-11T03:10:00Z', app: { slug: 'github-actions' }, check_suite: { id: 500 } })) };
  writeFileSync(join(work, 'check-runs.json'), JSON.stringify(checkRuns));
  const needs = Object.fromEntries(requiredJobIds(workflow).map((id) => [id, { result: 'success' }]));
  const emitted = exec(process.execPath, ['tools/receipt-verify.mjs', '--emit', '--out', join(work, 'emitted', 'ci-receipt.json'), '--check-runs', join(work, 'check-runs.json')], {
    env: { GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: head, GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'push', GITHUB_WORKFLOW: 'core gate', GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_NUMBER: '1', RUNNER_OS: 'Linux', NEEDS_JSON: JSON.stringify(needs) },
    log: join(work, 'logs', 'emit-receipt.log'),
  });
  if (emitted.status !== 0) throw new Error(failureDetail(emitted, 'rehearsal receipt emission'));
  // Stand-in candidate records for this tree, marked. The manifest and code
  // digests are the real ones, measured; what a rehearsal cannot have is the
  // universe's and the preflight's verdicts, and these say they are stand-ins.
  const measured = measureTree();
  const stand = { controlFlowTestOnly: true, note: 'stand-in written by tools/chain.mjs --rehearse; not a candidate record' };
  mkdirSync(join(work, 'records'), { recursive: true });
  const write = (name, value) => writeFileSync(join(work, 'records', name), `${JSON.stringify(value, null, 2)}\n`);
  write('manifest.json', { ...stand, codeDigest: measured.codeDigest, manifestDigest: measured.manifestDigest });
  write('provenance.json', { ...stand, codeDigest: measured.codeDigest, manifestDigest: measured.manifestDigest });
  write('preflight.json', { ...stand, codeDigest: measured.codeDigest, MIGRATION_CORE_CANDIDATE_PREFLIGHT: 'TRUE', facts: {} });
  write('universe.json', { ...stand, candidate: { codeDigest: measured.codeDigest, manifestDigest: measured.manifestDigest }, passed: true, steps: [] });
  write('migration-core-provenance.json', { ...stand, coreVersion: versions.coreVersion, packageFormatVersion: versions.packageFormatVersion });
  const receiptBytes = readFileSync(join(work, 'emitted', 'ci-receipt.json'));
  const zip = zipSync({ 'ci-receipt.json': new Uint8Array(receiptBytes) });
  writeFileSync(join(work, 'receipt.zip'), Buffer.from(zip));
  const statePath = join(work, 'fake-github.json');
  const state = {
    controlFlowTestOnly: true,
    scenario,
    repository: REPOSITORY,
    branch: BRANCH,
    prNumber: PR_NUMBER,
    head,
    mergedSha: head,
    main: 'f'.repeat(40),
    tree,
    prMerged: false,
    runId: 4242,
    receiptZip: join(work, 'receipt.zip'),
    requiredChecks: legs.map((leg) => leg.name),
    legs,
    tags: scenario === 'tag-exists' ? { [TAG]: { name: TAG, commit: 'e'.repeat(40), message: 'an earlier tag', objectSha: 'd'.repeat(40) } } : {},
    releases: [],
    assets: {},
    calls: 0,
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { work, statePath, head };
}

// --------------------------------------------------------------------- cli

async function main() {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1] ?? null;
  };
  if (args.includes('--plan')) {
    const { order, problems } = validateGraph(NODES);
    process.stdout.write(`${JSON.stringify({ nodes: NODES.map((node) => ({ id: node.id, phase: node.phase, deps: node.deps, mutation: node.mutation === true, timeoutMin: Math.round(node.timeoutMs / MINUTE), rehearsalStandIn: node.rehearsal !== undefined })), order, problems, valid: problems.length === 0 }, null, 2)}\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (args.includes('--rehearse') || args.includes('--barrier')) {
    const identity = runIdentity();
    process.env.KAURO_PR = String(identity.prNumber);
    process.env.KAURO_BRANCH = identity.branch;
    const scenarios = args.includes('--barrier') ? ['ok', 'gate-fails', 'ci-red', 'tag-exists', 'mutable', 'merge-405'] : [valueOf('--scenario') ?? 'ok'];
    const outcomes = [];
    for (const scenario of scenarios) {
      const { work, statePath, head } = await prepareRehearsal(scenario);
      process.env.KAURO_CONTROL_FLOW_TEST_ONLY = '1';
      process.env.KAURO_FAKE_GITHUB_STATE = statePath;
      await import(pathToFileURL(join(here, 'rehearsal', 'fake-github.mjs')).href);
      const ctx = await makeContext({ rehearsal: true, scenario, workName: `rehearsal-${scenario}` });
      ctx.state.head = head;
      ctx.state.mergedSha = head;
      ctx.saveState();
      ctx.childPreload = ['--import', pathToFileURL(join(here, 'rehearsal', 'fake-github.mjs')).href];
      ctx.childEnv = { KAURO_CONTROL_FLOW_TEST_ONLY: '1', KAURO_FAKE_GITHUB_STATE: statePath, GH_TOKEN: 'CONTROL_FLOW_TEST_ONLY' };
      await attachRemote(ctx);
      await validateRunIdentity(ctx.gh, identity);
      ctx.log(`\nREHEARSAL ${scenario} (CONTROL_FLOW_TEST_ONLY) in ${work}`);
      const run = await walk(ctx, { mode: 'run' });
      const report = summarise(ctx, { mode: 'run', ...run });
      // The second, read-only walk over the same bytes: nothing re-run.
      const check = await walk(ctx, { mode: 'check' });
      const checkReport = summarise(ctx, { mode: 'check', ...check });
      const expectation = expectedRehearsal(scenario);
      const observed = { failed: report.failed, blocked: report.blocked, checkAgrees: JSON.stringify(checkReport.nodes.map((row) => [row.id, row.status === 'BLOCKED' ? 'BLOCKED' : row.status === 'PASS' ? 'PASS' : 'FAIL'])) === JSON.stringify(report.nodes.map((row) => [row.id, row.status === 'BLOCKED' ? 'BLOCKED' : row.status === 'FAIL' ? 'FAIL' : 'PASS'])) };
      const matches = JSON.stringify(observed.failed) === JSON.stringify(expectation.failed) && JSON.stringify(observed.blocked) === JSON.stringify(expectation.blocked) && observed.checkAgrees;
      outcomes.push({ scenario, matches, expected: expectation, observed, work });
      ctx.log(`REHEARSAL ${scenario}: ${matches ? 'as expected' : 'NOT as expected'} — failed ${JSON.stringify(observed.failed)} blocked ${JSON.stringify(observed.blocked)} check-walk agrees ${String(observed.checkAgrees)}`);
    }
    if (args.includes('--barrier')) {
      const selfTests = [
        ['LAUNCHER-STOPS-01', 'bash', ['bench/prepare-universe-selftest.sh']],
        ['EVIDENCE-RULES-01', process.execPath, ['tools/evidence-selftest.mjs']],
        ['RELEASE-DOSSIER-01', process.execPath, ['tools/release-dossier-selftest.mjs']],
        ['RELEASE-CANDIDATE-01 self-test', process.execPath, ['tools/release-candidate-gate.mjs', '--self-test']],
        ['seal-check', process.execPath, ['tools/seal-campaign.mjs', '--check']],
      ];
      const gates = selfTests.map(([label, command, commandArgs]) => {
        const result = exec(command, commandArgs, { timeoutMs: 15 * MINUTE });
        return { label, ok: result.status === 0, exit: result.status };
      });
      const plan = validateGraph(NODES);
      const ready = plan.problems.length === 0 && outcomes.every((entry) => entry.matches) && gates.every((entry) => entry.ok);
      const barrier = { artifactKind: 'MIGRATION_CORE_CHAIN_BARRIER', writtenAt: nowUtc(), head: git(['rev-parse', 'HEAD']), graphValid: plan.problems.length === 0, rehearsals: outcomes, selfTests: gates, READY_TO_EXECUTE_FINAL_CHAIN: ready };
      mkdirSync(join(RECOVERY_ROOT, 'chain'), { recursive: true });
      writeFileSync(join(RECOVERY_ROOT, 'chain', 'barrier.json'), `${JSON.stringify(barrier, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(barrier, null, 2)}\n`);
      process.stderr.write(`\nREADY_TO_EXECUTE_FINAL_CHAIN = ${ready ? 'TRUE' : 'FALSE'}\n`);
      process.exit(ready ? 0 : 1);
    }
    process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
    process.exit(outcomes.every((entry) => entry.matches) ? 0 : 1);
  }
  const mode = args.includes('--run') ? 'run' : args.includes('--check') ? 'check' : null;
  if (mode === null) {
    process.stderr.write('usage: node tools/chain.mjs (--plan | --check | --run [--until <id>] [--allow-mutations] | --rehearse [--scenario <name>] | --barrier)\n');
    process.exit(64);
  }
  const identity = runIdentity();
  const remote = { rehearsal: false };
  await attachRemote(remote);
  const pull = await validateRunIdentity(remote.gh, identity);
  const ctx = await makeContext({ rehearsal: false, allowMutations: args.includes('--allow-mutations'), ...identity, prHead: pull.head.sha, pull });
  ctx.gh = remote.gh;
  ctx.dossierApi = remote.dossierApi;
  ctx.childEnv = {};
  ctx.log(`\nCHAIN ${mode} in ${ctx.work}`);
  const walked = await walk(ctx, { mode, until: valueOf('--until') });
  const report = summarise(ctx, { mode, ...walked });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

function expectedRehearsal(scenario) {
  const after = (id) => {
    const { order } = validateGraph(NODES);
    const downstream = new Set();
    const queue = [id];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const node of NODES) if (node.deps.includes(current) && !downstream.has(node.id)) {
        downstream.add(node.id);
        queue.push(node.id);
      }
    }
    return order.filter((entry) => downstream.has(entry));
  };
  switch (scenario) {
    case 'gate-fails':
      return { failed: ['vendor-evidence'], blocked: after('vendor-evidence') };
    case 'ci-red':
      return { failed: ['pr-ci'], blocked: after('pr-ci') };
    case 'merge-405':
      return { failed: ['merge'], blocked: after('merge') };
    case 'tag-exists':
      return { failed: ['tag'], blocked: after('tag') };
    case 'mutable':
      return { failed: ['release-publish'], blocked: after('release-publish') };
    default:
      return { failed: [], blocked: [] };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error.stack ?? error.message)}\n`);
    process.exit(1);
  });
}

export { NODES };
