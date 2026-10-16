import { realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import type { FileConfig, Limits, MigrationConfig, OccurrenceDeclaration } from '../domain/config.js';
import type { ColumnLocator, FileLocator, SheetLocator } from '../domain/locators.js';
import { makeFileId, makeOccurrenceFileId, makeSheetId } from '../domain/locators.js';
import type { SourceCell, SourceRow } from '../domain/source-cell.js';
import { isBlankRow } from '../domain/source-cell.js';
import { sha256Hex } from '../util/hash.js';
import { invariant } from '../util/assert.js';
import { assertCensusAgrees, createCsvCensus } from './row-census.js';

import { createCsvScanner } from './csv-reader.js';
import { openWorkbookFile } from './xlsx-reader.js';
import type { WorkbookRow } from './xlsx-reader.js';
import { digestOf, openSourceText } from './read-source-file.js';
import type { IngestedBundle, IngestedFile, IngestedSheet, RejectedRow, SheetEvidence } from './sheet.js';
import { buildColumns, makeRowLocator, makeSourceRow } from './sheet.js';

export interface IngestOptions {
  readonly inputRoot: string;
  readonly config: MigrationConfig;
  /**
   * Bytes per read of a CSV file. The default is the one the engine runs with;
   * a smaller value changes how the file is cut and must never change what it
   * says, which is what makes it useful to a test.
   */
  readonly blockBytes?: number;
}

export function ingestBundle(options: IngestOptions): IngestedBundle {
  const { config, inputRoot } = options;

  if (config.files.length > config.limits.maxFiles) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the configuration lists ${String(config.files.length)} files, above the limit of ${String(config.limits.maxFiles)}`,
      'Raise limits.maxFiles if this is expected, or split the migration.',
      { limit: 'maxFiles', allowed: config.limits.maxFiles, actual: config.files.length },
    );
  }

  const root = resolve(inputRoot);
  const loaded = config.files.map((fileConfig) => locateFile(root, fileConfig, config.limits));

  const totalBytes = loaded.reduce((sum, entry) => sum + entry.byteLength, 0);
  if (totalBytes > config.limits.maxTotalBytes) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `the input bundle is ${String(totalBytes)} bytes, above the limit of ${String(config.limits.maxTotalBytes)}`,
      'Raise limits.maxTotalBytes if this is expected, or split the migration.',
      { limit: 'maxTotalBytes', allowed: config.limits.maxTotalBytes, actual: totalBytes },
    );
  }

  // Streamed, one file at a time. The digest is the identity of a file, and
  // computing it used to mean holding every file in the bundle at once.
  const digests = loaded.map((entry) => digestOf(entry.path));
  const occurrences = inventoryOccurrences(config, digests);
  assertNoFileIdCollision(config.files, occurrences.fileIds);

  const bundleId = computeBundleId(config.files, digests);

  const files: IngestedFile[] = loaded.map((entry, index) => {
    const digest = digests[index] as string;
    const fileConfig = entry.config;
    const fileId = occurrences.fileIds[index] as string;
    const ingested =
      fileConfig.format === 'CSV'
        ? ingestCsvFile(bundleId, fileId, fileConfig, entry.path, digest, config, options.blockBytes)
        : ingestWorkbookFile(bundleId, fileId, fileConfig, entry.path, entry.byteLength, digest, config);
    return applyOccurrence(ingested, occurrences.notes[index] as OccurrenceNotes);
  });

  return { bundleId, files };
}

/**
 * Where a configured file is and how big it is -- and not its contents.
 *
 * Every check this used to make is still made here, because they are the
 * checks that decide whether the file may be read at all: it must resolve
 * inside the input directory even through a junction, it must exist, and it
 * must be within the per-file limit. What has changed is that the answer is a
 * path rather than the bytes at it.
 */
interface LocatedFile {
  readonly config: FileConfig;
  readonly path: string;
  readonly byteLength: number;
}

function locateFile(root: string, fileConfig: FileConfig, limits: Limits): LocatedFile {
  const absolute = join(root, ...fileConfig.path.split('/'));
  // The real path, not the lexical one: a junction or symlink inside the input
  // directory otherwise reads bytes from outside it while the package records a
  // path they did not come from.
  const resolved = realPathOrSelf(resolve(absolute));
  const realRoot = realPathOrSelf(root);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `file "${fileConfig.id}" resolves outside the input bundle`,
      'Use a relative path that stays inside the input directory.',
      { fileId: fileConfig.id, path: fileConfig.path },
    );
  }

  let size: number;
  try {
    size = statSync(resolved).size;
  } catch {
    throw new MigrationError(
      'INPUT_NOT_FOUND',
      `input file "${fileConfig.path}" was not found under the input directory`,
      'Check the path in the configuration and that the file is present in the input bundle.',
      { fileId: fileConfig.id, path: fileConfig.path },
    );
  }

  if (size > limits.maxBytesPerFile) {
    throw new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${fileConfig.path} is ${String(size)} bytes, above the per-file limit of ${String(limits.maxBytesPerFile)}`,
      'Raise limits.maxBytesPerFile if this is expected, or split the file.',
      { fileId: fileConfig.id, limit: 'maxBytesPerFile', allowed: limits.maxBytesPerFile, actual: size },
    );
  }

  return { config: fileConfig, path: resolved, byteLength: size };
}

