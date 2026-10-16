import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { MigrationError } from '../domain/errors.js';
import { DEFAULT_LIMITS, DEFAULT_LOCALE_EVIDENCE, DEFAULT_POLICIES, CONFIG_SCHEMA_VERSION } from '../domain/config.js';
import type { MigrationConfig } from '../domain/config.js';
import { ingestBundle } from '../ingest/ingest-bundle.js';
import { isPresent } from '../domain/source-cell.js';
import type { JsonObject, JsonValue } from '../util/json.js';
import { compareCodeUnits } from '../util/json.js';
import { CORE_VERSION } from '../version.js';

/**
 * Diagnosis only.
 *
 * Inspection never cleans, never transforms and never draws a conclusion about
 * identity. It reports what is in the files so a human can write a
 * configuration; anything that looks like a duplicate is reported as a repeated
 * value, not as a duplicate record.
 */

export interface InspectOptions {
  readonly inputRoot: string;
}

export interface ColumnProfile {
  readonly columnIndex: number;
  readonly header: string | null;
  readonly headerOccurrence: number;
  readonly populated: number;
  readonly blank: number;
  readonly blankRate: number;
  readonly distinctValues: number;
  readonly maxLength: number;
  readonly shapes: Readonly<Record<string, number>>;
  readonly uniqueAcrossPopulatedRows: boolean;
  readonly mostRepeatedValueCount: number;
}

export interface SheetProfile {
  readonly sheetId: string;
  readonly sheetName: string | null;
  readonly hidden: boolean;
  readonly headerRowNumber: number;
  readonly dataRows: number;
  readonly rejectedRows: number;
  readonly columns: readonly ColumnProfile[];
  readonly duplicateHeaders: readonly string[];
  readonly candidateKeyColumns: readonly number[];
  readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
  readonly warnings: readonly string[];
}

export interface FileProfile {
  readonly path: string;
  readonly fileId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly format: string;
  readonly encoding: string;
  readonly encodingEvidence: string;
  readonly sheets: readonly SheetProfile[];
}

export interface InspectionReport {
  readonly coreVersion: string;
  readonly bundleId: string;
  readonly files: readonly FileProfile[];
}

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

export function inspectBundle(options: InspectOptions): InspectionReport {
  const root = resolve(options.inputRoot);
  const discovered = discoverFiles(root);
  if (discovered.length === 0) {
    throw new MigrationError(
      'INPUT_NOT_FOUND',
      `no .csv or .xlsx files were found under ${root}`,
      'Point --input at a directory containing the CRM export files.',
      { inputRoot: root },
    );
  }

  const config = syntheticConfig(discovered);
  const bundle = ingestBundle({ inputRoot: root, config });

  const files: FileProfile[] = bundle.files.map((file) => ({
    path: file.file.filePathRelative,
    fileId: file.file.fileId,
    sha256: file.file.fileSha256,
    byteLength: file.file.fileByteLength,
    format: file.file.format,
    encoding: file.file.encoding,
    encodingEvidence: file.file.encodingEvidence,
    sheets: file.sheets.map((sheet) => profileSheet(sheet)),
  }));

  return { coreVersion: CORE_VERSION, bundleId: bundle.bundleId, files };
}

function profileSheet(sheet: Parameters<typeof profileSheetInner>[0]): SheetProfile {
  return profileSheetInner(sheet);
}

/**
 * One pass over the sheet, however many columns it has.
 *
 * The rows are read from the file as they are walked now, so walking them once
 * per column would read the file once per column. Everything each column needs
 * is accumulated in the single pass instead.
 *
 * What is still per column is a count of its distinct values, which grows with
 * the data. This is the report a person reads, and it is bounded in practice
 * by how many different values a column holds; the description a plan is
 * compiled against is `SourceProfileV1`, which counts distinct values exactly
 * and holds nothing per value.
 */
