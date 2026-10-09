// tools/audit/work-orders.mjs — the final-audit work-order ledger (FA-kit-at14 lane W; R2 21_QUALITY_AND_ACCEPTANCE:95 findings, :97
// material defects, :109-110 independence and closure, :128 "A final report cannot omit a failed attempt simply because a later
// attempt passed"). One test per rule cell W-01..W-14 of the mandate, each on temporary git repositories (tools/test/audit-fixture.mjs)
// and a temporary ledger root, so every sabotage row of section 3 goes red on one assertion of its test.
//
// API under test (the builder implements it; mandate section 6 plus these decisions, every one also listed in the lane-W report):
//   openLedger({root, runner?, beforeLink?, crashAt?}) -> {importFinding, transition, lost, fold, list, summary}. Reads are from disk on
//   every call (two instances on one root see each other's commits). `runner` is the kit git runner (spawnSync shape). `beforeLink(path)`
//   is handed to every writeOnce; `crashAt: {point: "afterTmp"|"afterLink", match: RegExp}` hands `crashAt: point` to the writeOnce
//   whose target path (with "\" replaced by "/") matches. Actors are {id, role}; roles auditor | coordinator | fixer | verifier.
//   importFinding(finding, {actor, requestId?}) -> {woId}.  transition(woId, {to, rev, requestId, actor, ...fields}) -> {event, anchorRun}
//   where rev is the seq the caller saw, event = {seq, prev, at, actor, requestId, from, to, fields}; the edge check precedes every
//   field check. Fields: ASSIGNED {fixer, branch, acceptanceTest{file, title, expectedFailure}}; FIXED {red{sha, record}, green{sha,
//   record}}; VERIFIED {permanentCheck?{file, title}}; CLOSED {toolRule, reviewReceipt? (dir `<label>-<sha12>`)}; FIXED|VERIFIED ->
//   ASSIGNED {reason}; VOIDED {r2{doc, heading}}. Every committed transition writes an anchor run (R3-2) named by `anchorRun`.
//   lost(woId, {anchorRun, actor, requestId?}) -> {event} with to "LOST" and fields {anchorRun, anchorSeq, anchorHash, lastSurvivingSeq}.
//   fold(woId) -> {id, state, seq, history} (throws E_LEDGER_CORRUPT when frozen). list() -> bound WO ids, numeric order.
//   summary() -> {runId, summary}; summary {workOrders[{id, state, family, tier, kind, attempts[{fixSha, reopenedReason}]}],
//   counts{byFamily, byState, byTier, byKind} (non-zero keys only), blockedCapabilities, lost[{woId, anchorRun, anchorSeq, anchorHash,
//   lastSurvivingSeq}], anchors, unboundSlots, frozen}. Event hash = sha256 of the event file bytes.
//   deltaRun records (lane D not shipped): `<root>/delta/<WO-id>/<nnnn>.json` {plan{base, head, mustRun, binding}, results[{id,
//   status}]}, newest = highest n; built here by the test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { MANIFEST_NAME, verifyManifest, writeManifest } from "../audit/lib/manifest.mjs";
import { canonical, sha256Hex } from "../audit/lib/record.mjs";
import { main, openLedger } from "../audit/work-orders.mjs";
import { makeFixture } from "./audit-fixture.mjs";

const CLI = fileURLToPath(new URL("../audit/work-orders.mjs", import.meta.url));
const AUDITOR = { id: "auditor-1", role: "auditor" };
const COORD = { id: "coordinator-1", role: "coordinator" };
const FIXER = { id: "fixer-1", role: "fixer" };
const FIXER2 = { id: "fixer-2", role: "fixer" };
const VERIFIER = { id: "verifier-1", role: "verifier" };
const SRC = "packages/x/src/a.ts";
const FAIL_MSG = "AssertionError: expected 2 but got 1";
const EXPECTED = "expected 2 but got 1";
const R2_VOID = { doc: "21_QUALITY_AND_ACCEPTANCE.md", heading: "Findings" };
const NOT_GENERIC = "NOT_GENERIC: the defect is specific to the fixture module";
const testFile = (k) => `packages/x/test/wo${k}.test.ts`;
const titleOf = (k) => `the fix keeps a at 2 (case ${k})`;
const withTitle = (title) => `import { test } from "node:test";\ntest(${JSON.stringify(title)}, () => {});\n`;
const slash = (p) => p.replaceAll("\\", "/");
const pad4 = (n) => String(n).padStart(4, "0");
const CLAIM = /\/fp\/[0-9a-f]{64}\.json$/;
const BINDING = /\/fp\/[0-9a-f]{64}\.wo\.json$/;

function refuses(fn, code, label) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, `${label}: ${e.message}`);
    return true;
  });
}

function refusesKind(fn, code, kind, label) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, code, `${label}: ${e.message}`);
    assert.equal(e.kind, kind, `${label}: kind of ${e.message}`);
    return true;
  });
}

/** The CLI in process: {status, stdout, stderr}. */
function cli(args) {
  const out = [];
  const err = [];
  const status = main(args, { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) });
  return { status, stdout: out.join("\n"), stderr: err.join("\n") };
}

function baseRecord(subject, rawPath, bytes) {
  return {
    producer: "kauro-audit-work-orders-test",
    subject,
    inputs: [{ path: "tools/test/audit-work-orders.test.mjs", sha256: sha256Hex("input") }],
    dependencies: [{ name: "node", hash: sha256Hex("node") }],
    environment: { os: "Windows 11", platform: "win32", node: "v24.14.1" },
    toolVersions: { node: "v24.14.1", git: "2.50.0" },
    command: ["node", "--test", "dist/test/a.test.js"],
    startedAt: "2026-10-09T10:00:00.000Z",
    endedAt: "2026-10-09T10:01:00.000Z",
    exit: 1,
    result: "FAILED",
    cost: { usd: 0, minutes: 1 },
    rawRef: { path: rawPath, sha256: sha256Hex(bytes) },
    interpretation: "the acceptance test result",
    class: "EXECUTED_LOCAL",
    createdAt: "2026-10-09T10:01:01.000Z",
  };
}

