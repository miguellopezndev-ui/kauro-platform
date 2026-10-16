import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ALL_ADAPTERS, getAdapter } from '../../src/adapters/specs.js';
import { objectSpec, vendorHeader } from '../../src/adapters/adapter.js';
import { importKeyFor } from '../../src/artifacts/import-key.js';
import { RELATIONSHIP_TYPES } from '../../src/domain/associations.js';
import { CANONICAL_OBJECTS, isCanonicalField } from '../../src/domain/canonical.js';
import { TARGET_MODES } from '../../src/domain/config.js';
import { GOLDEN_ROOT, collect, readTable, repoRoot, runFixture, scratchDir } from '../support/harness.js';
import { parseJson } from '../../src/util/json.js';
import type { JsonObject } from '../../src/util/json.js';

/**
 * Adapters may only claim what the source registry establishes. These tests pin
 * the specific vendor facts the engine acts on, so a documentation change that
 * invalidates one of them fails the gate rather than silently changing output.
 */

describe('every adapter', () => {
  for (const adapter of ALL_ADAPTERS) {
    describe(adapter.mode, () => {
      it('cites at least one source with a review date', () => {
        assert.ok(adapter.sources.length > 0);
        for (const source of adapter.sources) {
          assert.match(source.reviewedOn, /^\d{4}-\d{2}-\d{2}$/u);
          assert.ok(source.scope.length > 10, 'a source must say what it establishes');
        }
      });

      it('maps every field to a real canonical field', () => {
        for (const spec of adapter.objects) {
          for (const entry of spec.fields) {
            assert.ok(isCanonicalField(entry.canonicalField), `${entry.canonicalField} is not canonical`);
            assert.ok(entry.header.length > 0);
          }
        }
      });

      it('only requires fields it can also deliver', () => {
        for (const spec of adapter.objects) {
          for (const required of [...spec.requiredForCreate, ...spec.requiredAnyOf.flat()]) {
            assert.ok(
              vendorHeader(spec, required) !== null,
              `${adapter.mode} requires ${required} but has no column for it`,
            );
          }
          for (const key of spec.destinationMatchingKeys) {
            assert.ok(
              vendorHeader(spec, key) !== null,
              `${adapter.mode} matches on ${key} but has no column for it`,
            );
          }
        }
      });

      it('states a position on every relationship type', () => {
        for (const type of RELATIONSHIP_TYPES) {
          const support = adapter.relationships[type];
          assert.ok(support !== undefined, `${type} has no stated position`);
          if (support.kind === 'UNSUPPORTED') {
            assert.ok(support.reason.length > 20, `${type} must say why it is unsupported`);
          } else {
            assert.ok(support.operatorInstructions.length > 20, `${type} must tell the operator what to do`);
          }
        }
      });

      it('declares no duplicate destination headers within one object', () => {
        for (const spec of adapter.objects) {
          const headers = spec.fields.map((entry) => entry.header);
          assert.equal(new Set(headers).size, headers.length, `${spec.object} has a repeated header`);
        }
      });
    });
  }
});

/**
 * The registry itself.
 *
 * There are exactly three commercial modes and no activity object in any of
 * them. Both facts are load-bearing: a fourth adapter would be a product claim
 * nobody reviewed, and an activity object would be a promise the engine has no
 * canonical type to keep.
 */
