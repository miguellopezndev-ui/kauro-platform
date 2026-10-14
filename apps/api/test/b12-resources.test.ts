// Sales resources (package B12, lane L-DRAFT): PublishSalesResource / GetSalesResource and the resource gates of CMD061/CMD062/CMD063
// (plan docs/design/B12-outreach-plan.md rev 4 §1 R2-135, §M M40; companion B12-outreach-plan-cells.md §R Publish row GAP-PU-1/2/3 and its
// crash title). Publish of version n+1 of a family, one COMMIT: L1 (owner) -> L6 X family -> UPDATE n CURRENT -> SUPERSEDED (edge trigger) ->
// INSERT n+1 CURRENT (T7 one CURRENT per family, UNIQUE family/version) -> INSERT its capability claims -> journal. Written FIRST: every
// title fails until the lane builds publish-resource.ts / resources.ts and its world; GAP-PU-1 fails under KAURO_B12_CONTROL=M40 (L6 and
// the co-guards T7, family/version UNIQUE and the edge trigger removed: two CURRENT versions of the family) and GAP-PU-2 under PU-2.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  answerOf, asDraft, capabilityState, cell, claimsOf, completedOf, contentIdOf, corporateRoleState, draftAnswerOf, draftBodyOf, draftResources, draftRow, draftsOfProspect,
  draftWorld, failing, familyRows, intentsOfDraft, journalStates, keyOf, ORDERS, OUTCOME, prepareDraft, publish, raceAtWrite, revokeOwnerActor, ROUTES, safeContent, STALE,
  statusCode, T0, W, type DraftWorld, type GrantP, type Order, type Person, type RaceResult, type ResourceP, type Settled,
} from "./b12-draft-support.js";
import type { Reply } from "./support.js";

let w: DraftWorld;
before(async () => {
  w = await draftWorld("b12-resources");
  w.standAt(T0);
});
after(async () => {
  await w.stop();
});

const out = (r: Reply): string => w.outcome(r);
const replyOf = (s: Settled<unknown>, what: string): Reply => answerOf(s, what) as Reply;
const isGrant = (g: GrantP | Reply): g is GrantP => "authorizationId" in g;
interface Published {
  readonly resourceId: string;
  readonly familyId: string;
  readonly version: number;
  readonly state: string;
}
const publishedOf = (reply: Reply, what = "PublishSalesResource"): Published => completedOf<Published>(reply, 201, what).data;
/** The next version of the resource's family, by the publisher, from fresh content. */
async function nextVersion(publisher: Person, r: ResourceP, label: string, key?: string): Promise<Reply> {
  const contentRef = await contentIdOf(w, publisher, safeContent(label));
  return publish(w, publisher, { familyId: r.familyId, expectedVersion: r.version, contentRef, capabilityIds: [r.capabilityId] }, key);
}
const shape = async (familyId: string): Promise<Array<[number, string]>> => (await familyRows(w, familyId)).map((x) => [x.version, x.state]);

