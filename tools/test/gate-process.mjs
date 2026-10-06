import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export async function interruptedWorker(script, args, root, pidFile, signal, env = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const gate = spawn(process.execPath, [script, ...args], { cwd: root, env: childEnv, stdio: 'ignore' });
  const closed = new Promise((resolve) => gate.once('close', (code, signal) => resolve({ code, signal })));
  let pid;
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await delay(25);
    assert.ok(existsSync(pidFile), 'hung worker must start before interrupting the gate');
    pid = Number(readFileSync(pidFile, 'utf8'));
    gate.kill(signal);
    const result = await Promise.race([closed, delay(5000).then(() => assert.fail('gate did not exit'))]);
    if (process.platform !== 'win32') assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal]);
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { alive = false; break; } throw error; }
      // A zombie has terminated and cannot execute against a removed checkout.
      if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) { alive = false; break; }
      await delay(25);
    }
    assert.equal(alive, false, `worker ${pid} survived ${signal} to the gate`);
  } finally {
    gate.kill('SIGKILL');
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already terminated */ } }
  }
}
