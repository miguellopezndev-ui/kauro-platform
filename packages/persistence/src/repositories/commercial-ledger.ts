/**
 * The commission ledger over `pg` (mandate B10-ADAPTERS-LEDGER; migration 0030; docs/design/B10-commercial-domain.md §6, §8.1, §10;
 * decisions D10-POOL-1, D10-RATE-1, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-HOLD-1, D10-NEG-1, D10-NEG-2, D10-CTX-3, D10-CLOCK-1) — the
 * CommissionLedgerRepository port of @kauro/domain: completions, funds observations, pools with their lines, cumulative adjustments,
 * holds, offsets and the line transitions of design 8.1.
 *
 * The ledger is corporate (D10-CTX-3): the commission service writes it in the agency of the work item it adopted, the corporate owner
 * opens and resolves holds, a seller reads its own lines. Every read goes through the policies of the unit of work's session, so a row
 * the caller may not read answers null, never an error that tells it exists. Every instant recorded is `kauro.server_now()`
 * (commercial-ledger-rows), and an eligibility instant is derived from the FINAL completion's own stored instant in SQL — a canonical
 * instant fed back would lose its microseconds.
 *
 * The domain computes (commercial allocatePool, recomputePool); this adapter records, and the database repeats every rule: KC002 (a
 * pool is round(basis x rate) once and its lines sum to it, at COMMIT), KC015 (an adjustment is the exact cumulative difference, and a
 * basis only falls), KC007 (ELIGIBLE only with a FINAL completion 720 hours old, funds AVAILABLE and no covering hold), KC017 (an
 * offset only under signed SIGNED_FUTURE_OFFSET terms), the hold bounds and the listed line edges.
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  type AdjustmentDirection,
  type AdjustmentReason,
  type AgencyId,
  type AssistanceAgreementId,
  type AttributionAllocationId,
  type CaptureFundsObservationRecord,
  type CaptureId,
  type CommissionAdjustmentId,
  type CommissionAdjustmentRecord,
  type CommissionEntitlementId,
  type CommissionHoldId,
  type CommissionHoldRecord,
  type CommissionHoldState,
  type CommissionLedgerRepository,
  type CommissionLineChange,
  type CommissionLineId,
  type CommissionLineRecord,
  type CommissionLineState,
  type CommissionOffsetId,
  type CommissionOffsetRecord,
  type CommissionPoolId,
  type CommissionPoolRecord,
  type CommissionRateKind,
  type CommissionSource,
  type CommissionStatementId,
  type CompletionKind,
  type CompletionSource,
  type EventId,
  type FoundingBasis,
  type FoundingReservationId,
  type FundsObservationId,
  type FundsState,
  type HoldReason,
  type IdGenerator,
  type NewCommissionAdjustment,
  type NewCommissionHold,
  type NewCommissionPool,
  type NewPurchaseCompletion,
  type ObservedFundsState,
  type PaymentOrderId,
  type ProjectId,
  type PurchaseCompletionId,
  type PurchaseCompletionRecord,
  type QualifyingPurchaseId,
  type QualifyingPurchaseRecord,
  type QuoteId,
  type SellerAgreementId,
  type SellerId,
  type VersionedWrite,
} from "@kauro/domain";
import { execute, int, type Queryable } from "../sql.js";
import { canonical, centsOrZero, defined, instantOf, money, optionalInstantOf, optionalString, staleRow } from "./commercial-ledger-rows.js";

// --- completions and funds ----------------------------------------------------------------------------------------------------------

const COMPLETION = `completion_id, authorization_id, agency_id, kind, stage_ref, ${canonical("completed_at")}, evidence_hash, source, ${canonical("recorded_at")}`;
interface CompletionRow {
  completion_id: string;
  authorization_id: string;
  agency_id: string;
  kind: CompletionKind;
  stage_ref: string | null;
  completed_at: string;
  evidence_hash: string;
  source: CompletionSource;
  recorded_at: string;
}
function completionRecord(r: CompletionRow): PurchaseCompletionRecord {
  return defined<PurchaseCompletionRecord>(
    {
      completionId: r.completion_id as PurchaseCompletionId,
      purchaseId: r.authorization_id as QualifyingPurchaseId,
      agencyId: r.agency_id as AgencyId,
      kind: r.kind,
      completedAt: instantOf(r.completed_at),
      evidenceHash: r.evidence_hash as Sha256Hex,
      source: r.source,
      recordedAt: instantOf(r.recorded_at),
    },
    { stageRef: optionalString(r.stage_ref) },
  );
}

const OBSERVATION = `observation_id, agency_id, capture_id, capture_version, funds_state, ${canonical("review_at")}, source_event_id, ${canonical("observed_at")}`;
interface ObservationRow {
  observation_id: string;
  agency_id: string;
  capture_id: string;
  capture_version: string;
  funds_state: ObservedFundsState;
  review_at: string | null;
  source_event_id: string;
  observed_at: string;
}
function observationRecord(r: ObservationRow): CaptureFundsObservationRecord {
  return defined<CaptureFundsObservationRecord>(
    {
      observationId: r.observation_id as FundsObservationId,
      agencyId: r.agency_id as AgencyId,
      captureId: r.capture_id as CaptureId,
      captureVersion: int(r.capture_version),
      fundsState: r.funds_state,
      sourceEventId: r.source_event_id as EventId,
      observedAt: instantOf(r.observed_at),
    },
    { reviewAt: optionalInstantOf(r.review_at) },
  );
}

// --- pools, lines, adjustments, holds, offsets --------------------------------------------------------------------------------------

const POOL = `pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, allocation_id, assistance_agreement_id, rate_kind, rate_bps, initial_basis_cents, basis_cents,
  pool_cents, policy_version, version, ${canonical("created_at")}`;
interface PoolRow {
  pool_id: string;
  agency_id: string;
  authorization_id: string;
  capture_id: string;
  confirmation_seq: number;
  project_id: string;
  source: CommissionSource;
  allocation_id: string | null;
  assistance_agreement_id: string | null;
  rate_kind: CommissionRateKind;
  rate_bps: number;
  initial_basis_cents: string;
  basis_cents: string;
  pool_cents: string;
  policy_version: string;
  version: string;
  created_at: string;
}
function poolRecord(r: PoolRow): CommissionPoolRecord {
  return defined<CommissionPoolRecord>(
    {
      poolId: r.pool_id as CommissionPoolId,
      purchaseId: r.authorization_id as QualifyingPurchaseId,
      agencyId: r.agency_id as AgencyId,
      captureId: r.capture_id as CaptureId,
      confirmationSeq: r.confirmation_seq,
      projectId: r.project_id as ProjectId,
      source: r.source,
      rateKind: r.rate_kind,
      initialBasisCents: money(r.initial_basis_cents),
      basisCents: money(r.basis_cents),
      rateBps: r.rate_bps,
      poolCents: money(r.pool_cents),
      policyVersion: r.policy_version,
      version: int(r.version),
      createdAt: instantOf(r.created_at),
    },
    { allocationId: optionalString<AttributionAllocationId>(r.allocation_id), assistanceAgreementId: optionalString<AssistanceAgreementId>(r.assistance_agreement_id) },
  );
}

/** A line with the reason and review date of the OPEN hold covering it while it is HELD (the line row carries neither). */
const LINE = `l.line_id, l.agency_id, l.pool_id, l.authorization_id, l.entitlement_id, l.seller_id, l.capture_id, l.share_bps, l.rate_bps, l.net_service_basis_cents, l.cumulative_entitlement_cents,
  l.previous_posted_cents, l.paid_cents, ${canonical("l.paid_at", "paid_at")}, l.state, l.version, ${canonical("l.eligible_at", "eligible_at")}, l.final_completion_id, l.policy_version,
  ${canonical("l.created_at", "created_at")}, h.reason AS held_reason, ${canonical("h.review_at", "review_at")}, l.payable_statement_id`;
