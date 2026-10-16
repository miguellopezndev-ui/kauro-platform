/**
 * B03 stage 1 — the seams between the four stage-1 mandates, as the
 * integrator of ic/b03-stage-1 found them (closure plan D3-PRIV-1, D3-ID-1,
 * D3-KEY-1, D3-GRANT-1, D3-JRN-1, D3-TIME-1). Each test states one place
 * where two mandates meet and the plan says what must hold there:
 *
 * - B03-KERNEL-BOUNDARY's public projection and B03-KERNEL-JOURNAL's
 *   PREPARED fact: the public result and readRun keep a prepared request's
 *   digests only (D3-PRIV-1 "PREPARED keeps the digest only"); the envelope
 *   is the host's protected record.
 * - B03-KERNEL-BOUNDARY's projection and B03-ACCOUNTING's publish(): a
 *   result published under a state the record closed with from outside (a
 *   cancellation between the RESULT and its closing transition) is the
 *   public projection as well, never the raw log.
 * - B03-KERNEL-BOUNDARY's declared identity and B03-KERNEL-JOURNAL's
 *   tariff: the tariff comes with the dependencies, not the declared input,
 *   so the attempt binds it on RUN_CREATED; the same attempt under another
 *   tariff is IDENTITY_CONFLICT before the stored result and before any
 *   request (D3-ID-1, D3-GRANT-1).
 * - B03-KERNEL-BOUNDARY's absolute window and B03-KERNEL-JOURNAL's
 *   recovery: a run reopened after the audit is over still reconciles the
 *   answer a dead process stored — its usage committed, the grant settled —
 *   before it ends DEADLINE_EXCEEDED with no request and no draft
 *   (D3-TIME-1, D3-JRN-1, D3-GRANT-1).
 *
 * Every case runs the public run() with the real Migration Core in the host's
 * validation port; the model is the labelled oracle gateway, the ledger store
 * and the funded grant are the in-memory fakes (evidence class SIMULATED).
 * Journal facts are read through loose views (a fact is a record with a
 * kind), so the file states the contract without leaning on the types of the
 * build under test.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { ABSOLUTE_WINDOW_MS, WORKER_LEASE_MS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { AppendOutcome, LedgerEvent, LedgerStore } from '../src/kernel/ledger.js';
import { CONTEXT, TEST_TARIFF, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';

/** A journal fact: its kind and whatever it records. */
type Fact = { readonly kind: string; readonly [member: string]: unknown };
const factsOf = (events: readonly unknown[]): readonly Fact[] => events as readonly Fact[];
const ofKind = (events: readonly unknown[], kind: string): Fact[] => factsOf(events).filter((fact) => fact.kind === kind);
const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);

/** A store that runs `action` once, right before the first event `matches` lands. */
function interceptingStore(inner: LedgerStore, matches: (event: LedgerEvent) => boolean, action: () => void): LedgerStore {
  let done = false;
  return {
    append(id: string, event: LedgerEvent, expectedLength: number): AppendOutcome {
      if (!done && matches(event)) {
        done = true;
        action();
      }
      return inner.append(id, event, expectedLength);
    },
    read: (id) => inner.read(id),
    barrier: (id, length, point) => inner.barrier(id, length, point),
  };
}

/** What a public log must never carry: a stored answer's body, or a prepared request's envelope. */
function assertPublic(events: readonly unknown[], where: string): void {
  const stored = ofKind(events, 'RESPONSE_STORED');
  const prepared = ofKind(events, 'PREPARED');
  assert.ok(stored.length > 0 && prepared.length > 0, `${where}: the run sent a request and stored its answer`);
  for (const fact of stored) assert.ok(!('response' in fact), `${where}: a RESPONSE_STORED carries its digest, never the answer`);
  for (const fact of prepared) assert.ok(!('envelope' in fact), `${where}: a PREPARED carries its digests, never the envelope`);
}

