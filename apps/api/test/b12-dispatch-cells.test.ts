// B12 outreach dispatcher cells (lane L-SEND, tier 1; plan docs/design/B12-outreach-plan.md rev 4 §1 R2-129..132, Dispatcher D1-D6 rows,
// §M M3, M4, M4b, M8, M9, M10, M12, M14, M14b, M18-M22, M26, M27, M30, M45, §W D2/D3/D5/HUMAN rows, provider warnings GAP-HP-1..6).
// Units (apps/api/src/outreach/dispatcher.ts, lease OUTBOX_DISPATCH "b12-outreach-dispatcher", login kauro_outreach SERVICE):
//   D2 claim  L1 set S -> L3 S -> L4 (X first contact | S follow-up) -> L4g S -> L5 S -> L6 S -> L6p S -> L7 S -> L8 S -> L10 X -> L13 FOR SHARE -> effect_now -> rechecks -> UPDATE
//   D3 call   outside any transaction: gate statement (effect_now <= submitted_at + startGate), then port.submit with AbortSignal.timeout(callBound)
//   D4 answer L1 set S -> L3 S -> L4 (X on a 403/429 warning, else S) -> L4g S -> L7 X (AUTH_REVOKED only) -> L10 X -> L13 (attempted) -> effect_now -> edge | evidence path (D4b)
//   D5 recover L1 set S -> L3 S -> L4 S -> L4g S -> L10 X -> L13 -> SUBMITTING past uncertain_after -> SEND_UNCERTAIN, no call
// Providers are K1's labelled contract fakes (SIMULATED). Written FIRST: every title fails until the lane builds the dispatcher; every §M cell
// fails under its control (KAURO_B12_CONTROL=<M>) at its forbidden-effect assertion, which each body asserts before the observed block.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connectionPid, type FaultContext } from "@kauro/persistence/testing";
import {
  activate, activityKinds, answerOf, callsOf, cell, D4_GRACE_MS, DAY_MS, draftRow, draftState, evidenceOf, firstContacts, firstContacts24h, grantReserved, holdLease,
  holdSubject, intent, intentIdOf, intentsOfDraft, LEASE_TTL_MS, msOf, onEffectClock, OUTCOME, outboxOf, plusMs, plusUs, prospectState, queued, raceAtWrite,
  rev2OrderControl, send, sendWorld, senderState, sentFirst, staged, START_GATE_MS, stateOf, T0, tokenOf, UNCERTAIN_AFTER_MS, W, waitingBehind, warningsOf,
  type ClassifiedAnswer, type Dispatcher, type DraftP, type DraftState, type GrantP, type RaceActor, type RaceResult, type SellerP, type SendWorld, type Staged,
} from "./b12-send-support.js";
import type { Reply } from "./support.js";

let w: SendWorld;
before(async () => {
  w = await sendWorld("b12-dispatch");
});
after(async () => {
  await w.stop();
});

type Order = 1 | 2;
const ORDERS: ReadonlyArray<Order> = [1, 2];
const D = (): Dispatcher => w.dispatcher();
const out = (r: Reply): string => w.outcome(r);
const WARNING_INSERT = { label: "warning_insert", match: /INSERT INTO kauro\.outreach_provider_warnings\b/ } as const;
const D3_GATE = { label: "d3_gate", match: /kauro\.effect_now\(\)/ } as const;

/** A cell whose dispatcher takes over the OUTBOX_DISPATCH lease runs in a world of its own, so the file's lease stays with its one dispatcher. */
async function ownWorld(label: string, body: () => Promise<void>): Promise<void> {
  const saved = w;
  w = await sendWorld(label);
  try {
    await body();
  } finally {
    await w.stop();
    w = saved;
    activate(saved);
  }
}
const d2Actor = (name: string, disp: Dispatcher, intentId: string): RaceActor<unknown> => ({ name, role: "kauro_outreach", run: () => disp.dispatch(intentId), at: W.intentUpdate });
const settledOk = (s: RaceResult<unknown, unknown>["first"], what: string): unknown => answerOf(s, what);
const replyOf = (s: RaceResult<unknown, unknown>["first"], what: string): Reply => answerOf(s, what) as Reply;
const human = (actor: SellerP, intentId: string, observation: "SENT" | "NOT_SENT"): Promise<Reply> =>
  w.routes.recordActivity(actor, { kind: "HUMAN_SEND_OBSERVED", intentId, observation, evidenceRef: `observed-${observation}-${intentId}` });
/** The claim + call of one intent, the call answered `answer` by the fake: D3's classified answer (D4 not run). */
async function claimedAndCalled(disp: Dispatcher, intentId: string, answer: Parameters<SendWorld["gmail"]["script"]>[0]): Promise<ClassifiedAnswer> {
  assert.equal(await disp.claim(intentId), "ADMITTED", "D2 admitted the intent");
  w.gmail.script(answer);
  return disp.submit(intentId);
}
/** A redelivery and a recovery never submit an open SEND_UNCERTAIN again, and CMD063 of another draft of its prospect is 409 KC029. */
async function uncertainStaysClosed(what: string, s: Staged, intentId: string): Promise<void> {
  const i = await intent(w, intentId);
  assert.deepEqual([i.state, await draftState(w, s.draft)], ["SEND_UNCERTAIN", "SEND_UNCERTAIN"], `${what}: intent and draft SEND_UNCERTAIN`);
  assert.equal(callsOf(w, intentId), 1, `${what}: exactly one submission`);
  await D().dispatch(intentId);
  await D().recover();
  w.standAt(plusMs(i.uncertainAfter ?? T0, D4_GRACE_MS + 1_000));
  await D().pass();
  assert.equal(callsOf(w, intentId), 1, `${what}: redelivery and recovery never submit again`);
  assert.equal((await intent(w, intentId)).state, "SEND_UNCERTAIN", `${what}: still SEND_UNCERTAIN`);
  const other = await w.draft(s.seller, s.prospect, s.seller.sender, { label: `${what}-other` });
  const g = await w.grant([other]);
  assert.equal(out(await send(w, s.seller, other, g)), OUTCOME.KC029, `${what}: CMD063 409 KC029 while it is open`);
}

// --- R2-129 ------------------------------------------------------------------------------------------------------------------------------
cell("R2-129: the Gmail fake accepts but the answer is lost (timeout, reset, crash after SUBMITTING, lease taken over during the call): SEND_UNCERTAIN (draft SEND_UNCERTAIN), exactly one submission, redelivery and recovery never submit again, CMD063 409 KC029 while it is open", "crash-before-commit", async (ctx) => {
  for (const lost of [{ kind: "TIMEOUT" }, { kind: "RESET" }] as const) {
    w.standAt(T0);
    const s = await staged(w, `r129-${lost.kind}`);
    const id = await queued(w, s);
    w.gmail.script(lost);
    await D().dispatch(id);
    await uncertainStaysClosed(`R2-129 ${lost.kind}`, s, id);
  }
  {
    // crash after SUBMITTING: the fake accepted; D4 dies before its COMMIT; D5 at uncertain_after moves it to SEND_UNCERTAIN
    w.standAt(T0);
    const s = await staged(w, "r129-crash");
    const id = await queued(w, s);
    const answer = await claimedAndCalled(D(), id, { kind: "ACCEPTED", ref: "gmail-r129-crash" });
    assert.equal(answer.kind, "ACCEPTED");
    const crash = ctx.points.crash("target.before-commit");
    const conn = await w.open("kauro_outreach_test");
    try {
      await ctx.operation("D4 crashed before its COMMIT", () => w.on(conn, "kauro_outreach", ctx, [], () => D().record(id, answer), { target: 1 }).catch((e: unknown) => e));
      await crash.reached;
    } finally {
      await conn.end().catch(() => undefined);
    }
    assert.equal((await intent(w, id)).state, "SUBMITTING", "the answer was lost with the crash");
    w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS));
    await D().recover();
    await uncertainStaysClosed("R2-129 crash", s, id);
  }
  await ownWorld("r129-takeover", async () => {
    // lease taken over during the call: the old owner's call is held open, its lease expires, a new owner takes over and recovers
    w.standAt(T0);
    const s = await staged(w, "r129-takeover");
    const id = await queued(w, s);
    const old = w.dispatcher("r129-old");
    assert.equal(await old.claim(id), "ADMITTED");
    const held = w.gmail.holdNext();
    const call = old.submit(id);
    await held.reached;
    w.standAt(plusMs(T0, LEASE_TTL_MS + 1_000));
    const neu = w.dispatcher("r129-new");
    assert.ok((await neu.takeOver()) > (old.fence ?? 0), "the new owner's fence is higher");
    held.answer({ kind: "ACCEPTED_ANSWER_LOST" });
    await call;
    await neu.recover();
    await uncertainStaysClosed("R2-129 takeover", s, id);
  });
  w.standAt(T0);
}, "target");

test("R2-129 (5xx): a Gmail 503 after the body was sent is SEND_UNCERTAIN, never NOT_SENT; zero further submissions", async () => {
  w.standAt(T0);
  const s = await staged(w, "r129-5xx");
  const id = await queued(w, s);
  w.gmail.script({ kind: "HTTP_5XX", status: 503 });
  await D().dispatch(id);
  assert.equal(stateOf(await intent(w, id)), "SEND_UNCERTAIN", "a 503 is SEND_UNCERTAIN, never NOT_SENT");
  await uncertainStaysClosed("R2-129 5xx", s, id);
  w.standAt(T0);
});

test("R2-129 (port misclassification): REJECTED_DEFINITIVE{500} from the port is SEND_UNCERTAIN, zero further submissions", async () => {
  w.standAt(T0);
  const s = await staged(w, "r129-500");
  const id = await queued(w, s);
  w.gmail.script({ kind: "REJECTED_DEFINITIVE", status: 500 });
  await D().dispatch(id);
  assert.equal(stateOf(await intent(w, id)), "SEND_UNCERTAIN", "a definitive refusal outside the closed set {400, 403, 413, 429} is uncertain");
  await uncertainStaysClosed("R2-129 500", s, id);
  w.standAt(T0);
});

test("R2-129 (observed sent): after HUMAN_SEND_OBSERVED SENT the intent is OBSERVED_SENT, the draft PROVIDER_ACCEPTED, a CMD063 of the draft is 409 KC036 and the message counts in the 14-day cadence and the person cap", async () => {
  w.standAt(T0);
  const seller = await w.seller("r129-obs-sent");
  await firstContacts(w, seller, 9, "r129-obs-sent");
  const s = await staged(w, "r129-obs-sent-x", { seller, maximumSends: 2 });
  const id = await queued(w, s);
  w.gmail.script({ kind: "TIMEOUT" });
  await D().dispatch(id);
  assert.equal((await intent(w, id)).state, "SEND_UNCERTAIN");
  w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS));
  assert.ok((await human(seller, id, "SENT")).status < 300, "HUMAN_SEND_OBSERVED SENT recorded");
  assert.equal((await intent(w, id)).state, "OBSERVED_SENT");
  assert.equal(await draftState(w, s.draft), "PROVIDER_ACCEPTED");
  assert.equal(out(await send(w, seller, s.draft, s.grant)), OUTCOME.KC036, "CMD063 of the draft 409 KC036");
  assert.equal(await firstContacts24h(w, seller.userId, plusMs(T0, UNCERTAIN_AFTER_MS)), 10, "it counts in the person cap: 10 of 10");
  const eleventh = await staged(w, "r129-obs-sent-11", { seller });
  const r = await send(w, seller, eleventh.draft, eleventh.grant);
  assert.deepEqual([out(r), w.subReason(r)], [OUTCOME.KC032, "CAP_REACHED"], "the 11th first contact refused");
  w.standAt(plusMs(T0, 7 * DAY_MS));
  const f = await w.draft(seller, s.prospect, seller.sender, { purpose: "FOLLOW_UP" });
  const g = await w.grant([f]);
  assert.equal((await send(w, seller, f, g)).status, 200, "its follow-up window [first + 5 business days, first + 14 days) is anchored on it");
  w.standAt(T0);
});

