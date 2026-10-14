// tools/evidence.mjs — the durable evidence bundle (re-check finding N14). The parts that decide what a bundle claims are tested
// here without running the suites: the case map is read into exactly the 29 cases of B06, each citing tests that exist under
// exactly those names in the files it names; a JUnit report of node:test is read with its outcomes (names unescaped as the
// reporter escapes them); a compiled test file maps to its source; and a case is proven only when every cited test PASSED. Package
// B09 (implementation mandate M4): the tool also seals docs/design/B09-case-map.md — exactly the 30 cases of B09 — and a test its
// row plans (PLANNED, not on the branch yet) leaves its case unproven without failing the run, while a missing test of a row that
// plans nothing fails it.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { B09_CASE_MAP_PATH, CASE_MAPS, CASE_MAP_PATH, SUITES, canonical, caseResults, citationsOf, plansTests, readCaseMap, readJunit, sourceOf, verdictOf } from "../evidence.mjs";

const root = join(import.meta.dirname, "..", "..");
const rows = readCaseMap(readFileSync(CASE_MAP_PATH, "utf8"));

test("the case map reads as exactly the 29 cases of B06 (registry program.json), once each, every row citing at least one test", () => {
  const program = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "program.json"), "utf8"));
  const b06 = program.find((p) => p.id === "B06");
  assert.deepEqual(rows.map((r) => r.caseId).sort(), [...b06.caseIds].sort());
  for (const row of rows) {
    assert.ok(row.citations.length > 0, `${row.caseId} cites no test`);
    assert.ok(row.observes.length > 0, `${row.caseId} observes nothing`);
    assert.match(row.status, /^(EXECUTED_LOCAL \(integration\)|PARTIAL)/, row.caseId);
  }
});

test("every test the case map cites exists under exactly that name in the file it names", () => {
  const titlesOf = new Map();
  for (const row of rows) {
    for (const c of row.citations) {
      if (!titlesOf.has(c.file)) {
        const text = readFileSync(join(root, c.file), "utf8");
        titlesOf.set(c.file, new Set([...text.matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`))));
      }
      assert.ok(titlesOf.get(c.file).has(c.title), `${row.caseId}: ${c.file} :: "${c.title}" does not exist`);
    }
  }
});

test("a citation continues the file of the previous cell, and a title before any file is refused", () => {
  const first = citationsOf('`apps/api/test/a.test.ts` :: "one" and :: "two \\"quoted\\""', null);
  assert.deepEqual(first.citations, [{ file: "apps/api/test/a.test.ts", title: "one" }, { file: "apps/api/test/a.test.ts", title: 'two "quoted"' }]);
  assert.deepEqual(citationsOf(':: "three"', first.file).citations, [{ file: "apps/api/test/a.test.ts", title: "three" }]);
  assert.throws(() => citationsOf(':: "orphan"', null), /before any test file/);
});

test("a node:test JUnit report reads as its cases with their outcomes, names unescaped as the reporter escapes them; a compiled file maps to its source", () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<testsuites>",
    '\t<testcase name="first passes" time="0.1" classname="test" file="X"/>',
    '\t<testcase name="second &amp;quot;quoted&amp;quot; &amp; &lt;fails>" time="0.2" classname="test" file="X" failure="boom">',
    '\t\t<failure type="testCodeFailure" message="boom">stack</failure>',
    "\t</testcase>",
    '\t<testcase name="third skipped" time="0" classname="test" file="X">',
    '\t\t<skipped type="skipped" message="reason"/>',
    "\t</testcase>",
    "</testsuites>",
  ].join("\n");
  assert.deepEqual(readJunit(xml).map((c) => [c.name, c.outcome]), [
    ["first passes", "PASSED"],
    ['second "quoted" & <fails>', "FAILED"],
    ["third skipped", "SKIPPED"],
  ]);
  assert.equal(sourceOf(join(root, "apps", "api", "dist", "test", "reads.test.js")), "apps/api/test/reads.test.ts");
  assert.equal(sourceOf(join(root, "tools", "test", "matrix.test.mjs")), "tools/test/matrix.test.mjs");
});

test("a case is proven only when every cited test PASSED: a failed, skipped or missing citation leaves it unproven, and two tests of one file sharing a name are refused", () => {
  const row = { caseId: "S051", status: "EXECUTED_LOCAL (integration)", citations: [{ file: "f.test.ts", title: "a" }, { file: "f.test.ts", title: "b" }] };
  const results = (b) => [{ source: "f.test.ts", name: "a", outcome: "PASSED" }, ...(b === null ? [] : [{ source: "f.test.ts", name: "b", outcome: b }])];
  assert.equal(caseResults([row], results("PASSED"))[0].allPassed, true);
  for (const outcome of ["FAILED", "SKIPPED"]) assert.equal(caseResults([row], results(outcome))[0].allPassed, false, outcome);
  assert.deepEqual(caseResults([row], results(null))[0].tests.map((t) => t.outcome), ["PASSED", "MISSING"]);
  assert.throws(() => caseResults([row], [...results("PASSED"), { source: "f.test.ts", name: "a", outcome: "PASSED" }]), /share a name/);
});

test("the suites the tool runs are the packages' own test scripts, one for every workspace package that has one, and canonical JSON is key-order independent", () => {
  for (const suite of SUITES.filter((s) => s.script !== null)) {
    const pkg = JSON.parse(readFileSync(join(root, suite.cwd, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, suite.script, suite.cwd);
  }
  // the suites of `pnpm run test` (pnpm -r): every workspace package with a test script is one the tool runs
  const tested = ["packages", "apps"].flatMap((top) =>
    readdirSync(join(root, top))
      .map((name) => `${top}/${name}`)
      .filter((dir) => existsSync(join(root, dir, "package.json")) && JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")).scripts?.test !== undefined),
  );
  assert.deepEqual(SUITES.filter((s) => s.script !== null).map((s) => s.cwd).sort(), tested.sort(), "a workspace package's tests are a suite of the evidence run");
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("B09 (M4): the tool seals the B09 case map beside B06's, read as exactly the 30 cases of B09 (registry program.json) with the later packages each depends on; every cited test on the branch exists under exactly that name, and every other citation is in a row that plans it", () => {
  assert.deepEqual(CASE_MAPS.map((m) => [m.package, m.file]), [["B06", "docs/design/B06-case-map.md"], ["B09", "docs/design/B09-case-map.md"], ["B16", "docs/design/B16-case-map.md"]]);
  const program = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "program.json"), "utf8"));
  const b09 = readCaseMap(readFileSync(B09_CASE_MAP_PATH, "utf8"));
  assert.deepEqual(b09.map((r) => r.caseId).sort(), [...program.find((p) => p.id === "B09").caseIds].sort());
  assert.ok(rows.every((r) => r.later === undefined), "B06's five-column rows read as before");
  const titlesOf = new Map();
  for (const row of b09) {
    assert.ok(row.citations.length > 0 && row.observes.length > 0 && typeof row.later === "string", row.caseId);
    for (const c of row.citations) {
      if (!existsSync(join(root, c.file))) {
        assert.ok(plansTests(row), `${row.caseId}: ${c.file} is not on the branch and the row plans no test`);
        continue;
      }
      if (!titlesOf.has(c.file)) {
        const text = readFileSync(join(root, c.file), "utf8");
        titlesOf.set(c.file, new Set([...text.matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`))));
      }
      assert.ok(titlesOf.get(c.file).has(c.title), `${row.caseId}: ${c.file} :: "${c.title.slice(0, 80)}" does not exist`);
    }
  }
});

