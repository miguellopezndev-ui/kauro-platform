// renderReportHtml over the verified model (design B13-report-html.md; S069, S070, R2-065, R2-069, R2-070, R2-071, R-E3).
// The renderer is pure: it returns the HTML document and its SHA-256; the worker prints it to PDF.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buildReportModel, copyText, readMigrationPackage, renderReportHtml, REPORT_COPY, ReportModelError } from "../src/index.js";
import type { ProblemCode, VerifiedReport } from "../src/index.js";
import { facts, fileText, forge, loadPackage, manifestOf, writeManifest } from "./support/fixtures.js";
import type { CaseName } from "./support/fixtures.js";

function report(name: CaseName, overrides: Record<string, unknown> = {}): VerifiedReport {
  return buildReportModel(readMigrationPackage(loadPackage(name)), facts(name, overrides));
}

function refusal(run: () => unknown): ProblemCode[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ReportModelError, String(error));
    return error.problems.map((p) => p.code);
  }
  assert.fail("accepted");
}

/** The text of every element carrying data-figure="<name>", in document order. */
function figures(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`data-figure="${name}"[^>]*>([^<]*)<`, "g"))].map((m) => m[1] as string);
}

// A tiny valid PNG (1x1) and its hash; a PNG header claiming 100000x100000 (an image bomb).
const PNG_1x1 = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
const pngWithSize = (w: number, h: number): Buffer => {
  const b = Buffer.from(PNG_1x1);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("the document is self-contained and inert (S069)", () => {
  it("no script, no event handler, no inline style attribute, no remote URL, a restrictive CSP", () => {
    for (const pageSize of ["LETTER", "A4"] as const) {
      const { html } = renderReportHtml(report("D-salesforce"), { pageSize, locale: "en-US", logo: null });
      assert.ok(!/<script/i.test(html));
      assert.ok(!/\son[a-z]+\s*=/i.test(html));
      assert.ok(!/\sstyle\s*=/i.test(html));
      assert.ok(!/(https?:)?\/\/[a-z0-9]/i.test(html.replace(/<!DOCTYPE html>/, "")));
      assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
      assert.match(html, /<html lang="en-US">/);
    }
  });

  it("a hostile source file name is escaped, isolated in <bdi>, and never markup", () => {
    const files = loadPackage("D-hubspot");
    const manifest = manifestOf(files) as unknown as { inputs: { path: string }[] };
    manifest.inputs[0]!.path = `<img src=x onerror=alert(1)>"'&‮gnp.csv`;
    writeManifest(files, manifest);
    const pkg = readMigrationPackage(files);
    const r = buildReportModel(pkg, facts("D-hubspot", { expectedManifestSha256: pkg.manifestSha256 }));
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("<bdi>&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;‮gnp.csv</bdi>"));
  });

  it("an AGENCY_SUMMARY report prints no source file name", () => {
    const r = report("D-hubspot", { privacyClass: "AGENCY_SUMMARY" });
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.ok(!html.includes("contacts.csv</bdi>") && !html.includes("companies.csv</bdi>"));
  });
});