describe('B03 stage 1: the seams between the four stage-1 mandates', () => {
  it('PREPARED in the public projection: the result and readRun name each prepared request by its key, envelope hash, request digest and length, never its envelope; the envelope stays in the host\'s protected store', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-stage1-prepared');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const core = createIntelligenceCore(deps);
      const result = await core.run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.ok(oracle.calls >= 1, 'the run sent a request');
      assertPublic(result.runLedger, 'result.runLedger');
      assertPublic(core.readRun(result.runId), 'readRun');
      // The protected record keeps what was prepared, and the public fact is the same request by its digests.
      const kept = ofKind(deps.store.read(result.runId), 'PREPARED');
      const shown = ofKind(result.runLedger, 'PREPARED');
      assert.equal(shown.length, kept.length);
      for (const [index, fact] of kept.entries()) {
        assert.ok(fact['envelope'] !== undefined && fact['envelope'] !== null, 'the host\'s store holds the prepared envelope');
        const published = shown[index];
        for (const member of ['requestKey', 'envelopeHash', 'requestDigest', 'requestBytes', 'maxChargeMicros', 'deadlineAt']) assert.equal(published?.[member], fact[member], `the public PREPARED keeps ${member}`);
      }
    } finally {
      bundle.dispose();
    }
  });

  it('a result published under a state the record closed with from outside — a cancellation between the RESULT and its closing transition — is the public projection too, never the raw log', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-stage1-published-cancel');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const store = interceptingStore(deps.ledgerStore, (event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY', () => { RunLedger.open(deps.ledgerStore, clock, runId).cancel('cancelled under the closing transition'); });
      const core = createIntelligenceCore({ ...deps, ledgerStore: store });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await core.run(input, CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.ok(result.unresolvedItems.some((item) => item.codes.includes('RESULT_NAMED_PROPOSAL_READY')), 'published from the stored result under the recorded state');
      assertPublic(result.runLedger, 'the result published under the recorded state');
      // The redelivery reads the same answer, projected the same way.
      const again = await core.run(input, CONTEXT);
      assert.equal(again.state, 'CANCELLED');
      assertPublic(again.runLedger, 'the redelivery');
    } finally {
      bundle.dispose();
    }
  });

  it('the tariff is bound to the attempt: a finished attempt redelivered under another tariff is IDENTITY_CONFLICT naming hashes.tariff, before the stored result and before any request; the same tariff is answered from the stored result', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-stage1-tariff');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const oracle = oracleGateway();
      const deps = depsFor(oracle, port, clock);
      const first = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(first.state, 'PROPOSAL_READY', JSON.stringify(first.unresolvedItems));
      const sent = oracle.calls;
      const repriced = { ...TEST_TARIFF, outputMicrosPerToken: TEST_TARIFF.outputMicrosPerToken + 1 };
      await assert.rejects(createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: deps.store, tariff: repriced }).run(input, CONTEXT), (error: unknown) => {
        assert.ok(error instanceof IntelligenceError && error.code === 'IDENTITY_CONFLICT', String(error));
        assert.ok((error.details['differing'] as readonly string[]).includes('hashes.tariff'), JSON.stringify(error.details));
        return true;
      });
      assert.equal(oracle.calls, sent, 'no request under the other tariff');
      const again = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: deps.store }).run(input, CONTEXT);
      assert.equal(again.proposalDigest, first.proposalDigest, 'the same tariff is the same attempt, answered from its stored result');
      assert.equal(oracle.calls, sent);
    } finally {
      bundle.dispose();
    }
  });

  it('a run reopened after its absolute deadline with an answer a dead process stored but never billed commits the usage that answer reports and settles the grant before it ends DEADLINE_EXCEEDED, with no request and no draft', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-stage1-expired-recovery');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const oracle = oracleGateway();
      const store = new InterleavingLedgerStore(new MemoryLedgerStore());
      store.scheduleBefore('COMMITTED', () => { throw new ProcessDied(); });
      const dying = depsFor(oracle, port, clock);
      await assert.rejects(createIntelligenceCore({ ...dying, ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      assert.equal(oracle.calls, 1);
      const [stored] = ofKind(store.read(runId), 'RESPONSE_STORED');
      assert.ok(stored !== undefined, 'the answer is on the record');
      assert.equal(ofKind(store.read(runId), 'COMMITTED').length, 0, 'and was never billed');
      const reservationId = String(stored['reservationId']);
      const reported = (stored['response'] as { readonly usage: { readonly inputTokens: number; readonly outputTokens: number } }).usage;
      // The grant the dead process was admitted on; the redelivery is handed the same one, as a host hands the attempt's grant.
      const grant = dying.dispatchAdmission;
      assert.equal(grant.holdOf(reservationId, runId)?.state, 'HELD', 'the dead process left the maximum charge held');
      clock.advance(ABSOLUTE_WINDOW_MS + WORKER_LEASE_MS);
      const expired = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store, dispatchAdmission: grant }).run(input, CONTEXT);
      assert.equal(expired.state, 'DEADLINE_EXCEEDED', JSON.stringify(expired.unresolvedItems));
      assert.equal(expired.draft.status, 'NOT_DRAFTABLE');
      assert.equal(oracle.calls, 1, 'no request after the audit is over');
      const commits = ofKind(expired.runLedger, 'COMMITTED');
      assert.equal(commits.length, 1, 'the stored answer is billed once');
      assert.equal(commits[0]?.['reservationId'], reservationId);
      assert.deepEqual([(commits[0]?.['usage'] as { inputTokens: number }).inputTokens, (commits[0]?.['usage'] as { outputTokens: number }).outputTokens, commits[0]?.['usageKnown']], [reported.inputTokens, reported.outputTokens, true], 'at the usage the stored answer reports');
      const hold = grant.holdOf(reservationId, runId);
      assert.equal(hold?.state, 'COMMITTED', 'the grant is settled, not left holding the maximum charge');
      assert.equal(grant.view().heldMicros, 0);
      assert.equal(expired.resourceEvidence.ambiguousReservations, 0);
    } finally {
      bundle.dispose();
    }
  });
});
