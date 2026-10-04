// The tier-1 GAPs 23 to 28 of the B10 failure matrix on the qualifying-purchase trigger, the claim conversion and the entitlement creation
// (docs/design/B10-failure-matrix.md "GAP list, by risk" -> "Tier 1"; items TRG_PAR, TRG_CRASH, CONV_RACE, CLAIM_TAIL, CONV_PAR, CONV_CRASH),
// each a cell of the common fault harness (docs/design/FAULT-HARNESS.md). The trigger cells run the REAL webhook (CMD030) and the REAL
// reconciler of the payment service over the payment service's own pool: its commerce unit of work is bounded by the cell's commit points and
// its repositories traced (test/fault-support.ts wrapCommerce). A fault inside the designation trigger itself (one INSERT of the original
// authorization) is raised by a test trigger the superuser installs on the next table the designation writes (SQLSTATE KT001), and the
// cell proves what the database had done when it fired (the message carries what the transaction then saw). PostgreSQL 17 through the
// runtime login roles; the superuser only reads, installs the fault triggers and holds locks. Nothing sleeps.
//
// The founding cohort's three slots serve this whole file: the cells that need a live reservation run first (TRG_PAR T2 and T3, TRG_CRASH
// RETRY), the others run without one and assert that they have none.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { crashedAt, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import type { WebhookAck } from "@kauro/application";
import { deliver } from "./payment-support.js";
import { agentOf, integrationWorld, oracleRows, orderedThrough, planOf, quoted, type IntegrationWorld } from "./integration-support.js";
import { acceptAttribution, claimsOn, deliveryOf, eventOf, linesOf, poolsOf, purchase, sellingAgency, type Attribution, type Purchase, type Selling } from "./commission-support.js";
import type { SqlStep } from "./fault-support.js";
import { createCommissionService, type CommissionService } from "../src/index.js";
import type { CommissionSweepName } from "../src/commissions/sweeps.js";
import { completed, ids } from "./support.js";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  await installDbFaults();
  svc = createCommissionService({ assembly: { units: iw.faults.wrap(iw.pools.units), completions: iw.completions }, environment: "LOCAL", clock: iw.clock, ids, onBackgroundFailure: (subject, error) => void failures.push({ subject, error }) });
});
after(async () => {
  await iw.stop();
});

// --- the database faults the trigger cells raise inside the designation ---------------------------------------------------------------

/**
 * Two test triggers, installed by the superuser on the tables the designation (kauro.designate_qualifying_purchase) writes after its first:
 * the designation upserts the agency's recurrence (the confirmation sequence), then inserts the qualifying purchase, then consumes the
 * founding reservation. A row of kauro.b10_db_faults arms one: AFTER_RECURRENCE fires on the purchase insert (the recurrence is upserted,
 * the purchase is not written), AFTER_PURCHASE on the reservation's consumption (the purchase is written, the reservation is not yet
 * CONSUMED). What each saw is in its message, which the cell asserts.
 */
async function installDbFaults(): Promise<void> {
  const q = (sql: string): Promise<unknown> => iw.h.oracle.query(sql);
  await q("CREATE TABLE kauro.b10_db_faults (step text PRIMARY KEY)");
  await q(`CREATE FUNCTION kauro.b10_fault_after_recurrence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM kauro.b10_db_faults WHERE step = 'AFTER_RECURRENCE') THEN
        RAISE EXCEPTION 'KAURO_FAULT AFTER_RECURRENCE recurrence=% purchases=%',
          coalesce((SELECT r.confirmation_count FROM kauro.agency_recurrence r WHERE r.agency_id = NEW.agency_id), 0),
          (SELECT count(*) FROM kauro.qualifying_purchases p WHERE p.authorization_id = NEW.authorization_id) USING ERRCODE = 'KT001';
      END IF;
      RETURN NEW;
    END $$`);
  await q("CREATE TRIGGER b10_fault_after_recurrence BEFORE INSERT ON kauro.qualifying_purchases FOR EACH ROW EXECUTE FUNCTION kauro.b10_fault_after_recurrence()");
  await q(`CREATE FUNCTION kauro.b10_fault_after_purchase() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM kauro.b10_db_faults WHERE step = 'AFTER_PURCHASE') THEN
        RAISE EXCEPTION 'KAURO_FAULT AFTER_PURCHASE recurrence=% purchases=% reservation=%',
          coalesce((SELECT r.confirmation_count FROM kauro.agency_recurrence r WHERE r.agency_id = NEW.agency_id), 0),
          (SELECT count(*) FROM kauro.qualifying_purchases p WHERE p.authorization_id = NEW.consumed_by_authorization_id), OLD.state USING ERRCODE = 'KT001';
      END IF;
      RETURN NEW;
    END $$`);
  await q(`CREATE TRIGGER b10_fault_after_purchase BEFORE UPDATE OF state ON kauro.founding_slot_reservations
    FOR EACH ROW WHEN (NEW.state = 'CONSUMED' AND OLD.state <> 'CONSUMED') EXECUTE FUNCTION kauro.b10_fault_after_purchase()`);
}
const armDbFault = (step: "AFTER_RECURRENCE" | "AFTER_PURCHASE"): Promise<unknown> => iw.h.oracle.query("INSERT INTO kauro.b10_db_faults (step) VALUES ($1)", [step]);
const disarmDbFaults = (): Promise<unknown> => iw.h.oracle.query("DELETE FROM kauro.b10_db_faults");

