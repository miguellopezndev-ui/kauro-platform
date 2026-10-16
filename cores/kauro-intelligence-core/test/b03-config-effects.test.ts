/**
 * B03-CONFIG-EFFECTS — the configuration the core hands over, the document
 * Migration Core loads from it, and the effects Migration Core reports back
 * (D3-CFG-1, D3-CFG-2, D3-CFG-3, D3-EVC-1; review findings B03-R9, B03-R11).
 *
 * The IC-03 and IC-09 cases run on a bundle whose every column the resolver
 * decides on facts, so no gateway is ever called: the model stands for
 * nothing here, and a gateway that throws if called proves it. The host's
 * validation port is the real Migration Core over the whole fixture.
 *
 * The two cases were written first, against the design base, and read the
 * configuration, the manifest and the effects through loose views; they
 * stay so. The guards after them use the product adapter's types.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { loadConfig } from 'kauro-migration-core';
import type { HashedCandidateSet, HashedSourceProfile } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { sealConfiguration, toMigrationConfig } from '../src/adapter/migration-config.js';
import { MIGRATION_EFFECTS_SCHEMA } from '../src/adapter/migration-effects.js';
import type { MigrationEffects } from '../src/adapter/migration-effects.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { validate } from '../src/contracts/schema.js';
import { oracleGateway, oracleTransport, replayGateway, scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { transportGateway } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, ConfigFragmentField, FullDatasetValidationPort, FullDatasetValidationResult, IntelligenceInput } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import type { Bundle } from './support/fixtures.js';

type Loose = Readonly<Record<string, unknown>>;
type Alteration = (receipt: FullDatasetValidationResult, configuration: CandidateConfiguration) => unknown;

/** A fragment of the configuration, of whichever kind, as this file reads it. */
interface LooseFragment {
  readonly kind: 'RECORD' | 'FIELD' | 'ASSOCIATION' | 'PRESERVED_COLUMN' | 'EXCLUDED_COLUMN';
  readonly fragment: Loose;
}

interface LooseManifestEntry {
  readonly fragmentKind: string;
  readonly decisionRef: string;
  readonly fragmentHash: string;
  readonly origin: string;
  readonly rule: string;
  readonly pointer: string | null;
  readonly observed: boolean;
}

const CONTACTS = 'Email,First Name,Last Name,Phone\nada@kauro-fixture.test,Ada,Lovelace,+57 300 123 4567\ngrace@kauro-fixture.test,Grace,Hopper,+1 415 555 0100\nalan@kauro-fixture.test,Alan,Turing,+44 20 7946 0000\n';
const COMPANIES = 'Name,Website\nAnalytical Engines,https://analytical.test\nCOBOL Works,https://cobol.test\n';
const DECLARED_OBJECTS = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;

/**
 * Two files whose every column names exactly one canonical field of its
 * declared object: the resolver decides each of them, no question is left
 * and no gateway is called. The files hold no record id column; the header
 * the design base's fixture port keyed records by is set to one they hold,
 * so that port runs too.
 */
function deterministicBundle(name: string): Bundle {
  const made = makeBundle(name, { contacts: CONTACTS, companies: COMPANIES });
  return { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Email' : 'Name' })) };
}

function deterministicInput(profiled: { readonly profile: HashedSourceProfile; readonly candidateSet: HashedCandidateSet }): IntelligenceInput {
  const base = inputFor('CLEAN_ONLY', profiled, null);
  return { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED_OBJECTS } };
}

/** A gateway that fails the test's premise if the run ever calls it; labelled SIMULATED, as a stand-in is. */
function noModel(): { readonly gateway: ModelGateway; readonly calls: () => number } {
  let calls = 0;
  const gateway = {
    name: 'no-model',
    evidenceClass: 'SIMULATED' as const,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      calls += 1;
      throw new Error(`the run called the model for task ${request.envelope.taskId}; every column here is decided on facts`);
    },
  };
  return { gateway, calls: () => calls };
}

