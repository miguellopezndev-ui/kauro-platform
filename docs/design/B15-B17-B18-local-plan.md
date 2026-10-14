# B15 / B17 / B18: plan for the locally buildable cases (base origin/main 8354d7be, 2026-10-14)

Scope: the cases on main whose ids no test title names: B17 R2-018..R2-026 and S078; B18 S079, S080, S088, R2-113 and R2-114; B15 R2-061, R2-084, R2-133 and CMD035-OK/DENY/RACE.
Verdicts: (a) a test already covers the case and only the id is missing from its title or the case map; (b) the case can be built locally with fakes, giving SIMULATED or EXECUTED_LOCAL evidence, with the live half PARTIAL to a named package; (c) the case needs a real provider or an owner act and is BLOCKED.
Totals: **a = 2, b = 19, c = 4**. Of the 19 (b) ids, 1 is deferred until an in-flight branch merges.
Abbreviations used below:
- Files: T0 = `apps/api/test/cmd040-cmd041-import-stage.test.ts`, SSR = `packages/application/src/audit/handlers/submit-stage-receipt.ts`, CST = `.../audit/handlers/continue-stage.ts`, IS = `packages/domain/src/model/import-stage.ts`, ISR = `packages/persistence/src/repositories/import-stages.ts`, RT = `packages/application/src/commands/runtime.ts`.
- Rule numbers (r11a, r15 and so on) refer to the numbered family rules of `docs/design/FAILURE-MATRIX-TEMPLATE.md`.