// --- one capture the provider made, not yet reported to the payment service ----------------------------------------------------------

interface Captured {
  readonly agencyId: string;
  readonly orderId: string;
  readonly providerCaptureId: string;
}

/** An agency with a quote, an order the provider captured: only the webhook (CMD030) that reports it is left. */
async function capturedAtProvider(label: string): Promise<Captured> {
  const a = await agentOf(iw, label);
  const quote = await quoted(iw, a, await planOf(iw, a, label, { units: 50_000 }));
  const order = await orderedThrough(iw, a, quote);
  iw.pw.paypal.approve(order.order.providerOrderId!);
  return { agencyId: a.s.agency.agencyId, orderId: order.order.orderId, providerCaptureId: iw.pw.paypal.captureAtProvider(order.order.providerOrderId!) };
}

interface Designation {
  readonly authorizations: number;
  readonly captures: number;
  readonly purchases: ReadonlyArray<number>;
  readonly recurrence: { readonly count: number; readonly firstAuthorizationId: string } | null;
  readonly reservations: ReadonlyArray<{ readonly state: string; readonly consumedBy: string | null }>;
  readonly slotsHeld: number;
  readonly orderState: string;
}

/** What the designation wrote for the agency, read by the superuser: the money/rights state a trigger cell asserts. */
async function designationOf(x: Captured): Promise<Designation> {
  const n = async (sql: string): Promise<number> => Number((await oracleRows<{ n: string }>(iw, sql, [x.agencyId]))[0]!.n);
  const recurrence = (await oracleRows<{ confirmation_count: number; first_authorization_id: string }>(iw, "SELECT confirmation_count, first_authorization_id FROM kauro.agency_recurrence WHERE agency_id = $1", [x.agencyId]))[0];
  return {
    authorizations: await n("SELECT count(*)::text AS n FROM kauro.commercial_authorizations WHERE agency_id = $1"),
    captures: await n("SELECT count(*)::text AS n FROM kauro.capture_facts WHERE agency_id = $1"),
    purchases: (await oracleRows<{ confirmation_seq: number }>(iw, "SELECT confirmation_seq FROM kauro.qualifying_purchases WHERE agency_id = $1 ORDER BY confirmation_seq", [x.agencyId])).map((p) => p.confirmation_seq),
    recurrence: recurrence === undefined ? null : { count: recurrence.confirmation_count, firstAuthorizationId: recurrence.first_authorization_id },
    reservations: (await oracleRows<{ state: string; consumed_by_authorization_id: string | null }>(iw, "SELECT state, consumed_by_authorization_id FROM kauro.founding_slot_reservations WHERE agency_id = $1", [x.agencyId])).map((r) => ({ state: r.state, consumedBy: r.consumed_by_authorization_id })),
    slotsHeld: await n("SELECT count(*)::text AS n FROM kauro.founding_slots WHERE live_agency_id = $1 AND held"),
    orderState: (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.payment_orders WHERE order_id = $1", [x.orderId]))[0]!.state,
  };
}
const inboxStates = async (eventId: string): Promise<string[]> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.inbox_records WHERE external_event_id = $1", [eventId])).map((r) => r.state);

/** The webhook (CMD030) the provider sends for the capture, routed through the cell's payment points; a failure the handler recorded (the application it will retry) is thrown. */
async function report(ctx: Pick<FaultContext, "points">, x: Captured, options: { readonly eventId?: string; readonly throwFailure?: boolean } = {}): Promise<{ readonly eventId: string; readonly inboxState: string }> {
  const seen = iw.pw.backgroundFailures.length;
  const delivery = await iw.faults.onPayment(ctx.points, () => deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", x.providerCaptureId, options.eventId === undefined ? {} : { eventId: options.eventId }));
  const ack = completed<WebhookAck>(delivery.reply, 200).data;
  
  if (options.throwFailure === true && iw.pw.backgroundFailures.length > seen) {
    const [failure] = iw.pw.backgroundFailures.splice(seen);
    throw failure!.error;
  }
  return { eventId: delivery.eventId, inboxState: ack.inboxState };
}
/** A recovery that is no fault cell's own operation: the payment service's inbox worker applies what the handler left RECEIVED. */
const recovered = async (): Promise<ReadonlyArray<{ readonly state: string }>> => (await iw.pw.service.runInboxPass()).applied;

/** A reservation the agency held before its designation is CONSUMED by it exactly once, an agency without one has none (the cohort's slots are the file's, see its head). */
function consumedOnce(before: Designation, after: Designation): void {
  assert.deepEqual(after.reservations.map((r) => r.state), before.reservations.map(() => "CONSUMED"), "the founding reservation, if the agency held one, is consumed once");
  if (before.reservations.length > 0) assert.equal(after.reservations[0]!.consumedBy, after.recurrence!.firstAuthorizationId, "by the designating authorization");
}

const FOUNDING_SLOT = (d: Designation, state: string): void => assert.deepEqual(d.reservations.map((r) => r.state), [state], "the quote's founding reservation");

// --- 23. TRG_PAR ---------------------------------------------------------------------------------------------------------------------
// The designation is one INSERT of the original authorization whose trigger writes, in this order: the agency's recurrence (sequence), the
// qualifying purchase, the founding reservation's consumption. (The matrix names the first two in the opposite order; the order is the trigger's
// own, migration 0028.) Each cell fails the reconciler's transaction at one step, proves what the database had done at that step, and
// asserts that the whole reconciler transaction is gone (authorization, capture, order, sequence, purchase, slot) and that the same capture
// then applies once.

// the cells with a live founding reservation first: the cohort has three slots (see the head of this file)
faultCell(
  {
    id: "TRG_PAR",
    step: "Qualifying-purchase trigger (reconciler transaction), a database failure after the purchase is inserted and before the founding reservation is consumed",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected between the purchase insert and the reservation consumption of the designation rolls back the whole reconciler transaction, the reservation stays RESERVED and its slot held by it; the same capture then makes one designation and one consumption",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-par-purchase");
    const eventId = "evt-trg-par-purchase";
    const first = await designationOf(x);
    FOUNDING_SLOT(first, "RESERVED");
    assert.deepEqual([first.slotsHeld, first.authorizations, first.purchases, first.recurrence], [1, 0, [], null]);
    await armDbFault("AFTER_PURCHASE");
    try {
      await ctx.partial("the reconciler failing after the purchase insert and before the reservation consumption", "db.fault.AFTER_PURCHASE", async () => {
        await report(ctx, x, { eventId, throwFailure: true });
      });
    } finally {
      await disarmDbFaults();
    }
    // the database had written the sequence and the purchase and the reservation was still RESERVED when it fired
    assert.equal(iw.faults.dbFaults.at(-1)?.message, "KAURO_FAULT AFTER_PURCHASE recurrence=1 purchases=1 reservation=RESERVED");
    assert.deepEqual(await designationOf(x), first, "the whole reconciler transaction rolled back: no purchase, no sequence, the reservation RESERVED and its slot held");
    assert.deepEqual(await inboxStates(eventId), ["RECEIVED"], "the delivery the handler could not apply stays RECEIVED");
    await recovered();
    assert.deepEqual(await inboxStates(eventId), ["APPLIED"], "the inbox worker applies that delivery");
    const done = await designationOf(x);
    assert.deepEqual([done.authorizations, done.purchases, done.recurrence?.count, done.slotsHeld], [1, [1], 1, 1]);
    assert.deepEqual(done.reservations, [{ state: "CONSUMED", consumedBy: done.recurrence!.firstAuthorizationId }], "one designation and one consumption, by that authorization");
  },
);

faultCell(
  {
    id: "TRG_PAR",
    step: "Qualifying-purchase trigger (reconciler transaction), a failure after the founding reservation is consumed and before the reconciler's COMMIT",
    fault: "partial",
    expect:
      "RACE (partial): a failure after the authorization insert (its designation trigger wrote the sequence, the purchase and the consumption) and before the reconciler COMMIT leaves the reservation RESERVED and no purchase; the same capture then makes one designation and one consumption",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-par-consumption");
    const eventId = "evt-trg-par-consumption";
    const first = await designationOf(x);
    FOUNDING_SLOT(first, "RESERVED");
    // the failure is the reconciler's own, raised at the point right after the authorization INSERT answered: the point passes only when the insert
    // (and so the whole designation trigger, consumption included) completed in this transaction
    const failure = await ctx.partial("the reconciler failing right after the authorization insert (the designation complete) and before the COMMIT", "pay.authorizations.issue.after", async () => {
      await report(ctx, x, { eventId, throwFailure: true });
    });
    assert.ok(failure !== undefined);
    assert.deepEqual(await designationOf(x), first, "the consumption, the purchase and the sequence are all rolled back with the reconciler's transaction");
    assert.deepEqual(await inboxStates(eventId), ["RECEIVED"], "the delivery the handler could not apply stays RECEIVED");
    await recovered();
    assert.deepEqual(await inboxStates(eventId), ["APPLIED"], "the inbox worker applies that delivery");
    const done = await designationOf(x);
    assert.deepEqual([done.authorizations, done.purchases, done.recurrence?.count, done.slotsHeld], [1, [1], 1, 1]);
    assert.deepEqual(done.reservations, [{ state: "CONSUMED", consumedBy: done.recurrence!.firstAuthorizationId }], "one designation and one consumption");
  },
);

faultCell(
  {
    id: "TRG_CRASH",
    step: "Qualifying-purchase trigger (reconciler transaction), the same capture confirmation delivered again",
    fault: "retry",
    expect: "DENY: the same capture confirmation delivered again (the same provider event, and another event of the provider for the same capture) inserts no second authorization, purchase, designation or consumption",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-retry");
    FOUNDING_SLOT(await designationOf(x), "RESERVED");
    const [one, two] = await ctx.sequentially(2, async () => report(ctx, x, { eventId: "evt-trg-retry-same" }));
    assert.equal(one!.status, "fulfilled");
    assert.equal(two!.status, "fulfilled");
    const once = await designationOf(x);
    assert.deepEqual([once.authorizations, once.captures, once.purchases, once.recurrence?.count, once.slotsHeld], [1, 1, [1], 1, 1]);
    assert.deepEqual(once.reservations, [{ state: "CONSUMED", consumedBy: once.recurrence!.firstAuthorizationId }]);
    assert.deepEqual(await inboxStates("evt-trg-retry-same"), ["APPLIED"], "one inbox record for the one provider event, applied once");
    // another event of the provider reporting the same capture (a new event id): the capture is already confirmed
    await ctx.attempt(() => report(ctx, x, { eventId: "evt-trg-retry-another" }));
    assert.deepEqual(await designationOf(x), once, "no second authorization, purchase, designation or consumption");
  },
);

faultCell(
  {
    id: "TRG_PAR",
    step: "Qualifying-purchase trigger (reconciler transaction), a database failure after the agency's recurrence is upserted and before the qualifying purchase is inserted",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected between the recurrence upsert and the purchase insert of the designation rolls back the whole reconciler transaction; the delivery stays RECEIVED, and its application then makes one designation: sequence 1, one purchase, one recurrence, one authorization",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-par-recurrence");
    const eventId = "evt-trg-par-recurrence";
    const first = await designationOf(x);
    assert.deepEqual([first.authorizations, first.captures, first.purchases, first.recurrence], [0, 0, [], null], "an agency that never bought");
    await armDbFault("AFTER_RECURRENCE");
    try {
      const failure = await ctx.partial("the reconciler failing after the recurrence upsert and before the purchase insert", "db.fault.AFTER_RECURRENCE", async () => {
        await report(ctx, x, { eventId, throwFailure: true });
      });
      assert.ok(failure !== undefined);
    } finally {
      await disarmDbFaults();
    }
    // the database had done the recurrence upsert (sequence 1) and not the purchase when it fired: the step the cell names
    assert.deepEqual(iw.faults.dbFaults.at(-1)?.message, "KAURO_FAULT AFTER_RECURRENCE recurrence=1 purchases=0");
    assert.deepEqual(await designationOf(x), first, "the whole reconciler transaction rolled back: no authorization, capture, sequence, recurrence or purchase");
    assert.deepEqual(await inboxStates(eventId), ["RECEIVED"], "the delivery the handler could not apply stays RECEIVED");
    await recovered();
    assert.deepEqual(await inboxStates(eventId), ["APPLIED"], "the inbox worker applies that delivery");
    const done = await designationOf(x);
    assert.deepEqual([done.authorizations, done.captures, done.purchases, done.recurrence?.count, done.orderState], [1, 1, [1], 1, "CAPTURED"], "the same capture applies once: sequence 1, one purchase, one recurrence");
    consumedOnce(first, done);
    assert.equal(done.recurrence?.firstAuthorizationId, (await oracleRows<{ authorization_id: string }>(iw, "SELECT authorization_id FROM kauro.commercial_authorizations WHERE agency_id = $1", [x.agencyId]))[0]!.authorization_id);
  },
);

