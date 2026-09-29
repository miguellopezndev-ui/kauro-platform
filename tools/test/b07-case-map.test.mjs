// The B07 case map's citations, read from the committed docs/design/B07-case-map.md (21 "Evidence classes": "Every claim names
// its class"; the design reviser's rule: every case id of `node tools/package-brief.mjs B07` mapped to file :: exact test title).
// A cited test file that exists must contain a test with exactly the cited title — so an EXECUTED_LOCAL row can never name a test
// that does not run — and a cited file that does not exist yet must be one the implementation mandates create (design §15), cited
// only in a SPECIFIED line. Every case of the package has its section.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const CASE_MAP = join(root, "docs", "design", "B07-case-map.md");
const text = readFileSync(CASE_MAP, "utf8");

const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};

/** The files the B07 implementation mandates create (design §15); cited before they exist, and only as SPECIFIED. */
const PLANNED = new Set([
  "packages/data-plane/test/container-inspection.test.ts",
  "packages/data-plane/test/scan-coverage.test.ts",
  "packages/data-plane/test/selection-evaluation.test.ts",
  "apps/control/test/upload-inspection.test.ts",
  "apps/control/test/storage-lifecycle.test.ts",
  "apps/control/test/retention-sweeper.test.ts",
  "apps/control/test/authority-journal.test.ts",
  "apps/api/test/cmd012-create-revision.test.ts",
  "apps/api/test/cmd013-reserve-upload.test.ts",
  "apps/api/test/cmd014-complete-upload.test.ts",
  "apps/api/test/cmd015-cancel-upload.test.ts",
  "apps/api/test/cmd016-select-input-tables.test.ts",
  "apps/api/test/cmd017-seal-revision.test.ts",
  "apps/api/test/source-reads.test.ts",
  "packages/persistence/test/source-adapters.test.ts",
  "packages/application/test/source-provider-fakes.test.ts",
]);

/** Every `file` :: "title" citation, with the line it stands on. */
function citations() {
  const out = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(/`([^`]+\.test\.(?:ts|mjs))` :: "([^"]+)"/g)) out.push({ file: m[1], title: m[2], line });
  }
  return out;
}

/** The test titles of a source file, as node:test declares them. */
function titlesOf(file) {
  return [...readFileSync(join(root, file), "utf8").matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}

test("B07 case map: every cited test of an existing file is a test of that file under exactly that title; a file that does not exist yet is a planned file of a mandate, cited only as SPECIFIED", () => {
  const cited = citations();
  assert.ok(cited.length >= 60, `${cited.length} citations`);
  const missing = [];
  for (const c of cited) {
    if (existsSync(join(root, c.file))) {
      if (!titlesOf(c.file).includes(c.title)) missing.push(`${c.file} :: "${c.title}"`);
    } else {
      assert.ok(PLANNED.has(c.file), `${c.file} neither exists nor is a planned file of a B07 mandate`);
      assert.match(c.line, /SPECIFIED/, `${c.file} is not written yet, so its citation must be SPECIFIED: ${c.title}`);
    }
  }
  assert.deepEqual(missing, [], "cited tests that do not exist under that exact title");
});

test("B07 case map: every case of the package has its section, and every EXECUTED_LOCAL citation names a file that exists", () => {
  const b07 = registry("program.json").find((p) => p.id === "B07");
  assert.equal(b07.caseIds.length, 23);
  for (const caseId of b07.caseIds) {
    const family = /^(CMD\d{3})-(OK|DENY|RACE)$/.exec(caseId);
    const present = family === null ? text.includes(`\n### ${caseId} `) : text.includes(`**${caseId}**`);
    assert.ok(present, `${caseId} has no section in the case map`);
  }
  for (const c of citations().filter((x) => /EXECUTED_LOCAL/.test(x.line))) assert.ok(existsSync(join(root, c.file)), `${c.file} is cited as EXECUTED_LOCAL but does not exist`);
});

