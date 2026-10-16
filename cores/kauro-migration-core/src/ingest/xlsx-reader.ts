import { Inflate } from 'fflate';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { MigrationError } from '../domain/errors.js';
import { assertCensusAgrees, createWorksheetRowCensus } from './row-census.js';
import type { Limits } from '../domain/config.js';
import type { SpreadsheetDateSystem } from '../domain/source-cell.js';
import { localName, parseXml, parseXmlChunks } from './xml-pull-parser.js';

/**
 * Workbook reader.
 *
 * Three rules govern everything in this file:
 *
 *  1. Formulas are never evaluated. When a cell carries one, the formula text
 *     is kept as provenance and the value the spreadsheet cached is marked as
 *     such so that later stages can refuse to deliver it.
 *  2. Nothing external is resolved. External link parts are noted as evidence
 *     and never followed.
 *  3. Anything the reader does not fully understand fails the run rather than
 *     producing a partial workbook.
 *
 * And one rule about what it costs, which is newer and was learned the hard
 * way. This reader used to inflate every part of the archive at once, decode
 * every one of them to a string, and build a `WorkbookRow` for every row of
 * every sheet -- and then `ingestWorkbookFile` did the whole of that again for
 * each sheet it walked. Measured on the SHEET_COUNT capacity profile, reading a
 * workbook and walking every sheet of it once:
 *
 *     rows        source     before        after
 *     100,024    48.8 MB    658 MB       209 MB
 *     150,024    73.7 MB  1,086 MB       226 MB
 *   1,000,024   496.8 MB  4,337 MB       654 MB
 *
 * The old figure was never superlinear -- that was worth measuring rather than
 * assuming, and it was measured. It was linear at about 4.3 KB per row, which
 * is a different problem and a worse one at scale: at a million rows the reader
 * still held 3.66 GB after every sheet had been walked, because the rows of
 * every sheet stayed reachable for the length of the migration. Sixty-one per
 * cent of the whole memory budget, spent before the migration did anything.
 *
 * What it does now is stream. The container is walked once for its directory
 * and then read in blocks; one part is inflated at a time and never exists as a
 * whole string; the XML parser is fed a block at a time; and a sheet's rows are
 * handed out one at a time and released as they go. What is held for the life
 * of a workbook is its directory, its sheet names, its styles and its shared
 * strings -- not its rows, and not its bytes. Retained after ingest returns, at
 * every one of the three sizes above: nothing measurable.
 *
 * Nothing left scales with the workbook. The container used to be handed whole
 * to `unzipSync` so that fflate could find the directory at its end -- 497 MB of
 * the 654 MB above, held once and released before a row was read -- and that is
 * gone too, but not for the memory. It went because of what it cost in
 * correctness:
 *
 * ---- the directory and the data have to be one authority ----
 *
 * A ZIP states what it holds twice, in a local header before each member and
 * again in the central directory at the end, and the format makes the directory
 * the authoritative one. The streaming version of this reader took its
 * *directory* from the end -- the bomb check, the duplicate check, the declared
 * size -- and its *data* from the first local header with a matching name, found
 * by streaming from the front. Where the two disagreed it believed the local one
 * and said nothing.
 *
 * An adversarial reading of it built the disagreement: stale local records,
 * current local records, a directory naming the current ones, with the stale
 * worksheet padded to the same length so the size check was satisfied. The
 * reader read the stale copy, the row census agreed because it was fed the same
 * shadowed blocks, the reconciliation equation held, `verifyPackage` passed, and
 * two rows disappeared from a migration that reported itself complete. Every one
 * of the 1,386 tests passed.
 *
 * So the directory is now walked here, by hand, and a member is inflated from
 * the exact offset the directory places it at. That is more code than handing
 * the container to `unzipSync`, and it is the code that makes the two agree by
 * construction rather than by a check that can be stepped around. The local
 * header at that offset is still read and still compared: an archive whose two
 * accounts of a member disagree is refused, loudly, rather than resolved in
 * favour of either.
 */

export interface WorkbookCell {
  readonly columnIndex: number;
  readonly raw: string | null;
  readonly kind: 'XLSX_SHARED_STRING' | 'XLSX_INLINE_STRING' | 'XLSX_NUMBER' | 'XLSX_BOOLEAN' | 'XLSX_ERROR';
  readonly formula: string | null;
  /**
   * Whether the workbook stored a result for the formula: `PRESENT` when the
   * cell has a `<v>` (even an empty one, which is a cached empty string) and
   * `ABSENT` when it has none, which is a workbook that was never calculated.
   * `null` for a cell with no formula. The engine never evaluates a formula, so
   * an `ABSENT` cache is a value nobody has; it is never an empty cell.
   */
  readonly cachedValue: 'PRESENT' | 'ABSENT' | null;
  readonly numberFormat: string | null;
}

export interface WorkbookRow {
  readonly rowNumber: number;
  readonly cells: readonly WorkbookCell[];
}

export interface WorkbookSheet {
  readonly name: string;
  readonly index: number;
  readonly hidden: boolean;
  readonly rows: readonly WorkbookRow[];
}

export interface Workbook {
  readonly sheets: readonly WorkbookSheet[];
  readonly dateSystem: SpreadsheetDateSystem;
  readonly hasExternalLinks: boolean;
  readonly hasFormulas: boolean;
}

/** What a sheet is, before any of its rows have been read. */
export interface WorkbookSheetShape {
  readonly name: string;
  readonly index: number;
  readonly hidden: boolean;
}

/**
 * An open workbook whose rows have not been read.
 *
 * Everything a caller needs in order to decide what to do with a workbook --
 * which sheets it has, which of them are hidden, what calendar its serial dates
 * are on, whether it points at anything external -- is known from parts that
 * are small whatever the workbook weighs. The rows are the part that is not
 * small, and they are produced only when they are walked.
 *
 * Walking `rows` twice reads the part twice. That is the same trade the CSV
 * reader makes and for the same reason: re-reading costs I/O, where keeping the
 * rows costs memory that grows with the source.
 */
export interface WorkbookHandle {
  readonly sheets: readonly WorkbookSheetShape[];
  readonly dateSystem: SpreadsheetDateSystem;
  readonly hasExternalLinks: boolean;
  /**
   * One sheet's rows, in document order, one at a time.
   *
   * The independent row census runs over the same blocks the parser is given
   * and is checked when the sheet ends, so a reader that lost a row still says
   * so where it lost it.
   */
  rows(sheetIndex: number): IterableIterator<WorkbookRow>;
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b];

/** Built-in number format ids that mean a date or a time. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Bytes per read of the container. Fixed, so reading a workbook does not cost what the workbook weighs. */
const CONTAINER_BLOCK_BYTES = 1 << 16;

const NO_BYTES = new Uint8Array(0);

/** Compressed bytes per push to the inflater: at most about eight megabytes out at the format's best ratio. */
const INFLATE_SLICE_BYTES = 8 * 1024;

/**
 * The parts this reader will open at all.
 *
 * A closed set, because it decides what a relationship may point at: a sheet
 * whose relationship targets something outside it is a workbook this reader
 * does not understand, and it is refused rather than followed.
 */
