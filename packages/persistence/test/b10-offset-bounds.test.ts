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
import { recomputePool, type AdjustmentReason, type CommissionHoldId, type CommissionLineId, type EventId, type NewCommissionAdjustment } from "@kauro/domain";
import type { UtcInstant } from "@kauro/contracts";
import { PgCommissionLedgerRepository } from "../src/index.js";
import { clock } from "../src/testing/harness.js";
import { bothOrders, openConnection, recordHold, recordIssuedStatement, type HarnessConnection, type RaceRun } from "../src/testing/index.js";
import { invariantsAfterEach } from "../src/testing/invariants.js";
import { bindCommerce } from "./commerce-support.js";
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
/** The two commission-service connections the RACE cells contend on (the harness opens them: each is observed waiting once). */
let racers: [HarnessConnection, HarnessConnection];

before(async () => {
  w = await openWorld("b10-offset-bounds");
  const calendarId = await fixtureCalendar(w);
  periods = [await september(w, calendarId), await september(w, calendarId, "TEST_FIXTURE", ["2026-11-06", "2026-11-13"], "2026-10-01")];
  racers = [await openConnection(w.h.pg.clientConfig("kauro_commission_test")), await openConnection(w.h.pg.clientConfig("kauro_commission_test"))];
});
after(async () => {
  for (const c of racers ?? []) await c.end();
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
async function sellerWith(label: string, negatives: number, receiving: ReadonlyArray<number>, opts: { readonly receivingState?: "ELIGIBLE" | "ACCRUED_PENDING" } = {}): Promise<{ seller: Seller; agencyId: string; negativeLines: string[]; receivingLines: string[] }> {
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
    if (opts.receivingState !== "ACCRUED_PENDING") {
      await completion(w, a.ag, p, "FINAL");
      await funds(w, a.ag, p, "AVAILABLE", 2);
      await makeEligible(w, pool.lineOf.get(seller.sellerId)!);
    }
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
  return { seller, agencyId: a.ag.agencyId, negativeLines, receivingLines };
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

// The receiving line's capacity is its unpaid amount LESS its OPEN holds (R2-102: a partial hold leaves the line on its path and the statement
// withholds exactly the held cents; composeStatement clips an offset to unpaid - held, so an offset admitted beyond that is durable, consumes
// the negative position in full, and is never applied: owner money lost). Adversary ADV-3; migration 0045 is the guard that refuses it.
test("DENY: an offset beyond the receiving line's unpaid amount less its OPEN partial hold is refused commission_offsets_amount (the statement would clip the excess and the negative position would be consumed in full)", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-open-hold", 1, [1000]);
  await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 100n });
  await assert.rejects(offset(seller, n!, r!, 901), amountRefused, "1000 unpaid, 100 held OPEN: 900 is the capacity, 901 exceeds it by one cent");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offset wrote nothing");
  await offset(seller, n!, r!, 900);
  assert.deepEqual(await offsetsOf(seller), [[n, r, 900]]);
});

test("DENY: the capacity less an OPEN hold is shared by every offset against the line: a second negative line's offset beyond what the first left of unpaid-minus-held is refused", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-open-hold-aggregate", 2, [1000]);
  await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 100n });
  await offset(seller, n1!, r!, 500);
  await assert.rejects(offset(seller, n2!, r!, 401), amountRefused, "900 capacity, 500 offset already: 401 exceeds the 400 left");
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 500]], "the refused offset wrote nothing");
  await offset(seller, n2!, r!, 400);
});

test("a RELEASED hold withholds nothing: the offset may use the line's whole unpaid amount again", async () => {
  const { seller, agencyId, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-released-hold", 1, [1000]);
  const hold = await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 100n });
  await within(w.commission, service(agencyId), async (c) => {
    assert.equal((await new PgCommissionLedgerRepository(c, ids).resolveHold(hold.holdId, 1, "RELEASED", clock.now())).kind, "APPLIED");
  });
  await offset(seller, n!, r!, 1000);
  assert.deepEqual(await offsetsOf(seller), [[n, r, 1000]]);
});

// --- the offset is admitted only where a statement will apply it, and its capacity is read under the lines' lock (ADV-9, ADV-10) ------
// composeStatement applies an offset only to an ELIGIBLE receiving line (statements.ts: PAYABLE and VOID lines are not itemized again, an
// ACCRUED_PENDING or HELD line is itemized without one): an offset admitted against any other state is durable, consumes the negative
// position, and is never applied. A negative line never paid has no negative position at all. Every writer of either side of the capacity
// (an offset, a hold) takes the line's row lock and then its transition subject, the order 0036 set for lines (D10-GAP-8), and reads the
// capacity after it: two offsets, or an offset and a hold, that each fit alone never both commit (decision D10-NEG-3).
const applicableRefused = refusedWith("23514", "commission_offsets_applicable");
/** The repository surfaces the database refusal as a DomainFailure whose cause is the database error naming the constraint. */
const holdRefused = (e: unknown): boolean => {
  const named = refusedWith("23514", "commission_holds_offset_room");
  return named(e) || (typeof e === "object" && e !== null && "cause" in e && named((e as { cause: unknown }).cause));
};

