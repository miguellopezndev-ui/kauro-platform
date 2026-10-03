// CMD052 ApproveCommissionPayout — POST /api/v1/sales/statements/{statementId}/approve-payout — KAURO_OWNER with a fresh step-up — scope
// CORPORATE (package B10, mandate B10-STATEMENTS-PAYOUTS; docs/design/B10-case-map.md R2-102, R2-103, CMD052-OK, CMD052-DENY, CMD052-RACE;
// design §7, §10, §12; decision D10-PAY-1; 15 "Commission integration"; policy minimumPayoutCents 0, feeBearer KAURO; example 22). The real
// route, the commercial authorizer, B06's step-up verifier, the statement adapters and PostgreSQL 17 through the runtime login roles; the
// superuser only reads. Statements are issued by the real CMD051 route of the commission service; bank-available cash is a settlement
// observation of the payment service with bank evidence (B09). No transfer is made: the payout adapter is B15's.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PeriodCloseView } from "@kauro/application";
import { recordHold } from "@kauro/persistence/testing";
import type { UserId } from "@kauro/domain";
import {
  approvePayout,
  bankCash,
  changeDestination,
  claimedCents,
  closeMonth,
  eligibleLines,
  intentOf,
  rows,
  seller,
  statementsOfSeller,
  statementsWorld,
  verifyDestination,
  type LineSpec,
  type StatementsWorld,
} from "./statements-support.js";
import { SimulatedCrash, asProblem, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Reply } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;

type Seller = Awaited<ReturnType<typeof seller>>;

/** Sellers with their lines, a month closed through CMD051: each seller's ISSUED statement. */
async function issued(month: string, sellers: ReadonlyArray<{ readonly s: Seller; readonly lines: ReadonlyArray<LineSpec>; readonly hold?: bigint }>): Promise<Map<string, { statementId: string; version: number; payable: bigint; lineIds: string[] }>> {
  const lines = new Map<string, string[]>();
  for (const { s, lines: spec, hold } of sellers) {
    const sold = await eligibleLines(sw, `${s.sellerId.slice(-6)} ${month}`, s, WHOLE, spec);
    lines.set(s.sellerId, sold.lines.map((l) => l.lineId));
    if (hold !== undefined) await recordHold(sw.h, { ownerUserId: sw.owner.userId as UserId, lineId: sold.lines[0]!.lineId, amountCents: hold, reason: "SELLER_DISPUTE" });
  }
  const { periodId, reply } = await closeMonth(sw, month);
  completed<PeriodCloseView>(reply, 200);
  const out = new Map<string, { statementId: string; version: number; payable: bigint; lineIds: string[] }>();
  for (const { s } of sellers) {
    const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId);
    assert.ok(st !== undefined, "the close issued the seller's statement");
    out.set(s.sellerId, { statementId: st.statement_id, version: Number(st.version), payable: BigInt(st.payable_cents), lineIds: lines.get(s.sellerId)! });
  }
  return out;
}

/** Bank-available cash covering what live intents claim plus `cents` more. */
async function cashFor(cents: bigint): Promise<void> {
  await bankCash(sw, (await claimedCents(sw)) + cents);
}

async function body(st: { readonly version: number }, payeeRef: string): Promise<{ expectedVersion: number; payeeRef: string; authorizationRef: string }> {
  return { expectedVersion: st.version, payeeRef, authorizationRef: await sw.w.stepUp(sw.owner) };
}

