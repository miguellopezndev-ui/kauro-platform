import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isMigrationError } from '../../src/domain/errors.js';
import type { MigrationError } from '../../src/domain/errors.js';
import { findField, hashTargetContract } from '../../src/target/contract.js';
import type { TargetObjectContract } from '../../src/target/contract.js';
import {
  SALESFORCE_BUNDLE_LIMITS,
  assertNoSecrets,
  buildSalesforceTargetContract,
  parseSalesforceDescribe,
  readSalesforceBundleDirectory,
} from '../../src/target/salesforce-bundle.js';
import type { SalesforceBundleFile } from '../../src/target/salesforce-bundle.js';

const encoder = new TextEncoder();

function bundleFile(path: string, text: string): SalesforceBundleFile {
  return { path, bytes: encoder.encode(text) };
}

function refusal(run: () => unknown): MigrationError {
  try {
    run();
  } catch (error: unknown) {
    if (isMigrationError(error)) return error;
    throw error;
  }
  throw new Error('expected a MigrationError, but nothing was thrown');
}

/** A field entry carrying every attribute a describe states, so a test only writes the one it is about. */
function fieldOf(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'Placeholder__c',
    label: 'Placeholder',
    type: 'string',
    soapType: 'xsd:string',
    length: 255,
    byteLength: 765,
    precision: 0,
    scale: 0,
    digits: 0,
    nillable: true,
    createable: true,
    updateable: true,
    unique: false,
    externalId: false,
    idLookup: false,
    calculated: false,
    autoNumber: false,
    defaultedOnCreate: false,
    restrictedPicklist: false,
    picklistValues: [],
    referenceTo: [],
    relationshipName: null,
    custom: true,
    filterable: true,
    sortable: true,
    nameField: false,
    ...overrides,
  };
}

function describeOf(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    label: name,
    custom: false,
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    keyPrefix: '001',
    fields: [fieldOf({ name: 'Id', label: 'Record ID', type: 'id', createable: false, updateable: false, idLookup: true })],
    childRelationships: [],
    recordTypeInfos: [],
    ...overrides,
  };
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);
const wrapped = (payload: unknown): string => json({ status: 0, result: payload, warnings: [] });

interface BundleEntry {
  readonly path: string;
  readonly kind: string;
  readonly sobject?: string;
  readonly text: string;
}

const ORG_SUMMARY = wrapped({
  id: '00D5f000004abcdEAA',
  instanceUrl: 'https://acme.my.salesforce.com',
  username: 'ops@acme.example',
  alias: 'acme',
  apiVersion: '64.0',
  connectedStatus: 'Connected',
});

const ATTESTATION = json({
  capturedAt: '2026-08-30T11:04:00Z',
  capturedBy: 'A. Operator',
  cliVersion: '2.136.8',
});

function standardEntries(): BundleEntry[] {
  return [
    { path: 'org.json', kind: 'SALESFORCE_ORG_SUMMARY', text: ORG_SUMMARY },
    { path: 'attestation.json', kind: 'SALESFORCE_ATTESTATION', text: ATTESTATION },
    ...['Account', 'Contact', 'Lead', 'Opportunity'].map((name) => ({
      path: `describe/${name}.json`,
      kind: 'SALESFORCE_DESCRIBE',
      sobject: name,
      text: wrapped(describeOf(name)),
    })),
  ];
}

function manifestFor(entries: readonly BundleEntry[]): string {
  return json({
    bundleFormat: 'kauro-salesforce-target-bundle/1',
    files: entries.map((entry) =>
      entry.sobject === undefined
        ? { path: entry.path, kind: entry.kind }
        : { path: entry.path, kind: entry.kind, sobject: entry.sobject },
    ),
  });
}

function bundleOf(entries: readonly BundleEntry[], extras: readonly SalesforceBundleFile[] = []): SalesforceBundleFile[] {
  return [
    bundleFile('manifest.json', manifestFor(entries)),
    ...entries.map((entry) => bundleFile(entry.path, entry.text)),
    ...extras,
  ];
}

/** Replace one standard entry, keeping the rest of the bundle valid so a test isolates one fault. */
function withEntry(path: string, patch: Partial<BundleEntry>): BundleEntry[] {
  return standardEntries().map((entry) => (entry.path === path ? { ...entry, ...patch } : entry));
}

