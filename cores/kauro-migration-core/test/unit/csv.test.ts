import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createCsvScanner, readCsv, scanCsv } from '../../src/ingest/csv-reader.js';
import { escapeField, renderCsv } from '../../src/artifacts/csv-writer.js';
import { decodeSource } from '../../src/ingest/encoding.js';
import { isMigrationError } from '../../src/domain/errors.js';

const options = { delimiter: ',', filePath: 'test.csv', maxCellLength: 10_000, maxColumns: 100, maxRows: 1_000 };

describe('CSV reading', () => {
  it('performs no type inference at all', () => {
    const parsed = readCsv('a,b,c\n007,1.50,2026-01-02\n', options);
    assert.deepEqual(parsed.records[1]?.fields, ['007', '1.50', '2026-01-02']);
  });

  it('handles quoted delimiters, quotes and newlines', () => {
    const parsed = readCsv('a,b\n"x,y","he said ""hi""\nsecond line"\n', options);
    assert.deepEqual(parsed.records[1]?.fields, ['x,y', 'he said "hi"\nsecond line']);
  });

  it('counts records, not physical lines', () => {
    const parsed = readCsv('a,b\n"one\ntwo",z\nlast,row\n', options);
    assert.equal(parsed.records.length, 3);
    assert.equal(parsed.records[2]?.recordNumber, 3);
  });

  it('reads all three line terminators and reports which dominated', () => {
    assert.equal(readCsv('a\r\nb\r\n', options).lineTerminator, 'CRLF');
    assert.equal(readCsv('a\nb\n', options).lineTerminator, 'LF');
    assert.equal(readCsv('a\rb\r', options).lineTerminator, 'CR');
  });

  it('preserves an empty trailing field', () => {
    const parsed = readCsv('a,b,c\n1,,\n', options);
    assert.deepEqual(parsed.records[1]?.fields, ['1', '', '']);
  });

  it('fails on an unterminated quote rather than guessing where the field ends', () => {
    assert.throws(
      () => readCsv('a,b\n"open,value\n', options),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });

  it('fails on a quote in the middle of an unquoted field', () => {
    assert.throws(
      () => readCsv('a,b\nva"lue,x\n', options),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });

  it('enforces the cell length limit with the numbers in the message', () => {
    assert.throws(
      () => readCsv(`a\n${'x'.repeat(50)}\n`, { ...options, maxCellLength: 10 }),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'INPUT_LIMIT_EXCEEDED' &&
        error.details['limit'] === 'maxCellLength',
    );
  });
});

describe('CSV writing', () => {
  it('quotes only what has to be quoted', () => {
    assert.equal(escapeField('plain'), 'plain');
    assert.equal(escapeField('with,comma'), '"with,comma"');
    assert.equal(escapeField('with"quote'), '"with""quote"');
    assert.equal(escapeField('with\nnewline'), '"with\nnewline"');
    assert.equal(escapeField(' leading'), '" leading"');
  });

  it('does not rewrite a value a spreadsheet would read as a formula', () => {
    assert.equal(escapeField('=SUM(A1)'), '=SUM(A1)');
    assert.equal(escapeField('@channel'), '@channel');
    assert.equal(escapeField('+15551234567'), '+15551234567');
  });

  it('round-trips through the reader byte for byte', () => {
    const values = [
      '=SUM(A1:A9)',
      'he said "hi"',
      'line\nbreak',
      '  padded  ',
      'Núñez',
      '',
      '007',
      'semi;colon',
    ];
    const text = renderCsv(['v'], values.map((value) => [value]));
    const parsed = readCsv(text, options);
    assert.deepEqual(
      parsed.records.slice(1).map((record) => record.fields[0]),
      values,
    );
  });

  it('always ends with a newline and uses LF', () => {
    const text = renderCsv(['a'], [['1']]);
    assert.equal(text, 'a\n1\n');
  });
});

describe('encoding', () => {
  it('strips a UTF-8 byte-order mark and records the evidence', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n', 'utf8')]);
    const decoded = decodeSource(bytes, null, 'x.csv');
    assert.equal(decoded.text, 'a,b\n');
    assert.equal(decoded.evidence, 'BOM_UTF8');
  });

  it('decodes UTF-16 in both byte orders', () => {
    const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé\n', 'utf16le')]);
    assert.equal(decodeSource(little, null, 'x.csv').text, 'hé\n');

    const source = Buffer.from('hé\n', 'utf16le');
    const swapped = Buffer.alloc(source.length);
    for (let index = 0; index < source.length; index += 2) {
      swapped[index] = source[index + 1] as number;
      swapped[index + 1] = source[index] as number;
    }
    const big = Buffer.concat([Buffer.from([0xfe, 0xff]), swapped]);
    assert.equal(decodeSource(big, null, 'x.csv').text, 'hé\n');
  });

  it('fails with a byte offset rather than producing replacement characters', () => {
    const bytes = Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a]);
    assert.throws(
      () => decodeSource(bytes, null, 'x.csv'),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'ENCODING_UNKNOWN' &&
        typeof error.details['byteOffset'] === 'number',
    );
  });

  it('decodes windows-1252 when it is declared', () => {
    const bytes = Buffer.from([0x93, 0x41, 0x94, 0x0a]);
    assert.equal(decodeSource(bytes, 'WINDOWS_1252', 'x.csv').text, '“A”\n');
  });

  it('rejects a byte windows-1252 does not define', () => {
    assert.throws(
      () => decodeSource(Buffer.from([0x81]), 'WINDOWS_1252', 'x.csv'),
      (error: unknown) => isMigrationError(error) && error.code === 'ENCODING_UNKNOWN',
    );
  });

  it('refuses a declared encoding that contradicts the byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\n', 'utf8')]);
    assert.throws(
      () => decodeSource(bytes, 'WINDOWS_1252', 'x.csv'),
      (error: unknown) => isMigrationError(error) && error.code === 'ENCODING_UNKNOWN',
    );
  });
});

