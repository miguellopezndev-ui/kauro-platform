/**
 * IC-1 correction, round 4 — the kernel lot.
 *
 * The draft accounts for every field it carries (IC-09, R2R-PC-04): a
 * deterministic decision that put a field into the configuration is in
 * `draft.evidence` under origin DETERMINISTIC, its rule as the rationale
 * and its refs as the refs, beside the accepted proposals under PROPOSED.
 * The end of a run is recoverable (R2K-01): the RESULT is stored before the
 * closing transition, a crash between the two leaves an answer the next
 * delivery closes the state from, and a terminal state without an answer
 * is never written by this core. A lease renewal that loses its append to a
 * writer that did not take the run is tried again on the next tick
 * (R2K-02). The response goes on the record before its bill, and neither
 * append fails the owner on a host write between them (R2K-03). A
 * cancellation or a deadline names its cause first in the codes of an
 * unresolved item, on every path (R2K-04).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { DraftEvidence } from '../src/api/intelligence-core.js';
import { adaptContracts } from '../src/adapter/contract-adapter.js';
import { IntelligenceError } from '../src/contracts/errors.js';
import { TERMINAL_RUN_STATES, WORKER_LEASE_MS } from '../src/contracts/run.js';
import { oracleGateway, oracleProposal } from '../src/gateway/fake-gateway.js';
import { parseProviderRequestPayload, transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../src/gateway/transport-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { LedgerEvent, LedgerStore, PublicLedgerEvent, PublicResponseStored } from '../src/kernel/ledger.js';
import { resolve } from '../src/resolver/deterministic-resolver.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort, vendorContract } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';

const runId = RunLedger.runIdFor(CONTEXT.auditAttemptId, CONTEXT.tenant);
const DECLARED = { 'contacts.csv': 'CONTACT' as const, 'companies.csv': 'COMPANY' as const };
const kinds = (events: readonly (LedgerEvent | PublicLedgerEvent)[], kind: LedgerEvent['kind']): number => events.filter((event) => event.kind === kind).length;
const index = (events: readonly (LedgerEvent | PublicLedgerEvent)[], kind: LedgerEvent['kind']): number => events.findIndex((event) => event.kind === kind);
const isCode = (code: string) => (error: unknown): boolean => error instanceof IntelligenceError && error.code === code;
const CAUSES = new Set(['RUN_CANCELLED', 'DEADLINE_PASSED']);
/** Every unresolved item that carries a cancellation or deadline cause carries it first. */
const causesFirst = (items: readonly { readonly codes: readonly string[] }[]): boolean => items.every((item) => !item.codes.some((code) => CAUSES.has(code)) || CAUSES.has(item.codes[0] ?? ''));

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

/** A store that runs `action` right before the first append that `matches` lands — after the writer read and decided — and then delegates. */
function interceptingStore(inner: LedgerStore, matches: (event: LedgerEvent) => boolean, action: () => void): LedgerStore {
  let armed = true;
  return {
    append(id, event, expectedLength) {
      if (armed && matches(event)) {
        armed = false;
        action();
      }
      return inner.append(id, event, expectedLength);
    },
    read: (id) => inner.read(id),
    barrier: (id, length, point) => inner.barrier(id, length, point),
  };
}

