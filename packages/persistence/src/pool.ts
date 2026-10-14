/**
 * Pool factory (07 "Connection budget and operating limits": the API runs at most four connections per instance, control four,
 * intelligence two; raising instances without recalculating pools is a material capacity change — so the ceiling is an
 * explicit, mandatory input, never a library default. 08 "Database isolation": runtime roles are not owners, superusers or
 * BYPASSRLS — every physical connection is verified once, on first use, and a privileged login is refused before it can
 * serve a single statement; that is what makes the RLS policies the authority rather than a convention).
 *
 * The pool knows which runtime group its login role belongs to. The unit-of-work factory uses that fact to refuse a SYSTEM
 * context on the request-handler pool (kauro_app) and a TENANT/IDENTITY/ANONYMOUS context on the control pool (kauro_control)
 * (decision D-CTX-1, with the ANONYMOUS context of the review record B06-review/A-pipeline-authorization.md: four contexts,
 * two command roles, no crossing). The two evidence producers — kauro_assurance (the step-up verifier) and kauro_validator
 * (the independent Migration validator) — and the provider-webhook ingress (kauro_ingress, inbox.ts) run no unit of work at
 * all: their pools serve only their recorders. A login that belongs to two groups is refused, so a request handler can never
 * also be the producer of the evidence it checks, nor the ingress of the provider events its agency could want to suppress.
 *
 * An error of a pooled connection (server restart, administrator termination, failover, network loss), idle or held by a
 * caller, is neither swallowed nor allowed to end the process (review finding R38; 14 "Monitoring and service health": a
 * database outage is visible without exposing credentials): the connection is dropped, and the pool hands a safe
 * classification — pool name, the connection's state, error class, SQLSTATE or errno code, never the message or a connection
 * parameter — to the configured sink, by default one line on stderr.
 */
import { BlockList, isIP } from "node:net";
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { nameOfDatabaseEnvironment, type DatabaseEnvironment, type DatabaseEnvironmentName } from "./environment.js";
import { ConnectionSecurityError, connectionSecurityOf, sslOptionsOf, type ConnectionSecurityInput } from "./tls.js";

// The driver's error class, for the SQLSTATE classification of sql.ts: this module is the only one that imports the driver (DB-TLS-R4 allowlist)
export { DatabaseError } from "pg";

export type { DatabaseEnvironment } from "./environment.js";

/**
 * What every connection this module opens is given about its security, as the deployment names it (AWS-DELTA I-2, I-3). The pool and the
 * migrator apply connectionSecurityOf to it themselves, at construction: no caller, alias or wrapper can hand the driver a configuration
 * that skipped the rule (DB-TLS-R4 root cause: the rule is enforced at the single construction point, not looked for in the callers).
 */
export interface ConnectionSecurityConfig {
  /**
   * The deployment environment, minted from the validated configuration (never a string: DB-TLS gap 2); outside LOCAL: verified TLS, a DNS
   * host, the password from its file, no PG* fallbacks. Required.
   */
  readonly environment: DatabaseEnvironment;
  /** LOCAL only (refused outside LOCAL). */
  readonly password?: string;
  /** The mounted-secret password file; required outside LOCAL. */
  readonly passwordFile?: string;
  /** The CA bundle file (KAURO_DB_TLS_CA_FILE); required outside LOCAL. */
  readonly tlsCaFile?: string;
  /** The variables the deployment names the password inputs by, for the refusal text. */
  readonly passwordNames?: ConnectionSecurityInput["names"];
  /** Where PGPASSWORD, PGPASSFILE, PGSSLMODE, PGHOST and PGHOSTADDR are looked for (default process.env). */
  readonly processEnv?: ConnectionSecurityInput["processEnv"];
}

