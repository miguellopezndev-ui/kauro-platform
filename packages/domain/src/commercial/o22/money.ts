/**
 * Seller money (CP-01.13, CP-01.05; candidate contracts SellerMoneySummary, StatementBalance, StatementBalanceItem of CP-02.09/.10):
 * the four figures of OPS-1 per seller and in total, the statement balance, and the monthly retainer.
 *
 * Collections, never invoices. A collection counts in the period its capture was confirmed (the commission pool is born at the capture's
 * durable confirmation, policy windowAnchor FIRST_DURABLE_CAPTURE_CONFIRMATION, so a pool's basis history starts there) and a refund in
 * the period it happened (the basis change the ledger recorded then); an earlier period is never rewritten. Tax and excess are never basis
 * (commission.base), one capture is counted once — even when an acquisition and an assistance pool both commission it — and a split pool's
 * shares are applied once. Earned, held, payable and paid are kept apart.
 *
 * Every amount is `bigint` minor units. The per-period figures are signed: a refund in a later period than its collection lowers the later
 * period, which may go below zero; the candidate contract carries only non-negative strings, so `moneySummaryView` refuses a negative
 * figure rather than misreport it (recorded as a contract gap in docs/design/ORDER22-SELLER-MONEY.md).
 */
import { roundHalfUpBps } from "../../commerce/money.js";
import { O22Failure } from "./failure.js";
import { COLLECTION_PERIOD_RULE, REFUND_PERIOD_RULE, RETAINER_DEFAULT_CENTS_PER_MONTH } from "./policy.js";

export interface Period {
  /** Inclusive. */
  readonly startsAt: string;
  /** Exclusive. */
  readonly endsAt: string;
}

/** One change of a pool's basis: its birth (previous null) or a fall recorded by the ledger (refund, reversal). */
export interface PoolBasisChange {
  readonly poolId: string;
  readonly captureId: string;
  readonly source: "ACQUISITION" | "ASSISTANCE";
  readonly previousBasisCents: bigint | null;
  readonly newBasisCents: bigint;
  readonly changedAt: string;
}

export interface MoneyLine {
  readonly lineId: string;
  readonly sellerId: string;
  readonly poolId: string;
  readonly captureId: string;
  readonly shareBps: number;
  /** The line's first posting (its accrual before any adjustment). */
  readonly previousPostedCents: bigint;
  readonly cumulativeEntitlementCents: bigint;
  readonly paidCents: bigint;
  readonly state: "ACCRUED_PENDING" | "ELIGIBLE" | "HELD" | "PAYABLE" | "PAID" | "ADJUSTED" | "VOID";
  readonly createdAt: string;
}

export interface MoneyAdjustment {
  readonly adjustmentId: string;
  readonly lineId: string;
  readonly direction: "INCREASE" | "DECREASE";
  readonly amountCents: bigint;
  readonly createdAt: string;
}

export interface MoneyHold {
  readonly lineId: string;
  readonly amountCents: bigint;
  readonly state: "OPEN" | "RELEASED" | "UPHELD";
}

export interface MoneyOffset {
  readonly offsetId: string;
  readonly sellerId: string;
  readonly againstLineId: string;
  readonly amountCents: bigint;
  readonly recordedAt: string;
}

export interface MoneyOffsetRelease {
  readonly offsetId: string;
  readonly sellerId: string;
  readonly amountCents: bigint;
  readonly recordedAt: string;
}

export interface MoneyPayout {
  readonly sellerId: string;
  readonly amountCents: bigint;
  readonly state: string;
  readonly settledAt: string | null;
}

export interface SellerMoneyRows {
  readonly basis: ReadonlyArray<PoolBasisChange>;
  readonly lines: ReadonlyArray<MoneyLine>;
  readonly adjustments: ReadonlyArray<MoneyAdjustment>;
  readonly holds: ReadonlyArray<MoneyHold>;
  readonly offsets: ReadonlyArray<MoneyOffset>;
  readonly releases: ReadonlyArray<MoneyOffsetRelease>;
  readonly payouts: ReadonlyArray<MoneyPayout>;
  /** Each capture's latest observed funds (capture_funds_observations); a capture without one is not AVAILABLE. */
  readonly funds: ReadonlyArray<{ readonly captureId: string; readonly fundsState: "HELD" | "AVAILABLE" }>;
  /** A settled line's seller credit not yet itemized (recognized less itemized, 0057): what the next statement pays as a CREDIT item. */
  readonly credit: ReadonlyArray<{ readonly lineId: string; readonly dueCents: bigint }>;
}

