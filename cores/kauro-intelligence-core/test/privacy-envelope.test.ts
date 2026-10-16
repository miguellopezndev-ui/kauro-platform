import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hashTargetContract } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { digestOf } from '../src/contracts/canonical.js';
import { cleanOnlyTargetRef, envelopeHash } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, MemoryEvidenceItem, RepairContext } from '../src/contracts/envelope.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { TaskRecord } from '../src/contracts/run.js';
import { DATA_POLICY_VERSION, MASKING_POLICY_VERSION, buildEnvelope, decideEgress } from '../src/envelope/envelope-builder.js';
import { MODEL_POLICY_V1, PROMPT_BUNDLE_HASH, PROMPT_BUNDLE_V1 } from '../src/gateway/model-gateway.js';
import { buildProviderRequest } from '../src/gateway/transport-gateway.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { makeBundle, profileBundle, vendorContract } from './support/fixtures.js';

const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };
const secret = Buffer.alloc(32, 5);

/** The task of the resolver's plan that carries the field with this header, with its derived candidates. */
function taskFor(contracts: AdaptedContracts, header: string): { task: TaskRecord; candidates: DeterministicCandidate[]; fieldRef: string; locator: string } {
  const resolution = resolve(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } });
  const planned = plan('c'.repeat(64), resolution.openQuestions);
  const derived = new Map(resolution.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
  const entry = [...contracts.refs.fieldByRef.entries()].find(([, info]) => info.header === header);
  assert.ok(entry !== undefined, `the profile has ${header}`);
  const [fieldRef, info] = entry;
  const task = planned.tasks.find((candidate) => candidate.candidateRefs.some((ref) => derived.get(ref)?.sourceRefs.includes(fieldRef)));
  assert.ok(task !== undefined, `a task carries ${header}`);
  return { task, candidates: task.candidateRefs.map((ref) => derived.get(ref)).filter((candidate): candidate is DeterministicCandidate => candidate !== undefined), fieldRef, locator: info.locator };
}

/** The scope every envelope of these tests is built in unless a test names another: one tenant, one project revision (masking policy 1.3.0). */
const SCOPE = { tenant: { agencyId: 'agency-a', clientId: 'client-1' }, projectRevisionId: 'rev', projectRevisionHash: 'c'.repeat(64) } as const;

const build = (contracts: AdaptedContracts, header: string, summaries: ReadonlyMap<string, readonly string[]>, memoryEvidence: readonly MemoryEvidenceItem[] = [], repair: RepairContext | null = null, egressSecret: Buffer = secret, scope: typeof SCOPE = SCOPE) => {
  const { task, candidates, fieldRef, locator } = taskFor(contracts, header);
  const effective: TaskRecord = repair === null ? task : { ...task, taskType: 'SEMANTIC_REPAIR' };
  return { fieldRef, locator, built: buildEnvelope({ task: effective, contracts, candidates, memoryEvidence, summaries, projectRevisionId: scope.projectRevisionId, projectRevisionHash: scope.projectRevisionHash, supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: repair, egressSecret, tenant: scope.tenant, attemptId: 'attempt-0001' }) };
};