## 1. Verdict table (this table is the case-map skeleton)
| id | v | evidence (file:line) or dependency | test `file :: "title"` (live half) |
|---|---|---|---|
| R2-018 | b | No platform check exists. Plans that match on the native Record ID are blocked unless a native-ID receipt bound to the instance is present; none can exist today. | T2g :: "R2-018: DENY a native Record ID identity without an instance-bound native-ID validation receipt (IMPORTER_PROFILE_NATIVE_ID_UNVALIDATED)" (per-record membership is PART to B14 worker-host; live is PART to D-11) |
| R2-019 | b | GAP. No gate exists. | T2g :: "R2-019: DENY Record ID plus a secondary email on one object (IMPORTER_PROFILE_SECONDARY_EMAIL_WITH_RECORD_ID)" (live PART to D-11, D-12) |
| R2-020 | b | GAP. | T2g :: "R2-020: DENY a replacing intent on a MULTI_ENUM or association field under an add-only importer profile (IMPORTER_PROFILE_REPLACEMENT_UNQUALIFIED)" (the export-back compare is PART to D-11, D-12) |
| R2-021 | b | GAP. MC 3.0.0 relationship types are single level, but the platform has no gate of its own. | T2g :: "R2-021: DENY a grandparent dotted reference at plan validation (IMPORTER_PROFILE_RELATIONSHIP_DEPTH)" (live PART to D-12) |
| R2-022 | b | GAP. | T2g :: "R2-022: DENY a TEXT write or CLEAR under a profile whose null marker is a literal token (IMPORTER_PROFILE_NULL_MARKER_COLLISION)" (live PART to D-12) |
| R2-023 | b | GAP at CST:71-73: a parent's VERIFIED_PARTIAL state is accepted without checking which child edges depend on its failed rows. | T1 :: "R2-023: OK eight of ten parents bind; child edges of the two failed parents are BLOCKED_BY_PARENT; all ten parent dispositions stay" and T1 :: "R2-023: DENY a child receipt that claims MATCHED for a blocked child (CHILD_EDGE_BLOCKED)" |
| R2-024 | b | GAP at SSR:63-71: the receipt document carries no binding to its stage, so a foreign stage's receipt with the same source ids is accepted. | T1 :: "R2-024: DENY a success receipt of another stage with the same rows (RECEIPT_FOREIGN_STAGE), nothing recorded" |
| R2-025 | b | GAP at SSR:67 and SSR:55: identical bytes are refused with 409, and a differing receipt on a finalized stage is refused with STAGE_NOT_AWAITING. | T1 :: "R2-025: OK identical receipt content is idempotent on any key; a differing receipt for a finalized stage opens one reconciliation and never overwrites identity" |
| R2-026 | b | GAP: nothing on main writes `target_contracts.superseded_at`; the only check is the TARGET_STALE refusal at `execute-project.ts:125`. | T3 :: "R2-026: OK confirming a newer contract that lost an approved allowed value supersedes the old one, shows the consequences and the included paths; execution pauses with no charge" (B14 worker re-check PART; the refund-path execution is DEFERRED, see section 7) |
| S078 | b | GAP: `change-capability.ts:62` stores the evidence refs without resolving them. | T4 :: "S078: DENY a capability version whose qualification evidence is of another tool or profile (QUALIFICATION_TOOL_MISMATCH) or lacks export-back" (real Data Loader run PART to D-12) |
| S079 | b | GAP: no tool freezes or compares release candidates. | T5r :: "S079: DENY promotion of a rebuilt image digest under the approved candidate's evidence" (real image digests PART to B19, D-14) |
| R2-113 | b | GAP. | T5r :: "R2-113: DENY an identical source tree with a changed dependency lock or core hash; OK only with an EquivalenceReceipt naming exactly that input" |
| S080 | b | GAP: no exact-run verifier exists. The pipe census is 2 pipes, both in bash with pipefail (`verify.yml:94` and `:116`). | T5c :: "S080: DENY a same-named or older-sha check run, a skipped or neutral run, and a pipe that drops exit 1" (real runs at B18 close) |
| S088 | b | GAP: no deletion-ownership check exists. The census found 6 rmSync sites (listed in section 2). | T5o :: "S088: every recursive delete in tools/ removes a mkdtemp path of its own function or a workspace dist; a broad delete fixture is refused" |
| R2-114 | a | Covered by `tools/test/audit-kit.test.mjs:364`, `tools/test/red-proof.test.mjs:130` and `red-proof.test.mjs:147`. | Prefix "R2-114: " to those three titles (the rest of each title is unchanged). EXECUTED_LOCAL. |
| R2-061 | a* | Covered only on pv1/refund-build, at `apps/api/test/ach-refund-cells.test.ts:558` (G6-RACE) and `:655` (P3-RACE). That branch is not on main. | DEFERRED until pv1/refund-build merges; then prefix the id and fix CV-3. The webhook half is DEFERRED with the parked rail (`ACH-ROUTE.md:196-199`, DV1-09). |
| R2-084 | b | GAP: `observe` is a stub (`evidence-and-services.ts:122-125`). | T6 :: "R2-084: RACE (timeout) an invoice issued before the timeout and listed on page 3 is found by exact identity before any replacement" (live PART to R2-083 Alegra, D-14) |
| CMD035-OK | b | No handler exists. `ports.ts:213-245` already defines `submit` and `observe`. | T6 :: "CMD035-OK: FISCAL_SERVICE issues a VALIDATED document; legal number, provider id and evidence recorded; ISSUED" (route PART to L6-W) |
| CMD035-DENY | b | Same as CMD035-OK. | T6 :: "CMD035-DENY: a foreign role or agency, an unreviewed treatment, a profile or issuer mismatch, a missing entitlement and an unreconciled prior submission write nothing" |
| CMD035-RACE | b | Same as CMD035-OK. | T6 :: "CMD035-RACE: the same key replays, a conflicting key is refused, two issuers on one document yield one submission, crash after the SUBMITTING commit reconciles" |
| R2-133 | b-DEF | The NOTIFICATIONS consumer does not exist on main. It needs pv1/caveats (control dispatcher) and the B12 L-SEND sender. | DEFERRED; see section 7. |
| S033, S077 | c | BLOCKED_OWNER. They need real large-profile runs on AWS (D-14 company NIT, then the account). | none |
| R2-082 | c | BLOCKED_OWNER: the tax treatment is an owner fiscal decision. | none |
| R2-083 | c | BLOCKED_OWNER: the Alegra purchase is an owner money act. | none |

Outside this list:
- R2-085 is owned by PV1-SETTLE (`pv1/settle docs/design/PV1-SETTLE-two-step.md:19`).
- CMD018/019/040/041/058/059 are already on main.
- After the ids are added, T0 keeps CMD040/041 and gains an R2-025 rewrite (conflict X1).

