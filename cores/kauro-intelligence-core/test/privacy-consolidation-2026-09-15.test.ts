import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hashTargetContract } from 'kauro-migration-core';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { classifyMetadataText, compactVerdict, enumerationToken } from '../src/classifier/data-classifier.js';
import type { DeterministicCandidate, IntelligenceEnvelopeV1, TargetContractView } from '../src/contracts/envelope.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { TaskRecord } from '../src/contracts/run.js';
import { INTELLIGENCE_CORE_VERSION } from '../src/contracts/versions.js';
import { DATA_POLICY_VERSION, MASKING_POLICY_VERSION, buildEnvelope } from '../src/envelope/envelope-builder.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { makeBundle, profileBundle, vendorContract } from './support/fixtures.js';

/**
 * WO-IC-PRIVACY-20260915-01, the consolidation of R-IC-PRIVACY 009/009b (data
 * policy 1.6.0). The probe of the consolidated 009b tree
 * (evidence/channel-capitalization-c8a5b1c.json) showed the LABEL and
 * IDENTIFIER channels admitting a token by its case or by the shape of a
 * join, where the OPTION channel and the value rule did not: SMITH was
 * structural in capitals and a name in title case; Okonkwo was an identifier
 * in every case; OkonkwoNdebele, Okonkwo_Ndebele and Okonkwo__c were
 * structural by the grammar of the join. The rule now: a piece is known by
 * the closed lists or it is not, on every channel.
 */
const KINDS = ['OPTION', 'LABEL', 'IDENTIFIER'] as const;
const classOf = (text: string, kind: (typeof KINDS)[number]) => classifyMetadataText(text, kind).dataClass;
const safe = (text: string, kind: (typeof KINDS)[number]): boolean => {
  const classification = classifyMetadataText(text, kind);
  return classification.dataClass === 'SAFE_STRUCTURAL_METADATA' && !classification.instructionLike;
};

describe('data policy 1.6.0: a label or identifier token is structural by a closed list, never by its case', () => {
  it('the demonstration: a surname in capitals was structural on LABEL and IDENTIFIER while the same word in title case was a name; now no case makes it structural', () => {
    for (const surname of ['Smith', 'Patel', 'Nguyen', 'Wang', 'Okonkwo', 'Ndebele', 'Mbeki']) {
      const upper = surname.toUpperCase();
      for (const kind of ['LABEL', 'IDENTIFIER'] as const) {
        assert.equal(classOf(surname, kind), 'POTENTIAL_PII', `${surname} as ${kind}: a proper noun`);
        assert.equal(classOf(upper, kind), 'UNKNOWN', `${upper} as ${kind}: a constant or a surname, nothing tells which`);
        assert.ok(!safe(surname.toLowerCase(), 'LABEL'), `${surname.toLowerCase()} as a label`);
      }
      assert.ok(!safe(surname, 'OPTION') && !safe(upper, 'OPTION'), `${surname} as an option`);
    }
  });
  it('two or three capitals outside the ISO lists are UNKNOWN on every channel now, not only as options and values (R2R-PC-01 made uniform)', () => {
    for (const token of ['LEE', 'WU', 'LIM', 'HO', 'TAN', 'NDE', 'HEN']) for (const kind of KINDS) assert.equal(classOf(token, kind), 'UNKNOWN', `${token} as ${kind}`);
    for (const code of ['US', 'ES', 'GBR', 'EUR', 'USD']) for (const kind of KINDS) assert.ok(safe(code, kind), `${code} as ${kind}`);
  });
  it('the mundane acronyms headers are written with are vocabulary, not a shape: CRM, NPS, DOB, UTM, VAT, SKU travel; a shape of the same length does not', () => {
    for (const acronym of ['CRM', 'NPS', 'DOB', 'UTM', 'VAT', 'SKU', 'ID', 'URL', 'IBAN', 'NAICS', 'UUID']) assert.ok(safe(acronym, 'LABEL'), acronym);
    for (const label of ['CRM ID', 'UTM Source', 'NPS Score', 'DOB', 'Contact ID', 'Q1 2024', 'Total Amount (EUR)', 'hs_object_id', 'Custom_Field__c', 'firstName', 'AccountId', 'Fecha de nacimiento']) assert.ok(safe(label, 'LABEL'), label);
    for (const shape of ['XQZV', 'KWMB', 'ZBGNW']) assert.equal(classOf(shape, 'LABEL'), 'UNKNOWN', shape);
  });
});

