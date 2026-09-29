// The B10 design documents checked against each other and the vendored registry: docs/design/B10-case-map.md,
// docs/design/B10-mandates.json and docs/design/B10-commercial-domain.md (21 "Evidence classes": "Every claim names its class";
// amendment A4: a package is accepted when its case map gives every registry case its evidence class and test; A4 "lanes of at
// most five concurrent agents"; reference/TRANSITIONS_AND_EVENT_EFFECTS: "An unlisted edge is rejected rather than inferred").
// A cited test file that exists must contain a test with exactly the cited title, so a row can never name a test that does not
// run; a cited file that does not exist yet must be a test file of exactly one mandate, cited on a PLANNED row naming that
// mandate. Every mandate writes its tests first, owns its files, fakes and migrations alone and runs after what it needs; the
// status table follows from the rows; every DENY and RACE row states its registry scenario (D10-CASEMAP-1); every worked example
// routed to a B10 case is named by a title of that case; the design's machine edges are the registry's, its platform machines
// are closed, and every decision it cites is registered once.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");
const caseMap = read("docs", "design", "B10-case-map.md");
const design = read("docs", "design", "B10-commercial-domain.md");
const mandatesText = read("docs", "design", "B10-mandates.json");
const mandates = JSON.parse(mandatesText).mandates;

const registry = (name) => {
  const value = JSON.parse(read("packages", "contracts", "registry", name));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};
const b10 = registry("program.json").find((p) => p.id === "B10");
const CASES = new Map([...registry("cases.json"), ...registry("additional_scenarios.json")].map((c) => [c.id, c]));
const MACHINES = registry("state_transitions.json");
const CONTRACTS = registry("contracts.json");

/**
 * The named acceptance routes of reference/COMMERCIAL_LEDGER_WORKED_EXAMPLES.md ("Named acceptance routes"), equal to the
 * authority's registry/commercial_example_routes.json, which the platform does not vendor: worked example -> required case ids.
 */
const EXAMPLE_ROUTES = {
  1: ["R2-077", "R2-078", "R2-079"], 2: ["R2-080", "R2-086"], 3: ["R2-098", "R2-099"], 4: ["R2-087", "R2-088", "R2-136"],
  5: ["R2-089", "R2-096"], 6: ["R2-080", "R2-081"], 7: ["R2-104"], 8: ["R2-097"], 9: ["R2-137", "CMD030-RACE"], 10: ["R2-137"],
  11: ["R2-094", "R2-138"], 12: ["R2-095"], 13: ["R2-100"], 14: ["R2-085"], 15: ["R2-101"], 16: ["S060"], 17: ["R2-090", "R2-127"],
  18: ["R2-092", "R2-093"], 19: ["R2-082", "R2-128"], 20: ["R2-140"], 21: ["R2-102", "R2-139"], 22: ["R2-103"], 23: ["R2-105"],
  24: ["R2-141"], 25: ["R2-102", "R2-104"], 26: ["R2-120", "R2-121"],
};

/** A row of a case section: `- [PLANNED ]<class> (<mandate or origin>[; ...]) `file` :: "title"`. */
const ROW = /^\s*- (PLANNED )?(EXECUTED_LOCAL|SIMULATED) \(([^)]*)\)/;
const CITATION = /`([^`]+\.test\.(?:ts|mjs))` :: "([^"]+)"/g;
const MANDATE_KEY = /^B10-[A-Z]+(?:-[A-Z]+)*$/;

/** Every `file` :: "title" citation, with the line it stands on. */
function citations() {
  const out = [];
  for (const line of caseMap.split("\n")) {
    for (const m of line.matchAll(CITATION)) out.push({ file: m[1], title: m[2], line });
  }
  return out;
}

/** The test titles of a source file, as node:test declares them. */
function titlesOf(file) {
  return [...read(file).matchAll(/^test\(\s*"((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}

/** The mandates whose `tests` list a file. */
const ownersOf = (file) => mandates.filter((m) => m.tests.includes(file)).map((m) => m.key);

/** The lines of a case's section: a scenario's `### <id> ` heading, or a command family's `- **<id>**` item. */
function sectionOf(caseId) {
  const lines = caseMap.split("\n");
  const family = /^CMD\d{3}-(OK|DENY|RACE)$/.test(caseId);
  const start = lines.findIndex((l) => (family ? l.startsWith(`- **${caseId}**`) : l.startsWith(`### ${caseId} `)));
  assert.ok(start >= 0, `${caseId} has its section`);
  const out = [lines[start]];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("### ") || l.startsWith("## ") || (family && l.startsWith("- **"))) break;
    out.push(l);
  }
  return out;
}

