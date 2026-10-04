/**
 * The period close's pure rules (design §7 CMD051; D10-STMT-1, D10-STMT-2, D10-HOLD-1, D10-NEG-1, D10-NEG-2; decision D10-STMT-3):
 * the ledger cutoff hash KAURO_COMMISSION_CUTOFF_V1 over the lines, adjustments and holds a close includes, and the composition of
 * one seller's statement from the rows the close reads at its cutoff (StatementRepository.periodInputs). Both are functions of the
 * rows alone, so the PERIODS sweep that proposes a close, CMD051 that recomputes it and the adapter that stores it answer the same.
 *
 * Money is `bigint` minor units and nothing is rounded here: every amount is a line's cumulative entitlement, paid cents, a hold's or
 * an offset's cents, each already rounded once by the ledger (commercial/ledger.ts over B09's kernel).
 */
import { canonicalBytes, rawDigest, type Sha256Hex, type UtcInstant } from "@kauro/contracts";
import type { CaptureId, FundsState } from "../commerce/records.js";
import type {
  CommissionAdjustmentRecord,
  CommissionHoldRecord,
  CommissionLineId,
  CommissionLineRecord,
  CommissionOffsetRecord,
  CommissionPeriodId,
  CommissionPoolRecord,
  OffsetTerms,
  PurchaseCompletionRecord,
  SellerAgreementId,
  SellerId,
  StatementItemRecord,
} from "./records.js";

// --- what a close reads (D10-STMT-3) -----------------------------------------------------------------------------------------

/** The offset terms of the agreement a line was earned under (its entitlement's agreement; D10-NEG-1, KC017). */
export interface LineOffsetTerms {
  readonly lineId: CommissionLineId;
  readonly agreementId: SellerAgreementId;
  readonly offsetTerms: OffsetTerms;
}

/** A capture's latest observed funds state (capture.funds_observed.v1; UNKNOWN when none was observed). */
export interface CaptureFunds {
  readonly captureId: CaptureId;
  readonly fundsState: FundsState;
}

/**
 * The ledger rows a period close reads at its cutoff: every commission line created before it, the adjustments, holds and offsets
 * recorded before it, the pools of those lines (the project and first-or-repeat an item names, D10-STMT-2), their purchases'
 * completions and captures' funds (why an accrued line awaits), and the offset terms of each line's agreement.
 */
export interface PeriodLedgerRows {
  readonly lines: ReadonlyArray<CommissionLineRecord>;
  readonly adjustments: ReadonlyArray<CommissionAdjustmentRecord>;
  readonly holds: ReadonlyArray<CommissionHoldRecord>;
  readonly pools: ReadonlyArray<CommissionPoolRecord>;
  readonly completions: ReadonlyArray<PurchaseCompletionRecord>;
  readonly funds: ReadonlyArray<CaptureFunds>;
  readonly offsets: ReadonlyArray<CommissionOffsetRecord>;
  readonly offsetTerms: ReadonlyArray<LineOffsetTerms>;
}

// --- the cutoff hash (CMD051 ledgerCutoffHash) ---------------------------------------------------------------------------------

export const COMMISSION_CUTOFF_DOMAIN = "KAURO_COMMISSION_CUTOFF_V1";

