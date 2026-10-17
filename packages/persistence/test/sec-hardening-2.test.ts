// SEC-HARDENING-2 slice A (+ B-LIFETIME-2 BL2-F1/F2), mandate .kauro/mandates/SEC-HARDENING-2.md sections 2-4, real PostgreSQL 17.
// The migration under test is migrations/<N>_sec_hardening_2.sql (N = the next free number at build time, renumbered on rebase):
// - SH2-F1: the one SECURITY DEFINER (kauro.register_bank_payment_route, 0046) is owned by the NOLOGIN kauro_route_registrar, which holds
//   only the privileges the registration needs (R2 08 "minimal owner privileges"), instead of the migrator that owns every kauro table;
// - SH2-F2: neither the migration nor the pool accepts a runtime principal that is also a member of a non-runtime role (R2 08 "Runtime
//   roles are not owners, superusers or BYPASSRLS", 14_CLOUD:57 "only required database roles");
// - SH2-F3: the standing gate on dynamic SQL (R2 08 "Dynamic SQL based on customer input is prohibited");
// - BL2-F1: a recorded audit step's outcome and evidence are fixed (R2 06 :11 "immutable ... evidence", :92 conflicting input);
// - BL2-F2: the event log cannot be truncated, alone or by cascade (template rule 22).
// The release cells apply every migration before it to a fresh cluster, tamper with the cluster as the superuser and apply it.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client } from "pg";
import type { AgencyId, AuditStepId, UserId } from "@kauro/domain";
import { applyMigrations, createPool, listMigrations, MIGRATIONS_DIR, PrivilegedRoleError } from "../src/index.js";
import { PgBankRoutes } from "../src/repositories/bank-routes.js";
import { backendPid, settlesOrWaits } from "../src/testing/harness.js";
import { fundPlatformPool } from "../src/testing/audit-fixtures.js";
import { grantCorporateRole } from "../src/testing/commerce-fixtures.js";
import { controlOf } from "../src/testing/execution-fixtures.js";
import { ROLES, startTemporaryPostgres, testDatabaseEnvironment, type TemporaryPostgres } from "../src/testing/index.js";
import { auditSubject, closeAuditEnv, newAudit, openAuditEnv, type AuditEnv } from "./audit-support.js";
import { causeState } from "./execution-support.js";
import { ids, person, sha, sqlState, tx } from "./support.js";

const REGISTRAR = "kauro_route_registrar";
const DEFINER = "kauro.register_bank_payment_route(uuid,text,text,uuid,text,text)";
const GROUPS = ["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment", "kauro_commission"] as const;

/** The migration under test; every cell asserts it exists first, so a missing file fails each cell clearly instead of the file. */
function target(): { readonly version: number; readonly file: string; readonly path: string } {
  const m = listMigrations().find((x) => x.name === "sec_hardening_2");
  assert.ok(m, "the sec_hardening_2 migration exists");
  return { version: m.version, file: m.file, path: join(MIGRATIONS_DIR, m.file) };
}

let env: AuditEnv;
before(async () => {
  env = await openAuditEnv("sec-hardening-2");
  await fundPlatformPool(env.control, { ceilingCents: 5_000n });
});
after(async () => {
  await closeAuditEnv(env);
});

interface PreMigration {
  readonly pg: TemporaryPostgres;
  readonly su: Client;
  readonly owner: Client;
  readonly dir: string;
  readonly stop: () => Promise<void>;
}

