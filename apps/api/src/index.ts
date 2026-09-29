/**
 * @kauro/api — the Kauro HTTP API entrypoint (Fastify). `createApiServer` composes the seven B06 command routes over the
 * handlers, the closed schema validator, the authenticator and the clock/id ports, and the liveness/readiness probes outside
 * /api/v1 (`health.ts`: HEALTH_ROUTES and their response schemas); `loadContractSchemas` reads the generated contract bundle
 * once at start-up. The composition root binds the PostgreSQL adapters: `loadConfig` reads the environment, `openDatabase`
 * applies migrations on start when configured and opens the verified runtime pool, `assembleApi` binds the authorizer, the
 * handlers and the server over a unit-of-work factory, `startApi` runs both, and `bootstrap` adds the authenticator of the
 * environment, listens and offers the bounded `shutdown` (`main.ts` is the process entry). `runMigrationJob` is the one-shot
 * migration job (`migrate.ts` is its process entry): the only process that receives the owner's credential (N7).
 * The browser session boundary of B11 W2 (design D-AUTH-1..5): `createIdentityTokenVerifier` (jose; key sources GOOGLE_X509 and,
 * in LOCAL only, CONTRACT_FAKE), the SessionAuthenticator and the session routes (`sessions.ts`), bound by `assembleApi`'s
 * `sessions` and, from the configuration, by `startApi`.
 */
export { createApiServer, fastifyPath, classifyInternalError, clientNetworkOf, routeInventoryOf, DEFAULT_HTTP_LIMITS } from "./server.js";
export type { ApiServerOptions, ApiLogger, CommandReply, HttpLimits, ReadReply, RouteInventoryEntry } from "./server.js";
export { HEALTH_ROUTES, HEALTH_PATHS, LIVENESS_RESPONSE_SCHEMA, READINESS_RESPONSE_SCHEMA, readinessOf, registerHealthRoutes } from "./health.js";
export type { DatabaseReadiness, HealthOptions, LivenessResponse, ProbeResponse, ProbeRoute, ProbeSchema, ReadinessResponse } from "./health.js";
export { createBearerTokenAuthenticator, subjectOf, parseBearerTokenFile, loadBearerTokenFile, BearerTokenFileError, authenticationOf } from "./authenticator.js";
export type { Authenticator, Authentication, AuthenticationRequest, SubjectFacts, BearerTokenEntry } from "./authenticator.js";
export { createIdentityTokenVerifier, GOOGLE_SECURETOKEN_X509_URL, IDENTITY_PLATFORM_PROVIDER, MAX_ID_TOKEN_LENGTH } from "./identity-verifier.js";
export type { IdentityTokenVerifierOptions, IdentityKeySource, JsonWebKeySet, KeyDocumentFetch } from "./identity-verifier.js";
export { createSessionAuthenticator, registerSessionRoutes, assertIdentityConfig } from "./sessions.js";
export type { SessionAssembly, SessionRoutesOptions, IdentityConfigView } from "./sessions.js";
export { loadContractSchemas } from "./schemas.js";
export {
  loadConfig,
  loadMigrationJobConfig,
  readSecretFile,
  ConfigError,
  API_POOL_CEILING,
  SHUTDOWN_DEADLINE_CEILING_MS,
  MIGRATOR_PASSWORD_VARIABLE,
  MIGRATOR_PASSWORD_FILE_VARIABLE,
  CURSOR_KEY_FILE_VARIABLE,
  IDENTITY_VARIABLES,
  ASSURANCE_POOL_CEILING,
  readKeyFile,
} from "./config.js";
export type { ApiConfig, DatabaseConnectionConfig, HttpConfig, MigratorConfig, MigrationJobConfig, IdentityConfig } from "./config.js";
export { runMigrationJob } from "./migration-job.js";
export type { MigrationJobOutcome } from "./migration-job.js";
export { openProjectsInspector, noExternalActionsInThisEdition, noCommercialConsequencesInThisEdition, unavailablePlanServices } from "./edition.js";
export type { PlanServices } from "./edition.js";
export {
  openDatabase,
  applyMigrationsWith,
  assembleApi,
  startApi,
  reportingUnavailability,
  writeUnavailable,
  writeNotReady,
  systemClock,
  systemRandom,
  sessionAssemblyOf,
  API_APPLICATION_NAME,
  SESSIONS_APPLICATION_NAME,
  READINESS_STATEMENT_TIMEOUT_MS,
} from "./composition.js";
export type { DatabaseHandle, DatabaseConfig, DatabaseDependencies, ApiAssembly, StartOptions, StartedApi } from "./composition.js";
export { bootstrap, authenticatorOf, shutdownWithin, readFakeJwks, identityKeySourceOf } from "./bootstrap.js";
export type { BootstrappedApi, BootstrapOptions, ShutdownOutcome } from "./bootstrap.js";
