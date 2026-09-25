/**
 * Process entry of the Kauro api (`node dist/src/main.js`). The whole start sequence is `bootstrap` (configuration, the
 * migrator's secret taken out of the process environment, authenticator, migrations on start when configured, verified pool,
 * server, listen); this file adds the process concerns only: SIGTERM/SIGINT drain the server and then the pool within the
 * shutdown deadline (KAURO_SHUTDOWN_DEADLINE_MS, below the platform's grace period; review R35) and exit, and every start
 * failure is reported by class and variable name, never by value (08 "Secrets and supply chain").
 */
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const api = await bootstrap(process.env);
  const migrated = api.database.migrations ? ` (migrations applied: ${api.database.migrations.applied.length}, already applied: ${api.database.migrations.skipped.length})` : "";
  process.stderr.write(`kauro-api ${api.config.environment} listening on ${api.address}${migrated}\n`);
  const shutdown = (signal: string): void => {
    process.stderr.write(`kauro-api ${signal}: draining (deadline ${api.config.http.shutdownDeadlineMs} ms)\n`);
    api.shutdown().then(
      (outcome) => {
        if (outcome.kind === "CLOSED") {
          process.stderr.write("kauro-api drained and closed\n");
          process.exit(0);
        }
        process.stderr.write("kauro-api shutdown deadline exceeded: the remaining connections were closed; open transactions end with the process\n");
        process.exit(1);
      },
      (e: unknown) => {
        process.stderr.write(`kauro-api close failed: ${e instanceof Error ? e.name : typeof e}\n`);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  process.stderr.write(`kauro-api failed to start: ${description}\n`);
  process.exitCode = 1;
});
