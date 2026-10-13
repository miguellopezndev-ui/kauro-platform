// Seller credit at the database (docs/design/B10-OFFSET.md section 6 F6; D10-NEG-5, OFF-R1, OFF-R2-01, OFF-R3-01): a settled line owed more than it settled
// (an INCREASE above what it was paid, or the cents a partial hold withheld when it was paid, once RELEASED) records the difference as a durable receivable
// in the COMMIT of the write that changed it; CREDIT statement items consume it exactly once.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { invariantsAfterEach } from "../src/testing/invariants.js";
import { refusedWith, corporate, within, service } from "./b10-commission-support.js";
import { asCommission, asOwner, closeOffsetWorld, openOffsetWorld, ordered, refundIn, sellerWith, type OffsetWorld } from "./b10-offset-support.js";
import { creditItemIn, creditStatementIn, draftStatementIn, entriesOf, entryOn, paidLinesWithHolds, paidWithOpenHold, recognizedOf, releaseHold, releaseHoldOn, risenLine, spareFor } from "./b10-credit-support.js";

let ow: OffsetWorld;
invariantsAfterEach(() => ow.w.h.oracle);

before(async () => {
  ow = await openOffsetWorld("b10-seller-credit");
});
after(async () => {
  await closeOffsetWorld(ow);
});

const reconciledRefused = refusedWith("23514", "seller_credit_entries_reconciled");
const withinRecognizedRefused = refusedWith("23514", "statement_items_credit_within_recognized");
const timedOut = refusedWith("57014");
const itemizedOf = async (lineId: string): Promise<number> =>
  (await ow.w.h.oracle.query<{ n: number }>("SELECT kauro.commission_line_credit_itemized($1)::int AS n", [lineId])).rows[0]!.n;
