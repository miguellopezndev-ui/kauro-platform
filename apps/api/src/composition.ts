/**
 * Composition root of the api process (07 "Platform topology": the entrypoint binds the concrete adapters to the ports the
 * application layer depends on; 08 "Database isolation": the runtime pool is verified before it serves a request; 07
 * "Restoration and migration": migrations run as the owner role in their own connection, never through the runtime pool;
 * 08 "Tenant context is set transaction-locally": every command runs in one unit of work whose context — TENANT, IDENTITY —
 * is derived server-side from the authenticated subject and the agency selector, bound with SET LOCAL and gone at
 * COMMIT/ROLLBACK; the durable fact of an unauthenticated refusal is written under the ANONYMOUS context, which binds
 * neither a user nor an agency, review record B06-review/A-pipeline-authorization.md, R26). Decisions I-INT-1..3 in docs/design/B06-domain-db-authz.md §12c; the review's transport and operability
 * decisions in docs/design/B06-review/E-transport-operability.md.
 *
 * Two steps, so a test can put a hold point between them and a deployment runs both:
 *   openDatabase(config)  → migrations on start when configured, the verified pool, the unit-of-work factory, readiness;
 *   assembleApi(assembly) → the authorizer, the handlers over the edition's collaborators, the Fastify server.
 * startApi(config, options) runs both and hands back one handle whose close() releases everything.
 *
 * Operational facts go to sinks that name safe tokens only (14 "Monitoring and service health": a database outage is visible
 * without exposing credentials; review R38): an unexpected exception, the cause of every CAPACITY_UNAVAILABLE answer and of
 * every NOT_READY probe — by correlation id — and every error of a pooled connection, idle or held by a request. By default
 * each is one stderr line.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { B06Collaborators, CommandRuntime, SchemaValidator } from "@kauro/application";
import { createB06Handlers, createReadHandlers, isCursorKey, refuseUnauthenticated } from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import type { Clock, Environment, IdGenerator, RandomBytes, UnitOfWorkFactory } from "@kauro/domain";
import { DomainFailure, createIdGenerator, toUtcInstant } from "@kauro/domain";
import type { ApplyResult, KauroPool, LedgerEntry, PoolErrorSink } from "@kauro/persistence";
import { applyMigrationsAs, classifyError, compareSchema, createPool, createUnitOfWorkFactory, listMigrations, readSchemaLedger } from "@kauro/persistence";
import type { Authenticator } from "./authenticator.js";
import type { ApiConfig, MigratorConfig } from "./config.js";
import { activeWorkInspector, commercialConsequencesInspector, noExternalActionsInThisEdition, unavailablePlanServices } from "./edition.js";
import type { DatabaseReadiness, HealthOptions, ReadinessResponse } from "./health.js";
import { loadContractSchemas } from "./schemas.js";
import { createApiServer, type ApiServerOptions, type HttpLimits } from "./server.js";

/** The process clock: business instants come from here, never from the database (07 "Database representation"). */
export const systemClock: Clock = Object.freeze({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() });

export const systemRandom: RandomBytes = (n) => new Uint8Array(randomBytes(n));

/** Application name every runtime connection announces (pg_stat_activity; 07 "Connection budget"). */
export const API_APPLICATION_NAME = "kauro-api";

/** Bound of the readiness ledger read: a probe answers promptly or reports the database as unavailable. */
export const READINESS_STATEMENT_TIMEOUT_MS = 2_000;

export interface DatabaseHandle {
  readonly pool: KauroPool;
  readonly unitOfWork: UnitOfWorkFactory;
  /** The migrations applied at start, or null when KAURO_DB_MIGRATE_ON_START is off. */
  readonly migrations: ApplyResult | null;
  /** The highest migration version this build ships (readiness compares the database's ledger with the shipped set). */
  readonly codeSchemaVersion: number;
  /** The database side of readiness: the ledger read over a verified runtime connection and compared (R42). */
  readiness(): Promise<DatabaseReadiness>;
  close(): Promise<void>;
}

export interface DatabaseDependencies {
  readonly clock?: Clock;
  readonly random?: RandomBytes;
  /** LOCAL migrations on start: the owner's password read from its file by bootstrap, for the migration connection only (N7). */
  readonly migratorPassword?: string;
  /** Receives every error a connection of the runtime pool raises, idle or held (R38); default: one stderr line. */
  readonly onPoolError?: PoolErrorSink;
}

/**
 * Applies every pending migration as `migrator` on its own bounded connection (R37), closed afterwards: the LOCAL migrations on
 * start and the one-shot migration job (migration-job.ts). `password` is handed to that connection only; nothing keeps it.
 */
