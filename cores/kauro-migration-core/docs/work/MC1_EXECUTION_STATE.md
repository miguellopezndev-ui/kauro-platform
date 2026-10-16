# MC-1 EXECUTION STATE

Short, durable ledger for the MC-1 front. It exists so that a lost context can be
recovered from `git log`, the diff and this file, without repeating settled
investigation.

Governing documents, in precedence order:
`KAURO_PRODUCT_CONSTITUTION_V1` > `KAURO_MIGRATION_CORE_CANONICO_V1` >
`KAURO_MIGRATION_CORE_HOJA_DE_RUTA_CIERRE_V1` > handoff > repo spec/docs >
implementation.

---

## Anchor

| fact | value |
| --- | --- |
| repo | `miguellopezndev-ui/kauro-migration-core` (private) |
| `origin/main` at entry | `fab8eb6c55887feabfafd95e9f71cf35df58168d` |
| snapshot in the MC-1 prompt | `fab8eb6c…` — **matches**, no drift |
| branch | `core/mc1-bounded-architecture`, based on the real `origin/main` |
| MC-1 worktree | `C:\dev\kauro-mc1` |
| owner's working tree, left untouched | `C:\dev\kauro-migration-core` (dirty, on `core/bounded-capacity-v1`) |
| entry gate | `npm run gate` PASS on `fab8eb6c…` before any edit |
| tags / releases at entry | `v1.0.0`, `v1.0.1`, `v1.0.2`; no MC-1 PR open |

## The stopped attempt

Branch `core/bounded-capacity-v1`, four commits ahead of `main`
(`1ee4c85`, `c67662d`, `6ffa6c9`, `c1b75ef`) plus four modified files that were
never committed. It was **not** reset, cleaned, stashed or checked out. Both its
committed and uncommitted diffs are preserved as patches outside the repo before
any MC-1 work began.

Direction of that work — spooling the row-scale truth families out of memory and
hashing the package read-back in chunks — is compatible with PARTE XV of the
canonical document. It is being re-derived against the canonical contracts rather
than cherry-picked, because it was written against `RunTruth` as it stands and
MC-1 changes that shape.

| the stopped attempt's work | disposition |
| --- | --- |
| `truth-spool.ts` / `SpooledFamily` over the row-scale families | direction adopted; re-derived under the ScratchStore contract rather than ported as-is |
| streaming package read-back / chunked digest | direction adopted (canonical §54) |
| `capacity-profile.mjs`, heap report tools | kept as diagnostics, not as gate evidence |
| `capacity-allocation-profile.md` | historical measurement, superseded by the bytes-based evidence schema |

---

## Invariants closed on this branch

Each row is closed only when the code, a test that kills the defect, and the gate
all agree. "Test exists" is not "closed".