## 2. Authority first: R2 quote, then an input-only predicate and its census
- **R2-024.** 05:103 "Kauro validates that the receipt belongs to the purchased stage, maps every successful source parent to one target ID, rejects duplicate or foreign mappings". Predicate: row r on stage s is foreign when `r.correlationKey != stageCorrelationKey(s.stageId, s.packageHash, r.sourceId)` (sha256 canonical, domain `KAURO_STAGE_CORRELATION_V1`). Census: receipt producers in src = 0 (T0 fixtures only); validator callers = 1 (SSR:71).
- **R2-025.** 05:115 "A duplicated receipt upload is idempotent by stage and content hash. A different receipt for a finalized stage becomes a reconciliation request, not an overwrite." Predicates: `hasReceiptFile(stage, contentHash)` = idempotent; state in {VERIFIED_SUCCESS, VERIFIED_PARTIAL} with a new content hash = reconciliation. Census of contradicting main assertions: 3 (T0:248, :262, :288).
- **R2-023.** 05 "VERIFIED_PARTIAL records exactly which source units succeeded and which failed. Dependent stages can proceed only for an approved subset with complete parent identities; the omitted dependencies remain explicit exceptions." Predicate: a child source is admitted only when every edge `{parentStageId, parentSourceId}` of its `parent_edges` is MATCHED in that parent's latest receipt mapping.
- **R2-019.** 05 "A secondary contact email combined with Record ID can affect the primary email, so that combination requires a dedicated transformation decision and qualification case; it is never emitted accidentally". Predicate: the plan maps object O to `profile.recordIdField` AND to a field of `profile.secondaryEmailFields[O]`; V1 has no qualification case, so it blocks. Census: 1 catalogue profile has both (HUBSPOT_IMPORT_UI contacts: `hs_object_id`, `hs_additional_emails`).
- **R2-021.** 05:75 (referenceTo, relationshipName) and 05 "this is not permission to traverse arbitrary relationship depth." Predicate: hop separators (`.` or `:`) in `targetField` or `relationType` > `profile.maxRelationshipDepth` (1 for every profile).
- **R2-022.** 05:91 "Omitted fields, blank fields and explicit null markers are tested separately... cannot be copied blindly"; 05:93 "A clear operation is unavailable until that exact setting and representation pass." Predicate: `profile.nullMarker != null` AND (TEXT target with intent KEEP or SET, OR intent CLEAR). Census: 1 profile has a marker (SF_BULK_API2, not offered); on HubSpot and Data Loader "#N/A" stays literal data.
- **R2-020.** 05:43 "Multi-select replacement and append have separate primitives and emitted forms." Predicate: intent SET or CLEAR on a MULTI_ENUM field or a REFERENCE label field while `profile.multiEnumEffects` or `associationEffects` is exactly ["ADD"].
- **R2-018.** 05:27 "The agency portal ID is part of every target reference." Predicate: a native identity (resolution TARGET_NATIVE_ID, or a mapping to `profile.recordIdField`) AND no native-ID receipt for `instanceId`. Census of producers of that receipt: 0, so every such plan blocks (conservative reading).
- **S078.** 05:69 "an API-only test cannot certify a different Data Loader workflow"; CMD058 precondition "Independent acceptance covers the exact object/operation/importer/resource envelope". Predicate: each ref resolves to a `vendor_qualifications` row with `profileHash = body.profileHash`, `tool` = the profile's tool, result PASS and a non-null `exportBackHash`. Census of CMD058 callers in tests: 2 (cmd058-cmd059-capabilities, response-contract).
- **R2-026.** Case text "Pause affected execution, show scope consequences and provide included repair/refund/new-scope paths without an automatic extra charge"; 05:121 "a previously approved CRM plan does not automatically survive." Predicate: newer.confirmed AND some (object, field, value) of the approved plan's SET or enum mappings is missing from `newer.allowedValues`.
- **S079 / R2-113.** 21 "Build once and promote the same image digest into staging and production"; 21 "Reuse is permitted when an EquivalenceReceipt demonstrates that all transitive inputs relevant to the claim are unchanged or semantically equivalent"; registry ReleaseCandidate "A changed dependency or image produces a different candidate even with identical source text."
- **S080.** 21 "CI must correspond to the final accepted commit, including merge results and relevant workflow attempts." Predicate: per required context, the latest check run with `head_sha` = candidate has conclusion success; skipped and neutral fail.
- **S088.** Case text "only owned disposable intermediates can be routinely cleaned." Census (6 sites): `clean-consume.mjs:131`, `prepare-fast.mjs:42`, `red-proof.mjs:49`, `red-proof.mjs:99` (pkg dist), `test-runner.mjs:115`, `test-runner.mjs:300`.
- **R2-114.** 21 "Harness syntax errors, missing dependencies or unrelated crashes do not count as successful sabotage detection." Already enforced by E_RED_PROOF_HARNESS (`tools/audit/lib/red-proof.mjs`).
- **CMD035 / R2-084.** 15:141 "A timeout after issuance is reconciled before another document is created... The adapter does not assume a list endpoint's first thirty results contain the desired document; pagination and exact identity lookup follow the actual API contract." Predicate: REJECTED or a replacement only on `observe() = NOT_FOUND` with `absenceIsProof = true` after every page was read.
- **Clock sources of new product code:** only `effectNowOf(uow)` (`domain/ports/unit-of-work.ts:154` = `kauro.effect_now()`, 0038:12) and `kauro.server_now()` in SQL stamps; 0 app `Date.now`/`new Date` in new src; `tools/release-candidate.mjs` makes no time judgments. Pre-existing r15 defect: `uow.serverInstant()` is `transaction_timestamp()` (0009:42), read before the lock wait, and judged at SSR:51, CST:55 and in `confirm-target-contract.ts` (freshness); L1 and L3 move these to `effectNowOf` after the last lock.