/** node:test JUnit shape (as in audit-kit.test.mjs): compiled dist/test paths, failure type testCodeFailure. */
function junitXml(cases) {
  const body = cases.map((c) => {
    const open = `<testcase name="${c.name}" time="0.01" classname="test" file="${c.file}"`;
    if (c.outcome === "PASSED") return `${open}/>`;
    if (c.outcome === "FAILED") return `${open}>\n<failure type="${c.type}" message="${c.message}">${c.message}</failure>\n</testcase>`;
    return `${open}>\n<skipped type="${c.outcome === "TODO" ? "todo" : "skipped"}" message="x"/>\n</testcase>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body.join("\n")}\n</testsuites>\n`;
}

/** One subject repository (base, audited on origin/main) and any number of ledger roots mapping it in repos.json. */
function world() {
  const fx = makeFixture("kauro-platform");
  fx.commit("base", { [SRC]: "export const a = 1;\n", "docs/readme.md": "r\n" });
  const audited = fx.commit("audited", { "docs/readme.md": "r2\n" });
  fx.git(["push", "origin", "HEAD:refs/heads/main"]);
  const auditedTree = fx.tree(audited);
  const roots = [];
  let rawN = 0;
  let fixN = 0;
  // ADV-12: repos.json names the Kauro root; a tier-1 review receipt must resolve under <kauroRoot>/tools/review/out.
  const kauroRoot = join(fx.dir, "kauro");
  const reviewOut = join(kauroRoot, "tools", "review", "out");
  mkdirSync(reviewOut, { recursive: true });
  const w = {
    fx,
    audited,
    kauroRoot,
    reviewOut,
    newRoot() {
      const root = mkdtempSync(join(tmpdir(), "audit-wo-"));
      roots.push(root);
      writeFileSync(join(root, "repos.json"), `${JSON.stringify({ "kauro-platform": fx.work, kauroRoot })}\n`);
      return root;
    },
    finding(k, o = {}) {
      return {
        requirement: { doc: "21_QUALITY_AND_ACCEPTANCE.md", heading: "Findings" },
        subject: { repo: "kauro-platform", commit: audited, tree: auditedTree },
        reproduction: ["node", "--test", `packages/x/dist/test/wo${k}.test.js`],
        expected: "a stays at 2",
        observed: { text: `a was 1 (case ${k})`, rawRef: { path: `raw/obs-${k}.txt`, sha256: sha256Hex(`obs ${k}`) } },
        rootCause: { kind: "CAUSE", text: "the setter keeps the old value" },
        impact: "a wrong total",
        consumers: ["apps/api"],
        repair: "set a to 2",
        acceptanceCases: [`${testFile(k)} :: "${titleOf(k)}"`],
        kind: "DEFECT",
        class: "M",
        dimension: "correctness",
        capability: "",
        family: "retry",
        tier: 2,
        location: `${SRC}:${k}`,
        checkId: "wo-probe",
        ...o,
      };
    },
    /** The red commit R (the acceptance test, plus `extraR` test files) on audit/<wo>, cut from the audited sha. */
    red(wo, k, extraR = {}) {
      fx.checkout(`audit/${wo}`);
      return fx.commit(`red ${wo}`, { [testFile(k)]: withTitle(titleOf(k)), ...extraR });
    },
    /** A fix commit on top of the current head of audit/<wo> (production paths only). */
    fix(wo) {
      fx.checkout(`audit/${wo}`);
      return fx.commit(`fix ${wo} ${++fixN}`, { [SRC]: `export const a = 2; // fix ${fixN}\n` });
    },
    /** FIXED fields for (R, F) with JUnit raw files and records; overrides change the red or green testcase. */
    proof(k, R, F, { redCase = {}, greenCase = {} } = {}) {
      const compiled = `${slash(fx.work)}/packages/x/dist/test/wo${k}.test.js`;
      const rc = { name: titleOf(k), file: compiled, outcome: "FAILED", type: "testCodeFailure", message: FAIL_MSG, ...redCase };
      const gc = { name: titleOf(k), file: compiled, outcome: "PASSED", ...greenCase };
      const dir = join(fx.dir, "raw", String(++rawN));
      mkdirSync(dir, { recursive: true });
      const redXml = junitXml([rc]);
      const greenXml = junitXml([gc]);
      const redPath = join(dir, "red.xml");
      const greenPath = join(dir, "green.xml");
      writeFileSync(redPath, redXml);
      writeFileSync(greenPath, greenXml);
      const subject = (sha) => ({ repo: "kauro-platform", commit: sha, tree: fx.tree(sha) });
      return {
        red: { sha: R, record: baseRecord(subject(R), redPath, redXml) },
        green: { sha: F, record: { ...baseRecord(subject(F), greenPath, greenXml), exit: 0, result: "PASSED" } },
      };
    },
    /** A review receipt dir `<parent>/<label>-<sha12>` (parent = <kauroRoot>/tools/review/out) with review.json, codex.log and prompt.md (minus `omit`). */
    receipt(label, sha, { verdict = "ACCEPT", omit = [], parent = reviewOut } = {}) {
      const dir = join(parent, `${label}-${sha.slice(0, 12)}`);
      mkdirSync(dir, { recursive: true });
      const files = { "review.json": `${JSON.stringify({ verdict, label, sha })}\n`, "codex.log": `codex reviewed ${sha}\n`, "prompt.md": `# review ${label}\n` };
      for (const [name, text] of Object.entries(files)) if (!omit.includes(name)) writeFileSync(join(dir, name), text);
      return dir;
    },
    /** Creates audit/<wo> at the audited sha unless an earlier ledger root of this test already made it. */
    branchFor(wo) {
      const exists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/audit/${wo}`], { cwd: fx.work }).status === 0;
      if (!exists) fx.git(["branch", `audit/${wo}`, audited]);
    },
    setMain(sha) {
      fx.git(["push", "-f", "origin", `${sha}:refs/heads/main`]);
    },
    cleanup() {
      fx.cleanup();
      for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return w;
}

/** A ledger root with helpers that read the revision from the fold and give each call a fresh request id. */
function desk(w, root = w.newRoot()) {
  const open = (o = {}) => openLedger({ root, ...o });
  const ledger = open();
  let n = 0;
  const d = {
    root,
    open,
    ledger,
    seq: (wo) => ledger.fold(wo).seq,
    events: (wo) => readdirSync(join(root, "wo", wo)).filter((f) => /^\d{4}\.json$/.test(f)).sort(),
    eventPath: (wo, seq) => join(root, "wo", wo, `${pad4(seq)}.json`),
    eventHash: (wo, seq) => sha256Hex(readFileSync(join(root, "wo", wo, `${pad4(seq)}.json`))),
    go(wo, to, actor, fields = {}, l = ledger) {
      return l.transition(wo, { to, rev: ledger.fold(wo).seq, requestId: `${wo}-${to}-${++n}`, actor, ...fields });
    },
    imp(k, o = {}) {
      return ledger.importFinding(w.finding(k, o), { actor: AUDITOR }).woId;
    },
    /** Imports a finding whose binding write crashes: the slot exists with its OPEN event and stays unbound. */
    unbound(k, o = {}) {
      const before = new Set(existsSync(join(root, "wo")) ? readdirSync(join(root, "wo")) : []);
      refuses(() => open({ crashAt: { point: "afterTmp", match: BINDING } }).importFinding(w.finding(k, o), { actor: AUDITOR }), "E_SIMULATED_CRASH", "crash before the binding");
      const slots = readdirSync(join(root, "wo")).filter((s) => !before.has(s));
      assert.equal(slots.length, 1, "the crashed import made one slot");
      return slots[0];
    },
    assignFields(wo, k, fixer = FIXER.id, o = {}) {
      return { fixer, branch: `audit/${wo}`, acceptanceTest: { file: testFile(k), title: titleOf(k), expectedFailure: EXPECTED }, ...o };
    },
    assign(wo, k, fixer = FIXER.id) {
      w.branchFor(wo);
      return d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, k, fixer));
    },
    delta(wo, plan, results) {
      const dir = join(root, "delta", wo);
      mkdirSync(dir, { recursive: true });
      const next = readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).length + 1;
      writeFileSync(join(dir, `${pad4(next)}.json`), `${JSON.stringify({ plan, results })}\n`);
    },
    goodDelta(wo, F) {
      d.delta(wo, { base: w.audited, head: F, mustRun: [`wo:${wo}`, "check:lint"], binding: "BOUND" }, [{ id: `wo:${wo}`, status: "PASS" }, { id: "check:lint", status: "PASS" }]);
    },
    /** OPEN -> ASSIGNED -> FIXED for case k; returns {R, F}. */
    toFixed(wo, k, extraR = {}) {
      d.assign(wo, k);
      const R = w.red(wo, k, extraR);
      const F = w.fix(wo);
      d.go(wo, "FIXED", FIXER, w.proof(k, R, F));
      return { R, F };
    },
    validRuns() {
      const runs = join(root, "runs");
      if (!existsSync(runs)) return [];
      return readdirSync(runs).filter((id) => {
        try {
          verifyManifest(join(runs, id));
          return true;
        } catch {
          return false;
        }
      });
    },
    anchorsOf: (runId) => JSON.parse(readFileSync(join(root, "runs", runId, "anchors.json"), "utf8")),
  };
  return d;
}

test("OK a WO walks OPEN, ASSIGNED, FIXED, VERIFIED, CLOSED with valid records (positive control)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    assert.equal(wo, "WO-1", "the first slot of an empty ledger");
    assert.equal(d.ledger.fold(wo).state, "OPEN");
    const assigned = d.assign(wo, 1);
    assert.equal(assigned.event.to, "ASSIGNED");
    const R = w.red(wo, 1);
    const F = w.fix(wo);
    const fixed = d.go(wo, "FIXED", FIXER, w.proof(1, R, F));
    assert.equal(fixed.event.to, "FIXED", "positive control: a valid red proof is accepted");
    d.goodDelta(wo, F);
    assert.equal(d.go(wo, "VERIFIED", VERIFIER).event.to, "VERIFIED");
    w.setMain(F);
    const closed = d.go(wo, "CLOSED", COORD, { toolRule: NOT_GENERIC });
    assert.equal(closed.event.to, "CLOSED");
    const folded = d.ledger.fold(wo);
    assert.equal(folded.state, "CLOSED");
    assert.equal(folded.seq, 5);
    assert.deepEqual(folded.history.map((e) => e.to), ["OPEN", "ASSIGNED", "FIXED", "VERIFIED", "CLOSED"]);
    assert.deepEqual(folded.history.map((e) => e.seq), [1, 2, 3, 4, 5]);
    for (let s = 2; s <= 5; s++) assert.equal(folded.history[s - 1].prev, d.eventHash(wo, s - 1), `event ${s} chains to the bytes of event ${s - 1}`);
    assert.deepEqual(d.events(wo), ["0001.json", "0002.json", "0003.json", "0004.json", "0005.json"]);
    assert.deepEqual(d.ledger.list(), ["WO-1"]);
  } finally {
    w.cleanup();
  }
});

test("DENY every edge outside the state table, including from CLOSED and VOIDED (E_TRANSITION)", () => {
  const w = world();
  try {
    const d = desk(w);
    const deny = (wo, to, actor, fields, label) => {
      const before = d.seq(wo);
      refuses(() => d.go(wo, to, actor, fields), "E_TRANSITION", label);
      assert.equal(d.seq(wo), before, `${label}: no event written`);
    };
    const wo1 = d.imp(1);
    const dummy = w.proof(1, w.audited, w.audited);
    deny(wo1, "FIXED", FIXER, dummy, "s1 OPEN->FIXED");
    deny(wo1, "VERIFIED", VERIFIER, {}, "OPEN->VERIFIED");
    deny(wo1, "CLOSED", COORD, { toolRule: NOT_GENERIC }, "OPEN->CLOSED");
    d.assign(wo1, 1);
    d.goodDelta(wo1, w.audited);
    deny(wo1, "VERIFIED", VERIFIER, {}, "s2 ASSIGNED->VERIFIED");
    deny(wo1, "CLOSED", COORD, { toolRule: NOT_GENERIC }, "ASSIGNED->CLOSED");
    const R = w.red(wo1, 1);
    const F = w.fix(wo1);
    d.go(wo1, "FIXED", FIXER, w.proof(1, R, F));
    w.setMain(F);
    deny(wo1, "CLOSED", COORD, { toolRule: NOT_GENERIC }, "s3 FIXED->CLOSED");
    deny(wo1, "OPEN", COORD, {}, "FIXED->OPEN");

    const wo2 = d.imp(2, { family: "time" }); // another family: a FIXED same-family sibling would make VERIFIED need the permanent check (ADV-6)
    const { F: F2 } = d.toFixed(wo2, 2);
    d.goodDelta(wo2, F2);
    d.go(wo2, "VERIFIED", VERIFIER);
    w.setMain(F2);
    d.go(wo2, "CLOSED", COORD, { toolRule: NOT_GENERIC });
    assert.equal(d.ledger.fold(wo2).state, "CLOSED");
    deny(wo2, "ASSIGNED", COORD, { reason: "reopen a closed WO" }, "s4 CLOSED->ASSIGNED");
    deny(wo2, "VOIDED", COORD, { r2: R2_VOID }, "s4 CLOSED->VOIDED");
    deny(wo2, "OPEN", COORD, {}, "s4 CLOSED->OPEN");
    deny(wo2, "CLOSED", COORD, { toolRule: NOT_GENERIC }, "s4 CLOSED->CLOSED");

    const wo3 = d.imp(3);
    d.go(wo3, "VOIDED", COORD, { r2: R2_VOID });
    assert.equal(d.ledger.fold(wo3).state, "VOIDED");
    w.fx.git(["branch", `audit/${wo3}`, w.audited]);
    deny(wo3, "ASSIGNED", COORD, d.assignFields(wo3, 3), "s5 VOIDED->ASSIGNED");
    deny(wo3, "OPEN", COORD, {}, "s5 VOIDED->OPEN");
    deny(wo3, "VOIDED", COORD, { r2: R2_VOID }, "s5 VOIDED->VOIDED");
  } finally {
    w.cleanup();
  }
});

test("DENY FIXED whose red proof the kit refuses, a fix sha already used by an earlier FIXED, or a fixer replaced by reassignment (E_RED_PROOF, E_FIX_REUSED, E_ACTOR_NOT_FIXER)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    d.assign(wo, 1);
    const R = w.red(wo, 1);
    const F = w.fix(wo);
    refuses(() => d.go(wo, "FIXED", FIXER, w.proof(1, R, F, { redCase: { outcome: "PASSED" } })), "E_RED_PROOF_NOT_FAILED", "s1 red PASSED");
    assert.equal(d.ledger.fold(wo).state, "ASSIGNED");
    assert.equal(d.go(wo, "FIXED", FIXER, w.proof(1, R, F)).event.to, "FIXED");
    d.go(wo, "ASSIGNED", COORD, { reason: "the delta run failed" });
    d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER2.id));
    const F2 = w.fix(wo);
    refuses(() => d.go(wo, "FIXED", FIXER, w.proof(1, R, F2)), "E_ACTOR_NOT_FIXER", "s3 the replaced fixer");
    refuses(() => d.go(wo, "FIXED", FIXER2, w.proof(1, R, F)), "E_FIX_REUSED", "s2 the fix sha of the earlier FIXED");
    assert.equal(d.ledger.fold(wo).seq, 5, "no refused FIXED wrote an event");
    const ok = d.go(wo, "FIXED", FIXER2, w.proof(1, R, F2));
    assert.equal(ok.event.to, "FIXED");
    assert.equal(ok.event.seq, 6);
  } finally {
    w.cleanup();
  }
});

test("DENY the auditor as fixer and the fixer as verifier (E_INDEPENDENCE)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    w.fx.git(["branch", `audit/${wo}`, w.audited]);
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, AUDITOR.id)), "E_INDEPENDENCE_FIXER", "s1 fixer == auditor");
    assert.equal(d.seq(wo), 1);
    d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1));
    const R = w.red(wo, 1);
    const F = w.fix(wo);
    d.go(wo, "FIXED", FIXER, w.proof(1, R, F));
    d.goodDelta(wo, F);
    refuses(() => d.go(wo, "VERIFIED", { id: FIXER.id, role: "verifier" }), "E_INDEPENDENCE_VERIFIER", "s2 verifier == fixer");
    assert.equal(d.seq(wo), 3);
    assert.equal(d.go(wo, "VERIFIED", VERIFIER).event.to, "VERIFIED", "an independent verifier is accepted");
  } finally {
    w.cleanup();
  }
});

test("DENY ASSIGNED without branch audit/<wo-id>, without an acceptance test, with an expected failure matching a harness message or changed on reassignment, or on an unbound slot (E_ASSIGN)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    w.fx.git(["branch", `audit/${wo}`, w.audited]);
    w.fx.git(["branch", "feature/x", w.audited]);
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER.id, { branch: "feature/x" })), "E_ASSIGN_BRANCH", "s1 another branch");
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER.id, { acceptanceTest: undefined })), "E_ASSIGN_TEST", "s2 no acceptance test");
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER.id, { acceptanceTest: { file: testFile(1), expectedFailure: EXPECTED } })), "E_ASSIGN_TEST", "s2 no title");
    for (const expectedFailure of ["Cannot find module", ".*", "ERR_[A-Z_]+"]) {
      refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER.id, { acceptanceTest: { file: testFile(1), title: titleOf(1), expectedFailure } })), "E_ASSIGN_EXPECTED", `s3 ${expectedFailure} matches a harness sample`);
    }
    assert.equal(d.seq(wo), 1, "no refused ASSIGN wrote an event");
    d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1));
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER2.id, { acceptanceTest: { file: testFile(1), title: titleOf(1), expectedFailure: "expected \\d but got \\d" } })), "E_ASSIGN_EXPECTED_CHANGED", "s5 widened expectedFailure on reassignment");
    refuses(() => d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER2.id, { acceptanceTest: { file: testFile(1), title: "another title", expectedFailure: EXPECTED } })), "E_ASSIGN_EXPECTED_CHANGED", "s5 another title on reassignment");
    assert.equal(d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER2.id)).event.fields.fixer, FIXER2.id, "a reassignment repeating the same test is accepted");
    const slot = d.unbound(2);
    assert.ok(!d.ledger.list().includes(slot), "the unbound slot is not a live WO");
    w.fx.git(["branch", `audit/${slot}`, w.audited]);
    refuses(() => d.ledger.transition(slot, { to: "ASSIGNED", rev: 1, requestId: "assign-unbound", actor: COORD, ...d.assignFields(slot, 2) }), "E_ASSIGN_UNBOUND", "s4 unbound slot");
    assert.deepEqual(d.events(slot), ["0001.json"]);
  } finally {
    w.cleanup();
  }
});

test("DENY VERIFIED of a WO whose family has two live WOs until a permanent check exists at the red and fix commits (E_ROOT_CAUSE)", () => {
  const w = world();
  try {
    const d = desk(w);
    const PERM = "packages/x/test/permanent-retry.test.ts";
    const PERM_TITLE = "the retry family keeps a at 2";
    const wo1 = d.imp(1);
    const wo2 = d.imp(2);
    d.assign(wo2, 2);
    assert.equal(d.ledger.fold(wo2).state, "ASSIGNED", "the sibling of the family is live and not OPEN");
    const { F } = d.toFixed(wo1, 1, { [PERM]: withTitle(PERM_TITLE) });
    d.goodDelta(wo1, F);
    refuses(() => d.go(wo1, "VERIFIED", VERIFIER), "E_ROOT_CAUSE", "s1 two live retry WOs, no permanent check");
    refuses(() => d.go(wo1, "VERIFIED", VERIFIER, { permanentCheck: { file: PERM, title: "a title present nowhere" } }), "E_ROOT_CAUSE_ABSENT", "s2/s4 permanent check absent at R and F");
    assert.equal(d.seq(wo1), 3, "no refused VERIFIED wrote an event");
    assert.equal(d.go(wo1, "VERIFIED", VERIFIER, { permanentCheck: { file: PERM, title: PERM_TITLE } }).event.to, "VERIFIED");

    const wo3 = d.imp(3, { family: "time" });
    const wo4 = d.imp(4, { family: "time" });
    d.go(wo4, "VOIDED", COORD, { r2: R2_VOID });
    d.unbound(5, { family: "time" });
    const { F: F3 } = d.toFixed(wo3, 3);
    d.goodDelta(wo3, F3);
    assert.equal(d.go(wo3, "VERIFIED", VERIFIER).event.to, "VERIFIED", "s3 a VOIDED WO and an unbound slot are not live: no root-cause demand");
  } finally {
    w.cleanup();
  }
});

test("DENY VERIFIED when the delta run of the fix is not bound to the audited sha and F, misses a must-run check or the WO repro, has a FAIL, is BLOCKED, or follows a FAIL of the same F (E_VERIFY, E_NONDETERMINISTIC)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    const { R, F } = d.toFixed(wo, 1);
    const plan = (o = {}) => ({ base: w.audited, head: F, mustRun: [`wo:${wo}`, "check:lint"], binding: "BOUND", ...o });
    const pass = [{ id: `wo:${wo}`, status: "PASS" }, { id: "check:lint", status: "PASS" }];
    const tryVerify = (code, label) => {
      refuses(() => d.go(wo, "VERIFIED", VERIFIER), code, label);
      assert.equal(d.ledger.fold(wo).state, "FIXED", `${label}: still FIXED`);
    };
    d.delta(wo, plan({ head: R }), pass);
    tryVerify("E_VERIFY_SUBJECT", "s5 head is not F");
    d.delta(wo, plan({ base: R }), pass);
    tryVerify("E_VERIFY_SUBJECT", "s5 base is not the audited sha");
    d.delta(wo, plan({ binding: "BLOCKED" }), pass);
    tryVerify("E_VERIFY_BINDING", "s4 BLOCKED binding");
    d.delta(wo, plan({ mustRun: ["check:lint"] }), [{ id: "check:lint", status: "PASS" }]);
    tryVerify("E_VERIFY_REPRO", "s3 the WO repro is not a must-run check");
    d.delta(wo, plan(), [{ id: `wo:${wo}`, status: "PASS" }]);
    tryVerify("E_VERIFY_MISSING", "s1 check:lint has no result");
    d.delta(wo, plan(), [{ id: `wo:${wo}`, status: "PASS" }, { id: "check:lint", status: "FAIL" }]);
    tryVerify("E_VERIFY_FAIL", "s2 check:lint FAIL");
    d.delta(wo, plan(), pass);
    tryVerify("E_NONDETERMINISTIC", "s6 check:lint PASS after a FAIL of the same F");
    assert.equal(d.seq(wo), 3, "no refused VERIFIED wrote an event");
  } finally {
    w.cleanup();
  }
});

test("DENY CLOSED unless the tool's own origin/main contains F by ancestry or patch-id, has the acceptance title and a tool rule, and a tier-1 WO has an accepting lane or package review of F's patch labelled with the WO (E_CLOSE)", () => {
  const w = world();
  try {
    const d = desk(w);
    const { fx } = w;
    const wo = d.imp(1, { family: "money", tier: 1 });
    assert.equal(wo, "WO-1");
    const { R, F } = d.toFixed(wo, 1);
    d.goodDelta(wo, F);
    d.go(wo, "VERIFIED", VERIFIER);
    const good = w.receipt("wo-1-lane-review", F);
    const close = (fields, l = d.ledger) => d.go(wo, "CLOSED", COORD, { toolRule: NOT_GENERIC, reviewReceipt: good, ...fields }, l);
    const deny = (fields, code, label, l) => {
      refuses(() => close(fields, l), code, label);
      assert.equal(d.ledger.fold(wo).state, "VERIFIED", `${label}: still VERIFIED`);
    };
    const stub = (when, answer) => (cmd, args, opts) => (when(args) ? { status: 128, stdout: "", stderr: answer } : spawnSync(cmd, args, opts));

    // origin/main (bare) is the audited sha; HEAD = F and the local tracking ref is forged to F: only the tool's own fetch tells.
    fx.checkout(`audit/${wo}`);
    fx.git(["update-ref", "refs/remotes/origin/main", F]);
    deny({}, "E_CLOSE_NOT_ON_MAIN", "s1/s2 F is HEAD and a stale tracking ref, not on origin/main");
    deny({}, "E_CLOSE_MAIN_UNRESOLVED", "s4 fetch failure", d.open({ runner: stub((a) => a.includes("fetch"), "fatal: unable to access origin\n") }));

    fx.checkout("main");
    fx.git(["checkout", "-B", "squash-bad", w.audited]);
    fx.git(["merge", "--squash", F]);
    const bad = fx.commit("squash with other content", { "docs/extra.md": "extra\n" });
    w.setMain(bad);
    deny({}, "E_CLOSE_NOT_ON_MAIN", "s3 a squash with other content");

    fx.git(["checkout", "-B", "squash-good", w.audited]);
    fx.git(["merge", "--squash", F]);
    const sq = fx.commit("squash of F", {});
    w.setMain(sq);
    deny({ toolRule: "" }, "E_CLOSE_TOOL_RULE", "s6 empty tool rule");
    deny({ reviewReceipt: undefined }, "E_CLOSE_REVIEW", "s7 tier 1 without a receipt");
    deny({ reviewReceipt: w.receipt("b04-design-review", F) }, "E_CLOSE_REVIEW_LABEL", "s10 a label of no WO");
    deny({ reviewReceipt: w.receipt("wo-2-lane-review", F) }, "E_CLOSE_REVIEW_LABEL", "s10 a label of another WO");
    deny({}, "E_CLOSE_REVIEW_AMBIGUOUS", "s11 ambiguous sha12", d.open({ runner: stub((a) => a.includes("--verify") && a.includes(`${F.slice(0, 12)}^{commit}`), `error: short object ID ${F.slice(0, 12)} is ambiguous\nfatal: Needed a single revision\n`) }));
    deny({ reviewReceipt: w.receipt("wo-1-pkg-review", F, { omit: ["codex.log"] }) }, "E_CLOSE_REVIEW_FILES", "s12 no codex.log");
    deny({ reviewReceipt: w.receipt("wo-1-lane-review-r2", F, { omit: ["prompt.md"] }) }, "E_CLOSE_REVIEW_FILES", "s12 no prompt.md");
    deny({ reviewReceipt: w.receipt("wo-1-pkg-review-r3", F, { verdict: "REJECT" }) }, "E_CLOSE_REVIEW_VERDICT", "s9 REJECT");
    deny({ reviewReceipt: w.receipt("wo-1-lane-review-r4", R) }, "E_CLOSE_REVIEW_PATCH", "s8 a review of another patch");

    fx.checkout("squash-good");
    const dropped = fx.commit("drop the acceptance test", { [testFile(1)]: null });
    w.setMain(dropped);
    deny({}, "E_CLOSE_TITLE", "s5 acceptance title absent at origin/main");
    const restored = fx.commit("restore the acceptance test", { [testFile(1)]: withTitle(titleOf(1)) });
    w.setMain(restored);

    const closed = close({});
    assert.equal(closed.event.to, "CLOSED", "patch-id equality on a first-parent commit of origin/main closes");
    const hash = (name) => sha256Hex(readFileSync(join(good, name)));
    assert.deepEqual(closed.event.fields.reviewSha256, { "review.json": hash("review.json"), "codex.log": hash("codex.log"), "prompt.md": hash("prompt.md") }, "s13 the receipt is frozen in the event");
    assert.equal(d.ledger.fold(wo).state, "CLOSED");
  } finally {
    w.cleanup();
  }
});

test("OK a failed verification reopens to ASSIGNED and stays in the history and the summary (R2 21:128)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    const { R, F } = d.toFixed(wo, 1);
    refuses(() => d.go(wo, "ASSIGNED", COORD, {}), "E_REOPEN_REASON", "s3 REOPEN without a reason");
    refuses(() => d.go(wo, "ASSIGNED", COORD, { reason: "" }), "E_REOPEN_REASON", "s3 REOPEN with an empty reason");
    const R1 = "the delta run of the fix failed check:lint";
    assert.equal(d.go(wo, "ASSIGNED", COORD, { reason: R1 }).event.fields.reason, R1);
    assert.equal(d.ledger.fold(wo).state, "ASSIGNED");
    const F2 = w.fix(wo);
    d.go(wo, "FIXED", FIXER, w.proof(1, R, F2));
    d.goodDelta(wo, F2);
    d.go(wo, "VERIFIED", VERIFIER);
    const R2 = "the verifier found the repro flaky on a second machine";
    d.go(wo, "ASSIGNED", COORD, { reason: R2 });
    const folded = d.ledger.fold(wo);
    assert.equal(folded.state, "ASSIGNED");
    assert.deepEqual(folded.history.map((e) => e.to), ["OPEN", "ASSIGNED", "FIXED", "ASSIGNED", "FIXED", "VERIFIED", "ASSIGNED"], "s1 history keeps every attempt");
    assert.equal(d.events(wo).length, 7);
    const { summary } = d.ledger.summary();
    const row = summary.workOrders.find((x) => x.id === wo);
    assert.deepEqual(row.attempts, [{ fixSha: F, reopenedReason: R1 }, { fixSha: F2, reopenedReason: R2 }], "s2 the summary keeps both failed attempts");
  } finally {
    w.cleanup();
  }
});

test("RACE two transitions of one WO at the same revision, both orders held at the before-link hook: one commits, the other gets E_CONFLICT", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    d.assign(wo, 1);
    for (const [held, inner, target] of [["A", "B", 3], ["B", "A", 4]]) {
      const rev = d.seq(wo);
      assert.equal(rev, target - 1);
      const body = (who) => ({ to: "ASSIGNED", rev, requestId: `race-${target}-${who}`, actor: COORD, ...d.assignFields(wo, 1, `fixer-${who}`) });
      const eventFile = slash(d.eventPath(wo, target));
      let innerResult = null;
      let heldAtLink = false;
      const hold = d.open({
        beforeLink: (p) => {
          if (slash(p) !== eventFile || innerResult) return;
          heldAtLink = !existsSync(eventFile);
          innerResult = d.open().transition(wo, body(inner));
        },
      });
      refuses(() => hold.transition(wo, body(held)), "E_CONFLICT", `${held} held at the link loses to ${inner}`);
      assert.equal(heldAtLink, true, `${held} was waiting at its link while ${inner} ran`);
      assert.equal(innerResult.event.seq, target);
      const folded = d.ledger.fold(wo);
      assert.equal(folded.seq, target, "s1 exactly one event at that revision");
      assert.equal(folded.history[target - 1].requestId, `race-${target}-${inner}`, "the committed event is the winner's");
      assert.equal(folded.history[target - 1].fields.fixer, `fixer-${inner}`);
      assert.equal(d.events(wo).length, target);
    }
  } finally {
    w.cleanup();
  }
});

test("RACE (crash before link, crash after link): the retry with the same request id returns the committed event; another body gets E_CONFLICT", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    d.assign(wo, 1);
    const call = (seqSeen, requestId, fixer) => ({ to: "ASSIGNED", rev: seqSeen, requestId, actor: COORD, ...d.assignFields(wo, 1, fixer) });
    const crash = (point, seq) => d.open({ crashAt: { point, match: new RegExp(`/wo/${wo}/${pad4(seq)}\\.json$`) } });

    refuses(() => crash("afterTmp", 3).transition(wo, call(2, "req-3", "fixer-3")), "E_SIMULATED_CRASH", "crash before the link");
    assert.equal(existsSync(d.eventPath(wo, 3)), false, "nothing committed before the link");
    const retried = d.open().transition(wo, call(2, "req-3", "fixer-3"));
    assert.equal(retried.event.seq, 3, "the retry after a crash before the link commits");
    assert.deepEqual(d.events(wo), ["0001.json", "0002.json", "0003.json"]);

    refuses(() => crash("afterLink", 4).transition(wo, call(3, "req-4", "fixer-4")), "E_SIMULATED_CRASH", "crash after the link");
    const committed = JSON.parse(readFileSync(d.eventPath(wo, 4), "utf8"));
    assert.equal(committed.requestId, "req-4", "the event is committed by the link");
    const replay = d.open().transition(wo, call(3, "req-4", "fixer-4"));
    assert.deepEqual(replay.event, committed, "s1 the same request id returns the committed event");
    assert.deepEqual(d.events(wo), ["0001.json", "0002.json", "0003.json", "0004.json"], "s1 no duplicate event");
    const anchored = d.validRuns().some((id) => d.anchorsOf(id)[wo]?.seq === 4 && d.anchorsOf(id)[wo]?.hash === d.eventHash(wo, 4));
    assert.equal(anchored, true, "the retry leaves the committed event anchored");
    assert.deepEqual(d.open().transition(wo, call(3, "req-4", "fixer-4")).event, committed, "an identical second replay returns it again");
    refuses(() => d.open().transition(wo, call(3, "req-4", "fixer-other")), "E_CONFLICT", "s2 the same request id with another body");
    refuses(() => d.open().transition(wo, call(4, "req-4", "fixer-other")), "E_CONFLICT", "s2 the same request id with another body at the current revision");
    assert.equal(d.ledger.fold(wo).seq, 4);
    assert.equal(d.ledger.fold(wo).history[3].fields.fixer, "fixer-4");
  } finally {
    w.cleanup();
  }
});

test("DENY a tampered, gapped or tail-truncated chain against immutable run anchors, refuse a lower re-anchor, freeze the WO, and recover a truncated tail only by a coordinator LOST event (E_LEDGER_CORRUPT)", () => {
  const w = world();
  try {
    /** WO-1 at seq 4 (OPEN, ASSIGNED, reassigned twice); returns the anchor run of each committed event. */
    const chain = (d) => {
      const wo = d.imp(1);
      const runs = [null, null];
      runs.push(d.assign(wo, 1).anchorRun);
      runs.push(d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, "fixer-2")).anchorRun);
      runs.push(d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, "fixer-3")).anchorRun);
      for (const s of [2, 3, 4]) assert.deepEqual(d.anchorsOf(runs[s])[wo], { seq: s, hash: d.eventHash(wo, s) }, `the transition to seq ${s} wrote its anchor run`);
      return { wo, runs };
    };

    // s3 / s9: the tail of a transition is deleted right after it commits (no summary in between).
    const d = desk(w);
    const { wo, runs } = chain(d);
    const h4 = d.eventHash(wo, 4);
    unlinkSync(d.eventPath(wo, 4));
    refuses(() => d.ledger.fold(wo), "E_LEDGER_CORRUPT", "s3/s9 tail truncated behind the post-transition anchor");
    refuses(() => d.ledger.transition(wo, { to: "ASSIGNED", rev: 3, requestId: "frozen-3", actor: COORD, ...d.assignFields(wo, 1, "fixer-5") }), "E_LEDGER_CORRUPT", "s6 a frozen WO takes no transition at its surviving revision");
    assert.equal(existsSync(d.eventPath(wo, 4)), false, "s6 nothing written into the frozen WO");
    const cli = spawnSync(process.execPath, [CLI, "show", wo, "--root", d.root], { encoding: "utf8" });
    assert.equal(cli.status, 2, "the CLI exits 2 on a frozen WO");
    assert.match(`${cli.stdout}${cli.stderr}`, /E_LEDGER_CORRUPT/);

    // s4: a summary over the frozen WO never anchors it lower.
    const { runId, summary } = d.ledger.summary();
    assert.deepEqual(summary.frozen, [wo]);
    const re = d.anchorsOf(runId)[wo];
    assert.ok(re === undefined || (re.seq === 4 && re.hash === h4), `s4 no lower re-anchor: ${JSON.stringify(re)}`);
    refuses(() => d.ledger.fold(wo), "E_LEDGER_CORRUPT", "s4 still frozen after the summary run");

    // s5: rebuild every summary.json naming seq 4 as the truncated view (manifests regenerated): anchors.json still decides.
    const truncatedView = join(d.root, "runs", runs[3], "summary.json");
    for (const id of d.validRuns()) {
      const dir = join(d.root, "runs", id);
      if (d.anchorsOf(id)[wo]?.seq !== 4 || !existsSync(join(dir, "summary.json")) || !existsSync(truncatedView)) continue;
      writeFileSync(join(dir, "summary.json"), readFileSync(truncatedView));
      unlinkSync(join(dir, MANIFEST_NAME));
      writeManifest(dir);
    }
    refuses(() => d.ledger.fold(wo), "E_LEDGER_CORRUPT", "s5 anchors come from anchors.json, never summary.json");

    // s8 then the recovery.
    refuses(() => d.ledger.lost(wo, { anchorRun: runs[4], actor: AUDITOR, requestId: "lost-auditor" }), "E_LOST_AUTHORITY", "s8 LOST by a non-coordinator");
    refuses(() => d.ledger.lost(wo, { actor: COORD, requestId: "lost-no-anchor" }), "E_LOST_AUTHORITY", "s8 LOST without an anchor run");
    const lost = d.ledger.lost(wo, { anchorRun: runs[4], actor: COORD, requestId: "lost-ok" });
    assert.equal(lost.event.to, "LOST");
    assert.deepEqual(
      { anchorRun: lost.event.fields.anchorRun, anchorSeq: lost.event.fields.anchorSeq, anchorHash: lost.event.fields.anchorHash, lastSurvivingSeq: lost.event.fields.lastSurvivingSeq },
      { anchorRun: runs[4], anchorSeq: 4, anchorHash: h4, lastSurvivingSeq: 3 },
    );
    const recovered = d.ledger.fold(wo);
    assert.equal(recovered.state, "ASSIGNED", "the state is the last surviving event's");
    assert.equal(recovered.history.at(-1).to, "LOST", "the LOST event stays in the history");
    assert.equal(d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, "fixer-6")).event.fields.fixer, "fixer-6", "the recovered WO takes transitions again");

    // s1: a changed middle event breaks the prev chain (anchors removed, so only the chain can tell).
    const d1 = desk(w);
    const c1 = chain(d1);
    rmSync(join(d1.root, "runs"), { recursive: true, force: true });
    const e2 = JSON.parse(readFileSync(d1.eventPath(c1.wo, 2), "utf8"));
    e2.fields.fixer = "someone-else";
    writeFileSync(d1.eventPath(c1.wo, 2), `${JSON.stringify(e2)}\n`);
    refuses(() => d1.ledger.fold(c1.wo), "E_LEDGER_CORRUPT", "s1 prev hash");

    // s2: a gap whose prev chain still holds (events 3 and 4 moved up by one; anchors removed).
    const d2 = desk(w);
    const c2 = chain(d2);
    rmSync(join(d2.root, "runs"), { recursive: true, force: true });
    renameSync(d2.eventPath(c2.wo, 4), d2.eventPath(c2.wo, 5));
    renameSync(d2.eventPath(c2.wo, 3), d2.eventPath(c2.wo, 4));
    refuses(() => d2.ledger.fold(c2.wo), "E_LEDGER_CORRUPT", "s2 contiguity");

    // s7: the anchored tail changed in place is tamper: no LOST un-freezes it.
    const d3 = desk(w);
    const c3 = chain(d3);
    const e4 = JSON.parse(readFileSync(d3.eventPath(c3.wo, 4), "utf8"));
    e4.fields.fixer = "someone-else";
    writeFileSync(d3.eventPath(c3.wo, 4), `${JSON.stringify(e4)}\n`);
    refuses(() => d3.ledger.fold(c3.wo), "E_LEDGER_CORRUPT", "anchor hash mismatch");
    refuses(() => d3.ledger.lost(c3.wo, { anchorRun: c3.runs[4], actor: COORD, requestId: "lost-tamper" }), "E_LOST_NOT_TRUNCATION", "s7 LOST for tamper");
    refuses(() => d3.ledger.fold(c3.wo), "E_LEDGER_CORRUPT", "s7 still frozen");
  } finally {
    w.cleanup();
  }
});

test("RACE (two importers of one finding, both orders; crash after the claim) and RETRY: one live WO per fingerprint, claim before slot, pending claim refused, class D not imported, invalid VOID needs coordinator and R2 citation", () => {
  const w = world();
  try {
    for (const [held, inner] of [["imp-A", "imp-B"], ["imp-B", "imp-A"]]) {
      const d = desk(w);
      const f = w.finding(1);
      let innerResult = null;
      let heldAtLink = false;
      const hold = d.open({
        beforeLink: (p) => {
          if (!CLAIM.test(slash(p)) || innerResult) return;
          heldAtLink = !existsSync(p);
          innerResult = d.open().importFinding(f, { actor: AUDITOR, requestId: inner });
        },
      });
      const heldResult = hold.importFinding(f, { actor: AUDITOR, requestId: held });
      assert.equal(heldAtLink, true, `${held} was waiting at its claim link while ${inner} imported`);
      assert.equal(heldResult.woId, innerResult.woId, `${held} gets the WO ${inner} bound`);
      assert.deepEqual(d.ledger.list(), [innerResult.woId], "one live WO");
      assert.deepEqual(readdirSync(join(d.root, "wo")), [innerResult.woId], "s1 the loser made no slot: claim before slot");
      assert.deepEqual(d.events(innerResult.woId), ["0001.json"]);
    }

    const d = desk(w);
    const f = w.finding(2);
    refuses(() => d.open({ crashAt: { point: "afterLink", match: CLAIM } }).importFinding(f, { actor: AUDITOR, requestId: "imp-1" }), "E_SIMULATED_CRASH", "crash after the claim");
    refuses(() => d.open().importFinding(f, { actor: AUDITOR, requestId: "imp-2" }), "E_IMPORT_PENDING", "s3 another request id on a pending claim");
    assert.equal(existsSync(join(d.root, "wo")) ? readdirSync(join(d.root, "wo")).length : 0, 0, "s3 the refused importer made no slot");
    const resumed = d.open().importFinding(f, { actor: AUDITOR, requestId: "imp-1" });
    assert.deepEqual(d.ledger.list(), [resumed.woId], "s2 the same request id resumes the claim");
    assert.deepEqual(readdirSync(join(d.root, "wo")), [resumed.woId], "s2 one slot");
    assert.equal(d.ledger.fold(resumed.woId).state, "OPEN");

    assert.equal(d.open().importFinding(f, { actor: AUDITOR, requestId: "imp-1" }).woId, resumed.woId, "RETRY identical replay");
    assert.equal(d.open().importFinding(f, { actor: AUDITOR, requestId: "imp-redelivered" }).woId, resumed.woId, "RETRY the same finding redelivered under another request id");
    assert.equal(d.open().importFinding(f, { actor: AUDITOR }).woId, resumed.woId, "RETRY the default request id");
    assert.deepEqual(d.ledger.list(), [resumed.woId]);
    assert.deepEqual(d.events(resumed.woId), ["0001.json"], "a replay writes no event");

    refuses(() => d.ledger.importFinding(w.finding(3, { class: "D", tier: 3, kind: "IMPROVEMENT" }), { actor: AUDITOR }), "E_IMPORT_CLASS_D", "s4 class D");
    assert.deepEqual(d.ledger.list(), [resumed.woId], "s4 nothing imported");

    const wo = resumed.woId;
    refuses(() => d.go(wo, "VOIDED", AUDITOR, { r2: R2_VOID }), "E_VOID_AUTHORITY", "s5 VOID by a non-coordinator");
    refuses(() => d.go(wo, "VOIDED", COORD, {}), "E_VOID_AUTHORITY", "s5 VOID without an R2 citation");
    refuses(() => d.go(wo, "VOIDED", COORD, { r2: { doc: "21_QUALITY_AND_ACCEPTANCE.md" } }), "E_VOID_AUTHORITY", "s5 VOID citing no heading");
    assert.equal(d.ledger.fold(wo).state, "OPEN");
    assert.equal(d.go(wo, "VOIDED", COORD, { r2: R2_VOID }).event.to, "VOIDED");
  } finally {
    w.cleanup();
  }
});

test("OK summary counts by family, state, tier and kind, blocked capabilities, LOST events, anchors and unbound slots come only from the event fold, WO ids in numeric order", () => {
  const w = world();
  try {
    const d = desk(w);
    const spec = {
      3: { family: "money", tier: 1, materialClass: "false payment authority", capability: "payments-ach" },
      4: { family: "evidence", tier: 3, kind: "IMPROVEMENT" },
      5: { family: "time", kind: "BLOCKED_VERIFICATION" },
    };
    const ids = [];
    for (let k = 1; k <= 10; k++) ids.push(d.imp(k, spec[k] ?? {}));
    const expectedIds = Array.from({ length: 10 }, (_v, i) => `WO-${i + 1}`);
    assert.deepEqual(ids, expectedIds);
    const slot = d.unbound(11);
    assert.equal(slot, "WO-11");

    const assignRun = d.assign("WO-1", 1).anchorRun;
    const h2 = d.eventHash("WO-1", 2);
    unlinkSync(d.eventPath("WO-1", 2));
    d.ledger.lost("WO-1", { anchorRun: assignRun, actor: COORD, requestId: "lost-wo-1" });
    d.go("WO-4", "VOIDED", COORD, { r2: R2_VOID });
    const first = d.ledger.summary();
    d.assign("WO-2", 2);
    const { runId, summary } = d.ledger.summary();
    assert.notEqual(runId, first.runId);

    assert.deepEqual(d.ledger.list(), expectedIds, "s4 numeric order");
    assert.deepEqual(summary.workOrders.map((x) => x.id), expectedIds, "s4 numeric order in the summary");
    assert.ok(summary.workOrders.findIndex((x) => x.id === "WO-9") < summary.workOrders.findIndex((x) => x.id === "WO-10"), "s4 WO-9 < WO-10");
    assert.deepEqual(summary.counts, {
      byFamily: { retry: 7, money: 1, evidence: 1, time: 1 },
      byState: { OPEN: 8, ASSIGNED: 1, VOIDED: 1 },
      byTier: { 1: 1, 2: 8, 3: 1 },
      byKind: { DEFECT: 8, IMPROVEMENT: 1, BLOCKED_VERIFICATION: 1 },
    }, "s1 counts from the fold (WO-2 assigned after the first summary), the unbound slot not counted");
    assert.equal(summary.workOrders.find((x) => x.id === "WO-1").state, "OPEN", "WO-1 holds its last surviving state");
    assert.deepEqual(summary.blockedCapabilities, ["payments-ach"], "s2 the material WO blocks its capability");
    assert.equal(summary.lost.length, 1, "s5 the LOST event is reported");
    assert.deepEqual(
      { woId: summary.lost[0].woId, anchorRun: summary.lost[0].anchorRun, anchorSeq: summary.lost[0].anchorSeq, anchorHash: summary.lost[0].anchorHash, lastSurvivingSeq: summary.lost[0].lastSurvivingSeq },
      { woId: "WO-1", anchorRun: assignRun, anchorSeq: 2, anchorHash: h2, lastSurvivingSeq: 1 },
    );
    assert.deepEqual(summary.unboundSlots, ["WO-11"]);
    assert.deepEqual(summary.frozen, []);

    const dir = join(d.root, "runs", runId);
    assert.doesNotThrow(() => verifyManifest(dir), "the run verifies");
    const manifest = readFileSync(join(dir, MANIFEST_NAME), "utf8");
    assert.match(manifest, / {2}anchors\.json\n/, "s3 the run lists anchors.json");
    assert.match(manifest, / {2}summary\.json\n/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")), summary, "summary.json is the returned summary");
    const anchors = d.anchorsOf(runId);
    assert.deepEqual(Object.keys(anchors).sort(), [...expectedIds].sort(), "s3 one anchor per bound WO, none for the unbound slot");
    for (const id of expectedIds) {
      const last = d.events(id).at(-1);
      assert.deepEqual(anchors[id], { seq: Number.parseInt(last, 10), hash: sha256Hex(readFileSync(join(d.root, "wo", id, last))) }, `s3 anchor of ${id}`);
    }
    assert.deepEqual(summary.anchors, anchors);

    // LOST-citation row (coordinator ruling 19:52Z): a LOST event that does not cite its anchor (run id, seq, hash) is refused by the fold.
    const e1 = readFileSync(d.eventPath("WO-5", 1));
    const forged = { seq: 2, prev: sha256Hex(e1), at: "2026-10-09T12:00:00.000Z", actor: COORD, requestId: "lost-forged", from: "OPEN", to: "LOST", fields: { lastSurvivingSeq: 1 } };
    writeFileSync(d.eventPath("WO-5", 2), `${JSON.stringify(forged)}
`);
    refuses(() => d.ledger.fold("WO-5"), "E_LOST_NO_ANCHOR", "a LOST event without its anchor citation");
  } finally {
    w.cleanup();
  }
});

// ---------------------------------------------------------------- fix round 1 (adversary FAIL 8c7d810; coordinator rulings 20:23Z)

test("ADV-1: LOST records the runs it supersedes (fields.supersedes); it recovers whichever max-seq anchor run is cited, and a run outside that list is never exempt by run-id order (E_LEDGER_CORRUPT)", () => {
  const w = world();
  try {
    for (const cite of ["transition", "summary"]) {
      const d = desk(w);
      const wo = d.imp(1);
      d.assign(wo, 1);
      const runA = d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, "fixer-2")).anchorRun;
      const runS = d.ledger.summary().runId;
      const h3 = d.eventHash(wo, 3);
      assert.deepEqual(d.anchorsOf(runA)[wo], { seq: 3, hash: h3 }, "the transition run anchors seq 3");
      assert.deepEqual(d.anchorsOf(runS)[wo], { seq: 3, hash: h3 }, "the later summary run anchors the same seq 3");
      unlinkSync(d.eventPath(wo, 3));
      refuses(() => d.ledger.fold(wo), "E_LEDGER_CORRUPT", `${cite}: the truncated tail freezes the WO`);

      const anchorRun = cite === "transition" ? runA : runS;
      let lost;
      try {
        lost = d.ledger.lost(wo, { anchorRun, actor: COORD, requestId: `lost-${cite}` });
      } catch (e) {
        assert.fail(`${cite}: LOST citing the max-seq run ${anchorRun} was refused with ${e.code}: ${e.message}`);
      }
      assert.equal(lost.event.seq, 3, `${cite}: LOST takes the lost seq`);
      assert.equal(lost.event.to, "LOST");
      assert.deepEqual(
        { anchorRun: lost.event.fields.anchorRun, anchorSeq: lost.event.fields.anchorSeq, anchorHash: lost.event.fields.anchorHash, lastSurvivingSeq: lost.event.fields.lastSurvivingSeq },
        { anchorRun, anchorSeq: 3, anchorHash: h3, lastSurvivingSeq: 2 },
      );
      assert.deepEqual([...(lost.event.fields.supersedes ?? [])].sort(), [runA, runS].sort(), `${cite}: supersedes lists every verified run anchoring seq 3, the cited one and the other`);
      const recovered = d.ledger.fold(wo);
      assert.equal(recovered.state, "ASSIGNED", `${cite}: the state is the last surviving event's`);
      assert.equal(recovered.seq, 3);
      assert.deepEqual(d.ledger.lost(wo, { anchorRun, actor: COORD, requestId: `lost-${cite}` }).event, lost.event, `${cite}: the same LOST request replays its event`);

      // A complete, verifying copy of a superseded run under a LOWER run id (a clock step-back between processes): not in supersedes,
      // so its seq-3 anchor (the lost bytes) must still freeze the WO.
      const lowId = `${String(Number.parseInt(runA.slice(0, 13), 10) - 1).padStart(13, "0")}-000000`;
      cpSync(join(d.root, "runs", runS), join(d.root, "runs", lowId), { recursive: true });
      assert.doesNotThrow(() => verifyManifest(join(d.root, "runs", lowId)), "the lower-id run verifies");
      refuses(() => d.ledger.fold(wo), "E_LEDGER_CORRUPT", `${cite}: a run outside supersedes is not exempt even with a run id below the cited run`);
    }
  } finally {
    w.cleanup();
  }
});

test("ADV-2: a work order present in an anchor but missing on disk (its folder or its binding) is frozen in the summary and keeps its capability blocked; import writes an anchor run (E_LEDGER_CORRUPT kind missing)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo1 = d.imp(1);
    const wo2 = d.imp(2, { family: "money", tier: 1, materialClass: "false payment authority", capability: "payments-ach" });
    d.assign(wo2, 2);
    const first = d.ledger.summary().summary;
    assert.deepEqual(first.blockedCapabilities, ["payments-ach"], "WO-2 blocks payments-ach while it is on disk");
    assert.deepEqual(first.frozen, []);
    const wo3 = d.imp(3);
    const importAnchored = d.validRuns().some((id) => d.anchorsOf(id)[wo3]?.seq === 1 && d.anchorsOf(id)[wo3]?.hash === d.eventHash(wo3, 1));

    rmSync(join(d.root, "wo", wo2), { recursive: true, force: true });
    const fp1 = JSON.parse(readFileSync(d.eventPath(wo1, 1), "utf8")).fields.fingerprint;
    unlinkSync(join(d.root, "fp", `${fp1}.wo.json`));
    rmSync(join(d.root, "wo", wo3), { recursive: true, force: true });

    const { summary } = d.ledger.summary();
    assert.deepEqual(summary.frozen, [wo1, wo2, wo3], "P5/P5b: a deleted folder (WO-2, WO-3) or binding (WO-1) of an anchored WO is frozen, never dropped");
    assert.deepEqual(summary.blockedCapabilities, ["payments-ach"], "P5: the deleted material WO-2 keeps payments-ach blocked");
    refusesKind(() => d.ledger.fold(wo2), "E_LEDGER_CORRUPT", "missing", "the folder of the anchored WO-2 is missing");
    assert.equal(importAnchored, true, "import wrote an anchor run naming WO-3 at seq 1 before any summary");
  } finally {
    w.cleanup();
  }
});

