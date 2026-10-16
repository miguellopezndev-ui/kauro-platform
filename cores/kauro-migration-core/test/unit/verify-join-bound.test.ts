import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { coGroup } from '../../src/verify/join.js';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { caseScratch, scratchDir, verifyScratch } from '../support/harness.js';

/**
 * B02-R3: the package verifier joined every relationship claim about one source
 * id at once, so a parent with n children held n claims. The join is bounded
 * now. These cases write a package whose every edge points at one parent and
 * verify it with a small bound, reading how many rows the join held.
 */
function hotParentPackage(name: string, children: number): string {
  const dir = scratchDir('verify-join-bound', name);
  const inputDir = join(dir, 'input');
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(join(inputDir, 'companies.csv'), 'Company ID,Name\nA-0,Hot Parent\n', 'utf8');
  const lines = ['Contact ID,First Name,Company ID'];
  for (let index = 0; index < children; index += 1) lines.push(`C-${String(index)},First${String(index % 97)},A-0`);
  writeFileSync(join(inputDir, 'contacts.csv'), `${lines.join('\n')}\n`, 'utf8');
  const config = {
    configVersion: '3.0.0',
    source: { system: 'generic_csv', namespace: name },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [
      { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
      { id: 'companies', path: 'companies.csv', format: 'CSV' },
    ],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: [{ column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' }],
      },
      {
        id: 'companies',
        fileId: 'companies',
        object: 'COMPANY',
        sourceRecordIdColumn: { header: 'Company ID' },
        fields: [{ column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' }],
      },
    ],
    associations: [
      {
        id: 'contact-company',
        kind: 'COLUMN_REFERENCE',
        recordMappingId: 'contacts',
        relationshipType: 'CONTACT_TO_COMPANY',
        keyColumn: { header: 'Company ID' },
        targetRecordMappingId: 'companies',
        targetMatchKey: 'SOURCE_RECORD_ID',
      },
    ],
  };
  const loaded = loadConfig(JSON.stringify(config), `inline:${name}`);
  const run = runMigration({
    scratch: caseScratch(`verify-join-bound-${name}`),
    inputRoot: inputDir,
    config: loaded.config,
    configHash: loaded.configHash,
  });
  const packageDir = join(dir, 'package');
  writeAndPromotePackage({
    result: run,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  return packageDir;
}

describe('the package verifier holds a bounded number of rows of one join key (B02-R3)', () => {
  const CHILDREN = 3_000;
  const BOUND = 64;
  const packageDir = hotParentPackage('hot-parent', CHILDREN);

  it('[B02-R3] a parent with 3000 children is verified holding at most the bound, with the same result as unbounded', () => {
    let widest = 0;
    let groups = 0;
    const bounded = verifyPackage(packageDir, {
      scratch: verifyScratch(packageDir),
      joinBound: BOUND,
      observeJoin: (_check, held) => {
        widest = Math.max(widest, held);
        groups += 1;
      },
    });
    const unbounded = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
    assert.deepEqual(bounded.problems, []);
    assert.deepEqual(unbounded.problems, []);
    assert.equal(JSON.stringify(bounded), JSON.stringify(unbounded), 'the bound changes no verdict');
    assert.ok(groups > CHILDREN / BOUND, `the hot key was walked in pieces (${String(groups)} groups)`);
    assert.ok(widest <= BOUND, `the join held ${String(widest)} rows of one key, the bound is ${String(BOUND)}`);
  });

  it('[B02-R3] the bound is a bound: without it the same package holds every child at once', () => {
    // The instrument must see the defect it guards against.
    let widest = 0;
    verifyPackage(packageDir, {
      scratch: verifyScratch(packageDir),
      joinBound: Number.POSITIVE_INFINITY,
      observeJoin: (_check, held) => {
        widest = Math.max(widest, held);
      },
    });
    assert.ok(widest >= CHILDREN, `unbounded held only ${String(widest)} rows`);
  });

  it('[B02-R3] a forged claim against the hot parent is still found when it falls in a later piece', () => {
    const forged = hotParentPackage('hot-parent-forged', 300);
    // Point one edge, well past the first piece of 16, at a record that is not the one its source id names.
    const path = join(forged, '03_TRACEABILITY', 'associations.csv');
    const lines = readFileSync(path, 'utf8').split('\n');
    const target = lines[250] ?? '';
    assert.ok(target.includes('mk_company_'), 'the forged line is an edge row');
    lines[250] = target.replace(/mk_company_[0-9a-f]+/u, 'mk_company_ffffffffffffffffffff');
    writeFileSync(path, lines.join('\n'), 'utf8');
    const agreeing = (report: { problems: readonly unknown[] }): string[] =>
      report.problems.map((problem) => JSON.stringify(problem)).filter((text) => text.includes('ownerSideAgrees'));
    const bounded = agreeing(verifyPackage(forged, { scratch: verifyScratch(forged), joinBound: 16 }));
    const unbounded = agreeing(verifyPackage(forged, { scratch: verifyScratch(forged) }));
    assert.ok(unbounded.length >= 1, 'the forgery is a thing the verifier finds');
    assert.deepEqual(bounded, unbounded, 'in pieces it finds exactly what it finds whole');
  });
});

describe('coGroup with a bound never yields a bucket wider than it', () => {
  it('[B02-R3] 100000 same-key claims against one parent are consumed in pieces of at most the bound', () => {
    const claims = Array.from({ length: 100_000 }, (_unused, index) => ({ k: 'A-0', v: index }));
    let widest = 0;
    let seen = 0;
    for (const group of coGroup(claims, [{ k: 'A-0', v: 'parent' }], { bound: 1_000 })) {
      widest = Math.max(widest, group.left.length);
      seen += group.left.length;
    }
    assert.equal(seen, 100_000);
    assert.ok(widest <= 1_000);
  });
});
