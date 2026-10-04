// CMD053 ReconcileCommissionPayout — POST /api/v1/sales/statements/{statementId}/reconcile-payout — FINANCE_SERVICE — scope STORED_OPERATION
// (package B10, mandate B10-STATEMENTS-PAYOUTS; docs/design/B10-case-map.md R2-103, CMD053-OK, CMD053-DENY, CMD053-RACE; design §7, §10, §12;
// decision D10-PAY-2; registry "Submitting a transfer is not proof the seller received it"; example 22). The real service route, the
// commercial authorizer, the commission group's units of work and PostgreSQL 17 through the runtime login roles; the superuser only reads.
// The bank's or payout provider's evidence is the labelled contract fake of PayoutEvidenceVerifier (CONTRACT_FAKE, SIMULATED), scripted per
// stored reference: it decides the asserted clauses, so these rows are SIMULATED. Statements are issued by CMD051 and approved by CMD052
// through their real routes. Interleavings are held at named points and every wait is observed in pg_stat_activity; nothing sleeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { PayoutIntentView, PayoutReconciliationView, PeriodCloseView } from "@kauro/application";
import { waitForLockWait } from "@kauro/persistence/testing";
import {
  COMMISSION_APPLICATION_NAME,
  ServiceCrash,
  ZONE,
  approvePayout,
  bankCash,
  changeDestination,
  claimedCents,
  closeMonth,
  commissionToken,
  eligibleLines,
  intentOf,
  reconcilePayout,
  rows,
  scriptEvidence,
  seller,
  statementsOfSeller,
  statementsWorld,
  type StatementsWorld,
} from "./statements-support.js";
import { completed, freshKey, ids, outcome, replayTextOf } from "./support.js";

let sw: StatementsWorld;
before(async () => {
  sw = await statementsWorld();
});
after(async () => {
  await sw.stop();
});

const WHOLE = { firstBps: 10_000, repeatBps: 10_000 } as const;
const SERVICE_POOL = `${COMMISSION_APPLICATION_NAME}-service`;

type Seller = Awaited<ReturnType<typeof seller>>;
interface Approved {
  readonly statementId: string;
  readonly lineIds: ReadonlyArray<string>;
  readonly payable: bigint;
  readonly intent: Awaited<ReturnType<typeof intentOf>>;
}

/** Each seller's line on a purchase, the month closed through CMD051 and each statement approved through CMD052 to the seller's VERIFIED destination. */
async function approved(month: string, sellers: ReadonlyArray<{ readonly s: Seller; readonly cents: bigint }>): Promise<Map<string, Approved>> {
  const lines = new Map<string, string[]>();
  for (const { s, cents } of sellers) lines.set(s.sellerId, (await eligibleLines(sw, `${s.sellerId.slice(-6)} ${month}`, s, WHOLE, [{ basisCents: cents, poolCents: cents }])).lines.map((l) => l.lineId));
  const { periodId, reply } = await closeMonth(sw, month);
  completed<PeriodCloseView>(reply, 200);
  const out = new Map<string, Approved>();
  for (const { s } of sellers) {
    const st = (await statementsOfSeller(sw, s.sellerId)).find((x) => x.period_id === periodId)!;
    await bankCash(sw, (await claimedCents(sw)) + BigInt(st.payable_cents));
    completed<PayoutIntentView>(await approvePayout(sw, st.statement_id, { expectedVersion: Number(st.version), payeeRef: s.destinationId, authorizationRef: await sw.w.stepUp(sw.owner) }), 200);
    out.set(s.sellerId, { statementId: st.statement_id, lineIds: lines.get(s.sellerId)!, payable: BigInt(st.payable_cents), intent: await intentOf(sw, st.statement_id) });
  }
  return out;
}

const facts = (a: Approved) => ({ reference: a.intent.reference, destinationDigest: a.intent.destinationDigest, amountCents: a.intent.amount, currency: a.intent.currency });

/** The rows a reconciliation may change: the intent, the statement and the statement's lines with their paid cents. */
async function state(a: Approved): Promise<{ intent: string; evidence: string | null; statement: string; paidHash: string | null; lines: string[]; reconciliations: number }> {
  const intent = await rows<{ state: string; evidence_hash: string | null }>(sw, "SELECT state, evidence_hash FROM kauro.payout_intents WHERE intent_id = $1", [a.intent.intentId]);
  const statement = await rows<{ state: string; payout_evidence_hash: string | null }>(sw, "SELECT state, payout_evidence_hash FROM kauro.commission_statements WHERE statement_id = $1", [a.statementId]);
  const lines = await rows<{ line_id: string; state: string; paid_cents: string | null }>(sw, "SELECT line_id, state, paid_cents::text FROM kauro.commission_lines WHERE line_id = ANY ($1::uuid[]) ORDER BY line_id", [[...a.lineIds]]);
  const recorded = await rows<{ n: string }>(sw, "SELECT count(*)::text AS n FROM kauro.payout_reconciliations WHERE intent_id = $1", [a.intent.intentId]);
  return {
    intent: intent[0]!.state,
    evidence: intent[0]!.evidence_hash,
    statement: statement[0]!.state,
    paidHash: statement[0]!.payout_evidence_hash,
    lines: lines.map((l) => `${l.state}:${l.paid_cents ?? "-"}`),
    reconciliations: Number(recorded[0]!.n),
  };
}

