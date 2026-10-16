import { closeSync, openSync, readSync } from 'node:fs';
import type { CsvReadOptions, CsvRecordSink, CsvScanResult } from './csv-reader.js';
import { createCsvScanner } from './csv-reader.js';

/**
 * Read a CSV file that never exists in memory as one string.
 *
 * The incremental reader has been here for a while and had nothing to feed it:
 * every caller decoded the whole file first and then handed over the result, so
 * the reader's ability to take a file in pieces was never used and peak memory
 * was still governed by the largest artifact.
 *
 * What matters is that this is not another parser. It reads bytes, decodes them
 * as they arrive, and hands the text to the same state machine `readCsv` uses —
 * the same quoting rules, the same refusals, the same limits. Two parsers would
 * be two definitions of what a CSV is, and the one the verifier used would
 * eventually disagree with the one ingest used, which is the disagreement the
 * canonical document exists to forbid.
 *
 * Decoding is incremental too, and has to be: a multi-byte character can land
 * across a block boundary, and a decoder that finished at every boundary would
 * turn one character into two replacement characters at a position that depends
 * on the block size. That would make the read non-deterministic in the one way
 * nothing downstream could detect.
 */

/** Bytes per read. Fixed, so the cost of reading a file does not depend on its size. */
const BLOCK_BYTES = 1 << 16;

export function scanCsvFile(path: string, options: CsvReadOptions, sink: CsvRecordSink): CsvScanResult {
  const scanner = createCsvScanner(options, sink);
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      // `stream: true` keeps any partial character for the next block instead of
      // resolving it to a replacement character at a block boundary.
      scanner.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
    }
    // The final call without `stream` flushes anything the file ended mid-way
    // through, so a truncated character is reported rather than dropped.
    scanner.push(decoder.decode());
    return scanner.end();
  } finally {
    closeSync(handle);
  }
}

/**
 * How many records a CSV file holds, without holding any of them.
 *
 * Counting records does not need records, and the count is what several checks
 * ask for. The header is a record like any other to the reader and is not a row,
 * so callers that want rows subtract it.
 */
export function countCsvRecords(path: string, options: CsvReadOptions): number {
  return scanCsvFile(path, options, () => {}).recordCount;
}

/**
 * Walk a CSV file's records, a block at a time, pulling rather than being pushed.
 *
 * The push form is the right shape for one check over one artifact. It is the
 * wrong shape for a check that has to walk two artifacts together — and several
 * do, because a package's artifacts are written in one declared order and
 * corroborating one against another is a merge. A merge needs to ask each side
 * for its next record, which a callback cannot answer.
 *
 * Bounded the same way: one block of the file is read, the records it completed
 * are handed out, and the next block replaces it. What is held at any moment is
 * a block and the records inside it, whatever the file weighs.
 */
export function* readCsvFileRecords(
  path: string,
  options: CsvReadOptions,
): IterableIterator<readonly string[]> {
  const handle = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let ready: string[][] = [];
  // The scanner reuses its field array, so a record that outlives the callback
  // is copied. They outlive it by exactly one block here.
  const scanner = createCsvScanner(options, (_recordNumber, fields) => {
    ready.push([...fields]);
  });
  try {
    for (;;) {
      const read = readSync(handle, buffer, 0, buffer.length, null);
      if (read === 0) break;
      scanner.push(decoder.decode(buffer.subarray(0, read), { stream: true }));
      if (ready.length > 0) {
        const batch = ready;
        ready = [];
        yield* batch;
      }
    }
    scanner.push(decoder.decode());
    scanner.end();
    yield* ready;
  } finally {
    closeSync(handle);
  }
}

/**
 * The rows of a CSV file, keyed by its header.
 *
 * The header is consumed here rather than handed out, because a header is not a
 * row and every caller had to remember that.
 */
export function* readCsvFileRows(
  path: string,
  options: CsvReadOptions,
): IterableIterator<Record<string, string>> {
  let headers: readonly string[] | null = null;
  for (const fields of readCsvFileRecords(path, options)) {
    if (headers === null) {
      headers = [...fields];
      continue;
    }
    const row: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index] ?? ''] = fields[index] ?? '';
    }
    yield row;
  }
}
