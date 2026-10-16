/**
 * B03-KERNEL-JOURNAL — the attempt egress key, the journal facts of one
 * invocation, the durability barrier, the money admission and the fenced
 * owner's reconciliation evidence (closure plan D3-KEY-1, D3-JRN-1,
 * D3-JRN-2, D3-GRANT-1, D3-FENCE-1; review findings B03-R4, B03-R6, B03-R8).
 *
 * Every case goes through the public run() with the real Migration Core in the
 * host's validation port. The model is a labelled fake gateway, the ledger
 * store is in memory, and the funded grant is the in-memory dispatch
 * admission (evidence class SIMULATED): what these tests show is the core's
 * half of each case; the durable journal on PostgreSQL and the CostGrant row
 * lock are the platform's (B08).
 *
 * The journal facts and the grant are read through loose views (a fact is a
 * record with a kind) so that this file states the contract the core must
 * meet without leaning on the types of the build under test.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import * as publicIndex from '../src/index.js';
import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { digestOf } from '../src/contracts/canonical.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { WORKER_LEASE_MS } from '../src/contracts/run.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { AppendOutcome, LedgerEvent, LedgerStore } from '../src/kernel/ledger.js';
import type { CoreDependencies, FullDatasetValidationPort, HostContext } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';

// ------------------------------------------------------------------------------------------------ loose views of the contract

/** A journal fact: its kind and whatever it records. */
type Fact = { readonly kind: string; readonly [member: string]: unknown };
const factsOf = (events: readonly unknown[]): readonly Fact[] => events as readonly Fact[];
const ofKind = (events: readonly unknown[], kind: string): Fact[] => factsOf(events).filter((fact) => fact.kind === kind);
const count = (events: readonly unknown[], kind: string): number => ofKind(events, kind).length;
const at = (events: readonly unknown[], kind: string, predicate: (fact: Fact) => boolean = () => true): number => factsOf(events).findIndex((fact) => fact.kind === kind && predicate(fact));
/** A kind this file names that the build under test may not know yet. */
const kind = (name: string): LedgerEvent['kind'] => name as string as LedgerEvent['kind'];

type AdmissionOutcome = 'ADMITTED' | 'NO_FUNDED_GRANT' | 'FENCED';
interface Hold {
  readonly runId: string;
  readonly reservationId: string;
  readonly maxChargeMicros: number;
  readonly state: 'HELD' | 'AMBIGUOUS' | 'COMMITTED' | 'RELEASED';
  readonly chargeMicros: number | null;
  readonly usage: 'KNOWN' | 'UNKNOWN' | null;
}
interface GrantView {
  readonly fundedMicros: number;
  readonly availableMicros: number;
  readonly heldMicros: number;
  readonly chargedMicros: number;
  readonly liabilityMicros: number;
}
/** The labelled in-memory funded grant: one balance shared by every run that is handed it. */
interface Grant {
  readonly evidenceClass: string;
  readonly admissions: readonly { readonly runId: string; readonly reservationId: string; readonly maxChargeMicros: number; readonly outcome: AdmissionOutcome }[];
  readonly history: readonly GrantView[];
  holdOf(reservationId: string): Hold | undefined;
  view(): GrantView;
}
const GrantClass = (publicIndex as unknown as Record<string, unknown>)['MemoryDispatchAdmission'] as (new (options: { readonly fundedMicros: number }) => Grant) | undefined;
/** A funded grant; on a build without the admission port (B03-R8) an inert stand-in the core never calls, so the run goes ahead and the assertions say what happened. */
function grantOf(fundedMicros: number): Grant {
  if (GrantClass !== undefined) return new GrantClass({ fundedMicros });
  return { evidenceClass: 'NONE', admissions: [], history: [], holdOf: () => undefined, view: () => ({ fundedMicros, availableMicros: fundedMicros, heldMicros: 0, chargedMicros: 0, liabilityMicros: 0 }) };
}
const LARGE_GRANT_MICROS = 1_000_000_000_000;

/** A labelled test tariff: no price of any provider is asserted (plan, open question 3). The allowance is zero so every figure is the tariff's. */
const TARIFF = Object.freeze({ tariffRef: 'TEST_TARIFF_SIMULATED_NOT_A_PRICE', inputMicrosPerToken: 1, outputMicrosPerToken: 5, allowanceMicros: 0 });
const chargeOf = (usage: { readonly inputTokens: number; readonly outputTokens: number }): number => usage.inputTokens * TARIFF.inputMicrosPerToken + usage.outputTokens * TARIFF.outputMicrosPerToken;

/** The host's per-attempt egress key: an id the journal records and a secret it never does. */
const KEY = Object.freeze({ keyId: 'egress-key-attempt-0001', secret: Buffer.alloc(32, 21) });

interface JournalOptions {
  readonly store?: LedgerStore;
  /** null: no egress key at all. */
  readonly key?: { readonly keyId: string; readonly secret: Buffer } | null;
  readonly grant?: Grant;
  readonly workerId?: string;
  /** The model profile's tariff; the labelled test tariff when absent. */
  readonly tariff?: { readonly tariffRef: string; readonly inputMicrosPerToken: number; readonly outputMicrosPerToken: number; readonly allowanceMicros: number };
}

/** The fixture's dependencies as a host of this core hands them: the attempt's egress key, the tariff of its model profile and its dispatch admission — and no core-wide secret. */
function journalDeps(gateway: ModelGateway, port: FullDatasetValidationPort, clock: VirtualClock, options: JournalOptions = {}): CoreDependencies & { readonly timer: ReturnType<typeof depsFor>['timer'] } {
  const fixture = depsFor(gateway, port, clock);
  const deps: Record<string, unknown> = { ...fixture };
  delete deps['egressSecret'];
  delete deps['egressKey'];
  if (options.key !== null) deps['egressKey'] = options.key ?? KEY;
  deps['tariff'] = options.tariff ?? TARIFF;
  deps['dispatchAdmission'] = options.grant ?? grantOf(LARGE_GRANT_MICROS);
  if (options.store !== undefined) deps['ledgerStore'] = options.store;
  if (options.workerId !== undefined) deps['workerId'] = options.workerId;
  return deps as unknown as CoreDependencies & { readonly timer: ReturnType<typeof depsFor>['timer'] };
}

const grantEvidence = (result: IntelligenceResult): Record<string, unknown> => ((result.resourceEvidence as unknown as Record<string, unknown>)['grant'] ?? {}) as Record<string, unknown>;
const codesOf = (result: IntelligenceResult): string[] => [...result.tasks.flatMap((task) => [...task.codes]), ...result.unresolvedItems.flatMap((item) => [...item.codes])];
const isCode = (code: string) => (error: unknown): boolean => error instanceof IntelligenceError && error.code === code;
const runIdOf = (context: HostContext): string => RunLedger.runIdFor(context.auditAttemptId, context.tenant);
const reservationIds = (events: readonly unknown[]): string[] => ofKind(events, 'RESERVED').map((fact) => (fact['reservation'] as { reservationId: string }).reservationId);

