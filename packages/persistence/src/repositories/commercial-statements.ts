/**
 * Banking calendars, commission periods, statements, payout intents, reconciliations and compensation-guard reviews over `pg` (mandate
 * B10-ADAPTERS-LEDGER; migration 0031; docs/design/B10-commercial-domain.md §7, §8.2, §10; decisions D10-CAL-1, D10-STMT-1..3,
 * D10-GUARD-1, D10-PAY-1, D10-PAY-2, D10-CTX-3, D10-CLOCK-1) — the StatementRepository port of @kauro/domain.
 *
 * The corporate rows (D10-CTX-3): the commission service writes calendars, periods and statements and moves intents to their evidence;
 * the corporate owner authorizes an intent and approves a statement with its own fresh step-up; a seller reads its own. A period close
 * reads the ledger rows through periodInputs — every line created before the cutoff with its adjustments, holds and offsets, over which
 * KAURO_COMMISSION_CUTOFF_V1 is computed (commercial commissionCutoffHash) and the statement composed (commercial composeStatement).
 * Payout intents are written and moved under their statement's row lock, in the order of design 10 (statement, then intent, then line),
 * so two settlements of one statement serialize. Every instant recorded is `kauro.server_now()` (commercial-ledger-rows).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import {
  DomainFailure,
  compensationGuard,
  type AdjustmentDirection,
  type AgencyId,
  type AssuranceProofId,
  type BankingCalendarRecord,
  type BankingCalendarVersionId,
  type CalendarSource,
  type CaptureId,
  type CommissionAdjustmentRecord,
  type CommissionHoldRecord,
  type CommissionLineRecord,
  type CommissionOffsetRecord,
  type CommissionPeriodId,
  type CommissionPeriodRecord,
  type CommissionPoolRecord,
  type CommissionRateKind,
  type CommissionStatementId,
  type CommissionStatementRecord,
  type CommissionStatementState,
  type CompensationGuardReviewRecord,
  type GuardLabel,
  type GuardResult,
  type GuardReviewId,
  type HoldReason,
  type NewCommissionStatement,
  type NewPayoutIntent,
  type OffsetTerms,
  type PayoutCash,
  type PayoutCurrency,
  type PayoutDestinationId,
  type PayoutFeeBearer,
  type PayoutIntentId,
  type PayoutIntentRecord,
  type PayoutIntentState,
  type PayoutReconciliationId,
  type PayoutReconciliationRecord,
  type PeriodInputs,
  type ProjectId,
  type SellerAgreementId,
  type SellerId,
  type StatementChange,
  type StatementItemDisposition,
  type StatementItemId,
  type StatementItemKind,
  type StatementItemRecord,
  type StatementLabel,
  type StatementRepository,
  type UserId,
  type VersionedWrite,
  type CommissionAdjustmentId,
  type CommissionHoldId,
  type CommissionOffsetId,
  type CommissionLineId,
  type AdjustmentReason,
  type CommissionHoldState,
  type CommissionLineState,
  type CommissionSource,
  type CommissionEntitlementId,
  type CommissionPoolId,
  type PurchaseCompletionId,
  type QualifyingPurchaseId,
  type PurchaseCompletionRecord,
  type CompletionKind,
  type CompletionSource,
} from "@kauro/domain";
import { execute, int, lockPayoutCash, type Queryable } from "../sql.js";
import { calendarDate, canonical, centsOrZero, defined, instantOf, money, optionalInstantOf, optionalMoney, optionalString, staleRow } from "./commercial-ledger-rows.js";

// --- calendars and periods ------------------------------------------------------------------------------------------------------------

const CALENDAR = `calendar_id, calendar_version, jurisdiction, source,
  (SELECT coalesce(array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d), ARRAY[]::text[]) FROM unnest(nonbanking_dates) AS d) AS nonbanking_dates,
  ${calendarDate("covers_from")}, ${calendarDate("covers_to")}, evidence_hash, ${canonical("recorded_at")}`;
interface CalendarRow {
  calendar_id: string;
  calendar_version: string;
  jurisdiction: "CO";
  source: CalendarSource;
  nonbanking_dates: string[];
  covers_from: string;
  covers_to: string;
  evidence_hash: string;
  recorded_at: string;
}
function calendarRecord(r: CalendarRow): BankingCalendarRecord {
  return {
    calendarVersionId: r.calendar_id as BankingCalendarVersionId,
    calendarVersion: r.calendar_version,
    jurisdiction: r.jurisdiction,
    source: r.source,
    nonbankingDates: r.nonbanking_dates,
    coversFrom: r.covers_from,
    coversTo: r.covers_to,
    evidenceHash: r.evidence_hash as Sha256Hex,
    recordedAt: instantOf(r.recorded_at),
  };
}

const PERIOD = `period_id, to_char(period_month, 'YYYY-MM') AS month, ${canonical("starts_at")}, ${canonical("ends_at")}, state, version, calendar_id, calendar_source, ${calendarDate("close_due_on")},
  ${calendarDate("pay_due_on")}, cutoff_hash, ${canonical("closed_at")}`;
interface PeriodRow {
  period_id: string;
  month: string;
  starts_at: string;
  ends_at: string;
  state: CommissionPeriodRecord["state"];
  version: string;
  calendar_id: string | null;
  calendar_source: CalendarSource | null;
  close_due_on: string | null;
  pay_due_on: string | null;
  cutoff_hash: string | null;
  closed_at: string | null;
}
function periodRecord(r: PeriodRow): CommissionPeriodRecord {
  return defined<CommissionPeriodRecord>(
    { periodId: r.period_id as CommissionPeriodId, month: r.month, startsAt: instantOf(r.starts_at), endsAt: instantOf(r.ends_at), state: r.state, version: int(r.version) },
    {
      calendarVersionId: optionalString<BankingCalendarVersionId>(r.calendar_id),
      calendarSource: optionalString<CalendarSource>(r.calendar_source),
      closeDueOn: optionalString(r.close_due_on),
      payDueOn: optionalString(r.pay_due_on),
      cutoffHash: optionalString<Sha256Hex>(r.cutoff_hash),
      closedAt: optionalInstantOf(r.closed_at),
    },
  );
}

// --- statements and items --------------------------------------------------------------------------------------------------------------

const STATEMENT = `s.statement_id, s.period_id, s.seller_id, ${canonical("s.period_starts_at", "period_starts_at")}, ${canonical("s.period_ends_at", "period_ends_at")}, s.calendar_id, s.calendar_source,
  ${calendarDate("s.statement_date", "statement_date")}, ${calendarDate("s.pay_date", "pay_date")}, s.label, s.accrued_pending_cents, s.held_cents, s.payable_cents, s.paid_to_date_cents,
  s.negative_balance_cents, s.cutoff_hash, s.corrects_statement_id, (SELECT coalesce(array_agg(x::text ORDER BY x), ARRAY[]::text[]) FROM unnest(s.input_line_ids) AS x) AS input_line_ids, s.state, s.version, ${canonical("s.issued_at", "issued_at")}, s.payout_evidence_hash,
  (SELECT coalesce(array_agg(i.line_id::text ORDER BY i.item_no), ARRAY[]::text[]) FROM kauro.statement_items i WHERE i.statement_id = s.statement_id AND i.item_kind = 'LINE') AS line_ids`;
interface StatementRow {
  statement_id: string;
  period_id: string;
  seller_id: string;
  period_starts_at: string;
  period_ends_at: string;
  calendar_id: string;
  calendar_source: CalendarSource;
  statement_date: string;
  pay_date: string;
  label: StatementLabel;
  accrued_pending_cents: string;
  held_cents: string;
  payable_cents: string;
  paid_to_date_cents: string;
  negative_balance_cents: string;
  cutoff_hash: string;
  corrects_statement_id: string | null;
  state: CommissionStatementState;
  version: string;
  issued_at: string | null;
  payout_evidence_hash: string | null;
  line_ids: string[];
  input_line_ids: string[];
}
function statementRecord(r: StatementRow): CommissionStatementRecord {
  return defined<CommissionStatementRecord>(
    {
      statementId: r.statement_id as CommissionStatementId,
      periodId: r.period_id as CommissionPeriodId,
      sellerId: r.seller_id as SellerId,
      periodStart: instantOf(r.period_starts_at),
      periodEnd: instantOf(r.period_ends_at),
      lineIds: r.line_ids as CommissionLineId[],
      inputLineIds: r.input_line_ids as CommissionLineId[],
      accruedPendingCents: money(r.accrued_pending_cents),
      heldCents: money(r.held_cents),
      payableCents: money(r.payable_cents),
      paidToDateCents: money(r.paid_to_date_cents),
      negativeBalanceCents: money(r.negative_balance_cents),
      state: r.state,
      version: int(r.version),
      calendarVersionId: r.calendar_id as BankingCalendarVersionId,
      calendarSource: r.calendar_source,
      label: r.label,
      statementDate: r.statement_date,
      payDueOn: r.pay_date,
      cutoffHash: r.cutoff_hash as Sha256Hex,
    },
    { correctsStatementId: optionalString<CommissionStatementId>(r.corrects_statement_id), payoutEvidenceHash: optionalString<Sha256Hex>(r.payout_evidence_hash), issuedAt: optionalInstantOf(r.issued_at) },
  );
}

const ITEM = `item_id, statement_id, seller_id, item_no, item_kind, disposition, line_id, adjustment_id, hold_id, offset_id, agency_id, project_id, rate_kind, basis_cents, rate_bps, share_bps,
  cumulative_cents, previously_paid_cents, adjustment_direction, adjustment_cents, held_cents, hold_reason, ${canonical("hold_review_at")}, offset_cents, payable_cents`;
interface ItemRow {
  item_id: string;
  statement_id: string;
  seller_id: string;
  item_no: number;
  item_kind: StatementItemKind;
  disposition: StatementItemDisposition;
  line_id: string | null;
  adjustment_id: string | null;
  hold_id: string | null;
  offset_id: string | null;
  agency_id: string | null;
  project_id: string | null;
  rate_kind: CommissionRateKind | null;
  basis_cents: string | null;
  rate_bps: number | null;
  share_bps: number | null;
  cumulative_cents: string | null;
  previously_paid_cents: string | null;
  adjustment_direction: AdjustmentDirection | null;
  adjustment_cents: string | null;
  held_cents: string;
  hold_reason: HoldReason | null;
  hold_review_at: string | null;
  offset_cents: string;
  payable_cents: string;
}
function itemRecord(r: ItemRow): StatementItemRecord {
  return defined<StatementItemRecord>(
    {
      itemId: r.item_id as StatementItemId,
      statementId: r.statement_id as CommissionStatementId,
      sellerId: r.seller_id as SellerId,
      itemNo: r.item_no,
      kind: r.item_kind,
      disposition: r.disposition,
      heldCents: money(r.held_cents),
      offsetCents: money(r.offset_cents),
      payableCents: money(r.payable_cents),
    },
    {
      lineId: optionalString<CommissionLineId>(r.line_id),
      adjustmentId: optionalString<CommissionAdjustmentId>(r.adjustment_id),
      holdId: optionalString<CommissionHoldId>(r.hold_id),
      offsetId: optionalString<CommissionOffsetId>(r.offset_id),
      agencyId: optionalString<AgencyId>(r.agency_id),
      projectId: optionalString<ProjectId>(r.project_id),
      rateKind: optionalString<CommissionRateKind>(r.rate_kind),
      basisCents: optionalMoney(r.basis_cents),
      rateBps: r.rate_bps ?? undefined,
      shareBps: r.share_bps ?? undefined,
      cumulativeCents: optionalMoney(r.cumulative_cents),
      previouslyPaidCents: optionalMoney(r.previously_paid_cents),
      adjustmentDirection: optionalString<AdjustmentDirection>(r.adjustment_direction),
      adjustmentCents: optionalMoney(r.adjustment_cents),
      holdReason: optionalString<HoldReason>(r.hold_reason),
      holdReviewAt: optionalInstantOf(r.hold_review_at),
    },
  );
}

// --- intents, reconciliations, reviews --------------------------------------------------------------------------------------------------

const INTENT = `intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference, state, version, authorized_by_user_id,
  authorization_proof_ref, ${canonical("authorized_at")}, evidence_hash`;
interface IntentRow {
  intent_id: string;
  statement_id: string;
  seller_id: string;
  amount_cents: string;
  currency: PayoutCurrency;
  fee_bearer: PayoutFeeBearer;
  destination_id: string;
  destination_version: number;
  destination_digest: string;
  reference: string;
  state: PayoutIntentState;
  version: string;
  authorized_by_user_id: string;
  authorization_proof_ref: string;
  authorized_at: string;
  evidence_hash: string | null;
}
function intentRecord(r: IntentRow): PayoutIntentRecord {
  return defined<PayoutIntentRecord>(
    {
      intentId: r.intent_id as PayoutIntentId,
      statementId: r.statement_id as CommissionStatementId,
      sellerId: r.seller_id as SellerId,
      amountCents: money(r.amount_cents),
      currency: r.currency,
      feeBearer: r.fee_bearer,
      destinationId: r.destination_id as PayoutDestinationId,
      destinationVersion: r.destination_version,
      destinationDigest: r.destination_digest as Sha256Hex,
      reference: r.reference,
      state: r.state,
      version: int(r.version),
      authorizedBy: r.authorized_by_user_id as UserId,
      authorizationProofId: r.authorization_proof_ref as AssuranceProofId,
      authorizedAt: instantOf(r.authorized_at),
    },
    { evidenceHash: optionalString<Sha256Hex>(r.evidence_hash) },
  );
}

/** The intents that count against cash and against a second authorization: authorized, submitted, uncertain or settled. */
const LIVE_INTENT = "('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'SETTLED')";

