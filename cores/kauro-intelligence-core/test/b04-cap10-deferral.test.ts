/**
 * B04 integrate, CAP10 under Migration Core 3.0.0 (coordinator decision D4-MC3-2: the B03 assertion stays as it is).
 *
 * Migration Core 3.0.0 refuses to validate a plan whose creating record mapping maps nothing to a field the attested contract
 * requires (MAPPING_INVALID "... requires a value for contact.lastname to create a record ... maps nothing to it"): such a plan is "a
 * plan to change rather than a dataset to isolate". CAP10's blocking requirement is exactly that plan until the agency decides, so the
 * engine could not reach PROPOSAL_READY through a validation that cannot succeed. The engine now says what it is: a SYSTEM_DRAFT that
 * WAITS FOR THE AGENCY DECISION, whose Migration Core validation is deferred (validation.status DEFERRED_FOR_AGENCY_DECISION, no
 * receipt), and only for the refusal that names a blocking requirement the draft itself reports. Migration Core's validation is
 * mandatory before any final delivery: finalDeliveryBlockers / assertFinalDeliveryAllowed refuse a draft without it.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { DraftMigrationPlan, IntelligenceResult } from '../src/api/intelligence-core.js';
import { assertFinalDeliveryAllowed, finalDeliveryBlockers } from '../src/api/delivery-gate.js';
import { digestOf } from '../src/contracts/canonical.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import type { MemoryEntry } from '../src/contracts/run.js';
import { PROMPT_BUNDLE_VERSION, PROPOSAL_SCHEMA_VERSION, MODEL_POLICY_VERSION } from '../src/contracts/versions.js';
import type { ProposalItem } from '../src/contracts/proposal.js';
import { scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { ScriptEntry, ScriptPayload } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { FullDatasetValidationResult, IntelligenceInput, ProjectRevision } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';
import type { Bundle, FixtureValidationPort } from './support/fixtures.js';
import { isIntelligenceError } from '../src/contracts/errors.js';

type HashedContract = ReturnType<typeof vendorContract>;
type ContractBody = HashedContract['contract'];
type ContractField = ContractBody['objects'][number]['fields'][number];

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly peerDependencies: Readonly<Record<string, string>> };
const peer = (await import(Object.keys(manifest.peerDependencies)[0] ?? '')) as { hashTargetContract(body: ContractBody): HashedContract };
const TIMEOUT = { timeout: 180_000 };
const DECLARED = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } as const;

/** The fixture HubSpot contract with the named `object.apiName` fields required: not nillable, not defaulted. */
function hubspotContract(required: readonly string[]): HashedContract {
  const base = vendorContract('HUBSPOT');
  const body: ContractBody = {
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field): ContractField => (required.includes(`${object.apiName}.${field.apiName}`) ? { ...field, nillable: 'FALSE' } : field)) })),
  };
  return peer.hashTargetContract(body);
}

interface Refs {
  field(file: string, header: string): string;
  target(apiName: string): string;
}

const abstention = (candidate: DeterministicCandidate): ProposalItem => ({ candidateRef: candidate.candidateRef, proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: candidate.evidenceRefs.slice(0, 32), requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, alternatives: [], abstainReason: 'INSUFFICIENT_EVIDENCE' });
const answering = (answer: (candidate: DeterministicCandidate) => Partial<ProposalItem> | null): ScriptEntry => ({
  kind: 'proposal',
  build: (envelope: IntelligenceEnvelopeV1, payload: ScriptPayload) => ({
    schemaVersion: PROPOSAL_SCHEMA_VERSION, taskId: payload.taskId, runId: payload.runId, modelPolicyVersion: MODEL_POLICY_VERSION, promptBundleVersion: PROMPT_BUNDLE_VERSION, envelopeHash: payload.envelopeHash, overallOutcome: 'MIXED',
    items: envelope.deterministicCandidates.map((candidate) => ({ ...abstention(candidate), ...(answer(candidate) ?? {}) })),
  }),
});

interface Ran { readonly result: IntelligenceResult; readonly port: FixtureValidationPort; readonly refs: Refs }

