// What the B10 failure-cell files share (docs/design/B10-failure-matrix.md; lane 4 B10G4-R2, lane 5): the one way a cell delivers an event to the
// COMMISSIONS consumer or runs a sweep pass (the outcome is asserted in the helper, so no call site can forget it), the way a cell routes a
// unit over a connection of the common fault harness, and the two-actor race (`contend`: the holder stops with its locks taken, the waiter is
// observed waiting on it in pg_stat_activity, both settle, and nothing of the raced pair failed behind the sink). A test file binds its world
// once with `bindCells(iw)` in `before`; every file runs in a process of its own, so the binding is the file's.
import assert from "node:assert/strict";
import { connectionPid, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import { createCommissionService, type CommissionService } from "../src/index.js";
import type { CommissionSweepName, SweepReport } from "../src/commissions/sweeps.js";
import { providerReports, type IntegrationWorld } from "./integration-support.js";
import { acceptAttribution, claimsOn, deliveryOf, eventOf, linesOf, oracleRows, poolsOf, purchase, sellingAgency, type Attribution, type Purchase, type Selling } from "./commission-support.js";
import type { SqlStep } from "./fault-support.js";
import { ids } from "./support.js";

export type Login = "kauro_app_test" | "kauro_commission_test";
export type Delivery = Awaited<ReturnType<typeof deliveryOf>>;

let world: IntegrationWorld | null = null;
let rawSvc: CommissionService | null = null;
/** The failures the commission service handed to its background sink (a sweep item's failure), by subject. */
export const failures: Array<{ readonly subject: string; readonly error: unknown }> = [];

/** Binds the file's world and builds the commission service whose units are the fault-routed ones: real outside `faults.on`, the cell's connection inside it. */
export function bindCells(iw: IntegrationWorld): void {
  world = iw;
  rawSvc = createCommissionService({ assembly: { units: iw.faults.wrap(iw.pools.units), completions: iw.completions }, environment: "LOCAL", clock: iw.clock, ids, onBackgroundFailure: (subject, error) => void failures.push({ subject, error }) });
}
function iwOf(): IntegrationWorld {
  if (world === null) throw new Error("bindCells(iw) was not called");
  return world;
}
function svcOf(): CommissionService {
  if (rawSvc === null) throw new Error("bindCells(iw) was not called");
  return rawSvc;
}

export const open = (login: Login): Promise<HarnessConnection> => openConnection(iwOf().h.pg.clientConfig(login));

/** The consumer's delivery on `conn` (the unit routed over it), the service's units standing at `at` on the TEST CLOCK when given. */
export function consumeOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, delivery: Delivery, steps: ReadonlyArray<SqlStep> = [], at?: string): Promise<string> {
  const iw = iwOf();
  if (at !== undefined) iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => runConsumer(delivery)).finally(() => (at !== undefined ? iw.standAt(null) : undefined));
}
/** One pass of a sweep on `conn`. */
export function sweepOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, sweep: CommissionSweepName, steps: ReadonlyArray<SqlStep> = [], at?: string, expecting: Expecting = {}): Promise<SweepReport> {
  const iw = iwOf();
  if (at !== undefined) iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => runSweepPass(sweep, expecting)).finally(() => (at !== undefined ? iw.standAt(null) : undefined));
}
/**
 * THE way a cell runs a sweep pass or delivers an event to the consumer (the service itself is touched nowhere else): the outcome
 * is asserted here, so no call site can forget it. A sweep catches the error of an item, hands it to the background sink and resolves a
 * report with a FAILED entry, so a settled promise proves nothing: a FAILED item or a new entry of the sink fails the call, unless the cell
 * names the variant that expects the failure (`expectFailure`: its fault is the point of the cell, and it asserts the failure itself).
 */
