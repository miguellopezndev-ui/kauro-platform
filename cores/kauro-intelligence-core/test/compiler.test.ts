import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { compileProposal } from '../src/compiler/compiler.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { IntelligenceProposalV1, ProposalItem } from '../src/contracts/proposal.js';
import { buildEnvelope } from '../src/envelope/envelope-builder.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { makeBundle, profileBundle, vendorContract } from './support/fixtures.js';

/** The tenant every envelope of these tests is scoped to; the references it masks are bound to it (masking policy 1.3.0). */
const TENANT_SCOPE = { agencyId: 'agency-a', clientId: 'client-1' } as const;

/**
 * A HubSpot fixture with an open question — the Status column — whose
 * candidate may name the lead status picklist; every case below is a
 * schema-valid proposal that is semantically wrong in exactly one way.
 */
// Mood, a column the headers and shapes tie to no target, is a second FIELD_MAPPING question beside Status, so the Status task carries two candidates (B03-CAP-STRUCTURE: a column no target can hold is UNMAPPED_HANDLING's question and no longer rides in it).
const bundle = makeBundle('compiler', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Status,Mood\n1,Ada,Lovelace,ada@kauro-fixture.test,+57 300 123 4567,Active,calm\n2,Grace,Hopper,grace@kauro-fixture.test,,Inactive,busy\n3,Alan,Turing,alan@kauro-fixture.test,+1 415 555 0100,Active,calm\n4,Alan,Turing,ALAN@kauro-fixture.test,,Active,busy\n' });
const profiled = profileBundle(bundle, 'HUBSPOT');
const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
const resolution = resolve(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } });
const planned = plan('a'.repeat(64), resolution.openQuestions);
const derived = new Map(resolution.derivedCandidates.map((candidate) => [candidate.candidateRef, candidate]));
const statusField = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === 'Status')?.[0] ?? '';
const task = planned.tasks.find((candidate) => candidate.candidateRefs.some((ref) => derived.get(ref)?.sourceRefs.includes(statusField)));
assert.ok(task !== undefined, 'the Status column is an open question');
const candidates = task.candidateRefs.map((ref) => derived.get(ref)).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
const built = buildEnvelope({ task, contracts, candidates, memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' }, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
const RUN = 'run_0123456789abcdef';
const statusCandidate = candidates.find((candidate) => candidate.sourceRefs.includes(statusField));
assert.ok(statusCandidate !== undefined);
const leadStatusRef = built.envelope.targetContract.mode === 'HUBSPOT' ? built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage')?.targetRef ?? null : null;
const emailRef = contracts.contractView.mode === 'HUBSPOT' ? contracts.contractView.fields.find((field) => field.apiName === 'email')?.targetRef ?? null : null;
const internalRef = contracts.contractView.mode === 'HUBSPOT' ? contracts.contractView.fields.find((field) => field.apiName === 'internal_score')?.targetRef ?? null : null;

const base = (): IntelligenceProposalV1 => oracleProposal(built.envelope, RUN);
const withItem = (overrides: Partial<ProposalItem>, proposalOverrides: Partial<IntelligenceProposalV1> = {}): IntelligenceProposalV1 => {
  const proposal = base();
  const items = proposal.items.map((item) => (item.candidateRef === statusCandidate.candidateRef ? { ...item, ...overrides } : item));
  return { ...proposal, items, ...proposalOverrides };
};
const compile = (proposal: IntelligenceProposalV1) => compileProposal({ envelope: built.envelope, envelopeHash: built.hash, proposal, runId: RUN, contracts, decisions: resolution.decisions });
const codesOf = (proposal: IntelligenceProposalV1): string[] => [...compile(proposal).codes];

describe('the compiler: schema-valid but semantically wrong proposals are refused, each for its named reason', () => {
  it('a well-formed mapping of Status to the lead status picklist is PROPOSED with an evidence class derived from refs and facts', () => {
    assert.ok(leadStatusRef !== null);
    // "Status" shares no name with "Lifecycle Stage"; the fact behind this mapping is a verified memory convention, so the envelope carries it.
    const memory = { memoryId: 'mem_0123456789abcdef', scope: 'CLIENT' as const, knowledgeType: 'FIELD_CONVENTION', rule: { sourceHeaderPattern: 'status', targetRef: leadStatusRef, semanticType: 'ENUM' }, verificationOutcome: 'VERIFIED', weight: 1, status: 'ACTIVE' as const };
    const remembered = buildEnvelope({ task, contracts, candidates, memoryEvidence: [memory], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: built.envelope.budgetSnapshot, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
    const proposal = oracleProposal(remembered.envelope, RUN);
    const items = proposal.items.map((item) => (item.candidateRef === statusCandidate.candidateRef ? { ...item, proposalType: 'MAP_FIELD' as const, targetRef: leadStatusRef, transformPrimitive: 'PRESERVE_AS_IS' as const, rationaleCode: 'MEMORY_CONVENTION_APPLIES' as const } : item));
    const compiled = compileProposal({ envelope: remembered.envelope, envelopeHash: remembered.hash, proposal: { ...proposal, items }, runId: RUN, contracts, decisions: resolution.decisions });
    const item = compiled.items.find((entry) => entry.candidateRef === statusCandidate.candidateRef);
    assert.equal(item?.outcome, 'PROPOSED', JSON.stringify(item));
    assert.equal(item?.evidenceClass, 'SUPPORTED');
  });
  it('a target outside the envelope is FORBIDDEN, even if it exists in the contract', () => {
    assert.ok(codesOf(withItem({ proposalType: 'MAP_FIELD', targetRef: 'tgt_0000000000000000' })).includes('TARGET_OUTSIDE_ENVELOPE'));
    assert.ok(emailRef !== null);
    assert.ok(codesOf(withItem({ proposalType: 'MAP_FIELD', targetRef: emailRef })).includes('TARGET_OUTSIDE_ENVELOPE'), 'email was decided deterministically and is not an allowed target of the Status candidate');
  });
  it('a field outside the support envelope is FORBIDDEN', () => {
    assert.ok(internalRef !== null);
    const forged = { ...built.envelope, constraints: { ...built.envelope.constraints, allowedTargetIds: [...built.envelope.constraints.allowedTargetIds, internalRef] }, deterministicCandidates: built.envelope.deterministicCandidates.map((candidate) => (candidate.candidateRef === statusCandidate.candidateRef ? { ...candidate, allowedTargetRefs: [...candidate.allowedTargetRefs, internalRef] } : candidate)) };
    const compiled = compileProposal({ envelope: forged, envelopeHash: built.hash, proposal: withItem({ proposalType: 'MAP_FIELD', targetRef: internalRef }), runId: RUN, contracts, decisions: resolution.decisions });
    assert.ok(compiled.codes.includes('TARGET_OUTSIDE_SUPPORT_ENVELOPE'), compiled.codes.join(','));
  });
  it('an enum value not among the target options, and an enum map on CLEAN_ONLY, are refused', () => {
    assert.ok(leadStatusRef !== null);
    assert.ok(codesOf(withItem({ proposalType: 'MAP_ENUM_VALUE', targetRef: leadStatusRef, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { from: 'Active', to: 'ACTIVE' } })).includes('ENUM_VALUE_NOT_IN_TARGET_OPTIONS'));
    const ok = compile(withItem({ proposalType: 'MAP_ENUM_VALUE', targetRef: leadStatusRef, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { from: 'Active', to: 'OPEN' }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' }));
    assert.ok(!ok.codes.includes('ENUM_VALUE_NOT_IN_TARGET_OPTIONS'));
  });
  it('a destructive clear by the model is FORBIDDEN', () => {
    assert.ok(leadStatusRef !== null);
    const codes = codesOf(withItem({ proposalType: 'MAP_FIELD', targetRef: leadStatusRef, transformPrimitive: 'CLEAR_VALUE' }));
    assert.ok(codes.includes('DESTRUCTIVE_PRIMITIVE_BY_MODEL') && codes.includes('PRIMITIVE_NOT_SUPPORTED'));
  });
  it('an identity strategy without proof and without the agency is FORBIDDEN; with the agency it is a decision', () => {
    // The same candidate under an IDENTITY_STRATEGY task: Status is not unique, so no proof exists.
    const identityTask = { ...task, taskType: 'IDENTITY_STRATEGY' as const, taskId: 'task_1111111111111111' };
    const identityBuilt = buildEnvelope({ task: identityTask, contracts, candidates, memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: built.envelope.budgetSnapshot, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
    const proposalFor = (requiresAgencyDecision: boolean): IntelligenceProposalV1 => ({ ...oracleProposal(identityBuilt.envelope, RUN), items: identityBuilt.envelope.deterministicCandidates.map((candidate) => ({ candidateRef: candidate.candidateRef, proposalType: 'PROPOSE_IDENTITY_STRATEGY' as const, targetRef: null, transformPrimitive: null, typedTransformParams: null, evidenceRefs: [...candidate.evidenceRefs], requiresAgencyDecision, rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER' as const, shortRationale: null, alternatives: [], abstainReason: null })) });
    const forbidden = compileProposal({ envelope: identityBuilt.envelope, envelopeHash: identityBuilt.hash, proposal: proposalFor(false), runId: RUN, contracts, decisions: resolution.decisions });
    assert.equal(forbidden.outcome, 'FORBIDDEN_PROPOSAL');
    assert.ok(forbidden.codes.includes('IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY'), forbidden.codes.join(','));
    const decision = compileProposal({ envelope: identityBuilt.envelope, envelopeHash: identityBuilt.hash, proposal: proposalFor(true), runId: RUN, contracts, decisions: resolution.decisions });
    assert.equal(decision.outcome, 'REQUIRES_AGENCY_DECISION');
  });
  it('the adapter refuses a vendor contract on a CLEAN_ONLY run and a vendor run without one', () => {
    assert.throws(() => adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract }), /CONTRACT_VIOLATION/u);
    assert.throws(() => adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null }), /CONTRACT_VIOLATION/u);
    assert.throws(() => adaptContracts({ mode: 'SALESFORCE', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract }), /CONTRACT_VIOLATION/u);
  });
  it('a duplicate target across two items without an explicit resolution is refused; a comparison used as a rewrite is not a primitive', () => {
    const proposal = base();
    const first = proposal.items[0];
    const second = proposal.items[1];
    if (first !== undefined && second !== undefined && leadStatusRef !== null) {
      const dup = { ...proposal, items: [{ ...first, proposalType: 'MAP_FIELD' as const, targetRef: leadStatusRef, transformPrimitive: 'PRESERVE_AS_IS' as const }, { ...second, proposalType: 'MAP_FIELD' as const, targetRef: leadStatusRef, transformPrimitive: 'PRESERVE_AS_IS' as const }] };
      assert.ok(compile(dup).codes.includes('DUPLICATE_TARGET_WITHOUT_RESOLUTION') || compile(dup).codes.includes('TARGET_NOT_ALLOWED_FOR_CANDIDATE'));
    }
    const codes = codesOf(withItem({ proposalType: 'MAP_FIELD', targetRef: leadStatusRef, transformPrimitive: 'PARSE_PHONE_E164', typedTransformParams: { defaultRegion: 'CO' } }));
    assert.ok(codes.includes('PHONE_REGION_NOT_EVIDENCED') || codes.includes('PRIMITIVE_DOES_NOT_APPLY_TO_TYPE'));
  });
  it('invented evidence refs, a rationale that looks like code, and unknown parameters are refused', () => {
    assert.ok(codesOf(withItem({ evidenceRefs: ['ev_0000000000000000'] })).includes('INVENTED_EVIDENCE_REF'));
    assert.ok(codesOf(withItem({ shortRationale: 'select * from contacts; => {}' })).includes('RATIONALE_LOOKS_LIKE_CODE'));
    assert.ok(codesOf(withItem({ proposalType: 'MAP_FIELD', targetRef: leadStatusRef, transformPrimitive: 'TRIM_WHITESPACE', typedTransformParams: { regex: '.*' } })).includes('UNKNOWN_PARAM_REGEX'));
  });
  it('stale hashes, another run, another task and another policy version are refused before anything else', () => {
    assert.equal(compile(withItem({}, { envelopeHash: 'f'.repeat(64) })).outcome, 'STALE_INPUT');
    assert.equal(compile(withItem({}, { runId: 'run_fedcba9876543210' })).outcome, 'STALE_INPUT');
    assert.equal(compile(withItem({}, { taskId: 'task_fedcba9876543210' })).outcome, 'STALE_INPUT');
    assert.equal(compile(withItem({}, { modelPolicyVersion: '9.0.0' })).outcome, 'INCOMPATIBLE_CONTRACT_VERSION');
  });
  it('a candidate the proposal does not answer is INVALID_SEMANTICS CANDIDATE_NOT_ANSWERED, repairable once, and never preserved as if answered', () => {
    const proposal = base();
    assert.ok(proposal.items.length >= 2, `the Status task carries two or more candidates: ${String(proposal.items.length)}`);
    const omitted = proposal.items[proposal.items.length - 1]?.candidateRef ?? '';
    const compiled = compile({ ...proposal, items: proposal.items.slice(0, -1) });
    const item = compiled.items.find((entry) => entry.candidateRef === omitted);
    assert.deepEqual([item?.outcome, item?.codes], ['INVALID_SEMANTICS', ['CANDIDATE_NOT_ANSWERED']], JSON.stringify(item));
    assert.equal(compiled.outcome, 'INVALID_SEMANTICS');
    assert.equal(compiled.repairable, true, 'an omission is repaired once, like an unknown ref');
    assert.ok(!compiled.items.some((entry) => entry.candidateRef === omitted && (entry.outcome === 'ABSTAINED' || entry.proposalType === 'UNMAPPED_PRESERVE')), 'the omitted candidate is not preserved as if answered');
    assert.ok(!compile(proposal).codes.includes('CANDIDATE_NOT_ANSWERED'), 'the complete answer names no omission');
  });
  it('a proposal type the task does not allow is FORBIDDEN and not repairable', () => {
    const compiled = compile(withItem({ proposalType: 'MAP_OBJECT', targetRef: leadStatusRef }));
    assert.equal(compiled.outcome, 'FORBIDDEN_PROPOSAL');
    assert.equal(compiled.repairable, false);
  });
  it('an unknown candidate ref is repairable once; a forbidden proposal is not', () => {
    const compiled = compile(withItem({ candidateRef: 'cand_0000000000000000' }));
    assert.equal(compiled.repairable, true);
  });
  it('disposes the fixture', () => {
    bundle.dispose();
  });
});
