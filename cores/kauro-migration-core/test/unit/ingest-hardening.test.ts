import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { readCsv } from '../../src/ingest/csv-reader.js';
import { decodeSource } from '../../src/ingest/encoding.js';
import { parseXml, parseXmlChunks } from '../../src/ingest/xml-pull-parser.js';
import { readWorkbook } from '../../src/ingest/xlsx-reader.js';
import { ingestBundle } from '../../src/ingest/ingest-bundle.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCensusAgrees,
  countCsvRecords,
  countWorksheetRows,
  createWorksheetRowCensus,
} from '../../src/ingest/row-census.js';
import { DEFAULT_LIMITS } from '../../src/domain/config.js';
import { isMigrationError } from '../../src/domain/errors.js';
import type { ErrorCode } from '../../src/domain/errors.js';
import { runMigration } from '../../src/run/run-migration.js';
import { GOLDEN_ROOT, caseScratch, collect, scratchDir } from '../support/harness.js';

/**
 * Every case here reproduces a way an independent review got the readers to
 * accept malformed input and lose or invent source data. They are grouped by
 * the reviewer's finding so that a regression points straight back at what it
 * used to do.
 */

const CSV = { delimiter: ',', filePath: 'x.csv', maxCellLength: 100_000, maxColumns: 500, maxRows: 100_000 };

function expectFailure(code: ErrorCode, fragment: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    if (!isMigrationError(error)) {
      throw new Error(`expected a structured MigrationError, got ${String(error)}`);
    }
    assert.equal(error.code, code, error.message);
    assert.ok(
      `${error.message} ${JSON.stringify(error.details)}`.includes(fragment),
      `expected "${fragment}" in: ${error.message}`,
    );
    return true;
  });
}

const MTIME = 1_577_836_800_000;

