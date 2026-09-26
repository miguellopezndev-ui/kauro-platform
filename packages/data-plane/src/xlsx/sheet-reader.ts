/**
 * A streaming worksheet reader (04 "XLSX parser requirements": a far-away cell coordinate cannot cause allocation of millions of
 * empty cells; formula text is inert; error values, empty cells, absent cells and formula-without-cache are distinct; merged cells
 * are represented as observed; hidden worksheets remain in the inventory; hidden rows and columns are disclosed).
 *
 * It turns the XML events of one worksheet part into one record per `<row>` element, holding only the cells that element
 * contains: its 1-based index, its hidden flag, and per cell its 1-based column, its type (`t`), its stored value text (`<v>`, or
 * the inline string), whether it has a formula and the formula text (bounded, never evaluated). Rows and cells must be strictly
 * ascending and inside the SpreadsheetML grid (CORRUPT_STRUCTURE otherwise), so a reader never looks back. Sheet-level facts —
 * the hidden column ranges, zero-height default rows, merged cells, embedded object references — are collected on the way.
 *
 * Loaded inside the isolated child.
 */
import { InspectionRefusal } from "../errors.js";
import { TextAccumulator, type XmlAttributes, type XmlEvents } from "../xml/scanner.js";

export const GRID_ROWS = 1_048_576;
export const GRID_COLUMNS = 16_384;

export interface SheetCell {
  /** 1-based column (A = 1). */
  readonly col: number;
  /** The `t` attribute: s, str, inlineStr, n, b, e or d ("n" when absent). */
  readonly type: string;
  /** The stored value text: the `<v>` text, or the inline string; absent when the cell stores none. */
  readonly value?: string;
  readonly hasFormula: boolean;
  /** The formula text, never evaluated (present when hasFormula). */
  readonly formula?: string;
}

export interface SheetRow {
  /** 1-based row index. */
  readonly row: number;
  readonly hidden: boolean;
  readonly cells: ReadonlyArray<SheetCell>;
}

export interface SheetFacts {
  zeroHeight: boolean;
  /** Hidden column ranges [min, max] (1-based, inclusive) as `<col>` declares them. */
  readonly hiddenColumns: Array<readonly [number, number]>;
  mergedCells: number;
  /** `<oleObjects>` or `<controls>` in the sheet (the parts are refused by name too). */
  embeddedObjects: boolean;
}

/** Decodes an A1 reference: [row, col], or undefined when it is not one inside the grid. */
export function cellReference(ref: string): readonly [number, number] | undefined {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (m === null) return undefined;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (col > GRID_COLUMNS || row > GRID_ROWS) return undefined;
  return [row, col];
}

export class SheetReader implements XmlEvents {
  readonly facts: SheetFacts = { zeroHeight: false, hiddenColumns: [], mergedCells: 0, embeddedObjects: false };
  private readonly value: TextAccumulator;
  private readonly formulaText: TextAccumulator;
  private inSheetData = false;
  private row: { row: number; hidden: boolean; cells: SheetCell[]; lastCol: number } | undefined;
  private lastRow = 0;
  private cell: { col: number; type: string; value?: string; hasFormula: boolean; formula?: string } | undefined;
  private capture: "v" | "f" | "t" | undefined;
  private inInline = false;
  private inlineText: string[] = [];
  private phonetic = 0;

  constructor(
    private readonly part: string,
    cellBytes: number,
    private readonly onRow: (row: SheetRow) => void,
  ) {
    this.value = new TextAccumulator(cellBytes, part, "CELL_BYTES_LIMIT");
    this.formulaText = new TextAccumulator(cellBytes, part, "CELL_BYTES_LIMIT");
  }

  private corrupt(code: string): InspectionRefusal {
    return new InspectionRefusal("CORRUPT_STRUCTURE", code, this.part);
  }

