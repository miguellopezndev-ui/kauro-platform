# B05 plan r2: integrate MC 3.0.0 + IC 0.6.0 behind the core ports (S045, S046, S047; gate G-MONO)

Planner. r1 2026-10-06 (Codex design review 6bbb545: REJECT, 1 blocking + 9 major + 1 minor); r2 same day. Base platform a7315df;
MC v3.0.0 (3b4b0ae, release 404110602, tgz sha256 2686ee65...5312); IC frozen ic/b04-integrate 4fee8d1 (0.6.0, NOT released).
Authority: 07 "Platform topology"; 04 "Architecture and dependency boundary", "Resources"; 06 "Budget algebra", "Cancellation
and deadlines"; HASHING "Hash domain separation", "Version and namespace bridges"; B08 §10, D8-PORT-1..4, D8-GRANT-1/2, D8-AUD-3.
Kept from r1 (judged sound): D5-1 consumption, A01-A04, D5-7 CRM refusal, the IC-release/B02 waits.

## 0. r2 resolution of the review (finding -> decision / cells)
| Finding | Resolution |
|---|---|
| D01 BLOCKING money | D5-11 rewritten: durable settlement keyed (coreRunId, reservationId) + requestKey, exact micros kept, liability table, pool-wide dispatch block; new lane L3m owns migration/store/domain; rows J6, J7, J8 |
| D02 barrier authority | D5-4: authority recheck before and after every barrier flush, sticky refusal, late-continuation suppression; I02, I05, I12 |
| D03 run id | D5-13: journal run_id = audit UUID (= IC auditAttemptId); IC id runIdFor(auditAttemptId, tenant) asserted, stored in request_journal.core_run_id and used for core.cancel; I13 |
| D04 IC inputs/validation | D5-14 inputs from a CoreDocumentPort + CoreInputResolver (lane L3d); D5-15 IC validationPort = MC adapter validateFullDataset (lane L1v); D5-16 CandidateConfiguration<->PlanBody binding; egress key D5-17 |
| D05 bound phases | D5-2b: one operation deadline fixed at entry, every await raced against one AbortController, hard kill, late results dropped; ports gain optional `controls` (adapter requires them); M08, M09, M16a-c |
| D06 footprint | D5-2c: phase bounds + release order + subtree measurement at every phase boundary; M03, M03b |
| D07 crash cleanup | D5-2d: every core resource inside `kauro-attempt-scratch-<attemptId>/kauro-core-run/`, so removeAttemptScratch/STAGING_JANITOR reach it; audit-step orphans swept by `removeOrphanStepScratch` (L1) bound at control start (integration commit); M18, M19 |
| D08 hash namespaces | D5-3 rewritten: three identity classes, never re-hashed as another; C01-C04 rewritten |
| D09 stagingDir | E3: verify `WritePackageResult.stagingDir`, enumerate/re-hash there, `promotePackage`, stage from the promoted dir; M04, M20 |
| D10 input layout | D5-5 rewritten: path = digest of (objectName, generation); read config from the sealed revision's facts via CoreInputResolver; M21 |
| D11 wrapper surface | D5-6: every core root export preserved + an explicit allowlist of wrapper additions; K04 retitled (L0 change) |

## 1. Decisions
- **D5-1 Consumption** (unchanged): vendored tarballs + `vendor/MANIFEST.json` (status RELEASED | PROVISIONAL_UNRELEASED),
  overrides in pnpm-workspace.yaml, `tools/vendor-cores.mjs check [--release]`, clean-consume covers both wrappers.
- **D5-2 MC adapter** `packages/data-plane/src/cores/` (adapter layer). Per attempt/step: `{capability, scratchRoot, inputs:
  CoreInputResolver, clock, limits, pollIntervalMs=1000}`. Execute: E0 guard; E1 materialize; E2 child `runMigration`; E3
  `writePackage` -> `verifyPackage(stagingDir)` -> `promotePackage`; E4 re-hash + stage from the promoted dir; E5 cleanup.
  The config is `toMigrationConfig(boundConfiguration)` then MC `loadConfig`; its hash must equal the binding's coreConfigHash
  (D5-16) else REFUSED CONFIG_BINDING_MISMATCH.
