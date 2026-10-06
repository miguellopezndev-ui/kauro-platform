// SEC-DEPTH-PROVENANCE completeness (Codex design r11 root cause): every table and column the lane's guard functions read or write,
// as extracted from the migration SQL, has a cell in section 3b of the design doc or an explicit residual entry, and every
// learned-once (NULL -> value) column has its own first-assignment binding.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERED, check, inventory, unmapped } from "../sec/guard-reads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const doc = join(root, "docs", "design", "SEC-DEPTH-PROVENANCE.md");

test("SEC-DEPTH completeness: every table and column a covered guard reads has a section 3b cell or a residual entry, and every learned-once column a first-assignment binding", () => {
  const r = check(doc);
  assert.deepEqual(r.missing, [], "unmapped inventory entries");
  assert.equal(r.unmapped, 0);
  assert.ok(r.tables >= 39 && r.columns >= 306 && r.firstAssignments >= 47, `inventory shrank: ${JSON.stringify({ tables: r.tables, columns: r.columns, first: r.firstAssignments })}`);
});

test("SEC-DEPTH completeness: every guard function the lane covers is defined in the migrations", () => {
  const inv = inventory();
  assert.deepEqual(inv.missingFunctions, []);
  for (const fn of Object.values(COVERED).flat()) assert.ok(inv.functions[fn], fn);
});

test("SEC-DEPTH completeness (negative): an unlisted column, a learned-once column without a first binding and an unlisted table are reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-guard-reads-"));
  try {
    writeFileSync(join(dir, "0001_t.sql"), [
      "CREATE TABLE kauro.leases (",
      "  fence            bigint NOT NULL,",
      "  expires_at       timestamptz NOT NULL,",
      "  checkpoint_hash  text",
      ");",
      "CREATE TABLE kauro.other (",
      "  amount           bigint NOT NULL",
      ");",
      "CREATE OR REPLACE FUNCTION kauro.leases_guard() RETURNS trigger LANGUAGE plpgsql AS $$",
      "BEGIN",
      "  IF NEW.fence <> OLD.fence AND NEW.expires_at > now() THEN RAISE EXCEPTION 'x'; END IF;",
      "  PERFORM 1 FROM kauro.other o WHERE o.amount > 0;",
      "  RETURN NEW;",
      "END",
      "$$;",
      "CREATE TRIGGER leases_guard BEFORE UPDATE ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.leases_guard();",
      "CREATE TRIGGER leases_learned_once BEFORE UPDATE ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('expires_at');",
      "",
    ].join("\n"));
    const inv = inventory(dir);
    assert.deepEqual(Object.keys(inv.tables).sort(), ["leases", "other"]);
    assert.equal(inv.tables.leases.expires_at.learnedOnce, true);
    const partial = "### 3b x\n\n- `leases` (row 7) bound: `fence` +1; `expires_at` now.\n\n## A.";
    assert.deepEqual(unmapped(inv, partial).sort(), ["leases.expires_at: learned once without a first-assignment binding", "other: no section 3b line and no residual entry"]);
    const complete = "### 3b x\n\n- `leases` (row 7) bound: `fence` +1; first: `expires_at` claim := now.\nResidual B-LIFETIME-2: `other`.\n\n## A.";
    assert.deepEqual(unmapped(inv, complete), []);
    const noColumn = "### 3b x\n\n- `leases` (row 7) first: `expires_at` claim := now.\nResidual B-LIFETIME-2: `other`.\n\n## A.";
    assert.deepEqual(unmapped(inv, noColumn), ["leases.fence: no cell"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
