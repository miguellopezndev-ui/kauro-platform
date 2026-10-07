// AWS-DELTA I-2 / I-3: outside LOCAL the database connection is certificate-verified (KAURO_DB_TLS_CA_FILE required) and the
// passwords arrive as mounted-secret files only (the plain variables are refused, as N7 does for the migrator's).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ConfigError, loadConfig, loadMigrationJobConfig } from "../src/index.js";

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
  assert.equal(config.database.password, "runtime-secret-value");
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD: "plain-secret-value" })), refused("KAURO_DB_PASSWORD", "plain-secret-value"));
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD_FILE: join(dir, "missing") })), refused("KAURO_DB_PASSWORD_FILE"));
});

test("I-3: LOCAL still accepts the plain variable, refuses both forms at once, and the file works in LOCAL too", () => {
  const local = { KAURO_ENVIRONMENT: "LOCAL", KAURO_DB_USER: "kauro_app_login", KAURO_DB_POOL_MAX: "4" };
  assert.equal(loadConfig({ ...local, KAURO_DB_PASSWORD: "local-pw" }).database.password, "local-pw");
  assert.equal(loadConfig({ ...local, KAURO_DB_PASSWORD_FILE: pwFile }).database.password, "runtime-secret-value");
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
  assert.equal(config.identity?.assuranceDatabase.password, "assurance-secret-value");
  assert.throws(() => loadConfig(identityEnv({ KAURO_DB_ASSURANCE_PASSWORD: "plain-assurance" })), refused("KAURO_DB_ASSURANCE_PASSWORD", "plain-assurance"));
});

test("I-3: a refusal never carries a secret's value; an unreadable or empty file is refused by variable name", () => {
  const empty = join(dir, "empty");
  writeFileSync(empty, "\n");
  assert.throws(() => loadConfig(cursorEnv({ KAURO_DB_PASSWORD_FILE: empty })), refused("KAURO_DB_PASSWORD_FILE"));
  assert.ok(!JSON.stringify(loadConfig(cursorEnv()).environment).includes("secret"));
});
