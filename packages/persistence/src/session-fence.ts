/**
 * The session fence (migration 0047; PV1R-07 r4, docs/review/pv1-route-pv1r07-design.md §3.2). The request handlers' unit of work locks the
 * one web session its own transaction presents FOR SHARE and reads its liveness in that same locking statement: the lock, the judgment read,
 * the effect and the COMMIT are one transaction on one backend, so losing the backend loses all of them together, and every writer of the row
 * (the authentication boundary's revoke, resume touch, step-up: FOR UPDATE first) waits until this transaction ends.
 *
 * The statement reads no clock (FAILURE-MATRIX-TEMPLATE rule 16): the caller reads its clock after it returned and judges the row it returned.
 * The binding of the presented hash is transaction-local (set_config(..., true)): it ends with the unit's COMMIT or ROLLBACK.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type { UserId } from "@kauro/domain";
import { execute, instant, type Queryable } from "./sql.js";

/** The judged columns of the session row as the locking statement returned them. */
export interface LockedSession {
  readonly revokedAt: UtcInstant | null;
  readonly idleExpiresAt: UtcInstant;
  readonly absoluteExpiresAt: UtcInstant;
}

interface FenceRow {
  revoked_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
}

export class PgSessionFence {
  constructor(private readonly client: Queryable) {}

  /** Locks FOR SHARE and returns the session `secretSha256` names for `userId` as it stands (latest committed version after any wait), or null. */
  async lockPresented(secretSha256: Sha256Hex, userId: UserId): Promise<LockedSession | null> {
    await execute(this.client, "SELECT set_config('kauro.session_sha256', $1, true)", [secretSha256]);
    const r = await execute<FenceRow>(
      this.client,
      "SELECT revoked_at, idle_expires_at, absolute_expires_at FROM kauro.web_sessions WHERE secret_sha256 = $1 AND user_id = $2 FOR SHARE",
      [secretSha256, userId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      revokedAt: row.revoked_at === null ? null : instant(row.revoked_at),
      idleExpiresAt: instant(row.idle_expires_at),
      absoluteExpiresAt: instant(row.absolute_expires_at),
    };
  }
}