describe('F01: the envelope carries no metadata or value the classifier did not pass', () => {
  const bundle = makeBundle('privacy-envelope', {
    contacts: 'Contact ID,First Name,Email,Status,audit-person@example.test,Segment,Tier,Reference\n1,Ada,ada@x.test,Active,Alice,Alice,high,12345678Z\n2,Grace,grace@x.test,Inactive,Maria,Maria,low,ES9121000418450200051332\n3,Alan,alan@x.test,Active,Alice,Alice,urgent,4111 1111 1111 1111\n',
  });
  const profiled = profileBundle(bundle, 'CLEAN_ONLY');
  const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
  const locatorOf = (header: string): string => [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === header)?.locator ?? '';
  const summaries = new Map<string, readonly string[]>([
    [locatorOf('Status'), ['Active', 'Inactive']],
    [locatorOf('Segment'), ['Alice', 'Maria']],
    // Eight safe values, then a phone: a first-N selection would never have looked at it.
    [locatorOf('Tier'), ['high', 'medium', 'low', 'normal', 'urgent', 'critical', 'hot', 'warm', '+34 612 345 678']],
    [locatorOf('audit-person@example.test'), ['Alice', 'Maria']],
    [locatorOf('Reference'), ['12345678Z', 'ES9121000418450200051332', '4111 1111 1111 1111']],
  ]);

  it('the policy versions changed with the semantics', () => {
    assert.equal(MASKING_POLICY_VERSION, '1.4.0', 'mask tokens are bound to the tenant, the attempt and the revision');
    assert.equal(DATA_POLICY_VERSION, '1.7.0', 'the privacy repair: no identifier is admitted by its case; joined and suffixed names are personal values; a value its target lists as a person is one');
  });
  it('the audit reproduction: a header that is an email address travels as a token, never as text, and the task still leaves', () => {
    const { fieldRef, built } = build(contracts, 'audit-person@example.test', summaries);
    const field = built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef);
    assert.ok(field !== undefined);
    assert.match(field.header, /^hdr_[g-v]{12}$/u);
    assert.ok(!JSON.stringify(built.envelope).includes('audit-person'), 'the raw header is nowhere in the envelope');
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === fieldRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('header:')), 'the class is recorded against the ref');
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED', 'masked metadata is not a reason to abstain');
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), 'a column of given names emits no exemplar');
  });
  it('the audit reproduction: given names at low cardinality emit no exemplar; the safe vocabulary next to them still travels as L1', () => {
    const { fieldRef, built } = build(contracts, 'Segment', summaries);
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef));
    assert.ok(!JSON.stringify(built.envelope).includes('Alice') && !JSON.stringify(built.envelope).includes('Maria'));
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    const status = build(contracts, 'Status', summaries);
    assert.ok(status.built.envelope.exemplars.some((exemplar) => exemplar.fieldRef === status.fieldRef && exemplar.dataLevel === 'L1' && exemplar.minimizedValueOrClass === 'Active'), 'a real enumeration travels as L1');
    assert.equal(status.built.minimization.maxDataLevel, 'L1');
  });
  it('a column is classified whole before any exemplar is selected: a phone beyond the first N closes the column', () => {
    const { fieldRef, built } = build(contracts, 'Tier', summaries);
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), 'not even the eight safe values travel');
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === fieldRef && entry.dataClass === 'POTENTIAL_PII'));
    assert.ok(!JSON.stringify(built.envelope).includes('612 345 678'));
  });
  it('identity and financial numbers among the values are SENSITIVE and leave nothing behind', () => {
    const { fieldRef, built } = build(contracts, 'Reference', summaries);
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef));
    assert.ok(built.minimization.classesSeen.includes('SENSITIVE_OR_RESTRICTED'));
    const text = JSON.stringify(built.envelope);
    for (const sentinel of ['12345678Z', 'ES9121000418450200051332', '4111 1111 1111 1111']) assert.ok(!text.includes(sentinel), sentinel);
  });
  it('memory text is classified like a header: a pattern carrying an email travels as the same token its header gets', () => {
    const memory: MemoryEvidenceItem = { memoryId: 'mem_0123456789abcdef', scope: 'CLIENT', knowledgeType: 'FIELD_MAPPING_CONVENTION', rule: { sourceHeaderPattern: 'audit-person@example.test', targetRef: cleanOnlyTargetRef('contact.email'), semanticType: null }, verificationOutcome: 'AGENCY_APPROVED', weight: 0.3, status: 'ACTIVE' };
    const { fieldRef, built } = build(contracts, 'audit-person@example.test', summaries, [memory]);
    const item = built.envelope.memoryEvidence[0];
    assert.ok(item !== undefined);
    assert.match(item.rule.sourceHeaderPattern, /^hdr_[g-v]{12}$/u);
    assert.equal(item.rule.sourceHeaderPattern, built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef)?.header, 'equal texts share a token');
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === 'mem_0123456789abcdef' && entry.reason.startsWith('memory pattern:')));
    const structural: MemoryEvidenceItem = { ...memory, memoryId: 'mem_fedcba9876543210', rule: { ...memory.rule, sourceHeaderPattern: 'Status' } };
    const kept = build(contracts, 'Status', summaries, [structural]);
    assert.equal(kept.built.envelope.memoryEvidence[0]?.rule.sourceHeaderPattern, 'Status', 'a structural pattern travels as text');
  });
  it('repair context: a code that names a person travels as a token, a value that is an email is dropped', () => {
    const repair: RepairContext = { previousProposalDigest: 'd'.repeat(64), validationCodes: ['INVALID_SCHEMA', 'UNKNOWN_PARAM_ALICE'], allowedValues: ['Enterprise', 'bob@example.test'], allowedTargetRefs: [] };
    const { built } = build(contracts, 'Status', summaries, [], repair);
    assert.deepEqual(built.envelope.repairContext?.validationCodes.map((code) => (code.startsWith('code_') ? 'code_*' : code)), ['INVALID_SCHEMA', 'code_*']);
    assert.deepEqual(built.envelope.repairContext?.allowedValues, ['Enterprise']);
    assert.ok(!JSON.stringify(built.envelope).includes('ALICE') && !JSON.stringify(built.envelope).includes('bob@'));
  });
  it('the egress decision re-reads the envelope: a raw personal header put back after redaction is a policy block', () => {
    const { fieldRef, built } = build(contracts, 'audit-person@example.test', summaries);
    const envelope = { ...built.envelope, sourceProfile: { ...built.envelope.sourceProfile, fields: built.envelope.sourceProfile.fields.map((field) => (field.fieldRef === fieldRef ? { ...field, header: 'audit-person@example.test' } : field)) } };
    const decision = decideEgress({ envelope, hash: envelopeHash(envelope), minimization: built.minimization, budget, secret });
    assert.equal(decision.decision, 'EGRESS_BLOCKED_POLICY');
    assert.ok(decision.blockedReasons.some((reason) => reason.includes('metadata text that failed classification')));
  });
  it('F01-R3: a mask token is keyed by the egress secret — stable within a core, different across cores, never verifiable from the bytes', () => {
    const header = 'audit-person@example.test';
    const tokenOf = (egressSecret: Buffer, of: string = header): string => {
      const { fieldRef, built } = build(contracts, of, summaries, [], null, egressSecret);
      return built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef)?.header ?? '';
    };
    const first = tokenOf(secret);
    assert.match(first, /^hdr_[g-v]{12}$/u, 'the token keeps its shape');
    assert.equal(tokenOf(secret), first, 'the same core masks the same header to the same token across tasks');
    const other = tokenOf(Buffer.alloc(32, 6));
    assert.match(other, /^hdr_[g-v]{12}$/u);
    assert.notEqual(other, first, 'a core with another secret masks it to another token');
    // A keyless digest of the profile hash and the header — what the bytes would let anyone recompute — is not the token.
    const keyless = `hdr_${digestOf(['mask', contracts.profileHash, header]).slice(0, 12).replace(/[0-9a-f]/gu, (digit) => 'ghijklmnopqrstuv'[Number.parseInt(digit, 16)] ?? 'g')}`;
    assert.notEqual(first, keyless);
    assert.notEqual(other, keyless);
  });
  it('no reason, code or blocked entry echoes the text it is about', () => {
    const everything = JSON.stringify([build(contracts, 'audit-person@example.test', summaries), build(contracts, 'Segment', summaries), build(contracts, 'Tier', summaries), build(contracts, 'Reference', summaries)].map((entry) => [entry.built.minimization, entry.built.egress]));
    for (const sentinel of ['audit-person', 'Alice', 'Maria', '612 345 678', '12345678Z', 'ES9121000418450200051332', '4111 1111 1111 1111']) assert.ok(!everything.includes(sentinel), sentinel);
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

describe('F01: target contract text goes through the same classifier and the picklist keeps its authority', () => {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  // The same fixture contract with a picklist whose options are not in the safe vocabulary, plus one option that is an email address.
  const contract = hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, picklistValues: [{ value: 'Enterprise', label: 'Enterprise', active: true, defaultValue: false }, { value: 'Startup', label: 'Startup', active: true, defaultValue: false }, { value: 'alice@example.test', label: 'Alice', active: true, defaultValue: false }] } : field)) })),
  });
  const bundle = makeBundle('privacy-vendor', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,Enterprise\n2,Grace,Hopper,grace@x.test,,Startup\n3,Alan,Turing,alan@x.test,,Enterprise\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';

  it('values that match the target picklist travel as L1 — the option list is the authority, not the shape', () => {
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, ['Enterprise', 'Startup']]]));
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    assert.deepEqual(built.envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass).sort(), ['Enterprise', 'Startup']);
  });
  it('an option that is an email is dropped from the target view; the others stay; labels and api names travel', () => {
    const { built } = build(contracts, 'Segment', new Map());
    assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
    if (built.envelope.targetContract.mode === 'CLEAN_ONLY') return;
    const stage = built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
    assert.ok(stage !== undefined, 'the picklist field is in the view');
    assert.deepEqual(stage.options, ['Enterprise', 'Startup']);
    assert.equal(stage.label, 'Lifecycle Stage');
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === stage.targetRef && entry.reason.startsWith('target option:')));
    assert.ok(!JSON.stringify(built.envelope).includes('alice@example.test'));
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

