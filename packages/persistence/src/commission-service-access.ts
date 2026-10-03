/**
 * The work lists of B10's commission service (mandate B10-COMMISSION-SERVICE; docs/design/B10-commercial-domain.md §14; decisions
 * D10-CONS-1, D10-SVC-1, D10-SVC-2): the reads its sweeps need to find their work across agencies before each item is settled in a SERVICE
 * unit of work that adopts the item's agency (D10-CTX-1), and a savepoint for the one write the sweep tries knowing the database may
 * refuse it (B09's release guard on a quote with a payment in flight). Reached through commissionWorkOf(uow) — B09's
 * purchasedSubjectsOf pattern, as ledgerOf and salesOf are — on the unit of work's own connection and transaction.
 *
 * Every read runs under the policies of the session: the corporate ledger rows (lines, holds, completions, funds observations,
 * entitlements, claims) are kauro_commission's whole (0029, 0030); the founding reservations only once their end has passed (0033). Every
 * instant compared is kauro.server_now(), so a test stands the sweep at another instant only through the labelled TEST CLOCK.
 */
import { DomainFailure, type AgencyId, type CaptureId, type CommissionHoldId, type CommissionLineId, type FoundingReservationId, type QualifyingPurchaseId, type QuoteId, type UnitOfWork } from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { canonical, instantOf } from "./repositories/commercial-ledger-rows.js";
import { execute, int, type Queryable } from "./sql.js";
import { PgCommerceUnitOfWork } from "./unit-of-work.js";

/** A live founding reservation whose end has passed: the QUOTE_EXPIRY sweep's work item. */
export interface DueReservation {
  readonly reservationId: FoundingReservationId;
  readonly agencyId: AgencyId;
  readonly quoteId: QuoteId;
}

/** A qualifying purchase named by the ledger (its lines), with the capture the funds and completions of it are keyed by. */
export interface LedgerPurchase {
  readonly agencyId: AgencyId;
  readonly purchaseId: QualifyingPurchaseId;
  readonly captureId: CaptureId;
}

/** An OPEN funds hold whose capture's latest funds observation is AVAILABLE: the ELIGIBILITY sweep releases it. */
export interface ReleasableFundsHold {
  readonly holdId: CommissionHoldId;
  readonly lineId: CommissionLineId;
  readonly agencyId: AgencyId;
  readonly version: number;
}

/** A line due for eligibility (FINAL + 720 h passed) whose capture's latest funds observation is HELD and that no hold covers yet. */
export interface LineOnHeldFunds {
  readonly lineId: CommissionLineId;
  readonly agencyId: AgencyId;
  readonly version: number;
  /** The provider review date the funds observation recorded. */
  readonly reviewAt: UtcInstant | null;
}

/** The latest funds observation of a capture, as the consumer reads it back. */
const LATEST_FUNDS = (alias: string): string =>
  `(SELECT o.funds_state FROM kauro.capture_funds_observations o WHERE o.agency_id = ${alias}.agency_id AND o.capture_id = ${alias}.capture_id ORDER BY o.capture_version DESC LIMIT 1)`;

export class PgCommissionWork {
  constructor(private readonly db: Queryable) {}

