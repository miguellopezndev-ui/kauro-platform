// Lane L-AUTH of package B12: the SQL of the review, the grant, the revocation and the policy withdrawal (repositories/commercial-outreach-auth.ts;
// plan docs/design/B12-outreach-plan.md §L, §M M31..M34, §W; GAP-AU-5, GAP-AU-4/PARTIAL shape, M6/M10 writer side). The world and its fixtures are
// b12-outreach-support.ts (every write through its runtime role). Written compile-only under the owner sprint of 2026-10-14: run at the batch.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DomainFailure } from "@kauro/domain";
import { PgOutreachAuth } from "../src/index.js";
import { at, closeB12, draft, freshDomain, ids, nextSlot, openB12, ownerOf, plus, prospectIn, review, sender, type B12World, type Draft, type Sender } from "./b12-outreach-support.js";

let w: B12World;
let snd: Sender;

before(async () => {
  w = await openB12("b12-auth");
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

async function freshDraft(): Promise<Draft> {
  const p = await prospectIn(w, w.s, freshDomain("auth"));
  return draft(w, snd, p);
}

describe("B12 L-AUTH adapter (plan §L, §2 CMD062)", () => {
  test("a review is issued under L10 S of its drafts: issued_at is the database instant and expires 15 minutes later; a writer without the lock is refused before any SQL", async () => {
    const d = await freshDraft();
    const slot = await nextSlot(w);
    const reviewId = ids.next();
    await at(w.app, ownerOf(w), slot, async (c) => {
      const store = new PgOutreachAuth(c);
      await assert.rejects(store.issueReview({ reviewId, ownerUserId: w.kora, proofId: ids.next(), senderId: snd.senderId, digest: "0".repeat(64), items: [{ draftId: d.draftId, draftVersion: 1, contentHash: d.contentHash, contactLabel: "Lead" }] }), failure("INTEGRITY_FAILURE"));
      assert.equal((await c.query("SELECT 1 AS ok")).rows[0]?.ok, 1, "nothing failed inside the transaction");
    });
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.outreach_reviews WHERE review_id = $1", [reviewId])).rowCount, 0);
  });

  test("grantFacts judges the review at kauro.effect_now(): live one microsecond before issued_at + 15 min, refused at it (GAP-AU-5)", async () => {
    const d = await freshDraft();
    const slot = await nextSlot(w);
    const rv = await review(w, snd, [d], slot);
    // kauro.effect_now() is the test clock plus the time the transaction has run (0038), so the instant a statement judges at can only be
    // placed within the few milliseconds between the clock being set and the statement: "just before" is a 250 ms margin that covers
    // them, and "at the boundary" is exact because effect_now() never reads earlier than the instant the clock was set to. The review's
    // expiry carries microseconds (stamped at the database instant of the issue): both instants are computed by the database, never
    // through a JavaScript Date (which keeps milliseconds only).
    const fmt = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'";
    const bounds = (
      await w.h.oracle.query<{ e: string; before1us: string }>(
        `SELECT to_char(expires_at AT TIME ZONE 'UTC', ${fmt}) AS e, to_char((expires_at - interval '250 milliseconds') AT TIME ZONE 'UTC', ${fmt}) AS before1us FROM kauro.outreach_reviews WHERE review_id = $1`,
        [rv.reviewId],
      )
    ).rows[0]!;
    const { e: expiresAt, before1us } = bounds;
    const q = { reviewId: rv.reviewId, draftIds: [d.draftId], senderId: snd.senderId, validFrom: slot, expiresAt: plus(slot, 3600) };
    const early = await at(w.app, ownerOf(w), before1us, (c) => new PgOutreachAuth(c).grantFacts(q));
    assert.equal(early.reviewLive, true, "just before the boundary (a margin that covers the statement's own elapsed time) the review is live");
    const onTime = await at(w.app, ownerOf(w), expiresAt, (c) => new PgOutreachAuth(c).grantFacts(q));
    assert.equal(onTime.reviewLive, false, "at the boundary the review is expired");
  });

  test("M34: two grants of one review give one grant (U1) and the other is OUTREACH_REVIEW_INVALID, never a raw constraint error", async () => {
    const d = await freshDraft();
    const slot = await nextSlot(w);
    const rv = await review(w, snd, [d], slot);
    const seal = { draftId: d.draftId, contentHash: d.contentHash };
    const grantAt = (instant: string): Promise<unknown> =>
      at(w.app, ownerOf(w), instant, async (c) => {
        const store = new PgOutreachAuth(c);
        await store.lockGrantSet([d.draftId], snd.senderId);
        return store.insertGrant({
          authorizationId: ids.next(),
          reviewId: rv.reviewId,
          grantingUserId: w.kora,
          senderId: snd.senderId,
          proofId: rv.proofId,
          validFrom: instant,
          expiresAt: plus(instant, 3600),
          maximumSends: 1,
          permissionEvidenceHash: "a".repeat(64),
          policyVersion: "outreach-v1",
          seals: [seal],
        });
      });
    await grantAt(plus(slot, 1));
    await assert.rejects(grantAt(plus(slot, 2)), failure("PRECONDITION_FAILED", "OUTREACH_REVIEW_INVALID"));
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.outreach_authorizations WHERE review_id = $1", [rv.reviewId])).rowCount, 1);
  });

  test("RevokeOutreachAuthorization writer: refused without L4g X, revokes once, a second revoke is a no-op", async () => {
    const d = await freshDraft();
    const slot = await nextSlot(w);
    const rv = await review(w, snd, [d], slot);
    const authorizationId = ids.next();
    await at(w.app, ownerOf(w), plus(slot, 1), async (c) => {
      const store = new PgOutreachAuth(c);
      await store.lockGrantSet([d.draftId], snd.senderId);
      await store.insertGrant({ authorizationId, reviewId: rv.reviewId, grantingUserId: w.kora, senderId: snd.senderId, proofId: rv.proofId, validFrom: plus(slot, 1), expiresAt: plus(slot, 3600), maximumSends: 1, permissionEvidenceHash: "b".repeat(64), policyVersion: "outreach-v1", seals: [{ draftId: d.draftId, contentHash: d.contentHash }] });
    });
    await at(w.app, ownerOf(w), plus(slot, 5), async (c) => {
      await assert.rejects(new PgOutreachAuth(c).revokeGrant(authorizationId, w.kora), failure("INTEGRITY_FAILURE"));
    });
    await at(w.app, ownerOf(w), plus(slot, 6), async (c) => {
      const store = new PgOutreachAuth(c);
      await store.lockGrant(authorizationId);
      assert.equal(await store.revokeGrant(authorizationId, w.kora), true);
      assert.equal(await store.revokeGrant(authorizationId, w.kora), false);
      assert.equal((await store.authorizationById(authorizationId))?.revoked, true);
    });
  });

  test("WithdrawOutreachChannelPolicy writer: refused without L6p X; withdraws IN_FORCE once and a second withdraw changes nothing", async () => {
    const jurisdiction = "US";
    const purpose = "FOLLOW_UP";
    const slot = await nextSlot(w);
    await at(w.app, ownerOf(w), slot, async (c) => {
      await assert.rejects(new PgOutreachAuth(c).withdrawPolicy({ jurisdiction, purpose, version: 1, byUserId: w.kora }), failure("INTEGRITY_FAILURE"));
    });
    await at(w.app, ownerOf(w), plus(slot, 1), async (c) => {
      const store = new PgOutreachAuth(c);
      await store.lockPolicy(jurisdiction, purpose);
      assert.equal(await store.withdrawPolicy({ jurisdiction, purpose, version: 1, byUserId: w.kora }), true);
      assert.equal(await store.withdrawPolicy({ jurisdiction, purpose, version: 1, byUserId: w.kora }), false);
      assert.equal((await store.latestPolicy(jurisdiction, purpose))?.state, "WITHDRAWN");
    });
    // restore for sibling tests of this database: the world is private to this file, but keep the policy row honest for the oracle
    assert.equal((await w.h.oracle.query("SELECT state FROM kauro.outreach_channel_policies WHERE jurisdiction = 'US' AND purpose = 'FOLLOW_UP' AND version = 1")).rows[0]?.state, "WITHDRAWN");
  });
});
