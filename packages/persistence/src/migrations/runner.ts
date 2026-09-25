/**
 * Migration runner (07 "Restoration and migration": expand, compatible backfill and later contract; checksums and applied
 * versions are recorded; migration roles are separate from runtime; lock timeouts are explicit).
 *
 * Each file migrations/NNNN_name.sql is applied once, inside its own transaction, as the owner role; its SHA-256 is recorded
 * in kauro_meta.schema_migrations. A file that was applied and later changed on disk is a drift error: the runner refuses to
 * continue until the recorded checksum and the file agree (a silently edited migration cannot pass as the applied one).
 *
 * Runners serialize (review finding R33): several processes may migrate the same database at once — two API instances
 * migrating on start (07 "Connection budget" plans two). Each run first takes a session-level advisory lock of the database
 * (MIGRATION_RUNNER_LOCK), then creates the ledger if needed and reads it *under the lock*, applies what is still pending and
 * releases the lock: a runner that waited finds its peer's work recorded and skips it instead of failing on the bootstrap DDL
 * or re-running a committed file. Every statement is bounded (review finding R37; 07 "lock timeouts are explicit"): each
 * transaction sets lock_timeout and statement_timeout locally, the wait for a peer's lock is bounded by the statement timeout,
 * and the dedicated migrator connection has a connect timeout.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

/** The package root is the nearest ancestor holding this package's package.json (works from src/ and from dist/src/). */
function packageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@kauro/persistence") return dir;
    } catch {
      // not here; walk up
    }
    dir = join(dir, "..");
  }
  throw new Error("@kauro/persistence package root not found above " + start);
}

export const MIGRATIONS_DIR = join(packageRoot(here), "migrations");

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

export function listMigrations(dir: string = MIGRATIONS_DIR): ReadonlyArray<MigrationFile> {
  const files = readdirSync(dir).filter((f) => FILE_NAME.test(f)).sort();
  const out: MigrationFile[] = [];
  const seen = new Set<number>();
  for (const file of files) {
    const m = FILE_NAME.exec(file)!;
    const version = Number.parseInt(m[1]!, 10);
    if (seen.has(version)) throw new Error(`duplicate migration version ${version} (${file})`);
    seen.add(version);
    const sql = readFileSync(join(dir, file), "utf8");
    out.push({ version, name: m[2]!, file, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.version !== i + 1) throw new Error(`migration versions must be contiguous from 0001; found ${out[i]!.file} at position ${i + 1}`);
  }
  return out;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly appliedBy: string;
}

export class MigrationDriftError extends Error {
  constructor(file: string, recorded: string, actual: string) {
    super(`migration ${file} was applied with checksum ${recorded} but the file now hashes to ${actual}`);
    this.name = "MigrationDriftError";
  }
}

const BOOTSTRAP = `
CREATE SCHEMA IF NOT EXISTS kauro_meta;
CREATE TABLE IF NOT EXISTS kauro_meta.schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  checksum    text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);
`;

export interface ApplyOptions {
  readonly dir?: string;
  /** lock_timeout of every statement the runner runs (07: lock timeouts are explicit). Default 5 s. */
  readonly lockTimeoutMs?: number;
  /** statement_timeout of every statement the runner runs; also the bound of the wait for a peer runner's lock. Default 120 s. */
  readonly statementTimeoutMs?: number;
}

export const DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS = 120_000;
export const DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS = 5_000;

/**
 * The advisory lock every runner holds while it reads the ledger and applies migrations (two-key form, database-scoped):
 * the ASCII words KAUR and MIGR as 32-bit integers. Exported so an operator, or a test, can see or hold it (pg_locks,
 * locktype advisory, classid/objid).
 */
export const MIGRATION_RUNNER_LOCK = Object.freeze({ classId: 0x4b415552, objectId: 0x4d494752 });

function millis(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback));
}

/** Runs `work` in one transaction whose lock and statement timeouts are set locally (the caller's session is left as it was). */
async function bounded<T>(client: Client, lockTimeoutMs: number, statementTimeoutMs: number, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    const out = await work();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([e, rollbackError], "migration runner transaction failed and could not be rolled back on this connection");
    }
    throw e;
  }
}

export interface ApplyResult {
  readonly applied: ReadonlyArray<MigrationFile>;
  readonly skipped: ReadonlyArray<MigrationFile>;
}

/**
 * Applies every pending migration on `client` (connected as the owner role). Idempotent: a second run applies nothing.
 * Serialized with every other runner of the same database by MIGRATION_RUNNER_LOCK, held from before the ledger is read
 * until the last pending file committed (R33).
 */
