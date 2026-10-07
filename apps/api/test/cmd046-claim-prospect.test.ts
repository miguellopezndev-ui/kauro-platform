// CMD046 ClaimProspect — POST /api/v1/sales/prospects/{prospectId}/claims — an ACTIVE seller — scope CORPORATE (package B10, mandate
// B10-COMMANDS-PROSPECTS; docs/design/B10-case-map.md CMD046-OK, CMD046-DENY, CMD046-RACE; design §5, §12; decisions D10-CLAIM-1 and
// D10-CLAIM-2; registry "create a reviewable attribution claim"; "submission alone does not own the agency"; "existing accepted claims
// or customer history route to conflict review"). The real route, the real authorizers, the sales and attribution adapters and PostgreSQL
// 17 through the runtime login roles; the superuser only reads. The sellers are recorded with every activation fact by the corporate
// owner and the prospects by their registrars (@kauro/persistence/testing); claim evidence is each seller's own (test/sales-support.ts).
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AttributionClaimView } from "@kauro/application";
import { recordClaim, recordFrozenAllocation, recordProspect, type RecordedProspect } from "@kauro/persistence/testing";
import { asOperator, recordClaimEvidence, salesWorld, type Seller, type SalesWorld } from "./sales-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Person } from "./support.js";

let sw: SalesWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.w.h.oracle);
before(async () => {
  sw = await salesWorld({}, "cmd046");
});
after(async () => {
  await sw.stop();
});

const w = () => sw.w;
const claimsUrl = (prospectId: string): string => `/api/v1/sales/prospects/${prospectId}/claims`;

const claim = (who: Person, prospectId: string, body: Record<string, unknown> | undefined, options: { readonly key?: string; readonly token?: string; readonly agency?: string | null } = {}) =>
  call(w(), { url: claimsUrl(prospectId), token: options.token ?? who.token, agency: options.agency === undefined ? null : options.agency, key: options.key ?? freshKey("cmd046"), body });

const bodyOf = (evidenceHash: string, seller: Pick<Seller, "agreementVersion">, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ evidenceHash, agreementVersion: seller.agreementVersion, ...overrides });

/** A new ACTIVE seller of its own and a prospect it registered (and so owns) under a domain of its own. */
async function sellerWithProspect(label: string): Promise<{ readonly seller: Seller; readonly prospect: RecordedProspect }> {
  const seller = await sw.seller(label);
  const prospect = await recordProspect(w().h, { by: seller, domain: `${label}.example` });
  return { seller, prospect };
}

const claimRows = async (prospectId: string) =>
  (await w().h.oracle.query<{ claim_id: string; seller_id: string; state: string; version: string; agency_id: string | null; allocation_id: string | null; accepted_at: string | null; conflict_reason: string | null; deadline_seconds: string }>(
    `SELECT claim_id, seller_id, state, version::text AS version, agency_id, allocation_id, accepted_at::text AS accepted_at, conflict_reason, extract(epoch FROM review_deadline_at - submitted_at)::bigint::text AS deadline_seconds
       FROM kauro.attribution_claims WHERE prospect_id = $1 ORDER BY submitted_at, claim_id`,
    [prospectId],
  )).rows;

/** The rows a claim writes or must leave alone: claims, allocations, entitlements and the journal's CMD046 entries. */
const footprint = async () => ({
  claims: await w().count("attribution_claims"),
  allocations: await w().count("attribution_allocations"),
  entitlements: await w().count("commission_entitlements"),
  journal: await w().count("command_journal", "operation = 'CMD046'"),
});

