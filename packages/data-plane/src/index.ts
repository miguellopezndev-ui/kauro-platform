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
