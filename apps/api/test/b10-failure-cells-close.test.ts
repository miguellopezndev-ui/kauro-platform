// The tier-1 GAPs of the B10 failure matrix on CMD051 CloseCommissionPeriod and its statements (docs/design/B10-failure-matrix.md "GAP list, by
// risk" -> "Tier 1"), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL route of CMD051 runs its REAL unit of
// work over a connection the harness opened (test/fault-support.ts), so a race cell observes the close itself waiting on the holder's lock or
// holding it until its COMMIT. PostgreSQL 17 through the runtime login roles; the superuser only reads. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PeriodCloseView } from "@kauro/application";
import { connectionPid, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { acquired, approvePayout, bankCash, claimedCents, closeMonth, closePeriod, drainCommissions, eligibleLines, itemsOf, openMonth, proposal, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import { purchase } from "./commission-support.js";
import { createCommissionService } from "../src/index.js";
import { completed, ids, outcome, type Reply } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const CLOSE_AT = "2026-10-07T17:00:00Z";
let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;

type Login = "kauro_app_test" | "kauro_commission_test";
const open = (login: Login): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig(login));
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

/** The real CMD051 route on `conn` (the service's units of work stand on the labelled TEST CLOCK at the close instant). */
function closeOn(ctx: FaultContext, conn: HarnessConnection, periodId: string, ledgerCutoffHash: string): Promise<Reply> {
  sw.standAt(CLOSE_AT);
  return sw.faults.on(conn, "kauro_commission", ctx.points, [], () => closePeriod(sw, periodId, { ledgerCutoffHash })).finally(() => sw.standAt(null));
}

/** The owner's hold on a line as statements on `conn`, in the owner's session (the writer's own statement: PgCommissionLedgerRepository.openHold). */
async function holdOn(conn: HarnessConnection, lineId: string, cents: bigint, options: { readonly commit: boolean }): Promise<string> {
  const holdId = ids.next();
  await conn.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await conn.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [sw.owner.userId]);
    await conn.query(
      `INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at)
       SELECT $1, l.agency_id, l.line_id, l.seller_id, $3, 'SELLER_DISPUTE', $4::timestamptz, kauro.server_now(), now(), now() FROM kauro.commission_lines l WHERE l.line_id = $2`,
      [holdId, lineId, cents, new Date(Date.now() + 14 * 24 * 3_600_000).toISOString()],
    );
    if (options.commit) await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  }
  return holdId;
}

const statementOf = async (sellerId: string, periodId: string) => (await statementsOfSeller(sw, sellerId)).find((x) => x.period_id === periodId);

/** The owner's CMD052 of the statement at its current version to the seller's destination, the cash made to cover it (B10G-R2). */
async function approveStatement(st: { readonly statement_id: string; readonly version: string; readonly payable_cents: string }, destinationId: string): Promise<Reply> {
  await bankCash(sw, (await claimedCents(sw)) + BigInt(st.payable_cents));
  return approvePayout(sw, st.statement_id, { expectedVersion: Number(st.version), payeeRef: destinationId, authorizationRef: await sw.w.stepUp(sw.owner) });
}
const intentsOf = async (statementId: string): Promise<number> => Number((await sw.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId])).rows[0]!.n);

