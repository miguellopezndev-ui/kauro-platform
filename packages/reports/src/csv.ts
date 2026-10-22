/**
 * The narrow CSV reading the report model needs: strict UTF-8, RFC 4180 records (quoted fields may hold the delimiter, quotes
 * and line breaks), LF or CRLF endings. The model never trusts a row count the package declares about itself; it counts the
 * records in the bytes (CMD039-DENY "Matching manifest sums with wrong data … still fails").
 *
 * A table is scanned, not loaded (F-32): the bytes are decoded a slice at a time, each record is handed to the caller and dropped,
 * and what is held at once is one slice of text and one record. A field and a record are bounded by the limits the core's own
 * verifier reads a package with (`verify-package.ts` CSV_LIMITS), so no package the core verifies is refused for its size, and no
 * crafted file can make one record grow without end.
 */

export class CsvError extends Error {
  override readonly name = "CsvError";
}

/** Migration Core 3.0.0 `verify-package.ts` CSV_LIMITS: maxCellLength and maxColumns. */
export const MAX_FIELD_LENGTH = 10_000_000;
export const MAX_FIELDS = 10_000;
/** Bytes decoded at a time. */
const SLICE_BYTES = 1 << 20;

const COMMA = 44;
const QUOTE = 34;
const CR = 13;
const LF = 10;

const enum State {
  /** Nothing of the current field read yet. */
  FieldStart,
  /** In an unquoted field, or after the closing quote of a quoted one (a quote there is refused, any other character kept). */
  Unquoted,
  Quoted,
  /** A quote inside a quoted field: an escaped quote if another follows, else the field's closing quote. */
  QuoteInQuoted,
  /** A carriage return outside quotes: only a line feed may follow. */
  CarriageReturn,
}

/** Splits text, fed in pieces of any size, into records; each record goes to `emit` as it completes. */
class RecordSplitter {
  #state = State.FieldStart;
  #record: string[] = [];
  /** The current field's text, up to where the current piece's pending run starts. */
  #field = "";
  /** Code units of the pieces before the current one (error offsets count from the start of the text). */
  #consumed = 0;
  readonly #emit: (record: string[]) => void;

  constructor(emit: (record: string[]) => void) {
    this.#emit = emit;
  }

  #append(text: string): void {
    this.#field += text;
    if (this.#field.length > MAX_FIELD_LENGTH) throw new CsvError(`a field is longer than ${MAX_FIELD_LENGTH} characters`);
  }

  #endField(): void {
    this.#record.push(this.#field);
    this.#field = "";
    if (this.#record.length > MAX_FIELDS) throw new CsvError(`a record has more than ${MAX_FIELDS} fields`);
  }

  #endRecord(): void {
    this.#endField();
    const record = this.#record;
    this.#record = [];
    this.#emit(record);
  }

  push(piece: string): void {
    let run = 0;
    let i = 0;
    while (i < piece.length) {
      const c = piece.charCodeAt(i);
      switch (this.#state) {
        case State.FieldStart:
          if (c === QUOTE) {
            this.#state = State.Quoted;
            run = i + 1;
          } else if (c === COMMA) this.#endField();
          else if (c === CR) this.#state = State.CarriageReturn;
          else if (c === LF) this.#endRecord();
          else {
            this.#state = State.Unquoted;
            run = i;
          }
          break;
        case State.Unquoted:
          if (c === COMMA || c === LF) {
            this.#append(piece.slice(run, i));
            this.#state = State.FieldStart;
            if (c === COMMA) this.#endField();
            else this.#endRecord();
          } else if (c === CR) {
            this.#append(piece.slice(run, i));
            this.#state = State.CarriageReturn;
          } else if (c === QUOTE) throw new CsvError(`quote inside an unquoted field at offset ${this.#consumed + i}`);
          break;
        case State.Quoted:
          if (c === QUOTE) {
            this.#append(piece.slice(run, i));
            this.#state = State.QuoteInQuoted;
          }
          break;
        case State.QuoteInQuoted:
          if (c === QUOTE) {
            this.#append('"');
            this.#state = State.Quoted;
            run = i + 1;
            break;
          }
          // the closing quote: this character is read as part of the rest of the field
          this.#state = State.Unquoted;
          run = i;
          continue;
        case State.CarriageReturn:
          if (c !== LF) throw new CsvError(`bare carriage return at offset ${this.#consumed + i - 1}`);
          this.#state = State.FieldStart;
          this.#endRecord();
          break;
      }
      i++;
    }
    if (this.#state === State.Unquoted || this.#state === State.Quoted) this.#append(piece.slice(run));
    this.#consumed += piece.length;
  }

  end(): void {
    if (this.#state === State.Quoted) throw new CsvError("unterminated quoted field");
    if (this.#state === State.CarriageReturn) throw new CsvError(`bare carriage return at offset ${this.#consumed - 1}`);
    // A last record without a line ending still counts; a trailing line ending does not open an empty record.
    if (this.#state !== State.FieldStart || this.#record.length > 0) this.#endRecord();
    this.#state = State.FieldStart;
  }
}

/** Every record of the text, the header included, as arrays of field values. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  const splitter = new RecordSplitter((record) => records.push(record));
  splitter.push(text);
  splitter.end();
  return records;
}

/** What the caller does with each data record of a table: `header` is called once, and returns the visitor of the records. */
export type TableVisitor = (header: readonly string[]) => ((row: readonly string[]) => void) | null;

/**
 * Reads a table from its bytes without holding it: the header goes to `visit`, then each data record, in order, to the function
 * `visit` returned, decoding `sliceBytes` at a time (tests lower it to cut records anywhere). A file that is not UTF-8, has no
 * header, or has a record of another width than the header is refused.
 * Returns the header and the number of data records.
 */
export function scanTable(bytes: Uint8Array, visit: TableVisitor = () => null, sliceBytes: number = SLICE_BYTES): { readonly header: readonly string[]; readonly rows: number } {
  const table: { header: readonly string[] | null; onRow: ((row: readonly string[]) => void) | null; rows: number } = { header: null, onRow: null, rows: 0 };
  const splitter = new RecordSplitter((record) => {
    if (table.header === null) {
      table.header = record;
      table.onRow = visit(record);
      return;
    }
    table.rows++;
    if (record.length !== table.header.length) throw new CsvError(`record ${table.rows} has ${record.length} fields, the header has ${table.header.length}`);
    table.onRow?.(record);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const decode = (slice: Uint8Array, stream: boolean): string => {
    try {
      return decoder.decode(slice, { stream });
    } catch {
      throw new CsvError("not valid UTF-8");
    }
  };
  for (let at = 0; at < bytes.byteLength; at += sliceBytes) splitter.push(decode(bytes.subarray(at, Math.min(at + sliceBytes, bytes.byteLength)), true));
  splitter.push(decode(new Uint8Array(0), false));
  splitter.end();
  if (table.header === null) throw new CsvError("no header record");
  return { header: table.header, rows: table.rows };
}