const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

test("B10 case map: every cited test of an existing file is a test of that file under exactly that title; a file that does not exist yet is a test file of exactly one mandate, cited on a PLANNED row naming that mandate", () => {
  const cited = citations();
  assert.ok(cited.length >= 150, `${cited.length} citations`);
  const missing = [];
  for (const c of cited) {
    const row = ROW.exec(c.line);
    assert.ok(row !== null, `a citation stands on a classified row: ${c.line.slice(0, 100)}`);
    if (row[1] === "PLANNED ") {
      const mandate = /^(B10-[A-Z]+(?:-[A-Z]+)*)(?:;|$)/.exec(row[3].trim());
      assert.ok(mandate !== null, `a PLANNED row names its mandate first: ${row[3]}`);
      assert.deepEqual(ownersOf(c.file), [mandate[1]], `${c.file} is a test file of exactly the mandate its row names`);
    }
    if (existsSync(join(root, c.file))) {
      if (!titlesOf(c.file).includes(c.title)) missing.push(`${c.file} :: "${c.title}"`);
      continue;
    }
    assert.equal(row[1], "PLANNED ", `${c.file} does not exist yet, so its row must be PLANNED: ${c.title}`);
  }
  assert.deepEqual(missing, [], "cited tests that do not exist under that exact title");
  // one title per test: a file never declares two tests under one title
  for (const file of new Set(cited.map((c) => c.file))) {
    if (!existsSync(join(root, file))) continue;
    const titles = titlesOf(file);
    assert.equal(new Set(titles).size, titles.length, `${file}: each title once`);
  }
});

test("B10 mandates: tests first, one owner per test file, migration and fake, every test file cited, dependencies in earlier stages or the named head, at most five lanes per stage, and the design's stage table names them", () => {
  const keys = mandates.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "mandate keys are unique");
  const citedFiles = new Set(citations().map((c) => c.file));
  const fakes = [];
  const migrations = [];
  const perStage = new Map();
  for (const m of mandates) {
    assert.match(m.key, MANDATE_KEY);
    assert.ok(Number.isInteger(m.stage) && m.stage >= 1 && m.stage <= 4, `${m.key}: stage`);
    perStage.set(m.stage, [...(perStage.get(m.stage) ?? []), m.key]);
    assert.ok(typeof m.starts_from === "string" && m.starts_from.length > 0, `${m.key}: starts_from`);
    if (m.stage > 1) assert.equal(m.starts_from, `b10/stage-${m.stage - 1}`, `${m.key}: a stage-${m.stage} mandate starts from the integrator's merge of stage ${m.stage - 1}`);
    assert.ok(typeof m.estimate === "string" && /agent-day/.test(m.estimate), `${m.key}: estimate`);
    assert.ok(m.tests.length > 0, `${m.key}: writes tests`);
    assert.match(m.task, /^Tests first: /, `${m.key}: the task starts with its tests`);
    assert.match(m.task, /Done: /, `${m.key}: the task states when it is done`);
    for (const file of m.tests) {
      assert.ok(citedFiles.has(file), `${m.key}: ${file} is cited in the case map`);
      assert.ok(m.task.includes(file), `${m.key}: its task names ${file}`);
      assert.deepEqual(ownersOf(file), [m.key], `${file} belongs to one mandate`);
    }
    for (const dep of m.depends_on) {
      const d = mandates.find((x) => x.key === dep);
      assert.ok(d !== undefined, `${m.key}: depends on a mandate (${dep})`);
      assert.ok(d.stage < m.stage || (d.stage === m.stage && m.starts_from.includes(`head of ${dep}`)), `${m.key}: ${dep} runs in an earlier stage or is the head it starts from`);
    }
    for (const f of m.owns_fakes) {
      assert.match(f, /^ContractFake[A-Z][A-Za-z]+$/, `${m.key}: a labelled fake`);
      fakes.push(f);
    }
    migrations.push(...m.migrations);
    assert.doesNotMatch(m.task, /\bTO[D]O\b|\bFIX[M]E\b/, `${m.key}: no deferred-work marker`);
  }
  assert.equal(new Set(fakes).size, fakes.length, "one owner per fake");
  assert.equal(new Set(migrations).size, migrations.length, "one mandate per migration");
  for (const [stage, lanes] of perStage) assert.ok(lanes.length <= 5, `stage ${stage}: ${lanes.length} lanes, at most five (A4)`);
  // every mandate a PLANNED row names exists
  for (const c of citations()) {
    const row = ROW.exec(c.line);
    if (row?.[1] === "PLANNED ") assert.ok(keys.includes(row[3].split(";")[0].trim()), `${row[3]} is a mandate`);
  }
  // the design's stage table (section 1) names each mandate in its stage
  const stageRows = design.split("\n").map((l) => /^\| ([1-4]) \| (.+) \| ([^|]+) \|$/.exec(l)).filter((m) => m !== null);
  assert.equal(stageRows.length, 4, "the design's stage table has four stages");
  for (const [, stage, cell] of stageRows) {
    const named = [...new Set([...cell.matchAll(/B10-[A-Z]+(?:-[A-Z]+)*/g)].map((x) => x[0]))].sort();
    assert.deepEqual(named, [...(perStage.get(Number(stage)) ?? [])].sort(), `stage ${stage}: the design and the mandates name the same lanes`);
  }
  assert.match(design, new RegExp(`\\b${["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen"][mandates.length - 1]} mandates\\b`), "section 1 states the number of mandates");
});

