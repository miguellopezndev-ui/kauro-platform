// Database TLS (AWS-DELTA I-2, Q-AWS-8): every non-LOCAL connection is certificate-verified (CA from a PEM file,
// rejectUnauthorized: true, host name check); the pool and the migrator carry the same options. The handshake is proven on a
// real PostgreSQL 17 with a CA and a server certificate generated here by openssl; it is skipped where openssl is absent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "pg";
import { MigratorRoleError, applyMigrationsAs, createPool, sslOptionsOf } from "../src/index.js";

const PGBIN = process.env["PGBIN"] && existsSync(process.env["PGBIN"]) ? process.env["PGBIN"] : process.platform === "win32" ? "C:/Tools/pgsql17/bin" : "/usr/lib/postgresql/17/bin";
const exe = (name: string): string => join(PGBIN, process.platform === "win32" ? `${name}.exe` : name);
const openssl = spawnSync("openssl", ["version"], { encoding: "utf8", windowsHide: true });
const SKIP = openssl.status === 0 && existsSync(exe("initdb")) ? false : "openssl or PostgreSQL 17 binaries are not available on this runner";

test("I-2: sslOptionsOf carries the CA bytes and rejectUnauthorized true, and nothing without a CA", () => {
  assert.equal(sslOptionsOf(undefined), undefined);
  const ssl = sslOptionsOf({ ca: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n" });
  assert.ok(ssl);
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.ca, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
});

test("I-2: the pool's ssl options carry rejectUnauthorized true and the CA bytes; without tls the pool has no ssl (LOCAL unchanged)", async () => {
  const ca = "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----\n";
  const base = { host: "db.example.test", port: 5432, database: "kauro", user: "kauro_app_test", max: 1, applicationName: "t" };
  const withTls = createPool({ ...base, tls: { ca } });
  const without = createPool(base);
  try {
    const ssl = (withTls.raw as unknown as { options: { ssl?: { ca?: string; rejectUnauthorized?: boolean } } }).options.ssl;
    assert.equal(ssl?.rejectUnauthorized, true);
    assert.equal(ssl?.ca, ca);
    assert.equal((without.raw as unknown as { options: { ssl?: unknown } }).options.ssl, undefined);
  } finally {
    await withTls.end();
    await without.end();
  }
});

let base = "";
let port = 0;
let caPem = "";
let otherCaPem = "";

function sh(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
}

function makeCa(dir: string, name: string): void {
  sh("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.crt`, "-days", "2", "-subj", `/CN=${name}`], dir);
}

function makeServerCert(dir: string, caName: string, name: string, san: string): void {
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\n`);
  sh("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=kauro-db"], dir);
  sh("openssl", ["x509", "-req", "-in", `${name}.csr`, "-CA", `${caName}.crt`, "-CAkey", `${caName}.key`, "-CAcreateserial", "-out", `${name}.crt`, "-days", "2", "-extfile", `${name}.ext`], dir);
}

function install(dir: string, data: string, name: string): void {
  copyFileSync(join(dir, `${name}.crt`), join(data, "server.crt"));
  copyFileSync(join(dir, `${name}.key`), join(data, "server.key"));
  if (process.platform !== "win32") spawnSync("chmod", ["600", join(data, "server.key")]);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

before(async () => {
  if (SKIP) return;
  base = mkdtempSync(join(tmpdir(), "kauro-tls-"));
  makeCa(base, "ca");
  makeCa(base, "other-ca");
  makeServerCert(base, "ca", "good", "DNS:localhost");
  makeServerCert(base, "ca", "wrongname", "DNS:other.example.test");
  caPem = readFileSync(join(base, "ca.crt"), "utf8");
  otherCaPem = readFileSync(join(base, "other-ca.crt"), "utf8");
  const data = join(base, "data");
  sh(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"], base);
  install(base, data, "good");
  port = await freePort();
  const opts = [`-p ${port}`, "-c listen_addresses=127.0.0.1", "-c ssl=on", "-c fsync=off", ...(process.platform === "win32" ? [] : [`-k ${base}`])].join(" ");
  const r = spawnSync(exe("pg_ctl"), ["-D", data, "-l", join(base, "pg.log"), "-o", opts, "-w", "-t", "60", "start"], { stdio: "ignore", windowsHide: true, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`pg_ctl start failed: ${existsSync(join(base, "pg.log")) ? readFileSync(join(base, "pg.log"), "utf8") : ""}`);
});

after(() => {
  if (SKIP || base === "") return;
  spawnSync(exe("pg_ctl"), ["-D", join(base, "data"), "-m", "immediate", "-w", "stop"], { stdio: "ignore", windowsHide: true, timeout: 60_000 });
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

async function ssl(ca: string, host = "localhost"): Promise<string> {
  const client = new Client({ host, port, user: "postgres", database: "postgres", ssl: sslOptionsOf({ ca }) });
  await client.connect();
  try {
    const r = await client.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
    return String(r.rows[0]?.ssl);
  } finally {
    await client.end();
  }
}

test("I-2 handshake: the right CA connects over TLS; a wrong CA and a host name mismatch are refused", { skip: SKIP }, async () => {
  assert.equal(await ssl(caPem), "true");
  await assert.rejects(ssl(otherCaPem), /self.signed|unable to (get|verify)|certificate/i, "a CA that did not sign the server certificate");
  // the same server, a certificate whose names do not include the address the client dialled
  const data = join(base, "data");
  install(base, data, "wrongname");
  const reload = spawnSync(exe("pg_ctl"), ["-D", data, "reload"], { stdio: "ignore", windowsHide: true });
  assert.equal(reload.status, 0);
  await new Promise((r) => setTimeout(r, 500));
  await assert.rejects(ssl(caPem), /altnames|not in the cert|Hostname\/IP|does not match/i, "right CA, wrong host name");
  install(base, data, "good");
  spawnSync(exe("pg_ctl"), ["-D", data, "reload"], { stdio: "ignore", windowsHide: true });
});

test("I-2 handshake: the migrator connection verifies too (right CA reaches the role check, wrong CA is refused at the handshake)", { skip: SKIP }, async () => {
  await new Promise((r) => setTimeout(r, 500));
  const connection = { host: "localhost", port, database: "postgres", user: "postgres" };
  await assert.rejects(applyMigrationsAs({ ...connection, tls: { ca: caPem } }), MigratorRoleError, "TLS succeeded: the role check ran and refused the superuser");
  await assert.rejects(applyMigrationsAs({ ...connection, tls: { ca: otherCaPem } }), /self.signed|unable to (get|verify)|certificate/i);
});