export interface Expecting {
  readonly expectFailure?: true;
}
export async function runSweepPass(sweep: CommissionSweepName, expecting: Expecting = {}): Promise<SweepReport> {
  const seen = failures.length;
  const report = await svcOf().runSweep(sweep);
  if (expecting.expectFailure !== true) {
    assert.deepEqual(report.items.filter((i) => i.outcome.startsWith("FAILED")), [], `the ${sweep} pass reports a failed item`);
    assert.deepEqual(failures.slice(seen).map((f) => `${f.subject}: ${f.error instanceof Error ? f.error.message : String(f.error)}`), [], `the ${sweep} pass handed a failure to the background sink`);
  }
  return report;
}
export async function runConsumer(delivery: Delivery, expecting: Expecting = {}): Promise<string> {
  const seen = failures.length;
  const outcome = await svcOf().consumer.handle(delivery as never);
  if (expecting.expectFailure !== true) assert.deepEqual(failures.slice(seen).map((f) => String(f.subject)), [], "the consumer handed a failure to the background sink");
  return outcome;
}
export const itemOf = (report: { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> }, subject: string): string | undefined => report.items.find((i) => i.subject === subject)?.outcome;
/** The last failure the commission service reported for the subject. */
export const failureOf = (subject: string): unknown => [...failures].reverse().find((f) => f.subject === subject)?.error;
/** The settlement of an operation the cell expects to fail: its error, or the answer it got. */
export const settled = <T>(p: Promise<T>): Promise<{ readonly answer: T } | { readonly failure: unknown }> => p.then((answer) => ({ answer }), (failure: unknown) => ({ failure }));

// --- two actors contending for the same rows ------------------------------------------------------------------------------------

export interface Actor {
  readonly name: string;
  readonly login: Login;
  /** The point the holder stops at with its locks taken. */
  readonly holdAt: string;
  run(conn: HarnessConnection): Promise<unknown>;
}
/** Runs `holder` and `waiter` in that order over fresh connections: the waiter is observed waiting on the holder (`during` runs then, the holder still holding), then both settle. */
export async function contend(ctx: FaultContext, holder: Actor, waiter: Actor, what: string, during?: () => Promise<void>): Promise<{ readonly holder: PromiseSettledResult<unknown>; readonly waiter: PromiseSettledResult<unknown> }> {
  const iw = iwOf();
  const holderConn = await open(holder.login);
  const waiterConn = await open(waiter.login);
  const seen = failures.length;
  try {
    const pause = ctx.points.pause(holder.holdAt);
    const holding = ctx.operation(`${holder.name} (holder)`, () => settled(holder.run(holderConn)));
    await pause.reachedBy(holding).catch(async (e: unknown) => {
      const outcome = await holding;
      throw new Error(`${holder.name} did not reach ${holder.holdAt} (${what}): ${"failure" in outcome ? (outcome.failure instanceof Error ? outcome.failure.message + " / " + String((outcome.failure as { cause?: unknown }).cause) : String(outcome.failure)) : "it completed: " + JSON.stringify((outcome.answer as { status?: number; text?: string } | undefined)?.text ?? outcome.answer).slice(0, 600)}`, { cause: e });
    });
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: waiterConn, holder: connectionPid(holderConn) }, (conn) => waiter.run(conn), `${waiter.name} while ${holder.name} holds the rows (${what})`);
    // the cell's own observations of the state the holder and the observed waiter leave behind, before the holder lets go
    if (during !== undefined) await during();
    pause.release();
    const held = await holding;
    const waited = await waiting.pending;
    // before any recovery: no unit of the raced pair failed, whether it threw or only reported it to the sink
    assert.deepEqual(failures.slice(seen).map((f) => `${f.subject}: ${f.error instanceof Error ? f.error.message : String(f.error)}`), [], `${what}: a raced unit failed and reported it to the background sink`);
    return { holder: "failure" in held ? { status: "rejected", reason: held.failure } : { status: "fulfilled", value: held.answer }, waiter: waited };
  } finally {
    await holderConn.end();
    await waiterConn.end();
  }
}
/**
 * What a raced actor answered, refusing a failure it only reports: a sweep catches the error of an item, hands it to the background sink and
 * resolves a report with a FAILED entry (sweeps.ts item), so a settled promise is no proof; a report with a FAILED item fails here.
 */