test("B10 migrations: 0019..0024 are reservation files of B08's and B11's numbers, B10's own numbers start at 0025 without a gap, and the design's migration table is the mandates' migrations with their owners (D10-BASE-1)", () => {
  const all = mandates.flatMap((m) => m.migrations.map((file) => ({ file, owner: m.key })));
  const numbers = all.map((x) => Number(/^(\d{4})_[a-z0-9_]+\.sql$/.exec(x.file)?.[1])).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => 19 + i), "0019 upward without a gap");
  for (const { file } of all) {
    const n = Number(file.slice(0, 4));
    if (n <= 21) assert.match(file, /^00(19|20|21)_reserved_b08\.sql$/, `${file}: B08 owns 0019..0021`);
    else if (n <= 24) assert.match(file, /^00(22|23|24)_reserved_b11\.sql$/, `${file}: B11 owns 0022..0024`);
    else assert.doesNotMatch(file, /reserved/, `${file}: B10's own number`);
  }
  assert.ok(numbers.includes(25), "B10 starts at 0025");
  const listed = design.split("\n").map((l) => /^\| (\d{4}_[a-z0-9_]+\.sql) \| .* \| (B10-[A-Z]+(?:-[A-Z]+)*) \|$/.exec(l)).filter((m) => m !== null);
  assert.deepEqual(listed.map((m) => `${m[1]} ${m[2]}`).sort(), all.map((x) => `${x.file} ${x.owner}`).sort(), "the design lists every mandate migration with its owner");
  // the base holds 0001..0018 and nothing of B10 yet
  const base = read("packages", "persistence", "test", "migrations.test.ts");
  assert.match(base, /"0018_payment_service_source_reads\.sql"/, "the base ends at 0018");
});

const STATUS_ROW = /^\| ([A-Z0-9-]+) \| (EXECUTED_LOCAL|PARTIAL) \| (\d+) EXECUTED_LOCAL, (\d+) SIMULATED — [^|]+ \| ([^|]+) \|$/;
const CASE_ID = /\b(?:S\d{3}|R2-\d{3}|CMD\d{3}-(?:OK|DENY|RACE)|MC-\d{2}|IC-\d{2})\b/g;