/** The signed figures of one seller (or of the total, sellerId null) over one period, and the as-of amounts. */
export interface SellerMoneyFigures {
  readonly sellerId: string | null;
  readonly period: Period;
  readonly netAttributableRevenueCents: bigint;
  readonly commissionGeneratedCents: bigint;
  readonly commissionHeldCents: bigint;
  readonly commissionPayableCents: bigint;
  readonly commissionPendingCents: bigint;
  readonly commissionPaidCents: bigint;
  readonly refundOffsetCents: bigint;
}

const inPeriod = (at: string, p: Period): boolean => {
  const t = Date.parse(at);
  return t >= Date.parse(p.startsAt) && t < Date.parse(p.endsAt);
};

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** A pool's basis history in time order, checked: born once, then only falls, each change starting where the previous ended. */
function poolHistories(basis: ReadonlyArray<PoolBasisChange>): ReadonlyMap<string, ReadonlyArray<PoolBasisChange>> {
  const byPool = new Map<string, PoolBasisChange[]>();
  for (const c of basis) {
    const list = byPool.get(c.poolId) ?? [];
    list.push(c);
    byPool.set(c.poolId, list);
  }
  for (const [poolId, list] of byPool) {
    list.sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt) || (a.previousBasisCents === null ? -1 : b.previousBasisCents === null ? 1 : 0));
    if (list[0]?.previousBasisCents !== null) throw new RangeError(`pool ${poolId} has no birth in its basis history`);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as PoolBasisChange;
      const cur = list[i] as PoolBasisChange;
      if (cur.previousBasisCents !== prev.newBasisCents) throw new RangeError(`pool ${poolId}'s basis history is broken at ${cur.changedAt}`);
      if (cur.newBasisCents > (cur.previousBasisCents as bigint)) throw new RangeError(`pool ${poolId}'s basis rose at ${cur.changedAt}`);
    }
  }
  return byPool;
}

/**
 * The net collected service a share of a pool attributes in a period: the shared basis at birth if born in the period, less each fall
 * recorded in the period, each measured through the same share (half up once on the cumulative basis, so the falls of every period add up
 * exactly to the share of what was finally kept: nothing is lost or counted twice by rounding across periods).
 */
function attributedInPeriod(history: ReadonlyArray<PoolBasisChange>, shareBps: number, period: Period): bigint {
  let total = 0n;
  for (const c of history) {
    if (!inPeriod(c.changedAt, period)) continue;
    const after = roundHalfUpBps(c.newBasisCents, shareBps);
    total += c.previousBasisCents === null ? after : after - roundHalfUpBps(c.previousBasisCents, shareBps);
  }
  return total;
}

/** For one capture, the pool that measures it: its ACQUISITION pool, else its smallest pool id (assistance pools share the capture's basis). */
function measuringPool(pools: ReadonlyArray<PoolBasisChange>): PoolBasisChange {
  const sorted = [...pools].sort((a, b) => (a.source === b.source ? (a.poolId < b.poolId ? -1 : 1) : a.source === "ACQUISITION" ? -1 : 1));
  return sorted[0] as PoolBasisChange;
}

/** The as-of amounts of a set of lines: held (accruing, held, and OPEN holds) and payable (eligible or payable, net of holds and live offsets). */
/**
 * Held and payable as of now, classified exactly as the period close itemizes the same lines (statements.ts composeStatement): an
 * ELIGIBLE line covered by its OPEN holds is held; one whose capture's funds are not AVAILABLE awaits its funds (held, never payable);
 * otherwise it pays its unpaid cents net of holds and live offsets; a PAID or ADJUSTED line pays its seller credit not yet itemized.
 */
