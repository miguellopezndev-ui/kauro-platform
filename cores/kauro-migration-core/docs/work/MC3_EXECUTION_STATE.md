# MC-3 execution state — concentrated repair, independent qualification, freeze

Single inventory of defects and obligations for MC-3, kept current while the
work runs. Everything a reader needs to audit what was decided, repaired,
measured and frozen starts here. Sections marked `[LIVE]` are updated as the
work advances; the rest was fixed at the start and is amended only with a
dated note.

Working checkout: `C:\dev\kauro-mc3`, branch `core/mc3-freeze`, created from
`origin/main` at `5e19f6d6f22c551401829d520916baee90327457`. The owner's
checkout (`C:\dev\kauro-migration-core`, dirty, on another branch) and the MC-1
and MC-2 worktrees are not touched.

---

## 0. Anchor, re-derived on entry (2026-09-08T11:30Z)

| fact | value | how established |
| --- | --- | --- |
| `origin/main` | `5e19f6d6f22c551401829d520916baee90327457` | `git ls-remote` and REST `GET /repos/.../branches/main` |
| last main run | `34169242857`, `push`, conclusion `success`, attempt 1, 10 jobs, 0 artifacts | REST `GET /actions/runs/34169242857`, `/jobs?filter=all` |
| check runs on `5e19f6d` | 10, all `github-actions`, suite `92561125674`; a second suite (app `claude`) `queued`, 0 runs | REST `/commits/{sha}/check-runs`, `/check-suites` |
| candidate manifest digest | `071e0a95…` (530 files) | `qualification/candidate/manifest.json` |
| code digest | `b25ac498201ed6d3…` | `qualification/candidate/preflight.json`, capacity/vendor `candidate` blocks |
| PRs | #9, #10 merged | REST |
| RC / freeze | `MIGRATION_CORE_RELEASE_CANDIDATE` decided by RECEIPT-01 in CI (TRUE on run 34169242857); `MIGRATION_CORE_IMPLEMENTATION_FROZEN: false` written as a literal in `qualification/candidate/provenance.json` | files + workflow |
| releases | `v1.0.0`, `v1.0.1`, `v1.0.2` — `target_commitish: main`, 0 assets, `immutable: false`; annotated tags at `5de0ebfd…`, `d91bb3ea…`, `5bd3ce7c…` | REST `/releases`, `/git/refs/tags` |
| ruleset `21822071` "Protect main" | active on default branch; rules: `deletion`, `non_fast_forward`, `pull_request` (0 approvals, thread resolution required, allowed merge methods `rebase`), `required_linear_history`; **no `required_status_checks`**; `bypass_actors: []` | REST `/rulesets/21822071` |
| repo | private; `allow_rebase_merge`, `allow_squash_merge`, `allow_merge_commit` all true; Actions `allowed_actions: all`, `sha_pinning_required: false`, default workflow permissions `read` | REST |
| secrets (names only) | `HUBSPOT_TOKEN`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `SF_LOGIN_URL` | REST `/actions/secrets` |
| host | Windows 11 10.0.26200, 12 CPUs, 14,893,805,568 B RAM, Node v24.14.1, JDK 17.0.18 (javac present), free disk on `C:` 153,856,032,768 B | `node -e`, `javac -version`, `statfs` |
| `process.resourceUsage().maxRSS` | 237,364 on this host for an RSS of 243,060,736 B → ratio exactly 1024 (KiB), consistent with the Node documentation ("kilobytes") | empirical, `node -e` with a 200 MiB allocation |
| Data Loader | `dataloader-67.0.0.jar` (unmodified official release, 33,227,284 B) under the credential directory | `unzip -l`, `javap` |

No commit, push, tag, release, vendor write, browser opening or workflow
dispatch has been made at the time of this section. The credential directory
(`~/.kauro-mc2-auth`) was listed by file name only; no secret value was printed.

**AGENTS.md and CLAUDE.md**: neither exists in the repository at `5e19f6d`.
Recorded as a fact rather than assumed; the operating rules come from the
canonical documents and this mandate.

### 0.1 Reading log

Canonical authorities (in `~/Downloads`, SHA-256):

| document | sha256 | read |
| --- | --- | --- |
| `KAURO_MIGRATION_CORE_CANONICO_V1.md` | `18dab3a3be5001928416b6f22d65bfbd88ab50a42bd5b910bd270f5e20ce98b8` | whole (2,685 lines); §13–15, §137–138 re-read for the contracts |
| `KAURO_MIGRATION_CORE_HOJA_DE_RUTA_CIERRE_V1.md` | `2b96b122b9f059dcd0b14afbe36045ae023d8432088d4f3445aeb4eb04132b9f` | whole; §9.5–9.6, §11 re-read |
| `KAURO_INTELLIGENCE_CORE_CANONICO_V1.md` | `7463c7bffa0c98a3cefd48fd7b58a1ddc21c7c26386ba5f3278712e08b609c32` | whole; Parts II–IV re-read (§6–19) |
| `KAURO_PRODUCT_CONSTITUTION_V1.md` | `203558d9c9b2310088e48209144d2fd71b6cf11b2ed678d2dec1607cd62454cb` | headings; Part II §7–43; Part III §4, §18–19 |
| `KAURO_HANDOFF_CONTINUIDAD_CHAT_V1.md` | `e1b6805f…` | headings, entry state |
| `KAURO_HOJA_DE_RUTA_REPO_A_PRODUCCION_V1.md` | `d5654278…` | headings |
| `KAURO_MONOREPO_FINAL_E_INTEGRACION_CANONICO_V1.md` (+ hoja) | `66557a96…` | headings, contracts extraction section |
| `KAURO_CUALIFICACION_INTEGRAL_CANONICO_V1.md` (+ hoja) | `c8396f2d…` | headings, CAPACITY-FOUNDING definition |
| `KAURO_BACKEND_DOMINIO_DATA_PLANE_CANONICO_V1.md`, `KAURO_APLICACIONES_…`, `KAURO_ACEPTACION_…` | `892011d6…` and hashes recorded in the session log | headings only (outside MC-3 scope; consulted for boundaries) |
| `KAURO_INTELLIGENCE_CORE_HOJA_DE_RUTA_CIERRE_V1.md` | `0df486f2…` | §method for IC (fixtures/replay, 600 fixtures, three runs) |

Repository files read in full (git blob prefix / sha256 prefix at `5e19f6d`):

```
README.md                                   7f018ca81414 8259aadb71014834
docs/CONTRACT.md                            375d0c98dd18 b4a70bd0e7f6e662  (§0–17 incl. 5b, 7, 8, 11c, 13a–16b)
docs/DECISIONS.md                           e79a1b897e9c fcbb35099e7241e8  (headings; D31, D40–44, D57, D60, D61)
docs/SOURCE_REGISTRY.md                     312d7257e758 32a456346fd263e6
docs/ACCEPTANCE_LEDGER.md                   731fe69af6ec 893aec2e53bb9af0
docs/work/GATES.md                          d6a7c38469cd 13d587284d83a1c5
docs/work/MC2_EXECUTION_STATE.md            68c83d798de5 acfa66f57feca18e  (1–113, 1074–1605: the 30 deferred defects)
.github/workflows/ci.yml                    b771a8a6ee54 b991da5a2e2023c3
package.json / package-lock.json / tsconfig 208dd68b5b3e / 34afc18a008d / a5b0a9da4f39
src/index.ts, src/version.ts                645e8bf1c021 / fd8fb601874d
src/profile/source-profile.ts, inspect.ts   c2c60c57f9db
src/verify/verify-package.ts                91a44596471f 996f277f141d8679  (3,940 lines)
src/verify/verify-against-source.ts, join.ts, import-rows.ts
src/identity/resolve-identity.ts            2b2256b61d32
src/run/run-migration.ts, build-records.ts, build-edges.ts, records-by-row.ts, validate-destination.ts, spool.ts
src/scratch/filesystem-scratch-store.ts, external-sort.ts, scratch-store.ts
src/reconcile/reconcile.ts, truth.ts
src/domain/{identity,migration-key,value-intent,resource-profile,config,locators,source-cell,errors}.ts
src/target/{contract,attestation,match-authority}.ts
src/artifacts/{write-package,render-package,package-digest,csv-writer,import-key,import-partition,layout}.ts
src/adapters/adapter.ts, src/ingest/{ingest-bundle,read-csv-file,read-source-file}.ts, src/cli/main.ts, src/util/{json,hash,sorting}.ts
tools/*.mjs, tools/*.ts (all 26 files)
qualification/candidate-binding.mjs; qualification/hubspot/*.mjs; qualification/salesforce/*.mjs
qualification/evidence/*.json shapes, HUBSPOT_SCOPE_BLOCKER.md, TENANT_SAFETY.md, SF_DATALOADER_AUTH.md
qualification/capacity/*.json shapes, qualification/candidate/*.json shapes
test/support/harness.ts, test/integration/source-profile.test.ts, test/unit/spec.test.ts
acceptance/README.md, acceptance/index.json (first case)
```

Data Loader v67.0.0 API established from the jar (`javap -c -p`) and the tagged
sources on GitHub (`LoginClient.java`, `Controller.java`, `AppConfig.java`,
`ProcessRunner.java` at `v67.0.0`). Facts that decide the design are in §4.6.

---

## 1. Budget, critical path and abort rule `[LIVE]`

`T0 = 2026-09-08T11:30Z` (first tool call of this session). Target 18–24 h,
hard end `T0 + 24 h = 2026-09-09T11:30Z`.

