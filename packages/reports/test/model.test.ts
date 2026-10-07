// buildReportModel over the Migration Core 3.0.0 acceptance packages (design B13-report-model.md §3, §4; R2-065, R2-069,
// R2-070, R2-071, CMD008-OK at the model level; review ADV-3, ADV-5, ADV-7).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportModel, readMigrationPackage, ReportModelError } from "../src/index.js";
import type { ProblemCode, VerifiedPackage } from "../src/index.js";
import { CASES, facts, fileText, forge, loadPackage, rowsOf, TERMS_SHA256 } from "./support/fixtures.js";

function refusal(run: () => unknown): ProblemCode[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReportModelError, String(error));
    return error.problems.map((p) => p.code);
  }
  assert.fail("accepted");
}

describe("every count equals an independent count of the evidence tables (not the reconciliation the model read)", () => {
  for (const name of CASES) {
    it(name, () => {
      const files = loadPackage(name);
      const { model } = buildReportModel(readMigrationPackage(files), facts(name));
      const lineage = rowsOf(files, "03_TRACEABILITY/source-lineage.csv");
      const edges = rowsOf(files, "03_TRACEABILITY/associations.csv");
      const manifest = JSON.parse(fileText(files, "manifest.json")) as { artifacts: { path: string; kind: string }[] };
      const records = (path: string): number => fileText(files, path).split("\n").filter((l) => l.length > 0).length - 1;
      const by = (rows: Record<string, string>[], key: string, value: string): number => rows.filter((r) => r[key] === value).length;
      const c = model.counts;
      assert.equal(c.physicalSourceRows.value, lineage.length);
      assert.equal(c.logicalSourceRecords.value, by(lineage, "contribution_kind", "RECORD"));
      assert.equal(c.emittedRepresentatives.value, by(lineage, "disposition", "OUTPUT"));
      assert.equal(c.mergedNonSurvivors.value, by(lineage, "disposition", "MERGED_PROVEN"));
      assert.equal(c.rejected.value, records("02_EXCEPTIONS/rejected-input.csv"));
      assert.equal(c.withheld.value, records("02_EXCEPTIONS/isolated.csv") + records("02_EXCEPTIONS/leftovers.csv"));
      assert.equal(c.associationEdges.value, edges.length);
      assert.equal(c.emittedArtifactRows.value, manifest.artifacts.filter((a) => a.kind === "MACHINE_IMPORT_CSV").reduce((s, a) => s + records(a.path), 0));
      assert.equal(model.relationships.delivered.value, by(edges, "disposition", "OUTPUT"));
      assert.equal(model.relationships.leftover.value, by(edges, "disposition", "LEFTOVER"));
      for (const object of ["COMPANY", "CONTACT", "DEAL", "LEAD"] as const)
        assert.equal(model.deliveredByObject[object].value, lineage.filter((r) => r["contribution_kind"] === "RECORD" && r["disposition"] === "OUTPUT" && r["object"] === object).length, object);
      assert.equal(c.emittedArtifactRows.source.artifact, "01_IMPORT");
      assert.equal(c.physicalSourceRows.value, c.emittedRepresentatives.value + c.mergedNonSurvivors.value + c.rejected.value + c.withheld.value + c.unresolved.value);
    });
  }
});

describe("R2-065: physical rows, billable source units and output rows are separate named measures", () => {
  it("D-salesforce: 19 physical rows, 17 billable units from the quote, 23 import rows, 15 logical records", () => {
    const { model, snapshot } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts("D-salesforce", { billableSourceUnits: 17 }));
    assert.equal(model.counts.physicalSourceRows.value, 19);
    assert.equal(model.counts.billableSourceUnits.value, 17);
    assert.deepEqual(model.counts.billableSourceUnits.source, { artifact: "input:quote", locator: "/quotes/q-0001/billableSourceUnits" });
    assert.equal(model.counts.emittedArtifactRows.value, 23);
    assert.equal(model.counts.logicalSourceRecords.value, 15);
    assert.equal(model.counts.withheld.value, 4);
    assert.equal(snapshot.counts.billableSourceUnits, 17);
  });
  it("a package with undecided rows yields no report (forged lineage and reconciliation the reader accepts)", () => {
    const files = loadPackage("A-clean-multi-object");
    const L = "03_TRACEABILITY/source-lineage.csv";
    forge(files, L, fileText(files, L).replace(/,ASSOCIATION,OUTPUT,/, ",ASSOCIATION,,"));
    const R = "03_TRACEABILITY/reconciliation.json";
    const r = JSON.parse(fileText(files, R));
    r.sourceRows.byDisposition.OUTPUT -= 1;
    r.sourceRows.accountedFor -= 1;
    r.sourceRows.withoutDisposition = 1;
    forge(files, R, JSON.stringify(r));
    const pkg = readMigrationPackage(files);
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("A-clean-multi-object", { expectedManifestSha256: pkg.manifestSha256 }))), ["UNRESOLVED_DECISIONS"]);
  });
});

