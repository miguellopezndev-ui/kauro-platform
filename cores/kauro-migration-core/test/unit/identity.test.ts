import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderIdentityKey, permitsAutomaticMerge } from '../../src/domain/identity.js';
import type { SourceIdentityKey } from '../../src/domain/identity.js';
import type { IdentityEvidence } from '../../src/domain/identity.js';
import { runInline, textField } from '../support/inline.js';
import { GOLDEN_ROOT, collect, readTable, runFixture } from '../support/harness.js';

/**
 * The identity key, tested at the level where the forgeries were found.
 *
 * An independent review broke this twice. First by concatenating an external
 * identifier into the id segment; that was fixed by giving every part its own
 * escaped segment. Then by the same trick one field to the left: the column
 * segment was header text, so two columns sharing a header rendered one key,
 * and a headerless column rendered synthesized text that a real header could
 * spell. These cases pin both.
 */

function key(overrides: Partial<SourceIdentityKey> = {}): string {
  return renderIdentityKey({
    sourceSystem: 'generic_csv',
    sourceNamespace: 'acme',
    identitySpace: 'contacts',
    objectType: 'CONTACT',
    keyKind: 'EXTERNAL_ID',
    keyColumn: 'Legacy ID',
    keyColumnAddress: 'occurrence:1',
    sourceRecordId: '500',
    ...overrides,
  });
}

describe('an identity key names one column, not one column name', () => {
  it('separates two columns that share a header', () => {
    assert.notEqual(key({ keyColumnAddress: 'occurrence:1' }), key({ keyColumnAddress: 'occurrence:2' }));
  });

  it('separates a headerless column from a column whose header spells its position', () => {
    // The headerless column at index 1 used to render "#1", which is a header
    // a file may genuinely carry.
    const headerless = key({ keyColumn: '', keyColumnAddress: 'index:1' });
    const spelled = key({ keyColumn: '#1', keyColumnAddress: 'occurrence:1' });
    const literal = key({ keyColumn: 'index:1', keyColumnAddress: 'occurrence:1' });
    assert.equal(new Set([headerless, spelled, literal]).size, 3);
  });

  it('separates a lead from a contact the export numbered the same', () => {
    // A Lead and a Contact are two records, so the object type is its own
    // segment: one sequence numbering both from 1 — the most ordinary CRM
    // export there is — must not render one key for row 500 of each.
    assert.notEqual(key({ objectType: 'CONTACT' }), key({ objectType: 'LEAD' }));
  });

  it('keeps the same column in two files as one key', () => {
    // The address is where the column sits in its sheet, not which file it came
    // from: two halves of one export still merge on a shared external id.
    assert.equal(key(), key());
  });

  it('cannot be forged by spelling a separator into any segment', () => {
    const parts: (keyof SourceIdentityKey)[] = [
      'sourceSystem',
      'sourceNamespace',
      'identitySpace',
      'keyColumn',
      'keyColumnAddress',
      'sourceRecordId',
    ];
    const rendered = new Set<string>();
    for (const part of parts) {
      for (const value of ['a|b', 'a\\|b', 'a\\b', 'a', 'b']) {
        rendered.add(key({ [part]: value } as Partial<SourceIdentityKey>));
      }
    }
    assert.equal(rendered.size, parts.length * 5, 'two different keys rendered the same string');
  });
});

describe('a merge cites the key that joined it', () => {
  const evidence = (heldByMembers: number): IdentityEvidence => ({
    kind: 'SOURCE_RECORD_ID',
    authority: heldByMembers > 1 ? 'PROVING' : 'SUPPORTING',
    heldByMembers,
    value: key(),
    reasonCode: heldByMembers > 1 ? 'IDENTITY_PROVEN_SOURCE_RECORD_ID' : 'IDENTITY_MEMBER_KEY_NOT_SHARED',
  });

  it('does not accept a merge whose every key is held by one row', () => {
    // Two rows with two different record ids in one identity space are, by the
    // engine's own definition, two records. Listing both as PROVING made a
    // merge cite the evidence that it should not have happened.
    assert.equal(permitsAutomaticMerge([evidence(1), evidence(1)]), false);
  });

  it('accepts a merge with a key two rows share', () => {
    assert.equal(permitsAutomaticMerge([evidence(2), evidence(1)]), true);
  });
});

/**
 * An identifier is a value, and whitespace is part of it (R2-002, D67).
 *
 * The engine used to trim every source id and external id on the way into the
 * proving key, whatever the field options said. Two rows whose ids differed
 * only by padding then became one record with no approved decision anywhere.
 */
