import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { compileProposal } from '../src/compiler/compiler.js';
import type { CompiledItem } from '../src/compiler/compiler.js';
import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import { RATIONALE_CODES } from '../src/contracts/proposal.js';
import type { ProposalItem, RationaleCode } from '../src/contracts/proposal.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import { buildEnvelope } from '../src/envelope/envelope-builder.js';
import { oracleGateway, oracleProposal } from '../src/gateway/fake-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import { plan } from '../src/planner/task-planner.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import type { Bundle } from './support/fixtures.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';

/** The tenant every envelope of these tests is scoped to; the references it masks are bound to it (masking policy 1.3.0). */
const TENANT_SCOPE = { agencyId: 'agency-a', clientId: 'client-1' } as const;

/**
 * IC-1 correction, round 3 — the compiler lot. Every rationale code has a
 * fact rule and an item whose evidence class is AMBIGUOUS is never PROPOSED
 * (R2-PC-02); assembly claims a target once per record mapping, not once per
 * run (R2-PC-03, IC-08); the declared record id column reaches the resolver
 * through run() and an email declared there is still no proof (R2-PC-04,
 * IC-07); an ENUM destination carries the contract's options so a picklist
 * mapping reaches a SYSTEM_DRAFT through the host's validation (R2-PC-05).
 * The end-to-end cases are the reviewers' probes, adapted: a fake transport
 * answers each request with the oracle's proposal rewritten as a model
 * would answer it; no provider is called.
 */
const RUN = 'run_0123456789abcdef';
const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };
const DECLARED = { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };
const SUPPORTING: ReadonlySet<RationaleCode> = new Set<RationaleCode>(['HEADER_MATCHES_TARGET_LABEL', 'HEADER_MATCHES_TARGET_API_NAME', 'SHAPE_MATCHES_TARGET_TYPE', 'MEMORY_CONVENTION_APPLIES', 'VALUES_ARE_TARGET_OPTIONS', 'UNIQUE_AND_WELL_FORMED_IDENTIFIER']);

/** A transport answering with the oracle's proposal, each item rewritten by the case; `answer` sees the candidate's header and its allowed targets. */
function answeringTransport(rewrite: (item: ProposalItem, context: { readonly header: string; readonly allowedTargetRefs: readonly string[]; readonly envelope: IntelligenceEnvelopeV1 }) => ProposalItem): Transport {
  return async (request: ProviderRequest) => {
    const bytes = JSON.stringify(request);
    const payload = parseProviderRequestPayload(bytes);
    const envelope = payload.envelope;
    const proposal = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
    const headers = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field.header]));
    const items = proposal.items.map((item) => {
      const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
      if (candidate === undefined) return item;
      return rewrite(item, { header: headers.get(candidate.sourceRefs[0] ?? '') ?? '', allowedTargetRefs: candidate.allowedTargetRefs, envelope });
    });
    const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
    const text = JSON.stringify({ ...proposal, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' });
    return { status: 200, body: { id: 'msg_c3', type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
  };
}

/** The vendor target ref of a HubSpot api name, from the adapted contracts. */
function hubspotRef(contracts: ReturnType<typeof adaptContracts>, apiName: string): string {
  const ref = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === apiName)?.[0];
  assert.ok(ref !== undefined, `${apiName} is in the contract`);
  return ref;
}

function locatorOf(contracts: ReturnType<typeof adaptContracts>, header: string): string {
  const locator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === header)?.locator;
  assert.ok(locator !== undefined, `${header} is profiled`);
  return locator;
}

const mappedAs = (result: IntelligenceResult): readonly [string, string, string][] => (result.draft.configuration?.fields ?? []).map((field) => [field.filePath, field.columnHeader, field.destinationField]);

