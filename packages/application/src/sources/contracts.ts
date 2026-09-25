/**
 * The six B07 command contracts (CMD012..CMD017): input body (exactly the registry fields), result view and the spec the transport
 * and the authorizer consume, plus the auxiliary routes the source lifecycle needs beside the catalogue (the selection manifest
 * intake and the safe reads of manual 10 "Upload and target routes"). Behaviour — reads, locks, preconditions in order, writes,
 * events, OK/DENY/RACE — is specified in docs/design/B07-upload-source-lifecycle.md §8; handlers implementing these contracts
 * belong to mandate B07-COMMANDS.
 */
import type { UtcInstant } from "@kauro/contracts";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { JournaledSessionPlaceholder, ProtectedSessionView, RevisionImpactView, RevisionQuotaView, SourceRevisionView, UploadView } from "./views.js";

function spec<Body>(s: CommandSpec<Body>): CommandSpec<Body> {
  return Object.freeze(s);
}

// --- CMD012 CreateRevision ------------------------------------------------------------------------------------------------

export interface CreateRevisionBody {
  /** The project's version: the command moves projects.current_revision_id (design §8.1). */
  readonly expectedVersion: number;
  /** Must name the project's current revision (explicit lineage; never an in-place overwrite). */
  readonly supersedesRevisionId: string;
}
export interface CreateRevisionView {
  /** The new mutable revision (DRAFT, version 1). */
  readonly revision: SourceRevisionView;
  /** The predecessor after the command: SUPERSEDED (it was SEALED), CANCELLED (it was mutable) or unchanged (already terminal). */
  readonly predecessor: { readonly revisionId: string; readonly version: number; readonly state: string };
  readonly project: { readonly projectId: string; readonly version: number; readonly currentRevisionId: string };
  /** Authority that no longer applies to the new bytes (identified, never transferred; CMD012 failure clause). */
  readonly invalidated: RevisionImpactView;
  /** Live uploads of a cancelled mutable predecessor, cancelled in the same transaction. */
  readonly cancelledUploadIds: ReadonlyArray<string>;
}
export const CREATE_REVISION: CommandSpec<CreateRevisionBody> = spec<CreateRevisionBody>({
  id: "CMD012",
  name: "CreateRevision",
  method: "POST",
  path: "/api/v1/projects/{projectId}/revisions",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "projectId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "supersedesRevisionId"],
});
export type CreateRevisionHandler = CommandHandler<CreateRevisionBody, CreateRevisionView>;

// --- CMD013 ReserveUpload -------------------------------------------------------------------------------------------------

export interface ReserveUploadBody {
  /** The revision's version (the first reservation moves DRAFT -> UPLOADING; later ones leave the revision untouched). */
  readonly expectedVersion: number;
  readonly declaredBytes: number;
  readonly declaredFormat: "CSV" | "XLSX";
  readonly displayName: string;
}
export interface ReserveUploadView {
  readonly upload: UploadView;
  readonly revision: { readonly revisionId: string; readonly version: number; readonly state: string };
  readonly quota: RevisionQuotaView;
  /**
   * Journaled as the placeholder; the transport hydrates it for the requester only (D-SESSION-2). A replay by the requester while
   * the upload is UPLOADING and unexpired re-delivers the session; otherwise the member reads UNAVAILABLE.
   */
  readonly session: JournaledSessionPlaceholder | ProtectedSessionView;
}
export const RESERVE_UPLOAD: CommandSpec<ReserveUploadBody> = spec<ReserveUploadBody>({
  id: "CMD013",
  name: "ReserveUpload",
  method: "POST",
  path: "/api/v1/revisions/{revisionId}/uploads",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "revisionId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "declaredBytes", "declaredFormat", "displayName"],
});
export type ReserveUploadHandler = CommandHandler<ReserveUploadBody, ReserveUploadView>;

// --- CMD014 CompleteUpload ------------------------------------------------------------------------------------------------

export interface CompleteUploadBody {
  /** The provider's completion token as the browser received it: a claim, parsed and compared, never authority (S053). */
  readonly providerCompletionRef: string;
}
/**
 * CompleteUpload answers 202 ACCEPTED (completion remains asynchronous): the operation is the upload's verification, its id is
 * the upload id and its status is GET /api/v1/uploads/{uploadId}. The journal stores this body with status 202 (D-RUN-1).
 */
export interface CompleteUploadAccepted {
  readonly operationId: string;
  readonly state: "VERIFYING";
  readonly statusPath: string;
  readonly pollAfterSeconds: number;
  readonly upload: UploadView;
}
export const COMPLETE_UPLOAD: CommandSpec<CompleteUploadBody> = spec<CompleteUploadBody>({
  id: "CMD014",
  name: "CompleteUpload",
  method: "POST",
  path: "/api/v1/uploads/{uploadId}/complete",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "uploadId",
  expectedVersionRequired: false,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["providerCompletionRef"],
});
export type CompleteUploadHandler = CommandHandler<CompleteUploadBody, CompleteUploadAccepted>;

// --- CMD015 CancelUpload --------------------------------------------------------------------------------------------------

