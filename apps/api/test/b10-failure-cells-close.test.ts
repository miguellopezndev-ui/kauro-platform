// The tier-1 GAPs of the B10 failure matrix on CMD051 CloseCommissionPeriod and its statements (docs/design/B10-failure-matrix.md "GAP list, by
// risk" -> "Tier 1"), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL route of CMD051 runs its REAL unit of
// work over a connection the harness opened (test/fault-support.ts), so a race cell observes the close itself waiting on the holder's lock or
// holding it until its COMMIT. PostgreSQL 17 through the runtime login roles; the superuser only reads. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { PeriodCloseView } from "@kauro/application";
import { connectionPid, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { closePeriod, eligibleLines, itemsOf, openMonth, proposal, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
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
      }

      // the close first (held at its COMMIT, the lines locked): the hold waits for it and is ordered after the statement it did not change
      {
        const s = await seller(sw, `hold-race-${kind}-second`, WHOLE);
        const sold = await eligibleLines(sw, `hold race ${kind} second`, s, WHOLE, [{ basisCents: 10_000n, poolCents: 10_000n }]);
        const periodId = await openMonth(sw, nextMonth());
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
        } finally {
          await closing.end();
          await holding.end();
        }
      }
    }
  },
);