/** The bytes the provider would receive for a built envelope: what the audit probe captured through buildProviderRequest. */
const providerBytes = (built: ReturnType<typeof buildEnvelope>): string =>
  JSON.stringify(buildProviderRequest({ modelPolicy: MODEL_POLICY_V1, promptBundleRef: { promptBundleVersion: PROMPT_BUNDLE_V1.promptBundleVersion, promptBundleHash: PROMPT_BUNDLE_HASH }, envelope: built.envelope, envelopeHash: built.hash, runId: 'run_0123456789abcdef', outputSchema: PROMPT_BUNDLE_V1.outputSchema, deadlineAt: budget.deadlineAt, idempotencyRef: 'k', maxOutputTokens: 8192 }));

/** The HubSpot fixture contract with the lifecycle picklist replaced by these options. */
function contractWithOptions(options: readonly string[]): ReturnType<typeof hashTargetContract> {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  return hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : field)) })),
  });
}

describe('IC-05: a person name that is a target option never travels as an option or as an L1 exemplar', () => {
  const bundle = makeBundle('privacy-ic05', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,Zuleika\n2,Grace,Hopper,grace@x.test,,Svetlana\n3,Alan,Turing,alan@x.test,,Kowalski\n4,Joan,Clarke,joan@x.test,,山田太郎\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const setup = (options: readonly string[]) => {
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contractWithOptions(options) });
    const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';
    return { contracts, locator };
  };

  it('the audit reproduction PRIV-option-Zuleika/Svetlana, and Kowalski and 山田太郎 with them: the name is nowhere in the provider bytes', () => {
    for (const name of ['Zuleika', 'Svetlana', 'Kowalski', '山田太郎']) {
      const { contracts, locator } = setup([name]);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, [name]]]));
      const bytes = providerBytes(built);
      assert.ok(!bytes.includes(name), `${name} left in the provider request`);
      assert.ok(!JSON.stringify(built.envelope).includes(name), `${name} left in the envelope`);
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), `${name}: a column of names emits no exemplar`);
      assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
      if (built.envelope.targetContract.mode === 'CLEAN_ONLY') continue;
      const stage = built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
      assert.deepEqual(stage?.options, [], `${name}: the option is dropped from the target view`);
      assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')), `${name}: the class is recorded against the target ref`);
    }
  });
  it('the control PRIV-option-Active, and a genuine enumeration: the option travels and the value travels as L1 by it', () => {
    const { contracts, locator } = setup(['Active']);
    const control = build(contracts, 'Segment', new Map([[locator, ['Active']]]));
    assert.equal(control.built.egress.decision, 'EGRESS_ALLOWED');
    assert.ok(providerBytes(control.built).includes('Active'));
    const enumeration = setup(['Enterprise', 'Startup']);
    const { fieldRef, built } = build(enumeration.contracts, 'Segment', new Map([[enumeration.locator, ['Enterprise', 'Startup']]]));
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    assert.deepEqual(built.envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass).sort(), ['Enterprise', 'Startup']);
    assert.ok(providerBytes(built).includes('Enterprise') && providerBytes(built).includes('Startup'));
  });
  it('the egress decision re-reads exemplar values: an L1 name or an L2 shape that still carries a letter is a policy block whatever the report says', () => {
    const { contracts, locator } = setup(['Enterprise', 'Startup']);
    const { built } = build(contracts, 'Segment', new Map([[locator, ['Enterprise', 'Startup']]]));
    const first = built.envelope.exemplars[0];
    assert.ok(first !== undefined);
    const forge = (exemplar: typeof first): ReturnType<typeof decideEgress> => {
      const envelope = { ...built.envelope, exemplars: [...built.envelope.exemplars, { ...exemplar, exemplarRef: 'ex_0000000000000000' }] };
      return decideEgress({ envelope, hash: envelopeHash(envelope), minimization: built.minimization, budget, secret });
    };
    for (const name of ['Zuleika', 'Svetlana', 'Kowalski', '山田太郎', 'Alice', 'ada@x.test']) {
      const decision = forge({ ...first, dataLevel: 'L1', minimizedValueOrClass: name, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' });
      assert.equal(decision.decision, 'EGRESS_BLOCKED_POLICY', name);
      assert.ok(decision.blockedReasons.some((reason) => reason.includes('exemplar value fails the hard rules')), name);
    }
    for (const shape of ['Zuleika', '田中太郎', 'Aaa9 b', '']) assert.equal(forge({ ...first, dataLevel: 'L2', minimizedValueOrClass: shape, dataClass: 'SAFE_STRUCTURAL_METADATA' }).decision, 'EGRESS_BLOCKED_POLICY', `L2 ${JSON.stringify(shape)}`);
    assert.equal(forge({ ...first, dataLevel: 'L2', minimizedValueOrClass: 'Aaaa aaaa 9999', dataClass: 'SAFE_STRUCTURAL_METADATA' }).decision, 'EGRESS_ALLOWED', 'a real shape passes');
    assert.equal(forge({ ...first, dataLevel: 'L1', minimizedValueOrClass: 'Startup', dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' }).decision, 'EGRESS_ALLOWED', 'a vetted option passes');
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

describe('F01-R1: caseless-script names as values and as headers never reach the provider bytes, and a mask never carries script text', () => {
  const NAMES = ['田中太郎', '王伟', 'محمد', '김민수', 'דוד', 'สมชาย'] as const;
  const row = NAMES.join(',');
  const bundle = makeBundle('privacy-caseless', {
    contacts: `Contact ID,First Name,Email,Status,${row},Segment,Notes\n1,Ada,ada@x.test,Active,${row},田中太郎,Sección 田中\n2,Grace,grace@x.test,Inactive,${row},王伟,Sección 王伟\n3,Alan,alan@x.test,Active,${row},محمد,สวัสดีครับยินดีต้อนรับสู่ระบบของเรา\n`,
  });
  const profiled = profileBundle(bundle, 'CLEAN_ONLY');
  const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
  const locatorOf = (header: string): string => [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === header)?.locator ?? '';
  const repair: RepairContext = { previousProposalDigest: 'd'.repeat(64), validationCodes: ['INVALID_SCHEMA'], allowedValues: [], allowedTargetRefs: [] };

  it('as values on the L2 path (SEMANTIC_REPAIR): a column of caseless names emits neither a value nor a shape', () => {
    const summaries = new Map<string, readonly string[]>([[locatorOf('Segment'), [...NAMES]]]);
    const { fieldRef, built } = build(contracts, 'Segment', summaries, [], repair);
    assert.equal(built.envelope.taskType, 'SEMANTIC_REPAIR');
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef));
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === fieldRef && entry.dataClass === 'POTENTIAL_PII'));
    const bytes = providerBytes(built);
    for (const name of NAMES) assert.ok(!bytes.includes(name), name);
  });
  it('as free text on the L2 path: the shape that travels has no letter of any script left in it', () => {
    const summaries = new Map<string, readonly string[]>([[locatorOf('Notes'), ['Sección 田中', 'Sección 王伟', 'Nota interna 田中 revisada hoy']]]);
    const { fieldRef, built } = build(contracts, 'Notes', summaries, [], repair);
    const shapes = built.envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef);
    assert.ok(shapes.length >= 1, 'a shape travels for the repair');
    for (const exemplar of shapes) {
      assert.equal(exemplar.dataLevel, 'L2');
      assert.match(exemplar.minimizedValueOrClass, /^[Aa9\s'’.-]+$/u, exemplar.minimizedValueOrClass);
    }
    const bytes = providerBytes(built);
    for (const sentinel of ['田中', '王伟', 'สวัสดี']) assert.ok(!bytes.includes(sentinel), sentinel);
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
  });
  it('as headers: each travels as a token, never as text', () => {
    for (const name of NAMES) {
      const { fieldRef, built } = build(contracts, name, new Map([[locatorOf(name), ['Active', 'Inactive']]]));
      const field = built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef);
      assert.ok(field !== undefined, name);
      assert.match(field.header, /^hdr_[g-v]{12}$/u, name);
      assert.ok(!providerBytes(built).includes(name), `${name} in the provider bytes`);
      assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === fieldRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('header:')), name);
    }
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

describe('F01-R2: a target field whose label names people holds names, and none of its options vouches for a value', () => {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  const owner = hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, label: 'Deal owner', picklistValues: [{ value: 'Enterprise', label: 'Enterprise', active: true, defaultValue: false }, { value: 'Startup', label: 'Startup', active: true, defaultValue: false }] } : field)) })),
  });
  const bundle = makeBundle('privacy-owner', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,Enterprise\n2,Grace,Hopper,grace@x.test,,Startup\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: owner });
  const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';

  it('the options of an owner picklist are dropped from the view and vouch for nothing, though each would pass the OPTION channel on its own', () => {
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, ['Enterprise', 'Startup']]]));
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), 'no L1 by an owner option');
    assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
    if (built.envelope.targetContract.mode === 'CLEAN_ONLY') return;
    const stage = built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
    assert.deepEqual(stage?.options, []);
    assert.equal(stage?.label, 'Deal owner', 'the label itself is structural vocabulary');
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === stage?.targetRef && entry.reason.includes('label names people')));
    for (const sentinel of ['Enterprise', 'Startup']) assert.ok(!providerBytes(built).includes(sentinel), sentinel);
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