function isReadablePart(name: string): boolean {
  return (
    name === '[Content_Types].xml' ||
    name === 'xl/workbook.xml' ||
    name === 'xl/_rels/workbook.xml.rels' ||
    name === 'xl/sharedStrings.xml' ||
    name === 'xl/styles.xml' ||
    name.startsWith('xl/worksheets/')
  );
}

/**
 * A workbook on disk, opened without reading its rows.
 *
 * This is the entry point ingest uses. The container is held once, for as long
 * as it takes to walk its directory, and then released; every part after that
 * is streamed from the file.
 */
export function openWorkbookFile(path: string, limits: Limits, filePath: string): WorkbookHandle {
  return openArchiveWorkbook(archiveOfFile(path, limits, filePath), limits, filePath);
}

/** The same, for a workbook that is already in memory. */
export function openWorkbookBytes(bytes: Uint8Array, limits: Limits, filePath: string): WorkbookHandle {
  return openArchiveWorkbook(archiveOfBytes(bytes, limits, filePath), limits, filePath);
}

/**
 * The whole workbook, rows and all, in memory.
 *
 * Kept because a caller that genuinely wants every row of a small workbook in
 * one value should not have to assemble it, and because the tests that pin this
 * reader's refusals read it that way. It is a collection over the streaming
 * reader rather than a second reader: nothing here parses, and what it costs is
 * exactly what holding the rows costs, which is why ingest does not use it.
 */
export function readWorkbook(bytes: Uint8Array, limits: Limits, filePath: string): Workbook {
  const handle = openWorkbookBytes(bytes, limits, filePath);
  let hasFormulas = false;
  const sheets: WorkbookSheet[] = handle.sheets.map((shape) => {
    const rows: WorkbookRow[] = [];
    for (const row of handle.rows(shape.index)) {
      rows.push(row);
      if (!hasFormulas && row.cells.some((cell) => cell.formula !== null)) hasFormulas = true;
    }
    return { name: shape.name, index: shape.index, hidden: shape.hidden, rows };
  });
  return { sheets, dateSystem: handle.dateSystem, hasExternalLinks: handle.hasExternalLinks, hasFormulas };
}

function openArchiveWorkbook(archive: Archive, limits: Limits, filePath: string): WorkbookHandle {
  assertNotMacroEnabled(archive, filePath);

  const read = (name: string): string | null =>
    isReadablePart(name) && archive.entries.has(name) ? partText(archive, name, filePath) : null;

  const workbookXml = read('xl/workbook.xml');
  if (workbookXml === null) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} has no xl/workbook.xml part`,
      'The file is not a valid .xlsx workbook. Re-export it.',
      { filePath },
    );
  }

  const relsXml = read('xl/_rels/workbook.xml.rels');
  const relationships = relsXml === null ? new Map<string, string>() : parseRelationships(relsXml, filePath);
  const workbookMeta = parseWorkbook(workbookXml, filePath);

  if (workbookMeta.sheets.length > limits.maxSheetsPerFile) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${filePath} contains ${String(workbookMeta.sheets.length)} sheets, above the limit of ${String(limits.maxSheetsPerFile)}`,
      'Raise limits.maxSheetsPerFile if this is expected, or split the workbook.',
      { filePath, limit: 'maxSheetsPerFile', allowed: limits.maxSheetsPerFile, actual: workbookMeta.sheets.length },
    );
  }

  const sharedStrings = archive.entries.has('xl/sharedStrings.xml')
    ? readSharedStrings(partBlocks(archive, 'xl/sharedStrings.xml', filePath), filePath)
    : NO_SHARED_STRINGS;

  const stylesXml = read('xl/styles.xml');
  const numberFormats = stylesXml === null ? [] : parseStyles(stylesXml, filePath);

  const hasExternalLinks = [...archive.entries.keys()].some((name) => name.startsWith('xl/externalLinks/'));

  const shapes: WorkbookSheetShape[] = [];
  const sheetParts: string[] = [];
  // Two declarations pointing at one part would read the same rows twice and
  // deliver every record in them twice, which is the same defect
  // INPUT_DUPLICATE_FILE exists to prevent, one level down.
  const partOwners = new Map<string, string>();

  workbookMeta.sheets.forEach((sheetMeta, index) => {
    const target = relationships.get(sheetMeta.relationshipId);
    const part = target === undefined ? null : normalizePart(target);
    if (part !== null) {
      const owner = partOwners.get(part);
      if (owner !== undefined) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} declares sheets "${owner}" and "${sheetMeta.name}" and both read the same worksheet part ${part}`,
          'Two sheet names cannot share one worksheet. Re-export the workbook from the source application.',
          { filePath, first: owner, second: sheetMeta.name, part },
        );
      }
      partOwners.set(part, sheetMeta.name);
    }
    if (part === null || !isReadablePart(part) || !archive.entries.has(part)) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${filePath} declares sheet "${sheetMeta.name}" but its worksheet part is missing`,
        'The workbook archive is incomplete. Re-export it from the source application.',
        { filePath, sheet: sheetMeta.name, relationshipId: sheetMeta.relationshipId },
      );
    }
    shapes.push({ name: sheetMeta.name, index, hidden: sheetMeta.hidden });
    sheetParts.push(part);
  });

  return {
    sheets: shapes,
    dateSystem: workbookMeta.dateSystem,
    hasExternalLinks,
    rows(sheetIndex: number): IterableIterator<WorkbookRow> {
      const shape = shapes[sheetIndex];
      const part = sheetParts[sheetIndex];
      if (shape === undefined || part === undefined) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} was asked for sheet ${String(sheetIndex)}, which it does not declare`,
          'This is a defect in the engine rather than in the workbook. Report it with the configuration that produced it.',
          { filePath, sheetIndex },
        );
      }
      return streamWorksheet(
        partBlocks(archive, part, filePath),
        sharedStrings,
        numberFormats,
        limits,
        filePath,
        shape.name,
      );
    },
  };
}

// -------------------------------------------------------------- container

function assertNotOleContainer(bytes: Uint8Array, filePath: string): void {
  if (bytes.length >= OLE_SIGNATURE.length && OLE_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} is an OLE compound file, which means it is either an encrypted workbook or a legacy binary .xls`,
      'Open the file and save it as an unencrypted .xlsx, then run again. This engine does not open encrypted or legacy binary workbooks.',
      { filePath },
    );
  }
}

