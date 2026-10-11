// The one rule every composition root applies before it opens a PostgreSQL connection (AWS-DELTA I-2, I-3).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ConnectionSecurityError, connectionSecurityOf, createPool, KauroPool } from "../src/index.js";
import * as persistence from "../src/index.js";
import { testDatabaseEnvironment } from "../src/testing/index.js";

let dir: string;
let ca: string;
let pw: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "kauro-sec-"));
  ca = join(dir, "ca.pem");
  pw = join(dir, "pw");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  writeFileSync(pw, "file-secret\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const refusedBy = (variable: string, leak = "zzz-never") => (e: unknown) => e instanceof ConnectionSecurityError && e.message.startsWith(`${variable}:`) && !e.message.includes(leak);

test("outside LOCAL: no CA, a plain password and an IP-literal host are each refused by variable; the secure combination passes", () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    assert.throws(() => connectionSecurityOf(environment, { host: "db.example.test", passwordFile: pw }), refusedBy("KAURO_DB_TLS_CA_FILE"), environment);
    assert.throws(() => connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, password: "plain-zzz" }), refusedBy("KAURO_DB_PASSWORD", "plain-zzz"), environment);
    assert.throws(() => connectionSecurityOf(environment, { host: "10.1.2.3", tlsCaFile: ca }), refusedBy("KAURO_DB_HOST"), environment);
    assert.throws(() => connectionSecurityOf(environment, { host: "::1", tlsCaFile: ca }), refusedBy("KAURO_DB_HOST"), environment);
    const ok = connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, passwordFile: pw });
    assert.equal(ok.password, "file-secret");
    assert.equal(ok.tls?.ca.includes("BEGIN CERTIFICATE"), true);
  }
});

test("LOCAL: nothing is required, the plain password and an IP host are accepted, both forms together are not", () => {
  assert.deepEqual(connectionSecurityOf("LOCAL", { host: "127.0.0.1" }), {});
  assert.equal(connectionSecurityOf("LOCAL", { host: "127.0.0.1", password: "p" }).password, "p");
  assert.equal(connectionSecurityOf("LOCAL", { host: "127.0.0.1", passwordFile: pw }).password, "file-secret");
  assert.throws(() => connectionSecurityOf("LOCAL", { host: "127.0.0.1", password: "p", passwordFile: pw }), refusedBy("KAURO_DB_PASSWORD_FILE"));
});

test("a missing, empty or non-PEM file is refused by variable, never with its content", () => {
  const empty = join(dir, "empty");
  const junk = join(dir, "junk");
  writeFileSync(empty, "\n");
  writeFileSync(junk, "not a certificate zzz");
  assert.throws(() => connectionSecurityOf("LOCAL", { host: "h", passwordFile: join(dir, "nope") }), refusedBy("KAURO_DB_PASSWORD_FILE"));
  assert.throws(() => connectionSecurityOf("LOCAL", { host: "h", passwordFile: empty }), refusedBy("KAURO_DB_PASSWORD_FILE"));
  assert.throws(() => connectionSecurityOf("LOCAL", { host: "h", tlsCaFile: junk }), refusedBy("KAURO_DB_TLS_CA_FILE"));
});

test("ADV-9: outside LOCAL a password FILE is required (pg would otherwise consult PGPASSWORD or a pgpass file), the result always carries an explicit password, and LOCAL is unchanged", () => {
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    assert.throws(() => connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca }), refusedBy("KAURO_DB_PASSWORD_FILE"), environment);
    assert.throws(() => connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, validateOnly: true }), refusedBy("KAURO_DB_PASSWORD_FILE"), `${environment} validateOnly`);
    assert.throws(() => connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, names: { password: "KAURO_DB_ASSURANCE_PASSWORD", passwordFile: "KAURO_DB_ASSURANCE_PASSWORD_FILE" } }), refusedBy("KAURO_DB_ASSURANCE_PASSWORD_FILE"));
    assert.equal(typeof connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, passwordFile: pw }).password, "string");
    // the migrator holds its own credential: the caller says so, and the call site then requires an explicit password itself
    assert.doesNotThrow(() => connectionSecurityOf(environment, { host: "db.example.test", tlsCaFile: ca, passwordRequired: false }));
  }
  assert.deepEqual(connectionSecurityOf("LOCAL", { host: "127.0.0.1" }), {});
});

