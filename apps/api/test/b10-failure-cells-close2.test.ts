// The tier-1 GAPs 17 to 22 of the B10 failure matrix on the CMD051 close and correction family (docs/design/B10-failure-matrix.md "GAP list, by
// risk" -> "Tier 1"; items CORR_CRASH, CORR_AUTH, CLOSEP_PAR, CLOSE_CAL, CLOSE_CRA, CLOSE_TMO), each a cell of the common fault harness
// (docs/design/FAULT-HARNESS.md) where the harness can prove the fault: the REAL route of CMD051 (or the REAL correction of the commission
// service, or the REAL PERIODS sweep) runs its REAL unit of work over a connection the harness opened (test/fault-support.ts). PostgreSQL 17
// through the runtime login roles; the superuser only reads, or holds the lock a timeout cell waits on. Nothing sleeps.
//
// The months of this file close at LATER (2027-01-10, after every 2026 month's 5th banking day) so twelve months are available and the
// PERIODS sweep of the sweep cells (which opens the month it stands in) never meets a month a cell uses.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sha256Hex, UtcInstant } from "@kauro/contracts";
import { closeCommissionPeriod, correctCommissionStatement, type CommandResult, type PeriodCloseView, type StatementCorrectionView } from "@kauro/application";
import type { CorrelationId } from "@kauro/domain";
import { connectionPid, crashedAt, faultCell, FaultPoints, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { FIXTURE_CALENDAR, closeInstant, closePeriod, correctStatement, drainCommissions, eligibleLines, itemsOf, openMonth, periodRow, proposal, resultOf, rows, seller, statementsOfSeller, statementsWorld, StandingUnits, type StatementsWorld } from "./statements-support.js";
import type { SqlStep } from "./fault-support.js";
import { createCommissionService } from "../src/index.js";
import { statementServiceRuntime } from "../src/commissions/routes.js";
import { RecordedBankingCalendarSource } from "@kauro/persistence";
import { createPeriodsSweep, periodCloseKey } from "../src/commissions/periods.js";
import { asProblem, completed, freshKey, ids, outcome, sha, type Reply } from "./support.js";

let sw: StatementsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.h.oracle);
before(async () => {
  sw = await statementsWorld();
  LATER = await closeInstant(sw, LATER_FLOOR);
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const LATER_FLOOR = "2027-01-10T17:00:00Z";
// LATER_FLOOR, or the DATABASE clock + 1 h once real time has overtaken it (set in `before`; a record's created_at is real database time)
let LATER = LATER_FLOOR;
const LINE = 10_000n;
let month = 0;
const nextMonth = (): string => `2026-${String(++month).padStart(2, "0")}`;

type Login = "kauro_app_test" | "kauro_commission_test" | "postgres";
const open = (login: Login): Promise<HarnessConnection> => openConnection(sw.h.pg.clientConfig(login));
const value = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status !== "fulfilled") throw r.reason;
  return r.value;
};
const journalState = async (key: string): Promise<string | null> => (await sw.w.journal(key))?.state ?? null;

/** The real CMD051 route on `conn`, the commission service's units standing at LATER on the TEST CLOCK. */
function closeOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, periodId: string, ledgerCutoffHash: string, options: { readonly key?: string; readonly steps?: ReadonlyArray<SqlStep> } = {}): Promise<Reply> {
  sw.standAt(LATER);
  return sw.faults.on(conn, "kauro_commission", ctx.points, options.steps ?? [], () => closePeriod(sw, periodId, { ledgerCutoffHash }, options.key === undefined ? {} : { key: options.key })).finally(() => sw.standAt(null));
}

/** The real correction of the commission service on `conn`. */
function correctOn(ctx: FaultContext, conn: HarnessConnection, statementId: string, expectedVersion: number, options: { readonly key?: string } = {}): Promise<CommandResult<StatementCorrectionView>> {
  return sw.faults.on(conn, "kauro_commission", ctx.points, [], () => correctStatement(sw, statementId, { expectedVersion }, options.key === undefined ? {} : { key: options.key }));
}

/** A period of `month` with the seller's lines, delivered and proposed: the hash of the close the cell races or fails. */
let labels = 0;
async function readyPeriod(label: string, lines: number, options: { readonly partialHold?: boolean } = {}): Promise<{ readonly s: Awaited<ReturnType<typeof seller>>; readonly periodId: string; readonly proposed: string; readonly lineIds: string[] }> {
  const unique = `${label}-${++labels}`;
  const s = await seller(sw, unique, WHOLE);
  const sold = await eligibleLines(sw, unique, s, WHOLE, Array.from({ length: lines }, () => ({ basisCents: LINE, poolCents: LINE })));
  const lineIds = sold.lines.map((l) => l.lineId);
  if (options.partialHold === true) {
    const holder = await open("kauro_app_test");
    try {
      await holdOn(holder, lineIds[lines - 1]!, 1_000n);
    } finally {
      await holder.end();
    }
  }
  const periodId = await openMonth(sw, nextMonth());
  await drainCommissions(sw);
  return { s, periodId, proposed: await proposal(sw, periodId), lineIds };
}