function assertZipContainer(bytes: Uint8Array, filePath: string): void {
  if (bytes.length < 4 || !ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} does not begin with a ZIP archive header, so it is not a readable .xlsx workbook`,
      'Confirm the file is a real .xlsx workbook and re-export it if necessary.',
      { filePath },
    );
  }
}

interface EntryInfo {
  readonly originalSize: number;
  readonly compressedSize: number;
  /**
   * Where the member's own local header begins.
   *
   * This is the field that makes the directory and the data one authority
   * instead of two, and it exists because they were two and it lost rows.
   *
   * A ZIP says what it holds twice: once in a local header before each member's
   * bytes, and once in the central directory at the end. Every conformant reader
   * believes the central directory, because that is what the format says is
   * authoritative and it is what an in-place update rewrites. This reader used
   * to take its *directory* from the end -- the bomb check, the duplicate check,
   * the declared size -- and its *data* from the first local header with a
   * matching name, found by streaming the container from the front. On an
   * archive where the two disagree it believed the local one and said nothing.
   *
   * That is not hypothetical. Lay a container out as
   *
   *     [stale local records][current local records][central directory][EOCD]
   *
   * -- which is what appending an update produces -- with the stale worksheet
   * padded to the same length as the current one, and this reader read the stale
   * copy. The row census agreed, because it was fed the same shadowed blocks.
   * The reconciliation equation held. `verifyPackage` passed. Two rows
   * disappeared and every check in the engine said the migration was complete.
   *
   * So the member is now found by seeking to the offset the central directory
   * names. There is one authority, and a reader that disagrees with the
   * directory cannot exist rather than being caught by a check.
   */
  readonly localHeaderOffset: number;
  /** 0 stored, 8 deflate. Anything else is refused when the part is opened. */
  readonly method: number;
}

/**
 * A ZIP container: what it declares it holds, and any range of its bytes.
 *
 * `read` is deliberately a range rather than a whole-file accessor. The
 * container is never held: the directory is parsed out of the last few
 * kilobytes, and a member is inflated from the exact range the directory places
 * it at, in blocks.
 */
interface Archive {
  readonly entries: ReadonlyMap<string, EntryInfo>;
  readonly size: number;
  read(from: number, length: number): Uint8Array;
  blocks(from: number, length: number): IterableIterator<Uint8Array>;
}

/** The largest an end-of-central-directory record can be: 22 bytes plus a 65,535-byte comment. */
const EOCD_MAX_BYTES = 22 + 0xff_ff;

function archiveOfFile(path: string, limits: Limits, filePath: string): Archive {
  const handle = openSync(path, 'r');
  try {
    const size = fstatSync(handle).size;
    const read = (from: number, length: number): Uint8Array => {
      const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(length, size - from)));
      if (buffer.length > 0) readSync(handle, buffer, 0, buffer.length, from);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
    };
    const head = read(0, 8);
    assertNotOleContainer(head, filePath);
    assertZipContainer(head, filePath);
    const entries = readCentralDirectory(read, size, limits, filePath);
    return {
      entries,
      size,
      // Each call opens the file again. The handle this function used is closed
      // before it returns, because a reader that kept one open would hold a
      // descriptor for the length of a migration and there is nothing to gain
      // by it: a range read is a seek either way.
      read: (from, length) => readFileRange(path, from, length),
      blocks: (from, length) => readFileBlocks(path, from, length),
    };
  } finally {
    closeSync(handle);
  }
}

function archiveOfBytes(bytes: Uint8Array, limits: Limits, filePath: string): Archive {
  assertNotOleContainer(bytes, filePath);
  assertZipContainer(bytes, filePath);
  const read = (from: number, length: number): Uint8Array =>
    bytes.subarray(Math.min(from, bytes.length), Math.min(from + length, bytes.length));
  const entries = readCentralDirectory(read, bytes.length, limits, filePath);
  return {
    entries,
    size: bytes.length,
    read,
    *blocks(from: number, length: number): IterableIterator<Uint8Array> {
      const end = Math.min(from + length, bytes.length);
      for (let at = Math.min(from, end); at < end; at += CONTAINER_BLOCK_BYTES) {
        yield bytes.subarray(at, Math.min(at + CONTAINER_BLOCK_BYTES, end));
      }
    },
  };
}

function readFileRange(path: string, from: number, length: number): Uint8Array {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.max(0, length));
    const read = buffer.length === 0 ? 0 : readSync(handle, buffer, 0, buffer.length, from);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
  } finally {
    closeSync(handle);
  }
}

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) + (bytes[at + 3] ?? 0) * 0x100_00_00;
const u64 = (bytes: Uint8Array, at: number): number => u32(bytes, at) + u32(bytes, at + 4) * 0x1_00_00_00_00;

function corrupt(filePath: string, detail: string, extra: Record<string, unknown> = {}): MigrationError {
  return new MigrationError(
    'INPUT_CORRUPT',
    `${filePath} ${detail}`,
    'The workbook archive is damaged. Re-export it from the source application.',
    { filePath, ...extra },
  );
}

/**
 * Why a member name is not a canonical part name, or null if it is.
 *
 * A member name is an OPC part name, and a part has exactly one spelling. The
 * spellings refused here are the ones by which one part can be reached under
 * several names -- a separator other than "/", a segment that steps sideways or
 * up, a root or a drive, a character that is not a character -- and each of them
 * is what a program that normalizes names will read as a part this reader has
 * not compared (D70). A trailing "/" is a directory entry and is allowed.
 */
function nonCanonicalReason(name: string): string | null {
  if (name === '') return 'an empty name';
  if (name.includes('\\')) return 'a backslash';
  if (name.startsWith('/')) return 'a leading slash';
  if (/^[A-Za-z]:/u.test(name)) return 'a drive letter';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(name)) return 'a control character';
  const segments = name.split('/');
  if (name.endsWith('/')) segments.pop();
  for (const segment of segments) {
    if (segment === '') return 'an empty segment';
    if (segment === '.') return 'a "." segment';
    if (segment === '..') return 'a ".." segment';
  }
  return null;
}

/**
 * The identity of the part a name addresses: percent-decoded, with the ASCII
 * letters folded. Two names with one identity are one part, whatever their
 * spelling, and a decoded form that is not canonical is refused like any other.
 */
function partIdentity(name: string): { readonly identity: string; readonly decodedProblem: string | null } {
  let decoded = name;
  try {
    decoded = name.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (run) => decodeURIComponent(run));
  } catch {
    // A percent sequence that is not UTF-8 stays as it was written.
  }
  const folded = decoded.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  return { identity: folded, decodedProblem: decoded === name ? null : nonCanonicalReason(decoded) };
}

/**
 * Read the archive's own account of what it holds, from the end, where the
 * format says the authoritative one lives.
 *
 * Written here rather than borrowed from the decompressor for one reason: the
 * borrowed one could not say **where** a member is, and a reader that knows a
 * member's size but not its position has to go looking for it -- which is the
 * search that read a shadowed copy. Every field this returns comes out of one
 * pass over one structure.
 *
 * The bomb check stays exactly where it was, before a byte is inflated, and so
 * does the refusal of two members with one name. The second is now redundant
 * against the shadowing attack and is kept anyway: an archive that names one
 * member twice is damaged whether or not this reader could pick the right copy.
 */
function readCentralDirectory(
  read: (from: number, length: number) => Uint8Array,
  size: number,
  limits: Limits,
  filePath: string,
): Map<string, EntryInfo> {
  const tailLength = Math.min(size, EOCD_MAX_BYTES);
  const tail = read(size - tailLength, tailLength);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (u32(tail, at) === 0x0605_4b50) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) throw corrupt(filePath, 'has no ZIP end-of-central-directory record, so it does not say what it holds');

  let entryCount = u16(tail, eocd + 10);
  let directorySize = u32(tail, eocd + 12);
  let directoryAt = u32(tail, eocd + 16);

  // ZIP64. The sentinels say "this number did not fit"; the real ones are in a
  // record the locator points at. A workbook large enough to need this is
  // exactly the workbook this reader exists to handle, so it is read rather
  // than refused.
  if (entryCount === 0xff_ff || directorySize === 0xff_ff_ff_ff || directoryAt === 0xff_ff_ff_ff) {
    let locator = -1;
    for (let at = eocd - 20; at >= 0; at -= 1) {
      if (u32(tail, at) === 0x0706_4b50) {
        locator = at;
        break;
      }
    }
    if (locator === -1) throw corrupt(filePath, 'declares ZIP64 sizes and carries no ZIP64 locator');
    const zip64At = u64(tail, locator + 8);
    const zip64 = read(zip64At, 56);
    if (u32(zip64, 0) !== 0x0606_4b50) throw corrupt(filePath, 'points at a ZIP64 directory record that is not one');
    entryCount = u64(zip64, 32);
    directorySize = u64(zip64, 40);
    directoryAt = u64(zip64, 48);
  }

  if (directoryAt + directorySize > size) {
    throw corrupt(filePath, 'places its central directory outside the file', { directoryAt, directorySize, size });
  }

  const directory = read(directoryAt, directorySize);
  const entries = new Map<string, EntryInfo>();
  const identities = new Map<string, string>();
  let total = 0;
  let at = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > directory.length) throw corrupt(filePath, `declares ${String(entryCount)} archive members and its directory ends after ${String(index)}`);
    if (u32(directory, at) !== 0x0201_4b50) throw corrupt(filePath, `has a damaged central directory at entry ${String(index)}`);
    const method = u16(directory, at + 10);
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    let compressedSize = u32(directory, at + 20);
    let originalSize = u32(directory, at + 24);
    let localHeaderOffset = u32(directory, at + 42);
    const flags = u16(directory, at + 8);
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      throw corrupt(
        filePath,
        `names archive member ${String(index)} with bytes that are not valid UTF-8 (the UTF-8 name flag is ${(flags & 0x800) === 0 ? 'not ' : ''}set), so it does not say which part the member is`,
        { member: index, utf8Flag: (flags & 0x800) !== 0 },
      );
    }
    const why = nonCanonicalReason(name);
    if (why !== null) {
      throw corrupt(filePath, `holds an archive member with a non-canonical name ${JSON.stringify(name)} (${why})`, {
        member: name,
        reason: why,
      });
    }
    const { identity, decodedProblem } = partIdentity(name);
    if (decodedProblem !== null) {
      throw corrupt(filePath, `holds an archive member with a non-canonical name ${JSON.stringify(name)} (once decoded it has ${decodedProblem})`, {
        member: name,
        reason: decodedProblem,
      });
    }

    // The ZIP64 extra field, in the order the format fixes: uncompressed,
    // compressed, offset -- each present only if its 32-bit field held the
    // sentinel, so the order is fixed but the membership is not.
    if (originalSize === 0xff_ff_ff_ff || compressedSize === 0xff_ff_ff_ff || localHeaderOffset === 0xff_ff_ff_ff) {
      const extraAt = at + 46 + nameLength;
      let scan = extraAt;
      while (scan + 4 <= extraAt + extraLength) {
        const tag = u16(directory, scan);
        const length = u16(directory, scan + 2);
        if (tag === 0x0001) {
          let field = scan + 4;
          if (originalSize === 0xff_ff_ff_ff) { originalSize = u64(directory, field); field += 8; }
          if (compressedSize === 0xff_ff_ff_ff) { compressedSize = u64(directory, field); field += 8; }
          if (localHeaderOffset === 0xff_ff_ff_ff) { localHeaderOffset = u64(directory, field); }
          break;
        }
        scan += 4 + length;
      }
    }

    if (entries.has(name)) {
      throw corrupt(filePath, `contains two archive members named "${name}"`, { member: name });
    }
    const aliasOf = identities.get(identity);
    if (aliasOf !== undefined) {
      throw corrupt(filePath, `holds two archive members that name one part: "${aliasOf}" and "${name}"`, {
        member: name,
        alias: aliasOf,
      });
    }
    identities.set(identity, name);

    // The local header has to say what the directory says, for every member and
    // not only the ones a relationship reaches: a member the reader never opens
    // is still a name the next program will believe.
    const localHeader = read(localHeaderOffset, 30);
    if (localHeader.length < 30 || u32(localHeader, 0) !== 0x0403_4b50) {
      throw corrupt(filePath, `places the member "${name}" where there is no local file header`, {
        member: name,
        at: localHeaderOffset,
      });
    }
    const localName = read(localHeaderOffset + 30, u16(localHeader, 26));
    if (localName.length !== nameBytes.length || !nameBytes.every((byte, offset) => localName[offset] === byte)) {
      throw corrupt(
        filePath,
        `names the member "${name}" in its directory and "${new TextDecoder('utf-8', { fatal: false }).decode(localName)}" at the offset the directory gives for it`,
        { member: name, at: localHeaderOffset },
      );
    }

    entries.set(name, { originalSize, compressedSize, localHeaderOffset, method });
    // The envelope is conjunctive: each part within the part limit, and the
    // parts together within the workbook limit. Both are read from the directory,
    // before a byte is inflated (D70).
    if (originalSize > limits.maxWorkbookPartUncompressedBytes) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${filePath} holds the part "${name}", which expands to ${String(originalSize)} bytes, above the per-part limit of ${String(limits.maxWorkbookPartUncompressedBytes)}`,
        `A single worksheet this large is not read as a workbook part. Export "${name}" as CSV, or split the workbook into files whose parts are smaller, or raise limits.maxWorkbookPartUncompressedBytes if this size is expected.`,
        {
          filePath,
          limit: 'maxWorkbookPartUncompressedBytes',
          part: name,
          allowed: limits.maxWorkbookPartUncompressedBytes,
          actual: originalSize,
        },
      );
    }
    total += originalSize;
    if (total > limits.maxWorkbookUncompressedBytes) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${filePath} expands to more than ${String(limits.maxWorkbookUncompressedBytes)} bytes`,
        'Raise limits.maxWorkbookUncompressedBytes if this workbook is genuinely this large, or split it.',
        { filePath, limit: 'maxWorkbookUncompressedBytes', allowed: limits.maxWorkbookUncompressedBytes, actual: total },
      );
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function* readFileBlocks(path: string, from: number, length: number): IterableIterator<Uint8Array> {
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(CONTAINER_BLOCK_BYTES);
  try {
    let at = from;
    let left = length;
    while (left > 0) {
      const want = Math.min(buffer.length, left);
      const read = readSync(handle, buffer, 0, want, at);
      if (read === 0) break;
      at += read;
      left -= read;
      // Copied out of the reusable buffer rather than handed over as a view of
      // it: the decompressor keeps whatever it was given until the member that
      // straddles the boundary is complete, and the next read would overwrite
      // it underneath.
      yield Uint8Array.prototype.slice.call(buffer, 0, read);
    }
  } finally {
    closeSync(handle);
  }
}

/**
 * One part of the archive, decoded, in blocks.
 *
 * The member is read from **the offset the central directory names**, not found
 * by scanning the container for a local header with a matching name. That is the
 * whole difference between this and the version that lost rows: a search finds
 * the first copy, and the first copy is not necessarily the one the archive says
 * is current. See `EntryInfo.localHeaderOffset`.
 *
 * What is held at any moment is a block of the container and a block of the
 * decoded part -- not the part, and never the archive. Reading a second part
 * seeks again, which costs a seek rather than the whole container; the version
 * before this one streamed the container from the front for every part, and the
 * version before that inflated every part up front and kept all of them.
 */
function* partBlocks(archive: Archive, name: string, filePath: string): IterableIterator<string> {
  const declared = archive.entries.get(name);
  if (declared === undefined || !isReadablePart(name)) {
    throw corrupt(filePath, `was read for a part "${name}" the archive does not offer`, { part: name });
  }
  if (declared.method !== 0 && declared.method !== 8) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} stores "${name}" with ZIP compression method ${String(declared.method)}, which this reader does not open`,
      'Re-save the workbook from the source application. A .xlsx uses stored or deflated members.',
      { filePath, part: name, method: declared.method },
    );
  }

  // The local header, read at the offset the directory gave, and checked
  // against the directory rather than trusted. A local header that names a
  // different member than the directory placed here is the disagreement this
  // whole path exists to refuse, and it is refused loudly instead of being
  // resolved in favour of either side.
  const header = archive.read(declared.localHeaderOffset, 30);
  if (header.length < 30 || u32(header, 0) !== 0x0403_4b50) {
    throw corrupt(filePath, `places the member "${name}" where there is no local file header`, {
      part: name,
      at: declared.localHeaderOffset,
    });
  }
  const nameLength = u16(header, 26);
  const extraLength = u16(header, 28);
  const localNameBytes = archive.read(declared.localHeaderOffset + 30, nameLength);
  const localName = new TextDecoder('utf-8', { fatal: false }).decode(localNameBytes);
  if (localName !== name) {
    throw corrupt(
      filePath,
      `names the member "${name}" in its directory and "${localName}" at the offset the directory gives for it`,
      { part: name, localName, at: declared.localHeaderOffset },
    );
  }

  const dataAt = declared.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataAt + declared.compressedSize > archive.size) {
    throw corrupt(filePath, `places the data of "${name}" outside the file`, { part: name, at: dataAt });
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ready: string[] = [];
  let delivered = 0;

  const take = (chunk: Uint8Array, final: boolean): void => {
    delivered += chunk.length;
    // The directory said how large this member is, and the directory is what
    // the bomb check was made against. A member that delivers more than it
    // declared is an archive contradicting itself, and believing the data over
    // the directory is how a bounded read becomes an unbounded one.
    if (delivered > declared.originalSize) {
      throw corrupt(filePath, `member "${name}" declares ${String(declared.originalSize)} bytes and delivers more`, {
        part: name,
        declaredBytes: declared.originalSize,
      });
    }
    if (chunk.length > 0) ready.push(decodePart(decoder, chunk, filePath, name, false));
    if (final) ready.push(decodePart(decoder, NO_BYTES, filePath, name, true));
  };

  if (declared.method === 0) {
    let left = declared.compressedSize;
    for (const block of archive.blocks(dataAt, declared.compressedSize)) {
      left -= block.length;
      take(block, left <= 0);
      if (ready.length > 0) yield* ready.splice(0, ready.length);
    }
    if (left > 0) throw corrupt(filePath, `declares an archive member "${name}" whose data it does not contain`, { part: name });
  } else {
    const inflate = new Inflate((chunk, final) => { take(chunk, final); });
    let left = declared.compressedSize;
    try {
      for (const block of archive.blocks(dataAt, declared.compressedSize)) {
        left -= block.length;
        // Fed in small slices. The inflater hands out whatever a slice expands
        // to in one piece, and a deflate stream can expand a thousand to one, so
        // the slice is what bounds the most that is produced before the check
        // against the declared size can refuse it.
        for (let from = 0; from < block.length; from += INFLATE_SLICE_BYTES) {
          const end = Math.min(block.length, from + INFLATE_SLICE_BYTES);
          inflate.push(block.subarray(from, end), left <= 0 && end === block.length);
        }
        if (ready.length > 0) yield* ready.splice(0, ready.length);
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw corrupt(filePath, `could not be decompressed: ${error instanceof Error ? error.message : String(error)}`, { part: name });
    }
    if (left > 0) throw corrupt(filePath, `declares an archive member "${name}" whose data it does not contain`, { part: name });
    if (ready.length > 0) yield* ready.splice(0, ready.length);
  }

  if (delivered !== declared.originalSize) {
    throw corrupt(
      filePath,
      `member "${name}" declares ${String(declared.originalSize)} bytes and delivers ${String(delivered)}`,
      { part: name, declaredBytes: declared.originalSize, deliveredBytes: delivered },
    );
  }
}

function decodePart(
  decoder: InstanceType<typeof TextDecoder>,
  bytes: Uint8Array,
  filePath: string,
  name: string,
  last: boolean,
): string {
  try {
    // `stream` keeps a character that straddles a block for the next block
    // rather than resolving it to a replacement character at a boundary, which
    // would make what the reader delivered depend on the block size.
    return decoder.decode(bytes, { stream: !last });
  } catch {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} part "${name}" is not valid UTF-8`,
      'The workbook archive is damaged. Re-export it from the source application.',
      { filePath, part: name },
    );
  }
}

/** A part small enough that holding it is not a decision: the workbook, its relationships, its styles. */
function partText(archive: Archive, name: string, filePath: string): string {
  const pieces: string[] = [];
  for (const block of partBlocks(archive, name, filePath)) pieces.push(block);
  return pieces.join('');
}

function assertNotMacroEnabled(archive: Archive, filePath: string): void {
  if (archive.entries.has('xl/vbaProject.bin')) {
    throw new MigrationError(
      'INPUT_UNSUPPORTED',
      `${filePath} contains a macro project`,
      'Save the workbook as a macro-free .xlsx and run again. This engine will not read macro-enabled workbooks.',
      { filePath, reason: 'vbaProject' },
    );
  }
  if (archive.entries.has('[Content_Types].xml')) {
    const text = partText(archive, '[Content_Types].xml', filePath);
    if (text.includes('macroEnabled')) {
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${filePath} declares a macro-enabled content type`,
        'Save the workbook as a macro-free .xlsx and run again.',
        { filePath, reason: 'contentType' },
      );
    }
  }
}

