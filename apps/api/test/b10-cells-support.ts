// What the B10 failure-cell files share (docs/design/B10-failure-matrix.md; lane 4 B10G4-R2, lane 5): the one way a cell delivers an event to the
// COMMISSIONS consumer or runs a sweep pass (the outcome is asserted in the helper, so no call site can forget it), the way a cell routes a
// unit over a connection of the common fault harness, and the two-actor race (`contend`: the holder stops with its locks taken, the waiter is
// observed waiting on it in pg_stat_activity, both settle, and nothing of the raced pair failed behind the sink). A test file binds its world
// once with `bindCells(iw)` in `before`; every file runs in a process of its own, so the binding is the file's.
import assert from "node:assert/strict";
import type { Client } from "pg";
import { assertInvariants, connectionPid, faultCell, openConnection, type CellOptions, type FaultContext, type FaultKind, type FaultPoints, type HarnessConnection, type MatrixCell } from "@kauro/persistence/testing";
import { createCommissionService, type CommissionService } from "../src/index.js";
import type { CommissionSweepName, SweepReport } from "../src/commissions/sweeps.js";
import { providerReports, type IntegrationWorld } from "./integration-support.js";
import { acceptAttribution, claimsOn, deliveryOf, eventOf, linesOf, oracleRows, poolsOf, purchase, sellingAgency, type Attribution, type Purchase, type Selling } from "./commission-support.js";
import type { FaultRouting, LoggedStatement, RouteRole, Routing, SqlStep, UnitLog } from "./fault-support.js";
import { ids } from "./support.js";

export type Login = "kauro_app_test" | "kauro_commission_test" | "kauro_control_test" | "kauro_payment_test";
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
  const oracle = familyOf().oracle;
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

// ===================================================================================================================================
// The family runner (docs/design/B10-KIT-SUITES.md sections 3-5): members declare data, boundary receipts and postconditions; the runner
// owns the orchestration — the connections, the routing of the act's units (its target unit numbered by the invocation, crashable as
// `target`, its statements logged), the fault, the footprint rule, the recovery — so no member manufactures its own proof. Every cell
// ends with the B10 state oracle (assertInvariants). Registration refuses an incomplete member.
// ===================================================================================================================================

/** Where a member's cell sits in B10-failure-matrix.md: the table, the row and the column (fault kind) it answers. */
export interface MatrixRef {
  readonly table: string;
  readonly row: string;
  readonly column: string;
}

/** A statement of the act the runner must see with the member's identity params: a SqlStep and the identity it binds to the fixture. */
export type Receipt<F> = SqlStep & { identity(f: F): (params: ReadonlyArray<unknown>) => boolean };

/** The target unit of a crash or partial member: its ordinal in the act's invocation, its phase name, and the witness that proves the phase. */
export interface UnitTarget<F> {
  readonly ordinal: number;
  readonly phase: string;
  /** The effect's last write (FAILURE-MATRIX-TEMPLATE rule 2): it must be in the target unit's log with the identity params. */
  readonly witness: SqlStep;
  identity(f: F): (params: ReadonlyArray<unknown>) => boolean;
}

/** The ports a port-timeout member may name: classified by the binding the path actually CALLS (section 5.2). */
export type PortName = "BuyerTypeReader" | "PreparationCompletionSource" | "ActiveWorkInspector" | "PurchaseRebinder";

/** A dispatcher obligation of the LEASE family (section 6): run by that family's own runner, never by these templates. */
export interface DispatcherObligation {
  readonly row: "L1" | "D" | "L2";
  readonly column: string;
}

export type FaultPoint<F> =
  | { readonly kind: "lock-timeout"; hold(holder: HarnessConnection, f: F): Promise<void>; readonly waits: Receipt<F> }
  | { readonly kind: "port-timeout"; readonly port: PortName; readonly boundMs: number }
  | { readonly kind: "crash-before" | "crash-after"; readonly unit: UnitTarget<F> }
  | { readonly kind: "partial"; readonly unit: UnitTarget<F>; readonly completed: Receipt<F>; readonly failing: Receipt<F> }
  | { readonly kind: "twice"; readonly holder: { readonly unit: UnitTarget<F>; readonly holdAfter: Receipt<F> }; readonly waiter: { readonly unit: UnitTarget<F>; readonly blocks: Receipt<F> } }
  | { readonly kind: "membership"; readonly holdAfter: Receipt<F>; revoke(c: HarnessConnection, f: F): Promise<void>; refusal(e: unknown): boolean }
  | { readonly kind: "step-up-expiry"; waitOn(holder: HarnessConnection, f: F): Promise<void>; proofExpiresAt(f: F): string }
  | { readonly kind: "lease"; readonly obligation: DispatcherObligation };

/** A table's rows, each as the oracle's row_to_json text: what a member says the units before its target committed. */
export type RowSet = Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;