/** The HubSpot fixture contract with the lifecycle picklist relabelled and its options replaced: the reviewer's S3 shape. */
function contractWithPicklist(label: string, options: readonly string[]): ReturnType<typeof hashTargetContract> {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  return hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, label, picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : field)) })),
  });
}

/** The reviewer's S3 cases: a label the person-field vocabulary does not name, and single-token names of five scripts as its options. */
const S3_CASES = [
  { name: 'S3a', label: 'Comercial', options: ['Iker', 'Unai', 'Ainhoa', 'Leire'] },
  { name: 'S3b', label: 'Менеджер', options: ['Светлана', 'Дмитрий', 'Ольга'] },
  { name: 'S3c', label: 'Status', options: ['გიორგი', 'ნინო', 'დავითი'] },
  { name: 'S3f', label: 'Vendedor', options: ['Γιώργος', 'Μαρία', 'Νίκος'] },
  { name: 'S3g', label: 'Sales Rep', options: ['Zbigniew', 'Okonkwo', 'Thandiwe', 'Unassigned'] },
] as const;

describe('R2-PC-01: a single-token person name in a picklist under a label the person-field vocabulary does not name never reaches the provider bytes', () => {
  const bundle = makeBundle('privacy-r2-pc-01', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,Iker\n2,Grace,Hopper,grace@x.test,,Unai\n3,Alan,Turing,alan@x.test,,Ainhoa\n4,Joan,Clarke,joan@x.test,,Leire\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const setup = (label: string, options: readonly string[]) => {
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contractWithPicklist(label, options) });
    const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';
    return { contracts, locator };
  };

  it('the reproduction S3a/S3b/S3c/S3f/S3g: no name is an option on the wire, no name is an L1 exemplar, and each is recorded as PII against the target', () => {
    for (const { name, label, options } of S3_CASES) {
      const names = options.filter((option) => option !== 'Unassigned');
      const { contracts, locator } = setup(label, options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      const bytes = providerBytes(built);
      for (const sentinel of names) {
        assert.ok(!bytes.includes(sentinel), `${name}: ${sentinel} in the provider request`);
        assert.ok(!JSON.stringify(built.envelope).includes(sentinel), `${name}: ${sentinel} in the envelope`);
      }
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), `${name}: a column of names emits no exemplar, not even for the enumeration among them`);
      assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
      if (built.envelope.targetContract.mode === 'CLEAN_ONLY') continue;
      const stage = built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
      assert.deepEqual(stage?.options, options.filter((option) => option === 'Unassigned'), `${name}: only the enumeration survives in the target view`);
      assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')).length, names.length, `${name}: every name is recorded against the target ref`);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', `${name}: the redacted envelope still leaves`);
    }
  });
  it('the positives under the same labels: genuine enumerations travel as options and vouch for the identical values as L1', () => {
    const cases = [
      { label: 'Comercial', options: ['Inbound', 'Outbound', 'Partner'] },
      { label: 'Sales Rep', options: ['Unassigned', 'Team A', 'Team B'] },
      { label: 'Vendedor', options: ['Enterprise', 'Startup', 'SMB'] },
      { label: 'Менеджер', options: ['Closed Won', 'Closed Lost', 'In Progress'] },
      { label: 'Status', options: ['Active', 'Inactive', 'Pending'] },
    ] as const;
    for (const { label, options } of cases) {
      const { contracts, locator } = setup(label, options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', label);
      const travelled = built.envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass);
      // One exemplar per masked shape: what travels is a non-empty subset of the options and nothing else.
      assert.ok(travelled.length >= 1 && travelled.every((value) => (options as readonly string[]).includes(value)), `${label}: the values travel as L1 by the options: ${travelled.join('|')}`);
      assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
      if (built.envelope.targetContract.mode === 'CLEAN_ONLY') continue;
      const stage = built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage');
      assert.deepEqual(stage?.options, options, `${label}: the options travel`);
      const bytes = providerBytes(built);
      for (const option of options) assert.ok(bytes.includes(option), `${label}: ${option} on the wire`);
    }
  });
  it('the restriction still holds on top: the same enumerations under an owner label are dropped and vouch for nothing', () => {
    const { contracts, locator } = setup('Deal owner', ['Inbound', 'Outbound']);
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, ['Inbound', 'Outbound']]]));
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef));
    if (built.envelope.targetContract.mode === 'CLEAN_ONLY') return;
    assert.deepEqual(built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage')?.options, []);
  });
  it('the egress re-read refuses a forged L1 of any of the names against the redacted options', () => {
    const { contracts, locator } = setup('Lifecycle Stage', ['Enterprise', 'Startup']);
    const { built } = build(contracts, 'Segment', new Map([[locator, ['Enterprise', 'Startup']]]));
    const first = built.envelope.exemplars[0];
    assert.ok(first !== undefined);
    for (const name of S3_CASES.flatMap((entry) => entry.options).filter((option) => option !== 'Unassigned')) {
      const envelope: IntelligenceEnvelopeV1 = { ...built.envelope, exemplars: [...built.envelope.exemplars, { ...first, exemplarRef: 'ex_0000000000000000', dataLevel: 'L1' as const, minimizedValueOrClass: name, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' as const }] };
      assert.equal(decideEgress({ envelope, hash: envelopeHash(envelope), minimization: built.minimization, budget, secret }).decision, 'EGRESS_BLOCKED_POLICY', name);
    }
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

/** Whether the token stands as a whole word in the text: LEE inside a longer identifier or digest is not LEE on the wire. */
const wordIn = (token: string, text: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}_])${token}(?![\\p{L}\\p{N}_])`, 'u').test(text);

/** Round-4 picklists: a column of the reviewer's tokens, the same tokens as the lifecycle picklist under a label, and what the wire may carry. */
describe('R2R-PC-01/02/03: short upper-case surnames, name-derived handles and vocabulary-homonym surnames in a picklist never reach the provider bytes', () => {
  const bundle = makeBundle('privacy-r2r-pc', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,LEE\n2,Grace,Hopper,grace@x.test,,WU\n3,Alan,Turing,alan@x.test,,KIM\n4,Joan,Clarke,joan@x.test,,US\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const setup = (label: string, options: readonly string[]) => {
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contractWithPicklist(label, options) });
    const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';
    return { contracts, locator };
  };
  const stageOf = (built: ReturnType<typeof buildEnvelope>) => (built.envelope.targetContract.mode === 'CLEAN_ONLY' ? undefined : built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage'));
  const travelled = (built: ReturnType<typeof buildEnvelope>, fieldRef: string): string[] => built.envelope.exemplars.filter((exemplar) => exemplar.fieldRef === fieldRef && exemplar.dataLevel === 'L1').map((exemplar) => exemplar.minimizedValueOrClass);

  it('R2R-PC-01 reproduction: LEE, WU, KIM as values under a header the name rule does not know, with and without the same picklist — no exemplar, no option, none in the bytes', () => {
    const names = ['LEE', 'WU', 'KIM'];
    for (const options of [[] as string[], ['LEE', 'WU', 'KIM', 'US']]) {
      const { contracts, locator } = setup('Region', options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, [...names, 'US']]]));
      const bytes = providerBytes(built);
      for (const sentinel of names) {
        assert.ok(!wordIn(sentinel, bytes), `${sentinel} in the provider request (options ${options.length})`);
        assert.ok(!wordIn(sentinel, JSON.stringify(built.envelope)), `${sentinel} in the envelope`);
      }
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), 'a column with a short upper-case surname in it emits no exemplar, not even the ISO code beside it');
      if (options.length > 0) assert.deepEqual(stageOf(built)?.options, ['US'], 'only the ISO code survives in the target view');
    }
  });
  it('R2R-PC-01 positive: an ISO country or currency picklist travels as options and the values travel as L1 by the closed list', () => {
    const codes = ['US', 'ES', 'MX', 'EUR', 'USD'];
    const { contracts, locator } = setup('Country', codes);
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, codes]]));
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    assert.deepEqual(stageOf(built)?.options, codes);
    const values = travelled(built, fieldRef);
    assert.ok(values.length >= 1 && values.every((value) => codes.includes(value)), values.join('|'));
    const bytes = providerBytes(built);
    for (const code of codes) assert.ok(wordIn(code, bytes), `${code} on the wire`);
  });
  it('R2R-PC-02 reproduction: zuleika7, jkowalski1, mlopez01 as picklist options with the identical values — no option, no exemplar, none in the bytes', () => {
    const handles = ['zuleika7', 'jkowalski1', 'mlopez01'];
    const { contracts, locator } = setup('Status', [...handles, 'A12']);
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, [...handles, 'A12']]]));
    const bytes = providerBytes(built);
    for (const sentinel of handles) {
      assert.ok(!bytes.includes(sentinel), `${sentinel} in the provider request`);
      assert.ok(!JSON.stringify(built.envelope).includes(sentinel), `${sentinel} in the envelope`);
    }
    assert.deepEqual(stageOf(built)?.options, ['A12'], 'only the code survives in the target view');
    assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), 'the column closes on the handles');
    const stage = stageOf(built);
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')), 'zuleika7 is recorded as PII against the target');
    // Revision 009: the handles no name list knows are personal too (data policy 1.5.0), so every dropped handle is recorded as PII and none as UNKNOWN.
    assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')).length, handles.length, 'every handle is recorded as PII against the target');
    assert.ok(!built.minimization.blocked.some((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'UNKNOWN'), 'no handle is left UNKNOWN against the target');
  });
  it('R2R-PC-02 positive: codes with digits — A12, SKU-0042, 2024Q1, 001, tier1 — travel as options and the values travel as L1 by them', () => {
    const codes = ['A12', 'SKU-0042', '2024Q1', '001', 'tier1'];
    const { contracts, locator } = setup('Status', codes);
    const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, codes]]));
    assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    assert.deepEqual(stageOf(built)?.options, codes);
    const values = travelled(built, fieldRef);
    assert.ok(values.length >= 1 && values.every((value) => codes.includes(value)), values.join('|'));
    const bytes = providerBytes(built);
    for (const code of codes) assert.ok(bytes.includes(code), `${code} on the wire`);
  });
  it('R2R-PC-03 tie-break: Klein, Petit, Price, Campos beside a name the channel refused, or under a label that may name people, are dropped and vouch for nothing', () => {
    const cases = [
      { label: 'Segmento', options: ['Klein', 'Petit', 'Zbigniew'], homonyms: ['Klein', 'Petit'], survivors: [] as string[] },
      { label: 'Segmento', options: ['Price', 'Campos', 'García', 'Enterprise'], homonyms: ['Price', 'Campos'], survivors: ['Enterprise'] },
      { label: 'Comercial', options: ['Klein', 'Petit', 'Retail'], homonyms: ['Klein', 'Petit'], survivors: ['Retail'] },
      { label: 'Vendedor', options: ['Gross', 'Grand', 'Unassigned'], homonyms: ['Gross', 'Grand'], survivors: ['Unassigned'] },
      { label: 'Created by', options: ['Fields', 'Banks', 'Day'], homonyms: ['Fields', 'Banks', 'Day'], survivors: [] as string[] },
    ];
    for (const { label, options, homonyms, survivors } of cases) {
      const { contracts, locator } = setup(label, options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      const bytes = providerBytes(built);
      for (const sentinel of homonyms) {
        assert.ok(!wordIn(sentinel, bytes), `${label}: ${sentinel} in the provider request`);
        assert.ok(!wordIn(sentinel, JSON.stringify(built.envelope)), `${label}: ${sentinel} in the envelope`);
      }
      assert.deepEqual(stageOf(built)?.options, survivors, `${label}: only the enumeration survives`);
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), `${label}: the column of surnames emits no exemplar`);
      const stage = stageOf(built);
      assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === stage?.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')).length, options.length - survivors.length, `${label}: every dropped option is recorded as PII against the target`);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', `${label}: the redacted envelope still leaves`);
    }
  });
  it('R2R-PC-03 positive: the same words in a list of words under a label that does not name people are the words — sizes, tiers, metals travel and vouch', () => {
    const cases = [
      { label: 'Company Size', options: ['Klein', 'Mittel', 'Gross'] },
      { label: 'Taille', options: ['Petit', 'Moyen', 'Grand'] },
      { label: 'Tier', options: ['Gold', 'Silver', 'Bronze'] },
      { label: 'Segmento', options: ['Small', 'Medium', 'Large'] },
    ];
    for (const { label, options } of cases) {
      const { contracts, locator } = setup(label, options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', label);
      assert.deepEqual(stageOf(built)?.options, options, `${label}: the options travel`);
      const values = travelled(built, fieldRef);
      assert.ok(values.length >= 1 && values.every((value) => options.includes(value)), `${label}: ${values.join('|')}`);
      const bytes = providerBytes(built);
      for (const option of options) assert.ok(bytes.includes(option), `${label}: ${option} on the wire`);
    }
  });
  it('the egress re-read refuses a forged L1 of LEE, WU, zuleika7 or mlopez01 against the redacted options', () => {
    const { contracts, locator } = setup('Status', ['US', 'A12']);
    const { built } = build(contracts, 'Segment', new Map([[locator, ['US', 'A12']]]));
    const first = built.envelope.exemplars[0];
    assert.ok(first !== undefined);
    for (const forged of ['LEE', 'WU', 'zuleika7', 'jkowalski1', 'mlopez01']) {
      const envelope: IntelligenceEnvelopeV1 = { ...built.envelope, exemplars: [...built.envelope.exemplars, { ...first, exemplarRef: 'ex_0000000000000000', dataLevel: 'L1' as const, minimizedValueOrClass: forged, dataClass: 'SAFE_LOW_CARDINALITY_SEMANTICS' as const }] };
      assert.equal(decideEgress({ envelope, hash: envelopeHash(envelope), minimization: built.minimization, budget, secret }).decision, 'EGRESS_BLOCKED_POLICY', forged);
    }
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});
