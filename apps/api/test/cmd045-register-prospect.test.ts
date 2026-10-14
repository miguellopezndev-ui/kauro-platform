// CMD045 RegisterProspect — POST /api/v1/sales/prospects — an ACTIVE seller or the corporate owner — scope CORPORATE (package B10, mandate
// B10-COMMANDS-PROSPECTS; docs/design/B10-case-map.md CMD045-OK, CMD045-DENY, CMD045-RACE; design §5, §12; decision D10-PROS-1; registry
// "create a minimized prospect without granting customer data access or automatic attribution"; "a suppressed identity cannot be
// reactivated through spelling or duplicate-list import"). The real route, the real authorizers, the sales adapters and PostgreSQL 17
// through the runtime login roles; the superuser only reads. The sellers are recorded with every activation fact by the corporate owner,
// the source evidence and contacts by their registrars, the suppressions by the owner (test/sales-support.ts).
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProspectView } from "@kauro/application";
import { organizationKeyOf } from "@kauro/domain";
import { asOperator, recordSourceEvidence, salesWorld, suppress, type SalesWorld } from "./sales-support.js";
import { SimulatedCrash, asProblem, call, completed, freshKey, ids, outcome, replayTextOf, waitForApiLockWait, type Person } from "./support.js";

let sw: SalesWorld;
// the B10 state oracle after every test of this file (B10-KIT-SUITES section 2)
invariantsAfterEach(() => sw.w.h.oracle);
before(async () => {
  sw = await salesWorld({}, "cmd045");
});
after(async () => {
  await sw.stop();
});

const URL = "/api/v1/sales/prospects";
const w = () => sw.w;

interface Request {
  readonly token?: string;
  readonly key?: string;
  readonly agency?: string | null;
  readonly body?: Record<string, unknown>;
}

const register = (who: Person, options: Request = {}) => call(w(), { url: URL, token: options.token ?? who.token, agency: options.agency === undefined ? null : options.agency, key: options.key ?? freshKey("cmd045"), body: options.body });

const bodyOf = (label: string, evidence: { readonly sourceEvidenceHash: string; readonly contactRef: string }, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  organizationLabel: label,
  businessContactRef: evidence.contactRef,
  sourceEvidenceHash: evidence.sourceEvidenceHash,
  jurisdiction: "United States",
  ...overrides,
});

/** A new ACTIVE seller of its own and the evidence and contact it recorded for a business domain. */
async function sellerWith(label: string, domain: string) {
  const seller = await sw.seller(label);
  const evidence = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain });
  return { seller, evidence };
}

const prospectRow = async (organizationKey: string) =>
  (await w().h.oracle.query<{ prospect_id: string; state: string; version: string; owner_seller_id: string | null; registered_by_seller_id: string | null; registered_by_user_id: string; source_evidence_hash: string; business_contact_id: string | null }>(
    "SELECT prospect_id, state, version::text AS version, owner_seller_id, registered_by_seller_id, registered_by_user_id, source_evidence_hash, business_contact_id FROM kauro.prospects WHERE organization_key = $1",
    [organizationKey],
  )).rows;

const keyOf = (domain: string): string => organizationKeyOf(domain)?.key ?? "";

/** The rows a registration writes or must leave alone: prospects, claims, allocations and the journal's CMD045 entries. */
const footprint = async () => ({
  prospects: await w().count("prospects"),
  claims: await w().count("attribution_claims"),
  allocations: await w().count("attribution_allocations"),
  journal: await w().count("command_journal", "operation = 'CMD045'"),
});