// ------------------------------------------------------------- workbook.xml

interface SheetMeta {
  readonly name: string;
  readonly relationshipId: string;
  readonly hidden: boolean;
}

interface WorkbookMeta {
  readonly sheets: readonly SheetMeta[];
  readonly dateSystem: SpreadsheetDateSystem;
}

function parseWorkbook(xml: string, filePath: string): WorkbookMeta {
  const sheets: SheetMeta[] = [];
  let dateSystem: SpreadsheetDateSystem = 'DATE_1900';

  for (const event of parseXml(xml, `${filePath}!xl/workbook.xml`)) {
    if (event.kind !== 'start') continue;
    const tag = localName(event.name);
    if (tag === 'workbookPr') {
      const flag = event.attributes['date1904'];
      if (flag === '1' || flag === 'true') dateSystem = 'DATE_1904';
    }
    if (tag === 'sheet') {
      const name = event.attributes['name'];
      const relationshipId = findRelationshipId(event.attributes);
      if (name === undefined || relationshipId === null) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${filePath} declares a sheet without a name or relationship id`,
          'The workbook is damaged. Re-export it from the source application.',
          { filePath },
        );
      }
      const state = event.attributes['state'];
      sheets.push({ name, relationshipId, hidden: state === 'hidden' || state === 'veryHidden' });
    }
  }

  if (sheets.length === 0) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${filePath} declares no worksheets`,
      'The workbook is empty or damaged. Re-export it from the source application.',
      { filePath },
    );
  }
  return { sheets, dateSystem };
}

