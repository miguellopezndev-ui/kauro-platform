# Order 11, round 3: the deliverables plan

The documents Kauro produces are part of the product the customer keeps. They must reach the same bar as the screens: the health
check report, the delivery package, the manifest, the importer guide, the exception files, quotes, statements and messages.

The method is the web plan's ([ORDER11-ROUND3-MASTER-PLAN.md](ORDER11-ROUND3-MASTER-PLAN.md)), applied to documents: questions,
research, alternatives, blind judging, audits and records. The questions, the research and the checks differ, because:
- a document is read differently from a screen (printed, forwarded, opened in Excel, parsed by an importer, read months later);
- some documents are read by machines first and people second.

Owner's direction (2026-10-21):
- design and content only, whatever part of the system produces the document;
- each document must be the best version there is, as a template that later fills with the true data;
- create the documents that should exist and do not;
- documents Kauro gives the agency for the agency itself may carry more design;
- every format is in scope (PDF, JSON, Markdown, TXT, CSV);
- charts and other visuals are welcome where they add value.

---

## 0. The bar for a deliverable

A deliverable is done only when all of these hold.

1. **It answers its reader's questions** (§3) in the order the reader needs them. The first page or first screenful gives the
   conclusion.
2. **It is true.** Every figure comes from the data the template receives, never typed in. Every figure in a document reconciles
   with every other figure that describes the same thing:
   - counts add up across the report, the manifest and the files;
   - percentages are their counts over the stated population.

   Nothing claims a capability Kauro does not have, and nothing contradicts a contract or an owner decision.
3. **It works for its machines.** A file an importer reads keeps the exact format that importer needs:
   - HubSpot's import tool and Salesforce Data Loader dictate their columns, headers, encodings and separators;
   - JSON validates against its schema;
   - CSV opens cleanly in Excel, Numbers and Google Sheets (UTF-8 with or without BOM as required, delimiter, quoting, line endings,
     no formula injection: a cell starting with `=`, `+`, `-` or `@` is neutralised);
   - Markdown renders the same on GitHub, in VS Code and in a plain text editor.
4. **It is beautiful and clear in its medium.**
   - PDF: typography, grid, hierarchy, colour, charts, page breaks (no orphaned headings or split table rows), running headers and
     footers, page numbers, a table of contents where long. It prints well in greyscale and on A4 and Letter.
   - Text formats: structure, alignment, line length and naming.
5. **It is accessible.** A PDF is tagged (headings, reading order, table headers, alternative text for charts, document language and
   title). Contrast is AA. Information never relies on colour alone, including in charts and in greyscale.
6. **It is Kauro, at the right volume.** The brand level depends on who reads it (§2):
   - documents an agency may forward to its client can be neutral or co-branded;
   - documents for the agency itself carry more of Kauro's design.

   Documents the agency may forward under its own brand (white label) are judged **neutral and premium**: they must not look like
   Kauro, and they must look expensive. Documents for the agency itself and documents Kauro issues in its own name (quotes,
   statements, receipts) read as the Kauro family in print (the blur test against the light print tokens, §1.2).
7. **It survives the extremes:** 0 rows, 1 row, 2 million rows; 800 columns; long names in any script; missing optional data; a
   failed or partial run.
8. **It has a record:** the brief, the research, the alternatives, the judging and the decision.

Every step is an audit, as in the web plan: a checklist, evidence, findings, nothing passed on trust.

---

## 1. Inventory (filled from the code, confirmed before any design)

The table lists every deliverable that exists, where it is produced, who receives it, what pins its format (tests, golden files,
schemas, destinations) and what exists only on paper. Built from the repository on 2026-10-21; see §1.1.

Shorthand: `MC` = `cores/kauro-migration-core` (the source of Migration Core 3.0.0, vendored as `vendor/kauro-migration-core-3.0.0.tgz`).
The Intelligence Core writes no file. Existing records to start from: `docs/design/DELIVERABLES-INVENTORY.md` (2026-10-18) and
`DELIVERABLES-STRUCTURE-AUDIT.md` (defects F-01 to F-23).

