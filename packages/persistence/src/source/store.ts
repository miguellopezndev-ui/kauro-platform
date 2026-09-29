/**
 * The source store of a unit of work (B07, `SourceStore` of @kauro/domain): every source-lifecycle repository and read port on the
 * unit of work's one connection, under its bound context. The audience follows the context: a SYSTEM unit of work runs as the
 * control plane and reads no customer text (D-CTRL-1).
 */
import type { SourceStore } from "@kauro/domain";
import type { Queryable } from "../sql.js";
import { PgObjectHoldRepository } from "./holds.js";
import { PgInspectionReceiptRepository, PgSourceFileRepository } from "./inspection.js";
import { PgStoredObjectRepository } from "./objects.js";
import { PgRevisionLineageReader, PgSourceAvailabilityReader } from "./readers.js";
import { PgRetentionRepository } from "./retention.js";
import { PgPendingOperationJournal, PgProjectRevisionPointer, PgRevisionAuthorityInspector, PgSourceRevisionRepository } from "./revisions.js";
import type { SourceAudience } from "./rows.js";
import { PgSealedManifestRepository } from "./seals.js";
import { PgSelectionEvaluationRepository, PgSelectionManifestRepository } from "./selection.js";
import { PgSessionSecretRepository, PgUploadSessionRepository } from "./uploads.js";

export class PgSourceStore implements SourceStore {
  readonly uploads: PgUploadSessionRepository;
  readonly sessionSecrets: PgSessionSecretRepository;
  readonly objects: PgStoredObjectRepository;
  readonly holds: PgObjectHoldRepository;
  readonly inspections: PgInspectionReceiptRepository;
  readonly files: PgSourceFileRepository;
  readonly selections: PgSelectionManifestRepository;
  readonly evaluations: PgSelectionEvaluationRepository;
  readonly revisions: PgSourceRevisionRepository;
  readonly seals: PgSealedManifestRepository;
  readonly projects: PgProjectRevisionPointer;
  readonly authority: PgRevisionAuthorityInspector;
  readonly retention: PgRetentionRepository;
  readonly operations: PgPendingOperationJournal;
  readonly availability: PgSourceAvailabilityReader;
  readonly lineage: PgRevisionLineageReader;

  constructor(db: Queryable, audience: SourceAudience) {
    this.uploads = new PgUploadSessionRepository(db, audience);
    this.sessionSecrets = new PgSessionSecretRepository(db);
    this.objects = new PgStoredObjectRepository(db);
    this.holds = new PgObjectHoldRepository(db);
    this.inspections = new PgInspectionReceiptRepository(db);
    this.files = new PgSourceFileRepository(db, audience);
    this.selections = new PgSelectionManifestRepository(db);
    this.evaluations = new PgSelectionEvaluationRepository(db);
    this.revisions = new PgSourceRevisionRepository(db);
    this.seals = new PgSealedManifestRepository(db);
    this.projects = new PgProjectRevisionPointer(db);
    this.authority = new PgRevisionAuthorityInspector(db);
    this.retention = new PgRetentionRepository(db);
    this.operations = new PgPendingOperationJournal(db);
    this.availability = new PgSourceAvailabilityReader(db);
    this.lineage = new PgRevisionLineageReader(db);
  }
}