const RECONCILIATION = `reconciliation_id, intent_id, evidence_kind, evidence_hash, reference, destination_digest, amount_cents, currency, provider_ref, ${canonical("observed_at")}, ${canonical("recorded_at")}`;
interface ReconciliationRow {
  reconciliation_id: string;
  intent_id: string;
  evidence_kind: PayoutReconciliationRecord["evidence"]["status"];
  evidence_hash: string;
  reference: string;
  destination_digest: string;
  amount_cents: string;
  currency: string;
  provider_ref: string | null;
  observed_at: string;
  recorded_at: string;
}
function reconciliationRecord(r: ReconciliationRow): PayoutReconciliationRecord {
  return {
    reconciliationId: r.reconciliation_id as PayoutReconciliationId,
    intentId: r.intent_id as PayoutIntentId,
    evidence: defined<PayoutReconciliationRecord["evidence"]>(
      {
        status: r.evidence_kind,
        reference: r.reference,
        destinationDigest: r.destination_digest as Sha256Hex,
        amountCents: money(r.amount_cents),
        currency: r.currency,
        observedAt: instantOf(r.observed_at),
        evidenceHash: r.evidence_hash as Sha256Hex,
      },
      { providerRef: optionalString(r.provider_ref) },
    ),
    reconciledAt: instantOf(r.recorded_at),
  };
}

