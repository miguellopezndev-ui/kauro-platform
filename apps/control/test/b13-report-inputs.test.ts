// The platform's ReportInputsPort on a real PostgreSQL 17 (order 6; docs/design/B13-report-inputs.md §5): PlatformReportInputs reads a
// job's report sources in the control plane's SYSTEM unit of work bound to the job's agency, and @kauro/data-plane assembleReportFacts —
// the function the worker's report stage runs — verifies every binding. Each case is on records the platform holds: the ones its own
// paths wrote (a quote and its terms preimage, the agency's acceptance, the issuer and its legal identity document, the branding version,
// the subject's audit, the approval's disclosures), or — to show what the reader does with a record its guards would never admit — one
// rewritten by the superuser with the triggers off ("a record the guards would refuse"), never through a runtime role. A refusal that ends
// a job is followed to the end: FAILED REFUSED with the report's own code, no manifest, no package, nothing delivered.
// The legal identity is the labelled synthetic TEST identity; the superuser connection is the oracle and the writer of those rewrites only.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { REPORT_RECORD_ROLE, ReportStageError, assembleReportFacts, readReportPdfRecord, type AuthorizedReportInputs, type QuoteTerms, type ReportScope } from "@kauro/data-plane";
import { disclosureItemsOf, disclosuresHashOf } from "@kauro/application";
import { quoteTermsHash, type CorrelationId, type PlanBody } from "@kauro/domain";
import { reportSourcesOf } from "@kauro/persistence";
import { recordBranding, recordIssuerOfIdentity, recordLegalIdentity } from "@kauro/persistence/testing";
import { PlatformReportInputs } from "../src/execution/report-inputs.js";
import { EXECUTION_SERVICES, boundSystem } from "../src/execution/work.js";
import { TestClockExecutionUnits, admitted, clock, ids, launched, observedDone, type Purchase } from "./support/execution-world.js";
import { kitOf } from "./support/report-kit.js";
import { BRAND, ISSUER, RENDER, TERMS_VERSION, reportFixtureOf, sha256, startReportWorld, type PackageName, type ReportWorld } from "./support/report-world.js";

let w: ReportWorld;
let k: ReturnType<typeof kitOf>;

before(async () => {
  w = await startReportWorld("b13-inputs");
  k = kitOf(w);
});

after(async () => {
  await w.stop();
});

const CLEAN: PackageName = "A-clean-multi-object";
const SALESFORCE: PackageName = "D-salesforce";

const port = (): PlatformReportInputs => new PlatformReportInputs({ units: w.units, ids });

/** The scope of a job's latest attempt, from the oracle. */
async function scopeOf(jobId: string): Promise<ReportScope> {
  const r = (
    await w.h.oracle.query<{ agency_id: string; project_id: string; attempt_id: string }>(
      "SELECT j.agency_id, j.project_id, a.attempt_id FROM kauro.processing_jobs j JOIN kauro.processing_attempts a ON a.job_id = j.job_id WHERE j.job_id = $1 ORDER BY a.ordinal DESC LIMIT 1",
      [jobId],
    )
  ).rows[0];
  assert.ok(r, `job ${jobId} has an attempt`);
  return { agencyId: r.agency_id, projectId: r.project_id, jobId, attemptId: r.attempt_id };
}

/** What the report stage would answer for the scope: OK, or the code of its refusal. */
async function verdictOf(scope: ReportScope): Promise<string> {
  try {
    assembleReportFacts(scope, await port().read(scope), RENDER.rendererVersion);
    return "OK";
  } catch (e) {
    if (e instanceof ReportStageError) return e.code;
    throw e;
  }
}

/** A record the guards would refuse, written by the superuser with the triggers off (replication role replica), never by a runtime role. */
async function rewrite(sql: string, params: unknown[]): Promise<void> {
  const o = w.h.oracle;
  await o.query("BEGIN");
  try {
    await o.query("SET LOCAL session_replication_role = replica");
    const r = await o.query(sql, params);
    assert.ok((r.rowCount ?? 0) >= 1, `the rewrite touched a row: ${sql}`);
    await o.query("COMMIT");
  } catch (e) {
    await o.query("ROLLBACK");
    throw e;
  }
}

const quoteIdOf = async (p: Purchase): Promise<string> =>
  (await w.h.oracle.query<{ quote_id: string }>("SELECT quote_id FROM kauro.commercial_authorizations WHERE authorization_id = $1", [p.authorizationId])).rows[0]!.quote_id;