test("ADV-3: the CLI requires an explicit --role for import, transitions and LOST; without it exit 1 E_USAGE and nothing is written", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    const runId = d.ledger.summary().runId;
    const v = cli(["void", wo, "--root", d.root, "--actor", "fixer-1", "--rev", "1", "--fields", JSON.stringify({ r2: R2_VOID })]);
    assert.equal(v.status, 1, `P2 void without --role exits 1 (got ${v.status}, stdout ${v.stdout})`);
    assert.match(v.stderr, /^E_USAGE/);
    assert.equal(d.ledger.fold(wo).state, "OPEN", "P2 the WO stays OPEN");
    assert.equal(d.ledger.fold(wo).seq, 1, "P2 no event written");

    const l = cli(["lost", wo, "--root", d.root, "--actor", "coordinator-1", "--anchor", runId]);
    assert.equal(l.status, 1, "lost without --role exits 1");
    assert.match(l.stderr, /^E_USAGE/);
    assert.equal(d.ledger.fold(wo).seq, 1, "no LOST written");

    const i = cli(["import", JSON.stringify(w.finding(2)), "--root", d.root, "--actor", "auditor-1"]);
    assert.equal(i.status, 1, "import without --role exits 1");
    assert.match(i.stderr, /^E_USAGE/);
    assert.deepEqual(d.ledger.list(), [wo], "nothing imported");

    const ok = cli(["void", wo, "--root", d.root, "--actor", "coordinator-1", "--role", "coordinator", "--rev", "1", "--fields", JSON.stringify({ r2: R2_VOID })]);
    assert.equal(ok.status, 0, `an explicit coordinator role voids: ${ok.stderr}`);
    assert.deepEqual(JSON.parse(ok.stdout).event.actor, { id: "coordinator-1", role: "coordinator" }, "the recorded role is the declared one");
    assert.equal(d.ledger.fold(wo).state, "VOIDED");
  } finally {
    w.cleanup();
  }
});