const REVIEW = `review_id, period_id, seller_id, statement_id, retainer_cents, commission_accrued_cents, attributable_net_service_cents, guard_bps, outcome, label, ${canonical("created_at")}`;
interface ReviewRow {
  review_id: string;
  period_id: string;
  seller_id: string;
  statement_id: string | null;
  retainer_cents: string;
  commission_accrued_cents: string;
  attributable_net_service_cents: string;
  guard_bps: number;
  outcome: GuardResult;
  label: GuardLabel;
  created_at: string;
}
function reviewRecord(r: ReviewRow): CompensationGuardReviewRecord {
  const retainerCents = money(r.retainer_cents);
  const commissionAccruedCents = money(r.commission_accrued_cents);
  const attributableNetServiceCents = money(r.attributable_net_service_cents);
  // the displayed ratio is derived, never stored: the result is the exact integer comparison the database checked
  const guard = compensationGuard({ retainerCents, commissionAccruedCents, attributableNetServiceCents });
  return defined<CompensationGuardReviewRecord>(
    {
      reviewId: r.review_id as GuardReviewId,
      periodId: r.period_id as CommissionPeriodId,
      sellerId: r.seller_id as SellerId,
      retainerCents,
      commissionAccruedCents,
      attributableNetServiceCents,
      guardBps: r.guard_bps,
      ratioBps: guard.ratioBps,
      result: r.outcome,
      label: r.label,
      recordedAt: instantOf(r.created_at),
    },
    { statementId: optionalString<CommissionStatementId>(r.statement_id) },
  );
}

// --- the ledger rows a close reads ---------------------------------------------------------------------------------------------------------

const LEDGER_LINE = `l.line_id, l.agency_id, l.pool_id, l.authorization_id, l.entitlement_id, l.seller_id, l.capture_id, l.share_bps, l.rate_bps, l.net_service_basis_cents, l.cumulative_entitlement_cents,
  l.previous_posted_cents, l.paid_cents, ${canonical("l.paid_at", "paid_at")}, l.state, l.version, ${canonical("l.eligible_at", "eligible_at")}, l.final_completion_id, l.policy_version,
  ${canonical("l.created_at", "created_at")}`;
interface LedgerLineRow {
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
}

export class PgStatementRepository implements StatementRepository {
  constructor(private readonly db: Queryable) {}

  // --- calendars -----------------------------------------------------------------------------------------------------------------------

  async latestCalendar(jurisdiction: "CO", source: CalendarSource): Promise<BankingCalendarRecord | null> {
    const r = await execute<CalendarRow>(this.db, `SELECT ${CALENDAR} FROM kauro.banking_calendars WHERE jurisdiction = $1 AND source = $2 ORDER BY recorded_at DESC, calendar_id DESC LIMIT 1`, [jurisdiction, source]);
    return r.rows[0] ? calendarRecord(r.rows[0]) : null;
  }

  async getCalendar(calendarVersionId: BankingCalendarVersionId): Promise<BankingCalendarRecord | null> {
    const r = await execute<CalendarRow>(this.db, `SELECT ${CALENDAR} FROM kauro.banking_calendars WHERE calendar_id = $1`, [calendarVersionId]);
    return r.rows[0] ? calendarRecord(r.rows[0]) : null;
  }

