import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { interruptedWorker, withCleanup } from './gate-process.mjs';

test('cleanup failure never replaces the primary assertion error', async () => {
  const primary = new Error('worker survived');
  const remove = () => { throw Object.assign(new Error('EPERM during cleanup'), { code: 'EPERM' }); };
  await assert.rejects(withCleanup('x', async () => { throw primary; }, remove), (error) => error === primary);
});

test('cleanup failure is reported when the body succeeded, and removal is retried', async () => {
  const calls = [];
  await withCleanup('dir', async () => {}, (path, options) => { calls.push([path, options]); });
  assert.deepEqual(calls, [['dir', { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }]]);
  await assert.rejects(withCleanup('x', async () => {}, () => { throw new Error('EPERM during cleanup'); }), /EPERM during cleanup/);
});

test('the gate helper waits for the runner (ppid) as well as the worker, and fails if the runner survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-gate-helper-'));
  const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
  // The "gate" writes "<worker pid> <runner pid>"; the runner is a detached process that outlives the gate.
  writeFileSync(join(root, 'gate.mjs'), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
process.on('SIGTERM', () => process.exit(143));
const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
runner.unref();
writeFileSync('pid', process.pid + ' ' + runner.pid);
setInterval(() => {}, 1000);
`);
  let runnerPid;
  try {
    const failure = await interruptedWorker(join(root, 'gate.mjs'), [], root, join(root, 'pid'), signal).then(() => null, (error) => error);
    runnerPid = Number((await import('node:fs')).readFileSync(join(root, 'pid'), 'utf8').split(' ')[1]);
    assert.ok(failure, 'a surviving runner must fail the helper');
    assert.match(failure.message, /survived/);
  } finally {
    if (runnerPid) { try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
