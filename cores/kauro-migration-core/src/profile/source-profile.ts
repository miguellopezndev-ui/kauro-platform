import { MigrationError } from '../domain/errors.js';
import { isPresent } from '../domain/source-cell.js';
import { computeBundleId, ingestBundle } from '../ingest/ingest-bundle.js';
import { canonicalJsonText, compareCodeUnits, parseJson } from '../util/json.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { sha256Hex } from '../util/hash.js';
import type { ScratchStore } from '../scratch/scratch-store.js';
import { openFamily, orderKey, orderNumber, orderText } from '../run/spool.js';
import type { Limits, MigrationConfig, Policies } from '../domain/config.js';
import { validateAgainstSchema } from '../mapping/schema-validator.js';
import type { Schema } from '../mapping/schema-validator.js';
import { makeColumnLocatorId, makeFileId, makeOccurrenceFileId } from '../domain/locators.js';

/**
 * What the source is, stated once and hashable.
 *
 * Two things use a profile: the Free Audit, which shows a person what their
 * data looks like, and the plan that is compiled from it. Both have to be
 * talking about the same bytes read the same way, and until now neither could
 * prove it — profiling produced a report with no version and no hash, so a plan
 * could be compiled against one reading of a bundle and executed against
 * another with nothing in either artifact to notice.
 *
 * So a profile is versioned, serialised canonically, and named by the hash of
 * those bytes. A run carries the hash it was given and refuses a profile that
 * does not describe the bundle it actually read. That is the whole of the
 * binding: not that the profile is right, but that the profile and the
 * execution are about the same thing.
 *
 * Full dataset, and bounded. The report this replaces held every populated value
 * of every column in an array and then a map of every distinct one — the whole
 * dataset twice per sheet — to answer how many distinct values a column had. The
 * count is exact here and is taken from a sorted spill instead, because the
 * canonical contract asks for an exact figure and forbids reaching it by holding
 * the data or by sampling.
 *
 * ---- what a reader refuses, and why it did not before ----
 *
 * `loadSourceProfile` used to check one field: `profileVersion`. The text
 * `{"profileVersion":"1.0.0"}` loaded as a profile of nothing, `null` threw a
 * `TypeError` from inside the reader rather than a refusal from the contract,
 * and a profile whose counters contradicted each other, whose files repeated,
 * or whose hash had been edited was accepted and then bound to a run. That is
 * not a contract; it is a field name.
 *
 * A profile on disk is now `{profileHash, profile}`, exactly as a target
 * contract is: the name it claims is written beside the content, and the reader
 * recomputes the name from the content and refuses the file if the two have
 * parted company. The content is validated against a closed schema (an unknown
 * key is a refusal, not an ignored extra), and then against the invariants no
 * honest profile can break: the counters of a column partition its rows, a
 * distinct count cannot exceed the populated count, a file id is a function of
 * the file's digest, the bundle id is a function of the files, and the totals
 * are the sums of the parts.
 *
 * The profile also states how the bundle was read — the configuration that
 * decided encodings, delimiters, sheets, limits and which rows are rejected —
 * because two readings of the same bytes under different configurations are two
 * different datasets, and a plan compiled against one may not be executed
 * against the other.
 */

export const SOURCE_PROFILE_VERSION = '1.0.0';

export interface ColumnStatistics {
  readonly columnIndex: number;
  readonly columnLocatorId: string;
  readonly headerRaw: string | null;
  readonly headerOccurrence: number;
  /** Cells holding at least one character. Whitespace counts as present. */
  readonly populated: number;
  /** Cells that are present and hold no characters. */
  readonly blank: number;
  /** Rows with no cell at that column at all, which is not the same as blank. */
  readonly absent: number;
  readonly maxValueLength: number;
  /** Exact, taken from a sorted spill rather than from a set of every value. */
  readonly distinctValues: number;
  readonly mostRepeatedValueCount: number;
  /** True when every populated cell differs, which is what makes a column a key candidate. */
  readonly uniqueAcrossPopulatedRows: boolean;
  readonly shapes: Readonly<Record<string, number>>;
}

export interface SheetStatistics {
  readonly sheetId: string;
  readonly sheetName: string | null;
  readonly hidden: boolean;
  readonly headerRowNumber: number;
  readonly columnCount: number;
  /** Counted where the reader produced them, before anything sorted them. */
  readonly readerRowCount: number;
  readonly dataRowCount: number;
  readonly rejectedRowCount: number;
  readonly duplicateHeaders: readonly string[];
  readonly candidateKeyColumns: readonly number[];
  readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
  readonly columns: readonly ColumnStatistics[];
}

export interface FileStatistics {
  readonly fileId: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly format: string;
  readonly encoding: string;
  readonly encodingEvidence: string;
  readonly sheets: readonly SheetStatistics[];
}

