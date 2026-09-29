// The B08 design's machine, decision, migration and fake tables, read from the committed docs/design/B08-audit-approval-jobs.md
// against the vendored registry and docs/design/B08-mandates.json (reference/TRANSITIONS_AND_EVENT_EFFECTS: "Acceptance must cover
// every listed edge"; "An unlisted edge is rejected rather than inferred"; 07 "Job and attempt states", "Package and import
// states"). The design names a performer and an enforcement for every registry edge of the machines B08 owns, its platform machines
// are closed over the states manual 07 names, every decision it cites exists once, and every migration and fake has one owner.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const design = readFileSync(join(root, "docs", "design", "B08-audit-approval-jobs.md"), "utf8");
const caseMap = readFileSync(join(root, "docs", "design", "B08-case-map.md"), "utf8");
const mandatesText = readFileSync(join(root, "docs", "design", "B08-mandates.json"), "utf8");
const mandates = JSON.parse(mandatesText).mandates;
const machines = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "state_transitions.json"), "utf8"));

const EDGE = /^\| (Audit|Job|CostGrant|Plan|CommercialAuthorization|ProcessingAttempt|PackageVersion) \| ([A-Z_]+) \| ([a-z_]+) \| ([A-Z_]+) \| ([^|]+) \| ([^|]+) \|$/;
const edges = design.split("\n").map((l) => EDGE.exec(l)).filter((m) => m !== null)
  .map((m) => ({ machine: m[1], from: m[2], event: m[3], to: m[4], performer: m[5].trim(), guard: m[6].trim() }));
const key = (e) => `${e.from} -${e.event}-> ${e.to}`;

test("B08 design: section 8.1 lists every registry edge of Audit, Job and CostGrant exactly once with a performer and its enforcement, and every Plan edge B08 performs is a registry edge", () => {
  for (const name of ["Audit", "Job", "CostGrant"]) {
    const listed = edges.filter((e) => e.machine === name);
    const registry = machines.find((m) => m.contract === name).transitions.map(key).sort();
    assert.deepEqual(listed.map(key).sort(), registry, `${name}: the design's edges are exactly the registry's`);
    assert.equal(new Set(listed.map(key)).size, listed.length, `${name}: each edge once`);
    for (const e of listed) assert.ok(e.performer.length > 0 && e.guard.length > 0, `${name} ${key(e)}: performer and enforcement`);
  }
  const plan = new Set(machines.find((m) => m.contract === "Plan").transitions.map(key));
  const planEdges = edges.filter((e) => e.machine === "Plan");
  assert.ok(planEdges.length >= 4);
  for (const e of planEdges) assert.ok(plan.has(key(e)), `Plan ${key(e)} is a registry edge`);
});

// 07 "Job and attempt states": "An attempt is CREATED, CLAIMED, STARTING, RUNNING, STAGED, VERIFYING, COMMITTED, ABANDONED or FAILED";
// 07 "Package and import states": "PackageVersion is STAGED, VERIFIED_PRIVATE, AVAILABLE, RETIRED, REVOKED or DELETED".
const MANUAL_07_STATES = {
  ProcessingAttempt: ["CREATED", "CLAIMED", "STARTING", "RUNNING", "STAGED", "VERIFYING", "COMMITTED", "ABANDONED", "FAILED"],
  PackageVersion: ["STAGED", "VERIFIED_PRIVATE", "AVAILABLE", "RETIRED", "REVOKED", "DELETED"],
};

test("B08 design: the platform machines use exactly the states manual 07 names, every state is reachable from the initial one, a terminal state has no edge out and every other state has one", () => {
  for (const [name, states] of Object.entries(MANUAL_07_STATES)) {
    // a bullet continues on indented lines; join them without joining separate paragraphs
    const head = new RegExp(`^- \\*\\*${name}\\*\\* — initial ([A-Z_]+); terminal ([A-Z_, ]+); states ([A-Z_, ]+?) \\(07`, "m").exec(design.replace(/\n[ \t]+/g, " "));
    assert.ok(head !== null, `${name}: its initial, terminal and state lists`);
    const declared = head[3].split(",").map((s) => s.trim());
    assert.deepEqual(declared, states, `${name}: the states of manual 07`);
    const terminal = head[2].split(",").map((s) => s.trim());
    const own = edges.filter((e) => e.machine === name);
    for (const e of own) assert.ok(states.includes(e.from) && states.includes(e.to), `${name} ${key(e)}: states of the machine`);
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
});

test("B08 design: every decision has one register row with its decision and citation, and every D8 or Q8 reference in the design, the case map and the mandates names a registered decision or question", () => {
  const rows = design.split("\n").map((l) => /^\| (D8-[A-Z]+-\d+) \| (.+) \| ([^|]+) \|$/.exec(l)).filter((m) => m !== null);
  const ids = rows.map((m) => m[1]);
  assert.ok(ids.length >= 40, `${ids.length} decisions`);
  assert.equal(new Set(ids).size, ids.length, "each decision once");
  for (const m of rows) assert.ok(m[2].trim().length > 20 && m[3].trim().length > 3, `${m[1]}: a decision and its citation`);
  const questions = new Set(design.split("\n").map((l) => /^\| (Q8-\d+) \|/.exec(l)?.[1]).filter(Boolean));
  for (const source of [design, caseMap, mandatesText]) {
    for (const ref of source.matchAll(/\bD8-[A-Z]+-\d+\b/g)) assert.ok(ids.includes(ref[0]), `${ref[0]} is a registered decision`);
    for (const ref of source.matchAll(/\bQ8-\d+\b/g)) assert.ok(questions.has(ref[0]), `${ref[0]} is a registered question`);
  }
});

test("B08 design: the migrations of section 9 are the mandates' migrations, each owned by the mandate the design names, and every fake the design attributes to a B08 mandate is owned by that mandate alone", () => {
  const listed = design.split("\n").map((l) => /^\| (\d{4}_[a-z0-9_]+\.sql) \| .* \| (B08-[A-Z]+(?:-[A-Z]+)*) \|$/.exec(l)).filter((m) => m !== null);
  assert.ok(listed.length >= 3);
  for (const [, file, owner] of listed) {
    const holders = mandates.filter((m) => m.migrations.includes(file)).map((m) => m.key);
    assert.deepEqual(holders, [owner], `${file} belongs to ${owner}`);
  }
  assert.deepEqual(listed.map((m) => m[1]).sort(), mandates.flatMap((m) => m.migrations).sort(), "the design lists every mandate migration");
  const owners = new Map(mandates.flatMap((m) => m.owns_fakes.map((f) => [f, m.key])));
  const attributed = [...design.matchAll(/(ContractFake[A-Za-z]+)(?: and (ContractFake[A-Za-z]+))? \((B0\d-[A-Z]+(?:-[A-Z]+)*)/g)];
  for (const m of attributed.filter((x) => x[3].startsWith("B08-"))) {
    for (const fake of [m[1], m[2]].filter(Boolean)) assert.equal(owners.get(fake), m[3], `${fake} is owned by ${m[3]}`);
  }
  for (const [fake, owner] of owners) assert.ok(attributed.some((m) => (m[1] === fake || m[2] === fake) && m[3] === owner), `the design names ${fake} with its owner ${owner}`);
});
