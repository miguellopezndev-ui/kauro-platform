/**
 * The pinned limits of the platform's bounded parsers. The intake envelope is the registry's (policy.input, copied into
 * @kauro/domain INPUT_ENVELOPE and compared with the registry by the domain test): 2,000,000,000 bytes per file, 1 GiB per expanded
 * XLSX part, 20 GiB of cumulative expansion, 800 selected columns, 1 MiB per decoded cell, 8 MiB per parsed record (09 "Initial
 * intake envelope"; conjunctive limits). The archive and runtime bounds the registry does not number are recorded decisions of
 * docs/design/B07-upload-source-lifecycle.md (D-DP-1): entries, compression ratio, XML depth, wall clock, the child's heap.
 */
import type { InspectionLimits } from "@kauro/application";
import { INPUT_ENVELOPE } from "@kauro/domain";

export const DATA_PLANE_VERSION = "1.0.0";
/** ContainerInspectorPort.version (recorded as the receipt's inspectorVersion). */
export const INSPECTOR_VERSION = `kauro-container-inspector-${DATA_PLANE_VERSION}`;
/** SelectionEvaluatorPort.version (recorded as the evaluation's evaluatorVersion). */
export const EVALUATOR_VERSION = `kauro-selection-evaluator-${DATA_PLANE_VERSION}`;
export const PREVIEW_READER_VERSION = `kauro-preview-reader-${DATA_PLANE_VERSION}`;

/**
 * Decision D-DP-1 (the registry names the checks — entry count, compression ratio, XML depth, time — but not their values;
 * 04 "XLSX parser requirements"): at most 4,000 archive entries (a receipt's coverage document holds at most 4,096 parts, the
 * container included); a part may expand at most 250 times its compressed size once it passed 1 MiB (deflate's ceiling is about
 * 1,032; spreadsheet XML compresses 5..100 times); XML nests at most 64 elements deep (SpreadsheetML needs about ten); an
 * inspection or evaluation runs at most ten minutes of wall clock in a child whose V8 heap is bounded to 512 MiB; the central
 * directory is at most 16 MiB; one file's inventory holds at most 100,000 columns across its tables.
 */
export const ARCHIVE_BOUNDS = Object.freeze({
  maxArchiveEntries: 4_000,
  maxCompressionRatio: 250,
  ratioGraceBytes: 1_048_576,
  maxXmlDepth: 64,
  centralDirectoryBytes: 16_777_216,
  inventoryColumns: 100_000,
  wallClockMs: 600_000,
  childHeapMegabytes: 512,
});

/** The largest worksheet the SpreadsheetML grid admits (rows, columns): coordinates beyond it are a corrupt structure. */
export const SHEET_GRID = Object.freeze({ rows: 1_048_576, columns: 16_384 });

/** The inspection limits of this edition: the registry's intake envelope and the recorded archive bounds. */
export function inspectionLimits(): InspectionLimits {
  return Object.freeze({
    fileBytes: INPUT_ENVELOPE.fileBytes,
    xlsxExpandedTotalBytes: INPUT_ENVELOPE.xlsxExpandedTotalBytes,
    xlsxExpandedPartBytes: INPUT_ENVELOPE.xlsxExpandedPartBytes,
    maxArchiveEntries: ARCHIVE_BOUNDS.maxArchiveEntries,
    maxCompressionRatio: ARCHIVE_BOUNDS.maxCompressionRatio,
    maxXmlDepth: ARCHIVE_BOUNDS.maxXmlDepth,
    columns: INPUT_ENVELOPE.columns,
    decodedCellBytes: INPUT_ENVELOPE.decodedCellBytes,
    decodedRecordBytes: INPUT_ENVELOPE.decodedRecordBytes,
    wallClockMs: ARCHIVE_BOUNDS.wallClockMs,
  });
}

/** The limits of a counting pass: the inspection limits plus the revision envelope and the association ceiling (03). */
export function evaluationLimits(): InspectionLimits & { readonly associationCandidates: number; readonly revisionBytes: number; readonly files: number } {
  return Object.freeze({
    ...inspectionLimits(),
    associationCandidates: INPUT_ENVELOPE.associationCandidates,
    revisionBytes: INPUT_ENVELOPE.revisionBytes,
    files: INPUT_ENVELOPE.files,
  });
}

/** Decision D-SAPI-7: the preview route returns at most 20 rows of at most 50 columns, each cell at most 200 characters. */
export const PREVIEW_BOUNDS = Object.freeze({ rows: 20, columns: 50, cellChars: 200 });
