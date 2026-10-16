/**
 * F06 — the validation receipt and the host adapter's translation (canon
 * §30–§33, §100; threat T21).
 *
 * The receipt is validated against a closed schema and against what the
 * run knows: the exact configuration bytes, the hashes, exact and finite
 * row coverage, a supported Migration Core version, an instant not before
 * the run started and not after the clock's now, a verdict consistent with
 * itself and with the evidence it names. The host adapter
 * carries every authorised element of the fragment into the engine or says
 * which one it cannot; nothing is dropped on the way.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { validate } from '../src/contracts/schema.js';
import { optionsOfPrimitive, toMigrationConfig } from '../src/adapter/migration-config.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import { FULL_DATASET_VALIDATION_RESULT_SCHEMA } from '../src/ports/ports.js';
import type { CandidateConfiguration, ConfigFragmentField, FullDatasetValidationPort, FullDatasetValidationResult } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

type Alteration = (receipt: FullDatasetValidationResult, configuration: CandidateConfiguration) => unknown;

/** The real port, its receipt altered on the way back: the defence under test is the core's, not the engine's. */
function altered(real: FullDatasetValidationPort, alter: Alteration): FullDatasetValidationPort {
  return { async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> { return alter(await real.validate(configuration), configuration) as FullDatasetValidationResult; } };
}