// --- 24. TRG_CRASH (the crash cells; the redelivery cell is above, with the founding cells) ------------------------------------------------

faultCell(
  {
    id: "TRG_CRASH",
    step: "Qualifying-purchase trigger (reconciler transaction), a crash after the designation trigger's last write and immediately before the reconciler's COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (crash): a crash right before the reconciler COMMIT, after the authorization insert answered (its designation trigger complete), leaves no authorization, capture, sequence, recurrence or purchase; the delivery stays RECEIVED and its application makes one designation (this agency has no founding reservation: the slot half is TRG_PAR's)",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-crash-before");
    const eventId = "evt-trg-crash-before";
    const first = await designationOf(x);
    assert.deepEqual([first.authorizations, first.purchases, first.recurrence], [0, [], null], "an agency that never bought");
    const crash = ctx.points.crash("uow.before-commit");
    const reported = await ctx.operation("the reconciler whose COMMIT is never issued", () => report(ctx, x, { eventId }));
    await crash.reached;
    // the crash fired after the authorization insert (and its designation trigger) answered, in the reconciler's own unit
    const passed = ctx.points.passed;
    assert.ok(passed.slice(0, passed.lastIndexOf("uow.before-commit")).includes("pay.authorizations.issue.after"), "the authorization insert completed before the crash");
    assert.equal(reported.inboxState, "RECEIVED", "the provider is told only what the ingress settled");
    assert.deepEqual(await designationOf(x), first, "nothing of the reconciler's transaction remains: no authorization, capture, sequence, recurrence or purchase");
    assert.deepEqual(await inboxStates(eventId), ["RECEIVED"]);
    await recovered();
    const done = await designationOf(x);
    assert.deepEqual([done.authorizations, done.captures, done.purchases, done.recurrence?.count, done.orderState], [1, 1, [1], 1, "CAPTURED"], "the retry makes one designation");
    consumedOnce(first, done);
    assert.deepEqual(await inboxStates(eventId), ["APPLIED"]);
  },
);

