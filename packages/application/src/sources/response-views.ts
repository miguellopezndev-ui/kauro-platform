/**
 * Closed response views of the source lifecycle (B07; docs/design/B07-upload-source-lifecycle.md §10), declared exactly as B06
 * declares its own (api/response-schemas, decision D-RESP-1 of B06): a view that projects a registry contract (UploadSession,
 * DatasetRevision, FileManifest, RetentionRecord) takes every selected member from the generated registry bundle, may only narrow
 * it by adding a keyword, keeps what the registry requires required, and lists every registry member it does not select as
 * withheld with the reason. Every object is closed.
 *
 * Safety rules on top of B06's forbidden members (FORBIDDEN_RESPONSE_FIELDS): no view carries an object name, a provider location,
 * a provider generation, a vault key or the provider session reference — except ProtectedSessionView, the one view that carries the
 * resumable session URL, and only to its requester through the protected response (10 "Upload and target routes"; 09 "Resumable
 * session security"; D-SESSION-2). Untrusted customer text (the display filename, worksheet names, header labels, preview cells)
 * appears only in tenant reads, never in events or logs, as bounded text the UI escapes.
 *
 * `buildSourceViewSchemas` builds these with B06's viewSchema over the registry bundle; the application test proves they build,
 * stay closed, declare no forbidden member and keep the session URL inside ProtectedSessionView. When mandate B07-COMMANDS serves
 * the routes, the views join VIEW_DEFINITIONS and the command replies join COMMAND_RESPONSES.
 */
import { SELECTION_MANIFEST_SCHEMA } from "./request-schemas.js";
import { SOURCE_BLOCKERS } from "./views.js";
import type { SourceRouteSpec } from "./contracts.js";
import type { SourceRouteId } from "./outcomes.js";
import {
  FORBIDDEN_RESPONSE_FIELDS,
  RESPONSE_FIELD_VOCABULARY,
  RESPONSE_SCHEMA_PREFIX,
  VIEW_MEMBER_KIT,
  declaredMembers,
  openObjects,
  viewSchema,
  type JsonSchema,
  type RegistryBundle,
  type ViewDefinition,
} from "../api/response-schemas.js";
import { DomainFailure } from "@kauro/domain";

const { ID, VERSION, HASH, UTC, LABEL, COUNT } = RESPONSE_FIELD_VOCABULARY;
const { registry, platform, ref, NARROW_ID, CURSOR } = VIEW_MEMBER_KIT;