  async recordCalendar(calendar: BankingCalendarRecord): Promise<BankingCalendarRecord> {
    const inserted = await execute<CalendarRow>(
      this.db,
      `INSERT INTO kauro.banking_calendars (calendar_id, jurisdiction, calendar_version, source, nonbanking_dates, covers_from, covers_to, evidence_hash, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5::date[], $6::date, $7::date, $8, kauro.server_now(), now()) ON CONFLICT (jurisdiction, calendar_version) DO NOTHING RETURNING ${CALENDAR}`,
      [calendar.calendarVersionId, calendar.jurisdiction, calendar.calendarVersion, calendar.source, [...calendar.nonbankingDates], calendar.coversFrom, calendar.coversTo, calendar.evidenceHash],
    );
    if (inserted.rows[0] !== undefined) return calendarRecord(inserted.rows[0]);
    // a version is recorded once: the one that exists is the answer
    const existing = await execute<CalendarRow>(this.db, `SELECT ${CALENDAR} FROM kauro.banking_calendars WHERE jurisdiction = $1 AND calendar_version = $2`, [calendar.jurisdiction, calendar.calendarVersion]);
    const row = existing.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a calendar version neither recorded nor found after its unique index refused it");
    return calendarRecord(row);
  }

  // --- periods -------------------------------------------------------------------------------------------------------------------------

  async getPeriod(periodId: CommissionPeriodId): Promise<CommissionPeriodRecord | null> {
    const r = await execute<PeriodRow>(this.db, `SELECT ${PERIOD} FROM kauro.commission_periods WHERE period_id = $1`, [periodId]);
    return r.rows[0] ? periodRecord(r.rows[0]) : null;
  }

  async lockPeriod(periodId: CommissionPeriodId): Promise<CommissionPeriodRecord | null> {
    const r = await execute<PeriodRow>(this.db, `SELECT ${PERIOD} FROM kauro.commission_periods WHERE period_id = $1 FOR UPDATE`, [periodId]);
    return r.rows[0] ? periodRecord(r.rows[0]) : null;
  }

  async periodOfMonth(month: string): Promise<CommissionPeriodRecord | null> {
    const r = await execute<PeriodRow>(this.db, `SELECT ${PERIOD} FROM kauro.commission_periods WHERE period_month = ($1 || '-01')::date`, [month]);
    return r.rows[0] ? periodRecord(r.rows[0]) : null;
  }

  async openPeriod(period: Omit<CommissionPeriodRecord, "state" | "version" | "cutoffHash" | "closedAt">): Promise<{ readonly created: boolean; readonly record: CommissionPeriodRecord }> {
    // the bounds are the month's in America/Bogota, written by the database from the month (the check repeats them against what was given)
    const inserted = await execute<PeriodRow>(
      this.db,
      `INSERT INTO kauro.commission_periods (period_id, period_month, starts_at, ends_at, calendar_id, calendar_source, close_due_on, pay_due_on, created_at, updated_at)
       VALUES ($1, ($2 || '-01')::date, (($2 || '-01')::date::timestamp AT TIME ZONE 'America/Bogota'), ((($2 || '-01')::date + interval '1 month') AT TIME ZONE 'America/Bogota'), $3, $4, $5::date, $6::date, now(), now())
       ON CONFLICT (period_month) DO NOTHING RETURNING ${PERIOD}`,
      [period.periodId, period.month, period.calendarVersionId ?? null, period.calendarSource ?? null, period.closeDueOn ?? null, period.payDueOn ?? null],
    );
    if (inserted.rows[0] !== undefined) {
      const record = periodRecord(inserted.rows[0]);
      if (record.startsAt !== period.startsAt || record.endsAt !== period.endsAt) throw new DomainFailure("INTEGRITY_FAILURE", "the bounds given for a period are not its month's in America/Bogota");
      return { created: true, record };
    }
    const existing = await this.periodOfMonth(period.month);
    if (existing === null) throw new DomainFailure("INTEGRITY_FAILURE", "a period neither opened nor found after its unique index refused it");
    return { created: false, record: existing };
  }

  async datePeriod(
    periodId: CommissionPeriodId,
    expectedVersion: number,
    dates: { readonly calendarVersionId: BankingCalendarVersionId; readonly calendarSource: CalendarSource; readonly closeDueOn: string; readonly payDueOn: string },
    _now: UtcInstant,
  ): Promise<VersionedWrite<CommissionPeriodRecord>> {
    const r = await execute<PeriodRow>(
      this.db,
      `UPDATE kauro.commission_periods SET calendar_id = $3, calendar_source = $4, close_due_on = $5::date, pay_due_on = $6::date, version = version + 1
        WHERE period_id = $1 AND version = $2 RETURNING ${PERIOD}`,
      [periodId, expectedVersion, dates.calendarVersionId, dates.calendarSource, dates.closeDueOn, dates.payDueOn],
    );
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_periods WHERE period_id = $1", periodId, "period");
    return { kind: "APPLIED", record: periodRecord(r.rows[0]) };
  }

