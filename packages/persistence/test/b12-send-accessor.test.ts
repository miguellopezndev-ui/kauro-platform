// The B12 send accessor (repositories/commercial-outreach-send.ts; lane L-SEND part a; plan §L CMD063 and D2..D5 traces): each write takes
// its whole serializer set in the global order (OutreachLocks refuses a trace that leaves it), judges at kauro.effect_now() in one statement
// and only then writes; a refusal writes nothing. The world and fixtures are b12-outreach-support.ts (every write through its runtime role).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Client } from "pg";
import { DomainFailure, type SellerId, type UserId } from "@kauro/domain";
import { OutreachRefusal, PgOutreachSend, type ClaimVerdict, type OutcomeAnswer, type QueueSendInput, type QueuedSend } from "../src/index.js";
import { at, closeB12, draft, freshDomain, grant, ids, nextSlot, openB12, personOf, plus, prospectIn, sender, sendIntendedIn, sha, suppressionIn, type B12World, type Draft, type Sender } from "./b12-outreach-support.js";

let w: B12World;
let snd: Sender;

before(async () => {
  w = await openB12("b12-send-accessor");
  snd = await sender(w, w.s.userId);
});
after(async () => {
  await closeB12(w);
});

const failure = (reason: string, code?: string) => (e: unknown): boolean => {
  assert.ok(e instanceof DomainFailure, `expected a DomainFailure, got ${String(e)}`);
  if (code !== undefined) assert.equal(e.code, code, e.message);
  assert.equal((e.details as { reason?: string }).reason, reason, e.message);
  return true;
};

const actor = () => ({ kind: "SELLER", userId: w.s.userId as UserId, sellerId: w.s.sellerId as SellerId }) as const;
const seal = (intentId: string): string => sha(`payload-${intentId}`);

interface Fixture {
  readonly draft: Draft;
  readonly authorizationId: string;
  readonly slot: string;
}

/** A prospect, a draft and a grant for it, granted at the next business slot. */
async function fixture(s: Sender = snd, purpose: Draft["purpose"] = "INDIVIDUAL_PROSPECT_CONTACT"): Promise<Fixture> {
  const slot = await nextSlot(w);
  const p = await prospectIn(w, w.s, freshDomain("send"));
  const d = await draft(w, s, p, purpose);
  const g = await grant(w, s, [d], slot);
  return { draft: d, authorizationId: g.authorizationId, slot };
}

const inputOf = (f: Fixture, over: Partial<QueueSendInput> = {}): QueueSendInput => ({
  intentId: ids.next(),
  draftId: f.draft.draftId,
  authorizationId: f.authorizationId,
  actor: actor(),
  expectedVersion: 1,
  contentHash: f.draft.contentHash,
  seal: (facts) => seal(facts.intentId),
  ...over,
});

/** CMD063 in one transaction of the person at `instant`: the accessor's queueSend, then the unit's event and outbox record. */
function queueAt(f: Fixture, instant: string, over: Partial<QueueSendInput> = {}): Promise<QueuedSend> {
  const input = inputOf(f, over);
  return at(w.app, personOf(w.s.userId), instant, async (c) => {
    const q = await new PgOutreachSend(c, () => ids.next()).queueSend(input);
    await sendIntendedIn(c, { intentId: q.intentId, draft: f.draft, authorizationId: f.authorizationId });
    return q;
  });
}

/** A refusal: the call throws and the unit writes nothing. */
function refused(f: Fixture, instant: string, over: Partial<QueueSendInput> = {}): Promise<unknown> {
  const input = inputOf(f, over);
  return at(w.app, personOf(w.s.userId), instant, (c) => new PgOutreachSend(c, () => ids.next()).queueSend(input));
}

const outreach = <T>(instant: string, fn: (o: PgOutreachSend, c: Client) => Promise<T>): Promise<T> => at(w.outreach, {}, instant, (c) => fn(new PgOutreachSend(c, () => ids.next()), c));

const states = async (intentId: string): Promise<{ intent: string; draft: string; fence: string | null }> =>
  (await w.h.oracle.query<{ intent: string; draft: string; fence: string | null }>("SELECT i.state AS intent, d.state AS draft, i.claim_fence AS fence FROM kauro.outreach_send_intents i JOIN kauro.outreach_drafts d USING (draft_id) WHERE i.intent_id = $1", [intentId])).rows[0]!;