describe("every figure is printed from the model, never recounted (R2-065, R2-071)", () => {
  it("the three denominators are separate, each with its definition", () => {
    const r = report("D-salesforce", { billableSourceUnits: 17 });
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.deepEqual(figures(html, "physicalSourceRows"), ["19"]);
    assert.deepEqual(figures(html, "billableSourceUnits"), ["17"]);
    assert.deepEqual(figures(html, "emittedArtifactRows"), ["23"]);
    for (const key of ["counts.physicalSourceRows.definition", "counts.billableSourceUnits.definition", "counts.emittedArtifactRows.definition"] as const) assert.ok(html.includes(REPORT_COPY["en-US"][key]));
  });
  it("PR21-5: every RowCounts figure, exception total and import step prints a fixed expected value (the core's manifest, not the model)", () => {
    // Expected values from the core's own manifest.json and acceptance README (oracle independent of the model); 17 is the quote.
    const expected = {
      "D-salesforce": {
        counts: { physicalSourceRows: 19, logicalSourceRecords: 15, billableSourceUnits: 17, associationEdges: 12, emittedRepresentatives: 15, mergedNonSurvivors: 0, rejected: 0, withheld: 4, unresolved: 0, emittedArtifactRows: 23 },
        exceptions: { "destination-conflicts.csv": 0, "duplicate-candidates.csv": 0, "formula-risk.csv": 8, "isolated.csv": 0, "leftovers.csv": 4, "rejected-input.csv": 0, "unmapped-fields.csv": 7, "unresolved-associations.csv": 4 },
        steps: [["Account.csv", 4], ["Contact.csv", 5], ["Opportunity.csv", 3], ["Lead.csv", 3], ["associations/company_to_deal.csv", 3], ["associations/contact_to_company.csv", 5], ["associations/contact_to_deal.csv", 0]],
        dir: "01_IMPORT/salesforce/",
      },
      "C-identity-adversarial": {
        counts: { physicalSourceRows: 10, logicalSourceRecords: 10, billableSourceUnits: 17, associationEdges: 0, emittedRepresentatives: 3, mergedNonSurvivors: 2, rejected: 0, withheld: 5, unresolved: 0, emittedArtifactRows: 3 },
        exceptions: { "destination-conflicts.csv": 2, "duplicate-candidates.csv": 8, "formula-risk.csv": 0, "isolated.csv": 5, "leftovers.csv": 0, "rejected-input.csv": 0, "unmapped-fields.csv": 0, "unresolved-associations.csv": 0 },
        steps: [["contacts.csv", 3]],
        dir: "01_IMPORT/hubspot/",
      },
    } as const;
    for (const [name, want] of Object.entries(expected) as [CaseName, (typeof expected)[keyof typeof expected]][]) {
      const { html } = renderReportHtml(report(name), { pageSize: "A4", locale: "en-US", logo: null });
      for (const [key, value] of Object.entries(want.counts)) assert.deepEqual(figures(html, key), [String(value)], `${name} ${key}`);
      for (const [file, value] of Object.entries(want.exceptions)) assert.ok(html.includes(`data-records="02_EXCEPTIONS/${file}">${value}<`), `${name} ${file}`);
      const steps = [...html.matchAll(/<li data-step="(\d+)" data-path="([^"]+)"/g)].map((m) => m[2]);
      assert.deepEqual(steps, want.steps.map(([f]) => `${want.dir}${f}`), name);
      for (const [f, value] of want.steps) assert.ok(html.includes(`<span data-records="${want.dir}${f}">${value}<`), `${name} ${f}`);
    }
  });
  it("UNBOUND counts are disclosed on the first page; BOUND counts are not flagged", () => {
    const unbound = report("D-hubspot");
    assert.ok(renderReportHtml(unbound, { pageSize: "LETTER", locale: "en-US", logo: null }).html.includes(REPORT_COPY["en-US"]["counts.unbound"]));
    const bound = report("D-hubspot", { declaredCounts: unbound.snapshot.counts });
    assert.ok(!renderReportHtml(bound, { pageSize: "LETTER", locale: "en-US", logo: null }).html.includes(REPORT_COPY["en-US"]["counts.unbound"]));
  });
});

/** B-dirty-multinational with its one contacts import file cut into two files with the given names (4 records each), the
 * manifest and crosswalk re-pointed the way the core writes a cut table (its data view dropped, being a copy of the whole). */
