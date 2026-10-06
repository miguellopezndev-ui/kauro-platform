# B05 plan r3: integrate MC 3.0.0 + IC 0.6.0 behind the core ports (S045, S046, S047; gate G-MONO)

Planner. r1 6bbb545 REJECT (11 findings); r2 7e32522 REJECT (8 FIXED; D01, D04, D06 partial; D12-D14 new); r3 2026-10-06.
Base platform a7315df; MC v3.0.0 (3b4b0ae, release 404110602, tgz sha256 2686ee65...5312); IC frozen ic/b04-integrate 4fee8d1
(0.6.0, NOT released). Authority: 07 "Platform topology"; 04 "Architecture and dependency boundary", "Resources"; 06 "Budget
algebra", "Cancellation and deadlines"; HASHING "Hash domain separation", "Version and namespace bridges", "Exact money"; B08 §10,
D8-PORT-1..4, D8-GRANT-1/2, D8-AUD-3, D8-LOCK-1. Judged sound and kept: D5-1, A01-A04, D5-7, the IC-release/B02 waits, and the
r2 fixes of D02, D03, D05, D07-D11.

## 0. Resolution log
| Finding | r3 resolution |
|---|---|
| D01 BLOCKING (partial) | D5-11: liability = charge_micros - max_charge_micros (the exact admitted maximum), independent of cent rounding; cents stay conservative (reserve ceil, post min(ceil, reserved)); same rule for late settlement and for GRANT_RECONCILIATION (micros evidence); pool row lock serializes liability vs any admission of any run/grant on the pool; L05, L05b, L07, L08 |
| D04 (partial) | D5-15 order: run -> effects -> writePackage -> dispose run scratch -> verify; effects held in the child record; J5b binding-write row; M22 per effect family; B01-B03 |
| D06 (partial) | D5-2c: one byte ledger per attempt enforced BEFORE each write: parent writes pre-reserved from declared lengths; child direct fs writes (writePackage artifacts, human views, manifest) metered by a child preload that wraps writeSync/writeFileSync and refuses every other write API; M03, M03b, M23 |
| D12 send transition (new) | D5-18: RESERVED -> DISPATCHING committed through B06 `markDispatching` (0023 trigger: audit INTERPRETING, deadline, MODEL_TASK fence) before the gateway call; response/uncertain/failed mapping; matrix row J10; S01-S06 |
| D13 C-suite runner (new) | L0 adds `test` scripts (+ test tsconfig) to both wrappers so `pnpm -r run test` runs C01-C04; L5 registers B05-case-map in `tools/evidence.mjs` CASE_MAPS |
| D14 I10 title (new) | I10 retitled: false platform identity or native-loader mismatch only |
| K04/allowlist (coordinator) | `wrapper-additions.json` (L0, starts empty); L2 adds `assertCanonicalAgreement` to it and the export in one commit; K04 = core root exports + allowlist, both directions |