## 3. Failure matrices (cells are C (covered), GAP, or N/A with a reason)
Pipeline locks in order for every request command:
1. `authorizer.authorize`, which holds the membership transition lock (RT:246);
2. the journal reserve on the identity index (RT:250);
3. `assure` (RT:264).
After those come the handler locks listed per table. Every GAP below gets its test first. Tiers: 1 means money or authority; 2 means identity or integrity.

**M1 CMD040 SubmitStageReceipt (R2-024, R2-025, R2-023 child side).**
Lock trace:
1. the pipeline locks above;
2. the stage row, ISR:131 (`FOR UPDATE`, changed to `FOR NO KEY UPDATE` per r11a; receipt and reconciliation foreign keys take KEY SHARE);
3. parent rows `FOR SHARE`, in ascending stage_id order (new; r16);
4. `effectNowOf`;
5. the write.
| row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| append revision + advance | GAP: hold A at ISR:131 and run B with other bytes, both orders: the winner records 1 revision, the loser opens 1 reconciliation (T1 "R2-025: RACE ...") | GAP: a lock wait past INJECTED_STATEMENT_TIMEOUT_MS (faults/bounds.ts:26) is refused as retryable with nothing recorded; a retry on the same key returns the committed result | GAP: delay `getArtifact` past expires_at; the r15 judgment refuses STAGE_EXPIRED (T1 "R2-025: RACE (expiry) ...") | GAP: crash after appendReceipt, before COMMIT: 0 revisions | C, journal replay (T0:266) | GAP: identical content under a new key returns 200 with the same revision; same key with another body gives IDEMPOTENCY_CONFLICT (C, T0:266) | C, membership lock RT:246 (T0 DENY VIEWER) | GAP: fail `advance` after the append and assert the whole footprint is rolled back |
| reconciliation insert (new) | GAP: two differing receipts on a finalized stage, held at the stage lock, both orders: 1 row per content hash, the identity mapping unchanged | N/A, a single insert under the held lock | GAP: a deadline that passes while waiting refuses (r15) | GAP: crash before COMMIT leaves 0 rows | C, replay | GAP: the same differing bytes again return the same request (unique on stage and content hash) | as above | N/A, one statement (DENY: append-only trigger) |
| child bind (R2-023) | GAP: hold the parent's CMD041 at its lock; the child's FOR SHARE waits; both orders | N/A | GAP: a parent that expires during the wait refuses PARENT_STAGE_NOT_VERIFIED | covered by the append row | C | C | as above | N/A |
| correlation check (R2-024) | N/A, pure over the locked row | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

**M2 CMD041 ContinueStage (R2-023, R2-025).**
Lock trace: the pipeline locks; the stage at ISR:131 (NO KEY); parents `FOR SHARE` in ascending order (new, replacing the unlocked `getMany` at CST:71); `effectNowOf`; continue.
- RACE GAP: a parent reconciliation insert against the child's continuation, both orders. The child continuation refuses PARENT_IDENTITY_UNDER_RECONCILIATION; the fix is the FOR SHARE, and removing it turns the test red.
- EXPIRY GAP: a parent deadline that passes during the wait.
- Other cells are C through the T0 CMD041 tests (RETRY T0:399, REVOCATION by the membership lock); PARTIAL is N/A (single advance).

**M3 PLAN_VALIDATION importer-profile gate (R2-018..R2-022).**
- The gate is pure, inside `PlanValidator.run` (`apps/control/src/audit/receipts.ts:199`), before the core call and with no transaction.
- RACE, CRASH and PARTIAL are N/A: a CONTRACT_FAILURE writes nothing, and the consumer `plan-validation.ts` returns the plan to VALIDATION_REQUIRED as on main.
- REVOCATION: N/A, covered by the existing consumer.
- RETRY C: the same intent re-delivered yields the same CONTRACT_FAILURE (T2g "R2-018..022: RETRY ..."). Removing the gate turns all five DENY tests red.

**M4 CMD019 supersession (R2-026).**
Lock trace:
1. the pipeline locks;
2. the project row `FOR NO KEY UPDATE` (`workspace.ts:266`; new in CMD019, taken first);
3. the contract `lockLifecycle` (`workspace.ts:444`, NO KEY);
4. the prior confirmed contracts, ascending, NO KEY;
5. the UPDATE of `superseded_at`, which fires `take_transition_lock` exclusive (0003:262).
ExecuteProject takes `projects.lock` (`execute-project.ts:56`), then the shared transition lock of the target (`:99`). Both commands lock the project first, so there is no cycle.
| row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| confirm + supersede prior | GAP: ExecuteProject held at `:99` against CMD019, both orders: either QUEUED on the old contract before supersession, or TARGET_STALE; never a job bound to a superseded target after the supersession commits (tier 1) | GAP: a lock wait past INJECTED_STATEMENT_TIMEOUT_MS is refused as retryable with nothing written; a retry on the same key gives the committed answer | GAP: freshness judged with `effectNowOf` after the locks (r15) | GAP: crash after the supersede UPDATE, before COMMIT: both rows unchanged | C, replay | GAP: two confirms of two newer contracts of one project, held at the project lock: the later observation wins, the older is refused TARGET_STALE | C (existing CMD019 DENY) | GAP: fail the second supersede: no half-superseded set |
| TARGET_STALE consequences (ExecuteProject) | covered by the row above | N/A | N/A | N/A | N/A | C | C | N/A. Money tier 1: the refusal keeps the authorization ACTIVE, no charge, no entitlement consumed (`execute-project.ts:17-18`); a test asserts the amount and the state (r10). |

