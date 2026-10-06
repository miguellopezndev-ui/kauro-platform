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
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(pidFile), 'hung worker must start before interrupting the gate');
    // The worker writes "<pid> <ppid>": its own pid and the node --test runner that spawned it.
    pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
    gate.kill(signal);
    const result = await Promise.race([closed, delay(5000).then(() => assert.fail('gate did not exit'))]);
    if (process.platform !== 'win32') assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    for (const pid of pids) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
        // A zombie has terminated and cannot execute against a removed checkout.
        if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) { alive = false; break; }
        await delay(25);
      }
      assert.equal(alive, false, `process ${pid} (worker or runner) survived ${signal} to the gate`);
    }
  } finally {
    gate.kill('SIGKILL');
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ } }
  }
}

// Remove a fixture tree after a gate test. Windows can hold the cwd handle briefly after the process is gone, so removal
// retries EPERM/EBUSY (bounded, about 2.75 s). A cleanup failure must never replace the test's own assertion error.
export async function withCleanup(root, body, remove = rmSync) {
  let failed = false;
  try { return await body(); } catch (error) { failed = true; throw error; } finally {
    try { remove(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch (cleanup) { if (!failed) throw cleanup; }
  }
}