test("OK: an ACTIVE seller registers a prospect from its own AGENCY-segment source evidence and business contact — 201 with one RESEARCHED prospect owned by the seller, its organization key, no claim, no attribution, and a view without contact details or customer data; the owner may register one too", async () => {
  const { seller, evidence } = await sellerWith("cmd045-ok", "acme-agency.example");
  const key = freshKey("cmd045-ok");
  const claimsBefore = await w().count("attribution_claims");
  const reply = completed<ProspectView>(await register(seller.person, { key, body: bodyOf("acme-agency.example", evidence) }), 201);
  assert.equal(reply.version, 1);
  assert.equal(reply.replayed, false);
  // the minimized view: the prospect's own members only — no contact detail, no customer data, no claim or attribution
  assert.deepEqual(Object.keys(reply.data).sort(), ["jurisdiction", "organizationLabel", "ownerSellerId", "prospectId", "sourceEvidenceHash", "state", "suppressed"]);
  assert.deepEqual(
    [reply.data.organizationLabel, reply.data.sourceEvidenceHash, reply.data.jurisdiction, reply.data.state, reply.data.suppressed, reply.data.ownerSellerId],
    ["acme-agency.example", evidence.sourceEvidenceHash, "United States", "RESEARCHED", false, seller.sellerId],
  );
  // exactly one prospect row, RESEARCHED at version 1, owned by the registering seller under its organization key and its own evidence
  const rows = await prospectRow(keyOf("acme-agency.example"));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0]!, prospect_id: rows[0]!.prospect_id === reply.data.prospectId },
    { prospect_id: true, state: "RESEARCHED", version: "1", owner_seller_id: seller.sellerId, registered_by_seller_id: seller.sellerId, registered_by_user_id: seller.userId, source_evidence_hash: evidence.sourceEvidenceHash, business_contact_id: evidence.contactRef },
  );
  assert.equal(await w().count("attribution_claims"), claimsBefore, "registration submits no claim");
  assert.equal(await w().count("attribution_claims", "prospect_id = $1", [reply.data.prospectId]), 0);
  assert.equal(await w().count("attribution_allocations", "prospect_id = $1", [reply.data.prospectId]), 0, "and grants no attribution");
  const journal = await w().journal(key);
  assert.deepEqual([journal?.state, journal?.status, journal?.resourceKind, journal?.resourceId], ["COMMITTED", 201, "prospect", reply.data.prospectId]);

  // the owner may register one too, from its own evidence: owned by nobody, registered by no seller
  const ownerEvidence = await recordSourceEvidence(w().h, { userId: sw.owner.userId }, { domain: "owner-found.example" });
  const ownerReply = completed<ProspectView>(await register(sw.owner, { body: bodyOf("owner-found.example", ownerEvidence) }), 201);
  assert.equal(ownerReply.data.ownerSellerId, undefined);
  assert.equal(ownerReply.data.state, "RESEARCHED");
  const ownerRows = await prospectRow(keyOf("owner-found.example"));
  assert.deepEqual([ownerRows.length, ownerRows[0]?.owner_seller_id, ownerRows[0]?.registered_by_seller_id, ownerRows[0]?.registered_by_user_id], [1, null, null, sw.owner.userId]);
});

