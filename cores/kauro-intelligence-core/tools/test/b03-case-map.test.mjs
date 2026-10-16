// The B03 case map, read from docs/design/B03-case-map.md against docs/design/B03-mandates.json and docs/design/B03-closure-plan.md
// (21 "Evidence classes": every claim names its class; amendment A4: a package is accepted when its case map gives every registry
// case its evidence class and test). A cited test file of this repository that exists must declare a test with exactly the cited
// title — a template title matches its expansion, its fixed text compared character for character and each placeholder standing for a
// string literal the file or its support modules declare — so a row can never name a test that does not run; a cited file that does
// not exist yet must be the test file of exactly one mandate and stand on a PLANNED row that
// names that mandate. Every case has one section and one status its rows support, the status table and totals follow from the
// sections, every mandate writes its tests first and owns what its rows say, and every finding of the review has its disposition.
//
//   node --test tools/test/b03-case-map.test.mjs          (npm run design:check)
//   KAURO_PLATFORM_ROOT=<kauro-platform checkout> also checks the titles of the PLATFORM rows whose files exist there.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { titlesIn } from '../lib/test-titles.mjs';

const root = join(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const caseMap = read('docs', 'design', 'B03-case-map.md');
const plan = read('docs', 'design', 'B03-closure-plan.md');
const design = JSON.parse(read('docs', 'design', 'B03-mandates.json'));
const mandates = design.mandates;
const platformRoot = process.env.KAURO_PLATFORM_ROOT ?? null;

/** The fifty cases of package B03, in the order of the registry brief, with their gates. */
const PRIVACY = new Set(['IC-05', 'S036', 'S037', 'R2-027', 'R2-028', 'R2-029', 'R2-030']);
const CASES = [
  'IC-01', 'IC-02', 'IC-03', 'IC-04', 'IC-05', 'IC-06', 'IC-07', 'IC-08', 'IC-09', 'IC-12',
  'S036', 'S037', 'S038', 'S039', 'S040', 'S041', 'S095',
  'CAP01', 'CAP02', 'CAP03', 'CAP04', 'CAP05', 'CAP06', 'CAP07', 'CAP08', 'CAP09', 'CAP10', 'CAP11', 'CAP12',
  'R2-027', 'R2-028', 'R2-029', 'R2-030', 'R2-031', 'R2-032', 'R2-033', 'R2-034', 'R2-035', 'R2-036', 'R2-037', 'R2-038',
  'CMD020-OK', 'CMD020-DENY', 'CMD020-RACE', 'CMD021-OK', 'CMD021-DENY', 'CMD021-RACE', 'CMD022-OK', 'CMD022-DENY', 'CMD022-RACE',
];
const gateOf = (id) => (PRIVACY.has(id) ? 'G-IC-PRIVACY' : 'G-IC-KERNEL');
const FAMILIES = ['OBJECT_MAPPING', 'FIELD_MAPPING', 'SEMANTIC_TYPE', 'TRANSFORMATION_SELECTION', 'VALUE_MAP', 'IDENTITY_STRATEGY', 'DUPLICATE_SIGNAL_STRATEGY', 'ASSOCIATION_MAPPING', 'UNMAPPED_HANDLING', 'TARGET_REQUIREMENT', 'CONSISTENCY_REVIEW', 'SEMANTIC_REPAIR'];
const FINDINGS = Array.from({ length: 12 }, (unused, index) => `B03-R${String(index + 1)}`);
const PLATFORM_PREFIX = 'kauro-platform:';

/** The numbered platform obligations of the plan's §6, which a case's status may hand a B08 clause to. */
const OBLIGATIONS = (() => {
  const start = plan.indexOf('\n## 6. ');
  const end = plan.indexOf('\n## ', start + 1);
  return [...plan.slice(start, end < 0 ? undefined : end).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
})();

// ------------------------------------------------------------------------------------------------------------- the case map

const LINES = caseMap.split(/\r?\n/);
const ROW = /^- (PLATFORM )?(PLANNED )?(EXECUTED_LOCAL|SIMULATED) \(([^)]*)\) `([^`]+)` :: `([^`]+)` — observes: (\S.*)$/;
const SECTION = /^### (\S+) — (\S.*)$/;
const STATUS = /^Status: (EXECUTED_LOCAL|SIMULATED|PARTIAL)(?: — (\S.*))?$/;

/** The sections of the Cases part: id, status, packages the status names, and rows. */
function sections() {
  const out = [];
  let current = null;
  for (const line of LINES) {
    if (line.startsWith('## ')) {
      current = null;
      continue;
    }
    const heading = SECTION.exec(line);
    if (heading !== null) {
      current = { id: heading[1], line, status: null, packages: [], rows: [], strays: [] };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    const status = STATUS.exec(line);
    if (status !== null) {
      assert.equal(current.status, null, `${current.id} has one status line`);
      current.status = status[1];
      current.packages = [...new Set([...(status[2] ?? '').matchAll(/\b(B\d{2}): /g)].map((m) => m[1]))].sort();
      current.statusTail = status[2] ?? null;
      continue;
    }
    if (line.startsWith('- ')) {
      const row = ROW.exec(line);
      if (row === null) current.strays.push(line);
      else current.rows.push({ platform: row[1] !== undefined, planned: row[2] !== undefined, klass: row[3], origin: row[4].trim(), file: row[5], title: row[6], observes: row[7], line });
    }
  }
  return out;
}

const SECTIONS = sections();
const ALL_ROWS = SECTIONS.flatMap((section) => section.rows.map((row) => ({ ...row, caseId: section.id })));
const ownersOf = (file) => mandates.filter((m) => m.tests.includes(file)).map((m) => m.key);
const mandateOf = (origin) => /^(B0\d-[A-Z]+(?:-[A-Z]+)*)(?:;|$)/.exec(origin)?.[1] ?? null;

test('B03 case map: the fifty cases of the brief each have exactly one section, in the brief order, with one status and at least one row of this repository', () => {
  assert.deepEqual(SECTIONS.map((section) => section.id), CASES, 'the sections are the fifty cases, in order');
  for (const section of SECTIONS) {
    assert.notEqual(section.status, null, `${section.id} has a status line`);
    assert.deepEqual(section.strays, [], `${section.id}: every row follows the row grammar`);
    assert.ok(section.rows.some((row) => !row.platform), `${section.id} has a row of this repository`);
  }
});

test('B03 case map: every cited test of an existing file is a test of that file under exactly that title; a file that does not exist yet is a test file of exactly one mandate, cited on a PLANNED row naming that mandate', () => {
  assert.ok(ALL_ROWS.length >= 100, `${String(ALL_ROWS.length)} rows`);
  const missing = [];
  for (const row of ALL_ROWS) {
    if (row.platform) {
      assert.ok(row.file.startsWith(PLATFORM_PREFIX), `a PLATFORM row names a ${PLATFORM_PREFIX} file: ${row.line.slice(0, 120)}`);
      assert.match(row.origin, /^B08-[A-Z]+(?:-[A-Z]+)*(?:;|$)/, `a PLATFORM row names its B08 mandate first: ${row.origin}`);
      if (platformRoot === null) continue;
      const path = join(platformRoot, row.file.slice(PLATFORM_PREFIX.length));
      if (existsSync(path)) {
        if (!titlesIn(path).some((title) => title.matches(row.title))) missing.push(`${row.file} :: ${row.title}`);
      } else assert.ok(row.planned, `${row.file} does not exist in ${platformRoot}, so its row must be PLANNED`);
      continue;
    }
    assert.ok(!row.file.startsWith(PLATFORM_PREFIX), `a row of this repository names a file of this repository: ${row.file}`);
    assert.match(row.file, /^test\/[a-z0-9-]+\.test\.ts$/, `a row cites a test file under test/: ${row.file}`);
    const path = join(root, row.file);
    if (existsSync(path)) {
      if (!titlesIn(path).some((title) => title.matches(row.title))) missing.push(`${row.file} :: ${row.title}`);
      continue;
    }
    assert.ok(row.planned, `${row.file} does not exist yet, so its row must be PLANNED: ${row.title}`);
    const mandate = mandateOf(row.origin);
    assert.ok(mandate !== null, `a PLANNED row names its mandate first: (${row.origin})`);
    assert.deepEqual(ownersOf(row.file), [mandate], `${row.file} is a test file of exactly the mandate its row names`);
  }
  assert.deepEqual(missing, [], 'cited tests that do not exist under that exact title');
});

test('B03 case map: every status is supported by its rows — EXECUTED_LOCAL by an EXECUTED_LOCAL row of this repository, PARTIAL by the later packages it names, B08 by a PLATFORM row — and the table and the totals follow from the sections', () => {
  for (const section of SECTIONS) {
    const own = section.rows.filter((row) => !row.platform);
    if (section.status === 'EXECUTED_LOCAL') {
      assert.ok(own.some((row) => row.klass === 'EXECUTED_LOCAL'), `${section.id} EXECUTED_LOCAL has an EXECUTED_LOCAL row of this repository`);
      assert.deepEqual(section.packages, [], `${section.id} EXECUTED_LOCAL names no later package`);
    } else if (section.status === 'SIMULATED') {
      assert.deepEqual(section.packages, [], `${section.id} SIMULATED names no later package`);
      assert.equal(section.statusTail, null, `${section.id} SIMULATED has nothing after its class`);
    } else {
      assert.ok(section.packages.length > 0, `${section.id} PARTIAL names the later package of each open clause`);
      for (const pkg of section.packages) assert.ok(['B04', 'B08'].includes(pkg), `${section.id} names ${pkg}, a later package B03 hands to`);
      // A B08 clause is either supported by a platform test or handed over as a numbered obligation of the plan's §6.
      if (section.packages.includes('B08')) assert.ok(section.rows.some((row) => row.platform) || /\bobligations? \d/.test(section.statusTail), `${section.id} names B08 and cites a PLATFORM row or a platform obligation`);
      for (const m of (section.statusTail ?? '').matchAll(/\bobligations? ((?:\d+(?:, )?)+)/g)) {
        for (const n of m[1].split(', ').map(Number)) assert.ok(OBLIGATIONS.includes(n), `${section.id} names obligation ${String(n)}, which the plan's §6 defines`);
      }
    }
  }
  const table = new Map();
  for (const line of LINES) {
    const row = /^\| (\S+) \| (G-IC-KERNEL|G-IC-PRIVACY) \| (EXECUTED_LOCAL|SIMULATED|PARTIAL) \| ([^|]+) \|$/.exec(line);
    if (row !== null) table.set(row[1], { gate: row[2], status: row[3], later: row[4].trim() });
  }
  assert.deepEqual([...table.keys()], CASES, 'the status table lists the fifty cases, in order');
  for (const section of SECTIONS) {
    const entry = table.get(section.id);
    assert.equal(entry.gate, gateOf(section.id), `${section.id} gate`);
    assert.equal(entry.status, section.status, `${section.id}: the table says what the section says`);
    assert.equal(entry.later, section.packages.length === 0 ? 'none' : section.packages.join(', '), `${section.id}: the later packages of the table are the status line's`);
  }
  const count = (predicate) => SECTIONS.filter(predicate).length;
  const totals = /^Totals: (\d+) EXECUTED_LOCAL, (\d+) SIMULATED, (\d+) PARTIAL \(B08 (\d+), B04 (\d+), both (\d+)\)\./m.exec(caseMap);
  assert.ok(totals !== null, 'the case map states its totals');
  assert.deepEqual(totals.slice(1).map(Number), [
    count((s) => s.status === 'EXECUTED_LOCAL'),
    count((s) => s.status === 'SIMULATED'),
    count((s) => s.status === 'PARTIAL'),
    count((s) => s.packages.includes('B08')),
    count((s) => s.packages.includes('B04')),
    count((s) => s.packages.includes('B08') && s.packages.includes('B04')),
  ], 'the totals are counted from the sections');
});

// --------------------------------------------------------------------------------------------------------------- the mandates

test('B03 mandates: unique keys, stages that order their dependencies, one owner per test file and sabotage lot, tests first, and every test file cited under the mandate that owns it', () => {
  const keys = mandates.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, 'mandate keys are unique');
  const lots = mandates.map((m) => m.sabotage_lot);
  assert.equal(new Set(lots).size, lots.length, 'one mandate per sabotage lot');
  for (const m of mandates) {
    assert.match(m.key, /^B03-[A-Z]+(?:-[A-Z]+)*$/, `${m.key}: key`);
    assert.equal(m.branch, `ic/${m.key.toLowerCase()}`, `${m.key}: its branch`);
    assert.ok(typeof m.starts_from === 'string' && m.starts_from.length > 0, `${m.key}: starts_from`);
    assert.ok(Number.isInteger(m.stage) && m.stage >= 1, `${m.key}: stage`);
    assert.match(m.size, /^\d+(?:\.\d+)? agent-days?$/, `${m.key}: size in agent-days`);
    assert.match(m.task, /^Tests first: /, `${m.key}: the task starts with its tests`);
    assert.match(m.sabotage_lot, /^tools\/sabotage-inventory\/b03-[a-z-]+\.mjs$/, `${m.key}: its own sabotage lot`);
    assert.ok(m.tests.length > 0, `${m.key}: writes tests`);
    for (const file of m.tests) {
      assert.ok(m.task.includes(file), `${m.key}: its task names ${file}`);
      assert.deepEqual(ownersOf(file), [m.key], `${file} belongs to one mandate`);
      assert.ok(ALL_ROWS.some((row) => !row.platform && row.file === file && mandateOf(row.origin) === m.key), `${m.key}: ${file} is cited on a row naming the mandate`);
    }
    for (const dep of m.depends_on) {
      const d = mandates.find((x) => x.key === dep);
      assert.ok(d !== undefined, `${m.key}: depends on a mandate (${dep})`);
      assert.ok(d.stage < m.stage, `${m.key}: ${dep} lands in an earlier stage`);
    }
  }
  for (const stage of design.stages) {
    assert.deepEqual([...stage.mandates].sort(), mandates.filter((m) => m.stage === stage.stage).map((m) => m.key).sort(), `stage ${String(stage.stage)} lists its mandates`);
    assert.deepEqual([...stage.merge_order].sort(), [...stage.mandates].sort(), `stage ${String(stage.stage)} merges every mandate once`);
    assert.ok(stage.mandates.length <= 5, `stage ${String(stage.stage)} runs at most five agents at once (A4)`);
  }
});

test('B03 mandates: the cases a mandate declares are exactly the cases whose rows name it, and every case with a PLANNED row of this repository is owned', () => {
  for (const m of mandates) {
    const named = [...new Set(ALL_ROWS.filter((row) => !row.platform && mandateOf(row.origin) === m.key).map((row) => row.caseId))].sort();
    assert.deepEqual(named, [...m.cases].sort(), `${m.key}: declared cases = the cases whose rows name it`);
  }
  for (const row of ALL_ROWS.filter((r) => r.planned && !r.platform)) assert.ok(mandates.some((m) => m.key === mandateOf(row.origin)), `${row.caseId}: a PLANNED row names a mandate of B03-mandates.json`);
});

// ---------------------------------------------------------------------------------------------------------------- the plan

test('B03 closure plan: every finding has one disposition and a mandate when the IC fixes it, every decision a mandate names is defined, and the twelve families are designed under their registry names', () => {
  const PLAN_LINES = plan.split(/\r?\n/);
  const findings = new Map();
  for (const line of PLAN_LINES) {
    const row = /^\| (B03-R\d+) \| (BLOCKING|MAJOR|MINOR) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/.exec(line);
    if (row === null) continue;
    assert.ok(!findings.has(row[1]), `${row[1]} has one row`);
    findings.set(row[1], row[3].trim());
  }
  assert.deepEqual([...findings.keys()], FINDINGS, 'the plan disposes of B03-R1..B03-R12, in order');
  for (const [id, disposition] of findings) {
    assert.match(disposition, /^(?:FIX_IN_IC(?: \+ FIX_IN_PLATFORM_B08)?|FIX_IN_PLATFORM_B08|NOT_A_DEFECT \(.+\))$/, `${id}: a disposition of the closed vocabulary`);
    if (disposition.startsWith('FIX_IN_IC')) assert.ok(mandates.some((m) => m.findings.includes(id)), `${id} is fixed in the IC and a mandate owns it`);
  }
  for (const m of mandates) for (const id of m.findings) assert.ok(findings.has(id), `${m.key}: ${id} is a finding of the plan`);
  const decisions = new Set();
  for (const line of PLAN_LINES) {
    const row = /^\| (D3-[A-Z]+-\d+) \| /.exec(line);
    if (row !== null) decisions.add(row[1]);
  }
  const families = [];
  for (const line of PLAN_LINES) {
    const heading = /^### (CAP\d{2}) ([A-Z_]+) \((D3-CAP-\d{2})\)$/.exec(line);
    if (heading === null) continue;
    families.push(heading.slice(1, 3).join(' '));
    assert.equal(heading[3], `D3-CAP-${heading[1].slice(3)}`, `${heading[1]} names its decision`);
    decisions.add(heading[3]);
  }
  assert.deepEqual(families, FAMILIES.map((name, index) => `CAP${String(index + 1).padStart(2, '0')} ${name}`), 'the twelve families, in registry order and under registry names');
  for (const m of mandates) for (const id of m.decisions) assert.ok(decisions.has(id), `${m.key}: ${id} is a decision of the plan`);
  for (const [index] of FAMILIES.entries()) {
    const id = `D3-CAP-${String(index + 1).padStart(2, '0')}`;
    assert.ok(mandates.some((m) => m.decisions.includes(id)), `${id} is implemented by a mandate`);
  }
});
