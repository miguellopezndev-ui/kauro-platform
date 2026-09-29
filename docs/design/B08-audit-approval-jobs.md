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

The implementation base is `b08/base`: this branch merged into the verified head of `integration/b07-b09`, which carries B09's
migrations 0013–0017. B08 numbers 0018–0020 and cannot apply on `b07/integration` alone, because the runner refuses a gap
(D8-BASE-1). Mandates (`B08-mandates.json`) run in four stages, at most five agents at once (A4):

| stage | mandates (branch `b08/<key in lower case>`) | merged into |
|---|---|---|
| 1 | B08-PERSISTENCE-EXECUTION ∥ B08-CORE-PORTS → B08-WORKER-HOST | `b08/stage-1` (from `b08/base`) |
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

## 9. Migrations 0018–0020

PostgreSQL 17, schema `kauro`, the B06/B07 conventions: `agency_id` on every tenant row, composite keys bind scope, UUIDv7 ids,
lifecycle instants the server's (`kauro.server_now()`), money BIGINT cents, JSONB only for closed documents, `version` plus one event
per version on aggregates, kinds registered in `kauro.aggregate_kinds`, forced RLS, no DELETE for request handlers.

| migration | objects | key constraints and triggers | roles and RLS | mandate |
|---|---|---|---|---|
| 0018_execution_jobs_capacity.sql | kind `processing_job`; Job and ProcessingAttempt seeded; `processing_job.*.v1` types and `kauro.execution_control_event_types()`; `execution_capacity`, `agency_execution_capacity`, `processing_jobs`, `processing_attempts`; UNIQUE `commercial_authorizations_execution_subject` on B09's table; `projects` state transition lock; anchor kind EXECUTION_ADMITTED; `kauro.try_await_transition` (the non-blocking shared transition lock, D8-LOCK-1); SQLSTATE KA080–KA084 | one job per authorization, one live job per project; composite key to the authorization's subject and to the receipt; `holds` edges and ledger trigger with the one-snapshot deferred check (KA082); attempt fence = lease fence, identity `kauro-attempt-<id>`, prefix canonical, one live attempt, at most three, none after cancel_command (KA080, KA081); consumption bound at COMMIT (KA081); PAID_ORDINARY record hard deadline = capture completion + 1,209,600 s at COMMIT | `kauro_app`: insert QUEUED jobs of its tenant, the cancel_command columns only; `kauro_control` (bound agency): admission, attempts, leases, consumption edge of `commercial_authorizations` with SELECT on `commerce_event_bindings`, its restrictive outbox subscriber policy, the anchor and PAID_ORDINARY insert; column-scoped reads of plans, approvals, target contracts, projects, agencies, sealed manifests, receipts and `capture_facts.completed_at`; request handlers refused the control-plane event types | B08-PERSISTENCE-EXECUTION |
| 0019_staging_verification_packages.sql | kind `package_version`; PackageVersion seeded; `package_version.*.v1`; `staged_manifests`, `staged_artifacts`, `artifact_readbacks`, `package_verifications`, `package_versions`, `delivery_artifacts`, `attempt_cleanups`; anchor kind PACKAGE_AVAILABLE; `retention_anchors_bound` replaced by a superset | staged rows only from the lease's current attempt while RUNNING, objects only under that attempt's prefix (KA080); one VALID verification per attempt; one AVAILABLE package per job; publication guard deferred (KA080, KA081, KA084); delivery objects only under the package's prefix; cleanup rows name objects of exactly their attempt | all writes `kauro_control` (bound); `kauro_app` reads packages, verifications' result and the job's evidence summary of its tenant, never an object name or provider identity | B08-PERSISTENCE-EXECUTION |
| 0020_audits_cost_grants.sql | kinds `audit`, `cost_grant`; Audit and CostGrant seeded; `audit.*.v1`, `cost_grant.*.v1`; `cost_grants`, `audits`, `audit_steps`, `model_tasks`, `decision_artifacts`, `plan_validations`; FK and reservation trigger on B06's `request_journal.cost_grant_id` | `reserved + reconciled_spend <= ceiling`; AUDIT ceiling within policy and held on its pool; a dispatch intent reserves on an AUTHORIZED unexpired grant (KA083); one audit per (revision, target), one live per agency; steps only under the current fence (KA080); DRAFT_READY guard deferred; artifacts content-idempotent | `kauro_app`: StartAudit's audit, AUDIT grant and pool reservation (column grant, deferred check), CancelAudit's columns, artifacts, validation intents; `kauro_control`: steps, model tasks, grant reconciliation, system draft plans and the validation edges of `plans`; `kauro_validator` unchanged | B08-PERSISTENCE-AUDIT |

