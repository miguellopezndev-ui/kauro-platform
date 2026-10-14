// CMD061 PrepareOutreachDraft — POST /api/v1/ops/outreach/drafts — ASSIGNED_SELLER_OR_OWNER (package B12, lane L-DRAFT; plan
// docs/design/B12-outreach-plan.md rev 4 §1 CMD061-OK/DENY/RACE, R2-068, CMD061 matrix row GAP-DR-1..6, §M M11, M13, M24, M39).
// One COMMIT: draft (DRAFT v1, content hash = recipient/sender/purpose/body binding) + its cited resources (the content binding) + journal.
// Trace (§L): L1 seller S (or owner) -> L2 -> L3 S -> L5 S -> L6 S -> L6p S -> L7 S -> L8 S (contact + organization key) -> effect_now ->
// judge -> INSERT. No intent, outbox record, activity or provider call is ever born by it (A1). Written FIRST (lane L-DRAFT TD): every title
// fails until the lane builds prepare-draft.ts and its world; every race cell fails under its §M control (KAURO_B12_CONTROL=<id>) at its
// forbidden-effect assertion (a draft born after the conflicting writer committed).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { connectionPid, type FaultContext } from "@kauro/persistence/testing";
import { outreachBindingHash } from "@kauro/domain";
import {
  activitiesOfProspect, answerOf, asDraft, capabilityState, cell, CONTENT_REFUSED, contentIdOf, contentRowsByBody, draftAnswerOf, draftBodyOf, draftResources, draftRow,
  draftsOfProspect, draftWorld, eventsOfProspect, failing, familyRows, holdSubject, intentsOfDraft, journalStates, keyOf, ORDERS, OUTCOME, policyStates, prepareDraft,
  publish, putContent, raceAtWrite, ROUTES, safeContent, sellerState, senderState, settledValue, statusCode, suppressedKeys, T0, tokenOf, W, type DraftBody, type DraftWorld, type GrantP, type Order,
  type ProspectP, type RaceResult, type ResourceP, type SellerP, type Settled,
} from "./b12-draft-support.js";
import type { UnitLog } from "./fault-support.js";
import type { Reply } from "./support.js";

let w: DraftWorld;
before(async () => {
  w = await draftWorld("cmd061");
  w.standAt(T0);
});
after(async () => {
  await w.stop();
});

const out = (r: Reply): string => w.outcome(r);
const replyOf = (s: Settled<unknown>, what: string): Reply => answerOf(s, what) as Reply;
const isGrant = (g: GrantP | Reply): g is GrantP => "authorizationId" in g;
async function granted(d: ReturnType<typeof asDraft>): Promise<GrantP> {
  const g = await w.grant([d]);
  assert.ok(isGrant(g), `the owner grants the draft: ${isGrant(g) ? "" : g.text}`);
  return g;
}
/** A fresh seller with a fresh US prospect, a fresh CURRENT resource and a valid draft body. */
async function staging(label: string, options: { readonly contact?: string; readonly jurisdiction?: string; readonly purpose?: DraftBody["purpose"] } = {}): Promise<{ seller: SellerP; p: ProspectP; r: ResourceP; body: DraftBody }> {
  const seller = await w.seller(label);
  const p = await w.prospect(seller, { ...(options.contact === undefined ? {} : { contact: options.contact }), ...(options.jurisdiction === undefined ? {} : { jurisdiction: options.jurisdiction }) });
  const r = await w.freshResource(label);
  return { seller, p, r, body: await draftBodyOf(w, seller, p, r, label, options.purpose === undefined ? {} : { purpose: options.purpose }) };
}
/** CMD061 refused: the expected outcome, and no draft, event or outbox record of the prospect. */
async function refused(what: string, act: () => Promise<Reply>, expected: string, p: ProspectP): Promise<Reply> {
  const reply = await act();
  assert.equal(expected.split(" ").length === 2 ? statusCode(w, reply) : out(reply), expected, `${what}: ${reply.text}`);
  assert.deepEqual(await draftsOfProspect(w, p.prospectId), [], `${what}: no draft`);
  assert.equal(await eventsOfProspect(w, p.prospectId), 0, `${what}: no event or outbox record`);
  return reply;
}