describe('IC-09 (R2R-PC-04): every drafted field is accounted for in draft.evidence', () => {
  it('a run whose fields came from deterministic decisions has one DETERMINISTIC evidence entry per field — the decision ref, its rule, its refs, its class — and the destination set equals the configuration\'s', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('ic09-deterministic');
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const declared = DECLARED;
      const recordIdColumns = { 'contacts.csv': 'Contact ID', 'companies.csv': 'Company ID' };
      const base = inputFor('HUBSPOT', profiled, contract);
      const input = { ...base, projectRevision: { ...base.projectRevision, declaredObjects: declared, recordIdColumns } };
      const result = await createIntelligenceCore(depsFor(oracle, realValidationPort(bundle, profiled.profile, contract, { clock }), clock)).run(input, CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      const configuration = result.draft.configuration;
      assert.ok(configuration !== null);
      // What the resolver decided on the same contracts, independently of the run.
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const decisions = resolve(contracts, { declaredObjects: declared, recordIdColumns }).decisions.filter((decision) => decision.kind === 'FIELD_MAPPING' && decision.targetRef !== null);
      assert.ok(decisions.length >= 5, `the fixture decides at least five fields deterministically (${String(decisions.length)})`);
      const deterministicFields = new Set(decisions.map((decision) => decision.destinationField));
      const configured = new Set(configuration.fields.map((field) => field.destinationField));
      assert.deepEqual([...configured].sort(), [...deterministicFields].sort(), 'every configured field is a deterministic decision here');
      const deterministic = result.draft.evidence.filter((entry) => entry.origin === 'DETERMINISTIC');
      assert.equal(deterministic.length, decisions.length, `N deterministic fields, N deterministic evidence entries (${JSON.stringify(result.draft.evidence)})`);
      assert.deepEqual(new Set(deterministic.map((entry) => entry.destinationField)), configured, 'the deterministic evidence names exactly the configured destinations');
      for (const entry of deterministic) {
        const decision = decisions.find((candidate) => candidate.decisionRef === entry.candidateRef);
        assert.ok(decision !== undefined, `${entry.candidateRef} is a decision ref`);
        assert.equal(entry.rationaleCode, decision.rule);
        assert.equal(entry.rationaleCode, 'EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE');
        assert.equal(entry.evidenceClass, 'STRONG', 'an exact header match on a compatible shape is STRONG, as the compiler classes it');
        assert.deepEqual(entry.evidenceRefs, decision.evidenceRefs);
        assert.ok(entry.evidenceRefs.length > 0, 'the decision cites the field facts it was made on');
        assert.equal(entry.sourceFieldRef, decision.sourceFieldRef);
        assert.equal(entry.targetRef, decision.targetRef);
        assert.equal(entry.semanticType, decision.semanticType);
        assert.equal(entry.transformPrimitive, null);
        assert.equal(entry.typedTransformParams, null);
      }
      // Nothing in the configuration is unaccounted for, and nothing deterministic is passed off as a proposal.
      for (const field of configuration.fields) assert.ok(result.draft.evidence.some((entry) => entry.destinationField === field.destinationField), `${field.destinationField} has evidence`);
      assert.ok(!result.draft.evidence.some((entry) => entry.origin === 'PROPOSED' && deterministicFields.has(entry.destinationField ?? '')), 'a deterministic field is never PROPOSED evidence');
      assert.ok(result.draft.evidence.every((entry: DraftEvidence) => entry.origin === 'DETERMINISTIC' || entry.origin === 'PROPOSED'));
    } finally {
      bundle.dispose();
    }
  });
  it('a mixed draft: the deterministic fields are DETERMINISTIC evidence, the field the model proposed (Status → lifecycle stage) is PROPOSED evidence with the compiler\'s class and rationale, and every configured field has exactly one entry', { timeout: 60_000 }, async () => {
    const contract = vendorContract('HUBSPOT', { withStatusPicklist: true });
    const bundle = makeBundle('ic09-mixed', { contacts: 'Contact ID,First Name,Last Name,Email,Phone,Status\n1,Ada,Lovelace,ada@kauro-fixture.test,,lead\n2,Grace,Hopper,grace@kauro-fixture.test,,OPEN\n3,Alan,Turing,alan@kauro-fixture.test,,lead\n' });
    try {
      const profiled = profileBundle(bundle, 'HUBSPOT');
      const contracts = adaptContracts({ mode: 'HUBSPOT', profile: profiled.profile, candidateSet: profiled.candidateSet, targetContract: contract });
      const stage = [...contracts.refs.targetByRef.entries()].find(([, info]) => info.apiName === 'lifecyclestage')?.[0];
      assert.ok(stage !== undefined);
      const statusLocator = [...contracts.refs.fieldByRef.values()].find((entry) => entry.header === 'Status')?.locator;
      assert.ok(statusLocator !== undefined);
      // The model maps Status to the lifecycle stage on the option rule; everything else is the oracle's answer.
      const transport: Transport = async (request: ProviderRequest) => {
        const bytes = JSON.stringify(request);
        const payload = parseProviderRequestPayload(bytes);
        const envelope = payload.envelope;
        const proposal = oracleProposal(envelope, payload.runId, { modelPolicyVersion: payload.policyRef.modelPolicyVersion, promptBundleVersion: payload.promptRef.promptBundleVersion });
        const headers = new Map(envelope.sourceProfile.fields.map((field) => [field.fieldRef, field.header]));
        const items = proposal.items.map((item) => {
          const candidate = envelope.deterministicCandidates.find((entry) => entry.candidateRef === item.candidateRef);
          if (candidate === undefined || headers.get(candidate.sourceRefs[0] ?? '') !== 'Status' || !candidate.allowedTargetRefs.includes(stage)) return item;
          return { ...item, proposalType: 'MAP_FIELD' as const, targetRef: stage, transformPrimitive: 'PRESERVE_AS_IS', typedTransformParams: null, requiresAgencyDecision: false, rationaleCode: 'VALUES_ARE_TARGET_OPTIONS' as const, shortRationale: 'The values are the picklist options.', abstainReason: null, alternatives: [] };
        });
        const proposed = items.filter((item) => item.proposalType !== 'ABSTAIN' && item.proposalType !== 'UNMAPPED_PRESERVE').length;
        const text = JSON.stringify({ ...proposal, items, overallOutcome: proposed === items.length ? 'PROPOSED' : proposed === 0 ? 'ABSTAINED' : 'MIXED' });
        return { status: 200, body: { id: 'msg_r4', type: 'message', role: 'assistant', model: payload.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: Math.ceil(bytes.length / 4), output_tokens: Math.ceil(text.length / 4) } } };
      };
      const clock = new VirtualClock();
      const base = inputFor('HUBSPOT', profiled, contract, { categoricalSummaries: new Map([[statusLocator, ['lead', 'OPEN']]]) });
      const result = await createIntelligenceCore(depsFor(transportGateway(transport), realValidationPort(bundle, profiled.profile, contract, { clock }), clock)).run({ ...base, projectRevision: { ...base.projectRevision, declaredObjects: DECLARED } }, CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.draft.unresolved));
      assert.equal(result.draft.status, 'SYSTEM_DRAFT');
      const fields = result.draft.configuration?.fields ?? [];
      const status = fields.find((field) => field.columnHeader === 'Status');
      assert.equal(status?.destinationField, 'contact.lifecycleStage');
      const proposed = result.draft.evidence.filter((entry) => entry.origin === 'PROPOSED');
      const deterministic = result.draft.evidence.filter((entry) => entry.origin === 'DETERMINISTIC');
      assert.deepEqual(proposed.map((entry) => entry.destinationField), ['contact.lifecycleStage'], JSON.stringify(result.draft.evidence));
      assert.equal(proposed[0]?.rationaleCode, 'VALUES_ARE_TARGET_OPTIONS');
      assert.equal(proposed[0]?.evidenceClass, 'SUPPORTED');
      assert.equal(proposed[0]?.transformPrimitive, 'PRESERVE_AS_IS');
      assert.ok(proposed[0]?.candidateRef.startsWith('cand_'), 'a proposal names its candidate');
      assert.deepEqual(new Set(deterministic.map((entry) => entry.destinationField)), new Set(fields.filter((field) => field.columnHeader !== 'Status').map((field) => field.destinationField)));
      assert.ok(deterministic.length >= 5 && deterministic.every((entry) => entry.candidateRef.startsWith('dec_') && entry.rationaleCode === 'EXACT_HEADER_MATCH_AND_COMPATIBLE_SHAPE' && entry.transformPrimitive === null));
      assert.equal(result.draft.evidence.length, fields.length, 'one entry per configured field, no more');
      for (const field of fields) assert.equal(result.draft.evidence.filter((entry) => entry.destinationField === field.destinationField).length, 1, field.destinationField);
      assert.ok(result.draft.evidence.every((entry: DraftEvidence) => entry.origin === 'DETERMINISTIC' || entry.origin === 'PROPOSED'));
    } finally {
      bundle.dispose();
    }
  });
  it('a NOT_DRAFTABLE plan carries no evidence, whatever was decided', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('ic09-not-draftable');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const core = createIntelligenceCore(deps);
      const cancelling: ModelGateway = { name: 'cancelling', evidenceClass: 'SIMULATED', async analyze(request) { const answer = await oracle.analyze(request); core.cancel(runId, 'operator'); return answer; } };
      const cancelled = await createIntelligenceCore({ ...deps, gateway: cancelling }).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(cancelled.state, 'CANCELLED');
      assert.equal(cancelled.draft.status, 'NOT_DRAFTABLE');
      assert.deepEqual(cancelled.draft.evidence, []);
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2K-01: the end of a run is recoverable', () => {
  it('a process that dies between the RESULT and the closing transition: inside the dead owner\'s lease the redelivery is WORKER_NOT_OWNER; after it, the state is closed from the RESULT and the answer given, with no send and no validation; a third delivery reads the same answer', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('crash-after-result');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const oracle = oracleGateway();
      const deps = depsFor(oracle, port, clock);
      const dying = interceptingStore(deps.ledgerStore, (event) => event.kind === 'STATE' && TERMINAL_RUN_STATES.has(event.to), () => { throw new ProcessDied(); });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      await assert.rejects(createIntelligenceCore({ ...deps, ledgerStore: dying }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      const events = deps.ledgerStore.read(runId);
      assert.equal(kinds(events, 'RESULT'), 1, 'the answer was durable before the crash');
      const opened = RunLedger.open(deps.ledgerStore, clock, runId).view();
      assert.ok(!TERMINAL_RUN_STATES.has(opened.state), `not closed yet (${opened.state})`);
      const calls = oracle.calls;
      const validations = port.calls;
      await assert.rejects(createIntelligenceCore(deps).run(input, CONTEXT), isCode('WORKER_NOT_OWNER'), 'inside the dead owner\'s lease, as after any crash');
      clock.advance(WORKER_LEASE_MS + 1);
      const answered = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(answered.state, 'PROPOSAL_READY', JSON.stringify(answered.unresolvedItems));
      assert.equal(answered.draft.status, 'SYSTEM_DRAFT');
      assert.equal(oracle.calls, calls, 'no send');
      assert.equal(port.calls, validations, 'no validation');
      const closed = answered.runLedger;
      assert.equal(kinds(closed, 'RESULT'), 1);
      assert.equal(closed.filter((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY').length, 1, 'the closing transition applied once, from the RESULT');
      assert.ok(index(closed, 'RESULT') < closed.findIndex((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY'), 'the RESULT precedes the closing transition');
      assert.ok(closed.some((event) => event.kind === 'NOTE' && event.note === 'closing transition recovered from the stored result'));
      const third = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(third.proposalDigest, answered.proposalDigest);
      assert.equal(third.state, 'PROPOSAL_READY');
      assert.equal(oracle.calls, calls);
    } finally {
      bundle.dispose();
    }
  });
  it('the order holds on every path: FAILED_CONTRACT and ABSTAINED_MATERIAL runs store their RESULT before their closing STATE', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('order-every-path');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const failed = await createIntelligenceCore(deps).run({ ...inputFor('CLEAN_ONLY', profiled, null), policyBundle: { modelPolicyVersion: '999.0.0', promptBundleVersion: '1.1.0' } }, { ...CONTEXT, auditAttemptId: 'attempt-order-contract' });
      assert.equal(failed.state, 'FAILED_CONTRACT');
      assert.ok(index(failed.runLedger, 'RESULT') < failed.runLedger.findIndex((event) => event.kind === 'STATE' && event.to === 'FAILED_CONTRACT'), JSON.stringify(failed.runLedger.map((event) => event.kind)));
      assert.ok(failed.unresolvedItems.some((item) => item.outcome === 'INCOMPATIBLE_CONTRACT_VERSION'));
      const empty = makeBundle('order-empty', { contacts: 'Mystery A,Mystery B\n,\n,\n' });
      try {
        const emptied = profileBundle(empty, 'CLEAN_ONLY');
        const abstained = await createIntelligenceCore(depsFor(oracle, realValidationPort(empty, emptied.profile, null, { clock }), clock)).run(inputFor('CLEAN_ONLY', emptied, null), { ...CONTEXT, auditAttemptId: 'attempt-order-abstain' });
        if (abstained.state === 'ABSTAINED_MATERIAL') assert.ok(index(abstained.runLedger, 'RESULT') < abstained.runLedger.findIndex((event) => event.kind === 'STATE' && event.to === 'ABSTAINED_MATERIAL'), JSON.stringify(abstained.runLedger.map((event) => event.kind)));
        assert.ok(TERMINAL_RUN_STATES.has(abstained.state as never) && kinds(abstained.runLedger, 'RESULT') === 1);
      } finally {
        empty.dispose();
      }
    } finally {
      bundle.dispose();
    }
  });
  it('an attempt the host cancelled before any owner finished it is answered CANCELLED on the next delivery, with the cause first and a RESULT stored; a further delivery reads it', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancelled-unowned');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      // The owner dies before its first reservation; the host cancels the attempt while nobody owns it.
      const dying = interceptingStore(deps.ledgerStore, (event) => event.kind === 'RESERVED', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore({ ...deps, ledgerStore: dying }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      clock.advance(WORKER_LEASE_MS + 1);
      createIntelligenceCore(deps).cancel(runId, 'operator');
      assert.equal(RunLedger.open(deps.ledgerStore, clock, runId).view().state, 'CANCELLED');
      assert.equal(kinds(deps.ledgerStore.read(runId), 'RESULT'), 0);
      const calls = oracle.calls;
      const answered = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(answered.state, 'CANCELLED');
      assert.equal(answered.draft.status, 'NOT_DRAFTABLE');
      assert.equal(answered.unresolvedItems[0]?.codes[0], 'RUN_CANCELLED');
      assert.equal(oracle.calls, calls, 'nothing bought');
      assert.equal(kinds(answered.runLedger, 'RESULT'), 1);
      const again = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(again.proposalDigest, answered.proposalDigest);
      assert.equal(kinds(again.runLedger, 'RESULT'), 1);
    } finally {
      bundle.dispose();
    }
  });
  it('a cancellation that lands between the RESULT and its closing transition: the record wins — CANCELLED, NOT_DRAFTABLE, the cause first, one RESULT — and the redelivery reads the same answer', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancel-after-result');
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
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(result.draft.configuration, null);
      assert.equal(result.memoryCandidates.length, 0);
      const cause = result.unresolvedItems.find((item) => item.candidateRef === 'run');
      assert.equal(cause?.codes[0], 'RUN_CANCELLED');
      assert.ok(cause?.codes.includes('RESULT_NAMED_PROPOSAL_READY'), 'the answer says what the owner meant to close with');
      assert.equal(kinds(result.runLedger, 'RESULT'), 1);
      assert.ok(!result.runLedger.some((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY'));
      const again = await core.run(input, CONTEXT);
      assert.equal(again.state, 'CANCELLED');
      assert.equal(again.proposalDigest, result.proposalDigest);
      assert.deepEqual(again.unresolvedItems, result.unresolvedItems);
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2K-02: a lost renewal is tried again', () => {
  it('a renewal that loses its append to a host note renews on the next tick: the lease holds through a 150 s call, a second worker is refused, one send', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('renewal-cas-lost');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const { gateway, arrived, release, sends } = holdingGateway();
      const inner = new MemoryLedgerStore();
      const store = new InterleavingLedgerStore(inner);
      const deps = { ...depsFor(gateway, port, clock), ledgerStore: store };
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const a = createIntelligenceCore({ ...deps, workerId: 'worker_A' }).run(input, CONTEXT);
      await arrived;
      const leasesBefore = kinds(inner.read(runId), 'LEASE');
      // The first renewal loses its append to a note the host lands beside it.
      store.scheduleBefore('LEASE', () => { inner.append(runId, { kind: 'NOTE', at: clock.now(), note: 'host note during the await', counters: {} }, inner.read(runId).length); });
      deps.timer.advance(30_000);
      assert.equal(kinds(inner.read(runId), 'LEASE'), leasesBefore, 'the first renewal was lost');
      deps.timer.advance(120_000);
      assert.ok(kinds(inner.read(runId), 'LEASE') > leasesBefore, 'the renewals went on after the loss');
      const held = RunLedger.open(inner, clock, runId).view().lease;
      assert.equal(held?.workerId, 'worker_A');
      assert.ok(Date.parse(held?.leaseUntil ?? '') > clock.nowMs(), 'the lease in force is A\'s, renewed');
      const other = oracleGateway();
      await assert.rejects(createIntelligenceCore({ ...deps, gateway: other, workerId: 'worker_B' }).run(input, CONTEXT), isCode('WORKER_NOT_OWNER'));
      assert.equal(other.calls, 0);
      release();
      const result = await a;
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      assert.equal(sends(), 1, 'one send for one task');
      assert.equal(kinds(result.runLedger, 'RESPONSE_STORED'), 1);
      assert.equal(result.resourceEvidence.ambiguousReservations, 0);
    } finally {
      bundle.dispose();
    }
  });
  it('a lease held by another owner ends the renewals: after a takeover the late owner appends no LEASE however often its timer fires, and is fenced at its next write', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('renewal-stops-on-takeover');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const { gateway, arrived, release } = holdingGateway();
      const deps = depsFor(gateway, port, clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const a = createIntelligenceCore({ ...deps, workerId: 'worker_A' }).run(input, CONTEXT);
      await arrived;
      // A's timer never fired; by the run's clock A is dead, and B takes over and finishes.
      clock.advance(WORKER_LEASE_MS + 1);
      const b = await createIntelligenceCore({ ...deps, gateway: oracleGateway(), workerId: 'worker_B' }).run(input, CONTEXT);
      assert.equal(b.state, 'PROPOSAL_READY');
      const leases = kinds(deps.ledgerStore.read(runId), 'LEASE');
      for (let tick = 0; tick < 6; tick += 1) deps.timer.tick();
      const after = deps.ledgerStore.read(runId);
      assert.equal(kinds(after, 'LEASE'), leases, 'no LEASE from the late owner');
      assert.equal(RunLedger.open(deps.ledgerStore, clock, runId).view().lease?.workerId, 'worker_B');
      release();
      await assert.rejects(a, isCode('LEDGER_FENCED'));
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2K-03: the response precedes its bill, and neither append fails the owner on a host write between them', () => {
  it('the ledger: commit writes RESPONSE_STORED before COMMITTED; a cancel that lands between them costs neither, and both are on the record once', () => {
    const store = new InterleavingLedgerStore();
    const clock = new VirtualClock();
    const identity = { auditAttemptId: 'attempt-commit-order', projectRevisionHash: 'a'.repeat(64), hashes: { profile: 'b'.repeat(64) }, versions: {}, tenant: CONTEXT.tenant };
    const ledger = RunLedger.create(store, clock, identity);
    ledger.acquireLease('worker', WORKER_LEASE_MS);
    const reservation = ledger.reserve({ taskId: 'task_1', attempt: 1, invocation: 1, inputTokens: 1_000, outputTokens: 100, idempotencyKey: 'k'.repeat(64) });
    store.scheduleBefore('COMMITTED', () => { RunLedger.open(store, clock, ledger.runId).cancel('between the response and the bill'); });
    ledger.commit(reservation.reservationId, { inputTokens: 10, outputTokens: 5, billedButUnusable: false }, { idempotencyKey: 'k'.repeat(64), envelopeHash: 'h'.repeat(64), body: { answer: 1 } });
    const events = store.read(ledger.runId);
    assert.equal(kinds(events, 'RESPONSE_STORED'), 1);
    assert.equal(kinds(events, 'COMMITTED'), 1);
    assert.ok(index(events, 'RESPONSE_STORED') < index(events, 'COMMITTED'), 'the answer before the bill');
    assert.ok(index(events, 'CANCELLED') < index(events, 'COMMITTED'), 'the cancel landed between the two');
    assert.deepEqual(store.appends.filter((entry) => entry.kind === 'COMMITTED').map((entry) => entry.ok), [false, true], 'the bill lost once and was decided again');
    assert.equal(ledger.view().reservations[0]?.state, 'COMMITTED');
    assert.equal(ledger.view().budget.billedInputTokens, 10);
    assert.deepEqual(ledger.storedResponse('k'.repeat(64))?.response, { answer: 1 });
  });
  it('the core: a host cancel between the response and the bill — the owner\'s run resolves CANCELLED with a RESULT, one send, one RESPONSE_STORED, one COMMITTED; the redelivery answers from the ledger', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancel-between-response-and-bill');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const inner = new MemoryLedgerStore();
      const store = new InterleavingLedgerStore(inner);
      const deps = { ...depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock), ledgerStore: store };
      const core = createIntelligenceCore(deps);
      store.scheduleBefore('COMMITTED', () => { core.cancel(runId, 'cancel between the response and the bill'); });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await core.run(input, CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(oracle.calls, 1);
      assert.equal(kinds(result.runLedger, 'RESPONSE_STORED'), 1, 'the billed answer is on the record');
      assert.equal(kinds(result.runLedger, 'COMMITTED'), 1);
      assert.equal(kinds(result.runLedger, 'RESULT'), 1);
      assert.ok(causesFirst(result.unresolvedItems) && result.unresolvedItems.some((item) => item.codes[0] === 'RUN_CANCELLED'), JSON.stringify(result.unresolvedItems));
      clock.advance(WORKER_LEASE_MS + 1);
      const again = await core.run(input, CONTEXT);
      assert.equal(again.state, 'CANCELLED');
      assert.equal(again.proposalDigest, result.proposalDigest);
      assert.equal(oracle.calls, 1, 'no second send');
    } finally {
      bundle.dispose();
    }
  });
  it('the core: a process that dies between the response and the bill — the redelivery after the lease reuses the stored response, buys nothing, bills the usage the stored answer reports before compiling it and drafts (D3-JRN-1)', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('crash-between-response-and-bill');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const port = realValidationPort(bundle, profiled.profile, null, { clock });
      const oracle = oracleGateway();
      const store = new InterleavingLedgerStore();
      store.scheduleBefore('COMMITTED', () => { throw new ProcessDied(); });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      await assert.rejects(createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      assert.equal(oracle.calls, 1);
      assert.equal(kinds(store.read(runId), 'RESPONSE_STORED'), 1, 'the answer survived the crash');
      assert.equal(kinds(store.read(runId), 'COMMITTED'), 0);
      clock.advance(WORKER_LEASE_MS + 1);
      const resumed = await createIntelligenceCore({ ...depsFor(oracle, port, clock), ledgerStore: store }).run(input, CONTEXT);
      assert.equal(resumed.state, 'PROPOSAL_READY', JSON.stringify(resumed.unresolvedItems));
      assert.equal(resumed.draft.status, 'SYSTEM_DRAFT');
      assert.equal(oracle.calls, 1, 'the stored response is reused; the request is not bought again');
      assert.equal(resumed.resourceEvidence.ambiguousReservations, 0, 'the answer is on the record: its reservation is billed, not left ambiguous');
      assert.equal(resumed.resourceEvidence.providerInvocations, 1);
      // The answer itself is in the protected record the host's store holds; the public ledger carries only its digest and the usage it was counted at (D3-PRIV-1).
      const stored = store.read(runId).find((event): event is Extract<LedgerEvent, { kind: 'RESPONSE_STORED' }> => event.kind === 'RESPONSE_STORED');
      const published = resumed.runLedger.find((event): event is PublicResponseStored => event.kind === 'RESPONSE_STORED');
      const commits = resumed.runLedger.filter((event): event is Extract<LedgerEvent, { kind: 'COMMITTED' }> => event.kind === 'COMMITTED');
      assert.equal(commits.length, 1, 'billed exactly once');
      assert.equal(commits[0]?.reservationId, stored?.reservationId, 'the reservation the stored answer names');
      const reported = (stored?.response as { usage: { inputTokens: number; outputTokens: number } }).usage;
      assert.deepEqual([commits[0]?.usage.inputTokens, commits[0]?.usage.outputTokens, commits[0]?.usageKnown], [reported.inputTokens, reported.outputTokens, true], 'at the usage the stored answer reports');
      assert.deepEqual(published?.usage, { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens }, 'the public projection shows the usage it was counted at');
      assert.equal(published?.responseDigest, stored?.responseDigest);
      assert.ok(!('response' in (published ?? {})), 'never the answer itself');
      assert.ok(index(resumed.runLedger, 'COMMITTED') < resumed.runLedger.findIndex((event) => event.kind === 'NOTE' && event.note === 'response reused from the ledger'), 'billed before the answer was compiled');
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2K-03 (the host side): a cancellation whose own closing STATE never landed is still a cancellation', () => {
  /** A host handle whose process dies between the two appends of cancel(): CANCELLED lands, STATE:CANCELLED does not. */
  const halfCancel = (store: LedgerStore, clock: VirtualClock, reason: string): void => {
    const dying = interceptingStore(store, (event) => event.kind === 'STATE' && event.to === 'CANCELLED', () => { throw new ProcessDied(); });
    assert.throws(() => RunLedger.open(dying, clock, runId).cancel(reason), (error: unknown) => error instanceof ProcessDied);
    const view = RunLedger.open(store, clock, runId).view();
    assert.ok(view.cancelled && !TERMINAL_RUN_STATES.has(view.state), `cancelled on the record, state still open (${view.state})`);
  };
  it('the owner past its last provider answer closes the run CANCELLED itself: the cause first, one RESULT before the closing STATE, no CONTRACT_VIOLATION; the redelivery reads the same answer', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('half-cancel-owner');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const cancelling: ModelGateway = { name: 'half-cancelling', evidenceClass: 'SIMULATED', async analyze(request) { const answer = await oracle.analyze(request); halfCancel(deps.ledgerStore, clock, 'host died under its cancel'); return answer; } };
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await createIntelligenceCore({ ...deps, gateway: cancelling }).run(input, CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(result.unresolvedItems.find((item) => item.candidateRef === 'run')?.codes[0], 'RUN_CANCELLED');
      assert.equal(kinds(result.runLedger, 'RESULT'), 1);
      const closing = result.runLedger.findIndex((event) => event.kind === 'STATE' && event.to === 'CANCELLED');
      assert.ok(closing > index(result.runLedger, 'CANCELLED') && closing > index(result.runLedger, 'RESULT'), 'the owner closed the state after the cancellation and after its RESULT');
      assert.equal(result.runLedger.filter((event) => event.kind === 'STATE' && event.to === 'CANCELLED').length, 1);
      const again = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(again.state, 'CANCELLED');
      assert.equal(again.proposalDigest, result.proposalDigest);
      assert.equal(oracle.calls, 1);
    } finally {
      bundle.dispose();
    }
  });
  it('an attempt nobody owns, half-cancelled: the next delivery answers CANCELLED with the cause first, stores the RESULT, closes the state and buys nothing', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('half-cancel-unowned');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const dying = interceptingStore(deps.ledgerStore, (event) => event.kind === 'RESERVED', () => { throw new ProcessDied(); });
      await assert.rejects(createIntelligenceCore({ ...deps, ledgerStore: dying }).run(input, CONTEXT), (error: unknown) => error instanceof ProcessDied);
      clock.advance(WORKER_LEASE_MS + 1);
      halfCancel(deps.ledgerStore, clock, 'host died under its cancel');
      const calls = oracle.calls;
      const answered = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(answered.state, 'CANCELLED');
      assert.equal(answered.unresolvedItems[0]?.codes[0], 'RUN_CANCELLED');
      assert.equal(oracle.calls, calls, 'nothing bought');
      assert.equal(kinds(answered.runLedger, 'RESULT'), 1);
      assert.equal(RunLedger.open(deps.ledgerStore, clock, runId).view().state, 'CANCELLED');
      const again = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.equal(again.proposalDigest, answered.proposalDigest);
    } finally {
      bundle.dispose();
    }
  });
  it('a half-written cancel between the RESULT and its closing transition: the record wins as with a whole one — CANCELLED, no draft, RESULT_NAMED_PROPOSAL_READY beside the cause, and the ledger says what was not applied', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('half-cancel-under-close');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const store = interceptingStore(deps.ledgerStore, (event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY', () => { halfCancel(deps.ledgerStore, clock, 'host died under its cancel'); });
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const result = await createIntelligenceCore({ ...deps, ledgerStore: store }).run(input, CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      assert.equal(result.draft.configuration, null);
      const cause = result.unresolvedItems.find((item) => item.candidateRef === 'run');
      assert.equal(cause?.codes[0], 'RUN_CANCELLED');
      assert.ok(cause?.codes.includes('RESULT_NAMED_PROPOSAL_READY'));
      assert.ok(!result.runLedger.some((event) => event.kind === 'STATE' && event.to === 'PROPOSAL_READY'));
      assert.ok(result.runLedger.some((event) => event.kind === 'NOTE' && event.note === 'cancellation already recorded without its closing state; PROPOSAL_READY not applied'));
      assert.equal(RunLedger.open(deps.ledgerStore, clock, runId).view().state, 'CANCELLED');
      const again = await createIntelligenceCore(deps).run(input, CONTEXT);
      assert.deepEqual(again.unresolvedItems, result.unresolvedItems);
      assert.equal(oracle.calls, 1);
    } finally {
      bundle.dispose();
    }
  });
});

describe('R2K-04: a cancellation or a deadline names its cause first', () => {
  it('a cancel that lands after the last provider answer ends the run CANCELLED with an unresolved item whose first code is RUN_CANCELLED; the outcome stays in the TaskOutcome vocabulary', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('cancel-after-last-answer');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const core = createIntelligenceCore(deps);
      const cancelling: ModelGateway = { name: 'cancelling', evidenceClass: 'SIMULATED', async analyze(request) { const answer = await oracle.analyze(request); core.cancel(runId, 'operator'); return answer; } };
      const result = await createIntelligenceCore({ ...deps, gateway: cancelling }).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.equal(result.state, 'CANCELLED');
      assert.equal(result.draft.status, 'NOT_DRAFTABLE');
      const cause = result.unresolvedItems.find((item) => item.candidateRef === 'run');
      assert.ok(cause !== undefined, `the cause is on the result: ${JSON.stringify(result.unresolvedItems)}`);
      assert.equal(cause.codes[0], 'RUN_CANCELLED');
      assert.equal(cause.outcome, 'BUDGET_EXHAUSTED');
      assert.ok(causesFirst(result.unresolvedItems));
      assert.ok(causesFirst(result.draft.unresolved));
      assert.equal(kinds(result.runLedger, 'RESULT'), 1);
    } finally {
      bundle.dispose();
    }
  });
  it('a deadline that passes during the provider call: every item that names it names it first, on the task and on the run', { timeout: 60_000 }, async () => {
    const bundle = makeBundle('deadline-cause-first', { extraColumns: 2 });
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const clock = new VirtualClock();
      const oracle = oracleGateway();
      const deps = depsFor(oracle, realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const slow: ModelGateway = { name: 'slow', evidenceClass: 'SIMULATED', async analyze(request) { const answer = await oracle.analyze(request); clock.advance(20 * 60_000 + 1); return answer; } };
      const result = await createIntelligenceCore({ ...deps, gateway: slow }).run(inputFor('CLEAN_ONLY', profiled, null), CONTEXT);
      assert.notEqual(result.draft.status, 'SYSTEM_DRAFT');
      const named = [...result.tasks, ...result.unresolvedItems].filter((item) => item.codes.includes('DEADLINE_PASSED'));
      assert.ok(named.length > 0, JSON.stringify({ tasks: result.tasks, unresolved: result.unresolvedItems }));
      assert.ok(named.every((item) => item.codes[0] === 'DEADLINE_PASSED' && item.outcome === 'BUDGET_EXHAUSTED'));
      assert.ok(causesFirst(result.unresolvedItems));
    } finally {
      bundle.dispose();
    }
  });
});
