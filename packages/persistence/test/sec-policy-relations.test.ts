// Lock footprint of the row policies (FLAKY-UOW-TXLIMIT, batch B): a relation named in a policy expression is locked (AccessShareLock)
// whenever any query on the policy's table is planned, by every session the policy applies to, whether or not the policy can ever
// admit a row for it. B16's breakglass policy on kauro.agencies named kauro.projects, so every tenant read or lock of its agency waited
// on a lock of kauro.projects. The census reads, from the catalog the migrations build, every kauro policy that depends on a relation
// other than its own table; the set of (table, named relation) pairs is frozen at the pairs main already had, and a new one fails here: put the lookup in a
// PL/pgSQL function with an early return instead (0074 kauro.breakglass_scope_agency).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const FROZEN: readonly string[] = [
  "agencies NAMES memberships",
  "approvals NAMES memberships",
  "attribution_allocations NAMES allocation_shares",
  "attribution_claims NAMES prospects",
  "audits NAMES memberships",
  "bank_route_versions NAMES bank_routes",
  "banking_calendars NAMES commission_statements",
  "decision_artifacts NAMES memberships",
  "domain_events NAMES commerce_event_bindings",
  "identities NAMES sellers",
  "import_stages NAMES memberships",
  "inbox_body_conflicts NAMES inbox_records",
  "inbox_body_conflicts NAMES payment_routes",
  "inbox_records NAMES payment_routes",
  "membership_invitations NAMES memberships",
  "outbox_records NAMES commerce_event_bindings",
  "outbox_records NAMES commerce_event_subscriptions",
  "outbox_records NAMES domain_events",
  "payment_orders NAMES quotes",
  "plan_validations NAMES memberships",
  "plans NAMES audits",
  "processing_jobs NAMES memberships",
  "quotes NAMES purchase_rebindings",
  "retention_extensions NAMES retention_records",
  "retention_records NAMES capture_facts",
  "retention_records NAMES dataset_revisions",
  "retention_records NAMES processing_jobs",
  "retention_records NAMES retention_anchors",
  "security_events NAMES memberships",
  "selection_manifests NAMES memberships",
  "stage_receipts NAMES memberships",
  "target_artifacts NAMES memberships",
  "upload_session_secrets NAMES upload_sessions",
  "upload_sessions NAMES memberships",
];

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

test("B12 K2: no policy the B12 outreach migration creates names another relation (the lookups sit in kauro.outreach_* functions with an early return)", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const file = readdirSync(dir).filter((f) => /_b12_outreach\.sql$/.test(f));
  assert.equal(file.length, 1, "one B12 outreach migration (its number is provisional until the batch renumbers it)");
  const created = new Set([...readFileSync(new URL(file[0]!, dir), "utf8").matchAll(/^CREATE POLICY (\w+) ON kauro\.(\w+)/gm)].map((m) => `${m[1]} ON ${m[2]}`));
  assert.ok(created.size >= 80, `the migration is read (${created.size} policies)`);
  // the census per policy (its name, its table, the relation it names): a B12 policy is matched by name, not by its pair
  const POLICY_CENSUS = CENSUS.replace("SELECT DISTINCT c.relname || ' NAMES '", "SELECT DISTINCT pol.polname || ' ON ' || c.relname || ' NAMES '");
  assert.notEqual(POLICY_CENSUS, CENSUS, "the per-policy census is derived from the pair census");
  const su = await pg.connect("postgres");
  try {
    const found = (await su.query<{ entry: string }>(POLICY_CENSUS, ["kauro"])).rows.map((r) => r.entry);
    const b12 = found.filter((e) => created.has(e.split(" NAMES ")[0]!));
    assert.deepEqual(b12, [], "a B12 policy names another relation: move the lookup into a PL/pgSQL STABLE SECURITY INVOKER function with an early return (0072 kauro.outreach_*)");
    // the lookup functions exist, are INVOKER, STABLE and pin their search_path, and only kauro_app may call them
    const fns = (
      await su.query<{ proname: string; prosecdef: boolean; provolatile: string; cfg: string[] | null; pub: boolean; app: boolean }>(
        `SELECT p.proname, p.prosecdef, p.provolatile, p.proconfig AS cfg, has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('kauro_app', p.oid, 'EXECUTE') AS app
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'kauro' AND p.proname IN ('outreach_draft_authored', 'outreach_sender_owned', 'outreach_prospect_visible', 'outreach_intent_of_person', 'outreach_intent_visible') ORDER BY 1`,
      )
    ).rows;
    assert.deepEqual(fns.map((f) => f.proname), ["outreach_draft_authored", "outreach_intent_of_person", "outreach_intent_visible", "outreach_prospect_visible", "outreach_sender_owned"]);
    for (const f of fns) {
      assert.equal(f.prosecdef, false, `${f.proname} is SECURITY INVOKER`);
      assert.equal(f.provolatile, "s", `${f.proname} is STABLE`);
      assert.ok((f.cfg ?? []).some((c) => c.startsWith("search_path=pg_catalog")), `${f.proname} pins search_path`);
      assert.equal(f.pub, false, `${f.proname} is not callable by PUBLIC`);
      assert.equal(f.app, true, `${f.proname} is callable by kauro_app`);
    }
  } finally {
    await su.end();
  }
});
