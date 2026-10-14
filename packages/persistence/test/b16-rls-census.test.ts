// R2-047 census: the isolation facts are read from the catalog of the schema the migrations actually build (real PostgreSQL 17), not
// from a list of tables or roles someone remembered to maintain. A new tenant table or a new runtime role that breaks the rule fails
// here by itself.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres({ testClock: false });
});
after(async () => {
  await pg.stop();
});

test("R2-047 census: every kauro table with agency_id has ENABLE+FORCE RLS and every runtime role is non-owner, non-superuser, no BYPASSRLS", async () => {
  const su = await pg.connect("postgres");
  try {
    // (1) every ordinary or partitioned kauro table carrying an agency_id column: row security enabled AND forced
    const tenant = await su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'agency_id' AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'kauro' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
    );
    assert.ok(tenant.rows.length >= 20, `the census saw the tenant tables (${tenant.rows.length})`);
    const open = tenant.rows.filter((t) => !t.relrowsecurity || !t.relforcerowsecurity).map((t) => `${t.relname}: enable=${t.relrowsecurity} force=${t.relforcerowsecurity}`);
    assert.deepEqual(open, [], "every table with an agency_id is isolated by ENABLE and FORCE ROW LEVEL SECURITY");
    // the same holds for views: a view over a tenant table must not run with its owner's rights around the policies
    const views = await su.query<{ relname: string; reloptions: string[] | null }>(
      `SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kauro' AND c.relkind IN ('v', 'm') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'agency_id' AND a.attnum > 0 AND NOT a.attisdropped)
        ORDER BY c.relname`,
    );
    for (const v of views.rows) assert.ok((v.reloptions ?? []).some((o) => /^security_invoker=(true|on)$/.test(o)), `view ${v.relname} is security_invoker`);

    // (2) every role of the kauro family other than the schema owner: no superuser, no BYPASSRLS, no CREATEROLE/CREATEDB, owns nothing
    const roles = await su.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname LIKE 'kauro\\_%' AND rolname <> 'kauro_owner' ORDER BY rolname",
    );
    const runtime = roles.rows.map((r) => r.rolname);
    for (const expected of ["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment", "kauro_commission"]) {
      assert.ok(runtime.includes(expected), `${expected} is part of the census`);
    }
    for (const r of roles.rows) {
      assert.deepEqual([r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication], [false, false, false, false, false], r.rolname);
    }
    // the owner never serves requests: it holds the objects, no runtime role does
    const owner = await su.query<{ rolsuper: boolean; rolcanlogin: boolean }>("SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = 'kauro_owner'");
    assert.equal(owner.rows[0]?.rolsuper, false, "even the owner is not a superuser");
    const owned = await su.query<{ kind: string; name: string; owner: string }>(
      `SELECT 'table' AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kauro' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       UNION ALL
       SELECT 'function', p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro'
       ORDER BY 1, 2`,
    );
    assert.ok(owned.rows.length > 20, "the census saw the schema's objects");
    const foreign = owned.rows.filter((o) => o.owner !== "kauro_owner").map((o) => `${o.kind} ${o.name} owned by ${o.owner}`);
    assert.deepEqual(foreign, [], "no kauro object is owned by a runtime role (an owner bypasses RLS unless forced, and may alter its policies)");
    const members = await su.query<{ member: string; role: string }>(
      `SELECT m.rolname AS member, r.rolname AS role FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
        WHERE m.rolname = ANY($1::text[]) AND r.rolname IN ('kauro_owner', 'postgres') ORDER BY 1, 2`,
      [runtime],
    );
    assert.deepEqual(members.rows, [], "no runtime role is a member of the owner or of a superuser role");
  } finally {
    await su.end();
  }
});
