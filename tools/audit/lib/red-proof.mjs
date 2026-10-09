// The red proof of a final-audit work order (decision K-3; R2 21:49-51: a mutation is detected only when the intended check fails for the
// intended reason; harness errors do not count). validateRedProof({cwd, auditedSha, acceptanceTest{file, title, expectedFailure},
// red{sha: R, record}, green{sha: F, record}}, {runner, timeoutMs, readFile}) proves, reading git first:
//   (a) R descends from auditedSha (E_RED_PROOF_ANCESTRY) and diff(auditedSha, R) is test-only (E_RED_PROOF_NOT_TEST_ONLY);
//   (d) F descends from R (E_RED_PROOF_ANCESTRY), no merge in R..F (E_RED_PROOF_MERGE), diff(R, F) has no test-only path
//       (E_RED_PROOF_TEST_CHANGED): the acceptance test and every updated test live in R, a later update-branch merge is never F;
//   (f) each record validates, names R / F as subject.commit (E_RECORD_SUBJECT) and its rawRef sha256 is the file bytes (E_RAW_HASH);
//   (c) the title is present in the file at R and at F (E_RED_PROOF_TITLE);
//   (b) at R the JUnit testcase (file via the dist->source mapping, title) exists (E_RED_PROOF_NO_CASE), FAILED (E_RED_PROOF_NOT_FAILED)
//       with type testCodeFailure (E_RED_PROOF_HARNESS), no harness sample in its message (E_RED_PROOF_HARNESS) and its message
//       matches expectedFailure (E_RED_PROOF_REASON);
//   (e) at F the same testcase PASSED: skipped or todo is E_GREEN_PROOF_SKIPPED, failed E_GREEN_PROOF.
// A7 test-only predicate: `(^|/)test/`, `.test|.spec` ts/mjs/js, `apps/web/e2e/`. Playwright reports are not read yet.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitStatus } from "./git.mjs";
import { casesOf } from "./junit.mjs";
import { fail, sha256Hex, validateRecord } from "./record.mjs";

