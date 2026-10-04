// The tier-1 GAPs 29 to 36 of the B10 failure matrix on the COMMISSIONS consumers, the funds effect, the ELIGIBILITY sweep and the accrual
// (docs/design/B10-failure-matrix.md "GAP list, by risk" -> "Tier 1"; items FUNDS_PAR, FUNDS_RETRY, ELIG_REV, CONS_DUP_LINE, ACCRUAL_REC_RACE,
// CONS_REV, TERM_ACCRUAL, CONS_PAR), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). Every unit under test is the
// commission service's REAL unit of work (the COMMISSIONS consumer, a sweep item, CMD050) routed over a connection the harness opened; the
// statements of an effect are the cell's steps (test/fault-support.ts), and every sweep pass and consumer delivery goes through the helpers of
// b10-cells-support.ts, which assert that nothing failed behind the background sink before any recovery run. PostgreSQL 17 through the runtime
// login roles; the superuser only reads. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { assignedThrough, integrationWorld, oracleRows, providerReports, terminationBody, type IntegrationWorld } from "./integration-support.js";
import { faultCell, recordServiceAssignment, type FaultContext } from "@kauro/persistence/testing";
import { bindCells, eventsOf, fundsReport, ledgerOfPurchase, stateOf, type LedgerView, consumeOn, contend, failures, nothingFor, observeBlocked, convertedFor, converting, deliveryOfCapture, itemOf, mustHaveSettled, open, rightsOf, runConsumer, runSweepPass, settled, sweepOn, type Actor, type Converting, type Delivery } from "./b10-cells-support.js";
import { acceptAttribution, approvedRefund, claimsOn, sellingAgency, deliveredByTheExecutionPackage, deliveryOf, linesOf, poolsOf, purchase, type Purchase } from "./commission-support.js";
import type { ExecuteRefundView, SellerTerminationView, WebhookAck } from "@kauro/application";
import type { SweepReport } from "../src/commissions/sweeps.js";
import { call, completed, freshKey, type Reply } from "./support.js";
import type { SqlStep } from "./fault-support.js";
import { deliver, execute as paymentExecute } from "./payment-support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  bindCells(iw);
});
after(async () => {
  await iw.stop();
});

const HOUR_MS = 3_600_000;

// --- the statements of the effects under test ---------------------------------------------------------------------------------------

const FACT_INSERT: SqlStep = { label: "fact_insert", match: /INSERT INTO kauro\.capture_funds_observations/ };
const HOLD_INSERT: SqlStep = { label: "hold_insert", match: /INSERT INTO kauro\.commission_holds/ };
const LINE_UPDATE: SqlStep = { label: "line_update", match: /UPDATE kauro\.commission_lines/ };
const POOLS_LOCK: SqlStep = { label: "pools_lock", match: /FROM kauro\.commission_pools WHERE capture_id = \$1 ORDER BY pool_id FOR UPDATE/ };
const LINES_LOCK: SqlStep = { label: "lines_lock", match: /FROM kauro\.commission_lines WHERE pool_id = \$1 ORDER BY line_id FOR UPDATE/ };
const ADJUSTMENT_INSERT: SqlStep = { label: "adjustment_insert", match: /INSERT INTO kauro\.commission_adjustments/ };
const AGENCY_LOCK: SqlStep = { label: "agency_lock", match: /pg_advisory_xact_lock\(kauro\.transition_key\('kauro\.agency_commissions'/ };
const LINE_LOCK = (lineId: string): SqlStep => ({ label: "line_lock", match: /WHERE l\.line_id = \$1 FOR UPDATE OF l/, when: (params) => params[0] === lineId });

/** An agency whose claims are ACCEPTED, its first purchase confirmed and delivered to COMMISSIONS: converted, accrued, lines ACCRUED_PENDING. */
async function accrued(label: string, shares: ReadonlyArray<number>): Promise<Converting> {
  const c = await converting(label, shares);
  assert.equal(await runConsumer(c.delivery), "APPLIED", `${label}: the first purchase converts and accrues`);
  assert.deepEqual(await rightsOf(c), convertedFor(c, shares));
  return c;
}
/** The purchase's FINAL completion, 721 hours old, recorded by an ELIGIBILITY pass (the funds are still unknown: nothing becomes eligible). */
async function finalCompleted(c: Converting): Promise<void> {
  iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "FINAL", completedAt: new Date(Date.now() - 721 * HOUR_MS).toISOString() as never, source: "AUTHORIZATION_DELIVERY" });
  assert.equal(itemOf(await runSweepPass("ELIGIBILITY"), c.first.authorizationId), "COMPLETIONS 1", "the FINAL completion is recorded");
  const ledger = await ledgerOfPurchase(c.first);
  assert.deepEqual([ledger.facts.length, ...ledger.lines.map(stateOf)], [0, ...c.att.claimIds.map(() => "ACCRUED_PENDING")], "due, but no funds observed yet: nothing eligible, held or paid");
}

// =====================================================================================================================================
// 29. FUNDS_PAR: the funds effect is three writes (the fact, a hold per line, the line's HELD transition)
// =====================================================================================================================================

faultCell(
  {
    id: "FUNDS_PAR",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD: a failure after the funds fact and before the first hold, after one line's hold and line transition and before the second line's hold, and after a hold and before its line's HELD transition",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the fact insert answered, after the first line's hold and HELD update answered, and after a hold insert answered, rolls the whole effect back (no fact, no hold, both lines still ACCRUED_PENDING at their old versions: no half-state that withholds or enables payout); the redelivery then records the fact once, one OPEN FUNDS_HELD hold of the whole unpaid amount per line and one HELD transition per line",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const cases: ReadonlyArray<{ readonly label: string; readonly at: string; readonly steps: ReadonlyArray<SqlStep>; readonly what: string; readonly completedSteps: ReadonlyArray<string> }> = [
      { label: "fact-then-hold", at: "db.hold_insert.before", steps: [FACT_INSERT, HOLD_INSERT], what: "the funds effect failing after the fact insert and before the first hold", completedSteps: ["db.fact_insert.after"] },
      { label: "between-lines", at: "db.hold_insert.before", steps: [FACT_INSERT, LINE_UPDATE, { ...HOLD_INSERT, nth: 2 }], what: "the funds effect failing after the first line's HELD update and before the second line's hold", completedSteps: ["db.fact_insert.after", "db.line_update.after"] },
      { label: "hold-then-line", at: "db.line_update.before", steps: [FACT_INSERT, HOLD_INSERT, LINE_UPDATE], what: "the funds effect failing after the first hold and before its line's HELD update", completedSteps: ["db.fact_insert.after", "db.hold_insert.after"] },
    ];
    for (const { label, at, steps, what, completedSteps } of cases) {
      const c = await accrued(`funds-par-${label}`, shares);
      await finalCompleted(c);
      const held = await fundsReport(c.first, "DELAYED");
      const before = await ledgerOfPurchase(c.first);
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial(what, at, async () => {
          const outcome = await settled(consumeOn(ctx, conn, held, steps));
          if ("failure" in outcome) throw outcome.failure;
          return outcome.answer;
        });
        // the step the cell names completed in the operation before the failure
        const passed = ctx.points.passed;
        for (const point of completedSteps) assert.ok(passed.includes(point), `${label}: ${point} was passed before the failure`);
        if (label === "between-lines") assert.equal(passed.filter((p) => p === "db.line_update.after").length, 1, "between-lines: exactly the first line's update had answered");
      } finally {
        await conn.end();
      }
      assert.deepEqual(await ledgerOfPurchase(c.first), before, `${label}: the whole effect rolled back (no fact, no hold, every line as before)`);
      assert.equal(await runConsumer(held), "APPLIED", `${label}: the redelivery applies the effect`);
      const done = await ledgerOfPurchase(c.first);
      assert.deepEqual(done.facts, [[held.aggregateVersion, "HELD"]], `${label}: the fact once`);
      assert.deepEqual(done.lines.map(stateOf), ["HELD", "HELD"], `${label}: both lines HELD`);
      assert.deepEqual(
        done.lines.map((l, i) => [l.version - before.lines[i]!.version, l.holds.length, l.holds[0]?.[0], l.holds[0]?.[1], l.holds[0]?.[2] === l.cumulative]),
        [[1, 1, "FUNDS_HELD", "OPEN", true], [1, 1, "FUNDS_HELD", "OPEN", true]],
        `${label}: one OPEN FUNDS_HELD hold of the whole unpaid amount per line and one HELD transition per line`,
      );
    }
  },
);

// =====================================================================================================================================
// 30. FUNDS_RETRY: the identical HELD event delivered again
// =====================================================================================================================================

/** A capture whose two lines are due (FINAL completion 721 h old), with the provider's HELD observation not yet delivered. */
async function dueUnderHeldFunds(label: string): Promise<{ readonly c: Converting; readonly held: Delivery }> {
  const c = await accrued(label, [6_000, 4_000]);
  await finalCompleted(c);
  return { c, held: await fundsReport(c.first, "DELAYED") };
}

faultCell(
  {
    id: "FUNDS_RETRY",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F1: the funds fact), the identical event delivered twice",
    fault: "retry",
    expect: "DENY: the identical HELD event delivered again answers DUPLICATE and records no second fact: one observation for the capture version, the same row after the second delivery as after the first",
  },
  async (ctx) => {
    const { c, held } = await dueUnderHeldFunds("funds-retry-fact");
    const snapshots: LedgerView[] = [];
    const answers = await ctx.sequentially(2, async () => {
      const out = await runConsumer(held);
      snapshots.push(await ledgerOfPurchase(c.first));
      return out;
    });
    assert.deepEqual(answers.map((r) => (r.status === "fulfilled" ? r.value : r.reason)), ["APPLIED", "DUPLICATE"]);
    assert.deepEqual(snapshots[0]!.facts, [[held.aggregateVersion, "HELD"]], "one observation after the first delivery");
    assert.deepEqual(snapshots[1]!.facts, snapshots[0]!.facts, "no second observation after the second");
    const rows = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.capture_funds_observations WHERE capture_id = $1 AND source_event_id = $2", [c.first.captureId, held.eventId]);
    assert.deepEqual(rows, [{ n: 1 }], "one row names the event");
  },
);

faultCell(
  {
    id: "FUNDS_RETRY",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F2: the hold per affected line), the identical event delivered twice",
    fault: "retry",
    expect: "DENY: the identical HELD event delivered again opens no second hold: exactly one applicable (OPEN) FUNDS_HELD hold per line, the same hold rows after the second delivery as after the first",
  },
  async (ctx) => {
    const { c, held } = await dueUnderHeldFunds("funds-retry-hold");
    const holdIds = async (): Promise<string[]> => (await oracleRows<{ hold_id: string }>(iw, "SELECT h.hold_id FROM kauro.commission_holds h JOIN kauro.commission_lines l ON l.line_id = h.line_id WHERE l.authorization_id = $1 ORDER BY h.hold_id", [c.first.authorizationId])).map((r) => r.hold_id);
    const snapshots: Array<{ readonly ledger: LedgerView; readonly holds: string[] }> = [];
    await ctx.sequentially(2, async () => {
      await runConsumer(held);
      snapshots.push({ ledger: await ledgerOfPurchase(c.first), holds: await holdIds() });
    });
    assert.equal(snapshots[0]!.holds.length, 2, "one hold per line after the first delivery");
    assert.deepEqual(snapshots[1]!.holds, snapshots[0]!.holds, "the same two hold rows after the second delivery: none added");
    for (const l of snapshots[1]!.ledger.lines) assert.deepEqual(l.holds.map((h) => [h[0], h[1]]), [["FUNDS_HELD", "OPEN"]], "exactly one applicable hold on each line");
  },
);

