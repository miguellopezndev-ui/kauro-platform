/**
 * The web sessions of the browser boundary (B11 design D-AUTH-1; migration 0009): the store of the authentication boundary's
 * runtime group (kauro_assurance), the only group with any privilege on kauro.web_sessions. Each operation is one short
 * transaction of its own on a verified connection of that group, binding transaction-locally exactly what the policies check:
 * the identity a new session belongs to (kauro.user_id) and the secret hash the caller presents (kauro.session_sha256), so a
 * transaction sees, moves or ends that one session and nothing else. The secret itself never reaches the database.
 *
 * A step-up is recorded in the same group and the same transaction: the B06 STEP_UP proof of the identity the transaction binds
 * (assurance_proofs, D-EVID-1) and, for a cookie session, that session's latest step-up (a foreign key binds it to a proof of the
 * session's own person).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { DomainFailure, type AssuranceProof, type CorrelationId, type UserId } from "@kauro/domain";
import type { PoolClient } from "pg";
import type { KauroPool } from "./pool.js";
import { execute, instant, text } from "./sql.js";

/** A web session as the store reads it (the application's WebSessionRecord). */
export interface StoredWebSession {
  readonly sessionId: string;
  readonly userId: UserId;
  readonly provider: string;
  readonly subjectHash: Sha256Hex;
  readonly emailVerifiedAt: UtcInstant | null;
  readonly mfaAt: UtcInstant | null;
  readonly createdAt: UtcInstant;
  readonly lastSeenAt: UtcInstant;
  readonly idleExpiresAt: UtcInstant;
  readonly absoluteExpiresAt: UtcInstant;
  readonly stepUpProofId: string | null;
  readonly stepUpFreshUntil: UtcInstant | null;
  readonly revokedAt: UtcInstant | null;
  readonly revokeReason: string | null;
}

export type NewStoredWebSession = Omit<StoredWebSession, "stepUpProofId" | "stepUpFreshUntil" | "revokedAt" | "revokeReason">;

interface SessionRow {
  session_id: string;
  user_id: string;
  provider: string;
  subject_hash: string;
  email_verified_at: Date | null;
  mfa_at: Date | null;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  step_up_proof_id: string | null;
  step_up_fresh_until: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

const COLUMNS =
  "session_id, user_id, provider, subject_hash, email_verified_at, mfa_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at, step_up_proof_id, step_up_fresh_until, revoked_at, revoke_reason";

function nullableInstant(v: Date | null): UtcInstant | null {
  return v === null ? null : instant(v);
}

function sessionOf(r: SessionRow): StoredWebSession {
  return {
    sessionId: text(r.session_id),
    userId: r.user_id as UserId,
    provider: text(r.provider),
    subjectHash: r.subject_hash as Sha256Hex,
    emailVerifiedAt: nullableInstant(r.email_verified_at),
    mfaAt: nullableInstant(r.mfa_at),
    createdAt: instant(r.created_at),
    lastSeenAt: instant(r.last_seen_at),
    idleExpiresAt: instant(r.idle_expires_at),
    absoluteExpiresAt: instant(r.absolute_expires_at),
    stepUpProofId: r.step_up_proof_id,
    stepUpFreshUntil: nullableInstant(r.step_up_fresh_until),
    revokedAt: nullableInstant(r.revoked_at),
    revokeReason: r.revoke_reason,
  };
}

/** Statement bound of one boundary transaction: it waits on nobody for long (a session row lock at most). */
export const WEB_SESSION_STATEMENT_TIMEOUT_MS = 5_000;

export class PgWebSessionStore {
  constructor(private readonly pool: KauroPool) {}

  /** One transaction on a verified kauro_assurance connection with only the given settings bound; COMMIT is checked. */
  async #boundary<T>(bind: { readonly userId: UserId | null; readonly sessionSha256: Sha256Hex | null }, work: (client: PoolClient) => Promise<T>): Promise<T> {
    let acquired: Awaited<ReturnType<KauroPool["acquire"]>>;
    try {
      acquired = await this.pool.acquire();
    } catch (e) {
      if (e instanceof Error && e.name === "PrivilegedRoleError") throw e;
      const failure = new DomainFailure("CAPACITY_UNAVAILABLE", "no connection of the authentication boundary is available", { retryAfterSeconds: 1 }, true);
      failure.cause = e;
      throw failure;
    }
    const { client, connection } = acquired;
    if (connection.role !== "kauro_assurance") {
      client.release();
      throw new DomainFailure("INTEGRITY_FAILURE", `web sessions are kept only by kauro_assurance; this pool is ${connection.role} (08 Database isolation)`);
    }
    let destroy: Error | undefined;
    try {
      await execute(client, "BEGIN");
      await execute(client, `SET LOCAL statement_timeout = '${WEB_SESSION_STATEMENT_TIMEOUT_MS}ms'`);
      await execute(client, "SELECT set_config('kauro.user_id', $1, true), set_config('kauro.session_sha256', $2, true)", [bind.userId ?? "", bind.sessionSha256 ?? ""]);
      const out = await work(client);
      const commit = await execute(client, "COMMIT");
      if (commit.command !== "COMMIT") throw new DomainFailure("INTEGRITY_FAILURE", "the session transaction was aborted by an earlier refusal and did not commit");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw e;
    } finally {
      client.release(destroy);
    }
  }

