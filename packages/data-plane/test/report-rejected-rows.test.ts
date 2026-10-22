// Order 14 in the worker's chain. F-31: a package Migration Core 3.0.0 verifies, holding rows it could not read and rows no mapping covers
// (contribution_kind NONE), gets its report: the vendored core is run here on the committed input and must write the committed fixture's
// bytes, and the attempt's real envelope then produces, stages and records the PDF. F-32: an authentic package the core writes at volume
// is read, modelled and rendered in a child process whose V8 heap is fixed far below the worker's (`workerHeapMegabytes`, 1024), so a
// reader that held its tables again fails here, by V8's own limit rather than a timing or a sampled measurement.
// REAL: the core, the chain, the writer, the PDF engine where a browser exists (CI sets KAURO_REQUIRE_PDF_ENGINE=1).
// CONTRACT FAKE — SIMULATED: B07's object storage and the platform's report inputs, as in report-delivery.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createFilesystemScratchStore, loadConfig, runMigration, SCRATCH_BUDGET_BYTES, verifyPackage, writeAndPromotePackage } from "@kauro/migration-core";
import type { StagedArtifact } from "@kauro/application";
import type { PdfEngine } from "@kauro/reports";
import { ChromiumPdfEngine, findChromiumExecutable, REPORT_PDF_ROLE, REPORT_RECORD_ROLE, ReportingExecutionEnvelope, type ReportRenderConfig } from "../src/index.js";
import { collect } from "./support/attempt.js";
import { freshDir, removeDir } from "./support/harness.js";
import { readPdf, squash } from "./support/pdf-reader.js";
import { loadPackage } from "./support/report-fixtures.js";
import { acceptanceCore, inputsFor, rig, scriptedEngine, sha } from "./support/report-rig.js";

const FIXTURE = fileURLToPath(new URL("../../../reports/test/fixtures/mc-3.0.0-rejected/E-rejected-rows/", import.meta.url));
const CHILD = fileURLToPath(new URL("./support/report-read-child.js", import.meta.url));
const browser = findChromiumExecutable(process.env["KAURO_PDF_BROWSER"] ?? null);
const required = process.env["KAURO_REQUIRE_PDF_ENGINE"] === "1";
/** 48 MB of old generation and 2 MB semi-spaces: 54 MB of V8 heap in all, against the worker's 1024 MB old generation. */
const HEAP = ["--max-old-space-size=48", "--max-semi-space-size=2"];
const render: ReportRenderConfig = { pageSize: "LETTER", locale: "en-US", rendererVersion: "renderer-1.0.0" };

