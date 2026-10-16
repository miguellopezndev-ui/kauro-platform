// CMD063 SendAuthorizedOutreach — POST /api/v1/ops/outreach/{draftId}/send — ASSIGNED_SELLER_OR_OWNER (package B12, lane L-SEND, tier 1;
// plan docs/design/B12-outreach-plan.md rev 4 §1 CMD063-OK/DENY/RACE, §2 CMD063 row GAP-SE-1..25, §M M1, M2, M5, M7, M11, M13, M15, M16, M23,
// §W CMD063 row). One COMMIT: intent QUEUED (counted_at = effect_now) + draft AUTHORIZED + event outreach.send_intended.v1 + outbox + journal.
// Trace (§L): L1 (sender principal + assigned seller) S -> L2 -> L3 X -> L4 X -> L4g S -> L5 S -> L6 S -> L6p S -> L7 S -> L8 S -> L10 X ->
// effect_now -> judge (A2b, A4-A15) -> INSERTs. The real route over PostgreSQL through the runtime logins; the superuser only reads; the
// Gmail and Resend providers are K1's labelled contract fakes (SIMULATED). Written FIRST (lane L-SEND TD): every title fails until the lane
// builds send.ts and the dispatcher; every race cell fails under its §M control (KAURO_B12_CONTROL=<M>) at its forbidden-effect assertion.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FaultContext } from "@kauro/persistence/testing";
import {
  answerOf, callsOf, callsTotal, cell, DAY_MS, draftRow, draftState, epochUs, firstContacts, firstContacts24h, grantReserved, holdSubject, intent, intentIdOf, intentsOfDraft,
  intentsOfProspect, journalStates, msOf, onEffectClock, onlyIntent, OUTCOME, outboxOf, plusMs, plusUs, queued, raceAtWrite, send, sendIntendedEvents, sendWorld,
  sentFirst, sha256, staged, stateOf, T0, tokenOf, W, waitingBehind, warningsOf, type DraftP, type GrantP, type RaceResult, type SendWorld, type SellerP, type Staged,
} from "./b12-send-support.js";
import type { Reply } from "./support.js";

let w: SendWorld;
before(async () => {
  w = await sendWorld("cmd063");
});
after(async () => {
  await w.stop();
});

const out = (r: Reply): string => w.outcome(r);
const keyOf = (label: string): string => `cmd063-${label}-${Math.random().toString(36).slice(2, 14)}`.padEnd(20, "0");
/** CMD063 refused: the expected outcome, no new intent of the draft, no outbox record, zero provider calls even after a dispatcher pass. */
async function refused(what: string, act: () => Promise<Reply>, expected: string, d: DraftP, intentsBefore = 0): Promise<Reply> {
  const calls = callsTotal(w);
  const resendCalls = w.resend.calls.length;
  const outbox = await outboxTotal();
  const reply = await act();
  assert.equal(out(reply), expected, `${what}: ${reply.text}`);
  const rows = await intentsOfDraft(w, d.draftId);
  assert.equal(rows.length, intentsBefore, `${what}: no new intent of the draft (has ${rows.map(stateOf).join(", ")})`);
  assert.equal(await outboxTotal(), outbox, `${what}: no outbox record`);
  assert.deepEqual([callsTotal(w), w.resend.calls.length], [calls, resendCalls], `${what}: zero provider calls`);
  return reply;
}
async function outboxTotal(): Promise<number> {
  return (await w.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.outbox_records o JOIN kauro.domain_events e ON e.event_id = o.event_id WHERE e.event_type = 'outreach.send_intended.v1'")).rows[0]!.n;
}

// --- CMD063-OK ---------------------------------------------------------------------------------------------------------------------------
test("CMD063-OK: the assigned seller sends a sealed draft under a live grant: 200 one QUEUED intent (draft DRAFT -> AUTHORIZED) with payload hash and grant reference, one outbox record; the dispatcher submits once through the Gmail contract fake and records PROVIDER_ACCEPTED with the provider id (draft PROVIDER_ACCEPTED), never DELIVERED", async () => {
  w.standAt(T0);
  const s = await staged(w, "ok");
  assert.equal(await draftState(w, s.draft), "DRAFT", "the sealed draft is DRAFT before the send");
  const reply = await send(w, s.seller, s.draft, s.grant);
  const intentId = intentIdOf(reply);
  assert.equal(reply.json<{ data: { intentState: string } }>().data.intentState, "QUEUED", "the answer names the intent QUEUED");
  const i = await onlyIntent(w, s.draft);
  assert.deepEqual([i.intentId, i.state, i.authorizationId, i.personUserId, i.prospectId, i.purpose, i.route], [intentId, "QUEUED", s.grant.authorizationId, s.seller.userId, s.prospect.prospectId, "INDIVIDUAL_PROSPECT_CONTACT", "GMAIL_API"]);
  assert.match(i.payloadHash, /^[0-9a-f]{64}$/, "the payload hash is a sha256");
  assert.equal(i.countedAt, T0, "counted at the effect instant");
  assert.equal(await draftState(w, s.draft), "AUTHORIZED", "draft DRAFT -> AUTHORIZED");
  assert.deepEqual(await outboxOf(w, intentId), [{ state: "PENDING", attempts: 0 }], "one outbox record");
  assert.equal(await sendIntendedEvents(w, s.draft.draftId), 1, "one outreach.send_intended.v1 event");
  assert.equal(callsOf(w, intentId), 0, "no provider call before the dispatcher");
  w.gmail.script({ kind: "ACCEPTED", ref: "gmail-msg-cmd063-ok" });
  await w.dispatcher().pass();
  assert.equal(callsOf(w, intentId), 1, "exactly one submission");
  const sent = await intent(w, intentId);
  assert.deepEqual([sent.state, sent.providerRef], ["PROVIDER_ACCEPTED", "gmail-msg-cmd063-ok"], "PROVIDER_ACCEPTED with the provider id");
  assert.equal(await draftState(w, s.draft), "PROVIDER_ACCEPTED");
  const kinds = (await w.oracle.query<{ kind: string }>("SELECT kind FROM kauro.sales_activities WHERE intent_id = $1", [intentId])).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["PROVIDER_ACCEPTED"], "one PROVIDER_ACCEPTED activity, no DELIVERED");
  await w.dispatcher().pass();
  assert.equal(callsOf(w, intentId), 1, "a second pass submits nothing");
  const states = (await w.oracle.query<{ s: string }>("SELECT DISTINCT state AS s FROM kauro.outreach_send_intents UNION SELECT DISTINCT state FROM kauro.outreach_drafts")).rows.map((r) => r.s);
  assert.ok(!states.includes("DELIVERED"), "DELIVERED is never produced");
});