function fieldIn(object: TargetObjectContract, apiName: string): NonNullable<ReturnType<typeof findField>> {
  const field = findField(object, apiName);
  assert.notEqual(field, null, `expected the contract to carry the field ${apiName}`);
  return field as NonNullable<typeof field>;
}

describe('Salesforce describe reading', () => {
  it('reads the --json envelope and the bare payload as the same object', () => {
    const payload = describeOf('Account', {
      fields: [fieldOf({ name: 'Name', label: 'Account Name', type: 'string', nameField: true })],
    });
    const fromEnvelope = parseSalesforceDescribe(wrapped(payload), 'describe/Account.json');
    const fromBare = parseSalesforceDescribe(json(payload), 'describe/Account.json');
    assert.deepEqual(fromEnvelope, fromBare);
    assert.equal(fromEnvelope.apiName, 'Account');
    assert.equal(fromEnvelope.createable, 'TRUE');
  });

  it('refuses a file that carries both shapes rather than choosing one', () => {
    const both = json({
      status: 0,
      result: describeOf('Account'),
      warnings: [],
      name: 'Contact',
      fields: [fieldOf({ name: 'Email' })],
    });
    const error = refusal(() => parseSalesforceDescribe(both, 'describe/Account.json'));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /states two payloads/);
  });

  it('refuses an envelope whose command failed', () => {
    const failed = json({ status: 1, result: { message: 'No such sobject' }, warnings: [] });
    const error = refusal(() => parseSalesforceDescribe(failed, 'describe/Account.json'));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /reports status 1/);
  });

  it('keeps externalId and unique as separate facts', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          fields: [
            fieldOf({ name: 'Legacy_Id__c', label: 'Legacy Id', externalId: true, unique: false, idLookup: true }),
          ],
        }),
      ),
      'describe/Account.json',
    );
    const field = fieldIn(object, 'Legacy_Id__c');
    assert.equal(field.externalId, 'TRUE');
    assert.equal(field.unique, 'FALSE');
    assert.equal(field.idLookup, 'TRUE');
  });

  it('carries idLookup independently of externalId', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Contact', {
          fields: [fieldOf({ name: 'Email', label: 'Email', type: 'email', idLookup: true, externalId: false, unique: false })],
        }),
      ),
      'describe/Contact.json',
    );
    const field = fieldIn(object, 'Email');
    assert.equal(field.idLookup, 'TRUE');
    assert.equal(field.externalId, 'FALSE');
    assert.equal(field.unique, 'FALSE');
  });

  it('reads an attribute the describe does not state as UNKNOWN, never as FALSE', () => {
    const object = parseSalesforceDescribe(
      wrapped({
        name: 'Account',
        label: 'Account',
        fields: [{ name: 'Sparse__c', label: 'Sparse', type: 'string' }],
      }),
      'describe/Account.json',
    );
    const field = fieldIn(object, 'Sparse__c');
    assert.equal(field.unique, 'UNKNOWN');
    assert.equal(field.externalId, 'UNKNOWN');
    assert.equal(field.idLookup, 'UNKNOWN');
    assert.equal(field.createable, 'UNKNOWN');
    assert.equal(field.calculated, 'UNKNOWN');
    assert.equal(field.length, null);
    assert.equal(object.createable, 'UNKNOWN');
  });

  it('refuses a boolean attribute spelled as a string', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(
        wrapped(describeOf('Account', { fields: [fieldOf({ name: 'Fake__c', unique: 'true' })] })),
        'describe/Account.json',
      ),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /"unique" as a string/);
  });

  it('carries a restricted picklist with its inactive values, in the order the org stated them', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          fields: [
            fieldOf({
              name: 'Industry',
              label: 'Industry',
              type: 'picklist',
              restrictedPicklist: true,
              picklistValues: [
                { value: 'Retail', label: 'Retail', active: true, defaultValue: false, validFor: null },
                { value: 'Dialup', label: 'Dial-up', active: false, defaultValue: false, validFor: null },
                { value: 'Agriculture', label: 'Agriculture', active: true, defaultValue: true, validFor: null },
              ],
            }),
          ],
        }),
      ),
      'describe/Account.json',
    );
    const field = fieldIn(object, 'Industry');
    assert.equal(field.restrictedPicklist, 'TRUE');
    assert.deepEqual(
      field.picklistValues.map((option) => option.value),
      ['Retail', 'Dialup', 'Agriculture'],
    );
    assert.equal(field.picklistValues[1]?.active, false);
    assert.equal(field.picklistValues[1]?.label, 'Dial-up');
    assert.equal(field.picklistValues[2]?.defaultValue, true);
  });

  it('refuses a picklist value whose active flag was not stated', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(
        wrapped(
          describeOf('Account', {
            fields: [
              fieldOf({
                name: 'Industry',
                type: 'picklist',
                picklistValues: [{ value: 'Retail', label: 'Retail', defaultValue: false }],
              }),
            ],
          }),
        ),
        'describe/Account.json',
      ),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /does not state "active"/);
  });

  it('keeps a picklist value the org states twice, with both labels', () => {
    // This used to be a refusal, on the reasoning that a value set is a set.
    // Reading a real org disproved it: Salesforce's own BillingStateCode states
    // "AG" twice, because a dependent picklist repeats a code under every parent
    // it is valid for and tells them apart by validFor rather than by the code.
    // The example below is the same shape — one code, two labels, one of them
    // retired — and a reader that refuses it cannot read Salesforce.
    //
    // De-duplicating would be worse than refusing: it would drop an entry
    // silently, and the entry it dropped would take a label and an active flag
    // with it.
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          fields: [
            fieldOf({
              name: 'Industry',
              type: 'picklist',
              picklistValues: [
                { value: 'Retail', label: 'Retail', active: true, defaultValue: false },
                { value: 'Retail', label: 'Retail (old)', active: false, defaultValue: false },
              ],
            }),
          ],
        }),
      ),
      'describe/Account.json',
    );

    const industry = object.fields.find((field) => field.apiName === 'Industry');
    assert.ok(industry !== undefined, 'Industry should have been read');
    assert.equal(industry.picklistValues.length, 2);
    assert.deepEqual(
      industry.picklistValues.map((option) => [option.value, option.label, option.active]),
      [
        ['Retail', 'Retail', true],
        ['Retail', 'Retail (old)', false],
      ],
    );
  });

  it('reads record types by developer name, master included', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          recordTypeInfos: [
            {
              available: true,
              defaultRecordTypeMapping: false,
              developerName: 'Partner_Account',
              master: false,
              name: 'Partner Account',
              recordTypeId: '0125f000000abcdAAA',
            },
            {
              available: true,
              defaultRecordTypeMapping: true,
              developerName: 'Master',
              master: true,
              name: 'Master',
              recordTypeId: '012000000000000AAA',
            },
          ],
        }),
      ),
      'describe/Account.json',
    );
    assert.deepEqual(
      object.recordTypes.map((recordType) => recordType.developerName),
      ['Master', 'Partner_Account'],
    );
    assert.equal(object.recordTypes[0]?.master, true);
    assert.equal(object.recordTypes[1]?.master, false);
    assert.equal(object.recordTypes[1]?.name, 'Partner Account');
    assert.equal(object.recordTypes[1]?.recordTypeId, '0125f000000abcdAAA');
  });

  it('refuses a record type that states no developer name', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(
        wrapped(
          describeOf('Account', {
            recordTypeInfos: [
              { available: true, master: true, name: 'Master', recordTypeId: '012000000000000AAA' },
            ],
          }),
        ),
        'describe/Account.json',
      ),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /does not state "developerName"/);
  });

  it('marks a calculated field and an autoNumber field as such', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Opportunity', {
          fields: [
            fieldOf({ name: 'Age__c', label: 'Age', type: 'double', calculated: true, createable: false, updateable: false }),
            fieldOf({ name: 'Ref__c', label: 'Reference', type: 'string', autoNumber: true, createable: false, updateable: false }),
          ],
        }),
      ),
      'describe/Opportunity.json',
    );
    const calculated = fieldIn(object, 'Age__c');
    const autoNumber = fieldIn(object, 'Ref__c');
    assert.equal(calculated.calculated, 'TRUE');
    assert.equal(calculated.autoNumber, 'FALSE');
    assert.equal(calculated.createable, 'FALSE');
    assert.equal(autoNumber.autoNumber, 'TRUE');
    assert.equal(autoNumber.calculated, 'FALSE');
    assert.equal(autoNumber.updateable, 'FALSE');
  });

  it('carries a lookup with the objects it references', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Contact', {
          fields: [
            fieldOf({
              name: 'AccountId',
              label: 'Account ID',
              type: 'reference',
              referenceTo: ['Account'],
              relationshipName: 'Account',
            }),
          ],
        }),
      ),
      'describe/Contact.json',
    );
    const field = fieldIn(object, 'AccountId');
    assert.deepEqual(field.referenceTo, ['Account']);
    assert.equal(field.relationshipName, 'Account');
  });

  it('refuses a lookup that does not say what it references', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(
        wrapped(
          describeOf('Contact', {
            fields: [
              {
                name: 'AccountId',
                label: 'Account ID',
                type: 'reference',
                relationshipName: 'Account',
              },
            ],
          }),
        ),
        'describe/Contact.json',
      ),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /does not state "referenceTo"/);
  });

  it('fails closed when the describe carries no fields array', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(wrapped({ name: 'Account', label: 'Account' }), 'describe/Account.json'),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /without a "fields" array/);
  });

  it('refuses JSON that is not an object', () => {
    for (const text of ['[]', '"Account"', 'null', '42', 'true']) {
      const error = refusal(() => parseSalesforceDescribe(text, 'describe/Account.json'));
      assert.equal(error.code, 'TARGET_CONTRACT_INVALID', `for ${text}`);
      assert.match(error.message, /at the top level/, `for ${text}`);
    }
  });

  it('refuses text that is not JSON at all, without quoting it back', () => {
    const error = refusal(() => parseSalesforceDescribe('name=Account', 'describe/Account.json'));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /is not valid JSON/);
    assert.equal(error.message.includes('name=Account'), false);
  });

  it('refuses one object stating the same key twice', () => {
    const text = '{"name":"Account","label":"Account","fields":[],"unique":true,"unique":false}';
    const error = refusal(() => parseSalesforceDescribe(text, 'describe/Account.json'));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /states the key "unique" twice/);
  });

  it('refuses two keys that differ only in case rather than picking one', () => {
    const text = '{"name":"Account","label":"Account","fields":[{"name":"X__c","label":"X","type":"string","unique":true,"Unique":false}]}';
    const error = refusal(() => parseSalesforceDescribe(text, 'describe/Account.json'));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /keys that all read as "unique"/);
  });

  it('tolerates attributes it has no place for without letting them become authority', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          somethingSalesforceAddedLater: true,
          fields: [
            fieldOf({
              name: 'Name',
              label: 'Account Name',
              extraTypeInfo: 'plainTextArea',
              htmlFormatted: false,
              controllerName: null,
              dependentPicklist: false,
              aBrandNewAttribute: 'ignored',
            }),
          ],
        }),
      ),
      'describe/Account.json',
    );
    const field = fieldIn(object, 'Name');
    assert.equal(field.apiName, 'Name');
    assert.equal(field.evidence, 'ARTIFACT');
    assert.equal(object.fields.length, 1);
  });

  it('sorts fields by API name so two captures of one org agree', () => {
    const object = parseSalesforceDescribe(
      wrapped(
        describeOf('Account', {
          fields: [fieldOf({ name: 'Zeta__c' }), fieldOf({ name: 'Alpha__c' }), fieldOf({ name: 'Mid__c' })],
        }),
      ),
      'describe/Account.json',
    );
    assert.deepEqual(
      object.fields.map((field) => field.apiName),
      ['Alpha__c', 'Mid__c', 'Zeta__c'],
    );
  });

  it('refuses a describe that states one field twice', () => {
    const error = refusal(() =>
      parseSalesforceDescribe(
        wrapped(describeOf('Account', { fields: [fieldOf({ name: 'Name' }), fieldOf({ name: 'Name' })] })),
        'describe/Account.json',
      ),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /field "Name" on Account twice/);
  });

  it('enforces the field count cap', () => {
    const fields = Array.from({ length: 5 }, (_unused, index) => fieldOf({ name: `F${String(index)}__c` }));
    const error = refusal(() =>
      parseSalesforceDescribe(wrapped(describeOf('Account', { fields })), 'describe/Account.json', {
        ...SALESFORCE_BUNDLE_LIMITS,
        maxFieldsPerObject: 3,
      }),
    );
    assert.equal(error.code, 'INPUT_LIMIT_EXCEEDED');
    assert.equal(error.details['limit'], 'maxFieldsPerObject');
  });
});