/** A non-2xx answer of an act (member.act throws it), with the status and the outcome code. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "Refused";
  }
}

export interface Member<F, A> {
  readonly code: string;
  readonly cell: MatrixRef;
  readonly variant?: string;
  /** The tag of the matrix test index (e.g. `[gcashrace]`): unique across the families. */
  readonly tag: string;
  /** The login of each role whose units the act opens (one connection per role, one counter: onRoles). */
  readonly roles: Partial<Record<RouteRole, Login>>;
  /** `after`: the fixture of the previous phase of a membership member (phase 3 acts as the principal revoked in phase 2). */
  fixture(label: string, after?: F): Promise<F>;
  /** The act under the fault; a non-2xx answer throws Refused(status, code). */
  act(ctx: FaultContext, f: F, key: string): Promise<A>;
  readonly point: FaultPoint<F>;
  /** The tables of the footprint (command_journal and outbox_records are always added). */
  readonly tables: ReadonlyArray<string>;
  /** The EXACT rows committed by the units before the target (an empty set for a one-unit step). */
  earlier(f: F): Promise<RowSet>;
  /** The refusal and what survives it. */
  failed(f: F, failure: unknown): Promise<void>;
  /**
   * What a unit that committed before its answer was lost leaves (REQUIRED for crash-after). The act has no answer then: `lost` is what the
   * act failed with (the simulated crash at the target's after-commit), kept apart from the type A of an answer it never gave.
   */
  committed?(f: F, outcome: { readonly lost: unknown }): Promise<void>;
  /** The recovery: the same key, a redelivery, the next pass or a takeover. */
  recover(ctx: FaultContext, f: F, key: string): Promise<unknown>;
  /** Exactly once by durable identity; the earlier commits preserved. */
  recovered(f: F, recovery: unknown): Promise<void>;
  readonly expect: string;
  /**
   * A `twice` member only (5.5: "the reverse order is a second member"): the reason the reverse order does not exist for this cell (the two
   * actors are one and the same command, so swapping them changes nothing). Without it, the family must hold the reverse member.
   */
  readonly reverseNa?: string;
}

/** The world a family runs in: the superuser oracle, the fault routing of its api, and connections of the login roles. */
export interface FamilyWorld {
  readonly oracle: Client;
  readonly faults: FaultRouting;
  open(login: Login): Promise<HarnessConnection>;
}
let family: FamilyWorld | null = null;
/** Binds the world the family runner uses (bindCells binds the cells' world; a family over another world binds its own). */
export function bindFamily(w: FamilyWorld): void {
  family = w;
}
function familyOf(): FamilyWorld {
  if (family !== null) return family;
  const iw = iwOf();
  return { oracle: iw.h.oracle, faults: iw.faults, open };
}

/** The statement timeout of an explicit lock-timeout attempt only (section 1 non-goals): restored in `finally`. */
export const LOCK_TIMEOUT_ATTEMPT_MS = 1500;
/** How long (real ms) the runner waits past a port's declared bound for the application's own bound to settle the operation. */
export const PORT_SETTLE_LIMIT_MS = 5000;
/** The tables every footprint carries. */
const ALWAYS = ["command_journal", "outbox_records"] as const;

const kindOf = (point: FaultPoint<unknown>): { readonly fault: FaultKind; readonly at?: string } => {
  switch (point.kind) {
    case "lock-timeout":
    case "twice":
      return { fault: "race" };
    case "port-timeout":
      return { fault: "timeout" };
    case "crash-before":
      return { fault: "crash-before-commit", at: "target" };
    case "crash-after":
      return { fault: "crash-after-commit", at: "target" };
    case "partial":
      return { fault: "partial" };
    case "membership":
      return { fault: "revocation" };
    case "step-up-expiry":
      return { fault: "expiry" };
    case "lease":
      throw new Error("a lease member runs in the LEASE family's runner (section 6), never in these templates");
  }
};

/** The cell a member registers as: id = its code, the step its matrix reference, variant and tag (the matrix test index resolves the tag). */
export function memberCell(m: Member<never, never>): MatrixCell {
  const { fault, at } = kindOf(m.point as FaultPoint<unknown>);
  return { id: m.code, step: `${m.cell.table} ${m.cell.row} ${m.cell.column}${m.variant !== undefined ? ` (${m.variant})` : ""} ${m.tag}`, fault, ...(at !== undefined ? { at } : {}), expect: m.expect };
}

/** The reverse order of a `twice` member (5.5): another member of its code and cell whose holder holds after what this one's waiter blocks on, and the converse; or its declared N/A reason. */
function hasReverse(m: Member<never, never>, members: ReadonlyArray<Member<never, never>>): boolean {
  if (m.reverseNa !== undefined && m.reverseNa.trim().length > 0) return true;
  const p = m.point;
  if (p.kind !== "twice") return true;
  return members.some(
    (o) =>
      o !== m &&
      o.point.kind === "twice" &&
      o.code === m.code &&
      o.cell.table === m.cell.table &&
      o.cell.row === m.cell.row &&
      o.cell.column === m.cell.column &&
      o.point.holder.holdAfter.label === p.waiter.blocks.label &&
      o.point.waiter.blocks.label === p.holder.holdAfter.label,
  );
}

