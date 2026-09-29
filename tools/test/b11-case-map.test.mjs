// The bookkeeping of docs/design/B11-case-map.md and docs/design/B11-mandates.json against the vendored registry and the sources
// of this branch: one row per B11 case with its registry expectation; a cited test that exists exists under exactly its title; a
// cited test that does not exist yet is created by a mandate the row's status names; every DENY and RACE row of CMD044 states its
// registry scenario; every PARTIAL target names the later package that owns what remains; the mandates are complete, staged and
// own each contract fake exactly once.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const CASE_MAP = join(root, "docs", "design", "B11-case-map.md");
const MANDATES = JSON.parse(readFileSync(join(root, "docs", "design", "B11-mandates.json"), "utf8"));
const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};

/**
 * The cited tests of a cell: `file` :: "title" pairs, a file carried to the titles that follow it. Unlike B06's reader this one
 * also reads Playwright specs (`*.spec.ts`), the browser tests of B11.
 */
function citationsOf(cell) {
  const out = [];
  let file = null;
  for (const m of cell.matchAll(/`([^`]+\.(?:test|spec)\.(?:ts|mjs))`|::\s*"((?:[^"\\]|\\.)*)"/g)) {
    if (m[1] !== undefined) file = m[1];
    else {
      assert.ok(file !== null, `a title is cited before any test file: ${m[2].slice(0, 80)}`);
      out.push({ file, title: JSON.parse(`"${m[2]}"`) });
    }
  }
  return out;
}

/** The cells of a markdown table row (backticked text may contain a pipe). */
function cellsOf(line) {
  const cells = [];
  let current = "";
  let code = false;
  for (const c of line) {
    if (c === "`") code = !code;
    if (c === "|" && !code) {
      cells.push(current.trim());
      current = "";
    } else current += c;
  }
  cells.push(current.trim());
  return cells.slice(1, -1);
}

function rows() {
  const out = [];
  for (const line of readFileSync(CASE_MAP, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("| ")) continue;
    const cells = cellsOf(line);
    if (cells.length !== 6 || !/^(S\d{3}|R2-\d{3}|CMD\d{3}-(OK|DENY|RACE))$/.test(cells[0])) continue;
    const citations = citationsOf(cells[2]);
    out.push({ caseId: cells[0], expected: cells[1], citations, status: cells[3], target: cells[4], remaining: cells[5] });
  }
  return out;
}

const b11 = registry("program.json").find((p) => p.id === "B11");
const cases = [...registry("cases.json"), ...registry("additional_scenarios.json")];
const mandateByKey = new Map(MANDATES.mandates.map((m) => [m.key, m]));

test("B11 case map: exactly one row per B11 case with its registry expectation, and every row cites a test", () => {
  const map = rows();
  assert.deepEqual(map.map((r) => r.caseId).sort(), [...b11.caseIds].sort());
  for (const row of map) {
    const registered = cases.find((c) => c.id === row.caseId);
    assert.equal(row.expected, registered.expected, `${row.caseId}: the registry expectation, verbatim`);
    assert.ok(row.citations.length > 0, `${row.caseId}: cites a test`);
  }
});

test("B11 case map: a cited test on the branch exists under exactly its title; any other is created by a mandate its status names, and a row with a planned test is MISSING or PARTIAL, never EXECUTED_LOCAL", () => {
  for (const row of rows()) {
    const planned = [...row.status.matchAll(/PLANNED \(([^)]+)\)/g)].flatMap((m) => m[1].split(", "));
    for (const { file, title } of row.citations) {
      const path = join(root, file);
      if (existsSync(path)) {
        assert.ok(readFileSync(path, "utf8").includes(`test(${JSON.stringify(title)}`), `${row.caseId}: ${file} has no test titled ${title.slice(0, 90)}`);
      } else {
        const owners = MANDATES.mandates.filter((m) => m.creates_tests.includes(file)).map((m) => m.key);
        assert.equal(owners.length, 1, `${row.caseId}: ${file} is created by exactly one mandate (found ${owners.join(", ") || "none"})`);
        assert.ok(planned.includes(owners[0]), `${row.caseId}: the status names ${owners[0]}, which creates ${file}`);
        assert.match(row.status, /^\*\*(MISSING|PARTIAL)\*\*/, `${row.caseId}: a planned test leaves the case MISSING or PARTIAL`);
      }
    }
    for (const key of planned) {
      assert.ok(mandateByKey.has(key), `${row.caseId}: PLANNED names the unknown mandate ${key}`);
      assert.ok(mandateByKey.get(key).cases.includes(row.caseId), `${row.caseId}: mandate ${key} does not list the case`);
    }
  }
});

