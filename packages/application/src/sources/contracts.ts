/**
 * The six B07 command contracts (CMD012..CMD017): input body (exactly the registry fields), result view and the spec the transport
 * and the authorizer consume, plus the auxiliary routes the source lifecycle needs beside the catalogue (the selection manifest
 * intake and the safe reads of manual 10 "Upload and target routes"). Behaviour — reads, locks, preconditions in order, writes,
 * events, OK/DENY/RACE — is specified in docs/design/B07-upload-source-lifecycle.md §8; handlers implementing these contracts
 * belong to mandate B07-COMMANDS.
 */
import type { CommandResult } from "../api/envelope.js";
import type { CommandHandler, CommandSpec } from "../ports/command-handler.js";
import type { SourceRouteId } from "./outcomes.js";
import type {
  JournaledSessionPlaceholder,
  ProjectRevisionPointerView,
  ProtectedSessionView,
  RetentionView,
  RevisionImpactView,
  RevisionQuotaView,
  RevisionSummaryView,
  SourceRevisionView,
  UploadView,
} from "./views.js";

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
  readonly predecessor: RevisionSummaryView;
  readonly project: ProjectRevisionPointerView;
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
  readonly revision: RevisionSummaryView;
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
 * CompleteUpload answers 202 with B06's ACCEPTED envelope (completion remains asynchronous; D-RUN-1): the operation is the
 * upload's verification — operationId = the upload id, state = VERIFYING, statusPath = /api/v1/uploads/{uploadId}, pollAfterSeconds
 * = COMPLETION_POLL_AFTER_SECONDS (D-SAPI-3). The journal stores exactly this answer with status 202 and a replay answers it again;
 * progress is read at the status path (UploadView). No view rides on the 202: the envelope is closed (B06 D-RESP-1).
 */
export type CompleteUploadAccepted = Omit<Extract<CommandResult<never>, { readonly kind: "ACCEPTED" }>, "kind" | "status"> & { readonly state: "VERIFYING" };
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
/** A handler whose only success is the ACCEPTED answer (its CommandResult never carries a COMPLETED view). */
export type CompleteUploadHandler = CommandHandler<CompleteUploadBody, never>;

// --- CMD015 CancelUpload --------------------------------------------------------------------------------------------------

export interface CancelUploadBody {
  /** The upload's version (UploadSession.version: "Concurrent completion/cancellation fence"). */
  readonly expectedVersion: number;
}
export interface CancelUploadView {
  readonly upload: UploadView;
  readonly revision: RevisionSummaryView;
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
  /** KAURO_SOURCE_SEALED_SUBJECT_V1 digest binding this revision and its frozen counts to the manifest (D-HASH-4, B07-F12). */
  readonly sealedSubjectHash: string;
  /** The UNPAID record anchored on the first seal of the bytes: hard deadline fourteen days from it (D-RET-2, D-RET-3). */
  readonly retention: RetentionView;
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

// --- auxiliary routes (not catalogue commands; design §8.7, decisions D-SEL-2 and D-SAPI-1) ----------------------------------

/** An auxiliary route of the source lifecycle: not a catalogue command (no command journal entry), scope AGENCY_HEADER. */
export interface SourceRouteSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Registry role vocabulary (B06 D-AUTHZ-1): AGENCY_READER is any live ACTIVE membership. */
  readonly role: "AGENCY_READER" | "AGENCY_OPERATOR";
  /** The success status and the view it carries (response schemas: sources/response-views.ts). */
  readonly status: 200 | 201;
  readonly view: string;
  readonly authority: string;
}

/**
 * Routes the source lifecycle exposes beside the six commands. The reads are the safe projections manual 10 names ("GET returns
 * safe progress", "GET /revisions/{revisionId}/inspection", the bounded preview); the intake stores an immutable selection document
 * and changes no aggregate. Reads require a live ACTIVE membership in the selected agency (any role, D-SAPI-1); the session read
 * and the intake follow the command's own role.
 */
export const SOURCE_ROUTES: Readonly<Record<SourceRouteId, SourceRouteSpec>> = Object.freeze({
  SubmitSelectionManifest: { method: "POST", path: "/api/v1/revisions/{revisionId}/selection-manifests", role: "AGENCY_OPERATOR", status: 201, view: "SelectionManifestIntakeView", authority: "10 \"Upload and target routes\" (selection edits require the revision version: the version is compared by CMD016); D-SEL-2" },
  GetSelectionManifest: { method: "GET", path: "/api/v1/revisions/{revisionId}/selection-manifests/{selectionManifestId}", role: "AGENCY_READER", status: 200, view: "SelectionManifestView", authority: "D-SEL-1" },
  GetRevision: { method: "GET", path: "/api/v1/revisions/{revisionId}", role: "AGENCY_READER", status: 200, view: "SourceRevisionView", authority: "10 \"Client and project routes\"; 09 \"Notifications and customer action\" (dataAvailableUntil)" },
  GetInspection: { method: "GET", path: "/api/v1/revisions/{revisionId}/inspection", role: "AGENCY_READER", status: 200, view: "InspectionView", authority: "10 \"Upload and target routes\" (files, detected worksheets, parser choices and structured problems)" },
  ListUploads: { method: "GET", path: "/api/v1/revisions/{revisionId}/uploads", role: "AGENCY_READER", status: 200, view: "UploadPage", authority: "10 \"Upload and target routes\" (safe progress); 10 \"Pagination, search and exports\"" },
  GetUpload: { method: "GET", path: "/api/v1/uploads/{uploadId}", role: "AGENCY_READER", status: 200, view: "UploadView", authority: "10 \"Upload and target routes\" (GET returns safe progress without exposing the session URI to unrelated readers)" },
  GetUploadSession: { method: "GET", path: "/api/v1/uploads/{uploadId}/session", role: "AGENCY_OPERATOR", status: 200, view: "ProtectedSessionView", authority: "10 \"Upload and target routes\" (the provider session through the protected response only); 09 \"Resumable session security\"; D-SESSION-2" },
  PreviewTable: { method: "GET", path: "/api/v1/revisions/{revisionId}/tables/{tableId}/preview", role: "AGENCY_READER", status: 200, view: "TablePreviewView", authority: "10 \"Upload and target routes\" (a bounded authorized sample with safe display escaping and no shared caching); D-SAPI-7" },
});

export interface SelectionManifestIntakeView {
  readonly selectionManifestId: string;
  readonly revisionId: string;
  readonly bodyHash: string;
  /** false when the same body was already stored for this revision (the intake is idempotent by content). */
  readonly created: boolean;
}