function asOf(lines: ReadonlyArray<MoneyLine>, rows: SellerMoneyRows): { held: bigint; payable: bigint } {
  let held = 0n;
  let payable = 0n;
  const funds = new Map(rows.funds.map((f) => [f.captureId, f.fundsState] as const));
  const credit = new Map(rows.credit.map((c) => [c.lineId, c.dueCents] as const));
  const liveOffset = new Map<string, bigint>();
  const released = new Map<string, bigint>();
  for (const r of rows.releases) released.set(r.offsetId, (released.get(r.offsetId) ?? 0n) + r.amountCents);
  for (const o of rows.offsets) liveOffset.set(o.againstLineId, (liveOffset.get(o.againstLineId) ?? 0n) + o.amountCents - (released.get(o.offsetId) ?? 0n));
  for (const line of lines) {
    if (line.state === "PAID" || line.state === "ADJUSTED") {
      const due = credit.get(line.lineId) ?? 0n;
      if (due < 0n) throw new RangeError(`line ${line.lineId} itemizes more seller credit than it recognized`);
      payable += due;
      continue;
    }
    const unpaid = line.cumulativeEntitlementCents - line.paidCents;
    if (unpaid <= 0n) continue;
    switch (line.state) {
      case "ACCRUED_PENDING":
      case "HELD":
        held += unpaid;
        break;
      case "ELIGIBLE":
      case "PAYABLE": {
        const holds = sum(rows.holds.filter((h) => h.lineId === line.lineId && h.state === "OPEN").map((h) => h.amountCents));
        // the close's funds fence (D10-GAP-23): an ELIGIBLE line not wholly held awaits its capture's funds unless they are AVAILABLE
        if (line.state === "ELIGIBLE" && holds < unpaid && funds.get(line.captureId) !== "AVAILABLE") {
          held += unpaid;
          break;
        }
        const h = holds < unpaid ? holds : unpaid;
        const offset = liveOffset.get(line.lineId) ?? 0n;
        if (offset > unpaid - h) throw new RangeError(`line ${line.lineId} carries offsets beyond what it can pay`);
        held += h;
        payable += unpaid - h - offset;
        break;
      }
      default:
        break;
    }
  }
  return { held, payable };
}

/**
 * The four figures of every seller with a line, and the total row, for one period (ListSellerMoney; GetMyMoney is the caller's own row
 * of the same computation over the caller's own rows). The total row is computed from the captures, never by adding the seller rows, so
 * a capture split between sellers or commissioned by two pools counts once.
 */
export function sellerMoney(rows: SellerMoneyRows, period: Period): { readonly sellers: ReadonlyArray<SellerMoneyFigures>; readonly total: SellerMoneyFigures } {
  if (Date.parse(period.endsAt) <= Date.parse(period.startsAt)) throw new RangeError("a period ends after it starts");
  const histories = poolHistories(rows.basis);
  const linesBySeller = new Map<string, MoneyLine[]>();
  for (const l of rows.lines) {
    const list = linesBySeller.get(l.sellerId) ?? [];
    list.push(l);
    linesBySeller.set(l.sellerId, list);
  }
  const adjustmentsByLine = new Map<string, MoneyAdjustment[]>();
  for (const a of rows.adjustments) {
    const list = adjustmentsByLine.get(a.lineId) ?? [];
    list.push(a);
    adjustmentsByLine.set(a.lineId, list);
  }
  const lineIds = new Set(rows.lines.map((l) => l.lineId));
  for (const a of rows.adjustments) if (!lineIds.has(a.lineId)) throw new RangeError(`adjustment ${a.adjustmentId} names a line outside the rows`);

  const generatedOf = (lines: ReadonlyArray<MoneyLine>): bigint => {
    let g = 0n;
    for (const l of lines) {
      if (inPeriod(l.createdAt, period)) g += l.previousPostedCents;
      for (const a of adjustmentsByLine.get(l.lineId) ?? []) if (inPeriod(a.createdAt, period)) g += a.direction === "INCREASE" ? a.amountCents : -a.amountCents;
    }
    return g;
  };
  const offsetsOf = (sellerId: string | null): bigint =>
    sum(rows.offsets.filter((o) => (sellerId === null || o.sellerId === sellerId) && inPeriod(o.recordedAt, period)).map((o) => o.amountCents)) -
    sum(rows.releases.filter((r) => (sellerId === null || r.sellerId === sellerId) && inPeriod(r.recordedAt, period)).map((r) => r.amountCents));
  const paidOf = (sellerId: string | null): bigint =>
    sum(rows.payouts.filter((p) => (sellerId === null || p.sellerId === sellerId) && p.state === "SETTLED" && p.settledAt !== null && inPeriod(p.settledAt, period)).map((p) => p.amountCents));

  const sellers: SellerMoneyFigures[] = [];
  for (const sellerId of [...linesBySeller.keys()].sort()) {
    const lines = linesBySeller.get(sellerId) as MoneyLine[];
    // one capture once per seller: the line of the capture's measuring pool, else the seller's line of the smallest pool id
    const byCapture = new Map<string, MoneyLine>();
    for (const l of [...lines].sort((a, b) => (a.poolId < b.poolId ? -1 : 1))) {
      const history = histories.get(l.poolId);
      if (history === undefined) throw new RangeError(`line ${l.lineId}'s pool has no basis history`);
      const current = byCapture.get(l.captureId);
      const source = (history[0] as PoolBasisChange).source;
      if (current === undefined || (source === "ACQUISITION" && (histories.get(current.poolId)?.[0] as PoolBasisChange).source !== "ACQUISITION")) byCapture.set(l.captureId, l);
    }
    let revenue = 0n;
    for (const l of byCapture.values()) revenue += attributedInPeriod(histories.get(l.poolId) as ReadonlyArray<PoolBasisChange>, l.shareBps, period);
    const { held, payable } = asOf(lines, rows);
    sellers.push({
      sellerId,
      period,
      netAttributableRevenueCents: revenue,
      commissionGeneratedCents: generatedOf(lines),
      commissionHeldCents: held,
      commissionPayableCents: payable,
      commissionPendingCents: held + payable,
      commissionPaidCents: paidOf(sellerId),
      refundOffsetCents: offsetsOf(sellerId),
    });
  }

  // the total: each capture once, measured whole through its measuring pool
  const poolsByCapture = new Map<string, PoolBasisChange[]>();
  for (const history of histories.values()) {
    const birth = history[0] as PoolBasisChange;
    const list = poolsByCapture.get(birth.captureId) ?? [];
    list.push(birth);
    poolsByCapture.set(birth.captureId, list);
  }
  let totalRevenue = 0n;
  for (const [captureId, births] of poolsByCapture) {
    const firstBasis = births[0]?.newBasisCents;
    if (births.some((b) => b.newBasisCents !== firstBasis)) throw new RangeError(`the pools of capture ${captureId} disagree on its basis`);
    totalRevenue += attributedInPeriod(histories.get(measuringPool(births).poolId) as ReadonlyArray<PoolBasisChange>, 10_000, period);
  }
  const all = asOf(rows.lines, rows);
  const total: SellerMoneyFigures = {
    sellerId: null,
    period,
    netAttributableRevenueCents: totalRevenue,
    commissionGeneratedCents: generatedOf(rows.lines),
    commissionHeldCents: all.held,
    commissionPayableCents: all.payable,
    commissionPendingCents: all.held + all.payable,
    commissionPaidCents: paidOf(null),
    refundOffsetCents: offsetsOf(null),
  };
  return { sellers, total };
}