test("B09 (M4): a cited test not on the branch in a row with a PLANNED clause is PLANNED, never PASSED — its case is unproven and does not fail the run; a missing test of a row that plans nothing, or of a file on the branch, is MISSING and fails the run", () => {
  const planned = { caseId: "CMD030-OK", status: "**MISSING** (stage 1: …; M3 CMD030-OK) — PLANNED (M3) + SIMULATED", citations: [{ file: "apps/api/test/cmd030-payment-webhook.test.ts", title: "OK" }] };
  const partly = { caseId: "CMD028-OK", status: "**PARTIAL** (stage 1: …) — EXISTS + PLANNED (M4) + SIMULATED", citations: [{ file: "a.test.ts", title: "db" }, { file: "apps/api/test/cmd028-create-payment-order.test.ts", title: "OK" }] };
  const unplanned = { caseId: "CMD031-OK", status: "**EXECUTED_LOCAL** (stage 2, M4: …) — EXISTS", citations: [{ file: "apps/api/test/cmd031-request-refund.test.ts", title: "OK" }] };
  const results = [{ source: "a.test.ts", name: "db", outcome: "PASSED" }];
  // nothing of the planned files is on the branch
  const cases = caseResults([planned, partly, unplanned], results, (file) => file === "a.test.ts");
  assert.deepEqual(cases.map((c) => c.tests.map((t) => t.outcome)), [["PLANNED"], ["PASSED", "PLANNED"], ["MISSING"]]);
  const verdict = verdictOf(cases);
  assert.deepEqual([verdict.proven, verdict.planned, verdict.failing].map((list) => list.map((c) => c.caseId)), [[], ["CMD030-OK", "CMD028-OK"], ["CMD031-OK"]]);
  // a planned file that is on the branch but lacks the cited title is MISSING: the row's plan does not cover a written file
  const written = caseResults([planned], [], () => true);
  assert.deepEqual(written[0].tests.map((t) => t.outcome), ["MISSING"]);
  assert.deepEqual(verdictOf(written).failing.map((c) => c.caseId), ["CMD030-OK"]);
  // once the planned test ran and passed, its case is proven; a failed or skipped one fails the run whatever the row planned
  assert.equal(verdictOf(caseResults([planned], [{ source: planned.citations[0].file, name: "OK", outcome: "PASSED" }], () => true)).proven.length, 1);
  for (const outcome of ["FAILED", "SKIPPED"]) assert.equal(verdictOf(caseResults([partly], [...results, { source: partly.citations[1].file, name: "OK", outcome }], () => true)).failing.length, 1, outcome);
});