faultCell(
  {
    id: "FUNDS_RETRY",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F3: the affected lines' HELD transition), the identical event delivered twice, also for lines it must not move",
    fault: "retry",
    expect: "DENY: the identical HELD event delivered again leaves each line HELD once (the same version) and moves no VOID line: the line of a capture the provider reversed stays VOID, with no hold",
  },
  async (ctx) => {
    const { c, held } = await dueUnderHeldFunds("funds-retry-line");
    const snapshots: LedgerView[] = [];
    await ctx.sequentially(2, async () => {
      await runConsumer(held);
      snapshots.push(await ledgerOfPurchase(c.first));
    });
    assert.deepEqual(snapshots[0]!.lines.map(stateOf), ["HELD", "HELD"]);
    assert.deepEqual(snapshots[1]!.lines.map((l) => [l.state, l.version]), snapshots[0]!.lines.map((l) => [l.state, l.version]), "each line HELD once: no second transition");

    // a capture the provider reversed after reporting its HELD funds: its lines are VOID and the (late) HELD event moves none of them
    const v = await accrued("funds-retry-void", [6_000, 4_000]);
    await finalCompleted(v);
    const heldLate = await fundsReport(v.first, "DELAYED");
    iw.pw.paypal.updateCapture(v.first.providerCaptureId, { status: "REVERSED" });
    assert.equal(((await deliver(iw.pw, "PAYMENT.CAPTURE.REVERSED", v.first.providerCaptureId)).reply as { status: number }).status, 200);
    const [reversal] = await eventsOf(v.first.captureId, "capture.reversed.v1");
    assert.equal(await runConsumer(reversal!), "APPLIED");
    assert.deepEqual((await ledgerOfPurchase(v.first)).lines.map(stateOf), ["VOID", "VOID"], "the reversal voided both lines");
    const voidSnapshots: LedgerView[] = [];
    await ctx.sequentially(2, async () => {
      await runConsumer(heldLate);
      voidSnapshots.push(await ledgerOfPurchase(v.first));
    });
    assert.deepEqual(voidSnapshots[0]!.lines.map((l) => [l.state, l.holds.length]), [["VOID", 0], ["VOID", 0]], "no VOID line moved, no hold opened");
    assert.deepEqual(voidSnapshots[1]!, voidSnapshots[0]!, "and the second delivery changed nothing");
  },
);

// =====================================================================================================================================
// 31. ELIG_REV: the funds effect, a hold or a refund adjustment landing while the ELIGIBILITY pass makes a line ELIGIBLE
// =====================================================================================================================================
// The line is due (FINAL completion 721 h old) under a funds observation AVAILABLE; the provider's newer HELD observation is the event the
// consumer delivers while the sweep works on the line. Two actors contend for the line's row lock, in both orders, each stopped with its
// locks taken at an INTERMEDIATE point (the sweep right after its line lock, before its ELIGIBLE write; the consumer after its pool and line
// locks, after its hold insert, after its line update), the other observed waiting on it.

type DueAvailable = { readonly c: Converting; readonly held: Delivery; readonly lineId: string; readonly availableVersion: number };
/** A line due under funds AVAILABLE, with the provider's newer HELD observation not yet delivered to COMMISSIONS. */
async function dueUnderAvailableFunds(label: string): Promise<DueAvailable> {
  const c = await accrued(label, [10_000]);
  await finalCompleted(c);
  const available = await fundsReport(c.first, "INSTANT");
  assert.equal(await runConsumer(available), "APPLIED");
  const held = await fundsReport(c.first, "DELAYED");
  const ledger = await ledgerOfPurchase(c.first);
  assert.deepEqual([ledger.facts, ledger.lines.map(stateOf), ledger.lines[0]!.holds], [[[available.aggregateVersion, "AVAILABLE"]], ["ACCRUED_PENDING"], []], "due under AVAILABLE funds, nothing held yet");
  return { c, held, lineId: ledger.lines[0]!.lineId, availableVersion: available.aggregateVersion };
}
/** The ELIGIBILITY pass, stopped (when it is the holder) right after it locked the line, before its ELIGIBLE write. */
const eligibilityActor = (ctx: FaultContext, lineId: string): Actor => ({ name: "the ELIGIBILITY pass", login: "kauro_commission_test", holdAt: "db.line_lock.after", run: (conn) => sweepOn(ctx, conn, "ELIGIBILITY", [LINE_LOCK(lineId)]) });
const consumerOf = (ctx: FaultContext, delivery: Delivery, name: string, holdAt: string, steps: ReadonlyArray<SqlStep>): Actor => ({ name, login: "kauro_commission_test", holdAt, run: (conn) => consumeOn(ctx, conn, delivery, steps) });
const swept = (r: PromiseSettledResult<unknown>, what: string): { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> } => mustHaveSettled(r, what) as never;
/** No line of the purchase is ELIGIBLE while an OPEN hold covers its unpaid amount (KC007's second condition), whatever the interleaving. */
async function neverEligibleUnderCoveringHold(p: Purchase, what: string): Promise<void> {
  const rows = await oracleRows<{ n: number }>(
    iw,
    "SELECT count(*)::int AS n FROM kauro.commission_lines l JOIN kauro.commission_holds h ON h.line_id = l.line_id WHERE l.authorization_id = $1 AND l.state = 'ELIGIBLE' AND h.state = 'OPEN' AND h.amount_cents >= l.cumulative_entitlement_cents - coalesce(l.paid_cents, 0)",
    [p.authorizationId],
  );
  assert.deepEqual(rows, [{ n: 0 }], `${what}: never ELIGIBLE under a covering hold`);
}

type Order = "SWEEP_FIRST" | "CONSUMER_FIRST";
interface Raced {
  readonly d: DueAvailable;
  readonly ledger: LedgerView;
  readonly sweep: string | undefined;
  readonly consumer: unknown;
}
/**
 * One interleaving of the funds effect and the ELIGIBILITY pass on one due line. `consumerPoint` is where the consumer stops when it is the
 * holder; the sweep stops after its line lock. Asserts the raced units' own outcomes (before any recovery), the line's state and its holds.
 */
async function racedWithSweep(ctx: FaultContext, label: string, order: Order, consumerPoint: string, consumerSteps: ReadonlyArray<SqlStep>, during: (d: DueAvailable) => Promise<void>): Promise<Raced> {
  const what = `${label}, ${order}`;
  const d = await dueUnderAvailableFunds(`elig-${label}-${order === "SWEEP_FIRST" ? "s" : "c"}`);
  const sweepActor = eligibilityActor(ctx, d.lineId);
  const consumer = consumerOf(ctx, d.held, "the funds consumer", consumerPoint, consumerSteps);
  const out = order === "SWEEP_FIRST" ? await contend(ctx, sweepActor, consumer, what, () => during(d)) : await contend(ctx, consumer, sweepActor, what, () => during(d));
  const sweepReport = swept(order === "SWEEP_FIRST" ? out.holder : out.waiter, "the ELIGIBILITY pass");
  const consumerOutcome = mustHaveSettled(order === "SWEEP_FIRST" ? out.waiter : out.holder, "the funds consumer");
  const ledger = await ledgerOfPurchase(d.c.first);
  await neverEligibleUnderCoveringHold(d.c.first, what);
  return { d, ledger, sweep: itemOf(sweepReport, d.lineId), consumer: consumerOutcome };
}

/** What every ELIG_REV funds cell asserts of the two interleavings. */
function assertFundsAndSweep(what: string, order: Order, r: Raced): void {
  assert.equal(r.consumer, "APPLIED", `${what}: the funds consumer recorded the fact`);
  assert.deepEqual(r.ledger.facts.map((f) => f[1]), ["AVAILABLE", "HELD"], `${what}: both observations are recorded, the HELD one the newer`);
  const [line] = r.ledger.lines;
  if (order === "SWEEP_FIRST") {
    // the pass committed under the funds that were AVAILABLE; the HELD fact serialized after it and finds the line ELIGIBLE (no edge back to HELD: the statement judges funds again at its close)
    assert.equal(r.sweep, "ELIGIBLE", `${what}: the pass made the line ELIGIBLE`);
    assert.deepEqual([line!.state, line!.holds.length], ["ELIGIBLE", 0], `${what}: ELIGIBLE and no hold opened over it`);
  } else {
    // the fact committed first: the line is HELD under an OPEN hold of its whole amount and the pass, finding it no longer due, settles without writing
    assert.equal(r.sweep, "SETTLED", `${what}: the pass found the line no longer due and wrote nothing`);
    assert.deepEqual([line!.state, line!.holds.map((h) => [h[0], h[1], h[2] === line!.cumulative])], ["HELD", [["FUNDS_HELD", "OPEN", true]]], `${what}: HELD under an OPEN hold of its whole unpaid amount`);
  }
}

faultCell(
  {
    id: "ELIG_REV",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F1: the funds fact recorded, its transaction paused after its pool and line locks) and the ELIGIBILITY pass (paused after its line lock), contending for a due line",
    fault: "race",
    expect:
      "RACE: a HELD funds fact landing while the ELIGIBILITY pass makes a due line ELIGIBLE, in both orders with the lock wait observed (the fact inserted but uncommitted while the pass holds the line; the pass waiting on the consumer's line lock): never ELIGIBLE under a covering hold and no failed unit. Pass first: the line is ELIGIBLE (committed under funds AVAILABLE) and the later HELD fact opens no hold over it; fact first: the line is HELD under an OPEN FUNDS_HELD hold of its whole amount and the pass settles it without writing",
  },
  async (ctx) => {
    for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
      const r = await racedWithSweep(ctx, "fact", order, "db.lines_lock.after", [FACT_INSERT, LINES_LOCK], async (d) => {
        // the fact's insert answered (uncommitted, so the superuser still sees one observation) while the other unit holds the line
        assert.ok(ctx.points.passed.includes("db.fact_insert.after"), "the consumer inserted its fact before it stopped or waited");
        assert.deepEqual((await ledgerOfPurchase(d.c.first)).facts.map((f) => f[1]), ["AVAILABLE"], "the HELD fact is not committed yet");
      });
      assertFundsAndSweep(`fact, ${order}`, order, r);
    }
  },
);

