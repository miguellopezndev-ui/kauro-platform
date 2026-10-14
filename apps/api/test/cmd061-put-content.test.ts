// PutOutreachContent — POST /api/v1/ops/outreach/contents — seller or owner (package B12, lane L-DRAFT; companion
// docs/design/B12-outreach-plan-cells.md §R Put row GAP-PC-1, GAP-PC-2; §T content checks). Content-addressed: content_id = sha256 of the
// KAURO_OUTREACH_CONTENT_V1 line (domain outreachContentId); INSERT ... ON CONFLICT DO NOTHING; the checks refuse before any write
// (422 CONTENT_REFUSED). Written FIRST: every title fails until the lane builds put-content.ts and its world; GAP-PC-1 fails under
// KAURO_B12_CONTROL=PC-1 (the content primary key dropped: two rows of one id) and GAP-PC-2 under PC-2 (L1 removed: a content row recorded
// by a seller TERMINATED before it).
import assert from "node:assert/strict";
import { after, before } from "node:test";
import { outreachContentId } from "@kauro/domain";
import {
  answerOf, cell, completedOf, contentRows, contentRowsByBody, draftWorld, ORDERS, putContent, raceAtWrite, safeContent, sellerState, statusCode, T0, W, type DraftWorld,
  type Order, type RaceResult, type SellerP, type Settled,
} from "./b12-draft-support.js";
import type { Reply } from "./support.js";

let w: DraftWorld;
before(async () => {
  w = await draftWorld("cmd061-put");
  w.standAt(T0);
});
after(async () => {
  await w.stop();
});

const replyOf = (s: Settled<unknown>, what: string): Reply => answerOf(s, what) as Reply;
const idOf = (reply: Reply, what: string): string => completedOf<{ contentRef: string }>(reply, 201, what).data.contentRef;

cell("GAP-PC-1 two puts of one body: one row, both 201 same id", "race", async (ctx) => {
  const runs: Array<{ order: Order; content: { subject: string; body: string }; a: SellerP; b: SellerP; race: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const [a, b] = [await w.seller(`pc1-${order}-a`), await w.seller(`pc1-${order}-b`)];
    const content = safeContent(`pc1-${order}`);
    // the first pauses `.after` its INSERT (the row's primary-key tuple is held uncommitted); the second's INSERT waits on it
    const pa = { name: "put-A", role: "kauro_app" as const, run: () => putContent(w, a, content), at: W.contentInsert, after: true as const };
    const pb = { name: "put-B", role: "kauro_app" as const, run: () => putContent(w, b, content), at: W.contentInsert, after: true as const };
    runs.push({ order, content, a, b, race: await raceAtWrite(ctx, "PC-1", order === 1 ? pa : pb, order === 1 ? pb : pa) });
  }
  for (const { order, content, a, b, race } of runs) {
    const id = outreachContentId(content.subject, content.body);
    // forbidden effect first: two rows of one content id
    assert.equal(await contentRowsByBody(w, content.body), 1, `order ${order}: one row of the body`);
    const rows = await contentRows(w, id);
    assert.deepEqual(rows.map((x) => x.recordedBy), [order === 1 ? a.userId : b.userId], `order ${order}: the one row is the first putter's`);
    assert.deepEqual([idOf(replyOf(race.first, "first put"), "first put"), idOf(replyOf(race.second, "second put"), "second put")], [id, id], `order ${order}: both 201 with the same id`);
  }
  assert.deepEqual(runs.map((x) => x.race.secondBlocked), [true, true], "the second waited on the first's uncommitted row in both orders");
});

cell("GAP-PC-2 REVOCATION: CMD050 held at the seller lock L1 in both orders: the put commits then TERMINATED, or 403 and no content row", "race", async (ctx) => {
  const runs: Array<{ order: Order; seller: SellerP; content: { subject: string; body: string }; race: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`pc2-${order}`);
    const content = safeContent(`pc2-${order}`);
    const terminate = { name: "CMD050", role: "kauro_app" as const, run: () => w.routes.terminate(seller), at: W.sellerUpdate };
    const put = { name: "PutOutreachContent", role: "kauro_app" as const, run: () => putContent(w, seller, content), at: W.contentInsert };
    runs.push({ order, seller, content, race: await raceAtWrite(ctx, "PC-2", order === 1 ? terminate : put, order === 1 ? put : terminate) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(await contentRowsByBody(w, o1.content.body), 0, "order 1 (CMD050 holds L1 X): no content row is recorded by the TERMINATED seller");
  assert.equal(statusCode(w, replyOf(o1.race.second, "put")), "403 NOT_AUTHORIZED", "order 1: the put is 403");
  assert.equal(await sellerState(w, o1.seller.sellerId), "TERMINATED");
  const id = idOf(replyOf(o2.race.first, "put"), "order 2 put");
  assert.deepEqual((await contentRows(w, id)).map((x) => x.recordedBy), [o2.seller.userId], "order 2: the put committed one row before the termination");
  assert.equal(await sellerState(w, o2.seller.sellerId), "TERMINATED", "order 2: then TERMINATED");
  assert.deepEqual(runs.map((x) => x.race.secondBlocked), [true, true], "the second waited on the first at L1 in both orders");
});