**What exists**

| # | Deliverable (format, place in the package) | Reader | Produced by | Pinned by, format dictated by |
|---|---|---|---|---|
| 1 | Import files (CSV, `01_IMPORT/<hubspot\|salesforce\|clean-only>/<object>.csv`, `associations/*.csv`, numbered parts over size limits) | The agency's operator; not for the end client | MC: `src/artifacts/render-package.ts`, `import-partition.ts`, `csv-writer.ts`, `layout.ts`; headers in `src/adapters/specs.ts` | **The destination:** HubSpot's import tool and Salesforce Data Loader. Real imports are recorded in `MC/qualification`. Acceptance hashes, `manifest.json`, `MC/docs/CONTRACT.md` §11b, §13b, §15 |
| 2 | Exception files (CSV, `02_EXCEPTIONS/`: isolated, leftovers, rejected input, unmapped fields, unresolved associations, destination conflicts, duplicate candidates, formula risk) | The operator; sometimes forwarded to the client for decisions | MC: `render-package.ts`, `layout.ts` | Acceptance hashes, the manifest; read by name by the verifier and by `packages/reports/src/package.ts`; defects in the structure audit |
| 3 | Trace files (CSV and JSON, `03_TRACEABILITY/`: lineage, crosswalk, changes, flags, associations, matching, verification, reconciliation, merges, normalised configuration) | The agency, kept as evidence | MC: `render-package.ts`, `src/verify/*` | Acceptance hashes; `config.schema.json` (its hash is the configuration hash); `reason-codes.json` |
| 4 | Audit summary (Markdown, `04_DOCUMENTATION/audit.md`) | The operator | MC: `src/artifacts/audit.ts` | Acceptance hashes; integration tests |
| 5 | Importer guide (Markdown, `04_DOCUMENTATION/import-instructions.md`, one per destination) | The operator | MC: `src/artifacts/import-instructions.ts` (destination rules in `specs.ts`; `operatorInstructions` is never written, audit F-03) | Acceptance hashes; tests |
| 6 | Spreadsheet-safe copies (CSV, `04_DOCUMENTATION/data-view/`) | A person opening files in a spreadsheet | MC: `src/artifacts/human-view.ts` (decision D72) | Acceptance hashes |
| 7 | Manifest (`manifest.json`) | Machines | MC: `write-package.ts`, `package-digest.ts` | Re-checked in `packages/reports/test/package.test.ts` |
| 8 | **Package report (PDF, Letter or A4, from one HTML document, template `kauro-report-template/2`)** | The agency, which may forward it to its client. **White-label:** the agency's brand leads ("Prepared by {brand}"); Kauro only in the issuer line, which white label cannot remove | **Platform**, not a core: `packages/reports/src/{package,model,html,copy,fonts,pdf}.ts`; Chromium engine `packages/data-plane/src/pdf/chromium-pdf-engine.ts`; run by the worker | Bytes not pinned (Chromium is not deterministic; the PDF's SHA-256 is recorded); the HTML is deterministic with no golden file. Property tests in `packages/reports/test`, `packages/data-plane/test/report-*.test.ts`, `apps/control/test/b13-*.test.ts`. Fonts Inter 4.1 and JetBrains Mono, pinned by `assets/fonts/PROVENANCE.json` |
| 9 | Report record (canonical JSON, `KAURO_REPORT_PDF_RECORD_V1`) | Machine evidence | Platform: `packages/data-plane/src/report/record.ts` | Strict read-back; tests |
| 10 | Outreach email (plain text with one-click unsubscribe) | Prospects (agencies, companies) | Platform: `apps/api/src/outreach/mime.ts`; drafts in `packages/application/src/commercial/outreach/` | Sealed by the SHA-256 of its bytes; wording from A3 §4.6; tests `apps/api/test/b12-*`; sending refused until compliance is configured |

