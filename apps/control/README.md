# @kauro/control

The control plane of the Kauro platform's source lifecycle (design `docs/design/B07-upload-source-lifecycle.md` §12, mandate
B07-CONTROL). An entrypoint: it composes the application's ports, the `pg` adapters of `@kauro/persistence` and the platform's own
bounded parsers of `@kauro/data-plane`.

| piece | what it does |
|---|---|
| `PgOutboxDispatcher` | claims due outbox records of one consumer (B06 `OutboxDispatchStore`), holds each record's OUTBOX_DISPATCH lease, runs the consumer in SYSTEM units of work bound to the event's agency, settles DELIVERED / RETRYABLE / DEAD_LETTER under the attempt it claimed (D-CTRL-4) |
| `UploadInspection` | UPLOAD_INSPECTION (§12.1): claims the attempt (the database stamps its start), observes the quarantine object, inspects it in the isolated child, scans it (the scan instant is a reading of the database clock), promotes the exact generation and admits or rejects it on one receipt (D-INSP-1..4, D-CTRL-6) |
| `SelectionEvaluation` | SELECTION_EVALUATION (§12.2): counts a bound selection exactly and moves the revision READY_TO_SEAL or REJECTED |
| `StorageLifecycle` | STORAGE_LIFECYCLE (§12.3): cancels a requested provider session with the vault-opened reference and records the answer, purges the bearer record once resolved, deletes the tombstoned subject's objects by exact generation with their residual (D-CTRL-7) |
| `AuthorityJournal` | AUTHORITY_JOURNAL (§12.4): appends the restore tombstone of every terminal authority fact, only for a subject in the tombstone's terminal state (D-RESTORE-1, D-CTRL-8) |
| sweepers | `UploadDeadlines`, `ProviderSessionReconciliation`, `RetentionSweeper`, `ObjectInventory`, `DeletionRetries`, `LocationPolicy` — exactly `SOURCE_SWEEPERS` (§12.5), each on the server clock, never early |
| `assembleControlPlane`, `openControlDatabase`, `platformParsers` | the composition root: a verified `kauro_control` pool, the real parsers, and the provider ports the caller hands in |
| `JobAdmission` | JOB_ADMISSION (package B08, `docs/design/B08-audit-approval-jobs.md` §4.2): the fair round under the global ledger (D8-SCHED-1), every later lock taken without waiting (D8-LOCK-1), the authority re-read after them (a lost fact cancels the QUEUED job with its reason), then QUEUED -> ADMITTED with the entitlement consumed, the PAID_ORDINARY record and attempt 1 claimed at fence 1 in one unit |
| `JobPipeline` | JOB_EXECUTION's steps and ATTEMPT_MONITOR's observation: the launch by deterministic identity, observe before any other create, heartbeat under the fence, a lapsed lease terminated and taken over at fence + 1, the manifest read by the control plane, read-back and verification against the platform's authority, the delivery copies and the publication with the authority re-read after its locks (§4.3, §5) |
| `CancellationReconciler` | EXECUTION_CONTROL's continuation of a cancellation (CMD037 or a lost authority): the lease's cancellation version, the identity terminated and observed until terminal, the package revoked, CANCELLED releasing the slots once (§6) |
| `JobExecutionConsumer`, `ExecutionControlConsumer` | the consumers JOB_EXECUTION and EXECUTION_CONTROL over the same dispatcher (§11) |
| `AttemptMonitor`, `JobDeadlines`, `StagingJanitor` | with JobAdmission and the two audit sweepers, exactly `EXECUTION_SWEEPERS`: the monitor's pass over the ACTIVE job, deadlines never early, one ended attempt's exact prefix, scratch and cleanup record (D8-JAN-1) |
| `AuditOrchestration` | AUDIT_ORCHESTRATION (package B08, mandate B08-CONTROL-AUDIT, §3): at the audit's own version, the step of its state claims fence + 1, calls its core outside any transaction and records only under that fence — PROFILE over the sealed generations, INTERPRET over the platform's fenced journal with the system draft created with VALIDATING, VALIDATE with the receipt written by the validator's pool, then DRAFT_READY under the database's guard (D8-AUD-2..4, D8-CAU-4..9) |
| `PlanValidation`, `PlanValidator` | PLAN_VALIDATION (§8.1, D8-PLAN-2): only the plan's current intent validates; a null, incomplete or foreign receipt settles it ERROR and is never recorded, a late receipt stays evidence and moves nothing (D8-CAU-3, D8-CAU-7) |
| `AuditDeadlines`, `GrantReconciliation` | AUDIT_DEADLINES (the absolute deadline on the server clock, never early) and GRANT_RECONCILIATION (known usage joins the spend, only an intent the database can no longer send is released, the grant's edges on the server clock; D8-CAU-10) |
| `AuditCancellations`, `openValidatorReceipts` | EXECUTION_CONTROL's cancellation of the audits of a lost source (D8-CANCEL-2); the validator's write path over a second verified `kauro_validator` pool (D8-ROLE-1, D8-CAU-2) |

The execution and audit pipelines (package B08) are assembled only when the caller hands in the audit units of work, the worker host
(B14's), the cores' ports (the cores adapter of `b05/cores`) and the validator's write path; a deployment of this edition binds none, so
its control plane has none (D8-PORT-1), and the tests bind the labelled contract fakes of their owners.

Every unit of work is a SYSTEM context bound to the agency of its work item (D-CTRL-1), takes the revision row before any upload or
file of it (D-LOCK-2), records only the database's instants (D-CLOCK-1) and appends only the events of the edges the control plane
owns (D-CTRL-2). External providers are reached only through the ports of `@kauro/application`; no production source here imports a
test-only subpath, so no deployment binds a contract fake — the real provider adapters are B15's.

Tests (`test/`) run against a real PostgreSQL 17 started per file (`@kauro/persistence/testing`), with the labelled contract fakes of
`@kauro/application/testing` and `@kauro/data-plane/testing` (evidence class SIMULATED) and the real isolated parsers; interleavings
are fixed by the fakes' hold points and by lock waits observed in `pg_stat_activity`. `test/end-to-end.test.ts` composes the control
plane with the application's own handlers of CMD012..CMD017, the source reads and the manifest intake (as `apps/api` binds them, with
the real Authorizer of `@kauro/authorization`, each answer checked against its route's contract; design D-INT-1). `docs/design/B07-case-map.md`
names the tests of each case. The execution tests (`job-admission`, `job-execution`, `execution-control`, `staging-janitor`,
`cancellation-boundaries`) and the audit tests (`audit-orchestration`, `plan-validation`, `grant-reconciliation`, with
`test/support/audit-world.ts`) share `test/support/execution-world.ts`: B09's paid purchases, the labelled worker-host, Migration-core,
Intelligence-core and object-storage fakes, the validator's own pool, and the labelled TEST CLOCK of the control plane's units;
`docs/design/B08-case-map.md` names their cases.