// --- R2-135 -----------------------------------------------------------------------------------------------------------------------------
test("R2-135: a seller opening a superseded offer sheet sees SUPERSEDED and the current resource; a new draft citing it, a grant over a draft citing it and a send are refused, a capability suspended by CMD059 after drafting refuses the grant and the claim (NOT_SENT CAPABILITY_RESTRICTED), and the historical draft, intent and activity rows stay readable", async () => {
  // (a) superseded resource: drafted while CURRENT, then version 2 is published
  const seller = await w.seller("r2135");
  const p1 = await w.prospect(seller);
  const r = await w.freshResource("r2135-sheet");
  const b1 = await draftBodyOf(w, seller, p1, r, "r2135-d1");
  const d1 = draftAnswerOf(await prepareDraft(w, seller, b1), "a draft citing version 1 while CURRENT");
  const v2 = publishedOf(await nextVersion(w.owner, r, "r2135-sheet-v2"));
  assert.deepEqual([v2.familyId, v2.version, v2.state], [r.familyId, 2, "CURRENT"], "version 2 is CURRENT");
  assert.deepEqual(await shape(r.familyId), [[1, "SUPERSEDED"], [2, "CURRENT"]]);
  const opened = await w.call({ method: "GET", url: ROUTES.getResource(r.resourceId), token: seller.token, key: null });
  assert.equal(opened.status, 200, opened.text);
  const sheet = opened.json<{ data?: { state?: string; currentResourceId?: string; version?: number } }>().data ?? opened.json<{ state?: string; currentResourceId?: string; version?: number }>();
  assert.deepEqual([sheet.state, sheet.version, sheet.currentResourceId], ["SUPERSEDED", 1, v2.resourceId], "the seller sees SUPERSEDED and the current resource");
  const p2 = await w.prospect(seller);
  const fresh = await prepareDraft(w, seller, await draftBodyOf(w, seller, p2, r, "r2135-d2"));
  assert.equal(out(fresh), OUTCOME.KC033, `a new draft citing the superseded version: ${fresh.text}`);
  assert.deepEqual(await draftsOfProspect(w, p2.prospectId), [], "no draft");
  const dd1 = asDraft(d1, b1, p1, seller.sender);
  const g1 = await w.grant([dd1]);
  assert.ok(!isGrant(g1), "the grant over a draft citing the superseded version is refused");
  assert.equal(out(g1), OUTCOME.KC033, `the grant refusal: ${g1.text}`);
  // a send of the same draft under a grant taken before the supersession
  const r2 = await w.freshResource("r2135-sheet-b");
  const p3 = await w.prospect(seller);
  const b3 = await draftBodyOf(w, seller, p3, r2, "r2135-d3");
  const d3 = asDraft(draftAnswerOf(await prepareDraft(w, seller, b3)), b3, p3, seller.sender);
  const g3 = await w.grant([d3]);
  assert.ok(isGrant(g3), "granted while version 1 is CURRENT");
  publishedOf(await nextVersion(w.owner, r2, "r2135-sheet-b-v2"));
  const calls = w.callsTotal();
  const sent = await w.send(seller, d3, g3);
  assert.equal(out(sent), OUTCOME.KC033, `the send of a draft citing a superseded version: ${sent.text}`);
  assert.deepEqual(await intentsOfDraft(w, d3.draftId), [], "no intent");
  // (b) capability suspended by CMD059 after drafting
  const r3 = await w.freshResource("r2135-cap");
  const p4 = await w.prospect(seller);
  const b4 = await draftBodyOf(w, seller, p4, r3, "r2135-d4");
  const d4 = asDraft(draftAnswerOf(await prepareDraft(w, seller, b4)), b4, p4, seller.sender);
  const p5 = await w.prospect(seller);
  const b5 = await draftBodyOf(w, seller, p5, r3, "r2135-d5");
  const d5 = asDraft(draftAnswerOf(await prepareDraft(w, seller, b5)), b5, p5, seller.sender);
  const g5 = await w.grant([d5]);
  assert.ok(isGrant(g5), "d5 granted while the capability is AVAILABLE");
  assert.equal((await w.send(seller, d5, g5)).status, 200, "d5 queued while the capability is AVAILABLE");
  assert.ok((await w.routes.suspendCapability(r3.capabilityId)).status < 300, "CMD059 suspends the capability");
  assert.equal(await capabilityState(w, r3.capabilityId), "SUSPENDED");
  const g4 = await w.grant([d4]);
  assert.ok(!isGrant(g4), "the grant over a draft whose capability is SUSPENDED is refused");
  assert.equal(out(g4), OUTCOME.KC033, `the grant refusal: ${g4.text}`);
  await w.dispatcher().pass();
  const [i5] = await intentsOfDraft(w, d5.draftId);
  assert.ok(i5 !== undefined, "d5 has its intent");
  assert.deepEqual([i5.state, i5.reason], ["NOT_SENT", "CAPABILITY_RESTRICTED"], "the claim refuses the queued intent: NOT_SENT CAPABILITY_RESTRICTED");
  assert.equal(w.callsOf(i5.intentId), 0, "no provider call for the refused claim");
  assert.equal(w.callsTotal(), calls, "zero provider calls since the first refusal");
  // (c) the historical rows stay readable
  for (const id of [d1.draftId, d4.draftId, d5.draftId]) {
    const read = await w.call({ method: "GET", url: ROUTES.getDraft(id), token: seller.token, key: null });
    assert.equal(read.status, 200, `the historical draft ${id} stays readable: ${read.text}`);
  }
  assert.deepEqual([(await draftRow(w, d1.draftId)).state, await draftResources(w, d1.draftId)], ["DRAFT", [r.resourceId]], "d1 still cites version 1");
  assert.deepEqual(await claimsOf(w, r.resourceId), [r.capabilityId], "version 1's claim is kept");
  assert.equal((await intentsOfDraft(w, d5.draftId)).length, 1, "the NOT_SENT intent row is kept");
});