/**
 * What the plan and the bytes together say about each file as an occurrence.
 *
 * An occurrence is a file at a path, in a source namespace, at a place in the
 * plan. Its digest is evidence about what it holds: it can say two occurrences
 * are copies of one another, and it is never allowed to make them one. So
 * nothing here removes a file because of its digest (D69):
 *
 * - equal bytes in different namespaces are two occurrences. Both are read, both
 *   stay in the lineage under ids of their own, and each is flagged;
 * - equal bytes inside one namespace would double every row they hold if they
 *   were two exports of different things, and would be counted once if one is a
 *   copy. The engine cannot tell which, so it stops until the plan declares it.
 */
interface OccurrenceNotes {
  /** Facts about the file that are not decisions: which other occurrences hold the same bytes. */
  readonly equalTo: readonly string[];
  /** The plan's decision covering this file, if any. */
  readonly decision: {
    readonly kind: 'INDEPENDENT' | 'EXCLUDE_ONE';
    readonly keeps: string;
    readonly siblings: readonly string[];
    readonly excluded: boolean;
  } | null;
}

interface OccurrenceInventory {
  readonly fileIds: readonly string[];
  readonly notes: readonly OccurrenceNotes[];
}

function inventoryOccurrences(config: MigrationConfig, digests: readonly string[]): OccurrenceInventory {
  const files = config.files;
  const namespaceOf = (file: FileConfig): string => file.sourceNamespace ?? config.source.namespace;

  const byDigest = new Map<string, number[]>();
  digests.forEach((digest, index) => {
    const group = byDigest.get(digest);
    if (group === undefined) byDigest.set(digest, [index]);
    else group.push(index);
  });

  // A file whose bytes are unique keeps the id its digest gives it. Files that
  // share bytes take their ids from the digest and the path, so that they have
  // locators of their own.
  const fileIds = digests.map((digest, index) => {
    const shared = (byDigest.get(digest) ?? []).length > 1;
    return shared ? makeOccurrenceFileId(digest, (files[index] as FileConfig).path) : makeFileId(digest);
  });

  const declarationOf = new Map<string, { readonly declaration: OccurrenceDeclaration; readonly index: number }>();
  config.occurrences.forEach((declaration, index) => {
    const ids = declaration.files;
    const first = files.findIndex((file) => file.id === ids[0]);
    for (const id of ids) {
      const at = files.findIndex((file) => file.id === id);
      if (at === -1 || first === -1 || digests[at] !== digests[first]) {
        throw new MigrationError(
          'CONFIG_INVALID',
          `occurrences[${String(index)}] covers files with different bytes: ${ids.map((name) => `"${name}"`).join(', ')}`,
          'A decision about equal bytes can only name files whose bytes are equal. Remove the file that differs, or correct the decision.',
          { occurrence: index, files: [...ids] },
        );
      }
      declarationOf.set(id, { declaration, index });
    }
  });

  const notes: OccurrenceNotes[] = files.map((file, index) => {
    const others = (byDigest.get(digests[index] as string) ?? []).filter((other) => other !== index);
    const equalTo = others.map(
      (other) => `${(files[other] as FileConfig).path} (namespace ${namespaceOf(files[other] as FileConfig)})`,
    );
    const declared = declarationOf.get(file.id);
    if (declared === undefined) return { equalTo, decision: null };
    const { declaration } = declared;
    const listed = declaration.files.map((id) => (files.find((candidate) => candidate.id === id) as FileConfig).path);
    const keeps = listed[0] as string;
    return {
      equalTo,
      decision: {
        kind: declaration.decision,
        keeps,
        siblings: listed.filter((path) => path !== file.path),
        excluded: declaration.decision === 'EXCLUDE_ONE' && file.path !== keeps,
      },
    };
  });

  // The stop. Inside one namespace, every file that shares bytes must be covered
  // by one decision.
  for (const group of byDigest.values()) {
    if (group.length < 2) continue;
    const byNamespace = new Map<string, number[]>();
    for (const index of group) {
      const namespace = namespaceOf(files[index] as FileConfig);
      const members = byNamespace.get(namespace);
      if (members === undefined) byNamespace.set(namespace, [index]);
      else members.push(index);
    }
    for (const [namespace, members] of byNamespace) {
      if (members.length < 2) continue;
      const decided = new Set(members.map((index) => declarationOf.get((files[index] as FileConfig).id)?.index));
      if (decided.size === 1 && !decided.has(undefined)) continue;
      const paths = members.map((index) => (files[index] as FileConfig).path);
      throw new MigrationError(
        'INPUT_DUPLICATE_FILE',
        `${paths.map((path) => `"${path}"`).join(' and ')} are byte-identical occurrences in source namespace "${namespace}" and the plan declares no occurrence decision for them`,
        'Ingesting the same bytes twice would double every row they contain, and dropping one would hide a source. Add an "occurrences" entry naming these file ids with decision INDEPENDENT (each is its own export) or EXCLUDE_ONE (keep the first listed and reject the rest), or give the files their own sourceNamespace if they come from different instances.',
        {
          namespace,
          occurrences: paths,
          fileIds: members.map((index) => (files[index] as FileConfig).id),
          sha256: digests[members[0] as number] as string,
        },
      );
    }
  }

  return { fileIds, notes };
}