/** The owner's partial hold on a line, committed (the writer's own statement: PgCommissionLedgerRepository.openHold). */
async function holdOn(conn: HarnessConnection, lineId: string, cents: bigint): Promise<void> {
  await conn.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await conn.query("SELECT set_config('kauro.agency_id', '', true), set_config('kauro.user_id', $1, true), set_config('kauro.finance_agency_id', '', true)", [sw.owner.userId]);
    await conn.query(
      `INSERT INTO kauro.commission_holds (hold_id, agency_id, line_id, seller_id, amount_cents, reason, review_at, opened_at, created_at, updated_at)
       SELECT $1, l.agency_id, l.line_id, l.seller_id, $3, 'SELLER_DISPUTE', $4::timestamptz, kauro.server_now(), now(), now() FROM kauro.commission_lines l WHERE l.line_id = $2`,
      [ids.next(), lineId, cents, new Date(Date.now() + 14 * 24 * 3_600_000).toISOString()],
    );
    await conn.query("COMMIT");
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  }
}

const statementOf = async (sellerId: string, periodId: string) => (await statementsOfSeller(sw, sellerId)).find((x) => x.period_id === periodId);
const statementsOfPeriod = async (periodId: string): Promise<string[]> => (await rows<{ statement_id: string }>(sw, "SELECT statement_id FROM kauro.commission_statements WHERE period_id = $1 ORDER BY statement_id", [periodId])).map((r) => r.statement_id);
const lineStates = async (lineIds: ReadonlyArray<string>): Promise<string[]> => {
  const r = await rows<{ line_id: string; state: string }>(sw, "SELECT line_id, state FROM kauro.commission_lines WHERE line_id = ANY ($1::uuid[])", [[...lineIds]]);
  return lineIds.map((id) => r.find((x) => x.line_id === id)?.state ?? "MISSING");
};
const guardReviews = async (periodId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.compensation_guard_reviews WHERE period_id = $1", [periodId]))[0]!.n);

/** A period closed through the route at LATER (the proposal of the ledger as it stands). */
async function closeAtLater(periodId: string, key?: string): Promise<Reply> {
  const hash = await proposal(sw, periodId);
  sw.standAt(LATER);
  try {
    return await closePeriod(sw, periodId, { ledgerCutoffHash: hash }, key === undefined ? {} : { key });
  } finally {
    sw.standAt(null);
  }
}

// --- ISSUED statements for the correction cells: a month with `count` sellers, one 10,000-cent line each --------------------------------

interface Issued {
  readonly statementId: string;
  readonly version: number;
  readonly lineId: string;
}
/** The three ISSUED statements of the correction cells, one month for all (the TEST CLOCK's offset reaches only so far into the year). */
let pool: Promise<Issued[]> | undefined;
async function takeIssued(count: number): Promise<Issued[]> {
  pool ??= issueMonth(3);
  const all = await pool;
  const taken = all.splice(0, count);
  if (taken.length < count) throw new Error("the shared ISSUED statements are used up");
  return taken;
}
async function issueMonth(count: number): Promise<Issued[]> {
  const m = nextMonth();
  const sold: Array<{ s: Awaited<ReturnType<typeof seller>>; lineId: string }> = [];
  for (let i = 0; i < count; i++) {
    const s = await seller(sw, `corr-crash-${m}-${i}`, WHOLE);
    sold.push({ s, lineId: (await eligibleLines(sw, `corr crash ${m} ${i}`, s, WHOLE, [{ basisCents: LINE, poolCents: LINE }])).lines[0]!.lineId });
  }
  const periodId = await openMonth(sw, m);
  await drainCommissions(sw);
  completed<PeriodCloseView>(await closeAtLater(periodId), 200);
  return Promise.all(
    sold.map(async ({ s, lineId }) => {
      const st = await statementOf(s.sellerId, periodId);
      assert.ok(st !== undefined, "the close issued the seller's statement");
      return { statementId: st.statement_id, version: Number(st.version), lineId };
    }),
  );
}
const stateOf = async (statementId: string): Promise<{ state: string; version: number }> => {
  const r = (await rows<{ state: string; version: string }>(sw, "SELECT state, version::text AS version FROM kauro.commission_statements WHERE statement_id = $1", [statementId]))[0]!;
  return { state: r.state, version: Number(r.version) };
};
const successorsOf = (statementId: string) => rows<{ statement_id: string; state: string }>(sw, "SELECT statement_id, state FROM kauro.commission_statements WHERE corrects_statement_id = $1", [statementId]);

// --- 17. CORR_CRASH -----------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CORR_CRASH",
    step: "CMD051 correcting statement (correction_issued), a crash after the last write and before the correction COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect: "RACE (crash): a crash before the correction COMMIT leaves the predecessor ISSUED at its version, no successor and no journal result; the same key then corrects once",
  },
  async (ctx) => {
    const [x] = await takeIssued(1);
    const key = freshKey("corr-crash-before");
    const crash = ctx.points.crash("uow.before-commit");
    const conn = await open("kauro_commission_test");
    try {
      // the unit's work ran to its end (successor, items, predecessor CORRECTED, journal result) and the crash fired before COMMIT was issued
      await assert.rejects(
        ctx.operation("the correction crashing before its COMMIT", () => correctOn(ctx, conn, x!.statementId, x!.version, { key })),
        crashedAt("uow.before-commit"),
      );
      await crash.reached;
    } finally {
      await conn.end();
    }
    assert.deepEqual(await successorsOf(x!.statementId), [], "no successor survives");
    assert.deepEqual(await stateOf(x!.statementId), { state: "ISSUED", version: x!.version }, "the predecessor is unchanged");
    assert.deepEqual(await lineStates([x!.lineId]), ["PAYABLE"]);
    assert.equal(await journalState(key), null, "no journal result");
    const again = await correctStatement(sw, x!.statementId, { expectedVersion: x!.version }, { key });
    assert.equal(resultOf(again), "200", "the same key corrects once");
    assert.equal((await successorsOf(x!.statementId)).length, 1);
    assert.equal((await stateOf(x!.statementId)).state, "CORRECTED");
  },
);

