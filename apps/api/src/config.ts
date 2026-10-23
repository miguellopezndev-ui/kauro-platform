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
import { isApplicationOrigin, type CandidateActivation } from "@kauro/application";
import type { Environment } from "@kauro/domain";
import { ENVIRONMENTS, PROVIDER_CALL_TIMEOUT_MS } from "@kauro/domain";
import { ConnectionSecurityError, claimEnvironmentMinter, type DatabaseEnvironment, DEFAULT_MIGRATOR_CONNECT_TIMEOUT_MS, DEFAULT_MIGRATOR_LOCK_TIMEOUT_MS, DEFAULT_MIGRATOR_STATEMENT_TIMEOUT_MS, connectionSecurityOf, type ConnectionSecurityInput } from "@kauro/persistence";

export interface DatabaseConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  /** KAURO_DB_PASSWORD_FILE (I-3): the mounted secret holding the password; resolved by the composition, never kept here. */
  readonly passwordFile?: string;
  /** KAURO_DB_TLS_CA_FILE (I-2): the PEM file of the CA that signed the database's certificate; required outside LOCAL. */
  readonly tlsCaFile?: string;
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
  /** KAURO_DB_TLS_CA_FILE (I-2): required outside LOCAL. */
  readonly tlsCaFile?: string;
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

/**
 * The two public routes (B11 W5b; D-TOPO-2, D-PUB-2): the exact browser origins of the public site and of the application, and the
 * file of the key the inquiry digests are computed with (identical on every instance that shares the database).
 */
export interface PublicApiConfig {
  readonly publicOrigin: string;
  readonly appOrigin: string;
  readonly hashKeyFile: string;
}

export interface ApiConfig {
  readonly environment: Environment;
  /** The same environment as the brand every database connection requires (DB-TLS gap 2): minted here, from KAURO_ENVIRONMENT, only. */
  readonly databaseEnvironment: DatabaseEnvironment;
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
  /**
   * KAURO_API_CURSOR_KEY_FILE: a file (a mounted secret) of at least 32 bytes, the key list cursors are sealed with, shared by
   * every instance (N16). Required outside LOCAL; in LOCAL, when absent, each process uses a fresh random key.
   */
  readonly cursorKeyFile: string | null;
  /**
   * The browser session boundary (B11 design D-AUTH-*), or null when it is not bound (the B06 edition: LOCAL authenticates with
   * the bearer-token file, SANDBOX and LIVE refuse to start, I-INT-3). All of its variables come together or none does.
   */
  readonly identity: IdentityConfig | null;
  /** Present when KAURO_PUBLIC_ORIGIN, KAURO_APP_ORIGIN and KAURO_PUBLIC_HASH_KEY_FILE are all set; the public routes exist only then. */
  readonly publicApi: PublicApiConfig | null;
  /**
   * Behaviour built against the O19A re-issue candidate (Order 20), OFF by default: KAURO_CANDIDATE_CLEAN_NO_TARGET=true switches on CLEAN
   * without a target contract (CP-01.01, CP-02.01), in the LOCAL environment only until Order 19B adopts the candidate.
   */
  readonly candidate: CandidateActivation;
}

/** The session boundary's configuration (B11 W2). */
export interface IdentityConfig {
  /** KAURO_IDENTITY_KEY_SOURCE: GOOGLE_X509 (Identity Platform) or CONTRACT_FAKE (LOCAL only). */
  readonly keySource: "GOOGLE_X509" | "CONTRACT_FAKE";
  /** KAURO_IDENTITY_PROJECT_ID: the Google Cloud project id (the tokens' audience). */
  readonly projectId: string;
  /** KAURO_APP_ORIGINS: the exact browser origins of the application, comma-separated (CSRF and login-CSRF rule, D-AUTH-5). */
  readonly appOrigins: ReadonlyArray<string>;
  /** KAURO_IDENTITY_FAKE_JWKS_FILE: the contract fake's JWKS (CONTRACT_FAKE only). */
  readonly fakeJwksFile: string | null;
  /**
   * KAURO_IDENTITY_FAKE_ENDPOINT: where the page reaches the contract fake, announced to it (CONTRACT_FAKE only, optional): a path of the
   * application's own origin that the edge routes to the fake, so the page's connect-src stays 'self' (D-SEC-1; B11 D-INT1-4).
   */
  readonly fakeEndpoint: string | null;
  /**
   * KAURO_DB_ASSURANCE_USER / _PASSWORD / _POOL_MAX: the login of the authentication boundary group (kauro_assurance) and its
   * pool, which shares the api's connection budget with the runtime pool (07: four per instance).
   */
  readonly assuranceDatabase: { readonly user: string; readonly password?: string; readonly passwordFile?: string; readonly poolMax: number };
}

