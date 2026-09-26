/**
 * The preview task, run inside the isolated child (decision D-SAPI-7: at most 20 rows of at most 50 columns, each cell at most 200
 * characters of decoded text; decision D-DP-5 fixes what the rows are). The rows are the table's own rows from its top — a
 * worksheet's used-range rows from the first row holding a value (empty rows between as all-empty rows), a CSV's records from the
 * first — so the agency sees the header candidates it chooses among. A cell is its stored text: a shared or inline string, the
 * stored number or boolean text, a formula's cached value (the formula is never evaluated; without a cache the cell is empty);
 * null is an empty cell. Parsing stops once the window is full (the preview reads no more than it shows, plus one row to know
 * whether it was cut).
 *
 * Loaded inside the isolated child.
 */
import { InspectionRefusal, StopParsing } from "../errors.js";
import { ExpansionMeter, expandEntry, openArchive, partDigestOf, type ArchiveLimits } from "../archive/zip.js";
import { XmlScanner, type XmlLimits } from "../xml/scanner.js";
import { decodedText, sniffEncoding } from "../csv/inspect-csv.js";
import { CsvTokenizer } from "../csv/tokenizer.js";
import { delimiterChar, discoverDialect } from "../csv/dialect.js";
import type { CsvEncoding } from "../csv/encoding.js";
import { cutCodePoints } from "../text.js";
import { indexPackage, lookup, readWorkbookStructure } from "../xlsx/package.js";
import { readNeededStrings, sharedStringIndex } from "../xlsx/shared-strings.js";
import { SheetReader, occupies } from "../xlsx/sheet-reader.js";

export interface PreviewPayload {
  readonly input: string;
  readonly format: "CSV" | "XLSX";
  readonly ordinal: number;
  readonly csv?: { readonly encoding: CsvEncoding; readonly delimiter: "COMMA" | "SEMICOLON" | "TAB" | "PIPE"; readonly quote: "DOUBLE_QUOTE" | "NONE" };
  readonly bounds: { readonly rows: number; readonly columns: number; readonly cellChars: number };
  readonly limits: {
    readonly decodedCellBytes: number;
    readonly decodedRecordBytes: number;
    readonly maxArchiveEntries: number;
    readonly xlsxExpandedPartBytes: number;
    readonly xlsxExpandedTotalBytes: number;
    readonly maxCompressionRatio: number;
    readonly ratioGraceBytes: number;
    readonly centralDirectoryBytes: number;
    readonly maxXmlDepth: number;
  };
}

export interface PreviewResult {
  readonly rows: ReadonlyArray<ReadonlyArray<string | null>>;
  readonly columnCount: number;
  readonly truncated: boolean;
}

type Slot = { readonly text: string } | { readonly sst: number } | null;

function window(slots: ReadonlyArray<ReadonlyArray<Slot>>, resolve: (i: number) => string, bounds: PreviewPayload["bounds"], cut: boolean): PreviewResult {
  let truncated = cut;
  const columnCount = Math.min(bounds.columns, slots.reduce((n, r) => Math.max(n, r.length), 0));
  const rows = slots.map((r) => {
    const out: Array<string | null> = [];
    for (let c = 0; c < columnCount; c++) {
      const s = r[c] ?? null;
      if (s === null) {
        out.push(null);
        continue;
      }
      const raw = "text" in s ? s.text : resolve(s.sst);
      const { text, cut: cellCut } = cutCodePoints(raw, bounds.cellChars);
      if (cellCut) truncated = true;
      out.push(text);
    }
    return out;
  });
  return { rows, columnCount, truncated };
}

