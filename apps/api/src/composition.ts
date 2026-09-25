/**
 * Composition root of the api process (07 "Platform topology": the entrypoint binds the concrete adapters to the ports the
 * application layer depends on; 08 "Database isolation": the runtime pool is verified before it serves a request; 07
 * "Restoration and migration": migrations run as the owner role in their own connection, never through the runtime pool;
 * 08 "Tenant context is set transaction-locally": every command runs in one unit of work whose context — TENANT, IDENTITY —
 * is derived server-side from the authenticated subject and the agency selector, bound with SET LOCAL and gone at
 * COMMIT/ROLLBACK). Decisions I-INT-1..3 in docs/design/B06-domain-db-authz.md §12c.
 *
 * Two steps, so a test can put a hold point between them and a deployment runs both:
 *   openDatabase(config)  → migrations on start when configured, the verified pool, the unit-of-work factory;
 *   assembleApi(assembly) → the authorizer, the handlers over the edition's collaborators, the Fastify server.
 * startApi(config, options) runs both and hands back one handle whose close() releases everything.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { B06Collaborators, CommandRuntime, SchemaValidator } from "@kauro/application";
import { createB06Handlers, refuseUnauthenticated } from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import type { Clock, Environment, IdGenerator, RandomBytes, UnitOfWorkFactory } from "@kauro/domain";
import { createIdGenerator, toUtcInstant } from "@kauro/domain";
import type { ApplyResult, KauroPool } from "@kauro/persistence";
import { applyMigrationsAs, createPool, createUnitOfWorkFactory } from "@kauro/persistence";
import type { Authenticator } from "./authenticator.js";
import type { ApiConfig } from "./config.js";
import { noExternalActionsInThisEdition, openProjectsInspector, unavailablePlanServices } from "./edition.js";
import { loadContractSchemas } from "./schemas.js";
import { createApiServer, type ApiServerOptions } from "./server.js";

/** The process clock: business instants come from here, never from the database (07 "Database representation"). */
export const systemClock: Clock = Object.freeze({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() });

export const systemRandom: RandomBytes = (n) => new Uint8Array(randomBytes(n));

/** Application name every runtime connection announces (pg_stat_activity; 07 "Connection budget"). */
export const API_APPLICATION_NAME = "kauro-api";

export interface DatabaseHandle {
  readonly pool: KauroPool;
  readonly unitOfWork: UnitOfWorkFactory;
  /** The migrations applied at start, or null when KAURO_DB_MIGRATE_ON_START is off. */
  readonly migrations: ApplyResult | null;
  close(): Promise<void>;
}

export interface DatabaseDependencies {
  readonly clock?: Clock;
  readonly random?: RandomBytes;
}

/**
 * Opens the database side of the process: applies pending migrations as the migrator when configured (its own connection,
 * closed afterwards), opens the runtime pool with the configured ceiling, verifies one connection immediately so a
 * privileged or misassigned login refuses the start rather than the first request, and builds the unit-of-work factory.
 */
export async function openDatabase(config: ApiConfig, deps: DatabaseDependencies = {}): Promise<DatabaseHandle> {
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? systemRandom;
  let migrations: ApplyResult | null = null;
  if (config.migrateOnStart !== null) {
    migrations = await applyMigrationsAs({ ...config.migrateOnStart, applicationName: `${API_APPLICATION_NAME}-migrator` });
  }
  const { poolMax, statementTimeoutMs, ...connection } = config.database;
  const pool = createPool({ ...connection, max: poolMax, applicationName: API_APPLICATION_NAME });
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
    close: () => pool.end(),
  };
}

export interface ApiAssembly {
  readonly environment: Environment;
  readonly unitOfWork: UnitOfWorkFactory;
  readonly authenticator: Authenticator;
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
}

/** Binds the authorizer, the seven handlers and the HTTP server over an open unit-of-work factory. */
export function assembleApi(assembly: ApiAssembly): FastifyInstance {
  const clock = assembly.clock ?? systemClock;
  const ids = assembly.ids ?? createIdGenerator(clock, systemRandom);
  const runtime: CommandRuntime = {
    unitOfWork: assembly.unitOfWork,
    authorizer: createAuthorizer({ clock, assurance: createAssuranceVerifier() }),
    clock,
    ids,
  };
  const collaborators: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: openProjectsInspector,
    externalActions: noExternalActionsInThisEdition,
    ...unavailablePlanServices(),
    ...assembly.collaborators,
  };
  return createApiServer({
    environment: assembly.environment,
    handlers: createB06Handlers(runtime, collaborators),
    authenticator: assembly.authenticator,
    refuseUnauthenticated: (command, request) => refuseUnauthenticated(runtime, command, request),
    validator: assembly.validator ?? loadContractSchemas(),
    clock,
    ids,
    ...(assembly.logger !== undefined ? { logger: assembly.logger } : {}),
    ...(assembly.onInternalError !== undefined ? { onInternalError: assembly.onInternalError } : {}),
  });
}

export interface StartOptions extends Omit<ApiAssembly, "environment" | "unitOfWork"> {
  readonly random?: RandomBytes;
}

export interface StartedApi {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  /** Closes the HTTP server, then the pool. */
  close(): Promise<void>;
}

/** The deployment path: database first (migrations, verified pool), then the server; nothing is left open on failure. */
export async function startApi(config: ApiConfig, options: StartOptions): Promise<StartedApi> {
  const { random, ...assembly } = options;
  const database = await openDatabase(config, { ...(assembly.clock !== undefined ? { clock: assembly.clock } : {}), ...(random !== undefined ? { random } : {}) });
  let app: FastifyInstance;
  try {
    app = assembleApi({ ...assembly, environment: config.environment, unitOfWork: database.unitOfWork });
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