test("ADV-4: the CLI requires --rev and its default request id covers the revision: a second verify after a reopen commits a new VERIFIED, a retry at the same revision replays, no --rev is E_USAGE", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    const { R, F } = d.toFixed(wo, 1);
    d.goodDelta(wo, F);
    const asVerifier = ["--actor", VERIFIER.id, "--role", VERIFIER.role];
    const asCoord = ["--actor", COORD.id, "--role", COORD.role];
    const v1 = cli(["verify", wo, "--root", d.root, ...asVerifier, "--rev", "3"]);
    assert.equal(v1.status, 0, v1.stderr);
    const e4 = JSON.parse(v1.stdout).event;
    assert.equal(e4.seq, 4);
    const r1 = cli(["reopen", wo, "--root", d.root, ...asCoord, "--rev", "4", "--fields", JSON.stringify({ reason: "flaky" })]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(JSON.parse(r1.stdout).event.seq, 5);
    const F2 = w.fix(wo);
    assert.equal(d.go(wo, "FIXED", FIXER, w.proof(1, R, F2)).event.seq, 6);
    d.goodDelta(wo, F2);

    const v2 = cli(["verify", wo, "--root", d.root, ...asVerifier, "--rev", "6"]);
    assert.equal(v2.status, 0, v2.stderr);
    const e7 = JSON.parse(v2.stdout).event;
    assert.equal(e7.seq, 7, "P3 the second verify of a new cycle commits event 7, not the seq-4 event of the first cycle");
    assert.equal(d.ledger.fold(wo).state, "VERIFIED", "P3 the WO is VERIFIED again");
    assert.equal(d.ledger.fold(wo).seq, 7);

    const again = cli(["verify", wo, "--root", d.root, ...asVerifier, "--rev", "6"]);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout).event, e7, "RETRY the identical call at the same revision replays event 7");
    assert.equal(d.ledger.fold(wo).seq, 7, "RETRY no new event");

    const noRev = cli(["reopen", wo, "--root", d.root, ...asCoord, "--fields", JSON.stringify({ reason: "flaky" })]);
    assert.equal(noRev.status, 1, "a transition without --rev exits 1");
    assert.match(noRev.stderr, /^E_USAGE/);
    assert.equal(d.ledger.fold(wo).seq, 7, "no event without --rev");

    assert.equal(e4.requestId, sha256Hex(canonical({ woId: wo, to: "VERIFIED", actor: VERIFIER, rev: 3, fields: {} })), "default request id = sha256(canonical{woId, to, actor, rev, fields})");
    assert.equal(e7.requestId, sha256Hex(canonical({ woId: wo, to: "VERIFIED", actor: VERIFIER, rev: 6, fields: {} })));
  } finally {
    w.cleanup();
  }
});

