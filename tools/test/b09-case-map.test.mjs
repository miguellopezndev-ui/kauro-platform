// The bookkeeping of docs/design/B09-case-map.md against the vendored registry and the sources of this branch (review finding
// B09-F7, decision D-CASEMAP-B1): one row for every B09 case, every cited test that exists on the branch exists under exactly
// its title, every cited test that does not exist yet is a PLANNED command-level test of apps/api, and every DENY and RACE row of
// CMD028..CMD034 states its registry scenario — "Foreign tenant/wrong role and then one missing material prerequisite" and
// "Identical retry, conflicting same-key request and crash at the intent/commit boundary" (cases.json; 10 "Contract tests and
// compatibility").
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { citationsOf } from "../evidence.mjs";

const root = join(import.meta.dirname, "..", "..");
const CASE_MAP = join(root, "docs", "design", "B09-case-map.md");
const registry = (name) => {
  const value = JSON.parse(readFileSync(join(root, "packages", "contracts", "registry", name), "utf8"));
  return Array.isArray(value) ? value : Object.values(value).find(Array.isArray);
};

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
  let carried = null;
  for (const line of readFileSync(CASE_MAP, "utf8").split(/\r?\n/)) {
    if (!line.startsWith("| ")) continue;
    const cells = cellsOf(line);
    if (cells.length !== 6 || !/^(S\d{3}|R2-\d{3}|CMD\d{3}-(OK|DENY|RACE))$/.test(cells[0])) continue;
    const { citations, file } = citationsOf(cells[2], carried);
    carried = file;
    out.push({ caseId: cells[0], expected: cells[1], citations, status: cells[3], observes: cells[4], later: cells[5] });
  }
  return out;
}

const b09Cases = [...registry("cases.json"), ...registry("additional_scenarios.json")].filter((c) => c.package === "B09");

test("B09-F7: every B09 case has exactly one row with its registry expectation; every cited existing test exists under exactly its title and every other citation is a PLANNED command-level test", () => {
  const map = rows();
  const ids = [...new Set(b09Cases.map((c) => c.id))].sort();
  assert.deepEqual(map.map((r) => r.caseId).sort(), ids);
  for (const row of map) {
    const registered = b09Cases.find((c) => c.id === row.caseId);
    assert.ok(row.expected.startsWith(registered.expected.split(" No unauthorized")[0].slice(0, 40)), `${row.caseId}: the registry expectation`);
    assert.ok(row.citations.length > 0, `${row.caseId}: cites a test`);
    for (const { file, title } of row.citations) {
      const path = join(root, file);
      if (existsSync(path)) {
        assert.ok(readFileSync(path, "utf8").includes(`test(${JSON.stringify(title)}`), `${row.caseId}: ${file} has no test titled ${title.slice(0, 90)}`);
      } else {
        assert.match(file, /^apps\/api\/test\/(cmd0(2[89]|3[0-4])-[a-z-]+|b09-[a-z]+)\.test\.ts$/, `${row.caseId}: ${file} is neither on the branch nor a planned api test`);
        assert.match(row.status, /PLANNED \(M[23]\)/, `${row.caseId}: a planned citation needs a PLANNED status`);
      }
    }
  }
});

test("B09-F7: every DENY row of CMD028..CMD034 names a foreign tenant, a wrong role or service identity and one missing prerequisite; every RACE row names the identical retry, the same key with another digest (IDEMPOTENCY_CONFLICT) and a crash at the intent/commit boundary; a provider-effect RACE crashes on both sides of the intent commit and between the claim and the settle", () => {
  const map = rows();
  const triads = map.filter((r) => /^CMD0(2[89]|3[0-4])-(DENY|RACE)$/.test(r.caseId));
  assert.equal(triads.length, 14);
  for (const row of triads) {
    const titles = row.citations.map((c) => c.title);
    if (row.caseId.endsWith("-DENY")) {
      assert.ok(
        titles.some((t) => /foreign tenant/.test(t) && /(wrong role|wrong service identity)/.test(t) && /one missing prerequisite/.test(t)),
        `${row.caseId}: no cited test demonstrates the scenario "Foreign tenant/wrong role and then one missing material prerequisite"`,
      );
    } else {
      assert.ok(
        titles.some((t) => /identical retry/.test(t) && /IDEMPOTENCY_CONFLICT/.test(t) && /crash/.test(t)),
        `${row.caseId}: no cited test demonstrates the scenario "Identical retry, conflicting same-key request and crash at the intent/commit boundary"`,
      );
      // A provider-effect command (CMD028 create order, CMD029 capture, CMD033 refund; design §6.1) has two sides to its intent/commit
      // boundary and a provider call after it: the RACE test injects the crash before the intent commits, between the intent commit
      // and the claim, and between the claim and the settle — after the call, where only an observation by request identity, never a
      // second dispatch, may follow (07 "The client recovers the same command result by its idempotency identity. It must not repeat
      // the external effect under a new key"; 10 "An ambiguous external effect requires reconciliation, not blind retry").
      if (/^CMD0(28|29|33)-RACE$/.test(row.caseId)) {
        assert.ok(
          titles.some(
            (t) =>
              /crash before the intent commits/.test(t) &&
              /crash between the intent commit and the claim/.test(t) &&
              /between the claim and the settle/.test(t) &&
              /(never creates a second|never dispatched again|never dispatches it again)/.test(t),
          ),
          `${row.caseId}: no cited test injects the crash on both sides of the intent commit and between the claim and the settle of the provider call`,
        );
      }
    }
  }
  // CMD034-OK maps an incident CMD034 itself raises, never the settlement comparison's FEE_MISMATCH (B09-F13)
  const reconcileOk = map.find((r) => r.caseId === "CMD034-OK");
  assert.ok(reconcileOk.citations.every((c) => !/FEE_MISMATCH|fee mismatch/.test(c.title)));
});
