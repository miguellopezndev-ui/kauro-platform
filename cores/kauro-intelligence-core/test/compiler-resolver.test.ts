import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { compileProposal } from '../src/compiler/compiler.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import type { DeterministicCandidate } from '../src/contracts/envelope.js';
import { buildEnvelope } from '../src/envelope/envelope-builder.js';
import type { TaskRecord } from '../src/contracts/run.js';
import { oracleProposal } from '../src/gateway/fake-gateway.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { makeBundle, profileBundle, vendorContract } from './support/fixtures.js';

/** The tenant every envelope of these tests is scoped to; the references it masks are bound to it (masking policy 1.3.0). */
const TENANT_SCOPE = { agencyId: 'agency-a', clientId: 'client-1' } as const;

/**
 * IC-07, IC-08, IC-09 at the resolver: statistical uniqueness is not identity
 * (SEM-email-is-not-identity-proof), a target is claimed once per record
 * mapping and not once per run (SEM-two-contact-files), and every decision
 * carries the evidence the draft projects.
 */
const RUN = 'run_0123456789abcdef';
const budget = { maxInputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, maxOutputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, remainingBilledInputTokens: 1_000_000, remainingBilledOutputTokens: 100_000, remainingTasks: 10, deadlineAt: '2026-09-11T01:00:00Z' };
const DECLARED = { 'contacts.csv': 'CONTACT', 'companies.csv': 'COMPANY' };