/** One public run over a HubSpot contract that requires Last Name; `wrap` stands between the core and the validation port. */
async function run(name: string, contacts: string, script: (refs: Refs) => Record<string, ScriptEntry>, options: { readonly memory?: (refs: Refs) => readonly MemoryEntry[]; readonly wrap?: (port: FixtureValidationPort) => FixtureValidationPort } = {}): Promise<Ran & { dispose(): void }> {
  const made = makeBundle(name, { contacts, companies: 'Name\nAnalytical Engines\nCOBOL Works\n' });
  const bundle: Bundle = { ...made, files: made.files.map((file) => ({ ...file, idHeader: file.object === 'CONTACT' ? 'Email' : 'Name' })) };
  const contract = hubspotContract(['contact.lastname']);
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const refs: Refs = {
    field: (file, header) => {
      const found = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.filePath === file && entry.header === header)?.[0];
      assert.ok(found !== undefined, `${file} has a column ${header}`);
      return found;
    },
    target: (apiName) => {
      const found = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0];
      assert.ok(found !== undefined, `the contract carries ${apiName}`);
      return found;
    },
  };
  const clock = new VirtualClock();
  const real = realValidationPort(bundle, profiled.profile, contract, { clock });
  const port = options.wrap === undefined ? real : options.wrap(real);
  const gateway = scriptedGateway({ default: answering(() => null), ...script(refs) });
  const base = inputFor('HUBSPOT', profiled, contract, { scopedMemorySnapshot: options.memory?.(refs) ?? [] });
  const input: IntelligenceInput = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } as ProjectRevision };
  const result = await createIntelligenceCore(depsFor(gateway, port, clock)).run(input, CONTEXT);
  return { result, port: real, refs, dispose: () => { bundle.dispose(); } };
}

