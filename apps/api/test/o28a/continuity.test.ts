// O28A continuity on real PostgreSQL 17, no provider: (1) backup and restore — a logical backup (roles + database) of the populated cluster
// restores into a fresh cluster with the same migration ledger, rows, forced row security and policies, and the restored data keeps
// agency B out of agency A's rows; (2) node failure and retry — the api's database becomes unreachable under a running api, every request
// answers a retryable 503 (never a 500, never a partial write), and once it returns the same idempotent command completes exactly once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Client as PgClient, ClientConfig } from "pg";
import { EFFECT_TABLES, call, completed, effectCounts, freshKey, routes, world, type World } from "../support.js";

const BIN = process.env["PGBIN"] && existsSync(process.env["PGBIN"]) ? process.env["PGBIN"] : process.platform === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin";
const exe = (name: string) => join(BIN, process.platform === "win32" ? `${name}.exe` : name);
function run(name: string, args: ReadonlyArray<string>, detached = false): string {
  const r = spawnSync(exe(name), args, { encoding: "utf8", windowsHide: true, stdio: detached ? "ignore" : "pipe", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`${name} ${args.join(" ")} exited ${String(r.status)}: ${r.stderr ?? ""}`);
  return r.stdout ?? "";
}
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
let w: World;
let scratch: string;
before(async () => {
  w = await world();
  scratch = mkdtempSync(join(tmpdir(), "kauro-o28a-"));
});
after(async () => {
  await w?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

test("backup and restore: the populated cluster restores with its ledger, rows and row security, and isolation holds on the restored data", async () => {
  await w.project(w.A, w.clientA);
  await w.project(w.B, w.clientB);
  const sourcePort = String(w.h.pg.port);
  const roles = join(scratch, "roles.sql");
  const dump = join(scratch, "kauro.dump");
  run("pg_dumpall", ["-h", "127.0.0.1", "-p", sourcePort, "-U", "postgres", "--roles-only", "-f", roles]);
  run("pg_dump", ["-h", "127.0.0.1", "-p", sourcePort, "-U", "postgres", "-d", "kauro", "-Fc", "-f", dump]);

  const dataDir = join(scratch, "restored");
  run("initdb", ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"]);
  const port = await freePort();
  run("pg_ctl", ["-D", dataDir, "-l", join(scratch, "restored.log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off`, "-w", "-t", "60", "start"], true);
  try {
    // the superuser exists already: the roles file's one error is that line, every other role is created
    spawnSync(exe("psql"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-q", "-f", roles], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
    run("pg_restore", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-C", "--exit-on-error", dump]);

    const source = w.h.oracle;
    // the api declares no runtime pg dependency of its own: the harness oracle's class is the driver the persistence package ships
    const Client = w.h.oracle.constructor as new (config: ClientConfig) => PgClient;
    const restored = new Client({ host: "127.0.0.1", port, user: "postgres", database: "kauro" });
    await restored.connect();
    try {
      const ledger = "SELECT version, checksum FROM kauro_meta.schema_migrations ORDER BY version";
      assert.deepEqual((await restored.query(ledger)).rows, (await source.query(ledger)).rows, "the migration ledger");
      const counts = `SELECT ${EFFECT_TABLES.map((t) => `(SELECT count(*) FROM kauro.${t})::int AS ${t}`).join(", ")}`;
      assert.deepEqual((await restored.query(counts)).rows[0], await effectCounts(w), "the rows of every effect table");
      const security = "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'kauro' AND c.relkind IN ('r','p') ORDER BY 1";
      assert.deepEqual((await restored.query(security)).rows, (await source.query(security)).rows, "row security of every table");
      const policies = "SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'kauro' ORDER BY 1, 2";
      assert.deepEqual((await restored.query(policies)).rows, (await source.query(policies)).rows, "every policy");
    } finally {
      await restored.end();
    }
    // the request handlers' role on the restored data: under agency B's context, A's projects do not exist
    const app = new Client({ host: "127.0.0.1", port, user: "kauro_app_test", database: "kauro" });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [w.B.agencyId, w.stranger.userId]);
      const seen = await app.query<{ agency_id: string }>("SELECT DISTINCT agency_id::text FROM kauro.projects");
      assert.deepEqual(seen.rows.map((r) => r.agency_id).filter((a) => a !== w.B.agencyId), [], "only agency B's projects are visible");
      assert.ok(seen.rows.some((r) => r.agency_id === w.B.agencyId), "agency B's own project is visible (positive control)");
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }
  } finally {
    spawnSync(exe("pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { encoding: "utf8", windowsHide: true, stdio: "ignore", timeout: 60_000 });
  }
});

test("node failure: with the api's database unreachable every request is a retryable 503 and writes nothing; once it returns the retry completes once", async () => {
  // the api's database node fails for the api: its login is refused and every connection it holds is cut (the harness's superuser oracle,
  // which observes, is not the api's role and keeps its connection)
  const role = "kauro_app_test";
  const cut = async () => {
    await w.h.oracle.query(`ALTER ROLE ${role} NOLOGIN`);
    await w.h.oracle.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [role]);
  };
  const body = { displayName: "Continuity client", processingAuthorityRef: w.authorityA };
  const key = freshKey("continuity");
  const before = await w.count("end_clients");
  await cut();
  try {
    for (const attempt of [1, 2]) {
      const write = await call(w, { url: routes.createClient(w.A.agencyId), body, key });
      assert.equal(write.status, 503, `attempt ${attempt}: ${write.text}`);
      assert.equal(write.json<{ retryable: boolean }>().retryable, true);
      const read = await call(w, { method: "GET", url: `/api/v1/agencies/${w.A.agencyId}`, agency: null, key: null });
      assert.equal(read.status, 503, read.text);
    }
    assert.equal(await w.count("end_clients"), before, "nothing was written while the database was unreachable");
  } finally {
    await w.h.oracle.query(`ALTER ROLE ${role} LOGIN`);
  }
  let done = null as Awaited<ReturnType<typeof call>> | null;
  for (let i = 0; i < 20 && done === null; i++) {
    const r = await call(w, { url: routes.createClient(w.A.agencyId), body, key });
    if (r.status === 201) done = r;
    else assert.equal(r.status, 503, r.text);
  }
  assert.ok(done !== null, "the retry completed after the database returned");
  const replay = await call(w, { url: routes.createClient(w.A.agencyId), body, key });
  assert.equal(completed<{ clientId: string }>(replay, 201).replayed, true, "the same key replays");
  assert.equal(await w.count("end_clients"), before + 1, "exactly one client");
});