test("B10 case map: every case of the package has its section and one status row whose counts are its section's rows; a case with a SIMULATED row or an open later clause is PARTIAL and names its package and registry case; the totals follow", () => {
  assert.equal(b10.caseIds.length, 64);
  const start = caseMap.indexOf("\n## Status at `b10/design`\n");
  assert.ok(start >= 0, "the case map has its status section");
  const end = caseMap.indexOf("\n## ", start + 1);
  const section = caseMap.slice(start, end < 0 ? undefined : end).split("\n");
  const byCase = new Map();
  for (const row of section.filter((l) => l.startsWith("| ") && !l.startsWith("| case |"))) {
    const m = STATUS_ROW.exec(row);
    assert.ok(m !== null, `a status row has the table's shape: ${row.slice(0, 80)}`);
    assert.ok(!byCase.has(m[1]), `${m[1]} has one status row`);
    byCase.set(m[1], { status: m[2], executed: Number(m[3]), simulated: Number(m[4]), later: m[5].trim() });
  }
  assert.deepEqual([...byCase.keys()].sort(), [...b10.caseIds].sort(), "the table names exactly the package's cases");
  const tally = { EXECUTED_LOCAL: 0, PARTIAL: 0 };
  for (const caseId of b10.caseIds) {
    const row = byCase.get(caseId);
    const rows = sectionOf(caseId).filter((l) => ROW.test(l));
    for (const l of rows) assert.equal([...l.matchAll(CITATION)].length, 1, `${caseId}: every row cites one test`);
    const executed = rows.filter((l) => ROW.exec(l)[2] === "EXECUTED_LOCAL").length;
    const simulated = rows.filter((l) => ROW.exec(l)[2] === "SIMULATED").length;
    assert.deepEqual([row.executed, row.simulated], [executed, simulated], `${caseId}: the counts are its section's rows`);
    assert.ok(executed >= 1, `${caseId}: at least one clause is demonstrated locally`);
    const laterOpen = !row.later.startsWith("none");
    // a fake decides a SIMULATED row's clause, so its live half stays open to the package that binds the real port (D10-CASEMAP-1)
    if (simulated > 0) assert.ok(laterOpen, `${caseId}: a SIMULATED clause names the package that makes it live`);
    assert.equal(row.status, laterOpen ? "PARTIAL" : "EXECUTED_LOCAL", `${caseId}: the status its later column implies`);
    if (laterOpen) {
      assert.match(row.later, /\bB\d{2}\b/, `${caseId}: an open clause names its package`);
      const named = [...row.later.matchAll(CASE_ID)].map((x) => x[0]);
      assert.ok(named.length > 0 || /no registry case/.test(row.later), `${caseId}: an open clause names its registry case or says there is none`);
    }
    for (const id of [...row.later.matchAll(CASE_ID)].map((x) => x[0])) assert.ok(CASES.has(id), `${caseId}: ${id} is a registry case`);
    tally[row.status] += 1;
  }
  const totals = /Totals: (\d+) cases — (\d+) EXECUTED_LOCAL, (\d+) PARTIAL\./.exec(caseMap);
  assert.ok(totals !== null, "the status section states its totals");
  assert.deepEqual(totals.slice(1).map(Number), [b10.caseIds.length, tally.EXECUTED_LOCAL, tally.PARTIAL]);
});

test("B10 case map: every scenario section quotes its registry expectation, every command section names its command and expectation, every DENY and RACE section states its registry scenario (D10-CASEMAP-1)", () => {
  for (const caseId of b10.caseIds) {
    const c = CASES.get(caseId);
    assert.ok(c !== undefined, `${caseId} is a registry case`);
    const lines = sectionOf(caseId);
    const family = /^CMD\d{3}-(OK|DENY|RACE)$/.exec(caseId);
    const titles = lines.flatMap((l) => [...l.matchAll(CITATION)].map((m) => m[2]));
    if (family === null) {
      const at = lines.findIndex((l) => l.startsWith("Expected (registry): "));
      assert.ok(at > 0, `${caseId}: its registry expectation`);
      const block = [];
      for (const l of lines.slice(at)) {
        if (l.trim() === "") break;
        block.push(l);
      }
      assert.equal(lcFirst(oneLine(block.join(" ").slice("Expected (registry): ".length))), lcFirst(oneLine(c.expected)), `${caseId}: the registry's words`);
      continue;
    }
    const command = registry("commands.json").find((x) => x.id === caseId.slice(0, 6));
    const expected = oneLine(c.expected.split(" No unauthorized")[0]).replace(/\.$/, "");
    if (family[1] === "OK") assert.ok(lines[0].includes(`(${command.name}; ${lcFirst(expected)})`), `${caseId}: its command and expectation`);
    if (family[1] === "DENY") {
      assert.ok(lines[0].includes(`(${lcFirst(expected)})`), `${caseId}: its expectation`);
      assert.ok(titles.some((t) => /foreign (tenant|scope)/.test(t) && /wrong (role|service identity)/.test(t) && /one missing prerequisite/.test(t)),
        `${caseId}: a title names a foreign tenant or scope, a wrong role or service identity and one missing prerequisite (${c.scenario})`);
    }
    if (family[1] === "RACE") {
      assert.ok(lines[0].includes("(one logical operation, a typed conflict or explicit reconciled uncertainty; no duplicate authority)"), `${caseId}: the race expectation`);
      assert.ok(titles.some((t) => /identical retry/.test(t) && /IDEMPOTENCY_CONFLICT/.test(t) && /crash/.test(t)),
        `${caseId}: a title names the identical retry, the conflicting same-key request and a crash at the intent/commit boundary (${c.scenario})`);
    }
  }
});

