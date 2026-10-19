// Shared single-file Node test execution and workspace dependency ordering for the builder gates.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { removeTemp } from "./temp-removal.mjs";
import testEvents from "./test-events-reporter.mjs";

const REPORTER = import.meta.url;
const runners = new Set();
const captures = new Set();

// Compare filesystem identities, including Node's URL stack locations and Windows TEMP aliases.
// Keep repository-relative test identities relative; only absolute paths have a filesystem identity.
export function normalizePath(file, { platform = process.platform, realpath = realpathSync.native } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  let path;
  if (/^file:\/\//i.test(file)) path = fileURLToPath(file, { windows: platform === 'win32' });
  else {
    try { path = decodeURIComponent(file); } catch { path = file; } // A literal or incomplete '%' is valid in a filename.
  }
  if (paths.isAbsolute(path)) {
    try { path = realpath(path); } catch { /* A not-yet-emitted or unavailable file still needs lexical normalisation. */ }
  }
  path = paths.normalize(path);
  return platform === 'win32' ? path.toLowerCase() : path;
}

// Where was the error thrown? 'test': the test file, or a file under a test/, tests/, __tests__/, test-support/, test-utils/ or testing/ directory (including src/testing).
// 'product': under src/ (packages/*/src, apps/*/src, or their dist equivalents). 'unlocated': the frame has no file location.
// 'other': anything else (node_modules, unrelated paths). The nearest path segment decides, so dist/test/x.js is test code
// and dist/src/x.js is product code.
const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'test-support', 'test-utils', 'testing']);
export function frameOrigin(frame, file) {
  const location = /\((.+):\d+:\d+\)$/.exec(frame ?? '') ?? /^\s*at (.+):\d+:\d+$/.exec(frame ?? '');
  if (!location) return 'unlocated';
  let path;
  try { path = normalizePath(location[1]); } catch { return 'unlocated'; }
  if (path === file) return 'test';
  const segments = path.split(/[\\/]/).slice(0, -1);
  for (let index = segments.length - 1; index >= 0; index--) {
    if (segments[index] === 'node_modules') return 'other';
    if (TEST_SEGMENTS.has(segments[index])) return 'test';
    if (segments[index] === 'src') return 'product';
  }
  return 'other';
}

// Kills the runner's tree and returns the pids it terminated. On Windows taskkill /T prints one line per terminated process
// (leaves first, the runner last); its text is localised, so only the first number of each line, the terminated pid, is read.
// TerminateProcess only starts a termination, so the runner closing does not prove its workers are gone (main 9dd3a3b3,
// windows: a timed-out stress worker outlived the gate): runTest waits for every pid listed here. On Linux the group kill
// is confirmed by the runner's close, as before.
export function killRunner(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'win32') { process.kill(-pid, 'SIGKILL'); return []; }
  const result = run('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`taskkill exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  const pids = (result.stdout ?? '').split(/\r?\n/).flatMap((line) => /\d+/.exec(line)?.[0] ?? []).map(Number);
  // A listing without the runner is one this code cannot read: nothing would be confirmed, so the kill counts as failed.
  if (!pids.includes(pid)) throw new Error(`taskkill did not list runner ${pid}: ${(result.stdout ?? '').trim()}`);
  return pids;
}

// How often runTest re-checks the pids a kill reported; how long it may wait is the caller's postKillWaitMs.
const LIVENESS_POLL_MS = 5;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function stopTestRunners() {
  for (const pid of runners) {
    try { killRunner(pid); } catch (error) {
      if (error.code !== 'ESRCH') console.error(`runner ${pid} cleanup: ${error.message}`);
    }
  }
  for (const cleanup of captures) cleanup();
}
process.once('exit', stopTestRunners);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => { stopTestRunners(); process.exit(code); });
}