function profileSheetInner(sheet: {
  sheet: { sheetId: string; sheetName: string | null; hidden: boolean };
  columns: readonly { columnIndex: number; headerRaw: string | null; headerOccurrence: number }[];
  headerRowNumber: number;
  dataRowCount: number;
  rows: Iterable<{ cells: readonly { columnIndex: number; raw: string | null }[] }>;
  rejectedRows: readonly unknown[];
  evidence: readonly { kind: string; detail: string }[];
}): SheetProfile {
  const totalRows = sheet.dataRowCount;

  interface Accumulated {
    populated: number;
    maxLength: number;
    counts: Map<string, number>;
    shapes: Map<string, number>;
  }
  const perColumn = new Map<number, Accumulated>();
  for (const column of sheet.columns) {
    perColumn.set(column.columnIndex, { populated: 0, maxLength: 0, counts: new Map(), shapes: new Map() });
  }

  for (const row of sheet.rows) {
    for (const column of sheet.columns) {
      const accumulated = perColumn.get(column.columnIndex);
      if (accumulated === undefined) continue;
      const cell = row.cells[column.columnIndex];
      if (cell === undefined) continue;
      if (!isPresent({ ...cell, kind: 'CSV_TEXT', formula: null, numberFormat: null, dateSystem: null })) continue;
      const value = cell.raw as string;
      accumulated.populated += 1;
      accumulated.maxLength = Math.max(accumulated.maxLength, value.length);
      accumulated.counts.set(value, (accumulated.counts.get(value) ?? 0) + 1);
      for (const test of SHAPE_TESTS) {
        if (test.test(value)) accumulated.shapes.set(test.name, (accumulated.shapes.get(test.name) ?? 0) + 1);
      }
    }
  }

  const columns: ColumnProfile[] = sheet.columns.map((column) => {
    const accumulated = perColumn.get(column.columnIndex) ?? {
      populated: 0,
      maxLength: 0,
      counts: new Map<string, number>(),
      shapes: new Map<string, number>(),
    };
    const shapes: Record<string, number> = {};
    for (const test of SHAPE_TESTS) {
      const total = accumulated.shapes.get(test.name) ?? 0;
      if (total > 0) shapes[test.name] = total;
    }
    return {
      columnIndex: column.columnIndex,
      header: column.headerRaw,
      headerOccurrence: column.headerOccurrence,
      populated: accumulated.populated,
      blank: totalRows - accumulated.populated,
      blankRate:
        totalRows === 0 ? 0 : Number(((totalRows - accumulated.populated) / totalRows).toFixed(4)),
      distinctValues: accumulated.counts.size,
      maxLength: accumulated.maxLength,
      shapes,
      uniqueAcrossPopulatedRows:
        accumulated.populated > 0 && accumulated.counts.size === accumulated.populated,
      mostRepeatedValueCount: [...accumulated.counts.values()].reduce((max, value) => Math.max(max, value), 0),
    };
  });

  const headerCounts = new Map<string, number>();
  for (const column of sheet.columns) {
    if (column.headerRaw === null) continue;
    headerCounts.set(column.headerRaw, (headerCounts.get(column.headerRaw) ?? 0) + 1);
  }
  const duplicateHeaders = [...headerCounts.entries()]
    .filter(([, total]) => total > 1)
    .map(([header]) => header)
    .sort(compareCodeUnits);

  const warnings: string[] = [];
  if (duplicateHeaders.length > 0) {
    warnings.push(
      `Repeated column headers: ${duplicateHeaders.join(', ')}. They stay separate columns; address them by occurrence or index.`,
    );
  }
  if (sheet.columns.some((column) => column.headerRaw === null || column.headerRaw.length === 0)) {
    warnings.push('At least one column has no header text. Address it by index.');
  }
  if (sheet.sheet.hidden) warnings.push('This sheet is hidden in the workbook, but its rows are still present.');
  for (const item of sheet.evidence) {
    if (item.kind === 'SHEET_CONTAINS_FORMULAS' || item.kind === 'WORKBOOK_EXTERNAL_LINKS') {
      warnings.push(item.detail);
    }
  }
  for (const column of columns) {
    const ambiguousDates = column.shapes['slashDateAmbiguous'] ?? 0;
    if (ambiguousDates > 0) {
      warnings.push(
        `Column ${String(column.columnIndex)} (${column.header ?? 'no header'}) holds ${String(ambiguousDates)} values shaped like d/m/y or m/d/y. Declare a date format for it, or the values will be preserved and flagged.`,
      );
    }
    const localPhones = column.shapes['phoneLocalDigits'] ?? 0;
    if (localPhones > 0) {
      warnings.push(
        `Column ${String(column.columnIndex)} (${column.header ?? 'no header'}) holds ${String(localPhones)} numbers with no international prefix. Declare the country, or they will be preserved unchanged.`,
      );
    }
    const leadingZeros = column.shapes['leadingZeroDigits'] ?? 0;
    if (leadingZeros > 0) {
      warnings.push(
        `Column ${String(column.columnIndex)} (${column.header ?? 'no header'}) holds ${String(leadingZeros)} values with leading zeros. Map it as IDENTIFIER so they survive.`,
      );
    }
  }

  return {
    sheetId: sheet.sheet.sheetId,
    sheetName: sheet.sheet.sheetName,
    hidden: sheet.sheet.hidden,
    headerRowNumber: sheet.headerRowNumber,
    dataRows: totalRows,
    rejectedRows: sheet.rejectedRows.length,
    columns,
    duplicateHeaders,
    candidateKeyColumns: columns
      .filter((column) => column.uniqueAcrossPopulatedRows && column.blank === 0)
      .map((column) => column.columnIndex),
    evidence: sheet.evidence.map((item) => ({ kind: item.kind, detail: item.detail })),
    warnings,
  };
}

