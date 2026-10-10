// tools/audit/lib — the shared kit of the final audit (FA-kit-at14 lane K; R2 21_QUALITY_AND_ACCEPTANCE:11 evidence record, :95 finding,
// :97 material defects, :49-51 evaluator integrity, :128 failed attempts). Each rule has a test that observes it with one assertion, so
// the sabotage table of the commit (one rule removed per row, same file re-run) goes red for its own reason: an evidence record carries
// every R2 field and a reuse keeps the original producer and date; a finding carries every R2 field, tiers and material classes are
// enforced; a subject names a clean worktree of the right repository before anything is written; a manifest lists every run file
// sorted; writeOnce never exposes a partial file and makes its link durable; the families are the nine of families.md; a red proof is
// a test-only red failing for the declared reason, then green at the pre-merge fix head with the tests unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SimulatedCrash, probeLinks, readableFiles, writeOnce } from "../audit/lib/atomic.mjs";
import { FAMILIES } from "../audit/lib/families.mjs";
import { validateFinding } from "../audit/lib/finding.mjs";
import { buildManifest, verifyManifest, writeManifest } from "../audit/lib/manifest.mjs";
import { recordId, reuseRecord, sha256Hex, validateRecord } from "../audit/lib/record.mjs";
import { validateRedProof } from "../audit/lib/red-proof.mjs";
import { runHeavyArgv } from "../audit/lib/run-heavy.mjs";
import { subjectOf } from "../audit/lib/subject.mjs";
import { makeFixture } from "./audit-fixture.mjs";

const HEX40 = (c) => c.repeat(40);

function baseRecord() {
  return {
    producer: "kauro-audit-kit",
    subject: { repo: "kauro-platform", commit: HEX40("a"), tree: HEX40("b") },
    inputs: [{ path: "tools/audit/lib/record.mjs", sha256: sha256Hex("input") }],
    dependencies: [{ name: "node", hash: sha256Hex("node") }],
    environment: { os: "Windows 11", platform: "win32", node: "v24.14.1" },
    toolVersions: { node: "v24.14.1", git: "2.50.0" },
    command: ["node", "--test", "tools/test/audit-kit.test.mjs"],
    startedAt: "2026-10-09T10:00:00.000Z",
    endedAt: "2026-10-09T10:01:00.000Z",
    exit: 0,
    result: "PASSED",
    cost: { usd: 0, minutes: 1 },
    rawRef: { path: "raw/result.xml", sha256: sha256Hex("raw") },
    interpretation: "all rules held",
    class: "EXECUTED_LOCAL",
    createdAt: "2026-10-09T10:01:01.000Z",
  };
}

const RECORD_FIELDS = ["producer", "subject", "inputs", "dependencies", "environment", "toolVersions", "command", "startedAt", "endedAt", "exit", "result", "cost", "rawRef", "interpretation", "class", "createdAt"];

function baseFinding() {
  return {
    requirement: { doc: "21_QUALITY_AND_ACCEPTANCE.md", heading: "Findings" },
    subject: { repo: "kauro-intelligence-core", commit: HEX40("c"), tree: HEX40("d") },
    reproduction: ["node", "--test", "test/x.test.js"],
    expected: "the retry returns the committed result",
    observed: { text: "the retry created a second line", rawRef: { path: "raw/obs.txt", sha256: sha256Hex("obs") } },
    rootCause: { kind: "CAUSE", text: "key scoped per request, not per operation" },
    impact: "a duplicate line",
    consumers: ["apps/api"],
    repair: "scope the key per operation",
    acceptanceCases: ['test/x.test.js :: "the retry returns the committed result"'],
    kind: "DEFECT",
    class: "M",
    dimension: "correctness",
    capability: "ledger",
    family: "retry",
    tier: 2,
  };
}