/** Says what is known about a file's place among equal files, and acts on the decision the plan made. */
function applyOccurrence(ingested: IngestedFile, notes: OccurrenceNotes): IngestedFile {
  if (notes.equalTo.length === 0 && notes.decision === null) return ingested;
  const extra: SheetEvidence[] = [];
  if (notes.equalTo.length > 0) {
    extra.push({
      kind: 'FILE_EQUAL_BYTES_OTHER_OCCURRENCE',
      detail: `another occurrence holds the same bytes: ${notes.equalTo.join('; ')}. Equal bytes are evidence, not identity; this file keeps locators of its own`,
    });
  }
  const decision = notes.decision;
  if (decision !== null) {
    extra.push({
      kind: 'OCCURRENCE_DECISION',
      detail:
        decision.kind === 'INDEPENDENT'
          ? `INDEPENDENT: declared in the plan with ${decision.siblings.join(', ')}; each is its own export`
          : decision.excluded
            ? `EXCLUDE_ONE: declared in the plan; ${decision.keeps} is the occurrence kept and this file is excluded`
            : `EXCLUDE_ONE: declared in the plan; this file is the occurrence kept and ${decision.siblings.join(', ')} ${decision.siblings.length === 1 ? 'is' : 'are'} excluded`,
    });
  }

  const sheets = ingested.sheets.map((sheet): IngestedSheet => {
    const evidence = [...sheet.evidence, ...extra];
    if (decision === null || !decision.excluded) return { ...sheet, evidence };

    // Every row of an excluded occurrence is rejected input, by name. The rows
    // the reader accepted and the rows it had already rejected get the same
    // reason, because the file is what was excluded and not the row.
    const detail = `the file ${ingested.file.filePathRelative} is excluded as a copy of ${decision.keeps} (occurrences: EXCLUDE_ONE)`;
    const rejected: RejectedRow[] = [];
    for (const row of sheet.rows) {
      rejected.push({ locator: row.locator, reasonCode: 'INGEST_OCCURRENCE_EXCLUDED', detail });
    }
    for (const row of sheet.rejectedRows) {
      rejected.push({
        locator: row.locator,
        reasonCode: 'INGEST_OCCURRENCE_EXCLUDED',
        detail: `${detail}; the reader had also rejected it as ${row.reasonCode}`,
      });
    }
    rejected.sort((left, right) => left.locator.rowNumberSource - right.locator.rowNumberSource);
    return { ...sheet, dataRowCount: 0, rows: [], rejectedRows: rejected, evidence };
  });
  for (const sheet of sheets) assertRowsAccountedFor(sheet, ingested.file.filePathRelative);
  return { file: ingested.file, sheets };
}