test("DENY: an offset against a PAYABLE receiving line (payable through an ISSUED statement, which applies no later offset) is refused commission_offsets_applicable and writes nothing", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-payable", 1, [1000]);
  await recordIssuedStatement(w.h, { periodId: periods[1]!, sellerId: seller.sellerId, cutoffAt: clock.now() });
  assert.equal((await w.h.oracle.query<{ state: string }>("SELECT state FROM kauro.commission_lines WHERE line_id = $1", [r])).rows[0]!.state, "PAYABLE");
  await assert.rejects(offset(seller, n!, r!, 300), applicableRefused, "the PAYABLE case of the statement applies nothing: 300 would be lost to the owner");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offset wrote nothing");
});

test("DENY: an offset against an ACCRUED_PENDING receiving line, and against the same line once HELD under a covering hold, is refused commission_offsets_applicable and writes nothing", async () => {
  const { seller, agencyId, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-pending-held", 1, [1000], { receivingState: "ACCRUED_PENDING" });
  await assert.rejects(offset(seller, n!, r!, 1), applicableRefused, "ACCRUED_PENDING: no statement applies an offset to it");
  await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 1000n, reason: "FUNDS_HELD" });
  await within(w.commission, service(agencyId), async (c) => {
    const ledger = new PgCommissionLedgerRepository(c, ids);
    const line = (await ledger.lockLine(r as CommissionLineId))!;
    assert.equal((await ledger.transitionLine(r as CommissionLineId, line.version, { state: "HELD" }, clock.now())).kind, "APPLIED");
  });
  await assert.rejects(offset(seller, n!, r!, 1), applicableRefused, "HELD: no statement applies an offset to it");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offsets wrote nothing");
});

test("DENY: an offset FROM a line never paid (paid_cents NULL: no negative position) is refused commission_offsets_amount and writes nothing", async () => {
  const { seller, receivingLines: [never, r] } = await sellerWith("bounds-never-paid", 0, [1000, 1000]);
  assert.equal((await w.h.oracle.query<{ paid: string | null }>("SELECT paid_cents AS paid FROM kauro.commission_lines WHERE line_id = $1", [never])).rows[0]!.paid, null);
  await assert.rejects(offset(seller, never!, r!, 1), amountRefused, "a line never paid has no negative position to offset");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offset wrote nothing");
});

/** An offset written inside a racer's open transaction by the commission service. */
const offsetIn = (c: HarnessConnection, seller: Seller, negativeLineId: string, againstLineId: string, cents: number): Promise<unknown> =>
  c.query(
    "INSERT INTO kauro.commission_offsets (offset_id, seller_id, negative_line_id, against_line_id, amount_cents, agreement_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, kauro.server_now(), now())",
    [ids.next(), seller.sellerId, negativeLineId, againstLineId, cents, seller.agreementId],
  );
/** A partial dispute hold opened inside a racer's open transaction by the commission service (the ledger port's openHold). */
const holdIn = (c: HarnessConnection, lineId: string, cents: bigint) =>
  new PgCommissionLedgerRepository(c, ids).openHold({
    holdId: ids.next() as CommissionHoldId,
    lineId: lineId as CommissionLineId,
    amountCents: cents,
    reason: "SELLER_DISPUTE",
    reviewAt: new Date(Date.now() + 14 * 24 * 3_600_000).toISOString() as UtcInstant,
    openedAt: clock.now(),
  });
type Built = Awaited<ReturnType<typeof sellerWith>>;
/** Exactly the holder committed; the waiter, observed waiting on it, was refused as `refused` says once it read what the holder wrote. */
function holderWins(run: RaceRun<Built>, refused: Readonly<Record<string, (e: unknown) => boolean>>): void {
  const [holder, waiter] = run.order;
  assert.equal(run.outcomes[holder]!.committed, true, `${holder} (the holder) committed`);
  assert.equal(run.outcomes[waiter]!.committed, false, `${waiter} (the waiter) did not commit`);
  const act = run.outcomes[waiter]!.act;
  assert.ok(act.status === "rejected" && refused[waiter]!(act.reason), `${waiter} was refused by the capacity read after its wait: ${act.status === "rejected" ? String(act.reason) : "it was admitted"}`);
}

test("RACE: two 600-cent offsets of two negative lines against ONE 1000-cent receiving line, both orders: the second waits on the first's line lock and is refused, exactly one commits", async () => {
  const runs = await bothOrders<Built>({
    oracle: w.h.oracle,
    actors: [
      { name: "first-negative", client: racers[0], begin: (c) => bindCommerce(c, corporate), act: (c, s) => offsetIn(c, s.seller, s.negativeLines[0]!, s.receivingLines[0]!, 600) },
      { name: "second-negative", client: racers[1], begin: (c) => bindCommerce(c, corporate), act: (c, s) => offsetIn(c, s.seller, s.negativeLines[1]!, s.receivingLines[0]!, 600) },
    ],
    setup: (order) => sellerWith(`race-receiving-${order[0]}`, 2, [1000]),
    async verify(run) {
      holderWins(run, { "first-negative": amountRefused, "second-negative": amountRefused });
      const kept = run.order[0] === "first-negative" ? run.state.negativeLines[0] : run.state.negativeLines[1];
      assert.deepEqual(await offsetsOf(run.state.seller), [[kept, run.state.receivingLines[0], 600]], "1200 never sits on a 1000-cent line");
    },
  });
  assert.deepEqual(runs.map((r) => r.order[0]), ["first-negative", "second-negative"]);
});

