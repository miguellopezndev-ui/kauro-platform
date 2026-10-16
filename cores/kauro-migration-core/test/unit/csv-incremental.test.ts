import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCsvScanner } from '../../src/ingest/csv-reader.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { countCsvRecords, createCsvCensus } from '../../src/ingest/row-census.js';
import { ingestBundle } from '../../src/ingest/ingest-bundle.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { scratchDir } from '../support/harness.js';

const options = {
  delimiter: ',',
  filePath: 'incremental.csv',
  maxCellLength: 1_000,
  maxColumns: 100,
  maxRows: 1_000,
};

/**
 * The reason the incremental reader exists, stated as behaviour.
 *
 * It once carried every piece and parsed nothing until the last one. The output
 * was identical, so every agreement test passed — while the carry grew until it
 * held the whole file and the parse became quadratic in its size. A 28 MB
 * artifact took thirty seconds instead of a third of one, and because a slice
 * keeps its source alive, any caller that kept a single cell kept the file it
 * came from.
 *
 * Identical output is therefore not enough to state. What has to hold is that a
 * record completed inside a piece is handed over when that piece arrives, and
 * that what survives a piece is the record it was in the middle of and nothing
 * earlier.
 */
describe('the CSV reader reads incrementally', () => {
  it('hands out the records a piece completes, before the file ends', () => {
    const seen: number[] = [];
    const scanner = createCsvScanner(options, (recordNumber) => {
      seen.push(recordNumber);
    });

    scanner.push('a,b\n1,2\n3,4\n');
    // The last two characters of a piece are held back deliberately: a CRLF
    // can fall across the boundary, and deciding what a lone carriage return
    // means before the next byte arrives would make the line terminator depend
    // on the block size. So a piece hands over every record that finishes more
    // than two characters before its end.
    assert.deepEqual(seen, [1, 2], 'the complete records were not handed over when their piece arrived');

    scanner.push('5,6\n');
    assert.deepEqual(seen, [1, 2, 3], 'the next complete record was not handed over when its piece arrived');

    scanner.end();
    assert.deepEqual(seen, [1, 2, 3, 4], 'the last record was not finished by ending the file');
  });

  it('carries only the record it is in the middle of', () => {
    const seen: string[] = [];
    const scanner = createCsvScanner(options, (_recordNumber, fields) => {
      seen.push(fields.join('|'));
    });

    scanner.push('a,b\n1,2\n3,');
    assert.deepEqual(seen, ['a|b', '1|2'], 'the finished records were held back');

    scanner.push('4\n5,6\n');
    scanner.end();
    assert.deepEqual(
      seen,
      ['a|b', '1|2', '3|4', '5|6'],
      'a record was handed over twice, so more than the unfinished record was carried',
    );
  });

  it('does not wait for a terminator that will never come', () => {
    // A file whose last record has no line terminator is finished by `end()`,
    // and the records before it were handed over long before that.
    const seen: string[] = [];
    const scanner = createCsvScanner(options, (_recordNumber, fields) => {
      seen.push(fields.join('|'));
    });
    scanner.push('a,b\n1,2\n');
    assert.deepEqual(seen, ['a|b']);
    scanner.push('3,4');
    scanner.end();
    assert.deepEqual(seen, ['a|b', '1|2', '3|4']);
  });
});

/**
 * The independent count, over a file that arrives in pieces.
 *
 * The census exists so that "rows read" is not the reader agreeing with itself.
 * A census that needed the whole file would put the file back in memory to
 * check that the reader did not have to, so it counts a piece at a time — and
 * has to reach the same number however the pieces fall, including when a CRLF
 * or an escaped quote is split between two of them.
 */
describe('the row census counts in pieces', () => {
  const CASES = [
    ['plain rows', 'a,b\n1,2\n3,4\n'],
    ['an escaped quote', 'a\n"x""y"\n'],
    ['CRLF terminators', 'a,b\r\n1,2\r\n'],
    ['a quoted line break', 'a,b\n1,"two\nlines"\n5,6'],
    ['blank lines', '\n\n'],
    ['no terminator at all', 'a'],
    ['nothing', ''],
  ] as const;

  for (const [label, text] of CASES) {
    it(`agrees with the whole-text count on ${label}`, () => {
      const whole = countCsvRecords(text, ',');
      for (let size = 1; size <= Math.max(1, text.length + 2); size += 1) {
        const census = createCsvCensus();
        for (let at = 0; at < text.length; at += size) census.push(text.slice(at, at + size));
        assert.equal(census.total(), whole, `${label} disagreed at chunk size ${String(size)}`);
      }
    });
  }
});

