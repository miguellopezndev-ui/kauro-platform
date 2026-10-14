// Fixtures of the sources screens' tests (UI14-UI16): the api's own DTOs, built to the generated types and checked against the generated
// schemas by the api client when a test serves them. Synthetic names and numbers only; nothing here is a customer's value.
import type { InspectionColumnView, InspectionFileView, InspectionTableView, InspectionView, ProjectView, ProtectedSessionView, ReserveUploadView, SourceRevisionView, UploadView } from "../../src/api/generated.ts";
import { AGENCY, HASH, PROJECT, REVISION } from "./fixtures.ts";

export const UPLOAD = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6001";
export const UPLOAD_TWO = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6002";
export const FILE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6003";
export const TABLE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6004";
export const TABLE_HIDDEN = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6005";
export const MANIFEST = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6006";
export const MEMBERSHIP = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6007";
export const UPLOAD_ORIGIN = "https://uploads.example.test";
export const SELECTION_HASH = "5".repeat(64);
export const INVENTORY_HASH = "6".repeat(64);
export const NOW = Date.parse("2026-10-13T12:00:00Z");

export function revision(overrides: Partial<SourceRevisionView> = {}): SourceRevisionView {
  return {
    revisionId: REVISION,
    version: 4,
    state: "UPLOADING",
    agencyId: AGENCY,
    projectId: PROJECT,
    blockers: [],
    createdAt: "2026-10-13T10:00:00Z",
    permittedActions: ["ReserveUpload", "CompleteUpload", "CancelUpload"],
    ...overrides,
  };
}

export function project(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: PROJECT,
    agencyId: AGENCY,
    clientId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6010",
    version: 2,
    state: "OPEN",
    mode: "CLEAN",
    purpose: "Synthetic project",
    capabilityVersion: "CAP_V1",
    currentRevision: { revisionId: REVISION, state: "UPLOADING", version: 4 },
    readinessBlockers: [],
    createdAt: "2026-10-13T09:00:00Z",
    permittedActions: [],
    ...overrides,
  };
}

export function upload(overrides: Partial<UploadView> = {}): UploadView {
  return {
    uploadId: UPLOAD,
    revisionId: REVISION,
    version: 2,
    state: "UPLOADING",
    reservedBytes: 2048,
    applicationExpiresAt: "2026-10-13T18:00:00Z",
    providerCancellationState: "NOT_REQUESTED",
    agencyId: AGENCY,
    projectId: PROJECT,
    displayName: "contacts.csv",
    declaredFormat: "CSV",
    requestedByMembershipId: MEMBERSHIP,
    createdAt: "2026-10-13T11:00:00Z",
    permittedActions: ["CompleteUpload", "CancelUpload"],
    ...overrides,
  };
}

/** An upload the scanner skipped: the provider saw all the bytes, the scanner covered none of them, the structure was read. */
export function scannerSkipped(overrides: Partial<UploadView> = {}): UploadView {
  return upload({
    state: "VERIFYING",
    observation: { bytes: 2048, observedAt: "2026-10-13T11:05:00Z" },
    inspection: {
      structureStatus: "STRUCTURE_VALID",
      scanState: "NOT_SCANNED",
      semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
      detectedFormat: "CSV",
      claimConsistent: true,
      scanCoverage: { expectedParts: 4, scannedParts: 0, expectedBytes: 2048, scannedBytes: 0 },
      problems: [],
    },
    permittedActions: ["CancelUpload"],
    ...overrides,
  });
}

export function session(overrides: Partial<ProtectedSessionView> = {}): ProtectedSessionView {
  return { delivery: "PROTECTED_RESPONSE", uploadUrl: `${UPLOAD_ORIGIN}/session/opaque-one`, method: "PUT", chunkMultipleBytes: 262144, applicationExpiresAt: "2026-10-13T18:00:00Z", ...overrides };
}

export function reserved(overrides: Partial<ReserveUploadView> = {}): ReserveUploadView {
  return {
    upload: upload({ state: "RESERVED", version: 1 }),
    revision: { revisionId: REVISION, state: "UPLOADING", version: 5 },
    quota: { reservedBytes: 2048, fileCount: 1, revisionBytesLimit: 1_000_000, revisionFileLimit: 20, fileBytesLimit: 500_000, agencySessionLimit: 5, agencyActiveSessions: 1 },
    session: session(),
    ...overrides,
  };
}