- **D5-2b Bounds.** Each operation fixes `deadline = min(port deadline, entry + limits.wallClockMs)` ONCE at entry from the
  injected clock (never at spawn; a retry never restarts executionDeadlineAt). One AbortController armed for that instant and
  fired by cancellation polling (CANCELLED/FENCED); every await (open, each read chunk, write, close, child) is raced against
  it; on abort the child gets SIGKILL, the hung promise is abandoned (its later result dropped, a settled handle never listed),
  terminal cause fixed first. Ports gain optional `controls?: { deadlineAt; cancellation; limits }` on ValidateRequest and as
  `verify(candidate, expected, controls?)`; the real adapter rejects a call without them (fakes ignore). Callers in
  apps/control pass them (L3d).
- **D5-2c Scratch footprint** (one budget B = limits.scratchBudgetBytes per attempt; ENOSPC at hardScratchBytes is backstop ->
  SCRATCH_EXHAUSTED). Phases and release order: (1) inputs I; (2) run segments S in a child store with quota B - I - parent
  usage; (3) writePackage staging P (direct fs, outside the store): admitted only while I + S + P <= B, measured from
  WrittenArtifact bytes + manifest, else discard staging, SCRATCH_EXHAUSTED; then dispose S; (4) verify store V quota
  B - I - P, disposed after; (5) delete I; (6) stage file by file: parent spool F_k, delete file k after its close. Peak =
  max(I+S+P, I+P+V, P+F_k) <= B; the adapter measures the attempt subtree at each boundary and records it in resourceMetrics.
- **D5-2d Cleanup reach.** All dirs live under `attemptScratchDirectoryOf(scratchRoot, attemptId)/kauro-core-run/<callId>/`
  (`{input, run, package, package.kauro-staging, verify}`); the subdir name is outside the store's schema grammar. Execution
  crash residue: STAGING_JANITOR's existing removeAttemptScratch (no B08 change). Audit steps (`scratchRoot/profile|validate`,
  id = stepId): new `removeOrphanStepScratch(root, isLive)` run at control start (bound in the composition integration commit).
- **D5-3 Identity classes** (HASHING "Hash domain separation", "Version and namespace bridges"): (a) RAW_BYTES (sources,
  artifacts, MC manifestSha256); (b) CORE_NATIVE: MC `hashSourceProfile`/`hashCandidateSet`/`loadConfig().configHash`/
  `packageDigest` (indented canonicalJsonText, UTF-16 order, trailing newline) and IC `digestOf` refs - stored verbatim, checked
  only by the core's own loaders (`loadSourceProfile`, `loadCandidateSet`, `loadConfig`), never by platform canonicalize;
  (c) PLATFORM structured digests (`@kauro/contracts` domain wrappers) over platform documents; a platform record that refers
  to a core identity carries it as a string field. Only values the platform hashes structurally from IC output (PlanBody,
  fragment evidence) pass `assertCanonicalAgreement` (fail closed). IC issue for 0.6.x: code-point order, reject lone
  surrogate/unsafe int.
- **D5-4 IC journal bridge.** `BufferedLedgerStore` per interpret: seed = `journal.read(auditId)`; sync in-memory append;
  `barrier`: (i) authority check (cancellation CONTINUE, clock < interpretation and absolute deadlines); (ii) flush in order via
  `journal.append(auditId, ev, idx)` (fence checked by KA080 in the DB); LENGTH_MISMATCH -> re-read, same event at idx by
  core digest = landed; (iii) authority check again; any failure -> `{ok:false}` and the store is sticky-refused (append,
  barrier, admit all refused after). A continuation resolving after refusal is dropped. SYSTEM_DRAFT -> COMPILED only after
  AFTER_RESULT passed (i)-(iii) and no OPEN liability on the pool.
- **D5-11 Money (tier 1).** Migration 00NN (next free, renumbered at merge) adds to request_journal `core_run_id`,
  `core_reservation_id`, `core_request_key`, `max_charge_micros`, `settlement_state` (AMBIGUOUS | COMMITTED | RELEASED),
  `charge_micros`, `usage_known`, `settlement_hash`; UNIQUE (core_run_id, core_reservation_id); table `kauro.dispatch_liabilities`
  (request_id UNIQUE, grant_id, pool_id, excess_micros > 0, state OPEN | CLEARED, opened_at db clock; append-only except the
  clearing edge). admit: createModelTask + beginDispatch reserving ceil(maxChargeMicros/10_000) cents; requestKey required;
  replay of the same (run, reservation, max) answers ADMITTED without a second reservation, another max -> conflict;
  KA083/OPEN liability -> NO_FUNDED_GRANT; KA080/KA081 -> FENCED. settle `settleDispatch(s)` one transaction: same key + same
  settlement_hash = replay (returns record); terminal state + other body = SETTLEMENT_CONFLICT, no write; AMBIGUOUS keeps the
  reservation (usage UNKNOWN); RELEASED only from a request never DISPATCHING (else stays AMBIGUOUS); COMMITTED posts
  min(ceil(charge/10_000), reserved) cents, keeps charge_micros exact, usage_known=false -> usage ESTIMATED (grant cannot
  close); excess_micros = charge - reserved*10_000 > 0 -> OPEN liability row (never into reconciled_spend, so
  cost_grants_within_ceiling holds). `request_journal_reserves_grant` refuses any reservation on a grant whose pool has an
  OPEN liability. `reconcileRequest` (GRANT_RECONCILIATION) becomes idempotent on equal value and routes excess the same way.
  Clearing a liability is an owner/ops act -> PARTIAL B12 (until then the pool fails safe). Settle after cancel is allowed (06).
