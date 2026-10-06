import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { command, normalizePath, summarizeEvents, testTarget } from '../test-runner.mjs';

test('path normalisation decodes file URLs and percent-encoded paths before resolving Windows aliases', () => {
  const calls = [];
  const options = {platform: 'win32', realpath(path) {
    calls.push(path);
    return path.replace(/MIGUEL~1/i, 'Miguel Lopez');
  }};
  const expected = normalizePath('C:\\Users\\Miguel Lopez\\Temp\\value.test.js', options);
  assert.equal(normalizePath('file:///C:/Users/MIGUEL%7E1/Temp/value.test.js', options), expected);
  assert.equal(normalizePath('C:/Users/MIGUEL%7E1/Temp/value.test.js', options), expected);
  assert.deepEqual(calls, [
    'C:\\Users\\Miguel Lopez\\Temp\\value.test.js',
    'C:\\Users\\MIGUEL~1\\Temp\\value.test.js',
    'C:/Users/MIGUEL~1/Temp/value.test.js',
  ], 'both comparison sides must pass through realpath, after decoding');
});

test('Windows path normalisation reconciles slashes, dot segments and drive-letter case', () => {
  const options = {platform: 'win32', realpath(path) { return path; }};
  assert.equal(normalizePath('C:\\Temp\\tests\\..\\value.test.js', options), normalizePath('c:/temp/value.test.js', options));
  assert.notEqual(normalizePath('C:/temp/value.test.js', options), normalizePath('D:/temp/value.test.js', options));
});

test('missing paths use lexical normalisation and POSIX paths retain case', () => {
  const options = {platform: 'linux', realpath() { throw Object.assign(new Error('missing'), {code: 'ENOENT'}); }};
  assert.equal(normalizePath('file:///tmp/a%20b/../value.test.js', options), '/tmp/value.test.js');
  assert.notEqual(normalizePath('/tmp/Value.test.js', options), normalizePath('/tmp/value.test.js', options));
  assert.equal(normalizePath('/tmp/100%.test.js', options), '/tmp/100%.test.js');
  assert.equal(normalizePath('packages/cell/test/../test/value.test.ts', options), 'packages/cell/test/value.test.ts');
});