const codesOf = (result: IntelligenceResult): string[] => result.unresolvedItems.filter((item) => item.candidateRef === 'validation').flatMap((item) => [...item.codes]);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('F06: the receipt is validated, not believed', () => {
  const cases: { name: string; alter: Alteration; codes: string[] }[] = [
    { name: 'rowsValidated NaN', alter: (receipt) => ({ ...receipt, rowsValidated: Number.NaN }), codes: ['VALIDATION_RECEIPT_MALFORMED'] },
    { name: 'rowsValidated 1.5', alter: (receipt) => ({ ...receipt, rowsValidated: 1.5 }), codes: ['VALIDATION_RECEIPT_MALFORMED'] },
    { name: 'rowsValidated ten more than the profile holds', alter: (receipt) => ({ ...receipt, rowsValidated: receipt.rowsValidated + 10 }), codes: ['VALIDATION_COVERAGE_INEXACT'] },
    { name: 'rowsInProfile not the profile\'s while rowsValidated is', alter: (receipt) => ({ ...receipt, rowsInProfile: receipt.rowsInProfile + 1 }), codes: ['VALIDATION_COVERAGE_INCOMPLETE'] },
    { name: 'coreVersion 0.0.0 with a consistent verdict', alter: (receipt) => ({ ...receipt, coreVersion: '0.0.0' }), codes: ['VALIDATION_CORE_VERSION_UNSUPPORTED'] },
    { name: 'coreVersion 0.0.0 and problems under ok true', alter: (receipt) => ({ ...receipt, coreVersion: '0.0.0', problems: ['SYNTHETIC_VALIDATION_FAILURE'] }), codes: ['VALIDATION_CORE_VERSION_UNSUPPORTED', 'VALIDATION_RECEIPT_INCONSISTENT'] },
    { name: 'ok true with problems', alter: (receipt) => ({ ...receipt, problems: ['SYNTHETIC_VALIDATION_FAILURE'] }), codes: ['VALIDATION_RECEIPT_INCONSISTENT'] },
    { name: 'ok true with reconciliation not holding', alter: (receipt) => ({ ...receipt, reconciliationHolds: false }), codes: ['VALIDATION_RECEIPT_INCONSISTENT', 'VALIDATION_RECONCILIATION_OR_VERIFY_FAILED'] },
    { name: 'ok false with nothing wrong', alter: (receipt) => ({ ...receipt, ok: false }), codes: ['VALIDATION_RECEIPT_INCONSISTENT', 'VALIDATION_REPORTED_PROBLEMS'] },
    { name: 'the digest of another configuration', alter: (receipt, configuration) => ({ ...receipt, configurationDigest: digestOf({ ...configuration, fields: [] }) }), codes: ['VALIDATION_CONFIGURATION_DIGEST_MISMATCH'] },
    { name: 'another configuration ref', alter: (receipt) => ({ ...receipt, configurationRef: 'cfg_0000000000000000' }), codes: ['VALIDATION_FOR_ANOTHER_CONFIGURATION'] },
    { name: 'a member the schema does not know', alter: (receipt) => ({ ...receipt, approvedByAgency: true }), codes: ['VALIDATION_RECEIPT_MALFORMED'] },
    { name: 'the evidence block missing', alter: (receipt) => { const { evidence, ...rest } = receipt; void evidence; return rest; }, codes: ['VALIDATION_RECEIPT_MALFORMED'] },
    { name: 'a validatedAt that is not an instant', alter: (receipt) => ({ ...receipt, validatedAt: 'yesterday' }), codes: ['VALIDATION_RECEIPT_MALFORMED'] },
    { name: 'a validatedAt before the run started', alter: (receipt) => ({ ...receipt, validatedAt: '2020-01-01T00:00:00.000Z' }), codes: ['VALIDATION_BEFORE_RUN_STARTED'] },
    // The port dates by the run's clock, so its instant is exactly now; one millisecond past it is a receipt from the future — the tolerance is zero.
    { name: 'a validatedAt one millisecond after now', alter: (receipt) => ({ ...receipt, validatedAt: new Date(Date.parse(receipt.validatedAt) + 1).toISOString() }), codes: ['VALIDATION_AFTER_NOW'] },
    { name: 'a validatedAt an hour after now', alter: (receipt) => ({ ...receipt, validatedAt: new Date(Date.parse(receipt.validatedAt) + 3_600_000).toISOString() }), codes: ['VALIDATION_AFTER_NOW'] },
    { name: 'ok and packageVerified with no package digest', alter: (receipt) => ({ ...receipt, evidence: { ...receipt.evidence, packageDigest: null } }), codes: ['VALIDATION_RECEIPT_INCONSISTENT'] },
    { name: 'ok and packageVerified with no report digest', alter: (receipt) => ({ ...receipt, evidence: { ...receipt.evidence, reportDigest: null } }), codes: ['VALIDATION_RECEIPT_INCONSISTENT'] },
  ];
  for (const entry of cases) {
    it(`${entry.name} → no draft, ${entry.codes.join(' + ')}`, { timeout: 60_000 }, async () => {
      const bundle = makeBundle('receipt');
      try {
        const profiled = profileBundle(bundle, 'CLEAN_ONLY');
        const clock = new VirtualClock();
        const real = realValidationPort(bundle, profiled.profile, null, { clock });
        const result = await createIntelligenceCore(depsFor(oracleGateway(), altered(real, entry.alter), clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
        assert.equal(result.draft.status, 'NOT_DRAFTABLE');
        assert.equal(result.state, 'FAILED_COMPILER');
        assert.equal(result.draft.configuration, null);
        const codes = codesOf(result);
        for (const code of entry.codes) assert.ok(codes.includes(code), `${code} in ${JSON.stringify(codes)}`);
      } finally {
        bundle.dispose();
      }
    });
  }
  it('the genuine receipt passes, names the exact configuration and carries the engine\'s digests into the result', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('receipt-genuine');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      clock.advance(120_000);
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const result = await createIntelligenceCore(depsFor(oracleGateway(), port, clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.draft.status, 'SYSTEM_DRAFT', JSON.stringify(result.unresolvedItems));
      const receipt = result.draft.fullValidation;
      assert.ok(receipt !== null);
      assert.deepEqual(validate(receipt, FULL_DATASET_VALIDATION_RESULT_SCHEMA), []);
      assert.equal(receipt.configurationDigest, digestOf(result.draft.configuration));
      assert.equal(receipt.rowsValidated, profiled.profile.profile.totals.dataRowCount);
      assert.match(receipt.evidence.packageDigest ?? '', /^[0-9a-f]{64}$/u);
      assert.match(receipt.evidence.reportDigest ?? '', /^[0-9a-f]{64}$/u);
      assert.ok(receipt.evidence.coreConfigHash !== null && receipt.evidence.coreConfigHash.length > 0);
      assert.equal(receipt.validatedAt, clock.now(), 'the receipt is dated by the host, not before the run');
    } finally {
      bundle.dispose();
    }
  });
  it('a receipt the port reports as unsupported translation is no draft and says which primitive', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('receipt-unsupported');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const real = realValidationPort(bundle, profiled.profile, null, { clock });
      // The host hands the engine a configuration whose primitive it cannot express; the port refuses instead of dropping it.
      const refusing: FullDatasetValidationPort = { async validate(configuration) { const receipt = await real.validate({ ...configuration, fields: configuration.fields.map((field, index) => (index === 0 ? { ...field, transformPrimitive: 'PARSE_DATE_ISO', typedTransformParams: { dayFirst: 'true' } } : field)) }); return { ...receipt, configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration) }; } };
      const result = await createIntelligenceCore(depsFor(oracleGateway(), refusing, clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      const codes = codesOf(result);
      assert.ok(codes.includes('VALIDATION_REPORTED_PROBLEMS'), JSON.stringify(codes));
      assert.ok(codes.some((code) => code.startsWith('UNSUPPORTED_BY_CORE:PARSE_DATE_ISO')), JSON.stringify(codes));
      // A refusal ran nothing and names no evidence; that is consistent, and the only code about the receipt's shape is the problems it reports.
      assert.ok(!codes.includes('VALIDATION_RECEIPT_INCONSISTENT'), JSON.stringify(codes));
      assert.ok(!codes.includes('VALIDATION_AFTER_NOW'), JSON.stringify(codes));
    } finally {
      bundle.dispose();
    }
  });
});

