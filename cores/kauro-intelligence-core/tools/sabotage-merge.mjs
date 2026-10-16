#!/usr/bin/env node
/**
 * Merge the n shard reports of `tools/sabotage.mjs --shard k/n` into the one
 * QUALIFICATION report, or refuse. See tools/lib/sabotage-shards.mjs for what
 * is checked; the merged report is then verified by the unchanged
 * verifySabotageReport against this checkout, and, when --expect-commit is
 * given (CI passes $GITHUB_SHA), against that commit too.
 *
 *   node tools/sabotage-merge.mjs --shards <n> --dir <dir with the shard reports>
 *        [--out tmp/sabotage-report.json] [--expect-commit <sha>]
 *
 * Every *.json under --dir (recursively) is read as a shard report; a file
 * that is not one is a refusal, not something to skip. A stale --out is
 * removed first, so a refusal never leaves an old report behind.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentContext, verifySabotageReport } from './lib/verify-sabotage-report.mjs';
import { mergeShardReports } from './lib/sabotage-shards.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opts = { shards: null, dir: null, out: join(root, 'tmp', 'sabotage-report.json'), expectCommit: null };
const flags = { '--shards': 'shards', '--dir': 'dir', '--out': 'out', '--expect-commit': 'expectCommit' };
for (let i = 0; i < args.length; i += 2) {
  const key = flags[args[i]];
  if (key === undefined || args[i + 1] === undefined) {
    process.stderr.write(`unknown or incomplete argument ${String(args[i])}; usage: sabotage-merge.mjs --shards <n> --dir <dir> [--out <path>] [--expect-commit <sha>]\n`);
    process.exit(2);
  }
  opts[key] = args[i + 1];
}
if (opts.dir === null || !/^[1-9][0-9]{0,2}$/u.test(String(opts.shards))) {
  process.stderr.write('--shards <positive integer> and --dir <directory> are required\n');
  process.exit(2);
}
const count = Number(opts.shards);
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith('.json')) files.push(path);
  }
};
walk(resolve(opts.dir));
const reports = [];
const problems = [];
for (const file of files) {
  try {
    reports.push(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    problems.push(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const outPath = resolve(opts.out);
rmSync(outPath, { force: true });
const current = await currentContext(root);
const merge = mergeShardReports(reports, count, current);
problems.push(...merge.problems);
let verdict = null;
if (merge.ok && problems.length === 0) {
  verdict = verifySabotageReport(merge.report, current);
  problems.push(...verdict.problems);
  if (opts.expectCommit !== null && merge.report.subject.commit !== opts.expectCommit) problems.push(`subject ${merge.report.subject.commit} is not the expected ${opts.expectCommit}`);
}
if (problems.length > 0) {
  process.stderr.write(`SABOTAGE MERGE REFUSED (${String(reports.length)} shard reports read, ${String(count)} expected):\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`);
  process.exit(1);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(merge.report, null, 2)}\n`);
process.stderr.write(`SABOTAGE MERGE OK: ${String(count)} shards, ${String(verdict.recomputed.killed)} killed of ${String(verdict.recomputed.inventory)}, written to ${outPath}\n`);