/**
 * The property the canonical-bytes check leans on.
 *
 * That check compares an artifact a line at a time: each line against a
 * re-render of the record parsed from it. Doing that is only the same question
 * as comparing the whole file while the reader turns *every* byte into a record
 * — otherwise a reader that stopped early would leave a trailer nobody compared,
 * and a partial comparison would read as a pass.
 *
 * It is a property of the reader rather than of that check, so it is held here.
 */
describe('the reader accounts for every byte', () => {
  const options = {
    delimiter: ',',
    filePath: 'accounting.csv',
    maxCellLength: 1_000_000,
    maxColumns: 100,
    maxRows: 1_000_000,
  };

  const consumed = (text: string): number => {
    const { records } = readCsv(text, options);
    // What a record occupies in the source: its fields re-rendered, plus the
    // terminator that ended it. The final record has one only if the file did.
    let total = 0;
    for (const record of records) {
      total += record.fields.map((field) => escapeField(field)).join(',').length + 1;
    }
    return text.endsWith('\n') ? total : total - 1;
  };

  for (const [label, text] of [
    ['a plain file', 'a,b,c\n1,2,3\n'],
    ['no terminator on the last row', 'a,b,c\n1,2,3'],
    ['a trailing blank line', 'a,b,c\n1,2,3\n\n'],
    ['two trailing blank lines', 'a,b,c\n1,2,3\n\n\n'],
    ['a quoted comma', 'a,b\n"x,y",2\n'],
    ['a quoted newline', 'a,b\n"x\ny",2\n'],
    ['an escaped quote', 'a,b\n"x""y",2\n'],
    ['empty cells throughout', 'a,b,c\n,,\n'],
    ['a single column', 'a\n1\n'],
    ['unicode', 'a,b\nMiguel López,Ω\n'],
  ] as const) {
    it(`accounts for every byte of ${label}`, () => {
      assert.equal(consumed(text), text.length, `${label} left bytes unaccounted for`);
    });
  }
});

/**
 * The chunked reader says exactly what the whole-string reader says.
 *
 * This is the test the chunked path exists to earn. A reader fed in pieces has
 * one new way to be wrong — a piece may split a field, a quoted newline, a CRLF
 * or a record — and every one of those is a place where a value silently changes
 * or a row silently disappears. Nothing else in this repository would catch it:
 * the packages it verifies are well-formed, so a boundary bug shows up as a
 * verification that passes when it should not.
 *
 * So the property is checked directly, over hostile inputs, at every chunk size
 * from one character upward. One character is the important one: at that size
 * every boundary in the file is exercised at once.
 */