/** Refuses an incomplete or ambiguous family at registration (section 4): every reason, not the first. */
export function validateMembers(members: ReadonlyArray<Member<never, never>>): void {
  const problems: string[] = [];
  if (members.length === 0) problems.push("the family has no member: an empty (or wrongly filtered) member list registers no cell and would pass silently");
  const seen = new Set<string>();
  const tags = new Set<string>();
  for (const m of members) {
    const key = `${m.code}|${m.cell.table}|${m.cell.row}|${m.cell.column}|${m.variant ?? ""}`;
    if (seen.has(key)) problems.push(`${m.code}: the member ${key} is registered twice`);
    seen.add(key);
    if (tags.has(m.tag)) problems.push(`${m.code}: the tag ${m.tag} names two members`);
    tags.add(m.tag);
    if (!/^\[[a-z0-9]+\]$/.test(m.tag)) problems.push(`${m.code}: the tag ${m.tag} is not of the matrix test index form [lowercase]`);
    if (Object.keys(m.roles).length === 0) problems.push(`${m.code}: no role, so no unit of its act can be routed`);
    if (m.point.kind === "lease") problems.push(`${m.code}: a lease member belongs to the LEASE family's runner (section 6)`);
    if (m.point.kind === "crash-after" && m.committed === undefined) problems.push(`${m.code}: a crash-after member declares what its committed unit leaves (committed)`);
    if ((m.point.kind === "crash-before" || m.point.kind === "crash-after" || m.point.kind === "partial") && !(Number.isInteger(m.point.unit.ordinal) && m.point.unit.ordinal >= 1)) problems.push(`${m.code}: the target unit's ordinal is a positive integer`);
    if (m.point.kind === "twice" && m.point.holder.holdAfter.label === m.point.waiter.blocks.label) problems.push(`${m.code}: the holder's and the waiter's receipts are one label`);
    if (m.point.kind === "twice" && !hasReverse(m, members)) problems.push(`${m.code}: a twice member needs its reverse order as a second member of the same cell (holder and waiter swapped), or reverseNa with the reason there is none`);
    if (m.point.kind === "port-timeout" && !(m.point.boundMs > 0)) problems.push(`${m.code}: a port-timeout member declares the application's bound`);
    if (m.expect.trim().length === 0) problems.push(`${m.code}: no expected end state`);
  }
  if (problems.length > 0) throw new Error(`the family does not register:\n${problems.join("\n")}`);
}

/** Registers a family: one fault cell per member, the runner's template for its point, the oracle after it (sections 4 and 5). */
export function registerFamily(members: ReadonlyArray<Member<never, never>>, options: CellOptions = {}): void {
  validateMembers(members);
  for (const m of members) faultCell(memberCell(m), (ctx) => runMember(ctx, m as unknown as Member<unknown, unknown>), options);
}

// --- the footprint (section 4, r2 R8) ------------------------------------------------------------------------------------------------

