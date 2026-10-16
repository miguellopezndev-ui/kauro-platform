import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hashTargetContract } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { classifyMetadataText, classifyValue, compactVerdict, enumerationToken, handleIn } from '../src/classifier/data-classifier.js';
import { digestOf } from '../src/contracts/canonical.js';
import { cleanOnlyTargetRef } from '../src/contracts/envelope.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, MemoryEvidenceItem, RepairContext, TargetContractView } from '../src/contracts/envelope.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { TaskRecord } from '../src/contracts/run.js';
import { DATA_POLICY_VERSION, MASKING_POLICY_VERSION, buildEnvelope } from '../src/envelope/envelope-builder.js';
import { oracleTransport } from '../src/gateway/fake-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';

const column = { header: 'Segment', distinctCount: 2, rowCount: 4, shapeCandidates: [] };
const KINDS = ['OPTION', 'LABEL', 'IDENTIFIER'] as const;
const safe = (text: string, kind: (typeof KINDS)[number]): boolean => {
  const classification = classifyMetadataText(text, kind);
  return classification.dataClass === 'SAFE_STRUCTURAL_METADATA' && !classification.instructionLike;
};
/** Denied on every channel and as a value the option list names: the whole of what a handle may not do. */
function denied(handle: string): void {
  for (const kind of KINDS) assert.equal(classifyMetadataText(handle, kind).dataClass, 'POTENTIAL_PII', `${handle} as ${kind}`);
  assert.equal(classifyValue(handle, { ...column, targetOptions: [handle] }).dataClass, 'POTENTIAL_PII', `${handle} as a value the option list names`);
  assert.equal(classifyValue(handle, column).dataClass, 'POTENTIAL_PII', `${handle} as a value under no option`);
  assert.ok(handleIn(handle), `${handle} is a handle`);
  assert.ok(!enumerationToken(handle), `${handle} is not an enumeration token`);
}

