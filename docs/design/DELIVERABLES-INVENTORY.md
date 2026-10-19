# Deliverables inventory

2026-10-18, phase A of the owner's scope decision for deliverables. This document records only what exists and how it is classified.
Nothing listed as "not implemented" is to be built under this decision.

Sources:
- the engines' code: `cores/kauro-migration-core` and `cores/kauro-intelligence-core`;
- the platform's code: `apps/*` and `packages/*`;
- the specification as quoted in the repository: A3, the legal texts, `packages/contracts/registry` and the B-designs.

The R2 manual 13 ("Reports and deliverables") is not in the repository.

## 1. Deliverables that exist

### 1.1 Written by the Migration Core 3.0.0 (the owner's engine; not modified under this decision)

| Folder | Files | Format | Read by |
| --- | --- | --- | --- |
| `01_IMPORT/<target>/` | one file per object, plus `associations/*.csv` | CSV | the CRM import tool. The destination fixes the headers. |
| `02_EXCEPTIONS/` | isolated, leftovers, rejected-input, unmapped-fields, unresolved-associations, destination-conflicts, duplicate-candidates, formula-risk | CSV | the person who acts on them |
| `03_TRACEABILITY/` | source-lineage, changes, flags, associations, import-crosswalk, instance-verification, destination-matching | CSV | a person proving something, usually through tools |
| `03_TRACEABILITY/` | reconciliation, config.normalized, merges | JSON | machines (the verifier, the platform reader) |
| `04_DOCUMENTATION/` | `audit.md`, `import-instructions.md` | Markdown | the agency's operator |
| `04_DOCUMENTATION/data-view/<target>/` | safe-to-open copies of the import files that hold a value a spreadsheet would read as a formula | CSV | a person in a spreadsheet |
| root | `manifest.json` | JSON | the verifier and the platform reader |

The Intelligence Core 0.6.0 writes no file. It returns a draft migration plan, which the platform reads.

### 1.2 Written by the platform

| Deliverable | Format | State | Brand |
| --- | --- | --- | --- |
| Package report (B13) | HTML printed to PDF, Letter or A4 | built and tested; no app composition runs it yet | the agency's (name and logo); Kauro only as the issuer line (R2-070) |
| Report record | JSON | built | none (machine evidence) |
| Outreach email | plain text | built; sending refused until compliance is configured | Kauro's compliance signature |

The web pages that show information are pages, not deliverable files: UI18, UI23, UI24, UI30 and the legal pages. Sample delivery
(UI05) is the public, synthetic representation of the report, and it is in scope because it represents the report.

### 1.3 Who keeps what

"Agency" means the company that bought the service, whether an agency or a direct company.

| Deliverable | Kept by the agency | Handed to the end client |
| --- | --- | --- |
| Package report (PDF) | yes | yes (ToS 15.3; "Prepared by {agency}") |
| `02_EXCEPTIONS` | yes; the operator acts on them | sometimes, for decisions on duplicates and conflicts |
| `04_DOCUMENTATION` | yes | sometimes |
| `03_TRACEABILITY` | yes, as evidence | rarely, on a dispute |
| `01_IMPORT` | yes; they go into the CRM | no |

## 2. Deliverables specified but not implemented (not to be built under this decision)

- **Free data health check report** (`AUDIT_REPORT`; A3 §3.2 and §4.4). Today it is screen UI18 only.
- **Downloadable quote and order summary** (legal checklist A-05). Today it is screen UI23 only.
- **Payment instructions as a document** (ToS §8). Today it is screen UI24 only.
- **Commission statement** (`CommissionStatement`, UI36). Today it is JSON only.
- **Offer sheets for sellers** (UI53, R2-135). Today they are a record with a content hash.
- **Deletion receipt** (S064). Today it is a database record.
- **Notification and invitation emails.** There is no wording yet.

Five of these would be presented as delivered by Kauro itself: the quote and order summary, the payment instructions, the commission
statement, the offer sheets and the deletion receipt. If they are built later, they follow the documentary criteria to be added to
KAURO_VISUAL_IDENTITY.md.

## 3. Out of scope

Out of scope are documents produced by third parties: the fiscal invoice, credit and debit notes (e-invoicing provider), payment
receipts and bank evidence.

## 4. Typography

- **Agreed identity:** Inter for the brand, headings and text; JetBrains Mono for technical information; no third face.
- **The report** embeds Inter and JetBrains Mono (`packages/reports/assets/fonts`, see `REPORT-REDESIGN-PROPOSAL.md`).
- **The web** serves the same faces since Order 10 (2026-10-19; `apps/web/public/fonts`, A10 §11). The discrepancy recorded here on
  2026-10-18 is closed.