const creditItemsOf = async (lineId: string): Promise<number> =>
  (await ow.w.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.statement_items WHERE line_id = $1 AND item_kind = 'CREDIT'", [lineId])).rows[0]!.n;

test("C02 OK: an INCREASE of a PAID line above what it settled records the difference as seller credit", async () => {
  const r = await risenLine(ow, "c02");
  assert.deepEqual(await entriesOf(ow, r.lineId), [], "paid at its 2-cent entitlement: nothing owed");
  await r.refund(250n);
  assert.deepEqual(await entriesOf(ow, r.lineId), [["RECOGNIZED", 1, "ENTITLEMENT_CHANGED"]], "3 cents owed, 2 paid: one cent recognized in the increase's COMMIT");
  assert.equal(await recognizedOf(ow, r.lineId), 1);
});

test("C03 OK (J): a partial hold withheld when its line was PAID records nothing while OPEN; RELEASED records the held cents as credit; UPHELD with its correction records none", async () => {
  const p = await paidWithOpenHold(ow, "c03-released", 300);
  assert.deepEqual(await entriesOf(ow, p.lineId), [], "the hold is OPEN: X = 1000 - 700 - 300 = 0");
  await releaseHold(ow, p.holdId);
  assert.deepEqual(await entriesOf(ow, p.lineId), [["RECOGNIZED", 300, "HOLD_CHANGED"]], "RELEASED: 300 cents owed");
  const u = await paidWithOpenHold(ow, "c03-upheld", 300);
  await within(ow.w.commission, service(u.ag.agencyId), async (c) => {
    await c.query("UPDATE kauro.commission_holds SET state = 'UPHELD', version = version + 1, upheld_at = kauro.server_now() WHERE hold_id = $1", [u.holdId]);
    await refundIn(c, u.purchase, 7000n, u.seller.agreementVersion);
  });
  assert.deepEqual(await entriesOf(ow, u.lineId), [], "UPHELD with the correcting decrease of 300 in one COMMIT: nothing owed");
  assert.equal((await ow.w.h.oracle.query<{ e: number }>("SELECT cumulative_entitlement_cents::int AS e FROM kauro.commission_lines WHERE line_id = $1", [u.lineId])).rows[0]!.e, 700);
});

test("C04 OK: a decrease after an unitemized credit reverses it (REVERSED) down to the line's due; a credit already itemized is never reversed", async () => {
  const r = await risenLine(ow, "c04");
  await r.refund(250n);
  assert.equal(await recognizedOf(ow, r.lineId), 1);
  await r.refund(230n);
  assert.deepEqual(await entriesOf(ow, r.lineId), [["RECOGNIZED", 1, "ENTITLEMENT_CHANGED"], ["REVERSED", 1, "ENTITLEMENT_CHANGED"]]);
  assert.equal(await recognizedOf(ow, r.lineId), 0);
  // an itemized credit: 300 recognized and itemized, then the line falls by the held cents: R - V stays at itemized while the item is live
  const p = await paidWithOpenHold(ow, "c04-itemized", 300);
  await releaseHold(ow, p.holdId);
  await within(ow.w.commission, corporate, (c) => creditStatementIn(c, ow.periods[1]!, p.seller.sellerId, p.lineId, 300));
  assert.equal(await recognizedOf(ow, p.lineId), 300);
  await within(ow.w.commission, service(p.ag.agencyId), (c) => refundIn(c, p.purchase, 7000n, p.seller.agreementVersion));
  assert.equal(await recognizedOf(ow, p.lineId), 300, "the item is live: the credit it carries is not reversed");
  assert.equal(await itemizedOf(p.lineId), 300);
});

test("C05 DENY: a credit entry that is not the line's reconciled difference, written directly, is refused seller_credit_entries_reconciled and writes nothing", async () => {
  const r = await risenLine(ow, "c05");
  await assert.rejects(within(ow.w.commission, corporate, (c) => entryOn(c, r.seller.sellerId, r.lineId, "RECOGNIZED", 5)), reconciledRefused, "the line owes nothing: a 5-cent credit is fabricated");
  await r.refund(250n);
  await assert.rejects(within(ow.w.commission, corporate, (c) => entryOn(c, r.seller.sellerId, r.lineId, "RECOGNIZED", 1)), reconciledRefused, "the 1-cent difference is already recognized");
  await assert.rejects(within(ow.w.commission, corporate, (c) => entryOn(c, r.seller.sellerId, r.lineId, "REVERSED", 1)), reconciledRefused, "a reversal of credit that is owed");
  assert.deepEqual(await entriesOf(ow, r.lineId), [["RECOGNIZED", 1, "ENTITLEMENT_CHANGED"]]);
});

test("C06 RACE: an INCREASE and a hold RELEASED on one PAID line, both orders: the second waits on the line's subject; either order records the same credit", async () => {
  for (const order of ["increase-first", "release-first"] as const) {
    const r = await risenLine(ow, `c06-${order}`, { hold: true });
    assert.deepEqual(await entriesOf(ow, r.lineId), [], "paid 1 of 2 with 1 held: nothing owed");
    const increase = asCommission((c) => refundIn(c, r.purchase, 250n, r.agreementVersion), service(r.ag.agencyId));
    const release = asOwner(ow, (c) => releaseHoldOn(c, r.holdId!));
    const raced = order === "increase-first" ? await ordered(ow, increase, release) : await ordered(ow, release, increase);
    assert.equal(raced.waited, true, `${order}: the second waits on the line's subject`);
    assert.equal(raced.second.status, "fulfilled", order);
    assert.equal(await recognizedOf(ow, r.lineId), 2, `${order}: E 3, paid 1, nothing held: 2 cents owed either way`);
  }
});

test("C07 DENY: a second live CREDIT item beyond the recognized credit is refused at COMMIT statement_items_credit_within_recognized", async () => {
  const p = await paidWithOpenHold(ow, "c07", 300);
  await releaseHold(ow, p.holdId);
  await within(ow.w.commission, corporate, (c) => creditStatementIn(c, ow.periods[1]!, p.seller.sellerId, p.lineId, 300));
  const second = await spareFor(ow);
  await assert.rejects(within(ow.w.commission, corporate, (c) => creditStatementIn(c, second, p.seller.sellerId, p.lineId, 1)), withinRecognizedRefused, "300 recognized, 300 itemized: one more cent is refused");
  assert.equal(await creditItemsOf(p.lineId), 1);
});

test("DENY: a CREDIT item for a line that is not settled is refused statement_items_credit_guard", async () => {
  const { seller, receivingLines: [eligible] } = await sellerWith(ow, "c-unsettled-eligible", 0, [500]);
  await assert.rejects(
    within(ow.w.commission, corporate, async (c) => {
      const statementId = await draftStatementIn(c, ow.periods[0]!, seller.sellerId, 100);
      await creditItemIn(c, statementId, seller.sellerId, eligible!, 100, 1);
    }),
    refusedWith("23514", "statement_items_credit_guard"),
  );
  assert.equal(await creditItemsOf(eligible!), 0);
});

test("C08 RACE: two direct credit-entry inserts for one line, both orders: the second waits on the line's subject and is refused seller_credit_entries_reconciled unless it is the difference left after the first", async () => {
  const p = await paidWithOpenHold(ow, "c08", 300);
  // an unreconciled difference exists only inside the transaction that changes the line: the release (trigger) records it, then a direct insert of it is refused
  const raced = await ordered(ow, asOwner(ow, (c) => releaseHoldOn(c, p.holdId)), asCommission((c) => entryOn(c, p.seller.sellerId, p.lineId, "RECOGNIZED", 300)));
  assert.equal(raced.waited, true, "the direct insert waits on the subject the release took");
  assert.equal(raced.second.status, "rejected");
  assert.ok(reconciledRefused((raced.second as PromiseRejectedResult).reason), "the release already recorded the 300 cents");
  assert.deepEqual(await entriesOf(ow, p.lineId), [["RECOGNIZED", 300, "HOLD_CHANGED"]]);
});

test("C09 RACE (timeout): a credit-entry insert waiting on its line's subject past its statement timeout rolls back and writes nothing", async () => {
  const p = await paidWithOpenHold(ow, "c09", 300);
  const raced = await ordered(
    ow,
    asOwner(ow, (c) => releaseHoldOn(c, p.holdId)),
    asCommission(async (c) => {
      await c.query("SET LOCAL statement_timeout = '400ms'");
      await entryOn(c, p.seller.sellerId, p.lineId, "RECOGNIZED", 300);
    }),
    { holdMs: 900 },
  );
  assert.equal(raced.second.status, "rejected");
  assert.ok(timedOut((raced.second as PromiseRejectedResult).reason), "57014 query_canceled");
  assert.deepEqual(await entriesOf(ow, p.lineId), [["RECOGNIZED", 300, "HOLD_CHANGED"]], "only the release's own entry: the timed-out insert wrote nothing");
});

test("C10 RACE (timeout): a CREDIT item insert waiting on its line's subject past its statement timeout rolls back: no item, no statement", async () => {
  const p = await paidWithOpenHold(ow, "c10", 300);
  await releaseHold(ow, p.holdId);
  const raced = await ordered(
    ow,
    asCommission((c) => c.query("SELECT kauro.take_commission_line_subject($1, 'EXCLUSIVE')", [p.lineId])),
    asCommission(async (c) => {
      await c.query("SET LOCAL statement_timeout = '400ms'");
      await creditStatementIn(c, ow.periods[1]!, p.seller.sellerId, p.lineId, 300);
    }),
    { holdMs: 900 },
  );
  assert.equal(raced.second.status, "rejected");
  assert.ok(timedOut((raced.second as PromiseRejectedResult).reason));
  assert.equal(await creditItemsOf(p.lineId), 0);
  assert.equal((await ow.w.h.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.commission_statements WHERE seller_id = $1 AND period_id = $2", [p.seller.sellerId, ow.periods[1]])).rows[0]!.n, 0);
});

test("C13 RACE (OFF-R2-01): two 300-cent CREDIT items for one line's 300-cent recognized credit inserted in two statements, both orders: the second waits on the line's subject taken by the item guard and is refused statement_items_credit_within_recognized; 300 itemized", async () => {
  for (const order of [0, 1] as const) {
    const p = await paidWithOpenHold(ow, `c13-${order}`, 300);
    await releaseHold(ow, p.holdId);
    const second = await spareFor(ow);
    const raced = await ordered(
      ow,
      asCommission((c) => creditStatementIn(c, ow.periods[1]!, p.seller.sellerId, p.lineId, 300)),
      asCommission((c) => creditStatementIn(c, second, p.seller.sellerId, p.lineId, 300)),
    );
    assert.equal(raced.waited, true, `order ${order}: the second item waits on the line's subject`);
    assert.equal(raced.second.status, "rejected");
    assert.ok(withinRecognizedRefused((raced.second as PromiseRejectedResult).reason));
    assert.equal(await itemizedOf(p.lineId), 300);
  }
});

test("C18 RACE: two holds RELEASED on one PAID line, both orders: the second waits on the line's subject; credit equals both withheld amounts", async () => {
  const p = await paidWithOpenHold(ow, "c18", [300, 200]);
  const raced = await ordered(ow, asOwner(ow, (c) => releaseHoldOn(c, p.holdIds[0]!)), asOwner(ow, (c) => releaseHoldOn(c, p.holdIds[1]!)));
  assert.equal(raced.waited, true);
  assert.equal(raced.second.status, "fulfilled");
  assert.equal(await recognizedOf(ow, p.lineId), 500);
  assert.deepEqual((await entriesOf(ow, p.lineId)).map((e) => e[1]), [300, 200]);
});

test("C20 RACE (ADV-OFF-1, OFF-R4-02): two CREDIT items inserted in one transaction into a DRAFT statement for L5 then L2, both with recognized credit, while another transaction holds L2's row: the L5 item succeeds, the L2 item is refused KC027 COMMISSION_LOCK_ORDER (not KA004) without waiting; both items roll back", async () => {
  const p = await paidLinesWithHolds(ow, "c20", [300, 200]);
  for (const h of p.holdIds) await releaseHold(ow, h);
  const centsOf = (lineId: string): number => (lineId === p.lineIds[0] ? 300 : 200);
  const [first, second] = [...p.lineIds].sort();
  const raced = await ordered(
    ow,
    asCommission((c) => c.query("SELECT kauro.commission_lock_line_rows(ARRAY[$1::uuid], 'UPDATE')", [second])),
    asCommission(async (c) => {
      const statementId = await draftStatementIn(c, ow.periods[1]!, p.seller.sellerId, 500);
      await creditItemIn(c, statementId, p.seller.sellerId, first!, centsOf(first!), 1);
      await creditItemIn(c, statementId, p.seller.sellerId, second!, centsOf(second!), 2);
    }),
  );
  assert.equal(raced.waited, false, "the L2 item is refused without waiting");
  assert.equal(raced.second.status, "rejected");
  assert.ok(refusedWith("KC027")((raced.second as PromiseRejectedResult).reason));
  assert.equal((await creditItemsOf(first!)) + (await creditItemsOf(second!)), 0, "both items rolled back");
});
