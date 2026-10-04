/**
 * CMD051 correcting statement (design platform machine CommissionStatement ISSUED or DISPUTED to CORRECTED on correction_issued, "a correcting statement
 * supersedes it"; design section 7 CMD051, section 8.2, not the registry; ruling R-GAP-3; decision D10-GAP-7) — COMMISSION_SERVICE — no route and no provider
 * effect.
 *
 * One SERVICE unit of work of the commission group with no agency, after the service's access decision and its journal reservation (the
 * pipeline of CMD051's close), in the lock order of design 10 (statement, then lines):
 *  1. the predecessor statement FOR UPDATE (NOT_FOUND); expectedVersion (STALE_VERSION: two corrections, or a correction and an approval,
 *     of one statement serialize on its row, the second finding the first's version); then ISSUED or DISPUTED (UNLISTED_TRANSITION: an
 *     APPROVED, PAID or CORRECTED statement has no edge to CORRECTED, so a CORRECTED one is never corrected twice and no payout intent
 *     ever names a CORRECTED statement);
 *  2. the lines of the predecessor locked in ascending id, then the statement recomposed over exactly those lines from the ledger as it
 *     stands now (composeStatement): a line the predecessor made PAYABLE stays payable through the successor's item, a line released since
 *     that is ELIGIBLE again becomes PAYABLE (statement_closed), anything else is itemized by its state; a PAYABLE line that the
 *     recomposition would not keep payable (a covering hold opened since) refuses the correction (STALE_VERSION LEDGER_CHANGED) rather than
 *     leave a payable line outside every live statement item;
 *  3. the successor ISSUED with its items and totals (the period and seller of the predecessor, correctsStatementId naming it), then the
 *     predecessor CORRECTED in the same transaction (the database checks at COMMIT that a CORRECTED statement has its correcting one).
 * All of it is one COMMIT: a failure anywhere leaves the predecessor as it was and no successor. The compensation-guard review is the
 * period's (one per period and seller) and is not repeated.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommissionLineId, CommissionStatementId, StatementItemId } from "@kauro/domain";
import { DomainFailure, NotFoundFailure, StaleVersionFailure, commissionCutoffHash, composeStatement } from "@kauro/domain";
import type { CommandResult } from "../../api/envelope.js";
import { applied } from "../agency/shared.js";
import type { StatementCorrectionView } from "../views.js";
import { statementView } from "./get-statement.js";
import type { StatementServiceRuntime } from "./runtime.js";
import { runServiceCommand, type ServiceCommandRequest } from "./service.js";

/** The body of a correction: the version of the predecessor the performer read. */
export interface CorrectCommissionStatementBody {
  readonly expectedVersion: number;
}

const BEGINNING = "1970-01-01T00:00:00.000Z" as UtcInstant;