describe("ADV-1 R2: the reason-code tally is not a figure of the model", () => {
  it("an inflated tally with a markup key, re-declared in the manifest, reaches nothing the model shows", () => {
    const files = loadPackage("D-salesforce");
    const R = "03_TRACEABILITY/reconciliation.json";
    const r = JSON.parse(fileText(files, R));
    r.reasonCodeTally.ASSOCIATION_RESOLVED = 800;
    r.reasonCodeTally["<img src=x onerror=alert(1)>"] = 1;
    forge(files, R, JSON.stringify(r));
    const pkg = readMigrationPackage(files);
    const { model } = buildReportModel(pkg, facts("D-salesforce", { expectedManifestSha256: pkg.manifestSha256 }));
    const text = JSON.stringify(model);
    assert.ok(!("reasonCodes" in model) && !text.includes("<img"));
  });
});

describe("ADV-3: the model is bound to the platform's record of the package and says whether its counts are", () => {
  const pkg = readMigrationPackage(loadPackage("C-identity-adversarial"));
  it("a package other than the one the platform recorded is refused", () => {
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("C-identity-adversarial", { expectedManifestSha256: "0".repeat(64) }))), ["PACKAGE_BINDING_MISMATCH"]);
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("D-hubspot"))), ["PACKAGE_BINDING_MISMATCH"]);
  });
  it("without the platform's counts the model and the report say UNBOUND; with equal counts BOUND; with different counts it is refused", () => {
    const unbound = buildReportModel(pkg, facts("C-identity-adversarial"));
    assert.equal(unbound.countsBinding, "UNBOUND");
    assert.equal(unbound.model.countsBinding, "UNBOUND");
    const bound = buildReportModel(pkg, facts("C-identity-adversarial", { declaredCounts: unbound.snapshot.counts }));
    assert.equal(bound.countsBinding, "BOUND");
    assert.notEqual(bound.modelHash, unbound.modelHash);
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("C-identity-adversarial", { declaredCounts: { ...unbound.snapshot.counts, mergedNonSurvivors: 0 } }))), ["DECLARED_COUNTS_MISMATCH"]);
  });
});

describe("ADV-5: only a package the reader produced is accepted, and the model cannot change after it is hashed", () => {
  const pkg = readMigrationPackage(loadPackage("D-hubspot"));
  it("a look-alike package object is refused", () => {
    const lookAlike = { ...pkg } as VerifiedPackage;
    assert.deepEqual(refusal(() => buildReportModel(lookAlike, facts("D-hubspot"))), ["PACKAGE_UNVERIFIED"]);
  });
  it("changing the facts after the build changes nothing, and the model is frozen", () => {
    const input = facts("D-hubspot") as { branding: { displayName: string }; issuer: { legalName: string } };
    const report = buildReportModel(pkg, input);
    input.branding.displayName = "Changed";
    input.issuer.legalName = "Other Inc.";
    assert.equal(report.model.branding.displayName, "Northwind Data Partners");
    assert.equal(report.model.issuer.legalName, "Kauro Data S.A.S.");
    assert.ok(Object.isFrozen(report.model) && Object.isFrozen(report.model.branding) && Object.isFrozen(report.model.package.target) && Object.isFrozen(report.snapshot));
    assert.throws(() => {
      (report.model.counts.physicalSourceRows as { value: number }).value = 1;
    }, TypeError);
  });
});

describe("R2-069: the import artifacts are identified apart from the human-safe ones", () => {
  it("the guide lists only 01_IMPORT machine files, parents first, then associations, each with its hash", () => {
    const { model } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts("D-salesforce"));
    assert.deepEqual(
      model.importGuide.map((s) => [s.order, s.path, s.object, s.association, s.records.value]),
      [
        [1, "01_IMPORT/salesforce/Account.csv", "COMPANY", null, 4],
        [2, "01_IMPORT/salesforce/Contact.csv", "CONTACT", null, 5],
        [3, "01_IMPORT/salesforce/Opportunity.csv", "DEAL", null, 3],
        [4, "01_IMPORT/salesforce/Lead.csv", "LEAD", null, 3],
        [5, "01_IMPORT/salesforce/associations/company_to_deal.csv", null, { from: "COMPANY", to: "DEAL" }, 3],
        [6, "01_IMPORT/salesforce/associations/contact_to_company.csv", null, { from: "CONTACT", to: "COMPANY" }, 5],
        [7, "01_IMPORT/salesforce/associations/contact_to_deal.csv", null, { from: "CONTACT", to: "DEAL" }, 0],
      ],
    );
    for (const step of model.importGuide) assert.match(step.sha256, /^[0-9a-f]{64}$/);
  });
  it("the neutralised data view has the same name as an import file but a different use and hash", () => {
    const { model } = buildReportModel(readMigrationPackage(loadPackage("A-clean-multi-object")), facts("A-clean-multi-object"));
    const machine = model.artifacts.find((a) => a.path === "01_IMPORT/clean-only/contacts.csv");
    const view = model.artifacts.find((a) => a.path === "04_DOCUMENTATION/data-view/clean-only/contacts.csv");
    assert.equal(machine?.use, "IMPORT");
    assert.equal(view?.use, "HUMAN_VIEW");
    assert.notEqual(machine?.sha256, view?.sha256);
    assert.ok(!model.importGuide.some((s) => s.path.startsWith("04_DOCUMENTATION/")));
  });
});