  async periodInputs(periodId: CommissionPeriodId, cutoffAt: UtcInstant): Promise<PeriodInputs> {
    const period = await this.getPeriod(periodId);
    if (period === null) throw new DomainFailure("NOT_FOUND", "the period is not visible in this context");
    // every line created before the cutoff, whatever its state, and everything recorded against those lines: a change of any of them after the
    // proposal changes the hash (LEDGER_CHANGED), so the close is of exactly the ledger that was proposed
    const lineRows = await execute<LedgerLineRow>(this.db, `SELECT ${LEDGER_LINE} FROM kauro.commission_lines l WHERE l.created_at < $1::timestamptz ORDER BY l.created_at, l.line_id`, [cutoffAt]);
    const lines: CommissionLineRecord[] = lineRows.rows.map((r) =>
      defined<CommissionLineRecord>(
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
        { paidAt: optionalInstantOf(r.paid_at), eligibleAt: optionalInstantOf(r.eligible_at), finalCompletionId: optionalString<PurchaseCompletionId>(r.final_completion_id) },
      ),
    );
    const lineIds = lines.map((l) => l.lineId as string);
    const adjustments = await execute<{
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
    }>(
      this.db,
      `SELECT adjustment_id, line_id, seller_id, adjustment_seq, reason, direction, amount_cents, previous_cumulative_cents, new_cumulative_entitlement_cents, new_basis_cents, source_event_id,
              agreement_version, ${canonical("created_at")}
         FROM kauro.commission_adjustments WHERE line_id = ANY ($1::uuid[]) ORDER BY line_id, adjustment_seq`,
      [lineIds],
    );
    const holds = await execute<{
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
    }>(
      this.db,
      `SELECT hold_id, line_id, seller_id, amount_cents, reason, ${canonical("review_at")}, state, version, ${canonical("opened_at")}, ${canonical("coalesce(released_at, upheld_at)", "resolved_at")}
         FROM kauro.commission_holds WHERE line_id = ANY ($1::uuid[]) ORDER BY line_id, opened_at, hold_id`,
      [lineIds],
    );
    const offsets = await execute<{ offset_id: string; seller_id: string; negative_line_id: string; against_line_id: string; amount_cents: string; agreement_id: string; recorded_at: string }>(
      this.db,
      `SELECT offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, ${canonical("recorded_at")}
         FROM kauro.commission_offsets WHERE negative_line_id = ANY ($1::uuid[]) OR against_line_id = ANY ($1::uuid[]) ORDER BY recorded_at, offset_id`,
      [lineIds],
    );
    const poolIds = [...new Set(lines.map((l) => l.poolId as string))];
    const pools = await execute<{
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
    }>(
      this.db,
      `SELECT pool_id, agency_id, authorization_id, capture_id, confirmation_seq, project_id, source, allocation_id, assistance_agreement_id, rate_kind, rate_bps, initial_basis_cents, basis_cents,
              pool_cents, policy_version, version, ${canonical("created_at")}
         FROM kauro.commission_pools WHERE pool_id = ANY ($1::uuid[]) ORDER BY pool_id`,
      [poolIds],
    );
    const purchaseIds = [...new Set(lines.map((l) => l.purchaseId as string))];
    const completions = await execute<{
      completion_id: string;
      authorization_id: string;
      agency_id: string;
      kind: CompletionKind;
      stage_ref: string | null;
      completed_at: string;
      evidence_hash: string;
      source: CompletionSource;
      recorded_at: string;
    }>(
      this.db,
      `SELECT completion_id, authorization_id, agency_id, kind, stage_ref, ${canonical("completed_at")}, evidence_hash, source, ${canonical("recorded_at")}
         FROM kauro.purchase_completions WHERE authorization_id = ANY ($1::uuid[]) ORDER BY completed_at, completion_id`,
      [purchaseIds],
    );
    const captureIds = [...new Set(lines.map((l) => l.captureId as string))];
    const funds = await execute<{ capture_id: string; funds_state: "HELD" | "AVAILABLE" }>(
      this.db,
      `SELECT DISTINCT ON (capture_id) capture_id, funds_state FROM kauro.capture_funds_observations WHERE capture_id = ANY ($1::uuid[]) ORDER BY capture_id, capture_version DESC`,
      [captureIds],
    );
    const terms = await execute<{ line_id: string; agreement_id: string; offset_terms: OffsetTerms }>(
      this.db,
      `SELECT l.line_id, e.agreement_id, g.offset_terms FROM kauro.commission_lines l
         JOIN kauro.commission_entitlements e ON e.entitlement_id = l.entitlement_id
         JOIN kauro.seller_agreements g ON g.seller_id = e.seller_id AND g.agreement_id = e.agreement_id
        WHERE l.line_id = ANY ($1::uuid[]) ORDER BY l.line_id`,
      [lineIds],
    );
    return {
      lines,
      adjustments: adjustments.rows.map((r) => ({
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
        sourceEventId: r.source_event_id as CommissionAdjustmentRecord["sourceEventId"],
        agreementVersion: r.agreement_version,
        createdAt: instantOf(r.created_at),
      })),
      holds: holds.rows.map((r) =>
        defined<CommissionHoldRecord>(
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
        ),
      ),
      pools: pools.rows.map((r) =>
        defined<CommissionPoolRecord>(
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
          { allocationId: optionalString<CommissionPoolRecord["allocationId"] & string>(r.allocation_id), assistanceAgreementId: optionalString<CommissionPoolRecord["assistanceAgreementId"] & string>(r.assistance_agreement_id) },
        ),
      ),
      completions: completions.rows.map((r) =>
        defined<PurchaseCompletionRecord>(
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
        ),
      ),
      funds: funds.rows.map((r) => ({ captureId: r.capture_id as CaptureId, fundsState: r.funds_state })),
      offsets: offsets.rows.map(
        (r): CommissionOffsetRecord => ({
          offsetId: r.offset_id as CommissionOffsetId,
          sellerId: r.seller_id as SellerId,
          negativeLineId: r.negative_line_id as CommissionLineId,
          againstLineId: r.against_line_id as CommissionLineId,
          amountCents: money(r.amount_cents),
          agreementId: r.agreement_id as SellerAgreementId,
          recordedAt: instantOf(r.recorded_at),
        }),
      ),
      offsetTerms: terms.rows.map((r) => ({ lineId: r.line_id as CommissionLineId, agreementId: r.agreement_id as SellerAgreementId, offsetTerms: r.offset_terms })),
      undeliveredBeforeCutoff: await this.undeliveredBefore(cutoffAt),
    };
  }