faultCell(
  {
    id: "CORR_CRASH",
    step: "CMD051 correcting statement (correction_issued), the answer lost after the correction COMMIT",
    fault: "crash-after-commit",
    at: "uow",
    expect: "RACE (crash after COMMIT): the response lost after the correction commits is recovered by the same key as the same successor, one successor and the predecessor CORRECTED",
  },
  async (ctx) => {
    const [x] = await takeIssued(1);
    const key = freshKey("corr-crash-after");
    const crash = ctx.points.crash("uow.after-commit");
    const conn = await open("kauro_commission_test");
    let successorId: string;
    try {
      await assert.rejects(
        ctx.operation("the correction whose answer is lost", () => correctOn(ctx, conn, x!.statementId, x!.version, { key })),
        crashedAt("uow.after-commit"),
      );
      await crash.reached;
      const successors = await successorsOf(x!.statementId);
      assert.equal(successors.length, 1, "the unit had committed: one successor");
      successorId = successors[0]!.statement_id;
      assert.equal((await stateOf(x!.statementId)).state, "CORRECTED");
      assert.equal(await journalState(key), "COMMITTED");
      const again = await correctOn(ctx, conn, x!.statementId, x!.version, { key });
      assert.equal(resultOf(again), "200");
      assert.ok(again.kind === "COMPLETED" && again.replayed, "the same key recovers the committed answer");
      assert.equal(again.kind === "COMPLETED" ? again.view.statement.statementId : "", successorId, "the same successor");
    } finally {
      await conn.end();
    }
    assert.deepEqual((await successorsOf(x!.statementId)).map((r) => r.statement_id), [successorId!], "still one successor");
  },
);

// --- 18. CORR_AUTH ------------------------------------------------------------------------------------------------------------------