test("B11 case map: every DENY row names a foreign tenant, a wrong role and one missing prerequisite; every RACE row the identical retry, IDEMPOTENCY_CONFLICT and a crash at the intent/commit boundary; the CMD044 verification clause is answered", () => {
  const map = rows();
  for (const row of map.filter((r) => r.caseId.endsWith("-DENY"))) {
    assert.ok(row.citations.some((c) => /foreign tenant/.test(c.title) && /wrong role/.test(c.title) && /one missing prerequisite/.test(c.title)), row.caseId);
  }
  for (const row of map.filter((r) => r.caseId.endsWith("-RACE"))) {
    assert.ok(row.citations.some((c) => /identical retry/.test(c.title) && /IDEMPOTENCY_CONFLICT/.test(c.title) && /crash/.test(c.title)), row.caseId);
  }
  const text = readFileSync(CASE_MAP, "utf8");
  // the additional-scenario records of R2-062..R2-134 carry no verification member; cases.json's records of the same ids do
  const clauses = new Set(cases.filter((c) => b11.caseIds.includes(c.id) && typeof c.verification === "string").map((c) => c.verification));
  assert.equal(clauses.size, 2, "the two verification clauses of B11's cases");
  for (const clause of clauses) {
    assert.ok(text.includes(`"${clause}"`), `the verification clause is quoted and answered: ${clause}`);
  }
});

test("B11 case map: every target is EXECUTED_LOCAL or PARTIAL; a PARTIAL target names the later package that owns what remains; the stated counts are the rows' own", () => {
  const map = rows();
  for (const row of map) {
    assert.match(row.target, /^(EXECUTED_LOCAL|PARTIAL — .+)$/, `${row.caseId}: target`);
    if (row.target.startsWith("PARTIAL")) assert.match(row.remaining, /\bB(0[7-9]|1\d|2[01])\b/, `${row.caseId}: the later package`);
    else assert.equal(row.remaining, "—", `${row.caseId}: nothing remains`);
  }
  const executed = map.filter((r) => r.target === "EXECUTED_LOCAL").length;
  const missing = map.filter((r) => r.status.startsWith("**MISSING**")).length;
  const text = readFileSync(CASE_MAP, "utf8");
  assert.ok(text.includes(`Counts at design: ${map.length} cases — 0 EXECUTED_LOCAL, 0 SIMULATED, 0 PARTIAL, ${missing} MISSING (all planned).`));
  assert.ok(text.includes(`Target at B11 closure: ${executed}\nEXECUTED_LOCAL`) || text.includes(`Target at B11 closure: ${executed} EXECUTED_LOCAL`));
  assert.ok(text.includes(`${map.length - executed} PARTIAL`));
});

test("B11 mandates: every mandate has its fields, a known stage start and known dependencies; each contract fake has one owner; every case is carried by a mandate", () => {
  const keys = MANDATES.mandates.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "unique keys");
  const fakes = new Map();
  for (const m of MANDATES.mandates) {
    for (const field of ["key", "stage", "starts_from", "depends_on", "owns_fakes", "cases", "creates_tests", "task"]) assert.ok(field in m, `${m.key}: ${field}`);
    assert.ok(m.task.length > 80, `${m.key}: a task an agent can execute`);
    if (m.stage === 1) assert.equal(m.starts_from, "b11/design", `${m.key}: stage 1 starts from the design`);
    if (m.stage === 2) assert.match(m.starts_from, /^b11\/stage-1\b/, `${m.key}: stage 2 starts from the stage-1 integration`);
    for (const dep of m.depends_on) {
      const known = keys.includes(dep) || /^(B(0[6-9]|1\d|2[01])\b|W\d|INT-\d|OWNER 2026-10-08)/.test(dep);
      assert.ok(known, `${m.key}: unknown dependency ${dep}`);
    }
    for (const fake of m.owns_fakes) {
      assert.ok(!fakes.has(fake), `${fake} has two owners (${fakes.get(fake)}, ${m.key})`);
      fakes.set(fake, m.key);
    }
    for (const caseId of m.cases) assert.ok(b11.caseIds.includes(caseId), `${m.key}: ${caseId} is not a B11 case`);
  }
  for (const caseId of b11.caseIds) assert.ok(MANDATES.mandates.some((m) => m.cases.includes(caseId)), `${caseId}: no mandate carries it`);
  const stage1 = MANDATES.mandates.filter((m) => m.stage === 1 && !m.key.startsWith("INT"));
  assert.deepEqual(mandateByKey.get("INT-1").depends_on, stage1.map((m) => m.key), "INT-1 merges every stage-1 mandate");
  const stage2 = MANDATES.mandates.filter((m) => m.stage === 2 && !m.key.startsWith("INT"));
  assert.deepEqual(mandateByKey.get("INT-2").depends_on, stage2.map((m) => m.key), "INT-2 merges every stage-2 mandate");
});
