/**
 * CMD051 CloseCommissionPeriod — POST /api/v1/sales/commission-periods/{periodId}/close — COMMISSION_SERVICE — scope STORED_OPERATION —
 * no provider effect (design §7, §10, §12; decisions D10-STMT-1, D10-STMT-2, D10-STMT-4, D10-GUARD-1, D10-CAL-1, D10-NEG-1; registry
 * "issue an immutable statement with itemized basis, rates, adjustments, holds and payout date").
 *
 * One SERVICE unit of work of the commission group with no agency, after the service's access decision and its journal reservation:
 *  1. the period FOR UPDATE (NOT_FOUND; a CLOSED period UNLISTED_TRANSITION with its version and state) — a basis change holds the open
 *     periods FOR SHARE (D10-STMT-4), so a close and an adjustment serialize on it;
 *  2. its dates: an undated period is dated now from the calendar version BankingCalendarSource answers for the server's instant
 *     (CALENDAR_UNAVAILABLE when none, or when it does not cover the 10th banking day), recorded in banking_calendars and stored with its
 *     source (D10-CAL-1); then the period due — its close date reached on the server's clock in America/Bogota (PERIOD_NOT_DUE);
 *  3. its inputs reconciled: no COMMISSIONS outbox record created before the period's end still undelivered (INPUTS_UNRECONCILED; an
 *     unobservable count is unreconciled, never zero);
 *  4. the ledger it proposes to close: KAURO_COMMISSION_CUTOFF_V1 over every line existing at the close, with its adjustments and holds,
 *     for the period's end, equal to ledgerCutoffHash (STALE_VERSION LEDGER_CHANGED otherwise: the proposal is recomputed, never re-cut);
 *  5. one immutable ISSUED statement per seller with items (composeStatement: ELIGIBLE lines PAYABLE net of their partial holds, lines
 *     awaiting their final completion or funds and HELD lines as reasoned hold items, adjustments not reported before, offsets and the
 *     owner's recovery items of a negative position), dated by the period and labelled SIMULATED on a TEST_FIXTURE calendar; each PAYABLE
 *     item's line ELIGIBLE → PAYABLE (statement_closed);
 *  6. the owner's compensation-guard review of each seller (retainer of the agreement in force, commission accrued and attributable net
 *     service of the statement's lines): recorded, never a refusal (D10-GUARD-1, R2-105);
 *  7. the period CLOSED with the hash it closed on. Corporate aggregates publish no event (D10-EVT-1).
 */
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import type {
  BankingCalendarVersionId,
  CommerceUnitOfWork,
  CommissionLineRecord,
  CommissionPeriodId,
  CommissionPeriodRecord,
  CommissionStatementId,
  CompensationGuardReviewRecord,
  GuardReviewId,
  PeriodInputs,
  SellerId,
  StatementItemId,
  StatementRepository,
} from "@kauro/domain";
import { COMPENSATION_PLANNING_GUARD_BPS, DomainFailure, NotFoundFailure, commissionCutoffHash, commissionPeriodOf, compensationGuard, composeStatement, roundHalfUpBps } from "@kauro/domain";
import type { CommandResult } from "../../api/envelope.js";
import { applied } from "../agency/shared.js";
import type { CloseCommissionPeriodBody } from "../contracts.js";
import type { CommissionPeriodView, PeriodCloseView } from "../views.js";
import type { StatementServiceRuntime } from "./runtime.js";
import { runServiceCommand, type ServiceCommandRequest } from "./service.js";

/** Where the reported adjustments of a close start: every adjustment no earlier statement reported is this close's (D10-STMT-4). */
const BEGINNING = "1970-01-01T00:00:00.000Z" as UtcInstant;

