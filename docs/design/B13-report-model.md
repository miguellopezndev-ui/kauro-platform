# B13 — Verified report model: design

Package B13 "Reports and package experience" (program.json: "verified report models, secure HTML/PDF, white label, manifest,
chunk guide, exceptions and lineage presentation"; gate G-REPORT). This document covers the first part, the **report model**
(`packages/reports`, branch `b13/reports-model`). HTML/PDF rendering and the human import guide are the next parts
(`b13/reports-html`, `b13/reports-guide`); the backend commands CMD008 UpdateBranding and CMD039 VerifyPackage are B's.

Authority: registry contracts `ReportSnapshot`, `PackageManifest`, `Artifact`, `RowCounts` (owner 13 and 03); cases R2-069,
R2-070, R2-071, CMD008-*, CMD039-*; B11 cases S069 and S070 (closed PARTIAL by B11, re-run by B13, Q-B11-6); amendments A2..A9.
Nothing here changes a case, a threshold or an evidence class.

## 1. Where it sits

- Layer `application` (`architecture.rules.json`: `@kauro/reports`), one dependency: `@kauro/contracts`. No new runtime
  dependency; hashing is `node:crypto`.
- Pure: `readMigrationPackage(files: Map<path, bytes>)` and `buildReportModel(pkg, facts)` take bytes and facts and return
  values. The worker reads the package from storage, builds the model, renders it and stores the report with its
  `ReportSnapshot`. The web app (layer `web`) can never import this package; it shows what the API serves.
- No state: the model is a function of its inputs, so the failure matrix (FAILURE-MATRIX-TEMPLATE) has no row for it — no
  lock, deadline, commit or retry exists inside it. The stateful halves (persisting a `ReportSnapshot`, CMD008, CMD039,
  the render job) get their rows where they are built.

## 2. Reading a Migration Core 3.0.0 package (CMD039-OK / CMD039-DENY at the model)

Migration Core 3.0.0 writes package format 2.1.0 (`kauro-migration-core` `src/version.ts`, `src/artifacts/layout.ts`):
`manifest.json` plus four areas, `01_IMPORT` (the only files an operator imports), `02_EXCEPTIONS`, `03_TRACEABILITY`,
`04_DOCUMENTATION`. The model refuses the package — listing every problem, with a closed code and the path, never a cell
value — unless all of the following hold:

| check | refusal |
|---|---|
| manifest is the closed 2.1.0 object; `coreVersion` 3.0.0, `manifestVersion` 2.1.0; every string from the core's closed vocabularies: `runId`/`bundleId`/`fileId` identifiers `[A-Za-z0-9_-]{1,64}`, `configHash` hex, `target.mode` ∈ HUBSPOT/SALESFORCE/CLEAN_ONLY, `importMode` ∈ CREATE_ONLY/UPDATE_ONLY/UPSERT, `adapterVersion` x.y.z, `targetContractHash` `tc_`+hex or null | `MANIFEST_MALFORMED`, `UNSUPPORTED_FORMAT` |
| every path portable: ASCII `A-Za-z0-9._-` in `/`-separated segments; no `.`/`..` segment, no segment ending in a dot, no Windows reserved device name (`CON`, `NUL`, `COM1`…) | `UNSAFE_PATH` |
| each path once, and no two paths that differ only in case; each kind re-derived from the path as the core's verifier does (`01_IMPORT/**.csv` machine import, `04_DOCUMENTATION/data-view/**.csv` human view of an import file that exists, every other file by its exact name from the core's `layout.ts`; an unknown name is refused) | `DUPLICATE_PATH`, `AREA_KIND_MISMATCH` |
| closed inventory: every named file present, every present file named | `ARTIFACT_MISSING`, `ARTIFACT_UNDECLARED` |
| length and SHA-256 of every file recomputed | `ARTIFACT_BYTES_MISMATCH` |
| every CSV parsed (strict UTF-8, RFC 4180, header width) and its records counted | `ARTIFACT_UNREADABLE`, `ARTIFACT_ROWS_MISMATCH` |
| reconciliation bound to the manifest (run, bundle, config hash, core version); its equations recomputed, not read from `equationHolds` | `RECONCILIATION_MISMATCH` |
| rows: inputs' data rows = lineage rows = `sourceRows.total`; lineage rows per disposition (and without one) = `byDisposition` (and `withoutDisposition`); `isolated`/`leftovers`/`rejected-input` records = their dispositions | `RECONCILIATION_MISMATCH` |
| records: record import rows = `records.deliveredTotal` = lineage `RECORD/OUTPUT` rows; lineage `RECORD/OUTPUT` per object = `byObject`; every crosswalk row names a record import file and a row of it once, an object that agrees with its migration key (`mk_<object>_…`) and with its surviving lineage row (same object and key, named once), and an association key equal to the import file's own row; crosswalk rows per file = the file's records | `RECONCILIATION_MISMATCH`, `IMPORT_OBJECT_UNKNOWN` |
| relationships: `associations.csv` rows = `sourceEdges` = `relationshipCandidates`, its rows per disposition (and without one) = `byDisposition` (and `withoutDisposition`); `unresolved-associations.csv` records = LEFTOVER + UNRESOLVED; association import rows = `OUTPUT`; association files named `<object>_to_<object>.csv` over the core's objects | `RECONCILIATION_MISMATCH`, `IMPORT_OBJECT_UNKNOWN` |

