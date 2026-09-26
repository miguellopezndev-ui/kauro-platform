/**
 * CSV dialect facts of one file (04 "CSV parser requirements"; 09 "Completion and inspection": declared versus detected format,
 * supported encoding, parser limits). Two streaming passes over the attempt input: the first decides the encoding (EncodingSniffer),
 * the second decodes it, discovers the delimiter on a 1 MiB sample and tokenizes every record to the end — so a limit, an unclosed
 * quote or a NUL anywhere in the file is found, not only in a sample. The inventory is one CSV_TABLE whose positional columns are
 * the widest record's, labelled by the first record (the header candidate; the agency decides FIRST_RECORD or NONE).
 *
 * Loaded inside the isolated child.
 */
import { createReadStream } from "node:fs";
import type { DetectedTable } from "@kauro/application";
import { InspectionRefusal } from "../errors.js";
import { inventoryLabels } from "../text.js";
import { EncodingSniffer, decoderFor, type EncodingEvidence } from "./encoding.js";
import { delimiterChar, discoverDialect, type DelimiterName } from "./dialect.js";
import { CsvTokenizer, type CsvLimits } from "./tokenizer.js";

export interface CsvInspectionLimits {
  readonly decodedCellBytes: number;
  readonly decodedRecordBytes: number;
  readonly columns: number;
}

export interface CsvFacts {
  readonly encoding: EncodingEvidence;
  readonly delimiter: DelimiterName;
  readonly lineEndings: "LF" | "CRLF" | "CR" | "MIXED" | "NONE";
  readonly records: number;
  readonly table: DetectedTable;
}

const SAMPLE_CHARS = 1_048_576;
const CHUNK = 64 * 1024;

export const CSV_GRID_COLUMNS = 16_384;

export function csvLimits(limits: CsvInspectionLimits): CsvLimits {
  return { cellBytes: limits.decodedCellBytes, recordBytes: limits.decodedRecordBytes, maxFields: CSV_GRID_COLUMNS };
}

export async function sniffEncoding(path: string): Promise<EncodingEvidence> {
  const sniffer = new EncodingSniffer();
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK }) as AsyncIterable<Buffer>) sniffer.push(chunk);
  return sniffer.finish();
}

/** Streams the decoded text of a file (fatal decoding), refusing a NUL character. */
export async function* decodedText(path: string, encoding: EncodingEvidence["encoding"]): AsyncGenerator<string, void, void> {
  const decoder = decoderFor(encoding);
  for await (const chunk of createReadStream(path, { highWaterMark: CHUNK }) as AsyncIterable<Buffer>) {
    const text = decoder.decode(chunk);
    if (text.includes("\u0000")) throw new InspectionRefusal("CORRUPT_STRUCTURE", "CSV_NUL_CHARACTER");
    if (text.length > 0) yield text;
  }
  const rest = decoder.end();
  if (rest.includes("\u0000")) throw new InspectionRefusal("CORRUPT_STRUCTURE", "CSV_NUL_CHARACTER");
  if (rest.length > 0) yield rest;
}

export async function inspectCsv(path: string, limits: CsvInspectionLimits): Promise<CsvFacts> {
  const encoding = await sniffEncoding(path);
  const tokenLimits = csvLimits(limits);
  let sample = "";
  let tokenizer: CsvTokenizer | undefined;
  let delimiter: DelimiterName = "COMMA";
  const issues = new Set<string>(encoding.issues);
  const terminators = new Set<string>();
  let header: string[] | undefined;
  let width = 0;
  let firstWidth = -1;
  let ragged = false;
  let blank = 0;
  let embedded = false;
  let trailingDelimiter = true;
  let lastTerminator = "EOF";
  let records = 0;
  const start = (complete: boolean): CsvTokenizer => {
    const decision = discoverDialect(sample, complete, tokenLimits);
    delimiter = decision.delimiter;
    for (const i of decision.issues) issues.add(i);
    return new CsvTokenizer({ delimiter: delimiterChar(delimiter), quote: '"' }, tokenLimits, (fields, facts) => {
      records += 1;
      lastTerminator = facts.terminator;
      if (facts.terminator !== "EOF") terminators.add(facts.terminator);
      if (facts.embeddedLineBreak) embedded = true;
      if (facts.blank) {
        blank += 1;
        return;
      }
      if (header === undefined) header = fields.slice(0, Math.min(fields.length, CSV_GRID_COLUMNS));
      if (firstWidth < 0) firstWidth = fields.length;
      else if (fields.length !== firstWidth) ragged = true;
      if (fields.length > width) width = fields.length;
      if (fields.length < 2 || fields[fields.length - 1] !== "") trailingDelimiter = false;
    });
  };
  for await (const text of decodedText(path, encoding.encoding)) {
    if (tokenizer === undefined) {
      sample += text;
      if (sample.length >= SAMPLE_CHARS) {
        tokenizer = start(false);
        tokenizer.push(sample);
        sample = "";
      }
    } else tokenizer.push(text);
  }
  if (tokenizer === undefined) {
    tokenizer = start(true);
    tokenizer.push(sample);
    sample = "";
  }
  tokenizer.end();
  if (records === 0) throw new InspectionRefusal("CORRUPT_STRUCTURE", "EMPTY_FILE");
  if (blank > 0) issues.add("BLANK_LINES_PRESENT");
  if (ragged) issues.add("RAGGED_ROWS");
  if (embedded) issues.add("EMBEDDED_LINE_BREAKS");
  if (tokenizer.bareQuotes > 0) issues.add("BARE_QUOTE");
  if (tokenizer.textAfterQuote > 0) issues.add("TEXT_AFTER_QUOTE");
  if (trailingDelimiter && width >= 2) issues.add("TRAILING_DELIMITER");
  if (lastTerminator === "EOF") issues.add("NO_TERMINAL_NEWLINE");
  if (terminators.size > 1) issues.add("LINE_ENDINGS_MIXED");
  if (width > limits.columns) issues.add("COLUMNS_ABOVE_SELECTION_LIMIT");
  if (header === undefined) issues.add("EMPTY_TABLE");
  const headerFields: string[] = header ?? [];
  const labels = inventoryLabels(headerFields, width, headerFields.length);
  if (labels.some((l) => l.labelState === "DUPLICATE_LABEL")) issues.add("DUPLICATE_HEADER_LABELS");
  if (labels.some((l) => l.labelState === "EMPTY")) issues.add("EMPTY_HEADER_LABELS");
  const lineEndings = terminators.size === 0 ? "NONE" : terminators.size > 1 ? "MIXED" : ([...terminators][0] as "LF" | "CRLF" | "CR");
  const table: DetectedTable = {
    ordinal: 0,
    kind: "CSV_TABLE",
    visibility: "VISIBLE",
    columnCount: width,
    rowEstimate: records - blank,
    hasFormulas: false,
    formulaCache: "NOT_APPLICABLE",
    mergedCellCount: 0,
    hiddenRowCount: 0,
    hiddenColumnCount: 0,
    issues: [...issues].sort().slice(0, 64),
    columns: labels.map((l, ordinal) => (l.label === undefined ? { ordinal, labelState: l.labelState } : { ordinal, label: l.label, labelState: l.labelState })),
  };
  return { encoding, delimiter, lineEndings, records, table };
}
