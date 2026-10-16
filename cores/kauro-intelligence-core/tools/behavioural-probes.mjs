#!/usr/bin/env node
/**
 * Behavioural probes: five material refusals exercised on the built public
 * entry, outside the test suite, with nothing but the public API. Each probe
 * pairs a positive control (the same call, accepted) with the refusal, so a
 * module that throws on everything does not pass. The architecture gate runs
 * this file and records one EXECUTED fact per probe; a probe that throws
 * where it should not, or does not throw where it must, is false.
 *
 *   node tools/behavioural-probes.mjs      prints { probes: [{ name, ok, detail }] }, exit 0 when all ok
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const api = await import(pathToFileURL(resolve(root, 'dist', 'src', 'index.js')).href);
const { assertEgressBinds, decideEgress, RunLedger, MemoryLedgerStore, VirtualClock, BUDGET_LIMITS, RUN_TRANSITIONS, RUN_STATES, classifyValue, compileProposal, isIntelligenceError } = api;

const probes = [];
const probe = (name, body) => {
  try {
    probes.push({ name, ok: true, detail: body() });
  } catch (error) {
    probes.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
};
const refused = (fn, code) => {
  try {
    fn();
  } catch (error) {
    if (isIntelligenceError(error) && error.code === code) return error.message;
    throw new Error(`refused with ${isIntelligenceError(error) ? error.code : String(error)}, expected ${code}`);
  }
  throw new Error(`accepted; expected ${code}`);
};

// (a) An envelope changed after its egress decision is not sent; the same envelope is.
probe('egress_binding', () => {
  const secret = Buffer.from('probe-secret-not-a-credential');
  // The smallest envelope the egress decision can re-read: no fields, a CLEAN_ONLY contract, no memory, no repair, and the four channels of the closed envelope (objects, association options, review claims) empty.
  const envelope = { taskId: 'task_probe', exemplars: [], deterministicCandidates: [], objectTargets: [], objectFacts: [], associationTargets: [], reviewClaims: [], sourceProfile: { fields: [] }, targetContract: { mode: 'CLEAN_ONLY', canonicalFields: [] }, memoryEvidence: [], repairContext: null };
  const minimization = { classesSeen: ['SAFE_STRUCTURAL_METADATA'], blocked: [], maxDataLevel: 'L0' };
  const budget = { remainingTasks: 1, remainingBilledInputTokens: 1000, remainingBilledOutputTokens: 100 };
  const decision = decideEgress({ envelope, hash: api.envelopeHash(envelope), minimization, budget, secret });
  if (decision.decision !== 'EGRESS_ALLOWED') throw new Error(`control decision is ${decision.decision}`);
  assertEgressBinds(decision, envelope, secret);
  const modified = { ...envelope, exemplars: [{ fieldRef: 'fld_x', value: 'added after egress' }] };
  const reason = refused(() => assertEgressBinds(decision, modified, secret), 'EGRESS_BLOCKED');
  const forged = refused(() => assertEgressBinds({ ...decision, token: 'f'.repeat(decision.token.length) }, envelope, secret), 'EGRESS_BLOCKED');
  return `same envelope accepted; modified refused (${reason}); forged token refused (${forged})`;
});

// (b) A reservation above the per-request input ceiling is BUDGET_EXHAUSTED; one at the ceiling stands.
probe('budget_per_request_ceiling', () => {
  const create = () => RunLedger.create(new MemoryLedgerStore(), new VirtualClock(), { auditAttemptId: 'probe-attempt', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: { agencyId: 'probe-agency', clientId: 'probe-client' } });
  const ceiling = BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST;
  const at = create().reserve({ taskId: 'task_probe', attempt: 1, inputTokens: ceiling, outputTokens: 1, idempotencyKey: 'probe-key-at' });
  if (at.state !== 'RESERVED' || at.inputTokens !== ceiling) throw new Error('control reservation at the ceiling did not stand');
  const reason = refused(() => create().reserve({ taskId: 'task_probe', attempt: 1, inputTokens: ceiling + 1, outputTokens: 1, idempotencyKey: 'probe-key-over' }), 'BUDGET_EXHAUSTED');
  return `${String(ceiling)} reserved; ${String(ceiling + 1)} refused (${reason})`;
});

// (c) The run state machine has no CREATED → PROPOSAL_READY, in the table and in the ledger that applies it.
probe('run_transitions_closed', () => {
  if (RUN_TRANSITIONS.CREATED.includes('PROPOSAL_READY')) throw new Error('the table allows CREATED → PROPOSAL_READY');
  const missing = RUN_STATES.filter((state) => !Array.isArray(RUN_TRANSITIONS[state]));
  if (missing.length > 0) throw new Error(`states without a transition row: ${missing.join(', ')}`);
  const ledger = RunLedger.create(new MemoryLedgerStore(), new VirtualClock(), { auditAttemptId: 'probe-attempt', projectRevisionHash: 'b'.repeat(64), hashes: {}, versions: {}, tenant: { agencyId: 'probe-agency', clientId: 'probe-client' } });
  const reason = refused(() => ledger.transition('PROPOSAL_READY', 'probe'), 'INVALID_TRANSITION');
  ledger.transition('ENVELOPE_VALIDATED', 'probe');
  if (ledger.view().state !== 'ENVELOPE_VALIDATED') throw new Error('the control transition did not apply');
  return `CREATED → ENVELOPE_VALIDATED applied; CREATED → PROPOSAL_READY refused (${reason}); ${String(RUN_STATES.length)} states have rows`;
});

// (d) An email is never a safe class; a low-cardinality status word is.
probe('classifier_email_not_safe', () => {
  const email = classifyValue('ada@probe.example', { header: 'Contact', distinctCount: 2, rowCount: 100, shapeCandidates: ['emailLike'] });
  if (email.dataClass.startsWith('SAFE_')) throw new Error(`an email classified ${email.dataClass}`);
  const status = classifyValue('Active', { header: 'Status', distinctCount: 2, rowCount: 100, shapeCandidates: [] });
  if (status.dataClass !== 'SAFE_LOW_CARDINALITY_SEMANTICS') throw new Error(`the control value classified ${status.dataClass}`);
  return `email → ${email.dataClass}; status word → ${status.dataClass}`;
});

// (e) A proposal naming a target the envelope did not offer compiles to FORBIDDEN_PROPOSAL; the offered target compiles.
probe('compiler_target_outside_envelope', () => {
  const envelope = {
    taskId: 'task_probe',
    constraints: { allowedTargetIds: ['tgt_offered'], allowedProposalTypes: ['MAP_FIELD'], maxItems: 8, supportedTransformPrimitives: [], maxRationaleLength: 200 },
    deterministicCandidates: [{ candidateRef: 'cand_probe', sourceRefs: ['fld_probe'], allowedTargetRefs: ['tgt_offered', 'tgt_outside'], allowedPrimitiveRefs: ['PRESERVE_AS_IS'], evidenceRefs: ['ev_probe'], impactCounts: { rows: 1 } }],
    sourceProfile: { fields: [{ fieldRef: 'fld_probe', header: 'Email', shapeCandidates: ['emailLike'], evidenceRefs: [] }] },
    targetContract: { mode: 'CLEAN_ONLY' },
    memoryEvidence: [],
    // Facts the compiler derives evidence from: no exemplars travelled, the header names the target.
    exemplars: [],
  };
  const envelopeHash = api.envelopeHash(envelope);
  // The adapted contracts the compiler reads: the frozen profile view, the CLEAN_ONLY contract view and the reference tables (the closed design of B03 compiles against the record mappings of the run, here none).
  const contracts = { profileView: { fields: envelope.sourceProfile.fields }, contractView: { mode: 'CLEAN_ONLY', canonicalFields: [], relationshipTypes: [] }, refs: { fieldByRef: new Map([['fld_probe', { locator: 'probe-locator', fileId: 'probe-file', filePath: 'probe.csv', sheetId: 'probe-sheet', header: 'Email', columnIndex: 0 }]]), targetByRef: new Map([['tgt_offered', { destinationField: 'contact.email' }], ['tgt_outside', { destinationField: 'contact.phone' }]]) } };
  const proposalFor = (targetRef) => ({
    schemaVersion: api.PROPOSAL_SCHEMA_VERSION,
    taskId: 'task_probe',
    runId: 'run_probe',
    modelPolicyVersion: api.MODEL_POLICY_VERSION,
    promptBundleVersion: api.PROMPT_BUNDLE_VERSION,
    envelopeHash,
    items: [{ candidateRef: 'cand_probe', proposalType: 'MAP_FIELD', targetRef, transformPrimitive: null, typedTransformParams: null, evidenceRefs: ['ev_probe'], requiresAgencyDecision: false, rationaleCode: 'HEADER_MATCHES_TARGET_LABEL', shortRationale: null, alternatives: [], abstainReason: null }],
    overallOutcome: 'PROPOSED',
  });
  const compile = (targetRef) => compileProposal({ envelope, envelopeHash, proposal: proposalFor(targetRef), runId: 'run_probe', contracts, decisions: [] });
  const offered = compile('tgt_offered');
  if (offered.outcome !== 'PROPOSED') throw new Error(`the control target compiled ${offered.outcome}: ${offered.codes.join(',')}`);
  const outside = compile('tgt_outside');
  if (outside.outcome !== 'FORBIDDEN_PROPOSAL' && outside.outcome !== 'INVALID_SEMANTICS') throw new Error(`the outside target compiled ${outside.outcome}`);
  if (!outside.codes.includes('TARGET_OUTSIDE_ENVELOPE')) throw new Error(`refused for ${outside.codes.join(',')}, not TARGET_OUTSIDE_ENVELOPE`);
  return `offered target → PROPOSED; outside target → ${outside.outcome} [${outside.codes.join(',')}]`;
});

const ok = probes.length === 5 && probes.every((entry) => entry.ok);
process.stdout.write(`${JSON.stringify({ artifactKind: 'INTELLIGENCE_CORE_BEHAVIOURAL_PROBES', probes, ok }, null, 2)}\n`);
process.exit(ok ? 0 : 1);
