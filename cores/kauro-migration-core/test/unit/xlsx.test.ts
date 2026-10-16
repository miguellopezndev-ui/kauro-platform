import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { zipSync, strToU8, unzipSync } from 'fflate';
import {
  columnIndexFromReference,
  looksLikeDateFormat,
  openWorkbookBytes,
  readWorkbook,
} from '../../src/ingest/xlsx-reader.js';
import { decodeEntities, localName, parseXml } from '../../src/ingest/xml-pull-parser.js';
import { DEFAULT_LIMITS } from '../../src/domain/config.js';
import { isMigrationError } from '../../src/domain/errors.js';

const MTIME = 1_577_836_800_000;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

function workbook(sheetXml: string, extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, [Uint8Array, { mtime: number }]> = {
    '[Content_Types].xml': [strToU8(CONTENT_TYPES), { mtime: MTIME }],
    '_rels/.rels': [strToU8(ROOT_RELS), { mtime: MTIME }],
    'xl/workbook.xml': [
      strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      { mtime: MTIME },
    ],
    'xl/_rels/workbook.xml.rels': [strToU8(WORKBOOK_RELS), { mtime: MTIME }],
    'xl/styles.xml': [strToU8(STYLES), { mtime: MTIME }],
    'xl/worksheets/sheet1.xml': [strToU8(sheetXml), { mtime: MTIME }],
  };
  for (const [name, text] of Object.entries(extra)) files[name] = [strToU8(text), { mtime: MTIME }];
  return zipSync(files, { level: 0 });
}

