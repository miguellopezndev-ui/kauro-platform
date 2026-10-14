// CMD047 AcceptAttribution — POST /api/v1/sales/claims/{claimId}/accept — KAURO_OWNER — scope CORPORATE (package B10, mandate
// B10-COMMANDS-PROSPECTS; docs/design/B10-case-map.md CMD047-OK, CMD047-DENY, CMD047-RACE; design §5, §12; decisions D10-ATTR-1 and D58;
// registry "freeze accepted acquisition attribution and claim window; record any agreed split totaling 100%"; "assignment edits or two
// full-rate sellers cannot duplicate the commission pool"). The real route, the real authorizers, the sales and attribution adapters and
// PostgreSQL 17 through the runtime login roles; the superuser only reads. The sellers are recorded with every activation fact by the
// corporate owner, the allocations prepared by the owner (test/sales-support.ts), the agency's purchase by B09's adapter-written
// fixtures. The agency's buyer type is the labelled contract fake of BuyerTypeReader (SIMULATED, D10-FAKE-1): B11 records the real one.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AttributionView } from "@kauro/application";
import { ContractFakeBuyerTypeReader } from "@kauro/application/testing";
import type { AgencyId } from "@kauro/domain";
import { recordClaim, recordProspect } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { prepareAllocation, recordSeller, type Seller } from "./sales-support.js";
import { SimulatedCrash, asProblem, call, clock, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Person } from "./support.js";

const buyerTypes = new ContractFakeBuyerTypeReader({ clock });
let pw: PaymentsWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => pw.w.h.oracle);
before(async () => {
  pw = await paymentsWorld({ commercial: { buyerTypes } });
});
after(async () => {
  await pw.stop();
});

const w = () => pw.w;
const acceptUrl = (claimId: string): string => `/api/v1/sales/claims/${claimId}/accept`;
const HOURS_2160_S = String(2160 * 3600);

const accept = (who: Person, claimId: string, body: Record<string, unknown> | undefined, options: { readonly key?: string; readonly agency?: string | null } = {}) =>
  call(w(), { url: acceptUrl(claimId), token: who.token, agency: options.agency === undefined ? null : options.agency, key: options.key ?? freshKey("cmd047"), body });

/** A new agency of its own (its owner is a person of its own) whose buyer type the fake answers. */
async function agencyOf(label: string, buyerType: "AGENCY" | "IN_HOUSE" | null = "AGENCY"): Promise<AgencyId> {
  const owner = await w().person(`${label}-owner`);
  const agency = await w().h.createAgency(owner.userId, `Agency ${label}`);
  buyerTypes.set(agency.agencyId, buyerType);
  return agency.agencyId;
}

interface Claimed {
  readonly seller: Seller;
  readonly prospectId: string;
  readonly claimId: string;
}

/** An ACTIVE seller, the prospect it registered and its SUBMITTED claim on it. */
async function claimed(label: string): Promise<Claimed> {
  const seller = await recordSeller(w(), pw.kora.userId, label);
  const prospect = await recordProspect(w().h, { by: seller, domain: `${label}.example` });
  const { claimId } = await recordClaim(w().h, { seller, prospectId: prospect.prospectId });
  return { seller, prospectId: prospect.prospectId, claimId };
}

const bodyOf = (allocationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ expectedVersion: 1, shareAllocationRef: allocationId, ...overrides });

const claimRow = async (claimId: string) =>
  (await w().h.oracle.query<{ state: string; version: string; agency_id: string | null; allocation_id: string | null; accepted_at: string | null; window_seconds: string | null; rejected: boolean }>(
    "SELECT state, version::text AS version, agency_id, allocation_id, accepted_at::text AS accepted_at, extract(epoch FROM expires_at - accepted_at)::bigint::text AS window_seconds, rejected_at IS NOT NULL AS rejected FROM kauro.attribution_claims WHERE claim_id = $1",
    [claimId],
  )).rows[0];