**Promised in the documents but not built as files** (the creation list):
- the free data health check report (`AUDIT_REPORT`, A3 §3.2, §4.4);
- a downloadable quote and order summary;
- the order acknowledgement email;
- the payment-reversal complaint receipt;
- payment instructions;
- the commission statement (UI36, JSON only today);
- seller offer sheets (UI53);
- the deletion receipt;
- notification and invitation emails;
- the report classes `AGENCY_SUMMARY` and `INTERNAL_EVIDENCE`;
- a ZIP package (downloads are per-file signed links today);
- a one-page summary an agency can forward to its client.

Fiscal invoices and payment receipts come from third parties and are out of scope.

**Found already:** the public Sample delivery page uses file names the core never writes (`contacts-clean.csv`; the core writes
`01_IMPORT/clean-only/contacts.csv`). It is fixed in the web track so that the sample shows the real package.

### 1.1 Rules from the inventory
- **Import files (row 1): their format is untouchable.** Headers, encodings, separators and file names are dictated by HubSpot and
  Data Loader, and real imports qualified them. Only what surrounds them may change: the guide, the README, how parts are explained.
- **Rows 2–7 live inside Migration Core, and no engine code changes in this run.**
  - **Why** (fifth independent review, 2026-10-22):
    - the Intelligence Core accepts only Migration Core 3.0.0 (`SUPPORTED_MIGRATION_CORE.coreVersions`);
    - a release changes the run ID and every import key;
    - 3.0.0 is pinned in a dozen platform files;
    - the Intelligence Core may not be modified.

    A release would therefore break the audit path and CI.
  - **What is delivered instead,** for each of these documents (the audit summary, the importer guides, the exception and trace files,
    the spreadsheet-safe copies, the manifest, and the package's README and index, which do not exist yet):
    - the finished design and content as **rendered specimens** built from the canonical world;
    - a **written specification**;
    - a **ready patch** to the engine's templates, kept in `Kauro.archive` and not merged.
  - **Recorded** in `ROUND3-PRODUCT-DECISIONS.md` as a later core release. That release must also:
    - widen the Intelligence Core's accepted versions;
    - update every file that pins 3.0.0.
  - **The specimens reach the same bar** as any deliverable: they are judged, audited and recorded. Only their wiring waits.
  - **The patch is proven in a scratch copy** before it is archived:
    - the import files (row 1) and the exception and trace data files (rows 2–3) stay byte-identical;
    - `manifest.json` changes only in the entries for added or redesigned documentation files (path, kind, hash, size), shown by a
      diff that lists exactly those entries;
    - the core's verifier passes on every regenerated package, and the golden corpus passes (Day 0 confirms it does not pin
      document hashes).
  - **The PDF that ships in code describes the package that ships today (3.0.0).** Wording that depends on the patch (for example,
    "start with the README") lives only in the specimen version. The later-release record notes that `packages/reports/src/package.ts`
    maps package paths to kinds by a fixed list, so new files need entries there.
  - **The public Sample delivery page shows what 3.0.0 produces.** The redesigned documents appear there labelled as a proposal,
    recorded as a product decision and a functional gap, so the truth check (web plan §0, item 6) holds.

- **The PDF report (row 8) lives in the platform.** It is redesigned directly in `packages/reports` (model, HTML, copy, fonts, and
  charts drawn as inline SVG in the HTML, so no external service). The tests are updated to pin what matters: content, reconciliation
  and accessibility. Its white-label rule stands: the agency's brand leads and Kauro's issuer line stays.
- **New documents** are built as real templates in the platform (`packages/reports`, or the owning package for emails), rendered from
  synthetic data by the harness, and not wired to any flow. Each is recorded as a product decision and a functional gap (what wiring
  it needs).
