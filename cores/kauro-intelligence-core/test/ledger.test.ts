import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { BUDGET_LIMITS, RUN_STATES, RUN_TRANSITIONS, TERMINAL_RUN_STATES } from '../src/contracts/run.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';

const TENANT = { agencyId: 'a', clientId: 'c' };
const fresh = (clock = new VirtualClock()): { ledger: RunLedger; store: MemoryLedgerStore; clock: VirtualClock } => {
  const store = new MemoryLedgerStore();
  const ledger = RunLedger.create(store, clock, { auditAttemptId: 'attempt-1', projectRevisionHash: 'a'.repeat(64), hashes: { profile: 'b'.repeat(64) }, versions: {}, tenant: TENANT });
  return { ledger, store, clock };
};
/** A stand-in for the envelope: the key reads its content, not its shape. */
const ENVELOPE = { taskId: 'task_stub', exemplars: [], budgetSnapshot: { remainingBilledInputTokens: 1_000 } } as unknown as IntelligenceEnvelopeV1;
const key = (taskId: string, attempt: number): string => RunLedger.idempotencyKey({ taskId, attempt, modelPolicyVersion: '1.0.0', promptBundleVersion: '1.0.0', promptBundleHash: 'd'.repeat(64), envelope: ENVELOPE });
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof IntelligenceError ? error.code : 'OTHER';
  }
};

describe('the run ledger: state machine', () => {
  it('follows the lifecycle and refuses a transition the machine does not have', () => {
    const { ledger } = fresh();
    ledger.transition('ENVELOPE_VALIDATED', 't');
    ledger.transition('EGRESS_APPROVED', 't');
    ledger.transition('RUNNING', 't');
    ledger.transition('COMPILING', 't');
    ledger.transition('FULL_VALIDATING', 't');
    ledger.transition('PROPOSAL_READY', 't');
    assert.equal(ledger.view().state, 'PROPOSAL_READY');
    assert.equal(code(() => ledger.transition('RUNNING', 'again')), 'INVALID_TRANSITION');
    const other = fresh().ledger;
    assert.equal(code(() => other.transition('PROPOSAL_READY', 'skip everything')), 'INVALID_TRANSITION');
    assert.equal(code(() => other.transition('FULL_VALIDATING', 'skip')), 'INVALID_TRANSITION');
  });
  it('a restart rebuilds the same view from the same events', () => {
    const { ledger, store, clock } = fresh();
    ledger.transition('ENVELOPE_VALIDATED', 't');
    ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 1000, outputTokens: 100, idempotencyKey: key('task_1', 1) });
    const reopened = RunLedger.open(store, clock, ledger.runId);
    assert.deepEqual(reopened.view(), ledger.view());
    assert.equal(reopened.view().budget.reservedInputTokens, 1000);
  });
  it('a queue redelivery of the same attempt opens the same run instead of creating a second one, whatever the clock says', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const first = RunLedger.create(store, clock, { auditAttemptId: 'attempt-1', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: TENANT });
    first.transition('ENVELOPE_VALIDATED', 't');
    clock.advance(1_000);
    const again = RunLedger.create(store, clock, { auditAttemptId: 'attempt-1', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: TENANT });
    assert.equal(again.runId, first.runId);
    assert.equal(again.view().state, 'ENVELOPE_VALIDATED');
    assert.equal(store.read(first.runId).filter((event) => event.kind === 'RUN_CREATED').length, 1);
  });
  it('another tenant with the same inputs is another run', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, { auditAttemptId: 'attempt-1', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: TENANT });
    const b = RunLedger.create(store, clock, { auditAttemptId: 'attempt-1', projectRevisionHash: 'a'.repeat(64), hashes: {}, versions: {}, tenant: { agencyId: 'a', clientId: 'other' } });
    assert.notEqual(a.runId, b.runId);
  });
});