export const TEST_ONLY_PATTERNS = Object.freeze([/(^|\/)test\//, /\.test\.(ts|mjs|js)$/, /\.spec\.(ts|mjs|js)$/, /^apps\/web\/e2e\//]);
export const HARNESS_SAMPLES = Object.freeze(["ERR_MODULE_NOT_FOUND", "Cannot find module", "does not provide an export named", "SyntaxError", "ERR_IMPORT"]);
export const HARNESS_TYPES = Object.freeze(["hookFailed", "testTimeoutFailure", "cancelledByParent"]);

export const isTestOnly = (path) => TEST_ONLY_PATTERNS.some((re) => re.test(path));

export function validateRedProof(input, { runner, timeoutMs, readFile = readFileSync } = {}) {
  const { cwd, auditedSha, acceptanceTest: test, red, green } = input;
  const g = (args, okCodes = [0]) => {
    const r = gitStatus(args, { cwd, runner, timeoutMs });
    if (!okCodes.includes(r.status)) throw fail("E_GIT", `git ${args.join(" ")} exited ${r.status}: ${r.stderr.trim()}`);
    return r;
  };
  const descends = (ancestor, descendant) => g(["merge-base", "--is-ancestor", ancestor, descendant], [0, 1]).status === 0;
  const changed = (a, b) => g(["diff", "--name-only", "--no-renames", "-z", a, b]).stdout.split("\0").filter(Boolean);

  // git reads
  if (!descends(auditedSha, red.sha)) throw fail("E_RED_PROOF_ANCESTRY", `${red.sha} does not descend from the audited ${auditedSha}`);
  const redPaths = changed(auditedSha, red.sha);
  const production = redPaths.filter((p) => !isTestOnly(p));
  if (production.length > 0) throw fail("E_RED_PROOF_NOT_TEST_ONLY", `audited..red changes production paths: ${production.join(", ")}`, { paths: production });
  if (!descends(red.sha, green.sha)) throw fail("E_RED_PROOF_ANCESTRY", `the fix head ${green.sha} does not descend from the red commit ${red.sha}`);
  const merges = g(["rev-list", "--merges", `${red.sha}..${green.sha}`]).stdout.split("\n").filter(Boolean);
  if (merges.length > 0) throw fail("E_RED_PROOF_MERGE", `red..fix has merge commits (${merges.join(", ")}): the fix head is the head before any merge of origin/main`, { merges });

  // the title exists in the test file at R and at F
  const titleAt = (sha) => {
    const shown = gitStatus(["show", `${sha}:${test.file}`], { cwd, runner, timeoutMs });
    const quoted = [JSON.stringify(test.title), `'${test.title}'`, `\`${test.title}\``];
    if (shown.status !== 0 || !quoted.some((q) => shown.stdout.includes(q))) throw fail("E_RED_PROOF_TITLE", `${test.file} at ${sha} has no test titled ${JSON.stringify(test.title)}`);
  };
  titleAt(red.sha);
  titleAt(green.sha);
  const fixTests = changed(red.sha, green.sha).filter(isTestOnly);
  if (fixTests.length > 0) throw fail("E_RED_PROOF_TEST_CHANGED", `red..fix changes test-only paths: ${fixTests.join(", ")}`, { paths: fixTests });

  // records and raw bytes
  const raw = {};
  for (const [side, entry] of [["red", red], ["green", green]]) {
    validateRecord(entry.record);
    if (entry.record.subject.commit !== entry.sha) throw fail("E_RECORD_SUBJECT", `the ${side} record names ${entry.record.subject.commit}, not ${entry.sha}`);
    const bytes = readFile(resolve(cwd, entry.record.rawRef.path));
    if (sha256Hex(bytes) !== entry.record.rawRef.sha256) throw fail("E_RAW_HASH", `the ${side} raw result ${entry.record.rawRef.path} differs from its record`);
    raw[side] = bytes.toString("utf8");
  }

  // JUnit
  const find = (side) => {
    const found = casesOf(raw[side], { repoRoot: cwd }).filter((c) => c.file === test.file && c.name === test.title);
    if (found.length === 0) throw fail("E_RED_PROOF_NO_CASE", `the ${side} JUnit report has no testcase ${test.file} :: ${JSON.stringify(test.title)}`);
    if (found.length > 1) throw fail("E_RED_PROOF_AMBIGUOUS", `the ${side} JUnit report has ${found.length} testcases ${test.file} :: ${JSON.stringify(test.title)}`);
    return found[0];
  };
  const redCase = find("red");
  if (redCase.outcome !== "FAILED") throw fail("E_RED_PROOF_NOT_FAILED", `at the red commit the test is ${redCase.outcome}, not FAILED`);
  if (redCase.type !== "testCodeFailure") throw fail("E_RED_PROOF_HARNESS", `the red failure is type ${redCase.type}: a harness failure, not the test failing`);
  const sample = HARNESS_SAMPLES.find((s) => (redCase.message ?? "").includes(s));
  if (sample) throw fail("E_RED_PROOF_HARNESS", `the red failure message contains the harness sample ${sample}`);
  let reason;
  try {
    reason = new RegExp(test.expectedFailure);
  } catch {
    throw fail("E_RED_PROOF_REASON", `expectedFailure ${test.expectedFailure} is not a regular expression`);
  }
  if (!reason.test(redCase.message ?? "")) throw fail("E_RED_PROOF_REASON", `the red failure message does not match ${test.expectedFailure}`);

  const greenCase = find("green");
  if (greenCase.outcome === "SKIPPED" || greenCase.outcome === "TODO") throw fail("E_GREEN_PROOF_SKIPPED", `at the fix head the test is ${greenCase.outcome}`);
  if (greenCase.outcome !== "PASSED") throw fail("E_GREEN_PROOF", `at the fix head the test is ${greenCase.outcome}, not PASSED`);
  return {
    red: { sha: red.sha, file: redCase.file, title: test.title, outcome: redCase.outcome, type: redCase.type, message: redCase.message },
    green: { sha: green.sha, file: greenCase.file, title: test.title, outcome: greenCase.outcome },
  };
}