- **Emails** follow the same plan with their own checks (plain-text and HTML parts, length, unsubscribe, client rendering).
  - **The outreach email's** wording is fixed by A3 §4.6 and sealed by its hash. Any change to it is drafted as an amendment
    (proposal) and recorded, never changed in code.
- **The engine's logic, the money logic and the versioned legal texts are not changed** by this track.

---

### 1.2 The documents' theme (a recorded decision)
The web is dark only. Documents and emails are printed, forwarded and opened in light mail clients, so they use a **light, print-first
theme** that carries Kauro's identity elements: the type, the wine accent, stamps and rules, and the paper feel.

- **The printed "blur test"** checks that these elements carry over. It is not a colour comparison with the dark web.
- **Emails are checked only with what runs locally:**
  - table-safe HTML;
  - a plain-text part;
  - renders at 320 and 600 px;
  - a simulated dark-mode inversion.

  No external email-testing service is used.
- **The decision is recorded** in `ROUND3-PRODUCT-DECISIONS.md`.

### 1.3 One set of data
Every document renders from the canonical fixtures of the web plan (§2.1).

- **Day-0 proves the path.** Migration Core runs on the canonical world into a scratch folder, never into the tracked acceptance
  packages, and the PDF is rendered from that output.
- **If the path works,** the reconciliation check covers documents and screens together.
- **If it does not,** the feasibility record says so in writing, and documents render from the acceptance cases with the canonical
  world's names and figures mapped onto them where the data allows. The cross-surface reconciliation is then declared out of scope
  for documents.

### 1.4 One chart grammar
Charts in the PDF use the same chart grammar as the web's kit (web plan §8.0).

### 1.5 Tiers for documents
- **Tier A:**
  - the PDF report, built in the platform;
  - the package's entry point (README and index) and the importer guides, as specimens and a patch (§1.1).
- **Tier B:**
  - the free data health check report (new);
  - the quote and order summary (new);
  - the commission statement (new);
  - the one-page client summary (new, if its brief proves it);
  - the audit summary.
- **Tier C:** receipts, notification and invitation emails, and the specimens of the exception and trace files.

The bar is the same in every tier. Only the depth of the process differs, as in the web plan (§15).

## 2. Readers and their situations

For each deliverable the first questions are who reads it, when and how:

- **The agency's operator:** prepares the import and needs exact steps and files.
- **The agency's account lead:** explains the result to the client and needs a story and numbers.
- **The end client:** receives what the agency forwards (white-label or co-branded?) and needs to trust it without knowing Kauro.
- **The company's data owner** (buying direct): needs to understand and act.
- **An approver or finance:** quotes, statements and invoices.
- **A machine:** the HubSpot importer, Data Loader, a spreadsheet, a script.
- **An auditor months later:** needs traceability, versions and dates.

---

## 3. The question bank for documents

These questions differ from the web plan's. Every answer cites evidence.

### 3.1 Purpose and reader
1. Who opens this first, and who opens it next (forwarded)? What does each need to do after reading?
2. Is it read on screen, printed, forwarded by email, opened in a spreadsheet, or parsed by a program?
3. What is the one conclusion the reader must take away, and is it on the first page?
4. What decision or action does it enable, and is that action written as a step?
5. Kauro-branded, co-branded, or neutral (white-label)? Who decides, and does the document say who made it?
6. What would make the reader trust it? What would make them doubt it (a figure that does not add up, a vague claim, a missing date)?

### 3.2 Content and truth
7. Which figures, from which data? Are they reconciled with every other document of the same package?
8. What is measured, what is a sample or an example, and what is only proposed? Are the three kept apart, in words?
9. What is the scope: which files, which version, which plan, which dates? Is it stated on the cover or in the header?
10. What is not included, or not checked? Is it said plainly?
11. Which terms need a definition (billable source unit, duplicate candidate, prepared for import)? Is there a short glossary?
12. What changes between versions of the same document, and how does a reader tell versions apart?

