/**
 * The counting task, run inside the isolated child (decision D-ISO-1 applies to every parse of an untrusted file). It counts, per
 * included table and exactly, what 03 "Count the correct population" defines (decision D-DP-4 fixes the parser-level rules):
 *
 * - physical rows: the parsed non-header rows of the table. A worksheet's rows are the used-range rows after the header row (the
 *   header's zero-based index within the used range, or none) up to the last row holding a value or a formula, empty rows between
 *   them included; a hidden row is excluded when the parser choice excludes hidden rows (and counted as excluded). A CSV's rows are
 *   its records after the first (header FIRST_RECORD) or all of them (NONE), blank lines counted or skipped as chosen.
 * - logical records per projection: ROW — every physical row is one occurrence; REFERENCED_ENTITY — the distinct non-empty key
 *   tuples (exact string equality of the confirmed key cells, counted in bounded memory), plus one occurrence per row whose key is
 *   empty but whose field group is not (an unkeyed occurrence stays a distinct candidate; 03: "repeated organization occurrences
 *   remain distinct candidates").
 * - association edges: per declared association, the physical rows whose target projection's key is present (duplicates counted,
 *   before any edge deduplication).
 *
 * Formulas are inert: formula text is never evaluated. Under REJECT_FORMULAS a counted formula fails the table (FORMULAS_REJECTED);
 * under NOT_PRESENT so does any formula (FORMULA_POLICY_MISMATCH); under USE_PRESENT_CACHED_VALUES_WITH_DISCLOSURE the stored cache
 * is the value and a counted formula without one, with an error cache or with an external dependency fails the table
 * (FORMULA_CACHE_MISSING, FORMULA_CACHE_ERROR, FORMULA_EXTERNAL_DEPENDENCY). A counted cell is one of a data row that is counted,
 * in a selected column (every column when none is listed), not in a hidden column the choice excludes. A table whose bytes violate
 * a parser bound or cannot be decoded as chosen fails with that code.
 *
 * Loaded inside the isolated child.
 */
import type { CsvParserChoice, WorksheetParserChoice } from "@kauro/domain";
import { InspectionRefusal, StopParsing } from "../errors.js";
import { ExpansionMeter, expandEntry, openArchive, partDigestOf, type ArchiveLimits } from "../archive/zip.js";
import { XmlScanner, type XmlLimits } from "../xml/scanner.js";
import { decodedText } from "../csv/inspect-csv.js";
import { CsvTokenizer } from "../csv/tokenizer.js";
import { delimiterChar } from "../csv/dialect.js";
import { indexPackage, lookup, readWorkbookStructure, type PackageIndex } from "../xlsx/package.js";
import { SharedStringStore, sharedStringIndex } from "../xlsx/shared-strings.js";
import { RowSpan, SheetReader, externalDependency, isHiddenColumn, occupies, type SheetCell } from "../xlsx/sheet-reader.js";
import { DistinctCounter } from "./distinct.js";
import type { EvaluatePayload, EvaluateResult, FilePlan, ProjectionPlan, TableCount, TablePlan } from "./plan.js";

/** The per-table counters shared by the worksheet and CSV paths. */
class TableCounters {
  physicalRows = 0;
  excludedHiddenRows = 0;
  columnCount = 0;
  readonly failures = new Set<string>();
  readonly issues = new Set<string>();
  private readonly distinct = new Map<string, DistinctCounter>();
  private readonly unkeyed = new Map<string, number>();
  private readonly edges = new Map<string, number>();
  private readonly referenced: ReadonlyArray<ProjectionPlan>;
  private readonly targetOf: ReadonlyMap<string, ProjectionPlan>;
  /** The zero-based column ordinals whose values the projections read. */
  readonly neededOrdinals: ReadonlySet<number>;

  constructor(
    readonly plan: TablePlan,
    workDir: string,
    budget: number,
  ) {
    this.referenced = plan.projections.filter((p) => p.kind === "REFERENCED_ENTITY");
    for (const p of this.referenced) {
      this.distinct.set(p.projectionKey, new DistinctCounter(workDir, `${plan.ordinal}-${this.distinct.size}`, budget));
      this.unkeyed.set(p.projectionKey, 0);
    }
    const byKey = new Map(plan.projections.map((p) => [p.projectionKey, p]));
    const targets = new Map<string, ProjectionPlan>();
    for (const a of plan.associations) {
      const target = byKey.get(a.toProjectionKey);
      if (target !== undefined) targets.set(a.associationKey, target);
      this.edges.set(a.associationKey, 0);
    }
    this.targetOf = targets;
    const needed = new Set<number>();
    for (const p of this.referenced) for (const o of [...p.keyOrdinals, ...p.fieldOrdinals]) needed.add(o);
    this.neededOrdinals = needed;
  }

