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
import type { LateFailureSink, BankEvidenceClassifier, BankEvidenceStore, BankInboundCollaborators, ObjectReadSigningPort, BankCreditClassifier, DestinationFingerprinter } from "@kauro/application";
import { createBankEvidenceUpload, createBankInboundHandlers, createBankRouteHandlers, createBankSettlementHandlers, realProviderCallTimer, createBankRefundHandlers } from "@kauro/application";
import type { AssuranceVerifier, AuditReadRuntime, AuditRuntime, B06Collaborators, B07Collaborators, BuyerTypeReader, CommercialCommandHandler, CommercialReadHandler, CommerceCommandHandler, CommerceReadHandler, CommerceRequestCollaborators, CommerceRequestRuntime, CoreServices, ExecutionReadRuntime, ExecutionRuntime, SchemaValidator, SourceReadRuntime, SourceRuntime, QuoteCollaborators, ProviderCallTimer } from "@kauro/application";
import { RecordedBuyerTypeReader, SESSION_POLICY_VERSION, createAgencyAppHandlers, type AgencyAppStores, createAgencyLifecycleHandlers, createAuditHandlers, createAuditIntakeHandlers, createAuditReadHandlers, createB06Handlers, createB07Handlers, createRetentionHandlers, createCommerceAuthorizer, createCommerceRequestHandlers, createCommercialAuthorizer, createExecutionHandlers, createExecutionReadHandlers, createProspectHandlers, createProspectIntakeHandlers, createReadHandlers, createSessionService, createSourceIntakeHandlers, createSourceReadHandlers, createSupportHandlers, createTeamHandlers, createBrandingHandlers, createBrandingIntakeHandlers, type BrandingStores, isCursorKey, refuseAnonymously, refuseUnauthenticated, unavailableCoreServices, createSellerCommandHandlers, createCapabilityCommandHandlers, createOperationsCommandHandlers, createOperationsReadHandlers, createQuoteHandlers, createStatementRequestHandlers, getSellerHomeHandler, problemOf, recordOperatorDenial, createOutreachStubCommandHandlers, createOutreachStubReadHandlers, createOutreachAuthCommandHandlers, createOutreachAuthReadHandlers, createOutreachDraftCommandHandlers, createOutreachDraftReadHandlers, type OutreachSealer, createActivityCommandHandlers, createActivityReadHandlers, type OptOutKey, createOwnerToolHandlers } from "@kauro/application";
import { createAdmissionLimiter, createAssuranceVerifier, createAuthorizer } from "@kauro/authorization";
import type { UtcInstant } from "@kauro/contracts";
import type { AuditUnitOfWorkFactory, CommerceUnitOfWorkFactory, Clock, Environment, ExecutionContext, IdGenerator, RandomBytes, SourceUnitOfWork, UnitOfWorkOptions, UserId } from "@kauro/domain";
import { COMMERCE_POLICY_VERSION, DomainFailure, createIdGenerator, toUtcInstant } from "@kauro/domain";
import { createSendLaneHandlers, outreachSealerOf } from "./outreach/routes.js";
import type { ApplyResult, KauroPool, LedgerEntry, PoolErrorSink } from "@kauro/persistence";
import { bankRoutesOf, bankCreditsOf, bankSettlementsOf, buyerTypesOf, projectDashboardOf, reportSourcesOf, sessionFenceOf, effectInstantOf, PgCapabilityPublication, PgInquiryStore, PgWebSessionStore, agencyLifecycleOf, capabilityGovernanceOf, operationsOf, breakglassOf, agencyOrderPrecedesClaim, applyMigrationsAs, classifyError, compareSchema, createPool, type DatabaseEnvironment, attributionOf, commercialPrincipalsOf, listMigrations, readSchemaLedger, salesOf, createCommercialUnitOfWorkFactory, quoteReadsOf, recurrenceOf, ledgerOf, statementsOf, bankRefundsOf, outreachAuthOf, outreachDraftsOf, outreachActivityOf, PgOptOutStore, ownerToolsOf } from "@kauro/persistence";
import type { Authenticator } from "./authenticator.js";
import { commercialPrincipalReader } from "./commercial-principals.js";
import type { ApiConfig, IdentityConfig, MigratorConfig } from "./config.js";
import { activeWorkInspector, commerceEdition, commercialConsequencesInspector, commercialScopeInspector, externalActionInspector, planServices, sourceLineageReader } from "./edition.js";
import { createIdentityTokenVerifier, type IdentityKeySource } from "./identity-verifier.js";
import { assertIdentityConfig, createSessionAuthenticator, type SessionAssembly } from "./sessions.js";
import type { DatabaseReadiness, HealthOptions, ReadinessResponse } from "./health.js";
import { loadContractSchemas } from "./schemas.js";
import type { PublicApiOptions } from "./public-routes.js";
import { createApiServer, type ApiServerOptions, type HttpLimits, type OneTimeDelivery } from "./server.js";
import type { PaymentService } from "./payments/index.js";
import { createPurchaseRebinder } from "./payments/rebinder.js";
import { registerPaymentRoutes } from "./payments/routes.js";
import { registerBankRouteRoutes } from "./payments/bank-route-routes.js";
import { registerAgencyAppRoutes } from "./agency-app-routes.js";
import { PAYMENT_SERVICE_ID } from "./payments/runtime.js";
import { operationsServiceRuntime, registerCommissionRoutes, type CommissionRoutesBinding } from "./commissions/routes.js";

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
 * The request handlers' unit-of-work factory: B06's `run`, the source lifecycle's `runSource` (B07), the commerce unit of work of
 * the payments workflow (B09), the execution unit of work of the job commands and the audit unit of work of the audit commands (B08: `run`
 * also opens the execution store and the audit store on the same connection) — one factory on the verified kauro_app pool
 * (@kauro/persistence PgAuditUnitOfWorkFactory, which extends the execution factory of B08, the commerce factory of B09 and the
 * source-lifecycle factory of B07).
 */