faultCell(
  {
    id: "ELIG_REV",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F2: the FUNDS_HELD hold opened, its transaction paused right after the hold insert) and the ELIGIBILITY pass, contending for a due line",
    fault: "race",
    expect:
      "RACE: a hold opened while the ELIGIBILITY pass reads the line, in both orders with the lock wait observed: the line is never ELIGIBLE under the covering hold and no unit fails. Pass first: ELIGIBLE and the consumer opens no hold over it (no hold insert ran); hold first (uncommitted at the pass's wait): the pass settles without writing and the line is HELD under the OPEN hold",
  },
  async (ctx) => {
    for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
      const holdsBefore = ctx.points.passed.filter((p) => p === "db.hold_insert.after").length;
      const r = await racedWithSweep(ctx, "hold", order, "db.hold_insert.after", [HOLD_INSERT], async () => {
        if (order === "CONSUMER_FIRST") assert.equal(ctx.points.passed.filter((p) => p === "db.hold_insert.after").length, holdsBefore + 1, "the hold's insert answered before the pass waited");
      });
      assertFundsAndSweep(`hold, ${order}`, order, r);
      if (order === "SWEEP_FIRST") assert.equal(ctx.points.passed.filter((p) => p === "db.hold_insert.after").length, holdsBefore, "hold, SWEEP_FIRST: no hold was inserted over the ELIGIBLE line");
    }
  },
);

faultCell(
  {
    id: "ELIG_REV",
    step: "COMMISSIONS consumer capture.funds_observed.v1 HELD (F3: the line's HELD transition, its transaction paused right after the line UPDATE) and the ELIGIBILITY pass, contending for a due line",
    fault: "race",
    expect:
      "RACE: the funds effect's line transition racing the ELIGIBILITY pass, in both orders with the lock wait observed: HELD under its OPEN hold when the consumer committed first (the pass finding it no longer due), ELIGIBLE with the consumer opening nothing when the pass did; never ELIGIBLE under a covering hold, no failed unit",
  },
  async (ctx) => {
    for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
      const updatesBefore = ctx.points.passed.filter((p) => p === "db.line_update.after").length;
      const r = await racedWithSweep(ctx, "line", order, "db.line_update.after", [LINE_UPDATE], async () => {
        if (order === "CONSUMER_FIRST") assert.equal(ctx.points.passed.filter((p) => p === "db.line_update.after").length, updatesBefore + 1, "the line's HELD update answered before the pass waited");
      });
      assertFundsAndSweep(`line, ${order}`, order, r);
    }
  },
);

// --- ELIG_REV, the sweep's own cell: a refund adjustment or a reversal landing while the pass makes the line ELIGIBLE -------------------------

/** A customer refund of the purchase's service executed through CMD033: the one refund.completed.v1, not delivered to COMMISSIONS. */
async function refundEventOf(c: Converting, serviceCents: bigint): Promise<Delivery> {
  const refundId = await approvedRefund(iw, c.s, c.first, { serviceCents });
  const executed = completed<ExecuteRefundView>(await paymentExecute(iw.pw, refundId, { expectedVersion: 2 }), 200);
  assert.equal(executed.data.refund.state, "COMPLETED");
  const events = await eventsOf(c.first.captureId, "refund.completed.v1");
  return events[events.length - 1]!;
}
/** The provider reverses the capture and reports it through the webhook: the one capture.reversed.v1, not delivered to COMMISSIONS. */
async function reversalEventOf(p: Purchase): Promise<Delivery> {
  iw.pw.paypal.updateCapture(p.providerCaptureId, { status: "REVERSED" });
  assert.equal(completed<WebhookAck>((await deliver(iw.pw, "PAYMENT.CAPTURE.REVERSED", p.providerCaptureId)).reply, 200).data.inboxState, "APPLIED");
  const events = await eventsOf(p.captureId, "capture.reversed.v1");
  assert.equal(events.length, 1);
  return events[0]!;
}
const adjustmentsOfPurchase = async (p: Purchase): Promise<ReadonlyArray<readonly [string, string, string, string]>> =>
  (await oracleRows<{ line_id: string; adjustment_seq: number; direction: string; amount_cents: string; new_cumulative_entitlement_cents: string; source_event_id: string }>(
    iw,
    "SELECT a.line_id, a.adjustment_seq, a.direction, a.amount_cents::text, a.new_cumulative_entitlement_cents::text, a.source_event_id FROM kauro.commission_adjustments a JOIN kauro.commission_lines l ON l.line_id = a.line_id WHERE l.authorization_id = $1 ORDER BY l.seller_id, a.adjustment_seq",
    [p.authorizationId],
  )).map((a) => [a.direction, a.amount_cents, a.new_cumulative_entitlement_cents, a.source_event_id] as const);
const poolCentsOf = async (p: Purchase): Promise<string> => (await oracleRows<{ pool_cents: string }>(iw, "SELECT pool_cents::text FROM kauro.commission_pools WHERE authorization_id = $1", [p.authorizationId]))[0]!.pool_cents;

faultCell(
  {
    id: "ELIG_REV",
    step: "COMMISSIONS consumer refund.completed.v1 / capture.reversed.v1 (the adjustment and the line's state, its transaction paused after the adjustment insert) and the ELIGIBILITY pass (paused after its line lock), contending for a due line",
    fault: "race",
    expect:
      "RACE: a refund adjustment or a reversal landing while the ELIGIBILITY pass makes the line ELIGIBLE, each in both orders with the lock wait observed and no failed unit: the line ends ELIGIBLE with the adjusted cumulative (the refund's one DECREASE adjustment, whichever committed first) or, for the reversal, VOID at zero (the pass finding it VOID settles it without a write), never ELIGIBLE at a cumulative the refund had already lowered",
  },
  async (ctx) => {
    for (const change of ["REFUND", "REVERSAL"] as const) {
      for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
        const what = `${change.toLowerCase()}, ${order}`;
        const c = await accrued(`elig-adj-${change.toLowerCase()}-${order === "SWEEP_FIRST" ? "s" : "c"}`, [10_000]);
        await finalCompleted(c);
        assert.equal(await runConsumer(await fundsReport(c.first, "INSTANT")), "APPLIED");
        const event = change === "REFUND" ? await refundEventOf(c, 10_000n) : await reversalEventOf(c.first);
        const before = await ledgerOfPurchase(c.first);
        assert.deepEqual(before.lines.map(stateOf), ["ACCRUED_PENDING"]);
        const lineId = before.lines[0]!.lineId;
        const sweep = eligibilityActor(ctx, lineId);
        const consumer = consumerOf(ctx, event, `the ${change === "REFUND" ? "refund" : "reversal"} consumer`, "db.adjustment_insert.after", [ADJUSTMENT_INSERT]);
        const adjustmentsBefore = ctx.points.passed.filter((p) => p === "db.adjustment_insert.after").length;
        const out =
          order === "SWEEP_FIRST"
            ? await contend(ctx, sweep, consumer, what)
            : await contend(ctx, consumer, sweep, what, async () => assert.equal(ctx.points.passed.filter((p) => p === "db.adjustment_insert.after").length, adjustmentsBefore + 1, `${what}: the adjustment's insert answered before the pass waited`));
        const report = swept(order === "SWEEP_FIRST" ? out.holder : out.waiter, "the ELIGIBILITY pass");
        assert.equal(mustHaveSettled(order === "SWEEP_FIRST" ? out.waiter : out.holder, "the consumer"), "APPLIED", `${what}: the consumer applied the change`);
        const after = await ledgerOfPurchase(c.first);
        const adjustments = await adjustmentsOfPurchase(c.first);
        if (change === "REFUND") {
          const adjusted = await poolCentsOf(c.first);
          assert.ok(BigInt(adjusted) < BigInt(before.lines[0]!.cumulative), `${what}: the refund lowered the pool`);
          assert.equal(itemOf(report, lineId), "ELIGIBLE", `${what}: the pass made the line ELIGIBLE`);
          assert.deepEqual([after.lines[0]!.state, after.lines[0]!.cumulative], ["ELIGIBLE", adjusted], `${what}: ELIGIBLE with the adjusted cumulative`);
          assert.deepEqual(adjustments.map((a) => [a[0], a[2], a[3]]), [["DECREASE", adjusted, event.eventId]], `${what}: the refund's one adjustment`);
        } else {
          assert.equal(itemOf(report, lineId), order === "SWEEP_FIRST" ? "ELIGIBLE" : "SETTLED", `${what}: the pass ${order === "SWEEP_FIRST" ? "committed before the reversal" : "found the line VOID"}`);
          assert.deepEqual([after.lines[0]!.state, after.lines[0]!.cumulative], ["VOID", "0"], `${what}: VOID at zero`);
          assert.deepEqual(adjustments.map((a) => [a[0], a[2], a[3]]), [["DECREASE", "0", event.eventId]], `${what}: the reversal's one adjustment`);
        }
        await neverEligibleUnderCoveringHold(c.first, what);
      }
    }
  },
);

// =====================================================================================================================================
// 32. CONS_DUP_LINE: refund, reversal and completion racing each other in concurrent dispatchers
// =====================================================================================================================================
// Two COMMISSIONS consumers (two dispatchers whose lease changed hands, each delivering at least once) apply events of one capture at once.
// Each takes the agency's commission subject first, so the second waits on the first (observed), in both orders; the end state is asserted
// against the sequential order test's invariant: the same cumulative entitlements, one adjustment per changed line and event.

const poolKinds = async (p: Purchase): Promise<ReadonlyArray<string>> => (await poolsOf(iw, p.authorizationId)).map((x) => `${x.source} ${x.rate_kind} ${x.rate_bps}`);
const adjustmentStop: ReadonlyArray<SqlStep> = [ADJUSTMENT_INSERT];

