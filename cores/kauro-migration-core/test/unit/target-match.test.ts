import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { getAdapter } from '../../src/adapters/specs.js';
import { isMigrationError } from '../../src/domain/errors.js';
import type { DestinationMatchConfig, MigrationConfig, TargetMode } from '../../src/domain/config.js';
import { hashTargetContract, loadTargetContract, serializeTargetContract } from '../../src/target/contract.js';
import type { TargetContract, TargetFieldContract, TargetFlag } from '../../src/target/contract.js';
import { resolveMatchAuthority } from '../../src/target/match-authority.js';

/**
 * Destination match authority.
 *
 * These cases are the separation the engine exists to hold: a Kauro trace key
 * names a delivered record, and naming is not authority to match. Every refusal
 * below is a way somebody's records get silently merged or silently duplicated
 * if the rule is dropped.
 */

function field(overrides: Partial<TargetFieldContract> = {}): TargetFieldContract {
  return {
    apiName: 'Legacy_Id__c',
    label: 'Legacy Id',
    type: 'string',
    createable: 'TRUE',
    updateable: 'TRUE',
    nillable: 'TRUE',
    length: 64,
    precision: null,
    scale: null,
    unique: 'TRUE',
    externalId: 'TRUE',
    idLookup: 'TRUE',
    calculated: 'FALSE',
    autoNumber: 'FALSE',
    defaultedOnCreate: 'FALSE',
    restrictedPicklist: 'FALSE',
    picklistValues: [],
    referenceTo: [],
    relationshipName: null,
    evidence: 'ARTIFACT',
    ...overrides,
  };
}

function contract(mode: TargetMode, fields: readonly TargetFieldContract[]): TargetContract {
  return {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: { mode, instanceId: '00D000000000001', instanceLabel: 'test org', evidence: 'ARTIFACT' },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects: [{ apiName: 'Contact', label: 'Contact', createable: 'TRUE', updateable: 'TRUE', fields, recordTypes: [] }],
    pipelines: [],
  };
}

function config(
  mode: TargetMode,
  importMode: MigrationConfig['target']['importMode'],
  matching: readonly Partial<DestinationMatchConfig>[],
): MigrationConfig {
  return {
    configVersion: '3.0.0',
    source: { system: 'crm', namespace: 'acme', encoding: null },
    target: { mode, importMode },
    localeEvidence: { phoneCountry: null, dateFormat: null, decimalSeparator: null, thousandsSeparator: null },
    limits: {
      maxFiles: 1,
      maxBytesPerFile: 1,
      maxTotalBytes: 1,
      maxSheetsPerFile: 1,
      maxRowsPerSheet: 1,
      maxColumnsPerSheet: 1,
      maxCellLength: 1,
      maxWorkbookUncompressedBytes: 1,
      maxWorkbookPartUncompressedBytes: 1,
      maxRecordBytes: 1,
    },
    policies: {
      rowShapeMismatch: 'REJECT_ROW',
      blankRow: 'REJECT_ROW',
      formulaCachedValues: 'ISOLATE_ROW',
      destinationKeyConflict: 'ISOLATE',
      mergeFieldConflict: 'ISOLATE_RECORD',
      mergeFieldConflictJustification: null,
    },
    files: [{ id: 'contacts', path: 'c.csv', format: 'CSV', encoding: null, delimiter: null, sourceSystem: null, sourceNamespace: null, sheets: null }],
    records: [
      {
        id: 'contacts',
        fileId: 'contacts',
        sheet: null,
        identitySpace: null,
        object: 'CONTACT',
        sourceRecordIdColumn: null,
        authoritativeExternalIdColumns: [],
        fields: [],
      },
    ],
    associations: [],
    destinationMatching: matching.map((entry) => ({
      recordMappingId: 'contacts',
      matchAuthority: 'EXTERNAL_ID',
      targetField: 'Legacy_Id__c',
      sourceField: 'contact.email',
      onMissingMatch: 'ISOLATE',
      onMatchConflict: 'ISOLATE',
      ...entry,
    })),
    occurrences: [],
  };
}

function refusal(run: () => unknown, fragment: string): void {
  assert.throws(run, (error: unknown) => {
    if (!isMigrationError(error)) return false;
    assert.equal(error.code, 'DESTINATION_MATCH_UNSATISFIED', error.message);
    assert.ok(
      error.message.includes(fragment) || error.remedy.includes(fragment),
      `expected a refusal mentioning "${fragment}", got: ${error.message} / ${error.remedy}`,
    );
    return true;
  });
}