SQLSTATE translation (`sqlstate.ts`, D8-SQL-1): KA080 FENCE → PRECONDITION_FAILED / EXECUTION_FENCED (the control plane treats it as
"the attempt or step lost": DONE); KA081 AUTHORITY → PRECONDITION_FAILED / EXECUTION_AUTHORITY_LOST; KA082 → INTEGRITY_FAILURE /
CAPACITY_LEDGER, and the ledger CHECKs → CAPACITY_UNAVAILABLE / EXECUTION_QUEUE_FULL (retryable); KA083 → BUDGET_EXHAUSTED /
NO_FUNDED_GRANT, the grant ceiling CHECK → BUDGET_EXHAUSTED / GRANT_CEILING; KA084 → INTEGRITY_FAILURE / PUBLICATION_EVIDENCE_MISSING.
`runtime-boundary.json` is re-read from a cluster migrated to 0020 and reviewed entry by entry.

## 10. Ports and implementers

| port | defined in | implemented by | tests bind (fake owner) |
|---|---|---|---|
| ProfilePort, ValidatePort, ExecutionEnvelopePort, PackageVerifierPort | `@kauro/application` `ports/core-ports.ts` | the cores adapter of `b05/cores` over kauro-migration-core 2.0.3 | ContractFakeMigrationCore (B08-CORE-PORTS) |
| InterpretPort (planCandidates, interpret), PlanCompilerPort | `@kauro/application` `ports/core-ports.ts` | the cores adapter over kauro-intelligence-core 0.4.0 | ContractFakeIntelligenceCore (B08-CORE-PORTS) |
| SourceReader, ScratchStore, ArtifactWriter, CancellationChannel (the host I/O of 04) | `@kauro/application` `ports/core-ports.ts` | `@kauro/data-plane` GenerationSourceReader, AttemptScratchStore, FencedArtifactWriter (B08-WORKER-HOST) | real |
| WorkerHostPort (launch, observe, terminate, resources by identity) | `@kauro/application` `ports/worker-host.ts` | B14 (Cloud Batch) | ContractFakeWorkerHost (B08-WORKER-HOST) |
| ModelTaskJournalPort | `@kauro/application` `ports/core-ports.ts` | `@kauro/persistence` over `model_tasks`, `request_journal`, `cost_grants` (B08-PERSISTENCE-AUDIT) | real |
| ExecutionStore, AuditStore | `@kauro/domain` `ports/execution-store.ts`, `ports/audit-store.ts` | `@kauro/persistence` (B08-PERSISTENCE-EXECUTION, B08-PERSISTENCE-AUDIT) | real |
| DeliveryCapacityPort (B09) | `@kauro/application` (B09) | `@kauro/persistence` over the ledgers (B08-PERSISTENCE-EXECUTION) | real |
| CommercialConsequenceInspector, ExternalActionInspector, ActiveWorkInspector (B06) | `@kauro/application` | `@kauro/persistence` over jobs, packages and B09's authorizations (B08-PERSISTENCE-EXECUTION) | real |
| ArtifactResolver, PlanPatchCompiler, DisclosureComposer (B06) | `@kauro/application` | resolver over `decision_artifacts` (B08-PERSISTENCE-AUDIT); compiler via PlanCompilerPort and the composer (B08-COMMANDS-AUDIT) | real |
| ObjectStoragePort (B07), SourceAvailabilityReader (B07) | B07 | B15 / B07-PERSISTENCE | ContractFakeObjectStorage (B07-PROVIDER-FAKES) |

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
| `commercial_authorization.delivered.v1` | NOTIFICATIONS (B08 adds the subscription) |
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
| D8-BASE-1 | B08 is built on `b08/base` (this branch merged into the verified head of `integration/b07-b09`) and numbers its migrations 0018–0020, after B09's 0013–0017, because the runner refuses a gap. | A4 "Construction"; B07 §17 item 1; B09 §15 item 1 |
| D8-BASE-2 | B08 forks nothing: it adds tables, policies, grants, keys and function bodies that are supersets of what they replace (`retention_anchors_bound`, the `request_journal` grant key), each proven by the owning package's unchanged assertions. | FOUNDATION D-AGGK-5; B07 §17; B09 §15 |
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
| D8-APPR-1 | Approval stays B06's CMD025; B08 binds the real DisclosureComposer (every CLEAR with its receipt count) and the real consequence, external-action and active-work inspectors over jobs, packages and B09's authorizations. | CMD025, CMD026; B06 D-PLAN-3, D-PLAN-4 |
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
| D8-LOCK-1 | Lock order: membership → project (row, then transition lock) → job → authorization → plan → source → target → agency ledger → global ledger → lease → package. JOB_ADMISSION alone takes the global ledger first, and after it takes every other lock without waiting (rows `SKIP LOCKED`, the non-blocking variant of the shared transition locks that 0018 adds), deferring a busy job to the next round, so it never waits while holding the ledger and no cycle through a deletion or a cancellation can form. | 07 "Transaction discipline"; B06 D-TX-2; B07 D-LOCK-1, D-LOCK-2 |
| D8-DL-1 | Deadlines on the server clock, never early: JOB_DEADLINES at the delivery or execution deadline (terminating the exact provider job first), AUDIT_DEADLINES at the absolute deadline, GRANT_RECONCILIATION at expiry; no retry, worker or takeover restarts a clock. | 04 "Resources"; 06 "Cancellation and deadlines"; B07 D-EXP-1 |
| D8-API-1 | Answers and catalogues as §12: CMD036 202, CMD037 200 with the reconciliation state, CMD020 202, CMD021 200, CMD022 201, CMD024 202; GetJob and GetAudit for AGENCY_READER without provider identities or object names. | 10 "Responses and safe errors", "Processing and delivery routes", "Audit and plan routes"; B06 D-RESP-1, D-OUT-1 |
| D8-PAY-1 | Payment is B09's real authorization and its fixtures (`paidPurchase`), and a revocation is B09's own payment-service write; the provider effects stay B09's labelled fakes until B15. | prompts/B08 ("Payment can be a labelled contract fake until B09/B15"); B09 §14 |
| D8-PORT-1 | The cores are reached only through the ports of §10, implemented by the thin adapter of `b05/cores`; tests bind the labelled fakes; no composition root binds a fake, and a deployment without the adapter answers INTEGRITY_FAILURE CORE_SERVICES_UNAVAILABLE. | 04 "Architecture and dependency boundary"; 06 (stubs only in labelled local tests); B07 D-SAPI-6 |
| D8-FAKE-1 | One owner per fake: ContractFakeMigrationCore and ContractFakeIntelligenceCore (B08-CORE-PORTS, `@kauro/application/testing`), ContractFakeWorkerHost (B08-WORKER-HOST, `@kauro/data-plane/testing`); B07's storage fake and B09's fixtures are consumed, never copied; every fake reports SIMULATED with `contract-fake-*` tokens. | B07 §15, D-STAGE1-1; B09 D-FAKE-B1; 21 "Evidence classes" |

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
