// The commission service of package B10 (mandate B10-COMMISSION-SERVICE; docs/design/B10-case-map.md rows citing this file; design
// §6, §14; decisions D10-CONS-1, D10-CONS-2, D10-RATE-1, D10-RATE-2, D10-ADJ-1, D10-ADJ-2, D10-ELIG-1, D10-HOLD-1, D10-FIRST-2,
// D10-FOUND-4, D10-SVC-1..5). The real commission service — its composition over a kauro_commission and a kauro_control login, the
// COMMISSIONS consumer, its dispatcher and its sweeps — over PostgreSQL 17 through the runtime login roles; B09's payment service, api
// and provider fakes produce the purchases, refunds, reversals and funds observations it consumes. The superuser only reads, except
// where a title needs what no runtime role of this base performs (B08's delivery of an authorization; example 19's synthetic schedule),
// said so where it does. The preparation-completion port is its labelled contract fake (SIMULATED). Instants are the server's: the
// confirmations, acceptances and sweeps a title places at another instant stand there on the labelled TEST CLOCK; the worked examples'
// integer cents are written here, never read back from the code under test. Nothing sleeps: interleavings are held at named points and
// every wait is observed in pg_stat_activity. The founding cohort's three slots serve the whole cluster; the window sweeps, which stand
// a year ahead, run last.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ExecuteRefundView, WebhookAck } from "@kauro/application";
import type { PlanId } from "@kauro/domain";
import { barrier, commercialUnits, foundingQuote, handled, waitForLockWait } from "@kauro/persistence/testing";
import { AuthorizationDeliveryCompletionSource } from "@kauro/persistence";
import { DISPATCH_LEASE_SECONDS, PAYMENT_APPLICATION_NAME, commissionLeaseResource, createCommissionService } from "../src/index.js";
import {
  acceptAttribution,
  adjustmentsOf,
  approvedPlan,
  approvedRefund,
  assistanceFor,
  captureOf,
  checkoutOf,
  claimsOn,
  commissionWorld,
  deliveredByTheExecutionPackage,
  deliveryOf,
  eventOf,
  fixtureQuote,
  linesOf,
  oracleRows,
  poolsOf,
  providerCreated,
  purchase,
  quoteFactsOf,
  recordSyntheticSchedule,
  sellingAgency,
  statedQuote,
  type CommissionWorld,
  type Purchase,
  type Selling,
} from "./commission-support.js";
import { deliver, execute, postWebhook, reconcile, storeQuery } from "./payment-support.js";
import { clock, completed, ids } from "./support.js";

let cw: CommissionWorld;
before(async () => {
  cw = await commissionWorld();
});
after(async () => {
  await cw.stop();
});

const HOUR = 3600;
/** R2-INITIAL HUBSPOT band 1 at the founding rate: 129,500 less 32,375 (B09's fixture quote). */
const SERVICE = 97_125n;
/** round_half_up_bps(97125, 1000) = 9712.5 → 9713 (worked example 1). */
const FIRST_POOL = "9713";
/** round_half_up_bps(97125, 400) = 3885. */
const REPEAT_POOL = "3885";

/** Passes of the service's COMMISSIONS dispatcher until one claims less than a full batch: every due record of the cluster delivered. */
async function dispatch(): Promise<{ readonly deliveries: ReadonlyArray<{ readonly eventId: string; readonly eventType: string; readonly outcome: string }> }> {
  const deliveries: Array<{ readonly eventId: string; readonly eventType: string; readonly outcome: string }> = [];
  for (;;) {
    const pass = await cw.service.dispatcher.runOnce({ limit: 100 });
    const failed = pass.deliveries.filter((d) => d.outcome === "FAILED" || d.outcome === "DEAD_LETTER");
    assert.deepEqual(failed, [], "every delivery to COMMISSIONS is applied, a duplicate or not applicable");
    deliveries.push(...pass.deliveries);
    if (pass.held) throw new Error("another dispatcher holds the COMMISSIONS lease");
    if (pass.deliveries.length < 100) return { deliveries };
  }
}

/** One pass of a sweep whose every item settled (none FAILED). */
async function sweep(service: CommissionWorld["service"], name: Parameters<CommissionWorld["service"]["runSweep"]>[0]): Promise<void> {
  const report = await service.runSweep(name);
  assert.deepEqual(report.items.filter((i) => i.outcome.startsWith("FAILED")), [], `${name}: every item settled`);
}

async function acquired(label: string, options: { readonly acceptedAt?: string; readonly sellers?: number; readonly shares?: ReadonlyArray<number> } = {}) {
  const s = await sellingAgency(cw, label);
  const a = await claimsOn(cw, label, options.sellers ?? 1);
  const allocationId = await acceptAttribution(cw, s.agency.agencyId, a, options.shares ?? [10_000], options.acceptedAt ?? null);
  return { s, a, allocationId };
}

function poolShape(pools: ReadonlyArray<{ source: string; rate_kind: string; rate_bps: number; basis_cents: string; pool_cents: string }>) {
  return pools.map((p) => ({ source: p.source, rateKind: p.rate_kind, rateBps: p.rate_bps, basis: p.basis_cents, pool: p.pool_cents }));
}

