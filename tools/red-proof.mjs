#!/usr/bin/env node
// Negative control: source/migrations at base, tests at head, all in a disposable Git worktree.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { buildPackage, command, dependencyOrder, requireCommand, runTest, testTarget, workspacePackages } from "./test-runner.mjs";

function usage(message) {
  console.error(`${message}\nUsage: node tools/red-proof.mjs <base> <head> --tests <file>[,<file>...] [--out red-proof.json] [--timeout-min 30]`);
  process.exit(2);
}
const args = process.argv.slice(2);
const [baseRef, headRef] = args;
if (!baseRef || !headRef || baseRef.startsWith("-") || headRef.startsWith("-")) usage("base and head are required");
let files;
let out = "red-proof.json";
let seenOut = false;
let timeoutMin = 30;
let seenTimeout = false;
for (let i = 2; i < args.length; i++) {
  if (args[i] === "--tests" && !files && args[i + 1] && !args[i + 1].startsWith("-")) files = args[++i].split(",");
  else if (args[i] === "--out" && !seenOut && args[i + 1] && !args[i + 1].startsWith("-")) { out = args[++i]; seenOut = true; }
  else if (args[i] === "--timeout-min" && !seenTimeout && Number.isFinite(Number((args[i + 1] ?? ""))) && Number((args[i + 1] ?? "")) > 0) { timeoutMin = Number(args[++i]); seenTimeout = true; }
  else usage(`unknown or incomplete argument: ${args[i]}`);
}
if (!files?.length || files.some((file) => !file.trim()) || new Set(files).size !== files.length) usage("provide unique, nonempty test files");