**M5 CMD058 qualification resolution (S078).**
- Lock trace: the pipeline locks; the capability `FOR UPDATE` (as on main); a read of `vendor_qualifications`, which is insert-only and immutable, so it needs no lock.
- RACE N/A: the evidence never changes after birth (DENY: immutability trigger).
- Other cells: as on main (T0 for CMD058); PARTIAL N/A.
- The DENY tests cover each predicate alone (r12): UNKNOWN, TOOL_MISMATCH, PROFILE_MISMATCH, NO_EXPORT_BACK, FAILED.

**M6 CMD035 IssueTaxDocument (CMD035, R2-084).** Every GAP here is tier 1 (money and fiscal).
Lock trace:
1. the service journal reserve;
2. the document row (`commerce-finance.ts:175`, `FOR UPDATE`, changed to `FOR NO KEY UPDATE`: correction foreign keys at 0017 take KEY SHARE; the census of callers is 0);
3. the fiscal profile shared transition lock (`commerce-platform.ts:187`);
4. `effectNowOf`.
| row | RACE | TIMEOUT | EXPIRY | CRASH-BEFORE | CRASH-AFTER | RETRY | REVOCATION | PARTIAL |
|---|---|---|---|---|---|---|---|---|
| T1: VALIDATED to SUBMITTING with issue_request_hash | GAP: two issuers held at the document lock, both orders: 1 submission, the loser gets PAYMENT_PENDING | GAP: a lock wait past INJECTED_STATEMENT_TIMEOUT_MS is refused as retryable with nothing written; a retry on the same key gives the committed answer | N/A (no deadline; the entitlement is a fact) | GAP: crash before COMMIT: VALIDATED, no hash, no submit call | GAP: crash after COMMIT: the retry finds SUBMITTING and observes, never submits again | GAP: same key replays; conflicting key refused | GAP: profile re-review in flight (shared transition lock) | N/A, one UPDATE |
| port `submit` | N/A | GAP: a timeout leads to T2 UNCERTAIN | N/A | N/A | N/A | N/A | N/A | N/A |
| T2: conclude ISSUED / REJECTED / UNCERTAIN | GAP: an observer against the concluder, both orders: one terminal state | N/A | N/A | GAP: crash before COMMIT: SUBMITTING stays, the reconciler observes | GAP: crash after COMMIT: replay gives 200 ISSUED | GAP: a duplicate observation is a no-op | N/A | GAP: fail the ledger or event write after the state change: full rollback |
| port `observe`, paged (R2-084) | N/A | GAP: a timeout on page k means not proven, UNCERTAIN stays | N/A | N/A | N/A | GAP: a re-observe re-reads every page | N/A | GAP: a partial page set never counts as proof of absence |

**M7 release tools (S079, S080, R2-113, S088).** These are pure CLIs over fixture JSON and write only their own report. RACE, TIMEOUT, CRASH, EXPIRY, REVOCATION and PARTIAL are N/A (no shared state). RETRY is C because the tools are deterministic (the same input gives the same verdict).

## 4. Lanes (by file ownership; no two lanes edit one file)
Shared rules for every lane:
- Provisional migrations: 0090 (L1), 0091 (L3), 0092 (L4). They are renumbered at merge; the main max is 0070.
- **KA codes: 0 claimed.** The guards use 23514 (precedent `0050_b17_target_contracts.sql:19-31`) and the existing `forbid_column_change` and append-only helpers. Census: KA001-094 on main; B12 plan KA095-097; KP014 on refund-build. The next free code, KA098, is not claimed, so `ka-codes.test.mjs` is unchanged.
- Builder: claude-sonnet-5-5. Test-designer: Opus. Tests are written first (red), and red-proof runs before review.

