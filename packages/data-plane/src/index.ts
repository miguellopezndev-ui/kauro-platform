/**
 * @kauro/data-plane (layer adapter): the platform's own bounded parsers of untrusted source files (B07; docs/design/
 * B07-upload-source-lifecycle.md, mandate B07-DATA-PLANE). They are not providers: they are always real, in tests too.
 *
 * - IsolatedContainerInspector — ContainerInspectorPort: streaming SHA-256, format detection, a hardened ZIP/XML reader for XLSX
 *   and CSV dialect facts, the worksheet inventory, the expected scan parts and the parser profile (S024; 04 inspectContainer).
 * - IsolatedSelectionEvaluator — SelectionEvaluatorPort: exact physical rows, logical records, billable units and association
 *   edges of a selection, in bounded memory (03 "Count the correct population").
 * - IsolatedTablePreviewReader — the bounded preview of an admitted table (D-SAPI-7).
 *
 * Each runs its parse in an isolated child under the Node permission model with network hooks (decision D-ISO-1, runIsolated),
 * reporting InspectionIsolation evidence. The labelled scanner fake is the test-only subpath @kauro/data-plane/testing.
 *
 * The attempt envelope of a processing attempt (B08; docs/design/B08-audit-approval-jobs.md D8-STG-1..5, mandate B08-WORKER-HOST),
 * real in tests too: AttemptScratchStore (ScratchStore), FencedArtifactWriter (ArtifactWriter) and GenerationSourceReader
 * (SourceReader). The labelled worker-host fake is the test-only subpath @kauro/data-plane/testing/worker-host.
 */
export { ARCHIVE_BOUNDS, DATA_PLANE_VERSION, EVALUATOR_VERSION, INSPECTOR_VERSION, PREVIEW_BOUNDS, PREVIEW_READER_VERSION, SHEET_GRID, evaluationLimits, inspectionLimits } from "./limits.js";
export { IsolatedContainerInspector, InspectorFailure, type ContainerInspectorOptions } from "./inspector/container-inspector.js";
export { IsolatedSelectionEvaluator, billableUnder, checkManifest, type EvaluationEvidence, type SelectionEvaluatorOptions } from "./evaluator/selection-evaluator.js";
export { IsolatedTablePreviewReader, PreviewFailure, type TablePreview, type TablePreviewRequest } from "./preview/preview-reader.js";
export { rejectionClassOfInspection, rejectionClassOfScan } from "./scan/classify.js";
export { parserProfileHashOfInspection, storedTableFacts, type StoredTableFacts } from "./inventory.js";
export { partDigestOf } from "./archive/zip.js";
export { SANDBOX_CODE_ROOT, runIsolated, sandboxFlags, type SandboxRequest, type SandboxResult } from "./sandbox/runner.js";
export { AttemptEnvelopeFailure, terminalCauseOf, type AttemptFailureCause } from "./attempt/failure.js";
export {
  ARTIFACT_SPOOL_FAMILY,
  ATTEMPT_SCRATCH_DIRECTORY_PREFIX,
  AttemptScratchStore,
  SCRATCH_STORE_CONTRACT_VERSION,
  attemptScratchDirectoryOf,
  removeAttemptScratch,
  type AttemptScratchOptions,
  type ScratchDevice,
  type ScratchSpool,
} from "./attempt/scratch-store.js";
export { FencedArtifactWriter, type FencedArtifactWriterOptions, type StagedManifestRequest } from "./attempt/artifact-writer.js";
export { GenerationSourceReader, type GenerationSourceReaderOptions } from "./attempt/source-reader.js";
export { AttemptByteLedger, ScratchBudgetExceeded } from "./cores/attempt-byte-ledger.js";
export {
  CORE_RUN_DIRECTORY,
  MIGRATION_CORE_VERSION,
  MigrationCoreAdapter,
  coreConfigHashOf,
  coreInputPathOf,
  coreTargetModeOf,
  platformTargetModeOf,
  removeOrphanStepScratch,
  rowCountsOf,
  EffectsResidentLimitExceeded,
  FullValidationRefused,
  type CoreAdapterHooks,
  type FullValidationOutcome,
  type FullValidationRequest,
  type MigrationCoreAdapterOptions,
} from "./cores/migration-core-adapter.js";
export { CoreFullDatasetValidation, type CoreFullDatasetValidationOptions } from "./cores/full-dataset-validation.js";
export { coreTimersOf, type CoreTimers } from "./cores/operation.js";

/**
 * The report PDF engine (B13; docs/design/B13-report-pdf.md): the adapter of @kauro/reports' PdfEngine port. Chromium with its own
 * sandbox on, JavaScript off, network off; the caller supplies the executable.
 */
export { ChromiumPdfEngine, findChromiumExecutable, PDF_HTML_MAX_BYTES, type ChromiumPdfEngineOptions, type ChromiumProbe } from "./pdf/chromium-pdf-engine.js";

/**
 * The report stage (B13 x B08; docs/design/B13-report-delivery.md): the platform's report inputs, the PDF staged through the attempt's
 * own writer with its record, and the execution envelope that joins the report to the package the core staged.
 */
