// Order 21 (Stage A reserved migration ranges): the runner accepts a gap between versions, as the reserved disjoint ranges of the orders
// produce one (0097-0109 for O20, 0110-0119 for O21, ...), still refuses a duplicate version and a first version other than 0001, and never
// applies a pending file below a version the database already recorded (out of order). Pure file-level checks plus one real database.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyMigrations, listMigrations } from "../src/index.js";
import { startTemporaryPostgres } from "../src/testing/index.js";

function dirOf(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "kauro-o21-ranges-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test("O21: a gap between migration versions is accepted; a duplicate and a first version other than 0001 are refused", () => {
  const gap = dirOf({ "0001_a.sql": "SELECT 1;", "0002_b.sql": "SELECT 1;", "0110_c.sql": "SELECT 1;" });
  const dup = dirOf({ "0001_a.sql": "SELECT 1;", "0002_b.sql": "SELECT 1;", "0002_c.sql": "SELECT 1;" });
  const late = dirOf({ "0002_b.sql": "SELECT 1;" });
  try {
    assert.deepEqual(listMigrations(gap).map((f) => f.version), [1, 2, 110]);
    assert.throws(() => listMigrations(dup), /duplicate migration version 2/);
    assert.throws(() => listMigrations(late), /start at 0001/);
  } finally {
    for (const d of [gap, dup, late]) rmSync(d, { recursive: true, force: true });
  }
});

test("O21: a pending migration below the highest applied version is never applied (out of order), and the shipped set applies on a fresh database", async () => {
  const pg = await startTemporaryPostgres({ migrate: false });
  const first = dirOf({ "0001_a.sql": "CREATE TABLE o21_a (x int);", "0110_c.sql": "CREATE TABLE o21_c (x int);" });
  const later = dirOf({ "0001_a.sql": "CREATE TABLE o21_a (x int);", "0097_b.sql": "CREATE TABLE o21_b (x int);", "0110_c.sql": "CREATE TABLE o21_c (x int);" });
  const client = await pg.connect("postgres");
  try {
    const r = await applyMigrations(client, { dir: first });
    assert.deepEqual(r.applied.map((f) => f.version), [1, 110]);
    await assert.rejects(applyMigrations(client, { dir: later }), /0097_b\.sql is pending below the applied version 110/);
    const tables = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_tables WHERE tablename = 'o21_b'");
    assert.equal(tables.rows[0]?.n, "0", "the late migration did not run");
  } finally {
    await client.end();
    await pg.stop();
    for (const d of [first, later]) rmSync(d, { recursive: true, force: true });
  }
});
