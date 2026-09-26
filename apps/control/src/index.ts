/**
 * @kauro/control — the Kauro control plane (docs/design/B07-upload-source-lifecycle.md §12, mandate B07-CONTROL): the outbox
 * dispatcher over B06's dispatch store and leases, the source-lifecycle consumers UPLOAD_INSPECTION, SELECTION_EVALUATION,
 * STORAGE_LIFECYCLE and AUTHORITY_JOURNAL, and the sweepers of SOURCE_SWEEPERS (UPLOAD_DEADLINES, PROVIDER_SESSION_RECONCILIATION,
 * RETENTION, OBJECT_INVENTORY, DELETION_RETRIES, LOCATION_POLICY). Every unit of work runs as a SYSTEM context bound to the agency of
 * its work item (D-CTRL-1), takes the revision row before any upload or file of it (D-LOCK-2), records only the server's instants
 * (D-CLOCK-1) and appends only the events of the edges the control plane owns (D-CTRL-2). External providers are reached only
 * through the ports of @kauro/application; the platform's own parsers (@kauro/data-plane) are always real.
 */
export { PgOutboxDispatcher, serviceOf } from "./dispatcher.js";
export type { DispatcherOptions, DispatchCounts } from "./dispatcher.js";
export { UploadInspection, claimConsistentWith, QUARANTINE_AFTER_INSPECTION } from "./consumers/upload-inspection.js";
export type { UploadInspectionDependencies } from "./consumers/upload-inspection.js";
export { SelectionEvaluation, SELECTED_INPUT_REJECTED } from "./consumers/selection-evaluation.js";
export type { SelectionEvaluationDependencies } from "./consumers/selection-evaluation.js";
export { StorageLifecycle, ACCEPTANCE_TOMBSTONED } from "./consumers/storage-lifecycle.js";
export type { StorageLifecycleDependencies } from "./consumers/storage-lifecycle.js";
export { AuthorityJournal } from "./consumers/authority-journal.js";
export type { AuthorityJournalDependencies } from "./consumers/authority-journal.js";
export { UploadDeadlines, RESERVATION_EXPIRED, INTAKE_EXPIRED } from "./sweepers/upload-deadlines.js";
export { ProviderSessionReconciliation } from "./sweepers/provider-session-reconciliation.js";
export type { ProviderSessionReconciliationDependencies } from "./sweepers/provider-session-reconciliation.js";
export { RetentionSweeper, RETENTION_DEADLINE, RETENTION_ENDED } from "./sweepers/retention.js";
export type { RetentionDependencies, RetentionSweepResult } from "./sweepers/retention.js";
export { ObjectInventory, UNREGISTERED_GENERATION, scopeOfName } from "./sweepers/object-inventory.js";
export type { ObjectInventoryDependencies, ObjectInventoryResult, NamedScope } from "./sweepers/object-inventory.js";
export { DeletionRetries } from "./sweepers/deletion-retries.js";
export type { DeletionRetriesDependencies } from "./sweepers/deletion-retries.js";
export { LocationPolicy } from "./sweepers/location-policy.js";
export type { LocationPolicyDependencies } from "./sweepers/location-policy.js";
export { SweepRun } from "./sweepers/sweep.js";
export type { SweepResult, SweeperDependencies } from "./sweepers/sweep.js";
export { executeDeletion, requestAndDelete, cancelProviderSession, locationOf } from "./storage-work.js";
export type { DeletionOutcome, CancellationOutcome } from "./storage-work.js";
export { boundTo, discovery, publish, applied, lostTheSubject, SettledElsewhere, isAfter, microsOf, tokenOf } from "./work.js";
export type { WorkItem } from "./work.js";
export { assembleControlPlane, platformParsers, openControlDatabase, CONTROL_APPLICATION_NAME, controlClock } from "./composition.js";
export type { ControlPlane, ControlPlaneOptions, ControlProviders, ControlParsers, ControlConsumers, ControlSweepers, ControlCycleReport, ControlDatabase, ControlDatabaseConfig } from "./composition.js";