const intentRows = async (draftId: string): Promise<number> => (await w.h.oracle.query("SELECT 1 FROM kauro.outreach_send_intents WHERE draft_id = $1", [draftId])).rowCount ?? 0;

async function leaseAt(instant: string): Promise<{ resourceId: string; ownerId: string; fence: number }> {
  const resourceId = ids.next();
  const ownerId = ids.next();
  const r = await w.h.oracle.query<{ fence: string }>("SELECT fence FROM kauro.claim_lease('OUTBOX_DISPATCH', $1, $2, 120, $3, $4, NULL, NULL, $5)", [resourceId, ownerId, plus(instant, 3600), sha(`subject-${resourceId}`), instant]);
  return { resourceId, ownerId, fence: Number(r.rows[0]!.fence) };
}

const OK = (): "OK" => "OK";

/** Queues at slot+2 and claims at slot+10: the intent is SUBMITTING under the returned lease. */
async function submitting(f: Fixture): Promise<{ q: QueuedSend; lease: Awaited<ReturnType<typeof leaseAt>>; verdict: ClaimVerdict; claimedAt: string }> {
  const q = await queueAt(f, plus(f.slot, 2));
  const claimedAt = plus(f.slot, 10);
  const lease = await leaseAt(claimedAt);
  const verdict = await outreach(claimedAt, (o) => o.claim(q.intentId, lease, OK));
  return { q, lease, verdict, claimedAt };
}

describe("B12 L-SEND accessor: queueSend (CMD063)", () => {
  test("a seller's authorized draft becomes a QUEUED intent, the draft AUTHORIZED, with the sealed payload hash", async () => {
    const f = await fixture();
    const q = await queueAt(f, plus(f.slot, 2));
    assert.equal(q.state, "QUEUED");
    assert.equal(q.draftId, f.draft.draftId);
    assert.equal(q.payloadHash, seal(q.intentId));
    assert.equal(q.route, "GMAIL_API");
    assert.deepEqual(await states(q.intentId), { intent: "QUEUED", draft: "AUTHORIZED", fence: null });
  });

  test("a stale draft version is refused STALE_VERSION and writes nothing", async () => {
    const f = await fixture();
    await assert.rejects(refused(f, plus(f.slot, 2), { expectedVersion: 7 }), (e: unknown) => e instanceof DomainFailure && e.code === "STALE_VERSION");
    assert.equal(await intentRows(f.draft.draftId), 0);
  });

  test("a content hash other than the draft's binding is refused OUTREACH_GRANT_INVALID", async () => {
    const f = await fixture();
    await assert.rejects(refused(f, plus(f.slot, 2), { contentHash: sha("another") }), failure("OUTREACH_GRANT_INVALID"));
    assert.equal(await intentRows(f.draft.draftId), 0);
  });

  test("the transactional route carries no outreach: OUTREACH_ROUTE_FORBIDDEN", async () => {
    const resend = await sender(w, w.s.userId, { route: "RESEND_TRANSACTIONAL" });
    const slot = await nextSlot(w);
    const p = await prospectIn(w, w.s, freshDomain("resend"));
    const d = await draft(w, resend, p);
    // the grant exists (the accessor reads it before it judges); the route is what refuses
    const g = await grant(w, resend, [d], slot);
    const f: Fixture = { draft: d, authorizationId: g.authorizationId, slot };
    await assert.rejects(refused(f, plus(slot, 2)), failure("OUTREACH_ROUTE_FORBIDDEN"));
    assert.equal(await intentRows(d.draftId), 0);
  });

  test("a suppressed contact is refused PROSPECT_SUPPRESSED", async () => {
    const f = await fixture();
    await at(w.app, personOf(w.s.userId), f.slot, (c) => suppressionIn(c, w.s.userId, "CONTACT", f.draft.contactKey));
    await assert.rejects(refused(f, plus(f.slot, 2)), failure("PROSPECT_SUPPRESSED"));
    assert.equal(await intentRows(f.draft.draftId), 0);
  });

  test("an unconfigured compliance (the sealer answers null) is OUTREACH_COMPLIANCE_UNCONFIGURED", async () => {
    const f = await fixture();
    await assert.rejects(refused(f, plus(f.slot, 2), { seal: () => null }), failure("OUTREACH_COMPLIANCE_UNCONFIGURED"));
    assert.equal(await intentRows(f.draft.draftId), 0);
  });

  test("a draft already queued is refused OUTREACH_ALREADY_SENT (a second send of one draft)", async () => {
    const f = await fixture();
    await queueAt(f, plus(f.slot, 2));
    await assert.rejects(refused(f, plus(f.slot, 3), { expectedVersion: 1 }), (e: unknown) => e instanceof DomainFailure);
    assert.equal(await intentRows(f.draft.draftId), 1);
  });

  test("a follow-up without a first intent is refused with the cap reason FIRST_NOT_SENT", async () => {
    const f = await fixture(snd, "FOLLOW_UP");
    await assert.rejects(refused(f, plus(f.slot, 2)), (e: unknown) => {
      assert.ok(e instanceof OutreachRefusal, String(e));
      assert.equal(e.subReason, "FIRST_NOT_SENT");
      return true;
    });
    assert.equal(await intentRows(f.draft.draftId), 0);
  });

  test("a draft nobody of the caller's sees is NOT_AUTHORIZED, like one that does not exist", async () => {
    const f = await fixture();
    await assert.rejects(
      at(w.app, personOf(w.s2.userId), plus(f.slot, 2), (c) =>
        new PgOutreachSend(c, () => ids.next()).queueSend(inputOf(f, { actor: { kind: "SELLER", userId: w.s2.userId as UserId, sellerId: w.s2.sellerId as SellerId } })),
      ),
      (e: unknown) => e instanceof DomainFailure && e.code === "NOT_AUTHORIZED",
    );
    assert.equal(await intentRows(f.draft.draftId), 0);
  });
});