async function purchaseInstants(p: Purchase): Promise<{ confirmed: string; provider: string; seq: number }> {
  const r = await oracleRows<{ confirmed_at: Date; provider_completed_at: Date; confirmation_seq: number }>(cw, "SELECT confirmed_at, provider_completed_at, confirmation_seq FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId]);
  assert.equal(r.length, 1, "the capture designated one qualifying purchase");
  return { confirmed: r[0]!.confirmed_at.toISOString(), provider: r[0]!.provider_completed_at.toISOString(), seq: r[0]!.confirmation_seq };
}

async function lineState(lineId: string): Promise<{ state: string; cumulative: string; version: string }> {
  const r = await oracleRows<{ state: string; cumulative: string; version: string }>(cw, "SELECT state, cumulative_entitlement_cents::text AS cumulative, version::text AS version FROM kauro.commission_lines WHERE line_id = $1", [lineId]);
  return r[0]!;
}

/** The provider changes a capture's disbursement and the payment service applies its stored query (CMD034): capture.funds_observed.v1. */
async function fundsAtProvider(p: Purchase, disbursement: "INSTANT" | "DELAYED"): Promise<void> {
  cw.pw.paypal.updateCapture(p.providerCaptureId, { disbursement });
  completed(await reconcile(cw.pw, p.orderId, { observationRef: await storeQuery(cw.pw, p.providerOrderId) }), 200);
}

/** A refund of the purchase executed by the payment service through CMD033 (refund.completed.v1). */
async function refunded(s: Selling, p: Purchase, serviceCents: bigint, taxCents = 0n): Promise<string> {
  const refundId = await approvedRefund(cw, s, p, { serviceCents, taxCents });
  const executed = completed<ExecuteRefundView>(await execute(cw.pw, refundId, { expectedVersion: 2 }), 200);
  assert.equal(executed.data.refund.state, "COMPLETED");
  return refundId;
}

/** The provider reverses the capture (a chargeback) and reports it through the webhook (capture.reversed.v1). */
async function reversed(p: Purchase): Promise<void> {
  cw.pw.paypal.updateCapture(p.providerCaptureId, { status: "REVERSED" });
  assert.equal(completed<WebhookAck>((await deliver(cw.pw, "PAYMENT.CAPTURE.REVERSED", p.providerCaptureId)).reply, 200).data.inboxState, "APPLIED");
}

// --- R2-094, R2-098, R2-099: the acquisition rate and the window ------------------------------------------------------------

test("R2-094: after a first confirmation at 2028-02-29T15:00:00Z, a subsequent capture completed at the provider at 2029-02-28T14:59:59Z accrues a 400-bps line and one completed at 2029-02-28T15:00:00Z accrues no acquisition line", async () => {
  const { s } = await acquired("r094", { acceptedAt: "2028-02-20T12:00:00Z" });
  const first = await purchase(cw, s, "r094-first", { confirmedAt: "2028-02-29T15:00:00Z", providerCompletedAt: "2028-02-29T14:55:00Z" });
  const inside = await purchase(cw, s, "r094-inside", { providerCompletedAt: "2029-02-28T14:59:59Z", confirmedAt: "2029-03-01T15:00:00Z" });
  const atEnd = await purchase(cw, s, "r094-end", { providerCompletedAt: "2029-02-28T15:00:00Z", confirmedAt: "2029-03-01T16:00:00Z" });
  await dispatch();

  // the window: twelve calendar months at the same America/Bogota wall time, the day clamped (10:00 on 2028-02-29 → 10:00 on 2029-02-28)
  const windows = await oracleRows<{ window_starts_at: Date; window_ends_at: Date }>(cw, "SELECT window_starts_at, window_ends_at FROM kauro.commission_entitlements WHERE agency_id = $1", [s.agency.agencyId]);
  assert.deepEqual(windows.map((w) => [w.window_starts_at.toISOString(), w.window_ends_at.toISOString()]), [["2028-02-29T15:00:00.000Z", "2029-02-28T15:00:00.000Z"]]);
  assert.deepEqual(poolShape(await poolsOf(cw, first.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "97125", pool: FIRST_POOL }]);
  assert.deepEqual(poolShape(await poolsOf(cw, inside.authorizationId)), [{ source: "ACQUISITION", rateKind: "REPEAT", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
  assert.deepEqual((await linesOf(cw, inside.authorizationId)).map((l) => [l.rate_bps, l.cumulative_entitlement_cents, l.state]), [[400, REPEAT_POOL, "ACCRUED_PENDING"]]);
  assert.deepEqual(await poolsOf(cw, atEnd.authorizationId), [], "a provider completion exactly at the exclusive end earns no acquisition pool");
  assert.deepEqual(await linesOf(cw, atEnd.authorizationId), []);
  // the provider's completion decides, never the confirmation: both later purchases were confirmed after the window
  assert.deepEqual(await purchaseInstants(inside), { confirmed: "2029-03-01T15:00:00.000Z", provider: "2029-02-28T14:59:59.000Z", seq: 2 });
  assert.deepEqual(await purchaseInstants(atEnd), { confirmed: "2029-03-01T16:00:00.000Z", provider: "2029-02-28T15:00:00.000Z", seq: 3 });
});

let example3: { readonly s: Selling; readonly sellers: ReadonlyArray<{ readonly sellerId: string }>; readonly first: Purchase; readonly earned: ReadonlyArray<{ readonly lineId: string; readonly state: string; readonly cumulative: string; readonly version: string }> } | null = null;

test("R2-098 (example 3): a purchase completed at the provider at or after the window end accrues no acquisition line, and no assistance line without a prior agreement, while the seller's earned lines of the window stay on their path to payment", async () => {
  const { s, a } = await acquired("ex3", { acceptedAt: "2027-01-02T12:00:00Z", sellers: 2, shares: [6_000, 4_000] });
  const first = await purchase(cw, s, "ex3-first", { confirmedAt: "2027-01-10T15:00:00Z", providerCompletedAt: "2027-01-10T14:50:00Z" });
  await dispatch();
  const lines = await linesOf(cw, first.authorizationId);
  // the first pool, 9713, split 6000/4000 by largest remainder: 5827.8 → 5828 and 3885.2 → 3885 (worked example 8's rule)
  const bySeller = new Map(lines.map((l) => [l.seller_id, l]));
  assert.deepEqual([bySeller.get(a.sellers[0]!.sellerId)?.cumulative_entitlement_cents, bySeller.get(a.sellers[1]!.sellerId)?.cumulative_entitlement_cents], ["5828", "3885"]);
  const earned = await Promise.all(lines.map(async (l) => ({ lineId: l.line_id, ...(await lineState(l.line_id)) })));

  // after the window (it ended at 2028-01-10T15:00:00Z): completed at the provider exactly at its end, notified a day later
  const after = await purchase(cw, s, "ex3-after", { providerCompletedAt: "2028-01-10T15:00:00Z", confirmedAt: "2028-01-11T15:00:00Z" });
  await dispatch();
  assert.deepEqual(await poolsOf(cw, after.authorizationId), [], "no acquisition pool and no assistance pool: no agreement preceded its order");
  assert.deepEqual(await linesOf(cw, after.authorizationId), []);
  assert.equal((await purchaseInstants(after)).seq, 2, "it is still the agency's second qualifying purchase (the buyer's own history)");
  // the earned lines keep their state, amount and version — no hold, nothing waits on the later purchase
  for (const line of earned) assert.deepEqual({ lineId: line.lineId, ...(await lineState(line.lineId)) }, line);
  assert.deepEqual(await oracleRows(cw, "SELECT 1 FROM kauro.commission_holds WHERE line_id = ANY ($1::uuid[])", [earned.map((l) => l.lineId)]), []);
  example3 = { s, sellers: a.sellers, first, earned };
});

test("R2-099 (example 3): a post-window purchase whose order follows a signed assistance agreement accrues one ASSISTANCE pool at 400 bps for that seller only, separate from any acquisition pool, and the seller's old lines never wait on the new work", async () => {
  assert.ok(example3 !== null, "R2-098 left the agency of example 3");
  const { s, sellers, earned } = example3;
  const seller = sellers[0]!;
  let assistanceId = "";
  const assisted = await purchase(cw, s, "ex3-assisted", {
    // the owner prepares the project-specific arrangement before the work (example 3), then the agency orders
    beforeOrder: async (plan) => {
      assistanceId = await assistanceFor(cw, s.agency.agencyId, seller as never, plan.projectId);
    },
    providerCompletedAt: "2028-02-01T15:00:00Z",
    confirmedAt: "2028-02-02T15:00:00Z",
  });
  await dispatch();
  // round_half_up_bps(97125, 400) = 3885, the assisting seller's whole pool
  assert.deepEqual(poolShape(await poolsOf(cw, assisted.authorizationId)), [{ source: "ASSISTANCE", rateKind: "ASSISTANCE", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
  const pools = await oracleRows<{ assistance_agreement_id: string; allocation_id: string | null }>(cw, "SELECT assistance_agreement_id, allocation_id FROM kauro.commission_pools WHERE authorization_id = $1", [assisted.authorizationId]);
  assert.deepEqual(pools, [{ assistance_agreement_id: assistanceId, allocation_id: null }], "the agreement's pool, never the allocation's");
  assert.deepEqual((await linesOf(cw, assisted.authorizationId)).map((l) => [l.seller_id, l.share_bps, l.cumulative_entitlement_cents, l.state]), [[seller.sellerId, 10_000, REPEAT_POOL, "ACCRUED_PENDING"]]);
  const entitlements = await oracleRows<{ kind: string; seller_id: string; assistance_agreement_id: string | null }>(cw, "SELECT kind, seller_id, assistance_agreement_id FROM kauro.commission_entitlements WHERE agency_id = $1 AND kind = 'ASSISTANCE'", [s.agency.agencyId]);
  assert.deepEqual(entitlements, [{ kind: "ASSISTANCE", seller_id: seller.sellerId, assistance_agreement_id: assistanceId }]);
  for (const line of earned) assert.deepEqual({ lineId: line.lineId, ...(await lineState(line.lineId)) }, line, "the old lines never wait on the new work");
});

// --- R2-101: completions -----------------------------------------------------------------------------------------------------

test("R2-101 (example 15): a parent-stage STAGE completion reported by the preparation-completion fake leaves the line ACCRUED_PENDING, and the FINAL completion 720 hours later with funds available makes it ELIGIBLE in the ELIGIBILITY sweep", async () => {
  // the composition binds the platform's delivered authorization (D10-BIND-1); this world injects the port's labelled fake instead
  const composed = createCommissionService({ assembly: { units: cw.pools.units }, environment: "LOCAL", clock, ids });
  assert.ok(composed.runtime.completions instanceof AuthorizationDeliveryCompletionSource);
  assert.equal(cw.service.runtime.completions.binding, "CONTRACT_FAKE");
  const { s } = await acquired("ex15");
  const p = await purchase(cw, s, "ex15");
  await dispatch();
  const [line] = await linesOf(cw, p.authorizationId);
  assert.ok(line !== undefined);
  await fundsAtProvider(p, "INSTANT");
  // B08 delivers the parent stage's package; the staged purchase's port reports a STAGE completion only
  cw.completions.record({ agencyId: s.agency.agencyId, captureId: p.captureId, kind: "STAGE", stageRef: "parent-stage", completedAt: clock.now(), source: "STAGED_PREPARATION" });
  const delivered = await deliveredByTheExecutionPackage(cw, p.authorizationId, s.agency.agencyId);
  assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, delivered)), "APPLIED");
  await dispatch();
  const completionsOf = async () =>
    (await oracleRows<{ kind: string; stage_ref: string | null; source: string }>(cw, "SELECT kind, stage_ref, source FROM kauro.purchase_completions WHERE authorization_id = $1 ORDER BY completed_at, kind", [p.authorizationId])).map((c) => [c.kind, c.stage_ref, c.source]);
  assert.deepEqual(await completionsOf(), [["STAGE", "parent-stage", "STAGED_PREPARATION"]]);
  assert.equal((await lineState(line.line_id)).state, "ACCRUED_PENDING");
  // a STAGE starts nothing: forty days on, the line is still pending
  await sweep(cw.ahead(960 * HOUR), "ELIGIBILITY");
  assert.equal((await lineState(line.line_id)).state, "ACCRUED_PENDING", "no eligibility clock without a FINAL completion");

  // the dependent stage is produced and verified: the FINAL completion
  const finalAt = clock.now();
  cw.completions.record({ agencyId: s.agency.agencyId, captureId: p.captureId, kind: "FINAL", completedAt: finalAt, source: "STAGED_PREPARATION" });
  await sweep(cw.ahead(720 * HOUR - 60), "ELIGIBILITY");
  assert.deepEqual(await completionsOf(), [["STAGE", "parent-stage", "STAGED_PREPARATION"], ["FINAL", null, "STAGED_PREPARATION"]]);
  assert.equal((await lineState(line.line_id)).state, "ACCRUED_PENDING", "a minute before 720 hours it is not due");
  await sweep(cw.ahead(720 * HOUR + 60), "ELIGIBILITY");
  const eligible = await oracleRows<{ state: string; eligible_at: Date }>(cw, "SELECT state, eligible_at FROM kauro.commission_lines WHERE line_id = $1", [line.line_id]);
  assert.deepEqual(eligible.map((l) => [l.state, l.eligible_at.toISOString()]), [["ELIGIBLE", new Date(Date.parse(finalAt) + 720 * HOUR * 1000).toISOString()]]);
  // the fake's call log: the commission service asked for this purchase's completions in its own SERVICE units of work
  assert.ok(cw.completions.calls.filter((c) => c.identity === `${s.agency.agencyId}/${p.captureId}`).every((c) => c.operation === "COMPLETIONS_OF SERVICE"));
  assert.ok(cw.completions.calls.filter((c) => c.identity === `${s.agency.agencyId}/${p.captureId}`).length >= 3);
});

// --- R2-127: QUOTE_EXPIRY ------------------------------------------------------------------------------------------------------

test("R2-127: the QUOTE_EXPIRY sweep expires a founding quote with nothing in flight and releases its slot; with an uncertain capture it holds the reservation in RECONCILIATION_HOLD until the capture consumes the slot or a proved no-capture releases it", async () => {
  const units = commercialUnits(cw.h);
  const founding = async (label: string) => {
    const s = await sellingAgency(cw, label);
    const plan = await approvedPlan(cw, s, label);
    const issued = await foundingQuote(cw.h, units, { agency: s.agency, planId: plan.planId as PlanId, issuerRef: cw.pw.issuerRef, profileId: s.profileId });
    return { s, issued, reservation: issued.eligibility.reservation! };
  };
  const quoteState = async (quoteId: string) => (await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.quotes WHERE quote_id = $1", [quoteId]))[0]!.state;
  const reservation = async (id: string) => (await oracleRows<{ state: string; release_reason: string | null; slot_no: number }>(cw, "SELECT state, release_reason, slot_no FROM kauro.founding_slot_reservations WHERE reservation_id = $1", [id]))[0]!;
  const slot = async (no: number) => (await oracleRows<{ held: boolean; live_reservation_id: string | null }>(cw, "SELECT held, live_reservation_id FROM kauro.founding_slots WHERE policy_version = 'R2-INITIAL' AND slot_no = $1", [no]))[0]!;
  const pastExpiry = () => sweep(cw.ahead(336 * HOUR + 60), "QUOTE_EXPIRY");

  // nothing in flight: past its price expiry the quote EXPIRES and its slot is free again
  const free = await founding("r127-free");
  assert.equal(free.reservation.slotNo, 1);
  await sweep(cw.service, "QUOTE_EXPIRY");
  assert.equal((await reservation(free.reservation.reservationId)).state, "RESERVED", "before its end the reservation is nobody's work");
  await pastExpiry();
  assert.equal(await quoteState(free.issued.quote.quoteId), "EXPIRED");
  assert.deepEqual(await reservation(free.reservation.reservationId), { state: "RELEASED", release_reason: "QUOTE_EXPIRED", slot_no: 1 });
  assert.deepEqual(await slot(1), { held: false, live_reservation_id: null });
  const expired = await oracleRows<{ actor_kind: string; actor_id: string }>(cw, "SELECT actor_kind, actor_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'quote.expired.v1'", [free.issued.quote.quoteId]);
  assert.deepEqual(expired, [{ actor_kind: "SERVICE", actor_id: "commission-service" }]);

  // two checkouts in flight (the order CREATING, its CREATE_ORDER attempt DISPATCHING): the quote cannot expire, the reservation is held
  const consumed = await founding("r127-consumed");
  const released = await founding("r127-released");
  assert.deepEqual([consumed.reservation.slotNo, released.reservation.slotNo], [1, 2], "the freed slot is taken again in ascending order");
  const consumedCheckout = await checkoutOf(cw, consumed.s, await quoteFactsOf(cw, consumed.s, consumed.issued.quote.quoteId), { inFlight: true });
  const releasedCheckout = await checkoutOf(cw, released.s, await quoteFactsOf(cw, released.s, released.issued.quote.quoteId), { inFlight: true });
  await pastExpiry();
  for (const r of [consumed, released]) {
    assert.equal(await quoteState(r.issued.quote.quoteId), "ACCEPTED_FOR_CHECKOUT", "a quote whose payment is in flight does not expire");
    assert.equal((await reservation(r.reservation.reservationId)).state, "RECONCILIATION_HOLD");
    assert.deepEqual(await slot(r.reservation.slotNo), { held: true, live_reservation_id: r.reservation.reservationId }, "a held reservation keeps its slot");
  }
  // the capture completes: the purchase consumes the held slot, which is never freed again
  await captureOf(cw, consumed.s, await providerCreated(cw, consumedCheckout));
  assert.deepEqual(await reservation(consumed.reservation.reservationId), { state: "CONSUMED", release_reason: null, slot_no: 1 });
  // the other provider order was created and nothing was captured: the next pass proves nothing is in flight, expires and releases
  await providerCreated(cw, releasedCheckout);
  await pastExpiry();
  assert.equal(await quoteState(released.issued.quote.quoteId), "EXPIRED");
  assert.deepEqual(await reservation(released.reservation.reservationId), { state: "RELEASED", release_reason: "QUOTE_EXPIRED", slot_no: 2 });
  assert.deepEqual(await slot(2), { held: false, live_reservation_id: null });
  assert.deepEqual(await reservation(consumed.reservation.reservationId), { state: "CONSUMED", release_reason: null, slot_no: 1 }, "a consumed slot is never freed");
  assert.equal(await quoteState(consumed.issued.quote.quoteId), "ACCEPTED_FOR_CHECKOUT", "the paid quote keeps its purchase");
});

// --- R2-137, R2-138: first designation and the subsequent cutoff ---------------------------------------------------------------

test("R2-137 (examples 9 and 10): P confirmed first keeps sequence 1 and its 1000-bps pool; Q, whose authenticated provider completion is earlier but observed later, is sequence 2 at 400 bps inside the window — never a second 1000-bps pool — and a provider completion after its own confirmation is held PROVIDER_TIME_UNVERIFIED", async () => {
  const PAYMENT_POOL = `${PAYMENT_APPLICATION_NAME}-service`;
  // two projects X and Y of one agency, ordered in that order; in each interleaving one reconciliation designates its purchase and is
  // held at the designation before COMMIT while the other waits on the agency's recurrence lock — X first, then Y first. The one
  // confirmed first is P; the one that waited is Q, whose provider completion is the earlier one (reported, as example 10 has it, late)
  for (const interleaving of ["X_FIRST", "Y_FIRST"] as const) {
    const label = `r137-${interleaving === "X_FIRST" ? "x" : "y"}`;
    const { s } = await acquired(label);
    const checkoutX = await checkoutOf(cw, s, await fixtureQuote(cw, s, await approvedPlan(cw, s, `${label}-X`)));
    const checkoutY = await checkoutOf(cw, s, await fixtureQuote(cw, s, await approvedPlan(cw, s, `${label}-Y`)));
    const [first, second] = interleaving === "X_FIRST" ? [checkoutX, checkoutY] : [checkoutY, checkoutX];
    // both provider completions after both orders were created (plausible), Q's ten milliseconds before P's
    const ordered = await oracleRows<{ at: Date }>(cw, "SELECT max(created_at) AS at FROM kauro.payment_orders WHERE order_id = ANY ($1::uuid[])", [[checkoutX.orderId, checkoutY.orderId]]);
    const base = ordered[0]!.at.getTime() + 1;
    const providerQ = new Date(base + 10).toISOString();
    const providerP = new Date(base + 20).toISOString();
    const pHeld = barrier();
    const pAtDesignation = barrier();
    const p = handled(captureOf(cw, s, first, { providerCompletedAt: providerP, beforeCommit: async () => { pAtDesignation.open(); await pHeld.wait; } }));
    await pAtDesignation.wait;
    const q = handled(captureOf(cw, s, second, { providerCompletedAt: providerQ }));
    const waiting = await waitForLockWait(cw.h.oracle, PAYMENT_POOL, "commercial_authorizations");
    assert.ok(waiting > 0, `${interleaving}: Q's designation waits on P's, observed in pg_stat_activity`);
    pHeld.open();
    const P = await p;
    const Q = await q;
    // a third purchase whose provider completion is after its own confirmation: implausible, never guessed
    const R = await purchase(cw, s, `${label}-R`, { providerCompletedAt: new Date(Date.now() + HOUR * 1000).toISOString() });

    const pEvent = await eventOf(cw, P.captureId, "capture.completed.v1");
    const qEvent = await eventOf(cw, Q.captureId, "capture.completed.v1");
    if (interleaving === "X_FIRST") {
      // the dispatcher delivers the completions in the order they were recorded: P's first
      const pass = await dispatch();
      const seen = pass.deliveries.filter((d) => d.eventId === pEvent || d.eventId === qEvent);
      assert.deepEqual(seen.map((d) => [d.eventId, d.outcome]), [[pEvent, "APPLIED"], [qEvent, "APPLIED"]]);
    } else {
      // the late observation: COMMISSIONS receives Q's completion before P's
      assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, qEvent)), "APPLIED");
      const pass = await dispatch();
      const seen = new Map(pass.deliveries.filter((d) => d.eventId === pEvent || d.eventId === qEvent).map((d) => [d.eventId, d.outcome]));
      assert.deepEqual([seen.get(pEvent), seen.get(qEvent)], ["APPLIED", "DUPLICATE"]);
    }
    assert.deepEqual([(await purchaseInstants(P)).seq, (await purchaseInstants(Q)).seq], [1, 2]);
    assert.deepEqual([(await purchaseInstants(Q)).provider, (await purchaseInstants(P)).provider], [providerQ, providerP], "each provider completion recorded as reported, Q's the earlier");
    assert.deepEqual(poolShape(await poolsOf(cw, P.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "97125", pool: FIRST_POOL }]);
    assert.deepEqual(poolShape(await poolsOf(cw, Q.authorizationId)), [{ source: "ACQUISITION", rateKind: "REPEAT", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
    assert.deepEqual((await linesOf(cw, Q.authorizationId)).map((l) => l.state), ["ACCRUED_PENDING"]);
    assert.deepEqual(await oracleRows(cw, "SELECT count(*)::int AS n FROM kauro.commission_pools WHERE agency_id = $1 AND rate_kind = 'FIRST'", [s.agency.agencyId]), [{ n: 1 }], "never a second 1000-bps pool");
    // R: the repeat rate, the only one the cutoff can grant, born HELD under a hold of its whole amount
    assert.deepEqual(poolShape(await poolsOf(cw, R.authorizationId)), [{ source: "ACQUISITION", rateKind: "REPEAT", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
    const [held] = await linesOf(cw, R.authorizationId);
    assert.equal(held?.state, "HELD");
    const holds = await oracleRows<{ reason: string; amount_cents: string; state: string; review_at: Date; opened_at: Date }>(cw, "SELECT reason, amount_cents::text, state, review_at, opened_at FROM kauro.commission_holds WHERE line_id = $1", [held!.line_id]);
    assert.deepEqual(holds.map((h) => [h.reason, h.amount_cents, h.state]), [["PROVIDER_TIME_UNVERIFIED", REPEAT_POOL, "OPEN"]]);
    assert.ok(holds[0]!.review_at.getTime() > holds[0]!.opened_at.getTime(), "with a review date");
  }
});

test("R2-138: two subsequent captures completed at the provider one second before and exactly at the local twelve-month endpoint, both notified a day later, accrue 400 bps for the first and no acquisition line for the second", async () => {
  // example 11: the first confirmation at 09:00 in America/Bogota; the window ends at 09:00 twelve calendar months later
  const { s } = await acquired("r138", { acceptedAt: "2027-09-01T12:00:00Z" });
  await purchase(cw, s, "r138-first", { confirmedAt: "2027-09-12T14:00:00Z", providerCompletedAt: "2027-09-12T13:55:00Z" });
  const before = await purchase(cw, s, "r138-before", { providerCompletedAt: "2028-09-12T13:59:59Z", confirmedAt: "2028-09-13T13:59:59Z" });
  const atEnd = await purchase(cw, s, "r138-end", { providerCompletedAt: "2028-09-12T14:00:00Z", confirmedAt: "2028-09-13T14:00:00Z" });
  await dispatch();
  const windows = await oracleRows<{ window_ends_at: Date }>(cw, "SELECT window_ends_at FROM kauro.commission_entitlements WHERE agency_id = $1", [s.agency.agencyId]);
  assert.deepEqual(windows.map((w) => w.window_ends_at.toISOString()), ["2028-09-12T14:00:00.000Z"]);
  assert.deepEqual(poolShape(await poolsOf(cw, before.authorizationId)), [{ source: "ACQUISITION", rateKind: "REPEAT", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
  assert.deepEqual((await linesOf(cw, before.authorizationId)).map((l) => [l.rate_bps, l.cumulative_entitlement_cents, l.state]), [[400, REPEAT_POOL, "ACCRUED_PENDING"]]);
  assert.deepEqual(await poolsOf(cw, atEnd.authorizationId), []);
  // the notification instants are recorded apart from the provider's, and neither moved the cutoff
  assert.deepEqual(await purchaseInstants(before), { confirmed: "2028-09-13T13:59:59.000Z", provider: "2028-09-12T13:59:59.000Z", seq: 2 });
  assert.deepEqual(await purchaseInstants(atEnd), { confirmed: "2028-09-13T14:00:00.000Z", provider: "2028-09-12T14:00:00.000Z", seq: 3 });
});

// --- R2-140 and the COMMISSIONS consumer ------------------------------------------------------------------------------------------

test("R2-140 (example 20): a second full capture of one obligation and a duplicated capture.completed.v1 delivery accrue nothing more — one pool per purchase and source, its basis the allocated service capped by the obligation", async () => {
  const { s } = await acquired("r140");
  const p = await purchase(cw, s, "r140");
  // the provider captures the same obligation a second time and reports it: recorded as excess, no second purchase
  const second = cw.pw.paypal.captureAtProvider(p.providerOrderId);
  const reported = await deliver(cw.pw, "PAYMENT.CAPTURE.COMPLETED", second);
  assert.equal(completed<WebhookAck>(reported.reply, 200).data.inboxState, "APPLIED");
  const captures = await oracleRows<{ capture_id: string; allocated_service_cents: string; excess_cents: string }>(cw, "SELECT capture_id, allocated_service_cents::text, excess_cents::text FROM kauro.capture_facts WHERE order_id = $1 ORDER BY created_at", [p.orderId]);
  assert.deepEqual(captures.map((c) => [c.allocated_service_cents, c.excess_cents]), [["97125", "0"], ["0", "97125"]]);
  const secondCapture = captures[1]!.capture_id;
  await dispatch();
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "97125", pool: FIRST_POOL }], "the basis is the obligation's allocated service, never twice");
  assert.deepEqual(await oracleRows(cw, "SELECT count(*)::int AS n FROM kauro.commission_pools WHERE capture_id = $1", [secondCapture]), [{ n: 0 }]);
  assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, await eventOf(cw, secondCapture, "capture.completed.v1"))), "NOT_APPLICABLE", "an excess capture is no qualifying purchase");
  // the same capture.completed.v1 delivered again, and the provider's own retry of its webhook: nothing more
  assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, await eventOf(cw, p.captureId, "capture.completed.v1"))), "DUPLICATE");
  const retried = await postWebhook(cw.pw, reported.bytes, reported.headers);
  assert.equal(completed<WebhookAck>(retried, 200).data.duplicate, true);
  assert.deepEqual(await oracleRows(cw, "SELECT count(*)::int AS n FROM kauro.inbox_records WHERE external_event_id = $1", [reported.eventId]), [{ n: 1 }]);
  assert.deepEqual(await oracleRows(cw, "SELECT count(*)::int AS pools, (SELECT count(*)::int FROM kauro.commission_lines WHERE agency_id = $1) AS lines FROM kauro.commission_pools WHERE agency_id = $1", [s.agency.agencyId]), [{ pools: 1, lines: 1 }]);
});

test("COMMISSIONS on capture.completed.v1, refund.completed.v1 and capture.reversed.v1: one pool and line per beneficiary per purchase, one adjustment per changed line and event, the first designation mirrored once into agencies.first_qualifying_capture_id with agency.first_purchase_designated.v1, and a replay adds nothing", async () => {
  const { s, a } = await acquired("consumer", { sellers: 2, shares: [6_000, 4_000] });
  const [major, minor] = [a.sellers[0]!.sellerId, a.sellers[1]!.sellerId];
  const p = await purchase(cw, s, "consumer");
  await dispatch();
  const linesBySeller = async () => new Map((await linesOf(cw, p.authorizationId)).map((l) => [l.seller_id, l]));
  // one pool, one line per beneficiary: 9713 split 6000/4000 → 5828 and 3885
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "97125", pool: FIRST_POOL }]);
  let lines = await linesBySeller();
  assert.deepEqual([lines.get(major)?.cumulative_entitlement_cents, lines.get(minor)?.cumulative_entitlement_cents, lines.size], ["5828", "3885", 2]);
  assert.deepEqual(
    (await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [a.claimIds])).map((c) => c.state),
    ["CONVERTED", "CONVERTED"],
    "the accepted claims converted at the first purchase",
  );
  const designation = async () =>
    (await oracleRows<{ first_qualifying_capture_id: string | null; version: string; events: number }>(cw, "SELECT first_qualifying_capture_id, version::text, (SELECT count(*)::int FROM kauro.domain_events e WHERE e.aggregate_id = a.agency_id AND e.event_type = 'agency.first_purchase_designated.v1') AS events FROM kauro.agencies a WHERE agency_id = $1", [s.agency.agencyId]))[0]!;
  const mirrored = await designation();
  assert.deepEqual([mirrored.first_qualifying_capture_id, mirrored.events], [p.captureId, 1]);
  const designated = await oracleRows<{ payload: Record<string, unknown>; actor_id: string }>(cw, "SELECT payload, actor_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'agency.first_purchase_designated.v1'", [s.agency.agencyId]);
  assert.deepEqual(designated, [{ payload: { agencyId: s.agency.agencyId, firstQualifyingCaptureId: p.captureId, firstAuthorizationId: p.authorizationId, firstProjectId: p.projectId }, actor_id: "commission-service" }]);

  // a partial refund of 25,000 of service: the basis 72,125, the pool 7213 (7212.5 rounded once), split 4328 / 2885
  const refundId = await refunded(s, p, 25_000n);
  const refundEvent = await eventOf(cw, refundId, "refund.completed.v1");
  await dispatch();
  lines = await linesBySeller();
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "72125", pool: "7213" }]);
  assert.deepEqual((await adjustmentsOf(cw, lines.get(major)!.line_id)).map((x) => [x.reason, x.direction, x.amount_cents, x.new_cumulative_entitlement_cents, x.source_event_id]), [["REFUND", "DECREASE", "1500", "4328", refundEvent]]);
  assert.deepEqual((await adjustmentsOf(cw, lines.get(minor)!.line_id)).map((x) => [x.reason, x.direction, x.amount_cents, x.new_cumulative_entitlement_cents, x.source_event_id]), [["REFUND", "DECREASE", "1000", "2885", refundEvent]]);

  // the provider reverses the capture: every line to zero and VOID
  await reversed(p);
  const reversalEvent = await eventOf(cw, p.captureId, "capture.reversed.v1");
  await dispatch();
  lines = await linesBySeller();
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "0", pool: "0" }]);
  assert.deepEqual([...lines.values()].map((l) => [l.cumulative_entitlement_cents, l.net_service_basis_cents, l.state]), [["0", "0", "VOID"], ["0", "0", "VOID"]]);
  assert.deepEqual((await adjustmentsOf(cw, lines.get(major)!.line_id)).map((x) => [x.reason, x.amount_cents, x.source_event_id]), [["REFUND", "1500", refundEvent], ["REVERSAL", "4328", reversalEvent]]);
  assert.deepEqual((await adjustmentsOf(cw, lines.get(minor)!.line_id)).map((x) => [x.reason, x.amount_cents, x.source_event_id]), [["REFUND", "1000", refundEvent], ["REVERSAL", "2885", reversalEvent]]);

  // a replay of every delivery adds nothing
  const census = async () => oracleRows(cw, "SELECT (SELECT count(*)::int FROM kauro.commission_pools WHERE agency_id = $1) AS pools, (SELECT count(*)::int FROM kauro.commission_lines WHERE agency_id = $1) AS lines, (SELECT count(*)::int FROM kauro.commission_adjustments WHERE agency_id = $1) AS adjustments, (SELECT count(*)::int FROM kauro.commission_entitlements WHERE agency_id = $1) AS entitlements", [s.agency.agencyId]);
  const before = await census();
  for (const eventId of [await eventOf(cw, p.captureId, "capture.completed.v1"), refundEvent, reversalEvent]) {
    assert.equal(await cw.service.consumer.handle(await deliveryOf(cw, eventId)), "DUPLICATE");
  }
  assert.deepEqual(await census(), before);
  assert.deepEqual(before, [{ pools: 1, lines: 2, adjustments: 4, entitlements: 2 }]);
  assert.deepEqual(await designation(), mirrored, "the designation is mirrored once");
});