test("CORR_AUTH [deny] CMD051 correcting statement, an identity that does not hold COMMISSION_SERVICE in this deployment -> DENY: refused 403 before any unit opens, a durable DENY fact, nothing written; the commission service still corrects", async () => {
  const [x] = await takeIssued(1);
  const denials = async (reason: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.security_events WHERE action = 'CMD051' AND outcome = 'DENY' AND reason_code = $1", [reason]))[0]!.n);
  const as = (serviceId: string, environment: "LOCAL" | "LIVE", key: string) =>
    correctCommissionStatement(sw.statementRuntime, {
      correlationId: ids.next() as CorrelationId,
      idempotencyKey: key,
      identity: { serviceId, audience: "kauro-api", environment } as never,
      path: { statementId: x!.statementId },
      body: { expectedVersion: x!.version },
    });
  for (const [serviceId, environment, reason] of [["finance-service", "LOCAL", "SERVICE_NOT_PERMITTED"], ["commission-service", "LIVE", "SERVICE_ENVIRONMENT_MISMATCH"]] as const) {
    const before = await denials(reason);
    const key = freshKey("corr-auth");
    assert.match(resultOf(await as(serviceId, environment, key)), /^403 NOT_AUTHORIZED /);
    assert.equal(await denials(reason), before + 1, `${reason} is a durable fact`);
    assert.equal(await journalState(key), null, "no journal entry");
    assert.deepEqual(await successorsOf(x!.statementId), []);
    assert.deepEqual(await stateOf(x!.statementId), { state: "ISSUED", version: x!.version });
  }
  assert.equal(resultOf(await correctStatement(sw, x!.statementId, { expectedVersion: x!.version })), "200", "the commission service of this deployment corrects");
});

// --- 19. CLOSEP_PAR -----------------------------------------------------------------------------------------------------------------

const STATEMENT_INSERT: SqlStep = { label: "statement_insert", match: /INSERT INTO kauro\.commission_statements/ };
const ITEM_INSERT: SqlStep = { label: "item_insert", match: /INSERT INTO kauro\.statement_items/ };
const LINE_UPDATE: SqlStep = { label: "line_update", match: /UPDATE kauro\.commission_lines l SET/ };
const GUARD_INSERT: SqlStep = { label: "guard_insert", match: /INSERT INTO kauro\.compensation_guard_reviews/ };
const PERIOD_CLOSE: SqlStep = { label: "period_close", match: /UPDATE kauro\.commission_periods SET state = 'CLOSED'/ };

faultCell(
  {
    id: "CLOSEP_PAR",
    step: "CMD051 CloseCommissionPeriod, a failure after the statement, its items and holds, the PAYABLE transitions and the guard review and before the period CLOSED",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the statement row, after the items (the hold item among them), after the PAYABLE transitions and after the guard review and before the period CLOSED leaves the period OPEN with no statement, no PAYABLE line and no review, and the same journal key then closes once",
  },
  async (ctx) => {
    // two lines, the second with a 1000-cent partial hold: the statement has a PAYABLE item, a PAYABLE net item and a HELD item
    const { s, periodId, proposed, lineIds } = await readyPeriod("close-par", 2, { partialHold: true });
    const key = freshKey("close-par");
    const before = await periodRow(sw, periodId);
    assert.equal(before.state, "OPEN");
    const cases = [
      { at: "db.item_insert.before", what: "the close failing after the statement row and before its items", steps: [STATEMENT_INSERT, ITEM_INSERT] },
      { at: "db.line_update.before", what: "the close failing after the items (hold item included) and before the first PAYABLE transition", steps: [ITEM_INSERT, LINE_UPDATE] },
      { at: "db.guard_insert.before", what: "the close failing after the PAYABLE transitions and before the guard review", steps: [LINE_UPDATE, GUARD_INSERT] },
      { at: "db.period_close.before", what: "the close failing after the guard review and before the period CLOSED", steps: [GUARD_INSERT, PERIOD_CLOSE] },
    ];
    for (const { at, what, steps } of cases) {
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial(what, at, async () => {
          const seen = sw.w.internalErrors.length;
          const reply = await closeOn(ctx, conn, periodId, proposed, { key, steps });
          // the route answers 500 and reports the failure it hid (a crash is not a DomainFailure): the cell sees the failure itself
          if (reply.status >= 500) throw sw.w.internalErrors[seen]?.error ?? new Error(`the unit failed: ${reply.status}`);
          return reply;
        });
      } finally {
        await conn.end();
      }
      assert.equal((await periodRow(sw, periodId)).state, "OPEN", `${what}: the period stays OPEN`);
      assert.deepEqual(await periodRow(sw, periodId), before, "and unchanged (undated, no cutoff hash)");
      assert.deepEqual(await statementsOfPeriod(periodId), [], "no statement survives");
      assert.deepEqual(await lineStates(lineIds), ["ELIGIBLE", "ELIGIBLE"], "no line is PAYABLE");
      assert.equal(await guardReviews(periodId), 0, "no guard review survives");
      assert.equal(await journalState(key), null, "no journal result");
    }
    sw.standAt(LATER);
    const closed = completed<PeriodCloseView>(await closePeriod(sw, periodId, { ledgerCutoffHash: proposed }, { key }).finally(() => sw.standAt(null)), 200);
    assert.equal(closed.data.statementCount, 1, "the same key closes once");
    const st = (await statementOf(s.sellerId, periodId))!;
    assert.deepEqual([st.payable_cents, st.held_cents], ["19000", "1000"]);
    assert.deepEqual((await itemsOf(sw, st.statement_id)).map((i) => [i.disposition, i.payable_cents, i.held_cents]), [["PAYABLE", "10000", "0"], ["PAYABLE", "9000", "0"], ["HELD", "0", "1000"]]);
    assert.deepEqual(await lineStates(lineIds), ["PAYABLE", "PAYABLE"]);
    assert.equal(await guardReviews(periodId), 1);
    assert.equal((await periodRow(sw, periodId)).state, "CLOSED");
  },
);

// --- 20. CLOSE_CAL ------------------------------------------------------------------------------------------------------------------
// A banking-calendar version recorded while CloseCommissionPeriod runs. The close takes no lock on banking_calendars (a recording and a
// close contend for no row), so there is no lock wait for the harness's race evidence to observe; the window is proven instead by the close
// PAUSED at its COMMIT after it read and recorded its version, the newer version being served and committed inside that window.

const FIXTURE_NONBANKING = ["2026-10-12"];
const dayAfter = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
async function serveCalendar(label: string, nonbankingDates: ReadonlyArray<string>): Promise<void> {
  sw.calendar.serve({ calendarVersion: label, jurisdiction: "CO", source: "TEST_FIXTURE", nonbankingDates, coversFrom: FIXTURE_CALENDAR.coversFrom, coversTo: FIXTURE_CALENDAR.coversTo, recordedAt: new Date().toISOString() as UtcInstant, evidenceHash: sha(label) as Sha256Hex });
}
/** The feed's own recording of a version, committed by another connection (the superuser stands for the feed's writer: B15 is not built). */
async function recordCalendar(label: string, nonbankingDates: ReadonlyArray<string>): Promise<void> {
  await sw.h.oracle.query(
    "INSERT INTO kauro.banking_calendars (calendar_id, jurisdiction, calendar_version, source, nonbanking_dates, covers_from, covers_to, evidence_hash, recorded_at, created_at) VALUES ($1, 'CO', $2, 'TEST_FIXTURE', $3::date[], $4, $5, $6, kauro.server_now(), now())",
    [ids.next(), label, [...nonbankingDates], FIXTURE_CALENDAR.coversFrom, FIXTURE_CALENDAR.coversTo, sha(label)],
  );
}
/** The close and pay dates a calendar version gives the month of `periodId` (the database's own banking-day function). */
async function datesUnder(periodId: string, nonbankingDates: ReadonlyArray<string>): Promise<{ close: string; pay: string }> {
  const r = await rows<{ close: string; pay: string }>(
    sw,
    `SELECT kauro.banking_day_after(e, 5, $2::date[], $3::date, $4::date)::text AS close, kauro.banking_day_after(e, 10, $2::date[], $3::date, $4::date)::text AS pay
       FROM (SELECT (period_month + interval '1 month' - interval '1 day')::date AS e FROM kauro.commission_periods WHERE period_id = $1) m`,
    [periodId, [...nonbankingDates], FIXTURE_CALENDAR.coversFrom, FIXTURE_CALENDAR.coversTo],
  );
  return r[0]!;
}

