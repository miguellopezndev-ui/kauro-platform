import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isMigrationError } from '../src/domain/errors.js';
import type { MigrationConfig } from '../src/domain/config.js';
import type { SemanticType } from '../src/domain/canonical.js';
import type { JsonObject } from '../src/util/json.js';
import { preserve } from '../src/domain/value-intent.js';
import { loadConfig } from '../src/mapping/load-config.js';
import { runMigration } from '../src/run/run-migration.js';
import type { RunResult } from '../src/run/run-migration.js';
import { instanceFinding, instanceVocabulary } from '../src/run/validate-destination.js';
import { hashTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetContract, TargetFieldContract, TargetFlag, TargetPicklistValue } from '../src/target/contract.js';
import { writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import { attestContract, fixtureField, fixtureObjects } from '../tools/attestation-fixture.js';
import { caseScratch, repoRoot, scratchDir, verifyScratch } from './support/harness.js';

/**
 * Reinicio audit findings R-MC-TYPE and R-MC-ENUM (WO-MC-TARGET-20260915-01):
 * the destination-permission boundary of the attested instance.
 *
 * The frozen main authorised an arbitrary TEXT write into a field whose type
 * token this engine has not implemented (`time`, `future_scalar`), and took
 * every source value into a restricted enumeration with no eligible option,
 * and both packages verified. The rule under test is one rule, stated over
 * varied target names, type tokens, source values and eligibility states, on
 * both CRM modes, through the public boundary the audit exercised:
 * runMigration -> writePackage -> verifyPackage.
 *
 *   - An unknown or unimplemented destination type authorises no write.
 *   - Admitted string aliases and implemented compatible scalar paths deliver.
 *   - A known empty restricted vocabulary admits no nonempty value.
 *   - A vocabulary nobody established (no options, restriction UNKNOWN) admits
 *     nothing; source allowedValues never establish target eligibility.
 *   - Inactive options remain ineligible; active permitted values deliver.
 *   - A partly eligible ordinary vocabulary keeps its admitted records.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'target-boundary');
const INPUT = join(FIXTURES, 'input');

type Mode = 'HUBSPOT' | 'SALESFORCE';
const MODES: readonly Mode[] = ['HUBSPOT', 'SALESFORCE'];

const option = (value: string, active = true, label = value): TargetPicklistValue => ({ value, label, active, defaultValue: false });

/** A synthetic instance of `mode` whose contact object also declares `extra`. */
function contractWith(mode: Mode, extra: TargetFieldContract): HashedTargetContract {
  const contactName = mode === 'HUBSPOT' ? 'contact' : 'Contact';
  const objects = fixtureObjects(mode).map((object) =>
    object.apiName === contactName ? { ...object, fields: [...object.fields, extra] } : object,
  );
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: {
      mode,
      instanceId: mode === 'HUBSPOT' ? '00000001' : '00D000000000001',
      instanceLabel: 'target boundary fixture instance',
      evidence: 'ARTIFACT',
    },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'b'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects,
    pipelines: [],
  };
  return hashTargetContract(contract);
}

interface Plan {
  readonly config: MigrationConfig;
  readonly configHash: string;
  readonly normalizedJson: JsonObject;
}

/** A CREATE_ONLY plan of `mode` that delivers `column` to `custom:<label>` as `semanticType`. */
function planFor(mode: Mode, label: string, semanticType: SemanticType, column = 'Status', options: Record<string, unknown> = {}): Plan {
  const raw = {
    configVersion: '3.0.0',
    source: { system: 'legacy_crm', namespace: 'target-boundary' },
    target: { mode, importMode: 'CREATE_ONLY' },
    destinationMatching: [],
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Contact ID' },
        fields: [
          { column: { header: 'First Name' }, destinationField: 'contact.firstName', semanticType: 'TEXT' },
          { column: { header: 'Last Name' }, destinationField: 'contact.lastName', semanticType: 'TEXT' },
          { column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
          { column: { header: column }, destinationField: `custom:${label}`, semanticType, ...(Object.keys(options).length === 0 ? {} : { options }) },
        ],
      },
    ],
  };
  const loaded = loadConfig(JSON.stringify(raw), join(FIXTURES, `${mode.toLowerCase()}-${label}.json`));
  return { config: loaded.config, configHash: loaded.configHash, normalizedJson: loaded.normalizedJson };
}

