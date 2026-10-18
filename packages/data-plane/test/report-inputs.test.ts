// The platform's bindings of a report's facts (order 6; docs/design/B13-report-inputs.md §3): assembleReportFacts verifies each binding
// the platform's records carry — the quote's terms preimage against its recorded hash, the issuer's legal identity document against its
// recorded hash, the disclosure set against the approval's hash, the findings against the subject's audit, the branding against the agency —
// and refuses, with its own code, every fact that is absent, altered, of another version or of another scope. Then the whole chain, from
// such inputs to a staged PDF, with no simulated input admitted. The values are synthetic (support/platform-inputs.ts); the control plane's
// tests read the same bindings from a real PostgreSQL 17 (apps/control/test/b13-report-inputs.test.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { disclosuresHashOf } from "@kauro/application";
import { LEGAL_IDENTITY_DOMAIN, admitLogo, encodePng, legalIdentityBytesOf, legalIdentityProblems, quoteTermsHash, readLegalIdentity, type QuoteTermsPreimage } from "@kauro/domain";
import { canonicalBytes, rawDigest } from "@kauro/contracts";
import {
  B08_PACKAGE_REPORT_PRIVACY_CLASS,
  ReportingExecutionEnvelope,
  ReportStageError,
  assembleReportFacts,
  produceStagedReport,
  readStagedPackage,
  type AuthorizedReportInputs,
  type QuoteTerms,
  type ReportInputsPort,
  type ReportRenderConfig,
} from "../src/index.js";
import { simulatedReportInputsOf, simulatedTermsOf, SIMULATED_ISSUER } from "../src/testing/index.js";
import { v7 } from "./support/attempt.js";
import { TEST_IDENTITY, platformInputsOf, platformPartsOf } from "./support/platform-inputs.js";
import { acceptanceCore, platformRecordOf, rig, scriptedEngine, sha, type Rig } from "./support/report-rig.js";
import type { CaseName } from "./support/report-fixtures.js";

const CLEAN: CaseName = "A-clean-multi-object";
const SALESFORCE: CaseName = "D-salesforce";
const render: ReportRenderConfig = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" };
const RENDERER = "renderer-1.0.0";

let attempt = 700;
const nextRig = (): Rig => rig(++attempt);

const scopeOf = (n: number) => ({ agencyId: v7(1100 + n), projectId: v7(1200 + n), jobId: v7(1300 + n), attemptId: v7(1400 + n) });
const SCOPE = scopeOf(1);
const RECORD = platformRecordOf(CLEAN);
const good = (): AuthorizedReportInputs => platformInputsOf(SCOPE, RECORD);
const termsOf = (i: AuthorizedReportInputs): QuoteTerms => i.terms as QuoteTerms;

/** The inputs with the quote's terms changed; `rehash` re-records the hash over the changed preimage (a consistent record of something else). */
function withTerms(change: (t: QuoteTerms) => Partial<QuoteTerms>, options: { readonly rehash?: boolean } = {}): AuthorizedReportInputs {
  const i = good();
  const t = { ...termsOf(i), ...change(termsOf(i)) };
  return { ...i, terms: options.rehash === true ? { ...t, termsSha256: quoteTermsHash(t.preimage) } : t };
}
const withPreimage = (patch: Partial<QuoteTermsPreimage>, rehash = true): AuthorizedReportInputs => withTerms((t) => ({ preimage: { ...t.preimage, ...patch } }), { rehash });
const withIssuer = (patch: Partial<NonNullable<QuoteTerms["issuer"]>> | null): AuthorizedReportInputs => withTerms((t) => ({ issuer: patch === null ? null : { ...(t.issuer as NonNullable<QuoteTerms["issuer"]>), ...patch } }));

function refused(inputs: AuthorizedReportInputs | null, code: string, label: string): void {
  assert.throws(
    () => assembleReportFacts(SCOPE, inputs, RENDERER),
    (e: unknown) => e instanceof ReportStageError && e.code === code,
    `${label}: refused ${code}`,
  );
}