describe('destination match authority', () => {
  const salesforce = getAdapter('SALESFORCE');
  const hubspot = getAdapter('HUBSPOT');

  it('accepts an external id the instance establishes as external, unique and usable for lookup', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field()]));
    const [decision] = resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed);
    assert.equal(decision?.matchAuthority, 'EXTERNAL_ID');
    assert.equal(decision?.targetField, 'Legacy_Id__c');
    assert.equal(decision?.contractHash, hashed.contractHash);
  });

  it('refuses the Kauro trace key as a match key, even where the instance carries a field by that name', () => {
    // The whole separation. If this passes, Kauro is asking an agency to carry a
    // Kauro-shaped field inside their own org so that Kauro can match on it.
    const traceKey = field({ apiName: salesforce.associationKeyHeader });
    const hashed = hashTargetContract(contract('SALESFORCE', [traceKey]));
    refusal(
      () =>
        resolveMatchAuthority(
          config('SALESFORCE', 'UPSERT', [{ targetField: salesforce.associationKeyHeader }]),
          salesforce,
          hashed,
        ),
      'trace key',
    );
  });

  it('refuses the trace key by any spelling the destination would resolve', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field({ apiName: 'kauro_trace_key__c' })]));
    refusal(
      () =>
        resolveMatchAuthority(
          config('SALESFORCE', 'UPSERT', [{ targetField: salesforce.associationKeyHeader.toLowerCase() }]),
          salesforce,
          hashed,
        ),
      'trace key',
    );
  });

  it('refuses an external id the instance does not also establish as unique', () => {
    // Marking a Salesforce field External ID does not make it Unique. An upsert
    // against a non-unique external id can match two records, and one of them
    // loses. Salesforce documents these as separate attributes and so does this.
    for (const unique of ['FALSE', 'UNKNOWN'] as TargetFlag[]) {
      const hashed = hashTargetContract(contract('SALESFORCE', [field({ unique })]));
      refusal(
        () => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed),
        'REQUIRES_AGENCY_DECISION',
      );
    }
  });

  it('refuses an external id the describe does not report as usable to name a record', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field({ idLookup: 'UNKNOWN' })]));
    refusal(() => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed), 'idLookup');
  });

  it('treats an unestablished attribute as unestablished, not as false and not as true', () => {
    const hashed = hashTargetContract(contract('HUBSPOT', [field({ unique: 'UNKNOWN', externalId: 'UNKNOWN' })]));
    refusal(
      () =>
        resolveMatchAuthority(
          config('HUBSPOT', 'UPDATE_ONLY', [{ matchAuthority: 'TARGET_UNIQUE_FIELD' }]),
          hubspot,
          hashed,
        ),
      'unique values',
    );
  });

  it('refuses a field the captured contract does not carry, and says whose decision that is', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field({ apiName: 'Something_Else__c' })]));
    refusal(
      () => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed),
      'REQUIRES_AGENCY_DECISION',
    );
  });

  it('refuses a field the instance computes rather than accepts', () => {
    for (const overrides of [{ calculated: 'TRUE' as TargetFlag }, { autoNumber: 'TRUE' as TargetFlag }]) {
      const hashed = hashTargetContract(contract('SALESFORCE', [field(overrides)]));
      refusal(() => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed), 'read-only');
    }
  });

  it('refuses a field the instance does not report as updateable', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field({ updateable: 'UNKNOWN' })]));
    refusal(() => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed), 'updateable');
  });

  it('refuses a contract captured from a different destination', () => {
    const hashed = hashTargetContract(contract('HUBSPOT', [field()]));
    refusal(() => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, hashed), 'describes HUBSPOT');
  });

  it('refuses a matching run with no captured contract at all', () => {
    refusal(() => resolveMatchAuthority(config('SALESFORCE', 'UPSERT', [{}]), salesforce, null), 'needs a captured target contract');
  });

  it('refuses a match declaration on a create-only import', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', [field()]));
    refusal(
      () => resolveMatchAuthority(config('SALESFORCE', 'CREATE_ONLY', [{}]), salesforce, hashed),
      'never matches an existing record',
    );
  });

  it('refuses a matching run against CLEAN_ONLY, which has no instance', () => {
    refusal(
      () => resolveMatchAuthority(config('CLEAN_ONLY', 'UPSERT', [{}]), getAdapter('CLEAN_ONLY'), null),
      'no destination instance',
    );
  });

  it('accepts the destination record id without needing a captured field for it', () => {
    // A record id is the vendor's own identifier, not something Kauro introduces,
    // so it is the one authority that needs nothing captured.
    const hashed = hashTargetContract(contract('SALESFORCE', []));
    const [decision] = resolveMatchAuthority(
      config('SALESFORCE', 'UPDATE_ONLY', [{ matchAuthority: 'RECORD_ID', targetField: null }]),
      salesforce,
      hashed,
    );
    assert.equal(decision?.targetField, 'Id');
  });

  it('refuses a record id declaration that names something other than the record id', () => {
    const hashed = hashTargetContract(contract('SALESFORCE', []));
    refusal(
      () =>
        resolveMatchAuthority(
          config('SALESFORCE', 'UPDATE_ONLY', [{ matchAuthority: 'RECORD_ID', targetField: 'Legacy_Id__c' }]),
          salesforce,
          hashed,
        ),
      'rather than "Id"',
    );
  });

  it('names the contract by its content, and the same content twice by the same name', () => {
    const first = hashTargetContract(contract('SALESFORCE', [field()]));
    const second = hashTargetContract(contract('SALESFORCE', [field()]));
    assert.equal(first.contractHash, second.contractHash);
    assert.ok(first.contractHash.startsWith('tc_'));

    // A contract edited after capture is a different contract. This is what
    // stops a captured attribute being upgraded on the way to the decision.
    const tampered = hashTargetContract(contract('SALESFORCE', [field({ unique: 'FALSE' })]));
    assert.notEqual(first.contractHash, tampered.contractHash);
  });

  it('covers every field in the digest, so no attribute can change without the name changing', () => {
    const base = hashTargetContract(contract('SALESFORCE', [field()]));
    const changes: Partial<TargetFieldContract>[] = [
      { apiName: 'Other__c' },
      { label: 'Other' },
      { type: 'int' },
      { createable: 'FALSE' },
      { updateable: 'FALSE' },
      { nillable: 'FALSE' },
      { length: 65 },
      { precision: 1 },
      { scale: 1 },
      { unique: 'FALSE' },
      { externalId: 'FALSE' },
      { idLookup: 'FALSE' },
      { calculated: 'TRUE' },
      { autoNumber: 'TRUE' },
      { defaultedOnCreate: 'TRUE' },
      { restrictedPicklist: 'TRUE' },
      { picklistValues: [{ value: 'a', label: 'A', active: true, defaultValue: false }] },
      { referenceTo: ['Account'] },
      { relationshipName: 'Account' },
      { evidence: 'SUPPLEMENT' },
    ];
    for (const change of changes) {
      const other = hashTargetContract(contract('SALESFORCE', [field(change)]));
      assert.notEqual(
        other.contractHash,
        base.contractHash,
        `changing ${Object.keys(change).join(', ')} left the contract hash unchanged, so a tampered contract would keep its name`,
      );
    }
  });
});

