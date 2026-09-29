// The B08 case map's citations, read from the committed docs/design/B08-case-map.md against docs/design/B08-mandates.json and the
// vendored registry (21 "Evidence classes": "Every claim names its class"; amendment A4: a package is accepted when its case map
// gives every registry case its evidence class and test). A cited test file that exists must contain a test with exactly the cited
// title — so a row can never name a test that does not run — and a cited file that does not exist yet must be a test file of
// exactly one implementation mandate, cited on a PLANNED row that names that mandate. Every mandate's test file is cited, every
// mandate writes its tests first, a fake has one owner, and the status table follows from the rows.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const text = readFileSync(join(root, "docs", "design", "B08-case-map.md"), "utf8");
const mandates = JSON.parse(readFileSync(join(root, "docs", "design", "B08-mandates.json"), "utf8")).mandates;

const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};
const b08 = registry("program.json").find((p) => p.id === "B08");
const REGISTRY_CASES = new Set([...registry("cases.json"), ...registry("additional_scenarios.json")].map((c) => c.id));

/** A row of a case section: `- [PLANNED ]<class> (<mandate or origin>[; ...]) `file` :: "title"`. */
const ROW = /^\s*- (PLANNED )?(EXECUTED_LOCAL|SIMULATED) \(([^)]*)\)/;
const CITATION = /`([^`]+\.test\.(?:ts|mjs))` :: "([^"]+)"/g;

/** Every `file` :: "title" citation, with the line it stands on. */
function citations() {
  const out = [];
  for (const line of text.split("\n")) {
    for (const m of line.matchAll(CITATION)) out.push({ file: m[1], title: m[2], line });
  }
  return out;
}

/** The test titles of a source file, as node:test declares them. */
function titlesOf(file) {
  return [...readFileSync(join(root, file), "utf8").matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}

/** The mandates whose `tests` list a file. */
const ownersOf = (file) => mandates.filter((m) => m.tests.includes(file)).map((m) => m.key);

test("B08 case map: every cited test of an existing file is a test of that file under exactly that title; a file that does not exist yet is a test file of exactly one mandate, cited on a PLANNED row naming that mandate", () => {
  const cited = citations();
  assert.ok(cited.length >= 45, `${cited.length} citations`);
  const missing = [];
  for (const c of cited) {
    const row = ROW.exec(c.line);
    assert.ok(row !== null, `a citation stands on a classified row: ${c.line.slice(0, 100)}`);
    if (existsSync(join(root, c.file))) {
      if (!titlesOf(c.file).includes(c.title)) missing.push(`${c.file} :: "${c.title}"`);
      continue;
    }
    assert.equal(row[1], "PLANNED ", `${c.file} does not exist yet, so its row must be PLANNED: ${c.title}`);
    const mandate = /^(B08-[A-Z]+(?:-[A-Z]+)*)(?:;|$)/.exec(row[3].trim());
    assert.ok(mandate !== null, `a PLANNED row names its mandate first: ${row[3]}`);
    assert.deepEqual(ownersOf(c.file), [mandate[1]], `${c.file} is a test file of exactly the mandate its row names`);
  }
  assert.deepEqual(missing, [], "cited tests that do not exist under that exact title");
});

test("B08 mandates: every mandate's test file is cited, each test file and each migration has one mandate, every mandate names its tests first, a fake has one owner and dependencies run in earlier or equal stages", () => {
  const keys = mandates.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "mandate keys are unique");
  const citedFiles = new Set(citations().map((c) => c.file));
  const fakes = [];
  const migrations = [];
  for (const m of mandates) {
    assert.match(m.key, /^B08-[A-Z]+(?:-[A-Z]+)*$/);
    assert.ok(typeof m.starts_from === "string" && m.starts_from.length > 0, `${m.key}: starts_from`);
    assert.ok(Number.isInteger(m.stage) && m.stage >= 1, `${m.key}: stage`);
    assert.ok(m.tests.length > 0, `${m.key}: writes tests`);
    assert.match(m.task, /^Tests first: /, `${m.key}: the task starts with its tests`);
    for (const file of m.tests) {
      assert.ok(citedFiles.has(file), `${m.key}: ${file} is cited in the case map`);
      assert.ok(m.task.includes(file), `${m.key}: its task names ${file}`);
      assert.deepEqual(ownersOf(file), [m.key], `${file} belongs to one mandate`);
    }
    for (const dep of m.depends_on) {
      const d = mandates.find((x) => x.key === dep);
      assert.ok(d !== undefined, `${m.key}: depends on a mandate (${dep})`);
      assert.ok(d.stage <= m.stage, `${m.key}: ${dep} runs no later`);
    }
    for (const f of m.owns_fakes) {
      assert.match(f, /^ContractFake[A-Z][A-Za-z]+$/, `${m.key}: a labelled fake`);
      fakes.push(f);
    }
    migrations.push(...m.migrations);
  }
  assert.equal(new Set(fakes).size, fakes.length, "one owner per fake");
  assert.equal(new Set(migrations).size, migrations.length, "one mandate per migration");
  const numbers = migrations.map((f) => Number(/^(\d{4})_[a-z0-9_]+\.sql$/.exec(f)?.[1])).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => 19 + i), "the B08 migrations are 0019 upward without a gap");
});

/** The lines of a case's section: a scenario's `### <id> ` heading, or a command family's `- **<id>**` item. */
function sectionOf(caseId) {
  const lines = text.split("\n");
  const family = /^CMD\d{3}-(OK|DENY|RACE)$/.test(caseId);
  const start = lines.findIndex((l) => (family ? l.startsWith(`- **${caseId}**`) : l.startsWith(`### ${caseId} `)));
  assert.ok(start >= 0, `${caseId} has its section`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("### ") || l.startsWith("## ") || (family && l.startsWith("- **"))) break;
    out.push(l);
  }
  return out;
}

