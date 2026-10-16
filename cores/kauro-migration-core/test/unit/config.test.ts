import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/mapping/load-config.js';
import { isMigrationError } from '../../src/domain/errors.js';
import { resolveColumn } from '../../src/mapping/resolve-columns.js';
import { validateAgainstSchema } from '../../src/mapping/schema-validator.js';
import { CONFIG_SCHEMA } from '../../src/mapping/config-schema.js';
import { effectiveSemanticsClass } from '../../src/domain/canonical.js';
import { CONFIG_SCHEMA_VERSION, TARGET_MODES } from '../../src/domain/config.js';
import type { ColumnLocator } from '../../src/domain/locators.js';

function base(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    configVersion: '3.0.0',
    source: { system: 'crm', namespace: 'acme' },
    target: { mode: 'CLEAN_ONLY', importMode: 'CREATE_ONLY' },
    files: [{ id: 'contacts', path: 'contacts.csv', format: 'CSV' }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Id' },
        fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
      },
    ],
    ...overrides,
  });
}

function expectInvalid(text: string, code: string, fragment: string): void {
  assert.throws(
    () => loadConfig(text, 'test.json'),
    (error: unknown) => {
      if (!isMigrationError(error)) return false;
      assert.equal(error.code, code, error.message);
      assert.ok(
        error.message.includes(fragment) || JSON.stringify(error.details).includes(fragment),
        `expected "${fragment}" in: ${error.message} ${JSON.stringify(error.details)}`,
      );
      return true;
    },
  );
}

describe('the configuration schema is closed', () => {
  it('accepts a minimal valid configuration', () => {
    const loaded = loadConfig(base(), 'test.json');
    assert.equal(loaded.config.source.namespace, 'acme');
    assert.equal(loaded.configHash.length, 64);
  });

  it('produces the same hash for the same meaning written differently', () => {
    const a = loadConfig(base(), 'test.json');
    const b = loadConfig(
      JSON.stringify({
        target: { importMode: 'CREATE_ONLY', mode: 'CLEAN_ONLY' },
        source: { namespace: 'acme', system: 'crm' },
        configVersion: '3.0.0',
        records: [
          {
            fields: [{ semanticType: 'EMAIL', destinationField: 'contact.email', column: { header: 'Email' } }],
            sourceRecordIdColumn: { header: 'Id' },
            object: 'CONTACT',
            fileId: 'contacts',
            id: 'contacts',
          },
        ],
        files: [{ format: 'CSV', path: 'contacts.csv', id: 'contacts' }],
      }),
      'test.json',
    );
    assert.equal(a.configHash, b.configHash);
  });

  it('rejects an unknown property instead of ignoring it', () => {
    expectInvalid(base({ mystery: 1 }), 'CONFIG_INVALID', 'unknown property');
  });

  it('accepts each declared target mode and rejects every other name', () => {
    for (const mode of TARGET_MODES) {
      const loaded = loadConfig(base({ target: { mode, importMode: 'CREATE_ONLY' } }), 'test.json');
      assert.equal(loaded.config.target.mode, mode);
    }
    // There are exactly three modes, and a name this engine no longer answers
    // to is not a mode it quietly ignores. "zoho" is the destination that was
    // removed and "canonical" the old spelling of CLEAN_ONLY; the closed schema
    // is what stops either of them coming back by being written down.
    for (const mode of ['zoho', 'canonical', 'pipedrive']) {
      expectInvalid(
        base({ target: { mode, importMode: 'CREATE_ONLY' } }),
        'CONFIG_INVALID',
        'not one of',
      );
    }
  });

  it('rejects a target block that names the property the schema retired', () => {
    expectInvalid(
      base({ target: { vendor: 'HUBSPOT', mode: 'HUBSPOT', importMode: 'CREATE_ONLY' } }),
      'CONFIG_INVALID',
      'unknown property',
    );
  });

  it('names the JSON pointer of the problem', () => {
    const violations = validateAgainstSchema(
      JSON.parse(base({ limits: { maxFiles: 'lots' } })),
      CONFIG_SCHEMA,
    );
    assert.ok(violations.some((violation) => violation.pointer === '/limits/maxFiles'));
  });
});