describe("R2-070 (PARTIAL): branding cannot fabricate the issuer", () => {
  const pkg = readMigrationPackage(loadPackage("D-hubspot"));
  it("a brand named like another company leaves the issuer and the terms hash as the terms state them", () => {
    const { model } = buildReportModel(pkg, facts("D-hubspot", { branding: { version: "brand-9", displayName: "Other Company Inc.", logo: null } }));
    assert.equal(model.issuer.legalName, "Kauro Data S.A.S.");
    assert.equal(model.termsSha256, TERMS_SHA256);
  });
  it("branding carrying an issuer, facts carrying an unknown key, or a facts object that cannot be copied are refused", () => {
    assert.ok(refusal(() => buildReportModel(pkg, facts("D-hubspot", { branding: { version: "b", displayName: "X", logo: null, issuer: { legalName: "Other Inc." } } }))).includes("FACTS_MALFORMED"));
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("D-hubspot", { issuerOverride: "Other Inc." }))), ["FACTS_MALFORMED"]);
    assert.deepEqual(refusal(() => buildReportModel(pkg, new Proxy(facts("D-hubspot"), {}))), ["FACTS_MALFORMED"]);
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts("D-hubspot", { termsSha256: "not-a-hash" }))), ["FACTS_MALFORMED"]);
  });
  for (const hostile of ["<img src=x onerror=alert(1)>", "Acme‮gnp.exe", "Acme\u0000", "   ", "x".repeat(121), "Café", 'Acme" onmouseover="x', "O'Brien", "A&B", "Acme`x`", "Ac​me", "Acme x", "﻿Acme"]) {
    it(`S069 at the model: a hostile brand name is refused (${JSON.stringify(hostile).slice(0, 24)})`, () => {
      assert.deepEqual(refusal(() => buildReportModel(pkg, facts("D-hubspot", { branding: { version: "b", displayName: hostile, logo: null } }))), ["BRANDING_UNSAFE"]);
    });
  }
  it("CMD008-DENY at the model: a logo is a stored PNG/JPEG named by hash, never a URL or SVG", () => {
    for (const logo of [{ sha256: "https://evil.example/logo.png", mediaType: "image/png" }, { sha256: "a".repeat(64), mediaType: "image/svg+xml" }, { url: "https://evil.example/x.png" }])
      assert.deepEqual(refusal(() => buildReportModel(pkg, facts("D-hubspot", { branding: { version: "b", displayName: "X", logo } }))), ["BRANDING_UNSAFE"]);
  });
});

describe("privacy class and immutability", () => {
  const pkg = readMigrationPackage(loadPackage("C-identity-adversarial"));
  it("an AGENCY_SUMMARY report carries no source file name; SECURE_DETAIL carries it typed untrusted", () => {
    const summary = buildReportModel(pkg, facts("C-identity-adversarial", { privacyClass: "AGENCY_SUMMARY" })).model;
    const detail = buildReportModel(pkg, facts("C-identity-adversarial", { privacyClass: "SECURE_DETAIL" })).model;
    assert.ok(summary.lineage.inputs.every((i) => i.fileName === null));
    assert.ok(!JSON.stringify(summary).includes(pkg.inputs[0]?.fileName.untrusted as string));
    assert.ok(detail.lineage.inputs.every((i) => typeof i.fileName?.untrusted === "string"));
  });
  it("CMD008-OK at the model: a new branding version yields a new model hash and leaves the delivered report's hash as it was", () => {
    const first = buildReportModel(pkg, facts("C-identity-adversarial"));
    const rebranded = buildReportModel(pkg, facts("C-identity-adversarial", { reportId: "rpt-0002", branding: { version: "brand-4", displayName: "Northwind Data Partners", logo: null } }));
    assert.equal(buildReportModel(pkg, facts("C-identity-adversarial")).modelHash, first.modelHash);
    assert.notEqual(rebranded.modelHash, first.modelHash);
    assert.equal(first.snapshot.modelHash, first.modelHash);
    assert.equal(rebranded.snapshot.brandingVersion, "brand-4");
  });
  it("R2-071 at the model: exception tables keep their complete record counts and hashes (no clipping)", () => {
    const { model } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts("D-salesforce"));
    assert.equal(model.exceptions.find((a) => a.path === "02_EXCEPTIONS/leftovers.csv")?.records?.value, 4);
    assert.equal(model.exceptions.length, 8);
  });
});
