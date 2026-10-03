// CMD051 CloseCommissionPeriod — POST /api/v1/sales/commission-periods/{periodId}/close — COMMISSION_SERVICE — scope STORED_OPERATION (package
// B10, mandate B10-STATEMENTS-PAYOUTS; docs/design/B10-case-map.md R2-102, R2-105, R2-139, CMD051-OK, CMD051-DENY, CMD051-RACE; design §7,
// §10, §12; decisions D10-STMT-1, D10-STMT-2, D10-STMT-4, D10-GUARD-1, D10-CAL-1, D10-NEG-1). The real service route, the commercial
// authorizer, the commission service's units of work and PostgreSQL 17 through the runtime login roles; the superuser only reads (and records
// commission-support's synthetic price schedule). The banking calendar is the labelled contract fake (SIMULATED) serving example 21's
// controlled fixture: weekends and 2026-10-12 nonbanking. Each test closes its own month; the close stands at a chosen instant only through the
// labelled TEST CLOCK, never behind the real clock. The worked examples' integer cents are written here as the oracle. Interleavings are
// held at named points and every wait is observed in pg_stat_activity; nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { CommissionStatementView, ExecuteRefundView, PeriodCloseView } from "@kauro/application";
import { recordHold } from "@kauro/persistence/testing";
import { waitForLockWait } from "@kauro/persistence/testing";
import type { UserId } from "@kauro/domain";
import { approvedRefund } from "./commission-support.js";
import { execute } from "./payment-support.js";
import {
  COMMISSION_APPLICATION_NAME,
  ServiceCrash,
  ZONE,
  closePeriod,
  commissionToken,
  eligibleLines,
  itemsOf,
  lineStates,
  openMonth,
  periodIdOf,
  periodRow,
  proposal,
  readStatement,
  rows,
  seller,
  statementsOfSeller,
  statementsWorld,
  type StatementsWorld,
} from "./statements-support.js";
import { asProblem, completed, freshKey, ids, outcome, replayTextOf, sha } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

/** The application name of the commission service's own pool (its SERVICE units of work: the close and the consumer's effects). */
const SERVICE_POOL = `${COMMISSION_APPLICATION_NAME}-service`;
/** Rates of 100% of the basis, so a line's cents are the round numbers of the case (the allocation's and the agreement's). */
const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;

/** Closes a month's period with the proposal of the ledger as it stands. */
async function closeNow(periodId: string, options: { readonly key?: string } = {}) {
  return closePeriod(sw, periodId, { ledgerCutoffHash: await proposal(sw, periodId) }, options);
}

const dateOf = (d: Date | null): string | null => (d === null ? null : new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d));

// --- CMD051-OK, R2-139 ------------------------------------------------------------------------------------------------------------------