test("ADV-9: outside LOCAL PGPASSWORD, PGPASSFILE and PGSSLMODE in the environment refuse the start by name; LOCAL ignores them", () => {
  const ok = { host: "db.example.test", tlsCaFile: ca, passwordFile: pw };
  for (const variable of ["PGPASSWORD", "PGPASSFILE", "PGSSLMODE"]) {
    for (const environment of ["SANDBOX", "LIVE"] as const) {
      assert.throws(() => connectionSecurityOf(environment, { ...ok, processEnv: { [variable]: "zzz-value" } }), refusedBy(variable, "zzz-value"), `${environment} ${variable}`);
      assert.throws(() => connectionSecurityOf(environment, { ...ok, validateOnly: true, processEnv: { [variable]: "zzz-value" } }), refusedBy(variable, "zzz-value"));
    }
    assert.deepEqual(connectionSecurityOf("LOCAL", { host: "127.0.0.1", processEnv: { [variable]: "x" } }), {});
  }
  assert.equal(connectionSecurityOf("LIVE", { ...ok, processEnv: { PGPASSWORD: "" } }).password, "file-secret", "an empty variable is unset");
});

test("DB-TLS-R1: outside LOCAL the host must be a DNS name pg dials itself: an empty, blank, socket-path, bracketed or malformed host is refused (pg would fall back to PGHOST or a socket with no TLS server name), and PGHOST/PGHOSTADDR in the environment refuse the start", () => {
  const ok = { tlsCaFile: ca, passwordFile: pw };
  for (const environment of ["SANDBOX", "LIVE"] as const) {
    for (const host of ["", " ", "db.example.test ", "/var/run/postgresql", "[::1]", "db..example.test", "-db.example.test", "db.example.test,other.test", "db_example.test", "a".repeat(64) + ".test"]) {
      assert.throws(() => connectionSecurityOf(environment, { ...ok, host }), refusedBy("KAURO_DB_HOST"), `${environment} ${JSON.stringify(host)}`);
      assert.throws(() => connectionSecurityOf(environment, { ...ok, host, validateOnly: true }), refusedBy("KAURO_DB_HOST"), `${environment} validateOnly ${JSON.stringify(host)}`);
    }
    for (const variable of ["PGHOST", "PGHOSTADDR"]) {
      assert.throws(() => connectionSecurityOf(environment, { ...ok, host: "db.example.test", processEnv: { [variable]: "192.0.2.10" } }), refusedBy(variable, "192.0.2.10"), `${environment} ${variable}`);
      // ADV-2 (e692ba2): the refusal names what a host variable does (the host dialled), not the password or TLS mode
      assert.throws(() => connectionSecurityOf(environment, { ...ok, host: "db.example.test", processEnv: { [variable]: "192.0.2.10" } }), /dial the host from it/, `${environment} ${variable} reason`);
    }
    for (const host of ["db.example.test", "kauro-db-1.cluster-abc.us-east-1.rds.amazonaws.com", "DB.Example.TEST"]) {
      assert.equal(connectionSecurityOf(environment, { ...ok, host }).password, "file-secret", `${environment} ${host}`);
    }
  }
  assert.deepEqual(connectionSecurityOf("LOCAL", { host: "", processEnv: { PGHOST: "127.0.0.1" } }), {}, "LOCAL is unchanged");
});

test("DB-TLS-R3: a KauroPool is constructed by createPool only: the class taken by any import route refuses construction before a pg pool exists", async () => {
  const config = { environment: testDatabaseEnvironment("LOCAL"), host: "localhost", port: 1, database: "kauro", user: "u", max: 1, applicationName: "db-tls-r3" } as const;
  const Constructor = KauroPool as unknown as new (...args: unknown[]) => unknown;
  const Member = (persistence as unknown as Record<string, new (...args: unknown[]) => unknown>)["KauroPool"]!;
  const RunTime = ((await import("../src/index.js")) as unknown as Record<string, new (...args: unknown[]) => unknown>)["KauroPool"]!;
  for (const [route, C] of [["named import", Constructor], ["namespace computed member", Member], ["run-time import", RunTime]] as const) {
    assert.throws(() => new C(config), /KauroPool is constructed by createPool only/, route);
    assert.throws(() => new C(config, Symbol("KauroPool.create")), /KauroPool is constructed by createPool only/, `${route}: a look-alike token`);
  }
  const pool = createPool(config);
  assert.ok(pool instanceof KauroPool, "createPool still constructs one");
  await pool.end();
});
