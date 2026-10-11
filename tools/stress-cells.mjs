#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { changedTimingCells } from "./changed-cells.mjs";
import { normalizePath, runTest, testTarget } from "./test-runner.mjs";

function usage(message) {
  console.error(`${message}\nUsage: node tools/stress-cells.mjs <compiled test file> [N=20] [--concurrency <n>] [--timeout-min 30]
       node tools/stress-cells.mjs --changed [--base origin/main] [N=20] [--cpu-load] [--concurrency <n>] [--timeout-min 30]
  --changed: the race/timeout/expiry cells the change (merge base with --base ... HEAD) adds or modifies, each file run N times with
  only those cells selected; a fixed wait cap written in a changed cell FAILS before any run. --cpu-load (Linux only) keeps
  stress-ng --cpu <all cores> running for the whole gate.`);
  process.exit(2);
}
const args = process.argv.slice(2);
const changed = args[0] === "--changed";
let file;
if (changed) args.shift();
else {
  file = args.shift();
  if (!file || file.startsWith("-")) usage("test file is required");
}
function positive(value) { return /^[1-9]\d*$/.test(value ?? "") && Number.isSafeInteger(Number(value)); }
let count = 20;
let countGiven = false;
if (args[0] && !args[0].startsWith("-")) {
  if (!positive(args[0])) usage("N must be a positive integer");
  count = Number(args.shift());
  countGiven = true;
}
let concurrency;
let timeoutMin = 30;
let base = "origin/main";
let cpuLoad = false;
while (args.length) {
  if (changed && args[0] === "--cpu-load") { cpuLoad = true; args.splice(0, 1); continue; }
  if (changed && !countGiven && positive(args[0])) { count = Number(args.shift()); countGiven = true; continue; }
  if (changed && args.length >= 2 && args[0] === "--base" && !args[1].startsWith("-")) base = args[1];
  else if (args.length >= 2 && args[0] === "--concurrency" && concurrency === undefined && positive(args[1])) concurrency = Number(args[1]);
  else if (args.length >= 2 && args[0] === "--timeout-min" && Number.isFinite(Number(args[1])) && Number(args[1]) > 0) timeoutMin = Number(args[1]);
  else usage("expected --concurrency <positive integer> and/or --timeout-min <positive integer>");
  args.splice(0, 2);
}
if (cpuLoad && process.platform !== "linux") usage("--cpu-load runs on Linux only (stress-ng)");

function targetOf(path, root) {
  const absolute = normalizePath(resolve(root ?? ".", path));
  // Discover the nearest manifest even for an absolute path outside the current workspace.
  let packageDir = dirname(absolute);
  while (!existsSync(join(packageDir, "package.json"))) {
    const parent = dirname(packageDir);
    if (parent === packageDir) throw new Error(`no package.json for ${path}`);
    packageDir = parent;
  }
  return testTarget(packageDir, absolute);
}

/** Runs one file `count` times; each row is green only with a real passing test and no failure of any kind. */
async function iterate(target, label, namePatterns, report) {
  const rows = [];
  for (let iteration = 1; iteration <= count; iteration++) {
    const result = await runTest(target, concurrency ?? target.concurrency, { timeoutMs: timeoutMin * 60_000, namePatterns });
    const sum = result.summary;
    // Green needs a real passing test and no failure of any kind (body, hook, cancelled, file-level).
    const passed = result.status === 0 && !result.timedOut && sum.complete && sum.leafPassed >= 1 && !sum.anyFailure && sum.cancelled === 0 && sum.otherFailures === 0;
    const reason = passed ? null : result.killFailure ?? (result.timedOut ? `timed out after ${timeoutMin} min`
      : sum.leafPassed < 1 && !sum.anyFailure ? "no tests ran (zero, all skipped, todo or suites only)"
      : "failed, cancelled or unloadable tests reported");
    const tests = sum.leafPassed + sum.leafFailed;
    const row = { iteration, passed, reason, tests, skipped: sum.skipped, exitCode: result.status, signal: result.signal, durationMs: result.durationMs, firstFailingAssertion: passed ? null : result.firstFailingAssertion ?? reason };
    rows.push(row);
    report.results.push(changed ? { file: label, ...row } : row);
    console.log(`stress-cells: ${label ? `${label} ` : ""}${iteration}/${count} ${passed ? "PASS" : "FAIL"} (${result.durationMs} ms)`);
    if (result.killFailure) { report.stopped = true; break; } // An unconfirmed stop must not overlap another iteration.
  }
  return rows;
}

let load;
const stopLoad = () => { if (load?.pid && load.exitCode === null) { try { process.kill(-load.pid, "SIGKILL"); } catch { /* already gone */ } } };
const report = changed
  ? { mode: "changed", base, iterations: count, cpuLoad, concurrency: concurrency ?? "package", selection: [], fixedCaps: [], results: [], verdict: "FAIL" }
  : { file: normalizePath(resolve(file)), iterations: count, concurrency: concurrency ?? "node-default", results: [], verdict: "FAIL" };
try {
  if (!changed) {
    let target;
    try { target = targetOf(file); } catch (error) { usage(error.message); }
    concurrency ??= target.concurrency;
    report.concurrency = concurrency ?? "node-default";
    await iterate(target, "", [], report);
    if (report.results.length && report.results.every((row) => row.passed)) report.verdict = "PASS";
  } else {
    const selection = changedTimingCells(process.cwd(), base);
    report.selection = selection.map((s) => ({ file: s.file, wholeFile: s.wholeFile, cells: s.cells.map((c) => ({ title: c.title, lines: `${c.from}-${c.to}`, pattern: c.pattern })) }));
    report.fixedCaps = selection.flatMap((s) => s.fixedCaps.map((c) => ({ file: s.file, ...c })));
    for (const c of report.fixedCaps) console.log(`stress-cells: FIXED WAIT CAP ${c.file}:${c.line}: ${c.text} (derive it from the harness bounds)`);
    if (report.fixedCaps.length) report.error = "fixed wait caps in changed timing cells";
    else if (!selection.length) {
      console.log(`stress-cells: no race/timeout/expiry cell changed against ${base}`);
      report.verdict = "PASS";
    } else {
      if (cpuLoad) {
        load = spawn("stress-ng", ["--cpu", String(availableParallelism()), "--quiet"], { detached: true, stdio: "ignore" });
        process.once("exit", stopLoad); // an interrupted gate leaves no load behind
        await new Promise((ok, fail) => { load.once("spawn", ok); load.once("error", (e) => fail(new Error(`stress-ng did not start: ${e.message}`))); });
      }
      for (const s of selection) {
        const target = targetOf(s.file, process.cwd());
        const patterns = s.wholeFile ? [] : s.cells.map((c) => c.pattern);
        console.log(`stress-cells: ${s.file}: ${s.wholeFile ? "whole file (a non-literal title)" : `${s.cells.length} cell(s)`}`);
        await iterate(target, s.file, patterns, report);
        if (report.stopped) break;
      }
      const expected = selection.length * count;
      if (!report.stopped && report.results.length === expected && report.results.every((row) => row.passed)) report.verdict = "PASS";
    }
  }
} catch (error) {
  report.error = error.message;
  console.error(error.message);
} finally {
  stopLoad();
  writeFileSync("stress-cells.json", JSON.stringify(report, null, 2) + "\n");
}
const passed = report.results.filter((row) => row.passed).length;
console.log(`stress-cells: ${report.verdict} (${passed}/${changed ? report.selection.length * count : count} passed; stress-cells.json)`);
process.exitCode = report.verdict === "PASS" ? 0 : 1;
