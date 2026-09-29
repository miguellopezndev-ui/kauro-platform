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
import { Pool, type PoolClient } from "pg";

export type RuntimeRole = "kauro_app" | "kauro_control" | "kauro_assurance" | "kauro_validator" | "kauro_ingress" | "kauro_payment";

export const RUNTIME_ROLES: ReadonlyArray<RuntimeRole> = Object.freeze(["kauro_app", "kauro_control", "kauro_assurance", "kauro_validator", "kauro_ingress", "kauro_payment"]);

export interface PoolConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** The LOGIN role; must be a member of exactly one runtime group role (RUNTIME_ROLES). */
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
       ARRAY(SELECT g FROM unnest($1::text[]) AS g WHERE pg_has_role(current_user, g, 'MEMBER') ORDER BY g) AS groups,
       EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid) AS owns_database
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

interface VerifyRow {
  login_role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  groups: string[];
  owns_database: boolean;
}

function isRuntimeRole(value: string): value is RuntimeRole {
  return (RUNTIME_ROLES as ReadonlyArray<string>).includes(value);
}

/** A pool whose every physical connection was verified to be an unprivileged runtime role of one known group. */
export class KauroPool {
  readonly #pool: Pool;
  readonly #verified = new WeakMap<PoolClient, VerifiedConnection>();
  readonly #sink: PoolErrorSink;
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
    this.#sink = config.onError ?? defaultPoolErrorSink;
    this.#pool.on("error", (error: Error) => this.#sink({ pool: config.applicationName, connection: "IDLE", ...classifyError(error) }));
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
    const [role, ...others] = row.groups.filter(isRuntimeRole);
    if (role === undefined) return refuse("a member of no runtime group");
    if (others.length > 0) return refuse(`a member of more than one runtime group (${[role, ...others].join(", ")})`);
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
  return new KauroPool(config);
}