  /**
   * COMMISSIONS outbox records created before the cutoff and not yet delivered, when this session can see the whole outbox — the control
   * plane's (kauro_control) — and null otherwise: a role with no grant or with a tenant policy over it would count zero for want of a
   * read, and an unobservable input is unreconciled, never reconciled (CMD051 INPUTS_UNRECONCILED).
   */
  private async undeliveredBefore(cutoffAt: UtcInstant): Promise<number | null> {
    // the commission service reads the COMMISSIONS records themselves since migration 0034 (outbox_records_commission_inputs; D10-STMT-4)
    const sees = await execute<{ ok: boolean }>(this.db, "SELECT pg_has_role(current_user, 'kauro_control', 'USAGE') OR pg_has_role(current_user, 'kauro_commission', 'USAGE') AS ok");
    if (sees.rows[0]?.ok !== true) return null;
    const r = await execute<{ n: string }>(this.db, "SELECT count(*)::text AS n FROM kauro.outbox_records WHERE consumer = 'COMMISSIONS' AND state <> 'DELIVERED' AND created_at < $1::timestamptz", [cutoffAt]);
    return int(r.rows[0]?.n ?? "0");
  }

  async closePeriod(periodId: CommissionPeriodId, expectedVersion: number, cutoffHash: Sha256Hex, _now: UtcInstant): Promise<VersionedWrite<CommissionPeriodRecord>> {
    const r = await execute<PeriodRow>(
      this.db,
      `UPDATE kauro.commission_periods SET state = 'CLOSED', cutoff_hash = $3, closed_at = kauro.server_now(), version = version + 1 WHERE period_id = $1 AND version = $2 RETURNING ${PERIOD}`,
      [periodId, expectedVersion, cutoffHash],
    );
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_periods WHERE period_id = $1", periodId, "period");
    return { kind: "APPLIED", record: periodRecord(r.rows[0]) };
  }

  // --- statements ----------------------------------------------------------------------------------------------------------------------

  async issueStatement(input: NewCommissionStatement): Promise<{ readonly issued: boolean; readonly record: CommissionStatementRecord }> {
    const s = input.statement;
    const inserted = await execute<{ statement_id: string }>(
      this.db,
      `INSERT INTO kauro.commission_statements (statement_id, period_id, seller_id, period_starts_at, period_ends_at, calendar_id, calendar_source, statement_date, pay_date, label, accrued_pending_cents,
         held_cents, payable_cents, paid_to_date_cents, negative_balance_cents, cutoff_hash, corrects_statement_id, input_line_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8::date, $9::date, $10, $11, $12, $13, $14, $15, $16, $17, $18::uuid[], now(), now())
       ON CONFLICT DO NOTHING RETURNING statement_id`,
      [
        s.statementId,
        s.periodId,
        s.sellerId,
        s.periodStart,
        s.periodEnd,
        s.calendarVersionId,
        s.calendarSource,
        s.statementDate,
        s.payDueOn,
        s.label,
        s.accruedPendingCents,
        s.heldCents,
        s.payableCents,
        s.paidToDateCents,
        s.negativeBalanceCents,
        s.cutoffHash,
        s.correctsStatementId ?? null,
        [...s.inputLineIds],
      ],
    );
    if (inserted.rows[0] === undefined) {
      // one statement per period and seller (and one correction per statement): the one that exists is the replayed answer
      const existing = await execute<StatementRow>(
        this.db,
        `SELECT ${STATEMENT} FROM kauro.commission_statements s WHERE s.statement_id = $1 OR (s.period_id = $2 AND s.seller_id = $3 AND s.corrects_statement_id IS NOT DISTINCT FROM $4) ORDER BY s.created_at LIMIT 1`,
        [s.statementId, s.periodId, s.sellerId, s.correctsStatementId ?? null],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a statement neither issued nor found after its unique index refused it");
      return { issued: false, record: statementRecord(row) };
    }
    for (const item of input.items) {
      await execute(
        this.db,
        `INSERT INTO kauro.statement_items (item_id, statement_id, seller_id, item_no, item_kind, disposition, line_id, adjustment_id, hold_id, offset_id, agency_id, project_id, rate_kind, basis_cents,
           rate_bps, share_bps, cumulative_cents, previously_paid_cents, adjustment_direction, adjustment_cents, held_cents, hold_reason, hold_review_at, offset_cents, payable_cents, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::timestamptz, $24, $25, now())`,
        [
          item.itemId,
          s.statementId,
          s.sellerId,
          item.itemNo,
          item.kind,
          item.disposition,
          item.lineId ?? null,
          item.adjustmentId ?? null,
          item.holdId ?? null,
          item.offsetId ?? null,
          item.agencyId ?? null,
          item.projectId ?? null,
          item.rateKind ?? null,
          item.basisCents ?? null,
          item.rateBps ?? null,
          item.shareBps ?? null,
          item.cumulativeCents ?? null,
          item.previouslyPaidCents ?? null,
          item.adjustmentDirection ?? null,
          item.adjustmentCents ?? null,
          item.heldCents,
          item.holdReason ?? null,
          item.holdReviewAt ?? null,
          item.offsetCents,
          item.payableCents,
        ],
      );
    }
    // DRAFT -> ISSUED in the transaction that wrote its items (the totals are checked against them at COMMIT)
    await execute(this.db, "UPDATE kauro.commission_statements SET state = 'ISSUED', issued_at = kauro.server_now(), version = version + 1 WHERE statement_id = $1", [s.statementId]);
    const record = await this.getStatement(s.statementId);
    if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "a statement just issued is not readable by its writer");
    return { issued: true, record };
  }

  async getStatement(statementId: CommissionStatementId): Promise<CommissionStatementRecord | null> {
    const r = await execute<StatementRow>(this.db, `SELECT ${STATEMENT} FROM kauro.commission_statements s WHERE s.statement_id = $1`, [statementId]);
    return r.rows[0] ? statementRecord(r.rows[0]) : null;
  }

  async lockStatement(statementId: CommissionStatementId): Promise<CommissionStatementRecord | null> {
    const r = await execute<StatementRow>(this.db, `SELECT ${STATEMENT} FROM kauro.commission_statements s WHERE s.statement_id = $1 FOR UPDATE OF s`, [statementId]);
    return r.rows[0] ? statementRecord(r.rows[0]) : null;
  }

  async statementsOfSeller(sellerId: SellerId): Promise<ReadonlyArray<CommissionStatementRecord>> {
    const r = await execute<StatementRow>(this.db, `SELECT ${STATEMENT} FROM kauro.commission_statements s WHERE s.seller_id = $1 ORDER BY s.period_starts_at, s.created_at, s.statement_id`, [sellerId]);
    return r.rows.map(statementRecord);
  }

