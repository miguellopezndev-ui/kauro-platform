/**
 * Pool factory (07 "Connection budget and operating limits": the API runs at most four connections per instance, control four,
 * intelligence two; raising instances without recalculating pools is a material capacity change — so the ceiling is an
 * explicit, mandatory input, never a library default. 08 "Database isolation": runtime roles are not owners, superusers or
 * BYPASSRLS — every physical connection is verified once, on first use, and a privileged login is refused before it can
 * serve a single statement; that is what makes the RLS policies the authority rather than a convention).
 *
 * The pool knows which runtime group its login role belongs to (kauro_app or kauro_control). The unit-of-work factory uses
 * that fact to refuse a SYSTEM context on the request-handler pool and a TENANT/IDENTITY context on the control pool
 * (decision D-CTX-1: three contexts, two roles, no crossing).
 *
 * An error of an idle pooled connection (server restart, administrator termination, network loss) is not swallowed (review
 * finding R38; 14 "Monitoring and service health": a database outage is visible without exposing credentials): pg drops the
 * connection, and the pool hands a safe classification — pool name, error class, SQLSTATE or errno code, never the message
 * or a connection parameter — to the configured sink, by default one line on stderr.
 */
import { Pool, type PoolClient } from "pg";

export type RuntimeRole = "kauro_app" | "kauro_control";

export interface PoolConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The LOGIN role; must be a member of exactly one runtime group role (kauro_app or kauro_control). */
  readonly user: string;
  readonly password?: string;
  /** Connection ceiling of this instance (07 connection budget). Required: the budget is a decision, not a default. */
  readonly max: number;
  readonly applicationName: string;
  /** Idle-in-transaction ceiling: a unit of work never waits on a human (07 "Transaction discipline"). Default 30 s. */
  readonly idleInTransactionTimeoutMs?: number;
  /** Idle connection ceiling before the pool closes it. Default 30 s. */
  readonly idleTimeoutMs?: number;
  /** Time to wait for a free connection before failing (the caller answers CAPACITY_UNAVAILABLE). Default 5 s. */
  readonly connectionTimeoutMs?: number;
  /** Receives the safe classification of every idle-connection error; default: one line on stderr naming only the pool, the class and the code. */
  readonly onError?: PoolErrorSink;
}

/** A failure described by safe tokens only: its class and, when it has one, its SQLSTATE or errno code; never its message. */
export interface SafeErrorClassification {
  readonly errorClass: string;
  readonly code?: string;
}

/** An error of an idle pooled connection, safe to log: the pool's application name and the classification. */
export interface PoolErrorEvent extends SafeErrorClassification {
  readonly pool: string;
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
  process.stderr.write(`kauro-db pool=${event.pool} idle connection error class=${event.errorClass}${event.code === undefined ? "" : ` code=${event.code}`}
`);
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
       pg_has_role(current_user, 'kauro_app', 'MEMBER') AS is_app,
       pg_has_role(current_user, 'kauro_control', 'MEMBER') AS is_control,
       EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS owns_database
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

interface VerifyRow {
  login_role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  is_app: boolean;
  is_control: boolean;
  owns_database: boolean;
}

/** A pool whose every physical connection was verified to be an unprivileged runtime role of one known group. */
export class KauroPool {
  readonly #pool: Pool;
  readonly #verified = new WeakMap<PoolClient, VerifiedConnection>();
  readonly config: PoolConfig;

  constructor(config: PoolConfig) {
    if (!Number.isInteger(config.max) || config.max < 1 || config.max > 24) {
      throw new RangeError("pool max must be an integer between 1 and 24 (07 connection budget: the application ceiling is twenty-four)");
    }
    this.config = config;
    const idleTx = Math.max(1, Math.floor(config.idleInTransactionTimeoutMs ?? 30_000));
    this.#pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      ...(config.password === undefined ? {} : { password: config.password }),
      max: config.max,
      application_name: config.applicationName,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
      allowExitOnIdle: true,
      options: `-c idle_in_transaction_session_timeout=${idleTx}`,
    });
    // an idle client that errors (server restart, network) is dropped by pg; the error must not crash the process, and it
    // must not vanish either: its safe classification goes to the sink (R38)
    const sink = config.onError ?? defaultPoolErrorSink;
    this.#pool.on("error", (error: Error) => sink({ pool: config.applicationName, ...classifyError(error) }));
  }

  /** The underlying pg pool (tests and diagnostics only; units of work go through `acquire`). */
  get raw(): Pool {
    return this.#pool;
  }

  /**
   * Acquires a connection, verifying it the first time it is seen: not superuser, not BYPASSRLS, not CREATEROLE/CREATEDB,
   * not the database owner, member of exactly one runtime group. A privileged connection is destroyed, never pooled.
   */
  async acquire(): Promise<{ readonly client: PoolClient; readonly connection: VerifiedConnection }> {
    const client = await this.#pool.connect();
    const known = this.#verified.get(client);
    if (known) return { client, connection: known };
    let row: VerifyRow;
    try {
      const r = await client.query<VerifyRow>(VERIFY_SQL);
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
    if (row.is_app === row.is_control) refuse(row.is_app ? "a member of both runtime groups" : "a member of no runtime group");
    const connection: VerifiedConnection = { role: row.is_app ? "kauro_app" : "kauro_control", loginRole: row.login_role };
    this.#verified.set(client, connection);
    return { client, connection };
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
  return new KauroPool(config);
}
