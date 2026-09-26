/**
 * The bounded structural inspection of one XLSX file (04 inspectContainer: detected format, worksheet inventory, active-content
 * findings, suspicious structures, expansion and explicit admission problems; "A partially read ZIP cannot report complete safety
 * merely because its central directory looked plausible" — every part is expanded, bounded, CRC-checked and, when XML, parsed).
 *
 * Order: the archive metadata (openArchive: nothing expanded yet) and the active parts by name; then [Content_Types].xml, the
 * package relationships, the workbook and its relationships; then every other part once, in central-directory order — each
 * relationships part checked for external or escaping targets, each worksheet read into its inventory facts, every other XML part
 * parsed by the hardened scanner, every binary part expanded and verified; the shared strings last, resolving only the header
 * cells the inventory needs. Each part is expanded exactly once, so the expansion counter is the archive's total. A finding of a
 * phase refuses the file before the next phase expands anything.
 *
 * The inventory of a worksheet (decision D-DP-3): the used range spans the rows from the first to the last row holding a value or
 * a formula and the columns from A to the rightmost such cell (positional column ordinals count from column A); the header
 * candidate is the used range's first row; rowEstimate is the used range's row count; hidden rows are those of the span (a row
 * hidden by `hidden`, or an absent row under a zero-height default); hidden columns those declared in the span.
 *
 * Loaded inside the isolated child.
 */
import type { DetectedTable } from "@kauro/application";
import type { ScanPartKind } from "@kauro/domain";
import { InspectionRefusal, refusalOf, type Finding } from "../errors.js";
import { ExpansionMeter, drainEntry, openArchive, partDigestOf, expandEntry, type ArchiveLimits, type OpenedArchive } from "../archive/zip.js";
import { XmlScanner, type XmlLimits } from "../xml/scanner.js";
import { inventoryLabels, safeLabel } from "../text.js";
import { activePartFindings, indexPackage, isXmlPart, readRelationships, readWorkbookStructure, sourceOfRels, type PackageIndex, type WorkbookSheet } from "./package.js";
import { readNeededStrings, sharedStringIndex } from "./shared-strings.js";
import { RowSpan, SheetReader, externalDependency, hiddenColumnCount, occupies, type SheetCell, type SheetRow } from "./sheet-reader.js";

export interface XlsxInspectionLimits {
  readonly archive: ArchiveLimits;
  readonly xml: XmlLimits;
  readonly decodedCellBytes: number;
  readonly columns: number;
  readonly inventoryColumns: number;
}

export interface InspectedPart {
  readonly partDigest: string;
  readonly partKind: ScanPartKind;
  readonly bytes: number;
}

export interface XlsxFacts {
  readonly archive: OpenedArchive;
  readonly meter: ExpansionMeter;
  readonly findings: ReadonlyArray<Finding>;
  readonly parts: ReadonlyArray<InspectedPart>;
  readonly tables: ReadonlyArray<DetectedTable>;
  readonly date1904: boolean;
  readonly sharedStrings: boolean;
  readonly checks: ReadonlyArray<string>;
}

type HeaderValue = { readonly kind: "text"; readonly value: string } | { readonly kind: "sst"; readonly index: number } | { readonly kind: "none" };

/** The inventory facts of one worksheet, collected row by row. */
class WorksheetInventory {
  readonly span: RowSpan;
  private maxCol = 0;
  private header: Map<number, HeaderValue> | undefined;
  hiddenRows = 0;
  formulas = 0;
  cacheMissing = false;
  cacheError = false;
  external = false;
  maxSharedIndex = -1;

  constructor(
    readonly sheet: WorkbookSheet,
    private readonly part: string,
    readonly reader: { readonly facts: { zeroHeight: boolean } },
  ) {
    this.span = new RowSpan(-1, () => reader.facts.zeroHeight);
  }

  onRow(row: SheetRow): void {
    const occupied = row.cells.filter(occupies);
    for (const cell of row.cells) {
      if (cell.type === "s" && cell.value !== undefined) this.maxSharedIndex = Math.max(this.maxSharedIndex, sharedStringIndex(cell.value, this.part));
      if (cell.hasFormula) {
        this.formulas += 1;
        if (cell.value === undefined) this.cacheMissing = true;
        if (cell.type === "e") this.cacheError = true;
        if (externalDependency(cell.formula ?? "")) this.external = true;
      }
    }
    if (occupied.length === 0) {
      this.span.emptyRow(row.row, row.hidden);
      return;
    }
    const first = this.header === undefined;
    const confirmed = this.span.valueRow(row.row);
    this.hiddenRows += confirmed.gapHidden + (row.hidden ? 1 : 0);
    for (const cell of occupied) this.maxCol = Math.max(this.maxCol, cell.col);
    if (first) this.header = new Map(row.cells.map((c) => [c.col, headerValue(c, this.part)]));
  }

  neededStrings(into: Set<number>): void {
    for (const v of this.header?.values() ?? []) if (v.kind === "sst") into.add(v.index);
  }

