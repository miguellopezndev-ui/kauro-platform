import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { collect, readTable } from '../support/harness.js';
import { runInline, textField } from '../support/inline.js';
import type { InlineRun } from '../support/inline.js';

/**
 * A value is what the source wrote.
 *
 * Each case here states its truth from the bytes it wrote into the input file,
 * runs the public path (configuration, migration, package, verification) and
 * reads the artifacts. None of the expected values comes from the engine.
 */

const IMPORT_FILE = '01_IMPORT/clean-only/contacts.csv';

function importTable(ran: InlineRun) {
  return readTable(ran.packageDir, IMPORT_FILE);
}

function assertVerifies(ran: InlineRun): void {
  assert.deepEqual(
    ran.verification.problems,
    [],
    ran.verification.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; '),
  );
}

const NAME_HEADERS = ['Contact ID', 'First Name', 'Last Name'];
const NAME_FIELDS = [textField('First Name', 'contact.firstName'), textField('Last Name', 'contact.lastName')];

// U+00E9 as one code point, and as "e" followed by U+0301.
const NFC_E_ACUTE = 'é';
const NFD_E_ACUTE = 'é';

describe('Unicode spellings of one id', () => {
  it('[R2-003] NFC and NFD spellings of one id stay two records without an approved identity normalization', () => {
    assert.notEqual(NFC_E_ACUTE, NFD_E_ACUTE);
    assert.equal(NFC_E_ACUTE, NFD_E_ACUTE.normalize('NFC'));
    const ran = runInline('r2-003-plain', {
      headers: NAME_HEADERS,
      rows: [
        [`R${NFC_E_ACUTE}`, 'Rene', 'Costa'],
        [`R${NFD_E_ACUTE}`, 'Rene', 'Costa'],
      ],
      fields: NAME_FIELDS,
    });
    assertVerifies(ran);
    assert.equal(ran.run.truth.merges.length, 0, 'no approved normalization, so nothing proved these are one record');
    const records = collect(ran.run.truth.deliveredRecords);
    assert.equal(records.length, 2);
    // Each id is delivered as the source spelled it, code point for code point.
    assert.deepEqual(
      records.map((record) => record.sourceRecordId).sort(),
      [`R${NFC_E_ACUTE}`, `R${NFD_E_ACUTE}`].sort(),
    );
    assert.equal(
      collect(ran.run.truth.flags).some((flag) => (flag.reasonCode as string) === 'IDENTITY_KEY_NORMALIZED'),
      false,
      'no normalization was declared, so none may be reported',
    );
  });

  it('[R2-003] an approved NFC identity normalization records the collision as an identity decision naming both source values', () => {
    const ran = runInline('r2-003-nfc', {
      headers: NAME_HEADERS,
      rows: [
        [`R${NFC_E_ACUTE}`, 'Rene', 'Costa'],
        [`R${NFD_E_ACUTE}`, 'Rene', 'Costa'],
        ['Q', 'Quinn', 'Reyes'],
      ],
      fields: NAME_FIELDS,
      record: { sourceRecordIdColumn: { header: 'Contact ID', identityNormalization: { unicode: 'NFC' } } },
    });
    assertVerifies(ran);
    assert.equal(ran.run.truth.merges.length, 1, 'the declared normalization is what makes the two spellings one key');
    const merge = ran.run.truth.merges[0];
    assert.ok(merge !== undefined);

    // The collision is a decision, on the merge that it caused, and it names
    // both spellings the source used.
    const collision = (merge.identityEvidence as readonly { reasonCode: string; authority: string; sourceValues?: readonly string[] }[]).filter(
      (item) => item.reasonCode === 'IDENTITY_NORMALIZATION_COLLISION',
    );
    assert.equal(collision.length, 1);
    assert.equal(collision[0]?.authority, 'PROVING');
    assert.deepEqual([...(collision[0]?.sourceValues ?? [])].sort(), [`R${NFC_E_ACUTE}`, `R${NFD_E_ACUTE}`].sort());

    // The same decision is in the package a reader receives.
    const written = JSON.parse(readFileSync(join(ran.packageDir, '03_TRACEABILITY', 'merges.json'), 'utf8')) as {
      merges: { identityEvidence: { reasonCode: string; sourceValues?: string[] }[] }[];
    };
    const inPackage = written.merges.flatMap((item) => item.identityEvidence).filter((item) => item.reasonCode === 'IDENTITY_NORMALIZATION_COLLISION');
    assert.equal(inPackage.length, 1);
    assert.deepEqual([...(inPackage[0]?.sourceValues ?? [])].sort(), [`R${NFC_E_ACUTE}`, `R${NFD_E_ACUTE}`].sort());

    // Each row whose key the normalization changed says so, with the value it
    // had and the value it was keyed as. The row that was already NFC does not.
    const flags = collect(ran.run.truth.flags).filter((flag) => (flag.reasonCode as string) === 'IDENTITY_KEY_NORMALIZED');
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.preservedValue, `R${NFD_E_ACUTE}`);
    assert.ok(flags[0]?.evidence.includes(`R${NFC_E_ACUTE}`));

    const records = collect(ran.run.truth.deliveredRecords);
    assert.equal(records.length, 2, 'the two spellings became one record; the third row is its own');
  });
});