// --- CMD061-OK --------------------------------------------------------------------------------------------------------------------------
test("CMD061-OK: an assigned ACTIVE seller prepares a DRAFT for its US prospect from stored content and a CURRENT resource, sender its own verified GMAIL_API identity, provenance its prospect's source evidence: 201 version 1, content hash bound to recipient/sender/purpose/body, no intent, outbox record, activity or provider call", async () => {
  const { seller, p, r, body } = await staging("ok");
  assert.equal(seller.sender.route, "GMAIL_API");
  const calls = w.callsTotal();
  const reply = await prepareDraft(w, seller, body);
  const a = draftAnswerOf(reply);
  assert.deepEqual([a.version, a.state], [1, "DRAFT"], "201 version 1 DRAFT");
  const binding = outreachBindingHash({ prospectId: p.prospectId, contactKey: p.contactKey, senderId: seller.sender.senderId, purpose: "INDIVIDUAL_PROSPECT_CONTACT", contentRef: body.contentRef });
  assert.equal(a.contentHash, binding, "the content hash binds recipient, sender, purpose and body");
  const row = await draftRow(w, a.draftId);
  assert.deepEqual(
    [row.state, row.version, row.contentHash, row.contentRef, row.contactKey, row.senderId, row.purpose, row.provenance],
    ["DRAFT", 1, binding, body.contentRef, p.contactKey, seller.sender.senderId, "INDIVIDUAL_PROSPECT_CONTACT", p.provenanceEvidenceHash],
    "the stored draft is the bound DRAFT v1 with the prospect's provenance",
  );
  assert.deepEqual(await draftResources(w, a.draftId), [r.resourceId], "the content binding cites the CURRENT resource");
  assert.deepEqual(await intentsOfDraft(w, a.draftId), [], "no intent");
  assert.deepEqual(await activitiesOfProspect(w, p.prospectId), [], "no activity");
  assert.equal(await eventsOfProspect(w, p.prospectId), 0, "no event, no outbox record");
  await w.dispatcher().pass();
  assert.equal(w.callsTotal(), calls, "zero provider calls, even after a dispatcher pass");
  assert.deepEqual(await intentsOfDraft(w, a.draftId), [], "still no intent after the pass");
  const read = await w.call({ method: "GET", url: ROUTES.getDraft(a.draftId), token: seller.token, key: null });
  assert.equal(read.status, 200, read.text);
  const view = read.json<{ data?: { state?: string; version?: number; contentHash?: string }; state?: string; version?: number; contentHash?: string }>();
  const v = view.data ?? view;
  assert.deepEqual([v.state, v.version, v.contentHash], ["DRAFT", 1, binding], "GetOutreachDraft shows DRAFT v1 with its hash");
});

test("CMD061-OK (route): a RESEND_TRANSACTIONAL sender is admitted at draft time and refused only at send (R2-131)", async () => {
  const { seller, p, body } = await staging("route");
  const resend = await w.sender(seller, { route: "RESEND_TRANSACTIONAL" });
  const reply = await prepareDraft(w, seller, { ...body, senderIdentityRef: resend.senderId });
  const a = draftAnswerOf(reply, "CMD061 on a RESEND sender");
  assert.deepEqual([a.state, a.version, (await draftRow(w, a.draftId)).senderId], ["DRAFT", 1, resend.senderId], "the draft on the RESEND identity is DRAFT v1");
  const d = asDraft(a, body, p, resend);
  const g = await granted(d);
  const calls = w.callsTotal();
  const sent = await w.send(seller, d, g);
  assert.equal(out(sent), "409 PRECONDITION_FAILED OUTREACH_ROUTE_FORBIDDEN", `refused at send (KC028): ${sent.text}`);
  assert.deepEqual(await intentsOfDraft(w, a.draftId), [], "no intent on the RESEND route");
  assert.equal((await draftRow(w, a.draftId)).state, "DRAFT", "the draft stays DRAFT");
  await w.dispatcher().pass();
  assert.equal(w.callsTotal(), calls, "zero provider calls");
});