/** The calendar date of an instant in a zone (YYYY-MM-DD), as a person there reads it. */
export function calendarDateIn(instant: UtcInstant, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

/** The period view (D10-API-1): its dates, the calendar version they came from and whether that calendar was the test fixture. */
export function periodView(period: CommissionPeriodRecord, calendarVersion: string): CommissionPeriodView {
  if (period.closeDueOn === undefined || period.payDueOn === undefined || period.calendarSource === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "an undated period has no view");
  return {
    periodId: period.periodId,
    version: period.version,
    periodStart: period.startsAt,
    periodEnd: period.endsAt,
    state: period.state,
    closeDueOn: period.closeDueOn,
    payDueOn: period.payDueOn,
    calendarVersion,
    calendarSource: period.calendarSource,
    simulated: period.calendarSource === "TEST_FIXTURE",
  };
}

/** The ledger a close of `period` computes over at `at`: every row existing then, hashed for the period's end (D10-STMT-4). */
export interface CloseProposal {
  readonly cutoffAt: UtcInstant;
  readonly ledgerCutoffHash: Sha256Hex;
  readonly inputs: PeriodInputs;
}

/**
 * The proposal of a close (the PERIODS sweep's, and the one CMD051 recomputes): the rows of every line created before `at` with their
 * adjustments and holds, and KAURO_COMMISSION_CUTOFF_V1 over them for the period's end. A row that changes between the proposal and the
 * close changes the hash, so the close is of exactly the ledger that was proposed.
 */
export async function proposeCommissionClose(statements: StatementRepository, period: CommissionPeriodRecord, at: UtcInstant): Promise<CloseProposal> {
  const inputs = await statements.periodInputs(period.periodId, at);
  const ledgerCutoffHash = commissionCutoffHash({ periodId: period.periodId, cutoffAt: period.endsAt, lines: inputs.lines, adjustments: inputs.adjustments, holds: inputs.holds });
  return { cutoffAt: period.endsAt, ledgerCutoffHash, inputs };
}

/** The attributable net service of a line: its basis at the beneficiary's share, rounded half up once (B09's kernel). */
function attributableOf(line: CommissionLineRecord): bigint {
  return roundHalfUpBps(line.netServiceBasisCents, line.shareBps);
}

/** Dates an undated period from the calendar version the source answers now; the period as stored, with the version's label. */
async function datedPeriod(rt: StatementServiceRuntime, uow: CommerceUnitOfWork, period: CommissionPeriodRecord, now: UtcInstant): Promise<{ readonly period: CommissionPeriodRecord; readonly calendarVersion: string }> {
  const statements = rt.statements(uow);
  if (period.calendarVersionId !== undefined) {
    const calendar = await statements.getCalendar(period.calendarVersionId);
    if (calendar === null) throw new DomainFailure("INTEGRITY_FAILURE", "a dated period's calendar version is not readable");
    return { period, calendarVersion: calendar.calendarVersion };
  }
  const unavailable = (): DomainFailure => new DomainFailure("PRECONDITION_FAILED", "no recorded banking calendar version covers the period's close and pay dates", { reason: "CALENDAR_UNAVAILABLE" });
  const current = await rt.calendar.currentCalendar(uow, { jurisdiction: "CO", at: now });
  if (current === null) throw unavailable();
  const dates = commissionPeriodOf(period.month, rt.policy, current);
  if (dates.closeDueOn === null || dates.payDueOn === null) throw unavailable();
  const recorded = await statements.recordCalendar({ ...current, calendarVersionId: uow.ids.next() as BankingCalendarVersionId });
  const dated = applied(await statements.datePeriod(period.periodId, period.version, { calendarVersionId: recorded.calendarVersionId, calendarSource: recorded.source, closeDueOn: dates.closeDueOn, payDueOn: dates.payDueOn }, now));
  return { period: dated, calendarVersion: recorded.calendarVersion };
}

export function closeCommissionPeriod(rt: StatementServiceRuntime, request: ServiceCommandRequest<CloseCommissionPeriodBody>): Promise<CommandResult<PeriodCloseView>> {
  const periodId = request.path["periodId"] as CommissionPeriodId;
  return runServiceCommand<CloseCommissionPeriodBody, PeriodCloseView>(rt, {
    command: "CMD051",
    role: "COMMISSION_SERVICE",
    request,
    versionOf: (view) => view.period.version,
    async body(uow, now) {
      const statements = rt.statements(uow);
      const ledger = rt.ledger(uow);
      const sales = rt.sales(uow);
      // 1. the period, locked: a basis change waits for the close, or the close for it (D10-STMT-4)
      const locked = await statements.lockPeriod(periodId);
      if (locked === null) throw new NotFoundFailure("commission_period");
      if (locked.state !== "OPEN") {
        throw new DomainFailure("PRECONDITION_FAILED", "the period is already CLOSED", { reason: "UNLISTED_TRANSITION", currentVersion: locked.version, currentState: locked.state });
      }
      // 2. dated and due
      const { period, calendarVersion } = await datedPeriod(rt, uow, locked, now);
      const today = calendarDateIn(now, rt.policy.operationalTimeZone);
      if (period.closeDueOn === undefined || today < period.closeDueOn) {
        throw new DomainFailure("PRECONDITION_FAILED", `the period's close is due on ${String(period.closeDueOn)}`, { reason: "PERIOD_NOT_DUE", currentVersion: period.version, currentState: period.state });
      }
      // 3. its inputs reconciled: every COMMISSIONS record of the period delivered
      const before = await statements.periodInputs(period.periodId, period.endsAt);
      if (before.undeliveredBeforeCutoff === null || before.undeliveredBeforeCutoff > 0) {
        throw new DomainFailure("PRECONDITION_FAILED", "a COMMISSIONS input of the period is not yet delivered", { reason: "INPUTS_UNRECONCILED", currentVersion: period.version, currentState: period.state });
      }
      // 4. the proposed ledger, read under the row locks of its lines (D10-GAP-4): a hold, an eligibility or a payout move that is in flight
      //    on one of them is waited for and read, so the hash is of the ledger the statements are composed from and no hold committed after
      //    the reads can reach a line this close then makes PAYABLE (a hold insert takes the line's key-share lock and waits for the close)
      const read = await proposeCommissionClose(statements, period, now);
      for (const lineId of read.inputs.lines.map((l) => l.lineId).sort()) await ledger.lockLine(lineId);
      const proposal = await proposeCommissionClose(statements, period, now);
      if (proposal.ledgerCutoffHash !== request.body.ledgerCutoffHash) {
        throw new DomainFailure("STALE_VERSION", "the ledger changed since the close was proposed", { reason: "LEDGER_CHANGED", currentVersion: period.version, currentState: period.state });
      }
      // 5. one statement per seller with items
      const reported = await rt.reads.reportedAdjustments(uow);
      const rows = { ...proposal.inputs, adjustments: proposal.inputs.adjustments.filter((a) => !reported.has(a.adjustmentId)) };
      const sellers = [...new Set(rows.lines.map((l) => l.sellerId))].sort();
      const lines = new Map(rows.lines.map((l) => [l.lineId, l] as const));
      let statementCount = 0;
      let payableTotal = 0n;
      let heldTotal = 0n;
      let guardsExceeded = 0;
      if (period.calendarVersionId === undefined || period.calendarSource === undefined || period.closeDueOn === undefined || period.payDueOn === undefined) throw new DomainFailure("INTEGRITY_FAILURE", "a period closes dated");
      for (const sellerId of sellers) {
        const composed = composeStatement({ sellerId: sellerId as SellerId, periodStartsAt: BEGINNING, cutoffAt: now, rows });
        if (composed.items.length === 0) continue;
        const statementId = uow.ids.next() as CommissionStatementId;
        const issued = await statements.issueStatement({
          statement: {
            statementId,
            periodId: period.periodId,
            sellerId: sellerId as SellerId,
            periodStart: period.startsAt,
            periodEnd: period.endsAt,
            lineIds: composed.lineIds,
            accruedPendingCents: composed.accruedPendingCents,
            heldCents: composed.heldCents,
            payableCents: composed.payableCents,
            paidToDateCents: composed.paidToDateCents,
            negativeBalanceCents: composed.negativeBalanceCents,
            calendarVersionId: period.calendarVersionId,
            calendarSource: period.calendarSource,
            label: period.calendarSource === "TEST_FIXTURE" ? "SIMULATED" : "VERIFIED_CALENDAR",
            statementDate: period.closeDueOn,
            payDueOn: period.payDueOn,
            cutoffHash: proposal.ledgerCutoffHash,
          },
          items: composed.items.map((item) => ({ ...item, itemId: uow.ids.next() as StatementItemId, statementId })),
        });
        if (!issued.issued) throw new DomainFailure("INTEGRITY_FAILURE", "a statement of this period and seller already exists while the period is OPEN");
        statementCount++;
        payableTotal += composed.payableCents;
        heldTotal += composed.heldCents;
        // statement_closed: each PAYABLE item's line becomes PAYABLE (the database checks the issued item names it)
        for (const item of composed.items) {
          if (item.kind !== "LINE" || item.disposition !== "PAYABLE" || item.lineId === undefined) continue;
          const line = await ledger.lockLine(item.lineId);
          if (line === null || line.state !== "ELIGIBLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable item's line is no longer ELIGIBLE under the period's lock");
          applied(await ledger.transitionLine(item.lineId, line.version, { state: "PAYABLE" }, now));
        }
        // the owner's compensation-guard review of the seller: recorded, never a refusal (D10-GUARD-1)
        const itemized = composed.lineIds.map((id) => lines.get(id)).filter((l): l is CommissionLineRecord => l !== undefined);
        const seller = await sales.getSeller(sellerId as SellerId);
        const agreement = seller?.activeAgreementId !== undefined ? await sales.getAgreement(seller.activeAgreementId) : null;
        const guard = compensationGuard({
          retainerCents: agreement?.retainerCentsPerMonth ?? 0n,
          commissionAccruedCents: itemized.reduce((sum, l) => sum + l.cumulativeEntitlementCents, 0n),
          attributableNetServiceCents: itemized.reduce((sum, l) => sum + attributableOf(l), 0n),
        });
        const review: CompensationGuardReviewRecord = {
          reviewId: uow.ids.next() as GuardReviewId,
          periodId: period.periodId,
          sellerId: sellerId as SellerId,
          statementId: issued.record.statementId,
          retainerCents: guard.retainerCents,
          commissionAccruedCents: guard.commissionAccruedCents,
          attributableNetServiceCents: guard.attributableNetServiceCents,
          guardBps: COMPENSATION_PLANNING_GUARD_BPS,
          ratioBps: guard.ratioBps,
          result: guard.result,
          label: guard.label,
          recordedAt: now,
        };
        await statements.recordGuardReview(review);
        if (guard.result === "EXCEEDS_PLANNING_GUARD") guardsExceeded++;
      }
      // 7. CLOSED with the hash it closed on
      const closed = applied(await statements.closePeriod(period.periodId, period.version, proposal.ledgerCutoffHash, now));
      const view: PeriodCloseView = {
        period: periodView(closed, calendarVersion),
        ledgerCutoffHash: proposal.ledgerCutoffHash,
        statementCount,
        payableTotalCents: payableTotal.toString() as PeriodCloseView["payableTotalCents"],
        heldTotalCents: heldTotal.toString() as PeriodCloseView["heldTotalCents"],
        guardReviewCount: guardsExceeded,
      };
      return { view, version: closed.version, resourceKind: "commission_period", resourceId: closed.periodId };
    },
  });
}