  open(name: string, attributes: XmlAttributes): void {
    switch (name) {
      case "sheetFormatPr":
        this.facts.zeroHeight = /^(1|true)$/.test(attributes.get("zeroHeight") ?? "");
        return;
      case "col": {
        if (!/^(1|true)$/.test(attributes.get("hidden") ?? "")) return;
        const min = Number(attributes.get("min"));
        const max = Number(attributes.get("max"));
        if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > GRID_COLUMNS) throw this.corrupt("COLUMN_RANGE_INVALID");
        this.facts.hiddenColumns.push([min, max]);
        return;
      }
      case "mergeCell":
        this.facts.mergedCells += 1;
        return;
      case "oleObjects":
      case "controls":
        this.facts.embeddedObjects = true;
        return;
      case "sheetData":
        this.inSheetData = true;
        return;
      case "row": {
        if (!this.inSheetData || this.row !== undefined) throw this.corrupt("SHEET_STRUCTURE_INVALID");
        const r = attributes.get("r");
        const index = r === undefined ? this.lastRow + 1 : Number(r);
        if (!Number.isInteger(index) || index < 1 || index > GRID_ROWS) throw this.corrupt("CELL_REFERENCE_INVALID");
        if (index <= this.lastRow) throw this.corrupt("ROW_ORDER");
        this.row = { row: index, hidden: /^(1|true)$/.test(attributes.get("hidden") ?? ""), cells: [], lastCol: 0 };
        this.lastRow = index;
        return;
      }
      case "c": {
        if (this.row === undefined || this.cell !== undefined) throw this.corrupt("SHEET_STRUCTURE_INVALID");
        const ref = attributes.get("r");
        let col: number;
        if (ref === undefined) col = this.row.lastCol + 1;
        else {
          const decoded = cellReference(ref);
          if (decoded === undefined || decoded[0] !== this.row.row) throw this.corrupt("CELL_REFERENCE_INVALID");
          col = decoded[1];
        }
        if (col > GRID_COLUMNS) throw this.corrupt("CELL_REFERENCE_INVALID");
        if (col <= this.row.lastCol) throw this.corrupt("CELL_ORDER");
        this.row.lastCol = col;
        this.cell = { col, type: attributes.get("t") ?? "n", hasFormula: false };
        return;
      }
      case "v":
        if (this.cell !== undefined) this.capture = "v";
        return;
      case "f":
        if (this.cell !== undefined) {
          this.cell.hasFormula = true;
          this.capture = "f";
        }
        return;
      case "is":
        if (this.cell !== undefined) {
          this.inInline = true;
          this.inlineText = [];
        }
        return;
      case "rPh":
        this.phonetic += 1;
        return;
      case "t":
        if (this.inInline && this.phonetic === 0) this.capture = "t";
        return;
      default:
        return;
    }
  }

  text(value: string): void {
    if (this.capture === "v" || this.capture === "t") this.value.add(value);
    else if (this.capture === "f") this.formulaText.add(value);
  }

  close(name: string): void {
    switch (name) {
      case "v":
        if (this.cell !== undefined && this.capture === "v") this.cell.value = this.value.take();
        this.capture = undefined;
        return;
      case "f":
        if (this.cell !== undefined && this.capture === "f") this.cell.formula = this.formulaText.take();
        this.capture = undefined;
        return;
      case "t":
        if (this.capture === "t") this.inlineText.push(this.value.take());
        this.capture = undefined;
        return;
      case "rPh":
        this.phonetic -= 1;
        return;
      case "is":
        if (this.cell !== undefined && this.inInline) this.cell.value = this.inlineText.join("");
        this.inInline = false;
        return;
      case "c": {
        const cell = this.cell;
        if (cell === undefined || this.row === undefined) return;
        const out: SheetCell = {
          col: cell.col,
          type: cell.type,
          hasFormula: cell.hasFormula,
          ...(cell.value === undefined ? {} : { value: cell.value }),
          ...(cell.hasFormula ? { formula: cell.formula ?? "" } : {}),
        };
        this.row.cells.push(out);
        this.cell = undefined;
        return;
      }
      case "row": {
        const row = this.row;
        this.row = undefined;
        if (row !== undefined) this.onRow({ row: row.row, hidden: row.hidden, cells: row.cells });
        return;
      }
      case "sheetData":
        this.inSheetData = false;
        return;
      default:
        return;
    }
  }
}

