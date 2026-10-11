/**
 * The one-shot migration job of the api artifact (re-check finding N7, the residual of review R44; 07 "Restoration and
 * migration": migration roles are separate from runtime; 08 "privileged migration roles are never used by request handlers";
 * 14 "Deployment and rollback": the schema moves before traffic shifts to the release that needs it).
 *
 * `node dist/src/migrate.js` (migrate.ts) applies the pending migrations as the owner role and exits. In SANDBOX and LIVE it
 * runs as its own job before the serving revision takes traffic, so the owner's credential lives only in a process that
 * serves nothing and ends. The serving process refuses that credential by name (loadConfig): deleting a variable from
 * process.env leaves it in the initial environment block the operating system keeps (/proc/<pid>/environ on Linux), so a
 * serving process must never be given it. LOCAL may still migrate on start, reading the password from a file.
 */
import type { ApplyResult } from "@kauro/persistence";
import { applyMigrationsWith } from "./composition.js";
import { MIGRATOR_PASSWORD_FILE_VARIABLE, MIGRATOR_PASSWORD_VARIABLE, loadMigrationJobConfig, readSecretFile, type MigrationJobConfig } from "./config.js";

export interface MigrationJobOutcome {
  readonly config: MigrationJobConfig;
  readonly result: ApplyResult;
}

/**
 * The job: its configuration (loadMigrationJobConfig), the owner's password from KAURO_DB_MIGRATOR_PASSWORD or from the file
 * KAURO_DB_MIGRATOR_PASSWORD_FILE names (never both), and the migrations. A refusal names variables and error classes only.
 */
export async function runMigrationJob(env: Readonly<Record<string, string | undefined>>): Promise<MigrationJobOutcome> {
  const config = loadMigrationJobConfig(env);
  const inEnvironment = env[MIGRATOR_PASSWORD_VARIABLE];
  const password =
    config.migrator.passwordFile !== null
      ? readSecretFile(MIGRATOR_PASSWORD_FILE_VARIABLE, config.migrator.passwordFile)
      : inEnvironment === undefined || inEnvironment === ""
        ? undefined
        : inEnvironment;
  return { config, result: await applyMigrationsWith(config.databaseEnvironment, config.migrator, password) };
}
