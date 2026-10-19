import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cellsOf, fixedWaitCaps, selectChanged, touchedLines } from "../changed-cells.mjs";
import { removeTemp } from "../temp-removal.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../stress-cells.mjs");

const SOURCE = [
  'import { test } from "node:test";',                                   // 1
  'faultCell(',                                                           // 2
  '  { id: "REPL_RACE", step: "S1 intent", fault: "race", expect: "one" },', // 3
  '  async (ctx) => {',                                                   // 4
  '    await contend(ctx, a, b);',                                        // 5
  '  },',                                                                 // 6
  ');',                                                                   // 7
  'faultCell(',                                                           // 8
  '  { id: "REPL_CRB", step: "S2 settle", fault: "crash-before-commit", at: "uow", expect: "none" },', // 9
  '  async () => {},',                                                    // 10
  ');',                                                                   // 11
  'test("RACE: two keys, one allowance", async () => {',                  // 12
  '  await x();',                                                         // 13
  '});',                                                                  // 14
  'test("a plain read", async () => {',                                   // 15
  '  await bothOrders(a, b);',                                            // 16
  '});',                                                                  // 17
  'test("a pure check", () => {});',                                      // 18
].join("\n");

test("cellsOf: faultCell race/timeout/expiry, a RACE/TIMEOUT/EXPIRY title and a body driving the interleaving harness are timing cells; crash and plain cells are not", () => {
  const cells = cellsOf(SOURCE);
  assert.deepEqual(cells.map((c) => [c.from, c.to, c.timing]), [[2, 7, true], [8, 11, false], [12, 14, true], [15, 17, true], [18, 18, false]]);
  assert.equal(cells[0].pattern, "^REPL_RACE \\[race\\] S1 intent -> ");
  assert.equal(cells[2].pattern, "^RACE: two keys, one allowance$");
  assert.ok(new RegExp(cells[0].pattern).test("REPL_RACE [race] S1 intent -> one"));
  assert.ok(!new RegExp(cells[0].pattern).test("REPL_RACE [race] S1 intent, more -> one"), "the pattern selects exactly its own cell");
});