faultCell(
  {
    id: "TRG_CRASH",
    step: "Qualifying-purchase trigger (reconciler transaction), a crash right after the reconciler's COMMIT",
    fault: "crash-after-commit",
    at: "uow",
    expect:
      "RACE (crash): the answer lost right after the reconciler COMMIT leaves the designation committed once (sequence 1, one purchase, one authorization); the reconciler's retry, the inbox worker and a redelivery of the same event find it confirmed and add nothing",
  },
  async (ctx) => {
    const x = await capturedAtProvider("trg-crash-after");
    const eventId = "evt-trg-crash-after";
    const first = await designationOf(x);
    assert.equal(first.authorizations, 0);
    const crash = ctx.points.crash("uow.after-commit");
    const reported = await ctx.operation("the reconciler whose answer is lost after its COMMIT", () => report(ctx, x, { eventId }));
    await crash.reached;
    assert.equal(reported.inboxState, "RECEIVED", "the provider is told only what the ingress settled: the answer was lost");
    const committed = await designationOf(x);
    assert.deepEqual([committed.authorizations, committed.captures, committed.purchases, committed.recurrence?.count, committed.orderState], [1, 1, [1], 1, "CAPTURED"], "the unit had committed");
    assert.deepEqual(await inboxStates(eventId), ["APPLIED"]);
    assert.deepEqual((await iw.pw.service.runInboxPass()).applied, [], "the inbox worker has nothing to apply");
    assert.equal((await report(ctx, x, { eventId })).inboxState, "APPLIED", "the redelivery of the same event finds it applied");
    assert.deepEqual(await designationOf(x), committed, "one designation, no second authorization or purchase");
    consumedOnce(first, committed);
  },
);