describe('IC-07 — a unique email is an identity signal, never an identity proof', () => {
  const bundle = makeBundle('resolver-identity');
  const profiled = profileBundle(bundle, 'HUBSPOT');
  const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: vendorContract('HUBSPOT', { withStatusPicklist: true }) });
  const fieldRefOf = (header: string): string => [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === header)?.[0] ?? '';
  const proofOf = (decisions: ReturnType<typeof resolve>['decisions'], header: string): string | null => decisions.find((decision) => decision.kind === 'IDENTITY_PROOF' && decision.fieldRef === fieldRefOf(header))?.identityProof ?? null;

  it('SEM-email-is-not-identity-proof: Email is unique and populated on every row and is classified IDENTITY_SIGNAL', () => {
    const email = contracts.profileView.fields.find((field) => field.header === 'Email');
    assert.ok(email !== undefined && email.uniqueAmongNonEmpty === true && email.nonEmptyCount === email.rowCount, 'the fixture email column is statistically unique');
    const resolution = resolve(contracts, { declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } });
    assert.equal(proofOf(resolution.decisions, 'Email'), 'IDENTITY_SIGNAL');
    assert.equal(proofOf(resolution.decisions, 'Status'), 'NOT_UNIQUE');
  });
  it('the declared record id column still proves; without the declaration nothing in the file does', () => {
    const declared = resolve(contracts, { declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' } });
    assert.equal(proofOf(declared.decisions, 'Contact ID'), 'PROVEN_UNIQUE_IDENTIFIER');
    assert.equal(proofOf(declared.decisions, 'Company ID'), 'PROVEN_UNIQUE_IDENTIFIER');
    const undeclared = resolve(contracts, { declaredObjects: DECLARED });
    assert.equal(undeclared.decisions.filter((decision) => decision.identityProof === 'PROVEN_UNIQUE_IDENTIFIER').length, 0, 'no authority, no proof');
    assert.equal(proofOf(undeclared.decisions, 'Contact ID'), 'UNIQUE_BUT_UNPROVEN');
    const wrongFile = resolve(contracts, { declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Email' } });
    assert.equal(proofOf(wrongFile.decisions, 'Contact ID'), 'UNIQUE_BUT_UNPROVEN', 'a declaration names one column of one file');
  });
  it('the compiler treats IDENTITY_SIGNAL as no proof: PROPOSE_IDENTITY_STRATEGY on Email without the agency is FORBIDDEN', () => {
    const resolution = resolve(contracts, { declaredObjects: DECLARED, recordIdColumns: { 'contacts.csv': 'Contact ID' } });
    const email = contracts.profileView.fields.find((field) => field.header === 'Email');
    assert.ok(email !== undefined);
    // Email was mapped deterministically, so no derived candidate exists: the identity task is built over an audit-shaped candidate, as the probe does.
    const candidate: DeterministicCandidate = { candidateRef: 'cand_1234567890abcdef', candidateType: 'DERIVED_FIELD_DECISION', sourceRefs: [email.fieldRef], allowedTargetRefs: [], allowedPrimitiveRefs: ['PRESERVE_AS_IS'], evidenceRefs: email.evidenceRefs, impactCounts: { rows: email.rowCount, distinct: email.distinctCount }, constraints: { destructiveAllowed: false, identityAutoMergeAllowed: false }, derivedFrom: { candidateSetHash: contracts.candidateSetHash, candidateRef: null, rule: 'AUDIT_IDENTITY_INPUT' } };
    const built = buildEnvelope({ task: { taskId: 'task_1234567890abcdef', taskType: 'IDENTITY_STRATEGY', partitionKey: 'identity', candidateRefs: [candidate.candidateRef], order: 0 } satisfies TaskRecord, contracts, candidates: [candidate], memoryEvidence: [], summaries: new Map(), projectRevisionId: 'rev', projectRevisionHash: 'a'.repeat(64), supportEnvelopeVersion: '2.0.1', budgetSnapshot: budget, repairContext: null, egressSecret: Buffer.alloc(32, 3), tenant: TENANT_SCOPE, attemptId: 'attempt-0001' });
    const proposal = oracleProposal(built.envelope, RUN);
    const items = proposal.items.map((item) => ({ ...item, proposalType: 'PROPOSE_IDENTITY_STRATEGY' as const, targetRef: null, transformPrimitive: null, typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'UNIQUE_AND_WELL_FORMED_IDENTIFIER' as const, abstainReason: null }));
    const compiled = compileProposal({ envelope: built.envelope, envelopeHash: built.hash, proposal: { ...proposal, items }, runId: RUN, contracts, decisions: resolution.decisions });
    assert.equal(compiled.outcome, 'FORBIDDEN_PROPOSAL', JSON.stringify(compiled));
    assert.ok(compiled.codes.includes('IDENTITY_WITHOUT_PROOF_NEEDS_AGENCY'), compiled.codes.join(','));
  });
  it('disposes the fixture', () => {
    bundle.dispose();
  });
});

describe('IC-08 — a target is claimed once per record mapping, not once per run', () => {
  it('SEM-two-contact-files: two files declared CONTACT each map their own Email to contact.email', () => {
    const base = makeBundle('resolver-two-files');
    try {
      writeFileSync(join(base.root, 'contacts2.csv'), readFileSync(join(base.root, 'contacts.csv'), 'utf8').replace(/\n([1-4]),/gu, '\n10$1,'));
      const bundle = { ...base, files: [...base.files, { id: 'contacts2', path: 'contacts2.csv', idHeader: 'Contact ID', object: 'CONTACT' }] };
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const resolution = resolve(contracts, { declaredObjects: { 'contacts.csv': 'CONTACT', 'contacts2.csv': 'CONTACT', 'companies.csv': 'COMPANY' } });
      const emails = resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.destinationField === 'contact.email');
      assert.equal(emails.length, 2, JSON.stringify(resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING')));
      const fileIds = [...new Set(emails.map((decision) => contracts.refs.fieldByRef.get(decision.fieldRef)?.fileId))];
      assert.equal(fileIds.length, 2, 'one Email per file');
      assert.deepEqual(emails.map((decision) => decision.recordId).sort(), fileIds.map((fileId) => `${fileId ?? ''}-contact`).sort(), 'each decision belongs to its own record mapping');
      assert.ok(emails.every((decision) => decision.origin === 'DETERMINISTIC' && decision.impactRows === 4 && decision.evidenceRefs.length > 0));
      const secondEmail = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.fileId === 'contacts2' && entry.header === 'Email')?.[0] ?? '';
      assert.ok(!resolution.openQuestions.some((question) => question.fieldRefs.includes(secondEmail)), 'the second Email is decided, not asked');
    } finally {
      base.dispose();
    }
  });
  it('two columns of the same file competing for one target remain a conflict: the first claims, the second is an open question', () => {
    const bundle = makeBundle('resolver-same-file', { contacts: 'Contact ID,First Name,Last Name,Email,E-mail\n1,Ada,Lovelace,ada@kauro-fixture.test,ada2@kauro-fixture.test\n2,Grace,Hopper,grace@kauro-fixture.test,grace2@kauro-fixture.test\n' });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const contracts = adaptContracts({ mode: 'CLEAN_ONLY', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: null });
      const resolution = resolve(contracts, { declaredObjects: DECLARED });
      const emails = resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.destinationField === 'contact.email');
      assert.equal(emails.length, 1, 'one record mapping, one owner of contact.email');
      const second = [...contracts.refs.fieldByRef.entries()].find(([, entry]) => entry.header === 'E-mail')?.[0] ?? '';
      assert.ok(resolution.openQuestions.some((question) => question.fieldRefs.includes(second)), 'the competing column is a question');
      const derived = resolution.derivedCandidates.find((candidate) => candidate.sourceRefs.includes(second));
      assert.ok(derived !== undefined && !derived.allowedTargetRefs.some((ref) => contracts.refs.targetByRef.get(ref)?.destinationField === 'contact.email'), 'the claimed target is not offered again inside the same record mapping');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-09 — every deterministic decision carries the evidence the draft projects', () => {
  it('field mappings name origin, record mapping, source, destination, rule, refs and impact rows', () => {
    const bundle = makeBundle('resolver-evidence');
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: vendorContract('HUBSPOT', { withStatusPicklist: true }) });
      const resolution = resolve(contracts, { declaredObjects: DECLARED });
      const mappings = resolution.decisions.filter((decision) => decision.kind === 'FIELD_MAPPING');
      assert.ok(mappings.length > 0);
      for (const decision of mappings) {
        assert.equal(decision.origin, 'DETERMINISTIC');
        assert.equal(decision.sourceFieldRef, decision.fieldRef);
        assert.ok(decision.targetRef !== null && decision.destinationField === contracts.refs.targetByRef.get(decision.targetRef)?.destinationField);
        assert.ok(decision.recordId !== null && decision.recordId.endsWith(`-${(decision.destinationField ?? '').split('.')[0] ?? ''}`));
        assert.equal(decision.rule, 'EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE');
        assert.ok(decision.evidenceRefs.length > 0 && decision.evidenceRefs.every((ref) => contracts.refs.evidenceByRef.has(ref)));
        assert.equal(decision.impactRows, contracts.profileView.fields.find((field) => field.fieldRef === decision.fieldRef)?.nonEmptyCount);
      }
      for (const decision of resolution.decisions) {
        assert.equal(decision.origin, 'DETERMINISTIC');
        assert.equal(typeof decision.impactRows, 'number');
        if (decision.kind !== 'FIELD_MAPPING') assert.equal(decision.destinationField, null);
      }
    } finally {
      bundle.dispose();
    }
  });
});
