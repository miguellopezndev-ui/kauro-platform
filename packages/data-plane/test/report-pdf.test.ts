// The report PDF (B13; design docs/design/B13-report-pdf.md): real Chromium prints the real report HTML; the bytes are read back
// with pdf.js. Needs a Chromium-family browser (KAURO_PDF_BROWSER, or Chrome/Edge/Chromium at the usual path); without one the
// engine tests are reported as skipped, with the reason, and the port tests (fake engines) still run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { generateReportPdf, renderReportHtml, ReportModelError, ReportPdfError } from "@kauro/reports";
import type { PdfEngine, VerifiedReport } from "@kauro/reports";
import { ChromiumPdfEngine, findChromiumExecutable } from "../src/index.js";
import { reportOf } from "./support/report-fixtures.js";
import { readPdf, squash } from "./support/pdf-reader.js";

const browser = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const needsBrowser = browser === null ? "no Chromium-family browser found (set KAURO_PDF_BROWSER)" : false;
const engine = (): ChromiumPdfEngine => new ChromiumPdfEngine({ executablePath: browser as string }, "chromium/test");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const PAGE_POINTS = { LETTER: [612, 792], A4: [595.28, 841.89] } as const;
const LETTER = { pageSize: "LETTER" as const, locale: "en-US", logo: null };