describe('the adapter registry', () => {
  it('registers exactly the three target modes, and no fourth vendor', () => {
    assert.equal(ALL_ADAPTERS.length, TARGET_MODES.length);
    assert.deepEqual(
      ALL_ADAPTERS.map((adapter) => adapter.mode).sort(),
      [...TARGET_MODES].sort(),
    );
    for (const mode of TARGET_MODES) {
      assert.equal(getAdapter(mode).mode, mode, `${mode} must resolve to its own adapter`);
    }
  });

  it('declares no activity object, in any mode', () => {
    for (const adapter of ALL_ADAPTERS) {
      for (const spec of adapter.objects) {
        assert.ok(
          (CANONICAL_OBJECTS as readonly string[]).includes(spec.object),
          `${adapter.mode} declares ${spec.object}, which is not a canonical object`,
        );
        assert.ok(
          !/(activit|^notes|^calls|^meetings|^tasks)/iu.test(spec.fileName),
          `${adapter.mode} writes ${spec.fileName}, which is an activity import file`,
        );
      }
    }
  });

  it('names the import directory and association key header each package is written under', () => {
    assert.deepEqual(
      ALL_ADAPTERS.map((adapter) => [adapter.mode, adapter.importDirectory, adapter.associationKeyHeader]),
      [
        ['CLEAN_ONLY', 'clean-only', 'association_key'],
        ['HUBSPOT', 'hubspot', 'Association Key'],
        ['SALESFORCE', 'salesforce', 'Kauro_Association_Key__c'],
      ],
    );
  });

  it('never spells an association key the way a trace key was spelled', () => {
    // 01_IMPORT carries no Kauro trace identity in package format 2.0.0. An
    // adapter that went back to the old spelling would be putting it back in
    // front of the operator as a column to map, which is the mistake the four
    // areas exist to prevent.
    for (const adapter of ALL_ADAPTERS) {
      for (const header of [adapter.associationKeyHeader, adapter.associationFromHeader, adapter.associationToHeader]) {
        assert.ok(
          !/trace/iu.test(header),
          `${adapter.mode} names an import column "${header}"`,
        );
      }
    }
  });

  it('shapes the vendor-neutral mode for every canonical object', () => {
    // CLEAN_ONLY has no destination instance, so it carries the whole canonical
    // model rather than a vendor's subset of it.
    assert.deepEqual(
      getAdapter('CLEAN_ONLY').objects.map((spec) => [spec.object, spec.fileName]),
      [
        ['CONTACT', 'contacts.csv'],
        ['COMPANY', 'companies.csv'],
        ['DEAL', 'deals.csv'],
        ['LEAD', 'leads.csv'],
      ],
    );
  });
});

