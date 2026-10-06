import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { command, requireCommand } from "../test-runner.mjs";
import { interruptedWorker, withCleanup } from './gate-process.mjs';

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../red-proof.mjs");
const file = "packages/cell/test/value.test.ts";

function fixture(expected = 2, baseSource = "export const value = 1;\n", baseFiles = {}) {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "kauro-red-test-")));
  const root = join(parent, "repo");
  const scratch = join(parent, "scratch");
  mkdirSync(root);
  mkdirSync(scratch);
  function put(path, contents) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  function git(...args) { return requireCommand("git", args, root).output.trim(); }
  put("package.json", JSON.stringify({ private: true, packageManager: "pnpm@10.16.1", type: "module" }));
  put("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n  packages/cell: {}\n");
  put(".gitignore", "node_modules/\ndist/\nred-proof.json\n");
  put("packages/cell/package.json", JSON.stringify({ name: "@proof/cell", type: "module", scripts: {
    build: "node build.mjs", test: 'node --test --test-concurrency=3 "dist/test/*.test.js"',
  } }));
  // Tiny compiler stand-in: these .ts inputs are valid JS. No dependencies or PostgreSQL are needed.
  put("packages/cell/build.mjs", `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const dir of ['src', 'test']) {
  mkdirSync('dist/' + dir, { recursive: true });
  for (const file of readdirSync(dir)) writeFileSync('dist/' + dir + '/' + file.replace(/\\.ts$/, '.js'), readFileSync(dir + '/' + file));
}
`);
  put("packages/cell/src/value.ts", baseSource);
  for (const [path, contents] of Object.entries(baseFiles)) put(path, contents);
  put("packages/cell/src/deleted.ts", "export const deleted = true;\n");
  put("packages/cell/src/old-name.ts", "export const renamed = true;\n");
  put("packages/persistence/migrations/0001.sql", "SELECT 1;\n");
  put(file, "import {test} from 'node:test'; test('old test', () => {});\n");
  git("init", "-q");
  git("config", "user.name", "Gate test");
  git("config", "user.email", "gate@example.invalid");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  put("packages/cell/src/value.ts", "export const value = 2;\n");
  put("packages/cell/src/added.ts", "export const added = true;\n");
  rmSync(join(root, "packages/cell/src/deleted.ts"));
  rmSync(join(root, "packages/cell/src/old-name.ts"));
  put("packages/cell/src/new-name.ts", "export const renamed = true;\n");
  put("packages/persistence/migrations/0001.sql", "SELECT 2;\n");
  put(file, `import assert from 'node:assert/strict'; import {test} from 'node:test'; import {existsSync} from 'node:fs';
import {value} from '../src/value.js';
test('head regression assertion', () => {
  assert.equal(value, ${expected}, 'head regression assertion');
  assert.equal(existsSync(new URL('../src/deleted.js', import.meta.url)), value === 1, 'deleted source must match the phase');
});
`);
  git("add", ".");
  git("commit", "-qm", "fix and regression test");
  const head = git("rev-parse", "HEAD");
  return { parent, root, scratch, base, head, git, put };
}

