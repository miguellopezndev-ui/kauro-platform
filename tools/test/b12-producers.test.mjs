// Producer census (rule 1b; companion docs/design/B12-outreach-plan-cells.md §S, §P; lane K1): every table a B10 or B12 command reads
// has a non-fixture writer (an INSERT INTO kauro.<t> in packages/*/src or apps/*/src outside testing, or in a migration) or a named
// owner lane that will land it. The residual of tables with neither is an exact list, so a new unwritten read fails.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { b12Sources, insertedTables, migrationTexts, productSources, read, readTables, root } from "./b12-static.mjs";

/** The lanes of plan §9 that land the writer of a table no product code writes yet. */
const OWNER_LANE = Object.freeze({
  sender_identities: "L-SEND",
  outreach_provider_warnings: "L-SEND",
  outreach_send_evidence: "L-SEND",
  outreach_contents: "L-DRAFT",
  sales_resources: "L-DRAFT",
  sales_resource_capabilities: "L-DRAFT",
  outreach_drafts: "L-DRAFT",
  outreach_draft_resources: "L-DRAFT",
  outreach_reviews: "L-AUTH",
  outreach_review_items: "L-AUTH",
  outreach_authorizations: "L-AUTH",
  outreach_authorization_hashes: "L-AUTH",
  outreach_diagnoses: "L-ACT",
  prospect_contact_addresses: "L-SOURCE",
  prospect_source_evidence: "L-SOURCE",
  prospect_contacts: "L-SOURCE",
  // companion §P (L-OWNER)
  sellers: "L-OWNER",
  seller_legal_reviews: "L-OWNER",
  seller_agreements: "L-OWNER",
  seller_assessments: "L-OWNER",
  seller_confidentiality_acceptances: "L-OWNER",
  seller_tax_documents: "L-OWNER",
  seller_payout_destinations: "L-OWNER",
  service_assignments: "L-OWNER",
  assistance_agreements: "L-OWNER",
  seller_terminations: "L-OWNER",
  termination_manifests: "L-OWNER",
});
/** Read by a B10 command, written by no product code and named by no B12 lane: an open producer gap reported to the coordinator. */
const UNOWNED = Object.freeze(["allocation_shares", "attribution_allocations", "claim_evidence", "corporate_roles", "service_agreement_versions"]);

function written() {
  const out = new Set();
  for (const f of productSources()) for (const t of insertedTables(read(f))) out.add(t);
  for (const sql of migrationTexts()) for (const t of insertedTables(sql, true)) out.add(t);
  return out;
}

/** The B10 and B12 command readers: the B12 sources and the B10 commercial repositories. */
function readers() {
  const b10 = readdirSync(join(root, "packages/persistence/src/repositories"))
    .filter((f) => f.startsWith("commercial-"))
    .map((f) => `packages/persistence/src/repositories/${f}`);
  return [...new Set([...b12Sources(), ...b10])].map((file) => ({ file, text: read(file) }));
}

/** A set-returning function read FROM kauro.f(...) is not a table. */
const functions = () => new Set(migrationTexts().flatMap((sql) => [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+kauro\.(\w+)/gi)].map((m) => m[1])));

function unwritten(sources, writtenSet, fns) {
  const reads = new Set();
  for (const { text } of sources) for (const t of readTables(text)) reads.add(t);
  return [...reads].filter((t) => !writtenSet.has(t) && !(t in OWNER_LANE) && !fns.has(t)).sort();
}

const TITLE = "every table a B10/B12 command reads has a non-fixture writer or a named owner lane (census of INSERT INTO kauro.<t> in packages/*/src and apps/*/src outside testing); a planted reader of an unwritten table fails";

test(TITLE, () => {
  const w = written();
  const fns = functions();
  const sources = readers();
  assert.deepEqual(unwritten(sources, w, fns), [...UNOWNED].sort(), "the unwritten, unowned reads are exactly the reported residual");
  const created = [...read("packages/persistence/migrations/0072_b12_outreach.sql").matchAll(/CREATE TABLE kauro\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(created.filter((t) => !w.has(t) && !(t in OWNER_LANE)), [], "every 0072 table has a writer or its owner lane");
  assert.ok(w.has("outreach_send_intents") && w.has("sales_activities") && w.has("prospect_suppressions"), "the K1 writers are product writers");
  const planted = [...sources, { file: "planted.ts", text: 'await execute(db, "SELECT 1 FROM kauro.nobody_writes_this WHERE id = $1", [id]);' }];
  assert.ok(unwritten(planted, w, fns).includes("nobody_writes_this"), "a planted reader of an unwritten table is refused");
});
