// The B04 case map, read from docs/design/B04-case-map.md against docs/design/B04-mandates.md and docs/design/B03-case-map.md
// (same rules as the B03 checker, tools/test/b03-case-map.test.mjs: every claim names its evidence class, and a row can never name a
// test that does not run). A cited test file of this repository must exist and declare a test with exactly the cited title — a
// template title matches its expansion, its fixed text compared character for character and each placeholder standing for a string
// literal the file or its support modules declare. Every case has its rows, every row names a mandate of B04-mandates.md that owns
// the cited file and the case, the cases are the 11 of B04 and exactly the 8 B03 cases that name B04, the mandates are twelve with
// ordered dependencies and tests first, and the case map states no row as planned once the offline mandates are closed.
//
//   node --test tools/test/b04-case-map.test.mjs          (npm run design:check runs this and the B03 checker)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { titlesIn } from '../lib/test-titles.mjs';

const root = join(import.meta.dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const caseMap = read('docs', 'design', 'B04-case-map.md');
const mandatesDoc = read('docs', 'design', 'B04-mandates.md');
const b03Map = read('docs', 'design', 'B03-case-map.md');

/** The eleven cases of package B04 (gate G-IC-QUALITY) and the eight B03 cases left PARTIAL that name B04, in the case map's order. */
const B04_CASES = ['IC-10', 'IC-11', 'IC-13', 'S042', 'S043', 'S044', 'S091', 'R2-039', 'R2-040', 'R2-041', 'R2-042'];
const B03_NAMED = ['IC-05', 'S036', 'S037', 'S038', 'S040', 'R2-027', 'R2-028', 'R2-032'];
const MANDATE_KEYS = ['B04-POLICY', 'B04-WIRE', 'B04-CORPUS', 'B04-TRANSPORT', 'B04-RECEIPTS', 'B04-FIXTURES-SUPPORTED', 'B04-FIXTURES-BOUNDARY', 'B04-FIXTURES-HARD', 'B04-SCORER', 'B04-QUALIFY', 'B04-CAMPAIGN', 'B04-RELEASE-PREP'];
const STARTS = ['ic/b04-design', 'ic/b04-stage-1', 'ic/b04-stage-2'];

// ------------------------------------------------------------------------------------------------------------- the mandates

/** The mandates of B04-mandates.md: key, heading, the text of the section (its bullets), and what its `from:` and `depends:` name. */
function mandates() {
  const out = [];
  let current = null;
  for (const line of mandatesDoc.split(/\r?\n/)) {
    const heading = /^### (B04-[A-Z]+(?:-[A-Z]+)*) — (\S.*)$/.exec(line);
    if (heading !== null) {
      current = { key: heading[1], title: heading[2], text: '' };
      out.push(current);
      continue;
    }
    if (line.startsWith('## ')) current = null;
    if (current !== null) current.text += `${line}\n`;
  }
  for (const m of out) {
    m.from = /^- from: `([^`]+)`/m.exec(m.text)?.[1] ?? null;
    m.depends = [...(/ depends: ([^·\n]*?)(?: \(|\s+·|$)/m.exec(m.text)?.[1] ?? '').matchAll(/B04-[A-Z]+(?:-[A-Z]+)*/g)].map((x) => x[0]);
    m.files = [...new Set([...m.text.matchAll(/`((?:test|tools\/test)\/[a-z0-9-]+\.test\.(?:ts|mjs))`/g)].map((x) => x[1]))];
  }
  return out;
}
const MANDATES = mandates();

// ------------------------------------------------------------------------------------------------------------- the case map

/** A row of a case table: its case, and the mandate, file and title its last cell cites. */
const TABLE_ROW = /^\| (\S+) \| .* \| (B04-[A-Z]+(?:-[A-Z]+)*) · `([^`]+)` :: `([^`]+)`/;
const LINES = caseMap.split(/\r?\n/);
const SECTIONS = (() => {
  const out = [];
  let name = null;
  for (const line of LINES) {
    if (line.startsWith('## ')) name = line.slice(3).trim();
    const row = TABLE_ROW.exec(line);
    if (row !== null) out.push({ section: name, caseId: row[1], mandate: row[2], file: row[3], title: row[4], line });
    else if (/^\| [A-Z][A-Z0-9-]+ \| /.test(line) && !/^\| case \|/.test(line)) out.push({ section: name, caseId: line.split('|')[1].trim(), mandate: null, file: null, title: null, line });
  }
  return out;
})();
const CASE_ROWS = SECTIONS.filter((row) => row.section === 'B04 cases' || row.section === 'B03 cases that name B04');
const SUPPORTING = LINES.filter((line) => line.startsWith('- `'));

test('B04 case map: the eleven cases of B04 and the eight B03 cases that name it each have rows, every row follows the grammar, and no row is left as planned', () => {
  assert.deepEqual([...new Set(CASE_ROWS.filter((row) => row.section === 'B04 cases').map((row) => row.caseId))], B04_CASES, 'the B04 cases, in order');
  assert.deepEqual([...new Set(CASE_ROWS.filter((row) => row.section === 'B03 cases that name B04').map((row) => row.caseId))], B03_NAMED, 'the B03 cases that name B04, in order');
  for (const row of CASE_ROWS) {
    assert.notEqual(row.mandate, null, `${row.caseId}: a row names its mandate, file and title: ${row.line.slice(0, 100)}`);
    assert.ok(MANDATE_KEYS.includes(row.mandate), `${row.caseId}: ${row.mandate} is a mandate of B04`);
  }
  assert.ok(!/\bPLANNED\b/.test(caseMap.split('\n').filter((line) => !line.startsWith('- `')).join('\n')), 'no case row is PLANNED: the offline mandates are closed');
  const totals = /all (\d+) cases PARTIAL/.exec(caseMap);
  assert.ok(totals !== null, 'the case map states the status of its cases');
  assert.equal(Number(totals[1]), new Set(CASE_ROWS.map((row) => row.caseId)).size, 'the stated total is the distinct cases the rows cover');
  assert.equal(Number(totals[1]), B04_CASES.length + B03_NAMED.length);
});

test('B04 case map: every cited test of an existing file is a test of that file under exactly that title, for the case rows and the supporting tests alike', () => {
  const missing = [];
  const cite = (file, title, where) => {
    assert.match(file, /^test\/[a-z0-9-]+\.test\.ts$/, `${where}: a row cites a test file under test/: ${file}`);
    assert.ok(existsSync(join(root, file)), `${where}: ${file} exists`);
    if (title !== null && !titlesIn(join(root, file)).some((declared) => declared.matches(title))) missing.push(`${file} :: ${title}`);
  };
  for (const row of CASE_ROWS) cite(row.file, row.title, row.caseId);
  let supporting = 0;
  for (const line of SUPPORTING) {
    const row = /^- `([^`]+)` :: (?:`([^`]+)`)?/.exec(line);
    assert.ok(row !== null, `a supporting test names its file: ${line.slice(0, 80)}`);
    // A supporting row that describes a group of tests in prose (no backticked title after the ::) cites its file only.
    cite(row[1], row[2] ?? null, 'supporting');
    supporting += 1;
  }
  assert.ok(supporting >= 8, `${String(supporting)} supporting tests`);
  assert.deepEqual(missing, [], 'cited tests that do not exist under that exact title');
});

