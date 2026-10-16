import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { GOLDEN_ROOT, caseScratch, collect, runFixture, scratchDir } from '../support/harness.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { readCsv } from '../../src/ingest/csv-reader.js';
import { renderCsv } from '../../src/artifacts/csv-writer.js';
import type { RunResult } from '../../src/run/run-migration.js';

/**
 * Metamorphic relations.
 *
 * Each of these reshapes the input in a way the contract says must not change
 * the delivered truth, then checks that it did not. They catch the class of
 * defect where a result happens to be right for one arrangement of the same
 * data and wrong for another.
 */

const MTIME = 1_577_836_800_000;

function deliveredSummary(result: RunResult): string[] {
  return collect(result.truth.deliveredRecords)
    .map((record) => `${record.object}|${String(record.sourceRecordId)}|${JSON.stringify(record.values)}`)
    .sort();
}

function runWith(inputDir: string, configPath: string): RunResult {
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  return runMigration({
      scratch: caseScratch('metamorphic1'), inputRoot: inputDir, config: loaded.config, configHash: loaded.configHash });
}

function rewriteCsv(
  caseId: string,
  name: string,
  fileName: string,
  transform: (rows: string[][]) => string[][],
): { inputDir: string; configPath: string } {
  const source = join(GOLDEN_ROOT, caseId, 'input', fileName);
  const parsed = readCsv(readFileSync(source, 'utf8'), {
    delimiter: ',',
    filePath: fileName,
    maxCellLength: 100_000,
    maxColumns: 500,
    maxRows: 100_000,
  });
  const rows = parsed.records.map((record) => [...record.fields]);
  const header = rows[0] as string[];
  const transformed = transform(rows.slice(1));

  const root = scratchDir('metamorphic', name);
  const inputDir = join(root, 'input');
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, fileName), Buffer.from(renderCsv(header, transformed), 'utf8'));
  return { inputDir, configPath: join(GOLDEN_ROOT, caseId, 'config.json') };
}

describe('M1 row order', () => {
  it('reversing the rows delivers the same records', () => {
    const base = runFixture(GOLDEN_ROOT, 'G01-clean-contacts', { scratchName: 'm1-base' });
    const reversed = rewriteCsv('G01-clean-contacts', 'm1', 'contacts.csv', (rows) => [...rows].reverse());
    const other = runWith(reversed.inputDir, reversed.configPath);

    assert.deepEqual(deliveredSummary(other), deliveredSummary(base.result));
    assert.equal(other.reconciliation.sourceRows.total, base.result.reconciliation.sourceRows.total);
    assert.equal(other.reconciliation.cells.changed, base.result.reconciliation.cells.changed);
  });
});

