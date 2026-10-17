// B12 lane L-SOURCE: RecordProspectSource and RecordProspectContact (plan docs/design/B12-outreach-plan-cells.md section R, B12-1 and B12-2;
// GAP-PS-1, GAP-PS-2, GAP-PK-1..3; plan A14 contact key KAURO_PROSPECT_CONTACT_V1 of the case-folded NFC address). The real routes, the real
// authorizers, the sales adapters and PostgreSQL 17 through the runtime login roles; the superuser only reads. D-33: both segments are
// recorded and nothing here reads the segment to rank.
import { invariantsAfterEach } from "@kauro/persistence/testing";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ProspectContactView, ProspectSourceView, ProspectView } from "@kauro/application";
import { contactKeyOf } from "@kauro/domain";
import { asOperator, recordSourceEvidence, salesWorld, suppress, terminateSeller, type SalesWorld } from "./sales-support.js";
import { asProblem, call, completed, freshKey, outcome, sha, type Person } from "./support.js";

let sw: SalesWorld;
invariantsAfterEach(() => sw.w.h.oracle);
before(async () => {
  sw = await salesWorld({}, "b12src");
});
after(async () => {
  await sw.stop();
});
const w = () => sw.w;

const record = (who: Person, prospectId: string, leaf: "sources" | "contacts", body: Record<string, unknown>, key = freshKey("b12src")) =>
  call(w(), { url: `/api/v1/ops/prospects/${prospectId}/${leaf}`, token: who.token, agency: null, key, body });

/** A seller with a registered prospect of its own (CMD045 over fixture evidence). */
async function sellerWithProspect(label: string, domain: string) {
  const seller = await sw.seller(label);
  const evidence = await recordSourceEvidence(w().h, { userId: seller.userId, sellerId: seller.sellerId }, { domain });
  const reply = completed<ProspectView>(
    await call(w(), {
      url: "/api/v1/sales/prospects",
      token: seller.person.token,
      agency: null,
      key: freshKey("b12src-reg"),
      body: { organizationLabel: domain, businessContactRef: evidence.contactRef, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction: "United States" },
    }),
    201,
  );
  return { seller, prospectId: reply.data.prospectId };
}

const sourceBody = (name: string, overrides: Record<string, unknown> = {}) => ({
  evidenceHash: sha(`b12src-ev-${name}`),
  sourceUrlDigest: sha(`b12src-url-${name}`),
  observedOn: "2026-01-15",
  lawfulBasis: "LEGITIMATE_INTEREST",
  segment: "COMPANY",
  ...overrides,
});
const rows = async (table: string) => w().count(table);

test("RecordProspectSource OK: a seller records COMPANY and AGENCY evidence for its own prospect and the owner for any: 201 with the evidence view (no source URL), one append-only row per record, the replay answers the same row", async () => {
  const { seller, prospectId } = await sellerWithProspect("src-ok", "src-ok.example");
  const before = await rows("prospect_source_evidence");
  const key = freshKey("b12src-ok");
  const body = sourceBody("ok");
  const first = completed<ProspectSourceView>(await record(seller.person, prospectId, "sources", body, key), 201);
  assert.deepEqual(Object.keys(first.data).sort(), ["createdAt", "evidenceHash", "evidenceId", "observedOn", "segment"]);
  assert.equal(first.data.segment, "COMPANY");
  assert.equal(await rows("prospect_source_evidence"), before + 1);
  const replay = completed<ProspectSourceView>(await record(seller.person, prospectId, "sources", body, key), 201);
  assert.equal(replay.replayed, true);
  assert.equal(replay.data.evidenceId, first.data.evidenceId);
  assert.equal(await rows("prospect_source_evidence"), before + 1);
  const agency = completed<ProspectSourceView>(await record(seller.person, prospectId, "sources", sourceBody("ok-agency", { segment: "AGENCY" })), 201);
  assert.equal(agency.data.segment, "AGENCY");
  const byOwner = completed<ProspectSourceView>(await record(sw.owner, prospectId, "sources", sourceBody("ok-owner")), 201);
  assert.notEqual(byOwner.data.evidenceId, first.data.evidenceId);
});

test("RecordProspectSource DENY: another seller's prospect and an unknown id are 404, a TERMINATED seller 403 (GAP-PS-1), an observation dated after the database instant is SOURCE_EVIDENCE_INVALID (GAP-PS-2): nothing is written", async () => {
  const { seller, prospectId } = await sellerWithProspect("src-deny", "src-deny.example");
  const other = await sw.seller("src-deny-other");
  const before = await rows("prospect_source_evidence");
  assert.equal((await record(other.person, prospectId, "sources", sourceBody("d1"))).status, 404);
  assert.equal((await record(seller.person, "01990000-0000-7000-8000-000000000000", "sources", sourceBody("d2"))).status, 404);
  const future = await record(seller.person, prospectId, "sources", sourceBody("d3", { observedOn: "2999-01-01" }));
  assert.equal(outcome(w(), future), "409 PRECONDITION_FAILED SOURCE_EVIDENCE_INVALID");
  await terminateSeller(sw, seller);
  const terminated = await record(seller.person, prospectId, "sources", sourceBody("d4"));
  assert.equal(terminated.status, 403);
  assert.equal(asProblem(w(), terminated).code, "NOT_AUTHORIZED");
  assert.equal(await rows("prospect_source_evidence"), before);
});

