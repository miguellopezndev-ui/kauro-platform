/**
 * @kauro/api — the Kauro HTTP API entrypoint (Fastify). `createApiServer` composes the seven B06 command routes over the
 * handlers, the closed schema validator, the authenticator and the clock/id ports, and the liveness/readiness probes outside
 * /api/v1 (`health.ts`: HEALTH_ROUTES and their response schemas); `loadContractSchemas` reads the generated contract bundle
 * once at start-up. The composition root binds the PostgreSQL adapters: `loadConfig` reads the environment, `openDatabase`
 * applies migrations on start when configured and opens the verified runtime pool, `assembleApi` binds the authorizer, the
 * handlers and the server over a unit-of-work factory, `startApi` runs both, and `bootstrap` adds the authenticator of the
 * environment, listens and offers the bounded `shutdown` (`main.ts` is the process entry).
 */
export { createApiServer, fastifyPath, classifyInternalError, clientNetworkOf, DEFAULT_HTTP_LIMITS } from "./server.js";
export type { ApiServerOptions, ApiLogger, CommandReply, HttpLimits } from "./server.js";
export { HEALTH_ROUTES, HEALTH_PATHS, LIVENESS_RESPONSE_SCHEMA, READINESS_RESPONSE_SCHEMA, readinessOf, registerHealthRoutes } from "./health.js";
export type { DatabaseReadiness, HealthOptions, LivenessResponse, ReadinessResponse } from "./health.js";
export { createBearerTokenAuthenticator, subjectOf, parseBearerTokenFile, loadBearerTokenFile, BearerTokenFileError } from "./authenticator.js";
export type { Authenticator, SubjectFacts, BearerTokenEntry } from "./authenticator.js";
export { loadContractSchemas } from "./schemas.js";
export { loadConfig, ConfigError, API_POOL_CEILING, SHUTDOWN_DEADLINE_CEILING_MS, MIGRATOR_PASSWORD_VARIABLE } from "./config.js";
export type { ApiConfig, DatabaseConnectionConfig, HttpConfig, MigratorConfig } from "./config.js";
export { openProjectsInspector, noExternalActionsInThisEdition, unavailablePlanServices } from "./edition.js";
export type { PlanServices } from "./edition.js";
export {
  openDatabase,
  assembleApi,
  startApi,
  reportingUnavailability,
  writeUnavailable,
  writeNotReady,
  systemClock,
  systemRandom,
  API_APPLICATION_NAME,
  READINESS_STATEMENT_TIMEOUT_MS,
} from "./composition.js";
export type { DatabaseHandle, DatabaseConfig, DatabaseDependencies, ApiAssembly, StartOptions, StartedApi } from "./composition.js";
export { bootstrap, authenticatorOf, shutdownWithin } from "./bootstrap.js";
export type { BootstrappedApi, BootstrapOptions, ShutdownOutcome } from "./bootstrap.js";
