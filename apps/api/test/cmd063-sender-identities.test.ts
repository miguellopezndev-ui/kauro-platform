// B12 sender identities (lane L-SEND; companion docs/design/B12-outreach-plan-cells.md §R rows RegisterSenderIdentity B12-9, VerifySenderIdentity
// B12-10, RecordSenderRevocation B12-11; plan §M M38). Traces: Register (owner, step-up) L1 (owner + the identity's person) -> L2 -> INSERT
// sender_identities PENDING (unique address); Verify (owner) L1 -> L2 -> L7 X (sender subject) -> UPDATE PENDING -> VERIFIED (T6 refuses any edge out of
// REVOKED); Revocation (owner) L1 -> L2 -> L7 X -> UPDATE -> REVOKED. Written FIRST: every title fails until the lane builds the sender routes.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { answerOf, cell, plusUs, raceAtWrite, sendersAt, sendWorld, senderState, T0, W, type RaceActor, type RaceResult, type SendWorld } from "./b12-send-support.js";
import type { Reply } from "./support.js";

let w: SendWorld;
before(async () => {
  w = await sendWorld("b12-senders");
});
after(async () => {
  await w.stop();
});

type Order = 1 | 2;
const ORDERS: ReadonlyArray<Order> = [1, 2];
const replyOf = (s: RaceResult<unknown, unknown>["first"], what: string): Reply => answerOf(s, what) as Reply;
const address = (label: string): string => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@sender.example`;
const register = (userId: string, addr: string, extra: { readonly consentValidUntil?: string } = {}): Promise<Reply> =>
  w.routes.registerSender({ userId, address: addr, route: "GMAIL_API", consentEvidenceRef: `consent-${addr}`, ...extra });

cell("GAP-RS-1 RACE (registration): two registrations of one address: one row, one 409", "race", async (ctx) => {
  // both: L1 (owner, the seller) -> L2 -> INSERT sender_identities; the second INSERT waits on the first's uncommitted unique key, in both orders
  w.standAt(T0);
  const runs: Array<{ order: Order; addr: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`rs1-${order}`);
    const addr = address(`rs1-${order}`);
    const A: RaceActor<unknown> = { name: "registration A", role: "kauro_app", run: () => register(seller.userId, addr), at: W.senderInsert, after: true };
    const B: RaceActor<unknown> = { name: "registration B", role: "kauro_app", run: () => register(seller.userId, addr.toUpperCase()), at: W.senderInsert, after: true };
    runs.push({ order, addr, r: await raceAtWrite(ctx, "GAP-RS-1", order === 1 ? A : B, order === 1 ? B : A) });
  }
  for (const { order, addr } of runs) assert.equal(await sendersAt(w, addr), 1, `order ${order}: one row of the address, case-insensitively (forbidden: two)`);
  for (const { order, r } of runs) {
    assert.equal(replyOf(r.first, "first").status, 201, `order ${order}: the first 201`);
    assert.equal(replyOf(r.second, "second").status, 409, `order ${order}: the other 409`);
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first's unique key in both orders");
});

test("GAP-RS-2 EXPIRY (consent): consent evidence older than its stated validity refused: a registration whose consentValidUntil is at effect_now is 409 with no row; 1 us after effect_now admitted", async () => {
  w.standAt(T0);
  const seller = await w.seller("rs2");
  const stale = address("rs2-stale");
  const reply = await register(seller.userId, stale, { consentValidUntil: T0 });
  assert.equal(reply.status, 409, `consent valid until effect_now is refused: ${reply.text}`);
  assert.equal(await sendersAt(w, stale), 0, "no row");
  const older = address("rs2-older");
  assert.equal((await register(seller.userId, older, { consentValidUntil: plusUs(T0, -1) })).status, 409, "consent valid until 1 us before effect_now is refused");
  assert.equal(await sendersAt(w, older), 0);
  const fresh = address("rs2-fresh");
  const ok = await register(seller.userId, fresh, { consentValidUntil: plusUs(T0, 1) });
  assert.equal(ok.status, 201, `consent valid 1 us after effect_now is admitted: ${ok.text}`);
  assert.equal(await sendersAt(w, fresh), 1);
  const id = ok.json<{ senderId: string }>().senderId;
  assert.equal(await senderState(w, id), "PENDING", "admitted PENDING (verification is a separate step)");
});

cell("GAP-RS-3 RACE (seller): RegisterSenderIdentity for a seller against CMD050 terminating it, held at the seller subject L1 in both orders: order 1 (CMD050 holds) refused and no row; order 2 (registration holds) one PENDING row, then TERMINATED; red with L1 removed from both (a sender row of a TERMINATED seller born after the termination committed)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; addr: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`rs3-${order}`);
    const addr = address(`rs3-${order}`);
    const R: RaceActor<unknown> = { name: "RegisterSenderIdentity", role: "kauro_app", run: () => register(seller.userId, addr), at: W.senderInsert };
    const T: RaceActor<unknown> = { name: "CMD050", role: "kauro_app", run: () => w.routes.terminate(seller), at: W.sellerUpdate };
    runs.push({ order, addr, r: await raceAtWrite(ctx, "RS-3", order === 1 ? T : R, order === 1 ? R : T) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(await sendersAt(w, o1.addr), 0, "order 1: no sender row of the TERMINATED seller (forbidden effect)");
  assert.ok([403, 409].includes(replyOf(o1.r.second, "registration").status), `order 1: refused (${replyOf(o1.r.second, "registration").status})`);
  assert.equal(replyOf(o2.r.first, "registration").status, 201, "order 2: registered");
  assert.equal(await sendersAt(w, o2.addr), 1, "order 2: one PENDING row");
  assert.ok(replyOf(o2.r.second, "CMD050").status < 300, "order 2: then TERMINATED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-VS-1 RACE (verify vs revoke) M38: verify vs revoke held at L7: one terminal answer: VerifySenderIdentity of a PENDING identity against RecordSenderRevocation of it, held at the sender subject L7 in both orders: order 1 (verify holds) VERIFIED, then REVOKED; order 2 (revocation holds) REVOKED and verify 409; REVOKED stays in both; red with L7 removed from both and T6 dropped (a VERIFIED sender after REVOKED committed)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; senderId: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`vs1-${order}`);
    const pending = await w.sender(seller, { pending: true });
    assert.equal(await senderState(w, pending.senderId), "PENDING");
    const V: RaceActor<unknown> = { name: "VerifySenderIdentity", role: "kauro_app", run: () => w.routes.verifySender(pending.senderId), at: W.senderUpdate };
    const R: RaceActor<unknown> = { name: "RecordSenderRevocation", role: "kauro_app", run: () => w.routes.revokeSender(pending.senderId), at: W.senderUpdate };
    runs.push({ order, senderId: pending.senderId, r: await raceAtWrite(ctx, "M38", order === 1 ? V : R, order === 1 ? R : V) });
  }
  for (const { order, senderId } of runs) assert.equal(await senderState(w, senderId), "REVOKED", `order ${order}: REVOKED stays (forbidden: VERIFIED after REVOKED committed)`);
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.ok(replyOf(o1.r.first, "verify").status < 300, "order 1: VERIFIED first");
  assert.ok(replyOf(o1.r.second, "revoke").status < 300, "order 1: then REVOKED");
  assert.ok(replyOf(o2.r.first, "revoke").status < 300, "order 2: REVOKED");
  assert.equal(replyOf(o2.r.second, "verify").status, 409, "order 2: verify 409 (one terminal answer)");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});
