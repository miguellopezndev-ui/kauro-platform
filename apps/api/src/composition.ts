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
import type { B06Collaborators, B07Collaborators, CommerceCommandHandler, CommerceReadHandler, CommerceRequestCollaborators, CommerceRequestRuntime, SchemaValidator, SourceReadRuntime, SourceRuntime } from "@kauro/application";
import {
  SESSION_POLICY_VERSION,
  createB06Handlers,
  createB07Handlers,
  createCommerceAuthorizer,
  createCommerceRequestHandlers,
  createReadHandlers,
  createSessionService,
  createSourceIntakeHandlers,
  createSourceReadHandlers,
  isCursorKey,
  refuseAnonymously,
  refuseUnauthenticated,
} from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import type { Clock, CommerceUnitOfWorkFactory, Environment, ExecutionContext, IdGenerator, RandomBytes, SourceUnitOfWork, UnitOfWorkOptions } from "@kauro/domain";
import { DomainFailure, createIdGenerator, toUtcInstant } from "@kauro/domain";
import type { ApplyResult, KauroPool, LedgerEntry, PoolErrorSink } from "@kauro/persistence";
import { PgWebSessionStore, applyMigrationsAs, classifyError, compareSchema, createCommerceUnitOfWorkFactory, createPool, listMigrations, readSchemaLedger } from "@kauro/persistence";
import type { Authenticator } from "./authenticator.js";
import type { ApiConfig, IdentityConfig, MigratorConfig } from "./config.js";
import { activeWorkInspector, commerceEdition, commercialConsequencesInspector, commercialScopeInspector, noExternalActionsInThisEdition, unavailablePlanServices } from "./edition.js";
import { createIdentityTokenVerifier, type IdentityKeySource } from "./identity-verifier.js";
import { assertIdentityConfig, createSessionAuthenticator, type SessionAssembly } from "./sessions.js";
import type { DatabaseReadiness, HealthOptions, ReadinessResponse } from "./health.js";
import { loadContractSchemas } from "./schemas.js";
import { createApiServer, type ApiServerOptions, type HttpLimits } from "./server.js";
import type { PaymentService } from "./payments/index.js";
import { registerPaymentRoutes } from "./payments/routes.js";
import { PAYMENT_SERVICE_ID } from "./payments/runtime.js";

/** The process clock: business instants come from here, never from the database (07 "Database representation"). */
export const systemClock: Clock = Object.freeze({ now: () => toUtcInstant(Date.now()), nowMs: () => Date.now() });

export const systemRandom: RandomBytes = (n) => new Uint8Array(randomBytes(n));

/** Application name every runtime connection announces (pg_stat_activity; 07 "Connection budget"). */
export const API_APPLICATION_NAME = "kauro-api";

/** Application name of the session boundary's connections (kauro_assurance; B11 W2). */
export const SESSIONS_APPLICATION_NAME = `${API_APPLICATION_NAME}-sessions`;

/** Bound of the readiness ledger read: a probe answers promptly or reports the database as unavailable. */
export const READINESS_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * The request handlers' unit-of-work factory: B06's `run`, the source lifecycle's `runSource` (B07) and the commerce unit of work of
 * the payments workflow (B09) — one factory on the verified kauro_app pool (@kauro/persistence PgCommerceUnitOfWorkFactory, which
 * extends the source-lifecycle factory of B07).
 */
