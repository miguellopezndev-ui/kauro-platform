// CMD050 TerminateSeller — POST /api/v1/sales/sellers/{sellerId}/terminate — KAURO_OWNER — scope CORPORATE (package B10, mandate
// B10-COMMANDS-SELLERS; docs/design/B10-case-map.md CMD050-OK, CMD050-DENY, CMD050-RACE and R2-100; design §5, §10, §12; decision D10-TERM-1:
// "Termination ends access, keeps residuals, expires unlisted claims and records a 2160-hour tail only for enumerated accepted
// opportunities (KC011); nothing of the ledger is deleted"). The real route, the real authorizers, the sales adapters and PostgreSQL 17
// through the runtime login roles; the superuser only reads. The sellers, prospects, claims, allocations, entitlements and purchases are
// the adapter-written fixtures of @kauro/persistence/testing and sellers-support, each written by the role that owns it; the purchase that
// closes an opportunity is B09's. The provider is B09's labelled contract fake (SIMULATED): nothing here is a provider fact.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { SalesAccountView, SellerTerminationView } from "@kauro/application";
import type { UserId } from "@kauro/domain";
import { recordActiveSeller, recordClaim, recordConversion, recordFrozenAllocation, recordProspect, recordServiceAssignment, type AgencyFixture, type RecordedSeller } from "@kauro/persistence/testing";
import { paymentsWorld, type PaymentsWorld } from "./commerce-support.js";
import { candidateSeller, digest, paidProject, prepareManifest, prepareTerminationTerms, scrapedProspects, sellingAgency } from "./sellers-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Person, type Reply } from "./support.js";

let pw: PaymentsWorld;
before(async () => {
  pw = await paymentsWorld();
});
after(async () => {
  await pw.stop();
});

const HOUR_MS = 3_600_000;
const terminateUrl = (sellerId: string): string => `/api/v1/sales/sellers/${sellerId}/terminate`;
const ownerId = (): UserId => pw.kora.userId as UserId;

async function terminate(sellerId: string, body: Record<string, unknown>, options: { readonly token?: string; readonly key?: string } = {}): Promise<Reply> {
  return call(pw.w, { url: terminateUrl(sellerId), token: options.token ?? pw.kora.token, agency: null, key: options.key ?? freshKey("cmd050"), body });
}

const sellerRow = async (sellerId: string) =>
  (await pw.w.h.oracle.query<{ state: string; version: string; terminated_at: Date | null }>("SELECT state, version::text, terminated_at FROM kauro.sellers WHERE seller_id = $1", [sellerId])).rows[0]!;

/** An accepted opportunity of the seller: a prospect it registered, its claim and the frozen single-share allocation that accepts it for a fresh agency. */
interface Opportunity {
  readonly agency: AgencyFixture;
  readonly prospectId: string;
  readonly claimId: string;
  readonly allocationId: string;
}

async function opportunity(seller: RecordedSeller, label: string, options: { readonly accept?: boolean } = {}): Promise<Opportunity> {
  const { w } = pw;
  const agency = await w.h.createAgency((await w.person(`${label}-owner`)).userId, `Agency ${label}`);
  const prospect = await recordProspect(w.h, { by: seller, domain: `${label}.example` });
  const claim = await recordClaim(w.h, { seller, prospectId: prospect.prospectId });
  const allocationId = options.accept === false ? "" : (await recordFrozenAllocation(w.h, { ownerUserId: ownerId(), agencyId: agency.agencyId, prospectId: prospect.prospectId, shares: [{ seller, claimId: claim.claimId, shareBps: 10000 }] })).allocationId;
  return { agency, prospectId: prospect.prospectId, claimId: claim.claimId, allocationId };
}

interface Departing {
  readonly seller: RecordedSeller;
  readonly person: Person;
  readonly listed: readonly [Opportunity, Opportunity];
  readonly unlisted: Opportunity;
  readonly submitted: Opportunity;
}