| lane | branch | files owned | cells | est. (agent tokens / min) |
|---|---|---|---|---|
| L0 KIT | b17/kit-maps | new `docs/design/{B15,B17,B18}-case-map.md` (the rows of section 1); `tools/test/audit-kit.test.mjs` and `tools/test/red-proof.test.mjs` (R2-114 prefixes only) | R2-114 | 35k / 20 |
| L1 STAGE | b17/stage-receipts | IS, SSR, CST, `audit/handlers/projections.ts`, `audit/views.ts`, `audit/response-views.ts`, ISR, `domain/src/ports/import-stage-store.ts`, `audit/outcomes.ts` (append 3 rows; merges after b16/deletion), migration 0090, T0, new T1 = `apps/api/test/b17-stage-receipts.test.ts`, new `packages/domain/test/import-stage-receipts.test.ts` | M1, M2 | TD 60k/35 plus B 150k/90 |
| L2 PROFILE | b17/importer-profile | new `apps/control/src/audit/importer-profile.ts`, `apps/control/src/audit/receipts.ts`, `plan-validation.ts`, `orchestration.ts`, new T2g = `apps/control/test/b17-importer-profile-gate.test.ts` | M3 | TD 45k/25 plus B 110k/70 |
| L3 DRIFT | b17/target-drift | `packages/domain/src/model/target-contract.ts` (`targetDriftImpact`), `audit/handlers/confirm-target-contract.ts`, `persistence/src/repositories/workspace.ts` (supersede writer), `execution/handlers/execute-project.ts`, `execution/outcomes.ts`, migration 0091 (`superseded_by_contract_id` plus a supersede-once trigger), new T3 = `apps/api/test/b17-target-drift.test.ts` | M4 | TD 40k/25 plus B 100k/60 |
| L4 VENDOR | b17/vendor-qualification | `commercial/capabilities/change-capability.ts`, `capabilities/outcomes.ts`, `persistence/src/evidence.ts` (`recordVendorQualification`), new `persistence/src/repositories/vendor-qualifications.ts`, migration 0092, `apps/api/test/cmd058-cmd059-capabilities.test.ts` (seeds), new T4 = `apps/api/test/b17-vendor-qualification.test.ts` | M5 | TD 30k/20 plus B 70k/45 |
| L5 RELEASE | b18/release-candidate | new `tools/release-candidate.mjs`, new `tools/test/release-candidate.test.mjs` (T5r, T5c), new `tools/test/pipe-exit.test.mjs`, new `tools/test/owned-cleanup.test.mjs` (T5o), `tools/test/fixtures/release/*` | M7 | TD 35k/20 plus B 80k/50 |
| L6 FISCAL | b15/fiscal-issuance | new `commerce/core/fiscal-issuance.ts`, `commerce/core/index.ts` (one export), `persistence/src/repositories/commerce-finance.ts` (lock mode plus transitions), new `commerce/testing/fiscal-bridge-paginated.ts` (imported by path, because `testing/index.ts` is in flight), new T6 = `apps/api/test/b15-fiscal-issuance.test.ts` | M6 | TD 60k/35 plus B 160k/100 (tier 1: one Codex lane review) |

Totals: about 975k agent tokens and about 600 agent-minutes. With 4 agents in parallel that is about 2.5-3 h of wall time. Order: L0 first; L1-L6 are independent of each other.
Done criteria for every lane:
- the lane's cells are C, with the exact titles above;
- red-proof shows each new test failing at base 8354d7be;
- ci-local is green on the merge with origin/main;
- the impact inventory is re-run (section 6);
- the adversary returns PASS.

## 5. Context packets (each is at most 3k tokens; the coordinator pastes one per agent)
**Common header:** worktree `repos/<lane>`, base 8354d7be; read only the files and lines listed; harness `packages/persistence/src/testing/faults/index.ts:7-15` (`bothOrders`, `mustWait`, `FaultPoints`, `simulatedCrashOf`, `crashedAt`, `instrumentPort`, `runCell`, `faultMatrix`, `controlledClock`) and `apps/api/test/b10-cells-support.ts:25-78` (`bindCells`, `open`, `failureOf`); titles exactly as in section 1, RACE and crash titles per template "Naming tests"; report in at most 15 lines: sha, red-proof failing assertion, cells closed, gaps.