test("B09-R2: a capture's completion, refund completion and reversal delivered to COMMISSIONS in every order end with the same cumulative entitlements, one adjustment per changed line and event, and every line at zero basis after the reversal", async () => {
  const { s } = await acquired("b09r2");
  const orders = ["CRV", "CVR", "RCV", "RVC", "VCR", "VRC"] as const;
  const purchases: Array<{ readonly order: (typeof orders)[number]; readonly p: Purchase; readonly events: Readonly<Record<"C" | "R" | "V", string>> }> = [];
  for (const order of orders) {
    const p = await purchase(cw, s, `b09r2-${order}`);
    const refundId = await refunded(s, p, 25_000n);
    await reversed(p);
    purchases.push({ order, p, events: { C: await eventOf(cw, p.captureId, "capture.completed.v1"), R: await eventOf(cw, refundId, "refund.completed.v1"), V: await eventOf(cw, p.captureId, "capture.reversed.v1") } });
  }
  // the three facts of each capture exist; COMMISSIONS receives them in each of the six orders (the outbox delivers at least once, in any order)
  for (const { order, events } of purchases) {
    for (const step of order) await cw.service.consumer.handle(await deliveryOf(cw, events[step as "C" | "R" | "V"]));
  }
  // the oracle: S = 97,125 refunded by 25,000 to 72,125, then reversed. The first (CRV) is the agency's first purchase at 1000 bps
  // (9713 → 7213 → 0); the others repeats at 400 bps (3885 → 2885 → 0). A refund delivered after the reversal changes nothing.
  const expected: Readonly<Record<(typeof orders)[number], ReadonlyArray<ReadonlyArray<string>>>> = {
    CRV: [["R", "REFUND", "2500", "7213"], ["V", "REVERSAL", "7213", "0"]],
    CVR: [["V", "REVERSAL", "3885", "0"]],
    RCV: [["R", "REFUND", "1000", "2885"], ["V", "REVERSAL", "2885", "0"]],
    RVC: [["R", "REFUND", "1000", "2885"], ["V", "REVERSAL", "2885", "0"]],
    VCR: [["V", "REVERSAL", "3885", "0"]],
    VRC: [["V", "REVERSAL", "3885", "0"]],
  };
  const outcome = async () => {
    const out: Record<string, unknown> = {};
    for (const { order, p, events } of purchases) {
      const [line, ...others] = await linesOf(cw, p.authorizationId);
      assert.equal(others.length, 0, `${order}: one line`);
      const sourceOf = new Map(Object.entries(events).map(([k, v]) => [v, k]));
      out[order] = {
        pool: poolShape(await poolsOf(cw, p.authorizationId)).map((x) => [x.basis, x.pool]),
        line: [line!.cumulative_entitlement_cents, line!.net_service_basis_cents, line!.state],
        adjustments: (await adjustmentsOf(cw, line!.line_id)).map((x) => [sourceOf.get(x.source_event_id) ?? "?", x.reason, x.amount_cents, x.new_cumulative_entitlement_cents]),
      };
    }
    return out;
  };
  const after = await outcome();
  for (const order of orders) {
    assert.deepEqual(after[order], { pool: [["0", "0"]], line: ["0", "0", "VOID"], adjustments: expected[order] }, `${order}: the same zero entitlement, one adjustment per changed line and event`);
  }
  // the dispatcher delivers every one of them again: nothing changes
  await dispatch();
  assert.deepEqual(await outcome(), after);
});

