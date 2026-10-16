import type { RowLocator, SheetLocator } from './locators.js';

/**
 * How a cell's text was represented in the source file. The engine keeps this
 * so that later stages can tell, for example, an identifier that arrived as
 * text from one that the spreadsheet had already stored as a number.
 */
export const CELL_SOURCE_KINDS = [
  'CSV_TEXT',
  'XLSX_SHARED_STRING',
  'XLSX_INLINE_STRING',
  'XLSX_NUMBER',
  'XLSX_BOOLEAN',
  'XLSX_ERROR',
  'ABSENT',
] as const;

export type CellSourceKind = (typeof CELL_SOURCE_KINDS)[number];

export const SPREADSHEET_DATE_SYSTEMS = ['DATE_1900', 'DATE_1904'] as const;
export type SpreadsheetDateSystem = (typeof SPREADSHEET_DATE_SYSTEMS)[number];

/**
 * A cell exactly as the source represents it. This value is never mutated after
 * ingest; every interpretation lives elsewhere and points back here.
 */
export interface SourceCell {
  readonly columnIndex: number;
  /**
   * The source text. `null` means the cell is absent from the row entirely,
   * which is distinct from an empty string.
   */
  readonly raw: string | null;
  readonly kind: CellSourceKind;
  /**
   * Formula text when the spreadsheet cell carries one. The engine never
   * evaluates it; `raw` holds the value the spreadsheet had cached.
   */
  readonly formula: string | null;
  /**
   * Whether the spreadsheet stored a result for the formula. `ABSENT` means the
   * workbook was never calculated: there is no cached value to accept, and
   * `raw` is `null` for a reason other than an empty cell. Omitted for a cell
   * that did not come from a workbook reader; a formula with `raw` `null` is
   * read as `ABSENT` either way.
   */
  readonly cachedValue?: 'PRESENT' | 'ABSENT' | null;
  /** Spreadsheet number format code, when one applies. Used as date evidence. */
  readonly numberFormat: string | null;
  /** Workbook date system, carried so serial dates can be read without guessing. */
  readonly dateSystem: SpreadsheetDateSystem | null;
}

export interface SourceRow {
  readonly sheet: SheetLocator;
  readonly locator: RowLocator;
  readonly cells: readonly SourceCell[];
}

export function emptyCell(columnIndex: number): SourceCell {
  return {
    columnIndex,
    raw: null,
    kind: 'ABSENT',
    formula: null,
    numberFormat: null,
    dateSystem: null,
  };
}

export function cellAt(row: SourceRow, columnIndex: number): SourceCell {
  return row.cells[columnIndex] ?? emptyCell(columnIndex);
}

/** A cell is "present" when it holds at least one character. Whitespace counts as present. */
export function isPresent(cell: SourceCell): boolean {
  return cell.raw !== null && cell.raw.length > 0;
}

/** `true` when the row has no character in any cell. Such rows are rejected rather than skipped. */
export function isBlankRow(row: SourceRow): boolean {
  return row.cells.every((cell) => !isPresent(cell));
}