export async function applyMigrations(client: Client, options: ApplyOptions = {}): Promise<ApplyResult> {
  const files = listMigrations(options.dir ?? MIGRATIONS_DIR);
  const lockTimeoutMs = millis(options.lockTimeoutMs, DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS);
  const statementTimeoutMs = millis(options.statementTimeoutMs, DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS);
  const key = [MIGRATION_RUNNER_LOCK.classId, MIGRATION_RUNNER_LOCK.objectId];
  // a peer runner may hold the lock for a whole run: the wait is bounded by one statement budget, not by the short lock timeout
  await bounded(client, statementTimeoutMs, statementTimeoutMs, () => client.query("SELECT pg_advisory_lock($1, $2)", key));
  let result: ApplyResult;
  try {
    result = await applyUnderRunnerLock(client, files, lockTimeoutMs, statementTimeoutMs);
  } catch (e) {
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2)", key);
    } catch (unlockError) {
      // the connection itself failed; the server releases a session lock when the session ends, and both failures are reported
      throw new AggregateError([e, unlockError], "migration run failed and the runner lock could not be released on this connection");
    }
    throw e;
  }
  const released = await client.query<{ released: boolean }>("SELECT pg_advisory_unlock($1, $2) AS released", key);
  if (released.rows[0]?.released !== true) throw new Error("the migration runner lock was not held at the end of the run");
  return result;
}

async function applyUnderRunnerLock(client: Client, files: ReadonlyArray<MigrationFile>, lockTimeoutMs: number, statementTimeoutMs: number): Promise<ApplyResult> {
  // the ledger is created and read only once the lock is held: whatever a peer applied while this runner waited is seen here
  const recorded = await bounded(client, lockTimeoutMs, statementTimeoutMs, async () => {
    await client.query(BOOTSTRAP);
    return client.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM kauro_meta.schema_migrations ORDER BY version");
  });
  const byVersion = new Map(recorded.rows.map((r) => [r.version, r]));
  const applied: MigrationFile[] = [];
  const skipped: MigrationFile[] = [];
  for (const f of files) {
    const rec = byVersion.get(f.version);
    if (rec) {
      if (rec.checksum !== f.checksum) throw new MigrationDriftError(f.file, rec.checksum, f.checksum);
      skipped.push(f);
      continue;
    }
    try {
      await bounded(client, lockTimeoutMs, statementTimeoutMs, async () => {
        await client.query(f.sql);
        await client.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [f.version, f.name, f.checksum]);
      });
    } catch (e) {
      throw new Error(`migration ${f.file} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    applied.push(f);
  }
  return { applied, skipped };
}

export async function appliedMigrations(client: Client): Promise<ReadonlyArray<AppliedMigration>> {
  await client.query(BOOTSTRAP);
  const r = await client.query<{ version: number; name: string; checksum: string; applied_at: Date; applied_by: string }>(
    "SELECT version, name, checksum, applied_at, applied_by FROM kauro_meta.schema_migrations ORDER BY version",
  );
  return r.rows.map((x) => ({ version: x.version, name: x.name, checksum: x.checksum, appliedAt: x.applied_at.toISOString(), appliedBy: x.applied_by }));
}

/** Where the migrator connects (07 "Restoration and migration": migration roles are separate from runtime). */
export interface MigratorConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The owner role of the kauro objects (LOGIN, not SUPERUSER, not BYPASSRLS); never a runtime login role. */
  readonly user: string;
  readonly password?: string;
  readonly applicationName?: string;
}

export class MigratorRoleError extends Error {
  constructor(role: string, what: string) {
    super(`migrator role ${role} is ${what}; migrations run as the owner role only (07 Restoration and migration, 08 Database isolation)`);
    this.name = "MigratorRoleError";
  }
}

/**
 * Opens one dedicated connection as the migrator, refuses a superuser or BYPASSRLS login (the schema's own guard in
 * migration 0001 runs only on first application; this check runs every time), applies every pending migration and closes
 * the connection. Used by an entrypoint that migrates on start; the runtime pool is never involved.
 */
export interface ApplyAsOptions extends ApplyOptions {
  /** Bound of the whole connection start-up of the migrator (TCP, authentication, ready for query). Default 5 s (R37). */
  readonly connectTimeoutMs?: number;
}

export async function applyMigrationsAs(connection: MigratorConnection, options: ApplyAsOptions = {}): Promise<ApplyResult> {
  const client = new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ...(connection.password === undefined ? {} : { password: connection.password }),
    application_name: connection.applicationName ?? "kauro-migrator",
    connectionTimeoutMillis: millis(options.connectTimeoutMs, DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS),
    // session defaults for the statements outside the runner's own transactions (the role check below)
    statement_timeout: millis(options.statementTimeoutMs, DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS),
    lock_timeout: millis(options.lockTimeoutMs, DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS),
  });
  await client.connect();
  try {
    const r = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolname, rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user");
    const role = r.rows[0];
    if (!role) throw new MigratorRoleError(connection.user, "unknown to the server");
    if (role.rolsuper) throw new MigratorRoleError(role.rolname, "SUPERUSER");
    if (role.rolbypassrls) throw new MigratorRoleError(role.rolname, "BYPASSRLS");
    return await applyMigrations(client, options);
  } finally {
    await client.end();
  }
}