| # | invariant | state | evidence |
| --- | --- | --- | --- |
| D.1 | `assertReconciliationSound` has no O(N²) path | **CLOSED** | `test/unit/reconcile.test.ts` counts lineage element reads; quadratic shape reads 80,600 for 400 rows, bounded shape reads ≤ 4·N. Verified by re-introducing the scan and watching the test fail. |
| E.1 | `ValueIntent` is explicit and end-to-end | **CLOSED** | `PRESERVE`/`SET`/`CLEAR`/`OMIT` derived once at the transformation chokepoint and carried through draft → merge → destination validation → delivered record → import file → verifier. `test/integration/value-intent.test.ts`, 16 cases. |
| E.2 | `CLEAR`, `OMIT`, blank cell and absent cell are distinct | **CLOSED** | One fixture holds all three source states; the CLEAN_ONLY output shows them as `[KAURO:CLEAR]`, empty and the value. `OMIT` records `SOURCE_CELL_ABSENT` / `SOURCE_CELL_BLANK` / `NO_VALUE_PRODUCED`. |
| E.3 | HubSpot is never handed a blank pretending to clear | **CLOSED** | `clearRepresentation` per adapter; `TARGET_CLEAR_NOT_REPRESENTABLE` isolates on UPDATE_ONLY/UPSERT, allowed on CREATE_ONLY where there is nothing to remove. Salesforce refuses for the same reason until its null representation is declared and qualified. |
| E.4 | The seam cannot silently come back | **CLOSED** | Mutations M72 (clear demoted to omission), M73 (unrepresentable clear shipped as a blank) and M74 (a value that reads as the clear token delivered anyway). |
| C.1 | `ScratchStore` contract at version 1.0.0 | **CLOSED** | `src/scratch/scratch-store.ts`. Run-scoped, single-writer, immutable once sealed, self-describing segments, quota, fail-closed, disposal that reports when it cannot delete. Host-injected: the core names no backend and assumes no `/tmp`. |
| C.2 | A filesystem backend that is safe to run | **CLOSED** | `src/scratch/filesystem-scratch-store.ts`. Root resolved through symlinks and every path contained inside it, run id and schema refused if they could name anywhere else, staging file renamed on seal so no reader sees a partial segment, short writes fatal, read-back verified against the manifest, disposal removes the run directory. |
| D.2 | A deterministic external sort | **CLOSED** | `src/scratch/external-sort.ts`. The order is total — key then input position — so the sorted sequence is unique and spilling cannot change it. Bounded run size, bounded fan-in, spent runs deleted as the merge consumes them. |
| C/D tests | The properties, not the code paths | **CLOSED** | `test/unit/scratch.test.ts`, 25 cases: agreement with a materialised oracle; identical output at run sizes 1, 2, 3, 7, 13, 64, 65, 499, 500 and 100,000 across fan-ins 2–16; a check that it really spilled and really merged more than once; equal keys and prefix keys; tamper, truncation, growth and a missing terminator all refused; quota, hostile run ids and schemas, containment, disposal, deterministic segment names. |
| D.3 | A sort key cannot be confused with its record | **CLOSED** | Found by reading the merge, not by a red test. The merge splits each spilled line at the first tab to recover the key, so a key holding one was split in the wrong place — the key came back truncated and the record came back with the tail of the key glued to its front. Removing the guard and running three records at a run size of one returns a mangled record without raising anything; with a key whose tail happens to parse it would return a well-formed record in the wrong order instead. Source values reach keys and a quoted CSV field may hold a tab, so it was reachable from input. `test/unit/scratch.test.ts`. |
| C/D mutations | The properties cannot regress | **CLOSED** | M75 (sort loses its tie-break), M76 (segment read back unverified), M77 (quota stops being a limit), M78 (a segment declared sorted is trusted rather than checked). 78/78 killed, 0 survived. |
| F.1 | External attestation, verified offline | **CLOSED** | `src/target/attestation.ts`. Key material is injected by the host and never read from the attestation, the contract or the package — the check that makes an attestation external rather than self-issued. Ed25519 over the canonical bytes of everything the attestation asserts, artifacts ordered by path, signature excluded from what it covers. Absent, malformed, unsigned, wrong issuer, unnamed key, wrong instance, wrong contract, uncovered artifact, expired or wrong-nonce all fail closed, and every reason is reported rather than the first. Freshness is judged against an instant passed in, never the clock. 26 cases. |
| F.2 | The run consults the seam | **CLOSED** | `attestationPolicy: 'REQUIRED'` on `RunInput` refuses before a byte of source is read. `test/integration/attested-run.test.ts`, 10 cases, including a run pointed at a non-existent input directory that still fails on the evidence rather than the input. The default is `NOT_REQUIRED`; making it the default for CRM modes is a product change that has to be qualified against real captures first, and is **still owed**. |
| F.3 | The attestation seam cannot regress | **CLOSED** | M79 (a signature that does not verify is accepted), M80 (a run stops consulting the attestation it requires), M81 (an expired attestation is treated as current). |
| registry | Vendor facts revalidated where the work depends on them | **CLOSED** | `SOURCE_REGISTRY_VERSION` 2026-08-29 → 2026-09-02 as the canonical closure requires. HubSpot's blank-cell behaviour revalidated 2026-09-02 against the file-setup page, whose "Blank cells" section states blanks will not clear an existing value. Salesforce's null path revalidated the same day: it runs through a Data Loader setting chosen in the tool, not through anything a CSV can say. Both recorded in `docs/SOURCE_REGISTRY.md` against their sections. |
| G.1 | A package is not readable until it has been published | **CLOSED** | `writePackage` builds into a sibling staging directory and leaves it there; `promotePackage` publishes it in one rename. Until the move the destination holds either nothing or the previous package, and after it a complete one — there is no moment in between, which no amount of care while writing in place can offer. The CLI now runs the canonical order: stage, verify the staging, promote. A package that does not verify never appears at the destination at all. `test/integration/package-delivery.test.ts`, 8 cases. |
| G.2 | The read-back does not need the artifact | **CLOSED** | Canonical §54. Each delivered artifact is confirmed a block at a time against the digest taken as it was written, with a fixed buffer, so confirming a package no longer costs memory proportional to its largest file. The check is unchanged; the transient peak at the end of a run is gone. |
| G.3 | Delivery cannot regress | **CLOSED** | M82 (the package is built where it will be read, so it is live before it is checked) and M83 (a package that was not published is left on disk anyway). 83/83 killed, 0 survived. |
| C.3 | The run writes its truth where it can be read, not where it must be carried | **CLOSED** | All ten row-scale families — lineage, changes, flags, unmapped fields, isolated, leftovers, rejected, edges, delivered records, formula risks — are written as they are produced, sorted externally, and read back a record at a time. They were plain arrays: pushed to for the length of the run, copied to sort, and then held for the whole life of the result while the package was written from them and verified. The gate measures it by executing a run: none is an array, each knows its count, and each yields exactly that many facts on every walk. |
| C.4 | The producers write through rather than return | **CLOSED** | `buildRecords` takes the three cell-scale writers instead of returning arrays, so a changed cell is recorded and released in the same breath. Delivered records, edges and formula risks are written as they are settled rather than collected and sorted afterwards. |
| D.4 | The soundness check builds no index of the dataset | **CLOSED** | Every check is a merge over families already in canonical order. Where a check needs an order a family is not in — edges by the row that produced them, endpoints by the record they name — it spills a compact projection and sorts that, rather than holding a family a second way. The row-scale `Map` of dispositions is gone. |
| D.5 | Row numbers are ordered as numbers | **CLOSED** | `unmapped-fields.csv` was ordered by the row locator as text, so row 10 sorted before row 2 — the exact thing canonical §107 forbids, and invisible until a sheet had ten unmapped rows in it. It is now file, sheet, row, column, with the row number padded so text comparison reproduces numeric comparison. The verifier moved with it. |
| C.5 | The run reads its source in blocks | **CLOSED** | Every input file used to be read whole, decoded whole and kept for the length of the run, alongside a `SourceRow[]` per sheet. `openSourceText` reads a file in blocks and decodes them as they arrive; the decode stays fail-closed, carrying at most the few bytes an encoding needs to finish a character, and every refusal the whole-file decoder makes is made at the byte that causes it. A sheet's rows are an `Iterable` that reads the file when walked, so a sheet can be walked twice without either pass holding the other's rows. `test/unit/csv-incremental.test.ts` states the behaviour rather than the shape: a record completed inside a piece is handed over when that piece arrives, and what survives a piece is the record it was in the middle of. |
| C.6 | The incremental reader was not incremental | **CLOSED** | Found by measuring, not by a red test. `scanChunk` began its loop with an `if (!final)` block that carried the whole chunk and returned, so every block of every non-final read parsed nothing: the carry grew until it held the entire file and the file was parsed once at the end. Scanning a 28 MB artifact took 30.8 seconds instead of 0.29 — the carry was re-copied per block, so the work was quadratic in the file size — and because a `slice` in V8 keeps its source alive, any caller that kept one cell of a scanned file kept the whole file: 60 MB of heap for one twenty-five character row locator. M90 kills the regression. |
| D.6 | Identity is resolved over spilled facts | **CLOSED** | Drafts are written down as they are made — one per source row, each holding every value that row produced — and the rows that describe one record are found by a union-find over spilled keys: every (key, row) pair is read back in key order so rows sharing a key arrive adjacent, then the drafts are re-spilled under the component each landed in and the groups handed out one at a time. What is held is four bytes per row and one group. A resolved record no longer carries the drafts it was built from; it carries what anything downstream asks a member for. |
| D.7 | Records, conflicts and duplicate candidates are joins | **CLOSED** | `validateDestination` streams a record through validation and writes it down. Destination key conflicts are found by writing each record under the key value it carries and reading it back in value order. Duplicate candidates and cross-namespace collisions are grouped the same way, one entry per record per signal it carries. Which record a source row went into is a family walked alongside each sheet with a forward cursor that refuses to go backwards rather than answering wrongly. |
| D.8 | Relationships are resolved without indexes | **CLOSED** | The canonical document names this one directly: candidates and edges are not accumulated globally. An endpoint carries the migration key it points at rather than the record. The rows that hold a key and the records that answer to it are written under that key and read back together, so a key with no record, one record or several is a group of the size that says which. Candidates are written under the order the dispositions are decided in. Deduplication writes every candidate under the relationship it asserts and reads them back in that order: the first in source order delivers it and the rest are deduplicated into it. |
| D.9 | An ordering key cannot hold what the format owns | **CLOSED** | Found by the property tests. A key built from a customer value can contain a newline, a tab or a NUL — a name with a line break in it is a real thing to find in a spreadsheet — and the store refused the segment rather than writing something it could not read back. `orderText` escapes a key part taken from the data, injectively, which is what grouping needs. |
| G.4 | Package format 2.0.0 | **CLOSED** | Four areas, physically separated: `01_IMPORT` is what the operator feeds to the destination, `02_EXCEPTIONS` what did not go and why, `03_TRACEABILITY` what the run did, `04_DOCUMENTATION` what a person reads. `01_IMPORT` holds only columns the importer recognises: the Kauro trace key is gone from it, and where a plan declares relationships the object files carry an import-scoped association key instead. `03_TRACEABILITY/import-crosswalk.csv` is the way back from an import row to its record and its source rows, and the destination never receives it. `04_DOCUMENTATION/import-instructions.md` is generated from the same truth as the artifacts. D59 records the migration of the acceptance goldens; the 1.1.0 packages are in this repository's history at the commit before it. |
| G.5 | The layout cannot drift | **CLOSED** | `test/unit/layout.test.ts` states the area of every artifact independently of the module that places them — `01_IMPORT` is the one directory an operator is told to import, so which side of that line an artifact falls on is a contract and not an implementation detail. M86 (the trace key returns to `01_IMPORT`), M87 (the association key follows from the trace key alone), M88 (an artifact lands at the package root) and M89 (the crosswalk numbers its rows without regard to position). |
| H.1 | The verifier joins rather than indexes | **CLOSED** | `verifyPackage` takes a host-injected `ScratchStore`, like a run does. Artifacts co-sorted with the lineage are walked alongside it through a forward cursor that reports the disorder rather than throwing when an artifact goes backwards — a tampered package is a finding, not an engine defect. Everything else is spilled and merged through `src/verify/join.ts`. The delivered records are spilled once and read back by every check that needs a delivered value. The whole-artifact cache is gone. Verifying the 120,000-row probe package went from 8m47s to 14s and from over 1.5 GB of live heap to 22 MiB. |
| H.2 | An abandoned reader releases its file | **CLOSED** | A generator that is abandoned rather than finished never runs its `finally`, so an artifact read through one keeps its file handle open. On Windows an open handle inside a directory makes the directory unrenamable, and the writer publishes a package by renaming it — so a check that stopped early stopped the run from delivering. `coGroup` closes both sides, and every cursor is closed when the verification ends. |
| B.1 | `SourceProfileV1`, bound by hash | **CLOSED** | A versioned, canonically serialised, hashable description of the bundle, built by the same reader the run uses, over every row rather than a sample. A run given a profile refuses before it interprets anything unless the profile describes the bundle it actually read, and records the profile hash in the truth and in the manifest. Distinct-value counts are exact and bounded: cells are spilled once and distinct and most-repeated are read off the sorted walk. M84 and M85. |
| I.1 | A representative corpus | **CLOSED** | `qualification/capacity/profiles.json` declares P1–P12 across the three modes and the twelve dimensions the canonical document names, with the founding limits in bytes. `tools/capacity-profiles.mjs` generates each one in blocks and computes its expected counts from the parameters rather than reading them back. The gate generates all twelve, migrates each, and compares the rows and relationships that came out against what the profile declared, requiring a package that verifies. |
| I.2 | Evidence in bytes | **CLOSED** | Evidence schema 1.0.0. Source bytes, rows, cells, edges, wall clock, user and system CPU, peak RSS, peak scratch, package bytes, per-stage peaks and throughput, every one of them named for its unit. `maxRSS` is documented by Node in kibibytes and is converted to bytes where it is read, rather than divided by 1024 and called megabytes. The evidence says whether it is a full ladder or a single rung, so a smoke run cannot be read as the founding qualification. |
| units | Byte-exact resource contract | **CLOSED** | `src/domain/resource-profile.ts` states the FOUNDING_V1 limits as integer bytes and gives display helpers that are never used to decide anything. The capacity harness compares peaks against those constants in bytes, and the architecture gate checks that the manifest's limits are the same integers. |
| gate | ARCHITECTURE-01 exists and is derived | **CLOSED** | `tools/architecture-gate.mjs`, wired into CI as its own job. Every fact is obtained by executing or measuring something; none is read from a claim this repository makes about itself. `npm run architecture:self-test` breaks a material invariant, checks the gate notices, checks the closure condition consults the fact that broke, and restores the tree. |

