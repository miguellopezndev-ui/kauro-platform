import { MigrationError } from '../domain/errors.js';

/**
 * RFC 4180 reader with no type inference whatsoever.
 *
 * Every field comes out as the exact characters the file contained. Leading
 * zeros, long numeric identifiers and values that look like dates are all just
 * text here; deciding what they mean is the mapping layer's job, driven by
 * configuration rather than by guessing.
 */

export interface CsvRecord {
  /** 1-based record number, counting the header as record 1. Newlines inside quoted fields do not advance it. */
  readonly recordNumber: number;
  readonly fields: readonly string[];
}

export interface CsvReadOptions {
  readonly delimiter: string;
  readonly filePath: string;
  readonly maxCellLength: number;
  readonly maxColumns: number;
  readonly maxRows: number;
  /**
   * The most one record may hold, in UTF-8 bytes, from its first character to its
   * last and not counting its line terminator. Checked while the record grows, so
   * a record is refused when it passes the limit and not when it ends (D71).
   *
   * Absent for the readers of the engine's own artifacts, which are written under
   * limits the engine chose; every reader of a customer's file sets it.
   */
  readonly maxRecordBytes?: number;
}

export interface CsvReadResult {
  readonly records: readonly CsvRecord[];
  /** The line terminator the file predominantly used, kept as source evidence. */
  readonly lineTerminator: 'CRLF' | 'LF' | 'CR' | 'NONE';
}

export interface CsvScanResult {
  readonly recordCount: number;
  readonly lineTerminator: 'CRLF' | 'LF' | 'CR' | 'NONE';
  /**
   * How many characters the state machine stepped over, in all.
   *
   * Every character of the file is stepped over exactly once, so this equals the
   * length of the text. It is reported so that a test can say "scanned once"
   * about the one thing that used to be wrong -- an unfinished record read again
   * from its first character for every block that arrived after it -- and not
   * just about the output, which was right all along.
   */
  readonly charactersExamined: number;
}

/**
 * Called once per record while scanning.
 *
 * `fields` is reused between records. A consumer that needs a record after its
 * call returns has to copy it — which is the point: a consumer that does not
 * need to keep one never allocates an array of every record in the file.
 */
export type CsvRecordSink = (recordNumber: number, fields: readonly string[]) => void;

const QUOTE = '"';

/**
 * Read every record into an array.
 *
 * Use this when something genuinely needs the whole file at once. When it does
 * not — a row count, an order comparison, a couple of columns — use `scanCsv`,
 * which runs the identical state machine and keeps no record after the consumer
 * has looked at it. At a million rows an artifact is several hundred megabytes,
 * and the array of parsed records is the largest thing the verification builds.
 */
export function readCsv(text: string, options: CsvReadOptions): CsvReadResult {
  const records: CsvRecord[] = [];
  const { lineTerminator } = scanCsv(text, options, (recordNumber, fields) => {
    // Copied because the scanner reuses its field array.
    records.push({ recordNumber, fields: [...fields] });
  });
  return { records, lineTerminator };
}

/**
 * Read every record, handing each to `sink` and keeping none.
 *
 * This is the same reader as `readCsv` — the same state machine, the same
 * quoting rules, the same refusals, the same limits — differing only in what
 * becomes of a record once it has been read. There is deliberately not a second
 * parser: two parsers would be two definitions of what a CSV is, and the one
 * used by the verifier would eventually disagree with the one used by ingest.
 */
export function scanCsv(text: string, options: CsvReadOptions, sink: CsvRecordSink): CsvScanResult {
  const state = newState();
  scanChunk(text, options, sink, state, true);
  return resultOf(state);
}

/** A reader being fed a file a piece at a time. */
export interface CsvScanner {
  /** Hand it the next piece of the file, in order. */
  push(text: string): void;
  /** Say that the file has ended, and get what the whole of it said. */
  end(): CsvScanResult;
}