test("OK: the commission service closes a due September 2026 period on the test calendar — 200 with one immutable ISSUED statement per seller itemizing each line, dated 2026-10-07 with pay date 2026-10-15 and labelled SIMULATED, its ELIGIBLE lines PAYABLE and the period CLOSED", async () => {
  const one = await seller(sw, "cmd051-ok-one", WHOLE);
  const two = await seller(sw, "cmd051-ok-two", WHOLE);
  const a = await eligibleLines(sw, "CMD051 OK one", one, WHOLE, [{ basisCents: 20_000n, poolCents: 20_000n }, { basisCents: 5_000n, poolCents: 5_000n }]);
  const b = await eligibleLines(sw, "CMD051 OK two", two, WHOLE, [{ basisCents: 30_000n, poolCents: 30_000n }]);

  // the PERIODS sweep, standing in September, opens the month's period undated; the close dates it from the calendar fake
  const periodId = await openMonth(sw, "2026-09");
  assert.deepEqual(await periodRow(sw, periodId).then((p) => [p.state, p.close_due_on, p.pay_due_on]), ["OPEN", null, null]);
  const calls = sw.calendar.calls.length;
  sw.standAt("2026-10-07T17:00:00Z");
  try {
    const done = completed<PeriodCloseView>(await closeNow(periodId), 200);
    assert.deepEqual(
      [done.data.period.state, done.data.period.closeDueOn, done.data.period.payDueOn, done.data.period.calendarSource, done.data.period.calendarVersion, done.data.period.simulated],
      ["CLOSED", "2026-10-07", "2026-10-15", "TEST_FIXTURE", "test-fixture-2026-2030", true],
    );
    assert.equal(done.data.statementCount, 2, "one statement per seller with lines");
    assert.equal(done.data.payableTotalCents, "55000");
    assert.equal(done.data.heldTotalCents, "0");
    assert.equal(done.version, done.data.period.version);
  } finally {
    sw.standAt(null);
  }
  // R2-139 through the calendar fake: the version it served is recorded with its source, the period dated by it
  assert.deepEqual(sw.calendar.calls.slice(calls).map((c) => c.operation), ["CURRENT_CALENDAR SERVICE"]);
  const period = await periodRow(sw, periodId);
  assert.deepEqual([period.state, period.close_due_on, period.pay_due_on, period.calendar_source], ["CLOSED", "2026-10-07", "2026-10-15", "TEST_FIXTURE"]);
  assert.match(period.cutoff_hash ?? "", /^[0-9a-f]{64}$/);

  // one immutable ISSUED statement per seller, dated by the period, labelled SIMULATED, itemizing each line
  for (const [s, sold, payable] of [[one, a, "25000"], [two, b, "30000"]] as const) {
    const statements = await statementsOfSeller(sw, s.sellerId);
    assert.equal(statements.length, 1);
    const st = statements[0]!;
    assert.deepEqual([st.period_id, st.state, st.label, st.statement_date, st.pay_date, st.payable_cents, st.held_cents], [periodId, "ISSUED", "SIMULATED", "2026-10-07", "2026-10-15", payable, "0"]);
    const items = await itemsOf(sw, st.statement_id);
    assert.deepEqual(items.map((i) => [i.item_kind, i.disposition, i.line_id, i.payable_cents]), sold.lines.map((l, n) => ["LINE", "PAYABLE", l.lineId, n === 0 ? (s === one ? "20000" : "30000") : "5000"]));
    assert.deepEqual(await lineStates(sw, sold.lines.map((l) => l.lineId)), sold.lines.map(() => "PAYABLE"));
    // immutable: no runtime role and not even the superuser changes an issued statement or its items
    await assert.rejects(sw.h.oracle.query("UPDATE kauro.statement_items SET payable_cents = 1 WHERE statement_id = $1", [st.statement_id]), /KA004|IMMUTABLE|forbid/i);
    await assert.rejects(sw.h.oracle.query("UPDATE kauro.commission_statements SET payable_cents = 1 WHERE statement_id = $1", [st.statement_id]), /KA004|IMMUTABLE|forbid/i);
  }
  assert.deepEqual(sw.backgroundFailures, []);
});

// --- R2-102 ---------------------------------------------------------------------------------------------------------------------------------