describe('M2 whitespace is a value', () => {
  // The old relation, "padding every value with spaces delivers the same
  // records", asserted that the engine trims by default. It was wrong (R2-002,
  // D67): whitespace is part of the value until a field approves trimming. The
  // relation is now stated the other way round, from the input bytes.
  it('[R2-002] padding every value delivers the padded values unless a field approves trimming', () => {
    const pad = (value: string): string => (value === '' ? value : `  ${value}  `);
    const padded = rewriteCsv('G01-clean-contacts', 'm2', 'contacts.csv', (rows) => rows.map((row) => row.map(pad)));
    const other = runWith(padded.inputDir, padded.configPath);

    // The unpadded truth, read from the golden input file itself.
    const source = readCsv(readFileSync(join(GOLDEN_ROOT, 'G01-clean-contacts', 'input', 'contacts.csv'), 'utf8'), {
      delimiter: ',',
      filePath: 'contacts.csv',
      maxCellLength: 100_000,
      maxColumns: 500,
      maxRows: 100_000,
    }).records.slice(1);
    assert.equal(source.length, 6);

    const delivered = collect(other.truth.deliveredRecords);
    assert.equal(delivered.length, 6);
    for (const record of source) {
      const [id, first, last, email, phone] = record.fields as [string, string, string, string, string];
      const found = delivered.find((item) => item.sourceRecordId === pad(id));
      assert.ok(found !== undefined, `the padded id ${JSON.stringify(pad(id))} is its own identity`);
      assert.equal(found.values['contact.firstName'], pad(first));
      assert.equal(found.values['contact.lastName'], pad(last));
      // A padded address is not an address: it is preserved, not repaired.
      assert.equal(found.values['contact.email'], pad(email));
      // A phone is rewritten to E.164, which the source already was.
      assert.equal(found.values['contact.phone'], phone);
    }
    assert.equal(
      collect(other.truth.changes).some((change) => change.reasonCode === 'TRANSFORM_WHITESPACE_TRIMMED'),
      false,
      'no field approved trimming, so nothing may claim to have trimmed',
    );

    // Approving the trim on one field changes that field and no other.
    const approved = scratchDir('metamorphic', 'm2-approved');
    const config = JSON.parse(readFileSync(padded.configPath, 'utf8')) as {
      records: { fields: { column: { header: string }; options?: { trim: boolean } }[] }[];
    };
    const firstNameField = config.records[0]?.fields.find((item) => item.column.header === 'First Name');
    assert.ok(firstNameField !== undefined);
    firstNameField.options = { trim: true };
    const configPath = join(approved, 'config.json');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const trimmed = runWith(padded.inputDir, configPath);
    const changes = collect(trimmed.truth.changes).filter((change) => change.reasonCode === 'TRANSFORM_WHITESPACE_TRIMMED');
    assert.equal(changes.length, 6, 'one recorded trim per row, all of them on the approving field');
    for (const change of changes) assert.equal(change.destinationField, 'contact.firstName');
    for (const record of source) {
      const found = collect(trimmed.truth.deliveredRecords).find((item) => item.sourceRecordId === pad(record.fields[0] as string));
      assert.equal(found?.values['contact.firstName'], record.fields[1]);
      assert.equal(found?.values['contact.lastName'], pad(record.fields[2] as string));
    }
  });
});

describe('M3 email domain case', () => {
  it('uppercasing only the domain delivers the same address', () => {
    const base = runFixture(GOLDEN_ROOT, 'G01-clean-contacts', { scratchName: 'm3-base' });
    const shouted = rewriteCsv('G01-clean-contacts', 'm3', 'contacts.csv', (rows) =>
      rows.map((row) => {
        const email = row[3] ?? '';
        const at = email.indexOf('@');
        const rewritten = at === -1 ? email : `${email.slice(0, at)}@${email.slice(at + 1).toUpperCase()}`;
        return [row[0] ?? '', row[1] ?? '', row[2] ?? '', rewritten, row[4] ?? ''];
      }),
    );
    const other = runWith(shouted.inputDir, shouted.configPath);
    assert.deepEqual(deliveredSummary(other), deliveredSummary(base.result));
  });

  it('changing the local part case delivers a different address, because it is significant', () => {
    const shouted = rewriteCsv('G01-clean-contacts', 'm3-local', 'contacts.csv', (rows) =>
      rows.map((row) => {
        const email = row[3] ?? '';
        const at = email.indexOf('@');
        const rewritten = at === -1 ? email : `${email.slice(0, at).toUpperCase()}@${email.slice(at + 1)}`;
        return [row[0] ?? '', row[1] ?? '', row[2] ?? '', rewritten, row[4] ?? ''];
      }),
    );
    const other = runWith(shouted.inputDir, shouted.configPath);
    const base = runFixture(GOLDEN_ROOT, 'G01-clean-contacts', { scratchName: 'm3-local-base' });
    assert.notDeepEqual(deliveredSummary(other), deliveredSummary(base.result));
  });
});