function byKey<T>(rows: ReadonlyArray<T>, key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * KAURO_COMMISSION_CUTOFF_V1: the canonical wrapper of reference/HASHING (as KAURO_PROSPECT_ORGANIZATION_V1) over the period, the
 * cutoff and, in id order, each included line's version, state, basis, cumulative entitlement and paid cents, each included
 * adjustment and each included hold's version, state and cents. Any change of an included row — a transition, an adjustment, a hold
 * opened or resolved — changes it, so a close proposed on one ledger and performed on another is refused LEDGER_CHANGED (CMD051).
 */
export function commissionCutoffHash(input: {
  readonly periodId: CommissionPeriodId;
  readonly cutoffAt: UtcInstant;
  readonly lines: ReadonlyArray<CommissionLineRecord>;
  readonly adjustments: ReadonlyArray<CommissionAdjustmentRecord>;
  readonly holds: ReadonlyArray<CommissionHoldRecord>;
}): Sha256Hex {
  const payload = {
    periodId: input.periodId,
    cutoffAt: input.cutoffAt,
    lines: byKey(input.lines, (l) => l.lineId).map((l) => ({
      lineId: l.lineId,
      version: l.version,
      state: l.state,
      netServiceBasisCents: l.netServiceBasisCents.toString(),
      cumulativeEntitlementCents: l.cumulativeEntitlementCents.toString(),
      paidCents: l.paidCents.toString(),
    })),
    adjustments: byKey(input.adjustments, (a) => a.adjustmentId).map((a) => ({
      adjustmentId: a.adjustmentId,
      lineId: a.commissionLineId,
      adjustmentSeq: a.adjustmentSeq,
      newCumulativeEntitlementCents: a.newCumulativeEntitlementCents.toString(),
    })),
    holds: byKey(input.holds, (h) => h.holdId).map((h) => ({
      holdId: h.holdId,
      lineId: h.lineId,
      version: h.version,
      state: h.state,
      amountCents: h.amountCents.toString(),
    })),
  };
  return rawDigest(canonicalBytes({ domain: COMMISSION_CUTOFF_DOMAIN, version: 1, payload }));
}

// --- the statement composition (D10-STMT-2) -----------------------------------------------------------------------------------

/** One item as composed: a statement item before its identity and statement are assigned. */
export type ComposedStatementItem = Omit<StatementItemRecord, "itemId" | "statementId">;

/** One seller's statement as composed at a cutoff: its items and the separate totals of example 21. */
export interface StatementComposition {
  readonly sellerId: SellerId;
  readonly items: ReadonlyArray<ComposedStatementItem>;
  /** The lines its LINE items name, in item order. */
  readonly lineIds: ReadonlyArray<CommissionLineId>;
  /** The unpaid cents of the seller's ACCRUED_PENDING lines (awaiting their final completion's 720 hours or their funds). */
  readonly accruedPendingCents: bigint;
  /** The sum of the items' held cents: partial holds of eligible lines and whole HELD lines. */
  readonly heldCents: bigint;
  /** The sum of the items' payable cents: eligible lines net of what they withhold and offset. */
  readonly payableCents: bigint;
  /** The cents settled payouts have paid on the seller's lines. */
  readonly paidToDateCents: bigint;
  /** What the seller's paid lines were paid beyond their current entitlement, less the offsets recorded against it. */
  readonly negativeBalanceCents: bigint;
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/**
 * The statement of one seller at a cutoff (§7 CMD051; D10-STMT-2): for each of its lines in creation order —
 *  - ELIGIBLE: a PAYABLE LINE item of its unpaid cents net of its OPEN holds and of the offsets recorded against it, and one HOLD item
 *    per OPEN hold withholding exactly its cents with reason and review date (R2-102); a line whose OPEN holds cover its whole unpaid
 *    amount is a HELD LINE item instead, never payable;
 *  - ACCRUED_PENDING: a LINE item AWAITING_FUNDS when its purchase has a FINAL completion but its capture's funds are not AVAILABLE,
 *    otherwise AWAITING_FINAL_COMPLETION (no FINAL completion yet, or its 720 hours still running) — a reasoned hold, never payable;
 *  - HELD: a HELD LINE item of its unpaid cents with the covering hold's reason and review date;
 *  - PAID or ADJUSTED below what was paid: one OFFSET item per offset recorded from it, and for the negative position left without
 *    SIGNED_FUTURE_OFFSET terms a RECOVERY item REPAYMENT_REVIEW for the owner (D10-NEG-1; example 7); nothing debits the seller;
 *  - PAYABLE (on an earlier statement awaiting its payout) and VOID lines are not itemized again;
 * and one REPORTED ADJUSTMENT item per adjustment of its lines created in [periodStartsAt, cutoffAt). Items are numbered from 1.
 */
export function composeStatement(input: {
  readonly sellerId: SellerId;
  readonly periodStartsAt: UtcInstant;
  readonly cutoffAt: UtcInstant;
  readonly rows: PeriodLedgerRows;
}): StatementComposition {
  const { rows, sellerId } = input;
  const from = Date.parse(input.periodStartsAt);
  const to = Date.parse(input.cutoffAt);
  const pools = new Map(rows.pools.map((p) => [p.poolId, p] as const));
  const funds = new Map(rows.funds.map((f) => [f.captureId, f.fundsState] as const));
  const terms = new Map(rows.offsetTerms.map((t) => [t.lineId, t.offsetTerms] as const));
  const lines = byKey(
    rows.lines.filter((l) => l.sellerId === sellerId),
    (l) => `${l.createdAt}|${l.lineId}`,
  );

  const items: ComposedStatementItem[] = [];
  const lineIds: CommissionLineId[] = [];
  let accruedPending = 0n;
  let negative = 0n;

  const push = (item: Omit<ComposedStatementItem, "itemNo" | "sellerId">): void => {
    items.push({ ...item, sellerId, itemNo: items.length + 1 });
  };

  for (const line of lines) {
    const pool = pools.get(line.poolId);
    if (pool === undefined) throw new RangeError(`the pool of line ${line.lineId} is not among the close's rows`);
    const context = {
      lineId: line.lineId,
      agencyId: pool.agencyId,
      projectId: pool.projectId,
      rateKind: pool.rateKind,
      basisCents: line.netServiceBasisCents,
      rateBps: line.rateBps,
      shareBps: line.shareBps,
      cumulativeCents: line.cumulativeEntitlementCents,
      previouslyPaidCents: line.paidCents,
    };
    const unpaid = line.cumulativeEntitlementCents - line.paidCents;
    const openHolds = byKey(
      rows.holds.filter((h) => h.lineId === line.lineId && h.state === "OPEN"),
      (h) => `${h.openedAt}|${h.holdId}`,
    );
    const heldOpen = sum(openHolds.map((h) => h.amountCents));

    switch (line.state) {
      case "ELIGIBLE": {
        const covering = openHolds[openHolds.length - 1];
        if (covering !== undefined && heldOpen >= unpaid) {
          push({ ...context, kind: "LINE", disposition: "HELD", heldCents: unpaid, holdReason: covering.reason, holdReviewAt: covering.reviewAt, offsetCents: 0n, payableCents: 0n });
          lineIds.push(line.lineId);
          break;
        }
        // the funds fence (D10-GAP-23): a line eligible under funds AVAILABLE is paid only while the capture's latest funds are AVAILABLE still; the
        // provider can hold them afterwards and no line edge goes back to HELD, so the statement itemizes it as the ACCRUED_PENDING branch does and
        // makes nothing of it PAYABLE (it stays ELIGIBLE and is itemized again at the next close)
        if (funds.get(line.captureId) !== "AVAILABLE") {
          push({ ...context, kind: "LINE", disposition: "AWAITING_FUNDS", heldCents: 0n, offsetCents: 0n, payableCents: 0n });
          lineIds.push(line.lineId);
          accruedPending += unpaid;
          break;
        }
        const offsetIn = sum(rows.offsets.filter((o) => o.againstLineId === line.lineId).map((o) => o.amountCents));
        const remaining = unpaid - heldOpen;
        const offset = offsetIn < remaining ? offsetIn : remaining;
        push({ ...context, kind: "LINE", disposition: "PAYABLE", heldCents: 0n, offsetCents: offset, payableCents: remaining - offset });
        lineIds.push(line.lineId);
        for (const hold of openHolds) {
          push({ ...context, kind: "HOLD", disposition: "HELD", holdId: hold.holdId, heldCents: hold.amountCents, holdReason: hold.reason, holdReviewAt: hold.reviewAt, offsetCents: 0n, payableCents: 0n });
        }
        break;
      }
      case "ACCRUED_PENDING": {
        const final = rows.completions.some((c) => c.purchaseId === line.purchaseId && c.kind === "FINAL");
        const available = funds.get(line.captureId) === "AVAILABLE";
        push({ ...context, kind: "LINE", disposition: final && !available ? "AWAITING_FUNDS" : "AWAITING_FINAL_COMPLETION", heldCents: 0n, offsetCents: 0n, payableCents: 0n });
        lineIds.push(line.lineId);
        accruedPending += unpaid;
        break;
      }
      case "HELD": {
        const covering = openHolds.find((h) => h.amountCents === unpaid) ?? openHolds[openHolds.length - 1];
        if (covering === undefined) throw new RangeError(`held line ${line.lineId} has no OPEN hold among the close's rows`);
        push({ ...context, kind: "LINE", disposition: "HELD", heldCents: unpaid, holdReason: covering.reason, holdReviewAt: covering.reviewAt, offsetCents: 0n, payableCents: 0n });
        lineIds.push(line.lineId);
        break;
      }
      case "PAID":
      case "ADJUSTED": {
        const position = line.paidCents - line.cumulativeEntitlementCents;
        if (position <= 0n) break;
        const offsetsOut = byKey(
          rows.offsets.filter((o) => o.negativeLineId === line.lineId),
          (o) => `${o.recordedAt}|${o.offsetId}`,
        );
        for (const o of offsetsOut) {
          push({ ...context, kind: "OFFSET", disposition: "REPORTED", offsetId: o.offsetId, heldCents: 0n, offsetCents: o.amountCents, payableCents: 0n });
        }
        const left = position - sum(offsetsOut.map((o) => o.amountCents));
        if (left > 0n) {
          negative += left;
          if (terms.get(line.lineId) !== "SIGNED_FUTURE_OFFSET") {
            push({ ...context, kind: "RECOVERY", disposition: "REPAYMENT_REVIEW", heldCents: 0n, offsetCents: 0n, payableCents: 0n });
          }
        }
        break;
      }
      case "PAYABLE":
      case "VOID":
        break;
    }

    const reported = byKey(
      rows.adjustments.filter((a) => a.commissionLineId === line.lineId && Date.parse(a.createdAt) >= from && Date.parse(a.createdAt) < to),
      (a) => String(a.adjustmentSeq).padStart(10, "0"),
    );
    for (const a of reported) {
      push({
        ...context,
        kind: "ADJUSTMENT",
        disposition: "REPORTED",
        adjustmentId: a.adjustmentId,
        cumulativeCents: a.newCumulativeEntitlementCents,
        adjustmentDirection: a.direction,
        adjustmentCents: a.amountCents,
        heldCents: 0n,
        offsetCents: 0n,
        payableCents: 0n,
      });
    }
  }

  return {
    sellerId,
    items,
    lineIds,
    accruedPendingCents: accruedPending,
    heldCents: sum(items.map((i) => i.heldCents)),
    payableCents: sum(items.map((i) => i.payableCents)),
    paidToDateCents: sum(lines.map((l) => l.paidCents)),
    negativeBalanceCents: negative,
  };
}
