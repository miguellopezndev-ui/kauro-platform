/**
 * IC-1 correction, round 2 — the kernel lot.
 *
 * One worker owns an attempt (IC-01c): a lease in the ledger, taken by
 * compare-and-append before any reservation; a second live worker spends
 * nothing and leaves with WORKER_NOT_OWNER; a lapsed lease is taken over
 * and what the dead worker left in flight stays ambiguous. The await on
 * the host's validation is a boundary (IC-02): a cancellation or an absolute
 * deadline that landed while the host validated never becomes a draft, and a
 * terminal state recorded from outside is published, not swallowed. The
 * host's declaration is part of the identity (IC-04). Usage over a ceiling
 * ends the run without a draft (IC-12). A receipt that is not a record is
 * malformed, not a TypeError (IC-03).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { ABSOLUTE_WINDOW_MS, BUDGET_LIMITS, WORKER_LEASE_MS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { LedgerEvent, LedgerStore } from '../src/kernel/ledger.js';
import type { FullDatasetValidationPort, FullDatasetValidationResult } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';

const IDENTITY = { auditAttemptId: 'attempt-lease', projectRevisionHash: 'a'.repeat(64), hashes: { profile: 'b'.repeat(64) }, versions: {}, tenant: CONTEXT.tenant };
const unit = (): Parameters<RunLedger['reserve']>[0] => ({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 1_000, outputTokens: 100, idempotencyKey: 'k'.repeat(64) });
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof IntelligenceError ? error.code : `not an IntelligenceError: ${String(error)}`;
  }
};
const codesOf = (result: { unresolvedItems: readonly { codes: readonly string[] }[] }): string[] => result.unresolvedItems.flatMap((item) => [...item.codes]);

describe('IC-01c: one worker owns the attempt', () => {
  it('the ledger: a second worker finds the lease in force and neither takes it nor reserves; it takes over once the lease has lapsed, and then the first is the one shut out', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, IDENTITY);
    const b = RunLedger.create(store, clock, IDENTITY);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    assert.deepEqual(a.view().lease, { workerId: 'worker-a', ownerId: a.ownerId, leaseUntil: new Date(clock.nowMs() + WORKER_LEASE_MS).toISOString() });
    assert.equal(code(() => b.acquireLease('worker-b', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER');
    assert.equal(code(() => b.reserve(unit())), 'WORKER_NOT_OWNER');
    assert.equal(b.view().budget.invocations, 0, 'nothing was reserved by the worker shut out');
    // The owner renews and reserves freely.
    clock.advance(WORKER_LEASE_MS - 1);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    const reservation = a.reserve(unit());
    // Admitted and sent: the request may have reached the provider (D3-JRN-1).
    a.recordAdmission(reservation.reservationId, 1_000, 'ADMITTED');
    a.sendStarted(reservation.reservationId);
    assert.equal(a.view().budget.invocations, 1);
    // The lease lapses without renewal: the other worker takes it, and the first may no longer reserve.
    clock.advance(WORKER_LEASE_MS);
    b.acquireLease('worker-b', WORKER_LEASE_MS);
    assert.equal(b.view().lease?.workerId, 'worker-b');
    assert.equal(code(() => a.reserve({ ...unit(), invocation: 2 })), 'WORKER_NOT_OWNER');
    assert.equal(code(() => a.acquireLease('worker-a', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER');
    // What the first left in flight after its send started is the ledger's to keep as ambiguous, not the second's to release.
    assert.deepEqual(b.reopenInFlight('taken over').ambiguous.map((entry) => entry.reservationId), [reservation.reservationId]);
    assert.equal(b.view().reservations.find((entry) => entry.reservationId === reservation.reservationId)?.state, 'AMBIGUOUS_BILLED');
    assert.equal(code(() => a.acquireLease('', WORKER_LEASE_MS)), 'CONTRACT_VIOLATION');
  });
  it('the ledger: a lease acquisition that loses the compare-and-append is not ownership', () => {
    const inner = new MemoryLedgerStore();
    const clock = new VirtualClock();
    let armed = true;
    // Between this worker's read and its write, another worker's lease lands.
    const racing: LedgerStore = {
      append(runId, event, expectedLength) {
        if (event.kind === 'LEASE' && armed) {
          armed = false;
          inner.append(runId, { kind: 'LEASE', at: clock.now(), workerId: 'worker-other', ownerId: 'owner_other', leaseUntil: new Date(clock.nowMs() + WORKER_LEASE_MS).toISOString() }, expectedLength);
        }
        return inner.append(runId, event, expectedLength);
      },
      read: (runId) => inner.read(runId),
      barrier: (runId, length, point) => inner.barrier(runId, length, point),
    };
    const ledger = RunLedger.create(racing, clock, IDENTITY);
    assert.equal(code(() => ledger.acquireLease('worker-me', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER');
    assert.equal(ledger.view().lease?.workerId, 'worker-other');
    assert.equal(code(() => ledger.reserve(unit())), 'WORKER_NOT_OWNER');
    assert.equal(ledger.view().budget.invocations, 0);
  });
  it('two live workers on the same attempt with a request held at the provider: exactly one sends; the other leaves with WORKER_NOT_OWNER and spends nothing', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('two-live');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const oracle = oracleGateway();
      const deps = depsFor(oracle, port, clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
      let firstArrived: () => void = () => undefined;
      const arrived = new Promise<void>((resolveArrived) => { firstArrived = resolveArrived; });
      let sends = 0;
      const holding: ModelGateway = {
        name: 'holding',
        evidenceClass: 'SIMULATED',
        async analyze(request: GatewayRequest): Promise<GatewayResult> {
          sends += 1;
          firstArrived();
          await held;
          return oracle.analyze(request);
        },
      };
      const a = createIntelligenceCore({ ...deps, gateway: holding, workerId: 'worker-a' }).run(input, CONTEXT);
      await arrived;
      const b = createIntelligenceCore({ ...deps, gateway: holding, workerId: 'worker-b' }).run(input, CONTEXT);
      await assert.rejects(b, (error: unknown) => error instanceof IntelligenceError && error.code === 'WORKER_NOT_OWNER');
      assert.equal(sends, 1, 'the second worker sent nothing while the first held the request');
      const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);
      const view = RunLedger.open(deps.ledgerStore, clock, runId).view();
      assert.equal(view.budget.invocations, 1, 'one reservation: the first worker\'s');
      assert.equal(view.lease?.workerId, 'worker-a');
      release();
      const result = await a;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.resourceEvidence.providerInvocations, sends);
      assert.equal(result.runLedger.filter((event) => event.kind === 'RESERVED').length, sends);
    } finally {
      bundle.dispose();
    }
  });
  it('a worker that died with a request in flight: a redelivery inside its lease is refused without a call; one after it takes over, keeps the in-flight send ambiguous and buys only what is missing', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('takeover');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const store = new InterleavingLedgerStore();
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const oracle = oracleGateway();
      const dying: ModelGateway = { name: 'dying', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { const result = await oracle.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return result; } };
      await assert.rejects(createIntelligenceCore({ ...depsFor(dying, port, clock), ledgerStore: store, workerId: 'worker-dead' }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);
      assert.equal(RunLedger.open(store, clock, runId).view().reservations.filter((entry) => entry.state === 'RESERVED').length, 1, 'the dead worker left one request in flight');
      clock.advance(1_000);
      const early = oracleGateway();
      await assert.rejects(createIntelligenceCore({ ...depsFor(early, port, clock), ledgerStore: store, workerId: 'worker-early' }).run(input, CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'WORKER_NOT_OWNER');
      assert.equal(early.calls, 0, 'inside the lease nothing is sent: the dead worker may still be alive for all this one knows');
      const afterEarly = RunLedger.open(store, clock, runId).view();
      assert.equal(afterEarly.reservations.filter((entry) => entry.state === 'RESERVED').length, 1, 'and the in-flight reservation is not touched');
      assert.equal(afterEarly.lease?.workerId, 'worker-dead');
      clock.advance(WORKER_LEASE_MS);
      const late = oracleGateway();
      const resumed = await createIntelligenceCore({ ...depsFor(late, port, clock), ledgerStore: store, workerId: 'worker-late' }).run(input, CONTEXT);
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 1, 'the dead worker\'s send is kept ambiguous');
      assert.equal(late.calls, 1, 'the taker-over buys the one answer the ledger lacks');
      assert.equal(resumed.resourceEvidence.providerInvocations, 2);
      const leases = resumed.runLedger.filter((event): event is Extract<LedgerEvent, { kind: 'LEASE' }> => event.kind === 'LEASE').map((event) => event.workerId);
      assert.deepEqual([...new Set(leases)], ['worker-dead', 'worker-late'], 'the early worker never held the run');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-02: the validation await is a boundary', () => {
  /** Runs the fixture with a validation port that does `during` after the real validation, before returning the receipt. */
  async function validatedWhile(name: string, during: (core: ReturnType<typeof createIntelligenceCore>, clock: VirtualClock) => void): Promise<Awaited<ReturnType<ReturnType<typeof createIntelligenceCore>['run']>>> {
    const bundle = makeBundle(name);
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const real = realValidationPort(bundle, profiled.profile, null, { clock });
      let core!: ReturnType<typeof createIntelligenceCore>;
      const port: FullDatasetValidationPort = { async validate(configuration) { const receipt = await real.validate(configuration); during(core, clock); return receipt; } };
      core = createIntelligenceCore(depsFor(oracleGateway(), port, clock));
      return await core.run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
    } finally {
      bundle.dispose();
    }
  }
  it('a cancellation that lands while the host validates: CANCELLED, NOT_DRAFTABLE, RUN_CANCELLED — never a draft over a cancelled run', { timeout: 60_000 }, async () => {
    const result = await validatedWhile('cancel-in-validation', (core) => core.cancel(RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant), 'cancelled during validation'));
    assert.equal(result.state, 'CANCELLED');
    assert.equal(result.draft.status, 'NOT_DRAFTABLE');
    assert.equal(result.draft.configuration, null);
    assert.ok(codesOf(result).includes('RUN_CANCELLED'), JSON.stringify(codesOf(result)));
    assert.equal(result.memoryCandidates.length, 0);
    assert.equal(result.runLedger.filter((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY').length, 0);
    // Seen at the boundary, not caught at the finish line: the flow never meant PROPOSAL_READY, so the finish had nothing to refuse.
    assert.ok(!result.runLedger.some((event) => event.kind === 'NOTE' && event.note.includes('not applied')), 'the cancellation was read after the await, before any draft was built');
  });
  // Rewritten by B03-KERNEL-BOUNDARY (B03-R3, D3-TIME-1): the round-2 test asserted that the semantic window passing while the host validates ended the run ABSTAINED_MATERIAL. The semantic window gates dispatch only; the absolute window gates promotion.
  it('the absolute deadline that passes while the host validates: DEADLINE_EXCEEDED per the transition table, NOT_DRAFTABLE — never PROPOSAL_READY; the semantic window passing alone still drafts', { timeout: 60_000 }, async () => {
    const result = await validatedWhile('deadline-in-validation', (_core, clock) => clock.advance(ABSOLUTE_WINDOW_MS + 1));
    assert.equal(result.state, 'DEADLINE_EXCEEDED');
    assert.equal(result.draft.status, 'NOT_DRAFTABLE');
    assert.ok(codesOf(result).includes('DEADLINE_EXCEEDED'), JSON.stringify(codesOf(result)));
    assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'absolute deadline passed during validation'));
    assert.equal(result.runLedger.filter((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY').length, 0);
    const semanticOnly = await validatedWhile('semantic-in-validation', (_core, clock) => clock.advance(BUDGET_LIMITS.MAX_INTELLIGENCE_WALL_CLOCK_MS + 1));
    assert.equal(semanticOnly.state, 'PROPOSAL_READY', JSON.stringify(codesOf(semanticOnly)));
    assert.equal(semanticOnly.draft.status, 'SYSTEM_DRAFT');
  });
  it('a validation during which nothing happened still drafts: the boundary refuses only what changed', { timeout: 60_000 }, async () => {
    const result = await validatedWhile('quiet-validation', (_core, clock) => clock.advance(1_000));
    assert.equal(result.state, 'PROPOSAL_READY');
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
  });
  it('a terminal state recorded from outside between the last check and the finish is published as the run\'s state, and the ledger names the state the flow meant to reach', { timeout: 60_000 }, async () => {
    // A provider-failed run is cancelled the instant its COMPILING transition lands: the flow meant FAILED_PROVIDER; the ledger is CANCELLED, the result says CANCELLED, and nothing is swallowed.
    const bundle = makeBundle('cancel-at-finish');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const failing: ModelGateway = { name: 'failing', evidenceClass: 'SIMULATED', analyze: async () => ({ kind: 'TERMINAL_FAILURE', reason: 'synthetic 400', usage: { inputTokens: 10, outputTokens: 0 } }) };
      const deps = depsFor(failing, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);
      let armed = true;
      const store: LedgerStore = {
        append(id, event, expectedLength) {
          const outcome = deps.ledgerStore.append(id, event, expectedLength);
          if (armed && outcome.ok && event.kind === 'STATE' && event.to === 'COMPILING') {
            armed = false;
            RunLedger.open(deps.ledgerStore, clock, runId).cancel('cancelled at the finish line');
          }
          return outcome;
        },
        read: (id) => deps.ledgerStore.read(id),
        barrier: (id, length, point) => deps.ledgerStore.barrier(id, length, point),
      };
      const result = await createIntelligenceCore({ ...deps, ledgerStore: store }).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.ok(codesOf(result).includes('RUN_CANCELLED'), JSON.stringify(codesOf(result)));
      assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'terminal state CANCELLED already recorded; FAILED_PROVIDER not applied'), 'the ledger names what was not applied');
      assert.equal(result.runLedger.filter((event) => event.kind === 'STATE' && event.to === 'FAILED_PROVIDER').length, 0);
      assert.equal(result.runLedger.filter((event) => event.kind === 'RESULT').length, 1);
    } finally {
      bundle.dispose();
    }
  });
  it('three retryable failures end the run FAILED_PROVIDER after at most three invocations, and a redelivery grants no fourth', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('provider-recovery');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const oracle = oracleGateway();
      let failing = true;
      let calls = 0;
      const outage: ModelGateway = { name: 'outage', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { calls += 1; return failing ? { kind: 'RETRYABLE_FAILURE', reason: 'synthetic 503', usage: null, retryAfterMs: 0, neverSent: true } : oracle.analyze(request); } };
      const deps = depsFor(outage, port, clock);
      const first = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(first.state, 'FAILED_PROVIDER');
      assert.equal(first.draft.status, 'NOT_DRAFTABLE');
      assert.equal(calls, 1 + BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST);
      failing = false;
      clock.advance(WORKER_LEASE_MS + 1_000);
      const second = await createIntelligenceCore(deps).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(calls, 1 + BUDGET_LIMITS.MAX_TRANSPORT_RETRIES_PER_REQUEST, 'the redelivery answers from the stored result: no fourth send');
      assert.equal(second.state, 'FAILED_PROVIDER');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-04: the host\'s declaration is part of the identity', () => {
  it('a finished attempt resubmitted with another modelPolicyVersion, mode, declaredObjects or memory snapshot is IDENTITY_CONFLICT before the stored result; the same input is answered from it', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('redelivery-policy');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const core = createIntelligenceCore(depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock));
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const first = await core.run(input, CONTEXT);
      assert.equal(first.state, 'PROPOSAL_READY');
      const calls = oracle.calls;
      const same = await core.run(input, CONTEXT);
      assert.equal(same.proposalDigest, first.proposalDigest);
      assert.equal(oracle.calls, calls);
      const conflicts = [
        { name: 'modelPolicyVersion', changed: { ...input, policyBundle: { ...input.policyBundle, modelPolicyVersion: '999.0.0' } } },
        { name: 'promptBundleVersion', changed: { ...input, policyBundle: { ...input.policyBundle, promptBundleVersion: '999.0.0' } } },
        { name: 'declaredObjects', changed: { ...input, projectRevision: { ...input.projectRevision, declaredObjects: { ...(input.projectRevision.declaredObjects ?? {}), extra: 'CONTACT' as const } } } },
        { name: 'memory snapshot', changed: { ...input, scopedMemorySnapshot: [...input.scopedMemorySnapshot, ...input.scopedMemorySnapshot.slice(0, 1), { ...(input.scopedMemorySnapshot[0] ?? {}) } as (typeof input.scopedMemorySnapshot)[number]] } },
      ];
      for (const entry of conflicts) {
        await assert.rejects(core.run(entry.changed, CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT', entry.name);
      }
      assert.equal(oracle.calls, calls, 'none of the conflicts reached the provider');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-12: usage over a ceiling ends the run without a draft', () => {
  async function reporting(name: string, usage: { inputTokens: number; outputTokens: number }): Promise<Awaited<ReturnType<ReturnType<typeof createIntelligenceCore>['run']>>> {
    const bundle = makeBundle(name);
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const over: ModelGateway = { name: 'over', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { const result = await oracle.analyze(request); return result.kind === 'RESPONSE' ? { ...result, usage } : result; } };
      return await createIntelligenceCore(depsFor(over, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
    } finally {
      bundle.dispose();
    }
  }
  it('a total past the audit ceiling after one committed usage: recorded, counted, BUDGET_EXHAUSTED on the task, no draft', { timeout: 60_000 }, async () => {
    const result = await reporting('over-total', { inputTokens: BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT + 1, outputTokens: 100 });
    assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
    assert.notEqual(result.state, 'PROPOSAL_READY');
    assert.ok(result.tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED'), JSON.stringify(result.tasks));
    assert.equal(result.resourceEvidence.billedInputTokens, BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT + 1, 'what the provider billed is what the ledger holds');
    assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'usage over the ceiling; the run is exhausted' && event.counters['overTotal'] === 1));
    assert.ok(result.runLedger.some((event) => event.kind === 'TASK_OUTCOME' && event.outcome === 'BUDGET_EXHAUSTED'));
  });
  it('a single response above the per-request ceiling is implausible: counted and BUDGET_EXHAUSTED', { timeout: 60_000 }, async () => {
    const result = await reporting('implausible', { inputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST + 1, outputTokens: 10 });
    assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
    assert.ok(result.tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED'));
    assert.equal(result.resourceEvidence.billedInputTokens, BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST + 1);
    assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'usage over the ceiling; the run is exhausted' && event.counters['implausible'] === 1));
  });
  it('usage exactly at the per-request ceiling is a figure, not an excess: the run drafts', { timeout: 60_000 }, async () => {
    const result = await reporting('at-ceiling', { inputTokens: BUDGET_LIMITS.MAX_INPUT_TOKENS_PER_REQUEST, outputTokens: 10 });
    assert.equal(result.state, 'PROPOSAL_READY');
    assert.equal(result.draft.status, 'SYSTEM_DRAFT');
  });
});

describe('IC-03: a receipt that is not a record', () => {
  for (const entry of [{ name: 'null', receipt: null }, { name: 'undefined', receipt: undefined }, { name: 'an array', receipt: [] }, { name: 'a string', receipt: 'ok' }]) {
    it(`${entry.name} → NOT_DRAFTABLE with VALIDATION_RECEIPT_MALFORMED, never a TypeError`, { timeout: 60_000 }, async () => {
      const bundle = makeBundle('receipt-not-a-record');
      try {
        const profiled = profileBundle(bundle, 'CLEAN_ONLY');
        const clock = new VirtualClock();
        const port: FullDatasetValidationPort = { validate: async () => entry.receipt as unknown as FullDatasetValidationResult };
        const result = await createIntelligenceCore(depsFor(oracleGateway(), port, clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
        assert.equal(result.state, 'FAILED_COMPILER');
        assert.equal(result.draft.status, 'NOT_DRAFTABLE');
        assert.equal(result.draft.fullValidation, null, 'a malformed receipt is not carried into the result');
        assert.ok(codesOf(result).includes('VALIDATION_RECEIPT_MALFORMED'), JSON.stringify(codesOf(result)));
      } finally {
        bundle.dispose();
      }
    });
  }
});
