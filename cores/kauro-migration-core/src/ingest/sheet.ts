import type { ColumnLocator, FileLocator, RowLocator, SheetLocator } from '../domain/locators.js';
import { makeColumnLocatorId, makeRowLocatorId } from '../domain/locators.js';
import type { SourceCell, SourceRow } from '../domain/source-cell.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import { sha256Hex } from '../util/hash.js';

/** A row that could not be read as a well-formed row of its sheet. It still gets a locator and a disposition. */
export interface RejectedRow {
  readonly locator: RowLocator;
  readonly reasonCode: ReasonCode;
  readonly detail: string;
}

/** Observed facts about the source that are not values: delimiter, formulas present, hidden sheet, and so on. */
export interface SheetEvidence {
  readonly kind: string;
  readonly detail: string;
}

export interface IngestedSheet {
  readonly file: FileLocator;
  readonly sheet: SheetLocator;
  readonly columns: readonly ColumnLocator[];
  readonly headerRowNumber: number;
  /**
   * Data rows the reader produced, counted where the reader produced them and
   * before anything downstream sorted them into accepted and rejected. This is
   * the anchor for row conservation: counting the accepted and rejected arrays
   * instead would compare the same arrays the lineage walks.
   */
  readonly readerRowCount: number;
  /**
   * Rows the reader accepted, counted in the pass that sorted them.
   *
   * Kept as a number because the rows themselves are not kept: asking how many
   * there are would otherwise mean reading the file to count them.
   */
  readonly dataRowCount: number;
  /**
   * The accepted rows, read from the file when they are walked.
   *
   * Not an array. A bundle of a million rows does not fit in one, and holding
   * the rows of every sheet at once is what made a 38 MB source need hundreds
   * of megabytes before a single value had been looked at.
   *
   * Walking it twice reads the file twice, which is deliberate: relationships
   * need the owning rows and then the rows they point at, and re-reading a file
   * costs I/O where keeping its rows costs memory that grows with the source.
   */
  readonly rows: Iterable<SourceRow>;
  readonly rejectedRows: readonly RejectedRow[];
  readonly evidence: readonly SheetEvidence[];
}

export interface IngestedFile {
  readonly file: FileLocator;
  readonly sheets: readonly IngestedSheet[];
}

export interface IngestedBundle {
  readonly bundleId: string;
  readonly files: readonly IngestedFile[];
}

/**
 * Builds column locators from the header row.
 *
 * Two columns with the same header stay two columns. Their `headerOccurrence`
 * distinguishes them, and the physical index remains the authoritative address,
 * so nothing downstream can collapse them by accident.
 */
export function buildColumns(
  headerValues: readonly (string | null)[],
  fileId: string,
  sheetId: string,
): ColumnLocator[] {
  const seen = new Map<string, number>();
  return headerValues.map((headerRaw, columnIndex) => {
    const key = headerRaw === null ? ABSENT_HEADER_KEY : headerRaw;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return {
      fileId,
      sheetId,
      columnIndex,
      columnLocatorId: makeColumnLocatorId(fileId, sheetId, columnIndex),
      headerRaw,
      headerOccurrence: occurrence,
    };
  });
}

const ABSENT_HEADER_KEY = String.fromCharCode(1);
const HASH_SEPARATOR = String.fromCharCode(0);
const HASH_ABSENT = String.fromCharCode(1);
const HASH_ESCAPED_SEPARATOR = String.fromCharCode(2);

/**
 * Row hash over the raw cell values.
 *
 * Uses control characters as separators, escapes any that appear inside a
 * value, and includes the column count, so a shorter row can never hash the
 * same as a longer one whose trailing cells happen to be empty.
 */
export function computeRowHash(cells: readonly SourceCell[]): string {
  const parts = cells.map((cell) =>
    cell.raw === null ? HASH_ABSENT : cell.raw.split(HASH_SEPARATOR).join(HASH_ESCAPED_SEPARATOR),
  );
  return sha256Hex([String(cells.length), ...parts].join(HASH_SEPARATOR));
}

export function makeRowLocator(
  fileId: string,
  sheetId: string,
  rowNumberSource: number,
  cells: readonly SourceCell[],
): RowLocator {
  return {
    fileId,
    sheetId,
    rowNumberSource,
    rowLocatorId: makeRowLocatorId(fileId, sheetId, rowNumberSource),
    rowHash: computeRowHash(cells),
  };
}

export function makeSourceRow(
  sheet: SheetLocator,
  rowNumberSource: number,
  cells: readonly SourceCell[],
): SourceRow {
  return {
    sheet,
    locator: makeRowLocator(sheet.fileId, sheet.sheetId, rowNumberSource, cells),
    cells,
  };
}