test("B10 case map: every worked example routed to a B10 case is named by a title of that case's section, with the example's integer cents", () => {
  const cases = new Set(b10.caseIds);
  let routed = 0;
  for (const [example, ids] of Object.entries(EXAMPLE_ROUTES)) {
    for (const caseId of ids.filter((id) => cases.has(id))) {
      routed += 1;
      const titles = sectionOf(caseId).flatMap((l) => [...l.matchAll(CITATION)].map((m) => m[2]));
      const named = titles.some((t) => [...t.matchAll(/\bexamples? (\d+(?:(?:, | and )\d+)*)/g)].some((m) => m[1].split(/, | and /).map(Number).includes(Number(example))));
      assert.ok(named, `${caseId}: a title names worked example ${example}`);
    }
  }
  assert.equal(routed, 31, "the B10 routes of the worked examples (21 of the 26 examples)");
  // the oracle's integer cents appear in the titles that cite the examples
  const text = citations().map((c) => c.title).join("\n");
  for (const cents of ["9713", "97125", "129500", "32375", "5275", "123025", "4921", "4121", "-800", "4857", "4856", "751", "2026-10-07", "2026-10-15", "2029-02-28T15:00:00Z", "16.67%", "199500"]) {
    assert.ok(text.includes(cents), `a title carries the oracle value ${cents}`);
  }
});

/** The rows of the design's machine tables: | machine | from | event | to | performer | enforcement |. */
const EDGE = /^\| ([A-Za-z]+) \| ([A-Z_]+) \| ([a-z_]+) \| ([A-Z_]+) \| ([^|]+) \| ([^|]+) \|$/;
const edges = design.split("\n").map((l) => EDGE.exec(l)).filter((m) => m !== null)
  .map((m) => ({ machine: m[1], from: m[2], event: m[3], to: m[4], performer: m[5].trim(), guard: m[6].trim() }));
const key = (e) => `${e.from} -${e.event}-> ${e.to}`;

const PLATFORM = ["FoundingReservation", "Seller", "Prospect", "AttributionClaim", "CommissionEntitlement", "CommissionStatement", "PayoutIntent", "PayoutDestination", "CommissionHold", "CommissionPeriod"];

test("B10 design: section 8.1 lists every registry CommissionLine edge exactly once with its performer and enforcement, its Agency edges are registry edges, and the B09 Quote events B10 performs are B09's", () => {
  const line = edges.filter((e) => e.machine === "CommissionLine");
  assert.deepEqual(line.map(key).sort(), MACHINES.find((m) => m.contract === "CommissionLine").transitions.map(key).sort(), "CommissionLine: the registry's edges");
  assert.equal(new Set(line.map(key)).size, line.length, "each CommissionLine edge once");
  const agency = new Set(MACHINES.find((m) => m.contract === "Agency").transitions.map(key));
  const agencyEdges = edges.filter((e) => e.machine === "Agency");
  assert.ok(agencyEdges.length >= 4);
  for (const e of agencyEdges) assert.ok(agency.has(key(e)), `Agency ${key(e)} is a registry edge`);
  for (const e of [...line, ...agencyEdges]) assert.ok(e.performer.length > 0 && e.guard.length > 0, `${e.machine} ${key(e)}: performer and enforcement`);
  const quoteMachine = read("packages", "domain", "src", "commerce", "machines.ts");
  for (const event of ["issue_quote", "superseding_quote_issued", "price_expiry_reached", "withdraw_quote"]) {
    assert.ok(design.includes(`\`${event}\``), `the design names ${event}`);
    assert.ok(quoteMachine.includes(`event: "${event}"`), `${event} is an event of B09's Quote machine`);
  }
});