/** Runs the vendored core on `inputRoot` with `configPath` into `out`, as its acceptance tool does, and verifies the package from disk. */
function runCore(inputRoot: string, configPath: string, out: string): { readonly passed: boolean; readonly checks: number } {
  const loaded = loadConfig(readFileSync(configPath, "utf8"), configPath);
  const work = freshDir("order14-core");
  try {
    const scratch = createFilesystemScratchStore({ root: join(work, "run"), runId: "order14", quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const result = runMigration({ inputRoot, config: loaded.config, configHash: loaded.configHash, scratch });
      writeAndPromotePackage({ result, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: out, force: true });
    } finally {
      scratch.dispose();
    }
    const verifyScratch = createFilesystemScratchStore({ root: join(work, "verify"), runId: "order14-verify", quotaBytes: SCRATCH_BUDGET_BYTES });
    try {
      const verification = verifyPackage(out, { scratch: verifyScratch });
      return { passed: verification.passed, checks: verification.checks.length };
    } finally {
      verifyScratch.dispose();
    }
  } finally {
    removeDir(work);
  }
}

const relativeFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();

describe("F-31: a verified package with rows the core could not read gets its report", () => {
  it("the vendored core writes the committed fixture's bytes from the committed input, and verifies them", () => {
    const out = freshDir("order14-fixture");
    try {
      const pkg = join(out, "package");
      const verified = runCore(join(FIXTURE, "input"), join(FIXTURE, "config.json"), pkg);
      assert.ok(verified.passed, "the core verifies its own package");
      const committed = join(FIXTURE, "package");
      assert.deepEqual(relativeFiles(pkg), relativeFiles(committed));
      for (const file of relativeFiles(committed)) assert.equal(sha(readFileSync(join(pkg, file))), sha(readFileSync(join(committed, file))), file);
    } finally {
      removeDir(out);
    }
  });

  it("the attempt's chain reads it, prints the report and stages the PDF and its record beside the package", async () => {
    assert.ok(browser !== null || !required, "KAURO_REQUIRE_PDF_ENGINE=1 but no Chromium-family browser was found (set KAURO_PDF_BROWSER)");
    const engine: PdfEngine = browser === null ? scriptedEngine() : new ChromiumPdfEngine({ executablePath: browser }, "chromium/test");
    const r = rig(1401);
    const outcome = await new ReportingExecutionEnvelope({ inner: acceptanceCore("E-rejected-rows"), storage: r.storage, inputs: inputsFor("E-rejected-rows"), engine, render, admitSimulatedInputs: true }).execute(
      r.fixture.subject,
      r.io,
    );
    assert.equal(outcome.terminalCause, "COMPLETED", JSON.stringify(outcome.refusal));
    const pdf = outcome.stagedArtifacts.filter((a) => a.role === REPORT_PDF_ROLE);
    assert.equal(pdf.length, 1);
    assert.equal(outcome.stagedArtifacts.filter((a) => a.role === REPORT_RECORD_ROLE).length, 1);
    assert.equal(outcome.stagedArtifacts.length, loadPackage("E-rejected-rows").size + 2, "the package's files and the report's two");
    if (browser === null) return;
    const staged = pdf[0] as StagedArtifact;
    const bytes = await collect(r.fake.read(r.fake.location("STAGING"), staged.objectName, staged.generation));
    const text = squash((await readPdf(bytes)).pages.map((p) => p.text).join(" "));
    // the rows not readable and the rows held back are printed with their figures, and the exception file that lists them is named
    assert.ok(text.includes("Rowsnotreadable2"), "the rows not readable are printed with their figure");
    assert.ok(text.includes("Rowsheldback2"), "the rows held back are printed with their figure");
    assert.ok(text.includes("02_EXCEPTIONS/rejected-input.csv"), "the file listing them is named");
    assert.ok(text.includes("8d58776ea802e309ccb2fe38e75a6f613a642dfb46ca6cce64e924d959ebb14c"), "the core's package digest is printed");
  });
});

// --- F-32 ----------------------------------------------------------------------------------------------------------------------------

/** A deterministic source bundle for the fixture's configuration, `scale` times the size of its first, with malformed and unmapped rows. */
function writeVolumeInput(dir: string, scale: number): { readonly rows: number; readonly rejected: number; readonly unmapped: number } {
  mkdirSync(dir, { recursive: true });
  const pad = (n: number): string => String(n % 10_000).padStart(4, "0");
  const companies = 10 * scale;
  const contacts = 100 * scale;
  const deals = 10 * scale;
  let rows = 0;
  let rejected = 0;
  const table = (name: string, header: string, count: number, row: (i: number) => string, malformedEvery: number): void => {
    const lines = [header];
    for (let i = 1; i <= count; i++) {
      const malformed = i % malformedEvery === 0;
      lines.push(malformed ? `${row(i)},unexpected` : row(i));
      rows++;
      if (malformed) rejected++;
    }
    writeFileSync(join(dir, name), `${lines.join("\n")}\n`);
  };
  table("companies.csv", "Company ID,Name,Domain,City,Country,Employees", companies, (i) => `A-${i},Company ${i},company${i}.example,City ${i % 37},Country ${i % 11},${10 + i}`, 199);
  table("contacts.csv", "Contact ID,First Name,Last Name,Email,Phone,Country,Job Title,Company ID", contacts, (i) => `C-${i},First${i},Last${i},person${i}@company${1 + (i % companies)}.example,+1 212 555 ${pad(i)},US,Title ${i % 13},A-${1 + (i % companies)}`, 997);
  table("deals.csv", "Deal ID,Deal Name,Company ID,Amount,Close Date,Stage,Pipeline", deals, (i) => `D-${i},Deal ${i},A-${1 + (i % companies)},${1000 + i}.00,2026-0${1 + (i % 9)}-15,Proposal,Sales Pipeline`, 101);
  table("contact-deals.csv", "Contact ID,Deal ID", 2 * deals, (i) => `C-${1 + ((i * 7) % contacts)},D-${1 + (i % deals)}`, 1_000_000);
  table("leads.csv", "Lead ID,First Name,Last Name,Company,Email,Phone,Country,Status", 10 * scale, (i) => `L-${i},Lead${i},Person${i},Org ${i},lead${i}@org${i}.example,+1 757 555 ${pad(i)},US,Open`, 1_000_000);
  const unmapped = scale;
  table("notes.csv", "Note ID,Text", unmapped, (i) => `N-${i},Note ${i}`, 1_000_000);
  return { rows, rejected, unmapped };
}

describe("F-32: the report chain's memory does not grow with the package's tables", () => {
  it("an authentic package of thousands of rows, with rows not readable, is read, modelled and rendered in a V8 heap of 54 MB in all", () => {
    const out = freshDir("order14-volume");
    try {
      const input = join(out, "input");
      const plan = writeVolumeInput(input, 40);
      const pkg = join(out, "package");
      assert.ok(runCore(input, join(FIXTURE, "config.json"), pkg).passed, "the core verifies its own package");
      const reconciliation = JSON.parse(readFileSync(join(pkg, "03_TRACEABILITY", "reconciliation.json"), "utf8"));
      assert.equal(reconciliation.sourceRows.total, plan.rows);
      assert.equal(reconciliation.sourceRows.byDisposition.REJECTED_INPUT, plan.rejected);
      // the whole V8 heap pinned (old generation and both semi-spaces), so the limit is the same on every runner whatever its memory
      const child = spawnSync(process.execPath, [...HEAP, CHILD, pkg], { encoding: "utf8", maxBuffer: 1 << 20 });
      assert.equal(child.status, 0, `the chain ran out of its heap or failed: ${child.stderr.slice(-1500)}`);
      const result = JSON.parse(child.stdout);
      assert.ok(result.packageBytes > 8 * 1024 * 1024, `the package is ${result.packageBytes} bytes, larger than the heap's young generation`);
      assert.ok(result.heapLimitBytes <= 54 * 1024 * 1024, `the child ran under the small heap (${result.heapLimitBytes} bytes)`);
      // nothing was dropped to fit: the counts are the core's
      assert.equal(result.counts.physicalSourceRows, plan.rows);
      assert.equal(result.counts.rejected, plan.rejected);
      assert.equal(result.counts.emittedRepresentatives, reconciliation.sourceRows.byDisposition.OUTPUT);
      assert.equal(result.counts.withheld, reconciliation.sourceRows.byDisposition.ISOLATED + reconciliation.sourceRows.byDisposition.LEFTOVER);
      assert.ok(reconciliation.sourceRows.byDisposition.LEFTOVER >= plan.unmapped);
    } finally {
      removeDir(out);
    }
  });
});