/** The candidate SellerMoneySummary of one row (strings of minor units, the rules in force, USD, database time). */
export interface SellerMoneySummaryView {
  readonly sellerId?: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly netAttributableRevenueCents: string;
  readonly commissionGeneratedCents: string;
  readonly commissionPendingCents: string;
  readonly commissionHeldCents: string;
  readonly commissionPayableCents: string;
  readonly commissionPaidCents: string;
  readonly refundOffsetCents: string;
  readonly collectionPeriodRule: string;
  readonly refundPeriodRule: string;
  readonly currency: "USD";
  readonly computedAt: string;
}

/** Projects figures onto the candidate contract; a negative period figure is refused (FIGURE_NEGATIVE_IN_CANDIDATE_CONTRACT), never clipped. */
export function moneySummaryView(f: SellerMoneyFigures, computedAt: string): SellerMoneySummaryView {
  const money = (name: string, v: bigint): string => {
    if (v < 0n) throw new O22Failure("PRECONDITION_FAILED", "FIGURE_NEGATIVE_IN_CANDIDATE_CONTRACT", `${name} is ${v} in this period; the candidate SellerMoneySummary carries no negative amount`);
    return v.toString();
  };
  return {
    ...(f.sellerId === null ? {} : { sellerId: f.sellerId }),
    periodStart: f.period.startsAt,
    periodEnd: f.period.endsAt,
    netAttributableRevenueCents: money("netAttributableRevenueCents", f.netAttributableRevenueCents),
    commissionGeneratedCents: money("commissionGeneratedCents", f.commissionGeneratedCents),
    commissionPendingCents: money("commissionPendingCents", f.commissionPendingCents),
    commissionHeldCents: money("commissionHeldCents", f.commissionHeldCents),
    commissionPayableCents: money("commissionPayableCents", f.commissionPayableCents),
    commissionPaidCents: money("commissionPaidCents", f.commissionPaidCents),
    refundOffsetCents: money("refundOffsetCents", f.refundOffsetCents),
    collectionPeriodRule: COLLECTION_PERIOD_RULE,
    refundPeriodRule: REFUND_PERIOD_RULE,
    currency: "USD",
    computedAt,
  };
}

// --- the retainer (CP-01.05) -----------------------------------------------------------------------------------------------------------------