test("DENY: an agency member's tenant session is a foreign scope and a CANDIDATE or TERMINATED seller a wrong role (403); then one missing prerequisite at a time — source evidence of another seller or segment SOURCE_EVIDENCE_INVALID, an organization spelled differently but suppressed by organization or contact key PROSPECT_SUPPRESSED, a live duplicate PROSPECT_EXISTS — nothing is written", async () => {
  const { seller, evidence } = await sellerWith("cmd045-deny", "deny-base.example");
  const other = await sellerWith("cmd045-deny-other", "deny-other.example");
  /** Refuses with the outcome and writes nothing: the same rows, no journal entry for the key. */
  const refused = async (what: string, request: (key: string) => ReturnType<typeof register>, expected: string) => {
    const before = await footprint();
    const key = freshKey("cmd045-deny");
    const reply = await request(key);
    assert.equal(outcome(w(), reply), expected, what);
    assert.deepEqual(await footprint(), before, `${what}: nothing is written`);
    assert.equal(await w().journal(key), null, `${what}: no journal entry`);
    return reply;
  };

  // an agency member's tenant session is a foreign scope: the corporate scope holds neither its role nor an agency; a CANDIDATE and a
  // TERMINATED seller hold no ACTIVE row — one answer for all, which reveals nothing of a seller's state
  const denials = (await w().securityEvents("CMD045")).length;
  const member = await refused("an agency member's tenant session", (key) => register(w().owner, { key, agency: w().A.agencyId, body: bodyOf("deny-base.example", evidence) }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  const candidate = await w().person("cmd045-candidate");
  await asOperator(w().h, sw.owner.userId, (c) =>
    c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'Candidate seller', $3, now(), now())", [ids.next(), candidate.userId, sw.owner.userId]),
  );
  await refused("a CANDIDATE seller", (key) => register(candidate, { key, body: bodyOf("deny-base.example", evidence) }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  const terminated = await w().person("cmd045-terminated");
  await asOperator(w().h, sw.owner.userId, async (c) => {
    await c.query("INSERT INTO kauro.sellers (seller_id, user_id, display_label, created_by_user_id, created_at, updated_at) VALUES ($1, $2, 'Terminated seller', $3, now(), now())", [ids.next(), terminated.userId, sw.owner.userId]);
    await c.query("UPDATE kauro.sellers SET state = 'TERMINATED', terminated_at = kauro.server_now(), version = version + 1 WHERE user_id = $1", [terminated.userId]);
  });
  await refused("a TERMINATED seller", (key) => register(terminated, { key, body: bodyOf("deny-base.example", evidence) }), "403 NOT_AUTHORIZED CORPORATE_ROLE_MISSING");
  assert.deepEqual((await w().securityEvents("CMD045")).slice(denials).map((f) => [f.outcome, f.reason]), [["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"], ["DENY", "CORPORATE_ROLE_MISSING"]], "each wrong role is a durable DENY fact");
  assert.equal(asProblem(w(), member).code, "NOT_AUTHORIZED");

  // another seller's evidence (and its contact), an evidence hash nobody recorded and a contact that is not the caller's own
  await refused("another seller's source evidence", (key) => register(seller.person, { key, body: bodyOf("deny-base.example", other.evidence, { businessContactRef: evidence.contactRef }) }), "409 PRECONDITION_FAILED SOURCE_EVIDENCE_INVALID");
  await refused("an unknown source evidence", (key) => register(seller.person, { key, body: bodyOf("deny-base.example", evidence, { sourceEvidenceHash: "0".repeat(64) }) }), "409 PRECONDITION_FAILED SOURCE_EVIDENCE_INVALID");
  await refused("another seller's business contact", (key) => register(seller.person, { key, body: bodyOf("deny-base.example", evidence, { businessContactRef: other.evidence.contactRef }) }), "409 PRECONDITION_FAILED SOURCE_EVIDENCE_INVALID");

  // an organization spelled differently but suppressed: by its organization key, and by its contact key under another organization
  await suppress(w().h, sw.owner.userId, { domain: "suppressed-org.example" });
  const spelled = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "suppressed-org.example" });
  await refused("a suppressed organization, spelled in capitals with a www. and a trailing dot", (key) => register(seller.person, { key, body: bodyOf("WWW.Suppressed-Org.Example.", spelled) }), "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED");
  const contactKey = "c".repeat(64);
  await suppress(w().h, sw.owner.userId, { contactKey });
  const suppressedContact = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "innocent-org.example", contactKey });
  await refused("a suppressed contact under another organization", (key) => register(seller.person, { key, body: bodyOf("innocent-org.example", suppressedContact) }), "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED");
  assert.equal((await prospectRow(keyOf("suppressed-org.example"))).length, 0);
  assert.equal((await prospectRow(keyOf("innocent-org.example"))).length, 0);

  // a live duplicate: the organization registered once is not registered again under any spelling
  completed<ProspectView>(await register(seller.person, { body: bodyOf("deny-base.example", evidence) }), 201);
  const again = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "deny-base.example" });
  await refused("a live duplicate under another spelling", (key) => register(seller.person, { key, body: bodyOf("www.DENY-BASE.example", again) }), "409 PRECONDITION_FAILED PROSPECT_EXISTS");
  assert.equal((await prospectRow(keyOf("deny-base.example"))).length, 1, "one live prospect per organization key");
});

