// The acceptance ledger (tools/ledger.mjs, amendment A4 "the 441-case ledger is computed by a tool"): the single row schema of
// the sidecars and their mechanical conversion from the case maps, every registry case exactly once, the external maps pinned
// to a path and a commit, every failure the ledger must refuse (each with its negative control), the package status computed
// from program.json dependencies, and the committed outputs equal to a fresh computation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { readCaseMap } from "../evidence.mjs";
import {
  CLASSES,
  citationsIn,
  computeLedger,
  convertExternal,
  convertStatusBlocks,
  convertTableMap,
  ledgerFiles,
  ledgerOfRepo,
  loadRegistry,
  main,
  readInputs,
  readPinned,
  readSidecars,
  reviewCommitViolations,
  reviewIndex,
} from "../ledger.mjs";

const root = join(import.meta.dirname, "..", "..");
const registry = loadRegistry(root);
const read = (p) => readFileSync(join(root, p), "utf8");

// --- a synthetic program for the negative controls ---------------------------------------------------------------------------------

/** A registry of four packages: P0 ← P1 ← P2, and B20 after P2; two cases each. */
function fixtureRegistry() {
  const program = [
    { id: "B00", title: "zero", dependsOn: [], caseIds: ["S001", "S002"] },
    { id: "B01", title: "one", dependsOn: ["B00"], caseIds: ["S003", "S004"] },
    { id: "B02", title: "two", dependsOn: ["B01"], caseIds: ["S005", "S006"] },
    { id: "B20", title: "after launch", dependsOn: ["B02"], caseIds: ["S007", "S008"] },
  ];
  const cases = new Map(program.flatMap((p) => p.caseIds.map((id) => [id, { id, gate: `G-${p.id}`, package: p.id }])));
  const owner = new Map(program.flatMap((p) => p.caseIds.map((id) => [id, p.id])));
  const gates = program.map((p) => ({ id: `G-${p.id}`, owner: "21", package: p.id, caseIds: p.caseIds, evidenceRule: "rule" }));
  return { program, cases, owner, gates, provenance: { files: { "cases.json": "aa" } }, hashes: { "cases.json": "aa" } };
}
const row = (id, klass, extra = {}) => ({ case: id, class: klass, test: [`t.test.ts :: ${id}`], commit: null, reviewId: null, inheritedTo: [], ...extra });
const review = (pkg, round, verdict, cases, commit = `c${pkg}${round}`) => ({ id: `${pkg}-round${round}-${commit}`, package: pkg, round, commit, verdict, cases });
/** A clean fixture: every package reviewed and accepted, B20 planned after launch with the owner's date. */
function clean() {
  const reviews = ["B00", "B01", "B02"].map((p, i) => review(p, 1, "ACCEPT", fixtureRegistry().program[i].caseIds.map((id) => ({ id, claimed_status: "EXECUTED_LOCAL", agree: true }))));
  const sidecars = ["B00", "B01", "B02"].map((p, i) => ({
    package: p,
    rows: fixtureRegistry().program[i].caseIds.map((id) => row(id, "EXECUTED_LOCAL", { reviewId: reviews[i].id, commit: reviews[i].commit })),
  }));
  sidecars.push({ package: "B20", rows: ["S007", "S008"].map((id) => row(id, "PLANNED_POST_B19", { test: [], ownerDate: "2026-11-30" })) });
  return { registry: fixtureRegistry(), sidecars, reviews };
}
const kinds = (ledger) => ledger.violations.map((v) => `${v.kind} ${v.subject}`).sort();

test("the clean fixture has no violation: every case demonstrated with its review id and commit, every package ACCEPTED through its dependencies", () => {
  const ledger = computeLedger(clean());
  assert.deepEqual(kinds(ledger), []);
  assert.deepEqual(ledger.packages.map((p) => p.status), ["ACCEPTED", "ACCEPTED", "ACCEPTED", "NOT_STARTED"]);
  const s003 = ledger.cases.find((c) => c.case === "S003");
  assert.deepEqual([s003.demonstrated, s003.reviewId, s003.commit], ["EXECUTED_LOCAL", "B01-round1-cB011", "cB011"]);
  assert.deepEqual(ledger.gates.find((g) => g.gate === "G-B01").acceptedSubjects, [{ package: "B01", commit: "cB011", reviewId: "B01-round1-cB011" }]);
});