describe('a captured contract, read back', () => {
  const original = hashTargetContract(contract('SALESFORCE', [field()]));

  function refusesLoad(text: string, fragment: string): void {
    assert.throws(
      () => loadTargetContract(text, 'contract.json'),
      (error: unknown) => {
        if (!isMigrationError(error)) return false;
        assert.equal(error.code, 'TARGET_CONTRACT_INVALID', error.message);
        assert.ok(
          error.message.includes(fragment) || error.remedy.includes(fragment),
          `expected a refusal mentioning "${fragment}", got: ${error.message} / ${error.remedy}`,
        );
        return true;
      },
    );
  }

  it('round-trips a contract without changing its name', () => {
    const loaded = loadTargetContract(serializeTargetContract(original), 'contract.json');
    assert.equal(loaded.contractHash, original.contractHash);
    assert.equal(loaded.contract.instance.instanceId, '00D000000000001');
  });

  it('refuses a contract edited after capture', () => {
    // The whole value of a captured contract is that it is evidence. Evidence
    // that can be edited on the way to the decision is not evidence, so the
    // digest is recomputed on read rather than believed.
    const tampered = serializeTargetContract(original).replace('"unique": "TRUE"', '"unique": "FALSE"');
    assert.notEqual(tampered, serializeTargetContract(original), 'the test did not actually change anything');
    refusesLoad(tampered, 'does not hash to the digest it claims');
  });

  it('refuses a contract whose name was rewritten to match an edit', () => {
    // Editing the content and then editing the claimed digest to whatever the
    // editor liked still fails, because the digest is computed from content.
    const edited = serializeTargetContract(original)
      .replace('"unique": "TRUE"', '"unique": "FALSE"')
      .replace(original.contractHash, 'tc_0000000000000000000000000000000000000000000000000000000000000000');
    refusesLoad(edited, 'does not hash to the digest it claims');
  });

  it('refuses a file that is not a contract at all', () => {
    refusesLoad('not json', 'not valid JSON');
    refusesLoad('[]', 'not a target contract');
    refusesLoad('{"contract":{}}', 'both a contract and the digest');
    refusesLoad(
      `{"contractHash":"tc_x","contract":{"contractVersion":"1.0.0"}}`,
      'not shaped like a target contract',
    );
  });
});