function assertNoFileIdCollision(files: readonly FileConfig[], fileIds: readonly string[]): void {
  const seen = new Map<string, string>();
  fileIds.forEach((shortId, index) => {
    const fileConfig = files[index] as FileConfig;
    const previous = seen.get(shortId);
    if (previous !== undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `"${fileConfig.path}" and "${previous}" produce the same short file id ${shortId}`,
        'This is astronomically unlikely and indicates a damaged input. Re-export the files.',
        { fileId: shortId, path: fileConfig.path, other: previous },
      );
    }
    seen.set(shortId, fileConfig.path);
  });
}

/**
 * Deterministic bundle id over the sorted (path, digest) pairs; identical inputs
 * always yield the same id.
 *
 * Exported so a source profile can be checked against it: a profile states the
 * bundle id it describes and the files it read, and a reader that recomputes the
 * id from the files can refuse a profile whose two statements disagree.
 */
export function computeBundleId(files: readonly { readonly path: string }[], digests: readonly string[]): string {
  const pairs = files
    .map((file, index) => `${file.path}:${digests[index] as string}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `B-${sha256Hex(pairs.join('\n')).slice(0, 16)}`;
}

// ------------------------------------------------------------------- CSV

/**
 * A CSV file, read in blocks and never held.
 *
 * The shape of the sheet -- its header, its columns, how many rows the reader
 * produced, which of them were rejected -- comes from one streaming pass. The
 * rows themselves are not kept: `rows` reads the file again, which is what lets
 * relationships walk a sheet a second time without either pass holding the
 * other's rows.
 *
 * The census is fed from the same blocks as the reader and shares no code with
 * it, so "rows read" is still two independent counts of the same bytes rather
 * than the reader agreeing with itself.
 */
function ingestCsvFile(
  bundleId: string,
  fileId: string,
  fileConfig: FileConfig,
  path: string,
  digest: string,
  config: MigrationConfig,
  blockBytes: number | undefined,
): IngestedFile {
  const text = openSourceText(path, fileConfig.encoding ?? config.source.encoding, fileConfig.path, blockBytes);
  const delimiter = fileConfig.delimiter ?? ',';

  const file: FileLocator = {
    bundleId,
    fileId,
    fileSha256: digest,
    fileNameOriginal: baseName(fileConfig.path),
    filePathRelative: fileConfig.path,
    fileByteLength: text.byteLength,
    format: 'CSV',
    encoding: text.encoding,
    encodingEvidence: text.evidence,
  };

  const sheet: SheetLocator = {
    fileId: file.fileId,
    sheetId: makeSheetId(0),
    sheetIndex: 0,
    sheetName: null,
    hidden: false,
  };

  const options = {
    delimiter,
    filePath: fileConfig.path,
    maxCellLength: config.limits.maxCellLength,
    maxRecordBytes: config.limits.maxRecordBytes,
    maxColumns: config.limits.maxColumnsPerSheet,
    maxRows: config.limits.maxRowsPerSheet,
  };

  // ------------------------------------------------------------- the shape
  let headerRowNumber: number | null = null;
  let columns: ColumnLocator[] = [];
  let readerRowCount = 0;
  let dataRowCount = 0;
  const rejectedRows: RejectedRow[] = [];
  let records = 0;

  const census = createCsvCensus();
  const scanner = createCsvScanner(options, (recordNumber, fields) => {
    records += 1;
    if (headerRowNumber === null) {
      headerRowNumber = recordNumber;
      columns = buildColumns(fields, file.fileId, sheet.sheetId);
      return;
    }
    readerRowCount += 1;
    const outcome = classifyCsvRecord(recordNumber, fields, columns, sheet, fileConfig, config);
    if (outcome.kind === 'REJECTED') {
      rejectedRows.push(outcome.rejected);
      return;
    }
    dataRowCount += 1;
  });
  for (const block of text.blocks()) {
    scanner.push(block);
    census.push(block);
  }
  const scanned = scanner.end();

  if (headerRowNumber === null) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${fileConfig.path} contains no rows at all, so it has no header row`,
      'Provide a file whose first row lists the column headers.',
      { fileId: fileConfig.id, path: fileConfig.path },
    );
  }

  assertCensusAgrees(records, census.total(), fileConfig.path, { fileId: fileConfig.id });

  const evidence: SheetEvidence[] = [
    { kind: 'CSV_DELIMITER', detail: delimiter === '\t' ? 'TAB' : delimiter },
    { kind: 'CSV_LINE_TERMINATOR', detail: scanned.lineTerminator },
    { kind: 'SOURCE_ENCODING', detail: `${file.encoding} (${file.encodingEvidence})` },
  ];

  // ------------------------------------------------------------- the rows
  const rows: Iterable<SourceRow> = {
    *[Symbol.iterator](): IterableIterator<SourceRow> {
      let seenHeader = false;
      const held: SourceRow[] = [];
      const pass = createCsvScanner(options, (recordNumber, fields) => {
        if (!seenHeader) {
          seenHeader = true;
          return;
        }
        const outcome = classifyCsvRecord(recordNumber, fields, columns, sheet, fileConfig, config);
        if (outcome.kind === 'ACCEPTED') held.push(outcome.row);
      });
      for (const block of text.blocks()) {
        pass.push(block);
        // Handed out as each block completes them, so what is held is the rows
        // of one block rather than the rows of the file.
        if (held.length > 0) {
          const batch = held.splice(0, held.length);
          yield* batch;
        }
      }
      pass.end();
      yield* held;
    },
  };

  const ingested: IngestedSheet = {
    file,
    sheet,
    columns,
    headerRowNumber,
    readerRowCount,
    dataRowCount,
    rows,
    rejectedRows,
    evidence,
  };
  assertRowsAccountedFor(ingested, fileConfig.path);

  return { file, sheets: [ingested] };
}