interface Snapshot {
  readonly rows: ReadonlyMap<string, ReadonlySet<string>>;
  /** Each table's primary-key columns: a row's durable identity, by which a removed row is matched to the update that replaced it. */
  readonly keys: ReadonlyMap<string, ReadonlyArray<string>>;
}
async function snapshot(tables: ReadonlyArray<string>): Promise<Snapshot> {
  const rows = new Map<string, Set<string>>();
  const keys = new Map<string, string[]>();
  for (const t of new Set([...tables, ...ALWAYS])) {
    if (!/^[a-z_]+$/.test(t)) throw new Error(`footprint table ${t} is not a kauro table name`);
    const r = await familyOf().oracle.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM kauro.${t} x`);
    rows.set(t, new Set(r.rows.map((row) => row.j)));
    const k = await familyOf().oracle.query<{ col: string }>(
      "SELECT a.attname AS col FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::int2[]) WHERE i.indrelid = ('kauro.' || $1)::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)",
      [t],
    );
    keys.set(t, k.rows.map((row) => row.col));
  }
  return { rows, keys };
}
const canonical = (row: Record<string, unknown>): string => JSON.stringify(row);
/** A row's durable identity: its primary-key values (null when the table has none: then no removal can be matched). */
const identityOf = (key: ReadonlyArray<string>, row: Record<string, unknown>): string | null => (key.length === 0 ? null : JSON.stringify(key.map((c) => row[c] ?? null)));
/**
 * The footprint rule: after a fault the footprint is the one before plus EXACTLY the rows the units before the target committed (a row an
 * earlier unit changed shows as its new version; its old version is the only row that may leave). The target unit's writes are absent.
 * A removed row is matched by IDENTITY (its primary key) to a declared earlier row it is the previous version of, once: a deletion of an
 * unrelated row never hides behind a legitimate insertion (B10-KIT-PR1-01).
 */
async function assertFootprint(what: string, before: Snapshot, tables: ReadonlyArray<string>, earlier: RowSet): Promise<void> {
  const after = await snapshot(tables);
  for (const [t, rows] of after.rows) {
    const was = before.rows.get(t) ?? new Set<string>();
    const added = [...rows].filter((j) => !was.has(j)).map((j) => canonical(JSON.parse(j) as Record<string, unknown>)).sort();
    const removed = [...was].filter((j) => !rows.has(j)).map((j) => JSON.parse(j) as Record<string, unknown>);
    const declared = (earlier[t] ?? []).map((row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
    const expected = declared.map(canonical).sort();
    assert.deepEqual(added, expected, `${what}: kauro.${t} gained exactly the rows the units before the target committed`);
    const key = after.keys.get(t) ?? [];
    const updatable = new Map<string, number>();
    for (const row of declared) {
      const id = identityOf(key, row);
      if (id !== null) updatable.set(id, (updatable.get(id) ?? 0) + 1);
    }
    for (const row of removed) {
      const id = identityOf(key, row);
      const left = id === null ? 0 : (updatable.get(id) ?? 0);
      assert.ok(left > 0, `${what}: kauro.${t} lost a row that is not the previous version of a row an earlier unit updated (${key.length === 0 ? "the table has no primary key to match it by" : `key ${key.join(",")} = ${id}`})`);
      updatable.set(id!, left - 1);
    }
  }
  for (const t of Object.keys(earlier)) assert.ok(after.rows.has(t), `${what}: the earlier rows of ${t} are outside the member's footprint tables`);
}

// --- routing of the act ---------------------------------------------------------------------------------------------------------------

const LOGIN_ROLE: Readonly<Record<Login, RouteRole>> = { kauro_app_test: "kauro_app", kauro_commission_test: "kauro_commission", kauro_control_test: "kauro_control", kauro_payment_test: "kauro_payment" };

/** One connection per role of the member: the first is the one a lock wait is observed on. */
async function connectionsOf(m: Member<unknown, unknown>): Promise<{ readonly conns: Partial<Record<RouteRole, HarnessConnection>>; readonly first: HarnessConnection; end(): Promise<void> }> {
  const conns: Partial<Record<RouteRole, HarnessConnection>> = {};
  const opened: HarnessConnection[] = [];
  for (const [role, login] of Object.entries(m.roles) as Array<[RouteRole, Login]>) {
    if (LOGIN_ROLE[login] !== role) throw new Error(`${m.code}: the role ${role} logs in as ${login}`);
    const c = await familyOf().open(login);
    conns[role] = c;
    opened.push(c);
  }
  return {
    conns,
    first: opened[0]!,
    end: async () => {
      for (const c of opened) await c.end();
    },
  };
}

/** Runs the act with every unit it opens routed over the member's connections (`waiter` replaces the first role's connection). */
function routedAct<F, A>(ctx: FaultContext, m: Member<F, A>, f: F, key: string, conns: Partial<Record<RouteRole, HarnessConnection>>, steps: ReadonlyArray<SqlStep>, routing: Routing, waiter?: HarnessConnection): Promise<A> {
  const map = { ...conns };
  if (waiter !== undefined) map[Object.keys(m.roles)[0] as RouteRole] = waiter;
  return familyOf().faults.onRoles(map, ctx.points, steps, () => m.act(ctx, f, key), routing);
}

/** The target unit's log: it must exist and carry the witness with the identity params, else the target is another phase. */
function targetUnit<F>(log: ReadonlyArray<UnitLog>, unit: UnitTarget<F>, f: F, code: string): UnitLog {
  const u = log.find((x) => x.ordinal === unit.ordinal);
  const identity = unit.identity(f);
  if (u === undefined || !u.statements.some((s) => unit.witness.match.test(s.text) && identity(s.params))) {
    throw new Error(`${code}: target unit is another phase — unit ${unit.ordinal} (${unit.phase}) does not carry its witness ${unit.witness.label} with the member's identity (units: ${log.map((x) => `${x.ordinal}:${x.role ?? "?"}:${x.statements.length}`).join(", ")})`);
  }
  return u;
}
/**
 * The statement a holder is paused after (`db.<holdAfter>.after`): the last statement the act dispatched (it is stopped right after it). It
 * must carry the receipt's label and the member's identity params and, when the member declares one, belong to its target unit
 * (B10-KIT-PR1-02: a valid witness elsewhere proves nothing about the paused statement).
 */
function pausedAt<F>(log: ReadonlyArray<UnitLog>, holdAfter: Receipt<F>, f: F, what: string, ordinal?: number): void {
  const unit = log[log.length - 1];
  const held = unit?.statements[unit.statements.length - 1];
  assert.ok(unit !== undefined && held !== undefined && held.label === holdAfter.label && holdAfter.identity(f)(held.params) && (ordinal === undefined || unit.ordinal === ordinal), `${what} (paused in unit ${unit?.ordinal ?? "none"} after ${held?.label ?? "no step"})`);
}
/** The statements of a unit carrying a receipt's label with the member's identity params. */
const receipts = <F>(u: UnitLog, r: Receipt<F>, f: F): LoggedStatement[] => u.statements.filter((s) => s.label === r.label && r.identity(f)(s.params));

const settledOf = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> => p.then((value) => ({ status: "fulfilled", value }) as const, (reason: unknown) => ({ status: "rejected", reason }) as const);
const failureOfOutcome = (r: PromiseSettledResult<unknown>, what: string): unknown => {
  if (r.status === "fulfilled") throw new Error(`${what}: the act answered ${JSON.stringify(r.value)?.slice(0, 300)}, it was expected to fail`);
  return r.reason;
};
let keys = 0;
/** An Idempotency-Key of the accepted shape (16 to 128 of [A-Za-z0-9_-]) whatever the code's and the pid's lengths (a short pid made it 15). */
const keyOf = (m: Member<unknown, unknown>): string => `${m.code.toLowerCase()}-${process.pid}-${++keys}`.padEnd(16, "0");

// --- the port hook (section 5.2) --------------------------------------------------------------------------------------------------

/** The held call of a port was released by the runner after its verdict (the application never got an answer). */
export class PortReleased extends Error {
  constructor(port: PortName) {
    super(`the runner released the held ${port} call`);
    this.name = "PortReleased";
  }
}

/**
 * The port hook: a world binds each port it hands the application through `portHooks.hook(name, port)`. Unarmed, every call reaches the
 * real port. Armed by a port-timeout cell, the next call records its arrival (`port.<name>.<method>.before` in the operation's scope) and
 * is held: it never answers, so only the application's own bound can end the operation; the runner releases it (PortReleased) once its
 * verdict is in, so nothing is left running.
 */
export class PortHooks {
  readonly #armed = new Map<PortName, { readonly points: FaultPoints; readonly arrived: () => void; readonly held: Promise<never> }>();

  hook<P extends object>(name: PortName, port: P): P {
    return new Proxy(port, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function" || typeof prop !== "string") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        return async (...args: unknown[]) => {
          const armed = this.#armed.get(name);
          if (armed === undefined) return (value as (...a: unknown[]) => unknown).apply(target, args);
          this.#armed.delete(name);
          await armed.points.pass(`port.${name}.${prop}.before`);
          armed.arrived();
          return armed.held;
        };
      },
    });
  }

  /** Arms the next call of the port: resolves `arrived` when it is held; `release` ends the held call with PortReleased. */
  arm(name: PortName, points: FaultPoints): { readonly arrived: Promise<void>; release(): void } {
    if (this.#armed.has(name)) throw new Error(`the ${name} hook is already armed`);
    let arrived: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    let reject: (e: Error) => void = () => undefined;
    const held = new Promise<never>((_resolve, r) => (reject = r));
    held.catch(() => undefined);
    this.#armed.set(name, { points, arrived, held });
    const release = (): void => {
      this.#armed.delete(name);
      reject(new PortReleased(name));
    };
    return { arrived: reached, release };
  }
}
/** The hooks of the bound world's ports (one per test process: every file runs in a process of its own). */
export const portHooks = new PortHooks();