const statementState = async (statementId: string): Promise<[string, string]> => {
  const r = await rows<{ state: string; version: string }>(sw, "SELECT state, version::text FROM kauro.commission_statements WHERE statement_id = $1", [statementId]);
  return [r[0]!.state, r[0]!.version];
};
const intentCount = async (statementId: string): Promise<number> => Number((await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_intents WHERE statement_id = $1", [statementId]))[0]!.n);

// --- CMD052-OK ----------------------------------------------------------------------------------------------------------------------------

test("OK: the owner with a fresh step-up approves an ISSUED statement's payable to the seller's VERIFIED destination with bank-available cash — 200 with one AUTHORIZED intent of exactly the payable, fee bearer KAURO, the destination's version and digest and reference kauro-payout-<intentId>, the statement APPROVED, and no transfer", async () => {
  const s = await seller(sw, "cmd052-ok", WHOLE);
  const st = (await issued("2026-09", [{ s, lines: [{ basisCents: 12_345n, poolCents: 12_345n }] }])).get(s.sellerId)!;
  assert.equal(st.payable, 12_345n);
  await cashFor(st.payable);
  const providerCalls = sw.pw.paypal.calls.length;
  const payoutCalls = sw.payouts.calls.length;

  const done = completed<PayoutIntentView>(await approvePayout(sw, st.statementId, await body(st, s.destinationId)), 200);
  const intent = await intentOf(sw, st.statementId);
  assert.deepEqual(done.data, {
    intentId: intent.intentId,
    statementId: st.statementId,
    state: "AUTHORIZED",
    amountCents: "12345",
    currency: "USD",
    feeBearer: "KAURO",
    reference: `kauro-payout-${intent.intentId}`,
    destinationVersion: 1,
    authorizedAt: done.data.authorizedAt,
    version: 1,
    statementState: "APPROVED",
  });
  assert.equal(done.version, 1);
  // the stored intent: exactly the payable, nothing deducted, bound to the destination's version and digest
  assert.deepEqual([intent.state, intent.amount, intent.feeBearer, intent.currency, intent.destinationId, intent.destinationVersion, intent.destinationDigest, intent.reference], [
    "AUTHORIZED",
    12_345n,
    "KAURO",
    "USD",
    s.destinationId,
    1,
    s.destinationDigest,
    `kauro-payout-${intent.intentId}`,
  ]);
  assert.ok(!JSON.stringify(done.data).includes(s.destinationDigest), "the view never carries the destination digest");
  assert.deepEqual(await statementState(st.statementId), ["APPROVED", String(st.version + 1)]);
  // no transfer: no provider is called, not even the payout evidence verifier
  assert.equal(sw.pw.paypal.calls.length, providerCalls);
  assert.equal(sw.payouts.calls.length, payoutCalls);
  assert.deepEqual((await sw.w.securityEvents("CMD052")).slice(-1).map((f) => [f.outcome, f.reason]), [["ALLOW", "STEP_UP_FRESH"]]);
});

// --- R2-102 ---------------------------------------------------------------------------------------------------------------------------------

test("R2-102: ApproveCommissionPayout authorizes exactly the undisputed payable of that statement; the held cents are in no intent", async () => {
  const s = await seller(sw, "cmd052-r102", WHOLE);
  // example 21: the contested USD10 line held whole, the unrelated USD500 eligible
  const st = (await issued("2026-08", [{ s, lines: [{ basisCents: 1_000n, poolCents: 1_000n }, { basisCents: 50_000n, poolCents: 50_000n }], hold: 1_000n }])).get(s.sellerId)!;
  const held = await rows<{ held_cents: string; payable_cents: string }>(sw, "SELECT held_cents::text, payable_cents::text FROM kauro.commission_statements WHERE statement_id = $1", [st.statementId]);
  assert.deepEqual(held, [{ held_cents: "1000", payable_cents: "50000" }]);
  await cashFor(st.payable);
  const done = completed<PayoutIntentView>(await approvePayout(sw, st.statementId, await body(st, s.destinationId)), 200);
  assert.equal(done.data.amountCents, "50000");
  const intents = await rows<{ amount_cents: string }>(sw, "SELECT amount_cents::text FROM kauro.payout_intents WHERE statement_id = $1", [st.statementId]);
  assert.deepEqual(intents, [{ amount_cents: "50000" }], "the held 1000 cents are in no intent");
  assert.deepEqual((await rows<{ state: string }>(sw, "SELECT state FROM kauro.commission_lines WHERE line_id = $1", [st.lineIds[0]]))[0]!.state, "ELIGIBLE", "the contested line waits for its review");
});

// --- R2-103 ---------------------------------------------------------------------------------------------------------------------------------

test("R2-103 (example 22): a seller's bank change just before payout leaves ApproveCommissionPayout 409 PAYEE_UNVERIFIED for the new destination, and an intent authorized earlier keeps its original destination version and digest while the change is pending", async () => {
  const s = await seller(sw, "cmd052-r103", WHOLE);
  // an earlier statement approved to the VERIFIED destination version 1
  const earlier = (await issued("2026-07", [{ s, lines: [{ basisCents: 8_000n, poolCents: 8_000n }] }])).get(s.sellerId)!;
  await cashFor(earlier.payable);
  completed<PayoutIntentView>(await approvePayout(sw, earlier.statementId, await body(earlier, s.destinationId)), 200);
  const bound = await intentOf(sw, earlier.statementId);
  assert.deepEqual([bound.destinationId, bound.destinationVersion, bound.destinationDigest], [s.destinationId, 1, s.destinationDigest]);

  // the next statement; the seller changes its bank just before payout (version 2, pending the owner's verification)
  const next = (await issued("2026-06", [{ s, lines: [{ basisCents: 9_000n, poolCents: 9_000n }] }])).get(s.sellerId)!;
  const changed = await changeDestination(sw, s);
  assert.equal(changed.destinationVersion, 2);
  await cashFor(next.payable);
  const refused = await approvePayout(sw, next.statementId, await body(next, changed.destinationId));
  assert.equal(outcome(sw.w, refused), "409 PRECONDITION_FAILED PAYEE_UNVERIFIED");
  // nor to the old one while the change is pending: the calendar deadline authorizes no payout around the seller's change
  assert.equal(outcome(sw.w, await approvePayout(sw, next.statementId, await body(next, s.destinationId))), "409 PRECONDITION_FAILED PAYEE_UNVERIFIED");
  assert.deepEqual(await statementState(next.statementId), ["ISSUED", String(next.version)]);
  assert.equal(await intentCount(next.statementId), 0);
  // the intent authorized earlier keeps its original binding: it is never rewritten to the new destination
  const kept = await intentOf(sw, earlier.statementId);
  assert.deepEqual([kept.intentId, kept.state, kept.destinationId, kept.destinationVersion, kept.destinationDigest], [bound.intentId, "AUTHORIZED", s.destinationId, 1, s.destinationDigest]);
  assert.notEqual(kept.destinationDigest, changed.destinationDigest);
});

// --- CMD052-DENY ----------------------------------------------------------------------------------------------------------------------------

test("DENY: an agency member's tenant session is a foreign scope and the seller a wrong role (403); then one missing prerequisite at a time — an unverified or superseded payee PAYEE_UNVERIFIED, a zero payable NOTHING_PAYABLE, cash short of the payable and the live intents FUNDS_UNAVAILABLE, no fresh step-up — and a one-cent payable is approved in full with no fee deducted", async () => {
  const s = await seller(sw, "cmd052-deny", WHOLE);
  const z = await seller(sw, "cmd052-deny-zero", WHOLE);
  const c = await seller(sw, "cmd052-deny-cent", WHOLE);
  const statements = await issued("2026-05", [
    { s, lines: [{ basisCents: 7_000n, poolCents: 7_000n }] },
    { s: z, lines: [{ basisCents: 2_000n, poolCents: 2_000n, state: "ACCRUED" }] },
    { s: c, lines: [{ basisCents: 1n, poolCents: 1n }] },
  ]);
  const st = statements.get(s.sellerId)!;
  const probe = async (what: string, statementId: string, reply: Promise<Reply>, expected: string): Promise<void> => {
    const before = await statementState(statementId);
    assert.equal(outcome(sw.w, await reply), expected, what);
    assert.deepEqual(await statementState(statementId), before, `${what}: the statement is left as it was`);
    assert.equal(await intentCount(statementId), 0, `${what}: no intent`);
  };
  await cashFor(st.payable);

  // an agency member's tenant session and the seller itself: the same refusal, before any fact is read
  const denials = (await sw.w.securityEvents("CMD052")).length;
  await probe("an agency member", st.statementId, approvePayout(sw, st.statementId, await body(st, s.destinationId), { token: sw.w.owner.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await probe("the seller", st.statementId, approvePayout(sw, st.statementId, await body(st, s.destinationId), { token: s.person.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await sw.w.securityEvents("CMD052")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);

  // no fresh step-up
  await probe("a stale step-up", st.statementId, approvePayout(sw, st.statementId, { ...(await body(st, s.destinationId)), authorizationRef: await sw.w.stepUp(sw.owner, "STALE") }), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  await probe("another person's step-up", st.statementId, approvePayout(sw, st.statementId, { ...(await body(st, s.destinationId)), authorizationRef: await sw.w.stepUp(sw.w.owner) }), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");

  // an unverified payee (a change pending verification), then a superseded one (the change verified)
  const changed = await changeDestination(sw, s);
  await probe("an unverified payee", st.statementId, approvePayout(sw, st.statementId, await body(st, changed.destinationId)), "409 PRECONDITION_FAILED PAYEE_UNVERIFIED");
  await verifyDestination(sw, changed.destinationId, s.destinationId);
  await probe("a superseded payee", st.statementId, approvePayout(sw, st.statementId, await body(st, s.destinationId)), "409 PRECONDITION_FAILED PAYEE_UNVERIFIED");
  await probe("another seller's payee", st.statementId, approvePayout(sw, st.statementId, await body(st, z.destinationId)), "409 PRECONDITION_FAILED PAYEE_UNVERIFIED");

  // a zero payable: the statement of a seller whose only line awaits its completion
  const zero = statements.get(z.sellerId)!;
  assert.equal(zero.payable, 0n);
  await probe("a zero payable", zero.statementId, approvePayout(sw, zero.statementId, await body(zero, z.destinationId)), "409 PRECONDITION_FAILED NOTHING_PAYABLE");

  // cash short of the payable and the live intents by one cent
  await bankCash(sw, (await claimedCents(sw)) + st.payable - 1n);
  await probe("cash one cent short", st.statementId, approvePayout(sw, st.statementId, await body(st, changed.destinationId)), "409 PRECONDITION_FAILED FUNDS_UNAVAILABLE");
  // an unknown statement and a stale version
  assert.equal(outcome(sw.w, await approvePayout(sw, ids.next(), await body(st, changed.destinationId))), "404 NOT_FOUND -");
  const stale = await approvePayout(sw, st.statementId, await body({ version: st.version + 7 }, changed.destinationId));
  assert.equal(outcome(sw.w, stale), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(sw.w, stale).current, { version: st.version, state: "ISSUED" });

  // the same request, with cash and the verified destination, is approved
  await cashFor(st.payable);
  assert.equal(completed<PayoutIntentView>(await approvePayout(sw, st.statementId, await body(st, changed.destinationId)), 200).data.destinationVersion, 2);

  // a one-cent payable is approved in full: no minimum beyond zero, no fee deducted (fee bearer KAURO)
  const cent = statements.get(c.sellerId)!;
  assert.equal(cent.payable, 1n);
  await cashFor(1n);
  const one = completed<PayoutIntentView>(await approvePayout(sw, cent.statementId, await body(cent, c.destinationId)), 200);
  assert.deepEqual([one.data.amountCents, one.data.feeBearer, one.data.statementState], ["1", "KAURO", "APPROVED"]);
  assert.deepEqual((await intentOf(sw, cent.statementId)).amount, 1n);
});

// --- CMD052-RACE ----------------------------------------------------------------------------------------------------------------------------

test("RACE: an identical retry replays the 200, the same key with another payeeRef is 409 IDEMPOTENCY_CONFLICT, two approvals of one statement yield one intent and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the statement ISSUED with no intent", async () => {
  const r = await seller(sw, "cmd052-race", WHOLE);
  const t = await seller(sw, "cmd052-race-two", WHOLE);
  const v = await seller(sw, "cmd052-race-crash", WHOLE);
  const statements = await issued("2026-04", [
    { s: r, lines: [{ basisCents: 3_000n, poolCents: 3_000n }] },
    { s: t, lines: [{ basisCents: 4_000n, poolCents: 4_000n }] },
    { s: v, lines: [{ basisCents: 5_000n, poolCents: 5_000n }] },
  ]);
  await cashFor(12_000n);

  // an identical retry replays byte for byte and authorizes nothing again; the same key with another payeeRef is another request
  const st = statements.get(r.sellerId)!;
  const key = freshKey("cmd052-race");
  const request = await body(st, r.destinationId);
  const first = await approvePayout(sw, st.statementId, request, { key });
  completed<PayoutIntentView>(first, 200);
  const replay = await approvePayout(sw, st.statementId, request, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(await intentCount(st.statementId), 1);
  assert.equal(outcome(sw.w, await approvePayout(sw, st.statementId, { ...request, payeeRef: t.destinationId }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await sw.w.journal(key))?.state, "COMMITTED");

  // two approvals of one statement: the first holds its row until COMMIT; the second waits for it (observed), finds its version moved
  const racing = statements.get(t.sellerId)!;
  const hold = sw.w.holds.arm("journal.commit");
  const winner = approvePayout(sw, racing.statementId, await body(racing, t.destinationId));
  await hold.reached;
  const loser = approvePayout(sw, racing.statementId, await body(racing, t.destinationId));
  try {
    await waitForApiLockWait(sw.w, "FROM kauro.commission_statements");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<PayoutIntentView>(won, 200);
  assert.equal(outcome(sw.w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(sw.w, lost).current, { version: racing.version + 1, state: "APPROVED" });
  assert.equal(await intentCount(racing.statementId), 1, "one intent");

  // a crash at the intent/commit boundary: nothing is committed; the statement stays ISSUED with no intent; the same key approves it after
  const crashing = statements.get(v.sellerId)!;
  const crashKey = freshKey("cmd052-crash");
  const crashBody = await body(crashing, v.destinationId);
  sw.w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  assert.equal(outcome(sw.w, await approvePayout(sw, crashing.statementId, crashBody, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await statementState(crashing.statementId), ["ISSUED", String(crashing.version)]);
  assert.equal(await intentCount(crashing.statementId), 0);
  assert.equal(await sw.w.journal(crashKey), null);
  completed<PayoutIntentView>(await approvePayout(sw, crashing.statementId, crashBody, { key: crashKey }), 200);
  assert.equal(await intentCount(crashing.statementId), 1);
});
