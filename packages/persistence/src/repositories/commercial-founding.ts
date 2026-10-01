/**
 * The founding cohort over `pg` (package B10; migration 0028; design §3.3, D10-FOUND-1..4): the slots of a price policy's cohort, the
 * reservations that hold them and the reader behind the public pricing page.
 *
 * The Nth-slot race is decided on the slot row: takeSlot walks the slots in ascending order and runs
 * `UPDATE founding_slots … WHERE slot_no = $n AND NOT held` on each, so a contender for a row another transaction already took waits for
 * that transaction (the wait is visible in pg_stat_activity), re-checks `NOT held` on the committed row and moves on to the next slot
 * or to none. A release frees its slot in the same transaction and a consumed slot is never freed (the database refuses both, KC014).
 * Every instant is kauro.server_now() (D10-CLOCK-1).
 */
import type { UtcInstant } from "@kauro/contracts";
import {
  type AgencyId,
  type CommercialAuthorizationId,
  type FoundingOfferView,
  type FoundingRepository,
  type FoundingReservationId,
  type FoundingReservationRecord,
  type FoundingReservationState,
  type FoundingSlotRecord,
  type NewFoundingReservation,
  type QuoteId,
  type ReservationReleaseReason,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, instant, int, optionalInstant, optionalText, type Queryable } from "../sql.js";
import { defined, staleOf } from "./commerce-shared.js";

interface ReservationRow {
  reservation_id: string;
  agency_id: string;
  quote_id: string;
  policy_version: string;
  slot_no: number;
  version: string;
  state: FoundingReservationState;
  ends_at: Date;
  held_at: Date | null;
  consumed_at: Date | null;
  consumed_by_authorization_id: string | null;
  released_at: Date | null;
  release_reason: ReservationReleaseReason | null;
  created_at: Date;
  updated_at: Date;
}

const RESERVATION_COLUMNS =
  "reservation_id, agency_id, quote_id, policy_version, slot_no, version, state, ends_at, held_at, consumed_at, consumed_by_authorization_id, released_at, release_reason, created_at, updated_at";
const R_COLUMNS = RESERVATION_COLUMNS.split(", ").map((c) => `r.${c}`).join(", ");

export function reservationRecord(r: ReservationRow): FoundingReservationRecord {
  return defined<FoundingReservationRecord>(
    {
      reservationId: r.reservation_id as FoundingReservationId,
      policyVersion: r.policy_version,
      agencyId: r.agency_id as AgencyId,
      quoteId: r.quote_id as QuoteId,
      slotNo: int(r.slot_no),
      state: r.state,
      version: int(r.version),
      endsAt: instant(r.ends_at),
      createdAt: instant(r.created_at),
      updatedAt: instant(r.updated_at),
    },
    {
      heldAt: optionalInstant(r.held_at),
      consumedAt: optionalInstant(r.consumed_at),
      consumedByAuthorizationId: optionalText(r.consumed_by_authorization_id) as CommercialAuthorizationId | undefined,
      releasedAt: optionalInstant(r.released_at),
      releaseReason: r.release_reason ?? undefined,
    },
  );
}

export class PgFoundingRepository implements FoundingRepository {
  constructor(private readonly db: Queryable) {}

  async offer(policyVersion: string): Promise<FoundingOfferView> {
    const counts = await execute<{ slots: number; reservable: number }>(
      this.db,
      "SELECT count(*)::int AS slots, (count(*) FILTER (WHERE NOT held))::int AS reservable FROM kauro.founding_slots WHERE policy_version = $1",
      [policyVersion],
    );
    const policy = await execute<{ founding_discount_bps: number }>(this.db, "SELECT founding_discount_bps FROM kauro.price_policies WHERE policy_version = $1", [policyVersion]);
    return {
      policyVersion,
      slots: int(counts.rows[0]?.slots ?? 0),
      reservableSlots: int(counts.rows[0]?.reservable ?? 0),
      discountBps: policy.rows[0] === undefined ? 0 : int(policy.rows[0].founding_discount_bps),
    };
  }

  async slots(policyVersion: string): Promise<ReadonlyArray<FoundingSlotRecord>> {
    const r = await execute<{ policy_version: string; slot_no: number; held: boolean; live_reservation_id: string | null }>(
      this.db,
      "SELECT policy_version, slot_no, held, live_reservation_id FROM kauro.founding_slots WHERE policy_version = $1 ORDER BY slot_no",
      [policyVersion],
    );
    return r.rows.map((s) =>
      defined<FoundingSlotRecord>({ policyVersion: s.policy_version, slotNo: int(s.slot_no), held: s.held }, { liveReservationId: s.live_reservation_id ?? undefined }),
    );
  }

  async getReservation(reservationId: FoundingReservationId): Promise<FoundingReservationRecord | null> {
    const r = await execute<ReservationRow>(this.db, `SELECT ${RESERVATION_COLUMNS} FROM kauro.founding_slot_reservations WHERE reservation_id = $1`, [reservationId]);
    return r.rows[0] ? reservationRecord(r.rows[0]) : null;
  }

