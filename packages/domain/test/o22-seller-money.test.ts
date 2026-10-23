// Order 22 seller money (CP-01.13, CP-01.05; candidate SellerMoneySummary, StatementBalance): zero double counting, periods never
// rewritten, held/payable/paid kept apart, the retainer and the statement balance. Every expected amount is hand-computed here, never
// read back from the function under test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { o22 } from "../src/index.js";

const JAN: o22.Period = { startsAt: "2026-01-01T05:00:00.000Z", endsAt: "2026-02-01T05:00:00.000Z" };
const FEB: o22.Period = { startsAt: "2026-02-01T05:00:00.000Z", endsAt: "2026-03-01T05:00:00.000Z" };
const MAR: o22.Period = { startsAt: "2026-03-01T05:00:00.000Z", endsAt: "2026-04-01T05:00:00.000Z" };

const birth = (poolId: string, captureId: string, basis: bigint, at: string, source: "ACQUISITION" | "ASSISTANCE" = "ACQUISITION"): o22.PoolBasisChange => ({ poolId, captureId, source, previousBasisCents: null, newBasisCents: basis, changedAt: at });
const fall = (poolId: string, captureId: string, from: bigint, to: bigint, at: string, source: "ACQUISITION" | "ASSISTANCE" = "ACQUISITION"): o22.PoolBasisChange => ({ poolId, captureId, source, previousBasisCents: from, newBasisCents: to, changedAt: at });
const line = (lineId: string, sellerId: string, poolId: string, captureId: string, shareBps: number, posted: bigint, at: string, extra: Partial<o22.MoneyLine> = {}): o22.MoneyLine => ({
  lineId,
  sellerId,
  poolId,
  captureId,
  shareBps,
  previousPostedCents: posted,
  cumulativeEntitlementCents: posted,
  paidCents: 0n,
  state: "ACCRUED_PENDING",
  createdAt: at,
  ...extra,
});
const empty: o22.SellerMoneyRows = { basis: [], lines: [], adjustments: [], holds: [], offsets: [], releases: [], payouts: [], funds: [], credit: [] };
const available = (...captureIds: string[]): o22.SellerMoneyRows["funds"] => captureIds.map((captureId) => ({ captureId, fundsState: "AVAILABLE" as const }));

test("a capture split 60/40 counts once in the total and once per seller share; commission is generated once", () => {
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P1", "C1", 100_000n, "2026-01-10T15:00:00.000Z")],
    lines: [line("L1", "S-A", "P1", "C1", 6000, 6_000n, "2026-01-10T15:00:00.000Z"), line("L2", "S-B", "P1", "C1", 4000, 4_000n, "2026-01-10T15:00:00.000Z")],
  };
  const { sellers, total } = o22.sellerMoney(rows, JAN);
  assert.deepEqual(sellers.map((s) => [s.sellerId, s.netAttributableRevenueCents, s.commissionGeneratedCents]), [["S-A", 60_000n, 6_000n], ["S-B", 40_000n, 4_000n]]);
  assert.equal(total.netAttributableRevenueCents, 100_000n, "the total counts the capture once, not 200 000");
  assert.equal(total.commissionGeneratedCents, 10_000n);
});

test("an assistance pool on the same capture never counts the capture twice", () => {
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P1", "C1", 100_000n, "2026-01-10T15:00:00.000Z"), birth("P2", "C1", 100_000n, "2026-01-10T15:00:00.000Z", "ASSISTANCE")],
    lines: [line("L1", "S-A", "P1", "C1", 10_000, 10_000n, "2026-01-10T15:00:00.000Z"), line("L3", "S-A", "P2", "C1", 10_000, 2_000n, "2026-01-10T15:00:00.000Z"), line("L4", "S-C", "P2", "C1", 10_000, 0n, "2026-01-10T15:00:00.000Z")],
  };
  const { sellers, total } = o22.sellerMoney(rows, JAN);
  assert.equal(total.netAttributableRevenueCents, 100_000n);
  const a = sellers.find((s) => s.sellerId === "S-A") as o22.SellerMoneyFigures;
  assert.equal(a.netAttributableRevenueCents, 100_000n, "S-A's two lines on one capture count the capture once");
  assert.equal(a.commissionGeneratedCents, 12_000n, "both commissions are earned, each once");
});