describe('R-IC-PRIVACY 009: a token that carries a digit is a code by what its letter runs are, never by case, length, ratio, separators or an option list', () => {
  it('the audit reproduction IC-egress-Segment/Vendedor-handles: HENDERSON7 and NDEBELE8 are handles on every channel — capitals authorise nothing', () => {
    for (const handle of ['HENDERSON7', 'NDEBELE8']) denied(handle);
  });
  it('the forbidden partial repair 1: numeric dominance authorises nothing — digits at or above the letters are still beside an unknown run', () => {
    for (const handle of ['WU99', 'LI2024', 'ng1', 'wu2024', 'NG-2024', 'okonkwo1234567', 'hend20240101', 'KOW-2024-01']) denied(handle);
  });
  it('the forbidden partial repair 2: two-to-three capitals before a separator and digits are not a prefix — only the closed list is', () => {
    for (const handle of ['NDE-8', 'HEN_2024', 'KOW-01', 'LEE-7', 'WU.2024', 'HO/01', 'NDE8', 'HEN2024']) denied(handle);
    for (const code of ['SKU-0042', 'ISO-9001', 'PO_2024/07', 'ISO9001', 'sku-0042', 'po-7', 'INV-2024-001', 'DOC_12', 'RFC-2119', 'EAN-13']) {
      assert.ok(safe(code, 'OPTION'), `${code} as an option`);
      assert.equal(compactVerdict(code), 'CODE', code);
    }
    assert.equal(compactVerdict('SKU-HENDERSON7'), 'HANDLE', 'a prefix authorises the first run only; the runs after it are still read');
    assert.equal(compactVerdict('HENDERSON-SKU7'), 'HANDLE', 'a prefix in any other position is nothing');
  });
  it('short and long, any case, any script, through separators: the letters no vocabulary knows beside a digit are a handle', () => {
    for (const handle of ['wu1', 'li7', 'ng2', 'ndebelehenderson1234', 'Ndebele8', 'ndebele8', 'NDEBELE_8', 'k_ndebele_8', 'j.kowalski1', 'm-lopez01', 'zuleika_7', 'ÑÁÑEZ7', 'müller7', 'Светлана7', 'Дмитрий2', '田中7', 'ايمان7', 'gürsel9', '김민수3', 'McDonald7', 'DiCaprio1']) denied(handle);
  });
  it('a bare ISO 3166/4217 code is admitted; the same code followed by digits is not, and a stop word beside a digit is not a word', () => {
    for (const code of ['US', 'ES', 'DE', 'EUR', 'USD']) assert.ok(safe(code, 'OPTION'), code);
    for (const handle of ['US2024', 'ES-2024', 'EUR-01', 'DE2024', 'USD7', 'de7', 'en-2024', 'al7']) denied(handle);
  });
  it('the precedence: Migration Core file ids, single Latin letters, closed prefixes, vocabulary words and camel compounds are codes; a caseless single letter is not a symbol', () => {
    assert.equal(compactVerdict('F-1a5dfa29636d'), 'CODE', 'the narrow hex-identifier grammar, admitted whole');
    assert.equal(compactVerdict('F-1a5dfa29636dab'), 'HANDLE', 'and nothing wider: fourteen hex digits are not a file id, and dfa is an unknown run');
    assert.equal(compactVerdict('1a5dfa29636d'), 'HANDLE', 'a bare hex run is not the grammar either');
    for (const code of ['A12', 'a12', '4b', 'B2B', 'Q1', '2024Q1', 'S0', 'x0-1', 'C3', 'R14', 'X-1']) assert.equal(compactVerdict(code), 'CODE', code);
    for (const code of ['tier1', 'phone2', 'level3', 'Tier2', 'nivel1', 'Address2', 'ClosedWon2', 'closedWon_2', 'Custom_Field_2__c', 'Sheet1', 'Hoja2', 'Name0', 'Email2', 'Fax2', 'Q1-2024', 'tiers1']) assert.equal(compactVerdict(code), 'CODE', code);
    assert.equal(compactVerdict('王7'), 'HANDLE', 'a single caseless-script letter is a surname, not a symbol');
    assert.equal(compactVerdict('Tabelle1'), 'HANDLE', 'a word no vocabulary knows is unknown, structural-looking or not');
    assert.equal(compactVerdict('Active'), null, 'no digit: the compact rule has nothing to say');
    assert.equal(compactVerdict('Zq7#kL'), null, 'other punctuation: neither a code nor a handle by this rule');
  });
  it('the useful controls of every channel still hold, and a useful option still vouches for the identical value', () => {
    const options = ['Active', 'Inactive', 'SKU-0042', 'ISO-9001', 'PO_2024/07', '001', 'tier1', 'phone2', 'level3', 'Tier2', 'nivel1', '1-10', '51-200', 'A12', 'a12', '4b', 'B2B', 'Q1', '2024Q1', 'S0', 'Enterprise', 'Closed Won', 'Mid-Market', 'Tier 1', 'Level 2', 'opt_in', 'ClosedWon', 'N/A', 'Team A', 'US', 'EUR'];
    for (const option of options) {
      assert.ok(safe(option, 'OPTION'), `${option} as an option`);
      assert.equal(classifyValue(option, { ...column, targetOptions: [option] }).dataClass, 'SAFE_LOW_CARDINALITY_SEMANTICS', `${option} vouched by its option`);
    }
    for (const label of ['Address 2', 'phone2', 'Q1 2024', 'Revenue 2023', 'First Name', 'hs_object_id', 'Custom_Field__c', 'Total Amount (EUR)', 'Teléfono 2', 'Line 1', 'Phone 3']) assert.ok(safe(label, 'LABEL'), label);
    for (const identifier of ['lifecyclestage', 'internal_score', 'Custom_Stage__c', 'hs_object_id', 'F-1a5dfa29636d', 'S0', 'contact', 'Account', 'enumeration', 'INVALID_SCHEMA', 'Address2__c', 'Phone2']) assert.ok(safe(identifier, 'IDENTIFIER'), identifier);
  });
  it('genuinely UNKNOWN stays UNKNOWN: bare short capitals outside the lists, and a token the rule has no reading of', () => {
    for (const token of ['LEE', 'WU', 'LIM', 'HO', 'TAN']) {
      assert.equal(classifyMetadataText(token, 'OPTION').dataClass, 'UNKNOWN', `${token} as an option`);
      assert.equal(classifyValue(token, { ...column, targetOptions: ['LEE', 'WU', 'LIM', 'HO', 'TAN'] }).dataClass, 'UNKNOWN', `${token} as a value the option list names`);
    }
    assert.equal(classifyValue('Zq7#kL', { ...column, distinctCount: 5000, rowCount: 5000 }).dataClass, 'UNKNOWN');
    assert.equal(classifyMetadataText('Mystery 1').dataClass, 'UNKNOWN', 'a word beside a separate integer is not a compact token');
  });
  it('review PRIVACY-009-CASE-BYPASS: a change of case inside a run is not a split into symbols — nG1, wU99 and yN1 are handles, and a camel hump is a vocabulary word or nothing', () => {
    for (const handle of ['nG1', 'wU99', 'yN1', 'nG-1', 'wU_99', 'aB2B', 'xStatus1', 'statusX1', 'nGo1', 'okWu2', 'kowalskiJ1', 'jKowalski1', 'nG2024Q1']) denied(handle);
    for (const handle of ['nG', 'wU', 'yN', 'xStatus']) assert.equal(compactVerdict(`${handle}1`), 'HANDLE', `${handle}1`);
    // The symbols stay symbols when they are whole runs, and a camel compound of vocabulary words stays a code.
    for (const code of ['B2B', 'Q1', '2024Q1', 'S0', 'A12', 'a12', '4b', 'n1', 'N2', 'y1', 'ClosedWon2', 'closedWon2', 'OptIn2', 'TierLevel1', 'Address2', 'Phone2Mobile']) assert.equal(compactVerdict(code), 'CODE', code);
  });
  it('review PRIVACY-009-LENGTH-BYPASS: no length turns a handle into free text or unknown — on OPTION, LABEL, IDENTIFIER and as a value', () => {
    const long = 'qz'.repeat(48) + '7';
    for (const handle of [long, 'ab'.repeat(40) + '-12', 'z'.repeat(70) + '1', 'k'.repeat(33) + 'x7', `${'henderson'.repeat(12)}7`, `NDE-${'x'.repeat(100)}-8`]) denied(handle);
    assert.equal(compactVerdict(long), 'HANDLE');
    assert.equal(compactVerdict(`${'sku'.repeat(1)}-${'0'.repeat(80)}`), 'CODE', 'a long number after a closed prefix is still a code: the length rule is not a denial either');
    // Long text with no handle in it is free text still — the length rule is reached, only after the handle rule.
    assert.equal(classifyMetadataText('word '.repeat(30).trim()).dataClass, 'FREE_TEXT');
    assert.equal(classifyMetadataText(`${'word '.repeat(30)}${long}`).dataClass, 'POTENTIAL_PII', 'a handle at the end of long text is read before the length');
  });
  it('the name lists are read over the letter runs before the compact rule: a handle that carries a name is refused as the name, not merely as a handle', () => {
    for (const handle of ['zuleika7', 'ZULEIKA7', 'Kowalski7', 'svetlana99', 'ada2']) {
      assert.equal(classifyValue(handle, column).reason, 'given name', handle);
      assert.equal(classifyMetadataText(handle, 'OPTION').reason, 'person-name-like token in metadata', handle);
    }
    for (const handle of ['HENDERSON7', 'jkowalski1', 'mlopez01']) {
      assert.match(classifyValue(handle, column).reason, /^handle:/u, handle);
      assert.match(classifyMetadataText(handle, 'OPTION').reason, /^handle in metadata:/u, handle);
    }
  });
});

