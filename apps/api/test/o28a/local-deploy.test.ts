// O28A reproducible local deployment: deploy/local/stack.json is deployed as declared — one `node dist/src/main.js` process with exactly
// the declared environment over a fresh PostgreSQL 17 cluster — then probed over real HTTP on the loopback, redeployed, rolled back and
// failed. Rollback: migrations are forward-only, so a previous build is safe exactly when every migration it ships is recorded unchanged
// (readiness COMPATIBLE, even with newer migrations recorded); a drifted or missing one keeps it out of traffic (503) and the backup is
// the way back. The api's stderr of the whole run goes through the declared alert rules: the outage pages, the healthy runs do not.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startTemporaryPostgres, type TemporaryPostgres } from "@kauro/persistence/testing";
import type { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");
const stack = JSON.parse(readFileSync(join(repo, "deploy", "local", "stack.json"), "utf8")) as { entrypoint: string; environment: Record<string, string>; probes: { liveness: string; readiness: string } };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

interface Deployed {
  readonly child: ChildProcess;
  readonly base: string;
}

let pg: TemporaryPostgres;
let su: Client;
let scratch: string;
let bearerFile: string;
const stderr: Array<{ at: number; line: string }> = [];
const live = new Set<ChildProcess>();

before(async () => {
  pg = await startTemporaryPostgres();
  su = await pg.connect("postgres");
  scratch = mkdtempSync(join(tmpdir(), "kauro-o28a-deploy-"));
  bearerFile = join(scratch, "bearer-tokens.json");
  const at = new Date().toISOString();
  writeFileSync(bearerFile, JSON.stringify({ subjects: [{ token: `o28a-local-${"x".repeat(24)}`, provider: "identity-platform", subject: "o28a-local-person", emailVerifiedAt: at, mfaEnrolledAt: at, state: "ACTIVE" }] }));
});
after(async () => {
  for (const c of live) c.kill();
  await su?.end();
  await pg?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function deploy(): Promise<Deployed> {
  const httpPort = await freePort();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(stack.environment)) env[k] = v.replace("${PG_PORT}", String(pg.port)).replace("${HTTP_PORT}", String(httpPort)).replace("${BEARER_TOKENS_FILE}", bearerFile);
  // exactly the declared environment (plus what the OS needs to start a process): nothing inherited can configure the api
  const os = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k] as string]));
  const child = spawn(process.execPath, [join(repo, stack.entrypoint)], { env: { ...os, ...env }, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  live.add(child);
  child.once("exit", () => live.delete(child));
  let buffered = "";
  const listening = new Promise<void>((resolve, reject) => {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).replace(/\r$/, "");
        buffered = buffered.slice(nl + 1);
        stderr.push({ at: Date.now(), line });
        if (line.includes(" listening on ")) resolve();
        if (line.startsWith("kauro-api failed to start")) reject(new Error(line));
      }
    });
    child.once("exit", (code) => reject(new Error(`the api exited (${String(code)}) before listening`)));
  });
  await listening;
  return { child, base: `http://127.0.0.1:${httpPort}` };
}

async function stop(d: Deployed): Promise<void> {
  if (d.child.exitCode !== null) return;
  const exited = new Promise((resolve) => d.child.once("exit", resolve));
  d.child.kill("SIGTERM");
  await exited;
}

async function probe(d: Deployed, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${d.base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test("the declared stack deploys: live, ready on the shipped schema, private by default, and a redeploy changes nothing", async () => {
  const ledger = async () => (await su.query("SELECT version, checksum FROM kauro_meta.schema_migrations ORDER BY version")).rows;
  const before = await ledger();
  const first = await deploy();
  try {
    assert.equal((await probe(first, stack.probes.liveness)).status, 200);
    const ready = await probe(first, stack.probes.readiness);
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body["status"], "READY");
    // an anonymous request reads nothing private
    assert.equal((await fetch(`${first.base}/api/v1/agencies`)).status, 401);
  } finally {
    await stop(first);
  }
  const second = await deploy();
  try {
    assert.equal((await probe(second, stack.probes.readiness)).status, 200, "the redeploy is ready");
  } finally {
    await stop(second);
  }
  assert.deepEqual(await ledger(), before, "deploying twice applied and changed nothing");
});

test("rollback guard: a previous build serves over newer migrations, never over a drifted or missing one", async () => {
  const d = await deploy();
  try {
    await su.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES (9999, 'o28a_newer_build', repeat('0', 64))");
    const newer = await probe(d, stack.probes.readiness);
    assert.equal(newer.status, 200, `a newer recorded migration keeps the previous build serving: ${JSON.stringify(newer.body)}`);
    await su.query("DELETE FROM kauro_meta.schema_migrations WHERE version = 9999");
    const last = (await su.query<{ version: number; checksum: string }>("SELECT version, checksum FROM kauro_meta.schema_migrations ORDER BY version DESC LIMIT 1")).rows[0];
    assert.ok(last);
    await su.query("UPDATE kauro_meta.schema_migrations SET checksum = repeat('f', 64) WHERE version = $1", [last.version]);
    const drifted = await probe(d, stack.probes.readiness);
    assert.equal(drifted.status, 503);
    assert.equal((drifted.body["checks"] as Record<string, unknown>)["schema"], "DRIFTED");
    await su.query("UPDATE kauro_meta.schema_migrations SET checksum = $2 WHERE version = $1", [last.version, last.checksum]);
    assert.equal((await probe(d, stack.probes.readiness)).status, 200, "restored, ready again");
  } finally {
    await stop(d);
  }
});

test("an outage of the database: readiness goes 503 without a credential or host in the answer, and the declared alerts page on it", async () => {
  const d = await deploy();
  const from = stderr.length;
  try {
    await su.query("ALTER ROLE kauro_app_test NOLOGIN");
    await su.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'kauro_app_test'");
    for (let i = 0; i < 3; i++) {
      const r = await probe(d, stack.probes.readiness);
      assert.equal(r.status, 503);
      const text = JSON.stringify(r.body);
      for (const secret of ["kauro_app_test", "127.0.0.1", String(pg.port)]) assert.ok(!text.includes(secret), `the answer names ${secret}`);
    }
  } finally {
    await su.query("ALTER ROLE kauro_app_test LOGIN");
  }
  assert.equal((await probe(d, stack.probes.readiness)).status, 200, "ready again once the database returns");
  await stop(d);
  const alerts = (await import(pathToFileURL(join(repo, "tools", "ci", "alerts.mjs")).href)) as { loadRules(): unknown; evaluate(rules: unknown, events: ReadonlyArray<{ at: number; line: string }>): ReadonlyArray<{ id: string }> };
  const rules = alerts.loadRules();
  assert.deepEqual(alerts.evaluate(rules, stderr.slice(0, from)).map((a) => a.id), [], "the healthy deployments fired nothing");
  assert.ok(alerts.evaluate(rules, stderr.slice(from)).some((a) => a.id === "API_NOT_READY"), `the outage pages: ${stderr.slice(from).map((e) => e.line).join(" | ")}`);
});