## 1. Decisions
- **D5-1 Consumption.** Pinned tarballs in `vendor/`: `kauro-migration-core-3.0.0.tgz` (published asset verbatim, checked against the release SHA256SUMS line kept as `vendor/SHA256SUMS.mc-3.0.0`) and `kauro-intelligence-core-0.6.0.tgz` (PROVISIONAL_UNRELEASED: clean clone of the frozen sha, `npm ci && npm run build`, `npm pack`, refused unless it holds `dist/src/index.js`; never `tools/pack.mjs` on an unbuilt tree). `vendor/MANIFEST.json` (KAURO_VENDORED_DEPENDENCY entries + status RELEASED | PROVISIONAL_UNRELEASED). Wrappers declare exact versions; `pnpm-workspace.yaml` overrides map both names to `file:vendor/...`; pnpm-lock carries sha512 integrity. `tools/vendor-cores.mjs check [--release]` proves sha256 == MANIFEST == SHA256SUMS and lockfile integrity == file sha512, refuses link:/workspace:/sibling paths and, with --release, PROVISIONAL; it runs first in `verify` and in `clean-consume`, whose consumer gets the same overrides with absolute vendor paths and smoke-calls both wrappers. No network or credential needed (S045).
- **D5-2 MC adapter** `packages/data-plane/src/cores/`, per attempt/step `{capability, scratchRoot, inputs: CoreInputResolver, clock, limits, pollIntervalMs=1000}`. Execute E0 guard; E1 materialize; E2 child runMigration; E3 writePackage -> verifyPackage(stagingDir) -> promotePackage; E4 re-hash + stage from the promoted dir; E5 cleanup. Config = toMigrationConfig(bound configuration) then MC loadConfig; hash != binding's coreConfigHash -> REFUSED CONFIG_BINDING_MISMATCH.
- **D5-2b Bounds** : one deadline per operation fixed at entry; every await raced; SIGKILL; late results dropped; optional `controls` on ValidateRequest and `verify(...,controls?)`, required by the real adapter; callers pass them (L3d).
- **D5-2c Scratch capacity, enforced before every write.** Budget B = limits.scratchBudgetBytes per attempt (device ENOSPC at hardScratchBytes is only the backstop -> SCRATCH_EXHAUSTED). One `AttemptByteLedger` (live bytes, B): (1) parent inputs: input k reserved at its capability byteLength before its first byte; a stream past that length is cut (SOURCE_INTEGRITY_FAILED) before the excess is written; (2) child: quota passed = B - parent live bytes at spawn; the child's preload installs a metered fs: `writeSync`/`writeFileSync` charge the ledger before the call and throw ENOSPC-coded when it would pass the quota; `rmSync`/`unlinkSync`/`renameSync`-over credit the lstat size removed (human-view temporaries included); `appendFileSync`, `createWriteStream`, `copyFileSync`, `cpSync`, `truncate*`, `link`/`symlink`, `fs.promises` writes are refused OUTSIDE_CAPABILITY (fail closed on an MC upgrade); `module.syncBuiltinESMExports()` so MC's ESM named imports see the metered functions; the child's AttemptScratchStore `device` writes through the same ledger; (3) release order: run segments S disposed after writePackage+effects; verify scratch V disposed before exit; inputs deleted before staging; (4) parent spools: file k staged only if io.scratch live + remaining package bytes + size_k <= B (spool of k = size_k, known from the child's record); file k deleted after its close. MC's verifyAgainstSource tmpdir write is outside the permission model's allowed paths -> OUTSIDE_CAPABILITY (not used by verifyPackage; M23 asserts).
- **D5-2d Cleanup reach** : all under `kauro-attempt-scratch-<attemptId>/kauro-core-run/<callId>/`; `removeOrphanStepScratch` for audit steps.
- **D5-3 Identity classes** (HASHING "Hash domain separation"): (a) RAW_BYTES (sources, artifacts, MC manifestSha256); (b) CORE_NATIVE: MC hashSourceProfile / hashCandidateSet / loadConfig().configHash / packageDigest (indented canonicalJsonText, UTF-16 order, trailing newline) and IC digestOf refs, stored verbatim and checked only by the core's own loaders (loadSourceProfile, loadCandidateSet, loadConfig); (c) PLATFORM structured digests (@kauro/contracts domain wrappers). A platform record citing a core identity carries it as a string. Only values the platform hashes structurally from IC output (PlanBody, fragment evidence) pass `assertCanonicalAgreement` (fail closed). IC issue for 0.6.x: code-point order, reject lone surrogate / unsafe integer. Never re-hash one class as another.
- **D5-4 IC journal bridge** : authority check before and after every barrier flush; sticky refusal; dropped late continuations; COMPILED only after AFTER_RESULT passes and no OPEN liability on the pool.
- **D5-11 Money (tier 1).** Migration 00NN (next free; renumbered at merge) adds to request_journal `core_run_id`, `core_reservation_id`, `core_request_key`, `max_charge_micros` (> 0, the exact admitted maximum), `settlement_state` (AMBIGUOUS | COMMITTED | RELEASED), `charge_micros`, `usage_known`, `settlement_hash`; UNIQUE (core_run_id, core_reservation_id); table `kauro.dispatch_liabilities` (request_id UNIQUE, grant_id, pool_id, excess_micros > 0, state OPEN | CLEARED, opened_at db clock; append-only but the clearing edge, owner/ops act -> PARTIAL B12).
  - admit: createModelTask + beginDispatch reserving ceil(max/10_000) cents, max_charge_micros = max; requestKey required;
    same (run, reservation, max) replay -> ADMITTED, one reservation; other max -> conflict; KA083 or pool OPEN liability ->
    NO_FUNDED_GRANT; KA080/KA081 -> FENCED.
  - settle (`settleDispatch`, one transaction, lock order pool row FOR UPDATE -> grant row -> request row, consistent with
    D8-LOCK-1 "agency ledger -> global ledger"): same key + same settlement_hash -> replay; terminal + other body ->
    SETTLEMENT_CONFLICT, no write; AMBIGUOUS keeps the reservation (usage UNKNOWN); RELEASED only from RESERVED (never
    DISPATCHING; else stays AMBIGUOUS); COMMITTED posts min(ceil(charge/10_000), reserved_cents) cents, keeps charge_micros
    exact, usage_known=false -> ESTIMATED (grant cannot close).
  - **liability**: excess_micros = charge_micros - max_charge_micros; > 0 -> OPEN liability in the same transaction, never in
    reconciled_spend (cost_grants_within_ceiling holds). Rounding slack (reserved_cents*10_000 - max) never absorbs it.
  - GRANT_RECONCILIATION `reconcileRequest` takes provider evidence as micros (cents evidence = cents*10_000 exactly), is
    idempotent on an equal value, and applies the same excess rule against max_charge_micros; a late settlement after cancel
    or expiry is posted by the same rule (06: an incurred charge is still governed).
  - `request_journal_reserves_grant` takes the pool row FOR SHARE before the grant row and refuses any reservation, by any run
    or grant carved from that pool, while the pool has an OPEN liability.