describe("B12 L-SEND accessor: claim (D2)", () => {
  test("a live intent under a live lease is ADMITTED: SUBMITTING under the fence, the draft too", async () => {
    const f = await fixture();
    const { q, lease, verdict } = await submitting(f);
    assert.equal(verdict.kind, "ADMITTED");
    if (verdict.kind !== "ADMITTED") return;
    assert.equal(verdict.fence, lease.fence);
    assert.equal(verdict.submission.intentId, q.intentId);
    assert.equal(verdict.submission.payloadHash, q.payloadHash);
    assert.equal(verdict.submission.route, "GMAIL_API");
    assert.deepEqual(await states(q.intentId), { intent: "SUBMITTING", draft: "SUBMITTING", fence: String(lease.fence) });
  });

  test("a claim under a fence the lease does not hold is LEASE_FENCED and writes nothing", async () => {
    const f = await fixture();
    const q = await queueAt(f, plus(f.slot, 2));
    const claimedAt = plus(f.slot, 10);
    const lease = await leaseAt(claimedAt);
    await assert.rejects(outreach(claimedAt, (o) => o.claim(q.intentId, { ...lease, fence: lease.fence + 5 }, OK)), failure("LEASE_FENCED"));
    assert.deepEqual(await states(q.intentId), { intent: "QUEUED", draft: "AUTHORIZED", fence: null });
  });

  test("a contact suppressed after the queue is REFUSED NOT_SENT and the draft follows (SUPPRESSED)", async () => {
    const f = await fixture();
    const q = await queueAt(f, plus(f.slot, 2));
    await at(w.app, personOf(w.s.userId), plus(f.slot, 5), (c) => suppressionIn(c, w.s.userId, "CONTACT", f.draft.contactKey));
    const claimedAt = plus(f.slot, 10);
    const lease = await leaseAt(claimedAt);
    const verdict = await outreach(claimedAt, (o) => o.claim(q.intentId, lease, OK));
    assert.equal(verdict.kind, "REFUSED");
    if (verdict.kind !== "REFUSED") return;
    assert.equal(verdict.state, "NOT_SENT");
    assert.deepEqual(await states(q.intentId), { intent: "NOT_SENT", draft: "SUPPRESSED", fence: null });
  });

  test("a payload that no longer hashes the same is REFUSED NOT_SENT and the draft returns to DRAFT", async () => {
    const f = await fixture();
    const q = await queueAt(f, plus(f.slot, 2));
    const claimedAt = plus(f.slot, 10);
    const lease = await leaseAt(claimedAt);
    const verdict = await outreach(claimedAt, (o) => o.claim(q.intentId, lease, () => "CHANGED"));
    assert.equal(verdict.kind, "REFUSED");
    assert.deepEqual(await states(q.intentId), { intent: "NOT_SENT", draft: "DRAFT", fence: null });
  });

  test("an intent that already left QUEUED answers GONE", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const again = await outreach(plus(claimedAt, 1), (o) => o.claim(q.intentId, lease, OK));
    assert.deepEqual(again, { kind: "GONE", state: "SUBMITTING" });
  });
});