test("CLOSE_CAL [race] CMD051 CloseCommissionPeriod, a newer banking-calendar version recorded between the calendar read and the COMMIT, and before it, in both orders -> the statement and the period store the version the close read and their dates follow it", async () => {
  try {
    for (const order of ["during-close", "before-close"] as const) {
      const { s, periodId, proposed } = await readyPeriod(`cal-${order}`, 1);
      const monthEnd = (await rows<{ e: string }>(sw, "SELECT (period_month + interval '1 month' - interval '1 day')::date::text AS e FROM kauro.commission_periods WHERE period_id = $1", [periodId]))[0]!.e;
      const olderLabel = `cal-older-${order}`;
      const newerLabel = `cal-newer-${order}`;
      const older: string[] = [];
      const newer = Array.from({ length: 15 }, (_, i) => dayAfter(monthEnd, i + 1));
      const datesOlder = await datesUnder(periodId, older);
      const datesNewer = await datesUnder(periodId, newer);
      assert.notEqual(datesOlder.pay, datesNewer.pay, "the two versions give the month different pay dates: the version the close read decides the statement");
      assert.equal((await periodRow(sw, periodId)).pay_due_on, null, "the period is undated: the close reads the calendar");
      await serveCalendar(olderLabel, older);
      let expected: { label: string; dates: { close: string; pay: string } };
      if (order === "during-close") {
        const points = new FaultPoints();
        const closing = await open("kauro_commission_test");
        try {
          const pause = points.pause("uow.before-commit");
          const running = closeOn({ points }, closing, periodId, proposed);
          await pause.reachedBy(running);
          // the close read and recorded the older version; its unit is open and uncommitted. The newer version is recorded and committed now
          assert.equal((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.banking_calendars WHERE calendar_version = $1", [olderLabel]))[0]!.n, "0", "the close's own recording is not yet committed: it is mid-way");
          await serveCalendar(newerLabel, newer);
          await recordCalendar(newerLabel, newer);
          pause.release();
          completed<PeriodCloseView>(await running, 200);
        } finally {
          await closing.end();
        }
        expected = { label: olderLabel, dates: datesOlder };
      } else {
        await serveCalendar(newerLabel, newer);
        await recordCalendar(newerLabel, newer);
        completed<PeriodCloseView>(await closeAtLater(periodId), 200);
        expected = { label: newerLabel, dates: datesNewer };
      }
      const st = (await statementOf(s.sellerId, periodId))!;
      const stored = (await rows<{ label: string; pay_date: string; statement_date: string }>(sw, "SELECT c.calendar_version AS label, to_char(st.pay_date, 'YYYY-MM-DD') AS pay_date, to_char(st.statement_date, 'YYYY-MM-DD') AS statement_date FROM kauro.commission_statements st JOIN kauro.banking_calendars c ON c.calendar_id = st.calendar_id WHERE st.statement_id = $1", [st.statement_id]))[0]!;
      assert.deepEqual([stored.label, stored.statement_date, stored.pay_date], [expected.label, expected.dates.close, expected.dates.pay], `${order}: the statement stores the version the close read and its dates follow it`);
      const period = await periodRow(sw, periodId);
      assert.deepEqual([period.close_due_on, period.pay_due_on, period.state], [expected.dates.close, expected.dates.pay, "CLOSED"], "and so does the period");
    }
  } finally {
    await serveCalendar(FIXTURE_CALENDAR.calendarVersion, FIXTURE_NONBANKING);
  }
});

// --- 21. CLOSE_CRA ------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CLOSE_CRA",
    step: "CMD051 CloseCommissionPeriod, the answer lost after the close COMMIT",
    fault: "crash-after-commit",
    at: "uow",
    expect: "RACE (crash after COMMIT): the response lost after the close commits is recovered by the same key as the same statements, no second set",
  },
  async (ctx) => {
    const { s, periodId, proposed } = await readyPeriod("close-cra", 1);
    const key = freshKey("close-cra");
    const crash = ctx.points.crash("uow.after-commit");
    const conn = await open("kauro_commission_test");
    try {
      const lost = await ctx.operation("the close whose answer is lost", () => closeOn(ctx, conn, periodId, proposed, { key }));
      await crash.reached;
      assert.equal(outcome(sw.w, lost), "500 INTERNAL_ERROR -", "the caller got no answer");
      const first = await statementsOfPeriod(periodId);
      assert.equal(first.length, 1, "the unit had committed: one statement");
      assert.deepEqual([(await periodRow(sw, periodId)).state, await journalState(key)], ["CLOSED", "COMMITTED"]);
      const again = completed<PeriodCloseView>(await closeOn(ctx, conn, periodId, proposed, { key }), 200);
      assert.equal(again.replayed, true, "the same key recovers the committed answer");
      assert.equal(again.data.statementCount, 1);
      assert.deepEqual(await statementsOfPeriod(periodId), first, "the same statements, no second set");
      assert.equal((await statementOf(s.sellerId, periodId))?.statement_id, first[0]);
    } finally {
      await conn.end();
    }
  },
);