/**
 * The part of a configuration that decides how a bundle is read.
 *
 * Not the whole configuration: which destination fields a column maps to
 * changes nothing about what the reader produces, and binding a profile to the
 * mapping would make every profile stale the moment somebody renamed a field.
 * What is here is exactly the set of settings under which two readings of the
 * same bytes can differ.
 */
export interface ProfileReadConfig {
  readonly configVersion: string;
  readonly sourceEncoding: string | null;
  readonly limits: Limits;
  readonly rowShapeMismatch: Policies['rowShapeMismatch'];
  readonly blankRow: Policies['blankRow'];
  readonly formulaCachedValues: Policies['formulaCachedValues'];
  readonly files: readonly {
    readonly path: string;
    readonly format: string;
    readonly encoding: string | null;
    readonly delimiter: string | null;
    readonly sheets: readonly string[] | null;
  }[];
}

export interface SourceProfileV1 {
  readonly profileVersion: string;
  readonly bundleId: string;
  /** How the bundle was read. A run under a different reading refuses this profile. */
  readonly readConfig: ProfileReadConfig;
  /** Exact totals over the whole bundle, in bytes and rows. */
  readonly totals: {
    readonly fileCount: number;
    readonly sheetCount: number;
    readonly byteLength: number;
    readonly readerRowCount: number;
    readonly dataRowCount: number;
    readonly rejectedRowCount: number;
    readonly populatedCells: number;
  };
  readonly files: readonly FileStatistics[];
}

export interface HashedSourceProfile {
  readonly profile: SourceProfileV1;
  /** sha256 over the canonical serialisation. What a run is bound to. */
  readonly profileHash: string;
}

/**
 * The shapes a value can take, counted rather than guessed at.
 *
 * Deliberately the same list the report used, because a shape count is evidence
 * for a person reading a profile and changing it would change what they see
 * without changing what the data is.
 */
const SHAPE_TESTS: readonly { readonly name: string; readonly test: (value: string) => boolean }[] = [
  { name: 'blankPadded', test: (value) => value !== value.trim() },
  { name: 'integer', test: (value) => /^-?[0-9]+$/u.test(value) },
  { name: 'leadingZeroDigits', test: (value) => /^0[0-9]+$/u.test(value) },
  { name: 'decimalPoint', test: (value) => /^-?[0-9]+\.[0-9]+$/u.test(value) },
  { name: 'decimalComma', test: (value) => /^-?[0-9]+,[0-9]+$/u.test(value) },
  { name: 'groupedNumber', test: (value) => /^-?[0-9]{1,3}([., ][0-9]{3})+([.,][0-9]+)?$/u.test(value) },
  { name: 'isoDate', test: (value) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value) },
  { name: 'slashDateAmbiguous', test: (value) => /^([0-9]{1,2})\/([0-9]{1,2})\/[0-9]{2,4}$/u.test(value) },
  { name: 'emailLike', test: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) },
  { name: 'phoneInternational', test: (value) => /^\+[0-9][0-9\s().-]{5,}$/u.test(value) },
  { name: 'phoneLocalDigits', test: (value) => /^[0-9][0-9\s().-]{5,}$/u.test(value) },
  { name: 'booleanLike', test: (value) => /^(true|false|yes|no|y|n|0|1)$/iu.test(value) },
  { name: 'urlLike', test: (value) => /^https?:\/\//iu.test(value) },
  { name: 'containsNewline', test: (value) => value.includes('\n') || value.includes('\r') },
  { name: 'spreadsheetFormulaPrefix', test: (value) => /^[=+@]/u.test(value) },
];

/** The shape names a profile may carry, and therefore the only keys the schema admits under `shapes`. */
export const PROFILE_SHAPE_NAMES: readonly string[] = SHAPE_TESTS.map((shape) => shape.name);

export interface BuildSourceProfileInput {
  readonly inputRoot: string;
  readonly config: MigrationConfig;
  /** Where the distinct-value counts are sorted. Host-injected, like every other spill. */
  readonly scratch: ScratchStore;
}

/** The reading a configuration decides, in the form the profile records it. */
export function readConfigOf(config: MigrationConfig): ProfileReadConfig {
  return {
    configVersion: config.configVersion,
    sourceEncoding: config.source.encoding,
    limits: { ...config.limits },
    rowShapeMismatch: config.policies.rowShapeMismatch,
    blankRow: config.policies.blankRow,
    formulaCachedValues: config.policies.formulaCachedValues,
    files: [...config.files]
      .map((file) => ({
        path: file.path,
        format: file.format,
        encoding: file.encoding,
        delimiter: file.delimiter,
        sheets: file.sheets === null ? null : [...file.sheets],
      }))
      .sort((a, b) => compareCodeUnits(a.path, b.path)),
  };
}

