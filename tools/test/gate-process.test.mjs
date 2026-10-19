import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDead, hasTerminated, interruptedWorker, killUnconfirmed, removeAfter, withCleanup } from './gate-process.mjs';

test('cleanup failure never replaces the primary assertion error', async () => {
  const primary = new Error('worker survived');
  const remove = () => { throw Object.assign(new Error('EPERM during cleanup'), { code: 'EPERM' }); };
  await assert.rejects(withCleanup('x', async () => { throw primary; }, remove), (error) => error === primary);
});

test('cleanup failure is reported when the body succeeded, and removal asks for no silent rmSync retries', async () => {
  const calls = [];
  await withCleanup('dir', async () => {}, (path, options) => { calls.push([path, options]); });
  assert.deepEqual(calls, [['dir', { recursive: true, force: true }]]);
  await assert.rejects(withCleanup('x', async () => {}, () => { throw new Error('EPERM during cleanup'); }), /EPERM during cleanup/);
});

test('the gate helper waits for the runner (ppid) as well as the worker, and fails if the runner survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-gate-helper-'));
  const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
  // The "gate" writes "<worker pid> <runner pid>"; the runner is a detached process that outlives the gate.
  writeFileSync(join(root, 'gate.mjs'), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
process.on('SIGTERM', () => process.exit(143));
const runner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore', cwd: process.argv[2]});
runner.unref();
writeFileSync('pid', process.pid + ' ' + runner.pid);
setInterval(() => {}, 1000);
`);
  let runnerPid;
  let failure;
  await withCleanup(root, async () => { try {
    failure = await interruptedWorker(join(root, 'gate.mjs'), [tmpdir()], root, join(root, 'pid'), signal).then(() => null, (error) => error);
    runnerPid = Number((await import('node:fs')).readFileSync(join(root, 'pid'), 'utf8').split(' ')[1]);
    assert.ok(failure, 'a surviving runner must fail the helper');
    assert.match(failure.message, /survived/);
  } finally {
    // Only a runner the helper reported as surviving is known alive; never signal an id that may have been reused.
    if (runnerPid && failure?.message.includes(`${runnerPid} survived`)) { try { process.kill(runnerPid, 'SIGKILL'); } catch { /* already gone */ } }
  } });
});

test('cleanup kills only ids that are not yet confirmed dead (the OS reuses pids)', () => {
  const killed = [];
  killUnconfirmed([11, 22, 33], new Set([11, 33]), (pid, signal) => killed.push([pid, signal]));
  assert.deepEqual(killed, [[22, 'SIGKILL']]);
});

test('assertDead confirms a dead pid and reports a live one as survived, even when cleanup then fails', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const confirmed = new Set();
  await assertDead([dead], 'worker', 'SIGKILL', confirmed);
  assert.deepEqual([...confirmed], [dead]);
  const live = new Set();
  const remove = () => { throw Object.assign(new Error('EPERM during cleanup'), { code: 'EPERM' }); };
  await assert.rejects(withCleanup('x', () => assertDead([process.pid], 'worker', 'SIGKILL', live, 2), remove), /worker \d+ survived SIGKILL/);
  assert.deepEqual([...live], []);
});

test('cleanup retries a Windows EPERM only on an established fact, printed, and never past a named holder (no blind retry)', async () => {
  const lines = [];
  const win32 = (holders) => ({ platform: 'win32', holders, sleep: () => {}, log: (line) => lines.push(line) });
  const eperm = () => Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' });
  const root = mkdtempSync(join(tmpdir(), 'kauro-with-cleanup-'));
  const file = join(root, 'left.txt');
  writeFileSync(file, 'x');
  // files remain and Restart Manager names no holder: only the entries found are removed, retried until that succeeds, and printed
  let calls = 0;
  let unlinks = 0;
  const asked = [];
  await withCleanup(root, async () => {}, () => { calls++; throw eperm(); },
    { ...win32((files) => { asked.push(files); return []; }), fs: { unlink: (path) => { if (++unlinks < 3) throw eperm(); unlinkSync(path); }, rmdir: rmdirSync } });
  assert.equal(calls, 1, 'the recursive removal is never repeated');
  assert.equal(unlinks, 3);
  assert.deepEqual(asked, [[file]], 'Restart Manager is asked once, about the files left');
  assert.equal(existsSync(root), false);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /: EPERM; Restart Manager names no holder of its 1 remaining files \(answered in \d+ ms\); retrying for at most 5000 ms$/);
  assert.match(lines[1], /: removed at retry 3, \d+ ms after the first failure$/);
  // a holder Restart Manager names is never retried, and the failure names it with what is left
  const held = mkdtempSync(join(tmpdir(), 'kauro-with-cleanup-'));
  writeFileSync(join(held, 'locked.txt'), 'x');
  let attempts = 0;
  try {
    await assert.rejects(withCleanup(held, async () => {}, () => { attempts++; throw eperm(); }, win32(() => ['4242 node.exe'])),
      (error) => error.message === 'EPERM, Permission denied; not retried: Restart Manager names 4242 node.exe as holding its remaining files; left: locked.txt');
    assert.equal(attempts, 1);
  } finally { unlinkSync(join(held, 'locked.txt')); rmdirSync(held); }
  let denied = 0;
  await assert.rejects(withCleanup('x', async () => {}, () => { denied++; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, win32(() => [])), /EACCES/);
  assert.equal(denied, 1, 'a non-transient error is not retried');
  assert.equal(lines.length, 2, 'nothing retried, nothing printed');
});

test('a pid that vanishes between the liveness probe and the /proc read counts as dead', () => {
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  assert.equal(hasTerminated(1, 'linux', enoent), true);
  assert.equal(hasTerminated(1, 'linux', () => '1 (node) Z 0'), true, 'zombie');
  assert.equal(hasTerminated(1, 'linux', () => '1 (node) S 0'), false);
  assert.equal(hasTerminated(1, 'win32', enoent), false, 'only Linux consults /proc');
  assert.throws(() => hasTerminated(1, 'linux', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }), /EACCES/);
});

test('removeAfter removes once, keeps a failing test error primary, and fails a passing test whose tree is held, naming the holder', async () => {
  const calls = [];
  await removeAfter('dir', () => 'body result', (path, options) => { calls.push([path, options]); });
  assert.deepEqual(calls, [['dir', { recursive: true, force: true }]], 'one removal, no retry options');
  const held = (path) => { calls.push(path); throw Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' }); };
  calls.length = 0;
  const primary = new Error('gate exited 1');
  await assert.rejects(removeAfter('x', () => { throw primary; }, held), (error) => error === primary);
  assert.deepEqual(calls, ['x'], 'not retried after a failing body either');
  const root = mkdtempSync(join(tmpdir(), 'kauro-remove-after-'));
  mkdirSync(join(root, 'repo'));
  writeFileSync(join(root, 'repo', 'red-proof.json'), '{}');
  calls.length = 0;
  await assert.rejects(removeAfter(root, () => {}, held, { platform: 'win32', holders: () => ['4242 node.exe'] }), (error) => error.message === `fixture removal failed after a passing test: EPERM: EPERM, Permission denied; not retried: Restart Manager names 4242 node.exe as holding its remaining files; left: repo, ${join('repo', 'red-proof.json')}` && error.cause.cause.code === 'EPERM');
  assert.deepEqual(calls, [root]);
  await removeAfter(root, () => {});
  assert.equal(existsSync(root), false);
});