/** The PERIODS sweep over the commission service's units routed through the harness (standing at LATER), `hold` the close's test hook. */
function sweepOver(hold?: () => Promise<void>) {
  const units = sw.faults.wrap(new StandingUnits(sw.pools.pools, () => ({ at: LATER })));
  const runtime = createCommissionService({ assembly: { units, completions: sw.completions }, environment: "LOCAL", clock: sw.clock, ids, onBackgroundFailure: () => undefined }).runtime;
  const sweep = createPeriodsSweep(runtime, { calendar: sw.calendar, ...(hold === undefined ? {} : { hold }) });
  // routed units stand where the world stands (faults.stand), so the sweep stands at LATER for the pass
  return { ...sweep, run: (options: { readonly limit: number }) => { sw.standAt(LATER); return sweep.run(options).finally(() => sw.standAt(null)); } };
}
const itemOf = (report: { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> }, periodId: string): string | undefined => report.items.find((i) => i.subject === periodId)?.outcome;

faultCell(
  {
    id: "CLOSE_CRA",
    step: "Sweep PERIODS, the sweep stopped after CloseCommissionPeriod committed and before it recorded the result",
    fault: "crash-after-commit",
    at: "uow",
    expect: "RACE (crash after COMMIT): the PERIODS sweep stopped after the close committed has no second set to make: the next pass finds the period CLOSED, and the journal key period-close-<periodId> replays the same statements",
  },
  async (ctx) => {
    const { periodId } = await readyPeriod("close-cra-sweep", 1);
    // the crash is armed inside the close's own unit, so it fires at that unit's COMMIT boundary and no earlier unit of the sweep
    const sweep = sweepOver(async () => void ctx.points.crash("uow.after-commit"));
    const conn = await open("kauro_commission_test");
    try {
      const stopped = await ctx.operation("the PERIODS sweep stopped after the close COMMIT", () => sw.faults.on(conn, "kauro_commission", ctx.points, [], () => sweep.run({ limit: 10 })));
      assert.equal(itemOf(stopped, periodId), "FAILED UNEXPECTED_ERROR", "the sweep never recorded the close's result");
      const first = await statementsOfPeriod(periodId);
      assert.equal(first.length, 1, "the close had committed");
      assert.deepEqual([(await periodRow(sw, periodId)).state, await journalState(periodCloseKey(periodId))], ["CLOSED", "COMMITTED"]);
      const next = await sw.faults.on(conn, "kauro_commission", ctx.points, [], () => sweepOver().run({ limit: 10 }));
      assert.equal(itemOf(next, periodId), undefined, "the next pass has no period to close");
      assert.deepEqual(await statementsOfPeriod(periodId), first, "no second set");
    } finally {
      await conn.end();
    }
    const first = await statementsOfPeriod(periodId);
    const hash = (await periodRow(sw, periodId)).cutoff_hash!;
    sw.standAt(LATER);
    const replay = completed<PeriodCloseView>(await closePeriod(sw, periodId, { ledgerCutoffHash: hash }, { key: periodCloseKey(periodId) }).finally(() => sw.standAt(null)), 200);
    assert.equal(replay.replayed, true, "the sweep's journal key replays the committed close");
    assert.deepEqual([replay.data.statementCount, await statementsOfPeriod(periodId)], [1, first]);
  },
);

// --- 22. CLOSE_TMO ------------------------------------------------------------------------------------------------------------------
// The close's bounds are the database's own: every unit of work sets statement_timeout, and a lock wait that outlasts it is cancelled
// (SQLSTATE 57014) and answered as the retriable CAPACITY_UNAVAILABLE. The cell proves the real thing: a lock wait of the close on the
// holder's lock, OBSERVED, that ENDS in the database's timeout (shortened to TIMEOUT_MS on the routed units), not a deadline the test crosses.
// The banking calendar the test world binds is a contract fake that answers in process, so the first calendar cell proves only the rollback
// of the calendar's PERSISTENCE (recordCalendar, after the read answered); the SOURCE cell binds the real RecordedBankingCalendarSource,
// whose read of banking_calendars is the step that waits. The recomputation cell holds the ledger lines.

const TIMEOUT_MS = 1_500;