describe('a source id enters its identity key byte for byte', () => {
  const trimNothing = { trim: false };
  const fields = [
    textField('First Name', 'contact.firstName', trimNothing),
    textField('Last Name', 'contact.lastName', trimNothing),
  ];
  const headers = ['Contact ID', 'First Name', 'Last Name'];

  it("[R2-002] source ids 'A' and ' A ' are two identity keys without an approved identity normalization", () => {
    const ran = runInline('r2-002-ids', {
      headers,
      rows: [
        ['A', 'Ada', 'Lovelace'],
        [' A ', 'Ada', 'Lovelace'],
      ],
      fields,
    });
    assert.deepEqual(ran.verification.problems, []);
    assert.equal(ran.run.truth.merges.length, 0, 'nothing proved these rows are one record');
    const records = [...ran.run.truth.deliveredRecords];
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.sourceRecordId).sort(), [' A ', 'A']);
    assert.equal(new Set(records.map((record) => record.migrationKey)).size, 2);
  });

  it('[R2-002] a whitespace-only source id counts as no id and is flagged, never keyed', () => {
    const ran = runInline('r2-002-blank-id', {
      headers,
      rows: [
        ['   ', 'Ada', 'Lovelace'],
        ['\t', 'Ada', 'Lovelace'],
      ],
      fields,
    });
    const records = [...ran.run.truth.deliveredRecords];
    assert.equal(records.length, 2, 'two rows with no id are two records, not one');
    for (const record of records) assert.equal(record.sourceRecordId, null);
    const flags = [...ran.run.truth.flags].filter((flag) => flag.destinationField === 'source record id');
    assert.equal(flags.length, 2, 'each blank id is said out loud');
    assert.deepEqual(flags.map((flag) => flag.preservedValue).sort(), ['\t', '   ']);
  });
});

/**
 * A column is its position (S022).
 *
 * A header is a label, and a label can be empty or repeated. An object keyed by
 * label would keep one of two columns called Phone and would have nowhere to put
 * a column called nothing. The engine addresses columns by position, and this
 * follows three of them through a complete package to show that none is lost,
 * renamed or overwritten on the way.
 */
describe('positional field ids survive an empty header and repeated headers', () => {
  it('[S022] an empty header and two repeated headers keep three positional field ids through the complete package', () => {
    const headers = ['Contact ID', 'First Name', '', 'Phone', 'Phone'];
    const rows = [
      ['1', 'Ada', 'Analyst', '+12125550147', '+14155552671'],
      ['2', 'Alan', 'Cryptanalyst', '+442079460958', '+34612345678'],
    ];

    // Nothing maps the three columns, so the package has to carry each of them
    // by its id: the unmapped-fields artifact is where an address is all there is.
    const unmapped = runInline('s022-unmapped', {
      headers,
      rows,
      fields: [textField('First Name', 'contact.firstName')],
    });
    assert.deepEqual(unmapped.verification.problems, []);
    const table = readTable(unmapped.packageDir, 'unmapped-fields.csv');
    assert.equal(table.rows.length, 6, 'three columns of two rows');
    for (const [rowIndex, source] of rows.entries()) {
      const mine = table.rows.filter((row) => row['row_number'] === String(rowIndex + 2));
      assert.deepEqual(
        mine.map((row) => [row['column_index'], row['column_header'], row['value']]),
        [
          ['2', '', source[2]],
          ['3', 'Phone', source[3]],
          ['4', 'Phone', source[4]],
        ],
        `row ${String(rowIndex + 2)} keeps each value at its own position`,
      );
      const ids = mine.map((row) => row['column_locator_id'] ?? '');
      assert.equal(new Set(ids).size, 3, 'three different field ids');
      assert.deepEqual(ids.map((id) => id.slice(id.lastIndexOf(':') + 1)), ['C2', 'C3', 'C4']);
    }

    // Mapped by position, each lands in its own destination field (golden G41).
    const golden = runFixture(GOLDEN_ROOT, 'G41-empty-and-repeated-headers', { scratchName: 's022-g41' });
    assert.deepEqual(golden.verification.problems, []);
    const delivered = collect(golden.result.truth.deliveredRecords).sort((a, b) =>
      (a.sourceRecordId ?? '') < (b.sourceRecordId ?? '') ? -1 : 1,
    );
    assert.equal(delivered.length, 2);
    assert.deepEqual(
      delivered.map((record) => [record.values['contact.description'], record.values['contact.phone'], record.values['contact.mobilePhone']]),
      [
        ['Analyst', '+12125550147', '+14155552671'],
        ['Cryptanalyst', '+442079460958', '+34612345678'],
      ],
    );
  });
});