function environmentOf(config: { readonly environment?: unknown }): DatabaseEnvironmentName {
  return nameOfDatabaseEnvironment(config.environment);
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

/**
 * Loopback host (ADV-1): 127.0.0.0/8, ::1, `localhost`, or a unix socket directory (starts with "/"). An empty or missing host is NOT
 * loopback: pg would fall back to PGHOST, so a LOCAL connection must name its host.
 */
export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  if (host.startsWith("/")) return true;
  if (host.toLowerCase() === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return LOOPBACK.check(host, "ipv4");
  if (family === 6) return LOOPBACK.check(host, "ipv6");
  return false;
}

/** The driver's `password` and `ssl` settings of one connection, from connectionSecurityOf and nothing else. */
function securedSettingsOf(config: ConnectionSecurityConfig & { readonly host: string }, passwordRequired = true): { password?: string; ssl?: ReturnType<typeof sslOptionsOf> } {
  // ADV-1, by construction: LOCAL means no TLS, so it may only ever dial this machine. Whatever route minted a LOCAL environment
  // (the test-only minter included), it cannot reach a remote host: the refusal is here, in the one function every connection passes.
  if (environmentOf(config) === "LOCAL" && !isLoopbackHost(config.host)) {
    throw new ConnectionSecurityError("KAURO_DB_HOST", "must be a loopback address (127.0.0.0/8, ::1, localhost) or a unix socket path in the LOCAL environment: LOCAL connects without TLS");
  }
  const security = connectionSecurityOf(environmentOf(config), {
    host: config.host,
    ...(config.password === undefined ? {} : { password: config.password }),
    ...(config.passwordFile === undefined ? {} : { passwordFile: config.passwordFile }),
    ...(config.tlsCaFile === undefined ? {} : { tlsCaFile: config.tlsCaFile }),
    ...(config.passwordNames === undefined ? {} : { names: config.passwordNames }),
    ...(config.processEnv === undefined ? {} : { processEnv: config.processEnv }),
    passwordRequired,
  });
  return { ...(security.password === undefined ? {} : { password: security.password }), ...(security.tls === undefined ? {} : { ssl: sslOptionsOf(security.tls) }) };
}

export type RuntimeRole = "kauro_app" | "kauro_control" | "kauro_assurance" | "kauro_validator" | "kauro_ingress" | "kauro_payment" | "kauro_commission" | "kauro_outreach";

/** The runtime groups: B06's five, package B09's payment service (0013) and package B10's commission service (0028; D10-CTX-1). */
export const RUNTIME_ROLES: ReadonlyArray<RuntimeRole> = Object.freeze(["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment", "kauro_commission", "kauro_outreach"]);

export interface PoolConfig extends ConnectionSecurityConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The LOGIN role; must be a member of exactly one runtime group role (RUNTIME_ROLES). */
  readonly user: string;
  /** Connection ceiling of this instance (07 connection budget). Required: the budget is a decision, not a default. */
  readonly max: number;
  readonly applicationName: string;
  /** Idle-in-transaction ceiling: a unit of work never waits on a human (07 "Transaction discipline"). Default 30 s. */
  readonly idleInTransactionTimeoutMs?: number;
  /** Idle connection ceiling before the pool closes it. Default 30 s. */
  readonly idleTimeoutMs?: number;
  /** Time to wait for a free connection before failing (the caller answers CAPACITY_UNAVAILABLE). Default 5 s. */
  readonly connectionTimeoutMs?: number;
  /**
   * Receives the safe classification of every error a pooled connection raises, idle or held by a caller; default: one line on
   * stderr naming only the pool, the connection's state, the class and the code.
   */
  readonly onError?: PoolErrorSink;
}

/** A failure described by safe tokens only: its class and, when it has one, its SQLSTATE or errno code; never its message. */
export interface SafeErrorClassification {
  readonly errorClass: string;
  readonly code?: string;
}

/**
 * An error a pooled connection raised, safe to log: the pool's application name, whether the connection was idle in the pool or
 * held by a caller (a unit of work, a recorder, a readiness read), and the classification.
 */
export interface PoolErrorEvent extends SafeErrorClassification {
  readonly pool: string;
  readonly connection: "IDLE" | "IN_USE";
}

export type PoolErrorSink = (event: PoolErrorEvent) => void;

const SAFE_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{2,40})$/;

/**
 * The safe classification of any thrown value: the constructor name (DatabaseError, Error, AggregateError...) and the code
 * when it is a SQLSTATE (five characters) or a Node errno token (ECONNREFUSED, ETIMEDOUT...). The message is never read,
 * because it can carry a host, a user name, a value or SQL text.
 */
