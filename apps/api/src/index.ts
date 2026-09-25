/**
 * @kauro/api — the Kauro HTTP API entrypoint (Fastify). `createApiServer` composes the seven B06 command routes over the
 * handlers, the closed schema validator, the authenticator and the clock/id ports; `loadContractSchemas` reads the generated
 * contract bundle once at start-up. The composition root binds the PostgreSQL adapters: `loadConfig` reads the environment,
 * `openDatabase` applies migrations on start when configured and opens the verified runtime pool, `assembleApi` binds the
 * authorizer, the handlers and the server over a unit-of-work factory, `startApi` runs both, and `bootstrap` adds the
 * authenticator of the environment and listens (`main.ts` is the process entry).
 */
export { createApiServer, fastifyPath, classifyInternalError, routeInventoryOf } from "./server.js";
export type { ApiServerOptions, CommandReply, RouteInventoryEntry } from "./server.js";
export { createBearerTokenAuthenticator, subjectOf, parseBearerTokenFile, loadBearerTokenFile, BearerTokenFileError } from "./authenticator.js";
export type { Authenticator, SubjectFacts, BearerTokenEntry } from "./authenticator.js";
export { loadContractSchemas } from "./schemas.js";
export { loadConfig, ConfigError } from "./config.js";
export type { ApiConfig, DatabaseConnectionConfig } from "./config.js";
export { openProjectsInspector, noExternalActionsInThisEdition, unavailablePlanServices } from "./edition.js";
export type { PlanServices } from "./edition.js";
export { openDatabase, assembleApi, startApi, systemClock, systemRandom, API_APPLICATION_NAME } from "./composition.js";
export type { DatabaseHandle, DatabaseDependencies, ApiAssembly, StartOptions, StartedApi } from "./composition.js";
export { bootstrap, authenticatorOf } from "./bootstrap.js";
export type { BootstrappedApi, BootstrapOptions } from "./bootstrap.js";
