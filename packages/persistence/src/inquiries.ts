/**
 * The inquiry store over `pg` (B11 D-PUB-3..D-PUB-6; tables of migration 0027). One `admit` is one short transaction under the
 * runtime role with no tenant bound:
 *
 *   1. the three admission keys are serialized with transaction-scoped advisory locks, taken one statement each in ascending
 *      order of their lock keys, so two requests that share any key are decided one after the other and two requests that
 *      share several cannot deadlock. The lock namespace is this module's own (the first integer of the two-integer form), apart
 *      from the migration runner's and every transition lock;
 *   2. the replay check: the same content accepted less than 24 hours ago is that inquiry — answered as is, nothing written,
 *      no budget spent — even when a limiter is exhausted;
 *   3. the two limiters count only accepted inquiries (a row exists per acceptance), in trailing windows measured from the
 *      admission instants: 5 per client-address hash per hour, 3 per e-mail hash per day. A limited request reports how many
 *      seconds until the counted row that has to leave does;
 *   4. an accepted inquiry writes its row, its `inquiry.received.v1` event (ids only) and its three keys, all at the request's
 *      instant, and commits.
 *
 * A limited or replayed request writes nothing. READ COMMITTED is enough: every statement after the locks sees what the previous
 * holder of a shared lock committed.
 */
import { INQUIRY_LIMITS, INQUIRY_RECEIVED_EVENT, type InquiryAdmission, type InquiryAdmissionRequest, type InquiryId, type InquiryStore } from "@kauro/domain";
import type { PoolClient } from "pg";
import type { KauroPool } from "./pool.js";
import { inRuntimeTransaction } from "./runtime-transaction.js";
import { execute, instant } from "./sql.js";

/** "INQR": the first integer of this store's advisory locks. */
const INQUIRY_LOCK_NAMESPACE = 0x494e5152;

const iso = (ms: number): string => new Date(ms).toISOString();

/** The second integer of a key's advisory lock: its first 32 bits, as the signed integer PostgreSQL takes. */
function lockKey(keyHash: string): number {
  return Number.parseInt(keyHash.slice(0, 8), 16) | 0;
}

interface AdmissionRow {
  inquiry_id: string;
  admitted_at: Date;
}

/**
 * The seconds until an admission window has room again, or null when it has room now. `limit` is the budget of the window: the
 * newest `limit` rows inside it are read, and when all of them exist the oldest of those is the one that has to leave.
 */
async function secondsUntilRoom(client: PoolClient, kind: "ADDRESS" | "EMAIL", keyHash: string, limit: number, windowMs: number, nowMs: number): Promise<number | null> {
  const r = await execute<AdmissionRow>(
    client,
    `SELECT inquiry_id, admitted_at FROM kauro.inquiry_admissions WHERE kind = $1 AND key_hash = $2 AND admitted_at > $3::timestamptz ORDER BY admitted_at DESC LIMIT $4`,
    [kind, keyHash, iso(nowMs - windowMs), limit],
  );
  if (r.rows.length < limit) return null;
  const leaving = r.rows[r.rows.length - 1] as AdmissionRow;
  return Math.max(1, Math.ceil((leaving.admitted_at.getTime() + windowMs - nowMs) / 1000));
}

export class PgInquiryStore implements InquiryStore {
  /** Production admission statements keep the 10 s default; test races may configure an allowance for a paused holder. */
  constructor(private readonly pool: KauroPool, private readonly statementTimeoutMs = 10_000) {}

  admit(request: InquiryAdmissionRequest): Promise<InquiryAdmission> {
    const nowMs = Date.parse(request.now);
    if (!Number.isFinite(nowMs)) throw new RangeError("the admission instant is not a UTC instant");
    const { keys, content } = request;
    return inRuntimeTransaction(
      this.pool,
      async (client): Promise<InquiryAdmission> => {
        const locks = [...new Set([keys.address, keys.content, keys.email].map(lockKey))].sort((a, b) => a - b);
        for (const key of locks) await execute(client, "SELECT pg_advisory_xact_lock($1::int, $2::int)", [INQUIRY_LOCK_NAMESPACE, key]);

        const replay = await execute<AdmissionRow>(
          client,
          `SELECT inquiry_id, admitted_at FROM kauro.inquiry_admissions WHERE kind = 'CONTENT' AND key_hash = $1 AND admitted_at > $2::timestamptz ORDER BY admitted_at DESC LIMIT 1`,
          [keys.content, iso(nowMs - INQUIRY_LIMITS.replayWindowMs)],
        );
        const first = replay.rows[0];
        if (first !== undefined) return { kind: "REPLAYED", inquiryId: first.inquiry_id as InquiryId, receivedAt: instant(first.admitted_at) };

        const waits = [
          await secondsUntilRoom(client, "ADDRESS", keys.address, INQUIRY_LIMITS.addressPerHour, INQUIRY_LIMITS.addressWindowMs, nowMs),
          await secondsUntilRoom(client, "EMAIL", keys.email, INQUIRY_LIMITS.emailPerDay, INQUIRY_LIMITS.emailWindowMs, nowMs),
        ].filter((w): w is number => w !== null);
        if (waits.length > 0) return { kind: "LIMITED", retryAfterSeconds: Math.max(...waits) };

        await execute(
          client,
          `INSERT INTO kauro.inquiries (inquiry_id, buyer_type, contact_name, contact_email, company_name, destination, record_band, timing, description, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [request.inquiryId, content.buyerType, content.contactName, content.contactEmail, content.companyName, content.destination, content.recordBand, content.timing, content.description, request.now],
        );
        await execute(
          client,
          `INSERT INTO kauro.inquiry_events (event_id, event_type, inquiry_id, payload, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [request.eventId, INQUIRY_RECEIVED_EVENT, request.inquiryId, JSON.stringify({ inquiryId: request.inquiryId }), request.now],
        );
        await execute(
          client,
          `INSERT INTO kauro.inquiry_admissions (inquiry_id, kind, key_hash, admitted_at)
           VALUES ($1, 'ADDRESS', $2, $5), ($1, 'CONTENT', $3, $5), ($1, 'EMAIL', $4, $5)`,
          [request.inquiryId, keys.address, keys.content, keys.email, request.now],
        );
        return { kind: "ACCEPTED", inquiryId: request.inquiryId, receivedAt: request.now };
      },
      { statementTimeoutMs: this.statementTimeoutMs },
    );
  }
}