describe('numbers keep the sign and the scale the source wrote', () => {
  const numberField = (header: string, options: Record<string, unknown> = {}) => ({
    column: { header },
    destinationField: 'custom:balance',
    semanticType: 'NUMBER',
    ...(Object.keys(options).length === 0 ? {} : { options }),
  });

  it('[R2-004] -0, -0.00 and 1.50 keep their lexical sign and scale, and IDENTIFIER -0 never matches 0', () => {
    const ran = runInline('r2-004', {
      headers: ['Contact ID', 'Balance'],
      rows: [
        ['-0', '-0'],
        ['0', '0'],
        ['-0.00', '-0.00'],
        ['1.50', '1.50'],
      ],
      fields: [numberField('Balance')],
    });
    assertVerifies(ran);
    const records = collect(ran.run.truth.deliveredRecords);
    // Four ids, four records: "-0" is not "0" and "-0.00" is neither.
    assert.equal(records.length, 4);
    assert.equal(ran.run.truth.merges.length, 0);
    const balanceById = new Map(records.map((record) => [record.sourceRecordId, record.values['custom:balance']]));
    assert.deepEqual([...balanceById.entries()].sort(), [
      ['-0', '-0'],
      ['-0.00', '-0.00'],
      ['0', '0'],
      ['1.50', '1.50'],
    ]);
    assert.equal(
      collect(ran.run.truth.changes).length,
      0,
      'a plain number is accepted as written; no round trip through a JSON number happened',
    );

    // The same values under a declared decimal comma keep sign and scale too.
    const declared = runInline('r2-004-comma', {
      headers: ['Contact ID', 'Balance'],
      rows: [
        ['1', '-0'],
        ['2', '-0,00'],
        ['3', '1,50'],
        ['4', '-1.000,10'],
      ],
      fields: [numberField('Balance', { decimalSeparator: ',', thousandsSeparator: '.' })],
    });
    assertVerifies(declared);
    const byId = new Map(collect(declared.run.truth.deliveredRecords).map((record) => [record.sourceRecordId, record.values['custom:balance']]));
    assert.deepEqual([...byId.entries()].sort(), [
      ['1', '-0'],
      ['2', '-0.00'],
      ['3', '1.50'],
      ['4', '-1000.10'],
    ]);
  });

  it('[R2-005] a declared western grammar withholds the European minority rather than converting it, in changes and isolation artifacts', () => {
    const rows = [
      ['1', '1,234.56'],
      ['2', '2,345.67'],
      ['3', '3,456.78'],
      ['4', '1.234,56'],
      ['5', '7,5'],
    ];
    const western = { decimalSeparator: '.', thousandsSeparator: ',' };

    // Preserved and flagged: the European values are delivered as written.
    const preserved = runInline('r2-005-flag', {
      headers: ['Contact ID', 'Balance'],
      rows,
      fields: [numberField('Balance', western)],
    });
    assertVerifies(preserved);
    const values = new Map(collect(preserved.run.truth.deliveredRecords).map((record) => [record.sourceRecordId, record.values['custom:balance']]));
    assert.equal(values.get('1'), '1234.56');
    assert.equal(values.get('3'), '3456.78');
    assert.equal(values.get('4'), '1.234,56', 'not converted, although most of the column is western');
    assert.equal(values.get('5'), '7,5', 'not converted');
    const changed = readTable(preserved.packageDir, 'changes.csv').rows.map((row) => Object.values(row).join('|'));
    assert.equal(changed.some((line) => line.includes('1.234,56')), false, 'the minority is not in the change log');
    assert.equal(changed.some((line) => line.includes('7,5')), false);
    const flags = readTable(preserved.packageDir, 'flags.csv');
    const flagged = flags.rows.map((row) => Object.values(row).join('|'));
    assert.equal(flagged.filter((line) => line.includes('1.234,56')).length, 1);
    assert.equal(flagged.filter((line) => line.includes('7,5')).length, 1);
    assert.equal(flagged.some((line) => line.includes('TRANSFORM_NUMBER_INVALID')), true);

    // Isolated on request: the rows leave the import and wait for a decision.
    const isolated = runInline('r2-005-isolate', {
      headers: ['Contact ID', 'Balance'],
      rows,
      fields: [{ ...numberField('Balance', western), onInvalid: 'ISOLATE_ROW' }],
    });
    assertVerifies(isolated);
    assert.deepEqual(
      collect(isolated.run.truth.deliveredRecords).map((record) => record.sourceRecordId).sort(),
      ['1', '2', '3'],
    );
    // The isolation names the rows by where they sit in the input: the header is
    // row 1, so contacts 4 and 5, the two European spellings, are rows 5 and 6.
    const isolatedRows = readTable(isolated.packageDir, 'isolated.csv').rows;
    assert.deepEqual(isolatedRows.map((row) => row['row_number']).sort(), ['5', '6']);
    for (const row of isolatedRows) {
      assert.equal(row['reason_code'], 'ISOLATED_INVALID_FIELD');
      assert.ok((row['detail'] ?? '').includes('TRANSFORM_NUMBER_INVALID'));
    }
    // The values themselves are preserved beside their reason in the lineage.
    const lineage = readTable(isolated.packageDir, 'source-lineage.csv').rows.map((row) => Object.values(row).join('|'));
    assert.equal(lineage.filter((line) => line.includes('ISOLATED')).length >= 2, true);
    const importValues = importTable(isolated).rows.map((row) => Object.values(row).join('|')).join('\n');
    assert.equal(importValues.includes('1.234,56'), false);
    assert.equal(importValues.includes('1234.56'), true);
  });
});