/** Rewrites members of a quote and records, as its terms hash, KAURO_QUOTE_TERMS_V1 of the rewritten preimage (a consistent record of other terms). */
async function rewriteQuoteConsistently(p: Purchase, set: string, params: unknown[]): Promise<void> {
  const quoteId = await quoteIdOf(p);
  await rewrite(`UPDATE kauro.quotes SET ${set} WHERE quote_id = $1`, [quoteId, ...params]);
  const read = await w.units.run(boundSystem(EXECUTION_SERVICES.JOB_EXECUTION, p.agency.agencyId, ids.next() as CorrelationId), (uow) => reportSourcesOf(uow).quoteOf(p.agency.agencyId, quoteId));
  assert.ok(read !== null);
  await rewrite("UPDATE kauro.quotes SET terms_hash = $2 WHERE quote_id = $1", [quoteId, quoteTermsHash(read.preimage)]);
}

/** A paid purchase of a fresh agency's project, its job admitted (an attempt exists): the subject of one case. */
async function admittedJob(label: string, name: PackageName = CLEAN): Promise<{ readonly p: Purchase; readonly jobId: string; readonly identity: string; readonly scope: ReportScope }> {
  const A = await w.agency(label);
  w.scenario(A, { packageName: name });
  const p = await w.paid(A, label, { mode: name === CLEAN ? "HUBSPOT" : "SALESFORCE", report: reportFixtureOf(name) });
  const { jobId, identity } = await admitted(w, p);
  return { p, jobId, identity, scope: await scopeOf(jobId) };
}