/**
 * Build the profile of a bundle.
 *
 * The reader is the one the execution uses. Not a second implementation of what
 * a CSV or a workbook means: the whole point of a profile is that the plan
 * compiled from it will be executed against the same understanding of the same
 * bytes, and two readers would eventually disagree about a cell nobody looked at
 * twice.
 */
export function buildSourceProfile(input: BuildSourceProfileInput): HashedSourceProfile {
  const bundle = ingestBundle({ inputRoot: input.inputRoot, config: input.config });

  // One spilled tuple per populated cell, sorted by column and then by value.
  // Walking it afterwards gives the exact distinct count and the longest run of
  // one value, in constant memory — which is what the canonical contract asks
  // for and what a set of every distinct value cannot give at a million rows.
  const cells = openFamily<{ readonly at: string; readonly value: string }>(input.scratch, {
    schema: 'profile-cells',
    key: (cell) => orderKey(cell.at, orderText(cell.value)),
    purpose: 'every populated cell, keyed by column, so the distinct count is a sorted walk',
    producer: 'buildSourceProfile',
    consumer: 'buildSourceProfile',
  });

  let populatedCells = 0;
  const files: FileStatistics[] = [];

  for (const file of bundle.files) {
    const sheets: SheetStatistics[] = [];
    for (const sheet of file.sheets) {
      const dataRowCount = sheet.dataRowCount;
      const columns = sheet.columns.map((column) => ({
        columnIndex: column.columnIndex,
        columnLocatorId: column.columnLocatorId,
        headerRaw: column.headerRaw,
        headerOccurrence: column.headerOccurrence,
        populated: 0,
        blank: 0,
        absent: 0,
        maxValueLength: 0,
        shapes: {} as Record<string, number>,
      }));

      for (const row of sheet.rows) {
        for (const column of columns) {
          const cell = row.cells[column.columnIndex];
          if (cell === undefined) {
            column.absent += 1;
            continue;
          }
          if (!isPresent(cell)) {
            // Present and empty is a different observation from not being there
            // at all, and a profile that reported one number for both would hide
            // the difference the value semantics depend on.
            if (cell.raw === null) column.absent += 1;
            else column.blank += 1;
            continue;
          }
          const value = cell.raw as string;
          column.populated += 1;
          populatedCells += 1;
          if (value.length > column.maxValueLength) column.maxValueLength = value.length;
          for (const shape of SHAPE_TESTS) {
            if (shape.test(value)) column.shapes[shape.name] = (column.shapes[shape.name] ?? 0) + 1;
          }
          cells.add({ at: cellAddress(file.file.fileId, sheet.sheet.sheetId, column.columnIndex), value });
        }
      }

      sheets.push({
        sheetId: sheet.sheet.sheetId,
        sheetName: sheet.sheet.sheetName,
        hidden: sheet.sheet.hidden,
        headerRowNumber: sheet.headerRowNumber,
        columnCount: sheet.columns.length,
        readerRowCount: sheet.readerRowCount,
        dataRowCount,
        rejectedRowCount: sheet.rejectedRows.length,
        duplicateHeaders: duplicateHeadersOf(sheet.columns),
        // Filled in once the distinct counts are known.
        candidateKeyColumns: [],
        evidence: sheet.evidence.map((item) => ({ kind: item.kind, detail: item.detail })),
        columns: columns.map((column) => ({
          ...column,
          distinctValues: 0,
          mostRepeatedValueCount: 0,
          uniqueAcrossPopulatedRows: false,
          shapes: sortShapes(column.shapes),
        })),
      });
    }

    files.push({
      fileId: file.file.fileId,
      path: file.file.filePathRelative,
      sha256: file.file.fileSha256,
      byteLength: file.file.fileByteLength,
      format: file.file.format,
      encoding: file.file.encoding,
      encodingEvidence: file.file.encodingEvidence,
      sheets,
    });
  }

  // The sorted walk. Values for one column are adjacent, and equal values are
  // adjacent within that, so a distinct count and the longest run of one value
  // both fall out of comparing each tuple with the one before it.
  const distinct = new Map<string, { distinct: number; mostRepeated: number }>();
  let previousAt: string | null = null;
  let previousValue: string | null = null;
  let run = 0;
  const sealed = cells.seal();
  for (const cell of sealed) {
    const entry = distinct.get(cell.at) ?? { distinct: 0, mostRepeated: 0 };
    if (cell.at !== previousAt) {
      previousAt = cell.at;
      previousValue = null;
      run = 0;
    }
    if (cell.value === previousValue) {
      run += 1;
    } else {
      entry.distinct += 1;
      previousValue = cell.value;
      run = 1;
    }
    if (run > entry.mostRepeated) entry.mostRepeated = run;
    distinct.set(cell.at, entry);
  }
  sealed.release();

  const withCounts: FileStatistics[] = files.map((file) => ({
    ...file,
    sheets: file.sheets.map((sheet) => {
      const columns = sheet.columns.map((column) => {
        const counted = distinct.get(cellAddress(file.fileId, sheet.sheetId, column.columnIndex)) ?? {
          distinct: 0,
          mostRepeated: 0,
        };
        return {
          ...column,
          distinctValues: counted.distinct,
          mostRepeatedValueCount: counted.mostRepeated,
          uniqueAcrossPopulatedRows: column.populated > 0 && counted.distinct === column.populated,
        };
      });
      return {
        ...sheet,
        columns,
        candidateKeyColumns: columns
          .filter((column) => column.uniqueAcrossPopulatedRows && column.populated === sheet.dataRowCount)
          .map((column) => column.columnIndex),
      };
    }),
  }));

  const profile: SourceProfileV1 = {
    profileVersion: SOURCE_PROFILE_VERSION,
    bundleId: bundle.bundleId,
    readConfig: readConfigOf(input.config),
    totals: totalsOf(withCounts, populatedCells),
    files: withCounts,
  };

  // Built by the producer and still checked: a profile the reader would refuse
  // is a profile nobody should be handed.
  const problems = profileInvariantProblems(profile);
  if (problems.length > 0) {
    throw new MigrationError(
      'SOURCE_PROFILE_INVALID',
      `the profile this reader built breaks its own invariants: ${problems.map((problem) => `${problem.pointer}: ${problem.message}`).join('; ')}`,
      'This is a defect in the profiler, not in the source. Report it with the bundle that produced it.',
      { problems: problems.map((problem) => ({ pointer: problem.pointer, message: problem.message })) },
    );
  }

  return { profile, profileHash: hashSourceProfile(profile) };
}

