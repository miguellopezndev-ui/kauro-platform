/**
 * CMD051 correcting statement (design platform machine CommissionStatement ISSUED or DISPUTED to CORRECTED on correction_issued, "a correcting statement
 * supersedes it"; design section 7 CMD051, section 8.2, not the registry; ruling R-GAP-3; decision D10-GAP-7) — COMMISSION_SERVICE — no route and no provider
 * effect.
 *
 * One SERVICE unit of work of the commission group with no agency, after the service's access decision and its journal reservation (the
 * pipeline of CMD051's close), in the lock order of design 10 (statement, then lines):
 *  1. the predecessor statement FOR UPDATE (NOT_FOUND); expectedVersion (STALE_VERSION: two corrections, or a correction and an approval,
 *     of one statement serialize on its row, the second finding the first's version); then ISSUED or DISPUTED (UNLISTED_TRANSITION: an
 *     APPROVED, PAID or CORRECTED statement has no edge to CORRECTED, so a CORRECTED one is never corrected twice and no live payout
 *     intent names a CORRECTED statement; a FAILED or RETURNED one keeps naming the statement CMD053 supersedes, D10-GAP-12);
 *  2. the lines of the predecessor (the input set it was composed from, recorded at its close and carried by every correction, and every
 *     line any of its items names; D10-GAP-15, D10-GAP-16) locked in ascending id, then the statement recomposed over exactly those lines
 *     from the ledger as it stands now (composeStatement), its own reported adjustments carried and its whole negative balance with them,
 *     a debt line no item names included (an input line no item names enters only PAID or ADJUSTED, for what it reports): a line PAYABLE through the predecessor (its payable owner, 0037) stays payable through the successor's
 *     item and the successor takes it over, a line owned by another statement (a pending or held line a later period made payable, PAID or
 *     not) is that statement's: recomposed in its own state, never payable through the successor (B10G-R1: one live payable item per line), a line released since
 *     that is ELIGIBLE again becomes PAYABLE (statement_closed), anything else is itemized by its state; a PAYABLE line that the
 *     recomposition would not keep payable (a covering hold opened since) refuses the correction (STALE_VERSION LEDGER_CHANGED) rather than
 *     leave a payable line outside every live statement item;
 *  3. the successor ISSUED with its items and totals (the period and seller of the predecessor, correctsStatementId naming it), then the
 *     predecessor CORRECTED in the same transaction (the database checks at COMMIT that a CORRECTED statement has its correcting one).
 * All of it is one COMMIT: a failure anywhere leaves the predecessor as it was and no successor. The compensation-guard review is the
 * period's (one per period and seller) and is not repeated.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommerceUnitOfWork, CommissionLineId, CommissionLineRecord, CommissionStatementId, CommissionStatementRecord, StatementItemId } from "@kauro/domain";
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
      // 1. the predecessor, locked
      const predecessor = await statements.lockStatement(statementId);
      if (predecessor === null) throw new NotFoundFailure("commission_statement");
      if (predecessor.version !== request.body.expectedVersion) throw new StaleVersionFailure(predecessor.version, predecessor.state, {});
      if (predecessor.state !== "ISSUED" && predecessor.state !== "DISPUTED") {
        throw new DomainFailure("PRECONDITION_FAILED", "only an ISSUED or DISPUTED statement is corrected", { reason: "UNLISTED_TRANSITION", currentVersion: predecessor.version, currentState: predecessor.state });
      }
      const { issued, corrected, successorId } = await supersedeStatement(rt, uow, predecessor, now);
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

/**
 * Steps 2 and 3 of the correction, under the predecessor's row lock taken by the caller (ISSUED or DISPUTED): the successor recomposed over
 * the predecessor's lines and ISSUED, the predecessor CORRECTED. CMD053 calls it too, on a FAILED or RETURNED payout (D10-GAP-12).
 */
