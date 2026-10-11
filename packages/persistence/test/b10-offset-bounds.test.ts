// The offset amount bounds at the database (docs/design/B10-KIT-SUITES.md section 2.3; D10-NEG-1, R2-104; migration 0030
// commission_offsets_authorized): an offset is within the negative position its negative line has left after its earlier offsets, and
// within the unpaid amount its receiving line has left after the earlier offsets against it. These are insert-time facts, not state
// invariants (r3 R3-01: a later one-cent INCREASE is legal and leaves an earlier offset beyond the position), so the oracle does not
// carry them: these DENY tests do, one per predicate of the guard, each shown RED by the mutation that removes its predicate (recorded
// in the commit that added this file). Every refusal is the named check violation commission_offsets_amount (23514) and writes nothing.
// Negative positions are built as production builds them: a line paid through its statement and settled payout, then a refund lowering
// its pool's basis (the COMMISSIONS consumer's recomputation, the line walked PAID -> ADJUSTED); receiving lines are ELIGIBLE.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { recomputePool, type AdjustmentReason, type CommissionLineId, type EventId, type NewCommissionAdjustment } from "@kauro/domain";
import { PgCommissionLedgerRepository } from "../src/index.js";
import { clock } from "../src/testing/harness.js";
import { invariantsAfterEach } from "../src/testing/invariants.js";
import {
  accrue,
  acquired,
  activeSeller,
  closeWorld,
  completion,
  corporate,
  fixtureCalendar,
  funds,
  ids,
  makeEligible,
  openWorld,
  payLines,
  purchase,
  refusedWith,
  september,
  service,
  within,
  type Agency,
  type Purchase,
  type Seller,
  type World,
} from "./b10-commission-support.js";

let w: World;
invariantsAfterEach(() => w.h.oracle);
/** One dated period per negative line of a seller: each paid line is paid by the seller's one statement of its period. */
let periods: string[];

before(async () => {
  w = await openWorld("b10-offset-bounds");
  const calendarId = await fixtureCalendar(w);
  periods = [await september(w, calendarId), await september(w, calendarId, "TEST_FIXTURE", ["2026-11-06", "2026-11-13"], "2026-10-01")];
});
after(async () => {
  await closeWorld(w);
});

/** A refund lowering a capture's basis, recomputed and applied as the COMMISSIONS consumer does, a paid line walked to ADJUSTED. */
async function refundTo(ag: Agency, p: Purchase, basisCents: bigint, agreementVersion: string): Promise<void> {
  const sourceEventId = ids.next();
  await within(w.commission, service(ag.agencyId), async (c) => {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    for (const { pool, lines } of await ledger.lockPoolsOfCapture(p.captureId as never)) {
      const recomputed = recomputePool({ basisCents: pool.basisCents, rateBps: pool.rateBps, lines: lines.map((l) => ({ lineId: l.lineId, sellerId: l.sellerId, shareBps: l.shareBps, cumulativeCents: l.cumulativeEntitlementCents })) }, { kind: "REFUND_COMPLETED", serviceBasisAfterCents: basisCents });
      const adjustments: NewCommissionAdjustment[] = recomputed.adjustments.map((a) => ({
        adjustmentId: ids.next() as NewCommissionAdjustment["adjustmentId"],
        commissionLineId: a.lineId as CommissionLineId,
        reason: a.reason as AdjustmentReason,
        signedCents: a.signedCents,
        newCumulativeEntitlementCents: a.newCumulativeCents,
        sourceEventId: sourceEventId as EventId,
        agreementVersion,
        createdAt: clock.now(),
      }));
      assert.equal((await ledger.applyBasisChange(pool.poolId, recomputed.pool.basisCents, recomputed.poolCents, adjustments)).applied, true);
      for (const before of lines) {
        const line = (await ledger.getLine(before.lineId))!;
        if (line.state === "PAID" || line.state === "ADJUSTED") assert.equal((await ledger.transitionLine(line.lineId, line.version, { state: "ADJUSTED" }, clock.now())).kind, "APPLIED");
      }
    }
  });
}

/**
 * A seller under signed SIGNED_FUTURE_OFFSET terms with, on one agency: `negatives` paid lines of 4000 cents each (REPEAT 400 bps on
 * a 100000 basis) refunded to 3000 (basis 75000) — a 1000-cent negative position each — and ELIGIBLE receiving lines of the cents given (the first
 * purchase's FIRST line at 1000 bps on ten times those cents, then one REPEAT purchase at 400 bps per further receiving line).
 */