/** The variables of the session boundary: any one of them binds it, and then each required one is required by name. */
export const IDENTITY_VARIABLES = Object.freeze([
  "KAURO_IDENTITY_KEY_SOURCE",
  "KAURO_IDENTITY_PROJECT_ID",
  "KAURO_APP_ORIGINS",
  "KAURO_IDENTITY_FAKE_JWKS_FILE",
  "KAURO_IDENTITY_FAKE_ENDPOINT",
  "KAURO_DB_ASSURANCE_USER",
  "KAURO_DB_ASSURANCE_PASSWORD",
  "KAURO_DB_ASSURANCE_PASSWORD_FILE",
  "KAURO_DB_ASSURANCE_POOL_MAX",
]);

/** The session boundary's pool: one or two connections of the api's budget. */
export const ASSURANCE_POOL_CEILING = 2;

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
/** I-2: the CA of the database's certificate, a file path; every non-LOCAL connection verifies the server against it. */
export const DB_TLS_CA_FILE_VARIABLE = "KAURO_DB_TLS_CA_FILE";

/**
 * I-2, I-3: the one rule of connectionSecurityOf (persistence) validates the connection's secrets and TLS at start; its refusal
 * becomes a ConfigError naming the variable. The values it reads are not kept here: the composition resolves them again when it
 * opens the connection, so the rule has a single source.
 */
function checkConnectionSecurity(environment: Environment, input: ConnectionSecurityInput, env: Env): void {
  try {
    connectionSecurityOf(environment, { ...input, validateOnly: true, processEnv: env });
  } catch (e) {
    if (e instanceof ConnectionSecurityError) throw new ConfigError(e.variable, e.problem);
    throw e;
  }
}

/** The migrator's password as a file (a mounted secret): the one-shot job, or LOCAL migrations on start (N7). */
export const MIGRATOR_PASSWORD_FILE_VARIABLE = "KAURO_DB_MIGRATOR_PASSWORD_FILE";

/**
 * The unit of work's statement_timeout (D10-GAP-6a, ADV-14): never above PROVIDER_CALL_TIMEOUT_MS. The bound of a call made inside a unit of
 * work ends the wait and the unit abandons its backend; statement_timeout is what still ends that backend if the explicit end failed, so a
 * larger value would let an abandoned CMD043 backend hold its locks (the agency row included) for the difference. Refused outside LOCAL.
 */
export function statementTimeoutOf(env: Env, environment: Environment): number {
  const ms = integer(env, "KAURO_DB_STATEMENT_TIMEOUT_MS", PROVIDER_CALL_TIMEOUT_MS, 100, 120_000);
  // LOCAL only keeps the wider range: the lock-race tests of the harness (operability, R35) hold a lock for 10+ s and need the waiting command
  // to outlive the observation; no deployment (SANDBOX, LIVE) can run above the bound
  if (ms > PROVIDER_CALL_TIMEOUT_MS && environment !== "LOCAL") {
    throw new ConfigError("KAURO_DB_STATEMENT_TIMEOUT_MS", `must not exceed the provider call bound (${PROVIDER_CALL_TIMEOUT_MS} ms): an abandoned unit's backend would hold its locks beyond the bound (D10-GAP-6a)`);
  }
  return ms;
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

/** Order 20: CLEAN without a target contract, built against the O19A candidate; OFF unless set to true, LOCAL only. */
export const CANDIDATE_CLEAN_VARIABLE = "KAURO_CANDIDATE_CLEAN_NO_TARGET";

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ConfigError(name, "must be true or false");
}

// DB-TLS gap 2: the one production minter of a connection's environment, claimed once per process when this module loads (a second claim
// anywhere fails the load, so the environment of a connection has this one source)
const mintDatabaseEnvironment = claimEnvironmentMinter();