describe('Salesforce bundle secret refusal', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij';

  it('refuses an access token and does not echo its value', () => {
    const summary = wrapped({
      id: '00D5f000004abcdEAA',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'ops@acme.example',
      accessToken: token,
    });
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(withEntry('org.json', { text: summary }))));
    assert.equal(error.code, 'TARGET_ARTIFACT_SECRET_PRESENT');
    assert.equal(error.details['sourcePath'], 'org.json');
    assert.equal(error.details['key'], 'accessToken');
    assert.match(error.message, /accesstoken/);
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.toJson()).includes(token), false);
    assert.equal(error.remedy.includes(token), false);
  });

  it('refuses an sfdxAuthUrl key', () => {
    const summary = wrapped({
      id: '00D5f000004abcdEAA',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'ops@acme.example',
      sfdxAuthUrl: 'redacted-looking-but-still-a-place-for-one',
    });
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(withEntry('org.json', { text: summary }))));
    assert.equal(error.code, 'TARGET_ARTIFACT_SECRET_PRESENT');
    assert.equal(error.details['key'], 'sfdxAuthUrl');
  });

  it('refuses a force:// URL in a file that has no business carrying one', () => {
    const stray = bundleFile('notes.txt', 'handover notes\nforce://PlatformCLI::5Aep8@acme.my.salesforce.com\n');
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(standardEntries(), [stray])));
    assert.equal(error.code, 'TARGET_ARTIFACT_SECRET_PRESENT');
    assert.equal(error.details['sourcePath'], 'notes.txt');
    assert.equal(error.details['secretKind'], 'SFDX_AUTH_URL');
  });

  it('refuses a key whose spelling was escaped around the check', () => {
    const escaped = `{"\\u0061ccessToken":"${token}"}`;
    const error = refusal(() => assertNoSecrets(escaped, 'org.json'));
    assert.equal(error.code, 'TARGET_ARTIFACT_SECRET_PRESENT');
    assert.equal(error.message.includes(token), false);
  });

  it('refuses a credential key however it is cased, spaced or prefixed', () => {
    for (const key of ['ACCESS_TOKEN', 'sf-access-token', 'refreshToken', 'clientSecret', 'password', 'sessionId']) {
      const error = refusal(() => assertNoSecrets(`{"${key}": "x"}`, 'org.json'));
      assert.equal(error.code, 'TARGET_ARTIFACT_SECRET_PRESENT', `for ${key}`);
      assert.equal(error.details['key'], key, `for ${key}`);
    }
  });

  it('refuses a PEM private key block and a bearer token', () => {
    const pem = refusal(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n', 'server.key'));
    assert.equal(pem.details['secretKind'], 'PEM_PRIVATE_KEY');
    const bearer = refusal(() => assertNoSecrets('Authorization: Bearer 00DAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'headers.txt'));
    assert.equal(bearer.details['secretKind'], 'OAUTH_BEARER_TOKEN');
  });

  it('refuses a Salesforce session id while leaving a plain org id alone', () => {
    const session = refusal(() =>
      assertNoSecrets('{"value":"00D5f000004abcd!ARsAQFakeSessionMaterial00"}', 'org.json'),
    );
    assert.equal(session.details['secretKind'], 'SALESFORCE_SESSION_ID');
    assert.doesNotThrow(() => assertNoSecrets('{"value":"00D5f000004abcdEAA"}', 'org.json'));
  });

  it('says nothing about a bundle that carries no credential', () => {
    assert.doesNotThrow(() => assertNoSecrets(ORG_SUMMARY, 'org.json'));
    assert.doesNotThrow(() => assertNoSecrets(wrapped(describeOf('Account')), 'describe/Account.json'));
  });
});

describe('Salesforce bundle path refusal', () => {
  it('refuses a path that escapes the bundle root', () => {
    const stray = bundleFile('../outside.json', '{}');
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(standardEntries(), [stray])));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /escapes the bundle root/);
  });

  it('refuses a manifest entry that escapes the bundle root', () => {
    const entries = standardEntries().map((entry) =>
      entry.path === 'org.json' ? { ...entry, path: '../../etc/org.json' } : entry,
    );
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(entries)));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /escapes the bundle root/);
  });

  it('refuses an absolute path, a drive letter and a backslash', () => {
    for (const path of ['/etc/passwd.json', 'C:/secrets.json', 'describe\\Account.json']) {
      const error = refusal(() =>
        buildSalesforceTargetContract(bundleOf(standardEntries(), [bundleFile(path, '{}')])),
      );
      assert.equal(error.code, 'TARGET_CONTRACT_INVALID', `for ${path}`);
      assert.equal(error.details['path'], path, `for ${path}`);
    }
  });
});