- **D5-13 Run id.** Journal run_id = the audit UUID; adapter asserts `RunLedger.runIdFor(auditAttemptId, tenant)` for every
  ledger call (other id -> refuse), writes it to core_run_id, and cancels with it. tenant = {agencyId, clientId: projectId}.
- **D5-14 IC inputs.** `CoreDocumentPort` (application port; persistence impl in L3d, table `kauro.core_documents` keyed by
  (agency, kind, core-native hash), retention of the revision's derived data, 09): PROFILE stores the HashedSourceProfile;
  candidate set and target contract stored by hash. projectRevision = {revisionId, revisionHash, mode (CLEAN_ONLY<->CLEAN
  bridge), supportEnvelopeVersion pinned}; declaredObjects/recordIdColumns/localeEvidence absent (IC resolves or asks:
  NEEDS_DECISION) until the agency-facts feature (PARTIAL B11); scopedMemorySnapshot []; policyBundle pinned;
  resourceProfile.wallClockMs = remaining interpretation window. A missing or mismatched document -> FAILED
  PROFILE_EVIDENCE_MISSING, no dispatch.
- **D5-15 Full-dataset validation.** IC `validationPort` -> `MigrationCoreAdapter.validateFullDataset(configuration, controls)`:
  child loadConfig (coreConfigHash), runMigration, writePackage, verifyPackage(stagingDir), IC `effectsFromMigrationRun` in
  the child; answers FullDatasetValidationResult with packageDigest, reportDigest, effects, validatedAt by the shared clock.
  Bounded by the absolute audit deadline (8 h engine cap). The platform VALIDATE step still issues its own receipt.
- **D5-16 Plan binding.** PlanCompilerPort.compile stores (planHash -> CandidateConfiguration, coreConfigHash) in
  CoreDocumentPort; execute/validate translate only through that binding; PlanBody digest recomputed by the platform.
- **D5-17 Egress key.** `deps.egressKey` from the deployment secret (stable keyId, >= 32 bytes), injected by composition;
  tests use a labelled test key; never logged (B14 secret provisioning).
- **D5-5 Input layout.** path = `input/<sha256(canonical {domain:"KAURO_CORE_INPUT_PATH_V1", objectName, generation})>`;
  read config (format, encoding, delimiter, sheets) from the sealed revision's stored facts via CoreInputResolver(revisionHash),
  the same function for profile, compile and execute.
- **D5-6 Wrappers** re-export every core root export; additions only from `src/wrapper-additions.ts` (allowlist:
  `assertCanonicalAgreement`, core-native identity helpers).
- **D5-7, D5-8, D5-9, D5-10** as r1 (CRM REFUSED until B15; cause mapping; fake tokens unchanged; evidence class).

## 2. Case map
| S045 | EXECUTED_LOCAL MC half; PARTIAL -> L4 for the IC half | K01-K04, clean-consume log (Win+Linux), M01, T01-T03 real |
| S046 | EXECUTED_LOCAL | A01-A04 |
| S047 | EXECUTED_LOCAL on the provisional pin; PARTIAL -> L4 | C01-C04 (presealed digests, independent Python oracle) |

## 3. Failure matrix (G:x = GAP closed by test x first; T1 = tier 1; N/A with reason)
Cols: RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL
**MC-EXEC**
- E0 guard+dirs: G:M12 | N/A local mkdir | G:M08 | G:M18 (residue in attempt subtree) | G:M18 | G:M11 | G:M07 T1 | G:M11
- E1 materialize: N/A sealed generations, mismatch DENY M13 | G:M09 hung chunk | G:M08 | G:M18 | G:M18 | G:M11 | G:M07 T1 | G:M13
- E2 child run: G:M12 | G:M08 | G:M08 | G:M02 | G:M10 | G:M11 | G:M06, G:M07 T1 | G:M03
- E3 write->verify(stagingDir)->promote: N/A child-private dirs (M12) | G:M08 | G:M08 | G:M10 | G:M10 | G:M11 | G:M06, M07 T1 | G:M04, G:M20, G:M03b
- E4 stage: G:M07 held at close k T1 | G:M08 hung write/close | G:M08 | G:M18 + PARTIAL B14 (manifest never written, D8-STG-3) | same | G:M11 | G:M07 T1 | G:M05
- E5 cleanup: N/A attempt-owned | N/A local rm | N/A after terminal | G:M18 | G:M18 | N/A | N/A | G:M17
**MC-PROFILE (P1), MC-VALIDATE (Q1), MC-VERIFY (V1), MC-FULL-VALIDATION (F1)** each its own row, same cells:
- G:M12 | G:M16a/b/c/M22 hung read or child | same | G:M19 (step orphans) / M18 | G:M19 | G:M16 retry gets a new callId dir, equal core hashes | G:M16 cancel/fence | V1 G:T01, F1 G:M22, P1/Q1 G:M03b
**IC-INTERPRET**
- J0 seed read: G:I02 | G:I06 | G:I06 | N/A read | N/A read | G:I07 | G:I02 | N/A one read
- J1 buffered append: N/A one sync run per call | N/A memory | N/A | G:I04 T1 | N/A | G:I03 | G:I12 sticky | N/A
- J2 barrier flush: G:I02 both orders T1 | G:I06 T1 | G:I06, I12 T1 | G:I03 | G:I03 T1 | G:I03 | G:I02, I12 T1 | G:I02 T1
- J6 admit (task+intent): G:I04 both orders T1 | G:I12 late admit dropped then RELEASED T1 | G:I06 T1 | G:L01 T1 | G:L02 T1 | G:L02 T1 | G:I05, L05 T1 | G:L03 T1
- J7 settle (request, grant, liability): G:L04 settle vs GRANT_RECONCILIATION both orders T1 | G:I08 T1 | N/A settle allowed after cancel/expiry (06) | G:L03 T1 | G:L02 T1 | G:L02 T1 | G:L06 T1 | G:L03 T1
- J8 liability guard on reservation: G:L05 admission racing a liability insert both orders T1 | N/A trigger in the insert | G:L05 T1 | N/A one statement (DENY L05) | N/A | G:L05 T1 | G:L05 T1 | N/A one statement
- J4 outcome map: G:I05 T1 | N/A pure | G:I05 | N/A no write | N/A | G:I07 | G:I05 T1 | N/A pure
- J9 inputs + docs: G:I14 | G:I06 | G:I06 | N/A read | N/A read | G:I07 | N/A | G:I14 (one document missing)
- J5 compile/planCandidates: N/A pure, no spend (8 cells); DENY I09, I10, I15; OK T04

## 4. Tests (`<B>` = binding name; files: MCA data-plane/test/cores/migration-core-adapter.test.ts; CPF/CPR core-port-contract
fake/real; ICA application/test/cores/intelligence-adapter.test.ts; IJR apps/control/test/b05-interpret-journal.test.ts; LDG
persistence/test/b05-dispatch-settlement.test.ts; VC tools/test/vendor-cores.test.mjs; AG tools/test/architecture-gate.test.mjs;
CI intelligence-core/test/canonical-interop.test.ts)
- M01-M17 as r1 except: M03 "RACE (scratch full): a child store quota below the run's need answers SCRATCH_EXHAUSTED before a byte passes it; nothing staged"; M04 "RACE (partial): verifyPackage refusing writePackage's stagingDir, or a parent re-hash mismatch, answers CORRUPT_INTERMEDIATE; the staging dir is discarded and nothing promoted or staged"; M08 "RACE (expiry): the operation deadline fixed at entry ends a hung open, chunk, write, close or child with SIGKILL; late results are dropped; spawn and retry never restart it"; M09 "RACE (timeout): a SourceHandle chunk that never arrives is abandoned at the deadline; no child starts"
- M03b (MCA) "RACE (scratch full): inputs, run segments, writePackage staging, verify scratch and spools never together exceed the budget at any phase boundary; a package overshoot discards staging and answers SCRATCH_EXHAUSTED"
- M16a/b/c (MCA) "RACE (profile|validate|verify bounds): without controls the adapter rejects; with them a hung read or child is killed at the deadline, cancellation ends it, and a retry uses a new callId directory with equal core hashes"
- M18 (MCA) "RACE (crash residue): a parent killed in E0..E5 leaves everything under kauro-attempt-scratch-<attemptId>, and removeAttemptScratch removes inputs, run, package and package.kauro-staging"
- M19 (MCA) "RACE (crash residue): removeOrphanStepScratch removes a dead step's profile or validate scratch and never a live one"
- M20 (MCA) "OK E3: verifyPackage runs on WritePackageResult.stagingDir, promotePackage moves it, and staging enumerates the promoted dir"
- M21 (MCA) "DENY layout: two generations with identical bytes get distinct input paths; profile, compile and execute paths are equal for one revision"
- M22 (MCA) "OK F1: validateFullDataset returns IC's receipt with packageDigest, reportDigest, coreConfigHash equal to loadConfig's and effects; a refusal maps to ok false"
- T01-T04 as r1.
- I01-I11 as r1 except I02 adds "and an authority check failing after a successful flush refuses the barrier"
- I12 (ICA) "RACE (revocation at a barrier): cancellation, deadline or fence observed before or after a flush refuses the barrier stickily; a later append, barrier or admit is refused and a late continuation is dropped"
- I13 (IJR) "OK run id bridge: journal run_id is the audit UUID, each request names runIdFor(auditAttemptId, tenant), cancel uses it, and a ledger call for another run id is refused"
- I14 (IJR) "DENY inputs: a missing or hash-mismatched profile, candidate set or target document fails PROFILE_EVIDENCE_MISSING before any reservation"
- I15 (ICA) "DENY plan binding: execute or validate of a plan with no stored CandidateConfiguration, or whose loadConfig hash differs from the bound coreConfigHash, is REFUSED"
- L01 (LDG) "RACE (crash before COMMIT): admission rolled back after the model task insert leaves no task, no intent and no reserved cents"
- L02 (LDG) "RACE (retry, crash after COMMIT): admit and settle replayed with the same key return the recorded result with one reservation and one posting; another body is SETTLEMENT_CONFLICT with no write"
- L03 (LDG) "RACE (partial): a failure at the grant update or the liability insert rolls back the request row, the grant and the liability"
- L04 (LDG) "RACE (settle vs GRANT_RECONCILIATION, both orders): one posting, the other a replay or conflict; spend and reserved cents equal the hand-computed values"
- L05 (LDG) "RACE (liability): a charge 1 micro above the reservation opens a liability of exactly that excess, spend stays within the ceiling, and any reservation on the pool is refused NO_FUNDED_GRANT in both orders"
- L06 (LDG) "DENY settlement: RELEASED for a request that reached DISPATCHING stays AMBIGUOUS; usage_known false posts ESTIMATED and the grant cannot close"
- K01-K03 as r1; K04 (VC) "S045 OK: each wrapper exports every root export of its core plus exactly the wrapper-additions allowlist, and the installed core files equal the tarball's"
- A01-A04 as r1.
- C01 (CI) "S047 OK: for values the platform hashes structurally, Unicode (NFC and NFD distinct, astral, escapes), large integer strings and ordered arrays give identical bytes under canonicalize and IC canonicalJson, equal to the presealed digests"
- C02 (CI) "S047 DENY: code-point vs UTF-16 key order, lone surrogate, unsafe integer or undefined member: refused by the platform or assertCanonicalAgreement; never two silent digests"
- C03 (CI) "S047 OK: MC-native hashes of a Unicode/large-integer profile and candidate set are recomputed only by MC's loaders, stored verbatim, and a platform digest of a record citing them carries them as strings"
- C04 (CI) "S047 DENY: re-hashing a core-native identity with the platform profile, or a platform digest with canonicalJsonText, is refused by the identity bridge"

