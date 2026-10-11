import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function interruptedWorker(script, args, root, pidFile, signal, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const gate = spawn(process.execPath, [script, ...args], { cwd: root, env: childEnv, stdio: 'ignore' });
  const closed = new Promise((resolve) => gate.once('close', (code, signal) => resolve({ code, signal })));
  let pids = [];
  const confirmed = new Set(); // ids observed dead: the OS may reuse them, so cleanup must never signal them again
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(pidFile), 'hung worker must start before interrupting the gate');
    // The worker writes "<pid> <ppid>": its own pid and the node --test runner that spawned it.
    pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    gate.kill(signal);
    const result = await Promise.race([closed, delay(5000).then(() => assert.fail('gate did not exit'))]);
    if (process.platform !== 'win32') assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    await assertDead(pids, `process (worker or runner)`, signal, confirmed, 100, " to the gate");
  } finally {
    gate.kill('SIGKILL');
    killUnconfirmed(pids, confirmed);
  }
}

// Remove a fixture tree after a gate test. Windows can hold the cwd handle briefly after the process is gone, so removal
// retries EPERM/EBUSY/ENOTEMPTY (bounded: ten retries, 50 ms longer each, about 2.75 s). Node 24's rmSync ignores maxRetries here,
// so the retry is done explicitly. A cleanup failure must never replace the test's own assertion error.
export async function withCleanup(root, body, remove = rmSync) {
  let failed = false;
  try { return await body(); } catch (error) { failed = true; throw error; } finally {
    try { await removeWithRetry(root, remove); } catch (cleanup) { if (!failed) throw cleanup; }
  }
}

// Wait until every pid is gone and record it in `confirmed`. A pid still alive after the bound fails with "survived".
export async function assertDead(pids, label, signal, confirmed, attempts = 100, suffix = '') {
  for (const pid of pids) {
    let alive = true;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
      if (hasTerminated(pid)) { alive = false; break; }
      await delay(25);
    }
    if (!alive) confirmed.add(pid);
    assert.equal(alive, false, `${label} ${pid} survived ${signal}${suffix}`);
  }
}

// Last-resort cleanup: signal only ids that were never confirmed dead.
export function killUnconfirmed(pids, confirmed, kill = process.kill) {
  for (const pid of pids) {
    if (confirmed.has(pid)) continue;
    try { kill(pid, 'SIGKILL'); } catch { /* already terminated */ }
  }
}

async function removeWithRetry(root, remove) {
  for (let retry = 0; ; retry++) {
    try { return remove(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (error) {
      if (retry >= 10 || !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(50 * (retry + 1));
    }
  }
}

// A zombie has terminated and cannot execute against a removed checkout; a pid whose /proc entry vanished after the
// liveness probe has exited. Only Linux consults /proc.
export function hasTerminated(pid, platform = process.platform, read = (path) => readFileSync(path, 'utf8')) {
  if (platform !== 'linux') return false;
  try { return /\) Z /.test(read(`/proc/${pid}/stat`)); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