// --- the templates (section 5): each ends with the oracle --------------------------------------------------------------------------

/** Runs one member under its point's template. */
export async function runMember(ctx: FaultContext, m: Member<unknown, unknown>): Promise<void> {
  const label = `${m.code}${m.variant !== undefined ? `-${m.variant}` : ""}`;
  switch (m.point.kind) {
    case "lock-timeout":
      await lockTimeout(ctx, m, m.point, label);
      break;
    case "port-timeout":
      await portTimeout(ctx, m, m.point, label);
      break;
    case "crash-before":
    case "crash-after":
      await crash(ctx, m, m.point, label);
      break;
    case "partial":
      await partial(ctx, m, m.point, label);
      break;
    case "twice":
      await twice(ctx, m, m.point, label);
      break;
    case "membership":
      await membership(ctx, m, m.point, label);
      break;
    case "step-up-expiry":
      await stepUpExpiry(ctx, m, m.point, label);
      break;
    case "lease":
      throw new Error(`${m.code}: a lease member runs in the LEASE family's runner (section 6)`);
  }
  await assertInvariants(familyOf().oracle, { label: `${m.code} ${m.tag}` });
}

/** The recovery and its verdict: exactly once by durable identity, the earlier commits preserved. */
async function recovery<F>(ctx: FaultContext, m: Member<F, unknown>, f: F, key: string): Promise<void> {
  const recovered = await m.recover(ctx, f, key);
  await m.recovered(f, recovered);
}

/**
 * 5.1 lock-timeout (`race`): the holder takes the conflicting lock; the act, routed over the waiter connection with the statement timeout
 * of an explicit timeout attempt, is observed waiting (mustWait) and times out on its FIRST conflicting statement — the `waits` receipt:
 * dispatched with the identity params (`.before`), never answered (no `.after`), SQLSTATE 57014. Then the refusal, the footprint rule,
 * the holder's ROLLBACK and the recovery.
 */