// =====================================================================================================================================
// Claim conversion and entitlement creation (COMMISSIONS consumer C1; ACCRUAL_RECONCILIATION sweep C2)
// =====================================================================================================================================
// The consumer's unit of work (accrueOnEvent) mirrors the first designation, converts the agency's ACCEPTED claims (each: the claim to
// CONVERTED, then its beneficiary's ACQUISITION entitlement) and accrues the purchase's pools and lines, in ONE commit. The routed unit
// (test/fault-support.ts) runs it over a connection the harness opened; the statements of the conversion are the cell's steps.

const CLAIM_UPDATE: SqlStep = { label: "claim_update", match: /UPDATE kauro\.attribution_claims/ };
const ENTITLEMENT_INSERT: SqlStep = { label: "entitlement_insert", match: /INSERT INTO kauro\.commission_entitlements/ };

type Login = "kauro_app_test" | "kauro_commission_test";
const open = (login: Login): Promise<HarnessConnection> => openConnection(iw.h.pg.clientConfig(login));

/** The commission service whose units are the routed ones: real outside `faults.on`, the cell's connection inside it. */
let svc: CommissionService;
/** The failures the commission service handed to its background sink (a sweep item's failure), by subject. */
const failures: Array<{ readonly subject: string; readonly error: unknown }> = [];

/** An agency whose seller(s)' claims are ACCEPTED under one frozen allocation (the shares in bps), before the agency's first purchase. */
async function accepted(label: string, shares: ReadonlyArray<number>): Promise<{ readonly s: Selling; readonly att: Attribution; readonly allocationId: string; readonly agencyId: string }> {
  const s = await sellingAgency(iw, label);
  const att = await claimsOn(iw, label, shares.length);
  const allocationId = await acceptAttribution(iw, s.agency.agencyId, att, shares);
  return { s, att, allocationId, agencyId: s.agency.agencyId };
}
type Delivery = Awaited<ReturnType<typeof deliveryOf>>;
const deliveryOfCapture = async (p: Purchase): Promise<Delivery> => deliveryOf(iw, await eventOf(iw, p.captureId, "capture.completed.v1"));

interface Converting {
  readonly s: Selling;
  readonly att: Attribution;
  readonly allocationId: string;
  readonly agencyId: string;
  readonly first: Purchase;
  readonly delivery: Delivery;
}
/** Claims accepted, then the agency's first purchase confirmed: the capture's delivery waits for COMMISSIONS (nothing is dispatched). */
async function converting(label: string, shares: ReadonlyArray<number>): Promise<Converting> {
  const a = await accepted(label, shares);
  const first = await purchase(iw, a.s, label);
  return { ...a, first, delivery: await deliveryOfCapture(first) };
}

