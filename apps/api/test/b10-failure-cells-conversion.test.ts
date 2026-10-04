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
import { after, before, test } from "node:test";
import { connectionPid, crashedAt, faultCell, openConnection, type FaultContext, type HarnessConnection } from "@kauro/persistence/testing";
import type { AttributionView, SellerTerminationView, WebhookAck } from "@kauro/application";
import { deliver } from "./payment-support.js";
import { agentOf, integrationWorld, assignedThrough, opportunityOf, oracleRows, orderedThrough, planOf, quoted, terminatedThrough, terminationBody, webhookPurchase, type Agent, type IntegrationWorld } from "./integration-support.js";
import { seller } from "./statements-support.js";
import { recordServiceAssignment } from "@kauro/persistence/testing";
import type { RecordedSeller } from "@kauro/persistence/testing";
import { acceptAttribution, claimsOn, deliveryOf, eventOf, linesOf, poolsOf, purchase, sellingAgency, type Attribution, type Purchase, type Selling } from "./commission-support.js";
import type { SqlStep } from "./fault-support.js";
import { createCommissionService, type CommissionService } from "../src/index.js";
import type { CommissionSweepName } from "../src/commissions/sweeps.js";
import { prepareAllocation } from "./sales-support.js";
import { call, completed, freshKey, ids, type Reply } from "./support.js";

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
function consumeOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, delivery: Delivery, steps: ReadonlyArray<SqlStep> = [], at?: string): Promise<string> {
  if (at !== undefined) iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => svc.consumer.handle(delivery as never)).finally(() => (at !== undefined ? iw.standAt(null) : undefined));
}
/** One pass of a sweep on `conn`. */
function sweepOn(ctx: Pick<FaultContext, "points">, conn: HarnessConnection, sweep: CommissionSweepName, steps: ReadonlyArray<SqlStep> = [], at?: string) {
  if (at !== undefined) iw.standAt(at);
  return iw.faults.on(conn, "kauro_commission", ctx.points, steps, () => svc.runSweep(sweep)).finally(() => (at !== undefined ? iw.standAt(null) : undefined));
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

// =====================================================================================================================================
// 26. CLAIM_TAIL: an ACCEPTED claim a termination listed ends at its TAIL's end, not at its acceptance window's (D10-TERM-1, D10-TERM-2)
// =====================================================================================================================================
// A claim accepted through CMD047, then its seller terminated through the real CMD050 with the claim listed: the claim keeps running 2160
// hours from the termination, a few hundred milliseconds beyond its own acceptance window. Every instant a cell uses is read from the
// database (whole milliseconds, like the tail end itself), and the expiry cells put it on the transaction of the operation that consumes it
// through the controlled clock (op.clock.onServer: the first purchase's reconciliation, the CLAIM_WINDOWS sweep's units), so "after the
// original expires_at and before the tail end" and "at the exact tail end" are exact, and the harness proves each was crossed and consumed.

interface Tail {
  readonly label: string;
  readonly D: Awaited<ReturnType<typeof seller>>;
  readonly a: Agent;
  readonly agencyId: string;
  readonly claimId: string;
  readonly att: { readonly claimIds: ReadonlyArray<string>; readonly sellers: ReadonlyArray<RecordedSeller> };
  /**
   * The claim's own acceptance window's end, an instant between it and the tail's end, the whole millisecond before the one in which the tail
   * ends, and the first whole millisecond not before the tail's end (UTC; the controlled clock's grain); and the tail's end itself as the
   * database holds it, with its microseconds.
   */
  readonly expiresAt: string;
  readonly afterExpiry: string;
  readonly beforeEnd: string;
  readonly tailEnd: string;
  readonly exactEnd: string;
}

const ISO = (expr: string): string => `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function tailed(label: string): Promise<Tail> {
  const D = await seller(iw, label);
  const op = await opportunityOf(iw, D, label);
  const done = await terminatedThrough(iw, D.sellerId, await terminationBody(iw, D.sellerId, [op.claimId]));
  assert.equal(done.tailEntries, 1);
  const [t] = await oracleRows<{ expires_at: string; after_expiry: string; before_end: string; tail_end: string; exact_end: string; gap_ms: number }>(
    iw,
    `SELECT ${ISO("date_trunc('milliseconds', c.expires_at)")} AS expires_at, ${ISO("date_trunc('milliseconds', c.expires_at + (e.tail_end - c.expires_at) / 2)")} AS after_expiry,
            ${ISO("date_trunc('milliseconds', e.tail_end) - interval '1 millisecond'")} AS before_end,
            ${ISO("date_trunc('milliseconds', e.tail_end) + CASE WHEN date_trunc('milliseconds', e.tail_end) = e.tail_end THEN interval '0' ELSE interval '1 millisecond' END")} AS tail_end,
            e.tail_end::text AS exact_end, (extract(epoch FROM e.tail_end - c.expires_at) * 1000)::float AS gap_ms
       FROM kauro.attribution_claims c, LATERAL (SELECT max(t.ends_at) AS tail_end FROM kauro.termination_tail_entries t WHERE t.claim_id = c.claim_id) e WHERE c.claim_id = $1`,
    [op.claimId],
  );
  assert.ok(t!.gap_ms > 10, `the tail ends ${t!.gap_ms} ms after the claim's own acceptance window: room for an instant between them`);
  return { label, D, a: op.a, agencyId: op.a.s.agency.agencyId, claimId: op.claimId, att: { claimIds: [op.claimId], sellers: [D] }, expiresAt: t!.expires_at, afterExpiry: t!.after_expiry, beforeEnd: t!.before_end, tailEnd: t!.tail_end, exactEnd: t!.exact_end };
}

