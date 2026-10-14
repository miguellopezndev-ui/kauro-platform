// The B12 draft accessor (repositories/commercial-outreach-drafts.ts; lane L-DRAFT part a; plan §L CMD061 and Publish traces): each write
// takes its whole serializer set in the global order, judges at kauro.effect_now() in one statement and only then writes; a refusal writes
// nothing. The world and fixtures are b12-outreach-support.ts (every write through its runtime role).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "pg";
import { DomainFailure, type SellerId, type UserId } from "@kauro/domain";
import { OutreachLocks, PgOutreachDrafts } from "../src/index.js";
import { at, bindingOf, closeB12, content, contentIdOf, freshDomain, ids, openB12, ownerOf, personOf, prospectIn, sender, suppressionIn, type B12World, type Sender } from "./b12-outreach-support.js";

let w: B12World;
let snd: Sender;
let cap: string;

before(async () => {
  w = await openB12("b12-draft-accessor");
  snd = await sender(w, w.s.userId);
  cap = await w.h.offeredCapability("CLEAN");
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

const actor = () => ({ kind: "SELLER", userId: w.s.userId as UserId, sellerId: w.s.sellerId as SellerId }) as const;

const asSeller = <T>(fn: (d: PgOutreachDrafts, c: Client) => Promise<T>): Promise<T> => at(w.app, personOf(w.s.userId), w.base, (c) => fn(new PgOutreachDrafts(c), c));
const asOwner = <T>(fn: (d: PgOutreachDrafts, c: Client) => Promise<T>): Promise<T> => at(w.app, ownerOf(w), w.base, (c) => fn(new PgOutreachDrafts(c), c));

async function publish(family: string | null, expected: number | null, caps: ReadonlyArray<string> = []): Promise<{ resourceId: string; familyId: string; version: number }> {
  const contentRef = await content(w, w.kora, `resource-${ids.next().slice(-8)}`);
  const resourceId = ids.next();
  return asOwner((d) => d.publishResource({ resourceId, familyId: family, expectedVersion: expected, contentRef, capabilityIds: caps, publishedByUserId: w.kora as UserId }));
}

async function inputFor(p: { prospectId: string; evidenceHash: string }, resourceIds: ReadonlyArray<string> = [], purpose: "INDIVIDUAL_PROSPECT_CONTACT" | "FOLLOW_UP" = "INDIVIDUAL_PROSPECT_CONTACT", s: Sender = snd) {
  return {
    draftId: ids.next(),
    actor: actor(),
    prospectId: p.prospectId,
    senderId: s.senderId,
    purpose,
    contentRef: await content(w, w.s.userId, `prep-${ids.next().slice(-8)}`),
    provenanceEvidenceHash: p.evidenceHash,
    resourceIds,
  } as const;
}

const rows = async (draftId: string): Promise<number> => (await w.h.oracle.query("SELECT 1 FROM kauro.outreach_drafts WHERE draft_id = $1", [draftId])).rowCount ?? 0;

describe("B12 L-DRAFT accessor: prepareDraft (CMD061)", () => {
  test("a seller's draft carries the binding hash and its resource bindings, and reads back", async () => {
    const r = await publish(null, null, [cap]);
    const p = await prospectIn(w, w.s, freshDomain("prep"));
    const i = await inputFor(p, [r.resourceId]);
    const out = await asSeller((d) => d.prepareDraft(i));
    assert.deepEqual({ ...out }, { draftId: i.draftId, version: 1, state: "DRAFT", contentHash: bindingOf(p.prospectId, p.contactKey, snd.senderId, i.purpose, i.contentRef) });
    const back = await asSeller((d) => d.draftOf(i.draftId));
    assert.equal(back?.state, "DRAFT");
    assert.equal(back?.contentRef, i.contentRef);
    assert.deepEqual(back?.resourceIds, [r.resourceId]);
    assert.equal(await asSeller((d) => d.draftOf(ids.next())), null);
  });

  test("an unknown or foreign prospect, sender, provenance or content is NOT_FOUND and writes nothing", async () => {
    const p = await prospectIn(w, w.s, freshDomain("nf"));
    const foreign = await prospectIn(w, w.s2, freshDomain("nf2"));
    const s2snd = await sender(w, w.s2.userId);
    const cases: Array<[string, Awaited<ReturnType<typeof inputFor>>]> = [
      ["foreign prospect", await inputFor(foreign)],
      ["unknown prospect", { ...(await inputFor(p)), prospectId: ids.next() }],
      ["foreign sender", await inputFor(p, [], "INDIVIDUAL_PROSPECT_CONTACT", s2snd)],
      ["wrong provenance", { ...(await inputFor(p)), provenanceEvidenceHash: "0".repeat(64) }],
      ["unknown content", { ...(await inputFor(p)), contentRef: contentIdOf("none", "none") }],
      ["unknown resource", await inputFor(p, [ids.next()])],
    ];
    for (const [label, i] of cases) {
      await assert.rejects(asSeller((d) => d.prepareDraft(i)), failure("NOT_FOUND"), label);
      assert.equal(await rows(i.draftId), 0, label);
    }
  });

  test("a revoked and a pending sender, an unreviewed jurisdiction and a suppressed contact are refused with their reason", async () => {
    const p = await prospectIn(w, w.s, freshDomain("ref"));
    const pending = await sender(w, w.s.userId, { pending: true });
    await assert.rejects(asSeller(async (d) => d.prepareDraft(await inputFor(p, [], "INDIVIDUAL_PROSPECT_CONTACT", pending))), failure("PRECONDITION_FAILED", "SENDER_NOT_VERIFIED"));
    const revoked = await sender(w, w.s.userId);
    await at(w.app, ownerOf(w), w.base, async (c) => {
      await new OutreachLocks(c).take("L7", revoked.senderId);
      await c.query("UPDATE kauro.sender_identities SET state = 'REVOKED' WHERE sender_id = $1", [revoked.senderId]);
    });
    await assert.rejects(asSeller(async (d) => d.prepareDraft(await inputFor(p, [], "INDIVIDUAL_PROSPECT_CONTACT", revoked))), failure("PRECONDITION_FAILED", "SENDER_REVOKED"));
    const nowhere = await prospectIn(w, w.s, freshDomain("juris"), "Atlantis");
    await assert.rejects(asSeller(async (d) => d.prepareDraft(await inputFor(nowhere))), failure("PRECONDITION_FAILED", "OUTREACH_JURISDICTION_UNREVIEWED"));
    const sup = await prospectIn(w, w.s, freshDomain("sup"));
    await at(w.app, personOf(w.s.userId), w.base, (c) => suppressionIn(c, w.s.userId, "CONTACT", sup.contactKey, "REFUSAL"));
    await assert.rejects(asSeller(async (d) => d.prepareDraft(await inputFor(sup))), failure("PRECONDITION_FAILED", "PROSPECT_SUPPRESSED"));
  });

  test("a superseded resource is RESOURCE_NOT_CURRENT", async () => {
    const r1 = await publish(null, null);
    await publish(r1.familyId, 1);
    const p = await prospectIn(w, w.s, freshDomain("old"));
    const i = await inputFor(p, [r1.resourceId]);
    await assert.rejects(asSeller((d) => d.prepareDraft(i)), failure("PRECONDITION_FAILED", "RESOURCE_NOT_CURRENT"));
    assert.equal(await rows(i.draftId), 0);
  });

  test("a lock taken out of the global order before the accessor is refused as an integrity failure", async () => {
    const p = await prospectIn(w, w.s, freshDomain("order"));
    const i = await inputFor(p);
    await assert.rejects(
      asSeller(async (d, c) => {
        await new OutreachLocks(c).take("L10", ids.next());
        return d.prepareDraft(i);
      }),
      failure("INTEGRITY_FAILURE"),
    );
    assert.equal(await rows(i.draftId), 0);
  });
});

describe("B12 L-DRAFT accessor: putContent", () => {
  test("is content-addressed and idempotent whoever puts it", async () => {
    const a = await asSeller((d) => d.putContent({ subject: "Hello", body: "Same body" }, w.s.userId as UserId));
    const b = await asOwner((d) => d.putContent({ subject: "Hello", body: "Same body" }, w.kora as UserId));
    assert.equal(a, contentIdOf("Hello", "Same body"));
    assert.equal(b, a);
    assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.outreach_contents WHERE content_id = $1", [a])).rowCount, 1);
  });
});

describe("B12 L-DRAFT accessor: publishResource", () => {
  test("v1 then v2 supersede, one CURRENT per family, and the reads show the chain", async () => {
    const v1 = await publish(null, null, [cap]);
    assert.equal(v1.version, 1);
    const v2 = await publish(v1.familyId, 1, [cap]);
    assert.equal(v2.version, 2);
    assert.equal(v2.familyId, v1.familyId);
    const old = await asOwner((d) => d.resourceOf(v1.resourceId));
    assert.equal(old?.state, "SUPERSEDED");
    assert.equal(old?.currentResourceId, v2.resourceId);
    const cur = await asOwner((d) => d.resourceOf(v2.resourceId));
    assert.deepEqual({ state: cur?.state, current: cur?.currentResourceId, caps: cur?.capabilityIds }, { state: "CURRENT", current: v2.resourceId, caps: [cap] });
    assert.equal(await asOwner((d) => d.resourceOf(ids.next())), null);
  });

  test("a stale expectedVersion is STALE_VERSION, an unknown family NOT_FOUND, an existing family without a version refused, nothing is written", async () => {
    const v1 = await publish(null, null);
    await publish(v1.familyId, 1);
    await assert.rejects(publish(v1.familyId, 1), failure("STALE_VERSION"));
    await assert.rejects(publish(ids.next(), 1), failure("NOT_FOUND"));
    await assert.rejects(publish(v1.familyId, null), failure("PRECONDITION_FAILED", "RESOURCE_NOT_CURRENT"));
    const n = await w.h.oracle.query("SELECT count(*)::int AS n FROM kauro.sales_resources WHERE family_id = $1", [v1.familyId]);
    assert.equal(n.rows[0].n, 2);
  });

  test("an unknown content or capability is NOT_FOUND", async () => {
    const resourceId = ids.next();
    await assert.rejects(asOwner((d) => d.publishResource({ resourceId, familyId: null, expectedVersion: null, contentRef: contentIdOf("x", "y"), capabilityIds: [], publishedByUserId: w.kora as UserId })), failure("NOT_FOUND"));
    await assert.rejects(publish(null, null, [ids.next()]), failure("NOT_FOUND"));
  });
});

describe("B12 L-DRAFT accessor: latestStepUpProof", () => {
  test("is undefined for a person with no proof", async () => {
    assert.equal(await asOwner((d) => d.latestStepUpProof(ids.next() as UserId)), undefined);
  });
});