interface Observed {
  readonly accepted: boolean;
  readonly code: string | null;
  readonly message: string;
  /** source record id -> the value delivered to the custom field, for every delivered record. */
  readonly delivered: ReadonlyMap<string, string | undefined>;
  readonly isolated: readonly { sourceRecordId: string; reasonCode: string; field: string | null }[];
  /** The emitted import file, when a package was written. */
  readonly csv: string | null;
  readonly verified: boolean | null;
}

let counter = 0;

/** Run the plan against the contract through the public boundary and report what came out, or what was refused. */
function observe(mode: Mode, plan: Plan, contract: HashedTargetContract, label: string): Observed {
  counter += 1;
  let result: RunResult;
  try {
    result = runMigration({
      inputRoot: INPUT,
      config: plan.config,
      configHash: plan.configHash,
      scratch: caseScratch(`target-boundary-${String(counter)}`),
      targetContract: contract,
      ...attestContract(contract),
    });
  } catch (error: unknown) {
    if (!isMigrationError(error)) throw error;
    return { accepted: false, code: error.code, message: error.message, delivered: new Map(), isolated: [], csv: null, verified: null };
  }
  const packageDir = scratchDir('target-boundary', `package-${String(counter)}`);
  writeAndPromotePackage({ result, config: plan.config, normalizedConfig: plan.normalizedJson, outputDir: packageDir, force: true });
  const report = verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
  const csvPath =
    mode === 'HUBSPOT' ? join(packageDir, '01_IMPORT', 'hubspot', 'contacts.csv') : join(packageDir, '01_IMPORT', 'salesforce', 'Contact.csv');
  return {
    accepted: true,
    code: null,
    message: '',
    delivered: new Map([...result.truth.deliveredRecords].map((record) => [record.sourceRecordId ?? '', record.values[`custom:${label}`]])),
    isolated: [...result.truth.isolated].map((entry) => ({
      sourceRecordId: String(entry.address.rowNumberSource - 1),
      reasonCode: entry.reasonCode,
      field: entry.field,
    })),
    csv: readFileSync(csvPath, 'utf8'),
    verified: report.passed,
  };
}

/** Every value the emitted file carries in the column headed `header`. */
function columnOf(csv: string, header: string): string[] {
  const lines = csv.trimEnd().split('\n');
  const index = (lines[0] ?? '').split(',').indexOf(header);
  assert.ok(index >= 0, `column ${header} in ${lines[0] ?? ''}`);
  return lines.slice(1).map((line) => line.split(',')[index] ?? '');
}

/** The value a record carries must never reach the file: refusing the plan and withholding the field are both that. */
function assertNothingWritten(observed: Observed, label: string, values: readonly string[]): void {
  if (!observed.accepted) {
    assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN', observed.message);
    assert.ok(observed.message.includes(label), observed.message);
    return;
  }
  for (const value of observed.delivered.values()) assert.equal(value, undefined, `delivered ${String(value)} to custom:${label}`);
  const emitted = observed.csv === null ? [] : columnOf(observed.csv, label);
  for (const value of values) assert.ok(!emitted.includes(value), `${value} reached the file under ${label}`);
  assert.equal(observed.verified, true);
}