function workbook(sheetXml: string): Uint8Array {
  return zipSync(
    {
      '[Content_Types].xml': [
        strToU8(
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        ),
        { mtime: MTIME },
      ],
      '_rels/.rels': [
        strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        ),
        { mtime: MTIME },
      ],
      'xl/workbook.xml': [
        strToU8(
          '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        { mtime: MTIME },
      ],
      'xl/_rels/workbook.xml.rels': [
        strToU8(
          '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        { mtime: MTIME },
      ],
      'xl/worksheets/sheet1.xml': [strToU8(sheetXml), { mtime: MTIME }],
    },
    { level: 0 },
  );
}

/** A workbook of several named sheets, each in its own part. */
function workbookOfSheets(sheets: readonly (readonly [string, string])[]): Uint8Array {
  const parts: Record<string, [Uint8Array, { mtime: number }]> = {
    '[Content_Types].xml': [
      strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      ),
      { mtime: MTIME },
    ],
    '_rels/.rels': [
      strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      { mtime: MTIME },
    ],
    'xl/workbook.xml': [
      strToU8(
        `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
          .map(([name], index) => `<sheet name="${name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`)
          .join('')}</sheets></workbook>`,
      ),
      { mtime: MTIME },
    ],
    'xl/_rels/workbook.xml.rels': [
      strToU8(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, index) =>
              `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
          )
          .join('')}</Relationships>`,
      ),
      { mtime: MTIME },
    ],
  };
  sheets.forEach(([, xml], index) => {
    parts[`xl/worksheets/sheet${String(index + 1)}.xml`] = [strToU8(xml), { mtime: MTIME }];
  });
  return zipSync(parts, { level: 0 });
}

/**
 * An archive holding two members with one name.
 *
 * A zip is a list of records, not a map, so this is a shape a real archive can
 * have and a builder keyed by name cannot produce. It is made by writing the
 * second member under a placeholder of the same byte length and then renaming
 * it in place, which leaves every offset in the archive unchanged.
 */
function withExtraMember(name: string, first: string, second: string): Uint8Array {
  const placeholder = `${name.slice(0, -5)}ZZZZZ`;
  const bytes = zipSync(
    {
      ...Object.fromEntries(
        Object.entries(unzipSync(workbook(first))).map(([key, value]) => [key, [value, { mtime: MTIME }] as const]),
      ),
      [placeholder]: [strToU8(second), { mtime: MTIME }],
    },
    { level: 0 },
  );
  const from = strToU8(placeholder);
  for (let index = 0; index + from.length <= bytes.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < from.length; offset += 1) {
      if (bytes[index + offset] !== from[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const replacement = strToU8(name);
    for (let offset = 0; offset < replacement.length; offset += 1) {
      bytes[index + offset] = replacement[offset] as number;
    }
  }
  return bytes;
}

const sheet = (rows: string): string =>
  `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

describe('CSV: a row cannot be lost or invented', () => {
  it('keeps a final record that is one quoted empty field with no trailing newline', () => {
    // This row used to vanish: `field` and `fields` were both empty at EOF, so
    // the record was never pushed and the row had no disposition anywhere.
    const parsed = readCsv('a,b,c\n1,Ada,x\n""', CSV);
    assert.equal(parsed.records.length, 3);
    assert.deepEqual(parsed.records[2]?.fields, ['']);
  });

  it('gives the same row count with and without a trailing newline', () => {
    assert.equal(readCsv('a\n1\n""', CSV).records.length, readCsv('a\n1\n""\n', CSV).records.length);
  });

  it('refuses text after a closing quote instead of absorbing it', () => {
    // `1,"Ann"Smith,x` used to deliver `AnnSmith`, a value the file never held.
    expectFailure('INPUT_CORRUPT', 'text after a closing quote', () => readCsv('a,b,c\n1,"Ann"Smith,x\n', CSV));
  });

  it('still accepts a closing quote followed by a delimiter, a terminator or the end of the file', () => {
    assert.deepEqual(readCsv('a,b\n"x",y\n', CSV).records[1]?.fields, ['x', 'y']);
    assert.deepEqual(readCsv('a\n"x"\n', CSV).records[1]?.fields, ['x']);
    assert.deepEqual(readCsv('a\n"x"', CSV).records[1]?.fields, ['x']);
    assert.deepEqual(readCsv('a\n"x"\r\n', CSV).records[1]?.fields, ['x']);
  });
});

describe('encoding: UTF-16 is as fail-closed as UTF-8', () => {
  const utf16le = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

  it('reads well-formed UTF-16LE', () => {
    assert.equal(decodeSource(utf16le('héllo\n'), null, 'x.csv').text, 'héllo\n');
  });

  it('refuses an unpaired surrogate rather than substituting U+FFFD', () => {
    // This used to deliver EF BF BD into the import file, a character the
    // customer never had, and the package still verified.
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x41, 0x00, 0x00, 0xd8, 0x42, 0x00])]);
    expectFailure('ENCODING_UNKNOWN', 'unpaired UTF-16 surrogate', () => decodeSource(bytes, null, 'x.csv'));
  });

  it('refuses a trailing surrogate with no leading half', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x00, 0xdc])]);
    expectFailure('ENCODING_UNKNOWN', 'trailing UTF-16 surrogate', () => decodeSource(bytes, null, 'x.csv'));
  });

  it('refuses an odd byte count in little-endian as well as big-endian', () => {
    // Only the big-endian path was guarded, so a truncated little-endian file
    // silently lost its last character.
    const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([0x41, 0x00, 0x42])]);
    expectFailure('ENCODING_UNKNOWN', 'odd number of bytes', () => decodeSource(little, null, 'x.csv'));

    const big = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00, 0x41, 0x00])]);
    expectFailure('ENCODING_UNKNOWN', 'odd number of bytes', () => decodeSource(big, null, 'x.csv'));
  });

  it('reports the offset of the byte that is actually invalid', () => {
    // Bisection reported offset 0 here, blaming a valid lead byte.
    assert.throws(
      () => decodeSource(Buffer.from([0xc3, 0xa9, 0xff]), null, 'x.csv'),
      (error: unknown) => isMigrationError(error) && error.details['byteOffset'] === 2,
    );
    assert.throws(
      () => decodeSource(Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xff]), null, 'x.csv'),
      (error: unknown) => isMigrationError(error) && error.details['byteOffset'] === 4,
    );
  });

  it('rejects an overlong encoding and an encoded surrogate', () => {
    expectFailure('ENCODING_UNKNOWN', 'not valid UTF-8', () => decodeSource(Buffer.from([0xc0, 0xaf]), null, 'x.csv'));
    expectFailure('ENCODING_UNKNOWN', 'not valid UTF-8', () =>
      decodeSource(Buffer.from([0xed, 0xa0, 0x80]), null, 'x.csv'),
    );
  });
});

describe('XML: the parser refuses what it does not fully understand', () => {
  it('refuses a document that ends with an element still open', () => {
    // A truncated worksheet used to read as a shorter but well-formed one, and
    // the rows after the truncation disappeared with no error at all.
    expectFailure('INPUT_CORRUPT', 'still open', () => [...parseXml('<a><b>text', 'x')]);
  });

  it('refuses a mismatched closing tag', () => {
    expectFailure('INPUT_CORRUPT', 'is closed by', () => [...parseXml('<a><b></a></b>', 'x')]);
  });

  it('refuses a closing tag with no opening tag', () => {
    expectFailure('INPUT_CORRUPT', 'no matching opening tag', () => [...parseXml('<a></a></b>', 'x')]);
  });

  it('refuses a repeated attribute', () => {
    expectFailure('INPUT_CORRUPT', 'appears twice', () => [...parseXml('<c r="A1" r="B1"/>', 'x')]);
  });

  it('still accepts well-formed documents, including self-closing elements', () => {
    const events = [...parseXml('<a><b x="1"/><c>t</c></a>', 'x')];
    assert.equal(events.filter((event) => event.kind === 'start').length, 3);
    assert.equal(events.filter((event) => event.kind === 'end').length, 2);
  });
});