test("RACE: two 600-cent offsets of ONE negative line (a 1000-cent position) against two receiving lines, both orders: the second waits on the negative line's lock and is refused, exactly one commits", async () => {
  await bothOrders<Built>({
    oracle: w.h.oracle,
    actors: [
      { name: "to-first", client: racers[0], begin: (c) => bindCommerce(c, corporate), act: (c, s) => offsetIn(c, s.seller, s.negativeLines[0]!, s.receivingLines[0]!, 600) },
      { name: "to-second", client: racers[1], begin: (c) => bindCommerce(c, corporate), act: (c, s) => offsetIn(c, s.seller, s.negativeLines[0]!, s.receivingLines[1]!, 600) },
    ],
    setup: (order) => sellerWith(`race-negative-${order[0]}`, 1, [1000, 1000]),
    async verify(run) {
      holderWins(run, { "to-first": amountRefused, "to-second": amountRefused });
      const kept = run.order[0] === "to-first" ? run.state.receivingLines[0] : run.state.receivingLines[1];
      assert.deepEqual(await offsetsOf(run.state.seller), [[run.state.negativeLines[0], kept, 600]], "1200 is never offset from a 1000-cent position");
    },
  });
});

test("RACE: a 600-cent offset and a 500-cent hold on ONE 1000-cent ELIGIBLE line, both orders: the second waits on the first's line lock and is refused, exactly one commits (D10-NEG-3)", async () => {
  await bothOrders<Built>({
    oracle: w.h.oracle,
    actors: [
      { name: "offset", client: racers[0], begin: (c) => bindCommerce(c, corporate), act: (c, s) => offsetIn(c, s.seller, s.negativeLines[0]!, s.receivingLines[0]!, 600) },
      { name: "hold", client: racers[1], begin: (c, s) => bindCommerce(c, service(s.agencyId)), act: (c, s) => holdIn(c, s.receivingLines[0]!, 500n) },
    ],
    setup: (order) => sellerWith(`race-hold-${order[0]}`, 1, [1000]),
    async verify(run) {
      holderWins(run, { offset: amountRefused, hold: holdRefused });
      const holds = (await w.h.oracle.query("SELECT amount_cents::int AS cents FROM kauro.commission_holds WHERE line_id = $1", [run.state.receivingLines[0]])).rows;
      const offsets = await offsetsOf(run.state.seller);
      if (run.order[0] === "offset") assert.deepEqual([offsets.length, holds], [1, []], "the offset stands, the hold that would leave it unapplied was refused");
      else assert.deepEqual([offsets, holds], [[], [{ cents: 500 }]], "the hold stands, the offset beyond unpaid less it was refused");
    },
  });
});

test("DENY: a hold opened after an offset on an ELIGIBLE line beyond its unpaid amount less the offsets is refused commission_holds_offset_room and writes nothing; one within it opens", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-hold-after", 1, [1000]);
  await offset(seller, n!, r!, 900);
  await assert.rejects(recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 101n }), holdRefused, "1000 unpaid, 900 offset: a 101-cent hold would leave one cent of the offset unapplied");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.commission_holds WHERE line_id = $1", [r])).rows.length, 0, "the refused hold wrote nothing");
  await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 100n });
});

test("a hold on a PAYABLE line whose statement applied an offset still opens (the PAYOUT_FAILED covering hold): the room is checked only where a statement will apply offsets", async () => {
  const { seller, agencyId, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-payable-hold", 1, [1000]);
  await offset(seller, n!, r!, 300);
  await recordIssuedStatement(w.h, { periodId: periods[1]!, sellerId: seller.sellerId, cutoffAt: clock.now() });
  await within(w.commission, service(agencyId), (c) => holdIn(c, r!, 1000n));
  assert.deepEqual((await w.h.oracle.query("SELECT state, amount_cents::int AS cents FROM kauro.commission_holds WHERE line_id = $1", [r])).rows, [{ state: "OPEN", cents: 1000 }]);
});

test("an UPHELD hold withholds nothing (its decision posts an AGREED_ERROR_CORRECTION decrease instead): the offset may use the line's whole unpaid amount", async () => {
  const { seller, agencyId, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-upheld-hold", 1, [1000]);
  const hold = await recordHold(w.h, { ownerUserId: w.kora, lineId: r!, amountCents: 100n });
  await within(w.commission, service(agencyId), async (c) => {
    assert.equal((await new PgCommissionLedgerRepository(c, ids).resolveHold(hold.holdId, 1, "UPHELD", clock.now())).kind, "APPLIED");
  });
  await offset(seller, n!, r!, 1000);
  assert.deepEqual(await offsetsOf(seller), [[n, r, 1000]]);
});