/** The target fields of an envelope's view, none in CLEAN_ONLY. */
const targetFields = (envelope: IntelligenceEnvelopeV1): readonly TargetContractView['fields'][number][] => (envelope.targetContract.mode === 'CLEAN_ONLY' ? [] : envelope.targetContract.fields);

const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };
const SCOPE = { tenant: { agencyId: 'agency-a', clientId: 'client-1' }, projectRevisionId: 'rev', projectRevisionHash: 'c'.repeat(64) };
type Scope = typeof SCOPE;

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

const build = (contracts: AdaptedContracts, header: string, summaries: ReadonlyMap<string, readonly string[]>, options: { memoryEvidence?: readonly MemoryEvidenceItem[]; repair?: RepairContext | null; egressSecret?: Buffer; scope?: Scope } = {}) => {
  const { task, candidates, fieldRef, locator } = taskFor(contracts, header);
  const repair = options.repair ?? null;
  const scope = options.scope ?? SCOPE;
  const effective: TaskRecord = repair === null ? task : { ...task, taskType: 'SEMANTIC_REPAIR' };
  return { fieldRef, locator, built: buildEnvelope({ task: effective, contracts, candidates, memoryEvidence: options.memoryEvidence ?? [], summaries, projectRevisionId: scope.projectRevisionId, projectRevisionHash: scope.projectRevisionHash, supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: repair, egressSecret: options.egressSecret ?? Buffer.alloc(32, 5), tenant: scope.tenant, attemptId: 'attempt-0001' }) };
};