/**
 * Read a file that never exists in memory as one string.
 *
 * This is the same reader again — the same state machine, reached the same way —
 * fed in pieces instead of all at once. It exists because peak memory in
 * verification turned out to be governed by how much is *allocated*, not by how
 * much is kept: decoding a 450 MB artifact into one string costs 450 MB whether
 * or not a single row survives the read, and resident memory never returns to
 * the operating system once it has grown.
 *
 * The caller owns the reading and the decoding, because it owns the encoding
 * rules; this owns only what a CSV means. Pieces must arrive in order, and a
 * piece may split anything — a field, a quoted newline, a record — because the
 * state of the record in progress is carried from one piece to the next.
 */
export function createCsvScanner(options: CsvReadOptions, sink: CsvRecordSink): CsvScanner {
  const state = newState();
  let ended = false;
  return {
    push(text: string): void {
      if (ended) {
        throw new MigrationError(
          'CONFIG_INVALID',
          `${options.filePath} was given more text after it had ended`,
          'Feed every piece of the file before calling end().',
          { filePath: options.filePath },
        );
      }
      if (text.length === 0) return;
      scanChunk(text, options, sink, state, false);
    },
    end(): CsvScanResult {
      ended = true;
      scanChunk('', options, sink, state, true);
      return resultOf(state);
    },
  };
}

/**
 * Where the reader is in the file, between one piece and the next.
 *
 * This used to be only the text of the unfinished record, which was read again
 * from its first character when more arrived. That kept the state machine simple
 * -- there was no way to be half way through a quoted field, because a piece
 * always began at a record -- and it made the cost of one long record grow with
 * the square of its length, and meant nothing could be said about a cell or a
 * record until it had ended. A cell that never ended was never refused.
 *
 * So the state is kept: the fields of the record so far, the text of the field
 * in progress, whether a quote is open. Each character is stepped over once. The
 * one thing that is not state but text is the last two characters of a piece,
 * which are held back because the reader looks one character ahead -- at what
 * follows a closing quote, and at whether a carriage return is half of a CRLF --
 * and a lookahead that ran off the end of a piece would answer "end of file"
 * when the truth is "not yet".
 */
interface CsvState {
  /** Text not yet stepped over: the last two characters of the previous piece. */
  rest: string;
  /** Where `rest` begins in the file, so an offset in a message is a file offset. */
  offset: number;
  recordCount: number;
  recordNumber: number;
  crlf: number;
  lf: number;
  cr: number;
  /** The fields of the record in progress that have ended. */
  fields: string[];
  inQuotes: boolean;
  fieldWasQuoted: boolean;
  /**
   * The text of the field in progress that came before this piece, or null when
   * nothing has been read into it and no quote has opened it.
   */
  pending: string | null;
  /** UTF-8 bytes of the record in progress that came before this piece. */
  recordBytes: number;
  examined: number;
}

function newState(): CsvState {
  return {
    rest: '',
    offset: 0,
    recordCount: 0,
    recordNumber: 1,
    crlf: 0,
    lf: 0,
    cr: 0,
    fields: [],
    inQuotes: false,
    fieldWasQuoted: false,
    pending: null,
    recordBytes: 0,
    examined: 0,
  };
}

function resultOf(state: CsvState): CsvScanResult {
  return {
    recordCount: state.recordCount,
    lineTerminator: dominantTerminator(state.crlf, state.lf, state.cr),
    charactersExamined: state.examined,
  };
}

/**
 * A copy of a piece of text that shares nothing with the text it came from.
 *
 * V8 represents a slice as a view onto its source, so a short string taken out
 * of a chunk keeps the whole chunk alive. What is carried from one piece to the
 * next is detached here, so that keeping one cell of a scanned file can never
 * keep the file.
 */
