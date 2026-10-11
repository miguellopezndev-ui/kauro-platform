// What the 6a failure-cell files share beyond b10-cells-support.ts (kit-owned): the observation of a backend blocked by a holder that the harness
// cannot route (the payment service's own pool).
import type { Client } from "pg";

/**
 * Observes, in pg_stat_activity and pg_blocking_pids, a backend of `applicationPrefix` blocked by `holderPid` (a unit the harness cannot route
 * over its own connection, such as the payment service's SERVICE unit of a re-binding): its application name and the statement it waits in.
 */
export async function blockedBy(oracle: Client, holderPid: number, applicationPrefix: string, limitMs = 10_000): Promise<{ readonly application: string; readonly query: string }> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    await oracle.query("SELECT pg_stat_clear_snapshot()");
    const r = await oracle.query<{ application_name: string; query: string }>(
      "SELECT application_name, query FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid)) AND wait_event_type = 'Lock' AND application_name LIKE $2 || '%'",
      [holderPid, applicationPrefix],
    );
    if (r.rows[0] !== undefined) return { application: r.rows[0].application_name, query: r.rows[0].query };
    if (Date.now() > deadline) throw new Error(`no backend of ${applicationPrefix} was seen waiting on backend ${holderPid}'s lock within ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