"Matching manifest sums with wrong data … still fails" (CMD039-DENY) is the reason for the cross-checks: the tests forge a
file and re-declare its length, hash and count in the manifest, and the package is still refused.

The reason-code tally is not cross-checkable against one table and is therefore not read into the model (review ADV-1 R2).
A refusal subject is a safe package path, a manifest pointer or `(unsafe path)`, never a crafted name. The reader returns a
deep-frozen object it registers in a module `WeakSet`; `buildReportModel` refuses any other object (ADV-5).

The package digest is Migration Core's `kauro-package-digest/1` (every file, manifest included, sorted by UTF-16 code unit,
`<path> <sha256>\n` lines under the version line). It names the bytes; it attests to nothing by itself.

## 3. The model

Every number is a `Figure { value, source: { artifact, locator } }`. The renderers print figures and never add, subtract or
recount. `RowCounts` (contract owner 03, "Counters have named denominators and cannot be substituted for one another"):

| RowCounts | source in the package | note |
|---|---|---|
| physicalSourceRows | `reconciliation.json /sourceRows/total` | = Σ inputs' `dataRowCount` = lineage rows |
| logicalSourceRecords | `source-lineage.csv`, rows with `contribution_kind=RECORD` | |
| billableSourceUnits | **not in the package**: the frozen quote (`facts.billableSourceUnits`, source `input:quote`) | R2-065 |
| associationEdges | `/associations/sourceEdges` | |
| emittedRepresentatives | `/sourceRows/byDisposition/OUTPUT` | |
| mergedNonSurvivors | `/sourceRows/byDisposition/MERGED_PROVEN` | |
| rejected | `/sourceRows/byDisposition/REJECTED_INPUT` | |
| withheld | `ISOLATED + LEFTOVER` | |
| unresolved | `/sourceRows/withoutDisposition + /associations/withoutDisposition` | positive refuses the report (`UNRESOLVED_DECISIONS`) |
| emittedArtifactRows | `01_IMPORT`: records of every `MACHINE_IMPORT_CSV`, counted from bytes | |

Row equation the report states: physicalSourceRows = emittedRepresentatives + mergedNonSurvivors + rejected + withheld +
unresolved (true on all five fixtures).