  table(strings: ReadonlyMap<number, string>, mergedCells: number, hiddenColumns: ReadonlyArray<readonly [number, number]>, zeroHeight: boolean, externalHyperlinks: number, embeddedObjects: boolean, limits: XlsxInspectionLimits): DetectedTable {
    void zeroHeight;
    if (embeddedObjects) throw new InspectionRefusal("ACTIVE_CONTENT", "EMBEDDED_OBJECT_REFERENCE", this.part);
    const columnCount = this.maxCol;
    const raw: Array<string | undefined> = [];
    for (let c = 1; c <= columnCount; c++) {
      const v = this.header?.get(c);
      raw.push(v === undefined || v.kind === "none" ? undefined : v.kind === "text" ? v.value : strings.get(v.index));
    }
    const labels = inventoryLabels(raw, columnCount, columnCount);
    const issues = new Set<string>();
    const hiddenCols = hiddenColumnCount(hiddenColumns, columnCount);
    const rows = this.span.first === 0 ? 0 : this.span.last - this.span.first + 1;
    if (rows === 0) issues.add("EMPTY_TABLE");
    if (this.hiddenRows > 0) issues.add("HIDDEN_ROWS_PRESENT");
    if (hiddenCols > 0) issues.add("HIDDEN_COLUMNS_PRESENT");
    if (mergedCells > 0) issues.add("MERGED_CELLS_PRESENT");
    if (this.formulas > 0) issues.add("FORMULAS_PRESENT");
    if (this.cacheMissing) issues.add("FORMULA_CACHE_MISSING");
    if (this.cacheError) issues.add("FORMULA_ERROR_VALUES");
    if (this.external) issues.add("FORMULA_EXTERNAL_DEPENDENCY");
    if (externalHyperlinks > 0) issues.add("EXTERNAL_HYPERLINKS");
    if (columnCount > limits.columns) issues.add("COLUMNS_ABOVE_SELECTION_LIMIT");
    if (labels.some((l) => l.labelState === "DUPLICATE_LABEL")) issues.add("DUPLICATE_HEADER_LABELS");
    if (labels.some((l) => l.labelState === "EMPTY")) issues.add("EMPTY_HEADER_LABELS");
    if (this.sheet.visibility !== "VISIBLE") issues.add("HIDDEN_WORKSHEET");
    const formulaCache = this.formulas === 0 ? "NOT_APPLICABLE" : this.external ? "EXTERNAL_DEPENDENCY" : this.cacheError ? "ERROR_VALUES" : this.cacheMissing ? "SOME_MISSING" : "ALL_PRESENT";
    const name = safeLabel(this.sheet.name);
    const table: DetectedTable = {
      ordinal: this.sheet.ordinal,
      kind: "WORKSHEET",
      ...(name === undefined ? {} : { name }),
      visibility: this.sheet.visibility,
      columnCount,
      rowEstimate: rows,
      hasFormulas: this.formulas > 0,
      formulaCache,
      mergedCellCount: mergedCells,
      hiddenRowCount: this.hiddenRows,
      hiddenColumnCount: hiddenCols,
      issues: [...issues].sort().slice(0, 64),
      columns: labels.map((l, ordinal) => (l.label === undefined ? { ordinal, labelState: l.labelState } : { ordinal, label: l.label, labelState: l.labelState })),
    };
    return table;
  }
}

function headerValue(cell: SheetCell, part: string): HeaderValue {
  if (cell.value === undefined) return { kind: "none" };
  if (cell.type === "s") return { kind: "sst", index: sharedStringIndex(cell.value, part) };
  return { kind: "text", value: cell.value };
}

function kindOf(name: string, structure: { readonly workbookPart: string; readonly sharedStringsPart?: string }, sheets: ReadonlySet<string>): ScanPartKind {
  const key = name.normalize("NFC").toLowerCase();
  if (key === structure.workbookPart.normalize("NFC").toLowerCase()) return "WORKBOOK_PART";
  if (sheets.has(key)) return "WORKSHEET_PART";
  if (structure.sharedStringsPart !== undefined && key === structure.sharedStringsPart.normalize("NFC").toLowerCase()) return "SHARED_STRINGS_PART";
  if (/\.rels$/.test(key)) return "RELATIONSHIPS_PART";
  if (/(^|\/)styles\.xml$/.test(key)) return "STYLES_PART";
  return "OTHER_PART";
}

class Refused extends Error {
  constructor(readonly findings: ReadonlyArray<Finding>) {
    super("refused");
  }
}

function refuseIf(findings: ReadonlyArray<Finding>): void {
  if (findings.length > 0) throw new Refused(findings);
}

/**
 * Inspects one XLSX file. Returns its facts; a refused file returns its findings (the caller sets the refusal class by
 * precedence) with the tables and parts collected so far discarded.
 */