export interface RequestUnitOfWorkFactory extends CommerceUnitOfWorkFactory {
  runSource<T>(context: ExecutionContext, work: (uow: SourceUnitOfWork) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export interface DatabaseHandle {
  readonly pool: KauroPool;
  /**
   * The request handlers' units of work on the verified runtime pool (kauro_app): B06's commands and reads, the source lifecycle's
   * (runSource, B07) and — the same transaction with the commerce repositories — the request side of the payments workflow
   * (package B09, D-REQ-B1).
   */
  readonly unitOfWork: RequestUnitOfWorkFactory;
  /** The authentication boundary's pool (a login of kauro_assurance), when the session boundary is bound; null otherwise. */
  readonly assurancePool: KauroPool | null;
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

/** What opening the database needs from the configuration (the session boundary's login, when it is bound). */
export type DatabaseConfig = Pick<ApiConfig, "database" | "migrateOnStart"> & { readonly identity?: Pick<IdentityConfig, "assuranceDatabase"> | null };

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
  let assurancePool: KauroPool | null = null;
  const boundary = config.identity?.assuranceDatabase;
  if (boundary !== undefined) {
    const { poolMax: boundaryMax, ...login } = boundary;
    assurancePool = createPool({ host: connection.host, port: connection.port, database: connection.database, ...login, max: boundaryMax, applicationName: SESSIONS_APPLICATION_NAME, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
    try {
      const { client, connection: verified } = await assurancePool.acquire();
      client.release();
      if (verified.role !== "kauro_assurance") {
        throw new Error(`the session boundary's login must be a member of kauro_assurance; ${verified.loginRole} is a member of ${verified.role} (B06 D-EVID-1, B11 D-AUTH-1)`);
      }
    } catch (e) {
      await assurancePool.end();
      await pool.end();
      throw e;
    }
  }
  // one factory on the one verified pool: TENANT, IDENTITY, ANONYMOUS and OPERATOR contexts run under kauro_app; the payment
  // service's SERVICE contexts run on its own pool, which this process does not open here (the payment service's composition)
  const unitOfWork = createCommerceUnitOfWorkFactory({ app: pool }, { clock, random, defaultStatementTimeoutMs: statementTimeoutMs });
  const sessionsPool = assurancePool;
  return {
    pool,
    assurancePool,
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
    close: async () => {
      await pool.end();
      if (sessionsPool !== null) await sessionsPool.end();
    },
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
 * continue unchanged: the answer stays a retryable 503, and the operator can tell a database outage from capacity pressure. Both
 * kinds of unit of work are reported alike (`run` and the source lifecycle's `runSource`).
 */
export function reportingUnavailability(inner: RequestUnitOfWorkFactory, report: (correlationId: string, cause: unknown) => void): RequestUnitOfWorkFactory {
  const reported = async <T>(correlationId: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (e) {
      if (e instanceof DomainFailure && e.code === "CAPACITY_UNAVAILABLE") report(correlationId, e.cause ?? e);
      throw e;
    }
  };
  return {
    run: (context, work, options) => reported(context.correlationId, () => inner.run(context, work, options)),
    runSource: (context, work, options) => reported(context.correlationId, () => inner.runSource(context, work, options)),
  };
}

export interface ApiAssembly {
  readonly environment: Environment;
  /** The request handlers' units of work (DatabaseHandle.unitOfWork): B06's, B07's source units of work and the request side of the payments workflow. */
  readonly unitOfWork: RequestUnitOfWorkFactory;
  readonly authenticator: Authenticator;
  /** The database side of readiness and the build's schema version (the DatabaseHandle). */
  readonly database: Pick<DatabaseHandle, "readiness" | "codeSchemaVersion">;
  /**
   * Collaborators that replace the edition defaults (edition.ts). The acceptance tests bind deterministic plan services here;
   * a deployment of this edition binds nothing and answers PLAN_SERVICES_UNAVAILABLE for CMD023/CMD025 (I-INT-2).
   */
  readonly collaborators?: Partial<B06Collaborators>;
  /**
   * Collaborators of the source lifecycle that replace the edition defaults (B07 design §11; edition.ts): the provider adapters
   * with the application origin sessions are bound to, the preview reader, the commercial-scope inspector. The acceptance tests
   * bind the labelled contract fakes of @kauro/application/testing (SIMULATED) here; a deployment of this edition binds none
   * (D-SAPI-6) and B15 binds the real adapters.
   */
  readonly sources?: Partial<B07Collaborators>;
  /**
   * The payment collaborators that replace the edition's (edition.ts commerceEdition; package B09, D-REQ-B1): the payment service's
   * units of work (SERVICE on kauro_payment), the payment provider adapter and the platform port of B08. A deployment of this
   * edition binds none and answers the provider-effect commands PROVIDER_SERVICES_UNAVAILABLE; the acceptance tests bind the
   * labelled contract fakes of @kauro/application/testing here (D-FAKE-B1), never the production wiring.
   */
  readonly commerce?: Partial<CommerceRequestCollaborators>;
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
  /**
   * The payment service of package B09 (payments/index.ts createPaymentService; stage-2 mandate M3): its routes — the provider
   * webhook (CMD030), ExecuteRefund (CMD033), ReconcilePayment (CMD034) — are registered in every edition; without a bound payment
   * service the webhook knows no provider and the service routes find no verified service identity (D-FAKE-B1: nothing in the
   * product wiring binds a contract fake; the provider adapters are the integration package's, B15). Bound, it is also where the
   * request side's CreatePaymentOrder and CapturePayment settle (its units of work and provider adapter; D-INT2-B3).
   */
  readonly payments?: PaymentService;
  /**
   * The browser session boundary (B11 W2): the identity token verifier, the authentication boundary's store, the application
   * origins and the identity configuration the page reads. When bound, the api authenticates the session cookie (with the CSRF
   * rule) beside `authenticator`, and serves the session routes.
   */
  readonly sessions?: SessionAssembly;
  /** Entropy of the session secrets; node:crypto by default. */
  readonly random?: RandomBytes;
}

/**
 * Binds the authorizer, the thirteen command handlers (B06's seven, B07's six), the twelve reads, the selection manifest intake,
 * the request side of the payments workflow (CMD028, CMD029, CMD031, CMD032 and the four B09 reads), the payment service's routes
 * (CMD030, CMD033, CMD034) and the HTTP server over an open unit-of-work factory.
 */
export function assembleApi(assembly: ApiAssembly): FastifyInstance {
  const clock = assembly.clock ?? systemClock;
  const ids = assembly.ids ?? createIdGenerator(clock, systemRandom);
  const unitOfWork = reportingUnavailability(assembly.unitOfWork, assembly.onUnavailable ?? writeUnavailable);
  const runtime: SourceRuntime = {
    unitOfWork,
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
  const sources: B07Collaborators = {
    providers: null,
    preview: null,
    commercialScope: commercialScopeInspector,
    ...assembly.sources,
  };
  const cursorKey = assembly.cursorKey ?? systemRandom(32);
  if (!isCursorKey(cursorKey)) throw new RangeError("the cursor key has at least 32 bytes");
  // package B11: the browser session boundary (W2, D-AUTH-1..5). Bound, the api authenticates the session cookie — with the CSRF
  // rule of every unsafe request — beside the deployment's authenticator, and serves the session routes
  let authenticator = assembly.authenticator;
  let sessions: ApiServerOptions["sessions"];
  if (assembly.sessions !== undefined) {
    const bound = assembly.sessions;
    assertIdentityConfig(assembly.environment, bound.identityConfig);
    const service = createSessionService({ unitOfWork: runtime.unitOfWork, clock, ids, random: assembly.random ?? systemRandom, verifier: bound.verifier, store: bound.store });
    authenticator = createSessionAuthenticator(assembly.authenticator, service, bound.appOrigins);
    sessions = { service, authenticator, appOrigins: bound.appOrigins, identityConfig: bound.identityConfig };
  }
  const readRuntime: SourceReadRuntime = { unitOfWork: runtime.unitOfWork, authorizer: runtime.authorizer, clock, cursorKey };
  const validator = assembly.validator ?? loadContractSchemas();
  // package B09: the request side of the payments workflow over the same units of work and authorizer, with the corporate owner's
  // authorizer and the payment collaborators of the edition, replaced by the assembly's (D-REQ-B1). A bound payment service is the
  // one the request side's provider commands settle through (D-INT2-B3): their settle step (T3) runs in its SERVICE units of work on
  // its kauro_payment pool, as its own verified identity, with its provider adapter — the adapter its webhook, its refunds and its
  // reconciliation use — unless the assembly binds these collaborators itself.
  const commerceRuntime: CommerceRequestRuntime = {
    unitOfWork,
    authorizer: runtime.authorizer,
    commerceAuthorizer: createCommerceAuthorizer({ clock, assurance: createAssuranceVerifier() }),
    clock,
    ids,
  };
  const paymentService: Partial<CommerceRequestCollaborators> =
    assembly.payments === undefined ? {} : { payment: assembly.payments.runtime.assembly.commerce, paymentServiceId: PAYMENT_SERVICE_ID, provider: assembly.payments.runtime.assembly.provider };
  const commerce = createCommerceRequestHandlers(commerceRuntime, { ...commerceEdition(), ...paymentService, ...assembly.commerce });
  return createApiServer({
    environment: assembly.environment,
    handlers: { ...createB06Handlers(runtime, collaborators), ...createB07Handlers(runtime, sources) },
    reads: { ...createReadHandlers(readRuntime), ...createSourceReadHandlers(readRuntime, sources) },
    intakes: createSourceIntakeHandlers(readRuntime),
    commerce: { commands: Object.values(commerce.commands) as ReadonlyArray<CommerceCommandHandler<unknown, unknown>>, reads: Object.values(commerce.reads) as ReadonlyArray<CommerceReadHandler<unknown>> },
    authenticator,
    refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request),
    refuseCredentials: (action, request, failure) => refuseAnonymously(runtime, action, request, failure, SESSION_POLICY_VERSION),
    ...(sessions !== undefined ? { sessions } : {}),
    validator,
    clock,
    ids,
    paymentRoutes: (app, kit) => registerPaymentRoutes(app, kit, { payments: assembly.payments ?? null, validator, clock, refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request) }),
    health: { readiness: () => assembly.database.readiness(), codeSchemaVersion: assembly.database.codeSchemaVersion, onNotReady: assembly.onNotReady ?? writeNotReady },
    ...(assembly.logger !== undefined ? { logger: assembly.logger } : {}),
    ...(assembly.onInternalError !== undefined ? { onInternalError: assembly.onInternalError } : {}),
    ...(assembly.trustedProxyHops !== undefined ? { trustedProxyHops: assembly.trustedProxyHops } : {}),
    ...(assembly.clientAddressKey !== undefined ? { clientAddressKey: assembly.clientAddressKey } : {}),
    ...(assembly.limits !== undefined ? { limits: assembly.limits } : {}),
  });
}

export interface StartOptions extends Omit<ApiAssembly, "environment" | "unitOfWork" | "database" | "trustedProxyHops" | "limits" | "sessions"> {
  readonly random?: RandomBytes;
  readonly migratorPassword?: string;
  readonly onPoolError?: PoolErrorSink;
  /**
   * The key source of the identity token verifier when the configuration binds the session boundary: bootstrap reads the
   * contract fake's JWKS file (LOCAL); Google's securetoken document otherwise (the default).
   */
  readonly identityKeySource?: IdentityKeySource;
}

/** The session boundary a configuration binds, over the open database (its kauro_assurance pool). */
export function sessionAssemblyOf(environment: ApiConfig["environment"], identity: IdentityConfig, database: Pick<DatabaseHandle, "assurancePool">, keySource: IdentityKeySource, clock?: Clock): SessionAssembly {
  if (database.assurancePool === null) throw new Error("the session boundary is configured but its kauro_assurance pool is not open");
  if ((keySource.kind === "CONTRACT_FAKE") !== (identity.keySource === "CONTRACT_FAKE")) throw new Error(`the key source ${keySource.kind} is not the configured ${identity.keySource}`);
  return {
    verifier: createIdentityTokenVerifier({ projectId: identity.projectId, environment, keySource, ...(clock !== undefined ? { clock } : {}) }),
    store: new PgWebSessionStore(database.assurancePool),
    appOrigins: identity.appOrigins,
    identityConfig:
      identity.keySource === "CONTRACT_FAKE"
        ? { adapter: "CONTRACT_FAKE", projectId: identity.projectId, ...(identity.fakeEndpoint !== null ? { endpoint: identity.fakeEndpoint } : {}) }
        : { adapter: "IDENTITY_PLATFORM", projectId: identity.projectId },
  };
}

export interface StartedApi {
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  /** Closes the HTTP server (draining: every answer from now on closes its connection), then the pool. */
  close(): Promise<void>;
}

/** The deployment path: database first (migrations, verified pool), then the server; nothing is left open on failure. */
export async function startApi(config: ApiConfig, options: StartOptions): Promise<StartedApi> {
  const { random, migratorPassword, onPoolError, identityKeySource, ...assembly } = options;
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
      ...(random !== undefined ? { random } : {}),
      ...(config.identity !== null ? { sessions: sessionAssemblyOf(config.environment, config.identity, database, identityKeySource ?? { kind: "GOOGLE_X509" }, assembly.clock) } : {}),
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