Sections A–J of the MC-1 prompt are closed. This table is the honest record: a
row is here only when the code, a test that kills the defect, and the gate all
agree.

---

## What the gate computes, today

`npm run architecture` — **`MIGRATION_CORE_ARCHITECTURE_CLOSED=TRUE`**. Every
fact is obtained by executing or measuring something; none is read from a claim
this repository makes about itself.

| fact | value | how it was obtained |
| --- | --- | --- |
| `common_source_reader` | true | inspect and run executed over the same bytes; they agree on rows, rejections, columns and file digest |
| `source_profile_v1_bound` | true | a profile is built, hashes the same for the same bytes, is recorded on the run, and a profile describing another bundle is refused before anything is interpreted |
| `run_whole_bundle_retention` | **false** | measured: a 39 MiB source of 249,999 contacts, 2,499 companies and 249,999 relationships migrated in a process limited to a 192 MiB heap, and the finished run holds no decoded source rows |
| `run_truth_arrays_unbounded` | false | all ten row-scale families are spilled: none is an array, each knows its count, and each yields exactly that many facts on every walk |
| `scratch_contract_version` | 1.0.0 | a segment round-tripped with a verified manifest, and the contract reports 1.0.0 |
| `external_sort_join_deterministic` | true | 600 records with 7 distinct keys sorted identically at run sizes 1–5000 and fan-ins 2–16, matching a materialised stable sort |
| `reconciliation_quadratic_path` | false | doubling the rows took the check from 200 to 400 lineage reads — a factor of 2.00, measured |
| `value_intent_end_to_end` | true | an authorized clear, a blank source cell and a held value reach the artifact as three different things |
| `hubspot_blank_clear_is_not_emitted` | true | the record whose clear HubSpot cannot express is set aside, and no blank is shipped for it |
| `target_attestation_verified` | true | a named issuer verifies; an unnamed key, an absent, expired or wrong-instance attestation are each refused; and a run under REQUIRED stops before reading the source |
| `package_format_version` | 2.0.0 | two packages were written and inspected — four areas, nothing else at the root, no Kauro-named column in `01_IMPORT` beyond the association key a declared relationship needs, and a crosswalk accounting for every import row |
| `package_streaming_atomic` | true | the writer leaves the package staged and unpublished, so the host promotes it only after it has been verified |
| `verifier_bounded` | true | measured: a 75 MiB package verified in a process limited to a 96 MiB heap |
| `representative_capacity_harness_ready` | true | all twelve profiles were generated and migrated: twelve dimensions across three modes, each accounting for the rows and relationships its parameters declare, each producing a package that verifies |
| `full_mc2_capacity_qualification` | false | correct — no mode has passing evidence at a million rows, and that belongs to MC-2 |
| `release_candidate` | false | correct — MC-1 must leave it false |
| `implementation_frozen` | false | correct — MC-1 must leave it false |

