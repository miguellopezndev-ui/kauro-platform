import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { runMigration } from '../../src/run/run-migration.js';
import { writeAndPromotePackage } from '../../src/artifacts/write-package.js';
import { verifyPackage } from '../../src/verify/verify-package.js';
import { hashTargetContract } from '../../src/target/contract.js';
import type { HashedTargetContract, TargetContract } from '../../src/target/contract.js';
import { getAdapter } from '../../src/adapters/specs.js';
import { makeTransformResult } from '../../src/domain/transform.js';
import type { TargetMode } from '../../src/domain/config.js';
import { caseScratch, collect, readTable, repoRoot, scratchDir, verifyScratch } from '../support/harness.js';
import { attestContract } from '../../tools/attestation-fixture.js';

/**
 * What the engine says about a field, and what each destination does with it.
 *
 * Four things a migration can mean, and `string | null` can carry two of them:
 *
 *   PRESERVE  the source value, untouched
 *   SET       a value a rule produced
 *   CLEAR     remove the value the destination holds
 *   OMIT      say nothing; leave the destination alone
 *
 * The defect these cases exist to kill is the collapse of the last two. A
 * transformation returned CLEAR_EXPLICIT with no value, the delivered map
 * dropped every field with no value, and the authorized clear left the run as
 * an omission — the import file then looked exactly like a record that never
 * mentioned the field, and nothing anywhere said otherwise.
 *
 * The fixture holds all three observable states in one file, so no case can
 * pass by treating them alike:
 *
 *   row 2  Job Title "N/A"    matches the clearing rule   -> CLEAR
 *   row 3  Job Title empty    the cell is there and blank -> OMIT
 *   row 4  Job Title "Engineer"                           -> PRESERVE
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');

function contractFor(mode: TargetMode): HashedTargetContract {
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: {
      mode,
      instanceId: mode === 'HUBSPOT' ? '00000001' : '00D000000000001',
      instanceLabel: 'value-intent qualification instance',
      evidence: 'ARTIFACT',
    },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects: [
      {
        apiName: 'Contact',
        label: 'Contact',
        createable: 'TRUE',
        updateable: 'TRUE',
        recordTypes: [],
        fields: [
          {
            apiName: 'email',
            label: 'Email',
            type: 'string',
            createable: 'TRUE',
            updateable: 'TRUE',
            nillable: 'TRUE',
            length: 255,
            precision: null,
            scale: null,
            unique: 'TRUE',
            externalId: 'FALSE',
            idLookup: 'TRUE',
            calculated: 'FALSE',
            autoNumber: 'FALSE',
            defaultedOnCreate: 'FALSE',
            restrictedPicklist: 'FALSE',
            picklistValues: [],
            referenceTo: [],
            relationshipName: null,
            evidence: 'ARTIFACT',
          },
          // The plan delivers four fields, and destination validation consumes
          // this contract (MC-04): a contract that carried only the email would
          // have the other three refused as fields the instance does not have.
          ...(mode === 'HUBSPOT'
            ? [plainField('firstname', 'First name'), plainField('lastname', 'Last name'), plainField('jobtitle', 'Job title')]
            : [plainField('FirstName', 'First Name'), plainField('LastName', 'Last Name'), plainField('Title', 'Title')]),
        ],
      },
    ],
    pipelines: [],
  };
  return hashTargetContract(contract);
}

function plainField(apiName: string, label: string): TargetContract['objects'][number]['fields'][number] {
  return {
    apiName,
    label,
    type: 'string',
    createable: 'TRUE',
    updateable: 'TRUE',
    nillable: 'TRUE',
    length: null,
    precision: null,
    scale: null,
    unique: 'FALSE',
    externalId: 'FALSE',
    idLookup: 'FALSE',
    calculated: 'FALSE',
    autoNumber: 'FALSE',
    defaultedOnCreate: 'FALSE',
    restrictedPicklist: 'FALSE',
    picklistValues: [],
    referenceTo: [],
    relationshipName: null,
    evidence: 'ARTIFACT',
  };
}

interface Ran {
  readonly run: ReturnType<typeof runMigration>;
  readonly packageDir: string;
}

function runCase(
  configName: string,
  options: { inputDir?: string; contract?: HashedTargetContract; scratchName?: string } = {},
): Ran {
  const configPath = join(FIXTURES, `${configName}.json`);
  const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
  // A CRM case attests over whatever contract it was given. These cases are
  // about what happens to a clear the destination cannot express, not about the
  // attestation seam — but the seam applies to them anyway, because it applies
  // to every CRM run, which is the whole point of it being a default.
  //
  // A CRM case that names no contract gets the one this file builds, rather
  // than none: the mode decides whether evidence is required, and a case that
  // simply did not think about it is exactly the caller the default exists for.
  const mode = loaded.config.target.mode;
  const contract = options.contract ?? (mode === 'CLEAN_ONLY' ? null : contractFor(mode));
  const attested = contract === null ? {} : attestContract(contract);
  const run = runMigration({
    scratch: caseScratch('valueintent1'),
    inputRoot: options.inputDir ?? join(FIXTURES, 'input'),
    config: loaded.config,
    configHash: loaded.configHash,
    targetContract: contract,
    ...attested,
  });
  const packageDir = scratchDir('value-intent', options.scratchName ?? configName);
  writeAndPromotePackage({
    result: run,
    config: loaded.config,
    normalizedConfig: loaded.normalizedJson,
    outputDir: packageDir,
    force: true,
  });
  return { run, packageDir };
}

function delivered(ran: Ran, sourceRecordId: string) {
  const found = collect(ran.run.truth.deliveredRecords).find((record) => record.sourceRecordId === sourceRecordId);
  assert.ok(found !== undefined, `no delivered record for source record id ${sourceRecordId}`);
  return found;
}

describe('an authorized clear survives the run as a clear', () => {
  const ran = runCase('clean-only');

  it('does not demote the clear to an omission', () => {
    const ada = delivered(ran, '1');
    assert.deepEqual(ada.clearedFields, ['contact.jobTitle'], 'the clear must reach the delivered record');
    assert.equal(
      Object.hasOwn(ada.values, 'contact.jobTitle'),
      false,
      'a cleared field carries no value; that is the whole difference from SET',
    );
  });

  it('keeps a blank source cell apart from a clear', () => {
    const grace = delivered(ran, '2');
    assert.deepEqual(grace.clearedFields, [], 'a blank cell says nothing; it does not authorize a deletion');
    assert.equal(Object.hasOwn(grace.values, 'contact.jobTitle'), false);
  });

  it('leaves a populated value exactly as the source wrote it', () => {
    const alan = delivered(ran, '3');
    assert.deepEqual(alan.clearedFields, []);
    assert.equal(alan.values['contact.jobTitle'], 'Engineer');
  });

  it('records the clear in the change log with its own reason code', () => {
    const cleared = collect(ran.run.truth.changes).filter(
      (change) => change.reasonCode === 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION',
    );
    assert.equal(cleared.length, 1, 'exactly the one authorized clear');
    assert.equal(cleared[0]?.address.rowNumberSource, 2);
    assert.equal(cleared[0]?.originalValue, 'N/A');
    assert.equal(cleared[0]?.finalValue, null);
    assert.equal(ran.run.reconciliation.cells.clearedByExplicitAuthorization, 1);
  });
});

describe('CLEAN_ONLY writes the clear where a reader can see it', () => {
  const ran = runCase('clean-only');

  it('spells a clear differently from an empty cell', () => {
    const table = readTable(ran.packageDir, '01_IMPORT/clean-only/contacts.csv');
    const byName = new Map(table.rows.map((row) => [row['contact.firstName'] ?? '', row]));

    const token = getAdapter('CLEAN_ONLY').clearRepresentation;
    assert.equal(token.kind, 'EXPLICIT_TOKEN');
    const expected = token.kind === 'EXPLICIT_TOKEN' ? token.token : '';

    assert.equal(byName.get('Ada')?.['contact.jobTitle'], expected, 'the authorized clear is an instruction, not a blank');
    assert.equal(byName.get('Grace')?.['contact.jobTitle'], '', 'a blank source cell stays blank');
    assert.equal(byName.get('Alan')?.['contact.jobTitle'], 'Engineer');
  });

  it('produces a package that verifies from disk', () => {
    const report = verifyPackage(ran.packageDir, { scratch: verifyScratch(ran.packageDir) });
    assert.deepEqual(
      report.problems,
      [],
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; '),
    );
  });
});

describe('a destination that cannot express a clear is not asked to', () => {
  it('refuses the record rather than shipping a blank HubSpot would ignore', () => {
    const ran = runCase('hubspot-update', { contract: contractFor('HUBSPOT') });

    const isolated = collect(ran.run.truth.isolated).filter(
      (entry) => entry.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE',
    );
    assert.equal(isolated.length, 1, 'the row whose clear cannot be carried out');
    assert.equal(isolated[0]?.address.rowNumberSource, 2);
    assert.equal(isolated[0]?.field, 'contact.jobTitle');

    // The two rows that ask for nothing destructive are unaffected: refusing is
    // per record, not a mode that gives up on the file.
    assert.equal(ran.run.reconciliation.records.deliveredTotal, 2);
    assert.equal(
      collect(ran.run.truth.deliveredRecords).some((record) => record.sourceRecordId === '1'),
      false,
      'the record whose clear cannot be represented is not delivered as though it had been',
    );
  });

  it('applies the same refusal to Salesforce, where the null representation is undeclared', () => {
    const ran = runCase('salesforce-update', { contract: contractFor('SALESFORCE') });
    const isolated = collect(ran.run.truth.isolated).filter(
      (entry) => entry.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE',
    );
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0]?.address.rowNumberSource, 2);
  });

  it('allows the clear where there is nothing to clear, and still records it', () => {
    // Creating a record has no previous value to remove, so the authorization is
    // satisfied by the field having no value. The traceability keeps the fact
    // that the plan asked for it, which is what makes this different from the
    // field never having been mentioned.
    const ran = runCase('hubspot-create');
    assert.equal(
      collect(ran.run.truth.isolated).filter((entry) => entry.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE').length,
      0,
    );
    assert.deepEqual(delivered(ran, '1').clearedFields, ['contact.jobTitle']);
    assert.equal(ran.run.reconciliation.cells.clearedByExplicitAuthorization, 1);

    const table = readTable(ran.packageDir, '01_IMPORT/hubspot/contacts.csv');
    const ada = table.rows.find((row) => row['First name'] === 'Ada');
    assert.equal(ada?.['Job title'], '', 'HubSpot has no spelling for a clear, so a created record simply has none');
  });
});

describe('the clear token is never confused with data', () => {
  it('refuses a source value that is exactly the token', () => {
    // Escaping would make the file format depend on the data it carries, and a
    // reader would need to know the escaping rule to tell an instruction from a
    // value. Refusing the record is exact.
    const ran = runCase('clean-only', {
      inputDir: join(FIXTURES, 'collision', 'input'),
      scratchName: 'collision',
    });
    const isolated = collect(ran.run.truth.isolated).filter(
      (entry) => entry.reasonCode === 'TARGET_CLEAR_TOKEN_COLLISION',
    );
    assert.equal(isolated.length, 1);
    assert.equal(isolated[0]?.field, 'contact.jobTitle');
    assert.equal(ran.run.reconciliation.records.deliveredTotal, 0);
  });
});

describe('rows proven to be one record may disagree about a clear', () => {
  it('sets the record aside rather than picking a winner', () => {
    // One row authorizes emptying the field and another carries a value. Taking
    // the value is the non-destruction rule read backwards; taking the clear
    // destroys a value nobody authorized destroying. There is no safe automatic
    // answer, so the record is isolated and both instructions are preserved.
    const configPath = join(FIXTURES, 'clean-only.json');
    const loaded = loadConfig(readFileSync(configPath, 'utf8'), configPath);
    const run = runMigration({
      scratch: caseScratch('valueintent2'),
      inputRoot: join(FIXTURES, 'merge', 'input'),
      config: loaded.config,
      configHash: loaded.configHash,
    });

    const conflicts = run.truth.merges.flatMap((merge) =>
      merge.conflicts.filter((conflict) => conflict.reasonCode === 'IDENTITY_MERGE_CLEAR_CONFLICT'),
    );
    assert.equal(conflicts.length, 1, 'the disagreement is recorded as a conflict, not resolved silently');
    assert.equal(conflicts[0]?.destinationField, 'contact.jobTitle');

    const isolated = collect(run.truth.isolated).filter((entry) => entry.reasonCode === 'ISOLATED_IDENTITY_CONFLICT');
    assert.equal(isolated.length, 1);
    assert.equal(run.reconciliation.records.deliveredTotal, 0);
  });
});

describe('the transformation chokepoint will not let an intent drift from its outcome', () => {
  it('derives every intent in one place, from the outcome and the two values', () => {
    const cleared = makeTransformResult({
      kind: 'CLEAR_EXPLICIT',
      original: 'N/A',
      final: null,
      reasonCode: 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION',
      transformationId: 'test',
      transformationVersion: '1.0.0',
      safetyClass: 'DESTRUCTIVE_EXPLICITLY_AUTHORIZED',
    });
    assert.equal(cleared.intent.kind, 'CLEAR');

    const preserved = makeTransformResult({
      kind: 'UNCHANGED',
      original: 'Engineer',
      final: 'Engineer',
      reasonCode: 'TRANSFORM_UNCHANGED',
      transformationId: 'test',
      transformationVersion: '1.0.0',
    });
    assert.equal(preserved.intent.kind, 'PRESERVE');

    const blank = makeTransformResult({
      kind: 'UNCHANGED',
      original: '',
      final: '',
      reasonCode: 'TRANSFORM_UNCHANGED',
      transformationId: 'test',
      transformationVersion: '1.0.0',
    });
    assert.equal(blank.intent.kind, 'OMIT');
    assert.equal(blank.intent.kind === 'OMIT' ? blank.intent.reason : null, 'SOURCE_CELL_BLANK');

    const absent = makeTransformResult({
      kind: 'UNCHANGED',
      original: null,
      final: null,
      reasonCode: 'TRANSFORM_UNCHANGED',
      transformationId: 'test',
      transformationVersion: '1.0.0',
    });
    assert.equal(absent.intent.kind === 'OMIT' ? absent.intent.reason : null, 'SOURCE_CELL_ABSENT');
  });

  it('refuses to build a clear that nothing authorized', () => {
    // CLEAR_EXPLICIT without the destructive safety class is an engine defect,
    // and it raises rather than quietly emptying a cell.
    assert.throws(() =>
      makeTransformResult({
        kind: 'CLEAR_EXPLICIT',
        original: 'N/A',
        final: null,
        reasonCode: 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION',
        transformationId: 'test',
        transformationVersion: '1.0.0',
      }),
    );
  });

  it('refuses to empty a populated cell under any other outcome', () => {
    assert.throws(() =>
      makeTransformResult({
        kind: 'CHANGED_SAFE',
        original: 'Engineer',
        final: null,
        reasonCode: 'TRANSFORM_UNCHANGED',
        transformationId: 'test',
        transformationVersion: '1.0.0',
      }),
    );
  });
});

describe('a clear that cannot be represented is a refusal, not a silent success', () => {
  it('never reports the record as delivered', () => {
    const ran = runCase('hubspot-update', { contract: contractFor('HUBSPOT') });
    const report = verifyPackage(ran.packageDir, { scratch: verifyScratch(ran.packageDir) });
    assert.deepEqual(
      report.problems,
      [],
      report.problems.map((problem) => `${problem.check}: ${problem.detail}`).join('; '),
    );

    const table = readTable(ran.packageDir, '01_IMPORT/hubspot/contacts.csv');
    assert.equal(
      table.rows.some((row) => row['First name'] === 'Ada'),
      false,
      'the isolated record must not appear in the import file at all',
    );
  });

  it('states the refusal in terms the operator can act on', () => {
    const ran = runCase('hubspot-update', { contract: contractFor('HUBSPOT') });
    const entry = collect(ran.run.truth.isolated).find(
      (item) => item.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE',
    );
    assert.ok(entry !== undefined);
    assert.ok(
      entry.detail.includes('contact.jobTitle') && entry.detail.includes('blank'),
      `the detail must name the field and say why: ${entry.detail}`,
    );
  });
});


describe('KEEP, SET, CLEAR and OMIT are four different effects', () => {
  // One file, one column, four rows, one plan. The expected effect of each row
  // is stated from the cell the row holds (test/fixtures/value-intent/four-effects):
  //
  //   1  "Engineer"  the source value, untouched          KEEP  (PRESERVE)
  //   2  "sr"        an exact value map, "sr" -> "Senior"  SET
  //   3  "N/A"       an authorized clearing value          CLEAR
  //   4  ""          a blank cell                          OMIT
  const inputDir = join(FIXTURES, 'four-effects', 'input');
  const jobTitleChange = (ran: Ran, row: number) =>
    collect(ran.run.truth.changes).filter(
      (change) => change.destinationField === 'contact.jobTitle' && change.address.rowNumberSource === row + 1,
    );

  it('[S029] KEEP, SET, CLEAR and OMIT over empty values in one UPDATE give four distinct effects, and an unsupported CLEAR is blocked', () => {
    // Where the destination can express a clear, all four effects are visible
    // in the import file and no two of them are spelled alike.
    const clean = runCase('four-effects-clean', { inputDir, scratchName: 'four-effects-clean' });
    assert.equal(clean.run.reconciliation.records.deliveredTotal, 4);
    const kept = delivered(clean, '1');
    const set = delivered(clean, '2');
    const cleared = delivered(clean, '3');
    const omitted = delivered(clean, '4');
    assert.equal(kept.values['contact.jobTitle'], 'Engineer');
    assert.equal(set.values['contact.jobTitle'], 'Senior');
    assert.equal(Object.hasOwn(cleared.values, 'contact.jobTitle'), false);
    assert.deepEqual(cleared.clearedFields, ['contact.jobTitle']);
    assert.equal(Object.hasOwn(omitted.values, 'contact.jobTitle'), false);
    assert.deepEqual(omitted.clearedFields, [], 'a blank cell is not a clear');
    for (const record of [kept, set, omitted]) assert.deepEqual(record.clearedFields, []);

    // KEEP is not a change; SET is, and names both values; CLEAR is a change
    // with its own reason; OMIT leaves nothing behind at all.
    assert.deepEqual(jobTitleChange(clean, 1), []);
    const setChange = jobTitleChange(clean, 2);
    assert.equal(setChange.length, 1);
    assert.equal(setChange[0]?.originalValue, 'sr');
    assert.equal(setChange[0]?.finalValue, 'Senior');
    const clearChange = jobTitleChange(clean, 3);
    assert.equal(clearChange.length, 1);
    assert.equal(clearChange[0]?.reasonCode, 'TRANSFORM_CLEARED_BY_EXPLICIT_AUTHORIZATION');
    assert.deepEqual(jobTitleChange(clean, 4), []);

    const table = readTable(clean.packageDir, '01_IMPORT/clean-only/contacts.csv');
    const cell = (first: string) => table.rows.find((row) => row['contact.firstName'] === first)?.['contact.jobTitle'];
    const token = getAdapter('CLEAN_ONLY').clearRepresentation;
    assert.equal(token.kind, 'EXPLICIT_TOKEN');
    const clearToken = token.kind === 'EXPLICIT_TOKEN' ? token.token : null;
    assert.equal(cell('Keep'), 'Engineer');
    assert.equal(cell('Set'), 'Senior');
    assert.equal(cell('Clear'), clearToken);
    assert.equal(cell('Omit'), '');
    assert.equal(new Set(['Keep', 'Set', 'Clear', 'Omit'].map(cell)).size, 4, 'four effects, four different cells');

    // HubSpot cannot be told to clear a property from an import file, so the
    // one row that asks for it is set aside with its reason, and the other
    // three are delivered as they were.
    const hubspot = runCase('four-effects-hubspot', {
      inputDir,
      contract: contractFor('HUBSPOT'),
      scratchName: 'four-effects-hubspot',
    });
    const blocked = collect(hubspot.run.truth.isolated).filter((entry) => entry.reasonCode === 'TARGET_CLEAR_NOT_REPRESENTABLE');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]?.address.rowNumberSource, 4);
    assert.equal(blocked[0]?.field, 'contact.jobTitle');
    assert.equal(hubspot.run.reconciliation.records.deliveredTotal, 3);
    assert.equal(delivered(hubspot, '1').values['contact.jobTitle'], 'Engineer');
    assert.equal(delivered(hubspot, '2').values['contact.jobTitle'], 'Senior');
    assert.equal(Object.hasOwn(delivered(hubspot, '4').values, 'contact.jobTitle'), false);
    assert.deepEqual(delivered(hubspot, '4').clearedFields, []);
    assert.equal(
      collect(hubspot.run.truth.deliveredRecords).some((record) => record.sourceRecordId === '3'),
      false,
      'the blocked clear is not delivered as though it had been carried out',
    );
  });
});
