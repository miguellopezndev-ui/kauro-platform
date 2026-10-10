// ADV-1 for the control plane: against a cluster that refuses every connection without TLS, the control pool and the validator's
// pool are TLS backends according to pg_stat_ssl.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { ROLES, startTemporaryPostgres, type TemporaryPostgres, testDatabaseEnvironment } from "@kauro/persistence/testing";
import { CONTROL_APPLICATION_NAME, openControlDatabase, openValidatorReceipts } from "../src/index.js";

let pg: TemporaryPostgres;
before(async () => {
  pg = await startTemporaryPostgres({ tls: true });
});
after(async () => {
  await pg.stop();
});

test("ADV-1: openControlDatabase and openValidatorReceipts (SANDBOX) hold TLS backends", async () => {
  assert.ok(pg.tls);
  const base = { host: pg.tls.host, port: pg.port, database: ROLES.database, poolMax: 1, environment: testDatabaseEnvironment("SANDBOX"), tlsCaFile: pg.tls.caFile, passwordFile: pg.tls.passwordFile };
  const control = await openControlDatabase({ ...base, user: ROLES.controlLogin });
  const validator = await openValidatorReceipts({ ...base, user: ROLES.validatorLogin }, "kauro-control-validator-tls");
  try {
    const su = await pg.connect("postgres");
    try {
      const r = await su.query<{ application_name: string; ssl: boolean }>(
        "SELECT a.application_name, s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid = a.pid WHERE a.application_name IN ($1, $2) ORDER BY 1",
        [CONTROL_APPLICATION_NAME, "kauro-control-validator-tls"],
      );
      assert.deepEqual(r.rows.map((x) => [x.application_name, x.ssl]), [[CONTROL_APPLICATION_NAME, true], ["kauro-control-validator-tls", true]]);
    } finally {
      await su.end();
    }
  } finally {
    await validator.close();
    await control.close();
  }
});
