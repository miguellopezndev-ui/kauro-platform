// CMD049 ActivateSeller — POST /api/v1/sales/sellers/{sellerId}/activate — KAURO_OWNER with a fresh step-up — scope CORPORATE (package B10,
// mandate B10-COMMANDS-SELLERS; docs/design/B10-case-map.md CMD049-OK, CMD049-DENY, CMD049-RACE; design §5, §10, §12; decisions D10-SELL-1
// and D10-SELL-3: "Activation requires a signed agreement, a legal review of the classification's substance, assessment, confidentiality,
// verified payment and tax facts, verified identity with MFA and the owner's step-up, repeated by the database (KC005)"). The real route,
// the real authorizers, B06's step-up verifier, the sales adapters and PostgreSQL 17 through the runtime login roles; the superuser only
// reads. The activation facts are written by the owner and the seller through their own sessions (sellers-support); nothing is faked.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SellerView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { recordActiveSeller, recordProspect } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { asPerson, candidateSeller, type CandidateGaps, type CandidateSeller } from "./sellers-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Reply } from "./support.js";

let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const activateUrl = (sellerId: string): string => `/api/v1/sales/sellers/${sellerId}/activate`;
const ownerId = (): UserId => pw.kora.userId as UserId;

async function activate(sellerId: string, body: Record<string, unknown>, options: { readonly token?: string; readonly key?: string } = {}): Promise<Reply> {
  return call(pw.w, { url: activateUrl(sellerId), token: options.token ?? pw.kora.token, agency: null, key: options.key ?? freshKey("cmd049"), body });
}

/** A CANDIDATE seller (and the person its token names) with the gaps asked for, and CMD049's body for it with a fresh step-up of the owner. */
async function candidate(label: string, gaps: CandidateGaps = {}): Promise<CandidateSeller & { readonly body: () => Promise<Record<string, unknown>> }> {
  const { w } = pw;
  const person = await w.person(`seller-${label}`);
  const c = await candidateSeller(w.h, ownerId(), label, gaps);
  assert.equal(person.userId, c.userId, "the seller is the person the token names");
  return { ...c, body: async () => ({ agreementId: c.agreementId, assessmentEvidenceRef: c.assessmentRef, assuranceProofRef: await w.stepUp(pw.kora) }) };
}

const sellerRow = async (sellerId: string) =>
  (await pw.w.h.oracle.query<{ state: string; version: string; agreement_id: string | null; activated_by_user_id: string | null; activation_proof_ref: string | null; activated_at: Date | null }>(
    "SELECT state, version::text, agreement_id, activated_by_user_id, activation_proof_ref, activated_at FROM kauro.sellers WHERE seller_id = $1",
    [sellerId],
  )).rows[0]!;

