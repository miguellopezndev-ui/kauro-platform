import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { compileProposal } from '../src/compiler/compiler.js';
import type { CompiledItem } from '../src/compiler/compiler.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { DeterministicCandidate } from '../src/contracts/envelope.js';
import type { IntelligenceProposalV1, ProposalItem } from '../src/contracts/proposal.js';
import { buildEnvelope } from '../src/envelope/envelope-builder.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import type { Resolution } from '../src/resolver/deterministic-resolver.js';
import type { AdaptedContracts } from '../src/adapter/contract-adapter.js';
import { makeBundle, profileBundle, vendorContract } from './support/fixtures.js';

/** The tenant every envelope of these tests is scoped to; the references it masks are bound to it (masking policy 1.3.0). */
const TENANT_SCOPE = { agencyId: 'agency-a', clientId: 'client-1' } as const;

/**
 * IC-06 — the evidence class is derived from facts the compiler computes,
 * never from the rationale code the model chose; and a primitive is checked
 * against the candidate's own allowlist, not the global catalogue alone.
 * Adapted from the audit probes SEM-evidence-self-claim and
 * SEM-primitive-outside-candidate (KAURO_AUDITORIA_MC_IC_20260911_V1 §4).
 */
const RUN = 'run_0123456789abcdef';
const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };

interface Fixture {
  readonly contracts: AdaptedContracts;
  readonly resolution: Resolution;
  readonly fieldRef: string;
  readonly candidate: DeterministicCandidate;
  readonly envelope: ReturnType<typeof buildEnvelope>['envelope'];
  readonly hash: string;
  readonly lifecycleRef: string;
  readonly dispose: () => void;
}