test('the default path normaliser resolves both filesystem paths and encoded file URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-normalise-'));
  const file = join(root, 'value test~.test.mjs');
  writeFileSync(file, '');
  try {
    const canonical = realpathSync.native(file);
    assert.equal(normalizePath(file), process.platform === 'win32' ? canonical.toLowerCase() : canonical);
    assert.equal(normalizePath(pathToFileURL(file).href.replaceAll('~', '%7E')), normalizePath(file));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

for (const kind of ['function', 'constructor']) {
  test(`an encoded file URL attributes a missing ${kind} to its test and preserves genuine red`, () => {
    const root = mkdtempSync(join(tmpdir(), 'kauro-frame-'));
    const compiled = join(root, 'value test~.test.mjs');
    const events = join(root, 'events.jsonl');
    writeFileSync(compiled, '');
    const frame = pathToFileURL(compiled).href.replaceAll('~', '%7E');
    try {
      writeFileSync(events, [
        {event: 'error', errorName: 'TypeError', errorFrame: `    at TestContext.<anonymous> (${frame}:2:76)`},
        {event: 'fail', kind: 'test', nesting: 0, name: 'missing API', failureType: 'testCodeFailure', message: `api is not a ${kind}`},
        {event: 'error', errorName: 'AssertionError', errorCode: 'ERR_ASSERTION', errorFrame: `    at TestContext.<anonymous> (${frame}:3:10)`},
        {event: 'fail', kind: 'test', nesting: 0, name: 'real regression', failureType: 'testCodeFailure', message: 'GENUINE RED'},
        {event: 'summary'},
      ].map((record) => JSON.stringify(record)).join('\n'));
      const summary = summarizeEvents(events, compiled, 'packages/cell/test/value.test.ts', {classifyMissingApi: true});
      assert.deepEqual(summary.inconclusiveFailures, [`TypeError: api is not a ${kind}`]);
      assert.deepEqual(summary.redFailedNames, ['real regression']);
      assert.deepEqual(summary.redFailedPaths, [['packages/cell/test/value.test.ts', 'real regression']]);
      assert.equal(summary.redAssertion, 'AssertionError [ERR_ASSERTION]: GENUINE RED');
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

test('an indirect missing-API error in another file remains RED', () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-frame-'));
  const compiled = join(root, 'value.test.mjs');
  const other = join(root, 'other', 'value.test.mjs');
  const events = join(root, 'events.jsonl');
  writeFileSync(compiled, '');
  try {
    writeFileSync(events, [
      {event: 'error', errorName: 'TypeError', errorFrame: `    at helper (${pathToFileURL(other).href}:2:76)`},
      {event: 'fail', kind: 'test', nesting: 0, name: 'existing runtime regression', failureType: 'testCodeFailure', message: 'api is not a function'},
    ].map((record) => JSON.stringify(record)).join('\n'));
    const summary = summarizeEvents(events, compiled, compiled, {classifyMissingApi: true});
    assert.deepEqual(summary.inconclusiveFailures, []);
    assert.deepEqual(summary.redFailedNames, ['existing runtime regression']);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('a missing-API TypeError is classified by the origin of its top frame, not by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-origin-'));
  const compiled = join(root, 'packages', 'cell', 'dist', 'test', 'value.test.js');
  mkdirSync(join(root, 'packages', 'cell', 'dist', 'test'), {recursive: true});
  writeFileSync(compiled, '');
  const events = join(root, 'events.jsonl');
  const at = (...parts) => `    at f (${pathToFileURL(join(root, ...parts)).href}:1:1)`;
  const cases = [
    ['test file', at('packages', 'cell', 'dist', 'test', 'value.test.js'), 'inconclusive'],
    ['helper under test/', at('packages', 'cell', 'dist', 'test', 'helper.js'), 'inconclusive'],
    ['test-support', at('packages', 'cell', 'dist', 'test', 'test-support', 'h.js'), 'inconclusive'],
    ['package dist src', at('packages', 'cell', 'dist', 'src', 'ledger.js'), 'red'],
    ['package src', at('packages', 'cell', 'src', 'ledger.js'), 'red'],
    ['src/testing', at('packages', 'cell', 'dist', 'src', 'testing', 'drive.js'), 'inconclusive'],
    ['nested src/commerce/testing/faults', at('packages', 'cell', 'dist', 'src', 'commerce', 'testing', 'faults', 'x.js'), 'inconclusive'],
    ['source src/testing', at('packages', 'cell', 'src', 'testing', 'drive.ts'), 'inconclusive'],
    ['app src', at('apps', 'api', 'dist', 'src', 'ledger.js'), 'red'],
    ['no frame', undefined, 'inconclusive'],
    ['native frame', '    at Array.map (<anonymous>)', 'inconclusive'],
  ];
  try {
    for (const message of ['(intermediate value).cancel is not a function', 'makeLedger(...).cancel is not a function', 'obj[k] is not a function', 'X is not a constructor']) {
      for (const [label, frame, expected] of cases) {
        writeFileSync(events, [{event: 'error', errorName: 'TypeError', errorFrame: frame},
          {event: 'fail', kind: 'test', nesting: 0, name: 't', failureType: 'testCodeFailure', message}].map((r) => JSON.stringify(r)).join('\n'));
        const summary = summarizeEvents(events, compiled, compiled, {classifyMissingApi: true});
        assert.equal(summary.inconclusiveFailures.length === 1, expected === 'inconclusive', label + ': ' + message);
        assert.equal(summary.redFailedNames.length === 1, expected === 'red', label + ': ' + message);
      }
    }
    writeFileSync(events, [{event: 'error', errorName: 'TypeError', errorFrame: at('packages', 'cell', 'dist', 'test', 'value.test.js')},
      {event: 'fail', kind: 'test', nesting: 0, name: 't', failureType: 'testCodeFailure', message: 'x is not a function'}].map((r) => JSON.stringify(r)).join('\n'));
    assert.equal(summarizeEvents(events, compiled, compiled).redFailedNames.length, 1, 'head runs never reclassify');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('file-level events and full test identities recognise encoded file URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-identity-'));
  const compiled = join(root, 'value test~.test.mjs');
  const events = join(root, 'events.jsonl');
  writeFileSync(compiled, '');
  const url = pathToFileURL(compiled).href.replaceAll('~', '%7E');
  try {
    writeFileSync(events, JSON.stringify({event: 'fail', kind: 'test', nesting: 0, name: url, failureType: 'testCodeFailure', message: 'top-level failure'}));
    const failed = summarizeEvents(events, compiled);
    assert.equal(failed.fileFailures, 1);
    assert.equal(failed.leafFailed, 0);
    assert.deepEqual(failed.redFailedPaths, []);

    writeFileSync(events, JSON.stringify({event: 'pass', kind: 'test', nesting: 0, name: 'green'}));
    assert.deepEqual(summarizeEvents(events, compiled, url).passedPaths, summarizeEvents(events, compiled, compiled).passedPaths);
    assert.deepEqual(summarizeEvents(events, compiled, 'packages/cell/test/../test/value.test.ts').passedPaths,
      [['packages/cell/test/value.test.ts', 'green']]);
    writeFileSync(events, JSON.stringify({event: 'pass', kind: 'test', nesting: 0, name: 'file://service/test title'}));
    assert.equal(summarizeEvents(events, compiled).leafPassed, 1, 'a test title need not be a valid local file URL');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('testTarget canonicalises repository and test paths without allowing a sibling prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'kauro-target-'));
  const compiled = join(root, 'value.test.mjs');
  const sibling = root + '-sibling';
  mkdirSync(sibling);
  writeFileSync(compiled, '');
  writeFileSync(join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
  writeFileSync(join(sibling, 'value.test.mjs'), '');
  try {
    const target = testTarget(root, compiled);
    assert.equal(target.dir, normalizePath(realpathSync.native(root)));
    assert.equal(target.compiled, normalizePath(realpathSync.native(compiled)));
    assert.equal(target.file, 'value.test.mjs');
    assert.throws(() => testTarget(root, join(sibling, 'value.test.mjs')), /must exist inside the repository/);
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(sibling, {recursive: true, force: true});
  }
});

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