function detached(value: string): string {
  // UTF-16, not UTF-8: a chunk boundary can fall between the halves of a
  // surrogate pair, and the carry then ends on a lone surrogate. Round-tripping
  // that through UTF-8 replaces it, which would turn a character split across
  // two blocks into a replacement character -- the one corruption a block-based
  // reader must not introduce. Copying code unit for code unit preserves it.
  return Buffer.from(value, 'utf16le').toString('utf16le');
}

/**
 * UTF-8 bytes of a stretch of text, counted a code unit at a time.
 *
 * Each half of a surrogate pair counts two, so a pair is four bytes whichever
 * piece each half arrives in and the answer cannot depend on where a file was cut.
 */
function utf8Bytes(text: string, from: number, to: number): number {
  let bytes = 0;
  for (let index = from; index < to; index += 1) {
    const unit = text.charCodeAt(index);
    bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : unit >= 0xd800 && unit <= 0xdfff ? 2 : 3;
  }
  return bytes;
}

/**
 * Step over one piece of the file, emit the records that finished inside it, and
 * keep the state of the one that did not.
 *
 * `final` says whether anything follows. While it is false the last two
 * characters are left for the next piece (see `CsvState`), so every character
 * this reads has the character after it available, and a record it completes was
 * completed for the same reason it would have been in the whole file.
 */