export async function inspectXlsx(path: string, limits: XlsxInspectionLimits): Promise<XlsxFacts> {
  const archive = openArchive(path, limits.archive);
  const meter = new ExpansionMeter(limits.archive);
  const checks: string[] = [];
  const empty = (findings: ReadonlyArray<Finding>): XlsxFacts => ({ archive, meter, findings, parts: [], tables: [], date1904: false, sharedStrings: false, checks });
  try {
    refuseIf(archive.findings);
    checks.push("ARCHIVE_METADATA", "ARCHIVE_DECLARED_LIMITS");
    const index: PackageIndex = indexPackage(archive);
    refuseIf(activePartFindings(index));
    const structure = await readWorkbookStructure(index, meter, limits.xml);
    refuseIf(structure.findings);
    checks.push("WORKBOOK_STRUCTURE");
    const sheetKeys = new Set(structure.sheets.map((s) => s.partName.normalize("NFC").toLowerCase()));
    const sheetsByKey = new Map(structure.sheets.map((s) => [s.partName.normalize("NFC").toLowerCase(), s]));
    const inventories = new Map<number, { inventory: WorksheetInventory; reader: SheetReader }>();
    const hyperlinksBySheet = new Map<string, number>();
    const findings: Finding[] = [];
    const sstKey = structure.sharedStringsPart?.normalize("NFC").toLowerCase();
    for (const entry of archive.entries) {
      if (entry.directory || structure.expanded.has(entry.key) || entry.key === sstKey) continue;
      if (/\.rels$/.test(entry.key)) {
        const rels = await readRelationships(index, entry, meter, limits.xml);
        findings.push(...rels.findings);
        const source = sourceOfRels(entry.name);
        if (source !== undefined && rels.externalHyperlinks > 0) hyperlinksBySheet.set(source.normalize("NFC").toLowerCase(), rels.externalHyperlinks);
        refuseIf(findings);
        continue;
      }
      const sheet = sheetsByKey.get(entry.key);
      if (sheet !== undefined) {
        const part = partDigestOf(entry.name);
        let inventory: WorksheetInventory | undefined;
        const reader = new SheetReader(part, limits.decodedCellBytes, (row) => inventory?.onRow(row));
        inventory = new WorksheetInventory(sheet, part, reader);
        const scanner = new XmlScanner(reader, limits.xml, part);
        for await (const chunk of expandEntry(archive, entry, meter)) scanner.write(chunk);
        scanner.end();
        inventories.set(sheet.ordinal, { inventory, reader });
        continue;
      }
      if (isXmlPart(entry.name)) {
        const scanner = new XmlScanner({ open(): void {}, close(): void {}, text(): void {} }, limits.xml, partDigestOf(entry.name));
        for await (const chunk of expandEntry(archive, entry, meter)) scanner.write(chunk);
        scanner.end();
      } else await drainEntry(archive, entry, meter);
    }
    refuseIf(findings);
    const needed = new Set<number>();
    let maxIndex = -1;
    for (const { inventory } of inventories.values()) {
      inventory.neededStrings(needed);
      maxIndex = Math.max(maxIndex, inventory.maxSharedIndex);
    }
    const sstEntry = sstKey === undefined ? undefined : index.byKey.get(sstKey);
    const { strings } = await readNeededStrings(index, sstEntry, needed, maxIndex, meter, limits.xml, limits.decodedCellBytes);
    checks.push("ARCHIVE_ENTRIES_EXPANDED", "ARCHIVE_CRC", "XML_WELL_FORMED_NO_DTD", "RELATIONSHIPS_INTERNAL", "ACTIVE_CONTENT_ABSENT");
    const tables: DetectedTable[] = [];
    let inventoried = 0;
    for (const sheet of structure.sheets) {
      const found = inventories.get(sheet.ordinal);
      if (found === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
      const key = sheet.partName.normalize("NFC").toLowerCase();
      const table = found.inventory.table(strings, found.reader.facts.mergedCells, found.reader.facts.hiddenColumns, found.reader.facts.zeroHeight, hyperlinksBySheet.get(key) ?? 0, found.reader.facts.embeddedObjects, limits);
      inventoried += table.columnCount;
      if (inventoried > limits.inventoryColumns) throw new InspectionRefusal("RESOURCE_LIMIT", "INVENTORY_LIMIT");
      tables.push(table);
    }
    checks.push("WORKSHEET_INVENTORY");
    const parts: InspectedPart[] = archive.entries.filter((e) => !e.directory).map((e) => ({ partDigest: partDigestOf(e.name), partKind: kindOf(e.name, structure, sheetKeys), bytes: e.uncompressedSize }));
    return { archive, meter, findings: [], parts, tables, date1904: structure.date1904, sharedStrings: sstEntry !== undefined, checks };
  } catch (error) {
    if (error instanceof Refused) return empty(error.findings);
    if (error instanceof InspectionRefusal) return empty([{ refusal: error.refusal, code: error.code, ...(error.part === undefined ? {} : { part: error.part }) }]);
    throw error;
  }
}

export { refusalOf };
