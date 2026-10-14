// The B12 SQL writers (repositories/commercial-outreach.ts) and their lock discipline (outreach-access.ts; plan §L, §W; lane K1): each
// writer commits only with the subjects 0088's T2 asserts already held, in the one global order; a missing subject is refused before any
// SQL runs; an acquisition out of order is refused; the lease fence is judged at kauro.effect_now() (the TEST CLOCK instant of the unit),
// never at a caller instant. The world and its fixtures are b12-outreach-support.ts (every write through its runtime role).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DomainFailure } from "@kauro/domain";
import { OutreachLocks, PgOutreachWriters, holdOutreachLease, type OutreachIntentKeys } from "../src/index.js";
import { at, closeB12, draft, sendIntendedIn, type Draft, freshDomain, grant, ids, nextSlot, openB12, personOf, plus, prospectIn, sender, sha, type B12World, type Sender } from "./b12-outreach-support.js";

let w: B12World;
let snd: Sender;

before(async () => {
  w = await openB12("b12-writers");
  snd = await sender(w, w.s.userId);
});
after(async () => {
  await closeB12(w);
});

const failure = (code: string, reason?: string) => (e: unknown): boolean => {
  assert.ok(e instanceof DomainFailure, `expected a DomainFailure, got ${String(e)}`);
  assert.equal(e.code, code, e.message);
  if (reason !== undefined) assert.equal((e.details as { reason?: string }).reason, reason, e.message);
  return true;
};

async function granted(): Promise<{ keys: OutreachIntentKeys; contactKey: string; slot: string; d: Draft }> {
  const slot = await nextSlot(w);
  const p = await prospectIn(w, w.s, freshDomain("writers"));
  const d = await draft(w, snd, p);
  const g = await grant(w, snd, [d], slot);
  return { d, keys: { intentId: ids.next(), draftId: d.draftId, authorizationId: g.authorizationId, prospectId: p.prospectId, personUserId: snd.userId, purpose: d.purpose }, contactKey: p.contactKey, slot };
}

async function queueAt(k: OutreachIntentKeys, contactKey: string, instant: string, d: Draft): Promise<void> {
  await at(w.app, personOf(k.personUserId), instant, async (c) => {
    const locks = new OutreachLocks(c);
    await locks.take("L3", k.prospectId);
    await locks.take("L4", k.personUserId);
    await locks.take("L4g", k.authorizationId, "S");
    await locks.take("L10", k.draftId);
    await new PgOutreachWriters(c).queueIntent(locks, { ...k, senderId: snd.senderId, route: "GMAIL_API", contactKey, payloadHash: sha(`payload-${k.intentId}`), sequenceFirstIntentId: null, replyActivityId: null });
    await sendIntendedIn(c, { intentId: k.intentId, draft: d, authorizationId: k.authorizationId });
  });
}

async function lease(resource: string, owner: string, instant: string): Promise<number> {
  const r = await w.h.oracle.query<{ fence: string }>("SELECT fence FROM kauro.claim_lease('OUTBOX_DISPATCH', $1, $2, 120, $3, $4, NULL, NULL, $5)", [resource, owner, plus(instant, 3600), sha(`subject-${resource}`), instant]);
  return Number(r.rows[0]!.fence);
}

async function stateOf(intentId: string): Promise<{ intent: string; draft: string }> {
  const r = await w.h.oracle.query<{ intent: string; draft: string }>("SELECT i.state AS intent, d.state AS draft FROM kauro.outreach_send_intents i JOIN kauro.outreach_drafts d USING (draft_id) WHERE i.intent_id = $1", [intentId]);
  return r.rows[0]!;
}

