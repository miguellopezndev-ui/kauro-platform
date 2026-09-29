// The migrations against a real PostgreSQL 17 (07 "Acceptance obligations"): they apply in order, re-apply as a no-op,
// refuse drift, and the schema they build agrees with the vendored registry (state vocabularies, listed transitions, event
// types, aggregate kinds) and with the isolation rules (runtime roles are not owners/superusers/BYPASSRLS; every kauro table
// has RLS forced).
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { STATE_MACHINES, registryJson } from "@kauro/contracts";
import { AGGREGATE_KINDS, EVENT_TYPES, PLATFORM_STATE_MACHINES } from "@kauro/domain";
import { MIGRATIONS_DIR, MigrationDriftError, applyMigrations, appliedMigrations, listMigrations } from "../src/index.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres();
});
after(async () => {
  await pg.stop();
});

test("every migration applied once, in order, with its checksum recorded; a second run applies nothing", async () => {
  const files = listMigrations();
  // B06 owns 0001..0007; 0008 is the shared aggregate-kind registry (docs/design/FOUNDATION-aggregate-kinds.md); 0009 is the public inquiry (B11 W5b)
  assert.deepEqual(files.map((f) => f.file), [
    "0001_schema_roles_helpers.sql",
    "0002_identity_agencies_memberships.sql",
    "0003_capabilities_clients_projects.sql",
    "0004_plans_receipts_approvals.sql",
    "0005_events_outbox_inbox.sql",
    "0006_journals_leases.sql",
    "0007_security_events.sql",
    "0008_aggregate_kind_registry.sql",
    "0009_inquiries.sql",
  ]);
  assert.deepEqual(pg.migrations.applied.map((f) => f.version), files.map((f) => f.version));
  const owner = await pg.connect("kauro_owner");
  try {
    const again = await applyMigrations(owner);
    assert.equal(again.applied.length, 0);
    assert.equal(again.skipped.length, files.length);
    const ledger = await appliedMigrations(owner);
    assert.deepEqual(ledger.map((l) => [l.version, l.checksum]), files.map((f) => [f.version, f.checksum]));
    for (const l of ledger) assert.equal(l.appliedBy, "kauro_owner");
  } finally {
    await owner.end();
  }
});

