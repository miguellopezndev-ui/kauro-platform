#!/usr/bin/env node
// Builds, then runs every compiled test file under dist/test with node:test,
// and prints one summary line. A test file that fails to load is a failure.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const build = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' });
if (build.status !== 0) {
  process.stderr.write(`build exited ${String(build.status)}\n`);
  process.exit(build.status ?? 1);
}
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith('.test.js')) files.push(path);
  }
};
walk(join(root, 'dist', 'test'));
if (files.length === 0) {
  process.stderr.write('no test files under dist/test\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit', cwd: root });
process.stdout.write(`\nTEST FILES ${String(files.length)} exit ${String(result.status)}\n`);
process.exit(result.status ?? 1);
