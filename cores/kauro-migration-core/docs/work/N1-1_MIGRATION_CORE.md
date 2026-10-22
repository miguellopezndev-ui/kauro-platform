# N1-1 — Migration Core, consolidated once (Order 13)

Order 13 opened Migration Core once for the functional inventory's core items (`docs/design/FUNCTIONAL-CHANGE-INVENTORY.md`
§C7, the F-entries in `docs/design/ORDER11-FUNCTIONAL-GAPS.md`, both in the platform repository). The owner narrowed the order on
2026-10-22: the core and its own contracts only; no platform, Intelligence Core, payment, retention, legal or screen contract changed
in advance; no reform of the duplicate model or of the import flow because a visual proposal drew one; no vendored package replaced.

Base: platform `main` at `3f6a8d32d32fe7d65888545a9b43960d97f13f53` (PR #118). Result: Migration Core **3.1.0, prepared and tested,
not released** — no tag, no release, no tarball under the platform's `vendor/`. 3.0.0 stays the immutable reference.

## 1. What changed in the core

| # | Defect, as reproduced | Fix | Test written first, failing on 3.0.0 |
|---|---|---|---|
| D78-a | Two leads sharing an email, a phone or a full name were never reported as duplicate candidates: the signals read `contact.*` only, though section 7 makes these supporting evidence for any record and section 0 makes LEAD first-class | The person signals read the record's own family, Contact or Lead; the bucket still carries the object, so a Lead and a Contact never form one cluster. Merges are unchanged (`IDENTITY_RULE_VERSION` 1.0.0) | `test/unit/identity-adversarial.test.ts`, three cases |
| D78-b | HubSpot instructions told the operator to select the association key as the common column. HubSpot accepts only a unique identifier (Record ID, Email, Company domain name, a property requiring unique values), and both object files carry that header with different values | The strategy names the identifiers HubSpot accepts, says the key is not one, says the object files alone create no association, and points to the error file and its association errors | `test/unit/import-instructions.test.ts` |
| D78-c | Salesforce instructions said "use the pairing to populate the lookup field" without saying where a Salesforce Id comes from; none exists in any package file | The strategy says the object files alone create no relationship, and describes the Data Loader step as its source establishes it: the success file's `ID` column, the unmapped association key repeated in it, and that a missing, rejected or repeated key proves no Id | same |
| D78-d | An unsupported relationship's empty file (Salesforce `contact_to_deal.csv`) was described as a pairing beside the supported ones | It is named unsupported, with the adapter's reason and its count in `leftovers.csv`; every supported line carries its own count; "relationships to be created" became "relationships delivered" | same |
| F-31 (core half) | The core never stated `contribution_kind`'s vocabulary or how the manifest's per-sheet counts add up, and the platform's reader guessed both wrong | CONTRACT §1 states both; `spec/contract/contract.json` publishes `contributionKinds` | — (documentation and the generated spec; the reader's fix is the platform's) |

Also: `SOURCE_REGISTRY_VERSION` 2026-10-22 (three sources added, `docs/SOURCE_REGISTRY.md`), `CORE_VERSION` 3.1.0, CONTRACT §1, §7 and
§9, decision D78. Package format 2.1.0, configuration schema 3.0.0, every other contract version and every artifact's columns are
unchanged. `test/unit/identity-adversarial.test.ts` is also the F-27 synthetic adversarial set the inventory asks of the core (role
mailbox, plus-addressing, a Cyrillic look-alike, NFC against NFD, two records equal but for their ids, a chain of three proofs in
either row order, a consent disagreement under `PREFER_SURVIVOR`, cluster ids that survive an unrelated row and move with membership).

## 2. Classification of the items

**Already implemented and tested in 3.0.0** (kept; the new tests pin it):
- The three identity classes kept apart: proven (source record id in one identity space, a declared authoritative external id)
  merged; supporting evidence reported, never merged; a contradiction inside a proven identity isolated, consent never resolved by
  policy (section 7, D1, D20, D26, D51).
- Deterministic, permutation-independent grouping; migration keys from the smallest identity key; cluster ids from signal, value
  and members (section 8, D40).
- The External ID parent lookup on insert, `Account:<field>` in a Data Loader mapping, proved in a real org (`qualification/evidence/
  sf-dataloader.json`, case C1, 2026-10-02). A contact-to-company association through the company's domain, proved in a real
  portal (`hs-import.json`, I7).
- CLEAN without a destination: `CLEAN_ONLY` refuses a target contract and an attestation (`run-migration.ts` `attestationPolicyFor`,
  section 11c), a CLEAN package records no contract hash, and Intelligence Core requires none. **F-01 is entirely the platform's**
  (StartAudit, CreatePlan, ApprovePlan, CreateQuote and `CLEAN_ONLY_TARGET_HASH` in `packages/application`); nothing in the core
  contributes to it.

**Defects reproduced and fixed in the core**: section 1.

**New capabilities that need a platform contract or an owner decision first** (not built; the core half is specified in section 4):

| Item | What the core would add | Waits for |
|---|---|---|
| F-25 batch unification | An operator identity decision as a configuration input: "these records are one" for listed clusters, with the kept record and field rule, recorded as `OPERATOR_DECISION` evidence apart from source proof; "keep apart" recorded too | Owner: definition of a demonstrated identity, kept-record and field rules, batch cap (C1). Contract: the plan read, batch commands and preview hash (C3). Then a configuration schema minor version and an identity rule version |
| F-25 evidence classes | Per cluster, the facts a platform class needs: whether members carry distinct source ids in one namespace, whether the shared value is a role mailbox, consent disagreements. Today they are derivable from `duplicate-candidates.csv` (`conflicts`, `not_merged_reason_code`) and `source-lineage.csv` | Owner policy C1 (what blocks); the plan read (C3). A new column changes the package format |
| F-28 route per object | A declaration that a parent is addressed by an identifier its org already keys on (an idLookup External ID in the attested contract), a child column carrying it, the Data Loader mapping `Account:<field>` | The plan route per object and the import-stage read (C3); Intelligence Core to compile the route |
| F-29 staged reconciliation | A pure function over a verified package and a Data Loader success and error file: one success row per association key proves an Id, everything else is blocked with a reason; the dependent file carries `AccountId` from proved Ids only; fingerprints of every input | The import-stage read and commands (C3), the result-file retention key (C1), size and resubmission caps (C10) |
| F-30 HubSpot error file | A reader of the import's error file that lists each association not made by type (`ASSOCIATION_RECORD_NOT_FOUND`, …) against the package's pairs | The same import-stage contract |

**Outside the sold envelope, not introduced**: OpportunityContactRole (contact-to-opportunity on Salesforce stays `LEFTOVER`, its own
qualification gate `SF-OCR-01`, scope decision first); activities (D54); Salesforce person accounts and lead conversion; fuzzy or
normalised matching as proof (plus-addressing, look-alikes, accents stay supporting evidence at most); any field Kauro asks a CRM to
create.

## 3. The inventory's "to verify" items (C7)

| Question | Answer | How established |
|---|---|---|
| Do Data Loader's result files repeat the unmapped source-key column? | Yes, for the SOAP and Bulk API 1.0 paths: success file `ID`, every input column mapped or not, `STATUS` (`Item Created` / `Item Updated`); error file every input column, `ERROR`; input order, no row number, a row in one file only. Bulk API 2.0 downloads the server's own results and is **not** established | Read in the vendor source, forcedotcom/dataloader v67.0.0: `AbstractAction.openSuccessWriter`, `openErrorWriter`, `AbstractLoadAction.getStatusColumns`, `DAOLoadVisitor`; not run against an org |
| Data Loader's related-object step, as it names it | A mapping `Column=Account:<idLookup field>` (or `Account:Account-<field>`), on insert as well as upsert | Vendor source (`ParentIdLookupFieldFormatter`, insert tests) and the real-org case C1 |
| Does a HubSpot export carry the associated company's record id? | Exports include associated record ids, one column per associated object; the exact header names are **not** established | HubSpot knowledge base "Export records" and the exports API guide |
| Salesforce id prefixes (001 Account, 003 Contact, 006 Opportunity, 00Q Lead) | All four observed on the records the real org created (`sf-dataloader.json`, `created.ids`); the official prefix page answered 403 | Evidence in this repository; not a vendor document |

## 4. Core interfaces proposed for the coordinated intervention (not decided)

Each stays outside 3.1.0 and is written here so the contract work can start from the core's side of it.

- **Identity decisions (F-25).** `identityDecisions: [{ clusterId, decision: "SAME_RECORD" | "KEEP_APART", keep: <row locator>,
  fieldRule: "PREFER_KEPT" | "ISOLATE_ON_CONFLICT", decidedBy, decisionRef }]` in the configuration. Applied after proof and before
  candidates; refused when the cluster id does not match the members the run finds (a stale decision never lands on other records);
  consent fields still isolate; `merges.json` cites `OPERATOR_DECISION` with the decision reference. The cluster id is already stable
  under unrelated rows and changes with membership (pinned by the F-27 suite), which is what a preview hash needs.
- **Stage reconciliation (F-29).** `reconcileSalesforceStage({ packageDir, parentObject, successCsv, errorCsv, limits })` →
  `{ proven: [{ associationKey, salesforceId }], blocked: [{ associationKey, reason: MISSING | REJECTED | DUPLICATE | MALFORMED_ID,
  vendorMessage }], dependentFiles, fingerprints }`, streamed through the scratch store like every other row-scale family
  (section 16a), refusing a file above its row or byte limit.
- **Parent by an existing identifier (F-28).** `associations[].destinationReference: { parentField, sourceColumn }` checked against the
  attested contract (idLookup, unique, createable) and rendered as a child column plus a mapping file.

## 5. Compatibility

- **Configuration and package**: a 3.0.0 configuration loads unchanged, `configHash` and the normalised configuration are unchanged,
  and the files of a package keep their names and columns (the five acceptance packages were regenerated: same configuration
  hashes, same file set). What moves is `coreVersion`, `sourceRegistryVersion`, the run id and therefore every association key
  value (both take the core version), `duplicate-candidates.csv` where leads are duplicated, `import-instructions.md`, and
  `audit.md` (its vendor sources).
- **Intelligence Core 0.6.0** accepts exactly core 3.0.0 (`src/contracts/versions.ts` `SUPPORTED_MIGRATION_CORE`), declares the peer
  dependency `kauro-migration-core: 3.0.0`, and reads `RunResult.truth` in memory, `duplicateCandidates` included. The result of
  building and testing it against 3.1.0 in a scratch copy is in `N1-1_COMPATIBILITY.md`.
- **Platform**: `packages/data-plane/src/cores/migration-core-adapter.ts` (`MIGRATION_CORE_VERSION`), `packages/reports/src/package.ts`
  (`SUPPORTED_CORE_VERSION`), the wrapper's exact dependency, `vendor/MANIFEST.json`, `pnpm-workspace.yaml` and the lock all name
  3.0.0. None is changed here.

## 6. What remains, by owner of the work

| Work | Component | Depends on |
|---|---|---|
| Fix F-31: compare `dataRowCount + rejectedRowCount`, accept `contribution_kind` `NONE` (reproduced against 3.0.0 packages of the A03 and A04 adversarial fixtures; a package with an unmapped sheet's `LEFTOVER` rows is refused the same way) | platform, `packages/reports` | nothing |
| Fix F-32: stop holding every parsed file; stream or bound the reader | platform, `packages/reports`, data-plane worker limits | nothing |
| F-01: StartAudit, CreatePlan, ApprovePlan, CreateQuote without a target contract for CLEAN | platform (C1, C3, C4) | owner's plan-hash rule for CLEAN |
| F-25, F-28, F-29, F-30 contracts | registry and api contract (C3), policy (C1) | owner decisions listed in section 2 |
| The core halves of section 4 | Migration Core, one more coordinated opening | the contracts above |
| Accept 3.1.0 | Intelligence Core (`SUPPORTED_MIGRATION_CORE`, peer dependency, vendored tarball), then the platform pins | the N1 closing integration |
| Release 3.1.0 | Migration Core: tarball, `vendor/MANIFEST.json`, `SHA256SUMS`, lock | Intelligence Core accepting it |
| Integration tests | platform: a CLEAN run through the worker on 3.1.0; the report on a package with rejected rows; Salesforce and HubSpot packages through the reader | all of the above |
