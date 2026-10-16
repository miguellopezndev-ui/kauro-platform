/**
 * F04 — budget per invocation and unknown usage (canon §61, §64–§66).
 *
 * Every call that can reach the provider is reserved first and reconciled
 * against what came back: reported usage is committed, a failure that
 * reports usage is billed and unusable, a failure that reports none is
 * ambiguous and kept at full size, and only the transport's typed proof
 * that nothing left releases anything. The ledger's count is the
 * transport's count, and no response — however malformed — lowers it.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { BUDGET_LIMITS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock, usageIsValid } from '../src/kernel/ledger.js';
import type { LedgerEvent, PublicLedgerEvent } from '../src/kernel/ledger.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';

type Responder = (request: GatewayRequest, oracle: ModelGateway) => Promise<GatewayResult> | GatewayResult;

/** Answers each call from the script in order, then from the oracle; counts every call it saw. */
function sequenceGateway(script: readonly Responder[]): ModelGateway & { calls: number } {
  const oracle = oracleGateway();
  const gateway = {
    name: 'sequence',
    evidenceClass: 'SIMULATED' as const,
    calls: 0,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      const responder = script[gateway.calls];
      gateway.calls += 1;
      return responder === undefined ? oracle.analyze(request) : responder(request, oracle);
    },
  };
  return gateway;
}

const withUsage = async (request: GatewayRequest, oracle: ModelGateway, usage: { inputTokens: number; outputTokens: number } | null): Promise<GatewayResult> => {
  const result = await oracle.analyze(request);
  return result.kind === 'RESPONSE' ? { ...result, usage } : result;
};
const committed = (ledger: readonly (LedgerEvent | PublicLedgerEvent)[]): Extract<LedgerEvent, { kind: 'COMMITTED' }>[] => ledger.filter((event): event is Extract<LedgerEvent, { kind: 'COMMITTED' }> => event.kind === 'COMMITTED');
const reservations = (ledger: readonly (LedgerEvent | PublicLedgerEvent)[]): Extract<LedgerEvent, { kind: 'RESERVED' }>[] => ledger.filter((event): event is Extract<LedgerEvent, { kind: 'RESERVED' }> => event.kind === 'RESERVED');