/** A fresh cluster with every migration BEFORE `name` applied, and a directory holding all of them for the final apply. */
async function preMigration(name: string): Promise<PreMigration> {
  const m = listMigrations().find((x) => x.name === name);
  assert.ok(m, `the ${name} migration exists`);
  const pg = await startTemporaryPostgres({ migrate: false, testClock: false });
  const work = mkdtempSync(join(tmpdir(), "kauro-sec-hardening-2-"));
  const earlier = join(work, "before");
  mkdirSync(earlier);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (f.endsWith(".sql") && f < m.file) cpSync(join(MIGRATIONS_DIR, f), join(earlier, f));
  const su = await pg.connect("postgres");
  const owner = await pg.connect("kauro_owner");
  await applyMigrations(owner, { dir: earlier });
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

async function definerOwner(c: Client): Promise<string> {
  return (await c.query<{ o: string }>(`SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid = '${DEFINER}'::regprocedure`)).rows[0]!.o;
}

/** The roles of the two registration policies (0046), as pg_policies prints them. */
async function policyRoles(c: Client): Promise<Array<{ policyname: string; roles: string[] }>> {
  return (await c.query<{ policyname: string; roles: string[] }>(
    "SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE policyname IN ('payment_routes_register_bank', 'corporate_roles_register_bank_read') ORDER BY policyname",
  )).rows;
}

/** The migration is refused with `message` (42501), nothing of it persists: no ledger row, the definer still the migrator's. */
async function refused(p: PreMigration, message: RegExp, label: string): Promise<void> {
  const t = target();
  await assert.rejects(applyMigrations(p.owner, { dir: p.dir }), (e: unknown) => message.test(String((e as Error).message)) && migrationState(e) === "42501", label);
  assert.equal(await ledgerHas(p.owner, t.version), false, `${label}: the failed hardening recorded no ledger row`);
  assert.equal(await definerOwner(p.su), "kauro_owner", `${label}: the definer is still the migrator's`);
}

async function appliedNow(p: PreMigration, label: string): Promise<void> {
  const t = target();
  const again = await applyMigrations(p.owner, { dir: p.dir });
  assert.ok(again.applied.some((f) => f.version === t.version), label);
  assert.equal(await ledgerHas(p.owner, t.version), true, label);
  assert.equal(await definerOwner(p.su), REGISTRAR, label);
}

/** The SQLSTATE of a migration failure (the runner wraps the driver error as its cause). */
const migrationState = (e: unknown): string => sqlState((e as { cause?: unknown }).cause ?? e);

/** Runs `probe` under a savepoint of the caller's open transaction and expects SQLSTATE `code`; the transaction stays usable. */
async function refusedInSavepoint(c: Client, probe: () => Promise<unknown>, code: string, message: string): Promise<void> {
  await c.query("SAVEPOINT probe");
  try {
    await assert.rejects(probe(), (e: unknown) => sqlState(e) === code, message);
  } finally {
    await c.query("ROLLBACK TO SAVEPOINT probe");
  }
}

const REGISTRATION_COLUMNS = ["created_at", "currency", "environment", "integration_class", "merchant_ref", "payee_digest", "provider", "route_id", "state", "updated_at"];

test("SEC-HARDENING-2 catalog (R17, definer owner): the bank-route registrar owns only its function and holds only USAGE on kauro, INSERT of the ten registration columns of payment_routes and SELECT of corporate_roles(user_id, role, state) and state_machines", async () => {
  const o = env.h.oracle;
  assert.equal(await definerOwner(o), REGISTRAR, "the definer is the registrar's");
  const owned = await o.query<{ obj: string }>(
    `SELECT CASE WHEN d.classid = 'pg_proc'::regclass THEN d.objid::regprocedure::text ELSE d.classid::regclass::text || ' ' || d.objid END AS obj
       FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND d.deptype = 'o'`,
    [REGISTRAR],
  );
  assert.deepEqual(owned.rows.map((r) => r.obj), [DEFINER], "the registrar owns exactly its function");
  const shape = await o.query(
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
            ARRAY(SELECT m.roleid::regrole::text FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
            ARRAY(SELECT DISTINCT m.member::regrole::text FROM pg_auth_members m WHERE m.roleid = r.oid ORDER BY 1) AS members
       FROM pg_roles r WHERE r.rolname = $1`,
    [REGISTRAR],
  );
  assert.deepEqual(shape.rows, [{ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, member_of: [], members: ["kauro_owner"] }]);
  const grants = await o.query<{ g: string }>(
    `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
     SELECT g FROM (
       SELECT 'schema ' || n.nspname || ' ' || a.privilege_type AS g FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'table ' || c.oid::regclass::text || ' ' || a.privilege_type FROM pg_class c, LATERAL aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'column ' || t.attrelid::regclass::text || '.' || t.attname || ' ' || a.privilege_type FROM pg_attribute t, LATERAL aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'function ' || p.oid::regprocedure::text || ' ' || a.privilege_type FROM pg_proc p, LATERAL aclexplode(p.proacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'database ' || d.datname || ' ' || a.privilege_type FROM pg_database d, LATERAL aclexplode(d.datacl) a, r WHERE a.grantee = r.oid
     ) x ORDER BY g`,
    [REGISTRAR],
  );
  const expected = [
    ...["role", "state", "user_id"].map((c) => `column kauro.corporate_roles.${c} SELECT`),
    ...REGISTRATION_COLUMNS.map((c) => `column kauro.payment_routes.${c} INSERT`),
    `function ${DEFINER} EXECUTE`, // the owner's own implicit grant, kept by the ACL
    "schema kauro USAGE",
    "table kauro.state_machines SELECT",
  ].sort();
  assert.deepEqual(grants.rows.map((r) => r.g), expected);
  for (const privilege of ["UPDATE", "DELETE", "TRUNCATE", "INSERT"]) {
    assert.equal((await o.query("SELECT has_table_privilege($1, 'kauro.payment_routes', $2) AS p", [REGISTRAR, privilege])).rows[0].p, false, `no table-wide ${privilege}`);
  }
  assert.equal((await o.query("SELECT has_schema_privilege($1, 'kauro', 'CREATE') AS p", [REGISTRAR])).rows[0].p, false, "CREATE on kauro was only lent for the ownership transfer");
});

test("OK SEC-HARDENING-2 (configure): an active corporate owner registers a CONFIGURED bank payment route through the registrar-owned function, and a registrar session cannot update, delete or insert another state", async () => {
  const { h } = env;
  const app = await h.pg.connect("kauro_app_test");
  const owner = await h.pg.connect("kauro_owner");
  try {
    const ownerUser = await h.person("sh2-route-owner");
    await h.grantKauroOwner(ownerUser);
    const stranger = await h.person("sh2-route-stranger");
    const paymentRouteId = ids.next();
    await tx(app, { userId: ownerUser }, (c) => new PgBankRoutes(c).registerPaymentRoute({ paymentRouteId, provider: "contract-fake-bank", environment: "SANDBOX", merchantRef: ids.next(), payeeDigest: sha(`payee-${paymentRouteId}`), integrationClass: "CONTRACT_FAKE" }));
    const row = await h.oracle.query("SELECT state, integration_class FROM kauro.payment_routes WHERE route_id = $1", [paymentRouteId]);
    assert.deepEqual(row.rows, [{ state: "CONFIGURED", integration_class: "CONTRACT_FAKE" }]);
    // the narrowed read: under the registrar, the caller's own grant is visible and nobody else's
    await owner.query("BEGIN");
    try {
      await owner.query(`SET LOCAL ROLE ${REGISTRAR}`);
      await owner.query("SELECT set_config('kauro.user_id', $1, true)", [stranger]);
      assert.equal((await owner.query("SELECT 1 FROM kauro.corporate_roles")).rowCount, 0, "a stranger's session sees no corporate grant");
      await owner.query("SELECT set_config('kauro.user_id', $1, true)", [ownerUser]);
      assert.equal((await owner.query("SELECT 1 FROM kauro.corporate_roles WHERE role = 'KAURO_OWNER' AND state = 'ACTIVE'")).rowCount, 1, "the caller sees its own grant");
      const insert = (state: string, extra = "") =>
        owner.query(
          `INSERT INTO kauro.payment_routes (route_id, provider, environment, merchant_ref, payee_digest, currency, integration_class, state, created_at, updated_at${extra ? ", " + extra : ""}) VALUES ($1, 'contract-fake-bank', 'SANDBOX', $1, $2, 'USD', 'CONTRACT_FAKE', $3, now(), now()${extra ? ", '[]'::jsonb" : ""})`,
          [ids.next(), sha("sh2-direct"), state],
        );
      await refusedInSavepoint(owner, () => owner.query("UPDATE kauro.payment_routes SET state = 'ENABLED' WHERE route_id = $1", [paymentRouteId]), "42501", "UPDATE");
      await refusedInSavepoint(owner, () => owner.query("DELETE FROM kauro.payment_routes WHERE route_id = $1", [paymentRouteId]), "42501", "DELETE");
      // another state: the BEFORE INSERT trigger (enforce_initial_state, which the registrar's SELECT on state_machines lets run) refuses
      // it before row security's WITH CHECK is evaluated, so the refusal is the machine's KA008
      await refusedInSavepoint(owner, () => insert("QUALIFIED"), "KA008", "INSERT of another state");
      await refusedInSavepoint(owner, () => insert("CONFIGURED", "qualification_evidence_hashes"), "42501", "INSERT naming a column outside the ten");
      await refusedInSavepoint(owner, () => owner.query("SELECT 1 FROM kauro.bank_routes"), "42501", "no other table");
    } finally {
      await owner.query("ROLLBACK");
    }
  } finally {
    await app.end();
    await owner.end();
  }
});

test("RACE SEC-HARDENING-2 (release): a registration that reaches payment_routes while the hardening migration holds its policy lock waits and commits a CONFIGURED row after the migration", async () => {
  const t = target();
  const p = await preMigration("sec_hardening_2");
  const app = await (async () => {
    await p.su.query(`CREATE ROLE ${ROLES.appLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}`);
    await p.su.query(`CREATE ROLE ${ROLES.controlLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.control}`);
    return p.pg.connect("kauro_app_test");
  })();
  const control = await p.pg.connect("kauro_control_test");
  try {
    const { userId } = await person(app, "sh2-race-owner");
    await grantCorporateRole(control, userId as UserId);
    const pid = await backendPid(app);
    // M: the hardening file in an open transaction (what the runner does before its ledger row and COMMIT)
    await p.owner.query("BEGIN");
    await p.owner.query(readFileSync(t.path, "utf8"));
    // R: the registration through the repository, under the caller's own context
    const paymentRouteId = ids.next();
    const registration = tx(app, { userId }, async (c) => {
      await new PgBankRoutes(c).registerPaymentRoute({ paymentRouteId, provider: "contract-fake-bank", environment: "SANDBOX", merchantRef: ids.next(), payeeDigest: sha(`payee-${paymentRouteId}`), integrationClass: "CONTRACT_FAKE" });
      return paymentRouteId;
    });
    const seen = await settlesOrWaits(p.su, pid, registration, "the registration during the hardening");
    if (seen.kind === "SETTLED") await p.owner.query("ROLLBACK");
    assert.equal(seen.kind, "WAITING", "the registration waits for the hardening's policy lock");
    const waitedOn = await p.su.query<{ rel: string }>("SELECT relation::regclass::text AS rel FROM pg_locks WHERE pid = $1 AND NOT granted AND relation IS NOT NULL", [pid]);
    assert.ok(waitedOn.rows.every((r) => ["kauro.payment_routes", "kauro.corporate_roles"].includes(r.rel)) && waitedOn.rows.length > 0, `waits on a registration table (${JSON.stringify(waitedOn.rows)})`);
    await p.owner.query("COMMIT");
    if (seen.kind !== "WAITING") return;
    const outcome = await seen.pending;
    assert.equal(outcome.status === "fulfilled" ? outcome.value : `rejected ${causeState(outcome.reason)} ${String((outcome.reason as Error)?.message)}`, paymentRouteId, "the registration commits after the migration");
    const row = await p.su.query("SELECT state FROM kauro.payment_routes WHERE route_id = $1", [paymentRouteId]);
    assert.deepEqual(row.rows, [{ state: "CONFIGURED" }]);
    assert.equal(await definerOwner(p.su), REGISTRAR);
  } finally {
    await app.end();
    await control.end();
    await p.stop();
  }
});

test("TIMEOUT SEC-HARDENING-2 (release): a reader holding payment_routes makes the hardening fail at its lock timeout with no ledger row and the function still owned by the migrator", async () => {
  const t = target();
  const p = await preMigration("sec_hardening_2");
  try {
    await p.su.query("BEGIN");
    await p.su.query("SELECT 1 FROM kauro.payment_routes LIMIT 1");
    try {
      await assert.rejects(applyMigrations(p.owner, { dir: p.dir, lockTimeoutMs: 500 }), (e: unknown) => migrationState(e) === "55P03", "the hardening stops at its lock timeout");
    } finally {
      await p.su.query("ROLLBACK");
    }
    assert.equal(await ledgerHas(p.owner, t.version), false, "no ledger row");
    assert.equal(await definerOwner(p.su), "kauro_owner", "the ownership transfer rolled back with the file");
    assert.deepEqual(await policyRoles(p.su), [{ policyname: "corporate_roles_register_bank_read", roles: ["kauro_owner"] }, { policyname: "payment_routes_register_bank", roles: ["kauro_owner"] }]);
    await appliedNow(p, "released, the rerun applies");
  } finally {
    await p.stop();
  }
});

test("DENY SEC-HARDENING-2 (release): a failing membership check rolls the whole hardening back, leaving the definer, its policies and the ledger as before", async () => {
  const p = await preMigration("sec_hardening_2");
  try {
    await p.su.query(`CREATE ROLE ${ROLES.appLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}`);
    // a runtime login (not the group: granting kauro_owner to kauro_app is circular, 0LP01, since the migrator created the group)
    await p.su.query(`GRANT kauro_owner TO ${ROLES.appLogin}`);
    await refused(p, /is a member of non-runtime role kauro_owner/, "a runtime login in the migrator's role");
    assert.deepEqual(await policyRoles(p.su), [{ policyname: "corporate_roles_register_bank_read", roles: ["kauro_owner"] }, { policyname: "payment_routes_register_bank", roles: ["kauro_owner"] }], "the policies are as before");
    assert.equal((await p.su.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [REGISTRAR])).rowCount, 0, "the registrar role rolled back too");
    await p.su.query(`REVOKE kauro_owner FROM ${ROLES.appLogin}`);
    await appliedNow(p, "repaired, the rerun applies");
  } finally {
    await p.stop();
  }
});

test("DENY SEC-HARDENING-2 (release): a pre-existing kauro_route_registrar that can log in or has other members stops the hardening", async () => {
  const p = await preMigration("sec_hardening_2");
  try {
    // each wrong shape is otherwise usable (the migrator already its INHERIT+SET member), so only the shape check stops it
    await p.su.query(`CREATE ROLE ${REGISTRAR} LOGIN`);
    await p.su.query(`GRANT ${REGISTRAR} TO kauro_owner WITH INHERIT TRUE, SET TRUE`);
    await refused(p, /has shape login=t/, "a registrar that can log in");
    await p.su.query(`DROP ROLE ${REGISTRAR}`);
    await p.su.query(`CREATE ROLE ${REGISTRAR} NOLOGIN NOINHERIT`);
    await p.su.query(`GRANT ${REGISTRAR} TO kauro_owner WITH INHERIT TRUE, SET TRUE`);
    await p.su.query(`GRANT ${REGISTRAR} TO kauro_app`);
    await refused(p, /has shape/, "a registrar with a runtime member");
    await p.su.query(`DROP ROLE ${REGISTRAR}`);
    // the production shape (RDS, B14): a migrator without CREATEROLE and no pre-created registrar stops with a clear message
    await p.su.query("ALTER ROLE kauro_owner NOCREATEROLE");
    await refused(p, /does not exist and kauro_owner cannot create it/, "a migrator without CREATEROLE and no pre-created registrar");
    // ... and with the registrar pre-created in exactly the B14 shape (NOLOGIN, the migrator its only INHERIT+SET member) it applies
    await p.su.query(`CREATE ROLE ${REGISTRAR} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT`);
    await p.su.query(`GRANT ${REGISTRAR} TO kauro_owner WITH INHERIT TRUE, SET TRUE`);
    // ... and the runtime group created after the hardening (0088's kauro_outreach) is pre-created as B14 provisions every runtime group:
    // 0088 creates it only when missing, and a migrator without CREATEROLE cannot
    await p.su.query("CREATE ROLE kauro_outreach NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION");
    await appliedNow(p, "the B14 pre-created registrar and kauro_outreach, migrator without CREATEROLE");
  } finally {
    await p.stop();
  }
});

test("DENY SEC-HARDENING-2 (release): the hardening fails when a runtime group or login is a member of a superuser, BYPASSRLS or other non-runtime role", async () => {
  const p = await preMigration("sec_hardening_2");
  try {
    await p.su.query(`CREATE ROLE ${ROLES.appLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}`);
    const variants: ReadonlyArray<readonly [create: string, member: string, role: string]> = [
      ["CREATE ROLE sh2_su SUPERUSER NOLOGIN", "kauro_control", "sh2_su"],
      ["CREATE ROLE sh2_bypass BYPASSRLS NOLOGIN", ROLES.appLogin, "sh2_bypass"],
      ["CREATE ROLE sh2_plain NOLOGIN", ROLES.appLogin, "sh2_plain"],
    ];
    for (const [create, member, role] of variants) {
      await p.su.query(create);
      await p.su.query(`GRANT ${role} TO ${member}`);
      await refused(p, new RegExp(`runtime role ${member} is a member of non-runtime role ${role}`), `${member} in ${role}`);
      await p.su.query(`DROP ROLE ${role}`);
    }
    await appliedNow(p, "repaired, the rerun applies");
  } finally {
    await p.stop();
  }
});

test("DENY SEC-HARDENING-2 (pool): the pool refuses a runtime login that is also a member of a non-runtime role or owns a database object", async () => {
  const { h } = env;
  const fresh = (user: string) => createPool({ environment: testDatabaseEnvironment("LOCAL"), host: "127.0.0.1", port: h.pg.port, database: ROLES.database, user, max: 1, applicationName: "kauro-test-sec-hardening-2-pool" });
  const refusedBy = async (user: string, what: string): Promise<void> => {
    const pool = fresh(user);
    try {
      // an accepted connection is released before the assertion fails, so pool.end() never waits on it
      const outcome = await pool.acquire().then((v) => { v.client.release(); return null; }, (e: unknown) => e);
      assert.ok(outcome instanceof PrivilegedRoleError && outcome.message.includes(what), `${user}: ${what} (got ${outcome === null ? "an accepted connection" : String(outcome)})`);
      assert.equal(pool.totalCount, 0, `${user}: the connection was destroyed, not pooled`);
    } finally {
      await pool.end();
    }
  };
  await h.oracle.query("CREATE ROLE sh2_dual LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE kauro_app");
  try {
    await h.oracle.query(`GRANT ${REGISTRAR} TO sh2_dual`);
    await refusedBy("sh2_dual", `a member of a non-runtime role (${REGISTRAR})`);
  } finally {
    await h.oracle.query("DROP ROLE sh2_dual");
  }
  await h.oracle.query("CREATE ROLE sh2_owner LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE kauro_control");
  try {
    await h.oracle.query("CREATE TABLE public.sh2_owned (x int)");
    await h.oracle.query("ALTER TABLE public.sh2_owned OWNER TO sh2_owner");
    await refusedBy("sh2_owner", "the owner of a database object");
  } finally {
    await h.oracle.query("DROP TABLE IF EXISTS public.sh2_owned");
    await h.oracle.query("DROP ROLE sh2_owner");
  }
  const { client, connection } = await h.controlPool.acquire();
  try {
    assert.equal(connection.role, "kauro_control", "a control login in one group verifies");
  } finally {
    client.release();
  }
});

const DYNAMIC_SQL = `
SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
 WHERE n.nspname IN ('kauro', 'kauro_meta', 'public') AND l.lanname = 'plpgsql' AND p.prosrc ~* '(^|[^a-z_])execute\\s'
 ORDER BY 1`;

test("SEC-HARDENING-2 catalog (R17, dynamic SQL): only the registry-driven aggregate binder and the allowlisted commission row lock run dynamic SQL in kauro, kauro_meta and public", async () => {
  const o = env.h.oracle;
  const names = async () => (await o.query<{ sig: string }>(DYNAMIC_SQL)).rows.map((r) => r.sig.replace(/\(.*$/, ""));
  assert.deepEqual(await names(), ["kauro.commission_lock_line_rows", "kauro.domain_events_bind_aggregate"]);
  // non-vacuity (rule 14): a new dynamic function is seen by the same query
  await o.query("CREATE FUNCTION kauro.sh2_probe() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; END $$");
  try {
    assert.deepEqual(await names(), ["kauro.commission_lock_line_rows", "kauro.domain_events_bind_aggregate", "kauro.sh2_probe"]);
  } finally {
    await o.query("DROP FUNCTION kauro.sh2_probe()");
  }
});

// --- B-LIFETIME-2: a recorded audit step ------------------------------------------------------------------------------------------------

/** The statement of PgAuditStore.recordStep (store.ts), on a control-plane connection bound to the agency. */
const RECORD = "UPDATE kauro.audit_steps SET outcome = $2, evidence_hash = $3, evidence_class = $4 WHERE step_id = $1";

/** The agency of each claimed step (one live audit per agency: each step gets an agency of its own). */
const agencyOfStep = new Map<string, string>();
const stepControl = (stepId: string) => controlOf(agencyOfStep.get(stepId)!);

/** A fresh agency's audit with its PROFILE step claimed (PROFILING), nothing recorded. */
async function claimedProfileStep(seed: string): Promise<AuditStepId> {
  const { h } = env;
  const A = await h.createAgency(await h.person(`${seed}-owner`), `${seed} agency`);
  (env.clients as Map<string, string>).set(A.agencyId, await h.endClient(A, await h.processingAuthority(A), `${seed} client`));
  const input = newAudit(A, await auditSubject(env, A, seed));
  await h.audit.run(h.tenant(A.agencyId as AgencyId, A.ownerUserId as UserId), (uow) => uow.audits.startAudit(input));
  const claim = await h.audit.run(controlOf(A.agencyId), (uow) => uow.audits.claimStep(input.auditId, "PROFILE", ids.next() as AuditStepId));
  agencyOfStep.set(claim.step.stepId, A.agencyId);
  return claim.step.stepId;
}

async function stepRow(stepId: string): Promise<{ outcome: string | null; evidence_hash: string | null; evidence_class: string | null; recorded_at: Date | null }> {
  return (await env.h.oracle.query("SELECT outcome, evidence_hash, evidence_class, recorded_at FROM kauro.audit_steps WHERE step_id = $1", [stepId])).rows[0];
}

test("OK B-LIFETIME-2 (audit step record): an exact replay of a recorded step's outcome and evidence changes nothing", async () => {
  const { h } = env;
  const stepId = await claimedProfileStep("sh2-replay");
  const result = { outcome: "COMPLETED", evidenceHash: sha("sh2-replay-evidence"), evidenceClass: "SIMULATED" } as const;
  const first = await h.audit.run(stepControl(stepId), (uow) => uow.audits.recordStep(stepId, result));
  const before_ = await stepRow(stepId);
  const replay = await h.audit.run(stepControl(stepId), (uow) => uow.audits.recordStep(stepId, result));
  assert.deepEqual([replay.outcome, replay.evidenceHash, replay.evidenceClass, replay.recordedAt], [first.outcome, first.evidenceHash, first.evidenceClass, first.recordedAt]);
  assert.deepEqual(await stepRow(stepId), before_, "recorded_at and the evidence are unchanged");
});

test("RACE B-LIFETIME-2 (audit step record): a second record waiting on the step's row lock is refused KA004 when its evidence differs from the committed record", async () => {
  const { h } = env;
  const stepId = await claimedProfileStep("sh2-race");
  const a = await h.pg.connect("kauro_control_test");
  const b = await h.pg.connect("kauro_control_test");
  try {
    await a.query("BEGIN");
    await a.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', '', true)", [agencyOfStep.get(stepId)]);
    assert.equal((await a.query(RECORD, [stepId, "COMPLETED", null, "SIMULATED"])).rowCount, 1, "A records (COMPLETED, no hash)");
    const pidB = await backendPid(b);
    const second = tx(b, { agencyId: agencyOfStep.get(stepId)! }, (c) => c.query(RECORD, [stepId, "COMPLETED", sha("sh2-race-late"), "SIMULATED"]));
    const seen = await settlesOrWaits(h.oracle, pidB, second, "the second record");
    if (seen.kind === "SETTLED") await a.query("ROLLBACK");
    assert.equal(seen.kind, "WAITING", "B waits on A's row lock");
    const waits = await h.oracle.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted", [pidB]);
    assert.ok((waits.rowCount ?? 0) > 0, "B's lock request is ungranted in pg_locks");
    await a.query("COMMIT");
    const recordedA = await stepRow(stepId);
    if (seen.kind !== "WAITING") return;
    const outcome = await seen.pending;
    assert.equal(outcome.status === "rejected" ? sqlState(outcome.reason) : "resolved", "KA004", "B is refused once A's record is committed");
    const row = await stepRow(stepId);
    assert.equal(row.evidence_hash, null, "the committed record keeps no hash");
    assert.deepEqual(row.recorded_at, recordedA.recorded_at, "recorded_at is A's");
  } finally {
    await a.end();
    await b.end();
  }
});

test("DENY B-LIFETIME-2 (audit step record): after a step is recorded no update attaches, changes or clears its evidence hash, outcome or class (KA004), and recorded_at stays put", async () => {
  const { h } = env;
  const direct = (stepId: string, set: string, params: unknown[] = []) => tx(env.control, { agencyId: agencyOfStep.get(stepId)! }, (c) => c.query(`UPDATE kauro.audit_steps SET ${set} WHERE step_id = $1`, [stepId, ...params]));
  // recorded without a hash: attaching one later is refused
  const bare = await claimedProfileStep("sh2-deny-bare");
  await h.audit.run(stepControl(bare), (uow) => uow.audits.recordStep(bare, { outcome: "COMPLETED", evidenceHash: null, evidenceClass: "SIMULATED" }));
  const bareRow = await stepRow(bare);
  await assert.rejects(direct(bare, "evidence_hash = $2", [sha("sh2-late")]), (e: unknown) => sqlState(e) === "KA004", "NULL -> H");
  assert.deepEqual(await stepRow(bare), bareRow, "nothing moved");
  // recorded with a hash: changing it, the outcome or the class is refused, and so is clearing the class
  const hashed = await claimedProfileStep("sh2-deny-hashed");
  await h.audit.run(stepControl(hashed), (uow) => uow.audits.recordStep(hashed, { outcome: "COMPLETED", evidenceHash: sha("sh2-h1"), evidenceClass: "SIMULATED" }));
  const hashedRow = await stepRow(hashed);
  for (const [set, params, label] of [
    ["evidence_hash = $2", [sha("sh2-h2")], "H -> H2"],
    ["evidence_hash = NULL", [], "H -> NULL"],
    ["outcome = 'FAILED'", [], "another outcome"],
    ["evidence_class = 'EXECUTED_LOCAL'", [], "another class"],
    ["evidence_class = NULL", [], "clearing the class"],
  ] as const) {
    await assert.rejects(direct(hashed, set, [...params]), (e: unknown) => sqlState(e) === "KA004", label);
    assert.deepEqual(await stepRow(hashed), hashedRow, `${label}: nothing moved`);
  }
});

test("DENY B-LIFETIME-2 (domain_events): no session, the superuser included, truncates the event log, alone or by cascade (KA004)", async () => {
  const su = env.h.oracle;
  const counts = async () =>
    (await su.query<{ e: number; o: number; i: number; l: number }>(
      "SELECT (SELECT count(*)::int FROM kauro.domain_events) AS e, (SELECT count(*)::int FROM kauro.outbox_records) AS o, (SELECT count(*)::int FROM kauro.inbox_records) AS i, (SELECT count(*)::int FROM kauro.ledger_entries) AS l",
    )).rows[0]!;
  const before_ = await counts();
  assert.ok(before_.e > 0 && before_.o > 0, `the cluster holds events and outbox records (${JSON.stringify(before_)})`);
  // the tables a cascade reaches: every table with a foreign key to the event log, the outbox, inbox and ledger among them
  const referencing = (await su.query<{ t: string }>("SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'kauro.domain_events'::regclass ORDER BY 1")).rows.map((r) => r.t);
  for (const t of ["kauro.outbox_records", "kauro.inbox_records", "kauro.ledger_entries"]) assert.ok(referencing.includes(t), `${t} references the event log (${referencing.join(", ")})`);
  await su.query("BEGIN");
  try {
    // alone, the foreign keys refuse it before any trigger (0A000, as for aggregate_kinds); by cascade, the guard does (KA004)
    await refusedInSavepoint(su, () => su.query("TRUNCATE kauro.domain_events"), "0A000", "superuser TRUNCATE");
    await refusedInSavepoint(su, () => su.query("TRUNCATE kauro.domain_events CASCADE"), "KA004", "superuser TRUNCATE CASCADE");
    await refusedInSavepoint(su, () => su.query("TRUNCATE kauro.outbox_records, kauro.domain_events CASCADE"), "KA004", "superuser TRUNCATE naming the outbox and the log");
  } finally {
    await su.query("ROLLBACK");
  }
  assert.deepEqual(await counts(), before_, "every count is unchanged");
});