test("a missing case fails: a case of the registry without a row, a duplicated row, a row for a case the registry does not have", () => {
  const f = clean();
  f.sidecars[1].rows.pop();
  f.sidecars[0].rows.push(row("S001", "EXECUTED_LOCAL"), row("S999", "EXECUTED_LOCAL"));
  const ledger = computeLedger(f);
  assert.deepEqual(kinds(ledger), ["DUPLICATE_CASE S001", "MISSING_CASE S004", "UNKNOWN_CASE S999"]);
  assert.equal(ledger.packages.find((p) => p.package === "B01").status, "INCOMPLETE_MAP");
  const unavailable = computeLedger({ ...clean(), sidecars: clean().sidecars.filter((s) => s.package !== "B02"), missingInputs: [{ id: "MC", packages: ["B02"], reason: "not pinned" }] });
  assert.match(unavailable.violations.find((v) => v.subject === "S005").detail, /input MC unavailable \(not pinned\)/);
});

test("a cross citation without the inherited mark fails: a row for another package's case must name that package in inheritedTo; a PARTIAL row must name who carries the rest", () => {
  const f = clean();
  f.sidecars[2].rows.push(row("S003", "EXECUTED_LOCAL"));
  f.sidecars[1].rows[0] = row("S003", "PARTIAL");
  assert.deepEqual(kinds(computeLedger(f)), ["CROSS_CITATION_WITHOUT_INHERITED S003", "REMAINDER_WITHOUT_OWNER S003"]);
  // the control: marked, the inherited row strengthens the case's claimed class and the PARTIAL row names its heir
  const g = clean();
  g.sidecars[2].rows.push(row("S003", "EXECUTED_LOCAL", { inheritedTo: ["B01"] }));
  g.sidecars[1].rows[0] = row("S003", "PARTIAL", { inheritedTo: ["B02"] });
  const ledger = computeLedger(g);
  assert.deepEqual(kinds(ledger), []);
  assert.equal(ledger.cases.find((c) => c.case === "S003").claimed, "EXECUTED_LOCAL");
  assert.equal(ledger.cases.find((c) => c.case === "S003").demonstrated, null, "the inherited row is not reviewed: claimed, not demonstrated");
});

test("a PASS without review fails: a review id that does not exist, that rejects, that is not the package's latest round or whose entry disagrees with the row's class", () => {
  for (const [label, mutate] of [
    ["unknown review", (f) => { f.sidecars[0].rows[0].reviewId = "B00-round9-x"; }],
    ["rejecting review", (f) => { f.reviews[0].verdict = "REJECT"; }],
    ["superseded round", (f) => { f.reviews.push(review("B00", 2, "ACCEPT", [])); }],
    ["disagreeing entry", (f) => { f.reviews[0].cases[0].agree = false; }],
    ["other class", (f) => { f.reviews[0].cases[0].claimed_status = "PARTIAL"; }],
  ]) {
    const f = clean();
    mutate(f);
    const ledger = computeLedger(f);
    assert.ok(ledger.violations.some((v) => v.kind === "PASS_WITHOUT_REVIEW" && v.subject === "S001"), label);
    assert.equal(ledger.cases.find((c) => c.case === "S001").demonstrated, null, `${label}: not demonstrated`);
  }
});

test("a re-check covers only its findings (A4 (c)): a case's verdict is its latest entry across the rounds, the subject is the latest accepting round", () => {
  const f = clean();
  f.reviews[1] = review("B01", 1, "REJECT", [{ id: "S003", claimed_status: "EXECUTED_LOCAL", agree: true }, { id: "S004", claimed_status: "EXECUTED_LOCAL", agree: false }]);
  f.reviews.push(review("B01", 2, "ACCEPT", [{ id: "S004", claimed_status: "EXECUTED_LOCAL", agree: true }], "fix1"));
  f.sidecars[1].rows = f.sidecars[1].rows.map((r) => ({ ...r, reviewId: "B01-round2-fix1", commit: "fix1" }));
  const ledger = computeLedger(f);
  assert.deepEqual(kinds(ledger), []);
  assert.deepEqual(ledger.packages.find((p) => p.package === "B01").acceptedSubject, { commit: "fix1", reviewId: "B01-round2-fix1" });
  const { reviewOf } = reviewIndex(f.reviews);
  assert.equal(reviewOf("B01", "S003", "EXECUTED_LOCAL")?.id, "B01-round2-fix1");
  f.reviews[f.reviews.length - 1].cases.push({ id: "S003", agree: false });
  assert.equal(reviewIndex(f.reviews).reviewOf("B01", "S003", "EXECUTED_LOCAL"), null, "a later disagreeing entry withdraws the case");
});

