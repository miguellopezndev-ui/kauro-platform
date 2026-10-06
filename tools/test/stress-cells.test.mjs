import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command } from "../test-runner.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../stress-cells.mjs");
function fixture(contents) {
  const root = mkdtempSync(join(tmpdir(), "kauro-stress-test-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: 'node --test --test-reporter=spec --test-concurrency=3 "dist/test/**/*.test.js"' } }));
  writeFileSync(join(root, "fake.test.mjs"), contents);
  return root;
}

test("a passing file runs N times with CI concurrency, and an override is recorded", () => {
  const root = fixture("import {test} from 'node:test'; test('green', () => {});\n");
  try {
    for (const [args, count, concurrency] of [[[], 20, 3], [["4", "--concurrency", "1"], 4, 1]]) {
      const result = command(process.execPath, [script, "fake.test.mjs", ...args], root);
      assert.equal(result.status, 0, result.output);
      const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
      assert.equal(report.verdict, "PASS");
      assert.equal(report.iterations, count);
      assert.equal(report.concurrency, concurrency);
      assert.equal(report.results.length, count);
      assert.ok(report.results.every((row) => row.passed && row.firstFailingAssertion === null && row.durationMs > 0));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a file that fails one time in three records each failure and exits 1", () => {
  const root = fixture(`import assert from 'node:assert/strict'; import {test} from 'node:test';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
const counter = new URL('./counter', import.meta.url);
const n = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;
writeFileSync(counter, String(n));
test('deterministic third iteration', () => assert.notEqual(n % 3, 0, 'every third run fails'));
`);
  try {
    const result = command(process.execPath, [script, "fake.test.mjs", "6"], root);
    assert.equal(result.status, 1, result.output);
    const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.equal(report.concurrency, 3);
    assert.deepEqual(report.results.map((row) => row.passed), [true, true, false, true, true, false]);
    for (const row of report.results.filter((row) => !row.passed)) {
      assert.match(row.firstFailingAssertion, /AssertionError.*every third run fails/);
      assert.equal(row.exitCode, 1);
    }
    assert.equal(readFileSync(join(root, "counter"), "utf8"), "6");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid iteration/concurrency arguments and missing files exit 2", () => {
  const root = fixture("import {test} from 'node:test'; test('green', () => {});\n");
  try {
    for (const args of [[], ["missing.test.mjs"], ["fake.test.mjs", "0"], ["fake.test.mjs", "2.5"], ["fake.test.mjs", "--concurrency", "0"], ["fake.test.mjs", "--unknown"]]) {
      const result = command(process.execPath, [script, ...args], root);
      assert.equal(result.status, 2, result.output);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zero tests or all-skipped tests is a FAIL, never a pass", () => {
  for (const contents of ["// no tests at all\n", "import {test} from 'node:test'; test('skipped', {skip: true}, () => {});\n"]) {
    const root = fixture(contents);
    try {
      const result = command(process.execPath, [script, "fake.test.mjs", "2"], root);
      assert.equal(result.status, 1, result.output);
      const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.ok(report.results.every((row) => !row.passed && /no tests ran/.test(row.firstFailingAssertion)), JSON.stringify(report.results));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("todo-only, suite-only, hook-failing and top-level-throwing files are a FAIL", () => {
  for (const contents of [
    "import {test} from 'node:test'; test('todo', {todo: true}, () => {});\n",
    "import {describe} from 'node:test'; describe('empty suite', () => {});\n",
    "import {describe, test} from 'node:test'; describe('only todo and skip', () => { test('t', {todo: true}, () => {}); test('s', {skip: true}, () => {}); });\n",
    "import {before, test} from 'node:test'; before(() => { throw new Error('hook'); }); test('green', () => {});\n",
    "import {test} from 'node:test'; test('green', () => {}); throw new Error('top-level failure');\n",
  ]) {
    const root = fixture(contents);
    try {
      const result = command(process.execPath, [script, "fake.test.mjs", "2"], root);
      assert.equal(result.status, 1, result.output);
      const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.ok(report.results.every((row) => !row.passed), JSON.stringify(report.results));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a green file with a skipped and a todo sibling still passes", () => {
  const root = fixture("import {describe, test} from 'node:test'; describe('s', () => { test('t', () => {}); test('x', {skip: true}, () => {}); test('y', {todo: true}, () => {}); });\n");
  try {
    const result = command(process.execPath, [script, "fake.test.mjs", "2"], root);
    assert.equal(result.status, 0, result.output);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const option of ["skip", "todo"]) {
  test(`a parent test with only a ${option} subtest is not an executed leaf`, () => {
    const root = fixture(`import {test} from 'node:test'; test('parent', async (t) => { await t.test('child', {${option}: true}, () => {}); });\n`);
    try {
      const result = command(process.execPath, [script, "fake.test.mjs", "1"], root);
      assert.equal(result.status, 1, result.output);
      const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
      assert.equal(report.verdict, "FAIL");
      assert.equal(report.results[0].tests, 0);
      assert.match(report.results[0].reason, /no tests ran/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("a hung iteration is killed by --timeout-min and fails with the reason", () => {
  const root = fixture("import {test} from 'node:test'; test('hang', () => new Promise(() => setInterval(() => {}, 1000)));\n");
  try {
    const result = command(process.execPath, [script, "fake.test.mjs", "1", "--timeout-min", "0.03"], root);
    assert.equal(result.status, 1, result.output);
    const report = JSON.parse(readFileSync(join(root, "stress-cells.json"), "utf8"));
    assert.equal(report.results[0].passed, false);
    assert.match(report.results[0].reason, /timed out/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a timed-out stress worker is dead before the next iteration and return", () => {
  const root = fixture(`import {test} from 'node:test'; import {appendFileSync, readFileSync, existsSync} from 'node:fs';
const path = new URL('./worker-pids', import.meta.url);
if (existsSync(path)) for (const pid of readFileSync(path, 'utf8').trim().split('\\n').map(Number)) {
  try { process.kill(pid, 0); appendFileSync(new URL('./overlap', import.meta.url), 'alive'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
test('hang', () => { appendFileSync(path, process.pid + '\\n'); return new Promise(() => setInterval(() => {}, 1000)); });
`);
  let pids = [];
  try {
    const result = command(process.execPath, [script, "fake.test.mjs", "2", "--timeout-min", "0.03"], root);
    assert.equal(result.status, 1, result.output);
    pids = readFileSync(join(root, "worker-pids"), "utf8").trim().split("\n").map(Number);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `worker ${pid} survived the timeout`);
    assert.throws(() => readFileSync(join(root, "overlap")), { code: "ENOENT" });
  } finally {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
    rmSync(root, { recursive: true, force: true });
  }
});