const dateIn = (instant: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));

// --- CMD053-OK ------------------------------------------------------------------------------------------------------------------------------

test("OK: the finance service reconciles an intent with SETTLED evidence from the payout-evidence fake matching reference, destination digest, amount and currency — 200 with the intent SETTLED, the statement PAID with the evidence hash and its lines PAID; FAILED or RETURNED evidence keeps the intent FAILED or RETURNED, the lines HELD PAYOUT_FAILED with a review date and the statement superseded by its correcting statement (CORRECTED, D10-GAP-12)", async () => {
  const settled = await seller(sw, "cmd053-ok-settled", WHOLE);
  const failed = await seller(sw, "cmd053-ok-failed", WHOLE);
  const returned = await seller(sw, "cmd053-ok-returned", WHOLE);
  const all = await approved("2026-09", [
    { s: settled, cents: 21_000n },
    { s: failed, cents: 22_000n },
    { s: returned, cents: 23_000n },
  ]);
  const calls = sw.payouts.calls.length;

  // SETTLED: the intent SETTLED with the evidence, the statement PAID with its hash, each line PAID at its item's cents
  const a = all.get(settled.sellerId)!;
  const evidence = sw.payouts.matching(facts(a), "SETTLED");
  const ref = scriptEvidence(sw, evidence);
  const done = completed<PayoutReconciliationView>(await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: ref }), 200);
  assert.deepEqual(
    [done.data.intentId, done.data.intentState, done.data.statementState, done.data.payoutEvidenceHash, done.data.settledAt, done.data.linesPaid, done.data.linesHeld],
    [a.intent.intentId, "SETTLED", "PAID", evidence.evidenceHash, evidence.observedAt, 1, 0],
  );
  assert.deepEqual(await state(a), { intent: "SETTLED", evidence: evidence.evidenceHash, statement: "PAID", paidHash: evidence.evidenceHash, lines: ["PAID:21000"], reconciliations: 1 });

  // FAILED and RETURNED: the intent kept so, the statement payable again, its lines held for review with the reason PAYOUT_FAILED
  for (const [s, status] of [[failed, "FAILED"], [returned, "RETURNED"]] as const) {
    const x = all.get(s.sellerId)!;
    const e = sw.payouts.matching(facts(x), status);
    const r = completed<PayoutReconciliationView>(await reconcilePayout(sw, x.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, e) }), 200);
    assert.deepEqual([r.data.intentState, r.data.statementState, r.data.linesPaid, r.data.linesHeld, r.data.payoutEvidenceHash], [status, "CORRECTED", 0, 1, undefined]);
    assert.match(r.data.reviewOn ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(await state(x), { intent: status, evidence: e.evidenceHash, statement: "CORRECTED", paidHash: null, lines: ["HELD:-"], reconciliations: 1 });
    const holds = await rows<{ reason: string; amount_cents: string; review_at: Date; state: string }>(sw, "SELECT reason, amount_cents::text, review_at, state FROM kauro.commission_holds WHERE line_id = $1", [x.lineIds[0]]);
    assert.deepEqual(holds.map((h) => [h.reason, h.amount_cents, h.state, dateIn(h.review_at.toISOString())]), [["PAYOUT_FAILED", String(x.payable), "OPEN", r.data.reviewOn]]);
    const line = await rows<{ held_reason: string | null }>(sw, "SELECT h.reason AS held_reason FROM kauro.commission_holds h WHERE h.line_id = $1 AND h.state = 'OPEN'", [x.lineIds[0]]);
    assert.equal(line[0]!.held_reason, "PAYOUT_FAILED");
  }
  // the fake's log: one verification per stored reference, outside any transaction
  assert.deepEqual(sw.payouts.calls.slice(calls).map((c) => c.operation), ["VERIFY", "VERIFY", "VERIFY"]);
});

// --- R2-103 ---------------------------------------------------------------------------------------------------------------------------------

