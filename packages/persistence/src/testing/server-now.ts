import type { UtcInstant } from "@kauro/contracts";
import { toUtcInstant } from "@kauro/domain";
import type { SqlSession } from "./source-lifecycle.js";

/** The fixture session's database clock, formatted with the same millisecond precision as Clock.now(). */
export async function serverNow(client: SqlSession): Promise<UtcInstant> {
  // Pre-migration fixtures may have no server_now function yet. Check before calling it so an open transaction stays usable.
  const functions = await client.query<{ available: boolean }>("SELECT to_regprocedure('kauro.server_now()') IS NOT NULL AS available");
  const result = await client.query<{ now: Date }>(functions.rows[0]?.available
    ? "SELECT kauro.server_now() AS now"
    : "SELECT clock_timestamp() AS now");
  const row = result.rows[0];
  if (row === undefined) throw new Error("fixture server clock returned no row");
  return toUtcInstant(row.now.getTime());
}