async function sellerWith(label: string, negatives: number, receiving: ReadonlyArray<number>): Promise<{ seller: Seller; negativeLines: string[]; receivingLines: string[] }> {
  const seller = await activeSeller(w, `${label}-seller`, { offsetTerms: "SIGNED_FUTURE_OFFSET" });
  const a = await acquired(w, `${label} agency`, [{ seller, shareBps: 10000 }]);
  const entitlementId = a.entitlements.get(seller.sellerId)!;
  const line = (cents: number) => [{ sellerId: seller.sellerId, entitlementId, shareBps: 10000, cents }];
  let sequence = 1;
  // every later purchase is quoted with the agency's paid projects so far as its qualifying set (the second end client's projects)
  const paid: string[] = [a.first.projectId];
  const next = async (seed: string): Promise<Purchase> => {
    const p = await purchase(w, a.ag, seed, { qualifying: [...paid], client: 1 });
    paid.push(p.projectId);
    return p;
  };
  const receivingLines: string[] = [];
  for (const [i, cents] of receiving.entries()) {
    const p = i === 0 ? a.first : await next(`${label}-receiving-${i}`);
    const pool = await accrue(w, a.ag, p, a.allocationId, { rateKind: i === 0 ? "FIRST" : "REPEAT", rateBps: i === 0 ? 1000 : 400, basisCents: i === 0 ? cents * 10 : cents * 25, poolCents: cents, sequence: sequence++ }, line(cents));
    await completion(w, a.ag, p, "FINAL");
    await funds(w, a.ag, p, "AVAILABLE", 2);
    await makeEligible(w, pool.lineOf.get(seller.sellerId)!);
    receivingLines.push(pool.lineOf.get(seller.sellerId)!);
  }
  const negativeLines: string[] = [];
  for (let n = 0; n < negatives; n++) {
    const p = await next(`${label}-negative-${n}`);
    const pool = await accrue(w, a.ag, p, a.allocationId, { rateKind: "REPEAT", rateBps: 400, basisCents: 100000, poolCents: 4000, sequence: sequence++ }, line(4000));
    const lineId = pool.lineOf.get(seller.sellerId)!;
    await payLines(w, a.ag, p, periods[n]!, [{ seller, lineId }]);
    await refundTo(a.ag, p, 75000n, seller.agreementVersion);
    const row = (await w.h.oracle.query<{ position: number }>("SELECT (paid_cents - cumulative_entitlement_cents)::int AS position FROM kauro.commission_lines WHERE line_id = $1", [lineId])).rows[0]!;
    assert.equal(row.position, 1000, "a 1000-cent negative position");
    negativeLines.push(lineId);
  }
  return { seller, negativeLines, receivingLines };
}

/** The commission service records an offset of a negative line against a receiving line of its seller. */
const offset = (seller: Seller, negativeLineId: string, againstLineId: string, cents: number): Promise<unknown> =>
  within(w.commission, corporate, (c) =>
    c.query(
      "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now())",
      [ids.next(), seller.sellerId, negativeLineId, againstLineId, cents, seller.agreementId],
    ),
  );
const offsetsOf = async (seller: Seller): Promise<ReadonlyArray<readonly [string, string, number]>> =>
  (await w.h.oracle.query<{ n: string; a: string; cents: number }>("SELECT negative_line_id AS n, against_line_id AS a, amount_cents::int AS cents FROM kauro.commission_offsets WHERE seller_id = $1 ORDER BY recorded_at, offset_id", [seller.sellerId])).rows.map(
    (r) => [r.n, r.a, r.cents] as const,
  );
const amountRefused = refusedWith("23514", "commission_offsets_amount");

test("DENY: an offset of 101 cents against an unpaid 100-cent line with a 1000-cent negative position is refused commission_offsets_amount and writes nothing", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-receiving", 1, [100]);
  await assert.rejects(offset(seller, n!, r!, 101), amountRefused, "beyond the receiving line's unpaid amount");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offset wrote nothing");
  await offset(seller, n!, r!, 100);
  assert.deepEqual(await offsetsOf(seller), [[n, r, 100]]);
});

test("DENY: offsets of one negative line against two receiving lines whose sum exceeds the negative position are refused at the cent that exceeds it", async () => {
  const { seller, negativeLines: [n], receivingLines: [r1, r2] } = await sellerWith("bounds-negative-aggregate", 1, [600, 600]);
  await offset(seller, n!, r1!, 600);
  await assert.rejects(offset(seller, n!, r2!, 401), amountRefused, "600 offset, 400 left of the 1000-cent position: 401 exceeds it by one cent");
  assert.deepEqual(await offsetsOf(seller), [[n, r1, 600]], "the refused offset wrote nothing");
  await offset(seller, n!, r2!, 400);
  await assert.rejects(offset(seller, n!, r2!, 1), amountRefused, "the position is exhausted although the receiving line has 200 unpaid left");
  assert.deepEqual(await offsetsOf(seller), [[n, r1, 600], [n, r2, 400]]);
});

test("DENY: two negative lines of one seller each offset within its own position, a third offset exceeding one line's remaining position refused", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-per-negative-line", 2, [5000]);
  await offset(seller, n1!, r!, 700);
  await offset(seller, n2!, r!, 700);
  await assert.rejects(offset(seller, n1!, r!, 301), amountRefused, "the first line has 300 of its position left");
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 700], [n2, r, 700]], "the refused offset wrote nothing");
  await offset(seller, n1!, r!, 300);
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 700], [n2, r, 700], [n1, r, 300]]);
});

test("DENY: two distinct negative lines of one seller, each within its own position, whose offsets against ONE receiving line together exceed that line's unpaid amount are refused at the cent that exceeds it", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-receiving-aggregate", 2, [1000]);
  await offset(seller, n1!, r!, 600);
  await assert.rejects(offset(seller, n2!, r!, 401), amountRefused, "the receiving line has 400 unpaid left after the first line's offset");
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 600]], "the refused offset wrote nothing");
  await offset(seller, n2!, r!, 400);
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 600], [n2, r, 400]]);
});
