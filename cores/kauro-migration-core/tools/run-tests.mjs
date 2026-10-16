#!/usr/bin/env node
// Portable test runner. Collects compiled test files in a deterministic order
// and hands them to node:test, so the gate behaves identically on every
// platform without relying on shell globbing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const testRoot = join(repoRoot, 'dist', 'test');
const tmpDir = join(repoRoot, 'tmp');

if (!existsSync(testRoot)) {
  process.stderr.write('dist/test does not exist. Run "npm run build" first.\n');
  process.exit(1);
}

const args = process.argv.slice(2);
const filterIndex = args.indexOf('--filter');
const filter = filterIndex === -1 ? null : args[filterIndex + 1];
const coverage = args.includes('--coverage');

function collect(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collect(absolute));
    else if (entry.name.endsWith('.test.js')) found.push(absolute);
  }
  return found;
}

let files = collect(testRoot);
if (filter !== null && filter !== undefined) {
  files = files.filter((file) => relative(repoRoot, file).split(sep).join('/').includes(filter));
}

if (files.length === 0) {
  process.stderr.write(`no test files matched${filter === null ? '' : ` filter "${filter}"`}\n`);
  process.exit(1);
}

mkdirSync(tmpDir, { recursive: true });
const tapPath = join(tmpDir, 'test-results.tap');

const nodeArgs = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout'];
nodeArgs.push('--test-reporter=tap', `--test-reporter-destination=${tapPath}`);
if (coverage) {
  nodeArgs.push('--experimental-test-coverage');
  nodeArgs.push('--test-coverage-include=dist/src/**');
  nodeArgs.push('--test-coverage-exclude=dist/test/**');
}
nodeArgs.push(...files);

const result = spawnSync(process.execPath, nodeArgs, { cwd: repoRoot, stdio: 'inherit' });

if (existsSync(tapPath)) {
  const tap = readFileSync(tapPath, 'utf8');
  const read = (label) => {
    const match = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(tap);
    return match === null ? 0 : Number(match[1]);
  };
  process.stdout.write(
    `\nSUMMARY files=${files.length} tests=${read('tests')} pass=${read('pass')} fail=${read('fail')} skipped=${read('skipped')}\n`,
  );
}

if (result.error) {
  process.stderr.write(`${String(result.error.message)}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

