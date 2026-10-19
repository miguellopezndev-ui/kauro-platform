import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { removeTemp } from '../temp-removal.mjs';

export async function interruptedWorker(script, args, root, pidFile, signal, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const gate = spawn(process.execPath, [script, ...args], { cwd: root, env: childEnv, stdio: 'ignore' });
  const closed = new Promise((resolve) => gate.once('close', (code, signal) => resolve({ code, signal })));
  let pids = [];
  const confirmed = new Set(); // ids observed dead: the OS may reuse them, so cleanup must never signal them again
  try {
    const deadline = Date.now() + 20_000;
    // The worker writes "<pid> <ppid>": its own pid and the node --test runner that spawned it. The file exists before its bytes do
    // (writeFileSync creates, then writes), so wait for both ids: an early read skipped the runner (main 23307af, ubuntu).
    const ready = () => existsSync(pidFile) && /^\d+\s+\d+\s*$/.test(readFileSync(pidFile, 'utf8'));
    while (!ready() && Date.now() < deadline) await delay(25);
    assert.ok(ready(), 'hung worker must start and write both ids before interrupting the gate');
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

// Remove a fixture tree after a gate test. A cleanup failure must never replace the test's own assertion error. A Windows hold is
// retried only as removeTemp allows (an established fact, bounded, printed); it replaced a blind retry of every EPERM/EBUSY/ENOTEMPTY.
export async function withCleanup(root, body, remove = rmSync, options) {
  let failed = false;
  try { return await body(); } catch (error) { failed = true; throw error; } finally {
    try { removeTemp(root, () => remove(root, { recursive: true, force: true }), options); } catch (cleanup) { if (!failed) throw cleanup; }
  }
}

// Run a fixture test, then remove its tree, retrying only as removeTemp allows. A removal failure never replaces the test's own
// error (a try/finally rmSync did: on main 9dd3a3b3, windows, red-proof's "deciding body assertion" test failed after 1.7 s, well
// short of a full gate run, and only the cleanup EPERM was reported). After a passing body, a tree that still cannot be removed
// fails the test with what was left, since something still holds it.
export async function removeAfter(root, body, remove = rmSync, options) {
  let failed = false;
  try { return await body(); } catch (error) { failed = true; throw error; } finally {
    try { removeTemp(root, () => remove(root, { recursive: true, force: true }), options); } catch (cleanup) {
      // removeTemp's own failure already lists what is left
      const report = `${cleanup.code ?? cleanup.name}: ${cleanup.message}${cleanup.left ? '' : `; left: ${leftovers(root).join(', ') || '(none listed)'}`}`;
      if (!failed) throw new Error(`fixture removal failed after a passing test: ${report}`, { cause: cleanup });
      console.error(`fixture removal also failed (the test's own error is reported): ${report}`);
    }
  }
}

function leftovers(root, limit = 20) {
  const left = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (left.length >= limit) return;
      const path = join(dir, name);
      left.push(relative(root, path) || path);
      walk(path);
    }
  };
  walk(root);
  return left;
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

// A zombie has terminated and cannot execute against a removed checkout; a pid whose /proc entry vanished after the
// liveness probe has exited. Only Linux consults /proc.
export function hasTerminated(pid, platform = process.platform, read = (path) => readFileSync(path, 'utf8')) {
  if (platform !== 'linux') return false;
  try { return /\) Z /.test(read(`/proc/${pid}/stat`)); } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