- **D5-13 Run id.** Journal run_id = the audit UUID (= IC auditAttemptId); every ledger call asserts RunLedger.runIdFor(auditAttemptId, tenant) (other id refused); it is written to request_journal.core_run_id and used for core.cancel. tenant = {agencyId, clientId: projectId}.
- **D5-14 IC inputs.** CoreDocumentPort (application port; persistence impl L3d, table kauro.core_documents keyed by (agency, kind, core-native hash), retained with the revision's derived data, 09): PROFILE stores the HashedSourceProfile; candidate set and target contract stored by hash. projectRevision = {revisionId, revisionHash, mode via the CLEAN_ONLY<->CLEAN bridge, supportEnvelopeVersion pinned}; declaredObjects / recordIdColumns / localeEvidence absent until the agency-facts feature (PARTIAL B11; IC resolves or asks -> NEEDS_DECISION); scopedMemorySnapshot []; policyBundle pinned; resourceProfile.wallClockMs = remaining interpretation window. Missing or mismatched document -> FAILED PROFILE_EVIDENCE_MISSING before any reservation.
- **D5-16 Plan binding.** PlanCompilerPort.compile stores (planHash -> CandidateConfiguration, coreConfigHash) in CoreDocumentPort (row J5b); execute/validate translate a PlanBody only through that binding; PlanBody digest recomputed by the platform.
- **D5-17 Egress key.** deps.egressKey from the deployment secret (stable keyId, >= 32 bytes) injected by composition; tests use a labelled test key; never logged (B14 provisions the secret).
- **D5-15 Full-dataset validation, ordered.** Child: loadConfig (coreConfigHash) -> runMigration -> `effectsFromMigrationRun ({loaded, run})` while the run's scratch families are live (records, changes, unmapped columns, associations, duplicate clusters) -> serialize effects into the child record (cap 64 MiB, else FAILED EFFECTS_TOO_LARGE) -> writePackage -> dispose run scratch S -> verifyPackage(stagingDir) with V -> reportDigest -> dispose V -> record. The parent answers FullDatasetValidationResult from the record only. Same order (minus effects) for E3 and Q1.
- **D5-18 Durable send (tier 1).** IC gateway wrapped by the adapter. Order per invocation: IC admit (RESERVED, durable) -> SEND_STARTED + BEFORE_DISPATCH barrier (D5-4) -> `markDispatching(requestId, fence)` in its own unit, awaited to COMMIT (0023 `request_journal_model_task_send`: audit INTERPRETING, before the interpretation deadline, current MODEL_TASK fence; KA080/KA081/null -> no send, gateway answers "not dispatched", IC settles RELEASED) -> gateway send. Outcomes: response -> `storeResponse(requestId, fence, responseDigest, usage)` RESPONSE_STORED before IC's AFTER_RESPONSE barrier, IC settles COMMITTED; transport ambiguity (timeout, reset after write, lost ack) -> `markUncertain` UNCERTAIN, IC settles AMBIGUOUS; provider definite refusal -> `markFailed`, COMMITTED at the reported charge (0 when none billed). A crash between DISPATCHING commit and send is treated as sent (UNCERTAIN, reserved; never RELEASED). GRANT_RECONCILIATION releases only RESERVED rows; markDispatching and that release serialize on the request row (one wins). A takeover's new fence cannot markDispatching or storeResponse the old request (fence mismatch); the old request stays UNCERTAIN for reconciliation.
- **D5-5 Input layout.** path = input/<sha256(canonical {domain:"KAURO_CORE_INPUT_PATH_V1", objectName, generation})>; read config (format, encoding, delimiter, sheets) from the sealed revision's stored facts via CoreInputResolver(revisionHash), one function for profile, compile and execute.
- **D5-6 Wrappers** `@kauro/migration-core`, `@kauro/intelligence-core` (layer core) re-export every core root export; additions only as listed in `wrapper-additions.json`; the raw core is importable only by its wrapper, at its root.
- **D5-7 Attestation.** The adapter never sets attestationPolicy nor invents authorities; CRM modes REFUSED until the subject carries the attestation (PARTIAL B15); CLEAN_ONLY<->CLEAN through one enum-only bridge.
- **D5-8 Cause mapping.** quota/ENOSPC -> SCRATCH_EXHAUSTED; short write -> SHORT_WRITE; self-verify fail or re-hash mismatch -> CORRUPT_INTERMEDIATE; MigrationError refusal -> REFUSED; source mismatch -> AttemptEnvelopeFailure SOURCE_INTEGRITY_FAILED; ERR_ACCESS_DENIED or refused fs API -> OUTSIDE_CAPABILITY; close failure -> ARTIFACT_CLOSE_FAILED; child lost / OOM -> reject (worker WORKER_ERROR). No non-COMPLETED outcome lists a staged artifact.
- **D5-9** Comments naming the real core -> 3.0.0; fake tokens contract-fake-migration-core-2.0.3 unchanged (port unchanged).
- **D5-10 Evidence class.** Port EXECUTED_LOCAL for the real core; the gateway's own class (SIMULATED | EXECUTED_PROVIDER) is recorded on the dispatch intent.

## 2. Case map
| S045 | EXECUTED_LOCAL MC half; PARTIAL -> L4 IC half | K01-K04, clean-consume log Win+Linux, M01, T01-T03 real |
| S046 | EXECUTED_LOCAL | A01-A04 |
| S047 | EXECUTED_LOCAL on provisional pin; PARTIAL -> L4 | C01-C04 via `pnpm --filter @kauro/intelligence-core test`; presealed digests |

## 3. Failure matrix (G:x = GAP closed by test x first; T1 = tier 1; N/A with reason)
Cols: RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL
**MC-EXEC**
- E0 guard+dirs: G:M12 | N/A local mkdir | G:M08 | G:M18 | G:M18 | G:M11 | G:M07 T1 | G:M11
- E1 materialize: N/A sealed generations (DENY M13) | G:M09 | G:M08 | G:M18 | G:M18 | G:M11 | G:M07 T1 | G:M13, M03b (cut at declared length)
- E2 child run: G:M12 | G:M08 | G:M08 | G:M02 | G:M10 | G:M11 | G:M06, M07 T1 | G:M03
- E3 write->verify(staging)->promote: N/A child-private (M12) | G:M08 | G:M08 | G:M10 | G:M10 | G:M11 | G:M06, M07 T1 | G:M04, M20, M03b, M23
- E4 stage: G:M07 held at close k T1 | G:M08 | G:M08 | G:M18 + PARTIAL B14 (manifest never written) | same | G:M11 | G:M07 T1 | G:M05, M03b (spool preflight)
- E5 cleanup: N/A attempt-owned | N/A local rm | N/A after terminal | G:M18 | G:M18 | N/A | N/A | G:M17
**P1 profile, Q1 validate, V1 verify, F1 full-dataset validation** (one row each, same cells): G:M12 | G:M16a-c / M22 | same |
G:M19 / M18 | G:M19 | G:M16 (new callId, equal core hashes) | G:M16 | V1 G:T01; F1 G:M22 (effects before disposal), M03b; P1/Q1 G:M03b
**IC-INTERPRET**
- J0 seed read: G:I02 | G:I06 | G:I06 | N/A read | N/A read | G:I07 | G:I02 | N/A one read
- J1 buffered append: N/A one sync run | N/A memory | N/A | G:I04 T1 | N/A | G:I03 | G:I12 | N/A
- J2 barrier flush: G:I02 T1 | G:I06 T1 | G:I06, I12 T1 | G:I03 | G:I03 T1 | G:I03 | G:I02, I12 T1 | G:I02 T1
- J6 admit (task + RESERVED intent): G:I04, L05 T1 | G:I12 T1 | G:I06 T1 | G:L01 T1 | G:L02 T1 | G:L02 T1 | G:I05, L05 T1 | G:L03 T1
- **J10 send (RESERVED->DISPATCHING commit, gateway call, response/uncertain/failed write)**: G:S02 markDispatching vs GRANT_RECONCILIATION release, both orders T1 | G:S03 lost ack/timeout -> UNCERTAIN, AMBIGUOUS T1 | G:S04 deadline passes between barrier and markDispatching -> KA081, no send T1 | G:S05 crash before DISPATCHING commit -> no send, RELEASED T1 | G:S05 crash after DISPATCHING commit before send -> UNCERTAIN, never RELEASED T1 | G:S06 redelivery after response lost before storeResponse -> no re-send without the recovery rule T1 | G:S04 cancel or takeover fence -> no send; old request UNCERTAIN T1 | G:S01 response sent but storeResponse refused (fence) -> UNCERTAIN, settled AMBIGUOUS T1
- J7 settle (request, grant, liability): G:L04 settle vs GRANT_RECONCILIATION both orders T1 | G:I08 T1 | N/A allowed after cancel/expiry, same rule (L07) | G:L03 T1 | G:L02 T1 | G:L02 T1 | G:L06 T1 | G:L03 T1
- J8 pool liability guard on reservation: G:L05b liability insert vs another run's/grant's admission on the pool, both orders T1 | N/A inside the insert | G:L05 T1 | N/A one statement (DENY L05) | N/A | G:L05 T1 | G:L05 T1 | N/A one statement
- J9 inputs + docs: G:I14 | G:I06 | G:I06 | N/A read | N/A read | G:I07 | N/A read-only | G:I14
- J4 outcome map: G:I05 T1 | N/A pure | G:I05 | N/A | N/A | G:I07 | G:I05 T1 | N/A pure
- **J5b compile binding write (planHash -> configuration, coreConfigHash)**: G:B01 two compiles of one body both orders -> one row | G:B02 put hangs -> compile fails, no draft | N/A content-addressed, retained with the revision's derived data (09) | G:B02 no binding, no draft | G:B03 retry finds the identical binding | G:B03 same planHash other configuration -> INTEGRITY_FAILURE | N/A inert without an approved plan; cancellation leaves it unexecutable | N/A one insert (DENY B03)
- J5 compile, planCandidates: N/A pure (8 cells); DENY I09, I10, I15; OK T04

## 4. Tests (exact titles; self-contained. Files: MCA data-plane/test/cores/migration-core-adapter.test.ts; CPF
application/test/core-port-contract.fake.test.ts; CPR data-plane/test/cores/core-port-contract.real.test.ts (table
application/src/testing/core-port-contract.ts, `<B>` = ContractFakeMigrationCore | MigrationCoreAdapter); ICA
application/test/cores/intelligence-adapter.test.ts; IJR apps/control/test/b05-interpret-journal.test.ts (real PG); LDG
persistence/test/b05-dispatch-settlement.test.ts; CDT persistence/test/b05-core-documents.test.ts; VC tools/test/vendor-cores.test.mjs;
AG tools/test/architecture-gate.test.mjs; CI packages/intelligence-core/test/canonical-interop.test.ts)
**MC adapter (MCA)**
- M01 "OK S045 (EXECUTED_LOCAL): execute runs vendored kauro-migration-core 3.0.0 in an isolated child over the attempt's accepted generations and stages every package file through the ArtifactWriter with the package's own reconciliation"
- M02 "RACE (core throws mid-run): a MigrationError refusal answers REFUSED with its code, an unclassified throw rejects; neither stages an artifact nor leaves child scratch"
- M03 "RACE (scratch full): the shared ledger refuses the write that would pass the budget before the byte reaches the device, from the store or a direct writePackage write; SCRATCH_EXHAUSTED, nothing staged"
- M03b "RACE (scratch full): inputs reserved at declared length, run segments, writePackage artifacts and human-view temporaries, verify scratch and spools never exceed the budget at any write; a stream past its declared length is cut"
- M04 "RACE (partial): verifyPackage refusing writePackage's stagingDir, or a parent re-hash mismatch, answers CORRUPT_INTERMEDIATE; the staging dir is discarded and nothing promoted or staged"
- M05 "RACE (partial): the k-th artifact close failing rejects ARTIFACT_CLOSE_FAILED; artifacts 1..k-1 stay as staging residue, none is returned and nothing after k is opened"
- M06 "RACE (cancel): CANCELLED during the child run kills it within one poll interval; between two artifacts no further artifact opens; answers CANCELLED"
- M07 "RACE (revocation): FENCED mid-run or held at an artifact close, in both orders, kills the child and writes nothing after the fence; answers FENCED"
- M08 "RACE (expiry): the operation deadline fixed at entry ends a hung open, chunk, write, close or child with SIGKILL; late results are dropped; spawn and retry never restart it"
- M09 "RACE (timeout): a SourceHandle chunk that never arrives is abandoned at the deadline; no child starts"
- M10 "RACE (crash after the package is written): the child killed after writePackage, and after verify before its record, rejects with nothing staged and its scratch removed"
- M11 "RACE (retry): a second execute for one attemptId, same or other subject, refuses ATTEMPT_SCRATCH_EXISTS and leaves the first directory untouched"
- M12 "RACE (two attempts): two attempts of one job held mid-run in both orders keep disjoint child directories; the fenced one ends FENCED"
- M13 "DENY input: a generation whose bytes or sha256 differ from the capability rejects SOURCE_INTEGRITY_FAILED before any child starts"
- M14 "DENY attestation: HUBSPOT or SALESFORCE without host attestation answers REFUSED, attestationPolicy is never restated, and CLEAN_ONLY maps to CLEAN only through the bridge"
- M15 "OK isolation: the core child runs under the permission model with the attempt scratch as its only writable directory, an empty environment and no network; peak memory is the child's maxRSS"
- M16a/b/c "RACE (profile|validate|verify bounds): without controls the adapter rejects; with them a hung read or child is killed at the deadline, cancellation ends it, and a retry uses a new callId directory with equal core hashes"
- M17 "DENY cleanup: a failed removal is reported as residual inventory and never replaces the primary terminal cause"
- M18 "RACE (crash residue): a parent killed in E0..E5 leaves everything under kauro-attempt-scratch-<attemptId>, and removeAttemptScratch removes inputs, run, package and package.kauro-staging"
- M19 "RACE (crash residue): removeOrphanStepScratch removes a dead step's profile or validate scratch and never a live one"
- M20 "OK E3: verifyPackage runs on WritePackageResult.stagingDir, promotePackage moves it, and staging enumerates the promoted dir"
- M21 "DENY layout: two generations with identical bytes get distinct input paths; profile, compile and execute paths are equal for one revision"
- M22 "OK F1: effects for records, changes, unmapped columns, associations and duplicate clusters equal an undisposed in-process reference; packageDigest, reportDigest and coreConfigHash are MC's own"
- M23 "DENY child fs: appendFileSync, createWriteStream, copyFileSync, truncate, link, fs.promises writes and a tmpdir write are refused OUTSIDE_CAPABILITY; ESM named imports see the metered writeSync"
**Contract table (CPF and CPR, same titles with `<B>`)**
- T01 "<B>: verify checks only the caller's expected authority; a missing, duplicated, extra or foreign artifact and a false summary are each INVALID"
- T02 "<B>: execute reaches only its HostIo and answers SCRATCH_EXHAUSTED, SHORT_WRITE or CORRUPT_INTERMEDIATE for a provoked full scratch, short write or corrupt intermediate"
- T03 "<B>: every record carries the binding's evidence class and names its core version"
- T04 (IC table) "<B>: planCandidates plans a complete manifest with no dispatch or spend; interpret compiles a stored response before any new dispatch and never dispatches without a reservation"
**IC adapter (ICA, IJR)**
- I01 (ICA) "OK interpret: appends are buffered and made durable at each IC barrier in order, and the journal read back equals the core's ledger"
- I02 (IJR) "RACE (journal fence conflict, both orders): a newer step's append or a stale fence (KA080) refuses the barrier, and an authority check failing after a successful flush refuses it too; the landed prefix stays, no intent is reserved after it, outcome FAILED"
- I03 (IJR) "RACE (crash after COMMIT): an append whose commit answer is lost is recognised at its index by core digest and not appended twice; another event there is a conflict"
- I04 (IJR) "RACE (money): no send without a durable SEND_STARTED and a reserved intent; two admissions racing for one grant room in both orders reserve at most the ceiling; a refused barrier or admission sends and spends nothing"
- I05 (ICA) "RACE (cancel): cancellation during run cancels the core; a SYSTEM_DRAFT returned after cancellation or past the deadline answers FAILED, never COMPILED"
- I06 (ICA) "RACE (expiry): interpretationDeadlineAt reached mid-run or during a hung append ends FAILED with no further dispatch"
- I07 (IJR) "RACE (retry): a second interpret of the step reads the journal, compiles the stored response first and reserves nothing twice"
- I08 (IJR) "RACE (crash after reservation): an intent reserved but not sent, or sent ambiguously, stays reserved and is never re-sent without the core's recovery rule"
- I09 (ICA) "DENY compile: IC compiler rejections map to MALFORMED_PATCH, UNKNOWN_CANDIDATE, UNKNOWN_FIELD or EFFECT_NOT_PERMITTED"
- I10 (ICA) "DENY identity claims: a value claimed as a platform structured digest that the platform does not recompute, or a core-native hash its own core loader does not reproduce, is INTEGRITY_FAILURE; an honest core-native hash is stored verbatim"
- I11 (IJR) "RACE (money rounding): 1 micro reserves 1 cent, 10000k+1 micros k+1 cents; a crash around settle posts it once"
- I12 (ICA) "RACE (revocation at a barrier): cancellation, deadline or fence observed before or after a flush refuses the barrier stickily; a later append, barrier or admit is refused and a late continuation is dropped"
- I13 (IJR) "OK run id bridge: journal run_id is the audit UUID, each request names runIdFor(auditAttemptId, tenant), cancel uses it, and a ledger call for another run id is refused"
- I14 (IJR) "DENY inputs: a missing or hash-mismatched profile, candidate set or target document fails PROFILE_EVIDENCE_MISSING before any reservation"
- I15 (ICA) "DENY plan binding: execute or validate of a plan with no stored CandidateConfiguration, or whose loadConfig hash differs from the bound coreConfigHash, is REFUSED"
- S01 (IJR) "RACE (partial): a response whose storeResponse is refused by a moved fence leaves the request UNCERTAIN and the settlement AMBIGUOUS, reservation held"
- S02 (IJR) "RACE (send vs release, both orders): markDispatching and GRANT_RECONCILIATION's release of a RESERVED request serialize; released -> no send; dispatching -> never released"
- S03 (IJR) "RACE (timeout): a lost send acknowledgement or transport timeout marks UNCERTAIN, settles AMBIGUOUS at the maximum and keeps the reservation"
- S04 (IJR) "RACE (revocation, expiry): cancellation, a takeover fence or the interpretation deadline committed between BEFORE_DISPATCH and markDispatching refuses the transition (KA080/KA081) and nothing is sent"
- S05 (IJR) "RACE (crash at the DISPATCHING commit): before COMMIT nothing is sent and the reservation is RELEASED; after COMMIT and before the send the request is UNCERTAIN and never RELEASED"
- S06 (IJR) "RACE (retry): a redelivered INTERPRET step with SEND_STARTED and no stored response re-sends nothing outside IC's recovery rule and reserves nothing twice"
**Money and documents (LDG, CDT)**
- L01 "RACE (crash before COMMIT): admission rolled back after the model task insert leaves no task, no intent and no reserved cents"
- L02 "RACE (retry, crash after COMMIT): admit and settle replayed with the same key return the recorded result with one reservation and one posting; another body is SETTLEMENT_CONFLICT with no write"
- L03 "RACE (partial): a failure at the grant update or the liability insert rolls back the request row, the grant and the liability"
- L04 "RACE (settle vs GRANT_RECONCILIATION, both orders): one posting, the other a replay or conflict; spend and reserved cents equal the hand-computed values"
- L05 "RACE (liability): a charge 1 micro above max_charge_micros opens a liability of exactly 1 micro even when the rounded-up cents would cover it; spend stays within the ceiling and any reservation on the pool is refused NO_FUNDED_GRANT"
- L05b "RACE (liability, both orders): a settlement opening a liability and an admission by another run or grant of the same pool serialize on the pool row; after the liability commits no reservation lands"
- L06 "DENY settlement: RELEASED for a request that reached DISPATCHING stays AMBIGUOUS; usage_known false posts ESTIMATED and the grant cannot close"
- L07 "RACE (late settlement): a COMMITTED settlement after audit cancellation or interpretation expiry posts its cents and opens the excess-over-max liability by the same rule"
- L08 "RACE (reconciliation): GRANT_RECONCILIATION evidence in micros above max_charge_micros opens the liability; an equal replay is idempotent; cents evidence is compared as cents*10000"
- B01 (CDT) "RACE (binding, both orders): two compiles of one plan body store one binding"
- B02 (CDT) "RACE (crash before COMMIT, timeout): a binding write that fails or hangs leaves no binding and no system draft"
- B03 (CDT) "RACE (retry): a replayed compile finds the identical binding; the same planHash with another configuration is INTEGRITY_FAILURE"
**Consumption, architecture, canonical (VC, AG, CI)**
- K01 "S045 OK: each vendored core's sha256 equals MANIFEST and SHA256SUMS and pnpm-lock integrity equals the file's sha512"
- K02 "S045 DENY: a tampered tarball, a MANIFEST mismatch, a lockfile integrity mismatch, a sibling file:../ path, link: or workspace: spec each fail with its reason"
- K03 "S045 DENY: check --release refuses a PROVISIONAL_UNRELEASED pin"
- K04 "S045 OK: each wrapper exports every root export of its core plus exactly the names in wrapper-additions.json, each listed name exists, and the installed core files equal the tarball's"
- A01 "S046 DENY: a deep import into a raw core or a wrapper, or a raw core imported outside its wrapper, is rejected while the wrapper root import passes"
- A02 "S046 DENY: ui or web importing a wrapper or raw core is rejected as server-only, and domain importing persistence still fails in the same tree"
- A03 "S046 DENY: production source importing kauro-intelligence-core/benchmark is rejected"
- A04 "S046 OK: the checked-in tree with both wrappers and the cores adapter passes, and the same tree with one injected deep core import fails"
- C01 "S047 OK: for values the platform hashes structurally, Unicode (NFC and NFD distinct, astral, escapes), large integer strings and ordered arrays give identical bytes under canonicalize and IC canonicalJson, equal to the presealed digests"
- C02 "S047 DENY: code-point vs UTF-16 key order, lone surrogate, unsafe integer or undefined member: refused by the platform or assertCanonicalAgreement; never two silent digests"
- C03 "S047 OK: MC-native hashes of a Unicode/large-integer profile and candidate set are recomputed only by MC's loaders, stored verbatim, and a platform digest of a record citing them carries them as strings"
- C04 "S047 DENY: re-hashing a core-native identity with the platform profile, or a platform digest with canonicalJsonText, is refused by the identity bridge"