/** A gateway that answers through the oracle with the usage the test names (null: none reported). */
function reporting(usage: { readonly inputTokens: number; readonly outputTokens: number } | null, inner: ModelGateway = oracleGateway()): ModelGateway & { readonly requests: GatewayRequest[] } {
  const requests: GatewayRequest[] = [];
  return {
    name: 'reporting',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      const result = await inner.analyze(request);
      return result.kind === 'RESPONSE' ? { ...result, usage } : result;
    },
  };
}

/** A gateway that holds its first request until the test releases it and answers every other one at once. */
function holding(inner: ModelGateway = oracleGateway()): { readonly gateway: ModelGateway & { readonly requests: GatewayRequest[] }; readonly arrived: Promise<void>; release(): void } {
  const requests: GatewayRequest[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  let firstArrived: () => void = () => undefined;
  const arrived = new Promise<void>((resolveArrived) => { firstArrived = resolveArrived; });
  const gateway = {
    name: 'holding',
    evidenceClass: inner.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      if (requests.length === 1) {
        firstArrived();
        await held;
      }
      return inner.analyze(request);
    },
  };
  return { gateway, arrived, release: () => release() };
}

/** Each call answered by the next responder, then by the oracle; every request recorded. */
function sequence(script: readonly ((request: GatewayRequest) => GatewayResult)[]): ModelGateway & { readonly requests: GatewayRequest[] } {
  const oracle = oracleGateway();
  const requests: GatewayRequest[] = [];
  return {
    name: 'sequence',
    evidenceClass: oracle.evidenceClass,
    requests,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      requests.push(request);
      const responder = script[requests.length - 1];
      return responder === undefined ? oracle.analyze(request) : responder(request);
    },
  };
}

type BarrierPoint = 'BEFORE_DISPATCH' | 'AFTER_RESPONSE' | 'BEFORE_VALIDATION' | 'AFTER_RESULT';
type BarrierOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** A memory store whose durability barrier the test decides: the platform's buffering adapter flushes there under the step fence (D3-JRN-2, D8-PORT-3). */
class BarrierStore implements LedgerStore {
  readonly inner = new MemoryLedgerStore();
  readonly barriers: { readonly runId: string; readonly length: number; readonly point: BarrierPoint }[] = [];
  decide: (point: BarrierPoint, runId: string) => Promise<BarrierOutcome> = async () => ({ ok: true });
  append(runId: string, event: LedgerEvent, expectedLength: number): AppendOutcome {
    return this.inner.append(runId, event, expectedLength);
  }
  read(runId: string): readonly LedgerEvent[] {
    return this.inner.read(runId);
  }
  barrier(runId: string, length: number, point: BarrierPoint): Promise<BarrierOutcome> {
    this.barriers.push({ runId, length, point });
    return this.decide(point, runId);
  }
}

/** The default contacts file plus one open column whose header the envelope must mask under the attempt's egress key (the review's reproduction of B03-R4). */
const MASKED_HEADER_CONTACTS = 'Contact ID,First Name,Last Name,Email,Phone,Status,Pelsira Quontay\n1,Ada,Lovelace,ada@kauro-fixture.test,,Active,x\n2,Grace,Hopper,grace@kauro-fixture.test,,Inactive,y\n3,Alan,Turing,alan@kauro-fixture.test,,Active,x\n';

// ------------------------------------------------------------------------------------------------------------------ IC-01