describe('the run ledger: budget', () => {
  it('reserves atomically and refuses the per-request ceilings', () => {
    const { ledger } = fresh();
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST + 1, outputTokens: 10, idempotencyKey: key('task_1', 1) })), 'BUDGET_EXHAUSTED');
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: BUDGET_LIMITS.MAX_OUTPUT_TOKENS_PER_REQUEST + 1, idempotencyKey: key('task_1', 1) })), 'BUDGET_EXHAUSTED');
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 3, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 3) })), 'BUDGET_EXHAUSTED');
  });
  it('the thirty-third task is refused; the thirty-second is not', () => {
    const { ledger } = fresh();
    for (let index = 1; index <= BUDGET_LIMITS.MAX_SEMANTIC_TASKS_PER_AUDIT; index += 1) {
      ledger.reserve({ taskId: `task_${String(index)}`, attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key(`task_${String(index)}`, 1) });
    }
    assert.equal(ledger.view().budget.remainingTasks, 0);
    assert.equal(code(() => ledger.reserve({ taskId: 'task_33', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_33', 1) })), 'BUDGET_EXHAUSTED');
    // A repair of an existing task is not a new task.
    ledger.reserve({ taskId: 'task_1', attempt: 2, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 2) });
  });
  it('cumulative billed plus reserved tokens cannot exceed the audit total', () => {
    const { ledger } = fresh();
    const perRequest = BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST;
    let reserved = 0;
    let index = 0;
    while (reserved + perRequest <= BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT) {
      index += 1;
      const reservation = ledger.reserve({ taskId: `task_${String(index)}`, attempt: 1, invocation: 1, inputTokens: perRequest, outputTokens: 10, idempotencyKey: key(`task_${String(index)}`, 1) });
      ledger.commit(reservation.reservationId, { inputTokens: perRequest, outputTokens: 10, billedButUnusable: false }, null);
      reserved += perRequest;
    }
    assert.equal(code(() => ledger.reserve({ taskId: 'task_more', attempt: 1, invocation: 1, inputTokens: perRequest, outputTokens: 10, idempotencyKey: key('task_more', 1) })), 'BUDGET_EXHAUSTED');
  });
  it('two workers cannot spend the same reservation: the second reserve under one key conflicts', () => {
    const { ledger } = fresh();
    ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) })), 'BUDGET_RESERVATION_CONFLICT');
  });
  it('a billable unit is reserved once for good: after its commit, a stale worker asking for the same invocation again conflicts', () => {
    const { ledger } = fresh();
    const first = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    ledger.commit(first.reservationId, { inputTokens: 10, outputTokens: 5, billedButUnusable: false }, null);
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) })), 'BUDGET_RESERVATION_CONFLICT');
    // The next invocation of the same request is a new unit and is allowed.
    const second = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 2, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    assert.equal(second.invocation, 2);
    assert.equal(ledger.invocationsOf(key('task_1', 1)), 2);
  });
  it('a request reaches the provider at most three times: the initial send plus two transport retries', () => {
    const { ledger } = fresh();
    for (let invocation = 1; invocation <= BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST + 1; invocation += 1) {
      const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
      ledger.markAmbiguous(reservation.reservationId, 'timeout');
    }
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 4, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) })), 'BUDGET_EXHAUSTED');
    // An invocation cannot be reserved while the previous one of the same request is still open.
    const other = ledger.reserve({ taskId: 'task_2', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_2', 1) });
    assert.equal(code(() => ledger.reserve({ taskId: 'task_2', attempt: 1, invocation: 2, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_2', 1) })), 'BUDGET_RESERVATION_CONFLICT');
    ledger.release(other.reservationId, 'never sent');
  });
  it('an ambiguous timeout is not free: the reservation stays counted and cannot be released', () => {
    const { ledger } = fresh();
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 5000, outputTokens: 100, idempotencyKey: key('task_1', 1) });
    ledger.markAmbiguous(reservation.reservationId, 'timeout after send');
    const view = ledger.view();
    assert.equal(view.budget.reservedInputTokens, 5000);
    assert.equal(view.reservations[0]?.state, 'AMBIGUOUS_BILLED');
    assert.equal(code(() => ledger.release(reservation.reservationId, 'oops')), 'BUDGET_RESERVATION_CONFLICT');
  });
  it('a refusal answered with HTTP 200 is billed', () => {
    const { ledger } = fresh();
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 5000, outputTokens: 100, idempotencyKey: key('task_1', 1) });
    ledger.commit(reservation.reservationId, { inputTokens: 4000, outputTokens: 20, billedButUnusable: true }, null);
    assert.equal(ledger.view().budget.billedInputTokens, 4000);
  });
  it('a stored response is found under its key with the envelope hash it answered, and nothing is reserved again', () => {
    const { ledger } = fresh();
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    ledger.commit(reservation.reservationId, { inputTokens: 10, outputTokens: 5, billedButUnusable: false }, { idempotencyKey: key('task_1', 1), envelopeHash: 'e'.repeat(64), body: { content: 'x' } });
    assert.deepEqual(ledger.storedResponse(key('task_1', 1)), { response: { content: 'x' }, envelopeHash: 'e'.repeat(64), reservationId: reservation.reservationId });
    assert.equal(ledger.storedResponse(key('task_1', 2)), undefined);
  });
  it('the request key reads what the envelope asks, not what was left to spend when it was built', () => {
    const parts = { taskId: 'task_1', attempt: 1, modelPolicyVersion: '1.0.0', promptBundleVersion: '1.0.0', promptBundleHash: 'd'.repeat(64) };
    const budget = { maxInputTokens: 200_000, maxOutputTokens: 8_192, remainingBilledInputTokens: 1_900_000, remainingBilledOutputTokens: 120_000, remainingTasks: 30, deadlineAt: '2026-09-11T00:20:00.000Z' };
    const envelope = { taskId: 'task_1', taskType: 'FIELD_MAPPING', exemplars: [{ ref: 'x' }], repairContext: null, budgetSnapshot: budget } as unknown as IntelligenceEnvelopeV1;
    const later = { ...envelope, budgetSnapshot: { ...budget, remainingBilledInputTokens: 1_200_000, remainingBilledOutputTokens: 90_000, remainingTasks: 19 } };
    const same = RunLedger.idempotencyKey({ ...parts, envelope });
    assert.equal(RunLedger.idempotencyKey({ ...parts, envelope: later }), same, 'eleven answers later, the same request has the same key');
    // Anything that changes the request changes the key.
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, envelope: { ...envelope, exemplars: [] } }), same, 'other exemplars');
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, envelope: { ...envelope, repairContext: { previousProposalDigest: 'f'.repeat(64), validationCodes: [], allowedValues: [], allowedTargetRefs: [] } } }), same, 'a repair context');
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, attempt: 2, envelope }), same, 'another attempt');
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, taskId: 'task_2', envelope: { ...envelope, taskId: 'task_2' } }), same, 'another task');
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, promptBundleHash: 'f'.repeat(64), envelope }), same, 'another prompt bundle');
    assert.notEqual(RunLedger.idempotencyKey({ ...parts, modelPolicyVersion: '2.0.0', envelope }), same, 'another policy');
    assert.deepEqual(Object.keys(RunLedger.semanticEnvelope(envelope)).includes('budgetSnapshot'), false);
  });
});

