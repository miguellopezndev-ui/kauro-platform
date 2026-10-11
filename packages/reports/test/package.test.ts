// readMigrationPackage over the real Migration Core 3.0.0 acceptance packages (EXECUTED_LOCAL: the core's own bytes, read here)
// and over forged copies of them (CMD039-OK, CMD039-DENY; design B13-report-model.md §2). Every forgery re-declares the altered
// file's length, hash and count in the manifest, so only the cross-checks against the other evidence can catch it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMigrationPackage, ReportModelError } from "../src/index.js";
import type { ProblemCode } from "../src/index.js";
import { parseCsv } from "../src/csv.js";
import { CASES, fileText, forge, loadPackage, manifestOf, ORACLE, writeManifest } from "./support/fixtures.js";

const R = "03_TRACEABILITY/reconciliation.json";
const X = "03_TRACEABILITY/import-crosswalk.csv";
const L = "03_TRACEABILITY/source-lineage.csv";

function refusal(files: Map<string, Uint8Array>): { codes: ProblemCode[]; text: string } {
  try {
    readMigrationPackage(files);
  } catch (error) {
    assert.ok(error instanceof ReportModelError, `expected ReportModelError, got ${String(error)}`);
    return { codes: error.problems.map((p) => p.code), text: `${error.message} ${JSON.stringify(error.problems)}` };
  }
  assert.fail("the package was accepted");
}
const codes = (files: Map<string, Uint8Array>): ProblemCode[] => refusal(files).codes;
const editJson = (files: Map<string, Uint8Array>, path: string, edit: (json: any) => void): void => {
  const json = JSON.parse(fileText(files, path));
  edit(json);
  forge(files, path, JSON.stringify(json));
};
const renameArtifact = (files: Map<string, Uint8Array>, from: string, to: string): void => {
  const manifest = manifestOf(files);
  (manifest.artifacts.find((a) => a["path"] === from) as Record<string, unknown>)["path"] = to;
  files.set(to, files.get(from) as Uint8Array);
  files.delete(from);
  writeManifest(files, manifest);
};

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
      assert.ok(Object.isFrozen(pkg) && Object.isFrozen(pkg.reconciliation.sourceRows.byDisposition) && Object.isFrozen(pkg.inputs[0]));
    });
  }
});

describe("CMD039-DENY: a package whose bytes, inventory or sums do not hold is refused", () => {
  it("a changed byte in an import file fails its hash", () => {
    const files = loadPackage("D-hubspot");
    const bytes = new Uint8Array(files.get("01_IMPORT/hubspot/contacts.csv") as Uint8Array);
    bytes[bytes.length - 2] = (bytes[bytes.length - 2] as number) ^ 1;
    files.set("01_IMPORT/hubspot/contacts.csv", bytes);
    assert.deepEqual(codes(files), ["ARTIFACT_BYTES_MISMATCH"]);
  });

  it("matching manifest sums with wrong data: a dropped import record, re-declared in the manifest, still fails", () => {
    const files = loadPackage("D-hubspot");
    const path = "01_IMPORT/hubspot/contacts.csv";
    const lines = fileText(files, path).split("\n");
    lines.splice(1, 1);
    forge(files, path, lines.join("\n"));
    assert.ok(codes(files).includes("RECONCILIATION_MISMATCH"));
  });

  it("a reconciliation rewritten to move a delivered row to leftover, with conserving sums, still fails", () => {
    const files = loadPackage("A-clean-multi-object");
    editJson(files, R, (r) => {
      r.sourceRows.byDisposition.OUTPUT -= 1;
      r.sourceRows.byDisposition.LEFTOVER += 1;
    });
    assert.ok(codes(files).includes("RECONCILIATION_MISMATCH"));
  });

  it("dispositions that do not sum to the total fail even though the core's own equationHolds flag says true", () => {
    const files = loadPackage("B-dirty-multinational");
    editJson(files, R, (r) => {
      assert.equal(r.sourceRows.equationHolds, true);
      r.sourceRows.total += 1;
    });
    assert.ok(codes(files).includes("RECONCILIATION_MISMATCH"));
  });

  it("an input whose declared data rows differ from the reconciled source rows fails", () => {
    const files = loadPackage("D-salesforce");
    const manifest = manifestOf(files);
    const inputs = manifest["inputs"] as { sheets: { dataRowCount: number }[] }[];
    (inputs[0]?.sheets[0] as { dataRowCount: number }).dataRowCount += 1;
    writeManifest(files, manifest);
    assert.deepEqual(codes(files), ["RECONCILIATION_MISMATCH"]);
  });

  it("a declared record count that differs from the records in the bytes fails", () => {
    const files = loadPackage("C-identity-adversarial");
    const manifest = manifestOf(files);
    (manifest.artifacts.find((a) => a["path"] === "02_EXCEPTIONS/isolated.csv") as Record<string, unknown>)["rowCount"] = 4;
    writeManifest(files, manifest);
    assert.deepEqual(codes(files), ["ARTIFACT_ROWS_MISMATCH"]);
  });

  it("a file the manifest does not name is refused, and so is a name without its file", () => {
    const extra = loadPackage("D-salesforce");
    extra.set("01_IMPORT/salesforce/Extra.csv", new TextEncoder().encode("Name\nx\n"));
    assert.deepEqual(codes(extra), ["ARTIFACT_UNDECLARED"]);
    const missing = loadPackage("D-salesforce");
    missing.delete("02_EXCEPTIONS/leftovers.csv");
    assert.ok(codes(missing).includes("ARTIFACT_MISSING"));
  });

  it("another core version or package format is refused, not read as if it were 3.0.0", () => {
    for (const [key, value] of [["coreVersion", "2.0.3"], ["manifestVersion", "2.0.0"]] as const) {
      const files = loadPackage("D-hubspot");
      const manifest = manifestOf(files);
      manifest[key] = value;
      writeManifest(files, manifest);
      assert.deepEqual(codes(files), ["UNSUPPORTED_FORMAT"]);
    }
  });

  it("a manifest with a key outside the closed format is refused", () => {
    const files = loadPackage("D-hubspot");
    const manifest = manifestOf(files);
    manifest["verified"] = true;
    writeManifest(files, manifest);
    assert.deepEqual(codes(files), ["MANIFEST_MALFORMED"]);
  });

  it("a refusal for an unreadable file never quotes a value from inside it", () => {
    const files = loadPackage("D-hubspot");
    const path = "01_IMPORT/hubspot/contacts.csv";
    forge(files, path, fileText(files, path).replace(/\n$/, '\n"=HYPERLINK(""http://x"")",SECRET-CELL\n'));
    const { codes: found, text } = refusal(files);
    assert.deepEqual(found, ["ARTIFACT_UNREADABLE"]);
    assert.ok(!text.includes("SECRET-CELL") && !text.includes("HYPERLINK"));
  });
});