/** Runs `blocked` on a waiter connection while `hold` holds its lock; the wait is observed and ends in the statement timeout, then the holder lets go. */
async function waitsOutTimeout<T>(ctx: FaultContext, login: Login, hold: (conn: HarnessConnection) => Promise<void>, blocked: (conn: HarnessConnection) => Promise<T>, what: string): Promise<T> {
  const holder = await open(login);
  const waiter = await open("kauro_commission_test");
  sw.faults.statementTimeoutMs = TIMEOUT_MS;
  try {
    await holder.query("BEGIN");
    await hold(holder);
    const waiting = await ctx.mustWait(sw.h.oracle, { waiter, holder: connectionPid(holder) }, blocked, what);
    return value(await waiting.pending);
  } finally {
    sw.faults.statementTimeoutMs = null;
    await holder.query("ROLLBACK").catch(() => undefined);
    await holder.end();
    await waiter.end();
  }
}

const lockPeriod = (periodId: string) => async (c: HarnessConnection): Promise<void> => void (await c.query("SELECT 1 FROM kauro.commission_periods WHERE period_id = $1 FOR UPDATE", [periodId]));
const lockTable = (table: string) => async (c: HarnessConnection): Promise<void> => void (await c.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`));

async function assertRetriableAndUntouched(refused: Reply, periodId: string, before: Awaited<ReturnType<typeof periodRow>>, key: string, lineIds: string[]): Promise<void> {
  assert.match(outcome(sw.w, refused), /^503 CAPACITY_UNAVAILABLE/, "the wait that outlasted the database's timeout is the retriable failure");
  assert.equal(asProblem(sw.w, refused).retryable, true);
  assert.deepEqual(await periodRow(sw, periodId), before, "the period stays OPEN and as it was");
  assert.deepEqual(await statementsOfPeriod(periodId), [], "nothing written");
  assert.deepEqual(await lineStates(lineIds), lineIds.map(() => "ELIGIBLE"));
  assert.equal(await journalState(key), null, "no journal entry");
}
async function closesOnce(s: Awaited<ReturnType<typeof seller>>, periodId: string, key: string): Promise<void> {
  assert.equal(completed<PeriodCloseView>(await closeAtLater(periodId, key), 200).data.statementCount, 1, "the same key then closes once");
  assert.equal((await statementsOfPeriod(periodId)).length, 1);
  assert.equal((await statementOf(s.sellerId, periodId))?.state, "ISSUED");
}

for (const [step, hold, what] of [
  ["the calendar PERSISTENCE (statements.recordCalendar, which runs after the contract fake's in-process read answered: this is not a source timeout)", lockTable("kauro.banking_calendars"), "the close while the banking calendars table is held"],
  ["the cutoff recomputation and input reads (the ledger lines)", lockTable("kauro.commission_lines"), "the close while the ledger lines are held"],
] as const) {
  faultCell(
    {
      id: "CLOSE_TMO",
      step: `CMD051 CloseCommissionPeriod, ${step} waiting past the database's statement timeout`,
      fault: "race",
      expect: "DENY: a step of the close that waits on a lock past the database's statement timeout answers the retriable 503 CAPACITY_UNAVAILABLE, the period stays OPEN and undated, nothing is written, and the same journal key then closes once",
    },
    async (ctx) => {
      const { s, periodId, proposed, lineIds } = await readyPeriod("close-tmo", 1);
      const key = freshKey("close-tmo");
      const before = await periodRow(sw, periodId);
      const refused = await waitsOutTimeout(ctx, "postgres", hold, (conn) => closeOn(ctx, conn, periodId, proposed, { key }), what);
      await assertRetriableAndUntouched(refused, periodId, before, key, lineIds);
      await closesOnce(s, periodId, key);
    },
  );
}

faultCell(
  {
    id: "CLOSE_TMO",
    step: "CMD051 CloseCommissionPeriod, the lock wait on the period waiting past the database's statement timeout",
    fault: "race",
    expect: "DENY: a close that waits on the period's lock past the database's statement timeout answers the retriable 503 CAPACITY_UNAVAILABLE, nothing is written, and the same journal key then closes once",
  },
  async (ctx) => {
    const { s, periodId, proposed, lineIds } = await readyPeriod("close-tmo-lock", 1);
    const key = freshKey("close-tmo-lock");
    const before = await periodRow(sw, periodId);
    const refused = await waitsOutTimeout(ctx, "kauro_commission_test", lockPeriod(periodId), (conn) => closeOn(ctx, conn, periodId, proposed, { key }), "the close while the period is locked");
    await assertRetriableAndUntouched(refused, periodId, before, key, lineIds);
    await closesOnce(s, periodId, key);
  },
);

