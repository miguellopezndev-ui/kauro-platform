# B13 — Report PDF: design

Third part of B13 (after `B13-report-model.md` and `B13-report-html.md`). It turns the report HTML into real PDF bytes and ties
those bytes to the model, the HTML and the package. It stores nothing and publishes nothing.

## 1. Where it lives

| piece | package (layer) | why |
|---|---|---|
| `PdfEngine` port, `generateReportPdf`, `ReportPdf`, `ReportPdfIdentity`, `ReportPdfPublisher` (interface only), `ReportPdfError` | `@kauro/reports` (application) | renders the HTML (whose only read is the pinned faces), checks the engine's answer, hashes the bytes |
| `ChromiumPdfEngine`, `findChromiumExecutable` | `@kauro/data-plane` (adapter) | the only code that launches a browser; `playwright-core` 1.63.0 (already in the lockfile through `apps/web`) is its one new runtime dependency |

No new package, app or service. `pdfjs-dist` 5.6.205 is a devDependency of `@kauro/data-plane`, used only by tests to read PDFs back.
No browser is downloaded: the caller names the executable (Chrome, Chromium or Edge). `findChromiumExecutable(explicit)` looks at
conventional paths; deployment decides which browser is pinned (`engineId` records it beside the PDF).

## 2. Contract

`generateReportPdf(report: VerifiedReport, { pageSize: "LETTER" | "A4", locale, logo }, engine) -> ReportPdf`

1. `renderReportHtml` runs first: an unverified report or unsafe logo is refused (`ReportModelError`) before any engine is touched.
2. `engine.print({ html, pageSize })` returns bytes or throws. A throw becomes `ReportPdfError("ENGINE_FAILED")` (cause kept);
   bytes without a `%PDF-` header, a `startxref` and trailing `%%EOF`, or shorter than 200 bytes, are `OUTPUT_INVALID`. No
   `ReportPdf` exists unless both checks passed.
3. `ReportPdf = { bytes, identity, storage: "NOT_PERSISTED" }`. `identity.pdfSha256` is SHA-256 of exactly `bytes`; it sits beside
   `modelHash`, `htmlSha256`, `packageDigest`, `manifestSha256`, `reportId`, `packageId`, `rendererVersion`, `engineId`, page size
   and locale. The closed `ReportSnapshot` is untouched; the PDF hash is delivery metadata, not a snapshot field.
4. The PDF is not deterministic (Chromium stamps creation time and ids). The identity is therefore the hash of the stored bytes,
   not a recomputable value; reproducibility is at the HTML level (`htmlSha256`).

## 3. Safety (S069)

- Browser sandbox stays on (`chromiumSandbox: true`, which removes Playwright's default `--no-sandbox`). If the host cannot run it,
  printing fails; there is no unsandboxed retry.
- JavaScript off, context offline, service workers blocked, every request aborted. A document that asks for anything but its own
  `data:` logo fails the print (`ENGINE_FAILED`, message names only the scheme) instead of yielding a PDF with a hole in it.
- One fresh browser and context per print, closed in `finally`; 60 s limit; documents over 8 MiB are refused before launch.
- The report HTML already carries a CSP of `default-src 'none'; style-src 'unsafe-inline'; img-src data:`; the engine does not rely on it.

## 4. Presentation

Tagged PDF, text as text (selectable), size from the document's `@page` (Letter 612×792 pt, A4 ≈595×842 pt), repeating table
headers and unsplit rows as the HTML declares. Content is exactly the HTML's.

## 5. Defect found and fixed here

`copyText` only recognised `{[a-zA-Z]+}` placeholders, so the footer printed the literal `{manifestSha256}` instead of the manifest
hash: the HTML (and the PDF) did not carry the reference the design promises. The pattern now accepts digits; a regression test
asserts the footer holds the package digest, manifest SHA-256 and model hash and that no `{placeholder}` is rendered.

## 6. Cases

| case | here | evidence | remaining |
|---|---|---|---|
| S069 (PDF engine sandbox) | sandboxed Chromium, JS off, network off, tests with a local server that must see zero hits | EXECUTED_LOCAL (Windows, Edge 155); EXECUTED_CI (Linux: Ubuntu 24.04.5 runner, Google Chrome 155.0.8059.39 as `tools/ci/prepare-chromium.sh` finds it, the runner's own AppArmor profile, sandbox on: no `--no-sandbox`, non-root, no privileged container; the browser's sandboxed descendants report `Seccomp: 2` and `NoNewPrivs: 1` in `/proc`; the 5 tests of `report-pdf.test.ts` run with the engine required, none skipped, Letter 612x792 and A4 595x842 read back with their SHA-256; Windows: Chrome on windows-latest) — run https://github.com/miguellopezndev-ui/kauro-platform/actions/runs/38980645572 | deployment image and pinned browser |
| S070 (printed Letter/A4) | page sizes read back with pdf.js, multi-page report, long table with header on every page | EXECUTED_LOCAL | — |
| hash binding | `pdfSha256` equals SHA-256 of the returned bytes; identity equals model/HTML/package values | EXECUTED_LOCAL | — |

## 7. Interface left for delivery

`ReportPdfPublisher.publish(pdf: ReportPdf) -> { identity, location }` (declared in `@kauro/reports`) must store `pdf.bytes`, re-hash
what it stored, require equality with `identity.pdfSha256`, and only then return the location. It is implemented, and joined to B08's
attempt, publication and download, in `B13-report-delivery.md` (`StagedReportPdfPublisher` over the attempt's writer;
`ReportingExecutionEnvelope` composing `readMigrationPackage` → `buildReportModel` → `generateReportPdf` → publisher). `storage`
stays `NOT_PERSISTED` on the generated object: staging and delivery are facts of the stored artifacts, not of this module. A `ReportPdf`
is now frozen and registered when `generateReportPdf` returns it (the engine's bytes are copied), so a publisher accepts only a PDF this
module made (`isGeneratedReportPdf`) whose bytes still hash to its identity (`reportPdfProblems`).
