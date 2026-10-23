/**
 * The person-wide session revocation over PostgreSQL (O23A; migration 0150): one transaction on a verified kauro_assurance connection
 * that binds the person (kauro.user_id) and declares the revocation (kauro.person_revocation = 'on'), both transaction-local. The
 * person's live sessions are locked FOR UPDATE first, the instant is read after the lock is granted (FAILURE-MATRIX-TEMPLATE rule 16:
 * a resume or step-up that held a row finishes before the revocation is stamped), and every session live at that instant ends with the
 * reason. Another person's sessions are invisible to the transaction (row policies), not merely filtered.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { UserId } from "@kauro/domain";
import { DomainFailure } from "@kauro/domain";
import type { PersonRevocationReason, PersonSessionRevoker } from "@kauro/identity";
import type { KauroPool } from "@kauro/persistence";

const STATEMENT_TIMEOUT_MS = 5_000;

export class PgPersonSessionRevoker implements PersonSessionRevoker {
  constructor(private readonly pool: KauroPool) {}

  async revokeAllOf(userId: UserId, now: () => UtcInstant, reason: PersonRevocationReason, exceptSha256: string | null = null): Promise<number> {
    if (exceptSha256 !== null && reason !== "SIGN_OUT_EVERYWHERE") throw new RangeError("only SIGN_OUT_EVERYWHERE keeps the acting session");
    const { client, connection } = await this.pool.acquire();
    if (connection.role !== "kauro_assurance") {
      client.release();
      throw new DomainFailure("INTEGRITY_FAILURE", `web sessions are kept only by kauro_assurance; this pool is ${connection.role} (08 Database isolation)`);
    }
    let failed: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query("SELECT set_config('kauro.user_id', $1, true), set_config('kauro.session_sha256', '', true), set_config('kauro.person_revocation', 'on', true)", [userId]);
      await client.query("SELECT session_id FROM kauro.web_sessions WHERE user_id = $1 AND revoked_at IS NULL ORDER BY session_id FOR UPDATE", [userId]);
      // the instant, read after every lock was granted
      const at = now();
      const ended = await client.query(
        `UPDATE kauro.web_sessions SET revoked_at = $2::timestamptz, revoke_reason = $3
          WHERE user_id = $1 AND revoked_at IS NULL AND idle_expires_at > $2::timestamptz AND absolute_expires_at > $2::timestamptz
            AND secret_sha256 IS DISTINCT FROM $4`,
        [userId, at, reason, exceptSha256],
      );
      const committed = await client.query("COMMIT");
      if (committed.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the person-wide revocation was aborted and did not commit");
      return ended.rowCount ?? 0;
    } catch (e) {
      failed = e instanceof Error ? e : new Error(String(e));
      try {
        await client.query("ROLLBACK");
        failed = undefined;
      } catch {
        // the connection is destroyed below
      }
      throw e;
    } finally {
      client.release(failed);
    }
  }
}
