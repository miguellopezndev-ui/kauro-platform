import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getAdapter } from '../src/adapters/specs.js';
import { isMigrationError } from '../src/domain/errors.js';
import type { MigrationConfig, TargetMode } from '../src/domain/config.js';
import { loadConfig } from '../src/mapping/load-config.js';
import { buildSourceProfile, hashSourceProfile } from '../src/profile/source-profile.js';
import type { HashedSourceProfile } from '../src/profile/source-profile.js';
import { runMigration } from '../src/run/run-migration.js';
import type { RunInput } from '../src/run/run-migration.js';
import { hashTargetContract } from '../src/target/contract.js';
import type { HashedTargetContract, TargetContract, TargetFieldContract, TargetFlag, TargetObjectContract } from '../src/target/contract.js';
import { resolveMatchAuthority } from '../src/target/match-authority.js';
import { attestContract } from '../tools/attestation-fixture.js';
import { caseScratch, repoRoot } from './support/harness.js';

/**
 * MC-3 reopen, runtime lot: audit KAURO_AUDITORIA_MC_IC_20260911_V1 findings
 * MC-01 (mode not bound to the attested contract), MC-02 (match authority
 * borrowed from another object) and MC-03 (hashed inputs not re-established
 * at the engine boundary).
 *
 * Every negative case here was accepted by the frozen main; every positive
 * control is a genuine input that still runs.
 */

const FIXTURES = join(repoRoot(), 'test', 'fixtures', 'value-intent');
const INPUT = join(FIXTURES, 'input');

function field(overrides: Partial<TargetFieldContract> = {}): TargetFieldContract {
  return {
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
    ...overrides,
  };
}

function object(apiName: string, fields: readonly TargetFieldContract[]): TargetObjectContract {
  return { apiName, label: apiName, createable: 'TRUE', updateable: 'TRUE', fields, recordTypes: [] };
}

function contractOf(mode: TargetMode, objects: readonly TargetObjectContract[]): HashedTargetContract {
  const contract: TargetContract = {
    contractVersion: '1.0.0',
    parserVersion: '1.0.0',
    capturedAt: '2026-09-01T00:00:00Z',
    instance: {
      mode,
      instanceId: mode === 'HUBSPOT' ? '00000001' : '00D000000000001',
      instanceLabel: 'mc3 reopen fixture instance',
      evidence: 'ARTIFACT',
    },
    artifacts: [{ path: 'describe/Contact.json', sha256: 'a'.repeat(64), byteLength: 10, kind: 'DESCRIBE' }],
    objects,
    pipelines: [],
  };
  return hashTargetContract(contract);
}

/**
 * The contract the value-intent configurations run against: one Contact object
 * with a unique email and the three other fields the plan delivers. Destination
 * validation consumes the contract (MC-04), so the fields the plan writes have
 * to be ones the instance describes; only the email carries match authority.
 */
function vendorContract(mode: TargetMode): HashedTargetContract {
  const contactName = mode === 'HUBSPOT' ? 'contact' : 'Contact';
  const plain = (apiName: string, label: string): TargetFieldContract =>
    field({ apiName, label, unique: 'FALSE', idLookup: 'FALSE' });
  const others =
    mode === 'HUBSPOT'
      ? [plain('firstname', 'First name'), plain('lastname', 'Last name'), plain('jobtitle', 'Job title')]
      : [plain('FirstName', 'First Name'), plain('LastName', 'Last Name'), plain('Title', 'Title')];
  return contractOf(mode, [object(contactName, [field(), ...others])]);
}

function loadAt(name: string): { config: MigrationConfig; configHash: string } {
  const path = join(FIXTURES, `${name}.json`);
  const loaded = loadConfig(readFileSync(path, 'utf8'), path);
  return { config: loaded.config, configHash: loaded.configHash };
}

function withMode(config: MigrationConfig, mode: TargetMode): MigrationConfig {
  return { ...config, target: { ...config.target, mode } };
}

