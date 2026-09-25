// tools/evidence.mjs — the durable evidence bundle (re-check finding N14). The parts that decide what a bundle claims are tested
// here without running the suites: the case map is read into exactly the 29 cases of B06, each citing tests that exist under
// exactly those names in the files it names; a JUnit report of node:test is read with its outcomes (names unescaped as the
// reporter escapes them); a compiled test file maps to its source; and a case is proven only when every cited test PASSED.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CASE_MAP_PATH, SUITES, canonical, caseResults, citationsOf, readCaseMap, readJunit, sourceOf } from "../evidence.mjs";

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

test("the suites the tool runs are the packages' own test scripts, and canonical JSON is key-order independent", () => {
  for (const suite of SUITES.filter((s) => s.script !== null)) {
    const pkg = JSON.parse(readFileSync(join(root, suite.cwd, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, suite.script, suite.cwd);
  }
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
});