describe('R-MC-TYPE: an unknown or unimplemented destination type authorises no write', () => {
  const unknownTokens: Readonly<Record<Mode, readonly string[]>> = {
    SALESFORCE: ['time', 'future_scalar', 'anyType', 'location', 'address', 'base64', 'json'],
    HUBSPOT: ['object_coordinates', 'json', 'future_scalar', 'vendor_specific_token', ''],
  };

  for (const mode of MODES) {
    for (const type of unknownTokens[mode]) {
      it(`${mode}: TEXT into a "${type}" field is refused before any record, and no value reaches the file`, () => {
        const label = mode === 'HUBSPOT' ? 'start_x' : 'Start__c';
        const observed = observe(mode, planFor(mode, label, 'TEXT'), contractWith(mode, fixtureField(label, 'Start', type)), label);
        assert.equal(observed.accepted, false);
        assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN', observed.message);
        assert.ok(observed.message.includes(`type "${type}"`), observed.message);
        assert.ok(observed.message.includes(label), observed.message);
      });
    }

    it(`${mode}: the refusal is the destination's type, not the plan's — every semantic type is refused into an unknown token`, () => {
      const label = mode === 'HUBSPOT' ? 'when_x' : 'When__c';
      for (const [semanticType, column] of [['NUMBER', 'Score'], ['ENUM', 'Status'], ['IDENTIFIER', 'Contact ID']] as const) {
        const options = semanticType === 'ENUM' ? { allowedValues: ['Active', 'Inactive', 'Archived'] } : {};
        const observed = observe(mode, planFor(mode, label, semanticType, column, options), contractWith(mode, fixtureField(label, 'When', 'time')), label);
        assert.equal(observed.accepted, false, semanticType);
        assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN', observed.message);
      }
    });

    it(`${mode}: the token is read case- and whitespace-insensitively, as the family table always was`, () => {
      const label = mode === 'HUBSPOT' ? 'note_x' : 'Note__c';
      const observed = observe(mode, planFor(mode, label, 'TEXT'), contractWith(mode, fixtureField(label, 'Note', ' String ')), label);
      assert.equal(observed.accepted, true, observed.message);
      assert.equal(observed.verified, true);
    });
  }
});

describe('R-MC-TYPE controls: admitted string aliases and implemented scalar paths still deliver', () => {
  const textTokens: Readonly<Record<Mode, readonly string[]>> = {
    SALESFORCE: ['string', 'textarea', 'encryptedstring', 'picklist'],
    HUBSPOT: ['string', 'text'],
  };
  const numberTokens: Readonly<Record<Mode, readonly string[]>> = {
    SALESFORCE: ['double', 'currency', 'percent'],
    HUBSPOT: ['number'],
  };

  for (const mode of MODES) {
    for (const type of textTokens[mode]) {
      it(`${mode}: TEXT reaches a "${type}" field and the package verifies`, () => {
        const label = mode === 'HUBSPOT' ? 'status_x' : 'Status__c';
        const observed = observe(mode, planFor(mode, label, 'TEXT'), contractWith(mode, fixtureField(label, 'Status', type)), label);
        assert.equal(observed.accepted, true, observed.message);
        assert.equal(observed.delivered.get('1'), 'Active');
        assert.equal(observed.delivered.get('2'), 'Inactive');
        assert.equal(observed.delivered.get('5'), 'Archived');
        assert.deepEqual(columnOf(observed.csv ?? '', label).sort(), ['', 'Active', 'Active', 'Archived', 'Inactive']);
        assert.equal(observed.verified, true);
      });
    }

    for (const type of numberTokens[mode]) {
      it(`${mode}: NUMBER reaches a "${type}" field and the package verifies`, () => {
        const label = mode === 'HUBSPOT' ? 'score_x' : 'Score__c';
        const observed = observe(mode, planFor(mode, label, 'NUMBER', 'Score'), contractWith(mode, fixtureField(label, 'Score', type)), label);
        assert.equal(observed.accepted, true, observed.message);
        assert.equal(observed.delivered.size, 5);
        assert.deepEqual(columnOf(observed.csv ?? '', label).sort(), ['10', '20.5', '30', '40', '50']);
        assert.equal(observed.verified, true);
      });
    }

    it(`${mode}: a DATE into a datetime field is ${mode === 'HUBSPOT' ? 'the one qualified widening' : 'refused: nothing qualifies it, and no time or zone is invented'}`, () => {
      const label = mode === 'HUBSPOT' ? 'signed_x' : 'Signed__c';
      const observed = observe(
        mode,
        planFor(mode, label, 'DATE', 'Status', { dateFormat: 'ISO_8601' }),
        contractWith(mode, fixtureField(label, 'Signed', 'datetime')),
        label,
      );
      if (mode === 'HUBSPOT') {
        assert.equal(observed.accepted, true, observed.message);
      } else {
        assert.equal(observed.accepted, false);
        assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN', observed.message);
        assert.ok(observed.message.includes('as DATE'), observed.message);
      }
    });

    it(`${mode}: TEXT into a number field stays refused (the type check itself is unchanged)`, () => {
      const label = mode === 'HUBSPOT' ? 'score_x' : 'Score__c';
      const observed = observe(mode, planFor(mode, label, 'TEXT'), contractWith(mode, fixtureField(label, 'Score', mode === 'HUBSPOT' ? 'number' : 'double')), label);
      assert.equal(observed.accepted, false);
      assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN');
    });
  }
});