const allocationRow = async (allocationId: string) =>
  (await w().h.oracle.query<{ frozen: boolean; frozen_by_user_id: string | null; shares: string[] | null }>(
    "SELECT a.frozen_at IS NOT NULL AS frozen, a.frozen_by_user_id, (SELECT array_agg(s.share_bps::text ORDER BY s.share_bps DESC) FROM kauro.allocation_shares s WHERE s.allocation_id = a.allocation_id) AS shares FROM kauro.attribution_allocations a WHERE a.allocation_id = $1",
    [allocationId],
  )).rows[0];

/** The rows an acceptance writes or must leave alone: live and ruled claims, frozen allocations and the journal's CMD047 entries. */
const footprint = async () => ({
  accepted: await w().count("attribution_claims", "state = 'ACCEPTED'"),
  rejected: await w().count("attribution_claims", "state = 'REJECTED'"),
  frozen: await w().count("attribution_allocations", "frozen_at IS NOT NULL"),
  entitlements: await w().count("commission_entitlements"),
  journal: await w().count("command_journal", "operation = 'CMD047'"),
});

test("OK: the owner accepts a SUBMITTED claim with a prepared allocation naming the agency, the ruling reason and one 10000-bps share — 200 with the claim ACCEPTED, expiring 2160 h after acceptance, the allocation frozen and a competing claim REJECTED", async () => {
  const agencyId = await agencyOf("cmd047-ok");
  const main = await claimed("cmd047-ok");
  // a competing seller's claim on the same prospect (a claim needs no ownership to be written)
  const rival = await recordSeller(w(), pw.kora.userId, "cmd047-ok-rival");
  const competing = await recordClaim(w().h, { seller: rival, prospectId: main.prospectId });
  const allocationId = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId, prospectId: main.prospectId, shares: [{ seller: main.seller, claimId: main.claimId, shareBps: 10000 }] });
  assert.deepEqual(await allocationRow(allocationId), { frozen: false, frozen_by_user_id: null, shares: ["10000"] });
  const key = freshKey("cmd047-ok");
  const calls = buyerTypes.calls.length;

  const reply = completed<AttributionView>(await accept(pw.kora, main.claimId, bodyOf(allocationId), { key }), 200);
  assert.equal(reply.version, 2);
  assert.equal(reply.replayed, false);
  assert.deepEqual([reply.data.claim.claimId, reply.data.claim.state, reply.data.claim.version, reply.data.allocationId, reply.data.agencyId, reply.data.beneficiaryCount, reply.data.rejectedClaimCount], [main.claimId, "ACCEPTED", 2, allocationId, agencyId, 1, 1]);
  assert.equal(reply.data.decisionReason, "COMPETING_CLAIMS_REJECTED", "the answer carries a server token, never the owner's ruling text");
  // the claim is ACCEPTED under the allocation, running 2160 h from the acceptance; the answer's instants are the rows'
  const row = await claimRow(main.claimId);
  assert.deepEqual({ ...row, accepted_at: row?.accepted_at !== null }, { state: "ACCEPTED", version: "2", agency_id: agencyId, allocation_id: allocationId, accepted_at: true, window_seconds: HOURS_2160_S, rejected: false });
  const stored = await w().h.oracle.query<{ accepted: string; expires: string }>(
    "SELECT to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS accepted, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS expires FROM kauro.attribution_claims WHERE claim_id = $1",
    [main.claimId],
  );
  assert.deepEqual([reply.data.claim.acceptedAt, reply.data.claim.expiresAt], [stored.rows[0]?.accepted, stored.rows[0]?.expires]);
  // the allocation is frozen once, by the owner, with its single 10000-bps share; the competing claim is REJECTED under it
  assert.deepEqual(await allocationRow(allocationId), { frozen: true, frozen_by_user_id: pw.kora.userId, shares: ["10000"] });
  const lost = await claimRow(competing.claimId);
  assert.deepEqual([lost?.state, lost?.agency_id, lost?.allocation_id, lost?.rejected], ["REJECTED", agencyId, allocationId, true]);
  assert.equal(await w().count("commission_entitlements", "agency_id = $1", [agencyId]), 0, "an acceptance creates no entitlement: the commission service converts it at the first purchase");
  // D-33: the buyer type is no condition of attribution, so the platform port is not asked
  assert.deepEqual(buyerTypes.calls.slice(calls), [], "AcceptAttribution reads no buyer type");
  const journal = await w().journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 200, "attribution_claim", main.claimId]);
});