function scanChunk(
  incoming: string,
  options: CsvReadOptions,
  sink: CsvRecordSink,
  state: CsvState,
  final: boolean,
): void {
  const { delimiter } = options;
  if (delimiter.length !== 1) {
    throw new MigrationError(
      'CONFIG_INVALID',
      `delimiter for ${options.filePath} must be a single character`,
      'Use one of the supported delimiters.',
      { filePath: options.filePath, delimiter },
    );
  }

  // Concatenating only when there is something to concatenate.
  const text = state.rest === '' ? incoming : state.rest + incoming;
  const maxRecordBytes = options.maxRecordBytes ?? Number.POSITIVE_INFINITY;

  let fields = state.fields;
  let inQuotes = state.inQuotes;
  let fieldWasQuoted = state.fieldWasQuoted;
  let pending = state.pending;
  let recordCount = state.recordCount;
  let recordNumber = state.recordNumber;
  let crlf = state.crlf;
  let lf = state.lf;
  let cr = state.cr;
  const fileOffset = state.offset;
  const limit = final ? text.length : Math.max(0, text.length - 2);

  // Where the record in progress begins in this text (zero when it began in an
  // earlier piece), and the bytes it already held when this piece began.
  let recordStart = 0;
  let carriedBytes = state.recordBytes;

  /**
   * The current field, taken as offsets into the text rather than built up a
   * character at a time.
   *
   * The obvious loop appends each character to a string, which allocates once
   * per character consumed: a 45 MB artifact produced roughly 45 million
   * intermediate strings, and the garbage that made was a quarter of the whole
   * verification. A field is almost always a contiguous run of text, so the
   * common case is one slice and no intermediate at all. `pending` holds what
   * came before: an escaped quote, a closed quoted run, or the part of a field
   * that arrived in an earlier piece.
   */
  let segmentStart = 0;

  const takeField = (end: number): string => {
    const tail = text.slice(segmentStart, end);
    const value = pending === null ? tail : pending + tail;
    pending = null;
    return value;
  };

  /** Whether anything has been read into the current field yet, without building it. */
  const fieldIsEmpty = (end: number): boolean => (pending === null || pending.length === 0) && end <= segmentStart;

  const cellTooLong = (length: number, unfinished: boolean): MigrationError =>
    new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${options.filePath} record ${String(recordNumber)} has a field of ${unfinished ? 'more than ' : ''}${String(length)} characters${unfinished ? ' and it is not finished' : ''}, above the limit of ${String(options.maxCellLength)}`,
      'Raise limits.maxCellLength if this data is expected, or repair the source file.',
      {
        filePath: options.filePath,
        limit: 'maxCellLength',
        allowed: options.maxCellLength,
        actual: length,
        recordNumber,
      },
    );

  const recordTooLong = (bytes: number, unfinished: boolean): MigrationError =>
    new MigrationError(
      'INPUT_LIMIT_EXCEEDED',
      `${options.filePath} record ${String(recordNumber)} holds ${unfinished ? 'more than ' : ''}${String(bytes)} bytes${unfinished ? ' and it is not finished' : ''}, above the record limit of ${String(maxRecordBytes)}`,
      'Raise limits.maxRecordBytes if records this large are expected, or repair the source file: a record that long usually means a quote was never closed.',
      {
        filePath: options.filePath,
        limit: 'maxRecordBytes',
        allowed: maxRecordBytes,
        actual: bytes,
        recordNumber,
      },
    );

  const finishField = (end: number): void => {
    const field = takeField(end);
    if (field.length > options.maxCellLength) throw cellTooLong(field.length, false);
    fields.push(field);
    fieldWasQuoted = false;
    if (fields.length > options.maxColumns) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${options.filePath} record ${String(recordNumber)} has more than ${String(options.maxColumns)} columns`,
        'Raise limits.maxColumnsPerSheet if this data is expected, or repair the source file.',
        { filePath: options.filePath, limit: 'maxColumnsPerSheet', allowed: options.maxColumns, recordNumber },
      );
    }
  };

  const finishRecord = (end: number, afterTerminator: number): void => {
    // The record's size, before it is handed over. Three bytes a code unit is
    // the most there can be, so a record that cannot reach the limit at that
    // rate is not counted exactly.
    if (carriedBytes + (end - recordStart) * 3 > maxRecordBytes) {
      const bytes = carriedBytes + utf8Bytes(text, recordStart, end);
      if (bytes > maxRecordBytes) throw recordTooLong(bytes, false);
    }
    finishField(end);
    sink(recordNumber, fields);
    recordCount += 1;
    fields = [];
    recordNumber += 1;
    recordStart = afterTerminator;
    carriedBytes = 0;
    inQuotes = false;
    fieldWasQuoted = false;
    pending = null;
    if (recordCount > options.maxRows) {
      throw new MigrationError(
        'INPUT_LIMIT_EXCEEDED',
        `${options.filePath} has more than ${String(options.maxRows)} rows`,
        'Raise limits.maxRowsPerSheet if this data is expected, or split the file.',
        { filePath: options.filePath, limit: 'maxRowsPerSheet', allowed: options.maxRows },
      );
    }
  };

  let index = 0;
  for (; index < limit; index += 1) {
    const character = text[index] as string;

    if (inQuotes) {
      if (character === QUOTE) {
        if (text[index + 1] === QUOTE) {
          // The one place a field is not contiguous: keep what has been read,
          // add the single quote the pair stands for, and start a new run after
          // it.
          pending = (pending ?? '') + text.slice(segmentStart, index) + QUOTE;
          index += 1;
          segmentStart = index + 1;
          continue;
        }
        // A closing quote must be followed by a delimiter, a line terminator or
        // the end of the file. Anything else means the file does not say where
        // the field ends, and appending the remainder would invent a value.
        const next = text[index + 1];
        if (next !== undefined && next !== delimiter && next !== '\r' && next !== '\n') {
          throw new MigrationError(
            'INPUT_CORRUPT',
            `${options.filePath} record ${String(recordNumber)} has text after a closing quote (character offset ${String(fileOffset + index + 1)})`,
            'Quote the whole field and double any quote characters inside it, as RFC 4180 requires.',
            { filePath: options.filePath, recordNumber, characterOffset: fileOffset + index + 1 },
          );
        }
        // The quoted run ends here. Close it now so the closing quote itself
        // never reaches the value, and start an empty run: the check above has
        // already established that only a delimiter, a terminator or the end of
        // the file can follow.
        pending = (pending ?? '') + text.slice(segmentStart, index);
        segmentStart = index + 1;
        inQuotes = false;
        continue;
      }
      continue;
    }

    if (character === QUOTE) {
      if (!fieldIsEmpty(index) || fieldWasQuoted) {
        throw new MigrationError(
          'INPUT_CORRUPT',
          `${options.filePath} record ${String(recordNumber)} has a quote character in the middle of a field (character offset ${String(fileOffset + index)})`,
          'Quote the whole field and double any quote characters inside it, as RFC 4180 requires.',
          { filePath: options.filePath, recordNumber, characterOffset: fileOffset + index },
        );
      }
      inQuotes = true;
      fieldWasQuoted = true;
      // The opening quote is not part of the value.
      pending = pending ?? '';
      segmentStart = index + 1;
      continue;
    }

    if (character === delimiter) {
      finishField(index);
      segmentStart = index + 1;
      continue;
    }

    if (character === '\r') {
      const end = index;
      if (text[index + 1] === '\n') {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
      finishRecord(end, index + 1);
      segmentStart = index + 1;
      continue;
    }

    if (character === '\n') {
      lf += 1;
      finishRecord(index, index + 1);
      segmentStart = index + 1;
      continue;
    }
  }

  // Everything before `index` has been stepped over. (A lookahead can have taken
  // one character past `limit`, which is why this is `index` and not `limit`.)
  const scannedTo = Math.min(index, text.length);
  state.examined += scannedTo;

  if (!final) {
    // The record that has not finished is measured as it stands, so a cell or a
    // record that never ends is refused when it passes its limit and not when
    // the file does.
    const fieldSoFar = (pending === null ? 0 : pending.length) + (scannedTo - segmentStart);
    if (fieldSoFar > options.maxCellLength) throw cellTooLong(fieldSoFar, true);
    const recordSoFar = Number.isFinite(maxRecordBytes) ? carriedBytes + utf8Bytes(text, recordStart, scannedTo) : 0;
    if (recordSoFar > maxRecordBytes) throw recordTooLong(recordSoFar, true);

    const piece = scannedTo > segmentStart ? detached(text.slice(segmentStart, scannedTo)) : '';
    state.pending = pending === null && piece === '' ? null : (pending ?? '') + piece;
    state.fields = fields;
    state.inQuotes = inQuotes;
    state.fieldWasQuoted = fieldWasQuoted;
    state.recordBytes = recordSoFar;
    state.rest = detached(text.slice(scannedTo));
    state.offset = fileOffset + scannedTo;
    state.recordCount = recordCount;
    state.recordNumber = recordNumber;
    state.crlf = crlf;
    state.lf = lf;
    state.cr = cr;
    return;
  }

  if (inQuotes) {
    throw new MigrationError(
      'INPUT_CORRUPT',
      `${options.filePath} ends inside a quoted field that was never closed (record ${String(recordNumber)})`,
      'Close the quoted field, or re-export the file from the source system.',
      { filePath: options.filePath, recordNumber },
    );
  }

  // A trailing line terminator ends the last record; anything else still pending
  // is a final record. `fieldWasQuoted` matters here: a last line of `""` is a
  // record holding one empty field, and dropping it would lose a source row.
  if (!fieldIsEmpty(text.length) || fields.length > 0 || fieldWasQuoted) {
    finishRecord(text.length, text.length);
  }

  state.rest = '';
  state.offset = fileOffset + text.length;
  state.fields = [];
  state.inQuotes = false;
  state.fieldWasQuoted = false;
  state.pending = null;
  state.recordBytes = 0;
  state.recordCount = recordCount;
  state.recordNumber = recordNumber;
  state.crlf = crlf;
  state.lf = lf;
  state.cr = cr;
}

function dominantTerminator(crlf: number, lf: number, cr: number): CsvReadResult['lineTerminator'] {
  if (crlf === 0 && lf === 0 && cr === 0) return 'NONE';
  if (crlf >= lf && crlf >= cr) return 'CRLF';
  if (lf >= cr) return 'LF';
  return 'CR';
}