test("touchedLines and selectChanged: only timing cells with an added, changed or deleted line are selected, per test file", () => {
  const diff = [
    "diff --git a/apps/api/test/x.test.ts b/apps/api/test/x.test.ts",
    "--- a/apps/api/test/x.test.ts", "+++ b/apps/api/test/x.test.ts",
    "@@ -5 +5 @@", "-    await contend(ctx, b, a);", "+    await contend(ctx, a, b);",
    "@@ -10,0 +10 @@", "+  async () => {},",
    "@@ -17,2 +16,0 @@", "-  extra", "-  extra",
    "--- a/apps/api/src/y.ts", "+++ b/apps/api/src/y.ts", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n");
  const t = touchedLines(diff).get("apps/api/test/x.test.ts");
  assert.deepEqual([...t.touched].sort((a, b) => a - b), [5, 10, 16]);
  const sel = selectChanged(diff, () => SOURCE);
  assert.equal(sel.length, 1, "source files are never selected");
  assert.deepEqual(sel[0].cells.map((c) => c.from), [2, 15], "REPL_RACE (line 5) and the bothOrders test (deletion at 16); the crash cell (line 10) is not timing");
  assert.equal(sel[0].wholeFile, false);
});

test("fixedWaitCaps: a literal wait cap is refused, a cap derived from the harness bounds or a non-wait number passes", () => {
  const bad = ["await sleep(12_000);", "setTimeout(done, 1500);", "const waitMs = 10000;", "{ timeout: 30_000 }", "await waitForLock(conn, 2_000);", "const deadlineMs = 500;"];
  const good = ["await sleep(LOCK_WAIT_OBSERVATION_MS);", "setTimeout(done, bounds.pauseMs * 2);", "const units = 50_000;", "clock.advance(10_000);", "const waitMs = LOCK_WAIT_OBSERVATION_MS + 1_000;", "const boundary = 100;", "// await sleep(12_000)"];
  assert.deepEqual(fixedWaitCaps(new Map(bad.map((t, i) => [i + 1, t]))).map((f) => f.line), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fixedWaitCaps(new Map(good.map((t, i) => [i + 1, t]))), []);
});

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "kauro-changed-cells-"));
  const git = (...a) => assert.equal(spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, windowsHide: true }).status, 0, a.join(" "));
  const write = (rel, text) => { mkdirSync(join(dir, dirname(rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  write("package.json", JSON.stringify({ type: "module", scripts: { test: 'node --test --test-concurrency=2 "test/**/*.test.mjs"' } }));
  for (const [rel, text] of Object.entries(files.base)) write(rel, text);
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "base"); git("branch", "base");
  for (const [rel, text] of Object.entries(files.head)) write(rel, text);
  git("add", "-A"); git("commit", "-qm", "head");
  return dir;
}
const run = (dir, ...extra) => spawnSync(process.execPath, [script, "--changed", "--base", "base", "3", ...extra], { cwd: dir, encoding: "utf8", windowsHide: true });

test("stress-cells --changed: runs only the changed race cell N times, never the untouched or non-timing ones, and passes", () => {
  const cell = (id, body) => `test("${id} [race] step -> ok", () => { ${body} });\n`;
  const dir = repoWith({
    base: { "test/a.test.mjs": `import { test } from "node:test";\n${cell("A_RACE", "")}${cell("B_RACE", "throw new Error('untouched, never run')")}` },
    head: { "test/a.test.mjs": `import { test } from "node:test";\n${cell("A_RACE", "1;")}${cell("B_RACE", "throw new Error('untouched, never run')")}` },
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rep = JSON.parse(readFileSync(join(dir, "stress-cells.json"), "utf8"));
    assert.equal(rep.verdict, "PASS");
    assert.deepEqual(rep.selection.map((s) => s.cells.map((c) => c.title)), [["A_RACE [race] step -> ok"]]);
    assert.equal(rep.results.length, 3);
    assert.ok(rep.results.every((x) => x.tests === 1), "one test per run: the untouched failing cell was filtered out");
  } finally { removeTemp(dir, () => rmSync(dir, { recursive: true, force: true })); }
});

test("stress-cells --changed: a changed cell that fails one run in three FAILS; a fixed wait cap FAILS before any run; no timing change PASSES", () => {
  const flaky = `import { test } from "node:test"; import { readFileSync, writeFileSync, existsSync } from "node:fs";\ntest("F_RACE [race] flaky -> ok", () => { const n = existsSync("n") ? Number(readFileSync("n", "utf8")) + 1 : 1; writeFileSync("n", String(n)); if (n % 3 === 0) throw new Error("third run"); });\n`;
  const d1 = repoWith({ base: { "test/f.test.mjs": "" }, head: { "test/f.test.mjs": flaky } });
  const d2 = repoWith({ base: { "test/c.test.mjs": "" }, head: { "test/c.test.mjs": `import { test } from "node:test";\ntest("C_RACE [race] c -> ok", async () => { await new Promise((r) => setTimeout(r, 1500)); });\n` } });
  const d3 = repoWith({ base: { "test/p.test.mjs": "" }, head: { "test/p.test.mjs": `import { test } from "node:test";\ntest("a pure check", () => {});\n` } });
  try {
    const r1 = run(d1);
    assert.equal(r1.status, 1);
    const rep1 = JSON.parse(readFileSync(join(d1, "stress-cells.json"), "utf8"));
    assert.deepEqual(rep1.results.map((x) => x.passed), [true, true, false]);
    const r2 = run(d2);
    assert.equal(r2.status, 1);
    const rep2 = JSON.parse(readFileSync(join(d2, "stress-cells.json"), "utf8"));
    assert.equal(rep2.results.length, 0, "nothing ran");
    assert.match(rep2.fixedCaps[0].text, /setTimeout\(r, 1500\)/);
    const r3 = run(d3);
    assert.equal(r3.status, 0, r3.stdout + r3.stderr);
    assert.match(r3.stdout, /no race\/timeout\/expiry cell changed/);
  } finally { for (const d of [d1, d2, d3]) rmSync(d, { recursive: true, force: true }); }
});

test("stress-cells --changed --cpu-load is Linux only", { skip: process.platform === "linux" && "the Linux path is exercised by the gate itself" }, () => {
  const r = spawnSync(process.execPath, [script, "--changed", "--cpu-load"], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Linux only/);
});