let counter = 0;
function inputFor(config: MigrationConfig, configHash: string, contract: HashedTargetContract | null, extra: Partial<RunInput> = {}): RunInput {
  counter += 1;
  const attested = contract === null ? {} : attestContract(contract);
  return {
    inputRoot: INPUT,
    config,
    configHash,
    scratch: caseScratch(`mc3reopen${String(counter)}`),
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

describe('MC-01: the configured mode is bound to the attested contract before the source is read', () => {
  const crmConfigs: readonly { name: string; importMode: string }[] = [
    { name: 'hubspot-create', importMode: 'CREATE_ONLY' },
    { name: 'hubspot-update', importMode: 'UPDATE_ONLY' },
    { name: 'salesforce-update', importMode: 'UPDATE_ONLY' },
  ];

  for (const { name, importMode } of crmConfigs) {
    const loaded = loadAt(name);
    const mode = loaded.config.target.mode;
    const other: TargetMode = mode === 'HUBSPOT' ? 'SALESFORCE' : 'HUBSPOT';

    it(`${mode} ${importMode}: a genuine contract and attestation for ${mode} still runs`, () => {
      const run = runMigration(inputFor(loaded.config, loaded.configHash, vendorContract(mode)));
      assert.equal(run.reconciliation.sourceRows.equationHolds, true);
      assert.equal(run.truth.mode, mode);
    });

    it(`${mode} ${importMode}: a validly signed ${other} contract is refused before any source read (audit MC-wrong-mode-attestation)`, () => {
      const foreign = vendorContract(other);
      refused(
        () => runMigration(inputFor(loaded.config, loaded.configHash, foreign, { inputRoot: join(FIXTURES, 'does-not-exist') })),
        'TARGET_CONTRACT_INVALID',
        `describing ${other}`,
      );
    });

    it(`${mode} ${importMode}: an attestation whose subject names ${other} is refused even over a ${mode} contract`, () => {
      const contract = vendorContract(mode);
      const attested = attestContract(contract);
      const foreignSubject = {
        ...attested.targetAttestation,
        subject: { ...attested.targetAttestation.subject, mode: other },
      };
      refused(
        () =>
          runMigration(
            inputFor(loaded.config, loaded.configHash, contract, { ...attested, targetAttestation: foreignSubject }),
          ),
        'TARGET_CONTRACT_INVALID',
      );
    });
  }

  it('CREATE_ONLY under SALESFORCE refuses a HUBSPOT contract at match resolution too', () => {
    const loaded = loadAt('hubspot-create');
    const asSalesforce = withMode(loaded.config, 'SALESFORCE');
    refused(
      () => resolveMatchAuthority(asSalesforce, getAdapter('SALESFORCE'), vendorContract('HUBSPOT')),
      'DESTINATION_MATCH_UNSATISFIED',
      'describes HUBSPOT',
    );
  });

  it('CREATE_ONLY under HUBSPOT refuses a SALESFORCE contract at match resolution too', () => {
    const loaded = loadAt('hubspot-create');
    refused(
      () => resolveMatchAuthority(loaded.config, getAdapter('HUBSPOT'), vendorContract('SALESFORCE')),
      'DESTINATION_MATCH_UNSATISFIED',
      'describes SALESFORCE',
    );
  });
});

describe('MC-02: match authority is resolved on the object the mapping delivers to', () => {
  const salesforce = getAdapter('SALESFORCE');
  const loaded = loadAt('salesforce-update');
  const externalId = (config: MigrationConfig): MigrationConfig => ({
    ...config,
    destinationMatching: [
      {
        recordMappingId: 'contacts',
        matchAuthority: 'EXTERNAL_ID',
        targetField: 'External_Key__c',
        sourceField: 'contact.email',
        onMissingMatch: 'ISOLATE',
        onMatchConflict: 'FAIL_RUN',
      },
    ],
  });
  const key = (unique: TargetFlag, extra: Partial<TargetFieldContract> = {}): TargetFieldContract =>
    field({ apiName: 'External_Key__c', label: 'External key', unique, externalId: 'TRUE', idLookup: 'TRUE', ...extra });

  for (const order of ['foreign-first', 'correct-first'] as const) {
    it(`refuses a Contact EXTERNAL_ID whose uniqueness only Account establishes (audit MC-match-object-${order})`, () => {
      const account = object('Account', [key('TRUE')]);
      const contact = object('Contact', [key('FALSE')]);
      const contract = contractOf('SALESFORCE', order === 'foreign-first' ? [account, contact] : [contact, account]);
      refused(
        () => resolveMatchAuthority(externalId(loaded.config), salesforce, contract),
        'DESTINATION_MATCH_UNSATISFIED',
        'not establish it as unique',
      );
      refused(
        () => runMigration(inputFor(externalId(loaded.config), loaded.configHash, contract)),
        'DESTINATION_MATCH_UNSATISFIED',
        'not establish it as unique',
      );
    });

    it(`accepts a Contact EXTERNAL_ID that Contact itself establishes, whatever Account says (${order})`, () => {
      const account = object('Account', [key('FALSE', { externalId: 'FALSE', idLookup: 'FALSE' })]);
      const contact = object('Contact', [key('TRUE')]);
      const contract = contractOf('SALESFORCE', order === 'foreign-first' ? [account, contact] : [contact, account]);
      const [decision] = resolveMatchAuthority(externalId(loaded.config), salesforce, contract);
      assert.equal(decision?.matchAuthority, 'EXTERNAL_ID');
      assert.equal(decision?.resolvedField?.unique, 'TRUE');
    });
  }

  it('refuses a field that exists only on another object, even where that object comes first', () => {
    const account = object('Account', [key('TRUE')]);
    const contact = object('Contact', [field()]);
    refused(
      () => resolveMatchAuthority(externalId(loaded.config), salesforce, contractOf('SALESFORCE', [account, contact])),
      'DESTINATION_MATCH_UNSATISFIED',
      'no field "External_Key__c" on Contact',
    );
  });

  it('refuses when the contract does not describe the object the mapping delivers to', () => {
    const account = object('Account', [key('TRUE')]);
    refused(
      () => resolveMatchAuthority(externalId(loaded.config), salesforce, contractOf('SALESFORCE', [account])),
      'DESTINATION_MATCH_UNSATISFIED',
      'describes no CONTACT object',
    );
  });

  it('refuses a contract that describes the object twice', () => {
    const contract = contractOf('SALESFORCE', [object('Contact', [key('TRUE')]), object('contact', [key('TRUE')])]);
    refused(
      () => resolveMatchAuthority(externalId(loaded.config), salesforce, contract),
      'DESTINATION_MATCH_UNSATISFIED',
      '2 times',
    );
  });

  for (const flag of ['unique', 'externalId', 'idLookup'] as const) {
    for (const value of ['FALSE', 'UNKNOWN'] as const) {
      it(`${flag}=${value} on Contact is refused although Account carries TRUE`, () => {
        const contact = object('Contact', [key('TRUE', { [flag]: value })]);
        const account = object('Account', [key('TRUE')]);
        refused(
          () => resolveMatchAuthority(externalId(loaded.config), salesforce, contractOf('SALESFORCE', [account, contact])),
          'DESTINATION_MATCH_UNSATISFIED',
        );
      });
    }
  }

  it('HubSpot: a unique property on companies does not authorise a contact TARGET_UNIQUE_FIELD', () => {
    const hub = loadAt('hubspot-update');
    const companies = object('companies', [field({ unique: 'TRUE' })]);
    const contacts = object('contacts', [field({ unique: 'FALSE' })]);
    refused(
      () => resolveMatchAuthority(hub.config, getAdapter('HUBSPOT'), contractOf('HUBSPOT', [companies, contacts])),
      'DESTINATION_MATCH_UNSATISFIED',
      'not established as requiring unique values',
    );
    const [decision] = resolveMatchAuthority(
      hub.config,
      getAdapter('HUBSPOT'),
      contractOf('HUBSPOT', [companies, object('contacts', [field({ unique: 'TRUE' })])]),
    );
    assert.equal(decision?.matchAuthority, 'TARGET_UNIQUE_FIELD');
  });
});

describe('MC-03: hashed inputs are re-established at the engine boundary and frozen', () => {
  const clean = loadAt('clean-only');
  function profiled(name: string): HashedSourceProfile {
    return buildSourceProfile({ inputRoot: INPUT, config: clean.config, scratch: caseScratch(name) });
  }
  function cloneProfile(hashed: HashedSourceProfile): { profile: HashedSourceProfile['profile']; profileHash: string } {
    return JSON.parse(JSON.stringify(hashed)) as { profile: HashedSourceProfile['profile']; profileHash: string };
  }

  it('a genuine profile still runs and is recorded', () => {
    const profile = profiled('mc3profile-genuine');
    const run = runMigration(inputFor(clean.config, clean.configHash, null, { sourceProfile: profile }));
    assert.equal(run.truth.sourceProfileHash, profile.profileHash);
  });

  it('refuses a profile whose hash was replaced (audit MC-profile-hash-only)', () => {
    const forged = cloneProfile(profiled('mc3profile-hash'));
    forged.profileHash = 'f'.repeat(64);
    refused(
      () => runMigration(inputFor(clean.config, clean.configHash, null, { sourceProfile: forged })),
      'SOURCE_PROFILE_INVALID',
      'does not hash to the digest it claims',
    );
  });

  it('refuses a profile whose totals were edited under a stale hash (audit MC-profile-body-with-stale-hash)', () => {
    const forged = cloneProfile(profiled('mc3profile-body'));
    (forged.profile.totals as { dataRowCount: number }).dataRowCount += 100;
    refused(
      () => runMigration(inputFor(clean.config, clean.configHash, null, { sourceProfile: forged })),
      'SOURCE_PROFILE_INVALID',
    );
    // Re-named honestly it is still refused, now by the bundle comparison: the
    // edit is not made acceptable by hashing it.
    const renamed = { profile: forged.profile, profileHash: hashSourceProfile(forged.profile) };
    refused(() => runMigration(inputFor(clean.config, clean.configHash, null, { sourceProfile: renamed })), 'SOURCE_PROFILE_INVALID');
  });

  it('refuses a signed contract whose body was changed after loading (audit MC-instance-signed-body-changed)', () => {
    const hub = loadAt('hubspot-update');
    const signed = contractOf('HUBSPOT', [object('contact', [field({ unique: 'FALSE' })])]);
    const attested = attestContract(signed);
    const mutated = JSON.parse(JSON.stringify(signed)) as HashedTargetContract;
    const email = mutated.contract.objects[0]?.fields[0] as { unique: TargetFlag } | undefined;
    assert.ok(email !== undefined);
    email.unique = 'TRUE';
    refused(
      () => runMigration(inputFor(hub.config, hub.configHash, mutated, attested)),
      'TARGET_CONTRACT_INVALID',
      'does not hash to the digest it claims',
    );
    // The unmutated contract, honestly non-unique, is refused for the true reason.
    refused(
      () => runMigration(inputFor(hub.config, hub.configHash, signed, attested)),
      'DESTINATION_MATCH_UNSATISFIED',
      'not established as requiring unique values',
    );
  });

  it('refuses a contract whose contractHash field alone was replaced', () => {
    const hub = loadAt('hubspot-update');
    const genuine = vendorContract('HUBSPOT');
    const attested = attestContract(genuine);
    const renamed = { ...genuine, contractHash: `tc_${'0'.repeat(64)}` };
    refused(
      () => runMigration(inputFor(hub.config, hub.configHash, renamed, attested)),
      'TARGET_CONTRACT_INVALID',
      'does not hash to the digest it claims',
    );
  });

  it('a genuine contract still runs and its recorded hash is the recomputed one', () => {
    const hub = loadAt('hubspot-update');
    const genuine = vendorContract('HUBSPOT');
    const run = runMigration(inputFor(hub.config, hub.configHash, genuine));
    assert.equal(run.truth.targetContractHash, genuine.contractHash);
  });

  it('the run executes against its own frozen copy, not the object the caller keeps', () => {
    const hub = loadAt('hubspot-update');
    const genuine = JSON.parse(JSON.stringify(vendorContract('HUBSPOT'))) as HashedTargetContract;
    const attested = attestContract(genuine);
    const run = runMigration(inputFor(hub.config, hub.configHash, genuine, attested));
    // The caller's object is untouched and still mutable; the run does not
    // hold on to it, so mutating it after the fact changes nothing the run
    // recorded.
    (genuine.contract.objects[0]?.fields[0] as { unique: TargetFlag }).unique = 'UNKNOWN';
    assert.equal(run.truth.targetContractHash, hashTargetContract(vendorContract('HUBSPOT').contract).contractHash);
    assert.equal(run.truth.destinationMatching[0]?.matchAuthority, 'TARGET_UNIQUE_FIELD');
  });
});