/** The real port, its receipt altered on the way back: the defence under test is the core's. */
function altered(real: FullDatasetValidationPort, alter: Alteration): FullDatasetValidationPort {
  return { async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> { return alter(await real.validate(configuration), configuration) as FullDatasetValidationResult; } };
}

const codesOf = (result: IntelligenceResult): string[] => result.unresolvedItems.flatMap((item) => [...item.codes]);

/** Every fragment of a configuration, by kind. */
function fragmentsOf(configuration: Loose): readonly LooseFragment[] {
  const list = (member: string): readonly Loose[] => (Array.isArray(configuration[member]) ? (configuration[member] as readonly Loose[]) : []);
  return [
    ...list('records').map((fragment) => ({ kind: 'RECORD' as const, fragment })),
    ...list('fields').map((fragment) => ({ kind: 'FIELD' as const, fragment })),
    ...list('associations').map((fragment) => ({ kind: 'ASSOCIATION' as const, fragment })),
    ...list('preservedColumns').map((fragment) => ({ kind: 'PRESERVED_COLUMN' as const, fragment })),
    ...list('excludedColumns').map((fragment) => ({ kind: 'EXCLUDED_COLUMN' as const, fragment })),
  ];
}

/** The member a JSON pointer names. */
function at(json: unknown, pointer: string): unknown {
  let current = json;
  for (const segment of pointer.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment.replace(/~1/gu, '/').replace(/~0/gu, '~')];
  }
  return current;
}

/**
 * The fragment hash of an element Migration Core loaded (D3-CFG-1): the
 * element as its loader normalized it, bound to its kind — a field to the
 * record mapping it belongs to, a record without its fields.
 */
function consumedHash(kind: string, loaded: unknown, pointer: string): string {
  const element = at(loaded, pointer) as Loose | undefined;
  assert.ok(element !== undefined, `nothing at ${pointer} in the loaded configuration`);
  if (kind === 'RECORD') {
    const { fields, ...record } = element;
    void fields;
    return digestOf({ fragmentKind: 'RECORD', element: record });
  }
  if (kind === 'FIELD') {
    const record = at(loaded, pointer.slice(0, pointer.lastIndexOf('/fields/'))) as Loose;
    return digestOf({ fragmentKind: 'FIELD', recordMappingId: record['id'], element });
  }
  return digestOf({ fragmentKind: kind, element });
}