/**
 * What one record of a CSV sheet is: a row, or a rejection, or a reason to stop.
 *
 * Written once and used by both passes over the file. Two copies of this would
 * be two answers to what a row is, and the second pass -- the one that produces
 * the rows the migration acts on -- would eventually disagree with the counts
 * the first pass recorded.
 */
type CsvRecordOutcome =
  | { readonly kind: 'ACCEPTED'; readonly row: SourceRow }
  | { readonly kind: 'REJECTED'; readonly rejected: RejectedRow };

function classifyCsvRecord(
  recordNumber: number,
  fields: readonly string[],
  columns: readonly ColumnLocator[],
  sheet: SheetLocator,
  fileConfig: FileConfig,
  config: MigrationConfig,
): CsvRecordOutcome {
  const cells: SourceCell[] = fields.map((raw, columnIndex) => ({
    columnIndex,
    raw,
    kind: 'CSV_TEXT' as const,
    formula: null,
    numberFormat: null,
    dateSystem: null,
  }));

  if (fields.length !== columns.length) {
    const detail = `row has ${String(fields.length)} columns; the header has ${String(columns.length)}`;
    if (config.policies.rowShapeMismatch === 'FAIL_RUN') {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${fileConfig.path} record ${String(recordNumber)}: ${detail}`,
        'Repair the file, or set policies.rowShapeMismatch to REJECT_ROW to record such rows as rejected input instead.',
        { fileId: fileConfig.id, recordNumber, detail },
      );
    }
    return {
      kind: 'REJECTED',
      rejected: {
        locator: makeRowLocator(sheet.fileId, sheet.sheetId, recordNumber, cells),
        reasonCode: 'INGEST_ROW_COLUMN_COUNT_MISMATCH',
        detail,
      },
    };
  }

  const row = makeSourceRow(sheet, recordNumber, cells);
  if (isBlankRow(row)) {
    if (config.policies.blankRow === 'FAIL_RUN') {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${fileConfig.path} record ${String(recordNumber)} is empty`,
        'Remove the blank row, or set policies.blankRow to REJECT_ROW.',
        { fileId: fileConfig.id, recordNumber },
      );
    }
    return {
      kind: 'REJECTED',
      rejected: {
        locator: row.locator,
        reasonCode: 'INGEST_ROW_BLANK',
        detail: 'the row has no value in any column',
      },
    };
  }
  return { kind: 'ACCEPTED', row };
}

