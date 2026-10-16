import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { logicalName, packagePath, placedArtifactNames } from '../../src/artifacts/layout.js';
import { GOLDEN_ROOT, runFixture } from '../support/harness.js';
import { listPackageFiles } from '../../src/artifacts/write-package.js';

/**
 * Where every artifact belongs, written out here rather than read from the
 * module under test.
 *
 * This duplication is the test. `01_IMPORT` is the one directory an operator is
 * told to feed to their CRM, so which side of that line an artifact falls on is
 * a contract and not an implementation detail — and a contract that is only
 * stated in the code that implements it is not checked by anything. If a change
 * moves an artifact, this list has to be edited deliberately, which is the
 * moment to ask whether the operator should be importing it.
 */
const EXPECTED_AREA: Readonly<Record<string, string>> = {
  // Someone has to decide something about each of these.
  'isolated.csv': '02_EXCEPTIONS',
  'leftovers.csv': '02_EXCEPTIONS',
  'rejected-input.csv': '02_EXCEPTIONS',
  'unmapped-fields.csv': '02_EXCEPTIONS',
  'unresolved-associations.csv': '02_EXCEPTIONS',
  'destination-conflicts.csv': '02_EXCEPTIONS',
  'duplicate-candidates.csv': '02_EXCEPTIONS',
  'formula-risk.csv': '02_EXCEPTIONS',

  // Evidence of what the run did.
  'source-lineage.csv': '03_TRACEABILITY',
  'import-crosswalk.csv': '03_TRACEABILITY',
  'changes.csv': '03_TRACEABILITY',
  'flags.csv': '03_TRACEABILITY',
  'associations.csv': '03_TRACEABILITY',
  'destination-matching.csv': '03_TRACEABILITY',
  'instance-verification.csv': '03_TRACEABILITY',
  'merges.json': '03_TRACEABILITY',
  'reconciliation.json': '03_TRACEABILITY',
  'config.normalized.json': '03_TRACEABILITY',

  // What a person reads.
  'audit.md': '04_DOCUMENTATION',
  'import-instructions.md': '04_DOCUMENTATION',
};

const AREAS = ['01_IMPORT', '02_EXCEPTIONS', '03_TRACEABILITY', '04_DOCUMENTATION'];

describe('the package layout', () => {
  it('places every artifact in the area the contract gives it', () => {
    for (const [name, area] of Object.entries(EXPECTED_AREA)) {
      assert.equal(packagePath(name), `${area}/${name}`, `${name} is in the wrong area`);
    }
  });

  it('knows about exactly the artifacts the contract names', () => {
    assert.deepEqual([...placedArtifactNames()].sort(), Object.keys(EXPECTED_AREA).sort());
  });

  it('refuses an artifact that belongs to no area', () => {
    // A new artifact that quietly landed at the package root would be a file the
    // operator cannot classify, sitting beside the one directory they were told
    // to import. Better to fail the run than to ship it.
    assert.throws(() => packagePath('something-new.csv'), /PACKAGE_LAYOUT_COMPLETE/u);
  });

  it('leaves an import path alone, because those are addressed as paths', () => {
    assert.equal(packagePath('01_IMPORT/hubspot/contacts.csv'), '01_IMPORT/hubspot/contacts.csv');
    assert.equal(packagePath('manifest.json'), 'manifest.json');
  });

  it('reads a name back from where it was found', () => {
    for (const [name, area] of Object.entries(EXPECTED_AREA)) {
      assert.equal(logicalName(`${area}/${name}`), name);
    }
    assert.equal(logicalName('01_IMPORT/hubspot/contacts.csv'), '01_IMPORT/hubspot/contacts.csv');
  });

  it('writes a real package with nothing outside the four areas', () => {
    const run = runFixture(GOLDEN_ROOT, 'G11-associations', { scratchName: 'layout-areas' });
    const files = listPackageFiles(run.packageDir);
    assert.ok(files.length > 10, 'the fixture must produce a full package');

    for (const path of files) {
      if (path === 'manifest.json') continue;
      const area = path.split('/')[0] ?? '';
      assert.ok(AREAS.includes(area), `${path} is outside the four areas`);
      if (area === '01_IMPORT') continue;
      const name = path.slice(area.length + 1);
      assert.equal(EXPECTED_AREA[name], area, `${name} was written to ${area}`);
    }

    // Every artifact the contract names is actually produced, so an area cannot
    // be satisfied by having nothing in it.
    for (const [name, area] of Object.entries(EXPECTED_AREA)) {
      assert.ok(files.includes(`${area}/${name}`), `${name} is missing from the package`);
    }
  });
});