test("ADV-5: RETRY of an import: identical replay and identical redelivery return the WO; the same fingerprint (bound or claimed by the same request id) with another finding body is E_IMPORT_CONFLICT", () => {
  const w = world();
  try {
    const d = desk(w);
    const f = w.finding(1);
    const wo = d.ledger.importFinding(f, { actor: AUDITOR, requestId: "imp-1" }).woId;
    assert.equal(d.ledger.importFinding(f, { actor: AUDITOR, requestId: "imp-1" }).woId, wo, "identical replay");
    assert.equal(d.ledger.importFinding(f, { actor: AUDITOR, requestId: "imp-redelivered" }).woId, wo, "identical redelivery under another request id");
    const material = w.finding(1, { family: "money", tier: 1, materialClass: "false payment authority", capability: "payments-ach" });
    refuses(() => d.ledger.importFinding(material, { actor: AUDITOR, requestId: "imp-1" }), "E_IMPORT_CONFLICT", "P6 same key, another body (bound)");
    refuses(() => d.ledger.importFinding(material, { actor: AUDITOR, requestId: "imp-other" }), "E_IMPORT_CONFLICT", "P6 same fingerprint, another body, another request id (bound)");
    assert.deepEqual(d.ledger.list(), [wo]);
    assert.deepEqual(d.events(wo), ["0001.json"], "no event written");
    assert.equal(d.ledger.fold(wo).history[0].fields.finding.tier, 2, "the bound finding is unchanged");

    const g = w.finding(2);
    refuses(() => d.open({ crashAt: { point: "afterLink", match: CLAIM } }).importFinding(g, { actor: AUDITOR, requestId: "imp-2" }), "E_SIMULATED_CRASH", "crash after the claim");
    refuses(() => d.open().importFinding(w.finding(2, { tier: 1, family: "money", materialClass: "false payment authority", capability: "payments-ach" }), { actor: AUDITOR, requestId: "imp-2" }), "E_IMPORT_CONFLICT", "same request id on the pending claim with another body");
    assert.deepEqual(d.ledger.list(), [wo], "the conflicting body made no WO");
    const resumed = d.open().importFinding(g, { actor: AUDITOR, requestId: "imp-2" });
    assert.deepEqual(d.ledger.list(), [wo, resumed.woId], "the identical body resumes the claim");
  } finally {
    w.cleanup();
  }
});

