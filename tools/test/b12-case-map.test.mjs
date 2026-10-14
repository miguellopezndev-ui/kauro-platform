// The B12 case map (docs/design/B12-case-map.md): every B12 case of the registry appears exactly once, every status is DONE or OPEN with
// a named B12 lane (plan docs/design/B12-outreach-plan.md §1, §9), and every cited title occurs verbatim in its cited file.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCaseMap } from "../evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const program = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "program.json"), "utf8"));
const b12 = program.find((p) => p.id === "B12").caseIds;
const rows = readCaseMap(readFileSync(join(root, "docs", "design", "B12-case-map.md"), "utf8"));
const LANES = "L-DRAFT|L-AUTH|L-SEND|L-ACT|L-HOME|B12-OWNER-SCREENS-2";

test("B12 case map: every B12 case of the registry appears exactly once and nothing else", () => {
  assert.deepEqual(rows.map((r) => r.caseId).sort(), [...b12].sort());
  assert.equal(new Set(rows.map((r) => r.caseId)).size, rows.length);
});

test("B12 case map: a status is DONE, or OPEN naming its owning B12 lane and target class; a DONE row cites at least one test", () => {
  for (const r of rows) {
    assert.match(r.status, new RegExp(`^(DONE EXECUTED_LOCAL( \+ SIMULATED)?|OPEN -> (${LANES}) NOT_EXECUTED; target .+)$`), r.caseId);
    if (r.status.startsWith("DONE")) assert.ok(r.citations.length > 0, `${r.caseId} is DONE with no cited test`);
  }
});

test("B12 case map: every cited title occurs verbatim in its cited file, which exists", () => {
  for (const r of rows) {
    for (const { file, title } of r.citations) {
      const path = join(root, file);
      assert.ok(existsSync(path), `${r.caseId}: ${file} does not exist`);
      assert.ok(readFileSync(path, "utf8").includes(JSON.stringify(title)), `${r.caseId}: no test titled ${title.slice(0, 80)} in ${file}`);
    }
  }
});