/** The public name of the producer; the same function. */
export const produceSourceProfile = buildSourceProfile;

function totalsOf(files: readonly FileStatistics[], populatedCells: number): SourceProfileV1['totals'] {
  return {
    fileCount: files.length,
    sheetCount: files.reduce((sum, file) => sum + file.sheets.length, 0),
    byteLength: files.reduce((sum, file) => sum + file.byteLength, 0),
    readerRowCount: files.reduce((sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.readerRowCount, 0), 0),
    dataRowCount: files.reduce((sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.dataRowCount, 0), 0),
    rejectedRowCount: files.reduce(
      (sum, file) => sum + file.sheets.reduce((inner, sheet) => inner + sheet.rejectedRowCount, 0),
      0,
    ),
    populatedCells,
  };
}

function cellAddress(fileId: string, sheetId: string, columnIndex: number): string {
  return `${fileId}:${sheetId}:${orderNumber(columnIndex, 6)}`;
}

function duplicateHeadersOf(columns: readonly { readonly headerRaw: string | null }[]): string[] {
  const counts = new Map<string, number>();
  for (const column of columns) {
    if (column.headerRaw === null) continue;
    counts.set(column.headerRaw, (counts.get(column.headerRaw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, total]) => total > 1)
    .map(([header]) => header)
    .sort(compareCodeUnits);
}

function sortShapes(shapes: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(shapes).sort(([a], [b]) => compareCodeUnits(a, b)));
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

const NON_NEGATIVE: Schema = { type: 'integer', minimum: 0 };
const SHA256_HEX = '^[0-9a-f]{64}$';

const COLUMN_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'columnIndex',
    'columnLocatorId',
    'headerRaw',
    'headerOccurrence',
    'populated',
    'blank',
    'absent',
    'maxValueLength',
    'distinctValues',
    'mostRepeatedValueCount',
    'uniqueAcrossPopulatedRows',
    'shapes',
  ],
  properties: {
    columnIndex: NON_NEGATIVE,
    columnLocatorId: { type: 'string', minLength: 1 },
    headerRaw: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    headerOccurrence: { type: 'integer', minimum: 1 },
    populated: NON_NEGATIVE,
    blank: NON_NEGATIVE,
    absent: NON_NEGATIVE,
    maxValueLength: NON_NEGATIVE,
    distinctValues: NON_NEGATIVE,
    mostRepeatedValueCount: NON_NEGATIVE,
    uniqueAcrossPopulatedRows: { type: 'boolean' },
    shapes: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(PROFILE_SHAPE_NAMES.map((name) => [name, { type: 'integer', minimum: 1 } as Schema])),
    },
  },
};

const SHEET_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sheetId',
    'sheetName',
    'hidden',
    'headerRowNumber',
    'columnCount',
    'readerRowCount',
    'dataRowCount',
    'rejectedRowCount',
    'duplicateHeaders',
    'candidateKeyColumns',
    'evidence',
    'columns',
  ],
  properties: {
    sheetId: { type: 'string', pattern: '^S[0-9]+$' },
    sheetName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    hidden: { type: 'boolean' },
    headerRowNumber: { type: 'integer', minimum: 1 },
    columnCount: NON_NEGATIVE,
    readerRowCount: NON_NEGATIVE,
    dataRowCount: NON_NEGATIVE,
    rejectedRowCount: NON_NEGATIVE,
    duplicateHeaders: { type: 'array', items: { type: 'string' } },
    candidateKeyColumns: { type: 'array', items: NON_NEGATIVE },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'detail'],
        properties: { kind: { type: 'string', minLength: 1 }, detail: { type: 'string' } },
      },
    },
    columns: { type: 'array', items: COLUMN_SCHEMA },
  },
};

