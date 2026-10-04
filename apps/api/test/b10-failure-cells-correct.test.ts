// The tier-1 GAPs of the B10 failure matrix on the correcting statement of CMD051 (docs/design/B10-failure-matrix.md items 14 to 16, rows K1
// and K2; rulings R-GAP-3 and decision D10-GAP-7), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md): the REAL
// correction of the commission service runs its REAL unit of work over a connection the harness opened (test/fault-support.ts), so a race
// cell observes the correction waiting on the statement's row lock or holding it until its COMMIT, and a partial cell fails after a
// statement of the unit completed. A correction has no route (D10-GAP-7): it is called as the commission service over its runtime.
// PostgreSQL 17 through the runtime login roles; the superuser only reads. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { PayoutIntentView, PeriodCloseView, StatementCorrectionView } from "@kauro/application";
import type { CommandResult } from "@kauro/application";
import { connectionPid, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { approvePayout, bankCash, claimedCents, closeMonth, correctStatement, eligibleLines, itemsOf, resultOf, rows, seller, statementsOfSeller, statementsWorld, type StatementsWorld } from "./statements-support.js";
import type { SqlStep } from "./fault-support.js";
import { completed, freshKey, outcome, type Reply } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const PAYABLE = 5_000n;
type Seller = Awaited<ReturnType<typeof seller>>;
interface Issued {
  readonly s: Seller;
  readonly statementId: string;
  readonly periodId: string;
  readonly version: number;
  readonly lineId: string;
}

type Login = "kauro_app_test" | "kauro_commission_test";
const open = (login: Login): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig(login));
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};

// --- ISSUED statements: six sellers to a month, one 5,000-cent line each; a month is closed once ------------------------------------

let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;
const supply: Issued[] = [];
async function takeIssued(count: number): Promise<Issued[]> {
  while (supply.length < count) {
    const m = nextMonth();
    const sellers: Array<{ s: Seller; lineId: string }> = [];
    for (let i = 0; i < 6; i++) {
      const s = await seller(sw, `corr-${m}-${i}`, WHOLE);
      const sold = await eligibleLines(sw, `corr ${m} ${i}`, s, WHOLE, [{ basisCents: PAYABLE, poolCents: PAYABLE }]);
      sellers.push({ s, lineId: sold.lines[0]!.lineId });
    }
    const { periodId, reply } = await closeMonth(sw, m);
    completed<PeriodCloseView>(reply, 200);
    for (const { s, lineId } of sellers) {
      const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
      assert.ok(st !== undefined, "the close issued the seller's statement");
      supply.push({ s, statementId: st.statement_id, periodId, version: Number(st.version), lineId });
    }
  }
  return supply.splice(0, count);
}