`npm run architecture:self-test` breaks a material invariant — the sort's
tie-break — checks the gate notices, checks the closure condition consults the
fact that broke, and restores the tree.

### Why ARCHITECTURE-01 is a separate CI job

`npm run gate` asks whether the engine is correct. `npm run architecture` asks
whether MC-1 is finished. Conflating them would destroy the signal in both
directions: a reviewer could not tell a correctness regression from unfinished
work. They stay apart, and neither is softened to a warning anywhere.

---

## What MC-1 measured, and what it did not

Smoke measurements, at CI scale, labelled as such:

| what | measurement |
| --- | --- |
| a run's memory | a 39 MiB source, 252,498 source rows, 249,999 relationships, migrated inside a 192 MiB heap |
| a verification's memory | a 75 MiB package verified inside a 96 MiB heap; live heap peaks at 22 MiB |
| a verification's time | 14 seconds for a 120,000-row package, from 8m47s |
| a scan's time | 0.29 seconds for a 28 MB artifact, from 30.8 |
| the corpus | twelve profiles generated and migrated at 120 rows each; every one reconciles and verifies |

What MC-1 did **not** measure, and does not claim:

- a million rows in any mode. `full_mc2_capacity_qualification` is false and the
  ladder writes `CAPACITY-SMOKE` rather than `CAPACITY-FOUNDING` unless it ran
  the full ladder.