describe('HubSpot', () => {
  const adapter = getAdapter('HUBSPOT');

  it('offers contacts, companies and deals only', () => {
    // The import tool can load notes, calls, meetings and tasks. The product
    // does not sell them, so the adapter does not claim them.
    assert.deepEqual(
      adapter.objects.map((spec) => [spec.object, spec.fileName]),
      [
        ['CONTACT', 'contacts.csv'],
        ['COMPANY', 'companies.csv'],
        ['DEAL', 'deals.csv'],
      ],
    );
  });

  it('requires an email address to create a contact', () => {
    assert.deepEqual(objectSpec(adapter, 'CONTACT')?.requiredForCreate, ['contact.email']);
  });

  it('accepts either a company name or a domain', () => {
    assert.deepEqual(objectSpec(adapter, 'COMPANY')?.requiredAnyOf, [
      ['company.name', 'company.domain'],
    ]);
  });

  it('requires deal name, pipeline and stage', () => {
    assert.deepEqual(objectSpec(adapter, 'DEAL')?.requiredForCreate, [
      'deal.name',
      'deal.pipeline',
      'deal.stage',
    ]);
  });

  it('deduplicates contacts by email and companies by domain', () => {
    assert.deepEqual(objectSpec(adapter, 'CONTACT')?.destinationMatchingKeys, ['contact.email']);
    assert.deepEqual(objectSpec(adapter, 'COMPANY')?.destinationMatchingKeys, ['company.domain']);
  });

  it('writes the property labels the documentation spells out', () => {
    // An independent review found these emitted in title case while HubSpot
    // documents them in sentence case, so the header would not have matched a
    // property at all.
    const contact = objectSpec(adapter, 'CONTACT');
    const expected: [string, string][] = [
      ['contact.firstName', 'First name'],
      ['contact.lastName', 'Last name'],
      ['contact.phone', 'Phone number'],
      ['contact.mobilePhone', 'Mobile phone number'],
      ['contact.jobTitle', 'Job title'],
      ['contact.companyName', 'Company name'],
      ['contact.addressLine1', 'Street address'],
      ['contact.postalCode', 'Postal code'],
      ['contact.lifecycleStage', 'Lifecycle stage'],
    ];
    for (const [field, header] of expected) {
      assert.equal(vendorHeader(contact!, field as never)?.header, header, field);
    }
    const company = objectSpec(adapter, 'COMPANY');
    assert.equal(vendorHeader(company!, 'company.domain')?.header, 'Company domain name');
    assert.equal(vendorHeader(company!, 'company.employeeCount')?.header, 'Number of employees');
    const deal = objectSpec(adapter, 'DEAL');
    assert.equal(vendorHeader(deal!, 'deal.name')?.header, 'Deal name');
    assert.equal(vendorHeader(deal!, 'deal.stage')?.header, 'Deal stage');
    // HubSpot has no default deal property simply called Description.
    assert.equal(vendorHeader(deal!, 'deal.description')?.header, 'Deal description');
  });

  it('claims only the relationship pairs the documentation names', () => {
    assert.equal(adapter.relationships.CONTACT_TO_COMPANY.kind, 'SUPPORTED');
    assert.equal(adapter.relationships.CONTACT_TO_DEAL.kind, 'SUPPORTED');
    assert.equal(adapter.relationships.COMPANY_TO_DEAL.kind, 'SUPPORTED');
    for (const type of RELATIONSHIP_TYPES) {
      const support = adapter.relationships[type];
      if (support.kind !== 'SUPPORTED') continue;
      assert.equal(support.strategy, 'TWO_FILE_COMMON_COLUMN', `${type} is a two-file import`);
    }
  });

  it('measures the one-megabyte cell limit in bytes, as the page states it', () => {
    assert.equal(adapter.fileConstraints.maxFieldBytes, 1_048_576);
    assert.equal(adapter.fileConstraints.maxFieldCharacters, null);
  });

  it('keeps within the documented column limit', () => {
    assert.equal(adapter.fileConstraints.maxColumnsPerFile, 999);
    assert.equal(adapter.fileConstraints.maxRowsPerFile, 1_048_576);
  });
});