  async lockReservation(reservationId: FoundingReservationId): Promise<FoundingReservationRecord | null> {
    const r = await execute<ReservationRow>(this.db, `SELECT ${RESERVATION_COLUMNS} FROM kauro.founding_slot_reservations WHERE reservation_id = $1 FOR UPDATE`, [reservationId]);
    return r.rows[0] ? reservationRecord(r.rows[0]) : null;
  }

  async reservationOfQuote(quoteId: QuoteId): Promise<FoundingReservationRecord | null> {
    const r = await execute<ReservationRow>(this.db, `SELECT ${RESERVATION_COLUMNS} FROM kauro.founding_slot_reservations WHERE quote_id = $1`, [quoteId]);
    return r.rows[0] ? reservationRecord(r.rows[0]) : null;
  }

  async reservationOfAgency(policyVersion: string, agencyId: AgencyId): Promise<FoundingReservationRecord | null> {
    const r = await execute<ReservationRow>(this.db, `SELECT ${RESERVATION_COLUMNS} FROM kauro.founding_slot_reservations WHERE policy_version = $1 AND agency_id = $2`, [policyVersion, agencyId]);
    return r.rows[0] ? reservationRecord(r.rows[0]) : null;
  }

  async takeSlot(policyVersion: string, reservationId: FoundingReservationId, agencyId: AgencyId): Promise<number | null> {
    const slots = await execute<{ slot_no: number }>(this.db, "SELECT slot_no FROM kauro.founding_slots WHERE policy_version = $1 ORDER BY slot_no", [policyVersion]);
    for (const slot of slots.rows) {
      // a row another transaction holds locked is waited for; the committed row is then re-checked against NOT held
      const taken = await execute<{ slot_no: number }>(
        this.db,
        `UPDATE kauro.founding_slots SET held = true, live_reservation_id = $3, live_agency_id = $4, updated_at = kauro.server_now()
          WHERE policy_version = $1 AND slot_no = $2 AND NOT held
          RETURNING slot_no`,
        [policyVersion, slot.slot_no, reservationId, agencyId],
      );
      if (taken.rows[0] !== undefined) return int(taken.rows[0].slot_no);
    }
    return null;
  }

  async recordReservation(reservation: NewFoundingReservation): Promise<FoundingReservationRecord> {
    const r = await execute<ReservationRow>(
      this.db,
      `INSERT INTO kauro.founding_slot_reservations (reservation_id, agency_id, quote_id, policy_version, slot_no, ends_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING ${RESERVATION_COLUMNS}`,
      [reservation.reservationId, reservation.agencyId, reservation.quoteId, reservation.policyVersion, reservation.slotNo, reservation.endsAt, reservation.createdAt],
    );
    return reservationRecord(r.rows[0]!);
  }

  async release(reservationId: FoundingReservationId, expectedVersion: number, _now: UtcInstant): Promise<VersionedWrite<FoundingReservationRecord>> {
    // the reason names how the quote ended; the database refuses a release whose quote has not ended (KC014)
    const r = await execute<ReservationRow>(
      this.db,
      `UPDATE kauro.founding_slot_reservations AS r
          SET state = 'RELEASED', version = r.version + 1, released_at = kauro.server_now(),
              release_reason = 'QUOTE_' || (SELECT q.state FROM kauro.quotes q WHERE q.agency_id = r.agency_id AND q.quote_id = r.quote_id)
        WHERE r.reservation_id = $1 AND r.version = $2
        RETURNING ${R_COLUMNS}`,
      [reservationId, expectedVersion],
    );
    const row = r.rows[0];
    if (row === undefined) return staleOf(this.db, "founding_slot_reservations", "reservation_id", "state", reservationId, "founding reservation");
    // the slot is freed in the same transaction (the database checks it at COMMIT)
    await execute(
      this.db,
      `UPDATE kauro.founding_slots SET held = false, live_reservation_id = NULL, live_agency_id = NULL, updated_at = kauro.server_now()
        WHERE policy_version = $1 AND slot_no = $2 AND live_reservation_id = $3`,
      [row.policy_version, row.slot_no, row.reservation_id],
    );
    return { kind: "APPLIED", record: reservationRecord(row) };
  }

  async holdForReconciliation(reservationId: FoundingReservationId, expectedVersion: number, _now: UtcInstant): Promise<VersionedWrite<FoundingReservationRecord>> {
    const r = await execute<ReservationRow>(
      this.db,
      `UPDATE kauro.founding_slot_reservations AS r
          SET state = 'RECONCILIATION_HOLD', version = r.version + 1, held_at = kauro.server_now()
        WHERE r.reservation_id = $1 AND r.version = $2
        RETURNING ${R_COLUMNS}`,
      [reservationId, expectedVersion],
    );
    const row = r.rows[0];
    if (row === undefined) return staleOf(this.db, "founding_slot_reservations", "reservation_id", "state", reservationId, "founding reservation");
    return { kind: "APPLIED", record: reservationRecord(row) };
  }

  async endedReservations(now: UtcInstant, limit: number): Promise<ReadonlyArray<FoundingReservationRecord>> {
    const r = await execute<ReservationRow>(
      this.db,
      `SELECT ${RESERVATION_COLUMNS} FROM kauro.founding_slot_reservations
        WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD') AND ends_at <= $1
        ORDER BY ends_at, reservation_id LIMIT $2`,
      [now, limit],
    );
    return r.rows.map(reservationRecord);
  }
}
