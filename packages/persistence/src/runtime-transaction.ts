/**
 * One short runtime transaction outside any tenant context (B11 W5b: the two public routes). A visitor without a session has no
 * agency and no user, so the unit of work of manual 07 (which binds one) does not apply; these stores run under the runtime role
 * kauro_app with no tenant setting bound, and the policies of their tables (0024) say exactly what that role may touch.
 *
 * The shape is the unit of work's: a verified connection, BEGIN at READ COMMITTED (the invariants here are enforced by
 * transaction-scoped advisory locks), SET LOCAL statement_timeout, the work, a COMMIT whose command tag is checked (a COMMIT inside
 * an aborted block answers ROLLBACK without an error), and ROLLBACK on any failure. A refusal of the database becomes the typed
 * failure of the SQLSTATE table; anything else becomes INTERNAL_ERROR carrying the original error as `cause` for the server log.
 */
import { DomainFailure, isDomainFailure } from "@kauro/domain";
import type { PoolClient } from "pg";
import type { KauroPool } from "./pool.js";
import { execute, translateDatabaseError } from "./sql.js";

export interface RuntimeTransactionOptions {
  /** Statement timeout of the transaction in milliseconds (5 s by default: these are short, indexed statements). */
  readonly statementTimeoutMs?: number;
  /** Refuses any write in the transaction (the publication read). */
  readonly readOnly?: boolean;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

function asFailure(e: unknown): DomainFailure {
  if (isDomainFailure(e)) return e;
  const translated = translateDatabaseError(e);
  if (translated) {
    translated.cause = e;
    return translated;
  }
  const failure = new DomainFailure("INTERNAL_ERROR", "public runtime transaction failed", {}, true);
  failure.cause = e;
  return failure;
}

export async function inRuntimeTransaction<T>(pool: KauroPool, work: (client: PoolClient) => Promise<T>, options: RuntimeTransactionOptions = {}): Promise<T> {
  const timeoutMs = Math.max(1, Math.floor(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  let acquired: Awaited<ReturnType<KauroPool["acquire"]>>;
  try {
    acquired = await pool.acquire();
  } catch (e) {
    if (e instanceof Error && e.name === "PrivilegedRoleError") throw e;
    const failure = new DomainFailure("CAPACITY_UNAVAILABLE", "no database connection available", { retryAfterSeconds: 1 }, true);
    failure.cause = e;
    throw failure;
  }
  const { client, connection } = acquired;
  if (connection.role !== "kauro_app") {
    client.release();
    throw new DomainFailure("INTEGRITY_FAILURE", `a public request runs under kauro_app, this pool is ${connection.role} (08 Database isolation)`);
  }
  let destroy: Error | undefined;
  try {
    await execute(client, options.readOnly === true ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY" : "BEGIN ISOLATION LEVEL READ COMMITTED");
    await execute(client, `SET LOCAL statement_timeout = '${timeoutMs}ms'`);
    const out = await work(client);
    const commit = await execute(client, "COMMIT");
    if (commit.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the transaction was aborted by an earlier refusal and did not commit");
    return out;
  } catch (e) {
    // ROLLBACK after a failed COMMIT or BEGIN is a no-op on the server; a failure here means the connection is gone: destroy it
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw asFailure(e);
  } finally {
    client.release(destroy);
  }
}