describe("ADV-1: every figure the model shows is bound to the evidence tables", () => {
  it("R1: relationships relabelled LEFTOVER -> DEDUPLICATED fail against associations.csv", () => {
    const files = loadPackage("D-salesforce");
    editJson(files, R, (r) => {
      r.associations.byDisposition.LEFTOVER = 0;
      r.associations.byDisposition.DEDUPLICATED = 4;
    });
    assert.deepEqual(codes(files), ["RECONCILIATION_MISMATCH", "RECONCILIATION_MISMATCH", "RECONCILIATION_MISMATCH"]);
  });

  it("R1b: relationships relabelled LEFTOVER -> without disposition fail against associations.csv", () => {
    const files = loadPackage("D-salesforce");
    editJson(files, R, (r) => {
      r.associations.byDisposition.LEFTOVER = 0;
      r.associations.withoutDisposition = 4;
      r.associations.accountedFor = 8;
    });
    assert.ok(codes(files).includes("RECONCILIATION_MISMATCH"));
  });

  it("an unresolved-associations table that drops a row fails against LEFTOVER + UNRESOLVED", () => {
    const files = loadPackage("D-salesforce");
    const path = "02_EXCEPTIONS/unresolved-associations.csv";
    const lines = fileText(files, path).split("\n");
    lines.splice(1, 1);
    forge(files, path, lines.join("\n"));
    assert.deepEqual(codes(files), ["RECONCILIATION_MISMATCH"]);
  });

  it("R3: crosswalk objects swapped COMPANY <-> CONTACT, with byObject swapped too, fail against the lineage and the migration keys", () => {
    const files = loadPackage("D-salesforce");
    forge(files, X, fileText(files, X).replace(/,COMPANY,/g, ",@@,").replace(/,CONTACT,/g, ",COMPANY,").replace(/,@@,/g, ",CONTACT,"));
    editJson(files, R, (r) => {
      [r.records.byObject.COMPANY, r.records.byObject.CONTACT] = [r.records.byObject.CONTACT, r.records.byObject.COMPANY];
    });
    assert.ok(codes(files).includes("RECONCILIATION_MISMATCH"));
  });

  it("crosswalk and lineage objects swapped together still fail against the migration keys", () => {
    const files = loadPackage("D-hubspot");
    const swap = (text: string): string => text.replace(/,COMPANY,/g, ",@@,").replace(/,CONTACT,/g, ",COMPANY,").replace(/,@@,/g, ",CONTACT,");
    forge(files, X, swap(fileText(files, X)));
    forge(files, L, swap(fileText(files, L)));
    editJson(files, R, (r) => {
      [r.records.byObject.COMPANY, r.records.byObject.CONTACT] = [r.records.byObject.CONTACT, r.records.byObject.COMPANY];
    });
    const found = refusal(files);
    assert.ok(found.codes.includes("RECONCILIATION_MISMATCH"));
    assert.match(found.text, /disagrees with its migration key/);
  });

  it("a crosswalk association key that differs from the import file's own row fails", () => {
    const files = loadPackage("D-hubspot");
    const text = fileText(files, X);
    const first = text.split("\n")[1] as string;
    const key = first.split(",")[2] as string;
    forge(files, X, text.replace(`,${key},`, `,${"0".repeat(key.length)},`));
    const found = refusal(files);
    assert.deepEqual(found.codes, ["RECONCILIATION_MISMATCH"]);
    assert.match(found.text, /association key differs from the import file/);
  });

  it("lineage rows without a disposition must match sourceRows.withoutDisposition", () => {
    const files = loadPackage("A-clean-multi-object");
    forge(files, L, fileText(files, L).replace(/,ASSOCIATION,OUTPUT,/, ",ASSOCIATION,,"));
    assert.match(refusal(files).text, /lineage rows without a disposition differ from sourceRows.withoutDisposition/);
  });
});