export function applyMigrationsWith(migrator: MigratorConfig, password: string | undefined): Promise<ApplyResult> {
  const { connectTimeoutMs, statementTimeoutMs, lockTimeoutMs, passwordFile: _passwordFile, ...connection } = migrator;
  return applyMigrationsAs(
    { ...connection, ...(password === undefined ? {} : { password }), applicationName: `${API_APPLICATION_NAME}-migrator` },
    { connectTimeoutMs, statementTimeoutMs, lockTimeoutMs },
  );
}

/** What opening the database needs from the configuration. */
export type DatabaseConfig = Pick<ApiConfig, "database" | "migrateOnStart">;

/**
 * Opens the database side of the process: applies pending migrations as the migrator when configured (its own connection,
 * bounded and closed afterwards), opens the runtime pool with the configured ceiling, verifies one connection immediately so
 * a privileged or misassigned login refuses the start rather than the first request, and builds the unit-of-work factory
 * and the readiness probe.
 */
export async function openDatabase(config: DatabaseConfig, deps: DatabaseDependencies = {}): Promise<DatabaseHandle> {
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? systemRandom;
  const shipped = listMigrations();
  const codeSchemaVersion = shipped.reduce((max, f) => Math.max(max, f.version), 0);
  let migrations: ApplyResult | null = null;
  if (config.migrateOnStart !== null) migrations = await applyMigrationsWith(config.migrateOnStart, deps.migratorPassword);
  const { poolMax, statementTimeoutMs, ...connection } = config.database;
  const pool = createPool({ ...connection, max: poolMax, applicationName: API_APPLICATION_NAME, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
  try {
    const { client, connection: verified } = await pool.acquire();
    client.release();
    if (verified.role !== "kauro_app") {
      throw new Error(`the api runtime role must be a member of kauro_app; ${verified.loginRole} is a member of ${verified.role} (08 Database isolation)`);
    }
  } catch (e) {
    await pool.end();
    throw e;
  }
  const unitOfWork = createUnitOfWorkFactory(pool, { clock, random, defaultStatementTimeoutMs: statementTimeoutMs });
  return {
    pool,
    unitOfWork,
    migrations,
    codeSchemaVersion,
    async readiness(): Promise<DatabaseReadiness> {
      let ledger: ReadonlyArray<LedgerEntry>;
      try {
        ledger = await readSchemaLedger(pool, READINESS_STATEMENT_TIMEOUT_MS);
      } catch (cause) {
        // not swallowed: the probe answers NOT_READY and hands the cause to the diagnostics sink by correlation id
        return { database: "UNAVAILABLE", codeVersion: codeSchemaVersion, cause };
      }
      return { database: "AVAILABLE", schema: compareSchema(ledger, shipped) };
    },
    close: () => pool.end(),
  };
}

function safeCause(cause: unknown): string {
  const c = classifyError(cause);
  return c.code === undefined ? c.errorClass : `${c.errorClass} code=${c.code}`;
}

/** Default sink of the cause of a CAPACITY_UNAVAILABLE answer: class and SQLSTATE/errno only. */
export function writeUnavailable(correlationId: string, cause: unknown): void {
  process.stderr.write(`kauro-api unavailable correlation=${correlationId} code=CAPACITY_UNAVAILABLE cause=${safeCause(cause)}\n`);
}

/** Default sink of a NOT_READY probe: the states it answered and, when the database could not be read, the cause's class. */
export function writeNotReady(correlationId: string, response: ReadinessResponse, cause: unknown): void {
  const c = response.checks;
  process.stderr.write(`kauro-api not ready correlation=${correlationId} process=${c.process} database=${c.database} schema=${c.schema}${cause === undefined ? "" : ` cause=${safeCause(cause)}`}\n`);
}

/**
 * Hands the cause of every CAPACITY_UNAVAILABLE outcome of a unit of work to `report` by correlation id, then lets the outcome
 * continue unchanged: the answer stays a retryable 503, and the operator can tell a database outage from capacity pressure.
 */
export function reportingUnavailability(inner: UnitOfWorkFactory, report: (correlationId: string, cause: unknown) => void): UnitOfWorkFactory {
  return {
    async run(context, work, options) {
      try {
        return await inner.run(context, work, options);
      } catch (e) {
        if (e instanceof DomainFailure && e.code === "CAPACITY_UNAVAILABLE") report(context.correlationId, e.cause ?? e);
        throw e;
      }
    },
  };
}

export interface ApiAssembly {
  readonly environment: Environment;
  readonly unitOfWork: UnitOfWorkFactory;
  readonly authenticator: Authenticator;
  /** The database side of readiness and the build's schema version (the DatabaseHandle). */
  readonly database: Pick<DatabaseHandle, "readiness" | "codeSchemaVersion">;
  /**
   * Collaborators that replace the edition defaults (edition.ts). The acceptance tests bind deterministic plan services here;
   * a deployment of this edition binds nothing and answers PLAN_SERVICES_UNAVAILABLE for CMD023/CMD025 (I-INT-2).
   */
  readonly collaborators?: Partial<B06Collaborators>;
  /** The closed validator; loaded from the contract bundle when absent (a test passes the instance it asserts on). */
  readonly validator?: SchemaValidator;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: ApiServerOptions["logger"];
  readonly onInternalError?: ApiServerOptions["onInternalError"];
  /** Receives the cause of every CAPACITY_UNAVAILABLE outcome by correlation id; default writeUnavailable (R38). */
  readonly onUnavailable?: (correlationId: string, cause: unknown) => void;
  /** Receives every NOT_READY probe by correlation id; default writeNotReady (R42). */
  readonly onNotReady?: HealthOptions["onNotReady"];
  readonly trustedProxyHops?: number;
  readonly clientAddressKey?: Uint8Array;
  /**
   * The key list cursors are sealed with (N16; 10 "Cursors are opaque, integrity-protected ..."): every instance that serves the
   * same lists shares it (KAURO_API_CURSOR_KEY_FILE, required outside LOCAL). Absent — LOCAL only — a fresh random key per
   * process: a cursor then does not survive a restart, and its list starts over.
   */
  readonly cursorKey?: Uint8Array;
  readonly limits?: HttpLimits;
}

/** Binds the authorizer, the seven command handlers, the five reads and the HTTP server over an open unit-of-work factory. */
export function assembleApi(assembly: ApiAssembly): FastifyInstance {
  const clock = assembly.clock ?? systemClock;
  const ids = assembly.ids ?? createIdGenerator(clock, systemRandom);
  const runtime: CommandRuntime = {
    unitOfWork: reportingUnavailability(assembly.unitOfWork, assembly.onUnavailable ?? writeUnavailable),
    authorizer: createAuthorizer({ clock, assurance: createAssuranceVerifier() }),
    clock,
    ids,
  };
  const collaborators: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: activeWorkInspector,
    externalActions: noExternalActionsInThisEdition,
    commercialConsequences: commercialConsequencesInspector,
    ...unavailablePlanServices(),
    ...assembly.collaborators,
  };
  const cursorKey = assembly.cursorKey ?? systemRandom(32);
  if (!isCursorKey(cursorKey)) throw new RangeError("the cursor key has at least 32 bytes");
  return createApiServer({
    environment: assembly.environment,
    handlers: createB06Handlers(runtime, collaborators),
    reads: createReadHandlers({ unitOfWork: runtime.unitOfWork, authorizer: runtime.authorizer, clock, cursorKey }),
    authenticator: assembly.authenticator,
    refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request),
    validator: assembly.validator ?? loadContractSchemas(),
    clock,
    ids,
    health: { readiness: () => assembly.database.readiness(), codeSchemaVersion: assembly.database.codeSchemaVersion, onNotReady: assembly.onNotReady ?? writeNotReady },
    ...(assembly.logger !== undefined ? { logger: assembly.logger } : {}),
    ...(assembly.onInternalError !== undefined ? { onInternalError: assembly.onInternalError } : {}),
    ...(assembly.trustedProxyHops !== undefined ? { trustedProxyHops: assembly.trustedProxyHops } : {}),
    ...(assembly.clientAddressKey !== undefined ? { clientAddressKey: assembly.clientAddressKey } : {}),
    ...(assembly.limits !== undefined ? { limits: assembly.limits } : {}),
  });
}