const FINDING_FIELDS = ["requirement", "subject", "reproduction", "expected", "observed", "rootCause", "impact", "consumers", "repair", "acceptanceCases", "kind", "class", "dimension", "capability", "family", "tier"];
const MATERIAL = ["unauthorized data effect", "cross-tenant exposure", "false payment authority", "duplicate billable dispatch", "false success", "lost source units", "invalid target output", "hidden retention failure", "misleading release evidence"];
const TIER1_MATERIAL = MATERIAL.slice(0, 4);

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** An fs facade over the real fs that records the order of the durability-relevant calls; a directory gets a fake descriptor. */
function spyFs(events, { linkError, unlinkError } = {}) {
  const fds = new Map();
  let fake = 1000;
  return {
    openSync(p, flags) {
      if (existsSync(p) && statSync(p).isDirectory()) {
        const fd = fake++;
        fds.set(fd, { kind: "dir", flags });
        events.push(`open:dir:${flags}`);
        return fd;
      }
      const fd = nodeFs.openSync(p, flags);
      fds.set(fd, { kind: "file", flags });
      events.push(`open:file:${flags}`);
      return fd;
    },
    writeSync: (...a) => nodeFs.writeSync(...a),
    fsyncSync(fd) {
      const f = fds.get(fd);
      events.push(`fsync:${f.kind}:${f.flags}`);
      if (f.kind === "file") nodeFs.fsyncSync(fd);
    },
    closeSync(fd) {
      if (fds.get(fd).kind === "file") nodeFs.closeSync(fd);
    },
    linkSync(a, b) {
      events.push("link");
      if (linkError) throw Object.assign(new Error(linkError), { code: linkError });
      nodeFs.linkSync(a, b);
    },
    unlinkSync(p) {
      events.push("unlink");
      if (unlinkError) throw Object.assign(new Error(unlinkError), { code: unlinkError });
      nodeFs.unlinkSync(p);
    },
  };
}

test("OK a tool evidence record with every R2 21 field validates, and a reused record keeps its original producer and date", () => {
  assert.doesNotThrow(() => validateRecord(baseRecord()), "positive control");
  for (const cls of ["SIMULATED", "EXECUTED_LOCAL", "EXECUTED_PROVIDER"]) assert.doesNotThrow(() => validateRecord({ ...baseRecord(), class: cls }), cls);
  const original = baseRecord();
  const reused = reuseRecord(original, { reusedBy: "another-producer", at: "2026-10-10T09:00:00.000Z" });
  assert.equal(reused.producer, original.producer, "the reused record keeps the original producer");
  assert.equal(reused.createdAt, original.createdAt, "the reused record keeps the original date");
  assert.equal(reused.reusedFrom.producer, original.producer, "reusedFrom.producer");
  assert.equal(reused.reusedFrom.createdAt, original.createdAt, "reusedFrom.createdAt");
  assert.equal(reused.reusedFrom.recordId, recordId(original), "reusedFrom.recordId");
  assert.doesNotThrow(() => validateRecord(reused), "a reused record validates");
  assert.equal(original.reusedFrom, undefined, "the original is not mutated");
});

test("DENY an evidence record missing any one R2 21 field is refused naming that field (E_RECORD_FIELD)", () => {
  for (const field of RECORD_FIELDS) {
    const rec = baseRecord();
    delete rec[field];
    assert.throws(() => validateRecord(rec), (e) => e.code === "E_RECORD_FIELD" && e.field === field && e.message.includes(field), field);
  }
  for (const [parent, child] of [["subject", "repo"], ["subject", "commit"], ["cost", "usd"], ["cost", "minutes"], ["rawRef", "path"], ["rawRef", "sha256"], ["environment", "node"]]) {
    const rec = baseRecord();
    delete rec[parent][child];
    assert.throws(() => validateRecord(rec), (e) => e.code === "E_RECORD_FIELD" && e.field === `${parent}.${child}`, `${parent}.${child}`);
  }
  const noTree = baseRecord();
  delete noTree.subject.tree;
  assert.throws(() => validateRecord(noTree), { code: "E_RECORD_FIELD" }, "a subject needs a tree or an artifact digest");
  const artifact = baseRecord();
  artifact.subject = { repo: "kauro-platform", digest: sha256Hex("artifact") };
  assert.doesNotThrow(() => validateRecord(artifact), "an artifact digest names a subject without a commit");
});

test("DENY a tool record of class DESIGN, IMPLEMENTATION, INDEPENDENTLY_REVIEWED or ACCEPTED (E_RECORD_CLASS)", () => {
  for (const cls of ["DESIGN", "IMPLEMENTATION", "INDEPENDENTLY_REVIEWED", "ACCEPTED", "MADE_UP"]) {
    assert.throws(() => validateRecord({ ...baseRecord(), class: cls }), { code: "E_RECORD_CLASS" }, cls);
  }
});