// --- GAP-PU-1 (M40) ---------------------------------------------------------------------------------------------------------------------
cell("GAP-PU-1 RACE: two publishes of one family held at L6: one n+1, one 409 stale", "race", async (ctx) => {
  const runs: Array<{ order: Order; r: ResourceP; race: RaceResult<unknown, unknown>; first: string; second: string }> = [];
  for (const order of ORDERS) {
    const r = await w.freshResource(`pu1-${order}`);
    const [ca, cb] = [await contentIdOf(w, w.owner, safeContent(`pu1-${order}-a`)), await contentIdOf(w, w.owner, safeContent(`pu1-${order}-b`))];
    const a = { name: "publish-A", role: "kauro_app" as const, run: () => publish(w, w.owner, { familyId: r.familyId, expectedVersion: 1, contentRef: ca, capabilityIds: [r.capabilityId] }), at: W.resourceSupersede };
    const b = { name: "publish-B", role: "kauro_app" as const, run: () => publish(w, w.owner, { familyId: r.familyId, expectedVersion: 1, contentRef: cb, capabilityIds: [r.capabilityId] }), at: W.resourceSupersede };
    const race = await raceAtWrite(ctx, "M40", order === 1 ? a : b, order === 1 ? b : a);
    runs.push({ order, r, race, first: order === 1 ? ca : cb, second: order === 1 ? cb : ca });
  }
  for (const { order, r, race, first } of runs) {
    // forbidden effect first: two CURRENT versions (or a version 3 on a stale read) of one family
    const rows = await familyRows(w, r.familyId);
    assert.deepEqual(rows.map((x) => [x.version, x.state]), [[1, "SUPERSEDED"], [2, "CURRENT"]], `order ${order}: exactly one n+1, one CURRENT`);
    const won = publishedOf(replyOf(race.first, "first publish"), `order ${order} first publish`);
    assert.deepEqual([won.version, won.state], [2, "CURRENT"], `order ${order}: the first publish is version 2`);
    const current = (await w.oracle.query<{ ref: string }>("SELECT content_id AS ref FROM kauro.sales_resources WHERE resource_id = $1", [won.resourceId])).rows[0]!.ref;
    assert.equal(current, first, `order ${order}: version 2 carries the first publisher's content`);
    assert.equal(statusCode(w, replyOf(race.second, "second publish")), STALE, `order ${order}: the second is 409 stale`);
  }
  assert.deepEqual(runs.map((x) => x.race.secondBlocked), [true, true], "the second waited on the first at L6 in both orders");
});

// --- PUBLISH crash ----------------------------------------------------------------------------------------------------------------------
cell(
  "PUBLISH crash after the UPDATE before COMMIT: old stays CURRENT; after: replay",
  "crash-before-commit",
  async (ctx) => {
    {
      const r = await w.freshResource("pub-crash-before");
      const key = keyOf("pub-crb");
      const contentRef = await contentIdOf(w, w.owner, safeContent("pub-crb-v2"));
      ctx.points.crash("target.before-commit");
      const conn = await w.open("kauro_app_test");
      let crashed: Reply;
      try {
        crashed = await ctx.operation("publish dying before COMMIT", async () => w.on(conn, "kauro_app", ctx, [W.resourceSupersede], () => publish(w, w.owner, { familyId: r.familyId, expectedVersion: 1, contentRef, capabilityIds: [r.capabilityId] }, key), { target: 1 }));
      } finally {
        await conn.end().catch(() => undefined);
      }
      assert.equal(crashed.status, 500, `the publish reached its COMMIT and died there: ${crashed.text}`);
      assert.ok(ctx.points.passed.includes("db.resource_supersede.after"), "the crash came after the UPDATE CURRENT -> SUPERSEDED");
      assert.deepEqual(await shape(r.familyId), [[1, "CURRENT"]], "the old version stays CURRENT, no version 2");
      assert.deepEqual(await claimsOf(w, r.resourceId), [r.capabilityId]);
      assert.deepEqual(await journalStates(w, "PublishSalesResource", key), [], "no journal row");
    }
    {
      const r = await w.freshResource("pub-crash-after");
      const key = keyOf("pub-cra");
      const contentRef = await contentIdOf(w, w.owner, safeContent("pub-cra-v2"));
      const body = { familyId: r.familyId, expectedVersion: 1, contentRef, capabilityIds: [r.capabilityId] };
      ctx.points.crash("target.after-commit");
      const conn = await w.open("kauro_app_test");
      let lost: Reply;
      try {
        lost = await ctx.operation("publish answer lost after COMMIT", () => w.on(conn, "kauro_app", ctx, [], () => publish(w, w.owner, body, key), { target: 1 }));
      } finally {
        await conn.end().catch(() => undefined);
      }
      assert.equal(lost.status, 500, `the answer was lost after COMMIT: ${lost.text}`);
      assert.deepEqual(await shape(r.familyId), [[1, "SUPERSEDED"], [2, "CURRENT"]], "committed: version 2 CURRENT");
      const replay = publishedOf(await publish(w, w.owner, body, key), "the same-key replay");
      const v2 = (await familyRows(w, r.familyId)).find((x) => x.version === 2)!;
      assert.deepEqual([replay.resourceId, replay.version], [v2.resourceId, 2], "the same key replays the committed version 2");
      assert.deepEqual(await shape(r.familyId), [[1, "SUPERSEDED"], [2, "CURRENT"]], "still one version 2");
      assert.deepEqual(await journalStates(w, "PublishSalesResource", key), ["COMMITTED"]);
    }
  },
  "target",
);

