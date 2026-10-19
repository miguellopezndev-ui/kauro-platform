// The report PDF (B13; design docs/design/B13-report-pdf.md): real Chromium prints the real report HTML; the bytes are read back
// with pdf.js. Needs a Chromium-family browser (KAURO_PDF_BROWSER, or Chrome/Edge/Chromium at the usual path); without one the
// engine tests are reported as skipped, with the reason, and the port tests (fake engines) still run. CI sets
// KAURO_REQUIRE_PDF_ENGINE=1: there a missing browser is a FAILURE (never a skip), and the evidence of the run (browser version,
// sandbox state, page sizes, hashes) is written under KAURO_PDF_EVIDENCE_DIR.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { copyText, generateReportPdf, renderReportHtml, ReportModelError, ReportPdfError } from "@kauro/reports";
import type { CopyKey, PdfEngine, VerifiedReport } from "@kauro/reports";
import { ChromiumPdfEngine, findChromiumExecutable } from "../src/index.js";
import { reportOf } from "./support/report-fixtures.js";
import { readPdf, squash } from "./support/pdf-reader.js";

const browser = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const required = process.env["KAURO_REQUIRE_PDF_ENGINE"] === "1";
// when CI requires the engine, nothing is skipped: the suite runs and the first test below fails if there is no browser
const needsBrowser = browser === null && !required ? "no Chromium-family browser found (set KAURO_PDF_BROWSER)" : false;
const evidenceDir = process.env["KAURO_PDF_EVIDENCE_DIR"] ?? null;
const evidence = (name: string, value: unknown): void => {
  if (evidenceDir === null) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}
`);
};
const engine = (): ChromiumPdfEngine => new ChromiumPdfEngine({ executablePath: browser as string }, "chromium/test");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const PAGE_POINTS = { LETTER: [612, 792], A4: [595.28, 841.89] } as const;
const LETTER = { pageSize: "LETTER" as const, locale: "en-US", logo: null };

describe("report PDF — real engine", { skip: needsBrowser }, () => {
  it("has a Chromium to run on, and the browser really sandboxes its processes", async () => {
    assert.ok(browser !== null, "KAURO_REQUIRE_PDF_ENGINE=1 but no Chromium-family browser was found (set KAURO_PDF_BROWSER)");
    const probe = await ChromiumPdfEngine.probe(browser);
    evidence("browser.json", { executable: browser, ...probe, uid: process.platform === "win32" ? null : process.getuid?.() });
    assert.match(probe.version, /^chromium\/\d+\.\d+\.\d+\.\d+$/);
    if (process.platform !== "linux") return; // the process-level sandbox facts below are read from /proc
    assert.notEqual(process.getuid?.(), 0, "the browser must not run as root");
    assert.equal(probe.sandboxDisabledFlag, false, "no process of the browser carries a flag that disables a sandbox layer");
    // Chrome's zygote-forked children (renderers, the GPU and utility processes) rewrite their command line, so they cannot be told apart by
    // `--type`; what the kernel reports for them is what matters: under the sandbox they run with seccomp-bpf (Seccomp: 2) and no_new_privs.
    // The browser process and the zygotes that fork them are the brokers and stay at Seccomp: 0.
    const sandboxed = (probe.processes ?? []).filter((p) => p.seccomp === 2 && p.noNewPrivs === 1);
    assert.ok(sandboxed.length >= 1, `children of the browser run under seccomp-bpf with no_new_privs (${JSON.stringify(probe.processes)})`);
    assert.ok(sandboxed.every((p) => p.ppid !== 1), "the sandboxed processes are descendants of the browser");
  });

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
      if (evidenceDir !== null) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, `report-${pageSize}.pdf`), pdf.bytes);
      }
      evidence(`report-${pageSize}.json`, { pageSize, pdfSha256: pdf.identity.pdfSha256, byteLength: pdf.identity.byteLength, engineId: pdf.identity.engineId, pages: read.pages.map((p) => ({ width: p.width, height: p.height })), expectedPoints: [w, h] });
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

  // template 2 embeds its faces and keeps its text extractable: every text of the HTML document is in the PDF's text (whitespace ignored, and
  // case, because column heads are set in capitals), and the PDF carries the pinned faces rather than whatever the host has installed
  for (const name of ["D-salesforce", "A-clean-multi-object"] as const) {
    it(`${name}: every text of the document survives into the PDF, in the embedded Inter and JetBrains Mono`, async () => {
      const report = reportOf(name);
      const { html } = renderReportHtml(report, LETTER);
      const pdf = await generateReportPdf(report, LETTER, engine());
      if (evidenceDir !== null) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, `report-${name}-LETTER.pdf`), pdf.bytes);
      }
      const read = await readPdf(pdf.bytes);
      const flat = squash(read.pages.map((p) => p.text).join(" ")).toLowerCase();
      const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      const texts = [...html.slice(html.indexOf("<body>")).matchAll(/>([^<]+)</g)].map((m) => unescape(m[1] as string).trim()).filter((t) => t.length > 0);
      assert.ok(texts.length > 100);
      const lost = texts.filter((t) => !flat.includes(squash(t).toLowerCase()));
      assert.deepEqual(lost, [], "text of the document missing from the PDF's extracted text");
      assert.ok(read.pages.some((p) => p.text.includes(`Page 1 of ${read.pages.length}`)), "the running footer numbers the pages");
      // every figure reads in the PDF as a word beside its label (a short number like "4" is found inside any hash, so a search of the
      // flattened text would not notice a figure missing from the text layer)
      const words = ` ${read.pages.map((p) => p.text).join(" ").replace(/\s+/g, " ")} `;
      const said = (label: string, value: number): boolean => words.includes(` ${label} ${value.toLocaleString("en-US")} `);
      for (const [key, figure] of Object.entries(report.model.counts)) assert.ok(said(copyText("en-US", `counts.${key}` as CopyKey), figure.value), `figure ${key}=${figure.value} missing from the PDF's text`);
      for (const [object, figure] of Object.entries(report.model.deliveredByObject)) assert.ok(said(object, figure.value), `records of ${object} missing from the PDF's text`);
      for (const key of ["delivered", "leftover", "unresolved", "deduplicated"] as const) assert.ok(said(copyText("en-US", `relationships.${key}`), report.model.relationships[key].value), `relationships ${key} missing from the PDF's text`);
      // labels set in capitals with tracking still read as words
      for (const label of [copyText("en-US", "doc.stamp"), copyText("en-US", "glance.heading"), copyText("en-US", "table.measure")]) assert.ok(words.toLowerCase().includes(` ${label.toLowerCase()} `), `label "${label}" does not read as words`);
      const raw = Buffer.from(pdf.bytes).toString("latin1");
      const faces = [...raw.matchAll(/\/FontName\s*\/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map((m) => m[1] as string);
      assert.ok(faces.some((f) => f.startsWith("Inter")), `no embedded Inter face: ${faces.join(", ")}`);
      assert.ok(faces.some((f) => f.startsWith("JetBrainsMono")), `no embedded JetBrains Mono face: ${faces.join(", ")}`);
      assert.ok(faces.every((f) => f.startsWith("Inter") || f.startsWith("JetBrainsMono")), `a face other than the pinned ones: ${faces.join(", ")}`);
    });
  }

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