describe("B12 L-SEND accessor: gate (D3) and record (D4)", () => {
  test("the start gate is open within 5 s of the claim and closed after, for the fence that claimed", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const early = await outreach(plus(claimedAt, 2), (o) => o.gate(q.intentId, lease.fence));
    assert.deepEqual(early, { state: "SUBMITTING", fenceMatches: true, open: true });
    const late = await outreach(plus(claimedAt, 9), (o) => o.gate(q.intentId, lease.fence));
    assert.equal(late.open, false);
    const other = await outreach(plus(claimedAt, 2), (o) => o.gate(q.intentId, lease.fence + 1));
    assert.equal(other.fenceMatches, false);
  });

  test("ACCEPTED: the intent and the draft are PROVIDER_ACCEPTED, a PROVIDER_ACCEPTED activity exists", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const state = await outreach(plus(claimedAt, 3), (o) => o.record(q.intentId, lease, { kind: "ACCEPTED", ref: "gmail-ref-1" }));
    assert.equal(state, "PROVIDER_ACCEPTED");
    assert.deepEqual(await states(q.intentId), { intent: "PROVIDER_ACCEPTED", draft: "PROVIDER_ACCEPTED", fence: String(lease.fence) });
    const a = await w.h.oracle.query("SELECT 1 FROM kauro.sales_activities WHERE intent_id = $1 AND kind = 'PROVIDER_ACCEPTED'", [q.intentId]);
    assert.equal(a.rowCount, 1);
  });

  test("UNCERTAIN: SEND_UNCERTAIN on the intent and the draft", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const state = await outreach(plus(claimedAt, 3), (o) => o.record(q.intentId, lease, { kind: "UNCERTAIN", cause: "TIMEOUT" }));
    assert.equal(state, "SEND_UNCERTAIN");
    assert.deepEqual(await states(q.intentId), { intent: "SEND_UNCERTAIN", draft: "SEND_UNCERTAIN", fence: String(lease.fence) });
  });

  test("a definitive 400 is NOT_SENT without a warning for this intent's draft", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const answer: OutcomeAnswer = { kind: "REJECTED_DEFINITIVE", status: 400 };
    assert.equal(await outreach(plus(claimedAt, 3), (o) => o.record(q.intentId, lease, answer)), "NOT_SENT(PROVIDER_REJECTED:400)");
    assert.deepEqual(await states(q.intentId), { intent: "NOT_SENT", draft: "DRAFT", fence: String(lease.fence) });
  });

  test("GAP-DI-7b: the same owner's ACCEPTED after D5 (fence unchanged) is the edge SEND_UNCERTAIN -> PROVIDER_ACCEPTED with its reference; the replay is a no-op and writes no evidence", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const recoveredAt = plus(claimedAt, 40);
    assert.equal(await outreach(recoveredAt, async (o) => o.recover(q.intentId, await leaseAt(recoveredAt))), "SEND_UNCERTAIN");
    const late = await outreach(plus(recoveredAt, 2), (o) => o.record(q.intentId, lease, { kind: "ACCEPTED", ref: "gmail-late" }));
    assert.equal(late, "PROVIDER_ACCEPTED");
    assert.deepEqual(await states(q.intentId), { intent: "PROVIDER_ACCEPTED", draft: "PROVIDER_ACCEPTED", fence: String(lease.fence) });
    const again = await outreach(plus(recoveredAt, 3), (o) => o.record(q.intentId, lease, { kind: "ACCEPTED", ref: "gmail-late" }));
    assert.equal(again, "NOOP");
    const ev = await w.h.oracle.query("SELECT 1 FROM kauro.outreach_send_evidence WHERE intent_id = $1", [q.intentId]);
    assert.equal(ev.rowCount, 0);
  });

  test("D4b: an ACCEPTED answer of a fenced-out unit is evidence (one row per fence) and moves SEND_UNCERTAIN to PROVIDER_ACCEPTED; its replay is a no-op", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const recoveredAt = plus(claimedAt, 40);
    assert.equal(await outreach(recoveredAt, async (o) => o.recover(q.intentId, await leaseAt(recoveredAt))), "SEND_UNCERTAIN");
    const fenced = { ...lease, fence: lease.fence + 5 };
    const late = await outreach(plus(recoveredAt, 2), (o) => o.record(q.intentId, fenced, { kind: "ACCEPTED", ref: "gmail-late" }));
    assert.equal(late, "PROVIDER_ACCEPTED");
    assert.deepEqual((await states(q.intentId)).intent, "PROVIDER_ACCEPTED");
    assert.equal(await outreach(plus(recoveredAt, 3), (o) => o.record(q.intentId, fenced, { kind: "ACCEPTED", ref: "gmail-late" })), "NOOP");
    const ev = await w.h.oracle.query("SELECT 1 FROM kauro.outreach_send_evidence WHERE intent_id = $1 AND fence = $2", [q.intentId, fenced.fence]);
    assert.equal(ev.rowCount, 1);
  });
});