faultCell(
  {
    id: "CONS_DUP_LINE",
    step: "COMMISSIONS consumer refund.completed.v1 and capture.reversed.v1 (the adjustment and the line state), two dispatchers applying events of one capture concurrently",
    fault: "race",
    expect:
      "RACE: the refund and the reversal of one capture applied by two consumers at once, the refund twice by two dispatchers, and the capture's completion racing its refund, each in both orders with the lock wait observed (the first stopped after its adjustment insert, the second waiting for the agency): the same cumulative entitlements as the sequential order, one adjustment per changed line and event, never a second adjustment for an event, every unit applied or answering DUPLICATE",
  },
  async (ctx) => {
    // (1) refund and reversal: whichever commits first, the lines end VOID at zero; the later event adds an adjustment only when it still changes a line
    for (const order of ["REFUND_FIRST", "REVERSAL_FIRST"] as const) {
      const what = `refund and reversal, ${order}`;
      const c = await accrued(`dup-refund-reversal-${order === "REFUND_FIRST" ? "1" : "2"}`, [6_000, 4_000]);
      const refund = await refundEventOf(c, 10_000n);
      const reversal = await reversalEventOf(c.first);
      const refundActor = consumerOf(ctx, refund, "the refund dispatcher", "db.adjustment_insert.after", adjustmentStop);
      const reversalActor = consumerOf(ctx, reversal, "the reversal dispatcher", "db.adjustment_insert.after", adjustmentStop);
      const out = order === "REFUND_FIRST" ? await contend(ctx, refundActor, reversalActor, what) : await contend(ctx, reversalActor, refundActor, what);
      const [refundOutcome, reversalOutcome] = order === "REFUND_FIRST" ? [mustHaveSettled(out.holder, "the refund"), mustHaveSettled(out.waiter, "the reversal")] : [mustHaveSettled(out.waiter, "the refund"), mustHaveSettled(out.holder, "the reversal")];
      assert.equal(reversalOutcome, "APPLIED", `${what}: the reversal applied`);
      assert.equal(refundOutcome, order === "REFUND_FIRST" ? "APPLIED" : "DUPLICATE", `${what}: the refund applied before the reversal, and changed nothing after it`);
      const ledger = await ledgerOfPurchase(c.first);
      assert.deepEqual(ledger.lines.map((l) => [l.state, l.cumulative]), [["VOID", "0"], ["VOID", "0"]], `${what}: the same cumulative entitlements in either order: both lines VOID at zero`);
      const adjustments = await adjustmentsOfPurchase(c.first);
      const perEvent = new Map<string, number>();
      for (const a of adjustments) perEvent.set(a[3], (perEvent.get(a[3]) ?? 0) + 1);
      assert.deepEqual([...perEvent.entries()].sort(), order === "REFUND_FIRST" ? [[refund.eventId, 2], [reversal.eventId, 2]].sort() : [[reversal.eventId, 2]], `${what}: one adjustment per changed line and event`);
      assert.equal(await poolCentsOf(c.first), "0", `${what}: the pool at zero`);
    }

    // (2) the same refund delivered by two dispatchers: the second answers DUPLICATE and adds nothing
    {
      const what = "the same refund twice, two dispatchers";
      const c = await accrued("dup-refund-twice", [6_000, 4_000]);
      const refund = await refundEventOf(c, 10_000n);
      const first = consumerOf(ctx, refund, "the first dispatcher", "db.adjustment_insert.after", adjustmentStop);
      const second = consumerOf(ctx, refund, "the second dispatcher", "db.adjustment_insert.after", adjustmentStop);
      const out = await contend(ctx, first, second, what);
      assert.deepEqual([mustHaveSettled(out.holder, "the first"), mustHaveSettled(out.waiter, "the second")], ["APPLIED", "DUPLICATE"], `${what}: applied once, the other answering DUPLICATE`);
      const adjustments = await adjustmentsOfPurchase(c.first);
      assert.equal(adjustments.length, 2, `${what}: one adjustment per line`);
      assert.deepEqual([...new Set(adjustments.map((a) => a[3]))], [refund.eventId]);
      const ledger = await ledgerOfPurchase(c.first);
      assert.equal(ledger.lines.map((l) => BigInt(l.cumulative)).reduce((x, y) => x + y, 0n).toString(), await poolCentsOf(c.first), `${what}: the lines sum to the adjusted pool`);
    }

    // (3) the capture's completion racing its refund: a refund before its completion accrues the purchase first, the completion then finds it done
    for (const order of ["COMPLETION_FIRST", "REFUND_FIRST"] as const) {
      const what = `completion and refund, ${order}`;
      const c = await converting(`dup-completion-refund-${order === "COMPLETION_FIRST" ? "1" : "2"}`, [6_000, 4_000]);
      const refund = await refundEventOf(c, 10_000n);
      const completion = consumerOf(ctx, c.delivery, "the completion dispatcher", "uow.before-commit", []);
      const refunding = consumerOf(ctx, refund, "the refund dispatcher", "db.adjustment_insert.after", adjustmentStop);
      const out = order === "COMPLETION_FIRST" ? await contend(ctx, completion, refunding, what) : await contend(ctx, refunding, completion, what);
      const [completionOutcome, refundOutcome] = order === "COMPLETION_FIRST" ? [mustHaveSettled(out.holder, "the completion"), mustHaveSettled(out.waiter, "the refund")] : [mustHaveSettled(out.waiter, "the completion"), mustHaveSettled(out.holder, "the refund")];
      assert.equal(refundOutcome, "APPLIED", `${what}: the refund applied`);
      assert.equal(completionOutcome, order === "COMPLETION_FIRST" ? "APPLIED" : "DUPLICATE", `${what}: the completion ${order === "COMPLETION_FIRST" ? "accrued" : "found the purchase accrued by the refund"}`);
      assert.deepEqual(await rightsOf(c), convertedFor(c, [6_000, 4_000]), `${what}: converted once, one pool, one line per beneficiary`);
      const adjusted = await poolCentsOf(c.first);
      const ledger = await ledgerOfPurchase(c.first);
      assert.equal(ledger.lines.map((l) => BigInt(l.cumulative)).reduce((x, y) => x + y, 0n).toString(), adjusted, `${what}: the lines sum to the refund-adjusted pool`);
      const adjustments = await adjustmentsOfPurchase(c.first);
      assert.deepEqual([adjustments.length, [...new Set(adjustments.map((a) => a[3]))]], [2, [refund.eventId]], `${what}: one adjustment per line, all of the refund`);
    }
  },
);

faultCell(
  {
    id: "CONS_DUP_LINE",
    step: "COMMISSIONS consumer commercial_authorization.delivered.v1 (W2: the completion record), the STAGE and FINAL completions of one purchase recorded by two consumers, and by a consumer and the ELIGIBILITY pass, at once",
    fault: "race",
    expect:
      "RACE: the STAGE and the FINAL completion the source reports for one purchase recorded concurrently by two dispatchers, and by a dispatcher and the ELIGIBILITY pass, in both orders with the lock wait observed (the first stopped right after its first completion insert, the second waiting on that uncommitted row): exactly one STAGE and one FINAL completion, one unit recording both and the other answering DUPLICATE",
  },
  async (ctx) => {
    const completionInsert = (authorizationId: string): SqlStep => ({ label: "completion_insert", match: /INSERT INTO kauro\.purchase_completions/, when: (params) => params[2] === authorizationId });
    const completionsOfPurchase = async (p: Purchase): Promise<ReadonlyArray<readonly [string, string | null]>> =>
      (await oracleRows<{ kind: string; stage_ref: string | null }>(iw, "SELECT kind, stage_ref FROM kauro.purchase_completions WHERE authorization_id = $1 ORDER BY kind, stage_ref", [p.authorizationId])).map((r) => [r.kind, r.stage_ref] as const);
    const report = (c: Converting): void => {
      iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "STAGE", stageRef: "parent-stage", completedAt: new Date(Date.now() - 800 * HOUR_MS).toISOString() as never, source: "STAGED_PREPARATION" });
      iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "FINAL", completedAt: new Date(Date.now() - 721 * HOUR_MS).toISOString() as never, source: "STAGED_PREPARATION" });
    };
    for (const pairing of ["TWO_DISPATCHERS", "DISPATCHER_AND_SWEEP"] as const) {
      for (const order of ["FIRST_HOLDS", "SECOND_HOLDS"] as const) {
        const what = `${pairing}, ${order}`;
        const c = await accrued(`dup-completions-${pairing === "TWO_DISPATCHERS" ? "d" : "s"}-${order === "FIRST_HOLDS" ? "1" : "2"}`, [10_000]);
        report(c);
        const delivered = await deliveryOf(iw, await deliveredByTheExecutionPackage(iw, c.first.authorizationId, c.agencyId));
        const steps = [completionInsert(c.first.authorizationId)];
        const dispatcher = (name: string): Actor => consumerOf(ctx, delivered, name, "db.completion_insert.after", steps);
        const sweep: Actor = { name: "the ELIGIBILITY pass", login: "kauro_commission_test", holdAt: "db.completion_insert.after", run: (conn) => sweepOn(ctx, conn, "ELIGIBILITY", steps) };
        const [first, second] = pairing === "TWO_DISPATCHERS" ? [dispatcher("the first dispatcher"), dispatcher("the second dispatcher")] : order === "FIRST_HOLDS" ? [dispatcher("the dispatcher"), sweep] : [sweep, dispatcher("the dispatcher")];
        const out = await contend(ctx, first, second, what);
        const answers = [mustHaveSettled(out.holder, "the holder"), mustHaveSettled(out.waiter, "the waiter")];
        assert.deepEqual(await completionsOfPurchase(c.first), [["FINAL", null], ["STAGE", "parent-stage"]], `${what}: exactly one STAGE and one FINAL completion`);
        if (pairing === "TWO_DISPATCHERS") assert.deepEqual(answers, ["APPLIED", "DUPLICATE"], `${what}: one dispatcher recorded both, the other answered DUPLICATE`);
        else {
          const [dispatched, swept2] = first === sweep ? [answers[1], answers[0]] : [answers[0], answers[1]];
          const sweepItem = itemOf(swept2 as SweepReport, c.first.authorizationId);
          const winner = first === sweep ? "SWEEP" : "DISPATCHER";
          assert.deepEqual([dispatched, sweepItem], winner === "DISPATCHER" ? ["APPLIED", "NO_COMPLETION"] : ["DUPLICATE", "COMPLETIONS 2"], `${what}: ${winner === "DISPATCHER" ? "the dispatcher recorded both and the pass found nothing new" : "the pass recorded both and the dispatcher answered DUPLICATE"}`);
        }
      }
    }
  },
);

// =====================================================================================================================================
// 33. ACCRUAL_REC_RACE: ACCRUAL_RECONCILIATION racing the COMMISSIONS accrual of the same purchase
// =====================================================================================================================================