describe('reading a file in pieces says the same thing as reading it whole', () => {
  const options = {
    delimiter: ',',
    filePath: 'chunked.csv',
    maxCellLength: 1_000_000,
    maxColumns: 100,
    maxRows: 1_000_000,
  };

  const CASES: readonly (readonly [string, string])[] = [
    ['a plain file', 'a,b,c\n1,2,3\n4,5,6\n'],
    ['no terminator on the last row', 'a,b\n1,2'],
    ['CRLF throughout', 'a,b\r\n1,2\r\n'],
    ['a lone carriage return', 'a,b\r1,2\r'],
    ['mixed terminators', 'a,b\r\n1,2\n3,4\r'],
    ['a quoted comma', 'a,b\n"x,y",2\n'],
    ['a quoted newline', 'a,b\n"x\ny",2\n'],
    ['a quoted CRLF', 'a,b\r\n"x\r\ny",2\r\n'],
    ['an escaped quote', 'a,b\n"x""y",2\n'],
    ['a field that is only escaped quotes', 'a,b\n"""""",2\n'],
    ['empty cells throughout', 'a,b,c\n,,\n'],
    ['a final row of one empty quoted field', 'a\n""'],
    ['a trailing blank line', 'a,b\n1,2\n\n'],
    ['unicode beyond the basic plane', 'a,b\nMiguel López,𝄞Ω\n'],
    ['a value a spreadsheet would evaluate', 'a,b\n=SUM(A1),2\n'],
    ['a long field', `a,b\n${'x'.repeat(5000)},2\n`],
    ['many rows', `a,b\n${Array.from({ length: 200 }, (_, i) => `${String(i)},v${String(i)}`).join('\n')}\n`],
  ];

  const whole = (text: string): unknown => {
    const seen: unknown[] = [];
    const result = scanCsv(text, options, (recordNumber, fields) => {
      seen.push({ recordNumber, fields: [...fields] });
    });
    return { seen, ...result };
  };

  const inPieces = (text: string, size: number): unknown => {
    const seen: unknown[] = [];
    const scanner = createCsvScanner(options, (recordNumber, fields) => {
      seen.push({ recordNumber, fields: [...fields] });
    });
    for (let at = 0; at < text.length; at += size) scanner.push(text.slice(at, at + size));
    const result = scanner.end();
    return { seen, ...result };
  };

  for (const [label, text] of CASES) {
    it(`agrees on ${label}, at every chunk size`, () => {
      const expected = whole(text);
      for (let size = 1; size <= text.length + 2; size += 1) {
        assert.deepEqual(inPieces(text, size), expected, `${label} disagreed at chunk size ${String(size)}`);
      }
    });
  }

  it('refuses an unclosed quote wherever the pieces fall', () => {
    const text = 'a,b\n"never closed,2\n';
    for (let size = 1; size <= text.length + 2; size += 1) {
      assert.throws(
        () => inPieces(text, size),
        (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
        `an unclosed quote was accepted at chunk size ${String(size)}`,
      );
    }
  });

  it('reports the offset in the file, not in the piece', () => {
    // A message naming an offset inside a chunk would send somebody to the
    // wrong place in a 450 MB artifact, which is worse than naming none.
    const text = 'a,b\n1,"x"y\n';
    const fromWhole = (() => {
      try {
        whole(text);
        return null;
      } catch (error) {
        return isMigrationError(error) ? error.details['characterOffset'] : null;
      }
    })();
    assert.notEqual(fromWhole, null, 'the whole-string reader was expected to refuse this');
    for (let size = 1; size <= text.length + 2; size += 1) {
      try {
        inPieces(text, size);
        assert.fail(`accepted at chunk size ${String(size)}`);
      } catch (error) {
        if (!isMigrationError(error)) throw error;
        assert.equal(error.details['characterOffset'], fromWhole, `wrong offset at chunk size ${String(size)}`);
      }
    }
  });
});