describe('data policy 1.6.0: a join is a way of writing pieces, never a reason to admit them', () => {
  it('the demonstration: a Pascal, snake, kebab, dotted or camel compound of proper nouns, and a proper noun under the vendor suffix, are names on LABEL and IDENTIFIER and never options', () => {
    for (const compound of ['OkonkwoNdebele', 'Okonkwo_Ndebele', 'Okonkwo-Ndebele', 'Okonkwo.Ndebele', 'okonkwoNdebele', 'Okonkwo__c', 'Smith.Patel', 'Zbigniew_Okonkwo', 'OkonkwoStatus', 'StatusOkonkwo']) {
      assert.equal(classOf(compound, 'LABEL'), 'POTENTIAL_PII', `${compound} as a label`);
      assert.equal(classOf(compound, 'IDENTIFIER'), 'POTENTIAL_PII', `${compound} as an identifier`);
      assert.ok(!safe(compound, 'OPTION'), `${compound} as an option`);
      assert.ok(!enumerationToken(compound), `${compound} as an enumeration token`);
    }
    // A join of words in capitals or lower case no list knows is unknown on the label channels: the join gives it nothing.
    for (const compound of ['OKONKWO_NDEBELE', 'okonkwo_ndebele', 'okonkwo-ndebele']) assert.notEqual(classOf(compound, 'LABEL'), 'SAFE_STRUCTURAL_METADATA', compound);
  });
  it('the useful compounds: every piece known makes the compound structural on every channel, the vendor suffix and the constant case included', () => {
    for (const compound of ['FirstName', 'first_name', 'AccountId', 'hs_lead_status', 'Custom_Field__c', 'Internal_Score__c', 'Custom_Field_2__c', 'Address2__c', 'Closed_Won', 'ClosedWon', 'closed_won', 'Opt-in']) {
      for (const kind of KINDS) assert.ok(safe(compound, kind), `${compound} as ${kind}`);
    }
    // The enumeration vocabulary is the OPTION channel's, as before: a label is written with label words.
    for (const option of ['Mid-market', 'in_progress', 'Closed Won', 'Enterprise']) assert.ok(safe(option, 'OPTION'), option);
    for (const constant of ['INVALID_SCHEMA', 'TARGET_NOT_IN_CONTRACT', 'SEMANTIC_TYPE_NOT_IN_VOCABULARY', 'PRIMITIVE_NOT_SUPPORTED', 'TEXT', 'ENUM', 'DATETIME', 'IDENTIFIER', 'BOOLEAN']) assert.ok(safe(constant, 'IDENTIFIER'), constant);
    for (const apiName of ['lifecyclestage', 'jobtitle', 'contact', 'company', 'enumeration', 'string', 'picklist', 'Account', 'Contact', 'HasOptedOutOfEmail', 'MailingStreet', 'LeadSource']) assert.ok(safe(apiName, 'IDENTIFIER'), apiName);
    // An ordinal is the closed safe vocabulary, not the letters nd beside a digit.
    for (const ordinal of ['1st', '2nd', '3rd', '4th', '1º']) {
      assert.equal(compactVerdict(ordinal), 'CODE', ordinal);
      for (const kind of ['OPTION', 'LABEL'] as const) assert.ok(safe(ordinal, kind), `${ordinal} as ${kind}`);
    }
    assert.ok(safe('2nd', 'IDENTIFIER'));
    assert.ok(!safe('1º', 'IDENTIFIER'), 'the identifier grammar is ASCII');
  });
  it('a word beside a separate integer is still merely unknown, and a lower-case word no vocabulary knows is not an identifier either — data policy 1.7.0 withdrew the case admission the independent review rejected (PRIVACY-IDENTIFIER-CASE-BYPASS)', () => {
    assert.equal(classOf('Mystery 1', 'LABEL'), 'UNKNOWN');
    assert.equal(classOf('Okonkwo 7', 'LABEL'), 'UNKNOWN');
    assert.equal(classOf('okonkwo', 'IDENTIFIER'), 'UNKNOWN');
    assert.ok(safe('lifecyclestage', 'IDENTIFIER'), 'a concatenation of vocabulary words is still an identifier');
    assert.equal(classOf('okonkwo', 'LABEL'), 'UNKNOWN');
    assert.equal(classOf('okonkwo', 'OPTION'), 'POTENTIAL_PII');
  });
  it('an opaque reference the builder minted is structural on the label channels: the egress re-read of a redacted envelope finds it so', () => {
    for (const reference of ['hdr_ghijklmnopqr', 'lbl_vutsrqponmlk', 'api_gggggggggggg', 'code_hhhhhhhhhhhh', 'sheet_ijklmnopqrst']) {
      assert.ok(safe(reference, 'LABEL'), reference);
      assert.ok(safe(reference, 'IDENTIFIER'), reference);
    }
    assert.ok(!safe('hdr_ghijklmnopq', 'LABEL'), 'eleven letters is not a reference');
    assert.ok(!safe('hdr_abcdefabcdef', 'LABEL'), 'letters outside g–v are not a reference');
  });
  it('the versions moved with the semantics', () => {
    assert.equal(DATA_POLICY_VERSION, '1.7.0', 'the privacy repair: case admits no identifier, joined and suffixed names are personal values');
    assert.equal(MASKING_POLICY_VERSION, '1.4.0', 'the attempt joined the reference scope');
    assert.equal(INTELLIGENCE_CORE_VERSION, '0.6.0', 'the privacy repair did not move the package version; B03 (D3-VER-1) set 0.5.0 once, after the rename (amendment A2) set 0.4.0, the B04 release preparation set 0.6.0-rc.1 and the B04 release sets 0.6.0');
  });
});