test("CMD063-OK (payload): the submitted MIME is text/plain with the bound From, the draft subject, the commercial identification line, the deployment postal address, exactly one List-Unsubscribe URI which is https and names this intent's token, List-Unsubscribe-Post: List-Unsubscribe=One-Click, an opt-out URL in the body, no image or remote resource, and sha256 equal to the intent's payload hash", async () => {
  w.standAt(T0);
  const s = await staged(w, "payload");
  const intentId = await queued(w, s);
  await w.dispatcher().pass();
  const subs = w.gmail.submissions.filter((x) => x.intentId === intentId);
  assert.equal(subs.length, 1, "one submission");
  const mime = subs[0]!.mime;
  const [head, ...rest] = mime.split(/\r\n\r\n/);
  const body = rest.join("\r\n\r\n");
  const headers = head!.split(/\r\n(?![ \t])/).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()] as const);
  const all = (name: string): string[] => headers.filter(([k]) => k === name).map(([, v]) => v);
  const { subject } = await w.contentOf(s.draft);
  assert.match(all("content-type").join("|"), /^text\/plain(;|$)/, "text/plain only");
  assert.ok(!/multipart\//i.test(mime), "no multipart part");
  assert.equal(all("from").length, 1);
  assert.ok(all("from")[0]!.includes(s.seller.sender.address), `From is the bound identity ${s.seller.sender.address}: ${all("from")[0]}`);
  assert.deepEqual(all("subject"), [subject], "Subject is the draft subject");
  const lu = all("list-unsubscribe");
  assert.equal(lu.length, 1, "exactly one List-Unsubscribe header");
  const uris = [...lu[0]!.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
  assert.equal(uris.length, 1, `exactly one List-Unsubscribe URI: ${lu[0]}`);
  assert.match(uris[0]!, /^https:\/\//, "the URI is https (RFC 8058 s.3.1)");
  const token = tokenOf(w, intentId);
  assert.ok(uris[0]!.includes(token), "the URI names this intent's token");
  assert.deepEqual(all("list-unsubscribe-post"), ["List-Unsubscribe=One-Click"]);
  assert.ok(body.includes(uris[0]!), "the opt-out URL is in the body");
  assert.ok(body.includes(w.compliance.commercialIdentification), "the commercial identification line");
  assert.ok(body.includes(w.compliance.postalAddress), "the deployment postal address");
  assert.ok(!/<img|src=|http:\/\/|image\//i.test(mime), "no image or remote resource");
  assert.equal(sha256(mime), (await intent(w, intentId)).payloadHash, "sha256(MIME) = the intent's payload hash");
});

// --- CMD063-DENY -------------------------------------------------------------------------------------------------------------------------
test("CMD063-DENY: foreign and TERMINATED callers 403; then stale version, changed content hash, revoked, exhausted or uncovering grant, suppressed contact, RESEND sender (KC028), open SEND_UNCERTAIN of the prospect (KC029), draft AUTHORIZED, SUBMITTING, PROVIDER_ACCEPTED, BOUNCED or REPLIED (KC036), draft CANCELLED (409 DRAFT_CLOSED), follow-up while the first is still QUEUED (KC032 FIRST_NOT_SENT), follow-up after REPLIED or after BOUNCED, person paused by one bounce in its latest 50 (KC034), missing compliance configuration, uncovered calendar year (KC037): 409/503, no intent, no outbox, zero provider calls", async () => {
  w.standAt(T0);
  // callers
  {
    const s = await staged(w, "deny-foreign");
    const other = await w.seller("deny-foreign-other");
    assert.equal((await send(w, other, s.draft, s.grant)).status, 403, "another seller is 403");
    assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 0);
    const member = await w.agencyMember("deny-member");
    assert.equal((await send(w, member, s.draft, s.grant)).status, 403, "an agency member is 403");
    const t = await staged(w, "deny-terminated");
    assert.ok((await w.routes.terminate(t.seller)).status < 300, "CMD050 terminates the seller");
    assert.equal((await send(w, t.seller, t.draft, t.grant)).status, 403, "a TERMINATED seller is 403");
    assert.equal((await intentsOfDraft(w, t.draft.draftId)).length, 0);
  }
  {
    const s = await staged(w, "deny-version");
    await refused("stale version", () => send(w, s.seller, s.draft, s.grant, { expectedVersion: s.draft.version + 1 }), OUTCOME.STALE, s.draft);
    await refused("changed content hash", () => send(w, s.seller, s.draft, s.grant, { contentHash: sha256("another body") }), OUTCOME.KC030, s.draft);
    assert.ok((await w.routes.revokeGrant(s.grant)).status < 300, "the owner revokes the grant");
    await refused("revoked grant", () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC030, s.draft);
  }
  {
    // exhausted: a one-send grant over two drafts of one sender (two prospects): the first is admitted, the second is refused
    const seller = await w.seller("deny-exhausted");
    const p1 = await w.prospect(seller);
    const p2 = await w.prospect(seller);
    const d1 = await w.draft(seller, p1, seller.sender);
    const d2 = await w.draft(seller, p2, seller.sender);
    const g = await w.grant([d1, d2], { maximumSends: 1 });
    intentIdOf(await send(w, seller, d1, g));
    assert.equal(await grantReserved(w, g), 1);
    await refused("exhausted grant", () => send(w, seller, d2, g), OUTCOME.KC030, d2);
    assert.equal(await grantReserved(w, g), 1, "the grant stays at 1 of 1");
    // uncovering: a grant that does not seal the draft
    const d3 = await w.draft(seller, await w.prospect(seller), seller.sender);
    await refused("uncovering grant", () => send(w, seller, d3, g), OUTCOME.KC030, d3);
  }
  {
    const s = await staged(w, "deny-suppressed");
    await w.routes.suppress({ contactKey: s.prospect.contactKey });
    await refused("suppressed contact", () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC016, s.draft);
  }
  {
    const seller = await w.seller("deny-resend");
    const resend = await w.sender(seller, { route: "RESEND_TRANSACTIONAL" });
    const s = await staged(w, "deny-resend", { seller, sender: resend });
    await refused("RESEND sender", () => send(w, seller, s.draft, s.grant), OUTCOME.KC028, s.draft);
    assert.equal(w.resend.calls.length, 0, "zero Resend calls");
  }
  {
    // an open SEND_UNCERTAIN of the prospect: another draft of the same prospect is KC029
    const s = await staged(w, "deny-uncertain");
    const first = await queued(w, s);
    w.gmail.script({ kind: "ACCEPTED_ANSWER_LOST" });
    await w.dispatcher().dispatch(first); // this intent alone: a pass would also dispatch the QUEUED intents earlier blocks of this test left, and one of them would take the scripted answer
    assert.equal((await intent(w, first)).state, "SEND_UNCERTAIN");
    const other = await w.draft(s.seller, s.prospect, s.seller.sender, { label: "deny-uncertain-2" });
    const g = await w.grant([other]);
    await refused("open SEND_UNCERTAIN of the prospect", () => send(w, s.seller, other, g), OUTCOME.KC029, other);
    await refused("draft SEND_UNCERTAIN itself", () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC029, s.draft, 1);
  }
  {
    // draft states AUTHORIZED, SUBMITTING, PROVIDER_ACCEPTED, BOUNCED, REPLIED: KC036 (a two-send grant, so only the draft state refuses)
    const seller = await w.seller("deny-states");
    const mk = async (label: string): Promise<{ d: DraftP; g: GrantP }> => {
      const d = await w.draft(seller, await w.prospect(seller), seller.sender, { label });
      const spare = await w.draft(seller, await w.prospect(seller), seller.sender, { label: `${label}-spare` });
      return { d, g: await w.grant([d, spare], { maximumSends: 2 }) };
    };
    const a = await mk("authorized");
    intentIdOf(await send(w, seller, a.d, a.g));
    assert.equal(await draftState(w, a.d), "AUTHORIZED");
    await refused("draft AUTHORIZED", () => send(w, seller, a.d, a.g), OUTCOME.KC036, a.d, 1);
    const sub = await mk("submitting");
    const subId = intentIdOf(await send(w, seller, sub.d, sub.g));
    const held = w.gmail.holdNext();
    const running = w.dispatcher().dispatch(subId);
    await held.reached;
    assert.equal(await draftState(w, sub.d), "SUBMITTING");
    assert.equal(out(await send(w, seller, sub.d, sub.g)), OUTCOME.KC036, "draft SUBMITTING");
    held.answer({ kind: "ACCEPTED", ref: "gmail-deny-submitting" });
    await running;
    assert.equal(await draftState(w, sub.d), "PROVIDER_ACCEPTED");
    await refused("draft PROVIDER_ACCEPTED", () => send(w, seller, sub.d, sub.g), OUTCOME.KC036, sub.d, 1);
    assert.equal(callsOf(w, subId), 1, "the accepted draft was submitted once");
    const b = await mk("bounced");
    const bId = intentIdOf(await send(w, seller, b.d, b.g));
    await w.dispatcher().dispatch(bId);
    assert.ok((await w.routes.recordActivity(seller, { kind: "BOUNCED", intentId: bId, evidenceRef: "dsn-deny-bounced" })).status < 300, "BOUNCED recorded");
    assert.equal(await draftState(w, b.d), "BOUNCED");
    await refused("draft BOUNCED", () => send(w, seller, b.d, b.g), OUTCOME.KC036, b.d, 1);
    // a bounce pauses the person until the owner's diagnosis (KC034): lifted, so only the draft state refuses below
    assert.ok((await w.routes.diagnose(seller.userId)).status < 300, "the owner's diagnosis lifts the pause");
    const r = await mk("replied");
    const rId = intentIdOf(await send(w, seller, r.d, r.g));
    await w.dispatcher().dispatch(rId);
    assert.ok((await w.routes.recordActivity(seller, { kind: "REPLIED", intentId: rId, inboundRef: "inbound-deny-replied" })).status < 300, "REPLIED recorded");
    assert.equal(await draftState(w, r.d), "REPLIED");
    await refused("draft REPLIED", () => send(w, seller, r.d, r.g), OUTCOME.KC036, r.d, 1);
  }
  {
    // draft CANCELLED: the owner's draft on a seller's prospect, the seller terminated before the claim -> CANCELLED(RECIPIENT_CHANGED)
    const seller = await w.seller("deny-cancelled");
    const p = await w.prospect(seller);
    const ownerSender = await w.sender(w.owner);
    const d = await w.draft(w.owner, p, ownerSender);
    // a grant seals one hash per send it allows (KC030 "seals N hashes for M sends"): a spare draft seals the second
    const spare = await w.draft(w.owner, await w.prospect(seller), ownerSender, { label: "deny-cancelled-spare" });
    const g = await w.grant([d, spare], { maximumSends: 2 });
    const id = intentIdOf(await send(w, w.owner, d, g));
    assert.ok((await w.routes.terminate(seller)).status < 300);
    await w.dispatcher().pass();
    assert.equal(stateOf(await intent(w, id)), "CANCELLED(RECIPIENT_CHANGED)");
    assert.equal(await draftState(w, d), "CANCELLED");
    await refused("draft CANCELLED", () => send(w, w.owner, d, g), OUTCOME.DRAFT_CLOSED, d, 1);
  }
  {
    // follow-up while the first is still QUEUED: KC032 FIRST_NOT_SENT
    const s = await staged(w, "deny-first-queued");
    await queued(w, s);
    const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
    const g = await w.grant([f]);
    const reply = await refused("follow-up while the first is QUEUED", () => send(w, s.seller, f, g), OUTCOME.KC032, f);
    assert.equal(w.subReason(reply), "FIRST_NOT_SENT");
  }
  for (const stop of ["REPLIED", "BOUNCED"] as const) {
    const s = await staged(w, `deny-after-${stop}`);
    const first = await sentFirst(w, s);
    const activity = stop === "REPLIED" ? { kind: "REPLIED", intentId: first, inboundRef: `inbound-${first}` } : { kind: "BOUNCED", intentId: first, evidenceRef: `dsn-${first}` };
    assert.ok((await w.routes.recordActivity(s.seller, activity)).status < 300, `${stop} recorded`);
    if (stop === "BOUNCED") assert.ok((await w.routes.diagnose(s.seller.userId)).status < 300, "the owner's diagnosis lifts the pause, so only the stop fact refuses");
    w.standAt(plusMs(T0, 7 * DAY_MS)); // inside [first + 5 business days, first + 14 days)
    const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
    const g = await w.grant([f]);
    const reply = await refused(`follow-up after ${stop}`, () => send(w, s.seller, f, g), OUTCOME.KC032, f);
    assert.equal(w.subReason(reply), "CADENCE_CLOSED");
    w.standAt(T0);
  }
  {
    // one BOUNCED among the person's latest 50 counted intents pauses it: a new first contact of another prospect is KC034
    const s = await staged(w, "deny-paused");
    const first = await sentFirst(w, s);
    assert.ok((await w.routes.recordActivity(s.seller, { kind: "BOUNCED", intentId: first, evidenceRef: `dsn-${first}` })).status < 300);
    const n = await staged(w, "deny-paused-next", { seller: s.seller });
    await refused("person paused by one bounce", () => send(w, s.seller, n.draft, n.grant), OUTCOME.KC034, n.draft);
  }
  {
    const s = await staged(w, "deny-compliance");
    const restore = w.setCompliance(null);
    try {
      await refused("missing compliance configuration", () => send(w, s.seller, s.draft, s.grant), OUTCOME.COMPLIANCE, s.draft);
    } finally {
      restore();
    }
  }
  {
    // the outreach calendar is seeded for 2026-2028: a Wednesday of 2029 is not covered
    w.standAt("2029-01-10T15:00:00.000000Z");
    const s = await staged(w, "deny-calendar", { validFrom: "2029-01-10T14:00:00.000000Z", expiresAt: "2029-01-11T14:00:00.000000Z" }); // a grant live on that day, so only the calendar refuses
    await refused("uncovered calendar year", () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC037, s.draft);
    w.standAt(T0);
  }
});

// --- CMD063-RACE (journal, crash) --------------------------------------------------------------------------------------------------------
cell("CMD063-RACE: identical retry replays one intent (journal L2), same key other hash is 409, crash before COMMIT no intent and after COMMIT one intent replayed", "retry", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "race-retry", { maximumSends: 1 });
  const key = keyOf("retry");
  const first = await ctx.attempt(() => send(w, s.seller, s.draft, s.grant, { key }));
  const again = await ctx.attempt(() => send(w, s.seller, s.draft, s.grant, { key }));
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 1, "identical retry: one intent");
  // the replay is the journaled answer byte for byte, marked replayed (the platform's envelope: `replayed: true` on a replay, false on the first answer)
  const parsed = (r: { text: string }): Record<string, unknown> => JSON.parse(r.text) as Record<string, unknown>;
  assert.deepEqual([again.status, { ...parsed(again), replayed: false }], [first.status, parsed(first)], "identical retry replays the 200");
  assert.equal(parsed(again)["replayed"], true, "the replay is marked replayed");
  const other = await ctx.attempt(() => send(w, s.seller, s.draft, s.grant, { key, contentHash: sha256("other") }));
  assert.equal(out(other), OUTCOME.KEY_REUSED, "same key other hash is 409");
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 1, "still one intent");
  assert.deepEqual(await journalStates(w, key), ["COMMITTED"]);
  // crash before COMMIT (the target unit's before-commit, after the outbox INSERT): nothing; the same key then commits once
  const b = await staged(w, "race-crash-before");
  const kb = keyOf("crash-before");
  const crashBefore = ctx.points.crash("target.before-commit");
  const conn = await w.open("kauro_app_test");
  const crashed = await ctx.operation("CMD063 crashed before COMMIT", () => w.on(conn, "kauro_app", ctx, [W.outboxInsert], () => send(w, b.seller, b.draft, b.grant, { key: kb }), { target: 1 }));
  await crashBefore.reached;
  await conn.end().catch(() => undefined);
  assert.equal(crashed.status, 500, "the unit crashed before its COMMIT (no answer)");
  assert.ok(ctx.points.passed.includes("db.outbox_insert.after"), "the crash came after the outbox INSERT");
  assert.equal((await intentsOfDraft(w, b.draft.draftId)).length, 0, "crash before COMMIT: no intent");
  assert.equal(await draftState(w, b.draft), "DRAFT");
  assert.deepEqual(await journalStates(w, kb), [], "no journal row");
  intentIdOf(await send(w, b.seller, b.draft, b.grant, { key: kb }));
  assert.equal((await intentsOfDraft(w, b.draft.draftId)).length, 1, "the same key then commits one intent");
  // crash after COMMIT: the answer is lost, the intent is committed, and the same key replays it
  const a = await staged(w, "race-crash-after");
  const ka = keyOf("crash-after");
  const crashAfter = ctx.points.crash("target.after-commit");
  const conn2 = await w.open("kauro_app_test");
  const lost = await ctx.operation("CMD063 crashed after COMMIT", () => w.on(conn2, "kauro_app", ctx, [], () => send(w, a.seller, a.draft, a.grant, { key: ka }), { target: 1 }));
  await crashAfter.reached;
  await conn2.end().catch(() => undefined);
  assert.equal(lost.status, 500, "the answer was lost after COMMIT");
  const committed = await onlyIntent(w, a.draft);
  assert.deepEqual([committed.state, await draftState(w, a.draft)], ["QUEUED", "AUTHORIZED"], "crash after COMMIT: the intent is committed QUEUED, the draft AUTHORIZED");
  const replay = await send(w, a.seller, a.draft, a.grant, { key: ka });
  assert.equal(intentIdOf(replay), committed.intentId, "the same key replays the committed intent");
  assert.equal((await intentsOfDraft(w, a.draft.draftId)).length, 1, "one intent after the replay");
  assert.equal(await grantReserved(w, a.grant), 1, "the grant reserved once");
});

