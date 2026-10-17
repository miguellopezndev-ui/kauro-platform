// Migration 0095 (order 6; docs/design/B13-report-inputs.md): the sources of a B13 report, on a real PostgreSQL 17 through the runtime
// login roles.
//   1. From the schema before it: a cluster at 0094 holding a quote CMD027 issued (its terms hash KAURO_QUOTE_TERMS_V1 over its own
//      preimage), the agency's terms acceptance, the fiscal issuer and the approval is migrated; no row of them changes, and the control
//      plane — bound to the agency — reads the quote's preimage back and recomputes exactly the hash CMD027 recorded: the report's terms
//      binding is the platform's own record, never a document made to match it. Unbound, or bound to another agency, it reads nothing.
//   2. The legal identity documents: content-addressed, append-only for every role (the superuser included), recorded and read by the
//      control plane only, refused when incomplete; a fiscal issuer's legal identity hash never changes, so a corrected identity is
//      another document and another issuer, and the quotes already issued keep theirs.
//   3. The branding versions: numbered in order by the database, recorded only by the agency's ACTIVE OWNER or ADMIN as itself, printable
//      or refused, append-only, read by the agency and the control plane bound to it only.
//   4. The control plane's reads are column by column: what the report verifies, nothing else, no write.
// The values are synthetic (the identity says TEST in every field). The superuser connection is the oracle, and the writer of nothing but
// the deliberate superuser probes of the append-only guards.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Client } from "pg";
import { isDomainFailure, legalIdentityBytesOf, quoteTermsHash, type AgencyId, type FiscalIssuerRef, type FiscalProfileId, type MembershipId, type PlanId } from "@kauro/domain";
import { canonicalBytes, type Sha256Hex } from "@kauro/contracts";
import { MIGRATIONS_DIR, applyMigrations, listMigrations, reportSourcesOf } from "../src/index.js";
import { commercialUnits, issueCommercialQuote } from "../src/testing/commercial-recurrence.js";
import { waitForLockWait } from "../src/testing/harness.js";
import { TEST_LEGAL_IDENTITY, acceptReportAgreements, publishReportAgreements, recordBranding } from "../src/testing/report-sources.js";
import { agencyWith, closeWorld, openWorld, subjectOf, type Agency, type World } from "./b10-commission-support.js";
import { ids, sqlState } from "./support.js";

const TARGET = "0095_b13_report_sources.sql";
let w: World | null = null;
let dir: string | null = null;
let A: Agency;
let B: Agency;
let quoteId: string;
let issuedTermsHash: string;

after(async () => {
  if (w !== null) await closeWorld(w);
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
});

const world = (): World => {
  assert.ok(w !== null, "the world of the first test");
  return w;
};

/** Runs `fn` on `c` in one transaction with the agency (or none) and the person bound, as a unit of work binds them. */
async function bound<T>(c: Client, agencyId: string | null, userId: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [agencyId ?? "", userId ?? ""]);
    const out = await fn();
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

/** What the oracle holds of the records a report verifies, exactly as stored. */
async function recordsOf(agencyId: string): Promise<unknown> {
  const o = world().h.oracle;
  const q = async (sql: string): Promise<unknown> => (await o.query(sql, [agencyId])).rows;
  return {
    quotes: await q("SELECT to_jsonb(x) AS row FROM kauro.quotes x WHERE agency_id = $1 ORDER BY quote_id"),
    acceptances: await q("SELECT to_jsonb(x) AS row FROM kauro.agency_agreement_acceptances x WHERE agency_id = $1 ORDER BY acceptance_id"),
    approvals: await q("SELECT to_jsonb(x) AS row FROM kauro.approvals x WHERE agency_id = $1 ORDER BY approval_id"),
    issuers: (await o.query("SELECT to_jsonb(x) AS row FROM kauro.fiscal_issuers x ORDER BY issuer_ref")).rows,
  };
}

