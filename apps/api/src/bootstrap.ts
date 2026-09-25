/**
 * Bootstrap of the api process from the environment (14 "Deployment and rollback": the accepted artifact starts from explicit
 * environment configuration and refuses to start when a required input is missing). Order: configuration → the migrator's
 * secret taken out of the environment → authenticator → database (migrations on start when configured, verified pool) →
 * server → listen. `main.ts` calls this and wires the signals; the tests call it against a temporary cluster to prove the
 * deployment path itself.
 *
 * Authentication in this edition (I-INT-3): the LOCAL environment reads the bearer-token file; SANDBOX and LIVE need the
 * Identity Platform verifier, which is not bound here, so the process refuses to start in those environments instead of
 * serving requests nobody can authenticate.
 *
 * The migrator's password is consumed, not kept (review R44; 07 "Migration roles are separate from runtime"; 08 "privileged
 * migration roles are never used by request handlers"): it is removed from the environment object bootstrap receives — the
 * process environment in a deployment — before anything else runs, handed to the migration connection only, and it is no
 * part of the configuration the running process keeps. Shutdown is bounded (review R35): `shutdown()` drains the server —
 * every answer from then on closes its connection — and the pool, and gives up at the configured deadline, below the
 * platform's grace period, closing whatever connections remain.
 */
import { createBearerTokenAuthenticator, loadBearerTokenFile, type Authenticator } from "./authenticator.js";
import { startApi, type StartedApi, type StartOptions } from "./composition.js";
import { ConfigError, MIGRATOR_PASSWORD_VARIABLE, loadConfig, type ApiConfig } from "./config.js";

export function authenticatorOf(config: ApiConfig): Authenticator {
  if (config.environment === "LOCAL") {
    if (config.bearerTokensFile === null) throw new ConfigError("KAURO_AUTH_BEARER_TOKENS_FILE", "is required in the LOCAL environment of this edition");
    return createBearerTokenAuthenticator(loadBearerTokenFile(config.bearerTokensFile));
  }
  throw new ConfigError("KAURO_ENVIRONMENT", `${config.environment} needs the Identity Platform verifier, which this edition does not bind (I-INT-3)`);
}

/** CLOSED: the drain finished in time. DEADLINE_EXCEEDED: the remaining connections were closed; `closing` settles later. */
export type ShutdownOutcome = { readonly kind: "CLOSED" } | { readonly kind: "DEADLINE_EXCEEDED"; readonly closing: Promise<void> };

export interface BootstrappedApi extends StartedApi {
  readonly config: ApiConfig;
  /** The listening address (http://host:port). */
  readonly address: string;
  /** Drains the server and the pool within config.http.shutdownDeadlineMs (R35). */
  shutdown(): Promise<ShutdownOutcome>;
}

export type BootstrapOptions = Pick<StartOptions, "logger" | "onInternalError" | "onUnavailable" | "onNotReady" | "onPoolError">;

/**
 * Closes `api` (server drain, then pool) and waits at most `deadlineMs`. When the deadline passes first, every connection
 * still open is closed at once; the requests on them get no answer, and a transaction they left open ends when the process
 * exits (its client retries with the same idempotency key: 10 "A response lost after commit is recovered by the same key").
 */
export async function shutdownWithin(api: StartedApi, deadlineMs: number): Promise<ShutdownOutcome> {
  const closing = api.close();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"DEADLINE">((resolve) => {
    timer = setTimeout(() => resolve("DEADLINE"), deadlineMs);
  });
  try {
    const first = await Promise.race([closing.then(() => "CLOSED" as const), deadline]);
    if (first === "CLOSED") return { kind: "CLOSED" };
  } finally {
    clearTimeout(timer);
  }
  api.app.server.closeAllConnections();
  return { kind: "DEADLINE_EXCEEDED", closing };
}

/**
 * Configuration → migrator secret → authenticator → database → server → listen; nothing stays open when a step fails. `env`
 * loses KAURO_DB_MIGRATOR_PASSWORD (R44).
 */
export async function bootstrap(env: Record<string, string | undefined>, options: BootstrapOptions = {}): Promise<BootstrappedApi> {
  const config = loadConfig(env);
  const migratorPassword = env[MIGRATOR_PASSWORD_VARIABLE];
  delete env[MIGRATOR_PASSWORD_VARIABLE];
  const authenticator = authenticatorOf(config);
  const started = await startApi(config, {
    authenticator,
    logger: options.logger ?? true,
    ...(migratorPassword !== undefined && migratorPassword !== "" ? { migratorPassword } : {}),
    ...(options.onInternalError !== undefined ? { onInternalError: options.onInternalError } : {}),
    ...(options.onUnavailable !== undefined ? { onUnavailable: options.onUnavailable } : {}),
    ...(options.onNotReady !== undefined ? { onNotReady: options.onNotReady } : {}),
    ...(options.onPoolError !== undefined ? { onPoolError: options.onPoolError } : {}),
  });
  let address: string;
  try {
    address = await started.app.listen({ host: config.http.host, port: config.http.port });
  } catch (e) {
    await started.close();
    throw e;
  }
  return { ...started, config, address, shutdown: () => shutdownWithin(started, config.http.shutdownDeadlineMs) };
}