const FILE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['fileId', 'path', 'sha256', 'byteLength', 'format', 'encoding', 'encodingEvidence', 'sheets'],
  properties: {
    fileId: { type: 'string', pattern: '^F-[0-9a-f]{12}$' },
    path: { type: 'string', minLength: 1 },
    sha256: { type: 'string', pattern: SHA256_HEX },
    byteLength: NON_NEGATIVE,
    format: { type: 'string', enum: ['CSV', 'XLSX'] },
    encoding: { type: 'string', minLength: 1 },
    encodingEvidence: { type: 'string', minLength: 1 },
    sheets: { type: 'array', items: SHEET_SCHEMA },
  },
};

const READ_CONFIG_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['configVersion', 'sourceEncoding', 'limits', 'rowShapeMismatch', 'blankRow', 'formulaCachedValues', 'files'],
  properties: {
    configVersion: { type: 'string', minLength: 1 },
    sourceEncoding: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: [
        'maxFiles',
        'maxBytesPerFile',
        'maxTotalBytes',
        'maxSheetsPerFile',
        'maxRowsPerSheet',
        'maxColumnsPerSheet',
        'maxCellLength',
        'maxWorkbookUncompressedBytes',
        'maxWorkbookPartUncompressedBytes',
        'maxRecordBytes',
      ],
      properties: {
        maxFiles: NON_NEGATIVE,
        maxBytesPerFile: NON_NEGATIVE,
        maxTotalBytes: NON_NEGATIVE,
        maxSheetsPerFile: NON_NEGATIVE,
        maxRowsPerSheet: NON_NEGATIVE,
        maxColumnsPerSheet: NON_NEGATIVE,
        maxCellLength: NON_NEGATIVE,
        maxWorkbookUncompressedBytes: NON_NEGATIVE,
        maxWorkbookPartUncompressedBytes: NON_NEGATIVE,
        maxRecordBytes: NON_NEGATIVE,
      },
    },
    rowShapeMismatch: { type: 'string', enum: ['REJECT_ROW', 'FAIL_RUN'] },
    blankRow: { type: 'string', enum: ['REJECT_ROW', 'FAIL_RUN'] },
    formulaCachedValues: { type: 'string', enum: ['ISOLATE_ROW', 'ACCEPT_WITH_PROVENANCE'] },
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'format', 'encoding', 'delimiter', 'sheets'],
        properties: {
          path: { type: 'string', minLength: 1 },
          format: { type: 'string', enum: ['CSV', 'XLSX'] },
          encoding: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
          delimiter: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
          sheets: { anyOf: [{ type: 'array', items: { type: 'string', minLength: 1 } }, { type: 'null' }] },
        },
      },
    },
  },
};

export const SOURCE_PROFILE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['profileVersion', 'bundleId', 'readConfig', 'totals', 'files'],
  properties: {
    profileVersion: { type: 'string', enum: [SOURCE_PROFILE_VERSION] },
    bundleId: { type: 'string', pattern: '^B-[0-9a-f]{16}$' },
    readConfig: READ_CONFIG_SCHEMA,
    totals: {
      type: 'object',
      additionalProperties: false,
      required: ['fileCount', 'sheetCount', 'byteLength', 'readerRowCount', 'dataRowCount', 'rejectedRowCount', 'populatedCells'],
      properties: {
        fileCount: NON_NEGATIVE,
        sheetCount: NON_NEGATIVE,
        byteLength: NON_NEGATIVE,
        readerRowCount: NON_NEGATIVE,
        dataRowCount: NON_NEGATIVE,
        rejectedRowCount: NON_NEGATIVE,
        populatedCells: NON_NEGATIVE,
      },
    },
    files: { type: 'array', items: FILE_SCHEMA },
  },
};

/** The file a profile is written to: the content, and the name it claims. */
export const SERIALIZED_PROFILE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['profileHash', 'profile'],
  properties: {
    profileHash: { type: 'string', pattern: SHA256_HEX },
    profile: SOURCE_PROFILE_SCHEMA,
  },
};

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

export interface ProfileProblem {
  readonly pointer: string;
  readonly message: string;
}

/**
 * What no honest profile can break, checked after the schema has settled the
 * shape.
 *
 * Each rule is a relation between numbers the profiler produced independently,
 * so a profile edited by hand — or produced by a profiler with a defect — has
 * to be edited consistently in several places at once to pass, and a reader can
 * name the first place it was not.
 */
