// DB-TLS-R4 root cause (adversary ADV-1 on d515f18): the connection security rule is enforced where the pool and the migrator connection are
// built, not looked for in their callers. Every route to createPool (an aliased re-export, the package index by any specifier, a namespace
// computed member, a run-time import, a CommonJS require through createRequire, a wrapper) yields a pool to which connectionSecurityOf
// was applied: outside LOCAL it is TLS-verified, dials a DNS host, takes the password from its file and refuses the PG* fallbacks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ConnectionSecurityError, createPool as openPool, type KauroPool, type PoolConfig } from "../src/index.js";
import * as index from "../src/index.js";
import { migratorClientOf } from "../src/pool.js";
import { testDatabaseEnvironment } from "../src/testing/index.js";
import pg from "pg";

let dir: string;
let ca: string;
let pw: string;
const CA_TEXT = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "kauro-pool-enforcement-"));
  ca = join(dir, "ca.pem");
  pw = join(dir, "pw");
  writeFileSync(ca, CA_TEXT);
  writeFileSync(pw, "file-secret\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

type Factory = (config: PoolConfig) => KauroPool;
const refusedBy = (variable: string) => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`);
const optionsOf = (pool: KauroPool) => pool.connectionSecurity;

/** The routes the adversary used to reach an unchecked createPool on d515f18, each taken at run time from the built package. */
async function routes(): Promise<ReadonlyArray<readonly [string, Factory]>> {
  const require = createRequire(import.meta.url);
  const computed = (index as unknown as Record<string, Factory>)["create" + "Pool"]!;
  const dynamic = ((await import("../src/index.js")) as unknown as Record<string, Factory>)["createPool"]!;
  const required = (require("../src/index.js") as Record<string, Factory>)["createPool"]!;
  const parent = (require("../src/") as Record<string, Factory>)["createPool"]!;
  const wrapper: Factory = (c) => openPool({ ...c });
  return [
    ["aliased import (export { createPool as openPool })", openPool],
    ["namespace computed member I['create' + 'Pool']", computed],
    ["run-time import of the index", dynamic],
    ["createRequire(import.meta.url)('../src/index.js')", required],
    ["createRequire(import.meta.url)('../src/') (the parent directory)", parent],
    ["a wrapper function", wrapper],
  ];
}

const login = { host: "db.example.test", port: 1, database: "kauro", user: "u", max: 1, applicationName: "pool-enforcement" } as const;

test("DB-TLS-R4 / ADV-1: every route to createPool refuses an insecure configuration outside LOCAL before a pool exists", async () => {
  for (const [route, create] of await routes()) {
    for (const name of ["SANDBOX", "LIVE"] as const) {
      const environment = testDatabaseEnvironment(name);
      const secure = { ...login, environment, tlsCaFile: ca, passwordFile: pw, processEnv: {} };
      assert.throws(() => create({ ...secure, tlsCaFile: undefined } as never), refusedBy("KAURO_DB_TLS_CA_FILE"), `${route} ${name}: no CA`);
      assert.throws(() => create({ ...secure, passwordFile: undefined, password: "plain" } as never), refusedBy("KAURO_DB_PASSWORD"), `${route} ${name}: plain password`);
      assert.throws(() => create({ ...secure, passwordFile: undefined } as never), refusedBy("KAURO_DB_PASSWORD_FILE"), `${route} ${name}: no password file`);
      assert.throws(() => create({ ...secure, host: "10.0.0.1" }), refusedBy("KAURO_DB_HOST"), `${route} ${name}: IP host`);
      assert.throws(() => create({ ...secure, host: "" }), refusedBy("KAURO_DB_HOST"), `${route} ${name}: empty host`);
      for (const variable of ["PGHOST", "PGHOSTADDR", "PGPASSWORD", "PGSSLMODE", "PGPASSFILE"]) {
        assert.throws(() => create({ ...secure, processEnv: { [variable]: "192.0.2.10" } }), refusedBy(variable), `${route} ${name}: ${variable}`);
      }
    }
    // no environment at all (a JavaScript caller, a cast): refused, never treated as LOCAL
    assert.throws(() => create({ ...login } as never), /never a string/, `${route}: no environment`);
    // DB-TLS gap 2: a plain string, literal or built at run time, and a look-alike object are refused: only a minted environment opens a connection
    for (const forged of ["LOCAL", "LIVE", ["LOC", "AL"].join(""), { name: "LOCAL" }, Object.freeze({ name: "LIVE" })]) {
      assert.throws(() => create({ ...login, environment: forged } as never), /never a string/, `${route}: ${JSON.stringify(forged)}`);
    }
  }
});

test("DB-TLS-R4 / ADV-1: every route to createPool yields a verified-TLS pool with the file password outside LOCAL; a smuggled ssl setting does not reach the driver", async () => {
  for (const [route, create] of await routes()) {
    const pool = create({ ...login, environment: testDatabaseEnvironment("LIVE"), tlsCaFile: ca, passwordFile: pw, processEnv: {}, ssl: false, tls: { ca: "x" } } as never);
    try {
      const options = optionsOf(pool);
      assert.equal(options.ssl?.rejectUnauthorized, true, route);
      assert.equal(options.ssl?.ca, CA_TEXT, route);
      assert.equal(options.passwordGiven, true, route);
    } finally {
      await pool.end();
    }
  }
});

test("DB-TLS-R4: LOCAL is unchanged: no CA needed, a plain password accepted, no ssl unless a CA file is named", async () => {
  const pool = openPool({ ...login, host: "127.0.0.1", environment: testDatabaseEnvironment("LOCAL"), password: "p", processEnv: { PGHOST: "127.0.0.1" } });
  try {
    assert.equal(optionsOf(pool).ssl, undefined);
    assert.equal(optionsOf(pool).passwordGiven, true);
  } finally {
    await pool.end();
  }
});

test("DB-TLS-R4: the migrator connection is built under the same rule (CA, DNS host, explicit credential outside LOCAL)", () => {
  const timeouts = { connectionTimeoutMillis: 1000, statement_timeout: 1000, lock_timeout: 1000 };
  const migrator = { host: "db.example.test", port: 1, database: "kauro", user: "kauro_owner", processEnv: {} } as const;
  for (const name of ["SANDBOX", "LIVE"] as const) {
    const environment = testDatabaseEnvironment(name);
    assert.throws(() => migratorClientOf({ ...migrator, environment, password: "p" }, timeouts), refusedBy("KAURO_DB_TLS_CA_FILE"), name);
    assert.throws(() => migratorClientOf({ ...migrator, environment, password: "p", tlsCaFile: ca, host: "10.0.0.1" }, timeouts), refusedBy("KAURO_DB_HOST"), name);
    assert.throws(() => migratorClientOf({ ...migrator, environment, tlsCaFile: ca }, timeouts), refusedBy("KAURO_DB_MIGRATOR_PASSWORD"), name);
    assert.throws(() => migratorClientOf({ ...migrator, environment, password: "p", tlsCaFile: ca, processEnv: { PGHOST: "192.0.2.10" } }, timeouts), refusedBy("PGHOST"), name);
    const client = migratorClientOf({ ...migrator, environment, password: "p", tlsCaFile: ca }, { ...timeouts, ssl: false } as never);
    const ssl = (client as unknown as { connectionParameters: { ssl?: { ca?: string; rejectUnauthorized?: boolean } } }).connectionParameters.ssl;
    assert.equal(ssl?.rejectUnauthorized, true, `${name}: verified TLS, the smuggled ssl: false did not reach the driver`);
    assert.equal(ssl?.ca, CA_TEXT);
  }
  assert.throws(() => migratorClientOf({ ...migrator } as never, timeouts), /never a string/);
  assert.throws(() => migratorClientOf({ ...migrator, environment: "LOC" + "AL" } as never, timeouts), /never a string/);
  const local = migratorClientOf({ ...migrator, environment: testDatabaseEnvironment("LOCAL") }, timeouts);
  assert.equal((local as unknown as { connectionParameters: { ssl?: unknown } }).connectionParameters.ssl, false, "LOCAL unchanged: no TLS, no password required");
});

test("DB-TLS gap 1 (6de1436): the driver pool is unreachable from a KauroPool: no raw, no property holds a pg Pool, its Client class or its options; the security record is frozen", async () => {
  const pool = openPool({ ...login, environment: testDatabaseEnvironment("LIVE"), tlsCaFile: ca, passwordFile: pw, processEnv: {} });
  try {
    const loose = pool as unknown as Record<string, unknown>;
    assert.equal("raw" in pool, false, "no raw property at run time");
    assert.throws(() => new ((loose["raw"] as { Client: new (c: object) => unknown }).Client)({ host: "10.0.0.1", ssl: false }), TypeError, "new pool.raw.Client(...) is impossible");
    // every property reachable by name on the instance and its prototype chain, getters included
    const names = new Set<string>();
    for (let o: object | null = pool; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    for (const name of names) {
      const value = loose[name];
      assert.ok(!(value instanceof pg.Pool), `${name} is not the driver pool`);
      assert.ok(!(value instanceof pg.Client), `${name} is not a driver client`);
      if (typeof value === "object" && value !== null) {
        assert.equal(typeof (value as { Client?: unknown }).Client, "undefined", `${name} exposes no Client class`);
        assert.equal((value as { options?: unknown }).options, undefined, `${name} exposes no driver options`);
      }
    }
    // an options mutation through what the pool does expose is refused (strict mode) and changes nothing
    const record = pool.connectionSecurity as { ssl?: { rejectUnauthorized: boolean } | undefined; passwordGiven: boolean };
    assert.throws(() => { record.ssl = undefined; }, TypeError);
    assert.throws(() => { record.ssl!.rejectUnauthorized = false; }, TypeError);
    assert.equal(pool.connectionSecurity.ssl?.rejectUnauthorized, true);
  } finally {
    await pool.end();
  }
  assert.equal(pool.ended, true);
});

test("DB-TLS gap 2: the production minter is handed out once per process; a second claim is refused", async () => {
  const { claimEnvironmentMinter } = await import("../src/index.js");
  const mint = claimEnvironmentMinter();
  assert.equal(mint("LIVE").name, "LIVE");
  assert.throws(() => mint("PRODUCTION"), TypeError);
  assert.throws(() => claimEnvironmentMinter(), /already claimed/);
});

test("DB-TLS gap 2: a plain string is a compile-time error too (the brand is a unique symbol)", () => {
  const compileOnly = (): void => {
    // @ts-expect-error a string literal is not a DatabaseEnvironment
    openPool({ ...login, environment: "LOCAL" });
    // @ts-expect-error a string built at run time is not either
    migratorClientOf({ host: "h", port: 1, database: "d", user: "u", environment: "LOC" + "AL" }, { connectionTimeoutMillis: 1, statement_timeout: 1, lock_timeout: 1 });
  };
  assert.equal(typeof compileOnly, "function");
});