test("R2-102 (examples 21 and 25): CloseCommissionPeriod issues a statement in which the disputed 1000 cents are a held item with its reason and review date, the undisputed 50000 cents are payable, and accrued pending, eligible, held, paid and negative totals are separate", async () => {
  const s = await seller(sw, "r102-seller", WHOLE);
  // example 21: a USD10 contested line, USD500 of unrelated eligible commission, and a line still awaiting its final completion
  const sold = await eligibleLines(sw, "R2-102 agency", s, WHOLE, [{ basisCents: 1_000n, poolCents: 1_000n }, { basisCents: 50_000n, poolCents: 50_000n }, { basisCents: 7_000n, poolCents: 7_000n, state: "ACCRUED" }]);
  const [contested, unrelated, accrued] = sold.lines.map((l) => l.lineId) as [string, string, string];
  const hold = await recordHold(sw.h, { ownerUserId: sw.owner.userId as UserId, lineId: contested, amountCents: 1_000n, reason: "SELLER_DISPUTE", reviewInHours: 14 * 24 });

  const periodId = await openMonth(sw, "2026-08");
  completed<PeriodCloseView>(await closeNow(periodId), 200);
  const [st] = await statementsOfSeller(sw, s.sellerId);
  assert.ok(st !== undefined);
  // the totals are separate: accrued pending, eligible payable, specifically held, paid and negative
  assert.deepEqual(
    { accruedPending: st.accrued_pending_cents, payable: st.payable_cents, held: st.held_cents, paid: st.paid_to_date_cents, negative: st.negative_balance_cents },
    { accruedPending: "7000", payable: "50000", held: "1000", paid: "0", negative: "0" },
  );
  const items = await itemsOf(sw, st.statement_id);
  assert.deepEqual(
    items.map((i) => ({ line: i.line_id, kind: i.item_kind, disposition: i.disposition, held: i.held_cents, payable: i.payable_cents, reason: i.hold_reason, review: dateOf(i.hold_review_at) })),
    [
      { line: contested, kind: "LINE", disposition: "HELD", held: "1000", payable: "0", reason: "SELLER_DISPUTE", review: dateOf(new Date(hold.reviewAt)) },
      { line: unrelated, kind: "LINE", disposition: "PAYABLE", held: "0", payable: "50000", reason: null, review: null },
      { line: accrued, kind: "LINE", disposition: "AWAITING_FINAL_COMPLETION", held: "0", payable: "0", reason: null, review: null },
    ],
  );
  // only the undisputed line became PAYABLE: the contested one waits for its review, the accrued one for its completion
  assert.deepEqual(await lineStates(sw, [contested, unrelated, accrued]), ["ELIGIBLE", "PAYABLE", "ACCRUED_PENDING"]);
  // the seller's view carries the same separate totals and the hold's reason and review date
  const read = await readStatement(sw, st.statement_id, s.person.token);
  assert.equal(read.status, 200, read.text);
  const view = read.json<{ readonly kind: string; readonly data: CommissionStatementView }>().data;
  assert.deepEqual([view.payableCents, view.heldCents], ["50000", "1000"]);
  assert.deepEqual(view.items.map((i) => [i.lineId, i.heldCents, i.holdReason ?? null, i.holdReviewOn ?? null, i.payableCents]), [
    [contested, "1000", "SELLER_DISPUTE", dateOf(new Date(hold.reviewAt)), "0"],
    [unrelated, "0", null, null, "50000"],
    [accrued, "0", null, null, "0"],
  ]);
});

// --- R2-105 ---------------------------------------------------------------------------------------------------------------------------------

test("R2-105: the period close records the owner's compensation-guard review per seller — retainer, commission accrued, attributable net service, 16.67% EXCEEDS_PLANNING_GUARD — and still issues the statement; the guard refuses nothing", async () => {
  // example 23: a USD1,000 retainer plus a 10 percent commission on USD15,000 of attributable net service collection
  const s = await seller(sw, "r105-seller", { firstBps: 1_000, repeatBps: 400, retainerCentsPerMonth: 100_000 });
  const sold = await eligibleLines(sw, "R2-105 agency", s, { firstBps: 1_000, repeatBps: 400 }, [{ serviceCents: 1_500_000n, basisCents: 1_500_000n, poolCents: 150_000n }]);
  const periodId = await openMonth(sw, "2026-07");
  const done = completed<PeriodCloseView>(await closeNow(periodId), 200);
  assert.ok(done.data.guardReviewCount >= 1, "the close counts the statements whose review exceeds the planning guard");

  const [st] = await statementsOfSeller(sw, s.sellerId);
  assert.ok(st !== undefined);
  assert.deepEqual([st.state, st.payable_cents], ["ISSUED", "150000"], "the guard refuses nothing: the statement is issued and payable");
  assert.deepEqual(await lineStates(sw, [sold.lines[0]!.lineId]), ["PAYABLE"]);
  const reviews = await rows<{ statement_id: string; retainer_cents: string; commission_accrued_cents: string; attributable_net_service_cents: string; guard_bps: number; outcome: string; label: string }>(
    sw,
    "SELECT statement_id, retainer_cents::text, commission_accrued_cents::text, attributable_net_service_cents::text, guard_bps, outcome, label FROM kauro.compensation_guard_reviews WHERE period_id = $1 AND seller_id = $2",
    [periodId, s.sellerId],
  );
  assert.deepEqual(reviews, [{ statement_id: st.statement_id, retainer_cents: "100000", commission_accrued_cents: "150000", attributable_net_service_cents: "1500000", guard_bps: 1500, outcome: "EXCEEDS_PLANNING_GUARD", label: "BUSINESS_PLANNING_GUARD" }]);
  // (100000 + 150000) / 1500000 = 16.67%, by exact integer comparison against 1500 bps: (250000 x 10000) > (1500 x 1500000)
  assert.ok(250_000n * 10_000n > 1_500n * 1_500_000n);
  const ratio = (250_000n * 20_000n + 1_500_000n) / (2n * 1_500_000n);
  assert.equal(`${ratio / 100n}.${(ratio % 100n).toString().padStart(2, "0")}%`, "16.67%");
});