async function lockTimeout<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "lock-timeout" }>, label: string): Promise<void> {
  const fam = familyOf();
  const f = await m.fixture(label);
  const before = await snapshot(m.tables);
  const key = keyOf(m as Member<unknown, unknown>);
  const holder = await fam.open(Object.values(m.roles)[0]!);
  const c = await connectionsOf(m as Member<unknown, unknown>);
  const log: UnitLog[] = [];
  const previous = fam.faults.statementTimeoutMs;
  try {
    await holder.query("BEGIN");
    await point.hold(holder, f);
    fam.faults.statementTimeoutMs = LOCK_TIMEOUT_ATTEMPT_MS;
    let failure: unknown;
    try {
      const waiting = await ctx.mustWait(fam.oracle, { waiter: c.first, holder: connectionPid(holder) }, (conn) => routedAct(ctx, m, f, key, c.conns, [point.waits], { log }, conn), `${m.code}: the act while the holder holds ${point.waits.label}`);
      failure = failureOfOutcome(await waiting.pending, `${m.code} under the held lock`);
    } finally {
      fam.faults.statementTimeoutMs = previous;
    }
    const waited = log.flatMap((u) => receipts(u, point.waits, f));
    assert.equal(waited.length, 1, `${m.code}: the act dispatched ${point.waits.label} once with the member's identity params`);
    assert.deepEqual([waited[0]!.outcome, waited[0]!.code], ["failed", "57014"], `${m.code}: ${point.waits.label} is the statement that timed out on the holder's lock (the FIRST conflicting statement of the act)`);
    assert.ok(!ctx.points.passed.includes(`db.${point.waits.label}.after`), `${m.code}: ${point.waits.label} never answered`);
    await m.failed(f, failure);
    await assertFootprint(`${m.code} after the lock timeout`, before, m.tables, await m.earlier(f));
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    await holder.end();
    await c.end();
  }
  await recovery(ctx, m, f, key);
}

/**
 * 5.2 port-timeout (`timeout`): the port's next call is held after its recorded arrival and never answered; the declared bound is the
 * deadline, crossed while the call is in flight; only the application's own bound may end the operation. No bound: the member is RED
 * (a product GAP for the owning lane) — a statement timeout, an injected rejection or node:test's timeout never turns it green.
 */
async function portTimeout<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "port-timeout" }>, label: string): Promise<void> {
  const f = await m.fixture(label);
  const before = await snapshot(m.tables);
  const key = keyOf(m as Member<unknown, unknown>);
  const c = await connectionsOf(m as Member<unknown, unknown>);
  const hold = portHooks.arm(point.port, ctx.points);
  try {
    const deadline = ctx.deadline(ctx.clock.at(point.boundMs), `${m.code}: the application's ${point.port} bound`);
    const op = settledOf(ctx.operation(`${m.code} with ${point.port} held`, () => routedAct(ctx, m, f, key, c.conns, [], {})));
    await Promise.race([
      hold.arrived,
      op.then((r) => {
        throw new Error(`${m.code}: the act settled (${r.status}) without calling ${point.port}: the path calls another binding (classify it by the binding it calls, 5.2)`);
      }),
    ]);
    ctx.clock.past(deadline);
    const limit = new Promise<"NO_BOUND">((resolve) => setTimeout(() => resolve("NO_BOUND"), point.boundMs + PORT_SETTLE_LIMIT_MS).unref());
    const verdict = await Promise.race([op, limit]);
    if (verdict === "NO_BOUND") {
      hold.release();
      await op;
      throw new Error(`${m.code}: no application bound on ${point.port}: the operation still waited on the held call ${PORT_SETTLE_LIMIT_MS} ms past its ${point.boundMs} ms bound (product GAP for the owning lane)`);
    }
    const failure = failureOfOutcome(verdict, `${m.code} past the ${point.port} bound`);
    assert.ok(!(failure instanceof PortReleased), `${m.code}: the runner's release is never the application's bound`);
    await m.failed(f, failure);
    await assertFootprint(`${m.code} after the ${point.port} bound`, before, m.tables, await m.earlier(f));
  } finally {
    hold.release();
    await c.end();
  }
  await recovery(ctx, m, f, key);
}

/**
 * 5.3 crash-before / crash-after (`target`): the crash fires at the target unit's commit boundary inside an operation; the target unit
 * carries its witness. Before: the footprint rule (the target's writes absent). After: `committed`. Then the recovery.
 */
async function crash<F, A>(ctx: FaultContext, m: Member<F, A>, point: Extract<FaultPoint<F>, { kind: "crash-before" | "crash-after" }>, label: string): Promise<void> {
  const f = await m.fixture(label);
  const before = await snapshot(m.tables);
  const key = keyOf(m as Member<unknown, unknown>);
  const c = await connectionsOf(m as Member<unknown, unknown>);
  const log: UnitLog[] = [];
  const boundary = point.kind === "crash-before" ? "before-commit" : "after-commit";
  try {
    ctx.points.crash(`target.${boundary}`);
    const outcome = await settledOf(ctx.operation(`${m.code} crashing at target.${boundary}`, () => routedAct(ctx, m, f, key, c.conns, [], { target: point.unit.ordinal, log })));
    targetUnit(log, point.unit, f, m.code);
    const failure = failureOfOutcome(outcome, `${m.code} at target.${boundary}`);
    if (point.kind === "crash-before") {
      await m.failed(f, failure);
      await assertFootprint(`${m.code} after the crash before the target's COMMIT`, before, m.tables, await m.earlier(f));
    } else {
      await m.committed!(f, { lost: failure });
    }
  } finally {
    await c.end();
  }
  await recovery(ctx, m, f, key);
}