export interface StartOptions extends Omit<ApiAssembly, "environment" | "unitOfWork" | "database" | "trustedProxyHops" | "limits"> {
  readonly random?: RandomBytes;
  readonly migratorPassword?: string;
  readonly onPoolError?: PoolErrorSink;
}

export interface StartedApi {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  /** Closes the HTTP server (draining: every answer from now on closes its connection), then the pool. */
  close(): Promise<void>;
}

/** The deployment path: database first (migrations, verified pool), then the server; nothing is left open on failure. */
export async function startApi(config: ApiConfig, options: StartOptions): Promise<StartedApi> {
  const { random, migratorPassword, onPoolError, ...assembly } = options;
  const database = await openDatabase(config, {
    ...(assembly.clock !== undefined ? { clock: assembly.clock } : {}),
    ...(random !== undefined ? { random } : {}),
    ...(migratorPassword !== undefined ? { migratorPassword } : {}),
    ...(onPoolError !== undefined ? { onPoolError } : {}),
  });
  let app: FastifyInstance;
  try {
    app = assembleApi({
      ...assembly,
      environment: config.environment,
      unitOfWork: database.unitOfWork,
      database,
      trustedProxyHops: config.http.trustedProxyHops,
      limits: { requestTimeoutMs: config.http.requestTimeoutMs, connectionTimeoutMs: config.http.connectionTimeoutMs },
    });
    await app.ready();
  } catch (e) {
    await database.close();
    throw e;
  }
  return {
    app,
    database,
    close: async () => {
      await app.close();
      await database.close();
    },
  };
}