test("the pools of one capture that disagree on its basis are refused, never summed", () => {
  const rows: o22.SellerMoneyRows = { ...empty, basis: [birth("P1", "C1", 100_000n, "2026-01-10T15:00:00.000Z"), birth("P2", "C1", 90_000n, "2026-01-10T15:00:00.000Z", "ASSISTANCE")] };
  assert.throws(() => o22.sellerMoney(rows, JAN), /disagree/);
});

test("a refund belongs to the month it happened; January is never rewritten", () => {
  const janRows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P1", "C1", 100_000n, "2026-01-10T15:00:00.000Z")],
    lines: [line("L1", "S-A", "P1", "C1", 6000, 6_000n, "2026-01-10T15:00:00.000Z"), line("L2", "S-B", "P1", "C1", 4000, 4_000n, "2026-01-10T15:00:00.000Z")],
  };
  const before = o22.sellerMoney(janRows, JAN);
  const afterRows: o22.SellerMoneyRows = {
    ...janRows,
    basis: [...janRows.basis, fall("P1", "C1", 100_000n, 70_000n, "2026-02-10T15:00:00.000Z"), birth("P9", "C9", 50_000n, "2026-02-12T15:00:00.000Z")],
    lines: [...janRows.lines, line("L9", "S-A", "P9", "C9", 10_000, 5_000n, "2026-02-12T15:00:00.000Z")],
    adjustments: [
      { adjustmentId: "A1", lineId: "L1", direction: "DECREASE", amountCents: 1_800n, createdAt: "2026-02-10T15:00:00.000Z" },
      { adjustmentId: "A2", lineId: "L2", direction: "DECREASE", amountCents: 1_200n, createdAt: "2026-02-10T15:00:00.000Z" },
    ],
  };
  const after = o22.sellerMoney(afterRows, JAN);
  const periodFigures = (f: o22.SellerMoneyFigures) => [f.netAttributableRevenueCents, f.commissionGeneratedCents, f.commissionPaidCents, f.refundOffsetCents];
  assert.deepEqual(periodFigures(after.total), periodFigures(before.total), "January's period figures are identical after February's refund");
  assert.deepEqual(after.sellers.map(periodFigures), before.sellers.map(periodFigures));
  assert.deepEqual(after.sellers.find((s) => s.sellerId === "S-A")?.netAttributableRevenueCents, 60_000n);
  const feb = o22.sellerMoney(afterRows, FEB);
  assert.equal(feb.total.netAttributableRevenueCents, 20_000n, "50 000 collected less 30 000 refunded in February");
  assert.equal(feb.total.commissionGeneratedCents, 2_000n, "5 000 earned less 3 000 adjusted in February");
  const b = feb.sellers.find((s) => s.sellerId === "S-B") as o22.SellerMoneyFigures;
  assert.equal(b.netAttributableRevenueCents, -12_000n, "S-B's February is the refund alone");
  assert.throws(() => o22.moneySummaryView(b, "2026-03-01T00:00:00.000Z"), (e: unknown) => e instanceof o22.O22Failure && e.reason === "FIGURE_NEGATIVE_IN_CANDIDATE_CONTRACT");
  const view = o22.moneySummaryView(feb.total, "2026-03-01T00:00:00.000Z");
  assert.equal(view.sellerId, undefined);
  assert.equal(view.netAttributableRevenueCents, "20000");
  assert.equal(view.collectionPeriodRule, "MONTH_OF_CONFIRMED_CAPTURE");
  assert.equal(view.refundPeriodRule, "MONTH_IN_WHICH_THE_REFUND_HAPPENED");
  assert.equal(view.currency, "USD");
});

