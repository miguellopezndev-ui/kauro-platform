# Report redesign: phase A proposal

2026-10-18. This is a visual proposal for the B13 package report, for the owner's approval. **Nothing here is implemented.**

- **Renderer untouched:** the real renderer (`packages/reports/src/html.ts`) is unchanged.
- **What the proposal is:** a prototype run over the real verified model of the five sample packages, using the existing copy catalogue.
- **Previews:** `C:/Users/migue/Kauro-visual-delivery/deliverables/phaseA/`:
  - `before/` and `proposal/`: PDF, HTML and a PNG of every page, Letter and A4;
  - `compare-*.png`: the before/after sheets;
  - `fidelity.txt`: the content check.

## 1. What it keeps

- **Every fact template 1 prints, in Letter and A4:**
  - each count with its definition;
  - records by object;
  - relationships;
  - the import guide (path, object or relationship, part, expected records, SHA-256);
  - every exception and package file with its use, records and hash;
  - source files (with the agency's file names isolated in `<bdi>`);
  - the evidence line.
- **The agency's place:** the logo, or the display name set as a wordmark. No other customisation.
- **The issuer line**, as text (R2-070).
- **The model:** unchanged; no fact is computed by the layout.
- **The safety barriers:**
  - no script;
  - no URL other than the logo's and the fonts' `data:`;
  - every value escaped.

## 2. What changes

- **Type:** Inter (variable, 4.1) for all text and JetBrains Mono (2.304) for paths, hashes and section numbers. Both are embedded in
  the document as `data:` fonts, so the print no longer depends on the faces installed on the server.
- **Palette, used by context:**
  - carbon `#242426` for the text;
  - porcelain `#F8F6F3` for the summary panel, the table bands and the evidence block;
  - wine `#653A46` for the verdict, the section and step numbers and the source rows total;
  - a light tint of clay `#C4A693` for the counts notice.
- **First page:**
  1. the agency's brand;
  2. the verdict ("Prepared for import") as a quiet label instead of a rotated stamp;
  3. the title and status;
  4. who prepared the report and who provides the service;
  5. a summary panel with the three denominators and the rows unified with approval;
  6. the counts arranged as where every source row went (delivered, unified, held back, not readable, then the source rows as the
     total), followed by the other measures.

  The first page now gives the result without removing anything from later pages.
- **Tables:**
  - one rule under the head;
  - quiet porcelain bands instead of a grid;
  - numbers right-aligned in tabular figures;
  - paths that break only after a slash, with the folder lighter than the file name;
  - exception files with no rows set back.
- **Exceptions:** their common use is said once at the head of the section. A file whose use differs (`formula-risk.csv`, safe to open
  in a spreadsheet) says so under its name.
- **Short tables:** records by object and relationships sit side by side, aligned on the same line.
- **Running footer** on every page: the title, and "Page n of m" (CSS page margin boxes, supported by the pinned Chromium).

## 3. Defects of the previous attempts it resolves

- **Template 1 (main):**
  - a full grid on every table (double lines where cells meet);
  - no hierarchy between the title, the attribution and the counts;
  - the system faces of whichever machine prints it;
  - no page numbers.
- **Template 2 / v4 (not merged; rejected by the owner on 2026-10-18):**
  - it looked generated;
  - it did not use the palette or the agreed type;
  - it had double rules and too many dividers;
  - its proximity and hierarchy were weak;
  - its rotated stamp was clipped.

## 4. Labels the design adds (no new fact or claim)

"Prepared for import" (verdict), "At a glance", "Where every source row went", "Other measures", "Review, not for import." (the
existing use label, as a sentence), "Evidence for this report" and the page footer.

In phase B each becomes a catalogue key that passes the catalogue tests: no forbidden claims, no characters HTML would escape.
"Counts" (template 1's heading) is replaced by "Where every source row went" and "Other measures".

## 5. Content check (phase A)

`fidelity.mjs` compares the before and the proposal for each of the 10 documents (5 packages, Letter and A4). It checks:

- every text of the before is found in the text extracted from the proposal's PDF (whitespace removed, case ignored, because column
  heads are set in capitals);
- every `data-figure` has the same value;
- every file has the same use;
- every per-file record count is printed the same number of times.

Result: **all pass**. The check found two real problems while the proposal was being made, and both are fixed:

- **A lost use:** the "said once" exception use dropped the distinct use of `formula-risk.csv`.
- **Text that did not survive extraction:** Inter's alternate "a" and its contextual forms of brackets and hyphens extracted as missing
  or private characters. They are now off: `font-variant-ligatures: no-contextual` and `"calt" 0`, and no `cv11`/`ss01`.

## 6. For phase B (after approval)

- **CSP:** add `font-src data:` to the report's CSP. Load the font files reproducibly from a pinned, recorded copy of the official
  releases:

  | File | SHA-256 |
  | --- | --- |
  | `Inter-4.1.zip` | `9883fdd4…6b11e` |
  | `InterVariable.woff2` | `693b77d4…429a8e3` |
  | `JetBrainsMono-2.304.zip` | `6f6376c6…7bbf` |
  | `JetBrainsMono-Regular.woff2` | `a9cb1cd8…45f2` |
  | `JetBrainsMono-Medium.woff2` | `086c48df…a353` |

  Licence: OFL 1.1 for both families.
- **PDF size:** the PDF grows from about 0.19 MB to about 0.5 MB because the variable font is embedded whole. Static, subset weights
  would reduce it; decide in phase B.
- **Pagination limit:** a long table can start with a single row at the foot of a page. CSS cannot ask a table to keep its first rows
  together; phase B tries a structural fix and tests it.
- **Version:** a new `REPORT_TEMPLATE` and `rendererVersion`. Earlier reports keep their stored PDF and hashes.
- **Tests:**
  - the HTML tests (figures, catalogue text nodes, logo markup, page rules);
  - the data-plane PDF tests on Linux and Windows;
  - the content check above, made a test.
- **Then:** align Sample delivery, and write the documentary criteria into KAURO_VISUAL_IDENTITY.md.