- throughput at scale. The smoke runs at a fraction of the parser rate the
  canonical document quotes as an engineering reference, and optimising it is
  MC-2's, after MC-2 has measured where the time goes.
- any vendor behaviour that was not already in the source registry. No HubSpot or
  Salesforce account was touched.

---

## Next action

MC-1 is closed. What remains is MC-2's, and is recorded here so it is not
rediscovered:

1. **The founding qualification.** A million source rows for each of HUBSPOT,
   SALESFORCE and CLEAN_ONLY, with the complementary profiles covering the
   dimensions the 1M run does not, against the byte budgets in
   `qualification/capacity/profiles.json`.
2. **Vendor qualification.** Real captures, real attestations, and the evidence
   marked historical wherever a schema changed under it.
3. **Attestation policy for the CRM modes.** The seam is built and refuses
   before reading the source; making `REQUIRED` the default for HUBSPOT and
   SALESFORCE is a product change that needs real captures first.
4. **Throughput.** The scan is a hundred times faster than it was and still well
   under the reference rate; where the remaining time goes has not been measured.
5. **Scratch proportionality.** A run spills roughly fifty times the size of its
   source. That is inside the budget by two orders of magnitude, and it is more
   than it needs to be: the drafts and the records are each written twice, once
   in row order and once re-keyed.