function findRelationshipId(attributes: Readonly<Record<string, string>>): string | null {
  for (const [key, value] of Object.entries(attributes)) {
    if (localName(key) === 'id') return value;
  }
  return null;
}

function parseRelationships(xml: string, filePath: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const event of parseXml(xml, `${filePath}!xl/_rels/workbook.xml.rels`)) {
    if (event.kind !== 'start' || localName(event.name) !== 'Relationship') continue;
    const id = event.attributes['Id'];
    const target = event.attributes['Target'];
    if (id !== undefined && target !== undefined) relationships.set(id, target);
  }
  return relationships;
}

/** Relationship targets are relative to `xl/`, but some writers emit absolute part names. */
function normalizePart(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  if (target.startsWith('xl/')) return target;
  return `xl/${target}`;
}

// --------------------------------------------------------- sharedStrings.xml

/**
 * The workbook's shared strings, addressed by index.
 *
 * A worksheet cell of type `s` is an index into this table, so the table has to
 * be answerable while any sheet is being read. What it must not be is a
 * `string[]`: a real Excel export writes every distinct text value here, so at
 * a million rows that array is a million JS strings, each carrying an object
 * header and an eight-byte slot before a single character of the customer's
 * data. The text itself is unavoidable; the per-string overhead is not.
 *
 * So the text is kept as a handful of long strings and the table is three
 * typed arrays saying which of them a given index lives in and where. Twelve
 * bytes an entry instead of forty-odd, no per-string object for the collector to
 * walk, and `at` returns exactly the characters `<si>` held.
 */