describe('the run ledger: the transition table', () => {
  it('names an exit for every cause a run can end by, and none out of a terminal state', () => {
    for (const state of RUN_STATES) assert.ok(Array.isArray(RUN_TRANSITIONS[state]), state);
    for (const state of TERMINAL_RUN_STATES) assert.deepEqual(RUN_TRANSITIONS[state], [], `${state} is terminal`);
    // A task the provider failed is read after assembly, from COMPILING: the state that names the cause must be reachable from there.
    assert.ok(RUN_TRANSITIONS.COMPILING.includes('FAILED_PROVIDER'), 'COMPILING → FAILED_PROVIDER');
    assert.ok(RUN_TRANSITIONS.RUNNING.includes('FAILED_PROVIDER'), 'RUNNING → FAILED_PROVIDER');
    assert.ok(RUN_TRANSITIONS.COMPILING.includes('FAILED_COMPILER'), 'COMPILING → FAILED_COMPILER');
    assert.ok(!RUN_TRANSITIONS.CREATED.includes('FAILED_PROVIDER'), 'nothing was sent from CREATED');
    assert.ok(!RUN_TRANSITIONS.CREATED.includes('PROPOSAL_READY'));
    const { ledger } = fresh();
    ledger.transition('ENVELOPE_VALIDATED', 't');
    ledger.transition('EGRESS_APPROVED', 't');
    ledger.transition('RUNNING', 't');
    ledger.transition('COMPILING', 't');
    ledger.transition('FAILED_PROVIDER', 'a task the provider failed');
    assert.equal(ledger.view().state, 'FAILED_PROVIDER');
    assert.equal(code(() => ledger.transition('FULL_VALIDATING', 'again')), 'INVALID_TRANSITION');
  });
});

describe('the run ledger: cancellation and deadline', () => {
  it('after cancel, nothing new is reserved and a late response is not promoted', () => {
    const { ledger } = fresh();
    ledger.transition('ENVELOPE_VALIDATED', 't');
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    ledger.cancel('operator');
    assert.equal(ledger.view().state, 'CANCELLED');
    assert.equal(code(() => ledger.reserve({ taskId: 'task_2', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_2', 1) })), 'RUN_CANCELLED');
    // The in-flight call may finish and its cost is recorded, but the run stays cancelled.
    ledger.commit(reservation.reservationId, { inputTokens: 10, outputTokens: 5, billedButUnusable: true }, null);
    assert.equal(ledger.view().state, 'CANCELLED');
    assert.equal(code(() => ledger.transition('COMPILING', 'late')), 'INVALID_TRANSITION');
  });
  it('twenty virtual minutes exhaust the wall clock without waiting', () => {
    const clock = new VirtualClock();
    const { ledger } = fresh(clock);
    assert.equal(ledger.deadlinePassed(), false);
    clock.advance(BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS - 1);
    assert.equal(ledger.deadlinePassed(), false);
    clock.advance(1);
    assert.equal(ledger.deadlinePassed(), true);
    assert.equal(code(() => ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 10, idempotencyKey: key('task_1', 1) })), 'DEADLINE_PASSED');
  });
  it('a restart does not reset the budget or hide an attempt', () => {
    const { ledger, store, clock } = fresh();
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 100, outputTokens: 10, idempotencyKey: key('task_1', 1) });
    ledger.commit(reservation.reservationId, { inputTokens: 100, outputTokens: 10, billedButUnusable: false }, null);
    ledger.recordTaskOutcome({ taskId: 'task_1', outcome: 'INVALID_SCHEMA', attempt: 1, codes: ['x'], envelopeHash: null, proposalDigest: null });
    const reopened = RunLedger.open(store, clock, ledger.runId);
    assert.equal(reopened.view().budget.billedInputTokens, 100);
    assert.equal(reopened.view().taskOutcomes.length, 1);
  });
});
