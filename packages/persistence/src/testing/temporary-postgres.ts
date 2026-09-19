/**
 * Real PostgreSQL 17 for tests (07 "Acceptance obligations": use real PostgreSQL for tenant constraints, transactions,
 * migrations and concurrency; fakes cannot prove RLS, unique constraints, lock behaviour or pool reset).
 *
 * startTemporaryPostgres() runs initdb into a fresh directory, starts the server on a free 127.0.0.1 port, creates the
 * database and the roles the platform expects, applies the migrations as the owner role, creates login roles that are
 * members of the runtime group roles, and returns connection factories. stop() shuts the server down and removes the
 * directory. Binaries: env PGBIN first, then C:\Tools\pgsql17\bin on Windows, /usr/lib/postgresql/17/bin on Linux.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { applyMigrations, type ApplyResult } from "../migrations/runner.js";

export const ROLES = Object.freeze({
  owner: "kauro_owner",
  app: "kauro_app",
  control: "kauro_control",
  appLogin: "kauro_app_test",
  controlLogin: "kauro_control_test",
  superuser: "postgres",
  database: "kauro",
});

export interface TemporaryPostgres {
  readonly port: number;
  readonly dataDir: string;
  readonly migrations: ApplyResult;
  /** A connected client as the given role (LOGIN roles only). The caller ends it. */
  connect(role: "postgres" | "kauro_owner" | "kauro_app_test" | "kauro_control_test"): Promise<Client>;
  stop(): Promise<void>;
}

function pgbin(): string {
  const fromEnv = process.env["PGBIN"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fallback = process.platform === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin";
  if (!existsSync(fallback)) throw new Error(`PostgreSQL 17 binaries not found: set PGBIN (looked at ${fromEnv ?? "(unset)"} and ${fallback})`);
  return fallback;
}

function exe(bin: string, name: string): string {
  return join(bin, process.platform === "win32" ? `${name}.exe` : name);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], what: string, options: { readonly detached?: boolean; readonly logFile?: string } = {}): void {
  // pg_ctl start hands its stdio to the server it launches; with piped stdio spawnSync would wait for the server to exit.
  // The server writes to its own log file, so the launcher runs with ignored stdio and the log is read on failure.
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, stdio: options.detached ? "ignore" : "pipe", timeout: 120_000 });
  if (r.status !== 0) {
    let log = "";
    if (options.logFile && existsSync(options.logFile)) log = readFileSync(options.logFile, "utf8").slice(-2000);
    throw new Error(`${what} failed (exit ${r.status ?? "signal " + r.signal}): ${r.stdout ?? ""}\n${r.stderr ?? ""}\n${log}`);
  }
}

export interface StartOptions {
  /** Skip applying migrations (a test that exercises the runner itself). */
  readonly migrate?: boolean;
}

export async function startTemporaryPostgres(options: StartOptions = {}): Promise<TemporaryPostgres> {
  const bin = pgbin();
  const base = mkdtempSync(join(tmpdir(), "kauro-pg-"));
  const dataDir = join(base, "data");
  run(exe(bin, "initdb"), ["-D", dataDir, "-U", ROLES.superuser, "-A", "trust", "-E", "UTF8", "--no-locale"], "initdb");
  const port = await freePort();
  const serverOptions = [`-p ${port}`, "-c listen_addresses=127.0.0.1", "-c fsync=off", "-c synchronous_commit=off", "-c full_page_writes=off", "-c max_connections=40"];
  if (process.platform !== "win32") serverOptions.push(`-k ${base}`);
  const logFile = join(base, "postgres.log");
  run(exe(bin, "pg_ctl"), ["-D", dataDir, "-l", logFile, "-o", serverOptions.join(" "), "-w", "-t", "60", "start"], "pg_ctl start", { detached: true, logFile });

  const connect = async (role: string, database: string = ROLES.database): Promise<Client> => {
    const c = new Client({ host: "127.0.0.1", port, user: role, database, application_name: `kauro-test-${role}` });
    await c.connect();
    return c;
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    spawnSync(exe(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { encoding: "utf8", windowsHide: true, stdio: "ignore", timeout: 60_000 });
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  };

  try {
    const su = await connect(ROLES.superuser, "postgres");
    try {
      await su.query(`CREATE ROLE ${ROLES.owner} LOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS NOCREATEDB`);
      await su.query(`CREATE DATABASE ${ROLES.database} OWNER ${ROLES.owner}`);
    } finally {
      await su.end();
    }
    let migrations: ApplyResult = { applied: [], skipped: [] };
    if (options.migrate !== false) {
      const owner = await connect(ROLES.owner);
      try {
        migrations = await applyMigrations(owner);
      } finally {
        await owner.end();
      }
      const su2 = await connect(ROLES.superuser, "postgres");
      try {
        await su2.query(`CREATE ROLE ${ROLES.appLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.app}`);
        await su2.query(`CREATE ROLE ${ROLES.controlLogin} LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${ROLES.control}`);
      } finally {
        await su2.end();
      }
    }
    return {
      port,
      dataDir,
      migrations,
      connect: (role) => connect(role),
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
