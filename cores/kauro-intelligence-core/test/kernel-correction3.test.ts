/**
 * IC-1 correction, round 3 — the kernel lot.
 *
 * The lease is fenced (IC-01, RK-1 and RK-2 of the round-2 review). The
 * owner of an attempt is one run() invocation, by a token its ledger handle
 * mints and the LEASE event records — never the process, never the core
 * instance — so two invocations of one attempt in one process are two
 * owners and the second is shut out. Every write carries the owner: one
 * from an owner the lease has moved away from is LEDGER_FENCED and appends
 * nothing, so a slow worker taken over never commits its late response
 * beside the takeover's. And a live owner renews the lease on the host's
 * timer while it waits on the provider or on the host's validation, so a
 * call three times the lease is still that owner's call. The resource
 * profile and the categorical summaries are part of the identity (RK-3);
 * exhaustion found after assembly is BUDGET_EXHAUSTED (RK-4); a cancel
 * that lands under the terminal append still leaves a stored RESULT (RK-7).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { ERROR_CODES, IntelligenceError } from '../src/contracts/errors.js';
import { BUDGET_LIMITS, RUN_TRANSITIONS, WORKER_LEASE_MS, WORKER_LEASE_RENEWAL_MS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { LedgerEvent, LedgerStore, PublicLedgerEvent } from '../src/kernel/ledger.js';
import type { CoreDependencies, FullDatasetValidationPort } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';

const IDENTITY = { auditAttemptId: 'attempt-fence', projectRevisionHash: 'a'.repeat(64), hashes: { profile: 'b'.repeat(64) }, versions: {}, tenant: CONTEXT.tenant };
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
const kinds = (events: readonly (LedgerEvent | PublicLedgerEvent)[], kind: LedgerEvent['kind']): number => events.filter((event) => event.kind === kind).length;
const leaseOwners = (events: readonly (LedgerEvent | PublicLedgerEvent)[]): string[] => [...new Set(events.filter((event): event is Extract<LedgerEvent, { kind: 'LEASE' }> => event.kind === 'LEASE').map((event) => event.ownerId))];
const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);

/** A gateway that holds its first request until the test releases it and answers every other one at once. */
function holdingGateway(): { gateway: ModelGateway; arrived: Promise<void>; release: () => void; sends: () => number } {
  const oracle = oracleGateway();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  let firstArrived: () => void = () => undefined;
  const arrived = new Promise<void>((resolveArrived) => { firstArrived = resolveArrived; });
  let sends = 0;
  const gateway: ModelGateway = {
    name: 'holding',
    evidenceClass: 'SIMULATED',
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      sends += 1;
      if (sends === 1) {
        firstArrived();
        await held;
      }
      return oracle.analyze(request);
    },
  };
  return { gateway, arrived, release, sends: () => sends };
}