  async itemsOf(statementId: CommissionStatementId): Promise<ReadonlyArray<StatementItemRecord>> {
    const r = await execute<ItemRow>(this.db, `SELECT ${ITEM} FROM kauro.statement_items WHERE statement_id = $1 ORDER BY item_no`, [statementId]);
    return r.rows.map(itemRecord);
  }

  async transitionStatement(statementId: CommissionStatementId, expectedVersion: number, change: StatementChange, _now: UtcInstant): Promise<VersionedWrite<CommissionStatementRecord>> {
    const params: unknown[] = [statementId, expectedVersion, change.state];
    const sets = ["state = $3", "version = s.version + 1"];
    switch (change.state) {
      case "ISSUED":
        // DRAFT -> ISSUED is the first issue; a statement back to ISSUED (a failed payout, a resolved dispute) keeps its first issue instant
        sets.push("issued_at = coalesce(s.issued_at, kauro.server_now())");
        break;
      case "APPROVED":
        // the owner's approval is the authorization of the intent of this transaction: the same person with the same fresh step-up
        sets.push(
          "approved_by_user_id = kauro.current_user_id()",
          "approved_at = kauro.server_now()",
          "approval_proof_ref = (SELECT p.authorization_proof_ref FROM kauro.payout_intents p WHERE p.statement_id = s.statement_id AND p.state = 'AUTHORIZED' ORDER BY p.authorized_at DESC LIMIT 1)",
        );
        break;
      case "PAID":
        params.push(change.payoutEvidenceHash ?? null);
        sets.push("paid_at = kauro.server_now()", `payout_evidence_hash = $${params.length}`);
        break;
      case "CORRECTED":
        sets.push("corrected_at = kauro.server_now()");
        break;
      case "DRAFT":
      case "DISPUTED":
        break;
    }
    const r = await execute<{ statement_id: string }>(this.db, `UPDATE kauro.commission_statements s SET ${sets.join(", ")} WHERE s.statement_id = $1 AND s.version = $2 RETURNING s.statement_id`, params);
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.commission_statements WHERE statement_id = $1", statementId, "statement");
    const record = await this.getStatement(statementId);
    if (record === null) throw new DomainFailure("INTEGRITY_FAILURE", "a statement just transitioned is not readable by its writer");
    return { kind: "APPLIED", record };
  }

  // --- payouts -------------------------------------------------------------------------------------------------------------------------

  async payoutCash(): Promise<PayoutCash> {
    // one basis for the coverage check and the intent it licenses (D10-GAP-1): the caller holds its statement's row lock
    await lockPayoutCash(this.db);
    const bank = await execute<{ bank_available_cents: string }>(
      this.db,
      "SELECT bank_available_cents FROM kauro.settlements WHERE bank_evidence_hash IS NOT NULL ORDER BY observed_at DESC, settlement_id DESC LIMIT 1",
    );
    // unsettled: AUTHORIZED, SUBMITTED, UNCERTAIN; and a SETTLED intent until a bank-evidenced observation strictly newer than its
    // settlement is recorded: the paid transfer's debit is not in an older snapshot, so its cents stay claimed (B10G-R3)
    const claimed = await execute<{ cents: string }>(
      this.db,
      `SELECT coalesce(sum(p.amount_cents), 0)::text AS cents FROM kauro.payout_intents p
        WHERE p.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN')
           OR (p.state = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM kauro.settlements s WHERE s.bank_evidence_hash IS NOT NULL AND s.observed_at > p.settled_at))`,
    );
    return { bankAvailableCents: bank.rows[0] === undefined ? 0n : money(bank.rows[0].bank_available_cents), unsettledAuthorizedCents: money(claimed.rows[0]?.cents ?? "0") };
  }

  async unpayableLine(statementId: CommissionStatementId): Promise<CommissionLineId | null> {
    const r = await execute<{ line_id: string | null }>(this.db, "SELECT kauro.payout_lines_unpayable($1) AS line_id", [statementId]);
    const line = r.rows[0]?.line_id ?? null;
    return line === null ? null : (line as CommissionLineId);
  }

  /** The statement's row lock, taken before any intent of it is written or moved (design 10: statement, then payout intent, then line). */
  private async lockStatementRow(statementId: string): Promise<void> {
    await execute(this.db, "SELECT 1 FROM kauro.commission_statements WHERE statement_id = $1 FOR UPDATE", [statementId]);
  }

  async authorizeIntent(input: NewPayoutIntent): Promise<{ readonly authorized: boolean; readonly record: PayoutIntentRecord }> {
    const i = input.intent;
    await this.lockStatementRow(i.statementId);
    const inserted = await execute<IntentRow>(
      this.db,
      `INSERT INTO kauro.payout_intents (intent_id, statement_id, seller_id, amount_cents, currency, fee_bearer, destination_id, destination_version, destination_digest, reference, authorized_by_user_id,
         authorization_proof_ref, authorized_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, kauro.server_now(), now(), now()) ON CONFLICT DO NOTHING RETURNING ${INTENT}`,
      [i.intentId, i.statementId, i.sellerId, i.amountCents, i.currency, i.feeBearer, i.destinationId, i.destinationVersion, i.destinationDigest, i.reference, i.authorizedBy, i.authorizationProofId],
    );
    if (inserted.rows[0] !== undefined) return { authorized: true, record: intentRecord(inserted.rows[0]) };
    // one live intent per statement: the replayed row
    const live = await this.liveIntentOf(i.statementId);
    if (live === null) throw new DomainFailure("INTEGRITY_FAILURE", "an intent neither authorized nor found after its unique index refused it");
    return { authorized: false, record: live };
  }

  async getIntent(intentId: PayoutIntentId): Promise<PayoutIntentRecord | null> {
    const r = await execute<IntentRow>(this.db, `SELECT ${INTENT} FROM kauro.payout_intents WHERE intent_id = $1`, [intentId]);
    return r.rows[0] ? intentRecord(r.rows[0]) : null;
  }

