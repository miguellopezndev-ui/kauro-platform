// DB-TLS ADV-2 (3ecd979): what the driver pool actually receives (its own options), not the connectionSecurity copy. No PG is needed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { createPool as openPool } from "../src/index.js";
import { testDatabaseEnvironment } from "../src/testing/index.js";

const CA_TEXT = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", max: 1, applicationName: "pool-driver-options" } as const;

test("DB-TLS ADV-2 (3ecd979): the options the driver pool actually receives carry verified TLS and the password (not the connectionSecurity copy); no PG needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kauro-pool-driver-options-"));
  const ca = join(dir, "ca.pem");
  const pw = join(dir, "pw");
  writeFileSync(ca, CA_TEXT);
  writeFileSync(pw, "file-secret\n");
  const seen: Array<{ ssl?: unknown; password?: unknown; host?: unknown }> = [];
  const proto = pg.Pool.prototype as unknown as { on: (...a: unknown[]) => unknown };
  const original = proto.on;
  // KauroPool's constructor registers its error listener on the driver pool it builds: that call exposes the driver pool's own options
  proto.on = function (this: { options: { ssl?: unknown; password?: unknown; host?: unknown } }, ...args: unknown[]) {
    seen.push(this.options);
    return original.apply(this, args);
  };
  try {
    const pool = openPool({ ...login, environment: testDatabaseEnvironment("LIVE"), tlsCaFile: ca, passwordFile: pw, processEnv: {} });
    try {
      assert.equal(seen.length, 1, "the driver pool was observed");
      const ssl = seen[0]!.ssl as { ca?: string; rejectUnauthorized?: boolean } | undefined;
      assert.equal(ssl?.rejectUnauthorized, true, "the driver pool verifies the server certificate");
      assert.equal(ssl?.ca, CA_TEXT, "the driver pool has the CA bytes");
      assert.equal(seen[0]!.password, "file-secret", "the driver pool has the file password");
    } finally {
      await pool.end();
    }
  } finally {
    proto.on = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