/**
 * The agency's first purchase through the REAL webhook (CMD030, the real reconciler): the quote, the order and the provider's capture are made
 * now; the reconciliation's transaction is positioned on the cell's controlled clock (`ctx.clock`, already moved to `confirmedAt`) so the
 * confirmation instant is the one the cell chose, consumed by this operation.
 */
async function firstPurchaseAt(ctx: FaultContext, t: Tail, confirmedAt: string): Promise<Purchase & { readonly delivery: Delivery }> {
  const quote = await quoted(iw, t.a, await planOf(iw, t.a, t.label, { units: 50_000 }));
  const order = await orderedThrough(iw, t.a, quote);
  iw.pw.paypal.approve(order.order.providerOrderId!);
  const providerCaptureId = iw.pw.paypal.captureAtProvider(order.order.providerOrderId!);
  const seen = iw.pw.backgroundFailures.length;
  ctx.clock.set(confirmedAt);
  const delivery = await ctx.operation("the reconciler confirming the first purchase on the controlled clock", async (op) => {
    iw.faults.clock = op.clock;
    try {
      return await iw.faults.onPayment(ctx.points, () => deliver(iw.pw, "PAYMENT.CAPTURE.COMPLETED", providerCaptureId));
    } finally {
      iw.faults.clock = null;
    }
  });
  assert.equal(completed<WebhookAck>(delivery.reply, 200).data.inboxState, "APPLIED", `the reconciliation applied (${String((iw.pw.backgroundFailures[seen] as { error?: unknown } | undefined)?.error)})`);
  const p = await webhookPurchase(iw, quote, order, providerCaptureId);
  const [row] = await oracleRows<{ same: boolean }>(iw, "SELECT confirmed_at = $2::timestamptz AS same FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId, confirmedAt]);
  assert.equal(row!.same, true, "the purchase is confirmed at the instant the cell chose");
  return { ...p, delivery: await deliveryOfCapture(p) };
}
const claimStateOf = async (claimId: string): Promise<string> => (await oracleRows<{ state: string }>(iw, "SELECT state FROM kauro.attribution_claims WHERE claim_id = $1", [claimId]))[0]!.state;
const entitlementsOfAgency = async (agencyId: string): Promise<number> => (await oracleRows<{ n: number }>(iw, "SELECT count(*)::int AS n FROM kauro.commission_entitlements WHERE agency_id = $1", [agencyId]))[0]!.n;

for (const via of ["consumer", "sweep"] as const) {
  faultCell(
    {
      id: "CLAIM_TAIL",
      step: `Claim conversion and entitlement creation (${via === "consumer" ? "COMMISSIONS consumer" : "ACCRUAL_RECONCILIATION"}), the first purchase's confirmation against the tail end of a listed claim`,
      fault: "expiry",
      expect:
        "EXPIRY: a first purchase confirmed after the claim's own expires_at and before its termination tail's end still converts it (one entitlement for the departed seller, the claim CONVERTED); confirmed in the millisecond before the one the tail ends in it converts; confirmed at the first millisecond not before the tail end it does not: the claim stays ACCEPTED and nothing accrues (the purchase's own confirmation instant decides)",
    },
    async (ctx) => {
      // three tails, made in this order, so that every instant below is after the previous one (the controlled clock never moves back)
      const tails = [await tailed(`tail-${via}-a`), await tailed(`tail-${via}-b`), await tailed(`tail-${via}-c`)] as const;
      const cases = [
        { which: "after the claim's own expires_at, inside the tail", t: tails[0], at: tails[0].afterExpiry, deadline: tails[0].expiresAt, what: "the claim's own acceptance window's end", claim: "CONVERTED" },
        { which: "the millisecond before the one the tail ends in", t: tails[1], at: tails[1].beforeEnd, deadline: tails[1].expiresAt, what: "the claim's own acceptance window's end", claim: "CONVERTED" },
        { which: "the first millisecond not before the tail end", t: tails[2], at: tails[2].tailEnd, deadline: tails[2].tailEnd, what: "the termination tail's end", claim: "ACCEPTED" },
      ] as const;
      assert.ok(cases.every((c, i) => i === 0 || Date.parse(c.at) > Date.parse(cases[i - 1]!.at)), "the instants increase");
      for (const c of cases) ctx.deadline(c.deadline, c.what);
      for (const { which, t, at, claim } of cases) {
        const p = await firstPurchaseAt(ctx, t, at);
        assert.equal(await claimStateOf(t.claimId), "ACCEPTED", `${which}: the listed claim is still ACCEPTED when the purchase confirms`);
        if (via === "consumer") await svc.consumer.handle(p.delivery as never);
        else assert.match(itemOf(await svc.runSweep(RECONCILIATION), t.agencyId) ?? "", /^(CONVERTED \d|NOTHING_TO_CONVERT)$/);
        assert.equal(await claimStateOf(t.claimId), claim, `${which}: the claim`);
        if (claim === "CONVERTED") {
          const rights = await rightsOf({ att: t.att as Attribution, agencyId: t.agencyId, first: p });
          assert.deepEqual([rights.entitlements.map((e) => e[0]), rights.pools, rights.lines], [[t.D.sellerId], 1, 1], `${which}: one entitlement for the departed seller, and the purchase accrued for it`);
        } else {
          assert.equal(await entitlementsOfAgency(t.agencyId), 0, `${which}: no entitlement`);
          assert.deepEqual([(await poolsOf(iw, p.authorizationId)).length, (await linesOf(iw, p.authorizationId)).length], [0, 0], `${which}: nothing accrues`);
        }
      }
    },
  );
}

// --- W2: the CLAIM_WINDOWS sweep and a claim in its tail --------------------------------------------------------------------------------

faultCell(
  {
    id: "CLAIM_TAIL",
    step: "Sweep CLAIM_WINDOWS, an ACCEPTED claim a termination listed, run after its own expires_at, just before and at its tail's end",
    fault: "expiry",
    expect:
      "EXPIRY: the sweep run after the claim's own expires_at and before its termination tail's end leaves the claim ACCEPTED (applying the acceptance deadline here would forfeit earned acquisition rights); run at the first millisecond not before the tail end it lapses the claim EXPIRED at that instant",
  },
  async (ctx) => {
    const t = await tailed("tail-w2-expiry");
    ctx.deadline(t.expiresAt, "the claim's own acceptance window's end");
    ctx.deadline(t.tailEnd, "the termination tail's end");
    assert.ok(Date.parse(t.afterExpiry) > Date.parse(t.expiresAt) && Date.parse(t.beforeEnd) < Date.parse(t.tailEnd));
    const conn = await open("kauro_commission_test");
    /** One pass of CLAIM_WINDOWS whose every unit of work is positioned on the controlled clock at `at`, the pass being the operation that consumes it. */
    const passAt = async (at: string) => {
      ctx.clock.set(at);
      return ctx.operation(`the CLAIM_WINDOWS pass standing at ${at}`, async (op) => {
        iw.faults.clock = op.clock;
        try {
          return await sweepOn(ctx, conn, "CLAIM_WINDOWS");
        } finally {
          iw.faults.clock = null;
        }
      });
    };
    try {
      assert.equal(itemOf(await passAt(t.afterExpiry), t.claimId), undefined, "after the claim's own expires_at the sweep finds it not due: it runs on for its tail");
      assert.equal(await claimStateOf(t.claimId), "ACCEPTED", "not lapsed early");
      assert.equal(itemOf(await passAt(t.beforeEnd), t.claimId), undefined, "a whole millisecond before the tail's end it is still not due");
      assert.equal(await claimStateOf(t.claimId), "ACCEPTED");
      assert.equal(itemOf(await passAt(t.tailEnd), t.claimId), "EXPIRED", "at the first millisecond not before the tail's end it lapses");
    } finally {
      await conn.end();
    }
    const [lapsed] = await oracleRows<{ state: string; at_end: boolean }>(iw, "SELECT state, lapsed_at = $2::timestamptz AS at_end FROM kauro.attribution_claims WHERE claim_id = $1", [t.claimId, t.tailEnd]);
    assert.deepEqual([lapsed!.state, lapsed!.at_end], ["EXPIRED", true], "EXPIRED at the instant the pass stood at");
    assert.equal(await entitlementsOfAgency(t.agencyId), 0, "no purchase ever converted it");
  },
);


faultCell(
  {
    id: "CLAIM_TAIL",
    step: "Sweep CLAIM_WINDOWS racing the claim conversion at a listed claim's tail end",
    fault: "race",
    expect:
      "RACE: a conversion (the COMMISSIONS consumer) and a CLAIM_WINDOWS pass standing at the tail's end contending for the claim, in both orders with the lock wait observed: when the first purchase was confirmed in the millisecond before the one the tail ends in the claim is CONVERTED once (one entitlement, never EXPIRED); when it was confirmed at the first millisecond not before the tail end the claim is EXPIRED at the tail's end, never converted (no entitlement, pool or line)",
  },
  async (ctx) => {
    for (const convertible of [true, false]) {
      for (const order of ["CONSUMER_FIRST", "SWEEP_FIRST"] as const) {
        const what = `${convertible ? "convertible" : "at-end"} ${order}`;
        const t = await tailed(`tail-race-${convertible ? "c" : "n"}-${order === "CONSUMER_FIRST" ? "1" : "2"}`);
        const p = await purchase(iw, t.a.s, t.label, { confirmedAt: convertible ? t.beforeEnd : t.tailEnd });
        const delivery = await deliveryOfCapture(p);
        assert.equal(await claimStateOf(t.claimId), "ACCEPTED");
        const consuming = await open("kauro_commission_test");
        const sweeping = await open("kauro_commission_test");
        iw.standAt(t.tailEnd);
        try {
          const consumer = (conn: HarnessConnection): Promise<unknown> => consumeOn(ctx, conn, delivery, [CLAIM_UPDATE]);
          const sweep = (conn: HarnessConnection): Promise<unknown> => sweepOn(ctx, conn, "CLAIM_WINDOWS", [CLAIM_UPDATE]);
          const [first, second, holderConn, waiterConn] = order === "CONSUMER_FIRST" ? [consumer, sweep, consuming, sweeping] : [sweep, consumer, sweeping, consuming];
          // the holder stops with the claim locked: the consumer at its COMMIT, the sweep right after its claim update
          const pause = ctx.points.pause(order === "CONSUMER_FIRST" ? "uow.before-commit" : "db.claim_update.after");
          const holding = ctx.operation(`${order === "CONSUMER_FIRST" ? "the conversion" : "the CLAIM_WINDOWS pass"} (holder)`, () => first(holderConn));
          await pause.reachedBy(holding);
          const waiting = await ctx.mustWait(iw.h.oracle, { waiter: waiterConn, holder: connectionPid(holderConn) }, second, `${order === "CONSUMER_FIRST" ? "the CLAIM_WINDOWS pass" : "the conversion"} while the claim is locked (${what})`);
          pause.release();
          await holding;
          const result = await waiting.pending;
          if (result.status === "rejected") throw result.reason;
        } finally {
          iw.standAt(null);
          await consuming.end();
          await sweeping.end();
        }
        const rights = await rightsOf({ att: t.att as Attribution, agencyId: t.agencyId, first: p });
        if (convertible) {
          assert.deepEqual([rights.claims, rights.entitlements.map((e) => e[0]), rights.pools, rights.lines], [["CONVERTED"], [t.D.sellerId], 1, 1], `${what}: converted once, never expired`);
        } else {
          assert.deepEqual([rights.claims, rights.entitlements, rights.pools, rights.lines], [["EXPIRED"], [], 0, 0], `${what}: expired, never converted`);
          const [lapsed] = await oracleRows<{ at_end: boolean }>(iw, "SELECT lapsed_at = $2::timestamptz AS at_end FROM kauro.attribution_claims WHERE claim_id = $1", [t.claimId, t.tailEnd]);
          assert.equal(lapsed!.at_end, true, `${what}: lapsed at the instant the pass stood at, the tail's end`);
        }
      }
    }
  },
);

// The controlled clock's grain is the millisecond; the database's instants carry microseconds. A first purchase confirmed less than a
// millisecond before the tail's end is before it for the database (the claim converts: KC011's own comparison), and one confirmed at the
// exact end is not. State-based DENY test (no injected fault): the instants come from the database as text and are put on the payment
// service's reconciliation by the capture fixture, which positions its transaction exactly there.
test("CLAIM_TAIL (microseconds): a first purchase confirmed one microsecond before a listed claim's tail end converts it, one confirmed at the exact tail end does not", async () => {
  for (const [which, minus, claim] of [
    ["one microsecond before the tail end", " - interval '1 microsecond'", "CONVERTED"],
    ["at the exact tail end", "", "ACCEPTED"],
  ] as const) {
    const t = await tailed(`tail-micro-${claim.toLowerCase()}`);
    const at = (await oracleRows<{ at: string }>(iw, `SELECT ('${t.exactEnd}'::timestamptz${minus})::text AS at`))[0]!.at;
    const p = await purchase(iw, t.a.s, t.label, { confirmedAt: at });
    const [row] = await oracleRows<{ same: boolean }>(iw, "SELECT confirmed_at = $2::timestamptz AS same FROM kauro.qualifying_purchases WHERE authorization_id = $1", [p.authorizationId, at]);
    assert.equal(row!.same, true, `${which}: the purchase is confirmed at the instant chosen, to the microsecond`);
    await svc.consumer.handle((await deliveryOfCapture(p)) as never);
    assert.equal(await claimStateOf(t.claimId), claim, which);
    assert.equal(await entitlementsOfAgency(t.agencyId), claim === "CONVERTED" ? 1 : 0, which);
  }
});

// =====================================================================================================================================
// 25. CONV_RACE: the conversion racing the other writers of the claim and of the agency
// =====================================================================================================================================
// Two actors contend for the same rows, each in its real unit of work over a connection the harness opened: the holder stops with its locks
// taken (a pause at its COMMIT, or right after its claim update), the waiter is observed waiting on it in pg_stat_activity (mustWait), the
// holder lets go, and the cell asserts the state and the rights, then runs the opposite order on a fresh agency.

interface Actor {
  readonly name: string;
  readonly login: Login;
  /** The point the holder stops at with its locks taken. */
  readonly holdAt: string;
  run(conn: HarnessConnection): Promise<unknown>;
}
/** Runs `holder` and `waiter` in that order over fresh connections: the waiter is observed waiting on the holder, then both settle. */
async function contend(ctx: FaultContext, holder: Actor, waiter: Actor, what: string): Promise<{ readonly holder: PromiseSettledResult<unknown>; readonly waiter: PromiseSettledResult<unknown> }> {
  const holderConn = await open(holder.login);
  const waiterConn = await open(waiter.login);
  try {
    const pause = ctx.points.pause(holder.holdAt);
    const holding = ctx.operation(`${holder.name} (holder)`, () => settled(holder.run(holderConn)));
    await pause.reachedBy(holding).catch(async (e: unknown) => {
      const outcome = await holding;
      throw new Error(`${holder.name} did not reach ${holder.holdAt} (${what}): ${"failure" in outcome ? (outcome.failure instanceof Error ? outcome.failure.message + " / " + String((outcome.failure as { cause?: unknown }).cause) : String(outcome.failure)) : "it completed: " + JSON.stringify((outcome.answer as { status?: number; text?: string } | undefined)?.text ?? outcome.answer).slice(0, 600)}`, { cause: e });
    });
    const waiting = await ctx.mustWait(iw.h.oracle, { waiter: waiterConn, holder: connectionPid(holderConn) }, (conn) => waiter.run(conn), `${waiter.name} while ${holder.name} holds the rows (${what})`);
    pause.release();
    const held = await holding;
    const waited = await waiting.pending;
    return { holder: "failure" in held ? { status: "rejected", reason: held.failure } : { status: "fulfilled", value: held.answer }, waiter: waited };
  } finally {
    await holderConn.end();
    await waiterConn.end();
  }
}
const mustHaveSettled = (r: PromiseSettledResult<unknown>, what: string): unknown => {
  if (r.status === "rejected") throw new Error(`${what} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, { cause: r.reason });
  return r.value;
};

const consumerActor = (ctx: FaultContext, delivery: Delivery, name = "the conversion"): Actor => ({ name, login: "kauro_commission_test", holdAt: "uow.before-commit", run: (conn) => consumeOn(ctx, conn, delivery, [CLAIM_UPDATE]) });
const sweepActor = (ctx: FaultContext, sweep: CommissionSweepName, name: string): Actor => ({ name, login: "kauro_commission_test", holdAt: "db.claim_update.after", run: (conn) => sweepOn(ctx, conn, sweep, [CLAIM_UPDATE]) });

const poolKinds = async (p: Purchase): Promise<ReadonlyArray<string>> => (await poolsOf(iw, p.authorizationId)).map((x) => `${x.source} ${x.rate_kind} ${x.rate_bps}`);

faultCell(
  {
    id: "CONV_RACE",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), racing the CLAIM_WINDOWS lapse, another accrual of the same agency and a competing acceptance",
    fault: "race",
    expect:
      "RACE: the consumer's conversion contending, in both orders with the lock wait observed, with (1) the CLAIM_WINDOWS lapse of claims past their acceptance window: converted once when the first purchase was confirmed inside the window, EXPIRED and never converted when it was confirmed after it; (2) another accrual of the same agency: one entitlement per beneficiary, each claim CONVERTED once, the first purchase's pool at the first rate and the second's at the repeat rate in both orders; (3) the acceptance of the claim (CMD047): converted once by the consumer when the acceptance committed first, and by the ACCRUAL_RECONCILIATION sweep when it committed after the consumer's pass: never lost",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];

    // (1) the CLAIM_WINDOWS lapse: the sweep stands an hour after the claims' acceptance window
    for (const convertible of [true, false]) {
      for (const order of ["CONSUMER_FIRST", "SWEEP_FIRST"] as const) {
        const what = `lapse, ${convertible ? "purchase inside the window" : "purchase after the window"}, ${order}`;
        const a = await accepted(`conv-race-lapse-${convertible ? "in" : "out"}-${order === "CONSUMER_FIRST" ? "1" : "2"}`, shares);
        const after = (await oracleRows<{ after: string }>(iw, "SELECT (max(expires_at) + interval '1 hour')::text AS after FROM kauro.attribution_claims WHERE claim_id = ANY ($1::uuid[])", [a.att.claimIds]))[0]!.after;
        const first = await purchase(iw, a.s, `conv-race-lapse-${order}`, convertible ? {} : { confirmedAt: after });
        const c = { ...a, first, delivery: await deliveryOfCapture(first) };
        iw.standAt(after);
        try {
          const consumer = consumerActor(ctx, c.delivery);
          const sweep = sweepActor(ctx, "CLAIM_WINDOWS", "the CLAIM_WINDOWS pass");
          const out = order === "CONSUMER_FIRST" ? await contend(ctx, consumer, sweep, what) : await contend(ctx, sweep, consumer, what);
          mustHaveSettled(out.holder, "the holder");
          mustHaveSettled(out.waiter, "the waiter");
        } finally {
          iw.standAt(null);
        }
        if (convertible) assert.deepEqual(await rightsOf(c), convertedFor(c, shares), `${what}: converted once, never expired`);
        else assert.deepEqual(await rightsOf(c), { claims: c.att.claimIds.map(() => "EXPIRED"), entitlements: [], pools: 0, lines: 0 }, `${what}: expired, never converted`);
      }
    }

    // (2) another accrual of the same agency: the first purchase's consumer and the second purchase's consumer
    for (const order of ["FIRST_PURCHASE_FIRST", "SECOND_PURCHASE_FIRST"] as const) {
      const what = `another accrual, ${order}`;
      const c = await converting(`conv-race-accrual-${order === "FIRST_PURCHASE_FIRST" ? "1" : "2"}`, shares);
      const second = await purchase(iw, c.s, `conv-race-accrual-second-${order}`);
      const secondDelivery = await deliveryOfCapture(second);
      const one = consumerActor(ctx, c.delivery, "the first purchase's consumer");
      const two = consumerActor(ctx, secondDelivery, "the second purchase's consumer");
      const out = order === "FIRST_PURCHASE_FIRST" ? await contend(ctx, one, two, what) : await contend(ctx, two, one, what);
      mustHaveSettled(out.holder, "the holder");
      mustHaveSettled(out.waiter, "the waiter");
      const rights = await rightsOf(c);
      assert.deepEqual([rights.claims, rights.entitlements], [convertedFor(c, shares).claims, convertedFor(c, shares).entitlements], `${what}: one entitlement per beneficiary, each claim CONVERTED once`);
      assert.deepEqual(await poolKinds(c.first), ["ACQUISITION FIRST 1000"], `${what}: the first purchase's pool at the first rate`);
      assert.deepEqual(await poolKinds(second), ["ACQUISITION REPEAT 400"], `${what}: the second purchase's pool at the repeat rate`);
    }

    // (3) a competing acceptance of the claim (CMD047) after the agency's first purchase
    for (const order of ["ACCEPTANCE_FIRST", "CONSUMER_FIRST"] as const) {
      const what = `acceptance, ${order}`;
      const s = await sellingAgency(iw, `conv-race-accept-${order === "ACCEPTANCE_FIRST" ? "1" : "2"}`);
      iw.buyers.set(s.agency.agencyId, "AGENCY");
      const att = await claimsOn(iw, `conv-race-accept-${order === "ACCEPTANCE_FIRST" ? "1" : "2"}`, 1);
      const first = await purchase(iw, s, `conv-race-accept-${order}`);
      const delivery = await deliveryOfCapture(first);
      const c = { s, att, agencyId: s.agency.agencyId, first, delivery };
      const allocationId = await prepareAllocation(iw.h, { ownerUserId: iw.owner.userId, agencyId: c.agencyId, prospectId: att.prospectId, shares: [{ seller: att.sellers[0]!, claimId: att.claimIds[0]!, shareBps: 10_000 }] });
      const accept: Actor = {
        name: "AcceptAttribution",
        login: "kauro_app_test",
        holdAt: "uow.before-commit",
        run: (conn) =>
          iw.faults.on(conn, "kauro_app", ctx.points, [], () =>
            call(iw.w, { url: `/api/v1/sales/claims/${att.claimIds[0]!}/accept`, token: iw.owner.token, agency: null, key: freshKey("conv-race-accept"), body: { expectedVersion: 1, shareAllocationRef: allocationId } }),
          ),
      };
      const consumer = consumerActor(ctx, delivery);
      const out = order === "ACCEPTANCE_FIRST" ? await contend(ctx, accept, consumer, what) : await contend(ctx, consumer, accept, what);
      const reply = mustHaveSettled(order === "ACCEPTANCE_FIRST" ? out.holder : out.waiter, "the acceptance") as Reply;
      assert.equal(completed<AttributionView>(reply, 200).data.claim.state, "ACCEPTED", `${what}: the acceptance`);
      mustHaveSettled(order === "ACCEPTANCE_FIRST" ? out.waiter : out.holder, "the consumer");
      if (order === "ACCEPTANCE_FIRST") assert.deepEqual((await rightsOf(c)).claims, ["CONVERTED"], `${what}: the consumer converts what the acceptance committed`);
      else {
        assert.deepEqual((await rightsOf(c)).claims, ["ACCEPTED"], `${what}: the consumer's pass found no allocation: the accepted claim waits for the reconciliation`);
        assert.equal(itemOf(await svc.runSweep(RECONCILIATION), c.agencyId), "CONVERTED 1", `${what}: the ACCRUAL_RECONCILIATION sweep converts it`);
      }
      assert.deepEqual(await rightsOf(c), convertedFor(c, [10_000]), `${what}: converted once, one entitlement for the beneficiary, never lost`);
    }
  },
);