test("0095 from 0094: a quote CMD027 issued, its agency's acceptance, its issuer and its approval are unchanged, and the control plane bound to the agency recomputes from the quote's recorded members exactly the KAURO_QUOTE_TERMS_V1 hash CMD027 recorded", async () => {
  const all = listMigrations(MIGRATIONS_DIR);
  const target = all.find((m) => m.file === TARGET);
  assert.ok(target, "0095 is the report sources migration");
  const pos = all.indexOf(target);
  assert.equal(pos, all.length - 1, "0095 is the last migration of this edition");
  dir = mkdtempSync(join(tmpdir(), "kauro-0095-"));
  for (const m of all.slice(0, pos)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
  w = await openWorld("b13-sources", { migrationsDir: dir });
  const x = world();
  A = await agencyWith(x, "Sources Alpha");
  B = await agencyWith(x, "Sources Bravo");
  const versions = await publishReportAgreements(x.h);
  await acceptReportAgreements(x.h, A, versions);
  const s = await subjectOf(x, A, "sources-alpha");
  const issued = await issueCommercialQuote(x.h, commercialUnits(x.h), { agency: A, planId: s.planId as PlanId, issuerRef: x.routes.issuerRef as FiscalIssuerRef, profileId: A.profileId as FiscalProfileId });
  quoteId = issued.quote.quoteId;
  issuedTermsHash = issued.quote.termsHash;
  const exists = async (name: string): Promise<boolean> => (await x.h.oracle.query<{ r: string | null }>("SELECT to_regclass($1)::text AS r", [name])).rows[0]?.r !== null;
  assert.equal(await exists("kauro.legal_identity_snapshots"), false, "the cluster is at 0094");
  assert.equal(await exists("kauro.agency_branding_versions"), false);
  const before = await recordsOf(A.agencyId);

  for (const m of all.slice(pos)) copyFileSync(join(MIGRATIONS_DIR, m.file), join(dir, m.file));
  const owner = await x.h.pg.connect("kauro_owner");
  try {
    assert.deepEqual((await applyMigrations(owner, { dir })).applied.map((m) => m.file), [TARGET]);
    assert.deepEqual((await applyMigrations(owner, { dir })).applied, [], "applied once");
  } finally {
    await owner.end();
  }
  assert.deepEqual(await recordsOf(A.agencyId), before, "no quote, acceptance, approval or issuer row changed");
  assert.equal(await exists("kauro.legal_identity_snapshots"), true);
  assert.equal((await x.h.oracle.query("SELECT 1 FROM kauro.legal_identity_snapshots")).rowCount, 0, "no legal identity is recorded by the migration");
  assert.equal((await x.h.oracle.query("SELECT 1 FROM kauro.agency_branding_versions")).rowCount, 0, "no branding is invented for an existing agency");

  // the control plane bound to the agency reads the quote's preimage; its digest is the recorded hash, which is CMD027's
  const read = await x.h.execution.run({ ...x.h.system("job-execution"), agencyId: A.agencyId }, (uow) => reportSourcesOf(uow).quoteOf(A.agencyId, quoteId));
  assert.ok(read !== null, "the control plane bound to the agency reads its quote");
  assert.equal(read.termsHash, issuedTermsHash);
  assert.equal(quoteTermsHash(read.preimage), issuedTermsHash, "KAURO_QUOTE_TERMS_V1 of the recorded members is the hash CMD027 recorded");
  assert.equal(read.preimage.termsVersion, "TERMS-2026-01");
  assert.match(read.preimage.issuedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, "instants exact to the microsecond");
  // one member read another way would be another document: the binding admits no second spelling
  assert.notEqual(quoteTermsHash({ ...read.preimage, issuedAt: read.preimage.issuedAt.replace(/(\.\d{3})\d{3}Z$/, "$1Z") as typeof read.preimage.issuedAt }), issuedTermsHash);
  // unbound, or bound to another agency, the control plane reads no quote
  assert.equal(await x.h.execution.run(x.h.system("job-execution"), (uow) => reportSourcesOf(uow).quoteOf(A.agencyId, quoteId)), null);
  assert.equal(await x.h.execution.run({ ...x.h.system("job-execution"), agencyId: B.agencyId }, (uow) => reportSourcesOf(uow).quoteOf(A.agencyId, quoteId)), null);
});

test("legal identity documents: content-addressed, complete or refused, recorded and read by the control plane only, append-only for every role; an issuer's identity hash never changes", async () => {
  const x = world();
  const record = (bytes: Uint8Array) => x.h.control.run(x.h.system("legal-identity-recorder"), (uow) => reportSourcesOf(uow).legalIdentities.record(bytes));
  const bytes = legalIdentityBytesOf(TEST_LEGAL_IDENTITY);
  const first = await record(bytes);
  const again = await record(bytes);
  assert.deepEqual(again, first, "the same document is the same record, at its first instant");
  const read = await x.h.control.run(x.h.system("legal-identity-recorder"), (uow) => reportSourcesOf(uow).legalIdentities.documentOf(first.legalIdentityHash));
  assert.deepEqual(Buffer.from(read ?? []), Buffer.from(bytes));
  // an incomplete identity is no document
  const placeholder = canonicalBytes({ domain: "KAURO_LEGAL_IDENTITY_V1", version: 1, payload: { ...TEST_LEGAL_IDENTITY, taxId: "[NIT]" } });
  await assert.rejects(record(placeholder), (e: unknown) => isDomainFailure(e) && e.code === "INVALID_REQUEST");
  await assert.rejects(record(new TextEncoder().encode("Kauro")), (e: unknown) => isDomainFailure(e) && e.code === "INVALID_REQUEST");
  assert.equal((await x.h.oracle.query("SELECT 1 FROM kauro.legal_identity_snapshots")).rowCount, 1, "only the complete document was recorded");
  // the key is the document's SHA-256, whoever writes
  await assert.rejects(
    bound(x.control, null, null, () => x.control.query("INSERT INTO kauro.legal_identity_snapshots (legal_identity_hash, document) VALUES ($1, $2)", ["a".repeat(64), Buffer.from(legalIdentityBytesOf({ ...TEST_LEGAL_IDENTITY, taxId: "TEST-TAX-1" }))])),
    (e: unknown) => sqlState(e) === "23514",
  );
  // append-only: no runtime role may rewrite or remove one, and the guard refuses the superuser too
  await assert.rejects(bound(x.control, null, null, () => x.control.query("UPDATE kauro.legal_identity_snapshots SET document = document")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(bound(x.control, null, null, () => x.control.query("DELETE FROM kauro.legal_identity_snapshots")), (e: unknown) => sqlState(e) === "42501");
  for (const sql of ["UPDATE kauro.legal_identity_snapshots SET recorded_at = recorded_at", "DELETE FROM kauro.legal_identity_snapshots", "TRUNCATE kauro.legal_identity_snapshots"]) {
    await assert.rejects(x.h.oracle.query(sql), (e: unknown) => sqlState(e) === "KA004", sql);
  }
  // the request handlers, the payment service and the validator read none
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("SELECT 1 FROM kauro.legal_identity_snapshots")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(x.payment.query("SELECT 1 FROM kauro.legal_identity_snapshots"), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(x.validator.query("SELECT 1 FROM kauro.legal_identity_snapshots"), (e: unknown) => sqlState(e) === "42501");
  // a fiscal issuer's legal identity hash never changes (0013): a corrected identity is another issuer; the quote keeps the one its terms name
  await assert.rejects(
    bound(x.control, null, null, () => x.control.query("UPDATE kauro.fiscal_issuers SET legal_identity_hash = $2 WHERE issuer_ref = $1", [x.routes.issuerRef, first.legalIdentityHash])),
    (e: unknown) => sqlState(e) === "KA004",
  );
  const quote = (await x.h.oracle.query<{ issuer_ref: string; terms_hash: string }>("SELECT issuer_ref, terms_hash FROM kauro.quotes WHERE quote_id = $1", [quoteId])).rows[0];
  assert.deepEqual(quote, { issuer_ref: x.routes.issuerRef, terms_hash: issuedTermsHash });
});

test("branding versions: the agency's OWNER or ADMIN records the next number as itself; a name a report could not print, a number out of order, another agency or another role is refused; append-only; read by the agency and the control plane bound to it", async () => {
  const x = world();
  const v1 = await recordBranding(x.h, A, "Sources Alpha Partners");
  const v2 = await recordBranding(x.h, A, "Sources Alpha Partners Ltd");
  assert.deepEqual([v1.version, v2.version, v1.agencyId, v2.displayName], [1, 2, A.agencyId, "Sources Alpha Partners Ltd"]);
  assert.ok(Date.parse(v1.recordedAt) <= Date.parse(v2.recordedAt));
  assert.deepEqual((await recordBranding(x.h, B, "Sources Bravo")).version, 1, "numbered per agency");
  // an ADMIN records as itself; an OPERATOR, a VIEWER and another agency's owner cannot
  const admin = await x.h.person("sources-alpha-admin");
  const adminMembership = await x.h.addMember(A, admin, "ADMIN");
  const byAdmin = await x.h.app.run(x.h.tenant(A.agencyId as AgencyId, admin), (uow) => reportSourcesOf(uow).brandingVersions.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: adminMembership, displayName: "Sources Alpha by Admin" }));
  assert.equal(byAdmin.version, 3);
  for (const role of ["OPERATOR", "VIEWER", "APPROVER", "BILLING"] as const) {
    const person = await x.h.person(`sources-alpha-${role.toLowerCase()}`);
    const membership = await x.h.addMember(A, person, role);
    await assert.rejects(
      x.h.app.run(x.h.tenant(A.agencyId as AgencyId, person), (uow) => reportSourcesOf(uow).brandingVersions.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: membership, displayName: "Not Mine" })),
      (e: unknown) => isDomainFailure(e),
      role,
    );
  }
  // the session's person must be the membership's: the admin's membership named by the owner, and another agency's owner, are refused
  await assert.rejects(
    x.h.app.run(x.h.tenant(A.agencyId as AgencyId, A.ownerUserId), (uow) => reportSourcesOf(uow).brandingVersions.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: adminMembership, displayName: "Borrowed Membership" })),
    (e: unknown) => isDomainFailure(e),
  );
  await assert.rejects(
    x.h.app.run(x.h.tenant(B.agencyId as AgencyId, B.ownerUserId), (uow) => reportSourcesOf(uow).brandingVersions.record({ agencyId: A.agencyId as AgencyId, recordedByMembershipId: B.ownerMembershipId as MembershipId, displayName: "Foreign" })),
    (e: unknown) => isDomainFailure(e),
  );
  // the database numbers and fences: a number that is not the next, and a name a report could not print, are refused whoever writes
  const raw = (n: number, name: string) =>
    bound(x.app, A.agencyId, A.ownerUserId, () =>
      x.app.query("INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id) VALUES ($1, $2, $3, $4, $5)", [A.agencyId, n, name, A.ownerMembershipId, A.ownerUserId]),
    );
  await assert.rejects(raw(9, "Skipped Ahead"), (e: unknown) => sqlState(e) === "23514");
  await assert.rejects(raw(3, "Taken Number"), (e: unknown) => sqlState(e) === "23514");
  for (const name of ["<b>Bold</b>", "Quote \"Me\"", "Smith & Co", "Hidden\u200bSpace", "Bidi\u202eTxet", " Padded", "x".repeat(121), "Line\nBreak", "Cafe\u0301"]) {
    await assert.rejects(raw(4, name), (e: unknown) => sqlState(e) === "23514", JSON.stringify(name));
  }
  assert.deepEqual((await recordBranding(x.h, A, "Café Partners")).version, 4, "an NFC name with an accent is printable");
  // two recorders of the same next number at once: the guard admits both, the primary key one (the other answers a typed conflict)
  const second = await x.h.pg.connect("kauro_app_test");
  await second.query("SET application_name = 'b13-branding-race'");
  try {
    for (const c of [x.app, second]) {
      await c.query("BEGIN");
      await c.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [A.agencyId, A.ownerUserId]);
    }
    const insert = (c: Client, name: string) =>
      c.query("INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id) VALUES ($1, 5, $2, $3, $4)", [A.agencyId, name, A.ownerMembershipId, A.ownerUserId]);
    await insert(x.app, "First Writer");
    const racing = insert(second, "Second Writer").then(() => "inserted", (e: unknown) => sqlState(e));
    await waitForLockWait(x.h.oracle, "b13-branding-race", "INSERT INTO kauro.agency_branding_versions");
    await x.app.query("COMMIT");
    assert.equal(await racing, "23505", "the second recorder of number 5 loses on the primary key");
    await second.query("ROLLBACK");
  } finally {
    await second.end();
  }
  assert.deepEqual((await x.h.oracle.query<{ n: string }>("SELECT display_name AS n FROM kauro.agency_branding_versions WHERE agency_id = $1 AND branding_version = 5", [A.agencyId])).rows, [{ n: "First Writer" }]);
  // append-only: the request handlers cannot rewrite or remove one; the guard refuses the superuser too
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("UPDATE kauro.agency_branding_versions SET display_name = 'Rewritten'")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("DELETE FROM kauro.agency_branding_versions")), (e: unknown) => sqlState(e) === "42501");
  await assert.rejects(x.h.oracle.query("UPDATE kauro.agency_branding_versions SET display_name = 'Rewritten'"), (e: unknown) => sqlState(e) === "KA004");
  await assert.rejects(x.h.oracle.query("DELETE FROM kauro.agency_branding_versions"), (e: unknown) => sqlState(e) === "KA004");
  // read by the agency and the control plane bound to it, never across agencies
  const versionsAs = async (c: Client, agencyId: string | null, userId: string | null): Promise<number[]> =>
    bound(c, agencyId, userId, async () => (await c.query<{ v: number }>("SELECT branding_version AS v FROM kauro.agency_branding_versions WHERE agency_id = $1 ORDER BY 1", [A.agencyId])).rows.map((r) => r.v));
  assert.deepEqual(await versionsAs(x.app, A.agencyId, A.ownerUserId), [1, 2, 3, 4, 5]);
  assert.deepEqual(await versionsAs(x.control, A.agencyId, null), [1, 2, 3, 4, 5]);
  assert.deepEqual(await versionsAs(x.app, B.agencyId, B.ownerUserId), [], "another agency reads none");
  assert.deepEqual(await versionsAs(x.control, B.agencyId, null), [], "the control plane bound to another agency reads none");
  assert.deepEqual(await versionsAs(x.control, null, null), [], "the unbound control plane reads none");
});