describe('B03-KERNEL-JOURNAL: the attempt egress key (D3-KEY-1)', () => {
  it('IC-01: a new core instance over the same store and the same attempt egress key answers a masked-header attempt from its stored response with zero provider requests and one RESPONSE_STORED; the same attempt under another key id is IDENTITY_CONFLICT before any request, and a core without an egress key refuses to run', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-ic01', { contacts: MASKED_HEADER_CONTACTS });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      // What an uninterrupted run of this input drafts, under another attempt and its own key.
      const rehearsal = await createIntelligenceCore(journalDeps(oracleGateway(), port, clock, { key: { keyId: 'egress-key-rehearsal', secret: Buffer.alloc(32, 99) } })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-ic01-rehearsal' });
      assert.equal(rehearsal.state, 'PROPOSAL_READY', JSON.stringify(rehearsal.unresolvedItems));
      const store = new InterleavingLedgerStore();
      const first = oracleGateway();
      // The first process stores the answer and dies before its RESULT.
      store.scheduleBefore('RESULT', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore(journalDeps(first, port, clock, { store })).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      assert.equal(first.calls, 1);
      const sent = first.requests[0];
      assert.ok(sent !== undefined && sent.envelope.sourceProfile.fields.some((field) => /^hdr_[a-z]+$/u.test(field.header)), 'the attempt carries a header masked under its key');
      assert.equal(count(store.read(runIdOf(CONTEXT)), 'RESPONSE_STORED'), 1);
      clock.advance(WORKER_LEASE_MS + 1);
      // Another core instance, the same store, the same attempt key: the masked header is the same token, the request key finds the stored answer.
      const second = oracleGateway();
      const resumed = await createIntelligenceCore(journalDeps(second, port, clock, { store })).run(input, CONTEXT);
      assert.equal(second.calls, 0, 'zero provider requests: the stored response answers the attempt');
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(count(resumed.runLedger, 'RESPONSE_STORED'), 1, 'one RESPONSE_STORED across both instances');
      assert.equal(first.calls + second.calls, 1, 'one physical request across both instances');
      assert.equal(digestOf(resumed.draft.configuration), digestOf(rehearsal.draft.configuration), 'the draft is the one an uninterrupted run makes');
      const created = ofKind(resumed.runLedger, 'RUN_CREATED')[0];
      assert.equal(created?.['egressKeyId'], KEY.keyId, 'RUN_CREATED records the attempt key id');
      assert.ok(!JSON.stringify(resumed.runLedger).includes(KEY.secret.toString('hex')) && !JSON.stringify(resumed.runLedger).includes(KEY.secret.toString('base64')), 'never the secret');
      // The same attempt under another key id: refused before any request, nothing written.
      const length = store.read(runIdOf(CONTEXT)).length;
      const rotated = oracleGateway();
      await assert.rejects(createIntelligenceCore(journalDeps(rotated, port, clock, { store, key: { keyId: 'egress-key-rotated', secret: Buffer.alloc(32, 22) } })).run(input, CONTEXT), (error: unknown) => isCode('IDENTITY_CONFLICT')(error) && JSON.stringify((error as IntelligenceError).details).includes('egressKeyId'));
      assert.equal(rotated.calls, 0);
      // The same key id over another secret masks differently all the same: the record's keyed check value tells them apart.
      const resecret = oracleGateway();
      await assert.rejects(createIntelligenceCore(journalDeps(resecret, port, clock, { store, key: { keyId: KEY.keyId, secret: Buffer.alloc(32, 23) } })).run(input, CONTEXT), (error: unknown) => isCode('IDENTITY_CONFLICT')(error) && JSON.stringify((error as IntelligenceError).details).includes('egressKeyCheck'));
      assert.equal(resecret.calls, 0);
      assert.equal(store.read(runIdOf(CONTEXT)).length, length, 'a conflict appends nothing');
      // A core without an egress key does not run at all: no default key, no run, no request.
      const keyless = oracleGateway();
      const unkeyed = { ...CONTEXT, auditAttemptId: 'attempt-ic01-keyless' };
      await assert.rejects(createIntelligenceCore(journalDeps(keyless, port, clock, { store, key: null })).run(input, unkeyed), (error: unknown) => isCode('CONTRACT_VIOLATION')(error) && /egress key/u.test((error as Error).message));
      assert.equal(keyless.calls, 0);
      assert.equal(store.read(runIdOf(unkeyed)).length, 0, 'no run was created without a key');
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------ the journal facts, on recovery

describe('B03-KERNEL-JOURNAL: journal facts and recovery (D3-JRN-1)', () => {
  it('R2-031: a process that dies after RESERVED and before SEND_STARTED is durable recovers under the lease, releases that reservation and its grant hold as never dispatched, and sends the request once', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-r2031');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const grant = grantOf(LARGE_GRANT_MICROS);
      const store = new InterleavingLedgerStore();
      const oracle = oracleGateway();
      store.scheduleBefore(kind('SEND_STARTED'), () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore(journalDeps(oracle, port, clock, { store, grant })).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      const afterCrash = store.read(runIdOf(CONTEXT));
      assert.equal(oracle.calls, 0, 'nothing was dispatched');
      assert.equal(count(afterCrash, 'RESERVED'), 1);
      assert.equal(count(afterCrash, 'SEND_STARTED'), 0);
      const [reservationId] = reservationIds(afterCrash);
      assert.ok(reservationId !== undefined);
      assert.equal(grant.holdOf(reservationId)?.state, 'HELD', 'the dead process was admitted and holds its maximum charge');
      // Inside the dead owner's lease the redelivery is not the owner and sends nothing.
      await assert.rejects(createIntelligenceCore(journalDeps(oracle, port, clock, { store, grant })).run(input, CONTEXT), isCode('WORKER_NOT_OWNER'));
      assert.equal(oracle.calls, 0);
      clock.advance(WORKER_LEASE_MS + 1);
      const resumed = await createIntelligenceCore(journalDeps(oracle, port, clock, { store, grant })).run(input, CONTEXT);
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(oracle.calls, 1, 'the request is sent once');
      const released = ofKind(resumed.runLedger, 'RELEASED').find((fact) => fact['reservationId'] === reservationId);
      assert.ok(released !== undefined, 'the unsent reservation is released');
      assert.match(String(released['reason']), /never dispatched/u);
      assert.equal(count(resumed.runLedger, 'AMBIGUOUS'), 0, 'nothing was sent, so nothing is ambiguous');
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 0);
      assert.equal(grant.holdOf(reservationId)?.state, 'RELEASED', 'and so is its grant hold');
      assert.equal(grant.view().heldMicros, 0, 'no hold is left behind');
      // The one request that went out was admitted, marked sent, answered and billed, in that order.
      const sentId = reservationIds(resumed.runLedger)[1];
      const order = ['RESERVED', 'ADMISSION', 'SEND_STARTED', 'RESPONSE_STORED', 'COMMITTED'].map((name) => at(resumed.runLedger, name, (fact) => (name === 'RESERVED' ? (fact['reservation'] as { reservationId: string }).reservationId : fact['reservationId']) === sentId));
      assert.ok(order.every((position, index) => position >= 0 && (index === 0 || position > (order[index - 1] ?? -1))), `journal order ${JSON.stringify(order)}`);
    } finally {
      bundle.dispose();
    }
  });

  it('R2-032: a process that dies after SEND_STARTED keeps that reservation AMBIGUOUS at its maximum charge, records the provider request id when an answer carried one, and sends again only within the invocation bound and the remaining grant', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-r2032');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      /** One delivery whose process dies after the provider answered and before the answer is on the record. */
      const dieAfterSend = async (store: InterleavingLedgerStore, clock: VirtualClock, grant: Grant, gateway: ModelGateway, context: HostContext): Promise<void> => {
        const dying: ModelGateway = { name: 'dying', evidenceClass: gateway.evidenceClass, async analyze(request) { const answer = await gateway.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return answer; } };
        await assert.rejects(createIntelligenceCore(journalDeps(dying, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { store, grant })).run(input, context), (error: unknown) => error instanceof ProcessDied);
        clock.advance(WORKER_LEASE_MS + 1);
      };
      // (a) The sent reservation is kept AMBIGUOUS at its maximum charge; the retry's answer carries a provider request id, which the journal records.
      {
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const grant = grantOf(LARGE_GRANT_MICROS);
        const oracle = oracleGateway();
        await dieAfterSend(store, clock, grant, oracle, CONTEXT);
        const [sentId] = reservationIds(store.read(runIdOf(CONTEXT)));
        assert.ok(sentId !== undefined);
        assert.equal(count(store.read(runIdOf(CONTEXT)), 'SEND_STARTED'), 1);
        const resumed = await createIntelligenceCore(journalDeps(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { store, grant })).run(input, CONTEXT);
        assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
        assert.equal(oracle.calls, 2, 'one send per delivery');
        assert.ok(ofKind(resumed.runLedger, 'AMBIGUOUS').some((fact) => fact['reservationId'] === sentId), 'the sent reservation is AMBIGUOUS, never released');
        const admitted = grant.admissions.find((entry) => entry.reservationId === sentId);
        assert.ok(admitted !== undefined && admitted.maxChargeMicros > 0, 'the dead process was admitted at a maximum charge');
        assert.equal(grant.holdOf(sentId)?.state, 'AMBIGUOUS');
        assert.equal(grant.view().heldMicros, admitted.maxChargeMicros, 'held at its maximum charge, and nothing else is');
        assert.equal(grantEvidence(resumed)['heldMicros'], admitted.maxChargeMicros, 'the result names the hold');
        // The send again is the prepared request, byte for byte — never a rebuild with the budget snapshot of the moment (D3-JRN-1).
        const [firstSend, resend] = oracle.requests;
        assert.ok(firstSend !== undefined && resend !== undefined);
        assert.equal(resend.envelopeHash, firstSend.envelopeHash, 'the prepared envelope, not a rebuild');
        assert.equal(digestOf(resend.envelope), digestOf(firstSend.envelope));
        const prepared = ofKind(resumed.runLedger, 'PREPARED');
        assert.equal(prepared.length, 1, 'one PREPARED for the request, whichever process sends it');
        assert.equal(prepared[0]?.['envelopeHash'], firstSend.envelopeHash);
        assert.ok(at(resumed.runLedger, 'PREPARED') < at(resumed.runLedger, 'RESERVED'), 'prepared before anything was reserved for it');
        const stored = ofKind(resumed.runLedger, 'RESPONSE_STORED');
        assert.equal(stored.length, 1);
        assert.match(String(stored[0]?.['providerRequestId']), /^msg_oracle_\d+$/u, 'the provider request id the answer carried');
        assert.equal(stored[0]?.['reservationId'], reservationIds(resumed.runLedger)[1], 'the stored response names its reservation');
      }
      // (b) The remaining grant bounds the retry: the dead process's ambiguous hold leaves too little for another maximum charge.
      {
        const probe = grantOf(LARGE_GRANT_MICROS);
        const measured = await createIntelligenceCore(journalDeps(oracleGateway(), realValidationPort(bundle, profiled.profile, null), new VirtualClock(), { grant: probe })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-r2032-measure' });
        assert.equal(measured.state, 'PROPOSAL_READY');
        const maxCharge = probe.admissions[0]?.maxChargeMicros ?? 0;
        assert.ok(maxCharge > 0, 'the maximum charge of one request is known');
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const grant = grantOf(maxCharge + Math.floor(maxCharge / 2));
        const oracle = oracleGateway();
        const context = { ...CONTEXT, auditAttemptId: 'attempt-r2032-grant' };
        await dieAfterSend(store, clock, grant, oracle, context);
        const refused = await createIntelligenceCore(journalDeps(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { store, grant })).run(input, context);
        assert.equal(oracle.calls, 1, 'no second send: the grant cannot hold another maximum charge beside the ambiguous one');
        assert.equal(refused.state, 'BUDGET_EXHAUSTED');
        assert.ok(codesOf(refused).includes('NO_FUNDED_GRANT'), JSON.stringify(codesOf(refused)));
        assert.ok(grant.history.every((entry) => entry.availableMicros >= 0));
      }
      // (c) The invocation bound: three deliveries that each died after sending leave nothing for a fourth.
      {
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const grant = grantOf(LARGE_GRANT_MICROS);
        const oracle = oracleGateway();
        const context = { ...CONTEXT, auditAttemptId: 'attempt-r2032-bound' };
        for (let delivery = 0; delivery < 3; delivery += 1) await dieAfterSend(store, clock, grant, oracle, context);
        assert.equal(oracle.calls, 3);
        const fourth = await createIntelligenceCore(journalDeps(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { store, grant })).run(input, context);
        assert.equal(oracle.calls, 3, 'the initial send and two retries, and no fourth');
        assert.equal(fourth.state, 'BUDGET_EXHAUSTED');
        assert.equal(fourth.resourceEvidence.ambiguousReservations, 3);
        assert.equal(grant.admissions.filter((entry) => entry.runId === runIdOf(context) && entry.outcome === 'ADMITTED').length, 3);
      }
    } finally {
      bundle.dispose();
    }
  });

  it('the provider request id is kept beside the answer only as a token of an id alphabet; one that carries any other text is withheld (R2-028)', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-request-id');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const withRequestId = (requestId: string): ModelGateway => {
        const oracle = oracleGateway();
        return { name: 'request-id', evidenceClass: oracle.evidenceClass, async analyze(request) { const result = await oracle.analyze(request); return result.kind === 'RESPONSE' ? { ...result, providerMeta: { ...result.providerMeta, requestId } } : result; } };
      };
      const recorded = async (requestId: string, attempt: string): Promise<unknown> => {
        const clock = new VirtualClock();
        const result = await createIntelligenceCore(journalDeps(withRequestId(requestId), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, { ...CONTEXT, auditAttemptId: attempt });
        assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
        return ofKind(result.runLedger, 'RESPONSE_STORED')[0]?.['providerRequestId'];
      };
      assert.equal(await recorded('req_01J9Z-4f.a:7', 'attempt-request-id-token'), 'req_01J9Z-4f.a:7', 'a provider id is kept as it came');
      assert.equal(await recorded('Ada Lovelace <ada@kauro-fixture.test> said: {"secret":1}', 'attempt-request-id-text'), null, 'text is not an id: withheld');
      assert.equal(await recorded(`req_${'x'.repeat(200)}`, 'attempt-request-id-long'), null, 'nor is a token longer than any id');
    } finally {
      bundle.dispose();
    }
  });

  it('R2-033: a process that dies between RESPONSE_STORED and COMMITTED recovers with one physical request in total, commits the usage the stored answer reports exactly once, and drafts', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-r2033');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const grant = grantOf(LARGE_GRANT_MICROS);
      const usage = { inputTokens: 1_234, outputTokens: 77 };
      const gateway = reporting(usage);
      const store = new InterleavingLedgerStore();
      store.scheduleBefore('COMMITTED', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant })).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      assert.equal(count(store.read(runIdOf(CONTEXT)), 'RESPONSE_STORED'), 1);
      assert.equal(count(store.read(runIdOf(CONTEXT)), 'COMMITTED'), 0);
      clock.advance(WORKER_LEASE_MS + 1);
      const resumed = await createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant })).run(input, CONTEXT);
      assert.equal(gateway.requests.length, 1, 'one physical request in total');
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.draft.status, 'SYSTEM_DRAFT');
      const commits = ofKind(resumed.runLedger, 'COMMITTED');
      assert.equal(commits.length, 1, 'committed exactly once');
      assert.deepEqual([(commits[0]?.['usage'] as { inputTokens: number }).inputTokens, (commits[0]?.['usage'] as { outputTokens: number }).outputTokens, commits[0]?.['usageKnown']], [usage.inputTokens, usage.outputTokens, true], 'with the usage the stored answer reports');
      assert.equal(commits[0]?.['reservationId'], ofKind(resumed.runLedger, 'RESPONSE_STORED')[0]?.['reservationId'], 'the reservation the stored response names');
      assert.equal(resumed.resourceEvidence.billedInputTokens, usage.inputTokens, 'the reported figure, not the reservation estimate');
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 0, 'reconciled, not left ambiguous');
      const [reservationId] = reservationIds(resumed.runLedger);
      assert.equal(grant.holdOf(reservationId ?? '')?.state, 'COMMITTED');
      assert.equal(grant.holdOf(reservationId ?? '')?.chargeMicros, chargeOf(usage));
      assert.equal(grant.view().heldMicros, 0);
      // Reconciled before it was compiled: the COMMITTED precedes the task outcome drawn from the stored answer.
      assert.ok(at(resumed.runLedger, 'COMMITTED') < at(resumed.runLedger, 'TASK_OUTCOME'));
    } finally {
      bundle.dispose();
    }
  });

  it('R2-033: a process that dies between RESPONSE_STORED and COMMITTED with usage above the audit ceiling recovers with one physical request in total, commits the reported usage and ends BUDGET_EXHAUSTED with no draft', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-r2033-over');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const grant = grantOf(LARGE_GRANT_MICROS);
      const usage = { inputTokens: 2_000_001, outputTokens: 100 };
      // An allowance that covers the reported usage: the answer is stopped by the token ceilings themselves, not by a charge above its reservation.
      const tariff = { ...TARIFF, allowanceMicros: 10_000_000 };
      const gateway = reporting(usage);
      const store = new InterleavingLedgerStore();
      store.scheduleBefore('COMMITTED', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant, tariff })).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      clock.advance(WORKER_LEASE_MS + 1);
      const validations = port.calls;
      const resumed = await createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant, tariff })).run(input, CONTEXT);
      assert.equal(gateway.requests.length, 1, 'one physical request in total');
      assert.equal(resumed.state, 'BUDGET_EXHAUSTED', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.draft.status, 'NOT_DRAFTABLE');
      assert.equal(resumed.draft.configuration, null);
      assert.equal(port.calls, validations, 'nothing was validated: the stored answer never reached the compiler');
      assert.equal(grant.view().liabilityMicros, 0, 'no charge above the reservation: the token ceilings stopped it');
      assert.equal(resumed.resourceEvidence.billedInputTokens, usage.inputTokens, 'the reported usage is counted, not the reservation estimate');
      const commits = ofKind(resumed.runLedger, 'COMMITTED');
      assert.equal(commits.length, 1);
      assert.equal((commits[0]?.['usage'] as { inputTokens: number }).inputTokens, usage.inputTokens);
      assert.ok(resumed.tasks.some((task) => task.outcome === 'BUDGET_EXHAUSTED'));
      assert.ok(!ofKind(resumed.runLedger, 'TASK_OUTCOME').some((fact) => fact['outcome'] === 'PROPOSED'), 'the over-ceiling answer was never compiled into a proposal');
      assert.equal(grant.holdOf(reservationIds(resumed.runLedger)[0] ?? '')?.chargeMicros, chargeOf(usage));
    } finally {
      bundle.dispose();
    }
  });
});