/** A HubSpot fixture whose open question is the named column; the picklist target is Lifecycle Stage (lead, OPEN). */
function fixtureFor(name: string, header: string, contacts?: string, summaries: Map<string, readonly string[]> = new Map()): Fixture {
  const bundle = makeBundle(name, contacts === undefined ? {} : { contacts });
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
  const resolution = resolve(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' } });
  const fieldRef = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === header)?.[0] ?? '';
  const candidate = resolution.derivedCandidates.find((entry) => entry.sourceRefs.includes(fieldRef));
  assert.ok(candidate !== undefined, `${header} is an open question`);
  const planned = plan('a'.repeat(64), resolution.openQuestions);
  const task = planned.tasks.find((entry) => entry.candidateRefs.includes(candidate.candidateRef));
  assert.ok(task !== undefined);
  const keyed = new Map([...summaries.entries()].map(([key, values]) => [key === header ? fieldRef : key, values]));
  const built = buildEnvelope({ task, contracts, candidates: [candidate], memoryEvidence: [], summaries: keyed, projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
  const lifecycleRef = built.envelope.targetContract.mode === 'HUBSPOT' ? built.envelope.targetContract.fields.find((field) => field.apiName === 'lifecyclestage')?.targetRef ?? '' : '';
  assert.ok(candidate.allowedTargetRefs.includes(lifecycleRef), 'the candidate may name Lifecycle Stage');
  return { contracts, resolution, fieldRef, candidate, envelope: built.envelope, hash: built.hash, lifecycleRef, dispose: bundle.dispose };
}

function compileWith(fixture: Fixture, overrides: Partial<ProposalItem>): CompiledItem {
  const proposal: IntelligenceProposalV1 = oracleProposal(fixture.envelope, RUN);
  const items = proposal.items.map((item) => (item.candidateRef === fixture.candidate.candidateRef ? { ...item, ...overrides } : item));
  const compiled = compileProposal({ envelope: fixture.envelope, envelopeHash: fixture.hash, proposal: { ...proposal, items }, runId: RUN, contracts: fixture.contracts, decisions: fixture.resolution.decisions });
  const item = compiled.items.find((entry) => entry.candidateRef === fixture.candidate.candidateRef);
  assert.ok(item !== undefined);
  return item;
}

const LIFECYCLE_CONTACTS = 'Contact ID,First Name,Last Name,Email,Phone,Lifecycle\n1,Ada,Lovelace,ada@kauro-fixture.test,+57 300 123 4567,lead\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN\n3,Alan,Turing,alan@kauro-fixture.test,+1 415 555 0100,lead\n4,Alan,Turing,ALAN@kauro-fixture.test,,lead\n';

describe('IC-06 — the evidence class comes from facts the compiler computes, not from the rationale code', () => {
  it('SEM-evidence-self-claim: "Status" → Lifecycle Stage claiming HEADER_MATCHES_TARGET_LABEL shares no name and is refused as RATIONALE_NOT_SUPPORTED_BY_FACTS', () => {
    const fixture = fixtureFor('facts-claim', 'Status');
    try {
      const item = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL' });
      assert.equal(item.evidenceClass, 'INSUFFICIENT', JSON.stringify(item));
      assert.equal(item.outcome, 'INVALID_SEMANTICS');
      assert.ok(item.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), item.codes.join(','));
      const apiName = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_API_NAME' });
      assert.ok(apiName.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
      const shape = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'SHAPE_MATCHES_TARGET_TYPE' });
      assert.ok(shape.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), 'a text column has no shape that maps to a picklist');
    } finally {
      fixture.dispose();
    }
  });
  it('a header that does share a name with the target label — "Lifecycle" → Lifecycle Stage — is SUPPORTED on that fact', () => {
    const fixture = fixtureFor('facts-header', 'Lifecycle', LIFECYCLE_CONTACTS);
    try {
      const item = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL' });
      assert.equal(item.outcome, 'PROPOSED', JSON.stringify(item));
      assert.equal(item.evidenceClass, 'SUPPORTED');
    } finally {
      fixture.dispose();
    }
  });
  it('VALUES_ARE_TARGET_OPTIONS holds only when the envelope exemplars are a subset of the options', () => {
    const inside = fixtureFor('facts-values-in', 'Lifecycle', LIFECYCLE_CONTACTS, new Map([['Lifecycle', ['lead', 'OPEN']]]));
    try {
      assert.ok(inside.envelope.exemplars.some((exemplar) => exemplar.fieldRef === inside.fieldRef), 'the envelope carries classified exemplars for the column');
      const item = compileWith(inside, { proposalType: 'MAP_FIELD', targetRef: inside.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' });
      assert.equal(item.outcome, 'PROPOSED', JSON.stringify(item));
      assert.notEqual(item.evidenceClass, 'INSUFFICIENT');
    } finally {
      inside.dispose();
    }
    const outside = fixtureFor('facts-values-out', 'Status', undefined, new Map([['Status', ['Active', 'Inactive']]]));
    try {
      const item = compileWith(outside, { proposalType: 'MAP_FIELD', targetRef: outside.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' });
      assert.equal(item.outcome, 'INVALID_SEMANTICS', JSON.stringify(item));
      assert.ok(item.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
    } finally {
      outside.dispose();
    }
    const unseen = fixtureFor('facts-values-none', 'Status');
    try {
      const item = compileWith(unseen, { proposalType: 'MAP_FIELD', targetRef: unseen.lifecycleRef, transformPrimitive: 'PRESERVE_AS_IS', rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' });
      assert.ok(item.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), 'no exemplar in the envelope is no fact about the values');
    } finally {
      unseen.dispose();
    }
  });
  it('SEM-primitive-outside-candidate: a primitive the catalogue supports but the candidate does not carry is FORBIDDEN; one it carries is not', () => {
    const fixture = fixtureFor('facts-primitive', 'Status');
    try {
      assert.ok(!fixture.candidate.allowedPrimitiveRefs.includes('MAP_ENUM_VALUE'));
      assert.ok(fixture.envelope.constraints.supportedTransformPrimitives.includes('MAP_ENUM_VALUE'), 'the global catalogue alone would admit it');
      const item = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'MAP_ENUM_VALUE', typedTransformParams: { from: 'Active', to: 'OPEN' }, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' });
      assert.equal(item.outcome, 'FORBIDDEN_PROPOSAL', JSON.stringify(item));
      assert.ok(item.codes.includes('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE'), item.codes.join(','));
      const allowed = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: fixture.lifecycleRef, transformPrimitive: 'TRIM_WHITESPACE', rationaleCode: 'HEADER_MATCHES_TARGET_LABEL' });
      assert.ok(!allowed.codes.includes('PRIMITIVE_NOT_ALLOWED_FOR_CANDIDATE'));
      assert.notEqual(allowed.outcome, 'FORBIDDEN_PROPOSAL');
    } finally {
      fixture.dispose();
    }
  });
});