  async open(session: NewStoredWebSession, secretSha256: Sha256Hex, _correlationId: CorrelationId): Promise<void> {
    await this.#boundary({ userId: session.userId, sessionSha256: secretSha256 }, async (client) => {
      await execute(
        client,
        `INSERT INTO kauro.web_sessions (session_id, secret_sha256, user_id, provider, subject_hash, email_verified_at, mfa_at, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [session.sessionId, secretSha256, session.userId, session.provider, session.subjectHash, session.emailVerifiedAt, session.mfaAt, session.createdAt, session.lastSeenAt, session.idleExpiresAt, session.absoluteExpiresAt],
      );
    });
  }

  async resume(secretSha256: Sha256Hex, now: UtcInstant, idleSeconds: number, touchSeconds: number): Promise<StoredWebSession | null> {
    if (!Number.isInteger(idleSeconds) || idleSeconds <= 0 || !Number.isInteger(touchSeconds) || touchSeconds < 0) throw new RangeError("idle and touch windows are whole seconds");
    return this.#boundary({ userId: null, sessionSha256: secretSha256 }, async (client) => {
      // a live session whose last-seen is at least `touchSeconds` old moves it (at most once a minute: 07 connection budget);
      // a concurrent revocation holds the row lock first and the re-evaluated condition then leaves it untouched
      const touched = await execute<SessionRow>(
        client,
        `UPDATE kauro.web_sessions
            SET last_seen_at = $2::timestamptz,
                idle_expires_at = LEAST($2::timestamptz + make_interval(secs => $3::integer), absolute_expires_at)
          WHERE secret_sha256 = $1 AND revoked_at IS NULL
            AND idle_expires_at > $2::timestamptz AND absolute_expires_at > $2::timestamptz
            AND last_seen_at <= $2::timestamptz - make_interval(secs => $4::integer)
        RETURNING ${COLUMNS}`,
        [secretSha256, now, idleSeconds, touchSeconds],
      );
      const row = touched.rows[0] ?? (await execute<SessionRow>(client, `SELECT ${COLUMNS} FROM kauro.web_sessions WHERE secret_sha256 = $1`, [secretSha256])).rows[0];
      return row === undefined ? null : sessionOf(row);
    });
  }

  async revoke(secretSha256: Sha256Hex, at: UtcInstant, reason: string): Promise<{ readonly outcome: "REVOKED"; readonly userId: UserId } | { readonly outcome: "ENDED" | "UNKNOWN" }> {
    return this.#boundary({ userId: null, sessionSha256: secretSha256 }, async (client) => {
      const ended = await execute<{ user_id: string }>(
        client,
        `UPDATE kauro.web_sessions SET revoked_at = $2::timestamptz, revoke_reason = $3
          WHERE secret_sha256 = $1 AND revoked_at IS NULL AND idle_expires_at > $2::timestamptz AND absolute_expires_at > $2::timestamptz
        RETURNING user_id`,
        [secretSha256, at, reason],
      );
      const row = ended.rows[0];
      if (row !== undefined) return { outcome: "REVOKED" as const, userId: row.user_id as UserId };
      const known = await execute(client, "SELECT 1 FROM kauro.web_sessions WHERE secret_sha256 = $1", [secretSha256]);
      return { outcome: known.rowCount === 0 ? ("UNKNOWN" as const) : ("ENDED" as const) };
    });
  }

  async recordStepUp(proof: AssuranceProof, correlationId: CorrelationId, recordedAt: UtcInstant, sessionSha256: Sha256Hex | null): Promise<void> {
    await this.#boundary({ userId: proof.userId, sessionSha256 }, async (client) => {
      await execute(
        client,
        `INSERT INTO kauro.assurance_proofs (proof_id, user_id, kind, method, issued_at, expires_at, correlation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [proof.proofId, proof.userId, proof.kind, proof.method, proof.issuedAt, proof.expiresAt, correlationId, recordedAt],
      );
      if (sessionSha256 === null) return;
      const bound = await execute(
        client,
        `UPDATE kauro.web_sessions SET step_up_proof_id = $2, step_up_fresh_until = $3
          WHERE secret_sha256 = $1 AND user_id = $4 AND revoked_at IS NULL`,
        [sessionSha256, proof.proofId, proof.expiresAt, proof.userId],
      );
      if (bound.rowCount !== 1) throw new DomainFailure("INTEGRITY_FAILURE", "the step-up names a session that is not the live session of its person");
    });
  }
}