interface Rights {
  readonly claims: ReadonlyArray<string>;
  readonly entitlements: ReadonlyArray<readonly [string, string, number]>;
  readonly pools: number;
  readonly lines: number;
}
/** The rights the conversion creates or leaves: each claim's state, each beneficiary's entitlement (largest share first), the purchase's pools and lines. */
async function rightsOf(c: { readonly att: Attribution; readonly agencyId: string; readonly first: Purchase }): Promise<Rights> {
  const claims = await oracleRows<{ claim_id: string; state: string }>(iw, "SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [c.att.claimIds]);
  const entitlements = await oracleRows<{ seller_id: string; state: string; share_bps: number }>(iw, "SELECT seller_id, state, share_bps FROM kauro.commission_entitlements WHERE agency_id = $1 ORDER BY share_bps DESC, seller_id", [c.agencyId]);
  return {
    claims: c.att.claimIds.map((id) => claims.find((x) => x.claim_id === id)!.state),
    entitlements: entitlements.map((e) => [e.seller_id, e.state, e.share_bps] as const),
    pools: (await poolsOf(iw, c.first.authorizationId)).length,
    lines: (await linesOf(iw, c.first.authorizationId)).length,
  };
}
const nothingFor = (c: { readonly att: Attribution }): Rights => ({ claims: c.att.claimIds.map(() => "ACCEPTED"), entitlements: [], pools: 0, lines: 0 });

/** What one converted purchase leaves: every claim CONVERTED, one ACTIVE entitlement per beneficiary at its share, one acquisition pool and one line per beneficiary. */
function convertedFor(c: { readonly att: Attribution }, shares: ReadonlyArray<number>): Rights {
  const sellers = c.att.sellers.map((s, i) => [s.sellerId, shares[i]!] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { claims: c.att.claimIds.map(() => "CONVERTED"), entitlements: sellers.map(([id, bps]) => [id, "ACTIVE", bps] as const), pools: 1, lines: shares.length };
}

/** The consumer's delivery on `conn` (the unit routed over it), the service's units standing at `at` on the TEST CLOCK when given. */
function consumeOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, delivery: Delivery, steps: ReadonlyArray<SqlStep> = [], at: string | null = null): Promise<string> {
  iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => svc.consumer.handle(delivery as never)).finally(() => iw.standAt(null));
}
/** One pass of a sweep on `conn`. */
function sweepOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, sweep: CommissionSweepName, steps: ReadonlyArray<SqlStep> = [], at: string | null = null) {
  iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => svc.runSweep(sweep)).finally(() => iw.standAt(null));
}
const itemOf = (report: { readonly items: ReadonlyArray<{ readonly subject: string; readonly outcome: string }> }, subject: string): string | undefined => report.items.find((i) => i.subject === subject)?.outcome;

/**
 * A pass of `sweep` on `conn` stopped at the first claim UPDATE of its first conversion, where `arm` arms the cell's fault: how a sweep, which
 * opens several units, is faulted in the conversion's own unit.
 */
async function sweepFaultedInConversion(ctx: FaultContext, conn: HarnessConnection, sweep: CommissionSweepName, arm: () => void, steps: ReadonlyArray<SqlStep>, what: string) {
  const pause = ctx.points.pause("db.claim_update.before");
  const running = ctx.operation(what, () => sweepOn(ctx, conn, sweep, steps));
  await pause.reachedBy(running);
  arm();
  pause.release();
  return running;
}
/** The last failure the commission service reported for the subject. */
const failureOf = (subject: string): unknown => [...failures].reverse().find((f) => f.subject === subject)?.error;

/** The settlement of an operation the cell expects to fail: its error, or the answer it got. */
const settled = <T>(p: Promise<T>): Promise<{ readonly answer: T } | { readonly failure: unknown }> => p.then((answer) => ({ answer }), (failure: unknown) => ({ failure }));

// --- 28. CONV_CRASH, C1 (consumer) -----------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CONV_CRASH",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), a crash after the entitlement inserts and immediately before the unit's COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (crash): a crash right before the consumer's COMMIT, after both beneficiaries' claim CONVERTED updates and entitlement inserts answered, leaves both claims ACCEPTED, no entitlement, pool or line; the redelivery converts once: one entitlement per beneficiary, each claim CONVERTED once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await converting("conv-crash-before", shares);
    assert.deepEqual(await rightsOf(c), nothingFor(c));
    const crash = ctx.points.crash("uow.before-commit");
    const conn = await open("kauro_commission_test");
    try {
      const outcome = await ctx.operation("the conversion whose COMMIT is never issued", () => settled(consumeOn(ctx, conn, c.delivery, [CLAIM_UPDATE, ENTITLEMENT_INSERT])));
      await crash.reached;
      assert.ok("failure" in outcome && crashedAt("uow.before-commit")(outcome.failure), "the unit died at its COMMIT boundary");
      // both beneficiaries' claim updates and entitlement inserts answered before the crash: the step the cell names
      const passed = ctx.points.passed;
      const before = passed.slice(0, passed.lastIndexOf("uow.before-commit"));
      assert.deepEqual([before.filter((p) => p === "db.claim_update.after").length, before.filter((p) => p === "db.entitlement_insert.after").length], [2, 2]);
    } finally {
      await conn.end();
    }
    assert.deepEqual(await rightsOf(c), nothingFor(c), "no entitlement, pool or line remains and both claims are still ACCEPTED");
    assert.equal(await svc.consumer.handle(c.delivery as never), "APPLIED", "the redelivery converts");
    assert.deepEqual(await rightsOf(c), convertedFor(c, shares), "one entitlement per beneficiary, each claim CONVERTED once");
  },
);

faultCell(
  {
    id: "CONV_CRASH",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), a crash right after the unit's COMMIT, before the delivery is settled",
    fault: "crash-after-commit",
    at: "uow",
    expect:
      "RACE (crash): the answer lost after the consumer's COMMIT leaves the conversion committed once (one entitlement per beneficiary, each claim CONVERTED); the redelivery converts nothing again and answers DUPLICATE",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await converting("conv-crash-after", shares);
    const crash = ctx.points.crash("uow.after-commit");
    const conn = await open("kauro_commission_test");
    try {
      const outcome = await ctx.operation("the conversion whose answer is lost after its COMMIT", () => settled(consumeOn(ctx, conn, c.delivery)));
      await crash.reached;
      assert.ok("failure" in outcome && crashedAt("uow.after-commit")(outcome.failure));
    } finally {
      await conn.end();
    }
    const committed = await rightsOf(c);
    assert.deepEqual(committed, convertedFor(c, shares), "the unit had committed");
    assert.equal(await svc.consumer.handle(c.delivery as never), "DUPLICATE", "the redelivery finds the conversion made");
    assert.deepEqual(await rightsOf(c), committed, "no second entitlement per beneficiary, no second pool or line");
  },
);