  /** The live founding reservations whose end has passed on the server's clock, oldest end first (0033). */
  async dueReservations(limit: number): Promise<ReadonlyArray<DueReservation>> {
    const r = await execute<{ reservation_id: string; agency_id: string; quote_id: string }>(
      this.db,
      `SELECT reservation_id, agency_id, quote_id FROM kauro.founding_slot_reservations
        WHERE state IN ('RESERVED', 'RECONCILIATION_HOLD') AND ends_at <= kauro.server_now()
        ORDER BY ends_at, reservation_id LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ reservationId: x.reservation_id as FoundingReservationId, agencyId: x.agency_id as AgencyId, quoteId: x.quote_id as QuoteId }));
  }

  /**
   * The agencies whose accrual the ACCRUAL_RECONCILIATION sweep reconciles: an agency with an ACCEPTED claim (a conversion may be due once
   * it has a first purchase) or a live entitlement (a purchase may lack its lines), in agency id order after `after`.
   */
  async agenciesToReconcile(limit: number, after: AgencyId | null): Promise<ReadonlyArray<AgencyId>> {
    const r = await execute<{ agency_id: string }>(
      this.db,
      `SELECT agency_id FROM (
         SELECT c.agency_id FROM kauro.attribution_claims c WHERE c.state = 'ACCEPTED' AND c.agency_id IS NOT NULL
         UNION
         SELECT e.agency_id FROM kauro.commission_entitlements e WHERE e.state <> 'EXPIRED') x
        WHERE $2::uuid IS NULL OR agency_id > $2::uuid
        ORDER BY agency_id LIMIT $1`,
      [limit, after],
    );
    return r.rows.map((x) => x.agency_id as AgencyId);
  }

  /** The purchases with an ACCRUED_PENDING or HELD line and no FINAL completion yet: the completions the ELIGIBILITY sweep asks for. */
  async purchasesAwaitingFinal(limit: number): Promise<ReadonlyArray<LedgerPurchase>> {
    const r = await execute<{ agency_id: string; authorization_id: string; capture_id: string }>(
      this.db,
      `SELECT DISTINCT l.agency_id, l.authorization_id, l.capture_id FROM kauro.commission_lines l
        WHERE l.state IN ('ACCRUED_PENDING', 'HELD')
          AND NOT EXISTS (SELECT 1 FROM kauro.purchase_completions c WHERE c.agency_id = l.agency_id AND c.authorization_id = l.authorization_id AND c.kind = 'FINAL')
        ORDER BY l.agency_id, l.authorization_id LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ agencyId: x.agency_id as AgencyId, purchaseId: x.authorization_id as QualifyingPurchaseId, captureId: x.capture_id as CaptureId }));
  }

  /** OPEN FUNDS_HELD holds whose capture's latest funds observation is AVAILABLE (example 14: the funds were released by the provider). */
  async releasableFundsHolds(limit: number): Promise<ReadonlyArray<ReleasableFundsHold>> {
    const r = await execute<{ hold_id: string; line_id: string; agency_id: string; version: string }>(
      this.db,
      `SELECT h.hold_id, h.line_id, l.agency_id, h.version FROM kauro.commission_holds h JOIN kauro.commission_lines l ON l.line_id = h.line_id
        WHERE h.state = 'OPEN' AND h.reason = 'FUNDS_HELD' AND ${LATEST_FUNDS("l")} = 'AVAILABLE'
        ORDER BY h.opened_at, h.hold_id LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ holdId: x.hold_id as CommissionHoldId, lineId: x.line_id as CommissionLineId, agencyId: x.agency_id as AgencyId, version: int(x.version) }));
  }

  /** ACCRUED_PENDING lines due for eligibility whose capture's funds the provider holds, with no OPEN hold covering them yet. */
  async dueLinesOnHeldFunds(limit: number): Promise<ReadonlyArray<LineOnHeldFunds>> {
    const r = await execute<{ line_id: string; agency_id: string; version: string; review_at: string | null }>(
      this.db,
      `SELECT l.line_id, l.agency_id, l.version,
              (SELECT ${canonical("o.review_at", "review_at")} FROM kauro.capture_funds_observations o WHERE o.agency_id = l.agency_id AND o.capture_id = l.capture_id ORDER BY o.capture_version DESC LIMIT 1) AS review_at
         FROM kauro.commission_lines l
        WHERE l.state = 'ACCRUED_PENDING'
          AND EXISTS (SELECT 1 FROM kauro.purchase_completions c WHERE c.agency_id = l.agency_id AND c.authorization_id = l.authorization_id AND c.kind = 'FINAL'
                       AND c.completed_at + interval '720 hours' <= kauro.server_now())
          AND ${LATEST_FUNDS("l")} = 'HELD'
          AND NOT EXISTS (SELECT 1 FROM kauro.commission_holds x WHERE x.line_id = l.line_id AND x.state = 'OPEN' AND x.amount_cents >= l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0))
        ORDER BY l.created_at, l.line_id LIMIT $1`,
      [limit],
    );
    return r.rows.map((x) => ({ lineId: x.line_id as CommissionLineId, agencyId: x.agency_id as AgencyId, version: int(x.version), reviewAt: x.review_at === null ? null : instantOf(x.review_at) }));
  }

  /**
   * Runs one write the database may refuse under a savepoint, so a refusal leaves the unit of work usable: the value, or the refusal.
   * Only for a refusal the caller answers (a guard it cannot read beforehand); anything else it rethrows.
   */
  async attempt<T>(work: () => Promise<T>): Promise<{ readonly kind: "DONE"; readonly value: T } | { readonly kind: "REFUSED"; readonly error: unknown }> {
    await execute(this.db, "SAVEPOINT kauro_commission_attempt");
    try {
      const value = await work();
      await execute(this.db, "RELEASE SAVEPOINT kauro_commission_attempt");
      return { kind: "DONE", value };
    } catch (error) {
      await execute(this.db, "ROLLBACK TO SAVEPOINT kauro_commission_attempt");
      return { kind: "REFUSED", error };
    }
  }
}

const bound = new WeakMap<PgCommerceUnitOfWork, PgCommissionWork>();

/** The commission service's work lists on a unit of work of this package (one instance per unit of work). */
export function commissionWorkOf(uow: UnitOfWork): PgCommissionWork {
  if (!(uow instanceof PgCommerceUnitOfWork)) throw new DomainFailure("INTEGRITY_FAILURE", "the commission service's work is read in a commerce unit of work of @kauro/persistence");
  let work = bound.get(uow);
  if (work === undefined) {
    work = new PgCommissionWork((uow as unknown as { readonly client: Queryable }).client);
    bound.set(uow, work);
  }
  return work;
}