  async liveIntentOf(statementId: CommissionStatementId): Promise<PayoutIntentRecord | null> {
    const r = await execute<IntentRow>(this.db, `SELECT ${INTENT} FROM kauro.payout_intents WHERE statement_id = $1 AND state IN ${LIVE_INTENT} ORDER BY authorized_at DESC LIMIT 1`, [statementId]);
    return r.rows[0] ? intentRecord(r.rows[0]) : null;
  }

  async transitionIntent(intentId: PayoutIntentId, expectedVersion: number, state: PayoutIntentState, _now: UtcInstant): Promise<VersionedWrite<PayoutIntentRecord>> {
    const owner = await execute<{ statement_id: string }>(this.db, "SELECT statement_id FROM kauro.payout_intents WHERE intent_id = $1", [intentId]);
    if (owner.rows[0] === undefined) throw new DomainFailure("NOT_FOUND", "the payout intent is not visible in this context");
    await this.lockStatementRow(owner.rows[0].statement_id);
    // the intent leaves (or re-enters) the unsettled set under the cash basis lock (D10-GAP-1)
    await lockPayoutCash(this.db);
    // SETTLED, FAILED and RETURNED keep the evidence of the matching reconciliation recorded for that kind (the database checks it at COMMIT)
    const r = await execute<IntentRow>(
      this.db,
      `UPDATE kauro.payout_intents p SET state = $3, version = p.version + 1,
         submitted_at = CASE WHEN $3 = 'SUBMITTED' THEN kauro.server_now() ELSE p.submitted_at END,
         settled_at = CASE WHEN $3 = 'SETTLED' THEN kauro.server_now() ELSE p.settled_at END,
         failed_at = CASE WHEN $3 = 'FAILED' THEN kauro.server_now() ELSE p.failed_at END,
         returned_at = CASE WHEN $3 = 'RETURNED' THEN kauro.server_now() ELSE p.returned_at END,
         evidence_hash = CASE WHEN $3 IN ('SETTLED', 'FAILED', 'RETURNED')
           THEN (SELECT x.evidence_hash FROM kauro.payout_reconciliations x WHERE x.intent_id = p.intent_id AND x.evidence_kind = $3 ORDER BY x.recorded_at DESC, x.reconciliation_id DESC LIMIT 1)
           ELSE p.evidence_hash END
       WHERE p.intent_id = $1 AND p.version = $2 RETURNING ${INTENT}`,
      [intentId, expectedVersion, state],
    );
    if (r.rows[0] === undefined) return staleRow(this.db, "SELECT version, state FROM kauro.payout_intents WHERE intent_id = $1", intentId, "payout intent");
    return { kind: "APPLIED", record: intentRecord(r.rows[0]) };
  }

  async recordReconciliation(reconciliation: PayoutReconciliationRecord): Promise<PayoutReconciliationRecord> {
    const e = reconciliation.evidence;
    const inserted = await execute<ReconciliationRow>(
      this.db,
      `INSERT INTO kauro.payout_reconciliations (reconciliation_id, intent_id, evidence_kind, evidence_hash, reference, destination_digest, amount_cents, currency, provider_ref, observed_at, recorded_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, kauro.server_now(), now()) ON CONFLICT (intent_id, evidence_hash) DO NOTHING RETURNING ${RECONCILIATION}`,
      [reconciliation.reconciliationId, reconciliation.intentId, e.status, e.evidenceHash, e.reference, e.destinationDigest, e.amountCents, e.currency, e.providerRef ?? null, e.observedAt],
    );
    if (inserted.rows[0] !== undefined) return reconciliationRecord(inserted.rows[0]);
    // the same authenticated evidence is recorded once
    const existing = await execute<ReconciliationRow>(this.db, `SELECT ${RECONCILIATION} FROM kauro.payout_reconciliations WHERE intent_id = $1 AND evidence_hash = $2`, [reconciliation.intentId, e.evidenceHash]);
    const row = existing.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a reconciliation neither recorded nor found after its unique index refused it");
    return reconciliationRecord(row);
  }

  async reconciliationsOf(intentId: PayoutIntentId): Promise<ReadonlyArray<PayoutReconciliationRecord>> {
    const r = await execute<ReconciliationRow>(this.db, `SELECT ${RECONCILIATION} FROM kauro.payout_reconciliations WHERE intent_id = $1 ORDER BY recorded_at, reconciliation_id`, [intentId]);
    return r.rows.map(reconciliationRecord);
  }

  // --- compensation guard reviews ------------------------------------------------------------------------------------------------------

  async recordGuardReview(review: CompensationGuardReviewRecord): Promise<CompensationGuardReviewRecord> {
    const inserted = await execute<ReviewRow>(
      this.db,
      `INSERT INTO kauro.compensation_guard_reviews (review_id, period_id, seller_id, statement_id, retainer_cents, commission_accrued_cents, attributable_net_service_cents, guard_bps, outcome, label, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, kauro.server_now()) ON CONFLICT (period_id, seller_id) DO NOTHING RETURNING ${REVIEW}`,
      [
        review.reviewId,
        review.periodId,
        review.sellerId,
        review.statementId ?? null,
        review.retainerCents,
        review.commissionAccruedCents,
        review.attributableNetServiceCents,
        review.guardBps,
        review.result,
        review.label,
      ],
    );
    if (inserted.rows[0] !== undefined) return reviewRecord(inserted.rows[0]);
    const existing = await execute<ReviewRow>(this.db, `SELECT ${REVIEW} FROM kauro.compensation_guard_reviews WHERE period_id = $1 AND seller_id = $2`, [review.periodId, review.sellerId]);
    const row = existing.rows[0];
    if (row === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a guard review neither recorded nor found after its unique index refused it");
    return reviewRecord(row);
  }

  async guardReviewsOf(periodId: CommissionPeriodId): Promise<ReadonlyArray<CompensationGuardReviewRecord>> {
    const r = await execute<ReviewRow>(this.db, `SELECT ${REVIEW} FROM kauro.compensation_guard_reviews WHERE period_id = $1 ORDER BY seller_id`, [periodId]);
    return r.rows.map(reviewRecord);
  }
}