export interface RequestUnitOfWorkFactory extends AuditUnitOfWorkFactory {
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
export function applyMigrationsWith(environment: DatabaseEnvironment, migrator: MigratorConfig, password: string | undefined): Promise<ApplyResult> {
  const { connectTimeoutMs, statementTimeoutMs, lockTimeoutMs, passwordFile: _passwordFile, tlsCaFile, ...connection } = migrator;
  // the migrator's credential is its own (N7): applyMigrationsAs applies connectionSecurityOf and requires it explicitly outside LOCAL (DB-TLS-R4, ADV-9)
  return applyMigrationsAs(
    { ...connection, environment, ...(password === undefined ? {} : { password }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }), applicationName: `${API_APPLICATION_NAME}-migrator` },
    { connectTimeoutMs, statementTimeoutMs, lockTimeoutMs },
  );
}

/** What opening the database needs from the configuration (the session boundary's login, when it is bound). */
export type DatabaseConfig = Pick<ApiConfig, "databaseEnvironment" | "database" | "migrateOnStart"> & { readonly identity?: Pick<IdentityConfig, "assuranceDatabase"> | null };

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
  if (config.migrateOnStart !== null) migrations = await applyMigrationsWith(config.databaseEnvironment, config.migrateOnStart, deps.migratorPassword);
  const { poolMax, statementTimeoutMs, tlsCaFile, password, passwordFile, ...connection } = config.database;
  // createPool applies connectionSecurityOf itself (DB-TLS-R4): TLS, DNS host and the password file outside LOCAL
  const pool = createPool({ ...connection, environment: config.databaseEnvironment, ...(password === undefined ? {} : { password }), ...(passwordFile === undefined ? {} : { passwordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }), max: poolMax, applicationName: API_APPLICATION_NAME, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
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
    const { poolMax: boundaryMax, user: boundaryUser, password: boundaryPassword, passwordFile: boundaryPasswordFile } = boundary;
    try {
      // the password file is read inside the try: a failure closes the runtime pool opened above, never leaks it (ADV-7)
      assurancePool = createPool({ environment: config.databaseEnvironment, host: connection.host, port: connection.port, database: connection.database, user: boundaryUser, ...(boundaryPassword === undefined ? {} : { password: boundaryPassword }), ...(boundaryPasswordFile === undefined ? {} : { passwordFile: boundaryPasswordFile }), ...(tlsCaFile === undefined ? {} : { tlsCaFile }), passwordNames: { password: "KAURO_DB_ASSURANCE_PASSWORD", passwordFile: "KAURO_DB_ASSURANCE_PASSWORD_FILE" }, max: boundaryMax, applicationName: SESSIONS_APPLICATION_NAME, ...(deps.onPoolError !== undefined ? { onError: deps.onPoolError } : {}) });
      const { client, connection: verified } = await assurancePool.acquire();
      client.release();
      if (verified.role !== "kauro_assurance") {
        throw new Error(`the session boundary's login must be a member of kauro_assurance; ${verified.loginRole} is a member of ${verified.role} (B06 D-EVID-1, B11 D-AUTH-1)`);
      }
    } catch (e) {
      await assurancePool?.end();
      await pool.end();
      throw e;
    }
  }
  // one factory on the one verified pool: TENANT, IDENTITY, ANONYMOUS and OPERATOR contexts run under kauro_app; the payment
  // service's SERVICE contexts run on its own pool, which this process does not open here (the payment service's composition)
  // the commercial factory of package B10 extends B08's audit factory (D10-SYNC-2): one routed factory for every request context
  const unitOfWork = createCommercialUnitOfWorkFactory({ app: pool }, { clock, random, defaultStatementTimeoutMs: statementTimeoutMs });
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
   * Collaborators that replace the edition defaults (edition.ts planServices). The acceptance tests of B06 bind deterministic plan
   * services here; a deployment of this edition binds nothing: the decision artifacts, the patch compiler over `cores` and the real
   * disclosure composer are its own (I-INT-2, D8-CMA-5).
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
  /**
   * The read signer of CMD038 AuthorizeDownload (ObjectStoragePort.signRead, B16 lane L5): the provider adapter that presigns a delivery
   * object's read URL (S3 presigned GetObject, B15). Unbound, CMD038 answers 503 DOWNLOAD_SIGNER_UNAVAILABLE and writes nothing.
   */
  readonly readSigner?: ObjectReadSigningPort;
  /** Where the one-time secret of an invitation goes after the commit (never the response); absent, it is dropped. */
  readonly oneTimeDelivery?: OneTimeDelivery;
  /**
   * The two public routes (B11 W5b): the exact public and application origins, the inquiry store, the capability publication
   * reader and the key of the inquiry digests. Absent, neither route exists.
   */
  readonly publicApi?: PublicApiOptions;
  /**
   * The cores the request side reaches (package B08, D8-PORT-1): the Intelligence core's plan compiler behind CMD022 CreatePlan and
   * CMD023 RevisePlan. A deployment of this edition binds none and answers INTEGRITY_FAILURE / CORE_SERVICES_UNAVAILABLE for both;
   * the acceptance tests bind the labelled contract fakes of @kauro/application/testing/cores (SIMULATED) here, and B15 binds the
   * real thin adapter.
   */
  readonly cores?: CoreServices;
  /**
   * The platform ports of package B10 that replace the edition's (docs/design/B10-commercial-domain.md §11): the agency buyer type
   * (D58). A deployment of this edition binds none, so CMD047 refuses every attribution BUYER_TYPE_UNSET until B11 records the type;
   * the acceptance tests bind the labelled contract fake of @kauro/application/testing (SIMULATED). `assurance`: the step-up verifier of
   * the statement and payout operations (CMD052 judges the proof at its request and again at its effect); absent, the platform's. The
   * fault cells bind the platform's own verifier through an instrumented proxy, so the instant the product judges a proof at is evidence.
   */
  readonly commercial?: { /** KAURO_SELLER_SUPPORT_ROUTE (B12 GetSellerHome); null or absent shows "not configured". */ readonly sellerSupportRoute?: string | null; /** Package B12 (L-SEND): the deployment's outreach sealer (compliance configuration + opt-out key); absent = every CMD063 answers OUTREACH_COMPLIANCE_UNCONFIGURED. */ readonly outreachSealer?: OutreachSealer; readonly buyerTypes?: BuyerTypeReader; readonly assurance?: AssuranceVerifier; /** The bound of the collaborator calls of CMD027 and CMD043 (realProviderCallTimer when absent; fault cells bind a clock-driven one). */ readonly providerTimer?: ProviderCallTimer; /** Where the failure of a collaborator call after its bound elapsed goes (stderr when absent). */ readonly onLateFailure?: LateFailureSink };
  /**
   * CMD027 CreateQuote's collaborators that replace the edition's (package B10, mandate B10-COMMANDS-QUOTE): the recorded buyer type (the
   * edition records none, so a quote is refused BUYER_TYPE_UNSET until B11 binds it), the re-binder of a paid purchase (the payment service's
   * when one is bound) and the test-only hold of the replacement protocol. The acceptance tests bind the labelled contract fakes here.
   */
  readonly quotes?: Partial<QuoteCollaborators>;
  /**
   * The commission group's service commands of package B10 (commissions/routes.ts; mandate B10-STATEMENTS-PAYOUTS): CloseCommissionPeriod
   * (CMD051) and ReconcileCommissionPayout (CMD053) run in the commission service's units of work (openCommissionPools), with the
   * platform's banking calendar and payout evidence (RecordedBankingCalendarSource, UnavailablePayoutEvidenceVerifier; D10-BIND-1) unless
   * the binding names others. Their routes are registered in every edition; without a binding they find no verified service identity.
   * The acceptance tests bind the labelled contract fakes of @kauro/application/testing here, never the production wiring.
   */
  readonly commissions?: CommissionRoutesBinding;
  /**
   * The bank-transfer route (Payments V1, lane L-ROUTE): the restricted evidence store its owner-supplied details artifacts are read from
   * and the account-details classifier of the bound integration, each read at call time (a world binds its store after start-up). Absent,
   * every route command and the transfer-instructions read answer CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE; the acceptance tests bind the
   * labelled CONTRACT_FAKE store and classifier of @kauro/application/testing (SIMULATED).
   */
  /**
   * Package B12 lane L-ACT: the public one-click opt-out (RFC 8058). `keys` are the opt-out token key versions, newest first (every version
   * verifies; the sealer mints with the newest); `units` routes the outreach service's SERVICE contexts to its verified
   * kauro_outreach pool (CommercePools.outreach), which this process does not open here. Absent, the opt-out routes are not served.
   */
  readonly optOut?: { readonly keys: ReadonlyArray<OptOutKey>; readonly units: CommerceUnitOfWorkFactory };
  readonly bank?: {
    readonly evidence: () => BankEvidenceStore | null;
    readonly classifier: () => BankEvidenceClassifier | null;
    /** Lane L-REFUND: the destination fingerprinter (DV1-10/11) and the credit classifier of the payer evidence, read at call time; absent, every owner refund approval answers CAPACITY_UNAVAILABLE EVIDENCE_UNAVAILABLE. */
    readonly fingerprinter?: () => DestinationFingerprinter | null;
    readonly creditClassifier?: () => BankCreditClassifier | null;
    /** Test-only: the named point an owner command passes between its evidence read and its unit (never bound by a deployment). */
    readonly hold?: (point: string) => Promise<void>;
  };
}