// --- 1. CLOSE_HOLD_RACE -------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CLOSE_HOLD_RACE",
    step: "CMD051 CloseCommissionPeriod, a hold committed between the cutoff and input reads and the statement COMMIT",
    fault: "race",
    expect:
      "RACE: a full hold and a partial hold each committed between CloseCommissionPeriod's cutoff/input reads and its statement COMMIT, in both orders: the close refuses with STALE_VERSION LEDGER_CHANGED or the statement withholds exactly the held cents; e.g. a 1000-cent partial hold on an eligible 10000-cent line yields 9000 PAYABLE and 1000 withheld, and the whole line is excluded only for a covering hold; the held cents are never PAYABLE",
  },
  async (ctx) => {
    for (const [kind, cents] of [["partial", 1_000n], ["full", 10_000n]] as const) {
      // the hold first (uncommitted): the close, proposed before it, waits on the line the hold names, then finds the ledger changed
      {
        const s = await seller(sw, `hold-race-${kind}-first`, WHOLE);
        const sold = await eligibleLines(sw, `hold race ${kind} first`, s, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]);
        const periodId = await openMonth(sw, nextMonth());
        await drainCommissions(sw);
        const proposed = await proposal(sw, periodId);
        const holding = await open("kauro_app_test");
        const closing = await open("kauro_commission_test");
        try {
          await holdOn(holding, sold.lines[0]!.lineId, cents, { commit: false });
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: closing, holder: connectionPid(holding) }, (conn) => closeOn(ctx, conn, periodId, proposed), `the close while a ${kind} hold is uncommitted`);
          await holding.query("COMMIT");
          assert.equal(outcome(sw.w, value(await waiting.pending)), "409 STALE_VERSION LEDGER_CHANGED", "the close proposed before the hold is not the ledger that stands");
        } finally {
          await holding.end();
          await closing.end();
        }
        assert.equal(await statementOf(s.sellerId, periodId), undefined, "nothing was issued");
        // proposed again over the ledger with the hold: the statement withholds exactly the held cents
        sw.standAt(CLOSE_AT);
        try {
          completed<PeriodCloseView>(await closePeriod(sw, periodId, { ledgerCutoffHash: await proposal(sw, periodId) }), 200);
        } finally {
          sw.standAt(null);
        }
        const st = (await statementOf(s.sellerId, periodId))!;
        assert.deepEqual([st.payable_cents, st.held_cents], [String(10_000n - cents), String(cents)], `${kind}: the held cents are never PAYABLE`);
        const items = await itemsOf(sw, st.statement_id);
        assert.deepEqual(
          items.map((i) => [i.disposition, i.held_cents, i.payable_cents]),
          kind === "full" ? [["HELD", "10000", "0"]] : [["PAYABLE", "0", "9000"], ["HELD", "1000", "0"]],
          "the whole line is excluded only by a covering hold; a partial hold withholds exactly its cents",
        );
        // a nearby valid control (B10G-R2): the hold the statement itself withholds does not block paying the rest of the line
        if (kind === "partial") {
          completed<PayoutIntentView>(await approveStatement(st, s.destinationId), 200);
          assert.equal(await intentsOf(st.statement_id), 1, "the 9000 payable cents are authorized; the withheld 1000 are not");
        }
      }

      // the close first (held at its COMMIT, the lines locked): the hold waits for it and is ordered after the statement it did not change
      {
        const s = await seller(sw, `hold-race-${kind}-second`, WHOLE);
        const sold = await eligibleLines(sw, `hold race ${kind} second`, s, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]);
        const periodId = await openMonth(sw, nextMonth());
        await drainCommissions(sw);
        const proposed = await proposal(sw, periodId);
        const closing = await open("kauro_commission_test");
        const holding = await open("kauro_app_test");
        try {
          const pause = ctx.points.pause("uow.before-commit");
          const running = ctx.operation("the close (holder)", () => closeOn(ctx, closing, periodId, proposed));
          await pause.reachedBy(running);
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: holding, holder: connectionPid(closing) }, (conn) => holdOn(conn, sold.lines[0]!.lineId, cents, { commit: true }), `a ${kind} hold while the close is held`);
          pause.release();
          completed<PeriodCloseView>(await running, 200);
          const settled = await waiting.pending;
          const st = (await statementOf(s.sellerId, periodId))!;
          assert.deepEqual([st.payable_cents, st.held_cents], ["10000", "0"], "the statement is the ledger the close read: the hold arrived after it");
          value(settled);
          // B10G-R2: the hold committed after the close now holds cents the statement calls payable; the payout of the old payable is refused
          assert.equal(outcome(sw.w, await approveStatement(st, s.destinationId)), "409 STALE_VERSION LEDGER_CHANGED", `${kind}: held cents are never authorized`);
          assert.equal(await intentsOf(st.statement_id), 0);
        } finally {
          await closing.end();
          await holding.end();
        }
      }
    }

    // B10G-R2: CMD052 racing a hold on a payable line of its statement, both orders. The approval takes the shared half of each payable
    // line's transition subject and a hold insert its exclusive half: a hold in flight is waited for and refuses the approval
    // (STALE_VERSION LEDGER_CHANGED); an approval in flight is waited for by the hold, which lands after the intent (the dispute path, B12).
    const orders = ["hold-first", "approval-first"] as const;
    const racers = [];
    for (const order of orders) {
      const s = await seller(sw, `approve-hold-${order}`, WHOLE);
      racers.push({ order, s, sold: await eligibleLines(sw, `approve hold ${order}`, s, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]) });
    }
    const closed = await closeMonth(sw, nextMonth());
    completed<PeriodCloseView>(closed.reply, 200);
    for (const { order, s, sold } of racers) {
      const st = (await statementOf(s.sellerId, closed.periodId))!;
      await bankCash(sw, (await claimedCents(sw)) + BigInt(st.payable_cents));
      const body = { expectedVersion: Number(st.version), payeeRef: s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) };
      const holding = await open("kauro_app_test");
      const approving = await open("kauro_app_test");
      const approve = (conn: HarnessConnection): Promise<Reply> => sw.faults.on(conn, "kauro_app", ctx.points, [], () => approvePayout(sw, st.statement_id, body));
      try {
        if (order === "hold-first") {
          await holdOn(holding, sold.lines[0]!.lineId, 1_000n, { commit: false });
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: approving, holder: connectionPid(holding) }, approve, "the approval while a hold on its payable line is uncommitted");
          await holding.query("COMMIT");
          assert.equal(outcome(sw.w, value(await waiting.pending)), "409 STALE_VERSION LEDGER_CHANGED", "the hold in flight is read: its cents are never authorized");
          assert.equal(await intentsOf(st.statement_id), 0);
        } else {
          const pause = ctx.points.pause("uow.before-commit");
          const running = ctx.operation("the approval (holder)", () => approve(approving));
          await pause.reachedBy(running);
          const waiting = await ctx.mustWait(sw.h.oracle, { waiter: holding, holder: connectionPid(approving) }, (conn) => holdOn(conn, sold.lines[0]!.lineId, 1_000n, { commit: true }), "a hold while the approval is held");
          pause.release();
          completed<PayoutIntentView>(await running, 200);
          value(await waiting.pending);
          assert.equal(await intentsOf(st.statement_id), 1, "the approval read the line before the hold; the hold is ordered after the intent");
        }
      } finally {
        await holding.end();
        await approving.end();
      }
    }
  },
);

