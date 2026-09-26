/**
 * An incremental CSV tokenizer (04 "CSV parser requirements": incremental and backpressured; a row can span physical lines;
 * splitting a buffer by newline and comma is not a compliant parser; byte and character limits are enforced before an arbitrarily
 * large cell is concatenated, and a limit crossing several chunks fails at the same logical location; row width, trailing
 * delimiters, empty records, a missing terminal newline, unclosed quotes, escaped quotes, embedded CR/LF, NUL and mixed line endings
 * are checked). Values stay strings: nothing is converted (large identifiers, leading zeros, dates survive unchanged).
 *
 * The tokenizer takes decoded text in chunks of any size and reports each record with the facts of how it was written. Quoting is
 * RFC 4180 with the double quote (or none, when the agency chose quote NONE): a field that starts with the quote is quoted, a doubled
 * quote inside it is one quote, a quote inside an unquoted field is kept as text and counted (BARE_QUOTE), text after a closing
 * quote is kept and counted (TEXT_AFTER_QUOTE). Records end at CRLF, LF or CR outside quotes.
 *
 * Loaded inside the isolated child.
 */
import { InspectionRefusal, StopParsing } from "../errors.js";

export interface CsvDialect {
  /** One character: , ; TAB or |. */
  readonly delimiter: string;
  /** The quote character, or null for quote NONE. */
  readonly quote: string | null;
}

export interface CsvLimits {
  readonly cellBytes: number;
  readonly recordBytes: number;
  readonly maxFields: number;
}

export type RecordTerminator = "CRLF" | "LF" | "CR" | "EOF";

export interface CsvRecordFacts {
  /** A line with nothing on it: one empty, unquoted field. */
  readonly blank: boolean;
  readonly terminator: RecordTerminator;
  /** A quoted field of this record contains CR or LF. */
  readonly embeddedLineBreak: boolean;
}

/** Return false to stop (the caller catches StopParsing). */
export type RecordSink = (fields: string[], facts: CsvRecordFacts) => void | boolean;

export class CsvTokenizer {
  private fields: string[] = [];
  private pieces: string[] = [];
  private fieldBytes = 0;
  private recordBytes = 0;
  private fieldQuoted = false;
  private fieldHasText = false;
  private inQuotes = false;
  private pendingQuote = false;
  private pendingCR = false;
  private embedded = false;
  private readonly special: RegExp;
  bareQuotes = 0;
  textAfterQuote = 0;
  records = 0;

  constructor(
    private readonly dialect: CsvDialect,
    private readonly limits: CsvLimits,
    private readonly sink: RecordSink,
  ) {
    const esc = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    this.special = new RegExp(`[${esc(dialect.delimiter)}\\r\\n${dialect.quote === null ? "" : esc(dialect.quote)}]`, "g");
  }

  private append(text: string): void {
    if (text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    this.fieldBytes += bytes;
    this.recordBytes += bytes;
    if (this.fieldBytes > this.limits.cellBytes) throw new InspectionRefusal("RESOURCE_LIMIT", "CELL_BYTES_LIMIT");
    if (this.recordBytes > this.limits.recordBytes) throw new InspectionRefusal("RESOURCE_LIMIT", "RECORD_BYTES_LIMIT");
    this.pieces.push(text);
    this.fieldHasText = true;
  }

  private endField(): void {
    this.fields.push(this.pieces.length === 1 ? (this.pieces[0] as string) : this.pieces.join(""));
    this.pieces = [];
    this.fieldBytes = 0;
    this.fieldQuoted = false;
    this.fieldHasText = false;
    if (this.fields.length > this.limits.maxFields) throw new InspectionRefusal("RESOURCE_LIMIT", "COLUMN_LIMIT");
    this.recordBytes += 1;
    if (this.recordBytes > this.limits.recordBytes) throw new InspectionRefusal("RESOURCE_LIMIT", "RECORD_BYTES_LIMIT");
  }

  private endRecord(terminator: RecordTerminator): void {
    const quoted = this.fieldQuoted;
    this.endField();
    const fields = this.fields;
    const blank = fields.length === 1 && fields[0] === "" && !quoted;
    const facts: CsvRecordFacts = { blank, terminator, embeddedLineBreak: this.embedded };
    this.fields = [];
    this.recordBytes = 0;
    this.embedded = false;
    this.records += 1;
    if (this.sink(fields, facts) === false) throw new StopParsing();
  }

  push(text: string): void {
    let i = 0;
    const n = text.length;
    const quote = this.dialect.quote;
    const delimiter = this.dialect.delimiter;
    while (i < n) {
      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (text[i] === quote) {
            this.append(quote);
            i += 1;
            continue;
          }
          this.inQuotes = false;
          continue;
        }
        const q = text.indexOf(quote as string, i);
        const stop = q < 0 ? n : q;
        const chunk = text.slice(i, stop);
        if (!this.embedded && /[\r\n]/.test(chunk)) this.embedded = true;
        this.append(chunk);
        if (q < 0) return;
        this.pendingQuote = true;
        i = q + 1;
        continue;
      }
      if (this.pendingCR) {
        this.pendingCR = false;
        if (text[i] === "\n") {
          this.endRecord("CRLF");
          i += 1;
          continue;
        }
        this.endRecord("CR");
        continue;
      }
      this.special.lastIndex = i;
      const m = this.special.exec(text);
      const stop = m === null ? n : m.index;
      if (stop > i) {
        if (this.fieldQuoted) this.textAfterQuote += 1;
        this.append(text.slice(i, stop));
      }
      if (m === null) return;
      const c = text[stop] as string;
      i = stop + 1;
      if (c === delimiter) this.endField();
      else if (c === "\n") this.endRecord("LF");
      else if (c === "\r") this.pendingCR = true;
      else if (c === quote) {
        if (!this.fieldHasText && !this.fieldQuoted) {
          this.inQuotes = true;
          this.fieldQuoted = true;
        } else {
          this.bareQuotes += 1;
          this.append(c);
        }
      }
    }
  }

  /** Ends the input: a quote still open is CORRUPT_STRUCTURE (CSV_UNCLOSED_QUOTE); a last record without a newline is reported. */
  end(): void {
    if (this.inQuotes && !this.pendingQuote) throw new InspectionRefusal("CORRUPT_STRUCTURE", "CSV_UNCLOSED_QUOTE");
    this.inQuotes = false;
    this.pendingQuote = false;
    if (this.pendingCR) {
      this.pendingCR = false;
      this.endRecord("CR");
      return;
    }
    if (this.fields.length > 0 || this.pieces.length > 0 || this.fieldQuoted) this.endRecord("EOF");
  }
}