faultCell(
  {
    id: "CONV_RACE",
    step: "Claim conversion and entitlement creation (COMMISSIONS consumer), the claim's seller terminated through CMD050 after the agency's first purchase",
    fault: "race",
    expect:
      "RACE: the consumer's conversion and TerminateSeller (the claim not listed: its agency already bought) contending, in both orders with the lock wait observed: the claim is CONVERTED once and the entitlement is kept — TERMINATED_WITH_RESIDUAL when the conversion committed first, created after the termination when the termination did — never lost, never EXPIRED by the termination",
  },
  async (ctx) => {
    for (const order of ["CONSUMER_FIRST", "TERMINATION_FIRST"] as const) {
      const what = `termination, ${order}`;
      const c = await converting(`conv-race-term-${order === "CONSUMER_FIRST" ? "1" : "2"}`, [10_000]);
      const sellerId = c.att.sellers[0]!.sellerId;
      const body = await terminationBody(iw, sellerId, []);
      const terminate: Actor = {
        name: "TerminateSeller",
        login: "kauro_app_test",
        holdAt: "uow.before-commit",
        run: (conn) => iw.faults.on(conn, "kauro_app", ctx.points, [], () => call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/terminate`, token: iw.owner.token, agency: null, key: freshKey("conv-race-term"), body })),
      };
      const consumer = consumerActor(ctx, c.delivery);
      const out = order === "CONSUMER_FIRST" ? await contend(ctx, consumer, terminate, what) : await contend(ctx, terminate, consumer, what);
      const reply = mustHaveSettled(order === "CONSUMER_FIRST" ? out.waiter : out.holder, "the termination") as Reply;
      completed<SellerTerminationView>(reply, 200);
      mustHaveSettled(order === "CONSUMER_FIRST" ? out.holder : out.waiter, "the consumer");
      assert.deepEqual(await oracleRows(iw, "SELECT state FROM kauro.sellers WHERE seller_id = $1", [sellerId]), [{ state: "TERMINATED" }]);
      const rights = await rightsOf(c);
      assert.deepEqual([rights.claims, rights.entitlements.map((e) => [e[0], e[2]]), rights.pools, rights.lines], [["CONVERTED"], [[sellerId, 10_000]], 1, 1], `${what}: the claim converted once, its entitlement kept, the purchase accrued for it`);
      assert.equal(rights.entitlements[0]![1], order === "CONSUMER_FIRST" ? "TERMINATED_WITH_RESIDUAL" : "ACTIVE", `${what}: the entitlement's state`);
    }
  },
);

faultCell(
  {
    id: "CONV_RACE",
    step: "Claim conversion and entitlement creation (ACCRUAL_RECONCILIATION), racing the consumer's accrual of the same purchase",
    fault: "race",
    expect:
      "RACE: the ACCRUAL_RECONCILIATION sweep and the COMMISSIONS consumer converting and accruing the same first purchase, in both orders with the lock wait observed: one entitlement per beneficiary, each claim CONVERTED once, one pool and one line per beneficiary, whichever commits first",
  },
  async (ctx) => {
    const shares = [6_000, 4_000];
    for (const order of ["SWEEP_FIRST", "CONSUMER_FIRST"] as const) {
      const what = `reconciliation, ${order}`;
      const c = await converting(`conv-race-recon-${order === "SWEEP_FIRST" ? "1" : "2"}`, shares);
      const sweep = sweepActor(ctx, RECONCILIATION, "the ACCRUAL_RECONCILIATION pass");
      const consumer = consumerActor(ctx, c.delivery);
      const out = order === "SWEEP_FIRST" ? await contend(ctx, sweep, consumer, what) : await contend(ctx, consumer, sweep, what);
      mustHaveSettled(out.holder, "the holder");
      mustHaveSettled(out.waiter, "the waiter");
      assert.deepEqual(await rightsOf(c), convertedFor(c, shares), `${what}: one entitlement per beneficiary, each claim CONVERTED once, one pool and one line per beneficiary`);
    }
  },
);

// =====================================================================================================================================
// 25 (again). CONV_RACE and the lock order of the commercial aggregates (Codex r1 B10G4-R1, decision D10-GAP-20)
// =====================================================================================================================================
// Row locks taken by a foreign key count: an entitlement insert takes the seller's and the agency's row (KEY SHARE), a claim's acceptance and
// an account link the agency's, so a writer that locks a claim and only then reaches its seller or agency can cycle with one that holds them
// first. The claimant has an OPERATIONAL ASSIGNMENT on the agency (the account link CMD050 appends, SELLER_TERMINATED, is the agency FK
// lock), and every schedule stops the holder at an intermediate lock point, where the earlier cells paused at the COMMIT, in both roles.

const AGENCY_LOCK: SqlStep = { label: "agency_lock", match: /pg_advisory_xact_lock\(kauro\.transition_key\('kauro\.agency_commissions'/ };
const CLAIM_LOCK: SqlStep = { label: "claim_lock", match: /FROM kauro\.attribution_claims WHERE claim_id = \$1 FOR (NO KEY )?UPDATE/ };

faultCell(
  {
    id: "CONV_RACE",
    step: "Claim conversion (consumer, ACCRUAL_RECONCILIATION) and TerminateSeller of the claimant, who holds an operational assignment on the agency, paused at the intermediate lock points",
    fault: "race",
    expect:
      "RACE: the conversion paused after its agency lock, the consumer paused between its claim update and its entitlement insert, and TerminateSeller paused right after its claim lock, each against the other command, with the lock wait observed: no deadlock and no failed transaction; the claim CONVERTED once with its entitlement, the account link SELLER_TERMINATED appended, the seller TERMINATED",
  },
  async (ctx) => {
    const schedules = [
      { name: "the sweep holds the agency, TerminateSeller waits", holder: "sweep", holdAt: "db.agency_lock.after" },
      { name: "the consumer holds the claim before its entitlement insert, TerminateSeller waits", holder: "consumer", holdAt: "db.entitlement_insert.before" },
      { name: "TerminateSeller holds its claim lock, the consumer waits", holder: "terminate-consumer", holdAt: "db.claim_lock.after" },
      { name: "TerminateSeller holds its claim lock, the sweep waits", holder: "terminate-sweep", holdAt: "db.claim_lock.after" },
    ] as const;
    for (const sc of schedules) {
      const c = await converting(`conv-lockorder-${sc.holder}`, [10_000]);
      iw.buyers.set(c.agencyId as never, "AGENCY");
      const sellerId = c.att.sellers[0]!.sellerId;
      const assigned = await assignedThrough(iw, c.agencyId, { expectedVersion: 0, sellerId, serviceAssignmentRef: await recordServiceAssignment(iw.h, { ownerUserId: iw.owner.userId as never, agencyId: c.agencyId as never, sellerId }) });
      assert.equal(assigned.sellerId, sellerId, "the claimant holds the agency's operational assignment");
      const body = await terminationBody(iw, sellerId, []);
      const steps = [{ ...AGENCY_LOCK, when: (params: ReadonlyArray<unknown>) => params[0] === c.agencyId }, CLAIM_LOCK, CLAIM_UPDATE, ENTITLEMENT_INSERT];
      const terminate: Actor = {
        name: "TerminateSeller",
        login: "kauro_app_test",
        holdAt: sc.holdAt,
        run: (conn) => iw.faults.on(conn, "kauro_app", ctx.points, steps, () => call(iw.w, { url: `/api/v1/sales/sellers/${sellerId}/terminate`, token: iw.owner.token, agency: null, key: freshKey("conv-lockorder"), body })),
      };
      const consumer: Actor = { name: "the consumer", login: "kauro_commission_test", holdAt: sc.holdAt, run: (conn) => consumeOn(ctx, conn, c.delivery, steps) };
      const sweep: Actor = { name: "the ACCRUAL_RECONCILIATION pass", login: "kauro_commission_test", holdAt: sc.holdAt, run: (conn) => sweepOn(ctx, conn, RECONCILIATION, steps) };
      const [holder, waiter] = sc.holder === "sweep" ? [sweep, terminate] : sc.holder === "consumer" ? [consumer, terminate] : sc.holder === "terminate-consumer" ? [terminate, consumer] : [terminate, sweep];
      const out = await contend(ctx, holder, waiter, sc.name);
      const [termination, other] = holder === terminate ? [out.holder, out.waiter] : [out.waiter, out.holder];
      completed<SellerTerminationView>(mustHaveSettled(termination, "TerminateSeller") as Reply, 200);
      mustHaveSettled(other, "the conversion");
      // a sweep that was only the waiter may have found nothing left to convert: the next pass settles what remains
      await svc.runSweep(RECONCILIATION);
      await svc.consumer.handle(c.delivery as never);
      const rights = await rightsOf(c);
      assert.deepEqual([rights.claims, rights.entitlements.map((e) => e[0]), rights.pools, rights.lines], [["CONVERTED"], [sellerId], 1, 1], `${sc.name}: converted once, the entitlement kept`);
      assert.deepEqual(await oracleRows(iw, "SELECT state FROM kauro.sellers WHERE seller_id = $1", [sellerId]), [{ state: "TERMINATED" }]);
      assert.deepEqual(await oracleRows(iw, "SELECT count(*)::int AS n FROM kauro.account_assignments WHERE agency_id = $1 AND reason = 'SELLER_TERMINATED'", [c.agencyId]), [{ n: 1 }], `${sc.name}: the assignment ended`);
    }
  },
);