describe("ADV-2, ADV-6: strings from the package are from the core's closed vocabularies; paths are portable", () => {
  it("R4: markup in runId or target.mode is refused", () => {
    for (const edit of [(m: Record<string, any>) => (m["runId"] = "<script>x</script>"), (m: Record<string, any>) => (m["target"].mode = "<b>SF</b>"), (m: Record<string, any>) => (m["target"].importMode = "MERGE"), (m: Record<string, any>) => (m["bundleId"] = 'B"x')]) {
      const files = loadPackage("D-salesforce");
      const manifest = manifestOf(files);
      edit(manifest);
      writeManifest(files, manifest);
      assert.ok(codes(files).includes("MANIFEST_MALFORMED"));
    }
  });

  it("ADV-8: an adapterVersion, targetContractHash or input fileId outside the core's vocabulary is refused, each on its own", () => {
    const edits: [string, (m: Record<string, any>) => void][] = [
      ["adapterVersion", (m) => (m["target"].adapterVersion = "<b>1.0.0</b>")],
      ["targetContractHash", (m) => (m["target"].targetContractHash = "tc_<svg onload=x>")],
      ["fileId", (m) => (m["inputs"][0].fileId = 'F-"><img src=x>')],
      ["inputs sha256 (ADV-10)", (m) => (m["inputs"][0].sha256 = "<svg onload=alert(1)>")],
    ];
    for (const [field, edit] of edits) {
      const files = loadPackage("D-salesforce");
      const manifest = manifestOf(files);
      edit(manifest);
      writeManifest(files, manifest);
      assert.deepEqual(codes(files), ["MANIFEST_MALFORMED"], field);
    }
  });

  it("ADV-10: a configHash outside the core's vocabulary is refused, forged in both the manifest and the reconciliation", () => {
    const files = loadPackage("D-salesforce");
    const forgedHash = "<b>" + "a".repeat(61);
    const manifest = manifestOf(files);
    manifest["configHash"] = forgedHash;
    writeManifest(files, manifest);
    editJson(files, R, (r) => {
      r.configHash = forgedHash;
    });
    assert.deepEqual(codes(files), ["MANIFEST_MALFORMED"]);
  });

  it("B13 ADV-10: an input sha256 that is not 64 lowercase hex digits is refused (each wrong shape on its own); the intact one is accepted", () => {
    const wrong = ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", " " + "a".repeat(63)];
    for (const hash of wrong) {
      const files = loadPackage("D-salesforce");
      const manifest = manifestOf(files);
      (manifest["inputs"] as Record<string, unknown>[])[0]!["sha256"] = hash;
      writeManifest(files, manifest);
      assert.deepEqual(codes(files), ["MANIFEST_MALFORMED"], JSON.stringify(hash));
    }
    assert.doesNotThrow(() => readMigrationPackage(loadPackage("D-salesforce")));
  });

  it("B13 ADV-10: a well-formed configHash that differs between the manifest and the reconciliation is refused RECONCILIATION_MISMATCH, whichever side is forged; a malformed one is MANIFEST_MALFORMED", () => {
    const other = "b".repeat(64);
    const inManifest = loadPackage("D-salesforce");
    const m = manifestOf(inManifest);
    assert.notEqual(m["configHash"], other);
    m["configHash"] = other;
    writeManifest(inManifest, m);
    assert.deepEqual(codes(inManifest), ["RECONCILIATION_MISMATCH"], "forged in the manifest only");
    const inReconciliation = loadPackage("D-salesforce");
    editJson(inReconciliation, R, (r) => {
      assert.notEqual(r.configHash, other);
      r.configHash = other;
    });
    assert.deepEqual(codes(inReconciliation), ["RECONCILIATION_MISMATCH"], "forged in the reconciliation only");
    for (const bad of ["a".repeat(63), "A".repeat(64), 7]) {
      const files = loadPackage("D-salesforce");
      const manifest = manifestOf(files);
      manifest["configHash"] = bad;
      writeManifest(files, manifest);
      assert.ok(codes(files).includes("MANIFEST_MALFORMED"), JSON.stringify(bad));
    }
  });

  it("R5: an artifact path with markup is refused, and the refusal does not quote it", () => {
    const files = loadPackage("D-salesforce");
    renameArtifact(files, "02_EXCEPTIONS/formula-risk.csv", "02_EXCEPTIONS/<svg onload=alert(1)>.csv");
    const found = refusal(files);
    assert.ok(found.codes.includes("UNSAFE_PATH"));
    assert.ok(!found.text.includes("<svg"));
  });

  for (const unsafe of ["01_IMPORT/../manifest.csv", "/01_IMPORT/x.csv", "01_IMPORT\\x.csv", "01_IMPORT//x.csv", "01_IMPORT/x\u202e.csv", "C:/x.csv", "01_IMPORT/x y.csv", "01_IMPORT/a&b.csv", "01_IMPORT/x/CON.csv", "01_IMPORT/x/nul", "01_IMPORT/x./a.csv", "01_IMPORT/caf\u00e9.csv"]) {
    it(`an unsafe artifact path is refused: ${JSON.stringify(unsafe)}`, () => {
      const files = loadPackage("B-dirty-multinational");
      const manifest = manifestOf(files);
      (manifest.artifacts[0] as Record<string, unknown>)["path"] = unsafe;
      writeManifest(files, manifest);
      assert.ok(codes(files).includes("UNSAFE_PATH"));
    });
  }

  it("R6: two paths that differ only in case are refused", () => {
    const files = loadPackage("D-salesforce");
    const manifest = manifestOf(files);
    const entry = manifest.artifacts.find((a) => a["path"] === "02_EXCEPTIONS/formula-risk.csv") as Record<string, unknown>;
    manifest.artifacts.push({ ...entry, path: "02_EXCEPTIONS/Formula-Risk.csv" });
    files.set("02_EXCEPTIONS/Formula-Risk.csv", files.get("02_EXCEPTIONS/formula-risk.csv") as Uint8Array);
    writeManifest(files, manifest);
    assert.ok(codes(files).includes("DUPLICATE_PATH"));
  });

  it("an association file over an object the core does not have is refused", () => {
    const files = loadPackage("D-salesforce");
    renameArtifact(files, "01_IMPORT/salesforce/associations/contact_to_deal.csv", "01_IMPORT/salesforce/associations/contact_to_widget.csv");
    assert.deepEqual(codes(files), ["IMPORT_OBJECT_UNKNOWN"]);
  });
});