for (const [name, expected, verdict, failedWithoutFix, passedAtHead] of [
  ["a regression test fails without the fix and passes at head", 2, "PASS", true, true],
  ["a test that passes without the fix cannot prove red", 1, "FAIL", false, false],
  ["a test failing at head fails the gate", 3, "FAIL", true, false],
]) {
  test(name, () => {
    const f = fixture(expected);
    try {
      const result = command(process.execPath, [script, f.base, f.head, "--tests", file], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
      assert.equal(result.status, verdict === "PASS" ? 0 : 1, result.output);
      const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
      assert.equal(report.verdict, verdict, result.output);
      assert.equal(report.base, f.base);
      assert.equal(report.head, f.head);
      assert.equal(report.tests[0].file, file);
      assert.equal(report.tests[0].failedWithoutFix, failedWithoutFix);
      assert.equal(report.tests[0].passedAtHead, passedAtHead);
      assert.equal(report.errors.length, 0, report.errors.join("\n"));
      assert.deepEqual(report.revertedPaths, [
        "packages/cell/src/added.ts", "packages/cell/src/deleted.ts", "packages/cell/src/new-name.ts",
        "packages/cell/src/old-name.ts", "packages/cell/src/value.ts", "packages/persistence/migrations/0001.sql",
      ]);
      if (failedWithoutFix) assert.match(report.tests[0].firstFailingAssertion, /AssertionError.*head regression assertion/);
      assert.ok(report.tests[0].durations.withoutFixMs > 0);
      assert.ok(report.tests[0].durations.atHeadMs > 0);
      assert.deepEqual(readdirSync(f.scratch), [], "temporary copy and worktree must be removed");
      assert.equal(f.git("worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
      assert.equal(f.git("rev-parse", "HEAD"), f.head);
      assert.equal(f.git("status", "--porcelain"), "", "caller tree must remain unchanged");
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  });
}

test("every named test must fail red, including a test that is green in both phases", () => {
  const f = fixture();
  try {
    const green = "packages/cell/test/green.test.ts";
    f.put(green, "import {test} from 'node:test'; test('always green', () => {});\n");
    f.git("add", green);
    f.git("commit", "-qm", "green test");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.base, head, "--tests", `${file},${green}`, "--out", "proof.json"], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    assert.equal(result.status, 1, result.output);
    const report = JSON.parse(readFileSync(join(f.root, "proof.json"), "utf8"));
    assert.equal(report.verdict, "FAIL");
    assert.deepEqual(report.tests.map((row) => [row.failedWithoutFix, row.passedAtHead]), [[true, true], [false, true]]);
    assert.deepEqual(readdirSync(f.scratch), []);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test("invalid revision and missing test are usage errors; temporary files are cleaned", () => {
  const f = fixture();
  try {
    for (const args of [[], ["missing-revision", f.head, "--tests", file], [f.base, f.head, "--tests", "packages/cell/test/missing.test.ts"]]) {
      const result = command(process.execPath, [script, ...args], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
      assert.equal(result.status, 2, result.output);
      assert.deepEqual(readdirSync(f.scratch), []);
    }
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test("a build failure is not counted as a failing assertion and still cleans up", () => {
  const f = fixture();
  try {
    f.put("packages/cell/build.mjs", "throw new Error('broken build');\n");
    f.git("add", ".");
    f.git("commit", "-qm", "broken build");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.base, head, "--tests", file], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    assert.equal(result.status, 1, result.output);
    const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
    assert.equal(report.tests[0].failedWithoutFix, false);
    assert.equal(report.tests[0].passedAtHead, false);
    assert.match(report.errors.join("\n"), /broken build/);
    assert.deepEqual(readdirSync(f.scratch), []);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test("a test whose import only exists at head is INCONCLUSIVE, not red", () => {
  const f = fixture();
  try {
    const only = "packages/cell/test/export.test.ts";
    f.put("packages/cell/src/value.ts", "export const value = 2;\nexport const headOnly = 1;\n");
    f.put(only, "import assert from 'node:assert/strict'; import {test} from 'node:test'; import {headOnly} from '../src/value.js';\ntest('uses head export', () => assert.equal(headOnly, 1));\n");
    f.git("add", ".");
    f.git("commit", "-qm", "export only at head");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.base, head, "--tests", only], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    assert.equal(result.status, 2, result.output);
    const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
    assert.equal(report.verdict, "INCONCLUSIVE");
    assert.equal(report.tests[0].failedWithoutFix, false);
    assert.match(report.inconclusive.join("\n"), /failed to load/);
    assert.deepEqual(readdirSync(f.scratch), []);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test("a diff that touches no reverted path is refused with exit 2", () => {
  const f = fixture();
  try {
    f.put(file, "import {test} from 'node:test'; test('only a test changed', () => {});\n");
    f.git("add", ".");
    f.git("commit", "-qm", "test only");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.head, head, "--tests", file], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /nothing to revert/);
    assert.equal(JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8")).verdict, "INCONCLUSIVE");
    assert.deepEqual(readdirSync(f.scratch), []);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

const HEAD = "import assert from 'node:assert/strict'; import {test, describe, before} from 'node:test'; import {value} from '../src/value.js';\n";
for (const [name, baseSource, headSource, body, redNames] of [
  ['an existing base symbol throwing is not a function is RED',
    'export const value = 1; export const api = () => { const step = undefined; return step(); };', 'export const value = 2; export function api() {}',
    "import {api} from '../src/value.js'; test('existing API regression', () => api());", ['existing API regression']],
  ['an assertion mentioning ECONNREFUSED is RED',
    'export const value = 1;', 'export const value = 2;',
    "test('message regression', () => assert.equal(value, 2, 'ECONNREFUSED is the symptom under test'));", ['message regression']],
  ['a mixed missing-API file preserves its genuine RED test',
    'export const value = 1;', 'export const value = 2; export function headOnly() {}',
    "import * as api from '../src/value.js'; test('missing API', () => api.headOnly()); test('real regression', () => assert.equal(value, 2, 'GENUINE RED'));", ['real regression']],
]) {
  test(name, () => {
    const f = fixture(2, baseSource);
    try {
      f.put('packages/cell/src/value.ts', headSource);
      f.put(file, HEAD + body);
      f.git('add', '.'); f.git('commit', '-qm', name);
      const result = command(process.execPath, [script, f.base, f.git('rev-parse', 'HEAD'), '--tests', file], f.root, {env: {TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: '1'}});
      assert.equal(result.status, 0, result.output);
      const report = JSON.parse(readFileSync(join(f.root, 'red-proof.json'), 'utf8'));
      assert.equal(report.verdict, 'PASS');
      assert.equal(report.tests[0].failedWithoutFix, true);
      assert.deepEqual(report.tests[0].baseFailedNames, redNames);
      if (name.startsWith('a mixed')) assert.match(report.tests[0].firstFailingAssertion, /AssertionError.*GENUINE RED/);
      assert.deepEqual(readdirSync(f.scratch), []);
    } finally { rmSync(f.parent, {recursive: true, force: true}); }
  });
}
// ADV-18: decide by where the TypeError was thrown. A test-code frame means the API is absent (INCONCLUSIVE);
// a product frame is a genuine failure (RED).
const LEDGER_BASE = 'export const value = 1; export class Ledger { post() { return "posted"; } } export function makeLedger() { return new Ledger(); }';
const LEDGER_HEAD = 'export const value = 2; export class Ledger { post() { return "posted"; } cancel() { return "cancelled"; } } export function makeLedger() { return new Ledger(); }';
const RECURSIVE_BUILD = [
  "import {mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';",
  "function copy(from, to) { mkdirSync(to, {recursive: true}); for (const name of readdirSync(from)) { const source = from + '/' + name; if (statSync(source).isDirectory()) copy(source, to + '/' + name); else writeFileSync(to + '/' + name.replace(/\\.ts$/, '.js'), readFileSync(source)); } }",
  "for (const dir of ['src', 'test']) copy(dir, 'dist/' + dir);", ''].join('\n');
const NO_VALUE = (body) => HEAD.replace(/import \{value\}[^\n]*\n/, '') + body;
for (const [name, body, extra, reason] of [
  ['a method called on a new expression is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; test('cancel', () => assert.equal(new Ledger().cancel(), 'cancelled'));", {}, /\(intermediate value\)\.cancel is not a function/],
  ['a method called on a factory result is INCONCLUSIVE', "import {makeLedger} from '../src/value.js'; test('cancel', () => assert.equal(makeLedger().cancel(), 'cancelled'));", {}, /makeLedger\(\.\.\.\)\.cancel is not a function/],
  ['a missing method whose name occurs elsewhere in the base build is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; test('cancel', () => { const l = new Ledger(); assert.equal(l.cancel(), 'cancelled'); });", {base: LEDGER_BASE + ' // cancel settle close reverse\nexport const cancel = "cancel";'}, /cancel is not a function/],
  ['a computed missing method is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; test('cancel', () => { const l = new Ledger(); const k = 'cancel'; assert.equal(l[k](), 'cancelled'); });", {}, /is not a function/],
  ['a missing method called through a call result is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; const f = () => new Ledger(); test('cancel', () => assert.equal(f().cancel(), 'cancelled'));", {}, /is not a function/],
  ['a missing method called from a test helper file is INCONCLUSIVE', "import {run} from './helper.js'; test('cancel', () => assert.equal(run(), 'cancelled'));", {helper: "import {Ledger} from '../src/value.js'; export function run() { return new Ledger().cancel(); }\n"}, /is not a function/],
  ['a missing method called from a test-support helper is INCONCLUSIVE', "import {run} from './test-support/helper.js'; test('cancel', () => assert.equal(run(), 'cancelled'));", {support: "import {Ledger} from '../../src/value.js'; export function run() { return new Ledger().cancel(); }\n"}, /is not a function/],
  ['a missing method called from a src/testing support helper is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; import {drive} from '../src/testing/drive.js'; test('cancel', () => assert.equal(drive(new Ledger(), 'cancel'), 'cancelled'));", {baseFiles: {'packages/cell/src/testing/drive.ts': 'export function drive(o, m) { return o[m](); }\n'}}, /o\[m\] is not a function/],
  ['a missing method called from a nested src/x/testing helper is INCONCLUSIVE', "import {Ledger} from '../src/value.js'; import {drive} from '../src/commerce/testing/faults/drive.js'; test('cancel', () => assert.equal(drive(new Ledger(), 'cancel'), 'cancelled'));", {baseFiles: {'packages/cell/src/commerce/testing/faults/drive.ts': 'export function drive(o, m) { return o[m](); }\n'}}, /o\[m\] is not a function/],
]) {
  test(name, () => {
    const f = fixture(2, extra.base ?? LEDGER_BASE, extra.baseFiles);
    try {
      f.put('packages/cell/src/value.ts', LEDGER_HEAD);
      if (extra.helper) f.put('packages/cell/test/helper.ts', extra.helper);
      if (extra.support) f.put('packages/cell/test/test-support/helper.ts', extra.support);
      if (extra.support || extra.baseFiles) f.put('packages/cell/build.mjs', RECURSIVE_BUILD);
      f.put(file, NO_VALUE(body));
      f.git('add', '.'); f.git('commit', '-qm', name);
      const result = command(process.execPath, [script, f.base, f.git('rev-parse', 'HEAD'), '--tests', file], f.root, {env: {TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: '1'}});
      assert.equal(result.status, 2, result.output);
      const report = JSON.parse(readFileSync(join(f.root, 'red-proof.json'), 'utf8'));
      assert.equal(report.verdict, 'INCONCLUSIVE');
      assert.equal(report.tests[0].failedWithoutFix, false);
      assert.match(report.inconclusive.join('\n'), reason);
    } finally { rmSync(f.parent, {recursive: true, force: true}); }
  });
}
test('a TypeError thrown inside product code stays RED even when called from a helper', () => {
  const f = fixture(2, 'export const value = 1; export class Ledger { post() { const hook = undefined; return hook(); } }');
  try {
    f.put('packages/cell/src/value.ts', 'export const value = 2; export class Ledger { post() { return "posted"; } }');
    f.put('packages/cell/test/helper.ts', "import {Ledger} from '../src/value.js'; export function run() { return new Ledger().post(); }\n");
    f.put(file, NO_VALUE("import {run} from './helper.js'; test('posts', () => assert.equal(run(), 'posted'));"));
    f.git('add', '.'); f.git('commit', '-qm', 'product-internal TypeError');
    const result = command(process.execPath, [script, f.base, f.git('rev-parse', 'HEAD'), '--tests', file], f.root, {env: {TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: '1'}});
    assert.equal(result.status, 0, result.output);
    const report = JSON.parse(readFileSync(join(f.root, 'red-proof.json'), 'utf8'));
    assert.equal(report.verdict, 'PASS');
    assert.deepEqual(report.tests[0].baseFailedNames, ['posts']);
    assert.match(report.tests[0].firstFailingAssertion, /hook is not a function/);
  } finally { rmSync(f.parent, {recursive: true, force: true}); }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']) {
  test(`interrupting red-proof gate with ${signal} kills its worker`, { skip: (signal === 'SIGKILL' ? process.platform !== 'win32' : process.platform !== 'linux') && (signal === 'SIGKILL' ? 'Windows job-object test; Linux signals are tested separately' : 'Linux signal test; Windows has its own gate-kill test') }, async () => {
    const f = fixture();
    const pidFile = join(f.parent, 'pid');
    await withCleanup(f.parent, async () => {
      f.put(file, HEAD + `import {writeFileSync} from 'node:fs'; test('hang', () => { writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + process.ppid); return new Promise(() => setInterval(() => {}, 1000)); });`);
      f.git('add', '.'); f.git('commit', '-qm', 'hung worker');
      await interruptedWorker(script, [f.base, f.git('rev-parse', 'HEAD'), '--tests', file], f.root, pidFile, signal, {TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: '1'});
      if (signal !== 'SIGKILL') assert.deepEqual(readdirSync(f.scratch), []);
    });
  });
}
test("red proof records the deciding body assertion ahead of a failing hook", () => {
  const f = fixture();
  try {
    f.put(file, HEAD + `describe('fixture with a broken hook', () => {
  before(() => { if (value === 1) assert.fail('HOOK DECOY'); });
  test('blocked by hook', () => {});
});
test('actual regression', () => assert.equal(value, 2, 'BODY REGRESSION'));
`);
    f.git("add", ".");
    f.git("commit", "-qm", "hook and assertion regression");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.base, head, "--tests", file], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    assert.equal(result.status, 0, result.output);
    const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
    assert.equal(report.verdict, "PASS");
    assert.deepEqual(report.tests[0].baseFailedNames, ["actual regression"]);
    assert.match(report.tests[0].firstFailingAssertion, /AssertionError.*BODY REGRESSION/);
    assert.doesNotMatch(report.tests[0].firstFailingAssertion, /HOOK DECOY/);
  } finally { rmSync(f.parent, { recursive: true, force: true }); }
});

test("a timed-out red-proof worker is dead before head runs and the gate returns", async () => {
  const f = fixture();
  const pidFile = join(f.parent, "worker-pid");
  let pid;
  let dead = false; // a confirmed-dead pid may be reused by the OS and must not be signalled again
  await withCleanup(f.parent, async () => { try {
    f.put(file, HEAD + `import {readFileSync, writeFileSync} from 'node:fs';
const pidFile = ${JSON.stringify(pidFile)};
test('hang at base', () => {
  if (value === 1) { writeFileSync(pidFile, String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'}, 'base worker must be dead at head');
});
`);
    f.git("add", ".");
    f.git("commit", "-qm", "hung regression");
    const head = f.git("rev-parse", "HEAD");
    const result = command(process.execPath, [script, f.base, head, "--tests", file, "--timeout-min", "0.03"], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
    pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `worker ${pid} survived red-proof`);
    dead = true;
    assert.equal(result.status, 2, result.output);
    const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
    assert.equal(report.tests[0].passedAtHead, true, result.output);
    assert.match(report.inconclusive.join("\n"), /timed out/);
    assert.deepEqual(readdirSync(f.scratch), []);
  } finally {
    if (pid && !dead) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
  } });
});

for (const [name, body, status, verdict, failedWithoutFix, passedAtHead, reason, expectedPaths] of [
  ["a before() hook failing at base is INCONCLUSIVE, not red",
    "before(() => { if (value === 1) throw new Error('fixture unavailable'); });\ntest('regression', () => {});\n", 2, "INCONCLUSIVE", false, true, /hook failed/],
  ["a reverted run that executes no test is INCONCLUSIVE, not FAIL",
    "if (value === 2) test('regression', () => {});\n", 2, "INCONCLUSIVE", false, true, /no test executed/],
  ["an all-skipped head run is not green",
    "test('regression', {skip: value === 2}, () => assert.equal(value, 2));\n", 1, "FAIL", true, false],
  ["a todo-only head run is not green",
    "test('regression', {todo: value === 2}, () => assert.equal(value, 2));\n", 1, "FAIL", true, false],
  ["a describe-only head run (no leaf test) is not green",
    "describe('suite', () => { if (value === 1) test('regression', () => assert.equal(value, 2)); });\n", 1, "FAIL", true, false],
  ["a top-level throw after registration at head is not green",
    "test('regression', () => assert.equal(value, 2));\nif (value === 2) throw new Error('top-level failure');\n", 1, "FAIL", true, false],
  ["a top-level throw at base is INCONCLUSIVE, not red",
    "test('regression', () => {});\nif (value === 1) throw new Error('top-level failure');\n", 2, "INCONCLUSIVE", false, true, /failed to load or threw/],
  ["a different test passing at head does not recover the test that failed at base",
    "test(value === 1 ? 'regression' : 'renamed', () => assert.equal(value, 2));\n", 1, "FAIL", true, false],
  ["a same-named test in another suite cannot recover a skipped regression",
    "describe('outer', () => { describe('regression suite', () => { test('same name', {skip: value === 2}, () => assert.equal(value, 2)); }); describe('unrelated suite', () => { test('same name', () => {}); }); });\n", 1, "FAIL", true, false, undefined, [[file, "outer", "regression suite", "same name"]]],
  ["a nested regression recovers at its full path despite a same-named sibling",
    "describe('outer', () => { describe('regression suite', () => { test('same name', () => assert.equal(value, 2)); }); describe('unrelated suite', () => { test('same name', () => {}); }); });\n", 0, "PASS", true, true, undefined, [[file, "outer", "regression suite", "same name"]]],
  ["a passing same-named twin cannot recover a skipped regression in the same suite",
    "describe('outer', () => { test('same name', {skip: value === 2}, () => assert.equal(value, 2)); test('same name', () => {}); });\n", 1, "FAIL", true, false, undefined, [[file, "outer", ["same name", 1]]]],
  ["same-named twins recover at their own ordinals when both pass at head",
    "describe('outer', () => { test('same name', () => assert.equal(value, 2)); test('same name', () => {}); });\n", 0, "PASS", true, true, undefined, [[file, "outer", ["same name", 1]]]],
  ["a passing twin under a duplicate suite name cannot recover a skipped regression",
    "describe('outer', () => { describe('same suite', () => { test('regression', {skip: value === 2}, () => assert.equal(value, 2)); }); describe('same suite', () => { test('regression', () => {}); }); });\n", 1, "FAIL", true, false, undefined, [[file, "outer", ["same suite", 1], "regression"]]],
  ["a missing function at base is INCONCLUSIVE, not red",
    "test('regression', () => { const api = value === 2 ? () => {} : undefined; api(); });\n", 2, "INCONCLUSIVE", false, true, /TypeError.*is not a function/],
  ["a missing constructor at base is INCONCLUSIVE, not red",
    "test('regression', () => { const Api = value === 2 ? class {} : undefined; new Api(); });\n", 2, "INCONCLUSIVE", false, true, /TypeError.*is not a constructor/],
  ["a body-level missing module at base is INCONCLUSIVE, not red",
    "test('regression', async () => { if (value === 1) await import('../src/missing.js'); });\n", 2, "INCONCLUSIVE", false, true, /ERR_MODULE_NOT_FOUND/],
  ["a body-level refused connection at base is INCONCLUSIVE, not red",
    "test('regression', () => { if (value === 1) throw Object.assign(new Error('required service unavailable'), {code: 'ECONNREFUSED'}); });\n", 2, "INCONCLUSIVE", false, true, /ECONNREFUSED/],
  ["a missing-module code only in the failure message is RED",
    "test('regression', () => { if (value === 1) throw new Error('ERR_MODULE_NOT_FOUND: required module unavailable'); });\n", 0, "PASS", true, true],
  ["a refused-connection code only in the failure message is RED",
    "test('regression', () => { if (value === 1) throw new Error('ECONNREFUSED: required service unavailable'); });\n", 0, "PASS", true, true],
]) {
  test(name, () => {
    const f = fixture();
    try {
      f.put(file, HEAD + body);
      f.git("add", ".");
      f.git("commit", "-qm", "scenario");
      const head = f.git("rev-parse", "HEAD");
      const result = command(process.execPath, [script, f.base, head, "--tests", file], f.root, { env: { TMPDIR: f.scratch, NODE_DISABLE_COMPILE_CACHE: "1" } });
      assert.equal(result.status, status, result.output);
      const report = JSON.parse(readFileSync(join(f.root, "red-proof.json"), "utf8"));
      assert.equal(report.verdict, verdict, result.output);
      assert.equal(report.tests[0].failedWithoutFix, failedWithoutFix, result.output);
      if (status !== 2) assert.equal(report.tests[0].passedAtHead, passedAtHead, result.output);
      if (expectedPaths) assert.deepEqual(report.tests[0].baseFailedPaths, expectedPaths);
      if (reason) assert.match(report.inconclusive.join("\n"), reason);
      assert.deepEqual(readdirSync(f.scratch), []);
    } finally { rmSync(f.parent, { recursive: true, force: true }); }
  });
}