// --- 2a. CLOSE_VS_DELIVERY, the race (Codex r1 B10G-R5) ------------------------------------------------------------------------------

/** Every COMMISSIONS record recorded so far delivered (the service's own dispatcher), so the cell's record is the only one in flight. */
const drain = (): Promise<void> => drainCommissions(sw);

/** The capture.completed.v1 delivery of a purchase to COMMISSIONS, as the dispatcher hands it to the consumer. */
async function deliveryOf(captureId: string): Promise<never> {
  const r = await sw.h.oracle.query<{ event_id: string; event_type: string; agency_id: string; aggregate_id: string; aggregate_version: number; payload: Record<string, unknown> }>(
    `SELECT e.event_id, e.event_type, e.agency_id, e.aggregate_id, e.aggregate_version, e.payload FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id
      WHERE o.consumer = 'COMMISSIONS' AND o.state <> 'DELIVERED' AND e.event_type = 'capture.completed.v1' AND e.aggregate_id = $1`,
    [captureId],
  );
  const e = r.rows[0];
  assert.ok(e !== undefined, "the purchase's capture.completed.v1 waits for COMMISSIONS, undelivered");
  return { eventId: e.event_id, eventType: e.event_type, agencyId: e.agency_id, aggregateId: e.aggregate_id, aggregateVersion: e.aggregate_version, payload: e.payload } as never;
}