// --- CMD051-DENY ------------------------------------------------------------------------------------------------------------------------------

test("DENY: a user token or the finance service is a wrong service identity (403) and another period a foreign scope (404); then one missing prerequisite at a time — an undelivered COMMISSIONS record before the cutoff INPUTS_UNRECONCILED, a changed ledger LEDGER_CHANGED, a period not yet due PERIOD_NOT_DUE — and a line awaiting final completion or AVAILABLE funds stays a reasoned hold item, never payable", async () => {
  const s = await seller(sw, "cmd051-deny", WHOLE);
  // the purchases record capture.completed.v1 for COMMISSIONS now; this suite delivers none of them (no dispatcher runs before the race)
  const sold = await eligibleLines(sw, "CMD051 DENY agency", s, WHOLE, [
    { basisCents: 4_000n, poolCents: 4_000n },
    { basisCents: 3_000n, poolCents: 3_000n, state: "ACCRUED" },
    { basisCents: 2_000n, poolCents: 2_000n, state: "AWAITING_FUNDS" },
  ]);
  const [eligible, awaitingFinal, awaitingFunds] = sold.lines.map((l) => l.lineId) as [string, string, string];

  // the PERIODS sweep at the real clock opens the month it stands in
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const month = today.slice(0, 7);
  const report = await sw.periods().run({ limit: 10 });
  assert.ok(report.items.some((i) => i.subject === "OPEN" && i.outcome.endsWith(month)), JSON.stringify(report));
  const current = await periodIdOf(sw, month);
  const unchanged = async (periodId: string, what: string) => assert.deepEqual((await periodRow(sw, periodId)).state, "OPEN", `${what}: the period stays OPEN`);

  // wrong principals: a person's token is no service identity; the finance service lacks the role; another (unknown) period is out of scope
  const body = { ledgerCutoffHash: await proposal(sw, current) };
  const before = (await sw.w.securityEvents("CMD051")).length;
  assert.equal(outcome(sw.w, await closePeriod(sw, current, body, { token: sw.owner.token })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(sw.w, await closePeriod(sw, current, body, { token: commissionToken(sw, "finance-service") })), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.equal(outcome(sw.w, await closePeriod(sw, current, body, { token: commissionToken(sw, "commission-service", "LIVE") })), "403 NOT_AUTHORIZED SERVICE_ENVIRONMENT_MISMATCH");
  assert.equal(outcome(sw.w, await closePeriod(sw, ids.next(), body)), "404 NOT_FOUND -");
  assert.deepEqual((await sw.w.securityEvents("CMD051")).slice(before).map((f) => [f.outcome, f.reason]), [
    ["DENY", "SERVICE_NOT_PERMITTED"],
    ["DENY", "SERVICE_NOT_PERMITTED"],
    ["DENY", "SERVICE_ENVIRONMENT_MISMATCH"],
    ["DENY", "NOT_FOUND"],
  ]);
  assert.equal(outcome(sw.w, await closePeriod(sw, current, body, { token: null })), "401 AUTHENTICATION_REQUIRED -");
  await unchanged(current, "a wrong principal");

  // a period not yet due: the current month's close falls on the 5th banking day after it ends
  const notDue = await closePeriod(sw, current, body);
  assert.equal(outcome(sw.w, notDue), "409 PRECONDITION_FAILED PERIOD_NOT_DUE");
  assert.deepEqual(asProblem(sw.w, notDue).current?.state, "OPEN");
  assert.deepEqual(await periodRow(sw, current).then((p) => [p.state, p.close_due_on]), ["OPEN", null], "nothing is written, not even the dates");

  // standing past its close date, its COMMISSIONS inputs are not all delivered: the purchases' records before its end wait for the consumer
  const [y, m] = month.split("-").map(Number) as [number, number];
  const later = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 20, 17)).toISOString();
  sw.standAt(later);
  try {
    const pending = await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.outbox_records WHERE consumer = 'COMMISSIONS' AND state <> 'DELIVERED'");
    assert.ok(Number(pending[0]!.n) > 0);
    assert.equal(outcome(sw.w, await closePeriod(sw, current, { ledgerCutoffHash: await proposal(sw, current) })), "409 PRECONDITION_FAILED INPUTS_UNRECONCILED");
  } finally {
    sw.standAt(null);
  }
  await unchanged(current, "unreconciled inputs");

  // a ledger that moved after the proposal: the close is refused, never re-cut over another ledger
  const may = await openMonth(sw, "2026-05");
  const stale = await proposal(sw, may);
  await recordHold(sw.h, { ownerUserId: sw.owner.userId as UserId, lineId: eligible, amountCents: 500n, reason: "SELLER_DISPUTE" });
  const changed = await closePeriod(sw, may, { ledgerCutoffHash: stale });
  assert.equal(outcome(sw.w, changed), "409 STALE_VERSION LEDGER_CHANGED");
  await unchanged(may, "a changed ledger");
  assert.deepEqual(await statementsOfSeller(sw, s.sellerId), [], "no statement was issued");

  // a later close — the PERIODS sweep proposing the ledger as it stands and closing through CMD051 under period-close-<periodId> — keeps the
  // lines awaiting their final completion or their funds as reasoned hold items, never payable
  const closed = await sw.periods().run({ limit: 10 });
  assert.deepEqual(closed.items.filter((i) => i.subject === may), [{ subject: may, outcome: "CLOSED" }]);
  assert.equal((await sw.w.journal(`period-close-${may}`))?.state, "COMMITTED");
  const [st] = await statementsOfSeller(sw, s.sellerId);
  assert.ok(st !== undefined);
  const items = await itemsOf(sw, st.statement_id);
  assert.deepEqual(
    items.map((i) => [i.line_id, i.item_kind, i.disposition, i.held_cents, i.payable_cents]),
    [
      [eligible, "LINE", "PAYABLE", "0", "3500"],
      [eligible, "HOLD", "HELD", "500", "0"],
      [awaitingFinal, "LINE", "AWAITING_FINAL_COMPLETION", "0", "0"],
      [awaitingFunds, "LINE", "AWAITING_FUNDS", "0", "0"],
    ],
  );
  assert.deepEqual([st.payable_cents, st.held_cents, st.accrued_pending_cents], ["3500", "500", "5000"]);
  assert.deepEqual(await lineStates(sw, [eligible, awaitingFinal, awaitingFunds]), ["PAYABLE", "ACCRUED_PENDING", "ACCRUED_PENDING"]);
});