describe('B03-KERNEL-JOURNAL: a recovered answer passes the per-request ceiling before it is compiled (B03-R6)', () => {
  it('a stored answer found unbilled on recovery that reports more than one request may use is billed at that figure and ends BUDGET_EXHAUSTED before it is compiled, though the audit total still has room', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-r2033-implausible');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const grant = grantOf(LARGE_GRANT_MICROS);
      // Above the per-request input ceiling, well under the audit total; an allowance that covers it, so no liability decides the case.
      const usage = { inputTokens: 250_000, outputTokens: 100 };
      const tariff = { ...TARIFF, allowanceMicros: 10_000_000 };
      const gateway = reporting(usage);
      const store = new InterleavingLedgerStore();
      store.scheduleBefore('COMMITTED', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant, tariff })).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      clock.advance(WORKER_LEASE_MS + 1);
      const validations = port.calls;
      const resumed = await createIntelligenceCore(journalDeps(gateway, port, clock, { store, grant, tariff })).run(input, CONTEXT);
      assert.equal(gateway.requests.length, 1, 'one physical request in total');
      assert.equal(resumed.state, 'BUDGET_EXHAUSTED', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.draft.status, 'NOT_DRAFTABLE');
      assert.equal(port.calls, validations, 'never validated: the answer was stopped before the compiler');
      assert.equal(resumed.resourceEvidence.billedInputTokens, usage.inputTokens);
      assert.ok(ofKind(resumed.runLedger, 'NOTE').some((fact) => fact['note'] === 'usage over the ceiling; the run is exhausted' && (fact['counters'] as Record<string, number>)['implausible'] === 1));
      assert.ok(!ofKind(resumed.runLedger, 'TASK_OUTCOME').some((fact) => fact['outcome'] === 'PROPOSED'));
      assert.equal(grant.view().liabilityMicros, 0);
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------ the fence and its evidence

describe('B03-KERNEL-JOURNAL: the barrier and the fenced owner (D3-JRN-2, D3-FENCE-1)', () => {
  it('R2-034: a worker fenced out by a takeover cannot pass the dispatch barrier or store a RESULT; the usage of its late answer settles its own ambiguous reservation as reconciliation evidence and nothing of it is drafted', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-r2034');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      // (a) The dispatch barrier: A has marked its send started and waits on the flush; B takes the attempt over meanwhile. A never dispatches.
      {
        const clock = new VirtualClock();
        const port = realValidationPort(bundle, profiled.profile, null, { clock });
        const store = new BarrierStore();
        const grant = grantOf(LARGE_GRANT_MICROS);
        let flush: (outcome: BarrierOutcome) => void = () => undefined;
        let reached: () => void = () => undefined;
        const aAtBarrier = new Promise<void>((resolveReached) => { reached = resolveReached; });
        let armed = true;
        store.decide = (point) => {
          if (point !== 'BEFORE_DISPATCH' || !armed) return Promise.resolve({ ok: true });
          armed = false;
          reached();
          return new Promise<BarrierOutcome>((resolveFlush) => { flush = resolveFlush; });
        };
        const gatewayA = oracleGateway();
        const a = createIntelligenceCore(journalDeps(gatewayA, port, clock, { store, grant, workerId: 'worker_A' })).run(input, CONTEXT);
        const first = await Promise.race([aAtBarrier.then(() => 'AT_THE_BARRIER'), a.then(() => 'FINISHED', () => 'FAILED')]);
        assert.equal(first, 'AT_THE_BARRIER', `A must wait on the dispatch barrier after its SEND_STARTED; it ${first === 'FINISHED' ? 'dispatched and finished without one' : 'failed before it'} (${String(gatewayA.calls)} requests)`);
        clock.advance(WORKER_LEASE_MS + 1);
        const gatewayB = oracleGateway();
        const b = await createIntelligenceCore(journalDeps(gatewayB, port, clock, { store, grant, workerId: 'worker_B' })).run(input, CONTEXT);
        assert.equal(b.state, 'PROPOSAL_READY', JSON.stringify(b.unresolvedItems));
        flush({ ok: true });
        await assert.rejects(a, isCode('LEDGER_FENCED'));
        assert.equal(gatewayA.calls, 0, 'the fenced worker did not pass the dispatch barrier');
        assert.equal(gatewayB.calls, 1);
        assert.ok(store.barriers.some((entry) => entry.point === 'BEFORE_DISPATCH'));
        // A store that refuses the barrier (the step fence moved under the flush) stops the dispatch just the same.
        const refusing = new BarrierStore();
        refusing.decide = async (point) => (point === 'BEFORE_DISPATCH' ? { ok: false, reason: 'the INTERPRET fence moved' } : { ok: true });
        const gatewayC = oracleGateway();
        await assert.rejects(createIntelligenceCore(journalDeps(gatewayC, port, clock, { store: refusing, grant })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-r2034-refused' }), isCode('LEDGER_FENCED'));
        assert.equal(gatewayC.calls, 0, 'a refused barrier dispatches nothing');
      }
      // (b) The late answer: A is slow past its lease, B takes over and finishes; A's answer then arrives.
      {
        const clock = new VirtualClock();
        const port = realValidationPort(bundle, profiled.profile, null, { clock });
        const store = new BarrierStore();
        const grant = grantOf(LARGE_GRANT_MICROS);
        const lateUsage = { inputTokens: 999, outputTokens: 42 };
        const slow = holding(reporting(lateUsage));
        const a = createIntelligenceCore(journalDeps(slow.gateway, port, clock, { store, grant, workerId: 'worker_A' })).run(input, CONTEXT);
        await slow.arrived;
        clock.advance(WORKER_LEASE_MS + 1);
        const b = await createIntelligenceCore(journalDeps(oracleGateway(), port, clock, { store, grant, workerId: 'worker_B' })).run(input, CONTEXT);
        assert.equal(b.state, 'PROPOSAL_READY', JSON.stringify(b.unresolvedItems));
        const [aReservation, bReservation] = reservationIds(b.runLedger);
        assert.ok(aReservation !== undefined && bReservation !== undefined);
        assert.equal(grant.holdOf(aReservation)?.state, 'AMBIGUOUS', 'A\'s send is ambiguous while its answer is out');
        slow.release();
        await assert.rejects(a, isCode('LEDGER_FENCED'));
        const events = store.read(runIdOf(CONTEXT));
        const evidence = ofKind(events, 'RECONCILIATION_EVIDENCE');
        assert.equal(evidence.length, 1, 'the one append a fenced owner may make');
        assert.equal(evidence[0]?.['reservationId'], aReservation, 'for its own reservation');
        assert.equal((evidence[0]?.['usage'] as { inputTokens: number }).inputTokens, lateUsage.inputTokens);
        assert.ok(!('response' in (evidence[0] ?? {})), 'evidence carries usage and a digest, never the answer');
        assert.equal(typeof evidence[0]?.['responseDigest'], 'string');
        const settled = RunLedger.open(store, clock, runIdOf(CONTEXT)).view().reservations.find((entry) => entry.reservationId === aReservation);
        assert.notEqual(settled?.state, 'AMBIGUOUS_BILLED', 'the evidence settles the ambiguous reservation');
        assert.equal(grant.holdOf(aReservation)?.state, 'COMMITTED');
        assert.equal(grant.holdOf(aReservation)?.chargeMicros, chargeOf(lateUsage), 'at the usage the late answer reports');
        // Nothing of A's answer is drafted or stored: one RESPONSE_STORED (B's), one RESULT (B's), no transition after B's close.
        assert.equal(count(events, 'RESPONSE_STORED'), 1);
        assert.equal(ofKind(events, 'RESPONSE_STORED')[0]?.['reservationId'], bReservation);
        assert.equal(count(events, 'RESULT'), 1);
        assert.equal((RunLedger.open(store, clock, runIdOf(CONTEXT)).storedResult() as { proposalDigest: string }).proposalDigest, b.proposalDigest);
        const closed = at(events, 'STATE', (fact) => fact['to'] === 'PROPOSAL_READY');
        assert.ok(closed > at(events, 'RESULT'), 'B closed the attempt');
        assert.deepEqual(factsOf(events).slice(closed + 1).map((fact) => fact.kind).filter((name) => name !== 'NOTE'), ['RECONCILIATION_EVIDENCE'], 'after B closed the attempt, A appended its evidence and nothing else');
      }
    } finally {
      bundle.dispose();
    }
  });
});

describe('B03-KERNEL-JOURNAL: the grant follows the durable journal (D3-JRN-2, D3-GRANT-1)', () => {
  it('an answer whose AFTER_RESPONSE barrier the store refuses is not settled on the grant: the maximum charge stays held, the run is fenced, and the taker settles it from the journal', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-after-response');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const grant = grantOf(LARGE_GRANT_MICROS);
      const store = new BarrierStore();
      let refuse = true;
      store.decide = async (point) => (point === 'AFTER_RESPONSE' && refuse ? { ok: false, reason: 'the step fence moved under the flush' } : { ok: true });
      const first = oracleGateway();
      await assert.rejects(createIntelligenceCore(journalDeps(first, port, clock, { store, grant })).run(input, CONTEXT), isCode('LEDGER_FENCED'));
      assert.equal(first.calls, 1);
      const [reservationId] = reservationIds(store.read(runIdOf(CONTEXT)));
      assert.ok(reservationId !== undefined);
      assert.equal(grant.holdOf(reservationId)?.state, 'HELD', 'the grant is told nothing the journal has not made durable');
      // The next owner reads what the journal holds — here, the answer the memory store kept — and settles the grant from it.
      refuse = false;
      clock.advance(WORKER_LEASE_MS + 1);
      const second = oracleGateway();
      const resumed = await createIntelligenceCore(journalDeps(second, port, clock, { store, grant })).run(input, CONTEXT);
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(second.calls, 0);
      assert.equal(grant.holdOf(reservationId)?.state, 'COMMITTED');
      assert.equal(grant.view().heldMicros, 0);
    } finally {
      bundle.dispose();
    }
  });
});