test("B10 design: the platform machines of section 8.2 are closed — the registry contract's states where one exists, every state reachable from the initial one, a terminal state without an edge out and every other state with one", () => {
  const flat = design.replace(/\n[ \t]+/g, " ");
  for (const name of PLATFORM) {
    const head = new RegExp(`^- \\*\\*${name}\\*\\* — initial ([A-Z_]+); terminal ([A-Z_, ]+); states ([A-Z_, ]+?) \\(`, "m").exec(flat);
    assert.ok(head !== null, `${name}: its initial, terminal and state lists`);
    const states = head[3].split(",").map((s) => s.trim());
    const terminal = head[2].split(",").map((s) => s.trim());
    const contract = CONTRACTS.find((c) => c.name === name);
    const stateField = contract?.fields.find((f) => f.name === "state");
    if (stateField !== undefined) assert.deepEqual([...states].sort(), stateField.type.slice("enum:".length).split(",").sort(), `${name}: the registry contract's states`);
    const own = edges.filter((e) => e.machine === name);
    assert.ok(own.length > 0, `${name}: its edges are listed`);
    assert.equal(new Set(own.map(key)).size, own.length, `${name}: each edge once`);
    for (const e of own) {
      assert.ok(states.includes(e.from) && states.includes(e.to), `${name} ${key(e)}: states of the machine`);
      assert.ok(e.performer.length > 0 && e.guard.length > 0, `${name} ${key(e)}: performer and enforcement`);
    }
    const reached = new Set([head[1]]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of own) if (reached.has(e.from) && !reached.has(e.to)) { reached.add(e.to); grew = true; }
    }
    assert.deepEqual([...reached].sort(), [...states].sort(), `${name}: every state is reachable from ${head[1]}`);
    for (const s of states) {
      const out = own.filter((e) => e.from === s).length;
      if (terminal.includes(s)) assert.equal(out, 0, `${name}: terminal ${s} has no edge out`);
      else assert.ok(out > 0, `${name}: ${s} has an edge out`);
    }
  }
  const listed = new Set(edges.map((e) => e.machine));
  for (const m of listed) assert.ok(["Agency", "CommissionLine", ...PLATFORM].includes(m), `${m}: a machine B10 declares or performs`);
});

test("B10 design: every decision has one register row with its decision and citation, every D10 or Q10 reference in the design, the case map and the mandates is registered, and every fake is named with its owning mandate", () => {
  const rows = design.split("\n").map((l) => /^\| (D10-[A-Z]+-\d+) \| (.+) \| ([^|]+) \|$/.exec(l)).filter((m) => m !== null);
  const ids = rows.map((m) => m[1]);
  assert.ok(ids.length >= 40, `${ids.length} decisions`);
  assert.equal(new Set(ids).size, ids.length, "each decision once");
  for (const m of rows) assert.ok(m[2].trim().length > 20 && m[3].trim().length > 3, `${m[1]}: a decision and its citation`);
  const questions = new Set(design.split("\n").map((l) => /^\| (Q10-\d+) \|/.exec(l)?.[1]).filter(Boolean));
  for (const source of [design, caseMap, mandatesText]) {
    for (const ref of source.matchAll(/\bD10-[A-Z]+-\d+\b/g)) assert.ok(ids.includes(ref[0]), `${ref[0]} is a registered decision`);
    for (const ref of source.matchAll(/\bD10-([A-Z]+)-(\d+)\.\.(\d+)\b/g)) {
      for (let n = Number(ref[2]); n <= Number(ref[3]); n += 1) assert.ok(ids.includes(`D10-${ref[1]}-${n}`), `${ref[0]}: D10-${ref[1]}-${n} is registered`);
    }
    for (const ref of source.matchAll(/\bQ10-\d+\b/g)) assert.ok(questions.has(ref[0]), `${ref[0]} is a registered question`);
  }
  const owners = new Map(mandates.flatMap((m) => m.owns_fakes.map((f) => [f, m.key])));
  assert.ok(owners.size >= 4, "the four labelled fakes of B10");
  const attributed = [...design.matchAll(/(ContractFake[A-Za-z]+) \((B10-[A-Z]+(?:-[A-Z]+)*)\)/g)];
  for (const [fake, owner] of owners) assert.ok(attributed.some((m) => m[1] === fake && m[2] === owner), `the design names ${fake} with its owner ${owner}`);
  for (const m of attributed) assert.equal(owners.get(m[1]), m[2], `${m[1]} is owned by ${m[2]}`);
  // amendment A2: the registry's owner role is written KAURO_OWNER; the legacy token is derived as tools/openapi.mjs derives it,
  // from the R2 digest-domain aliases, and never spelled out here
  const digest = read("packages", "contracts", "src", "digest.ts");
  const aliases = digest.slice(digest.indexOf("R2_DOMAIN_ALIASES"), digest.indexOf("});", digest.indexOf("R2_DOMAIN_ALIASES")));
  const legacy = [...new Set([...aliases.matchAll(/^\s+([A-Z]+)_[A-Z_]+_V1:/gm)].map((m) => m[1]))];
  assert.equal(legacy.length, 1, "one legacy token");
  for (const source of [design, caseMap, mandatesText]) assert.doesNotMatch(source, new RegExp(legacy[0], "i"), "the product's earlier brand is never written");
});
