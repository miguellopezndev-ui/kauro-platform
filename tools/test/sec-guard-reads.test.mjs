// SEC-DEPTH-PROVENANCE completeness and enforcement (Codex design r11/r12 root cause): every table and column the lane's guard
// functions read or write, as extracted from the migration SQL, has a section 3b cell (or a feeds-none residual entry); every
// bound or first cell names a trigger that really fires on that column's write and reads it; every first-assignment cell's trigger
// also fires on INSERT; every money/authority table names a birth trigger.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERED, check, inventory, parseMigrations, problems } from "../sec/guard-reads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const doc = join(root, "docs", "design", "SEC-DEPTH-PROVENANCE.md");

test("SEC-DEPTH completeness: every table and column a covered guard reads has a section 3b cell naming a trigger that fires on its write, or a feeds-none residual entry", () => {
  const r = check(doc);
  assert.deepEqual(r.missing, [], "problems");
  assert.equal(r.problems, 0);
  assert.ok(r.tables >= 50 && r.columns >= 335 && r.firstAssignments >= 53, `inventory shrank: ${JSON.stringify({ tables: r.tables, columns: r.columns, first: r.firstAssignments })}`);
});

test("SEC-DEPTH completeness: every guard function the lane covers is defined in the migrations", () => {
  const inv = inventory();
  assert.deepEqual(inv.missingFunctions, []);
  for (const fn of Object.values(COVERED).flat()) assert.ok(inv.functions[fn], fn);
});

test("SEC-DEPTH enforcement (negative, SDP-36): a first cell naming the delivery bound, whose WHEN reads only the state, is rejected", () => {
  const db = parseMigrations();
  const inv = { tables: { commercial_authorizations: { delivered_at: { learnedOnce: true, immutable: false } } } };
  const line = "### 3b x\n\n- `commercial_authorizations` (row 20; feeds money and authority) birth: [commercial_authorizations_require_capture]; first: `delivered_at` [commercial_authorizations_delivery_bound] only on DELIVERED.\n\n## A.";
  const found = problems(inv, line, db);
  assert.equal(found.length, 1);
  assert.match(found[0], /commercial_authorizations_delivery_bound .*WHEN.*does not read delivered_at/);
  const learnedOnceOnly = line.replace("commercial_authorizations_delivery_bound", "commercial_authorizations_learned_once");
  assert.match(problems(inv, learnedOnceOnly, db)[0], /does not read delivered_at|learned-once trigger itself|does not fire on INSERT/);
});

test("SEC-DEPTH enforcement (negative): an unknown trigger, a missing birth, an UPDATE OF list without the column, and a planned trigger absent from its existing migration are rejected", () => {
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
      "  IF NEW.fence <> OLD.fence AND NEW.expires_at > now() AND NEW.checkpoint_hash IS NULL THEN RAISE EXCEPTION 'x'; END IF;",
      "  PERFORM 1 FROM kauro.other o WHERE o.amount > 0;",
      "  RETURN NEW;",
      "END",
      "$$;",
      "CREATE TRIGGER leases_guard BEFORE INSERT OR UPDATE OF fence, expires_at ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.leases_guard();",
      "CREATE TRIGGER leases_learned_once BEFORE UPDATE ON kauro.leases FOR EACH ROW EXECUTE FUNCTION kauro.forbid_reassignment('expires_at');",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "0002_empty.sql"), "SELECT 1;\n");
    const db = parseMigrations(dir);
    const inv = inventory(dir, db);
    assert.deepEqual(Object.keys(inv.tables).sort(), ["leases", "other"]);
    const good = "### 3b x\n\n- `leases` (row 7; feeds authority) birth: [leases_guard]; bound: `fence` [leases_guard] +1; `checkpoint_hash` [leases_planned] kept; first: `expires_at` [leases_guard] claim := now.\nResidual B-LIFETIME-2 (feeds none): `other` test.\n\n### 3c x\n\n- planned `leases_planned` BEFORE INSERT OR UPDATE ON `leases` in 0009 (columns: `checkpoint_hash`) test\n\n## A.";
    assert.deepEqual(problems(inv, good, db), []);
    const out = problems(inv, good.replace(" birth: [leases_guard];", "").replace("[leases_planned]", "[leases_nothing]").replace("in 0009", "in 0002"), db);
    assert.ok(out.some((x) => /leases: feeds authority but has no birth cell/.test(x)), out.join("\n"));
    assert.ok(out.some((x) => /checkpoint_hash: trigger leases_nothing does not exist/.test(x)), out.join("\n"));
    const ofList = problems(inv, good.replace("`fence` [leases_guard]", "`fence` [leases_guard]").replace("`checkpoint_hash` [leases_planned]", "`checkpoint_hash` [leases_guard]"), db);
    assert.ok(ofList.some((x) => /checkpoint_hash: leases_guard fires only on UPDATE OF fence, expires_at/.test(x)), ofList.join("\n"));
    const missingPlanned = problems(inv, good.replace("in 0009", "in 0002"), db);
    assert.ok(missingPlanned.some((x) => /planned trigger leases_planned on leases is missing from migration 0002/.test(x)), missingPlanned.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