function cutContacts(names: readonly [string, string] | string[]): Map<string, Uint8Array> {
  const files = loadPackage("B-dirty-multinational");
  const dir = "01_IMPORT/clean-only/";
  const path = `${dir}contacts.csv`;
  const lines = fileText(files, path).split("\n").filter((l) => l.length > 0);
  const header = lines[0] as string;
  const parts = [`${header}\n${lines.slice(1, 5).join("\n")}\n`, `${header}\n${lines.slice(5).join("\n")}\n`];
  const manifest = manifestOf(files);
  const entry = manifest.artifacts.find((a) => a["path"] === path) as Record<string, unknown>;
  manifest.artifacts = manifest.artifacts.filter((a) => a["path"] !== path && a["path"] !== "04_DOCUMENTATION/data-view/clean-only/contacts.csv");
  files.delete("04_DOCUMENTATION/data-view/clean-only/contacts.csv");
  files.delete(path);
  names.forEach((name) => {
    manifest.artifacts.push({ ...entry, path: `${dir}${name}` });
    files.set(`${dir}${name}`, new Uint8Array());
  });
  writeManifest(files, manifest);
  names.forEach((name, i) => forge(files, `${dir}${name}`, parts[i] as string));
  const X = "03_TRACEABILITY/import-crosswalk.csv";
  const xw = fileText(files, X).split("\n");
  forge(files, X, xw.map((l, i) => (i === 0 || l === "" ? l : l.replace(`${path},${i},`, i <= 4 ? `${dir}${names[0]},${i},` : `${dir}${names[1]},${i - 4},`))).join("\n"));
  return files;
}

describe("the import guide names only the files to import, in order, by part (R2-069)", () => {
  it("D-salesforce: seven steps in the model's order, the instruction to import 01_IMPORT only, every evidence file marked not for import", () => {
    const r = report("D-salesforce");
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    const steps = [...html.matchAll(/<li data-step="(\d+)" data-path="([^"]+)"/g)].map((m) => [Number(m[1]), m[2]]);
    assert.deepEqual(steps, r.model.importGuide.map((s) => [s.order, s.path]));
    assert.ok(html.includes(REPORT_COPY["en-US"]["guide.onlyImport"]));
    for (const a of r.model.artifacts.filter((x) => x.use !== "IMPORT")) assert.ok(html.includes(`data-artifact="${a.path}" data-use="${a.use}"`), a.path);
  });
  it("a cut table is listed part by part", () => {
    const files = cutContacts(["contacts-001.csv", "contacts-002.csv"]);
    const pkg = readMigrationPackage(files);
    const r = buildReportModel(pkg, facts("B-dirty-multinational", { expectedManifestSha256: pkg.manifestSha256 }));
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.deepEqual(r.model.importGuide.map((s) => [s.part, s.parts, s.records.value]), [[1, 2, 4], [2, 2, 4]]);
    assert.ok(html.includes("Part 1 of 2") && html.includes("Part 2 of 2"));
  });
  it("PR21-4: a cut table whose parts are not exactly 1..m is refused (a gap, or an unnumbered sibling)", () => {
    for (const names of [["contacts-001.csv", "contacts-003.csv"], ["contacts.csv", "contacts-001.csv"], ["contacts-002.csv", "contacts-003.csv"]]) {
      const found = (() => {
        try {
          readMigrationPackage(cutContacts(names));
        } catch (error) {
          assert.ok(error instanceof ReportModelError, String(error));
          return error.problems.map((p) => p.code);
        }
        return [] as ProblemCode[];
      })();
      assert.deepEqual(found, ["IMPORT_PARTS_INVALID"], names.join(" + "));
    }
  });
});

describe("white label never replaces the issuer (R2-070, CMD008)", () => {
  it("the brand is shown as the preparer for the agency; the issuer's legal identity is printed on every report", () => {
    const { html } = renderReportHtml(report("D-hubspot", { branding: { version: "b-2", displayName: "Northwind Data Partners", logo: null } }), { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.ok(html.includes("Northwind Data Partners"));
    assert.ok(html.includes("Kauro Data S.A.S.") && html.includes("NIT-PENDING-OWNER"));
  });
  it("a logo is embedded only when its bytes match the branding's SHA-256 and type, within size and dimension limits", () => {
    const logo = { sha256: sha(PNG_1x1), mediaType: "image/png" };
    const r = report("D-hubspot", { branding: { version: "b-3", displayName: "N", logo } });
    const ok = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: PNG_1x1 }).html;
    assert.ok(ok.includes(`<img class="logo" alt="N" src="data:image/png;base64,${PNG_1x1.toString("base64")}">`));
    assert.deepEqual(refusal(() => renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: pngWithSize(2, 1) })), ["BRANDING_UNSAFE"]);
    const bomb = pngWithSize(100000, 100000);
    const rb = report("D-hubspot", { branding: { version: "b-4", displayName: "N", logo: { sha256: sha(bomb), mediaType: "image/png" } } });
    assert.deepEqual(refusal(() => renderReportHtml(rb, { pageSize: "LETTER", locale: "en-US", logo: bomb })), ["BRANDING_UNSAFE"]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    const rs = report("D-hubspot", { branding: { version: "b-5", displayName: "N", logo: { sha256: sha(svg), mediaType: "image/png" } } });
    assert.deepEqual(refusal(() => renderReportHtml(rs, { pageSize: "LETTER", locale: "en-US", logo: svg })), ["BRANDING_UNSAFE"]);
    assert.deepEqual(refusal(() => renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null })), ["BRANDING_UNSAFE"]);
  });
});

