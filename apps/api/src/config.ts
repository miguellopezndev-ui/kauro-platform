/**
 * Configuration of the api process, read from the environment once at start (14 "Deployment and rollback": staging and
 * production use the accepted artifact and explicit environment configuration; 08 "Secrets and supply chain": secrets are
 * referenced by the deployment configuration and never live in the repository; 07 "Connection budget and operating limits":
 * the pool ceiling is a capacity decision, so it is a required input rather than a library default, and it stays inside the
 * API's budget of four connections per instance; 07 "Restoration and migration": migration roles are separate from runtime —
 * the serving process never receives the owner's password (re-check finding N7): SANDBOX and LIVE apply migrations with the
 * one-shot job of the same artifact (`node dist/src/migrate.js`, loadMigrationJobConfig) before traffic shifts, and the
 * LOCAL-only migrations on start read the password from a file, never from the environment; the migrator is never the
 * runtime login; 14 "Identity matrix": the API identity accesses the domain database only).
 *
 * Every variable is validated here; a malformed or missing value refuses the start with the variable name (never its value).
 */
import { readFileSync } from "node:fs";
import type { Environment } from "@kauro/domain";
import { ENVIRONMENTS } from "@kauro/domain";
import { DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS, DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS, DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS } from "@kauro/persistence";

export interface DatabaseConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
}

/** The HTTP side: where to listen, whom to trust for the client address, and every deadline of a request's life. */
export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  /** Proxy hops in front of the process whose X-Forwarded-For entries name the client (R34); 0 trusts none. */
  readonly trustedProxyHops: number;
  /** Whole-request deadline, headers and body (R36). */
  readonly requestTimeoutMs: number;
  /** Socket inactivity deadline (R36). */
  readonly connectionTimeoutMs: number;
  /** How long a SIGTERM drain may take before the remaining connections are closed and the process exits (R35). */
  readonly shutdownDeadlineMs: number;
}

/** The owner role that applies pending migrations — without its password, which is never configuration (R44, N7). */
export interface MigratorConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** R37: bounds of the migrator's connection start-up, of each statement, and of each lock wait. */
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  /**
   * KAURO_DB_MIGRATOR_PASSWORD_FILE: a file (a mounted secret) holding the owner's password, read once when the migration
   * connection opens. The path is configuration; the password never is, and it never enters an environment block (N7).
   */
  readonly passwordFile: string | null;
}

export interface ApiConfig {
  readonly environment: Environment;
  readonly http: HttpConfig;
  /** The runtime login role (a member of kauro_app, never the owner, never a superuser: 08 "Database isolation"). */
  readonly database: DatabaseConnectionConfig & { readonly poolMax: number; readonly statementTimeoutMs: number };
  /**
   * Present only when KAURO_DB_MIGRATE_ON_START=true, which the LOCAL environment alone accepts: the owner role that applies
   * pending migrations before the pool opens (N7: SANDBOX and LIVE migrate with the one-shot job instead).
   */
  readonly migrateOnStart: MigratorConfig | null;
  /** LOCAL only: a JSON file binding opaque bearer tokens to authenticated subjects (design 12b I-AUTH-1). */
  readonly bearerTokensFile: string | null;
}

/** 07 "Connection budget": the API runs at most two instances with four connections each (R43). */
export const API_POOL_CEILING = 4;

/**
 * The shutdown deadline stays below the platform's grace period: Cloud Run (14 "Initial architecture") sends SIGKILL ten
 * seconds after SIGTERM, so a drain that has not finished by nine seconds is ended by the process itself (R35).
 */
export const SHUTDOWN_DEADLINE_CEILING_MS = 9_000;

/**
 * The migrator's password in an environment: accepted by the one-shot migration job only. The serving process refuses it by
 * name (N7): deleting a variable from process.env does not remove it from the initial environment block the operating system
 * keeps for the process (/proc/<pid>/environ on Linux), so a serving process that was given it would hold the owner's
 * credential for its whole life.
 */
export const MIGRATOR_PASSWORD_VARIABLE = "KAURO_DB_MIGRATOR_PASSWORD";
/** The migrator's password as a file (a mounted secret): the one-shot job, or LOCAL migrations on start (N7). */
export const MIGRATOR_PASSWORD_FILE_VARIABLE = "KAURO_DB_MIGRATOR_PASSWORD_FILE";

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

function migratorOf(env: Env, host: string, port: number, database: string, runtimeUser: string | undefined): MigratorConfig {
  const migratorUser = roleName(env, "KAURO_DB_MIGRATOR_USER");
  if (migratorUser === runtimeUser) throw new ConfigError("KAURO_DB_MIGRATOR_USER", "must differ from KAURO_DB_USER (migration roles are separate from runtime)");
  return {
    host,
    port,
    database,
    user: migratorUser,
    connectTimeoutMs: integer(env, "KAURO_DB_MIGRATOR_CONNECT_TIMEOUT_MS", DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS, 100, 60_000),
    statementTimeoutMs: integer(env, "KAURO_DB_MIGRATOR_STATEMENT_TIMEOUT_MS", DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS, 1_000, 3_600_000),
    lockTimeoutMs: integer(env, "KAURO_DB_MIGRATOR_LOCK_TIMEOUT_MS", DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS, 100, 600_000),
    passwordFile: optional(env, MIGRATOR_PASSWORD_FILE_VARIABLE) ?? null,
  };
}