// --- D-LEASE-3: the dispatcher's lease -------------------------------------------------------------------------------------------

test("D-LEASE-3: the COMMISSIONS dispatcher's OUTBOX_DISPATCH lease is held against a second dispatcher, is resumed under the next fence by its former owner once it expired, and a dispatcher whose heartbeat is refused settles nothing more", async () => {
  await dispatch();
  const { s } = await acquired("lease");
  const first = await purchase(cw, s, "lease-1");
  const second = await purchase(cw, s, "lease-2");
  const ours = [await eventOf(cw, first.captureId, "capture.completed.v1"), await eventOf(cw, second.captureId, "capture.completed.v1")];
  const lease = async () => (await oracleRows<{ owner_id: string; fence: string }>(cw, "SELECT owner_id, fence::text FROM kauro.leases WHERE resource_kind = 'OUTBOX_DISPATCH' AND resource_id = $1", [commissionLeaseResource()]))[0]!;
  const records = async () => oracleRows<{ event_id: string; state: string; attempts: number }>(cw, "SELECT event_id, state, attempts FROM kauro.outbox_records WHERE consumer = 'COMMISSIONS' AND event_id = ANY ($1::uuid[]) ORDER BY event_id", [ours]);
  const a = cw.service.dispatcherOf();
  const b = cw.service.dispatcherOf();
  // the service's own dispatcher held the lease; once it expired, A takes it under the next fence
  const before = Number((await lease()).fence);
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  const hold = cw.holds.arm("DELIVERY_BEFORE_SETTLE");
  const passA = handled(a.runOnce({ limit: 100 }));
  await hold.reached;
  assert.deepEqual(await lease(), { owner_id: a.ownerId, fence: String(before + 1) });
  assert.deepEqual((await records()).map((r) => r.state), ["CLAIMED", "CLAIMED"], "A claimed both records and settled none yet");

  // held against a second dispatcher: B claims nothing
  const held = await b.runOnce({ limit: 100 });
  assert.deepEqual([held.held, held.deliveries.length], [true, 0]);
  assert.deepEqual(await lease(), { owner_id: a.ownerId, fence: String(before + 1) });

  // A's lease and claims expire while it is stalled: B takes the lease over under the next fence and settles both records
  cw.clock.advance(300_000);
  const takeover = await b.runOnce({ limit: 100 });
  assert.deepEqual([takeover.held, takeover.fence], [false, before + 2]);
  const bOutcomes = takeover.deliveries.filter((d) => ours.includes(d.eventId)).map((d) => d.outcome).sort();
  assert.deepEqual(bOutcomes, ["APPLIED", "DUPLICATE"], "the effect A completed is not applied twice");
  const settledByB = await records();
  assert.deepEqual(settledByB.map((r) => r.state), ["DELIVERED", "DELIVERED"]);

  // A resumes: its heartbeat under the old fence is refused and it settles nothing more
  hold.release();
  const resultA = await passA;
  assert.deepEqual(resultA.deliveries.map((d) => d.outcome), ["FENCED"]);
  assert.deepEqual(await records(), settledByB, "A changed no record after it lost the lease");
  assert.deepEqual(await lease(), { owner_id: b.ownerId, fence: String(before + 2) });

  // B's lease expires; its former owner A resumes it under the next fence
  cw.clock.advance(300_000);
  const resumed = await a.runOnce({ limit: 100 });
  assert.deepEqual([resumed.held, resumed.fence], [false, before + 3]);
  assert.deepEqual(await lease(), { owner_id: a.ownerId, fence: String(before + 3) });
  assert.deepEqual(poolShape(await poolsOf(cw, second.authorizationId)), [{ source: "ACQUISITION", rateKind: "REPEAT", rateBps: 400, basis: "97125", pool: REPEAT_POOL }]);
  // A stops; once its lease expires the service's own dispatcher resumes the consumer under the next fence
  cw.clock.advance((DISPATCH_LEASE_SECONDS + 1) * 1000);
  assert.equal((await cw.service.dispatcher.runOnce({ limit: 100 })).fence, before + 4);
});

