// buildReportModel over the Migration Core 3.0.0 acceptance packages (design B13-report-model.md §3, §4; R2-065, R2-069,
// R2-070, R2-071, CMD008-OK at the model level).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportModel, readMigrationPackage, ReportModelError } from "../src/index.js";
import type { Figure, ProblemCode, VerifiedPackage } from "../src/index.js";
import { CASES, facts, fileText, loadPackage } from "./support/fixtures.js";

function refusal(run: () => unknown): ProblemCode[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReportModelError, String(error));
    return error.problems.map((p) => p.code);
  }
  assert.fail("accepted");
}

/** Reads a figure's value back from the package by its source, independently of the model's arithmetic. */
function resolve(files: Map<string, Uint8Array>, figure: Figure): number {
  const { artifact, locator } = figure.source;
  if (artifact === "03_TRACEABILITY/reconciliation.json") {
    const json = JSON.parse(fileText(files, artifact));
    return locator.split(" + ").reduce((sum, pointer) => sum + pointer.split("/").slice(1).reduce((o, k) => o[k], json), 0);
  }
  if (locator === "records excluding the header") return fileText(files, artifact).split("\n").filter((l) => l.length > 0).length - 1;
  return Number.NaN;
}

describe("every figure names its source, and reading that source gives the figure", () => {
  for (const name of CASES) {
    it(name, () => {
      const files = loadPackage(name);
      const { model } = buildReportModel(readMigrationPackage(files), facts());
      const figures: Figure[] = [...Object.values(model.counts), ...Object.values(model.deliveredByObject), ...Object.values(model.relationships), ...model.importGuide.map((s) => s.records), ...model.reasonCodes.map((r) => r.occurrences)];
      for (const figure of figures) {
        if (figure.source.artifact === "input:quote") continue;
        assert.ok(figure.source.artifact === "manifest.json" || files.has(figure.source.artifact), figure.source.artifact);
        const back = resolve(files, figure);
        if (!Number.isNaN(back)) assert.equal(back, figure.value, `${figure.source.artifact} ${figure.source.locator}`);
      }
      // the row equation the report states: physical rows = emitted + merged + rejected + withheld + unresolved
      const c = model.counts;
      assert.equal(c.physicalSourceRows.value, c.emittedRepresentatives.value + c.mergedNonSurvivors.value + c.rejected.value + c.withheld.value + c.unresolved.value);
    });
  }
});

describe("R2-065: physical rows, billable source units and output rows are separate named measures", () => {
  it("D-salesforce: 19 physical rows, 17 billable units from the quote, 23 import rows, 15 logical records", () => {
    const { model, snapshot } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts({ billableSourceUnits: 17 }));
    assert.equal(model.counts.physicalSourceRows.value, 19);
    assert.equal(model.counts.billableSourceUnits.value, 17);
    assert.deepEqual(model.counts.billableSourceUnits.source, { artifact: "input:quote", locator: "/quotes/q-0001/billableSourceUnits" });
    assert.equal(model.counts.emittedArtifactRows.value, 23);
    assert.equal(model.counts.logicalSourceRecords.value, 15);
    assert.equal(model.counts.withheld.value, 4);
    assert.equal(snapshot.counts.billableSourceUnits, 17);
    assert.equal(snapshot.counts.physicalSourceRows, 19);
  });
  it("a platform manifest whose counts differ from what the bytes prove is refused; equal counts pass", () => {
    const pkg = readMigrationPackage(loadPackage("C-identity-adversarial"));
    const { snapshot } = buildReportModel(pkg, facts());
    assert.doesNotThrow(() => buildReportModel(pkg, facts({ declaredCounts: snapshot.counts })));
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts({ declaredCounts: { ...snapshot.counts, mergedNonSurvivors: 0 } }))), ["DECLARED_COUNTS_MISMATCH"]);
  });
  it("a package with undecided rows yields no report", () => {
    const pkg = readMigrationPackage(loadPackage("B-dirty-multinational"));
    const forged: VerifiedPackage = { ...pkg, reconciliation: { ...pkg.reconciliation, sourceRows: { ...pkg.reconciliation.sourceRows, withoutDisposition: 1 } } };
    assert.deepEqual(refusal(() => buildReportModel(forged, facts())), ["UNRESOLVED_DECISIONS"]);
  });
});