test("R2-129 (observed not sent): draft SEND_UNCERTAIN before, HUMAN_SEND_OBSERVED NOT_SENT moves the intent to OBSERVED_NOT_SENT and the draft to DRAFT (same version and hash, so the grant still binds it); one repeat CMD063 is admitted and submitted once; a second repeat is 409 KC036", async () => {
  w.standAt(T0);
  const s = await staged(w, "r129-obs-not");
  const id = await queued(w, s);
  w.gmail.script({ kind: "TIMEOUT" });
  await D().dispatch(id);
  assert.equal(await draftState(w, s.draft), "SEND_UNCERTAIN", "draft SEND_UNCERTAIN before");
  const before = await draftRow(w, s.draft);
  const ua = (await intent(w, id)).uncertainAfter!;
  w.standAt(ua);
  assert.ok((await human(s.seller, id, "NOT_SENT")).status < 300, "HUMAN_SEND_OBSERVED NOT_SENT recorded");
  assert.equal((await intent(w, id)).state, "OBSERVED_NOT_SENT");
  assert.deepEqual(await draftRow(w, s.draft), { ...before, state: "DRAFT" }, "draft DRAFT at the same version and hash");
  assert.equal(await grantReserved(w, s.grant), 0, "the observed-not-sent intent no longer reserves the one-send grant");
  const repeat = intentIdOf(await send(w, s.seller, s.draft, s.grant));
  w.standAt(plusMs(ua, D4_GRACE_MS));
  await D().dispatch(repeat);
  assert.deepEqual([callsOf(w, repeat), (await intent(w, repeat)).state], [1, "PROVIDER_ACCEPTED"], "the repeat submitted once and accepted");
  assert.equal(callsOf(w, id), 1, "the first intent was submitted once");
  assert.equal(out(await send(w, s.seller, s.draft, s.grant)), OUTCOME.KC036, "a second repeat is 409 KC036");
  w.standAt(T0);
});