test("DENY a finding missing any R2 21 finding field or of a kind outside DEFECT, BLOCKED_VERIFICATION, IMPROVEMENT (E_FINDING_FIELD, E_FINDING_KIND)", () => {
  assert.doesNotThrow(() => validateFinding(baseFinding()), "positive control");
  for (const field of FINDING_FIELDS) {
    const f = baseFinding();
    delete f[field];
    assert.throws(() => validateFinding(f), (e) => e.code === "E_FINDING_FIELD" && e.field === field, field);
  }
  for (const kind of ["DEFECT", "BLOCKED_VERIFICATION", "IMPROVEMENT"]) assert.doesNotThrow(() => validateFinding({ ...baseFinding(), kind }), kind);
  for (const kind of ["OPTIONAL", "BUG", "defect"]) assert.throws(() => validateFinding({ ...baseFinding(), kind }), { code: "E_FINDING_KIND" }, kind);
  assert.throws(() => validateFinding({ ...baseFinding(), family: "style" }), { code: "E_FINDING_FIELD" }, "a family outside families.md");
});

test("DENY a money, tenant, revocation or authority finding below tier 1, a tier-1 class D finding, and a finding of each of the 9 R2 material classes that is IMPROVEMENT, class D or names no capability (E_TIER, E_MATERIAL)", () => {
  for (const family of ["money", "tenant", "revocation"]) {
    assert.throws(() => validateFinding({ ...baseFinding(), family, tier: 2 }), { code: "E_TIER" }, `${family} below tier 1`);
    assert.doesNotThrow(() => validateFinding({ ...baseFinding(), family, tier: 1 }), `${family} at tier 1`);
  }
  assert.throws(() => validateFinding({ ...baseFinding(), authority: true, tier: 2 }), { code: "E_TIER" }, "authority below tier 1");
  assert.doesNotThrow(() => validateFinding({ ...baseFinding(), authority: true, tier: 1 }), "authority at tier 1");
  for (const materialClass of TIER1_MATERIAL) {
    assert.throws(() => validateFinding({ ...baseFinding(), materialClass, tier: 2 }), { code: "E_TIER" }, `${materialClass} below tier 1`);
  }
  assert.throws(() => validateFinding({ ...baseFinding(), family: "concurrency", tier: 1, class: "D" }), { code: "E_TIER_CLASS_D" }, "tier 1 class D");
  assert.doesNotThrow(() => validateFinding({ ...baseFinding(), family: "concurrency", tier: 1, class: "M" }), "tier 1 class M");
  for (const materialClass of MATERIAL) {
    const ok = { ...baseFinding(), materialClass, tier: 1, capability: "ledger" };
    assert.doesNotThrow(() => validateFinding(ok), `${materialClass} DEFECT`);
    assert.doesNotThrow(() => validateFinding({ ...ok, kind: "BLOCKED_VERIFICATION" }), `${materialClass} BLOCKED_VERIFICATION`);
    assert.throws(() => validateFinding({ ...ok, kind: "IMPROVEMENT" }), { code: "E_MATERIAL_KIND" }, `${materialClass} IMPROVEMENT`);
    assert.throws(() => validateFinding({ ...ok, class: "D" }), { code: "E_MATERIAL_CLASS" }, `${materialClass} class D`);
    assert.throws(() => validateFinding({ ...ok, capability: "" }), { code: "E_MATERIAL_CAPABILITY" }, `${materialClass} without capability`);
  }
  for (const materialClass of MATERIAL.slice(4)) assert.doesNotThrow(() => validateFinding({ ...baseFinding(), materialClass, tier: 2 }), `${materialClass} needs no tier 1`);
  assert.throws(() => validateFinding({ ...baseFinding(), materialClass: "bad luck" }), { code: "E_FINDING_FIELD" }, "a class outside the nine");
});

