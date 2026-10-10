// tools/acceptance-touch.mjs (amendment A6 §2): the accepted packages a range of commits touches — by their files (case map,
// sidecar, design documents, cited test files and the source trees beside them) or by their registry cases and case-map rows —
// with the changes that reopen a package (a cited test or an own row) reported apart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedCaseRows, globToRegExp, main, packageGlobs, readPackageGlobs, touched, unattributed } from "../acceptance-touch.mjs";
import { loadRegistry } from "../ledger.mjs";

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
  for (const g of ["docs/design/B08-*", "apps/control/src/**", "apps/worker/**"]) assert.ok(globs.includes(g), g);
  assert.ok(!globs.includes("docs/acceptance/case-maps/B08.json"), "the sidecar is compared row by row, not as a file");
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

// --- a repository with a synthetic program: B00 accepted at X (its review recorded at Y), B01 not accepted ------------------------
// `external`: B01's map is external (MC, pinned at PIN, no sidecar) and its accepting review, bound to PIN, is recorded at Y too.
// `globsLater`: the attribution file does not exist at X yet; Y adds it.

const PIN = "3b4b0aea4f1879ffb4189a55a16f22f4520787d4";
const MC = { id: "MC", flag: "mc", repository: "kauro-migration-core", path: "docs/design/B01-B02-case-map.md", commit: PIN, format: "table", packages: ["B01"] };
const SNAP = `docs/acceptance/ledger/external/MC-${PIN.slice(0, 12)}.json`;
const snapshot = (test = ["test/mc.test.ts :: refuses"]) => ({ id: "MC", repository: MC.repository, path: MC.path, commit: PIN, packages: ["B01"], rows: [{ case: "S003", class: "EXECUTED_LOCAL", test, commit: PIN.slice(0, 7), reviewId: null, inheritedTo: [] }] });
const GLOBS = "docs/acceptance/ledger/package-globs.json";