faultCell(
  {
    id: "CONV_CRASH",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), the first capture's delivery repeated",
    fault: "retry",
    expect: "DENY: the first capture's delivery repeated converts nothing again: one entitlement per beneficiary, each claim CONVERTED once, and the repeat answers DUPLICATE",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await converting("conv-retry", shares);
    const answers = await ctx.sequentially(2, () => svc.consumer.handle(c.delivery as never));
    assert.deepEqual(answers.map((r) => (r.status === "fulfilled" ? r.value : r.reason)), ["APPLIED", "DUPLICATE"]);
    assert.deepEqual(await rightsOf(c), convertedFor(c, shares), "one entitlement per beneficiary, each claim CONVERTED once");
  },
);

// --- 27. CONV_PAR, C1 -------------------------------------------------------------------------------------------------------------------

faultCell(
  {
    id: "CONV_PAR",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), a failure after a claim CONVERTED and before its beneficiary's entitlement insert, and after the first beneficiary's entitlement insert and before the second claim's update",
    fault: "partial",
    expect:
      "RACE (partial): a failure injected between a claim's CONVERTED update and its entitlement insert, and between the first beneficiary's entitlement insert and the second claim's update, rolls the whole conversion back (both claims ACCEPTED, no entitlement, pool or line); the redelivery then converts once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const cases: ReadonlyArray<{ readonly label: string; readonly at: string; readonly steps: ReadonlyArray<SqlStep>; readonly what: string }> = [
      { label: "claim-then-entitlement", at: "db.entitlement_insert.before", steps: [CLAIM_UPDATE, ENTITLEMENT_INSERT], what: "the conversion failing after the first claim CONVERTED and before its entitlement insert" },
      { label: "between-beneficiaries", at: "db.claim_update.before", steps: [{ ...CLAIM_UPDATE, nth: 2 }, ENTITLEMENT_INSERT], what: "the conversion failing after the first beneficiary's entitlement insert and before the second claim's update" },
    ];
    for (const { label, at, steps, what } of cases) {
      const c = await converting(`conv-par-${label}`, shares);
      const conn = await open("kauro_commission_test");
      try {
        await ctx.partial(what, at, async () => {
          const outcome = await settled(consumeOn(ctx, conn, c.delivery, steps));
          if ("failure" in outcome) throw outcome.failure;
          return outcome.answer;
        });
      } finally {
        await conn.end();
      }
      assert.deepEqual(await rightsOf(c), nothingFor(c), `${label}: the whole conversion rolled back`);
      assert.equal(await svc.consumer.handle(c.delivery as never), "APPLIED");
      assert.deepEqual(await rightsOf(c), convertedFor(c, shares), `${label}: the redelivery converts once`);
    }
  },
);

// --- C2: ACCRUAL_RECONCILIATION, the acceptance that follows the first purchase ---------------------------------------------------------

/** The agency's first purchase confirmed and consumed (nothing to convert yet), then the claims ACCEPTED: the conversion is the sweep's. */
async function acceptedLater(label: string, shares: ReadonlyArray<number>): Promise<Converting> {
  const s = await sellingAgency(iw, label);
  const att = await claimsOn(iw, label, shares.length);
  const first = await purchase(iw, s, label);
  const delivery = await deliveryOfCapture(first);
  assert.equal(await svc.consumer.handle(delivery as never), "APPLIED", "the first purchase is mirrored and consumed with no claim to convert");
  const allocationId = await acceptAttribution(iw, s.agency.agencyId, att, shares);
  const c = { s, att, allocationId, agencyId: s.agency.agencyId, first, delivery };
  assert.deepEqual(await rightsOf(c), nothingFor(c));
  return c;
}
const RECONCILIATION: CommissionSweepName = "ACCRUAL_RECONCILIATION";