/** Runs an admitted job's attempt to the end of JOB_EXECUTION and asserts it ended REFUSED with the report's `code`, nothing delivered. */
async function refusedToTheEnd(c: { readonly p: Purchase; readonly jobId: string; readonly identity: string }, code: string): Promise<void> {
  await launched(w, c.jobId);
  await observedDone(w, c.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal(w.outcomes.get(c.jobId)?.refusal?.code, `REPORT_${code}`);
  const job = await w.job(c.jobId);
  assert.deepEqual([job.state, job.terminal_reason], ["FAILED", "REFUSED"], code);
  await k.assertNothingDelivered(c.jobId, c.p.agency.agencyId);
  assert.equal((await w.authorization(c.p.authorizationId)).state, "CONSUMED", `${code}: never DELIVERED`);
}

const jsonOf = (inputs: AuthorizedReportInputs | null): string => JSON.stringify(inputs, (_k, v: unknown) => (v instanceof Uint8Array ? `sha256:${sha256(v)}` : v));

for (const name of [CLEAN, SALESFORCE] as const) {
  test(`${name}: every input is the platform's record — the receipt's manifest, the quote's terms and their recomputed hash, the agency's acceptance, the issuer of the legal identity document, the branding version, the audit's findings and the approval's disclosures — and the delivered report is printed from them`, async () => {
    const { A, p, jobId } = await k.delivered(`records-${name.slice(0, 5).toLowerCase()}`, name);
    const scope = await scopeOf(jobId);
    const inputs = await port().read(scope);
    assert.ok(inputs !== null);
    const o = w.h.oracle;
    const job = (await o.query("SELECT plan_id, plan_hash, approval_id, revision_hash, target_contract_hash, validation_receipt_hash FROM kauro.processing_jobs WHERE job_id = $1", [jobId])).rows[0];
    assert.equal(inputs.evidenceClass, "EXECUTED_LOCAL");
    assert.deepEqual(inputs.subject, { planId: job.plan_id, planHash: job.plan_hash, approvalId: job.approval_id, revisionHash: job.revision_hash, targetContractHash: job.target_contract_hash, validationReceiptHash: job.validation_receipt_hash });
    const receipt = (await o.query("SELECT artifact_evidence_hash, counts FROM kauro.validation_receipts WHERE receipt_hash = $1", [job.validation_receipt_hash])).rows[0];
    assert.equal(inputs.expectedManifestSha256, receipt.artifact_evidence_hash);
    // the terms: the quote's recorded hash, which is KAURO_QUOTE_TERMS_V1 of its recorded members, naming the issuer
    const terms = inputs.terms as QuoteTerms;
    const quote = (await o.query("SELECT quote_id, terms_hash, terms_version, issuer_ref, state, mode FROM kauro.quotes WHERE quote_id = $1", [await quoteIdOf(p)])).rows[0];
    assert.deepEqual([terms.binding, terms.termsSha256, terms.termsVersion, terms.quoteState], ["QUOTE_TERMS_V1", quote.terms_hash, TERMS_VERSION, "ACCEPTED_FOR_CHECKOUT"]);
    assert.equal(quoteTermsHash(terms.preimage), quote.terms_hash);
    assert.equal(terms.preimage.mode, quote.mode);
    const acceptance = (await o.query("SELECT terms_version, terms_document_hash FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [A.agencyId])).rows;
    assert.deepEqual(acceptance, [{ terms_version: TERMS_VERSION, terms_document_hash: terms.acceptance?.documentHash }]);
    const issuer = (await o.query("SELECT issuer_ref, legal_identity_hash FROM kauro.fiscal_issuers WHERE issuer_ref = $1", [quote.issuer_ref])).rows[0];
    assert.equal(terms.issuer?.legalIdentityHash, issuer.legal_identity_hash);
    assert.equal(sha256(terms.issuer?.identity ?? new Uint8Array()), issuer.legal_identity_hash, "the document read is the one the issuer's hash names");
    // the rest, each from its record
    const audit = (await o.query("SELECT audit_id, state, finding_codes FROM kauro.audits WHERE project_id = $1", [scope.projectId])).rows;
    assert.deepEqual(inputs.findings, { binding: "AUDIT_FINDINGS_V1", auditId: audit[0].audit_id, auditState: "NEEDS_DECISION", codes: audit[0].finding_codes });
    const approval = (await o.query("SELECT disclosures_hash FROM kauro.approvals WHERE approval_id = $1", [job.approval_id])).rows[0];
    const body = (await o.query<{ body: PlanBody }>("SELECT body FROM kauro.plans WHERE plan_id = $1", [job.plan_id])).rows[0]!.body;
    const items = disclosureItemsOf(body, receipt.counts.physicalSourceRows);
    assert.deepEqual(inputs.materialDecisions, { binding: "APPROVAL_DISCLOSURES_V1", approvalId: job.approval_id, planHash: job.plan_hash, receiptHash: job.validation_receipt_hash, disclosuresHash: approval.disclosures_hash, items });
    assert.equal(disclosuresHashOf(job.plan_hash, job.validation_receipt_hash, items), approval.disclosures_hash, "the approval was granted over exactly this set");
    assert.equal(inputs.branding?.binding, "AGENCY_BRANDING_V1");
    assert.equal(inputs.privacyClass, "SECURE_DETAIL");
    // the facts the worker's stage assembled from them, and the report it delivered
    const facts = assembleReportFacts(scope, inputs, RENDER.rendererVersion);
    assert.deepEqual(facts.issuer, { legalName: ISSUER.legalName, jurisdiction: ISSUER.jurisdiction, registrationId: ISSUER.taxId });
    assert.deepEqual(facts.branding, { version: "agency-branding-v1", displayName: BRAND, logo: null });
    assert.deepEqual([facts.termsSha256, facts.quoteId, facts.findingIds, facts.materialDecisionIds], [quote.terms_hash, quote.quote_id, ["AGENCY_DECISION_REQUIRED"], items]);
    const outcome = w.outcomes.get(jobId);
    assert.deepEqual([outcome?.terminalCause, outcome?.refusal], ["COMPLETED", undefined]);
    assert.equal((await w.job(jobId)).state, "READY");
  });
}

test("the attempt, job, project and agency are one scope: inputs are read only for the attempt of the scope's own job, project and agency, and never across agencies", async () => {
  const first = await k.delivered("scope-alpha", CLEAN);
  const second = await k.delivered("scope-bravo", CLEAN);
  const sameAgency = await k.delivered("scope-alpha-2", CLEAN, { agency: first.A });
  const a = await scopeOf(first.jobId);
  const b = await scopeOf(second.jobId);
  const a2 = await scopeOf(sameAgency.jobId);
  assert.equal(await verdictOf(a), "OK");
  for (const [label, scope] of [
    ["another agency named for the job", { ...a, agencyId: b.agencyId }],
    ["another project of the same agency", { ...a, projectId: a2.projectId }],
    ["another job of the same agency", { ...a, jobId: a2.jobId }],
    ["another job's attempt", { ...a, attemptId: a2.attemptId }],
    ["another agency's attempt", { ...a, attemptId: b.attemptId }],
  ] as const) {
    assert.equal(await port().read(scope), null, label);
    assert.equal(await verdictOf(scope), "FACTS_UNAVAILABLE", label);
  }
});

/**
 * One case: a fresh agency's purchase admitted, `mutate` applied to its records, the verdict of the report stage asserted, and the job run to
 * the end of JOB_EXECUTION refused with that code and nothing delivered. Each case ends its job before the next begins (one active slot).
 */
async function refusedCase(label: string, mutate: (c: Awaited<ReturnType<typeof admittedJob>>) => Promise<void>, code: string, options: { readonly readFirst?: boolean } = {}): Promise<void> {
  const c = await admittedJob(label);
  // a first read also binds the job's branding version (0095 2b); a case about the versions themselves changes them before any read
  if (options.readFirst !== false) assert.equal(await verdictOf(c.scope), "OK", `${label}: the records are consistent before the change`);
  await mutate(c);
  assert.equal(await verdictOf(c.scope), code, label);
  await refusedToTheEnd(c, code);
}

test("a quote that no longer governs the purchase, terms altered after they were recorded, terms of another version and a missing or later acceptance are refused, each to the end of its job", async () => {
  await refusedCase("quote-expired", async (c) => rewrite("UPDATE kauro.quotes SET state = 'EXPIRED' WHERE quote_id = $1", [await quoteIdOf(c.p)]), "QUOTE_NOT_IN_FORCE");
  await refusedCase("quote-withdrawn", async (c) => rewrite("UPDATE kauro.quotes SET state = 'WITHDRAWN' WHERE quote_id = $1", [await quoteIdOf(c.p)]), "QUOTE_NOT_IN_FORCE");
  // a recorded member changed after its hash was recorded (the source the quote promised, one second shorter)
  await refusedCase("terms-altered", async (c) => rewrite("UPDATE kauro.quotes SET source_available_until = source_available_until - interval '1 second' WHERE quote_id = $1", [await quoteIdOf(c.p)]), "TERMS_UNVERIFIABLE");
  // a consistent record of another terms version, which the agency never accepted
  await refusedCase("terms-other-version", (c) => rewriteQuoteConsistently(c.p, "terms_version = $2", ["TERMS-2027-01"]), "TERMS_UNAVAILABLE");
  await refusedCase("terms-unaccepted", (c) => rewrite("DELETE FROM kauro.agency_agreement_acceptances WHERE agency_id = $1", [c.p.agency.agencyId]), "TERMS_UNAVAILABLE");
  await refusedCase("terms-accepted-late", (c) => rewrite("UPDATE kauro.agency_agreement_acceptances SET accepted_at = now() + interval '1 day' WHERE agency_id = $1", [c.p.agency.agencyId]), "TERMS_UNAVAILABLE");
});

test("an issuer with no recorded legal identity, unconfirmed legal facts or another jurisdiction's identity is refused, each to the end of its job; a brand spelled like a legal name is only the brand", async () => {
  // the state of this edition until the owner records the real identity: the quote names an issuer whose document nobody recorded
  await refusedCase("issuer-missing", async (c) => rewriteQuoteConsistently(c.p, "issuer_ref = $2", [await recordIssuerOfIdentity(w.h, sha256(`an identity nobody recorded ${c.jobId}`), { qualify: false })]), "ISSUER_UNAVAILABLE");
  const identity = await recordLegalIdentity(w.h, ISSUER);
  await refusedCase("issuer-pending", async (c) => rewriteQuoteConsistently(c.p, "issuer_ref = $2", [await recordIssuerOfIdentity(w.h, identity.legalIdentityHash, { legalFactStatus: "PENDING" })]), "ISSUER_UNVERIFIABLE");
  await refusedCase("issuer-owner-declared", async (c) => rewriteQuoteConsistently(c.p, "issuer_ref = $2", [await recordIssuerOfIdentity(w.h, identity.legalIdentityHash, { legalFactStatus: "OWNER_DECLARED" })]), "ISSUER_UNVERIFIABLE");
  const us = await recordLegalIdentity(w.h, { ...ISSUER, jurisdiction: "US" });
  await refusedCase("issuer-foreign-identity", async (c) => rewriteQuoteConsistently(c.p, "issuer_ref = $2", [await recordIssuerOfIdentity(w.h, us.legalIdentityHash, { qualify: false })]), "ISSUER_UNVERIFIABLE");

  const B = await w.agency("issuer-brand");
  await recordBranding(w.h, B, "Kauro Data S.A.S.");
  const { jobId } = await k.delivered("issuer-brand", CLEAN, { agency: B });
  const scope = await scopeOf(jobId);
  const facts = assembleReportFacts(scope, await port().read(scope), RENDER.rendererVersion);
  assert.deepEqual([facts.branding.displayName, facts.branding.version, facts.issuer.legalName], ["Kauro Data S.A.S.", "agency-branding-v2", ISSUER.legalName]);
});

test("a branding change after a delivery: the delivered PDF and record stay exactly as they were, a job queued before the change keeps the version in force when it was queued, and later jobs take the new one; an agency with no branding when it queued is refused", async () => {
  const before = await k.delivered("brand-change", CLEAN);
  const agency = before.A;
  const firstPdf = await k.deliveredPdf(before.jobId);
  const firstRecord = (await k.deliveredOf(firstPdf.packageVersionId)).find((c) => c.role === REPORT_RECORD_ROLE)!;
  const recordBytes = await k.bytesOf("DELIVERY", firstRecord.object_name, firstRecord.generation);
  // a job of the agency queued (and admitted) before the change, run after it
  const pendingPurchase = await w.paid(agency, "brand-change-queued", { report: reportFixtureOf(CLEAN) });
  const pending = await admitted(w, pendingPurchase);
  const recorded = await recordBranding(w.h, agency, "Rebranded Test Agency");
  assert.equal(recorded.version, 2);
  const pendingScope = await scopeOf(pending.jobId);
  assert.equal((assembleReportFacts(pendingScope, await port().read(pendingScope), RENDER.rendererVersion).branding.version), "agency-branding-v1", "the version in force when it was queued");
  await launched(w, pending.jobId);
  await observedDone(w, pending.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(pending.jobId)).state, "READY");
  // a job queued after the change takes the new version
  const after = await k.delivered("brand-change-after", CLEAN, { agency });
  const afterScope = await scopeOf(after.jobId);
  assert.deepEqual(assembleReportFacts(afterScope, await port().read(afterScope), RENDER.rendererVersion).branding, { version: "agency-branding-v2", displayName: "Rebranded Test Agency", logo: null });
  // the first delivery is untouched: the same bytes under the same generations
  const again = await k.deliveredPdf(before.jobId);
  assert.deepEqual([again.copy.generation, again.copy.sha256, sha256(again.bytes)], [firstPdf.copy.generation, firstPdf.copy.sha256, sha256(firstPdf.bytes)]);
  assert.deepEqual(await k.bytesOf("DELIVERY", firstRecord.object_name, firstRecord.generation), recordBytes);
  const modelOf = async (jobId: string): Promise<string> => {
    const pdf = await k.deliveredPdf(jobId);
    const record = (await k.deliveredOf(pdf.packageVersionId)).find((c) => c.role === REPORT_RECORD_ROLE)!;
    const read = readReportPdfRecord(await k.bytesOf("DELIVERY", record.object_name, record.generation));
    assert.ok(read.ok);
    return read.record.identity.modelHash;
  };
  const [m1, mPending, m2] = [await modelOf(before.jobId), await modelOf(pending.jobId), await modelOf(after.jobId)];
  assert.notEqual(m1, m2, "a new branding version is a new model, a new PDF");
  assert.notEqual(m1, mPending, "each job is its own report (its own ids), the pending one under the first version");
  // no branding version in force when the job was queued
  await refusedCase("brand-none-at-queue", (c) => rewrite("UPDATE kauro.agency_branding_versions SET recorded_at = now() + interval '1 day' WHERE agency_id = $1", [c.p.agency.agencyId]), "BRANDING_UNAVAILABLE", { readFirst: false });
});

test("findings and decisions are the job's own subject's: another project's approval disclosures or audit are never taken, an audit missing or ambiguous is refused, and the disclosure set must be the one the approval was granted over", async () => {
  const other = await k.delivered("subject-other", CLEAN);
  const otherDisclosures = (await w.h.oracle.query<{ d: string }>("SELECT a.disclosures_hash AS d FROM kauro.approvals a JOIN kauro.processing_jobs j ON j.approval_id = a.approval_id WHERE j.job_id = $1", [other.jobId])).rows[0]!.d;
  await refusedCase("subject-disclosures", (c) => rewrite("UPDATE kauro.approvals SET disclosures_hash = $2 WHERE approval_id = (SELECT approval_id FROM kauro.processing_jobs WHERE job_id = $1)", [c.jobId, otherDisclosures]), "DECISIONS_UNVERIFIABLE");
  // another project's audit moved onto this job's subject: two audits of one subject are no single record of its findings, and the other
  // project is left with none
  await refusedCase(
    "subject-audit",
    (c) =>
      rewrite(
        `UPDATE kauro.audits SET agency_id = j.agency_id, project_id = j.project_id, revision_hash = j.revision_hash, target_contract_hash = j.target_contract_hash
           FROM kauro.processing_jobs j WHERE j.job_id = $1 AND kauro.audits.project_id = (SELECT project_id FROM kauro.processing_jobs WHERE job_id = $2)`,
        [c.jobId, other.jobId],
      ),
    "FINDINGS_UNAVAILABLE",
  );
  assert.equal(await verdictOf(await scopeOf(other.jobId)), "FINDINGS_UNAVAILABLE", "the other project now has no audit of its subject");
});

test("counts and receipts the platform does not support are refused, and the receipt bound is the job's own VALID one, each to the end of its job", async () => {
  await refusedCase("counts-mismatch", (c) => rewrite("UPDATE kauro.dataset_revisions SET physical_source_rows = physical_source_rows + 1 WHERE agency_id = $1 AND project_id = $2", [c.scope.agencyId, c.scope.projectId]), "COUNTS_MISMATCH");
  await refusedCase("receipt-invalid", (c) => rewrite("UPDATE kauro.validation_receipts SET result = 'INVALID' WHERE receipt_hash = (SELECT validation_receipt_hash FROM kauro.processing_jobs WHERE job_id = $1)", [c.jobId]), "FACTS_UNAVAILABLE");
});

test("retries, concurrency and a restarted reader: the same scope reads the same inputs however often and however concurrently, and a second reader over its own units of work reads them too", async () => {
  // twelve first reads of a fresh job at once: one binding of its branding, one reading
  const fresh0 = await admittedJob("concurrent-first");
  const firsts = await Promise.all(Array.from({ length: 12 }, () => port().read(fresh0.scope)));
  assert.ok(firsts.every((m) => jsonOf(m) === jsonOf(firsts[0] ?? null)), "twelve concurrent first reads are one reading");
  assert.equal((await w.h.oracle.query("SELECT 1 FROM kauro.report_branding_bindings WHERE job_id = $1", [fresh0.jobId])).rowCount, 1, "one binding");
  await launched(w, fresh0.jobId);
  await observedDone(w, fresh0.identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(fresh0.jobId)).state, "READY");
  const { jobId } = await k.delivered("concurrent", CLEAN);
  const scope = await scopeOf(jobId);
  const once = jsonOf(await port().read(scope));
  const many = await Promise.all(Array.from({ length: 12 }, () => port().read(scope)));
  assert.ok(many.every((m) => jsonOf(m) === once), "twelve concurrent reads are one reading");
  // a second control-plane process: its own unit-of-work factory over its own connections, nothing carried over in memory
  const fresh = new TestClockExecutionUnits({ app: w.h.appPool, payment: w.h.paymentPool, control: w.h.controlPool }, { clock, defaultStatementTimeoutMs: 30_000 });
  const restarted = await new PlatformReportInputs({ units: fresh, ids }).read(scope);
  assert.equal(jsonOf(restarted), once);
  const facts = assembleReportFacts(scope, restarted, RENDER.rendererVersion);
  assert.deepEqual(facts, assembleReportFacts(scope, many[0] ?? null, RENDER.rendererVersion));
  // each attempt is its own report: the same records under another attempt of the job name another package, nothing else
  const other = { ...scope, attemptId: ids.next() };
  assert.equal(await port().read(other), null, "an attempt the job does not have reads nothing");
});

test("review R1: a branding version stamped before a job is queued and committed after the job's first report cannot change its reports — the binding keeps the version the first read saw for every later read and the delivery; the control plane can bind no other version and never rewrite a binding", async () => {
  const A = await w.agency("brand-race");
  w.scenario(A, { packageName: CLEAN });
  const app = await w.h.pg.connect("kauro_app_test");
  let jobId = "";
  let identity = "";
  try {
    // the owner's branding transaction: version 2 stamped now, left uncommitted while the job is queued and its report first read
    await app.query("BEGIN");
    await app.query("SELECT set_config('kauro.agency_id', $1, true), set_config('kauro.user_id', $2, true)", [A.agencyId, A.ownerUserId]);
    await app.query(
      "INSERT INTO kauro.agency_branding_versions (agency_id, branding_version, display_name, recorded_by_membership_id, recorded_by_user_id) VALUES ($1, 2, 'Late Committed Brand', $2, $3)",
      [A.agencyId, A.ownerMembershipId, A.ownerUserId],
    );
    const p = await w.paid(A, "brand-race", { report: reportFixtureOf(CLEAN) });
    ({ jobId, identity } = await admitted(w, p));
    const scope = await scopeOf(jobId);
    const first = await port().read(scope);
    assert.deepEqual([first?.branding?.binding, (first?.branding as { version: number }).version], ["AGENCY_BRANDING_V1", 1], "the first read sees the committed version 1");
    await app.query("COMMIT");
    const stamps = (await w.h.oracle.query<{ before: boolean }>("SELECT (SELECT recorded_at FROM kauro.agency_branding_versions WHERE agency_id = $1 AND branding_version = 2) < j.queued_at AS before FROM kauro.processing_jobs j WHERE j.job_id = $2", [A.agencyId, jobId])).rows[0];
    assert.equal(stamps?.before, true, "version 2 is stamped before the job was queued: by its instant alone it would be the job's");
    const after = await port().read(scope);
    assert.equal((after?.branding as { version: number }).version, 1, "the binding, not the versions, answers every later read");
    assert.deepEqual((await w.h.oracle.query("SELECT branding_version FROM kauro.report_branding_bindings WHERE job_id = $1", [jobId])).rows, [{ branding_version: 1 }]);
  } catch (e) {
    await app.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await app.end();
  }
  // the delivery is made from the binding
  await launched(w, jobId);
  await observedDone(w, identity);
  await w.drain(w.x.consumers.jobExecution);
  assert.equal((await w.job(jobId)).state, "READY");
  assert.equal(assembleReportFacts(await scopeOf(jobId), await port().read(await scopeOf(jobId)), RENDER.rendererVersion).branding.version, "agency-branding-v1");

  // the binding's guard and history: another version, a second binding, a rewrite and a removal are refused
  const control = await w.h.pg.connect("kauro_control_test");
  const asControl = async (sql: string, params: unknown[]): Promise<string> => {
    await control.query("BEGIN");
    try {
      await control.query("SELECT set_config('kauro.agency_id', $1, true)", [A.agencyId]);
      await control.query(sql, params);
      await control.query("COMMIT");
      return "OK";
    } catch (e) {
      await control.query("ROLLBACK");
      return (e as { code?: string }).code ?? String(e);
    }
  };
  try {
    const next = await w.paid(A, "brand-race-guard", { report: reportFixtureOf(CLEAN) });
    const queued = await admitted(w, next);
    assert.equal(await asControl("INSERT INTO kauro.report_branding_bindings (agency_id, job_id, branding_version) VALUES ($1, $2, 1)", [A.agencyId, queued.jobId]), "23514", "version 2 is the one in force for a job queued after it");
    // committed now, version 2 does read as in force for the first job — which is why its binding, made before, is the one that stays
    assert.equal(await asControl("INSERT INTO kauro.report_branding_bindings (agency_id, job_id, branding_version) VALUES ($1, $2, 2)", [A.agencyId, jobId]), "23505", "a second binding of a job is refused");
    assert.equal(await asControl("UPDATE kauro.report_branding_bindings SET branding_version = 2 WHERE job_id = $1", [jobId]), "42501");
    assert.equal(await asControl("DELETE FROM kauro.report_branding_bindings WHERE job_id = $1", [jobId]), "42501");
    await assert.rejects(w.h.oracle.query("UPDATE kauro.report_branding_bindings SET bound_at = bound_at WHERE job_id = $1", [jobId]), (e: unknown) => (e as { code?: string }).code === "KA004");
    // the second job: bound to version 2 by its first read, then delivered
    const scope = await scopeOf(queued.jobId);
    assert.equal(assembleReportFacts(scope, await port().read(scope), RENDER.rendererVersion).branding.version, "agency-branding-v2");
    await launched(w, queued.jobId);
    await observedDone(w, queued.identity);
    await w.drain(w.x.consumers.jobExecution);
    assert.equal((await w.job(queued.jobId)).state, "READY");
  } finally {
    await control.end();
  }
});