/** The HubSpot fixture contract with the lifecycle picklist relabelled, its options replaced and — when asked — its api name replaced. */
function contractWith(label: string, options: readonly string[], apiName = 'lifecyclestage'): ReturnType<typeof hashTargetContract> {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  return hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, apiName, label, picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : field)) })),
  });
}

describe('R-IC-PRIVACY 009 on the envelope: every caller of the shared classifier reads a handle as personal, drops it without a substitute, and keeps the useful members', () => {
  const bundle = makeBundle('privacy-009-envelope', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,HENDERSON7\n2,Grace,Hopper,grace@x.test,,NDEBELE8\n3,Alan,Turing,alan@x.test,,Active\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const setup = (label: string, options: readonly string[], apiName?: string) => {
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contractWith(label, options, apiName) });
    const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Segment')?.locator ?? '';
    return { contracts, locator };
  };
  const stageOf = (built: ReturnType<typeof buildEnvelope>) => targetFields(built.envelope).find((field) => field.apiName === 'lifecyclestage');

  it('a mixed option list keeps its safe member and drops the handles: absent from the view, not replaced by an opaque option the model could select', () => {
    for (const label of ['Region', 'Vendedor']) {
      const options = ['HENDERSON7', 'NDEBELE8', 'Active'];
      const { contracts, locator } = setup(label, options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      const stage = stageOf(built);
      assert.ok(stage !== undefined, `${label}: the target survives`);
      assert.deepEqual(stage.options, ['Active'], `${label}: the safe member stays, the handles are gone`);
      assert.ok(stage.options.every((option) => !/^[a-z]+_[g-v]{12}$/u.test(option)), `${label}: no opaque substitute stands in an option list`);
      const bytes = JSON.stringify(built.envelope);
      for (const handle of ['HENDERSON7', 'NDEBELE8']) assert.ok(!bytes.includes(handle), `${label}: ${handle} in the envelope`);
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), `${label}: the contaminated source column is withheld whole`);
      assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === stage.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')).length, 2, `${label}: each handle is recorded as PII against the target ref`);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', `${label}: the useful task still leaves`);
    }
  });
  it('review PRIVACY-009-CASE/LENGTH-BYPASS on the envelope: a camel two-letter handle and a ninety-seven-character handle contaminate the column like any other — options dropped without a substitute, no exemplar, Active withheld with them', () => {
    const long = 'qz'.repeat(48) + '7';
    for (const handles of [['nG1', 'wU99'], [long], ['yN1', long]]) {
      const options = [...handles, 'Active'];
      const { contracts, locator } = setup('Region', options);
      const { fieldRef, built } = build(contracts, 'Segment', new Map([[locator, options]]));
      const stage = stageOf(built);
      assert.ok(stage !== undefined, `${handles.join(',')}: the target survives`);
      assert.deepEqual(stage.options, ['Active'], `${handles.join(',')}: the safe member stays, the handles are gone`);
      const bytes = JSON.stringify(built.envelope);
      for (const handle of handles) assert.ok(!bytes.includes(handle), `${handle} in the envelope`);
      assert.ok(built.envelope.exemplars.every((exemplar) => exemplar.fieldRef !== fieldRef), `${handles.join(',')}: the contaminated source column is withheld whole — no Active exemplar either`);
      assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === stage.targetRef && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('target option:')).length, handles.length);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    }
  });
  it('a memory pattern that is a handle travels as the same header token, never as text', () => {
    const { contracts, locator } = setup('Region', ['Active', 'Inactive']);
    const memory: MemoryEvidenceItem = { memoryId: 'mem_0123456789abcdef', scope: 'CLIENT', knowledgeType: 'FIELD_MAPPING_CONVENTION', rule: { sourceHeaderPattern: 'HENDERSON7', targetRef: cleanOnlyTargetRef('contact.email'), semanticType: null }, verificationOutcome: 'AGENCY_APPROVED', weight: 0.3, status: 'ACTIVE' };
    const { built } = build(contracts, 'Segment', new Map([[locator, ['Active']]]), { memoryEvidence: [memory] });
    const item = built.envelope.memoryEvidence[0];
    assert.ok(item !== undefined);
    assert.match(item.rule.sourceHeaderPattern, /^hdr_[g-v]{12}$/u);
    assert.ok(!JSON.stringify(built.envelope).includes('HENDERSON7'));
    assert.ok(built.minimization.blocked.some((entry) => entry.fieldRef === 'mem_0123456789abcdef' && entry.dataClass === 'POTENTIAL_PII' && entry.reason.startsWith('memory pattern:')));
  });
  it('repair context: a validation code that is a handle travels as a token, an allowed value that is a handle is dropped and not replaced', () => {
    const { contracts, locator } = setup('Region', ['Active', 'Inactive']);
    const repair: RepairContext = { previousProposalDigest: 'd'.repeat(64), validationCodes: ['INVALID_SCHEMA', 'NDEBELE8', 'UNKNOWN_VALUE_mlopez01'], allowedValues: ['Active', 'HENDERSON7', 'jkowalski1', 'SKU-0042'], allowedTargetRefs: [] };
    const { built } = build(contracts, 'Segment', new Map([[locator, ['Active']]]), { repair });
    assert.deepEqual(built.envelope.repairContext?.validationCodes.map((code) => (code.startsWith('code_') ? 'code_*' : code)), ['INVALID_SCHEMA', 'code_*', 'code_*']);
    assert.deepEqual(built.envelope.repairContext?.allowedValues, ['Active', 'SKU-0042'], 'the handles are absent; the useful values stay');
    const bytes = JSON.stringify(built.envelope);
    for (const handle of ['NDEBELE8', 'mlopez01', 'HENDERSON7', 'jkowalski1']) assert.ok(!bytes.includes(handle), handle);
    assert.equal(built.minimization.blocked.filter((entry) => entry.fieldRef === 'repair' && entry.dataClass === 'POTENTIAL_PII').length, 4);
  });
  it('availability: a vendor field whose api name is an ambiguous digit-bearing token survives by targetRef with the api name masked, never removed', () => {
    for (const apiName of ['CB2_Segment__c', 'Sq1_Status__c']) {
      // Delivered through the support envelope by its label (the api name is the vendor's own); the label does not match the Segment header, so the field is a model task.
      const { contracts, locator } = setup('Lifecycle Stage', ['Active', 'Inactive'], apiName);
      const { built } = build(contracts, 'Segment', new Map([[locator, ['Active']]]));
      assert.notEqual(built.envelope.targetContract.mode, 'CLEAN_ONLY');
      if (built.envelope.targetContract.mode === 'CLEAN_ONLY') continue;
      const targetRef = contracts.contractView.mode === 'CLEAN_ONLY' ? '' : (contracts.contractView.fields.find((field) => field.apiName === apiName)?.targetRef ?? '');
      const field = built.envelope.targetContract.fields.find((entry) => entry.targetRef === targetRef);
      assert.ok(field !== undefined, `${apiName}: the target is in the view by its ref`);
      assert.match(field.apiName, /^api_[g-v]{12}$/u, `${apiName}: the api name is masked`);
      assert.equal(field.label, 'Lifecycle Stage', `${apiName}: the label travels`);
      assert.deepEqual(field.options, ['Active', 'Inactive'], `${apiName}: the options travel`);
      assert.ok(!JSON.stringify(built.envelope).includes(apiName));
      assert.ok(built.envelope.constraints.allowedTargetIds.includes(targetRef), `${apiName}: the model may still name it`);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED');
    }
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

describe('R-IC-PRIVACY 009 references: an opaque reference is bound to the secret, the agency, the client, the revision and the profile', () => {
  const bundle = makeBundle('privacy-009-scope', { contacts: 'Contact ID,First Name,Email,Status,audit-person@example.test\n1,Ada,ada@x.test,Active,x\n2,Grace,grace@x.test,Inactive,y\n' });
  const profiled = profileBundle(bundle, 'CLEAN_ONLY');
  const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
  const header = 'audit-person@example.test';
  const tokenOf = (options: { egressSecret?: Buffer; scope?: Scope } = {}): string => {
    const { fieldRef, built } = build(contracts, header, new Map(), options);
    return built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef)?.header ?? '';
  };
  it('equal text in equal scope under an equal key is one stable reference; each change of agency, client, revision, key or profile separates it', () => {
    const first = tokenOf();
    assert.match(first, /^hdr_[g-v]{12}$/u);
    assert.equal(tokenOf(), first, 'stable within the scope');
    const others = [
      tokenOf({ scope: { ...SCOPE, tenant: { ...SCOPE.tenant, agencyId: 'agency-b' } } }),
      tokenOf({ scope: { ...SCOPE, tenant: { ...SCOPE.tenant, clientId: 'client-2' } } }),
      tokenOf({ scope: { ...SCOPE, projectRevisionId: 'rev-2', projectRevisionHash: 'e'.repeat(64) } }),
      tokenOf({ scope: { ...SCOPE, projectRevisionHash: 'e'.repeat(64) } }),
      tokenOf({ egressSecret: Buffer.alloc(32, 11) }),
    ];
    for (const other of others) assert.match(other, /^hdr_[g-v]{12}$/u);
    assert.equal(new Set([first, ...others]).size, others.length + 1, 'no two scopes share a reference');
    // Another profile of the same tenant and revision: the profile hash is in the key too.
    const otherBundle = makeBundle('privacy-009-scope-other', { contacts: 'Contact ID,First Name,Email,Status,audit-person@example.test\n1,Ada,ada@x.test,Active,x\n' });
    try {
      const otherProfiled = profileBundle(otherBundle, 'CLEAN_ONLY');
      const otherContracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: otherProfiled.profile, candidateSet: otherProfiled.candidateSet, targetContract: null });
      const { fieldRef, built } = build(otherContracts, header, new Map());
      assert.notEqual(built.envelope.sourceProfile.fields.find((entry) => entry.fieldRef === fieldRef)?.header, first, 'another profile, another reference');
    } finally {
      otherBundle.dispose();
    }
  });
  it('nothing reversible and nothing unkeyed: the tenant is not in the bytes, and a digest of everything but the secret is not the token', () => {
    const { built } = build(contracts, header, new Map());
    const bytes = JSON.stringify([built.envelope, built.minimization, built.egress]);
    for (const sentinel of ['agency-a', 'client-1', Buffer.from('agency-a').toString('base64'), Buffer.from('agency-a').toString('hex')]) assert.ok(!bytes.includes(sentinel), sentinel);
    const letters = (hex: string): string => hex.slice(0, 12).replace(/[0-9a-f]/gu, (digit) => 'ghijklmnopqrstuv'[Number.parseInt(digit, 16)] ?? 'g');
    const token = tokenOf();
    for (const guess of [digestOf(['mask', contracts.profileHash, header]), digestOf(['mask', MASKING_POLICY_VERSION, contracts.profileHash, 'agency-a', 'client-1', 'rev', 'c'.repeat(64), header]), digestOf([header])]) assert.notEqual(token, `hdr_${letters(guess)}`);
  });
  it('a reference is never issued outside a scope: an envelope built without its tenant is a contract violation', () => {
    const { task, candidates } = taskFor(contracts, header);
    assert.throws(() => buildEnvelope({ task, contracts, candidates, memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'c'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 5), tenant: { agencyId: '', clientId: 'client-1' }, attemptId: 'attempt-0001' }), /scoped to/u);
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});