test('B04 case map: a row names the mandate that owns its file and its case, and every case a mandate owns has a row naming it', () => {
  for (const row of CASE_ROWS) {
    const mandate = MANDATES.find((m) => m.key === row.mandate);
    assert.ok(mandate !== undefined, `${row.caseId}: ${row.mandate} is in B04-mandates.md`);
    assert.ok(mandate.files.includes(row.file) || mandate.text.includes(row.file), `${row.caseId}: ${row.mandate} owns ${row.file}`);
    // The mandate lists the cases it owns in its tests line (S091, R2-041); the clause by file title stands for the fixtures mandates.
    assert.ok(mandate.text.includes(row.caseId) || /^B04-FIXTURES/.test(mandate.key) || mandate.text.includes(row.title.slice(0, 40)), `${row.caseId}: ${row.mandate} names the case`);
  }
  for (const m of MANDATES.filter((x) => !/^B04-(?:FIXTURES|RELEASE)/.test(x.key))) {
    const named = new Set(CASE_ROWS.filter((row) => row.mandate === m.key).map((row) => row.caseId));
    for (const id of [...B04_CASES, ...B03_NAMED]) if (new RegExp(`\\b${id.replace(/[-]/g, '\\-')}\\b`).test(/tests:[\s\S]*$/m.exec(m.text)?.[0].split('\n').slice(0, 6).join(' ') ?? '')) assert.ok(named.has(id), `${m.key} lists ${id} in its tests and a row names it`);
  }
});

