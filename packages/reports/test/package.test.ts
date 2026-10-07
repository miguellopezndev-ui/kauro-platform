// readMigrationPackage over the real Migration Core 3.0.0 acceptance packages (EXECUTED_LOCAL: the core's own bytes, read here)
// and over forged copies of them (CMD039-OK, CMD039-DENY; design B13-report-model.md §2, §5).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMigrationPackage, ReportModelError } from "../src/index.js";
import type { ProblemCode } from "../src/index.js";
import { parseCsv } from "../src/csv.js";
import { CASES, fileText, forge, loadPackage, manifestOf, writeManifest } from "./support/fixtures.js";
import type { CaseName } from "./support/fixtures.js";

// Independent oracles. manifestSha256: the core's own acceptance.json. packageDigest: a separate Python implementation of the
// core's `kauro-package-digest/1` definition run over the fixture directories. Rows: the core's acceptance/README.md table.
const ORACLE: Record<CaseName, { manifestSha256: string; packageDigest: string; files: number; sourceRows: number; delivered: number; merged: number; isolated: number; edgesDelivered: number; leftover: number }> = {
  "A-clean-multi-object": { manifestSha256: "69a35b99f6e033d1375ccc0f268adf8d92e09d4c54daf57d2a91a6804bdd985e", packageDigest: "37f98cce23e43a71ad24922ade889f877465e40000bcb00b54d875bbc7ff950a", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "B-dirty-multinational": { manifestSha256: "20d35be70a587da2ae0cd5e7f65b1ab390eb4da1a794407139153155ba1142c4", packageDigest: "543b767d068a58b856f90968e308f943008b0fbbaa1fcb4e9dd12ee2f2f454e7", files: 23, sourceRows: 8, delivered: 8, merged: 0, isolated: 0, edgesDelivered: 0, leftover: 0 },
  "C-identity-adversarial": { manifestSha256: "daca27c3d715ad187612d04321cb87d84cda1fbbae3f34aad128d8f4185754aa", packageDigest: "bb1b68fd4d1b47167fea9e5a9ee4ab0c2ac75f5d7d186b02aa231f783129efb9", files: 22, sourceRows: 10, delivered: 3, merged: 2, isolated: 5, edgesDelivered: 0, leftover: 0 },
  "D-hubspot": { manifestSha256: "6177cda1ce9bacc728b25bb38a7250321a3615cd6dc6818b2cea623b4be82241", packageDigest: "ceab42f60701016c4a67aa6cce82555e36d90a03b767e5f064418d91a0590dd4", files: 28, sourceRows: 16, delivered: 12, merged: 0, isolated: 0, edgesDelivered: 12, leftover: 0 },
  "D-salesforce": { manifestSha256: "46d9e077930d8dbbf73f934e43d5d6d788423f6683e07307e17adbf7bafb43c4", packageDigest: "232f775956d7d61c2c5e38639a2465c4484b58b8a84f7bb23b7461389c1471ce", files: 30, sourceRows: 19, delivered: 15, merged: 0, isolated: 0, edgesDelivered: 8, leftover: 4 },
};

function refusal(files: Map<string, Uint8Array>): ProblemCode[] {
  try {
    readMigrationPackage(files);
  } catch (error) {
    assert.ok(error instanceof ReportModelError, `expected ReportModelError, got ${String(error)}`);
    return error.problems.map((p) => p.code);
  }
  assert.fail("the package was accepted");
}

describe("CMD039-OK: every Migration Core 3.0.0 acceptance package verifies and its figures match the core's own record", () => {
  for (const name of CASES) {
    it(name, () => {
      const files = loadPackage(name);
      const pkg = readMigrationPackage(files);
      const oracle = ORACLE[name];
      assert.equal(files.size, oracle.files);
      assert.equal(pkg.manifestSha256, oracle.manifestSha256);
      assert.equal(pkg.packageDigest, oracle.packageDigest);
      assert.equal(pkg.reconciliation.sourceRows.total, oracle.sourceRows);
      assert.equal(pkg.reconciliation.records.deliveredTotal, oracle.delivered);
      assert.equal(pkg.reconciliation.sourceRows.byDisposition.MERGED_PROVEN, oracle.merged);
      assert.equal(pkg.reconciliation.sourceRows.byDisposition.ISOLATED, oracle.isolated);
      assert.equal(pkg.reconciliation.associations.byDisposition.OUTPUT, oracle.edgesDelivered);
      assert.equal(pkg.reconciliation.sourceRows.byDisposition.LEFTOVER, oracle.leftover);
      assert.equal(pkg.lineage.rows, oracle.sourceRows);
    });
  }
});

describe("CMD039-DENY: a package whose bytes, inventory or sums do not hold is refused", () => {
  it("a changed byte in an import file fails its hash", () => {
    const files = loadPackage("D-hubspot");
    const bytes = new Uint8Array(files.get("01_IMPORT/hubspot/contacts.csv") as Uint8Array);
    bytes[bytes.length - 2] = (bytes[bytes.length - 2] as number) ^ 1;
    files.set("01_IMPORT/hubspot/contacts.csv", bytes);
    assert.deepEqual(refusal(files), ["ARTIFACT_BYTES_MISMATCH"]);
  });

  it("matching manifest sums with wrong data: a dropped import record, re-declared in the manifest, still fails", () => {
    const files = loadPackage("D-hubspot");
    const path = "01_IMPORT/hubspot/contacts.csv";
    const lines = fileText(files, path).split("\n");
    lines.splice(1, 1);
    forge(files, path, lines.join("\n"));
    const codes = refusal(files);
    assert.ok(codes.includes("RECONCILIATION_MISMATCH"), codes.join(","));
  });

  it("a reconciliation rewritten to move a delivered row to leftover, with conserving sums and a re-declared hash, still fails", () => {
    const files = loadPackage("A-clean-multi-object");
    const path = "03_TRACEABILITY/reconciliation.json";
    const rec = JSON.parse(fileText(files, path));
    rec.sourceRows.byDisposition.OUTPUT -= 1;
    rec.sourceRows.byDisposition.LEFTOVER += 1;
    forge(files, path, JSON.stringify(rec));
    const codes = refusal(files);
    assert.ok(codes.includes("RECONCILIATION_MISMATCH"), codes.join(","));
  });

  it("dispositions that do not sum to the total fail even though the core's own equationHolds flag says true", () => {
    const files = loadPackage("B-dirty-multinational");
    const path = "03_TRACEABILITY/reconciliation.json";
    const rec = JSON.parse(fileText(files, path));
    rec.sourceRows.total += 1;
    assert.equal(rec.sourceRows.equationHolds, true);
    forge(files, path, JSON.stringify(rec));
    const codes = refusal(files);
    assert.ok(codes.includes("RECONCILIATION_MISMATCH"), codes.join(","));
  });

  it("an input whose declared data rows differ from the reconciled source rows fails", () => {
    const files = loadPackage("D-salesforce");
    const manifest = manifestOf(files);
    const inputs = manifest["inputs"] as { sheets: { dataRowCount: number }[] }[];
    (inputs[0]?.sheets[0] as { dataRowCount: number }).dataRowCount += 1;
    writeManifest(files, manifest);
    assert.deepEqual(refusal(files), ["RECONCILIATION_MISMATCH"]);
  });

  it("a declared record count that differs from the records in the bytes fails", () => {
    const files = loadPackage("C-identity-adversarial");
    const manifest = manifestOf(files);
    const entry = manifest.artifacts.find((a) => a["path"] === "02_EXCEPTIONS/isolated.csv") as Record<string, unknown>;
    entry["rowCount"] = 4;
    writeManifest(files, manifest);
    assert.deepEqual(refusal(files), ["ARTIFACT_ROWS_MISMATCH"]);
  });

  it("a file the manifest does not name is refused, and so is a name without its file", () => {
    const extra = loadPackage("D-salesforce");
    extra.set("01_IMPORT/salesforce/Extra.csv", new TextEncoder().encode("Name\nx\n"));
    assert.deepEqual(refusal(extra), ["ARTIFACT_UNDECLARED"]);
    const missing = loadPackage("D-salesforce");
    missing.delete("02_EXCEPTIONS/leftovers.csv");
    assert.ok(refusal(missing).includes("ARTIFACT_MISSING"));
  });

  for (const unsafe of ["01_IMPORT/../manifest.csv", "/01_IMPORT/x.csv", "01_IMPORT\\x.csv", "01_IMPORT//x.csv", "01_IMPORT/x\u202e.csv", "C:/x.csv"]) {
    it(`an unsafe artifact path is refused: ${JSON.stringify(unsafe)}`, () => {
      const files = loadPackage("B-dirty-multinational");
      const manifest = manifestOf(files);
      (manifest.artifacts[0] as Record<string, unknown>)["path"] = unsafe;
      writeManifest(files, manifest);
      assert.ok(refusal(files).includes("UNSAFE_PATH"));
    });
  }

  it("R2-069: evidence relabelled as an import file, or an import kind outside 01_IMPORT, is refused", () => {
    for (const [path, kind] of [
      ["03_TRACEABILITY/changes.csv", "MACHINE_IMPORT_CSV"],
      ["04_DOCUMENTATION/data-view/clean-only/contacts.csv", "MACHINE_IMPORT_CSV"],
      ["01_IMPORT/clean-only/contacts.csv", "HUMAN_VIEW_CSV"],
    ] as const) {
      const files = loadPackage("A-clean-multi-object");
      const manifest = manifestOf(files);
      (manifest.artifacts.find((a) => a["path"] === path) as Record<string, unknown>)["kind"] = kind;
      writeManifest(files, manifest);
      assert.deepEqual(refusal(files), ["AREA_KIND_MISMATCH"], `${path} as ${kind}`);
    }
  });

  it("another core version or package format is refused, not read as if it were 3.0.0", () => {
    for (const [key, value] of [["coreVersion", "2.0.3"], ["manifestVersion", "2.0.0"]] as const) {
      const files = loadPackage("D-hubspot");
      const manifest = manifestOf(files);
      manifest[key] = value;
      writeManifest(files, manifest);
      assert.deepEqual(refusal(files), ["UNSUPPORTED_FORMAT"]);
    }
  });

  it("a manifest with a key outside the closed format is refused", () => {
    const files = loadPackage("D-hubspot");
    const manifest = manifestOf(files);
    manifest["verified"] = true;
    writeManifest(files, manifest);
    assert.deepEqual(refusal(files), ["MANIFEST_MALFORMED"]);
  });

  it("a refusal never quotes a value from inside a file", () => {
    const files = loadPackage("D-hubspot");
    const path = "01_IMPORT/hubspot/contacts.csv";
    const content = fileText(files, path);
    forge(files, path, content.replace(/\n$/, "\n\"=HYPERLINK(\"\"http://x\"\")\",SECRET-CELL\n"));
    try {
      readMigrationPackage(files);
      assert.fail("accepted");
    } catch (error) {
      assert.ok(error instanceof ReportModelError);
      assert.ok(!error.message.includes("SECRET-CELL") && !JSON.stringify(error.problems).includes("SECRET-CELL"));
    }
  });
});

describe("CSV records", () => {
  it("a quoted field holding a line break, a comma and a quote is one record", () => {
    assert.deepEqual(parseCsv('a,b\r\n"x\r\ny, ""z""",2\n3,4'), [["a", "b"], ['x\r\ny, "z"', "2"], ["3", "4"]]);
  });
  it("an unterminated quote and a bare carriage return are refused", () => {
    assert.throws(() => parseCsv('a\n"x'), /unterminated/);
    assert.throws(() => parseCsv("a\rb"), /bare carriage return/);
  });
});