## 5. Lanes (file ownership; `b05/<lane>`; worktrees `repos/pw-b05-<lane>`; migrations take the next free number, renumbered at merge)
| Lane | Files owned | Tests | Est (tokens/min), model |
|---|---|---|---|
| L0 kit (RUNNING) | vendor/**, pnpm-workspace.yaml, pnpm-lock.yaml, root package.json, tools/vendor-cores.mjs, tools/test/vendor-cores.test.mjs, tools/clean-consume.mjs, architecture.rules.json, tools/architecture-gate.mjs, tools/test/architecture-gate.test.mjs, packages/migration-core/**, packages/intelligence-core/** (package.json `test` script + test tsconfig, `wrapper-additions.json` empty; minus L2 files), docs/design/B05-design.md | K01-K04, A01-A04 | 450k/175 |
| L1 mc-adapter (after L0) | data-plane src/cores/** (adapter, core-child-runner, child-task, child-preload-fs, attempt-byte-ledger, removeOrphanStepScratch), src/index.ts, package.json, README, attempt/scratch-store.ts comment, test/cores/**; application ports/core-ports.ts (optional controls + comments), ports/core-inputs.ts (new: CoreInputResolver, CoreDocumentPort), testing/core-port-contract.ts, testing/cores.ts, test/core-port-contract.fake.test.ts, testing/contract-fake-migration-core.ts comment | M01-M21, M23, T01-T03 | TD Opus 240k/80 + Sonnet 650k/280 |
| L1v full-validation (after L1) | data-plane src/cores/full-dataset-validation.ts, child-task.ts (handed over), test/cores/full-validation.test.ts | M22 | TD 120k/40 + Sonnet 320k/130 |
| L2 canon (after L0) | intelligence-core src/canonical-agreement.ts + its export line + its wrapper-additions.json entry (handed over), test/canonical-interop.test.ts, test/fixtures/canonical-interop.json, tools/canonical-oracle.py | C01-C04 | 190k/80 |
| L3m money (now) | persistence migrations/00NN_dispatch_settlement.sql, src/audit/store.ts, domain ports/audit-store.ts, model/audit/grants.ts, persistence/test/b05-dispatch-settlement.test.ts | L01-L08, L05b | TD Opus 240k/80 + Sonnet 520k/230; Codex lane review |
| L3d control-docs (after L1 ports) | persistence migrations/00NN_core_documents.sql, src/audit/core-documents.ts, src/source/core-inputs.ts, test/b05-core-documents.test.ts; apps/control/src/audit/orchestration.ts (store profile, pass controls), the verifier caller in apps/control/src/execution/** | B01-B03, I14 part, M16 callers | 500k/200 |
| L3 ic-adapter (after L0, L3m, L3d) | application src/adapters/cores/intelligence/** (buffered ledger, admission, send.ts gateway wrapper, outcome map, compiler), src/index.ts, package.json, test/cores/**, testing/core-port-contract-intelligence.ts (+ cores.ts line after L1), test/core-port-contract-intelligence.fake.test.ts; apps/control/test/b05-interpret-journal.test.ts | I01-I15, S01-S06, T04 | TD 240k/80 + Sonnet 560k/240; Codex lane review |
| L4 ic-pin (after IC 0.6.0) | vendor/** IC entries, MANIFEST, pnpm-lock.yaml | K01, K03 --release; rerun C, I, S, T04 | 40k/30 |
| L5 close (coordinator) | docs/design/B05-case-map.md, tools/test/b05-case-map.test.mjs, tools/evidence.mjs (CASE_MAPS += B05), docs/acceptance/README.md | case map | 160k/50 |
Total ~4.4M agent tokens (r2 3.9M), ~30 agent-hours; wall ~3 days: L1 || L3m || L2 now, then L1v || L3d, then L3.

## 6. Context packets (each <= 3k tokens; coordinator pastes, agents do not re-read)
- L1: core-ports.ts 144-301; data-plane sandbox/runner.ts 1-132, child.ts 1-60, preload.ts (observer install pattern), attempt/scratch-store.ts 8-20, 44-132, 159-200, failure.ts; worker-host.ts 78-94, 214-227; core-port-fakes.test.ts 36-240; MC write-package.ts 32-66, 82-260, 300-450, verify-package.ts 424-472, run-migration.ts 66-153, load-config.ts 61-125, source-profile.ts 121-226. Harness: own clock + named holds (FaultPoints pattern); data-plane cannot import persistence.
- L1v: L1 child-task.ts; IC adapter/migration-effects.ts 146-200; IC ports/ports.ts 223-300.
- L2: contracts/src/canonical.ts (199 lines); IC src/contracts/canonical.ts 1-70; MC util/json.ts 1-60; oracle Python `json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)` UTF-8 sha256, digests committed before code.
- L3m: 0023_audits_cost_grants.sql 70-120, 180-330 (reserve and send triggers); persistence src/audit/store.ts 540-600, src/request-journal.ts 54-110; domain ports/audit-store.ts 200-240, ports/request-journal.ts; model/audit/grants.ts; IC kernel/admission.ts 1-63; harness `@kauro/persistence/testing` (bothOrders, mustWait, FaultPoints.crashableFactory, faultCell, controlledClock); a hand-computed cents/micros table (1 micro over max; max = k*10_000 + 1).
- L3d: orchestration.ts 230-300; persistence src/audit/journal.ts; B07 stored facts (`storedTableFacts`).
- L3: core-ports.ts 336-400; persistence audit/journal.ts 1-33, request-journal.ts 54-110; orchestration.ts 277-330; grant-reconciliation.test.ts 1-90; IC ports/ports.ts 21-100, 223-375; kernel/ledger.ts 101-125, 348-372; api/intelligence-core.ts 594-610, 640-680, 700-830, 1755-1800.

## 7. Waits, acceptance touch, risks
- IC 0.6.0 release (D-14 by 10-12, then B04 campaign): L4, IC halves of S045/S047, L5. B02 ACCEPTED: B05 stays REVIEW_ACCEPTED.
- Later packages: B12 liability clearing; B11 agency project facts; B14 manifest-crash cells, egress secret; B15 CRM attestation.
- Acceptance touch (B08/B06, list in Codex prompts): core-ports.ts, audit-store.ts, grants.ts, persistence audit/store.ts, 0023 trigger functions replaced by the new migration (reserve: pool lock + liability guard), orchestration.ts, verifier caller, scratch-store.ts comment; two new migrations.
- Risks: the child fs metering depends on MC using only writeSync/writeFileSync/rmSync/renameSync (verified at 3b4b0ae; M23 fails closed on change); D5-3 fail-closed on astral keys until IC aligns; full-data MC runs twice per audit (B17 cost).