test("rounding across periods: whatever the sequence of partial refunds, the periods add up to the share of what was kept", () => {
  let seed = 7;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let trial = 0; trial < 300; trial++) {
    const share = 1 + rnd(9_999);
    let basis = BigInt(1 + rnd(5_000_000));
    const times = [0, 1, 2, 3].map(() => Date.parse(FEB.startsAt) + rnd(55) * 86_400_000 + rnd(86_400_000)).sort((a, b) => a - b);
    const fixed: o22.PoolBasisChange[] = [birth("P", "C", basis, "2026-01-05T15:00:00.000Z")];
    for (const t of times) {
      const next = basis - BigInt(rnd(Number(basis) + 1));
      fixed.push(fall("P", "C", basis, next, new Date(t).toISOString()));
      basis = next;
    }
    const months = [JAN, FEB, MAR];
    const rows: o22.SellerMoneyRows = { ...empty, basis: fixed, lines: [line("L", "S", "P", "C", share, 0n, "2026-01-05T15:00:00.000Z")] };
    let totalSeller = 0n;
    let totalAll = 0n;
    for (const m of months) {
      const r = o22.sellerMoney(rows, m);
      totalSeller += (r.sellers[0] as o22.SellerMoneyFigures).netAttributableRevenueCents;
      totalAll += r.total.netAttributableRevenueCents;
    }
    const final = (fixed[fixed.length - 1] as o22.PoolBasisChange).newBasisCents;
    assert.equal(totalSeller, (final * BigInt(share) + 5_000n) / 10_000n, `trial ${trial}`);
    assert.equal(totalAll, final, `trial ${trial}`);
  }
});

test("a broken basis history is refused: no birth, a gap, or a rise", () => {
  assert.throws(() => o22.sellerMoney({ ...empty, basis: [fall("P", "C", 10n, 5n, "2026-01-05T15:00:00.000Z")] }, JAN), /no birth/);
  assert.throws(() => o22.sellerMoney({ ...empty, basis: [birth("P", "C", 10n, "2026-01-05T15:00:00.000Z"), fall("P", "C", 9n, 5n, "2026-01-06T15:00:00.000Z")] }, JAN), /broken/);
  assert.throws(() => o22.sellerMoney({ ...empty, basis: [birth("P", "C", 10n, "2026-01-05T15:00:00.000Z"), fall("P", "C", 10n, 15n, "2026-01-06T15:00:00.000Z")] }, JAN), /rose/);
});

test("a refund after payout and its offset: generated falls once, the offset is reported apart and lowers payable once", () => {
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P1", "C1", 60_000n, "2026-01-10T15:00:00.000Z"), fall("P1", "C1", 60_000n, 42_000n, "2026-02-10T15:00:00.000Z"), birth("P2", "C2", 50_000n, "2026-03-03T15:00:00.000Z")],
    lines: [
      line("L1", "S-A", "P1", "C1", 10_000, 6_000n, "2026-01-10T15:00:00.000Z", { cumulativeEntitlementCents: 4_200n, paidCents: 6_000n, state: "ADJUSTED" }),
      line("L2", "S-A", "P2", "C2", 10_000, 5_000n, "2026-03-03T15:00:00.000Z", { state: "ELIGIBLE" }),
    ],
    adjustments: [{ adjustmentId: "A1", lineId: "L1", direction: "DECREASE", amountCents: 1_800n, createdAt: "2026-02-10T15:00:00.000Z" }],
    offsets: [{ offsetId: "O1", sellerId: "S-A", againstLineId: "L2", amountCents: 1_800n, recordedAt: "2026-03-05T15:00:00.000Z" }],
    payouts: [{ sellerId: "S-A", amountCents: 6_000n, state: "SETTLED", settledAt: "2026-01-20T15:00:00.000Z" }],
    funds: available("C2"),
  };
  const feb = o22.sellerMoney(rows, FEB).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(feb.commissionGeneratedCents, -1_800n);
  assert.equal(feb.refundOffsetCents, 0n);
  const mar = o22.sellerMoney(rows, MAR).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(mar.commissionGeneratedCents, 5_000n, "March's generated is not lowered again by the offset");
  assert.equal(mar.refundOffsetCents, 1_800n);
  assert.equal(mar.commissionPayableCents, 3_200n, "5 000 eligible less the 1 800 offset");
  assert.equal(mar.commissionHeldCents, 0n);
  assert.equal(mar.commissionPendingCents, 3_200n);
  const jan = o22.sellerMoney(rows, JAN).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(jan.commissionPaidCents, 6_000n);
  assert.equal(mar.commissionPaidCents, 0n);
});