describe('R2-PC-02 — every rationale code has a fact rule; AMBIGUOUS evidence is never PROPOSED', () => {
  /** The reviewer's end-to-end case: a CSV without Last Name, a status column "Estado" (lead/OPEN) the model maps to lastname claiming INSUFFICIENT_EVIDENCE. */
  it('run-ambiguous-draft: "Estado" proposed as contact.lastName with INSUFFICIENT_EVIDENCE is a decision for the agency, never a SYSTEM_DRAFT mapping', async () => {
    const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
    // Estado is the run's only question: the id columns, which no target of the fixture contract can hold, would be UNMAPPED_HANDLING's own task and a second request (B03-CAP-STRUCTURE).
    const bundle = makeBundle('c3-ambiguous', { contacts: 'First Name,Email,Phone,Estado\nAda,ada@kauro-fixture.test,,lead\nGrace,grace@kauro-fixture.test,,OPEN\nAlan,alan@kauro-fixture.test,,lead\n', companies: 'Name,Website\nAnalytical Engines,https://analytical.test\nCOBOL Works,https://cobol.test\n' });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const lastnameRef = hubspotRef(contracts, 'lastname');
      let offered = false;
      const transport = answeringTransport((item, context) => {
        if (context.header !== 'Estado' || !context.allowedTargetRefs.includes(lastnameRef)) return item;
        offered = true;
        return { ...item, proposalType: 'MAP_FIELD', targetRef: lastnameRef, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'INSUFFICIENT_EVIDENCE', shortRationale: null, abstainReason: null, alternatives: [] };
      });
      const clock = new VirtualClock();
      const deps = depsFor(transportGateway(transport), realValidationPort(bundle, profiled.profile, contract, { clock }), clock);
      const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: new Map([[locatorOf(contracts, 'Estado'), ['lead', 'OPEN']]]) });
      const result = await createIntelligenceCore(deps).run({ ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } }, CONTEXT);
      assert.ok(offered, 'the envelope offered lastname to the Estado candidate');
      assert.ok(!mappedAs(result).some(([, header, destination]) => header === 'Estado' || destination === 'contact.lastName'), JSON.stringify(mappedAs(result)));
      assert.ok(result.draft.decisionsRequired.some((decision) => decision.reason === 'AMBIGUOUS_EVIDENCE_NEEDS_AGENCY'), JSON.stringify(result.draft.decisionsRequired));
      assert.ok(result.draft.evidence.every((entry) => entry.evidenceClass === 'SUPPORTED' || entry.evidenceClass === 'STRONG'), 'nothing drafted stands on AMBIGUOUS or INSUFFICIENT evidence');
      assert.equal(result.tasks[0]?.outcome, 'REQUIRES_AGENCY_DECISION');
      assert.equal(result.resourceEvidence.providerInvocations, 1, 'a deferral is not repaired: the agency decides, the model is not asked again');
    } finally {
      bundle.dispose();
    }
  });

  interface Fixture {
    readonly contracts: ReturnType<typeof adaptContracts>;
    readonly decisions: ReturnType<typeof resolve>['decisions'];
    readonly candidateRef: string;
    readonly envelope: IntelligenceEnvelopeV1;
    readonly hash: string;
    readonly allowed: readonly string[];
  }
  /** The open question over one column of a HubSpot fixture, with the envelope the task would carry. */
  function fixtureFor(bundle: Bundle, header: string, summaries: readonly string[] = []): Fixture {
    const profiled = profileBundle(bundle, 'HUBSPOT');
    const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: vendorContract('HUBSPOT', { withStatusPicklist: true }) });
    const resolution = resolve(contracts, { declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } });
    const fieldRef = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === header)?.[0] ?? '';
    const candidate = resolution.derivedCandidates.find((entry) => entry.sourceRefs.includes(fieldRef));
    assert.ok(candidate !== undefined, `${header} is an open question`);
    const task = plan('a'.repeat(64), resolution.openQuestions).tasks.find((entry) => entry.candidateRefs.includes(candidate.candidateRef));
    assert.ok(task !== undefined);
    const built = buildEnvelope({ task, contracts, candidates: [candidate], memoryEvidence: [], summaries: new Map(summaries.length === 0 ? [] : [[fieldRef, summaries]]), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
    return { contracts, decisions: resolution.decisions, candidateRef: candidate.candidateRef, envelope: built.envelope, hash: built.hash, allowed: candidate.allowedTargetRefs };
  }
  function compileWith(fixture: Fixture, overrides: Partial<ProposalItem>): CompiledItem {
    const proposal = oracleProposal(fixture.envelope, RUN);
    const items = proposal.items.map((item) => (item.candidateRef === fixture.candidateRef ? { ...item, ...overrides } : item));
    const compiled = compileProposal({ envelope: fixture.envelope, envelopeHash: fixture.hash, proposal: { ...proposal, items }, runId: RUN, contracts: fixture.contracts, decisions: fixture.decisions });
    const item = compiled.items.find((entry) => entry.candidateRef === fixture.candidateRef);
    assert.ok(item !== undefined);
    return item;
  }

  it('all fifteen codes over Status → Lifecycle Stage: a supporting code that holds is PROPOSED; every other code is refused by name or deferred, never PROPOSED', () => {
    const bundle = makeBundle('c3-fifteen');
    try {
      const fixture = fixtureFor(bundle, 'Status', ['Active', 'Inactive']);
      const stage = hubspotRef(fixture.contracts, 'lifecyclestage');
      const outcomes = new Map<RationaleCode, CompiledItem>();
      for (const code of RATIONALE_CODES) outcomes.set(code, compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: code, abstainReason: null }));
      assert.equal(outcomes.size, 15);
      for (const [code, item] of outcomes) {
        assert.ok(item.outcome !== 'PROPOSED' || (item.evidenceClass === 'SUPPORTED' || item.evidenceClass === 'STRONG'), `${code}: ${item.outcome} on ${item.evidenceClass}`);
        assert.ok(item.outcome !== 'PROPOSED' || SUPPORTING.has(code), `${code} defers and cannot be PROPOSED`);
        if (item.evidenceClass === 'AMBIGUOUS') assert.ok(item.outcome === 'REQUIRES_AGENCY_DECISION' && item.codes.includes('AMBIGUOUS_EVIDENCE_NEEDS_AGENCY'), `${code}: AMBIGUOUS is the agency's`);
        if (item.evidenceClass === 'INSUFFICIENT') assert.ok(item.outcome === 'INVALID_SEMANTICS' && item.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), `${code}: a contradicted claim is refused by name`);
      }
      // "Status" shares no name with Lifecycle Stage, its values are not the options, it is not unique: no supporting claim holds, so nothing is PROPOSED.
      assert.ok([...outcomes.values()].every((item) => item.outcome !== 'PROPOSED'), 'no supporting fact holds for Status');
      // The reviewer's four codes, by name: INSUFFICIENT_EVIDENCE holds (the compiler finds nothing either) and defers; the other three contradict the envelope.
      assert.deepEqual([outcomes.get('INSUFFICIENT_EVIDENCE')?.outcome, outcomes.get('INSUFFICIENT_EVIDENCE')?.evidenceClass], ['REQUIRES_AGENCY_DECISION', 'AMBIGUOUS']);
      assert.ok(outcomes.get('NO_TARGET_IN_ENVELOPE')?.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), 'an item that names a target cannot claim the envelope offered none');
      assert.ok(outcomes.get('FOREIGN_KEY_COLUMN')?.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), '"Status" names no other object');
      assert.ok(outcomes.get('AMBIGUOUS_BETWEEN_TARGETS')?.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), `one target was offered, not several: ${String(fixture.allowed.length)}`);
      assert.ok(outcomes.get('VALUE_NOT_IN_TARGET_OPTIONS')?.outcome === 'REQUIRES_AGENCY_DECISION', 'Active/Inactive are outside lead/OPEN: the claim holds and defers');
      assert.ok(outcomes.get('IDENTITY_NEEDS_PROOF')?.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'), 'Status is NOT_UNIQUE: there is no identity to prove');
    } finally {
      bundle.dispose();
    }
  });
  it('the deferring facts hold where the envelope says so: a "Company ID" column in a contacts file is a foreign key, the agency decides', () => {
    const bundle = makeBundle('c3-foreign', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Company ID\n1,Ada,Lovelace,ada@kauro-fixture.test,,C1\n2,Grace,Hopper,grace@kauro-fixture.test,,C2\n3,Alan,Turing,alan@kauro-fixture.test,,C1\n' });
    try {
      const fixture = fixtureFor(bundle, 'Company ID');
      const stage = hubspotRef(fixture.contracts, 'lifecyclestage');
      const foreign = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, rationaleCode: 'FOREIGN_KEY_COLUMN' });
      assert.equal(foreign.outcome, 'REQUIRES_AGENCY_DECISION', JSON.stringify(foreign));
      assert.equal(foreign.evidenceClass, 'AMBIGUOUS');
      const abstained = compileWith(fixture, { proposalType: 'ABSTAIN', targetRef: null, transformPrimitive: null, typedTransformParams: null, rationaleCode: 'NO_TARGET_IN_ENVELOPE', abstainReason: 'NO_VALID_TARGET' });
      assert.equal(abstained.outcome, 'ABSTAINED', 'an abstention claims no authority and is never refused for its code');
    } finally {
      bundle.dispose();
    }
  });
  it('positive: a header that names the target is still PROPOSED and SUPPORTED; the api-name claim is checked against the api name, the label claim against the label', () => {
    const bundle = makeBundle('c3-positive', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Lifecycle\n1,Ada,Lovelace,ada@kauro-fixture.test,,lead\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN\n' });
    try {
      const fixture = fixtureFor(bundle, 'Lifecycle');
      const stage = hubspotRef(fixture.contracts, 'lifecyclestage');
      const label = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL' });
      assert.equal(label.outcome, 'PROPOSED', JSON.stringify(label));
      assert.equal(label.evidenceClass, 'SUPPORTED');
      assert.deepEqual(label.codes, []);
      // "Lifecycle" is a token of the label "Lifecycle Stage"; the api name "lifecyclestage" is one token the header does not equal, so the api-name claim is the wrong claim and is refused by name.
      const apiName = compileWith(fixture, { proposalType: 'MAP_FIELD', targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, rationaleCode: 'HEADER_MATCHES_TARGET_API_NAME' });
      assert.equal(apiName.outcome, 'INVALID_SEMANTICS', JSON.stringify(apiName));
      assert.ok(apiName.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2-PC-03 / IC-08 — assembly claims a target once per record mapping, not once per run', () => {
  it('SEM-two-contact-files end to end: two files declared CONTACT both reach the SYSTEM_DRAFT with contact.email, one per file, and no decision is required', async () => {
    const base = makeBundle('c3-two-files');
    try {
      writeFileSync(join(base.root, 'contacts2.csv'), readFileSync(join(base.root, 'contacts.csv'), 'utf8').replace(/\n([1-4]),/gu, '\n10$1,'));
      const bundle: Bundle = { ...base, files: [...base.files, { id: 'contacts2', path: 'contacts2.csv', idHeader: 'Contact ID', object: 'CONTACT' }] };
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await createIntelligenceCore(depsFor(oracleGateway(), port, clock)).run({ ...input, projectRevision: { ...input.projectRevision, declaredObjects: { 'contacts.csv': 'CONTACT', 'contacts2.csv': 'CONTACT', 'companies.csv': 'COMPANY' } } }, CONTEXT);
      const emails = mappedAs(result).filter(([, , destination]) => destination === 'contact.email');
      assert.equal(result.draft.status, 'SYSTEM_DRAFT', JSON.stringify(result.draft.unresolved));
      assert.deepEqual(emails.map(([file]) => file).sort(), ['contacts.csv', 'contacts2.csv'], JSON.stringify(mappedAs(result)));
      assert.deepEqual(result.draft.decisionsRequired, [], 'no DUPLICATE_TARGET across files');
      assert.equal(mappedAs(result).filter(([file]) => file === 'contacts2.csv').length, 4, 'First Name, Last Name, Email and Phone of the second file are all mapped');
      assert.equal(result.draft.fullValidation?.rowsValidated, 10);
      const recordIds = new Set((result.draft.configuration?.fields ?? []).filter((field) => field.destinationField === 'contact.email').map((field) => field.recordId));
      assert.equal(recordIds.size, 2, 'each Email belongs to its own record mapping');
    } finally {
      base.dispose();
    }
  });
});

describe('R2-PC-04 / IC-07 — the declared record id column reaches the resolver through run(); an email declared there is still no proof', () => {
  const contactsWithoutId = (bundle: Bundle): ReturnType<typeof profileBundle> => profileBundle(bundle, 'CLEAN_ONLY');
  /** A transport that maps the "Contact ID" open question to contact.description claiming IDENTITY_NEEDS_PROOF — the only rationale whose fact reads the resolver's identity proof. */
  const identityTransport = (contracts: ReturnType<typeof adaptContracts>): Transport => {
    const description = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.destinationField === 'contact.description')?.[0] ?? '';
    return answeringTransport((item, context) => (context.header === 'Contact ID' && context.allowedTargetRefs.includes(description) ? { ...item, proposalType: 'MAP_FIELD', targetRef: description, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'IDENTITY_NEEDS_PROOF', shortRationale: null, abstainReason: null, alternatives: [] } : item));
  };
  /** The compiled outcome of the one item the transport rewrote: the only item of the run that can carry either of these codes. */
  const outcomeOfContactId = (result: IntelligenceResult): { readonly outcome: string; readonly codes: readonly string[] } | undefined => {
    const compiled = result.draft.unresolved.find((entry) => entry.codes.includes('AMBIGUOUS_EVIDENCE_NEEDS_AGENCY') || entry.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
    return compiled === undefined ? undefined : { outcome: compiled.outcome, codes: compiled.codes };
  };
  it('undeclared: Contact ID is UNIQUE_BUT_UNPROVEN, so "identity needs proof" holds and the item defers; declared as recordIdColumns: it is PROVEN and the claim is contradicted', async () => {
    const bundle = makeBundle('c3-record-id');
    try {
      const profiled = contactsWithoutId(bundle);
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const runWith = async (recordIdColumns: Record<string, string> | undefined, attempt: string): Promise<IntelligenceResult> => {
        const clock = new VirtualClock();
        const deps = depsFor(transportGateway(identityTransport(contracts)), realValidationPort(bundle, profiled.profile, null, { clock }), clock);
        const input = inputFor('CLEAN_ONLY', profiled, null);
        return createIntelligenceCore(deps).run({ ...input, projectRevision: { ...input.projectRevision, declaredObjects: DECLARED, ...(recordIdColumns === undefined ? {} : { recordIdColumns }) } }, { ...CONTEXT, auditAttemptId: attempt });
      };
      const undeclared = await runWith(undefined, 'c3-rid-1');
      assert.deepEqual(outcomeOfContactId(undeclared), { outcome: 'REQUIRES_AGENCY_DECISION', codes: ['AMBIGUOUS_EVIDENCE_NEEDS_AGENCY'] }, JSON.stringify(undeclared.draft.unresolved));
      const declared = await runWith({ 'contacts.csv': 'Contact ID' }, 'c3-rid-2');
      assert.equal(outcomeOfContactId(declared)?.outcome, 'INVALID_SEMANTICS', `a PROVEN identifier needs no proof: ${JSON.stringify(declared.draft.unresolved)}`);
      assert.ok(outcomeOfContactId(declared)?.codes.includes('RATIONALE_NOT_SUPPORTED_BY_FACTS'));
      // An email declared as the record id column is still a signal: the claim "needs proof" about Contact ID holds as if nothing were declared.
      const emailDeclared = await runWith({ 'contacts.csv': 'Email' }, 'c3-rid-3');
      assert.equal(outcomeOfContactId(emailDeclared)?.outcome, 'REQUIRES_AGENCY_DECISION', JSON.stringify(emailDeclared.draft.unresolved));
    } finally {
      bundle.dispose();
    }
  });
  it('at the resolver: the declared column proves; the same declaration naming Email leaves Email an IDENTITY_SIGNAL', () => {
    const bundle = makeBundle('c3-resolver-signal');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const proofOf = (recordIdColumns: Record<string, string>, header: string): string | null => {
        const fieldRef = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === header)?.[0] ?? '';
        return resolve(contracts, { declaredObjects: DECLARED, recordIdColumns }).decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === fieldRef)?.identityProof ?? null;
      };
      assert.equal(proofOf({ 'contacts.csv': 'Contact ID' }, 'Contact ID'), 'PROVEN_UNIQUE_IDENTIFIER');
      assert.equal(proofOf({ 'contacts.csv': 'Contact ID' }, 'Email'), 'IDENTITY_SIGNAL');
      assert.equal(proofOf({ 'contacts.csv': 'Email' }, 'Email'), 'IDENTITY_SIGNAL', 'declaring the email column as the record id does not make an email an identity');
      assert.equal(proofOf({ 'contacts.csv': 'Email' }, 'Contact ID'), 'UNIQUE_BUT_UNPROVEN');
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2-PC-05 — an ENUM destination carries the contract options, so a picklist mapping reaches the SYSTEM_DRAFT', () => {
  it('run-picklist-positive: Status (lead/OPEN) → Lifecycle Stage with VALUES_ARE_TARGET_OPTIONS is drafted as ENUM with allowedValues and validated by the engine', async () => {
    const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
    const bundle = makeBundle('c3-picklist', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@kauro-fixture.test,,lead\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN\n3,Alan,Turing,alan@kauro-fixture.test,,lead\n' });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const stage = hubspotRef(contracts, 'lifecyclestage');
      const transport = answeringTransport((item, context) => (context.header === 'Status' && context.allowedTargetRefs.includes(stage) ? { ...item, proposalType: 'MAP_FIELD', targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS', shortRationale: 'The values are the picklist options.', abstainReason: null, alternatives: [] } : item));
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, contract, { clock });
      const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: new Map([[locatorOf(contracts, 'Status'), ['lead', 'OPEN']]]) });
      const result = await createIntelligenceCore(depsFor(transportGateway(transport), port, clock)).run({ ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } }, CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.draft.unresolved));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      const status = result.draft.configuration?.fields.find((field) => field.columnHeader === 'Status');
      assert.ok(status !== undefined, JSON.stringify(mappedAs(result)));
      assert.equal(status.destinationField, 'contact.lifecycleStage');
      assert.equal(status.semanticType, 'ENUM');
      assert.deepEqual(status.allowedValues, ['lead', 'OPEN'], 'the options come from the attested contract');
      assert.ok(result.draft.configuration?.fields.filter((field) => field.semanticType !== 'ENUM').every((field) => field.allowedValues === undefined), 'only an ENUM destination carries allowedValues');
      assert.equal(result.draft.fullValidation?.ok, true, JSON.stringify(result.draft.fullValidation?.problems));
      assert.equal(result.draft.fullValidation?.rowsValidated, 5);
      assert.ok(result.draft.evidence.some((entry) => entry.destinationField === 'contact.lifecycleStage' && entry.rationaleCode === 'VALUES_ARE_TARGET_OPTIONS' && entry.evidenceClass === 'SUPPORTED'));
    } finally {
      bundle.dispose();
    }
  });
});