const sheet = (rows: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

describe('XML pull parser', () => {
  it('reads elements, attributes and text', () => {
    const events = [...parseXml('<a x="1"><b>text</b></a>', 'x')];
    assert.equal(events[0]?.kind, 'start');
    assert.equal(events[0]?.kind === 'start' ? events[0].attributes['x'] : null, '1');
    assert.equal(events[2]?.kind === 'text' ? events[2].text : null, 'text');
  });

  it('strips namespace prefixes only where asked', () => {
    assert.equal(localName('r:id'), 'id');
    assert.equal(localName('id'), 'id');
  });

  it('decodes the five predefined entities and numeric references', () => {
    assert.equal(decodeEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f&#65;&#x42;', 'x'), 'a&b<c>d"e\'fAB');
  });

  it('refuses a document type declaration outright', () => {
    assert.throws(
      () => [...parseXml('<!DOCTYPE a><a/>', 'x')],
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_UNSUPPORTED',
    );
  });

  it('refuses an entity it was never given a definition for', () => {
    assert.throws(
      () => decodeEntities('&lol;', 'x'),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_UNSUPPORTED',
    );
  });

  it('fails on a tag that is never closed', () => {
    assert.throws(
      () => [...parseXml('<a x="1"', 'x')],
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });
});

describe('workbook reading', () => {
  it('keeps formula text and marks the cached value', () => {
    const bytes = workbook(
      sheet('<row r="1"><c r="A1" t="str"><f>SUM(B1:C1)</f><v>7</v></c></row>'),
    );
    const read = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx');
    const cell = read.sheets[0]?.rows[0]?.cells[0];
    assert.equal(cell?.formula, 'SUM(B1:C1)');
    assert.equal(cell?.raw, '7');
    assert.equal(read.hasFormulas, true);
  });

  it('[S025] a formula cell without a cached value reads as cache-absent, distinct from a cached empty string', () => {
    // A1 has a formula and no <v> at all: the workbook was never calculated.
    // B1 has a formula and an explicitly empty cached result (<v></v>).
    // C1 is the same with a self-closing <v/>. D1 has a cached value, E1 no formula.
    const bytes = workbook(
      sheet(
        '<row r="1">' +
          '<c r="A1"><f>1+1</f></c>' +
          '<c r="B1" t="str"><f>A1&amp;""</f><v></v></c>' +
          '<c r="C1" t="str"><f>A1&amp;""</f><v/></c>' +
          '<c r="D1" t="str"><f>"x"</f><v>x</v></c>' +
          '<c r="E1" t="inlineStr"><is><t>plain</t></is></c>' +
          '</row>',
      ),
    );
    const cells = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx').sheets[0]?.rows[0]?.cells ?? [];
    const byColumn = (index: number) => cells.find((cell) => cell.columnIndex === index);
    assert.equal(byColumn(0)?.formula, '1+1');
    assert.equal(byColumn(0)?.raw, null);
    assert.equal(byColumn(0)?.cachedValue, 'ABSENT');
    assert.equal(byColumn(1)?.raw, '');
    assert.equal(byColumn(1)?.cachedValue, 'PRESENT');
    assert.equal(byColumn(2)?.raw, '');
    assert.equal(byColumn(2)?.cachedValue, 'PRESENT');
    assert.equal(byColumn(3)?.raw, 'x');
    assert.equal(byColumn(3)?.cachedValue, 'PRESENT');
    assert.equal(byColumn(4)?.formula, null);
    assert.equal(byColumn(4)?.cachedValue, null);
  });

  it('reads a number format so a date serial carries its own evidence', () => {
    const bytes = workbook(sheet('<row r="1"><c r="A1" s="1"><v>45001</v></c></row>'));
    const read = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx');
    const cell = read.sheets[0]?.rows[0]?.cells[0];
    assert.equal(cell?.raw, '45001');
    assert.equal(cell?.numberFormat, 'builtin:14');
  });

  it('records the workbook date system', () => {
    assert.equal(readWorkbook(workbook(sheet('<row r="1"/>')), DEFAULT_LIMITS, 'x').dateSystem, 'DATE_1900');
  });

  it('refuses an OLE compound file', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    assert.throws(
      () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_UNSUPPORTED',
    );
  });

  it('refuses a macro project', () => {
    const bytes = workbook(sheet('<row r="1"/>'), { 'xl/vbaProject.bin': 'macro' });
    assert.throws(
      () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_UNSUPPORTED',
    );
  });

  it('refuses an archive that would expand beyond the configured limit', () => {
    const bytes = workbook(sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(2000)}</t></is></c></row>`));
    assert.throws(
      () => readWorkbook(bytes, { ...DEFAULT_LIMITS, maxWorkbookUncompressedBytes: 500 }, 'x.xlsx'),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'INPUT_LIMIT_EXCEEDED' &&
        error.details['limit'] === 'maxWorkbookUncompressedBytes',
    );
  });

  it('refuses something that is not a ZIP archive at all', () => {
    assert.throws(
      () => readWorkbook(Buffer.from('plain text file'), DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });

  it('translates column references', () => {
    assert.equal(columnIndexFromReference('A1', 'x'), 0);
    assert.equal(columnIndexFromReference('Z9', 'x'), 25);
    assert.equal(columnIndexFromReference('AA1', 'x'), 26);
    assert.equal(columnIndexFromReference('AB12', 'x'), 27);
  });

  it('tells a date number format from a currency one', () => {
    assert.equal(looksLikeDateFormat('yyyy-mm-dd'), true);
    assert.equal(looksLikeDateFormat('dd/mm/yyyy hh:mm'), true);
    assert.equal(looksLikeDateFormat('#,##0.00'), false);
    assert.equal(looksLikeDateFormat('[$$-409]#,##0.00'), false);
    assert.equal(looksLikeDateFormat('0.00"days"'), false);
  });
});

/**
 * The shared-string table, which had no test that read one successfully.
 *
 * Every existing case pointed a `t="s"` cell at a workbook with no shared
 * strings, so what was pinned was the refusal and never the value. That matters
 * more now that the table is no longer a `string[]`: it is a few long strings
 * and an index into them, and an off-by-one in that index would hand a cell its
 * neighbour's text -- a wrong value that the row count, the row hash and every
 * check downstream would agree with.
 */
describe('shared strings', () => {
  const sharedStrings = (items: readonly string[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(items.length)}" uniqueCount="${String(items.length)}">${items.join('')}</sst>`;

  const cells = (indexes: readonly number[]): string =>
    `<row r="1">${indexes
      .map((value, column) => `<c r="${String.fromCharCode(65 + column)}1" t="s"><v>${String(value)}</v></c>`)
      .join('')}</row>`;

  it('reads plain, rich-text, empty and phonetic-bearing entries as the workbook wrote them', () => {
    const bytes = workbook(sheet(cells([0, 1, 2, 3, 4])), {
      'xl/sharedStrings.xml': sharedStrings([
        '<si><t>Ada</t></si>',
        // Rich text: the runs are one value, joined in document order.
        '<si><r><t>Grace </t></r><r><t>Hopper</t></r></si>',
        '<si/>',
        // The phonetic hint is not part of the value and never was.
        '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>',
        '<si><t xml:space="preserve"> a &amp; b </t></si>',
      ]),
    });
    const read = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx');
    assert.deepEqual(
      read.sheets[0]?.rows[0]?.cells.map((cell) => cell.raw),
      ['Ada', 'Grace Hopper', '', '東京', ' a & b '],
    );
    assert.deepEqual(
      read.sheets[0]?.rows[0]?.cells.map((cell) => cell.kind),
      ['XLSX_SHARED_STRING', 'XLSX_SHARED_STRING', 'XLSX_SHARED_STRING', 'XLSX_SHARED_STRING', 'XLSX_SHARED_STRING'],
    );
  });

  it('reads entries either side of an internal segment boundary', () => {
    // The table keeps its text as a handful of long strings rather than one
    // string per entry, so there is a boundary inside it that no caller can see
    // and no ordinary workbook would land on. This one lands on it on purpose:
    // more text than one segment holds, with entry lengths that differ so the
    // boundary falls inside the run rather than neatly between two blocks.
    const items: string[] = [];
    const expected: string[] = [];
    for (let index = 0; index < 1_400; index += 1) {
      const value = `${String(index)}:${'v'.repeat(1_000 + (index % 7))}`;
      expected.push(value);
      items.push(`<si><t>${value}</t></si>`);
    }
    const probes = [0, 1, 1_040, 1_041, 1_042, 1_043, 1_044, 1_045, 1_046, 1_047, 1_048, 1_398, 1_399];
    const bytes = workbook(sheet(cells(probes)), { 'xl/sharedStrings.xml': sharedStrings(items) });
    const read = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx');
    assert.deepEqual(
      read.sheets[0]?.rows[0]?.cells.map((cell) => cell.raw),
      probes.map((index) => expected[index]),
    );
  });

  it('refuses an index one past the end rather than reading the entry before it', () => {
    const bytes = workbook(sheet(cells([2])), {
      'xl/sharedStrings.xml': sharedStrings(['<si><t>a</t></si>', '<si><t>b</t></si>']),
    });
    assert.throws(
      () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });
});

/**
 * The open workbook, which is what ingest reads through.
 *
 * `readWorkbook` collects what this hands out, so the two agreeing is the whole
 * of the claim that nothing changed when the rows stopped being materialised.
 */
describe('an open workbook hands out rows without holding them', () => {
  const threeSheets = (): Uint8Array => {
    const parts: Record<string, [Uint8Array, { mtime: number }]> = {
      '[Content_Types].xml': [strToU8(CONTENT_TYPES), { mtime: MTIME }],
      '_rels/.rels': [strToU8(ROOT_RELS), { mtime: MTIME }],
      'xl/workbook.xml': [
        strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Hid" sheetId="2" r:id="rId2" state="hidden"/><sheet name="Two" sheetId="3" r:id="rId3"/></sheets></workbook>',
        ),
        { mtime: MTIME },
      ],
      'xl/_rels/workbook.xml.rels': [
        strToU8(
          '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
            '</Relationships>',
        ),
        { mtime: MTIME },
      ],
      'xl/styles.xml': [strToU8(STYLES), { mtime: MTIME }],
      'xl/worksheets/sheet1.xml': [
        strToU8(
          sheet(
            '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row>',
          ),
        ),
        { mtime: MTIME },
      ],
      'xl/worksheets/sheet2.xml': [
        strToU8(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>')),
        { mtime: MTIME },
      ],
      'xl/worksheets/sheet3.xml': [strToU8(sheet('')), { mtime: MTIME }],
    };
    return zipSync(parts, { level: 0 });
  };

  it('agrees with the collected reader, sheet for sheet and row for row', () => {
    const bytes = threeSheets();
    const collected = readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx');
    const open = openWorkbookBytes(bytes, DEFAULT_LIMITS, 'x.xlsx');
    assert.deepEqual(
      open.sheets.map((shape) => [shape.name, shape.index, shape.hidden]),
      collected.sheets.map((each) => [each.name, each.index, each.hidden]),
    );
    assert.equal(open.dateSystem, collected.dateSystem);
    assert.equal(open.hasExternalLinks, collected.hasExternalLinks);
    for (const shape of open.sheets) {
      assert.deepEqual([...open.rows(shape.index)], collected.sheets[shape.index]?.rows);
    }
  });

  it('gives the same rows every time a sheet is walked', () => {
    // Relationships need the owning rows and then the rows they point at, so a
    // sheet is walked more than once in one run. A walk that consumed the sheet
    // would hand the second pass nothing, and the row equation would be the only
    // thing that noticed.
    const open = openWorkbookBytes(threeSheets(), DEFAULT_LIMITS, 'x.xlsx');
    assert.deepEqual([...open.rows(0)], [...open.rows(0)]);
    assert.equal([...open.rows(0)].length, 2);
  });

  it('refuses a sheet index it never declared instead of returning nothing', () => {
    const open = openWorkbookBytes(threeSheets(), DEFAULT_LIMITS, 'x.xlsx');
    assert.throws(
      () => [...open.rows(3)],
      (error: unknown) => isMigrationError(error) && error.code === 'INPUT_CORRUPT',
    );
  });
});

/**
 * A workbook that is actually compressed.
 *
 * Every .xlsx fixture in this repository is stored rather than deflated, which
 * no real export is: Excel, LibreOffice and Sheets all deflate. So while the
 * reader handed whole parts to `unzipSync` that gap cost nothing, and the moment
 * it started streaming them through an inflate stream it became the untested
 * half of the common case. A deflate stream also hands its output back in
 * pieces the archive chose rather than pieces the reader asked for, so it
 * exercises the block boundaries differently from a stored member.
 *
 * The two are compared against each other rather than against a literal, so the
 * claim is the one that matters: compressing a workbook does not change a single
 * value the reader gets out of it.
 */
describe('a deflated workbook reads exactly as the same workbook stored', () => {
  const many = (): string => {
    const rows: string[] = [];
    for (let index = 0; index < 4_000; index += 1) {
      rows.push(
        `<row r="${String(index + 1)}"><c r="A${String(index + 1)}" t="inlineStr"><is>` +
          `<t xml:space="preserve">row ${String(index)} é€ ${'p'.repeat(index % 97)}</t>` +
          '</is></c></row>',
      );
    }
    return sheet(rows.join(''));
  };

  const compressed = (level: 0 | 6): Uint8Array => {
    const parts: Record<string, [Uint8Array, { mtime: number; level: 0 | 6 }]> = {
      '[Content_Types].xml': [strToU8(CONTENT_TYPES), { mtime: MTIME, level }],
      '_rels/.rels': [strToU8(ROOT_RELS), { mtime: MTIME, level }],
      'xl/workbook.xml': [
        strToU8(
          `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        ),
        { mtime: MTIME, level },
      ],
      'xl/_rels/workbook.xml.rels': [strToU8(WORKBOOK_RELS), { mtime: MTIME, level }],
      'xl/styles.xml': [strToU8(STYLES), { mtime: MTIME, level }],
      'xl/worksheets/sheet1.xml': [strToU8(many()), { mtime: MTIME, level }],
    };
    return zipSync(parts, { mtime: MTIME });
  };

  it('gives the same rows, and the compression really happened', () => {
    const stored = compressed(0);
    const deflated = compressed(6);
    // Without this the test could pass on two identical archives and prove
    // nothing about the inflate path it exists to cover.
    assert.ok(deflated.length * 4 < stored.length, 'the deflated archive has to be substantially smaller');

    const fromStored = readWorkbook(stored, DEFAULT_LIMITS, 'x.xlsx');
    const fromDeflated = readWorkbook(deflated, DEFAULT_LIMITS, 'x.xlsx');
    assert.equal(fromDeflated.sheets[0]?.rows.length, 4_000);
    assert.deepEqual(fromDeflated.sheets, fromStored.sheets);
  });
});

/**
 * The archive that says one thing in its directory and another in its bytes.
 *
 * A ZIP states what it holds twice, and the format makes the central directory
 * at the end the authoritative account. A reader that takes its directory from
 * the end and its data from the first local header with a matching name will,
 * on an archive where the two disagree, quietly read the copy nobody named.
 *
 * This is not a theoretical shape. It is what appending an in-place update to a
 * ZIP produces, and an adversarial reading of the streaming reader built it and
 * made two rows disappear from a migration that then reported itself complete:
 * the row census agreed, because it was fed the same shadowed blocks; the
 * reconciliation equation held; `verifyPackage` passed. Every test in this file
 * passed too, which is why this one exists.
 */
describe('a shadowed archive member', () => {
  const u16at = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u32at = (bytes: Uint8Array, at: number): number =>
    ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) + (bytes[at + 3] ?? 0) * 0x100_00_00;
  const putU32 = (bytes: Uint8Array, at: number, value: number): void => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = (value / 0x100_00_00) & 0xff;
  };

  /** Everything the central directory says, in the order it says it. */
  function directoryOf(bytes: Uint8Array): { eocd: number; at: number; entries: { at: number; name: string; offset: number }[] } {
    let eocd = -1;
    for (let at = bytes.length - 22; at >= 0; at -= 1) {
      if (u32at(bytes, at) === 0x0605_4b50) { eocd = at; break; }
    }
    assert.notEqual(eocd, -1, 'the fixture archive has an end-of-central-directory record');
    const count = u16at(bytes, eocd + 10);
    const start = u32at(bytes, eocd + 16);
    const entries = [];
    let at = start;
    for (let index = 0; index < count; index += 1) {
      const nameLength = u16at(bytes, at + 28);
      const extraLength = u16at(bytes, at + 30);
      const commentLength = u16at(bytes, at + 32);
      entries.push({
        at,
        name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
        offset: u32at(bytes, at + 42),
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return { eocd, at: start, entries };
  }

  /**
   * `[the stale copy of one member][the whole current archive, its directory
   * offsets moved along by that much]`.
   *
   * Both archives are written with `level: 0`, so every member is stored and no
   * member carries a data descriptor: the surgery is a splice and an addition,
   * with nothing to recompute.
   */
  function shadowed(current: Uint8Array, stale: Uint8Array, member: string): Uint8Array {
    const staleDirectory = directoryOf(stale);
    const staleEntry = staleDirectory.entries.find((entry) => entry.name === member);
    assert.ok(staleEntry !== undefined, `the stale archive holds ${member}`);
    // From its local header to the start of the next thing in the file, which
    // for a stored member is the next local header or the directory.
    const nextOffsets = staleDirectory.entries
      .map((entry) => entry.offset)
      .filter((offset) => offset > staleEntry.offset);
    const staleEnd = nextOffsets.length > 0 ? Math.min(...nextOffsets) : staleDirectory.at;
    const record = stale.subarray(staleEntry.offset, staleEnd);

    const out = new Uint8Array(record.length + current.length);
    out.set(record, 0);
    out.set(current, record.length);

    // Every entry in the current directory, and the directory itself, now sits
    // that much further into the file.
    const moved = directoryOf(out.subarray(record.length));
    for (const entry of moved.entries) {
      putU32(out, record.length + entry.at + 42, entry.offset + record.length);
    }
    putU32(out, record.length + moved.eocd + 16, moved.at + record.length);
    return out;
  }

  it('reads the member the central directory names, not the first one in the file', () => {
    const current = workbook(
      sheet(
        '<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>one</t></is></c></row>' +
          '<row r="3"><c r="A3" t="inlineStr"><is><t>two</t></is></c></row>',
      ),
    );
    const stale = workbook(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>'));
    const attacked = shadowed(current, stale, 'xl/worksheets/sheet1.xml');

    // The shadow really is in the file, ahead of the copy the directory names.
    assert.ok(attacked.length > current.length, 'the attacked container carries both copies');

    const read = readWorkbook(attacked, DEFAULT_LIMITS, 'x.xlsx');
    assert.equal(read.sheets[0]?.rows.length, 3, 'the rows of the copy the directory names');
    assert.deepEqual(
      read.sheets[0]?.rows.map((row) => row.cells[0]?.raw),
      ['h', 'one', 'two'],
      'not the two rows the shadow would have dropped',
    );
  });

  it('refuses an archive whose local header names a different member than the directory placed there', () => {
    const current = workbook(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>h</t></is></c></row>'));
    const directory = directoryOf(current);
    const entry = directory.entries.find((row) => row.name === 'xl/worksheets/sheet1.xml');
    assert.ok(entry !== undefined);
    const attacked = current.slice();
    // Point the directory at another member's local header. The two accounts of
    // where this part lives now disagree, and a reader that resolved it in
    // favour of either would be choosing which archive to believe.
    const other = directory.entries.find((row) => row.name === '[Content_Types].xml');
    assert.ok(other !== undefined);
    putU32(attacked, entry.at + 42, other.offset);

    assert.throws(
      () => readWorkbook(attacked, DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'INPUT_CORRUPT' &&
        error.message.includes('at the offset the directory gives for it'),
    );
  });
});

/**
 * The envelope of a workbook is conjunctive (R2-014, B02-R1).
 *
 * A file is admitted only if the file is within its limit, **and** every part
 * is within the part limit, **and** the parts together are within the workbook
 * limit. The old gate summed the parts and compared the sum, so one part could
 * be as large as the whole allowance and still pass.
 */
describe('the workbook envelope is file, part and total together', () => {
  const PART = 'xl/worksheets/sheet1.xml';
  const limits = (extra: Record<string, number>) => ({ ...DEFAULT_LIMITS, ...extra });

  /** A workbook whose one large part is highly compressible, so the file stays small. */
  function deflatedWorkbook(rowCount: number): Uint8Array {
    const rows = Array.from(
      { length: rowCount },
      (_, index) => `<row r="${String(index + 1)}"><c r="A${String(index + 1)}" t="inlineStr"><is><t>${'x'.repeat(40)}</t></is></c></row>`,
    ).join('');
    const stored = workbook(sheet(rows));
    return zipSync(
      Object.fromEntries(Object.entries(unzipSync(stored)).map(([name, data]) => [name, [data, { mtime: MTIME, level: 6 }] as const])),
    );
  }
  const partSize = (bytes: Uint8Array): number => (unzipSync(bytes)[PART] as Uint8Array).length;

  it('[R2-014] refuses a worksheet above the per-part limit although the file and the workbook total are within theirs, naming the part and the CSV or split alternative', () => {
    const bytes = deflatedWorkbook(4_000);
    const size = partSize(bytes);
    assert.ok(bytes.length * 5 < size, 'the compressed file is a fraction of the part');
    assert.ok(size > 200_000);
    const conjunctive = limits({
      maxBytesPerFile: bytes.length + 1,
      maxWorkbookUncompressedBytes: size * 2,
      maxWorkbookPartUncompressedBytes: size - 1,
    });
    assert.throws(
      () => readWorkbook(bytes, conjunctive, 'x.xlsx'),
      (error: unknown) => {
        assert.ok(isMigrationError(error));
        assert.equal(error.code, 'INPUT_LIMIT_EXCEEDED');
        assert.equal(error.details['limit'], 'maxWorkbookPartUncompressedBytes');
        assert.equal(error.details['part'], PART);
        assert.equal(error.details['allowed'], size - 1);
        assert.equal(error.details['actual'], size);
        const said = `${error.message} ${error.remedy}`;
        assert.ok(said.includes(PART), 'the denial names the part');
        assert.ok(said.includes('CSV'), 'the remedy offers a CSV export');
        assert.ok(said.toLowerCase().includes('split'), 'the remedy offers splitting the workbook');
        return true;
      },
    );
  });

  it('[R2-014] admits the same part one byte under the per-part limit', () => {
    const bytes = deflatedWorkbook(4_000);
    const size = partSize(bytes);
    const read = readWorkbook(
      bytes,
      limits({ maxWorkbookUncompressedBytes: size * 2, maxWorkbookPartUncompressedBytes: size + 1 }),
      'x.xlsx',
    );
    assert.equal(read.sheets[0]?.rows.length, 4_000);
    const exact = readWorkbook(
      bytes,
      limits({ maxWorkbookUncompressedBytes: size * 2, maxWorkbookPartUncompressedBytes: size }),
      'x.xlsx',
    );
    assert.equal(exact.sheets[0]?.rows.length, 4_000, 'a part exactly at the limit is within it');
  });

  it('[R2-014] refuses a member whose inflated bytes exceed its declared size', () => {
    const bytes = deflatedWorkbook(4_000).slice();
    // Declare 1,000 bytes in the directory for a part that inflates to several hundred thousand.
    const signature = [0x50, 0x4b, 0x01, 0x02];
    const name = strToU8(PART);
    let entry = -1;
    for (let at = 0; at + 46 + name.length <= bytes.length && entry === -1; at += 1) {
      if (!signature.every((byte, offset) => bytes[at + offset] === byte)) continue;
      if (name.every((byte, offset) => bytes[at + 46 + offset] === byte)) entry = at;
    }
    assert.notEqual(entry, -1, 'the directory entry of the worksheet was found');
    const declared = 1_000;
    bytes[entry + 24] = declared & 0xff;
    bytes[entry + 25] = (declared >>> 8) & 0xff;
    bytes[entry + 26] = 0;
    bytes[entry + 27] = 0;
    assert.throws(
      () => readWorkbook(bytes, DEFAULT_LIMITS, 'x.xlsx'),
      (error: unknown) =>
        isMigrationError(error) &&
        error.code === 'INPUT_CORRUPT' &&
        error.message.includes(PART) &&
        error.message.includes('declares 1000 bytes and delivers more'),
    );
  });
});
