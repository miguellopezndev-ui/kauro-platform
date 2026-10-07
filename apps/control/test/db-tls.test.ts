// I-2 / I-3 at the control plane's two connection sites: outside LOCAL each refuses before it opens a connection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionSecurityError } from "@kauro/persistence";
import { openControlDatabase, openValidatorReceipts } from "../src/index.js";

const base = { host: "db.example.test", port: 1, database: "kauro", user: "kauro_control_login", poolMax: 1 };
const refused = (variable: string) => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`);

test("openControlDatabase and openValidatorReceipts refuse SANDBOX and LIVE without a CA, with a plain password or with an IP host", async () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    await assert.rejects(openControlDatabase({ ...base, environment }), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openControlDatabase({ ...base, environment, password: "x", tlsCaFile: "ca.pem" }), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openControlDatabase({ ...base, environment, host: "10.0.0.1", tlsCaFile: "ca.pem" }), refused("KAURO_DB_HOST"));
    await assert.rejects(openValidatorReceipts({ ...base, environment }, "t"), refused("KAURO_DB_TLS_CA_FILE"));
    await assert.rejects(openValidatorReceipts({ ...base, environment, password: "x", tlsCaFile: "ca.pem" }, "t"), refused("KAURO_DB_PASSWORD"));
    await assert.rejects(openValidatorReceipts({ ...base, environment, host: "10.0.0.1", tlsCaFile: "ca.pem" }, "t"), refused("KAURO_DB_HOST"));
  }
});