export interface CancelUploadBody {
  /** The upload's version (UploadSession.version: "Concurrent completion/cancellation fence"). */
  readonly expectedVersion: number;
}
export interface CancelUploadView {
  readonly upload: UploadView;
  readonly revision: { readonly revisionId: string; readonly version: number; readonly state: string };
  /** Bytes returned to the revision envelope by this cancellation (exactly once). */
  readonly releasedBytes: number;
}
export const CANCEL_UPLOAD: CommandSpec<CancelUploadBody> = spec<CancelUploadBody>({
  id: "CMD015",
  name: "CancelUpload",
  method: "POST",
  path: "/api/v1/uploads/{uploadId}/cancel",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "uploadId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion"],
});
export type CancelUploadHandler = CommandHandler<CancelUploadBody, CancelUploadView>;

// --- CMD016 SelectInputTables ---------------------------------------------------------------------------------------------

export interface SelectInputTablesBody {
  readonly expectedVersion: number;
  /** An immutable selection manifest of this revision (stored through the selection manifest intake, D-SEL-2). */
  readonly selectionManifestRef: string;
}
export interface SelectInputTablesView {
  readonly revision: SourceRevisionView;
  readonly selection: {
    readonly selectionManifestId: string;
    readonly selectionHash: string;
    readonly includedFileCount: number;
    readonly includedTableCount: number;
    readonly reusedFileIds: ReadonlyArray<string>;
  };
}
export const SELECT_INPUT_TABLES: CommandSpec<SelectInputTablesBody> = spec<SelectInputTablesBody>({
  id: "CMD016",
  name: "SelectInputTables",
  method: "POST",
  path: "/api/v1/revisions/{revisionId}/selection",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "revisionId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: [],
  fields: ["expectedVersion", "selectionManifestRef"],
});
export type SelectInputTablesHandler = CommandHandler<SelectInputTablesBody, SelectInputTablesView>;

// --- CMD017 SealRevision --------------------------------------------------------------------------------------------------

export interface SealRevisionBody {
  readonly expectedVersion: number;
  /** The selection the agency confirmed on the seal review (UI16); recomputed and compared by the server. */
  readonly selectionHash: string;
}
export interface SealRevisionView {
  readonly revision: SourceRevisionView;
  readonly manifestHash: string;
  readonly projectionHash: string;
  readonly retention: { readonly retentionId: string; readonly class: "UNPAID"; readonly hardDeadline: UtcInstant; readonly effectiveDeadline: UtcInstant };
}
export const SEAL_REVISION: CommandSpec<SealRevisionBody> = spec<SealRevisionBody>({
  id: "CMD017",
  name: "SealRevision",
  method: "POST",
  path: "/api/v1/revisions/{revisionId}/seal",
  role: "AGENCY_OPERATOR",
  scope: "AGENCY_HEADER",
  aggregateParam: "revisionId",
  expectedVersionRequired: true,
  stepUpRequired: false,
  authorityHashFields: ["selectionHash"],
  fields: ["expectedVersion", "selectionHash"],
});
export type SealRevisionHandler = CommandHandler<SealRevisionBody, SealRevisionView>;

export const B07_COMMANDS = Object.freeze({
  CMD012: CREATE_REVISION,
  CMD013: RESERVE_UPLOAD,
  CMD014: COMPLETE_UPLOAD,
  CMD015: CANCEL_UPLOAD,
  CMD016: SELECT_INPUT_TABLES,
  CMD017: SEAL_REVISION,
} as const);
export type B07CommandId = keyof typeof B07_COMMANDS;

export interface B07Handlers {
  readonly CMD012: CreateRevisionHandler;
  readonly CMD013: ReserveUploadHandler;
  readonly CMD014: CompleteUploadHandler;
  readonly CMD015: CancelUploadHandler;
  readonly CMD016: SelectInputTablesHandler;
  readonly CMD017: SealRevisionHandler;
}

// --- auxiliary routes (not catalogue commands; design §8.7, decisions D-SEL-2 and D-API-1) ----------------------------------

/**
 * Routes the source lifecycle exposes beside the six commands. The reads are the safe projections manual 10 names ("GET returns
 * safe progress", "GET /revisions/{revisionId}/inspection"); the intake stores an immutable selection document and changes no
 * aggregate. Reads require a live ACTIVE membership in the selected agency (any role, D-API-1); the session read and the intake
 * follow the command's own role.
 */
export const SOURCE_ROUTES = Object.freeze({
  selectionManifestIntake: { method: "POST", path: "/api/v1/revisions/{revisionId}/selection-manifests", role: "AGENCY_OPERATOR" },
  getSelectionManifest: { method: "GET", path: "/api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId}", role: "AGENCY_READER" },
  getRevision: { method: "GET", path: "/api/v1/revisions/{revisionId}", role: "AGENCY_READER" },
  getInspection: { method: "GET", path: "/api/v1/revisions/{revisionId}/inspection", role: "AGENCY_READER" },
  listUploads: { method: "GET", path: "/api/v1/revisions/{revisionId}/uploads", role: "AGENCY_READER" },
  getUpload: { method: "GET", path: "/api/v1/uploads/{uploadId}", role: "AGENCY_READER" },
  getUploadSession: { method: "GET", path: "/api/v1/uploads/{uploadId}/session", role: "AGENCY_OPERATOR" },
} as const);

export interface SelectionManifestIntakeView {
  readonly selectionManifestId: string;
  readonly revisionId: string;
  readonly bodyHash: string;
  /** false when the same body was already stored for this revision (the intake is idempotent by content). */
  readonly created: boolean;
}
