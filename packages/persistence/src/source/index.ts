/**
 * The `pg` adapters of the B07 source-lifecycle ports (@kauro/domain ports/source-store; migrations 0009..0012 and 0020; design
 * docs/design/B07-upload-source-lifecycle.md, mandate B07-PERSISTENCE). A unit of work reaches them through
 * `PgUnitOfWorkFactory.runSource` (uow.sources); they are exported for the entrypoints' composition and for tests.
 */
export { PgSourceStore } from "./store.js";
export { PgUploadSessionRepository, PgSessionSecretRepository } from "./uploads.js";
export { PgStoredObjectRepository, PROVIDER_SOFT_DELETED_REASON } from "./objects.js";
export { PgObjectHoldRepository } from "./holds.js";
export { PgInspectionReceiptRepository, PgSourceFileRepository } from "./inspection.js";
export { PgSelectionManifestRepository, PgSelectionEvaluationRepository } from "./selection.js";
export { PgSourceRevisionRepository, PgProjectRevisionPointer, PgRevisionAuthorityInspector, PgPendingOperationJournal } from "./revisions.js";
export { PgSealedManifestRepository } from "./seals.js";
export { PgRetentionRepository } from "./retention.js";
export { PgDeletionRepository } from "./deletion.js";
export { PgSourceAvailabilityReader, PgRevisionLineageReader } from "./readers.js";
export { serverInstantOf } from "./rows.js";
export type { SourceAudience } from "./rows.js";