export interface RetainerAgreement {
  readonly agreementId: string;
  readonly sellerId: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly retainerCentsPerMonth: bigint;
  /** Null while unsigned: an unsigned agreement never sets a retainer. */
  readonly signedAt: string | null;
}

export interface RetainerDue {
  readonly sellerId: string;
  readonly monthStart: string;
  readonly amountCents: bigint;
  /** The signed agreement that sets the amount, or null for the default (USD 0.00). */
  readonly agreementId: string | null;
}

/**
 * The retainer a seller is owed for the month starting at `monthStart` (operational time zone): the amount of the signed agreement in
 * force at that instant — the latest signed before it, among those whose term covers it — else the default USD 0.00. Only an agreement
 * signed at or before the month's start governs it, so a later signature never rewrites an earlier month (an accrued obligation is never
 * removed: the accrual table is append-only and this rule is applied once per month).
 */
export function retainerDue(sellerId: string, monthStart: string, agreements: ReadonlyArray<RetainerAgreement>): RetainerDue {
  const at = Date.parse(monthStart);
  const inForce = agreements
    .filter((a) => a.sellerId === sellerId && a.signedAt !== null && Date.parse(a.signedAt) <= at && Date.parse(a.startsAt) <= at && (a.endsAt === null || at < Date.parse(a.endsAt)))
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || (a.agreementId < b.agreementId ? 1 : -1));
  const governing = inForce[0];
  if (governing === undefined) return { sellerId, monthStart, amountCents: RETAINER_DEFAULT_CENTS_PER_MONTH, agreementId: null };
  if (governing.retainerCentsPerMonth < 0n) throw new RangeError("a retainer is never negative");
  return { sellerId, monthStart, amountCents: governing.retainerCentsPerMonth, agreementId: governing.agreementId };
}

// --- the statement balance (CP-02.10) --------------------------------------------------------------------------------------------------------

/** A statement item as the balance reads it (statement_items). */
export interface BalanceStatementItem {
  readonly kind: "LINE" | "HOLD" | "OFFSET" | "RECOVERY" | "ADJUSTMENT" | "CREDIT";
  readonly lineId: string;
  readonly heldCents: bigint;
  readonly offsetCents: bigint;
  readonly payableCents: bigint;
}

export interface BalanceRetainerAccrual {
  readonly accrualId: string;
  readonly monthStart: string;
  readonly amountCents: bigint;
}

export interface StatementBalance {
  readonly earnedCents: bigint;
  readonly offsetCents: bigint;
  readonly retainerCents: bigint;
  readonly heldCents: bigint;
  readonly payableCents: bigint;
}

/**
 * payable = earned − offsets + retainer − held, each a sum of the statement's own items. An offset is counted once, from the line it is
 * applied against (LINE.offsetCents); the OFFSET item of the negative line reports the same cents from the other side and is never
 * subtracted again. A HOLD item withholds cents its LINE item already excludes from payable, so it is earned and held once.
 */
export function statementBalance(items: ReadonlyArray<BalanceStatementItem>, retainer: ReadonlyArray<BalanceRetainerAccrual>): StatementBalance {
  let earned = 0n;
  let offset = 0n;
  let held = 0n;
  let payable = 0n;
  for (const i of items) {
    if (i.heldCents < 0n || i.offsetCents < 0n || i.payableCents < 0n) throw new RangeError("a statement item carries no negative amount");
    switch (i.kind) {
      case "LINE":
      case "CREDIT":
        earned += i.payableCents + i.offsetCents + i.heldCents;
        offset += i.offsetCents;
        held += i.heldCents;
        payable += i.payableCents;
        break;
      case "HOLD":
        earned += i.heldCents;
        held += i.heldCents;
        break;
      default:
        // OFFSET, RECOVERY and ADJUSTMENT items report; they move no cents of this statement
        break;
    }
  }
  const months = new Set<string>();
  let retainerCents = 0n;
  for (const r of retainer) {
    if (months.has(r.monthStart)) throw new RangeError(`the retainer of ${r.monthStart} is accrued twice`);
    months.add(r.monthStart);
    if (r.amountCents < 0n) throw new RangeError("a retainer is never negative");
    retainerCents += r.amountCents;
  }
  const balance = { earnedCents: earned, offsetCents: offset, retainerCents, heldCents: held, payableCents: payable + retainerCents };
  if (balance.payableCents !== balance.earnedCents - balance.offsetCents + balance.retainerCents - balance.heldCents) throw new RangeError("the statement balance does not hold");
  return balance;
}
