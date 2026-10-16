/**
 * F02 — logical identity, redelivery, restart and concurrency (canon §76–§79).
 *
 * The run is the host's AuditAttempt within its tenant; time never enters
 * it. The persistence port appends only against the length that was read,
 * so two workers deciding on the same view cannot both get their decision
 * in. A process that dies mid-request leaves a reservation the reopened run
 * keeps as ambiguous, and goes on from the ledger without buying again.
 */
import { RUN_LEDGER_VERSION } from '../src/contracts/versions.js';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceEnvelopeV1 } from '../src/contracts/envelope.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { TERMINAL_RUN_STATES, WORKER_LEASE_MS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { LedgerEvent, PublicLedgerEvent } from '../src/kernel/ledger.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';

const TENANT = { agencyId: 'a', clientId: 'c' };
const IDENTITY = { auditAttemptId: 'attempt-9', projectRevisionHash: 'a'.repeat(64), hashes: { profile: 'b'.repeat(64), candidateSet: 'c'.repeat(64), targetContract: null }, versions: { intelligenceCoreVersion: '0.2.0', promptBundleHash: 'd'.repeat(64) }, tenant: TENANT };
const ENVELOPE = { taskId: 'task_stub', budgetSnapshot: { remainingTasks: 32 } } as unknown as IntelligenceEnvelopeV1;
const key = (taskId: string, attempt = 1): string => RunLedger.idempotencyKey({ taskId, attempt, modelPolicyVersion: '1.0.0', promptBundleVersion: '1.0.0', promptBundleHash: 'd'.repeat(64), envelope: ENVELOPE });
const unit = (taskId: string, invocation = 1): { taskId: string; attempt: number; invocation: number; inputTokens: number; outputTokens: number; idempotencyKey: string } => ({ taskId, attempt: 1, invocation, inputTokens: 1_000, outputTokens: 100, idempotencyKey: key(taskId) });
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof IntelligenceError ? error.code : 'OTHER';
  }
};

describe('F02: identity binding', () => {
  it('the same attempt about the same content is the same run whatever the clock says; the run id carries no time', () => {
    const store = new MemoryLedgerStore();
    const early = new VirtualClock('2026-09-11T00:00:00.000Z');
    const late = new VirtualClock('2026-09-11T01:00:00.000Z');
    const first = RunLedger.create(store, early, IDENTITY);
    const again = RunLedger.create(store, late, IDENTITY);
    assert.equal(again.runId, first.runId);
    // Two independent stores, two different clocks, one identity: one id.
    const elsewhere = RunLedger.create(new MemoryLedgerStore(), late, IDENTITY);
    assert.equal(elsewhere.runId, first.runId);
    assert.equal(RunLedger.runIdFor(IDENTITY.auditAttemptId, TENANT), first.runId);
    const created = store.read(first.runId)[0];
    assert.equal(created?.kind, 'RUN_CREATED');
    if (created?.kind === 'RUN_CREATED') {
      assert.equal(created.auditAttemptId, 'attempt-9');
      assert.deepEqual(created.hashes, IDENTITY.hashes);
      assert.equal(created.versions['promptBundleHash'], 'd'.repeat(64));
      assert.equal(created.versions['runLedgerVersion'], RUN_LEDGER_VERSION);
    }
  });
  it('the same attempt id about other content is an IDENTITY_CONFLICT, whichever field differs, and nothing is written', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const first = RunLedger.create(store, clock, IDENTITY);
    const before = store.read(first.runId).length;
    const variants: { name: string; input: Parameters<typeof RunLedger.create>[2] }[] = [
      { name: 'projectRevisionHash', input: { ...IDENTITY, projectRevisionHash: 'f'.repeat(64) } },
      { name: 'profile hash', input: { ...IDENTITY, hashes: { ...IDENTITY.hashes, profile: 'f'.repeat(64) } } },
      { name: 'target contract hash', input: { ...IDENTITY, hashes: { ...IDENTITY.hashes, targetContract: 'f'.repeat(64) } } },
      { name: 'core version', input: { ...IDENTITY, versions: { ...IDENTITY.versions, intelligenceCoreVersion: '9.9.9' } } },
      { name: 'prompt bundle hash', input: { ...IDENTITY, versions: { ...IDENTITY.versions, promptBundleHash: 'f'.repeat(64) } } },
    ];
    for (const variant of variants) {
      assert.equal(code(() => RunLedger.create(store, clock, variant.input)), 'IDENTITY_CONFLICT', variant.name);
    }
    assert.equal(store.read(first.runId).length, before, 'a conflict appends nothing');
    // A new attempt is explicit: another id, another run, no conflict.
    const next = RunLedger.create(store, clock, { ...IDENTITY, auditAttemptId: 'attempt-10', hashes: { ...IDENTITY.hashes, profile: 'f'.repeat(64) } });
    assert.notEqual(next.runId, first.runId);
  });
});