const NO_SOURCE = 'Email\nada@kauro-fixture.test\ngrace@kauro-fixture.test\n';
const surnameMemory = (refs: Refs): readonly MemoryEntry[] => [{ memoryId: 'mem_5a5b5c5d5e5f6061', scope: 'CLIENT', tenant: CONTEXT.tenant, knowledgeType: 'FIELD_MAPPING_CONVENTION', ruleOrPattern: { sourceHeaderPattern: 'Surname', targetRef: refs.target('lastname'), semanticType: null }, sourceProjectRef: 'project-0', sourcePlanVersion: '1.0.0', targetInstanceRef: null, targetSchemaVersion: null, approvedBy: 'human:qa', verificationOutcome: 'AGENCY_APPROVED', provenance: 'run r task t', createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, status: 'ACTIVE', version: 1 }];
const SURNAME = 'Email,Surname\nada@kauro-fixture.test,Lovelace\ngrace@kauro-fixture.test,\nalan@kauro-fixture.test,Turing\n';
const satisfied = (refs: Refs): Record<string, ScriptEntry> => ({
  FIELD_MAPPING: answering(() => ({ proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
  TARGET_REQUIREMENT: answering((candidate) => (candidate.sourceRefs[0] === refs.field('contacts.csv', 'Surname') ? { proposalType: 'MAP_FIELD', targetRef: refs.target('lastname'), transformPrimitive: null, rationaleCode: 'MEMORY_CONVENTION_APPLIES', abstainReason: null } : null)),
});

/** A port that answers with a returned refusal instead of throwing: the shape a host's port may use. */
const returning = (port: FixtureValidationPort): FixtureValidationPort => ({
  ...port,
  get calls(): number { return port.calls; },
  get lastLoaded(): FixtureValidationPort['lastLoaded'] { return port.lastLoaded; },
  get lastPackage(): FixtureValidationPort['lastPackage'] { return port.lastPackage; },
  async validate(configuration) {
    try {
      return await port.validate(configuration);
    } catch (error) {
      const refused: FullDatasetValidationResult = { configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: '', candidateSetHash: configuration.candidateSetHash, targetContractHash: null, rowsInProfile: 0, validatedAt: new Date(0).toISOString(), coreVersion: '3.0.0', ok: false, rowsValidated: 0, reconciliationHolds: false, packageVerified: false, problems: [error instanceof Error ? error.message : String(error)], evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null };
      return refused;
    }
  },
});

/** A port whose refusal names another field than the blocking requirement (or none): never deferred. */
const refusing = (message: string) => (port: FixtureValidationPort): FixtureValidationPort => ({
  ...port,
  get calls(): number { return port.calls; },
  get lastLoaded(): FixtureValidationPort['lastLoaded'] { return port.lastLoaded; },
  get lastPackage(): FixtureValidationPort['lastPackage'] { return port.lastPackage; },
  async validate(configuration) {
    await port.validate(configuration).catch(() => undefined);
    throw new Error(message);
  },
});

const REFUSAL_OF = (field: string): string => `MAPPING_INVALID: the attested contract for HUBSPOT instance 00000001 requires a value for ${field} to create a record (nillable FALSE, no default on create), and record mapping "F-0" maps nothing to it`;

describe('B04 CAP10 under Migration Core 3.0.0: a blocking requirement is a draft that waits for the agency, never a validated plan', () => {
  it('MC3-CAP10: a requirement nothing satisfies (a column that is no Last Name) is PROPOSAL_READY with Migration Core\'s validation deferred and named, not a failed compile', TIMEOUT, async () => {
    const ran = await run('cap10-deferral-claim', 'Email,Nickname\nada@kauro-fixture.test,Countess\ngrace@kauro-fixture.test,Amazing\n', (refs) => ({
      FIELD_MAPPING: answering(() => ({ proposalType: 'UNMAPPED_PRESERVE', rationaleCode: 'INSUFFICIENT_EVIDENCE', abstainReason: null })),
      TARGET_REQUIREMENT: answering((candidate) => ({ proposalType: 'BLOCKING_TARGET_REQUIREMENT', targetRef: candidate.allowedTargetRefs[0] ?? refs.target('lastname'), requiresAgencyDecision: true, rationaleCode: 'REQUIRED_TARGET_UNSATISFIED', abstainReason: null })),
    }));
    try {
      const { result, port } = ran;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(port.calls, 1, 'Migration Core was asked, and refused the plan');
      assert.deepEqual(result.draft.validation, { status: 'DEFERRED_FOR_AGENCY_DECISION', blockedDestinations: ['contact.lastName'], refusal: 'MAPPING_INVALID' });
      assert.equal(result.draft.fullValidation, null, 'no receipt: nothing was validated');
      assert.equal(result.draft.fragmentCoverage, null, 'no effects were observed, so no fragment is claimed observed');
      assert.deepEqual(result.draft.requirements.map((entry) => [entry.destinationField, entry.status]), [['contact.lastName', 'BLOCKING']]);
      assert.ok(result.draft.decisionsRequired.some((entry) => entry.reason === 'REQUIRED_TARGET_UNSATISFIED:contact.lastName'));
      // The draft cannot be delivered: it names why.
      assert.deepEqual(finalDeliveryBlockers(result.draft), ['VALIDATION_DEFERRED', 'BLOCKING_REQUIREMENT']);
      assert.throws(() => { assertFinalDeliveryAllowed(result.draft); }, (error: unknown) => isIntelligenceError(error) && error.code === 'CONTRACT_VIOLATION' && /final delivery refused: VALIDATION_DEFERRED, BLOCKING_REQUIREMENT/u.test(error.message));
    } finally {
      ran.dispose();
    }
  });

  it('MC3-CAP10: with no column that could hold the requirement the draft is deferred too, no request is made, and the same gate refuses it', TIMEOUT, async () => {
    const ran = await run('cap10-deferral-no-source', NO_SOURCE, () => ({}));
    try {
      assert.equal(ran.result.state, 'PROPOSAL_READY', JSON.stringify(ran.result.unresolvedItems));
      assert.equal(ran.result.draft.validation.status, 'DEFERRED_FOR_AGENCY_DECISION');
      assert.deepEqual(ran.result.draft.validation.blockedDestinations, ['contact.lastName']);
      assert.ok(finalDeliveryBlockers(ran.result.draft).includes('VALIDATION_DEFERRED'));
    } finally {
      ran.dispose();
    }
  });

  it('MC3-CAP10: a validation port that RETURNS the refusal (ok false, no effects) is deferred the same way as one that throws', TIMEOUT, async () => {
    const ran = await run('cap10-deferral-returned', NO_SOURCE, () => ({}), { wrap: returning });
    try {
      assert.equal(ran.result.state, 'PROPOSAL_READY', JSON.stringify(ran.result.unresolvedItems));
      assert.deepEqual(ran.result.draft.validation, { status: 'DEFERRED_FOR_AGENCY_DECISION', blockedDestinations: ['contact.lastName'], refusal: 'MAPPING_INVALID' });
      assert.equal(ran.result.draft.fullValidation, null, 'the refusal is not carried as a receipt: it validated nothing');
    } finally {
      ran.dispose();
    }
  });

  it('MC3-CAP10: only the refusal that names a blocking requirement of the draft is deferred; another field, another code or a port that fails stays FAILED_COMPILER with nothing drafted', TIMEOUT, async () => {
    for (const [label, message, wrap] of [
      ['another field than the blocking requirement', REFUSAL_OF('contact.firstname'), refusing(REFUSAL_OF('contact.firstname'))],
      ['another refusal of Migration Core', 'MAPPING_INVALID: record mapping "F-0" maps one source column twice', refusing('MAPPING_INVALID: record mapping "F-0" maps one source column twice')],
      ['a port that is down', 'ECONNRESET', refusing('ECONNRESET')],
      ['the same refusal, returned, naming another field', REFUSAL_OF('contact.firstname'), (port: FixtureValidationPort) => returning(refusing(REFUSAL_OF('contact.firstname'))(port))],
    ] as const) {
      const ran = await run(`cap10-deferral-other-${label.length}`, NO_SOURCE, () => ({}), { wrap });
      try {
        assert.equal(ran.result.state, 'FAILED_COMPILER', `${label}: ${message}`);
        assert.equal(ran.result.draft.status, 'NOT_DRAFTABLE', label);
        assert.equal(ran.result.draft.validation.status, 'NOT_RUN', label);
      } finally {
        ran.dispose();
      }
    }
  });

  it('MC3-CAP10: the agency\'s decision makes the same plan validate: the draft is VALIDATED, carries Migration Core\'s receipt, and the gate lets it through', TIMEOUT, async () => {
    const ran = await run('cap10-deferral-decided', SURNAME, satisfied, { memory: surnameMemory });
    try {
      const { result } = ran;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.deepEqual(result.draft.validation, { status: 'VALIDATED', blockedDestinations: [], refusal: null });
      assert.ok(result.draft.fullValidation !== null && result.draft.fullValidation.ok, 'Migration Core validated it');
      assert.deepEqual(finalDeliveryBlockers(result.draft), []);
      assert.doesNotThrow(() => { assertFinalDeliveryAllowed(result.draft); });
    } finally {
      ran.dispose();
    }
  });

  it('final delivery without Migration Core\'s validation is refused: no receipt, a failed receipt, a receipt of another configuration, a draft that is not draftable, a requirement still blocking', TIMEOUT, async () => {
    const ran = await run('cap10-deferral-gate', SURNAME, satisfied, { memory: surnameMemory });
    try {
      const draft: DraftMigrationPlan = ran.result.draft;
      const receipt = draft.fullValidation as FullDatasetValidationResult;
      assert.deepEqual(finalDeliveryBlockers(draft), [], 'the control: the validated draft passes');
      const cases: readonly (readonly [string, DraftMigrationPlan, readonly string[]])[] = [
        ['no receipt', { ...draft, fullValidation: null }, ['NO_MIGRATION_CORE_VALIDATION']],
        ['validation never run', { ...draft, validation: { status: 'NOT_RUN', blockedDestinations: [], refusal: null } }, ['NO_MIGRATION_CORE_VALIDATION']],
        ['a failed receipt', { ...draft, fullValidation: { ...receipt, ok: false } }, ['MIGRATION_CORE_VALIDATION_FAILED']],
        ['a receipt whose package was not verified', { ...draft, fullValidation: { ...receipt, packageVerified: false } }, ['MIGRATION_CORE_VALIDATION_FAILED']],
        ['a receipt whose reconciliation does not hold', { ...draft, fullValidation: { ...receipt, reconciliationHolds: false } }, ['MIGRATION_CORE_VALIDATION_FAILED']],
        ['a receipt of another configuration', { ...draft, fullValidation: { ...receipt, configurationDigest: 'f'.repeat(64) } }, ['RECEIPT_NOT_BOUND_TO_CONFIGURATION']],
        ['a draft that is not draftable', { ...draft, status: 'NOT_DRAFTABLE', configuration: null }, ['NOT_DRAFTABLE', 'NO_CONFIGURATION']],
        ['a requirement still blocking', { ...draft, requirements: draft.requirements.map((entry) => ({ ...entry, status: 'BLOCKING' as const })) }, ['BLOCKING_REQUIREMENT']],
      ];
      for (const [label, candidate, expected] of cases) {
        assert.deepEqual(finalDeliveryBlockers(candidate), expected, label);
        assert.throws(() => { assertFinalDeliveryAllowed(candidate); }, (error: unknown) => isIntelligenceError(error) && error.code === 'CONTRACT_VIOLATION' && error.message.includes('final delivery refused: '), label);
      }
    } finally {
      ran.dispose();
    }
  });
});