interface SharedStrings {
  readonly count: number;
  at(index: number): string | undefined;
}

const NO_SHARED_STRINGS: SharedStrings = { count: 0, at: () => undefined };

/**
 * Characters per segment. Long enough that the per-segment cost is noise, short
 * enough that no single one approaches V8's maximum string length -- a table
 * kept as one string would refuse a workbook this reader could otherwise read.
 */
const SHARED_STRING_SEGMENT_CHARS = 1 << 20;

function readSharedStrings(chunks: Iterable<string>, filePath: string): SharedStrings {
  const segments: string[] = [];
  let pending: string[] = [];
  let pendingChars = 0;
  let segmentOf: Uint32Array = new Uint32Array(1024);
  let startsAt: Uint32Array = new Uint32Array(1024);
  let endsAt: Uint32Array = new Uint32Array(1024);
  let count = 0;

  const grown = (from: Uint32Array): Uint32Array => {
    const out = new Uint32Array(from.length * 2);
    out.set(from);
    return out;
  };

  const add = (value: string): void => {
    if (count === segmentOf.length) {
      segmentOf = grown(segmentOf);
      startsAt = grown(startsAt);
      endsAt = grown(endsAt);
    }
    if (pendingChars > 0 && pendingChars + value.length > SHARED_STRING_SEGMENT_CHARS) {
      segments.push(pending.join(''));
      pending = [];
      pendingChars = 0;
    }
    segmentOf[count] = segments.length;
    startsAt[count] = pendingChars;
    endsAt[count] = pendingChars + value.length;
    pending.push(value);
    pendingChars += value.length;
    count += 1;
  };

  let current: string[] | null = null;
  let inText = false;
  let inPhonetic = false;

  for (const event of parseXmlChunks(chunks, `${filePath}!xl/sharedStrings.xml`)) {
    if (event.kind === 'start') {
      const tag = localName(event.name);
      if (tag === 'si') {
        current = [];
        if (event.selfClosing) {
          add('');
          current = null;
        }
      } else if (tag === 'rPh') {
        inPhonetic = true;
      } else if (tag === 't') {
        inText = !inPhonetic;
        if (event.selfClosing) inText = false;
      }
      continue;
    }
    if (event.kind === 'end') {
      const tag = localName(event.name);
      if (tag === 'si' && current !== null) {
        add(current.join(''));
        current = null;
      } else if (tag === 'rPh') {
        inPhonetic = false;
      } else if (tag === 't') {
        inText = false;
      }
      continue;
    }
    if (inText && current !== null) current.push(event.text);
  }

  segments.push(pending.join(''));
  pending = [];

  return {
    count,
    at(index: number): string | undefined {
      if (!Number.isInteger(index) || index < 0 || index >= count) return undefined;
      const segment = segments[segmentOf[index] as number] as string;
      return segment.slice(startsAt[index] as number, endsAt[index] as number);
    },
  };
}

// ---------------------------------------------------------------- styles.xml

/** Number format code for each cell format index, or `null` when the format is not a date. */
function parseStyles(xml: string, filePath: string): (string | null)[] {
  const custom = new Map<number, string>();
  const cellFormats: (string | null)[] = [];
  let inCellXfs = false;

  for (const event of parseXml(xml, `${filePath}!xl/styles.xml`)) {
    if (event.kind === 'end') {
      if (localName(event.name) === 'cellXfs') inCellXfs = false;
      continue;
    }
    if (event.kind !== 'start') continue;
    const tag = localName(event.name);
    if (tag === 'numFmt') {
      const id = Number.parseInt(event.attributes['numFmtId'] ?? '', 10);
      const code = event.attributes['formatCode'];
      if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
      continue;
    }
    if (tag === 'cellXfs') {
      inCellXfs = true;
      continue;
    }
    if (tag === 'xf' && inCellXfs) {
      const id = Number.parseInt(event.attributes['numFmtId'] ?? '0', 10);
      const code = custom.get(id);
      if (code !== undefined) {
        cellFormats.push(looksLikeDateFormat(code) ? code : null);
      } else {
        cellFormats.push(BUILTIN_DATE_FORMATS.has(id) ? `builtin:${String(id)}` : null);
      }
    }
  }
  return cellFormats;
}

/**
 * Decides whether a custom number format code describes a date. Quoted literals
 * and bracketed sections are removed first so that a currency symbol such as
 * `[$$-409]` or the literal text `"day"` cannot be mistaken for date tokens.
 */
export function looksLikeDateFormat(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/gu, '')
    .replace(/\[[^\]]*\]/gu, '')
    .replace(/\\./gu, '');
  return /[yYdDhHsS]/u.test(stripped) || /m{3,}/u.test(stripped) || /(^|[^a-zA-Z])m{1,2}([/-]|$)/u.test(stripped);
}

// ------------------------------------------------------------- worksheet xml