describe('F02: the persistence port under two consumers', () => {
  it('duplicate concurrent reserve: A reads, B reads, A appends, B appends → B conflicts and exactly one RESERVED exists', () => {
    const store = new InterleavingLedgerStore();
    const clock = new VirtualClock();
    const workerA = RunLedger.create(store, clock, IDENTITY);
    const workerB = RunLedger.open(store, clock, workerA.runId);
    // B's whole reserve runs after A read and decided, before A's append lands.
    store.schedule(() => workerB.reserve(unit('task_1')));
    assert.equal(code(() => workerA.reserve(unit('task_1'))), 'BUDGET_RESERVATION_CONFLICT');
    const reserved = store.read(workerA.runId).filter((event) => event.kind === 'RESERVED');
    assert.equal(reserved.length, 1);
    assert.deepEqual(store.appends.filter((entry) => entry.kind === 'RESERVED').map((entry) => entry.ok), [true, false]);
  });
  it('two workers, two requests, budget for one: the loser of the append learns it and does not overspend', () => {
    const store = new InterleavingLedgerStore();
    const clock = new VirtualClock();
    const workerA = RunLedger.create(store, clock, IDENTITY);
    const workerB = RunLedger.open(store, clock, workerA.runId);
    // Nearly the whole output budget goes first, one ceiling-sized request at a time; what is left fits one more request, not two.
    let spent = 0;
    for (let index = 0; spent < 131_072 - 200; index += 1) {
      const outputTokens = Math.min(8_192, 131_072 - 200 - spent);
      const bulk = workerA.reserve({ taskId: `task_bulk_${String(index)}`, attempt: 1, invocation: 1, inputTokens: 10, outputTokens, idempotencyKey: key(`task_bulk_${String(index)}`) });
      workerA.commit(bulk.reservationId, { inputTokens: 10, outputTokens, billedButUnusable: false }, null);
      spent += outputTokens;
    }
    assert.equal(workerA.view().budget.remainingOutputTokens, 200);
    const last = (taskId: string): Parameters<RunLedger['reserve']>[0] => ({ taskId, attempt: 1, invocation: 1, inputTokens: 10, outputTokens: 150, idempotencyKey: key(taskId) });
    store.schedule(() => workerB.reserve(last('task_b')));
    assert.equal(code(() => workerA.reserve(last('task_a'))), 'BUDGET_RESERVATION_CONFLICT');
    const view = workerA.view();
    assert.equal(view.reservations.filter((reservation) => reservation.state === 'RESERVED').length, 1);
    assert.ok(view.budget.billedOutputTokens + view.budget.reservedOutputTokens <= 131_072, 'the audit total holds');
  });
  it('cancellation between a worker\'s read and its append: the reservation does not land', () => {
    const store = new InterleavingLedgerStore();
    const clock = new VirtualClock();
    const worker = RunLedger.create(store, clock, IDENTITY);
    const operator = RunLedger.open(store, clock, worker.runId);
    store.schedule(() => operator.cancel('operator'));
    assert.equal(code(() => worker.reserve(unit('task_1'))), 'BUDGET_RESERVATION_CONFLICT');
    assert.equal(worker.view().reservations.length, 0);
    assert.equal(code(() => worker.reserve(unit('task_2'))), 'RUN_CANCELLED');
  });
  it('a late response for a committed reservation is ignored and never counted twice', () => {
    const store = new MemoryLedgerStore();
    const ledger = RunLedger.create(store, new VirtualClock(), IDENTITY);
    const reservation = ledger.reserve(unit('task_1'));
    ledger.commit(reservation.reservationId, { inputTokens: 700, outputTokens: 50, billedButUnusable: false }, { idempotencyKey: key('task_1'), envelopeHash: 'e'.repeat(64), body: { first: true } });
    assert.equal(code(() => ledger.commit(reservation.reservationId, { inputTokens: 700, outputTokens: 50, billedButUnusable: false }, { idempotencyKey: key('task_1'), envelopeHash: 'e'.repeat(64), body: { late: true } })), 'BUDGET_RESERVATION_CONFLICT');
    assert.equal(code(() => ledger.markAmbiguous(reservation.reservationId, 'late timeout')), 'BUDGET_RESERVATION_CONFLICT');
    assert.equal(ledger.view().budget.billedInputTokens, 700);
    assert.deepEqual(ledger.storedResponse(key('task_1'))?.response, { first: true });
  });
  it('crash after RESERVED: on reopen a reservation whose send never started is released as never dispatched, and one whose send started is kept ambiguous at full size and its maximum charge, never released (D3-JRN-1)', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const dying = RunLedger.create(store, clock, IDENTITY);
    const unsent = dying.reserve(unit('task_1'));
    const sent = dying.reserve(unit('task_2'));
    dying.recordAdmission(sent.reservationId, 5_000, 'ADMITTED');
    dying.sendStarted(sent.reservationId);
    // The process dies here. Another process opens the same run.
    const reopened = RunLedger.open(store, clock, dying.runId);
    const outcome = reopened.reopenInFlight('reopened');
    assert.deepEqual(outcome.released.map((entry) => entry.reservationId), [unsent.reservationId], 'no SEND_STARTED: provably never dispatched');
    assert.deepEqual(outcome.ambiguous.map((entry) => entry.reservationId), [sent.reservationId], 'SEND_STARTED and no answer: it may have reached the provider');
    assert.deepEqual(outcome.answered, []);
    const view = reopened.view();
    const stateOf = (reservationId: string): string | undefined => view.reservations.find((entry) => entry.reservationId === reservationId)?.state;
    assert.equal(stateOf(unsent.reservationId), 'RELEASED');
    assert.equal(stateOf(sent.reservationId), 'AMBIGUOUS_BILLED');
    const released = store.read(dying.runId).find((event): event is Extract<LedgerEvent, { kind: 'RELEASED' }> => event.kind === 'RELEASED');
    assert.match(released?.reason ?? '', /never dispatched/u);
    assert.equal(view.budget.ambiguousInputTokens, 1_000);
    assert.equal(view.budget.reservedInputTokens, 1_000, 'the sent one is still counted against the budget; the released one is not');
    assert.equal(view.grant.heldMicros, 5_000, 'and its maximum charge is still held');
    assert.equal(code(() => reopened.release(sent.reservationId, 'free it')), 'BUDGET_RESERVATION_CONFLICT');
    // The requests go on as new invocations; the ambiguous one stays.
    const next = reopened.reserve(unit('task_2', 2));
    assert.equal(next.invocation, 2);
    assert.equal(reopened.view().budget.invocations, 3);
    // A reservation that was never admitted cannot be marked sent.
    assert.equal(code(() => reopened.sendStarted(next.reservationId)), 'BUDGET_EXHAUSTED');
  });
  it('two workers finishing one run keep the first result', () => {
    const store = new MemoryLedgerStore();
    const ledger = RunLedger.create(store, new VirtualClock(), IDENTITY);
    assert.deepEqual(ledger.storeResult({ answer: 1 }), { answer: 1 });
    assert.deepEqual(ledger.storeResult({ answer: 2 }), { answer: 1 });
    assert.equal(store.read(ledger.runId).filter((event) => event.kind === 'RESULT').length, 1);
  });
});