// --- GAP-PU-2 (owner grant revoked at L1) -----------------------------------------------------------------------------------------------
cell("GAP-PU-2 RACE (owner grant): the publisher's KAURO_OWNER grant revoked at L1 in both orders: version n+1 then REVOKED, or 403 and the family unchanged", "race", async (ctx) => {
  const runs: Array<{ order: Order; r: ResourceP; grantId: string; race: RaceResult<unknown, unknown> }> = [];
  for (const order of ORDERS) {
    const owner = await w.extraOwner(`pu2-${order}`);
    const r = await w.freshResource(`pu2-${order}`);
    const contentRef = await contentIdOf(w, owner, safeContent(`pu2-${order}-v2`));
    const pub = { name: "PublishSalesResource", role: "kauro_app" as const, run: () => publish(w, owner, { familyId: r.familyId, expectedVersion: 1, contentRef, capabilityIds: [r.capabilityId] }), at: W.resourceSupersede };
    const revoke = revokeOwnerActor(owner.grantId);
    runs.push({ order, r, grantId: owner.grantId, race: await raceAtWrite<unknown, unknown>(ctx, "PU-2", order === 1 ? revoke : pub, order === 1 ? pub : revoke) });
  }
  const [o1, o2] = runs as [(typeof runs)[0], (typeof runs)[0]];
  assert.deepEqual(await shape(o1.r.familyId), [[1, "CURRENT"]], "order 1 (revocation holds L1 X): no version is published by the revoked owner");
  assert.equal(statusCode(w, replyOf(o1.race.second, "publish")), "403 NOT_AUTHORIZED", "order 1: the publish is 403");
  assert.equal(answerOf(o1.race.first, "revocation"), 1, "order 1: one grant revoked");
  assert.equal(await corporateRoleState(w, o1.grantId), "REVOKED");
  assert.deepEqual(await shape(o2.r.familyId), [[1, "SUPERSEDED"], [2, "CURRENT"]], "order 2: version 2 committed before the revocation");
  assert.equal(publishedOf(replyOf(o2.race.first, "publish"), "order 2 publish").version, 2);
  assert.equal(await corporateRoleState(w, o2.grantId), "REVOKED", "order 2: then REVOKED");
  assert.deepEqual(runs.map((x) => x.race.secondBlocked), [true, true], "the second waited on the first at L1 in both orders");
});

// --- GAP-PU-3 (PARTIAL) -----------------------------------------------------------------------------------------------------------------
cell("GAP-PU-3 failure at the capability-claim INSERT rolls back n+1 and the SUPERSEDED edge", "partial", async (ctx) => {
  const r = await w.freshResource("pu3");
  const key = keyOf("pu3");
  const contentRef = await contentIdOf(w, w.owner, safeContent("pu3-v2"));
  const body = { familyId: r.familyId, expectedVersion: 1, contentRef, capabilityIds: [r.capabilityId] };
  const conn = await w.open("kauro_app_test");
  try {
    await ctx.partial("publish failing at its capability-claim INSERT after the UPDATE and the n+1 INSERT", "db.capability_claim_insert.before", () =>
      w.on(conn, "kauro_app", ctx, [W.resourceSupersede, W.resourceInsert, W.capabilityClaimInsert], () => failing(w, () => publish(w, w.owner, body, key))),
    );
  } finally {
    await conn.end().catch(() => undefined);
  }
  assert.ok(ctx.points.passed.includes("db.resource_insert.after"), "the n+1 INSERT had completed");
  assert.deepEqual(await shape(r.familyId), [[1, "CURRENT"]], "no version 2, and version 1 is CURRENT again (the SUPERSEDED edge rolled back)");
  assert.deepEqual(await claimsOf(w, r.resourceId), [r.capabilityId], "version 1's claim unchanged");
  assert.deepEqual(await journalStates(w, "PublishSalesResource", key), [], "no journal reservation");
  const retried = publishedOf(await publish(w, w.owner, body, key), "the same-key retry");
  assert.deepEqual([retried.version, retried.state], [2, "CURRENT"]);
  assert.deepEqual(await shape(r.familyId), [[1, "SUPERSEDED"], [2, "CURRENT"]], "the same-key retry commits version 2 once");
  assert.deepEqual(await claimsOf(w, retried.resourceId), [r.capabilityId], "version 2 claims the capability");
});
