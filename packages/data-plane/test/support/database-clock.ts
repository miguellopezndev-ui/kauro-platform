// The database clock of the data-plane tests: a real PostgreSQL 17 cluster started for the test file (never a clock stand-in).
// The scan instant of the labelled scanner fake is read from the database (design D-INSP-4: the worker reads its scan instant from
// the database clock, SourceUnitOfWork.serverInstant(), whose shipped kauro.server_now() is transaction_timestamp()). This package
// is an adapter and may not import @kauro/persistence (architecture.rules.json), so the test starts a bare cluster itself — initdb,
// pg_ctl on a free 127.0.0.1 port — and reads transaction_timestamp() through psql; stop() shuts it down and removes its directory.
// Binaries: env PGBIN first, then C:\Tools\pgsql17\bin on Windows, /usr/lib/postgresql/17/bin elsewhere (as @kauro/persistence).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DatabaseClock {
  readonly port: number;
  /** The database's transaction time of one statement, as a UTC instant with microseconds ("…T…Z"). */
  now(): Promise<string>;
  /** Every reading so far, in order (the test's record of when the clock was consulted). */
  readonly readings: string[];
  stop(): Promise<void>;
}

function pgbin(): string {
  const fromEnv = process.env["PGBIN"];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const fallback = process.platform === "win32" ? "C:\\Tools\\pgsql17\\bin" : "/usr/lib/postgresql/17/bin";
  if (!existsSync(fallback)) throw new Error(`PostgreSQL 17 binaries not found: set PGBIN (looked at ${fromEnv ?? "(unset)"} and ${fallback})`);
  return fallback;
}

function exe(bin: string, name: string): string {
  return join(bin, process.platform === "win32" ? `${name}.exe` : name);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

const CLOCK_SQL = `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');\n`;

export async function startDatabaseClock(): Promise<DatabaseClock> {
  const bin = pgbin();
  const base = mkdtempSync(join(tmpdir(), "kauro-dp-pg-"));
  const dataDir = join(base, "data");
  const logFile = join(base, "postgres.log");
  const init = spawnSync(exe(bin, "initdb"), ["-D", dataDir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-locale"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (init.status !== 0) {
    rmSync(base, { recursive: true, force: true });
    throw new Error(`initdb failed: ${init.stderr}`);
  }
  const port = await freePort();
  const options = [`-p ${port}`, "-c listen_addresses=127.0.0.1", "-c fsync=off", "-c max_connections=10"];
  if (process.platform !== "win32") options.push(`-k ${base}`);
  // pg_ctl start hands its stdio to the server it launches: the launcher runs with ignored stdio, the server logs to its file
  const start = spawnSync(exe(bin, "pg_ctl"), ["-D", dataDir, "-l", logFile, "-o", options.join(" "), "-w", "-t", "60", "start"], { windowsHide: true, stdio: "ignore", timeout: 120_000 });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    spawnSync(exe(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], { windowsHide: true, stdio: "ignore", timeout: 60_000 });
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  };
  if (start.status !== 0) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2_000) : "";
    await stop();
    throw new Error(`pg_ctl start failed: ${log}`);
  }
  const readings: string[] = [];
  const now = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const psql = spawn(exe(bin, "psql"), ["-X", "-q", "-A", "-t", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      psql.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      psql.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
      psql.on("error", reject);
      psql.on("close", (code) => {
        const value = out.trim();
        if (code !== 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
          reject(new Error(`psql clock read failed (exit ${String(code)}): ${err}`));
          return;
        }
        readings.push(value);
        resolve(value);
      });
      psql.stdin.end(CLOCK_SQL);
    });
  try {
    await now();
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, now, readings, stop };
}