const LINE_FROM = `kauro.commission_lines l LEFT JOIN LATERAL (
    SELECT x.reason, x.review_at FROM kauro.commission_holds x WHERE x.line_id = l.line_id AND x.state = 'OPEN' ORDER BY x.opened_at DESC, x.hold_id DESC LIMIT 1
  ) h ON l.state = 'HELD'`;
interface LineRow {
  line_id: string;
  agency_id: string;
  pool_id: string;
  authorization_id: string;
  entitlement_id: string;
  seller_id: string;
  capture_id: string;
  share_bps: number;
  rate_bps: number;
  net_service_basis_cents: string;
  cumulative_entitlement_cents: string;
  previous_posted_cents: string;
  paid_cents: string | null;
  paid_at: string | null;
  state: CommissionLineState;
  version: string;
  eligible_at: string | null;
  final_completion_id: string | null;
  policy_version: string;
  created_at: string;
  held_reason: HoldReason | null;
  review_at: string | null;
  payable_statement_id: string | null;
}
function lineRecord(r: LineRow): CommissionLineRecord {
  return defined<CommissionLineRecord>(
    {
      lineId: r.line_id as CommissionLineId,
      agencyId: r.agency_id as AgencyId,
      poolId: r.pool_id as CommissionPoolId,
      purchaseId: r.authorization_id as QualifyingPurchaseId,
      entitlementId: r.entitlement_id as CommissionEntitlementId,
      sellerId: r.seller_id as SellerId,
      captureId: r.capture_id as CaptureId,
      shareBps: r.share_bps,
      rateBps: r.rate_bps,
      netServiceBasisCents: money(r.net_service_basis_cents),
      cumulativeEntitlementCents: money(r.cumulative_entitlement_cents),
      previousPostedCents: money(r.previous_posted_cents),
      paidCents: centsOrZero(r.paid_cents),
      state: r.state,
      version: int(r.version),
      policyVersion: r.policy_version,
      createdAt: instantOf(r.created_at),
    },
    {
      paidAt: optionalInstantOf(r.paid_at),
      eligibleAt: optionalInstantOf(r.eligible_at),
      finalCompletionId: optionalString<PurchaseCompletionId>(r.final_completion_id),
      heldReason: optionalString<HoldReason>(r.held_reason),
      reviewAt: optionalInstantOf(r.review_at),
      payableStatementId: optionalString<CommissionStatementId>(r.payable_statement_id),
    },
  );
}

const ADJUSTMENT = `adjustment_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id,
  agreement_version, ${canonical("created_at")}`;