test("OK (split): an allocation of two sellers' claims at 6000/4000 under their signed agreements is frozen once and both claims are ACCEPTED", async () => {
  const agencyId = await agencyOf("cmd047-split");
  const first = await claimed("cmd047-split-a");
  const second = await recordSeller(w(), pw.kora.userId, "cmd047-split-b");
  const secondClaim = await recordClaim(w().h, { seller: second, prospectId: first.prospectId });
  const allocationId = await prepareAllocation(w().h, {
    ownerUserId: pw.kora.userId,
    agencyId,
    prospectId: first.prospectId,
    shares: [
      { seller: first.seller, claimId: first.claimId, shareBps: 6000 },
      { seller: second, claimId: secondClaim.claimId, shareBps: 4000 },
    ],
  });
  const reply = completed<AttributionView>(await accept(pw.kora, first.claimId, bodyOf(allocationId)), 200);
  assert.deepEqual([reply.data.claim.state, reply.data.beneficiaryCount, reply.data.rejectedClaimCount, reply.data.decisionReason], ["ACCEPTED", 2, 0, "AGREED_SPLIT"]);
  // one allocation, frozen once, with the two shares; both claims ACCEPTED under it
  assert.deepEqual(await allocationRow(allocationId), { frozen: true, frozen_by_user_id: pw.kora.userId, shares: ["6000", "4000"] });
  assert.equal(await w().count("attribution_allocations", "agency_id = $1", [agencyId]), 1);
  for (const id of [first.claimId, secondClaim.claimId]) {
    const row = await claimRow(id);
    assert.deepEqual([row?.state, row?.agency_id, row?.allocation_id, row?.window_seconds], ["ACCEPTED", agencyId, allocationId, HOURS_2160_S]);
  }
});