export function profileInvariantProblems(profile: SourceProfileV1): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  const say = (pointer: string, message: string): void => {
    problems.push({ pointer, message });
  };

  const paths = new Set<string>();
  const fileIds = new Set<string>();
  const digests: string[] = [];
  let populatedCells = 0;

  profile.files.forEach((file, fileIndex) => {
    const at = `/files/${String(fileIndex)}`;
    if (paths.has(file.path)) say(`${at}/path`, `the file ${file.path} appears more than once`);
    paths.add(file.path);
    if (fileIds.has(file.fileId)) say(`${at}/fileId`, `the file id ${file.fileId} appears more than once`);
    fileIds.add(file.fileId);
    // Files that share bytes take their ids from digest and path (D69); any other file's id is its digest's.
    const shared = profile.files.filter((other) => other.sha256 === file.sha256).length > 1;
    const expectedId = shared ? makeOccurrenceFileId(file.sha256, file.path) : makeFileId(file.sha256);
    if (file.fileId !== expectedId) say(`${at}/fileId`, `the file id ${file.fileId} is not derived from the file's ${shared ? 'digest and path' : 'digest'}`);
    digests.push(file.sha256);

    const sheetIds = new Set<string>();
    file.sheets.forEach((sheet, sheetIndex) => {
      const sheetAt = `${at}/sheets/${String(sheetIndex)}`;
      if (sheetIds.has(sheet.sheetId)) say(`${sheetAt}/sheetId`, `the sheet id ${sheet.sheetId} appears more than once in ${file.path}`);
      sheetIds.add(sheet.sheetId);
      if (sheet.columnCount !== sheet.columns.length) {
        say(`${sheetAt}/columnCount`, `states ${String(sheet.columnCount)} columns and lists ${String(sheet.columns.length)}`);
      }
      if (sheet.readerRowCount !== sheet.dataRowCount + sheet.rejectedRowCount) {
        say(
          `${sheetAt}/readerRowCount`,
          `the reader produced ${String(sheet.readerRowCount)} rows, which is not ${String(sheet.dataRowCount)} data rows plus ${String(sheet.rejectedRowCount)} rejected`,
        );
      }
      const indexes = new Set<number>();
      const byIndex = new Map<number, ColumnStatistics>();
      sheet.columns.forEach((column, columnIndex) => {
        const columnAt = `${sheetAt}/columns/${String(columnIndex)}`;
        if (indexes.has(column.columnIndex)) say(`${columnAt}/columnIndex`, `column index ${String(column.columnIndex)} appears more than once`);
        indexes.add(column.columnIndex);
        byIndex.set(column.columnIndex, column);
        const expectedLocator = makeColumnLocatorId(file.fileId, sheet.sheetId, column.columnIndex);
        if (column.columnLocatorId !== expectedLocator) {
          say(`${columnAt}/columnLocatorId`, `is ${column.columnLocatorId} and the column's address is ${expectedLocator}`);
        }
        if (column.populated + column.blank + column.absent !== sheet.dataRowCount) {
          say(
            `${columnAt}/populated`,
            `${String(column.populated)} populated + ${String(column.blank)} blank + ${String(column.absent)} absent is not the sheet's ${String(sheet.dataRowCount)} data rows`,
          );
        }
        if (column.distinctValues > column.populated) say(`${columnAt}/distinctValues`, 'exceeds the populated count');
        if (column.mostRepeatedValueCount > column.populated) say(`${columnAt}/mostRepeatedValueCount`, 'exceeds the populated count');
        if ((column.distinctValues === 0) !== (column.populated === 0)) {
          say(`${columnAt}/distinctValues`, 'a column has distinct values exactly when it has populated cells');
        }
        if ((column.mostRepeatedValueCount === 0) !== (column.populated === 0)) {
          say(`${columnAt}/mostRepeatedValueCount`, 'a column has a most repeated value exactly when it has populated cells');
        }
        if (column.populated > 0 && column.maxValueLength === 0) say(`${columnAt}/maxValueLength`, 'a populated cell holds at least one character');
        if (column.populated === 0 && column.maxValueLength !== 0) say(`${columnAt}/maxValueLength`, 'no populated cell, so no value length');
        if (column.uniqueAcrossPopulatedRows !== (column.populated > 0 && column.distinctValues === column.populated)) {
          say(`${columnAt}/uniqueAcrossPopulatedRows`, 'disagrees with the populated and distinct counts');
        }
        for (const [shape, count] of Object.entries(column.shapes)) {
          if (count > column.populated) say(`${columnAt}/shapes/${shape}`, 'counts more cells than are populated');
        }
        populatedCells += column.populated;
      });
      const keyColumns = new Set<number>();
      sheet.candidateKeyColumns.forEach((index, position) => {
        const keyAt = `${sheetAt}/candidateKeyColumns/${String(position)}`;
        if (keyColumns.has(index)) say(keyAt, `column ${String(index)} is listed twice`);
        keyColumns.add(index);
        const column = byIndex.get(index);
        if (column === undefined) say(keyAt, `column ${String(index)} is not a column of this sheet`);
        else if (!(column.uniqueAcrossPopulatedRows && column.populated === sheet.dataRowCount)) {
          say(keyAt, `column ${String(index)} is not unique across every data row, so it is not a key candidate`);
        }
      });
      for (const column of sheet.columns) {
        if (column.uniqueAcrossPopulatedRows && column.populated === sheet.dataRowCount && !keyColumns.has(column.columnIndex)) {
          say(`${sheetAt}/candidateKeyColumns`, `column ${String(column.columnIndex)} is a key candidate and is not listed`);
        }
      }
      const duplicates = duplicateHeadersOf(sheet.columns);
      if (duplicates.join('\n') !== [...sheet.duplicateHeaders].join('\n')) {
        say(`${sheetAt}/duplicateHeaders`, 'disagrees with the headers the columns carry');
      }
    });
  });

  const expectedBundleId = computeBundleId(
    profile.files.map((file) => ({ path: file.path })),
    digests,
  );
  if (profile.files.length > 0 && profile.bundleId !== expectedBundleId) {
    say('/bundleId', `is ${profile.bundleId} and the files it lists derive ${expectedBundleId}`);
  }

  const totals = totalsOf(profile.files, populatedCells);
  for (const [key, value] of Object.entries(totals)) {
    if (profile.totals[key as keyof typeof totals] !== value) {
      say(`/totals/${key}`, `is ${String(profile.totals[key as keyof typeof totals])} and the files sum to ${String(value)}`);
    }
  }

  // The reading names every file the profile describes, and nothing else.
  const readPaths = profile.readConfig.files.map((file) => file.path);
  const readSet = new Set(readPaths);
  if (readSet.size !== readPaths.length) say('/readConfig/files', 'names a file more than once');
  for (const file of profile.files) {
    if (!readSet.has(file.path)) say('/readConfig/files', `does not name ${file.path}, which the profile describes`);
  }
  for (const path of readPaths) {
    if (!paths.has(path)) say('/readConfig/files', `names ${path}, which the profile does not describe`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Serialising, hashing, loading
// ---------------------------------------------------------------------------

/** Canonical bytes of a profile, and the hash a run is bound to. */
export function sourceProfileToJson(profile: SourceProfileV1): JsonObject {
  return JSON.parse(JSON.stringify(profile)) as JsonObject;
}

export function hashSourceProfile(profile: SourceProfileV1): string {
  return sha256Hex(canonicalJsonText(sourceProfileToJson(profile) as JsonValue));
}

/**
 * The file a host keeps: the content and the name it claims, canonical.
 *
 * The name is written beside the content so a reader can disagree with it.
 * Nothing trusts it: `loadSourceProfile` recomputes the hash from the content
 * and refuses a file whose two halves have parted company.
 */
export function serializeSourceProfile(hashed: HashedSourceProfile): string {
  return canonicalJsonText({ profileHash: hashed.profileHash, profile: sourceProfileToJson(hashed.profile) });
}

function refuse(where: string, message: string, remedy: string, details: JsonObject = {}): never {
  throw new MigrationError('SOURCE_PROFILE_INVALID', `${where} ${message}`, remedy, { where, ...details });
}

/** The first few problems in the message; every one of them in the details. */
const SUMMARISED = 3;

function summarise(problems: readonly string[]): string {
  const shown = problems.slice(0, SUMMARISED).join('; ');
  return problems.length > SUMMARISED ? `${shown}; and ${String(problems.length - SUMMARISED)} more` : shown;
}

/**
 * Read a profile off disk, and refuse everything that is not one.
 *
 * Every refusal is a `MigrationError` with code `SOURCE_PROFILE_INVALID` and a
 * pointer into the document. There is no path here that returns a partial
 * profile, and no input — including `null`, an array, or the empty string —
 * that reaches the reader's own code before the contract has spoken.
 */
export function loadSourceProfile(text: string, where: string): HashedSourceProfile {
  if (typeof text !== 'string') refuse(where, 'is not text', 'Supply the profile file as it was written.');
  let parsed: JsonValue;
  try {
    parsed = parseJson(text);
  } catch (error) {
    refuse(where, 'is not valid JSON', 'Supply the profile as it was written.', {
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse(where, 'is not a profile document', 'A profile file is an object holding profileHash and profile.', {
      received: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
    });
  }
  // The version first and on its own, so a profile written by a later core is
  // refused for that reason rather than for whatever field the later schema
  // added.
  const body = (parsed as JsonObject)['profile'];
  const declared = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject)['profileVersion'] : undefined;
  if (declared !== undefined && declared !== SOURCE_PROFILE_VERSION) {
    refuse(where, `declares profile version ${String(declared)} and this core reads ${SOURCE_PROFILE_VERSION}`, 'Rebuild the profile with this core version.', {
      declared: String(declared),
    });
  }
  const violations = validateAgainstSchema(parsed, SERIALIZED_PROFILE_SCHEMA);
  if (violations.length > 0) {
    // Named in the message, not only in the details. A refusal a reader has to
    // open a JSON blob to understand is a refusal they will guess at instead.
    refuse(where, `does not match the source profile schema: ${summarise(violations.map((violation) => `${violation.pointer === '' ? '/' : violation.pointer}: ${violation.message}`))}`, 'Correct each listed pointer. The schema is closed, so an unknown key is rejected rather than ignored.', {
      violations: violations.map((violation) => ({ pointer: violation.pointer === '' ? '/' : violation.pointer, message: violation.message })),
    });
  }
  const document = parsed as unknown as { profileHash: string; profile: SourceProfileV1 };
  const problems = profileInvariantProblems(document.profile);
  if (problems.length > 0) {
    refuse(where, `breaks the profile invariants: ${summarise(problems.map((problem) => `${problem.pointer} ${problem.message}`))}`, 'A profile whose counters disagree with each other describes no dataset. Rebuild it rather than editing it.', {
      problems: problems.map((problem) => ({ pointer: problem.pointer, message: problem.message })),
    });
  }
  const recomputed = hashSourceProfile(document.profile);
  if (recomputed !== document.profileHash) {
    refuse(where, 'does not hash to the digest it claims', 'The profile has changed since it was built. Rebuild it rather than repairing the file: a profile whose content and name disagree is not evidence about anything.', {
      claimed: document.profileHash,
      recomputed,
    });
  }
  return { profile: document.profile, profileHash: recomputed };
}

// ---------------------------------------------------------------------------
// Binding a profile to a run
// ---------------------------------------------------------------------------

/**
 * Does this profile describe the bundle that was actually read, read the same way?
 *
 * Three questions, and every one has to be answered yes:
 *
 *   - the bundle id the profile names is the bundle id the run derived;
 *   - the file inventory is the same in both directions — every file the run
 *     read is in the profile with the same digest, and every file the profile
 *     describes was read by the run. A profile of more files than the run read
 *     was compiled against data the run never saw, which is as wrong as the
 *     reverse and used to pass;
 *   - the reading is the same: the configuration settings that decide what the
 *     reader produces are the ones the profile recorded.
 */
export function assertProfileDescribesBundle(
  supplied: HashedSourceProfile,
  bundleId: string,
  fileDigests: readonly { readonly path: string; readonly sha256: string }[],
  config?: MigrationConfig,
): void {
  if (supplied.profile.bundleId !== bundleId) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `the supplied source profile describes bundle ${supplied.profile.bundleId} and this run read ${bundleId}`,
      'The source bytes have changed since the profile was built. Rebuild the profile, recompile the plan against it, and run again. A plan compiled against one reading of a bundle may not be executed against another.',
      { profileBundleId: supplied.profile.bundleId, bundleId, profileHash: supplied.profileHash },
    );
  }

  const profiled = new Map(supplied.profile.files.map((file) => [file.path, file.sha256]));
  const read = new Set<string>();
  for (const file of fileDigests) {
    read.add(file.path);
    const known = profiled.get(file.path);
    if (known === undefined) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `the supplied source profile does not describe ${file.path}, which this run read`,
        'Rebuild the profile over the bundle this run is given.',
        { path: file.path, profileHash: supplied.profileHash },
      );
    }
    if (known !== file.sha256) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `the supplied source profile describes a different ${file.path}`,
        'The file has changed since the profile was built. Rebuild the profile and recompile the plan against it.',
        { path: file.path, profiled: known, read: file.sha256 },
      );
    }
  }
  for (const path of profiled.keys()) {
    if (!read.has(path)) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        `the supplied source profile describes ${path}, which this run did not read`,
        'The profile was built over more files than this run was given. Rebuild the profile over exactly the bundle this run reads.',
        { path, profileHash: supplied.profileHash },
      );
    }
  }

  if (config !== undefined) {
    const expected = canonicalJsonText(JSON.parse(JSON.stringify(readConfigOf(config))) as JsonValue);
    const recorded = canonicalJsonText(JSON.parse(JSON.stringify(supplied.profile.readConfig)) as JsonValue);
    if (expected !== recorded) {
      throw new MigrationError(
        'INPUT_CORRUPT',
        'the supplied source profile was built under a different reading of the bundle than this run uses',
        'Encodings, delimiters, sheet selections, limits and the row policies decide what the reader produces. Rebuild the profile under the configuration this run is given, or run under the configuration the profile was built with.',
        { profileHash: supplied.profileHash, profileReadConfig: JSON.parse(recorded) as JsonValue, runReadConfig: JSON.parse(expected) as JsonValue },
      );
    }
  }
}