**P-L1 (test-designer and builder).**
- Read: IS:150-252; SSR:40-104; CST:40-90; ISR:120-160; `import-stage-store.ts`; T0:1-140 (helpers `seedStage`, `storeUpload`, `matched`), T0:198-300, T0:399-433; `0052_b17_import_stage_receipts.sql`; `audit/outcomes.ts:40-62`.
- Build: `stageCorrelationKey` in IS, and receipt rows gain `correlationKey` (closed shape). `validateStageReceipt(stage, parsed, parents)` returns FOREIGN_STAGE, or BLOCKED_BY_PARENT per blocked child.
- SSR order: lock, terminal state, upload, instance, package, parse, correlation, foreign, content-hash idempotent, then awaiting (append and advance), finalized (reconciliation insert) or not awaiting. Parents FOR SHARE, `effectNowOf` last. CST: parents FOR SHARE plus the open-reconciliation refusal. ISR lock mode NO KEY.
- Migration 0090: `import_stages.parent_edges jsonb NOT NULL DEFAULT '[]'` (immutable via `forbid_column_change`); `stage_receipt_reconciliations(stage, content_hash UNIQUE, receipt_upload_ref, opened_at = kauro.server_now(), state 'OPEN')`, append-only, RLS like `stage_receipts`, kauro_app SELECT and INSERT.
- New reasons: RECEIPT_FOREIGN_STAGE, CHILD_EDGE_BLOCKED, PARENT_IDENTITY_UNDER_RECONCILIATION. Rewrite T0:248, :262 and :288 per X1, keeping the "no new revision" assertions (r14). Done: every M1 and M2 cell is C.

**P-L2.**
- Read: `apps/control/src/audit/receipts.ts:80-90,160-215`; `plan-validation.ts` (81 lines); the lines of `orchestration.ts` that build ValidationRun; `packages/contracts/src/generated/types.ts:299-310,337-460`; `domain/src/model/target-contract.ts:100-135`.
- Build: closed catalogue HUBSPOT_IMPORT_UI, SALESFORCE_DATA_LOADER, SF_BULK_API2 (not offered), each `{tool, recordIdField, secondaryEmailFields, maxRelationshipDepth: 1, nullMarker, associationEffects: ["ADD"], multiEnumEffects: ["ADD"]}`; `ValidationRun.target` (the target body read by `targetContractHash`); the gate runs after the body digest check at :200 and returns CONTRACT_FAILURE `IMPORTER_PROFILE_*`, evidenceClass EXECUTED_LOCAL.
- Tests: five DENY, one predicate each (r12), plus one OK sibling per profile (r20).

**P-L3.**
- Read: `confirm-target-contract.ts` (88 lines); `workspace.ts:440-500`; `execute-project.ts:1-30,50-130`; `persistence/src/execution/store.ts:330-350`; 0003:234-265; 0050:1-35.
- Build: CMD019 takes the project lock first, then supersedes the prior confirmed contracts of the same project, mode and instance with an older `observed_at`; confirming an observation older than a confirmed one is refused TARGET_STALE; the view gains `supersedes[{contractId, impact{missingAllowedValues, affectedMappings}, includedPaths:["REVALIDATE_INCLUDED","REQUEST_REFUND","REQUEST_NEW_QUOTE"]}]`; freshness judged with `effectNowOf`.
- Migration 0091: `superseded_by_contract_id` FK to the same agency and project; `superseded_at` set once to `kauro.server_now()`, never changed (trigger, 23514).
- Money assertion (tier 1): the authorization stays ACTIVE, 0 captures or charges, the entitlement not consumed.

**P-L4.**
- Read: `change-capability.ts` (85 lines); `persistence/src/evidence.ts:1-70`; 0003:12-40,296-305; the seeding helpers of `apps/api/test/cmd058-cmd059-capabilities.test.ts`.
- Migration 0092: `vendor_qualifications(evidence_hash PK, profile_hash, tool, tool_version, api_mode, result PASS|FAIL, export_back_hash, recorded_at)`, insert-only; INSERT for kauro_validator through the evidence recorder, SELECT for kauro_control.
- New reasons: QUALIFICATION_EVIDENCE_UNKNOWN, QUALIFICATION_TOOL_MISMATCH, QUALIFICATION_EXPORT_BACK_MISSING.

**P-L5.**
- Read: `tools/audit/lib/{subject,manifest}.mjs` (exports only); `.github/workflows/verify.yml:50-120`; `tools/red-proof.mjs:40-110`.
- Build `release-candidate.mjs`: `freeze` writes the registry ReleaseCandidate fields; `verify-promotion` refuses any changed field unless an EquivalenceReceipt names it; `verify-ci` checks a check-runs JSON fixture.
- `pipe-exit.test.mjs` scans the workflows and package.json scripts and refuses a pipe without pipefail or under a non-bash shell (a fixture is the negative control). `owned-cleanup.test.mjs`: the census of the 6 allowlisted sites plus a broad-delete fixture.

**P-L6.**
- Read: `commerce/ports.ts:205-250`; `commerce/testing/evidence-and-services.ts:100-130`; `commerce-finance.ts:160-270`; 0017 (the tax_documents block and triggers, grep `tax_documents_`); `apps/api/src/payments/service-commands.ts:113-180` (pattern only: intent, dispatch, conclude; do not edit).
- Build: `issueTaxDocument(rt, {documentId, expectedVersion, fiscalProfileId})`, two-phase with UNCERTAIN reconciliation; the paginated fake has 30 items per page, an exact-identity filter and injectable page timeouts.
- The route is not wired (L6-W is deferred). Evidence: SIMULATED.

