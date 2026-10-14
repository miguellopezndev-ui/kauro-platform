// The B16 case map (docs/design/B16-case-map.md): every B16 case of the registry appears exactly once, every status is DONE or OPEN with
// a named lane, and every cited title occurs verbatim in its cited file (titles are copied by tooling, never typed by hand).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { B16_CASE_MAP_PATH, readCaseMap } from "../evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const program = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", "program.json"), "utf8"));
const b16 = program.find((p) => p.id === "B16").caseIds;
const rows = readCaseMap(readFileSync(B16_CASE_MAP_PATH, "utf8"));

test("B16 case map: every B16 case of the registry appears exactly once and nothing else", () => {
  assert.deepEqual(rows.map((r) => r.caseId).sort(), [...b16].sort());
  assert.equal(new Set(rows.map((r) => r.caseId)).size, rows.length);
});

test("B16 case map: a status is DONE, or OPEN naming its owning lane; a DONE row cites at least one test", () => {
  for (const r of rows) {
    assert.match(r.status, /^(DONE EXECUTED_LOCAL|OPEN -> L[2-8](\+L[2-8])?( \(PR #\d+, not on main\))? (NOT_EXECUTED; target .+|PARTIAL \(PLANNED L[2-8]; target .+\)))$/, r.caseId);
    if (r.status.startsWith("DONE")) assert.ok(r.citations.length > 0, `${r.caseId} is DONE with no cited test`);
  }
  assert.deepEqual(rows.filter((r) => r.caseId === "R2-054" || r.caseId === "R2-055").map((r) => r.status.startsWith("OPEN -> L7")), [true, true]);
});

test("B16 case map: every cited title occurs verbatim in its cited file, which exists", () => {
  for (const r of rows) {
    for (const { file, title } of r.citations) {
      const path = join(root, file);
      assert.ok(existsSync(path), `${r.caseId}: ${file} does not exist`);
      const text = readFileSync(path, "utf8");
      assert.ok(text.includes(JSON.stringify(title)), `${r.caseId}: no test titled ${title.slice(0, 80)} in ${file}`);
    }
  }
});