test("OK: the owner with a fresh step-up activates a CANDIDATE seller whose agreement is signed and whose legal review, assessment, confidentiality acceptance, VERIFIED destination, tax documentation and MFA identity are recorded — 200 with the seller ACTIVE on that agreement's compensation version, able to register prospects and read only its own statements", async () => {
  const { w } = pw;
  const c = await candidate("cmd049-ok");
  const other = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: "cmd049-ok-other" });
  assert.equal((await sellerRow(c.sellerId)).state, "CANDIDATE");
  // a candidate acts as no seller: it cannot register a prospect through its own session
  await assert.rejects(recordProspect(w.h, { by: c, domain: "cmd049-ok-before.example" }), "a CANDIDATE seller registers no prospect");

  const proof = await w.stepUp(pw.kora);
  const done = completed<SellerView>(await activate(c.sellerId, { agreementId: c.agreementId, assessmentEvidenceRef: c.assessmentRef, assuranceProofRef: proof }), 200);
  assert.deepEqual([done.data.sellerId, done.data.state, done.data.agreementId, done.data.classification, done.data.payoutDestinationVerified], [c.sellerId, "ACTIVE", c.agreementId, "INDEPENDENT_COLLABORATION", true]);
  assert.equal(done.data.version, 2);
  assert.equal(done.version, 2);
  assert.match(done.data.activatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!JSON.stringify(done.data).includes(c.destinationDigest), "the view never carries the destination or its digest");

  // the row: ACTIVE on that agreement (whose compensation version it binds), the passed assessment, the owner's own step-up and instant
  const row = await sellerRow(c.sellerId);
  assert.deepEqual([row.state, row.version, row.agreement_id, row.activated_by_user_id, row.activation_proof_ref], ["ACTIVE", "2", c.agreementId, ownerId(), proof]);
  const agreement = await w.h.oracle.query("SELECT compensation_policy_version, first_bps, repeat_bps, recurring_months FROM kauro.seller_agreements WHERE agreement_id = $1", [c.agreementId]);
  assert.deepEqual(agreement.rows, [{ compensation_policy_version: "R2-INITIAL", first_bps: 1000, repeat_bps: 400, recurring_months: 12 }]);
  assert.deepEqual((await w.securityEvents("CMD049")).slice(-1).map((f) => [f.outcome, f.reason]), [["ALLOW", "STEP_UP_FRESH"]], "the authorization is a durable fact of the owner's identity stream");

  // least privilege: the activated seller registers a prospect through its own session and reads only its own rows
  const prospect = await recordProspect(w.h, { by: c, domain: "cmd049-ok-after.example" });
  await recordProspect(w.h, { by: other, domain: "cmd049-ok-other.example" });
  const seen = await asPerson(w.h, c.userId, async (q) => ({
    sellers: (await q.query("SELECT seller_id FROM kauro.sellers")).rows.map((r: { seller_id: string }) => r.seller_id),
    prospects: (await q.query("SELECT prospect_id FROM kauro.prospects")).rows.map((r: { prospect_id: string }) => r.prospect_id),
    statements: Number((await q.query("SELECT count(*) AS n FROM kauro.commission_statements")).rows[0].n),
  }));
  assert.deepEqual(seen, { sellers: [c.sellerId], prospects: [prospect.prospectId], statements: 0 });
  // no package, source or plan of any agency is readable to it: the rows of the tenants are not its rows
  assert.deepEqual(await asPerson(w.h, c.userId, async (q) => [Number((await q.query("SELECT count(*) AS n FROM kauro.dataset_revisions")).rows[0].n), Number((await q.query("SELECT count(*) AS n FROM kauro.plans")).rows[0].n)]), [0, 0]);
  const attempt = await asPerson(w.h, c.userId, (q) => q.query("UPDATE kauro.sellers SET state = 'SUSPENDED' WHERE seller_id = $1", [c.sellerId]).then((r) => r.rowCount, () => 0));
  assert.equal(attempt, 0, "a seller cannot move its own state");
  assert.equal((await sellerRow(c.sellerId)).state, "ACTIVE");
});

