// tools/acceptance-touch.mjs (amendment A6 §2): the accepted packages a range of commits touches — by their files (case map,
// sidecar, design documents, cited test files and the source trees beside them) or by their registry cases and case-map rows —
// with the changes that reopen a package (a cited test or an own row) reported apart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedCaseRows, globToRegExp, packageGlobs, touched } from "../acceptance-touch.mjs";

const root = join(import.meta.dirname, "..", "..");

test("globs: ** crosses directories, * stays within a segment", () => {
  assert.ok(globToRegExp("packages/persistence/src/**").test("packages/persistence/src/execution/store.ts"));
  assert.ok(globToRegExp("docs/design/B08-*").test("docs/design/B08-case-map.md"));
  assert.ok(!globToRegExp("docs/design/B08-*").test("docs/design/B08/x.md"));
  assert.ok(!globToRegExp("packages/domain/src/**").test("packages/domain/test/x.test.ts"));
});

test("a package's files: its map, sidecar and design documents, every cited test file and the source tree beside it, and its extra globs", () => {
  const sidecar = JSON.parse(readFileSync(join(root, "docs/acceptance/case-maps/B08.json"), "utf8"));
  const { globs, tests } = packageGlobs("B08", sidecar, { B08: ["apps/worker/**"] });
  assert.ok(tests.includes("apps/control/test/job-admission.test.ts"));
  for (const g of ["docs/design/B08-*", "docs/acceptance/case-maps/B08.json", "apps/control/src/**", "apps/worker/**"]) assert.ok(globs.includes(g), g);
  assert.ok(!globs.some((g) => g.startsWith("golden ")), "a corpus label is not a file");
});

test("touched: a file in a package's globs or a changed case touches it; a cited test or an own row reopens it; an untouched package is not listed", () => {
  const accepted = [
    { package: "B07", status: "REVIEW_ACCEPTED", acceptedSubject: { commit: "a", reviewId: "B07-round7-a" } },
    { package: "B08", status: "REVIEW_ACCEPTED", acceptedSubject: { commit: "b", reviewId: "B08-round3-b" } },
    { package: "B09", status: "REVIEW_ACCEPTED", acceptedSubject: { commit: "c", reviewId: "B09-round5-c" } },
  ];
  const globsOf = (p) => ({ B07: { globs: ["packages/data-plane/src/**"], tests: [] }, B08: { globs: ["apps/control/src/**", "apps/control/test/a.test.ts"], tests: ["apps/control/test/a.test.ts"] }, B09: { globs: ["docs/design/B09-*"], tests: [] } })[p];
  const result = touched({
    accepted,
    changedFiles: ["apps/control/src/x.ts", "apps/control/test/a.test.ts", "README.md"],
    changedCases: [{ case: "S057", package: "B09" }],
    changedOwnRows: [{ case: "S057", package: "B09" }],
    globsOf,
  });
  assert.deepEqual(result.map((r) => [r.package, r.files, r.cases, r.reopen]), [
    ["B08", ["apps/control/src/x.ts", "apps/control/test/a.test.ts"], [], { citedTests: ["apps/control/test/a.test.ts"], ownRows: [] }],
    ["B09", [], ["S057"], { citedTests: [], ownRows: ["S057"] }],
  ]);
});

test("changed case rows through git: a changed registry record, a changed own row and an inherited row in another package's sidecar each touch the case's package; an unchanged row does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "touch-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "packages/contracts/registry"), { recursive: true });
    mkdirSync(join(dir, "docs/acceptance/case-maps"), { recursive: true });
    const cases = (expected) => JSON.stringify([{ id: "S001", expected }, { id: "S002", expected: "same" }, { id: "S003", expected: "same" }]);
    const sidecar = (pkg, rows) => JSON.stringify({ package: pkg, rows });
    writeFileSync(join(dir, "packages/contracts/registry/cases.json"), cases("one"));
    writeFileSync(join(dir, "docs/acceptance/case-maps/B01.json"), sidecar("B01", [{ case: "S002", class: "PARTIAL" }]));
    writeFileSync(join(dir, "docs/acceptance/case-maps/B02.json"), sidecar("B02", [{ case: "S003", class: "EXECUTED_LOCAL" }]));
    git("add", ".");
    git("commit", "-qm", "accepted");
    const from = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "packages/contracts/registry/cases.json"), cases("two"));
    writeFileSync(join(dir, "docs/acceptance/case-maps/B01.json"), sidecar("B01", [{ case: "S002", class: "EXECUTED_LOCAL" }]));
    writeFileSync(join(dir, "docs/acceptance/case-maps/B02.json"), sidecar("B02", [{ case: "S003", class: "EXECUTED_LOCAL" }, { case: "S001", class: "EXECUTED_PROVIDER", inheritedTo: ["B00"] }]));
    git("commit", "-qam", "later");
    const owner = new Map([["S001", "B00"], ["S002", "B01"], ["S003", "B02"]]);
    const { changedCases, changedOwnRows } = changedCaseRows(dir, from, "HEAD", owner);
    assert.deepEqual(changedCases.map((c) => `${c.package} ${c.case}`).sort(), ["B00 S001", "B00 S001", "B01 S002"]);
    assert.deepEqual(changedOwnRows, [{ case: "S002", package: "B01" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