function environmentOf(env: Env): { readonly environment: Environment; readonly databaseEnvironment: DatabaseEnvironment } {
  const raw = required(env, "KAURO_ENVIRONMENT");
  if (!(ENVIRONMENTS as ReadonlyArray<string>).includes(raw)) throw new ConfigError("KAURO_ENVIRONMENT", `must be one of ${ENVIRONMENTS.join(", ")}`);
  return { environment: raw as Environment, databaseEnvironment: mintDatabaseEnvironment(raw) };
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function roleName(env: Env, name: string): string {
  const v = required(env, name);
  if (!ROLE_NAME.test(v)) throw new ConfigError(name, "must be a PostgreSQL role name");
  return v;
}

function migratorOf(env: Env, host: string, port: number, database: string, runtimeUser: string | undefined): MigratorConfig {
  const tlsCaFile = optional(env, DB_TLS_CA_FILE_VARIABLE);
  const migratorUser = roleName(env, "KAURO_DB_MIGRATOR_USER");
  if (migratorUser === runtimeUser) throw new ConfigError("KAURO_DB_MIGRATOR_USER", "must differ from KAURO_DB_USER (migration roles are separate from runtime)");
  return {
    host,
    port,
    database,
    user: migratorUser,
    ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
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
  const { environment, databaseEnvironment } = environmentOf(env);
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
  const runtimePasswordFile = optional(env, "KAURO_DB_PASSWORD_FILE");
  const tlsCaFile = optional(env, DB_TLS_CA_FILE_VARIABLE);
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
  const cleanWithoutTarget = flag(env, CANDIDATE_CLEAN_VARIABLE, false);
  if (cleanWithoutTarget && environment !== "LOCAL") throw new ConfigError(CANDIDATE_CLEAN_VARIABLE, "is accepted in the LOCAL environment only: the O19A candidate is not adopted (Order 19B)");
  const bearerTokensFile = optional(env, "KAURO_AUTH_BEARER_TOKENS_FILE") ?? null;
  if (bearerTokensFile !== null && environment !== "LOCAL") throw new ConfigError("KAURO_AUTH_BEARER_TOKENS_FILE", "is accepted in the LOCAL environment only");
  const config: ApiConfig = {
    environment,
    databaseEnvironment,
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
      ...(runtimePasswordFile === undefined ? {} : { passwordFile: runtimePasswordFile }),
      ...(tlsCaFile === undefined ? {} : { tlsCaFile }),
      poolMax: integer(env, "KAURO_DB_POOL_MAX", undefined, 1, API_POOL_CEILING),
      statementTimeoutMs: statementTimeoutOf(env, environment),
    },
    migrateOnStart,
    bearerTokensFile,
    cursorKeyFile: optional(env, CURSOR_KEY_FILE_VARIABLE) ?? null,
    identity: null,
    publicApi: publicApiOf(env, environment),
    candidate: { cleanWithoutTarget },
  };
  const identity = identityOf(env, environment, runtimeUser, config.database.poolMax, migrateOnStart?.user ?? null);
  // one application origin (B11 stage-1 integration, D-INT1-6): the origin the public inquiry accepts as the application's (W5b,
  // KAURO_APP_ORIGIN) is one of the origins the session boundary's CSRF rule accepts (W2, KAURO_APP_ORIGINS)
  if (identity !== null && config.publicApi !== null && !identity.appOrigins.includes(config.publicApi.appOrigin)) {
    throw new ConfigError("KAURO_APP_ORIGIN", "must be one of KAURO_APP_ORIGINS: the public routes and the session boundary serve one application origin");
  }
  // every instance behind the load balancer must open the cursors another one sealed (10 "Pagination, search and exports")
  if (config.cursorKeyFile === null && environment !== "LOCAL") throw new ConfigError(CURSOR_KEY_FILE_VARIABLE, "is required outside LOCAL: every instance seals and opens the same list cursors");
  // I-2, I-3: outside LOCAL the database is reached over verified TLS, by a DNS name, with file passwords, or not at all
  checkConnectionSecurity(environment, { host, ...(runtimePassword === undefined ? {} : { password: runtimePassword }), ...(runtimePasswordFile === undefined ? {} : { passwordFile: runtimePasswordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }) }, env);
  if (identity !== null) {
    const login = identity.assuranceDatabase;
    checkConnectionSecurity(environment, { host, ...(login.password === undefined ? {} : { password: login.password }), ...(login.passwordFile === undefined ? {} : { passwordFile: login.passwordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }), names: { password: "KAURO_DB_ASSURANCE_PASSWORD", passwordFile: "KAURO_DB_ASSURANCE_PASSWORD_FILE" } }, env);
  }
  return identity === null ? config : { ...config, identity };
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** The contract fake's address on the application origin (IdentityConfigView.endpoint). */
const FAKE_ENDPOINT_PATH = /^(?=.{2,200}$)(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/;

/** The session boundary's variables, validated together (null when none is set). */
function identityOf(env: Env, environment: Environment, runtimeUser: string, runtimePoolMax: number, migratorUser: string | null): IdentityConfig | null {
  if (!IDENTITY_VARIABLES.some((name) => optional(env, name) !== undefined)) return null;
  const keySource = required(env, "KAURO_IDENTITY_KEY_SOURCE");
  if (keySource !== "GOOGLE_X509" && keySource !== "CONTRACT_FAKE") throw new ConfigError("KAURO_IDENTITY_KEY_SOURCE", "must be GOOGLE_X509 or CONTRACT_FAKE");
  if (keySource === "CONTRACT_FAKE" && environment !== "LOCAL") throw new ConfigError("KAURO_IDENTITY_KEY_SOURCE", "CONTRACT_FAKE is accepted in the LOCAL environment only (B11 design D-AUTH-3)");
  const projectId = required(env, "KAURO_IDENTITY_PROJECT_ID");
  if (!PROJECT_ID.test(projectId)) throw new ConfigError("KAURO_IDENTITY_PROJECT_ID", "must be a Google Cloud project id (6..30 lowercase letters, digits and hyphens)");
  const origins = required(env, "KAURO_APP_ORIGINS").split(",");
  for (const origin of origins) {
    if (!isApplicationOrigin(origin, environment === "LOCAL")) {
      throw new ConfigError("KAURO_APP_ORIGINS", `must list exact origins (https://host[:port], lowercase, no path; http only for localhost in LOCAL), comma-separated`);
    }
  }
  if (new Set(origins).size !== origins.length) throw new ConfigError("KAURO_APP_ORIGINS", "names an origin twice");
  let fakeJwksFile: string | null = null;
  let fakeEndpoint: string | null = null;
  if (keySource === "CONTRACT_FAKE") {
    fakeJwksFile = required(env, "KAURO_IDENTITY_FAKE_JWKS_FILE");
    fakeEndpoint = optional(env, "KAURO_IDENTITY_FAKE_ENDPOINT") ?? null;
    if (fakeEndpoint !== null && !FAKE_ENDPOINT_PATH.test(fakeEndpoint)) throw new ConfigError("KAURO_IDENTITY_FAKE_ENDPOINT", "must be a path of the application origin (/segment[/segment]..., no dot segment, at most 200 characters)");
  } else {
    for (const name of ["KAURO_IDENTITY_FAKE_JWKS_FILE", "KAURO_IDENTITY_FAKE_ENDPOINT"]) {
      if (optional(env, name) !== undefined) throw new ConfigError(name, "is accepted with KAURO_IDENTITY_KEY_SOURCE=CONTRACT_FAKE only");
    }
  }
  const user = roleName(env, "KAURO_DB_ASSURANCE_USER");
  if (user === runtimeUser || user === migratorUser) throw new ConfigError("KAURO_DB_ASSURANCE_USER", "must be its own login of kauro_assurance, neither the request handlers' nor the migrator's");
  const poolMax = integer(env, "KAURO_DB_ASSURANCE_POOL_MAX", undefined, 1, ASSURANCE_POOL_CEILING);
  if (runtimePoolMax + poolMax > API_POOL_CEILING) {
    throw new ConfigError("KAURO_DB_ASSURANCE_POOL_MAX", `with KAURO_DB_POOL_MAX it exceeds the api's ${API_POOL_CEILING} connections per instance (07 connection budget)`);
  }
  const password = optional(env, "KAURO_DB_ASSURANCE_PASSWORD");
  const passwordFile = optional(env, "KAURO_DB_ASSURANCE_PASSWORD_FILE");
  return { keySource, projectId, appOrigins: origins, fakeJwksFile, fakeEndpoint, assuranceDatabase: { user, ...(password === undefined ? {} : { password }), ...(passwordFile === undefined ? {} : { passwordFile }), poolMax } };
}

/** The variables that bind the public routes: all three or none. */
export const PUBLIC_API_VARIABLES = Object.freeze(["KAURO_PUBLIC_ORIGIN", "KAURO_APP_ORIGIN", "KAURO_PUBLIC_HASH_KEY_FILE"] as const);

/**
 * An exact browser origin as the Origin header carries it: https://host[:port], lowercase, no path or trailing slash; http only
 * for localhost in the LOCAL environment.
 */
function originOf(env: Env, name: string, environment: Environment): string {
  const value = required(env, name);
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }
  const local = environment === "LOCAL" && parsed !== undefined && parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed === undefined || parsed.origin !== value || (parsed.protocol !== "https:" && !local)) {
    throw new ConfigError(name, "must be an exact origin (https://host[:port], lowercase, no path; http only for localhost in LOCAL)");
  }
  return value;
}

function publicApiOf(env: Env, environment: Environment): PublicApiConfig | null {
  if (PUBLIC_API_VARIABLES.every((name) => optional(env, name) === undefined)) return null;
  return { publicOrigin: originOf(env, "KAURO_PUBLIC_ORIGIN", environment), appOrigin: originOf(env, "KAURO_APP_ORIGIN", environment), hashKeyFile: required(env, "KAURO_PUBLIC_HASH_KEY_FILE") };
}

/** The list cursors' key as a file (N16). */
export const CURSOR_KEY_FILE_VARIABLE = "KAURO_API_CURSOR_KEY_FILE";

/** A key read from a file (a mounted secret): its bytes, at least 32. A refusal names the variable and the class, never bytes. */
export function readKeyFile(variable: string, path: string): Uint8Array {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    const code = e instanceof Error && typeof (e as NodeJS.ErrnoException).code === "string" ? String((e as NodeJS.ErrnoException).code) : "unreadable";
    throw new ConfigError(variable, `names a file that cannot be read (${code})`);
  }
  if (bytes.byteLength < 32) throw new ConfigError(variable, "names a key shorter than 32 bytes");
  return new Uint8Array(bytes);
}