/** An ACTIVE seller with two accepted opportunities to hand over, one accepted opportunity it does not and a claim still SUBMITTED. */
async function departing(label: string): Promise<Departing> {
  const { w } = pw;
  const person = await w.person(`seller-${label}`);
  const seller = await recordActiveSeller(w.h, { ownerUserId: ownerId(), subject: label });
  assert.equal(person.userId, seller.userId);
  const listed = [await opportunity(seller, `${label}-l1`), await opportunity(seller, `${label}-l2`)] as const;
  return { seller, person, listed, unlisted: await opportunity(seller, `${label}-u`), submitted: await opportunity(seller, `${label}-s`, { accept: false }) };
}

/** An agency the seller acquired, with its first purchase and the conversion into the seller's ACTIVE entitlement (example 1's shape). */
async function entitledAgency(seller: RecordedSeller, label: string): Promise<{ readonly agencyId: string; readonly entitlementId: string; readonly claimId: string }> {
  const { w } = pw;
  const s = await sellingAgency(pw, label);
  const prospect = await recordProspect(w.h, { by: seller, domain: `${label}.example` });
  const claim = await recordClaim(w.h, { seller, prospectId: prospect.prospectId });
  const { allocationId } = await recordFrozenAllocation(w.h, { ownerUserId: ownerId(), agencyId: s.agency.agencyId, prospectId: prospect.prospectId, shares: [{ seller, claimId: claim.claimId, shareBps: 10000 }] });
  await paidProject(pw, s, `${label}-first`);
  const entitlement = (await recordConversion(w.h, { agencyId: s.agency.agencyId, allocationId })).get(seller.sellerId);
  assert.ok(entitlement, "the conversion created the seller's entitlement");
  return { agencyId: s.agency.agencyId, entitlementId: entitlement.entitlementId, claimId: claim.claimId };
}

/** The termination's body: the owner's prepared terms and the manifest of the claims it hands over. */
async function prepared(sellerId: string, handedOver: ReadonlyArray<string>, expectedVersion?: number): Promise<{ expectedVersion: number; terminationTermsRef: string; activeOpportunityManifestRef: string }> {
  return {
    expectedVersion: expectedVersion ?? Number((await sellerRow(sellerId)).version),
    terminationTermsRef: await prepareTerminationTerms(pw.w.h, ownerId(), sellerId),
    activeOpportunityManifestRef: await prepareManifest(pw.w.h, ownerId(), sellerId, handedOver),
  };
}

/** Everything the termination may touch, as the superuser reads it: the seller, its claims, entitlements, assignments, prospects, tail, terminations and ledger rows. */
async function footprint(sellerId: string): Promise<ReadonlyArray<string>> {
  const { h } = pw.w;
  return [
    await digest(h, "SELECT * FROM kauro.sellers WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.attribution_claims WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.commission_entitlements WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.account_assignments WHERE seller_id = $1 OR agency_id IN (SELECT agency_id FROM kauro.account_assignments WHERE seller_id = $1)", [sellerId]),
    await digest(h, "SELECT * FROM kauro.sales_accounts WHERE agency_id IN (SELECT agency_id FROM kauro.account_assignments WHERE seller_id = $1)", [sellerId]),
    await digest(h, "SELECT * FROM kauro.prospects WHERE registered_by_seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.termination_tail_entries WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.seller_terminations WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.commission_lines WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.commission_adjustments WHERE line_id IN (SELECT line_id FROM kauro.commission_lines WHERE seller_id = $1)", [sellerId]),
    await digest(h, "SELECT * FROM kauro.commission_statements WHERE seller_id = $1", [sellerId]),
    await digest(h, "SELECT * FROM kauro.seller_payout_destinations WHERE seller_id = $1", [sellerId]),
  ];
}

const claimStates = async (claimIds: ReadonlyArray<string>) =>
  Object.fromEntries((await pw.w.h.oracle.query<{ claim_id: string; state: string }>("SELECT claim_id, state FROM kauro.attribution_claims WHERE claim_id = ANY($1::uuid[])", [[...claimIds]])).rows.map((r) => [r.claim_id, r.state]));

