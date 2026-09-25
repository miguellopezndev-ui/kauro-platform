// The case map's bookkeeping, read from the committed docs/design/B06-case-map.md against the vendored registry (re-check
// findings N12 and N18; 21 "Evidence classes": "SIMULATED demonstrates a local contract with fakes", "Every claim names its
// class"; 21 "Gate registry": "Each gate record lists applicability, prerequisites, owner, required evidence, independent
// checks, blocking findings, accepted subject and review trigger. NOT_APPLICABLE requires a reason."): one PARTIAL criterion
// for every case, a record for every closure gate of B06, and an answer to every registry verification clause.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CASE_MAP_PATH, readCaseMap } from "../evidence.mjs";

const root = join(import.meta.dirname, "..", "..");
const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};
const text = readFileSync(CASE_MAP_PATH, "utf8");
const rows = readCaseMap(text);
const b06 = registry("program.json").find((p) => p.id === "B06");

/** The body of the case map's `## <title>` section, up to the next `## ` heading. */
function section(title) {
  const start = text.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `the case map has no section "## ${title}"`);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

/** A package of the program other than B06. */
const OTHER_PACKAGE = /\bB(0[0-57-9]|1\d|2[0-2])\b/;

// The reviewed classification (design D-GATE-1): a case is PARTIAL when a clause of its expected outcome is shown only through
// a test-bound port (SIMULATED) or belongs to another package's command or aggregate (not demonstrated in B06).
const PARTIAL = ["S089", "S093", "R2-043", "CMD023-OK", "CMD023-DENY", "CMD025-OK", "CMD025-DENY", "CMD026-OK"];

test("N12: one PARTIAL criterion — exactly the reviewed cases are PARTIAL, each naming its demonstrated half, what B06 does not demonstrate and the package that owns it; no EXECUTED_LOCAL row rests on a SIMULATED clause; an edition constant a row relies on is NOT_APPLICABLE with its reason", () => {
  const partial = rows.filter((r) => r.status.startsWith("PARTIAL"));
  assert.deepEqual(partial.map((r) => r.caseId).sort(), [...PARTIAL].sort());
  for (const row of partial) {
    assert.match(row.observes, /\*\*Demonstrated\*\*/, `${row.caseId}: its demonstrated half`);
    assert.match(row.observes, /\*\*(SIMULATED|Not demonstrated in B06)\*\*/, `${row.caseId}: its undemonstrated half`);
    assert.match(row.observes, OTHER_PACKAGE, `${row.caseId}: the package that owns the undemonstrated half`);
  }
  for (const row of rows.filter((r) => !r.status.startsWith("PARTIAL"))) {
    assert.doesNotMatch(row.observes, /\*\*SIMULATED\*\*/, `${row.caseId} is EXECUTED_LOCAL yet names a SIMULATED clause`);
  }
  assert.match(rows.find((r) => r.caseId === "CMD010-OK").observes, /NOT_APPLICABLE/, "CMD010-OK: the edition's retained-work constants");
});

test("N18: every closure gate of B06 has its record — its owner and package, every field of manual 21 for a gate of B06 with each gate case outside B06 and the package the registry routes it to, and for a gate another package owns what B06 contributes to each of its cases", () => {
  const gates = registry("gates.json");
  const requirements = registry("requirements.json");
  const body = section("Gates");
  assert.deepEqual([...b06.gates].sort(), ["G-DOMAIN", "G-TENANT"]);
  for (const gateId of b06.gates) {
    const gate = gates.find((g) => g.id === gateId);
    const start = body.indexOf(`\n### ${gateId} (`);
    assert.ok(start >= 0, `${gateId}: no record`);
    const next = body.indexOf("\n### ", start + 1);
    const record = body.slice(start, next < 0 ? body.length : next);
    assert.ok(record.split("\n")[1].includes(`owner manual ${gate.owner}, package ${gate.package}; ${gate.caseIds.length} cases)`), `${gateId}: its owner, package and size`);
    if (gate.package === "B06") {
      for (const field of ["applicability", "prerequisites", "owner", "required evidence", "independent checks", "blocking findings", "accepted subject", "review trigger"]) {
        assert.ok(record.includes(`\n| ${field} | `), `${gateId}: no "${field}"`);
      }
      for (const caseId of gate.caseIds.filter((c) => !b06.caseIds.includes(c))) {
        const routed = requirements.filter((r) => r.caseIds.includes(caseId)).flatMap((r) => r.packages);
        assert.ok(routed.length > 0, `${caseId}: routed by no requirement`);
        assert.ok(record.includes(caseId), `${gateId}: ${caseId}, outside B06, is not named`);
        for (const pkg of routed) assert.ok(record.includes(pkg), `${gateId}: ${caseId} is routed to ${pkg}, which the record does not name`);
      }
    } else {
      assert.ok(record.includes(`what ${gate.package} must still prove`), `${gateId}: what ${gate.package} must still prove`);
      const ranges = [...record.matchAll(/CMD(\d{3})–CMD(\d{3})/g)].map((m) => [Number(m[1]), Number(m[2])]);
      for (const caseId of gate.caseIds) {
        const family = /^CMD(\d{3})-(OK|DENY|RACE)$/.exec(caseId);
        const covered =
          record.includes(caseId) ||
          (family !== null && (new RegExp(`\\bCMD${family[1]}\\b`).test(record) || ranges.some(([a, b]) => a <= Number(family[1]) && Number(family[1]) <= b)));
        assert.ok(covered, `${gateId}: ${caseId} has no row`);
      }
    }
  }
});

test("N18: every registry verification clause of B06's command cases is quoted and answered — NOT_APPLICABLE with the package whose domain it is, or the evidence that answers it", () => {
  const cases = registry("cases.json");
  const body = section("Registry verification clauses");
  const clauses = new Map();
  for (const caseId of b06.caseIds.filter((c) => c.startsWith("CMD"))) {
    const verification = cases.find((c) => c.id === caseId).verification;
    clauses.set(verification, [...(clauses.get(verification) ?? []), caseId]);
  }
  for (const [clause, caseIds] of clauses) {
    const line = body.split("\n").find((l) => l.startsWith("| ") && l.includes(`"${clause}"`));
    assert.ok(line, `the clause of ${caseIds.join(", ")} is not quoted: "${clause}"`);
    for (const caseId of caseIds) assert.ok(line.includes(`${caseId.slice(0, 6)}-*`), `${caseId}: the row of its clause does not name it`);
    const answer = line.split(" | ").at(-1);
    assert.ok(/^NOT_APPLICABLE\b.*\bB\d\d\b/.test(answer) || /^Answered by\b/.test(answer), `${caseIds[0]}: the clause is neither NOT_APPLICABLE with its owner nor answered`);
  }
});