async function previewCsv(payload: PreviewPayload): Promise<PreviewResult> {
  const bounds = payload.bounds;
  const cellLimits = { cellBytes: payload.limits.decodedCellBytes, recordBytes: payload.limits.decodedRecordBytes, maxFields: 16_384 };
  let dialect = payload.csv;
  if (dialect === undefined) {
    const evidence = await sniffEncoding(payload.input);
    let sample = "";
    for await (const text of decodedText(payload.input, evidence.encoding)) {
      sample += text;
      if (sample.length >= 1_048_576) break;
    }
    dialect = { encoding: evidence.encoding, delimiter: discoverDialect(sample, sample.length < 1_048_576, cellLimits).delimiter, quote: "DOUBLE_QUOTE" };
  }
  const slots: Slot[][] = [];
  let cut = false;
  const tokenizer = new CsvTokenizer({ delimiter: delimiterChar(dialect.delimiter), quote: dialect.quote === "DOUBLE_QUOTE" ? '"' : null }, cellLimits, (fields) => {
    if (slots.length === bounds.rows) {
      cut = true;
      return false;
    }
    if (fields.length > bounds.columns) cut = true;
    slots.push(fields.slice(0, bounds.columns).map((f) => (f === "" ? null : { text: f })));
    return true;
  });
  try {
    for await (const text of decodedText(payload.input, dialect.encoding)) tokenizer.push(text);
    tokenizer.end();
  } catch (error) {
    if (!(error instanceof StopParsing)) throw error;
  }
  return window(slots, () => "", bounds, cut);
}

async function previewWorksheet(payload: PreviewPayload): Promise<PreviewResult> {
  const bounds = payload.bounds;
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
  const archive = openArchive(payload.input, archiveLimits);
  if (archive.findings.length > 0) throw new InspectionRefusal((archive.findings[0] as { refusal: "CORRUPT_STRUCTURE" }).refusal, (archive.findings[0] as { code: string }).code);
  const index = indexPackage(archive);
  const meter = new ExpansionMeter(archiveLimits);
  const structure = await readWorkbookStructure(index, meter, xml);
  const sheet = structure.sheets.find((s) => s.ordinal === payload.ordinal);
  if (sheet === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "TABLE_NOT_FOUND");
  const entry = lookup(index, sheet.partName);
  if (entry === undefined) throw new InspectionRefusal("CORRUPT_STRUCTURE", "MISSING_PART");
  const part = partDigestOf(entry.name);
  const slots: Slot[][] = [];
  const needed = new Set<number>();
  let first = 0;
  let cut = false;
  const reader = new SheetReader(part, limits.decodedCellBytes, (row) => {
    if (!row.cells.some(occupies)) return;
    if (first === 0) first = row.row;
    const index = row.row - first;
    if (index >= bounds.rows) {
      cut = true;
      throw new StopParsing();
    }
    while (slots.length < index) slots.push([]);
    const out: Slot[] = [];
    for (const cell of row.cells) {
      if (cell.col > bounds.columns) {
        if (occupies(cell)) cut = true;
        continue;
      }
      while (out.length < cell.col - 1) out.push(null);
      if (cell.value === undefined) out.push(null);
      else if (cell.type === "s") {
        const i = sharedStringIndex(cell.value, part);
        needed.add(i);
        out.push({ sst: i });
      } else out.push(cell.value === "" ? null : { text: cell.value });
    }
    slots.push(out);
  });
  const scanner = new XmlScanner(reader, xml, part);
  try {
    for await (const chunk of expandEntry(archive, entry, meter)) scanner.write(chunk);
    scanner.end();
  } catch (error) {
    if (!(error instanceof StopParsing)) throw error;
  }
  const sst = structure.sharedStringsPart === undefined ? undefined : lookup(index, structure.sharedStringsPart);
  const maxIndex = needed.size === 0 ? -1 : Math.max(...needed);
  const { strings } = await readNeededStrings(index, sst, needed, maxIndex, meter, xml, limits.decodedCellBytes);
  return window(slots, (i) => strings.get(i) ?? "", bounds, cut);
}

export async function run(payload: PreviewPayload): Promise<PreviewResult> {
  return payload.format === "CSV" ? previewCsv(payload) : previewWorksheet(payload);
}
