// Lock footprint of the row policies (FLAKY-UOW-TXLIMIT, batch B): a relation named in a policy expression is locked (AccessShareLock)
// whenever any query on the policy's table is planned, by every session the policy applies to, whether or not the policy can ever
// admit a row for it. B16's breakglass policy on kauro.agencies named kauro.projects, so every tenant read or lock of its agency waited
// on a lock of kauro.projects. The census reads, from the catalog the migrations build, every kauro policy that depends on a relation
// other than its own table; the set of (table, named relation) pairs is frozen at the pairs main already had, and a new one fails here: put the lookup in a
// PL/pgSQL function with an early return instead (0074 kauro.breakglass_scope_agency).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

const CENSUS = `SELECT DISTINCT c.relname || ' NAMES ' || r.relname AS entry
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> pol.polrelid
  JOIN pg_class r ON r.oid = d.refobjid
 WHERE n.nspname = $1
 ORDER BY 1`;

// The (table, named relation) pairs main had before batch B (reviewed when they landed): a policy may be renamed or split on one of
// them, since the lock footprint is the pair's, but no new pair may be added.
const FROZEN: readonly string[] = [];

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres({ testClock: false });
});
after(async () => {
  await pg.stop();
});

test("no new kauro row policy names a relation other than its own table (the lookup sits in a function), and a planted one is seen", async () => {
  const su = await pg.connect("postgres");
  try {
    const found = (await su.query<{ entry: string }>(CENSUS, ["kauro"])).rows.map((r) => r.entry);
    assert.deepEqual(found.filter((e) => !FROZEN.includes(e)), [], "a policy that names another relation locks it at every plan of its table");
    // planted negative: the same census sees a policy that names another relation
    await su.query("CREATE SCHEMA planted_policy");
    await su.query("CREATE TABLE planted_policy.parent (id int PRIMARY KEY)");
    await su.query("CREATE TABLE planted_policy.child (id int, parent_id int)");
    await su.query("CREATE POLICY child_by_parent ON planted_policy.child USING (EXISTS (SELECT 1 FROM planted_policy.parent p WHERE p.id = child.parent_id))");
    await su.query("CREATE POLICY child_plain ON planted_policy.child USING (id > 0)");
    const planted = (await su.query<{ entry: string }>(CENSUS, ["planted_policy"])).rows.map((r) => r.entry);
    assert.deepEqual(planted, ["child NAMES parent"], "the census sees the planted policy and only it");
    await su.query("DROP SCHEMA planted_policy CASCADE");
  } finally {
    await su.end();
  }
});