describe('Salesforce', () => {
  const adapter = getAdapter('SALESFORCE');

  it('loads the four objects it names, each into its own API file', () => {
    assert.deepEqual(
      adapter.objects.map((spec) => [spec.object, spec.fileName]),
      [
        ['CONTACT', 'Contact.csv'],
        ['COMPANY', 'Account.csv'],
        ['LEAD', 'Lead.csv'],
        ['DEAL', 'Opportunity.csv'],
      ],
    );
  });

  it('requires only LastName on a contact, and enforces the documented lengths', () => {
    const spec = objectSpec(adapter, 'CONTACT');
    assert.deepEqual(spec?.requiredForCreate, ['contact.lastName']);
    assert.equal(vendorHeader(spec!, 'contact.lastName')?.maxLength, 80);
    assert.equal(vendorHeader(spec!, 'contact.firstName')?.maxLength, 40);
  });

  it('requires the three non-nillable opportunity fields', () => {
    assert.deepEqual(objectSpec(adapter, 'DEAL')?.requiredForCreate, [
      'deal.name',
      'deal.closeDate',
      'deal.stage',
    ]);
  });

  it('requires the two non-nillable lead fields, and can deliver both', () => {
    const spec = objectSpec(adapter, 'LEAD');
    assert.ok(spec !== null, 'Salesforce must declare a LEAD object');
    assert.equal(spec.fileName, 'Lead.csv');
    // Company is required because an unconverted lead carries its employer as a
    // value on itself rather than through a relationship.
    assert.deepEqual(spec.requiredForCreate, ['lead.lastName', 'lead.company']);
    assert.equal(vendorHeader(spec, 'lead.lastName')?.header, 'LastName');
    assert.equal(vendorHeader(spec, 'lead.company')?.header, 'Company');
    assert.equal(vendorHeader(spec, 'lead.lastName')?.maxLength, 80);
    // The Object Reference states no length for Company, so the adapter asserts
    // none. A limit nobody documented is a guess, and a guess here truncates
    // somebody's data.
    assert.equal(vendorHeader(spec, 'lead.company')?.maxLength, null);
  });

  it('writes the documented Lead API names, not the Contact ones', () => {
    // A Lead is not a Contact under another name. Its address columns are
    // Street, City and State rather than the Mailing* set, its employer is a
    // value called Company, and its two consent fields have Salesforce's own
    // spellings.
    const lead = objectSpec(adapter, 'LEAD');
    const expected: [string, string][] = [
      ['lead.firstName', 'FirstName'],
      ['lead.lastName', 'LastName'],
      ['lead.company', 'Company'],
      ['lead.email', 'Email'],
      ['lead.phone', 'Phone'],
      ['lead.mobilePhone', 'MobilePhone'],
      ['lead.jobTitle', 'Title'],
      ['lead.website', 'Website'],
      ['lead.addressLine1', 'Street'],
      ['lead.city', 'City'],
      ['lead.state', 'State'],
      ['lead.postalCode', 'PostalCode'],
      ['lead.country', 'Country'],
      ['lead.status', 'Status'],
      ['lead.leadSource', 'LeadSource'],
      ['lead.rating', 'Rating'],
      ['lead.industry', 'Industry'],
      ['lead.employeeCount', 'NumberOfEmployees'],
      ['lead.annualRevenue', 'AnnualRevenue'],
      ['lead.description', 'Description'],
      ['lead.doNotCall', 'DoNotCall'],
      ['lead.doNotEmail', 'HasOptedOutOfEmail'],
    ];
    for (const [field, header] of expected) {
      assert.equal(vendorHeader(lead!, field as never)?.header, header, field);
    }
  });

  it('claims no destination-side deduplication, because org duplicate rules are configuration', () => {
    for (const spec of adapter.objects) {
      assert.deepEqual(spec.destinationMatchingKeys, [], `${spec.object} must not claim automatic matching`);
    }
  });

  it('asserts no per-file row cap, because the documented figure is a daily allowance', () => {
    assert.equal(adapter.fileConstraints.maxRowsPerFile, null);
  });

  it('uses the documented field limit rather than the header-row limit', () => {
    assert.equal(adapter.fileConstraints.maxFieldCharacters, 131_072);
    assert.equal(adapter.fileConstraints.maxHeaderRowCharacters, 32_000);
  });

  it('spells the parent lookup the way each import path actually wants it', () => {
    // Qualification against a real org found this: Data Loader's mapping file
    // addresses a parent by external id with a COLON and refuses the dotted
    // form outright as an invalid mapping. The dotted form is the Bulk API CSV
    // header. Data Loader is the qualified path for this envelope, so telling
    // an operator only the dotted form told them the wrong thing for the tool
    // the gate requires.
    const support = adapter.relationships.CONTACT_TO_COMPANY;
    assert.equal(support.kind, 'SUPPORTED');
    if (support.kind !== 'SUPPORTED') return;
    assert.ok(support.operatorInstructions.includes('Account:Kauro_Key__c'), 'the Data Loader form must be stated');
    assert.ok(support.operatorInstructions.includes('Account.Kauro_Key__c'), 'the Bulk API form must be stated');
    assert.ok(/Data Loader/.test(support.operatorInstructions), 'it must say which form belongs to which tool');
    // The __r form is for custom-object relationships and is still not this.
    assert.ok(!support.operatorInstructions.includes('Relationship__r'));
  });

  it('supports the two standard lookups and refuses the one that is a junction object', () => {
    assert.equal(adapter.relationships.CONTACT_TO_COMPANY.kind, 'SUPPORTED');
    assert.equal(adapter.relationships.COMPANY_TO_DEAL.kind, 'SUPPORTED');
    const support = adapter.relationships.CONTACT_TO_DEAL;
    assert.equal(support.kind, 'UNSUPPORTED');
    if (support.kind !== 'UNSUPPORTED') return;
    // There is no Contact lookup on Opportunity to write to, so the honest
    // answer is a refusal that names the object the operator must go through.
    assert.ok(support.reason.includes('OpportunityContactRole'));
  });
});

