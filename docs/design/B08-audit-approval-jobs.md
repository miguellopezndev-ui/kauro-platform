# B08 — Audit, approval and processing authority: design

Branch `b08/design` from `b07/integration` (`075b7c3`). Package B08 of the build program (22: "Implement durable
profile/interpret/validate orchestration, typed plan editing, exact approval, job admission, fenced staging, verification and
publication"; "Test cancellation at each await/commit, stale source/target, duplicate tasks and valid artifact from an unauthorized
attempt"). Gate G-JOB (owner 07). Manuals 04, 06, 07, 09, 10; the catalogues, TRANSITIONS, HASHING and ACCEPTANCE_SCENARIOS are
active source. Cases: `node tools/package-brief.mjs B08` (15). Brand Kauro (A2); acceptance per A4 (case map, verify green on
Windows, Linux and CI, independent review of the exact commit, on main).

This branch delivers documents and their checks only: this design, `docs/design/B08-case-map.md`, `docs/design/B08-mandates.json`,
`tools/test/b08-case-map.test.mjs` and `tools/test/b08-design.test.mjs`. It **extends** and never forks: B06's pipeline (D-PIPE-1),
journal (D-IDEM-1..3), facts (D-FACT-1), transition locks (D-TX-2), leases (D-LEASE-1, S090), request journal (S089), outbox
(D-OUTBOX-1) and runtime groups; B07's server clock (D-CLOCK-1), control-plane units (D-CTRL-1, D-CTRL-2), revision-first locking
(D-LOCK-2), object registry (D-OBJ-1..3), retention (D-RET-2, D-ANCH-1/2), dispatcher (D-CTRL-4), `runCommandIn` (D-CMD-10) and hold
points (D-CMD-15); B09's CommercialAuthorization machine (D-MACH-B4), `DeliveryCapacityPort` (D-CAP-B1), event bindings (D-EVT-B3)
and its integration obligations §15 items 7, 11 and 13. Every rule below is a decision of §13 (`D8-*`) or quoted authority.

## 1. Base, stages and what B08 owns

The implementation base is `b08/base`: this branch, `b08/core-ports` and `b08/worker-host` merged into the verified head of `integration/b07-b09` (D8-BASE-3), which carries B09's
migrations 0013–0017 and the merge's 0018 (D-MERGE-3). B08 numbers 0019–0021 and cannot apply on `b07/integration` alone, because the runner refuses a gap
(D8-BASE-1). Mandates (`B08-mandates.json`) run in four stages, at most five agents at once (A4):

| stage | mandates (branch `b08/<key in lower case>`) | merged into |
|---|---|---|
| 1 | B08-PERSISTENCE-EXECUTION (B08-CORE-PORTS → B08-WORKER-HOST already merged in `b08/base`) | `b08/stage-1` (from `b08/base`) |
| 2 | B08-COMMANDS-EXECUTION ∥ B08-CONTROL-EXECUTION ∥ B08-PERSISTENCE-AUDIT | `b08/stage-2` (from `b08/stage-1`) |
| 3 | B08-COMMANDS-AUDIT ∥ B08-CONTROL-AUDIT | `b08/stage-3` (from `b08/stage-2`) |
| 4 | B08-INTEGRATION (end to end, case-map statuses, verify on Windows and Linux) | `b08/integration` |

B08 owns the aggregates Audit, CostGrant, ProcessingJob and PackageVersion and the evidence rows of attempts, steps, staging,
read-back, verification and cleanup; it serves CMD036 ExecuteProject and CMD037 CancelJob (its cases) and, as the platform host of
the cores, CMD020 StartAudit, CMD021 CancelAudit, CMD022 CreatePlan and CMD024 ValidatePlan, whose cases stay B03's and B01's (the
case map cites B08's tests for them as supporting evidence, never as B08 cases). It binds B06's CMD023 and CMD025 collaborators to
real implementations (D8-PLAN-1, D8-APPR-1). It consumes B07's sealed source and B09's CommercialAuthorization.

## 2. The authority chain

Every link binds the next by digest and by database key; a consumer recomputes the preimage (HASHING "Hash domain separation").

| link | binds | enforced by |
|---|---|---|
| sealed revision → plan | `manifestHash` (KAURO_SOURCE_REVISION_V1) is the plan body's `revisionHash` | B06 `plans_source_fk`, `plans_body_names_subjects` |
| target contract → plan | `bodyHash` (KAURO_TARGET_BODY_V1) is the body's `targetContractHash` | B06 `plans_target_fk` |
| plan → receipt | the receipt names plan body hash, revision, target and the consumed core package | B06 six-column FK; D8-AUD-4, D8-PLAN-2 |
| receipt → approval | KAURO_PLAN_APPROVAL_V1 over plan, revision, target, receipt and disclosures | B06 CMD025, D-PLAN-2..5 |
| approval → quote → authorization | quote and CommercialAuthorization carry plan, approval, hashes, mode, units, capability version | B09 composite keys, KP004 |
| authorization → job | the job's composite key to the authorization's execution subject plus the receipt's core package hash | D8-JOB-1, D8-JOB-2 |
| job → attempt | the JOB_ATTEMPT lease subject is the job's input binding hash (KAURO_JOB_INPUT_BINDING_V1); fence = lease fence | D8-ATT-1 |
| attempt → staged manifest | KAURO_STAGED_MANIFEST_V1 names attempt, fence and input binding hash | D8-STG-3, KA080 |
| staged manifest → package | read-back of every generation and a VALID verification against authority the platform supplies | D8-VER-1, KA084 |
| package → delivery | KAURO_DELIVERY_MANIFEST_V1 over the issued PackageManifest (revision, plan, target, core, receipt, artifacts) | D8-PUB-2 |

Payment is required before execution only: an audit and a validation run on a funded cost grant (D8-GRANT-1), ExecuteProject needs a
live CommercialAuthorization (07 "CommercialAuthorization"; 10 "Processing and delivery routes").

## 3. Orchestration over a sealed revision (Audit)

StartAudit (CMD020) checks the sealed, available revision and the confirmed, current target after their transition locks, the agency's
one live audit, and carves an AUDIT grant from an AUTHORIZED platform pool under the pool's row lock; without a funded grant it
answers 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT with nothing written, and sealing never reserves anything (R2-044; D8-GRANT-1). The audit
is born QUEUED with its absolute deadline (creation + 86,400 s) and its grant; AUDIT_ORCHESTRATION then runs three steps, each claiming
`audits.fence + 1`, calling its port outside any transaction and recording its result only under that fence (D8-AUD-2):

1. **PROFILE** (QUEUED → PROFILING → INTERPRETING): `ProfilePort.profile` over the sealed manifest's exact ACCEPTED generations
   (`GenerationSourceReader`), then `InterpretPort.planCandidates`; records the profile evidence hash and the complete candidate
   manifest hash; stamps the interpretation deadline (+ 1,200 s) once.
2. **INTERPRET** (INTERPRETING → VALIDATING, NEEDS_DECISION, UNSUPPORTED or FAILED): `InterpretPort.interpret` with the funded
   ceiling, the interpretation deadline and the platform's `ModelTaskJournalPort` (model tasks over B06's `request_journal`, MODEL_TASK
   leases, each dispatch intent reserving on the grant, D8-GRANT-2): a stored response is compiled before any new dispatch; a send
   without a response stays UNCERTAIN and reserved (D8-AUD-3).
3. **VALIDATE** (VALIDATING → DRAFT_READY or NEEDS_DECISION): creates the system draft plan (DRAFT → VALIDATION_REQUIRED → VALIDATING,
   creator = the audit's requester), `ValidatePort.validate` with the exact manifest, plan body, target body and core, the receipt
   written by `kauro_validator`; DRAFT_READY commits only under the current fence and cancel version before the absolute deadline
   with that plan VALIDATED under a VALID receipt of exactly the audit's subject (D8-AUD-4).

CancelAudit (CMD021) advances the audit's cancel version and takes `cancellation_wins`; AUDIT_DEADLINES takes `absolute_deadline` on
the server clock; GRANT_RECONCILIATION settles reservations (D8-GRANT-2). Typed editing (CMD022, CMD023) and ValidatePlan (CMD024)
reuse the same ports (D8-PLAN-1, D8-PLAN-2); approval is B06's CMD025 with real collaborators (D8-APPR-1).

## 4. Job admission, attempts and fencing

1. **ExecuteProject** (CMD036, request handler): B06's pipeline; the project row, then the authorization after its shared transition
   lock, then plan → source → target (D-TX-2); an authorization that already has a job answers that job (D8-JOB-1); otherwise the
   agency ACTIVE, project OPEN, authorization ACTIVE, approval live on the APPROVED plan, source SEALED and available, target current,
   capability offered and the agency below its live-job bound (D8-CAP-2); one QUEUED job binding the authorization's subject
   (D8-JOB-2) with its delivery deadline (capture + 172,800 s, D8-RET-1), `processing_job.queued.v1` → JOB_EXECUTION, 202.
2. **Admission** (JOB_ADMISSION, control plane): the fair scheduler (D8-SCHED-1) under the global ledger lock; per job, re-read the
   authority after the transition locks, taken without waiting (D8-LOCK-1; a loss cancels, D8-CANCEL-2), then in one unit of work QUEUED → ADMITTED (holds WAITING),
   authorization ACTIVE → CONSUMED naming the job (D8-AUTH-1), the PAID_ORDINARY retention record (D8-RET-1), the JOB_ATTEMPT lease
   claimed and attempt 1 CREATED → CLAIMED at fence 1 (D8-ATT-1).
3. **Launch** (JOB_EXECUTION): while the ACTIVE slot is free, record the launch intent — attempt CLAIMED → STARTING with its
   deterministic identity and staging prefix, holds WAITING → ACTIVE, the execution deadline set once — then `WorkerHostPort.launch`
   outside any transaction (D8-HOST-1, D8-STG-1). ATTEMPT_MONITOR observes by identity, heartbeats the lease under the attempt's fence
   (D8-ATT-2) and takes `provider_start_observed`; a lapsed lease abandons the attempt after its provider job is terminal, and attempt
   n+1 is a lease takeover at fence n+1 within the execution deadline, at most three attempts.

## 5. Staging, verification and publication

The worker writes only under its attempt's prefix through the host-supplied `FencedArtifactWriter` and `AttemptScratchStore`
(D8-STG-1, D8-STG-2) and checks its cancellation channel after every await (D8-CANCEL-1). When the host reports success, the control
plane reads the manifest object itself and submits it under the fence (RUNNING → VERIFYING, package STAGED; D8-STG-3). Verification
reads every artifact back by exact generation and calls `PackageVerifierPort` with authority the platform supplies (D8-VER-1); VALID →
VERIFIED_PRIVATE and the delivery copies (D8-PUB-1); the publication transaction is the only edge that makes a package downloadable
(D8-PUB-2): package AVAILABLE, job READY, attempt COMMITTED, authorization DELIVERED, retention soft deadline, all or nothing. A valid
package of an attempt that is not the lease's current owner, of a cancelled job or under a revoked authorization is kept private as
evidence and REVOKED, never AVAILABLE (S056, CMD037-DENY, R2-045).

## 6. Cancellation at every await and commit

The job's cancel version (CMD037, or EXECUTION_CONTROL for a lost authority) is mirrored into the lease by EXECUTION_CONTROL; the
check after each await is the next unit of work re-reading the job under its row lock, and publication is the last atomic check
(D8-CANCEL-1). Each boundary has a hold point in the fakes (`cancellation-boundaries.test.ts`, `audit-orchestration.test.ts`).

| await (outside any transaction) | the check that follows | a cancellation committed there yields |
|---|---|---|
| admission unit committed, launch not yet recorded | launch intent re-reads job | no launch; attempt ABANDONED |
| `WorkerHostPort.launch` returns or times out | launch record under the job row | the identity is terminated at once |
| each `observe` | monitor unit re-reads the job | terminate, then reconcile |
| each worker await (source read, scratch segment, artifact close, manifest write) | `CancellationChannel.check()` → CONTINUE, CANCELLED or FENCED | the worker stops; no manifest |
| manifest object read | submission unit (fence and cancel version) | no STAGED; objects left to the janitor |
| each read-back; the verifier call | verification unit | package REVOKED, evidence kept |
| delivery copies | publication unit | refused; package REVOKED |
| publication commit | job row lock (one winner with CMD037) | READY or CANCEL_REQUESTED, never both |
| audit: profile call; each model task; the validator call | step record under fence and cancel version; the kernel checks before SEND_STARTED | no step result; no draft; a sent request keeps its reservation |
| audit: finalization | DRAFT_READY guard (fence, cancel version, absolute deadline) | a later VALID receipt stays evidence |

## 7. Crash and recovery

| crash point | durable state | recovery |
|---|---|---|
| CMD036 before COMMIT | nothing (journal reservation rolled back) | retry with the same key executes |
| CMD036 after COMMIT, answer lost (S055) | job QUEUED, event, outbox record | same key replays; another key answers the same job; the dispatcher delivers |
| dispatcher after claim, before settlement | OUTBOX_DISPATCH lease | redelivery; admission of a job no longer QUEUED is DONE |
| launch intent committed, no create | attempt STARTING, identity, launch NOT_LAUNCHED | monitor observes NOT_FOUND after the host horizon, creates by identity |
| create done, record lost (S056) | attempt STARTING, launch UNCERTAIN | observe(identity) before any create; found → adopt |
| worker dies (S075) | lease lapses, prefix and scratch remain | ATTEMPT_MONITOR abandons after terminate; STAGING_JANITOR cleans; next attempt at fence + 1 |
| manifest written, not submitted | object in the prefix | submission on the next SUCCEEDED observation |
| verification or delivery copy interrupted | no verification row; copy intents INTENDED (B07 D-OBJ-1) | rerun; a present generation is observed and verified, never assumed |
| after publication COMMIT | READY, events, outbox | notifications from the outbox |
| audit step claimed, result lost | fence spent | next delivery claims fence + 1; a stored model response is compiled before any new dispatch |
| database restore | — | B16 applies tombstones and revocations and invalidates stale leases before traffic (07 "Restoration") |

## 8. State machines and guards

Seeded in `kauro.state_machines` / `kauro.state_transitions`, every row born in its initial state, every other edge refused (KA008).
"control" is `kauro_control`; the database column names the enforcement beyond the listed-transition trigger.

### 8.1 Registry machines

| machine | from | event | to | performer | guard enforced by |
|---|---|---|---|---|---|
| Audit | QUEUED | profile_worker_claims | PROFILING | AUDIT_ORCHESTRATION | source SEALED and available, grant AUTHORIZED and unexpired, fence + 1 (KA080, KA081) |
| Audit | PROFILING | profile_and_candidates_complete | INTERPRETING | AUDIT_ORCHESTRATION | profile evidence and candidate manifest recorded under the fence; interpretation deadline set once |
| Audit | INTERPRETING | compiled_decisions_ready | VALIDATING | AUDIT_ORCHESTRATION | compiled configuration covers the manifest; system draft plan VALIDATING |
| Audit | INTERPRETING | unresolved_material_choice | NEEDS_DECISION | AUDIT_ORCHESTRATION | pending decisions recorded, no plan |
| Audit | INTERPRETING | capability_not_supported | UNSUPPORTED | AUDIT_ORCHESTRATION | unsupported capabilities recorded, grant released when unused |
| Audit | VALIDATING | complete_valid_receipt_and_current_authority | DRAFT_READY | AUDIT_ORCHESTRATION | deferred guard D8-AUD-4 (KA080, KA081) |
| Audit | VALIDATING | validatable_issue_needs_agency_choice | NEEDS_DECISION | AUDIT_ORCHESTRATION | structurally valid receipt with decision codes |
| Audit | QUEUED | cancellation_wins | CANCELLED | CMD021; EXECUTION_CONTROL | cancel version + 1 (D8-CANCEL-1/2) |
| Audit | PROFILING | cancellation_wins | CANCELLED | CMD021; EXECUTION_CONTROL | same; the step's late result is refused |
| Audit | INTERPRETING | cancellation_wins | CANCELLED | CMD021; EXECUTION_CONTROL | sent requests keep their reservation until reconciled |
| Audit | VALIDATING | cancellation_wins | CANCELLED | CMD021; EXECUTION_CONTROL | a later VALID receipt never promotes |
| Audit | QUEUED | absolute_deadline | EXPIRED | AUDIT_DEADLINES | server clock at or past the absolute deadline (D8-DL-1) |
| Audit | PROFILING | absolute_deadline | EXPIRED | AUDIT_DEADLINES | same |
| Audit | INTERPRETING | absolute_deadline | EXPIRED | AUDIT_DEADLINES | same |
| Audit | VALIDATING | absolute_deadline | EXPIRED | AUDIT_DEADLINES | same, even while the validator runs |
| Audit | PROFILING | fatal_integrity_error | FAILED | AUDIT_ORCHESTRATION | classified cause token |
| Audit | INTERPRETING | fatal_contract_or_provider_error | FAILED | AUDIT_ORCHESTRATION | journal and cost state preserved |
| Audit | VALIDATING | fatal_contract_error | FAILED | AUDIT_ORCHESTRATION | null, foreign or corrupt receipt |
| Job | QUEUED | capacity_reserved | ADMITTED | JOB_ADMISSION | fair order; ledgers (KA082); authorization consumed in the same unit (KA081) |
| Job | ADMITTED | provider_start_observed | RUNNING | ATTEMPT_MONITOR | the attempt's identity observed running; lease subject unchanged |
| Job | RUNNING | complete_staging_submitted | VERIFYING | JOB_EXECUTION | manifest read by the control plane; attempt owns the lease at its fence (KA080) |
| Job | VERIFYING | atomic_publication_accepted | READY | JOB_EXECUTION | publication guard D8-PUB-2 (KA080, KA081, KA084) |
| Job | QUEUED | cancel_command | CANCEL_REQUESTED | CMD037; EXECUTION_CONTROL | version CAS or a verified authority loss |
| Job | ADMITTED | cancel_command | CANCEL_REQUESTED | CMD037; EXECUTION_CONTROL | job row lock orders it with launch |
| Job | RUNNING | cancel_command | CANCEL_REQUESTED | CMD037; EXECUTION_CONTROL | cancel version + 1 |
| Job | VERIFYING | cancel_command | CANCEL_REQUESTED | CMD037; EXECUTION_CONTROL | wins only if committed before publication (S062) |
| Job | CANCEL_REQUESTED | provider_and_artifacts_reconciled | CANCELLED | EXECUTION_CONTROL | identity observed terminal or proved absent; package REVOKED; slot released |
| Job | QUEUED | deadline_reached | EXPIRED | JOB_DEADLINES | delivery deadline on the server clock, never early |
| Job | ADMITTED | deadline_reached | EXPIRED | JOB_DEADLINES | launch uncertainty reconciled first |
| Job | RUNNING | deadline_reached | EXPIRED | JOB_DEADLINES | execution deadline; exact provider job terminated |
| Job | VERIFYING | deadline_reached | EXPIRED | JOB_DEADLINES | publication refused after the deadline |
| Job | ADMITTED | unrecoverable_start_error | FAILED | ATTEMPT_MONITOR | host REFUSED, or attempts exhausted with uncertainty recorded |
| Job | RUNNING | fatal_resource_or_integrity_error | FAILED | JOB_EXECUTION | classified cause (S035) |
| Job | VERIFYING | verification_failure | FAILED | JOB_EXECUTION | read-back or verifier INVALID (S061) |
| CostGrant | PREPARED | actual_authorization_and_funding | AUTHORIZED | CMD020 (AUDIT grant); owner funding act (pool, Q8-1) | authorization reference, ceiling, scope, expiry present (CHECK); an AUDIT grant's ceiling held on its pool |
| CostGrant | AUTHORIZED | remaining_budget_unavailable | EXHAUSTED | GRANT_RECONCILIATION | known spend plus reserved reaches the ceiling |
| CostGrant | EXHAUSTED | reconciliation_releases_unused_reserve | AUTHORIZED | GRANT_RECONCILIATION | provably unused amount, grant unexpired |
| CostGrant | AUTHORIZED | expiry_reached | EXPIRED | GRANT_RECONCILIATION | server clock at or past `expires_at` |
| CostGrant | EXHAUSTED | expiry_reached | EXPIRED | GRANT_RECONCILIATION | same |
| CostGrant | AUTHORIZED | all_effects_reconciled_and_scope_closed | CLOSED | GRANT_RECONCILIATION | no UNKNOWN or UNCERTAIN usage left |
| CostGrant | EXPIRED | all_effects_reconciled | CLOSED | GRANT_RECONCILIATION | same |
| Plan | DRAFT | compiled_or_edited | VALIDATION_REQUIRED | CMD022; AUDIT_ORCHESTRATION (system draft) | body digest recomputed (B06 D-PLAN-5) |
| Plan | VALIDATION_REQUIRED | validation_admitted | VALIDATING | CMD024; AUDIT_ORCHESTRATION | one current validation intent (D8-PLAN-2) |
| Plan | VALIDATING | valid_receipt | VALIDATED | PLAN_VALIDATION; AUDIT_ORCHESTRATION | VALID receipt of this body by `kauro_validator`; intent current |
| Plan | VALIDATING | invalid_receipt_result | VALIDATION_REQUIRED | PLAN_VALIDATION; AUDIT_ORCHESTRATION | findings kept; no old VALIDATED status |

B06 keeps the other Plan edges (CMD023, CMD025, CMD026). Of B09's CommercialAuthorization machine B08 performs exactly:

| machine | from | event | to | performer | guard enforced by |
|---|---|---|---|---|---|
| CommercialAuthorization | ACTIVE | execution_admitted | CONSUMED | JOB_ADMISSION | job of this authorization enters ADMITTED in the same transaction (deferred, KA081) |
| CommercialAuthorization | CONSUMED | package_published | DELIVERED | JOB_EXECUTION | job enters READY with an AVAILABLE package in the same transaction (deferred, KA081) |

### 8.2 Platform machines

- **ProcessingAttempt** — initial CREATED; terminal COMMITTED, ABANDONED, FAILED; states CREATED, CLAIMED, STARTING, RUNNING, STAGED,
  VERIFYING, COMMITTED, ABANDONED, FAILED (07 "Job and attempt states"). Evidence rows of the job, not an aggregate (D8-EVT-1).
- **PackageVersion** — initial STAGED; terminal DELETED; states STAGED, VERIFIED_PRIVATE, AVAILABLE, RETIRED, REVOKED, DELETED (07
  "Package and import states"). An aggregate (kind `package_version`).

| machine | from | event | to | performer | guard enforced by |
|---|---|---|---|---|---|
| ProcessingAttempt | CREATED | fence_claimed | CLAIMED | JOB_ADMISSION; ATTEMPT_MONITOR | lease owner = attempt, attempt fence = lease fence, subject = input binding |
| ProcessingAttempt | CLAIMED | launch_intent | STARTING | JOB_EXECUTION | identity and prefix recorded; ACTIVE slot (KA082) |
| ProcessingAttempt | STARTING | provider_start_observed | RUNNING | ATTEMPT_MONITOR | identity observed running |
| ProcessingAttempt | RUNNING | manifest_submitted | STAGED | JOB_EXECUTION | KA080 |
| ProcessingAttempt | STAGED | verification_started | VERIFYING | JOB_EXECUTION | KA080 |
| ProcessingAttempt | VERIFYING | publication_committed | COMMITTED | JOB_EXECUTION | with the job READY |
| ProcessingAttempt | CLAIMED | attempt_abandoned | ABANDONED | ATTEMPT_MONITOR; EXECUTION_CONTROL | cancellation, lapsed lease or takeover |
| ProcessingAttempt | STARTING | attempt_abandoned | ABANDONED | ATTEMPT_MONITOR; EXECUTION_CONTROL | identity terminal or proved absent |
| ProcessingAttempt | RUNNING | attempt_abandoned | ABANDONED | ATTEMPT_MONITOR; EXECUTION_CONTROL | same |
| ProcessingAttempt | STAGED | attempt_abandoned | ABANDONED | EXECUTION_CONTROL | cancellation before verification |
| ProcessingAttempt | VERIFYING | attempt_abandoned | ABANDONED | EXECUTION_CONTROL; JOB_EXECUTION | cancellation or authority lost before publication |
| ProcessingAttempt | STARTING | attempt_failed | FAILED | ATTEMPT_MONITOR | host REFUSED |
| ProcessingAttempt | RUNNING | attempt_failed | FAILED | JOB_EXECUTION | classified cause |
| ProcessingAttempt | STAGED | attempt_failed | FAILED | JOB_EXECUTION | manifest invalid |
| ProcessingAttempt | VERIFYING | attempt_failed | FAILED | JOB_EXECUTION | read-back or verifier INVALID |
| PackageVersion | STAGED | verification_valid | VERIFIED_PRIVATE | JOB_EXECUTION | VALID verification, every read-back equal |
| PackageVersion | VERIFIED_PRIVATE | package_published | AVAILABLE | JOB_EXECUTION | publication guard (D8-PUB-2) |
| PackageVersion | STAGED | publication_denied | REVOKED | JOB_EXECUTION; EXECUTION_CONTROL | verification INVALID, cancellation or authority lost; evidence kept |
| PackageVersion | VERIFIED_PRIVATE | publication_denied | REVOKED | JOB_EXECUTION; EXECUTION_CONTROL | same |
| PackageVersion | AVAILABLE | package_replaced | RETIRED | LATER B13 (replacement version) | a newer AVAILABLE version of the job's scope |
| PackageVersion | AVAILABLE | authority_revoked | REVOKED | LATER B16 (incident, dispute policy) | 07 "Reversal after delivery ... restricts further service" |
| PackageVersion | AVAILABLE | package_deleted | DELETED | LATER B16 (retention, deletion) | effective deadline reached or deletion |
| PackageVersion | RETIRED | package_deleted | DELETED | LATER B16 | same |
| PackageVersion | REVOKED | package_deleted | DELETED | STAGING_JANITOR; B16 | private evidence past its retention |

## 9. Migrations 0019–0021

PostgreSQL 17, schema `kauro`, the B06/B07 conventions: `agency_id` on every tenant row, composite keys bind scope, UUIDv7 ids,
lifecycle instants the server's (`kauro.server_now()`), money BIGINT cents, JSONB only for closed documents, `version` plus one event
per version on aggregates, kinds registered in `kauro.aggregate_kinds`, forced RLS, no DELETE for request handlers.

| migration | objects | key constraints and triggers | roles and RLS | mandate |
|---|---|---|---|---|
| 0019_execution_jobs_capacity.sql | kind `processing_job`; Job and ProcessingAttempt seeded; `processing_job.*.v1` types and `kauro.execution_control_event_types()`; `execution_capacity`, `agency_execution_capacity`, `processing_jobs`, `processing_attempts`; UNIQUE `commercial_authorizations_execution_subject` on B09's table; `projects` state transition lock; anchor kind EXECUTION_ADMITTED; `kauro.try_await_transition` (the non-blocking shared transition lock, D8-LOCK-1) and EXECUTE on it and on `kauro.await_transition` for `kauro_control` (D8-XPKG-6); SQLSTATE KA080–KA084 | one job per authorization, one live job per project; composite key to the authorization's subject and to the receipt; `holds` edges and ledger trigger with the one-snapshot deferred check (KA082); attempt fence = lease fence, identity `kauro-attempt-<id>`, prefix canonical, one live attempt, at most three, none after cancel_command (KA080, KA081); consumption bound at COMMIT (KA081); PAID_ORDINARY record hard deadline = capture completion + 1,209,600 s at COMMIT, an existing record of the revision kept (D8-XPKG-8) | `kauro_app`: insert QUEUED jobs of its tenant, the cancel_command columns only; `kauro_app` and, in its adopted agency, `kauro_payment`: column-scoped reads of the two ledgers for `DeliveryCapacityPort` (D8-XPKG-4); `kauro_control` (bound agency): admission, attempts, leases, consumption edge of `commercial_authorizations` with SELECT on `commerce_event_bindings`, its restrictive outbox subscriber policy, the anchor and PAID_ORDINARY insert; column-scoped reads of plans, approvals, target contracts, projects, agencies, sealed manifests, receipts and `capture_facts.provider_completed_at` (D8-XPKG-5); request handlers refused the control-plane event types, and `kauro_control` inserts them under its own `domain_events` policy, because B07's admits only the source kinds (D8-XPKG-6) | B08-PERSISTENCE-EXECUTION |
| 0020_staging_verification_packages.sql | kind `package_version`; PackageVersion seeded; `package_version.*.v1`; `staged_manifests`, `staged_artifacts`, `artifact_readbacks`, `package_verifications`, `package_versions`, `delivery_artifacts`, `attempt_cleanups`; anchor kind PACKAGE_AVAILABLE; `retention_anchors_bound` replaced by a superset; the row (`commercial_authorization.delivered.v1`, NOTIFICATIONS) of B09's append-only `commerce_event_subscriptions` (D8-XPKG-7) | staged rows only from the lease's current attempt while RUNNING, objects only under that attempt's prefix (KA080); one VALID verification per attempt; one AVAILABLE package per job; publication guard deferred (KA080, KA081, KA084); delivery objects only under the package's prefix; cleanup rows name objects of exactly their attempt | all writes `kauro_control` (bound); `kauro_app` reads packages, verifications' result and the job's evidence summary of its tenant, never an object name or provider identity | B08-PERSISTENCE-EXECUTION |
| 0021_audits_cost_grants.sql | kinds `audit`, `cost_grant`; Audit and CostGrant seeded; `audit.*.v1`, `cost_grant.*.v1`; `cost_grants`, `audits`, `audit_steps`, `model_tasks`, `model_task_journal` (D8-PAU-2), `decision_artifacts`, `plan_validations`; FK and reservation trigger on B06's `request_journal.cost_grant_id` | `reserved + reconciled_spend <= ceiling`; AUDIT ceiling within policy and held on its pool; a dispatch intent reserves on an AUTHORIZED unexpired grant (KA083); one audit per (revision, target), one live per agency; steps only under the current fence (KA080); DRAFT_READY guard deferred; artifacts content-idempotent | `kauro_app`: StartAudit's audit, AUDIT grant and pool reservation (column grant, deferred check), CancelAudit's columns, artifacts, validation intents; `kauro_control`: steps, model tasks, grant reconciliation, system draft plans and the validation edges of `plans`; `kauro_validator` unchanged | B08-PERSISTENCE-AUDIT |

SQLSTATE translation (`sqlstate.ts`, D8-SQL-1): KA080 FENCE → PRECONDITION_FAILED / EXECUTION_FENCED (the control plane treats it as
"the attempt or step lost": DONE); KA081 AUTHORITY → PRECONDITION_FAILED / EXECUTION_AUTHORITY_LOST; KA082 → INTEGRITY_FAILURE /
CAPACITY_LEDGER, and the ledger CHECKs → CAPACITY_UNAVAILABLE / EXECUTION_QUEUE_FULL (retryable); KA083 → BUDGET_EXHAUSTED /
NO_FUNDED_GRANT, the grant ceiling CHECK → BUDGET_EXHAUSTED / GRANT_CEILING; KA084 → INTEGRITY_FAILURE / PUBLICATION_EVIDENCE_MISSING.
`runtime-boundary.json` is re-read from a cluster migrated to 0021 and reviewed entry by entry.

## 10. Ports and implementers

| port | defined in | implemented by | tests bind (fake owner) |
|---|---|---|---|
| ProfilePort, ValidatePort, ExecutionEnvelopePort, PackageVerifierPort | `@kauro/application` `ports/core-ports.ts` | the cores adapter of `b05/cores` over kauro-migration-core 2.0.3 | ContractFakeMigrationCore (B08-CORE-PORTS) |
| InterpretPort (planCandidates, interpret), PlanCompilerPort | `@kauro/application` `ports/core-ports.ts` | the cores adapter over kauro-intelligence-core 0.4.0 | ContractFakeIntelligenceCore (B08-CORE-PORTS) |
| SourceReader, ScratchStore, ArtifactWriter, CancellationChannel (the host I/O of 04) | `@kauro/application` `ports/core-ports.ts` | `@kauro/data-plane` GenerationSourceReader, AttemptScratchStore, FencedArtifactWriter (B08-WORKER-HOST) | real |
| WorkerHostPort (launch, observe, terminate, resources by identity) | `@kauro/application` `ports/worker-host.ts` | B14 (Cloud Batch) | ContractFakeWorkerHost (B08-WORKER-HOST) |
| ModelTaskJournalPort | `@kauro/application` `ports/core-ports.ts` | `@kauro/persistence` over `model_tasks`, `request_journal`, `cost_grants` (B08-PERSISTENCE-AUDIT) | real |
| ExecutionStore, AuditStore | `@kauro/domain` `ports/execution-store.ts`, `ports/audit-store.ts` | `@kauro/persistence` (B08-PERSISTENCE-EXECUTION, B08-PERSISTENCE-AUDIT) | real |
| DeliveryCapacityPort (B09) | `@kauro/application` (B09) | `@kauro/persistence` over the ledgers (B08-PERSISTENCE-EXECUTION), bound by B08-COMMANDS-EXECUTION in `apps/api/src/edition.ts`, where `commerceEdition()` leaves `capacity: null` (D8-XPKG-4) | real |
| CommercialConsequenceInspector, ExternalActionInspector, ActiveWorkInspector (B06) | `@kauro/application` | B09's `commercialInspectionsOf` already binds the authorization halves in `apps/api/src/edition.ts` (`activeJobs` is the literal 0); B08 extends them by composition with `@kauro/persistence` readings of jobs and packages (B08-PERSISTENCE-EXECUTION), B09's inspector tests unchanged (D8-XPKG-3) | real |
| ArtifactResolver, PlanPatchCompiler, DisclosureComposer (B06) | `@kauro/application` | resolver over `decision_artifacts` (B08-PERSISTENCE-AUDIT); compiler via PlanCompilerPort and the composer (B08-COMMANDS-AUDIT) | real |
| ObjectStoragePort (B07) | B07 `ports/source-providers.ts` | B15 | ContractFakeObjectStorage (B07-PROVIDER-FAKES) |
| SourceAvailabilityReader, SourceLineageReader, CommercialScopeInspector (B09 and B07 ports) | `@kauro/application` | already bound in `apps/api/src/edition.ts` to B07's persistence (`commercialSourceReadsOf`, binding PLATFORM) and B09's `findLiveByRevisionHash`; consumed, never re-bound by B08, whose roles read B07's tables under their own column grants (D8-XPKG-2) | real |

Signatures fixed here so parallel mandates agree: `ExecutionEnvelopePort.execute(subject: ExecutionSubject, io: HostIo):
Promise<ExecutionOutcome>` where `HostIo = { source: SourceReader; scratch: ScratchStore; writer: ArtifactWriter; cancellation:
CancellationChannel; limits: ExecutionLimits }`; `CancellationChannel.check(): Promise<"CONTINUE" | "CANCELLED" | "FENCED">`;
`ArtifactWriter.open(role, pathHash) → { write, close(): Promise<StagedArtifact> }` (close re-reads before it resolves);
`WorkerHostPort.launch(spec) → LAUNCHED | ALREADY_EXISTS | REFUSED | AMBIGUOUS`, `observe(identity) → NOT_FOUND | QUEUED | RUNNING |
SUCCEEDED | FAILED | TERMINATED` (with heartbeat, manifest reference, cause, resources), `terminate(identity) → TERMINATED |
ALREADY_TERMINAL | NOT_FOUND | UNCERTAIN`; `PackageVerifierPort.verify(candidate, expected: ExpectedAuthority) → VALID | INVALID |
ERROR`. Every port result carries `evidenceClass`; a fake answers SIMULATED (D8-FAKE-1).

## 11. Outbox, consumers and sweepers

| event | consumers |
|---|---|
| `processing_job.queued.v1`, `.admitted.v1`, `.verifying.v1`; `package_version.verified_private.v1` | JOB_EXECUTION |
| `processing_job.cancel_requested.v1` | EXECUTION_CONTROL |
| `processing_job.ready.v1`, `.failed.v1`, `.cancelled.v1`, `.expired.v1`; `package_version.available.v1` | NOTIFICATIONS |
| `commercial_authorization.revoked.v1` (B09), `approval.withdrawn.v1`, `plan.withdrawn.v1`, `plan.superseded.v1` (B06), `dataset_revision.superseded.v1`, `.expired.v1`, `source_file.admission_revoked.v1` (B07) | EXECUTION_CONTROL (already routed) |
| `commercial_authorization.delivered.v1` | NOTIFICATIONS (0020 adds the row to B09's append-only `commerce_event_subscriptions`, D8-XPKG-7) |
| `audit.queued.v1`, `.profiling.v1`, `.interpreting.v1`, `.validating.v1`, `.cancelled.v1` | AUDIT_ORCHESTRATION |
| `audit.draft_ready.v1`, `.needs_decision.v1`, `.unsupported.v1`, `.failed.v1`, `.expired.v1` | NOTIFICATIONS |
| `plan.validating.v1` | PLAN_VALIDATION |

Sweepers (`EXECUTION_SWEEPERS`): JOB_ADMISSION, ATTEMPT_MONITOR, JOB_DEADLINES, STAGING_JANITOR, AUDIT_DEADLINES,
GRANT_RECONCILIATION. Every consumer runs at least once over B07's dispatcher in SYSTEM units bound to the agency (D-CTRL-1), is
idempotent by its fence and the listed transitions, and verifies its subject's state before any effect (D8-CONS-1, D8-DUP-1).

## 12. Commands and reads

| command | route, role | body | answer | closed outcomes beyond B06's common ones |
|---|---|---|---|---|
| CMD036 ExecuteProject | POST /api/v1/projects/{projectId}/execute, AGENCY_OPERATOR | commercialAuthorizationId | 202 ACCEPTED (operationId jobId, statusPath /api/v1/jobs/{jobId}, poll 10 s) | 404 NOT_FOUND; 409 PRECONDITION_FAILED AUTHORIZATION_REVOKED, PLAN_NOT_APPROVED, AGENCY_NOT_ACTIVE, PROJECT_NOT_OPEN; 422 SOURCE_EXPIRED; 422 TARGET_STALE; CAPABILITY_UNAVAILABLE MODE_NOT_OFFERED; 503 CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL |
| CMD037 CancelJob | POST /api/v1/jobs/{jobId}/cancel, AGENCY_OPERATOR | expectedVersion, reasonCode | 200 JobView (CANCEL_REQUESTED, cancelVersion, activeProviderState, publishedPackageId) | 409 STALE_VERSION; 409 PRECONDITION_FAILED JOB_TERMINAL, JOB_ALREADY_READY |
| CMD020 StartAudit | POST /api/v1/revisions/{revisionId}/audits, AGENCY_OPERATOR | targetContractId, auditPolicyVersion | 202 ACCEPTED (auditId) | 409 PRECONDITION_FAILED REVISION_NOT_SEALED, AUDIT_EXISTS; 422 SOURCE_EXPIRED; 422 TARGET_STALE; 429 ADMISSION_LIMITED AUDIT_CONCURRENCY_LIMITED; 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT |
| CMD021 CancelAudit | POST /api/v1/audits/{auditId}/cancel, AGENCY_OPERATOR | expectedVersion | 200 AuditView | 409 STALE_VERSION; 409 PRECONDITION_FAILED AUDIT_TERMINAL |
| CMD022 CreatePlan | POST /api/v1/audits/{auditId}/plans, AGENCY_OPERATOR | candidateDecisionArtifactRef | 201 PlanView | 400 with the compiler reason on the field; 409 PRECONDITION_FAILED AUDIT_NOT_DECIDABLE |
| CMD024 ValidatePlan | POST /api/v1/plans/{planId}/validate, AGENCY_OPERATOR | expectedVersion, planHash | 202 ACCEPTED (planId) | 409 STALE_VERSION (planHash mismatch); 409 PRECONDITION_FAILED PLAN_NOT_VALIDATABLE; 429 BUDGET_EXHAUSTED |
| GetJob, GetAudit | GET /api/v1/jobs/{jobId}, /api/v1/audits/{auditId}, AGENCY_READER | — | JobView, AuditView (no provider identity, object name, prompt or customer value) | 404 |
| decision-artifact intake | POST /api/v1/audits/{auditId}/decision-artifacts, AGENCY_OPERATOR (content-idempotent, not journaled) | the closed decision document | 201 or 200 STORED | 400 schema |

Every route declares its closed catalogue (B06 D-OUT-1), is served in `apps/api` through `runCommandIn`/`runReadIn` (B07 D-CMD-10),
documented under `paths` (D-API-1) and listed in the generated matrix with its applicability rows; DENY facts follow D-FACT-1.

## 13. Decisions register

| id | decision | citation |
|---|---|---|
| D8-BASE-1 | B08 is built on `b08/base` (this branch merged into the verified head of `integration/b07-b09`) and numbers its migrations 0019–0021, after B09's 0013–0017 and the B07+B09 merge's 0018, because the runner refuses a gap; B11 owns 0022–0024 and B10 0025 onward. | A4 "Construction"; B07 §17 item 1; B09 §15 item 1; B07-B09-merge D-MERGE-3 |
| D8-BASE-2 | B08 forks nothing: it adds tables, policies, grants, keys and function bodies that are supersets of what they replace (`retention_anchors_bound`, the `request_journal` grant key), each proven by the owning package's unchanged assertions. | FOUNDATION D-AGGK-5; B07 §17; B09 §15 |
| D8-BASE-3 | `b08/base` also carries the finished B08-CORE-PORTS and B08-WORKER-HOST (`b08/core-ports`, `b08/worker-host`), whose only textual conflict was the description of `@kauro/application`'s package.json (resolved to name both test-only subpaths); stage 1 therefore merges B08-PERSISTENCE-EXECUTION alone. | B07-B09-merge obligation 15; D8-FAKE-1 |
| D8-ROLE-1 | No new runtime group: request handlers serve CMD020–CMD022, CMD024, CMD036, CMD037; `kauro_control` runs every audit step, admission, attempt, verification, publication and cleanup and is B09's execution-control role for consumption and delivery; receipts stay `kauro_validator`'s through a second verified control-plane pool. | B06 D-RLS-1, D-EVID-1; B09 §15 items 11, 13; 07 "Platform topology" |
| D8-ROLE-2 | Execution evidence is the control plane's: request handlers hold no grant on attempts, staging, read-backs, verifications, packages, cleanups or the consumption columns, and a restrictive policy refuses them `kauro.execution_control_event_types()`. | B06 D-EVID-1; B07 D-ROLE-3; 10 "Internal command authentication" |
| D8-CLOCK-1 | Every lifecycle instant and deadline is `kauro.server_now()`, lease operations included (the adapter passes the server instant in SQL); tests stand in the past only through the labelled TEST CLOCK. | B07 D-CLOCK-1; 06 "Cancellation and deadlines"; 07 "Job and attempt states" |
| D8-SQL-1 | B08 raises KA080 FENCE, KA081 AUTHORITY, KA082 CAPACITY_LEDGER, KA083 GRANT, KA084 EVIDENCE, translated as §9 states. | B07 D-SQL-1; 07 "Command outcomes and error taxonomy" |
| D8-AUD-1 | One audit per (revision, target contract) — a retry or a failed audit is not a new free audit — and one live audit per agency (`capacity.agencyAudits`); absolute deadline creation + 86,400 s, interpretation deadline first INTERPRETING + 1,200 s, both set once. | 06 "Logical attempt and durable journal", "Cancellation and deadlines"; 08 (no new free audit by retrying); policy `intelligence.*` |
| D8-AUD-2 | PROFILE, INTERPRET and VALIDATE each claim `audits.fence + 1`, call the core outside any transaction and record only under that fence (KA080); the phase is a projection of the recorded steps. | 06 "Concurrency, leases and uncertain dispatch"; 07 "Audit and plan states"; B07 D-INSP-2 |
| D8-AUD-3 | INTERPRET gives the IC core the platform's `ModelTaskJournalPort` (model tasks over `request_journal`, MODEL_TASK leases): a stored response is compiled before any new dispatch, a send without a response stays UNCERTAIN and reserved, nothing new is sent after the interpretation deadline. | 06 "Logical attempt and durable journal", "Concurrency, leases and uncertain dispatch"; B06 S089, S090 |
| D8-AUD-4 | DRAFT_READY commits only under the current fence and cancel version, before the absolute deadline, with the system draft plan VALIDATED under a VALID receipt of exactly the audit's revision, target and compiled configuration (deferred guard); a later receipt after CANCELLED or EXPIRED stays evidence. | 06 "Migration validation and final states"; HASHING "Version and namespace bridges"; CMD021 failure |
| D8-GRANT-1 | StartAudit carves an AUDIT grant (≤ 150 cents free) from an AUTHORIZED, unexpired PLATFORM_MONTHLY pool under the pool's row lock and without one answers 429 BUDGET_EXHAUSTED NO_FUNDED_GRANT with nothing written; sealing reserves nothing. | R2-044; 07 "SourceRevision state machine"; 06 "Budget algebra"; CMD020; A4 "Resources" |
| D8-GRANT-2 | Every dispatch intent names a funded grant and reserves on it under the grant's row lock (FK plus BEFORE INSERT, KA083); unknown usage stays reserved until reconciled — S089's grant half, which B06 left open. | 06 "Budget algebra"; B06 §10 S089; registry CostGrant |
| D8-PLAN-1 | Typed editing stays CMD023 with `PlanPatchCompiler` bound to `PlanCompilerPort` and `ArtifactResolver` to `decision_artifacts`; CMD022 compiles an agency's candidate decision artifact against the audit's candidates; artifacts enter a content-idempotent intake; natural language is never a patch. | CMD022, CMD023; 06 "Response parser and compiler"; B06 D-API-2; B07 D-SEL-2 |
| D8-PLAN-2 | CMD024 records a validation intent with its own fence and answers 202; PLAN_VALIDATION runs `ValidatePort` on the exact subjects, `kauro_validator` writes the receipt, and only the current intent moves the plan. | CMD024; 04 "validatePlan and dryRun"; B06 D-EVID-1 |
| D8-APPR-1 | Approval stays B06's CMD025; B08 binds the real DisclosureComposer (every CLEAR with its receipt count) and extends the consequence, external-action and active-work inspectors B09 already bound over its authorizations (`activeJobs` still 0) by composition with jobs and packages (D8-XPKG-3). | CMD025, CMD026; B06 D-PLAN-3, D-PLAN-4; B09 D-INSP-B1 |
| D8-JOB-1 | One ProcessingJob per CommercialAuthorization for good and one live job per project; ExecuteProject for an authorization that has a job answers that job in whatever state, so one entitlement never starts a second execution. | CMD036 failure; 07 "CommercialAuthorization"; 10 "Processing and delivery routes" |
| D8-JOB-2 | The job binds by composite key its authorization's execution subject (a UNIQUE B08 adds to B09's table) and the receipt's core package hash; KAURO_JOB_INPUT_BINDING_V1 over them is the JOB_ATTEMPT lease subject. | registry Job.inputBindingHash; B06 D-LEASE-1; 04 "executePlan" |
| D8-AUTH-1 | CMD036 binds but does not consume: ACTIVE → CONSUMED happens with QUEUED → ADMITTED and CONSUMED → DELIVERED with publication, each bound at COMMIT to its job edge (KA081); a revocation before admission is PRE_EXECUTION and the job never launches. B09's matrix row for execution_admitted moves from CMD036 to JOB_ADMISSION (Q8-5). | Job capacity_reserved guard; 07 "CommercialAuthorization" (reversal before execution prevents launch); B09 D-MACH-B4 |
| D8-CAP-1 | Two ledgers kept only by the jobs' trigger: global ACTIVE ≤ `capacity.heavyActive` (1) and WAITING ≤ `capacity.heavyQueued` (3); per agency live jobs ≤ 3; `holds` BACKLOG → WAITING → ACTIVE → NONE, CANCEL_REQUESTED keeps it; the deferred check reads jobs and ledgers in one snapshot (KA082). | 07 "Job and attempt states"; R2-046; B07 D-UP-2, D-UP-3 |
| D8-CAP-2 | ExecuteProject over the agency's bound is 503 CAPACITY_UNAVAILABLE EXECUTION_QUEUE_FULL with nothing written and the authorization ACTIVE; `DeliveryCapacityPort` reads the same ledger, so checkout never sells into a hidden queue. | R2-046; CMD036 failure; B09 D-CAP-B1, Q-B09-19 |
| D8-SCHED-1 | The fair scheduler admits QUEUED jobs (`SKIP LOCKED`) under the global ledger lock in the order: agency's WAITING+ACTIVE jobs, agency's last admission (never first), job queued_at, job id; launch order is admitted_at, job id; pure in `@kauro/domain`, mirrored in SQL. | R2-046; 07 "fair agency scheduling" |
| D8-ATT-1 | An attempt's fence is its job's JOB_ATTEMPT lease fence (owner attempt, subject input binding, deadline execution deadline, cost authority the authorization); attempt n+1 is a takeover after attempt n is terminal or lapsed, at most three, never after cancel_command or past the execution deadline. | 07 "Job and attempt states"; registry Lease; B06 S090 |
| D8-ATT-2 | Heartbeats (30 s) reach the lease (120 s) only through ATTEMPT_MONITOR observing the identity; the worker opens no SQL pool; a lapsed lease abandons the attempt once its provider job is terminal or terminated. | 07 "Job and attempt states", "Connection budget and operating limits" |
| D8-HOST-1 | The provider identity `kauro-attempt-<attemptId>` is recorded before launch; launch creates by identity (ALREADY_EXISTS adopts); a timeout is UNCERTAIN and nothing is created again until `observe` answers; only NOT_FOUND after the host's creation horizon proves no effect. | 07 "deterministic provider job identity"; 10 "Provider adapter contract"; S056 |
| D8-STG-1 | Each attempt owns `staging/{agency}/{project}/{job}/{attempt}/`, recorded before launch; its capability names that prefix, the manifest name and the sealed ACCEPTED generations read-only; the FencedArtifactWriter writes with generation-0 preconditions, closes, hashes and re-reads, and a failed close, short write or mismatch is never a staged artifact. | 04 "Architecture and dependency boundary"; 09 "Derived data and worker scratch"; 10 "capability broker" |
| D8-STG-2 | AttemptScratchStore: a private directory with a byte quota and a checksum per segment; SCRATCH_EXHAUSTED, SHORT_WRITE and CORRUPT_INTERMEDIATE are distinct terminal causes, never a completed segment; cleanup deletes only that directory. | 04 "Resources"; 09 "Derived data and worker scratch"; S035 |
| D8-STG-3 | The control plane submits the manifest: it reads the object from the attempt's prefix at its generation, validates KAURO_STAGED_MANIFEST_V1 (attempt, fence, input binding, artifacts), registers each artifact (STAGING) and moves attempt → STAGED, job → VERIFYING, package born STAGED, refused KA080 unless the attempt owns the lease at its fence. | 10 "Internal command authentication"; Job complete_staging_submitted |
| D8-STG-4 | B07's ObjectStoragePort has no server-side write (a resumable session's holder is the browser), so the FencedArtifactWriter spools each artifact into the attempt's scratch quota, creates a session of that exact length through ObjectStoragePort (generation-0 at finalization) and writes through `ResumableUploadPort` (`ports/worker-host.ts`), the holder side B14/B15 bind to the provider's session and tests to the storage fake's `writeThroughSession`. | B07 `ports/source-providers.ts` ObjectStoragePort; 09 "Resumable session security"; D8-STG-1, D8-STG-2 |
| D8-STG-5 | Staged names are `<prefix><UUIDv8>`, the UUID the first 16 bytes of a domain-separated digest of (role, path hash) or (the manifest, attempt), because the object grammar admits only UUID components and a rewrite must meet its own generation-0 precondition; the manifest object's bytes are the canonical KAURO_STAGED_MANIFEST_V1 wrapper, so its raw SHA-256 is the digest B08-PERSISTENCE-EXECUTION's domain computes. | domain `object-names.ts` (two to five UUIDs); HASHING "Hash domain separation"; RFC 9562 §5.8 |
| D8-VER-1 | Verification reads every artifact back by exact generation from the attempt's own prefix and calls PackageVerifierPort with the sealed manifest, approved plan, target body, receipt core hash and evidence inventory the platform supplies; a partial blob, a foreign object or generation, or INVALID fails the job and REVOKES the package with its evidence kept. | 04 "verifyPackage"; 07 "Staging and publication transaction"; S061 |
| D8-PUB-1 | A VALID verification makes the package VERIFIED_PRIVATE; its artifacts are copied to `delivery/{agency}/{project}/{package}/` with generation-0 preconditions and read back, still private. | 07 "Staging and publication transaction"; 09 "Accepted immutability and sealing" |
| D8-PUB-2 | Publication locks project (shared transition lock) → job → authorization (exclusive) → plan → source → target (shared) → lease → package — the project first, as a deletion (B16) takes the project and then its jobs — and its deferred guard requires the lease's current attempt, an unchanged cancel version, the authorization CONSUMED by this job, a live approval, a SEALED available source, a current target, an offered capability, an ACTIVE agency, an OPEN project and every staging and delivery read-back equal; then AVAILABLE, READY, COMMITTED, DELIVERED together. | TRANSITIONS "Cross-aggregate finalization"; 07 "Staging and publication transaction"; R2-045; S062 |
| D8-RET-1 | Admission writes the EXECUTION_ADMITTED anchor and the PAID_ORDINARY record (hard = capture completion + 1,209,600 s, checked at COMMIT); publication writes PACKAGE_AVAILABLE and the soft deadline (+ 604,800 s, effective = minimum); the job's delivery deadline is capture completion + 172,800 s. | 09 "Retention schedule"; HASHING "Retention formulas"; B07 D-RET-2, D-ANCH-1/2; B09 §15 item 7 |
| D8-CANCEL-1 | Cancellation is a version on the job mirrored into the lease by EXECUTION_CONTROL; the worker checks its channel after every await and every control-plane unit re-reads the job under its row lock; publication is the last atomic check, so a cancellation committed first wins (§6). | 07 "Staging and publication transaction"; 06 "Cancellation and deadlines"; registry Lease.cancelVersion |
| D8-CANCEL-2 | A lost authority cancels through the same edges as a SERVICE actor with a reason token: EXECUTION_CONTROL cancels the jobs and audits a revoked authorization, a withdrawn approval or plan, a superseded or expired revision, a revoked admission or a deletion request names; cancellation is never a CRM rollback. | Plan withdraw_approval effect; DatasetRevision SEALED effects; 07 "CommercialAuthorization"; CMD026, CMD037 |
| D8-STALE-1 | Admission, CMD036 and publication read the source (SEALED with an ACTIVE governing record ahead) and the target (confirmed, not superseded) after their shared transition locks; a stale fact refuses with SOURCE_EXPIRED or TARGET_STALE and cancels the job. | 10 "Concurrency and preconditions"; B06 D-TX-2; B07 D-PERS-7 |
| D8-DUP-1 | A duplicated task is harmless: every consumer is idempotent by its fence and the listed transitions (a spent fence or a moved state is DONE), launch is create-by-identity, and no redelivery takes a second slot or reservation. | 07 "Outbox, inbox and event ordering"; S056; B07 D-CTRL-4 |
| D8-JAN-1 | STAGING_JANITOR cleans one attempt at a time: terminate its identity, list exactly its prefix, delete by generation what no AVAILABLE package retains, delete its scratch, and record one `attempt_cleanups` row with the host-reported VM, disk, cost and result; nothing outside the prefix is touched. | S075; 09 "Derived data and worker scratch"; 07 "The sweeper repairs ... abandoned leases" |
| D8-EVT-1 | B08's aggregates are Audit, CostGrant, ProcessingJob and PackageVersion, one event `<kind>.<state>.v1` per version; attempts, steps, staging, read-backs, verifications and cleanups are evidence rows; payloads carry ids, hashes, tokens and counts only. | B06 D-EVT-1/2; FOUNDATION D-AGGK-1; B07 D-OBJ-3 |
| D8-CONS-1 | Consumers JOB_EXECUTION, EXECUTION_CONTROL, AUDIT_ORCHESTRATION, PLAN_VALIDATION and the six sweepers of §11 run at least once over B07's dispatcher, bound to the agency, each verifying its subject's state before the effect. | 07 "Outbox, inbox and event ordering"; B06 D-OUTBOX-1; B07 D-CTRL-1, D-CTRL-4 |
| D8-CONS-2 | Worker-host notifications (B14's Batch events) enter B06's inbox under `kauro_ingress` and only trigger an observation by identity; a notice is never authority. | 07 "Outbox, inbox and event ordering"; B06 D-ING-1 |
| D8-LOCK-1 | Lock order: membership → project (row, then transition lock) → job → authorization → plan → source → target → agency ledger → global ledger → lease → package. JOB_ADMISSION alone takes the global ledger first, and after it takes every other lock without waiting (rows `SKIP LOCKED`, the non-blocking variant of the shared transition locks that 0019 adds), deferring a busy job to the next round, so it never waits while holding the ledger and no cycle through a deletion or a cancellation can form. | 07 "Transaction discipline"; B06 D-TX-2; B07 D-LOCK-1, D-LOCK-2 |
| D8-DL-1 | Deadlines on the server clock, never early: JOB_DEADLINES at the delivery or execution deadline (terminating the exact provider job first), AUDIT_DEADLINES at the absolute deadline, GRANT_RECONCILIATION at expiry; no retry, worker or takeover restarts a clock. | 04 "Resources"; 06 "Cancellation and deadlines"; B07 D-EXP-1 |
| D8-API-1 | Answers and catalogues as §12: CMD036 202, CMD037 200 with the reconciliation state, CMD020 202, CMD021 200, CMD022 201, CMD024 202; GetJob and GetAudit for AGENCY_READER without provider identities or object names. | 10 "Responses and safe errors", "Processing and delivery routes", "Audit and plan routes"; B06 D-RESP-1, D-OUT-1 |
| D8-PAY-1 | Payment is B09's real authorization and its fixtures (`paidPurchase`), and a revocation is B09's own payment-service write; the provider effects stay B09's labelled fakes until B15. | prompts/B08 ("Payment can be a labelled contract fake until B09/B15"); B09 §14 |
| D8-PORT-1 | The cores are reached only through the ports of §10, implemented by the thin adapter of `b05/cores`; tests bind the labelled fakes; no composition root binds a fake, and a deployment without the adapter answers INTEGRITY_FAILURE CORE_SERVICES_UNAVAILABLE. | 04 "Architecture and dependency boundary"; 06 (stubs only in labelled local tests); B07 D-SAPI-6 |
| D8-PORT-2 | Checked against kauro-migration-core 2.0.3 as released (`kauro-migration-core-release`): its public `runMigration`/`writePackage`/`promotePackage`/`verifyPackage` take plain local directories (`inputRoot`, `outputDir`, `packageDir`), not an injected `SourceReader`/`ArtifactWriter`; only `ScratchStore` is truly host-injected. `ports/core-ports.ts` keeps `SourceReader` and `ArtifactWriter` as the platform's own abstraction over the attempt's staging prefix (implemented for real by B08-WORKER-HOST); the thin adapter of `b05/cores` materializes the core's directories from them and back, rather than the core accepting either port directly. | kauro-migration-core-release `src/index.ts`, `src/run/run-migration.ts`, `src/artifacts/write-package.ts`; manual 04 "Architecture and dependency boundary" |
| D8-PORT-3 | kauro-intelligence-core's host-injected journal (`LedgerStore.append`/`read`, `src/kernel/ledger.ts`) is synchronous, while `ModelTaskJournalPort`'s real implementer is `@kauro/persistence` over PostgreSQL (async, B08-PERSISTENCE-AUDIT); the thin adapter of `b05/cores` must read the journal and buffer/replay it around one `run()` invocation rather than pass the async port straight through as `deps.ledgerStore`. `planCandidates` is satisfiable apart from `interpret` because the core exports `planTasks`/`resolveDeterministically` separately from `run` (no dispatch, no spend). | kauro-intelligence-core-privacy `src/kernel/ledger.ts`, `src/api/intelligence-core.ts`, `src/index.ts`; manual 06 |
| D8-PORT-4 | The registry's `ValidationReceipt.targetContractHash` (contracts `generated/types.ts`) is a required `Sha256Hex`, with no accommodation for a CLEAN_ONLY run that addresses no instance; `ValidatePort`'s `CoreValidationReceipt` (`ports/core-ports.ts`) types the field nullable so the port itself can answer a CLEAN_ONLY validation, and persistence (B08-PERSISTENCE-AUDIT) supplies the row's canonical "no target" hash when it writes a CLEAN_ONLY receipt. | contracts `generated/types.ts` `ValidationReceipt`; kauro-migration-core-release `src/run/run-migration.ts` `AttestationPolicy` (`NOT_APPLICABLE` for CLEAN_ONLY) |
| D8-FAKE-1 | One owner per fake: ContractFakeMigrationCore and ContractFakeIntelligenceCore (B08-CORE-PORTS, `@kauro/application/testing/cores`, beside the `@kauro/application/testing` of B07 and B09), ContractFakeWorkerHost (B08-WORKER-HOST, `@kauro/data-plane/testing`); B07's storage fake and B09's fixtures are consumed, never copied; every fake reports SIMULATED with `contract-fake-*` tokens. | B07 §15, D-STAGE1-1; B09 D-FAKE-B1; 21 "Evidence classes" |
| D8-XPKG-1 | B08's migrations were planned as 0018–0020 before the B07+B09 merge took 0018 (`kauro_payment` reads retention); they are 0019–0021 in the design, the mandates and the case-map check, with B11 at 0022–0024 and B10 from 0025. | B07-B09-merge D-MERGE-3, `migrations/0018_payment_service_source_reads.sql`; D8-BASE-1 |
| D8-XPKG-2 | `SourceAvailabilityReader` and `SourceLineageReader` are B09's collaborator ports, already bound to B07's persistence (`commercialSourceReadsOf`, binding PLATFORM) with a 0018 grant for `kauro_payment` alone, and `CommercialScopeInspector` is bound to B09's `findLiveByRevisionHash`; B08 re-binds none of them and its roles read B07's tables under grants of its own migrations. | B07-B09-merge D-MERGE-2 and obligations 5–7; `apps/api/src/edition.ts` |
| D8-XPKG-3 | B09 already binds the ActiveWork and CommercialConsequence inspectors over its authorizations (`commercialInspectionsOf`, `activeJobs` the literal 0), so B08 extends them by composition with jobs and packages, supplies the ExternalAction reading (delivered packages) and leaves B09's inspector tests unchanged. | B09 D-INSP-B1; `apps/api/src/edition.ts` (`activeWorkInspector`, `commercialConsequencesInspector`) |
| D8-XPKG-4 | `DeliveryCapacityPort` is unbound (`capacity: null` in `commerceEdition()`) and is read by `kauro_app` request units and by the payment service's SERVICE units of its adopted agency, so 0019 grants both roles column-scoped reads of the two ledgers (an adopted-agency policy for `kauro_payment`, the shape of D-MERGE-3) and B08-COMMANDS-EXECUTION binds it. | B09 D-CAP-B1; B07-B09-merge D-MERGE-3; `apps/api/src/edition.ts` |
| D8-XPKG-5 | The capture's completion instant is `capture_facts.provider_completed_at` (NOT NULL once COMPLETED or REVERSED, learned once), not `completed_at`; admission and the delivery and retention deadlines read that column, column-scoped. | `migrations/0015` `capture_facts_completion_time`, `capture_facts_learned_once`; domain `commerce/fiscal.ts` tax point |
| D8-XPKG-6 | `kauro_control` has no EXECUTE on `kauro.await_transition` (granted to `kauro_app` in 0001 and `kauro_payment` in 0013) and its `domain_events` policy from B07 admits only `source_control_event_types()`, so 0019 grants EXECUTE on `await_transition` and `try_await_transition` and adds a second insert policy over `execution_control_event_types()`. | `migrations/0001`, `0009` (control `domain_events` policy), `0013`; B07 D-CTRL-2 |
| D8-XPKG-7 | `CONSUMERS` holds 10 entries and `EVENT_SUBSCRIPTIONS` 62 on the base: B08 adds JOB_EXECUTION, AUDIT_ORCHESTRATION and PLAN_VALIDATION, and the row (`commercial_authorization.delivered.v1`, NOTIFICATIONS) goes into B09's append-only `commerce_event_subscriptions` in 0020, mirrored in domain `COMMERCE_EVENT_SUBSCRIPTIONS` with the persistence test proving them equal. | `migrations/0013` ("a later package that subscribes to a commerce event adds its row in its own migration"); B07-B09-merge obligation 3 |
| D8-XPKG-8 | `retention_records` is unique per (agency, revision, class) and its hard deadline, anchor and class never change, so admission over a revision that already has a PAID_ORDINARY record keeps it and creates only the new job's anchor; D8-STALE-1's "ACTIVE governing record ahead" is then read against the job's delivery deadline. | `migrations/0012` (`retention_records_one_per_revision_class`, `retention_records_immutable`); B07 D-RET-2; D8-RET-1 |
| D8-XPKG-9 | B09's matrix row `execution_admitted` still names CMD036 in `tools/matrix.mjs` and the generated matrix and OpenAPI documents are byte-checked by verify, so the mandate that moves the row to JOB_ADMISSION regenerates them in the same commit. | `tools/matrix.mjs` (B09 machine owners); `tools/test/matrix.test.mjs`, `tools/test/openapi.test.mjs`; D8-AUTH-1 |
| D8-XPKG-10 | Execution units of work extend `PgCommerceUnitOfWork`, the one routed factory that serves `run`, `runSource` and the commerce contexts, not a separate factory of B06. | B07-B09-merge D-MERGE-1 |
| D8-XPKG-11 | The core fakes are the separate test-only subpath `@kauro/application/testing/cores`, so the one `./testing` export of B07 and B09 and its no-production-import test stay unchanged. | B07-B09-merge obligation 15; `packages/application/package.json` exports; D8-FAKE-1 |
| D8-CEX-1 | The control plane finds its work through an `ExecutionDiscovery` port on the execution unit of work (launch candidates, monitored jobs, jobs past a deadline, attempts to clean, live jobs relying on a lost fact, an attempt's plan body and sealed generations), implemented read-only by `@kauro/persistence` over the grants 0019 and 0020 already give; no migration changes. | mandate B08-CONTROL-EXECUTION (no migration); D8-PEX-6; B07 D-CTRL-1 |
| D8-CEX-2 | `EXECUTION_SWEEPERS` in `@kauro/application` holds the four sweepers of this mandate (JOB_ADMISSION, ATTEMPT_MONITOR, JOB_DEADLINES, STAGING_JANITOR); B08-CONTROL-AUDIT adds AUDIT_DEADLINES and GRANT_RECONCILIATION to it and to `runCycle`. | §11; mandate B08-CONTROL-AUDIT |
| D8-CEX-3 | `processing_job.queued.v1` runs JOB_ADMISSION's fair round and `.admitted.v1` the launch of the next job in launch order; the free ACTIVE slot is also handed on after every JOB_EXECUTION and EXECUTION_CONTROL delivery and by the JOB_ADMISSION and ATTEMPT_MONITOR sweeps, and a takeover's attempt is launched by the monitor's next pass (one step per job per pass). | §4.2, §4.3; D8-SCHED-1; D8-ATT-1 |
| D8-CEX-4 | A read-back that differs is the verification's verdict without a verifier call, recorded INVALID with its exact token (READBACK_MISSING, READBACK_PARTIAL_BLOB, READBACK_FOREIGN_CONTENT, READBACK_GENERATION_CHANGED); a verifier's problems are reduced to tokens; the job and attempt end with the first problem and the package is REVOKED as VERIFICATION_FAILED. | D8-VER-1; S061; 0020 `package_verifications_current_attempt` (problems are tokens) |
| D8-CEX-5 | The publication re-reads the authority twice: after the shared transition locks before the delivery copies (a lost fact requests the job's cancellation with its reason as JOB_EXECUTION and revokes the package in that unit), and inside the publication transaction after the store's own locks, before COMMIT (a lost fact rolls it back, then cancels the same way). | D8-PUB-2; D8-STALE-1; D8-CANCEL-2 |
| D8-CEX-6 | EXECUTION_CONTROL's first pass over a cancellation is the one whose lease's cancel version lags the job's: it mirrors the version, terminates the identity, then observes; a later pass observes first and terminates again only a live job. A person's CMD037 reason is a label, so its package is revoked as JOB_CANCELLED, a lost authority's with its own token. | D8-CANCEL-1; D8-HOST-1; CMD037-RACE |
| D8-CEX-7 | No port carries the lease's cancellation to a running worker in this edition (Q8-6): EXECUTION_CONTROL's termination by identity stops it, and the tests stand in for the host's mirror with the worker-host fake's `signal`. | Q8-6; D8-ATT-2; D8-CANCEL-1 |
| D8-CEX-8 | A worker's SCRATCH_EXHAUSTED, SHORT_WRITE, CORRUPT_INTERMEDIATE and the envelope's other classified causes fail the job with that cause; a crash, a worker error, a terminated or lost provider job and a lapsed lease abandon the attempt and take the lease over (three attempts inside the execution wall, then ATTEMPTS_EXHAUSTED); a SUCCEEDED or FAILED observation of a STARTING attempt first takes provider_start_observed. | §4.3; S035; Q8-3; D8-ATT-1 |
| D8-CEX-9 | STAGING_JANITOR keeps the staging of an attempt whose package is REVOKED (private evidence, R2-045; its deletion past retention is B16's), registers an object its prefix holds that the registry never knew as RESIDUAL at its generation before deleting it, reads the STAGING location's retention back before its first deletion (B07's LocationPolicy) and removes the attempt's scratch under the worker host's scratch root. | D8-JAN-1; D8-VER-1; B07 D-OBJ-1, D-OBJ-2 |
| D8-CEX-10 | The control-plane tests stand after a lease's expiry through the labelled TEST CLOCK set transaction-locally in every unit the control plane opens, with the worker host's clock moved as far, and hold a step inside a unit of work or a provider's answer by test decorators of the unchanged adapters and of the fakes' answers; they own no fake. | D8-CLOCK-1; D8-FAKE-1; B07 D-CMD-15 |
| D8-PEX-1 | The JOB_ATTEMPT lease is claimed at admission, before the execution deadline exists (it starts at launch), and a B06 lease's deadline never changes, so the lease's deadline is the job's delivery deadline and the execution deadline is enforced on the job row (D8-PEX-2). | D8-ATT-1; B06 `leases` (0006, immutable deadline); mandate B08-PERSISTENCE-EXECUTION |
| D8-PEX-2 | The execution deadline is set once, by the launch edge (the job's WAITING slot becoming ACTIVE), as launch + 28,800 s and never past the delivery deadline; no takeover moves it. | D8-ATT-1; D8-DL-1; 04 "Resources" |
| D8-PEX-3 | Anchors stay one per revision and kind under B07's unchanged `retention_anchors_once_per_revision`: the first admission of a revision writes EXECUTION_ADMITTED and a later purchase of that revision reuses it, and the first publication writes PACKAGE_AVAILABLE; a job-scoped index would break B07's ON CONFLICT inference. | B07 `migrations/0012`; D8-XPKG-8; D8-BASE-2 |
| D8-PEX-4 | ProcessingAttempt and PackageVersion are exported as `EXECUTION_PLATFORM_MACHINES` instead of joining `PLATFORM_STATE_MACHINES`, whose exact contents B06's and B09's domain suite fixes; `machine()` and the persistence seed tests read both. | D8-BASE-2; `packages/domain/test/end-client-project.test.ts` |
| D8-PEX-5 | Beside B09's UNIQUE `commercial_authorizations_execution_subject`, 0019 adds the UNIQUE `validation_receipts_core_binding` on B06's receipts, so a job's core package hash is its approval's receipt's by key (`processing_jobs_receipt_fk`); a binding target only, nothing on a receipt changes. | D8-JOB-2; D8-BASE-2; B06 `migrations/0004` |
| D8-PEX-6 | The control plane reads the jobs and agency ledgers of every agency, because JOB_ADMISSION's fair round orders the QUEUED jobs of all agencies, while each of its writes stays bound to the agency of its SYSTEM context. | D8-SCHED-1; B07 D-CTRL-1 |
| D8-PEX-7 | The publication's soft deadline is a version of the PAID_ORDINARY record and needs an event type of its own: `retention_record.soft_deadline_set.v1`, registered in 0020, appended additively to B07's source-model event list and inserted by the control plane alone. | D8-RET-1; D8-EVT-1; B06 D-EVT-1 |
| D8-PEX-8 | The pair of an authorization and its job is bound by the two deferred bounds rather than a foreign key, and the consumption and delivery bounds exempt a superuser session (which can disable any trigger), because B09's suites consume and deliver an entitlement as the superuser oracle standing in for B08 (B09-F2, the api scenario S059) and stay unchanged; every runtime role remains bound. | D8-AUTH-1; `packages/persistence/test/b09-critique.test.ts` B09-F2; `apps/api/test/b09-scenarios.test.ts` S059; D8-BASE-2 |
| D8-PEX-9 | The S062 deletion half writes the project's DELETION_REQUESTED version with a stand-in event of the registered type `project.created.v1` until B16 registers CMD042's own type; the stand-in lives only in that test. | S062; B16 CMD042-RACE; B06 D-EVT-1 |
| D8-PEX-10 | The failure reasons of KA083 (NO_FUNDED_GRANT, GRANT_CEILING) join the vocabulary now with those of KA080–KA082 and KA084, so the Problem enum and the SQLSTATE map change once; only B08-PERSISTENCE-AUDIT raises KA083. | D8-SQL-1 |
| D8-PEX-11 | Publication locks the authorization's row in D8-PUB-2's position and takes its exclusive transition half with the DELIVERED update itself, after the lease and package rows; the row lock already orders it with a revocation, which updates the same row first (R2-045 proves both interleavings). | D8-PUB-2; D8-LOCK-1; B06 D-TX-2 |
| D8-PEX-12 | CMD036 moves its agency's live-job count through the ledger trigger, which runs as the writer, so `kauro_app` also holds INSERT and UPDATE of `agency_execution_capacity` (agency_id, live_jobs, updated_at) under its tenant policy; an edit around the jobs is refused at COMMIT (KA082), proven as `kauro_app` in R2-046. | D8-CAP-1; D8-XPKG-4; D8-ROLE-2 |
| D8-CMD-1 | `ExecutionStore.readAuthority` takes the execution subject, not the job row, because ExecuteProject reads the approval, source, target and capability facts before any job exists and learns the source and target ids from them to take their transition locks; a `ProcessingJobRecord` is such a subject, so admission and publication call it unchanged. | design §4 item 1; D8-LOCK-1; D8-JOB-2; `packages/domain/src/ports/execution-store.ts` |
| D8-CMD-2 | `JOB_TERMINAL` and `JOB_ALREADY_READY` answer with no next actions, because a job that ended or whose package was delivered is final and reloading or retrying changes nothing; a reason may therefore override the actions of its code, and every other reason keeps them. | CMD037-DENY; D8-CANCEL-1; `packages/application/src/api/problems.ts` |
| D8-CMD-3 | The execution store reads the platform ledger as the one row it is, with no `ledger_id` predicate, because `kauro_app` holds SELECT on the columns `active_jobs` and `waiting_jobs` of it only (0019) and a predicate on the key column made every ExecuteProject fail with 42501, which the map answers as a missing tenant context. | D8-CAP-1; D8-ROLE-2; D8-PEX-12; `packages/persistence/src/execution/store.ts` |
| D8-CMD-4 | The failure reasons `AUTHORIZATION_REVOKED`, `JOB_TERMINAL` and `JOB_ALREADY_READY` join the vocabulary now, so the Problem enum, the closed schemas and the OpenAPI document change once for the outcomes §12 already lists. | §12 (CMD036 and CMD037 rows); D8-PEX-10; `packages/domain/src/model/execution/failure-reasons.ts` |
| D8-CMD-5 | The execution unit of work also exposes `serverInstant()`, the database's own transaction time on its connection, because ExecuteProject judges the source's retention deadline against the database clock at the request and a handler that read the process clock could disagree with the instants the triggers stamp. | D8-CLOCK-1; D8-STALE-1; `packages/domain/src/ports/execution-store.ts` |
| D8-CMD-6 | The edition's external-action inspector is renamed from `noExternalActionsInThisEdition` to `externalActionInspector`, because it now names the delivered packages of a plan; the three inspectors stay the ones B09 composed and B08 extends them with its jobs and packages (the client's live jobs, the plan's unreconciled jobs after B09's facts), so no B09 inspector is replaced. | D8-XPKG-3; `apps/api/src/edition.ts` |
| D8-CMD-7 | A second authorization's ExecuteProject while its project's first job is live is refused by the database's `processing_jobs_one_live_per_project` (23505), an outcome no §12 catalogue names and no SQLSTATE map entry translates, so it surfaces as the opaque 500 INTERNAL_ERROR under its correlation id with the unit rolled back and nothing written, until a later package chooses its reason. | D8-JOB-1; §12 (CMD036 row); `packages/persistence/migrations/0019_execution_jobs_capacity.sql` |
| D8-PAU-1 | The PLATFORM_MONTHLY pool has no agency and B06's event binding admits only an event of an aggregate of its own agency, so a pool's versions carry no domain event (its state, version and instants are its record) and the cost_grant events record the AUDIT grants' versions. | `migrations/0005` `require_event_for_version`, `0008` `domain_events_bind_aggregate`; D8-EVT-1; Q8-1 |
| D8-PAU-2 | The ModelTaskJournalPort's events are opaque (D8-PORT-3), so the core's fenced log is a table of its own, `model_task_journal` (run, position, the INTERPRET step's fence), beside the typed `model_tasks` and B06's request journal; a run belongs to one audit and only the INTERPRET step of the audit's current fence appends (KA080). | D8-AUD-3; D8-PORT-3; `@kauro/application` `ports/core-ports.ts` |
| D8-PAU-3 | A grant's reserved and spent cents change without a version, and a request handler's own statement never moves them: a dispatch intent's reservation and an AUDIT grant's hold on its pool do, a trigger level deeper, and so does the control plane's reconciliation (KA083). | registry CostGrant; D8-GRANT-2; 0019 `agency_execution_capacity_guard` |
| D8-PAU-4 | An AUDIT grant expires with its audit's absolute window (creation + 86,400 s, never past its pool's expiry), set by the database, and its pool holds its whole ceiling from its authorization until it closes, when the hold becomes its reconciled spend on the pool. | registry Audit invariant; D8-GRANT-1; D8-CLOCK-1 |
| D8-PAU-5 | A platform pool funds a tenant-less or an agency's dispatch intent and an AUDIT grant only its own agency's; a model task's intent names exactly its audit's grant within its maximum cost, at the MODEL_TASK lease's current fence, while the audit interprets and before the interpretation deadline. | D8-GRANT-2; D8-AUD-3; B06 `journals-leases.test.ts` S089 (a tenant-less attempt) |
| D8-PAU-6 | The current-intent rule binds only a plan that has validation intents, so B06's plan paths without one keep moving VALIDATING -> VALIDATED on a VALID receipt; ValidatePlan and the system drafts always record one. | D8-PLAN-2; D8-BASE-2; `migrations/0004` |
| D8-PAU-7 | An audit binds its subject by composite keys to two UNIQUE constraints 0021 adds, on B07's `dataset_revisions` (agency, project, revision, manifest hash) and `target_contracts` (agency, project, contract, body hash): binding targets only. | D8-BASE-2; D8-AUD-1 |
| D8-PAU-8 | The ModelTaskJournalPort and B06's ArtifactResolver are written structurally in `@kauro/persistence` (`modelTaskJournalOf`, `decisionArtifactResolver`), each journal call a control-plane unit of its own, because the adapter does not depend on `@kauro/application`. | D8-XPKG-3; D8-AUD-2; `architecture.rules.json` |
| D8-PAU-9 | The audit store rides a unit of work of its own that extends the execution one (`AuditUnitOfWork`, `PgAuditUnitOfWorkFactory`) instead of widening `ExecutionUnitOfWork`, so the stage-2 mandates that bind the execution factory are untouched. | D8-XPKG-10; mandates B08-COMMANDS-EXECUTION, B08-CONTROL-EXECUTION |
| D8-PAU-10 | The reasons AUDIT_EXISTS and AUDIT_CONCURRENCY_LIMITED, the answers of 0021's audit keys, join the vocabulary now (the Problem enum is regenerated); the other audit outcomes of §12 are B08-COMMANDS-AUDIT's. | D8-SQL-1; D8-PEX-10; §12 |
| D8-CMA-1 | The four audit commands, GetAudit and the decision artifact intake run on B06's pipeline (`runCommandIn`, `runReadIn`) in an `AuditUnitOfWork` of the api's one unit-of-work factory, so the access decision, the journal reserve or replay and the commit keep D-PIPE-1's order and no second pipeline exists. | D8-PAU-9; B06 D-PIPE-1; `packages/application/src/audit/handlers/shared.ts` |
| D8-CMA-2 | CreatePlan locks the audit row, requires NEEDS_DECISION and the agency's CANDIDATE_DECISIONS artifact of that audit (a foreign, missing or wrong-kind reference is one UNKNOWN_REFERENCE), recomputes the body's KAURO_PLAN_BODY_V1 digest, requires the audit's own revision and target, and inserts the plan DRAFT then VALIDATION_REQUIRED in one unit without writing the audit, so one audit may back several plans; a stale move of a plan inserted in the same unit is an INTEGRITY_FAILURE, never a 409. | D8-PLAN-1; N10; `packages/application/src/audit/handlers/create-plan.ts` |
| D8-CMA-3 | ValidatePlan checks expectedVersion, then the planHash the caller reviewed (STALE_VERSION with `mismatch: [planHash]`), then that the plan is VALIDATION_REQUIRED (PLAN_NOT_VALIDATABLE); it calls no core and spends no budget, and the receipt settles the intent later. | D8-PLAN-2; D8-PAU-6; `packages/application/src/audit/handlers/validate-plan.ts` |
| D8-CMA-4 | StartAudit and ValidatePlan answer 202 ACCEPTED with the audit or the plan as the operation, its state, its read as the status path and one polling interval, with no aggregate version; OpenAPI documents the two 202s per command. | D8-API-1; 10 "Long work returns 202"; `packages/application/src/audit/contracts.ts`; `tools/openapi.mjs` |
| D8-CMA-5 | The edition binds the plan services itself: the decision artifacts of 0021, the patch compiler over the Intelligence core's plan compiler and the real disclosure composer; with no core adapter CreatePlan and RevisePlan answer INTEGRITY_FAILURE CORE_SERVICES_UNAVAILABLE with nothing written, ApprovePlan has no unavailable outcome, and PLAN_SERVICES_UNAVAILABLE stays in the vocabulary unanswered. This refines B06's I-INT-2 and B06's CMD023 and CMD025 tests stay unchanged. | D8-PORT-1; B06 I-INT-2; 07 "Command outcomes and error taxonomy"; `apps/api/src/edition.ts` |
| D8-CMA-6 | The disclosure composer is computed from records alone, one safe token per mapping (`intent kind:object.field:physical source rows`) with `includesClear` when a CLEAR is disclosed, and the hash binds the plan hash and the receipt hash so a disclosure set cannot be replayed onto another plan or evidence. | owner manual 11/07; D8-PLAN-1; `packages/application/src/audit/disclosure-composer.ts` |
| D8-CMA-7 | The decision artifact intake is a route without an idempotency key or a journal entry: content-idempotent per subject (201 stored, 200 the same document again), operator role, the audit in any state, the document bounded to 131072 UTF-8 bytes; the four commands' bodies and the intake envelope are closed request schemas validated at the boundary. | D8-PLAN-1; B07 D-SEL-2; `packages/application/src/audit/handlers/intake.ts`; `request-schemas.ts` |
| D8-CMA-8 | CancelAudit decides a finished audit (AUDIT_TERMINAL) before comparing the version, so a retry that read the audit before it ended is told what became of it, and the audit row lock is the one fence it shares with the orchestration's edges; its 200 and GetAudit share one safe view that never carries a hash, the requester, a step, a task, the pool or a provider. | D8-CANCEL-1; D8-AUD-2; `packages/application/src/audit/handlers/cancel-audit.ts`, `projections.ts` |
| D8-CMA-9 | StartAudit reads the revision's availability through the source store of its unit of work and compares its retention with the database's clock (SOURCE_EXPIRED), requires the revision's manifest hash and the availability record to agree (else INTEGRITY_FAILURE), and carves a grant of the policy's free audit ceiling under the price profile of the audit policy. | D8-STALE-1; D8-CLOCK-1; D8-GRANT-1; `packages/application/src/audit/handlers/start-audit.ts` |
| D8-CMA-10 | The Plan machine's `valid_receipt` and `invalid_receipt_result` edges belong to B08's PLAN_VALIDATION consumer and CostGrant's initial PREPARED to CMD020, whose store call also authorizes the grant from its pool; ValidatePlan only records the intent, and the matrix's applicability rows cite the tests of the four commands. | D8-PLAN-2; D8-GRANT-1; `tools/matrix.mjs` |
| D8-CAU-1 | The control plane finds its audit work through an `AuditDiscovery` port on the audit unit of work (audits past their deadline, the live audits of a lost revision, a step's sealed generations and open draft intents, a plan's current intent, the grants due and their usage under row locks), implemented read-only by `@kauro/persistence` over the grants 0019–0021 already give; no migration changes. | mandate B08-CONTROL-AUDIT (no migration); D8-CEX-1; D8-PAU-9 |
| D8-CAU-2 | The execution options of the control plane carry the audit units of work, the cores' four audit ports, the validator's write path (`ValidationReceipts`: persistence's recorder over a second pool the composition verifies to be a kauro_validator member, `openValidatorReceipts`) and the core package hash the platform expects; a deployment binds none of them (D8-PORT-1). | D8-ROLE-1; D8-PAU-9; 08 "Database isolation" |
| D8-CAU-3 | The Migration-core fake names one core package hash per installed core, not one per plan, and the platform binds the hash it expects: a receipt naming another core is a contract failure (ERROR), never recorded. | registry ValidationReceipt.corePackageHash ("Actual consumed MC package bytes"); B03 IC-03; D8-FAKE-1 |
| D8-CAU-4 | The Intelligence-core fake's COMPILED decisions carry the system draft's plan body of its candidate manifest's own source and target (the manifest names both), and its compiler answers the body's KAURO_PLAN_BODY_V1 digest as B06's PatchCompilation defines; the control plane recomputes the digest and fails the audit on another one, as CMD023 refuses it. | B06 D-PLAN-5; `ports/plan-services.ts` PatchCompilation; D8-FAKE-1 |
| D8-CAU-5 | INTERPRET re-derives the candidate manifest with `planCandidates` (no dispatch, no spend) from the recorded profile evidence and fails the audit on a manifest whose hash is not the recorded one, since the audit stores only the hash; the Intelligence core's run is the audit itself, so an INTERPRET step at fence + 1 finds the stored response before any new dispatch. | D8-AUD-3; D8-PORT-3; 0021 `model_task_journal` |
| D8-CAU-6 | ValidatePort's receipt also carries the registry's `counts` (RowCounts), which only the validator can establish and the receipt row requires; the Migration-core fake reports a simulated source of one conserved record. | registry ValidationReceipt.counts; 0004 `validation_receipts.counts`; D8-FAKE-1 |
| D8-CAU-7 | A receipt's hash is KAURO_VALIDATION_RECEIPT_V1 over every field, its id included, so two validations of one body are two receipts; a receipt of exactly the intent's body, source, target and core is recorded by the validator's pool before the settlement, as evidence even when the intent or the audit moved meanwhile, and a null, incomplete, foreign or contradictory one is never recorded and settles its intent ERROR. | D8-PLAN-2; D8-AUD-4; HASHING "Hash domain separation"; B03 IC-03 |
| D8-CAU-8 | AUDIT_ORCHESTRATION acts on an audit event only at the audit's own version (an older one finds it moved on: DONE) and runs the step of the audit's state, so audit.profiling.v1 of a PROFILE claim whose result was lost claims fence + 1; audit.cancelled.v1 settles the system draft's open intent CANCELLED, and AUDIT_DEADLINES does so in its expiry unit, since audit.expired.v1 is the agency's. | D8-AUD-2; §7 (audit step claimed, result lost); D8-DUP-1; D8-AUD-4 |
| D8-CAU-9 | PROFILE reads the sealed ACCEPTED generations through B08-WORKER-HOST's GenerationSourceReader under a read-only capability naming the audit as its job and the step as its attempt (the derived prefix and manifest name are never written: PROFILE writes no artifact), and PROFILE and each validation run in an AttemptScratchStore of their own under the control plane's scratch root, removed after the call. | §3 step 1; D8-STG-1; D8-STG-2 |
| D8-CAU-10 | GRANT_RECONCILIATION, under the grant's and its requests' row locks, joins a KNOWN usage to the spend, releases as CANCELLED with nothing spent only a RESERVED intent the check before SEND_STARTED would refuse, keeps every other usage reserved, then takes the edges its state admits on the server clock; an AUDIT grant's scope closes when its audit ends and a pool's only with its expiry. | D8-GRANT-2; D8-DL-1; 0021 `request_journal_model_task_send`; registry CostGrant |
| D8-CAU-11 | InterpretResult carries no finding codes, so NEEDS_DECISION records AGENCY_DECISION_REQUIRED and UNSUPPORTED CAPABILITY_NOT_SUPPORTED, while VALIDATE's NEEDS_DECISION records the receipt's blocking issues, each reduced to a safe token. | 0021 `audits_terminal_explained`; `ports/core-ports.ts` InterpretResult; 07 "Audit and plan states" |
| D8-INT-1 | B08-COMMANDS-AUDIT and B08-CONTROL-AUDIT both registered D8-CAU-1..n in parallel; the commands mandate's ten became D8-CMA-1..10 (commands, audit, beside D8-CMD) in every citation when B08-INTEGRATION merged it, and the control mandate keeps D8-CAU-1..11 (control, audit, beside D8-CEX). | §13 (one row per decision, `tools/test/b08-design.test.mjs`); B08-case-map header |
| D8-INT-2 | The stage-3 merges and the B08-INTEGRATION mandate share `b08/integration`, cut from `b08/stage-2` as the orchestration instructed, instead of a separate `b08/stage-3`; both audit mandates' suites ran on the merged state before the end-to-end tests were written, and verify runs on the result. | `B08-mandates.json` bases (`b08/stage-3`, `b08/integration`); A4 "Construction" |
| D8-INT-3 | The end-to-end tests seal their source through B07's handlers and this control plane instead of the execution world's fixture, whose admitted generations no storage fake holds, so a whole runCycle's OBJECT_INVENTORY revokes their admission as it must; the world gains only additive helpers. | B07 D-FILE-1, D-OBJ-2; mandate B08-INTEGRATION ("one set of labelled fakes"); `apps/control/test/b08-end-to-end.test.ts` |

## 14. Open questions for the authority

| # | question | interim decision |
|---|---|---|
| Q8-1 | No catalogue command funds the platform's monthly model pool (CostGrant PREPARED → AUTHORIZED; B09 re-assigned the edge to B03). | An operations act under `kauro_control` writes the pool (owner-approved grant, A4 "Resources"); tests use a fixture; R2-044 needs only its absence. |
| Q8-2 | The registry has no per-agency execution bound. | Live jobs per agency ≤ `capacity.heavyQueued` (3) (D8-CAP-1). |
| Q8-3 | The registry has no attempt limit per job. | Three, all inside the original execution deadline (D8-ATT-1). |
| Q8-4 | May a job cancelled before admission free its authorization for another ExecuteProject? | No: one job per authorization for good (D8-JOB-1); a new execution is B10's credit or re-quote path. |
| Q8-5 | B09's machine names CMD036 as the performer of execution_admitted. | Consumption at admission (D8-AUTH-1); the generated matrix row moves. |
| Q8-6 | The heartbeat transport of a real Batch worker (callback route or provider observation). | Observation by identity (D8-ATT-2); B14 may add an authenticated callback that only triggers an observation. |
| Q8-7 | Plan VALIDATED → WITHDRAWN (withdraw_plan) and the assigned paid validation grant have no command. | Not performed by B08. |
| Q8-8 | Package listing and download (GET /projects/{projectId}/packages, CMD038) are named in 10 but owned by B13 and B16. | B08 exposes only the package id on the JobView. |

## 15. Handoff

`docs/design/B08-mandates.json` is the hand-off: nine mandates with their base, dependencies, fakes, migrations and the case-map tests
each writes **first**. `tools/test/b08-case-map.test.mjs` refuses a cited test file that exists without the exact title and a planned
file no mandate owns; `tools/test/b08-design.test.mjs` refuses a registry edge of Audit, Job or CostGrant missing from §8, an
unreachable platform state, a dangling or duplicated decision and a migration not owned by exactly one mandate. Common rules: real
PostgreSQL 17, never a database fake; interleavings by hold points and lock waits in `pg_stat_activity`, never sleeps; tests first;
`pnpm run verify` green before a mandate reports; the matrix owner rows and served inventory of what a mandate adds; no fake bound by
a composition root.