describe("B12 L-SEND accessor: recovery (D5)", () => {
  test("an intent is due only past uncertain_after (submitted_at + 37 s) and recovery moves it to SEND_UNCERTAIN, never back to QUEUED", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    assert.ok(!(await outreach(plus(claimedAt, 36), (o) => o.dueForRecovery(100))).includes(q.intentId));
    assert.equal(await outreach(plus(claimedAt, 36), (o) => o.recover(q.intentId, lease)), "UNTOUCHED");
    assert.equal((await states(q.intentId)).intent, "SUBMITTING");
    assert.ok((await outreach(plus(claimedAt, 38), (o) => o.dueForRecovery(100))).includes(q.intentId));
    assert.equal(await outreach(plus(claimedAt, 38), (o) => o.recover(q.intentId, lease)), "SEND_UNCERTAIN");
    assert.deepEqual(await states(q.intentId), { intent: "SEND_UNCERTAIN", draft: "SEND_UNCERTAIN", fence: String(lease.fence) });
  });

  test("a send answered meanwhile is untouched by recovery", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    await outreach(plus(claimedAt, 3), (o) => o.record(q.intentId, lease, { kind: "ACCEPTED", ref: "gmail-ok" }));
    assert.equal(await outreach(plus(claimedAt, 50), (o) => o.recover(q.intentId, lease)), "UNTOUCHED");
    assert.equal((await states(q.intentId)).intent, "PROVIDER_ACCEPTED");
  });

  test("the event of an intent is not the outreach service's to read: it takes the intent from the outbox delivery it claimed (kauro_outreach holds no privilege on domain_events)", async () => {
    const f = await fixture();
    const q = await queueAt(f, plus(f.slot, 2));
    const ev = await w.h.oracle.query<{ event_id: string }>("SELECT event_id FROM kauro.domain_events WHERE aggregate_id = $1 AND event_type = 'outreach.send_intended.v1'", [q.intentId]);
    assert.equal(ev.rowCount, 1);
    await assert.rejects(
      outreach(plus(f.slot, 3), (_o, c) => c.query("SELECT aggregate_id FROM kauro.domain_events WHERE event_id = $1", [ev.rows[0]!.event_id])),
      (e: unknown) => (e as { code?: string }).code === "42501",
    );
  });
});

// A provider warning (403/429) pauses the person's outreach pending diagnosis (KC034), for every later test of the world: this one runs last.
describe("B12 L-SEND accessor: provider warning", () => {
  test("a definitive 429 is NOT_SENT, the draft returns to DRAFT and a provider warning is written", async () => {
    const f = await fixture();
    const { q, lease, claimedAt } = await submitting(f);
    const state = await outreach(plus(claimedAt, 3), (o) => o.record(q.intentId, lease, { kind: "REJECTED_DEFINITIVE", status: 429 }));
    // the recorded state carries its outcome reason, as the dispatcher and the api cells read it (state(reason))
    assert.equal(state, "NOT_SENT(PROVIDER_REJECTED:429)");
    assert.deepEqual(await states(q.intentId), { intent: "NOT_SENT", draft: "DRAFT", fence: String(lease.fence) });
    const warn = await w.h.oracle.query("SELECT 1 FROM kauro.outreach_provider_warnings WHERE intent_id = $1", [q.intentId]);
    assert.ok((warn.rowCount ?? 0) >= 1);
  });
});