test("an offset released in a later month is reported in that month, not by rewriting the month it was applied", () => {
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P2", "C2", 50_000n, "2026-02-03T15:00:00.000Z")],
    lines: [line("L2", "S-A", "P2", "C2", 10_000, 5_000n, "2026-02-03T15:00:00.000Z", { state: "ELIGIBLE" })],
    offsets: [{ offsetId: "O1", sellerId: "S-A", againstLineId: "L2", amountCents: 1_800n, recordedAt: "2026-02-05T15:00:00.000Z" }],
    releases: [{ offsetId: "O1", sellerId: "S-A", amountCents: 800n, recordedAt: "2026-03-05T15:00:00.000Z" }],
    funds: available("C2"),
  };
  assert.equal((o22.sellerMoney(rows, FEB).sellers[0] as o22.SellerMoneyFigures).refundOffsetCents, 1_800n);
  assert.equal((o22.sellerMoney(rows, MAR).sellers[0] as o22.SellerMoneyFigures).refundOffsetCents, -800n);
  assert.equal((o22.sellerMoney(rows, MAR).sellers[0] as o22.SellerMoneyFigures).commissionPayableCents, 4_000n);
});

test("held, payable and paid are kept apart; only a SETTLED payout counts as paid, in the month it settled", () => {
  const at = "2026-01-10T15:00:00.000Z";
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: ["P1", "P2", "P3", "P4", "P5"].map((p, i) => birth(p, `C${i}`, 10_000n, at)),
    lines: [
      line("L1", "S", "P1", "C0", 10_000, 1_000n, at, { state: "ACCRUED_PENDING" }),
      line("L2", "S", "P2", "C1", 10_000, 1_000n, at, { state: "HELD" }),
      line("L3", "S", "P3", "C2", 10_000, 1_000n, at, { state: "ELIGIBLE" }),
      line("L4", "S", "P4", "C3", 10_000, 1_000n, at, { state: "PAYABLE" }),
      line("L5", "S", "P5", "C4", 10_000, 1_000n, at, { state: "PAID", paidCents: 1_000n }),
    ],
    holds: [{ lineId: "L3", amountCents: 300n, state: "OPEN" }, { lineId: "L3", amountCents: 999n, state: "RELEASED" }],
    payouts: [
      { sellerId: "S", amountCents: 1_000n, state: "SETTLED", settledAt: "2026-01-25T15:00:00.000Z" },
      { sellerId: "S", amountCents: 700n, state: "AUTHORIZED", settledAt: null },
      { sellerId: "S", amountCents: 900n, state: "FAILED", settledAt: null },
      { sellerId: "S", amountCents: 500n, state: "SETTLED", settledAt: "2026-02-02T15:00:00.000Z" },
    ],
    funds: available("C2", "C3"),
  };
  const s = o22.sellerMoney(rows, JAN).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(s.commissionHeldCents, 2_300n, "accruing 1 000 + held 1 000 + the OPEN hold's 300");
  assert.equal(s.commissionPayableCents, 1_700n, "eligible 700 after its hold + payable 1 000");
  assert.equal(s.commissionPendingCents, 4_000n);
  assert.equal(s.commissionPaidCents, 1_000n);
  assert.equal(s.commissionGeneratedCents, 5_000n);
});

test("the retainer: USD 0.00 by default; a signed agreement prevails under its dates; a later signature never rewrites a month", () => {
  const agreements: o22.RetainerAgreement[] = [
    { agreementId: "AG1", sellerId: "S", startsAt: "2026-01-01T05:00:00.000Z", endsAt: "2026-04-01T05:00:00.000Z", retainerCentsPerMonth: 50_000n, signedAt: "2025-12-20T15:00:00.000Z" },
    { agreementId: "AG2", sellerId: "S", startsAt: "2026-02-01T05:00:00.000Z", endsAt: null, retainerCentsPerMonth: 80_000n, signedAt: "2026-02-15T15:00:00.000Z" },
    { agreementId: "AG3", sellerId: "S", startsAt: "2026-01-01T05:00:00.000Z", endsAt: null, retainerCentsPerMonth: 99_000n, signedAt: null },
  ];
  assert.deepEqual(o22.retainerDue("S", "2025-12-01T05:00:00.000Z", agreements), { sellerId: "S", monthStart: "2025-12-01T05:00:00.000Z", amountCents: 0n, agreementId: null });
  assert.equal(o22.retainerDue("S", JAN.startsAt, agreements).amountCents, 50_000n);
  assert.equal(o22.retainerDue("S", FEB.startsAt, agreements).agreementId, "AG1", "AG2 was signed after February began");
  assert.equal(o22.retainerDue("S", MAR.startsAt, agreements).agreementId, "AG2", "the later agreement in force prevails from March");
  assert.equal(o22.retainerDue("S", "2026-04-01T05:00:00.000Z", agreements).amountCents, 80_000n);
  assert.equal(o22.retainerDue("OTHER", JAN.startsAt, agreements).amountCents, 0n, "another seller's agreement never applies");
  assert.equal(o22.RETAINER_DEFAULT_CENTS_PER_MONTH, 0n);
});