describe('Salesforce bundle assembly', () => {
  it('builds a contract whose instance identity comes from the org summary', () => {
    const contract = buildSalesforceTargetContract(bundleOf(standardEntries()));
    assert.equal(contract.instance.mode, 'SALESFORCE');
    assert.equal(contract.instance.instanceId, '00D5f000004abcdEAA');
    assert.equal(contract.instance.instanceLabel, 'https://acme.my.salesforce.com');
    assert.equal(contract.instance.evidence, 'ARTIFACT');
    assert.equal(contract.capturedAt, '2026-08-30T11:04:00Z');
    assert.deepEqual(contract.pipelines, []);
    assert.deepEqual(
      contract.objects.map((object) => object.apiName),
      ['Account', 'Contact', 'Lead', 'Opportunity'],
    );
  });

  it('reads a bare org summary as well as the --json envelope', () => {
    const bare = json({
      orgId: '00D5f000004abcdEAA',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'ops@acme.example',
    });
    const contract = buildSalesforceTargetContract(bundleOf(withEntry('org.json', { text: bare })));
    assert.equal(contract.instance.instanceId, '00D5f000004abcdEAA');
  });

  it('refuses an org summary whose two org id spellings disagree', () => {
    const conflicting = json({
      orgId: '00D5f000004abcdEAA',
      id: '00D5f000004zzzzEAA',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'ops@acme.example',
    });
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(withEntry('org.json', { text: conflicting }))));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /different values/);
  });

  it('refuses an org id that is not a Salesforce id', () => {
    const wrong = json({
      orgId: 'https://acme.my.salesforce.com',
      instanceUrl: 'https://acme.my.salesforce.com',
      username: 'ops@acme.example',
    });
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(withEntry('org.json', { text: wrong }))));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /15- or 18-character Salesforce id/);
  });

  it('records every artifact with the digest of its own bytes', () => {
    const files = bundleOf(standardEntries());
    const contract = buildSalesforceTargetContract(files);
    assert.equal(contract.artifacts.length, files.length);
    assert.deepEqual(
      contract.artifacts.map((artifact) => artifact.path),
      [
        'attestation.json',
        'describe/Account.json',
        'describe/Contact.json',
        'describe/Lead.json',
        'describe/Opportunity.json',
        'manifest.json',
        'org.json',
      ],
    );
    for (const artifact of contract.artifacts) {
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      const source = files.find((file) => file.path === artifact.path);
      assert.equal(artifact.byteLength, source?.bytes.length);
    }
    assert.equal(
      contract.artifacts.find((artifact) => artifact.path === 'manifest.json')?.kind,
      'SALESFORCE_BUNDLE_MANIFEST',
    );
  });

  it('refuses a file the manifest does not declare', () => {
    const error = refusal(() =>
      buildSalesforceTargetContract(bundleOf(standardEntries(), [bundleFile('extra.json', '{}')])),
    );
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /is not declared in manifest.json/);
  });

  it('refuses a declared file that is not in the bundle', () => {
    const entries = standardEntries();
    const files = bundleOf(entries).filter((file) => file.path !== 'describe/Lead.json');
    const error = refusal(() => buildSalesforceTargetContract(files));
    assert.equal(error.code, 'INPUT_NOT_FOUND');
    assert.match(error.message, /declares "describe\/Lead.json"/);
  });

  it('refuses a bundle with no manifest at all', () => {
    const files = bundleOf(standardEntries()).filter((file) => file.path !== 'manifest.json');
    const error = refusal(() => buildSalesforceTargetContract(files));
    assert.equal(error.code, 'INPUT_NOT_FOUND');
    assert.match(error.message, /carries no manifest.json/);
  });

  it('refuses a manifest whose sobject disagrees with the describe', () => {
    const entries = standardEntries().map((entry) =>
      entry.path === 'describe/Lead.json' ? { ...entry, text: wrapped(describeOf('Contact')) } : entry,
    );
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(entries)));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /describes "Contact" but manifest.json declares it as "Lead"/);
  });

  it('refuses a bundle missing one of the four objects the mode addresses', () => {
    const entries = standardEntries().filter((entry) => entry.path !== 'describe/Lead.json');
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(entries)));
    assert.equal(error.code, 'INPUT_NOT_FOUND');
    assert.equal(error.details['sobject'], 'Lead');
  });

  it('carries a further describe rather than refusing it', () => {
    const entries = [
      ...standardEntries(),
      {
        path: 'describe/OpportunityContactRole.json',
        kind: 'SALESFORCE_DESCRIBE',
        sobject: 'OpportunityContactRole',
        text: wrapped(describeOf('OpportunityContactRole')),
      },
    ];
    const contract = buildSalesforceTargetContract(bundleOf(entries));
    assert.deepEqual(
      contract.objects.map((object) => object.apiName),
      ['Account', 'Contact', 'Lead', 'Opportunity', 'OpportunityContactRole'],
    );
  });

  it('refuses a manifest key the shape does not define', () => {
    const entries = standardEntries();
    const manifest = json({
      bundleFormat: 'kauro-salesforce-target-bundle/1',
      files: entries.map((entry) => ({ path: entry.path, kind: entry.kind, sobject: entry.sobject ?? undefined })),
      notes: 'anything at all',
    });
    const files = [bundleFile('manifest.json', manifest), ...entries.map((entry) => bundleFile(entry.path, entry.text))];
    const error = refusal(() => buildSalesforceTargetContract(files));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /carries the key "notes"/);
  });

  it('refuses a manifest that declares a different bundle format', () => {
    const entries = standardEntries();
    const manifest = json({ bundleFormat: 'something-else/2', files: [] });
    const files = [bundleFile('manifest.json', manifest), ...entries.map((entry) => bundleFile(entry.path, entry.text))];
    const error = refusal(() => buildSalesforceTargetContract(files));
    assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
    assert.match(error.message, /this reader reads/);
  });

  it('refuses two org summaries', () => {
    const entries = [
      ...standardEntries(),
      { path: 'org2.json', kind: 'SALESFORCE_ORG_SUMMARY', text: ORG_SUMMARY },
    ];
    const error = refusal(() => buildSalesforceTargetContract(bundleOf(entries)));
    assert.equal(error.code, 'INPUT_DUPLICATE_FILE');
    assert.match(error.message, /SALESFORCE_ORG_SUMMARY/);
  });

  it('refuses an attestation whose capture time is not a real UTC instant', () => {
    for (const capturedAt of ['2026-08-30', '30/08/2026', '2026-02-30T00:00:00Z', '2026-08-30T25:00:00Z']) {
      const attestation = json({ capturedAt, capturedBy: 'A. Operator', cliVersion: '2.136.8' });
      const error = refusal(() =>
        buildSalesforceTargetContract(bundleOf(withEntry('attestation.json', { text: attestation }))),
      );
      assert.equal(error.code, 'TARGET_CONTRACT_INVALID', `for ${capturedAt}`);
    }
  });

  it('accepts a leap day and refuses the same day in a common year', () => {
    const leap = json({ capturedAt: '2028-02-29T00:00:00Z', capturedBy: 'A', cliVersion: '2.136.8' });
    assert.equal(
      buildSalesforceTargetContract(bundleOf(withEntry('attestation.json', { text: leap }))).capturedAt,
      '2028-02-29T00:00:00Z',
    );
    const common = json({ capturedAt: '2026-02-29T00:00:00Z', capturedBy: 'A', cliVersion: '2.136.8' });
    const error = refusal(() =>
      buildSalesforceTargetContract(bundleOf(withEntry('attestation.json', { text: common }))),
    );
    assert.match(error.message, /not a real instant/);
  });

  it('enforces the per-file byte cap', () => {
    const error = refusal(() =>
      buildSalesforceTargetContract(bundleOf(standardEntries()), { ...SALESFORCE_BUNDLE_LIMITS, maxBytesPerFile: 32 }),
    );
    assert.equal(error.code, 'INPUT_LIMIT_EXCEEDED');
    assert.equal(error.details['limit'], 'maxBytesPerFile');
  });

  it('enforces the file count cap', () => {
    const error = refusal(() =>
      buildSalesforceTargetContract(bundleOf(standardEntries()), { ...SALESFORCE_BUNDLE_LIMITS, maxFiles: 3 }),
    );
    assert.equal(error.code, 'INPUT_LIMIT_EXCEEDED');
    assert.equal(error.details['limit'], 'maxFiles');
  });
});

