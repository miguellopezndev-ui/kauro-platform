/**
 * The sender identities of package B12's lane L-SEND over `pg` (docs/design/B12-outreach-plan.md §L, companion §R rows B12-9..B12-11;
 * migration 0072 sender_identities): RegisterSenderIdentity, VerifySenderIdentity and RecordSenderRevocation, all by the corporate owner.
 * Traces: Register L1 S (the person's seller row, when it has one) then the INSERT (the unique (address, route) answers the second registration
 * with one 409); Verify and Revoke L7 X (the sender subject) -> judgment of the locked row -> the UPDATE. Verify and revoke on one sender
 * answer ONE terminal state: whoever takes L7 first wins, the other reads it (GAP-VS-1). Revoking is idempotent; a REVOKED sender is never verified.
 * The database repeats every edge (KA095 immutability, the edge machine and LOCK_NOT_HELD of 0072). No event, no outbox record.
 */
import { DomainFailure, NotFoundFailure } from "@kauro/domain";
import { OutreachLocks } from "../outreach-access.js";
import { execute, type Queryable } from "../sql.js";
import { awaitSalesTransition } from "./commercial-sales-rows.js";

export type SenderRouteName = "GMAIL_API" | "RESEND_TRANSACTIONAL";
export interface SenderRecord {
  readonly senderId: string;
  readonly userId: string;
  readonly address: string;
  readonly route: SenderRouteName;
  readonly state: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegisterSenderInput {
  readonly senderId: string;
  readonly userId: string;
  readonly address: string;
  readonly route: SenderRouteName;
  readonly consentEvidenceRef: string | null;
  readonly recordedByUserId: string;
}

interface Row {
  sender_id: string;
  user_id: string;
  address: string;
  route: SenderRouteName;
  state: SenderRecord["state"];
  created_at: string;
  updated_at: string;
}
const COLUMNS = `sender_id, user_id, address, route, state, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;
const recordOf = (r: Row): SenderRecord => ({ senderId: r.sender_id, userId: r.user_id, address: r.address, route: r.route, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at });

export class PgOutreachSenders {
  constructor(private readonly db: Queryable) {}

  async register(i: RegisterSenderInput): Promise<SenderRecord> {
    const address = i.address.trim().toLowerCase();
    if (i.route === "GMAIL_API" && i.consentEvidenceRef === null) {
      throw new DomainFailure("INVALID_REQUEST", "request refused: SCHEMA_VIOLATION", { reason: "SCHEMA_VIOLATION", fields: [{ field: "consentEvidenceRef", code: "REQUIRED" }] });
    }
    if ((await execute(this.db, "SELECT 1 FROM kauro.identities WHERE user_id = $1", [i.userId])).rowCount !== 1) throw new NotFoundFailure("identity");
    // L1: the person's seller row, when the person is a seller; a TERMINATED seller gets no sender (GAP-RS-3)
    const seller = (await execute<{ seller_id: string }>(this.db, "SELECT seller_id FROM kauro.sellers WHERE user_id = $1", [i.userId])).rows[0];
    if (seller !== undefined) {
      await awaitSalesTransition(this.db, "kauro.sellers", seller.seller_id);
      const st = (await execute<{ state: string }>(this.db, "SELECT state FROM kauro.sellers WHERE seller_id = $1", [seller.seller_id])).rows[0];
      if (st?.state === "TERMINATED") throw new DomainFailure("PRECONDITION_FAILED", "the person's seller is terminated", { reason: "SELLER_NOT_ACTIVE" });
    }
    if ((await execute(this.db, "SELECT 1 FROM kauro.sender_identities WHERE address = $1 AND route = $2", [address, i.route])).rowCount !== 0) {
      throw new DomainFailure("IDEMPOTENCY_CONFLICT", "a sender identity of this address and route is already recorded");
    }
    const r = await execute<Row>(
      this.db,
      `INSERT INTO kauro.sender_identities (sender_id, user_id, address, route, consent_evidence_ref, recorded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [i.senderId, i.userId, address, i.route, i.consentEvidenceRef, i.recordedByUserId],
    );
    return recordOf(r.rows[0]!);
  }

  /** L7 X, then the locked row: the judgment and the write of verify / revoke. */
  async #locked(senderId: string): Promise<SenderRecord> {
    if ((await execute(this.db, "SELECT 1 FROM kauro.sender_identities WHERE sender_id = $1", [senderId])).rowCount !== 1) throw new NotFoundFailure("sender_identity");
    await new OutreachLocks(this.db).take("L7", senderId, "X");
    const r = (await execute<Row>(this.db, `SELECT ${COLUMNS} FROM kauro.sender_identities WHERE sender_id = $1`, [senderId])).rows[0];
    if (r === undefined) throw new NotFoundFailure("sender_identity");
    return recordOf(r);
  }

  async #reread(senderId: string): Promise<SenderRecord> {
    return recordOf((await execute<Row>(this.db, `SELECT ${COLUMNS} FROM kauro.sender_identities WHERE sender_id = $1`, [senderId])).rows[0]!);
  }

  async verify(senderId: string, verificationEvidenceHash: string): Promise<SenderRecord> {
    const cur = await this.#locked(senderId);
    if (cur.state === "REVOKED") throw new DomainFailure("PRECONDITION_FAILED", "the sender identity was revoked", { reason: "SENDER_REVOKED" });
    if (cur.state === "VERIFIED") return cur;
    await execute(this.db, "UPDATE kauro.sender_identities SET state = 'VERIFIED', verification_evidence_hash = $2, updated_at = kauro.server_now() WHERE sender_id = $1", [senderId, verificationEvidenceHash]);
    return this.#reread(senderId);
  }

  async revoke(senderId: string): Promise<SenderRecord> {
    const cur = await this.#locked(senderId);
    if (cur.state === "REVOKED") return cur;
    await execute(this.db, "UPDATE kauro.sender_identities SET state = 'REVOKED', updated_at = kauro.server_now() WHERE sender_id = $1", [senderId]);
    return this.#reread(senderId);
  }
}