interface AdjustmentRow {
  adjustment_id: string;
  line_id: string;
  seller_id: string;
  adjustment_seq: number;
  reason: AdjustmentReason;
  direction: AdjustmentDirection;
  amount_cents: string;
  previous_cumulative_cents: string;
  new_cumulative_entitlement_cents: string;
  new_basis_cents: string;
  source_event_id: string;
  agreement_version: string;
  created_at: string;
}
function adjustmentRecord(r: AdjustmentRow): CommissionAdjustmentRecord {
  return {
    adjustmentId: r.adjustment_id as CommissionAdjustmentId,
    commissionLineId: r.line_id as CommissionLineId,
    sellerId: r.seller_id as SellerId,
    adjustmentSeq: r.adjustment_seq,
    reason: r.reason,
    direction: r.direction,
    amountCents: money(r.amount_cents),
    previousCumulativeCents: money(r.previous_cumulative_cents),
    newCumulativeEntitlementCents: money(r.new_cumulative_entitlement_cents),
    newBasisCents: money(r.new_basis_cents),
    sourceEventId: r.source_event_id as EventId,
    agreementVersion: r.agreement_version,
    createdAt: instantOf(r.created_at),
  };
}

const HOLD = `hold_id, line_id, seller_id, amount_cents, reason, ${canonical("review_at")}, state, version, ${canonical("opened_at")}, ${canonical("coalesce(released_at, upheld_at)", "resolved_at")}`;
interface HoldRow {
  hold_id: string;
  line_id: string;
  seller_id: string;
  amount_cents: string;
  reason: HoldReason;
  review_at: string;
  state: CommissionHoldState;
  version: string;
  opened_at: string;
  resolved_at: string | null;
}
function holdRecord(r: HoldRow): CommissionHoldRecord {
  return defined<CommissionHoldRecord>(
    {
      holdId: r.hold_id as CommissionHoldId,
      lineId: r.line_id as CommissionLineId,
      sellerId: r.seller_id as SellerId,
      amountCents: money(r.amount_cents),
      reason: r.reason,
      reviewAt: instantOf(r.review_at),
      state: r.state,
      version: int(r.version),
      openedAt: instantOf(r.opened_at),
    },
    { resolvedAt: optionalInstantOf(r.resolved_at) },
  );
}

const OFFSET = `offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, ${canonical("recorded_at")}, (SELECT coalesce(sum(r.amount_cents), 0) FROM kauro.commission_offset_releases r WHERE r.offset_id = commission_offsets.offset_id) AS released_cents`;
interface OffsetRow {
  offset_id: string;
  seller_id: string;
  negative_line_id: string;
  against_line_id: string;
  amount_cents: string;
  agreement_id: string;
  recorded_at: string;
  released_cents: string;
}
function offsetRecord(r: OffsetRow): CommissionOffsetRecord {
  return {
    offsetId: r.offset_id as CommissionOffsetId,
    sellerId: r.seller_id as SellerId,
    negativeLineId: r.negative_line_id as CommissionLineId,
    againstLineId: r.against_line_id as CommissionLineId,
    amountCents: money(r.amount_cents),
    agreementId: r.agreement_id as SellerAgreementId,
    recordedAt: instantOf(r.recorded_at),
    releasedCents: money(r.released_cents),
  };
}

const PURCHASE = `q.authorization_id, q.agency_id, q.project_id, q.quote_id, q.order_id, q.capture_id, q.confirmation_seq, ${canonical("q.confirmed_at", "confirmed_at")},
  ${canonical("q.provider_completed_at", "provider_completed_at")}, ${canonical("q.order_created_at", "order_created_at")}, q.allocated_service_cents, q.founding_basis, q.founding_reservation_id`;
interface PurchaseRow {
  authorization_id: string;
  agency_id: string;
  project_id: string;
  quote_id: string;
  order_id: string;
  capture_id: string;
  confirmation_seq: number;
  confirmed_at: string;
  provider_completed_at: string | null;
  order_created_at: string;
  allocated_service_cents: string;
  founding_basis: FoundingBasis;
  founding_reservation_id: string | null;
}
function purchaseRecord(r: PurchaseRow): QualifyingPurchaseRecord {
  return defined<QualifyingPurchaseRecord>(
    {
      purchaseId: r.authorization_id as QualifyingPurchaseId,
      agencyId: r.agency_id as AgencyId,
      projectId: r.project_id as ProjectId,
      quoteId: r.quote_id as QuoteId,
      orderId: r.order_id as PaymentOrderId,
      captureId: r.capture_id as CaptureId,
      confirmationSeq: r.confirmation_seq,
      confirmedAt: instantOf(r.confirmed_at),
      orderCreatedAt: instantOf(r.order_created_at),
      allocatedServiceCents: money(r.allocated_service_cents),
      foundingBasis: r.founding_basis,
    },
    { providerCompletedAt: optionalInstantOf(r.provider_completed_at), foundingReservationId: optionalString<FoundingReservationId>(r.founding_reservation_id) },
  );
}

/** What a line's holds may cover and a covering hold must reach: its unpaid entitlement. */
const UNPAID = "(l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0))";
/** What makes a line due for ELIGIBLE (KC007's conditions); $1 is the instant. */
const DUE_FOR_ELIGIBILITY = `l.state IN ('ACCRUED_PENDING', 'HELD')
          AND EXISTS (SELECT 1 FROM kauro.purchase_completions c WHERE c.agency_id = l.agency_id AND c.authorization_id = l.authorization_id AND c.kind = 'FINAL'
                       AND c.completed_at + interval '720 hours' <= $1::timestamptz)
          AND (SELECT o.funds_state FROM kauro.capture_funds_observations o WHERE o.agency_id = l.agency_id AND o.capture_id = l.capture_id ORDER BY o.capture_version DESC LIMIT 1) = 'AVAILABLE'
          AND NOT EXISTS (SELECT 1 FROM kauro.commission_holds x WHERE x.line_id = l.line_id AND x.state = 'OPEN' AND x.amount_cents >= ${UNPAID})`;