describe("R2-069: the kind of every artifact is derived from its path, as the core's verifier does", () => {
  for (const [path, kind] of [
    ["03_TRACEABILITY/changes.csv", "MACHINE_IMPORT_CSV"],
    ["04_DOCUMENTATION/data-view/clean-only/contacts.csv", "MACHINE_IMPORT_CSV"],
    ["01_IMPORT/clean-only/contacts.csv", "HUMAN_VIEW_CSV"],
    ["02_EXCEPTIONS/leftovers.csv", "HUMAN_VIEW_CSV"],
    ["02_EXCEPTIONS/formula-risk.csv", "MACHINE_EXCEPTION_CSV"],
  ] as const) {
    it(`${path} declared ${kind} is refused`, () => {
      const files = loadPackage("A-clean-multi-object");
      const manifest = manifestOf(files);
      (manifest.artifacts.find((a) => a["path"] === path) as Record<string, unknown>)["kind"] = kind;
      writeManifest(files, manifest);
      assert.deepEqual(codes(files), ["AREA_KIND_MISMATCH"]);
    });
  }
  it("a file at a path the format does not place, and a data view of no import file, are refused", () => {
    const unknown = loadPackage("A-clean-multi-object");
    renameArtifact(unknown, "02_EXCEPTIONS/leftovers.csv", "02_EXCEPTIONS/notes.csv");
    assert.ok(codes(unknown).includes("AREA_KIND_MISMATCH"));
    const orphan = loadPackage("A-clean-multi-object");
    renameArtifact(orphan, "04_DOCUMENTATION/data-view/clean-only/contacts.csv", "04_DOCUMENTATION/data-view/clean-only/people.csv");
    assert.deepEqual(codes(orphan), ["AREA_KIND_MISMATCH"]);
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