describe('F06: the host adapter translates the whole fragment', () => {
  // A field fragment of the contacts file, under the record mapping of its destination's object; its decision ref is a stand-in, and its hash is stamped only by the core's sealing, which these direct translations do not need.
  const field = (bundle: Bundle, profileFileId: string, locator: string, header: string, destinationField: string, semanticType: string, primitive: string | null, params: Record<string, string> | null): ConfigFragmentField => ({ recordId: `${profileFileId}-${destinationField.split('.')[0] ?? 'contact'}`, fileId: profileFileId, filePath: bundle.files[0]?.path ?? 'contacts.csv', object: destinationField.split('.')[0]?.toUpperCase() ?? 'CONTACT', columnHeader: header, columnLocator: locator, destinationField, semanticType, required: false, onInvalid: 'PRESERVE', onAmbiguous: 'PRESERVE', transformPrimitive: primitive, typedTransformParams: params, decisionRef: `dec_${digestOf([locator, destinationField]).slice(0, 16)}`, fragmentHash: '' });
  // CandidateConfiguration 2.0.0 around those fields: one record fragment per record mapping they name, nothing else.
  const configurationOf = (base: Pick<CandidateConfiguration, 'configurationRef' | 'mode' | 'profileHash' | 'candidateSetHash' | 'targetContractHash'>, fields: readonly ConfigFragmentField[]): CandidateConfiguration => ({
    ...base,
    records: [...new Map(fields.map((entry) => [entry.recordId, { recordId: entry.recordId, fileId: entry.fileId, filePath: entry.filePath, object: entry.object, sourceRecordIdColumn: null, authoritativeExternalIdColumns: [], identitySpace: null, decisionRef: `dec_${digestOf(['record', entry.recordId]).slice(0, 16)}`, fragmentHash: '' }])).values()],
    fields,
    associations: [],
    preservedColumns: [],
    excludedColumns: [],
  });
  const locate = (profile: ReturnType<typeof profileBundle>['profile'], header: string): { fileId: string; locator: string } => {
    for (const file of profile.profile.files) for (const sheet of file.sheets) for (const column of sheet.columns) if (column.headerRaw === header) return { fileId: file.fileId, locator: column.columnLocatorId };
    throw new Error(`no column ${header}`);
  };
  it('a primitive with parameters reaches the engine and changes the delivered value: a local phone becomes E.164 under the region the proposal named', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('translate-phone', { contacts: 'Contact ID,First Name,Email,Phone\n1,Ada,ada@kauro-fixture.test,300 123 4567\n2,Grace,grace@kauro-fixture.test,+1 415 555 0100\n' });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const phone = locate(profiled.profile, 'Phone');
      const email = locate(profiled.profile, 'Email');
      const configuration = configurationOf({ configurationRef: 'cfg_translate', mode: 'CLEAN_ONLY', profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null }, [field(bundle, email.fileId, email.locator, 'Email', 'contact.email', 'EMAIL', 'NORMALISE_EMAIL_CASE', null), field(bundle, phone.fileId, phone.locator, 'Phone', 'contact.phone', 'PHONE', 'PARSE_PHONE_E164', { defaultRegion: 'CO' })]);
      const receipt = await port.validate(configuration);
      assert.equal(receipt.ok, true, JSON.stringify(receipt.problems));
      assert.equal(receipt.rowsValidated, profiled.profile.profile.totals.dataRowCount);
      assert.ok(port.lastPackage !== null);
      const delivered = filesUnder(join(port.lastPackage.stagingDir, '01_IMPORT')).map((path) => readFileSync(path, 'utf8')).join('\n');
      assert.ok(delivered.includes('+573001234567'), `the delivered import carries the parsed number:\n${delivered}`);
      assert.ok(!delivered.includes('300 123 4567'), 'the raw local number is not what was delivered');
      // Without the primitive the same column is preserved as written: the parameter is what changed the value.
      const plain = await port.validate({ ...configuration, configurationRef: 'cfg_plain', fields: configuration.fields.map((entry) => ({ ...entry, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null })) });
      assert.equal(plain.ok, true);
      assert.ok(port.lastPackage !== null);
      const preserved = filesUnder(join(port.lastPackage.stagingDir, '01_IMPORT')).map((path) => readFileSync(path, 'utf8')).join('\n');
      assert.ok(!preserved.includes('+573001234567'));
    } finally {
      bundle.dispose();
    }
  });
  it('the column goes in by the locator\'s physical index, so a repeated header cannot be confused', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('translate-index', { contacts: 'Contact ID,Email,Email\n1,first@kauro-fixture.test,second@kauro-fixture.test\n' });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const second = profiled.profile.profile.files.flatMap((file) => file.sheets.flatMap((sheet) => sheet.columns.map((column) => ({ fileId: file.fileId, column })))).filter((entry) => entry.column.headerRaw === 'Email')[1];
      assert.ok(second !== undefined);
      const translation = toMigrationConfig(configurationOf({ configurationRef: 'cfg_index', mode: 'CLEAN_ONLY', profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null }, [field(bundle, second.fileId, second.column.columnLocatorId, 'Email', 'contact.email', 'EMAIL', null, null)]), profiled.profile);
      assert.deepEqual(translation.problems, []);
      const spec = ((translation.document?.['records'] as { fields: { column: { index: number } }[] }[] | undefined)?.[0]?.fields ?? [])[0];
      assert.equal(spec?.column.index, second.column.columnIndex);
      // A locator whose header is not the one the fragment names is refused, not guessed.
      const wrong = toMigrationConfig(configurationOf({ configurationRef: 'cfg_wrong', mode: 'CLEAN_ONLY', profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null }, [field(bundle, second.fileId, second.column.columnLocatorId, 'Contact ID', 'contact.email', 'EMAIL', null, null)]), profiled.profile);
      assert.ok(wrong.problems.some((problem) => problem.startsWith('COLUMN_LOCATOR_HEADER_MISMATCH')));
    } finally {
      bundle.dispose();
    }
  });
  it('a primitive the frozen schema cannot express is a problem, never a silent drop; the destructive one above all', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('translate-refuse');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const email = locate(profiled.profile, 'Email');
      const base = { configurationRef: 'cfg_refuse', mode: 'CLEAN_ONLY' as const, profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null };
      for (const [primitive, params, semanticType] of [['CLEAR_VALUE', null, 'EMAIL'], ['PARSE_DATE_ISO', { dayFirst: 'true' }, 'DATE'], ['MAP_ENUM_VALUE', { from: 'a', to: 'b' }, 'ENUM'], ['PARSE_PHONE_E164', null, 'PHONE'], ['SOMETHING_NEW', null, 'TEXT']] as const) {
        const receipt = await port.validate(configurationOf(base, [field(bundle, email.fileId, email.locator, 'Email', 'contact.email', semanticType, primitive, params === null ? null : { ...params })]));
        assert.equal(receipt.ok, false, primitive);
        assert.equal(receipt.rowsValidated, 0, `${primitive}: nothing ran`);
        assert.equal(receipt.evidence.packageDigest, null, `${primitive}: no package`);
        assert.ok(receipt.problems.some((problem) => problem.startsWith(`UNSUPPORTED_BY_CORE:${primitive}`)), `${primitive}: ${JSON.stringify(receipt.problems)}`);
        assert.deepEqual(validate(receipt, FULL_DATASET_VALIDATION_RESULT_SCHEMA), [], 'a refusal is still a well-formed receipt');
      }
      assert.ok('problem' in optionsOfPrimitive(field(bundle, email.fileId, email.locator, 'Email', 'contact.email', 'EMAIL', 'CLEAR_VALUE', null)));
      assert.deepEqual(optionsOfPrimitive(field(bundle, email.fileId, email.locator, 'Email', 'contact.email', 'EMAIL', 'TRIM_WHITESPACE', null)), { options: { trim: true } });
      assert.deepEqual(optionsOfPrimitive(field(bundle, email.fileId, email.locator, 'Email', 'contact.email', 'NUMBER', 'NORMALISE_NUMBER', { decimalSeparator: ',' })), { options: { trim: true, decimalSeparator: ',', thousandsSeparator: 'NONE' } });
    } finally {
      bundle.dispose();
    }
  });
  it('the object per file is the candidate\'s, and a file split across two objects is refused', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('translate-object');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const email = locate(profiled.profile, 'Email');
      const first = locate(profiled.profile, 'First Name');
      const base = { configurationRef: 'cfg_object', mode: 'CLEAN_ONLY' as const, profileHash: profiled.profile.profileHash, candidateSetHash: profiled.candidateSet.candidateSetHash, targetContractHash: null };
      const asLead = toMigrationConfig(configurationOf(base, [field(bundle, email.fileId, email.locator, 'Email', 'lead.email', 'EMAIL', null, null)]), profiled.profile);
      assert.deepEqual(asLead.problems, []);
      assert.equal((asLead.document?.['records'] as { object: string }[] | undefined)?.[0]?.object, 'LEAD');
      const split = toMigrationConfig(configurationOf(base, [field(bundle, email.fileId, email.locator, 'Email', 'lead.email', 'EMAIL', null, null), field(bundle, first.fileId, first.locator, 'First Name', 'contact.firstName', 'TEXT', null, null)]), profiled.profile);
      assert.ok(split.problems.some((problem) => problem.startsWith('MULTIPLE_OBJECTS_FOR_FILE')));
    } finally {
      bundle.dispose();
    }
  });
});
