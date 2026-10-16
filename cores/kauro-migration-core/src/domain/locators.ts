/**
 * Durable addresses for source material.
 *
 * Locators are the backbone of the audit trail: every change, flag, isolation,
 * leftover and edge in the package points back at one of these. They are
 * derived only from file bytes and position, never from time or run order, so
 * they are identical on every machine for the same inputs.
 */

import { sha256Hex } from '../util/hash.js';

export const SOURCE_FORMATS = ['CSV', 'XLSX'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const SOURCE_ENCODINGS = ['UTF8', 'UTF16LE', 'UTF16BE', 'WINDOWS_1252', 'LATIN1'] as const;
export type SourceEncoding = (typeof SOURCE_ENCODINGS)[number];

export interface FileLocator {
  readonly bundleId: string;
  /** `F-` followed by the first 12 hex characters of `fileSha256`. Collisions abort the run. */
  readonly fileId: string;
  readonly fileSha256: string;
  /** File name exactly as supplied, without directory components. */
  readonly fileNameOriginal: string;
  /** Path relative to the input bundle root, using forward slashes on every platform. */
  readonly filePathRelative: string;
  readonly fileByteLength: number;
  readonly format: SourceFormat;
  readonly encoding: SourceEncoding;
  /** How the encoding was established, e.g. `BOM_UTF8` or `CONFIG_DECLARED`. */
  readonly encodingEvidence: string;
}

export interface SheetLocator {
  readonly fileId: string;
  /** `S` followed by the zero-based sheet index within the file. CSV files always have exactly `S0`. */
  readonly sheetId: string;
  readonly sheetIndex: number;
  /** Worksheet name for XLSX. `null` for CSV, which has no sheet name. */
  readonly sheetName: string | null;
  readonly hidden: boolean;
}

export interface ColumnLocator {
  readonly fileId: string;
  readonly sheetId: string;
  /** Zero-based physical position. This, not the header text, is the authoritative address. */
  readonly columnIndex: number;
  /** `<fileId>:<sheetId>:C<columnIndex>` */
  readonly columnLocatorId: string;
  /** Header text exactly as it appears in the source. `null` when the header cell is absent. */
  readonly headerRaw: string | null;
  /**
   * 1-based ordinal among columns sharing the same `headerRaw`. Two columns both
   * named `Phone` are occurrence 1 and 2; they are never collapsed.
   */
  readonly headerOccurrence: number;
}

export interface RowLocator {
  readonly fileId: string;
  readonly sheetId: string;
  /** 1-based physical row number within the sheet, counting the header row. */
  readonly rowNumberSource: number;
  /** `<fileId>:<sheetId>:R<rowNumberSource>` */
  readonly rowLocatorId: string;
  /** SHA-256 over the row's raw cell values, delimited by a byte that cannot occur in them. */
  readonly rowHash: string;
}

export function makeFileId(fileSha256: string): string {
  return `F-${fileSha256.slice(0, 12)}`;
}

/**
 * The id of a file whose bytes another file in the bundle shares.
 *
 * A file's id is normally the first twelve hex characters of its digest. Two
 * occurrences with equal bytes would then share an id, and with it every row
 * locator, so the second would overwrite the first in the lineage. Such files
 * take their id from the digest **and the path**, which the plan keeps unique
 * (D69). A file whose bytes are unique keeps the digest id it has always had.
 */
export function makeOccurrenceFileId(fileSha256: string, filePath: string): string {
  return `F-${sha256Hex(`${fileSha256}|${filePath}`).slice(0, 12)}`;
}

export function makeSheetId(sheetIndex: number): string {
  return `S${String(sheetIndex)}`;
}

export function makeColumnLocatorId(fileId: string, sheetId: string, columnIndex: number): string {
  return `${fileId}:${sheetId}:C${String(columnIndex)}`;
}

export function makeRowLocatorId(fileId: string, sheetId: string, rowNumberSource: number): string {
  return `${fileId}:${sheetId}:R${String(rowNumberSource)}`;
}

/** Human-facing address such as `contacts.csv!S0!row 14`, used in operator messages only. */
export function describeRow(file: FileLocator, sheet: SheetLocator, row: RowLocator): string {
  const sheetPart = sheet.sheetName === null ? '' : `!${sheet.sheetName}`;
  return `${file.filePathRelative}${sheetPart}!row ${String(row.rowNumberSource)}`;
}