function discoverFiles(root: string): { path: string; format: 'CSV' | 'XLSX' }[] {
  const found: { path: string; format: 'CSV' | 'XLSX' }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareCodeUnits(a.name, b.name),
    )) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const lower = entry.name.toLowerCase();
      const relativePath = relative(root, absolute).split(sep).join('/');
      if (lower.endsWith('.csv')) found.push({ path: relativePath, format: 'CSV' });
      else if (lower.endsWith('.xlsx')) found.push({ path: relativePath, format: 'XLSX' });
    }
  };
  if (!statSync(root).isDirectory()) {
    throw new MigrationError('INPUT_NOT_FOUND', `${root} is not a directory`, 'Point --input at a directory.', {
      inputRoot: root,
    });
  }
  walk(root);
  return found;
}

/**
 * The configuration inspection reads a bundle under.
 *
 * Exported because the profile is built with the same reader and therefore
 * needs the same configuration: two different synthetic configurations would be
 * two different readings of the same bytes, which is the disagreement the whole
 * profile contract exists to prevent.
 */
export function syntheticConfig(files: readonly { path: string; format: 'CSV' | 'XLSX' }[]): MigrationConfig {
  return {
    configVersion: CONFIG_SCHEMA_VERSION,
    source: { system: 'inspection', namespace: 'inspection', encoding: null },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    localeEvidence: DEFAULT_LOCALE_EVIDENCE,
    limits: DEFAULT_LIMITS,
    policies: { ...DEFAULT_POLICIES, formulaCachedValues: 'ISOLATE_ROW' },
    files: files.map((file, index) => ({
      id: `f${String(index)}`,
      path: file.path,
      format: file.format,
      encoding: null,
      delimiter: null,
      sourceSystem: null,
      // Inspection draws no conclusion about identity, so two files with equal
      // bytes are two occurrences here and not a reason to stop (D69).
      sourceNamespace: file.path,
      sheets: null,
    })),
    records: [],
    associations: [],
    destinationMatching: [],
    occurrences: [],
  };
}

export function inspectionToJson(report: InspectionReport): JsonObject {
  return JSON.parse(JSON.stringify(report)) as JsonObject;
}

export function renderInspectionMarkdown(report: InspectionReport): string {
  const lines: string[] = ['# Source inspection', ''];
  lines.push(`- Core version: ${report.coreVersion}`);
  lines.push(`- Bundle id: ${report.bundleId}`);
  lines.push('');
  lines.push('This report describes the source files. It draws no conclusion about identity and changes nothing.');
  lines.push('');

  for (const file of report.files) {
    lines.push(`## ${file.path}`);
    lines.push('');
    lines.push(`- SHA-256: ${file.sha256}`);
    lines.push(`- ${String(file.byteLength)} bytes, ${file.format}, ${file.encoding} (${file.encodingEvidence})`);
    lines.push('');
    for (const sheet of file.sheets) {
      const name = sheet.sheetName === null ? sheet.sheetId : `${sheet.sheetId} "${sheet.sheetName}"`;
      lines.push(`### Sheet ${name}${sheet.hidden ? ' (hidden)' : ''}`);
      lines.push('');
      lines.push(`${String(sheet.dataRows)} data rows, ${String(sheet.columns.length)} columns, ${String(sheet.rejectedRows)} rows rejected at read time.`);
      lines.push('');
      lines.push('| # | Header | Populated | Blank rate | Distinct | Max length | Unique | Observed shapes |');
      lines.push('| ---: | --- | ---: | ---: | ---: | ---: | --- | --- |');
      for (const column of sheet.columns) {
        const shapes = Object.entries(column.shapes)
          .sort(([a], [b]) => compareCodeUnits(a, b))
          .map(([name2, total]) => `${name2}:${String(total)}`)
          .join(' ');
        const header =
          column.header === null
            ? '(none)'
            : column.headerOccurrence > 1
              ? `${column.header} #${String(column.headerOccurrence)}`
              : column.header;
        lines.push(
          `| ${String(column.columnIndex)} | ${header} | ${String(column.populated)} | ${column.blankRate.toFixed(2)} | ${String(column.distinctValues)} | ${String(column.maxLength)} | ${column.uniqueAcrossPopulatedRows ? 'yes' : 'no'} | ${shapes} |`,
        );
      }
      lines.push('');
      if (sheet.candidateKeyColumns.length > 0) {
        lines.push(
          `Columns unique and fully populated, so usable as a source record id: ${sheet.candidateKeyColumns.join(', ')}.`,
        );
        lines.push('');
      }
      if (sheet.warnings.length > 0) {
        lines.push('Points to settle before running a migration:');
        lines.push('');
        for (const warning of sheet.warnings) lines.push(`- ${warning}`);
        lines.push('');
      }
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

export type { JsonValue };
