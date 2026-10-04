// The tier-1 GAPs of the B10 failure matrix on the payout commands (docs/design/B10-failure-matrix.md "GAP list, by risk" -> "Tier 1"),
// each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL route of CMD052 / CMD053 runs its REAL unit of work
// over a connection the harness opened (test/fault-support.ts), so a race cell observes the command itself waiting on the holder's
// lock, a crash cell dies at the COMMIT boundary, a partial cell fails after a statement of the unit completed. PostgreSQL 17 through
// the runtime login roles; the superuser only reads. Nothing sleeps. Titles are the matrix's proposed titles.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { PayoutIntentView, PeriodCloseView } from "@kauro/application";
import { connectionPid, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import {
  approvePayout,
  bankCash,
  claimedCents,
  closeMonth,
  eligibleLines,
  rows,
  seller,
  statementsOfSeller,
  statementsWorld,
  type LineSpec,
  type StatementsWorld,
} from "./statements-support.js";
import { completed, outcome, type Reply } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
type Seller = Awaited<ReturnType<typeof seller>>;
interface Issued {
  readonly s: Seller;
  readonly statementId: string;
  readonly version: number;
  readonly payable: bigint;
  readonly lineIds: string[];
}

/** One seller per spec, each with its lines; the month closed through CMD051: each seller's ISSUED statement. */
async function issued(month: string, specs: ReadonlyArray<ReadonlyArray<LineSpec>>, label: string): Promise<Issued[]> {
  const sellers: Array<{ s: Seller; lines: string[] }> = [];
  for (let i = 0; i < specs.length; i++) {
    const s = await seller(sw, `${label}-${i}`, WHOLE);
    const sold = await eligibleLines(sw, `${label}-${i} ${month}`, s, WHOLE, specs[i]!);
    sellers.push({ s, lines: sold.lines.map((l) => l.lineId) });
  }
  const { periodId, reply } = await closeMonth(sw, month);
  completed<PeriodCloseView>(reply, 200);
  const out: Issued[] = [];
  for (const { s, lines } of sellers) {
    const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
    assert.ok(st !== undefined, "the close issued the seller's statement");
    out.push({ s, statementId: st.statement_id, version: Number(st.version), payable: BigInt(st.payable_cents), lineIds: lines });
  }
  return out;
}

const approveBody = async (st: Issued, payeeRef = st.s.destinationId) => ({ expectedVersion: st.version, payeeRef, authorizationRef: await sw.w.stepUp(sw.owner) });
const intentCount = async (statementId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId]))[0]!.n);
const statementState = async (statementId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!.state;

/** The real CMD052 route for `st`, its units of work on `conn`, the harness's `uow.*` points of the cell around its COMMIT. */
async function approveOn(ctx: FaultContext, conn: HarnessConnection, st: Issued, options: { readonly key?: string; readonly payeeRef?: string } = {}): Promise<Reply> {
  const body = await approveBody(st, options.payeeRef);
  return sw.faults.on(conn, "kauro_app", ctx.points, [], () => approvePayout(sw, st.statementId, body, options.key === undefined ? {} : { key: options.key }));
}

type Login = "kauro_app_test" | "kauro_payment_test" | "kauro_commission_test" | "kauro_control_test";
interface Actor<T> {
  readonly login: Login;
  run(conn: HarnessConnection): Promise<T>;
}
const actor = <T>(login: Login, run: (conn: HarnessConnection) => Promise<T>): Actor<T> => ({ login, run });
const asApp = <T>(run: (conn: HarnessConnection) => Promise<T>): Actor<T> => actor("kauro_app_test", run);
const open = (login: Login): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig(login));

/**
 * The holder's real command held at a point of the cell (default: its COMMIT, every write done and every lock kept), and a second actor
 * observed waiting on it (ctx.mustWait: its own statement blocked by the holder's backend); then the holder goes on. Both outcomes come back.
 */