  /** One counted data row: `valueAt(ordinal)` is the cell text, "" when empty or absent. */
  dataRow(valueAt: (ordinal: number) => string): void {
    this.physicalRows += 1;
    const keyOf = new Map<string, string | undefined>();
    for (const p of this.referenced) {
      const key = p.keyOrdinals.map(valueAt);
      if (key.every((k) => k === "")) {
        keyOf.set(p.projectionKey, undefined);
        if (p.fieldOrdinals.some((o) => valueAt(o) !== "")) this.unkeyed.set(p.projectionKey, (this.unkeyed.get(p.projectionKey) ?? 0) + 1);
      } else {
        const encoded = JSON.stringify(key);
        keyOf.set(p.projectionKey, encoded);
        (this.distinct.get(p.projectionKey) as DistinctCounter).add(encoded);
      }
    }
    for (const [association, target] of this.targetOf) {
      if (keyOf.get(target.projectionKey) !== undefined) this.edges.set(association, (this.edges.get(association) ?? 0) + 1);
    }
  }

  /** Empty data rows (no stored value at all): ROW occurrences only. */
  emptyRows(n: number): void {
    this.physicalRows += n;
  }

  result(): TableCount {
    const projections = this.plan.projections.map((p) => {
      if (p.kind === "ROW") return { projectionKey: p.projectionKey, logicalRecords: this.physicalRows, spilledKeys: 0 };
      const counter = this.distinct.get(p.projectionKey) as DistinctCounter;
      return { projectionKey: p.projectionKey, logicalRecords: counter.count() + (this.unkeyed.get(p.projectionKey) ?? 0), spilledKeys: counter.spilledKeys };
    });
    return {
      tableId: this.plan.tableId,
      physicalRows: this.physicalRows,
      columnCount: this.columnCount,
      excludedHiddenRows: this.excludedHiddenRows,
      issues: [...this.issues].sort(),
      failures: [...this.failures].sort(),
      projections,
      associations: this.plan.associations.map((a) => ({ associationKey: a.associationKey, edges: this.edges.get(a.associationKey) ?? 0 })),
    };
  }

  failed(code: string): TableCount {
    return {
      tableId: this.plan.tableId,
      physicalRows: 0,
      columnCount: 0,
      excludedHiddenRows: 0,
      issues: [],
      failures: [code],
      projections: this.plan.projections.map((p) => ({ projectionKey: p.projectionKey, logicalRecords: 0, spilledKeys: 0 })),
      associations: this.plan.associations.map((a) => ({ associationKey: a.associationKey, edges: 0 })),
    };
  }
}

async function countCsv(file: FilePlan, plan: TablePlan, counters: TableCounters, limits: EvaluatePayload["limits"]): Promise<void> {
  const choice = plan.parser as CsvParserChoice;
  let first = true;
  const tokenizer = new CsvTokenizer(
    { delimiter: delimiterChar(choice.delimiter), quote: choice.quote === "DOUBLE_QUOTE" ? '"' : null },
    { cellBytes: limits.decodedCellBytes, recordBytes: limits.decodedRecordBytes, maxFields: 16_384 },
    (fields, facts) => {
      if (fields.length > counters.columnCount) counters.columnCount = fields.length;
      if (first) {
        first = false;
        if (choice.header.mode === "FIRST_RECORD") return;
      }
      if (facts.blank && choice.blankLines === "SKIP") return;
      counters.dataRow((o) => fields[o] ?? "");
    },
  );
  for await (const text of decodedText(file.path, choice.encoding)) tokenizer.push(text);
  tokenizer.end();
}