test("ADV-6: the root-cause rule counts every non-VOIDED WO of the family in any state: two FIXED siblings, and a sibling already CLOSED, need the permanent check (E_ROOT_CAUSE)", () => {
  const w = world();
  try {
    const d = desk(w);
    const PERM = "packages/x/test/permanent-retry.test.ts";
    const PERM_TITLE = "the retry family keeps a at 2";
    const wo1 = d.imp(1);
    const wo2 = d.imp(2);
    const { F: F1 } = d.toFixed(wo1, 1, { [PERM]: withTitle(PERM_TITLE) });
    const { F: F2 } = d.toFixed(wo2, 2);
    assert.deepEqual([d.ledger.fold(wo1).state, d.ledger.fold(wo2).state], ["FIXED", "FIXED"]);
    d.goodDelta(wo1, F1);
    d.goodDelta(wo2, F2);
    refuses(() => d.go(wo1, "VERIFIED", VERIFIER), "E_ROOT_CAUSE", "P4 the sibling WO-2 is FIXED");
    assert.equal(d.seq(wo1), 3, "no VERIFIED written");
    assert.equal(d.go(wo1, "VERIFIED", VERIFIER, { permanentCheck: { file: PERM, title: PERM_TITLE } }).event.to, "VERIFIED");
    refuses(() => d.go(wo2, "VERIFIED", VERIFIER), "E_ROOT_CAUSE", "P4 the sibling WO-1 is VERIFIED");
    assert.equal(d.seq(wo2), 3);

    // first-CLOSED order: WO-3 closes alone, then WO-4 of the same family arrives.
    const wo3 = d.imp(3, { family: "time" });
    const { F: F3 } = d.toFixed(wo3, 3);
    d.goodDelta(wo3, F3);
    d.go(wo3, "VERIFIED", VERIFIER);
    w.setMain(F3);
    d.go(wo3, "CLOSED", COORD, { toolRule: NOT_GENERIC });
    assert.equal(d.ledger.fold(wo3).state, "CLOSED");
    const wo4 = d.imp(4, { family: "time" });
    const { F: F4 } = d.toFixed(wo4, 4);
    d.goodDelta(wo4, F4);
    refuses(() => d.go(wo4, "VERIFIED", VERIFIER), "E_ROOT_CAUSE", "the sibling WO-3 is CLOSED");
    assert.equal(d.ledger.fold(wo4).state, "FIXED");
  } finally {
    w.cleanup();
  }
});