/** The lines of a case's section: a scenario's `### <id> ` heading, or a command family's `- **<id>**` item. */
function sectionOf(caseId) {
  const lines = text.split("\n");
  const family = /^CMD\d{3}-(OK|DENY|RACE)$/.test(caseId);
  const start = lines.findIndex((l) => (family ? l.startsWith(`- **${caseId}**`) : l.startsWith(`### ${caseId} `)));
  assert.ok(start >= 0, `${caseId} has no section`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("### ") || l.startsWith("## ") || (family && l.startsWith("- **"))) break;
    out.push(l);
  }
  return out;
}

const STATUS_ROW = /^\| ([A-Z0-9-]+) \| (EXECUTED_LOCAL|PARTIAL|MISSING) \| (\d+) EXECUTED_LOCAL, (\d+) SIMULATED — [^|]+ \| ([^|]+) \| ([^|]+) \|$/;

test("B07 case map: the status table of b07/integration names every case once, with the counts of its section's EXECUTED_LOCAL and SIMULATED rows, no SPECIFIED row left once both stage-2 mandates are merged, and the status those rows imply", () => {
  const b07 = registry("program.json").find((p) => p.id === "B07");
  // b07/integration merges every mandate of design §15: a row still SPECIFIED would name a test no merged mandate wrote
  assert.deepEqual(text.split("\n").filter((l) => /^\s*- SPECIFIED \(/.test(l)), [], "no row is SPECIFIED on b07/integration");
  const start = text.indexOf("\n## Status at `b07/integration`\n");
  assert.ok(start >= 0, "the case map has its status section");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end < 0 ? undefined : end).split("\n");
  const rows = section.filter((l) => l.startsWith("| ") && !l.startsWith("| case |"));
  const byCase = new Map();
  for (const row of rows) {
    const m = STATUS_ROW.exec(row);
    assert.ok(m !== null, `a status row has the table's shape: ${row.slice(0, 80)}`);
    assert.ok(!byCase.has(m[1]), `${m[1]} has one status row`);
    byCase.set(m[1], { status: m[2], executed: Number(m[3]), simulated: Number(m[4]), stage2: m[5].trim(), later: m[6].trim() });
  }
  assert.deepEqual([...byCase.keys()].sort(), [...b07.caseIds].sort(), "the table names exactly the package's cases");
  const tally = { EXECUTED_LOCAL: 0, PARTIAL: 0, MISSING: 0 };
  for (const caseId of b07.caseIds) {
    const row = byCase.get(caseId);
    const lines = sectionOf(caseId);
    const executed = lines.filter((l) => /^\s*- EXECUTED_LOCAL\b/.test(l)).length;
    const simulated = lines.filter((l) => /^\s*- SIMULATED\b/.test(l)).length;
    const specified = new Set(lines.flatMap((l) => [...l.matchAll(/^\s*- SPECIFIED \((B07-[A-Z-]+)/g)].map((x) => x[1])));
    assert.deepEqual([row.executed, row.simulated], [executed, simulated], `${caseId}: the counts are its section's rows`);
    const named = new Set([...row.stage2.matchAll(/B07-[A-Z]+(?:-[A-Z]+)*/g)].map((x) => x[0]));
    assert.deepEqual([...named].sort(), [...specified].sort(), `${caseId}: the stage-2 column names exactly the mandates of its SPECIFIED rows`);
    if (specified.size === 0) assert.equal(row.stage2, "none", `${caseId}: nothing is open in stage 2`);
    const laterOpen = !row.later.startsWith("none");
    if (laterOpen) assert.match(row.later, /\bB\d{2}\b/, `${caseId}: an open later clause names its package`);
    const expected = executed === 0 ? "MISSING" : specified.size > 0 || laterOpen ? "PARTIAL" : "EXECUTED_LOCAL";
    assert.equal(row.status, expected, `${caseId}: the status its rows imply`);
    tally[row.status] += 1;
  }
  const totals = /Totals: (\d+) cases — (\d+) EXECUTED_LOCAL, (\d+) PARTIAL, (\d+) MISSING\./.exec(section.join("\n"));
  assert.ok(totals !== null, "the section states its totals");
  assert.deepEqual(totals.slice(1).map(Number), [b07.caseIds.length, tally.EXECUTED_LOCAL, tally.PARTIAL, tally.MISSING]);
});