describe('a phone without a country', () => {
  const phoneField = (options: Record<string, unknown> = {}) => ({
    column: { header: 'Phone' },
    destinationField: 'contact.phone',
    semanticType: 'PHONE',
    ...(Object.keys(options).length === 0 ? {} : { options }),
  });

  it('[S028] a national number with an extension and no country is delivered whole and flagged, through the package', () => {
    const national = '020 7946 0958 ext. 123';
    const ran = runInline('s028', {
      headers: ['Contact ID', 'Phone'],
      rows: [
        ['1', national],
        ['2', '+442079460958 ext. 55'],
      ],
      fields: [phoneField()],
    });
    assertVerifies(ran);
    const records = new Map(collect(ran.run.truth.deliveredRecords).map((record) => [record.sourceRecordId, record]));
    // No country and no international prefix: the number is delivered whole,
    // extension included, and no country is assumed.
    assert.equal(records.get('1')?.values['contact.phone'], national);
    const inImport = importTable(ran).rows.map((row) => row['contact.phone'] ?? '');
    assert.ok(inImport.includes(national), 'the import file holds the value as the source wrote it');
    const flags = readTable(ran.packageDir, 'flags.csv').rows.map((row) => Object.values(row).join('|'));
    assert.equal(
      flags.some((line) => line.includes(national) && line.includes('TRANSFORM_PHONE_NO_COUNTRY_EVIDENCE')),
      true,
      'the value is flagged with the reason',
    );
    // With the "+" the country is established, and with nowhere to put the
    // extension the number is preserved whole as well, and flagged.
    assert.equal(records.get('2')?.values['contact.phone'], '+442079460958 ext. 55');
    assert.equal(flags.some((line) => line.includes('TRANSFORM_PHONE_EXTENSION_NO_DESTINATION_FIELD')), true);
  });
});