test("a migration file edited after being applied is refused as drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-mig-drift-"));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    const owner = await pg.connect("kauro_owner");
    try {
      const first = await applyMigrations(owner, { dir });
      assert.equal(first.applied.length, 0, "the copy matches the applied set");
      writeFileSync(join(dir, "0007_security_events.sql"), "-- edited after application\nSELECT 1;\n");
      await assert.rejects(applyMigrations(owner, { dir }), MigrationDriftError);
    } finally {
      await owner.end();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime roles are neither owners nor superusers and have no BYPASSRLS; the owner never serves requests", async () => {
  const su = await pg.connect("postgres");
  try {
    const roles = await su.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname IN
         ('kauro_app', 'kauro_control', 'kauro_assurance', 'kauro_validator', 'kauro_ingress', 'kauro_app_test', 'kauro_control_test', 'kauro_assurance_test', 'kauro_validator_test', 'kauro_ingress_test')`,
    );
    assert.equal(roles.rows.length, 10);
    for (const r of roles.rows) {
      assert.equal(r.rolsuper, false, r.rolname);
      assert.equal(r.rolbypassrls, false, r.rolname);
      assert.equal(r.rolcreaterole, false, r.rolname);
    }
    const owners = await su.query<{ tableowner: string }>("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'kauro'");
    assert.deepEqual(owners.rows.map((o) => o.tableowner), ["kauro_owner"]);
    const rls = await su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relkind = 'r' ORDER BY c.relname",
    );
    assert.ok(rls.rows.length >= 20);
    for (const t of rls.rows) {
      if (t.relname === "state_transitions" || t.relname === "state_machines") continue; // reference data, SELECT only, no tenant rows
      assert.equal(t.relrowsecurity, true, `${t.relname} has no RLS`);
      assert.equal(t.relforcerowsecurity, true, `${t.relname} does not FORCE RLS`);
    }
    // no SECURITY DEFINER function anywhere in the schema (08: requires specific justification; none is used)
    const definers = await su.query<{ proname: string }>("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'kauro' AND p.prosecdef");
    assert.deepEqual(definers.rows, []);
    // request handlers never hold DELETE on any table
    const deletes = await su.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'kauro_app' AND privilege_type = 'DELETE' AND table_schema = 'kauro'",
    );
    assert.deepEqual(deletes.rows, []);
  } finally {
    await su.end();
  }
});

interface RegistryContract {
  name: string;
  fields: Array<{ name: string; type: string }>;
}

function registryEnum(contract: string, field: string): string[] {
  const contracts = registryJson<RegistryContract[]>("contracts.json");
  const f = contracts.find((c) => c.name === contract)?.fields.find((x) => x.name === field);
  assert.ok(f && f.type.startsWith("enum:"), `${contract}.${field}`);
  return f.type.slice(5).split(",");
}

test("state and enum CHECK constraints carry exactly the registry vocabularies", async () => {
  const su = await pg.connect("postgres");
  try {
    const expect: Array<[string, string, string, string]> = [
      ["agencies", "state", "Agency", "state"],
      ["memberships", "role", "Membership", "role"],
      ["memberships", "state", "Membership", "state"],
      ["end_clients", "state", "EndClient", "state"],
      ["dataset_revisions", "state", "DatasetRevision", "state"],
      ["plans", "state", "Plan", "state"],
      ["capabilities", "state", "Capability", "state"],
      ["validation_receipts", "result", "ValidationReceipt", "result"],
      ["request_journal", "state", "RequestJournal", "state"],
      ["request_journal", "usage_state", "RequestJournal", "usageState"],
      ["outbox_records", "state", "OutboxRecord", "state"],
      ["inbox_records", "state", "InboxRecord", "state"],
      ["inbox_records", "environment", "InboxRecord", "environment"],
      ["target_contracts", "mode", "TargetContract", "mode"],
    ];
    for (const [table, column, contract, field] of expect) {
      const r = await su.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'kauro' AND t.relname = $1 AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ~ ('^CHECK \\(\\(' || $2 || ' = ANY')`,
        [table, column],
      );
      assert.equal(r.rows.length, 1, `${table}.${column} has no enum CHECK`);
      const values = [...r.rows[0]!.def.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
      assert.deepEqual(values, registryEnum(contract, field), `${table}.${column}`);
    }
  } finally {
    await su.end();
  }
});

test("the listed-transition seed equals the registry machines for every machine the schema guards", async () => {
  const su = await pg.connect("postgres");
  try {
    for (const name of ["Agency", "Membership", "DatasetRevision", "Plan", "Capability"]) {
      const m = STATE_MACHINES.find((x) => x.contract === name)!;
      const expected = [...new Set(m.transitions.map((t) => `${t.from}>${t.to}`))].sort();
      const r = await su.query<{ edge: string }>("SELECT from_state || '>' || to_state AS edge FROM kauro.state_transitions WHERE machine = $1 ORDER BY 1", [name]);
      assert.deepEqual(r.rows.map((x) => x.edge), expected, name);
    }
    const others = await su.query<{ machine: string }>("SELECT DISTINCT machine FROM kauro.state_transitions ORDER BY 1");
    assert.deepEqual(others.rows.map((x) => x.machine), ["Agency", "Capability", "DatasetRevision", "EndClient", "Membership", "Plan", "Project"]);
  } finally {
    await su.end();
  }
});

