# MC 2.0.3 — closure plan for review `mc-203-159f9647c38d`

Codex REJECT of `159f964` for B01 and B02 had 12 BLOCKING and 1 MAJOR finding. There is one row per
case in [`B01-B02-case-map.md`](B01-B02-case-map.md). Every mandate writes its tests first; the case-map
titles are fixed. Mandates branch from `fix/mc-203-review` as `fix/mc-203-m1` … `fix/mc-203-m4` and merge back
in the order M1, M2, M3, M4. New sabotage ids are reserved per mandate so the branches cannot collide:
M1 `M110–M114`, M2 `M115–M119`, M3 `M120–M124`, M4 `M125–M129`.

## Dispositions

| finding | disposition | approach |
|---|---|---|
| B01-R1 unapproved default trim | FIX_IN_MC (M1) | `DEFAULT_FIELD_OPTIONS.trim` becomes `false`. A trim is a per-field plan decision, recorded as `TRANSFORM_WHITESPACE_TRIMMED`. The configuration schema moves to `3.0.0`, so a `2.x` configuration is refused, never read with a new meaning. |
| B01-R2 identity keys trimmed | FIX_IN_MC (M1) | Source ids and authoritative external ids enter identity keys byte-exact. Any identity normalization (trim or NFC) is declared on the key column and recorded as an IdentityDecision. The collisions it creates are listed. |
| B01-R3 digest-only duplicate files | FIX_IN_MC (M2) | Occurrence identity is (declared path, source namespace, entry index), and the digest becomes evidence. Equal bytes in two namespaces are ingested and flagged. Equal bytes in one namespace stop until the plan declares `INDEPENDENT` or `EXCLUDE_ONE`, and that decision is recorded in lineage. |
| B01-R4 absent formula cache → OMIT | FIX_IN_MC (M3) | The reader distinguishes a missing `<v>` from a cached empty string. A missing cache is `UNSUPPORTED` / `TRANSFORM_FORMULA_CACHED_VALUE_ABSENT` under both policies. The stated remedy is a new trusted export or an explicit exclusion. |
| B01-R5 ZIP part aliases | FIX_IN_MC (M2) | Before expansion, refuse non-canonical member names: `\`, `.`/`..` or empty segments, a leading `/`, a drive letter, a control character, or a local and central name that disagree. Then compare OPC part identity (ASCII case-folded, percent-decoded) for duplicates. |
| B01-R6 executable human report | FIX_IN_MC (M3) | `01_IMPORT` stays byte-exact (D7 holds). A new `04_DOCUMENTATION/data-view/` is added: a neutralised copy of each import file that has a risky cell, declared `HUMAN_VIEW_CSV`. `formula-risk.csv` neutralises its value column and adds `value_sha256`. The verifier re-derives the view and refuses any executable cell in a human view. Package format moves to `2.1.0`. |
| B01-R7 quadratic lineage spill | FIX_IN_MC (M4) | A per-row entry carries its own member, the survivor, the merge id and the isolation. The cluster membership is written once, in a record-keyed family that is read with a forward cursor. |
| B01-R8 absorbed ids lost | FIX_IN_MC (M4) | `spillSourceIdTargets` keys each row by its own member's source id, not by `ids[0]`. Every absorbed id therefore indexes the survivor. This follows naturally from the R7 row entry. |
| B01-R9 CMD024 product operation absent | **FIX_IN_PLATFORM_B08** | See the next section. |
| B02-R1 no per-part bound | FIX_IN_MC (M2) | Add `limits.maxWorkbookPartUncompressedBytes`, checked per central-directory entry before expansion, and abort any inflation that exceeds the declared size. The envelope is conjunctive: file ∧ part ∧ total. The denial names the part and suggests a CSV export or splitting the workbook. The default is below the aggregate and derived from the part reader's measured peak (recorded in a decision). |
| B02-R2 no record envelope | FIX_IN_MC (M2) | `maxCellLength` is checked while a field grows. A new `limits.maxRecordBytes` is checked while a record grows. The scanner keeps its state instead of re-reading the unfinished record from its first character. |
| B02-R3 skewed join buckets | FIX_IN_MC (M4) | `coGroup` streams one side and holds the other up to a bound, spilling a larger bucket to scratch. `distinctTargets` becomes an adjacent-unique pass over input sorted by (key, migration key). The edge partition is checked against an independent count. |
| B02-R4 consumer installs local pack (MAJOR) | FIX_IN_MC (M3), run post-publication | `tools/published-asset-check.mjs` downloads the release asset and checks sha256 = the dossier's = a `tools/pack.mjs` reconstruction at the tag. It installs those exact bytes with `consumer-check.mjs` and compares the installed files with the tar entries. |

### B01-R9 — who owns CMD024

`registry/program.json` lists `CMD024-OK/DENY/RACE` under B01, but the command is a PostgreSQL product
operation: `POST /api/v1/plans/{planId}/validate`, `idempotency=REQUIRED`,
`stateCheck=TRANSACTIONAL_EXPECTED_VERSION_WHEN_SUPPLIED_PLUS_STORED_AUTHORITY`. The authority
places that half as follows.

- **B08 — Audit, approval and processing authority** (`22_BUILD_PROGRAM.md` §B08: "Implement durable
  profile/interpret/validate orchestration…"). B08 owns the endpoint, the persisted ValidationReceipt, the
  resource-grant admission, and the null/incomplete/wrong-subject/future/cancelled denials.
- It builds on **B06** (command idempotency, SQL migrations, tenant constraints, and the neighbouring plan
  commands CMD023/CMD025/CMD026) and on **B05** (the shared ValidationReceipt contract).
- **The engine keeps only its pure half** (manual 04 §validatePlan and dryRun: deterministic, with no persistence).
  In M3, `docs/CONTRACT.md` gains §17a. It names the compatible public names manual 04 allows: validatePlan =
  `loadConfig` + `loadSourceProfile`/`assertProfileDescribesBundle` + `assertCandidateSetMatches` +
  `loadTargetContract` + `verifyAttestation`; dryRun = `runMigration` to staging + `verifyPackage`. The same
  section lists the evidence hashes a receipt carries: profile, configuration, contract, attestation, canonical
  package digest (§13b) and `CORE_VERSION`.
- This is a split of registry cases across packages. The re-review must accept `PARTIAL(B08)` for these three
  rows, or the owner re-assigns them in the registry. No platform code is written in this repository.
- **Authority (2026-10-01):** amendment A5 (`authority/r2/amendments/A5_CMD024_SPLIT.md`) adopts the split: each
  CMD024 case has a core half (semantic, through the public MC API) and a B08 half (transactional). The case map records
  CMD024-OK/DENY/RACE as PARTIAL naming B08; they are not EXECUTED until B08 lands its half.

## Contract and decisions touched

- **M1**: CONTRACT §5 (Timestamps: a declared IANA zone with its tzdata version bound into the plan, a DST gap is
  unresolved, an overlap needs `EARLIER`/`LATER`; Numbers: lexical sign and scale are the policy), §5a (a `trim` row,
  off by default), §7 (identity keys are exact; normalization is declared). New decisions D67 (whitespace is a
  value) and D68 (a zone only with its tzdata).
- **M2**: CONTRACT §7 (the bullet "refuses a duplicate file" is replaced by occurrence identity), §15a (workbook
  part identity), §16 (per-part and record envelopes). New decisions D69–D71.
- **M3**: CONTRACT §6 (absent cache), §11b and §15 (the human data view), new §17a (CMD024's engine half).
  D72 amends D7, and D73 covers the published-asset check.
- **M4**: CONTRACT §9 (absorbed ids resolve to the survivor), §16a (membership is written once; hot buckets are
  bounded). New decision D74.
- Versions: configuration schema `3.0.0` (M1) and package format `2.1.0` (M3). `CORE_VERSION` is set once, in
  the release-prep commit before the seal. It is recommended to be `3.0.0`, because the configuration change
  breaks existing configurations. The Intelligence handoff names the change. `2.0.3` was never tagged
  (the last tag is `v2.0.1`).

## Evidence that must be re-produced

Every producer closure fingerprints `src/`, so each mandate moves all seven producers. After M1–M4
and the version commit merge, there is **one** new campaign seal (`tools/seal-campaign.mjs`), and then:

| evidence | why | cost |
|---|---|---|
| Vendor gates HSP-TARGET-01 (target contract 47 checks, import 27 expectations plus the new `I11`, portal 51872453) and SF-TARGET-01 (target contract 11, Data Loader 29 plus the new `A8`, OCR 13, org 00Dak000018tvSeEAI) — all five runners | M1 changes what is delivered (whitespace, configuration schema) and M3 changes the package format. The 2026-09-29 evidence was sealed on the old subject. | ~1 h of agent time. Each run took minutes on 09-29, and sandbox cleanup is verified on read-back. An expired credential goes to Miguel at once. |
| Capacity: the full campaign under the new seal. Matrix P1–P12, founding ×2 per mode, and the new P13 GIANT_CLUSTER and P14 SKEWED_JOIN (`capacityProfilesVersion` 1.2.0) | M2 and M4 change spill families and algorithms, so the 2.0.2 equivalence argument in `EQUIVALENCE_2.0.3.md` is void. The `campaign_covers_this_subject` gate already required the full campaign. | ~12–13 h of host wall clock (the 2.0.2 campaign's 6 h 48 min at the +56 % re-measured on 09-29 ≈ 10 h 40 min, plus about 1.5 h for P13 and P14). It runs unattended with few tokens. |
| S034 cross-OS determinism: the same subject on the Windows host and WSL Linux, with a different TZ and locale | The case requires an exact-subject comparison | ~0.5 h |
| B02-R4 / R2-017 published asset | **Yes, it is a post-publication check.** It downloads the real asset and installs those bytes, with a hidden-byte negative control: a same-version tarball with one byte changed inside a packed file must be refused by the digest comparison before its installation counts. The control also runs pre-publication inside `npm test` against a local fake release (SIMULATED). The real run is EXECUTED after the owner authorizes publication. | ~0.5 h after publication |

Only after this evidence is produced does Codex re-review B01 and B02 against the case map. B02's G-MC-RELEASE closes only with the post-publication record.

## Mandates

Each mandate writes the case-map tests first and sees them fail on `159f964` where a defect exists. It then fixes the
defect, adds its sabotage mutations (each one must be killed), updates the contract sections above, and
flips its case-map rows to `EXECUTED_LOCAL` with the commit. Golden and adversarial expectations are
derived by hand from the input bytes, never regenerated from engine output. No campaign runs inside a mandate.

| mandate | findings | cases it closes |
|---|---|---|
| M1 value and identity exactness | B01-R1, B01-R2 | R2-002, R2-003, R2-004, R2-005, R2-008, S026, S028, S029, R2-009 (live half in the vendor re-run) |
| M2 ingest occurrence identity and input envelopes | B01-R3, B01-R5, B02-R1, B02-R2 | R2-001, R2-011, R2-014, R2-015, S021, S022, R2-012 |
| M3 formula cache, human view, release and evidence checks | B01-R4, B01-R6, B02-R4 | S025, R2-013, R2-010, MC-07 (into `npm test`), S092, S034, R2-017, CMD024 engine half (§17a) |
| M4 merge lineage, absorbed-id endpoints, skewed joins | B01-R7, B01-R8, B02-R3 | S031, S032, R2-016 (P13 and P14 declared) |