let root, base, head;
try {
  root = realpathSync.native(requireCommand("git", ["rev-parse", "--show-toplevel"], process.cwd()).output.trim());
  base = requireCommand("git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], root).output.trim();
  head = requireCommand("git", ["rev-parse", "--verify", "--end-of-options", `${headRef}^{commit}`], root).output.trim();
} catch (error) { usage(error.message); }
const timeoutMs = timeoutMin * 60_000;
// 8.3 short TEMP paths and long paths must compare equal: normalise both sides of relative().
files = files.map((file) => { const absolute = resolve(process.cwd(), file); try { return realpathSync.native(absolute); } catch { return absolute; } });
const report = { base, head, revertedPaths: [], tests: [], errors: [], inconclusive: [], verdict: "FAIL" };
class Stop extends Error {}
const work = mkdtempSync(join(tmpdir(), "kauro-red-proof-"));
const repository = join(work, "repository");
const checkout = join(work, "head");
let registered = false;
function cleanup() {
  if (registered) {
    const result = command("git", ["worktree", "remove", "--force", checkout], repository);
    if (result.status !== 0) console.error(`worktree removal: ${result.output}`);
    registered = false;
  }
  rmSync(work, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(signal === "SIGINT" ? 130 : 143); });
let exitCode = 1;
try {
  // A shared local clone reuses objects and keeps worktree metadata out of the caller's (possibly read-only) .git.
  requireCommand("git", ["clone", "--shared", "--no-checkout", root, repository], root);
  requireCommand("git", ["worktree", "add", "--detach", checkout, head], repository);
  registered = true;
  let targets;
  try {
    targets = files.map((file) => testTarget(checkout, relative(root, file)));
  } catch (error) {
    console.error(error.message);
    exitCode = 2;
    throw error;
  }
  report.tests = targets.map(({ file }) => ({
    file, failedWithoutFix: false, baseFailedNames: [], firstFailingAssertion: null, passedAtHead: false,
    durations: { withoutFixMs: null, atHeadMs: null },
  }));
  report.revertedPaths = requireCommand("git", ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], checkout).output
    .split("\0").filter((path) => /^(?:apps|packages)\/[^/]+\/src\//.test(path) || path.startsWith("packages/persistence/migrations/"));

  if (!report.revertedPaths.length) {
    report.inconclusive.push("nothing to revert: the diff touches no apps/*/src, packages/*/src or packages/persistence/migrations path");
    exitCode = 2;
    throw new Stop(report.inconclusive[0]);
  }

  const callerStore = requireCommand("pnpm", ["store", "path"], root).output.trim();
  const storeDir = callerStore.replace(/[\\/]v\d+$/, "");
  const installArgs = ["install", "--frozen-lockfile", "--store-dir", storeDir];
  const offline = command("pnpm", [...installArgs, "--offline"], checkout);
  if (offline.status !== 0) {
    if (!/ERR_PNPM_(?:NO_OFFLINE_(?:TARBALL|META)|MISSING_PACKAGE)/.test(offline.output)) throw new Error(`offline install failed:\n${offline.output}`);
    console.log("red-proof: offline cache incomplete; retrying frozen install with the same store");
    requireCommand("pnpm", installArgs, checkout);
  }
  const packages = workspacePackages(checkout);
  const selected = targets.map((target) => packages.find((pkg) => pkg.dir === target.dir) ?? target);
  const buildOrder = dependencyOrder(packages, selected);
  const manifest = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
  if (manifest.scripts?.generate) requireCommand("pnpm", ["run", "generate"], checkout);

  async function phase(withoutFix) {
    const label = withoutFix ? "without fix" : "at head";
    try {
      // Remove emitted files each time: deleted/renamed source must never survive as stale dist output.
      for (const pkg of buildOrder) rmSync(join(pkg.dir, "dist"), { recursive: true, force: true });
      if (!withoutFix && manifest.scripts?.generate) requireCommand("pnpm", ["run", "generate"], checkout);
      for (const pkg of buildOrder) {
        console.log(`red-proof: build ${pkg.manifest.name} (${label})`);
        buildPackage(pkg, { runtimeOnly: true });
      }
      if (withoutFix && report.revertedPaths.length) {
        requireCommand("git", ["diff", "--exit-code", base, "--", ...report.revertedPaths], checkout);
      } else if (!withoutFix) {
        requireCommand("git", ["diff", "--exit-code", head, "--"], checkout);
      }
    } catch (error) {
      report.errors.push(`${label} preparation: ${error.message}`);
      return; // A build/install failure is not a failing test and cannot prove red.
    }
    for (let i = 0; i < targets.length; i++) {
      try {
        const result = await runTest(targets[i], undefined, { timeoutMs });
        const row = report.tests[i];
        const sum = result.summary;
        const ran = sum.leafPassed + sum.leafFailed;
        if (withoutFix) {
          // Red only when at least one real test body failed its own assertions. Hook failures, cancellations,
          // load errors, timeouts and runs that executed nothing prove nothing.
          const timedOut = result.timedOut;
          row.failedWithoutFix = !timedOut && !sum.inconclusiveFailures.length && result.status !== 0 && sum.leafFailed >= 1;
          row.baseFailedNames = row.failedWithoutFix ? sum.bodyFailedNames : [];
          if (!row.failedWithoutFix && !(result.status === 0 && ran >= 1)) {
            const why = timedOut ? `timed out after ${timeoutMin} min`
              : sum.inconclusiveFailures.length ? sum.inconclusiveFailures.join("; ")
              : sum.fileFailures ? "the test file failed to load or threw at top level (import/syntax/missing export)"
              : sum.hookFailures ? "a before/after hook failed, so no test body proved the regression"
              : ran === 0 ? "no test executed (zero, all skipped, todo or suites only)"
              : sum.cancelled || sum.otherFailures ? "tests were cancelled or failed without a test-body failure" : "no failing test body was identified";
            report.inconclusive.push(`without fix: ${targets[i].file}: ${why}`);
          }
          row.firstFailingAssertion = row.failedWithoutFix ? sum.assertion : result.firstFailingAssertion;
          row.durations.withoutFixMs = result.durationMs;
        } else {
          const recovered = row.baseFailedNames.every((name) => sum.passedNames.includes(name));
          row.passedAtHead = result.status === 0 && sum.complete && sum.leafPassed >= 1 && !sum.anyFailure && sum.cancelled === 0 && recovered;
          row.durations.atHeadMs = result.durationMs;
          if (!row.passedAtHead) row.firstFailingAssertionAtHead = result.firstFailingAssertion ?? (result.status === 0 ? "head run is not green: no executed passing test, or a base-failing test did not pass" : null);
        }
        console.log(`red-proof: ${targets[i].file} (${label}): ${result.status === 0 ? "PASS" : "FAIL"} (${result.durationMs} ms)`);
        if (result.status !== 0) console.log(result.output);
        if (result.timedOut && !withoutFix) report.errors.push(`${label}: ${targets[i].file} timed out after ${timeoutMin} min`);
        else if (result.status === null && !result.timedOut) report.errors.push(`${label}: ${targets[i].file} did not exit normally`);
      } catch (error) { report.errors.push(`${label}: ${error.message}`); }
    }
  }

  if (report.revertedPaths.length) requireCommand("git", ["restore", `--source=${base}`, "--staged", "--worktree", "--", ...report.revertedPaths], checkout);
  await phase(true);
  requireCommand("git", ["reset", "--hard", head], checkout);
  await phase(false);
  if (!report.errors.length && report.tests.every((row) => row.failedWithoutFix && row.passedAtHead)) {
    report.verdict = "PASS";
    exitCode = 0;
  } else if (report.inconclusive.length && !report.errors.length) {
    report.verdict = "INCONCLUSIVE";
    exitCode = 2;
  }
} catch (error) {
  if (error instanceof Stop) report.verdict = "INCONCLUSIVE";
  else report.errors.push(error.message);
} finally {
  cleanup();
  writeFileSync(resolve(out), JSON.stringify(report, null, 2) + "\n");
}
console.log(`red-proof: ${report.verdict} (${resolve(out)})`);
if (report.inconclusive.length) console.error(`INCONCLUSIVE: ${report.inconclusive.join("; ")}`);
if (report.errors.length) console.error(report.errors.join("\n"));
process.exitCode = exitCode;