async function countWorksheet(index: PackageIndex, partName: string, plan: TablePlan, counters: TableCounters, sst: SharedStringStore | undefined, meter: ExpansionMeter, xml: XmlLimits, cellBytes: number, recordBytes: number): Promise<void> {
  const choice = plan.parser as WorksheetParserChoice;
  const entry = lookup(index, partName);
  if (entry === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  const part = partDigestOf(entry.name);
  const excludeHiddenRows = choice.hiddenRows === "EXCLUDE";
  const excludeHiddenColumns = choice.hiddenColumns === "EXCLUDE";
  const selected = plan.selectedColumns === undefined ? undefined : new Set(plan.selectedColumns);
  const headerIndex = choice.header.mode === "ROW" ? choice.header.rowIndex : -1;
  const reader: SheetReader = new SheetReader(part, cellBytes, recordBytes, (row) => {
    const occupied = row.cells.filter(occupies);
    if (occupied.length === 0) {
      span.emptyRow(row.row, row.hidden);
      return;
    }
    for (const c of occupied) if (c.col > counters.columnCount) counters.columnCount = c.col;
    const confirmed = span.valueRow(row.row);
    const hiddenGap = excludeHiddenRows ? confirmed.gapHidden : 0;
    counters.emptyRows(confirmed.gapRows - hiddenGap);
    counters.excludedHiddenRows += hiddenGap;
    if (!confirmed.isDataRow) return;
    if (row.hidden && excludeHiddenRows) {
      counters.excludedHiddenRows += 1;
      return;
    }
    const byColumn = new Map<number, SheetCell>();
    for (const cell of row.cells) {
      const ordinal = cell.col - 1;
      const counted = (selected === undefined || selected.has(ordinal)) && !(excludeHiddenColumns && isHiddenColumn(reader.facts.hiddenColumns, cell.col));
      if (counted && cell.hasFormula) {
        if (choice.formulas === "REJECT_FORMULAS") counters.failures.add("FORMULAS_REJECTED");
        else if (choice.formulas === "NOT_PRESENT") counters.failures.add("FORMULA_POLICY_MISMATCH");
        else {
          if (cell.value === undefined) counters.failures.add("FORMULA_CACHE_MISSING");
          if (cell.type === "e") counters.failures.add("FORMULA_CACHE_ERROR");
          if (externalDependency(cell.formula ?? "")) counters.failures.add("FORMULA_EXTERNAL_DEPENDENCY");
        }
      }
      if (counters.neededOrdinals.has(ordinal)) byColumn.set(ordinal, cell);
    }
    counters.dataRow((ordinal) => {
      const cell = byColumn.get(ordinal);
      if (cell === undefined || cell.value === undefined) return "";
      if (cell.type === "s") {
        if (sst === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "SHARED_STRING_MISSING", part);
        return sst.get(sharedStringIndex(cell.value, part));
      }
      return cell.value;
    });
  });
  const span = new RowSpan(headerIndex, () => reader.facts.zeroHeight);
  const scanner = new XmlScanner(reader, xml, part);
  for await (const chunk of expandEntry(index.archive, entry, meter)) scanner.write(chunk);
  scanner.end();
  if (excludeHiddenRows && counters.excludedHiddenRows > 0) counters.issues.add("HIDDEN_ROWS_EXCLUDED");
}

export async function run(payload: EvaluatePayload, context: { readonly workDir: string }): Promise<EvaluateResult> {
  const limits = payload.limits;
  const archiveLimits: ArchiveLimits = {
    maxEntries: limits.maxArchiveEntries,
    partBytes: limits.xlsxExpandedPartBytes,
    totalBytes: limits.xlsxExpandedTotalBytes,
    maxCompressionRatio: limits.maxCompressionRatio,
    ratioGraceBytes: limits.ratioGraceBytes,
    centralDirectoryBytes: limits.centralDirectoryBytes,
  };
  const xml: XmlLimits = { maxDepth: limits.maxXmlDepth, maxTokenChars: Math.max(65_536, limits.decodedCellBytes) };
  const tables: TableCount[] = [];
  let decompressedBytes = 0;
  for (const file of payload.files) {
    if (file.format === "CSV") {
      for (const plan of file.tables) {
        const counters = new TableCounters(plan, context.workDir, payload.distinctKeysInMemory);
        try {
          await countCsv(file, plan, counters, limits);
          tables.push(counters.result());
        } catch (error) {
          if (!(error instanceof InspectionRefusal) && !(error instanceof StopParsing)) throw error;
          tables.push(counters.failed(error instanceof InspectionRefusal ? error.code : "PARSE_STOPPED"));
        }
      }
      continue;
    }
    const archive = openArchive(file.path, archiveLimits);
    const meter = new ExpansionMeter(archiveLimits);
    if (archive.findings.length > 0) {
      for (const plan of file.tables) tables.push(new TableCounters(plan, context.workDir, payload.distinctKeysInMemory).failed((archive.findings[0] as { code: string }).code));
      continue;
    }
    const index = indexPackage(archive);
    let sst: SharedStringStore | undefined;
    try {
      const structure = await readWorkbookStructure(index, meter, xml);
      if (structure.findings.length > 0) throw new InspectionRefusal((structure.findings[0] as { refusal: "CORRUPT_STRUCTURE" }).refusal, (structure.findings[0] as { code: string }).code);
      const needsStrings = file.tables.some((t) => t.projections.some((p) => p.kind === "REFERENCED_ENTITY"));
      if (needsStrings && structure.sharedStringsPart !== undefined) {
        sst = await SharedStringStore.build(index, lookup(index, structure.sharedStringsPart), context.workDir, meter, xml, limits.decodedCellBytes);
      }
      for (const plan of file.tables) {
        const counters = new TableCounters(plan, context.workDir, payload.distinctKeysInMemory);
        const sheet = structure.sheets.find((s) => s.ordinal === plan.ordinal);
        try {
          if (sheet === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "TABLE_NOT_FOUND");
          await countWorksheet(index, sheet.partName, plan, counters, sst, meter, xml, limits.decodedCellBytes, limits.decodedRecordBytes);
          tables.push(counters.result());
        } catch (error) {
          if (!(error instanceof InspectionRefusal)) throw error;
          tables.push(counters.failed(error.code));
        }
      }
    } catch (error) {
      if (!(error instanceof InspectionRefusal)) throw error;
      for (const plan of file.tables) if (!tables.some((t) => t.tableId === plan.tableId)) tables.push(new TableCounters(plan, context.workDir, payload.distinctKeysInMemory).failed(error.code));
    } finally {
      sst?.close();
      decompressedBytes += meter.decompressedBytes;
    }
  }
  return { tables, decompressedBytes };
}
