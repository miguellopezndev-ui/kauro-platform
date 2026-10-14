// B18 S080 (SIMULATED over a check-runs fixture and the repository's own workflows; the required CI step is the separate
// "CI: release-candidate gate" PR). Two ways a green can lie: a check run that is not the exact run of the candidate's sha, and a
// pipe that turns a failing step into exit 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { packagePipes, verifyCi, workflowPipes } from "../release-candidate.mjs";

const here = import.meta.dirname;
const repo = join(here, "..", "..");
const tool = join(here, "..", "release-candidate.mjs");
const fixture = (name) => readFileSync(join(here, "fixtures", "release", name), "utf8");
const runs = JSON.parse(fixture("check-runs.json"));
const SHA = "c".repeat(40);
const OLD = "d".repeat(40);
const REQUIRED = ["verify (ubuntu-latest)", "verify (windows-latest)"];
const codes = (r) => r.problems.map((p) => p.code);
const run = (extra) => verifyCi([...runs, ...extra], { sha: SHA, required: REQUIRED });

function packageManifests(dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".next") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...packageManifests(p));
    else if (e.name === "package.json") found.push(p);
  }
  return found;
}

test("S080: DENY a same-named or older-sha check run, a skipped or neutral run, and a pipe that drops exit 1", () => {
  // the exact run of both required contexts passes
  assert.deepEqual(verifyCi(runs, { sha: SHA, required: REQUIRED }), { ok: true, problems: [] });

  // same name, other sha: the older head's success never stands in for the candidate's
  assert.deepEqual(codes(verifyCi(runs.filter((r) => !(r.head_sha === SHA && r.name === REQUIRED[1])), { sha: SHA, required: REQUIRED })), ["RUN_MISSING"]);
  assert.deepEqual(codes(verifyCi(runs, { sha: "e".repeat(40), required: REQUIRED })), ["RUN_MISSING", "RUN_MISSING"]);
  assert.match(verifyCi(runs, { sha: OLD.replace(/d/g, "9"), required: [REQUIRED[0]] }).problems[0].detail, /other shas do not count/);
  // a newer run on an older sha does not outrank anything on the candidate's sha
  assert.deepEqual(codes(run([{ id: 999, name: REQUIRED[0], head_sha: OLD, status: "completed", conclusion: "failure" }])), []);

  // skipped, neutral and every other conclusion, and an unfinished run
  for (const conclusion of ["skipped", "neutral", "failure", "cancelled", "timed_out", "action_required", "stale", null]) {
    const result = run([{ id: 500, name: REQUIRED[1], head_sha: SHA, status: "completed", conclusion }]);
    assert.deepEqual(codes(result), ["RUN_NOT_SUCCESS"], String(conclusion));
  }
  assert.deepEqual(codes(run([{ id: 500, name: REQUIRED[0], head_sha: SHA, status: "in_progress", conclusion: null }])), ["RUN_NOT_COMPLETED"]);
  // the latest run decides in both directions
  assert.deepEqual(codes(run([{ id: 100, name: REQUIRED[0], head_sha: SHA, status: "completed", conclusion: "failure" }])), [], "an older failed attempt is superseded by the later success");
  assert.deepEqual(codes(run([{ id: 103, name: REQUIRED[0], head_sha: SHA, status: "completed", conclusion: "skipped" }])), ["RUN_NOT_SUCCESS"], "a later skipped rerun supersedes the earlier success");
  assert.deepEqual(codes(run([{ id: 101, name: REQUIRED[0], head_sha: SHA, status: "completed", conclusion: "success" }])), ["RUN_AMBIGUOUS"]);
  assert.deepEqual(codes(verifyCi(runs, { sha: SHA, required: [] })), ["NO_REQUIRED_CONTEXTS"]);
  assert.deepEqual(codes(verifyCi(runs, { sha: "abc", required: REQUIRED })), ["SHA_MALFORMED"]);

  // the repository's own pipes: the two in verify.yml are safe (job default shell bash; set -o pipefail), no others anywhere
  const workflow = workflowPipes(readFileSync(join(repo, ".github", "workflows", "verify.yml"), "utf8"));
  assert.equal(workflow.pipes.length, 2, JSON.stringify(workflow.pipes));
  assert.deepEqual(workflow.pipes.map((p) => p.safe), [true, true]);
  for (const manifest of packageManifests(repo)) {
    const unsafe = packagePipes(readFileSync(manifest, "utf8")).pipes.filter((p) => !p.safe);
    assert.deepEqual(unsafe, [], relative(repo, manifest));
  }

  // planted: a step with no shell and no pipefail drops exit 1
  const planted = workflowPipes(fixture("workflow-unsafe.yml")).pipes;
  assert.equal(planted.length, 1);
  assert.equal(planted[0].safe, false);
  const safe = (patch) => workflowPipes(fixture("workflow-unsafe.yml").replace("        run: |", patch)).pipes.map((p) => p.safe);
  assert.deepEqual(safe("        shell: bash\n        run: |"), [true]);
  assert.deepEqual(safe("        shell: sh\n        run: |"), [false]);
  assert.deepEqual(safe("        shell: bash -e {0}\n        run: |"), [false]);
  assert.deepEqual(safe("        shell: pwsh\n        run: |"), [false]);
  assert.deepEqual(workflowPipes(fixture("workflow-unsafe.yml").replace("          pnpm run gate", "          set -eo pipefail\n          pnpm run gate")).pipes.map((p) => p.safe), [true]);
  assert.deepEqual(workflowPipes(fixture("workflow-unsafe.yml").replace("          pnpm run gate", "          set -o pipefail\n          set +o pipefail\n          pnpm run gate")).pipes.map((p) => p.safe), [false]);
  assert.deepEqual(workflowPipes(fixture("workflow-unsafe.yml").replace("    steps:", "    defaults:\n      run:\n        shell: bash\n    steps:")).pipes.map((p) => p.safe), [true], "job default shell");
  assert.deepEqual(workflowPipes(fixture("workflow-unsafe.yml").replace("          pnpm run gate 2>&1 | tee gate.log", "          pnpm run a || pnpm run b\n          echo 'a | b'")).pipes, [], "|| and a quoted bar are not pipes");
  // a continuation line starting with the bar belongs to the pipe above it
  assert.equal(workflowPipes(fixture("workflow-unsafe.yml").replace("pnpm run gate 2>&1 | tee gate.log", "pnpm run gate \\\n            | tee gate.log")).pipes[0].safe, false);
  // package.json scripts run under sh without pipefail
  assert.deepEqual(packagePipes('{"scripts":{"a":"node x | tee y","b":"set -o pipefail; node x | tee y","c":"node x || node y"}}').pipes.map((p) => [p.script, p.safe]), [["a", false], ["b", true]]);

  // the CLI refuses the planted workflow and the planted script, and accepts the repository's own
  const dir = mkdtempSync(join(tmpdir(), "kauro-pipe-exit-"));
  try {
    writeFileSync(join(dir, "package.json"), '{"scripts":{"verify":"node gate.mjs | tee gate.log"}}');
    const cli = (...args) => spawnSync(process.execPath, [tool, "verify-pipes", ...args], { encoding: "utf8" });
    const refused = cli("--workflow", join(here, "fixtures", "release", "workflow-unsafe.yml"));
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /PIPE_DROPS_EXIT/);
    assert.equal(cli("--package", join(dir, "package.json")).status, 1);
    assert.equal(cli("--workflow", join(repo, ".github", "workflows", "verify.yml"), "--package", join(repo, "package.json")).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