describe("order 6 the platform's bindings: every fact verified against the record that vouches for it", () => {
  it("consistent records assemble: the issuer is the legal identity document's, the terms hash the quote's, the findings the audit's, the decisions the approval's", () => {
    const inputs = good();
    const facts = assembleReportFacts(SCOPE, inputs, RENDERER);
    const t = termsOf(inputs);
    assert.deepEqual(facts.issuer, { legalName: TEST_IDENTITY.legalName, jurisdiction: "CO", registrationId: TEST_IDENTITY.taxId });
    assert.equal(facts.termsSha256, t.termsSha256);
    assert.equal(facts.termsSha256, quoteTermsHash(t.preimage), "the recorded hash is KAURO_QUOTE_TERMS_V1 of the preimage");
    assert.equal(facts.termsVersion, "TERMS-2026-01");
    assert.equal(facts.quoteId, t.preimage.quoteId);
    assert.equal(facts.billableSourceUnits, RECORD.counts.billableSourceUnits);
    assert.deepEqual(facts.branding, { version: "agency-branding-v2", displayName: "Synthetic Test Agency", logo: null });
    assert.deepEqual(facts.findingIds, ["AGENCY_DECISION_REQUIRED"]);
    assert.deepEqual(facts.materialDecisionIds, ["SET:Contact.email:19", "CLEAR:Contact.phone:19"]);
    assert.equal(facts.privacyClass, B08_PACKAGE_REPORT_PRIVACY_CLASS);
    assert.deepEqual(facts.declaredCounts, RECORD.counts);
    // an audit that recorded no finding (a system draft) is the audit's own record of none, not an unknown
    const none = { ...inputs, findings: { binding: "AUDIT_FINDINGS_V1" as const, auditId: v7(9), auditState: "DRAFT_READY", codes: [] } };
    assert.deepEqual(assembleReportFacts(SCOPE, none, RENDERER).findingIds, []);
    // a finding recorded twice is one finding
    const twice = { ...inputs, findings: { binding: "AUDIT_FINDINGS_V1" as const, auditId: v7(9), auditState: "NEEDS_DECISION", codes: ["AGENCY_DECISION_REQUIRED", "AGENCY_DECISION_REQUIRED"] } };
    assert.deepEqual(assembleReportFacts(SCOPE, twice, RENDERER).findingIds, ["AGENCY_DECISION_REQUIRED"]);
  });

  it("KAURO_REPORT_TERMS_SNAPSHOT_V1 is not the quote's terms: a snapshot can never hash to a quote's terms hash, and the platform's inputs may not carry one", () => {
    const inputs = good();
    const t = termsOf(inputs);
    const snapshot = simulatedTermsOf(t.termsVersion, SIMULATED_ISSUER);
    // the two documents: the snapshot's raw SHA-256 and the quote's structured digest differ for the same terms version
    assert.notEqual(snapshot.termsSha256, t.termsSha256);
    // a snapshot "recorded" under the quote's hash does not verify, and from the platform's inputs no snapshot is admitted at all
    refused({ ...inputs, terms: { ...snapshot, termsSha256: t.termsSha256 } }, "TERMS_UNVERIFIABLE", "a snapshot under the quote's hash");
    refused({ ...inputs, terms: snapshot }, "TERMS_UNVERIFIABLE", "a consistent snapshot from the platform's inputs");
    // the simulator's inputs still assemble with it (the B13 x B08 suite)
    const simulated = simulatedReportInputsOf(SCOPE, RECORD);
    assert.equal(assembleReportFacts(SCOPE, simulated, RENDERER).termsSha256, simulated.terms?.termsSha256);
  });

  it("terms that are absent, altered, of another version or not accepted are refused", () => {
    const cases: ReadonlyArray<readonly [string, AuthorizedReportInputs, string]> = [
      ["no terms", { ...good(), terms: null }, "TERMS_UNAVAILABLE"],
      ["a preimage member altered after the hash was recorded (the total)", withPreimage({ totalCents: "1" as QuoteTermsPreimage["totalCents"] }, false), "TERMS_UNVERIFIABLE"],
      ["a preimage member altered (the issuer the terms name)", withPreimage({ issuerRef: v7(77) }, false), "TERMS_UNVERIFIABLE"],
      ["a preimage instant spelled another way (milliseconds)", withPreimage({ issuedAt: "2026-10-01T12:00:00.123Z" as QuoteTermsPreimage["issuedAt"] }, false), "TERMS_UNVERIFIABLE"],
      ["another recorded hash", withTerms(() => ({ termsSha256: "5".repeat(64) })), "TERMS_UNVERIFIABLE"],
      ["a recorded hash that is no SHA-256", withTerms(() => ({ termsSha256: "terms" })), "FACTS_MALFORMED"],
      ["another terms version than the preimage names", withTerms(() => ({ termsVersion: "TERMS-2027-01" })), "TERMS_UNVERIFIABLE"],
      ["no acceptance of the terms version by the agency", withTerms(() => ({ acceptance: null })), "TERMS_UNAVAILABLE"],
      ["an acceptance of another terms version", withTerms((t) => ({ acceptance: { ...(t.acceptance as NonNullable<QuoteTerms["acceptance"]>), version: "TERMS-2025-01" } })), "TERMS_UNVERIFIABLE"],
      ["an acceptance after the quote was issued", withTerms((t) => ({ acceptance: { ...(t.acceptance as NonNullable<QuoteTerms["acceptance"]>), acceptedAt: "2026-10-02T00:00:00.000000Z" } })), "TERMS_UNVERIFIABLE"],
      ["an acceptance one microsecond after the quote", withTerms((t) => ({ acceptance: { ...(t.acceptance as NonNullable<QuoteTerms["acceptance"]>), acceptedAt: "2026-10-01T12:00:00.123457Z" } })), "TERMS_UNVERIFIABLE"],
      ["an acceptance instant that is no instant", withTerms((t) => ({ acceptance: { ...(t.acceptance as NonNullable<QuoteTerms["acceptance"]>), acceptedAt: "yesterday" } })), "TERMS_UNVERIFIABLE"],
    ];
    for (const [label, inputs, code] of cases) refused(inputs, code, label);
  });

  it("a quote of another agency, project or subject, or one that no longer governs the purchase, is refused", () => {
    const cases: ReadonlyArray<readonly [string, AuthorizedReportInputs, string]> = [
      ["another agency's quote", withPreimage({ agencyId: v7(5001) }), "FACTS_FOREIGN_SCOPE"],
      ["another project's quote", withPreimage({ projectId: v7(5002) }), "FACTS_FOREIGN_SCOPE"],
      ["a quote of another plan", withPreimage({ planId: v7(5003) }), "FACTS_FOREIGN_SCOPE"],
      ["a quote of another approval", withPreimage({ approvalId: v7(5004) }), "FACTS_FOREIGN_SCOPE"],
      ["a quote of another plan body", withPreimage({ planHash: sha("other-plan") as QuoteTermsPreimage["planHash"] }), "FACTS_FOREIGN_SCOPE"],
      ["a quote of another source", withPreimage({ revisionHash: sha("other-source") as QuoteTermsPreimage["revisionHash"] }), "FACTS_FOREIGN_SCOPE"],
      ["a quote of another target", withPreimage({ targetContractHash: sha("other-target") as QuoteTermsPreimage["targetContractHash"] }), "FACTS_FOREIGN_SCOPE"],
      ["the inputs name another quote than the terms carry", { ...good(), quote: { quoteId: v7(5005), billableSourceUnits: RECORD.counts.billableSourceUnits } }, "FACTS_FOREIGN_SCOPE"],
      ["the inputs' units are not the quote's", { ...good(), quote: { quoteId: termsOf(good()).preimage.quoteId, billableSourceUnits: 16 } }, "FACTS_FOREIGN_SCOPE"],
      ["an expired quote", withTerms(() => ({ quoteState: "EXPIRED" })), "QUOTE_NOT_IN_FORCE"],
      ["a withdrawn quote", withTerms(() => ({ quoteState: "WITHDRAWN" })), "QUOTE_NOT_IN_FORCE"],
      ["a superseded quote", withTerms(() => ({ quoteState: "SUPERSEDED" })), "QUOTE_NOT_IN_FORCE"],
      ["an issued, unpaid quote", withTerms(() => ({ quoteState: "ISSUED" })), "QUOTE_NOT_IN_FORCE"],
      ["no job subject", { ...good(), subject: null }, "FACTS_UNAVAILABLE"],
      ["no frozen quote visible", { ...good(), quote: null }, "QUOTE_UNAVAILABLE"],
    ];
    for (const [label, inputs, code] of cases) refused(inputs, code, label);
  });

  it("an issuer whose legal identity is absent or cannot be verified is refused, and nothing but its document names it", () => {
    const parts = platformPartsOf(SCOPE, RECORD.counts);
    const flipped = Uint8Array.from(parts.identity);
    flipped[flipped.length - 8] = (flipped[flipped.length - 8] as number) ^ 1;
    const other = legalIdentityBytesOf({ ...TEST_IDENTITY, jurisdiction: "US" });
    // a document whose hash matches but whose payload is a placeholder (written by hand, as a careless operator might)
    const placeholder = canonicalBytes({ domain: LEGAL_IDENTITY_DOMAIN, version: 1, payload: { ...TEST_IDENTITY, taxId: "[NIT]" } });
    const respelled = new TextEncoder().encode(Buffer.from(parts.identity).toString("utf8").replace('"version":1', '"version": 1'));
    const cases: ReadonlyArray<readonly [string, AuthorizedReportInputs, string]> = [
      ["no fiscal issuer recorded", withIssuer(null), "ISSUER_UNAVAILABLE"],
      ["no legal identity document recorded (the state of this edition until the owner records it)", withIssuer({ identity: null }), "ISSUER_UNAVAILABLE"],
      ["an issuer other than the one the terms name", withIssuer({ issuerRef: v7(88) }), "ISSUER_UNVERIFIABLE"],
      ["a document altered after its hash was recorded", withIssuer({ identity: flipped }), "ISSUER_UNVERIFIABLE"],
      ["a document whose hash is not the issuer's", withIssuer({ legalIdentityHash: sha("another identity") }), "ISSUER_UNVERIFIABLE"],
      ["another jurisdiction's identity under its own hash", withIssuer({ identity: other, legalIdentityHash: rawDigest(other) }), "ISSUER_UNVERIFIABLE"],
      ["a placeholder under its own hash", withIssuer({ identity: placeholder, legalIdentityHash: rawDigest(placeholder) }), "ISSUER_UNVERIFIABLE"],
      ["a second spelling of the document under its own hash", withIssuer({ identity: respelled, legalIdentityHash: rawDigest(respelled) }), "ISSUER_UNVERIFIABLE"],
      ["legal facts PENDING", withIssuer({ legalFactStatus: "PENDING" }), "ISSUER_UNVERIFIABLE"],
      ["legal facts only OWNER_DECLARED", withIssuer({ legalFactStatus: "OWNER_DECLARED" }), "ISSUER_UNVERIFIABLE"],
      ["legal facts EXPIRED", withIssuer({ legalFactStatus: "EXPIRED" }), "ISSUER_UNVERIFIABLE"],
    ];
    for (const [label, inputs, code] of cases) refused(inputs, code, label);
    // a brand that looks like a legal name changes nothing about the issuer
    const facts = assembleReportFacts(SCOPE, { ...good(), branding: { binding: "AGENCY_BRANDING_V1", agencyId: SCOPE.agencyId, version: 3, displayName: "Kauro Data S.A.S.", recordedAt: "2026-09-02T00:00:00.000000Z", logo: null } }, RENDERER);
    assert.equal(facts.issuer.legalName, TEST_IDENTITY.legalName);
  });

  it("branding, findings, decisions and privacy the platform did not record, or that are another scope's, are refused", () => {
    const i = good();
    const d = i.materialDecisions as Extract<AuthorizedReportInputs["materialDecisions"], { binding: "APPROVAL_DISCLOSURES_V1" }>;
    const cases: ReadonlyArray<readonly [string, AuthorizedReportInputs, string]> = [
      ["no branding version when the job was queued", { ...i, branding: null }, "BRANDING_UNAVAILABLE"],
      ["another agency's branding", { ...i, branding: { binding: "AGENCY_BRANDING_V1", agencyId: v7(6001), version: 1, displayName: "Other Agency", recordedAt: "2026-09-01T00:00:00.000000Z", logo: null } }, "FACTS_FOREIGN_SCOPE"],
      ["a branding version that is no positive integer", { ...i, branding: { binding: "AGENCY_BRANDING_V1", agencyId: SCOPE.agencyId, version: 0, displayName: "Synthetic Test Agency", recordedAt: "2026-09-01T00:00:00.000000Z", logo: null } }, "FACTS_MALFORMED"],
      ["logo bytes for a branding that names no logo", { ...i, logo: new Uint8Array([1, 2, 3]) }, "BRANDING_UNVERIFIABLE"],
      ["a simulated branding in the platform's inputs", { ...i, branding: { binding: "SIMULATED", branding: { version: "brand-1", displayName: "Invented", logo: null } } }, "BRANDING_UNVERIFIABLE"],
      ["no audit of the subject", { ...i, findings: null }, "FINDINGS_UNAVAILABLE"],
      ["an audit no plan comes from", { ...i, findings: { binding: "AUDIT_FINDINGS_V1", auditId: v7(9), auditState: "FAILED", codes: [] } }, "FINDINGS_UNVERIFIABLE"],
      ["an audit still running", { ...i, findings: { binding: "AUDIT_FINDINGS_V1", auditId: v7(9), auditState: "VALIDATING", codes: [] } }, "FINDINGS_UNVERIFIABLE"],
      ["simulated findings in the platform's inputs", { ...i, findings: { binding: "SIMULATED", ids: ["F-1"] } }, "FINDINGS_UNVERIFIABLE"],
      ["no approval disclosures", { ...i, materialDecisions: null }, "DECISIONS_UNAVAILABLE"],
      ["a disclosure set other than the approval's (one item dropped)", { ...i, materialDecisions: { ...d, items: d.items.slice(0, 1) } }, "DECISIONS_UNVERIFIABLE"],
      ["a disclosure set other than the approval's (an item invented)", { ...i, materialDecisions: { ...d, items: [...d.items, "SET:Deal.amount:19"] } }, "DECISIONS_UNVERIFIABLE"],
      ["another approval's disclosures", { ...i, materialDecisions: { ...d, approvalId: v7(6002) } }, "FACTS_FOREIGN_SCOPE"],
      ["another plan's disclosures, consistently hashed", { ...i, materialDecisions: { ...d, planHash: sha("p2"), disclosuresHash: disclosuresHashOf(sha("p2"), d.receiptHash, d.items) } }, "FACTS_FOREIGN_SCOPE"],
      ["another receipt's disclosures, consistently hashed", { ...i, materialDecisions: { ...d, receiptHash: sha("r2"), disclosuresHash: disclosuresHashOf(d.planHash, sha("r2"), d.items) } }, "FACTS_FOREIGN_SCOPE"],
      ["simulated decisions in the platform's inputs", { ...i, materialDecisions: { binding: "SIMULATED", ids: ["D-1"] } }, "DECISIONS_UNVERIFIABLE"],
      ["Kauro's internal evidence class", { ...i, privacyClass: "INTERNAL_EVIDENCE" }, "PRIVACY_UNAUTHORIZED"],
      ["a summary class for wider circulation", { ...i, privacyClass: "AGENCY_SUMMARY" }, "PRIVACY_UNAUTHORIZED"],
      ["counts the platform does not have", { ...i, countFacts: null }, "COUNTS_UNAVAILABLE"],
      ["inputs read for another attempt", { ...i, scope: { ...SCOPE, attemptId: v7(6003) } }, "FACTS_FOREIGN_SCOPE"],
      ["no inputs at all", null as unknown as AuthorizedReportInputs, "FACTS_UNAVAILABLE"],
    ];
    for (const [label, inputs, code] of cases) refused(inputs, code, label);
  });

  it("order 7 (CMD008): a branding version's stored logo is printed only as the bytes whose SHA-256 the version names — other bytes, missing bytes or a malformed record are refused", () => {
    const px = new Uint8Array(8 * 4 * 4).fill(200);
    const admitted = admitLogo(encodePng(8, 4, px));
    assert.ok(admitted.ok);
    const logo = admitted.logo;
    const i = good();
    const b = i.branding as Extract<AuthorizedReportInputs["branding"], { binding: "AGENCY_BRANDING_V1" }>;
    const named = { ...i, branding: { ...b, logo: { logoId: v7(7001), sha256: logo.sha256, mediaType: "image/png" as const } }, logo: logo.bytes };
    assert.deepEqual(assembleReportFacts(SCOPE, named, RENDERER).branding, { version: "agency-branding-v2", displayName: b.displayName, logo: { sha256: logo.sha256, mediaType: "image/png" } });
    const other = admitLogo(encodePng(8, 4, new Uint8Array(8 * 4 * 4).fill(10)));
    assert.ok(other.ok);
    refused({ ...named, logo: other.logo.bytes }, "BRANDING_UNVERIFIABLE", "bytes that are not the stored logo the version names");
    refused({ ...named, logo: null }, "BRANDING_UNAVAILABLE", "a version naming a logo whose bytes are not visible");
    refused({ ...named, branding: { ...named.branding, logo: { ...named.branding.logo, sha256: "not-a-hash" } } }, "FACTS_MALFORMED", "a logo not named by a SHA-256");
    refused({ ...named, branding: { ...named.branding, logo: { ...named.branding.logo, mediaType: "image/svg+xml" as "image/png" } } }, "FACTS_MALFORMED", "a logo that is not the pipeline's PNG");
    refused({ ...i, logo: logo.bytes }, "BRANDING_UNVERIFIABLE", "logo bytes for a version that names no logo");
  });

  it("the legal identity document admits only recorded facts: complete, closed, canonical, printable and no placeholder", () => {
    const bytes = legalIdentityBytesOf(TEST_IDENTITY);
    const read = readLegalIdentity(bytes);
    assert.ok(read.ok);
    assert.equal(read.ok && read.sha256, rawDigest(bytes));
    for (const [field, value] of [
      ["legalName", ""],
      ["legalName", " Padded S.A.S."],
      ["taxId", "[NIT]"],
      ["taxId", "REQUIRES_REVIEW"],
      ["commercialRegistrationId", "PENDING"],
      ["registeredAddress", "Calle 1 <b>"],
      ["registeredAddress", "Calle\u200bHidden"],
      ["jurisdiction", "Colombia"],
      ["legalName", "Smith & Co"],
    ] as const) {
      assert.ok(legalIdentityProblems({ ...TEST_IDENTITY, [field]: value }).length > 0, `${field}=${JSON.stringify(value)} is not a recorded fact`);
      assert.throws(() => legalIdentityBytesOf({ ...TEST_IDENTITY, [field]: value }));
    }
    assert.deepEqual(legalIdentityProblems({ ...TEST_IDENTITY, extra: "x" }), ["IDENTITY_NOT_CLOSED"]);
    const { registeredAddress: _omitted, ...missing } = TEST_IDENTITY;
    assert.deepEqual(legalIdentityProblems(missing), ["IDENTITY_NOT_CLOSED"]);
    assert.equal(readLegalIdentity(new TextEncoder().encode("Synthetic Test Issuer S.A.S.")).ok, false);
  });
});