describe("R2-069: the import artifacts are identified apart from the human-safe ones", () => {
  it("the guide lists only 01_IMPORT machine files, parents first, then associations, each with its hash", () => {
    const { model } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts());
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
    const { model } = buildReportModel(readMigrationPackage(loadPackage("A-clean-multi-object")), facts());
    const machine = model.artifacts.find((a) => a.path === "01_IMPORT/clean-only/contacts.csv");
    const view = model.artifacts.find((a) => a.path === "04_DOCUMENTATION/data-view/clean-only/contacts.csv");
    assert.equal(machine?.use, "IMPORT");
    assert.equal(view?.use, "HUMAN_VIEW");
    assert.notEqual(machine?.sha256, view?.sha256);
    assert.ok(!model.importGuide.some((s) => s.path.startsWith("04_DOCUMENTATION/")));
  });
});

describe("R2-070: the issuer comes from the terms, branding cannot fabricate it", () => {
  const pkg = readMigrationPackage(loadPackage("D-hubspot"));
  it("the model's issuer is the terms' issuer whatever the brand is called", () => {
    const { model } = buildReportModel(pkg, facts({ branding: { version: "brand-9", displayName: "Kauro Data S.A.S.", logo: null } }));
    assert.deepEqual(model.issuer, { legalName: "Kauro Data S.A.S.", jurisdiction: "Colombia", registrationId: "NIT-PENDING-OWNER" });
    assert.equal(model.branding.displayName, "Kauro Data S.A.S.");
  });
  it("branding carrying an issuer, or facts carrying an unknown key, are refused", () => {
    assert.ok(refusal(() => buildReportModel(pkg, facts({ branding: { version: "b", displayName: "X", logo: null, issuer: { legalName: "Other Inc." } } }))).includes("FACTS_MALFORMED"));
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts({ issuerOverride: "Other Inc." }))), ["FACTS_MALFORMED"]);
    assert.deepEqual(refusal(() => buildReportModel(pkg, facts({ issuer: { legalName: "", jurisdiction: "Colombia", registrationId: "x" } }))), ["FACTS_MALFORMED"]);
  });
  for (const hostile of ["<img src=x onerror=alert(1)>", "Acme‮gnp.exe", "Acme\u0000", "   ", "x".repeat(121), "Café"]) {
    it(`S069 at the model: a hostile brand name is refused (${JSON.stringify(hostile).slice(0, 24)})`, () => {
      assert.deepEqual(refusal(() => buildReportModel(pkg, facts({ branding: { version: "b", displayName: hostile, logo: null } }))), ["BRANDING_UNSAFE"]);
    });
  }
  it("CMD008-DENY at the model: a logo is a stored PNG/JPEG named by hash, never a URL or SVG", () => {
    for (const logo of [{ sha256: "https://evil.example/logo.png", mediaType: "image/png" }, { sha256: "a".repeat(64), mediaType: "image/svg+xml" }, { url: "https://evil.example/x.png" }])
      assert.deepEqual(refusal(() => buildReportModel(pkg, facts({ branding: { version: "b", displayName: "X", logo } }))), ["BRANDING_UNSAFE"]);
  });
});

describe("privacy class and immutability", () => {
  const pkg = readMigrationPackage(loadPackage("C-identity-adversarial"));
  it("an AGENCY_SUMMARY report carries no source file name; SECURE_DETAIL does", () => {
    const summary = buildReportModel(pkg, facts({ privacyClass: "AGENCY_SUMMARY" })).model;
    const detail = buildReportModel(pkg, facts({ privacyClass: "SECURE_DETAIL" })).model;
    assert.ok(summary.lineage.inputs.every((i) => i.fileName === null));
    assert.ok(!JSON.stringify(summary).includes(pkg.inputs[0]?.path as string));
    assert.ok(detail.lineage.inputs.every((i) => typeof i.fileName === "string"));
  });
  it("CMD008-OK at the model: a new branding version yields a new model hash and leaves the delivered report's hash as it was", () => {
    const first = buildReportModel(pkg, facts());
    const again = buildReportModel(pkg, facts());
    const rebranded = buildReportModel(pkg, facts({ reportId: "rpt-0002", branding: { version: "brand-4", displayName: "Northwind Data Partners", logo: null } }));
    assert.equal(first.modelHash, again.modelHash);
    assert.notEqual(rebranded.modelHash, first.modelHash);
    assert.equal(buildReportModel(pkg, facts()).modelHash, first.modelHash);
    assert.equal(first.snapshot.modelHash, first.modelHash);
    assert.equal(rebranded.snapshot.brandingVersion, "brand-4");
  });
  it("R2-071 at the model: exception tables keep their complete record counts and hashes (no clipping)", () => {
    const { model } = buildReportModel(readMigrationPackage(loadPackage("D-salesforce")), facts());
    const leftovers = model.exceptions.find((a) => a.path === "02_EXCEPTIONS/leftovers.csv");
    assert.equal(leftovers?.records?.value, 4);
    assert.equal(model.exceptions.length, 8);
  });
});