test("DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — shares summing to 9999 SHARES_NOT_WHOLE, a claim submitted after the agency's first payment order CLAIM_AFTER_FIRST_ORDER, a second full-rate seller's allocation for the agency ATTRIBUTION_EXISTS, a stale version — nothing is written and no pool can double", async () => {
  const agencyId = await agencyOf("cmd047-deny");
  const main = await claimed("cmd047-deny");
  const whole = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId, prospectId: main.prospectId, shares: [{ seller: main.seller, claimId: main.claimId, shareBps: 10000 }] });
  /** Refuses with the outcome and writes nothing: the same ruled claims, frozen allocations and entitlements, no journal entry for the key. */
  const refused = async (what: string, request: (key: string) => ReturnType<typeof accept>, expected: string) => {
    const before = await footprint();
    const key = freshKey("cmd047-deny");
    const reply = await request(key);
    assert.equal(outcome(w(), reply), expected, what);
    assert.deepEqual(await footprint(), before, `${what}: nothing is written`);
    assert.equal(await w().journal(key), null, `${what}: no journal entry`);
    return reply;
  };

  // an agency member's tenant session is a foreign scope and a seller a wrong role; each is a durable DENY fact
  const denials = (await w().securityEvents("CMD047")).length;
  await refused("an agency member's tenant session", (key) => accept(w().owner, main.claimId, bodyOf(whole), { key, agency: w().A.agencyId }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await refused("a seller", (key) => accept(main.seller.person, main.claimId, bodyOf(whole), { key }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w().securityEvents("CMD047")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);
  assert.equal(asProblem(w(), await accept(pw.kora, ids.next(), bodyOf(whole))).code, "NOT_FOUND", "a claim nobody holds is unknown");

  // shares summing to 9999 are not whole
  const short = await claimed("cmd047-deny-short");
  const shortAllocation = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId: await agencyOf("cmd047-deny-short"), prospectId: short.prospectId, shares: [{ seller: short.seller, claimId: short.claimId, shareBps: 9999 }] });
  await refused("shares summing to 9999", (key) => accept(pw.kora, short.claimId, bodyOf(shortAllocation), { key }), "409 PRECONDITION_FAILED SHARES_NOT_WHOLE");

  // a stale version carries the current one
  const stale = await refused("a stale version", (key) => accept(pw.kora, main.claimId, bodyOf(whole, { expectedVersion: 7 }), { key }), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w(), stale).current, { version: 1, state: "SUBMITTED" });

  // a claim submitted after the agency's first payment order: the purchase is paid first, then the seller claims
  buyerTypes.set(w().A.agencyId, "AGENCY");
  await pw.paidProject("cmd047-first-order");
  const late = await claimed("cmd047-deny-late");
  const lateAllocation = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId: w().A.agencyId, prospectId: late.prospectId, shares: [{ seller: late.seller, claimId: late.claimId, shareBps: 10000 }] });
  await refused("a claim after the first payment order", (key) => accept(pw.kora, late.claimId, bodyOf(lateAllocation), { key }), "409 PRECONDITION_FAILED CLAIM_AFTER_FIRST_ORDER");

  // a second full-rate seller's allocation for the agency: the first acceptance is made, the second is the pool doubled and refused
  completed<AttributionView>(await accept(pw.kora, main.claimId, bodyOf(whole)), 200);
  const other = await claimed("cmd047-deny-second");
  const doubled = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId, prospectId: other.prospectId, shares: [{ seller: other.seller, claimId: other.claimId, shareBps: 10000 }] });
  await refused("a second full-rate allocation for the agency", (key) => accept(pw.kora, other.claimId, bodyOf(doubled), { key }), "409 PRECONDITION_FAILED ATTRIBUTION_EXISTS");
  assert.equal(await w().count("attribution_allocations", "agency_id = $1 AND frozen_at IS NOT NULL", [agencyId]), 1, "one frozen allocation per agency: the pool does not double");
  assert.equal((await claimRow(other.claimId))?.state, "SUBMITTED");
});

test("OK (D-33): a company buyer is attributable under the same rules as an agency — with the buyer-type fake answering IN_HOUSE or unset, AcceptAttribution freezes the allocation and accepts the claim exactly as for AGENCY, and the buyer-type port is not asked", async () => {
  const calls = buyerTypes.calls.length;
  for (const [label, buyerType] of [["cmd047-d33-house", "IN_HOUSE"], ["cmd047-d33-unset", null], ["cmd047-d33-agency", "AGENCY"]] as const) {
    const agencyId = await agencyOf(label, buyerType);
    const c = await claimed(label);
    const allocationId = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId, prospectId: c.prospectId, shares: [{ seller: c.seller, claimId: c.claimId, shareBps: 10000 }] });
    const reply = completed<AttributionView>(await accept(pw.kora, c.claimId, bodyOf(allocationId)), 200);
    assert.deepEqual([reply.data.claim.state, reply.data.agencyId, reply.data.beneficiaryCount, reply.data.decisionReason], ["ACCEPTED", agencyId, 1, "SOLE_CLAIM_ACCEPTED"], String(buyerType));
    const row = await claimRow(c.claimId);
    assert.deepEqual([row?.state, row?.agency_id, row?.allocation_id, row?.window_seconds], ["ACCEPTED", agencyId, allocationId, HOURS_2160_S], `${String(buyerType)}: the same 2160-hour window`);
    assert.deepEqual(await allocationRow(allocationId), { frozen: true, frozen_by_user_id: pw.kora.userId, shares: ["10000"] }, String(buyerType));
  }
  assert.deepEqual(buyerTypes.calls.slice(calls), [], "no acceptance asked the buyer-type port");
});