test("OK: an ACTIVE seller claims a prospect it owns with substantive evidence under its active agreement version — 201 with one SUBMITTED claim whose review deadline is 2160 h later, and no allocation, entitlement or agency ownership", async () => {
  const { seller, prospect } = await sellerWithProspect("cmd046-ok");
  const evidenceHash = await recordClaimEvidence(w().h, seller, prospect.prospectId);
  const key = freshKey("cmd046-ok");
  const reply = completed<AttributionClaimView>(await claim(seller.person, prospect.prospectId, bodyOf(evidenceHash, seller), { key }), 201);
  assert.equal(reply.version, 1);
  assert.equal(reply.replayed, false);
  assert.deepEqual(
    [reply.data.prospectId, reply.data.sellerId, reply.data.evidenceHash, reply.data.agreementVersion, reply.data.state, reply.data.version, reply.data.acceptedAt],
    [prospect.prospectId, seller.sellerId, evidenceHash, seller.agreementVersion, "SUBMITTED", 1, undefined],
  );
  // exactly one SUBMITTED claim whose review deadline is 2160 hours (7 776 000 s) after the server's instant of submission, owning nothing
  const rows = await claimRows(prospect.prospectId);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0]!, claim_id: rows[0]!.claim_id === reply.data.claimId },
    { claim_id: true, seller_id: seller.sellerId, state: "SUBMITTED", version: "1", agency_id: null, allocation_id: null, accepted_at: null, conflict_reason: null, deadline_seconds: String(2160 * 3600) },
  );
  const deadline = await w().h.oracle.query<{ expires: string }>("SELECT to_char(review_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires FROM kauro.attribution_claims WHERE claim_id = $1", [reply.data.claimId]);
  assert.equal(reply.data.expiresAt, deadline.rows[0]?.expires, "the answer's expiry is the stored review deadline");
  assert.equal(await w().count("attribution_allocations", "prospect_id = $1", [prospect.prospectId]), 0, "submission creates no allocation");
  assert.equal(await w().count("commission_entitlements", "seller_id = $1", [seller.sellerId]), 0, "and no entitlement");
  assert.equal((await w().h.oracle.query("SELECT 1 FROM kauro.sales_accounts")).rowCount, 0, "and owns no agency");
  const journal = await w().journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "attribution_claim", reply.data.claimId]);
});