test("RecordProspectContact OK: the contact key is KAURO_PROSPECT_CONTACT_V1 of the case-folded NFC address, the address is stored restricted, the view carries neither", async () => {
  const { seller, prospectId } = await sellerWithProspect("pk-ok", "pk-ok.example");
  const reply = completed<ProspectContactView>(await record(seller.person, prospectId, "contacts", { contactLabel: "Head of growth", roleLabel: "Growth", channel: "EMAIL", address: "Lead@PK-OK.example" }), 201);
  assert.deepEqual(Object.keys(reply.data).sort(), ["channel", "contactId", "createdAt"]);
  const expected = contactKeyOf("lead@pk-ok.example");
  assert.notEqual(expected, null);
  const stored = await w().h.oracle.query<{ contact_key: string; address: string }>(
    "SELECT c.contact_key, a.address FROM kauro.prospect_contacts c JOIN kauro.prospect_contact_addresses a USING (contact_id) WHERE c.contact_id = $1",
    [reply.data.contactId],
  );
  assert.deepEqual(stored.rows, [{ contact_key: expected?.key, address: "lead@pk-ok.example" }]);
});

test("GAP-PK-1 and reimport: one address recorded by two sellers in other case gives two contact rows and one key; after an opt-out of that key CMD045 is 409 PROSPECT_SUPPRESSED", async () => {
  const a = await sellerWithProspect("pk-a", "pk-a.example");
  const b = await sellerWithProspect("pk-b", "pk-b.example");
  const [ra, rb] = await Promise.all([
    record(a.seller.person, a.prospectId, "contacts", { contactLabel: "Contact A", channel: "EMAIL", address: "Shared@Reimport.example" }),
    record(b.seller.person, b.prospectId, "contacts", { contactLabel: "Contact B", channel: "EMAIL", address: "shared@reimport.example" }),
  ]);
  const ca = completed<ProspectContactView>(ra, 201);
  const cb = completed<ProspectContactView>(rb, 201);
  assert.notEqual(ca.data.contactId, cb.data.contactId);
  const keys = await w().h.oracle.query<{ contact_key: string }>("SELECT DISTINCT contact_key FROM kauro.prospect_contacts WHERE contact_id = ANY($1)", [[ca.data.contactId, cb.data.contactId]]);
  assert.equal(keys.rows.length, 1);
  await suppress(w().h, sw.owner.userId, { contactKey: keys.rows[0]?.contact_key ?? "" });
  const evidence = await recordSourceEvidence(w().h, { userId: b.seller.userId, sellerId: b.seller.sellerId }, { domain: "reimport-new.example" });
  const register = await call(w(), {
    url: "/api/v1/sales/prospects",
    token: b.seller.person.token,
    agency: null,
    key: freshKey("b12src-re"),
    body: { organizationLabel: "reimport-new.example", businessContactRef: cb.data.contactId, sourceEvidenceHash: evidence.sourceEvidenceHash, jurisdiction: "United States" },
  });
  assert.equal(outcome(w(), register), "409 PRECONDITION_FAILED PROSPECT_SUPPRESSED");
});

test("RecordProspectContact DENY: a foreign prospect is 404 and a non-address is a schema violation, nothing written (GAP-PK-3 leaves neither contact nor address)", async () => {
  const { seller, prospectId } = await sellerWithProspect("pk-deny", "pk-deny.example");
  const other = await sw.seller("pk-deny-other");
  const contacts = await rows("prospect_contacts");
  const addresses = await rows("prospect_contact_addresses");
  assert.equal((await record(other.person, prospectId, "contacts", { contactLabel: "X", channel: "EMAIL", address: "x@pk-deny.example" })).status, 404);
  assert.equal((await record(seller.person, prospectId, "contacts", { contactLabel: "X", channel: "EMAIL", address: "not-an-address" })).status, 400);
  assert.equal(await rows("prospect_contacts"), contacts);
  assert.equal(await rows("prospect_contact_addresses"), addresses);
});

test("todo: DENY (reassignment), DENY (provider change), DENY (CRM), GAP-PK-2 and GAP-PS-1 held at L1 in both orders, crash cells", { todo: "depends on the L-DRAFT/L-SEND handlers and the raceAtWrite harness; not run in the owner sprint" }, () => {});