describe("report PDF — real engine", { skip: needsBrowser }, () => {
  for (const pageSize of ["LETTER", "A4"] as const) {
    it(`prints a verified report as a ${pageSize} PDF whose text, figures and hash check out`, async () => {
      const report = reportOf("A-clean-multi-object");
      const options = { pageSize, locale: "en-US", logo: null };
      const pdf = await generateReportPdf(report, options, engine());
      assert.equal(pdf.storage, "NOT_PERSISTED");
      assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString("latin1"), "%PDF-");
      // the hash is of exactly these bytes, and the identity ties them to the model, the HTML and the package
      assert.equal(pdf.identity.pdfSha256, sha256(pdf.bytes));
      assert.equal(pdf.identity.byteLength, pdf.bytes.byteLength);
      assert.equal(pdf.identity.modelHash, report.modelHash);
      assert.equal(pdf.identity.htmlSha256, renderReportHtml(report, options).sha256);
      assert.equal(pdf.identity.packageDigest, report.model.package.packageDigest);
      assert.equal(pdf.identity.manifestSha256, report.model.package.manifestSha256);
      assert.equal(pdf.identity.reportId, "rpt-0001");
      assert.equal(pdf.identity.packageId, "pkg-0001");
      assert.equal(pdf.identity.pageSize, pageSize);

      const read = await readPdf(pdf.bytes);
      assert.ok(read.pages.length >= 1);
      const [w, h] = PAGE_POINTS[pageSize];
      for (const page of read.pages) {
        assert.ok(Math.abs(page.width - w) < 0.5 && Math.abs(page.height - h) < 0.5, `page is ${page.width}x${page.height}, expected ${w}x${h}`);
      }
      const text = read.pages.map((p) => p.text).join(" ");
      const flat = squash(text);
      for (const needle of ["Northwind Data Partners", "Kauro Data S.A.S.", "Colombia", "terms-2026-10-01"]) assert.ok(text.includes(needle), `missing ${needle}`);
      // every differentiated count the model holds is printed
      for (const [name, figure] of Object.entries(report.model.counts)) {
        assert.ok(text.includes(figure.value.toLocaleString("en-US")), `missing count ${name}=${figure.value}`);
      }
      // references that identify the exact inputs, wrapped by the page but intact
      for (const ref of [report.model.package.packageDigest, report.model.package.manifestSha256, report.modelHash]) assert.ok(flat.includes(ref), `missing reference ${ref.slice(0, 12)}`);
      // the import guide and its files
      for (const step of report.model.importGuide) assert.ok(flat.includes(squash(step.path)), `missing import file ${step.path}`);
    });
  }

  it("prints a longer report across pages, with no text lost", async () => {
    const report = reportOf("D-salesforce");
    const pdf = await generateReportPdf(report, LETTER, engine());
    const read = await readPdf(pdf.bytes);
    assert.ok(read.pages.length >= 2, `expected a multi-page report, got ${read.pages.length}`);
    const flat = squash(read.pages.map((p) => p.text).join(" "));
    for (const art of [...report.model.exceptions, ...report.model.artifacts]) assert.ok(flat.includes(squash(art.path)), `missing ${art.path}`);
  });

  it("paginates a very long table and repeats its header on each page", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => `<tr><td>row-${i}</td><td>${(i * 7919) % 10007}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:letter}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body><table><thead><tr><th>HEADERCELL</th><th>VALUE</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
    const bytes = await engine().print({ html, pageSize: "LETTER" });
    const read = await readPdf(bytes);
    assert.ok(read.pages.length >= 5, `pages: ${read.pages.length}`);
    for (const page of read.pages) assert.ok(page.text.includes("HEADERCELL"), "header missing on a page");
    const all = read.pages.map((p) => p.text).join(" ");
    assert.ok(all.includes("row-0 ") && all.includes("row-399 "));
  });

  it("does not run scripts in the document", async () => {
    const html = `<!DOCTYPE html><html><body><p>PLAIN</p><script>document.body.append("SCRIPTRAN")</script><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onerror="document.body.append('HANDLERRAN')" onload="document.body.append('HANDLERRAN')"></body></html>`;
    const read = await readPdf(await engine().print({ html, pageSize: "A4" }));
    const text = read.pages.map((p) => p.text).join(" ");
    assert.ok(text.includes("PLAIN"));
    assert.ok(!text.includes("SCRIPTRAN") && !text.includes("HANDLERRAN"));
  });

  it("makes no network request and refuses to print a document that asks for one", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end("x");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const html of [
        `<!DOCTYPE html><html><body><img src="${url}/a.png"></body></html>`,
        `<!DOCTYPE html><html><head><link rel="stylesheet" href="${url}/a.css"></head><body>x</body></html>`,
        `<!DOCTYPE html><html><body><script src="${url}/a.js"></script><iframe src="${url}/f"></iframe></body></html>`,
      ]) {
        await assert.rejects(engine().print({ html, pageSize: "LETTER" }), (e: unknown) => e instanceof ReportPdfError && e.code === "ENGINE_FAILED" && !e.message.includes("127.0.0.1"));
      }
      assert.equal(hits, 0, "the browser reached the network");
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it("fails, and returns no PDF, when the browser cannot be started", async () => {
    const missing = new ChromiumPdfEngine({ executablePath: "C:\\no\\such\\browser.exe" });
    await assert.rejects(generateReportPdf(reportOf("A-clean-multi-object"), LETTER, missing), (e: unknown) => e instanceof ReportPdfError && e.code === "ENGINE_FAILED");
  });
});

describe("report PDF — port", () => {
  const never: PdfEngine = { engineId: "never", print: async () => assert.fail("the engine must not run") };

  it("refuses a report that buildReportModel did not produce, before any engine runs", async () => {
    const real = reportOf("A-clean-multi-object");
    const forged = { ...real, model: { ...real.model, reportId: "rpt-forged" } } as VerifiedReport;
    await assert.rejects(generateReportPdf(forged, LETTER, never), (e: unknown) => e instanceof ReportModelError && e.problems.some((p) => p.code === "REPORT_UNVERIFIED"));
    await assert.rejects(generateReportPdf({} as VerifiedReport, LETTER, never), ReportModelError);
  });

  it("wraps an engine failure and never reports success", async () => {
    const boom: PdfEngine = { engineId: "boom", print: async () => Promise.reject(new Error("browser crashed")) };
    await assert.rejects(generateReportPdf(reportOf("A-clean-multi-object"), LETTER, boom), (e: unknown) => e instanceof ReportPdfError && e.code === "ENGINE_FAILED" && (e.cause as Error).message === "browser crashed");
  });

  it("refuses engine output that is not a complete PDF", async () => {
    const outputs: unknown[] = [new Uint8Array(0), new TextEncoder().encode("<html>not a pdf</html>".repeat(30)), new TextEncoder().encode(`%PDF-1.7\n${"x".repeat(400)}`), "string", null];
    for (const output of outputs) {
      const bad: PdfEngine = { engineId: "bad", print: async () => output as Uint8Array };
      await assert.rejects(generateReportPdf(reportOf("A-clean-multi-object"), LETTER, bad), (e: unknown) => e instanceof ReportPdfError && e.code === "OUTPUT_INVALID");
    }
  });
});