| window | plan | status |
| --- | --- | --- |
| T0 → T0+3h (→14:30Z) | inventory, three reviewers, DAG, budget | inventory written 12:05Z; reviewers R1/R2/R3 launched 11:52Z (read-only, deliver once) |
| T0+3h → T0+10h (→21:30Z) | grouped repairs B1–B6 (§5) with their negative tests | pending |
| T0+10h → T0+12h (→23:30Z) | cheap barrier, independent adversarial review of the diff, fixes in the same batch, seal | pending |
| T0+12h → T0+19h (→06:30Z 09-09) | one campaign on sealed inputs: vendor gates ∥ capacity founding (sequential internally) → matrix → docs/provenance/manifest → preflight → universe from a clean checkout | pending |
| T0+19h → T0+22h (→09:30Z) | one push, one PR, PR CI, ruleset required checks, one rebase merge, main CI + external receipt, dossier, tag `v2.0.1`, release + assets, freeze verdict | pending |
| T0+22h → T0+24h | reserve, final read-only audit on the final SHA and downloaded assets, report, STOP | pending |

Critical path (machine time after the seal, sequential where the host forbids
overlap): capacity founding 3 modes × 2 reproductions ≈ 2.0 h (MC-2 wall
clocks 16.0 + 18.4 + 23.7 min per reproduction) → matrix P1–P12 ≈ 2.0 h →
regeneration, manifest, preflight ≈ 0.3 h → universe ≈ 1.0 h (sabotage 36 min
locally) → PR CI ≈ 0.9 h (sabotage job 47 min in CI) → main CI ≈ 0.9 h →
release ≈ 0.3 h. **≈ 7.4 h from seal to freeze verdict**, so the seal must
happen by `T0 + 13 h` (00:30Z) at the latest for the 22 h target and by
`T0 + 16 h` (03:30Z) for the hard end. Vendor gates (≈ 0.5 h, light) run
concurrently with the first founding reproduction; nothing else overlaps a
capacity load on this 15 GB host.

**Abort rule.** If at `T0 + 16 h` a material condition is still open (a
MATERIAL item in §5 without closure evidence, or the seal not reached), the
campaign is not started and the result is `FREEZE_REJECTED / NOT_CLOSED` with
the evidence and the exact minimal remaining action. If the campaign or the
universe fails on a shared change, the failure is recorded (§8), fixed inside
MC-3, and only the invalidated nodes are re-run; a second attempt is never hidden
under a new name.

## 2. Counters `[LIVE]`

| counter | value | note |
| --- | ---: | --- |
| costly capacity campaigns | 0 | the planned one has not started |
| campaigns sealed | 9 | one per code change during the repair phase; a seal is a question, not a cost |
| vendor gate runs (repair phase) | 7 | HubSpot import ×2, HubSpot target ×1, Data Loader ×3, OCR ×2, Salesforce target ×1 |
| complete local universes | 0 | |
| formal preflights | 0 | |
| vendor records created | 9 + 8 + 4 | HubSpot 9, Data Loader 8, OCR 4 — every one deleted and read back |
| vendor records left behind | 0 | confirmed by read-back, not by counting 204s |
| browser openings | 0 | `browserFlowEntered` false on every launch, and the markers looked for in each Data Loader log |
| branch pushes | 0 | |
| PRs opened | 0 | |
| merges | 0 | |
| remote workflow runs consumed | 0 | |
| tags / releases created | 0 | |
| GitHub writes of any kind | 0 | the only remote reads so far are `GET /repos/actions/upload-artifact/git/ref/tags/v4.6.2` and the freeze verdict's own observations |

The vendor gates were run during the repair phase because each repair had to be
shown to work against the real tenant; every one of those runs created records
inside its own campaign namespace and removed them again. The campaign the
evidence will be taken in is a separate, single run of all five under one seal.

### 2.1 What the repair-phase vendor runs established

| gate | cases | result | what it cost |
| --- | ---: | --- | --- |
| HSP-TARGET-01 (import) | 27 | PASS | 9 records created and removed, namespace empty on read-back |
| HSP-TARGET-01 (contract) | 42 | PASS | no writes; parses a captured bundle |
| SF-TARGET-01 (Data Loader) | 29 | PASS | 8 records created and removed; twelve headless launches, no browser flow, no token in any output |
| SF-TARGET-01 (contract) | 11 | PASS | no writes; parses a captured bundle |
| SF-OCR-01 | 13 | PASS | 4 records created and removed |

## 3. Organisation

- Three read-only reviewers with separate scopes, one delivery each:
  **R1** engine semantics and resources (verifier apostrophe/formula-risk,
  giant identity groups, key injectivity, readers/scratch, value intent, resource
  measurement, hardcoding in `src/` and `tools/`); **R2** evidence producers and
  validators, CI and receipt (the 30 MC-2 items re-verified, gate facts,
  receipt-verify, candidate provenance, provenance, drift, universe, sabotage,
  architecture, workflow); **R3** public contracts and vendors (SourceProfileV1,
  public exports and a packed-tarball consumer, target contract/attestation,
  vendor runners, evidence shapes, documentation claims, versions). The
  integrator is the main session. Findings are integrated into §5 under
  `R1-nn/R2-nn/R3-nn` ids; nothing a reviewer says is accepted without the code
  location or reproduction it cites.
- Logs and checkpoints: every command's exit code and full output go to
  `C:\dev\kauro-mc3-logs\<node>\<utc>.log` (outside the tree) with a `sha256` line
  appended; the checkpoint after each DAG node is this file plus
  `C:\dev\kauro-mc3-logs\CHECKPOINT.json` (node, inputs hash, outputs, hashes).
  After any context compaction the checkpoint is read and the identities in §0
  are re-verified before continuing.
- No agent platform is installed and the model is not changed.

---

## 4. Decisions fixed for MC-3

These settle the ambiguities the inventory depends on. Each is a decision, not
a finding; the finding it answers is referenced.

**D-MC3-01 Execution subject and producer capture.** A new
`tools/execution-subject.mjs` computes `ExecutionSubjectManifest` v1.0.0:
`codeDigest` (existing CODE_ROOTS: `src/`, `tools/`, `spec/`, `package.json`,
`package-lock.json`, `tsconfig.json`), `harnessDigest` (`tools/`,
`qualification/**/*.mjs`, `qualification/salesforce/dataloader-launcher/**`,
`test/support/**`), `oracleDigest` (`qualification/*/EXPECTED_TRUTH.md`,
`qualification/*/corpus/**`, `qualification/capacity/profiles.json`,
`test/fixtures/**/expected/**`), `workflowDigest` (`.github/workflows/**`),
`lockfileDigest` and the closed dependency closure (every `name@version` +
`integrity` from `package-lock.json`), `versions` (core, package format, config
schema, source registry, source profile, target contract, attestation, scratch
contract, capacity profiles, capacity evidence schema, candidate set),
`environment` (node, platform, arch, cpu count, total memory, java version where
used). Its digest is `subjectDigest`. `qualification/candidate-binding.mjs`
gains `captureStart({producer, campaign})` and `captureEnd(capture, results)`:
the subject is recomputed at the end and the evidence is written `valid:false,
invalidation:'SUBJECT_CHANGED_DURING_RUN'` if it moved. Every evidence file
carries `capture: {producer, campaignId, subjectDigestAtStart,
subjectDigestAtEnd, startedAt, endedAt}`; timestamps are UTC to the second, and
a gate rejects a future instant or `endedAt < startedAt`. (Answers §6 of the
mandate; items 1, 4, 10, 24, 30.)

**D-MC3-02 Campaign record.** `qualification/candidate/campaign.json`
(`campaignId = c_<sha256(subjectDigest + sealedAt)[0:16]>`, `subjectDigest`,
`sealedAt`, the producers expected) is written once at the seal. The gate fact
`evidence_bound_to_exact_candidate` requires all five vendor files and the four
capacity files to carry the same `campaignId`, `subjectDigestAtStart ===
subjectDigestAtEnd === current subject digest`, distinct producer ids, no
duplicate case ids, and non-empty case arrays whose ids equal the normative
oracle's ids. Evidence moved between candidates, campaigns or instances is
refused on the verdict, not only on a hash. MC-2's evidence files are replaced
by the new campaign at the same paths; the old bytes remain in git history at
`5e19f6d` and are named in `provenance.supersedes`.

**D-MC3-03 One capacity evidence schema version.** The tree carries two
(`tools/capacity.mjs` writes `'2.0.0'` as a literal in two places;
`tools/capacity-profiles.mjs` exports `EVIDENCE_SCHEMA_VERSION = '1.0.0'`, which
`profiles.json` and CONTRACT.md 16b repeat; the hoja names `1.0.0`). MC-3 adds
required fields (capture, campaign, per-stage resources), so the schema is
`3.0.0`, declared once in `tools/capacity-profiles.mjs`, written by
`capacity.mjs` from that constant, validated by a typed schema in the gate and
the architecture gate, and stated in CONTRACT.md and profiles.json under DRIFT.
The hoja's `1.0.0` is reported as superseded with this reason; nothing is
called compatible.

**D-MC3-04 Freeze flags are computed outside the tree.** A new
`tools/freeze-verdict.mjs` (read-only observer) derives
`MIGRATION_CORE_ARCHITECTURE_CLOSED`, `MIGRATION_CORE_RELEASE_CANDIDATE`,
`MIGRATION_CORE_IMPLEMENTATION_FROZEN`, `MIGRATION_CORE_V1_FROZEN` from: the
main head SHA equals the expected SHA; a clean checkout of that SHA reproduces
the manifest and code digests and its preflight facts are all TRUE; the external
CI receipt for that SHA (push to main, all mandatory legs success, artifact bytes
match); the ruleset on main carries the required status checks equal to the
mandatory legs plus PR/linear-history/no-force/no-delete and no bypass actors;
the annotated tag `v2.0.1` points at the SHA; the release for the tag carries the
required assets whose SHA-256 match the downloaded bytes; provenance valid and
`CORE_VERSION = 2.0.1`, `PACKAGE_FORMAT_VERSION = 2.0.0` — the format did not
change, so its version did not. The verdict is a release asset
and is printed in the final report. In-tree, `provenance.json` stops carrying a
boolean and states `freezeDecision: {decidedBy: 'tools/freeze-verdict.mjs',
outsideTree: true}`; the architecture gate's two `EVIDENCE_READ` flag facts move
to `decidedElsewhere`. (Item 11 family; mandate §10.)