test("R2-103 (example 22): evidence from the payout-evidence fake naming the new destination for an intent bound to the old one is PAYOUT_EVIDENCE_MISMATCH and changes nothing; only evidence for the bound destination settles it", async () => {
  const s = await seller(sw, "cmd053-r103", WHOLE);
  const a = (await approved("2026-08", [{ s, cents: 15_000n }])).get(s.sellerId)!;
  // the seller changes its bank during the uncertainty: the intent keeps its destination binding for reconciliation
  const changed = await changeDestination(sw, s);
  const before = await state(a);
  const calls = sw.payouts.calls.length;
  const toNew = sw.payouts.matching({ ...facts(a), destinationDigest: changed.destinationDigest as never }, "SETTLED");
  assert.equal(outcome(sw.w, await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, toNew) })), "409 PRECONDITION_FAILED PAYOUT_EVIDENCE_MISMATCH");
  assert.deepEqual(await state(a), before, "nothing changes: intent AUTHORIZED, statement APPROVED, lines PAYABLE");
  assert.deepEqual(before, { intent: "AUTHORIZED", evidence: null, statement: "APPROVED", paidHash: null, lines: ["PAYABLE:-"], reconciliations: 0 });
  // only evidence of the bound destination settles it
  const bound = sw.payouts.matching(facts(a), "SETTLED");
  assert.equal(bound.destinationDigest, s.destinationDigest);
  const done = completed<PayoutReconciliationView>(await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, bound) }), 200);
  assert.equal(done.data.intentState, "SETTLED");
  assert.deepEqual(await state(a), { intent: "SETTLED", evidence: bound.evidenceHash, statement: "PAID", paidHash: bound.evidenceHash, lines: ["PAID:15000"], reconciliations: 1 });
  assert.deepEqual(sw.payouts.calls.slice(calls).map((c) => c.operation), ["VERIFY", "VERIFY"]);
});

// --- CMD053-DENY ----------------------------------------------------------------------------------------------------------------------------

test("DENY: a user token or the commission service is a wrong service identity (403) and an intent of another statement a foreign scope (404); then one missing prerequisite at a time — evidence of another reference, destination or amount PAYOUT_EVIDENCE_MISMATCH, SUBMITTED-only evidence PAYOUT_NOT_SETTLED — nothing changes and the lines stay PAYABLE", async () => {
  const s = await seller(sw, "cmd053-deny", WHOLE);
  const o = await seller(sw, "cmd053-deny-other", WHOLE);
  const all = await approved("2026-07", [
    { s, cents: 11_000n },
    { s: o, cents: 12_000n },
  ]);
  const a = all.get(s.sellerId)!;
  const other = all.get(o.sellerId)!;
  const before = await state(a);
  assert.deepEqual(before.lines, ["PAYABLE:-"]);
  const probe = async (what: string, reply: Promise<Awaited<ReturnType<typeof reconcilePayout>>>, expected: string): Promise<void> => {
    assert.equal(outcome(sw.w, await reply), expected, what);
    assert.deepEqual(await state(a), before, `${what}: nothing changes`);
    assert.deepEqual(await state(other), { ...(await state(other)), intent: "AUTHORIZED", statement: "APPROVED" }, `${what}: the other statement neither`);
  };
  const settledRef = scriptEvidence(sw, sw.payouts.matching(facts(a), "SETTLED"));

  // wrong principals, recorded: a person's token, the commission service (it closes periods, it does not reconcile payouts)
  const denials = (await sw.w.securityEvents("CMD053")).length;
  await probe("a user token", reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: settledRef }, { token: sw.owner.token }), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  await probe("the commission service", reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: settledRef }, { token: commissionToken(sw, "commission-service") }), "403 NOT_AUTHORIZED SERVICE_NOT_PERMITTED");
  assert.deepEqual((await sw.w.securityEvents("CMD053")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "SERVICE_NOT_PERMITTED"], ["DENY", "SERVICE_NOT_PERMITTED"]]);
  // an intent of another statement is a foreign scope, answered as an id nobody holds; so is an unknown statement
  await probe("another statement's intent", reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching(facts(other), "SETTLED")) }), "404 NOT_FOUND -");
  await probe("an unknown statement", reconcilePayout(sw, ids.next(), { providerPayoutEvidenceRef: settledRef }), "404 NOT_FOUND -");

  // one missing prerequisite at a time: evidence of another reference, destination or amount; a submission only; no evidence at all
  for (const member of ["REFERENCE", "DESTINATION", "AMOUNT"] as const) {
    await probe(`evidence of another ${member.toLowerCase()}`, reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.mismatching(facts(a), "SETTLED", member)) }), "409 PRECONDITION_FAILED PAYOUT_EVIDENCE_MISMATCH");
  }
  await probe("SUBMITTED-only evidence", reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: scriptEvidence(sw, sw.payouts.matching(facts(a), "SUBMITTED")) }), "409 PRECONDITION_FAILED PAYOUT_NOT_SETTLED");
  await probe("evidence nobody stored", reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: ids.next() }), "409 PRECONDITION_FAILED PAYOUT_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(before, { intent: "AUTHORIZED", evidence: null, statement: "APPROVED", paidHash: null, lines: ["PAYABLE:-"], reconciliations: 0 });

  // the matching evidence, finally, settles it
  completed<PayoutReconciliationView>(await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: settledRef }), 200);
  assert.equal((await state(a)).statement, "PAID");
});