describe('F02: redelivery, restart and resume through the API', () => {
  it('a process that dies between the reservation and the answer: the redelivered attempt resumes, keeps the ambiguous unit, buys only what it lacks, and a third delivery buys nothing', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('crash-resume');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const store = new InterleavingLedgerStore();
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      // The first worker: its gateway answers, and the write of that answer is where the process dies.
      const dying: ModelGateway = { name: 'dying', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { const result = await oracle.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return result; } };
      const input = inputFor('CLEAN_ONLY', profiled, null);
      await assert.rejects(createIntelligenceCore({ ...depsFor(dying, port, clock), ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);
      const afterCrash = RunLedger.open(store, clock, runId).view();
      assert.equal(afterCrash.reservations.filter((reservation) => reservation.state === 'RESERVED').length, 1, 'one reservation left open by the dead process');
      assert.equal(oracle.calls, 1);
      // The queue redelivers the same attempt to a live worker a second later, inside the run's twenty minutes.
      clock.advance(WORKER_LEASE_MS + 1_000);
      const resumed = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(resumed.runId, runId);
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 1, 'the dead process\'s send is kept as ambiguous');
      assert.equal(resumed.resourceEvidence.providerInvocations, oracle.calls, 'every invocation of both processes is in the ledger');
      assert.ok(resumed.resourceEvidence.ambiguousInputTokens > 0);
      assert.equal(resumed.resourceEvidence.billedInputTokens, resumed.runLedger.filter((event) => event.kind === 'COMMITTED').reduce((sum, event) => sum + (event.kind === 'COMMITTED' ? event.usage.inputTokens : 0), 0) + resumed.resourceEvidence.ambiguousInputTokens);
      assert.equal(resumed.runLedger.filter((event) => event.kind === 'RUN_CREATED').length, 1);
      assert.ok(resumed.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'run resumed from the ledger'));
      // A third delivery, an hour later: the stored result, no call.
      const calls = oracle.calls;
      clock.advance(3_600_000);
      const third = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(third.proposalDigest, resumed.proposalDigest);
      assert.equal(oracle.calls, calls);
    } finally {
      bundle.dispose();
    }
  });
  /**
   * A fixture that plans several tasks, run once in rehearsal to learn how
   * many responses a complete run stores, then run by a worker that dies at
   * `dieAt` — after every response is stored (`'after-last-response'`), or
   * between the last reservation and its answer (`'in-last-request'`).
   */
  async function crashedAfterStoring(name: string, dieAt: 'after-last-response' | 'in-last-request'): Promise<{ store: InterleavingLedgerStore; clock: VirtualClock; port: ReturnType<typeof realValidationPort>; input: ReturnType<typeof inputFor>; responses: number; runId: string; dispose: () => void }> {
    const bundle = makeBundle(name, { extraColumns: 4 });
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const store = new InterleavingLedgerStore();
    const clock = new VirtualClock();
    const port = realValidationPort(bundle, profiled.profile, null, { clock });
    const input = inputFor('CLEAN_ONLY', profiled, null);
    const rehearsal = await createIntelligenceCore(depsFor(oracleGateway(), port, clock)).run(input, { ...CONTEXT, auditAttemptId: 'attempt-rehearsal' });
    assert.equal(rehearsal.state, 'PROPOSAL_READY', JSON.stringify(rehearsal.unresolvedItems));
    const responses = rehearsal.resourceEvidence.modelCalls;
    assert.ok(responses >= 3, `the fixture plans ${String(responses)} calls; the property needs several`);
    const oracle = oracleGateway();
    const dying: ModelGateway = {
      name: 'dying',
      evidenceClass: 'SIMULATED',
      async analyze(request: GatewayRequest): Promise<GatewayResult> {
        const result = await oracle.analyze(request);
        // The last response: either the write of the answer is where the process dies, or every answer lands and the next state write is.
        if (oracle.calls === responses) {
          if (dieAt === 'in-last-request') store.schedule(() => { throw new ProcessDied(); });
          else store.scheduleBefore('STATE', () => { throw new ProcessDied(); });
        }
        return result;
      },
    };
    await assert.rejects(createIntelligenceCore({ ...depsFor(dying, port, clock), ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
    assert.equal(oracle.calls, responses);
    return { store, clock, port, input, responses, runId: RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant), dispose: () => bundle.dispose() };
  }
  const outcomesOf = (events: readonly (LedgerEvent | PublicLedgerEvent)[]): Extract<LedgerEvent, { kind: 'TASK_OUTCOME' }>[] => events.filter((event): event is Extract<LedgerEvent, { kind: 'TASK_OUTCOME' }> => event.kind === 'TASK_OUTCOME');

  it('a process that dies with every response stored: the redelivered attempt reuses all of them — zero invocations — a second later, and an hour later answers with the same digest', { timeout: 120_000 }, async () => {
    const crashed = await crashedAfterStoring('resume-all-stored', 'after-last-response');
    try {
      const { store, clock, port, input, responses, runId } = crashed;
      const afterCrash = RunLedger.open(store, clock, runId).view();
      assert.equal(afterCrash.state, 'RUNNING', 'the process died before the run left the task loop');
      assert.equal(afterCrash.budget.responses, responses, 'every response is in the ledger');
      assert.equal(afterCrash.reservations.filter((reservation) => reservation.state === 'RESERVED').length, 0, 'nothing in flight');
      const sentHashes = new Map(afterCrash.taskOutcomes.map((outcome) => [outcome.taskId, outcome.envelopeHash]));
      // Redelivered once the dead process's lease has lapsed. The dead process spent tokens and tasks, so every envelope this worker rebuilds carries another budget snapshot and hashes differently; the responses must be found all the same.
      clock.advance(WORKER_LEASE_MS + 1_000);
      const second = oracleGateway();
      const validations = port.calls;
      const resumed = await createIntelligenceCore({ ...depsFor(second, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(second.calls, 0, 'not one invocation: every response came from the ledger');
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.draft.status, 'SYSTEM_DRAFT');
      assert.equal(resumed.resourceEvidence.providerInvocations, responses, 'the cost is what the dead process spent, nothing more');
      assert.equal(resumed.resourceEvidence.modelCalls, responses);
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 0);
      assert.equal(port.calls, validations + 1, 'validation had not happened; it happens once now');
      const reused = resumed.runLedger.filter((event): event is Extract<LedgerEvent, { kind: 'NOTE' }> => event.kind === 'NOTE' && event.note === 'response reused from the ledger');
      assert.equal(reused.length, responses);
      assert.ok(reused.some((event) => event.counters['rebuiltHashDiffers'] === 1), 'the rebuilt envelopes do hash differently from the ones sent; the key does not read the hash');
      // Every task compiled against the hash of the envelope that was actually sent — the one its proposal names — and no outcome was recorded twice.
      for (const task of resumed.tasks) if (sentHashes.has(task.taskId)) assert.equal(task.envelopeHash, sentHashes.get(task.taskId), task.taskId);
      assert.equal(outcomesOf(resumed.runLedger).length, afterCrash.taskOutcomes.length, 'the resumed run reached the same outcomes and did not record them again');
      assert.equal(resumed.runLedger.filter((event) => event.kind === 'RESPONSE_STORED').length, responses);
      // An hour later: the stored result, the same digest, still no call.
      clock.advance(3_600_000);
      const third = oracleGateway();
      const later = await createIntelligenceCore({ ...depsFor(third, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(third.calls, 0);
      assert.equal(later.proposalDigest, resumed.proposalDigest);
      assert.equal(later.runId, runId);
      assert.equal(port.calls, validations + 1);
    } finally {
      crashed.dispose();
    }
  });
  it('a process that dies inside the last request with every earlier response stored: the redelivered attempt buys exactly the one it lacks', { timeout: 120_000 }, async () => {
    const crashed = await crashedAfterStoring('resume-all-but-one', 'in-last-request');
    try {
      const { store, clock, port, input, responses, runId } = crashed;
      const afterCrash = RunLedger.open(store, clock, runId).view();
      assert.equal(afterCrash.budget.responses, responses - 1, 'every response but the last is in the ledger');
      assert.equal(afterCrash.reservations.filter((reservation) => reservation.state === 'RESERVED').length, 1, 'the last request is in flight');
      clock.advance(WORKER_LEASE_MS + 1_000);
      const second = oracleGateway();
      const resumed = await createIntelligenceCore({ ...depsFor(second, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(second.calls, 1, 'one invocation: the request whose answer the dead process never wrote');
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 1, 'the dead process\'s send is kept as ambiguous');
      assert.equal(resumed.resourceEvidence.providerInvocations, responses + 1);
      assert.equal(resumed.resourceEvidence.modelCalls, responses);
      const sent = second.requests[0];
      assert.ok(sent !== undefined);
      const bought = afterCrash.reservations.find((reservation) => reservation.state === 'RESERVED');
      assert.equal(sent.envelope.taskId, bought?.taskId, 'the one bought is the one that was in flight');
      assert.equal(resumed.runLedger.filter((event) => event.kind === 'NOTE' && event.note === 'response reused from the ledger').length, responses - 1);
    } finally {
      crashed.dispose();
    }
  });
  it('a crashed run redelivered after its twenty minutes makes no call: the deadline is the run\'s, not the process\'s', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('crash-late');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const store = new InterleavingLedgerStore();
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const dying: ModelGateway = { name: 'dying', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { const result = await oracle.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return result; } };
      const input = inputFor('CLEAN_ONLY', profiled, null);
      await assert.rejects(createIntelligenceCore({ ...depsFor(dying, port, clock), ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      clock.advance(3_600_000);
      const late = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(oracle.calls, 1, 'no new call past the deadline');
      assert.notEqual(late.draft.status, 'SYSTEM_DRAFT');
      assert.ok(late.tasks.some((task) => task.codes.includes('DEADLINE_PASSED')));
      assert.equal(late.resourceEvidence.ambiguousReservations, 1, 'the dead process\'s send is still counted');
    } finally {
      bundle.dispose();
    }
  });
  it('a process that dies before the result is stored leaves no closed run behind: the state is still open, and the redelivery after the lease answers from the stored response without buying (round 4, R2K-01)', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('terminal-no-result');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const port = realValidationPort(bundle, profiled.profile, null);
      const store = new InterleavingLedgerStore();
      const clock = new VirtualClock();
      const gateway = oracleGateway();
      store.scheduleBefore('RESULT', () => { throw new ProcessDied(); });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      await assert.rejects(createIntelligenceCore({ ...depsFor(gateway, port, clock), ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      const calls = gateway.calls;
      // The RESULT precedes the closing transition: a crash before the RESULT is a crash before the run closed, never a terminal state without an answer.
      const log = RunLedger.open(store, clock, RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant)).view();
      assert.ok(!TERMINAL_RUN_STATES.has(log.state), `the run is still open (${log.state}), not closed without an answer`);
      assert.equal(log.state, 'FULL_VALIDATING');
      clock.advance(WORKER_LEASE_MS + 1);
      const answered = await createIntelligenceCore({ ...depsFor(gateway, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(answered.state, 'PROPOSAL_READY', JSON.stringify(answered.unresolvedItems));
      assert.equal(answered.draft.status, 'SYSTEM_DRAFT');
      assert.equal(gateway.calls, calls, 'the stored response is reused; nothing is bought again');
      assert.equal(answered.runLedger.filter((event) => event.kind === 'RESULT').length, 1);
      assert.equal(answered.runLedger.filter((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY').length, 1);
    } finally {
      bundle.dispose();
    }
  });
});