/**
 * Binds the authorizer, the nineteen command handlers (B06's seven, B07's six, B08's two job commands and four audit commands), the fourteen reads, the selection manifest and decision artifact intakes,
 * the request side of the payments workflow (CMD028, CMD029, CMD031, CMD032 and the four B09 reads), the agency lifecycle of package B10
 * (CMD002, CMD043), the payment service's routes (CMD030, CMD033, CMD034) and the HTTP server over an open unit-of-work factory.
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
  const cores = assembly.cores ?? unavailableCoreServices();
  const collaborators: B06Collaborators = {
    abuseLimiter: createAdmissionLimiter(),
    activeWork: activeWorkInspector,
    externalActions: externalActionInspector,
    commercialConsequences: commercialConsequencesInspector,
    ...planServices(cores),
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
    const service = createSessionService({ unitOfWork: runtime.unitOfWork, clock, ids, random: assembly.random ?? systemRandom, verifier: bound.verifier, store: bound.store, fence: { lockPresented: (uow, secretSha256, userId) => sessionFenceOf(uow).lockPresented(secretSha256, userId) } });
    authenticator = createSessionAuthenticator(assembly.authenticator, service, bound.appOrigins);
    sessions = { service, authenticator, appOrigins: bound.appOrigins, identityConfig: bound.identityConfig };
  }
  // package B11 lane A1: the agency app's stores — the recorded buyer type (CMD101 writes it; GetBuyerType, CMD027 and CMD047 read it) and the project dashboard
  const agencyApp: AgencyAppStores = { buyerTypes: (uow) => buyerTypesOf(uow), dashboard: (uow) => projectDashboardOf(uow) };
  const recordedBuyerTypes = new RecordedBuyerTypeReader(agencyApp);
  // package B13 (order 7): the agency's branding versions and stored logos (migrations 0095, 0096) — CMD008 records a version, the logo intake stores a logo
  const branding: BrandingStores = { branding: (uow) => reportSourcesOf(uow).brandingVersions };
  const readRuntime: SourceReadRuntime & ExecutionReadRuntime & AuditReadRuntime = { unitOfWork, authorizer: runtime.authorizer, clock, cursorKey, agencyApp };
  // package B08: the job commands run B06's pipeline in an execution unit of work of the same factory (design §12)
  const executionRuntime: ExecutionRuntime = { unitOfWork, authorizer: runtime.authorizer, clock, ids };
  // package B08: the audit commands on the same pipeline in an audit unit of work of the same factory (design §12)
  const auditRuntime: AuditRuntime = { unitOfWork, authorizer: runtime.authorizer, clock, ids };
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
  // Payments V1 bank-transfer route (lane L-ROUTE): the route tables and the effect instant of the commerce unit of work, the late-bound
  // evidence store and classifier, the step-up verifier and the provider-call bound of the store read
  const bank: BankInboundCollaborators = {
    routes: (uow) => bankRoutesOf(uow),
    credits: (uow) => bankCreditsOf(uow as never),
    hold: assembly.bank?.hold ?? (() => Promise.resolve()),
    effectNow: (uow) => effectInstantOf(uow),
    evidence: assembly.bank?.evidence ?? (() => null),
    classifier: assembly.bank?.classifier ?? (() => null),
    assurance: createAssuranceVerifier(),
    timer: assembly.commercial?.providerTimer ?? realProviderCallTimer,
    random: assembly.random ?? systemRandom,
    cursorKey,
    // lane L-REFUND: the refund tables of the payment service's unit, the fingerprinter and the payer-evidence classifier (late-bound)
    refunds: (uow) => bankRefundsOf(uow),
    fingerprinter: assembly.bank?.fingerprinter ?? (() => null),
    creditClassifier: assembly.bank?.creditClassifier ?? (() => null),
  };
  const commerceCollaborators: CommerceRequestCollaborators = { ...commerceEdition(), ...paymentService, bank, ...assembly.commerce };
  const bankRoutes = createBankRouteHandlers(commerceRuntime, bank);
  const bankRefunds = createBankRefundHandlers({ runtime: commerceRuntime, payment: commerceCollaborators.payment, paymentServiceId: commerceCollaborators.paymentServiceId, bank });
  // the owner's inbound credit commands and CMD214's record run on the request pool (kauro_app, D-ACH-16, D-INB-CTX-1/2)
  const bankInbound = createBankInboundHandlers(commerceRuntime, bank);
  // B12 GAP-API-8: the owner's evidence upload into the late-bound restricted store
  const bankUpload = createBankEvidenceUpload(commerceRuntime, bank);
  // CMD215 (lane PV1-SETTLE two-step): the owner's settlement intent and its reads, with the settlement tables of its unit and the cursor
  // key of the in-transit page; the payment service applies the intent (payments/bank-settlement-service.ts)
  const bankSettlement = createBankSettlementHandlers(commerceRuntime, { ...bank, settlements: (uow) => bankSettlementsOf(uow as never), cursorKey });
  const commerce = createCommerceRequestHandlers(commerceRuntime, commerceCollaborators);
  // package B10: the agency lifecycle (CMD002, CMD043) on the same runtime, over the lifecycle adapter of the persistence package, B06's
  // active-work inspector and the step-up verifier
  const commercial = createAgencyLifecycleHandlers(commerceRuntime, { lifecycle: agencyLifecycleOf, activeWork: collaborators.activeWork, assurance: createAssuranceVerifier(), ...(assembly.commercial?.providerTimer !== undefined ? { providerTimer: assembly.commercial.providerTimer } : {}), ...(assembly.commercial?.onLateFailure !== undefined ? { onLateFailure: assembly.commercial.onLateFailure } : {}) });
  // package B10: the prospect, claim and attribution commands (CMD045, CMD046, CMD047) in the caller's OPERATOR context, over the sales and
  // attribution adapters, the commercial authorizer's principals (the seller row and the owner grant, read after their transition locks)
  const prospectCollaborators = {
    authorizer: createCommercialAuthorizer({ principals: { binding: "PLATFORM", sellerOf: async (uow, userId) => commercialPrincipalsOf(uow).sellerOf(userId), ownerGrantOf: async (uow, userId) => commercialPrincipalsOf(uow).ownerGrantOf(userId) } }),
    sales: salesOf,
    attribution: attributionOf,
    orderPrecedesClaim: agencyOrderPrecedesClaim,
  };
  const prospects = createProspectHandlers(commerceRuntime, prospectCollaborators);
  // package B12 lane L-SOURCE: RecordProspectSource and RecordProspectContact replace their NOT_BUILT stubs
  const outreachCommands = { ...createOutreachStubCommandHandlers(), ...createProspectIntakeHandlers(commerceRuntime, prospectCollaborators) };
  // package B10: the seller commands (CMD048, CMD049, CMD050) on the same runtime, over the sales and attribution adapters, the commercial
  // authorizer (the corporate owner's grant) and the step-up verifier
  const sellers = createSellerCommandHandlers(commerceRuntime, { sales: salesOf, attribution: attributionOf, authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), assurance: createAssuranceVerifier() });
  // package B12 (lane L-OWNER, companion §P): the owner tools, the seller's destination change and claim evidence, on the same runtime over the
  // owner-tool store, the commercial authorizer and the step-up verifier
  const ownerTools = createOwnerToolHandlers(commerceRuntime, { tools: ownerToolsOf, authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), assurance: createAssuranceVerifier() });
  // package B18: the capability commands (CMD058 ChangeCapability, CMD059 RestrictCapability) on the same runtime, over the capability governance adapter and the corporate owner access
  // the operations service (decision B18-OPS-1: a member of the commission group's role) is the second principal of CMD056 and CMD059, when the commission service's pools are bound
  const operationsService = assembly.commissions === undefined ? undefined : operationsServiceRuntime(assembly.commissions, assembly.environment, clock);
  const serviceAuthenticator = assembly.commissions?.serviceAuthenticator ?? assembly.payments?.runtime.assembly.serviceAuthenticator ?? undefined;
  const capabilities = createCapabilityCommandHandlers(commerceRuntime, { governance: capabilityGovernanceOf, authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), ...(operationsService !== undefined ? { service: operationsService } : {}) });
  // package B16/B18: RecordIncident (CMD056) and AuthorizeRecovery (CMD057)
  // package B16 lane L4: the breakglass grants (CMD054, CMD055) and the preview read under them, on B07's storage adapter and preview reader
  const operationsCollaborators = { operations: operationsOf, breakglass: breakglassOf, authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), assurance: createAssuranceVerifier(), sources: { providers: sources.providers, preview: sources.preview } };
  const operations = createOperationsCommandHandlers(commerceRuntime, operationsCollaborators, operationsService);
  const operationsReads = createOperationsReadHandlers(commerceRuntime, operationsCollaborators);
  // package B10: CreateQuote (CMD027) on the same runtime, over the recurrence adapter and its issuance core, the recorded buyer type and
  // B09's re-binding of a paid purchase (the payment service's when bound, else the edition's lineage reader)
  const quotes = createQuoteHandlers(commerceRuntime, {
    request: commerceCollaborators,
    buyerType: assembly.commercial?.buyerTypes ?? recordedBuyerTypes,
    recurrence: recurrenceOf,
    reads: quoteReadsOf,
    rebinder: assembly.payments?.rebinder ?? createPurchaseRebinder({ lineage: sourceLineageReader }),
    ...(assembly.commercial?.providerTimer !== undefined ? { providerTimer: assembly.commercial.providerTimer } : {}),
    ...(assembly.commercial?.onLateFailure !== undefined ? { onLateFailure: assembly.commercial.onLateFailure } : {}),
    ...assembly.quotes,
  });
  // package B10: the statement and payout operations (mandate B10-STATEMENTS-PAYOUTS). ApproveCommissionPayout (CMD052) and the statement
  // read on the same runtime, over the statement, ledger and sales adapters, the commercial authorizer and the step-up verifier; the
  // commission group's service commands (CMD051, CMD053) on the commission service's own units of work, with the platform's calendar
  // and payout evidence unless the binding names others (D10-BIND-1)
  const statements = createStatementRequestHandlers(commerceRuntime, {
    statements: statementsOf,
    ledger: ledgerOf,
    sales: salesOf,
    serverNow: async (uow) => `${(await (uow as unknown as { serverInstant(): Promise<string> }).serverInstant()).slice(0, 23)}Z` as UtcInstant,
    authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }),
    assurance: assembly.commercial?.assurance ?? createAssuranceVerifier(),
  });
  // package B12 lane L-HOME (R2-066): the seller's home, served to a seller in any state
  const sellerHome = getSellerHomeHandler(commerceRuntime, {
    statements: statementsOf,
    ledger: ledgerOf,
    sales: salesOf,
    serverNow: async (uow) => `${(await (uow as unknown as { serverInstant(): Promise<string> }).serverInstant()).slice(0, 23)}Z` as UtcInstant,
    authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }),
    assurance: assembly.commercial?.assurance ?? createAssuranceVerifier(),
    supportRoute: () => assembly.commercial?.sellerSupportRoute ?? null,
  });
  // package B12 lane L-AUTH: CMD062, PrepareOutreachReview, RevokeOutreachAuthorization, WithdrawOutreachChannelPolicy and GetOutreachReview replace their NOT_BUILT stubs
  const outreachAuthCollaborators = { store: outreachAuthOf, authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), assurance: createAssuranceVerifier() };
  const outreachAuthCommands = createOutreachAuthCommandHandlers(commerceRuntime, outreachAuthCollaborators);
  const outreachAuthReads = createOutreachAuthReadHandlers(commerceRuntime, outreachAuthCollaborators);
  // package B12 lane L-DRAFT: the draft commands and GetOutreachDraft replace their NOT_BUILT stubs
  const outreachDraftCollaborators = { authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), drafts: outreachDraftsOf, assurance: assembly.commercial?.assurance ?? createAssuranceVerifier() };
  const outreachDraftCommands = createOutreachDraftCommandHandlers(commerceRuntime, outreachDraftCollaborators);
  const outreachDraftReads = createOutreachDraftReadHandlers(commerceRuntime, outreachDraftCollaborators);
  // package B12 (L-SEND): CMD063 and the sender routes over the kit's stubs
  const sendLane = createSendLaneHandlers(commerceRuntime, { authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), assurance: assembly.commercial?.assurance ?? createAssuranceVerifier(), sealer: assembly.commercial?.outreachSealer ?? outreachSealerOf({ compliance: null, optOutKey: null }) });
  // package B12 lane L-ACT: CMD064, RecordOutreachDiagnosis, ListSalesActivities and GetOutreachMetrics replace their NOT_BUILT stubs
  const activityCollaborators = { authorizer: createCommercialAuthorizer({ principals: commercialPrincipalReader }), activity: outreachActivityOf, assurance: assembly.commercial?.assurance ?? createAssuranceVerifier() };
  const activityCommands = createActivityCommandHandlers(commerceRuntime, activityCollaborators);
  const activityReads = createActivityReadHandlers(commerceRuntime, activityCollaborators);
  // the public opt-out over the outreach service's store (kauro_outreach SERVICE units), when the deployment binds it
  const optOut = assembly.optOut === undefined ? undefined : { keys: assembly.optOut.keys, store: new PgOptOutStore(assembly.optOut.units, ids) };
  return createApiServer({
    ...(optOut !== undefined ? { optOut } : {}),
    ...(assembly.oneTimeDelivery !== undefined ? { oneTimeDelivery: assembly.oneTimeDelivery } : {}),
    environment: assembly.environment,
    handlers: { ...createB06Handlers(runtime, collaborators), ...createB07Handlers(runtime, sources), ...createRetentionHandlers(runtime), ...createExecutionHandlers(executionRuntime, assembly.readSigner !== undefined ? { signer: assembly.readSigner } : {}), ...createAuditHandlers(auditRuntime, cores), ...createSupportHandlers(runtime), ...createTeamHandlers(runtime, { random: assembly.random ?? systemRandom }), ...createBrandingHandlers(runtime, branding) },
    reads: { ...createReadHandlers(readRuntime), ...createSourceReadHandlers(readRuntime, sources), ...createExecutionReadHandlers(readRuntime), ...createAuditReadHandlers(readRuntime) },
    intakes: { ...createSourceIntakeHandlers(readRuntime), ...createAuditIntakeHandlers(readRuntime), ...createBrandingIntakeHandlers(readRuntime, branding) },
    commercial: {
      commands: [...Object.values(commercial), ...Object.values(quotes), ...Object.values(prospects), ...Object.values(sellers), ...Object.values(ownerTools), ...Object.values(capabilities), ...Object.values(operations), statements.CMD052, ...Object.values({ ...outreachCommands, ...outreachAuthCommands, ...outreachDraftCommands, ...sendLane, ...activityCommands })] as ReadonlyArray<CommercialCommandHandler<unknown, unknown>>,
      reads: [statements.GetCommissionStatement, operationsReads.PreviewTableUnderBreakglass, sellerHome, ...Object.values({ ...createOutreachStubReadHandlers(), ...outreachAuthReads, ...outreachDraftReads, ...activityReads })] as ReadonlyArray<CommercialReadHandler<unknown>>,
      ...(serviceAuthenticator !== undefined ? { serviceAuthenticator } : {}),
    },
    commerce: { commands: Object.values(commerce.commands) as ReadonlyArray<CommerceCommandHandler<unknown, unknown>>, reads: Object.values(commerce.reads) as ReadonlyArray<CommerceReadHandler<unknown>> },
    authenticator,
    refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request),
    refuseCredentials: (action, request, failure) => refuseAnonymously(runtime, action, request, failure, SESSION_POLICY_VERSION),
    ...(sessions !== undefined ? { sessions } : {}),
    validator,
    clock,
    ids,
    paymentRoutes: (app, kit) => {
      registerPaymentRoutes(app, kit, { payments: assembly.payments ?? null, validator, clock, refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request) });
      registerBankRouteRoutes(app, kit, { handlers: bankRoutes, inbound: bankInbound, upload: bankUpload, settlement: bankSettlement, runtime: commerceRuntime, bank, validator, clock, environment: assembly.environment, refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request), refunds: bankRefunds });
    },
    agencyRoutes: (app, kit) => registerAgencyAppRoutes(app, kit, { handlers: createAgencyAppHandlers(runtime, agencyApp), validator, clock, environment: assembly.environment }),
    commissionRoutes: (app, kit) =>
      registerCommissionRoutes(app, kit, {
        binding: assembly.commissions ?? null,
        serviceAuthenticator: assembly.commissions?.serviceAuthenticator ?? assembly.payments?.runtime.assembly.serviceAuthenticator ?? null,
        persons: assembly.authenticator,
        environment: assembly.environment,
        validator,
        clock,
        refuseUnauthenticated: (action, request) => refuseUnauthenticated(runtime, action, request),
        refusePerson: async (action, userId, correlationId, failure) => {
          await recordOperatorDenial(commerceRuntime, { kind: "OPERATOR", userId: userId as UserId, correlationId }, action, failure, COMMERCE_POLICY_VERSION, null);
          return problemOf(failure, correlationId);
        },
      }),
    health: { readiness: () => assembly.database.readiness(), codeSchemaVersion: assembly.database.codeSchemaVersion, onNotReady: assembly.onNotReady ?? writeNotReady },
    ...(assembly.logger !== undefined ? { logger: assembly.logger } : {}),
    ...(assembly.onInternalError !== undefined ? { onInternalError: assembly.onInternalError } : {}),
    ...(assembly.publicApi !== undefined ? { publicApi: assembly.publicApi, onUnavailable: assembly.onUnavailable ?? writeUnavailable } : {}),
    ...(assembly.trustedProxyHops !== undefined ? { trustedProxyHops: assembly.trustedProxyHops } : {}),
    ...(assembly.clientAddressKey !== undefined ? { clientAddressKey: assembly.clientAddressKey } : {}),
    ...(assembly.limits !== undefined ? { limits: assembly.limits } : {}),
  });
}

export interface StartOptions extends Omit<ApiAssembly, "environment" | "unitOfWork" | "database" | "trustedProxyHops" | "limits" | "sessions" | "publicApi"> {
  /** The key of the inquiry digests, read from the file the configuration names; required when the configuration binds the public routes. */
  readonly publicHashKey?: Uint8Array;
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
  const { random, migratorPassword, onPoolError, identityKeySource, publicHashKey, ...assembly } = options;
  if (config.publicApi !== null && publicHashKey === undefined) throw new RangeError("the configuration binds the public routes: the key of the inquiry digests must be given");
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
      ...(config.publicApi !== null && publicHashKey !== undefined
        ? {
            publicApi: {
              origins: { public: config.publicApi.publicOrigin, app: config.publicApi.appOrigin },
              inquiries: new PgInquiryStore(database.pool),
              capabilities: new PgCapabilityPublication(database.pool),
              hashKey: publicHashKey,
            },
          }
        : {}),
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