/**
 * A worksheet's rows, one at a time.
 *
 * The same state machine that used to fill a `WorkbookRow[]`, with the array
 * taken out: a completed row is handed to the caller and then forgotten. Every
 * refusal it made it still makes, in the same order over the document, and two
 * that used to run over the finished array now run as each row finishes --
 * which is the earliest point at which they can be asked, and the same first
 * offending row either way.
 *
 * The independent census reads the same blocks the parser is given, exactly as
 * the CSV reader feeds `CsvCensus`, and is checked when the sheet ends. It is
 * not asked when a caller abandons the walk part way through, because a walk
 * that was stopped is not a walk that lost rows; the pass that establishes the
 * sheet's row count always runs to the end.
 */
function* streamWorksheet(
  chunks: Iterable<string>,
  sharedStrings: SharedStrings,
  numberFormats: readonly (string | null)[],
  limits: Limits,
  filePath: string,
  sheetName: string,
): IterableIterator<WorkbookRow> {
  const origin = `${filePath}!${sheetName}`;
  const census = createWorksheetRowCensus();
  const counted = function* (): IterableIterator<string> {
    for (const block of chunks) {
      census.push(block);
      yield block;
    }
    census.end();
  };

  let produced = 0;
  /** Rows that actually left this generator, counted after the yield resumed. */
  let handedOut = 0;
  let inSheetData = false;
  let inRow = false;
  const seenRowNumbers = new Set<number>();
  let highestRowNumber = 0;
  const seenColumnIndexes = new Set<number>();
  let rowNumber = 0;
  let cells: WorkbookCell[] = [];
  let nextColumnIndex = 0;

  let cellColumnIndex = 0;
  let cellType = '';
  let cellFormat: string | null = null;
  let cellFormula: string | null = null;
  let valueParts: string[] | null = null;
  let inValue = false;
  let inFormula = false;
  let inInlineText = false;
  let inlineParts: string[] | null = null;
  let openCell = false;

  const finishCell = (): void => {
    if (!openCell) return;
    openCell = false;
    const rawValue =
      inlineParts !== null ? inlineParts.join('') : valueParts === null ? null : valueParts.join('');
    cells.push(materializeCell(cellColumnIndex, cellType, rawValue, cellFormula, cellFormat, sharedStrings, origin));
    valueParts = null;
    inlineParts = null;
    cellFormula = null;
    cellFormat = null;
    cellType = '';
  };

  const finishRow = (row: WorkbookRow): WorkbookRow => {
    for (const cell of row.cells) {
      if (cell.raw !== null && cell.raw.length > limits.maxCellLength) {
        throw new MigrationError(
          'INPUT_LIMIT_EXCEEDED',
          `${origin} row ${String(row.rowNumber)} has a cell of ${String(cell.raw.length)} characters, above the limit of ${String(limits.maxCellLength)}`,
          'Raise limits.maxCellLength if this data is expected, or repair the source file.',
          { filePath, sheet: sheetName, limit: 'maxCellLength', allowed: limits.maxCellLength },
        );
      }
    }
    produced += 1;
    if (produced > limits.maxRowsPerSheet) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${origin} has more than ${String(limits.maxRowsPerSheet)} rows`,
        'Raise limits.maxRowsPerSheet if this data is expected, or split the sheet.',
        { filePath, sheet: sheetName, limit: 'maxRowsPerSheet', allowed: limits.maxRowsPerSheet },
      );
    }
    return row;
  };

  for (const event of parseXmlChunks(counted(), origin)) {
    if (event.kind === 'start') {
      const tag = localName(event.name);
      if (tag === 'sheetData') {
        inSheetData = true;
        if (event.selfClosing) inSheetData = false;
        continue;
      }
      if (!inSheetData) {
        // Silently skipping these produced a partial workbook: rows outside
        // sheetData were read by no one, counted by no one and reported by no
        // one, and the row equation held because both sides came from the
        // reader's own output.
        if (tag === 'row' || tag === 'c') {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} has a <${tag}> element outside <sheetData>`,
            'The worksheet is not laid out the way the format requires. Re-export the workbook from the source application.',
            { filePath, sheet: sheetName, element: tag },
          );
        }
        continue;
      }

      if (tag === 'row') {
        if (inRow) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} opens a row while row ${String(rowNumber)} is still open`,
            'The workbook archive is damaged. Re-export it from the source application.',
            { filePath, sheet: sheetName, rowNumber },
          );
        }
        const declaredRow = event.attributes['r'];
        if (declaredRow !== undefined && !/^[0-9]+$/u.test(declaredRow)) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} has a row whose position is "${declaredRow}", which is not a row number`,
            'The workbook archive is damaged. Re-export it from the source application.',
            { filePath, sheet: sheetName, declaredRow },
          );
        }
        rowNumber = declaredRow === undefined ? rowNumber + 1 : Number.parseInt(declaredRow, 10);
        // Two rows claiming the same position would produce two records with one
        // locator, which the reconciliation would later report as an engine
        // defect. It is a damaged file, so say so here.
        if (seenRowNumbers.has(rowNumber)) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} declares row ${String(rowNumber)} more than once`,
            'The workbook archive is damaged. Re-export it from the source application.',
            { filePath, sheet: sheetName, rowNumber },
          );
        }
        if (rowNumber < highestRowNumber) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} declares row ${String(rowNumber)} after row ${String(highestRowNumber)}`,
            'Rows have to appear in position order; out of order, the first row of the sheet is not the header row. Re-export the workbook from the source application.',
            { filePath, sheet: sheetName, rowNumber, previousRowNumber: highestRowNumber },
          );
        }
        highestRowNumber = rowNumber;
        seenRowNumbers.add(rowNumber);
        cells = [];
        seenColumnIndexes.clear();
        nextColumnIndex = 0;
        inRow = !event.selfClosing;
        if (event.selfClosing) {
          yield finishRow({ rowNumber, cells: [] });
          handedOut += 1;
        }
        continue;
      }

      if (tag === 'c') {
        if (!inRow) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} has a cell outside any row`,
            'The workbook archive is damaged. Re-export it from the source application.',
            { filePath, sheet: sheetName },
          );
        }
        finishCell();
        const reference = event.attributes['r'];
        cellColumnIndex = reference === undefined ? nextColumnIndex : columnIndexFromReference(reference, origin);
        if (seenColumnIndexes.has(cellColumnIndex)) {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${origin} row ${String(rowNumber)} declares column ${String(cellColumnIndex + 1)} more than once`,
            'The workbook archive is damaged. Re-export it from the source application.',
            { filePath, sheet: sheetName, rowNumber, columnIndex: cellColumnIndex },
          );
        }
        seenColumnIndexes.add(cellColumnIndex);
        nextColumnIndex = cellColumnIndex + 1;
        cellType = event.attributes['t'] ?? 'n';
        const styleIndex = Number.parseInt(event.attributes['s'] ?? '', 10);
        cellFormat = Number.isInteger(styleIndex) ? (numberFormats[styleIndex] ?? null) : null;
        cellFormula = null;
        valueParts = null;
        inlineParts = null;
        openCell = true;
        if (cellColumnIndex >= limits.maxColumnsPerSheet) {
          throw new MigrationError(
            'INPUT_LIMIT_EXCEEDED',
            `${origin} uses column ${String(cellColumnIndex + 1)}, above the limit of ${String(limits.maxColumnsPerSheet)}`,
            'Raise limits.maxColumnsPerSheet if this data is expected, or trim the sheet.',
            { filePath, sheet: sheetName, limit: 'maxColumnsPerSheet', allowed: limits.maxColumnsPerSheet },
          );
        }
        if (event.selfClosing) finishCell();
        continue;
      }

      if (tag === 'v') {
        valueParts = [];
        inValue = !event.selfClosing;
        continue;
      }
      if (tag === 'f') {
        cellFormula = '';
        inFormula = !event.selfClosing;
        continue;
      }
      if (tag === 'is') {
        inlineParts = [];
        continue;
      }
      if (tag === 't' && inlineParts !== null) {
        inInlineText = !event.selfClosing;
        continue;
      }
      continue;
    }

    if (event.kind === 'end') {
      const tag = localName(event.name);
      if (tag === 'sheetData') {
        inSheetData = false;
        continue;
      }
      if (!inSheetData) continue;
      if (tag === 'c') {
        finishCell();
        continue;
      }
      if (tag === 'row') {
        finishCell();
        inRow = false;
        yield finishRow({ rowNumber, cells });
        handedOut += 1;
        continue;
      }
      if (tag === 'v') inValue = false;
      if (tag === 'f') inFormula = false;
      if (tag === 't') inInlineText = false;
      continue;
    }

    if (inValue && valueParts !== null) valueParts.push(event.text);
    else if (inFormula) cellFormula = (cellFormula ?? '') + event.text;
    else if (inInlineText && inlineParts !== null) inlineParts.push(event.text);
  }

  // The same second opinion the CSV path gets: <row> elements counted in the
  // worksheet bytes, by a scanner that shares no code with this one.
  //
  // The operand is `handedOut`, not `produced`, and the difference is the whole
  // point of the check. `produced` is this function's own tally, incremented in
  // `finishRow`; comparing it against the census asks "does my count match",
  // which a reader that lost a row before yielding it would answer yes to.
  // `handedOut` is incremented immediately after each `yield`, so it counts rows
  // that actually left this generator. The materialising reader compared
  // `rows.length` — the array it had really built — and that property is what is
  // being kept here rather than traded for a counter.
  //
  // The two are compared as well. A row that was validated and never handed out
  // is a reader defect rather than a damaged workbook, and it is reported as
  // one.
  if (handedOut !== produced) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${origin} read ${String(produced)} rows and handed out ${String(handedOut)}`,
      'This is a defect in the engine rather than in the workbook. Report it with the configuration that produced it.',
      { filePath, sheet: sheetName, produced, handedOut },
    );
  }
  assertCensusAgrees(handedOut, census.total(), origin, { filePath, sheet: sheetName });
}

function materializeCell(
  columnIndex: number,
  type: string,
  rawValue: string | null,
  formula: string | null,
  numberFormat: string | null,
  sharedStrings: SharedStrings,
  origin: string,
): WorkbookCell {
  const cell = materializeTypedCell(columnIndex, type, rawValue, formula, numberFormat, sharedStrings, origin);
  // A `<v>` element is what a cache is, and an empty one is an empty string. No
  // `<v>` at all means nothing was stored. Decided here from the element, not
  // from the text, so `<v></v>` and a missing `<v>` can never be confused.
  return { ...cell, cachedValue: formula === null ? null : rawValue === null ? 'ABSENT' : 'PRESENT' };
}

function materializeTypedCell(
  columnIndex: number,
  type: string,
  rawValue: string | null,
  formula: string | null,
  numberFormat: string | null,
  sharedStrings: SharedStrings,
  origin: string,
): Omit<WorkbookCell, 'cachedValue'> {
  switch (type) {
    case 's': {
      if (rawValue === null) {
        return { columnIndex, raw: null, kind: 'XLSX_SHARED_STRING', formula, numberFormat: null };
      }
      // A shared-string reference must be a plain non-negative integer. Anything
      // `parseInt` would salvage (`0x1`, `1abc`, ` 1 `) would deliver a
      // different cell's text than the workbook meant.
      if (!/^[0-9]+$/u.test(rawValue)) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${origin} has a shared-string reference of "${rawValue}", which is not an index`,
          'The workbook archive is damaged. Re-export it from the source application.',
          { origin, sharedStringIndex: rawValue },
        );
      }
      const value = sharedStrings.at(Number.parseInt(rawValue, 10));
      if (value === undefined) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${origin} references shared string ${rawValue}, which the workbook does not define`,
          'The workbook archive is inconsistent. Re-export it from the source application.',
          { origin, sharedStringIndex: rawValue },
        );
      }
      return { columnIndex, raw: value, kind: 'XLSX_SHARED_STRING', formula, numberFormat: null };
    }
    case 'inlineStr':
      return { columnIndex, raw: rawValue, kind: 'XLSX_INLINE_STRING', formula, numberFormat: null };
    case 'str':
      // A formula whose cached result is text.
      return { columnIndex, raw: rawValue, kind: 'XLSX_INLINE_STRING', formula, numberFormat: null };
    case 'b': {
      if (rawValue === null) {
        return { columnIndex, raw: null, kind: 'XLSX_BOOLEAN', formula, numberFormat: null };
      }
      // Only 0 and 1 are booleans. Reading anything else as FALSE would invent a
      // definite answer from a value the workbook does not define.
      if (rawValue !== '0' && rawValue !== '1') {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${origin} has a boolean cell holding "${rawValue}", which is neither 0 nor 1`,
          'The workbook archive is damaged. Re-export it from the source application.',
          { origin, value: rawValue },
        );
      }
      return {
        columnIndex,
        raw: rawValue === '1' ? 'TRUE' : 'FALSE',
        kind: 'XLSX_BOOLEAN',
        formula,
        numberFormat: null,
      };
    }
    case 'd':
      // ST_CellType defines "d" as an ISO-8601 date held as text. Strict-OOXML
      // writers emit it. It is read as the text it is, never reinterpreted.
      return { columnIndex, raw: rawValue, kind: 'XLSX_INLINE_STRING', formula, numberFormat: null };
    case 'e':
      return { columnIndex, raw: rawValue, kind: 'XLSX_ERROR', formula, numberFormat: null };
    case 'n':
      return { columnIndex, raw: rawValue, kind: 'XLSX_NUMBER', formula, numberFormat };
    default:
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${origin} has a cell of type "${type}", which this reader does not understand`,
        'Re-export the workbook from the source application. The engine will not guess what an unknown cell type means.',
        { origin, cellType: type },
      );
  }
}

/** `AB12` -> 27. Rejects references the reader does not understand rather than guessing a position. */
export function columnIndexFromReference(reference: string, origin: string): number {
  let index = 0;
  let consumed = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      index = index * 26 + (code - 64);
      consumed += 1;
      continue;
    }
    if (code >= 97 && code <= 122) {
      index = index * 26 + (code - 96);
      consumed += 1;
      continue;
    }
    break;
  }
  if (consumed === 0) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${origin} contains the cell reference "${reference}", which has no column letters`,
      'The workbook is damaged. Re-export it from the source application.',
      { origin, reference },
    );
  }
  return index - 1;
}