describe("B12 K1 outreach writers (plan §L T2)", () => {
  test("CMD063 queue, D2 claim under the live lease, D4 acceptance and its activity commit through the writers with exactly their T2 subjects", async () => {
    const { keys, contactKey, slot, d } = await granted();
    await queueAt(keys, contactKey, plus(slot, 2), d);
    assert.deepEqual(await stateOf(keys.intentId), { intent: "QUEUED", draft: "AUTHORIZED" });
    const owner = ids.next();
    const fence = await lease(keys.intentId, owner, plus(slot, 5));
    await at(w.outreach, {}, plus(slot, 10), async (c) => {
      const locks = new OutreachLocks(c);
      await locks.take("L3", keys.prospectId, "S");
      await locks.take("L4", keys.personUserId, "X");
      await locks.take("L4g", keys.authorizationId, "S");
      await locks.take("L10", keys.draftId);
      await locks.lease(keys.intentId, owner, fence);
      assert.equal(await new PgOutreachWriters(c).claimIntent(locks, keys, fence), true);
    });
    assert.deepEqual(await stateOf(keys.intentId), { intent: "SUBMITTING", draft: "SUBMITTING" });
    await at(w.outreach, {}, plus(slot, 15), async (c) => {
      const locks = new OutreachLocks(c);
      await locks.take("L3", keys.prospectId, "S");
      await locks.take("L4", keys.personUserId, "S");
      await locks.take("L4g", keys.authorizationId, "S");
      await locks.take("L10", keys.draftId);
      const writers = new PgOutreachWriters(c);
      assert.equal(await writers.answerIntent(locks, keys, fence, { state: "PROVIDER_ACCEPTED", providerMessageRef: `gmail-${keys.intentId}` }), true);
      await writers.recordServiceActivity(locks, { activityId: ids.next(), intent: keys, kind: "PROVIDER_ACCEPTED", providerMessageRef: `gmail-${keys.intentId}`, evidenceHash: sha(`ev-${keys.intentId}`), occurredAt: plus(slot, 15) });
      assert.equal(await writers.answerIntent(locks, keys, fence, { state: "SEND_UNCERTAIN" }), false, "a second answer of the same fence finds no SUBMITTING row");
    });
    assert.deepEqual(await stateOf(keys.intentId), { intent: "PROVIDER_ACCEPTED", draft: "PROVIDER_ACCEPTED" });
  });

  test("a writer whose T2 subject is not held is refused before any SQL runs (the unit stays usable and nothing was written)", async () => {
    const { keys, contactKey, slot } = await granted();
    await at(w.app, personOf(keys.personUserId), plus(slot, 2), async (c) => {
      const locks = new OutreachLocks(c);
      await locks.take("L3", keys.prospectId);
      await locks.take("L4", keys.personUserId);
      await locks.take("L4g", keys.authorizationId, "S");
      await assert.rejects(
        new PgOutreachWriters(c).queueIntent(locks, { ...keys, senderId: snd.senderId, route: "GMAIL_API", contactKey, payloadHash: sha("p"), sequenceFirstIntentId: null, replyActivityId: null }),
        failure("INTEGRITY_FAILURE"),
      );
      assert.equal((await c.query("SELECT 1 AS ok")).rows[0]?.ok, 1, "no statement failed inside the transaction");
    });
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.outreach_send_intents WHERE intent_id = $1", [keys.intentId])).rowCount, 0);
  });

  test("an S subject never meets an X need: D2's first-contact claim needs L4 X", async () => {
    const { keys, contactKey, slot, d } = await granted();
    await queueAt(keys, contactKey, plus(slot, 2), d);
    await at(w.outreach, {}, plus(slot, 10), async (c) => {
      const locks = new OutreachLocks(c);
      await locks.take("L3", keys.prospectId, "S");
      await locks.take("L4", keys.personUserId, "S");
      await locks.take("L4g", keys.authorizationId, "S");
      await locks.take("L10", keys.draftId);
      await assert.rejects(new PgOutreachWriters(c).claimIntent(locks, keys, 1), failure("INTEGRITY_FAILURE"));
    });
  });

  test("an acquisition against the global order is refused before it runs (L10 then L3; L10 keys descending)", async () => {
    await at(w.outreach, {}, w.base, async (c) => {
      const locks = new OutreachLocks(c);
      await locks.take("L10", "b");
      await assert.rejects(locks.take("L3", "a", "S"), failure("INTEGRITY_FAILURE"));
      await assert.rejects(locks.take("L10", "a"), failure("INTEGRITY_FAILURE"));
      const held = await c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()");
      assert.equal(held.rows[0]?.n, 1, "only the first acquisition ran");
    });
    await at(w.outreach, {}, w.base, async (c) => {
      const locks = new OutreachLocks(c);
      await locks.takeAll("L10", ["c", "a", "b", "a"]);
      assert.deepEqual(locks.taken.map((t) => t.subject), ["a", "b", "c"]);
    });
  });

  test("holdOutreachLease judges expiry at kauro.effect_now(): live inside the TTL, LEASE_FENCED after it, and for a stale fence or owner", async () => {
    const slot = await nextSlot(w);
    const resource = ids.next();
    const owner = ids.next();
    const fence = await lease(resource, owner, slot);
    await at(w.outreach, {}, plus(slot, 119), (c) => holdOutreachLease(c, resource, owner, fence));
    await assert.rejects(at(w.outreach, {}, plus(slot, 121), (c) => holdOutreachLease(c, resource, owner, fence)), failure("PRECONDITION_FAILED", "LEASE_FENCED"));
    await assert.rejects(at(w.outreach, {}, plus(slot, 10), (c) => holdOutreachLease(c, resource, owner, fence + 1)), failure("PRECONDITION_FAILED", "LEASE_FENCED"));
    await assert.rejects(at(w.outreach, {}, plus(slot, 10), (c) => holdOutreachLease(c, resource, ids.next(), fence)), failure("PRECONDITION_FAILED", "LEASE_FENCED"));
  });

  test("the service's suppression (public opt-out) takes L8 X, records the key once, and a replay records nothing (A17: no prospect write)", async () => {
    const key = sha(`contact-${ids.next()}`);
    const write = () =>
      at(w.outreach, {}, w.base, async (c) => {
        const locks = new OutreachLocks(c);
        await locks.take("L8", `CONTACT:${key}`);
        return new PgOutreachWriters(c).recordSuppression(locks, { suppressionId: ids.next(), keyKind: "CONTACT", key, reason: "OPT_OUT", by: { service: "outreach-service" } });
      });
    assert.equal(await write(), true);
    assert.equal(await write(), false);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.prospect_suppressions WHERE suppression_key = $1", [key])).rowCount, 1);
  });
});
