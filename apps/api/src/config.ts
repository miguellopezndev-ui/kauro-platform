/**
 * Configuration of the api process, read from the environment once at start (14 "Deployment and rollback": staging and
 * production use the accepted artifact and explicit environment configuration; 08 "Secrets and supply chain": secrets are
 * referenced by the deployment configuration and never live in the repository; 07 "Connection budget and operating limits":
 * the pool ceiling is a capacity decision, so it is a required input rather than a library default; 07 "Restoration and
 * migration": migration roles are separate from runtime — the migrator credentials are read only when migrations on start
 * are enabled and are never the runtime login; 14 "Identity matrix": the API identity accesses the domain database only).
 *
 * Every variable is validated here; a malformed or missing value refuses the start with the variable name (never its value).
 */
import type { Environment } from "@kauro/domain";
import { ENVIRONMENTS } from "@kauro/domain";

export interface DatabaseConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
}

export interface ApiConfig {
  readonly environment: Environment;
  readonly http: { readonly host: string; readonly port: number };
  /** The runtime login role (a member of kauro_app, never the owner, never a superuser: 08 "Database isolation"). */
  readonly database: DatabaseConnectionConfig & { readonly poolMax: number; readonly statementTimeoutMs: number };
  /** Present only when KAURO_DB_MIGRATE_ON_START=true: the owner role that applies pending migrations before the pool opens. */
  readonly migrateOnStart: DatabaseConnectionConfig | null;
  /** LOCAL only: a JSON file binding opaque bearer tokens to authenticated subjects (design 12b I-AUTH-1). */
  readonly bearerTokensFile: string | null;
}

export class ConfigError extends Error {
  constructor(variable: string, problem: string) {
    super(`${variable}: ${problem}`);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") throw new ConfigError(name, "is required");
  return v;
}

function optional(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function integer(env: Env, name: string, fallback: number | undefined, min: number, max: number): number {
  const raw = optional(env, name);
  if (raw === undefined) {
    if (fallback === undefined) throw new ConfigError(name, "is required");
    return fallback;
  }
  if (!/^\d+$/.test(raw)) throw new ConfigError(name, "must be a non-negative integer");
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(name, `must be between ${min} and ${max}`);
  return n;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(name, "must be true or false");
}

function environmentOf(env: Env): Environment {
  const raw = required(env, "KAURO_ENVIRONMENT");
  if (!(ENVIRONMENTS as ReadonlyArray<string>).includes(raw)) throw new ConfigError("KAURO_ENVIRONMENT", `must be one of ${ENVIRONMENTS.join(", ")}`);
  return raw as Environment;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function roleName(env: Env, name: string): string {
  const v = required(env, name);
  if (!ROLE_NAME.test(v)) throw new ConfigError(name, "must be a PostgreSQL role name");
  return v;
}

export function loadConfig(env: Env = process.env): ApiConfig {
  const environment = environmentOf(env);
  const host = optional(env, "KAURO_DB_HOST") ?? "127.0.0.1";
  const port = integer(env, "KAURO_DB_PORT", 5432, 1, 65535);
  const database = optional(env, "KAURO_DB_NAME") ?? "kauro";
  const runtimeUser = roleName(env, "KAURO_DB_USER");
  const runtimePassword = optional(env, "KAURO_DB_PASSWORD");
  const migrate = flag(env, "KAURO_DB_MIGRATE_ON_START", false);
  let migrateOnStart: DatabaseConnectionConfig | null = null;
  if (migrate) {
    const migratorUser = roleName(env, "KAURO_DB_MIGRATOR_USER");
    if (migratorUser === runtimeUser) throw new ConfigError("KAURO_DB_MIGRATOR_USER", "must differ from KAURO_DB_USER (migration roles are separate from runtime)");
    const migratorPassword = optional(env, "KAURO_DB_MIGRATOR_PASSWORD");
    migrateOnStart = { host, port, database, user: migratorUser, ...(migratorPassword === undefined ? {} : { password: migratorPassword }) };
  }
  const bearerTokensFile = optional(env, "KAURO_AUTH_BEARER_TOKENS_FILE") ?? null;
  if (bearerTokensFile !== null && environment !== "LOCAL") throw new ConfigError("KAURO_AUTH_BEARER_TOKENS_FILE", "is accepted in the LOCAL environment only");
  return {
    environment,
    http: { host: optional(env, "KAURO_HTTP_HOST") ?? "127.0.0.1", port: integer(env, "KAURO_HTTP_PORT", 3000, 1, 65535) },
    database: {
      host,
      port,
      database,
      user: runtimeUser,
      ...(runtimePassword === undefined ? {} : { password: runtimePassword }),
      poolMax: integer(env, "KAURO_DB_POOL_MAX", undefined, 1, 24),
      statementTimeoutMs: integer(env, "KAURO_DB_STATEMENT_TIMEOUT_MS", 10_000, 100, 120_000),
    },
    migrateOnStart,
    bearerTokensFile,
  };
}
