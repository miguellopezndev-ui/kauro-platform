#!/usr/bin/env node
/**
 * CI-LOCAL — runs, before any push, exactly the commands of the workflow's cheap jobs on the commit GitHub would test:
 * the merge of HEAD with origin/main, in a disposable clone, with the environment a workflow step sees.
 *
 *   node tools/ci-local.mjs                 HEAD merged with origin/main (fetches origin first)
 *   node tools/ci-local.mjs --no-merge      HEAD alone (the push leg on main)
 *   node tools/ci-local.mjs --keep          keep the clone for inspection
 *
 * The steps are read from .github/workflows/ci.yml, not copied: every `run:` of the jobs in CHEAP_JOBS, in order,
 * so this script and the workflow cannot drift. `uses:` steps are replaced by what they do here: the clone is the
 * checkout, and Node must be the version the workflow pins (24.x; 24.14.1 is what the owner measures with).
 * GITHUB_ACTIONS, GITHUB_SHA (the merge commit) and RUNNER_TEMP are set as on a runner, so a check that only
 * misbehaves under Actions misbehaves here too. Run it on Windows and in WSL Linux; push only when both pass.
 * The heavy jobs (sabotage shards, merge, architecture closure, receipt) are not run: see `--only` in
 * tools/sabotage.mjs for the mutations of the files you changed, and tools/sabotage-anchors.mjs.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHEAP_JOBS = ['gate', 'dependencies', 'sabotage-anchors', 'sabotage-selftest', 'architecture-selftest'];
const EXPECTED_NODE_MAJOR = 24;

/** The `run:` scripts of one job, in order, from the workflow text (two-space job ids, block scalars kept). */
export function jobRuns(yaml, jobId) {
  const lines = yaml.replace(/\r\n/gu, '\n').split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[i]) || /^\S/u.test(lines[i])) { end = i; break; }
  const runs = [];
  for (let i = start + 1; i < end; i += 1) {
    const match = /^(\s+)(?:- )?run:\s?(.*)$/u.exec(lines[i]);
    if (match === null) continue;
    if (match[2] !== '|' && match[2] !== '|-') { runs.push(match[2]); continue; }
    const body = [];
    let indent = null;
    for (let j = i + 1; j < end; j += 1) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      const lead = lines[j].length - lines[j].trimStart().length;
      if (indent === null) indent = lead;
      if (lead < indent) break;
      body.push(lines[j].slice(indent));
      i = j;
    }
    runs.push(body.join('\n').replace(/\n+$/u, ''));
  }
  return runs;
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const args = process.argv.slice(2);
  const known = new Set(['--no-merge', '--keep']);
  for (const arg of args) if (!known.has(arg)) { process.stderr.write(`unknown flag ${arg}\n`); process.exit(2); }
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== EXPECTED_NODE_MAJOR) { process.stderr.write(`Node ${process.versions.node}: the workflow runs Node ${String(EXPECTED_NODE_MAJOR)}\n`); process.exit(2); }
  const git = (cwd, gitArgs) => execFileSync('git', gitArgs, { cwd, encoding: 'utf8' }).trim();
  if (git(root, ['status', '--porcelain']) !== '') { process.stderr.write('the working tree is dirty: commit first; CI tests commits, not files\n'); process.exit(2); }
  const head = git(root, ['rev-parse', 'HEAD']);
  const work = mkdtempSync(join(tmpdir(), 'ic-ci-local-'));
  const clone = join(work, 'repo');
  const runnerTemp = join(work, 'runner-temp');
  mkdirSync(runnerTemp);
  let failed = null;
  const started = Date.now();
  try {
    git(root, ['clone', '-q', '--no-hardlinks', root, clone]);
    git(clone, ['checkout', '-q', head]);
    let subject = head;
    if (!args.includes('--no-merge')) {
      // Fetch when this host can (a WSL user may hold no GitHub credential); otherwise the last fetched origin/main.
      const fetched = spawnSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      if (fetched.status !== 0) process.stderr.write('ci-local: could not fetch origin; using the last fetched origin/main\n');
      const main = git(root, ['rev-parse', 'origin/main']);
      git(clone, ['fetch', '-q', root, main]);
      const merge = spawnSync('git', ['-c', 'user.name=ci-local', '-c', 'user.email=ci-local@localhost', 'merge', '-q', '--no-edit', main], { cwd: clone, encoding: 'utf8' });
      if (merge.status !== 0) throw new Error(`HEAD does not merge cleanly with origin/main ${main.slice(0, 12)}: ${merge.stdout}${merge.stderr}`);
      subject = git(clone, ['rev-parse', 'HEAD']);
      process.stderr.write(`ci-local: ${head.slice(0, 12)} merged with origin/main ${main.slice(0, 12)} = ${subject.slice(0, 12)}\n`);
    } else process.stderr.write(`ci-local: ${head.slice(0, 12)} (no merge)\n`);
    const yaml = readFileSync(join(clone, '.github', 'workflows', 'ci.yml'), 'utf8');
    const env = { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_SHA: subject, RUNNER_TEMP: runnerTemp, SABOTAGE_SHARDS: /SABOTAGE_SHARDS:\s*'?(\d+)/u.exec(yaml)?.[1] ?? '' };
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    for (const job of CHEAP_JOBS) {
      const runs = jobRuns(yaml, job);
      if (runs === null) throw new Error(`job ${job} is not in the workflow`);
      for (const script of runs) {
        const label = `${job}: ${script.split('\n')[0].slice(0, 90)}`;
        const t0 = Date.now();
        const result = spawnSync(bash, ['-e', '-c', script], { cwd: clone, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        const seconds = ((Date.now() - t0) / 1000).toFixed(0);
        if (result.status !== 0) {
          process.stderr.write(`  FAIL  ${label} (${seconds}s, exit ${String(result.status)})\n${(result.stdout + result.stderr).split('\n').slice(-40).join('\n')}\n`);
          failed = label;
          break;
        }
        process.stderr.write(`  ok    ${label} (${seconds}s)\n`);
      }
      if (failed !== null) break;
    }
  } catch (error) {
    failed = String(error.message);
    process.stderr.write(`  FAIL  ${failed}\n`);
  } finally {
    if (args.includes('--keep')) process.stderr.write(`clone kept at ${clone}\n`);
    else rmSync(work, { recursive: true, force: true });
  }
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  process.stderr.write(`CI-LOCAL = ${failed === null ? 'PASS' : 'FAIL'} (${process.platform}, Node ${process.versions.node}, ${minutes} min)\n`);
  process.exit(failed === null ? 0 : 1);
}