## 6. Conflicts decided and impact inventory
- **X1.** T0:248, :262 and :288 contradict R2 05:115 (quoted in section 2). R2 wins.
  - Identical bytes now return 200 with the existing revision and no new one.
  - The 3-way race becomes all 200: 1 revision plus 1 reconciliation.
  - A settled stage with new bytes opens a reconciliation.
- **X2.** R2 15:137 names the TaxDocument states DRAFT, READY_TO_ISSUE, DISPATCHING, PROVIDER_PENDING, ACCEPTED and so on. Registry `state_transitions.json` and migration 0017 use DRAFT, VALIDATED, SUBMITTING, UNCERTAIN, ISSUED, REJECTED and CORRECTED.
  - The registry machine governs, because A6 binds acceptance to registry cases and R2 15 itself says "Provider-specific states map explicitly to this model".
  - Mapping recorded in T6: READY_TO_ISSUE=VALIDATED, DISPATCHING=SUBMITTING, PROVIDER_PENDING=UNCERTAIN, ACCEPTED and ACCEPTED_WITH_OBSERVATIONS=ISSUED (observations go in the evidence), REJECTED=REJECTED, CORRECTION_REQUIRED and VOIDED_BY_VALID_CORRECTION=CORRECTED.
- **X3.** MC treats "#N/A" as a spreadsheet-error sentinel that never becomes an identity key (MC `docs/CONTRACT.md:360`). R2-022 is about an importer's clear token. These do not conflict, and the platform gate covers only the token.
- **X4.** An open reconciliation blocks child continuation. R2 05:105: "Kauro does not emit guessed parent IDs or claim relationship completion". This is the conservative reading.
- **X5.** A differing receipt on a RECEIPT_VALIDATING stage stays STAGE_NOT_AWAITING. It is not finalized, and nothing is overwritten.
- **Impact inventory** (tests that read the changed members):
  - T0 (receipt shape and R2-025);
  - `apps/control/test/b16-staged-retention.test.ts:424`, which inserts import_stages with an explicit column list (the DEFAULT keeps it valid);
  - `packages/persistence/test/migrations.test.ts` (new tables);
  - `cmd058-cmd059-capabilities.test.ts` and `response-contract.test.ts` (CMD058 seeds);
  - `tools/test/openapi.test.mjs` (regenerated at merge).

## 7. Deferred (binding requirements recorded; no adapter designed now)
- **L6-W (CMD035 route).** Starts after pv1/settle and pv1/refund-build merge.
  - Route POST /api/v1/tax-documents/{documentId}/issue, role FISCAL_SERVICE, fields expectedVersion and fiscalProfileId, idempotency REQUIRED, in `service-commands.ts` and `assembly.ts`.
  - It calls `issueTaxDocument` unchanged; openapi is regenerated.
- **R2-061.** After pv1/refund-build merges:
  - prefix "R2-061: " to the titles at ach-refund-cells:558 and :655;
  - fix the ACH-case-map path (CV-3);
  - write the missing SI2-RACE test. Requirement: a refund before a delayed capture reconciles without a double reversal, in both orders.
- **R2-133.** After pv1/caveats and B12 L-SEND merge. Requirements:
  - essential capacity is reserved before any optional send;
  - a funded action is raised when quota is exhausted;
  - an unsigned or forged (non-Svix) delivery webhook is rejected with nothing recorded;
  - the in-app state stays readable.
- **R2-026 refund path.** Executing REQUEST_REFUND needs CMD031 KAURO_REMEDY on V1, which lives on pv1/refund-build. L3 only exposes the path.

## 8. Caveats (each one is either a cell above or a decision)
- **CV-1.** No runtime writer of import_stages exists; there is no B08 stage compiler on main (0052 header: "a fixture or the compiler does"). The L1 tests seed stages as an oracle. The compiler's exclusion of blocked edges is a B08 gap, so it is recorded here and not hidden.
- **CV-2.** L3 is the first writer of `superseded_at`.
- **CV-3.** `ACH-case-map.md:65` cites packages/persistence/test, but the tests live in apps/api/test. SI2-RACE is missing.
- **CV-4.** X1 rewrites main assertions under R2 authority; rule r14 is kept.
- **CV-5.** The S088 census covers platform tools only. Builder-repo tools are out of the product.
- **CV-6.** The registry has no resolution command for a reconciliation request. Requests stay OPEN and visible in the stage view; identity is never overwritten (R2 05:115).
- **CV-7.** Rule r15 is applied to the whole lane: the three existing `serverInstant()` judgments (section 2) move to `effectNowOf`.
