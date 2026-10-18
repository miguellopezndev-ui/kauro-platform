# Structure audit of the package's CSV, Markdown and JSON files

2026-10-18, phase A of the owner's scope decision for deliverables.

**Scope:** an audit of organisation and comprehension only.
- No file is modified, and the Migration Core 3.0.0 is not re-versioned in this phase.
- The JSON consumed by machines stays intact.
- Every proposal below would be a future core release. A release changes the golden fixtures and manifest hashes, and runs the core's
  acceptance and verifier tests.

**Material read:**
- every file of the five sample packages (`packages/reports/test/fixtures/mc-3.0.0/`, byte copies of the core's acceptance packages);
- the writers in `cores/kauro-migration-core/src/artifacts/`;
- the platform reader `packages/reports/src/package.ts`.

**Verification:** the four class A findings were each checked again against the bytes and the code before being recorded.

**Classes:**
- **A:** a defect that prevents interpreting or using a file correctly.
- **B:** a desirable clarity improvement.
- **C:** an aesthetic preference without functional impact.

## A. Defects

### F-01. HubSpot instructions say nothing is matched, while the same package says HubSpot matches on email

- **Evidence:**
  - D-hubspot `import-instructions.md` lines 15 and 23 say: "Matching field: none. Nothing in this file is matched against a record
    you already hold."
  - The same package's `audit.md` line 82 says "HubSpot deduplicates contacts by email address on import regardless of the selected
    mode". `instance-verification.csv` has an `EXISTING_RECORDS` item.
  - In C-identity-adversarial, `destination-conflicts.csv` says "HUBSPOT matches CONTACT records on contact.email".
  - Writer: `import-instructions.ts:105-106`, printed whatever the target does.
- **Impact:** the operator is told existing records cannot be touched. The "stop and reconcile" rule (line 51) then treats a
  legitimately lower created count as a failed import.
- **Proposal:** separate "Kauro declares no matching field" from "the destination matches on email and domain anyway", and make the
  stop rule conditional on it. This is a text change only; no effect on the reader or the verifier.

### F-02. Salesforce instructions say 0 relationships are listed in a file that holds 4

- **Evidence:**
  - D-salesforce `import-instructions.md` line 51: "0 could not be resolved and are listed in
    `02_EXCEPTIONS/unresolved-associations.csv`". That file has 4 data rows: LEFTOVER, `ASSOCIATION_UNSUPPORTED_BY_TARGET`.
  - Line 47 lists `associations/contact_to_deal.csv` to import. The file is header-only, and nothing says why.
  - The same 4 source rows are also in `leftovers.csv`.
  - Writers: `import-instructions.ts:150-154` counts only UNRESOLVED; `render-package.ts:364` writes both UNRESOLVED and LEFTOVER.
- **Impact:** the instructions cannot be reconciled with the exceptions folder.
- **Proposal:** "N could not be resolved and M are not supported by the destination; both are listed in …", and mark an unsupported
  association file as "0 rows, not importable into this destination". Text only; the reader's check (`package.ts:396`) still holds.

### F-03. The relationship step cannot be followed as written (HubSpot and Salesforce)

- **HubSpot:**
  - Line 41 says "Add the association key column from the association file to both object files as a common column". The object files
    already carry their own `Association Key`.
  - Editing them also contradicts "Import the files under `01_IMPORT/` and nothing else" and the hashes in the manifest.
  - Writer: `import-instructions.ts:197-202`.
- **Salesforce:**
  - Lines 16, 24 and 32 say "Do not map `Kauro_Association_Key__c`".
  - Line 49 says "use the pairing to populate the lookup field on the child", but the files have no lookup column and no steps are
    given.
  - The adapter holds a concrete procedure, `operatorInstructions` (`specs.ts:531`), which is never written into any package. Its field
    name `Kauro_Key__c` also differs from the header `Kauro_Association_Key__c`.
- **Impact:** the relationship step cannot be completed from the package. The likely result is records without their relationships,
  or an edit to hashed files.
- **Proposal:**
  - Render the adapter's procedure (with the field name corrected) as numbered steps.
  - Reconcile it with "Do not map".
  - Text only. Check any acceptance test that snapshots the instructions.

### F-04. `duplicate-candidates.csv` pairs conflicting values that do not belong to the same row

- **Evidence:**
  - C-identity-adversarial lines 2-3: `contact.firstName="Alan"/"Joan"; contact.lastName="Clarke"/"Turing"`.
  - `describeConflicts` (`identity/resolve-identity.ts:1136-1160`) sorts each field's values on its own. Read pairwise, the file says
    "Alan Clarke / Joan Turing".
  - Both member rows carry the same string.
- **Impact:** whoever decides on a possible duplicate gets a wrong picture of which record holds which value. Deciding on duplicates
  is the file's main purpose.
- **Proposal:** tie each value to its row, for example `R4: Alan Turing | R5: Joan Clarke`. The column is not read by name by the
  reader or the verifier.

## B. Clarity improvements

| ID | Finding (evidence) | Proposal |
| --- | --- | --- |
| F-05 | The "safe to open in a spreadsheet" guidance is only in `audit.md` (`audit.ts:144-146`) and is always printed. It sends C to a `data-view` folder C does not have, and calls every other CSV "for tools, not spreadsheets", although `02_EXCEPTIONS` is for people. | Print it only when it applies. Name the safe files. Repeat a one-line rule in the instructions. |
| F-06 | The data-view copies are UTF-8 without a byte-order mark. Accented names (B, `data-view/clean-only/contacts.csv` lines 2, 5, 6) and leading zeros (`01730`) are likely to display wrongly in Excel on Windows (not tested in Excel). | A byte-order mark on human-view files only, never on `01_IMPORT`; the reader and the verifier strip it. |
| F-07 | The "Reason codes used" table omits codes that appear in the files (`UNMAPPED_COLUMN_PRESERVED`, `DESTINATION_FORMULA_RISK_VALUE`, `IDENTITY_CANDIDATE_CONFLICTING_ATTRIBUTES`, `DESTINATION_INSTANCE_VERIFICATION_REQUIRED`). Its "Times" column mixes files (A: `ASSOCIATION_RESOLVED` 16 against 12 relationships). | Build the legend from every code in the package, using the descriptions already in `domain/reason-codes.ts`. Explain or drop "Times". `reconciliation.json` stays as it is. |
| F-08 | "What to expect afterwards" omits outcomes: C's 2 unified rows, its 2 destination conflicts and 4 duplicate clusters; B's 2 flagged values; D-salesforce's 4 leftovers. | One line per row outcome, each pointing to its file. |
| F-09 | `flags.csv` and `instance-verification.csv` ask a person to act but sit in `03_TRACEABILITY`, against the layout's own rule (`layout.ts:96-99`). | Name them in the instructions (cheap), or move them in a later release (affects `package.ts` and the verifier). |
| F-10 | Exception CSVs open with nine technical address columns. The reason, detail, field and value come at columns 10 to 14. | Put what a person needs first. The reader and the verifier read columns by name. |
| F-11 | `isolated.csv` (C line 6) leaves `field` empty, and names one conflicting field when there are two. The second appears only in `merges.json`. | Fill in the field, list every conflicting field, and tie values to rows. |
| F-12 | Terms are inconsistent. "Set aside" vs ISOLATED. LEFTOVER is defined as "not covered by the configuration", while in D-salesforce it means "not supported by the destination". One count has three names (`relationshipCandidates`, `sourceEdges`, "source relationships"). | A short glossary in `audit.md`; LEFTOVER defined by its reason. No JSON change. |
| F-13 | Salesforce documents use HubSpot and neutral vocabulary: "property", COMPANY for `Account.csv`, and an always-empty `Association Label` column. | Show the vendor's object name beside the core's. File names stay (the reader and the verifier require them). |
| F-14 | "In this order" is alphabetical order (`import-instructions.ts:57-60`). | Derive the order from parents and children, or say that it does not matter. |
| F-15 | CLEAN_ONLY instructions say "import … in this order" and "Expect 12 relationships to be created", then "nothing is imported anywhere". | Separate wording for CLEAN_ONLY. |
| F-16 | Destination notes are repeated four times (A and B lines 67-70) or describe objects not in the package (C). | One note each, only for the objects delivered. The verifier re-renders the audit in the same step. |
| F-17 | Engineer-only wording ("V1 support envelope", "target contract", "Data Loader profile declares"), and run ids before the result. | A "What needs your attention" block first, and plain wording. |
| F-18 | Two row-numbering conventions, neither explained: `row_number` and `R<n>` count physical lines, `import_row_number` counts data rows. | Explain both. Column names stay. |
| F-19 | `formula-risk.csv` lists delivered values in the folder described as "what did not go". It names each value by migration key only, with no import file or row. | Point to `import-crosswalk.csv`, or add the import path and row. |

## C. Aesthetic preferences

| ID | Finding |
| --- | --- |
| F-20 | Sentences with a zero count read badly: "0 values were cleared, all under an explicit authorization"; "All 0 source relationships …". |
| F-21 | One header mixes styles: `from_association_key,to_association_key,Association Label`. |
| F-22 | Identifier prefixes mix styles: `F-`, `B-` and `ed_`, `mk_`, `run_`. |
| F-23 | The audit names files without folders; the instructions give full paths. |

## Checked and fine

- **Encoding:** all 125 CSVs are UTF-8 with LF line endings and a final newline, and every row has as many fields as its header.
  Quoting follows RFC 4180.
- **Counts:** every count in `audit.md` and `import-instructions.md` matches `reconciliation.json` and the manifest's row counts.
  The exceptions are the wording in F-02 and F-07.
- **Data-view copies** differ from their import files only by the apostrophe on risky cells. `value_sha256` in `formula-risk.csv` is
  the hash of the exact value.
- **Identifiers:** the configuration hash equals the SHA-256 of `config.normalized.json`. Row identifiers have one format across files.
- **Empty files and JSON:** header-only files are understandable, and the JSON keys are consistent camelCase in a canonical order. No
  JSON restructuring is proposed.

## Not verified

- **Spreadsheets and real imports:** no behaviour in Excel, LibreOffice or Numbers, and no real HubSpot or Salesforce import. F-01 and
  F-03 rest on contradictions inside the package.
- **The core's verifier** was searched, not read in full. The impact on the golden and acceptance tests is inferred.
