// The offset amount bounds at the database (docs/design/B10-KIT-SUITES.md section 2.3, docs/design/B10-OFFSET.md section 6 F1; D10-NEG-1, D10-NEG-4,
// R2-104; migrations 0030 and 0055 commission_offsets_authorized): an offset is admitted only from a settled source (PAID or ADJUSTED, or PAYABLE through
// a noncash-settled item) within the position its source has left after its live claims, and only against an ELIGIBLE receiving line within
// what it can still pay after its OPEN holds and the live claims against it. These are insert-time facts, not state invariants (r3 R3-01: a later
// one-cent INCREASE is legal and leaves an earlier offset beyond the position), so these DENY tests carry them, one per predicate of the guard.
// Every refusal is the named check violation commission_offsets_amount or commission_offsets_applicable (23514) and writes nothing.
// Negative positions are built as production builds them: a line paid through its statement and settled payout, then a refund lowering
// its pool's basis (the COMMISSIONS consumer's recomputation, the line walked PAID -> ADJUSTED); receiving lines are ELIGIBLE.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { invariantsAfterEach } from "../src/testing/invariants.js";
import type { Client } from "pg";
import { refusedWith, ids, corporate, within, ownerOf, issueStatement } from "./b10-commission-support.js";
import { asCommission, asOwner, closeOffsetWorld, extraPeriod, offset, offsetOn, openHoldOn, ordered, releasesOf as releasesOfIn, offsetsOf as offsetsOfIn, openHold, openOffsetWorld, refundTo, sellerWith as sellerWithIn, liveOf as liveOfIn, type OffsetWorld, type Seller } from "./b10-offset-support.js";

let ow: OffsetWorld;
invariantsAfterEach(() => ow.w.h.oracle);

before(async () => {
  ow = await openOffsetWorld("b10-offset-bounds");
});
after(async () => {
  await closeOffsetWorld(ow);
});

const sellerWith = (label: string, negatives: number, receiving: ReadonlyArray<number>) => sellerWithIn(ow, label, negatives, receiving);
const offsetsOf = (seller: Seller) => offsetsOfIn(ow, seller);
const liveOf = (seller: Seller) => liveOfIn(ow, seller);
const record = (seller: Seller, n: string, a: string, cents: number) => offset(ow, seller, n, a, cents);
void [ids, corporate, within, offsetOn, refundTo, liveOf, assert];
const amountRefused = refusedWith("23514", "commission_offsets_amount");

test("DENY: an offset of 101 cents against an unpaid 100-cent line with a 1000-cent negative position is refused commission_offsets_amount and writes nothing", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-receiving", 1, [100]);
  await assert.rejects(record(seller, n!, r!, 101), amountRefused, "beyond the receiving line's unpaid amount");
  assert.deepEqual(await offsetsOf(seller), [], "the refused offset wrote nothing");
  await record(seller, n!, r!, 100);
  assert.deepEqual(await offsetsOf(seller), [[n, r, 100]]);
});

test("DENY: offsets of one negative line against two receiving lines whose sum exceeds the negative position are refused at the cent that exceeds it", async () => {
  const { seller, negativeLines: [n], receivingLines: [r1, r2] } = await sellerWith("bounds-negative-aggregate", 1, [600, 600]);
  await record(seller, n!, r1!, 600);
  await assert.rejects(record(seller, n!, r2!, 401), amountRefused, "600 offset, 400 left of the 1000-cent position: 401 exceeds it by one cent");
  assert.deepEqual(await offsetsOf(seller), [[n, r1, 600]], "the refused offset wrote nothing");
  await record(seller, n!, r2!, 400);
  await assert.rejects(record(seller, n!, r2!, 1), amountRefused, "the position is exhausted although the receiving line has 200 unpaid left");
  assert.deepEqual(await offsetsOf(seller), [[n, r1, 600], [n, r2, 400]]);
});

test("DENY: two negative lines of one seller each offset within its own position, a third offset exceeding one line's remaining position refused", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-per-negative-line", 2, [5000]);
  await record(seller, n1!, r!, 700);
  await record(seller, n2!, r!, 700);
  await assert.rejects(record(seller, n1!, r!, 301), amountRefused, "the first line has 300 of its position left");
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 700], [n2, r, 700]], "the refused offset wrote nothing");
  await record(seller, n1!, r!, 300);
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 700], [n2, r, 700], [n1, r, 300]]);
});

test("DENY: two distinct negative lines of one seller, each within its own position, whose offsets against ONE receiving line together exceed that line's unpaid amount are refused at the cent that exceeds it", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-receiving-aggregate", 2, [1000]);
  await record(seller, n1!, r!, 600);
  await assert.rejects(record(seller, n2!, r!, 401), amountRefused, "the receiving line has 400 unpaid left after the first line's offset");
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 600]], "the refused offset wrote nothing");
  await record(seller, n2!, r!, 400);
  assert.deepEqual(await offsetsOf(seller), [[n1, r, 600], [n2, r, 400]]);
});