const stateOf = async (statementId: string): Promise<{ state: string; version: number }> => {
  const r = (await rows<{ state: string; version: string }>(sw, "SELECT state, version::text AS version FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!;
  return { state: r.state, version: Number(r.version) };
};
const successorsOf = (statementId: string) => rows<{ statement_id: string; state: string; payable_cents: string; period_id: string }>(sw, "SELECT statement_id, state, payable_cents::text, period_id FROM kauro.commission_statements WHERE corrects_statement_id = $1", [statementId]);
const lineState = async (lineId: string): Promise<string> => (await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_lines WHERE line_id = $1", [lineId]))[0]!.state;
/** The statement items of a line that stand in a live (ISSUED, DISPUTED, APPROVED or PAID) statement: the line is payable through exactly these. */
const liveItems = async (lineId: string): Promise<number> =>
  Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.statement_items i JOIN kauro.commission_statements s ON s.statement_id = i.statement_id WHERE i.line_id = $1 AND i.item_kind = 'LINE' AND i.disposition = 'PAYABLE' AND s.state <> 'CORRECTED'", [lineId]))[0]!.n);
const journalState = async (key: string): Promise<string | null> => (await sw.w.journal(key))?.state ?? null;

/** The real correction of `st` as the commission service, its units of work on `conn`, the harness's `uow.*` points of the cell around its COMMIT. */
function correctOn(ctx: FaultContext, conn: HarnessConnection, statementId: string, expectedVersion: number, options: { readonly key?: string; readonly steps?: ReadonlyArray<SqlStep> } = {}): Promise<CommandResult<StatementCorrectionView>> {
  return sw.faults.on(conn, "kauro_commission", ctx.points, options.steps ?? [], () => correctStatement(sw, statementId, { expectedVersion }, options.key === undefined ? {} : { key: options.key }));
}
const approveBody = async (st: Issued) => ({ expectedVersion: st.version, payeeRef: st.s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) });
function approveOn(ctx: FaultContext, conn: HarnessConnection, st: Issued, body: Awaited<ReturnType<typeof approveBody>>): Promise<Reply> {
  return sw.faults.on(conn, "kauro_app", ctx.points, [], () => approvePayout(sw, st.statementId, body, { token: sw.owner.token }));
}

// --- 1. CORR_APPROVE ---------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CORR_APPROVE",
    step: "CMD051 correcting statement (correction_issued), racing CMD052 ApproveCommissionPayout of the predecessor",
    fault: "race",
    expect:
      "RACE: a correcting statement racing ApproveCommissionPayout of the same statement, in both orders: approval first refuses the correction, correction first makes the approval 409 STALE_VERSION, and no intent ever names a CORRECTED statement",
  },
  async (ctx) => {
    const [first, second] = await takeIssued(2);

    // the correction first (held at its COMMIT, holding the predecessor's row), the approval observed waiting: it finds the statement moved
    {
      const st = first!;
      await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
      const body = await approveBody(st);
      const hc = await open("kauro_commission_test");
      const wc = await open("kauro_app_test");
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const running = ctx.operation("the correction (holder)", () => correctOn(ctx, hc, st.statementId, st.version));
        await pause.reachedBy(running);
        const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (conn) => approveOn(ctx, conn, st, body), "the approval while the correction holds the statement");
        pause.release();
        assert.equal(resultOf(await running), "200", "the correction committed");
        assert.match(outcome(sw.w, await waiting.pending), /^409 STALE_VERSION /, "the approval that waited finds the statement CORRECTED and its version moved");
      } finally {
        await hc.end();
        await wc.end();
      }
      assert.equal((await stateOf(st.statementId)).state, "CORRECTED");
      assert.equal(await intentCount(st.statementId), 0, "no intent names a CORRECTED statement");
      assert.equal((await successorsOf(st.statementId)).length, 1);
    }

    // the approval first (held at its COMMIT), the correction observed waiting: APPROVED has no edge to CORRECTED, nothing is written
    {
      const st = second!;
      await bankCash(sw, (await claimedCents(sw)) + PAYABLE);
      const body = await approveBody(st);
      const hc = await open("kauro_app_test");
      const wc = await open("kauro_commission_test");
      try {
        const pause = ctx.points.pause("uow.before-commit");
        const running = ctx.operation("the approval (holder)", () => approveOn(ctx, hc, st, body));
        await pause.reachedBy(running);
        const waiting = await ctx.mustWait(sw.h.oracle, { waiter: wc, holder: connectionPid(hc) }, (conn) => correctOn(ctx, conn, st.statementId, st.version), "the correction while the approval holds the statement");
        pause.release();
        completed<PayoutIntentView>(await running, 200);
        assert.match(resultOf(await waiting.pending), /^409 STALE_VERSION /, "the correction read the version before the approval: stale, nothing written");
      } finally {
        await hc.end();
        await wc.end();
      }
      const now = await stateOf(st.statementId);
      assert.equal(now.state, "APPROVED");
      assert.equal((await successorsOf(st.statementId)).length, 0, "APPROVED is never corrected");
      // a correction that read the approved version is refused on the machine: APPROVED has no edge to CORRECTED
      assert.equal(resultOf(await correctStatement(sw, st.statementId, { expectedVersion: now.version })), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
      assert.equal((await successorsOf(st.statementId)).length, 0);
      assert.equal(await intentCount(st.statementId), 1, "the one live intent still names the APPROVED statement");
    }
  },
);

const intentCount = async (statementId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId]))[0]!.n);