describe('workbook: no row is lost and no value is invented', () => {
  it('refuses a worksheet whose last row is never closed', () => {
    const xml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>1</t></is></c>';
    expectFailure('INPUT_CORRUPT', 'still open', () => readWorkbook(workbook(xml), DEFAULT_LIMITS, 'x.xlsx'));
  });

  it('refuses two rows claiming the same position', () => {
    expectFailure('INPUT_CORRUPT', 'more than once', () =>
      readWorkbook(workbook(sheet('<row r="2"/><row r="2"/>')), DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('refuses two cells claiming the same column', () => {
    expectFailure('INPUT_CORRUPT', 'more than once', () =>
      readWorkbook(
        workbook(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="A1" t="inlineStr"><is><t>b</t></is></c></row>')),
        DEFAULT_LIMITS,
        'x.xlsx',
      ),
    );
  });

  it('refuses a cell that sits outside any row', () => {
    expectFailure('INPUT_CORRUPT', 'outside any row', () =>
      readWorkbook(workbook(sheet('<c r="A1" t="inlineStr"><is><t>a</t></is></c>')), DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('refuses a shared-string reference that is not an index', () => {
    // `parseInt("0x1", 10)` is 0, which used to deliver a different cell's text.
    for (const value of ['0x1', '1abc', ' 1 ', '-1', '1.0']) {
      expectFailure('INPUT_CORRUPT', 'not an index', () =>
        readWorkbook(workbook(sheet(`<row r="1"><c r="A1" t="s"><v>${value}</v></c></row>`)), DEFAULT_LIMITS, 'x.xlsx'),
      );
    }
  });

  it('refuses a boolean cell that is neither 0 nor 1', () => {
    // `raw === '1' ? TRUE : FALSE` invented a definite answer from `2`.
    for (const value of ['2', 'true', '']) {
      expectFailure('INPUT_CORRUPT', 'neither 0 nor 1', () =>
        readWorkbook(workbook(sheet(`<row r="1"><c r="A1" t="b"><v>${value}</v></c></row>`)), DEFAULT_LIMITS, 'x.xlsx'),
      );
    }
  });

  it('refuses a cell type it does not understand instead of reading it as a number', () => {
    expectFailure('INPUT_CORRUPT', 'does not understand', () =>
      readWorkbook(workbook(sheet('<row r="1"><c r="A1" t="zzz"><v>5</v></c></row>')), DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('still reads a well-formed sheet with sparse cells and gaps between rows', () => {
    const read = readWorkbook(
      workbook(
        sheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c><c r="C1" t="inlineStr"><is><t>Name</t></is></c></row>' +
            '<row r="2"><c r="A2"><v>1</v></c></row>' +
            '<row r="4"><c r="C4" t="inlineStr"><is><t>Ada</t></is></c></row>',
        ),
      ),
      DEFAULT_LIMITS,
      'x.xlsx',
    );
    assert.equal(read.sheets[0]?.rows.length, 3);
    assert.deepEqual(
      read.sheets[0]?.rows.map((row) => row.rowNumber),
      [1, 2, 4],
    );
  });

  it('refuses rows written out of position order', () => {
    // Rows were kept in document order, so a worksheet writing row 3 before
    // row 1 made row 3 the header and every value landed under the wrong
    // column name. Excel and LibreOffice always write ascending, so refusing
    // costs nothing a real export needs.
    expectFailure('INPUT_CORRUPT', 'declares row 1 after row 3', () =>
      readWorkbook(
        workbook(
          sheet(
            '<row r="3"><c r="A3" t="inlineStr"><is><t>Ada</t></is></c></row>' +
              '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>',
          ),
        ),
        DEFAULT_LIMITS,
        'x.xlsx',
      ),
    );
  });

  it('refuses a worksheet with more than one top-level element', () => {
    expectFailure('INPUT_CORRUPT', 'top-level elements', () =>
      readWorkbook(
        workbook(`${sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>')}<trailing/>`),
        DEFAULT_LIMITS,
        'x.xlsx',
      ),
    );
  });

  it('refuses a sheet whose first row carries formatting and no values', () => {
    // Excel emits a row element for a formatted empty row. The reader keeps it,
    // as it must — it is a row of the sheet. Ingest used to take it as the
    // header, which made the sheet zero columns wide and reported every data
    // row as a column-count mismatch: the whole sheet unusable, for a reason
    // that named the wrong problem.
    const bytes = workbook(
      sheet('<row r="1" s="1" customFormat="1"/><row r="2"><c r="A2" t="inlineStr"><is><t>Id</t></is></c></row>'),
    );
    assert.equal(readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx').sheets[0]?.rows.length, 2);

    const root = mkdtempSync(join(tmpdir(), 'kmc-header-'));
    try {
      writeFileSync(join(root, 'contacts.xlsx'), bytes);
      const config = loadConfig(
        JSON.stringify({
          configVersion: '3.0.0',
          source: { system: 'crm', namespace: 'acme' },
          target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
          files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
          records: [
            {
              id: 'contacts',
              fileId: 'contacts',
              object: 'CONTACT',
              sourceRecordIdColumn: { header: 'Id' },
              fields: [{ column: { header: 'Id' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
            },
          ],
        }),
        'test.json',
      ).config;
      expectFailure('INPUT_CORRUPT', 'has no value in its first row', () =>
        ingestBundle({ inputRoot: root, config }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A second review took the readers apart again. These are the inputs it found
 * that lost or invented rows with the run reporting success and the package
 * verifying clean, plus the independent count that now stands behind both
 * readers.
 */
describe('a second review: rows lost and invented inside the readers', () => {
  const workbookWithTwoSheets = (worksheets: Readonly<Record<string, string>>, sheetsXml: string, relsXml: string) =>
    zipSync(
      {
        '[Content_Types].xml': [
          strToU8(
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
          ),
          { mtime: MTIME },
        ],
        '_rels/.rels': [
          strToU8(
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
          ),
          { mtime: MTIME },
        ],
        'xl/workbook.xml': [
          strToU8(
            `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetsXml}</sheets></workbook>`,
          ),
          { mtime: MTIME },
        ],
        'xl/_rels/workbook.xml.rels': [strToU8(relsXml), { mtime: MTIME }],
        ...Object.fromEntries(
          Object.entries(worksheets).map(([path, xml]) => [path, [strToU8(xml), { mtime: MTIME }] as const]),
        ),
      },
      { level: 0 },
    );

  it('refuses a row element outside sheetData instead of discarding it', () => {
    // Read as one row before: Alan was in no artifact, and every count agreed
    // because every count came from the reader.
    const xml =
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c></row></sheetData>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Alan</t></is></c></row></worksheet>';
    expectFailure('INPUT_CORRUPT', 'outside <sheetData>', () =>
      readWorkbook(workbook(xml), DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('refuses two sheet declarations that read one worksheet part', () => {
    // Read as four rows before, and delivered every record in the sheet twice
    // under two migration keys.
    const bytes = workbookWithTwoSheets(
      {
        'xl/worksheets/sheet1.xml': sheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c></row>',
        ),
      },
      '<sheet name="Contacts" sheetId="1" r:id="rId1"/><sheet name="ContactsCopy" sheetId="2" r:id="rId1"/>',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    expectFailure('INPUT_CORRUPT', 'read the same worksheet part', () =>
      readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('reads an ISO date cell as the text it holds rather than refusing it', () => {
    const read = readWorkbook(
      workbook(sheet('<row r="1"><c r="A1" t="d"><v>2024-03-01T00:00:00</v></c></row>')),
      DEFAULT_LIMITS,
      'x.xlsx',
    );
    assert.equal(read.sheets[0]?.rows[0]?.cells[0]?.raw, '2024-03-01T00:00:00');
  });
});

describe('a third review: what the archive and the filesystem can hide', () => {
  it('refuses a workbook that contains two archive members with one name', () => {
    // Both the reader and the row census read whichever member won, so they
    // agree with each other and the run reports a smaller migration as a
    // complete one. Same principle as INPUT_DUPLICATE_FILE, one level down.
    const good = sheet(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Alan</t></is></c></row>',
    );
    const shadow = sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row>');
    const doubled = withExtraMember('xl/worksheets/sheet1.xml', good, shadow);
    expectFailure('INPUT_CORRUPT', 'two archive members named', () =>
      readWorkbook(doubled, DEFAULT_LIMITS, 'x.xlsx'),
    );
  });

  it('reads a sheet whose only row carries formatting and no values as an empty sheet', () => {
    // The refusal added for a value-less header row fired on a sheet that has
    // no data at all — a formatted-but-empty Sheet2 that no mapping touches —
    // and killed the whole run with a remedy naming a row that is not there.
    const root = mkdtempSync(join(tmpdir(), 'kmc-empty-'));
    try {
      writeFileSync(
        join(root, 'contacts.xlsx'),
        workbookOfSheets([
          ['Contacts', sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Id</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>C-1</t></is></c></row>')],
          ['Sheet2', sheet('<row r="1" ht="15" customHeight="1" s="1" customFormat="1"/>')],
        ]),
      );
      const config = loadConfig(
        JSON.stringify({
          configVersion: '3.0.0',
          source: { system: 'crm', namespace: 'acme' },
          target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
          files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
          records: [
            {
              id: 'contacts',
              fileId: 'contacts',
              sheet: 'Contacts',
              object: 'CONTACT',
              sourceRecordIdColumn: { header: 'Id' },
              fields: [{ column: { header: 'Id' }, destinationField: 'contact.description', semanticType: 'TEXT' }],
            },
          ],
        }),
        'test.json',
      ).config;
      const bundle = ingestBundle({ inputRoot: root, config });
      const sheets = bundle.files[0]?.sheets ?? [];
      assert.equal(sheets.length, 2);
      assert.equal(sheets[1]?.readerRowCount, 0);
      assert.equal(sheets[1]?.dataRowCount, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the row census is a second opinion, not the reader repeating itself', () => {
  it('counts the records a well-formed CSV holds', () => {
    for (const [text, expected] of [
      ['a,b\r\n1,2\r\n', 2],
      ['a,b\n1,2', 2],
      ['a,b\r\n1,2\r\n\r\n3,4\r\n', 4],
      ['a,b\r\n"x\r\ny",2\r\n', 2],
      ['a,b\r\n1,""\r\n', 2],
      ['a,b\r\n1,2\r\n""', 3],
      ['a,b\r\n,\r\n', 2],
      ['', 0],
      ['\r\n\r\n', 2],
      ['a', 1],
    ] as const) {
      assert.equal(countCsvRecords(text, ','), expected, JSON.stringify(text));
      assert.equal(readCsv(text, CSV).records.length, expected, `reader disagrees on ${JSON.stringify(text)}`);
    }
  });

  it('counts row elements without being fooled by text that looks like one', () => {
    assert.equal(countWorksheetRows(sheet('<row r="1"/><row r="2"/>')), 2);
    assert.equal(countWorksheetRows(sheet('<rowBreaks count="1"><brk id="1"/></rowBreaks>')), 0);
    assert.equal(countWorksheetRows(sheet('<!-- <row r="9"/> --><row r="1"/>')), 1);
    assert.equal(countWorksheetRows(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[<row/>]]></t></is></c></row>')), 1);
    assert.equal(countWorksheetRows('<?xml version="1.0"?><worksheet><sheetData><x:row/></sheetData></worksheet>'), 1);
  });

  it('catches a reader that drops a record even though every count downstream agrees', () => {
    // The defect the anchor could not see: both sides of the equation came from
    // the reader's output, so a reader that lost a row reported a smaller
    // migration as a complete one.
    const text = 'a,b\r\n1,2\r\n3,4\r\n5,6\r\n';
    const produced = readCsv(text, CSV).records.length - 1;
    assert.equal(countCsvRecords(text, ','), 4);
    assert.throws(
      () => {
        assertCensusAgrees(produced, countCsvRecords(text, ','), 'x.csv', {});
      },
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });
});

/**
 * A fourth review, of the change that stopped the workbook reader holding the
 * workbook.
 *
 * Reading a part in blocks is only safe if it cannot change what the part says,
 * and there are exactly three ways it could: a token split across a boundary
 * could be read as two, a character split across a boundary could be read as
 * two broken ones, and a count taken from the same blocks could drift from a
 * count taken from the whole. Each of those is asked here directly, at every
 * split point rather than at a representative one, because the block size is a
 * constant and a test that used it would prove nothing about the next constant.
 */
describe('reading in blocks does not change what a part says', () => {
  const splits = (text: string, size: number): string[] => {
    const out: string[] = [];
    for (let at = 0; at < text.length; at += size) out.push(text.slice(at, at + size));
    return out.length === 0 ? [''] : out;
  };

  const documents = [
    sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>Ada Lovelace</t></is></c></row>'),
    sheet('<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve"> a &amp; b &lt;c&gt; </t></is></c></row>'),
    sheet('<row r="1"><!-- a comment with <row r="9"/> inside it --><c r="A1"><v>1</v></c></row>'),
    sheet('<row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[<row/> & ]]]]></t></is></c></row>'),
    sheet('<row r="1"/><row r="2"/><row r="3"/>'),
    '<?xml version="1.0"?><worksheet><sheetData><x:row/></sheetData></worksheet>',
  ];

  it('yields the same events whatever size the blocks are', () => {
    for (const document of documents) {
      const whole = [...parseXml(document, 'x')];
      for (let size = 1; size <= document.length + 1; size += 1) {
        assert.deepEqual(
          [...parseXmlChunks(splits(document, size), 'x')],
          whole,
          `blocks of ${String(size)} disagree on ${document.slice(0, 40)}`,
        );
      }
    }
  });

  it('still refuses a truncated document however the blocks fall', () => {
    // The refusal that matters most: a worksheet cut short used to read as a
    // shorter well-formed one. A block-based parser has a new way to get this
    // wrong -- treating the end of a block as the end of the document -- and it
    // would lose every row after the last complete block with no error at all.
    const truncated = '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v>';
    for (let size = 1; size <= truncated.length + 1; size += 1) {
      expectFailure('INPUT_CORRUPT', 'still open', () => [...parseXmlChunks(splits(truncated, size), 'x')]);
    }
  });

  it('counts the same rows whatever size the blocks are', () => {
    for (const document of documents) {
      const whole = countWorksheetRows(document);
      for (let size = 1; size <= document.length + 1; size += 1) {
        const census = createWorksheetRowCensus();
        for (const block of splits(document, size)) census.push(block);
        census.end();
        assert.equal(census.total(), whole, `blocks of ${String(size)} disagree on ${document.slice(0, 40)}`);
      }
    }
  });

  it('counts a row whose element name is split across two blocks exactly once', () => {
    // `<r` then `ow r="1"/>` is one row, not none and not two. The whole-string
    // scan cannot get this wrong because it never runs out of characters.
    const census = createWorksheetRowCensus();
    census.push('<?xml version="1.0"?><worksheet><sheetData><r');
    census.push('ow r="1"/><ro');
    census.push('wBreaks/></sheetData></worksheet>');
    census.end();
    assert.equal(census.total(), 1);
  });

  it('reads a multi-byte character that straddles a decode block as one character', () => {
    // The failure this exists to catch is silent: a decoder that finished at
    // every block boundary turns one character into two replacement characters,
    // at a position that depends on the block size. Nothing downstream can
    // detect that, because the row count and every hash agree with the value
    // the reader invented.
    //
    // The block size is not written here. The workbook is built once to find
    // where the marker actually lands in the part's bytes, and then rebuilt so
    // the marker sits astride the boundary -- and at every offset within it, so
    // a four-byte character is cut in all three places it can be cut.
    const BLOCK_BYTES = 1 << 16;
    const marker = '\u00e9\u20ac\u{1f600}';
    const build = (pad: number): Uint8Array =>
      workbook(
        sheet(
          `<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(pad)}${marker}tail</t></is></c></row>` +
            '<row r="2"><c r="A2" t="inlineStr"><is><t>after</t></is></c></row>',
        ),
      );
    const partOf = (bytes: Uint8Array): Uint8Array =>
      unzipSync(bytes, { filter: (file) => file.name === 'xl/worksheets/sheet1.xml' })[
        'xl/worksheets/sheet1.xml'
      ] as Uint8Array;
    const markerByteOffset = (pad: number): number =>
      Buffer.from(partOf(build(pad))).indexOf(Buffer.from(marker, 'utf8'));

    const found = markerByteOffset(0);
    assert.ok(found > 0, 'the marker has to be findable in the worksheet part');
    // Every padding that puts some part of the marker on the boundary, plus a
    // few either side so a passing test cannot be an accident of alignment.
    for (let offset = -2; offset <= marker.length * 4 + 2; offset += 1) {
      const pad = BLOCK_BYTES - found + offset;
      if (pad < 0) continue;
      const read = readWorkbook(build(pad), DEFAULT_LIMITS, 'x.xlsx');
      const cell = read.sheets[0]?.rows[0]?.cells[0];
      assert.equal(cell?.raw, `${'x'.repeat(pad)}${marker}tail`, `padding ${String(pad)} lost the marker`);
      assert.equal(read.sheets[0]?.rows[1]?.cells[0]?.raw, 'after');
      assert.equal(read.sheets[0]?.rows.length, 2);
    }
  });
});

/**
 * Occurrence identity (R2-001, B01-R3).
 *
 * A file is an occurrence: it has a path, a source namespace and a place in the
 * plan. Its digest is evidence about what it holds, never what it is. The
 * engine used to refuse any two files with equal bytes, which refused two
 * exports of one report taken from two instances.
 */
describe('occurrence identity', () => {
  const CSV_TEXT = 'Contact ID,First Name\n1,Ada\n2,Alan\n';

  function occurrencePlan(occurrences: unknown): string {
    const mapping = (id: string): unknown => ({
      id,
      fileId: id,
      object: 'CONTACT',
      sourceRecordIdColumn: { header: 'Contact ID' },
      fields: [{ column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' }],
    });
    return JSON.stringify({
      configVersion: '3.0.0',
      source: { system: 'crm', namespace: 'acme' },
      target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
      files: [
        { id: 'a', path: 'a.csv', format: 'CSV' },
        { id: 'b', path: 'b.csv', format: 'CSV' },
      ],
      records: [mapping('a'), mapping('b')],
      ...(occurrences === undefined ? {} : { occurrences }),
    });
  }

  function inputWithTwoEqualFiles(name: string): string {
    const root = scratchDir('occurrence', name);
    const input = join(root, 'input');
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, 'a.csv'), CSV_TEXT);
    writeFileSync(join(input, 'b.csv'), CSV_TEXT);
    return input;
  }

  function migrate(name: string, occurrences: unknown) {
    const input = inputWithTwoEqualFiles(name);
    const loaded = loadConfig(occurrencePlan(occurrences), `occurrence:${name}`);
    return runMigration({
      scratch: caseScratch(`occurrence-${name}`),
      inputRoot: input,
      config: loaded.config,
      configHash: loaded.configHash,
    });
  }

  it("[R2-001] an INDEPENDENT decision keeps both occurrences in lineage; EXCLUDE_ONE disposes the other occurrence's rows by name", () => {
    // INDEPENDENT: both files are read, each row has a locator of its own and
    // its own lineage line, and the decision is written where a reader sees it.
    const independent = migrate('independent', [{ files: ['a', 'b'], decision: 'INDEPENDENT' }]);
    assert.equal(independent.reconciliation.sourceRows.total, 4, 'two rows in each of two files');
    assert.equal(independent.reconciliation.sourceRows.withoutDisposition, 0);
    const lineage = collect(independent.truth.lineage);
    assert.equal(lineage.length, 4);
    assert.deepEqual(
      [...new Set(lineage.map((entry) => entry.address.filePath))].sort(),
      ['a.csv', 'b.csv'],
      'each occurrence is in the lineage under its own path',
    );
    assert.equal(new Set(lineage.map((entry) => entry.address.rowLocatorId)).size, 4, 'no two rows share a locator');
    assert.equal(new Set(independent.truth.sourceFiles.map((file) => file.fileId)).size, 2);
    for (const file of independent.truth.sourceFiles) {
      const evidence = file.sheets.flatMap((sheetEntry) => sheetEntry.evidence);
      assert.ok(
        evidence.some((item) => item.kind === 'FILE_EQUAL_BYTES_OTHER_OCCURRENCE'),
        `${file.path} does not say another occurrence holds its bytes`,
      );
      const decision = evidence.find((item) => item.kind === 'OCCURRENCE_DECISION');
      assert.ok(decision !== undefined && decision.detail.includes('INDEPENDENT'), `${file.path} does not record the decision`);
    }

    // EXCLUDE_ONE: the first file listed is kept. Every row of the other is
    // rejected input, by name, with a reason that says which occurrence kept it.
    const excluded = migrate('exclude-one', [{ files: ['a', 'b'], decision: 'EXCLUDE_ONE' }]);
    assert.equal(excluded.reconciliation.sourceRows.total, 4, 'the excluded rows are still counted');
    assert.equal(excluded.reconciliation.sourceRows.byDisposition.REJECTED_INPUT, 2);
    assert.equal(excluded.reconciliation.sourceRows.byDisposition.OUTPUT, 2);
    assert.equal(excluded.reconciliation.sourceRows.withoutDisposition, 0);
    const byFile = (path: string) => collect(excluded.truth.lineage).filter((entry) => entry.address.filePath === path);
    assert.ok(byFile('a.csv').every((entry) => entry.disposition === 'OUTPUT'));
    const rejected = byFile('b.csv');
    assert.equal(rejected.length, 2);
    for (const entry of rejected) {
      assert.equal(entry.disposition, 'REJECTED_INPUT');
      assert.equal(entry.reasonCode, 'INGEST_OCCURRENCE_EXCLUDED');
      assert.ok(
        entry.detail.includes('a.csv') && entry.detail.includes('b.csv'),
        `the detail must name both occurrences: ${entry.detail}`,
      );
    }
    const flagged = excluded.truth.sourceFiles.find((file) => file.path === 'b.csv');
    const decision = flagged?.sheets.flatMap((sheetEntry) => sheetEntry.evidence).find((item) => item.kind === 'OCCURRENCE_DECISION');
    assert.ok(decision !== undefined && decision.detail.includes('EXCLUDE_ONE'));
  });

  it('[R2-001] without a declaration, equal bytes in one namespace stop the run and name both occurrences', () => {
    const input = inputWithTwoEqualFiles('undeclared');
    const loaded = loadConfig(occurrencePlan(undefined), 'occurrence:undeclared');
    expectFailure('INPUT_DUPLICATE_FILE', 'a.csv', () => ingestBundle({ inputRoot: input, config: loaded.config }));
    expectFailure('INPUT_DUPLICATE_FILE', 'b.csv', () => ingestBundle({ inputRoot: input, config: loaded.config }));
  });

  it('[R2-001] a decision about files whose bytes differ, or about a file the plan does not list, is refused', () => {
    const input = inputWithTwoEqualFiles('bad-declaration');
    writeFileSync(join(input, 'b.csv'), 'Contact ID,First Name\n1,Ada\n');
    const differing = loadConfig(occurrencePlan([{ files: ['a', 'b'], decision: 'EXCLUDE_ONE' }]), 'occurrence:differ');
    expectFailure('CONFIG_INVALID', 'different bytes', () => ingestBundle({ inputRoot: input, config: differing.config }));
    assert.throws(
      () => loadConfig(occurrencePlan([{ files: ['a', 'nope'], decision: 'INDEPENDENT' }]), 'occurrence:unknown'),
      (error: unknown) => isMigrationError(error) && error.code === 'MAPPING_INVALID' && error.message.includes('nope'),
    );
  });
});

/**
 * ZIP member names are part names (R2-011, B01-R5).
 *
 * The same worksheet can be spelled more than one way, and a reader that
 * compares the spellings byte for byte sees two different parts where every
 * other program sees one. The names are refused when they are not canonical,
 * and compared as OPC part identities when they are.
 */
describe('workbook: archive member names are canonical part names', () => {
  const g18 = (): Uint8Array =>
    new Uint8Array(readFileSync(join(GOLDEN_ROOT, 'G18-xlsx-formulas', 'input', 'contacts.xlsx')));

  const members = (): Record<string, [Uint8Array, { mtime: number }]> =>
    Object.fromEntries(Object.entries(unzipSync(g18())).map(([name, data]): [string, [Uint8Array, { mtime: number }]] => [name, [data, { mtime: MTIME }]]));

  const withAlias = (alias: string): Uint8Array => {
    // The alias holds a different, empty worksheet: whichever spelling a reader
    // prefers decides which rows the migration sees.
    const all = members();
    all[alias] = [strToU8(sheet('')), { mtime: MTIME }];
    return zipSync(all, { level: 0 });
  };

  const NON_CANONICAL: readonly string[] = [
    'xl/worksheets/./sheet1.xml',
    'xl\\worksheets\\sheet1.xml',
    '/xl/worksheets/sheet1.xml',
    'xl/worksheets/../worksheets/sheet1.xml',
    'xl//worksheets/sheet1.xml',
    'C:/xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet\u00011.xml',
    'xl/worksheets/%2e/sheet1.xml',
    'xl/worksheets%5csheet1.xml',
  ];
  const ONE_PART: readonly string[] = ['XL/Worksheets/Sheet1.xml', 'xl/worksheets/sheet%31.xml'];

  it('[R2-011] refuses a worksheet alias spelled with /./, a backslash, a leading slash, .. or other case, before expanding any member', () => {
    for (const alias of NON_CANONICAL) {
      expectFailure('INPUT_CORRUPT', 'non-canonical', () => readWorkbook(withAlias(alias), DEFAULT_LIMITS, 'x.xlsx'));
    }
    for (const alias of ONE_PART) {
      expectFailure('INPUT_CORRUPT', 'one part', () => readWorkbook(withAlias(alias), DEFAULT_LIMITS, 'x.xlsx'));
    }
  });

  it('[R2-011] the unaltered G18 workbook is still read', () => {
    const read = readWorkbook(g18(), DEFAULT_LIMITS, 'x.xlsx');
    assert.equal(read.sheets.length, 1);
    assert.equal(read.sheets[0]?.rows.length, 3);
    assert.equal(read.hasFormulas, true);
  });

  it('[R2-011] refuses a member whose local header names another part than the directory does, even one no relationship reads', () => {
    const all = members();
    all['docs/aaaa.txt'] = [strToU8('x'), { mtime: MTIME }];
    const bytes = zipSync(all, { level: 0 });
    const name = strToU8('docs/aaaa.txt');
    const at: number[] = [];
    for (let index = 0; index + name.length <= bytes.length; index += 1) {
      if (name.every((byte, offset) => bytes[index + offset] === byte)) at.push(index);
    }
    assert.equal(at.length, 2, 'the name is in the local header and in the directory');
    bytes.set(strToU8('docs/bbbb.txt'), at[1] as number);
    expectFailure('INPUT_CORRUPT', 'docs/bbbb.txt', () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'));
  });

  it('[R2-011] refuses a member name that is not UTF-8', () => {
    const all = members();
    all['docs/ab.txt'] = [strToU8('x'), { mtime: MTIME }];
    const bytes = zipSync(all, { level: 0 });
    const name = strToU8('docs/ab.txt');
    for (let index = 0; index + name.length <= bytes.length; index += 1) {
      if (name.every((byte, offset) => bytes[index + offset] === byte)) bytes[index + 6] = 0xe9;
    }
    expectFailure('INPUT_CORRUPT', 'UTF-8', () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'));
  });
});