test("OK (D-33): an ACTIVE seller registers a company prospect from its own COMPANY-segment source evidence — 201 with one RESEARCHED prospect owned by the seller under the same minimized view, no claim and no attribution; an AGENCY and a COMPANY record of one domain share its organization key, so the second is PROSPECT_EXISTS", async () => {
  const seller = await sw.seller("cmd045-company");
  const evidence = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "northwind-company.example", segment: "COMPANY" });
  const before = await footprint();
  const reply = completed<ProspectView>(await register(seller.person, { body: bodyOf("northwind-company.example", evidence) }), 201);
  assert.deepEqual(Object.keys(reply.data).sort(), ["jurisdiction", "organizationLabel", "ownerSellerId", "prospectId", "sourceEvidenceHash", "state", "suppressed"], "the same minimized view as an agency prospect");
  assert.deepEqual([reply.data.state, reply.data.ownerSellerId, reply.data.sourceEvidenceHash], ["RESEARCHED", seller.sellerId, evidence.sourceEvidenceHash]);
  const rows = await prospectRow(keyOf("northwind-company.example"));
  assert.deepEqual(rows.map((r) => [r.state, r.owner_seller_id, r.source_evidence_hash]), [["RESEARCHED", seller.sellerId, evidence.sourceEvidenceHash]]);
  const after = await footprint();
  assert.deepEqual([after.prospects - before.prospects, after.claims - before.claims, after.allocations - before.allocations], [1, 0, 0], "one prospect, no claim, no attribution");
  // the segment is not part of the organization key: an agency record of the same domain cannot open a second live prospect
  const agencyRecord = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "northwind-company.example", segment: "AGENCY" });
  assert.equal(outcome(w(), await register(seller.person, { body: bodyOf("www.northwind-company.example", agencyRecord) })), "409 PRECONDITION_FAILED PROSPECT_EXISTS");
});

test("DENY (D-33): the protections stand for company prospects — another seller's COMPANY-segment evidence is SOURCE_EVIDENCE_INVALID, a suppressed company by organization or contact key is PROSPECT_SUPPRESSED, and nothing is written", async () => {
  const seller = await sw.seller("cmd045-company-deny");
  const other = await sw.seller("cmd045-company-deny-other");
  const mine = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "company-deny.example", segment: "COMPANY" });
  const theirs = await recordSourceEvidence(w().h, { userId: other.userId, sellerId: other.sellerId }, { domain: "company-deny.example", segment: "COMPANY" });
  const refused = async (what: string, body: Record<string, unknown>, expected: string) => {
    const before = await footprint();
    const key = freshKey("cmd045-company-deny");
    assert.equal(outcome(w(), await register(seller.person, { key, body })), expected, what);
    assert.deepEqual(await footprint(), before, `${what}: nothing is written`);
    assert.equal(await w().journal(key), null, `${what}: no journal entry`);
  };
  await refused("another seller's COMPANY evidence", bodyOf("company-deny.example", theirs, { businessContactRef: mine.contactRef }), "409 PRECONDITION_FAILED SOURCE_EVIDENCE_INVALID");
  await suppress(w().h, sw.owner.userId, { domain: "suppressed-company.example" });
  const suppressedOrg = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "suppressed-company.example", segment: "COMPANY" });
  await refused("a suppressed company", bodyOf("Suppressed-Company.example", suppressedOrg), "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED");
  const contactKey = "d".repeat(64);
  await suppress(w().h, sw.owner.userId, { contactKey });
  const suppressedContact = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain: "company-contact.example", segment: "COMPANY", contactKey });
  await refused("a company whose contact is suppressed", bodyOf("company-contact.example", suppressedContact), "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED");
  assert.equal((await prospectRow(keyOf("company-deny.example"))).length, 0);
});