describe('R-IC-PRIVACY 009 through the public API with real Migration Core 2.0.1 validation: transport denial, task abstention, scoped references, versioned provenance', () => {
  // Status is the run's only question: the id columns, which no target of the fixture contract can hold, would be UNMAPPED_HANDLING's own task (B03-CAP-STRUCTURE) and a request beside the Status task this describe observes.
  const bundle = makeBundle('privacy-009-api', { contacts: 'First Name,Last Name,Email,Phone,Status\nAda,Lovelace,ada@kauro-fixture.test,+57 300 123 4567,Active\nGrace,Hopper,grace@kauro-fixture.test,,Inactive\nAlan,Turing,alan@kauro-fixture.test,+1 415 555 0100,Active\nAlan,Turing,ALAN@kauro-fixture.test,,Active\n', companies: 'Name,Website\nAnalytical Engines,https://analytical.test\nCOBOL Works,https://cobol.test\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  async function run(label: string, values: readonly string[], scope: { agency?: string; client?: string; revision?: string; keyByte?: number } = {}) {
    const target = contractWith(label, values);
    const adapted = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: target });
    const field = adapted.profileView.fields.find((entry) => entry.header === 'Status');
    assert.ok(field !== undefined);
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, target, { clock });
    const bodies: string[] = [];
    const inner = oracleTransport();
    const capture: Transport = async (request, deadlineAt, correlation) => { bodies.push(JSON.stringify(request)); return inner(request, deadlineAt, correlation); };
    const deps = depsFor(transportGateway(capture), port, clock);
    const withKey = { ...deps, egressKey: { keyId: `egress-key-${String(scope.keyByte ?? 7)}`, secret: Buffer.alloc(32, scope.keyByte ?? 7) } };
    const input = inputFor('HUBSPOT', profiled, target, { categoricalSummaries: new Map([[field.fieldRef, values]]) });
    const revision = scope.revision ?? 'rev-a';
    const scoped = { ...input, projectRevision: { ...input.projectRevision, projectRevisionId: revision, projectRevisionHash: digestOf(['revision', revision]) } };
    const result = await createIntelligenceCore(withKey).run(scoped, { ...CONTEXT, tenant: { agencyId: scope.agency ?? 'scope-agency-a', clientId: scope.client ?? 'scope-client-a' } });
    return { result, bodies, port, field };
  }
  it('the audit reproduction on the wire: HENDERSON7 and NDEBELE8 under Segment and Vendedor never reach the physical request; the useful draft is still validated by the real engine', { timeout: 120_000 }, async () => {
    for (const label of ['Segment', 'Vendedor']) {
      const { result, bodies, port, field } = await run(label, ['HENDERSON7', 'NDEBELE8']);
      assert.ok(bodies.length > 0, `${label}: a physical transport call`);
      assert.equal(result.state, 'PROPOSAL_READY');
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      assert.ok(port.calls > 0 && result.draft.fullValidation?.packageVerified === true, `${label}: the real adapter validated the package`);
      const wire = bodies.join('\n');
      for (const handle of ['HENDERSON7', 'NDEBELE8']) for (const form of [handle, Buffer.from(handle).toString('base64'), Buffer.from(handle).toString('hex')]) assert.ok(!wire.includes(form), `${label}: ${handle} on the wire as ${form}`);
      const targets = bodies.flatMap((bytes) => targetFields(parseProviderRequestPayload(bytes).envelope)).filter((entry) => entry.apiName === 'lifecyclestage');
      assert.ok(targets.length > 0, `${label}: the target is minimized, not removed`);
      assert.ok(targets.every((entry) => entry.options.length === 0), `${label}: no option and no substitute`);
      assert.ok(bodies.every((bytes) => parseProviderRequestPayload(bytes).envelope.exemplars.every((exemplar) => exemplar.fieldRef !== field.fieldRef)), `${label}: the source column is withheld`);
      assert.equal(result.provenance.dataPolicyVersion, DATA_POLICY_VERSION);
      assert.equal(result.provenance.maskingPolicyVersion, MASKING_POLICY_VERSION);
      const created = result.runLedger[0];
      assert.ok(created !== undefined && created.kind === 'RUN_CREATED');
      assert.equal(created.versions['dataPolicyVersion'], DATA_POLICY_VERSION, 'the data policy is part of the run identity');
      assert.equal(created.versions['maskingPolicyVersion'], MASKING_POLICY_VERSION, 'the masking policy is part of the run identity');
    }
  });
  it('the useful control on the wire: Active and Inactive travel as options and as L1 exemplars', { timeout: 120_000 }, async () => {
    const { result, bodies, field } = await run('Segment', ['Active', 'Inactive']);
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
    const payloads = bodies.map((bytes) => parseProviderRequestPayload(bytes).envelope);
    assert.ok(payloads.some((envelope) => envelope.targetContract.mode !== 'CLEAN_ONLY' && envelope.targetContract.fields.some((entry) => entry.apiName === 'lifecyclestage' && entry.options.includes('Active') && entry.options.includes('Inactive'))));
    assert.ok(payloads.some((envelope) => envelope.exemplars.some((exemplar) => exemplar.fieldRef === field.fieldRef && exemplar.dataLevel === 'L1' && ['Active', 'Inactive'].includes(exemplar.minimizedValueOrClass))));
  });
  it('genuinely UNKNOWN fails closed: LEE and WU abstain the Status task with EGRESS_BLOCKED_UNKNOWN, no physical request, no Status mapping in the draft', { timeout: 120_000 }, async () => {
    const { result, bodies, field } = await run('Segment', ['LEE', 'WU']);
    assert.equal(result.tasks.length, 1, 'exactly the Status model task');
    const task = result.tasks[0];
    assert.ok(task !== undefined);
    assert.equal(task.taskType, 'FIELD_MAPPING');
    assert.equal(task.outcome, 'ABSTAINED');
    assert.ok(task.codes.includes('EGRESS_BLOCKED_UNKNOWN'));
    assert.equal(bodies.length, 0, 'nothing reached the transport');
    assert.ok((result.draft.configuration?.fields ?? []).every((entry) => entry.columnHeader !== field.header), 'no Status mapping in the draft');
    assert.equal(result.state, 'PROPOSAL_READY', 'the deterministic fields still make a draft');
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
  });
  it('scoped references on the wire: a masked label is one token within a scope and another under another agency, client, revision or key', { timeout: 180_000 }, async () => {
    const label = 'HENDERSON7';
    const tokens: string[] = [];
    for (const scope of [{}, {}, { agency: 'scope-agency-b' }, { client: 'scope-client-b' }, { revision: 'rev-b' }, { keyByte: 11 }]) {
      const { bodies } = await run(label, ['Active', 'Inactive'], scope);
      const wire = bodies.join('\n');
      for (const sentinel of [label, 'scope-agency', 'scope-client']) assert.ok(!wire.includes(sentinel), sentinel);
      const labels = [...new Set(bodies.flatMap((bytes) => targetFields(parseProviderRequestPayload(bytes).envelope)).filter((entry) => entry.apiName === 'lifecyclestage').map((entry) => entry.label))];
      assert.equal(labels.length, 1, 'one reference within a run');
      assert.match(labels[0] ?? '', /^lbl_[g-v]{12}$/u);
      tokens.push(labels[0] ?? '');
    }
    assert.equal(tokens[0], tokens[1], 'same scope, same reference');
    assert.equal(new Set([tokens[0], ...tokens.slice(2)]).size, 5, 'every other scope separates the reference');
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});