test("ADV-8: the verifier is none of the fixers ever ASSIGNED on the WO: an earlier fixer after reassignment is refused (E_INDEPENDENCE_VERIFIER)", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1);
    const { R } = d.toFixed(wo, 1);
    d.go(wo, "ASSIGNED", COORD, { reason: "the delta run failed" });
    d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, FIXER2.id));
    const F2 = w.fix(wo);
    d.go(wo, "FIXED", FIXER2, w.proof(1, R, F2));
    d.goodDelta(wo, F2);
    refuses(() => d.go(wo, "VERIFIED", { id: FIXER.id, role: "verifier" }), "E_INDEPENDENCE_VERIFIER", "P7 fixer-1 (an earlier fixer whose commits are in F2) verifies");
    refuses(() => d.go(wo, "VERIFIED", { id: FIXER2.id, role: "verifier" }), "E_INDEPENDENCE_VERIFIER", "the current fixer verifies");
    assert.equal(d.ledger.fold(wo).state, "FIXED");
    assert.equal(d.seq(wo), 6, "no VERIFIED written");
    assert.equal(d.go(wo, "VERIFIED", VERIFIER).event.to, "VERIFIED", "an independent verifier is accepted");
  } finally {
    w.cleanup();
  }
});

test("ADV-9: a run whose manifest does not verify (a changed, an extra or a missing file, or an anchors.json that is not JSON) freezes the WO (E_LEDGER_CORRUPT kind run); only a run without a manifest is ignored", () => {
  const w = world();
  try {
    const setup = () => {
      const d = desk(w);
      const wo = d.imp(1);
      d.assign(wo, 1);
      const run3 = d.go(wo, "ASSIGNED", COORD, d.assignFields(wo, 1, "fixer-2")).anchorRun;
      return { d, wo, dir: join(d.root, "runs", run3) };
    };
    {
      const { d, wo } = setup();
      const crashed = join(d.root, "runs", "0000000000001-abcdef");
      mkdirSync(crashed);
      writeFileSync(join(crashed, "anchors.json"), `${JSON.stringify({ [wo]: { seq: 9, hash: "0".repeat(64) } })}\n`);
      assert.equal(d.ledger.fold(wo).seq, 3, "a run without a manifest (crash before the manifest) is ignored");
    }
    const cases = [
      ["P8 anchors.json changed after its manifest", (c) => writeFileSync(join(c.dir, "anchors.json"), `${JSON.stringify({ [c.wo]: { seq: 2, hash: c.d.eventHash(c.wo, 2) } })}\n`)],
      ["an extra file in the run", (c) => writeFileSync(join(c.dir, "extra.json"), "{}\n")],
      ["anchors.json missing from the run", (c) => unlinkSync(join(c.dir, "anchors.json"))],
      [
        "anchors.json not JSON under a regenerated manifest",
        (c) => {
          writeFileSync(join(c.dir, "anchors.json"), "{not json\n");
          unlinkSync(join(c.dir, MANIFEST_NAME));
          writeManifest(c.dir);
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const c = setup();
      mutate(c);
      refusesKind(() => c.d.ledger.fold(c.wo), "E_LEDGER_CORRUPT", "run", label);
    }
  } finally {
    w.cleanup();
  }
});

test("W-08b: CLOSED is refused when origin/main is the red commit (title present, fix absent) and when the fetch fails with the tracking ref forged to F (E_CLOSE_NOT_ON_MAIN, E_CLOSE_MAIN_UNRESOLVED)", () => {
  const w = world();
  try {
    const d = desk(w);
    const { fx } = w;
    const wo = d.imp(1);
    const { R, F } = d.toFixed(wo, 1);
    d.goodDelta(wo, F);
    d.go(wo, "VERIFIED", VERIFIER);
    const deny = (code, label, l) => {
      refuses(() => d.go(wo, "CLOSED", COORD, { toolRule: NOT_GENERIC }, l), code, label);
      assert.equal(d.ledger.fold(wo).state, "VERIFIED", `${label}: still VERIFIED`);
      assert.equal(d.seq(wo), 4, `${label}: no event`);
    };
    w.setMain(R);
    assert.equal(spawnSync("git", ["show", `${R}:${testFile(1)}`], { cwd: fx.work, encoding: "utf8" }).stdout.includes(JSON.stringify(titleOf(1))), true, "the acceptance title is at origin/main = R");
    deny("E_CLOSE_NOT_ON_MAIN", "s1 origin/main = R: the title is there, the fix is not");

    w.setMain(w.audited);
    fx.git(["update-ref", "refs/remotes/origin/main", F]);
    assert.equal(fx.git(["rev-parse", "refs/remotes/origin/main"]), F, "the stale tracking ref names F right before the failing fetch");
    const failFetch = (cmd, args, opts) => (args.includes("fetch") ? { status: 128, stdout: "", stderr: "fatal: unable to access origin\n" } : spawnSync(cmd, args, opts));
    deny("E_CLOSE_MAIN_UNRESOLVED", "s4 fetch fails and the tracking ref is forged to F: fail closed", d.open({ runner: failFetch }));

    w.setMain(F);
    assert.equal(d.go(wo, "CLOSED", COORD, { toolRule: NOT_GENERIC }).event.to, "CLOSED", "positive control: F on origin/main closes");
  } finally {
    w.cleanup();
  }
});

test("ADV-12: a tier-1 review receipt must resolve (realpath) under <kauroRoot>/tools/review/out, kauroRoot from repos.json; a correctly named receipt elsewhere, through .., through a junction, or without kauroRoot is E_REVIEW_RECEIPT", () => {
  const w = world();
  try {
    const d = desk(w);
    const wo = d.imp(1, { family: "money", tier: 1 });
    const { F } = d.toFixed(wo, 1);
    d.goodDelta(wo, F);
    d.go(wo, "VERIFIED", VERIFIER);
    w.setMain(F);
    const close = (reviewReceipt) => d.go(wo, "CLOSED", COORD, { toolRule: NOT_GENERIC, reviewReceipt });
    const deny = (receipt, label) => {
      refuses(() => close(receipt), "E_REVIEW_RECEIPT", label);
      assert.equal(d.ledger.fold(wo).state, "VERIFIED", `${label}: still VERIFIED`);
      assert.equal(d.seq(wo), 4, `${label}: no event`);
    };
    const elsewhere = join(w.fx.dir, "elsewhere");
    deny(w.receipt("wo-1-lane-review", F, { parent: elsewhere }), "a correctly named ACCEPT receipt outside review/out");
    const evil = join(w.reviewOut, "..", "out-evil");
    w.receipt("wo-1-lane-review", F, { parent: evil });
    deny(join(w.reviewOut, "..", "out-evil", `wo-1-lane-review-${F.slice(0, 12)}`), "a path that leaves review/out through ..");
    const outside = w.receipt("wo-1-pkg-review", F, { parent: elsewhere });
    const junction = join(w.reviewOut, `wo-1-pkg-review-${F.slice(0, 12)}`);
    symlinkSync(outside, junction, "junction");
    deny(junction, "a junction inside review/out whose realpath is outside");

    const good = w.receipt("wo-1-lane-review-r2", F);
    const reposPath = join(d.root, "repos.json");
    const repos = readFileSync(reposPath, "utf8");
    writeFileSync(reposPath, `${JSON.stringify({ "kauro-platform": w.fx.work })}\n`);
    deny(good, "repos.json names no kauroRoot");
    writeFileSync(reposPath, repos);
    assert.equal(close(good).event.to, "CLOSED", "positive control: a receipt under <kauroRoot>/tools/review/out closes");
  } finally {
    w.cleanup();
  }
});

/** ADV-13 preload: injects a fault into the CLI child process at an exact point after the event link (node:module syncBuiltinESMExports). */
const PRELOAD = String.raw`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const mode = process.env.ADV13_MODE;
const EVENT = /[\\/]wo[\\/]WO-\d+[\\/]\d{4}\.json$/;
const EVENT_DIR = /[\\/]wo[\\/]WO-\d+$/;
const RUN = /[\\/]runs[\\/][^\\/]+$/;
const { openSync, fsyncSync, closeSync, mkdirSync } = fs;
const marked = new Set();
if (mode === "durability") {
  fs.openSync = function (p, flags, ...rest) {
    const fd = openSync.call(fs, p, flags, ...rest);
    if ((flags === "r+" && EVENT.test(String(p))) || (flags === "r" && EVENT_DIR.test(String(p)))) marked.add(fd);
    return fd;
  };
  fs.fsyncSync = function (fd) {
    if (marked.has(fd)) throw Object.assign(new Error("EIO: i/o error, fsync (injected after the event link)"), { code: "EIO" });
    return fsyncSync.call(fs, fd);
  };
  fs.closeSync = function (fd) {
    marked.delete(fd);
    return closeSync.call(fs, fd);
  };
}
if (mode === "unexpected") {
  fs.mkdirSync = function (p, ...rest) {
    if (RUN.test(String(p))) throw new Error("injected: the anchor run directory cannot be created");
    return mkdirSync.call(fs, p, ...rest);
  };
}
syncBuiltinESMExports();
`;

test("ADV-13: the CLI exits 2 when the outcome is unknown (E_IO after the event link, an unexpected error after the commit, E_GIT), never 1", () => {
  const w = world();
  const preloadDir = mkdtempSync(join(tmpdir(), "audit-wo-preload-"));
  try {
    const preload = join(preloadDir, "fault.mjs");
    writeFileSync(preload, PRELOAD);
    for (const mode of ["durability", "unexpected"]) {
      const d = desk(w);
      const wo = d.imp(1);
      const args = ["--import", pathToFileURL(preload).href, CLI, "void", wo, "--root", d.root, "--actor", COORD.id, "--role", COORD.role, "--rev", "1", "--fields", JSON.stringify({ r2: R2_VOID })];
      const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ADV13_MODE: mode } });
      assert.equal(existsSync(d.eventPath(wo, 2)), true, `${mode}: the fault hit after the event was linked (the effect happened): ${r.stderr}`);
      assert.equal(JSON.parse(readFileSync(d.eventPath(wo, 2), "utf8")).to, "VOIDED", `${mode}: the committed event is the VOID`);
      if (mode === "durability") assert.match(r.stderr, /E_IO/, "the durability failure surfaces as E_IO");
      assert.equal(r.status, 2, `${mode}: the CLI exits 2 (outcome unknown), got ${r.status}: ${r.stderr.trim()}`);
    }
    const d = desk(w);
    writeFileSync(join(d.root, "repos.json"), `${JSON.stringify({ "kauro-platform": join(d.root, "no-such-worktree"), kauroRoot: w.kauroRoot })}\n`);
    const g = cli(["import", JSON.stringify(w.finding(1)), "--root", d.root, "--actor", AUDITOR.id, "--role", AUDITOR.role]);
    assert.match(g.stderr, /^E_GIT/, "git could not run in the worktree");
    assert.equal(g.status, 2, `E_GIT exits 2, got ${g.status}`);
    assert.equal(existsSync(join(d.root, "wo")), false, "nothing imported");
  } finally {
    rmSync(preloadDir, { recursive: true, force: true });
    w.cleanup();
  }
});