export async function supersedeStatement(rt: StatementServiceRuntime, uow: CommerceUnitOfWork, predecessor: CommissionStatementRecord, now: UtcInstant) {
  const statements = rt.statements(uow);
  const ledger = rt.ledger(uow);
  const period = await statements.getPeriod(predecessor.periodId);
  if (period === null) throw new DomainFailure("INTEGRITY_FAILURE", "a statement's period is readable");
  // 2. its lines, locked in ascending id, and the statement recomposed over exactly them: the input set the predecessor was composed from
  // (its close's lines of the seller, carried unchanged by each correction, D10-GAP-16) and every line ANY item of it names (LINE, HOLD,
  // ADJUSTMENT, OFFSET, RECOVERY; D10-GAP-15), so a paid line it reports, or counts in its negative balance with no item naming it
  // (SIGNED_FUTURE_OFFSET terms, its adjustment reported earlier), is reported again by the successor with that balance (B10G-R9)
  const predecessorItems = await statements.itemsOf(predecessor.statementId);
  const itemized = new Set<string>(predecessor.lineIds);
  for (const i of predecessorItems) if (i.lineId !== undefined && i.lineId !== null) itemized.add(i.lineId);
  const named = new Set<string>([...itemized, ...predecessor.inputLineIds]);
  const locked = new Map<string, CommissionLineRecord>();
  for (const lineId of [...named].sort()) {
    const line = await ledger.lockLine(lineId as CommissionLineId);
    if (line !== null) locked.set(lineId, line);
  }
  // a line owned by another statement (PAYABLE through it, or PAID through it: 0037 keeps the owner) is never payable through the
  // successor nor taken over by it (B10G-R1, B10G-R8, D10-GAP-13): it is recomposed in its own state, so only what is reported of it
  // (its offsets, its recovery, the predecessor's own adjustments of it) is carried (D10-GAP-15)
  const ownedElsewhere = (id: string): boolean => {
    const l = locked.get(id);
    return l !== undefined && l.payableStatementId !== undefined && l.payableStatementId !== null && l.payableStatementId !== predecessor.statementId;
  };
  const inputs = await statements.periodInputs(period.periodId, now);
  // an input line no item of the predecessor names was not open at its close (an open line is always itemized): it enters only PAID or
  // ADJUSTED, for the balance and the adjustments it reports; one released or held since belongs to the statement that itemizes it or to
  // the next close, never to this successor
  const lines = inputs.lines.filter((l) => itemized.has(l.lineId) || (named.has(l.lineId) && (l.state === "PAID" || l.state === "ADJUSTED")));
  const included = new Set<string>(lines.map((l) => l.lineId as string));
  const payableBefore = new Set(lines.filter((l) => l.state === "PAYABLE" && !ownedElsewhere(l.lineId)).map((l) => l.lineId as string));
  // the adjustments live statements report (a CORRECTED statement's are its successor's): the predecessor's own are among them until it is
  // CORRECTED below, and are the successor's again; every other reported one stays with its statement
  const reported = await rt.reads.reportedAdjustments(uow);
  const own = new Set(predecessorItems.flatMap((i) => (i.adjustmentId === undefined || i.adjustmentId === null ? [] : [i.adjustmentId as string])));
  const rows = {
    ...inputs,
    // a line PAYABLE through the predecessor awaits this very payout: itemized again, as the ELIGIBLE line it was composed from
    lines: lines.map((l) => (payableBefore.has(l.lineId) ? { ...l, state: "ELIGIBLE" as const } : l)),
    adjustments: inputs.adjustments.filter((a) => included.has(a.commissionLineId) && (!reported.has(a.adjustmentId) || own.has(a.adjustmentId))),
  };
  const composed = composeStatement({ sellerId: predecessor.sellerId, periodStartsAt: BEGINNING, cutoffAt: now, rows });
  // every line of the predecessor may have gone on to another statement, or ended (PAID, ADJUSTED or VOID with nothing to report): the
  // successor then supersedes it with nothing to pay (D10-GAP-13); open lines that the recomposition drops entirely are an integrity fault
  const open = lines.filter((l) => !ownedElsewhere(l.lineId)).filter((l) => l.state === "ACCRUED_PENDING" || l.state === "ELIGIBLE" || l.state === "HELD" || l.state === "PAYABLE");
  if (composed.items.length === 0 && open.length > 0) throw new DomainFailure("INTEGRITY_FAILURE", "a statement that was issued with open lines itemizes none of them again");
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
      // the same input set as the predecessor's: a later correction recomposes over it again (D10-GAP-16)
      inputLineIds: predecessor.inputLineIds,
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
      cutoffHash: commissionCutoffHash({ periodId: period.periodId, cutoffAt: now, lines, adjustments: rows.adjustments, holds: inputs.holds.filter((h) => included.has(h.lineId)) }),
      correctsStatementId: predecessor.statementId,
    },
    items: composed.items.map((item) => ({ ...item, itemId: uow.ids.next() as StatementItemId, statementId: successorId })),
  });
  if (!issued.issued) throw new DomainFailure("INTEGRITY_FAILURE", "a correction of a locked ISSUED or DISPUTED statement already exists");
  // the successor takes over each line payable through the predecessor (the database allows only the correcting statement, KC019),
  // and statement_closed for each line released since: ELIGIBLE to PAYABLE through the successor (the database checks its item)
  for (const item of composed.items) {
    if (item.kind !== "LINE" || item.disposition !== "PAYABLE" || item.lineId === undefined) continue;
    const line = await ledger.lockLine(item.lineId);
    if (payableBefore.has(item.lineId)) {
      if (line === null || line.state !== "PAYABLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable line of the predecessor moved under the statement's lock");
      applied(await ledger.movePayableOwner(item.lineId, line.version, predecessor.statementId, successorId));
      continue;
    }
    if (line === null || line.state !== "ELIGIBLE") throw new DomainFailure("INTEGRITY_FAILURE", "a payable item's line is no longer ELIGIBLE under the statement's lock");
    applied(await ledger.transitionLine(item.lineId, line.version, { state: "PAYABLE", payableStatementId: successorId }, now));
  }
  const corrected = applied(await statements.transitionStatement(predecessor.statementId, predecessor.version, { state: "CORRECTED" }, now));
  return { issued, corrected, successorId };
}