describe('B03-CONFIG-EFFECTS: the receipt names the document Migration Core loaded, and every fragment is observed in its effects', () => {
  it('IC-03: on a run with no gateway call, a null receipt, an ok receipt with a null or foreign coreConfigHash, a validatedAt after now and a receipt for another configuration are each a typed contract failure with no draft; the genuine receipt drafts', { timeout: 180_000 }, async () => {
    const bundle = deterministicBundle('b03-ic03');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = deterministicInput(profiled);
      // A genuine Migration Core hash, of another document: the loader's hash of the configuration the profile was read under.
      const foreignHash = profiled.configHash;
      const cases: readonly { readonly name: string; readonly alter: Alteration; readonly codes: readonly string[] }[] = [
        { name: 'a null receipt', alter: () => null, codes: ['VALIDATION_RECEIPT_MALFORMED'] },
        { name: 'an ok receipt with a null coreConfigHash', alter: (receipt) => ({ ...receipt, evidence: { ...receipt.evidence, coreConfigHash: null } }), codes: ['VALIDATION_CORE_CONFIG_HASH_MISSING'] },
        // Effects that agree with the foreign hash: only the comparison with the core's own loading of its document can refuse it.
        { name: 'an ok receipt with a foreign coreConfigHash', alter: (receipt) => ({ ...receipt, evidence: { ...receipt.evidence, coreConfigHash: foreignHash }, effects: receipt.effects === null ? null : { ...receipt.effects, configHash: foreignHash } }), codes: ['VALIDATION_CORE_CONFIG_HASH_MISMATCH'] },
        { name: 'a validatedAt one millisecond after now', alter: (receipt) => ({ ...receipt, validatedAt: new Date(Date.parse(receipt.validatedAt) + 1).toISOString() }), codes: ['VALIDATION_AFTER_NOW'] },
        { name: 'a receipt for another configuration', alter: (receipt, configuration) => ({ ...receipt, configurationRef: 'cfg_0000000000000000', configurationDigest: digestOf({ ...configuration, fields: [] }) }), codes: ['VALIDATION_FOR_ANOTHER_CONFIGURATION', 'VALIDATION_CONFIGURATION_DIGEST_MISMATCH'] },
      ];
      for (const entry of cases) {
        const clock = new VirtualClock();
        const model = noModel();
        const result = await createIntelligenceCore(depsFor(model.gateway, altered(realValidationPort(bundle, profiled.profile, null, { clock }), entry.alter), clock)).run(input, CONTEXT);
        assert.equal(model.calls(), 0, `${entry.name}: the gateway was not called`);
        assert.equal(result.state, 'FAILED_COMPILER', `${entry.name}: ${result.state} ${JSON.stringify(result.unresolvedItems)}`);
        assert.equal(result.draft.status, 'NOT_DRAFTABLE', entry.name);
        assert.equal(result.draft.configuration, null, entry.name);
        const codes = codesOf(result);
        for (const code of entry.codes) assert.ok(codes.includes(code), `${entry.name}: ${code} in ${JSON.stringify(codes)}`);
      }
      // The genuine receipt drafts, and the hash it names is Migration Core's own loader hash of the document this core produced.
      const clock = new VirtualClock();
      const model = noModel();
      const genuine = await createIntelligenceCore(depsFor(model.gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.equal(model.calls(), 0, 'the genuine run did not call the gateway');
      assert.equal(genuine.state, 'PROPOSAL_READY', JSON.stringify(genuine.unresolvedItems));
      assert.equal(genuine.draft.status, 'SYSTEM_DRAFT');
      const configuration = genuine.draft.configuration;
      const receipt = genuine.draft.fullValidation;
      assert.ok(configuration !== null && receipt !== null);
      const produced = toMigrationConfig(configuration, profiled.profile);
      assert.deepEqual(produced.problems, [], 'the core produced a document Migration Core can take whole');
      assert.ok(produced.document !== null);
      const loaded = loadConfig(JSON.stringify(produced.document), 'ic-03-produced-document.json');
      assert.equal(receipt.evidence.coreConfigHash, loaded.configHash, 'the receipt names the loader hash of the document this core produced');
      assert.notEqual(loaded.configHash, foreignHash);
    } finally {
      bundle.dispose();
    }
  });

  it('IC-09: on a run with no gateway call every configuration fragment carries DecisionEvidence whose fragment hash equals the fragment Migration Core consumed, and a fragment the receipt does not report consumed is FAILED_COMPILER EFFECT_NOT_OBSERVED', { timeout: 180_000 }, async () => {
    const bundle = deterministicBundle('b03-ic09');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = deterministicInput(profiled);
      const clock = new VirtualClock();
      const model = noModel();
      const result = await createIntelligenceCore(depsFor(model.gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.equal(model.calls(), 0, 'the gateway was not called');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const configuration = result.draft.configuration;
      const receipt = result.draft.fullValidation;
      assert.ok(configuration !== null && receipt !== null);
      const fragments = fragmentsOf(configuration as unknown as Loose);
      // Every fragment names the decision that put it there and the hash of what Migration Core consumes of it.
      for (const { kind, fragment } of fragments) {
        assert.match(String(fragment['decisionRef']), /^(?:dec|cand)_[0-9a-f]{16}$/u, `every configuration fragment names its decision: this ${kind} fragment names ${String(fragment['decisionRef'])}`);
        assert.match(String(fragment['fragmentHash']), /^[0-9a-f]{64}$/u, `every configuration fragment names its fragment hash: this ${kind} fragment names ${String(fragment['fragmentHash'])}`);
      }
      const fields = fragments.filter((entry) => entry.kind === 'FIELD');
      const records = fragments.filter((entry) => entry.kind === 'RECORD');
      assert.equal(fields.length, 6, 'Email, First Name, Last Name, Phone, Name and Website are decided on facts');
      assert.equal(records.length, 2, 'one record mapping per file');
      assert.equal(new Set(fragments.map((entry) => entry.fragment['fragmentHash'])).size, fragments.length, 'no two fragments share a hash');

      // DecisionEvidence per fragment: the manifest names each fragment's decision, its rule and the same hash; a field's draft evidence names the hash too.
      const manifest = (result.draft as unknown as { readonly fragmentCoverage?: { readonly complete: boolean; readonly entries: readonly LooseManifestEntry[] } | null }).fragmentCoverage;
      assert.ok(manifest !== undefined && manifest !== null, 'the draft carries the coverage manifest');
      assert.equal(manifest.complete, true);
      assert.equal(manifest.entries.length, fragments.length, 'one manifest entry per fragment');
      for (const { kind, fragment } of fragments) {
        const entry: LooseManifestEntry | undefined = manifest.entries.find((candidate) => candidate.fragmentKind === kind && candidate.decisionRef === fragment['decisionRef']);
        assert.ok(entry !== undefined, `${kind} ${String(fragment['decisionRef'])} has its manifest entry`);
        assert.equal(entry.fragmentHash, fragment['fragmentHash']);
        assert.equal(entry.origin, 'DETERMINISTIC', `${kind}: decided on facts, with no model`);
        assert.match(entry.rule, /^[A-Z][A-Z_]+$/u, `${kind}: the rule that decided it`);
        assert.equal(entry.observed, true, `${kind} ${entry.decisionRef}: Migration Core reported it consumed`);
      }
      for (const { fragment } of fields) {
        const evidence = result.draft.evidence.find((entry) => entry.candidateRef === fragment['decisionRef']) as (Loose & { readonly origin: string }) | undefined;
        assert.ok(evidence !== undefined, `${String(fragment['destinationField'])} has its draft evidence`);
        assert.equal(evidence.origin, 'DETERMINISTIC');
        assert.equal(evidence['fragmentHash'], fragment['fragmentHash'], `${String(fragment['destinationField'])}: the evidence names the fragment hash`);
      }

      // The fragment Migration Core consumed: the document this core produces, loaded by Migration Core's own loader, at the pointer the adapter names.
      const produced = toMigrationConfig(configuration, profiled.profile);
      assert.deepEqual(produced.problems, []);
      const loaded = loadConfig(JSON.stringify(produced.document), 'ic-09-produced-document.json');
      assert.equal(receipt.evidence.coreConfigHash, loaded.configHash, 'the receipt is about exactly that document');
      for (const { kind, fragment } of fragments.filter((entry) => entry.kind === 'RECORD' || entry.kind === 'FIELD')) {
        const pointer = produced.coverage.find((entry) => entry.kind === kind && entry.decisionRef === fragment['decisionRef']);
        assert.ok(pointer !== undefined && pointer.pointer !== null, `${kind} ${String(fragment['decisionRef'])} is in the document`);
        assert.equal(pointer.fragmentHash, fragment['fragmentHash']);
        assert.equal(consumedHash(kind, loaded.normalizedJson, pointer.pointer), fragment['fragmentHash'], `${kind} ${String(fragment['decisionRef'])}: its hash is the hash of the element Migration Core loaded at ${pointer.pointer}`);
      }

      // The receipt reports what Migration Core consumed, by the same hashes, with the delivered counts of the whole fixture.
      const effects = (receipt as unknown as { readonly effects?: { readonly configHash: string; readonly records: readonly Loose[]; readonly fields: readonly Loose[] } | null }).effects;
      assert.ok(effects !== undefined && effects !== null, 'the receipt carries the effects block');
      assert.equal(effects.configHash, loaded.configHash);
      for (const { fragment } of records) assert.ok(effects.records.some((entry) => entry['fragmentHash'] === fragment['fragmentHash']), `record ${String(fragment['recordId'])} was consumed`);
      for (const { fragment } of fields) {
        const effect: Loose | undefined = effects.fields.find((entry) => entry['fragmentHash'] === fragment['fragmentHash']);
        assert.ok(effect !== undefined, `${String(fragment['destinationField'])} was consumed`);
        assert.equal(effect['delivered'], fragment['object'] === 'CONTACT' ? 3 : 2, `${String(fragment['destinationField'])}: every populated row delivered a value`);
      }

      // The negative control: the same run, and a receipt whose effects leave one field out.
      const dropped = fields[0]?.fragment;
      assert.ok(dropped !== undefined);
      const omitting: Alteration = (genuine) => {
        const block = (genuine as unknown as { readonly effects: { readonly fields: readonly Loose[] } & Loose }).effects;
        return { ...genuine, effects: { ...block, fields: block.fields.filter((entry) => entry['fragmentHash'] !== dropped['fragmentHash']) } };
      };
      const negativeClock = new VirtualClock();
      const negativeModel = noModel();
      const negative = await createIntelligenceCore(depsFor(negativeModel.gateway, altered(realValidationPort(bundle, profiled.profile, null, { clock: negativeClock }), omitting), negativeClock)).run(input, CONTEXT);
      assert.equal(negativeModel.calls(), 0);
      assert.equal(negative.state, 'FAILED_COMPILER', JSON.stringify(negative.unresolvedItems));
      assert.equal(negative.draft.status, 'NOT_DRAFTABLE');
      assert.equal(negative.draft.configuration, null);
      const codes = codesOf(negative);
      assert.ok(codes.includes('EFFECT_NOT_OBSERVED'), JSON.stringify(codes));
      assert.ok(codes.some((code) => code.includes(String(dropped['decisionRef']))), `the gap names the fragment's decision: ${JSON.stringify(codes)}`);
    } finally {
      bundle.dispose();
    }
  });

  it('D3-CFG-3: under a verified verdict, a receipt with no effects block, or effects of another document than the one it names, is a typed failure with no draft', { timeout: 180_000 }, async () => {
    const bundle = deterministicBundle('b03-effects-binding');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = deterministicInput(profiled);
      const cases: readonly { readonly name: string; readonly alter: Alteration; readonly code: string }[] = [
        { name: 'no effects block', alter: (receipt) => ({ ...receipt, effects: null }), code: 'VALIDATION_EFFECTS_MISSING' },
        { name: 'effects of another document', alter: (receipt) => (receipt.effects === null ? receipt : { ...receipt, effects: { ...receipt.effects, configHash: profiled.configHash } }), code: 'VALIDATION_EFFECTS_FOR_ANOTHER_CONFIGURATION' },
      ];
      for (const entry of cases) {
        const clock = new VirtualClock();
        const model = noModel();
        const result = await createIntelligenceCore(depsFor(model.gateway, altered(realValidationPort(bundle, profiled.profile, null, { clock }), entry.alter), clock)).run(input, CONTEXT);
        assert.equal(model.calls(), 0);
        assert.deepEqual([result.state, result.draft.status], ['FAILED_COMPILER', 'NOT_DRAFTABLE'], entry.name);
        assert.ok(codesOf(result).includes(entry.code), `${entry.name}: ${entry.code} in ${JSON.stringify(codesOf(result))}`);
      }
    } finally {
      bundle.dispose();
    }
  });

  it('D3-EVC-1: the scripted, replay and oracle gateways and a transport gateway over the labelled oracle declare SIMULATED, a result names the evidence class of the gateway it ran on, and a gateway that declares none is refused before anything is spent', { timeout: 120_000 }, async () => {
    for (const gateway of [scriptedGateway({}), replayGateway(new Map()), oracleGateway(), transportGateway(oracleTransport())]) {
      assert.equal((gateway as unknown as Loose)['evidenceClass'], 'SIMULATED', `${gateway.name} is a labelled fake`);
    }
    const bundle = makeBundle('b03-evidence-class');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const oracle = oracleGateway();
      const result = await createIntelligenceCore(depsFor(oracle, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.ok(oracle.calls > 0, 'the oracle answered the run');
      assert.equal((result.provenance as unknown as Loose)['gatewayEvidenceClass'], 'SIMULATED', 'the result says its answers came from a labelled fake');
      const undeclared = { name: 'undeclared', analyze: async (): Promise<GatewayResult> => ({ kind: 'TERMINAL_FAILURE', reason: 'never called', usage: null }) } as unknown as ModelGateway;
      assert.throws(() => createIntelligenceCore(depsFor(undeclared, realValidationPort(bundle, profiled.profile, null))), (error: unknown) => error instanceof IntelligenceError && error.code === 'CONTRACT_VIOLATION');
    } finally {
      bundle.dispose();
    }
  });

  it('D3-CFG-3: a column the run preserves is a fragment named by its locator alone, observed as Migration Core\'s unmapped leftover by its hash; the effects block is closed and carries no header, value or path of the bundle; a receipt that loses the leftover is EFFECT_NOT_OBSERVED', { timeout: 180_000 }, async () => {
    const sentinels = ['Loyalty Sentinel Header', 'SENTINEL-VALUE-ALPHA', 'SENTINEL-VALUE-BRAVO'];
    const bundle = makeBundle('b03-preserved', { contacts: 'Email,First Name,Loyalty Sentinel Header\nada@kauro-fixture.test,Ada,SENTINEL-VALUE-ALPHA\ngrace@kauro-fixture.test,Grace,SENTINEL-VALUE-BRAVO\n', companies: COMPANIES });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = deterministicInput(profiled);
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const loyalty = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Loyalty Sentinel Header')?.locator ?? assert.fail('no loyalty column');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const result = await createIntelligenceCore(depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.ok(oracle.calls > 0, 'the column no field names was a question the labelled oracle answered');
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const configuration = result.draft.configuration;
      const receipt = result.draft.fullValidation;
      assert.ok(configuration !== null && receipt !== null && receipt.effects !== null);
      const preserved = configuration.preservedColumns.find((column) => column.columnLocator === loyalty);
      assert.ok(preserved !== undefined, 'the column left unmapped is a preserved-column fragment');
      assert.ok(!('columnHeader' in preserved), 'a column no field maps is named by its locator alone');
      assert.ok(!JSON.stringify(configuration).includes('Loyalty Sentinel Header'), 'the unmapped header is nowhere in the configuration');
      const entry = result.draft.fragmentCoverage?.entries.find((candidate) => candidate.fragmentKind === 'PRESERVED_COLUMN' && candidate.decisionRef === preserved.decisionRef);
      assert.ok(entry !== undefined);
      assert.deepEqual([entry.observed, entry.expectedEffect, entry.pointer, entry.fragmentHash], [true, 'UNMAPPED_LEFTOVER', null, preserved.fragmentHash]);
      const effects: MigrationEffects = receipt.effects;
      assert.deepEqual(validate(effects, MIGRATION_EFFECTS_SCHEMA), [], 'the effects block is closed');
      const leftover = effects.unmapped.find((cell) => cell.columnLocator === loyalty);
      assert.ok(leftover !== undefined);
      assert.deepEqual([leftover.cells, leftover.fragmentHash], [2, preserved.fragmentHash], 'both populated cells are unmapped leftovers, met on the fragment hash');
      // Payload-free: ids, locators, canonical destinations, counts and hashes; no header, value or path of the bundle, in the effects or in the manifest.
      const published = `${JSON.stringify(effects)}\n${JSON.stringify(result.draft.fragmentCoverage)}`;
      for (const text of [...sentinels, 'ada@kauro-fixture.test', 'Grace', 'Analytical Engines', 'contacts.csv', 'companies.csv', 'First Name']) assert.ok(!published.includes(text), `the effects and the manifest carry ${text}`);

      // The negative control: the same run, and a receipt whose effects lose the leftover.
      const losing: Alteration = (genuine) => (genuine.effects === null ? genuine : { ...genuine, effects: { ...genuine.effects, unmapped: genuine.effects.unmapped.filter((cell) => cell.columnLocator !== loyalty) } });
      const negativeClock = new VirtualClock();
      const negative = await createIntelligenceCore(depsFor(oracleGateway(), altered(realValidationPort(bundle, profiled.profile, null, { clock: negativeClock }), losing), negativeClock)).run(input, CONTEXT);
      assert.equal(negative.state, 'FAILED_COMPILER');
      assert.equal(negative.draft.status, 'NOT_DRAFTABLE');
      const codes = codesOf(negative);
      assert.ok(codes.includes('EFFECT_NOT_OBSERVED') && codes.includes(`PRESERVED_COLUMN:${preserved.decisionRef}`), JSON.stringify(codes));
    } finally {
      bundle.dispose();
    }
  });

  it('D3-CFG-1 / D3-CFG-2: an association between two record mappings with declared record ids is expressed, Migration Core resolves its edges and reports the missing endpoint; one whose target declares no record id, an excluded column and an inexpressible primitive are each refused by decision ref, with no document', { timeout: 180_000 }, async () => {
    const bundle = makeBundle('b03-association', { contacts: 'Contact ID,Email,Company Ref\n1,ada@kauro-fixture.test,C1\n2,grace@kauro-fixture.test,C2\n3,alan@kauro-fixture.test,C9\n', companies: 'Company ID,Name\nC1,Analytical Engines\nC2,COBOL Works\n' });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const column = (header: string): { readonly fileId: string; readonly filePath: string; readonly header: string; readonly locator: string } => [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === header) ?? assert.fail(`no ${header} column`);
      const [email, name, contactId, companyId, key] = [column('Email'), column('Name'), column('Contact ID'), column('Company ID'), column('Company Ref')];
      const contacts = `${email.fileId}-contact`;
      const companies = `${name.fileId}-company`;
      const field = (info: typeof email, destinationField: string, semanticType: string, recordId: string, object: string, decisionRef: string): ConfigFragmentField => ({ recordId, fileId: info.fileId, filePath: info.filePath, object, columnHeader: info.header, columnLocator: info.locator, destinationField, semanticType, required: false, onInvalid: 'PRESERVE', onAmbiguous: 'PRESERVE', transformPrimitive: null, typedTransformParams: null, decisionRef, fragmentHash: '' });
      const configuration: CandidateConfiguration = {
        configurationRef: 'cfg_association',
        mode: 'CLEAN_ONLY',
        profileHash: profiled.profile.profileHash,
        candidateSetHash: profiled.candidateSet.candidateSetHash,
        targetContractHash: null,
        records: [
          { recordId: contacts, fileId: email.fileId, filePath: email.filePath, object: 'CONTACT', sourceRecordIdColumn: { columnLocator: contactId.locator }, authoritativeExternalIdColumns: [], identitySpace: null, decisionRef: 'dec_0000000000000001', fragmentHash: '' },
          { recordId: companies, fileId: name.fileId, filePath: name.filePath, object: 'COMPANY', sourceRecordIdColumn: { columnLocator: companyId.locator }, authoritativeExternalIdColumns: [], identitySpace: null, decisionRef: 'dec_0000000000000002', fragmentHash: '' },
        ],
        fields: [field(email, 'contact.email', 'EMAIL', contacts, 'CONTACT', 'dec_0000000000000003'), field(name, 'company.name', 'TEXT', companies, 'COMPANY', 'dec_0000000000000004')],
        associations: [{ associationId: 'assoc_contact_company', recordId: contacts, relationshipType: 'CONTACT_TO_COMPANY', ownerSide: 'FROM', keyColumn: { columnLocator: key.locator }, targetRecordId: companies, targetMatchKey: 'SOURCE_RECORD_ID', decisionRef: 'cand_0000000000000005', fragmentHash: '' }],
        preservedColumns: [],
        excludedColumns: [],
      };
      const sealing = sealConfiguration(configuration, profiled.profile);
      assert.ok(sealing.ok, JSON.stringify(sealing));
      const sealed = sealing.sealed;
      assert.equal(sealed.coverage.find((entry) => entry.kind === 'ASSOCIATION')?.pointer, '/associations/0');
      const port = realValidationPort(bundle, profiled.profile, null);
      const receipt = await port.validate(sealed.configuration);
      assert.equal(receipt.ok, true, JSON.stringify(receipt.problems));
      assert.equal(receipt.evidence.coreConfigHash, sealed.coreConfigHash, 'the host ran exactly the document the core sealed');
      assert.ok(receipt.effects !== null);
      const effects = receipt.effects;
      for (const record of sealed.configuration.records) assert.ok(effects.records.some((effect) => effect.fragmentHash === record.fragmentHash), `record ${record.recordId} observed`);
      for (const mapped of sealed.configuration.fields) assert.ok(effects.fields.some((effect) => effect.fragmentHash === mapped.fragmentHash), `${mapped.destinationField} observed`);
      const edges = effects.associations.find((effect) => effect.fragmentHash === sealed.configuration.associations[0]?.fragmentHash);
      assert.ok(edges !== undefined, 'the association was consumed');
      assert.deepEqual([edges.edges.output, edges.missingEndpoints], [2, 1], 'two edges delivered; the contact whose company is not in the bundle is a missing endpoint');

      const undeclared = toMigrationConfig({ ...configuration, records: configuration.records.map((record) => (record.object === 'COMPANY' ? { ...record, sourceRecordIdColumn: null } : record)) }, profiled.profile);
      assert.equal(undeclared.document, null);
      assert.ok(undeclared.refused.some((entry) => entry.kind === 'ASSOCIATION' && entry.decisionRef === 'cand_0000000000000005' && entry.problem.startsWith('ASSOCIATION_ENDPOINT_UNDECLARED')), JSON.stringify(undeclared.refused));
      const excluded = toMigrationConfig({ ...configuration, excludedColumns: [{ fileId: key.fileId, filePath: key.filePath, columnLocator: key.locator, decisionRef: 'dec_0000000000000006', fragmentHash: '' }] }, profiled.profile);
      assert.equal(excluded.document, null);
      assert.ok(excluded.refused.some((entry) => entry.kind === 'EXCLUDED_COLUMN' && entry.decisionRef === 'dec_0000000000000006' && entry.problem.startsWith('UNSUPPORTED_BY_CORE:EXCLUDED_COLUMN')), JSON.stringify(excluded.refused));
      const dated = { ...configuration, fields: configuration.fields.map((entry, index) => (index === 0 ? { ...entry, transformPrimitive: 'PARSE_DATE_ISO', typedTransformParams: { dayFirst: 'true' } } : entry)) };
      const inexpressible = toMigrationConfig(dated, profiled.profile);
      assert.equal(inexpressible.document, null);
      assert.ok(inexpressible.refused.some((entry) => entry.kind === 'FIELD' && entry.decisionRef === 'dec_0000000000000003' && entry.problem.startsWith('UNSUPPORTED_BY_CORE:PARSE_DATE_ISO')), JSON.stringify(inexpressible.refused));
      const unsealed = sealConfiguration(dated, profiled.profile);
      assert.ok(!unsealed.ok && unsealed.problems.some((problem) => problem.startsWith('UNSUPPORTED_BY_CORE:PARSE_DATE_ISO') && problem.endsWith('@dec_0000000000000003')), JSON.stringify(unsealed));
    } finally {
      bundle.dispose();
    }
  });
});