function fixture({ external = false, globsLater = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "touch-"));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "core.quotepath=off", ...a], { encoding: "utf8" }).trim();
  const write = (path, value) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 1)}\n`);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const reg = "packages/contracts/registry";
  const program = [
    { id: "B00", title: "zero", dependsOn: [], caseIds: ["S001", "S002"] },
    { id: "B01", title: "one", dependsOn: ["B00"], caseIds: ["S003"] },
  ];
  write(`${reg}/program.json`, program);
  write(`${reg}/cases.json`, ["S001", "S002", "S003"].map((id) => ({ id, gate: "G-X", expected: "one" })));
  write(`${reg}/additional_scenarios.json`, []);
  write(`${reg}/gates.json`, [{ id: "G-X", owner: "21", package: "B00", caseIds: ["S001", "S002", "S003"], evidenceRule: "r" }]);
  write(`${reg}/PROVENANCE.json`, { files: {} });
  write("docs/acceptance/ledger/inputs.json", { external: external ? [MC] : [] });
  const globs = { shared: ["package.json"], packages: { B00: ["src/**"], B01: ["lib/**"] } };
  if (!globsLater) write(GLOBS, globs);
  if (external) write(SNAP, snapshot());
  write("package.json", "{}\n");
  write("src/a.ts", "export const a = 1;\n");
  write("lib/b.ts", "export const b = 1;\n");
  write("test/a.test.ts", "test('a', () => {});\n");
  const row = (id, extra = {}) => ({ case: id, class: "EXECUTED_LOCAL", test: ["test/a.test.ts :: a"], commit: null, reviewId: null, inheritedTo: [], ...extra });
  write("docs/acceptance/case-maps/B00.json", { package: "B00", rows: [row("S001"), row("S002")] });
  if (!external) write("docs/acceptance/case-maps/B01.json", { package: "B01", rows: [{ case: "S003", class: "NOT_EXECUTED", test: [], commit: null, reviewId: null, inheritedTo: [] }] });
  const X = commit("accepted subject");
  const reviewId = `B00-round1-${X.slice(0, 7)}`;
  write(`docs/acceptance/reviews/${reviewId}.json`, { verdict: "ACCEPT", cases: ["S001", "S002"].map((id) => ({ id, claimed_status: "EXECUTED_LOCAL", agree: true })) });
  const ownRows = (extra = {}) => [row("S001", { reviewId, commit: X.slice(0, 7), ...extra }), row("S002", { reviewId, commit: X.slice(0, 7) })];
  write("docs/acceptance/case-maps/B00.json", { package: "B00", rows: ownRows() });
  if (globsLater) write(GLOBS, globs);
  if (external) write(`docs/acceptance/reviews/B01-round1-${PIN.slice(0, 7)}.json`, { verdict: "ACCEPT", cases: [{ id: "S003", claimed_status: "EXECUTED_LOCAL", agree: true }] });
  const Y = commit("review recorded");
  const run = (...argv) => {
    const lines = [];
    const code = main([...argv, "--json"], dir, (l) => lines.push(l));
    return { code, out: code === 2 ? lines.join("\n") : JSON.parse(lines.join("\n")) };
  };
  return { dir, git, write, commit, X, Y, run, reg, program, globs, ownRows, reviewId, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("PR18-6 (T6): main end to end — the ACCEPTED package (not only REVIEW_ACCEPTED) is diffed; recording its review touches nothing; a later change to its files touches it; an unresolvable target is exit 2", () => {
  const f = fixture();
  try {
    const atY = f.run(f.Y);
    assert.equal(atY.code, 0);
    assert.deepEqual(atY.out.touched, [], "the review and the reviewId/commit bookkeeping of its rows are not a change");
    f.write("src/a.ts", "export const a = 2;\n");
    f.commit("change");
    const later = f.run();
    assert.deepEqual(later.out.touched.map((t) => [t.package, t.status, t.files]), [["B00", "ACCEPTED", ["src/a.ts"]]]);
    assert.equal(f.run("no-such-ref").code, 2);
  } finally {
    f.done();
  }
});

test("PR18-1: a renamed cited test is seen under both names and reopens the package; a non-ASCII path is matched verbatim", () => {
  const f = fixture();
  try {
    f.git("mv", "test/a.test.ts", "test/z.test.ts");
    f.write("src/ñandú.ts", "export const n = 1;\n");
    f.commit("rename and non-ASCII");
    const [b00] = f.run().out.touched;
    assert.equal(b00.package, "B00");
    assert.deepEqual(b00.reopen.citedTests, ["test/a.test.ts"]);
    assert.ok(b00.files.includes("src/ñandú.ts"), `files: ${b00.files.join(", ")}`);
  } finally {
    f.done();
  }
});

test("PR18-6 (T4): a change to a cited test alone, with no source change, touches the package and reopens it", () => {
  const f = fixture();
  try {
    f.write("test/a.test.ts", "test('a', () => { /* changed */ });\n");
    f.commit("test only");
    assert.deepEqual(f.run().out.touched.map((t) => [t.package, t.files, t.reopen.citedTests]), [["B00", ["test/a.test.ts"], ["test/a.test.ts"]]]);
  } finally {
    f.done();
  }
});

test("PR18-3 (a): each package is diffed from its own accepted subject — a later left bound never hides an earlier change", () => {
  const f = fixture();
  try {
    f.write("docs/design/B00-notes.md", "a design note\n");
    const edit = f.commit("design edit");
    f.write("docs/other.md", "unrelated\n");
    f.commit("unrelated");
    const [b00] = f.run(`${f.git("rev-parse", "HEAD~1")}..HEAD`).out.touched;
    assert.equal(b00?.package, "B00");
    assert.deepEqual(b00.files, ["docs/design/B00-notes.md"]);
    assert.ok(edit);
  } finally {
    f.done();
  }
});

test("PR18-4 and PR18-6 (T3): a case added to, removed from or moved between packages, and a registry record changed or deleted, touch the old and new owner; an own row changed reopens; an unreadable registry revision is an error", () => {
  const f = fixture();
  try {
    const moved = [{ ...f.program[0], caseIds: ["S001", "S004"] }, { ...f.program[1], caseIds: ["S002", "S003"] }];
    f.write(`${f.reg}/program.json`, moved);
    f.write(`${f.reg}/cases.json`, [{ id: "S002", gate: "G-X", expected: "one" }, { id: "S003", gate: "G-X", expected: "two" }]);
    f.commit("move S002 to B01, add S004 to B00, delete S001's record, change S003's record");
    const { changedCases } = changedCaseRows(f.dir, f.X, "HEAD", loadRegistry(f.dir));
    const by = (pkg) => [...new Set(changedCases.filter((c) => c.package === pkg).map((c) => c.case))].sort();
    assert.deepEqual(by("B00"), ["S001", "S002", "S004"]);
    assert.deepEqual(by("B01"), ["S002", "S003"]);
    f.write("docs/acceptance/case-maps/B00.json", { package: "B00", rows: [{ case: "S001", class: "PARTIAL", test: ["test/a.test.ts :: a"], commit: null, reviewId: null, inheritedTo: ["B01"] }] });
    f.commit("row changed");
    assert.deepEqual(changedCaseRows(f.dir, f.Y, "HEAD", loadRegistry(f.dir)).changedOwnRows.map((r) => r.case).sort(), ["S001", "S002"]);
    const registry = loadRegistry(f.dir);
    f.git("rm", "-q", `${f.reg}/program.json`);
    f.commit("registry file gone");
    assert.throws(() => changedCaseRows(f.dir, f.X, "HEAD", registry), /program\.json cannot be read at HEAD/);
  } finally {
    f.done();
  }
});

test("PR18-2: a changed non-doc file no package and no shared glob owns fails the run; the attribution file is required", () => {
  const f = fixture();
  try {
    f.write("infra/main.tf", "# a new area\n");
    f.commit("new area");
    const r = f.run();
    assert.equal(r.code, 1);
    assert.deepEqual(r.out.unattributed, ["infra/main.tf"]);
    f.git("rm", "-q", "docs/acceptance/ledger/package-globs.json");
    f.commit("no attribution");
    assert.throws(() => f.run(), /package-globs\.json is missing/);
  } finally {
    f.done();
  }
});

test("PR18-2: every tracked non-doc file of this repository is attributed to a package or to the shared list, and B's reproductions (migrations, authorization, contracts, lockfile, a package manifest) touch B06", () => {
  const globs = readPackageGlobs(root);
  const sidecar = (p) => JSON.parse(readFileSync(join(root, "docs/acceptance/case-maps", `${p}.json`), "utf8"));
  const sets = Object.keys(globs.packages).map((p) => packageGlobs(p, sidecar(p), globs.packages).globs);
  const tracked = execFileSync("git", ["-C", root, "-c", "core.quotepath=off", "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 500);
  assert.deepEqual(unattributed(tracked, sets, globs.shared), []);
  const b06 = [...packageGlobs("B06", sidecar("B06"), globs.packages).globs, ...globs.shared].map(globToRegExp);
  for (const f of ["packages/persistence/migrations/0002_identity_agencies_memberships.sql", "packages/authorization/src/index.ts", "packages/contracts/src/index.ts", "pnpm-lock.yaml", "packages/domain/package.json"]) {
    assert.ok(b06.some((r) => r.test(f)), `${f} touches B06`);
  }
});

test("an inherited row in another package's sidecar touches the case's owner but is not its own row; a changed record and a changed own row each touch their package; an unchanged row does not (the pre-PR18 test, on the fixture)", () => {
  const f = fixture();
  try {
    f.write(`${f.reg}/cases.json`, [{ id: "S001", gate: "G-X", expected: "two" }, { id: "S002", gate: "G-X", expected: "one" }, { id: "S003", gate: "G-X", expected: "one" }]);
    f.write("docs/acceptance/case-maps/B01.json", {
      package: "B01",
      rows: [
        { case: "S003", class: "PARTIAL", test: [], commit: null, reviewId: null, inheritedTo: ["B00"] },
        { case: "S002", class: "EXECUTED_PROVIDER", test: ["test/a.test.ts :: a"], commit: null, reviewId: null, inheritedTo: ["B00"] },
      ],
    });
    f.commit("record S001 changed, B01's own row S003 changed, B01 inherits a row for B00's S002");
    const { changedCases, changedOwnRows } = changedCaseRows(f.dir, f.Y, "HEAD", loadRegistry(f.dir));
    assert.deepEqual(changedCases.map((c) => `${c.package} ${c.case}`).sort(), ["B00 S001", "B00 S002", "B01 S003"]);
    assert.deepEqual(changedOwnRows, [{ case: "S003", package: "B01" }]);
  } finally {
    f.done();
  }
});

// --- the family "evidence" (a false not-touched verdict): every scope path the tool can see -----------------------------------------
// One row per path: the change made in a commit after Y and the outcome it must have. A path is either loud (an accepted package it
// belongs to is listed, or the run fails) or listed here as inert with its reason. Every tracked file of the fixture and every
// repository input the tool reads (SCOPE_INPUTS) must have a row, so a new path or a new input without a row fails this test.
const FAMILY = [
  { path: "src/a.ts", why: "B00's package glob", change: (f) => f.write("src/a.ts", "export const a = 2;\n"), code: 0, touched: ["B00"] },
  { path: "test/a.test.ts", why: "B00's cited test", change: (f) => f.write("test/a.test.ts", "test('a', () => { /* changed */ });\n"), code: 0, touched: ["B00"] },
  { path: "lib/b.ts", why: "the package glob of B01, an accepted external package", change: (f) => f.write("lib/b.ts", "export const b = 2;\n"), code: 0, touched: ["B01"] },
  { path: "package.json", why: "a shared glob touches every accepted package (ADV-3)", change: (f) => f.write("package.json", "{ \"x\": 1 }\n"), code: 0, touched: ["B00", "B01"] },
  { path: GLOBS, why: "re-attribution: src/** moved from B00 to B01 in the commit that edits src/a.ts (ADV-1)", change: (f) => { f.write(GLOBS, { ...f.globs, packages: { B00: [], B01: ["lib/**", "src/**"] } }); f.write("src/a.ts", "export const a = 2;\n"); }, code: 0, touched: ["B00", "B01"] },
  { path: GLOBS, why: "a package's globs changed alone (ADV-1)", change: (f) => f.write(GLOBS, { ...f.globs, packages: { ...f.globs.packages, B00: ["src/**", "tools/**"] } }), code: 0, touched: ["B00"] },
  { path: GLOBS, why: "the shared list changed alone (ADV-1)", change: (f) => f.write(GLOBS, { ...f.globs, shared: [] }), code: 0, touched: ["B00", "B01"] },
  { path: "docs/acceptance/ledger/inputs.json", why: "the pin of B01's external map moved (ADV-2)", change: (f) => f.write("docs/acceptance/ledger/inputs.json", { external: [{ ...MC, commit: "1111111aea4f1879ffb4189a55a16f22f4520787d" }] }), code: 0, touched: ["B01"] },
  { path: SNAP, why: "B01's external snapshot (ADV-2)", change: (f) => f.write(SNAP, snapshot(["test/mc.test.ts :: refuses twice"])), code: 0, touched: ["B01"] },
  { path: "docs/acceptance/case-maps/B00.json", why: "B00's own row: a citation added", change: (f) => f.write("docs/acceptance/case-maps/B00.json", { package: "B00", rows: f.ownRows({ test: ["test/a.test.ts :: a", "test/a.test.ts :: b"] }) }), code: 0, touched: ["B00"] },
  { path: "docs/acceptance/case-maps/B00.json", why: "B00's own row: a class its review does not accept (the package stops computing as accepted; it is still listed)", change: (f) => f.write("docs/acceptance/case-maps/B00.json", { package: "B00", rows: f.ownRows({ class: "PARTIAL", inheritedTo: ["B01"] }) }), code: 0, touched: ["B00"] },
  { path: "docs/design/B00-notes.md", why: "B00's design documents", change: (f) => f.write("docs/design/B00-notes.md", "a note\n"), code: 0, touched: ["B00"] },
  { path: "packages/contracts/registry/program.json", why: "a case moved between packages (old and new owner); the registry file has no owner in the fixture", change: (f) => f.write(`${f.reg}/program.json`, [{ ...f.program[0], caseIds: ["S001"] }, { ...f.program[1], caseIds: ["S002", "S003"] }]), code: 1, touched: ["B00", "B01"] },
  { path: "packages/contracts/registry/cases.json", why: "a case record changed", change: (f) => f.write(`${f.reg}/cases.json`, [{ id: "S001", gate: "G-X", expected: "two" }, { id: "S002", gate: "G-X", expected: "one" }, { id: "S003", gate: "G-X", expected: "one" }]), code: 1, touched: ["B00"] },
  { path: "packages/contracts/registry/additional_scenarios.json", why: "a scenario record added for a case", change: (f) => f.write(`${f.reg}/additional_scenarios.json`, [{ id: "S003", note: "x" }]), code: 1, touched: ["B01"] },
  { path: "packages/contracts/registry/gates.json", why: "an unowned non-doc file fails the run", change: (f) => f.write(`${f.reg}/gates.json`, [{ id: "G-X", owner: "21", package: "B00", caseIds: ["S001", "S002", "S003"], evidenceRule: "r2" }]), code: 1, touched: [] },
  { path: "packages/contracts/registry/PROVENANCE.json", why: "an unowned non-doc file fails the run", change: (f) => f.write(`${f.reg}/PROVENANCE.json`, { files: {}, note: "x" }), code: 1, touched: [] },
  { path: "infra/main.tf", why: "a new non-doc file no glob owns fails the run", change: (f) => f.write("infra/main.tf", "# x\n"), code: 1, touched: [] },
  { path: "docs/acceptance/reviews/", why: "INERT: a review is the acceptance itself (it moves the subject, it is not a change after it)", change: (f) => f.write(`docs/acceptance/reviews/${f.reviewId}.json`, { verdict: "ACCEPT", note: "x", cases: ["S001", "S002"].map((id) => ({ id, claimed_status: "EXECUTED_LOCAL", agree: true })) }), code: 0, touched: [] },
  { path: "docs/other.md", why: "INERT: a document of no package", change: (f) => f.write("docs/other.md", "x\n"), code: 0, touched: [] },
];

test("family evidence: every scope path acceptance-touch can see is loud (an accepted package it belongs to is listed, or the run fails) or inert by a stated reason, and every tracked file and every input the tool reads has a row", async () => {
  const touch = await import("../acceptance-touch.mjs");
  const covered = (p) => FAMILY.some((r) => r.path === p || (r.path.endsWith("/") && p.startsWith(r.path)));
  const base = fixture({ external: true });
  try {
    const tracked = base.git("ls-files", "-z").split("\0").filter(Boolean);
    assert.deepEqual(tracked.filter((p) => !covered(p)), [], "every tracked file has a family row");
    const atY = base.run();
    assert.deepEqual([atY.code, atY.out.touched], [0, []], `the fixture at Y is clean: ${JSON.stringify(atY.out)}`);
  } finally {
    base.done();
  }
  const wrong = [];
  for (const r of FAMILY) {
    const f = fixture({ external: true });
    try {
      r.change(f);
      f.commit(r.why);
      const { code, out } = f.run();
      const got = code === 2 ? `exit 2: ${out}` : JSON.stringify([code, out.touched.map((t) => t.package)]);
      if (got !== JSON.stringify([r.code, r.touched])) wrong.push(`${r.path} (${r.why}): expected ${JSON.stringify([r.code, r.touched])}, got ${got}`);
    } finally {
      f.done();
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(Array.isArray(touch.SCOPE_INPUTS) && touch.SCOPE_INPUTS.length > 0, "acceptance-touch.mjs exports SCOPE_INPUTS, the repository inputs it reads");
  for (const input of touch.SCOPE_INPUTS) assert.ok(FAMILY.some((r) => r.path.startsWith(input) || input.startsWith(r.path)), `no family row for the input ${input}`);
});

test("ADV-1: a re-attribution in package-globs.json never hides a change — the globs at the package's subject and at the target are united, a package whose globs (or the shared list) changed is touched, and a package accepted before the file existed is compared with the file's first version", () => {
  const f = fixture();
  try {
    f.write(GLOBS, { ...f.globs, packages: { B00: [], B01: ["lib/**", "src/**"] } });
    f.write("src/a.ts", "export const a = 2;\n");
    f.commit("move src/** to B01 and edit src/a.ts");
    const r = f.run();
    assert.deepEqual([r.code, r.out.touched.map((t) => [t.package, t.files])], [0, [["B00", [GLOBS, "src/a.ts"]]]]);
  } finally {
    f.done();
  }
  const g = fixture();
  try {
    g.write(GLOBS, { ...g.globs, packages: { B00: [], B01: ["lib/**", "src/**"] } });
    g.commit("move src/** to B01");
    g.write("src/a.ts", "export const a = 2;\n");
    g.commit("edit src/a.ts later");
    assert.deepEqual(g.run(`${g.git("rev-parse", "HEAD~1")}..HEAD`).out.touched.map((t) => [t.package, t.files]), [["B00", [GLOBS, "src/a.ts"]]], "the left bound never narrows B00's range");
  } finally {
    g.done();
  }
  const h = fixture({ globsLater: true });
  try {
    assert.deepEqual(h.run().out.touched, [], "adding the attribution file is not a change of B00's globs");
    h.write(GLOBS, { ...h.globs, packages: { B00: [], B01: ["lib/**", "src/**"] } });
    h.write("src/a.ts", "export const a = 2;\n");
    h.commit("move src/** to B01 and edit src/a.ts");
    assert.deepEqual(h.run().out.touched.map((t) => [t.package, t.files]), [["B00", [GLOBS, "src/a.ts"]]]);
  } finally {
    h.done();
  }
});