// --- §M race cells of CMD063 -------------------------------------------------------------------------------------------------------------
type Order = 1 | 2;
const ORDERS: ReadonlyArray<Order> = [1, 2];
const cmd063Actor = (name: string, actor: SellerP | { readonly userId: string; readonly token: string }, d: DraftP, g: GrantP) => ({ name, role: "kauro_app" as const, run: () => send(w, actor, d, g), at: W.intentInsert });
const replyOf = (s: RaceResult<unknown, unknown>["first"], what: string): Reply => answerOf(s, what) as Reply;
async function countedOfProspect(prospectId: string): Promise<number> {
  return (await intentsOfProspect(w, prospectId)).filter((i) => ["QUEUED", "SUBMITTING", "PROVIDER_ACCEPTED", "SEND_UNCERTAIN", "OBSERVED_SENT"].includes(i.state)).length;
}

cell("GAP-SE-1 RACE (sequence) M1: CMD063 of the owner and CMD063 of the assigned seller, one prospect, two drafts, two grants, held at the prospect subject L3 in both orders: order 1 the first 200 and the other 409 KC032; order 2 symmetric; red with L3 removed from both (two QUEUED intents of one prospect)", "race", async (ctx: FaultContext) => {
  // traces: seller CMD063 L1 S(seller), L2, L3 X(P), L4 X(seller), L4g S, ..., L10 X(dS); owner CMD063 L1 S(owner, assigned seller), L2, L3 X(P), L4 X(owner), ..., L10 X(dO): they share only L3
  w.standAt(T0);
  const ownerSender = await w.sender(w.owner);
  const runs: Array<{ order: Order; p: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m1-${order}`);
    const p = await w.prospect(seller);
    const dS = await w.draft(seller, p, seller.sender);
    const dO = await w.draft(w.owner, p, ownerSender);
    const [gS, gO] = [await w.grant([dS]), await w.grant([dO])];
    const S = cmd063Actor("seller CMD063", seller, dS, gS);
    const O = cmd063Actor("owner CMD063", w.owner, dO, gO);
    runs.push({ order, p: p.prospectId, r: await raceAtWrite(ctx, "M1", order === 1 ? S : O, order === 1 ? O : S) });
  }
  for (const { order, p } of runs) assert.equal(await countedOfProspect(p), 1, `order ${order}: exactly one counted intent of the prospect (forbidden: two QUEUED intents of one prospect)`);
  for (const { order, r } of runs) {
    assert.equal(replyOf(r.first, "first").status, 200, `order ${order}: the first holder 200`);
    assert.equal(out(replyOf(r.second, "second")), OUTCOME.KC032, `order ${order}: the other 409 KC032`);
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first's L3 in both orders");
});

cell("GAP-SE-8 RACE (grant) M2: two CMD063 of one person on two prospects under one grant of maximumSends 1, held at the person subject L4 in both orders: order 1 the first 200 and the other 409 KC030; order 2 symmetric; red with L4 removed from both (two COUNTED intents on a max-1 grant)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; g: GrantP; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m2-${order}`);
    const [d1, d2] = [await w.draft(seller, await w.prospect(seller), seller.sender), await w.draft(seller, await w.prospect(seller), seller.sender)];
    const g = await w.grant([d1, d2], { maximumSends: 1 });
    const A = cmd063Actor("CMD063 P1", seller, d1, g);
    const B = cmd063Actor("CMD063 P2", seller, d2, g);
    runs.push({ order, g, r: await raceAtWrite(ctx, "M2", order === 1 ? A : B, order === 1 ? B : A) });
  }
  for (const { order, g } of runs) assert.equal(await grantReserved(w, g), 1, `order ${order}: the max-1 grant reserves exactly 1 (forbidden: 2)`);
  for (const { order, r } of runs) {
    assert.equal(replyOf(r.first, "first").status, 200, `order ${order}: first 200`);
    assert.equal(out(replyOf(r.second, "second")), OUTCOME.KC030, `order ${order}: other 409 KC030`);
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-2 RACE (cap) M2: with 9 first contacts of the person counted, two CMD063 first contacts of that person on two prospects under two grants, held at the person subject L4 in both orders: order 1 the first 200 and the other 409 KC032 CAP_REACHED; order 2 symmetric; red with L4 removed from both (11 first contacts in 24 h)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; seller: SellerP; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m2cap-${order}`);
    await firstContacts(w, seller, 9, `m2cap-${order}`);
    const a = await staged(w, `m2cap-${order}-a`, { seller });
    const b = await staged(w, `m2cap-${order}-b`, { seller });
    const A = cmd063Actor("CMD063 P10", seller, a.draft, a.grant);
    const B = cmd063Actor("CMD063 P11", seller, b.draft, b.grant);
    runs.push({ order, seller, r: await raceAtWrite(ctx, "M2", order === 1 ? A : B, order === 1 ? B : A) });
  }
  for (const { order, seller } of runs) assert.equal(await firstContacts24h(w, seller.userId, T0), 10, `order ${order}: 10 first contacts of the person in 24 h (forbidden: 11)`);
  for (const { order, r } of runs) {
    assert.equal(replyOf(r.first, "first").status, 200);
    const second = replyOf(r.second, "second");
    assert.equal(out(second), OUTCOME.KC032, `order ${order}: 409 KC032`);
    assert.equal(w.subReason(second), "CAP_REACHED");
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-3 TIMEOUT: at the person subject L4", "race", async (ctx) => {
  // CMD063 waiting at L4 X (held by a test connection) past the routed statement_timeout answers 503 retryable and writes nothing; the same key then commits once
  w.standAt(T0);
  const s = await staged(w, "timeout-l4");
  const key = keyOf("timeout");
  const hold = await holdSubject(w, "L4", s.seller.userId, "X");
  w.setStatementTimeout(1_500);
  let reply: Reply;
  try {
    const waiting = await waitingBehind(ctx, w, hold, "kauro_app", "CMD063 waits at the person subject L4", () => send(w, s.seller, s.draft, s.grant, { key }), [W.personLock]);
    reply = await waiting.pending;
  } finally {
    w.setStatementTimeout(null);
    await hold.release();
  }
  assert.equal(out(reply), OUTCOME.TIMEOUT, `503 retryable: ${reply.text}`);
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 0, "no intent");
  assert.equal(await draftState(w, s.draft), "DRAFT", "the draft stays DRAFT");
  assert.deepEqual(await journalStates(w, key), [], "no journal reservation survives");
  intentIdOf(await send(w, s.seller, s.draft, s.grant, { key }));
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 1, "the same key then commits once");
});

cell("GAP-SE-4 EXPIRY (wait): expiresAt crossed while waiting at the last await L10 X (§W holder): refused at effect_now after it (red with server_now)", "expiry", async (ctx) => {
  // §W CMD063 row: the last await before the judgment is L10 X; the holder holds the draft subject (as a PrepareOutreachReview paused at its judgment with L10 S)
  const expiresAt = plusMs(T0, 60_000);
  w.standAt(T0);
  const s = await staged(w, "expiry-wait", { expiresAt });
  w.standAt(null);
  const deadline = ctx.deadline(msOf(expiresAt), "the grant's expiresAt");
  ctx.clock.set(msOf(expiresAt) - 30_000);
  const reply = await onEffectClock(ctx, w, "CMD063 waiting at L10 X across expiresAt", async () => {
    const hold = await holdSubject(w, "L10", s.draft.draftId, "S");
    try {
      const waiting = await waitingBehind(ctx, w, hold, "kauro_app", "CMD063 waits at the draft subject L10", () => send(w, s.seller, s.draft, s.grant), [W.draftLock]);
      ctx.clock.past(deadline);
      await hold.release();
      return await waiting.pending;
    } catch (e) {
      await hold.release().catch(() => undefined);
      throw e;
    }
  });
  assert.equal(out(reply), OUTCOME.KC030, `refused at effect_now after the wait: ${reply.text}`);
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 0, "no intent on an expired grant");
  assert.equal(await draftState(w, s.draft), "DRAFT");
  assert.equal(await grantReserved(w, s.grant), 0);
});

cell("GAP-SE-5 RACE (seller) M5: CMD063 against CMD050 terminating the sending seller, held at the seller subject L1 in both orders: order 1 (CMD050 holds) CMD063 403 and no intent; order 2 (CMD063 holds) 200 and the intent CANCELLED(SELLER_NOT_ACTIVE) at its claim with zero calls; red with L1 removed from both (a QUEUED intent of a TERMINATED seller admitted)", "race", async (ctx) => {
  // traces: CMD063 L1 S(seller) first; CMD050 L1 row FOR NO KEY UPDATE (commercial-sales.ts:369) then L1 X (:372), UPDATE sellers
  w.standAt(T0);
  const runs: Array<{ order: Order; s: Staged; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m5-${order}`);
    const C = cmd063Actor("CMD063", s.seller, s.draft, s.grant);
    const T = { name: "CMD050", role: "kauro_app" as const, run: () => w.routes.terminate(s.seller), at: W.sellerUpdate };
    runs.push({ order, s, r: await raceAtWrite(ctx, "M5", order === 1 ? T : C, order === 1 ? C : T) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.s.draft.draftId)).length, 0, "order 1: no intent born after the termination committed (forbidden effect)");
  assert.equal(replyOf(o1.r.second, "CMD063").status, 403, "order 1: CMD063 403");
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  assert.ok(replyOf(o2.r.second, "CMD050").status < 300, "order 2: the termination commits after it");
  await w.dispatcher().pass();
  assert.equal(stateOf(await intent(w, id)), "CANCELLED(SELLER_NOT_ACTIVE)", "order 2: cancelled at the claim");
  assert.equal(callsOf(w, id), 0, "order 2: zero provider calls");
  assert.equal(await draftState(w, o2.s.draft), "CANCELLED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-6 RACE (revocation) M13: CMD063 against RecordSenderRevocation of the draft's sender, held at the sender subject L7 in both orders: order 1 (revocation holds) 409 SENDER_REVOKED and no intent; order 2 (CMD063 holds) 200 and the intent CANCELLED(SENDER_REVOKED) at its claim with zero calls; red with L7 removed from both (a row on a REVOKED sender)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; s: Staged; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m13-${order}`);
    const C = cmd063Actor("CMD063", s.seller, s.draft, s.grant);
    const R = { name: "RecordSenderRevocation", role: "kauro_app" as const, run: () => w.routes.revokeSender(s.seller.sender.senderId), at: W.senderUpdate };
    runs.push({ order, s, r: await raceAtWrite(ctx, "M13", order === 1 ? R : C, order === 1 ? C : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.s.draft.draftId)).length, 0, "order 1: no intent on a REVOKED sender (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.SENDER_REVOKED);
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await w.dispatcher().pass();
  assert.equal(stateOf(await intent(w, id)), "CANCELLED(SENDER_REVOKED)");
  assert.equal(callsOf(w, id), 0);
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-7 PARTIAL: failure at the outbox INSERT rolls back intent, draft, event, journal", "partial", async (ctx) => {
  w.standAt(T0);
  const s = await staged(w, "partial");
  const key = keyOf("partial");
  const before = await draftRow(w, s.draft);
  const conn = await w.open("kauro_app_test");
  await ctx.partial("CMD063 failing at its outbox INSERT after the intent INSERT", "db.outbox_insert.before", () => w.on(conn, "kauro_app", ctx, [W.intentInsert, W.outboxInsert], () => send(w, s.seller, s.draft, s.grant, { key })));
  await conn.end().catch(() => undefined);
  assert.ok(ctx.points.passed.includes("db.intent_insert.after"), "the intent INSERT had completed");
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 0, "no intent");
  assert.deepEqual(await draftRow(w, s.draft), before, "the draft DRAFT at its version and hash");
  assert.equal(await sendIntendedEvents(w, s.draft.draftId), 0, "no outreach.send_intended.v1 event");
  assert.deepEqual(await journalStates(w, key), [], "no journal row");
  assert.equal(await grantReserved(w, s.grant), 0);
  intentIdOf(await send(w, s.seller, s.draft, s.grant, { key }));
  assert.equal((await intentsOfDraft(w, s.draft.draftId)).length, 1, "the same-key retry commits one intent");
  assert.equal(await sendIntendedEvents(w, s.draft.draftId), 1);
});