// ------------------------------------------------------------------------------------------------ the funded grant

describe('B03-KERNEL-JOURNAL: the dispatch admission (D3-GRANT-1)', () => {
  it('S038: a response lost after a possibly accepted dispatch holds its maximum charge on the grant until reconciled, each retry needs its own admission, no more than three invocations are ever admitted, and the result claims no exactly-once delivery', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-s038');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const lost = (): GatewayResult => ({ kind: 'RETRYABLE_FAILURE', reason: 'connection reset after the request was written', usage: null, retryAfterMs: 1 });
      // A grant with room for everything: three sends, each admitted on its own, each lost and held.
      {
        const clock = new VirtualClock();
        const grant = grantOf(LARGE_GRANT_MICROS);
        const gateway = sequence([lost, lost, lost, lost]);
        const deps = journalDeps(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { grant });
        const result = await createIntelligenceCore(deps).run(input, CONTEXT);
        assert.equal(gateway.requests.length, 3);
        assert.equal(result.state, 'FAILED_PROVIDER');
        const ids = reservationIds(result.runLedger);
        const admitted = grant.admissions.filter((entry) => entry.outcome === 'ADMITTED');
        assert.deepEqual(admitted.map((entry) => entry.reservationId), ids, 'one admission per invocation, for exactly the reservations made');
        for (const id of ids) assert.ok(at(result.runLedger, 'ADMISSION', (fact) => fact['reservationId'] === id) < at(result.runLedger, 'SEND_STARTED', (fact) => fact['reservationId'] === id), 'admitted before its send started');
        for (const id of ids) assert.equal(grant.holdOf(id)?.state, 'AMBIGUOUS', 'each lost send stays held');
        assert.equal(grant.view().heldMicros, admitted.reduce((sum, entry) => sum + entry.maxChargeMicros, 0), 'at its maximum charge');
        assert.equal(result.resourceEvidence.ambiguousReservations, 3);
        assert.equal(grantEvidence(result)['heldMicros'], grant.view().heldMicros, 'the result names the hold');
        assert.equal((result.resourceEvidence as unknown as Record<string, unknown>)['dispatchGuarantee'], 'AT_MOST_ONE_CONCURRENT_DISPATCH');
        assert.ok(!/EXACTLY_ONCE/iu.test(JSON.stringify(result)), 'no exactly-once claim anywhere in the result');
        // A redelivery an hour later: the stored answer, no fourth admission, the holds untouched until someone reconciles them.
        clock.advance(3_600_000);
        const again = await createIntelligenceCore(journalDeps(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { store: deps.ledgerStore, grant })).run(input, CONTEXT);
        assert.equal(again.proposalDigest, result.proposalDigest);
        assert.equal(gateway.requests.length, 3);
        assert.equal(grant.admissions.length, 3, 'no more than three invocations are ever admitted');
        for (const id of ids) assert.equal(grant.holdOf(id)?.state, 'AMBIGUOUS');
      }
      // A grant with room for two maximum charges: the third send needs an admission of its own and does not get one while the two lost ones are held.
      {
        const probe = grantOf(LARGE_GRANT_MICROS);
        await createIntelligenceCore(journalDeps(oracleGateway(), realValidationPort(bundle, profiled.profile, null), new VirtualClock(), { grant: probe })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-s038-measure' });
        const maxCharge = probe.admissions[0]?.maxChargeMicros ?? 0;
        assert.ok(maxCharge > 0);
        const clock = new VirtualClock();
        const grant = grantOf(2 * maxCharge + Math.floor(maxCharge / 2));
        const gateway = sequence([lost, lost, lost]);
        const result = await createIntelligenceCore(journalDeps(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { grant })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-s038-two' });
        assert.equal(gateway.requests.length, 2, 'the third send was not admitted');
        assert.deepEqual(grant.admissions.map((entry) => entry.outcome), ['ADMITTED', 'ADMITTED', 'NO_FUNDED_GRANT']);
        assert.equal(result.state, 'BUDGET_EXHAUSTED');
        assert.ok(codesOf(result).includes('NO_FUNDED_GRANT'));
        assert.ok(grant.history.every((entry) => entry.availableMicros >= 0));
      }
    } finally {
      bundle.dispose();
    }
  });

  it('S041: two attempts sharing one funded grant with money for one request race for it; exactly one is admitted and sends, the other ends BUDGET_EXHAUSTED NO_FUNDED_GRANT with no request, and the grant\'s available balance never goes negative', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-s041');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const probe = grantOf(LARGE_GRANT_MICROS);
      await createIntelligenceCore(journalDeps(oracleGateway(), realValidationPort(bundle, profiled.profile, null), new VirtualClock(), { grant: probe })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-s041-measure' });
      // The maximum charge of one request, as the grant saw it admitted (a nominal figure where no grant was ever asked; asserted below).
      const measured = probe.admissions[0]?.maxChargeMicros;
      const maxCharge = measured ?? 1_000_000;
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const grant = grantOf(maxCharge + Math.floor(maxCharge / 2));
      const shared = holding();
      const contextA = { ...CONTEXT, auditAttemptId: 'attempt-s041-a' };
      const contextB = { ...CONTEXT, auditAttemptId: 'attempt-s041-b' };
      // Two attempts, two core instances, one grant; the first request that gets out is held at the provider until the other attempt has decided.
      const a = createIntelligenceCore(journalDeps(shared.gateway, port, clock, { grant, workerId: 'worker_A' })).run(input, contextA);
      const b = createIntelligenceCore(journalDeps(shared.gateway, port, clock, { grant, workerId: 'worker_B' })).run(input, contextB);
      await shared.arrived;
      const loser = await Promise.race([a, b]);
      shared.release();
      const [resultA, resultB] = await Promise.all([a, b]);
      const results = [resultA, resultB];
      const winner = results.find((result) => result !== loser);
      assert.ok(winner !== undefined);
      assert.equal(loser.state, 'BUDGET_EXHAUSTED', JSON.stringify(loser.unresolvedItems));
      assert.ok(codesOf(loser).includes('NO_FUNDED_GRANT'), JSON.stringify(codesOf(loser)));
      assert.equal(shared.gateway.requests.filter((request) => request.runId === loser.runId).length, 0, 'the loser sent nothing');
      assert.equal(winner.state, 'PROPOSAL_READY', JSON.stringify(winner.unresolvedItems));
      assert.equal(shared.gateway.requests.filter((request) => request.runId === winner.runId).length, 1, 'the winner sent its one request');
      assert.deepEqual(grant.admissions.map((entry) => entry.outcome).sort(), ['ADMITTED', 'NO_FUNDED_GRANT']);
      assert.equal(grant.admissions.find((entry) => entry.outcome === 'ADMITTED')?.runId, winner.runId);
      assert.ok(grant.history.length >= 2 && grant.history.every((entry) => entry.availableMicros >= 0), `the balance history never goes negative: ${JSON.stringify(grant.history.map((entry) => entry.availableMicros))}`);
      assert.equal(grant.view().heldMicros, 0, 'the winner\'s hold is settled to its charge');
      assert.equal(count(loser.runLedger, 'SEND_STARTED'), 0);
      assert.ok(measured !== undefined && measured > 0, 'the maximum charge of one request was admitted on the probe grant');
    } finally {
      bundle.dispose();
    }
  });

  it('R2-036: an answer without usage is charged on the grant at its maximum charge, marked UNKNOWN, never zero, and the grant\'s available balance never counts it as free', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-r2036');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const funded = 50_000_000;
      const grant = grantOf(funded);
      const gateway = reporting(null);
      const result = await createIntelligenceCore(journalDeps(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { grant })).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.requests.length, 1);
      const [reservationId] = reservationIds(result.runLedger);
      const admission = grant.admissions.find((entry) => entry.reservationId === reservationId);
      assert.ok(admission !== undefined && admission.maxChargeMicros > 0);
      const hold = grant.holdOf(reservationId ?? '');
      assert.equal(hold?.state, 'COMMITTED');
      assert.equal(hold?.usage, 'UNKNOWN', 'marked UNKNOWN');
      assert.equal(hold?.chargeMicros, admission.maxChargeMicros, 'charged at its maximum charge, never zero');
      assert.equal(grant.view().availableMicros, funded - admission.maxChargeMicros, 'the balance never counts it as free');
      assert.ok(grant.history.slice(1).every((entry) => entry.availableMicros <= funded - admission.maxChargeMicros), 'not once after the admission');
      const commit = ofKind(result.runLedger, 'COMMITTED')[0];
      assert.equal(commit?.['usageKnown'], false);
      assert.equal(commit?.['chargeMicros'], admission.maxChargeMicros);
      assert.equal(grantEvidence(result)['unknownUsageCharges'], 1);
      assert.equal(grantEvidence(result)['chargedMicros'], admission.maxChargeMicros);
    } finally {
      bundle.dispose();
    }
  });

  it('IC-12: a reported charge above the reservation becomes actual liability on the grant, blocks every further dispatch and the promotion, and ends BUDGET_EXHAUSTED with the liability in the result', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-ic12', { extraColumns: 4 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const grant = grantOf(LARGE_GRANT_MICROS);
      // Under every token ceiling, above what the reservation's byte bound can hold: the provider billed more than was reserved.
      const usage = { inputTokens: 150_000, outputTokens: 100 };
      const gateway = reporting(usage);
      const result = await createIntelligenceCore(journalDeps(gateway, port, clock, { grant })).run(input, CONTEXT);
      assert.equal(gateway.requests.length, 1, 'no further dispatch after the liability');
      assert.equal(result.state, 'BUDGET_EXHAUSTED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE', 'no promotion');
      assert.equal(port.calls, 0, 'nothing was validated');
      const admission = grant.admissions[0];
      assert.ok(admission !== undefined && admission.maxChargeMicros > 0);
      const liability = chargeOf(usage) - admission.maxChargeMicros;
      assert.ok(liability > 0, 'the reported charge exceeds the reservation');
      assert.equal(grant.view().liabilityMicros, liability, 'the liability is on the grant');
      assert.equal(grantEvidence(result)['liabilityMicros'], liability, 'and in the result');
      assert.ok(codesOf(result).includes('GRANT_LIABILITY'), JSON.stringify(codesOf(result)));
      // The liability blocks the grant for every other attempt as well.
      const next = oracleGateway();
      const blocked = await createIntelligenceCore(journalDeps(next, port, clock, { grant })).run(input, { ...CONTEXT, auditAttemptId: 'attempt-ic12-next' });
      assert.equal(next.calls, 0);
      assert.equal(blocked.state, 'BUDGET_EXHAUSTED');
      assert.ok(codesOf(blocked).includes('NO_FUNDED_GRANT'));
    } finally {
      bundle.dispose();
    }
  });

  it('a liability that a fenced owner\'s late answer puts on the record while the taker validates blocks the taker\'s promotion: BUDGET_EXHAUSTED, GRANT_LIABILITY, no draft (IC-12)', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-liability-late');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const grant = grantOf(LARGE_GRANT_MICROS);
      const store = new BarrierStore();
      // A's answer reports more than A's reservation could hold, and comes back only after B has taken over and is validating.
      const slow = holding(reporting({ inputTokens: 150_000, outputTokens: 100 }));
      const a = createIntelligenceCore(journalDeps(slow.gateway, port, clock, { store, grant, workerId: 'worker_A' })).run(input, CONTEXT);
      await slow.arrived;
      clock.advance(WORKER_LEASE_MS + 1);
      let entered: () => void = () => undefined;
      const validating = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
      const gated: FullDatasetValidationPort = { async validate(configuration) { entered(); await gate; return port.validate(configuration); } };
      const b = createIntelligenceCore(journalDeps(oracleGateway(), gated, clock, { store, grant, workerId: 'worker_B' })).run(input, CONTEXT);
      await validating;
      slow.release();
      await assert.rejects(a, isCode('LEDGER_FENCED'));
      assert.equal(count(store.read(runIdOf(CONTEXT)), 'RECONCILIATION_EVIDENCE'), 1);
      assert.ok(grant.view().liabilityMicros > 0, 'the late charge is liability on the grant');
      open();
      const taker = await b;
      assert.equal(taker.state, 'BUDGET_EXHAUSTED', JSON.stringify(taker.unresolvedItems));
      assert.equal(taker.draft.status, 'NOT_DRAFTABLE', 'no promotion');
      assert.ok(codesOf(taker).includes('GRANT_LIABILITY'), JSON.stringify(codesOf(taker)));
      assert.equal(grantEvidence(taker)['liabilityMicros'], grant.view().liabilityMicros, 'the result names the liability the grant holds');
    } finally {
      bundle.dispose();
    }
  });

  it('CMD020-DENY: an attempt whose funded grant cannot admit its first request ends BUDGET_EXHAUSTED NO_FUNDED_GRANT with zero provider requests and no grant hold left behind', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('b03-cmd020-deny');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const grant = grantOf(1);
      const gateway = oracleGateway();
      const result = await createIntelligenceCore(journalDeps(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock, { grant })).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(gateway.calls, 0, 'zero provider requests');
      assert.equal(result.state, 'BUDGET_EXHAUSTED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.ok(codesOf(result).includes('NO_FUNDED_GRANT'), JSON.stringify(codesOf(result)));
      assert.deepEqual(grant.admissions.map((entry) => entry.outcome), ['NO_FUNDED_GRANT']);
      assert.deepEqual(grant.view(), { fundedMicros: 1, availableMicros: 1, heldMicros: 0, chargedMicros: 0, liabilityMicros: 0 }, 'the grant is unchanged: no hold left behind');
      assert.equal(count(result.runLedger, 'SEND_STARTED'), 0);
      assert.equal(count(result.runLedger, 'RELEASED'), 1, 'the reservation is released as never dispatched');
    } finally {
      bundle.dispose();
    }
  });

  it('CMD021-OK: a cancellation while a request is in flight stops every further dispatch and the promotion, keeps that request\'s maximum charge on the grant and settles it to the reported usage when the answer arrives', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b03-cmd021-ok', { extraColumns: 4 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const grant = grantOf(LARGE_GRANT_MICROS);
      const usage = { inputTokens: 700, outputTokens: 60 };
      const inFlight = holding(reporting(usage));
      const core = createIntelligenceCore(journalDeps(inFlight.gateway, port, clock, { grant }));
      const running = core.run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      await inFlight.arrived;
      core.cancel(runIdOf(CONTEXT), 'the agency cancelled the audit');
      // What the grant holds while the cancelled request is still out.
      const first = grant.admissions[0];
      const whileInFlight = { state: first === undefined ? undefined : grant.holdOf(first.reservationId)?.state, heldMicros: grant.view().heldMicros };
      inFlight.release();
      const result = await running;
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE', 'no promotion');
      assert.equal(inFlight.gateway.requests.length, 1, 'no further dispatch');
      assert.equal(port.calls, 0);
      assert.ok(first !== undefined, 'the request in flight was admitted on the grant');
      assert.equal(grant.admissions.length, 1);
      assert.deepEqual(whileInFlight, { state: 'HELD', heldMicros: first.maxChargeMicros }, 'the request in flight kept its maximum charge after the cancellation');
      assert.equal(grant.holdOf(first.reservationId)?.state, 'COMMITTED', 'settled when the answer arrived');
      assert.equal(grant.holdOf(first.reservationId)?.chargeMicros, chargeOf(usage), 'to the reported usage');
      assert.equal(grant.view().heldMicros, 0);
    } finally {
      bundle.dispose();
    }
  });
});