// --- CMD051-RACE -----------------------------------------------------------------------------------------------------------------------------

test("RACE: an identical retry replays the 200 with the same statements, the same key with another ledgerCutoffHash is 409 IDEMPOTENCY_CONFLICT, a close racing a refund adjustment serializes on the period in both orders — the adjustment is in this statement or the next, never both or neither — and a crash before COMMIT leaves the period OPEN", async () => {
  // an identical retry replays byte for byte and issues nothing again; the same key with another hash is another request
  const r = await seller(sw, "cmd051-race-replay", WHOLE);
  await eligibleLines(sw, "CMD051 RACE replay", r, WHOLE, [{ basisCents: 6_000n, poolCents: 6_000n }]);
  const june = await openMonth(sw, "2026-06");
  const key = freshKey("cmd051-race");
  const hash = await proposal(sw, june);
  const first = await closePeriod(sw, june, { ledgerCutoffHash: hash }, { key });
  completed<PeriodCloseView>(first, 200);
  const statements = await statementsOfSeller(sw, r.sellerId);
  const replay = await closePeriod(sw, june, { ledgerCutoffHash: hash }, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.deepEqual(await statementsOfSeller(sw, r.sellerId), statements, "the same statements, nothing issued again");
  assert.equal(outcome(sw.w, await closePeriod(sw, june, { ledgerCutoffHash: sha("another ledger") }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await sw.w.journal(key).then((j) => [j?.state, j?.resourceKind, j?.resourceId]), ["COMMITTED", "commission_period", june]);

  // a refund of the line's purchase executed by the payment service: its refund.completed.v1 reaches the COMMISSIONS consumer, whose basis
  // change takes the open periods FOR SHARE before the line's pool (D10-STMT-4)
  const refundOf = async (sold: Awaited<ReturnType<typeof eligibleLines>>): Promise<void> => {
    const refundId = await approvedRefund(sw, sold.selling, sold.lines[0]!.purchase, { serviceCents: 10_000n });
    assert.equal(completed<ExecuteRefundView>(await execute(sw.pw, refundId, { expectedVersion: 2 }), 200).data.refund.state, "COMPLETED");
  };
  const adjustmentOf = async (lineId: string): Promise<string> => {
    const a = await rows<{ adjustment_id: string; direction: string; amount_cents: string }>(sw, "SELECT adjustment_id, direction, amount_cents::text FROM kauro.commission_adjustments WHERE line_id = $1", [lineId]);
    assert.deepEqual(a.map((x) => [x.direction, x.amount_cents]), [["DECREASE", "10000"]], "one adjustment of the refunded 10000 cents of basis at 100%");
    return a[0]!.adjustment_id;
  };
  // every COMMISSIONS record recorded so far delivered (the purchases' captures), so the consumer's only work in a race is the refund
  const drain = async (): Promise<void> => {
    for (;;) {
      const pass = await sw.service.dispatcher.runOnce({ limit: 100 });
      if (pass.deliveries.length < 100) return;
    }
  };
  const reportedIn = async (adjustmentId: string): Promise<string[]> => (await rows<{ statement_id: string }>(sw, "SELECT statement_id FROM kauro.statement_items WHERE adjustment_id = $1", [adjustmentId])).map((x) => x.statement_id);

  // order 1: the close holds the period; the adjustment waits for it, then goes to the next statement
  const t = await seller(sw, "cmd051-race-close-first", WHOLE);
  const soldT = await eligibleLines(sw, "CMD051 RACE close first", t, WHOLE, [{ basisCents: 97_125n, poolCents: 97_125n }]);
  const april = await openMonth(sw, "2026-04");
  await drain();
  const held = sw.serviceHolds.arm("CMD051");
  const closing = closeNow(april);
  await held.reached;
  await refundOf(soldT);
  const dispatching = sw.service.dispatcher.runOnce({ limit: 100 });
  try {
    await waitForLockWait(sw.h.oracle, SERVICE_POOL, "FROM kauro.commission_periods");
  } finally {
    held.release();
  }
  completed<PeriodCloseView>(await closing, 200);
  await dispatching;
  const adjT = await adjustmentOf(soldT.lines[0]!.lineId);
  const [aprilT] = await statementsOfSeller(sw, t.sellerId);
  assert.deepEqual((await itemsOf(sw, aprilT!.statement_id)).map((i) => [i.item_kind, i.disposition, i.payable_cents]), [["LINE", "PAYABLE", "97125"]], "closed before the adjustment existed");
  assert.deepEqual(await reportedIn(adjT), [], "not in the statement closed before it");
  const march = await openMonth(sw, "2026-03");
  completed<PeriodCloseView>(await closeNow(march), 200);
  const [, marchT] = await statementsOfSeller(sw, t.sellerId);
  assert.deepEqual((await itemsOf(sw, marchT!.statement_id)).map((i) => [i.item_kind, i.disposition, i.adjustment_id]), [["ADJUSTMENT", "REPORTED", adjT]], "the PAYABLE line is not itemized again; its adjustment is");
  assert.deepEqual(await reportedIn(adjT), [marchT!.statement_id], "in the next statement, once");

  // order 2: the adjustment holds the period (FOR SHARE) while it waits for its pool; the close waits for it, finds the ledger changed and,
  // proposed again, reports the adjustment in its own statement
  const u = await seller(sw, "cmd051-race-adjust-first", WHOLE);
  const soldU = await eligibleLines(sw, "CMD051 RACE adjustment first", u, WHOLE, [{ basisCents: 97_125n, poolCents: 97_125n }]);
  const february = await openMonth(sw, "2026-02");
  await drain();
  const proposed = await proposal(sw, february);
  await refundOf(soldU);
  const pool = await sw.h.pg.connect("kauro_commission_test");
  try {
    await pool.query("BEGIN");
    await pool.query("SELECT 1 FROM kauro.commission_pools WHERE pool_id = (SELECT pool_id FROM kauro.commission_lines WHERE line_id = $1) FOR UPDATE", [soldU.lines[0]!.lineId]);
    const adjusting = sw.service.dispatcher.runOnce({ limit: 100 });
    let racing: Promise<unknown> | null = null;
    try {
      await waitForLockWait(sw.h.oracle, SERVICE_POOL, "commission_pools");
      racing = closePeriod(sw, february, { ledgerCutoffHash: proposed });
      await waitForLockWait(sw.h.oracle, SERVICE_POOL, "FROM kauro.commission_periods");
    } finally {
      await pool.query("ROLLBACK");
    }
    await adjusting;
    assert.equal(outcome(sw.w, (await racing) as never), "409 STALE_VERSION LEDGER_CHANGED");
  } finally {
    await pool.end();
  }
  const adjU = await adjustmentOf(soldU.lines[0]!.lineId);
  assert.deepEqual(await statementsOfSeller(sw, u.sellerId), [], "the refused close issued nothing");
  completed<PeriodCloseView>(await closeNow(february), 200);
  const [febU] = await statementsOfSeller(sw, u.sellerId);
  assert.deepEqual(
    (await itemsOf(sw, febU!.statement_id)).map((i) => [i.item_kind, i.disposition, i.adjustment_id, i.payable_cents]),
    [
      ["LINE", "PAYABLE", null, "87125"],
      ["ADJUSTMENT", "REPORTED", adjU, "0"],
    ],
  );
  assert.deepEqual(await reportedIn(adjU), [febU!.statement_id], "in this statement, once");

  // a crash before COMMIT: nothing of the close is committed, the period stays OPEN, and the same key closes it afterwards
  const v = await seller(sw, "cmd051-race-crash", WHOLE);
  await eligibleLines(sw, "CMD051 RACE crash", v, WHOLE, [{ basisCents: 8_000n, poolCents: 8_000n }]);
  const january = await openMonth(sw, "2026-01");
  const crashKey = freshKey("cmd051-crash");
  const crashBody = { ledgerCutoffHash: await proposal(sw, january) };
  sw.serviceHolds.arm("CMD051", { fail: new ServiceCrash("before COMMIT") });
  assert.equal(outcome(sw.w, await closePeriod(sw, january, crashBody, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await periodRow(sw, january).then((p) => [p.state, p.close_due_on]), ["OPEN", null]);
  assert.deepEqual(await statementsOfSeller(sw, v.sellerId), []);
  assert.equal(await sw.w.journal(crashKey), null);
  completed<PeriodCloseView>(await closePeriod(sw, january, crashBody, { key: crashKey }), 200);
  assert.equal((await periodRow(sw, january)).state, "CLOSED");
  assert.equal((await statementsOfSeller(sw, v.sellerId)).length, 1);
});