cell("GAP-SE-10 RACE (suppression) M23: the public opt-out through the token of a sent message to contact K against CMD063 of another prospect's draft to K, held at the suppression key L8 in both orders: order 1 (opt-out holds) 409 PROSPECT_SUPPRESSED and no intent; order 2 (CMD063 holds) 200 and NOT_SENT(SUPPRESSED) at its claim with zero calls; red with L8 removed from both (an intent born after the suppression)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; d: DraftP; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const contact = `m23-${order}-${Date.now()}@contact.example`;
    const s1 = await staged(w, `m23-${order}-a`, { prospect: await w.prospect(await w.seller(`m23-${order}-a`), { contact }) });
    const sent = await sentFirst(w, s1);
    const token = tokenOf(w, sent); // the token of the message the fake recorded (rule 24b)
    const seller2 = await w.seller(`m23-${order}-b`);
    const s2 = await staged(w, `m23-${order}-b`, { seller: seller2, prospect: await w.prospect(seller2, { contact }) });
    const O = { name: "opt-out", role: "kauro_app" as const, run: () => w.routes.optOut(token), at: W.suppressionInsert };
    const C = cmd063Actor("CMD063", seller2, s2.draft, s2.grant);
    runs.push({ order, d: s2.draft, r: await raceAtWrite(ctx, "M23", order === 1 ? O : C, order === 1 ? C : O) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.d.draftId)).length, 0, "order 1: no intent born after the suppression (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.KC016);
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await w.dispatcher().pass();
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(SUPPRESSED)");
  assert.equal(callsOf(w, id), 0);
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-11 RACE (grant release) M15: D4 recording NOT_SENT(PROVIDER_REJECTED:400) of P1's intent against CMD063 of P2's draft, one person, one one-send grant over both, held at the person subject L4 in both orders: order 1 (D4 holds) CMD063 waits, then 200; order 2 (CMD063 holds) 409 KC030 and D4 then releases the grant; red with L4 removed from both (order 1 a stale 409)", "race", async (ctx) => {
  // traces: D4 L1 set S, L3 S(P1), L4 S(person), L4g S, L10 X(d1); CMD063 L1 S, L2, L3 X(P2), L4 X(person), L4g S(g), ..., L10 X(d2): L4 S/X meet
  w.standAt(T0);
  const runs: Array<{ order: Order; g: GrantP; i1: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const seller = await w.seller(`m15-${order}`);
    const [d1, d2] = [await w.draft(seller, await w.prospect(seller), seller.sender), await w.draft(seller, await w.prospect(seller), seller.sender)];
    const g = await w.grant([d1, d2], { maximumSends: 1 });
    const i1 = intentIdOf(await send(w, seller, d1, g));
    const disp = w.dispatcher();
    assert.equal(await disp.claim(i1), "ADMITTED");
    w.gmail.script({ kind: "REJECTED_DEFINITIVE", status: 400 });
    const answer = await disp.submit(i1);
    assert.deepEqual(answer, { kind: "REJECTED_DEFINITIVE", status: 400 });
    const D = { name: "D4 NOT_SENT(400)", role: "kauro_outreach" as const, run: () => disp.record(i1, answer), at: W.d4First };
    const C = cmd063Actor("CMD063 P2", seller, d2, g);
    runs.push({ order, g, i1, r: await raceAtWrite<unknown, unknown>(ctx, "M15", order === 1 ? D : C, order === 1 ? C : D) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal(replyOf(o1.r.second, "CMD063").status, 200, "order 1: CMD063 judged the grant after D4 released it (forbidden: a stale 409)");
  assert.equal(out(replyOf(o2.r.first, "CMD063")), OUTCOME.KC030, "order 2: 409 KC030 while the grant was reserved");
  for (const { order, g, i1 } of runs) {
    assert.equal(stateOf(await intent(w, i1)), "NOT_SENT(PROVIDER_REJECTED:400)", `order ${order}: D4 recorded the refusal`);
    assert.equal(await grantReserved(w, g), order === 1 ? 1 : 0, `order ${order}: grant reserved`);
  }
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

test("GAP-SE-12 DENY (second identity): a person at 10 first contacts in 24 h on its first identity is refused the 11th through a second verified identity (409 KC032 CAP_REACHED): the cap is the person's, summed over all of its identities; no intent, zero calls", async () => {
  w.standAt(T0);
  const seller = await w.seller("se12");
  await firstContacts(w, seller, 10, "se12");
  assert.equal(await firstContacts24h(w, seller.userId, T0), 10);
  const second = await w.sender(seller);
  const s = await staged(w, "se12-second", { seller, sender: second });
  const reply = await refused("the 11th first contact on a second identity", () => send(w, seller, s.draft, s.grant), OUTCOME.KC032, s.draft);
  assert.equal(w.subReason(reply), "CAP_REACHED");
  assert.equal(await firstContacts24h(w, seller.userId, T0), 10, "still 10");
});

cell("GAP-SE-14 RACE (stop fact) M16: CMD064 REPLIED on P's sent first message against CMD063 of P's follow-up, held at the prospect subject L3 in both orders: order 1 (REPLIED holds) 409 KC032; order 2 (CMD063 holds) 200 and NOT_SENT(CADENCE_CLOSED) at its claim with zero calls; red with L3 removed from both (a follow-up born after REPLIED)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; f: DraftP; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    w.standAt(T0);
    const s = await staged(w, `m16-${order}`);
    const first = await sentFirst(w, s);
    w.standAt(plusMs(T0, 7 * DAY_MS));
    const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
    const g = await w.grant([f]);
    const R = { name: "CMD064 REPLIED", role: "kauro_app" as const, run: () => w.routes.recordActivity(s.seller, { kind: "REPLIED", intentId: first, inboundRef: `inbound-m16-${order}-${first}` }), at: W.activityInsert };
    const C = cmd063Actor("CMD063 follow-up", s.seller, f, g);
    runs.push({ order, f, r: await raceAtWrite(ctx, "M16", order === 1 ? R : C, order === 1 ? C : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.f.draftId)).length, 0, "order 1: no follow-up born after REPLIED (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.KC032);
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await w.dispatcher().pass();
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(CADENCE_CLOSED)");
  assert.equal(callsOf(w, id), 0);
  assert.equal(await draftState(w, o2.f), "DRAFT", "a reusable refusal returns the follow-up draft to DRAFT");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
  w.standAt(T0);
});

test("GAP-SE-15 DENY (health): one BOUNCED among the person's latest 50 counted intents refuses a new first contact and a follow-up of another prospect (KC034) until the owner's diagnosis; with 3 sends shown as 1/3", async () => {
  w.standAt(T0);
  const seller = await w.seller("se15");
  const sends: Staged[] = [await staged(w, "se15-0", { seller }), await staged(w, "se15-1", { seller }), await staged(w, "se15-2", { seller })];
  const [a, , c] = [await sentFirst(w, sends[0]!), await sentFirst(w, sends[1]!), await sentFirst(w, sends[2]!)];
  assert.ok((await w.routes.recordActivity(seller, { kind: "BOUNCED", intentId: a!, evidenceRef: `dsn-${a}` })).status < 300, "one BOUNCED");
  const m = await w.metrics(w.owner, seller.userId);
  assert.deepEqual([m.pauseNumerator, m.pauseDenominator, m.paused], [1, 3, true], "shown as 1/3, paused");
  const n = await staged(w, "se15-new", { seller });
  await refused("a new first contact of the paused person", () => send(w, seller, n.draft, n.grant), OUTCOME.KC034, n.draft);
  w.standAt(plusMs(T0, 7 * DAY_MS));
  const f = await w.draft(seller, sends[1]!.prospect, seller.sender, { purpose: "FOLLOW_UP" }); // the prospect of the 2nd send, not the bounced one
  const g = await w.grant([f]);
  await refused("a follow-up of another prospect", () => send(w, seller, f, g), OUTCOME.KC034, f);
  assert.ok((await w.routes.diagnose(seller.userId)).status < 300, "the owner's diagnosis");
  intentIdOf(await send(w, seller, f, g));
  assert.equal((await intent(w, c!)).state, "PROVIDER_ACCEPTED", "the third send stays accepted");
  assert.equal((await w.metrics(w.owner, seller.userId)).paused, false, "unpaused after the diagnosis");
  w.standAt(T0);
});

test("GAP-SE-16 EXPIRY (boundaries): at validFrom admitted and 1 us before refused; 1 us before expiresAt admitted and at expiresAt refused", async () => {
  const validFrom = plusUs(plusMs(T0, 3_600_000), 1);
  const expiresAt = plusUs(plusMs(T0, 5 * 3_600_000), 7);
  w.standAt(T0);
  const seller = await w.seller("se16");
  const mk = async (label: string): Promise<Staged> => staged(w, label, { seller, validFrom, expiresAt });
  const [a, b, c, d] = [await mk("se16-a"), await mk("se16-b"), await mk("se16-c"), await mk("se16-d")];
  assert.equal(a.grant.validFrom, validFrom, "a future validFrom is kept (only a past one is clamped)");
  w.standAt(plusUs(validFrom, -1));
  await refused("1 us before validFrom", () => send(w, seller, a.draft, a.grant), OUTCOME.KC030, a.draft);
  w.standAt(validFrom);
  assert.equal((await send(w, seller, b.draft, b.grant)).status, 200, "at validFrom admitted");
  w.standAt(plusUs(expiresAt, -1));
  assert.equal((await send(w, seller, c.draft, c.grant)).status, 200, "1 us before expiresAt admitted");
  w.standAt(expiresAt);
  await refused("at expiresAt", () => send(w, seller, d.draft, d.grant), OUTCOME.KC030, d.draft);
  assert.equal(epochUs(expiresAt) - epochUs(plusUs(expiresAt, -1)), 1);
  w.standAt(T0);
});

test("GAP-SE-17 CAP (24 h edge): a first contact counted at T keeps the 11th refused at T + 24 h - 1 us and admits it at T + 24 h", async () => {
  const T = "2026-10-20T14:00:00.000000Z"; // Tuesday
  w.standAt(T);
  const seller = await w.seller("se17");
  await firstContacts(w, seller, 1, "se17-t");
  const nine = plusMs(T, 3_600_000);
  w.standAt(nine);
  await firstContacts(w, seller, 9, "se17-later");
  const edge = plusMs(T, DAY_MS);
  const s1 = await staged(w, "se17-11a", { seller, expiresAt: plusMs(T, 3 * DAY_MS) });
  const s2 = await staged(w, "se17-11b", { seller, expiresAt: plusMs(T, 3 * DAY_MS) });
  w.standAt(plusUs(edge, -1));
  const r1 = await refused("the 11th at T + 24 h - 1 us", () => send(w, seller, s1.draft, s1.grant), OUTCOME.KC032, s1.draft);
  assert.equal(w.subReason(r1), "CAP_REACHED");
  w.standAt(edge);
  assert.equal((await send(w, seller, s2.draft, s2.grant)).status, 200, "admitted at T + 24 h (the first contact at T left the window)");
  assert.equal(await firstContacts24h(w, seller.userId, edge), 10);
  w.standAt(T0);
});

/** A sent first contact at `first`, and a FOLLOW_UP draft of the same prospect sealed by a grant covering the whole window. */
async function followUpOf(label: string, first: string): Promise<{ s: Staged; f: DraftP; g: GrantP; fresh: () => Promise<{ f: DraftP; g: GrantP }> }> {
  w.standAt(first);
  const s = await staged(w, label, { expiresAt: plusMs(first, 13 * DAY_MS) });
  await sentFirst(w, s);
  const mk = async (): Promise<{ f: DraftP; g: GrantP }> => {
    const f = await w.draft(s.seller, s.prospect, s.seller.sender, { purpose: "FOLLOW_UP" });
    return { f, g: await w.grant([f], { expiresAt: plusMs(first, 14 * DAY_MS) }) };
  };
  const one = await mk();
  return { s, ...one, fresh: mk };
}
async function followUpAt(at: string, x: { s: Staged; f: DraftP; g: GrantP }): Promise<Reply> {
  w.standAt(at);
  return send(w, x.s.seller, x.f, x.g);
}

test("GAP-SE-18 CADENCE (business days): first send 2026-12-24T15:00Z: follow-up refused on 2027-01-03 (10 calendar days, 4 business days) and at 2027-01-04T14:59:59.999999Z, admitted at 2027-01-04T15:00:00Z, admitted 1 us before 2027-01-07T15:00:00Z and refused at it", async () => {
  // drafts and grants are prepared at the first send's instant; each check sends one follow-up draft at the named instant
  const x = await followUpOf("se18", "2026-12-24T15:00:00.000000Z");
  const r1 = await refused("2027-01-03 (4 business days)", () => followUpAt("2027-01-03T15:00:00.000000Z", x), OUTCOME.KC032, x.f);
  w.standAt("2026-12-24T15:00:00.000000Z");
  const y = await x.fresh();
  const r2 = await refused("1 us before the window opens", () => followUpAt("2027-01-04T14:59:59.999999Z", { s: x.s, ...y }), OUTCOME.KC032, y.f);
  assert.equal(w.subReason(r2), "CADENCE_CLOSED");
  assert.equal((await followUpAt("2027-01-04T15:00:00.000000Z", { s: x.s, ...y })).status, 200, "admitted at 2027-01-04T15:00:00Z");
  // the closing edge on a second sequence of the same shape (one follow-up per sequence)
  const z = await followUpOf("se18-close", "2026-12-24T15:00:00.000000Z");
  assert.equal((await followUpAt("2027-01-06T15:00:00.000000Z", z)).status, 200, "inside the window");
  const u = await followUpOf("se18-close-2", "2026-12-24T15:00:00.000000Z");
  assert.equal((await followUpAt("2027-01-07T14:59:59.999999Z", u)).status, 200, "admitted 1 us before 2027-01-07T15:00:00Z");
  const v = await followUpOf("se18-close-3", "2026-12-24T15:00:00.000000Z");
  await refused("at 2027-01-07T15:00:00Z (first + 14 days)", () => followUpAt("2027-01-07T15:00:00.000000Z", v), OUTCOME.KC032, v.f);
  w.standAt(T0);
});

test("GAP-SE-19 CADENCE (90 days): a new sequence refused 1 us before last message + 90 days, admitted at it", async () => {
  const first = "2026-10-15T15:00:00.000000Z"; // Thursday
  w.standAt(first);
  const s = await staged(w, "se19");
  await sentFirst(w, s);
  const at90 = plusMs(first, 90 * DAY_MS); // 2027-01-13T15:00Z, a Wednesday business instant in both zones
  w.standAt(plusMs(at90, -DAY_MS));
  const a = await w.draft(s.seller, s.prospect, s.seller.sender, { label: "se19-a" });
  const b = await w.draft(s.seller, s.prospect, s.seller.sender, { label: "se19-b" });
  const [ga, gb] = [await w.grant([a], { expiresAt: plusMs(at90, DAY_MS) }), await w.grant([b], { expiresAt: plusMs(at90, DAY_MS) })];
  w.standAt(plusUs(at90, -1));
  const r = await refused("1 us before last message + 90 days", () => send(w, s.seller, a, ga), OUTCOME.KC032, a);
  assert.equal(w.subReason(r), "CADENCE_CLOSED");
  w.standAt(at90);
  assert.equal((await send(w, s.seller, b, gb)).status, 200, "a new sequence admitted at last message + 90 days");
  w.standAt(T0);
});

test("GAP-SE-20 DENY (calendar): a Saturday first contact is refused, a Saturday follow-up inside its window too", async () => {
  const saturday = "2026-10-17T15:00:00.000000Z";
  w.standAt("2026-10-16T15:00:00.000000Z");
  const s = await staged(w, "se20-first", { expiresAt: plusMs(saturday, DAY_MS) });
  w.standAt(saturday);
  const r = await refused("a Saturday first contact", () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC032, s.draft);
  assert.equal(w.subReason(r), "OUTSIDE_BUSINESS_DAY");
  // a follow-up whose window [first + 5 business days, first + 14 days) contains a Saturday: first Thu 2026-10-15T15:00Z -> window [Thu 10-22 15:00, Thu 10-29 15:00); Sat 10-24 inside it
  const x = await followUpOf("se20-follow", "2026-10-15T15:00:00.000000Z");
  const rf = await refused("a Saturday follow-up inside its window", () => followUpAt("2026-10-24T15:00:00.000000Z", x), OUTCOME.KC032, x.f);
  assert.equal(w.subReason(rf), "OUTSIDE_BUSINESS_DAY");
  w.standAt(T0);
});

cell("GAP-SE-21 RACE (grant revocation) M7: CMD063 against RevokeOutreachAuthorization of its grant, held at the grant subject L4g in both orders: order 1 (revoke holds) 409 KC030 and no intent; order 2 (CMD063 holds) 200 and the intent NOT_SENT(GRANT_REVOKED) at its claim with zero calls; red with L4g removed from both (an intent born on a revoked grant)", "race", async (ctx) => {
  w.standAt(T0);
  const runs: Array<{ order: Order; s: Staged; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m7-${order}`);
    const C = cmd063Actor("CMD063", s.seller, s.draft, s.grant);
    const R = { name: "RevokeOutreachAuthorization", role: "kauro_app" as const, run: () => w.routes.revokeGrant(s.grant), at: W.grantRevoke };
    runs.push({ order, s, r: await raceAtWrite(ctx, "M7", order === 1 ? R : C, order === 1 ? C : R) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.s.draft.draftId)).length, 0, "order 1: no intent born on the revoked grant (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.KC030);
  const id = intentIdOf(replyOf(o2.r.first, "CMD063"));
  await w.dispatcher().pass();
  assert.equal(stateOf(await intent(w, id)), "NOT_SENT(GRANT_REVOKED)");
  assert.equal(callsOf(w, id), 0);
  assert.equal(await draftState(w, o2.s.draft), "DRAFT");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

cell("GAP-SE-22 RACE (policy) M11: CMD063 against WithdrawOutreachChannelPolicy of the US first-contact policy, held at the policy subject L6p in both orders: order 1 (withdraw holds) 409 OUTREACH_JURISDICTION_UNREVIEWED and no intent; order 2 (CMD063 holds) 200 and NOT_SENT(POLICY_WITHDRAWN) at its claim with zero calls; red with L6p removed from both (a row born after the withdrawal committed)", "race", async (ctx) => {
  // the policy row is shared by every US first contact: each order withdraws it and the owner reinstates it (policy v+1 IN_FORCE) before the next
  w.standAt(T0);
  const runs: Array<{ order: Order; s: Staged; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staged(w, `m11-${order}`);
    const C = cmd063Actor("CMD063", s.seller, s.draft, s.grant);
    const P = { name: "WithdrawOutreachChannelPolicy", role: "kauro_app" as const, run: () => w.routes.withdrawPolicy("US", "INDIVIDUAL_PROSPECT_CONTACT"), at: W.policyWithdraw };
    const r = await raceAtWrite(ctx, "M11", order === 1 ? P : C, order === 1 ? C : P);
    runs.push({ order, s, r });
    if (order === 2) {
      const id = intentIdOf(replyOf(r.first, "CMD063"));
      await w.dispatcher().pass();
      assert.equal(stateOf(await intent(w, id)), "NOT_SENT(POLICY_WITHDRAWN)", "order 2: refused at its claim");
      assert.equal(callsOf(w, id), 0);
    }
    await w.routes.reinstatePolicy("US", "INDIVIDUAL_PROSPECT_CONTACT"); // the US first-contact policy back IN_FORCE for the next order
  }
  const [o1] = runs as [(typeof runs)[0]];
  assert.equal((await intentsOfDraft(w, o1.s.draft.draftId)).length, 0, "order 1: no row born after the withdrawal (forbidden effect)");
  assert.equal(out(replyOf(o1.r.second, "CMD063")), OUTCOME.JURISDICTION);
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true]);
});

test("GAP-SE-23 DENY (calendar union): first contacts at 2027-01-11T15:00Z (Colombian holiday only) and 2027-01-18T15:00Z (US holiday only) and 2027-06-18T15:00Z (US observed Juneteenth) are 409 KC032 OUTSIDE_BUSINESS_DAY; 2027-01-12T15:00Z admitted", async () => {
  for (const at of ["2027-01-11T15:00:00.000000Z", "2027-01-18T15:00:00.000000Z", "2027-06-18T15:00:00.000000Z"]) {
    w.standAt(plusMs(at, -DAY_MS * 3));
    const s = await staged(w, `se23-${at.slice(0, 10)}`, { expiresAt: plusMs(at, DAY_MS) });
    w.standAt(at);
    const r = await refused(`first contact at ${at}`, () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC032, s.draft);
    assert.equal(w.subReason(r), "OUTSIDE_BUSINESS_DAY", at);
  }
  w.standAt("2027-01-12T10:00:00.000000Z");
  const ok = await staged(w, "se23-ok");
  w.standAt("2027-01-12T15:00:00.000000Z");
  assert.equal((await send(w, ok.seller, ok.draft, ok.grant)).status, 200, "2027-01-12T15:00Z admitted");
  w.standAt(T0);
});

test("GAP-SE-24 CADENCE (calendar union): first 2027-01-13T15:00Z: follow-up refused at 2027-01-20T15:00Z (MLK not a business day) and admitted at 2027-01-21T15:00Z; first 2027-01-06T15:00Z: refused at 2027-01-13T15:00Z (2027-01-11 not a business day), admitted at 2027-01-14T15:00Z", async () => {
  const a = await followUpOf("se24-a", "2027-01-13T15:00:00.000000Z");
  await refused("2027-01-20T15:00Z (MLK)", () => followUpAt("2027-01-20T15:00:00.000000Z", a), OUTCOME.KC032, a.f);
  assert.equal((await followUpAt("2027-01-21T15:00:00.000000Z", a)).status, 200, "admitted at 2027-01-21T15:00Z");
  const b = await followUpOf("se24-b", "2027-01-06T15:00:00.000000Z");
  await refused("2027-01-13T15:00Z (2027-01-11 Colombian holiday)", () => followUpAt("2027-01-13T15:00:00.000000Z", b), OUTCOME.KC032, b.f);
  assert.equal((await followUpAt("2027-01-14T15:00:00.000000Z", b)).status, 200, "admitted at 2027-01-14T15:00Z");
  w.standAt(T0);
});

test("GAP-SE-25 DENY (two zones): 2027-07-10T04:30:00Z (Friday 23:30 Bogota, Saturday 00:30 New York) and 2027-07-19T04:30:00Z (Monday 00:30 New York, Sunday 23:30 Bogota) are refused; 2027-07-13T16:00:00Z admitted (2027-07-12 is a Colombian holiday)", async () => {
  for (const at of ["2027-07-10T04:30:00.000000Z", "2027-07-19T04:30:00.000000Z"]) {
    w.standAt(plusMs(at, -DAY_MS * 2));
    const s = await staged(w, `se25-${at.slice(0, 10)}`, { expiresAt: plusMs(at, DAY_MS) });
    w.standAt(at);
    const r = await refused(`first contact at ${at}`, () => send(w, s.seller, s.draft, s.grant), OUTCOME.KC032, s.draft);
    assert.equal(w.subReason(r), "OUTSIDE_BUSINESS_DAY", at);
  }
  w.standAt("2027-07-13T12:00:00.000000Z");
  const ok = await staged(w, "se25-ok");
  w.standAt("2027-07-13T16:00:00.000000Z");
  assert.equal((await send(w, ok.seller, ok.draft, ok.grant)).status, 200, "2027-07-13T16:00Z admitted");
  w.standAt(T0);
});

// referenced so an unused import never hides a dropped assertion
void warningsOf;