/**
 * What a real HubSpot portal corrected.
 *
 * Every case below failed against portal 51872453 before the engine was changed,
 * and each failure was a way the HubSpot half of V1 was either unusable or
 * unsafe. They are kept apart from the cases above because they are not
 * hypotheses: they are what a portal did.
 */
describe('destination match authority, as a real HubSpot portal settled it', () => {
  const hubspot = getAdapter('HUBSPOT');

  /** HubSpot establishes neither External ID nor idLookup, and never will. */
  function hubspotField(overrides: Partial<TargetFieldContract> = {}): TargetFieldContract {
    return field({
      apiName: 'email',
      label: 'Email',
      externalId: 'UNKNOWN',
      idLookup: 'UNKNOWN',
      ...overrides,
    });
  }

  function hubspotContract(fields: readonly TargetFieldContract[]): TargetContract {
    return { ...contract('HUBSPOT', fields), instance: { mode: 'HUBSPOT', instanceId: '51872453', instanceLabel: 'developer test portal', evidence: 'ARTIFACT' } };
  }

  const match = (overrides: Partial<DestinationMatchConfig> = {}): MigrationConfig =>
    config('HUBSPOT', 'UPSERT', [{ matchAuthority: 'TARGET_UNIQUE_FIELD', targetField: 'email', ...overrides }]);

  it('matches on a property the portal reports as unique and writable', () => {
    // This is the case that did not work. The property export carries whether a
    // property's value is read-only, and the parser was discarding it, so every
    // HubSpot field reached this module with updateability UNKNOWN — which is
    // refused. Nothing could be matched on, and UPSERT against HubSpot was
    // unreachable for every portal, not just this one.
    const hashed = hashTargetContract(hubspotContract([hubspotField()]));
    const [decision] = resolveMatchAuthority(match(), hubspot, hashed);
    assert.equal(decision?.matchAuthority, 'TARGET_UNIQUE_FIELD');
    assert.equal(decision?.resolvedField?.apiName, 'email');
    assert.equal(decision?.contractHash, hashed.contractHash);
  });

  it('refuses a property whose value the portal reports read-only', () => {
    const hashed = hashTargetContract(hubspotContract([hubspotField({ updateable: 'FALSE' })]));
    refusal(() => resolveMatchAuthority(match(), hubspot, hashed), 'updateable');
  });

  it('refuses a property the portal computes', () => {
    const hashed = hashTargetContract(hubspotContract([hubspotField({ calculated: 'TRUE' })]));
    refusal(() => resolveMatchAuthority(match(), hubspot, hashed), 'computes');
  });

  it('refuses a writable property the portal does not report as unique', () => {
    const hashed = hashTargetContract(hubspotContract([hubspotField({ apiName: 'firstname', unique: 'FALSE' })]));
    refusal(() => resolveMatchAuthority(match({ targetField: 'firstname' }), hubspot, hashed), 'REQUIRES_AGENCY_DECISION');
  });

  it('refuses a writable property whose uniqueness nobody stated', () => {
    const hashed = hashTargetContract(hubspotContract([hubspotField({ unique: 'UNKNOWN' })]));
    refusal(() => resolveMatchAuthority(match(), hubspot, hashed), 'REQUIRES_AGENCY_DECISION');
  });

  it('refuses EXTERNAL_ID against HubSpot, which has no such attribute', () => {
    // It was refused before this, but by telling the agency to go and mark the
    // property External ID in their portal — an instruction HubSpot gives them
    // no way to follow.
    const hashed = hashTargetContract(hubspotContract([hubspotField()]));
    refusal(() => resolveMatchAuthority(match({ matchAuthority: 'EXTERNAL_ID' }), hubspot, hashed), 'HubSpot does not have');
  });

  it('refuses the trace key spelled the way a HubSpot property would be named', () => {
    // The hole this closed. Kauro writes the column "Kauro Trace Key", but a
    // HubSpot internal name is lower case with underscores, so the property an
    // agency creates to hold it is `kauro_trace_key` — and case folding alone
    // does not see those as one name. Declared as the match authority, it went
    // straight past the guard; had the portal carried the property and a
    // supplement called it unique, Kauro would have matched on its own trace key.
    for (const spelling of ['kauro_trace_key', 'KAURO_TRACE_KEY', 'kauro-trace-key', 'kaurotracekey', 'Kauro Trace Key']) {
      const hashed = hashTargetContract(hubspotContract([hubspotField({ apiName: spelling })]));
      refusal(() => resolveMatchAuthority(match({ targetField: spelling }), hubspot, hashed), 'trace key');
    }
  });

  it('still refuses a field that merely resembles the trace key', () => {
    // Folding separators must not fold two different names together. This one
    // is a property an agency could legitimately own, and it has to survive.
    const hashed = hashTargetContract(hubspotContract([hubspotField({ apiName: 'kauro_trace_key_source' })]));
    const [decision] = resolveMatchAuthority(match({ targetField: 'kauro_trace_key_source' }), hubspot, hashed);
    assert.equal(decision?.matchAuthority, 'TARGET_UNIQUE_FIELD');
  });
});