describe('Salesforce target contract determinism', () => {
  it('produces the same contract hash from the same bytes twice', () => {
    const first = hashTargetContract(buildSalesforceTargetContract(bundleOf(standardEntries())));
    const second = hashTargetContract(buildSalesforceTargetContract(bundleOf(standardEntries())));
    assert.equal(first.contractHash, second.contractHash);
    assert.equal(first.canonicalJson, second.canonicalJson);
    assert.match(first.contractHash, /^tc_[0-9a-f]{64}$/);
  });

  it('does not depend on the order the files were handed over in', () => {
    const files = bundleOf(standardEntries());
    const forward = hashTargetContract(buildSalesforceTargetContract(files));
    const backward = hashTargetContract(buildSalesforceTargetContract([...files].reverse()));
    assert.equal(forward.contractHash, backward.contractHash);
  });

  it('changes the hash when one artifact byte changes', () => {
    const baseline = hashTargetContract(buildSalesforceTargetContract(bundleOf(standardEntries())));
    const edited = hashTargetContract(
      buildSalesforceTargetContract(
        bundleOf(
          withEntry('describe/Account.json', {
            text: wrapped(describeOf('Account', { fields: [fieldOf({ name: 'Name', label: 'Account Name' })] })),
          }),
        ),
      ),
    );
    assert.notEqual(baseline.contractHash, edited.contractHash);
  });
});