/**
 * 5.4 partial: the act fails at `db.<failing>.before` strictly after `completed` answered in the SAME target unit (both writes, both in
 * the target's log with the identity params, `completed` answered before `failing` was dispatched); the footprint rule.
 */
async function partial<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "partial" }>, label: string): Promise<void> {
  const f = await m.fixture(label);
  const before = await snapshot(m.tables);
  const key = keyOf(m as Member<unknown, unknown>);
  const c = await connectionsOf(m as Member<unknown, unknown>);
  const log: UnitLog[] = [];
  try {
    const failure = await ctx.partial(`${m.code}: ${point.completed.label} then ${point.failing.label}`, `db.${point.failing.label}.before`, () => routedAct(ctx, m, f, key, c.conns, [point.completed, point.failing], { target: point.unit.ordinal, log }));
    const u = targetUnit(log, point.unit, f, m.code);
    const done = receipts(u, point.completed, f);
    const failing = receipts(u, point.failing, f);
    assert.ok(done.length >= 1 && done.every((s) => s.outcome === "answered"), `${m.code}: ${point.completed.label} answered in the target unit with the identity params`);
    assert.equal(failing.length, 1, `${m.code}: ${point.failing.label} was reached in the target unit with the identity params`);
    assert.ok(u.statements.indexOf(done[0]!) < u.statements.indexOf(failing[0]!), `${m.code}: ${point.completed.label} completed before ${point.failing.label} was dispatched`);
    await m.failed(f, failure);
    await assertFootprint(`${m.code} after the partial failure`, before, m.tables, await m.earlier(f));
  } finally {
    await c.end();
  }
  await recovery(ctx, m, f, key);
}

/**
 * 5.5 twice (`race`; r2 R7): A pauses right after `holdAfter` answered in its target unit; B runs and is observed waiting (mustWait) with
 * its last dispatched statement = `blocks`, with the identity params, in B's target unit; release; both settle (sweeps through
 * mustHaveSettled, the sink checked). The reverse order is a second member. One durable effect: `recovered`.
 */
async function twice<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "twice" }>, label: string): Promise<void> {
  const fam = familyOf();
  const f = await m.fixture(label);
  const ca = await connectionsOf(m as Member<unknown, unknown>);
  const cb = await connectionsOf(m as Member<unknown, unknown>);
  const logA: UnitLog[] = [];
  const logB: UnitLog[] = [];
  const seen = failures.length;
  try {
    const pause = ctx.points.pause(`db.${point.holder.holdAfter.label}.after`);
    const a = settledOf(ctx.operation(`${m.code} A (holder)`, () => routedAct(ctx, m, f, keyOf(m as Member<unknown, unknown>), ca.conns, [point.holder.holdAfter], { target: point.holder.unit.ordinal, log: logA })));
    await pause.reachedBy(a.then((r) => (r.status === "fulfilled" ? r.value : Promise.reject(r.reason))));
    targetUnit(logA, point.holder.unit, f, `${m.code} A`);
    pausedAt(logA, point.holder.holdAfter, f, `${m.code}: A paused after ${point.holder.holdAfter.label} in its target unit ${point.holder.unit.ordinal} with the member's identity params`, point.holder.unit.ordinal);
    let blocked: LoggedStatement | undefined;
    const waiting = await ctx.mustWait(fam.oracle, { waiter: cb.first, holder: connectionPid(ca.conns[Object.keys(m.roles)[0] as RouteRole]!) }, (conn) => routedAct(ctx, m, f, keyOf(m as Member<unknown, unknown>), cb.conns, [point.waiter.blocks], { target: point.waiter.unit.ordinal, log: logB }, conn), `${m.code}: B while A holds after ${point.holder.holdAfter.label}`);
    const unitB = logB.find((u) => u.ordinal === point.waiter.unit.ordinal);
    blocked = unitB?.statements[unitB.statements.length - 1];
    assert.ok(blocked !== undefined && blocked.label === point.waiter.blocks.label && blocked.outcome === "pending" && point.waiter.blocks.identity(f)(blocked.params), `${m.code}: B's last dispatched statement in its target unit is ${point.waiter.blocks.label} with the identity params, waiting`);
    pause.release();
    const held = await a;
    const waited = await waiting.pending;
    mustHaveSettled(held, `${m.code} A`);
    mustHaveSettled(waited, `${m.code} B`);
    assert.deepEqual(failures.slice(seen).map((x) => String(x.subject)), [], `${m.code}: a raced unit failed behind the background sink`);
    await m.recovered(f, { a: held, b: waited });
  } finally {
    await ca.end();
    await cb.end();
  }
}

/**
 * 5.6 membership revocation, the three phases of PAY_REV (b10-failure-cells-pay.test.ts): (1) the revocation first, uncommitted: the act
 * waits on it, the revocation commits (ctx.revoked), the act is refused and writes nothing; (2) the act first, held right after
 * `holdAfter`: the revocation waits and lands after the act's COMMIT; (3) after the revocation every act is refused (ctx.fenced).
 */
