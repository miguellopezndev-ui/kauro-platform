import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getAdapter } from '../src/adapters/specs.js';
import { isMigrationError } from '../src/domain/errors.js';
import type { MigrationConfig, TargetMode } from '../src/domain/config.js';
import type { ImportMode } from '../src/domain/canonical.js';
import type { JsonObject } from '../src/util/json.js';
import { preserve } from '../src/domain/value-intent.js';
import { loadConfig } from '../src/mapping/load-config.js';
import { runMigration } from '../src/run/run-migration.js';
import type { RunInput, RunResult } from '../src/run/run-migration.js';
import { instanceFinding, instancePlan } from '../src/run/validate-destination.js';
import { hashTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetContract, TargetFieldContract, TargetObjectContract } from '../src/target/contract.js';
import { HUBSPOT_INTERNAL_NAMES, instanceFieldNames, resolveInstanceField } from '../src/target/instance-fields.js';
import { writeAndPromotePackage } from '../src/artifacts/write-package.js';
import { verifyPackage } from '../src/verify/verify-package.js';
import { attestContract, fixtureField, fixtureObjects } from '../tools/attestation-fixture.js';
import { caseScratch, repoRoot, scratchDir, verifyScratch } from './support/harness.js';

/**
 * MC-3 reopen, validation lot: audit KAURO_AUDITORIA_MC_IC_20260911_V1 finding
 * MC-04 (destination validation ignores the attested instance's facts).
 *
 * The four audit cases (MC-instance-readonly-field, -missing-field,
 * -unknown-custom, -tiny-length) were all delivered and verified on the frozen
 * main. Here each is refused or isolated under a typed code, and a genuine
 * contract describing the instance the plan writes to still runs, per property
 * and per import mode.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');
const INPUT = join(FIXTURES, 'input');

type FieldEdit = (field: TargetFieldContract) => TargetFieldContract;

interface ContractOptions {
  readonly edit?: Readonly<Record<string, FieldEdit>>;
  readonly drop?: readonly string[];
  readonly add?: readonly TargetFieldContract[];
  readonly objects?: (objects: TargetObjectContract[]) => TargetObjectContract[];
}

/** A synthetic instance of `mode` that describes what the adapter can deliver, edited field by field. */
function contractOf(mode: 'HUBSPOT' | 'SALESFORCE', options: ContractOptions = {}): HashedTargetContract {
  const contactName = mode === 'HUBSPOT' ? 'contact' : 'Contact';
  let objects = fixtureObjects(mode).map((object) => {
    if (object.apiName !== contactName) return object;
    const fields = object.fields
      .filter((field) => !(options.drop ?? []).some((name) => name.toLowerCase() === field.apiName.toLowerCase()))
      .map((field) => {
        const edit = Object.entries(options.edit ?? {}).find(([name]) => name.toLowerCase() === field.apiName.toLowerCase());
        return edit === undefined ? field : edit[1](field);
      });
    return { ...object, fields: [...fields, ...(options.add ?? [])] };
  });
  if (options.objects !== undefined) objects = options.objects(objects);
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: {
      mode,
      instanceId: mode === 'HUBSPOT' ? '00000001' : '00D000000000001',
      instanceLabel: 'mc3 reopen validation fixture instance',
      evidence: 'ARTIFACT',
    },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects,
    pipelines: [],
  };
  return hashTargetContract(contract);
}

const emailName = (mode: TargetMode): string => (mode === 'HUBSPOT' ? 'email' : 'Email');
const jobTitleName = (mode: TargetMode): string => (mode === 'HUBSPOT' ? 'jobtitle' : 'Title');

/**
 * Matching on the email needs the instance to establish it unique (the
 * value-intent update plans match TARGET_UNIQUE_FIELD on "email"). Match
 * authority looks the declared targetField up by exact api name, so the
 * Salesforce field is spelled the way the fixture plan declares it; destination
 * validation itself resolves "Email" and "email" alike.
 */
const uniqueEmail: FieldEdit = (field) => ({ ...field, apiName: 'email', unique: 'TRUE', idLookup: 'TRUE' });

