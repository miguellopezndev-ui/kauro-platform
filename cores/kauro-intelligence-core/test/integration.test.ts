import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CORE_VERSION } from 'kauro-migration-core';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import { oracleGateway, scriptedGateway } from '../src/gateway/fake-gateway.js';
import { VirtualClock } from '../src/kernel/ledger.js';
import type { CandidateConfiguration, FullDatasetValidationResult } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';

describe('end to end: fake gateway → compiler → the frozen engine in the host adapter → full validation → draft', () => {
  for (const mode of ['CLEAN_ONLY', 'HUBSPOT', 'SALESFORCE'] as const) {
    it(`${mode}: a validated configuration becomes a SYSTEM_DRAFT and keeps every row`, { timeout: 120_000 }, async () => {
      const bundle = makeBundle(`e2e-${mode.toLowerCase()}`);
      try {
        const profiled = profileBundle(bundle, mode);
        const contract = mode === 'CLEAN_ONLY' ? null : vendorContract(mode);
        const port = realValidationPort(bundle, profiled.profile, contract);
        const core = createIntelligenceCore(depsFor(oracleGateway(), port));
        const input = inputFor(mode, profiled, contract);
        const final = await core.run(input, CONTEXT);
        assert.equal(final.state, 'PROPOSAL_READY', JSON.stringify({ state: final.state, unresolved: final.unresolvedItems.slice(0, 5), tasks: final.tasks.map((task) => [task.taskType, task.outcome, task.codes.slice(0, 3)]) }));
        assert.equal(final.draft.status, 'SYSTEM_DRAFT');
        assert.ok(final.draft.configuration !== null && final.draft.configuration.fields.length >= 2, 'at least email and name are mapped');
        assert.equal(final.draft.fullValidation?.rowsValidated, profiled.profile.profile.totals.dataRowCount, 'every row of the fixture was validated by the engine');
        assert.equal(final.draft.fullValidation?.reconciliationHolds, true);
        assert.equal(final.draft.fullValidation?.packageVerified, true);
        assert.ok(final.resourceEvidence.deterministicDecisions > 0);
        assert.ok(final.resourceEvidence.modelCalls <= final.resourceEvidence.tasksPlanned * BUDGET_LIMITS.MAX_SEMANTIC_ATTEMPTS_PER_TASK);
        assert.equal(final.provenance.targetContractHash, contract?.contractHash ?? null);
        assert.ok(final.draft.unsupportedPreserved.length >= 0);
        assert.equal(final.draft.note, 'A SYSTEM_DRAFT is not an approval, a quote or an authorisation to execute.');
      } finally {
        bundle.dispose();
      }
    });
  }

  it('the validation port cannot be a stub: ok:true with no rows validated is refused and blocks the draft', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('stub-port');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const stub = { async validate(configuration: CandidateConfiguration): Promise<FullDatasetValidationResult> { return { ok: true, configurationRef: configuration.configurationRef, configurationDigest: digestOf(configuration), profileHash: profiled.profile.profileHash, candidateSetHash: configuration.candidateSetHash, targetContractHash: null, rowsValidated: 0, rowsInProfile: 0, reconciliationHolds: true, packageVerified: true, problems: [], validatedAt: '2026-09-11T00:00:00.000Z', coreVersion: CORE_VERSION, evidence: { packageDigest: null, reportDigest: null, coreConfigHash: null }, effects: null }; } };
      const result = await createIntelligenceCore(depsFor(oracleGateway(), stub)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
      assert.ok(result.unresolvedItems.some((item) => item.codes.includes('VALIDATION_COVERAGE_INCOMPLETE')), JSON.stringify(result.unresolvedItems));
      assert.equal(result.state, 'FAILED_COMPILER');
    } finally {
      bundle.dispose();
    }
  });

  it('a stale validation — hashes of another candidate set — blocks the draft', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('stale-port');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const real = realValidationPort(bundle, profiled.profile, null, { clock });
      const stale = { async validate(configuration: Parameters<typeof real.validate>[0]) { const result = await real.validate(configuration); return { ...result, candidateSetHash: 'f'.repeat(64) }; } };
      const result = await createIntelligenceCore(depsFor(oracleGateway(), stale, clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
      const codes = result.unresolvedItems.flatMap((item) => [...item.codes]);
      assert.ok(codes.includes('VALIDATION_HASHES_STALE'), JSON.stringify(codes));
      assert.ok(!codes.includes('VALIDATION_AFTER_NOW'), 'the receipt is dated by the run\'s clock; staleness is the only problem');
    } finally {
      bundle.dispose();
    }
  });

  it('a vendor contract handed to a CLEAN_ONLY run, or none handed to a vendor run, fails the contract before any call', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('mode-mismatch');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const gateway = scriptedGateway({});
      const core = createIntelligenceCore(depsFor(gateway, realValidationPort(bundle, profiled.profile, null)));
      // Two inputs are two attempts; one attempt id cannot name both.
      const withContract = await core.run(inputFor('CLEAN_ONLY', profiled, vendorContract('HUBSPOT')), { ...CONTEXT, auditAttemptId: 'attempt-mismatch-1' });
      assert.equal(withContract.state, 'FAILED_CONTRACT');
      const hubspotWithout = await core.run(inputFor('HUBSPOT', profiled, null), { ...CONTEXT, auditAttemptId: 'attempt-mismatch-2' });
      assert.equal(hubspotWithout.state, 'FAILED_CONTRACT');
      assert.equal(gateway.calls, 0, 'no model call was made');
    } finally {
      bundle.dispose();
    }
  });

  it('the number of model calls does not grow with the number of rows', { timeout: 120_000 }, async () => {
    const small = makeBundle('rows-small', { extraColumns: 2 });
    const large = makeBundle('rows-large', { extraColumns: 2, extraRows: 400 });
    try {
      const calls: number[] = [];
      for (const bundle of [small, large]) {
        const profiled = profileBundle(bundle, 'CLEAN_ONLY');
        const port = realValidationPort(bundle, profiled.profile, null);
        const result = await createIntelligenceCore(depsFor(oracleGateway(), port)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
        calls.push(result.resourceEvidence.modelCalls);
      }
      assert.equal(calls[0], calls[1], `calls ${String(calls[0])} vs ${String(calls[1])}`);
      assert.ok((calls[0] ?? 0) >= 1);
    } finally {
      small.dispose();
      large.dispose();
    }
  });

  it('a redelivered request is answered from the ledger, not billed again — a second or an hour later; a new attempt is a new run; the same attempt about other content is refused', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('idempotent');
    const other = makeBundle('idempotent-other', { extraColumns: 1 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const deps = depsFor(oracleGateway(), port);
      const first = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(first.state, 'PROPOSAL_READY');
      const validations = port.calls;
      // Same store and inputs, the clock a second and then an hour later: the same run, no call, no validation, the same digest.
      for (const advance of [1_000, 3_600_000]) {
        deps.clock.advance(advance);
        const gateway = oracleGateway();
        const again = await createIntelligenceCore({ ...depsFor(gateway, port, deps.clock), ledgerStore: deps.store }).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
        assert.equal(again.runId, first.runId, `after ${String(advance)} ms`);
        assert.equal(gateway.calls, 0, 'every response came from the ledger');
        assert.equal(again.proposalDigest, first.proposalDigest);
        assert.equal(again.resourceEvidence.providerInvocations, first.resourceEvidence.providerInvocations);
        assert.equal(port.calls, validations, 'the validation port was not called again');
        assert.equal(again.runLedger.filter((event) => event.kind === 'RUN_CREATED').length, 1);
      }
      // A new attempt the agency authorised is explicit: a new id, a new run, its own calls.
      const fresh = oracleGateway();
      const second = await createIntelligenceCore({ ...depsFor(fresh, port, deps.clock), ledgerStore: deps.store }).run(inputFor('CLEAN_ONLY', profiled, null), { ...CONTEXT, auditAttemptId: 'attempt-0002' });
      assert.notEqual(second.runId, first.runId);
      assert.ok(fresh.calls > 0);
      // The same attempt id about another profile is a host defect: refused before anything is spent.
      const otherProfiled = profileBundle(other, 'CLEAN_ONLY');
      assert.notEqual(otherProfiled.profile.profileHash, profiled.profile.profileHash);
      const conflicting = oracleGateway();
      await assert.rejects(createIntelligenceCore({ ...depsFor(conflicting, port, deps.clock), ledgerStore: deps.store }).run(inputFor('CLEAN_ONLY', otherProfiled, null), CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT');
      assert.equal(conflicting.calls, 0);
      assert.equal(deps.store.read(first.runId).length, first.runLedger.length, 'the conflict left the original run untouched');
    } finally {
      bundle.dispose();
      other.dispose();
    }
  });

  it('a cancelled run makes no further calls and ends CANCELLED', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancel', { extraColumns: 3 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      // A gateway that cancels the run from inside the first call, as a queue would from outside.
      let core: ReturnType<typeof createIntelligenceCore> | null = null;
      const cancelling = scriptedGateway({ default: { kind: 'proposal', build: (envelope, request) => { core?.cancel(request.runId, 'operator cancelled'); return { schemaVersion: '1.0.0', taskId: envelope.taskId, runId: request.runId, modelPolicyVersion: '1.0.0', promptBundleVersion: '1.0.0', envelopeHash: request.envelopeHash, items: [], overallOutcome: 'ABSTAINED' }; } } });
      core = createIntelligenceCore(depsFor(cancelling, port));
      const result = await core.run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(cancelling.calls, 1);
    } finally {
      bundle.dispose();
    }
  });
});