// --- example 14, example 19 -----------------------------------------------------------------------------------------------------

test("example 14: capture.funds_observed.v1 HELD moves an otherwise due line HELD FUNDS_HELD with a review date and blocks no unrelated line, and AVAILABLE releases it in the ELIGIBILITY sweep", async () => {
  const { s } = await acquired("ex14");
  const heldFunds = await purchase(cw, s, "ex14-held");
  const clear = await purchase(cw, s, "ex14-clear");
  await dispatch();
  const [heldLine] = await linesOf(cw, heldFunds.authorizationId);
  const [clearLine] = await linesOf(cw, clear.authorizationId);
  // both purchases' preparation completed more than thirty days ago (their FINAL completions)
  const finalAt = new Date(Date.now() - 721 * HOUR * 1000).toISOString() as never;
  for (const p of [heldFunds, clear]) cw.completions.record({ agencyId: s.agency.agencyId, captureId: p.captureId, kind: "FINAL", completedAt: finalAt, source: "AUTHORIZATION_DELIVERY" });
  await sweep(cw.service, "ELIGIBILITY");
  assert.deepEqual([(await lineState(heldLine!.line_id)).state, (await lineState(clearLine!.line_id)).state], ["ACCRUED_PENDING", "ACCRUED_PENDING"], "due, but no funds observed yet");

  // the provider holds one capture's proceeds and makes the other's available
  await fundsAtProvider(heldFunds, "DELAYED");
  await fundsAtProvider(clear, "INSTANT");
  await dispatch();
  assert.equal((await lineState(heldLine!.line_id)).state, "HELD");
  const holds = await oracleRows<{ hold_id: string; reason: string; amount_cents: string; state: string; review_at: Date; opened_at: Date }>(cw, "SELECT hold_id, reason, amount_cents::text, state, review_at, opened_at FROM kauro.commission_holds WHERE line_id = $1", [heldLine!.line_id]);
  assert.deepEqual(holds.map((h) => [h.reason, h.amount_cents, h.state]), [["FUNDS_HELD", FIRST_POOL, "OPEN"]]);
  assert.ok(holds[0]!.review_at.getTime() > holds[0]!.opened_at.getTime(), "with a review date");
  await sweep(cw.service, "ELIGIBILITY");
  assert.equal((await lineState(clearLine!.line_id)).state, "ELIGIBLE", "the unrelated line is not blocked");
  assert.equal((await lineState(heldLine!.line_id)).state, "HELD");

  // the provider releases the proceeds: the ELIGIBILITY sweep releases the hold and the line becomes ELIGIBLE
  await fundsAtProvider(heldFunds, "INSTANT");
  await dispatch();
  await sweep(cw.service, "ELIGIBILITY");
  assert.deepEqual((await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.commission_holds WHERE hold_id = $1", [holds[0]!.hold_id])).map((h) => h.state), ["RELEASED"]);
  assert.equal((await lineState(heldLine!.line_id)).state, "ELIGIBLE");
});

test("example 19: a tax-inclusive 112000-cent capture of a 100000-cent service line accrues a 10000-cent first pool on the service only, and a gross partial refund changes the basis by its service component alone", async () => {
  // synthetic illustrative inputs (example 19): a labelled schedule of this cluster only and a reviewed 12% rule
  await recordSyntheticSchedule(cw, "EXAMPLE-19-SYNTHETIC");
  const tax = { treatment: "DOMESTIC_TAXABLE", rule: "RATE_HALF_UP", rateBps: 1_200 } as const;
  const s = await sellingAgency(cw, "ex19", tax);
  const a = await claimsOn(cw, "ex19");
  await acceptAttribution(cw, s.agency.agencyId, a, [10_000]);
  const quote = await statedQuote(cw, s, await approvedPlan(cw, s, "ex19"), { policyVersion: "EXAMPLE-19-SYNTHETIC", serviceCents: 100_000n, tax, taxCents: 12_000n });
  const p = await captureOf(cw, s, await checkoutOf(cw, s, quote));
  assert.deepEqual(await oracleRows(cw, "SELECT amount_cents::text, allocated_service_cents::text, allocated_tax_cents::text FROM kauro.capture_facts WHERE capture_id = $1", [p.captureId]), [{ amount_cents: "112000", allocated_service_cents: "100000", allocated_tax_cents: "12000" }]);
  await dispatch();
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "100000", pool: "10000" }], "USD100 on the service, never USD112 on the total");

  // a gross refund of USD560: 50,000 of service and 6,000 of tax; the basis falls by the service component only
  const refundId = await refunded(s, p, 50_000n, 6_000n);
  const payload = (await oracleRows<{ payload: Record<string, unknown> }>(cw, "SELECT payload FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'refund.completed.v1'", [refundId]))[0]!.payload;
  assert.deepEqual([payload["serviceCents"], payload["taxCents"], payload["serviceBasisAfterCents"]], [50_000, 6_000, 50_000]);
  await dispatch();
  assert.deepEqual(poolShape(await poolsOf(cw, p.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "50000", pool: "5000" }]);
  const [line] = await linesOf(cw, p.authorizationId);
  assert.deepEqual((await adjustmentsOf(cw, line!.line_id)).map((x) => [x.reason, x.direction, x.amount_cents, x.new_cumulative_entitlement_cents, x.new_basis_cents]), [["REFUND", "DECREASE", "5000", "5000", "50000"]]);
});