describe('M4 the same data in a workbook', () => {
  it('a CSV and an equivalent workbook deliver the same records', () => {
    const caseId = 'G01-clean-contacts';
    const base = runFixture(GOLDEN_ROOT, caseId, { scratchName: 'm4-base' });

    const source = readFileSync(join(GOLDEN_ROOT, caseId, 'input', 'contacts.csv'), 'utf8');
    const parsed = readCsv(source, {
      delimiter: ',',
      filePath: 'contacts.csv',
      maxCellLength: 100_000,
      maxColumns: 500,
      maxRows: 100_000,
    });

    const rowsXml = parsed.records
      .map((record, rowIndex) => {
        const cells = record.fields
          .map((value, columnIndex) => {
            const reference = `${String.fromCharCode(65 + columnIndex)}${String(rowIndex + 1)}`;
            const escaped = value.split('&').join('&amp;').split('<').join('&lt;');
            return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escaped}</t></is></c>`;
          })
          .join('');
        return `<row r="${String(rowIndex + 1)}">${cells}</row>`;
      })
      .join('');

    const bytes = zipSync(
      {
        '[Content_Types].xml': [
          strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
          ),
          { mtime: MTIME },
        ],
        '_rels/.rels': [
          strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
          ),
          { mtime: MTIME },
        ],
        'xl/workbook.xml': [
          strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`,
          ),
          { mtime: MTIME },
        ],
        'xl/_rels/workbook.xml.rels': [
          strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
          ),
          { mtime: MTIME },
        ],
        'xl/worksheets/sheet1.xml': [
          strToU8(
            `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
          ),
          { mtime: MTIME },
        ],
      },
      { level: 0 },
    );

    const root = scratchDir('metamorphic', 'm4');
    const inputDir = join(root, 'input');
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, 'contacts.xlsx'), Buffer.from(bytes));

    const config = JSON.parse(readFileSync(join(GOLDEN_ROOT, caseId, 'config.json'), 'utf8')) as {
      files: { path: string; format: string }[];
    };
    config.files[0] = { ...config.files[0], path: 'contacts.xlsx', format: 'XLSX' } as never;
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));

    const other = runWith(inputDir, configPath);
    assert.deepEqual(deliveredSummary(other), deliveredSummary(base.result));
    assert.equal(other.reconciliation.sourceRows.total, base.result.reconciliation.sourceRows.total);
  });
});

describe('M5 splitting one sheet into two files', () => {
  it('the same rows split across two files deliver the same records', () => {
    const caseId = 'G01-clean-contacts';
    const base = runFixture(GOLDEN_ROOT, caseId, { scratchName: 'm5-base' });

    const parsed = readCsv(readFileSync(join(GOLDEN_ROOT, caseId, 'input', 'contacts.csv'), 'utf8'), {
      delimiter: ',',
      filePath: 'contacts.csv',
      maxCellLength: 100_000,
      maxColumns: 500,
      maxRows: 100_000,
    });
    const header = [...(parsed.records[0]?.fields ?? [])];
    const rows = parsed.records.slice(1).map((record) => [...record.fields]);
    const half = Math.ceil(rows.length / 2);

    const root = scratchDir('metamorphic', 'm5');
    const inputDir = join(root, 'input');
    mkdirSync(inputDir, { recursive: true });
    writeFileSync(join(inputDir, 'part-a.csv'), Buffer.from(renderCsv(header, rows.slice(0, half)), 'utf8'));
    writeFileSync(join(inputDir, 'part-b.csv'), Buffer.from(renderCsv(header, rows.slice(half)), 'utf8'));

    const original = JSON.parse(readFileSync(join(GOLDEN_ROOT, caseId, 'config.json'), 'utf8')) as {
      files: unknown[];
      records: { id: string; fileId: string }[];
    };
    const recordMapping = original.records[0] as Record<string, unknown>;
    const config = {
      ...original,
      files: [
        { id: 'a', path: 'part-a.csv', format: 'CSV' },
        { id: 'b', path: 'part-b.csv', format: 'CSV' },
      ],
      records: [
        { ...recordMapping, id: 'contacts-a', fileId: 'a' },
        { ...recordMapping, id: 'contacts-b', fileId: 'b' },
      ],
    };
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));

    const other = runWith(inputDir, configPath);
    assert.deepEqual(deliveredSummary(other), deliveredSummary(base.result));
    assert.equal(other.reconciliation.sourceRows.total, base.result.reconciliation.sourceRows.total);
    assert.equal(other.reconciliation.identity.provenMerges, 0);
  });
});