test("R20: the initial-state seed equals the registry machines (and the platform machines of D-AGG-1/D-AGG-2); every table that guards its listed edges also guards its birth state", async () => {
  const su = await pg.connect("postgres");
  try {
    const seeded = await su.query<{ machine: string; initial_state: string }>("SELECT machine, initial_state FROM kauro.state_machines ORDER BY machine");
    const expected = ["Agency", "Capability", "DatasetRevision", "EndClient", "Membership", "Plan", "Project"].map((name) => {
      const m = STATE_MACHINES.find((x) => x.contract === name) ?? PLATFORM_STATE_MACHINES.find((x) => x.contract === name);
      assert.ok(m, `${name} is a registry or platform machine`);
      return { machine: name, initial_state: m.initial };
    });
    assert.deepEqual(seeded.rows, expected);
    // every machine with listed edges has its initial state, and every edge starts from a state of that machine
    const orphanEdges = await su.query("SELECT DISTINCT machine FROM kauro.state_transitions t WHERE NOT EXISTS (SELECT 1 FROM kauro.state_machines m WHERE m.machine = t.machine)");
    assert.deepEqual(orphanEdges.rows, []);
    // the birth guard sits on exactly the tables whose state changes are guarded, for the same machine
    const defs = await su.query<{ relname: string; def: string }>(
      `SELECT c.relname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'kauro' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
    );
    const machineOf = (fn: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const d of defs.rows) {
        const m = new RegExp(`EXECUTE FUNCTION kauro\\.${fn}\\('([A-Za-z]+)'\\)`).exec(d.def);
        if (m?.[1]) out.set(d.relname, m[1]);
      }
      return out;
    };
    const edges = machineOf("enforce_listed_transition");
    const births = machineOf("enforce_initial_state");
    for (const d of defs.rows) if (/EXECUTE FUNCTION kauro\.enforce_membership_initial_state\(\)/.test(d.def)) births.set(d.relname, "Membership");
    assert.deepEqual([...births.entries()].sort(), [...edges.entries()].sort());
    for (const d of defs.rows) {
      if (/enforce_initial_state|enforce_membership_initial_state/.test(d.def)) assert.match(d.def, /BEFORE INSERT ON/, d.def);
    }
  } finally {
    await su.end();
  }
});

test("registered event types in the database are exactly the domain EVENT_TYPES", async () => {
  const su = await pg.connect("postgres");
  try {
    const r = await su.query<{ event_type: string }>("SELECT event_type FROM kauro.event_types ORDER BY 1");
    assert.deepEqual(r.rows.map((x) => x.event_type), [...EVENT_TYPES].sort());
  } finally {
    await su.end();
  }
});

test("registered aggregate kinds are exactly the domain AGGREGATE_KINDS, B06's seven with their exact tables and id columns, each bound to the table and id column its event-per-version trigger names", async () => {
  const su = await pg.connect("postgres");
  try {
    const r = await su.query<{ aggregate_kind: string; table_name: string; id_column: string; owner_package: string }>(
      "SELECT aggregate_kind, table_name, id_column, owner_package FROM kauro.aggregate_kinds ORDER BY aggregate_kind",
    );
    assert.deepEqual(r.rows.map((x) => x.aggregate_kind), [...AGGREGATE_KINDS].sort());
    // the kinds, tables and id columns of B06's former CHECK list and CASE arms (0005), owned by B06
    assert.deepEqual(
      r.rows.filter((x) => x.owner_package === "B06").map((x) => [x.aggregate_kind, x.table_name, x.id_column]),
      [
        ["agency", "agencies", "agency_id"],
        ["approval", "approvals", "approval_id"],
        ["dataset_revision", "dataset_revisions", "revision_id"],
        ["end_client", "end_clients", "client_id"],
        ["membership", "memberships", "membership_id"],
        ["plan", "plans", "plan_id"],
        ["project", "projects", "project_id"],
      ],
    );
    // D-EVT-1 over the registry: every registered kind's table carries require_event_for_version(kind, id column), and every such
    // trigger names a registered kind with that table and column — the event-per-version rule and the binding agree on each kind
    const triggers = await su.query<{ table_name: string; def: string }>(
      `SELECT c.relname AS table_name, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'kauro' AND NOT t.tgisinternal AND t.tgfoid = 'kauro.require_event_for_version()'::regprocedure ORDER BY 1`,
    );
    const perVersion = triggers.rows.map((t) => {
      const m = /EXECUTE FUNCTION kauro\.require_event_for_version\('([a-z_]+)', '([a-z_]+)'\)/.exec(t.def);
      assert.ok(m, t.def);
      return [m[1], t.table_name, m[2]];
    });
    assert.deepEqual(perVersion.sort(), r.rows.map((x) => [x.aggregate_kind, x.table_name, x.id_column]).sort());
    // the former CHECK list is gone; a foreign key to the registry stands in its place
    const constraints = await su.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'kauro.domain_events'::regclass AND conname LIKE 'domain_events_aggregate_kind%' ORDER BY 1`,
    );
    assert.deepEqual(constraints.rows, [{ conname: "domain_events_aggregate_kind_fkey", def: "FOREIGN KEY (aggregate_kind) REFERENCES kauro.aggregate_kinds(aggregate_kind)" }]);
  } finally {
    await su.end();
  }
});
