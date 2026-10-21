// The review's one project (Order 11), as the api would answer its reads, for the screens the web implements. It is the public site's
// worked example (prototypes/example.ts): contacts.csv with 12,480 rows and companies.xlsx with 3,204, prepared for HubSpot, 15,684
// billable source units. The answers are built with the web's own test fixtures, so the schema guard checks them exactly as it checks
// the api's. Every name and number is synthetic.
import type { InspectionView, ProjectView, SourceRevisionView, UploadView } from "@web/api/generated.ts";
import { HASH, PROJECT, REVISION } from "@web-test/fixtures.ts";
import { column, inspectedFile, inspection, project, readyToSeal, revision, table, upload } from "@web-test/fixtures-sources.ts";
import { EXAMPLE } from "../../prototypes/example.ts";

export const CONTACTS_UPLOAD = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6101";
export const COMPANIES_UPLOAD = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6102";
const CONTACTS_FILE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6103";
const COMPANIES_FILE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6104";
const CONTACTS_TABLE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6105";
const COMPANIES_TABLE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6106";
const ARCHIVE_TABLE = "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6107";

const CONTACTS_BYTES = 1_372_800;
const COMPANIES_BYTES = 418_304;

/** The project as the api answers GetProject, for the agency the address names. */
export function reviewProject(agencyId: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return project({ agencyId, mode: "HUBSPOT", purpose: "Larch Studio: contacts and companies into HubSpot", ...overrides });
}

const clean = (bytes: number, detectedFormat: "CSV" | "XLSX"): NonNullable<UploadView["inspection"]> => ({
  structureStatus: "STRUCTURE_VALID",
  scanState: "COVERED_CLEAN",
  semanticStatus: "SEMANTIC_NOT_YET_PROFILED",
  detectedFormat,
  claimConsistent: true,
  scanCoverage: { expectedParts: 4, scannedParts: 4, expectedBytes: bytes, scannedBytes: bytes },
  problems: [],
});

export const contactsAdmitted = (agencyId: string): UploadView =>
  upload({ uploadId: CONTACTS_UPLOAD, agencyId, state: "ADMITTED", version: 4, displayName: "contacts.csv", declaredFormat: "CSV", reservedBytes: CONTACTS_BYTES, fileId: CONTACTS_FILE, observation: { bytes: CONTACTS_BYTES, observedAt: "2026-10-20T09:12:00Z" }, inspection: clean(CONTACTS_BYTES, "CSV"), createdAt: "2026-10-20T09:10:00Z", permittedActions: ["CancelUpload"] });

export const companiesAdmitted = (agencyId: string): UploadView =>
  upload({ uploadId: COMPANIES_UPLOAD, agencyId, state: "ADMITTED", version: 4, displayName: "companies.xlsx", declaredFormat: "XLSX", reservedBytes: COMPANIES_BYTES, fileId: COMPANIES_FILE, observation: { bytes: COMPANIES_BYTES, observedAt: "2026-10-20T09:14:00Z" }, inspection: clean(COMPANIES_BYTES, "XLSX"), createdAt: "2026-10-20T09:13:00Z", permittedActions: ["CancelUpload"] });

export const companiesUploading = (agencyId: string): UploadView =>
  upload({ uploadId: COMPANIES_UPLOAD, agencyId, state: "UPLOADING", version: 2, displayName: "companies.xlsx", declaredFormat: "XLSX", reservedBytes: COMPANIES_BYTES, createdAt: "2026-10-20T09:13:00Z" });

/** The scanner did not cover the file: the structure was read, but the page must say it was not fully checked. */
export const companiesNotScanned = (agencyId: string): UploadView =>
  upload({
    uploadId: COMPANIES_UPLOAD,
    agencyId,
    state: "VERIFYING",
    version: 3,
    displayName: "companies.xlsx",
    declaredFormat: "XLSX",
    reservedBytes: COMPANIES_BYTES,
    observation: { bytes: COMPANIES_BYTES, observedAt: "2026-10-20T09:14:00Z" },
    inspection: { structureStatus: "STRUCTURE_VALID", scanState: "NOT_SCANNED", semanticStatus: "SEMANTIC_NOT_YET_PROFILED", detectedFormat: "XLSX", claimConsistent: true, scanCoverage: { expectedParts: 3, scannedParts: 0, expectedBytes: COMPANIES_BYTES, scannedBytes: 0 }, problems: [] },
    createdAt: "2026-10-20T09:13:00Z",
    permittedActions: ["CancelUpload"],
  });