/** The target fields of an envelope's view, none in CLEAN_ONLY. */
const targetFields = (envelope: IntelligenceEnvelopeV1): readonly TargetContractView['fields'][number][] => (envelope.targetContract.mode === 'CLEAN_ONLY' ? [] : envelope.targetContract.fields);
const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };
const SCOPE = { tenant: { agencyId: 'agency-a', clientId: 'client-1' }, projectRevisionId: 'rev', projectRevisionHash: 'c'.repeat(64) };

function taskFor(contracts: AdaptedContracts, header: string): { task: TaskRecord; candidates: DeterministicCandidate[]; locator: string } {
  const resolution = resolve(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } });
  const planned = plan('c'.repeat(64), resolution.openQuestions);
  const derived = new Map(resolution.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
  const entry = [...contracts.refs.fieldByRef.entries()].find(([, info]) => info.header === header);
  assert.ok(entry !== undefined, `the profile has ${header}`);
  const [fieldRef, info] = entry;
  const task = planned.tasks.find((candidate) => candidate.candidateRefs.some((ref) => derived.get(ref)?.sourceRefs.includes(fieldRef)));
  assert.ok(task !== undefined, `a task carries ${header}`);
  return { task, candidates: task.candidateRefs.map((ref) => derived.get(ref)).filter((candidate): candidate is DeterministicCandidate => candidate !== undefined), locator: info.locator };
}

/** The HubSpot fixture contract with the lifecycle picklist relabelled, renamed and its options replaced. */
function contractWith(label: string, apiName: string, options: readonly string[]): ReturnType<typeof hashTargetContract> {
  const base = vendorContract('HUBSPOT', { withStatusPicklist: true });
  return hashTargetContract({
    ...base.contract,
    objects: base.contract.objects.map((object) => ({ ...object, fields: object.fields.map((field) => (field.apiName === 'lifecyclestage' ? { ...field, apiName, label, picklistValues: options.map((value) => ({ value, label: value, active: true, defaultValue: false })) } : field)) })),
  });
}

describe('data policy 1.6.0 on the envelope: a label in capitals and an api name in title case are masked, the field survives, the options travel, the egress is allowed', () => {
  const bundle = makeBundle('privacy-consolidation-envelope', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Segment\n1,Ada,Lovelace,ada@x.test,,Active\n2,Grace,Hopper,grace@x.test,,Inactive\n3,Alan,Turing,alan@x.test,,Active\n' });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  it('SMITH or OkonkwoNdebele as the target label, Okonkwo or Okonkwo__c as its api name: each leaves as a reference, never as text', () => {
    // The field is delivered by its api name when the label is masked, and by its label when the api name is (as in revision 009's availability case).
    for (const [label, apiName] of [['SMITH', 'lifecyclestage'], ['OkonkwoNdebele', 'lifecyclestage'], ['Lifecycle Stage', 'Okonkwo'], ['Lifecycle Stage', 'Okonkwo__c'], ['Lifecycle Stage', 'Ndebele_Segment']] as const) {
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contractWith(label, apiName, ['Active', 'Inactive']) });
      const { task, candidates, locator } = taskFor(contracts, 'Segment');
      const built = buildEnvelope({ task, contracts, candidates, memoryEvidence: [], summaries: new Map([[locator, ['Active', 'Inactive']]]), projectRevisionId: SCOPE.projectRevisionId, projectRevisionHash: SCOPE.projectRevisionHash, supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 5), tenant: SCOPE.tenant, attemptId: 'attempt-0001' });
      const targetRef = contracts.contractView.mode === 'CLEAN_ONLY' ? '' : (contracts.contractView.fields.find((field) => field.apiName === apiName)?.targetRef ?? '');
      const field = targetFields(built.envelope).find((entry) => entry.targetRef === targetRef);
      assert.ok(field !== undefined, `${label}/${apiName}: the target survives by its ref`);
      if (apiName === 'lifecyclestage') assert.equal(field.apiName, 'lifecyclestage');
      else assert.match(field.apiName, /^api_[g-v]{12}$/u, `${apiName}: the api name is masked`);
      if (label === 'Lifecycle Stage') assert.equal(field.label, 'Lifecycle Stage');
      else assert.match(field.label, /^lbl_[g-v]{12}$/u, `${label}: the label is masked`);
      assert.deepEqual(field.options, ['Active', 'Inactive'], 'the options travel');
      const bytes = JSON.stringify(built.envelope);
      assert.ok((apiName === 'lifecyclestage' || !bytes.includes(apiName)) && (label === 'Lifecycle Stage' || !bytes.includes(label)), `${label}/${apiName}: no raw text in the envelope`);
      assert.equal(built.egress.decision, 'EGRESS_ALLOWED', `${label}/${apiName}: masked metadata is not a reason to abstain`);
      assert.ok(built.envelope.exemplars.some((exemplar) => exemplar.dataLevel === 'L1' && exemplar.minimizedValueOrClass === 'Active'), 'the useful value travels as L1');
    }
  });
  it('the fixture bundle is disposed', () => {
    bundle.dispose();
  });
});
