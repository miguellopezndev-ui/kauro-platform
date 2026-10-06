#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runTest, testTarget } from "./test-runner.mjs";

function usage(message) {
  console.error(`${message}\nUsage: node tools/stress-cells.mjs <compiled test file> [N=20] [--concurrency <n>] [--timeout-min 30]`);
  process.exit(2);
}
const args = process.argv.slice(2);
const file = args.shift();
if (!file || file.startsWith("-")) usage("test file is required");
function positive(value) { return /^[1-9]\d*$/.test(value ?? "") && Number.isSafeInteger(Number(value)); }
let count = 20;
if (args[0] && !args[0].startsWith("-")) {
  if (!positive(args[0])) usage("N must be a positive integer");
  count = Number(args.shift());
}
let concurrency;
let timeoutMin = 30;
while (args.length) {
  if (args.length >= 2 && args[0] === "--concurrency" && concurrency === undefined && positive(args[1])) concurrency = Number(args[1]);
  else if (args.length >= 2 && args[0] === "--timeout-min" && Number.isFinite(Number(args[1])) && Number(args[1]) > 0) timeoutMin = Number(args[1]);
  else usage("expected --concurrency <positive integer> and/or --timeout-min <positive integer>");
  args.splice(0, 2);
}
let target;
try {
  // Discover the nearest manifest even for an absolute path outside the current workspace.
  let packageDir = dirname(resolve(file));
  while (!existsSync(join(packageDir, "package.json"))) {
    const parent = dirname(packageDir);
    if (parent === packageDir) throw new Error(`no package.json for ${file}`);
    packageDir = parent;
  }
  target = testTarget(packageDir, resolve(file));
} catch (error) { usage(error.message); }
concurrency ??= target.concurrency;
const report = { file: resolve(file), iterations: count, concurrency: concurrency ?? "node-default", results: [], verdict: "FAIL" };
try {
  for (let iteration = 1; iteration <= count; iteration++) {
    const result = await runTest(target, concurrency, { timeoutMs: timeoutMin * 60_000 });
    const sum = result.summary;
    // Green needs a real passing test and no failure of any kind (body, hook, cancelled, file-level).
    const passed = result.status === 0 && !result.timedOut && sum.complete && sum.leafPassed >= 1 && !sum.anyFailure && sum.cancelled === 0 && sum.otherFailures === 0;
    const reason = passed ? null : result.killFailure ?? (result.timedOut ? `timed out after ${timeoutMin} min`
      : sum.leafPassed < 1 && !sum.anyFailure ? "no tests ran (zero, all skipped, todo or suites only)"
      : "failed, cancelled or unloadable tests reported");
    const tests = sum.leafPassed + sum.leafFailed;
    report.results.push({ iteration, passed, reason, tests, skipped: sum.skipped, exitCode: result.status, signal: result.signal, durationMs: result.durationMs, firstFailingAssertion: passed ? null : result.firstFailingAssertion ?? reason });
    console.log(`stress-cells: ${iteration}/${count} ${passed ? "PASS" : "FAIL"} (${result.durationMs} ms)`);
    if (result.killFailure) break; // An unconfirmed stop must not overlap another iteration.
  }
  if (report.results.every((row) => row.passed)) report.verdict = "PASS";
} catch (error) {
  report.error = error.message;
  console.error(error.message);
} finally {
  writeFileSync("stress-cells.json", JSON.stringify(report, null, 2) + "\n");
}
const passed = report.results.filter((row) => row.passed).length;
console.log(`stress-cells: ${report.verdict} (${passed}/${count} passed; stress-cells.json)`);
process.exitCode = report.verdict === "PASS" ? 0 : 1;