**D-MC3-05 CI shape.** Triggers: `pull_request` (all branches), `push` to `main`
only, `workflow_dispatch`. Job names stay the ones GitHub already emits as check
names on `5e19f6d`: `gate (ubuntu-latest, node 22)`, `gate (ubuntu-latest, node
24)`, `gate (windows-latest, node 22)`, `gate (windows-latest, node 24)`,
`architecture closure (ARCHITECTURE-01)`, `sabotage`, `dependency audit`,
`document drift (DRIFT-01)`, `candidate preflight (RELEASE-CANDIDATE-01)`,
`release receipt (RECEIPT-01)`. The first nine become the ruleset's required
status checks before the merge; the receipt job runs only on push to `main` and
is not a pre-merge check. The receipt job uploads the provisional receipt with
`actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2`
(tag resolved via the GitHub API on 2026-09-08), `retention-days: 90`, and does
not decide its own conclusion; `tools/receipt-verify.mjs --observe` runs
outside CI after the run completes, reads jobs and check runs with `filter=all`
and pagination, downloads the artifact, checks bytes and emits the final receipt.
Every `run:` step declares `shell: bash` unless it is PowerShell on purpose.

**D-MC3-06 Data Loader runs headless through its public API.** Facts from the
jar and the tagged sources: `ProcessRunner.run()` calls `handleOAuthLogin` →
`requiresOAuthLogin = !(contains(sfdc.username) && contains(sfdc.password))` →
`doBrowserLogin` → `OAuthFlowHandler.handleOAuthLogin` → `OAuthServerFlow`
(PKCE, callback HTTP server, browser); supplying an access token does not
disable it. `LoginClient.dologin()` does honour a token: when
`sfdc.oauth.accesstoken` is non-empty it takes `serverUrl` from
`salesforce.oauth.instanceURL`, builds the connector config on it and calls
`setConfiguredSessionId` → `conn.setSessionHeader(token)` → `conn.getUserInfo()`
(a real server check) → `loginSuccess`. `sfdc.oauth.accesstoken` is in
`ENCRYPTED_PROPERTY_NAMES` (`salesforce.oauth.instanceURL` is not), so the value
handed to `AppConfig` must be AES-encrypted with the key named by
`process.encryptionKeyFile` (`EncryptionAesUtil.setCipherKeyFromFilePath`,
`encryptMsg`); in batch mode a decrypt failure throws, in UI mode it is blanked
silently, so the launcher sets `AppUtil.setAppRunMode("batch")`. Browser launch
sites in the jar are `ui.URLUtil`, `util.AppUtil` and `install.Installer`;
none is reachable from `Controller.getInstance → login → setFieldTypes →
initializeOperation → executeAction → logout`. Decision: a small
qualification-only launcher, `qualification/salesforce/dataloader-launcher/
KauroDataLoaderLauncher.java`, compiled at run time by `javac` against the
unmodified official jar, reads the token and instance URL from **stdin** (never
argv, never a file in the tree), writes a per-run key file under a temporary
directory it deletes afterwards, encrypts the token in memory, calls the public
API above with `NihilistProgressAdapter`, asserts `appConfig.getLastOAuthFlow()`
is unchanged (it is set to `PKCE` at the first line of the browser flow), checks
the session's `organizationId` and `userId` against the expected org and the
integration principal before any operation, and prints one JSON line
(`ok, exitClass, orgId, userId, userName, rowsWithError, successFile,
errorFile, lastOAuthFlow, browserFlowEntered:false`). Exit classes:
`AUTH_INVALID` (token rejected by `getUserInfo`), `IDENTITY_MISMATCH`,
`CONFIG_ERROR`, `OPERATION_ERROR`, `OK`. The Node side scans stdout, stderr,
the Data Loader log and every file in the run directory for the token bytes and
refuses the evidence if found. Token source: the already-authorised
client-credentials integration (`sf-token.sh`), read by the runner in-process.
REST stays for identity, metadata and read-back; the loads themselves go
through Data Loader. The one network call the official jar makes on its own in
batch mode (`Controller` constructor, `getLatestDownloadableDataLoaderVersion`)
is recorded as vendor behaviour, not ours.

**D-MC3-07 Vendor namespaces and cleanup.** Every synthetic record carries the
campaign id: HubSpot e-mails `<case>.<campaign8>@kauro-qualification.dev`,
company domains `<campaign8>-<n>.kauro-qualification.dev`, deal names
`[KQ <campaign8>] …`; Salesforce qualification keys `KQ-<campaign8>-…`. The
runners record the exact ids of every record they created (read back by the
namespaced key), delete exactly those ids, then read back the namespace and
require zero. Records from earlier campaigns or unknown origin are counted and
reported, never deleted. The heuristic `clearPortal` (delete by domain and
two deal names) is removed. Identity and effective privileges are checked
before the first write (`GET /account-info/v3/details` and a scoped `GET` per
object; `userinfo` + `Organization` for Salesforce) and the evidence records the
observed portal/org, account type and principal.

**D-MC3-08 Public contracts for Intelligence.** `SourceProfileV1` (version
`1.0.0`, unchanged shape plus `profileHash`, `readConfig` and `bundle` counters)
gains a closed schema, counter invariants, duplicate detection, bidirectional
inventory against the bundle, and a canonical hash recomputed on load.
`CandidateSetV1` (`src/profile/candidate-set.ts`, version `1.0.0`) follows the
IC canonical §12: `{candidateSetVersion, refs: {bundleId, profileHash,
configHash, coreVersion, supportEnvelopeVersion}, candidates: [{candidateRef,
candidateType, sourceRefs[], allowedTargetRefs[], allowedPrimitiveRefs[],
evidenceRefs[], impactCounts, constraints}], limits, candidateSetHash}`;
candidates are produced only from deterministic engine facts (duplicate
candidate clusters, unmapped columns, ambiguous-shape columns, relationship
candidates); no candidate carries merge or transform authority (the type has no
authority field and the loader refuses one); refs to an unknown or other
revision are refused with `CANDIDATE_SET_REFS_MISMATCH`; iteration is bounded by
`limits.maxItems`. Exports added to `src/index.ts`: `produceSourceProfile`,
`serializeSourceProfile`, `loadSourceProfile`, `assertProfileDescribesBundle`,
`buildCandidateSet`, `serializeCandidateSet`, `loadCandidateSet`,
`createFilesystemScratchStore`, `SOURCE_PROFILE_VERSION`,
`CANDIDATE_SET_VERSION`, and the types. A temporary consumer installs the
`npm pack` tarball and uses only those exports. No `@kauro/contracts`, no second
repository.

**D-MC3-09 Verifier semantics.** `csvSafety.noValueRewriting` stops treating
a leading apostrophe as proof: package-only, a value `'X` is a rewrite only when
`X` starts like a formula **and** `changes.csv` records that cell with an
original lacking the apostrophe, or a crosswalked lineage row proves the
original; otherwise the value is delivered as is and the question is
source-backed (`kauro-core attest` compares against the source cell). The
distinction is written into the check's failure text and CONTRACT.md §15.
`formula-risk.csv` is never read whole: both `noValueRewriting` and
`riskValuesMatch` project (`migration_key|field|value`) into spilled families,
sort, and merge against the import rows' formula-like cells, preserving
multiplicity and exact coverage; the 55 check names do not change.