const STATUS_ROW = /^\| ([A-Z0-9-]+) \| (EXECUTED_LOCAL|PARTIAL) \| (\d+) EXECUTED_LOCAL, (\d+) SIMULATED — [^|]+ \| ([^|]+) \|$/;
const CASE_ID = /\b(?:S\d{3}|R2-\d{3}|CMD\d{3}-(?:OK|DENY|RACE)|MC-\d{2}|IC-\d{2})\b/g;

test("B08 case map: every case of the package has its section and one status row whose counts are its section's rows, a PARTIAL case names its later package and registry case, and the totals follow", () => {
  assert.equal(b08.caseIds.length, 15);
  const start = text.indexOf("\n## Status at `b08/design`\n");
  assert.ok(start >= 0, "the case map has its status section");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end < 0 ? undefined : end).split("\n");
  const byCase = new Map();
  for (const row of section.filter((l) => l.startsWith("| ") && !l.startsWith("| case |"))) {
    const m = STATUS_ROW.exec(row);
    assert.ok(m !== null, `a status row has the table's shape: ${row.slice(0, 80)}`);
    assert.ok(!byCase.has(m[1]), `${m[1]} has one status row`);
    byCase.set(m[1], { status: m[2], executed: Number(m[3]), simulated: Number(m[4]), later: m[5].trim() });
  }
  assert.deepEqual([...byCase.keys()].sort(), [...b08.caseIds].sort(), "the table names exactly the package's cases");
  const tally = { EXECUTED_LOCAL: 0, PARTIAL: 0 };
  for (const caseId of b08.caseIds) {
    const row = byCase.get(caseId);
    const rows = sectionOf(caseId).filter((l) => ROW.test(l));
    for (const l of rows) assert.equal([...l.matchAll(CITATION)].length, 1, `${caseId}: every row cites one test`);
    const executed = rows.filter((l) => ROW.exec(l)[2] === "EXECUTED_LOCAL").length;
    const simulated = rows.filter((l) => ROW.exec(l)[2] === "SIMULATED").length;
    assert.deepEqual([row.executed, row.simulated], [executed, simulated], `${caseId}: the counts are its section's rows`);
    assert.ok(executed >= 1, `${caseId}: at least one clause is demonstrated locally`);
    const laterOpen = !row.later.startsWith("none");
    assert.equal(row.status, laterOpen ? "PARTIAL" : "EXECUTED_LOCAL", `${caseId}: the status its later column implies`);
    if (laterOpen) {
      assert.match(row.later, /\bB\d{2}\b/, `${caseId}: an open clause names its package`);
      const named = [...row.later.matchAll(CASE_ID)].map((x) => x[0]);
      assert.ok(named.length > 0 || /no registry case/.test(row.later), `${caseId}: an open clause names its registry case or says there is none`);
    }
    for (const id of [...row.later.matchAll(CASE_ID)].map((x) => x[0])) assert.ok(REGISTRY_CASES.has(id), `${caseId}: ${id} is a registry case`);
    tally[row.status] += 1;
  }
  const totals = /Totals: (\d+) cases — (\d+) EXECUTED_LOCAL, (\d+) PARTIAL\./.exec(text);
  assert.ok(totals !== null, "the status section states its totals");
  assert.deepEqual(totals.slice(1).map(Number), [b08.caseIds.length, tally.EXECUTED_LOCAL, tally.PARTIAL]);
});