describe('Salesforce bundle reading from disk', () => {
  function writeBundle(root: string, entries: readonly BundleEntry[]): void {
    mkdirSync(join(root, 'describe'), { recursive: true });
    writeFileSync(join(root, 'manifest.json'), manifestFor(entries), 'utf8');
    for (const entry of entries) writeFileSync(join(root, ...entry.path.split('/')), entry.text, 'utf8');
  }

  it('reads a bundle directory and builds the same contract as the in-memory files', () => {
    const root = mkdtempSync(join(tmpdir(), 'kauro-sfbundle-'));
    try {
      const entries = standardEntries();
      writeBundle(root, entries);
      const fromDisk = buildSalesforceTargetContract(readSalesforceBundleDirectory(root));
      const inMemory = buildSalesforceTargetContract(bundleOf(entries));
      assert.equal(hashTargetContract(fromDisk).contractHash, hashTargetContract(inMemory).contractHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic link rather than following it', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'kauro-sfbundle-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'kauro-sfbundle-outside-'));
    try {
      writeBundle(root, standardEntries());
      writeFileSync(join(outside, 'elsewhere.json'), '{}', 'utf8');
      try {
        symlinkSync(join(outside, 'elsewhere.json'), join(root, 'linked.json'), 'file');
      } catch {
        t.skip('this platform does not permit creating a symbolic link');
        return;
      }
      const error = refusal(() => readSalesforceBundleDirectory(root));
      assert.equal(error.code, 'TARGET_CONTRACT_INVALID');
      assert.match(error.message, /is a symbolic link/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reports a bundle directory that is not there', () => {
    const error = refusal(() => readSalesforceBundleDirectory(join(tmpdir(), 'kauro-sfbundle-absent-directory')));
    assert.equal(error.code, 'INPUT_NOT_FOUND');
  });
});