describe('the source registry', () => {
  it('lists every URL the adapters cite', () => {
    const registry = readFileSync(join(repoRoot(), 'docs', 'SOURCE_REGISTRY.md'), 'utf8');
    for (const adapter of ALL_ADAPTERS) {
      if (adapter.mode === 'CLEAN_ONLY') continue;
      for (const source of adapter.sources) {
        assert.ok(registry.includes(source.url), `${source.url} is not in docs/SOURCE_REGISTRY.md`);
      }
    }
  });

  it('records what cannot be checked without the customer account', () => {
    for (const adapter of ALL_ADAPTERS) {
      if (adapter.mode === 'CLEAN_ONLY') continue;
      assert.ok(
        adapter.instanceVerification.length >= 4,
        `${adapter.mode} should name what it cannot verify offline`,
      );
      for (const item of adapter.instanceVerification) {
        assert.ok(item.sourceUrl.startsWith('https://'), 'each item must cite a page');
      }
    }
  });
});

/**
 * Vendor fidelity.
 *
 * The same source bundle as the G38 golden case, rendered for each real
 * destination, read back with this repository's own CSV reader, and compared
 * cell by cell against the value the engine decided to deliver. The boundary
 * under test is the one an adapter must never cross: it chooses headers and a
 * layout, and it does not get to re-interpret a finished value. CSV quoting is
 * not corruption as long as parsing returns the value exactly.
 */
