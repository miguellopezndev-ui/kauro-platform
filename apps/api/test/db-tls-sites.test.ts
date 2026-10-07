// ADV-1: against a cluster that refuses every connection without TLS (hostnossl reject), every pool an entry point of the api
// opens is certificate-verified, and the server itself says so: pg_stat_ssl.ssl is true for each backend (the migration job's
// connection is closed when it ends; it is proved by connecting at all to that cluster and by its run through the job).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres } from "@kauro/persistence/testing";
import { API_APPLICATION_NAME, COMMISSION_APPLICATION_NAME, PAYMENT_APPLICATION_NAME, SESSIONS_APPLICATION_NAME, openCommissionPools, openDatabase, openPaymentPools, runMigrationJob, systemClock, systemRandom } from "../src/index.js";
import { listMigrations } from "@kauro/persistence";

let pg: TemporaryPostgres;
let dir: string;
let passwordFile: string;
before(async () => {
  pg = await startTemporaryPostgres({ tls: true });
  dir = mkdtempSync(join(tmpdir(), "kauro-api-tls-sites-"));
  passwordFile = join(dir, "pw");
  writeFileSync(passwordFile, "not-checked-under-trust\n");
});
after(async () => {
  await pg.stop();
  rmSync(dir, { recursive: true, force: true });
});

function login(user: string, poolMax = 1): { host: string; port: number; database: string; user: string; poolMax: number; tlsCaFile: string; passwordFile: string } {
  assert.ok(pg.tls);
  return { host: pg.tls.host, port: pg.port, database: ROLES.database, user, poolMax, tlsCaFile: pg.tls.caFile, passwordFile };
}

/** The server's own account of the open backends: [application_name, ssl] for the application names that start with `prefix`. */
async function backends(prefix: string): Promise<Array<[string, boolean]>> {
  const su = await pg.connect("postgres");
  try {
    const r = await su.query<{ application_name: string; ssl: boolean }>(
      "SELECT a.application_name, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.application_name LIKE $1 ORDER BY 1",
      [`${prefix}%`],
    );
    return r.rows.map((row) => [row.application_name, row.ssl]);
  } finally {
    await su.end();
  }
}

test("ADV-1: the api runtime pool and the session boundary's pool (SANDBOX) are TLS backends according to pg_stat_ssl", async () => {
  const db = await openDatabase({
    environment: "SANDBOX",
    database: { ...login(ROLES.appLogin, 2), statementTimeoutMs: 10_000 },
    migrateOnStart: null,
    identity: { assuranceDatabase: { user: ROLES.assuranceLogin, poolMax: 1, passwordFile } },
  });
  try {
    assert.deepEqual(await backends(API_APPLICATION_NAME), [
      [API_APPLICATION_NAME, true],
      [SESSIONS_APPLICATION_NAME, true],
    ]);
  } finally {
    await db.close();
  }
});

test("ADV-1: the commission service's two pools and the payment service's three are TLS backends according to pg_stat_ssl", async () => {
  const deps = { clock: systemClock, random: systemRandom, environment: "SANDBOX" as const };
  const commission = await openCommissionPools({ commission: login(ROLES.commissionLogin), control: login(ROLES.controlLogin) }, deps);
  try {
    assert.deepEqual(
      await backends(COMMISSION_APPLICATION_NAME),
      [`${COMMISSION_APPLICATION_NAME}-dispatcher`, `${COMMISSION_APPLICATION_NAME}-service`].map((n) => [n, true]),
    );
  } finally {
    await commission.close();
  }
  const db = await openDatabase({ environment: "SANDBOX", database: { ...login(ROLES.appLogin), statementTimeoutMs: 10_000 }, migrateOnStart: null });
  const payment = await openPaymentPools(db.pool, { payment: login(ROLES.paymentLogin), control: login(ROLES.controlLogin), ingress: login(ROLES.ingressLogin) }, deps);
  try {
    assert.deepEqual(
      await backends(PAYMENT_APPLICATION_NAME),
      [`${PAYMENT_APPLICATION_NAME}-dispatcher`, `${PAYMENT_APPLICATION_NAME}-ingress`, `${PAYMENT_APPLICATION_NAME}-service`].map((n) => [n, true]),
    );
  } finally {
    await payment.close();
    await db.close();
  }
});

test("ADV-1: the migration job connects to the TLS-only cluster with its CA (a connection without TLS would be rejected by the server)", async () => {
  const fresh = await startTemporaryPostgres({ migrate: false, tls: true });
  try {
    assert.ok(fresh.tls);
    const ran = await runMigrationJob({
      KAURO_ENVIRONMENT: "LIVE",
      KAURO_DB_HOST: fresh.tls.host,
      KAURO_DB_PORT: String(fresh.port),
      KAURO_DB_NAME: ROLES.database,
      KAURO_DB_MIGRATOR_USER: ROLES.owner,
      KAURO_DB_TLS_CA_FILE: fresh.tls.caFile,
    });
    assert.equal(ran.result.applied.length, listMigrations().length);
  } finally {
    await fresh.stop();
  }
});