faultCell(
  {
    id: "ACCRUAL_REC_RACE",
    step: "ACCRUAL_RECONCILIATION (the pool and lines of a late purchase: its accrual unit stopped right after its pool insert, or standing at its agency lock with the purchase already listed) and the COMMISSIONS consumer's accrual of the same purchase (stopped right after its pool insert, or contending)",
    fault: "race",
    expect:
      "RACE: the sweep's accrual unit and the consumer accruing the same second purchase of an agency, in both orders with the lock wait observed (the first stopped with its pool inserted and uncommitted, the second waiting on the agency's commission subject; in the consumer-first order the sweep has already listed the purchase as lacking its pool and is let go from its accrual unit's start once the consumer holds the agency, its wait on the consumer observed in pg_blocking_pids): one pool and one line per beneficiary at the repeat rate, the second unit finding it made (NOTHING_TO_ACCRUE, DUPLICATE); with the purchase's refund already completed at the provider the sweep's current basis and the consumer's allocated basis end, once the refund event is delivered, at the same cumulative entitlements",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    for (const withRefund of [false, true]) {
      for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
        const what = `${withRefund ? "refund completed at the provider, " : ""}${order}`;
        const c = await accrued(`accrual-rec-${withRefund ? "r" : "n"}-${order === "SWEEP_FIRST" ? "s" : "c"}`, shares);
        const second = await purchase(iw, c.s, `accrual-rec-second-${withRefund ? "r" : "n"}-${order}`);
        const delivery = await deliveryOfCapture(second);
        const refund = withRefund ? await refundEventOf({ ...c, first: second }, 10_000n) : null;
        assert.deepEqual([(await poolsOf(iw, second.authorizationId)).length, (await linesOf(iw, second.authorizationId)).length], [0, 0], `${what}: the second purchase is not accrued yet`);
        const poolInsert: SqlStep = { label: "pool_insert", match: /INSERT INTO kauro\.commission_pools/, when: (params) => params[1] === second.authorizationId };
        const sweepActor: Actor = { name: "the ACCRUAL_RECONCILIATION pass", login: "kauro_commission_test", holdAt: "db.pool_insert.after", run: (conn) => sweepOn(ctx, conn, "ACCRUAL_RECONCILIATION", [poolInsert]) };
        const consumerActor = consumerOf(ctx, delivery, "the accruing consumer", "db.pool_insert.after", [poolInsert]);
        let sweepReport: ReturnType<typeof swept>;
        let consumerOutcome: unknown;
        if (order === "SWEEP_FIRST") {
          const out = await contend(ctx, sweepActor, consumerActor, what);
          sweepReport = swept(out.holder, "the sweep");
          consumerOutcome = mustHaveSettled(out.waiter, "the consumer");
        } else {
          // the sweep's three units of this agency (conversion, listing of the purchases lacking a pool, accrual of one) each begin by adopting
          // the agency: the first two are let through, the third, which has the purchase on its list, stands before its agency lock; the consumer
          // then takes the agency, inserts the pool and stops; the sweep is let go and observed waiting on it
          const sweepConn = await open("kauro_commission_test");
          const consumerConn = await open("kauro_commission_test");
          const seen = failures.length;
          try {
            const adopt: SqlStep = { label: "adopt", match: /SELECT set_config\('kauro\.agency_id', \$1, true\)/, when: (params) => params[0] === c.agencyId };
            const sweeping = ctx.operation("the ACCRUAL_RECONCILIATION pass (its listing holds the purchase, it stands at its accrual unit)", () => settled(sweepOn(ctx, sweepConn, "ACCRUAL_RECONCILIATION", [adopt])));
            for (let unit = 0; unit < 2; unit++) {
              const through = ctx.points.pause("db.adopt.after");
              await through.reachedBy(sweeping);
              through.release();
            }
            const atLock = ctx.points.pause("db.adopt.after");
            await atLock.reachedBy(sweeping).catch(async (e: unknown) => {
              const o = await sweeping;
              throw new Error(`the sweep did not stand at its accrual unit: ${"failure" in o ? String(o.failure) : JSON.stringify(o.answer)}`, { cause: e });
            });
            const atPool = ctx.points.pause("db.pool_insert.after");
            const consuming = ctx.operation("the accruing consumer (holder)", () => settled(consumeOn(ctx, consumerConn, delivery, [poolInsert])));
            await atPool.reachedBy(consuming);
            atLock.release();
            await observeBlocked(sweepConn, consumerConn, `${what}: the sweep's accrual unit waiting on the consumer's agency lock`);
            atPool.release();
            const [swept1, consumed] = await Promise.all([sweeping, consuming]);
            sweepReport = swept("failure" in swept1 ? { status: "rejected", reason: swept1.failure } : { status: "fulfilled", value: swept1.answer }, "the sweep");
            consumerOutcome = mustHaveSettled("failure" in consumed ? { status: "rejected", reason: consumed.failure } : { status: "fulfilled", value: consumed.answer }, "the consumer");
            assert.deepEqual(failures.slice(seen).map((f) => f.subject), [], `${what}: a raced unit reported a failure`);
          } finally {
            await sweepConn.end();
            await consumerConn.end();
          }
        }
        assert.equal(itemOf(sweepReport, second.authorizationId), order === "SWEEP_FIRST" ? "ACCRUED 1" : "NOTHING_TO_ACCRUE", `${what}: the sweep's accrual of the purchase`);
        assert.equal(consumerOutcome, order === "SWEEP_FIRST" ? "DUPLICATE" : "APPLIED", `${what}: the consumer's accrual of the purchase`);
        assert.deepEqual(await poolKinds(second), ["ACQUISITION REPEAT 400"], `${what}: one pool at the repeat rate`);
        assert.equal((await linesOf(iw, second.authorizationId)).length, 2, `${what}: one line per beneficiary`);
        if (refund !== null) {
          const outcome = await runConsumer(refund);
          // whichever accrued first, the refund then leaves the same cumulative entitlements: the pool's lines sum to the refunded pool
          assert.equal(outcome, order === "SWEEP_FIRST" ? "DUPLICATE" : "APPLIED", `${what}: the refund event ${order === "SWEEP_FIRST" ? "finds the pool already at the current (refunded) basis" : "lowers the pool the consumer accrued at the allocated basis"}`);
          const ledger = await ledgerOfPurchase(second);
          const adjusted = await poolCentsOf(second);
          assert.equal(ledger.lines.map((l) => BigInt(l.cumulative)).reduce((x, y) => x + y, 0n).toString(), adjusted, `${what}: the lines sum to the refunded pool`);
          const full = (await oracleRows<{ initial_basis_cents: string; basis_cents: string }>(iw, "SELECT initial_basis_cents::text, basis_cents::text FROM kauro.commission_pools WHERE authorization_id = $1", [second.authorizationId]))[0]!;
          assert.equal(BigInt(full.basis_cents), BigInt(second.serviceCents) - 10_000n, `${what}: the pool's basis is the refunded one`);
          assert.equal(full.initial_basis_cents, order === "SWEEP_FIRST" ? full.basis_cents : String(second.serviceCents), `${what}: the initial basis is ${order === "SWEEP_FIRST" ? "the current one the sweep accrued at" : "the allocated one the consumer accrued at"}`);
        }
      }
    }
  },
);

// =====================================================================================================================================
// 36. CONS_PAR: failure between the writes of one COMMISSIONS effect
// =====================================================================================================================================

const POOL_INSERT: SqlStep = { label: "pool_insert", match: /INSERT INTO kauro\.commission_pools/ };
const LINE_INSERT: SqlStep = { label: "line_insert", match: /INSERT INTO kauro\.commission_lines/ };
const MIRROR_UPDATE: SqlStep = { label: "mirror_update", match: /UPDATE kauro\.agencies a SET first_qualifying_capture_id/ };
const CLAIM_UPDATE: SqlStep = { label: "claim_update", match: /UPDATE kauro\.attribution_claims/ };
const POOL_UPDATE: SqlStep = { label: "pool_update", match: /UPDATE kauro\.commission_pools SET basis_cents/ };
/** The line's STATE transition (transitionLine: `UPDATE kauro.commission_lines l SET state = ...`), not the cumulative or basis update of an adjustment. */
const LINE_STATE: SqlStep = { label: "line_state", match: /UPDATE kauro\.commission_lines l SET state = / };

/** A cell's failure of a consumer delivery: runs it routed over `conn` and throws what it raised (the operation `ctx.partial` requires to fail). */
async function failing(ctx: FaultContext, conn: Awaited<ReturnType<typeof open>>, delivery: Delivery, steps: ReadonlyArray<SqlStep>): Promise<unknown> {
  const outcome = await settled(consumeOn(ctx, conn, delivery, steps));
  if ("failure" in outcome) throw outcome.failure;
  return outcome.answer;
}

interface FirstAccrual {
  readonly rights: Awaited<ReturnType<typeof rightsOf>>;
  readonly mirror: string | null;
  readonly designated: number;
}
const firstAccrualOf = async (c: Converting): Promise<FirstAccrual> => ({
  rights: await rightsOf(c),
  mirror: (await oracleRows<{ first_qualifying_capture_id: string | null }>(iw, "SELECT first_qualifying_capture_id FROM kauro.agencies WHERE agency_id = $1", [c.agencyId]))[0]!.first_qualifying_capture_id,
  designated: (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.domain_events WHERE agency_id = $1 AND event_type = 'agency.first_purchase_designated.v1'", [c.agencyId]))[0]!.n,
}) ;

faultCell(
  {
    id: "CONS_PAR",
    step: "COMMISSIONS consumer capture.completed.v1 (the first designation mirror, the claim conversion, the pool, a line, a hold and the line's HELD update of one unit): a failure after the mirror, after the pool, after the first line, and after a hold",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the designation mirror's update, after the pool insert, after the first beneficiary's line insert (the second's not yet written) and, for a purchase whose provider time is unverified, after a line's hold insert, rolls the whole effect back (no mirror and no designation event, no entitlement, claim conversion, pool, line or hold); the redelivery then produces the effect once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const cases: ReadonlyArray<{ readonly label: string; readonly at: string; readonly steps: ReadonlyArray<SqlStep>; readonly completedSteps: ReadonlyArray<string> }> = [
      { label: "after-mirror", at: "db.claim_update.before", steps: [MIRROR_UPDATE, CLAIM_UPDATE], completedSteps: ["db.mirror_update.after"] },
      { label: "after-pool", at: "db.line_insert.before", steps: [POOL_INSERT, LINE_INSERT], completedSteps: ["db.pool_insert.after"] },
      { label: "after-first-line", at: "db.line2_insert.before", steps: [{ ...LINE_INSERT, label: "line1_insert", nth: 1 }, { ...LINE_INSERT, label: "line2_insert", nth: 2 }], completedSteps: ["db.line1_insert.after"] },
    ];
    for (const { label, at, steps, completedSteps } of cases) {
      const c = await converting(`cons-par-completed-${label}`, shares);
      const before = await firstAccrualOf(c);
      assert.deepEqual([before.rights, before.mirror, before.designated], [nothingFor(c), null, 0]);
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial(`the consumer failing ${label}`, at, () => failing(ctx, conn, c.delivery, steps));
        for (const point of completedSteps) assert.ok(ctx.points.passed.includes(point), `${label}: ${point} was passed before the failure`);
      } finally {
        await conn.end();
      }
      assert.deepEqual(await firstAccrualOf(c), before, `${label}: no mirror, no designation event, no conversion, pool or line remains`);
      assert.equal(await runConsumer(c.delivery), "APPLIED", `${label}: the redelivery applies the effect`);
      const done = await firstAccrualOf(c);
      assert.deepEqual([done.rights, done.mirror, done.designated], [convertedFor(c, shares), c.first.captureId, 1], `${label}: converted once, one pool and one line per beneficiary, the mirror and its event once`);
    }

    // a later purchase whose provider completion is after its own confirmation: each line is born HELD under a hold of its whole amount
    {
      const c = await accrued("cons-par-completed-hold", shares);
      const unverified = await purchase(iw, c.s, "cons-par-completed-hold-R", { providerCompletedAt: new Date(Date.now() + HOUR_MS).toISOString() });
      const delivery = await deliveryOfCapture(unverified);
      const census = async (): Promise<ReadonlyArray<number>> => [(await poolsOf(iw, unverified.authorizationId)).length, (await linesOf(iw, unverified.authorizationId)).length, (await ledgerOfPurchase(unverified)).lines.reduce((n, l) => n + l.holds.length, 0)];
      assert.deepEqual(await census(), [0, 0, 0]);
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial("the consumer failing after a born-HELD line's hold insert and before its HELD update", "db.line_update.before", () => failing(ctx, conn, delivery, [HOLD_INSERT, LINE_UPDATE]));
        assert.ok(ctx.points.passed.includes("db.hold_insert.after"), "after-hold: the hold insert answered before the failure");
      } finally {
        await conn.end();
      }
      assert.deepEqual(await census(), [0, 0, 0], "after-hold: no pool, line or hold remains");
      assert.equal(await runConsumer(delivery), "APPLIED", "after-hold: the redelivery applies the effect");
      const ledger = await ledgerOfPurchase(unverified);
      assert.deepEqual(await poolKinds(unverified), ["ACQUISITION REPEAT 400"]);
      assert.deepEqual(
        ledger.lines.map((l) => [l.state, l.holds.map((h) => [h[0], h[1], h[2] === l.cumulative])]),
        [["HELD", [["PROVIDER_TIME_UNVERIFIED", "OPEN", true]]], ["HELD", [["PROVIDER_TIME_UNVERIFIED", "OPEN", true]]]],
        "after-hold: each line HELD under one OPEN hold of its whole amount, once",
      );
    }
  },
);