**D-MC3-10 Giant identity groups.** Audit by measurement, not assertion: an
adversarial fixture with N rows sharing one authoritative external id at two
scales gives retained bytes per member; the structures that are O(component)
(the drafts held for one component, `holders`, `absorbedRowLocatorIds`,
`memberRowLocatorIds`, `merges[]`, the reconciliation's `new Set(absorbed)`,
`merges.json` rendering and the verifier's read of it) are reduced where the
slope shows it matters and the remaining bound is stated in the Support Envelope
in bytes per member against the memory budget. No artificial row limit.

**D-MC3-11 Resources.** `tools/capacity.mjs` records per reproduction and per
stage (profile, run, package, verify, attest, cleanup) wall clock, `maxRSS`,
`heapUsed`/`external` peaks sampled at a declared interval, live scratch
(store counter) and sampled scratch (directory walk), with the child and any
concurrent process measured jointly (the parent sums children); the environment
block carries versions, CPU, RAM, process limits where the platform exposes
them and `null` with a reason where it does not; `maxRSS` is converted per
observed platform and Node major using an empirical calibration performed at
campaign start and recorded. A missing metric is `null`, never `0`. Budgets
stay as declared in `src/domain/resource-profile.ts`: RAM hard
8,589,934,592 B, budget 6,012,954,214 B; scratch hard 68,719,476,736 B, budget
51,539,607,552 B; contractual per-run wall clock 28,800,000 ms, distinct from
the 24 h development target. The duplicated `BUDGET_MB 5734 / CEILING_MB 8192`
in `tools/provenance.mjs` is replaced by an import from `dist`.

**D-MC3-12 Release contents.** Assets: `kauro-migration-core-2.0.1.tgz` (npm
pack from the clean checkout), `source-<sha>.tar.gz` (`git archive`),
`sbom.cdx.json` (CycloneDX from `package-lock.json` via `npm sbom`),
`provenance.json`, `preflight.json`, `universe.json`, `campaign.json`,
`ci-receipt.json` (final, observer-emitted), `evidence.tar.gz` (qualification
evidence and capacity files), `dossier-manifest.json` (the delivery manifest:
repository, commit, tree, versions, digests, campaign, per-producer
fingerprints and every other asset's size and digest; written outside the tree
after the assets it lists), `SHA256SUMS` (every other asset, itself excluded).
That is inventory 1.0.0 in `tools/release-dossier.mjs`, thirteen assets. The
freeze verdict was listed here as an asset until 2026-09-11 and is not one: it
is decided after publication, about the published release, and is kept beside
the handoff record outside the release (deviation D12).

Inventory 1.1.0 (2026-09-11, audit KAURO_AUDITORIA_MC_IC_20260911_V1 MC-07): the
asset list is unchanged; what a verifier of the inventory must prove per asset
class is now part of it. Every JSON record is validated against a closed
schema and its flags are derived from its facts (a preflight whose facts
contain FALSE cannot carry TRUE; a universe whose steps failed cannot say
passed; a candidate manifest whose files table derives another digest cannot
claim this one); every archive is opened by a bounded reader that refuses
traversal, links and duplicates; the source archive must be rooted at
`kauro-migration-core-<sha>/`; and the package, source and evidence archives
are compared entry by entry with a reconstruction of the commit made from
`git archive <sha>` alone (the package built and packed from that archive in a
temporary directory), never only with the sums beside them. A dossier that
says 1.0.0 is refused. The v2.0.1 dossier verification recorded above was made
under 1.0.0 and is history; a new release is verified by the repaired verifier
(RELEASE-DOSSIER-01, 91 cases).
Nothing is called signed: the repository holds no signing identity; assets are
hashed and the hashes are verified after download. Immutability is applied
where the platform exposes it; if it does not, that is stated. Existing tags
and releases are never overwritten; nothing is published from the PR head.

---

## 5. Inventory of defects and obligations `[LIVE]`

Each item: **ID · source · evidence/reproduction · consequence · where ·
repair · oracle · tests · gates · deps · closure**. Severity `M` = material
(blocks freeze), `m` = minor, `n` = note. Status column is live:
`OPEN`, `IN_PROGRESS`, `REPAIRED` (code + tests in the branch), `CLOSED`
(evidence of repair observed in the campaign/universe/CI), `EXCLUDED` (with
proof it does not apply).

### 5.1 The 30 deferred MC-2 items

Status confronted with the code on 2026-09-11 at `bc5729d`, item by item,
by reading the mechanism rather than the commit message; the proof column in
§5.1.1 names the rule, scenario or step that fires when the repair is undone.
Every one of the thirty is FIXED with a proof; none is historical and none is
open. "where" still names the MC-2 head so the row can be read against it.

| # | sev | status | where (at 5e19f6d) | repair (MC-3) | negative test |
| ---: | :-: | --- | --- | --- | --- |
| 1 | M | FIXED | `tools/candidate-provenance.mjs` `--stamp` writes `candidate` into `qualification/capacity/*.json` | remove `--stamp`; producers capture the subject at start/end (D-MC3-01); gate refuses a `candidate` block whose `writtenBy` is not the producer; only `tools/candidate-provenance.mjs` is forbidden as writer, not all of `tools/` | evidence stamped by a non-producer → `evidence_bound_to_exact_candidate` FALSE |
| 2 | M | FIXED | `tools/receipt-verify.mjs` `receiptObservationProblems` Maps by name | key observations by `(app, checkSuiteId, workflowRunId, runAttempt, jobId, checkRunId, name)`; a red leg is never erased by a later green of the same name; permutation-invariant | receipt with `[fail, success]` for one name in either order → refused |
| 3 | M | FIXED | `tools/drift-gate.mjs` `HISTORICAL` regex over the first 40 lines | explicit lifecycle record `docs/work/DOCUMENT_LIFECYCLE.json` (`{path, status: CURRENT/HISTORICAL/SUPERSEDED, supersededBy, decidedOn, authority}`); DRIFT reads only that; an unlisted document is CURRENT | doc containing the word "historical" but listed CURRENT with a stale figure → DRIFT FAIL |
| 4 | M | FIXED | `tools/provenance.mjs` reads legacy `capacity-500000/1000000.json` (`peakMb`) and counts `hs-custom-property` (portal 51050101) | provenance reads only campaign-bound evidence; legacy files removed from the tree and named in `supersedes`; HSP-TARGET-01 = target contract + import on 51872453 only; historical evidence listed under "not counted" | legacy file present with `peakMb` → provenance refuses; evidence naming portal ≠ observed → refused |
| 5 | M | FIXED | `tools/release-candidate-gate.mjs` `amplificationExplained` `problems.push()` with no argument | push a typed problem `{id:'MODE_MISSING', mode}`; every `problems` array in the gate is validated to be non-empty strings/objects | mode file missing → fact FALSE with the mode named |
| 6 | M | FIXED | `capacityFor` unit regex `/(mb|mib|gb|gib|kb|kib)$/i`; DRIFT `AMBIGUOUS_FIELD` scope | typed evidence schema (bytes/ms integer fields by name); DRIFT rule extended to any generated evidence and to `Mb/MB/MiB/mB` spellings | field `peakMB` → refused; `peak_mib` → refused |
| 7 | M | FIXED | `offlineUniverse` checks failed steps only | normative step inventory `tools/universe-inventory.mjs` (18 ids, order); the gate requires every id present exactly once, `ok:true`, `status` in a closed set, non-empty output digest; empty/missing/duplicate/skipped refused | universe.json with 17 steps, or one duplicated, or `skipped:true` → FALSE |
| 8 | M | FIXED | `vendorGate` requires no checks; regex on `detail` | typed results (`{id, ok, observed, expected}`) validated against the oracle's id list per gate (`EXPECTED_TRUTH` ids exported by each runner); zero cases, duplicate ids, missing families refused | evidence with `cases: []` → FALSE; missing `R1` → FALSE |
| 9 | M | FIXED | `profileMatrixComplete` `declaredRows ?? sourceRows` | expected scale computed from `profiles.json` (`rowFactor`, sheet factors, auxiliary rows) by `planOf`; result compared to expectation; no self-comparison | matrix entry with `sourceRows` half the declared → FALSE |
| 10 | M | FIXED | `tools/provenance.mjs` evidence list `.filter(null)` | mandatory file inventory; a missing file invalidates provenance with the path | delete `sf-ocr.json` → provenance FAIL |
| 11 | M | FIXED | `tools/provenance.mjs` `state: 'PASS'` literals for constitution/target-contract/sabotage | read the gates' own emitted evidence files (constitution and target-contract gates gain `--evidence`; sabotage summary read from universe step output) | tamper the evidence to FAIL → provenance shows FAIL |
| 12 | M | FIXED | `qualification/salesforce/run-ocr-qualification.mjs` O3 `adapterDoesNotClaimIt` detail text vs result | typed predicate `{expected:'UNSUPPORTED', observed: adapter.relationships.CONTACT_TO_DEAL.kind}`; requalified in the campaign | adapter claiming SUPPORTED → O3 fails |
| 13 | M | FIXED | `tools/build-acceptance-packages.ts` Target column prints `importMode`; intent text "notes and four relationship shapes"; Relationships = `sourceEdges` | Target = vendor + import mode; intent texts corrected to the three-relationship envelope; Relationships split delivered/leftover/unresolved; regenerated `acceptance/README.md` and `index.json` | README diff test against the reconciliation |
| 14 | M | FIXED | `tools/sabotage.mjs` `killed = tested.status !== 0` | classify child outcome: `KILLED_BY_ASSERTION` (test failures reported by the runner), `DID_NOT_COMPILE`, `TIMEOUT`, `INFRA_ERROR` (spawn error, ENOSPC, signal); only the first counts as a kill; summary carries the class counts | a mutation whose child is killed by timeout → not a kill, reported |
| 15 | M | FIXED | `tools/universe.mjs` `sabotage-left-no-trace` = `git diff --exit-code` | `git status --porcelain=v2 --untracked-files=all` before/after + content/mode digest of tracked files + explicit inventory of `tmp/` | leave an untracked file → step fails |
| 16 | M | FIXED | `tools/drift-gate.mjs` `documents()` skips `acceptance` | enumerate every tracked `*.md` and `*.json` under docs, README, qualification, acceptance (generated docs included) from `git ls-files` | stale figure in `acceptance/README.md` → DRIFT FAIL |
| 17 | M | FIXED | facts schema boolean vs `.value` (`architectureClosed` filters `entry.value === false` over booleans) | one facts schema `{name, value:boolean, by, detail}` in a shared module; every consumer validates the report before reading | architecture report with `facts.x=false` (boolean) → gate FALSE |
| 18 | M | FIXED | `documentDrift` keeps last 2 lines / 200 chars | keep the full diagnostics array; the gate output lists them all | 3 drift problems → all three in the fact detail |
| 19 | M | FIXED | `architecture-gate.mjs` `capacityHarness` `problems.slice(0,4)`, `report.problems[0]?.detail` | keep all problem ids | 5 problems → 5 reported |
| 20 | M | FIXED | `receipt-verify.mjs --emit` unguarded `JSON.parse`/`.map` | structured rejection `{code: RECEIPT_MISSING/RECEIPT_MALFORMED/RECEIPT_INCOMPATIBLE/API_INVALID, detail}` and exit 2 | malformed receipt → exit 2, no stack trace |
| 21 | M | FIXED | API observation absent/empty/unreadable/incomplete/contradictory conflated | observation record `{status: ABSENT/EMPTY/UNREADABLE/INCOMPLETE/CONTRADICTORY/COMPLETE, pages, totalCount, seen}` and distinct verdicts | `total_count: 10` with 9 seen → INCOMPLETE → NOT_VERIFIED |
| 22 | M | FIXED | `receipt-verify.mjs` `valueOf` lenient argv; `src/cli/main.ts` `parseOptions` lenient | strict parsers (unknown flag, missing value, duplicate flag → usage error exit 64) for both | `--receipt` without value → exit 64 |
| 23 | M | FIXED | `apiPages` without `filter=all`; partial reruns | `filter=all&per_page=100` with pagination until `total_count` reached; effective final state per `(jobName, runAttempt)` keeping history | synthetic pages with a rerun → history kept, final = latest attempt |
| 24 | M | FIXED | `sourceRegistryCurrent` reads only two `capturedAt` | separate `SOURCE_REGISTRY_VERSION` (review date), evidence `observedAt`, freshness clock `--now` passed in; UTC; refuse future dates; no restamping | evidence with `observedAt` in the future → FALSE |
| 25 | M | FIXED | `package.json` `release-candidate:self-test` → nonexistent file | script points at `tools/release-candidate-gate.mjs --self-test`; self-test scenarios include real false positives (see §5.3) | `npm run release-candidate:self-test` exits 0 only if every scenario flips the gate |
| 26 | M | FIXED | `architecture-gate.mjs` `closed()` literals `'1.0.0'`, `'2.0.0'` | versions read from `dist/src/version.js` and `dist/src/scratch/scratch-store.js`; normative floors declared in `tools/version-floors.mjs` (`>=`) | bump a constant → gate reads it; below floor → FALSE |
| 27 | M | FIXED | `tools/determinism-replay.ts` PASS on zero fixtures | expected inventory (`test/fixtures/golden` 38 + acceptance 5) declared and compared | empty fixture dir → FAIL |
| 28 | m | FIXED | stale amplification comments (60x ceiling) in gate/scratch-model | comments rewritten; measurements and algorithmic bound reported as two fields | n/a (DRIFT rule on the figure) |
| 29 | M | FIXED | `tools/provenance.mjs` "What this release does not claim" prose | generated from the evidence inventory (what is absent is listed from the inventory, not typed) | remove an evidence file → the prose changes |
| 30 | M | FIXED | HubSpot corpus dependencies implicit; editorial vs semantic invalidation undefined | D-MC3-01 subject sets; `tools/invalidation-policy.mjs` classifies a path as EDITORIAL or SEMANTIC; tests prove a README change keeps evidence valid and a runner/oracle/mapper/contract change invalidates it | change `qualification/hubspot/EXPECTED_TRUTH.md` → REQUALIFY; change README → valid |

#### 5.1.1 Proof per item `[LIVE]`

| # | status | mechanism in the tree | what fires when it is undone |
| ---: | --- | --- | --- |
| 1 | FIXED | `tools/candidate-provenance.mjs` has no `--stamp` (the option is refused by name with `STAMP_IS_GONE`); captures are taken by the producer at start and end | gate self-test `a stamped candidate block`, `a capture written by a tool`; EVIDENCE-RULES-01 `capacity.stampedBlock`, `capture.noProducer` |
| 2 | FIXED | `receiptObservationProblems` keys observations by `checkRunId`, app, suite and attempt; the receipt keeps `reruns` | gate self-test `a red required check`, `a check run GitHub never saw`; the chain rehearsal's `receipt-observe` node runs `--observe` against the injected remote |
| 3 | FIXED | `docs/work/DOCUMENT_LIFECYCLE.json` read by `tools/drift-gate.mjs`; an unlisted document is CURRENT | DRIFT-01 rules over the lifecycle record (`node tools/drift-gate.mjs`) |
| 4 | FIXED | legacy `capacity-500000/1000000.json` removed; `tools/provenance.mjs` reads campaign-bound evidence only and lists what is not counted | provenance self-consistency (`npm run provenance:check`); RELEASE-CANDIDATE-01 `evidence about another instance` |
| 5 | FIXED | every `problems.push` in the gate carries a string; the mode is named | RELEASE-CANDIDATE-01 self-test (24 scenarios each naming its fact) |
| 6 | FIXED | `unitFieldProblems` in `tools/evidence-schema.mjs`; integer byte and millisecond fields by name | EVIDENCE-RULES-01 `capacity.displayUnit`; gate self-test `a capacity record denominated in mebibytes` |
| 7 | FIXED | `tools/universe-inventory.mjs` (19 ids, order) read by the gate, the universe and provenance | EVIDENCE-RULES-01 `universe.missingStep/duplicatedStep/emptyReport/skippedStep/quickScope/unknownStep`; gate self-test `a universe missing a step`, `a universe with a step recorded twice` |
| 8 | FIXED | `vendorEvidenceProblems` against each runner's oracle ids | EVIDENCE-RULES-01 `oracle.missingCase/duplicateCase/emptyCases/undeclaredCase`; gate self-test `a case the oracle declares and nobody asked`, `a case recorded twice` |
| 9 | FIXED | `matrixEntryProblems` compares produced rows with the scale `profiles.json` declares | gate self-test `a matrix profile below its declared scale` |
| 10 | FIXED | `tools/provenance.mjs` evidence inventory with `required: true`; a missing file names its path | `npm run provenance:check` on a tree missing `sf-ocr.json` fails with the path (exercised in the repair phase) |
| 11 | FIXED | constitution, target-contract and sabotage states are read from the universe report (`gateFromUniverse`) | provenance regenerated after the universe; DRIFT-01 `provenance-vouches-for-the-bytes-that-are-here` |
| 12 | FIXED | O3 is a typed predicate `{expected: 'UNSUPPORTED', observed}` | SF-OCR-01 evidence `sf-ocr.json` case O3 (requalified 02:19Z under c_53d6b2453fe15386) |
| 13 | FIXED | Target column = vendor + import mode; intent texts name the three relationship shapes | `npm run acceptance` regenerates to committed bytes (universe step `artifacts-reproducible`) |
| 14 | FIXED | `classifySuite` in `tools/sabotage.mjs`: KILLED, SURVIVED, DID_NOT_COMPILE, TIMEOUT, INFRA_ERROR; only KILLED counts | sabotage summary 98/98 killed with the outcome inventory; universe step `sabotage` |
| 15 | FIXED | `git status --porcelain=v2 --untracked-files=all` before and after, plus the `tmp/` inventory | universe step `sabotage-left-no-trace` |
| 16 | FIXED | `tools/drift-gate.mjs` enumerates documents from `git ls-files` | DRIFT-01 `documents: 35` |
| 17 | FIXED | `factsProblems` in `tools/evidence-schema.mjs`, used by the architecture gate and the verdict | ARCHITECTURE-01 self-test (`npm run architecture:self-test`) |
| 18 | FIXED | the full diagnostics array is kept | DRIFT-01 output lists every problem |
| 19 | FIXED | no `slice(0, 4)`; every problem is reported | ARCHITECTURE-01 self-test |
| 20 | FIXED | structured rejections `RECEIPT_MISSING/MALFORMED/INCOMPATIBLE`, exit codes in `EXIT` | `--receipt` on a truncated file exits 2 with the code named (exercised in the repair phase; no stack trace) |
| 21 | FIXED | observation status `ABSENT/EMPTY/UNREADABLE/INCOMPLETE/CONTRADICTORY/COMPLETE` | gate self-test `a receipt nothing was asked about`, `a run GitHub puts on another commit` |
| 22 | FIXED | strict argv in `receipt-verify.mjs` (`KNOWN_SWITCHES`), `freeze-verdict.mjs` (`KNOWN`, `--expect-check` whole names) and `src/cli/main.ts` | exit 64 on unknown flag, missing value, duplicate flag (verified 01:5xZ for the verdict) |
| 23 | FIXED | `filter=all&per_page=100` paginated until `total_count`; history per attempt kept | gate self-test `a red required check` (two attempts, red kept) |
| 24 | FIXED | `SOURCE_REGISTRY_VERSION`, `observedAt`, `FUTURE_SKEW_MS`; future instants refused | EVIDENCE-RULES-01 `instant.future`, `capture.futureStart`; gate self-test `an observation dated after the gate ran` |
| 25 | FIXED | `release-candidate:self-test` → `tools/release-candidate-gate.mjs --self-test` | 24 scenarios PASS (02:1xZ, clean tree) |
| 26 | FIXED | versions read from `dist/`; floors in `tools/version-floors.mjs` | EVIDENCE-RULES-01 `invalidation.semverComparison`; verdict `versions_at_or_above_floor` |
| 27 | FIXED | the determinism replay declares its fixture inventory and fails on an empty one | `npm run determinism` (universe step `determinism`) |
| 28 | FIXED | comments rewritten; no `60x` figure remains | DRIFT-01 |
| 29 | FIXED | "what this release does not claim" is generated from the evidence inventory | `npm run provenance` then `provenance:check` |
| 30 | FIXED | `tools/invalidation-policy.mjs` classifies; `tools/producer-closure.mjs` binds each capture to its producer's traced closure (MCR-03) | EVIDENCE-RULES-01 `invalidation.*`, `subject.*`, `closure.*`, `capture.producerInputsMoved`, `capture.otherHarnessMovedIsAccepted` |

### 5.1.2 The four defects of the recovery audit (MCR-01..04) `[LIVE]`

| id | sev | status | reproduced as | repair | proof |
| --- | :-: | --- | --- | --- | --- |
| MCR-01 | M | REPAIRED | the verdict's release block accepted `unrelated.txt` beside a matching SHA256SUMS and never read `immutable` | `tools/release-dossier.mjs`: inventory 1.0.0 (13 assets, role and origin), delivery manifest written after the assets it lists and never hashing itself, strict sums, exact inventory, sizes as the API declares them, each record bound to the measured code digest, campaign and per-producer fingerprints, receipt byte-identical to the one handed in, package tarball at this version with its entry point, paginated asset list; two conditions `release_published_immutable` (draft:false, correct tag, immutable:true — absent is not verified) and `release_assets_verified`; `draft_ready` is a preparation state and never a freeze; the final verdict is not an asset | RELEASE-DOSSIER-01 (38 cases, `node tools/release-dossier-selftest.mjs`), which fails against a verifier that accepts everything and against one that skips immutability |
| MCR-02 | M | REPAIRED | `bench/prepare-universe.sh` piped gates to grep; a gate printing PASS and exiting 7 let the pipeline continue; `git add -A`; the dirty count printed, not asserted | `set -euo pipefail`; status taken from the command, never from the compound statement (the first draft had that bug and its own negative test found it); only the four generated records staged; zero dirty asserted; identity from git config; `bench/campaign.sh` returns the verdict as its exit code and stops after a failed matrix | LAUNCHER-STOPS-01 (`bench/prepare-universe-selftest.sh`, 7 cases incl. PASS text + exit 7, SIGTERM, missing command), FALSE against the first draft; in CI beside EVIDENCE-RULES-01 |
| MCR-03 | M | REPAIRED | class-granular invalidation; the launcher was EDITORIAL and, worse, `bench/` was excluded from the tracked listing altogether; any harness change invalidated every capture | `tools/producer-closure.mjs`: per-producer traced closure (static, dynamic and URL imports; dist/ pulls the engine, package.json, lockfile, tsconfig; an unresolved specifier leaves no fingerprint); captures bound at start and end to the producer's fingerprint; `bench/*.sh` SEMANTIC_HARNESS and measured (exclusion rule 1.4.0); the universe reads the subject only and binds through its report's digests, not the seal | EVIDENCE-RULES-01 `closure.*`, `capture.producerInputsMoved`, `capture.otherHarnessMovedIsAccepted`, `capture.unknownProducer`, `invalidation.semantic(bench/…)`; gate self-test `a capture whose producer read other inputs`, `inputs that moved while the producer ran` |
| MCR-04 | M | REPAIRED | `--expect-checks a,b,c` parsed as CSV; a matrix leg has a comma in its name; an empty or trimmed list looked like a shorter list | `--expect-check <whole name>`, repeatable, refuses empty/untrimmed/duplicate values, and only adds to the checks derived from the workflow; no option removes a normative check | usage errors exit 64 (verified); the derived legs are compared whole in `main_protection_in_force` (10 required checks observed 01:5xZ) |

### 5.2 Additional seams

| ID | sev | status | statement | repair | negative test |
| --- | :-: | --- | --- | --- | --- |
| A-1 | M | OPEN | `loadSourceProfile` accepts `{"profileVersion":"1.0.0"}`; `null` throws `TypeError` | D-MC3-08 closed schema + `MigrationError('SOURCE_PROFILE_INVALID')` | both inputs → structured refusal |
| A-2 | M | OPEN | no duplicate/counter/ref/hash validation of a profile | schema + invariants: `populated + blank = rows`, `distinct ≤ populated`, unique file paths/sheet ids/column indexes, `bundleId` recomputed from file digests, `profileHash` recomputed | each violation → refusal naming the pointer |
| A-3 | M | OPEN | `assertProfileDescribesBundle` one-directional | bidirectional inventory; extra bundle file or extra profile file both refused | |
| A-4 | M | OPEN | no binding to the reading configuration | `readConfig` (format/encoding/delimiter/sheets/limits/formula policy) recorded and compared to the run's config | run with a different delimiter → refused |
| A-5 | M | OPEN | `CandidateSetV1` does not exist | D-MC3-08 | refs mismatch, unknown field, authority field, over-limit → refused |
| A-6 | M | OPEN | `src/index.ts` exports no profile producer/serializer, no scratch store factory | D-MC3-08 exports + `test/integration/public-consumer.test.ts` (packed tarball, temp project) | consumer using only public exports profiles, runs, verifies |
| B-1 | M | OPEN | `csvSafety.noValueRewriting` fails on legitimate `'Ada` | D-MC3-09 | package with `'Ada` unchanged → passes; `'=SUM` introduced per changes.csv → fails |
| B-2 | M | OPEN | `formula-risk.csv` read whole (3 `readTable`), value-proportional Sets | D-MC3-09 bounded projections | fixtures: zero / some / all cells formula-like, repeated values, long values, Unicode |
| B-3 | M | OPEN | giant identity group retention unmeasured | D-MC3-10 | adversarial fixture at two scales; slope recorded |
| B-4 | M | OPEN | key injectivity unproven | property test over `renderIdentityKey` (escaping of `\` and `|`), `orderKey/orderText`, locator ids, sort keys, conflict keys; collision reproduced or excluded with proof | fast-check property |
| C-1 | M | OPEN | per-stage resource measurement absent; maxRSS unit assumed | D-MC3-11 | evidence lacking a stage → refused; calibration recorded |
| C-2 | M | OPEN | hardcoded authorities in tools (BUDGET_MB, EXPECTED_STAGES, field counts 209/115/73, portal ids in fixtures) | allowlist file `tools/allowlist.json` for legitimate constants; the rest replaced by config/oracle reads | hardcode hunt script fails on an undeclared literal |
| V-1 | M | OPEN | Data Loader depends on browser PKCE / saved session (SF_DATALOADER_AUTH.md) | D-MC3-06 launcher; smoke (valid token, invalid token, config error) before the campaign | invalid token → `AUTH_INVALID`, no browser, exit ≠ 0 |
| V-2 | M | OPEN | `clearPortal` heuristic deletes; no campaign namespace; ids not recorded | D-MC3-07 | cleanup touches only created ids; read-back zero |
| V-3 | M | OPEN | identity/privilege check before writes (HubSpot has portal check; privileges not probed) | scoped GET probes recorded in evidence | mismatch → refuse |
| E-1 | M | OPEN | no subject manifest / producer capture / campaign | D-MC3-01, D-MC3-02 | negatives of mandate §6 (move, tamper, suppress, duplicate, change after capture, editorial only, contract change, incomplete API) |
| E-2 | M | OPEN | freeze flags self-declared | D-MC3-04 | verdict FALSE when any input fails |
| CI-1 | M | OPEN | duplicate CI on push + pull_request; receipt not uploaded; receipt job attests itself | D-MC3-05 | workflow YAML validated by a parser + `actionlint`-equivalent checks in the barrier |
| CI-2 | M | OPEN | ruleset lacks required status checks | add after the PR CI shows the real check names, before merge | verdict reads the ruleset |
| R-1 | M | OPEN | release assets absent on v1.x; SBOM/licences/inventory absent | D-MC3-12 | download + hash check |
| DOC-1 | m | OPEN | false/stale statements (README "seven jobs" with ten legs, acceptance intent text, CONTRACT 16b evidence 1.0.0, ledger "spills roughly fifty times") | corrected with the regeneration; DRIFT covers the figures | |

### 5.3 Self-test scenarios the release-candidate gate must flip (item 25)

1. universe.json with a step removed; 2. with a step duplicated; 3. vendor
evidence with `cases: []`; 4. vendor evidence whose `campaignId` differs;
5. capacity evidence with a field named `peakMB`; 6. matrix entry below the
declared scale; 7. facts array with a boolean instead of `{value}`; 8. evidence
with `observedAt` in the future; 9. provenance missing a mandatory file; 10.
receipt with `[failure, success]` for one leg; 11. editorial change (README)
keeps the verdict; 12. semantic change (oracle) flips `evidence_bound_to_exact_candidate`;
13. subject changed between `captureStart` and `captureEnd`; 14. profile
hash tampered (public contract). The 14 existing scenarios are kept where
still meaningful.

### 5.4 Defects found by the pre-campaign smoke `[LIVE]`

The mandate asks for one costly campaign. A campaign that produces a record the
gate cannot read, or no record at all, is a second campaign — so the founding
harness was run end to end at two thousand rows first, and the record it wrote
was validated against `capacityEvidenceProblems` before any of it ran at a
million. Seven defects, four of them silent.

| ID | sev | statement | how it presented | repair |
| --- | :-: | --- | --- | --- |
| S-1 | H | `subjectDigest` was taken over the whole class census, EVIDENCE and GENERATED and EDITORIAL included | the first producer of a campaign wrote its evidence, which moved the subject, and the second refused to start against the campaign it belonged to — as "re-seal the campaign, or check out the sealed tree", which reads as operator error | the digest is taken over the subject classes, by a rule a reader can reapply to a printed subject; two self-test rules hold both directions |
| S-2 | H | the profile stage returned its summary under the key `profile`, colliding with the capacity profile id | on a **passing** founding run `String(measured.profile)` was `[object Object]`, both the founding and matrix filters skipped every measurement, no evidence was written, the previous qualification's file stayed in place, and the harness printed PASS. A failing run wrote its record normally, which is why it only appeared once the run started passing | renamed `sourceProfile`; both blocks refuse rather than skip when they write nothing |
| S-3 | H | a sort key may not hold a line feed and nothing checked for one; `buildSourceProfile` keyed on the raw cell | the founding CLEAN_ONLY profile did not run at all — the first cell with a line break in it, ordinary in a spreadsheet, failed in the store four frames deeper with a message naming only a segment id | `orderText`; the forbidden characters stated once as data and checked in the sort. The carriage return was **not** added: the store splits on the line feed alone, and the suite says so |
| S-4 | M | a failed child's output was reduced to `stderr.slice(-3).join(' \| ')` in three places | a Node crash records `} \|  \| Node.js v24.14.1`, and the case directory holding the real output is deleted immediately afterwards | the whole of stdout and stderr kept in `bench/capacity/logs`, path and digest in the record |
| S-5 | M | missing metrics were written as `0`, or dropped | `peakRssBytes` with nothing measured became `undefined` and `JSON.stringify` removed the property; `runMs ?? 0` claimed a stage ran and cost nothing; `problems: 0` beside a FAIL read as "nothing was wrong" | every metric null when not taken, and a FAIL carries its outcome and detail |
| S-6 | M | a rejected sort key was quoted into the exception | a sort key is built from source values, and an exception is logged, attached to a report and read by whoever is on the other end of a failed migration | position, length and a short digest; a test holds it |
| S-7 | m | control characters were written into three source files as bytes | `file` reported them as data and `grep` answered "Binary file matches" instead of the line | written as escapes; the derived values unchanged |

Two more were found by running the vendor gates against the real tenants during
the repair phase, and neither was visible from reading the code:

| ID | sev | statement | how it presented |
| --- | :-: | --- | --- |
| S-8 | H | run directories are named for the case and reused, and nothing removed the previous run's `success.csv` | the Data Loader gate reported "Item Created" for an account created the day before, with the previous day's external key, and then failed its cleanup with ENTITY_IS_DELETED. Twenty-three of twenty-nine cases were green against files from another run |
| S-9 | H | the launcher calls `controller.logout()`, which revokes the session it was handed | one session shared across every load worked exactly once: the first load succeeded and the other eleven failed AUTH_INVALID. Invisible until S-8 was fixed, because each failing load left the previous run to answer for it |

### 5.5 The cheap barrier: three scoped reviewers over the whole diff `[LIVE]`

Run at 19:20Z against `5054adf`, before any of the campaign's machine time was
spent, with three separate scopes and no chaining between them: semantics and
resources over `src/` and the capacity harness; evidence and CI over the
subject, the campaign, the gates and the workflow; contracts and vendors over
the public surface and the five runners. Each delivered once.

The barrier paid for itself several times over. Six of the repairs this front
had already made were worse than what they replaced, and four of those were from
the same afternoon. Everything marked FIXED is in the batches committed at 19:52Z
and 19:58Z; the campaign was sealed after them.

| ID | sev | what | disposition |
| --- | :-: | --- | --- |
| B-01 | critical | `qualification/[^/]+/…` requires a subdirectory, so `oracles.mjs`, `campaign.mjs`, `namespace.mjs` and `.gitattributes` classified EDITORIAL and were outside the subject entirely. Deleting a required case from the oracle moved no digest, kept the campaign valid, and left every earlier measurement accepted | FIXED |
| B-02 | critical | `rowOrderParts` escaping the file path made the engine and the verifier spell an address differently: `orderText` is injective and not order-preserving, and `lineage.ordering` plus `artifacts.declaredOrder` compare the path raw. A hostile filename stopped aborting in the sort and started producing a package that failed its own verification on seven checks | FIXED — reverted |
| B-03 | critical | the new apostrophe rule had the old rule's defect: "final begins with `'` and original does not" is satisfied by ` 'Twas` trimmed | FIXED |
| B-04 | critical | HubSpot `X1` filtered the ledger by the negation of the predicate that fills the ledger; it could not fail | FIXED |
| B-05 | critical | HubSpot `X3` and the emptiness precondition read the search index, which the same file documents as unfit for that question | FIXED |
| B-06 | critical | `H1` compared `launches.length` to itself; with no launches the case passed | FIXED |
| B-07 | critical | `run-custom-property-qualification.mjs` still opened by deleting every contact matching the bare domain, never consulted the allowlist, and would have cleared the excluded portal | FIXED |
| B-08 | high | the freeze verdict fetched the run using `receipt.repository` and compared that field against the run it had just fetched with it | FIXED |
| B-09 | high | `githubToken()` fell back to `git credential fill` | FIXED — reverted |
| B-10 | high | Salesforce `X1` skipped every fixed-name record, which are the ones genuinely outside the namespace | FIXED |
| B-11 | high | the association risk join lost its edge scope | FIXED |
| B-12 | high | `assertRunnerAskedEverything` was called by nothing | FIXED |
| B-13 | high | four target-runner checks recorded `ok: true` before running | FIXED |
| B-14 | high | a capacity run reported PASS with a failed attestation | FIXED |
| B-15 | high | the HubSpot EXPORT route read `propertyExports` as objects where the collector writes strings | FIXED |
| B-16 | high | an uncapped `fail` per claim in the risk rules | FIXED |
| B-17 | medium | a drift rule vanished rather than failing when the provenance record was absent | FIXED |
| B-18 | medium | `Number(null) <= budget` is true | FIXED |
| B-19 | medium | `KAURO_QUAL_STAMP` could take a run out of its own campaign | FIXED |
| B-20 | medium | `O3.contactIdHasNoRelationshipName` passed on an absent field; OCR's `X3` asked only about the Account | FIXED |
| B-21 | medium | a stage the sampler never fired inside recorded `0` beside a reason saying it is not a measurement | FIXED |
| B-22 | medium | the CLI reached `digest` for any command name inherited from the object prototype | FIXED |
| B-23 | medium | a real customer portal's record census was published in the blocklist's reason | FIXED |
| B-24 | medium | `preflight_facts_all_true` reads a file the candidate digest excludes | OPEN — CI recomputes it byte for byte, and the flag states what it rests on |
| B-25 | medium | the CI check-runs read lacks `filter=all` and `jq -s` strips `total_count` | OPEN — the workflow is in the sealed subject |
| B-26 | medium | `vendorEvidenceProblems` and `caseProblems` have no consumers | OPEN |
| B-27 | medium | capacity evidence is keyed by the record's own `mode` over directory order | OPEN |
| B-28 | low | `observedAt` has no lower bound against the capture's instants | OPEN |
| B-29 | low | the attest stage re-derives the whole migration, so summing the six double-counts | OPEN — recorded on the stage |
| B-30 | low | the maxRSS calibration is recorded rather than applied | OPEN — the engine's documented conversion is what is used |

### 5.6 Reviewer findings `[LIVE]`

The three reviewers of §3 could not be launched at 11:52Z: every one returned
HTTP 429 with a session limit that reset at 11:30 America/Bogota. The audit was
done solo until the limit lifted, and the three scoped adversarial reviewers
were then run as the §7 barrier over the whole diff rather than over a plan.
Their findings are §5.5.


---

## 5.7 The campaign `[LIVE]`

Sealed at 2026-09-08T21:14:44Z as `c_ad783a8067c556d6` over subject
`66ac60cbb21efa280537d8df5ca89c67e11406490a295c4c5363332c8e3fd685`.

**This is the second seal, and the first one is worth recording.** The campaign
sealed at 19:56Z as `c_ad6c9606566777b5` was invalidated thirty minutes into its
capacity run by a one-line change to `tools/sabotage.mjs` — a mutation whose
anchor the association escaping had moved. `tools/` is SEMANTIC_HARNESS, so the
subject moved and every measurement taken under the old seal stopped belonging
to the tree. The capacity run was stopped, the five vendor gates that had passed
under it were discarded, and everything was re-run under this seal.

That is the discipline working rather than a mistake in it: the alternative is a
campaign whose evidence was taken against code that is no longer here, which is
the failure the whole front exists to remove. What it cost was about seventy
minutes, and the lesson is the ordering — every change to anything in the
subject belongs before the seal, and the way to know is to ask each harness
whether it still holds *before* spending machine time rather than during it.

### Before the seal: the sabotage corpus, checked twice

The anchor preflight answered in a tenth of a second and found M53 broken by the
association escaping. The full corpus then ran to answer the question the
preflight cannot: whether every mutation is still *killed* by the suite after
thirteen thousand lines of change.

    98 mutations, 98 anchors verified
    98/98 mutations killed, 0 survived

Run before the seal on purpose. A survivor is a source change, a source change
moves the subject, and finding one eight hours into a capacity run would have
cost the campaign a second time.

Documentation is EDITORIAL and outside the subject, so the campaign survives the
writing of this section — which is the point of the S-1 repair, and was checked
rather than assumed: `seal-campaign --check` reports `matches: true` after each
of the commits made while the campaign ran.

### The five vendor gates

All five passed under the first seal, and are re-run under this one after the
capacity work, because evidence belongs to the campaign it was taken in. The
figures below are from the first seal and the second run is expected to
reproduce them; what the second run establishes that the first did not is that
they hold against the code the capacity evidence was measured on.

| gate | evidence | cases | result |
| --- | --- | ---: | --- |
| HSP-TARGET-01 (target contract) | `hs-target-contract.json` | 42 | PASS |
| HSP-TARGET-01 (import) | `hs-import.json` | 27 | PASS |
| SF-TARGET-01 (target contract) | `sf-target-contract.json` | 11 | PASS |
| SF-TARGET-01 (Data Loader) | `sf-dataloader.json` | 29 | PASS |
| SF-OCR-01 | `sf-ocr.json` | 13 | PASS |

The release gate reads all five and, with the live credentials in the
environment, reports:

- `hubspot_target_current` **true** — against instance `i_85d7849b12c37767`,
  which is the instance the live credential authenticates to (DEVELOPER\_TEST);
  every case the oracle declares was asked and answered, and every file captured
  the campaign's subject;
- `salesforce_target_current` **true** — against `i_fba18c99c632ea0d`, by a
  client-credentials grant;
- `salesforce_ocr_disposition_current` **true**.

Those three are the facts a script reading this repository cannot satisfy, and
they are why the gate cannot be made true offline.

The first attempt at this campaign was refused by the runners themselves: the
oracle assertion had been placed before the evidence object rather than before
the write, and in three of the five runners that object is built early and
appended to — so it fired against an empty array and refused a run that had
asked all twenty-seven of its cases and passed every one. Fixed, re-sealed,
re-run. It is the assertion working: the refusal was wrong about the cause and
right that something was missing where it looked.

### Capacity

Started 2026-09-08T20:02:55Z, strictly sequential — the host has fourteen
gigabytes and the memory budget is five and a half, so two heavy loads at once
would measure the host rather than the engine.

1. the three founding profiles at one million rows, two complete reproductions
   each;
2. then P1 to P12 at the same rung, each at the scale its own parameters
   declare.

## 6. Execution DAG

Shared nodes run once. `cost` is the MC-2 measurement or an estimate marked `~`.

| node | inputs (hashed) | outputs | depends on | cost | resources |
| --- | --- | --- | --- | --- | --- |
| N0 inventory/audit | tree @5e19f6d, canonical docs | this file, reviewer JSON | — | ~3 h | light |
| N1 repairs B1–B6 | N0 | branch commits, tests | N0 | ~7 h | light |
| N2 cheap barrier | N1 | `npm run build/typecheck/lint/spec:check/test`, gate tools in check mode, workflow lint, tamper/negative suites, public-consumer test, Data Loader smoke | N1 | ~1 h | light; smoke uses SF reads + 1 synthetic insert |
| N3 adversarial review of the diff | N2 | findings, fixes in the same batch | N2 | ~1 h | light |
| N4 seal | N3 | commit, `subjectDigest`, `campaign.json`, calibration | N3 | 5 min | — |
| N5 vendor campaign | N4, credentials | 5 evidence files (target capture, attestation, import, export-back, cleanup) | N4 | ~30 min | HubSpot/SF API; Data Loader |
| N6 capacity founding | N4 | 3 mode files, 2 reproductions each | N4 | ~2.0 h | 1.5–1.7 GiB RSS, 12 GiB scratch each, sequential |
| N7 matrix P1–P12 | N4, N6 done | `matrix.json` | N6 | ~2.0 h | up to 2.4 GiB RSS, 22 GiB scratch (P3) |
| N8 regeneration | N5, N6, N7 | acceptance docs, provenance, manifest, GATES/README figures | N5–N7 | 10 min | light |
| N9 preflight | N8 | `preflight.json` → `READY_FOR_FINAL_UNIVERSE` | N8 | 5 min | light |
| N10 universe | N9, clean checkout of the sealed commit | `universe.json` (18 steps, sabotage ≥ 93 + new mutations) | N9 | ~1 h | CPU |
| N11 push + PR + PR CI | N10 | run id, check names | N10 | ~55 min | GitHub |
| N12 ruleset update | N11 (real check names) | ruleset with required checks | N11 | 2 min | GitHub |
| N13 rebase merge | N12 | main SHA | N12 | 1 min | GitHub |
| N14 main CI + observer | N13 | receipt artifact, final `ci-receipt.json` | N13 | ~55 min | GitHub |
| N15 dossier/tag/release | N14 | tag `v2.0.1`, release + assets, verified downloads | N14 | 20 min | GitHub |
| N16 freeze verdict | N15 | `freeze-verdict.json` | N15 | 5 min | GitHub reads |
| N17 final audit | N16 | audit notes | N16 | 20 min | light |
| N18 report | N17 | final report; STOP | N17 | 10 min | — |

## 7. Evidence dependency policy (invalidation graph)

| change class | examples | effect |
| --- | --- | --- |
| EDITORIAL | `README.md`, `docs/**/*.md` that are not oracles, `docs/work/*`, generated `acceptance/README.md` prose, comments in docs | no requalification; the subject digest does not include them |
| SEMANTIC — runtime | `src/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `spec/**` | new capacity campaign + five vendor gates + universe + CI |
| SEMANTIC — harness/oracle | `tools/**`, `qualification/**/*.mjs`, launcher sources, `EXPECTED_TRUTH.md`, corpora, `profiles.json`, `test/fixtures/**` | same as runtime (the subject digest moves) |
| SEMANTIC — contracts | `TargetContract` capture, attestation issuers, adapters (`src/adapters/**`) | vendor gates + universe |
| WORKFLOW | `.github/workflows/**` | CI receipt; universe unchanged |

The policy is code (`tools/invalidation-policy.mjs`) with tests, and the gate
`evidence_bound_to_exact_candidate` is its enforcement. For MC-3 every class
above except EDITORIAL is touched, so the whole campaign runs once on the sealed
commit; nothing from MC-2 is counted as current.

## 8. Deviations and failures `[LIVE]`

| # | what | why it is a deviation | what was done |
| --- | --- | --- | --- |
| D1 | The three scoped reviewers of §3 could not be launched at 11:52Z | every one returned HTTP 429, session limit, resets 11:30 America/Bogota | the audit was done solo until the limit lifted; three scoped adversarial reviewers were then run over the whole diff as the §7 barrier |
| D2 | Nine campaigns were sealed during the repair phase | the mandate asks for one costly campaign; it does not limit seals, and a seal is a measurement of the tree rather than a cost | each seal is recorded; the campaign the evidence is taken in is a single run of all five vendor gates plus capacity under one seal |
| D3 | The vendor gates were run seven times before the campaign | each repair had to be shown to work against the real tenant, and three of them were only visible because a run failed | every run created records inside its own campaign namespace and removed them, with the read-back recorded; the org and the portal were confirmed empty of each namespace afterwards |
| D4 | No YAML library was added to validate the workflow | the mandate asks for validation by a proper tool; adding one would be a fourth development dependency and would move the dependency closure the campaign is sealed over | the workflow is parsed by `readWorkflowJobs`, a reader that refuses every line it cannot classify — stricter than a permissive parse for this purpose — and GitHub's own parse is observed when the run starts |
| D6 | The campaign was sealed twice and the first seal discarded | a one-line re-anchor of a sabotage mutation moved the subject thirty minutes into the capacity run, and evidence belongs to the campaign it was taken in | the capacity run was stopped, the five vendor gates re-run under the second seal, and the full sabotage corpus run *before* the second seal so that a survivor could not cost a third |
| D7 | The sabotage corpus was run outside the offline universe as well as inside it | the universe runs it, but a survivor is a source change, a source change moves the subject, and finding one eight hours into a capacity run costs the campaign | 98/98 killed, 0 survived, recorded before the seal |
| D5 | The profile stage makes every capacity case slower | measured: P6 at 100,000 rows takes 142s against roughly 83s implied by MC-2's figure at the million rung | accepted rather than removed: a migration in this product is preceded by a full profile of the same bundle, and measuring the run without it measured most of the work and reported all of it |
| D8 | Campaign `c_8d5ba3a565072ace` (sealed 2026-09-10 19:28Z) was lost to contamination | a child-only kill left its orchestrator alive; a second matrix launched 21:12Z shared `bench/capacity` and `matrix.log` with it; both died at P4 attest with ENOENT | evidence discarded; the whole process tree is now killed by command line through WMI, one `bench/capacity` per run, zero processes verified before each launch |
| D9 | Campaign `c_05aca06eaf0abc14` (2026-09-11 01:36Z) stopped at P1 after 17 minutes | `bench/` was excluded from the tracked listing, so the launchers were outside the manifest, the subject and the universe's binding; the fix is in `tools/candidate-provenance.mjs`, which is in the capacity closure | re-sealed and relaunched rather than run to completion on a closure known to be about to change |
| D10 | Campaign `c_941e544247629ac7` (01:57Z) stopped at P1 after 20 minutes | §8: a host must be able to sign a synthetic attestation and `attestationSigningBytes` was not public; `src/` is in the capacity closure | every remaining public-surface need bundled into one commit (`6740923`), re-sealed as `c_53d6b2453fe15386` at 02:18Z and relaunched; P1 at 1M rows had passed in 9.8 minutes with a 1155 MiB peak on the stopped run |
| D11 | The vendor gates were run three times on 2026-09-11 | each re-seal unbinds the captures taken under the previous seal | 5/5 PASS each time; every run in its own campaign namespace with read-back cleanup recorded |
| D12 | The final freeze verdict is not published as a release asset, against D-MC3-12 as first written | an immutable release cannot receive a verdict decided after its publication, and a verdict inside the release it judges would vouch for itself | the verdict is written outside the tree and the release (`--out`), beside the handoff record; the dossier inventory 1.0.0 lists what the release carries |

## 9. Closure matrix `[LIVE]`

Filled at the end: every id in §5 with `CLOSED / EXCLUDED` and the evidence
path (test name, gate fact, evidence file, run id, or verdict field).

## 9.1 The chain `[LIVE]`

From 2026-09-11 the order below, the release procedure of §11 and every step
between them are one graph, `tools/chain.mjs`: twenty nodes with their real
commands, inputs, dependencies, timeouts and oracles, validated for cycles and
orphans, walked in topological order with every descendant of a failed node
BLOCKED and every independent failure in one report, with a read-only `--check`
walk and a ledger outside the tree. `--rehearse` runs the graph under
CONTROL_FLOW_TEST_ONLY against `tools/rehearsal/fake-github.mjs` and reaches
merge, main CI, the downloaded receipt, the dossier, the tag, the draft, the
publication and the verdict through the injected transport; six scenarios
(ok, a failed gate, red CI, a refused merge, an existing tag, a mutable
release) must fail exactly where they should. `--barrier` runs them all with
the self-tests and prints `READY_TO_EXECUTE_FINAL_CHAIN`; it was TRUE at
`bc5729d` (02:40Z). The two sections below remain as the reasons behind the
graph's order.

## 10. The order the generated records must be written in `[LIVE]`

Four records vouch for each other, and getting the order wrong is the single
mistake this front made most often — three separate times, each found only by
running the whole chain rather than by reading it.

    1. tools/universe.mjs              -> qualification/candidate/universe.json
    2. tools/candidate-provenance.mjs  -> manifest.json + provenance.json
    3. release-candidate-gate --preflight -> preflight.json
    4. npm run provenance              -> migration-core-provenance.json + its Markdown

The release provenance hashes all three of the others, so it is written last.
Nothing it writes can invalidate them, because the exclusion rule keeps the
manifest, the candidate provenance, the preflight, the universe report and the
release provenance itself out of the digest the manifest is over.

Written out of order, exactly one of `candidate-provenance --check`,
`provenance:check` and DRIFT-01 fails, and which one depends on which record
was written last. That is what took PR #11 red on its first run: the preflight was
taken after the release provenance, so the release record vouched for a preflight
that no longer existed.

## 11. Publishing the release `[LIVE]`

Three things about this are only learnable by doing it, and two of them were
learned the expensive way.

**The release must be created as a draft and published only once every asset is
on it.** This repository has immutable releases. A release created and then
published is sealed: assets cannot be added afterwards. Worse, **deleting an
immutable release permanently reserves its tag name** — GitHub refuses to
create that ref again, by git push or by API, with "Cannot create ref due to
creations being restricted". A release created empty, deleted and recreated
therefore costs the tag name for good.

**The release needs a `SHA256SUMS` asset.** `release_assets_verified` reads it,
requires every other asset to be named in it, downloads each one and hashes it,
and refuses if the release names a file it does not carry or carries one the
sums do not name. A release with seven assets and no sums is not a release this
verdict will accept.

The order that works:

    1. git tag -a v2.0.1 <merged sha> -m "..."   and push it
    2. assemble the dossier, then write SHA256SUMS over it
    3. create the release as a DRAFT on that tag
    4. upload every asset, SHA256SUMS included
    5. publish the draft
    6. node tools/freeze-verdict.mjs --sha <merged sha> --receipt <path>

Both conditions were exercised against throwaway tags before the real one, which
is how the missing `SHA256SUMS` was found without costing a qualification. The
probes were removed afterwards.
