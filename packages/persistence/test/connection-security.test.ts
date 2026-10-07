// The one rule every composition root applies before it opens a PostgreSQL connection (AWS-DELTA I-2, I-3).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ConnectionSecurityError, connectionSecurityOf } from "../src/index.js";

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