// --- CMD053-RACE ----------------------------------------------------------------------------------------------------------------------------

test("RACE: an identical retry replays the 200, the same key with other evidence is 409 IDEMPOTENCY_CONFLICT, two reconciliations of one intent yield one settlement with the wait observed, and a crash before COMMIT leaves the intent AUTHORIZED and the lines PAYABLE", async () => {
  const r = await seller(sw, "cmd053-race", WHOLE);
  const t = await seller(sw, "cmd053-race-two", WHOLE);
  const v = await seller(sw, "cmd053-race-crash", WHOLE);
  const all = await approved("2026-06", [
    { s: r, cents: 3_100n },
    { s: t, cents: 3_200n },
    { s: v, cents: 3_300n },
  ]);

  // an identical retry replays byte for byte; the same key with other evidence is another request
  const a = all.get(r.sellerId)!;
  const key = freshKey("cmd053-race");
  const ref = scriptEvidence(sw, sw.payouts.matching(facts(a), "SETTLED"));
  const first = await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: ref }, { key });
  completed<PayoutReconciliationView>(first, 200);
  const replay = await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: ref }, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  const otherRef = scriptEvidence(sw, sw.payouts.matching(facts(a), "FAILED"));
  assert.equal(outcome(sw.w, await reconcilePayout(sw, a.statementId, { providerPayoutEvidenceRef: otherRef }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.deepEqual(await state(a).then((x) => [x.intent, x.statement, x.reconciliations, x.lines]), ["SETTLED", "PAID", 1, ["PAID:3100"]]);
  assert.equal((await sw.w.journal(key))?.state, "COMMITTED");

  // two reconciliations of one intent: the first holds the statement's row until COMMIT; the second waits for it (observed) and finds the
  // same evidence applied — one settlement, the lines paid once
  const b = all.get(t.sellerId)!;
  const bRef = scriptEvidence(sw, sw.payouts.matching(facts(b), "SETTLED"));
  const hold = sw.serviceHolds.arm("CMD053");
  const winner = reconcilePayout(sw, b.statementId, { providerPayoutEvidenceRef: bRef });
  await hold.reached;
  const loser = reconcilePayout(sw, b.statementId, { providerPayoutEvidenceRef: bRef });
  try {
    await waitForLockWait(sw.h.oracle, SERVICE_POOL, "FROM kauro.commission_statements");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  assert.equal(completed<PayoutReconciliationView>(won, 200).data.intentState, "SETTLED");
  assert.equal(completed<PayoutReconciliationView>(lost, 200).data.intentState, "SETTLED");
  assert.deepEqual(await state(b), { intent: "SETTLED", evidence: (await state(b)).evidence, statement: "PAID", paidHash: (await state(b)).evidence, lines: ["PAID:3200"], reconciliations: 1 });

  // a crash at the intent/commit boundary: nothing is committed; the intent stays AUTHORIZED and the lines PAYABLE; the same key settles it after
  const c = all.get(v.sellerId)!;
  const crashKey = freshKey("cmd053-crash");
  const cRef = scriptEvidence(sw, sw.payouts.matching(facts(c), "SETTLED"));
  sw.serviceHolds.arm("CMD053", { fail: new ServiceCrash("before COMMIT") });
  assert.equal(outcome(sw.w, await reconcilePayout(sw, c.statementId, { providerPayoutEvidenceRef: cRef }, { key: crashKey })), "500 INTERNAL_ERROR -");
  assert.deepEqual(await state(c), { intent: "AUTHORIZED", evidence: null, statement: "APPROVED", paidHash: null, lines: ["PAYABLE:-"], reconciliations: 0 });
  assert.equal(await sw.w.journal(crashKey), null);
  completed<PayoutReconciliationView>(await reconcilePayout(sw, c.statementId, { providerPayoutEvidenceRef: cRef }, { key: crashKey }), 200);
  assert.deepEqual(await state(c).then((x) => [x.intent, x.statement, x.lines]), ["SETTLED", "PAID", ["PAID:3300"]]);
});
