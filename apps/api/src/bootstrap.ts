/**
 * Bootstrap of the api process from the environment (14 "Deployment and rollback": the accepted artifact starts from explicit
 * environment configuration and refuses to start when a required input is missing). Order: configuration → authenticator →
 * database (migrations on start when configured, verified pool) → server → listen. `main.ts` calls this and wires the
 * signals; the tests call it against a temporary cluster to prove the deployment path itself.
 *
 * Authentication in this edition (I-INT-3): the LOCAL environment reads the bearer-token file; SANDBOX and LIVE need the
 * Identity Platform verifier, which is not bound here, so the process refuses to start in those environments instead of
 * serving requests nobody can authenticate.
 */
import { createBearerTokenAuthenticator, loadBearerTokenFile, type Authenticator } from "./authenticator.js";
import { startApi, type StartedApi } from "./composition.js";
import { ConfigError, loadConfig, type ApiConfig } from "./config.js";

export function authenticatorOf(config: ApiConfig): Authenticator {
  if (config.environment === "LOCAL") {
    if (config.bearerTokensFile === null) throw new ConfigError("KAURO_AUTH_BEARER_TOKENS_FILE", "is required in the LOCAL environment of this edition");
    return createBearerTokenAuthenticator(loadBearerTokenFile(config.bearerTokensFile));
  }
  throw new ConfigError("KAURO_ENVIRONMENT", `${config.environment} needs the Identity Platform verifier, which this edition does not bind (I-INT-3)`);
}

export interface BootstrappedApi extends StartedApi {
  readonly config: ApiConfig;
  /** The listening address (http://host:port). */
  readonly address: string;
}

export interface BootstrapOptions {
  readonly logger?: boolean;
}

/** Configuration → authenticator → database → server → listen; nothing stays open when a step fails. */
export async function bootstrap(env: Readonly<Record<string, string | undefined>>, options: BootstrapOptions = {}): Promise<BootstrappedApi> {
  const config = loadConfig(env);
  const authenticator = authenticatorOf(config);
  const started = await startApi(config, { authenticator, logger: options.logger ?? true });
  let address: string;
  try {
    address = await started.app.listen({ host: config.http.host, port: config.http.port });
  } catch (e) {
    await started.close();
    throw e;
  }
  return { ...started, config, address };
}
