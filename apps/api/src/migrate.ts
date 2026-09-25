/**
 * Process entry of the one-shot migration job (`node dist/src/migrate.js`; re-check finding N7): applies the pending
 * migrations as the owner role and exits 0, or reports the failure by class and variable name, never by value (08 "Secrets and
 * supply chain"), and exits 1. It serves nothing; the api process (`main.ts`) never receives the owner's credential.
 */
import { runMigrationJob } from "./migration-job.js";

runMigrationJob(process.env).then(
  ({ config, result }) => {
    process.stdout.write(`kauro-migrate ${config.environment}: migrations applied: ${result.applied.length}, already applied: ${result.skipped.length}\n`);
  },
  (e: unknown) => {
    const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    process.stderr.write(`kauro-migrate failed: ${description}\n`);
    process.exitCode = 1;
  },
);
