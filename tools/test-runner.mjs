// Shared single-file Node test execution and workspace dependency ordering for the builder gates.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import testEvents from "./test-events-reporter.mjs";

const REPORTER = import.meta.url;
const runners = new Set();
const captures = new Set();

function killRunner(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`taskkill exited ${result.status}`);
  } else process.kill(-pid, 'SIGKILL');
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
    rmSync(capture, { recursive: true, force: true });
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
export function summarizeEvents(path, file, identityFile = file, { baseSymbols } = {}) {
  let records = [];
  try { records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { /* an absent or torn file means "no evidence" */ }
  const base = file.split(/[\\/]/).pop();
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
    record.path = [identityFile.replaceAll('\\', '/'), ...record.ancestors.map(component), component(record)];
  }
  for (let index = 0; index < completed.length; index++) {
    const record = completed[index];
    const hasSubtests = completed[index - 1]?.nesting > record.nesting;
    // A file with no tests is reported as one passing node named after the file; that is not an executed test either.
    if (record.nesting === 0 && (record.name === base || record.name === file)) { if (record.event === "fail") summary.fileFailures++; continue; }
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
      // Only a direct call in this test to a symbol absent from the base runtime build is a missing API.
      // Error text identifies that symbol, but never substitutes for the error's type or code.
      const symbol = /^(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*) is not a (?:function|constructor)\b/.exec(record.message ?? '')?.[1];
      const missingApi = record.errorName === 'TypeError' && symbol && baseSymbols && !baseSymbols.has(symbol)
        && record.errorFrame?.replaceAll('\\', '/').includes(file.replaceAll('\\', '/') + ':');
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

// A conservative identifier inventory of emitted runtime code; tests cannot supply a missing base API.
export function baseBuildSymbols(packages) {
  const symbols = new Set();
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!['test', 'tests', 'node_modules'].includes(entry.name)) scan(path); }
      else if (/\.[cm]?js$/.test(entry.name)) {
        for (const symbol of readFileSync(path, 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? []) symbols.add(symbol);
      }
    }
  }
  for (const pkg of packages) {
    const dist = join(pkg.dir, 'dist');
    scan(existsSync(dist) ? dist : join(pkg.dir, 'src'));
  }
  return symbols;
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
  const absolute = resolve(root, file);
  const rel = relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(absolute)) {
    throw new Error(`test file must exist inside the repository: ${file}`);
  }
  if (!/\.test\.(?:[cm]?[jt]s|tsx)$/.test(absolute)) throw new Error(`expected a single .test.js/.test.mjs/.test.ts file: ${file}`);
  let dir = dirname(absolute);
  while (!existsSync(join(dir, "package.json"))) {
    if (dir === root) throw new Error(`no package.json for ${file}`);
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

export async function runTest(target, concurrency = target.concurrency, { timeoutMs, killer = killRunner, postKillWaitMs = 10_000, baseSymbols } = {}) {
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
    rmSync(eventsDir, { recursive: true, force: true });
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
        try { killer(child.pid); } catch (cause) { error = cause; }
        postKillTimer = setTimeout(() => finish(null, null,
          `${error ? `${error.code ?? error.name}: ${error.message}; ` : ''}runner did not close within ${postKillWaitMs} ms after kill`), postKillWaitMs);
      }, timeoutMs) : undefined;
      child.once("error", (cause) => { error = cause; });
      child.once("close", (status, signal) => {
        runners.delete(child.pid);
        finish(status, signal);
      });
    });
    const summary = summarizeEvents(eventsFile, target.compiled, target.file ?? target.compiled, { baseSymbols });
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