describe('a delivered value survives the vendor renderer unchanged', () => {
  const CASE_ID = 'G38-agency-normal-cleaning';

  /** The contract, written out rather than read back from the run. */
  const EXPECTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    // Trimmed and title-cased, an email whose domain was lowercased while its
    // local part was not, a national number read with the declared country, a
    // date read with the declared format, a composed job title, a mapped
    // category, and two custom fields.
    '1': {
      'contact.firstName': 'Miguel',
      'contact.email': 'MIGUEL.LOPEZ@acme.example',
      'contact.phone': '+573011234567',
      'contact.jobTitle': 'Diseñadora Sénior'.normalize('NFC'),
      'custom:Signup Date': '2024-03-07',
      'custom:Segment': 'Customer',
    },
    // The exact mapped exception the mechanical case rule could not reach.
    '4': { 'contact.lastName': 'McDonald', 'contact.firstName': 'Ronald' },
  };

  const COMPANY_EXPECTED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    K1: { 'company.name': 'Acme Logistics', 'custom:Segment': 'Customer' },
  };

  for (const mode of ['HUBSPOT', 'SALESFORCE'] as const) {
    describe(mode, () => {
      const adapter = getAdapter(mode);
      const scratch = scratchDir(`vendor-fidelity-${mode}`);
      const configPath = join(scratch, 'config.json');
      const source = parseJson(
        readFileSync(join(GOLDEN_ROOT, CASE_ID, 'config.json'), 'utf8'),
      ) as JsonObject;
      writeFileSync(
        configPath,
        JSON.stringify({ ...source, target: { mode, importMode: 'CREATE_ONLY' } }, null, 2),
        'utf8',
      );

      const run = runFixture(GOLDEN_ROOT, CASE_ID, {
        configPath,
        scratchName: `vendor-fidelity-${mode}-package`,
      });

      const headerFor = (object: 'CONTACT' | 'COMPANY', field: string): string => {
        if (field.startsWith('custom:')) {
          return adapter.customFieldHeader(field.slice('custom:'.length));
        }
        const spec = objectSpec(adapter, object);
        assert.ok(spec !== null, `${mode} has no ${object} spec`);
        const entry = vendorHeader(spec, field as Parameters<typeof vendorHeader>[1]);
        assert.ok(entry !== null, `${mode} does not carry ${field}`);
        return entry.header;
      };

      const check = (
        object: 'CONTACT' | 'COMPANY',
        expected: Readonly<Record<string, Readonly<Record<string, string>>>>,
      ): void => {
        const spec = objectSpec(adapter, object);
        assert.ok(spec !== null);
        const table = readTable(run.packageDir, `01_IMPORT/${adapter.importDirectory}/${spec.fileName}`);
        const crosswalk = readTable(run.packageDir, 'import-crosswalk.csv');

        for (const [sourceRecordId, fields] of Object.entries(expected)) {
          const record = collect(run.result.truth.deliveredRecords).find(
            (entry) => entry.object === object && entry.sourceRecordId === sourceRecordId,
          );
          assert.ok(record !== undefined, `${mode}: ${object} ${sourceRecordId} was not delivered`);

          // The import file does not name the record; the crosswalk does. Its
          // rows are in the same order as the file, so the position is the join.
          const crosswalkIndex = crosswalk.rows.findIndex(
            (entry) =>
              (entry['import_path'] ?? '') === `01_IMPORT/${adapter.importDirectory}/${spec.fileName}` &&
              (entry['migration_key'] ?? '') === record.migrationKey,
          );
          assert.ok(crosswalkIndex !== -1, `${mode}: ${record.migrationKey} is in no crosswalk row`);
          const rowNumber = Number(crosswalk.rows[crosswalkIndex]?.['import_row_number'] ?? '0');
          const row = table.rows[rowNumber - 1];
          assert.ok(row !== undefined, `${mode}: no ${spec.fileName} row for ${sourceRecordId}`);

          for (const [field, value] of Object.entries(fields)) {
            const header = headerFor(object, field);
            // The engine decided this value...
            assert.equal(record.values[field], value, `${mode}: delivered ${field}`);
            // ...and the import file gives back exactly the same one.
            assert.equal(row[header], value, `${mode}: ${spec.fileName} column "${header}"`);
          }
        }
      };

      it('delivers every contact value unchanged through the import file', () => {
        check('CONTACT', EXPECTED);
      });

      it('delivers every company value unchanged through the import file', () => {
        check('COMPANY', COMPANY_EXPECTED);
      });

      it('carries the relationship into the import package', () => {
        const table = readTable(
          run.packageDir,
          `01_IMPORT/${adapter.importDirectory}/associations/contact_to_company.csv`,
        );
        assert.equal(table.rows.length, 5, `${mode}: every resolved relationship must be written`);
        const contact = collect(run.result.truth.deliveredRecords).find(
          (entry) => entry.object === 'CONTACT' && entry.sourceRecordId === '1',
        );
        const company = collect(run.result.truth.deliveredRecords).find(
          (entry) => entry.object === 'COMPANY' && entry.sourceRecordId === 'K1',
        );
        assert.ok(contact !== undefined && company !== undefined);
        // The association file pairs records by their import key, which is
        // derived from the run and the migration key and is not the trace key.
        assert.ok(
          table.rows.some(
            (row) =>
              row[adapter.associationFromHeader] === importKeyFor(run.result.truth.runId, contact.migrationKey) &&
              row[adapter.associationToHeader] === importKeyFor(run.result.truth.runId, company.migrationKey),
          ),
          `${mode}: the contact-to-company relationship is missing`,
        );
      });

      it('delivers the same records the vendor-neutral run does', () => {
        // The destination decides headers and layout. It does not decide which
        // records are deliverable, and none of these values trips a limit.
        assert.deepEqual(run.verification.problems, []);
        assert.equal(run.result.reconciliation.records.byObject.CONTACT, 5);
        assert.equal(run.result.reconciliation.records.byObject.COMPANY, 2);
        assert.equal(run.result.reconciliation.sourceRows.byDisposition.ISOLATED, 0);
        assert.equal(run.result.reconciliation.destination.keyConflicts, 0);
      });
    });
  }
});