/**
 * Found by the final adversarial pass, against the engine rather than a package.
 *
 * The trace-key guard checked only the running adapter's spelling, so a HubSpot
 * run naming `Kauro_Trace_Key__c` — the Salesforce spelling — was accepted. It is
 * still a Kauro trace key, and which destination a run happens to target does not
 * change what the column is.
 */
describe('the trace key of any destination is not a match key for any other', () => {
  const hubspot = getAdapter('HUBSPOT');
  const salesforce = getAdapter('SALESFORCE');

  const contractFor = (mode: TargetMode, apiName: string): TargetContract => ({
    ...contract(mode, [field({ apiName, externalId: 'TRUE', idLookup: 'TRUE', unique: 'TRUE' })]),
    instance: { mode, instanceId: '51872453', instanceLabel: 'test instance', evidence: 'ARTIFACT' },
  });

  const declare = (mode: TargetMode, targetField: string): MigrationConfig =>
    config(mode, 'UPSERT', [
      { matchAuthority: mode === 'HUBSPOT' ? 'TARGET_UNIQUE_FIELD' : 'EXTERNAL_ID', targetField },
    ]);

  it('refuses the Salesforce trace key spelling under HubSpot', () => {
    refusal(
      () => resolveMatchAuthority(declare('HUBSPOT', 'kauro_trace_key__c'), hubspot, hashTargetContract(contractFor('HUBSPOT', 'kauro_trace_key__c'))),
      'trace key',
    );
  });

  it('refuses the HubSpot trace key spelling under Salesforce', () => {
    refusal(
      () => resolveMatchAuthority(declare('SALESFORCE', 'Kauro Trace Key'), salesforce, hashTargetContract(contractFor('SALESFORCE', 'Kauro Trace Key'))),
      'trace key',
    );
  });

  it('refuses an association header of either destination', () => {
    for (const spelling of [hubspot.associationToHeader, salesforce.associationToHeader]) {
      refusal(
        () => resolveMatchAuthority(declare('HUBSPOT', spelling), hubspot, hashTargetContract(contractFor('HUBSPOT', spelling))),
        'trace key',
      );
    }
  });

  it('still accepts a field whose name only resembles one of them', () => {
    // The boundary. Folding this into the refusal would block a property an
    // agency may legitimately own, and would not make anything safer: the value
    // in it was never written by Kauro.
    const hashed = hashTargetContract(contractFor('HUBSPOT', 'kauro_trace_key_source'));
    const [decision] = resolveMatchAuthority(declare('HUBSPOT', 'kauro_trace_key_source'), hubspot, hashed);
    assert.equal(decision?.matchAuthority, 'TARGET_UNIQUE_FIELD');
  });
});