test("the statement balance: payable = earned − offsets + retainer − held; an offset and a hold count once", () => {
  const items: o22.BalanceStatementItem[] = [
    { kind: "LINE", lineId: "L1", heldCents: 0n, offsetCents: 1_800n, payableCents: 2_900n },
    { kind: "HOLD", lineId: "L1", heldCents: 300n, offsetCents: 0n, payableCents: 0n },
    { kind: "OFFSET", lineId: "L0", heldCents: 0n, offsetCents: 1_800n, payableCents: 0n },
    { kind: "LINE", lineId: "L2", heldCents: 1_000n, offsetCents: 0n, payableCents: 0n },
    { kind: "CREDIT", lineId: "L3", heldCents: 0n, offsetCents: 0n, payableCents: 400n },
    { kind: "RECOVERY", lineId: "L4", heldCents: 0n, offsetCents: 0n, payableCents: 0n },
    { kind: "ADJUSTMENT", lineId: "L1", heldCents: 0n, offsetCents: 0n, payableCents: 0n },
  ];
  const b = o22.statementBalance(items, [{ accrualId: "R1", monthStart: JAN.startsAt, amountCents: 50_000n }]);
  assert.deepEqual(b, { earnedCents: 6_400n, offsetCents: 1_800n, retainerCents: 50_000n, heldCents: 1_300n, payableCents: 53_300n });
  assert.deepEqual(o22.statementBalance(items, []).retainerCents, 0n);
  assert.throws(() => o22.statementBalance(items, [{ accrualId: "R1", monthStart: JAN.startsAt, amountCents: 1n }, { accrualId: "R2", monthStart: JAN.startsAt, amountCents: 1n }]), /twice/);
});

test("review F-3: held and payable follow the close — an eligible line awaiting its funds is held, a settled line's seller credit is payable", () => {
  const at = "2026-01-10T15:00:00.000Z";
  const rows: o22.SellerMoneyRows = {
    ...empty,
    basis: [birth("P1", "C1", 10_000n, at), birth("P2", "C2", 12_000n, at)],
    lines: [
      line("L1", "S", "P1", "C1", 10_000, 1_000n, at, { state: "ELIGIBLE" }),
      line("L2", "S", "P2", "C2", 10_000, 1_000n, at, { state: "ADJUSTED", cumulativeEntitlementCents: 1_200n, paidCents: 1_000n }),
    ],
    funds: [{ captureId: "C1", fundsState: "HELD" }],
    credit: [{ lineId: "L2", dueCents: 200n }],
  };
  const s = o22.sellerMoney(rows, JAN).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(s.commissionHeldCents, 1_000n, "the close itemizes L1 AWAITING_FUNDS: never payable");
  assert.equal(s.commissionPayableCents, 200n, "the close itemizes L2's 200 as a CREDIT item");
  assert.equal(s.commissionPendingCents, 1_200n);
  const funded = o22.sellerMoney({ ...rows, funds: available("C1") }, JAN).sellers[0] as o22.SellerMoneyFigures;
  assert.equal(funded.commissionPayableCents, 1_200n, "once its funds are AVAILABLE the line pays");
  assert.throws(() => o22.sellerMoney({ ...rows, credit: [{ lineId: "L2", dueCents: -1n }] }, JAN), /more seller credit/);
});
