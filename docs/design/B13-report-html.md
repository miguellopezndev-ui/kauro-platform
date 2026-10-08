# B13 — Report HTML and import guide: design

Second part of B13 (branch `b13/reports-html`, stacked on `b13/reports-model`, PR #16). It renders the verified report model
(`docs/design/B13-report-model.md`) as one self-contained HTML document. The worker prints that document to PDF; the PDF
engine, its pinned version and the stored PDF are B's (worker), not this package's.

## 1. Contract

`renderReportHtml(report: VerifiedReport, { pageSize: "LETTER" | "A4", locale, logo: Uint8Array | null }) -> { html, sha256 }`.
Pure and deterministic: the same report, page size, locale and logo give the same bytes; no clock, no randomness, no I/O.
`sha256` is over the UTF-8 bytes of `html`; the footer names the package digest, manifest hash, core version, `modelHash` and
renderer version, so a printed report identifies its exact inputs.

## 2. Safety (S069)

- No `<script>`, no event-handler attribute, no inline `style=` attribute, no URL of any kind. One `<style>` element and a CSP
  meta: `default-src 'none'; style-src 'unsafe-inline'; img-src data:` (the worker's PDF engine must also run with scripts
  and network off; requested of B).
- Every string is escaped for text and double-quoted attribute context (`& < > " '`). Model strings are from closed vocabularies
  except the agency's file names (`UntrustedText`), which are escaped and isolated in `<bdi>`, and printed only in
  SECURE_DETAIL / INTERNAL_EVIDENCE reports.
- The logo is embedded as a `data:` image only when its bytes are the stored logo the branding names: SHA-256 equal, PNG/JPEG
  signature of the declared type, at most 512 KiB and 1..2048 pixels a side (an image bomb is refused before any decoder runs).
  A branding with a logo but no bytes, or bytes but no logo, is refused (`BRANDING_UNSAFE`).

## 3. Content

Header: title, "Prepared by {brand}", the issuer's legal identity from the terms facts (R2-070: white label never replaces it),
and "Prepared for import. Nothing has been written to any CRM". Counts: the three denominators first (source rows, billable
units from the quote, rows in the import files), then every other RowCounts measure, each with its definition (R2-065);
`countsBinding: "UNBOUND"` prints a notice that the counts are not yet reconciled with the platform record. Records by object;
relationships. Import guide (R2-069): "Import the files under 01_IMPORT and nothing else", then each step in the model's order
with its path, object or relationship ends, "Part n of m" for a cut table, expected records and SHA-256. Exceptions (R2-071):
every exception file with its complete total and hash; the rows stay in the package files. Package contents: every other
file with its use ("Evidence, not for import" …). Source files.

## 4. Print layout (S070)

`@page { size: letter | A4 }` is the only difference between the two sizes (tested byte for byte). Table headers repeat on each
page, rows do not split, headings stay with their content, hashes and paths wrap. Text is text (no image of text), so it stays
selectable and readable by assistive technology in the PDF. Whether the PDF engine honours these rules is the worker's test.

## 5. Copy (A3, R-E3)

All visible text comes from `REPORT_COPY`, keyed by locale; English (en-US) is the default and the fallback for an unknown
locale or a missing key. Tests: the English catalog holds no Spanish text, no character HTML would escape, and none of A3's
forbidden claims (AI, "imported", compatibility, deleting duplicates, savings, "audit"/"diagnosis"); every text node of a
rendered document is a catalog text or a model value.

## 6. Cases

| case | here | evidence | remaining |
|---|---|---|---|
| S069 | escaping, `<bdi>`, inert document, logo bytes checked (hash, signature, size, pixels) | EXECUTED_LOCAL (HTML) | the PDF engine's own sandbox: worker (B) |
| S070 | Letter/A4 page rules, repeating headers, unsplit rows, exact counts | PARTIAL | the printed PDF in Letter and A4: worker (B) |
| R2-065 | three denominators with definitions | EXECUTED_LOCAL (HTML) | — |
| R2-069 | guide lists only import files, by order and part; every other file marked not for import | EXECUTED_LOCAL (HTML) | — |
| R2-070 | issuer printed on every report whatever the brand | PARTIAL (model R2-070 is PARTIAL) | terms snapshot input: B |
| R2-071 | complete exception totals; rows stay in the package | PARTIAL | pagination of a long rejection table if a later report class shows rows |

## 7. Requests

- The worker's PDF step (B): pinned engine with JavaScript and network disabled; prints this HTML in Letter and A4; stores the PDF
  with its SHA-256 beside the HTML hash and the `ReportSnapshot`; the S070 print test on its side.