test("DENY: another seller's prospect is a foreign scope (404) and the owner or an agency member a wrong role (403); then one missing prerequisite at a time — a stale agreement version AGREEMENT_VERSION_MISMATCH, a list import or tracking link alone CLAIM_EVIDENCE_INSUFFICIENT, the seller's second live claim CLAIM_EXISTS — nothing is written", async () => {
  const { seller, prospect } = await sellerWithProspect("cmd046-deny");
  const rival = await sw.seller("cmd046-deny-rival");
  const evidenceHash = await recordClaimEvidence(w().h, seller, prospect.prospectId);
  /** Refuses with the outcome and writes nothing: the same rows, no journal entry for the key. */
  const refused = async (what: string, request: (key: string) => ReturnType<typeof claim>, expected: string) => {
    const before = await footprint();
    const key = freshKey("cmd046-deny");
    const reply = await request(key);
    assert.equal(outcome(w(), reply), expected, what);
    assert.deepEqual(await footprint(), before, `${what}: nothing is written`);
    assert.equal(await w().journal(key), null, `${what}: no journal entry`);
    return reply;
  };

  // another seller's prospect is a foreign scope, answering exactly as a prospect nobody registered does; the owner and an agency member hold no seller row
  const foreign = await refused("another seller's prospect", (key) => claim(rival.person, prospect.prospectId, bodyOf(evidenceHash, rival), { key }), "404 NOT_FOUND -");
  const unknown = await claim(rival.person, ids.next(), bodyOf(evidenceHash, rival));
  assert.equal(unknown.status, 404);
  assert.deepEqual({ ...asProblem(w(), foreign), correlationId: "" }, { ...asProblem(w(), unknown), correlationId: "" }, "a foreign and a nonexistent prospect answer alike");
  const denials = (await w().securityEvents("CMD046")).length;
  await refused("the owner", (key) => claim(sw.owner, prospect.prospectId, bodyOf(evidenceHash, seller), { key }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await refused("an agency member", (key) => claim(w().owner, prospect.prospectId, bodyOf(evidenceHash, seller), { key, agency: w().A.agencyId }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w().securityEvents("CMD046")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);

  // a stale agreement version, then evidence that is a list import or a tracking link alone, another prospect's or nobody's
  await refused("a stale agreement version", (key) => claim(seller.person, prospect.prospectId, bodyOf(evidenceHash, seller, { agreementVersion: "SA-SUPERSEDED" }), { key }), "409 PRECONDITION_FAILED AGREEMENT_VERSION_MISMATCH");
  const listImport = await recordClaimEvidence(w().h, seller, prospect.prospectId, ["LIST_IMPORT", "TRACKING_LINK"]);
  await refused("a list import and a tracking link alone", (key) => claim(seller.person, prospect.prospectId, bodyOf(listImport, seller), { key }), "409 PRECONDITION_FAILED CLAIM_EVIDENCE_INSUFFICIENT");
  const elsewhere = await recordProspect(w().h, { by: seller, domain: "cmd046-deny-elsewhere.example" });
  const otherProspectsEvidence = await recordClaimEvidence(w().h, seller, elsewhere.prospectId);
  await refused("evidence of another prospect", (key) => claim(seller.person, prospect.prospectId, bodyOf(otherProspectsEvidence, seller), { key }), "409 PRECONDITION_FAILED CLAIM_EVIDENCE_INSUFFICIENT");
  await refused("evidence nobody recorded", (key) => claim(seller.person, prospect.prospectId, bodyOf("0".repeat(64), seller), { key }), "409 PRECONDITION_FAILED CLAIM_EVIDENCE_INSUFFICIENT");
  assert.deepEqual(await claimRows(prospect.prospectId), [], "no refusal left a claim");

  // the seller's second live claim on the prospect
  completed<AttributionClaimView>(await claim(seller.person, prospect.prospectId, bodyOf(evidenceHash, seller)), 201);
  const second = await recordClaimEvidence(w().h, seller, prospect.prospectId);
  await refused("a second live claim", (key) => claim(seller.person, prospect.prospectId, bodyOf(second, seller), { key }), "409 PRECONDITION_FAILED CLAIM_EXISTS");
  assert.equal((await claimRows(prospect.prospectId)).length, 1, "one live claim per seller and prospect");
});

test("DENY (conflict review): a claim on a prospect with another seller's accepted or live claim is written DISPUTED in the same transaction and owns nothing", async () => {
  // another seller's live claim: seller B claimed the prospect seller A registered (a claim needs no ownership to be written), so A's claim is born DISPUTED
  const { seller: a, prospect } = await sellerWithProspect("cmd046-conflict-a");
  const b = await sw.seller("cmd046-conflict-b");
  const competing = await recordClaim(w().h, { seller: b, prospectId: prospect.prospectId });
  const evidenceHash = await recordClaimEvidence(w().h, a, prospect.prospectId);
  const disputed = completed<AttributionClaimView>(await claim(a.person, prospect.prospectId, bodyOf(evidenceHash, a)), 201);
  assert.equal(disputed.data.state, "DISPUTED");
  assert.equal(disputed.version, 2, "born SUBMITTED and moved DISPUTED in the same transaction");
  let rows = await claimRows(prospect.prospectId);
  const own = rows.find((r) => r.claim_id === disputed.data.claimId);
  assert.deepEqual([own?.state, own?.conflict_reason, own?.agency_id, own?.allocation_id], ["DISPUTED", "LIVE_COMPETING_CLAIM", null, null], "it owns nothing");
  assert.equal(rows.find((r) => r.claim_id === competing.claimId)?.state, "SUBMITTED", "the competing claim is untouched");
  const history = await w().h.oracle.query<{ edge: string }>("SELECT coalesce(from_state, '-') || '>' || to_state AS edge FROM kauro.commercial_transitions WHERE machine = 'AttributionClaim' AND subject_id = $1 ORDER BY subject_version", [disputed.data.claimId]);
  assert.deepEqual(history.rows.map((r) => r.edge), ["->SUBMITTED", "SUBMITTED>DISPUTED"]);

  // an accepted claim on the organization: seller D's claim on the prospect seller C registered was accepted (a frozen allocation of an
  // agency), so C's claim is DISPUTED by the accepted claim
  const { seller: c, prospect: contested } = await sellerWithProspect("cmd046-conflict-c");
  const d = await sw.seller("cmd046-conflict-d");
  const acceptedClaim = await recordClaim(w().h, { seller: d, prospectId: contested.prospectId });
  await recordFrozenAllocation(w().h, { ownerUserId: sw.owner.userId as never, agencyId: w().A.agencyId, prospectId: contested.prospectId, shares: [{ seller: d, claimId: acceptedClaim.claimId, shareBps: 10000 }] });
  const evidenceC = await recordClaimEvidence(w().h, c, contested.prospectId);
  const behindAccepted = completed<AttributionClaimView>(await claim(c.person, contested.prospectId, bodyOf(evidenceC, c)), 201);
  assert.equal(behindAccepted.data.state, "DISPUTED");
  rows = await claimRows(contested.prospectId);
  assert.deepEqual(rows.find((r) => r.claim_id === behindAccepted.data.claimId)?.conflict_reason, "ACCEPTED_CLAIM_ON_ORGANIZATION");
  assert.equal(rows.find((r) => r.claim_id === acceptedClaim.claimId)?.state, "ACCEPTED");
  assert.equal(await w().count("attribution_allocations", "prospect_id = $1", [contested.prospectId]), 1, "the disputed claim created no allocation of its own");
  assert.equal(await w().count("commission_entitlements", "seller_id = $1", [c.sellerId]), 0);
});

test("RACE: an identical retry replays the 201, the same key with another evidenceHash is 409 IDEMPOTENCY_CONFLICT, two sellers' claims of one prospect serialize on its claims lock with the wait observed — the second is DISPUTED — and a crash before COMMIT leaves no claim", async () => {
  const { seller, prospect } = await sellerWithProspect("cmd046-race");
  const evidenceHash = await recordClaimEvidence(w().h, seller, prospect.prospectId);
  const key = freshKey("cmd046-race");
  const body = bodyOf(evidenceHash, seller);

  // a crash at the intent/commit boundary: the claim and the journal entry were written and never committed
  w().holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await claim(seller.person, prospect.prospectId, body, { key });
  assert.equal(outcome(w(), crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await claimRows(prospect.prospectId), []);
  assert.equal(await w().journal(key), null);

  // the retry under the same key claims once; the identical retry replays the journaled 201 byte for byte
  const first = await claim(seller.person, prospect.prospectId, body, { key });
  completed<AttributionClaimView>(first, 201);
  assert.equal((await claimRows(prospect.prospectId)).length, 1);
  const replay = await claim(seller.person, prospect.prospectId, body, { key });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await claimRows(prospect.prospectId)).length, 1, "the replay submitted no second claim");

  // the same key with another evidenceHash is another request: a conflict, and nothing happens
  const other = await recordClaimEvidence(w().h, seller, prospect.prospectId);
  assert.equal(outcome(w(), await claim(seller.person, prospect.prospectId, bodyOf(other, seller), { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await claimRows(prospect.prospectId)).length, 1);

  // two sellers' claims of one prospect: seller A claims it as its owner and holds inside its unit of work with the claim written; the
  // owner then hands the prospect to seller B, whose claim waits on the prospect's claims lock (observed in pg_stat_activity), reads A's
  // committed claim after A commits and is written DISPUTED
  const contested = await sellerWithProspect("cmd046-race-a");
  const b = await sw.seller("cmd046-race-b");
  const evidenceA = await recordClaimEvidence(w().h, contested.seller, contested.prospect.prospectId);
  const evidenceB = await recordClaimEvidence(w().h, b, contested.prospect.prospectId);
  const hold = w().holds.arm("journal.commit");
  const requestA = claim(contested.seller.person, contested.prospect.prospectId, bodyOf(evidenceA, contested.seller));
  await hold.reached;
  await asOperator(w().h, sw.owner.userId, (c) => c.query("UPDATE kauro.prospects SET owner_seller_id = $2, version = version + 1 WHERE prospect_id = $1", [contested.prospect.prospectId, b.sellerId]));
  const requestB = claim(b.person, contested.prospect.prospectId, bodyOf(evidenceB, b));
  try {
    await waitForApiLockWait(w(), "pg_advisory_xact_lock(kauro.transition_key('kauro.attribution_claims'");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([requestA, requestB]);
  assert.equal(completed<AttributionClaimView>(ra, 201).data.state, "SUBMITTED");
  assert.equal(completed<AttributionClaimView>(rb, 201).data.state, "DISPUTED", "the second claim is written DISPUTED");
  const rows = await claimRows(contested.prospect.prospectId);
  assert.deepEqual(rows.map((r) => [r.seller_id, r.state]), [[contested.seller.sellerId, "SUBMITTED"], [b.sellerId, "DISPUTED"]]);
});