export function column(ordinal: number, label: string | undefined, labelState: InspectionColumnView["labelState"] = "PRESENT"): InspectionColumnView {
  return { ordinal, ...(label === undefined ? {} : { label }), labelState };
}

export function table(overrides: Partial<InspectionTableView> = {}): InspectionTableView {
  return {
    tableId: TABLE,
    ordinal: 0,
    kind: "WORKSHEET",
    name: "Contacts",
    visibility: "VISIBLE",
    columnCount: 3,
    rowEstimate: 120,
    hasFormulas: false,
    formulaCache: "NOT_APPLICABLE",
    mergedCellCount: 0,
    hiddenRowCount: 0,
    hiddenColumnCount: 0,
    issues: [],
    structureHash: "7".repeat(64),
    columns: [column(0, "Email"), column(1, "Name"), column(2, "Email", "DUPLICATE_LABEL")],
    ...overrides,
  };
}

export function inspectedFile(overrides: Partial<InspectionFileView> = {}): InspectionFileView {
  return {
    fileId: FILE,
    sha256: "8".repeat(64),
    bytes: 2048,
    format: "XLSX",
    scanState: "COVERED_CLEAN",
    parserProfileHash: "9".repeat(64),
    admitted: true,
    origin: "THIS_REVISION",
    uploadId: UPLOAD,
    tables: [table(), table({ tableId: TABLE_HIDDEN, ordinal: 1, name: "Archive", visibility: "HIDDEN", hasFormulas: true, formulaCache: "SOME_MISSING", structureHash: "a1".repeat(32), columns: [column(0, "Id")] })],
    ...overrides,
  };
}

export function inspection(overrides: Partial<InspectionView> = {}): InspectionView {
  return {
    revision: revision({ state: "INSPECTING" }),
    inventoryHash: INVENTORY_HASH,
    uploads: [upload({ state: "ADMITTED", fileId: FILE, displayName: "contacts.xlsx", declaredFormat: "XLSX" })],
    files: [inspectedFile()],
    ...overrides,
  };
}

/** A revision whose selection was confirmed, evaluated and is ready to be sealed. */
export function readyToSeal(overrides: Partial<SourceRevisionView> = {}): SourceRevisionView {
  return revision({
    state: "READY_TO_SEAL",
    version: 9,
    selection: { selectionManifestId: MANIFEST, selectionHash: SELECTION_HASH, inventoryHash: INVENTORY_HASH, selectedAt: "2026-10-13T11:30:00Z" },
    evaluationHash: HASH,
    populations: { physicalSourceRows: 12_345, logicalSourceRecords: 7_777, billableSourceUnits: 9_876, associationEdges: 4_321 },
    blockers: [],
    dataAvailableUntil: "2026-11-13T00:00:00Z",
    permittedActions: ["SealRevision", "SelectInputTables"],
    ...overrides,
  });
}

export function evaluated(overrides: Partial<InspectionView> = {}): InspectionView {
  return inspection({
    revision: readyToSeal(),
    selection: { selectionManifestId: MANIFEST, selectionHash: SELECTION_HASH, tables: [{ tableId: TABLE, disposition: "INCLUDE" }, { tableId: TABLE_HIDDEN, disposition: "EXCLUDE", exclusionReason: "OLD_OR_ARCHIVED_DATA" }] },
    evaluation: { evaluationHash: HASH, result: "COMPLETE", populations: { physicalSourceRows: 12_345, logicalSourceRecords: 7_777, billableSourceUnits: 9_876, associationEdges: 4_321 }, failures: [] },
    ...overrides,
  });
}

/** Ready to seal in every way but the counts: the selection is not evaluated yet. */
export function unevaluatedRevision(): SourceRevisionView {
  const { populations: _populations, evaluationHash: _evaluationHash, ...rest } = readyToSeal();
  return rest;
}

export function unevaluatedInspection(): InspectionView {
  const { evaluation: _evaluation, ...rest } = evaluated();
  return rest;
}

/** A revision with no selection yet. */
export function withoutSelection(): SourceRevisionView {
  const { selection: _selection, ...rest } = readyToSeal();
  return rest;
}