// --- R2-130 ------------------------------------------------------------------------------------------------------------------------------
cell("R2-130 (cross-seller): the public opt-out through the token of P1's submitted message (taken from the MIME the fake recorded) against the claim of another seller's prospect P2 with the same contact key, held at the suppression key L8 (the only lock they share): order 1 opt-out first: NOT_SENT(SUPPRESSED), zero calls, P2 shown suppressed; order 2 claim first: exactly one submission, the opt-out commits after it, the next intent to that contact NOT_SENT(SUPPRESSED) with zero calls; red with D2's L8 removed", "race", async (ctx) => {
  // traces: opt-out L8 X (contact key) -> L14 prospect rows; D2 of P2 L1 S(seller B) -> L3 S(P2) -> L4 X(B) -> ... -> L8 S(K) -> L10 X: they share only L8
  w.standAt(T0);
  const runs: Array<{ order: Order; p2: Staged; i2: string; i3: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const contact = `m21-${order}-${Date.now()}@contact.example`;
    const sellerA = await w.seller(`m21-${order}-a`);
    const p1 = await staged(w, `m21-${order}-a`, { seller: sellerA, prospect: await w.prospect(sellerA, { contact }) });
    const sent = await sentFirst(w, p1);
    const token = tokenOf(w, sent);
    const sellerB = await w.seller(`m21-${order}-b`);
    const p2 = await staged(w, `m21-${order}-b`, { seller: sellerB, prospect: await w.prospect(sellerB, { contact }) });
    const i2 = await queued(w, p2);
    const sellerC = await w.seller(`m21-${order}-c`);
    const p3 = await staged(w, `m21-${order}-c`, { seller: sellerC, prospect: await w.prospect(sellerC, { contact }) });
    const i3 = await queued(w, p3);
    const O: RaceActor<unknown> = { name: "public opt-out", role: "kauro_app", run: () => w.routes.optOut(token), at: W.suppressionInsert };
    const C = d2Actor("D2 of P2", D(), i2);
    runs.push({ order, p2, i2, i3, r: await raceAtWrite(ctx, "M21", order === 1 ? O : C, order === 1 ? C : O) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.i2), 0, "order 1: zero calls to the suppressed contact (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.i2)), "NOT_SENT(SUPPRESSED)");
  assert.equal(await prospectState(w, o1.p2.prospect), "SUPPRESSED", "order 1: P2 shown suppressed");
  assert.equal(callsOf(w, o2.i2), 1, "order 2: exactly one submission");
  assert.ok(replyOf(o2.r.second, "opt-out").status < 300, "order 2: the opt-out commits after it");
  for (const { order, i3 } of runs) {
    await D().dispatch(i3);
    assert.deepEqual([stateOf(await intent(w, i3)), callsOf(w, i3)], ["NOT_SENT(SUPPRESSED)", 0], `order ${order}: the next intent to that contact NOT_SENT(SUPPRESSED) with zero calls`);
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first's L8 in both orders");
});

cell("R2-130 (same prospect): the public opt-out through the FIRST message's token (from the MIME the fake recorded) against the claim of the queued follow-up, held at L8 (the opt-out takes no L3, L4, L4g, L10): order 1: NOT_SENT(SUPPRESSED), zero calls; order 2: one submission then SUPPRESSED; the sealed grant never overrides the refusal; red with L8 removed from both (zero-call assertion fails); the support refuses a token of an intent never submitted", "race", async (ctx) => {
  const runs: Array<{ order: Order; s: Staged; follow: string; g: GrantP; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    w.standAt(T0);
    const s = await staged(w, `m22-${order}`);
    const first = await sentFirst(w, s);
    const token = tokenOf(w, first);
    w.standAt(plusMs(T0, 7 * DAY_MS));
    const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
    const g = await w.grant([f]);
    const follow = intentIdOf(await send(w, s.seller, f, g));
    if (order === 1) assert.throws(() => tokenOf(w, follow), "the support refuses a token of an intent never submitted");
    const O: RaceActor<unknown> = { name: "public opt-out", role: "kauro_app", run: () => w.routes.optOut(token), at: W.suppressionInsert };
    const C = d2Actor("D2 of the follow-up", D(), follow);
    runs.push({ order, s, follow, g, r: await raceAtWrite(ctx, "M22", order === 1 ? O : C, order === 1 ? C : O) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.follow), 0, "order 1: zero calls after the opt-out committed (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.follow)), "NOT_SENT(SUPPRESSED)");
  const live = await w.oracle.query<{ revoked: boolean }>("SELECT revoked FROM kauro.outreach_authorizations WHERE authorization_id = $1", [o1.g.authorizationId]);
  assert.equal(live.rows[0]?.revoked, false, "order 1: the sealed grant is live and still never overrides the refusal");
  assert.equal(callsOf(w, o2.follow), 1, "order 2: one submission");
  assert.equal(await prospectState(w, o2.s.prospect), "SUPPRESSED", "order 2: then SUPPRESSED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
  w.standAt(T0);
});

// --- R2-131 / R2-132 ---------------------------------------------------------------------------------------------------------------------
test("R2-131: a sales draft on a RESEND_TRANSACTIONAL sender is refused at send despite valid fake credentials and spare quota: zero Resend calls, the draft stays DRAFT, the grant unconsumed, a forged intent on that route refused (KC028); the same contentRef drafted on the seller's GMAIL_API sender is granted and submitted once", async () => {
  w.standAt(T0);
  const seller = await w.seller("r131");
  const resendSender = await w.sender(seller, { route: "RESEND_TRANSACTIONAL" });
  const s = await staged(w, "r131", { seller, sender: resendSender });
  const resendBefore = w.resend.calls.length;
  assert.equal(out(await send(w, seller, s.draft, s.grant)), OUTCOME.KC028, "refused at send (KC028)");
  await D().pass();
  assert.equal(w.resend.calls.length, resendBefore, "zero Resend calls");
  assert.equal(await draftState(w, s.draft), "DRAFT", "the draft stays DRAFT");
  assert.equal(await grantReserved(w, s.grant), 0, "the grant unconsumed");
  // a forged intent on the RESEND route (a copy of an admitted intent with route and draft changed) is refused by the database
  const gmailTwin = await staged(w, "r131-gmail", { seller, prospect: await w.prospect(seller) });
  const model = await queued(w, gmailTwin);
  await assert.rejects(
    w.oracle.query(
      `INSERT INTO kauro.outreach_send_intents SELECT (jsonb_populate_record(NULL::kauro.outreach_send_intents, to_jsonb(i) || jsonb_build_object('intent_id', gen_random_uuid(), 'route', 'RESEND_TRANSACTIONAL', 'draft_id', $2::uuid, 'authorization_id', $3::uuid, 'prospect_id', $4::uuid))).* FROM kauro.outreach_send_intents i WHERE i.intent_id = $1`,
      [model, s.draft.draftId, s.grant.authorizationId, s.prospect.prospectId],
    ),
    (e: unknown) => (e as { code?: string }).code === "KC028",
    "a forged intent on the RESEND route is refused with KC028",
  );
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 0);
  // the same contentRef on the seller's GMAIL_API sender
  const p = await w.prospect(seller);
  const d = await w.draft(seller, p, seller.sender, { contentRef: s.draft.contentRef, label: "r131-same-content" });
  assert.equal(d.contentRef, s.draft.contentRef, "the same stored content");
  const g = await w.grant([d]);
  const id = intentIdOf(await send(w, seller, d, g));
  await D().dispatch(id);
  assert.deepEqual([callsOf(w, id), (await intent(w, id)).state, w.resend.calls.length], [1, "PROVIDER_ACCEPTED", resendBefore], "granted and submitted once through Gmail, zero Resend calls");
});

class Refused extends Error {}
cell("R2-132: the sender's OAuth grant revoked with three queued drafts: the first claim observes AUTH_REVOKED (no effect), D4 takes L4 and L4g before the sender row and marks it REVOKED, the first intent NOT_SENT(AUTH_REVOKED) and its draft CANCELLED, the other two CANCELLED(SENDER_REVOKED) at their claims unsubmitted, past PROVIDER_ACCEPTED and SEND_UNCERTAIN activity is kept, and no intent is ever sent from the owner's identity", "revocation", async (ctx) => {
  w.standAt(T0);
  const seller = await w.seller("r132");
  const past = await sentFirst(w, await staged(w, "r132-past", { seller }));
  const pastU = await queued(w, await staged(w, "r132-past-u", { seller }));
  w.gmail.script({ kind: "TIMEOUT" });
  await D().dispatch(pastU);
  assert.equal((await intent(w, pastU)).state, "SEND_UNCERTAIN");
  const q = [await staged(w, "r132-q1", { seller }), await staged(w, "r132-q2", { seller }), await staged(w, "r132-q3", { seller })];
  const ids = [await queued(w, q[0]!), await queued(w, q[1]!), await queued(w, q[2]!)];
  const conn = await w.open("kauro_outreach_test");
  try {
    await ctx.revoked("the provider refuses the sender's OAuth grant at the first call (AUTH_REVOKED)", async () => {
      w.gmail.script({ kind: "AUTH_REVOKED" });
      return w.on(conn, "kauro_outreach", ctx, [W.personLock, { label: "grant_lock", match: /kauro\.outreach_authorizations'/ }, W.senderLock, W.senderUpdate], () => D().dispatch(ids[0]!));
    });
  } finally {
    await conn.end().catch(() => undefined);
  }
  const passed = ctx.points.passed;
  const last = (p: string): number => passed.lastIndexOf(p);
  assert.ok(last("db.sender_lock.after") > last("db.person_lock.after") && last("db.sender_lock.after") > last("db.grant_lock.after"), `D4 takes L4 and L4g before the sender row (passed: ${passed.join(", ")})`);
  assert.equal(await senderState(w, seller.sender.senderId), "REVOKED", "D4 marks the sender REVOKED");
  assert.equal(stateOf(await intent(w, ids[0]!)), "NOT_SENT(AUTH_REVOKED)");
  assert.equal(await draftState(w, q[0]!.draft), "CANCELLED");
  assert.equal(callsOf(w, ids[0]!), 1, "the first claim's call observed AUTH_REVOKED (no effect)");
  for (const k of [1, 2]) {
    await ctx.fenced(`the claim of queued draft ${k + 1} after the revocation`, async () => {
      const r = await D().dispatch(ids[k]!);
      throw new Refused(stateOf(await intent(w, ids[k]!)) + " " + r.outcome);
    }, (e) => e instanceof Refused && e.message.startsWith("CANCELLED(SENDER_REVOKED)"));
    assert.equal(callsOf(w, ids[k]!), 0, `queued draft ${k + 1} unsubmitted`);
    assert.equal(await draftState(w, q[k]!.draft), "CANCELLED");
  }
  assert.deepEqual(await activityKinds(w, past), ["PROVIDER_ACCEPTED"], "past PROVIDER_ACCEPTED activity kept");
  assert.deepEqual(await activityKinds(w, pastU), ["SEND_UNCERTAIN"], "past SEND_UNCERTAIN activity kept");
  const fromOthers = w.gmail.submissions.filter((x) => [past, pastU, ...ids].includes(x.intentId ?? "") && x.senderId !== seller.sender.senderId);
  assert.deepEqual(fromOthers, [], "no intent is ever sent from the owner's (or any other) identity");
});

// --- §M race cells of the dispatcher -----------------------------------------------------------------------------------------------------
cell("GAP-DI-17 RACE (sender revocation during dispatch) M12: D2 against RecordSenderRevocation of the intent's sender, held at the sender subject L7 in both orders: order 1 (revocation holds) CANCELLED(SENDER_REVOKED) and zero calls; order 2 (D2 holds) one call, then REVOKED; red with L7 removed from both (a call from a REVOKED sender)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; s: Staged; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m12-${order}`);
    const id = await queued(w, s);
    const R: RaceActor<unknown> = { name: "RecordSenderRevocation", role: "kauro_app", run: () => w.routes.revokeSender(s.seller.sender.senderId), at: W.senderUpdate };
    runs.push({ order, s, id, r: await raceAtWrite(ctx, "M12", order === 1 ? R : d2Actor("D2", D(), id), order === 1 ? d2Actor("D2", D(), id) : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call from the REVOKED sender (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "CANCELLED(SENDER_REVOKED)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.equal(await senderState(w, o2.s.seller.sender.senderId), "REVOKED", "order 2: then REVOKED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

/** D2 of an intent against a writer that withdraws one of D2's prerequisites, both orders: order 1 refused with zero calls, order 2 one call. */
async function d2Against(ctx: FaultContext, m: string, label: string, stage: (order: Order) => Promise<{ s: Staged; id: string; writer: RaceActor<unknown> }>): Promise<Array<{ order: Order; s: Staged; id: string; r: RaceResult<unknown, unknown> }>> {
  const runs: Array<{ order: Order; s: Staged; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const { s, id, writer } = await stage(order);
    const claim = d2Actor(`D2 (${label})`, D(), id);
    runs.push({ order, s, id, r: await raceAtWrite(ctx, m, order === 1 ? writer : claim, order === 1 ? claim : writer) });
  }
  return runs;
}

cell("GAP-DI-1 RACE (termination) M4: D2 against CMD050 terminating the sending seller, held at the seller subject L1 in both orders: order 1 (CMD050 holds) CANCELLED(SELLER_NOT_ACTIVE) and zero calls; order 2 (D2 holds) one call, then TERMINATED; red with L1 removed from both (a call after TERMINATED committed)", "race", async (ctx) => {
  // traces: CMD050 L1 sellers row FOR NO KEY UPDATE (commercial-sales.ts:369) -> L1 X (:372) -> UPDATE sellers; D2 L1 set S (sending seller) first
  w.standAt(T0);
  const runs = await d2Against(ctx, "M4", "termination", async (order) => {
    const s = await staged(w, `m4-${order}`);
    const id = await queued(w, s);
    return { s, id, writer: { name: "CMD050", role: "kauro_app", run: () => w.routes.terminate(s.seller), at: W.sellerUpdate } };
  });
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call after TERMINATED committed (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "CANCELLED(SELLER_NOT_ACTIVE)");
  assert.equal(await draftState(w, o1.s.draft), "CANCELLED");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.ok(replyOf(o2.r.second, "CMD050").status < 300, "order 2: then TERMINATED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-1b RACE (assignment) M4b: D2 of an owner-sent intent against CMD050 of the assigned seller, held at the assigned seller's subject L1 in both orders: order 1 (CMD050 holds) CANCELLED(RECIPIENT_CHANGED) and zero calls; order 2 (D2 holds) one call, then the prospect unassigned; red with L1 removed from both (a call to an unassigned prospect)", "race", async (ctx) => {
  w.standAt(T0);
  const ownerSender = await w.sender(w.owner);
  const runs = await d2Against(ctx, "M4b", "assignment", async (order) => {
    const seller = await w.seller(`m4b-${order}`);
    const p = await w.prospect(seller);
    const d = await w.draft(w.owner, p, ownerSender, { label: `m4b-${order}` });
    const g = await w.grant([d]);
    const id = intentIdOf(await send(w, w.owner, d, g));
    return { s: { seller, prospect: p, draft: d, grant: g }, id, writer: { name: "CMD050 of the assigned seller", role: "kauro_app", run: () => w.routes.terminate(seller), at: W.sellerUpdate } };
  });
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call to an unassigned prospect (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "CANCELLED(RECIPIENT_CHANGED)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  const assigned = await w.oracle.query<{ seller: string | null }>("SELECT assigned_seller_id::text AS seller FROM kauro.prospects WHERE prospect_id = $1", [o2.s.prospect.prospectId]);
  assert.equal(assigned.rows[0]?.seller ?? null, null, "order 2: then unassigned");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-10 RACE (cap re-stamp) M3: D2 re-stamping P1's intent queued more than 24 h earlier against CMD063 of a first contact on P2, one person with 9 other first contacts in the window, two grants, held at the person subject L4 in both orders: order 1 (D2 holds) D2 admits and CMD063 409 KC032; order 2 (CMD063 holds) CMD063 200 and D2 NOT_SENT(CAP_REACHED); red with L4 removed from both (11 first contacts in 24 h)", "race", async (ctx) => {
  const runs: Array<{ order: Order; seller: SellerP; at: string; i1: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const base = plusMs(T0, (order - 1) * 7 * DAY_MS); // Thursdays 2026-10-15 and 2026-10-22
    w.standAt(base);
    const seller = await w.seller(`m3-${order}`);
    const s1 = await staged(w, `m3-${order}-p1s`, { seller, prospect: await w.prospect(seller) });
    const i1 = await queued(w, s1); // counted at base, never claimed
    const at = plusMs(base, 25 * 3_600_000); // Friday 16:00Z
    w.standAt(plusMs(at, -3_600_000));
    await firstContacts(w, seller, 9, `m3-${order}-nine`);
    w.standAt(at);
    const p2 = await staged(w, `m3-${order}-p2`, { seller });
    const C: RaceActor<unknown> = { name: "CMD063 P2", role: "kauro_app", run: () => send(w, seller, p2.draft, p2.grant), at: W.intentInsert };
    const R = d2Actor("D2 re-stamp of P1", D(), i1);
    runs.push({ order, seller, at, i1, r: await raceAtWrite(ctx, "M3", order === 1 ? R : C, order === 1 ? C : R) });
  }
  for (const { order, seller, at } of runs) assert.equal(await firstContacts24h(w, seller.userId, plusMs(at, 1_000)), 10, `order ${order}: 10 first contacts in 24 h (forbidden: 11)`);
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual([stateOf(await intent(w, o1.i1)), callsOf(w, o1.i1)], ["PROVIDER_ACCEPTED", 1], "order 1: D2 admitted P1's intent (re-stamped) and it was sent once");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.KC032, "order 1: CMD063 409 KC032");
  assert.equal(replyOf(o2.r.first, "CMD063").status, 200, "order 2: CMD063 200");
  assert.equal(stateOf(await intent(w, o2.i1)), "NOT_SENT(CAP_REACHED)", "order 2: D2 NOT_SENT(CAP_REACHED)");
  assert.equal(callsOf(w, o2.i1), 0);
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
  w.standAt(T0);
});

cell("GAP-DI-11 RACE (capability) M8: D2 against CMD059 suspending the capability the draft's resource cites, held at the capability subject L5 (taken by CMD059's own trigger X) in both orders: order 1 (CMD059 holds) NOT_SENT(CAPABILITY_RESTRICTED) and zero calls; order 2 (D2 holds) one call, then SUSPENDED; red with L5 removed from both (a call after SUSPENDED committed)", "race", async (ctx) => {
  w.standAt(T0);
  const runs = await d2Against(ctx, "M8", "capability", async (order) => {
    const res = await w.freshResource(`m8-${order}`);
    const seller = await w.seller(`m8-${order}`);
    const p = await w.prospect(seller);
    const d = await w.draft(seller, p, seller.sender, { resource: res, label: `m8-${order}` });
    const g = await w.grant([d]);
    const id = intentIdOf(await send(w, seller, d, g));
    return { s: { seller, prospect: p, draft: d, grant: g }, id, writer: { name: "CMD059", role: "kauro_app", run: () => w.routes.suspendCapability(res.capabilityId), at: W.capabilityUpdate, after: true } };
  });
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call after SUSPENDED committed (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "NOT_SENT(CAPABILITY_RESTRICTED)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.ok(replyOf(o2.r.second, "CMD059").status < 300, "order 2: then SUSPENDED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-12 RACE (resource) M9: D2 against PublishSalesResource superseding the draft's resource, held at the resource family subject L6 in both orders: order 1 (Publish holds) NOT_SENT(RESOURCE_NOT_CURRENT) and zero calls; order 2 (D2 holds) one call, then SUPERSEDED; red with L6 removed from both (a call citing a SUPERSEDED resource)", "race", async (ctx) => {
  w.standAt(T0);
  const runs = await d2Against(ctx, "M9", "resource", async (order) => {
    const res = await w.freshResource(`m9-${order}`);
    const seller = await w.seller(`m9-${order}`);
    const p = await w.prospect(seller);
    const d = await w.draft(seller, p, seller.sender, { resource: res, label: `m9-${order}` });
    const g = await w.grant([d]);
    const id = intentIdOf(await send(w, seller, d, g));
    return { s: { seller, prospect: p, draft: d, grant: g }, id, writer: { name: "PublishSalesResource", role: "kauro_app", run: () => w.routes.publishResource(res.familyId), at: W.resourceSupersede } };
  });
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call citing a SUPERSEDED resource (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "NOT_SENT(RESOURCE_NOT_CURRENT)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.ok(replyOf(o2.r.second, "Publish").status < 300, "order 2: then SUPERSEDED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-16 RACE (policy) M10: D2 against WithdrawOutreachChannelPolicy of the US first-contact policy, held at the policy subject L6p in both orders: order 1 (withdraw holds) NOT_SENT(POLICY_WITHDRAWN) and zero calls; order 2 (D2 holds) one call, then WITHDRAWN; red with L6p removed from both (a call after the withdrawal)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m10-${order}`);
    const id = await queued(w, s);
    const P: RaceActor<unknown> = { name: "WithdrawOutreachChannelPolicy", role: "kauro_app", run: () => w.routes.withdrawPolicy("US", "INDIVIDUAL_PROSPECT_CONTACT"), at: W.policyWithdraw };
    const C = d2Actor("D2", D(), id);
    const r = await raceAtWrite(ctx, "M10", order === 1 ? P : C, order === 1 ? C : P);
    runs.push({ order, id, r });
    assert.ok((await w.routes.reinstatePolicy("US", "INDIVIDUAL_PROSPECT_CONTACT")).status < 300, "the policy back IN_FORCE for the next order and cell");
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call after the withdrawal (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "NOT_SENT(POLICY_WITHDRAWN)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.ok(replyOf(o2.r.second, "withdraw").status < 300, "order 2: then WITHDRAWN");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-18 RACE (lock order) M14: D4 AUTH_REVOKED of person X against CMD063 of X on another prospect held at L4 in both orders: no deadlock, sender REVOKED, the first intent NOT_SENT(AUTH_REVOKED); CMD063 409 SENDER_REVOKED (order 1) or 200 and its intent CANCELLED(SENDER_REVOKED) at claim (order 2); red (40P01) with D4 taking L7 before L4", "race", async (ctx) => {
  // traces: D4 AUTH_REVOKED L1 S -> L3 S(P1) -> L4 S(X) -> L4g S -> L7 X(sender) -> L10 X(d1); CMD063 L1 S -> L2 -> L3 X(P2) -> L4 X(X) -> L4g S -> ... -> L7 S(sender) -> L10 X(d2)
  // (i) rule 13: the first actor paused after its FIRST lock of the pair (D4: L4 S; under KAURO_B12_CONTROL=M14-order the rev-2 order takes L7 X first) -> the
  //     cross interleaving that deadlocks the rev-2 order (40P01 is the forbidden effect); (ii) 24a: KAURO_B12_CONTROL=M14 removes {L4, L7} from both.
  w.standAt(T0);
  const runs: Array<{ order: Order; seller: SellerP; i1: string; p2: Staged; r: RaceResult<unknown, unknown> }> = [];
  const cross: Array<RaceResult<unknown, unknown>> = [];
  for (const variant of ["cross", 1, 2] as const) {
    const seller = await w.seller(`m14-${variant}`);
    const p1 = await staged(w, `m14-${variant}-p1`, { seller });
    const i1 = await queued(w, p1);
    const disp = D();
    const answer = await claimedAndCalled(disp, i1, { kind: "AUTH_REVOKED" });
    assert.deepEqual(answer, { kind: "AUTH_REVOKED" });
    const p2 = await staged(w, `m14-${variant}-p2`, { seller });
    const C: RaceActor<unknown> = { name: "CMD063 X on P2", role: "kauro_app", run: () => send(w, seller, p2.draft, p2.grant), at: W.intentInsert };
    if (variant === "cross") {
      const firstLock = rev2OrderControl() ? W.senderLock : W.personLock;
      const R: RaceActor<unknown> = { name: "D4 AUTH_REVOKED paused after its first lock of the pair", role: "kauro_outreach", run: () => disp.record(i1, answer), at: firstLock, after: true };
      cross.push(await raceAtWrite(ctx, "M14-cross", R, C));
      continue;
    }
    const R: RaceActor<unknown> = { name: "D4 AUTH_REVOKED", role: "kauro_outreach", run: () => disp.record(i1, answer), at: W.d4Revoked };
    runs.push({ order: variant, seller, i1, p2, r: await raceAtWrite(ctx, "M14", variant === 1 ? R : C, variant === 1 ? C : R) });
  }
  const settledText = (x: RaceResult<unknown, unknown>["first"]): string =>
    "failure" in x ? `failed ${String((x.failure as { code?: string }).code ?? (x.failure as Error).message)}` : typeof x.answer === "object" && x.answer !== null && "status" in x.answer ? `${(x.answer as Reply).status} ${(x.answer as Reply).text}` : "ok";
  const all = [...cross, ...runs.map((x) => x.r)].flatMap((r) => [settledText(r.first), settledText(r.second)]);
  assert.deepEqual(all.filter((t) => t.startsWith("failed") || /^5\d\d /.test(t) || /40P01|deadlock/i.test(t)), [], "no deadlock (40P01) and no failed actor in the cross interleaving or either order (forbidden effect (i))");
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.p2.draft.draftId)).length, 0, "order 1: no CMD063 row on a REVOKED sender (forbidden effect (ii))");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.SENDER_REVOKED, "order 1: CMD063 409 SENDER_REVOKED");
  for (const { order, seller, i1 } of runs) {
    assert.equal(await senderState(w, seller.sender.senderId), "REVOKED", `order ${order}: sender REVOKED`);
    assert.equal(stateOf(await intent(w, i1)), "NOT_SENT(AUTH_REVOKED)", `order ${order}: the first intent NOT_SENT(AUTH_REVOKED)`);
  }
  const id2 = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await D().dispatch(id2);
  assert.deepEqual([stateOf(await intent(w, id2)), callsOf(w, id2)], ["CANCELLED(SENDER_REVOKED)", 0], "order 2: 200 and its intent CANCELLED(SENDER_REVOKED) at claim");
  assert.equal(cross[0]!.secondBlocked, true, "the cross interleaving: CMD063 waited on D4's L4 S");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-DI-19 RACE (revocation vs follow-up) M14b: D4 AUTH_REVOKED of person X on P1 against D2 of X's follow-up on P2, held at the sender subject L7 (L4 S/S, L4g S/S) in both orders: order 1 (D4 holds) CANCELLED(SENDER_REVOKED) and zero calls; order 2 (D2 holds) one call, then REVOKED; red with L7 removed from both (a call after the revocation)", "race", async (ctx) => {
  const runs: Array<{ order: Order; seller: SellerP; f: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    w.standAt(T0);
    const seller = await w.seller(`m14b-${order}`);
    const p2 = await staged(w, `m14b-${order}-p2`, { seller });
    await sentFirst(w, p2);
    w.standAt(plusMs(T0, 7 * DAY_MS));
    const fd = await w.draft(seller, p2.prospect, seller.sender, { purpose: "FOLLOW_UP" });
    const f = intentIdOf(await send(w, seller, fd, await w.grant([fd])));
    const p1 = await staged(w, `m14b-${order}-p1`, { seller });
    const i1 = await queued(w, p1);
    const disp = D();
    const answer = await claimedAndCalled(disp, i1, { kind: "AUTH_REVOKED" });
    const R: RaceActor<unknown> = { name: "D4 AUTH_REVOKED", role: "kauro_outreach", run: () => disp.record(i1, answer), at: W.d4Revoked };
    const C = d2Actor("D2 of the follow-up", D(), f);
    runs.push({ order, seller, f, r: await raceAtWrite(ctx, "M14b", order === 1 ? R : C, order === 1 ? C : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.f), 0, "order 1: no call after the revocation (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.f)), "CANCELLED(SENDER_REVOKED)");
  assert.equal(callsOf(w, o2.f), 1, "order 2: one call");
  assert.equal(await senderState(w, o2.seller.sender.senderId), "REVOKED", "order 2: then REVOKED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
  w.standAt(T0);
});

cell("GAP-HP-1 RACE (bounce pause) M18: CMD064 BOUNCED of person X's sent intent on P1 against D2 of X's intent on P2, held at the person subject L4 in both orders: order 1 (BOUNCED holds) NOT_SENT(PAUSED) and zero calls; order 2 (D2 holds) one call, then paused; red with L4 removed from both (a call of a paused person)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; seller: SellerP; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m18-${order}`);
    const sent = await sentFirst(w, await staged(w, `m18-${order}-p1`, { seller }));
    const id = await queued(w, await staged(w, `m18-${order}-p2`, { seller }));
    const B: RaceActor<unknown> = { name: "CMD064 BOUNCED", role: "kauro_app", run: () => w.routes.recordActivity(seller, { kind: "BOUNCED", intentId: sent, evidenceRef: `dsn-m18-${order}` }), at: W.activityInsert };
    const C = d2Actor("D2 P2", D(), id);
    runs.push({ order, seller, id, r: await raceAtWrite(ctx, "M18", order === 1 ? B : C, order === 1 ? C : B) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call of a paused person (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "NOT_SENT(PAUSED)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.equal((await w.metrics(w.owner, o2.seller.userId)).paused, true, "order 2: then paused");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-HP-2 RACE (provider warning pause) M19: D4 recording a Gmail 429 warning of person X on P1 against D2 of X's intent on P2, held at the person subject L4 in both orders: order 1 (D4 holds) NOT_SENT(PAUSED) and zero calls; order 2 (D2 holds) one call, then paused; red with L4 removed from both (a call of a paused person)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; seller: SellerP; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m19-${order}`);
    const i1 = await queued(w, await staged(w, `m19-${order}-p1`, { seller }));
    const disp = D();
    const answer = await claimedAndCalled(disp, i1, { kind: "REJECTED_DEFINITIVE", status: 429 });
    assert.deepEqual(answer, { kind: "REJECTED_DEFINITIVE", status: 429 });
    const id = await queued(w, await staged(w, `m19-${order}-p2`, { seller }));
    const R: RaceActor<unknown> = { name: "D4 429", role: "kauro_outreach", run: () => disp.record(i1, answer), at: W.d4First };
    const C = d2Actor("D2 P2", D(), id);
    runs.push({ order, seller, id, r: await raceAtWrite(ctx, "M19", order === 1 ? R : C, order === 1 ? C : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(callsOf(w, o1.id), 0, "order 1: no call of a paused person (forbidden effect)");
  assert.equal(stateOf(await intent(w, o1.id)), "NOT_SENT(PAUSED)");
  assert.equal(callsOf(w, o2.id), 1, "order 2: one call");
  assert.equal((await warningsOf(w, o2.seller.userId)).length, 1, "order 2: one warning row");
  assert.equal((await w.metrics(w.owner, o2.seller.userId)).paused, true, "order 2: then paused");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-HP-3 RACE (complaint pause) M20: CMD064 COMPLAINT on person X's sent intent to contact K1 against CMD063 of X on P2 (contact K2), held at the person subject L4 (L8 keys differ) in both orders: order 1 (COMPLAINT holds) 409 KC034 and no intent; order 2 (CMD063 holds) 200 and NOT_SENT(PAUSED) at its claim with zero calls; red with L4 removed from both (an intent of a paused person)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; p2: Staged; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m20-${order}`);
    const sent = await sentFirst(w, await staged(w, `m20-${order}-k1`, { seller }));
    const p2 = await staged(w, `m20-${order}-k2`, { seller });
    const X: RaceActor<unknown> = { name: "CMD064 COMPLAINT", role: "kauro_app", run: () => w.routes.recordActivity(seller, { kind: "SUPPRESSED", reason: "COMPLAINT", intentId: sent, evidenceRef: `fbl-m20-${order}` }), at: W.activityInsert };
    const C: RaceActor<unknown> = { name: "CMD063 P2", role: "kauro_app", run: () => send(w, seller, p2.draft, p2.grant), at: W.intentInsert };
    runs.push({ order, p2, r: await raceAtWrite(ctx, "M20", order === 1 ? X : C, order === 1 ? C : X) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.p2.draft.draftId)).length, 0, "order 1: no intent of a paused person (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.KC034);
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await D().dispatch(id);
  assert.deepEqual([stateOf(await intent(w, id)), callsOf(w, id)], ["NOT_SENT(PAUSED)", 0], "order 2: NOT_SENT(PAUSED) at its claim with zero calls");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

// --- takeover and late answers (each in a world of its own: the cell moves the OUTBOX_DISPATCH lease) ------------------------------------
cell("GAP-DI-5 RACE (takeover) M30: D2 of the old owner against claim_lease of a new owner after expiry, held at the lease row L13 (FOR SHARE / FOR UPDATE) in both orders: order 1 (D2 holds) the takeover waits for its COMMIT, the intent SUBMITTING at the old fence and D5 later SEND_UNCERTAIN; order 2 (takeover holds) D2 waits, then LEASE_FENCED: the unit rolls back and the intent stays QUEUED; red with L13 removed from both (order 2 a provider call by the fenced owner after the takeover committed)", "race", async (ctx) => {
  // each actor positions its own unit's clock when it starts (the step clock is read at the unit's BEGIN): the old owner's D2 judges its lease at
  // `early` (still valid), the takeover claims at `late` (expired); so with L13 removed the old owner's D2 reads the uncommitted takeover's row as
  // still its own and calls the provider (the forbidden effect), and with L13 it either commits first (order 1) or sees the new fence (order 2)
  const early = plusMs(T0, LEASE_TTL_MS - 1_000);
  const late = plusMs(T0, LEASE_TTL_MS + 1_000);
  const finals: Array<{ order: Order; state: string; fence: number | null; oldFence: number; calls: number; recovered: string | null; blocked: boolean }> = [];
  for (const order of ORDERS) {
    await ownWorld(`m30-${order}`, async () => {
      w.standAt(T0);
      const s = await staged(w, `m30-${order}`);
      const id = await queued(w, s);
      const old = w.dispatcher("m30-old");
      const oldFence = await old.takeOver();
      const neu = w.dispatcher("m30-new");
      const T: RaceActor<unknown> = { name: "claim_lease takeover", role: "kauro_control", run: async () => { w.standAt(late); return neu.takeOver(); }, at: W.leaseClaim, after: true };
      const C: RaceActor<unknown> = {
        name: "D2 (+ D3) of the old owner",
        role: "kauro_outreach",
        run: async () => {
          w.standAt(early);
          const verdict = await old.claim(id);
          if (verdict === "ADMITTED") await old.submit(id);
          return verdict;
        },
        at: W.intentUpdate,
      };
      const r = await raceAtWrite(ctx, "M30", order === 1 ? C : T, order === 1 ? T : C);
      const i = await intent(w, id);
      let recovered: string | null = null;
      if (order === 1) {
        w.standAt(plusMs(late, UNCERTAIN_AFTER_MS));
        await neu.recover();
        recovered = (await intent(w, id)).state;
      }
      finals.push({ order, state: i.state, fence: i.claimFence, oldFence, calls: callsOf(w, id), recovered, blocked: r.secondBlocked });
    });
  }
  const [o1, o2] = finals as [(typeof finals)[0], (typeof finals)[0]];
  assert.equal(o2.calls, 0, "order 2: no provider call by the fenced owner after the takeover committed (forbidden effect)");
  assert.deepEqual([o2.state, o2.fence], ["QUEUED", null], "order 2: LEASE_FENCED, the unit rolled back, the intent QUEUED");
  assert.deepEqual([o1.state, o1.fence, o1.calls], ["SUBMITTING", o1.oldFence, 1], "order 1: the takeover waited for D2's COMMIT; the intent SUBMITTING at the old fence");
  assert.equal(o1.recovered, "SEND_UNCERTAIN", "order 1: D5 later SEND_UNCERTAIN");
  assert.deepEqual(finals.map((f) => f.blocked), [true, true], "the second waited on the first's L13 in both orders");
});

cell("GAP-DI-7 RACE (takeover) M26: the old owner's D4 after the new owner's claim is LEASE_FENCED; D4b and D5 held at L10 in both orders: one submission, PROVIDER_ACCEPTED with the late ref, one PROVIDER_ACCEPTED activity and no SEND_UNCERTAIN activity; red with L10 removed from both and T1 dropped (order 2 ends SEND_UNCERTAIN)", "race", async (ctx) => {
  const finals: Array<{ order: Order; state: string; ref: string | null; kinds: string[]; calls: number; evidence: number; blocked: boolean }> = [];
  for (const order of ORDERS) {
    await ownWorld(`m26-${order}`, async () => {
      w.standAt(T0);
      const s = await staged(w, `m26-${order}`);
      const id = await queued(w, s);
      const old = w.dispatcher("m26-old");
      assert.equal(await old.claim(id), "ADMITTED");
      const held = w.gmail.holdNext();
      const call = old.submit(id);
      await held.reached;
      w.standAt(plusMs(T0, LEASE_TTL_MS + 1_000)); // past the lease TTL and past uncertain_after
      const neu = w.dispatcher("m26-new");
      await neu.takeOver();
      held.answer({ kind: "ACCEPTED", ref: `gmail-late-m26-${order}` });
      const answer = await call;
      assert.deepEqual(answer, { kind: "ACCEPTED", ref: `gmail-late-m26-${order}` });
      const B: RaceActor<unknown> = { name: "D4b (old owner, LEASE_FENCED)", role: "kauro_outreach", run: () => old.record(id, answer), at: W.evidenceInsert };
      const R: RaceActor<unknown> = { name: "D5 (new owner)", role: "kauro_outreach", run: () => neu.recover(), at: W.intentUpdate };
      const r = await raceAtWrite(ctx, "M26", order === 1 ? B : R, order === 1 ? R : B);
      const i = await intent(w, id);
      finals.push({ order, state: i.state, ref: i.providerRef, kinds: await activityKinds(w, id), calls: callsOf(w, id), evidence: (await evidenceOf(w, id)).length, blocked: r.secondBlocked });
    });
  }
  for (const f of finals) {
    assert.deepEqual([f.state, f.ref], ["PROVIDER_ACCEPTED", `gmail-late-m26-${f.order}`], `order ${f.order}: PROVIDER_ACCEPTED with the late ref (forbidden: SEND_UNCERTAIN)`);
    assert.equal(f.kinds.filter((k) => k === "PROVIDER_ACCEPTED").length, 1, `order ${f.order}: one PROVIDER_ACCEPTED activity`);
  }
  assert.deepEqual(finals[0]!.kinds, ["PROVIDER_ACCEPTED"], "order 1: no SEND_UNCERTAIN activity on an accepted send");
  for (const f of finals) assert.deepEqual([f.calls, f.evidence], [1, 1], `order ${f.order}: one submission, one evidence row`);
  assert.deepEqual(finals.map((f) => f.blocked), [true, true]);
});

cell("GAP-DI-7b RACE (late answer) M27: D4 of the same owner recording a late ACCEPTED against D5 at uncertain_after, one intent, held at the draft subject L10 in both orders: order 1 (D4 holds) PROVIDER_ACCEPTED and D5 a no-op; order 2 (D5 holds) SEND_UNCERTAIN then PROVIDER_ACCEPTED; red with L10 removed from both and T1 dropped (final SEND_UNCERTAIN)", "race", async (ctx) => {
  const runs: Array<{ order: Order; id: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    w.standAt(T0);
    const s = await staged(w, `m27-${order}`);
    const id = await queued(w, s);
    const disp = D();
    assert.equal(await disp.claim(id), "ADMITTED");
    const held = w.gmail.holdNext();
    const call = disp.submit(id);
    await held.reached;
    w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS)); // D5 is due exactly now
    held.answer({ kind: "ACCEPTED", ref: `gmail-late-m27-${order}` });
    const answer = await call;
    const A: RaceActor<unknown> = { name: "D4 late ACCEPTED", role: "kauro_outreach", run: () => disp.record(id, answer), at: W.d4First };
    const R: RaceActor<unknown> = { name: "D5", role: "kauro_outreach", run: () => disp.recover(), at: W.intentUpdate };
    runs.push({ order, id, r: await raceAtWrite(ctx, "M27", order === 1 ? A : R, order === 1 ? R : A) });
  }
  for (const { order, id } of runs) {
    const i = await intent(w, id);
    assert.deepEqual([i.state, i.providerRef], ["PROVIDER_ACCEPTED", `gmail-late-m27-${order}`], `order ${order}: final PROVIDER_ACCEPTED (forbidden: final SEND_UNCERTAIN)`);
    assert.equal(callsOf(w, id), 1);
  }
  assert.deepEqual(await activityKinds(w, runs[0]!.id), ["PROVIDER_ACCEPTED"], "order 1: D5 a no-op");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
  w.standAt(T0);
});

cell("GAP-DI-24 RACE (late answer after the human's NOT_SENT) M45: the old owner's D4 recording a late ACCEPTED onto an OBSERVED_NOT_SENT intent against the new owner's D2 of the draft's repeat, held at the draft subject L10 in both orders: order 1 (D4 holds) one evidence row, the repeat NOT_SENT(ALREADY_SENT) with zero calls, draft PROVIDER_ACCEPTED; order 2 (D2 holds) the repeat submitted once, then the evidence row: both submissions shown; red with L10 removed from both (order 1 a second submission)", "race", async (ctx) => {
  const finals: Array<{ order: Order; repeatCalls: number; repeatState: string; draft: DraftState; evidence: number; firstState: string; blocked: boolean }> = [];
  for (const order of ORDERS) {
    await ownWorld(`m45-${order}`, async () => {
      w.standAt(T0);
      const s = await staged(w, `m45-${order}`);
      const id = await queued(w, s);
      const old = w.dispatcher("m45-old");
      const timeout = await claimedAndCalled(old, id, { kind: "TIMEOUT" });
      await old.record(id, timeout);
      assert.equal((await intent(w, id)).state, "SEND_UNCERTAIN");
      w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS));
      assert.ok((await human(s.seller, id, "NOT_SENT")).status < 300);
      const repeat = intentIdOf(await send(w, s.seller, s.draft, s.grant));
      w.standAt(plusMs(T0, LEASE_TTL_MS + 10_000)); // past the lease TTL and past uncertain_after + d4Grace
      const neu = w.dispatcher("m45-new");
      await neu.takeOver();
      const late: ClassifiedAnswer = { kind: "ACCEPTED", ref: `gmail-late-m45-${order}` };
      const A: RaceActor<unknown> = { name: "D4 late ACCEPTED (old owner)", role: "kauro_outreach", run: () => old.record(id, late), at: W.evidenceInsert };
      const C = d2Actor("D2 of the repeat (new owner)", neu, repeat);
      const r = await raceAtWrite(ctx, "M45", order === 1 ? A : C, order === 1 ? C : A);
      finals.push({ order, repeatCalls: callsOf(w, repeat), repeatState: stateOf(await intent(w, repeat)), draft: await draftState(w, s.draft), evidence: (await evidenceOf(w, id)).length, firstState: (await intent(w, id)).state, blocked: r.secondBlocked });
    });
  }
  const [o1, o2] = finals as [(typeof finals)[0], (typeof finals)[0]];
  assert.equal(o1.repeatCalls, 0, "order 1: no second submission (forbidden effect)");
  assert.deepEqual([o1.repeatState, o1.draft, o1.evidence], ["NOT_SENT(ALREADY_SENT)", "PROVIDER_ACCEPTED", 1], "order 1: evidence; repeat NOT_SENT(ALREADY_SENT); draft PROVIDER_ACCEPTED");
  assert.deepEqual([o2.repeatCalls, o2.evidence, o2.draft], [1, 1, "PROVIDER_ACCEPTED"], "order 2: the repeat submitted once, then the evidence row (both submissions shown)");
  for (const f of finals) assert.equal(f.firstState, "OBSERVED_NOT_SENT", `order ${f.order}: the observed intent keeps its human state`);
  assert.deepEqual(finals.map((f) => f.blocked), [true, true]);
});

// --- D2 TIMEOUT / EXPIRY / CRASH / PARTIAL -----------------------------------------------------------------------------------------------
cell("GAP-DI-2 TIMEOUT: claim lock wait: QUEUED, outbox RETRYABLE, zero calls", "race", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di2");
  const id = await queued(w, s);
  const hold = await holdSubject(w, "L10", s.draft.draftId, "X");
  w.setStatementTimeout(1_500);
  try {
    const waiting = await waitingBehind(ctx, w, hold, "kauro_outreach", "D2 waits at the draft subject L10", () => D().claim(id), [W.draftLock]);
    await waiting.pending.catch((e: unknown) => e);
  } finally {
    w.setStatementTimeout(null);
    await hold.release();
  }
  assert.equal((await intent(w, id)).state, "QUEUED", "the intent stays QUEUED");
  assert.deepEqual((await outboxOf(w, id)).map((o) => o.state), ["RETRYABLE"], "outbox RETRYABLE");
  assert.equal(callsOf(w, id), 0, "zero calls");
  await D().dispatch(id);
  assert.deepEqual([callsOf(w, id), (await intent(w, id)).state], [1, "PROVIDER_ACCEPTED"], "the redelivery submits once");
});

cell("GAP-DI-3 EXPIRY (wait): grant expiry crossed while waiting at L4: NOT_SENT(GRANT_EXPIRED)", "expiry", async (ctx) => {
  // §W rev 4: D2's last await before its judgment is the L13 FOR SHARE statement; the holder is kauro_control_test holding the lease row FOR UPDATE
  w.standAt(T0);
  await sentFirst(w, await staged(w, "di3-lease")); // the lease row exists
  const expiresAt = plusMs(T0, 600_000);
  const s = await staged(w, "di3", { expiresAt });
  const id = await queued(w, s);
  w.standAt(null);
  const deadline = ctx.deadline(msOf(expiresAt) - UNCERTAIN_AFTER_MS, "expiresAt - (startGate + callBound + margin)");
  ctx.clock.set(msOf(expiresAt) - UNCERTAIN_AFTER_MS - 10_000);
  const verdict = await onEffectClock(ctx, w, "D2 waiting at L13 across the grant's expiry bound", async () => {
    const hold = await holdLease(w);
    try {
      const waiting = await waitingBehind(ctx, w, hold, "kauro_outreach", "D2 waits at the lease row L13", () => D().claim(id), [W.leaseShare]);
      ctx.clock.past(deadline);
      await hold.release();
      return await waiting.pending;
    } catch (e) {
      await hold.release().catch(() => undefined);
      throw e;
    }
  });
  assert.equal(verdict, "NOT_SENT(GRANT_EXPIRED)", "refused at effect_now after the wait");
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(GRANT_EXPIRED)");
  assert.deepEqual([callsOf(w, id), await draftState(w, s.draft), await grantReserved(w, s.grant)], [0, "DRAFT", 0], "zero calls, draft DRAFT, grant released");
  w.standAt(T0);
});

test("D2 EXPIRY (boundaries): claimed when expiresAt - (startGate + callBound + margin) is 1 us after effect_now, refused at equality", async () => {
  w.standAt(T0);
  const expiresAt = plusUs(plusMs(T0, 3_600_000), 3);
  const seller = await w.seller("d2-expiry");
  const a = await staged(w, "d2-expiry-a", { seller, expiresAt });
  const b = await staged(w, "d2-expiry-b", { seller, expiresAt });
  const ia = await queued(w, a);
  const ib = await queued(w, b);
  const bound = plusMs(expiresAt, -UNCERTAIN_AFTER_MS);
  w.standAt(plusUs(bound, -1));
  assert.equal(await D().claim(ia), "ADMITTED", "claimed when the bound is 1 us after effect_now");
  w.standAt(bound);
  assert.equal(await D().claim(ib), "NOT_SENT(GRANT_EXPIRED)", "refused at equality");
  assert.deepEqual([callsOf(w, ib), await draftState(w, b.draft)], [0, "DRAFT"]);
  w.standAt(T0);
});

cell("GAP-DI-4 CRASH: after the SUBMITTING UPDATE, before COMMIT: QUEUED, redelivery submits once", "crash-before-commit", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di4");
  const id = await queued(w, s);
  const crash = ctx.points.crash("target.before-commit");
  const conn = await w.open("kauro_outreach_test");
  try {
    await ctx.operation("D2 crashed before its COMMIT", () => w.on(conn, "kauro_outreach", ctx, [W.intentUpdate], () => D().claim(id), { target: 1 }).catch((e: unknown) => e));
    await crash.reached;
  } finally {
    await conn.end().catch(() => undefined);
  }
  assert.ok(ctx.points.passed.includes("db.intent_update.after"), "the SUBMITTING UPDATE had completed");
  assert.deepEqual([(await intent(w, id)).state, await draftState(w, s.draft), callsOf(w, id)], ["QUEUED", "AUTHORIZED", 0], "QUEUED, draft AUTHORIZED, zero calls");
  await D().dispatch(id);
  await D().dispatch(id);
  assert.deepEqual([callsOf(w, id), (await intent(w, id)).state], [1, "PROVIDER_ACCEPTED"], "the redelivery submits once");
}, "target");

cell("GAP-DI-6 PARTIAL: failure at the draft UPDATE after the intent UPDATE rolls both back", "partial", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di6");
  const id = await queued(w, s);
  const before = await intent(w, id);
  const conn = await w.open("kauro_outreach_test");
  try {
    await ctx.partial("D2 failing at its draft UPDATE after the intent UPDATE", "db.draft_update.before", () => w.on(conn, "kauro_outreach", ctx, [W.intentUpdate, W.draftUpdate], () => D().claim(id)));
  } finally {
    await conn.end().catch(() => undefined);
  }
  const i = await intent(w, id);
  assert.deepEqual([i.state, i.submittedAt, i.claimFence, i.countedAt], [before.state, before.submittedAt, before.claimFence, before.countedAt], "the intent rolled back (QUEUED, no submission stamp, no fence, counted_at unchanged)");
  assert.equal(await draftState(w, s.draft), "AUTHORIZED", "the draft rolled back");
  assert.equal(callsOf(w, id), 0);
  await D().dispatch(id);
  assert.deepEqual([callsOf(w, id), (await intent(w, id)).state], [1, "PROVIDER_ACCEPTED"], "the retry submits once");
});

// --- D3 ----------------------------------------------------------------------------------------------------------------------------------
cell("GAP-DI-26 EXPIRY (call start): D3 paused before its gate statement past submitted_at + startGate: NOT_ATTEMPTED, zero calls, NOT_SENT(LOCAL_FAILURE), draft DRAFT; 1 us before admitted", "expiry", async (ctx) => {
  // the 1 us sibling: claimed at S, the gate at S + startGate - 1 us is admitted and the call made
  w.standAt(T0);
  const ok = await staged(w, "di26-ok");
  const okId = await queued(w, ok);
  assert.equal(await D().claim(okId), "ADMITTED");
  w.standAt(plusUs(plusMs(T0, START_GATE_MS), -1));
  const okAnswer = await D().submit(okId);
  assert.equal(okAnswer.kind, "ACCEPTED", "1 us before the start bound the call is made");
  assert.equal(callsOf(w, okId), 1);
  await D().record(okId, okAnswer);
  // the crossing: D3 paused before its gate statement while the effect clock crosses submitted_at + startGate
  w.standAt(T0);
  const s = await staged(w, "di26");
  const id = await queued(w, s);
  w.standAt(null);
  const claimedAt = msOf(T0) + 60_000;
  ctx.clock.set(claimedAt);
  const answer = await onEffectClock(ctx, w, "D2 then D3 across the start gate", async () => {
    assert.equal(await D().claim(id), "ADMITTED");
    const deadline = ctx.deadline(claimedAt + START_GATE_MS + 1, "submitted_at + startGate (+1 ms: past it)");
    const pause = ctx.points.pause("db.d3_gate.before");
    const conn = await w.open("kauro_outreach_test");
    try {
      const pending = w.on(conn, "kauro_outreach", ctx, [D3_GATE], () => D().submit(id));
      await pause.reached;
      ctx.clock.past(deadline);
      pause.release();
      return await pending;
    } finally {
      await conn.end().catch(() => undefined);
    }
  });
  assert.deepEqual(answer, { kind: "NOT_ATTEMPTED" }, "NOT_ATTEMPTED");
  assert.equal(callsOf(w, id), 0, "zero calls");
  await D().record(id, answer);
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(LOCAL_FAILURE)");
  assert.equal(await draftState(w, s.draft), "DRAFT");
  w.standAt(T0);
});

// --- D4 ----------------------------------------------------------------------------------------------------------------------------------
cell("GAP-DI-8 TIMEOUT: the outcome COMMIT times out once: D4 retries and records the answer (edge or evidence) before uncertain_after + d4Grace; past it the intent stays SEND_UNCERTAIN (residual §5)", "race", async (ctx) => {
  // the dispatcher's own D4 retry (dispatch: D2 -> D3 -> D4 with retries). The Gmail call is held so a test connection can take L10 X of the draft after
  // D2 committed; D4's first attempt then waits at L10 past the routed statement_timeout; the holder is released once D4's SECOND attempt reaches its
  // L10 statement (a pause re-armed at the same point after the first wait was observed), so exactly one attempt timed out.
  w.standAt(T0);
  const s = await staged(w, "di8");
  const id = await queued(w, s);
  const disp = D();
  const lockDraft = async (draftId: string): Promise<{ conn: Awaited<ReturnType<SendWorld["open"]>>; release: () => Promise<void> }> => {
    const conn = await w.open("superuser");
    await conn.query("BEGIN");
    await conn.query("SELECT pg_advisory_xact_lock(kauro.transition_key('kauro.outreach_drafts', $1))", [draftId]);
    return { conn, release: async () => { await conn.query("ROLLBACK"); await conn.end(); } };
  };
  const held = w.gmail.holdNext();
  const conn = await w.open("kauro_outreach_test");
  w.setStatementTimeout(1_000);
  try {
    const running = w.on(conn, "kauro_outreach", ctx, [W.draftLock], () => disp.dispatch(id));
    await held.reached; // D2 committed SUBMITTING; D3 is in the call
    const hold = await lockDraft(s.draft.draftId);
    held.answer({ kind: "ACCEPTED", ref: "gmail-di8" });
    const waited = await ctx.mustWait(w.oracle, { waiter: conn, holder: connectionPid(hold.conn) }, () => running, "D4 attempt 1 waits at L10");
    const second = ctx.points.pause("db.draft_lock.before");
    await second.reached;
    await hold.release();
    second.release();
    await waited.pending;
  } finally {
    w.setStatementTimeout(null);
    await conn.end().catch(() => undefined);
  }
  assert.deepEqual([(await intent(w, id)).state, (await intent(w, id)).providerRef, callsOf(w, id)], ["PROVIDER_ACCEPTED", "gmail-di8", 1], "the retry recorded the answer before uncertain_after + d4Grace");
  assert.deepEqual(await activityKinds(w, id), ["PROVIDER_ACCEPTED"], "one activity");
  // past uncertain_after + d4Grace: the answer's D4 cannot commit inside the grace; the intent stays SEND_UNCERTAIN
  w.standAt(T0);
  const p = await staged(w, "di8-past");
  const pid = await queued(w, p);
  const heldP = w.gmail.holdNext();
  const runningP = disp.dispatch(pid);
  await heldP.reached;
  const ua = (await intent(w, pid)).uncertainAfter!;
  w.standAt(ua);
  await disp.recover();
  assert.equal((await intent(w, pid)).state, "SEND_UNCERTAIN", "D5 at uncertain_after");
  w.standAt(plusMs(ua, D4_GRACE_MS));
  const holdP = await lockDraft(p.draft.draftId);
  w.setStatementTimeout(1_000);
  try {
    heldP.answer({ kind: "ACCEPTED", ref: "gmail-di8-past" });
    await runningP.catch((e: unknown) => e);
  } finally {
    w.setStatementTimeout(null);
    await holdP.release();
  }
  assert.equal((await intent(w, pid)).state, "SEND_UNCERTAIN", "past uncertain_after + d4Grace the intent stays SEND_UNCERTAIN (residual r1)");
  assert.ok(!(await activityKinds(w, pid)).includes("PROVIDER_ACCEPTED"), "no PROVIDER_ACCEPTED recorded past the grace");
  w.standAt(T0);
});

cell("GAP-DI-9 PARTIAL: failure at the activity INSERT rolls back the outcome; the retry records it once", "partial", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di9");
  const id = await queued(w, s);
  const disp = D();
  const answer = await claimedAndCalled(disp, id, { kind: "ACCEPTED", ref: "gmail-di9" });
  const conn = await w.open("kauro_outreach_test");
  try {
    await ctx.partial("D4 failing at its activity INSERT after the intent UPDATE", "db.activity_insert.before", () => w.on(conn, "kauro_outreach", ctx, [W.intentUpdate, W.activityInsert], () => disp.record(id, answer)));
  } finally {
    await conn.end().catch(() => undefined);
  }
  assert.deepEqual([(await intent(w, id)).state, await draftState(w, s.draft), await activityKinds(w, id)], ["SUBMITTING", "SUBMITTING", []], "the outcome rolled back (intent and draft SUBMITTING, no activity)");
  await disp.record(id, answer);
  assert.deepEqual([(await intent(w, id)).state, await activityKinds(w, id), callsOf(w, id)], ["PROVIDER_ACCEPTED", ["PROVIDER_ACCEPTED"], 1], "the retry records it once");
});

cell("GAP-DI-13 RETRY: a redelivered D4 with its activity already recorded is a no-op", "retry", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di13");
  const id = await queued(w, s);
  const disp = D();
  const answer = await claimedAndCalled(disp, id, { kind: "ACCEPTED", ref: "gmail-di13" });
  await ctx.attempt(() => disp.record(id, answer));
  const once = await intent(w, id);
  await ctx.attempt(() => disp.record(id, answer));
  assert.deepEqual(await intent(w, id), once, "the redelivered D4 changed nothing");
  assert.deepEqual(await activityKinds(w, id), ["PROVIDER_ACCEPTED"], "one activity");
  assert.deepEqual(await evidenceOf(w, id), [], "no evidence row (the edge was admissible the first time)");
  assert.equal(callsOf(w, id), 1);
});

test("GAP-DI-23 (same fence, after HUMAN NOT_SENT): the provider accepts after the human's NOT_SENT; the same owner's D4 writes an evidence row, the intent stays OBSERVED_NOT_SENT and counts, the draft PROVIDER_ACCEPTED, a repeat CMD063 409 KC036 and a repeat already queued NOT_SENT(ALREADY_SENT) with zero calls", async () => {
  w.standAt(T0);
  const s = await staged(w, "di23");
  const id = await queued(w, s);
  const disp = D();
  const timeout = await claimedAndCalled(disp, id, { kind: "TIMEOUT" });
  await disp.record(id, timeout);
  const fence = (await intent(w, id)).claimFence;
  w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS));
  assert.ok((await human(s.seller, id, "NOT_SENT")).status < 300);
  const repeat = intentIdOf(await send(w, s.seller, s.draft, s.grant)); // a repeat already queued
  assert.equal(await grantReserved(w, s.grant), 1, "only the repeat reserves the grant before the late answer");
  await disp.record(id, { kind: "ACCEPTED", ref: "gmail-di23-late" });
  assert.deepEqual((await evidenceOf(w, id)).map((e) => [e.fence, e.status, e.providerRef]), [[fence, "ACCEPTED", "gmail-di23-late"]], "one evidence row of the same fence");
  assert.equal((await intent(w, id)).state, "OBSERVED_NOT_SENT", "the intent keeps the human's state");
  assert.equal(await grantReserved(w, s.grant), 2, "and counts (ACCEPTED evidence)");
  assert.equal(await draftState(w, s.draft), "PROVIDER_ACCEPTED");
  assert.equal(out(await send(w, s.seller, s.draft, s.grant)), OUTCOME.KC036, "a repeat CMD063 409 KC036");
  w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS + D4_GRACE_MS));
  await disp.dispatch(repeat);
  assert.deepEqual([stateOf(await intent(w, repeat)), callsOf(w, repeat), await draftState(w, s.draft)], ["NOT_SENT(ALREADY_SENT)", 0, "PROVIDER_ACCEPTED"], "the queued repeat NOT_SENT(ALREADY_SENT) with zero calls");
  w.standAt(T0);
});

test("GAP-DI-25 EXPIRY (repeat grace): a repeat claimed 1 us before the previous uncertain_after + d4Grace stays QUEUED with zero calls, at it is claimed", async () => {
  w.standAt(T0);
  const s = await staged(w, "di25");
  const id = await queued(w, s);
  const disp = D();
  await disp.record(id, await claimedAndCalled(disp, id, { kind: "TIMEOUT" }));
  const ua = (await intent(w, id)).uncertainAfter!;
  w.standAt(ua);
  assert.ok((await human(s.seller, id, "NOT_SENT")).status < 300);
  const repeat = intentIdOf(await send(w, s.seller, s.draft, s.grant));
  const grace = plusMs(ua, D4_GRACE_MS);
  w.standAt(plusUs(grace, -1));
  assert.equal(await disp.claim(repeat), "DEFERRED", "1 us before the grace ends: the unit rolls back");
  assert.deepEqual([(await intent(w, repeat)).state, callsOf(w, repeat)], ["QUEUED", 0], "the repeat stays QUEUED with zero calls");
  assert.deepEqual((await outboxOf(w, repeat)).map((o) => o.state), ["RETRYABLE"], "outbox RETRYABLE at that instant");
  w.standAt(grace);
  assert.equal(await disp.claim(repeat), "ADMITTED", "at it the repeat is claimed");
  w.standAt(T0);
});

cell("GAP-DI-27 EXPIRY (open call): the Gmail fake holds a call open until its abort; HUMAN NOT_SENT at uncertain_after - 1 us is 409 and at uncertain_after admitted only after the fake recorded the abort (event order, not a clock comparison)", "expiry", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di27");
  const id = await queued(w, s);
  const disp = D();
  assert.equal(await disp.claim(id), "ADMITTED");
  const ua = (await intent(w, id)).uncertainAfter!;
  const held = w.gmail.holdNext();
  const call = disp.submit(id).then((a) => disp.record(id, a)); // D3, then D4 once the fake recorded the abort
  await held.reached;
  w.standAt(plusUs(ua, -1));
  assert.equal((await human(s.seller, id, "NOT_SENT")).status, 409, "HUMAN NOT_SENT at uncertain_after - 1 us is 409");
  // the crossing consumed by an operation: the HUMAN NOT_SENT unit reads effect_now on the controlled clock past uncertain_after, after the abort
  w.standAt(null);
  const deadline = ctx.deadline(msOf(ua), "uncertain_after");
  ctx.clock.set(msOf(ua) - 1_000);
  await held.aborted;
  await call;
  const admitted = await onEffectClock(ctx, w, "HUMAN NOT_SENT after the abort", async () => {
    ctx.clock.past(deadline);
    return human(s.seller, id, "NOT_SENT");
  });
  assert.ok(admitted.status < 300, `admitted after the abort: ${admitted.text}`);
  const order = await w.oracle.query<{ kind: string }>("SELECT kind FROM kauro.sales_activities WHERE intent_id = $1 ORDER BY recorded_at, activity_id", [id]);
  assert.deepEqual(order.rows.map((r) => r.kind), ["SEND_UNCERTAIN", "HUMAN_SEND_OBSERVED"], "the abort's SEND_UNCERTAIN is recorded before the human's observation");
  assert.equal(w.gmail.submissions.filter((x) => x.intentId === id).map((x) => x.answered).join(), "ABORTED", "the fake recorded the abort");
  assert.equal((await intent(w, id)).state, "OBSERVED_NOT_SENT");
  w.standAt(T0);
});

// --- D4 evidence path (D4b) --------------------------------------------------------------------------------------------------------------
/** In a world of its own: an intent claimed by an old owner whose call is held, the lease taken over, the late answer delivered to the old owner. */
async function lateAfterTakeover(label: string, late: Parameters<SendWorld["gmail"]["script"]>[0]): Promise<{ s: Staged; id: string; old: Dispatcher; neu: Dispatcher; answer: ClassifiedAnswer }> {
  w.standAt(T0);
  const s = await staged(w, label);
  const id = await queued(w, s);
  const old = w.dispatcher(`${label}-old`);
  assert.equal(await old.claim(id), "ADMITTED");
  const held = w.gmail.holdNext();
  const call = old.submit(id);
  await held.reached;
  w.standAt(plusMs(T0, LEASE_TTL_MS + 1_000));
  const neu = w.dispatcher(`${label}-new`);
  await neu.takeOver();
  await neu.recover();
  assert.equal((await intent(w, id)).state, "SEND_UNCERTAIN", "the new owner recovered it SEND_UNCERTAIN");
  held.answer(late);
  return { s, id, old, neu, answer: await call };
}

test("GAP-DI-20 DENY (late refusal): a late 400 after a takeover keeps SEND_UNCERTAIN, writes one evidence row with status 400, zero submissions; a late 429 also writes its warning and pauses the person", async () => {
  await ownWorld("di20", async () => {
    const a = await lateAfterTakeover("di20-400", { kind: "REJECTED_DEFINITIVE", status: 400 });
    await a.old.record(a.id, a.answer);
    assert.equal((await intent(w, a.id)).state, "SEND_UNCERTAIN", "a late 400 keeps SEND_UNCERTAIN");
    assert.deepEqual((await evidenceOf(w, a.id)).map((e) => e.httpStatus), [400], "one evidence row with status 400");
    assert.equal(callsOf(w, a.id), 1, "zero further submissions");
    assert.deepEqual(await warningsOf(w, a.s.seller.userId), [], "a 400 is no warning");
    const b = await lateAfterTakeover("di20-429", { kind: "REJECTED_DEFINITIVE", status: 429 });
    await b.old.record(b.id, b.answer);
    assert.equal((await intent(w, b.id)).state, "SEND_UNCERTAIN");
    assert.deepEqual((await evidenceOf(w, b.id)).map((e) => e.httpStatus), [429]);
    assert.deepEqual((await warningsOf(w, b.s.seller.userId)).map((x) => [x.intentId, x.status]), [[b.id, 429]], "its warning");
    const n = await staged(w, "di20-next", { seller: b.s.seller });
    assert.equal(out(await send(w, b.s.seller, n.draft, n.grant)), OUTCOME.KC034, "the person paused");
  });
});

cell("GAP-DI-21 RETRY: D4b twice: one activity, one evidence row", "retry", async (ctx) => {
  await ownWorld("di21", async () => {
    const a = await lateAfterTakeover("di21", { kind: "ACCEPTED", ref: "gmail-di21-late" });
    await ctx.attempt(() => a.old.record(a.id, a.answer));
    await ctx.attempt(() => a.old.record(a.id, a.answer));
    assert.equal((await evidenceOf(w, a.id)).length, 1, "one evidence row");
    assert.equal((await activityKinds(w, a.id)).filter((k) => k === "PROVIDER_ACCEPTED").length, 1, "one PROVIDER_ACCEPTED activity");
    assert.deepEqual([(await intent(w, a.id)).state, callsOf(w, a.id)], ["PROVIDER_ACCEPTED", 1]);
  });
});

cell("GAP-DI-22 PARTIAL: failure at the evidence INSERT rolls back the warning", "partial", async (ctx) => {
  await ownWorld("di22", async () => {
    const a = await lateAfterTakeover("di22", { kind: "REJECTED_DEFINITIVE", status: 429 });
    const conn = await w.open("kauro_outreach_test");
    try {
      await ctx.partial("D4b failing at its evidence INSERT after the warning INSERT", "db.evidence_insert.before", () => w.on(conn, "kauro_outreach", ctx, [WARNING_INSERT, W.evidenceInsert], () => a.old.record(a.id, a.answer)));
    } finally {
      await conn.end().catch(() => undefined);
    }
    assert.deepEqual([await warningsOf(w, a.s.seller.userId), await evidenceOf(w, a.id)], [[], []], "the warning rolled back with the evidence");
    await a.old.record(a.id, a.answer);
    assert.deepEqual([(await warningsOf(w, a.s.seller.userId)).length, (await evidenceOf(w, a.id)).length], [1, 1], "the retry writes one of each");
  });
});

// --- D5 ----------------------------------------------------------------------------------------------------------------------------------
cell("GAP-DI-14 EXPIRY (D5 boundary): SUBMITTING at uncertain_after - 1 us untouched, at it SEND_UNCERTAIN; D5 held at L13 (lease row held FOR UPDATE by a test connection) across it", "expiry", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di14");
  const id = await queued(w, s);
  assert.equal(await D().claim(id), "ADMITTED");
  const ua = (await intent(w, id)).uncertainAfter!;
  w.standAt(plusUs(ua, -1));
  await D().recover();
  assert.equal((await intent(w, id)).state, "SUBMITTING", "uncertain_after - 1 us: untouched");
  w.standAt(ua);
  await D().recover();
  assert.equal((await intent(w, id)).state, "SEND_UNCERTAIN", "at uncertain_after: SEND_UNCERTAIN");
  // held across it
  w.standAt(T0);
  const h = await staged(w, "di14-held");
  const hid = await queued(w, h);
  assert.equal(await D().claim(hid), "ADMITTED");
  const hua = (await intent(w, hid)).uncertainAfter!;
  w.standAt(null);
  const deadline = ctx.deadline(msOf(hua), "uncertain_after");
  ctx.clock.set(msOf(hua) - 2_000);
  await onEffectClock(ctx, w, "D5 waiting at L13 across uncertain_after", async () => {
    const hold = await holdLease(w);
    try {
      const waiting = await waitingBehind(ctx, w, hold, "kauro_outreach", "D5 waits at the lease row L13", () => D().recover(), [W.leaseShare]);
      ctx.clock.past(deadline);
      await hold.release();
      return await waiting.pending;
    } catch (e) {
      await hold.release().catch(() => undefined);
      throw e;
    }
  });
  assert.equal((await intent(w, hid)).state, "SEND_UNCERTAIN", "judged at effect_now after the wait");
  assert.equal(callsOf(w, hid), 0, "no call");
  w.standAt(T0);
});

cell("GAP-DI-15 RETRY (D5 rerun): a second recovery pass over a SEND_UNCERTAIN intent changes nothing (state guard): one SEND_UNCERTAIN state, no second activity, zero calls", "retry", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "di15");
  const id = await queued(w, s);
  assert.equal(await D().claim(id), "ADMITTED");
  w.standAt(plusMs(T0, UNCERTAIN_AFTER_MS));
  await ctx.attempt(() => D().recover());
  const once = { i: await intent(w, id), kinds: await activityKinds(w, id) };
  const again = await ctx.attempt(() => D().recover());
  assert.ok(!again.includes(id), "the rerun names nothing for this intent");
  assert.deepEqual({ i: await intent(w, id), kinds: await activityKinds(w, id) }, once, "unchanged");
  assert.deepEqual([once.i.state, callsOf(w, id)], ["SEND_UNCERTAIN", 0]);
  w.standAt(T0);
});

// --- provider warnings -------------------------------------------------------------------------------------------------------------------
test("GAP-HP-4 DENY (provider warning): a Gmail 429 at D3 records NOT_SENT(PROVIDER_REJECTED:429), one warning row, and a new first contact of that person is 409 KC034 until the diagnosis", async () => {
  w.standAt(T0);
  const seller = await w.seller("hp4");
  const id = await queued(w, await staged(w, "hp4", { seller }));
  w.gmail.script({ kind: "REJECTED_DEFINITIVE", status: 429 });
  await D().dispatch(id);
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(PROVIDER_REJECTED:429)");
  assert.deepEqual((await warningsOf(w, seller.userId)).map((x) => [x.intentId, x.status]), [[id, 429]], "one warning row");
  const n = await staged(w, "hp4-next", { seller });
  assert.equal(out(await send(w, seller, n.draft, n.grant)), OUTCOME.KC034, "a new first contact 409 KC034");
  assert.ok((await w.routes.diagnose(seller.userId)).status < 300, "the owner's diagnosis");
  assert.equal((await send(w, seller, n.draft, n.grant)).status, 200, "admitted after the diagnosis");
});

test("GAP-HP-5 DENY (quota exhaustion): the Gmail fake answers 429 at the 3rd of 5 queued intents of one person: two PROVIDER_ACCEPTED, the 3rd NOT_SENT(PROVIDER_REJECTED:429), the 4th and 5th NOT_SENT(PAUSED) at their claims with zero calls, never retried automatically", async () => {
  w.standAt(T0);
  const seller = await w.seller("hp5");
  const ids: string[] = [];
  for (let k = 0; k < 5; k++) ids.push(await queued(w, await staged(w, `hp5-${k}`, { seller })));
  w.gmail.script({ kind: "ACCEPTED", ref: "gmail-hp5-1" }, { kind: "ACCEPTED", ref: "gmail-hp5-2" }, { kind: "REJECTED_DEFINITIVE", status: 429 });
  for (const id of ids) await D().dispatch(id); // units run sequentially (§L dispatcher concurrency)
  const states = await Promise.all(ids.map(async (id) => stateOf(await intent(w, id))));
  assert.deepEqual(states, ["PROVIDER_ACCEPTED", "PROVIDER_ACCEPTED", "NOT_SENT(PROVIDER_REJECTED:429)", "NOT_SENT(PAUSED)", "NOT_SENT(PAUSED)"]);
  assert.deepEqual(ids.map((id) => callsOf(w, id)), [1, 1, 1, 0, 0], "the 4th and 5th with zero calls");
  w.standAt(plusMs(T0, DAY_MS));
  await D().pass();
  await D().pass();
  assert.deepEqual(ids.map((id) => callsOf(w, id)), [1, 1, 1, 0, 0], "never retried automatically");
  w.standAt(T0);
});

test("GAP-HP-6 DENY (not a warning): a 400 records NOT_SENT(PROVIDER_REJECTED:400) and no pause", async () => {
  w.standAt(T0);
  const seller = await w.seller("hp6");
  const id = await queued(w, await staged(w, "hp6", { seller }));
  w.gmail.script({ kind: "REJECTED_DEFINITIVE", status: 400 });
  await D().dispatch(id);
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(PROVIDER_REJECTED:400)");
  assert.deepEqual(await warningsOf(w, seller.userId), [], "no warning row");
  const n = await staged(w, "hp6-next", { seller });
  assert.equal((await send(w, seller, n.draft, n.grant)).status, 200, "no pause: a new first contact admitted");
});

// --- D2 DENY: one prerequisite withdrawn after CMD063 and before the claim ---------------------------------------------------------------
interface Withdrawn {
  readonly s: Staged;
  readonly id: string;
}
/** CMD063 admitted, the prerequisite withdrawn, then D2: the refusal, the A2b draft edge, zero calls, grant and cap released. */
function d2Deny(prerequisite: string, expected: string, draft: DraftState, stage: (label: string) => Promise<Withdrawn>, after?: () => Promise<void>): void {
  test(`D2 DENY (${prerequisite}): withdrawn after CMD063 and before the claim: ${expected}, draft ${draft}, zero provider calls, grant and cap released`, async () => {
    w.standAt(T0);
    const { s, id } = await stage(`d2deny-${prerequisite.replace(/\W+/g, "-")}`);
    try {
      const at = (await intent(w, id)).countedAt;
      const counted = await firstContacts24h(w, s.seller.userId, at);
      assert.equal(await D().claim(id), expected, `D2 refused ${expected}`);
      assert.equal(stateOf(await intent(w, id)), expected);
      assert.equal(await draftState(w, s.draft), draft, `the A2b draft edge: ${draft}`);
      assert.equal(callsOf(w, id), 0, "zero provider calls");
      await D().pass();
      assert.equal(callsOf(w, id), 0, "zero provider calls after another pass");
      assert.equal(await grantReserved(w, s.grant), 0, "the grant released");
      if ((await intent(w, id)).purpose === "INDIVIDUAL_PROSPECT_CONTACT") assert.equal(await firstContacts24h(w, s.seller.userId, at), counted - 1, "the cap released");
    } finally {
      if (after !== undefined) await after();
      w.standAt(T0);
    }
  });
}
const admitted = async (label: string, options: Parameters<typeof staged>[2] = {}): Promise<Withdrawn> => {
  const s = await staged(w, label, options);
  return { s, id: await queued(w, s) };
};
d2Deny("suppression registry", "NOT_SENT(SUPPRESSED)", "SUPPRESSED", async (label) => {
  const x = await admitted(label);
  await w.routes.suppress({ contactKey: x.s.prospect.contactKey });
  return x;
});
d2Deny("grant", "NOT_SENT(GRANT_REVOKED)", "DRAFT", async (label) => {
  const x = await admitted(label);
  assert.ok((await w.routes.revokeGrant(x.s.grant)).status < 300);
  return x;
});
d2Deny("assignment", "CANCELLED(RECIPIENT_CHANGED)", "CANCELLED", async (label) => {
  const seller = await w.seller(label);
  const p = await w.prospect(seller);
  const d = await w.draft(w.owner, p, await w.sender(w.owner), { label });
  const g = await w.grant([d]);
  const id = intentIdOf(await send(w, w.owner, d, g));
  assert.ok((await w.routes.terminate(seller)).status < 300, "CMD050 unassigns the prospect");
  return { s: { seller: { ...seller, userId: w.owner.userId }, prospect: p, draft: d, grant: g }, id };
});
d2Deny("channel policy", "NOT_SENT(POLICY_WITHDRAWN)", "DRAFT", async (label) => {
  const x = await admitted(label);
  assert.ok((await w.routes.withdrawPolicy("US", "INDIVIDUAL_PROSPECT_CONTACT")).status < 300);
  return x;
}, async () => {
  assert.ok((await w.routes.reinstatePolicy("US", "INDIVIDUAL_PROSPECT_CONTACT")).status < 300);
});
let restoreCompliance: (() => void) | null = null;
d2Deny("compliance configuration", "NOT_SENT(COMPLIANCE_UNCONFIGURED)", "DRAFT", async (label) => {
  const x = await admitted(label);
  restoreCompliance = w.setCompliance(null);
  return x;
}, async () => {
  restoreCompliance?.();
  restoreCompliance = null;
});
d2Deny("cadence stop fact", "NOT_SENT(CADENCE_CLOSED)", "DRAFT", async (label) => {
  const s = await staged(w, label);
  const first = await sentFirst(w, s);
  w.standAt(plusMs(T0, 7 * DAY_MS));
  const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
  const g = await w.grant([f]);
  const id = intentIdOf(await send(w, s.seller, f, g));
  assert.ok((await w.routes.recordActivity(s.seller, { kind: "REPLIED", intentId: first, inboundRef: `inbound-${first}` })).status < 300);
  return { s: { ...s, draft: f, grant: g }, id };
});
d2Deny("health", "NOT_SENT(PAUSED)", "DRAFT", async (label) => {
  const seller = await w.seller(label);
  const sent = await sentFirst(w, await staged(w, `${label}-sent`, { seller }));
  const x = await admitted(label, { seller });
  assert.ok((await w.routes.recordActivity(seller, { kind: "BOUNCED", intentId: sent, evidenceRef: `dsn-${sent}` })).status < 300);
  return x;
});
d2Deny("business day", "NOT_SENT(OUTSIDE_BUSINESS_DAY)", "DRAFT", async (label) => {
  w.standAt("2026-10-16T20:00:00.000000Z"); // Friday
  const x = await admitted(label);
  w.standAt("2026-10-17T15:00:00.000000Z"); // Saturday
  return x;
});
d2Deny("seller", "CANCELLED(SELLER_NOT_ACTIVE)", "CANCELLED", async (label) => {
  const x = await admitted(label);
  assert.ok((await w.routes.terminate(x.s.seller)).status < 300);
  return x;
});
d2Deny("sender", "CANCELLED(SENDER_REVOKED)", "CANCELLED", async (label) => {
  const x = await admitted(label);
  assert.ok((await w.routes.revokeSender(x.s.seller.sender.senderId)).status < 300);
  return x;
});
d2Deny("resource", "NOT_SENT(RESOURCE_NOT_CURRENT)", "DRAFT", async (label) => {
  const res = await w.freshResource(label);
  const seller = await w.seller(label);
  const p = await w.prospect(seller);
  const d = await w.draft(seller, p, seller.sender, { resource: res, label });
  const g = await w.grant([d]);
  const id = intentIdOf(await send(w, seller, d, g));
  assert.ok((await w.routes.publishResource(res.familyId)).status < 300, "the cited resource SUPERSEDED");
  return { s: { seller, prospect: p, draft: d, grant: g }, id };
});
d2Deny("capability", "NOT_SENT(CAPABILITY_RESTRICTED)", "DRAFT", async (label) => {
  const res = await w.freshResource(label);
  const seller = await w.seller(label);
  const p = await w.prospect(seller);
  const d = await w.draft(seller, p, seller.sender, { resource: res, label });
  const g = await w.grant([d]);
  const id = intentIdOf(await send(w, seller, d, g));
  assert.ok((await w.routes.suspendCapability(res.capabilityId)).status < 300, "CMD059 suspends the capability");
  return { s: { seller, prospect: p, draft: d, grant: g }, id };
});
d2Deny("person cap", "NOT_SENT(CAP_REACHED)", "DRAFT", async (label) => {
  // queued at T0 (Thursday), not claimed; 10 first contacts sent the next day inside the claim's 24 h window; the claim re-stamps counted_at
  const seller = await w.seller(label);
  const x = await admitted(label, { seller });
  const claimAt = plusMs(T0, 25 * 3_600_000);
  w.standAt(plusMs(claimAt, -3_600_000));
  await firstContacts(w, seller, 10, `${label}-ten`);
  w.standAt(claimAt);
  return x;
});

void settledOk;
void prospectState;