const applicableRefused = refusedWith("23514", "commission_offsets_applicable");
const holdIds = async (lineId: string): Promise<string[]> =>
  (await ow.w.h.oracle.query<{ hold_id: string }>("SELECT hold_id FROM kauro.commission_holds WHERE line_id = $1 ORDER BY opened_at", [lineId])).rows.map((r) => r.hold_id);
const releasedOf = async (seller: Seller): Promise<ReadonlyArray<readonly [string, number]>> => releasesOfIn(ow, seller);
const offsetIdOf = async (seller: Seller): Promise<string> =>
  (await ow.w.h.oracle.query<{ offset_id: string }>("SELECT offset_id FROM kauro.commission_offsets WHERE seller_id = $1 ORDER BY recorded_at, offset_id", [seller.sellerId])).rows[0]!.offset_id;
const releaseOn = (c: Client, offsetId: string, seller: Seller, cents: number): Promise<unknown> =>
  c.query("INSERT INTO kauro.commission_offset_releases (release_id, offset_id, seller_id, amount_cents, cause, recorded_at, created_at) VALUES ($1, $2, $3, $4, 'ENTITLEMENT_DECREASED', kauro.server_now(), now())", [ids.next(), offsetId, seller.sellerId, cents]);

test("DENY: an offset beyond the receiving line's unpaid amount less its OPEN partial hold is refused commission_offsets_amount and writes nothing (held cents are never claimed, D10-NEG-4)", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t05", 1, [1000]);
  await openHold(ow, r!, 400);
  await assert.rejects(record(seller, n!, r!, 601), amountRefused, "1000 unpaid, 400 held: 600 left");
  assert.deepEqual(await offsetsOf(seller), []);
  await record(seller, n!, r!, 600);
  assert.deepEqual(await liveOf(seller), [600]);
});

test("DENY: the capacity less an OPEN hold is shared by every offset against the line: a second negative line's offset beyond what the first left of unpaid-minus-held is refused", async () => {
  const { seller, negativeLines: [n1, n2], receivingLines: [r] } = await sellerWith("bounds-t06", 2, [1000]);
  await openHold(ow, r!, 300);
  await record(seller, n1!, r!, 500);
  await assert.rejects(record(seller, n2!, r!, 201), amountRefused, "1000 unpaid, 300 held, 500 claimed: 200 left");
  await record(seller, n2!, r!, 200);
  assert.deepEqual(await liveOf(seller), [500, 200]);
});

test("a RELEASED hold withholds nothing: the offset may use the line's whole unpaid amount again", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t07", 1, [1000]);
  await openHold(ow, r!, 400);
  const [holdId] = await holdIds(r!);
  await within(ow.w.app, ownerOf(ow.w), (c) => c.query("UPDATE kauro.commission_holds SET state = 'RELEASED', version = version + 1, released_at = kauro.server_now() WHERE hold_id = $1", [holdId]));
  await record(seller, n!, r!, 1000);
  assert.deepEqual(await liveOf(seller), [1000]);
});

test("DENY: an offset against a PAYABLE receiving line (payable through an ISSUED statement, which applies no later offset) is refused commission_offsets_applicable and writes nothing", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t08", 1, [1000]);
  await issueStatement(ow.w, await extraPeriod(ow), seller, [r!]);
  await assert.rejects(record(seller, n!, r!, 100), applicableRefused);
  assert.deepEqual(await offsetsOf(seller), []);
});

test("DENY: an offset FROM a line never paid (paid_cents NULL: no negative position) is refused commission_offsets_amount and writes nothing", async () => {
  const { seller, receivingLines: [r1, r2] } = await sellerWith("bounds-t10", 0, [600, 600]);
  await assert.rejects(record(seller, r1!, r2!, 1), amountRefused, "an ELIGIBLE line was never settled");
  assert.deepEqual(await offsetsOf(seller), []);
});