describe('mapping validation', () => {
  it('rejects a field that belongs to another object', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [{ column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' }],
          },
        ],
      }),
      'MAPPING_INVALID',
      'belongs to COMPANY',
    );
  });

  it('rejects two columns writing the same destination field', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              { column: { header: 'A' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
              { column: { header: 'B' }, destinationField: 'contact.email', semanticType: 'EMAIL' },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'mapped more than once',
    );
  });

  it('rejects a column reference that names both a header and an index', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              { column: { header: 'A', index: 3 }, destinationField: 'contact.email', semanticType: 'EMAIL' },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'exactly one of',
    );
  });

  it('rejects an option that does not apply to the semantic type', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              {
                column: { header: 'A' },
                destinationField: 'contact.description',
                semanticType: 'TEXT',
                options: { phoneCountry: 'US' },
              },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'only applies to',
    );
  });

  it('rejects clearing without an explicit destructive authorisation', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              {
                column: { header: 'A' },
                destinationField: 'contact.description',
                semanticType: 'TEXT',
                options: { clearWhenMatches: ['n/a'] },
              },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'destructiveAuthorization',
    );
  });

  it('rejects an ENUM with no declared options', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              { column: { header: 'A' }, destinationField: 'contact.lifecycleStage', semanticType: 'ENUM' },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'allowedValues',
    );
  });

  it('rejects PREFER_SURVIVOR without a justification', () => {
    expectInvalid(
      base({ policies: { mergeFieldConflict: 'PREFER_SURVIVOR' } }),
      'MAPPING_INVALID',
      'justification',
    );
  });

  it('accepts a configuration that merely maps a consent field under PREFER_SURVIVOR', () => {
    // Mapping a consent field is not resolving one by policy. Refusing this
    // configuration meant an export with an ordinary Unsubscribed column could
    // not use PREFER_SURVIVOR at all, and it made the runtime guard that
    // actually protects consent unreachable. G26 is where that guard is proven:
    // a consent conflict inside a proven merge sets the record aside, whatever
    // the policy says.
    const loaded = loadConfig(
      base({
        policies: {
          mergeFieldConflict: 'PREFER_SURVIVOR',
          mergeFieldConflictJustification: 'the first export is authoritative',
        },
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [
              {
                column: { header: 'Opt In' },
                destinationField: 'contact.marketingConsent',
                semanticType: 'BOOLEAN',
              },
            ],
          },
        ],
      }),
      'test.json',
    );
    assert.equal(loaded.config.policies.mergeFieldConflict, 'PREFER_SURVIVOR');
  });

  it('refuses a matching import mode that does not say what it matches on', () => {
    // The engine used to refuse UPDATE_ONLY and UPSERT outright. It now refuses
    // them only when nothing declares what the destination should match, which
    // is the actual missing thing.
    for (const importMode of ['UPSERT', 'UPDATE_ONLY']) {
      expectInvalid(
        base({ target: { mode: 'SALESFORCE', importMode } }),
        'MAPPING_INVALID',
        'declares no destination match authority',
      );
    }
  });

  it('refuses a matching import mode that declares it matches on nothing', () => {
    // Declaring NONE is not the same as declaring nothing, and it is not an
    // escape from having to say. Under a mode that matches an existing record,
    // matching on nothing is the one answer that cannot be carried out.
    expectInvalid(
      base({
        target: { mode: 'SALESFORCE', importMode: 'UPSERT' },
        destinationMatching: [{ recordMappingId: 'contacts', matchAuthority: 'NONE' }],
      }),
      'MAPPING_INVALID',
      'declares no destination match authority',
    );
  });

  it('refuses a matching import mode against a destination that does not exist', () => {
    // CLEAN_ONLY has no instance, so there is no record to update and nothing a
    // declaration could name.
    expectInvalid(
      base({
        target: { mode: 'CLEAN_ONLY', importMode: 'UPSERT' },
        destinationMatching: [
          {
            recordMappingId: 'contacts',
            matchAuthority: 'EXTERNAL_ID',
            targetField: 'Legacy_Id__c',
            sourceField: 'contact.email',
          },
        ],
      }),
      'MAPPING_INVALID',
      'CLEAN_ONLY cannot run in UPSERT',
    );
  });

  it('accepts a matching import mode that declares an authority the mapping can supply', () => {
    const loaded = loadConfig(
      base({
        target: { mode: 'SALESFORCE', importMode: 'UPSERT' },
        destinationMatching: [
          {
            recordMappingId: 'contacts',
            matchAuthority: 'EXTERNAL_ID',
            targetField: 'Legacy_Id__c',
            sourceField: 'contact.email',
            onMissingMatch: 'CREATE',
            onMatchConflict: 'ISOLATE',
          },
        ],
      }),
      'test.json',
    );
    const [match] = loaded.config.destinationMatching;
    assert.equal(match?.matchAuthority, 'EXTERNAL_ID');
    assert.equal(match?.targetField, 'Legacy_Id__c');
    // Whether Legacy_Id__c exists in the org, and whether it is an External ID
    // that is also unique, is not a question the configuration can answer. It is
    // settled against the captured target contract at run time.
  });

  it('refuses a match value the mapping does not deliver', () => {
    expectInvalid(
      base({
        target: { mode: 'SALESFORCE', importMode: 'UPDATE_ONLY' },
        destinationMatching: [
          {
            recordMappingId: 'contacts',
            matchAuthority: 'EXTERNAL_ID',
            targetField: 'Legacy_Id__c',
            sourceField: 'contact.phone',
          },
        ],
      }),
      'MAPPING_INVALID',
      'which it does not map',
    );
  });

  it('refuses a match declaration on a create-only import', () => {
    // Declaring what a create-only import matches on claims behaviour that never
    // happens, and a claim nobody checks is how a wrong one survives.
    expectInvalid(
      base({
        destinationMatching: [
          {
            recordMappingId: 'contacts',
            matchAuthority: 'RECORD_ID',
            sourceField: 'contact.email',
          },
        ],
      }),
      'MAPPING_INVALID',
      'under CREATE_ONLY',
    );
  });

  it('refuses creating an unmatched row in a mode that does not create', () => {
    expectInvalid(
      base({
        target: { mode: 'SALESFORCE', importMode: 'UPDATE_ONLY' },
        destinationMatching: [
          {
            recordMappingId: 'contacts',
            matchAuthority: 'EXTERNAL_ID',
            targetField: 'Legacy_Id__c',
            sourceField: 'contact.email',
            onMissingMatch: 'CREATE',
          },
        ],
      }),
      'MAPPING_INVALID',
      'does not create',
    );
  });

  it('refuses two match declarations for one record mapping', () => {
    expectInvalid(
      base({
        target: { mode: 'SALESFORCE', importMode: 'UPSERT' },
        destinationMatching: [
          { recordMappingId: 'contacts', matchAuthority: 'RECORD_ID', sourceField: 'contact.email' },
          { recordMappingId: 'contacts', matchAuthority: 'EXTERNAL_ID', targetField: 'X__c', sourceField: 'contact.email' },
        ],
      }),
      'MAPPING_INVALID',
      'more than one destinationMatching entry',
    );
  });

  it('refuses two fields writing their extension into one destination', () => {
    expectInvalid(
      base({
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [
              {
                column: { header: 'Phone' },
                destinationField: 'contact.phone',
                semanticType: 'PHONE',
                options: { extensionDestinationField: 'custom:Ext' },
              },
              {
                column: { header: 'Mobile' },
                destinationField: 'contact.mobilePhone',
                semanticType: 'PHONE',
                options: { extensionDestinationField: 'custom:Ext' },
              },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'both write their extension into',
    );
  });

  it('rejects a relationship whose endpoints do not match the record mappings', () => {
    expectInvalid(
      base({
        files: [
          { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
          { id: 'companies', path: 'companies.csv', format: 'CSV' },
        ],
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
          {
            id: 'companies',
            fileId: 'companies',
            object: 'COMPANY',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Name' }, destinationField: 'company.name', semanticType: 'TEXT' }],
          },
        ],
        associations: [
          {
            id: 'wrong',
            kind: 'COLUMN_REFERENCE',
            recordMappingId: 'contacts',
            relationshipType: 'COMPANY_TO_DEAL',
            keyColumn: { header: 'Company Id' },
            targetRecordMappingId: 'companies',
          },
        ],
      }),
      'MAPPING_INVALID',
      'relationship type',
    );
  });

  it('rejects a path that tries to leave the input bundle', () => {
    expectInvalid(
      base({ files: [{ id: 'contacts', path: '../secrets.csv', format: 'CSV' }] }),
      'MAPPING_INVALID',
      'inside the input bundle',
    );
  });
});

describe('column resolution', () => {
  const columns: ColumnLocator[] = ['Phone', 'Phone', 'Email'].map((headerRaw, columnIndex) => ({
    fileId: 'F',
    sheetId: 'S0',
    columnIndex,
    columnLocatorId: `F:S0:C${String(columnIndex)}`,
    headerRaw,
    headerOccurrence: headerRaw === 'Phone' ? columnIndex + 1 : 1,
  }));

  it('refuses to pick between repeated headers on its own', () => {
    assert.throws(
      () => resolveColumn({ header: 'Phone', occurrence: null, index: null }, columns, 'test'),
      (error: unknown) => isMigrationError(error) && error.code === 'MAPPING_INVALID',
    );
  });

  it('honours an explicitly stated occurrence', () => {
    assert.equal(resolveColumn({ header: 'Phone', occurrence: 1, index: null }, columns, 'test').columnIndex, 0);
    assert.equal(resolveColumn({ header: 'Phone', occurrence: 2, index: null }, columns, 'test').columnIndex, 1);
  });

  it('lists the available headers when a column is missing', () => {
    assert.throws(
      () => resolveColumn({ header: 'Fax', occurrence: null, index: null }, columns, 'test'),
      (error: unknown) =>
        isMigrationError(error) && JSON.stringify(error.details['availableHeaders']).includes('Email'),
    );
  });
});

/**
 * A second review found three ways a configuration could reach behaviour the
 * first round of guards was written to prevent. Each case is the configuration
 * it wrote, and each has to be refused at load rather than acted on.
 */
describe('a declared field class may raise protection, never lower it', () => {
  it('keeps a canonical consent field consent whatever the configuration declares', () => {
    // The load-time guard refuses this configuration, so this is the rule
    // underneath it: even if a declaration reached the merge, it could not turn
    // a consent field into an ordinary one.
    assert.equal(effectiveSemanticsClass('contact.doNotEmail', 'STANDARD'), 'CONSENT');
    assert.equal(effectiveSemanticsClass('contact.doNotEmail', null), 'CONSENT');
    assert.equal(effectiveSemanticsClass('contact.marketingConsent', 'STANDARD'), 'CONSENT');
  });

  it('lets a declaration raise an ordinary field to consent', () => {
    assert.equal(effectiveSemanticsClass('custom:Do Not Contact', 'CONSENT'), 'CONSENT');
    assert.equal(effectiveSemanticsClass('contact.description', 'CONSENT'), 'CONSENT');
  });

  it('leaves an undeclared ordinary field ordinary', () => {
    assert.equal(effectiveSemanticsClass('contact.email', null), 'STANDARD');
    assert.equal(effectiveSemanticsClass('custom:Notes', null), 'STANDARD');
  });
});

describe('a configuration cannot switch off the guards that protect it', () => {
  it('refuses a declaration that makes a canonical consent field ordinary', () => {
    // Declaring STANDARD here used to replace the canonical class outright, so
    // PREFER_SURVIVOR would pick the less restrictive of two disagreeing
    // do-not-email values and record the field as ordinary while doing it.
    expectInvalid(
      base({
        policies: {
          mergeFieldConflict: 'PREFER_SURVIVOR',
          mergeFieldConflictJustification: 'the operator accepted survivor-wins for ordinary fields',
        },
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [
              {
                column: { header: 'Do Not Email' },
                destinationField: 'contact.doNotEmail',
                semanticType: 'TEXT',
                semanticsClass: 'STANDARD',
              },
            ],
          },
        ],
      }),
      'MAPPING_INVALID',
      'on a field the canonical model defines as CONSENT',
    );
  });

  it('refuses two record mappings over one file when only one names its sheet', () => {
    // Different keys, one physical sheet: a mapping with no sheet takes the
    // only sheet of a single-sheet file. This used to pass validation and fail
    // much later as a reconciliation error blaming the engine.
    expectInvalid(
      base({
        files: [{ id: 'contacts', path: 'contacts.xlsx', format: 'XLSX' }],
        records: [
          {
            id: 'unnamed',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
          {
            id: 'named',
            fileId: 'contacts',
            sheet: 'Contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
        ],
      }),
      'MAPPING_INVALID',
      'one by name and one without one',
    );
  });

  it('refuses an identity space that lands on another mapping by accident', () => {
    expectInvalid(
      base({
        files: [
          { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
          { id: 'leads', path: 'leads.csv', format: 'CSV' },
        ],
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
          {
            id: 'leads',
            fileId: 'leads',
            object: 'CONTACT',
            identitySpace: 'contacts',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
        ],
      }),
      'MAPPING_INVALID',
      'implicit identity space',
    );
  });

  it('still accepts an identity space both mappings declare', () => {
    const loaded = loadConfig(
      base({
        files: [
          { id: 'contacts', path: 'contacts.csv', format: 'CSV' },
          { id: 'more', path: 'more.csv', format: 'CSV' },
        ],
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            identitySpace: 'customer_export',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
          {
            id: 'more',
            fileId: 'more',
            object: 'CONTACT',
            identitySpace: 'customer_export',
            sourceRecordIdColumn: { header: 'Id' },
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
        ],
      }),
      'test.json',
    );
    assert.equal(loaded.config.records[1]?.identitySpace, 'customer_export');
  });
});

describe('a policy the engine cannot honour is refused rather than offered', () => {
  it('refuses DELIVER_WITH_ALTERNATE_KEY, whatever the mode', () => {
    // A destination key conflict is a collision on a field the destination
    // matches records by. Delivering both makes the destination merge them,
    // and nothing in this engine assigns an alternate key, so the policy
    // guaranteed the silent merge the report exists to prevent.
    for (const mode of TARGET_MODES) {
      expectInvalid(
        base({
          target: { mode, importMode: 'CREATE_ONLY' },
          policies: { destinationKeyConflict: 'DELIVER_WITH_ALTERNATE_KEY' },
        }),
        'MAPPING_INVALID',
        'is not implemented and cannot be made safe',
      );
    }
  });
});

describe('the configured normalization primitives', () => {
  const withOptions = (
    semanticType: string,
    options: Record<string, unknown>,
    destinationField = 'contact.description',
  ): Record<string, unknown> => ({
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        object: 'CONTACT',
        sourceRecordIdColumn: { header: 'Id' },
        fields: [{ column: { header: 'X' }, destinationField, semanticType, options }],
      },
    ],
  });

  it('leaves all three off unless the plan asks for them', () => {
    const loaded = loadConfig(base(), 'test.json');
    const options = loaded.config.records[0]?.fields[0]?.options;
    assert.equal(options?.unicodeNormalization, 'PRESERVE');
    assert.equal(options?.caseTransform, 'PRESERVE');
    assert.deepEqual(options?.valueMap, []);
  });

  it('refuses Unicode normalization on a type that has its own pipeline', () => {
    for (const semanticType of ['EMAIL', 'PHONE', 'DATE', 'NUMBER', 'BOOLEAN', 'IDENTIFIER', 'URL']) {
      expectInvalid(
        base(withOptions(semanticType, { unicodeNormalization: 'NFC' })),
        'MAPPING_INVALID',
        'only applies to TEXT, ENUM',
      );
    }
  });

  it('refuses a case transform anywhere but TEXT', () => {
    expectInvalid(
      base(withOptions('ENUM', { caseTransform: 'LOWER', allowedValues: ['a'] })),
      'MAPPING_INVALID',
      'only applies to TEXT',
    );
    expectInvalid(
      base(withOptions('EMAIL', { caseTransform: 'TITLE_SIMPLE' }, 'contact.email')),
      'MAPPING_INVALID',
      'only applies to TEXT',
    );
  });

  it('refuses a value map on a type that has its own pipeline', () => {
    expectInvalid(
      base(withOptions('PHONE', { valueMap: [{ from: 'x', to: 'y' }] }, 'contact.phone')),
      'MAPPING_INVALID',
      'only applies to TEXT, ENUM',
    );
  });

  it('accepts all three where they apply', () => {
    const loaded = loadConfig(
      base(
        withOptions('TEXT', {
          unicodeNormalization: 'NFC',
          caseTransform: 'TITLE_SIMPLE',
          valueMap: [{ from: 'MCDONALD', to: 'McDonald' }],
        }),
      ),
      'test.json',
    );
    assert.deepEqual(loaded.config.records[0]?.fields[0]?.options.valueMap, [
      { from: 'MCDONALD', to: 'McDonald' },
    ]);
  });

  it('refuses two mappings that say the same thing', () => {
    expectInvalid(
      base(
        withOptions('TEXT', {
          valueMap: [
            { from: 'cliente', to: 'Customer' },
            { from: 'cliente', to: 'Lead' },
          ],
        }),
      ),
      'MAPPING_INVALID',
      'the same value once',
    );
  });

  it('refuses two mappings that differ only by whitespace the field trims away', () => {
    // "A" and " A " are the same cell to a field that trims, so which one wins
    // would depend on an order the plan never declared.
    expectInvalid(
      base(
        withOptions('TEXT', {
          trim: true,
          valueMap: [
            { from: 'A', to: 'x' },
            { from: ' A ', to: 'y' },
          ],
        }),
      ),
      'MAPPING_INVALID',
      'the same value once',
    );
  });

  it('keeps both when the field does not trim, because then they are different cells', () => {
    const loaded = loadConfig(
      base(
        withOptions('TEXT', {
          trim: false,
          valueMap: [
            { from: 'A', to: 'x' },
            { from: ' A ', to: 'y' },
          ],
        }),
      ),
      'test.json',
    );
    assert.equal(loaded.config.records[0]?.fields[0]?.options.valueMap.length, 2);
  });

  it('refuses two mappings that differ only by Unicode form the field composes away', () => {
    expectInvalid(
      base(
        withOptions('TEXT', {
          unicodeNormalization: 'NFC',
          valueMap: [
            { from: 'Se\u0301nior', to: 'x' },
            { from: 'S\u00e9nior', to: 'y' },
          ],
        }),
      ),
      'MAPPING_INVALID',
      'the same value once',
    );
  });

  it('refuses a mapping that matches nothing a populated cell can hold', () => {
    expectInvalid(
      base(withOptions('TEXT', { trim: true, valueMap: [{ from: '   ', to: 'x' }] })),
      'MAPPING_INVALID',
      'which is empty once',
    );
  });

  it('refuses a mapping that would erase the value', () => {
    // Clearing a populated cell is clearWhenMatches plus destructiveAuthorization,
    // and nothing else.
    expectInvalid(
      base(withOptions('TEXT', { valueMap: [{ from: 'placeholder', to: '' }] })),
      'CONFIG_INVALID',
      'must be at least 1 characters',
    );
  });

  it('reads the same plan the same way however the mappings were ordered', () => {
    const forward = loadConfig(
      base(
        withOptions('TEXT', {
          valueMap: [
            { from: 'cliente', to: 'Customer' },
            { from: 'cliente viejo', to: 'Customer' },
            { from: 'prospecto', to: 'Lead' },
            { from: 'partner', to: 'Partner' },
          ],
        }),
      ),
      'test.json',
    );
    const shuffled = loadConfig(
      base(
        withOptions('TEXT', {
          valueMap: [
            { from: 'partner', to: 'Partner' },
            { from: 'prospecto', to: 'Lead' },
            { from: 'cliente', to: 'Customer' },
            { from: 'cliente viejo', to: 'Customer' },
          ],
        }),
      ),
      'test.json',
    );
    assert.equal(forward.configHash, shuffled.configHash);
    assert.deepEqual(forward.normalizedJson, shuffled.normalizedJson);
    assert.deepEqual(
      forward.config.records[0]?.fields[0]?.options.valueMap.map((entry) => entry.from),
      ['cliente', 'cliente viejo', 'partner', 'prospecto'],
    );
  });
});