### 3.3 Structure
13. What is the order: conclusion, evidence, detail, appendix? Does every section earn its place?
14. How long should it be? What moves to an appendix or to a separate file?
15. Does a long document need a contents page, running headers, page numbers, section numbers?
16. Can a reader find one record, row or figure fast (search, IDs, cross-references between files)?

### 3.4 Visual design (PDF and rendered formats)
17. Which grid, margins, page size (A4 and Letter both)? Portrait or landscape for wide tables?
18. Which type scale, and which fonts? (PDF keeps Inter today; is it still the best? Is it embedded and subset?)
19. How much colour, where, and does it survive greyscale printing and colour-blind reading?
20. Which charts truly help (a bar of issue counts, a waterfall from source rows to delivered rows, a stacked share of records by
    state)? Which would be decoration? Each chart has a title, units, a source line and a text alternative.
21. Tables: which columns, alignment (numbers right, tabular figures), row height, zebra or rules, repeated headers on new pages,
    no split rows.
22. Cover and back page: what goes on them, and how much brand?
23. Does it look like the same family as the web (blur test) at the right brand volume?

### 3.5 Machine formats
24. Who parses it, and which exact format does that parser need (encoding, BOM, delimiter, quoting, line endings, header names, date
    and number formats)?
25. Are column names readable by people and stable for programs? Is the order meaningful (identity first, then attributes)?
26. Is every file named predictably (project, version, date, part) and sorted sensibly in a folder?
27. Does each machine file have a human companion (a README or a manifest entry) saying what it is and how to use it?
28. Are injection risks neutralised (CSV formulas) and are sensitive values never present (secrets, other tenants)?

### 3.6 Edge cases
29. 0 rows, 1 row, millions of rows; 800 columns; very long text; non-Latin scripts; right-to-left names; emoji.
30. Partial runs, failed checks, held-back rows, expired documents: how does each read?

### 3.7 The package as a whole
31. Does the package (the folder or ZIP) read as one thing: a clear entry point (README or index), consistent names, a manifest that
    adds up, nothing duplicated or contradictory?
32. Is it obvious which file to open first, which to import, and which to keep for the record?

---

## 4. Research for documents