/** The pool, each line and every adjustment of a purchase: what a basis change writes. */
async function basisLedgerOf(p: Purchase): Promise<{ readonly pool: ReadonlyArray<string>; readonly lines: ReadonlyArray<readonly [string, number, string]>; readonly adjustments: number }> {
  const [pool] = await oracleRows<{ basis_cents: string; pool_cents: string; version: string }>(iw, "SELECT basis_cents::text, pool_cents::text, version::text FROM kauro.commission_pools WHERE authorization_id = $1", [p.authorizationId]);
  const ledger = await ledgerOfPurchase(p);
  return { pool: [pool!.basis_cents, pool!.pool_cents, pool!.version], lines: ledger.lines.map((l) => [l.state, l.version, l.cumulative] as const), adjustments: (await adjustmentsOfPurchase(p)).length };
}

faultCell(
  {
    id: "CONS_PAR",
    step: "COMMISSIONS consumer refund.completed.v1 and capture.reversed.v1 (the pool's basis, each line's adjustment and cumulative, each line's state): a failure after the pool update, after the first line's adjustment, between the adjustments and the line states, and between two line states",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected after the pool's basis update (a partial refund), after one line's adjustment and cumulative update and before the other's, after the adjustments and before the first line's VOID transition, and between the two lines' VOID transitions (the reversal) rolls the whole effect back (the pool, every line and every adjustment as before); the redelivery then applies it once: one adjustment per changed line and event",
  },
  async (ctx) => {
    const cases: ReadonlyArray<{ readonly label: string; readonly change: "REFUND" | "REVERSAL"; readonly at: string; readonly steps: ReadonlyArray<SqlStep>; readonly completedSteps: ReadonlyArray<string> }> = [
      { label: "after-pool-update", change: "REFUND", at: "db.adjustment_insert.before", steps: [POOL_UPDATE, ADJUSTMENT_INSERT], completedSteps: ["db.pool_update.after"] },
      { label: "between-adjustments", change: "REVERSAL", at: "db.adjustment2_insert.before", steps: [{ ...LINE_UPDATE, label: "line1_update", nth: 1 }, { ...ADJUSTMENT_INSERT, label: "adjustment2_insert", nth: 2 }], completedSteps: ["db.line1_update.after"] },
      { label: "adjustments-then-state", change: "REVERSAL", at: "db.line_state.before", steps: [ADJUSTMENT_INSERT, LINE_STATE], completedSteps: ["db.adjustment_insert.after"] },
      { label: "between-states", change: "REVERSAL", at: "db.line_state2.before", steps: [{ ...LINE_STATE, label: "line_state1", nth: 1 }, { ...LINE_STATE, label: "line_state2", nth: 2 }], completedSteps: ["db.line_state1.after"] },
    ];
    for (const { label, change, at, steps, completedSteps } of cases) {
      const c = await accrued(`cons-par-basis-${label}`, [6_000, 4_000]);
      const event = change === "REFUND" ? await refundEventOf(c, 10_000n) : await reversalEventOf(c.first);
      const before = await basisLedgerOf(c.first);
      assert.equal(before.adjustments, 0);
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial(`the ${change.toLowerCase()} consumer failing ${label}`, at, () => failing(ctx, conn, event, steps));
        for (const point of completedSteps) assert.ok(ctx.points.passed.includes(point), `${label}: ${point} was passed before the failure`);
      } finally {
        await conn.end();
      }
      assert.deepEqual(await basisLedgerOf(c.first), before, `${label}: the pool, every line and every adjustment as before`);
      assert.equal(await runConsumer(event), "APPLIED", `${label}: the redelivery applies the effect`);
      const done = await basisLedgerOf(c.first);
      assert.equal(done.adjustments, 2, `${label}: one adjustment per changed line`);
      assert.deepEqual([...new Set((await adjustmentsOfPurchase(c.first)).map((a) => a[3]))], [event.eventId], `${label}: all of this event`);
      if (change === "REVERSAL") assert.deepEqual([done.pool[0], done.lines.map((l) => [l[0], l[2]])], ["0", [["VOID", "0"], ["VOID", "0"]]], `${label}: the pool at zero basis, both lines VOID`);
      else assert.equal((await ledgerOfPurchase(c.first)).lines.map((l) => BigInt(l.cumulative)).reduce((x, y) => x + y, 0n).toString(), await poolCentsOf(c.first), `${label}: the lines sum to the refunded pool`);
    }
  },
);

faultCell(
  {
    id: "CONS_PAR",
    step: "COMMISSIONS consumer commercial_authorization.delivered.v1 (W2: the completion records) and the ELIGIBILITY pass (the completion's unit, then the line's ELIGIBLE unit): a failure after the STAGE record and before the FINAL record, and after the completion committed and before the line's ELIGIBLE write",
    fault: "partial",
    expect:
      "RACE (partial): a failure after the STAGE completion insert and before the FINAL's rolls the consumer's unit back (no completion); the redelivery records both once. A failure of the ELIGIBILITY pass after its completion unit committed and before the line's ELIGIBLE UPDATE leaves the FINAL completion recorded and the line ACCRUED_PENDING (the line transition is a unit of its own, not half of the completion's: no half-state); the next pass makes it ELIGIBLE once",
  },
  async (ctx) => {
    const kind = (k: string) => (params: ReadonlyArray<unknown>): boolean => params[3] === k;
    const STAGE_INSERT: SqlStep = { label: "stage_insert", match: /INSERT INTO kauro\.purchase_completions/, when: kind("STAGE") };
    const FINAL_INSERT: SqlStep = { label: "final_insert", match: /INSERT INTO kauro\.purchase_completions/, when: kind("FINAL") };
    const completionsOfPurchase = async (p: Purchase): Promise<ReadonlyArray<string>> => (await oracleRows<{ kind: string }>(iw, "SELECT kind FROM kauro.purchase_completions WHERE authorization_id = $1 ORDER BY kind", [p.authorizationId])).map((r) => r.kind);

    // the consumer's unit: STAGE inserted, FINAL not yet
    {
      const c = await accrued("cons-par-completion-unit", [10_000]);
      iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "STAGE", stageRef: "parent-stage", completedAt: new Date(Date.now() - 800 * HOUR_MS).toISOString() as never, source: "STAGED_PREPARATION" });
      iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "FINAL", completedAt: new Date(Date.now() - 721 * HOUR_MS).toISOString() as never, source: "STAGED_PREPARATION" });
      const delivery = await deliveryOf(iw, await deliveredByTheExecutionPackage(iw, c.first.authorizationId, c.agencyId));
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial("the consumer failing after the STAGE record and before the FINAL record", "db.final_insert.before", () => failing(ctx, conn, delivery, [STAGE_INSERT, FINAL_INSERT]));
        assert.ok(ctx.points.passed.includes("db.stage_insert.after"), "the STAGE insert answered before the failure");
      } finally {
        await conn.end();
      }
      assert.deepEqual(await completionsOfPurchase(c.first), [], "no completion remains");
      assert.equal(await runConsumer(delivery), "APPLIED");
      assert.deepEqual(await completionsOfPurchase(c.first), ["FINAL", "STAGE"], "the redelivery recorded both once");
      assert.equal(await runConsumer(delivery), "DUPLICATE");
    }

    // the sweep: the completion's unit committed, the line's ELIGIBLE unit fails
    {
      const c = await accrued("cons-par-completion-line", [10_000]);
      assert.equal(await runConsumer(await fundsReport(c.first, "INSTANT")), "APPLIED");
      iw.completions.record({ agencyId: c.agencyId as never, captureId: c.first.captureId, kind: "FINAL", completedAt: new Date(Date.now() - 721 * HOUR_MS).toISOString() as never, source: "AUTHORIZATION_DELIVERY" });
      const lineId = (await ledgerOfPurchase(c.first)).lines[0]!.lineId;
      const completionInsert: SqlStep = { label: "completion_insert", match: /INSERT INTO kauro\.purchase_completions/, when: (params) => params[2] === c.first.authorizationId };
      const eligibleUpdate: SqlStep = { label: "eligible_update", match: /UPDATE kauro\.commission_lines l SET state = /, when: (params) => params[0] === lineId };
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial("the ELIGIBILITY pass failing after the completion unit committed and before the line's ELIGIBLE write", "db.eligible_update.before", async () => {
          const seen = failures.length;
          const report = await sweepOn(ctx, conn, "ELIGIBILITY", [completionInsert, eligibleUpdate], undefined, { expectFailure: true });
          const failure = failures.slice(seen).find((f) => f.subject === lineId);
          assert.match(itemOf(report, lineId) ?? "", /^FAILED /, "the pass reports the line's unit failed");
          assert.equal(itemOf(report, c.first.authorizationId), "COMPLETIONS 1", "the completion's own unit had committed");
          if (failure === undefined) throw new Error("the pass recorded no failure of the line");
          throw failure.error;
        });
        assert.ok(ctx.points.passed.includes("db.completion_insert.after"), "the completion insert answered before the failure");
      } finally {
        await conn.end();
      }
      assert.deepEqual(await completionsOfPurchase(c.first), ["FINAL"], "the FINAL completion is recorded");
      assert.deepEqual((await ledgerOfPurchase(c.first)).lines.map(stateOf), ["ACCRUED_PENDING"], "and the line is not ELIGIBLE: no half-state");
      assert.equal(itemOf(await runSweepPass("ELIGIBILITY"), lineId), "ELIGIBLE", "the next pass makes it ELIGIBLE");
      assert.deepEqual((await ledgerOfPurchase(c.first)).lines.map(stateOf), ["ELIGIBLE"]);
      assert.equal(itemOf(await runSweepPass("ELIGIBILITY"), lineId), undefined, "and a third pass finds nothing to do");
    }
  },
);

// =====================================================================================================================================
// 35. TERM_ACCRUAL and 34. CONS_REV: the accrual, the basis changes and the entitlement's window against TerminateSeller and the window sweep
// =====================================================================================================================================
// Every writer of an agency's commercial rights takes the agency's commission subject first (D10-GAP-20; the ENTITLEMENT_WINDOWS pass since
// D10-GAP-22), so the second of any two waits for the first, observed, and decides on what the first committed.

