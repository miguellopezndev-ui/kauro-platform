// Schema compatibility for readiness (14 "Monitoring and service health": readiness checks the minimum dependencies and the
// schema compatibility the service's role needs; 14 "Deployment and rollback": schema compatibility is verified before
// traffic shifts; review finding R42). The runtime roles read the migration ledger — and only read it — over a verified
// pooled connection, and the ledger is compared with the migrations the code ships by version and checksum. Real
// PostgreSQL 17; the ledger is edited by the superuser oracle and restored.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { compareSchema, createPool, listMigrations, readSchemaLedger } from "../src/index.js";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres } from "../src/testing/index.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres();
});
after(async () => {
  await pg.stop();
});

test("R42: the runtime roles read the ledger (and cannot write it); compared with the shipped migrations it is COMPATIBLE, DRIFTED on a changed checksum, BEHIND on a missing version, and tolerates a newer expand migration", async () => {
  const shipped = listMigrations();
  const last = shipped.at(-1);
  assert.ok(last);
  const pools = [
    createPool({ host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.appLogin, max: 1, applicationName: "kauro-readiness-app" }),
    createPool({ host: "127.0.0.1", port: pg.port, database: ROLES.database, user: ROLES.controlLogin, max: 1, applicationName: "kauro-readiness-control" }),
  ];
  const oracle = await pg.connect("postgres");
  try {
    for (const pool of pools) {
      const ledger = await readSchemaLedger(pool, 2_000);
      assert.deepEqual(ledger, shipped.map((f) => ({ version: f.version, checksum: f.checksum })), pool.config.user);
      assert.deepEqual(compareSchema(ledger, shipped), { kind: "COMPATIBLE", codeVersion: last.version, databaseVersion: last.version });
      // read only: the runtime roles cannot record, alter or erase a migration
      const { client } = await pool.acquire();
      try {
        for (const statement of [
          "INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES (99, 'forged', repeat('0', 64))",
          "UPDATE kauro_meta.schema_migrations SET checksum = repeat('0', 64)",
          "DELETE FROM kauro_meta.schema_migrations",
        ]) {
          await assert.rejects(client.query(statement), (e: unknown) => (e as { code?: string }).code === "42501", statement);
        }
      } finally {
        client.release();
      }
    }
    const app = pools[0]!;
    // a shipped version recorded under another checksum: DRIFTED
    const original = await oracle.query<{ checksum: string }>("SELECT checksum FROM kauro_meta.schema_migrations WHERE version = $1", [last.version]);
    await oracle.query("UPDATE kauro_meta.schema_migrations SET checksum = repeat('0', 64) WHERE version = $1", [last.version]);
    assert.deepEqual(compareSchema(await readSchemaLedger(app, 2_000), shipped), { kind: "DRIFTED", codeVersion: last.version, databaseVersion: last.version, drifted: [last.version] });
    await oracle.query("UPDATE kauro_meta.schema_migrations SET checksum = $2 WHERE version = $1", [last.version, original.rows[0]?.checksum]);
    // a shipped version not recorded: BEHIND
    const row = await oracle.query<{ name: string; checksum: string }>("DELETE FROM kauro_meta.schema_migrations WHERE version = $1 RETURNING name, checksum", [last.version]);
    assert.deepEqual(compareSchema(await readSchemaLedger(app, 2_000), shipped), { kind: "BEHIND", codeVersion: last.version, databaseVersion: last.version - 1, missing: [last.version] });
    await oracle.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [last.version, row.rows[0]?.name, row.rows[0]?.checksum]);
    // a newer expand migration applied by the next release: still compatible for the release that serves now
    await oracle.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, 'next_release_expand', repeat('a', 64))", [last.version + 1]);
    assert.deepEqual(compareSchema(await readSchemaLedger(app, 2_000), shipped), { kind: "COMPATIBLE", codeVersion: last.version, databaseVersion: last.version + 1 });
    await oracle.query("DELETE FROM kauro_meta.schema_migrations WHERE version = $1", [last.version + 1]);
    assert.deepEqual(compareSchema(await readSchemaLedger(app, 2_000), shipped).kind, "COMPATIBLE");
  } finally {
    await oracle.end();
    for (const pool of pools) await pool.end();
  }
});