faultCell(
  {
    id: "CLOSE_TMO",
    step: "Sweep PERIODS, the close of a period waiting past the database's statement timeout",
    fault: "race",
    expect: "DENY: the PERIODS sweep whose close waits on the period's lock past the database's statement timeout reports the period refused as retriable and writes nothing; the next pass closes it once under period-close-<periodId>",
  },
  async (ctx) => {
    const { s, periodId, lineIds } = await readyPeriod("close-tmo-sweep", 1);
    const before = await periodRow(sw, periodId);
    const key = periodCloseKey(periodId);
    const report = await waitsOutTimeout(ctx, "kauro_commission_test", lockPeriod(periodId), (conn) => sw.faults.on(conn, "kauro_commission", ctx.points, [], () => sweepOver().run({ limit: 10 })), "the PERIODS sweep while the period is locked");
    assert.equal(itemOf(report, periodId), "REFUSED CAPACITY_UNAVAILABLE", "the sweep reports the close refused, retriable");
    assert.deepEqual(await periodRow(sw, periodId), before);
    assert.deepEqual(await statementsOfPeriod(periodId), []);
    assert.deepEqual(await lineStates(lineIds), ["ELIGIBLE"]);
    assert.equal(await journalState(key), null);
    const conn = await open("kauro_commission_test");
    try {
      const next = await sw.faults.on(conn, "kauro_commission", ctx.points, [], () => sweepOver().run({ limit: 10 }));
      assert.equal(itemOf(next, periodId), "CLOSED", "the next pass closes it");
    } finally {
      await conn.end();
    }
    assert.equal((await statementsOfPeriod(periodId)).length, 1);
    assert.equal((await statementOf(s.sellerId, periodId))?.state, "ISSUED");
  },
);

faultCell(
  {
    id: "CLOSE_TMO",
    step: "CMD051 CloseCommissionPeriod, the RecordedBankingCalendarSource READ of banking_calendars waiting past the database's statement timeout",
    fault: "race",
    expect: "DENY: the real RecordedBankingCalendarSource whose read of banking_calendars waits on a lock past the database's statement timeout fails at the source read (the read is cancelled, never answered), the close answers the retriable 503 CAPACITY_UNAVAILABLE, the period stays OPEN and undated, nothing is written, and the same journal key then closes once",
  },
  async (ctx) => {
    const { s, periodId, proposed, lineIds } = await readyPeriod("close-tmo-source", 1);
    // a recorded VERIFIED_FEED version for the source to read (the feed's writer is B15: the superuser stands for it)
    await sw.h.oracle.query(
      "INSERT INTO kauro.banking_calendars (calendar_id, jurisdiction, calendar_version, source, nonbanking_dates, covers_from, covers_to, evidence_hash, recorded_at, created_at) VALUES ($1, 'CO', $2, 'VERIFIED_FEED', '{}', $3, $4, $5, kauro.server_now(), now())",
      [ids.next(), `feed-tmo-${ids.next()}`, FIXTURE_CALENDAR.coversFrom, FIXTURE_CALENDAR.coversTo, sha("feed-tmo")],
    );
    const real = new RecordedBankingCalendarSource();
    const reads: string[] = [];
    const source = {
      binding: real.binding,
      async currentCalendar(uow: Parameters<typeof real.currentCalendar>[0], request: Parameters<typeof real.currentCalendar>[1]) {
        reads.push("started");
        try {
          const answer = await real.currentCalendar(uow, request);
          reads.push("answered");
          return answer;
        } catch (e) {
          reads.push("rejected");
          throw e;
        }
      },
    };
    const runtime = statementServiceRuntime({ units: sw.faults.wrap(new StandingUnits(sw.pools.pools, () => ({ at: LATER }))), calendar: source as never }, "LOCAL", sw.clock);
    const key = freshKey("close-tmo-source");
    const before = await periodRow(sw, periodId);
    const refused = await waitsOutTimeout(
      ctx,
      "postgres",
      lockTable("kauro.banking_calendars"),
      (conn) => {
        sw.standAt(LATER);
        return sw.faults.on(conn, "kauro_commission", ctx.points, [], () => closeCommissionPeriod(runtime, { correlationId: ids.next() as CorrelationId, idempotencyKey: key, identity: { serviceId: "commission-service", audience: "kauro-api", environment: "LOCAL" }, path: { periodId }, body: { ledgerCutoffHash: proposed } })).finally(() => sw.standAt(null));
      },
      "the close whose calendar source reads banking_calendars while the table is held",
    );
    assert.deepEqual(reads, ["started", "rejected"], "the timeout happened AT the source read: it was called, never answered, and failed");
    assert.match(resultOf(refused), /^503 CAPACITY_UNAVAILABLE/);
    assert.equal(refused.kind === "UNAVAILABLE" && refused.problem.retryable, true);
    assert.deepEqual(await periodRow(sw, periodId), before, "the period stays OPEN and undated");
    assert.deepEqual(await statementsOfPeriod(periodId), [], "nothing written");
    assert.deepEqual(await lineStates(lineIds), ["ELIGIBLE"]);
    assert.equal(await journalState(key), null, "no journal entry");
    reads.length = 0;
    sw.standAt(LATER);
    const again = await closeCommissionPeriod(runtime, { correlationId: ids.next() as CorrelationId, idempotencyKey: key, identity: { serviceId: "commission-service", audience: "kauro-api", environment: "LOCAL" }, path: { periodId }, body: { ledgerCutoffHash: proposed } }).finally(() => sw.standAt(null));
    assert.equal(resultOf(again), "200", "the same key then closes once");
    assert.deepEqual(reads, ["started", "answered"]);
    assert.equal((await statementsOfPeriod(periodId)).length, 1);
    assert.equal((await statementOf(s.sellerId, periodId))?.state, "ISSUED");
  },
);