export function classifyError(e: unknown): SafeErrorClassification {
  if (typeof e !== "object" || e === null) return { errorClass: typeof e };
  const ctor = (e as { constructor?: { name?: unknown } }).constructor?.name;
  const errorClass = typeof ctor === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(ctor) ? ctor : "Object";
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && SAFE_CODE.test(code) ? { errorClass, code } : { errorClass };
}

function defaultPoolErrorSink(event: PoolErrorEvent): void {
  process.stderr.write(`kauro-db pool=${event.pool} ${event.connection === "IDLE" ? "idle" : "in-use"} connection error class=${event.errorClass}${event.code === undefined ? "" : ` code=${event.code}`}\n`);
}

export interface VerifiedConnection {
  readonly role: RuntimeRole;
  readonly loginRole: string;
}

export class PrivilegedRoleError extends Error {
  constructor(loginRole: string, what: string) {
    super(`login role ${loginRole} is ${what}; runtime pools refuse privileged roles (08 Database isolation)`);
    this.name = "PrivilegedRoleError";
  }
}

const VERIFY_SQL = `
SELECT current_user AS login_role,
       r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
       -- a runtime group a schema has not created yet (kauro_outreach before 0072) is not a membership: pg_has_role would raise on it
       ARRAY(SELECT g FROM unnest($1::text[]) AS g WHERE CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname = g) THEN pg_has_role(current_user, g, 'MEMBER') ELSE false END ORDER BY g) AS groups,
       EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS owns_database,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') AS database_temporary,
       has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
       EXISTS (SELECT 1 FROM pg_namespace s WHERE has_schema_privilege(current_user, s.oid, 'CREATE')) AS schema_create,
       current_setting('session_replication_role') AS replication_role,
       ARRAY(SELECT b.rolname::text FROM pg_catalog.pg_roles b
              WHERE b.oid <> r.oid AND NOT b.rolname = ANY($1) AND pg_has_role(current_user, b.oid, 'MEMBER') ORDER BY 1) AS other_roles,
       EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o') AS owns_objects
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

interface VerifyRow {
  login_role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  groups: string[];
  owns_database: boolean;
  database_temporary: boolean;
  database_create: boolean;
  schema_create: boolean;
  replication_role: string;
  other_roles: string[];
  owns_objects: boolean;
}

function isRuntimeRole(value: string): value is RuntimeRole {
  return (RUNTIME_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * DB-TLS-R3: the only way to a KauroPool is createPool. The token is module-private, so no import route (an alias, a namespace or
 * computed member, the index re-export, a run-time import) can construct one elsewhere. DB-TLS-R4: the constructor applies
 * connectionSecurityOf itself, so whatever reaches createPool (an aliased re-export, a wrapper, a run-time import) builds a secure pool.
 */
const CREATE: unique symbol = Symbol("KauroPool.create");

/** A pool whose every physical connection was verified to be an unprivileged runtime role of one known group. */
export class KauroPool {
  readonly #pool: Pool;
  readonly #verified = new WeakMap<PoolClient, VerifiedConnection>();
  readonly #sink: PoolErrorSink;
  readonly config: PoolConfig;
  /** What the driver was given about security, copied at construction (the TLS options, whether a password was given; never the password). */
  readonly connectionSecurity: { readonly ssl?: { readonly ca: string; readonly rejectUnauthorized: true }; readonly passwordGiven: boolean };

  constructor(config: PoolConfig, token: typeof CREATE) {
    if (token !== CREATE) throw new TypeError("KauroPool is constructed by createPool only (DB-TLS-R3)");
    if (!Number.isInteger(config.max) || config.max < 1 || config.max > 24) {
      throw new RangeError("pool max must be an integer between 1 and 24 (07 connection budget: the application ceiling is twenty-four)");
    }
    // DB-TLS-R4: the security rule is applied here, before the driver sees the configuration (it reads the password and CA files)
    const secured = securedSettingsOf(config);
    this.connectionSecurity = Object.freeze({ ...(secured.ssl === undefined ? {} : { ssl: Object.freeze({ ...secured.ssl }) }), passwordGiven: secured.password !== undefined });
    this.config = config;
    const idleTx = Math.max(1, Math.floor(config.idleInTransactionTimeoutMs ?? 30_000));
    this.#pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      ...secured,
      max: config.max,
      application_name: config.applicationName,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
      allowExitOnIdle: true,
      // SEC-DEPTH A2: a physical connection is recycled after ten minutes, so a verified login is re-verified at least that often
      maxLifetimeSeconds: 600,
      options: `-c idle_in_transaction_session_timeout=${idleTx}`,
    });
    // an idle client that errors (server restart, network) is dropped by pg; the error must not crash the process, and it
    // must not vanish either: its safe classification goes to the sink (R38)
    this.#sink = config.onError ?? defaultPoolErrorSink;
    this.#pool.on("error", (error: Error) => this.#sink({ pool: config.applicationName, connection: "IDLE", ...classifyError(error) }));
  }

  /**
   * DB-TLS gap 1 (6de1436): the driver pool is never handed out (no `raw`): its Client class and its options (ssl, host, password) would let
   * a holder build or re-point a connection that skipped connectionSecurityOf. What callers need is narrow:
   *
   * A pooled connection WITHOUT the role verification of `acquire` and without its in-use error listener. Its one production use is the side
   * connection that ends an abandoned unit's backend (endAbandonedBackend, ADV-8/ADV-13), which runs a signalling statement only; otherwise
   * test fixtures and diagnostics.
   */
  connectUnverified(): Promise<PoolClient> {
    return this.#pool.connect();
  }

  /** One statement on a pooled connection, without role verification: test fixtures and diagnostics only (units of work use `acquire`). */
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: ReadonlyArray<unknown>): Promise<QueryResult<R>> {
    return this.#pool.query<R>(text, values === undefined ? undefined : [...values]);
  }

  /** Whether `end` was called. */
  get ended(): boolean {
    return this.#pool.ended;
  }

  /**
   * Acquires a connection, verifying it the first time it is seen: not superuser, not BYPASSRLS, not CREATEROLE/CREATEDB,
   * not the database owner, member of exactly one runtime group. A privileged connection is destroyed, never pooled.
   */
  async acquire(): Promise<{ readonly client: PoolClient; readonly connection: VerifiedConnection }> {
    const client = this.#listenWhileHeld(await this.#pool.connect());
    const known = this.#verified.get(client);
    if (known) return { client, connection: known };
    let row: VerifyRow;
    try {
      const r = await client.query<VerifyRow>(VERIFY_SQL, [[...RUNTIME_ROLES]]);
      const first = r.rows[0];
      if (!first) throw new Error("role verification returned no row");
      row = first;
    } catch (e) {
      client.release(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    const refuse = (what: string): never => {
      const err = new PrivilegedRoleError(row.login_role, what);
      client.release(err);
      throw err;
    };
    if (row.rolsuper) refuse("SUPERUSER");
    if (row.rolbypassrls) refuse("BYPASSRLS");
    if (row.rolcreaterole) refuse("CREATEROLE");
    if (row.rolcreatedb) refuse("CREATEDB");
    if (row.owns_database) refuse("the database owner");
    // SEC-DEPTH A2 / P2: a runtime login outside the guard-execution boundary can neither create temporary or schema objects nor
    // run in a session that skips triggers (replica mode); migration 0060 removes the grants, this refuses a login that still has them
    if (row.database_temporary) refuse("granted TEMPORARY on the database");
    if (row.database_create) refuse("granted CREATE on the database");
    if (row.schema_create) refuse("granted CREATE on a schema");
    if (row.replication_role !== "origin") refuse(`running with session_replication_role = ${row.replication_role}`);
    const [role, ...others] = row.groups.filter(isRuntimeRole);
    if (role === undefined) return refuse("a member of no runtime group");
    if (others.length > 0) return refuse(`a member of more than one runtime group (${[role, ...others].join(", ")})`);
    // SEC-HARDENING-2 SH2-F2 (B14-R1: a runtime login holds exactly one membership; 14_CLOUD:57 "only required database roles"): a login
    // that is also a member of any other role (the migrator, a superuser or BYPASSRLS role, the route registrar) could SET ROLE into it,
    // and one owning any object in any database of the cluster is an owner; checked after the group messages, which stay first
    if (row.other_roles.length > 0) return refuse(`a member of a non-runtime role (${row.other_roles.join(", ")})`);
    if (row.owns_objects) return refuse("the owner of a database object");
    const connection: VerifiedConnection = { role, loginRole: row.login_role };
    this.#verified.set(client, connection);
    return { client, connection };
  }

  /**
   * While a caller holds a connection, pg-pool's idle error listener is detached, so an error the connection raises then — the
   * server terminated the backend, a failover, the network dropped — would be an unhandled `error` event and end the process
   * with every request in flight. The pool listens for the whole checkout instead: the error reaches the sink as an in-use
   * connection error (R38: a database outage is visible, without credentials), the holder's next statement fails on its own
   * (a connection that raised an error is no longer queryable, so its unit of work answers the failure), and the release
   * destroys the connection rather than returning it to the pool.
   */
  #listenWhileHeld(client: PoolClient): PoolClient {
    let lost: Error | undefined;
    const onError = (error: Error): void => {
      lost ??= error;
      this.#sink({ pool: this.config.applicationName, connection: "IN_USE", ...classifyError(error) });
    };
    client.on("error", onError);
    // pg-pool hands out a fresh single-use release with every checkout; this one detaches the listener first
    const release = client.release;
    client.release = (destroy?: Error | boolean): void => {
      client.removeListener("error", onError);
      release(destroy === undefined || destroy === false ? lost ?? destroy : destroy);
    };
    return client;
  }

  get totalCount(): number {
    return this.#pool.totalCount;
  }

  get idleCount(): number {
    return this.#pool.idleCount;
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }
}

export function createPool(config: PoolConfig): KauroPool {
  return new KauroPool(config, CREATE);
}

/** Where the migrator connects (07 "Restoration and migration": migration roles are separate from runtime). */
export interface MigratorConnection extends Omit<ConnectionSecurityConfig, "password" | "passwordFile" | "passwordNames"> {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The owner role of the kauro objects (LOGIN, not SUPERUSER, not BYPASSRLS); never a runtime login role. */
  readonly user: string;
  /** The migrator's own credential (N7), read by its entrypoint; required outside LOCAL, so pg never falls back to PGPASSWORD or a pgpass file (ADV-9). */
  readonly password?: string;
  readonly applicationName?: string;
}

/** The migrator connection's driver timeouts, in milliseconds. */
export interface MigratorClientTimeouts {
  readonly connectionTimeoutMillis: number;
  readonly statement_timeout: number;
  readonly lock_timeout: number;
}

/**
 * The migrator's one dedicated connection (not yet connected), under the same rule as every pool: connectionSecurityOf at construction
 * (DB-TLS-R4). The migrator holds its credential itself, so outside LOCAL the password is required explicitly, never from a file.
 */
export function migratorClientOf(connection: MigratorConnection, timeouts: MigratorClientTimeouts): Client {
  const { ssl } = securedSettingsOf({ environment: connection.environment, host: connection.host, ...(connection.tlsCaFile === undefined ? {} : { tlsCaFile: connection.tlsCaFile }), ...(connection.processEnv === undefined ? {} : { processEnv: connection.processEnv }) }, false);
  if (environmentOf(connection) !== "LOCAL" && connection.password === undefined) {
    throw new ConnectionSecurityError("KAURO_DB_MIGRATOR_PASSWORD", "is required outside LOCAL (or KAURO_DB_MIGRATOR_PASSWORD_FILE): the migration connection is always given its password explicitly");
  }
  return new Client({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    ...(connection.password === undefined ? {} : { password: connection.password }),
    ...(ssl === undefined ? {} : { ssl }),
    application_name: connection.applicationName ?? "kauro-migrator",
    // picked one by one: nothing a caller passes can reach the driver beside the secured settings
    connectionTimeoutMillis: timeouts.connectionTimeoutMillis,
    statement_timeout: timeouts.statement_timeout,
    lock_timeout: timeouts.lock_timeout,
  });
}