**This mapping is provisional (Q-B13-1)**: the platform's RowCounts producer is B's lane ROWCOUNTS-PRODUCER (sealed-revision
populations and the core's ValidationReceipt counts). When the platform has them it passes them as `facts.declaredCounts`;
any difference refuses the model (`DECLARED_COUNTS_MISMATCH`) and the model says `countsBinding: "BOUND"`. Until then
`declaredCounts` is null and the model says `countsBinding: "UNBOUND"`: the report must say its counts are not yet bound to
the platform's record. `countsBinding` is in the model (so under `modelHash`) and in `VerifiedReport`; it is not added to the
registry `ReportSnapshot`, whose schema is closed (`additionalProperties: false`). The billable-units comparison inside
`declaredCounts` is fact against fact and proves nothing about the package.

Binding to the platform record (ADV-3): `facts.expectedManifestSha256` is required — the manifest SHA-256 the platform
recorded for `packageId` — and a package with another manifest is refused (`PACKAGE_BINDING_MISMATCH`). The manifest names
the hash of every other file, so this binds every byte the model read.

Other sections: delivered records by object; relationships (edges, delivered, leftover, unresolved, deduplicated); every
artifact with its **use** (`IMPORT`, `EXCEPTION`, `TRACEABILITY`, `HUMAN_VIEW`, `DOCUMENT`), hash and verified records
(R2-069: the import bytes and the neutralised `04_DOCUMENTATION/data-view` copy share a file name but never a use or hash);
the import guide (only `01_IMPORT` files, parent objects first in the core's order COMPANY, CONTACT, DEAL, LEAD, numbered
parts in order, then association files, each with its hash and expected records); the exception tables with their complete
record counts (R2-071: the human report may paginate or minimise, the machine evidence stays complete in the package);
reason codes; lineage with the inputs.

Facts the platform supplies (closed object; an unknown key is refused): report and package ids, privacy class, billable
source units and quote id, branding version, display name and logo (a stored PNG/JPEG named by SHA-256, never a URL or SVG),
terms version and **issuer** (legal name, jurisdiction, registration id), finding and material-decision ids, renderer version,
declared counts.

- R2-070: the issuer comes only from the terms facts (`termsVersion`, `termsSha256`, `issuer`); branding has no field that
  could stand in for it. The model records the terms hash but cannot read the terms document, so it cannot show the issuer is
  the one that document states: PARTIAL until the terms snapshot that names the issuer is B's input.
- S069 at the model: brand and issuer text is refused when empty, over length, not NFC, or holding a control (Cc), a format
  character (Cf: bidirectional controls, zero-width characters, U+FEFF), a line/paragraph separator (Zl, Zp) or one of
  `< > " ' & \``. Every other string in the model is from the core's closed vocabularies; the agency's source file names are
  the only free text and are typed `UntrustedText` (`{ untrusted }`). The renderer escapes everything anyway; this is the
  earlier of two fences.
- Privacy class: `AGENCY_SUMMARY` carries no source file name (the agency's own file names are untrusted customer text);
  `SECURE_DETAIL` and `INTERNAL_EVIDENCE` carry them, for the renderer to escape.
- Immutability: `modelHash` = `structuredDigest(DOMAINS.REPORT_MODEL, 1, model)`. The facts are copied before they are
  checked and the model is a deep-frozen copy, so nothing a caller does after hashing changes what is rendered (ADV-5). A new branding version yields a new model and hash; a delivered
  report's model and hash are untouched (CMD008-OK "preserving already delivered artifact identity"; "Report correction must
  not overwrite an old attestation").

## 4. Cases

| case | here | evidence | remaining |
|---|---|---|---|
| CMD039-OK | the five MC 3.0.0 acceptance packages read and match independent oracles | EXECUTED_LOCAL (model) | the command, its record and its RACE: B |
| CMD039-DENY | forged bytes, counts, sums, inventory, paths, kinds, versions refused; every shown figure cross-checked against the evidence tables (ADV-1 R1/R1b/R3 refused) | EXECUTED_LOCAL (model), pending B's re-review | same |
| CMD039-RACE | — | — | B (stateful) |
| R2-065 | three denominators separate, each with its source | EXECUTED_LOCAL (model) | the UI definitions: B11 W7 |
| R2-069 | uses and hashes separate; guide lists only import files; every kind re-derived from its path (ADV-4 R7 refused); guide objects bound to lineage and migration keys | EXECUTED_LOCAL (model), pending B's re-review | HTML guide part |
| R2-070 | issuer from the terms facts only; closed facts; terms hash recorded | PARTIAL (no binding of the issuer to the terms document) | terms snapshot input: B; invoices: B09/B15 |
| R2-071 | complete exception counts kept | PARTIAL | pagination and escaping: HTML part |
| CMD008-OK/DENY | at the model only: new hash per branding version; unsafe logo/name refused | PARTIAL | the command and the stored logo pipeline: B |
| S069 / S070 | brand text fence at the model | PARTIAL | HTML/PDF part (Letter/A4) |

## 5. Questions and requests

- Q-B13-1: confirm the RowCounts mapping of §3 against ROWCOUNTS-PRODUCER; `declaredCounts` enforces whichever wins, and `countsBinding` says when none was given.
- Q-B13-2: done — `DOMAINS.REPORT_MODEL` (B, 1ed5aca); the model calls `structuredDigest`.
- Q-B13-3: a package from a core other than 3.0.0 / format 2.1.0 is refused, not guessed at; a new core version is a new
  reader with its own fixtures.