test("OK subject names commit and tree of a clean worktree; DENY a dirty worktree, another repo's worktree, and a git call past its timeout before any write (E_DIRTY, E_REPO_MISMATCH, E_GIT_TIMEOUT)", () => {
  const fx = makeFixture("kauro-platform");
  const other = makeFixture("kauro-other");
  const rootDir = tmpDir("audit-root-");
  const save = (subject) => writeFileSync(join(rootDir, "subject.json"), JSON.stringify(subject));
  try {
    const head = fx.git(["rev-parse", "HEAD"]);
    const subject = subjectOf({ repo: "kauro-platform", cwd: fx.work, save });
    assert.deepEqual(subject, { repo: "kauro-platform", commit: head, tree: fx.tree(head) });
    assert.deepEqual(JSON.parse(readFileSync(join(rootDir, "subject.json"), "utf8")), subject, "save ran after the reads");
    rmSync(join(rootDir, "subject.json"));

    writeFileSync(join(fx.work, "untracked.txt"), "dirty\n");
    assert.throws(() => subjectOf({ repo: "kauro-platform", cwd: fx.work, save }), { code: "E_DIRTY" });
    rmSync(join(fx.work, "untracked.txt"));
    writeFileSync(join(fx.work, "README.md"), "changed\n");
    assert.throws(() => subjectOf({ repo: "kauro-platform", cwd: fx.work, save }), { code: "E_DIRTY" }, "a modified tracked file");
    fx.git(["checkout", "--", "README.md"]);

    assert.throws(() => subjectOf({ repo: "kauro-platform", cwd: other.work, save }), { code: "E_REPO_MISMATCH" });

    const slow = (_cmd, _args, opts) => spawnSync(process.execPath, ["-e", "const t=Date.now()+1500;while(Date.now()<t){}"], opts);
    assert.throws(() => subjectOf({ repo: "kauro-platform", cwd: fx.work, save, timeoutMs: 200, runner: slow }), { code: "E_GIT_TIMEOUT" });
    assert.deepEqual(readdirSync(rootDir), [], "nothing was written under the root by any refused call");
  } finally {
    fx.cleanup();
    other.cleanup();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("OK the manifest lists every run file sorted with its SHA-256; DENY verify on a changed, a missing and an extra file (E_MANIFEST)", () => {
  const dirs = [];
  const make = () => {
    const dir = tmpDir("audit-run-");
    dirs.push(dir);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "summary.json"), '{"a":1}\n');
    writeFileSync(join(dir, "B.txt"), "upper\n");
    writeFileSync(join(dir, "sub.txt"), "dot\n");
    writeFileSync(join(dir, "sub", "x.txt"), "inner\n");
    writeFileSync(join(dir, "anchors.json.tmp-1-ab"), "a leftover temp file is not a run file\n");
    writeManifest(dir);
    return dir;
  };
  try {
    const dir = make();
    const lines = readFileSync(join(dir, "MANIFEST.sha256"), "utf8").trimEnd().split("\n");
    assert.deepEqual(lines.map((l) => l.slice(66)), ["B.txt", "sub.txt", "sub/x.txt", "summary.json"], "sorted by code unit, never by directory order");
    assert.equal(lines[0], `${sha256Hex("upper\n")}  B.txt`);
    assert.equal(buildManifest(dir), `${lines.join("\n")}\n`, "the manifest is a pure function of the files");
    assert.deepEqual(verifyManifest(dir), { files: 4 });

    const changed = make();
    writeFileSync(join(changed, "summary.json"), '{"a":2}\n');
    assert.throws(() => verifyManifest(changed), { code: "E_MANIFEST_CHANGED" });

    const missing = make();
    rmSync(join(missing, "sub", "x.txt"));
    assert.throws(() => verifyManifest(missing), { code: "E_MANIFEST_MISSING" });

    const extra = make();
    writeFileSync(join(extra, "stray.json"), "{}\n");
    assert.throws(() => verifyManifest(extra), { code: "E_MANIFEST_EXTRA" });

    const absent = tmpDir("audit-run-");
    dirs.push(absent);
    writeFileSync(join(absent, "summary.json"), "{}\n");
    assert.throws(() => verifyManifest(absent), { code: "E_MANIFEST_ABSENT" }, "no manifest: the run is not valid");
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
});

test("RACE (crash before link, crash after link, second writer): writeOnce never exposes a partial file, makes the link durable, the second writer gets E_EXISTS, a failed temp unlink is success, a link EPERM is E_IO, readers ignore temp files", () => {
  const dir = tmpDir("audit-atomic-");
  try {
    const p = (name) => join(dir, name);
    // crash before link: the target does not exist, the temp file holds the whole content
    assert.throws(() => writeOnce(p("a.json"), "AAAA", { crashAt: "afterTmp" }), (e) => e instanceof SimulatedCrash);
    assert.equal(existsSync(p("a.json")), false, "no partial target after a crash before the link");
    assert.deepEqual(readableFiles(dir), [], "readers ignore the temp file");
    assert.equal(readdirSync(dir).filter((n) => n.startsWith("a.json.tmp-")).length, 1, "the temp file is the crash residue");
    // retry after the crash succeeds
    writeOnce(p("a.json"), "AAAA");
    assert.equal(readFileSync(p("a.json"), "utf8"), "AAAA");
    assert.deepEqual(readableFiles(dir), ["a.json"], "readers list the real file only");
    // crash after link: the target is complete; the retry is the second writer
    assert.throws(() => writeOnce(p("b.json"), "BBBB", { crashAt: "afterLink" }), (e) => e instanceof SimulatedCrash);
    assert.equal(readFileSync(p("b.json"), "utf8"), "BBBB", "the committed file is whole after a crash after the link");
    assert.throws(() => writeOnce(p("b.json"), "CCCC"), { code: "E_EXISTS" });
    assert.equal(readFileSync(p("b.json"), "utf8"), "BBBB", "the second writer did not overwrite");
    // second writer racing at the hold point: B finishes inside A's beforeLink hook, A then gets E_EXISTS
    let inner = false;
    assert.throws(
      () => writeOnce(p("c.json"), "first", { beforeLink: () => { if (!inner) { inner = true; writeOnce(p("c.json"), "second"); } } }),
      { code: "E_EXISTS" },
    );
    assert.equal(readFileSync(p("c.json"), "utf8"), "second", "the writer that linked first owns the path");
    assert.equal(readdirSync(dir).filter((n) => n.startsWith("c.json.tmp-")).length, 0, "the loser removed its temp file");
    // a failed temp unlink after the link is success
    const unlinkEvents = [];
    assert.doesNotThrow(() => writeOnce(p("d.json"), "DDDD", { fs: spyFs(unlinkEvents, { unlinkError: "EBUSY" }) }));
    assert.equal(readFileSync(p("d.json"), "utf8"), "DDDD");
    assert.ok(unlinkEvents.includes("unlink"), "the unlink was attempted");
    // a link EPERM is E_IO after three attempts, never E_EXISTS
    const permEvents = [];
    assert.throws(() => writeOnce(p("e.json"), "EEEE", { fs: spyFs(permEvents, { linkError: "EPERM" }) }), { code: "E_IO" });
    assert.equal(permEvents.filter((e) => e === "link").length, 3, "three attempts");
    assert.equal(existsSync(p("e.json")), false);
    // durability: the link is flushed before the temp file is removed
    const lin = [];
    writeOnce(p("f.json"), "FFFF", { fs: spyFs(lin), platform: "linux" });
    const iLink = lin.indexOf("link");
    const iDirSync = lin.indexOf("fsync:dir:r");
    assert.ok(iLink >= 0 && iDirSync > iLink, `linux: parent directory fsync after the link (${lin.join(",")})`);
    assert.ok(lin.indexOf("unlink") > iDirSync, "linux: temp unlink after the durability step");
    const win = [];
    writeOnce(p("g.json"), "GGGG", { fs: spyFs(win), platform: "win32" });
    const wLink = win.indexOf("link");
    const wSync = win.indexOf("fsync:file:r+");
    assert.ok(wLink >= 0 && wSync > wLink, `win32: the linked file reopened r+ and fsynced after the link (${win.join(",")})`);
    assert.ok(win.indexOf("unlink") > wSync, "win32: temp unlink after the durability step");
    // the ledger root must support hard links
    assert.doesNotThrow(() => probeLinks(dir));
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes("probe")), [], "the probe leaves nothing behind");
    const noLink = { ...spyFs([]), linkSync: undefined };
    assert.throws(() => probeLinks(dir, { fs: noLink }), { code: "E_ROOT_FS" });
    assert.throws(() => probeLinks(dir, { fs: spyFs([], { linkError: "EPERM" }) }), { code: "E_ROOT_FS" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pinned families are exactly the 9 ids of families.md, and run-heavy argv names kind, repo, ref and command without --force-rerun", () => {
  const nine = ["concurrency", "time", "crash", "retry", "revocation", "partial", "evidence", "money", "tenant"];
  assert.deepEqual([...FAMILIES], nine);
  assert.ok(Object.isFrozen(FAMILIES), "the pinned list cannot be edited at runtime");
  const doc = "C:/Projects/Kauro/tools/review/families.md";
  if (existsSync(doc)) {
    const ids = [...readFileSync(doc, "utf8").matchAll(/^\| ([a-z]+) \|/gm)].map((m) => m[1]).filter((id) => id !== "family");
    assert.deepEqual(ids, nine, "families.md is the source");
  }
  const env = { KAURO_RUN_HEAVY: "C:/Projects/Kauro/tools/builder/run-heavy.mjs" };
  const argv = runHeavyArgv({ kind: "audit", repo: "C:/Projects/Kauro/repos/pw-audit", ref: "HEAD", command: ["node", "tools/audit/delta.mjs", "--plan", "p.json"], env });
  assert.equal(argv[0], env.KAURO_RUN_HEAVY);
  assert.equal(argv[argv.indexOf("--kind") + 1], "audit");
  assert.equal(argv[argv.indexOf("--repo") + 1], "C:/Projects/Kauro/repos/pw-audit");
  assert.equal(argv[argv.indexOf("--ref") + 1], "HEAD");
  assert.deepEqual(argv.slice(argv.indexOf("--") + 1), ["node", "tools/audit/delta.mjs", "--plan", "p.json"]);
  assert.ok(!argv.some((a) => a.includes("force-rerun")), "never --force-rerun");
  assert.throws(() => runHeavyArgv({ kind: "audit", repo: "r", ref: "HEAD", command: ["node"], env: {} }), { code: "E_RUN_HEAVY_PATH" });
});

const TITLE = "the fix keeps a at 2";
const TFILE = "packages/x/test/a.test.ts";
const OTHER = "packages/x/test/other.test.ts";
const SRC = "packages/x/src/a.ts";
const WITH_TITLE = `import { test } from "node:test";\ntest(${JSON.stringify(TITLE)}, () => {});\n`;
const FAIL_MSG = "AssertionError: expected 2 but got 1";

function junitXml(cases) {
  const body = cases.map((c) => {
    const open = `<testcase name="${c.name}" time="0.01" classname="test" file="${c.file}"`;
    if (c.outcome === "PASSED") return `${open}/>`;
    if (c.outcome === "FAILED") return `${open}>\n<failure type="${c.type}" message="${c.message}">${c.message}</failure>\n</testcase>`;
    return `${open}>\n<skipped type="${c.outcome === "TODO" ? "todo" : "skipped"}" message="x"/>\n</testcase>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body.join("\n")}\n</testsuites>\n`;
}

test("DENY a red proof that is not a test-only red on the audited sha failing for the declared reason, then green at the pre-merge fix head with the tests unchanged (E_RED_PROOF)", () => {
  const fx = makeFixture("kauro-platform");
  try {
    const compiled = `${fx.work.replaceAll("\\", "/")}/packages/x/dist/test/a.test.js`;
    const base = fx.commit("base", { [SRC]: "export const a = 1;\n", [TFILE]: 'import { test } from "node:test";\ntest("something else", () => {});\n', [OTHER]: "// other 1\n", "docs/readme.md": "r\n" });
    const audited = fx.commit("audited", { [OTHER]: "// other 2\n" });
    const redCase = { name: TITLE, file: compiled, outcome: "FAILED", type: "testCodeFailure", message: FAIL_MSG };
    const greenCase = { name: TITLE, file: compiled, outcome: "PASSED" };
    let n = 0;
    const mkRecord = (sha, rawPath, bytes) => ({
      ...baseRecord(),
      subject: { repo: "kauro-platform", commit: sha, tree: fx.tree(sha) },
      rawRef: { path: rawPath, sha256: sha256Hex(bytes) },
    });
    function build(o = {}) {
      n++;
      fx.branch(`case-${n}`, o.from ?? audited);
      const R = fx.commit(`red ${n}`, o.rFiles ?? { [TFILE]: WITH_TITLE });
      const F = o.makeF ? o.makeF(R, n) : fx.commit(`fix ${n}`, o.fFiles ?? { [SRC]: `export const a = 2; // ${n}\n` });
      const rawDir = join(fx.dir, "raw", String(n));
      mkdirSync(rawDir, { recursive: true });
      const redXml = junitXml([o.redCase ?? redCase]);
      const greenXml = junitXml([o.greenCase ?? greenCase]);
      const redPath = join(rawDir, "red.xml");
      const greenPath = join(rawDir, "green.xml");
      writeFileSync(redPath, redXml);
      writeFileSync(greenPath, greenXml);
      const input = {
        cwd: fx.work,
        auditedSha: audited,
        acceptanceTest: { file: TFILE, title: TITLE, expectedFailure: "expected 2 but got 1" },
        red: { sha: R, record: mkRecord(R, redPath, redXml) },
        green: { sha: F, record: mkRecord(F, greenPath, greenXml) },
      };
      o.tweak?.(input, { redPath, greenPath, audited });
      return input;
    }
    const refuses = (input, code, label) => assert.throws(() => validateRedProof(input), (e) => e.code === code, `${label} -> ${code}`);

    const ok = validateRedProof(build());
    assert.equal(ok.red.outcome, "FAILED");
    assert.equal(ok.green.outcome, "PASSED");
    assert.equal(ok.red.file, TFILE, "the compiled dist/test path maps to its source test");
    assert.equal(validateRedProof(build({ redCase: { ...redCase, file: TFILE } })).red.file, TFILE, "a source path is taken as is");

    refuses(build({ rFiles: { [TFILE]: WITH_TITLE, [SRC]: "export const a = 9;\n" } }), "E_RED_PROOF_NOT_TEST_ONLY", "s1 production file in audited..R");
    refuses(build({ from: base }), "E_RED_PROOF_ANCESTRY", "s2 R not a descendant of the audited sha");
    refuses(build({ redCase: { ...redCase, outcome: "PASSED" } }), "E_RED_PROOF_NOT_FAILED", "s3 red PASSED");
    refuses(build({ redCase: { ...redCase, type: "hookFailed" } }), "E_RED_PROOF_HARNESS", "s4 hookFailed");
    refuses(build({ redCase: { ...redCase, type: "testTimeoutFailure" } }), "E_RED_PROOF_HARNESS", "s4 timeout");
    refuses(build({ redCase: { ...redCase, message: "AssertionError: something unrelated" } }), "E_RED_PROOF_REASON", "s5 message does not match the declared reason");
    refuses(build({ redCase: { ...redCase, message: `SyntaxError: Unexpected token, ${FAIL_MSG}` } }), "E_RED_PROOF_HARNESS", "s6 harness sample in the message");
    const NO_TITLE = 'import { test } from "node:test";\ntest("something else", () => {});\n';
    refuses(build({ rFiles: { [TFILE]: NO_TITLE }, fFiles: { [SRC]: "export const a = 4;\n", [TFILE]: WITH_TITLE } }), "E_RED_PROOF_TITLE", "s7 title absent at R");
    refuses(build({ fFiles: { [SRC]: "export const a = 5;\n", [TFILE]: NO_TITLE } }), "E_RED_PROOF_TITLE", "s7 title absent at F");
    refuses(build({ fFiles: { [SRC]: "export const a = 3;\n", [OTHER]: "// other 3\n" } }), "E_RED_PROOF_TEST_CHANGED", "s8 test-only path in R..F");
    refuses(
      build({
        makeF: (_R, k) => {
          fx.branch(`sibling-${k}`, audited);
          return fx.commit(`sibling fix ${k}`, { [TFILE]: WITH_TITLE, [SRC]: `export const a = 2; // sibling ${k}\n` });
        },
      }),
      "E_RED_PROOF_ANCESTRY",
      "s9 F does not descend from R",
    );
    refuses(build({ greenCase: { ...greenCase, outcome: "FAILED", type: "testCodeFailure", message: FAIL_MSG } }), "E_GREEN_PROOF", "s10 green FAILED");
    refuses(build({ tweak: (i, c) => { i.red.record.subject.commit = c.audited; i.red.record.subject.tree = fx.tree(c.audited); } }), "E_RECORD_SUBJECT", "s11 record names another commit");
    refuses(build({ tweak: (_i, c) => writeFileSync(c.redPath, "<testsuites>tampered</testsuites>\n") }), "E_RAW_HASH", "s12 raw bytes differ from the record");
    refuses(build({ redCase: { ...redCase, name: "some other test" } }), "E_RED_PROOF_NO_CASE", "red case absent from the report");
    refuses(build({ greenCase: { ...greenCase, name: "some other test" } }), "E_RED_PROOF_NO_CASE", "green case absent from the report");
    refuses(build({ redCase: { ...redCase, file: compiled.replace("/x/dist/test/a.test.js", "/y/dist/test/a.test.js") } }), "E_RED_PROOF_NO_CASE", "s13 same title in another file");
    refuses(build({ greenCase: { ...greenCase, outcome: "SKIPPED" } }), "E_GREEN_PROOF_SKIPPED", "s14 skipped green");
    refuses(build({ greenCase: { ...greenCase, outcome: "TODO" } }), "E_GREEN_PROOF_SKIPPED", "s14 todo green");
    refuses(
      build({
        makeF: (R, k) => {
          fx.branch(`fixline-${k}`, R);
          fx.commit(`fix ${k}`, { [SRC]: `export const a = 2; // merged ${k}\n` });
          fx.branch(`side-${k}`, R);
          fx.commit(`main moved ${k}`, { [`docs/main-${k}.md`]: "moved\n" });
          fx.checkout(`fixline-${k}`);
          fx.git(["merge", "--no-ff", "-m", `merge origin/main ${k}`, `side-${k}`]);
          return fx.git(["rev-parse", "HEAD"]);
        },
      }),
      "E_RED_PROOF_MERGE",
      "s15 merge inside R..F",
    );
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------------- fix round 1 (adversary FAIL 8c7d810; coordinator rulings 20:23Z)

test("ADV-7: a red proof whose fix head is the red commit or adds no change (F == R, or an empty diff R..F) is refused (E_RED_PROOF_NO_FIX)", () => {
  const fx = makeFixture("kauro-platform");
  try {
    const compiled = `${fx.work.replaceAll("\\", "/")}/packages/x/dist/test/a.test.js`;
    fx.commit("base", { [SRC]: "export const a = 1;\n", "docs/readme.md": "r\n" });
    const audited = fx.commit("audited", { "docs/readme.md": "r2\n" });
    let n = 0;
    const build = (makeF) => {
      n++;
      fx.branch(`adv7-${n}`, audited);
      const R = fx.commit(`red ${n}`, { [TFILE]: WITH_TITLE });
      const F = makeF(R, n);
      const rawDir = join(fx.dir, "raw", String(n));
      mkdirSync(rawDir, { recursive: true });
      const redXml = junitXml([{ name: TITLE, file: compiled, outcome: "FAILED", type: "testCodeFailure", message: FAIL_MSG }]);
      const greenXml = junitXml([{ name: TITLE, file: compiled, outcome: "PASSED" }]);
      writeFileSync(join(rawDir, "red.xml"), redXml);
      writeFileSync(join(rawDir, "green.xml"), greenXml);
      const record = (sha, path, bytes) => ({ ...baseRecord(), subject: { repo: "kauro-platform", commit: sha, tree: fx.tree(sha) }, rawRef: { path, sha256: sha256Hex(bytes) } });
      return {
        cwd: fx.work,
        auditedSha: audited,
        acceptanceTest: { file: TFILE, title: TITLE, expectedFailure: "expected 2 but got 1" },
        red: { sha: R, record: record(R, join(rawDir, "red.xml"), redXml) },
        green: { sha: F, record: record(F, join(rawDir, "green.xml"), greenXml) },
      };
    };
    const ok = validateRedProof(build((_R, k) => fx.commit(`fix ${k}`, { [SRC]: `export const a = 2; // ${k}\n` })));
    assert.equal(ok.green.outcome, "PASSED", "positive control: a production change R..F is a fix");
    const refusesNoFix = (input, label) =>
      assert.throws(() => validateRedProof(input), (e) => {
        assert.equal(e.code, "E_RED_PROOF_NO_FIX", `${label}: ${e.message}`);
        return true;
      });
    refusesNoFix(build((R) => R), "P1 F == R (a flaky acceptance test passes with zero product change)");
    refusesNoFix(build((_R, k) => fx.commit(`empty fix ${k}`, {})), "an empty commit on R: diff R..F is empty");
  } finally {
    fx.cleanup();
  }
});

// The sha256 of the nine `| <id> |` rows of tools/review/families.md (LF-joined, CR stripped), pinned on 2026-10-09.
const FAMILIES_ROWS_SHA256 = "e2ac440df58b7c95b8b447a2e2a02c2be1dcd516f0784174e392fa4973b5e4ff";

test("ADV-11: the families.md id rows are pinned by sha256; when the source is present it must match and name exactly FAMILIES, and the output states whether the source check ran", (t) => {
  const doc = process.env.KAURO_FAMILIES_MD ?? "C:/Projects/Kauro/tools/review/families.md";
  assert.match(FAMILIES_ROWS_SHA256, /^[0-9a-f]{64}$/);
  if (!existsSync(doc)) {
    t.diagnostic(`families.md source check: SKIPPED (${doc} absent); the binding run is the ci-local Windows leg`);
    return;
  }
  const rows = readFileSync(doc, "utf8").split(/\r?\n/).filter((line) => /^\| [a-z]+ \|/.test(line));
  assert.deepEqual(rows.map((r) => r.split("|")[1].trim()), [...FAMILIES], "the id column of families.md is FAMILIES, in order");
  assert.equal(sha256Hex(rows.join("\n")), FAMILIES_ROWS_SHA256, "the families.md rows are the pinned rows");
  t.diagnostic(`families.md source check: RAN against ${doc} (${rows.length} rows, sha256 ${FAMILIES_ROWS_SHA256})`);
});
