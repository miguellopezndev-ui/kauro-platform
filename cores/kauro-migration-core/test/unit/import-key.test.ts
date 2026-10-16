import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { importKeyFor, objectsNeedingImportKey } from '../../src/artifacts/import-key.js';
import type { MigrationConfig } from '../../src/domain/config.js';

const RUN = 'run_0123456789abcdef01234567';
const KEY = 'mk_contact_0f895d0d3d9339ebe2bd';

describe('the association key', () => {
  it('is the same key for the same run and record', () => {
    // The engine is byte-reproducible, so this is not a nicety: the import file
    // and the crosswalk are written from two separate walks and have to agree.
    assert.equal(importKeyFor(RUN, KEY), importKeyFor(RUN, KEY));
  });

  it('is twenty-four lower-case hex digits', () => {
    assert.match(importKeyFor(RUN, KEY), /^[0-9a-f]{24}$/u);
  });

  it('does not follow from the migration key alone', () => {
    // This is the property that keeps the key from being a stable pseudonym for
    // a record. If the run played no part, anyone holding a key left behind in a
    // CRM could hash the trace keys out of some other package's traceability and
    // find the record — which is exactly the link 01_IMPORT exists to withhold.
    assert.notEqual(importKeyFor('run_aaaaaaaaaaaaaaaaaaaaaaaa', KEY), importKeyFor('run_bbbbbbbbbbbbbbbbbbbbbbbb', KEY));
  });

  it('separates the run from the record, so two joins cannot collide', () => {
    // Concatenating without a separator would make ("ab", "c") and ("a", "bc")
    // the same key, and a run id and a migration key are both variable-length.
    assert.notEqual(importKeyFor('run_a', 'bc'), importKeyFor('run_ab', 'c'));
  });

  it('tells two records of the same run apart', () => {
    assert.notEqual(importKeyFor(RUN, 'mk_contact_aaaaaaaaaaaaaaaaaaaa'), importKeyFor(RUN, 'mk_contact_bbbbbbbbbbbbbbbbbbbb'));
  });

  it('discloses nothing of the record it names', () => {
    const key = importKeyFor(RUN, KEY);
    assert.ok(!key.includes('mk_'), 'the key must not carry the migration key');
    assert.ok(!KEY.includes(key), 'the key must not be a slice of the migration key');
  });
});

function configWith(associations: { relationshipType: string }[]): MigrationConfig {
  return { associations } as unknown as MigrationConfig;
}

describe('which import files carry the association key', () => {
  it('names both ends of every relationship the plan declares', () => {
    const objects = objectsNeedingImportKey(configWith([{ relationshipType: 'CONTACT_TO_COMPANY' }]));
    assert.deepEqual([...objects].sort(), ['COMPANY', 'CONTACT']);
  });

  it('names nothing when the plan declares no relationship', () => {
    // An object nothing is associated with gets a file of destination fields
    // only: there is nothing to join it to, so there is no column to explain,
    // ignore, or accidentally map into a property.
    assert.deepEqual([...objectsNeedingImportKey(configWith([]))], []);
  });

  it('takes the union across relationships rather than the last one', () => {
    const objects = objectsNeedingImportKey(
      configWith([{ relationshipType: 'CONTACT_TO_COMPANY' }, { relationshipType: 'COMPANY_TO_DEAL' }]),
    );
    assert.deepEqual([...objects].sort(), ['COMPANY', 'CONTACT', 'DEAL']);
  });
});