- **Sources:**
  - data-quality and audit reports (Insycle grader reports, data-quality tools' PDF exports, Fivetran and Airbyte logs);
  - migration deliverables published by agencies and integrators;
  - delivery notes and manifests (software release notes, package manifests);
  - importer documentation: HubSpot import files, Salesforce Data Loader CSV rules;
  - statements and invoices (Stripe, Paddle invoices, commission statements of partner programmes);
  - well-designed annual and technical reports;
  - data-visualisation guidance;
  - document accessibility (PDF/UA, WCAG for PDF);
  - GOV.UK guidance on writing and on publishing data in CSV.
- **Scorecards and minimum samples** as in the web plan (§7):
  - 8 or more per document type;
  - patterns need 3 independent references.
- **Fresh-context concept agents** are used where references run out.

---

## 5. Alternatives and judging

- Every document gets **3 or more full alternatives** of its structure and visual design (cover, first page, a body page, a table page,
  a chart, an appendix). Each is rendered with the same synthetic data at A4 and Letter, in colour and in greyscale.
- Machine formats get alternatives where a real choice exists (column order, naming, README structure, JSON shape where Kauro owns the
  schema).
- **Gates:**
  - truthfulness and reconciliation;
  - the importer's format (a file the importer cannot read is eliminated);
  - accessibility checks;
  - print checks (margins, breaks).
- **Judging applies the web plan's §9.0–§9.5 word for word**, with the document rubric below in place of the screen rubric:
  - fidelity rises with the level;
  - calibration on at least 30 held-out document pairs, at 85% or more. The subtle pairs come from print and document-design guidance
    (for example, the PDF/UA and GOV.UK publishing guidance), paired with deliberately degraded copies and with good alternatives
    that differ only in hierarchy;
  - the incumbent (today's document, or a kit-only baseline for a new one) always competes, at the challengers' fidelity;
  - a Swiss bracket, three judges, both side orders, independent rubric scores;
  - a clear win means at least 2 of 3 judges in both orders and a lead of 5 points or more;
  - the same ceilings as the web's tiers;
  - one outside critic per Tier A or Tier B document, and one per walk of the whole Tier C set (as one per site walk for Tier C
    screens).

### 5.1 Document rubric (100 points)

| Criterion | Points |
|---|---|
| The conclusion is clear and first | 20 |
| Truth and reconciliation | gate |
| Structure and findability | 15 |
| Typography, grid and hierarchy | 15 |
| Visuals (charts, tables) that add meaning | 10 |
| Identity at the right volume (Kauro family, or neutral and premium for white label) | 10 |
| Accessibility (tagged PDF, contrast, colour-independent) | 10 |
| Machine-format correctness and robustness | 10 (gate where a parser reads it) |
| Edge cases | 10 |

---

## 6. Tooling

The Day-0 feasibility check of the web plan (§3.0) covers these tools too. The PDF structure is read with pdf.js. Tagging is
confirmed with the tooling available locally; where none exists, that is stated in the record.

- **A local render harness** for every deliverable from synthetic data. It uses the repository's own renderers; no external service is
  called. The base commands are known:
  - **PDF:** `pnpm -r build`, then in `packages/data-plane` with `KAURO_PDF_BROWSER` set to the local Edge or Chrome and
    `KAURO_PDF_EVIDENCE_DIR` set to a scratch folder, run `node --test dist/test/report-pdf.test.js`. It writes Letter and A4 PDFs of
    the acceptance cases.
  - **Package files:** generated from the canonical world into a scratch folder (§1.3). The five acceptance packages in
    `MC/acceptance/*/package` are only read, never regenerated in place; the patch is proven in a scratch copy (§1.1).
- **PDF checks:** page count, fonts embedded, tags present, reading order, page breaks, contrast of text colours, greyscale render,
  A4 and Letter.
- **Machine-format checks:** CSV parsed by a strict parser and by the same rules HubSpot and Data Loader document (headers, encoding,
  quoting); JSON validated against its schema; Markdown rendered by two renderers.
- **A reconciliation check** across every file of a package (counts and identifiers agree).
- **A contact sheet** of every page of every PDF alternative, for judging.

---

## 7. Order and links with the web plan

1. **Inventory and briefs for every deliverable.**
2. **The package as a whole:** its entry point, naming and the manifest. Every other document hangs from it.
3. **The documents themselves:**
   - the health check report;
   - the delivery report;
   - the importer guides (HubSpot, Salesforce);
   - the exceptions and trace files;
   - quotes and statements;
   - the messages.

   They are ordered by how many readers each reaches and how much each shapes trust.
4. **New documents** whose need the briefs prove (for example, a one-page summary an agency can forward to its client, if the research
   supports it).
5. **Integration with the web:**
   - the workspace's delivery screens (UI26–UI28) and the public Sample delivery page show the finished documents (the shipped PDF as built; the engine's documents as the 3.0.0 output plus the redesign labelled as a
     proposal, §1.1);
   - so the documents must be final before those screens are finished.

The track runs in parallel with the web plan from the start, in its own worktree, with the same records, ledger and final
push-and-merge.

---

## 8. Records

For every deliverable, `Kauro.archive/Deliveries/Visual/order11/research/round3-docs-<name>/` holds:
- BRIEF.md;
- RESEARCH.md;
- the alternatives' renders;
- AUDITIONS.md;
- NOTES.md.

Product decisions (new documents, changed contents) go in `docs/design/ROUND3-PRODUCT-DECISIONS.md`. Progress goes in
`docs/design/ROUND3-PROGRESS.md`.