export class PgCommissionLedgerRepository implements CommissionLedgerRepository {
  constructor(
    private readonly db: Queryable,
    private readonly ids: IdGenerator,
  ) {}

  async recordCompletion(completion: NewPurchaseCompletion): Promise<{ readonly recorded: boolean; readonly record: PurchaseCompletionRecord }> {
    const inserted = await execute<CompletionRow>(
      this.db,
      `INSERT INTO kauro.purchase_completions (completion_id, agency_id, authorization_id, kind, stage_ref, completed_at, evidence_hash, source, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, kauro.server_now(), now()) ON CONFLICT DO NOTHING RETURNING ${COMPLETION}`,
      [completion.completionId, completion.agencyId, completion.purchaseId, completion.kind, completion.stageRef ?? null, completion.completedAt, completion.evidenceHash, completion.source],
    );
    if (inserted.rows[0] !== undefined) return { recorded: true, record: completionRecord(inserted.rows[0]) };
    // one FINAL per purchase and one row per stage: the one that exists is the answer
    const existing = await execute<CompletionRow>(
      this.db,
      `SELECT ${COMPLETION} FROM kauro.purchase_completions WHERE agency_id = $1 AND authorization_id = $2 AND kind = $3 AND stage_ref IS NOT DISTINCT FROM $4 ORDER BY recorded_at, completion_id LIMIT 1`,
      [completion.agencyId, completion.purchaseId, completion.kind, completion.stageRef ?? null],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a completion neither recorded nor found after its unique indexes refused it");
    return { recorded: false, record: completionRecord(row) };
  }

  async completionsOf(purchaseId: QualifyingPurchaseId): Promise<ReadonlyArray<PurchaseCompletionRecord>> {
    const r = await execute<CompletionRow>(this.db, `SELECT ${COMPLETION} FROM kauro.purchase_completions WHERE authorization_id = $1 ORDER BY completed_at, completion_id`, [purchaseId]);
    return r.rows.map(completionRecord);
  }

  async recordFundsObservation(observation: CaptureFundsObservationRecord): Promise<{ readonly recorded: boolean; readonly record: CaptureFundsObservationRecord }> {
    const inserted = await execute<ObservationRow>(
      this.db,
      `INSERT INTO kauro.capture_funds_observations (observation_id, agency_id, capture_id, capture_version, funds_state, review_at, source_event_id, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::timestamptz, now()) ON CONFLICT DO NOTHING RETURNING ${OBSERVATION}`,
      [observation.observationId, observation.agencyId, observation.captureId, observation.captureVersion, observation.fundsState, observation.reviewAt ?? null, observation.sourceEventId, observation.observedAt],
    );
    if (inserted.rows[0] !== undefined) return { recorded: true, record: observationRecord(inserted.rows[0]) };
    const existing = await execute<ObservationRow>(
      this.db,
      `SELECT ${OBSERVATION} FROM kauro.capture_funds_observations WHERE source_event_id = $1 OR (agency_id = $2 AND capture_id = $3 AND capture_version = $4) ORDER BY observed_at LIMIT 1`,
      [observation.sourceEventId, observation.agencyId, observation.captureId, observation.captureVersion],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a funds observation neither recorded nor found after its unique indexes refused it");
    return { recorded: false, record: observationRecord(row) };
  }

  async fundsStateOf(captureId: CaptureId): Promise<FundsState> {
    const r = await execute<{ funds_state: ObservedFundsState }>(this.db, "SELECT funds_state FROM kauro.capture_funds_observations WHERE capture_id = $1 ORDER BY capture_version DESC LIMIT 1", [captureId]);
    return r.rows[0]?.funds_state ?? "UNKNOWN";
  }

  async accrue(pool: NewCommissionPool): Promise<{ readonly created: boolean; readonly pool: CommissionPoolRecord; readonly lines: ReadonlyArray<CommissionLineRecord> }> {
    const existing = await this.poolOf(pool.purchaseId, pool.source, pool.assistanceAgreementId);
    if (existing !== null) return { created: false, pool: existing, lines: await this.linesOfPool(existing.poolId) };
    // the purchase's confirmation sequence and project travel with the pool (0030): read from the purchase, in the agency the session adopted
    const inserted = await execute<PoolRow>(
      this.db,
      `INSERT INTO kauro.commission_pools (pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, allocation_id, assistance_agreement_id, rate_kind, rate_bps,
         initial_basis_cents, basis_cents, pool_cents, policy_version, created_at, updated_at)
       SELECT $1, q.agency_id, q.authorization_id, q.capture_id, q.confirmation_seq, q.project_id, $4, $5, $6, $7, $8, $9, $9, $10, $11, now(), now()
         FROM kauro.qualifying_purchases q WHERE q.authorization_id = $2 AND q.agency_id = $3 AND q.capture_id = $12
       ON CONFLICT DO NOTHING RETURNING ${POOL}`,
      [pool.poolId, pool.purchaseId, pool.agencyId, pool.source, pool.allocationId ?? null, pool.assistanceAgreementId ?? null, pool.rateKind, pool.rateBps, pool.basisCents, pool.poolCents, pool.policyVersion, pool.captureId],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      // a concurrent accrual of the same purchase and source won the unique index, or the purchase is not visible to this writer
      const winner = await this.poolOf(pool.purchaseId, pool.source, pool.assistanceAgreementId);
      if (winner === null) throw new DomainFailure("NOT_FOUND", "the qualifying purchase of the pool is not visible in this context");
      return { created: false, pool: winner, lines: await this.linesOfPool(winner.poolId) };
    }
    for (const line of pool.lines) {
      await execute(
        this.db,
        `INSERT INTO kauro.commission_lines (line_id, agency_id, pool_id, entitlement_id, seller_id, authorization_id, capture_id, share_bps, rate_bps, net_service_basis_cents, cumulative_entitlement_cents,
           previous_posted_cents, policy_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, now(), now())`,
        [line.lineId, pool.agencyId, pool.poolId, line.entitlementId, line.sellerId, pool.purchaseId, pool.captureId, line.shareBps, pool.rateBps, pool.basisCents, line.cumulativeEntitlementCents, pool.policyVersion],
      );
      if (line.heldReason !== undefined) {
        // born HELD (PROVIDER_TIME_UNVERIFIED): the birth walks ACCRUED_PENDING -> HELD in the same transaction under an OPEN hold of its whole amount
        if (line.reviewAt === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a line born held names the review date of its hold");
        await this.openHold({ holdId: this.ids.next() as CommissionHoldId, lineId: line.lineId, amountCents: line.cumulativeEntitlementCents, reason: line.heldReason, reviewAt: line.reviewAt, openedAt: pool.createdAt });
        await execute(this.db, "UPDATE kauro.commission_lines SET state = 'HELD', version = version + 1 WHERE line_id = $1", [line.lineId]);
      }
    }
    return { created: true, pool: poolRecord(row), lines: await this.linesOfPool(pool.poolId) };
  }

  private async poolOf(purchaseId: QualifyingPurchaseId, source: CommissionSource, assistanceAgreementId: AssistanceAgreementId | undefined): Promise<CommissionPoolRecord | null> {
    const r = await execute<PoolRow>(this.db, `SELECT ${POOL} FROM kauro.commission_pools WHERE authorization_id = $1 AND source = $2 AND assistance_agreement_id IS NOT DISTINCT FROM $3`, [
      purchaseId,
      source,
      assistanceAgreementId ?? null,
    ]);
    return r.rows[0] ? poolRecord(r.rows[0]) : null;
  }

  private async linesOfPool(poolId: CommissionPoolId): Promise<ReadonlyArray<CommissionLineRecord>> {
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE l.pool_id = $1 ORDER BY l.seller_id, l.line_id`, [poolId]);
    return r.rows.map(lineRecord);
  }

  async poolsOfPurchase(purchaseId: QualifyingPurchaseId): Promise<ReadonlyArray<CommissionPoolRecord>> {
    const r = await execute<PoolRow>(this.db, `SELECT ${POOL} FROM kauro.commission_pools WHERE authorization_id = $1 ORDER BY created_at, pool_id`, [purchaseId]);
    return r.rows.map(poolRecord);
  }

  async lockPoolsOfCapture(captureId: CaptureId): Promise<ReadonlyArray<{ readonly pool: CommissionPoolRecord; readonly lines: ReadonlyArray<CommissionLineRecord> }>> {
    const pools = await execute<PoolRow>(this.db, `SELECT ${POOL} FROM kauro.commission_pools WHERE capture_id = $1 ORDER BY pool_id FOR UPDATE`, [captureId]);
    const out: Array<{ pool: CommissionPoolRecord; lines: ReadonlyArray<CommissionLineRecord> }> = [];
    // G-ORD-1: every line of the capture, row-locked in one call after the pools
    const all = await execute<{ line_id: string }>(this.db, "SELECT line_id FROM kauro.commission_lines WHERE capture_id = $1", [captureId]);
    if (all.rows.length > 0) await execute(this.db, "SELECT kauro.commission_lock_line_rows($1::uuid[], 'UPDATE')", [all.rows.map((x) => x.line_id).sort()]);
    for (const row of pools.rows) {
      out.push({ pool: poolRecord(row), lines: await this.linesOfPool(row.pool_id as CommissionPoolId) });
    }
    return out;
  }

  async fenceLinesOfCapture(captureId: CaptureId): Promise<void> {
    const lines = await execute<{ line_id: string }>(this.db, "SELECT line_id FROM kauro.commission_lines WHERE capture_id = $1 ORDER BY line_id", [captureId]);
    if (lines.rows.length > 0) await execute(this.db, "SELECT kauro.commission_lock_line_rows($1::uuid[], 'KEY SHARE', 'EXCLUSIVE')", [lines.rows.map((x) => x.line_id)]);
  }

  async applyBasisChange(
    poolId: CommissionPoolId,
    basisCents: bigint,
    poolCents: bigint,
    adjustments: ReadonlyArray<NewCommissionAdjustment>,
  ): Promise<{ readonly applied: boolean; readonly adjustments: ReadonlyArray<CommissionAdjustmentRecord> }> {
    const current = await execute<{ basis_cents: string; pool_cents: string }>(this.db, "SELECT basis_cents, pool_cents FROM kauro.commission_pools WHERE pool_id = $1 FOR UPDATE", [poolId]);
    const pool = current.rows[0];
    if (pool === undefined) throw new DomainFailure("NOT_FOUND", "the pool is not visible in this context");
    // a replay adds nothing (UNIQUE line, source event): the adjustments already recorded for these events are the answer
    for (const a of adjustments) {
      const done = await execute(this.db, "SELECT 1 FROM kauro.commission_adjustments WHERE line_id = $1 AND source_event_id = $2", [a.commissionLineId, a.sourceEventId]);
      if (done.rows.length > 0) {
        const all = await execute<AdjustmentRow>(
          this.db,
          `SELECT ${ADJUSTMENT} FROM kauro.commission_adjustments WHERE source_event_id = ANY ($1::uuid[]) AND line_id = ANY ($2::uuid[]) ORDER BY line_id, adjustment_seq`,
          [[...new Set(adjustments.map((x) => x.sourceEventId))], adjustments.map((x) => x.commissionLineId)],
        );
        return { applied: false, adjustments: all.rows.map(adjustmentRecord) };
      }
    }
    if (adjustments.length === 0 && money(pool.basis_cents) === basisCents && money(pool.pool_cents) === poolCents) return { applied: false, adjustments: [] };

    // the pool's new basis and cents (a basis that rises is KC015 at the update), then each line at the new basis, its adjustment first
    await execute(this.db, "UPDATE kauro.commission_pools SET basis_cents = $2, pool_cents = $3, version = version + 1 WHERE pool_id = $1", [poolId, basisCents, poolCents]);
    const recorded: CommissionAdjustmentRecord[] = [];
    const changed = new Map(adjustments.map((a) => [a.commissionLineId as string, a]));
    const lines = await execute<{ line_id: string }>(this.db, "SELECT line_id FROM kauro.commission_lines WHERE pool_id = $1 ORDER BY line_id", [poolId]);
    for (const a of adjustments) {
      if (!lines.rows.some((l) => l.line_id === a.commissionLineId)) throw new DomainFailure("INTEGRITY_FAILURE", "an adjustment names a line outside its pool");
    }
    for (const { line_id } of lines.rows) {
      const adjustment = changed.get(line_id);
      if (adjustment === undefined) {
        await execute(this.db, "UPDATE kauro.commission_lines SET net_service_basis_cents = $2, version = version + 1 WHERE line_id = $1", [line_id, basisCents]);
        continue;
      }
      // the difference is the caller's to state and the database's to check: amount, direction and previous cumulative are written from the
      // line and the signed cents, so an adjustment that is not the cumulative difference is refused KC015
      const r = await execute<AdjustmentRow>(
        this.db,
        `INSERT INTO kauro.commission_adjustments (adjustment_id, agency_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents,
           new_cumulative_entitlement_cents, new_basis_cents, source_event_id, agreement_version, created_at)
         SELECT $1, l.agency_id, l.line_id, l.seller_id, coalesce((SELECT max(a.adjustment_seq) FROM kauro.commission_adjustments a WHERE a.line_id = l.line_id), 0) + 1, $3,
                CASE WHEN $4::bigint < 0 THEN 'DECREASE' ELSE 'INCREASE' END, abs($4::bigint), l.cumulative_entitlement_cents, $5, $6, $7, $8, kauro.server_now()
           FROM kauro.commission_lines l WHERE l.line_id = $2
         RETURNING ${ADJUSTMENT}`,
        [adjustment.adjustmentId, line_id, adjustment.reason, adjustment.signedCents, adjustment.newCumulativeEntitlementCents, basisCents, adjustment.sourceEventId, adjustment.agreementVersion],
      );
      const row = r.rows[0];
      if (row === undefined) throw new DomainFailure("NOT_FOUND", "the line of the adjustment is not visible in this context");
      recorded.push(adjustmentRecord(row));
      await execute(this.db, "UPDATE kauro.commission_lines SET net_service_basis_cents = $2, cumulative_entitlement_cents = $3, version = version + 1 WHERE line_id = $1", [
        line_id,
        basisCents,
        adjustment.newCumulativeEntitlementCents,
      ]);
    }
    return { applied: true, adjustments: recorded };
  }

  async getLine(lineId: CommissionLineId): Promise<CommissionLineRecord | null> {
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE l.line_id = $1`, [lineId]);
    return r.rows[0] ? lineRecord(r.rows[0]) : null;
  }

  async lockLine(lineId: CommissionLineId): Promise<CommissionLineRecord | null> {
    await execute(this.db, "SELECT kauro.commission_lock_line_rows(ARRAY[$1::uuid], 'UPDATE')", [lineId]);
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE l.line_id = $1`, [lineId]);
    return r.rows[0] ? lineRecord(r.rows[0]) : null;
  }

  async lockLines(lineIds: ReadonlyArray<CommissionLineId>, subject?: "EXCLUSIVE" | "SHARE"): Promise<ReadonlyArray<CommissionLineRecord>> {
    const ids = [...new Set(lineIds)].sort();
    if (ids.length === 0) return [];
    await execute(this.db, "SELECT kauro.commission_lock_line_rows($1::uuid[], 'UPDATE', $2::text)", [ids, subject ?? null]);
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE l.line_id = ANY ($1::uuid[]) ORDER BY l.line_id`, [ids]);
    return r.rows.map(lineRecord);
  }

  async linesOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionLineRecord>> {
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE l.seller_id = $1 ORDER BY l.created_at, l.line_id`, [sellerId]);
    return r.rows.map(lineRecord);
  }

  async transitionLine(lineId: CommissionLineId, expectedVersion: number, change: CommissionLineChange, _now: UtcInstant): Promise<VersionedWrite<CommissionLineRecord>> {
    const params: unknown[] = [lineId, expectedVersion, change.state];
    const sets = ["state = $3", "version = l.version + 1"];
    if (change.state === "HELD" && change.heldReason !== undefined) {
      // the line is HELD only under an OPEN hold of its whole unpaid amount: the one that exists, or the one this edge opens (PAYOUT_FAILED)
      if (change.reviewAt === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a line held for a reason names the review date of its hold");
      await execute(this.db, "SELECT kauro.commission_lock_line_rows(ARRAY[$1::uuid], 'UPDATE')", [lineId]);
      const locked = await execute<{ version: string; state: string; unpaid: string }>(this.db, `SELECT l.version, l.state, ${UNPAID} AS unpaid FROM kauro.commission_lines l WHERE l.line_id = $1`, [lineId]);
      const row = locked.rows[0];
      if (row === undefined) throw new DomainFailure("NOT_FOUND", "the line is not visible in this context");
      if (int(row.version) !== expectedVersion) return { kind: "STALE", currentVersion: int(row.version), currentState: row.state };
      const covering = await execute(this.db, "SELECT 1 FROM kauro.commission_holds WHERE line_id = $1 AND state = 'OPEN' AND amount_cents = $2::bigint", [lineId, row.unpaid]);
      if (covering.rows.length === 0) {
        await this.openHold({ holdId: this.ids.next() as CommissionHoldId, lineId, amountCents: money(row.unpaid), reason: change.heldReason, reviewAt: change.reviewAt, openedAt: _now });
      }
    }
    if (change.state === "ELIGIBLE") {
      // 720 hours after the purchase's FINAL completion, exactly as stored; none leaves it NULL and the database refuses it KC007
      const final = "FROM kauro.purchase_completions c WHERE c.agency_id = l.agency_id AND c.authorization_id = l.authorization_id AND c.kind = 'FINAL'";
      sets.push(`eligible_at = (SELECT c.completed_at + interval '720 hours' ${final})`, `final_completion_id = (SELECT c.completion_id ${final})`);
    }
    if (change.state === "PAYABLE" && change.payableStatementId !== undefined) {
      // the statement the line is payable through (0037: an ISSUED statement with the line's PAYABLE item, checked at COMMIT)
      params.push(change.payableStatementId);
      sets.push(`payable_statement_id = $${params.length}::uuid`);
    }
    if (change.state === "PAID") {
      if (change.paidCents !== undefined) {
        params.push(change.paidCents);
        sets.push(`paid_cents = $${params.length}::bigint`);
      } else {
        // the cents the SETTLED statement's PAYABLE item of this line pays, on top of what was paid before (the database repeats it, KC010)
        sets.push(
          `paid_cents = coalesce(l.paid_cents, 0) + (SELECT i.payable_cents FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id
             WHERE i.line_id = l.line_id AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.seller_id = l.seller_id
               AND EXISTS (SELECT 1 FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'SETTLED' AND p.evidence_hash IS NOT NULL)
             ORDER BY s.issued_at DESC LIMIT 1)`,
        );
      }
      sets.push("paid_at = kauro.server_now()");
    }
    const r = await execute<{ line_id: string }>(this.db, `UPDATE kauro.commission_lines l SET ${sets.join(", ")} WHERE l.line_id = $1 AND l.version = $2 RETURNING l.line_id`, params);
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_lines WHERE line_id = $1", lineId, "line");
    const record = await this.getLine(lineId);
    if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "a line just transitioned is not readable by its writer");
    return { kind: "APPLIED", record };
  }

  async adjustmentsOfLine(lineId: CommissionLineId): Promise<ReadonlyArray<CommissionAdjustmentRecord>> {
    const r = await execute<AdjustmentRow>(this.db, `SELECT ${ADJUSTMENT} FROM kauro.commission_adjustments WHERE line_id = $1 ORDER BY adjustment_seq`, [lineId]);
    return r.rows.map(adjustmentRecord);
  }

  async openHold(hold: NewCommissionHold): Promise<CommissionHoldRecord> {
    const r = await execute<HoldRow>(
      this.db,
      `INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at)
       SELECT $1, l.agency_id, l.line_id, l.seller_id, $3, $4, $5::timestamptz, kauro.server_now(), now(), now() FROM kauro.commission_lines l WHERE l.line_id = $2
       RETURNING ${HOLD}`,
      [hold.holdId, hold.lineId, hold.amountCents, hold.reason, hold.reviewAt],
    );
    const row = r.rows[0];
    if (row === undefined) throw new DomainFailure("NOT_FOUND", "the line of the hold is not visible in this context");
    return holdRecord(row);
  }

  async resolveHold(holdId: CommissionHoldId, expectedVersion: number, state: Exclude<CommissionHoldState, "OPEN">, _now: UtcInstant): Promise<VersionedWrite<CommissionHoldRecord>> {
    const r = await execute<HoldRow>(
      this.db,
      `UPDATE kauro.commission_holds SET state = $3, version = version + 1,
         released_at = CASE WHEN $3 = 'RELEASED' THEN kauro.server_now() END, upheld_at = CASE WHEN $3 = 'UPHELD' THEN kauro.server_now() END
       WHERE hold_id = $1 AND version = $2 RETURNING ${HOLD}`,
      [holdId, expectedVersion, state],
    );
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_holds WHERE hold_id = $1", holdId, "hold");
    return { kind: "APPLIED", record: holdRecord(r.rows[0]) };
  }

  async movePayableOwner(lineId: CommissionLineId, expectedVersion: number, fromStatementId: CommissionStatementId, toStatementId: CommissionStatementId): Promise<VersionedWrite<CommissionLineRecord>> {
    const r = await execute<{ line_id: string }>(
      this.db,
      "UPDATE kauro.commission_lines l SET payable_statement_id = $4, version = l.version + 1 WHERE l.line_id = $1 AND l.version = $2 AND l.state = 'PAYABLE' AND l.payable_statement_id = $3 RETURNING l.line_id",
      [lineId, expectedVersion, fromStatementId, toStatementId],
    );
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_lines WHERE line_id = $1", lineId, "line");
    const record = await this.getLine(lineId);
    if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "a line just handed over is not readable by its writer");
    return { kind: "APPLIED", record };
  }

  async holdsOfLine(lineId: CommissionLineId): Promise<ReadonlyArray<CommissionHoldRecord>> {
    const r = await execute<HoldRow>(this.db, `SELECT ${HOLD} FROM kauro.commission_holds WHERE line_id = $1 ORDER BY opened_at, hold_id`, [lineId]);
    return r.rows.map(holdRecord);
  }

  async linesDueForEligibility(now: UtcInstant, limit: number): Promise<ReadonlyArray<CommissionLineRecord>> {
    // due: the purchase's FINAL completion is 720 hours old, its capture's latest funds observation is AVAILABLE and no OPEN hold covers the line
    const r = await execute<LineRow>(this.db, `SELECT ${LINE} FROM ${LINE_FROM} WHERE ${DUE_FOR_ELIGIBILITY} ORDER BY l.created_at, l.line_id LIMIT $2`, [now, limit]);
    return r.rows.map(lineRecord);
  }

  async lineDueForEligibility(lineId: CommissionLineId, now: UtcInstant): Promise<boolean> {
    // the same conditions, one statement after the caller's lock on the line: it sees what committed while the caller waited (D10-GAP-21)
    const r = await execute(this.db, `SELECT 1 FROM ${LINE_FROM} WHERE ${DUE_FOR_ELIGIBILITY} AND l.line_id = $2`, [now, lineId]);
    return r.rows.length > 0;
  }

  async purchasesLackingPools(limit: number): Promise<ReadonlyArray<QualifyingPurchaseRecord>> {
    // a purchase, in the agencies the session reads, of an agency with a live entitlement whose source has no pool for it: the acquisition
    // entitlement's first purchase, or a repeat completed inside its window; an assistance entitlement's purchase ordered after its signing
    // (and of its project when the agreement names one)
    const r = await execute<PurchaseRow>(
      this.db,
      `SELECT ${PURCHASE}
         FROM kauro.qualifying_purchases q
        WHERE EXISTS (
                SELECT 1 FROM kauro.commission_entitlements e
                 WHERE e.agency_id = q.agency_id AND e.state IN ('ACTIVE', 'DISPUTED', 'TERMINATED_WITH_RESIDUAL')
                   AND ((e.kind = 'ACQUISITION' AND (q.confirmation_seq = 1 OR (e.window_ends_at IS NOT NULL AND q.provider_completed_at < e.window_ends_at))
                         AND NOT EXISTS (SELECT 1 FROM kauro.commission_pools p WHERE p.authorization_id = q.authorization_id AND p.source = 'ACQUISITION'))
                     OR (e.kind = 'ASSISTANCE' AND NOT EXISTS (SELECT 1 FROM kauro.commission_pools p WHERE p.authorization_id = q.authorization_id AND p.assistance_agreement_id = e.assistance_agreement_id)
                         AND EXISTS (SELECT 1 FROM kauro.assistance_agreements g WHERE g.assistance_agreement_id = e.assistance_agreement_id AND q.order_created_at > g.signed_at
                                      AND (g.project_id IS NULL OR g.project_id = q.project_id)))))
        ORDER BY q.confirmed_at, q.authorization_id LIMIT $1`,
      [limit],
    );
    return r.rows.map(purchaseRecord);
  }

  async recordOffset(offset: Omit<CommissionOffsetRecord, "releasedCents">): Promise<CommissionOffsetRecord> {
    const r = await execute<OffsetRow>(
      this.db,
      `INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now()) RETURNING ${OFFSET}`,
      [offset.offsetId, offset.sellerId, offset.negativeLineId, offset.againstLineId, offset.amountCents, offset.agreementId],
    );
    return offsetRecord(r.rows[0]!);
  }

  async offsetsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionOffsetRecord>> {
    const r = await execute<OffsetRow>(this.db, `SELECT ${OFFSET} FROM kauro.commission_offsets WHERE seller_id = $1 ORDER BY recorded_at, offset_id`, [sellerId]);
    return r.rows.map(offsetRecord);
  }
}