function loadAt(name: string, mutate: (raw: Record<string, unknown>) => void = () => {}): { config: MigrationConfig; configHash: string; normalizedJson: JsonObject } {
  const path = join(FIXTURES, `${name}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  const loaded = loadConfig(JSON.stringify(raw), path);
  return { config: loaded.config, configHash: loaded.configHash, normalizedJson: loaded.normalizedJson };
}

function withImportMode(raw: Record<string, unknown>, importMode: ImportMode): void {
  raw['target'] = { ...(raw['target'] as Record<string, unknown>), importMode };
}

function addField(raw: Record<string, unknown>, field: Record<string, unknown>): void {
  const records = raw['records'] as { fields: Record<string, unknown>[] }[];
  records[0]?.fields.push(field);
}

let counter = 0;
function inputFor(loaded: { config: MigrationConfig; configHash: string }, contract: HashedTargetContract | null, extra: Partial<RunInput> = {}): RunInput {
  counter += 1;
  const attested = contract === null ? {} : attestContract(contract);
  return {
    inputRoot: INPUT,
    config: loaded.config,
    configHash: loaded.configHash,
    scratch: caseScratch(`mc3validation${String(counter)}`),
    targetContract: contract,
    ...attested,
    ...extra,
  };
}

function refused(run: () => unknown, code: string, fragment?: string): void {
  assert.throws(run, (error: unknown) => {
    if (!isMigrationError(error)) return false;
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    if (fragment !== undefined) {
      assert.ok(
        error.message.includes(fragment) || error.remedy.includes(fragment),
        `expected a refusal mentioning "${fragment}", got: ${error.message}`,
      );
    }
    return true;
  });
}

function deliveredEmails(run: RunResult): string[] {
  return [...run.truth.deliveredRecords].map((record) => record.values['contact.email'] ?? '').sort();
}

/** Isolations under one code, naming each row by the source record id its row number carries (row 2 is id "1"). */
function isolatedBy(run: RunResult, code: string): { sourceRecordId: string; field: string | null; detail: string }[] {
  return [...run.truth.isolated]
    .filter((entry) => entry.reasonCode === code)
    .map((entry) => ({ sourceRecordId: String(entry.address.rowNumberSource - 1), field: entry.field, detail: entry.detail }));
}

/** Write and verify the package, so a finding that made the package unverifiable would show here. */
function verified(run: RunResult, loaded: { config: MigrationConfig; normalizedJson: JsonObject }): ReturnType<typeof verifyPackage> {
  counter += 1;
  const packageDir = scratchDir('mc3-reopen-validation', `package-${String(counter)}`);
  writeAndPromotePackage({ result: run, config: loaded.config, normalizedConfig: loaded.normalizedJson, outputDir: packageDir, force: true });
  return verifyPackage(packageDir, { scratch: verifyScratch(packageDir) });
}

const CRM_PLANS: readonly { name: string; mode: 'HUBSPOT' | 'SALESFORCE'; importMode: ImportMode }[] = [
  { name: 'hubspot-create', mode: 'HUBSPOT', importMode: 'CREATE_ONLY' },
  { name: 'hubspot-update', mode: 'HUBSPOT', importMode: 'UPDATE_ONLY' },
  { name: 'salesforce-update', mode: 'SALESFORCE', importMode: 'UPDATE_ONLY' },
];

describe('MC-04: the four audit cases are refused or isolated', () => {
  const loaded = loadAt('hubspot-create');

  it('positive control: the genuine instance delivers every contact with its email', () => {
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT')));
    assert.deepEqual(deliveredEmails(run), ['ada@example.com', 'alan@example.com', 'grace@example.com']);
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
  });

  it('MC-instance-readonly-field: email createable=FALSE updateable=FALSE is refused, nothing delivered', () => {
    const contract = contractOf('HUBSPOT', { edit: { email: (field) => ({ ...field, createable: 'FALSE', updateable: 'FALSE' }) } });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'does not establish contact.email as createable');
  });

  it('MC-instance-missing-field: a contract that does not carry the email field is refused', () => {
    const contract = contractOf('HUBSPOT', { drop: ['email'] });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'carries no contact field answering to "email"');
  });

  it('MC-instance-unknown-custom: a custom column the instance does not declare is not deliverable', () => {
    const withCustom = loadAt('hubspot-create', (raw) =>
      addField(raw, { column: { header: 'Job Title' }, destinationField: 'custom:Never_Declared_In_Contract', semanticType: 'TEXT' }),
    );
    refused(
      () => runMigration(inputFor(withCustom, contractOf('HUBSPOT'))),
      'DESTINATION_FIELD_UNKNOWN',
      'declares no contact property answering to "Never_Declared_In_Contract"',
    );
  });

  it('positive control for the custom case: the same column runs once the instance declares the property', () => {
    const withCustom = loadAt('hubspot-create', (raw) =>
      addField(raw, { column: { header: 'Job Title' }, destinationField: 'custom:Never_Declared_In_Contract', semanticType: 'TEXT' }),
    );
    const contract = contractOf('HUBSPOT', { add: [fixtureField('never_declared_in_contract', 'Never_Declared_In_Contract', 'string')] });
    const run = runMigration(inputFor(withCustom, contract));
    assert.equal(deliveredEmails(run).length, 3);
    assert.equal([...run.truth.deliveredRecords].find((record) => record.sourceRecordId === '3')?.values['custom:Never_Declared_In_Contract'], 'Engineer');
  });

  it('MC-instance-tiny-length: email length=3 isolates every record whose email is longer, preserved, and the package still verifies', () => {
    const contract = contractOf('HUBSPOT', { edit: { email: (field) => ({ ...field, length: 3 }) } });
    const run = runMigration(inputFor(loaded, contract));
    assert.deepEqual(deliveredEmails(run), []);
    const isolated = isolatedBy(run, 'DESTINATION_INSTANCE_VALUE_TOO_LONG');
    assert.deepEqual(isolated.map((entry) => entry.sourceRecordId).sort(), ['1', '2', '3']);
    for (const entry of isolated) {
      assert.equal(entry.field, 'contact.email');
      assert.ok(entry.detail.includes('length 3'), entry.detail);
    }
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
    assert.equal(run.reconciliation.sourceRows.byDisposition.ISOLATED, 3);
    const report = verified(run, loaded);
    assert.deepEqual(report.problems, []);
    assert.equal(report.passed, true);
  });

  it('a length the values respect delivers them (positive control for the length property)', () => {
    const contract = contractOf('HUBSPOT', { edit: { email: (field) => ({ ...field, length: 17 }) } });
    const run = runMigration(inputFor(loaded, contract));
    assert.deepEqual(deliveredEmails(run), ['ada@example.com', 'alan@example.com', 'grace@example.com']);
  });
});

describe('MC-04: writeability follows the import mode, and UNKNOWN never authorises', () => {
  for (const { name, mode, importMode } of CRM_PLANS) {
    const loaded = loadAt(name);
    const email = emailName(mode);
    const jobTitle = jobTitleName(mode);
    const creates = importMode === 'CREATE_ONLY';

    it(`${mode} ${importMode}: the genuine instance runs`, () => {
      const run = runMigration(inputFor(loaded, contractOf(mode, { edit: { [email]: uniqueEmail } })));
      assert.equal(run.reconciliation.sourceRows.equationHolds, true);
      assert.ok(deliveredEmails(run).length > 0);
    });

    it(`${mode} ${importMode}: ${creates ? 'createable' : 'updateable'} UNKNOWN on a delivered field refuses`, () => {
      const flag = creates ? 'createable' : 'updateable';
      const contract = contractOf(mode, { edit: { [email]: uniqueEmail, [jobTitle]: (field) => ({ ...field, [flag]: 'UNKNOWN' }) } });
      refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', `as ${flag} (reports UNKNOWN)`);
    });

    it(`${mode} ${importMode}: ${creates ? 'createable' : 'updateable'} FALSE on a delivered field refuses`, () => {
      const flag = creates ? 'createable' : 'updateable';
      const contract = contractOf(mode, { edit: { [email]: uniqueEmail, [jobTitle]: (field) => ({ ...field, [flag]: 'FALSE' }) } });
      refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', `as ${flag} (reports FALSE)`);
    });

    it(`${mode} ${importMode}: the operation this mode does not perform may be FALSE (positive control)`, () => {
      const other = creates ? 'updateable' : 'createable';
      const contract = contractOf(mode, { edit: { [email]: uniqueEmail, [jobTitle]: (field) => ({ ...field, [other]: 'FALSE' }) } });
      const run = runMigration(inputFor(loaded, contract));
      assert.ok(deliveredEmails(run).length > 0);
    });

    it(`${mode} ${importMode}: a formula field is refused however its flags read`, () => {
      const contract = contractOf(mode, { edit: { [email]: uniqueEmail, [jobTitle]: (field) => ({ ...field, calculated: 'TRUE' }) } });
      refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'formula field');
    });

    it(`${mode} ${importMode}: the object itself must be ${creates ? 'createable' : 'updateable'}`, () => {
      const flag = creates ? 'createable' : 'updateable';
      const contract = contractOf(mode, {
        edit: { [email]: uniqueEmail },
        objects: (objects) => objects.map((object) => (object.apiName.toLowerCase() === 'contact' ? { ...object, [flag]: 'UNKNOWN' as const } : object)),
      });
      refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_MODE_UNSUPPORTED', `as ${flag} (reports UNKNOWN)`);
    });
  }

  it('UPSERT needs both operations: createable FALSE refuses, updateable FALSE refuses, both TRUE runs', () => {
    const upsert = loadAt('hubspot-update', (raw) => withImportMode(raw, 'UPSERT'));
    const base = { email: uniqueEmail };
    const run = runMigration(inputFor(upsert, contractOf('HUBSPOT', { edit: base })));
    assert.ok(deliveredEmails(run).length > 0);
    refused(
      () => runMigration(inputFor(upsert, contractOf('HUBSPOT', { edit: { ...base, jobtitle: (field) => ({ ...field, createable: 'FALSE' }) } }))),
      'DESTINATION_FIELD_UNKNOWN',
      'as createable (reports FALSE)',
    );
    refused(
      () => runMigration(inputFor(upsert, contractOf('HUBSPOT', { edit: { ...base, jobtitle: (field) => ({ ...field, updateable: 'FALSE' }) } }))),
      'DESTINATION_FIELD_UNKNOWN',
      'as updateable (reports FALSE)',
    );
  });
});

describe('MC-04: object availability', () => {
  const loaded = loadAt('hubspot-create');

  it('a contract describing no CONTACT object is refused for a CONTACT mapping', () => {
    const contract = contractOf('HUBSPOT', { objects: (objects) => objects.filter((object) => object.apiName !== 'contact') });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_OBJECT_UNSUPPORTED', 'describes no CONTACT object');
  });

  it('a contract with objects: [] (the pre-repair fixture shape) is refused rather than delivered against', () => {
    const contract = contractOf('HUBSPOT', { objects: () => [] });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_OBJECT_UNSUPPORTED');
  });

  it('a contract describing CONTACT twice contradicts itself and is refused', () => {
    const contract = contractOf('HUBSPOT', {
      objects: (objects) => [...objects, { ...(objects.find((object) => object.apiName === 'contact') as TargetObjectContract), apiName: 'contacts' }],
    });
    refused(() => runMigration(inputFor(loaded, contract)), 'TARGET_CONTRACT_INVALID', '2 times');
  });

  it('a field of the same name on another object is not evidence about this one', () => {
    const contract = contractOf('HUBSPOT', {
      drop: ['email'],
      objects: (objects) =>
        objects.map((object) => (object.apiName === 'company' ? { ...object, fields: [...object.fields, fixtureField('email', 'Email', 'string')] } : object)),
    });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'carries no contact field');
  });
});

describe('MC-04: type compatibility', () => {
  const loaded = loadAt('hubspot-create');

  it('a TEXT column delivered to a number field is refused', () => {
    const contract = contractOf('HUBSPOT', { edit: { jobtitle: (field) => ({ ...field, type: 'number' }) } });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'as type "number"');
  });

  it('a TEXT column delivered to a bool or a date field is refused', () => {
    for (const type of ['bool', 'date', 'datetime']) {
      const contract = contractOf('HUBSPOT', { edit: { jobtitle: (field) => ({ ...field, type }) } });
      refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', `as type "${type}"`);
    }
  });

  it('an EMAIL column delivered to a Salesforce email field, and to a string field, runs (positive controls)', () => {
    const sf = loadAt('salesforce-update');
    for (const type of ['email', 'string', 'textarea']) {
      const run = runMigration(inputFor(sf, contractOf('SALESFORCE', { edit: { Email: (field) => ({ ...uniqueEmail(field), type }) } })));
      assert.ok(deliveredEmails(run).length > 0, type);
    }
  });

  it('a type token this engine cannot place authorises no write (reinicio R-MC-TYPE; this case previously asserted the opposite)', () => {
    const contract = contractOf('HUBSPOT', { edit: { jobtitle: (field) => ({ ...field, type: 'vendor_specific_token' }) } });
    refused(() => runMigration(inputFor(loaded, contract)), 'DESTINATION_FIELD_UNKNOWN', 'type "vendor_specific_token"');
  });
});

describe('MC-04: picklist vocabularies', () => {
  const loaded = loadAt('hubspot-create');
  const options = (...values: { value: string; label?: string; active?: boolean }[]): FieldEdit => (field) => ({
    ...field,
    type: 'enumeration',
    restrictedPicklist: 'TRUE',
    picklistValues: values.map((option) => ({ value: option.value, label: option.label ?? option.value, active: option.active ?? true, defaultValue: false })),
  });

  it('a value among the declared options is delivered (positive control)', () => {
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { jobtitle: options({ value: 'Engineer' }, { value: 'Analyst' }) } })));
    assert.equal([...run.truth.deliveredRecords].find((record) => record.sourceRecordId === '3')?.values['contact.jobTitle'], 'Engineer');
    assert.deepEqual(isolatedBy(run, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN'), []);
  });

  it('a value outside the declared options isolates the record, and is never mapped onto a nearby option', () => {
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { jobtitle: options({ value: 'engineer' }, { value: 'Analyst' }) } })));
    const isolated = isolatedBy(run, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
    assert.deepEqual(isolated.map((entry) => entry.sourceRecordId), ['3']);
    assert.equal(isolated[0]?.field, 'contact.jobTitle');
    assert.ok(isolated[0]?.detail.includes('"Engineer"'), isolated[0]?.detail);
    assert.equal([...run.truth.deliveredRecords].some((record) => record.values['contact.jobTitle'] !== undefined), false);
    assert.equal(run.reconciliation.sourceRows.equationHolds, true);
    const report = verified(run, loaded);
    assert.deepEqual(report.problems, []);
  });

  it('an option that is declared but inactive does not admit the value', () => {
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { jobtitle: options({ value: 'Engineer', active: false }) } })));
    assert.deepEqual(isolatedBy(run, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN').map((entry) => entry.sourceRecordId), ['3']);
  });

  // This case asserted that a display label admits the value "as the importer
  // would". No source in docs/SOURCE_REGISTRY.md establishes that, and the
  // package delivers the label, a string the instance does not store. The
  // completed permission rule (R-MC-ENUM) admits an active option's value only.
  it('an option label admits nothing: the value the instance stores is the option value', () => {
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { jobtitle: options({ value: 'eng', label: 'Engineer' }) } })));
    const isolated = isolatedBy(run, 'DESTINATION_INSTANCE_PICKLIST_VALUE_UNKNOWN');
    assert.deepEqual(isolated.map((entry) => entry.sourceRecordId), ['3']);
    assert.ok(isolated[0]?.detail.includes('display label of the option whose value is "eng"'), isolated[0]?.detail);
  });
});

describe('MC-04: fields the contract requires', () => {
  const required: FieldEdit = (field) => ({ ...field, nillable: 'FALSE' });

  it('CREATE_ONLY: a record with no value for a required mapped field is isolated; the others are delivered', () => {
    const loaded = loadAt('hubspot-create');
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { jobtitle: required } })));
    const isolated = isolatedBy(run, 'DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING');
    // Grace has an empty title; Ada's "N/A" is an authorised clear, which carries no value either.
    assert.deepEqual(isolated.map((entry) => entry.sourceRecordId).sort(), ['1', '2']);
    assert.equal(isolated[0]?.field, 'contact.jobTitle');
    assert.deepEqual(deliveredEmails(run), ['alan@example.com']);
    const report = verified(run, loaded);
    assert.deepEqual(report.problems, []);
  });

  it('CREATE_ONLY: a required field every record carries delivers every record (positive control)', () => {
    const loaded = loadAt('hubspot-create');
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { lastname: required } })));
    assert.equal(deliveredEmails(run).length, 3);
  });

  it('CREATE_ONLY: a required field the plan maps nothing to is a plan to change, refused before any record', () => {
    const loaded = loadAt('hubspot-create');
    const contract = contractOf('HUBSPOT', { edit: { phone: required } });
    refused(() => runMigration(inputFor(loaded, contract)), 'MAPPING_INVALID', 'maps nothing to it');
  });

  it('CREATE_ONLY: a required field with a default on create is not demanded', () => {
    const loaded = loadAt('hubspot-create');
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { phone: (field) => ({ ...required(field), defaultedOnCreate: 'TRUE' }) } })));
    assert.equal(deliveredEmails(run).length, 3);
  });

  it('UPDATE_ONLY: a required-on-create field is not demanded of an update', () => {
    const loaded = loadAt('hubspot-update');
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', { edit: { email: uniqueEmail, jobtitle: required, phone: required } })));
    assert.deepEqual(isolatedBy(run, 'DESTINATION_INSTANCE_REQUIRED_FIELD_MISSING'), []);
    assert.ok(deliveredEmails(run).length > 0);
  });
});

describe('MC-04: declared numeric limits, at the finding itself', () => {
  const plan = (field: TargetFieldContract): Parameters<typeof instanceFinding>[1] => ({
    object: { apiName: 'Opportunity', label: 'Opportunity', createable: 'TRUE', updateable: 'TRUE', recordTypes: [], fields: [field] },
    fields: [{ destinationField: 'deal.amount', field }],
    requiredOnCreate: [],
  });
  const record = (value: string): Parameters<typeof instanceFinding>[0] => ({ values: new Map([['deal.amount', { intent: preserve(value) }]]) });
  const amount = fixtureField('Amount', 'Amount', 'currency', { precision: 5, scale: 2 });

  it('a value inside precision and scale is no finding', () => {
    assert.equal(instanceFinding(record('123.45'), plan(amount), true), null);
    assert.equal(instanceFinding(record('-999'), plan(amount), true), null);
    assert.equal(instanceFinding(record('007.5'), plan(amount), true), null);
  });

  it('too many integer digits, or too many decimals, is a finding that keeps the value', () => {
    for (const value of ['1234.5', '1.234', '123456']) {
      const finding = instanceFinding(record(value), plan(amount), true);
      assert.equal(finding?.reasonCode, 'DESTINATION_INSTANCE_VALUE_TOO_LONG', value);
      assert.ok(finding?.detail.includes(value), finding?.detail);
    }
  });

  it('a value that is not a plain number is not measured against precision', () => {
    assert.equal(instanceFinding(record('12,345.67'), plan(amount), true), null);
  });
});

describe('MC-04: CLEAN_ONLY keeps the adapter rules and no contract', () => {
  it('runs without a contract and delivers every record', () => {
    const loaded = loadAt('clean-only');
    const run = runMigration(inputFor(loaded, null));
    assert.equal(deliveredEmails(run).length, 3);
  });
});

describe('MC-04: how a plan field is found in the instance', () => {
  const hubspot = getAdapter('HUBSPOT');
  const salesforce = getAdapter('SALESFORCE');
  const contactSpec = (adapter: typeof hubspot) => adapter.objects.find((spec) => spec.object === 'CONTACT');

  it('every HubSpot field the adapter delivers has an internal name', () => {
    for (const spec of hubspot.objects) {
      for (const field of spec.fields) {
        assert.notEqual(HUBSPOT_INTERNAL_NAMES[field.canonicalField], undefined, field.canonicalField);
      }
    }
  });

  it('HubSpot resolves by internal name first, then by the import header as label; Salesforce by API name', () => {
    const hs = contactSpec(hubspot);
    const sf = contactSpec(salesforce);
    assert.ok(hs !== undefined && sf !== undefined);
    assert.deepEqual(instanceFieldNames('HUBSPOT', hs, 'contact.firstName'), { apiNames: ['firstname'], labels: ['First name'] });
    assert.deepEqual(instanceFieldNames('SALESFORCE', sf, 'contact.firstName'), { apiNames: ['FirstName'], labels: ['FirstName'] });
    assert.deepEqual(instanceFieldNames('HUBSPOT', hs, 'custom:Opted In'), { apiNames: ['Opted In'], labels: ['Opted In'] });
    const object: TargetObjectContract = {
      apiName: 'contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', recordTypes: [],
      fields: [fixtureField('firstname', 'First Name', 'string'), fixtureField('opted_in', 'Opted In', 'bool')],
    };
    assert.equal(resolveInstanceField(object, { apiNames: ['FIRSTNAME'], labels: [] }).kind, 'FOUND');
    assert.equal(resolveInstanceField(object, { apiNames: ['Opted In'], labels: ['Opted In'] }).kind, 'FOUND');
    assert.equal(resolveInstanceField(object, { apiNames: ['nothing'], labels: ['nothing'] }).kind, 'NONE');
    assert.equal(
      resolveInstanceField({ ...object, fields: [...object.fields, fixtureField('FirstName', 'First Name', 'string')] }, { apiNames: ['firstname'], labels: [] }).kind,
      'AMBIGUOUS',
    );
  });

  it('the plan for a mapping names the resolved instance field for every delivered field', () => {
    const loaded = loadAt('hubspot-create');
    const plans = instancePlan(loaded.config, hubspot, contractOf('HUBSPOT'), true, false);
    const contacts = plans.get('contacts');
    assert.ok(contacts !== undefined);
    assert.deepEqual(
      contacts.fields.map((entry) => [entry.destinationField, entry.field.apiName]),
      [['contact.firstName', 'firstname'], ['contact.lastName', 'lastname'], ['contact.email', 'email'], ['contact.jobTitle', 'jobtitle']],
    );
  });
});

describe('MC-04b: a DATE delivered to a datetime field is a widening, not a coercion', () => {
  // Found running the HubSpot import qualification against the captured contract:
  // the portal reports DEAL.closedate as `datetime`, the deals mapping delivers a
  // DATE, and the portal takes it and reads it back. A calendar date is the
  // instant at the start of that day, so a DATE into a DATETIME field loses
  // nothing; the reverse still would, and stays refused. Exercised here on a
  // contact field so no pipeline is involved.
  const dateInput = (): string => {
    const dir = scratchDir('mc3-reopen-validation', `date-widening-${String((counter += 1))}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'contacts.csv'),
      'Contact ID,First Name,Last Name,Email,Signed\n1,Ada,Lovelace,ada@example.com,2026-09-01\n3,Alan,Turing,alan@example.com,2026-09-02\n',
    );
    return dir;
  };
  const signedAsDate = (raw: Record<string, unknown>): void => {
    const record = (raw['records'] as { fields: Record<string, unknown>[] }[])[0];
    if (record === undefined) throw new Error('the fixture has no record mapping');
    const jobTitle = record.fields.find((field) => field['destinationField'] === 'contact.jobTitle');
    if (jobTitle === undefined) throw new Error('the fixture no longer maps contact.jobTitle');
    jobTitle['column'] = { header: 'Signed' };
    jobTitle['semanticType'] = 'DATE';
    delete jobTitle['options'];
  };
  const jobTitleType = (type: string): ContractOptions => ({ edit: { jobtitle: (field) => ({ ...field, type }) } });
  const deliveredJobTitles = (run: RunResult): string[] =>
    [...run.truth.deliveredRecords].map((record) => String(record.values['contact.jobTitle'] ?? '')).filter((value) => value !== '');

  it('delivers a DATE column into a datetime instance field', () => {
    const loaded = loadAt('hubspot-create', signedAsDate);
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', jobTitleType('datetime')), { inputRoot: dateInput() }));
    assert.ok(deliveredJobTitles(run).length > 0, 'a DATE value reached the datetime field');
  });

  it('still delivers a DATE column into a date instance field (regression)', () => {
    const loaded = loadAt('hubspot-create', signedAsDate);
    const run = runMigration(inputFor(loaded, contractOf('HUBSPOT', jobTitleType('date')), { inputRoot: dateInput() }));
    assert.ok(deliveredJobTitles(run).length > 0);
  });

  it('still refuses a DATE column delivered to a number field (a date is not a number)', () => {
    const loaded = loadAt('hubspot-create', signedAsDate);
    refused(
      () => runMigration(inputFor(loaded, contractOf('HUBSPOT', jobTitleType('number')), { inputRoot: dateInput() })),
      'DESTINATION_FIELD_UNKNOWN',
      'as type "number"',
    );
  });
});
