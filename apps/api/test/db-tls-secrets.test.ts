// AWS-DELTA I-2 / I-3: outside LOCAL the database connection is certificate-verified (KAURO_DB_TLS_CA_FILE required) and the
// passwords arrive as mounted-secret files only (the plain variables are refused, as N7 does for the migrator's).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ConnectionSecurityError } from "@kauro/persistence";
import { ConfigError, applyMigrationsWith, loadConfig, loadMigrationJobConfig } from "../src/index.js";
import { testDatabaseEnvironment } from "@kauro/persistence/testing";

let dir: string;
let caFile: string;
let pwFile: string;
let assurancePwFile: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "kauro-api-tls-"));
  caFile = join(dir, "ca.pem");
  pwFile = join(dir, "db-password");
  assurancePwFile = join(dir, "assurance-password");
  writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  writeFileSync(pwFile, "runtime-secret-value\n");
  writeFileSync(assurancePwFile, "assurance-secret-value\r\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const refused = (variable: string, leak?: string) => (e: unknown) => e instanceof ConfigError && e.message.includes(variable) && (leak === undefined || !e.message.includes(leak));

function live(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    KAURO_ENVIRONMENT: "LIVE",
    KAURO_DB_HOST: "db.example.test",
    KAURO_DB_USER: "kauro_app_login",
    KAURO_DB_POOL_MAX: "4",
    KAURO_HTTP_TRUSTED_PROXY_HOPS: "1",
    KAURO_API_CURSOR_KEY_FILE: undefined,
    KAURO_DB_TLS_CA_FILE: caFile,
    KAURO_DB_PASSWORD_FILE: pwFile,
    ...extra,
  };
}

function cursorEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const key = join(dir, "cursor.key");
  writeFileSync(key, Buffer.alloc(32, 7));
  return live({ KAURO_API_CURSOR_KEY_FILE: key, ...extra });
}

test("I-2: SANDBOX and LIVE refuse to start without KAURO_DB_TLS_CA_FILE; LOCAL does not need it", () => {
  for (const environment of ["SANDBOX", "LIVE"]) {
    assert.throws(() => loadConfig(cursorEnv({ KAURO_ENVIRONMENT: environment, KAURO_DB_TLS_CA_FILE: undefined })), refused("KAURO_DB_TLS_CA_FILE"), environment);
  }
  assert.equal(loadConfig(cursorEnv()).database.tlsCaFile, caFile);
  const local = loadConfig({ KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_USER: "kauro_app_login", KAURO_DB_POOL_MAX: "4" });
  assert.ok(!("tlsCaFile" in local.database), "LOCAL without a CA keeps today's shape");
});

test("I-2: the one-shot migration job and its connection carry the CA, required outside LOCAL", () => {
  const job = { KAURO_ENVIRONMENT: "LIVE", KAURO_DB_HOST: "db.example.test", KAURO_DB_MIGRATOR_USER: "kauro_owner" };
  assert.throws(() => loadMigrationJobConfig(job), refused("KAURO_DB_TLS_CA_FILE"));
  assert.equal(loadMigrationJobConfig({ ...job, KAURO_DB_TLS_CA_FILE: caFile }).migrator.tlsCaFile, caFile);
});

test("I-3: KAURO_DB_PASSWORD_FILE is read with one trailing newline trimmed; the plain KAURO_DB_PASSWORD is refused outside LOCAL", () => {
  const config = loadConfig(cursorEnv());
  assert.equal(config.database.passwordFile, pwFile);
  assert.ok(!("password" in config.database) && !JSON.stringify(config).includes("runtime-secret-value"), "the file is named, never read into the configuration: the composition resolves it through connectionSecurityOf");
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD: "plain-secret-value" })), refused("KAURO_DB_PASSWORD", "plain-secret-value"));
});

test("I-3: LOCAL still accepts the plain variable, refuses both forms at once, and the file works in LOCAL too", () => {
  const local = { KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_USER: "kauro_app_login", KAURO_DB_POOL_MAX: "4" };
  assert.equal(loadConfig({ ...local, KAURO_DB_PASSWORD: "local-pw" }).database.password, "local-pw");
  assert.equal(loadConfig({ ...local, KAURO_DB_PASSWORD_FILE: pwFile }).database.passwordFile, pwFile);
  assert.throws(() => loadConfig({ ...local, KAURO_DB_PASSWORD: "x", KAURO_DB_PASSWORD_FILE: pwFile }), refused("KAURO_DB_PASSWORD_FILE"));
});

function identityEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return cursorEnv({
    KAURO_DB_POOL_MAX: "2",
    KAURO_IDENTITY_KEY_SOURCE: "GOOGLE_X509",
    KAURO_IDENTITY_PROJECT_ID: "kauro-test",
    KAURO_APP_ORIGINS: "https://app.example.test",
    KAURO_DB_ASSURANCE_USER: "kauro_assurance_login",
    KAURO_DB_ASSURANCE_POOL_MAX: "2",
    KAURO_DB_ASSURANCE_PASSWORD_FILE: assurancePwFile,
    ...extra,
  });
}

test("I-3: KAURO_DB_ASSURANCE_PASSWORD_FILE is read and trimmed; the plain variable is refused outside LOCAL; both directions in LOCAL", () => {
  const config = loadConfig(identityEnv({}));
  assert.equal(config.identity?.assuranceDatabase.passwordFile, assurancePwFile);
  assert.throws(() => loadConfig(identityEnv({ KAURO_DB_ASSURANCE_PASSWORD: "plain-assurance" })), refused("KAURO_DB_ASSURANCE_PASSWORD", "plain-assurance"));
});

test("I-3: a refusal never carries a secret's value; the files are read when the connection opens, by the one rule", () => {
  assert.ok(!JSON.stringify(loadConfig(cursorEnv())).includes("secret"), "the configuration names files, never holds a secret");
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD: "plain-secret-value" })), refused("KAURO_DB_PASSWORD", "plain-secret-value"));
});

test("I-2: outside LOCAL the database host is a DNS name (pg verifies an IP literal against 'localhost'); LOCAL keeps its IP", () => {
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_HOST: "10.0.0.5" })), refused("KAURO_DB_HOST"));
  assert.throws(() => loadMigrationJobConfig({ KAURO_ENVIRONMENT: "LIVE", KAURO_DB_HOST: "10.0.0.5", KAURO_DB_MIGRATOR_USER: "kauro_owner", KAURO_DB_TLS_CA_FILE: caFile }), refused("KAURO_DB_HOST"));
  assert.equal(loadConfig({ KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_HOST: "127.0.0.1", KAURO_DB_USER: "kauro_app_login", KAURO_DB_POOL_MAX: "4" }).database.host, "127.0.0.1");
});

test("ADV-9: outside LOCAL the runtime and assurance password files are required, and PGPASSWORD / PGPASSFILE in the environment refuse the start", () => {
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD_FILE: undefined })), refused("KAURO_DB_PASSWORD_FILE"));
  assert.throws(() => loadConfig(identityEnv({ KAURO_DB_ASSURANCE_PASSWORD_FILE: undefined })), refused("KAURO_DB_ASSURANCE_PASSWORD_FILE"));
  for (const variable of ["PGPASSWORD", "PGPASSFILE"]) {
    assert.throws(() => loadConfig(cursorEnv({ [variable]: "zzz-value" })), refused(variable, "zzz-value"));
    assert.throws(() => loadMigrationJobConfig({ KAURO_ENVIRONMENT: "LIVE", KAURO_DB_HOST: "db.example.test", KAURO_DB_MIGRATOR_USER: "kauro_owner", KAURO_DB_TLS_CA_FILE: caFile, [variable]: "zzz-value" }), refused(variable, "zzz-value"));
  }
});

test("ADV-9: the migration connection outside LOCAL needs an explicit password (never pg's PGPASSWORD / pgpass fallback)", async () => {
  const migrator = { host: "db.example.test", port: 1, database: "kauro", user: "kauro_owner", tlsCaFile: caFile, connectTimeoutMs: 100, statementTimeoutMs: 1000, lockTimeoutMs: 100, passwordFile: null };
  await assert.rejects(async () => applyMigrationsWith(testDatabaseEnvironment("LIVE"), migrator, undefined), (e: unknown) => e instanceof ConnectionSecurityError && e.variable === "KAURO_DB_MIGRATOR_PASSWORD");
});