faultCell(
  {
    id: "CLOSE_VS_DELIVERY",
    step: "CMD051 CloseCommissionPeriod, a COMMISSIONS delivery of a record created after the period's end racing the close",
    fault: "race",
    expect:
      "RACE: a COMMISSIONS record created after the period's end and before the close (endsAt < created_at < close) delivered while the close runs, in both orders: the delivery first makes the close wait, then refuse INPUTS_UNRECONCILED until the record is delivered, and the close proposed again carries the line; the close first makes the delivery wait, and the line it creates after the close is the next statement's; never a line omitted from both",
  },
  async (ctx) => {
    // the consumer whose units run on the cell's harness connections (faults.on): the real COMMISSIONS effect
    const routed = createCommissionService({ assembly: { units: sw.faults.wrap(sw.pools.units), completions: sw.completions }, environment: "LOCAL", clock: sw.clock, ids });
    const deliver = (conn: HarnessConnection, delivery: never): Promise<unknown> => sw.faults.on(conn, "kauro_commission", ctx.points, [], () => routed.consumer.handle(delivery));
    const lineOf = async (captureId: string): Promise<string | undefined> => (await sw.h.oracle.query<{ line_id: string }>("SELECT line_id FROM kauro.commission_lines WHERE capture_id = $1", [captureId])).rows[0]?.line_id;
    const statementLines = async (periodId: string, sellerId: string): Promise<string[]> => {
      const st = await statementOf(sellerId, periodId);
      return st === undefined ? [] : (await itemsOf(sw, st.statement_id)).flatMap((i) => (i.line_id === null ? [] : [i.line_id]));
    };

    // the close first (held at its COMMIT, the period locked): the record is created and delivered while it holds; the delivery waits, and
    // its line, created after the close, is the next statement's (the next close below)
    let late: { readonly sellerId: string; readonly lineId: string };
    {
      const s = await seller(sw, "delivery-race-second", WHOLE);
      const { selling } = await acquired(sw, "delivery race second", s, WHOLE);
      const periodId = await openMonth(sw, nextMonth());
      await drain();
      const proposed = await proposal(sw, periodId);
      const closing = await open("kauro_commission_test");
      const delivering = await open("kauro_commission_test");
      let captureId = "";
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const running = ctx.operation("the close (holder)", () => closeOn(ctx, closing, periodId, proposed));
        await pause.reachedBy(running);
        const p = await purchase(sw, selling, "delivery-race-second");
        captureId = p.captureId;
        const delivery = await deliveryOf(p.captureId);
        const waiting = await ctx.mustWait(sw.h.oracle, { waiter: delivering, holder: connectionPid(closing) }, (conn) => deliver(conn, delivery), "the delivery while the close holds the period");
        pause.release();
        completed<PeriodCloseView>(await running, 200);
        value(await waiting.pending);
      } finally {
        await closing.end();
        await delivering.end();
      }
      const lineId = await lineOf(captureId);
      assert.ok(lineId !== undefined, "the delivery accrued the purchase's line after the close");
      assert.deepEqual(await statementLines(periodId, s.sellerId), [], "the closed period's statement set has no line created after it");
      late = { sellerId: s.sellerId, lineId: lineId! };
    }

    // the delivery first (held at its COMMIT, holding the open periods FOR SHARE): the close waits for it, then finds the record undelivered
    {
      const s = await seller(sw, "delivery-race-first", WHOLE);
      const { selling } = await acquired(sw, "delivery race first", s, WHOLE);
      const periodId = await openMonth(sw, nextMonth());
      const period = (await sw.h.oracle.query<{ ends_at: Date }>("SELECT ends_at FROM kauro.commission_periods WHERE period_id = $1", [periodId])).rows[0]!;
      await drain();
      const p = await purchase(sw, selling, "delivery-race-first");
      const record = (await sw.h.oracle.query<{ created_at: Date }>("SELECT o.created_at FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE o.consumer = 'COMMISSIONS' AND e.aggregate_id = $1 AND e.event_type = 'capture.completed.v1'", [p.captureId])).rows[0]!;
      assert.ok(record.created_at > period.ends_at && record.created_at < new Date(CLOSE_AT), "the record is created after the period's end and before the close");
      const proposed = await proposal(sw, periodId);
      const delivery = await deliveryOf(p.captureId);
      const delivering = await open("kauro_commission_test");
      const closing = await open("kauro_commission_test");
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const running = ctx.operation("the delivery (holder)", () => deliver(delivering, delivery));
        await pause.reachedBy(running);
        const waiting = await ctx.mustWait(sw.h.oracle, { waiter: closing, holder: connectionPid(delivering) }, (conn) => closeOn(ctx, conn, periodId, proposed), "the close while the delivery holds the open periods");
        pause.release();
        await running;
        assert.equal(outcome(sw.w, value(await waiting.pending)), "409 PRECONDITION_FAILED INPUTS_UNRECONCILED", "the record created before the close is not yet delivered");
      } finally {
        await delivering.end();
        await closing.end();
      }
      const lineId = await lineOf(p.captureId);
      assert.ok(lineId !== undefined, "the delivery accrued the purchase's line");
      await drain();
      sw.standAt(CLOSE_AT);
      try {
        completed<PeriodCloseView>(await closePeriod(sw, periodId, { ledgerCutoffHash: await proposal(sw, periodId) }), 200);
      } finally {
        sw.standAt(null);
      }
      assert.deepEqual(await statementLines(periodId, s.sellerId), [lineId], "the close proposed again carries the delivered line");
      assert.deepEqual(await statementLines(periodId, late.sellerId), [late.lineId], "the line created after the earlier close is this next statement's: never omitted from both");
    }
  },
);