// Preserve error identity alongside the existing reporter's bounded first message. In particular,
// a missing module's message does not contain ERR_MODULE_NOT_FOUND, although its code does.
export default async function* testEventsWithErrorIdentity(source) {
  async function* annotated() {
    for await (const event of source) {
      if (event.type === "test:fail") {
        const error = event.data.details?.error;
        const cause = error?.cause ?? error;
        appendFileSync(process.env.KAURO_TEST_EVENTS, JSON.stringify({ event: "error", errorName: cause?.name, errorCode: cause?.code,
          errorFrame: cause?.stack?.split(/\r?\n/).find((line) => /^\s+at /.test(line)) }) + "\n");
      }
      yield event;
    }
  }
  yield* testEvents(annotated());
}

export function command(program, args, cwd, { env = {}, timeoutMs } = {}) {
  const started = performance.now();
  // File-backed capture also works in sandboxes that prohibit synchronous pipe polling.
  const capture = mkdtempSync(join(tmpdir(), "kauro-command-"));
  const stdout = openSync(join(capture, "stdout"), "w");
  const stderr = openSync(join(capture, "stderr"), "w");
  try {
    const childEnv = { ...process.env, CI: "true", FORCE_COLOR: "0", ...env };
    // A nested gate is an independent runner, not the parent node:test worker's V8 reporter channel.
    delete childEnv.NODE_TEST_CONTEXT;
    // With shell:true the arguments are concatenated unescaped; quote any containing whitespace (e.g. a store path under "MIGUEL LOPEZ").
    const shell = process.platform === "win32" && program === "pnpm";
    const result = spawnSync(program, shell ? args.map((arg) => (/\s/.test(arg) ? '"' + arg + '"' : arg)) : args, {
      cwd, stdio: ["ignore", stdout, stderr],
      env: childEnv,
      shell,
      ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
    return {
      status: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT",
      output: readFileSync(join(capture, "stdout"), "utf8") + readFileSync(join(capture, "stderr"), "utf8")
        + (result.error ? `\nError: ${result.error.message}` : ""),
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
    removeTemp(capture, () => rmSync(capture, { recursive: true, force: true }));
  }
}

export function requireCommand(program, args, cwd) {
  const result = command(program, args, cwd);
  if (result.status !== 0) throw new Error(`${program} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.output}`);
  return result;
}

export function firstFailingAssertion(output) {
  return output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)
    .find((line) => /\b(?:[A-Za-z]*Error)(?:\s*\[|:|\b)/.test(line))?.trim() ?? null;
}

// Summarises the structured events written by tools/test-events-reporter.mjs. Nothing here reads spec text.
// A "leaf" is a real test with no subtests (details.type "test", not a suite, skipped or todo). The synthetic failure node:test
// reports for a file that fails to load or throws at top level is named after the file and is never a leaf.
export function summarizeEvents(path, file, identityFile = file, { classifyMissingApi = false } = {}) {
  let records = [];
  try { records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { /* an absent or torn file means "no evidence" */ }
  const normalizedFile = normalizePath(file);
  const base = normalizedFile.split(/[\\/]/).pop();
  const identity = normalizePath(identityFile).replaceAll('\\', '/');
  const summary = {
    complete: records.some((record) => record.event === "summary"),
    passedNames: [], failedNames: [], bodyFailedNames: [], hookFailures: 0, cancelled: 0, otherFailures: 0, fileFailures: 0,
    passedPaths: [], bodyFailedPaths: [],
    redFailedNames: [], redFailedPaths: [], redAssertion: null,
    leafPassed: 0, leafFailed: 0, skipped: 0, todo: 0, assertion: null, inconclusiveFailures: [],
  };
  // Completion events are in postorder: a parent's last child completes immediately before the parent,
  // at a deeper nesting level. This also covers parents made with test()/t.test(), not just describe().
  const completed = records.flatMap((record, index) => record.event === "pass" || record.event === "fail"
    ? [{ ...record, ...(records[index - 1]?.event === "error" ? records[index - 1] : {}), event: record.event }] : []);
  // Walking postorder backwards visits each parent before its children. Keep parent records,
  // not just names: same-named suites are distinct parents too.
  const ancestors = [];
  for (let index = completed.length - 1; index >= 0; index--) {
    const record = completed[index];
    ancestors.length = record.nesting;
    record.ancestors = ancestors.slice();
    ancestors[record.nesting] = record;
  }
  const siblingCounts = new Map();
  for (const record of completed) {
    const parent = record.ancestors.at(-1);
    if (!siblingCounts.has(parent)) siblingCounts.set(parent, new Map());
    const counts = siblingCounts.get(parent);
    record.ordinal = (counts.get(record.name) ?? 0) + 1;
    counts.set(record.name, record.ordinal);
  }
  // Count skipped/todo siblings as well, so skipping the regression never renumbers its passing twin.
  // Unique names retain their existing key; duplicate components carry a one-based ordinal.
  const component = (record) => siblingCounts.get(record.ancestors.at(-1)).get(record.name) > 1
    ? [record.name, record.ordinal] : record.name;
  for (const record of completed) {
    record.path = [identity, ...record.ancestors.map(component), component(record)];
  }
  for (let index = 0; index < completed.length; index++) {
    const record = completed[index];
    const hasSubtests = completed[index - 1]?.nesting > record.nesting;
    let recordFile;
    if (record.nesting === 0) {
      try { recordFile = normalizePath(record.name); } catch { /* Test titles need not be valid file URLs. */ }
    }
    // A file with no tests is reported as one passing node named after the file; that is not an executed test either.
    if (record.nesting === 0 && (recordFile === base || recordFile === normalizedFile)) { if (record.event === "fail") summary.fileFailures++; continue; }
    if (record.kind !== "test") {
      if (record.event === "fail" && record.failureType === "hookFailed") summary.hookFailures++;
      continue; // a suite never counts as an executed test; its children are reported on their own
    }
    if (record.skip) { summary.skipped++; continue; }
    if (record.todo) { summary.todo++; continue; }
    if (hasSubtests) {
      if (record.event === "fail") {
        if (record.failureType === "hookFailed") summary.hookFailures++;
        else if (record.failureType === "cancelledByParent") summary.cancelled++;
        else if (record.failureType !== "subtestsFailed") summary.otherFailures++;
      }
      continue;
    }
    if (record.event === "pass") { summary.leafPassed++; summary.passedNames.push(record.name); summary.passedPaths.push(record.path); continue; }
    summary.failedNames.push(record.name);
    if (record.failureType === "testCodeFailure") {
      summary.leafFailed++; summary.bodyFailedNames.push(record.name);
      summary.bodyFailedPaths.push(record.path);
      const assertion = record.message == null ? null : record.errorName
        ? `${record.errorName}${record.errorCode ? ` [${record.errorCode}]` : ""}: ${record.message}` : record.message;
      summary.assertion ??= assertion;
      // A "not a function/constructor" TypeError thrown from test code (or one whose origin cannot be located) means the
      // API the test calls is absent: its behaviour assertion never ran. One thrown inside product code is a real failure.
      // Decided by where it was thrown, never by the name in the message.
      const missingApi = classifyMissingApi && record.errorName === 'TypeError'
        && /\bis not a (?:function|constructor)\b/.test(record.message ?? '')
        && ['test', 'unlocated'].includes(frameOrigin(record.errorFrame, normalizedFile));
      if (missingApi || ['ERR_MODULE_NOT_FOUND', 'ECONNREFUSED'].includes(record.errorCode)) {
        summary.inconclusiveFailures.push(assertion);
      } else {
        summary.redFailedNames.push(record.name);
        summary.redFailedPaths.push(record.path);
        summary.redAssertion ??= assertion;
      }
    } else if (record.failureType === "hookFailed") summary.hookFailures++;
    else if (record.failureType === "cancelledByParent") summary.cancelled++;
    else summary.otherFailures++;
  }
  summary.anyFailure = summary.failedNames.length > 0 || summary.fileFailures > 0 || summary.hookFailures > 0 || summary.cancelled > 0 || summary.otherFailures > 0;
  return summary;
}

export function workspacePackages(root) {
  const packages = [];
  for (const group of ["packages", "apps"]) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const dir = join(root, group, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
      packages.push({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) });
    }
  }
  return packages;
}

export function dependencyOrder(packages, selected = packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const done = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(pkg) {
    if (done.has(pkg)) return;
    if (visiting.has(pkg)) throw new Error(`workspace dependency cycle at ${pkg.manifest.name}`);
    visiting.add(pkg);
    for (const [name, version] of Object.entries({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies })) {
      if (version.startsWith("workspace:") && byName.has(name)) visit(byName.get(name));
    }
    visiting.delete(pkg);
    done.add(pkg);
    ordered.push(pkg);
  }
  selected.forEach(visit);
  return ordered;
}

export function testTarget(root, file) {
  root = normalizePath(resolve(root));
  const absolute = normalizePath(resolve(root, file));
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(absolute)) {
    throw new Error(`test file must exist inside the repository: ${file}`);
  }
  if (!/\.test\.(?:[cm]?[jt]s|tsx)$/.test(absolute)) throw new Error(`expected a single .test.js/.test.mjs/.test.ts file: ${file}`);
  let dir = dirname(absolute);
  while (!existsSync(join(dir, "package.json"))) {
    if (dir === root || dirname(dir) === dir) throw new Error(`no package.json for ${file}`);
    dir = dirname(dir);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const script = manifest.scripts?.test ?? "node --test";
  if (!/(?:^|\s)node\s+--test(?:\s|$)/.test(script)) throw new Error(`unsupported single-file runner in ${dir}: ${script}`);
  const concurrencyMatch = script.match(/--test-concurrency(?:=|\s+)(\d+)\b/);
  const concurrency = concurrencyMatch ? Number(concurrencyMatch[1]) : undefined;
  let compiled = absolute;
  if (/\.(?:[cm]?ts|tsx)$/.test(absolute)) {
    const sourceRel = relative(dir, absolute);
    if (!sourceRel.startsWith(`test${sep}`)) throw new Error(`TypeScript test must be under its package's test/: ${file}`);
    compiled = join(dir, "dist", sourceRel.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.tsx?$/, ".js"));
  }
  return { file: rel.split(sep).join("/"), dir, manifest, compiled, concurrency };
}

export async function runTest(target, concurrency = target.concurrency, { timeoutMs, killer = killRunner, postKillWaitMs = 10_000, classifyMissingApi, namePatterns = [] } = {}) {
  if (!existsSync(target.compiled)) throw new Error(`compiled test is missing: ${target.compiled}`);
  const eventsDir = mkdtempSync(join(tmpdir(), "kauro-events-"));
  const eventsFile = join(eventsDir, "events.jsonl");
  const stdoutFile = join(eventsDir, "stdout");
  const stderrFile = join(eventsDir, "stderr");
  const stdout = openSync(stdoutFile, "w");
  const stderr = openSync(stderrFile, "w");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    closeSync(stdout);
    closeSync(stderr);
    removeTemp(eventsDir, () => rmSync(eventsDir, { recursive: true, force: true }));
    captures.delete(cleanup);
  };
  captures.add(cleanup);
  const started = performance.now();
  try {
    // Default process isolation: a top-level throw or load error stays attributable to its file. The custom reporter
    // yields nothing, so its destination is stderr only to satisfy the pairing rule; events go to KAURO_TEST_EVENTS.
    const args = ["--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
      `--test-reporter=${REPORTER}`, "--test-reporter-destination=stderr"];
    if (concurrency !== undefined) args.push(`--test-concurrency=${concurrency}`);
    if (timeoutMs) args.push(`--test-timeout=${Math.max(1, Math.floor(timeoutMs * 0.8))}`);
    // only the named tests of the file (stress-cells --changed); a pattern that matches nothing runs zero tests, which is a FAIL
    for (const pattern of namePatterns) args.push(`--test-name-pattern=${pattern}`);
    args.push(target.compiled);
    const env = { ...process.env, CI: "true", FORCE_COLOR: "0", KAURO_TEST_EVENTS: eventsFile };
    delete env.NODE_TEST_CONTEXT;
    // A detached runner owns the process group containing its isolated per-file workers. Keep the outer
    // timer in this process so Windows taskkill can find the live runner and traverse its descendants.
    const result = await new Promise((resolveResult) => {
      const child = spawn(process.execPath, args, { cwd: target.dir, env, detached: process.platform !== 'win32', stdio: ["ignore", stdout, stderr] });
      if (child.pid) runners.add(child.pid);
      let timedOut = false;
      let error;
      let settled = false;
      let postKillTimer;
      let runnerClosed = false;
      let killError; // the killer's own failure, kept apart from a spawn error
      let pending = []; // the runner's descendants the kill reported, until each is observed terminated
      const finish = (status, signal, killFailure = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(postKillTimer);
        if (killFailure) child.unref(); // The bounded result must also allow the gate itself to exit.
        resolveResult({ status, signal, timedOut, killFailure,
          output: readFileSync(stdoutFile, 'utf8') + readFileSync(stderrFile, 'utf8') + (error ? `\nError: ${error.code ?? error.name}: ${error.message}` : ''),
          durationMs: Math.round(performance.now() - started) });
      };
      const timer = timeoutMs ? setTimeout(() => {
        timedOut = true;
        try { pending = (killer(child.pid) ?? []).filter((pid) => pid !== child.pid); } catch (cause) { error = cause; killError = cause; }
        // One bound for the whole tree: a runner that does not close, or a worker still alive after it closed, is a kill failure.
        postKillTimer = setTimeout(() => finish(null, null, `${error ? `${error.code ?? error.name}: ${error.message}; ` : ''}${runnerClosed
          ? `worker ${pending.join(', ')} still alive ${postKillWaitMs} ms after kill` : `runner did not close within ${postKillWaitMs} ms after kill`}`), postKillWaitMs);
      }, timeoutMs) : undefined;
      child.once("error", (cause) => { error = cause; });
      child.once("close", (status, signal) => {
        runners.delete(child.pid);
        runnerClosed = true;
        // The run ends when every process the kill reported has terminated, not when the runner alone has.
        const confirm = () => {
          if (settled) return;
          pending = pending.filter(alive); // a pid seen dead is never probed again: the OS reuses pids
          if (pending.length) setTimeout(confirm, LIVENESS_POLL_MS);
          // A kill that failed or could not be read confirmed nothing: the runner closing does not vouch for its workers (Codex R-112-1).
          else finish(status, signal, killError ? `${killError.code ?? killError.name}: ${killError.message}; the runner closed but its tree's termination is unconfirmed` : null);
        };
        confirm();
      });
    });
    const summary = summarizeEvents(eventsFile, target.compiled, target.file ?? target.compiled, { classifyMissingApi });
    return { ...result, firstFailingAssertion: summary.assertion ?? firstFailingAssertion(result.output), summary };
  } finally {
    cleanup();
  }
}

// generate has already run. Avoid the contracts build script's redundant generation.
export function buildPackage(pkg, { runtimeOnly = false } = {}) {
  if (pkg.manifest.name === "@kauro/contracts" && pkg.manifest.scripts?.build === "node tools/generate.mjs && tsc -p tsconfig.json && node tools/copy-generated-assets.mjs") {
    requireCommand("pnpm", ["exec", "tsc", "-p", "tsconfig.json", ...(runtimeOnly ? ["--noCheck"] : [])], pkg.dir);
    requireCommand(process.execPath, ["tools/copy-generated-assets.mjs"], pkg.dir);
  } else if (runtimeOnly && /^tsc -p [\w.-]+$/.test(pkg.manifest.scripts?.build ?? "")) {
    // Head's tests may name types introduced by the fix. Emit the executable negative control anyway;
    // a compiler diagnostic is not its verdict. The independent verify:fast gate checks types.
    requireCommand("pnpm", ["exec", ...pkg.manifest.scripts.build.split(" "), "--noCheck"], pkg.dir);
  } else if (pkg.manifest.scripts?.build) {
    requireCommand("pnpm", ["run", "build"], pkg.dir);
  }
}