test("the control plane's reads are column by column and bound to its agency: the quote's preimage and state, the terms acceptances, the approval's disclosures hash — nothing else, and no write", async () => {
  const x = world();
  const asControl = <T>(agencyId: string | null, sql: string, params: unknown[] = []) => bound(x.control, agencyId, null, async () => (await x.control.query<T & Record<string, unknown>>(sql, params)).rows);
  assert.equal((await asControl(A.agencyId, "SELECT terms_hash, terms_version, state, issuer_ref, total_cents FROM kauro.quotes WHERE quote_id = $1", [quoteId])).length, 1);
  assert.equal((await asControl(B.agencyId, "SELECT terms_hash FROM kauro.quotes WHERE quote_id = $1", [quoteId])).length, 0);
  assert.equal((await asControl(null, "SELECT terms_hash FROM kauro.quotes")).length, 0);
  await assert.rejects(asControl(A.agencyId, "SELECT created_by_membership_id FROM kauro.quotes"), (e: unknown) => sqlState(e) === "42501", "a column the report does not verify");
  await assert.rejects(asControl(A.agencyId, "UPDATE kauro.quotes SET terms_version = terms_version WHERE quote_id = $1", [quoteId]), (e: unknown) => sqlState(e) === "42501");
  assert.equal((await asControl(A.agencyId, "SELECT terms_version, terms_document_hash, accepted_at FROM kauro.agency_agreement_acceptances")).length, 1);
  assert.equal((await asControl(B.agencyId, "SELECT terms_version FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [A.agencyId])).length, 0);
  await assert.rejects(asControl(A.agencyId, "SELECT user_id FROM kauro.agency_agreement_acceptances"), (e: unknown) => sqlState(e) === "42501", "never the person who accepted");
  await assert.rejects(asControl(A.agencyId, "INSERT INTO kauro.agency_agreement_acceptances (acceptance_id) VALUES ($1)", [ids.next()]), (e: unknown) => sqlState(e) === "42501");
  assert.ok((await asControl<{ disclosures_hash: Sha256Hex }>(A.agencyId, "SELECT disclosures_hash FROM kauro.approvals")).length >= 1);
  await assert.rejects(asControl(A.agencyId, "UPDATE kauro.approvals SET disclosures_hash = disclosures_hash"), (e: unknown) => sqlState(e) === "42501");
  // the kauro_app request handlers keep their own reads only: no new grant reached them on the legal identities
  await assert.rejects(bound(x.app, A.agencyId, A.ownerUserId, () => x.app.query("INSERT INTO kauro.legal_identity_snapshots (legal_identity_hash, document) VALUES ($1, $2)", ["b".repeat(64), Buffer.from("x")])), (e: unknown) => sqlState(e) === "42501");
});