export function correctCommissionStatement(rt: StatementServiceRuntime, request: ServiceCommandRequest<CorrectCommissionStatementBody>): Promise<CommandResult<StatementCorrectionView>> {
  const statementId = request.path["statementId"] as CommissionStatementId;
  return runServiceCommand<CorrectCommissionStatementBody, StatementCorrectionView>(rt, {
    command: "CMD051",
    role: "COMMISSION_SERVICE",
    request,
    versionOf: (view) => view.statement.version,
    async body(uow, now) {
      const statements = rt.statements(uow);
      const ledger = rt.ledger(uow);
      // 1. the predecessor, locked
      const predecessor = await statements.lockStatement(statementId);
      if (predecessor === null) throw new NotFoundFailure("commission_statement");
      if (predecessor.version !== request.body.expectedVersion) throw new StaleVersionFailure(predecessor.version, predecessor.state, {});
      if (predecessor.state !== "ISSUED" && predecessor.state !== "DISPUTED") {
        throw new DomainFailure("PRECONDITION_FAILED", "only an ISSUED or DISPUTED statement is corrected", { reason: "UNLISTED_TRANSITION", currentVersion: predecessor.version, currentState: predecessor.state });
      }
      const period = await statements.getPeriod(predecessor.periodId);
      if (period === null) throw new DomainFailure("INTEGRITY_FAILURE", "a statement's period is readable");
      // 2. its lines, locked in ascending id, and the statement recomposed over exactly them
      const predecessorLines = new Set<string>(predecessor.lineIds);
      for (const lineId of [...predecessorLines].sort()) await ledger.lockLine(lineId as CommissionLineId);
      const inputs = await statements.periodInputs(period.periodId, now);
      const lines = inputs.lines.filter((l) => predecessorLines.has(l.lineId));
      const payableBefore = new Set(lines.filter((l) => l.state === "PAYABLE").map((l) => l.lineId as string));
      const reported = await rt.reads.reportedAdjustments(uow);
      const own = new Set((await statements.itemsOf(predecessor.statementId)).flatMap((i) => (i.adjustmentId === undefined ? [] : [i.adjustmentId as string])));
      const rows = {
        ...inputs,
        // a line of the predecessor that is PAYABLE awaits this very payout: itemized again, as the ELIGIBLE line it was composed from
        lines: lines.map((l) => (l.state === "PAYABLE" ? { ...l, state: "ELIGIBLE" as const } : l)),
        // the predecessor's own reported adjustments are the successor's again; every other reported one stays with its statement
        adjustments: inputs.adjustments.filter((a) => predecessorLines.has(a.commissionLineId) && (!reported.has(a.adjustmentId) || own.has(a.adjustmentId))),
      };
      const composed = composeStatement({ sellerId: predecessor.sellerId, periodStartsAt: BEGINNING, cutoffAt: now, rows });
      if (composed.items.length === 0) throw new DomainFailure("INTEGRITY_FAILURE", "a statement that was issued with lines itemizes none of them again");
      for (const lineId of payableBefore) {
        const item = composed.items.find((i) => i.kind === "LINE" && i.lineId === lineId);
        if (item === undefined || item.disposition !== "PAYABLE") {
          throw new DomainFailure("STALE_VERSION", "the ledger moved under the statement: a payable line would no longer be payable through its correction", { reason: "LEDGER_CHANGED", currentVersion: predecessor.version, currentState: predecessor.state });
        }
      }
      // 3. the successor ISSUED with its items, then the predecessor CORRECTED
      const successorId = uow.ids.next() as CommissionStatementId;
      const issued = await statements.issueStatement({
        statement: {
          statementId: successorId,
          periodId: period.periodId,
          sellerId: predecessor.sellerId,
          periodStart: predecessor.periodStart,
          periodEnd: predecessor.periodEnd,
          lineIds: composed.lineIds,
          accruedPendingCents: composed.accruedPendingCents,
          heldCents: composed.heldCents,
          payableCents: composed.payableCents,
          paidToDateCents: composed.paidToDateCents,
          negativeBalanceCents: composed.negativeBalanceCents,
          calendarVersionId: predecessor.calendarVersionId,
          calendarSource: predecessor.calendarSource,
          label: predecessor.label,
          statementDate: predecessor.statementDate,
          payDueOn: predecessor.payDueOn,
          cutoffHash: commissionCutoffHash({ periodId: period.periodId, cutoffAt: now, lines, adjustments: rows.adjustments, holds: inputs.holds.filter((h) => predecessorLines.has(h.lineId)) }),
          correctsStatementId: predecessor.statementId,
        },
        items: composed.items.map((item) => ({ ...item, itemId: uow.ids.next() as StatementItemId, statementId: successorId })),
      });
      if (!issued.issued) throw new DomainFailure("INTEGRITY_FAILURE", "a correction of a locked ISSUED or DISPUTED statement already exists");
      // statement_closed for each line released since: ELIGIBLE to PAYABLE (the database checks the issued item names it)
      for (const item of composed.items) {
        if (item.kind !== "LINE" || item.disposition !== "PAYABLE" || item.lineId === undefined || payableBefore.has(item.lineId)) continue;
        const line = await ledger.lockLine(item.lineId);
        if (line === null || line.state !== "ELIGIBLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable item's line is no longer ELIGIBLE under the statement's lock");
        applied(await ledger.transitionLine(item.lineId, line.version, { state: "PAYABLE" }, now));
      }
      const corrected = applied(await statements.transitionStatement(predecessor.statementId, predecessor.version, { state: "CORRECTED" }, now));
      const calendar = await statements.getCalendar(issued.record.calendarVersionId);
      const view: StatementCorrectionView = {
        correctedStatementId: corrected.statementId,
        correctedVersion: corrected.version,
        statement: statementView(issued.record, await statements.itemsOf(successorId), calendar?.calendarVersion ?? ""),
      };
      return { view, version: issued.record.version, resourceKind: "commission_statement", resourceId: successorId };
    },
  });
}
