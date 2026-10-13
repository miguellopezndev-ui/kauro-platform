// SEC-DEPTH-PROVENANCE section C, file R (rows R1 hardening A and R2 P2 boundary), real PostgreSQL 17. The migration under test is
// the one the design calls 0050 (runtime hardening); on this branch it is migrations/0060_runtime_hardening.sql (provisional number).
// The release titles apply the migrations before it to a fresh cluster, tamper with the cluster as the superuser, and apply it.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import { applyMigrations, listMigrations, MIGRATIONS_DIR, PrivilegedRoleError, createPool } from "../src/index.js";
import { start, type Harness } from "../src/testing/harness.js";
import { ROLES, startTemporaryPostgres, testDatabaseEnvironment, type TemporaryPostgres } from "../src/testing/index.js";
import { causeState } from "./execution-support.js";

const HARDENING = listMigrations().find((m) => m.name === "runtime_hardening");
assert.ok(HARDENING, "the hardening migration exists");

let h: Harness;
before(async () => { h = await start(); });
after(async () => { await h.stop(); });

const GROUPS = ["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment", "kauro_commission"] as const;

interface PreHardening {
  readonly pg: TemporaryPostgres;
  readonly su: Client;
  readonly owner: Client;
  readonly dir: string;
  readonly stop: () => Promise<void>;
}