/** A file whose content is not what its name says: refused, with its reason, and never used. */
export const companiesRejected = (agencyId: string): UploadView =>
  upload({
    uploadId: COMPANIES_UPLOAD,
    agencyId,
    state: "REJECTED",
    version: 4,
    displayName: "companies.xlsx",
    declaredFormat: "XLSX",
    reservedBytes: COMPANIES_BYTES,
    observation: { bytes: COMPANIES_BYTES, observedAt: "2026-10-20T09:14:00Z" },
    inspection: { structureStatus: "STRUCTURE_INVALID", scanState: "COVERED_CLEAN", semanticStatus: "SEMANTIC_NOT_YET_PROFILED", detectedFormat: "UNSUPPORTED", claimConsistent: false, scanCoverage: { expectedParts: 3, scannedParts: 3, expectedBytes: COMPANIES_BYTES, scannedBytes: COMPANIES_BYTES }, problems: ["FORMAT_MISMATCH"], rejectionClass: "FORMAT" },
    terminalReason: "FORMAT_MISMATCH",
    createdAt: "2026-10-20T09:13:00Z",
    permittedActions: [],
  });

export const uploadingRevision = (agencyId: string, overrides: Partial<SourceRevisionView> = {}): SourceRevisionView =>
  revision({ agencyId, createdAt: "2026-10-20T09:00:00Z", ...overrides });

/** The two files as Kauro read them: one sheet each, and an archive sheet in the workbook that is hidden. */
export function reviewInspection(agencyId: string, overrides: Partial<InspectionView> = {}): InspectionView {
  return inspection({
    revision: revision({ agencyId, state: "INSPECTING", version: 6, permittedActions: ["SelectInputTables"] }),
    uploads: [contactsAdmitted(agencyId), companiesAdmitted(agencyId)],
    files: [
      inspectedFile({
        fileId: CONTACTS_FILE,
        bytes: CONTACTS_BYTES,
        format: "CSV",
        uploadId: CONTACTS_UPLOAD,
        tables: [table({ tableId: CONTACTS_TABLE, kind: "CSV_TABLE", name: "contacts.csv", columnCount: 6, rowEstimate: EXAMPLE.contacts, columns: [column(0, "First name"), column(1, "Last name"), column(2, "E-mail"), column(3, "Phone"), column(4, "Company"), column(5, "E-mail", "DUPLICATE_LABEL")] })],
      }),
      inspectedFile({
        fileId: COMPANIES_FILE,
        bytes: COMPANIES_BYTES,
        format: "XLSX",
        uploadId: COMPANIES_UPLOAD,
        tables: [
          table({ tableId: COMPANIES_TABLE, ordinal: 0, name: "Companies", columnCount: 4, rowEstimate: EXAMPLE.companies, columns: [column(0, "Company"), column(1, "Domain"), column(2, "City"), column(3, "Industry")] }),
          table({ tableId: ARCHIVE_TABLE, ordinal: 1, name: "Archive 2023", visibility: "HIDDEN", columnCount: 4, rowEstimate: 812, hasFormulas: true, formulaCache: "SOME_MISSING", structureHash: "a1".repeat(32), columns: [column(0, "Company"), column(1, "Domain"), column(2, "Closed"), column(3, "Notes")] }),
        ],
      }),
    ],
    ...overrides,
  });
}

const POPULATIONS = { physicalSourceRows: EXAMPLE.units, logicalSourceRecords: EXAMPLE.units, billableSourceUnits: EXAMPLE.units, associationEdges: EXAMPLE.contacts - EXAMPLE.report.noCompany } as const;

/** The selection confirmed and evaluated: the archive sheet left out with its reason, the counts measured on the whole set. */
export function reviewEvaluated(agencyId: string): InspectionView {
  const base = reviewInspection(agencyId);
  return {
    ...base,
    revision: readyToSeal({ agencyId, populations: POPULATIONS, dataAvailableUntil: "2026-10-21T09:10:00Z" }),
    selection: { selectionManifestId: "0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e6006", selectionHash: "5".repeat(64), tables: [{ tableId: CONTACTS_TABLE, disposition: "INCLUDE" }, { tableId: COMPANIES_TABLE, disposition: "INCLUDE" }, { tableId: ARCHIVE_TABLE, disposition: "EXCLUDE", exclusionReason: "OLD_OR_ARCHIVED_DATA" }] },
    evaluation: { evaluationHash: HASH, result: "COMPLETE", populations: POPULATIONS, failures: [] },
  };
}

export const readyRevision = (agencyId: string, overrides: Partial<SourceRevisionView> = {}): SourceRevisionView => readyToSeal({ agencyId, populations: POPULATIONS, dataAvailableUntil: "2026-10-21T09:10:00Z", ...overrides });

export { PROJECT, REVISION };