describe("order 6 the chain from the platform's inputs: a staged PDF, and no simulated input admitted", () => {
  for (const name of [CLEAN, SALESFORCE] as const) {
    it(`${name}: the platform's inputs produce the report, naming the issuer of the legal identity document and the quote's terms`, async () => {
      const r = nextRig();
      const inputs: ReportInputsPort = { read: async (scope) => platformInputsOf(scope, platformRecordOf(name)) };
      const core = await acceptanceCore(name).execute(r.fixture.subject, r.io);
      const files = await readStagedPackage(r.storage, core.stagedArtifacts);
      const produced = await produceStagedReport({ files, scope: r.scope, writer: r.writer, storage: r.storage, inputs, engine: scriptedEngine(), render, cancellation: r.channel });
      const model = produced.report.model;
      const expected = platformInputsOf(r.scope, platformRecordOf(name));
      assert.equal(model.issuer.legalName, TEST_IDENTITY.legalName);
      assert.equal(model.termsSha256, (expected.terms as QuoteTerms).termsSha256);
      assert.equal(model.branding.version, "agency-branding-v2");
      assert.equal(produced.report.countsBinding, "BOUND");
      assert.equal(produced.staged.stage, "STAGED_VERIFIED");
    });
  }

  it("the simulator's inputs are refused by a composition that does not admit them: INPUTS_SIMULATED, no engine call, nothing staged", async () => {
    const r = nextRig();
    const engine = scriptedEngine();
    const simulated: ReportInputsPort = { read: async (scope) => simulatedReportInputsOf(scope, platformRecordOf(CLEAN)) };
    const outcome = await new ReportingExecutionEnvelope({ inner: acceptanceCore(CLEAN), storage: r.storage, inputs: simulated, engine, render }).execute(r.fixture.subject, r.io);
    assert.equal(outcome.terminalCause, "REFUSED");
    assert.equal(outcome.refusal?.code, "REPORT_INPUTS_SIMULATED");
    assert.equal(engine.calls, 0);
    assert.ok(r.writer.artifacts().every((a) => a.role !== "report-pdf" && a.role !== "report-record"));
  });

  it("a missing legal identity ends the attempt REFUSED ISSUER_UNAVAILABLE before the engine runs", async () => {
    const r = nextRig();
    const engine = scriptedEngine();
    const inputs: ReportInputsPort = {
      read: async (scope) => {
        const i = platformInputsOf(scope, platformRecordOf(CLEAN));
        return { ...i, terms: { ...(i.terms as QuoteTerms), issuer: { ...((i.terms as QuoteTerms).issuer as NonNullable<QuoteTerms["issuer"]>), identity: null } } };
      },
    };
    const outcome = await new ReportingExecutionEnvelope({ inner: acceptanceCore(CLEAN), storage: r.storage, inputs, engine, render }).execute(r.fixture.subject, r.io);
    assert.equal(outcome.refusal?.code, "REPORT_ISSUER_UNAVAILABLE");
    assert.equal(engine.calls, 0);
  });
});
