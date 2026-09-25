/**
 * Bootstrap of the api process from the environment (14 "Deployment and rollback": the accepted artifact starts from explicit
 * environment configuration and refuses to start when a required input is missing). Order: configuration → authenticator →
 * database (LOCAL migrations on start when configured, verified pool) → server → listen. `main.ts` calls this and wires the signals; the tests call it against a temporary cluster to prove the
 * deployment path itself.
 *
 * Authentication in this edition (I-INT-3): the LOCAL environment reads the bearer-token file; SANDBOX and LIVE need the
 * Identity Platform verifier, which is not bound here, so the process refuses to start in those environments instead of
 * serving requests nobody can authenticate.
 *
 * The serving process never holds the owner's credential in its environment (review R44 and re-check finding N7; 07
 * "Migration roles are separate from runtime"; 08 "privileged migration roles are never used by request handlers"):
 * loadConfig refuses KAURO_DB_MIGRATOR_PASSWORD by name, because removing it from process.env would leave it in the initial
 * environment block the operating system keeps for the process (/proc/<pid>/environ on Linux). SANDBOX and LIVE apply
 * migrations with the one-shot job (`node dist/src/migrate.js`) before traffic shifts; LOCAL may migrate on start, and then
 * the password is read from the file KAURO_DB_MIGRATOR_PASSWORD_FILE names, handed to the migration connection only, and is no
 * part of the configuration the running process keeps. Shutdown is bounded (review R35): `shutdown()` drains the server —
 * every answer from then on closes its connection — and the pool, and gives up at the configured deadline, below the
 * platform's grace period, closing whatever connections remain.
 */
import { createBearerTokenAuthenticator, loadBearerTokenFile, type Authenticator } from "./authenticator.js";
import { startApi, type StartedApi, type StartOptions } from "./composition.js";
import { CURSOR_KEY_FILE_VARIABLE, ConfigError, MIGRATOR_PASSWORD_FILE_VARIABLE, loadConfig, readKeyFile, readSecretFile, type ApiConfig } from "./config.js";

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
 * Configuration → authenticator → database → server → listen; nothing stays open when a step fails. `env` is read, never
 * changed: a serving process given KAURO_DB_MIGRATOR_PASSWORD refuses to start (N7).
 */
export async function bootstrap(env: Readonly<Record<string, string | undefined>>, options: BootstrapOptions = {}): Promise<BootstrappedApi> {
  const config = loadConfig(env);
  const authenticator = authenticatorOf(config);
  const passwordFile = config.migrateOnStart?.passwordFile ?? null;
  const migratorPassword = passwordFile === null ? undefined : readSecretFile(MIGRATOR_PASSWORD_FILE_VARIABLE, passwordFile);
  const cursorKey = config.cursorKeyFile === null ? undefined : readKeyFile(CURSOR_KEY_FILE_VARIABLE, config.cursorKeyFile);
  const started = await startApi(config, {
    authenticator,
    logger: options.logger ?? true,
    ...(migratorPassword !== undefined ? { migratorPassword } : {}),
    ...(cursorKey !== undefined ? { cursorKey } : {}),
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