describe('IC-01 (RK-1): the owner is the invocation, not the process', () => {
  it('the ledger: two handles under one worker id are two owners; the second finds the first\'s lease in force, and the LEASE event names the token it was checked against', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, IDENTITY);
    const b = RunLedger.create(store, clock, IDENTITY);
    assert.notEqual(a.ownerId, b.ownerId, 'a token per handle');
    a.acquireLease('worker-shared', WORKER_LEASE_MS);
    assert.equal(code(() => b.acquireLease('worker-shared', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER', 'the same process name grants nothing');
    assert.equal(code(() => b.reserve(unit())), 'WORKER_NOT_OWNER');
    const lease = store.read(a.runId).find((event): event is Extract<LedgerEvent, { kind: 'LEASE' }> => event.kind === 'LEASE');
    assert.equal(lease?.ownerId, a.ownerId);
    assert.equal(lease?.workerId, 'worker-shared');
    assert.ok(a.holdsLease());
    assert.ok(!b.holdsLease());
    // The owner renews under its own token as often as it likes.
    a.acquireLease('worker-shared', WORKER_LEASE_MS);
    assert.deepEqual(leaseOwners(store.read(a.runId)), [a.ownerId]);
  });
  it('K3: two concurrent run() of one attempt on one core instance — exactly one send, one COMMITTED, one RESULT; the second leaves with WORKER_NOT_OWNER', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('same-instance');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const { gateway, arrived, release, sends } = holdingGateway();
      const core = createIntelligenceCore({ ...depsFor(gateway, port, clock), workerId: 'worker_shared' });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const first = core.run(input, CONTEXT);
      await arrived;
      const second = core.run(input, CONTEXT);
      await assert.rejects(second, (error: unknown) => error instanceof IntelligenceError && error.code === 'WORKER_NOT_OWNER');
      assert.equal(sends(), 1, 'the second invocation sent nothing while the first held the request');
      release();
      const result = await first;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(sends(), 1);
      assert.equal(kinds(result.runLedger, 'COMMITTED'), 1);
      assert.equal(kinds(result.runLedger, 'RESPONSE_STORED'), 1);
      assert.equal(kinds(result.runLedger, 'RESULT'), 1);
      assert.equal(result.resourceEvidence.providerInvocations, 1, 'one reservation, one bill');
      assert.equal(leaseOwners(result.runLedger).length, 1, 'one owner held the attempt from start to finish');
      // A redelivery after the fact is answered from the stored result, not bought again.
      const again = await core.run(input, CONTEXT);
      assert.equal(again.proposalDigest, result.proposalDigest);
      assert.equal(sends(), 1);
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-01 (RK-2a): every write is fenced', () => {
  it('the ledger: a worker whose lease was taken over can neither commit, release, mark, transition, record, note nor store a result — every write LEDGER_FENCED, the log unchanged, the taker\'s result the one kept', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, IDENTITY);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    a.transition('ENVELOPE_VALIDATED', 'planned');
    const reservation = a.reserve(unit());
    // Admitted and sent: the request may have reached the provider (D3-JRN-1).
    a.recordAdmission(reservation.reservationId, 1_000, 'ADMITTED');
    a.sendStarted(reservation.reservationId);
    clock.advance(WORKER_LEASE_MS + 1);
    const b = RunLedger.create(store, clock, IDENTITY);
    b.acquireLease('worker-b', WORKER_LEASE_MS);
    assert.deepEqual(b.reopenInFlight('taken over').ambiguous.map((entry) => entry.reservationId), [reservation.reservationId]);
    const length = store.read(a.runId).length;
    assert.equal(code(() => a.commit(reservation.reservationId, { inputTokens: 10, outputTokens: 10, billedButUnusable: false }, { idempotencyKey: 'k'.repeat(64), envelopeHash: 'h'.repeat(64), body: { late: true } })), 'LEDGER_FENCED');
    assert.equal(code(() => a.release(reservation.reservationId, 'zombie')), 'LEDGER_FENCED');
    assert.equal(code(() => a.markAmbiguous(reservation.reservationId, 'zombie')), 'LEDGER_FENCED');
    assert.equal(code(() => a.transition('EGRESS_APPROVED', 'zombie')), 'LEDGER_FENCED');
    assert.equal(code(() => a.recordTaskOutcome({ taskId: 'task_1', outcome: 'ABSTAINED', attempt: 1, codes: [], envelopeHash: null, proposalDigest: null })), 'LEDGER_FENCED');
    assert.equal(code(() => a.note('zombie')), 'LEDGER_FENCED');
    assert.equal(code(() => a.storeResult({ state: 'ZOMBIE' })), 'LEDGER_FENCED');
    assert.equal(code(() => a.reserve({ ...unit(), invocation: 2 })), 'WORKER_NOT_OWNER');
    assert.equal(code(() => a.acquireLease('worker-a', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER');
    assert.equal(store.read(a.runId).length, length, 'a fenced-out owner appends nothing to a run in progress');
    assert.equal(kinds(store.read(a.runId), 'COMMITTED'), 0);
    assert.equal(a.view().reservations[0]?.state, 'AMBIGUOUS_BILLED', 'what the fenced-out owner left in flight stays ambiguous');
    // The taker finishes; the fenced-out owner's result is not a second answer, and its discard is on the record at the end of the closed log.
    b.transition('CANCELLED', 'ended by the taker');
    assert.deepEqual(b.storeResult({ state: 'TAKER' }), { state: 'TAKER' });
    assert.equal(code(() => a.storeResult({ state: 'ZOMBIE' })), 'LEDGER_FENCED');
    assert.deepEqual(a.storedResult(), { state: 'TAKER' });
    assert.equal(kinds(store.read(a.runId), 'RESULT'), 1);
    const last = store.read(a.runId).at(-1);
    assert.equal(last?.kind, 'NOTE');
    assert.ok(last?.kind === 'NOTE' && last.note.startsWith('late RESULT from a fenced-out owner discarded'), JSON.stringify(last));
    assert.ok(ERROR_CODES.includes('LEDGER_FENCED'));
  });
  it('the ledger: a lease lapsed but not taken over is still its owner\'s — the write lands; the host\'s cancel is never fenced; a write that loses its append to a takeover is named the fence, not a conflict', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, IDENTITY);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    const reservation = a.reserve(unit());
    clock.advance(WORKER_LEASE_MS + 1);
    a.commit(reservation.reservationId, { inputTokens: 10, outputTokens: 10, billedButUnusable: false }, null);
    assert.equal(a.view().reservations[0]?.state, 'COMMITTED', 'nobody took the run: the only account of the send is the owner\'s');
    // Another handle cancels while the owner holds a fresh lease: accepted, and the owner sees it.
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    const host = RunLedger.open(store, clock, a.runId);
    assert.equal(code(() => host.cancel('operator')), null);
    assert.ok(a.view().cancelled);
    // A write that reads the log, then loses the append to a takeover's LEASE: LEDGER_FENCED, not LEDGER_CONFLICT.
    const store2 = new MemoryLedgerStore();
    const clock2 = new VirtualClock();
    let armed = false;
    const racing: LedgerStore = {
      append(id, event, expectedLength) {
        if (armed && event.kind === 'NOTE') {
          armed = false;
          clock2.advance(WORKER_LEASE_MS + 1);
          RunLedger.open(store2, clock2, id).acquireLease('worker-taker', WORKER_LEASE_MS);
        }
        return store2.append(id, event, expectedLength);
      },
      read: (id) => store2.read(id),
      barrier: (id, length, point) => store2.barrier(id, length, point),
    };
    const owner = RunLedger.create(racing, clock2, IDENTITY);
    owner.acquireLease('worker-owner', WORKER_LEASE_MS);
    armed = true;
    assert.equal(code(() => owner.note('late')), 'LEDGER_FENCED');
    assert.equal(kinds(store2.read(owner.runId), 'NOTE'), 0);
  });
  it('K4 without renewal: worker A slow past the lease, B takes over — exactly one COMMITTED and one RESULT; A\'s late response is discarded (LEDGER_FENCED), noted, and reported on the telemetry', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('slow-fenced');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const { gateway, arrived, release } = holdingGateway();
      const telemetry: { kind: string; codes: readonly string[] }[] = [];
      const deps: CoreDependencies = { ...depsFor(gateway, port, clock), telemetry: (event) => { telemetry.push({ kind: event.kind, codes: event.codes }); } };
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const a = createIntelligenceCore({ ...deps, workerId: 'worker_A' }).run(input, CONTEXT);
      await arrived;
      // A's renewal timer never fires (the fixture's ticker is fired by hand): by the run's clock A is indistinguishable from a dead worker.
      clock.advance(WORKER_LEASE_MS + 1);
      const late = oracleGateway();
      const b = await createIntelligenceCore({ ...deps, gateway: late, workerId: 'worker_B' }).run(input, CONTEXT);
      assert.equal(b.state, 'PROPOSAL_READY', JSON.stringify(b.unresolvedItems));
      assert.equal(b.resourceEvidence.ambiguousReservations, 1, 'A\'s send is kept ambiguous, never released');
      release();
      await assert.rejects(a, (error: unknown) => error instanceof IntelligenceError && error.code === 'LEDGER_FENCED');
      const events = deps.ledgerStore.read(runId);
      assert.equal(kinds(events, 'COMMITTED'), 1, 'B\'s response is the only one committed');
      assert.equal(kinds(events, 'RESPONSE_STORED'), 1);
      assert.equal(kinds(events, 'RESULT'), 1);
      assert.equal(RunLedger.open(deps.ledgerStore, clock, runId).view().lease?.workerId, 'worker_B');
      const stored = RunLedger.open(deps.ledgerStore, clock, runId).storedResult() as { proposalDigest: string };
      assert.equal(stored.proposalDigest, b.proposalDigest, 'the stored result is the taker\'s');
      assert.ok(events.some((event) => event.kind === 'NOTE' && event.note.startsWith('late COMMITTED from a fenced-out owner discarded')), 'the discard is on the record');
      assert.ok(telemetry.some((event) => event.kind === 'WRITE_FENCED' && event.codes.includes('LEDGER_FENCED')), JSON.stringify(telemetry));
      assert.equal(kinds(events, 'STATE'), events.filter((event) => event.kind === 'STATE').length);
      assert.ok(!events.some((event) => event.kind === 'STATE' && event.from === 'PROPOSAL_READY'), 'no write of A\'s landed after B finished');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-01 (RK-2b): a live owner renews while it waits', () => {
  it('a provider call three times the lease: the owner renews on the host\'s timer, a redelivery inside the window is WORKER_NOT_OWNER, and the call ends as one send under one owner', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('slow-renewed');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const { gateway, arrived, release, sends } = holdingGateway();
      const deps = depsFor(gateway, port, clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const a = createIntelligenceCore({ ...deps, workerId: 'worker_A' }).run(input, CONTEXT);
      await arrived;
      assert.equal(deps.timer.registered, 1, 'the renewal timer runs for the provider call');
      // Three leases' worth of waiting, the timer firing every renewal interval as a live worker's would.
      deps.timer.advance(3 * WORKER_LEASE_MS);
      const other = oracleGateway();
      await assert.rejects(createIntelligenceCore({ ...deps, gateway: other, workerId: 'worker_B' }).run(input, CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'WORKER_NOT_OWNER');
      assert.equal(other.calls, 0);
      const before = RunLedger.open(deps.ledgerStore, clock, runId).view();
      assert.equal(before.lease?.workerId, 'worker_A');
      assert.ok(Date.parse(before.lease?.leaseUntil ?? '') > clock.nowMs(), 'the lease in force is A\'s, renewed');
      release();
      const result = await a;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(sends(), 1, 'one send for one task, however long it took');
      assert.equal(kinds(result.runLedger, 'COMMITTED'), 1);
      assert.equal(result.resourceEvidence.ambiguousReservations, 0);
      assert.equal(leaseOwners(result.runLedger).length, 1);
      assert.ok(kinds(result.runLedger, 'LEASE') >= (3 * WORKER_LEASE_MS) / WORKER_LEASE_RENEWAL_MS, 'renewed throughout the wait');
      assert.equal(deps.timer.registered, 2, 'and once more for the host\'s validation');
    } finally {
      bundle.dispose();
    }
  });
  it('a host validation longer than the lease is kept as well: the owner renews, the redelivery is refused, the run drafts', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('slow-validation');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const real = realValidationPort(bundle, profiled.profile, null, { clock });
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
      let arrivedAt: () => void = () => undefined;
      const arrived = new Promise<void>((resolveArrived) => { arrivedAt = resolveArrived; });
      const port: FullDatasetValidationPort = { async validate(configuration) { arrivedAt(); await held; return real.validate(configuration); } };
      const oracle = oracleGateway();
      const deps = depsFor(oracle, port, clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const a = createIntelligenceCore({ ...deps, workerId: 'worker_A' }).run(input, CONTEXT);
      await arrived;
      deps.timer.advance(2 * WORKER_LEASE_MS);
      await assert.rejects(createIntelligenceCore({ ...deps, workerId: 'worker_B' }).run(input, CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'WORKER_NOT_OWNER');
      release();
      const result = await a;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      assert.equal(leaseOwners(result.runLedger).length, 1);
    } finally {
      bundle.dispose();
    }
  });
  it('the ledger: a takeover is refused while the holder renewed inside the window, and granted once the renewed lease has lapsed', () => {
    const store = new MemoryLedgerStore();
    const clock = new VirtualClock();
    const a = RunLedger.create(store, clock, IDENTITY);
    const b = RunLedger.create(store, clock, IDENTITY);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    clock.advance(WORKER_LEASE_MS - 1);
    a.acquireLease('worker-a', WORKER_LEASE_MS);
    clock.advance(WORKER_LEASE_MS - 1);
    assert.equal(code(() => b.acquireLease('worker-b', WORKER_LEASE_MS)), 'WORKER_NOT_OWNER', 'past the first lease, inside the renewal');
    assert.equal(code(() => a.reserve(unit())), null);
    clock.advance(1);
    assert.equal(code(() => b.acquireLease('worker-b', WORKER_LEASE_MS)), null);
    assert.equal(code(() => a.reserve({ ...unit(), invocation: 2 })), 'WORKER_NOT_OWNER');
  });
});

describe('IC-04 (RK-3): the resource profile and the summaries are part of the identity', () => {
  it('a finished attempt resubmitted with another wallClockMs or other categorical summaries is IDENTITY_CONFLICT; the same summaries in a new Map are the same attempt', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('identity-resources');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const core = createIntelligenceCore(depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock));
      const locator = profiled.profile.profile.files[0]?.sheets[0]?.columns[0]?.columnLocatorId ?? 'col-0';
      const input = inputFor('CLEAN_ONLY', profiled, null, { resourceProfile: { wallClockMs: 10 * 60_000 }, categoricalSummaries: new Map([[locator, ['Active', 'Inactive']]]) });
      const first = await core.run(input, CONTEXT);
      assert.equal(first.state, 'PROPOSAL_READY', JSON.stringify(first.unresolvedItems));
      const calls = oracle.calls;
      const same = await core.run({ ...input, categoricalSummaries: new Map([[locator, ['Active', 'Inactive']]]) }, CONTEXT);
      assert.equal(same.proposalDigest, first.proposalDigest, 'the same content is the same attempt');
      assert.equal(oracle.calls, calls);
      const conflicts = [
        { name: 'wallClockMs', changed: { ...input, resourceProfile: { wallClockMs: 60_000 } } },
        { name: 'wallClockMs absent', changed: { ...input, resourceProfile: {} } },
        { name: 'summaries values', changed: { ...input, categoricalSummaries: new Map([[locator, ['Active', 'Inactive', 'Lead']]]) } },
        { name: 'summaries absent', changed: (({ categoricalSummaries: omitted, ...rest }) => { void omitted; return rest; })(input) },
      ];
      for (const entry of conflicts) {
        await assert.rejects(core.run(entry.changed, CONTEXT), (error: unknown) => error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT' && (error.details['differing'] as string[]).includes('hashes'), entry.name);
      }
      assert.equal(oracle.calls, calls, 'none of the conflicts reached the provider');
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-02 / IC-12 (RK-4): exhaustion after assembly is BUDGET_EXHAUSTED', () => {
  it('usage past the audit ceiling on the response ends the run BUDGET_EXHAUSTED from COMPILING, not ABSTAINED_MATERIAL; the table allows it', { timeout: 60_000 }, async () => {
    assert.ok(RUN_TRANSITIONS.COMPILING.includes('BUDGET_EXHAUSTED'), 'COMPILING → BUDGET_EXHAUSTED');
    const bundle = makeBundle('exhausted-state');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const over: ModelGateway = { name: 'over', evidenceClass: 'SIMULATED', async analyze(request: GatewayRequest): Promise<GatewayResult> { const result = await oracle.analyze(request); return result.kind === 'RESPONSE' ? { ...result, usage: { inputTokens: BUDGET_LIMITS.MAX_TOTAL_BILLED_INPUT_TOKENS_PER_AUDIT + 1, outputTokens: 10 } } : result; } };
      const result = await createIntelligenceCore(depsFor(over, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.state, 'BUDGET_EXHAUSTED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.ok(result.runLedger.some((event) => event.kind === 'STATE' && event.from === 'COMPILING' && event.to === 'BUDGET_EXHAUSTED'));
      assert.ok(!result.runLedger.some((event) => event.kind === 'STATE' && event.to === 'ABSTAINED_MATERIAL'));
    } finally {
      bundle.dispose();
    }
  });
});

describe('IC-02 (RK-7): a cancel under the terminal append still answers', () => {
  it('a cancellation that lands between the soundness check and the PROPOSAL_READY append: run() resolves CANCELLED, NOT_DRAFTABLE, a RESULT is stored, and the redelivery answers from it', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancel-under-append');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      let armed = true;
      const store: LedgerStore = {
        append(id, event, expectedLength) {
          if (armed && event.kind === 'STATE' && event.to === 'PROPOSAL_READY') {
            armed = false;
            RunLedger.open(deps.ledgerStore, clock, id).cancel('cancelled under the terminal append');
          }
          return deps.ledgerStore.append(id, event, expectedLength);
        },
        read: (id) => deps.ledgerStore.read(id),
        barrier: (id, length, point) => deps.ledgerStore.barrier(id, length, point),
      };
      const core = createIntelligenceCore({ ...deps, ledgerStore: store });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await core.run(input, CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(result.draft.configuration, null);
      assert.ok(codesOf(result).includes('RUN_CANCELLED'), JSON.stringify(codesOf(result)));
      assert.equal(result.memoryCandidates.length, 0);
      assert.equal(kinds(result.runLedger, 'RESULT'), 1, 'the attempt has a stored answer');
      assert.equal(kinds(result.runLedger, 'STATE'), result.runLedger.filter((event) => event.kind === 'STATE').length);
      assert.ok(!result.runLedger.some((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY'));
      assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'terminal state CANCELLED already recorded; PROPOSAL_READY not applied'));
      const calls = oracle.calls;
      const again = await core.run(input, CONTEXT);
      assert.equal(again.state, 'CANCELLED');
      assert.equal(again.proposalDigest, result.proposalDigest);
      assert.equal(oracle.calls, calls, 'the redelivery is answered from the ledger');
    } finally {
      bundle.dispose();
    }
  });
});