test("R2-100 (example 13): TerminateSeller with a manifest of two enumerated active opportunities records exactly two tail entries ending 2160 h after the effective instant, and the thousand prospects the seller registered from a scraped list gain no tail, claim or entitlement", async () => {
  const { w } = pw;
  const d = await departing("cmd050-r100");
  // the seller imported a list: a thousand lawful-looking prospects it registered and never claimed
  const scraped = await scrapedProspects(w.h, d.seller, 1000);
  assert.equal(new Set(scraped).size, 1000);
  assert.equal(await w.count("prospects", "registered_by_seller_id = $1", [d.seller.sellerId]), 1000 + 4, "the list and the four prospects of its opportunities");

  const body = await prepared(d.seller.sellerId, [d.listed[0].claimId, d.listed[1].claimId]);
  const done = completed<SellerTerminationView>(await terminate(d.seller.sellerId, body), 200);
  assert.equal(done.data.tailEntries, 2);
  assert.equal(done.data.prospectsUnassigned, 1004);

  // exactly two tail entries, each ending 2160 hours (7 776 000 s) after the termination's effective instant
  const tail = await w.h.oracle.query<{ claim_id: string; agency_id: string; seconds: string; same: boolean }>(
    "SELECT e.claim_id, e.agency_id, extract(epoch FROM e.ends_at - t.effective_at)::bigint::text AS seconds, e.effective_at = t.effective_at AS same FROM kauro.termination_tail_entries e JOIN kauro.seller_terminations t USING (termination_id) WHERE e.seller_id = $1 ORDER BY e.claim_id",
    [d.seller.sellerId],
  );
  assert.deepEqual(
    tail.rows,
    [d.listed[0], d.listed[1]].sort((a, b) => (a.claimId < b.claimId ? -1 : 1)).map((o) => ({ claim_id: o.claimId, agency_id: o.agency.agencyId, seconds: String(2160 * 3600), same: true })),
  );
  const effective = Date.parse(done.data.effectiveAt);
  assert.equal(Date.parse(done.data.tailEndsAt) - effective, 2160 * HOUR_MS);

  // the thousand prospects gain no tail, claim or entitlement: they are unassigned and nothing else of them changes
  const claimsOfScraped = await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.attribution_claims WHERE prospect_id = ANY($1::uuid[])", [scraped]);
  const tailOfScraped = await w.h.oracle.query<{ n: string }>("SELECT count(*)::text AS n FROM kauro.termination_tail_entries e JOIN kauro.attribution_claims c USING (claim_id) WHERE c.prospect_id = ANY($1::uuid[])", [scraped]);
  const unassigned = await w.h.oracle.query<{ n: string; states: string[] }>("SELECT count(*)::text AS n, array_agg(DISTINCT state) AS states FROM kauro.prospects WHERE prospect_id = ANY($1::uuid[]) AND owner_seller_id IS NULL", [scraped]);
  assert.deepEqual([claimsOfScraped.rows[0]!.n, tailOfScraped.rows[0]!.n, unassigned.rows[0]!.n, unassigned.rows[0]!.states], ["0", "0", "1000", ["RESEARCHED"]]);
  assert.equal(await w.count("commission_entitlements", "seller_id = $1", [d.seller.sellerId]), 0, "no entitlement was created for the departed seller");
  assert.equal(await w.count("termination_tail_entries", "seller_id = $1", [d.seller.sellerId]), 2);
  // the unlisted accepted opportunity and the submitted claim lapse; the two listed ones stay ACCEPTED for their tail
  assert.deepEqual(await claimStates([d.listed[0].claimId, d.listed[1].claimId, d.unlisted.claimId, d.submitted.claimId]), {
    [d.listed[0].claimId]: "ACCEPTED",
    [d.listed[1].claimId]: "ACCEPTED",
    [d.unlisted.claimId]: "EXPIRED",
    [d.submitted.claimId]: "EXPIRED",
  });
});

