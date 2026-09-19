/**
 * @kauro/api — the Kauro HTTP API entrypoint (Fastify). `createApiServer` composes the seven B06 command routes over the
 * handlers, the closed schema validator, the authenticator and the clock/id ports; `loadContractSchemas` reads the generated
 * contract bundle once at start-up. Binding the PostgreSQL adapters (unit of work, repositories, journals) and the Identity
 * Platform verifier into this server is the integration step of the B06 mandate.
 */
export { createApiServer, fastifyPath } from "./server.js";
export type { ApiServerOptions, CommandReply } from "./server.js";
export { createBearerTokenAuthenticator, subjectOf } from "./authenticator.js";
export type { Authenticator, SubjectFacts } from "./authenticator.js";
export { loadContractSchemas } from "./schemas.js";
