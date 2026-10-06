import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { command } from '../test-runner.mjs';

for (const code of ['EPERM', 'ESRCH']) {
  test(`a ${code} killer cannot leave runTest waiting forever`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kauro-kill-failure-'));
    const runner = join(root, 'gate.mjs');
    const compiled = join(root, 'hung.test.mjs');
    writeFileSync(compiled, "import {test} from 'node:test'; test('blocked', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));");
    writeFileSync(runner, `import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs';
import {runTest} from ${JSON.stringify(new URL('../test-runner.mjs', import.meta.url).href)};
const realKill = process.kill;
process.kill = (pid) => { writeFileSync(${JSON.stringify(join(root, 'pid'))}, String(Math.abs(pid))); throw Object.assign(new Error('injected ${code} kill failure'), {code: '${code}'}); };
const watchdog = setTimeout(() => { process.kill = realKill; process.exit(97); }, 3000);
const result = await runTest({compiled: ${JSON.stringify(compiled)}, dir: ${JSON.stringify(root)}}, undefined, {
  timeoutMs: 500, postKillWaitMs: 100,
  ...(process.platform === 'win32' ? {killer(pid) { process.kill(pid); }} : {})
});
process.kill = realKill;
clearTimeout(watchdog);
assert.equal(result.status, null);
assert.equal(result.timedOut, true);
assert.match(result.killFailure, /${code}.*did not close/);
assert.ok(result.durationMs < 2000);
console.log(result.killFailure);
`);
    let pid;
    try {
      const result = command(process.execPath, [runner], root);
      pid = Number(readFileSync(join(root, 'pid'), 'utf8'));
      assert.equal(result.status, 0, result.output);
      assert.match(result.output, new RegExp(code));
    } finally {
      if (pid) {
        if (process.platform === 'win32') command('taskkill', ['/PID', String(pid), '/T', '/F'], root);
        else { try { process.kill(-pid, 'SIGKILL'); } catch { /* already terminated */ } }
      }
      rmSync(root, {recursive: true, force: true});
    }
  });
}
