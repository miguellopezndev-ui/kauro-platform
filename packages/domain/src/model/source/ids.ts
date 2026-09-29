/**
 * Identities of the source lifecycle (B07; 07 "Database representation": server-generated UUIDv7, scoped even when globally
 * unique; 03 "Source identity": a locator identifies an occurrence — revision, file, table, logical row, projection — never a
 * display name). Branded so an upload id is unusable where a file id is required; every one is minted through IdGenerator and
 * checked as UUIDv7 by the database.
 */
import type { Id } from "@kauro/contracts";
import type { Branded } from "../ids.js";

/** UploadSession.uploadId: one reservation and its provider session. */
export type UploadId = Branded<Id, "UploadId">;
/** A registered storage object (09 "Storage zones and object registry"): one row per object generation or intent. */
export type StoredObjectId = Branded<Id, "StoredObjectId">;
/** FileManifest.fileId / SourceLocator.fileId: one admitted, immutable, provider-observed generation. */
export type SourceFileId = Branded<Id, "SourceFileId">;
/** SourceLocator.tableId: a CSV table or a worksheet of an admitted file. */
export type SourceTableId = Branded<Id, "SourceTableId">;
/** SourceLocator.projectionId: one declared object projection of a table. */
export type ProjectionId = Branded<Id, "ProjectionId">;
/** CMD016 selectionManifestRef: an immutable selection document of one revision. */
export type SelectionManifestId = Branded<Id, "SelectionManifestId">;
/** One counting pass over one selection. */
export type EvaluationId = Branded<Id, "EvaluationId">;
/** One completed inspection attempt of one upload. */
export type InspectionReceiptId = Branded<Id, "InspectionReceiptId">;
/** RetentionRecord.retentionId. */
export type RetentionId = Branded<Id, "RetentionId">;
/** One immutable retention anchor fact. */
export type RetentionAnchorId = Branded<Id, "RetentionAnchorId">;
/** One provider hold record: one included file's accepted generation, held by one seal attempt (B07-R1, D-HOLD-1). */
export type ObjectHoldId = Branded<Id, "ObjectHoldId">;
/** One seal attempt: the holds one execution of SealRevision placed, under one id (D-HOLD-2). */
export type SealAttemptId = Branded<Id, "SealAttemptId">;