const terminateActor = (ctx: FaultContext, sellerId: string, body: Awaited<ReturnType<typeof terminationBody>>, holdAt: string, steps: ReadonlyArray<SqlStep>): Actor => ({
  name: "TerminateSeller",
  login: "kauro_app_test",
  holdAt,
  run: (conn) => iw.faults.on(conn, "kauro_app", ctx.points, steps, () => call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/terminate`, token: iw.owner.token, agency: null, key: freshKey("accrual-term"), body })),
});
const agencyLockOf = (agencyId: string): SqlStep => ({ ...AGENCY_LOCK, when: (params) => params[0] === agencyId });
const entitlementsOf = async (agencyId: string): Promise<ReadonlyArray<readonly [string, string, number]>> =>
  (await oracleRows<{ seller_id: string; state: string; share_bps: number }>(iw, "SELECT seller_id, state, share_bps FROM kauro.commission_entitlements WHERE agency_id = $1 ORDER BY share_bps DESC, seller_id", [agencyId])).map((e) => [e.seller_id, e.state, e.share_bps] as const);
const sellerState = async (sellerId: string): Promise<string> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.sellers WHERE seller_id = $1", [sellerId]))[0]!.state;
type Variant = "UNASSIGNED" | "ASSIGNED";
/** Every CMD050 cell runs the common case (CONVERTED claims, a live entitlement, NO current assignment: only the entitlement names the agency to lock, D10-GAP-22) and the assigned one. */
const variantsOf = <T extends string>(orders: ReadonlyArray<T>): ReadonlyArray<readonly [Variant, T]> => (["UNASSIGNED", "ASSIGNED"] as const).flatMap((v) => orders.map((o) => [v, o] as const));
/** The claimant holds the agency's OPERATIONAL ASSIGNMENT (the account link CMD050 appends, SELLER_TERMINATED, is a foreign key on the agency: the lock-order family of D10-GAP-20). */
async function holdsAssignment(c: Converting, variant: Variant): Promise<void> {
  if (variant === "UNASSIGNED") {
    const current = await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.sales_accounts s WHERE s.agency_id = $1 AND s.current_assignment_id IS NOT NULL", [c.agencyId]);
    assert.deepEqual([current[0]!.n, (await entitlementsOf(c.agencyId)).map((e) => e[1]), (await rightsOf(c)).claims], [0, ["ACTIVE"], ["CONVERTED"]], "the claimant has no assignment on the agency: CONVERTED claim, a live entitlement");
    return;
  }
  iw.buyers.set(c.agencyId as never, "AGENCY");
  const sellerId = c.att.sellers[0]!.sellerId;
  const assigned = await assignedThrough(iw, c.agencyId, { expectedVersion: 0, sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as never, agencyId: c.agencyId as never, sellerId }) });
  assert.equal(assigned.sellerId, sellerId, "the claimant holds the agency's operational assignment");
}
const assignmentEnded = async (agencyId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.account_assignments WHERE agency_id = $1 AND reason = 'SELLER_TERMINATED'", [agencyId]))[0]!.n;

/** The first purchase accrued, a second purchase captured and not yet delivered, the seller's termination prepared. */
async function secondToAccrue(label: string, variant: Variant): Promise<{ readonly c: Converting; readonly second: Purchase; readonly delivery: Delivery; readonly sellerId: string; readonly body: Awaited<ReturnType<typeof terminationBody>> }> {
  const c = await accrued(label, [10_000]);
  await holdsAssignment(c, variant);
  const second = await purchase(iw, c.s, `${label}-second`);
  const sellerId = c.att.sellers[0]!.sellerId;
  return { c, second, delivery: await deliveryOfCapture(second), sellerId, body: await terminationBody(iw, sellerId, []) };
}

/** What a second purchase accrued for a terminated seller leaves: one REPEAT pool, one line at the seller's whole share, the entitlement TERMINATED_WITH_RESIDUAL. */
async function assertResidualAccrued(what: string, f: { readonly c: Converting; readonly second: Purchase; readonly sellerId: string }, variant: Variant): Promise<void> {
  assert.deepEqual(await poolKinds(f.second), ["ACQUISITION REPEAT 400"], `${what}: one pool at the repeat rate`);
  const ledger = await ledgerOfPurchase(f.second);
  assert.deepEqual(ledger.lines.map((l) => [l.state, l.cumulative]), [["ACCRUED_PENDING", await poolCentsOf(f.second)]], `${what}: one line at the seller's whole share of the pool`);
  assert.deepEqual(await entitlementsOf(f.c.agencyId), [[f.sellerId, "TERMINATED_WITH_RESIDUAL", 10_000]], `${what}: the entitlement keeps its share, TERMINATED_WITH_RESIDUAL`);
  assert.equal(await sellerState(f.sellerId), "TERMINATED", `${what}: the seller is TERMINATED`);
  assert.equal(await assignmentEnded(f.c.agencyId), variant === "ASSIGNED" ? 1 : 0, `${what}: the operational assignment ended (only an assigned claimant had one)`);
  assert.equal((await linesOf(iw, f.c.first.authorizationId)).length, 1, `${what}: the first purchase's line is untouched`);
}

faultCell(
  {
    id: "TERM_ACCRUAL",
    step: "COMMISSIONS consumer capture.completed.v1 (the second purchase's pool and line, its transaction paused before COMMIT) and TerminateSeller (CMD050, paused before COMMIT) of the seller who holds the entitlement",
    fault: "race",
    expect:
      "RACE: the accrual of a second purchase racing the seller's termination, in both orders, for a claimant with CONVERTED claims and a live entitlement and no assignment on the agency and for one holding its operational assignment, with the lock wait observed: one pool and one line at the seller's whole share (the repeat rate, inside the window nothing lost), the entitlement TERMINATED_WITH_RESIDUAL, the seller TERMINATED, the termination answering 200 and the consumer APPLIED whichever committed first",
  },
  async (ctx) => {
    for (const [variant, order] of variantsOf(["CONSUMER_FIRST", "TERMINATION_FIRST"] as const)) {
      const what = `accrual and termination, ${variant}, ${order}`;
      const f = await secondToAccrue(`term-accrual-${variant === "ASSIGNED" ? "a" : "u"}-${order === "CONSUMER_FIRST" ? "c" : "t"}`, variant);
      const consumer = consumerOf(ctx, f.delivery, "the accruing consumer", "uow.before-commit", []);
      const terminate = terminateActor(ctx, f.sellerId, f.body, "uow.before-commit", []);
      const out = order === "CONSUMER_FIRST" ? await contend(ctx, consumer, terminate, what) : await contend(ctx, terminate, consumer, what);
      completed<SellerTerminationView>(mustHaveSettled(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the termination") as Reply, 200);
      assert.equal(mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer"), "APPLIED", `${what}: the consumer accrued`);
      await assertResidualAccrued(what, f, variant);
    }
  },
);

faultCell(
  {
    id: "CONS_REV",
    step: "COMMISSIONS consumer capture.completed.v1 (stopped right after the agency's commission subject) and TerminateSeller (stopped right after the same subject): the seller terminated between the delivery and the accrual",
    fault: "race",
    expect:
      "RACE: the seller's termination landing between a capture.completed.v1 and its accrual, at the intermediate lock point after the agency's commission subject, in both orders, for a claimant with CONVERTED claims and a live entitlement and no assignment on the agency and for one holding its operational assignment, with the lock wait observed: the accrual reads the entitlement as the first committed it (ACTIVE when it went first, TERMINATED_WITH_RESIDUAL when the termination did) and in both orders accrues one line at the seller's whole share: a termination alone does not forfeit earned rights",
  },
  async (ctx) => {
    for (const [variant, order] of variantsOf(["CONSUMER_FIRST", "TERMINATION_FIRST"] as const)) {
      const what = `termination between the delivery and the accrual, ${variant}, ${order}`;
      const f = await secondToAccrue(`cons-rev-term-${variant === "ASSIGNED" ? "a" : "u"}-${order === "CONSUMER_FIRST" ? "c" : "t"}`, variant);
      const steps = [agencyLockOf(f.c.agencyId)];
      const consumer = consumerOf(ctx, f.delivery, "the accruing consumer", "db.agency_lock.after", steps);
      const terminate = terminateActor(ctx, f.sellerId, f.body, "db.agency_lock.after", steps);
      const during = async (): Promise<void> => {
        assert.deepEqual((await entitlementsOf(f.c.agencyId)).map((e) => e[1]), ["ACTIVE"], `${what}: nothing of the other committed while it waited`);
      };
      const out = order === "CONSUMER_FIRST" ? await contend(ctx, consumer, terminate, what, during) : await contend(ctx, terminate, consumer, what, during);
      completed<SellerTerminationView>(mustHaveSettled(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the termination") as Reply, 200);
      assert.equal(mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer"), "APPLIED", `${what}: the consumer accrued`);
      await assertResidualAccrued(what, f, variant);
    }
  },
);

faultCell(
  {
    id: "CONS_REV",
    step: "COMMISSIONS consumer capture.reversed.v1 (the adjustment, its transaction paused right after the adjustment insert) and TerminateSeller (stopped right after the agency's commission subject): the seller terminated mid-way through a basis change",
    fault: "race",
    expect:
      "RACE: a reversal applied while the seller of its lines is terminated, in both orders, for a claimant with CONVERTED claims and a live entitlement and no assignment on the agency and for one holding its operational assignment, with the lock wait observed: the adjustments are made whichever committed first (one per line and event, the lines VOID at zero, the pool at zero), the entitlement TERMINATED_WITH_RESIDUAL, the seller TERMINATED, the termination answering 200",
  },
  async (ctx) => {
    for (const [variant, order] of variantsOf(["CONSUMER_FIRST", "TERMINATION_FIRST"] as const)) {
      const what = `reversal and termination, ${variant}, ${order}`;
      const c = await accrued(`cons-rev-reversal-term-${variant === "ASSIGNED" ? "a" : "u"}-${order === "CONSUMER_FIRST" ? "c" : "t"}`, [10_000]);
      await holdsAssignment(c, variant);
      const sellerId = c.att.sellers[0]!.sellerId;
      const reversal = await reversalEventOf(c.first);
      const body = await terminationBody(iw, sellerId, []);
      const consumer = consumerOf(ctx, reversal, "the reversal consumer", "db.adjustment_insert.after", [ADJUSTMENT_INSERT]);
      const terminate = terminateActor(ctx, sellerId, body, "db.agency_lock.after", [agencyLockOf(c.agencyId)]);
      const out = order === "CONSUMER_FIRST" ? await contend(ctx, consumer, terminate, what) : await contend(ctx, terminate, consumer, what);
      completed<SellerTerminationView>(mustHaveSettled(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the termination") as Reply, 200);
      assert.equal(mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer"), "APPLIED", `${what}: the consumer applied the reversal`);
      const ledger = await ledgerOfPurchase(c.first);
      assert.deepEqual(ledger.lines.map((l) => [l.state, l.cumulative]), [["VOID", "0"]], `${what}: the line VOID at zero`);
      assert.deepEqual((await adjustmentsOfPurchase(c.first)).map((a) => [a[0], a[2], a[3]]), [["DECREASE", "0", reversal.eventId]], `${what}: the reversal's one adjustment`);
      assert.equal(await poolCentsOf(c.first), "0");
      assert.deepEqual(await entitlementsOf(c.agencyId), [[sellerId, "TERMINATED_WITH_RESIDUAL", 10_000]], `${what}: the entitlement kept`);
      assert.equal(await sellerState(sellerId), "TERMINATED");
      assert.equal(await assignmentEnded(c.agencyId), variant === "ASSIGNED" ? 1 : 0, `${what}: the operational assignment ended (only an assigned claimant had one)`);
    }
  },
);

// --- the window sweep: fixed instants (R2-138), run last because a pass standing after the window expires every window that ended ---------

/** The agency's window: first confirmed 2027-09-12T14:00Z, so it ends 2028-09-12T14:00:00Z at America/Bogota wall time (R2-138's). */
const WINDOW_END = "2028-09-12T14:00:00Z";
const AFTER_WINDOW = "2028-09-13T15:00:00Z";
/** An agency whose single claimant's claim was accepted 2027-09-01 and whose first purchase (confirmed 2027-09-12) is accrued: ACTIVE entitlement ending at WINDOW_END. */
async function windowed(label: string): Promise<Converting> {
  const s = await sellingAgency(iw, label);
  const att = await claimsOn(iw, label, 1);
  const allocationId = await acceptAttribution(iw, s.agency.agencyId, att, [10_000], "2027-09-01T12:00:00Z");
  const first = await purchase(iw, s, `${label}-first`, { confirmedAt: "2027-09-12T14:00:00Z", providerCompletedAt: "2027-09-12T13:55:00Z" });
  const c = { s, att, allocationId, agencyId: s.agency.agencyId, first, delivery: await deliveryOfCapture(first) };
  assert.equal(await runConsumer(c.delivery), "APPLIED", `${label}: the first purchase converts and accrues`);
  const [window] = await oracleRows<{ ends: string }>(iw, "SELECT to_char(window_ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS ends FROM kauro.commission_entitlements WHERE agency_id = $1", [c.agencyId]);
  assert.equal(window!.ends, WINDOW_END, `${label}: the window ends at twelve calendar months`);
  return c;
}
/** A pass of ENTITLEMENT_WINDOWS or an accrual standing after the window: every unit of the commission service on the TEST CLOCK at that instant. */
async function standingAfterWindow<T>(work: () => Promise<T>): Promise<T> {
  iw.standAt(AFTER_WINDOW);
  try {
    return await work();
  } finally {
    iw.standAt(null);
  }
}
const windowSweepActor = (ctx: FaultContext, agencyId: string, holdAt: string): Actor => ({ name: "the ENTITLEMENT_WINDOWS pass", login: "kauro_commission_test", holdAt, run: (conn) => sweepOn(ctx, conn, "ENTITLEMENT_WINDOWS", [agencyLockOf(agencyId)]) });

faultCell(
  {
    id: "CONS_REV",
    step: "Sweep ENTITLEMENT_WINDOWS (stopped right after the agency's commission subject, standing after the window) and the COMMISSIONS consumer's accrual of a purchase the provider completed one second before, and exactly at, the window's end (stopped before COMMIT)",
    fault: "race",
    expect:
      "RACE: the window sweep expiring an entitlement at the instant of a capture.completed.v1 for a purchase completed at the provider one second before the window's end, in both orders with the lock wait observed: the line is accrued by the provider-completion instant, never by the processing instant or the entitlement's state (one REPEAT pool at 400 bps, one line, the entitlement EXPIRED); a purchase completed exactly at the end accrues no acquisition line",
  },
  async (ctx) => {
    for (const completedAt of ["BEFORE_END", "AT_END"] as const) {
      for (const order of ["CONSUMER_FIRST", "SWEEP_FIRST"] as const) {
        const what = `purchase completed ${completedAt === "BEFORE_END" ? "one second before" : "exactly at"} the window's end, ${order}`;
        const c = await windowed(`cons-rev-window-${completedAt === "BEFORE_END" ? "b" : "e"}-${order === "CONSUMER_FIRST" ? "c" : "s"}`);
        const late = await purchase(iw, c.s, `cons-rev-window-late-${completedAt}-${order}`, completedAt === "BEFORE_END" ? { providerCompletedAt: "2028-09-12T13:59:59Z", confirmedAt: "2028-09-13T13:59:59Z" } : { providerCompletedAt: WINDOW_END, confirmedAt: "2028-09-13T14:00:00Z" });
        const delivery = await deliveryOfCapture(late);
        const consumer = consumerOf(ctx, delivery, "the accruing consumer", "uow.before-commit", []);
        const sweep = windowSweepActor(ctx, c.agencyId, "db.agency_lock.after");
        const out = await standingAfterWindow(() => (order === "CONSUMER_FIRST" ? contend(ctx, consumer, sweep, what) : contend(ctx, sweep, consumer, what)));
        const sweepReport = swept(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the window sweep");
        const entitlementId = (await oracleRows<{ entitlement_id: string }>(iw, "SELECT entitlement_id FROM kauro.commission_entitlements WHERE agency_id = $1", [c.agencyId]))[0]!.entitlement_id;
        assert.equal(itemOf(sweepReport, entitlementId), "EXPIRED", `${what}: the pass expired the entitlement`);
        assert.equal(mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer"), completedAt === "BEFORE_END" ? "APPLIED" : "NOT_APPLICABLE", `${what}: the consumer`);
        assert.deepEqual((await entitlementsOf(c.agencyId)).map((e) => e[1]), ["EXPIRED"], `${what}: EXPIRED`);
        if (completedAt === "BEFORE_END") {
          assert.deepEqual(await poolKinds(late), ["ACQUISITION REPEAT 400"], `${what}: accrued at the repeat rate by the provider-completion instant`);
          assert.equal((await linesOf(iw, late.authorizationId)).length, 1, `${what}: one line`);
        } else {
          assert.deepEqual([(await poolsOf(iw, late.authorizationId)).length, (await linesOf(iw, late.authorizationId)).length], [0, 0], `${what}: no acquisition line`);
        }
        assert.equal((await linesOf(iw, c.first.authorizationId)).length, 1, `${what}: the earned line of the first purchase is unaffected`);
      }
    }
  },
);

faultCell(
  {
    id: "CONS_REV",
    step: "Sweep ENTITLEMENT_WINDOWS (stopped right after the agency's commission subject, standing after the window) and the COMMISSIONS consumer's reversal (stopped right after its adjustment insert): the entitlement expired mid-way through a basis change",
    fault: "race",
    expect:
      "RACE: a reversal applied while the entitlement of its lines expires, in both orders with the lock wait observed: the adjustment is made whichever committed first (one per line and event, the line VOID at zero, the pool at zero) and the entitlement is EXPIRED: an expired entitlement still has its lines adjusted",
  },
  async (ctx) => {
    for (const order of ["CONSUMER_FIRST", "SWEEP_FIRST"] as const) {
      const what = `reversal and window expiry, ${order}`;
      const c = await windowed(`cons-rev-window-reversal-${order === "CONSUMER_FIRST" ? "c" : "s"}`);
      const reversal = await reversalEventOf(c.first);
      const consumer = consumerOf(ctx, reversal, "the reversal consumer", "db.adjustment_insert.after", [ADJUSTMENT_INSERT]);
      const sweep = windowSweepActor(ctx, c.agencyId, "db.agency_lock.after");
      const out = await standingAfterWindow(() => (order === "CONSUMER_FIRST" ? contend(ctx, consumer, sweep, what) : contend(ctx, sweep, consumer, what)));
      swept(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the window sweep");
      assert.equal(mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer"), "APPLIED", `${what}: the consumer applied the reversal`);
      const ledger = await ledgerOfPurchase(c.first);
      assert.deepEqual(ledger.lines.map((l) => [l.state, l.cumulative]), [["VOID", "0"]], `${what}: the line VOID at zero`);
      assert.deepEqual((await adjustmentsOfPurchase(c.first)).map((a) => [a[0], a[2], a[3]]), [["DECREASE", "0", reversal.eventId]], `${what}: the reversal's one adjustment`);
      assert.deepEqual((await entitlementsOf(c.agencyId)).map((e) => e[1]), ["EXPIRED"], `${what}: the entitlement EXPIRED`);
    }
  },
);

faultCell(
  {
    id: "TERM_ACCRUAL",
    step: "Sweep ENTITLEMENT_WINDOWS (stopped right after the agency's commission subject, standing after the window) and TerminateSeller (stopped right after the same subject) of the entitlement's seller",
    fault: "race",
    expect:
      "RACE: an entitlement reaching its window's end while its seller is terminated, in both orders, for a claimant with CONVERTED claims and a live entitlement and no assignment on the agency and for one holding its operational assignment, with the lock wait observed: no unit fails (the termination answers 200, the pass reports no failed item), the seller is TERMINATED and the entitlement ends EXPIRED whichever committed first (TERMINATED_WITH_RESIDUAL then EXPIRED, or EXPIRED left as it is by the termination); its earned line is untouched",
  },
  async (ctx) => {
    for (const [variant, order] of variantsOf(["TERMINATION_FIRST", "SWEEP_FIRST"] as const)) {
      const what = `window end and termination, ${variant}, ${order}`;
      const c = await windowed(`term-window-${variant === "ASSIGNED" ? "a" : "u"}-${order === "TERMINATION_FIRST" ? "t" : "s"}`);
      await holdsAssignment(c, variant);
      const sellerId = c.att.sellers[0]!.sellerId;
      const body = await terminationBody(iw, sellerId, []);
      const terminate = terminateActor(ctx, sellerId, body, "db.agency_lock.after", [agencyLockOf(c.agencyId)]);
      const sweep = windowSweepActor(ctx, c.agencyId, "db.agency_lock.after");
      const out = await standingAfterWindow(() => (order === "TERMINATION_FIRST" ? contend(ctx, terminate, sweep, what) : contend(ctx, sweep, terminate, what)));
      const view = completed<SellerTerminationView>(mustHaveSettled(order === "TERMINATION_FIRST" ? out.holder : out.waiter, "the termination") as Reply, 200).data;
      const sweepReport = swept(order === "TERMINATION_FIRST" ? out.waiter : out.holder, "the window sweep");
      const entitlementId = (await oracleRows<{ entitlement_id: string }>(iw, "SELECT entitlement_id FROM kauro.commission_entitlements WHERE agency_id = $1", [c.agencyId]))[0]!.entitlement_id;
      assert.equal(itemOf(sweepReport, entitlementId), "EXPIRED", `${what}: the pass expired the entitlement`);
      assert.equal(view.entitlementsResidual, order === "TERMINATION_FIRST" ? 1 : 0, `${what}: the termination ${order === "TERMINATION_FIRST" ? "made it TERMINATED_WITH_RESIDUAL first" : "found it already EXPIRED and left it"}`);
      assert.deepEqual(await entitlementsOf(c.agencyId), [[sellerId, "EXPIRED", 10_000]], `${what}: EXPIRED at its share`);
      assert.equal(await sellerState(sellerId), "TERMINATED");
      assert.equal(await assignmentEnded(c.agencyId), variant === "ASSIGNED" ? 1 : 0, `${what}: the operational assignment ended (only an assigned claimant had one)`);
      assert.equal((await linesOf(iw, c.first.authorizationId)).length, 1, `${what}: the earned line is untouched`);
    }
  },
);