test("DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — an unsigned agreement, a contractor label without a legal review of its substance, no assessment evidence, an unverified destination, no fresh step-up — each refused with the seller left CANDIDATE", async () => {
  const { w } = pw;
  const probe = async (what: string, c: CandidateSeller, reply: Promise<Reply>, expected: string): Promise<Reply> => {
    const before = await sellerRow(c.sellerId);
    const r = await reply;
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual(await sellerRow(c.sellerId), before, `${what}: the seller is left as it was`);
    assert.equal((await sellerRow(c.sellerId)).state, "CANDIDATE", `${what}: CANDIDATE`);
    return r;
  };

  // an agency member's tenant session is a foreign scope, a seller a wrong role: the same refusal, before any fact is read
  const c = await candidate("cmd049-deny");
  const member = await w.person("cmd049-deny-member");
  await w.h.addMember(w.A, member.userId, "BILLING");
  const sellerPerson = await w.person("seller-cmd049-deny");
  const ok = await c.body();
  const denials = (await w.securityEvents("CMD049")).length;
  await probe("an agency member", c, activate(c.sellerId, ok, { token: member.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await probe("a seller", c, activate(c.sellerId, ok, { token: sellerPerson.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD049")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);

  // no fresh step-up: a proof older than the freshness window, and another person's proof
  const stale = await w.stepUp(pw.kora, "STALE");
  await probe("a stale step-up", c, activate(c.sellerId, { ...ok, assuranceProofRef: stale }), "403 ASSURANCE_REQUIRED STEP_UP_STALE");
  const someoneElses = await w.stepUp(w.owner);
  await probe("another person's step-up", c, activate(c.sellerId, { ...ok, assuranceProofRef: someoneElses }), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");
  await probe("a proof nobody recorded", c, activate(c.sellerId, { ...ok, assuranceProofRef: ids.next() }), "403 ASSURANCE_REQUIRED STEP_UP_NOT_OWNED");

  // one missing prerequisite at a time
  const unsigned = await candidate("cmd049-deny-unsigned", { unsigned: true });
  await probe("an unsigned agreement", unsigned, activate(unsigned.sellerId, await unsigned.body()), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
  const label = await candidate("cmd049-deny-label", { reviewNotConfirmed: true });
  await probe("a contractor label without a legal review confirming its substance", label, activate(label.sellerId, await label.body()), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
  const unassessed = await candidate("cmd049-deny-assessment", { noAssessment: true });
  await probe("no assessment evidence", unassessed, activate(unassessed.sellerId, await unassessed.body()), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
  const unverified = await candidate("cmd049-deny-destination", { unverifiedDestination: true });
  await probe("an unverified destination", unverified, activate(unverified.sellerId, await unverified.body()), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
  // an agreement that is not this seller's, an unknown seller
  await probe("another seller's agreement", c, activate(c.sellerId, { ...ok, agreementId: unsigned.agreementId }), "409 PRECONDITION_FAILED AGREEMENT_VERSION_MISMATCH");
  assert.equal(outcome(w, await activate(ids.next(), await c.body())), "404 NOT_FOUND -");
  // the same request, correct, is accepted: the refusals above were the only obstacle
  completed<SellerView>(await activate(c.sellerId, await c.body()), 200);
  assert.equal((await sellerRow(c.sellerId)).state, "ACTIVE");
  assert.deepEqual(asProblem(w, await activate(c.sellerId, await c.body())).current, { version: 2, state: "ACTIVE" }, "an already active seller answers its current state");
});

test("RACE: an identical retry replays the 200, the same key with another agreementId is 409 IDEMPOTENCY_CONFLICT, two activations racing yield one ACTIVE seller with the wait observed, and a crash before COMMIT leaves it CANDIDATE", async () => {
  const { w } = pw;
  // an identical retry replays the 200 byte for byte and activates once; the same key with another agreementId is another request
  const c = await candidate("cmd049-race");
  const key = freshKey("cmd049-race");
  const body = await c.body();
  const first = await activate(c.sellerId, body, { key });
  completed<SellerView>(first, 200);
  const replay = await activate(c.sellerId, body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await sellerRow(c.sellerId)).version, "2", "the replay activated nothing a second time");
  assert.equal(outcome(w, await activate(c.sellerId, { ...body, agreementId: ids.next() }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await sellerRow(c.sellerId)).version, "2");

  // two activations racing: the first holds the seller's row until its commit; the second waits for it (observed in pg_stat_activity),
  // finds the seller ACTIVE and is refused: one transition
  const racing = await candidate("cmd049-race-two");
  const hold = w.holds.arm("journal.commit");
  const winner = activate(racing.sellerId, await racing.body());
  await hold.reached;
  const loser = activate(racing.sellerId, await racing.body());
  try {
    await waitForApiLockWait(w, "FROM kauro.sellers");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<SellerView>(won, 200);
  assert.equal(outcome(w, lost), "409 PRECONDITION_FAILED SELLER_NOT_ACTIVATABLE");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "ACTIVE" });
  assert.equal(await w.count("commercial_transitions", "subject_id = $1 AND to_state = 'ACTIVE'", [racing.sellerId]), 1, "one transition to ACTIVE");

  // a crash at the intent/commit boundary: the activation was written and never committed; the seller stays CANDIDATE
  const crashing = await candidate("cmd049-race-crash");
  const crashKey = freshKey("cmd049-crash");
  const crashBody = await crashing.body();
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await activate(crashing.sellerId, crashBody, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await sellerRow(crashing.sellerId)).state, (await sellerRow(crashing.sellerId)).version], ["CANDIDATE", "1"]);
  assert.equal(await w.journal(crashKey), null);
  completed<SellerView>(await activate(crashing.sellerId, crashBody, { key: crashKey }), 200);
  assert.equal((await sellerRow(crashing.sellerId)).state, "ACTIVE");
});