describe('the configuration schema version follows the meaning of the plan', () => {
  it('[R2-002] refuses a 2.x configuration and names the trim-default change, never reinterpreting it', () => {
    for (const version of ['2.0.0', '2.1.0']) {
      assert.throws(
        () => loadConfig(base({ configVersion: version }), 'old-plan.json'),
        (error: unknown) => {
          if (!isMigrationError(error)) return false;
          assert.equal(error.code, 'CONFIG_INVALID');
          assert.ok(error.message.includes(version), error.message);
          assert.ok(/trim/u.test(error.message + error.remedy), `the refusal must name the trim default: ${error.message}`);
          assert.ok(error.remedy.includes('"trim": true'), 'the remedy says how to keep the old behaviour, field by field');
          return true;
        },
      );
    }
  });

  it('[R2-002] loads a 3.0.0 configuration in which no field trims unless it says so', () => {
    const loaded = loadConfig(base({ configVersion: CONFIG_SCHEMA_VERSION }), 'new-plan.json');
    assert.equal(CONFIG_SCHEMA_VERSION, '3.0.0');
    assert.equal(loaded.config.records[0]?.fields[0]?.options.trim, false);
    const approved = loadConfig(
      base({
        configVersion: CONFIG_SCHEMA_VERSION,
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL', options: { trim: true } }],
          },
        ],
      }),
      'approved.json',
    );
    assert.equal(approved.config.records[0]?.fields[0]?.options.trim, true);
  });

  it('declares an identity normalization on a key column, and only trim and NFC are offered', () => {
    const plan = (identityNormalization: unknown) =>
      base({
        configVersion: CONFIG_SCHEMA_VERSION,
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            sourceRecordIdColumn: { header: 'Id', identityNormalization },
            authoritativeExternalIdColumns: [{ header: 'Legacy', identityNormalization: { trim: true } }],
            fields: [{ column: { header: 'Email' }, destinationField: 'contact.email', semanticType: 'EMAIL' }],
          },
        ],
      });
    const loaded = loadConfig(plan({ trim: true, unicode: 'NFC' }), 'test.json');
    const keyColumns = loaded.config.records[0] as unknown as {
      sourceRecordIdColumn?: { identityNormalization: unknown };
      authoritativeExternalIdColumns: { identityNormalization: unknown }[];
    };
    assert.deepEqual(keyColumns.sourceRecordIdColumn?.identityNormalization, { trim: true, unicode: 'NFC' });
    assert.deepEqual(keyColumns.authoritativeExternalIdColumns[0]?.identityNormalization, { trim: true, unicode: null });
    assert.throws(() => loadConfig(plan({ unicode: 'NFKC' }), 'test.json'));
    assert.throws(() => loadConfig(plan({ lowercase: true }), 'test.json'));
  });

  it('refuses a timezone that also declares an offset, and an unknown zone', () => {
    const plan = (options: Record<string, unknown>) =>
      base({
        configVersion: CONFIG_SCHEMA_VERSION,
        records: [
          {
            id: 'contacts',
            fileId: 'contacts',
            object: 'CONTACT',
            fields: [{ column: { header: 'When' }, destinationField: 'contact.createdAt', semanticType: 'DATETIME', options }],
          },
        ],
      });
    const tz = { zone: 'Europe/Madrid', tzdata: process.versions.tz ?? '', overlap: 'REFUSE' };
    assert.doesNotThrow(() => loadConfig(plan({ timezone: tz }), 'test.json'));
    expectInvalid(plan({ timezone: tz, timezoneOffset: '+01:00' }), 'CONFIG_INVALID', 'timezoneOffset');
    expectInvalid(plan({ timezone: { ...tz, zone: 'Mars/Olympus_Mons' } }), 'CONFIG_INVALID', 'Mars/Olympus_Mons');
    expectInvalid(plan({ timezone: { ...tz, overlap: 'SHIFT' } }), 'CONFIG_INVALID', 'SHIFT');
  });
});
