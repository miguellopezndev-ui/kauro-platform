/**
 * Migration runner (07 "Restoration and migration": expand, compatible backfill and later contract; checksums and applied
 * versions are recorded; migration roles are separate from runtime; lock timeouts are explicit).
 *
 * Each file migrations/NNNN_name.sql is applied once, inside its own transaction, as the owner role; its SHA-256 is recorded
 * in kauro_meta.schema_migrations. A file that was applied and later changed on disk is a drift error: the runner refuses to
 * continue until the recorded checksum and the file agree (a silently edited migration cannot pass as the applied one).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

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
  /** lock_timeout for every migration transaction (07: lock timeouts are explicit). Default 5 s. */
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export interface ApplyResult {
  readonly applied: ReadonlyArray<MigrationFile>;
  readonly skipped: ReadonlyArray<MigrationFile>;
}

/** Applies every pending migration on `client` (connected as the owner role). Idempotent: a second run applies nothing. */
export async function applyMigrations(client: Client, options: ApplyOptions = {}): Promise<ApplyResult> {
  const files = listMigrations(options.dir ?? MIGRATIONS_DIR);
  await client.query(BOOTSTRAP);
  const recorded = await client.query<{ version: number; name: string; checksum: string }>("SELECT version, name, checksum FROM kauro_meta.schema_migrations ORDER BY version");
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
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(options.lockTimeoutMs ?? 5000))}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(options.statementTimeoutMs ?? 120_000))}ms'`);
      await client.query(f.sql);
      await client.query("INSERT INTO kauro_meta.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [f.version, f.name, f.checksum]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
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