/**
 * A workbook, opened to learn the shape of its sheets and walked a row at a
 * time.
 *
 * A sheet is inside a zip container, so there is no reading one row of it
 * without the parts that describe the workbook -- the shared strings, the
 * styles, the date system. Those are read when the workbook is opened, and
 * nothing else is.
 *
 * The previous version of this comment claimed the rows were "produced when
 * they are walked and released as they go", and the claim was false in a way
 * worth recording. `readWorkbook` returned every row of every sheet as one
 * value, so opening the workbook built the whole thing; the lazy iterable then
 * called `readWorkbook` *again* per walk, building a second whole workbook
 * beside the first; and the first stayed reachable for the length of the
 * migration, because the iterable's closure captured the sheet it came from.
 * Measured on the SHEET_COUNT profile at 100,024 rows: 397 MB still held after
 * ingest returned, and 658 MB peak to ingest and walk a 48.8 MB workbook.
 *
 * Now the handle holds the workbook's shape and the reader hands out one row at
 * a time. Walking a sheet twice reads its part twice, which is the same trade
 * the CSV reader makes: I/O rather than memory that grows with the source.
 */
function ingestWorkbookFile(
  bundleId: string,
  fileId: string,
  fileConfig: FileConfig,
  path: string,
  byteLength: number,
  digest: string,
  config: MigrationConfig,
): IngestedFile {
  const workbook = openWorkbookFile(path, config.limits, fileConfig.path);

  const file: FileLocator = {
    bundleId,
    fileId,
    fileSha256: digest,
    fileNameOriginal: baseName(fileConfig.path),
    filePathRelative: fileConfig.path,
    fileByteLength: byteLength,
    format: 'XLSX',
    encoding: 'UTF8',
    encodingEvidence: 'OOXML_UTF8',
  };

  if (fileConfig.sheets !== null) {
    const actual = workbook.sheets.map((sheet) => sheet.name);
    const declared = [...fileConfig.sheets];
    const missing = declared.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !declared.includes(name));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new MigrationError(
        'INPUT_UNSUPPORTED',
        `${fileConfig.path} does not contain the sheets the configuration declares`,
        'Correct files[].sheets, or supply the workbook the configuration was written for. Declaring sheets asserts the exact set the workbook must contain.',
        { fileId: fileConfig.id, declared, actual, missing, unexpected },
      );
    }
  }

  const sheets: IngestedSheet[] = workbook.sheets.map((workbookSheet) => {
    const sheet: SheetLocator = {
      fileId: file.fileId,
      sheetId: makeSheetId(workbookSheet.index),
      sheetIndex: workbookSheet.index,
      sheetName: workbookSheet.name,
      hidden: workbookSheet.hidden,
    };

    // ------------------------------------------------------------- the shape
    //
    // One pass over the sheet, holding one row. It settles what the columns
    // are, counts what the reader produced and sorts it, and keeps the header
    // row -- which is the only row of a sheet this has to remember, because it
    // is what every other row is measured against.
    let firstRow: WorkbookRow | null = null;
    let headerSettled = false;
    let width = 0;
    let columns: ColumnLocator[] = [];
    let readerRows = 0;
    let dataRowCount = 0;
    let sheetHasFormulas = false;
    const rejectedRows: RejectedRow[] = [];

    /**
     * What the header row means, decided once the sheet has said whether it has
     * any other rows.
     *
     * `hasDataRows` is the question `rows.length > 1` used to answer over the
     * whole materialised sheet. Streaming, the answer arrives with the second
     * row, so the refusal below happens there rather than after the sheet has
     * been read -- the same first offending sheet, one row earlier.
     */
    const settleHeader = (headerRow: WorkbookRow, hasDataRows: boolean): void => {
      if (headerSettled) return;
      headerSettled = true;
      if (headerRow.cells.every((cell) => (cell.raw ?? '').trim().length === 0) && hasDataRows) {
        // Excel writes a row element for a row that carries formatting and no
        // values. Taking it as the header made the sheet zero columns wide and
        // every data row an overflow, reported as a column-count mismatch.
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${fileConfig.path}!${workbookSheet.name} has no value in its first row, so it has no header row`,
          'Remove the empty leading row, or point the mapping at a sheet whose first row lists the column headers.',
          { fileId: fileConfig.id, sheet: workbookSheet.name },
        );
      }
      width = headerRow.cells.reduce((max, cell) => Math.max(max, cell.columnIndex + 1), 0);
      const headerValues: (string | null)[] = [];
      for (let index = 0; index < width; index += 1) {
        headerValues.push(headerRow.cells.find((cell) => cell.columnIndex === index)?.raw ?? null);
      }
      columns = buildColumns(headerValues, file.fileId, sheet.sheetId);
    };

    for (const workbookRow of workbook.rows(workbookSheet.index)) {
      if (!sheetHasFormulas && workbookRow.cells.some((cell) => cell.formula !== null)) sheetHasFormulas = true;
      if (firstRow === null) {
        firstRow = workbookRow;
        continue;
      }
      settleHeader(firstRow, true);
      readerRows += 1;
      const outcome = classifyWorkbookRow(
        workbookRow,
        width,
        workbook.dateSystem,
        sheet,
        workbookSheet.name,
        fileConfig,
        config,
      );
      if (outcome.kind === 'REJECTED') {
        rejectedRows.push(outcome.rejected);
        continue;
      }
      dataRowCount += 1;
    }
    // A sheet whose only row is its header still has columns, and a mapping is
    // still entitled to be checked against them.
    if (firstRow !== null) settleHeader(firstRow, false);

    const evidence: SheetEvidence[] = [
      { kind: 'WORKBOOK_DATE_SYSTEM', detail: workbook.dateSystem },
      { kind: 'SOURCE_ENCODING', detail: 'UTF8 (OOXML_UTF8)' },
    ];
    if (workbookSheet.hidden) {
      evidence.push({
        kind: 'SHEET_HIDDEN',
        detail: 'the workbook marks this sheet hidden; its rows are still accounted for',
      });
    }
    if (workbook.hasExternalLinks) {
      evidence.push({
        kind: 'WORKBOOK_EXTERNAL_LINKS',
        detail: 'the workbook references external links; they were recorded and never followed',
      });
    }
    if (sheetHasFormulas) {
      evidence.push({
        kind: 'SHEET_CONTAINS_FORMULAS',
        detail: 'at least one cell holds a formula; formulas are never evaluated',
      });
    }

    if (firstRow === null) {
      return {
        file,
        sheet,
        columns: [],
        headerRowNumber: 0,
        readerRowCount: 0,
        dataRowCount: 0,
        rows: [],
        rejectedRows: [],
        evidence: [...evidence, { kind: 'SHEET_EMPTY', detail: 'the sheet contains no rows' }],
      };
    }

    // ------------------------------------------------------------- the rows
    //
    // Read again when they are walked, by the same code that just counted
    // them: the same sheet index, the same classification, and only the
    // accepted rows handed out. Nothing of this pass survives it, so what a
    // walk costs is one row rather than one sheet.
    const rows: Iterable<SourceRow> = {
      *[Symbol.iterator](): IterableIterator<SourceRow> {
        let seenHeader = false;
        for (const workbookRow of workbook.rows(workbookSheet.index)) {
          if (!seenHeader) {
            seenHeader = true;
            continue;
          }
          const outcome = classifyWorkbookRow(
            workbookRow,
            width,
            workbook.dateSystem,
            sheet,
            workbookSheet.name,
            fileConfig,
            config,
          );
          if (outcome.kind === 'ACCEPTED') yield outcome.row;
        }
      },
    };

    const ingested: IngestedSheet = {
      file,
      sheet,
      columns,
      headerRowNumber: firstRow.rowNumber,
      readerRowCount: readerRows,
      dataRowCount,
      rows,
      rejectedRows,
      evidence,
    };
    assertRowsAccountedFor(ingested, fileConfig.path);
    return ingested;
  });

  return { file, sheets };
}

/**
 * Every row the reader produced is either accepted or rejected. A gap here is a
 * defect in this file, not in the customer data, so it raises rather than
 * quietly producing a smaller sheet.
 */
/**
 * What one row of a worksheet is: a row, or a rejection, or a reason to stop.
 *
 * Written once and used by both passes over the workbook -- the one that counts
 * the rows and the one that produces them. Two copies would be two answers to
 * what a row is, and the pass the migration acts on would eventually disagree
 * with the counts the other recorded.
 */
function classifyWorkbookRow(
  workbookRow: {
    readonly rowNumber: number;
    readonly cells: readonly {
      readonly columnIndex: number;
      readonly raw: string | null;
      readonly kind: SourceCell['kind'];
      readonly formula: string | null;
      readonly cachedValue: 'PRESENT' | 'ABSENT' | null;
      readonly numberFormat: string | null;
    }[];
  },
  width: number,
  dateSystem: SourceCell['dateSystem'],
  sheet: SheetLocator,
  sheetName: string,
  fileConfig: FileConfig,
  config: MigrationConfig,
): CsvRecordOutcome {
  const cells: SourceCell[] = [];
  const overflow = workbookRow.cells.filter((cell) => cell.columnIndex >= width);
  for (let index = 0; index < width; index += 1) {
    const found = workbookRow.cells.find((cell) => cell.columnIndex === index);
    cells.push(
      found === undefined
        ? { columnIndex: index, raw: null, kind: 'ABSENT', formula: null, numberFormat: null, dateSystem: null }
        : {
            columnIndex: index,
            raw: found.raw,
            kind: found.kind,
            formula: found.formula,
            cachedValue: found.cachedValue,
            numberFormat: found.numberFormat,
            dateSystem,
          },
    );
  }

  if (overflow.length > 0) {
    const detail = `row has data in column ${String((overflow[0] as { columnIndex: number }).columnIndex + 1)} but the header row is ${String(width)} columns wide`;
    if (config.policies.rowShapeMismatch === 'FAIL_RUN') {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${fileConfig.path}!${sheetName} row ${String(workbookRow.rowNumber)}: ${detail}`,
        'Repair the sheet, or set policies.rowShapeMismatch to REJECT_ROW.',
        { fileId: fileConfig.id, sheet: sheetName, rowNumber: workbookRow.rowNumber, detail },
      );
    }
    return {
      kind: 'REJECTED',
      rejected: {
        locator: makeRowLocator(sheet.fileId, sheet.sheetId, workbookRow.rowNumber, cells),
        reasonCode: 'INGEST_ROW_COLUMN_COUNT_MISMATCH',
        detail,
      },
    };
  }

  const row = makeSourceRow(sheet, workbookRow.rowNumber, cells);
  if (isBlankRow(row)) {
    if (config.policies.blankRow === 'FAIL_RUN') {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `${fileConfig.path}!${sheetName} row ${String(workbookRow.rowNumber)} is empty`,
        'Remove the blank row, or set policies.blankRow to REJECT_ROW.',
        { fileId: fileConfig.id, sheet: sheetName, rowNumber: workbookRow.rowNumber },
      );
    }
    return {
      kind: 'REJECTED',
      rejected: {
        locator: row.locator,
        reasonCode: 'INGEST_ROW_BLANK',
        detail: 'the row has no value in any column',
      },
    };
  }
  return { kind: 'ACCEPTED', row };
}

function assertRowsAccountedFor(sheet: IngestedSheet, filePath: string): void {
  const sorted = sheet.dataRowCount + sheet.rejectedRows.length;
  invariant(
    sheet.readerRowCount === sorted,
    'INGEST_ROWS_ACCOUNTED_FOR',
    `the reader produced ${String(sheet.readerRowCount)} data rows for ${filePath} but ${String(sorted)} were sorted into accepted or rejected`,
    { filePath, sheetId: sheet.sheet.sheetId, readerRowCount: sheet.readerRowCount, sorted },
  );
}

/**
 * The real path, or the path itself when it does not exist yet — a missing file
 * is reported by the read that follows, with a better message than this.
 */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}