// --- 2. CLOSE_VS_DELIVERY (ruling R-GAP-2: the input is the COMMISSIONS records CREATED before the close, never occurred_at) -----------

test("CLOSE_VS_DELIVERY [deny] CMD051 CloseCommissionPeriod, a COMMISSIONS record created after the close -> DENY: a line whose record occurred inside the period but was created after the period's close is absent from the closed statement and present in the next one", async () => {
  const first = await seller(sw, "late-delivery-first", WHOLE);
  await eligibleLines(sw, "late delivery first", first, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]);
  const m1 = nextMonth();
  const closed = await closeMonth(sw, m1);
  completed<PeriodCloseView>(closed.reply, 200);
  const st1 = (await statementOf(first.sellerId, closed.periodId))!;
  assert.deepEqual([st1.payable_cents, st1.held_cents], ["10000", "0"]);

  // the late delivery: its line is created now, after m1's close COMMIT, whatever instant its capture occurred at
  const late = await seller(sw, "late-delivery-second", WHOLE);
  const sold = await eligibleLines(sw, "late delivery second", late, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]);
  const lateLine = sold.lines[0]!.lineId;
  assert.equal(await statementOf(late.sellerId, closed.periodId), undefined, "the closed statement set has nobody's late line");
  assert.ok(!(await itemsOf(sw, st1.statement_id)).some((i) => i.line_id === lateLine), "the closed statement itemizes only what was created before it");

  const m2 = nextMonth();
  const next = await closeMonth(sw, m2);
  completed<PeriodCloseView>(next.reply, 200);
  const st2 = (await statementOf(late.sellerId, next.periodId))!;
  assert.deepEqual((await itemsOf(sw, st2.statement_id)).map((i) => [i.line_id, i.disposition, i.payable_cents]), [[lateLine, "PAYABLE", "10000"]], "the next statement carries it");
});