test("a PLANNED case outside B20/B21 fails; in B20/B21 the only planned class is PLANNED_POST_B19 and it needs the owner's date", () => {
  const f = clean();
  f.sidecars[1].rows[0] = row("S003", "PLANNED");
  f.sidecars[3].rows[0] = row("S007", "PLANNED");
  f.sidecars[3].rows[1].ownerDate = null;
  assert.deepEqual(kinds(computeLedger(f)), ["OWNER_DATE_MISSING S008", "PLANNED_OUTSIDE_B20_B21 S003", "POST_LAUNCH_CLASS S007"]);
  const g = clean();
  g.sidecars[0].rows[0] = row("S001", "PLANNED_POST_B19", { ownerDate: "2026-11-30" });
  assert.deepEqual(kinds(computeLedger(g)), ["PLANNED_OUTSIDE_B20_B21 S001"]);
});

test("a package is REVIEW_ACCEPTED until every dependency is ACCEPTED, and names what it waits for nearest first", () => {
  const f = clean();
  f.reviews = f.reviews.filter((r) => r.package !== "B00");
  f.sidecars[0].rows = f.sidecars[0].rows.map((r) => ({ ...r, reviewId: null }));
  const ledger = computeLedger(f);
  assert.deepEqual(ledger.packages.map((p) => [p.package, p.status, p.waitingFor]), [
    ["B00", "IN_PROGRESS", ""],
    ["B01", "REVIEW_ACCEPTED", "B00"],
    ["B02", "REVIEW_ACCEPTED", "B01 → B00"],
    ["B20", "NOT_STARTED", ""],
  ]);
});

test("an inherited obligation left open keeps the receiving package from acceptance; COVERED or an owner-signed NOT_APPLICABLE releases it", () => {
  const f = clean();
  f.sidecars[2].obligations = [{ id: "B10-CELL-1", from: "B10", status: "OPEN" }];
  let ledger = computeLedger(f);
  assert.deepEqual(kinds(ledger), ["OPEN_INHERITED_OBLIGATION B10-CELL-1"]);
  assert.equal(ledger.packages.find((p) => p.package === "B02").status, "IN_PROGRESS");
  f.sidecars[2].obligations = [{ id: "B10-CELL-1", from: "B10", status: "NOT_APPLICABLE", reason: "r" }];
  assert.deepEqual(kinds(computeLedger(f)), ["OPEN_INHERITED_OBLIGATION B10-CELL-1"], "NOT_APPLICABLE needs the owner's signature");
  f.sidecars[2].obligations = [{ id: "B10-CELL-1", from: "B10", status: "NOT_APPLICABLE", reason: "r", ownerSigned: "2026-10-12" }];
  assert.deepEqual(kinds(computeLedger(f)), []);
});

test("a changed vendored registry fails against PROVENANCE.json", () => {
  const f = clean();
  f.registry.hashes["cases.json"] = "bb";
  assert.deepEqual(kinds(computeLedger(f)), ["REGISTRY_HASH_MISMATCH cases.json"]);
});

// --- reading the case maps ---------------------------------------------------------------------------------------------------------

test("citations: carried files, `and ::` continuations, MC's backticked titles and golden corpora, nested describe :: it titles", () => {
  assert.deepEqual([...citationsIn('`a/x.test.ts` :: "one" and :: "two"; `b/y.test.ts` :: "three"')], ["a/x.test.ts :: one", "a/x.test.ts :: two", "b/y.test.ts :: three"]);
  assert.deepEqual([...citationsIn(':: "carried"', "c/z.test.ts")], ["c/z.test.ts :: carried"]);
  assert.deepEqual([...citationsIn("`test/u.test.ts` :: `t1`; `t2`. golden `G17-x` :: `delivers`")], ["test/u.test.ts :: t1", "test/u.test.ts :: t2", "golden G17-x :: delivers"]);
  assert.deepEqual([...citationsIn('`e/s.spec.ts` :: "describe" :: "it"')], ["e/s.spec.ts :: describe :: it"]);
  assert.deepEqual([...citationsIn("the `b07/integration` branch and \"a quote\"")], []);
});

test("the sidecars of B06 and B09 cite exactly the tests tools/evidence.mjs seals from their case maps", () => {
  for (const pkg of ["B06", "B09"]) {
    const sealed = readCaseMap(read(`docs/design/${pkg}-case-map.md`));
    const sidecar = JSON.parse(read(`docs/acceptance/case-maps/${pkg}.json`));
    for (const r of sealed) {
      const mine = sidecar.rows.find((x) => x.case === r.caseId);
      assert.deepEqual(new Set(mine.test), new Set(r.citations.map((c) => `${c.file} :: ${c.title}`)), `${pkg} ${r.caseId}`);
    }
  }
});