export { REPORT_STAGE_ERROR_CODES, ReportStageError, type ReportStageErrorCode } from "./report/errors.js";
export {
  AUDIT_STATES_WITH_PLANS,
  B08_PACKAGE_REPORT_PRIVACY_CLASS,
  PRINTABLE_LEGAL_FACT_STATUSES,
  QUOTE_IN_FORCE,
  REPORT_INPUTS_EVIDENCE_CLASSES,
  TERMS_SNAPSHOT_DOMAIN,
  assembleReportFacts,
  readTermsSnapshot,
  reportIdOf,
  reportPackageIdOf,
  termsSnapshotBytesOf,
  type AuthorizedReportInputs,
  type QuoteTerms,
  type ReportBrandingInputs,
  type ReportDecisionsInputs,
  type ReportFindingsInputs,
  type ReportInputsEvidenceClass,
  type ReportInputsPort,
  type ReportScope,
  type ReportSubject,
  type SnapshotTerms,
  type TermsSnapshotReading,
} from "./report/facts.js";
export { REPORT_PDF_ROLE, REPORT_RECORD_DOMAIN, REPORT_RECORD_ROLE, readReportPdfRecord, reportPdfRecordBytesOf, reportRecordProblems, type ReportPdfRecord, type ReportPdfRecordReading } from "./report/record.js";
export { StagedReportPdfPublisher, reportPdfObjectNameOf, type ReportBinding, type StagedReportPdf, type StagedReportPdfPublisherOptions } from "./report/publisher.js";
export {
  DEFAULT_MAX_PACKAGE_BYTES,
  ReportingExecutionEnvelope,
  produceStagedReport,
  readStagedPackage,
  type ProduceStagedReportRequest,
  type ProducedReport,
  type ReportRenderConfig,
  type ReportingExecutionEnvelopeOptions,
} from "./report/stage.js";
export { PACKAGE_MANIFEST_ROLE } from "./cores/migration-core-adapter.js";

/**
 * The worker executor of B14-A (docs/design/B14-A-worker-executor.md): the closed attempt ticket, the local worker protocol, the
 * attempt's storage broker (the host side) and its client (the worker side), the composition of one attempt inside a worker process,
 * and LocalProcessWorkerHost — the local WorkerHostPort (EXECUTED_LOCAL, single-tenant qualification), each attempt one worker process.
 */
export {
  ATTEMPT_TICKET_DOMAIN,
  ATTEMPT_TICKET_MAX_BYTES,
  attemptTicketBytesOf,
  attemptTicketDigestOf,
  attemptTicketProblems,
  executionLimitsProblems,
  readAttemptTicket,
  type AttemptTicket,
  type AttemptTicketReading,
} from "./host/ticket.js";
export { BrokerCallFailed, MAX_RESULT_REFUSAL_CHARS, WORKER_CALL_OPS, WORKER_PROTOCOL_VERSION, WORKER_STAGES, normalizeWorkerMessage, workerResultProblem, type BrokeredZone, type InvalidWorkerMessage, type HostMessage, type WorkerCall, type WorkerCallError, type WorkerMessage, type WorkerResultReport, type WorkerStage } from "./host/protocol.js";
export { AttemptStorageBroker, BROKER_READ_CHUNK_BYTES, BrokerRefusal, callErrorOf, type AttemptStorageBrokerOptions, type BrokerRefusalRecord } from "./host/broker.js";
export { BROKERED_STORAGE_PROVIDER, BrokeredObjectStorage, BrokeredUploads, WorkerRpc } from "./host/client.js";
export { BROWSER_TEMP_DIRECTORY, WORKER_SESSION_ORIGIN, diagnosticOf, runAttemptWorker, type AttemptWorkerOptions } from "./host/worker-runtime.js";
export { encodeFrame, FRAME_MAX_BODY_BYTES, FRAME_MAX_HEADER_BYTES, FrameDecoder, FrameViolation } from "./host/framing.js";
export { openWorkerChannel, WORKER_CHANNEL_FD, type WorkerChannel } from "./host/worker-channel.js";
export { AttemptScopeUnavailable, qualifyAttemptScope, type AttemptScope } from "./host/attempt-scope.js";
export { HostRootInUse, acquireHostRootLock, rootLockNameOf, type HostRootLock } from "./host/root-lock.js";
export { CANCELLED_BEFORE_CREATE, HostRecordUnreadable, JobJournal, OS_DIRECTORIES, ensureDurableDirectory, type DirectoryOps, type JournalFaults } from "./host/job-journal.js";
export {
  BROWSER_SOCKET_ROOT_MAX_BYTES,
  CALLS_HELD,
  LOCAL_HOST_ISOLATION,
  LOCAL_PROCESS_HOST,
  LOCAL_PROCESS_MACHINE_TYPE,
  LocalProcessWorkerHost,
  browserTempDirectoryOf,
  type AttemptTicketReads,
  type AttemptTicketSource,
  type LocalJobRecord,
  type LocalProcessHostHooks,
  type LocalProcessWorkerHostOptions,
} from "./host/local-process-host.js";