async function holdAndWait<H, W>(ctx: FaultContext, what: string, holder: Actor<H>, waiter: Actor<W>, at = "uow.before-commit"): Promise<{ readonly held: PromiseSettledResult<H>; readonly waited: PromiseSettledResult<W> }> {
  const hc = await open(holder.login);
  const wc = await open(waiter.login);
  try {
    const pause = ctx.points.pause(at);
    const running = ctx.operation(`${what} (holder)`, () => holder.run(hc));
    const settledHolder = running.then<PromiseSettledResult<H>, PromiseSettledResult<H>>((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    await pause.reachedBy(running);
    const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (c) => waiter.run(c), what);
    pause.release();
    return { held: await settledHolder, waited: await waiting.pending };
  } finally {
    await hc.end();
    await wc.end();
  }
}
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

// --- 1. PAY_CASH_RACE ---------------------------------------------------------------------------------------------------------------

let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;

faultCell(
  {
    id: "PAY_CASH_RACE",
    step: "CMD052 ApproveCommissionPayout, bank-available cash read of two statements",
    fault: "race",
    expect: "RACE: two ApproveCommissionPayout calls on two statements whose payables each fit the bank-available cash but not together admit one intent and refuse the other FUNDS_UNAVAILABLE, in both orders",
  },
  async (ctx) => {
    const [a, b, c, d] = await issued(nextMonth(), [[{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }], [{ basisCents: 6_000n, poolCents: 6_000n }]], "cash-race");
    for (const [first, second] of [[a!, b!], [d!, c!]] as const) {
      // cash for one of the two payables and not for both
      await bankCash(sw, (await claimedCents(sw)) + 6_000n + 5_999n);
      const { held, waited } = await holdAndWait(
        ctx,
        `the approval of ${second.statementId} while the approval of ${first.statementId} holds the cash`,
        asApp((conn) => approveOn(ctx, conn, first)),
        asApp((conn) => approveOn(ctx, conn, second)),
      );
      completed<PayoutIntentView>(value(held), 200);
      assert.equal(outcome(sw.w, value(waited)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", "the second approval finds the first one's claim and the cash does not cover both");
      assert.equal(await intentCount(first.statementId), 1);
      assert.equal(await intentCount(second.statementId), 0);
      assert.equal(await statementState(second.statementId), "ISSUED");
    }
  },
);

// --- 2. PAY_CASH_BASIS --------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "PAY_CASH_BASIS",
    step: "CMD052 ApproveCommissionPayout, bank-available cash against a newer bank-evidenced settlement",
    fault: "race",
    expect:
      "RACE: a settlement that lowers the bank-available cash committing while ApproveCommissionPayout holds its cash read, in both orders: the approval uses one consistent cash basis and is FUNDS_UNAVAILABLE rather than spending cash shown only by the stale snapshot",
  },
  async (ctx) => {
    const [a, b] = await issued(nextMonth(), [[{ basisCents: 7_000n, poolCents: 7_000n }], [{ basisCents: 7_000n, poolCents: 7_000n }]], "cash-basis");
    const settle = (cents: bigint) => actor("kauro_payment_test", (conn) => bankCash(sw, cents, sw.faults.unit(conn, "kauro_payment", ctx.points) as never));

    // approval first (holding the cash it read), the lowering settlement observed waiting for it: the approval spent the basis it read, consistently
    await bankCash(sw, (await claimedCents(sw)) + 7_000n);
    const first = await holdAndWait(ctx, "the settlement lowering the cash while the approval holds its cash read", asApp((conn) => approveOn(ctx, conn, a!)), settle((await claimedCents(sw)) - 1n));
    completed<PayoutIntentView>(value(first.held), 200);
    value(first.waited);
    assert.equal(await intentCount(a!.statementId), 1, "the approval committed on the basis it read; the settlement then landed after it");

    // settlement first (holding its lock), the approval observed waiting: it reads the lowered cash and is refused
    const claimed = await claimedCents(sw);
    const second = await holdAndWait(ctx, "the approval while the settlement lowering the cash is held", settle(claimed + 6_999n), asApp((conn) => approveOn(ctx, conn, b!)));
    value(second.held);
    assert.equal(outcome(sw.w, value(second.waited)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE", "the lowered cash is the basis: one cent short of the payable");
    assert.equal(await intentCount(b!.statementId), 0);
    assert.equal(await statementState(b!.statementId), "ISSUED");
  },
);