// --- the window sweeps (they stand up to a year ahead: last) -----------------------------------------------------------------

test("the CLAIM_WINDOWS, ENTITLEMENT_WINDOWS and ACCRUAL_RECONCILIATION sweeps: claims lapse at their deadline with no first purchase, entitlements expire at window end with earned lines unaffected, and an acceptance after the first purchase gains its missing lines once", async () => {
  // the claim was submitted before the first order but accepted only after the first purchase
  const late = await sellingAgency(cw, "late");
  const lateClaims = await claimsOn(cw, "late");
  const first = await purchase(cw, late, "late-first");
  await dispatch();
  assert.deepEqual(await poolsOf(cw, first.authorizationId), [], "no frozen allocation at the first purchase: nothing to accrue yet");
  await acceptAttribution(cw, late.agency.agencyId, lateClaims, [10_000]);
  await sweep(cw.service, "ACCRUAL_RECONCILIATION");
  assert.deepEqual((await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.attribution_claims WHERE claim_id = $1", [lateClaims.claimIds[0]])).map((c) => c.state), ["CONVERTED"]);
  assert.deepEqual(poolShape(await poolsOf(cw, first.authorizationId)), [{ source: "ACQUISITION", rateKind: "FIRST", rateBps: 1000, basis: "97125", pool: FIRST_POOL }]);
  const [earned] = await linesOf(cw, first.authorizationId);
  assert.equal(earned?.cumulative_entitlement_cents, FIRST_POOL);
  const census = async () => oracleRows(cw, "SELECT (SELECT count(*)::int FROM kauro.commission_pools WHERE agency_id = $1) AS pools, (SELECT count(*)::int FROM kauro.commission_lines WHERE agency_id = $1) AS lines, (SELECT count(*)::int FROM kauro.commission_entitlements WHERE agency_id = $1) AS entitlements", [late.agency.agencyId]);
  const once = await census();
  const cycle = await cw.service.runCycle();
  assert.deepEqual(cycle.map((r) => r.sweep), ["QUOTE_EXPIRY", "ACCRUAL_RECONCILIATION", "CLAIM_WINDOWS", "ENTITLEMENT_WINDOWS", "ELIGIBILITY", "PERIODS"]);
  assert.deepEqual(cycle.flatMap((r) => r.items.filter((i) => i.outcome.startsWith("FAILED"))), [], "every item of the cycle settled");
  assert.deepEqual(await census(), once, "a second pass gains nothing");
  assert.deepEqual(once, [{ pools: 1, lines: 1, entitlements: 1 }]);

  // claims with no first purchase: one still under review, one accepted for an agency that never bought
  const idle = await sellingAgency(cw, "idle");
  const pending = await claimsOn(cw, "lapse-pending");
  const accepted = await claimsOn(cw, "lapse-accepted");
  await acceptAttribution(cw, idle.agency.agencyId, accepted, [10_000]);
  const claimStates = async () => (await oracleRows<{ claim_id: string; state: string }>(cw, "SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[]) ORDER BY claim_id", [[pending.claimIds[0], accepted.claimIds[0]]])).map((c) => c.state);
  await sweep(cw.ahead(2_160 * HOUR - 60), "CLAIM_WINDOWS");
  assert.deepEqual((await claimStates()).sort(), ["ACCEPTED", "SUBMITTED"], "a minute before 2160 hours nothing lapses");
  await sweep(cw.ahead(2_160 * HOUR + 60), "CLAIM_WINDOWS");
  assert.deepEqual(await claimStates(), ["EXPIRED", "EXPIRED"]);

  // the entitlement's window ends twelve calendar months after the first confirmation; its earned line is unaffected
  const ends = (await oracleRows<{ window_ends_at: Date; entitlement_id: string }>(cw, "SELECT window_ends_at, entitlement_id FROM kauro.commission_entitlements WHERE agency_id = $1", [late.agency.agencyId]))[0]!;
  const toEnd = Math.ceil((ends.window_ends_at.getTime() - Date.now()) / 1000);
  const lineBefore = await lineState(earned!.line_id);
  await sweep(cw.ahead(toEnd - 60), "ENTITLEMENT_WINDOWS");
  assert.deepEqual((await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.commission_entitlements WHERE entitlement_id = $1", [ends.entitlement_id])).map((e) => e.state), ["ACTIVE"]);
  await sweep(cw.ahead(toEnd + 60), "ENTITLEMENT_WINDOWS");
  assert.deepEqual((await oracleRows<{ state: string }>(cw, "SELECT state FROM kauro.commission_entitlements WHERE entitlement_id = $1", [ends.entitlement_id])).map((e) => e.state), ["EXPIRED"]);
  assert.deepEqual(await lineState(earned!.line_id), lineBefore, "the earned line is unaffected");
});