describe('F04: every invocation reserved and reconciled', () => {
  it('two billed transient failures and a response: three invocations, one model call, every token counted', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('billed-retries');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const retryable: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'synthetic billed transient error', usage: { inputTokens: 100, outputTokens: 10 }, retryAfterMs: 1 });
      const gateway = sequenceGateway([retryable, retryable, (request, oracle) => withUsage(request, oracle, { inputTokens: 1_463, outputTokens: 256 })]);
      const deps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null));
      const result = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.calls, 3);
      assert.equal(result.resourceEvidence.providerInvocations, 3, 'the ledger counts what the transport saw');
      assert.equal(result.resourceEvidence.modelCalls, 1);
      assert.equal(result.resourceEvidence.ambiguousReservations, 0);
      assert.equal(result.resourceEvidence.billedInputTokens, 1_663);
      assert.equal(result.resourceEvidence.billedOutputTokens, 276);
      assert.equal(reservations(result.runLedger).length, 3);
      assert.deepEqual(reservations(result.runLedger).map((event) => event.reservation.invocation), [1, 2, 3]);
      assert.deepEqual(committed(result.runLedger).map((event) => [event.usage.inputTokens, event.usage.outputTokens, event.usage.billedButUnusable, event.usageKnown]), [[100, 10, true, true], [100, 10, true, true], [1_463, 256, false, true]]);
      assert.equal(result.state, 'PROPOSAL_READY');
    } finally {
      bundle.dispose();
    }
  });
  it('a response without usage is billed at the reservation size, never at zero', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('no-usage');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const gateway = sequenceGateway([(request, oracle) => withUsage(request, oracle, null)]);
      const result = await createIntelligenceCore(depsFor(gateway, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      const first = committed(result.runLedger)[0];
      const reserved = reservations(result.runLedger)[0];
      assert.ok(first !== undefined && reserved !== undefined);
      assert.equal(first.usageKnown, false);
      assert.equal(first.usage.inputTokens, reserved.reservation.inputTokens);
      assert.equal(first.usage.outputTokens, BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST);
      assert.ok(result.resourceEvidence.billedInputTokens >= reserved.reservation.inputTokens);
      assert.ok(result.resourceEvidence.billedOutputTokens >= BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST);
      assert.equal(result.resourceEvidence.modelCalls, 1, 'the response itself is usable');
      assert.equal(result.state, 'PROPOSAL_READY');
    } finally {
      bundle.dispose();
    }
  });
  it('usage that is NaN, infinite, negative or fractional is unknown, not a number to bill', { timeout: 60_000 }, async () => {
    assert.equal(usageIsValid({ inputTokens: Number.NaN, outputTokens: 1 }), false);
    assert.equal(usageIsValid({ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 1 }), false);
    assert.equal(usageIsValid({ inputTokens: -1, outputTokens: 1 }), false);
    assert.equal(usageIsValid({ inputTokens: 1.5, outputTokens: 1 }), false);
    assert.equal(usageIsValid({ inputTokens: '10' as unknown as number, outputTokens: 1 }), false);
    assert.equal(usageIsValid(null), false);
    assert.equal(usageIsValid({ inputTokens: 0, outputTokens: 0 }), true);
    const bundle = makeBundle('bad-usage');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const gateway = sequenceGateway([(request, oracle) => withUsage(request, oracle, { inputTokens: Number.NaN, outputTokens: -5 })]);
      const result = await createIntelligenceCore(depsFor(gateway, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      const first = committed(result.runLedger)[0];
      const reserved = reservations(result.runLedger)[0];
      assert.ok(first !== undefined && reserved !== undefined);
      assert.equal(first.usageKnown, false);
      assert.equal(first.usage.inputTokens, reserved.reservation.inputTokens);
      assert.ok(Number.isFinite(result.resourceEvidence.billedInputTokens) && result.resourceEvidence.billedInputTokens > 0);
      assert.ok(Number.isFinite(result.resourceEvidence.billedOutputTokens) && result.resourceEvidence.billedOutputTokens > 0);
    } finally {
      bundle.dispose();
    }
  });
  it('a transient failure without usage and without proof of non-send is ambiguous: kept at full size, retried under a new reservation', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('ambiguous-retry');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      // The message claims it was never sent; a message is not the transport's proof.
      const unproven: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'connection reset before send (probably)', usage: null, retryAfterMs: 1 });
      const gateway = sequenceGateway([unproven]);
      const result = await createIntelligenceCore(depsFor(gateway, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.calls, 2);
      assert.equal(result.resourceEvidence.providerInvocations, 2);
      assert.equal(result.resourceEvidence.ambiguousReservations, 1);
      const states = result.runLedger.filter((event) => event.kind === 'RELEASED');
      assert.equal(states.length, 0, 'nothing was released');
      const first = reservations(result.runLedger)[0];
      assert.ok(first !== undefined);
      assert.equal(result.resourceEvidence.ambiguousInputTokens, first.reservation.inputTokens);
      assert.equal(result.resourceEvidence.ambiguousOutputTokens, BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST);
      assert.ok(result.resourceEvidence.billedInputTokens >= result.resourceEvidence.ambiguousInputTokens + (committed(result.runLedger)[0]?.usage.inputTokens ?? 0));
      assert.equal(result.state, 'PROPOSAL_READY');
    } finally {
      bundle.dispose();
    }
  });
  it('the transport\'s typed proof that the request never left is the one thing that releases a reservation', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('never-sent');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const proven: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'dns failure', usage: null, retryAfterMs: 1, neverSent: true } as GatewayResult);
      const gateway = sequenceGateway([proven]);
      const result = await createIntelligenceCore(depsFor(gateway, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.calls, 2);
      assert.equal(result.resourceEvidence.providerInvocations, 2, 'the attempt that never left is still an invocation on the record');
      assert.equal(result.resourceEvidence.ambiguousReservations, 0);
      assert.equal(result.runLedger.filter((event) => event.kind === 'RELEASED').length, 1);
      assert.equal(result.resourceEvidence.billedInputTokens, committed(result.runLedger).reduce((sum, event) => sum + event.usage.inputTokens, 0));
    } finally {
      bundle.dispose();
    }
  });
  it('a terminal failure that reports usage is billed and unusable; a gateway that throws is ambiguous', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('terminal-billed');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const terminal = sequenceGateway([() => ({ kind: 'TERMINAL_FAILURE', reason: 'wrong model answered', usage: { inputTokens: 900, outputTokens: 0 } })]);
      const failed = await createIntelligenceCore(depsFor(terminal, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(terminal.calls, 1, 'a terminal failure is not retried');
      assert.equal(failed.resourceEvidence.providerInvocations, 1);
      assert.equal(failed.resourceEvidence.modelCalls, 0);
      assert.equal(failed.resourceEvidence.billedInputTokens, 900);
      assert.equal(committed(failed.runLedger)[0]?.usage.billedButUnusable, true);
      assert.notEqual(failed.draft.status, 'SYSTEM_DRAFT');
      const throwing = sequenceGateway([() => { throw new Error('socket exploded'); }]);
      const ambiguous = await createIntelligenceCore(depsFor(throwing, realValidationPort(bundle, profiled.profile, null))).run(inputFor('CLEAN_ONLY', profiled, null), { ...CONTEXT, auditAttemptId: 'attempt-throwing' });
      assert.equal(ambiguous.resourceEvidence.ambiguousReservations, 1);
      assert.equal(ambiguous.resourceEvidence.providerInvocations, 1);
      assert.ok(ambiguous.tasks.some((task) => task.outcome === 'PROVIDER_RETRYABLE_FAILURE'));
    } finally {
      bundle.dispose();
    }
  });
});