test("RACE: an identical retry replays the 201, the same key with another organizationLabel is 409 IDEMPOTENCY_CONFLICT, two sellers registering one organization at once yield one prospect and one 409 PROSPECT_EXISTS with the wait observed, and a crash before COMMIT leaves no prospect", async () => {
  const a = await sellerWith("cmd045-race-a", "retry.example");
  const key = freshKey("cmd045-race");
  const body = bodyOf("retry.example", a.evidence);

  // a crash at the intent/commit boundary: the prospect and the journal entry were written and never committed
  w().holds.arm("journal.commit", { fail: new SimulatedCrash("before COMMIT") });
  const crashed = await register(a.seller.person, { key, body });
  assert.equal(outcome(w(), crashed), "500 INTERNAL_ERROR -");
  assert.equal((await prospectRow(keyOf("retry.example"))).length, 0);
  assert.equal(await w().journal(key), null);

  // the retry under the same key registers it once; the identical retry replays the journaled 201 byte for byte
  const first = await register(a.seller.person, { key, body });
  completed<ProspectView>(first, 201);
  assert.equal((await prospectRow(keyOf("retry.example"))).length, 1);
  const replay = await register(a.seller.person, { key, body });
  assert.equal(replay.status, 201, replay.text);
  assert.equal(replay.text, replayTextOf(first));
  assert.equal(completed<ProspectView>(replay, 201).version, 1);
  assert.equal((await prospectRow(keyOf("retry.example"))).length, 1, "the replay registered no second prospect");

  // the same key with another organizationLabel is another request: a conflict, and nothing happens
  const elsewhere = await recordSourceEvidence(w().h, { userId: a.seller.userId, sellerId: a.seller.sellerId }, { domain: "elsewhere.example" });
  assert.equal(outcome(w(), await register(a.seller.person, { key, body: bodyOf("elsewhere.example", elsewhere) })), "409 IDEMPOTENCY_CONFLICT REQUEST_DIGEST_DIFFERS");
  assert.equal((await prospectRow(keyOf("elsewhere.example"))).length, 0);

  // two sellers registering one organization at once: A holds inside its unit of work with the prospect written; B cannot see it, so it
  // blocks on the live-prospect unique index (observed in pg_stat_activity), and after A commits answers PROSPECT_EXISTS
  const sellerB = await sw.seller("cmd045-race-b");
  const evidenceA = await recordSourceEvidence(w().h, { userId: a.seller.userId, sellerId: a.seller.sellerId }, { domain: "contested.example" });
  const evidenceB = await recordSourceEvidence(w().h, { userId: sellerB.userId, sellerId: sellerB.sellerId }, { domain: "contested.example" });
  const hold = w().holds.arm("journal.commit");
  const requestA = register(a.seller.person, { body: bodyOf("contested.example", evidenceA) });
  await hold.reached;
  const requestB = register(sellerB.person, { body: bodyOf("www.contested.example", evidenceB) });
  try {
    await waitForApiLockWait(w(), "INSERT INTO kauro.prospects");
  } finally {
    hold.release();
  }
  const [ra, rb] = await Promise.all([requestA, requestB]);
  completed<ProspectView>(ra, 201);
  assert.equal(outcome(w(), rb), "409 PRECONDITION_FAILED PROSPECT_EXISTS");
  const rows = await prospectRow(keyOf("contested.example"));
  assert.deepEqual(rows.map((r) => r.owner_seller_id), [a.seller.sellerId], "one prospect, the first seller's");
});