test("the IC block format: a case's block, its Status line, its citations and commit; a block of another package is not read", () => {
  const text = [
    "## IC-01 Deterministic kernel",
    "Status: EXECUTED_LOCAL",
    'Tests: `test/kernel.test.ts` :: "IC-01: the same input compiles to the same bytes"',
    "Commit: `abc1234`",
    "",
    "### CAP01 Capability",
    "**Status:** PARTIAL — the live half belongs to B04",
    "",
    "- **S001** not ours",
    "Status: EXECUTED_LOCAL",
  ].join("\n");
  const reg = { owner: new Map([["IC-01", "B03"], ["CAP01", "B03"], ["S001", "B00"]]) };
  assert.deepEqual(convertStatusBlocks(text, { packages: ["B03"], registry: reg }), [
    { case: "IC-01", class: "EXECUTED_LOCAL", test: ["test/kernel.test.ts :: IC-01: the same input compiles to the same bytes"], commit: "abc1234", reviewId: null, inheritedTo: [], claimed: "EXECUTED_LOCAL" },
    { case: "CAP01", class: "PARTIAL", test: [], commit: null, reviewId: null, inheritedTo: ["B04"], claimed: "PARTIAL — the live half belongs to B04" },
  ]);
});

// --- the repository ----------------------------------------------------------------------------------------------------------------

test("every registry case of every platform package appears exactly once in its sidecar, in the single row schema, and the sidecars equal the mechanical conversion of the case maps", () => {
  const sidecars = readSidecars(root);
  const external = readInputs(root).external.flatMap((i) => i.packages);
  assert.deepEqual(sidecars.map((s) => s.package), registry.program.map((p) => p.id).filter((p) => !external.includes(p)));
  for (const s of sidecars) {
    const pkg = registry.program.find((p) => p.id === s.package);
    assert.deepEqual(s.rows.map((r) => r.case).sort(), [...pkg.caseIds].sort(), `${s.package}: each case exactly once`);
    for (const r of s.rows) {
      for (const key of ["case", "class", "test", "commit", "reviewId", "inheritedTo"]) assert.ok(key in r, `${s.package} ${r.case}: ${key}`);
      assert.ok(CLASSES.includes(r.class), `${s.package} ${r.case}: class ${r.class}`);
      assert.ok(r.test.every((t) => / :: /.test(t)), `${s.package} ${r.case}: every test is "file :: title"`);
      if (r.class !== "NOT_EXECUTED" && r.class !== "PLANNED_POST_B19") assert.ok(r.test.length > 0, `${s.package} ${r.case}: a claimed class cites its tests`);
    }
    if (s.source.file) assert.equal(s.source.sha256, createHash("sha256").update(read(s.source.file)).digest("hex"), `${s.package}: converted from the committed map`);
  }
  const lines = [];
  assert.equal(main(["sidecars"], root, (l) => lines.push(l)), 0, lines.join("\n"));
});