faultCell(
  {
    id: "CONV_CRASH",
    step: "ACCRUAL_RECONCILIATION (claim conversion for an acceptance after the first purchase), a crash after the entitlement inserts and immediately before the conversion unit's COMMIT",
    fault: "crash-before-commit",
    at: "uow",
    expect:
      "RACE (crash): a crash right before the COMMIT of the sweep's conversion unit, after both beneficiaries' claim updates and entitlement inserts answered, leaves both claims ACCEPTED and no entitlement; the next pass converts once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await acceptedLater("conv2-crash-before", shares);
    const conn = await open("kauro_commission_test");
    try {
      const report = await sweepFaultedInConversion(ctx, conn, RECONCILIATION, () => void ctx.points.crash("uow.before-commit"), [CLAIM_UPDATE, ENTITLEMENT_INSERT], "the sweep whose conversion COMMIT is never issued");
      assert.match(itemOf(report, c.agencyId) ?? "", /^FAILED /, "the agency's conversion failed at the crash");
      assert.ok(crashedAt("uow.before-commit")(failureOf(c.agencyId)), "and it is the crash at the COMMIT boundary that failed it");
      const passed = ctx.points.passed;
      const before = passed.slice(0, passed.lastIndexOf("uow.before-commit"));
      assert.deepEqual([before.filter((p) => p === "db.claim_update.after").length, before.filter((p) => p === "db.entitlement_insert.after").length], [2, 2], "both claims updated and both entitlements inserted before the crash");
    } finally {
      await conn.end();
    }
    assert.deepEqual(await rightsOf(c), nothingFor(c), "no entitlement remains, both claims are still ACCEPTED");
    assert.equal(itemOf(await svc.runSweep(RECONCILIATION), c.agencyId), "CONVERTED 2", "the next pass converts");
    assert.deepEqual(await rightsOf(c), convertedFor(c, shares), "one entitlement per beneficiary, each claim CONVERTED once");
  },
);

faultCell(
  {
    id: "CONV_CRASH",
    step: "ACCRUAL_RECONCILIATION (claim conversion for an acceptance after the first purchase), a crash right after the conversion unit's COMMIT",
    fault: "crash-after-commit",
    at: "uow",
    expect: "RACE (crash): the sweep stopped right after its conversion unit committed leaves the conversion made once; the next pass converts nothing again",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await acceptedLater("conv2-crash-after", shares);
    const conn = await open("kauro_commission_test");
    try {
      const report = await sweepFaultedInConversion(ctx, conn, RECONCILIATION, () => void ctx.points.crash("uow.after-commit"), [CLAIM_UPDATE, ENTITLEMENT_INSERT], "the sweep stopped after its conversion COMMIT");
      assert.match(itemOf(report, c.agencyId) ?? "", /^FAILED /, "the sweep never recorded the conversion's result");
      assert.ok(crashedAt("uow.after-commit")(failureOf(c.agencyId)), "the crash at the COMMIT boundary is what failed it");
    } finally {
      await conn.end();
    }
    const committed = await rightsOf(c);
    assert.deepEqual([committed.claims, committed.entitlements], [convertedFor(c, shares).claims, convertedFor(c, shares).entitlements], "the unit had committed: one entitlement per beneficiary, each claim CONVERTED");
    assert.equal(itemOf(await svc.runSweep(RECONCILIATION), c.agencyId), "NOTHING_TO_CONVERT", "the next pass converts nothing again");
    const after = await rightsOf(c);
    assert.deepEqual([after.claims, after.entitlements], [committed.claims, committed.entitlements], "no second entitlement per beneficiary");
    assert.deepEqual([after.pools, after.lines], [1, 2], "the purchase accrued once, for both beneficiaries");
  },
);

faultCell(
  {
    id: "CONV_CRASH",
    step: "ACCRUAL_RECONCILIATION (claim conversion for an acceptance after the first purchase), a second pass after the first converted",
    fault: "retry",
    expect: "DENY: a second pass of ACCRUAL_RECONCILIATION converts nothing again: one entitlement per beneficiary, each claim CONVERTED once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await acceptedLater("conv2-retry", shares);
    const passes = await ctx.sequentially(2, () => svc.runSweep(RECONCILIATION));
    assert.deepEqual(passes.map((r) => (r.status === "fulfilled" ? itemOf(r.value, c.agencyId) : r.reason)), ["CONVERTED 2", "NOTHING_TO_CONVERT"]);
    assert.deepEqual(await rightsOf(c), convertedFor(c, shares), "one entitlement per beneficiary, each claim CONVERTED once");
  },
);

faultCell(
  {
    id: "CONV_PAR",
    step: "ACCRUAL_RECONCILIATION (claim conversion for an acceptance after the first purchase), a failure after the first beneficiary's entitlement insert and before the second claim's update",
    fault: "partial",
    expect:
      "RACE (partial): a failure between the first beneficiary's entitlement insert and the second claim's update rolls the sweep's conversion back (both claims ACCEPTED, no entitlement); the next pass converts once",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    const c = await acceptedLater("conv2-par", shares);
    const conn = await open("kauro_commission_test");
    try {
      await ctx.partial("the sweep's conversion failing after the first beneficiary's entitlement insert and before the second claim's update", "db.claim_update.before", async () => {
        const seen = failures.length;
        const report = await sweepOn(ctx, conn, RECONCILIATION, [{ ...CLAIM_UPDATE, nth: 2 }, ENTITLEMENT_INSERT]);
        const failure = failures.slice(seen).find((f) => f.subject === c.agencyId);
        assert.match(itemOf(report, c.agencyId) ?? "", /^FAILED /);
        if (failure === undefined) throw new Error("the sweep recorded no failure of the agency");
        throw failure.error;
      });
    } finally {
      await conn.end();
    }
    assert.deepEqual(await rightsOf(c), nothingFor(c), "the whole conversion rolled back");
    assert.equal(itemOf(await svc.runSweep(RECONCILIATION), c.agencyId), "CONVERTED 2");
    assert.deepEqual(await rightsOf(c), convertedFor(c, shares));
  },
);