const TOKEN = Object.freeze({ type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$" });
const DECLARED_FORMAT = Object.freeze({ type: "string", enum: ["CSV", "XLSX"] });
const ids = (max: number): JsonSchema => ({ type: "array", maxItems: max, items: ID });
const closed = (required: ReadonlyArray<string>, properties: Readonly<Record<string, JsonSchema>>): JsonSchema => ({ type: "object", additionalProperties: false, required: [...required], properties });

/** The B07 operations a caller may issue on a source resource (informative, never authority; B06 D-PERM-1). */
export const SOURCE_RESOURCE_ACTIONS = ["CreateRevision", "ReserveUpload", "CompleteUpload", "CancelUpload", "SelectInputTables", "SealRevision"] as const;
export type SourceResourceAction = (typeof SOURCE_RESOURCE_ACTIONS)[number];
const SOURCE_ACTIONS_SCHEMA = Object.freeze({ type: "array", maxItems: SOURCE_RESOURCE_ACTIONS.length, items: { type: "string", enum: [...SOURCE_RESOURCE_ACTIONS] } });
const SOURCE_ACTIONS_DESCRIPTION =
  "The source-lifecycle commands the caller may issue on this resource, derived server-side from the caller's role, the resource's state and, for an upload, whether the caller requested it; informative, never authority (B06 D-PERM-1).";

/** The member that carries the resumable session URL, allowed in ProtectedSessionView only (D-SESSION-2). */
export const SESSION_URL_MEMBER = "uploadUrl";
export const SESSION_URL_VIEW = "ProtectedSessionView";

const POPULATIONS = closed(["physicalSourceRows", "logicalSourceRecords", "billableSourceUnits", "associationEdges"], {
  physicalSourceRows: COUNT,
  logicalSourceRecords: COUNT,
  billableSourceUnits: COUNT,
  associationEdges: COUNT,
});
const POPULATIONS_DESCRIPTION = "The four populations frozen by the evaluation of the bound selection (RowCounts members; 03 \"Count the correct population\"): physical rows, logical records after projection, billable units before deduplication, association edges.";

/** The selection manifest document as a response member: the closed request document without its root annotations. */
const SELECTION_DOCUMENT: JsonSchema = Object.freeze(Object.fromEntries(Object.entries(SELECTION_MANIFEST_SCHEMA).filter(([k]) => k !== "$schema" && k !== "$id")));

/** The success reply of each B07 command: CMD014 answers B06's ACCEPTED envelope (D-RUN-1); the others a COMPLETED view. */
export const SOURCE_COMMAND_RESPONSES = Object.freeze({
  CMD012: { status: 201, view: "CreateRevisionView" },
  CMD013: { status: 201, view: "ReserveUploadView" },
  CMD014: { status: 202, view: null },
  CMD015: { status: 200, view: "CancelUploadView" },
  CMD016: { status: 200, view: "SelectInputTablesView" },
  CMD017: { status: 200, view: "SealRevisionView" },
} as const);

export const SOURCE_VIEW_DEFINITIONS: ReadonlyArray<ViewDefinition> = Object.freeze([
  {
    name: "UploadView",
    description: "Safe progress of one upload (10 \"GET returns safe progress without exposing the session URI to unrelated readers\"; UI14 \"Separate upload progress, provider observation, scanner coverage, parser state and accepted bytes\").",
    contract: "UploadSession",
    withheld: {
      providerSessionSecretRef: "Private bearer reference (registry: never included in generic DTO/logs); the session is delivered only by the protected response to its requester (D-SESSION-2).",
      observedGeneration: "A provider generation locates stored customer bytes; progress carries the observed length and time instead, and the sealed manifest binds generations by digest (09 Storage zones and object registry).",
    },
    members: {
      uploadId: registry(true, NARROW_ID),
      revisionId: registry(true, NARROW_ID),
      version: registry(true),
      state: registry(true),
      reservedBytes: registry(true),
      applicationExpiresAt: registry(true),
      providerCancellationState: registry(true),
      inspectionReceiptHash: registry(false),
      agencyId: platform(true, ID, "Owning agency."),
      projectId: platform(true, ID, "Owning project."),
      displayName: platform(true, LABEL, "Untrusted display filename (09: display metadata only, never part of a storage path, an event or a log); the UI escapes it."),
      declaredFormat: platform(true, DECLARED_FORMAT, "Declared format (CMD013 declaredFormat, narrowed to the supported formats, D-SAPI-4)."),
      observation: platform(false, closed(["bytes", "observedAt"], { bytes: COUNT, observedAt: UTC }), "What the provider actually holds, once the server observed it (S053: observation, never the browser's claim)."),
      inspection: platform(false, ref("UploadInspectionView"), "The inspection outcome as separate results (09: no single generic safe flag)."),
      fileId: platform(false, ID, "The admitted file, once ADMITTED."),
      terminalReason: platform(false, TOKEN, "Why application acceptance ended (CANCELLED, EXPIRED or REJECTED)."),
      requestedByMembershipId: platform(true, ID, "The requester's membership."),
      createdAt: platform(true, UTC, "Initiation; the application deadline is exactly twenty-four hours later (09 Upload reservation)."),
      permittedActions: platform(true, SOURCE_ACTIONS_SCHEMA, SOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "UploadInspectionView",
    description: "One inspection receipt's separate results (09 \"Completion and inspection\": STRUCTURE_VALID, SCAN_COMPLETE_NO_DETECTION and SEMANTIC_NOT_YET_PROFILED are separate fields).",
    contract: null,
    withheld: {},
    members: {
      structureStatus: platform(true, { type: "string", enum: ["STRUCTURE_VALID", "STRUCTURE_INVALID", "NOT_EVALUATED"] }, "Structural result of the bounded preflight."),
      scanState: registry(true, undefined, ["FileManifest", "scanState"]),
      semanticStatus: platform(true, { type: "string", const: "SEMANTIC_NOT_YET_PROFILED" }, "Inspection never claims a semantic profile."),
      detectedFormat: platform(true, { type: "string", enum: ["CSV", "XLSX", "UNSUPPORTED", "NOT_EVALUATED"] }, "Detected format, compared with the declared one."),
      claimConsistent: platform(true, { type: "boolean" }, "Whether the browser's completion claim agreed with the server's observation (a claim is never authority)."),
      scanCoverage: platform(true, closed(["expectedParts", "scannedParts", "expectedBytes", "scannedBytes"], { expectedParts: COUNT, scannedParts: COUNT, expectedBytes: COUNT, scannedBytes: COUNT }), "Expected parts and bytes against actual scan coverage (09 Scanner coverage; S054)."),
      problems: platform(true, { type: "array", maxItems: 256, items: TOKEN }, "Stable problem codes; never an archive entry name or a cell value."),
      rejectionClass: platform(false, TOKEN, "The precise rejection class (09 Completion and inspection; D-INSP-3)."),
    },
  },
  {
    name: "UploadPage",
    description: "A page of the revision's uploads in (createdAt, uploadId) order (10 \"Pagination, search and exports\").",
    contract: null,
    withheld: {},
    members: {
      items: platform(true, { type: "array", maxItems: 100, items: ref("UploadView") }, "The page."),
      nextCursor: platform(false, CURSOR, "The cursor of the next page, when there may be one (opaque, bound to the caller, the revision and this list)."),
    },
  },
  {
    name: "ProtectedSessionView",
    description: "The resumable provider session, delivered only to its requester in the protected response of CMD013, its replay and the session read, while the upload is UPLOADING and unexpired (10 \"Upload and target routes\"; 09 \"Resumable session security\": the reference is a bearer credential, never logged, cached, emailed or shown to another reader). delivery PROTECTED_RESPONSE carries uploadUrl, method, chunkMultipleBytes and applicationExpiresAt; UNAVAILABLE carries unavailableReason only.",
    contract: null,
    withheld: {},
    members: {
      delivery: platform(true, { type: "string", enum: ["PROTECTED_RESPONSE", "UNAVAILABLE"] }, "Whether the session is delivered."),
      uploadUrl: platform(false, { type: "string", pattern: "^https://", maxLength: 4096 }, "The resumable session URL (a bearer credential; Cache-Control no-store on every reply)."),
      method: platform(false, { type: "string", const: "PUT" }, "The method the client resumes with."),
      chunkMultipleBytes: platform(false, COUNT, "The chunk multiple the client respects when resuming from the provider-confirmed offset."),
      applicationExpiresAt: platform(false, UTC, "The application acceptance deadline; the provider session may outlive it, acceptance does not (R2-051)."),
      unavailableReason: platform(false, { type: "string", enum: ["SESSION_NOT_ACTIVE", "NOT_REQUESTER", "SESSION_PENDING"] }, "Why the session is not delivered."),
    },
  },
  {
    name: "RevisionQuotaView",
    description: "The revision's intake envelope as committed (R2-052: the database decides on the committed ledger; the view informs).",
    contract: null,
    withheld: {},
    members: {
      reservedBytes: platform(true, COUNT, "Bytes held: reservations in flight and admitted observed bytes."),
      fileCount: platform(true, COUNT, "Uploads in flight and admitted files."),
      revisionBytesLimit: platform(true, COUNT, "Policy input.revisionBytes."),
      revisionFileLimit: platform(true, COUNT, "Policy input.files."),
      fileBytesLimit: platform(true, COUNT, "Policy input.fileBytes."),
      agencyActiveSessions: platform(true, COUNT, "The agency's upload sessions in flight."),
      agencySessionLimit: platform(true, COUNT, "Policy capacity.agencyUploads, as operations set it for the agency."),
    },
  },
  {
    name: "ReserveUploadView",
    description: "CMD013 ReserveUpload result: the reservation, the revision after upload_reserved, the committed envelope and the protected session (never journaled: the journal holds a placeholder the transport hydrates for the requester, D-SESSION-2).",
    contract: null,
    withheld: {},
    members: {
      upload: platform(true, ref("UploadView"), "The reservation (UPLOADING once the session was issued)."),
      revision: platform(true, ref("RevisionSummary"), "The revision after the reservation (UPLOADING)."),
      quota: platform(true, ref("RevisionQuotaView"), "The committed envelope."),
      session: platform(true, ref("ProtectedSessionView"), "The protected session."),
    },
  },
  {
    name: "RetentionView",
    description: "A retention record governing a revision's data (09 \"Retention schedule\"; HASHING \"Retention formulas\"; registry RetentionRecord: the effective deadline is a minimum of named anchors and retries do not extend it).",
    contract: "RetentionRecord",
    withheld: {
      scope: "The enclosing revision names the agency, project and revision the record governs.",
    },
    members: {
      retentionId: registry(true, NARROW_ID),
      class: registry(true),
      anchorEvidenceHash: registry(true),
      softDeadline: registry(false),
      hardDeadline: registry(true),
      effectiveDeadline: registry(true),
      policyVersion: registry(true),
      providerResiduals: registry(true),
      state: registry(true),
    },
  },
  {
    name: "SourceRevisionView",
    description: "A dataset revision: its lifecycle, lineage, bound selection, frozen populations, seal and retention (10 \"Client and project routes\"; 09 \"Notifications and customer action\": dataAvailableUntil on every source screen once a record governs it).",
    contract: "DatasetRevision",
    withheld: {
      scope: "The agencyId and projectId members carry the tenant binding.",
      files: "The inspection read serves the file set with its tables; a revision summary does not repeat it.",
      manifestHash: "Required by the registry of a sealed contract; a mutable revision has none, so the view serves it inside `seal`, present exactly once the revision is sealed.",
      projectionHash: "As manifestHash: served inside `seal`.",
    },
    members: {
      revisionId: registry(true, NARROW_ID),
      version: registry(true),
      state: registry(true),
      sealedAt: registry(false),
      supersedesRevisionId: registry(false, NARROW_ID),
      agencyId: platform(true, ID, "Owning agency."),
      projectId: platform(true, ID, "Owning project."),
      supersededByRevisionId: platform(false, ID, "The successor once SUPERSEDED or replaced (D-REV-1)."),
      selection: platform(false, closed(["selectionManifestId", "selectionHash", "inventoryHash", "selectedAt"], { selectionManifestId: ID, selectionHash: HASH, inventoryHash: HASH, selectedAt: UTC }), "The bound selection and the inventory it was made against (D-SEL-3)."),
      evaluationHash: platform(false, HASH, "The evaluation that froze the populations (READY_TO_SEAL onwards)."),
      populations: platform(false, POPULATIONS, POPULATIONS_DESCRIPTION),
      seal: platform(false, closed(["manifestHash", "projectionHash", "fileCount", "bytes"], { manifestHash: HASH, projectionHash: HASH, fileCount: COUNT, bytes: COUNT }), "The sealed subject: manifest and projection digests (KAURO_SOURCE_REVISION_V1), included files and bytes."),
      retention: platform(false, { type: "array", maxItems: 8, items: ref("RetentionView") }, "The records governing the revision's data."),
      dataAvailableUntil: platform(false, UTC, "The earliest effective deadline of the governing records."),
      terminalReason: platform(false, TOKEN, "Why the revision closed (CANCELLED, REJECTED, EXPIRED)."),
      blockers: platform(true, { type: "array", maxItems: SOURCE_BLOCKERS.length, items: { type: "string", enum: [...SOURCE_BLOCKERS] } }, "Why the revision cannot move forward now, recomputed at read time from durable facts (10: a readiness flag is informative, not authority)."),
      createdAt: platform(true, UTC, "Server creation time."),
      permittedActions: platform(true, SOURCE_ACTIONS_SCHEMA, SOURCE_ACTIONS_DESCRIPTION),
    },
  },
  {
    name: "InspectionColumnView",
    description: "One positional column of a detected table (03 \"Source identity\": positional ids independent of labels; duplicate and empty headers are surfaced).",
    contract: null,
    withheld: {},
    members: {
      ordinal: platform(true, COUNT, "Zero-based position (the column's identity)."),
      label: platform(false, LABEL, "Untrusted header text for display (absent when empty or undecodable); the UI escapes it."),
      labelState: platform(true, { type: "string", enum: ["PRESENT", "EMPTY", "DUPLICATE_LABEL", "DISPLAY_TRUNCATED", "UNDECODABLE", "NO_HEADER"] }, "How the header was observed."),
    },
  },
  {
    name: "InspectionTableView",
    description: "A detected worksheet or CSV table with its structural facts (04 \"XLSX parser requirements\": hidden worksheets stay in the inventory, formula text is inert, merged cells as observed).",
    contract: null,
    withheld: {},
    members: {
      tableId: platform(true, ID, "Table identity (file, ordinal)."),
      ordinal: platform(true, COUNT, "Workbook order; 0 for a CSV table."),
      kind: platform(true, { type: "string", enum: ["CSV_TABLE", "WORKSHEET"] }, "Table kind."),
      name: platform(false, LABEL, "Untrusted worksheet name for display; the UI escapes it."),
      visibility: platform(true, { type: "string", enum: ["VISIBLE", "HIDDEN", "VERY_HIDDEN"] }, "Worksheet visibility; a hidden table is never silently included (CMD016)."),
      columnCount: platform(true, COUNT, "Detected columns."),
      rowEstimate: platform(false, COUNT, "A structural estimate from the preflight; never the counted population."),
      hasFormulas: platform(true, { type: "boolean" }, "Whether formulas are present."),
      formulaCache: platform(true, { type: "string", enum: ["NOT_APPLICABLE", "ALL_PRESENT", "SOME_MISSING", "ERROR_VALUES", "EXTERNAL_DEPENDENCY"] }, "The cached-value situation of the formulas."),
      mergedCellCount: platform(true, COUNT, "Merged cells as observed."),
      hiddenRowCount: platform(true, COUNT, "Hidden rows."),
      hiddenColumnCount: platform(true, COUNT, "Hidden columns."),
      issues: platform(true, { type: "array", maxItems: 64, items: TOKEN }, "Stable issue codes (encoding, delimiter ambiguity, duplicate headers, blank lines, ...)."),
      structureHash: platform(true, HASH, "KAURO_SOURCE_TABLE_V1 digest of the detected facts: a selection binds it."),
      columns: platform(true, { type: "array", maxItems: 16384, items: ref("InspectionColumnView") }, "Positional columns."),
    },
  },
  {
    name: "InspectionFileView",
    description: "An admitted file with its detected tables (registry FileManifest; \"Only provider-observed bytes and generations may be admitted\").",
    contract: "FileManifest",
    withheld: {
      storageRef: "A private registry object reference (registry: never a public bucket URI); the tenant has no use for it.",
      providerGeneration: "A provider generation locates stored customer bytes; the file is identified by fileId and bound by sha256 and bytes.",
    },
    members: {
      fileId: registry(true, NARROW_ID),
      sha256: registry(true),
      bytes: registry(true),
      format: registry(true),
      scanState: registry(true),
      parserProfileHash: registry(true),
      admitted: registry(true),
      origin: platform(true, { type: "string", enum: ["THIS_REVISION", "REUSABLE"] }, "Admitted from this revision's uploads, or a previously admitted file of the project the selection may reuse."),
      uploadId: platform(true, ID, "The upload that admitted it."),
      tables: platform(true, { type: "array", maxItems: 4096, items: ref("InspectionTableView") }, "Detected tables."),
    },
  },
  {
    name: "InspectionView",
    description: "GET /revisions/{revisionId}/inspection (10: files, detected worksheets, parser choices and structured problems), with the inventory hash a selection manifest is made against (D-SEL-3).",
    contract: null,
    withheld: {},
    members: {
      revision: platform(true, ref("SourceRevisionView"), "The revision."),
      inventoryHash: platform(true, HASH, "KAURO_SOURCE_INVENTORY_V1 digest of the uploads, files and tables below."),
      uploads: platform(true, { type: "array", maxItems: 500, items: ref("UploadView") }, "Every upload of the revision, terminal ones included (a rejection is listed with its class, never silently dropped)."),
      files: platform(true, { type: "array", maxItems: 100, items: ref("InspectionFileView") }, "Admitted files of this revision, then reusable admitted files of the project."),
      selection: platform(false, closed(["selectionManifestId", "selectionHash", "tables"], {
        selectionManifestId: ID,
        selectionHash: HASH,
        tables: { type: "array", maxItems: 4096, items: closed(["tableId", "disposition"], { tableId: ID, disposition: { type: "string", enum: ["INCLUDE", "EXCLUDE"] }, exclusionReason: TOKEN }) },
      }), "The bound selection's table choices (the manifest document is its own resource)."),
      evaluation: platform(false, closed(["evaluationHash", "result", "failures"], {
        evaluationHash: HASH,
        result: { type: "string", enum: ["COMPLETE", "ADMISSION_FAILED", "ERROR"] },
        populations: POPULATIONS,
        failures: { type: "array", maxItems: 256, items: closed(["code"], { code: TOKEN, tableId: ID }) },
      }), "The latest evaluation of the bound selection."),
    },
  },
  {
    name: "RevisionImpactView",
    description: "Authority that does not carry onto the new bytes (CMD012 failure: do not carry old validation, approval or paid execution authority onto changed bytes; identified, never transferred).",
    contract: null,
    withheld: {},
    members: {
      planIds: platform(true, ids(1000), "Plans that name the predecessor's manifest hash."),
      approvalIds: platform(true, ids(1000), "Their live approvals."),
      commercialAuthorizationIds: platform(true, ids(1000), "Live commercial authorizations bound to the predecessor (none before the payments package, B09)."),
    },
  },
  {
    name: "ProjectRevisionPointerView",
    description: "The project after CMD012 moved its current revision.",
    contract: null,
    withheld: {},
    members: {
      projectId: platform(true, ID, "The project."),
      version: platform(true, VERSION, "Its version after the move."),
      currentRevisionId: platform(true, ID, "The new current revision."),
    },
  },
  {
    name: "CreateRevisionView",
    description: "CMD012 CreateRevision result: the new mutable revision with explicit lineage, the predecessor after the command (SUPERSEDED if it was sealed, CANCELLED if it was mutable), the project pointer, the invalidated authority and the uploads cancelled with a mutable predecessor.",
    contract: null,
    withheld: {},
    members: {
      revision: platform(true, ref("SourceRevisionView"), "The new DRAFT revision."),
      predecessor: platform(true, ref("RevisionSummary"), "The predecessor after the command."),
      project: platform(true, ref("ProjectRevisionPointerView"), "The project's current revision pointer."),
      invalidated: platform(true, ref("RevisionImpactView"), "Authority identified as not carried over."),
      cancelledUploadIds: platform(true, ids(500), "Uploads of a mutable predecessor tombstoned with it."),
    },
  },
  {
    name: "CancelUploadView",
    description: "CMD015 CancelUpload result: acceptance tombstoned, the provider cancellation requested where a session exists, and the bytes returned to the envelope exactly once.",
    contract: null,
    withheld: {},
    members: {
      upload: platform(true, ref("UploadView"), "The cancelled upload."),
      revision: platform(true, ref("RevisionSummary"), "The revision after the cancellation."),
      releasedBytes: platform(true, COUNT, "Bytes returned to the revision envelope."),
    },
  },
  {
    name: "SelectInputTablesView",
    description: "CMD016 SelectInputTables result: the revision INSPECTING with its new selection, uncounted until SELECTION_EVALUATION counts it.",
    contract: null,
    withheld: {},
    members: {
      revision: platform(true, ref("SourceRevisionView"), "The revision after the binding."),
      selection: platform(true, closed(["selectionManifestId", "selectionHash", "includedFileCount", "includedTableCount", "reusedFileIds"], {
        selectionManifestId: ID,
        selectionHash: HASH,
        includedFileCount: COUNT,
        includedTableCount: COUNT,
        reusedFileIds: ids(50),
      }), "The bound selection."),
    },
  },
  {
    name: "SealRevisionView",
    description: "CMD017 SealRevision result: the sealed revision, its manifest and projection digests and the UNPAID retention record anchored on the seal.",
    contract: null,
    withheld: {},
    members: {
      revision: platform(true, ref("SourceRevisionView"), "The SEALED revision."),
      manifestHash: platform(true, HASH, "KAURO_SOURCE_REVISION_V1 digest of the sealed manifest: exactly HASHING's preimage (accepted files, table selection, parser profile, projection; B07-F12)."),
      projectionHash: platform(true, HASH, "Digest of the sealed projection and pricing interpretation."),
      sealedSubjectHash: platform(true, HASH, "KAURO_SOURCE_SEALED_SUBJECT_V1 digest of the sealed subject: this revision, its lineage, the manifest and the frozen counts (D-HASH-4). Named apart from the forbidden identity member subjectHash (B06 FORBIDDEN_RESPONSE_FIELDS)."),
      retention: platform(true, ref("RetentionView"), "The UNPAID record: hard deadline fourteen days from the seal."),
    },
  },
  {
    name: "SelectionManifestIntakeView",
    description: "The selection manifest intake (D-SEL-2): stored once per revision and body hash; the same body again answers the stored manifest with created false.",
    contract: null,
    withheld: {},
    members: {
      selectionManifestId: platform(true, ID, "The manifest identity CMD016 names as selectionManifestRef."),
      revisionId: platform(true, ID, "The revision it selects in."),
      bodyHash: platform(true, HASH, "KAURO_SOURCE_SELECTION_V1 digest of the document: the selectionHash CMD017 confirms."),
      created: platform(true, { type: "boolean" }, "False when the same document was already stored for this revision."),
    },
  },
  {
    name: "SelectionManifestView",
    description: "A stored selection manifest (D-SEL-1): the closed document — dispositions, parser choices, projection and associations; ids, digests, tokens and positions only.",
    contract: null,
    withheld: {},
    members: {
      selectionManifestId: platform(true, ID, "The manifest identity."),
      revisionId: platform(true, ID, "The revision it selects in."),
      bodyHash: platform(true, HASH, "KAURO_SOURCE_SELECTION_V1 digest of the document."),
      createdByMembershipId: platform(true, ID, "The membership that stored it."),
      createdAt: platform(true, UTC, "When it was stored."),
      document: platform(true, SELECTION_DOCUMENT, "The document as stored."),
    },
  },
  {
    name: "TablePreviewView",
    description: "A bounded authorized sample of an admitted table (10 \"A preview endpoint returns a bounded authorized sample with safe display escaping and no shared caching\"; D-SAPI-7): at most 20 rows of at most 50 columns, each cell at most 200 characters of decoded text the UI escapes; never cached, never logged.",
    contract: null,
    withheld: {},
    members: {
      tableId: platform(true, ID, "The table."),
      fileId: platform(true, ID, "Its admitted file."),
      columns: platform(true, { type: "array", maxItems: 50, items: ref("InspectionColumnView") }, "The previewed columns in position order."),
      rows: platform(true, { type: "array", maxItems: 20, items: { type: "array", maxItems: 50, items: { type: ["string", "null"], maxLength: 200 } } }, "Decoded cell text per row, null for an empty cell; formula text is inert text."),
      truncated: platform(true, { type: "boolean" }, "Whether rows, columns or cells were cut to the bounds."),
    },
  },
] satisfies ReadonlyArray<ViewDefinition>);

function refuse(message: string): never {
  throw new DomainFailure("INTEGRITY_FAILURE", `source response views: ${message}`);
}

// --- the planned reply envelopes (B07-F13): generated into OpenAPI as x-kauro-planned until mandate B07-COMMANDS serves them ------

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The COMPLETED reply of a B07 command (CMD014 answers B06's ACCEPTED envelope instead, D-RUN-1). */
export function sourceCommandResponseSchemaId(command: Exclude<keyof typeof SOURCE_COMMAND_RESPONSES, "CMD014">): string {
  return `${RESPONSE_SCHEMA_PREFIX}${command}`;
}

/** The reply of an auxiliary source route (a read, or the selection manifest intake). */
export function sourceRouteResponseSchemaId(operationId: SourceRouteId): string {
  return `${RESPONSE_SCHEMA_PREFIX}source:${operationId}`;
}

function sourceCompletedEnvelope(command: Exclude<keyof typeof SOURCE_COMMAND_RESPONSES, "CMD014">, view: string): JsonSchema {
  return {
    $schema: DIALECT,
    $id: sourceCommandResponseSchemaId(command),
    title: `${command} COMPLETED`,
    description: "Synchronous success: the validated DTO and the version of the aggregate the command edited or created (10 \"Responses and safe errors\"); replayed is true when an idempotent replay returned the journaled result (10 \"Idempotency contract\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "version", "replayed", "data"],
    properties: {
      kind: { type: "string", const: "COMPLETED" },
      version: VERSION,
      replayed: { type: "boolean" },
      data: ref(view),
    },
  };
}

function sourceRouteEnvelope(operationId: SourceRouteId, route: SourceRouteSpec): JsonSchema {
  const intake = route.method === "POST";
  return {
    $schema: DIALECT,
    $id: sourceRouteResponseSchemaId(operationId),
    title: `${operationId} ${intake ? "STORED" : "READ"}`,
    description: intake
      ? "The selection manifest intake (D-SEL-2): the stored document's identity; created false (200) when the same body was already stored for this revision (content-idempotent, no journal entry, no aggregate version)."
      : "A read: the safe projection the caller may see (10 \"Read endpoints return safe projections\").",
    type: "object",
    additionalProperties: false,
    required: ["kind", "data"],
    properties: {
      kind: { type: "string", const: intake ? "STORED" : "READ" },
      data: ref(route.view),
    },
  };
}

/**
 * Every schema the planned B07 routes reply with, built exactly as B06 builds its served ones (views over the registry bundle,
 * closed envelopes that reference them): `defs` are the source views, `roots` the envelopes by schema id. `existing` are the served
 * (B06) view names the source views may reference and must not redefine. tools/openapi.mjs documents the routes from these as
 * x-kauro-planned operations (B07-F13); when B07-COMMANDS serves them, the views join VIEW_DEFINITIONS and the envelopes the
 * served roots, and the routes move to `paths`.
 */
export function buildSourceResponseSchemas(bundle: RegistryBundle, existing: ReadonlySet<string>, routes: Readonly<Record<SourceRouteId, SourceRouteSpec>>): { readonly defs: Readonly<Record<string, JsonSchema>>; readonly roots: Readonly<Record<string, JsonSchema>> } {
  const defs = buildSourceViewSchemas(bundle, existing);
  const known = (view: string): boolean => view in defs || existing.has(view);
  const roots: Record<string, JsonSchema> = {};
  for (const [command, reply] of Object.entries(SOURCE_COMMAND_RESPONSES) as Array<[keyof typeof SOURCE_COMMAND_RESPONSES, (typeof SOURCE_COMMAND_RESPONSES)[keyof typeof SOURCE_COMMAND_RESPONSES]]>) {
    if (command === "CMD014" || reply.view === null) continue;
    if (!known(reply.view)) refuse(`${command} names an unknown view ${reply.view}`);
    roots[sourceCommandResponseSchemaId(command)] = sourceCompletedEnvelope(command, reply.view);
  }
  for (const [operationId, route] of Object.entries(routes) as Array<[SourceRouteId, SourceRouteSpec]>) {
    if (!known(route.view)) refuse(`${operationId} names an unknown view ${route.view}`);
    roots[sourceRouteResponseSchemaId(operationId)] = sourceRouteEnvelope(operationId, route);
  }
  for (const [where, schema] of Object.entries(roots)) {
    for (const member of declaredMembers(schema)) {
      if (member.name in FORBIDDEN_RESPONSE_FIELDS) refuse(`${where}${member.path} declares the forbidden member ${member.name}`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${where} is not closed at ${open.join(", ")}`);
  }
  return { defs, roots };
}

/**
 * Builds every source view over the registry bundle with B06's viewSchema. `existing` are the B06 view names the source views
 * may reference (RevisionSummary) and must not redefine. Refuses a collision, a forbidden member (FORBIDDEN_RESPONSE_FIELDS), an
 * open object, and the session URL member anywhere but ProtectedSessionView.
 */
export function buildSourceViewSchemas(bundle: RegistryBundle, existing: ReadonlySet<string>, views: ReadonlyArray<ViewDefinition> = SOURCE_VIEW_DEFINITIONS): Readonly<Record<string, JsonSchema>> {
  const defs: Record<string, JsonSchema> = {};
  for (const view of views) {
    if (view.name in bundle.$defs) refuse(`view ${view.name} collides with a registry definition`);
    if (existing.has(view.name) || view.name in defs) refuse(`view ${view.name} is defined twice`);
    defs[view.name] = viewSchema(bundle, view);
  }
  for (const [name, schema] of Object.entries(defs)) {
    for (const member of declaredMembers(schema)) {
      if (member.name in FORBIDDEN_RESPONSE_FIELDS) refuse(`${name}${member.path} declares the forbidden member ${member.name}`);
      if (member.name === SESSION_URL_MEMBER && name !== SESSION_URL_VIEW) refuse(`${name}${member.path} carries the session URL outside ${SESSION_URL_VIEW}`);
    }
    const open = openObjects(schema);
    if (open.length > 0) refuse(`${name} is not closed at ${open.join(", ")}`);
  }
  return defs;
}
