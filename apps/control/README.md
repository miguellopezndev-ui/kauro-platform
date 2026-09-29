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

Every unit of work is a SYSTEM context bound to the agency of its work item (D-CTRL-1), takes the revision row before any upload or
file of it (D-LOCK-2), records only the database's instants (D-CLOCK-1) and appends only the events of the edges the control plane
owns (D-CTRL-2). External providers are reached only through the ports of `@kauro/application`; no production source here imports a
test-only subpath, so no deployment binds a contract fake — the real provider adapters are B15's.

Tests (`test/`) run against a real PostgreSQL 17 started per file (`@kauro/persistence/testing`), with the labelled contract fakes of
`@kauro/application/testing` and `@kauro/data-plane/testing` (evidence class SIMULATED) and the real isolated parsers; interleavings
are fixed by the fakes' hold points and by lock waits observed in `pg_stat_activity`. `test/end-to-end.test.ts` composes the control
plane with the application's own handlers of CMD012..CMD017, the source reads and the manifest intake (as `apps/api` binds them, with
the real Authorizer of `@kauro/authorization`, each answer checked against its route's contract; design D-INT-1). `docs/design/B07-case-map.md`
names the tests of each case.
