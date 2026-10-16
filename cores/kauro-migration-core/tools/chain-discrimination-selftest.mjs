#!/usr/bin/env node
// Run today's witnesses on actual historical implementations, in disposable
// checkouts. Only the witness files and a visibility-only export are overlaid.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoRoot } from './candidate-provenance.mjs';

const at = process.argv.indexOf('--out');
const out = at === -1 ? mkdtempSync(join(tmpdir(), 'kauro-chain-discrimination-')) : resolve(process.argv[at + 1]);
mkdirSync(out, { recursive: true });
const execute = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
const must = (command, args, options) => {
  const result = execute(command, args, options);
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout;
};
const idsFromLog = (log) => [...log.matchAll(/^  (?:ok   |FALSE) (\S+)$/gmu)].map((match) => match[1]);
const run = (root, name, report = false) => {
  const env = { ...process.env, KAURO_CHAIN_ROOT: join(out, `${name}-recovery`) };
  // Historical suites predate recoveryRoot, so even their ignored options
  // remain confined to this disposable directory.
  const args = ['tools/release-dossier-selftest.mjs', ...(report ? ['--report', join(out, `${name}.json`)] : [])];
  const result = execute(process.execPath, args, { cwd: root, env, timeout: 180_000 });
  writeFileSync(join(out, `${name}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  if (result.error || result.status === null) throw new Error(`${name}: ${result.error ?? result.signal}`);
  if (report && !existsSync(join(out, `${name}.json`))) throw new Error(`${name} did not reach the witness report`);
  return result;
};

const baseline = join(out, 'baseline-810889f');
const checkout = (revision, root) => {
  if (existsSync(root)) throw new Error(`refusing to overwrite ${root}`);
  must('git', ['clone', '--quiet', '--no-hardlinks', repoRoot, root]);
  must('git', ['checkout', '--quiet', '--detach', revision], { cwd: root });
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  // The repository's node_modules/ directory rule does not cover a symlink.
  writeFileSync(join(root, '.git/info/exclude'), 'node_modules\n');
  must('npm', ['run', 'build'], { cwd: root });
};
checkout('810889f', baseline);
const original = run(baseline, 'baseline-810889f');
const originalIds = new Set(idsFromLog(original.stdout));
if (originalIds.size === 0) throw new Error('baseline reported no cases');
const current = run(repoRoot, 'current', true);
const currentCases = JSON.parse(readFileSync(join(out, 'current.json'), 'utf8'));
const newCases = currentCases.filter((entry) => !originalIds.has(entry.id));
if (newCases.length === 0) throw new Error('no new witnesses were found');
const older = {};
for (const revision of ['8a1b5a1', '810889f']) {
  const root = join(out, `witness-${revision}`);
  checkout(revision, root);
  for (const path of ['tools/chain-identity-selftest.mjs', 'tools/release-dossier-selftest.mjs']) copyFileSync(join(repoRoot, path), join(root, path));
  const chainPath = join(root, 'tools/chain.mjs');
  const source = readFileSync(chainPath, 'utf8');
  if (!/export (?:async )?function makeContext/u.test(source)) writeFileSync(chainPath, `${source}\nexport { makeContext };\n`);
  run(root, revision, true);
  const cases = JSON.parse(readFileSync(join(out, `${revision}.json`), 'utf8'));
  older[revision] = new Map(cases.map((entry) => [entry.id, entry]));
}
const rows = newCases.map((entry) => ({ id: entry.id, current: entry.ok, ...Object.fromEntries(Object.entries(older).map(([revision, cases]) => {
  if (!cases.has(entry.id)) throw new Error(`${revision} did not report ${entry.id}`);
  return [revision, cases.get(entry.id).ok];
})) }));
const nonDiscriminating = rows.filter((entry) => entry['8a1b5a1'] || entry['810889f']);
const passed = current.status === 0 && rows.every((entry) => entry.current) && nonDiscriminating.length === 0;
writeFileSync(join(out, 'discrimination.json'), `${JSON.stringify({ passed, baselineCaseCount: originalIds.size, newCaseCount: rows.length, nonDiscriminating, rows }, null, 2)}\n`);
writeFileSync(join(out, 'discrimination.md'), `| New case | Current | 8a1b5a1 | 810889f |\n|---|---|---|---|\n${rows.map((entry) => `| ${entry.id} | ${entry.current ? 'PASS' : 'FAIL'} | ${entry['8a1b5a1'] ? 'PASS' : 'FAIL'} | ${entry['810889f'] ? 'PASS' : 'FAIL'} |`).join('\n')}\n`);
process.stdout.write(`${JSON.stringify({ passed, newCases: rows.length, nonDiscriminating: nonDiscriminating.map((entry) => entry.id), table: join(out, 'discrimination.md') }, null, 2)}\n`);
// Keep logs/reports, discard cloned repositories and their scratch state.
for (const name of ['baseline-810889f', 'witness-8a1b5a1', 'witness-810889f', 'baseline-810889f-recovery', 'current-recovery', '8a1b5a1-recovery', '810889f-recovery']) rmSync(join(out, name), { recursive: true, force: true });
process.exit(passed ? 0 : 1);
