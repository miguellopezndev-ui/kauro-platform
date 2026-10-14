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