describe('F04: bounds before sending, backoff under the deadline', () => {
  it('an estimate above the per-request ceiling is refused, not trimmed to fit', () => {
    const ledger = RunLedger.create(new MemoryLedgerStore(), new VirtualClock(), { auditAttemptId: 'attempt-big', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: CONTEXT.tenant });
    assert.throws(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST + 1, outputTokens: 10, idempotencyKey: 'k' }), /BUDGET_EXHAUSTED/u);
    assert.equal(ledger.view().budget.invocations, 0, 'nothing was reserved, so nothing can be sent');
  });
  it('a Retry-After the deadline cannot hold is refused: no wait, no retry, the failure stands', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('retry-after-late');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const gateway = sequenceGateway([() => ({ kind: 'RETRYABLE_FAILURE', reason: '429', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: 10_000 })]);
      const deps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null));
      const before = deps.clock.nowMs();
      const result = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null, { resourceProfile: { wallClockMs: 5_000 } }), CONTEXT);
      assert.equal(gateway.calls, 1);
      assert.equal(deps.clock.nowMs(), before, 'no wait was taken');
      assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note.startsWith('transport retry refused')));
      assert.ok(result.tasks.some((task) => task.outcome === 'PROVIDER_RETRYABLE_FAILURE'));
      assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
    } finally {
      bundle.dispose();
    }
  });
  it('a Retry-After the deadline can hold is honoured on the injected clock, and never beyond two retries', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('retry-after-ok');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const retryable: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: '503', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: 1_500 });
      const gateway = sequenceGateway([retryable, retryable, retryable, retryable]);
      const deps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null));
      const before = deps.clock.nowMs();
      const result = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.calls, 1 + BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST, 'the bound holds however many failures follow');
      assert.ok(deps.clock.nowMs() - before >= 2 * 1_500, 'the waits happened on the virtual clock');
      assert.equal(result.resourceEvidence.providerInvocations, 3);
      assert.equal(result.resourceEvidence.billedInputTokens, 3);
    } finally {
      bundle.dispose();
    }
  });
  it('cumulative ambiguity exhausts the audit budget explicitly instead of overspending', () => {
    const ledger = RunLedger.create(new MemoryLedgerStore(), new VirtualClock(), { auditAttemptId: 'attempt-exhaust', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: CONTEXT.tenant });
    let refused: string | null = null;
    for (let task = 1; task <= BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT && refused === null; task += 1) {
      for (let invocation = 1; invocation <= 3 && refused === null; invocation += 1) {
        try {
          const reservation = ledger.reserve({ taskId: `task_${String(task)}`, attempt: 1, invocation, inputTokens: 1_000, outputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST, idempotencyKey: `req_${String(task)}` });
          ledger.markAmbiguous(reservation.reservationId, 'timeout');
        } catch (error) {
          refused = error instanceof Error ? error.message : String(error);
        }
      }
    }
    assert.ok(refused !== null && refused.startsWith('BUDGET_EXHAUSTED'), refused ?? 'nothing refused');
    const view = ledger.view();
    assert.ok(view.budget.reservedOutputTokens <= BUDGET_LIMITS.MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT);
    assert.equal(view.budget.remainingOutputTokens, BUDGET_LIMITS.MAX_TOTAL_BILLED_OUTPUT_TOKENS_PER_AUDIT - view.budget.reservedOutputTokens);
  });
});