// --- 2. CORR_DUP -------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CORR_DUP",
    step: "CMD051 correcting statement (correction_issued), the same correction twice",
    fault: "retry",
    expect: "RACE: two corrections of one ISSUED statement on two keys yield one successor and one STALE_VERSION; the same key replays; each line is payable through exactly one live statement item",
  },
  async (ctx) => {
    const [a, b] = await takeIssued(2);

    // the same key twice: the second is the journaled answer
    const key = freshKey("corr-dup");
    const attempts = await ctx.sequentially(2, async () => correctStatement(sw, a!.statementId, { expectedVersion: a!.version }, { key }));
    const [one, two] = [value(attempts[0]!), value(attempts[1]!)];
    assert.equal(resultOf(one), "200");
    assert.equal(resultOf(two), "200");
    assert.deepEqual([one.kind === "COMPLETED" && one.replayed, two.kind === "COMPLETED" && two.replayed], [false, true], "the second answer is the journal's replay");
    assert.equal((await successorsOf(a!.statementId)).length, 1, "one successor");
    assert.equal(await liveItems(a!.lineId), 1, "the line is payable through one live item");

    // another key, the same predecessor and version: one refusal, STALE_VERSION, nothing more written
    const other = await ctx.sequentially(2, async (n) => correctStatement(sw, b!.statementId, { expectedVersion: b!.version }, { key: freshKey(`corr-dup-${n}`) }));
    assert.deepEqual(other.map((r) => resultOf(value(r))), ["200", "409 STALE_VERSION -"]);
    assert.equal((await successorsOf(b!.statementId)).length, 1);
    assert.equal(await liveItems(b!.lineId), 1, "never two live items of one line");

    // a CORRECTED predecessor read at its current version: the machine has no edge from it, nothing written
    const corrected = await stateOf(b!.statementId);
    assert.equal(corrected.state, "CORRECTED");
    const before = await successorsOf(b!.statementId);
    assert.equal(resultOf(await correctStatement(sw, b!.statementId, { expectedVersion: corrected.version })), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
    assert.deepEqual(await successorsOf(b!.statementId), before, "nothing was written");
    assert.deepEqual(await stateOf(b!.statementId), corrected);
    assert.equal(await lineState(b!.lineId), "PAYABLE");
  },
);

// --- 3. CORR_PAR -------------------------------------------------------------------------------------------------------------------

const STATEMENT_INSERT: SqlStep = { label: "successor_insert", match: /INSERT INTO kauro\.commission_statements/ };
const ITEM_INSERT: SqlStep = { label: "item_insert", match: /INSERT INTO kauro\.statement_items/ };
const ISSUE_UPDATE: SqlStep = { label: "issue_update", match: /UPDATE kauro\.commission_statements SET state = 'ISSUED'/ };
const PREDECESSOR_UPDATE: SqlStep = { label: "predecessor_update", match: /UPDATE kauro\.commission_statements s SET/ };

faultCell(
  {
    id: "CORR_PAR",
    step: "CMD051 correcting statement (correction_issued), a failure between issuing the successor and marking the predecessor CORRECTED",
    fault: "partial",
    expect: "RACE (partial): a failure injected after the successor statement is inserted and before the predecessor is marked CORRECTED rolls both back",
  },
  async (ctx) => {
    const cases = [
      { x: (await takeIssued(1))[0]!, at: "db.item_insert.before", what: "the correction failing after the successor row and before its items", steps: [STATEMENT_INSERT, ITEM_INSERT] },
      { x: (await takeIssued(1))[0]!, at: "db.issue_update.before", what: "the correction failing after the items and before the successor ISSUED", steps: [ITEM_INSERT, ISSUE_UPDATE] },
      { x: (await takeIssued(1))[0]!, at: "db.predecessor_update.before", what: "the correction failing after the successor ISSUED and before the predecessor CORRECTED", steps: [ISSUE_UPDATE, PREDECESSOR_UPDATE] },
    ];
    for (const { x, at, what, steps } of cases) {
      const key = freshKey("corr-par");
      const conn = await open("kauro_commission_test");
      try {
        // the unit crashes at the point (not a DomainFailure): the service command rethrows it, nothing is journaled
        await ctx.partial(what, at, () => correctOn(ctx, conn, x.statementId, x.version, { key, steps }));
      } finally {
        await conn.end();
      }
      assert.deepEqual(await successorsOf(x.statementId), [], `${what}: no successor row survives`);
      assert.deepEqual(await stateOf(x.statementId), { state: "ISSUED", version: x.version }, "the predecessor is unchanged");
      assert.equal(await lineState(x.lineId), "PAYABLE");
      assert.equal(await liveItems(x.lineId), 1, "the line stays payable through its one item");
      assert.equal(await journalState(key), null, "no journal result");
      assert.equal((await itemsOf(sw, x.statementId)).length, 1);
      // the same key then corrects once
      const retried = await correctStatement(sw, x.statementId, { expectedVersion: x.version }, { key });
      assert.equal(resultOf(retried), "200");
      assert.equal((await successorsOf(x.statementId)).length, 1);
      assert.equal(await liveItems(x.lineId), 1);
    }
  },
);