export const mustHaveSettled = (r: PromiseSettledResult<unknown>, what: string): unknown => {
  if (r.status === "rejected") throw new Error(`${what} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, { cause: r.reason });
  const items = (r.value as { readonly items?: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> } | null)?.items;
  const failed = items?.filter((i) => i.outcome.startsWith("FAILED")) ?? [];
  assert.deepEqual(failed, [], `${what} reports a failed item`);
  return r.value;
};

// --- an agency whose claims are ACCEPTED, its first purchase and what the conversion leaves ---------------------------------------

/** An agency whose seller(s)' claims are ACCEPTED under one frozen allocation (the shares in bps), before the agency's first purchase. */
export async function accepted(label: string, shares: ReadonlyArray<number>): Promise<{ readonly s: Selling; readonly att: Attribution; readonly allocationId: string; readonly agencyId: string }> {
  const s = await sellingAgency(iwOf(), label);
  const att = await claimsOn(iwOf(), label, shares.length);
  const allocationId = await acceptAttribution(iwOf(), s.agency.agencyId, att, shares);
  return { s, att, allocationId, agencyId: s.agency.agencyId };
}
export const deliveryOfCapture = async (p: Purchase): Promise<Delivery> => deliveryOf(iwOf(), await eventOf(iwOf(), p.captureId, "capture.completed.v1"));

export interface Converting {
  readonly s: Selling;
  readonly att: Attribution;
  readonly allocationId: string;
  readonly agencyId: string;
  readonly first: Purchase;
  readonly delivery: Delivery;
}
/** Claims accepted, then the agency's first purchase confirmed: the capture's delivery waits for COMMISSIONS (nothing is dispatched). */
export async function converting(label: string, shares: ReadonlyArray<number>): Promise<Converting> {
  const a = await accepted(label, shares);
  const first = await purchase(iwOf(), a.s, label);
  return { ...a, first, delivery: await deliveryOfCapture(first) };
}

export interface Rights {
  readonly claims: ReadonlyArray<string>;
  readonly entitlements: ReadonlyArray<readonly [string, string, number]>;
  readonly pools: number;
  readonly lines: number;
}
/** The rights the conversion creates or leaves: each claim's state, each beneficiary's entitlement (largest share first), the purchase's pools and lines. */
export async function rightsOf(c: { readonly att: Attribution; readonly agencyId: string; readonly first: Purchase }): Promise<Rights> {
  const claims = await oracleRows<{ claim_id: string; state: string }>(iwOf(), "SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [c.att.claimIds]);
  const entitlements = await oracleRows<{ seller_id: string; state: string; share_bps: number }>(iwOf(), "SELECT seller_id, state, share_bps FROM kauro.commission_entitlements WHERE agency_id = $1 ORDER BY share_bps DESC, seller_id", [c.agencyId]);
  return {
    claims: c.att.claimIds.map((id) => claims.find((x) => x.claim_id === id)!.state),
    entitlements: entitlements.map((e) => [e.seller_id, e.state, e.share_bps] as const),
    pools: (await poolsOf(iwOf(), c.first.authorizationId)).length,
    lines: (await linesOf(iwOf(), c.first.authorizationId)).length,
  };
}
export const nothingFor = (c: { readonly att: Attribution }): Rights => ({ claims: c.att.claimIds.map(() => "ACCEPTED"), entitlements: [], pools: 0, lines: 0 });

/** What one converted purchase leaves: every claim CONVERTED, one ACTIVE entitlement per beneficiary at its share, one acquisition pool and one line per beneficiary. */
export function convertedFor(c: { readonly att: Attribution }, shares: ReadonlyArray<number>): Rights {
  const sellers = c.att.sellers.map((s, i) => [s.sellerId, shares[i]!] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { claims: c.att.claimIds.map(() => "CONVERTED"), entitlements: sellers.map(([id, bps]) => [id, "ACTIVE", bps] as const), pools: 1, lines: shares.length };
}

/**
 * Observes, in pg_stat_activity and pg_blocking_pids, that the backend of `waiter` is waiting on a lock held by the backend of `holder`
 * (for a cell whose waiter is already running, paused before its lock, so `ctx.mustWait` — which starts its operation — cannot be used).
 */
export async function observeBlocked(waiter: HarnessConnection, holder: HarnessConnection, what: string, limitMs = 10_000): Promise<void> {
  const oracle = iwOf().h.oracle;
  const deadline = Date.now() + limitMs;
  for (;;) {
    const r = await oracle.query<{ blocked: boolean; state: string | null }>(
      "SELECT $2::int = ANY (pg_blocking_pids(pid)) AS blocked, wait_event_type AS state FROM pg_stat_activity WHERE pid = $1",
      [connectionPid(waiter), connectionPid(holder)],
    );
    if (r.rows[0]?.blocked === true && r.rows[0].state === "Lock") return;
    if (Date.now() > deadline) throw new Error(`${what}: the waiter was never seen waiting on the holder's lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- the ledger of a purchase, read by the superuser ----------------------------------------------------------------------------------

export interface LineView {
  readonly lineId: string;
  readonly state: string;
  readonly version: number;
  readonly cumulative: string;
  readonly holds: ReadonlyArray<readonly [string, string, string]>;
}
export interface LedgerView {
  readonly facts: ReadonlyArray<readonly [number, string]>;
  readonly lines: ReadonlyArray<LineView>;
}
/** What the funds effect writes for a purchase: the funds facts of its capture, each line with its state, version, cumulative and holds (reason, state, cents). */
export async function ledgerOfPurchase(p: Purchase): Promise<LedgerView> {
  const facts = await oracleRows<{ capture_version: number; funds_state: string }>(iwOf(), "SELECT capture_version, funds_state FROM kauro.capture_funds_observations WHERE capture_id = $1 ORDER BY capture_version", [p.captureId]);
  const lines = await oracleRows<{ line_id: string; state: string; version: string; cumulative: string }>(
    iwOf(),
    "SELECT line_id, state, version::text, cumulative_entitlement_cents::text AS cumulative FROM kauro.commission_lines WHERE authorization_id = $1 ORDER BY seller_id, line_id",
    [p.authorizationId],
  );
  const out: LineView[] = [];
  for (const l of lines) {
    const holds = await oracleRows<{ reason: string; state: string; amount_cents: string }>(iwOf(), "SELECT reason, state, amount_cents::text FROM kauro.commission_holds WHERE line_id = $1 ORDER BY opened_at, hold_id", [l.line_id]);
    out.push({ lineId: l.line_id, state: l.state, version: Number(l.version), cumulative: l.cumulative, holds: holds.map((h) => [h.reason, h.state, h.amount_cents] as const) });
  }
  return { facts: facts.map((f) => [Number(f.capture_version), f.funds_state] as const), lines: out };
}
export const stateOf = (l: LineView): string => l.state;

/** Every capture event of a type, oldest version first, as the dispatcher would hand them to COMMISSIONS. */
export async function eventsOf(captureId: string, eventType: string): Promise<Delivery[]> {
  const rows = await oracleRows<{ event_id: string }>(iwOf(), "SELECT event_id FROM kauro.domain_events WHERE event_type = $2 AND (aggregate_id = $1::uuid OR payload->>'captureId' = $1::text) ORDER BY aggregate_version, created_at", [captureId, eventType]);
  return Promise.all(rows.map((r) => deliveryOf(iwOf(), r.event_id)));
}
/** The provider changes the capture's disbursement and the payment service applies it (CMD034): the one new capture.funds_observed.v1, not delivered to COMMISSIONS. */
export async function fundsReport(p: Purchase, disbursement: "INSTANT" | "DELAYED"): Promise<Delivery> {
  const before = (await eventsOf(p.captureId, "capture.funds_observed.v1")).length;
  await providerReports(iwOf(), p, { disbursement });
  const events = await eventsOf(p.captureId, "capture.funds_observed.v1");
  assert.equal(events.length, before + 1, "the provider's change published one funds observation");
  const latest = events[events.length - 1]!;
  assert.equal(latest.payload["fundsState"], disbursement === "INSTANT" ? "AVAILABLE" : "HELD");
  return latest;
}