/** A fresh cluster with every migration BEFORE the hardening applied, and a directory holding all of them for the final apply. */
async function preHardening(): Promise<PreHardening> {
  const pg = await startTemporaryPostgres({ migrate: false, testClock: false });
  const work = mkdtempSync(join(tmpdir(), "kauro-sec-depth-root-"));
  const before = join(work, "before");
  mkdirSync(before);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith(".sql") && f < HARDENING!.file) cpSync(join(MIGRATIONS_DIR, f), join(before, f));
  const su = await pg.connect("postgres");
  const owner = await pg.connect("kauro_owner");
  await applyMigrations(owner, { dir: before });
  return {
    pg, su, owner, dir: MIGRATIONS_DIR,
    stop: async () => {
      await owner.end();
      await su.end();
      await pg.stop();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

async function ledgerHas(c: Client, version: number): Promise<boolean> {
  return (await c.query("SELECT 1 FROM kauro_meta.schema_migrations WHERE version = $1", [version])).rowCount === 1;
}

/** The hardening is refused with `message`, nothing of it persists (no ledger row), and after `repair` it applies and records its row. */
async function refusedThenRepaired(p: PreHardening, message: RegExp, repair: () => Promise<void>): Promise<void> {
  await assert.rejects(applyMigrations(p.owner, { dir: p.dir }), (e: unknown) => message.test(String((e as Error).message)) && /42501|SEC-DEPTH/.test(String((e as { code?: string }).code) + String((e as Error).message)));
  assert.equal(await ledgerHas(p.owner, HARDENING!.version), false, "the failed hardening recorded no ledger row");
  await repair();
  const again = await applyMigrations(p.owner, { dir: p.dir });
  assert.ok(again.applied.some((f) => f.version === HARDENING!.version));
  assert.equal(await ledgerHas(p.owner, HARDENING!.version), true);
}

test("DENY SEC-DEPTH (release): 0050 records no ledger row when its revokes leave TEMPORARY to a runtime group", async () => {
  const p = await preHardening();
  try {
    // a role that keeps TEMPORARY by inheritance: revoking from PUBLIC and from the group leaves it
    await p.su.query("CREATE ROLE temp_holder NOLOGIN");
    await p.su.query(`GRANT TEMPORARY ON DATABASE ${ROLES.database} TO temp_holder`);
    await p.su.query("GRANT temp_holder TO kauro_app");
    await refusedThenRepaired(p, /still holds a database privilege \(.*kauro_app TEMPORARY/, async () => {
      await p.su.query("REVOKE temp_holder FROM kauro_app");
    });
    // after the hardening: neither PUBLIC nor any group or login holds TEMPORARY or CREATE on the database
    const holders = await p.su.query<{ rolname: string; priv: string }>(
      `SELECT r.rolname, k.priv FROM pg_roles r CROSS JOIN (VALUES ('TEMPORARY'), ('CREATE')) k(priv)
        WHERE NOT r.rolsuper AND r.rolname !~ '^(pg_|kauro_owner$|temp_holder$)' AND has_database_privilege(r.oid, current_database(), k.priv)`,
    );
    assert.deepEqual(holders.rows, []);
    const publicRights = await p.su.query("SELECT a.privilege_type FROM pg_database d, aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND a.grantee = 0 ORDER BY 1");
    assert.deepEqual(publicRights.rows.map((r) => r.privilege_type), ["CONNECT"], "PUBLIC keeps CONNECT only");
  } finally {
    await p.stop();
  }
});

test("DENY SEC-DEPTH (release): 0050 fails when a runtime group, login or PUBLIC holds SET on session_replication_role, owns a kauro object or can execute a definer in kauro, kauro_meta or public", async () => {
  // SET on session_replication_role: to a group, to a login of a group, to PUBLIC (each granted by the superuser, so the migrator cannot revoke it)
  for (const grantee of ["kauro_control", "sec_depth_login", "PUBLIC"]) {
    const p = await preHardening();
    try {
      await p.su.query("CREATE ROLE sec_depth_login LOGIN IN ROLE kauro_app");
      await p.su.query(`GRANT SET ON PARAMETER session_replication_role TO ${grantee}`);
      await refusedThenRepaired(p, /SET on session_replication_role is held by/, async () => {
        await p.su.query(`REVOKE SET ON PARAMETER session_replication_role FROM ${grantee}`);
      });
    } finally {
      await p.stop();
    }
  }
  // a runtime group (or a login of one) owns a kauro object
  {
    const p = await preHardening();
    try {
      await p.su.query("CREATE TABLE kauro.sec_depth_owned (x int)");
      await p.su.query("ALTER TABLE kauro.sec_depth_owned OWNER TO kauro_payment");
      await refusedThenRepaired(p, /owns a kauro object \(kauro_payment owns relation sec_depth_owned/, async () => {
        await p.su.query("DROP TABLE kauro.sec_depth_owned");
      });
    } finally {
      await p.stop();
    }
  }
  // a definer a runtime principal can execute: through PUBLIC in public, through a grant to a group in kauro and in kauro_meta
  for (const [schema, grant] of [["public", ""], ["kauro", "GRANT EXECUTE ON FUNCTION kauro.sec_depth_hole() TO kauro_ingress"], ["kauro_meta", "GRANT EXECUTE ON FUNCTION kauro_meta.sec_depth_hole() TO kauro_validator"]] as const) {
    const p = await preHardening();
    try {
      await p.su.query(`CREATE FUNCTION ${schema}.sec_depth_hole() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      if (grant === "") await p.su.query(`GRANT EXECUTE ON FUNCTION ${schema}.sec_depth_hole() TO PUBLIC`);
      else {
        await p.su.query(`REVOKE EXECUTE ON FUNCTION ${schema}.sec_depth_hole() FROM PUBLIC`);
        await p.su.query(grant);
      }
      await refusedThenRepaired(p, new RegExp(`can execute a SECURITY DEFINER routine \\((${schema}\\.)?sec_depth_hole\\(\\) to `), async () => {
        await p.su.query(`DROP FUNCTION ${schema}.sec_depth_hole()`);
      });
    } finally {
      await p.stop();
    }
  }
  // the one justified exception stays executable by kauro_app (0046) and does not fail the hardening: the main cluster applied it
  const exception = await h.oracle.query("SELECT has_function_privilege('kauro_app', 'kauro.register_bank_payment_route(uuid, text, text, uuid, text, text)', 'EXECUTE') AS e");
  assert.equal(exception.rows[0].e, true);
});

test("DENY SEC-DEPTH: a pooled runtime login cannot create a temporary table or a pg_temp function (42501)", async () => {
  for (const pool of [h.appPool, h.controlPool]) {
    const { client, connection } = await pool.acquire();
    try {
      for (const statement of ["CREATE TEMP TABLE sec_depth_t (x int)", "CREATE FUNCTION pg_temp.sec_depth_f() RETURNS int LANGUAGE sql AS 'SELECT 1'"]) {
        await assert.rejects(client.query(statement), (e: unknown) => causeState(e) === "42501", `${connection.role}: ${statement}`);
      }
    } finally {
      client.release();
    }
  }
});

test("DENY SEC-DEPTH: a runtime login cannot SET LOCAL session_replication_role = replica (42501)", async () => {
  for (const pool of [h.appPool, h.controlPool]) {
    const { client, connection } = await pool.acquire();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query("SET LOCAL session_replication_role = replica"), (e: unknown) => causeState(e) === "42501", connection.role);
      await client.query("ROLLBACK");
      assert.equal((await client.query("SELECT current_setting('session_replication_role') AS r")).rows[0].r, "origin");
    } finally {
      client.release();
    }
  }
});

test("DENY SEC-DEPTH: the pool refuses a login with TEMPORARY, schema CREATE or a non-origin session_replication_role", async () => {
  const login = ROLES.appLogin;
  const fresh = () => createPool({ environment: testDatabaseEnvironment("LOCAL"), host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user: login, max: 1, applicationName: "kauro-test-sec-depth-pool" });
  const refused = async (what: RegExp, label: string): Promise<void> => {
    const pool = fresh();
    try {
      await assert.rejects(pool.acquire(), (e: unknown) => e instanceof PrivilegedRoleError && what.test(e.message), label);
      assert.equal(pool.totalCount, 0, `${label}: the connection was destroyed, not pooled`);
    } finally {
      await pool.end();
    }
  };
  const accepted = async (label: string): Promise<void> => {
    const pool = fresh();
    try {
      const { client, connection } = await pool.acquire();
      assert.equal(connection.role, "kauro_app", label);
      client.release();
    } finally {
      await pool.end();
    }
  };
  await accepted("baseline: the login as the migrations leave it");
  await h.oracle.query(`GRANT TEMPORARY ON DATABASE ${ROLES.database} TO ${login}`);
  try { await refused(/granted TEMPORARY on the database/, "TEMPORARY"); } finally { await h.oracle.query(`REVOKE TEMPORARY ON DATABASE ${ROLES.database} FROM ${login}`); }
  await h.oracle.query(`GRANT CREATE ON DATABASE ${ROLES.database} TO ${login}`);
  try { await refused(/granted CREATE on the database/, "database CREATE"); } finally { await h.oracle.query(`REVOKE CREATE ON DATABASE ${ROLES.database} FROM ${login}`); }
  await h.oracle.query("CREATE SCHEMA sec_depth_pool_probe");
  await h.oracle.query(`GRANT CREATE ON SCHEMA sec_depth_pool_probe TO ${login}`);
  try { await refused(/granted CREATE on a schema/, "schema CREATE"); } finally { await h.oracle.query("DROP SCHEMA sec_depth_pool_probe"); }
  await h.oracle.query(`ALTER ROLE ${login} SET session_replication_role = replica`);
  try { await refused(/session_replication_role = replica/, "replica mode"); } finally { await h.oracle.query(`ALTER ROLE ${login} RESET session_replication_role`); }
  await accepted("after every repair the login is accepted again");
});

test("OK SEC-DEPTH: every runtime group is covered by the hardening and each pool of the harness verifies", async () => {
  for (const group of GROUPS) {
    const r = await h.oracle.query("SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS t, has_database_privilege($1, current_database(), 'CREATE') AS c", [group]);
    assert.deepEqual(r.rows[0], { t: false, c: false }, group);
  }
});