/**
 * The reader's allocation is bounded while a cell and a record grow (R2-015, B02-R2).
 *
 * The limits used to be checked when a field was finished, so a cell that never
 * ended was never refused, and a record made of many cells that were each
 * within their limit had no limit at all. The unfinished record was also read
 * again from its first character whenever more arrived, so the cost of one
 * long record grew with the square of its length.
 */
describe('the CSV reader bounds a cell and a record while they grow', () => {
  // Typed with the keys this reader has today and the ones it is given in 2.0.3;
  // the extra key travels through a spread so that the file reads either way.
  const limited = (extra: Record<string, number>) => ({ ...options, ...extra });
  const refusal = (limit: string) => (error: unknown): boolean => {
    assert.ok(isMigrationError(error), `expected a structured error, got ${String(error)}`);
    assert.equal(error.code, 'INPUT_LIMIT_EXCEEDED');
    assert.equal(error.details['limit'], limit);
    return true;
  };

  it('[R2-015] refuses an unfinished cell as soon as it passes maxCellLength', () => {
    const scanner = createCsvScanner(limited({ maxCellLength: 10 }), () => undefined);
    // The probe from the review: ten thousand characters, no delimiter, no terminator.
    assert.throws(() => { scanner.push('x'.repeat(10_000)); }, refusal('maxCellLength'));

    // A quoted cell that never closes is refused in the same push.
    const quoted = createCsvScanner(limited({ maxCellLength: 10 }), () => undefined);
    assert.throws(() => { quoted.push(`"${'x'.repeat(10_000)}`); }, refusal('maxCellLength'));

    // And in pieces: the refusal comes with the piece that crosses the limit,
    // not with the end of the file.
    const pieces = createCsvScanner(limited({ maxCellLength: 10 }), () => undefined);
    let pushes = 0;
    assert.throws(() => {
      for (let index = 0; index < 1_000; index += 1) {
        pushes += 1;
        pieces.push('abcde');
      }
    }, refusal('maxCellLength'));
    assert.ok(pushes <= 4, `the cell was refused after ${String(pushes)} pieces`);
  });

  it('[R2-015] refuses a record of individually valid cells above maxRecordBytes', () => {
    const record = Array.from({ length: 100 }, () => 'x'.repeat(1_024)).join(',');
    assert.equal(record.length, 102_499);
    const base = { maxCellLength: 1_024, maxColumns: 100 };
    assert.throws(
      () => createCsvScanner(limited({ ...base, maxRecordBytes: 100_000 }), () => undefined).push(`${record}\n`),
      refusal('maxRecordBytes'),
    );
    // One byte short of the record, whole and in pieces.
    const short = limited({ ...base, maxRecordBytes: 102_498 });
    assert.throws(() => {
      const scanner = createCsvScanner(short, () => undefined);
      scanner.push(`${record}\n`);
      scanner.end();
    }, refusal('maxRecordBytes'));
    assert.throws(() => {
      const scanner = createCsvScanner(short, () => undefined);
      for (let at = 0; at < record.length; at += 500) scanner.push(record.slice(at, at + 500));
      scanner.end();
    }, refusal('maxRecordBytes'));
  });

  it('[R2-015] admits a record exactly at maxRecordBytes', () => {
    const record = Array.from({ length: 100 }, () => 'x'.repeat(1_024)).join(',');
    const seen: number[] = [];
    const exact = limited({ maxCellLength: 1_024, maxColumns: 100, maxRecordBytes: 102_499 });
    const scanner = createCsvScanner(exact, (_number, fields) => { seen.push(fields.length); });
    for (let at = 0; at < record.length; at += 700) scanner.push(record.slice(at, at + 700));
    scanner.push('\n');
    scanner.end();
    assert.deepEqual(seen, [100]);

    // Bytes, not characters: 'é' is two bytes in the file, so two of them fill four.
    const bytes = (limit: number) => () => {
      const reader = createCsvScanner(limited({ maxRecordBytes: limit }), () => undefined);
      reader.push('éé\n');
      reader.end();
    };
    assert.doesNotThrow(bytes(4));
    assert.throws(bytes(3), refusal('maxRecordBytes'));
  });

  it('[R2-015] an unfinished record is scanned once, not re-read per block', () => {
    const total = 200_000;
    const scanner = createCsvScanner(limited({ maxCellLength: 1_000_000, maxRecordBytes: 1_000_000 }), () => undefined);
    const block = 64;
    for (let at = 0; at < total; at += block) scanner.push('x'.repeat(Math.min(block, total - at)));
    const scanned = scanner.end() as { charactersExamined?: number };
    // One record of 200,000 characters arriving 64 at a time. Re-reading it per
    // block would examine about 3,000 times that.
    assert.equal(typeof scanned.charactersExamined, 'number', 'the scanner reports how many characters it examined');
    assert.ok(
      (scanned.charactersExamined ?? Infinity) <= total,
      `${String(scanned.charactersExamined)} characters were examined for a record of ${String(total)}`,
    );
  });
});