describe('R-MC-ENUM: the eligibility set is the contract\'s, and empty or unknown admits nothing', () => {
  const enumType = (mode: Mode): string => (mode === 'HUBSPOT' ? 'enumeration' : 'picklist');
  const label = (mode: Mode): string => (mode === 'HUBSPOT' ? 'stage_x' : 'Stage__c');
  const SOURCE_VALUES = ['Active', 'Inactive', 'Archived'];
  const allowed = { allowedValues: SOURCE_VALUES };

  const enumField = (mode: Mode, restricted: TargetFlag, values: readonly TargetPicklistValue[], type = enumType(mode)): TargetFieldContract =>
    fixtureField(label(mode), 'Stage', type, { restrictedPicklist: restricted, picklistValues: values });

  for (const mode of MODES) {
    it(`${mode}: a restricted vocabulary with no option admits no nonempty value, whatever the source allows`, () => {
      for (const semanticType of ['ENUM', 'TEXT'] as const) {
        const options = semanticType === 'ENUM' ? allowed : {};
        const observed = observe(mode, planFor(mode, label(mode), semanticType, 'Status', options), contractWith(mode, enumField(mode, 'TRUE', [])), label(mode));
        assertNothingWritten(observed, label(mode), SOURCE_VALUES);
        assert.equal(observed.accepted, false, `${semanticType}: a field no value is eligible for is a plan to change`);
        assert.ok(observed.message.includes('no option'), observed.message);
      }
    });

    it(`${mode}: a restricted vocabulary whose every option is inactive admits no nonempty value`, () => {
      const observed = observe(
        mode,
        planFor(mode, label(mode), 'ENUM', 'Status', allowed),
        contractWith(mode, enumField(mode, 'TRUE', [option('Active', false), option('Inactive', false)])),
        label(mode),
      );
      assertNothingWritten(observed, label(mode), SOURCE_VALUES);
      // Options were captured, so this is a value-level fact: the record with no value for the field is still delivered.
      assert.equal(observed.accepted, true, observed.message);
      assert.deepEqual([...observed.delivered.keys()], ['4']);
      assert.deepEqual(
        observed.isolated.filter((entry) => entry.reasonCode === 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN').map((entry) => entry.sourceRecordId).sort(),
        ['1', '2', '3', '5'],
      );
    });

    it(`${mode}: a vocabulary field with no captured option and restriction UNKNOWN is not established, and admits nothing`, () => {
      for (const type of [enumType(mode), mode === 'HUBSPOT' ? 'enumeration' : 'multipicklist', mode === 'HUBSPOT' ? 'enumeration' : 'combobox']) {
        const observed = observe(mode, planFor(mode, label(mode), 'ENUM', 'Status', allowed), contractWith(mode, enumField(mode, 'UNKNOWN', [], type)), label(mode));
        assertNothingWritten(observed, label(mode), SOURCE_VALUES);
        assert.equal(observed.accepted, false, type);
        assert.ok(observed.message.includes('not established'), observed.message);
      }
    });

    it(`${mode}: a field the contract marks restricted with no option is refused even under a non-vocabulary type token`, () => {
      const observed = observe(mode, planFor(mode, label(mode), 'TEXT'), contractWith(mode, enumField(mode, 'TRUE', [], 'string')), label(mode));
      assert.equal(observed.accepted, false, observed.message);
      assert.equal(observed.code, 'DESTINATION_FIELD_UNKNOWN');
    });

    it(`${mode}: a vocabulary field the instance states is unrestricted, with no captured option, takes the value (unchanged fixture semantics)`, () => {
      const observed = observe(mode, planFor(mode, label(mode), 'ENUM', 'Status', allowed), contractWith(mode, enumField(mode, 'FALSE', [])), label(mode));
      assert.equal(observed.accepted, true, observed.message);
      assert.equal(observed.delivered.get('1'), 'Active');
      assert.equal(observed.verified, true);
    });

    it(`${mode}: an inactive option is ineligible while active permitted values are delivered (positive control)`, () => {
      const observed = observe(
        mode,
        planFor(mode, label(mode), 'ENUM', 'Status', allowed),
        contractWith(mode, enumField(mode, 'TRUE', [option('Active'), option('Inactive', false), option('Archived')])),
        label(mode),
      );
      assert.equal(observed.accepted, true, observed.message);
      assert.equal(observed.delivered.get('1'), 'Active');
      assert.equal(observed.delivered.get('3'), 'Active');
      assert.equal(observed.delivered.get('5'), 'Archived');
      assert.equal(observed.delivered.get('4'), undefined, 'a record with no value carries none');
      assert.equal(observed.delivered.has('2'), false, 'Inactive is declared and inactive');
      assert.deepEqual(
        observed.isolated.filter((entry) => entry.reasonCode === 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN'),
        [{ sourceRecordId: '2', reasonCode: 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN', field: `custom:${label(mode)}` }],
      );
      assert.deepEqual(columnOf(observed.csv ?? '', label(mode)).sort(), ['', 'Active', 'Active', 'Archived']);
      assert.equal(observed.verified, true);
    });

    it(`${mode}: a partly eligible ordinary vocabulary keeps its admitted records and withholds the rest`, () => {
      for (const restricted of ['TRUE', 'FALSE', 'UNKNOWN'] as const) {
        const observed = observe(mode, planFor(mode, label(mode), 'ENUM', 'Status', allowed), contractWith(mode, enumField(mode, restricted, [option('Active')])), label(mode));
        assert.equal(observed.accepted, true, `${restricted}: ${observed.message}`);
        assert.deepEqual([...observed.delivered.keys()].sort(), ['1', '3', '4'], restricted);
        assert.deepEqual(columnOf(observed.csv ?? '', label(mode)).sort(), ['', 'Active', 'Active'], restricted);
        assert.equal(observed.verified, true, restricted);
      }
    });

    // This case asserted the opposite until the permission rule was completed:
    // a source value equal to an option's display label was delivered as that
    // label, a string the instance does not store. The requirement now is that
    // labels and source allowedValues grant nothing; only an option's value does.
    it(`${mode}: an option's display label admits nothing, and source allowedValues admit nothing of their own`, () => {
      const observed = observe(
        mode,
        planFor(mode, label(mode), 'ENUM', 'Status', allowed),
        contractWith(mode, enumField(mode, 'TRUE', [option('act', true, 'Active')])),
        label(mode),
      );
      assert.equal(observed.accepted, true, observed.message);
      assert.deepEqual([...observed.delivered.keys()].sort(), ['4'], 'only the record with no value for the field is delivered');
      assert.equal(observed.delivered.get('4'), undefined);
      const byLabel = observed.isolated.filter((entry) => entry.reasonCode === 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
      assert.deepEqual(byLabel.map((entry) => entry.sourceRecordId).sort(), ['1', '2', '3', '5']);
      assert.ok(!columnOf(observed.csv ?? '', label(mode)).includes('Active'), 'the label never reaches the file');
      assert.equal(observed.verified, true);
    });

    it(`${mode}: the option's own value is delivered (positive control for the label case)`, () => {
      const observed = observe(
        mode,
        planFor(mode, label(mode), 'ENUM', 'Status', allowed),
        contractWith(mode, enumField(mode, 'TRUE', [option('Active', true, 'Shown as active'), option('Archived')])),
        label(mode),
      );
      assert.equal(observed.accepted, true, observed.message);
      assert.equal(observed.delivered.get('1'), 'Active');
      assert.equal(observed.delivered.get('5'), 'Archived');
      assert.equal(observed.verified, true);
    });
  }
});

describe('the vocabulary of a field, at the rule itself', () => {
  const field = (type: string, restricted: TargetFlag, values: readonly TargetPicklistValue[]): TargetFieldContract =>
    fixtureField('x', 'x', type, { restrictedPicklist: restricted, picklistValues: values });

  it('captured options are KNOWN, whatever the type token or restriction says', () => {
    for (const type of ['enumeration', 'picklist', 'string', 'bool', 'future_scalar']) {
      for (const restricted of ['TRUE', 'FALSE', 'UNKNOWN'] as const) {
        const vocabulary = instanceVocabulary(field(type, restricted, [option('a'), option('b', false)]));
        assert.equal(vocabulary.kind, 'KNOWN');
        if (vocabulary.kind === 'KNOWN') assert.deepEqual(vocabulary.active.map((entry) => entry.value), ['a']);
      }
    }
  });

  it('no options: a vocabulary type is EMPTY when restricted, OPEN when not, UNKNOWN when nobody said', () => {
    for (const type of ['picklist', 'multipicklist', 'combobox', 'enumeration', 'Enumeration', ' PICKLIST ']) {
      assert.equal(instanceVocabulary(field(type, 'TRUE', [])).kind, 'EMPTY', type);
      assert.equal(instanceVocabulary(field(type, 'FALSE', [])).kind, 'OPEN', type);
      assert.equal(instanceVocabulary(field(type, 'UNKNOWN', [])).kind, 'UNKNOWN', type);
    }
  });

  it('no options on a non-vocabulary type is NONE unless the contract states a restriction', () => {
    for (const type of ['string', 'number', 'bool', 'date', 'time', 'future_scalar']) {
      assert.equal(instanceVocabulary(field(type, 'FALSE', [])).kind, 'NONE', type);
      assert.equal(instanceVocabulary(field(type, 'UNKNOWN', [])).kind, 'NONE', type);
      assert.equal(instanceVocabulary(field(type, 'TRUE', [])).kind, 'EMPTY', type);
    }
  });

  it('instanceFinding withholds every nonempty value from an EMPTY or UNKNOWN vocabulary, and none from OPEN or NONE', () => {
    const plan = (contract: TargetFieldContract): Parameters<typeof instanceFinding>[1] => ({
      object: { apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', fields: [contract], recordTypes: [] },
      fields: [{ destinationField: 'custom:x', field: contract }],
      requiredOnCreate: [],
    });
    const record = (value: string): Parameters<typeof instanceFinding>[0] => ({ values: new Map([['custom:x', { intent: preserve(value) }]]) });
    for (const contract of [field('picklist', 'TRUE', []), field('enumeration', 'UNKNOWN', []), field('string', 'TRUE', [])]) {
      const finding = instanceFinding(record('Active'), plan(contract), true);
      assert.equal(finding?.reasonCode, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN', contract.type);
      assert.equal(finding?.field, 'custom:x');
    }
    for (const contract of [field('picklist', 'FALSE', []), field('string', 'FALSE', []), field('string', 'UNKNOWN', [])]) {
      assert.equal(instanceFinding(record('Active'), plan(contract), true), null, contract.type);
    }
    assert.equal(instanceFinding(record('b'), plan(field('picklist', 'TRUE', [option('a'), option('b', false)])), true)?.reasonCode, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
    assert.equal(instanceFinding(record('a'), plan(field('picklist', 'TRUE', [option('a'), option('b', false)])), true), null);
  });
});