test('B04 case map: the eight B03 cases it names are exactly the B03 sections left PARTIAL that name B04, and each stays PARTIAL there', () => {
  const partial = [];
  let id = null;
  for (const line of b03Map.split(/\r?\n/)) {
    const heading = /^### (\S+) — /.exec(line);
    if (heading !== null) id = heading[1];
    const status = /^Status: PARTIAL — (\S.*)$/.exec(line);
    if (status !== null && id !== null && /\bB04\b/.test(status[1])) partial.push(id);
  }
  assert.deepEqual([...partial].sort(), [...B03_NAMED].sort(), 'B03 hands exactly these cases to B04');
  for (const row of CASE_ROWS.filter((r) => r.section === 'B03 cases that name B04')) assert.match(row.line, /PARTIAL \(B04/, `${row.caseId}: the B04 map says what the B03 map says`);
});

// --------------------------------------------------------------------------------------------------------------- the mandates

test('B04 mandates: twelve, unique, each from a stage branch, with test files that exist, tests first, dependencies ordered by the stage plan, and the release prep owning this checker', () => {
  assert.deepEqual(MANDATES.map((m) => m.key), MANDATE_KEYS, 'the twelve mandates, in order');
  assert.ok(/Tests first: the first commit holds the test file/.test(mandatesDoc), 'every mandate writes its tests first');
  const plan = /```\n(stage 1:[\s\S]*?)\n```/.exec(mandatesDoc)?.[1] ?? '';
  const order = [...plan.matchAll(/B04-[A-Z]+(?:-[A-Z]+)*/g)].map((x) => x[0]);
  for (const key of MANDATE_KEYS) assert.equal(order.filter((x) => x === key).length, 1, `${key} stands once in the stage plan`);
  const stageOf = new Map();
  let stage = 0;
  for (const line of plan.split('\n')) {
    const head = /^stage (\d):/.exec(line);
    if (head !== null) stage = Number(head[1]);
    if (/^(?:stage \d:|\s+∥)/.test(line)) for (const key of line.match(/B04-[A-Z]+(?:-[A-Z]+)*/g) ?? []) stageOf.set(key, stage);
  }
  for (const m of MANDATES) {
    assert.ok(m.from !== null && STARTS.includes(m.from), `${m.key}: starts from a stage branch (${String(m.from)})`);
    assert.ok(m.files.length > 0 || /^B04-FIXTURES/.test(m.key), `${m.key}: names the test files it writes`);
    for (const file of m.files) assert.ok(existsSync(join(root, file)), `${m.key}: ${file} exists`);
    for (const dep of m.depends) {
      assert.ok(MANDATE_KEYS.includes(dep), `${m.key}: depends on a mandate (${dep})`);
      assert.ok(order.indexOf(dep) < order.indexOf(m.key), `${m.key}: ${dep} comes earlier in the order`);
      assert.ok(stageOf.get(dep) <= stageOf.get(m.key), `${m.key}: ${dep} lands in the same or an earlier stage`);
    }
  }
  const release = MANDATES.find((m) => m.key === 'B04-RELEASE-PREP');
  assert.ok(release.files.includes('tools/test/b04-case-map.test.mjs'), 'the release prep owns this checker');
  assert.ok(existsSync(join(root, 'tools', 'test', 'b04-case-map.test.mjs')));
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts['design:check'], /tools\/test\/b03-case-map\.test\.mjs/, 'design:check runs the B03 checker');
  assert.match(scripts['design:check'], /tools\/test\/b04-case-map\.test\.mjs/, 'design:check runs the B04 checker');
});
