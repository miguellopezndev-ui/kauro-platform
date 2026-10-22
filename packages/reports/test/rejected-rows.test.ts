// F-31 (Order 14): a package the core verified, holding rows it could not read (REJECTED_INPUT) and rows no record mapping covers
// (LEFTOVER), both written with contribution_kind NONE, is read; and every way of forging those rows is still refused. The package is
// the vendored core's own output (test/fixtures/mc-3.0.0-rejected/PROVENANCE.json; the data-plane suite re-runs the core and compares
// the bytes). The core's rules this checks against: run-migration.ts writes NONE only for a rejected row and for a row no mapping
// covers; a sheet's readerRowCount is its dataRowCount plus its rejectedRowCount; reconciliation.sourceRows.ingested is the sum of
// readerRowCount and equals sourceRows.total (verify-package.ts `reconciliation.equation`, reconcile.ts `assertReconciliationSound`).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReportModel, readMigrationPackage, renderReportHtml, ReportModelError } from "../src/index.js";
import type { ProblemCode } from "../src/index.js";
import { facts, fileText, forge, loadRejectedPackage, manifestOf, REJECTED_CASE, writeManifest } from "./support/fixtures.js";

const R = "03_TRACEABILITY/reconciliation.json";
const L = "03_TRACEABILITY/source-lineage.csv";
const REJECTED = "02_EXCEPTIONS/rejected-input.csv";
const LEFTOVERS = "02_EXCEPTIONS/leftovers.csv";

function refusal(files: Map<string, Uint8Array>): { codes: ProblemCode[]; text: string } {
  try {
    readMigrationPackage(files);
  } catch (error) {
    assert.ok(error instanceof ReportModelError, `expected ReportModelError, got ${String(error)}`);
    return { codes: error.problems.map((p) => p.code), text: `${error.message} ${JSON.stringify(error.problems)}` };
  }
  assert.fail("the package was accepted");
}
const editJson = (files: Map<string, Uint8Array>, path: string, edit: (json: any) => void): void => {
  const json = JSON.parse(fileText(files, path));
  edit(json);
  forge(files, path, JSON.stringify(json));
};
const editManifest = (files: Map<string, Uint8Array>, edit: (manifest: any) => void): void => {
  const manifest = manifestOf(files);
  edit(manifest);
  writeManifest(files, manifest);
};
/** The lineage with one row (found by its row locator) changed by `edit` on its fields. */
const editLineageRow = (files: Map<string, Uint8Array>, locator: string, edit: (row: Record<string, string>) => void): void => {
  const lines = fileText(files, L).split("\n");
  const header = (lines[0] as string).split(",");
  const at = lines.findIndex((line) => line.includes(`,${locator},`));
  assert.ok(at > 0, `no lineage row ${locator}`);
  const row = Object.fromEntries((lines[at] as string).split(",").map((v, i) => [header[i] as string, v]));
  edit(row);
  lines[at] = header.map((h) => row[h] ?? "").join(",");
  forge(files, L, lines.join("\n"));
};
const REJECTED_ROW = "F-a75de921c085:S0:R7";
const LEFTOVER_ROW = "F-21ded67ecb22:S0:R2";

