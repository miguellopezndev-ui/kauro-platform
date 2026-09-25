/**
 * Concurrent writers of the rows a B06 command reads but does not own — B07's revision expiry, B08's target-contract
 * supersession, the control plane's capability suspension, an agency transition — each as its own transaction on the fixture
 * pools, held open for as long as a RACE test needs. They place a writer on either side of a command held inside its unit of
 * work (21 "Concurrency and crash matrix"): the writer is either observed waiting on the command's lock in pg_stat_activity, or
 * it holds its own row lock uncommitted while the command is observed waiting on it. The observation is the harness's
 * waitForLockWait, which throws when no such wait appears: an interleaving that did not happen fails the test, it never passes
 * silently. No sleep synchronizes anything.
 */
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { waitForLockWait, type AgencyFixture } from "@kauro/persistence";
import type { Hold, Reply, World } from "./support.js";

export interface HeldTransaction {
  /** The application name of the writer's connection (the key waitForLockWait observes it by). */
  readonly applicationName: string;
  /** The connection itself, for the fixture helpers that write through a PoolClient (rawEvent). */
  readonly client: PoolClient;
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult<R>>;
  commit(): Promise<void>;
  /** Rolls back what is still open and returns the connection; idempotent, for `finally`. */
  close(): Promise<void>;
}

async function open(client: PoolClient, context: { readonly agencyId: string; readonly userId: string } | null): Promise<HeldTransaction> {
  let state: "OPEN" | "COMMITTED" | "CLOSED" = "OPEN";
  try {
    const name = await client.query<{ name: string }>("SELECT current_setting('application_name') AS name");
    const applicationName = name.rows[0]?.name;
    if (applicationName === undefined || applicationName === "") throw new Error("the writer connection has no application name to be observed by");
    await client.query("BEGIN");
    if (context !== null) await client.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [context.agencyId, context.userId]);
    return {
      applicationName,
      client,
      query: (sql, params = []) => client.query(sql, [...params]),
      async commit() {
        if (state !== "OPEN") throw new Error(`the writer transaction is ${state}`);
        await client.query("COMMIT");
        state = "COMMITTED";
      },
      async close() {
        if (state === "CLOSED") return;
        try {
          if (state === "OPEN") await client.query("ROLLBACK");
        } finally {
          state = "CLOSED";
          client.release();
        }
      },
    };
  } catch (e) {
    client.release();
    throw e;
  }
}

/** A writer under the tenant context of the agency's owner, on the request-handler role (as the owning package would write). */
export async function tenantWriter(w: World, agency: AgencyFixture): Promise<HeldTransaction> {
  return open(await w.h.appPool.raw.connect(), { agencyId: agency.agencyId, userId: agency.ownerUserId });
}

/** A writer on the control-plane role (capabilities are platform-wide rows the control plane owns). */
export async function controlWriter(w: World): Promise<HeldTransaction> {
  return open(await w.h.controlPool.raw.connect(), null);
}

/** Waits until the writer's connection is blocked on a lock while running a statement containing `fragment`; throws otherwise. */
export function waitForWriterLockWait(w: World, writer: HeldTransaction, fragment: string): Promise<number> {
  return waitForLockWait(w.h.oracle, writer.applicationName, fragment);
}

/**
 * Resolves when the held request reached its hold point; rejects if the request finished first (it then never reached the
 * hold, and waiting on the hold would hang instead of failing).
 */
export async function reachedHold(hold: Hold, request: Promise<Reply>): Promise<void> {
  // the request's own outcome (a reply or a rejection) stays with whoever awaits `request`; here it only means "finished"
  const first = await Promise.race([hold.reached.then(() => "REACHED" as const), request.then(() => "FINISHED" as const, () => "FINISHED" as const)]);
  if (first === "FINISHED") throw new Error("the request finished before reaching its hold point");
}