test("RACE: a 600-cent offset and a 500-cent hold on ONE 1000-cent ELIGIBLE line, both orders: the second waits on the first's line lock; hold first, the offset is refused beyond the 500 left; offset first, the hold opens and releases 100 of the offset (D10-NEG-4)", async () => {
  {
    const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t13-hold-first", 1, [1000]);
    const raced = await ordered(ow, asOwner(ow, (c) => openHoldOn(c, r!, 500)), asCommission((c) => offsetOn(c, seller, n!, r!, 600)));
    assert.equal(raced.waited, true, "the offset waits behind the hold's subject");
    assert.equal(raced.second.status, "rejected");
    assert.ok(amountRefused((raced.second as PromiseRejectedResult).reason), "refused beyond the 500 left");
    assert.deepEqual(await offsetsOf(seller), []);
  }
  {
    const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t13-offset-first", 1, [1000]);
    const raced = await ordered(ow, asCommission((c) => offsetOn(c, seller, n!, r!, 600)), asOwner(ow, (c) => openHoldOn(c, r!, 500)));
    assert.equal(raced.waited, true, "the hold waits behind the offset's subject");
    assert.equal(raced.second.status, "fulfilled");
    assert.deepEqual(await liveOf(seller), [500]);
    assert.deepEqual(await releasedOf(seller), [["HOLD_OPENED", 100]]);
  }
});

test("OK: a hold opened after an offset on an ELIGIBLE line opens whatever the offsets: 1000 unpaid, 900 offset, a 101-cent hold opens and releases 1 cent of the offset to the negative line (D10-NEG-4)", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t14", 1, [1000]);
  await record(seller, n!, r!, 900);
  await openHold(ow, r!, 101);
  assert.deepEqual(await liveOf(seller), [899]);
  assert.deepEqual(await releasedOf(seller), [["HOLD_OPENED", 1]]);
});

test("DENY: the negative position counts only live claims: after a refund released 200 of a 600-cent offset of a 1000-cent position, 600 more is admitted and 601 refused", async () => {
  const { seller, ag, negativeLines: [n], receivingLines: [r1, r2], receivingPurchases: [p1] } = await sellerWith("bounds-t18", 1, [1000, 1000]);
  await record(seller, n!, r1!, 600);
  await refundTo(ow, ag, p1!, 4000n, seller.agreementVersion);
  assert.deepEqual(await liveOf(seller), [400], "the refund of the receiving line lowered its capacity to 400 and released 200");
  await assert.rejects(record(seller, n!, r2!, 601), amountRefused, "1000 position less 400 live leaves 600");
  await record(seller, n!, r2!, 600);
  assert.deepEqual(await liveOf(seller), [400, 600]);
});

test("DENY: a release beyond its offset's live amount, written directly by the commission service, is refused commission_offset_releases_within_live and writes nothing", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t22", 1, [1000]);
  await record(seller, n!, r!, 600);
  const offsetId = await offsetIdOf(seller);
  await assert.rejects(within(ow.w.commission, corporate, (c) => releaseOn(c, offsetId, seller, 601)), refusedWith("23514", "commission_offset_releases_within_live"));
  assert.deepEqual(await liveOf(seller), [600]);
  await within(ow.w.commission, corporate, (c) => releaseOn(c, offsetId, seller, 600));
  assert.deepEqual(await liveOf(seller), [0]);
});

test("RACE: two direct 400-cent releases of one live 600-cent offset, both orders: the second waits on the receiving line's subject taken by the INSERT guard and is refused commission_offset_releases_within_live; 400 released", async () => {
  const { seller, negativeLines: [n], receivingLines: [r] } = await sellerWith("bounds-t24", 1, [1000]);
  await record(seller, n!, r!, 600);
  const offsetId = await offsetIdOf(seller);
  const release = (c: Client) => releaseOn(c, offsetId, seller, 400);
  const raced = await ordered(ow, asCommission(release), asCommission(release));
  assert.equal(raced.waited, true);
  assert.equal(raced.second.status, "rejected");
  assert.ok(refusedWith("23514", "commission_offset_releases_within_live")((raced.second as PromiseRejectedResult).reason));
  assert.deepEqual(await liveOf(seller), [200]);
});

test("RACE: a 600-cent offset and a refund lowering its 1000-cent receiving line to 400, both orders: refund first, the offset is refused beyond 400; offset first, the refund releases 200; never more than 400 claimed", async () => {
  {
    const { seller, ag, negativeLines: [n], receivingLines: [r], receivingPurchases: [p] } = await sellerWith("bounds-t19-refund-first", 1, [1000]);
    await refundTo(ow, ag, p!, 4000n, seller.agreementVersion);
    await assert.rejects(record(seller, n!, r!, 600), amountRefused);
    await record(seller, n!, r!, 400);
    assert.deepEqual(await liveOf(seller), [400]);
  }
  {
    const { seller, ag, negativeLines: [n], receivingLines: [r], receivingPurchases: [p] } = await sellerWith("bounds-t19-offset-first", 1, [1000]);
    await record(seller, n!, r!, 600);
    await refundTo(ow, ag, p!, 4000n, seller.agreementVersion);
    assert.deepEqual(await liveOf(seller), [400]);
    assert.deepEqual(await releasedOf(seller), [["ENTITLEMENT_DECREASED", 200]]);
  }
});