/**
 * What the reader says about a file does not depend on how the bytes arrive (S021).
 *
 * The earlier agreement tests cut a string into pieces and fed the same scanner
 * on both sides, which shows the scanner agrees with itself. The bytes of a file
 * are cut somewhere else first: a decoder turns them into text, and a cut that
 * falls inside a two-, three- or four-byte character has to come out as that
 * character and not as two replacements. So this goes through \`ingestBundle\`
 * on real files and compares everything the bundle publishes -- file and column
 * locators, every row's locator and hash, the rejected rows, the evidence -- for
 * a read in one block and for a read in blocks of every size from one byte up.
 */
describe('the public locators do not depend on the block size', () => {
  const UTF8_TEXT =
    'Id,Name,Note\r\n' +
    '1,Zoë,"line one\nline two, 日本語"\r\n' +
    '2,😀,plain\r\n' +
    '3,short\r\n' +
    '\r\n' +
    '4,Åsa,"say ""hi"""\r\n';
  const UTF16_TEXT = 'Id,Name\r\n1,😀 Ada\r\n2,Zoë\r\n';

  function publish(root: string, blockBytes: number | null): string {
    const config = loadConfig(
      JSON.stringify({
        configVersion: '3.0.0',
        source: { system: 'crm', namespace: 'acme' },
        target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
        files: [
          { id: 'one', path: 'one.csv', format: 'CSV' },
          { id: 'two', path: 'two.csv', format: 'CSV' },
        ],
        records: ['one', 'two'].map((id) => ({
          id,
          fileId: id,
          object: 'CONTACT',
          sourceRecordIdColumn: { header: 'Id' },
          fields: [{ column: { header: 'Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' }],
        })),
      }),
      's021',
    ).config;
    const extra = blockBytes === null ? {} : { blockBytes };
    const bundle = ingestBundle({ inputRoot: root, config, ...extra });
    return JSON.stringify({
      bundleId: bundle.bundleId,
      files: bundle.files.map((file) => ({
        file: file.file,
        sheets: file.sheets.map((sheet) => ({
          sheet: sheet.sheet,
          columns: sheet.columns,
          headerRowNumber: sheet.headerRowNumber,
          readerRowCount: sheet.readerRowCount,
          dataRowCount: sheet.dataRowCount,
          rejected: sheet.rejectedRows,
          evidence: sheet.evidence,
          rows: [...sheet.rows],
        })),
      })),
    });
  }

  function countReads<T>(run: () => T): { value: T; reads: number } {
    const original = fs.readSync;
    let reads = 0;
    fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return (original as (...a: unknown[]) => number)(...args);
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      return { value: run(), reads };
    } finally {
      fs.readSync = original;
      syncBuiltinESMExports();
    }
  }

  it('[S021] public locators and counts agree whole and at every byte-chunk size, including splits inside a multi-byte character', () => {
    const root = scratchDir('s021');
    const utf8 = Buffer.from(UTF8_TEXT, 'utf8');
    writeFileSync(join(root, 'one.csv'), utf8);
    writeFileSync(join(root, 'two.csv'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(UTF16_TEXT, 'utf16le')]));

    const whole = publish(root, null);
    const parsed = JSON.parse(whole) as { files: { sheets: { readerRowCount: number; rejected: unknown[] }[] }[] };
    assert.equal(parsed.files[0]?.sheets[0]?.readerRowCount, 5, 'four records and a blank line');
    assert.equal(parsed.files[0]?.sheets[0]?.rejected.length, 2, 'the short row and the blank line are rejected with locators');

    for (let size = 1; size <= utf8.length + 1; size += 1) {
      const counted = countReads(() => publish(root, size));
      assert.ok(
        counted.reads >= Math.ceil(utf8.length / size),
        `a block size of ${String(size)} was not honoured: ${String(counted.reads)} reads for ${String(utf8.length)} bytes`,
      );
      assert.equal(counted.value, whole, `the published locators differ at a block size of ${String(size)} bytes`);
    }
  });
});