async function membership<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "membership" }>, label: string): Promise<void> {
  const fam = familyOf();
  // (1) revocation first
  const f1 = await m.fixture(`${label}-1`);
  const before = await snapshot(m.tables);
  const rc = await fam.open("kauro_control_test");
  const c1 = await connectionsOf(m as Member<unknown, unknown>);
  try {
    await rc.query("BEGIN");
    await point.revoke(rc, f1);
    const waiting = await ctx.mustWait(fam.oracle, { waiter: c1.first, holder: connectionPid(rc) }, (conn) => routedAct(ctx, m, f1, keyOf(m as Member<unknown, unknown>), c1.conns, [], {}, conn), `${m.code}: the act while the revocation is uncommitted`);
    await ctx.revoked(`${m.code}: the membership`, () => rc.query("COMMIT"));
    const refused = failureOfOutcome(await waiting.pending, `${m.code} after the revocation committed`);
    assert.ok(point.refusal(refused), `${m.code}: the act that waited is refused as the member declares`);
    await m.failed(f1, refused);
    await assertFootprint(`${m.code} refused after the revocation`, before, m.tables, await m.earlier(f1));
  } finally {
    await rc.query("ROLLBACK").catch(() => undefined);
    await rc.end();
    await c1.end();
  }
  // (2) the act first, held after holdAfter: the revocation waits and lands after it
  const f2 = await m.fixture(`${label}-2`);
  const c2 = await connectionsOf(m as Member<unknown, unknown>);
  const rc2 = await fam.open("kauro_control_test");
  try {
    const pause = ctx.points.pause(`db.${point.holdAfter.label}.after`);
    const log2: UnitLog[] = [];
    const act = settledOf(ctx.operation(`${m.code} holding the membership`, () => routedAct(ctx, m, f2, keyOf(m as Member<unknown, unknown>), c2.conns, [point.holdAfter], { log: log2 })));
    await pause.reachedBy(act.then((r) => (r.status === "fulfilled" ? r.value : Promise.reject(r.reason))));
    pausedAt(log2, point.holdAfter, f2, `${m.code}: the act paused after ${point.holdAfter.label} with the member's identity params`);
    const revocation = settledOf(
      (async () => {
        await rc2.query("BEGIN");
        await point.revoke(rc2, f2);
        await rc2.query("COMMIT");
      })(),
    );
    await observeBlocked(rc2, c2.first, `${m.code}: the revocation while the act holds the membership`);
    pause.release();
    const held = await act;
    assert.equal(held.status, "fulfilled", `${m.code}: the act holding the membership commits before the revocation`);
    await ctx.revoked(`${m.code}: the membership (after the act)`, async () => {
      const r = await revocation;
      assert.equal(r.status, "fulfilled", `${m.code}: the revocation lands after the act`);
    });
    // (3) every act after the revocation is refused
    const f3 = await m.fixture(`${label}-3`, f2);
    const c3 = await connectionsOf(m as Member<unknown, unknown>);
    try {
      await ctx.fenced(`${m.code}: an act after the revocation`, () => routedAct(ctx, m, f3, keyOf(m as Member<unknown, unknown>), c3.conns, [], {}), point.refusal);
      await m.failed(f3, undefined);
    } finally {
      await c3.end();
    }
    await m.recovered(f2, held);
  } finally {
    await rc2.query("ROLLBACK").catch(() => undefined);
    await rc2.end();
    await c2.end();
  }
}

/**
 * 5.7 step-up expiry (CMD043, own declared deadline): the holder makes the act wait (`waitOn`); the proof's expiry is the deadline, crossed
 * while the act waits; the holder lets go; the act, consuming the instant past the deadline, is refused; footprint; recovery.
 */
async function stepUpExpiry<F>(ctx: FaultContext, m: Member<F, unknown>, point: Extract<FaultPoint<F>, { kind: "step-up-expiry" }>, label: string): Promise<void> {
  const fam = familyOf();
  const f = await m.fixture(label);
  const before = await snapshot(m.tables);
  const key = keyOf(m as Member<unknown, unknown>);
  const holder = await fam.open(Object.values(m.roles)[0]!);
  const c = await connectionsOf(m as Member<unknown, unknown>);
  try {
    await holder.query("BEGIN");
    await point.waitOn(holder, f);
    const deadline = ctx.deadline(point.proofExpiresAt(f), `${m.code}: the step-up proof's expiry`);
    const waiting = await ctx.mustWait(fam.oracle, { waiter: c.first, holder: connectionPid(holder) }, (conn) => routedAct(ctx, m, f, key, c.conns, [], {}, conn), `${m.code}: the act while its step-up proof runs out`);
    ctx.clock.past(deadline);
    await holder.query("ROLLBACK");
    const failure = failureOfOutcome(await waiting.pending, `${m.code} past the proof's expiry`);
    await m.failed(f, failure);
    await assertFootprint(`${m.code} after the proof expired`, before, m.tables, await m.earlier(f));
  } finally {
    await holder.query("ROLLBACK").catch(() => undefined);
    await holder.end();
    await c.end();
  }
  await recovery(ctx, m, f, key);
}