describe("print layout and identity (S070)", () => {
  it("Letter and A4 differ only in the page rule; table headers repeat; rows do not split; hashes wrap", () => {
    const r = report("D-salesforce");
    const letter = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    const a4 = renderReportHtml(r, { pageSize: "A4", locale: "en-US", logo: null });
    assert.match(letter.html, /@page \{ size: letter;/);
    assert.match(a4.html, /@page \{ size: A4;/);
    assert.equal(letter.html.replace("size: letter;", "size: A4;"), a4.html);
    for (const rule of ["thead { display: table-header-group; }", "tr { break-inside: avoid; }", "overflow-wrap: anywhere;"]) assert.ok(letter.html.includes(rule), rule);
  });
  it("the same model renders the same bytes; the hash is the document's SHA-256 and names the model hash", () => {
    const r = report("C-identity-adversarial");
    const one = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    const two = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    assert.equal(one.html, two.html);
    assert.equal(one.sha256, sha(new TextEncoder().encode(one.html)));
    assert.ok(one.html.includes(r.modelHash));
  });
});

describe("R-E3: English by default from a catalog keyed by locale", () => {
  it("an unknown locale falls back to English, key by key", () => {
    const r = report("B-dirty-multinational");
    assert.equal(renderReportHtml(r, { pageSize: "LETTER", locale: "es-CO", logo: null }).html, renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null }).html);
  });
  it("the English catalog holds no non-English text and none of A3's forbidden claims", () => {
    const forbidden = [/\bAI\b/, /\bimported\b/i, /compatible with/i, /works with any CRM/i, /delete duplicates/i, /eliminate records/i, /pays for itself/i, /without losing money/i, /\bsav(e|ings)\b/i, /\baudit\b/i, /\bdiagnosis\b/i];
    const spanish = /[áéíóúñ¿¡]|\b(el|la|los|las|de|del|para|archivo|registros|filas|importar|cliente)\b/i;
    for (const [key, text] of Object.entries(REPORT_COPY["en-US"])) {
      assert.ok(!spanish.test(text), `${key}: ${text}`);
      assert.ok(!/[&<>"']/.test(text), `${key} holds a character HTML would escape: ${text}`);
      for (const f of forbidden) assert.ok(!f.test(text), `${key} matches ${f}: ${text}`);
    }
  });
  it("every visible text node of the document comes from the catalog or from the model", () => {
    const r = report("D-salesforce");
    const { html } = renderReportHtml(r, { pageSize: "LETTER", locale: "en-US", logo: null });
    const body = html.slice(html.indexOf("<body>"));
    const texts = [...body.matchAll(/>([^<]+)</g)].map((m) => (m[1] as string).trim()).filter((t) => t.length > 0);
    const catalog = Object.values(REPORT_COPY["en-US"]);
    const modelText = JSON.stringify(r.model);
    for (const t of texts) {
      const fromCatalog = catalog.some((c) => c === t || c.includes("{") && new RegExp(`^${c.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[a-zA-Z]+\}/g, ".+")}$`).test(t));
      const fromModel = modelText.includes(t.replace(/,/g, "")) || /^[0-9,]+$/.test(t);
      assert.ok(fromCatalog || fromModel, `hard-coded text: ${t}`);
    }
  });
});

describe("PR21-1: every logo rule has its own test (S069)", () => {
  const withLogo = (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg"): VerifiedReport => report("D-hubspot", { branding: { version: "b-9", displayName: "N", logo: { sha256: sha(bytes), mediaType } } });
  // A minimal baseline JPEG: SOI, one SOF0 segment naming the dimensions, EOI.
  const jpeg = (width: number, height: number): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  it("a PNG over 512 KiB is refused although its hash matches", () => {
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(512 * 1024)]);
    assert.deepEqual(refusal(() => renderReportHtml(withLogo(big, "image/png"), { pageSize: "LETTER", locale: "en-US", logo: big })), ["BRANDING_UNSAFE"]);
  });
  it("a valid JPEG renders as its exact data: image", () => {
    const small = jpeg(120, 40);
    const { html } = renderReportHtml(withLogo(small, "image/jpeg"), { pageSize: "LETTER", locale: "en-US", logo: small });
    assert.ok(html.includes(`<img class="logo" alt="N" src="data:image/jpeg;base64,${small.toString("base64")}">`));
  });
  it("a JPEG that claims 60000x60000 pixels is refused", () => {
    const bomb = jpeg(60000, 60000);
    assert.deepEqual(refusal(() => renderReportHtml(withLogo(bomb, "image/jpeg"), { pageSize: "LETTER", locale: "en-US", logo: bomb })), ["BRANDING_UNSAFE"]);
  });
  it("a JPEG with no start-of-frame marker is refused", () => {
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    assert.deepEqual(refusal(() => renderReportHtml(withLogo(noFrame, "image/jpeg"), { pageSize: "LETTER", locale: "en-US", logo: noFrame })), ["BRANDING_UNSAFE"]);
  });
  it("logo bytes are refused when the branding names no logo", () => {
    assert.deepEqual(refusal(() => renderReportHtml(report("D-hubspot"), { pageSize: "LETTER", locale: "en-US", logo: PNG_1x1 })), ["BRANDING_UNSAFE"]);
  });
});

describe("PR21-2: the renderer prints only a report buildReportModel produced, and escapes every value", () => {
  it("a report object that buildReportModel did not produce is refused", () => {
    const real = report("D-hubspot");
    assert.deepEqual(refusal(() => renderReportHtml({ ...real } as VerifiedReport, { pageSize: "LETTER", locale: "en-US", logo: null })), ["REPORT_UNVERIFIED"]);
  });
  it("a hand-made report with markup in every raw field renders none of it", () => {
    const real = report("D-salesforce");
    const evil = "<img src=x onerror=alert(1)>";
    const m = real.model;
    const forged = {
      ...real,
      modelHash: evil,
      model: {
        ...m,
        lineage: { ...m.lineage, inputs: m.lineage.inputs.map((i) => ({ ...i, fileId: evil, sha256: evil })) },
        importGuide: m.importGuide.map((s) => ({ ...s, order: evil, object: evil, sha256: evil })),
        exceptions: m.exceptions.map((a) => ({ ...a, sha256: evil })),
        artifacts: m.artifacts.map((a) => ({ ...a, sha256: evil })),
      },
    } as unknown as VerifiedReport;
    let html = "";
    try {
      html = renderReportHtml(forged, { pageSize: "LETTER", locale: "en-US", logo: null }).html;
    } catch (error) {
      assert.ok(error instanceof ReportModelError);
      assert.deepEqual(error.problems.map((p) => p.code), ["REPORT_UNVERIFIED"]);
      return;
    }
    assert.ok(!html.includes("<img src=x"), "markup from a hand-made report reached the document");
  });
});

describe("PR21-3: a copy text never renders with a missing value", () => {
  it("a template whose placeholder has no value throws instead of printing an empty string", () => {
    assert.throws(() => copyText("en-US", "doc.preparedFor", {}), /no value for \{brand\}/);
    assert.equal(copyText("en-US", "doc.preparedFor", { brand: "N" }), "Prepared by N");
  });
});