/**
 * Reads a secret from a file (a mounted secret): the content without one trailing line break. A refusal names the variable
 * that named the file and the error class, never the content.
 */
export function readSecretFile(variable: string, path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string" ? String((e as NodeJS.ErrnoException).code) : "unreadable";
    throw new ConfigError(variable, `names a file that cannot be read (${code})`);
  }
  const value = raw.replace(/\r?\n$/, "");
  if (value === "") throw new ConfigError(variable, "names an empty file");
  return value;
}

export function loadConfig(env: Env = process.env): ApiConfig {
  const environment = environmentOf(env);
  // N7: the serving process never receives the owner's credential in its environment, whatever the mode (08 "privileged
  // migration roles are never used by request handlers"; 07 "Migration roles are separate from runtime")
  if (optional(env, MIGRATOR_PASSWORD_VARIABLE) !== undefined) {
    throw new ConfigError(MIGRATOR_PASSWORD_VARIABLE, "is never accepted by the serving process: the one-shot migration job (node dist/src/migrate.js) holds the owner's credential");
  }
  const host = optional(env, "KAURO_DB_HOST") ?? "127.0.0.1";
  const port = integer(env, "KAURO_DB_PORT", 5432, 1, 65535);
  const database = optional(env, "KAURO_DB_NAME") ?? "kauro";
  const runtimeUser = roleName(env, "KAURO_DB_USER");
  const runtimePassword = optional(env, "KAURO_DB_PASSWORD");
  const migrate = flag(env, "KAURO_DB_MIGRATE_ON_START", false);
  let migrateOnStart: MigratorConfig | null = null;
  if (migrate) {
    if (environment !== "LOCAL") {
      throw new ConfigError("KAURO_DB_MIGRATE_ON_START", "is accepted in the LOCAL environment only: SANDBOX and LIVE apply migrations with the one-shot job (node dist/src/migrate.js) before traffic shifts");
    }
    migrateOnStart = migratorOf(env, host, port, database, runtimeUser);
  } else if (optional(env, MIGRATOR_PASSWORD_FILE_VARIABLE) !== undefined) {
    throw new ConfigError(MIGRATOR_PASSWORD_FILE_VARIABLE, "is accepted only with KAURO_DB_MIGRATE_ON_START=true");
  }
  const bearerTokensFile = optional(env, "KAURO_AUTH_BEARER_TOKENS_FILE") ?? null;
  if (bearerTokensFile !== null && environment !== "LOCAL") throw new ConfigError("KAURO_AUTH_BEARER_TOKENS_FILE", "is accepted in the LOCAL environment only");
  return {
    environment,
    http: {
      host: optional(env, "KAURO_HTTP_HOST") ?? "127.0.0.1",
      port: integer(env, "KAURO_HTTP_PORT", 3000, 1, 65535),
      // behind the platform's load balancer the hop count is a deployment fact, so outside LOCAL it has no default
      trustedProxyHops: integer(env, "KAURO_HTTP_TRUSTED_PROXY_HOPS", environment === "LOCAL" ? 0 : undefined, 0, 4),
      requestTimeoutMs: integer(env, "KAURO_HTTP_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
      connectionTimeoutMs: integer(env, "KAURO_HTTP_CONNECTION_TIMEOUT_MS", 60_000, 1_000, 600_000),
      shutdownDeadlineMs: integer(env, "KAURO_SHUTDOWN_DEADLINE_MS", 8_000, 100, SHUTDOWN_DEADLINE_CEILING_MS),
    },
    database: {
      host,
      port,
      database,
      user: runtimeUser,
      ...(runtimePassword === undefined ? {} : { password: runtimePassword }),
      poolMax: integer(env, "KAURO_DB_POOL_MAX", undefined, 1, API_POOL_CEILING),
      statementTimeoutMs: integer(env, "KAURO_DB_STATEMENT_TIMEOUT_MS", 10_000, 100, 120_000),
    },
    migrateOnStart,
    bearerTokensFile,
  };
}

/** The one-shot migration job's configuration (N7): the owner role, its limits and, when given, its password file. */
export interface MigrationJobConfig {
  readonly environment: Environment;
  readonly migrator: MigratorConfig;
}

/**
 * Configuration of the one-shot migration job (`node dist/src/migrate.js`; 14 "Deployment and rollback": the schema moves
 * before traffic shifts to the release that needs it). The job is not a serving process: it may receive the owner's password
 * as KAURO_DB_MIGRATOR_PASSWORD or as a file (KAURO_DB_MIGRATOR_PASSWORD_FILE), never both, and it ends when the migrations
 * are applied. Like loadConfig it never keeps the password.
 */
export function loadMigrationJobConfig(env: Env = process.env): MigrationJobConfig {
  const environment = environmentOf(env);
  if (optional(env, MIGRATOR_PASSWORD_VARIABLE) !== undefined && optional(env, MIGRATOR_PASSWORD_FILE_VARIABLE) !== undefined) {
    throw new ConfigError(MIGRATOR_PASSWORD_FILE_VARIABLE, `is exclusive with ${MIGRATOR_PASSWORD_VARIABLE}`);
  }
  const host = optional(env, "KAURO_DB_HOST") ?? "127.0.0.1";
  const port = integer(env, "KAURO_DB_PORT", 5432, 1, 65535);
  const database = optional(env, "KAURO_DB_NAME") ?? "kauro";
  return { environment, migrator: migratorOf(env, host, port, database, optional(env, "KAURO_DB_USER")) };
}