/** The one-shot migration job's configuration (N7): the owner role, its limits and, when given, its password file. */
export interface MigrationJobConfig {
  readonly environment: Environment;
  readonly databaseEnvironment: DatabaseEnvironment;
  readonly migrator: MigratorConfig;
}

/**
 * Configuration of the one-shot migration job (`node dist/src/migrate.js`; 14 "Deployment and rollback": the schema moves
 * before traffic shifts to the release that needs it). The job is not a serving process: it may receive the owner's password
 * as KAURO_DB_MIGRATOR_PASSWORD or as a file (KAURO_DB_MIGRATOR_PASSWORD_FILE), never both, and it ends when the migrations
 * are applied. Like loadConfig it never keeps the password.
 */
export function loadMigrationJobConfig(env: Env = process.env): MigrationJobConfig {
  const { environment, databaseEnvironment } = environmentOf(env);
  if (optional(env, MIGRATOR_PASSWORD_VARIABLE) !== undefined && optional(env, MIGRATOR_PASSWORD_FILE_VARIABLE) !== undefined) {
    throw new ConfigError(MIGRATOR_PASSWORD_FILE_VARIABLE, `is exclusive with ${MIGRATOR_PASSWORD_VARIABLE}`);
  }
  const host = optional(env, "KAURO_DB_HOST") ?? "127.0.0.1";
  const port = integer(env, "KAURO_DB_PORT", 5432, 1, 65535);
  const database = optional(env, "KAURO_DB_NAME") ?? "kauro";
  const migrator = migratorOf(env, host, port, database, optional(env, "KAURO_DB_USER"));
  checkConnectionSecurity(environment, { host, passwordRequired: false, ...(migrator.tlsCaFile === undefined ? {} : { tlsCaFile: migrator.tlsCaFile }) }, env);
  return { environment, databaseEnvironment, migrator };
}