test("the external maps are pinned to a path and a commit and read through git at that commit; the snapshot must equal a fresh conversion", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-pin-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "docs"));
    const map = (status) => `| case | status | proving test (file :: title) | commit |\n|---|---|---|---|\n| MC-01 | ${status} | \`test/a.test.ts\` :: \`refuses\` | \`ed09809\` |\n`;
    writeFileSync(join(dir, "docs", "map.md"), map("EXECUTED_LOCAL"));
    git("add", ".");
    git("commit", "-qm", "one");
    const first = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "docs", "map.md"), map("PLANNED(M9)"));
    git("commit", "-qam", "two");
    const pinned = readPinned(`${join(dir, "docs", "map.md")}@${first.slice(0, 7)}`);
    assert.deepEqual([pinned.path, pinned.commit], ["docs/map.md", first]);
    const input = { id: "MC", flag: "mc", repository: "r", path: "docs/map.md", commit: first, format: "table", packages: ["B01"] };
    const snap = convertExternal(input, pinned, registry);
    assert.deepEqual(snap.rows.map((r) => [r.case, r.class, r.test, r.commit]), [["MC-01", "EXECUTED_LOCAL", ["test/a.test.ts :: refuses"], "ed09809"]], "the bytes at the pinned commit, not the working tree");

    // through the command line, in a copy of the repository's inputs: the snapshot is written, then refused once it drifts
    const repo = mkdtempSync(join(tmpdir(), "ledger-repo-"));
    for (const p of ["packages/contracts/registry", "docs/acceptance/case-maps", "docs/acceptance/reviews", "docs/acceptance/README.md"]) cpSync(join(root, p), join(repo, p), { recursive: true });
    mkdirSync(join(repo, "docs/acceptance/ledger"), { recursive: true });
    writeFileSync(join(repo, "docs/acceptance/ledger/inputs.json"), JSON.stringify({ external: [input] }));
    const spec = `${join(dir, "docs", "map.md")}@${first}`;
    main(["--mc", spec, "--write"], repo, () => {});
    assert.equal(ledgerOfRepo(repo).ledger.violations.filter((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT").length, 0);
    const snapFile = join(repo, "docs/acceptance/ledger/external", `MC-${first.slice(0, 12)}.json`);
    const tampered = JSON.parse(readFileSync(snapFile, "utf8"));
    tampered.rows[0].class = "EXECUTED_PROVIDER";
    writeFileSync(snapFile, JSON.stringify(tampered));
    assert.ok(ledgerOfRepo(repo, { _: [], "--mc": [spec] }).ledger.violations.some((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT"), "a snapshot that differs from its pinned map is refused");
    const second = git("rev-parse", "HEAD");
    assert.ok(ledgerOfRepo(repo, { _: [], "--mc": [`${join(dir, "docs", "map.md")}@${second}`] }).ledger.violations.some((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT" && /pinned/.test(v.detail)), "another commit than the pinned one is refused");
    rmSync(repo, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger lists the 441 registry cases; the only missing ones belong to an external map not yet pinned, and the committed ledger, gate records and README table equal a fresh computation", () => {
  const { ledger, missingInputs } = ledgerOfRepo(root);
  assert.equal(ledger.cases.length, 441);
  assert.equal(new Set(ledger.cases.map((c) => c.case)).size, 441);
  const unpinned = new Set(missingInputs.flatMap((m) => m.packages));
  const missing = ledger.violations.filter((v) => v.kind === "MISSING_CASE");
  assert.deepEqual(missing.map((v) => v.subject).sort(), ledger.cases.filter((c) => unpinned.has(c.package)).map((c) => c.case).sort());
  for (const [path, content] of Object.entries(ledgerFiles(ledger))) assert.equal(read(path), content, `${path} is stale — run node tools/ledger.mjs --write`);
  // the README's hand table claims no acceptance the ledger does not compute
  // no README status is claimed without its review; the hand table still names the commit merged to main (4b33e26) where the
  // accepted subject is the latest accepting round (d9bbfd0) for B06, B07 and B09 (PR18-3 (c)) until B regenerates it
  const readmeClaimed = ledger.violations.filter((v) => v.kind === "README_CLAIM_WITHOUT_REVIEW");
  assert.deepEqual(readmeClaimed.filter((v) => !/^README names commit/.test(v.detail)), []);
  assert.deepEqual(readmeClaimed.map((v) => v.subject), ["B06", "B07", "B09"]);
});

// A platform case map in the table format converts with the review that accepts it; a row that lost its review agreement is a claim.
test("conversion: a table row takes its class from the status column, its review from the accepting round, and hands a PARTIAL remainder to the packages it names", () => {
  const text = "| case | status | rows | later package and case |\n|---|---|---|---|\n| S035 | PARTIAL | `packages/x/test/a.test.ts` :: \"S035: cleans\" | B14 — the Batch scratch |\n| S055 | EXECUTED_LOCAL | `packages/x/test/a.test.ts` :: \"S055: atomic\" | none (B14 repeats it) |\n";
  const reviews = [review("B08", 1, "ACCEPT", [{ id: "S035", claimed_status: "PARTIAL", agree: true }, { id: "S055", claimed_status: "EXECUTED_LOCAL", agree: false }], "88cf29d")];
  const rows = convertTableMap(text, { packages: ["B08"], registry, reviewOf: reviewIndex(reviews).reviewOf });
  assert.deepEqual(rows.map((r) => [r.case, r.class, r.reviewId, r.commit, r.inheritedTo]), [
    ["S035", "PARTIAL", "B08-round1-88cf29d", "88cf29d", ["B14"]],
    ["S055", "EXECUTED_LOCAL", null, null, []],
  ]);
});

test("every sidecar citation of a tools/test file names a test that exists in that file under exactly that title", () => {
  for (const s of readSidecars(root)) {
    for (const r of s.rows) {
      for (const t of r.test.filter((x) => x.startsWith("tools/test/"))) {
        const [file, ...title] = t.split(" :: ");
        assert.ok(read(file).includes(`test(${JSON.stringify(title.join(" :: "))}`), `${s.package} ${r.case}: ${t}`);
      }
    }
  }
});

test("a PARTIAL remainder kept by the package itself for a later lane names its own package; a remainder named by nobody stays unowned", () => {
  const map = (later) => `| case | status | rows | later package and case |\n|---|---|---|---|\n| R2-104 | PARTIAL | \`packages/x/test/a.test.ts\` :: "R2-104: offset" | ${later} |\n`;
  const own = convertTableMap(map("offset capacity open until lane B10-OFFSET (B10 lane B10-OFFSET, no registry case)"), { packages: ["B10"], registry });
  assert.deepEqual(own[0].inheritedTo, ["B10"]);
  const nobody = convertTableMap(map("offset capacity still open"), { packages: ["B10"], registry });
  assert.deepEqual(nobody[0].inheritedTo, []);
  const sidecar = JSON.parse(read("docs/acceptance/case-maps/B10.json"));
  assert.deepEqual(sidecar.rows.find((r) => r.case === "R2-104").inheritedTo, ["B10"], "B10's R2-104 as main states it");
});

test("PR18-5: a gate is DEMONSTRATED only when every case's demonstrated class is EXECUTED_LOCAL or EXECUTED_PROVIDER; a reviewed PARTIAL or SIMULATED case leaves it PARTIAL; an undemonstrated case leaves it OPEN", () => {
  const all = computeLedger(clean());
  assert.equal(all.gates.find((g) => g.gate === "G-B01").status, "DEMONSTRATED");
  for (const klass of ["PARTIAL", "SIMULATED"]) {
    const f = clean();
    f.sidecars[1].rows[0] = { ...f.sidecars[1].rows[0], class: klass, inheritedTo: ["B02"] };
    f.reviews[1].cases[0].claimed_status = klass;
    const ledger = computeLedger(f);
    assert.equal(ledger.cases.find((c) => c.case === "S003").demonstrated, klass, `${klass}: reviewed`);
    assert.equal(ledger.gates.find((g) => g.gate === "G-B01").status, "PARTIAL", `${klass} keeps the gate from DEMONSTRATED`);
  }
  const g = clean();
  g.sidecars[1].rows[0].reviewId = null;
  assert.equal(computeLedger(g).gates.find((x) => x.gate === "G-B01").status, "OPEN");
});

test("PR18-7: readPinned reads a pinned file through a non-canonical path (an 8.3 short name on Windows, a symlink here): git's toplevel and the file are compared as real paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-real-"));
  const alias = join(mkdtempSync(join(tmpdir(), "ledger-alias-")), "repo");
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "map.md"), "pinned bytes\n");
    git("add", ".");
    git("commit", "-qm", "one");
    symlinkSync(dir, alias, "junction");
    const pinned = readPinned(`${join(alias, "docs", "map.md")}@HEAD`);
    assert.deepEqual([pinned.path, pinned.text], ["docs/map.md", "pinned bytes\n"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirname(alias), { recursive: true, force: true });
  }
});

test("PR18-6 (M5): reviewOf binds a row only while the package's latest round accepts — a later REJECT withdraws every case", () => {
  const f = clean();
  assert.equal(reviewIndex(f.reviews).reviewOf("B01", "S003", "EXECUTED_LOCAL")?.id, "B01-round1-cB011");
  f.reviews.push(review("B01", 2, "REJECT", [{ id: "S004", claimed_status: "EXECUTED_LOCAL", agree: false }]));
  assert.equal(reviewIndex(f.reviews).reviewOf("B01", "S003", "EXECUTED_LOCAL"), null, "S003 agreed in round 1, but round 2 rejects the package");
});

test("PR18-3 (c): a README row whose commit is not the package's accepted subject is a claim without review", () => {
  const f = clean();
  const readme = (commit) => `| Package | Cases | Status | Commit on main |\n|---|---|---|---|\n| B01 one | 2 | ACCEPTED | \`${commit}\` |\n`;
  assert.deepEqual(kinds(computeLedger({ ...f, readme: readme("cB011") })), []);
  const ledger = computeLedger({ ...f, readme: readme("deadbee") });
  assert.deepEqual(kinds(ledger), ["README_CLAIM_WITHOUT_REVIEW B01"]);
  assert.match(ledger.violations[0].detail, /deadbee.*cB011/);
});

test("PR18-9: an external map's rows are bound by its package's accepting review only when the review's commit is the pinned commit of the snapshot", () => {
  const external = (commit) => {
    const f = clean();
    const rows = f.sidecars[1].rows.map((r) => ({ ...r, reviewId: null, commit: "ed09809" }));
    f.sidecars = f.sidecars.filter((s) => s.package !== "B01");
    f.reviews[1] = review("B01", 1, "ACCEPT", rows.map((r) => ({ id: r.case, claimed_status: "EXECUTED_LOCAL", agree: true })), "3b4b0ae");
    return computeLedger({ ...f, externals: [{ id: "MC", commit, packages: ["B01"], rows }] });
  };
  const bound = external("3b4b0aea4f1879ffb4189a55a16f22f4520787d4");
  assert.deepEqual(kinds(bound), []);
  assert.equal(bound.packages.find((p) => p.package === "B01").status, "ACCEPTED");
  assert.deepEqual(bound.cases.filter((c) => c.package === "B01").map((c) => [c.demonstrated, c.reviewId]), [["EXECUTED_LOCAL", "B01-round1-3b4b0ae"], ["EXECUTED_LOCAL", "B01-round1-3b4b0ae"]]);
  const other = external("1111111aea4f1879ffb4189a55a16f22f4520787d");
  assert.ok(other.violations.some((v) => v.kind === "EXTERNAL_REVIEW_COMMIT_MISMATCH" && v.subject === "B01"));
  assert.equal(other.packages.find((p) => p.package === "B01").status, "IN_PROGRESS");
});

test("PR18-3 (b): every review's commit resolves in the repository and an accepting subject is an ancestor of HEAD; an external package's subject is its pinned commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-reviews-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a");
    git("add", ".");
    git("commit", "-qm", "accepted");
    const onMain = git("rev-parse", "HEAD");
    git("checkout", "-qb", "side");
    writeFileSync(join(dir, "b.txt"), "b");
    git("add", ".");
    git("commit", "-qm", "side");
    const onSide = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");
    const reviews = [
      review("B06", 1, "ACCEPT", [], onMain.slice(0, 7)),
      review("B07", 1, "ACCEPT", [], onSide.slice(0, 7)),
      review("B08", 1, "ACCEPT", [], "deadbee"),
      review("B09", 1, "REJECT", [], "badc0de"),
      review("B01", 1, "ACCEPT", [], "3b4b0ae"),
    ];
    const v = reviewCommitViolations(dir, reviews, { B01: "3b4b0aea4f1879ffb4189a55a16f22f4520787d4" });
    assert.deepEqual(v.map((x) => `${x.kind} ${x.subject}`).sort(), ["REVIEW_COMMIT_UNBOUND B07-round1-" + onSide.slice(0, 7), "REVIEW_COMMIT_UNBOUND B08-round1-deadbee", "REVIEW_COMMIT_UNBOUND B09-round1-badc0de"].sort());
    assert.match(v.find((x) => x.subject.startsWith("B07")).detail, /not an ancestor of HEAD/);
    assert.match(v.find((x) => x.subject.startsWith("B08")).detail, /does not resolve/);
    assert.deepEqual(reviewCommitViolations(dir, [review("B01", 1, "ACCEPT", [], "1111111")], { B01: "3b4b0aea4f18" }).map((x) => x.kind), ["REVIEW_COMMIT_UNBOUND"], "an external review must name the pinned commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR18-9: a snapshot whose commit, path or packages differ from its pin in inputs.json is refused even without a checkout", () => {
  const repo = mkdtempSync(join(tmpdir(), "ledger-snap-"));
  try {
    for (const p of ["packages/contracts/registry", "docs/acceptance/case-maps", "docs/acceptance/reviews", "docs/acceptance/ledger/inputs.json", "docs/acceptance/ledger/external"]) cpSync(join(root, p), join(repo, p), { recursive: true });
    assert.deepEqual(ledgerOfRepo(repo).ledger.violations.filter((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT"), []);
    const input = readInputs(repo).external.find((i) => i.id === "MC");
    const file = join(repo, "docs/acceptance/ledger/external", `MC-${input.commit.slice(0, 12)}.json`);
    const snap = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...snap, commit: "1111111aea4f1879ffb4189a55a16f22f4520787d" }));
    assert.ok(ledgerOfRepo(repo).ledger.violations.some((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT" && /commit/.test(v.detail)));
    writeFileSync(file, JSON.stringify({ ...snap, packages: ["B01"] }));
    assert.ok(ledgerOfRepo(repo).ledger.violations.some((v) => v.kind === "EXTERNAL_SNAPSHOT_DRIFT" && /packages/.test(v.detail)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * Whether a test title is written in a test file: as the literal title (any quote kind, escapes undone) of a test, it, describe,
 * suite or context call, modifiers such as .skip or .only included. A comment, another string or a longer title is not it (ADV-6).
 */
function titleIn(source, title) {
  const call = /(?<![\w.$])(?:test|it|describe|suite|context)(?:\.\w+)*\s*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const m of source.matchAll(call)) if (m[2].replace(/\\([\s\S])/g, "$1") === title) return true;
  return false;
}

test("PR18-8: every citation of every platform sidecar names a test file that exists and a title written in it (each part of a nested describe :: it title, escaped quotes included); only a row that names its PLANNED half may cite a test file not written yet", () => {
  const missing = [];
  let checked = 0;
  for (const s of readSidecars(root)) {
    for (const r of s.rows) {
      for (const t of r.test) {
        const [file, ...parts] = t.split(" :: ");
        let source;
        try {
          source = read(file);
        } catch {
          // a planned half's test, its title fixed before it is written, is cited by a row that says so; an executed row never
          if (/^EXECUTED/.test(r.class) || !/PLANNED/.test(r.claimed ?? "")) missing.push(`${s.package} ${r.case}: no file ${file}`);
          continue;
        }
        checked++;
        for (const part of parts.length ? parts : [""]) if (!titleIn(source, part)) missing.push(`${s.package} ${r.case}: ${file} has no test titled ${part.slice(0, 100)}`);
      }
    }
  }
  assert.ok(checked > 500, `${checked} citations checked`);
  assert.deepEqual(missing, []);
});

test("PR18-10: obligations entered in B16's sidecar at B10 close survive `sidecars --write` and keep B16 from acceptance until each is COVERED or an owner-signed NOT_APPLICABLE", () => {
  const repo = mkdtempSync(join(tmpdir(), "ledger-obligations-"));
  try {
    for (const p of ["packages/contracts/registry", "docs/acceptance/case-maps", "docs/acceptance/reviews", "docs/acceptance/ledger/inputs.json", "docs/acceptance/ledger/external", "docs/design"]) cpSync(join(root, p), join(repo, p), { recursive: true });
    const file = join(repo, "docs/acceptance/case-maps/B16.json");
    const obligations = [{ id: "B10-CELL-X", from: "B10", status: "OPEN" }];
    writeFileSync(file, `${JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), obligations }, null, 1)}\n`);
    main(["sidecars", "--write"], repo, () => {});
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).obligations, obligations, "regenerating the sidecars keeps them");
    assert.ok(read("docs/acceptance/A7-draft.md").includes("They are added at B10 close"), "the draft says when they enter");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ADV-5: the command line binds every review to the history (reviewCommitViolations is wired into main), which ledgerOfRepo and the committed outputs leave out", () => {
  const repo = mkdtempSync(join(tmpdir(), "ledger-wired-"));
  try {
    for (const p of ["packages/contracts/registry", "docs/acceptance/case-maps", "docs/acceptance/reviews", "docs/acceptance/ledger/inputs.json", "docs/acceptance/ledger/external", "docs/acceptance/README.md"]) cpSync(join(root, p), join(repo, p), { recursive: true });
    const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "inputs only: no reviewed commit is in this history");
    const unbound = (violations) => violations.filter((v) => v.kind === "REVIEW_COMMIT_UNBOUND").map((v) => v.subject).sort();
    assert.deepEqual(unbound(ledgerOfRepo(repo).ledger.violations), [], "the committed outputs carry no git-dependent result");
    const lines = [];
    const code = main(["--json"], repo, (l) => lines.push(l));
    const external = new Set(readInputs(repo).external.flatMap((i) => i.packages));
    const platformReviews = execFileSync("git", ["-C", root, "ls-files", "docs/acceptance/reviews"], { encoding: "utf8" }).split("\n").filter((f) => /\/B\d\d-round\d+-[0-9a-f]+\.json$/.test(f));
    assert.ok(platformReviews.length > 0);
    assert.equal(code, 1);
    assert.deepEqual(unbound(JSON.parse(lines.join("\n")).violations), platformReviews.map((f) => f.split("/").pop().replace(/\.json$/, "")).filter((id) => !external.has(id.slice(0, 3))).sort(), "every review of a platform package (an external one is bound to its pin instead)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ADV-6: a cited title is written only as the title of a test, it or describe call — a comment, a longer title or another string does not satisfy it; escaped quotes and every quote kind do", () => {
  const source = [
    "// refuses a stale lease (a comment)",
    'const note = "refuses a stale lease";',
    'test("refuses a stale lease twice", () => {});',
    "describe('outer', () => {",
    '  it("says \\"no\\"", () => {});',
    "  it.skip(`uses a backtick`, () => {});",
    "  test('it\\'s fine', async () => {});",
    "});",
  ].join("\n");
  assert.equal(titleIn(source, "refuses a stale lease"), false);
  assert.equal(titleIn(source, "refuses a stale lease twice"), true);
  assert.equal(titleIn(source, "outer"), true);
  assert.equal(titleIn(source, 'says "no"'), true);
  assert.equal(titleIn(source, "uses a backtick"), true);
  assert.equal(titleIn(source, "it's fine"), true);
  assert.equal(titleIn(source, "fine"), false);
});