## 5. Lanes (file ownership; `b05/<lane>`; worktrees `repos/pw-b05-<lane>`; migrations take the next free number, renumbered at merge)
| Lane | Files owned | Tests | Est (tokens/min), model |
|---|---|---|---|
| L0 kit (RUNNING) | as r1 + `packages/*-core/src/wrapper-additions.ts` | K01-K04, A01-A04 | +20k/10 for K04 retitle; total 440k/170 |
| L1 mc-adapter (after L0) | data-plane src/cores/** (+ `removeOrphanStepScratch`), src/index.ts, package.json, README, scratch-store.ts comment, test/cores/**; application ports/core-ports.ts (optional controls + comments), new ports/core-inputs.ts (CoreInputResolver, CoreDocumentPort), testing/core-port-contract.ts, testing/cores.ts, test/core-port-contract.fake.test.ts, contract-fake-migration-core.ts comment | M01-M21, T01-T03 | TD Opus 220k/75 + Sonnet 600k/260 |
| L1v full-validation (after L1) | data-plane src/cores/full-dataset-validation.ts, child-task.ts (handed over by L1), test/cores/full-validation.test.ts | M22 | TD 120k/40 + Sonnet 300k/120 |
| L2 canon (after L0) | intelligence-core src/canonical-agreement.ts, test/canonical-interop.test.ts, fixtures, tools/canonical-oracle.py | C01-C04 | TD 70k/30 + Sonnet 120k/50 |
| L3m money (now) | persistence migrations/00NN_dispatch_settlement.sql, src/audit/store.ts, domain ports/audit-store.ts, model/audit/grants.ts, persistence/test/b05-dispatch-settlement.test.ts | L01-L06 | TD Opus 200k/70 + Sonnet 450k/200; Codex lane review |
| L3d control-docs (after L1 ports) | persistence migrations/00NN_core_documents.sql, src/audit/core-documents.ts, src/source/core-inputs.ts, test/b05-core-documents.test.ts; apps/control/src/audit/orchestration.ts (store profile, pass controls), the verifier caller in apps/control/src/execution/** | I14 part, M16 callers | TD 150k/50 + Sonnet 350k/150 |
| L3 ic-adapter (after L0, L3m, L3d) | application src/adapters/cores/intelligence/**, src/index.ts, package.json, test/cores/**, testing/core-port-contract-intelligence.ts (+ cores.ts line after L1); apps/control/test/b05-interpret-journal.test.ts | I01-I15, T04 | TD 220k/75 + Sonnet 500k/220; Codex lane review |
| L4 ic-pin, L5 close | as r1 | | 40k/30; 150k/45 |
Total ~3.9M agent tokens (r1 2.1M), ~27 agent-hours; wall ~3 days with L1 || L3m || L2 now, then L1v || L3d, then L3.

## 6. Context packets (each <= 3k tokens)
- L1: core-ports.ts 144-301; data-plane sandbox/runner.ts 1-132, child.ts 1-60, attempt/scratch-store.ts 8-20, 44-132,
  159-200, failure.ts; worker-host.ts 78-94, 214-227; core-port-fakes.test.ts 36-240; MC write-package.ts 32-66, 82, 216-260,
  verify-package.ts 424-472, run-migration.ts 66-153, load-config.ts 61-125, source-profile.ts 121-226. Harness: own clock +
  named hold points (FaultPoints pattern); data-plane cannot import persistence.
- L3m: 0023_audits_cost_grants.sql 70-120, 180-300; persistence src/audit/store.ts 540-600; domain ports/audit-store.ts
  200-240, model/audit/grants.ts; IC kernel/admission.ts 1-63; harness `@kauro/persistence/testing` (`bothOrders`, `mustWait`,
  `FaultPoints.crashableFactory`, `faultCell`, `controlledClock`); hand-computed cents/micros table in the test.
- L3d: orchestration.ts 230-275, 277-300; persistence src/audit/journal.ts; B07 stored facts (`storedTableFacts`).
- L3: core-ports.ts 336-400; persistence audit/journal.ts 1-33; orchestration.ts 277-330; grant-reconciliation.test.ts 1-90;
  IC ports/ports.ts 21-100, 223-300, 329-375; kernel/ledger.ts 101-125, 348-372; api/intelligence-core.ts 594-610, 700-830,
  1755-1800.

## 7. Waits, acceptance touch, risks
- IC 0.6.0 release (D-14 by 10-12, then B04 campaign): L4, IC halves of S045/S047, L5. B02 ACCEPTED: B05 stays REVIEW_ACCEPTED.
- Later packages named: B12 liability clearing; B11 agency project facts; B14 manifest-crash cells and egress secret; B15 CRM
  attestation.
- Acceptance touch (B08 REVIEW_ACCEPTED, list in Codex prompts): core-ports.ts, audit-store.ts, grants.ts, persistence
  audit/store.ts, orchestration.ts, verifier caller, data-plane scratch-store.ts comment; two new migrations.
- Risks: D5-3 fail-closed on astral/private-use keys until IC aligns; D5-15 runs full-data MC twice per audit (IC's validation
  + VALIDATE step), cost noted for B17; L3 waits on L3m and L3d.