test("OK: the owner terminates an ACTIVE seller with prepared terms and an enumerated manifest — 200 with the seller TERMINATED at the effective instant, its assignments ended, its prospects unassigned, its entitlements TERMINATED_WITH_RESIDUAL, its unlisted open claims EXPIRED and one tail entry per listed opportunity", async () => {
  const { w } = pw;
  const d = await departing("cmd050-ok");
  const entitled = await entitledAgency(d.seller, "cmd050-ok-entitled");
  // the seller is the operational owner of one of the agencies it handed over
  const service = await recordServiceAssignment(w.h, { ownerUserId: ownerId(), agencyId: d.listed[0].agency.agencyId, sellerId: d.seller.sellerId });
  completed<SalesAccountView>(await call(w, { url: `/api/v1/sales/agencies/${d.listed[0].agency.agencyId}/assignment`, token: pw.kora.token, agency: null, key: freshKey("cmd050-assign"), body: { expectedVersion: 0, sellerId: d.seller.sellerId, serviceAssignmentRef: service } }), 200);
  const ledgerBefore = [
    await digest(w.h, "SELECT * FROM kauro.commission_lines WHERE seller_id = $1", [d.seller.sellerId]),
    await digest(w.h, "SELECT * FROM kauro.commission_statements WHERE seller_id = $1", [d.seller.sellerId]),
    await digest(w.h, "SELECT * FROM kauro.seller_payout_destinations WHERE seller_id = $1", [d.seller.sellerId]),
    await digest(w.h, "SELECT * FROM kauro.seller_agreements WHERE seller_id = $1", [d.seller.sellerId]),
  ];
  const prospectsBefore = await w.count("prospects", "registered_by_seller_id = $1", [d.seller.sellerId]);
  assert.equal(await w.count("prospects", "owner_seller_id = $1", [d.seller.sellerId]), prospectsBefore);

  const body = await prepared(d.seller.sellerId, [d.listed[0].claimId, d.listed[1].claimId]);
  const done = completed<SellerTerminationView>(await terminate(d.seller.sellerId, body), 200);
  // the answer: TERMINATED at the effective instant, what it did to claims, prospects, assignments and entitlements
  assert.deepEqual(
    [done.data.sellerId, done.data.state, done.data.version, done.data.tailEntries, done.data.entitlementsResidual, done.data.claimsExpired, done.data.prospectsUnassigned, done.data.assignmentsEnded],
    [d.seller.sellerId, "TERMINATED", 2, 2, 1, 2, prospectsBefore, 1],
  );
  assert.equal(done.version, 2);
  assert.equal(Date.parse(done.data.tailEndsAt) - Date.parse(done.data.effectiveAt), 2160 * HOUR_MS);
  // the rows: the seller TERMINATED at the termination's effective instant
  const row = await w.h.oracle.query<{ state: string; version: string; same: boolean; by_owner: boolean }>(
    "SELECT s.state, s.version::text, s.terminated_at = t.effective_at AS same, t.terminated_by_user_id = $2 AS by_owner FROM kauro.sellers s JOIN kauro.seller_terminations t ON t.seller_id = s.seller_id WHERE s.seller_id = $1 AND t.termination_id = $3",
    [d.seller.sellerId, ownerId(), body.terminationTermsRef],
  );
  assert.deepEqual(row.rows, [{ state: "TERMINATED", version: "2", same: true, by_owner: true }]);
  assert.equal(new Date(row.rows.length > 0 ? (await sellerRow(d.seller.sellerId)).terminated_at! : 0).toISOString(), done.data.effectiveAt);
  // its assignments ended: the agency's chain gained a SELLER_TERMINATED link naming nobody; the earlier link stays
  const links = await w.h.oracle.query<{ reason: string; seller_id: string | null }>("SELECT reason, seller_id FROM kauro.account_assignments WHERE agency_id = $1 ORDER BY effective_at, assignment_id", [d.listed[0].agency.agencyId]);
  assert.deepEqual(links.rows, [{ reason: "ASSIGNED", seller_id: d.seller.sellerId }, { reason: "SELLER_TERMINATED", seller_id: null }]);
  // its prospects unassigned (kept, not deleted)
  assert.equal(await w.count("prospects", "owner_seller_id = $1", [d.seller.sellerId]), 0);
  assert.equal(await w.count("prospects", "registered_by_seller_id = $1", [d.seller.sellerId]), prospectsBefore);
  // its entitlement TERMINATED_WITH_RESIDUAL; the converted claim behind it is untouched
  assert.deepEqual((await w.h.oracle.query("SELECT state, terminated_at IS NOT NULL AS ended FROM kauro.commission_entitlements WHERE entitlement_id = $1", [entitled.entitlementId])).rows, [{ state: "TERMINATED_WITH_RESIDUAL", ended: true }]);
  // its claims: the unlisted accepted one and the submitted one EXPIRED, the two enumerated ones ACCEPTED with one tail entry each, the converted one CONVERTED
  assert.deepEqual(await claimStates([d.listed[0].claimId, d.listed[1].claimId, d.unlisted.claimId, d.submitted.claimId, entitled.claimId]), {
    [d.listed[0].claimId]: "ACCEPTED",
    [d.listed[1].claimId]: "ACCEPTED",
    [d.unlisted.claimId]: "EXPIRED",
    [d.submitted.claimId]: "EXPIRED",
    [entitled.claimId]: "CONVERTED",
  });
  assert.equal(await w.count("termination_tail_entries", "termination_id = $1", [body.terminationTermsRef]), 2);
  // nothing of the ledger is touched, deleted or forfeited by the termination
  assert.deepEqual(
    [
      await digest(w.h, "SELECT * FROM kauro.commission_lines WHERE seller_id = $1", [d.seller.sellerId]),
      await digest(w.h, "SELECT * FROM kauro.commission_statements WHERE seller_id = $1", [d.seller.sellerId]),
      await digest(w.h, "SELECT * FROM kauro.seller_payout_destinations WHERE seller_id = $1", [d.seller.sellerId]),
      await digest(w.h, "SELECT * FROM kauro.seller_agreements WHERE seller_id = $1", [d.seller.sellerId]),
    ],
    ledgerBefore,
  );
  // access ended: the departed seller's token no longer acts as a seller (its row is TERMINATED), and a second termination is refused
  assert.equal(outcome(w, await terminate(d.seller.sellerId, await prepared(d.seller.sellerId, [], 2))), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
});

test("DENY: an agency member's tenant session is a foreign scope and a seller a wrong role (403); then one missing prerequisite at a time — a manifest entry of an agency that already purchased or of another seller's claim TAIL_NOT_ENUMERATED, a manifest of unclaimed scraped prospects TAIL_NOT_ENUMERATED, no termination terms TERMINATION_TERMS_UNPREPARED, a stale version — nothing is written", async () => {
  const { w } = pw;
  const d = await departing("cmd050-deny");
  const thief = await departing("cmd050-deny-other");
  const entitled = await entitledAgency(d.seller, "cmd050-deny-purchased");
  void entitled;
  // an opportunity accepted for an agency that then made a qualifying purchase: no longer an opportunity to hand over
  const sold = await sellingAgency(pw, "cmd050-deny-sold");
  const soldProspect = await recordProspect(w.h, { by: d.seller, domain: "cmd050-deny-sold.example" });
  const soldClaim = await recordClaim(w.h, { seller: d.seller, prospectId: soldProspect.prospectId });
  await recordFrozenAllocation(w.h, { ownerUserId: ownerId(), agencyId: sold.agency.agencyId, prospectId: soldProspect.prospectId, shares: [{ seller: d.seller, claimId: soldClaim.claimId, shareBps: 10000 }] });
  await paidProject(pw, sold, "cmd050-deny-sold-first");
  const scraped = await scrapedProspects(w.h, d.seller, 3);

  const before = await footprint(d.seller.sellerId);
  const beforeOther = await footprint(thief.seller.sellerId);
  const good = await prepared(d.seller.sellerId, [d.listed[0].claimId]);
  const refused = async (what: string, reply: Promise<Reply>, expected: string): Promise<Reply> => {
    const r = await reply;
    assert.equal(outcome(w, r), expected, what);
    assert.deepEqual(await footprint(d.seller.sellerId), before, `${what}: nothing was written for the seller`);
    assert.deepEqual(await footprint(thief.seller.sellerId), beforeOther, `${what}: nothing was written for any other seller`);
    return r;
  };

  // an agency member's tenant session is a foreign scope, a seller a wrong role: the same refusal, a durable fact of the caller's stream
  const member = await w.person("cmd050-deny-member");
  await w.h.addMember(w.A, member.userId, "BILLING");
  const denials = (await w.securityEvents("CMD050")).length;
  await refused("an agency member", terminate(d.seller.sellerId, good, { token: member.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  await refused("the seller itself", terminate(d.seller.sellerId, good, { token: d.person.token }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w.securityEvents("CMD050")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]]);
  assert.equal(outcome(w, await terminate(ids.next(), good)), "404 NOT_FOUND -");

  // one missing prerequisite at a time: a manifest entry of an agency that already purchased, of another seller's claim, of a prospect
  // nobody claimed, of an expired or unaccepted claim; then no termination terms, terms of another seller, a stale version
  for (const [what, entries] of [
    ["an agency that already purchased", [d.listed[0].claimId, soldClaim.claimId]],
    ["another seller's claim", [d.listed[0].claimId, thief.listed[0].claimId]],
    ["unclaimed scraped prospects", scraped],
    ["a claim still SUBMITTED", [d.listed[0].claimId, d.submitted.claimId]],
    ["an unknown claim", [ids.next()]],
  ] as const) {
    await refused(what, terminate(d.seller.sellerId, await prepared(d.seller.sellerId, entries)), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED");
  }
  const manifestOfOther = await prepareManifest(w.h, ownerId(), thief.seller.sellerId, [thief.listed[0].claimId]);
  await refused("another seller's manifest", terminate(d.seller.sellerId, { ...good, activeOpportunityManifestRef: manifestOfOther }), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED");
  await refused("an unknown manifest", terminate(d.seller.sellerId, { ...good, activeOpportunityManifestRef: ids.next() }), "409 PRECONDITION_FAILED TAIL_NOT_ENUMERATED");
  await refused("no termination terms", terminate(d.seller.sellerId, { ...good, terminationTermsRef: ids.next() }), "409 PRECONDITION_FAILED TERMINATION_TERMS_UNPREPARED");
  const termsOfOther = await prepareTerminationTerms(w.h, ownerId(), thief.seller.sellerId);
  await refused("another seller's terms", terminate(d.seller.sellerId, { ...good, terminationTermsRef: termsOfOther }), "409 PRECONDITION_FAILED TERMINATION_TERMS_UNPREPARED");
  const stale = await refused("a stale version", terminate(d.seller.sellerId, { ...good, expectedVersion: 1 }), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, stale).current, { version: 2, state: "ACTIVE" });
  // a CANDIDATE seller is not terminated by this command
  const candidate = await candidateSeller(w.h, ownerId(), "cmd050-deny-candidate");
  const candidateBody = await prepared(candidate.sellerId, []);
  assert.equal(outcome(w, await terminate(candidate.sellerId, { ...candidateBody, expectedVersion: 1 })), "409 PRECONDITION_FAILED UNLISTED_TRANSITION");
  assert.equal((await sellerRow(candidate.sellerId)).state, "CANDIDATE");
  // nothing is deletable: the privilege matrix has no DELETE for the runtime roles on the ledger and the termination's records
  assert.equal(await w.count("termination_tail_entries", "seller_id = ANY($1::uuid[])", [[d.seller.sellerId, thief.seller.sellerId]]), 0);

  // the same request, correct, is accepted: the refusals above were the only obstacle
  completed<SellerTerminationView>(await terminate(d.seller.sellerId, good), 200);
  assert.equal((await sellerRow(d.seller.sellerId)).state, "TERMINATED");
});

test("RACE: an identical retry replays the 200, the same key with another manifest is 409 IDEMPOTENCY_CONFLICT, two terminations on one expectedVersion yield one TERMINATED seller and one 409 STALE_VERSION with the wait observed, and a crash before COMMIT leaves the seller ACTIVE with its claims and entitlements unchanged", async () => {
  const { w } = pw;
  // an identical retry replays the 200 byte for byte and terminates once; the same key with another manifest is another request
  const d = await departing("cmd050-race");
  const key = freshKey("cmd050-race");
  const body = await prepared(d.seller.sellerId, [d.listed[0].claimId, d.listed[1].claimId]);
  const first = await terminate(d.seller.sellerId, body, { key });
  completed<SellerTerminationView>(first, 200);
  const replay = await terminate(d.seller.sellerId, body, { key });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal((await sellerRow(d.seller.sellerId)).version, "2", "the replay terminated nothing a second time");
  const other = await prepareManifest(w.h, ownerId(), d.seller.sellerId, [d.listed[0].claimId]);
  assert.equal(outcome(w, await terminate(d.seller.sellerId, { ...body, activeOpportunityManifestRef: other }, { key })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal(await w.count("termination_tail_entries", "seller_id = $1", [d.seller.sellerId]), 2, "the conflicting request had no effect");

  // two terminations on one expectedVersion: the first holds the seller's row until its commit; the second waits for it (observed in
  // pg_stat_activity), reads the moved version and is stale
  const two = await departing("cmd050-race-two");
  const bodyA = await prepared(two.seller.sellerId, [two.listed[0].claimId]);
  const bodyB = await prepared(two.seller.sellerId, [two.listed[1].claimId]);
  const hold = w.holds.arm("journal.commit");
  const winner = terminate(two.seller.sellerId, bodyA);
  await hold.reached;
  const loser = terminate(two.seller.sellerId, bodyB);
  try {
    await waitForApiLockWait(w, "FROM kauro.sellers");
  } finally {
    hold.release();
  }
  const [won, lost] = await Promise.all([winner, loser]);
  completed<SellerTerminationView>(won, 200);
  assert.equal(outcome(w, lost), "409 STALE_VERSION -");
  assert.deepEqual(asProblem(w, lost).current, { version: 2, state: "TERMINATED" });
  assert.equal((await sellerRow(two.seller.sellerId)).state, "TERMINATED");
  assert.equal(await w.count("seller_terminations", "seller_id = $1 AND effective_at IS NOT NULL", [two.seller.sellerId]), 1, "one termination became effective");
  assert.equal(await w.count("termination_tail_entries", "seller_id = $1", [two.seller.sellerId]), 1);

  // a crash at the intent/commit boundary: the termination was written and never committed; the seller stays ACTIVE with its claims and
  // entitlements as they were
  const crashing = await departing("cmd050-race-crash");
  await entitledAgency(crashing.seller, "cmd050-race-crash-entitled");
  const crashBody = await prepared(crashing.seller.sellerId, [crashing.listed[0].claimId]);
  const crashKey = freshKey("cmd050-crash");
  const before = await footprint(crashing.seller.sellerId);
  w.holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await terminate(crashing.seller.sellerId, crashBody, { key: crashKey });
  assert.equal(outcome(w, crashed), "500 INTERNAL_ERROR -");
  assert.deepEqual(await footprint(crashing.seller.sellerId), before, "the seller is ACTIVE with its claims, entitlements, prospects and assignments unchanged");
  assert.equal(await w.journal(crashKey), null);
  completed<SellerTerminationView>(await terminate(crashing.seller.sellerId, crashBody, { key: crashKey }), 200);
  assert.equal((await sellerRow(crashing.seller.sellerId)).state, "TERMINATED");
});
