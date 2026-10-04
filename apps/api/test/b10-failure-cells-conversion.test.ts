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
import { faultCell, type FaultContext } from "@kauro/persistence/testing";
import { deliver } from "./payment-support.js";
import { agentOf, integrationWorld, oracleRows, orderedThrough, planOf, quoted, type IntegrationWorld } from "./integration-support.js";
import { completed } from "./support.js";
import type { WebhookAck } from "@kauro/application";

let iw: IntegrationWorld;
before(async () => {
  iw = await integrationWorld();
  await installDbFaults();
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