test("RACE: an identical retry replays the 200, the same key with another shareAllocationRef is 409 IDEMPOTENCY_CONFLICT, two acceptances for one agency racing yield one allocation and one ATTRIBUTION_EXISTS with the wait observed, and a crash before COMMIT leaves the claim SUBMITTED", async () => {
  const agencyId = await agencyOf("cmd047-race");
  const main = await claimed("cmd047-race");
  const allocationId = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId, prospectId: main.prospectId, shares: [{ seller: main.seller, claimId: main.claimId, shareBps: 10000 }] });
  const key = freshKey("cmd047-race");

  // a crash at the intent/commit boundary: the allocation was frozen, the claim ruled and the journal entry written, none committed
  w().holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await accept(pw.kora, main.claimId, bodyOf(allocationId), { key });
  assert.equal(outcome(w(), crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual([(await claimRow(main.claimId))?.state, (await allocationRow(allocationId))?.frozen], ["SUBMITTED", false]);
  assert.equal(await w().journal(key), null);

  // the retry under the same key accepts once; the identical retry replays the journaled 200 byte for byte
  const first = await accept(pw.kora, main.claimId, bodyOf(allocationId), { key });
  completed<AttributionView>(first, 200);
  assert.equal((await claimRow(main.claimId))?.state, "ACCEPTED");
  const replay = await accept(pw.kora, main.claimId, bodyOf(allocationId), { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await claimRow(main.claimId))?.version, "2", "the replay ruled nothing again");

  // the same key with another shareAllocationRef is another request: a conflict, and nothing happens
  const elsewhere = await claimed("cmd047-race-else");
  const otherAllocation = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId: await agencyOf("cmd047-race-else"), prospectId: elsewhere.prospectId, shares: [{ seller: elsewhere.seller, claimId: elsewhere.claimId, shareBps: 10000 }] });
  assert.equal(outcome(w(), await accept(pw.kora, main.claimId, bodyOf(otherAllocation), { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await allocationRow(otherAllocation))?.frozen, false);

  // two acceptances for one agency racing: A holds inside its unit of work with its allocation frozen; B, ruling another seller's claim
  // for the same agency, cannot see it and blocks on the agency's one-frozen-allocation index (observed in pg_stat_activity); after A
  // commits it answers ATTRIBUTION_EXISTS and its claim is untouched
  const racing = await agencyOf("cmd047-race-two");
  const one = await claimed("cmd047-race-one");
  const two = await claimed("cmd047-race-two");
  const allocationOne = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId: racing, prospectId: one.prospectId, shares: [{ seller: one.seller, claimId: one.claimId, shareBps: 10000 }] });
  const allocationTwo = await prepareAllocation(w().h, { ownerUserId: pw.kora.userId, agencyId: racing, prospectId: two.prospectId, shares: [{ seller: two.seller, claimId: two.claimId, shareBps: 10000 }] });
  const hold = w().holds.arm("journal.commit");
  const requestA = accept(pw.kora, one.claimId, bodyOf(allocationOne));
  await hold.reached;
  const requestB = accept(pw.kora, two.claimId, bodyOf(allocationTwo));
  try {
    // the second acceptance waits for the first on the agency's commission subject, which every writer of its claims takes first (D10-GAP-20)
    await waitForApiLockWait(w(), "pg_advisory_xact_lock(kauro.transition_key('kauro.agency_commissions'");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([requestA, requestB]);
  completed<AttributionView>(ra, 200);
  assert.equal(outcome(w(), rb), "409 PRECONDITION_FAILED ATTRIBUTION_EXISTS");
  assert.equal(await w().count("attribution_allocations", "agency_id = $1 AND frozen_at IS NOT NULL", [racing]), 1, "one allocation for the agency");
  assert.deepEqual([(await claimRow(one.claimId))?.state, (await claimRow(two.claimId))?.state, (await allocationRow(allocationTwo))?.frozen], ["ACCEPTED", "SUBMITTED", false]);
});