// --- CMD061-DENY ------------------------------------------------------------------------------------------------------------------------
test("CMD061-DENY: an agency tenant session and a TERMINATED seller are 403, another seller's prospect is 404 like an unknown id; then one missing prerequisite at a time: other person's sender, REVOKED sender, not-yet-verified sender (KC031), provenance not the prospect's, contentRef naming a tenant upload or staged record (404 like unknown), unreviewed jurisdiction, suppressed contact, superseded resource, savings amount, AI in subject, CR/LF in subject; no row, no event", async () => {
  const { seller, p, r, body } = await staging("deny");
  const unknownId = "01900000-0000-7000-8000-000000000000";
  const unknownHash = "0".repeat(64);
  // callers
  const member = await w.agencyMember("deny-member");
  assert.equal((await refused("an agency tenant session", () => prepareDraft(w, member, body), "403 NOT_AUTHORIZED", p)).status, 403);
  const t = await staging("deny-terminated");
  assert.ok((await w.routes.terminate(t.seller)).status < 300, "CMD050 terminates the seller");
  assert.equal(await sellerState(w, t.seller.sellerId), "TERMINATED");
  await refused("a TERMINATED seller", () => prepareDraft(w, t.seller, t.body), "403 NOT_AUTHORIZED", t.p);
  // another seller's prospect answers exactly like an unknown prospect id
  const other = await staging("deny-other");
  const unknown = await prepareDraft(w, seller, { ...body, prospectId: unknownId });
  const foreign = await refused("another seller's prospect", () => prepareDraft(w, seller, { ...body, prospectId: other.p.prospectId }), "404 NOT_FOUND", other.p);
  assert.deepEqual([foreign.status, out(foreign)], [unknown.status, out(unknown)], "a foreign prospect is indistinguishable from an unknown id");
  // one missing prerequisite at a time (every other field valid)
  const unknownSender = await prepareDraft(w, seller, { ...body, senderIdentityRef: unknownId });
  const otherSender = await refused("other person's sender", () => prepareDraft(w, seller, { ...body, senderIdentityRef: other.seller.sender.senderId }), "404 NOT_FOUND", p);
  assert.equal(out(otherSender), out(unknownSender), "another person's sender answers like an unknown sender");
  const revoked = await w.sender(seller);
  assert.ok((await w.routes.revokeSender(revoked.senderId)).status < 300, "the owner revokes the identity");
  assert.equal(await senderState(w, revoked.senderId), "REVOKED");
  await refused("REVOKED sender", () => prepareDraft(w, seller, { ...body, senderIdentityRef: revoked.senderId }), OUTCOME.SENDER_REVOKED, p);
  const pending = await w.sender(seller, { pending: true });
  assert.equal(await senderState(w, pending.senderId), "PENDING_VERIFICATION");
  await refused("not-yet-verified sender", () => prepareDraft(w, seller, { ...body, senderIdentityRef: pending.senderId }), OUTCOME.KC031, p);
  const unknownProvenance = await prepareDraft(w, seller, { ...body, provenanceEvidenceHash: unknownHash });
  const otherProvenance = await refused("provenance not the prospect's", () => prepareDraft(w, seller, { ...body, provenanceEvidenceHash: other.p.provenanceEvidenceHash }), "404 NOT_FOUND", p);
  assert.equal(out(otherProvenance), out(unknownProvenance), "another prospect's provenance answers like an unknown one");
  const unknownContent = await prepareDraft(w, seller, { ...body, contentRef: "f".repeat(64) });
  const tenant = await w.tenantRecordIds();
  for (const [what, ref] of [["a tenant upload", tenant.uploadId], ["a staged record", tenant.stagedRecordId]] as const) {
    const reply = await refused(`contentRef naming ${what}`, () => prepareDraft(w, seller, { ...body, contentRef: ref }), "404 NOT_FOUND", p);
    assert.equal(out(reply), out(unknownContent), `${what} answers like an unknown contentRef`);
  }
  const abroad = await staging("deny-abroad", { jurisdiction: "Brazil" });
  await refused("unreviewed jurisdiction", () => prepareDraft(w, abroad.seller, abroad.body), OUTCOME.JURISDICTION, abroad.p);
  const supp = await staging("deny-suppressed");
  await w.routes.suppress({ contactKey: supp.p.contactKey });
  await refused("suppressed contact", () => prepareDraft(w, supp.seller, supp.body), OUTCOME.KC016, supp.p);
  const ownerContent = await contentIdOf(w, w.owner, safeContent("deny-v2"));
  assert.equal((await publish(w, w.owner, { familyId: r.familyId, expectedVersion: 1, contentRef: ownerContent, capabilityIds: [r.capabilityId] })).status, 201, "the owner publishes version 2");
  assert.deepEqual((await familyRows(w, r.familyId)).map((x) => [x.version, x.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
  await refused("superseded resource", () => prepareDraft(w, seller, body), OUTCOME.KC033, p);
  // content checks: the body is refused before any row exists (no content row, so no draft can cite it)
  const bad: ReadonlyArray<readonly [string, { subject: string; body: string }]> = [
    ["savings amount", { subject: "A short question about your migration", body: "Hello,\n\nWe can save you $40,000 on your next migration.\n" }],
    ["AI in subject", { subject: "AI-written migration plan for you", body: "Hello,\n\nWould a short call next week be useful?\n" }],
    ["CR/LF in subject", { subject: "Migration review\r\nBcc: someone@example.com", body: "Hello,\n\nWould a short call next week be useful?\n" }],
  ];
  for (const [what, content] of bad) {
    const reply = await putContent(w, seller, content);
    assert.equal(statusCode(w, reply), CONTENT_REFUSED, `${what}: ${reply.text}`);
    assert.equal(await contentRowsByBody(w, content.body), 0, `${what}: no content row of the refused body`);
  }
  assert.deepEqual(await draftsOfProspect(w, p.prospectId), [], "no draft of the prospect after every refusal");
  assert.equal(await eventsOfProspect(w, p.prospectId), 0, "no event");
});

// --- CMD061-RACE ------------------------------------------------------------------------------------------------------------------------
const cmd061Actor = (name: string, seller: SellerP, body: DraftBody, key?: string) => ({ name, role: "kauro_app" as const, run: () => prepareDraft(w, seller, body, key), at: W.draftInsert });

cell("CMD061-RACE: identical retry replays the 201, same key other content is 409, CMD050 held at the seller lock L1 in both orders (draft then TERMINATED, or 403), PublishSalesResource held at the resource subject L6 in both orders, crash before COMMIT leaves nothing and crash after COMMIT replays one draft", "race", async (ctx: FaultContext) => {
  // retry (L2 journal identity)
  {
    const { seller, p, body } = await staging("race-retry");
    const key = keyOf("retry");
    const first = await ctx.attempt(() => prepareDraft(w, seller, body, key));
    const again = await ctx.attempt(() => prepareDraft(w, seller, body, key));
    const a = draftAnswerOf(first);
    assert.equal(draftAnswerOf(again, "identical retry").draftId, a.draftId, "identical retry replays the 201 (same draft)");
    assert.equal(again.json<{ replayed: boolean }>().replayed, true, "the replay is marked replayed");
    assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1, "identical retry: one draft");
    const otherContent = await contentIdOf(w, seller, safeContent("race-retry-other"));
    const other = await ctx.attempt(() => prepareDraft(w, seller, { ...body, contentRef: otherContent }, key));
    assert.equal(out(other), OUTCOME.KEY_REUSED, `same key other content is 409: ${other.text}`);
    assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1, "still one draft");
    assert.deepEqual(await journalStates(w, "CMD061", key), ["COMMITTED"]);
  }
  // CMD050 x CMD061 at L1 (seller S/X), both orders (M39-L1)
  {
    const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; r: RaceResult<unknown, unknown> }> = [];
    for (const order of ORDERS) {
      const s = await staging(`race-l1-${order}`);
      const terminate = { name: "CMD050", role: "kauro_app" as const, run: () => w.routes.terminate(s.seller), at: W.sellerUpdate };
      const draft = cmd061Actor("CMD061", s.seller, s.body);
      runs.push({ order, s, r: await raceAtWrite(ctx, "M39-L1", order === 1 ? terminate : draft, order === 1 ? draft : terminate) });
    }
    const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
    // forbidden effect first: a draft of a seller whose termination committed before the draft's judgment
    assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (CMD050 holds L1 X): no draft is born for the TERMINATED seller");
    assert.equal(replyOf(o1.r.second, "CMD061").status, 403, "order 1: CMD061 is 403");
    assert.equal(await sellerState(w, o1.s.seller.sellerId), "TERMINATED");
    const d2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
    assert.deepEqual([(await draftRow(w, d2.draftId)).state, await sellerState(w, o2.s.seller.sellerId)], ["DRAFT", "TERMINATED"], "order 2: the draft, then TERMINATED");
    assert.ok(replyOf(o2.r.second, "CMD050").status < 300, "order 2: CMD050 commits after the draft");
    assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L1 in both orders");
  }
  // PublishSalesResource x CMD061 at L6 (family X/S), both orders (M39-L6)
  {
    const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; r: RaceResult<unknown, unknown> }> = [];
    for (const order of ORDERS) {
      const s = await staging(`race-l6-${order}`);
      const v2 = await contentIdOf(w, w.owner, safeContent(`race-l6-v2-${order}`));
      const pub = { name: "PublishSalesResource", role: "kauro_app" as const, run: () => publish(w, w.owner, { familyId: s.r.familyId, expectedVersion: 1, contentRef: v2, capabilityIds: [s.r.capabilityId] }), at: W.resourceSupersede };
      const draft = cmd061Actor("CMD061", s.seller, s.body);
      runs.push({ order, s, r: await raceAtWrite(ctx, "M39-L6", order === 1 ? pub : draft, order === 1 ? draft : pub) });
    }
    const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
    assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (publish holds L6 X): no draft cites the resource superseded before it");
    assert.equal(out(replyOf(o1.r.second, "CMD061")), OUTCOME.KC033, "order 1: 409 RESOURCE_NOT_CURRENT");
    assert.deepEqual((await familyRows(w, o1.s.r.familyId)).map((x) => [x.version, x.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
    const d2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
    assert.deepEqual(await draftResources(w, d2.draftId), [o2.s.r.resourceId], "order 2: the draft cites version 1 while it was CURRENT");
    assert.equal(replyOf(o2.r.second, "publish").status, 201, "order 2: the publish commits after the draft");
    assert.deepEqual((await familyRows(w, o2.s.r.familyId)).map((x) => [x.version, x.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
    assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L6 in both orders");
  }
  // crash before COMMIT (after the content-binding INSERT): nothing; the same key then commits one draft
  {
    const { seller, p, body } = await staging("race-crash-before");
    const key = keyOf("crash-before");
    ctx.points.crash("target.before-commit");
    const conn = await w.open("kauro_app_test");
    const crashed = await ctx.operation("CMD061 crashed before COMMIT", () => w.on(conn, "kauro_app", ctx, [W.draftResourceInsert], () => prepareDraft(w, seller, body, key), { target: 1 }));
    await conn.end().catch(() => undefined);
    assert.equal(crashed.status, 500, `the unit crashed before its COMMIT (no answer): ${crashed.text}`);
    assert.ok(ctx.points.crashes.includes("target.before-commit"), "the crash fired at the target unit's before-commit boundary");
    assert.ok(ctx.points.passed.includes("db.draft_resource_insert.after"), "the crash came after the content-binding INSERT");
    assert.deepEqual(await draftsOfProspect(w, p.prospectId), [], "crash before COMMIT: no draft");
    assert.deepEqual(await journalStates(w, "CMD061", key), [], "crash before COMMIT: no journal row");
    draftAnswerOf(await prepareDraft(w, seller, body, key), "the same key after the crash");
    assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1, "the same key then commits one draft");
  }
  // crash after COMMIT: the answer is lost, the draft is committed, the same key replays it
  {
    const { seller, p, body } = await staging("race-crash-after");
    const key = keyOf("crash-after");
    ctx.points.crash("target.after-commit");
    const conn = await w.open("kauro_app_test");
    const lost = await ctx.operation("CMD061 crashed after COMMIT", () => w.on(conn, "kauro_app", ctx, [], () => prepareDraft(w, seller, body, key), { target: 1 }));
    await conn.end().catch(() => undefined);
    assert.equal(lost.status, 500, `the answer was lost after COMMIT: ${lost.text}`);
    assert.ok(ctx.points.crashes.includes("target.after-commit"), "the crash fired at the target unit's after-commit boundary");
    const rows = await draftsOfProspect(w, p.prospectId);
    assert.deepEqual(rows.map((x) => [x.state, x.version]), [["DRAFT", 1]], "crash after COMMIT: one committed DRAFT v1");
    const replay = await prepareDraft(w, seller, body, key);
    assert.equal(draftAnswerOf(replay, "replay").draftId, rows[0]!.draftId, "the same key replays the committed draft");
    assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1, "one draft after the replay");
    assert.deepEqual(await journalStates(w, "CMD061", key), ["COMMITTED"]);
  }
});

// --- R2-068 -----------------------------------------------------------------------------------------------------------------------------
test("R2-068: a draft prepared without a grant stays DRAFT through reads, a dispatcher pass and a forged activity: no intent, no activity, metrics zero, no delivered member — while the same pass submits a granted sibling draft exactly once", async () => {
  const a = await staging("r2068-alone");
  const lone = draftAnswerOf(await prepareDraft(w, a.seller, a.body));
  for (let k = 0; k < 2; k++) {
    const read = await w.call({ method: "GET", url: ROUTES.getDraft(lone.draftId), token: a.seller.token, key: null });
    assert.equal(read.status, 200, read.text);
  }
  // the granted sibling (another seller, so the lone seller's metrics stay its own)
  const b = await staging("r2068-sibling");
  const sa = draftAnswerOf(await prepareDraft(w, b.seller, b.body));
  const sibling = asDraft(sa, b.body, b.p, b.seller.sender);
  const g = await granted(sibling);
  const queued = await w.send(b.seller, sibling, g);
  assert.equal(queued.status, 200, `the sibling is queued: ${queued.text}`);
  const before = w.callsTotal();
  await w.dispatcher().pass();
  const [si] = await intentsOfDraft(w, sa.draftId);
  assert.ok(si !== undefined, "the sibling has its intent");
  assert.deepEqual([w.callsOf(si.intentId), si.state], [1, "PROVIDER_ACCEPTED"], "the pass submits the granted sibling exactly once");
  assert.equal(w.callsTotal(), before + 1, "exactly one provider call in the pass (none for the ungranted draft)");
  // a forged activity on the ungranted draft is refused and writes nothing
  const forged = await w.routes.recordActivity(a.seller, { kind: "PROVIDER_ACCEPTED", prospectId: a.p.prospectId, draftId: lone.draftId, providerMessageRef: "gmail-forged-r2068", occurredAt: T0 });
  assert.ok(forged.status >= 400 && forged.status < 500, `the forged PROVIDER_ACCEPTED is refused: ${forged.status} ${forged.text}`);
  await w.dispatcher().pass();
  assert.deepEqual([(await draftRow(w, lone.draftId)).state, (await draftRow(w, lone.draftId)).version], ["DRAFT", 1], "the ungranted draft stays DRAFT v1");
  assert.deepEqual(await intentsOfDraft(w, lone.draftId), [], "no intent");
  assert.deepEqual(await activitiesOfProspect(w, a.p.prospectId), [], "no activity");
  assert.equal(w.callsOf(si.intentId), 1, "the second pass submits nothing more");
  const m = await w.metrics(a.seller, a.seller.userId);
  assert.deepEqual(Object.keys(m).filter((k) => /deliver/i.test(k)), [], "no delivered member");
  for (const [k, v] of Object.entries(m)) if (typeof v === "number") assert.equal(v, 0, `metric ${k} of the ungranted seller is 0`);
});

// --- GAP-DR-1..6 ------------------------------------------------------------------------------------------------------------------------
cell("GAP-DR-1 RACE (capability): CMD059 held at the capability subject L5 in both orders: draft then SUSPENDED, or 409 RESOURCE_NOT_CURRENT", "race", async (ctx) => {
  // CMD061 L5 S (capability of each cited resource) vs CMD059 UPDATE capabilities whose trigger takes L5 X (0003:50-56): CMD059 paused `.after` it
  const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staging(`dr1-${order}`);
    const suspend = { name: "CMD059", role: "kauro_app" as const, run: () => w.routes.suspendCapability(s.r.capabilityId), at: W.capabilityUpdate, after: true as const };
    const draft = cmd061Actor("CMD061", s.seller, s.body);
    runs.push({ order, s, r: await raceAtWrite(ctx, "M39-L5", order === 1 ? suspend : draft, order === 1 ? draft : suspend) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (CMD059 holds L5 X): no draft claims the capability SUSPENDED before it");
  assert.equal(out(replyOf(o1.r.second, "CMD061")), OUTCOME.KC033, "order 1: 409 RESOURCE_NOT_CURRENT");
  assert.equal(await capabilityState(w, o1.s.r.capabilityId), "SUSPENDED");
  const d2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
  assert.deepEqual([(await draftRow(w, d2.draftId)).state, await capabilityState(w, o2.s.r.capabilityId)], ["DRAFT", "SUSPENDED"], "order 2: the draft, then SUSPENDED");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L5 in both orders");
});

cell("GAP-DR-2 RACE (suppression): the public opt-out of the contact through another prospect held at L8 in both orders: 409 PROSPECT_SUPPRESSED, or the draft born before it and refused at send; red with L8 removed", "race", async (ctx) => {
  // M24: the opt-out holds L8 X of the contact key (paused at its suppression INSERT); CMD061 takes L8 S of the contact and organization keys
  const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const contact = `dr2-${order}-${keyOf("c").slice(-8)}@contact.example`;
    const sentIntent = await w.sentFirstContactTo(contact, `dr2-p1-${order}`);
    const token = tokenOf(w, sentIntent);
    const s = await staging(`dr2-${order}`, { contact });
    const optOut = { name: "opt-out", role: "kauro_outreach" as const, run: () => w.routes.optOut(token), at: W.suppressionInsert };
    const draft = cmd061Actor("CMD061", s.seller, s.body);
    runs.push({ order, s, r: await raceAtWrite(ctx, "M24", order === 1 ? optOut : draft, order === 1 ? draft : optOut) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (opt-out holds L8 X): no draft is born after the suppression");
  assert.equal(out(replyOf(o1.r.second, "CMD061")), OUTCOME.KC016, "order 1: 409 PROSPECT_SUPPRESSED");
  assert.equal(replyOf(o1.r.first, "opt-out").status, 200);
  const a2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
  assert.equal(replyOf(o2.r.second, "opt-out").status, 200, "order 2: the opt-out commits after the draft");
  assert.equal(await suppressedKeys(w, o2.s.p.contactKey), 1, "order 2: the contact is suppressed once");
  const d2 = asDraft(a2, o2.s.body, o2.s.p, o2.s.seller.sender);
  const g = await granted(d2);
  const calls = w.callsTotal();
  const sent = await w.send(o2.s.seller, d2, g);
  assert.equal(out(sent), OUTCOME.KC016, "order 2: the draft born before the opt-out is refused at send");
  assert.deepEqual(await intentsOfDraft(w, a2.draftId), [], "no intent");
  await w.dispatcher().pass();
  assert.equal(w.callsTotal(), calls, "zero provider calls");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L8 in both orders");
});

cell("GAP-DR-3 TIMEOUT: CMD061 waiting at L6 past statement_timeout answers 503 retryable, writes nothing", "race", async (ctx) => {
  const { seller, p, r, body } = await staging("dr3");
  const key = keyOf("timeout");
  const hold = await holdSubject(w, "kauro.sales_resources", r.familyId, "X");
  const log: UnitLog[] = [];
  const conn = await w.open("kauro_app_test");
  w.setStatementTimeout(1_500);
  let reply: Reply;
  try {
    // the bound fires inside the operation: CMD061 is observed blocked by the holder's pid, then its own statement_timeout ends the wait
    const waiting = await ctx.mustWait(w.oracle, { waiter: conn, holder: connectionPid(hold.conn) }, (client) => w.on(client, "kauro_app", ctx, [W.resourceLock], () => prepareDraft(w, seller, body, key), { log }), "CMD061 waits at the resource family subject L6");
    reply = settledValue(await waiting.pending);
  } finally {
    w.setStatementTimeout(null);
    await hold.release();
    await conn.end().catch(() => undefined);
  }
  assert.equal(out(reply), OUTCOME.TIMEOUT, `503 retryable: ${reply.text}`);
  assert.ok(log.some((u) => u.statements.some((s) => s.code === "57014")), "the statement_timeout bound fired (57014 on the L6 wait)");
  assert.deepEqual(await draftsOfProspect(w, p.prospectId), [], "no draft");
  assert.deepEqual(await journalStates(w, "CMD061", key), [], "no journal reservation survives");
  draftAnswerOf(await prepareDraft(w, seller, body, key), "the same key after the timeout");
  assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1, "the same key then commits once");
});

cell("GAP-DR-4 RACE (revocation): RecordSenderRevocation held at the sender subject L7 in both orders", "race", async (ctx) => {
  // M13 (CMD061 side): RecordSenderRevocation L7 X (paused at its sender UPDATE) vs CMD061 L7 S of the sender
  const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; senderId: string; r: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const s = await staging(`dr4-${order}`);
    const snd = await w.sender(s.seller);
    const body = { ...s.body, senderIdentityRef: snd.senderId };
    const revoke = { name: "RecordSenderRevocation", role: "kauro_app" as const, run: () => w.routes.revokeSender(snd.senderId), at: W.senderUpdate };
    const draft = cmd061Actor("CMD061", s.seller, body);
    runs.push({ order, s: { ...s, body }, senderId: snd.senderId, r: await raceAtWrite(ctx, "M13", order === 1 ? revoke : draft, order === 1 ? draft : revoke) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (revocation holds L7 X): no draft on the sender REVOKED before it");
  assert.equal(out(replyOf(o1.r.second, "CMD061")), OUTCOME.SENDER_REVOKED, "order 1: 409 SENDER_REVOKED");
  assert.equal(await senderState(w, o1.senderId), "REVOKED");
  const d2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
  assert.deepEqual([(await draftRow(w, d2.draftId)).state, await senderState(w, o2.senderId)], ["DRAFT", "REVOKED"], "order 2: the draft, then REVOKED");
  const again = await prepareDraft(w, o2.s.seller, o2.s.body, keyOf("dr4-after"));
  assert.equal(out(again), OUTCOME.SENDER_REVOKED, "order 2: a new draft on the REVOKED sender is 409 SENDER_REVOKED");
  assert.equal((await draftsOfProspect(w, o2.s.p.prospectId)).length, 1, "order 2: still the one draft born before the revocation");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L7 in both orders");
});

cell("GAP-DR-5 PARTIAL: failure at the content-binding INSERT rolls back the draft and the journal reservation", "partial", async (ctx) => {
  const { seller, p, r, body } = await staging("dr5");
  const key = keyOf("partial");
  const conn = await w.open("kauro_app_test");
  try {
    await ctx.partial("CMD061 failing at its content-binding INSERT after the draft INSERT", "db.draft_resource_insert.before", () =>
      w.on(conn, "kauro_app", ctx, [W.draftInsert, W.draftResourceInsert], () => failing(w, () => prepareDraft(w, seller, body, key))),
    );
  } finally {
    await conn.end().catch(() => undefined);
  }
  assert.ok(ctx.points.passed.includes("db.draft_insert.after"), "the draft INSERT had completed");
  assert.deepEqual(await draftsOfProspect(w, p.prospectId), [], "no draft");
  assert.equal((await w.oracle.query<{ n: number }>("SELECT count(*)::int AS n FROM kauro.outreach_draft_resources dr JOIN kauro.outreach_drafts d USING (draft_id) WHERE d.prospect_id = $1", [p.prospectId])).rows[0]!.n, 0, "no content-binding row");
  assert.deepEqual(await journalStates(w, "CMD061", key), [], "no journal reservation");
  const a = draftAnswerOf(await prepareDraft(w, seller, body, key), "the same-key retry");
  assert.deepEqual(await draftResources(w, a.draftId), [r.resourceId], "the same-key retry commits one draft with its binding");
  assert.equal((await draftsOfProspect(w, p.prospectId)).length, 1);
});

cell("GAP-DR-6 RACE (policy): WithdrawOutreachChannelPolicy held at L6p in both orders: 409 OUTREACH_JURISDICTION_UNREVIEWED, or the draft born before it and refused at send; red with L6p removed", "race", async (ctx) => {
  // M11 (CMD061 side). The cell withdraws (US, REQUESTED_REPLY) only, so the other cells' INDIVIDUAL_PROSPECT_CONTACT policy stays in force,
  // and reinstates it after each order (a re-reviewed version).
  const purpose = "REQUESTED_REPLY" as const;
  const runs: Array<{ order: Order; s: Awaited<ReturnType<typeof staging>>; r: RaceResult<unknown, unknown>; refusedAtSend?: string }> = [];
  for (const order of ORDERS) {
    const s = await staging(`dr6-${order}`, { purpose });
    const withdraw = { name: "WithdrawOutreachChannelPolicy", role: "kauro_app" as const, run: () => w.routes.withdrawPolicy(s.p.jurisdiction, purpose), at: W.policyWithdraw };
    const draft = cmd061Actor("CMD061", s.seller, s.body);
    const r = await raceAtWrite(ctx, "M11", order === 1 ? withdraw : draft, order === 1 ? draft : withdraw);
    let refusedAtSend: string | undefined;
    if (order === 2 && "answer" in r.first && (r.first.answer as Reply).status === 201) {
      const a = draftAnswerOf(r.first.answer as Reply);
      const d = asDraft(a, s.body, s.p, s.seller.sender);
      const g = await w.grant([d]);
      refusedAtSend = isGrant(g) ? out(await w.send(s.seller, d, g)) : out(g);
    }
    assert.equal((await policyStates(w, s.p.jurisdiction, purpose)).at(-1), "WITHDRAWN", `order ${order}: the policy is WITHDRAWN`);
    assert.ok((await w.routes.reinstatePolicy(s.p.jurisdiction, purpose)).status < 300, "the policy is reinstated for the next order");
    runs.push({ order, s, r, ...(refusedAtSend === undefined ? {} : { refusedAtSend }) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual(await draftsOfProspect(w, o1.s.p.prospectId), [], "order 1 (withdraw holds L6p X): no draft is born after the withdrawal");
  assert.equal(out(replyOf(o1.r.second, "CMD061")), OUTCOME.JURISDICTION, "order 1: 409 OUTREACH_JURISDICTION_UNREVIEWED");
  const a2 = draftAnswerOf(replyOf(o2.r.first, "CMD061"), "order 2 CMD061");
  assert.equal((await draftRow(w, a2.draftId)).state, "DRAFT", "order 2: the draft born before the withdrawal");
  assert.equal(o2.refusedAtSend, OUTCOME.JURISDICTION, "order 2: refused at send (grant or CMD063) while the policy was WITHDRAWN");
  assert.deepEqual(await intentsOfDraft(w, a2.draftId), [], "order 2: no intent");
  assert.deepEqual(runs.map((x) => x.r.secondBlocked), [true, true], "the second waited on the first at L6p in both orders");
});