describe("F-31: a verified package with rows the core could not read is read, and nothing about those rows is hidden", () => {
  it("the core's own package verifies, with the core's manifest hash and package digest", () => {
    const files = loadRejectedPackage();
    const pkg = readMigrationPackage(files);
    assert.equal(files.size, REJECTED_CASE.files);
    assert.equal(pkg.manifestSha256, REJECTED_CASE.manifestSha256);
    assert.equal(pkg.packageDigest, REJECTED_CASE.packageDigest);
    const rows = pkg.reconciliation.sourceRows;
    assert.equal(rows.total, 23);
    assert.equal(rows.ingested, 23);
    assert.deepEqual({ ...rows.byDisposition }, { ISOLATED: 0, LEFTOVER: 2, MERGED_PROVEN: 0, OUTPUT: 19, REJECTED_INPUT: 2 });
    assert.deepEqual({ ...pkg.lineage.byKindDisposition }, { "ASSOCIATION/OUTPUT": 4, "NONE/LEFTOVER": 2, "NONE/REJECTED_INPUT": 2, "RECORD/OUTPUT": 15 });
    // the readers' rows, kept apart as the core keeps them: data rows plus rejected rows are the rows read
    assert.equal(pkg.inputs.reduce((s, i) => s + i.dataRowCount, 0), 21);
    assert.equal(pkg.inputs.reduce((s, i) => s + i.rejectedRowCount, 0), 2);
    assert.equal(pkg.reconciliation.records.deliveredTotal, 15);
  });

  it("the model, its HTML and its counts show the rejected rows, and every source row is accounted for once", () => {
    const pkg = readMigrationPackage(loadRejectedPackage());
    const report = buildReportModel(pkg, facts("A-clean-multi-object", { expectedManifestSha256: REJECTED_CASE.manifestSha256 }));
    const c = report.model.counts;
    assert.equal(c.physicalSourceRows.value, 23);
    assert.equal(c.rejected.value, 2);
    assert.equal(c.rejected.source.locator, "/sourceRows/byDisposition/REJECTED_INPUT");
    assert.equal(c.withheld.value, 2);
    assert.equal(c.emittedRepresentatives.value + c.mergedNonSurvivors.value + c.withheld.value + c.rejected.value, c.physicalSourceRows.value);
    assert.equal(c.unresolved.value, 0);
    const rejectedFile = report.model.exceptions.find((a) => a.path === REJECTED);
    assert.equal(rejectedFile?.records?.value, 2);
    assert.equal(report.model.exceptions.find((a) => a.path === LEFTOVERS)?.records?.value, 2);
    const { html } = renderReportHtml(report, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.match(html, /data-figure="rejected"[^>]*>2</);
    assert.match(html, /data-figure="physicalSourceRows"[^>]*>23</);
    assert.ok(html.includes(REJECTED));
  });
});

describe("F-31: the rows the core could not read cannot be forged", () => {
  it("a rejected row relabelled as a record, or as a delivered row, is refused", () => {
    const asRecord = loadRejectedPackage();
    editLineageRow(asRecord, REJECTED_ROW, (r) => (r["contribution_kind"] = "RECORD"));
    assert.ok(refusal(asRecord).codes.includes("RECONCILIATION_MISMATCH"));
    const delivered = loadRejectedPackage();
    editLineageRow(delivered, REJECTED_ROW, (r) => (r["disposition"] = "OUTPUT"));
    assert.ok(refusal(delivered).codes.includes("RECONCILIATION_MISMATCH"));
  });

  it("NONE only goes with a row the core could not read or a row no mapping covers, and carries no record", () => {
    const merged = loadRejectedPackage();
    editLineageRow(merged, LEFTOVER_ROW, (r) => (r["disposition"] = "MERGED_PROVEN"));
    editJson(merged, R, (r) => {
      r.sourceRows.byDisposition.LEFTOVER -= 1;
      r.sourceRows.byDisposition.MERGED_PROVEN += 1;
    });
    assert.ok(refusal(merged).codes.includes("RECONCILIATION_MISMATCH"));
    const keyed = loadRejectedPackage();
    editLineageRow(keyed, REJECTED_ROW, (r) => {
      r["object"] = "CONTACT";
      r["migration_key"] = "mk_contact_0000000000000000";
    });
    assert.match(refusal(keyed).text, /NONE/);
    const unknownKind = loadRejectedPackage();
    editLineageRow(unknownKind, REJECTED_ROW, (r) => (r["contribution_kind"] = "NOTHING"));
    assert.ok(refusal(unknownKind).codes.includes("RECONCILIATION_MISMATCH"));
  });

  it("the reconciliation moving a rejected row to leftover, with conserving sums, is refused", () => {
    const files = loadRejectedPackage();
    editJson(files, R, (r) => {
      r.sourceRows.byDisposition.REJECTED_INPUT -= 1;
      r.sourceRows.byDisposition.LEFTOVER += 1;
    });
    assert.ok(refusal(files).codes.includes("RECONCILIATION_MISMATCH"));
  });

  it("a rejected-input table that drops, duplicates or renames a row is refused, even re-declared in the manifest", () => {
    const dropped = loadRejectedPackage();
    const lines = fileText(dropped, REJECTED).split("\n");
    forge(dropped, REJECTED, [lines[0], lines[1], ""].join("\n"));
    assert.ok(refusal(dropped).codes.includes("RECONCILIATION_MISMATCH"));
    const doubled = loadRejectedPackage();
    forge(doubled, REJECTED, [lines[0], lines[1], lines[1], ""].join("\n"));
    editJson(doubled, R, (r) => {
      r.sourceRows.byDisposition.REJECTED_INPUT += 1;
      r.sourceRows.byDisposition.OUTPUT -= 1;
    });
    assert.ok(refusal(doubled).codes.includes("RECONCILIATION_MISMATCH"));
    const renamed = loadRejectedPackage();
    forge(renamed, REJECTED, fileText(renamed, REJECTED).replace(`,${REJECTED_ROW},`, ",F-a75de921c085:S0:R2,"));
    assert.match(refusal(renamed).text, /rejected-input\.csv/);
  });

  it("the readers' counts in the manifest must hold: rows read = data rows + rejected rows = ingested = the lineage", () => {
    const sheetOf = (m: any, fileIndex: number): Record<string, number> => m.inputs[fileIndex].sheets[0];
    const contacts = (m: any): number => m.inputs.findIndex((i: any) => i.path === "contacts.csv");
    const hidden = loadRejectedPackage();
    editManifest(hidden, (m) => {
      const s = sheetOf(m, contacts(m));
      s["rejectedRowCount"] = (s["rejectedRowCount"] as number) - 1;
    });
    assert.ok(refusal(hidden).codes.includes("RECONCILIATION_MISMATCH"));
    const reread = loadRejectedPackage();
    editManifest(reread, (m) => {
      const s = sheetOf(m, contacts(m));
      s["rejectedRowCount"] = (s["rejectedRowCount"] as number) - 1;
      s["dataRowCount"] = (s["dataRowCount"] as number) + 1;
    });
    assert.ok(refusal(reread).codes.includes("RECONCILIATION_MISMATCH"));
    const ingested = loadRejectedPackage();
    editJson(ingested, R, (r) => (r.sourceRows.ingested += 1));
    assert.ok(refusal(ingested).codes.includes("RECONCILIATION_MISMATCH"));
    const missing = loadRejectedPackage();
    editManifest(missing, (m) => delete sheetOf(m, 0)["readerRowCount"]);
    assert.ok(refusal(missing).codes.includes("MANIFEST_MALFORMED"));
  });

  it("a changed byte anywhere in the package still fails its hash", () => {
    const files = loadRejectedPackage();
    const bytes = new Uint8Array(files.get(REJECTED) as Uint8Array);
    bytes[bytes.length - 2] = (bytes[bytes.length - 2] as number) ^ 1;
    files.set(REJECTED, bytes);
    assert.deepEqual(refusal(files).codes, ["ARTIFACT_BYTES_MISMATCH"]);
  });
});