/** A cell that occupies the used range: it stores a value or a formula (a formula without its cache still occupies it). */
export function occupies(cell: SheetCell): boolean {
  return cell.value !== undefined || cell.hasFormula;
}

/**
 * Formula text that depends on something outside the workbook (04: "Missing caches, error caches, external dependencies or
 * unsupported formula result types are unresolved or rejected"): an external workbook reference ([n] or '[Book]Sheet'!), a DDE
 * link (app|topic!item), or a function that reaches outside (WEBSERVICE, RTD, CALL, REGISTER, REGISTER.ID, EXEC). String literals
 * are ignored. The text is only matched, never evaluated.
 */
export function externalDependency(formula: string): boolean {
  const code = formula.replace(/"(?:[^"]|"")*"/g, '""');
  if (/\[[^\]]*\]/.test(code)) return true;
  if (/[A-Za-z0-9_.]+\|/.test(code)) return true;
  return /(^|[^A-Za-z0-9_.])(_xlfn\.)?(WEBSERVICE|RTD|CALL|REGISTER|REGISTER\.ID|EXEC)\s*\(/i.test(code);
}

/** Tracks the used range's row span of one worksheet: its first and last value rows and the rows between them. */
export class RowSpan {
  first = 0;
  last = 0;
  private pendingExplicit = 0;
  private pendingHidden = 0;

  constructor(
    /** Zero-based index, within the used range, of the header row (-1: no header). Rows at or before it are not data rows. */
    private readonly headerIndex: number,
    private readonly zeroHeight: () => boolean,
  ) {}

  /** A `<row>` element without any occupying cell. */
  emptyRow(row: number, hidden: boolean): void {
    if (this.first === 0 || row - this.first <= this.headerIndex) return;
    this.pendingExplicit += 1;
    if (hidden) this.pendingHidden += 1;
  }

  /**
   * A row with an occupying cell. Returns the data rows it confirms: the rows between the previous value row and this one (their
   * count and how many of them are hidden), and whether this row itself is a data row.
   */
  valueRow(row: number): { readonly gapRows: number; readonly gapHidden: number; readonly isDataRow: boolean } {
    const gapFrom = this.first === 0 ? row : this.last + 1;
    if (this.first === 0) this.first = row;
    const lowest = this.first + this.headerIndex + 1;
    const lo = Math.max(gapFrom, lowest);
    const gapRows = Math.max(0, row - lo);
    const absent = Math.max(0, gapRows - this.pendingExplicit);
    const gapHidden = this.pendingHidden + (this.zeroHeight() ? absent : 0);
    this.pendingExplicit = 0;
    this.pendingHidden = 0;
    this.last = row;
    return { gapRows, gapHidden, isDataRow: row >= lowest };
  }
}

/** The number of hidden columns in [1, maxCol] given the declared (possibly overlapping) hidden ranges. */
export function hiddenColumnCount(ranges: ReadonlyArray<readonly [number, number]>, maxCol: number): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let count = 0;
  let cursor = 0;
  for (const [min, max] of sorted) {
    const lo = Math.max(min, cursor + 1);
    const hi = Math.min(max, maxCol);
    if (hi >= lo) count += hi - lo + 1;
    cursor = Math.max(cursor, max);
  }
  return count;
}

export function isHiddenColumn(ranges: ReadonlyArray<readonly [number, number]>, col: number): boolean {
  return ranges.some(([min, max]) => col >= min && col <= max);
}
