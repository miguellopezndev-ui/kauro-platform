// The tier-1 GAPs 29 to 36 of the B10 failure matrix on the COMMISSIONS consumers, the funds effect, the ELIGIBILITY sweep and the accrual
// (docs/design/B10-failure-matrix.md "GAP list, by risk" -> "Tier 1"; items FUNDS_PAR, FUNDS_RETRY, ELIG_REV, CONS_DUP_LINE, ACCRUAL_REC_RACE,
// CONS_REV, TERM_ACCRUAL, CONS_PAR), each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). Every unit under test is the
// commission service's REAL unit of work (the COMMISSIONS consumer, a sweep item, CMD050) routed over a connection the harness opened; the
// statements of an effect are the cell's steps (test/fault-support.ts), and every sweep pass and consumer delivery goes through the helpers of
// b10-cells-support.ts, which assert that nothing failed behind the background sink before any recovery run. PostgreSQL 17 through the runtime
// login roles; the superuser only reads. Nothing sleeps.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { crashedAt, faultCell, type FaultContext } from "@kauro/persistence/testing";
import { agentOf, integrationWorld, oracleRows, providerReports, type IntegrationWorld } from "./integration-support.js";
import { accepted, bindCells, consumeOn, contend, failures, observeBlocked, convertedFor, converting, deliveryOfCapture, itemOf, mustHaveSettled, open, rightsOf, runConsumer, runSweepPass, settled, sweepOn, type Actor, type Converting, type Delivery } from "./b10-cells-support.js";
import { approvedRefund, deliveredByTheExecutionPackage, deliveryOf, linesOf, poolsOf, purchase, type Purchase } from "./commission-support.js";
import type { ExecuteRefundView, WebhookAck } from "@kauro/application";
import type { SweepReport } from "../src/commissions/sweeps.js";
import { completed } from "./support.js";
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
void agentOf;
void accepted;
void deliveryOfCapture;
void crashedAt;
void mustHaveSettled;

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

// --- the ledger of a purchase, read by the superuser ----------------------------------------------------------------------------------

interface LineView {
  readonly lineId: string;
  readonly state: string;
  readonly version: number;
  readonly cumulative: string;
  readonly holds: ReadonlyArray<readonly [string, string, string]>;
}
interface LedgerView {
  readonly facts: ReadonlyArray<readonly [number, string]>;
  readonly lines: ReadonlyArray<LineView>;
}
/** What the funds effect writes for a purchase: the funds facts of its capture, each line with its state, version, cumulative and holds (reason, state, cents). */
async function ledgerOfPurchase(p: Purchase): Promise<LedgerView> {
  const facts = await oracleRows<{ capture_version: number; funds_state: string }>(iw, "SELECT capture_version, funds_state FROM kauro.capture_funds_observations WHERE capture_id = $1 ORDER BY capture_version", [p.captureId]);
  const lines = await oracleRows<{ line_id: string; state: string; version: string; cumulative: string }>(
    iw,
    "SELECT line_id, state, version::text, cumulative_entitlement_cents::text AS cumulative FROM kauro.commission_lines WHERE authorization_id = $1 ORDER BY seller_id, line_id",
    [p.authorizationId],
  );
  const out: LineView[] = [];
  for (const l of lines) {
    const holds = await oracleRows<{ reason: string; state: string; amount_cents: string }>(iw, "SELECT reason, state, amount_cents::text FROM kauro.commission_holds WHERE line_id = $1 ORDER BY opened_at, hold_id", [l.line_id]);
    out.push({ lineId: l.line_id, state: l.state, version: Number(l.version), cumulative: l.cumulative, holds: holds.map((h) => [h.reason, h.state, h.amount_cents] as const) });
  }
  return { facts: facts.map((f) => [Number(f.capture_version), f.funds_state] as const), lines: out };
}
const stateOf = (l: LineView): string => l.state;

/** Every capture event of a type, oldest version first, as the dispatcher would hand them to COMMISSIONS. */
async function eventsOf(captureId: string, eventType: string): Promise<Delivery[]> {
  const rows = await oracleRows<{ event_id: string }>(iw, "SELECT event_id FROM kauro.domain_events WHERE event_type = $2 AND (aggregate_id = $1::uuid OR payload->>'captureId' = $1::text) ORDER BY aggregate_version, created_at", [captureId, eventType]);
  return Promise.all(rows.map((r) => deliveryOf(iw, r.event_id)));
}
/** The provider changes the capture's disbursement and the payment service applies it (CMD034): the one new capture.funds_observed.v1, not delivered to COMMISSIONS. */
async function fundsReport(p: Purchase, disbursement: "INSTANT" | "DELAYED"): Promise<Delivery> {
  const before = (await eventsOf(p.captureId, "capture.funds_observed.v1")).length;
  await providerReports(iw, p, { disbursement });
  const events = await eventsOf(p.captureId, "capture.funds_observed.v1");
  assert.equal(events.length, before + 1, "the provider's change published one funds observation");
  const latest = events[events.length - 1]!;
  assert.equal(latest.payload["fundsState"], disbursement === "INSTANT" ? "AVAILABLE" : "HELD");
  return latest;
}

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
    step: "ACCRUAL_RECONCILIATION (the pool and lines of a late purchase, its unit paused right after its pool insert) and the COMMISSIONS consumer's accrual of the same purchase (paused right after its pool insert)",
    fault: "race",
    expect:
      "RACE: the sweep's accrual unit and the consumer accruing the same second purchase of an agency, in both orders with the lock wait observed (the first stopped with its pool inserted and uncommitted, the second waiting on the agency's commission subject): one pool and one line per beneficiary at the repeat rate, the second unit finding it made (NOTHING_TO_ACCRUE, DUPLICATE); with the purchase's refund already completed at the provider the sweep's current basis and the consumer's allocated basis end, once the refund event is delivered, at the same cumulative entitlements",
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

void sweepOn;
void contend;
void poolsOf;
void linesOf;
void deliveryOf;
void ({} as FaultContext);
void ({} as Actor);
