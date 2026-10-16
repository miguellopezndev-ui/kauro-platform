import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { canonicalJson, sha256Hex } from '../src/contracts/canonical.js';
import { WORKER_LEASE_MS } from '../src/contracts/run.js';
import { SONNET_5_5_US } from '../src/gateway/candidates.js';
import { oracleTransport } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, ModelGateway } from '../src/gateway/model-gateway.js';
import { MemoryLedgerStore, RunLedger, VirtualClock } from '../src/kernel/ledger.js';
import type { HostContext } from '../src/ports/ports.js';
import { assessResponse, publicProjection, reconcileByIdempotencyRef, responseReceipt } from '../src/provider/vertex-receipts.js';
import type { ProtectedReceipt, ResponseReceipt } from '../src/provider/vertex-receipts.js';
import { vertexGateway } from '../src/provider/vertex-gateway.js';
import type { VertexFetch } from '../src/provider/vertex-transport.js';
import { forms } from './support/egress-harness.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { InterleavingLedgerStore, ProcessDied } from './support/interleaving-store.js';
import { drain, loadRecording, replay } from './support/vertex-replay.js';
import { bedrockGateway } from '../src/provider/bedrock-gateway.js';
import { reconcileAmbiguousHold, reconcileBedrock } from '../src/provider/bedrock-receipts.js';
import type { BedrockFetch } from '../src/provider/bedrock-transport.js';
import { loadBedrockRecording } from './support/bedrock-replay.js';

const TOKEN = 'ya29.SIMULATED-TOKEN-NOT-A-SECRET-0002';
const tokenProvider = async (): Promise<{ token: string; expiresAt: string }> => ({ token: TOKEN, expiresAt: '2999-01-01T00:00:00.000Z' });

type Fact = { readonly kind: string; readonly [member: string]: unknown };
const ofKind = (events: readonly unknown[], kind: string): Fact[] => (events as readonly Fact[]).filter((fact) => fact.kind === kind);
const runIdOf = (context: HostContext): string => RunLedger.runIdFor(context.auditAttemptId, context.tenant);

/** A fetch answered by the offline oracle, in the Vertex wire form. `lose(n)` drops the answer of call n after the body was written. */
function oracleFetch(lose: (call: number) => boolean = () => false): { readonly fetchImpl: VertexFetch; calls(): number; readonly bodies: string[] } {
  const oracle = oracleTransport();
  const bodies: string[] = [];
  let calls = 0;
  const fetchImpl: VertexFetch = async (_url, init) => {
    calls += 1;
    const text = Buffer.from(await drain(init.body)).toString('utf8');
    bodies.push(text);
    if (lose(calls)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const { anthropic_version: _version, ...rest } = JSON.parse(text) as Record<string, unknown>;
    const answered = await oracle({ model: SONNET_5_5_US.modelId, ...rest } as never, '2999-01-01T00:00:00.000Z');
    return new Response(JSON.stringify(answered.body), { status: answered.status, headers: { 'content-type': 'application/json', 'x-goog-request-id': `simulated-goog-${String(calls)}` } });
  };
  return { fetchImpl, calls: () => calls, bodies };
}

const gatewayOver = (fetchImpl: VertexFetch, receipts: ProtectedReceipt[]): ReturnType<typeof vertexGateway> => vertexGateway({ project: 'kauro-sim-project', profile: SONNET_5_5_US, tokenProvider, fetchImpl, sink: (receipt) => { receipts.push(receipt); }, now: () => 0 });

const ambiguousCount = (result: IntelligenceResult): number => result.resourceEvidence.ambiguousReservations;

describe('B04-RECEIPTS: request and response receipts through the Vertex gateway (SIMULATED, no network)', () => {
  it('S038: a connection lost after the body was written is AFTER_SEND ambiguous with the reservation held, the adapter never retries, and a later receipt with the same idempotency ref reconciles by provider message id', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b04-s038');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const receipts: ProtectedReceipt[] = [];
      const wire = oracleFetch((call) => call === 1);
      const first = depsFor(gatewayOver(wire.fetchImpl, receipts), realValidationPort(bundle, profiled.profile, null, { clock }), clock);
      const lostRun = await createIntelligenceCore(first).run(input, CONTEXT);
      // The adapter made exactly one fetch for the one send the kernel asked for; it retried nothing itself.
      assert.equal(wire.calls(), 1, 'one fetch: the adapter never retries');
      const ambiguous = ofKind(lostRun.runLedger, 'AMBIGUOUS');
      assert.equal(ambiguous.length, 1);
      assert.match(String(ambiguous[0]?.['reason']), /AFTER_SEND/u);
      assert.equal(ambiguousCount(lostRun), 1, 'the reservation is held at its maximum charge');
      assert.notEqual(lostRun.state, 'PROPOSAL_READY');
      // The held reservation names the same idempotency ref the request receipt carries.
      const requests = receipts.filter((receipt) => receipt.kind === 'REQUEST');
      assert.equal(requests.length, 1);
      const reserved = ofKind(lostRun.runLedger, 'RESERVED').find((fact) => (fact['reservation'] as { reservationId: string }).reservationId === ambiguous[0]?.['reservationId']);
      assert.ok(reserved !== undefined);
      const ref = (reserved['reservation'] as { requestKey: string }).requestKey;
      assert.equal(requests[0]?.idempotencyRef, ref, 'journal reservation and request receipt share the idempotency ref');
      assert.equal(reconcileByIdempotencyRef(receipts, ref).providerMessageId, null, 'nothing answered yet');
      // A later receipt for the same ref (the response that was lost on the wire, seen by a reconciliation lookup) names the provider message id.
      const recording = loadRecording('messages-200');
      const later = responseReceipt({ status: 200, headers: recording.headers, bodyText: JSON.stringify(recording.body), bodyLength: JSON.stringify(recording.body).length, truncated: false, latencyMs: 0, idempotencyRef: ref, runId: requests[0]?.runId ?? null });
      const reconciled = reconcileByIdempotencyRef([...receipts, later], ref);
      assert.equal(reconciled.requests, 1);
      assert.equal(reconciled.responses, 1);
      assert.equal(reconciled.providerMessageId, 'msg_vrtx_01SIMULATED0001');
      assert.equal(reconcileByIdempotencyRef([...receipts, later], 'idem-of-another-request').providerMessageId, null, 'another ref does not reconcile');
      assert.equal(wire.calls(), 1, 'reconciliation is a lookup, not a send');
      assert.ok(!/EXACTLY_ONCE/iu.test(JSON.stringify(lostRun)), 'no exactly-once claim');
    } finally {
      bundle.dispose();
    }
  });

  it('R2-032: after a crash past SEND_STARTED the journal holds the provider message id from the receipt when one arrived, and recovery sends again only within the invocation bound and the remaining grant', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b04-r2032');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const deliver = async (wire: ReturnType<typeof oracleFetch>, receipts: ProtectedReceipt[], clock: VirtualClock, store: InterleavingLedgerStore | MemoryLedgerStore, context: HostContext, die: boolean) => {
        const inner = gatewayOver(wire.fetchImpl, receipts);
        const dying = die && store instanceof InterleavingLedgerStore;
        // The process dies after the provider answered and before the answer is on the record.
        const gateway: ModelGateway = dying ? { name: 'dying', evidenceClass: inner.evidenceClass, async analyze(request) { const answer = await inner.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return answer; } } : inner;
        const deps = { ...depsFor(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock), ledgerStore: store };
        const run = createIntelligenceCore(deps).run(input, context);
        if (dying) {
          await assert.rejects(run, (error: unknown) => error instanceof ProcessDied);
          clock.advance(WORKER_LEASE_MS + 1);
          return null;
        }
        return { result: await run, deps };
      };
      // (a) The process dies after the provider answered and before the answer is on the record; the retry's receipt carries the id the journal then stores.
      {
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const receipts: ProtectedReceipt[] = [];
        const wire = oracleFetch();
        await deliver(wire, receipts, clock, store, CONTEXT, true);
        assert.equal(ofKind(store.read(runIdOf(CONTEXT)), 'SEND_STARTED').length, 1);
        assert.equal(ofKind(store.read(runIdOf(CONTEXT)), 'RESPONSE_STORED').length, 0, 'the answer never reached the journal');
        const first = receipts.find((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
        assert.ok(first !== undefined && first.providerMessageId !== null, 'an answer with a provider message id arrived before the crash');
        const resumed = await deliver(wire, receipts, clock, store, CONTEXT, false);
        assert.ok(resumed !== null);
        assert.equal(resumed.result.state, 'PROPOSAL_READY', JSON.stringify(resumed.result.unresolvedItems));
        assert.equal(wire.calls(), 2, 'one send per delivery');
        const answers = receipts.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
        assert.equal(answers.length, 2);
        const stored = ofKind(resumed.result.runLedger, 'RESPONSE_STORED');
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.['providerRequestId'], answers[1]?.providerMessageId, 'the journal holds the provider message id of the receipt that arrived');
        assert.ok(ofKind(resumed.result.runLedger, 'AMBIGUOUS').length >= 1, 'the sent reservation stays ambiguous, never released');
      }
      // (b) The invocation bound: three deliveries that each died after sending leave nothing for a fourth, and no fetch is made for it.
      {
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const receipts: ProtectedReceipt[] = [];
        const wire = oracleFetch();
        const context = { ...CONTEXT, auditAttemptId: 'attempt-b04-r2032-bound' };
        for (let delivery = 0; delivery < 3; delivery += 1) await deliver(wire, receipts, clock, store, context, true);
        assert.equal(wire.calls(), 3);
        const fourth = await deliver(wire, receipts, clock, store, context, false);
        assert.ok(fourth !== null);
        assert.equal(wire.calls(), 3, 'the initial send and two retries, and no fourth');
        assert.equal(fourth.result.state, 'BUDGET_EXHAUSTED');
        assert.equal(receipts.filter((receipt) => receipt.kind === 'REQUEST').length, 3, 'no request receipt for a send that never happened');
      }
    } finally {
      bundle.dispose();
    }
  });

  it('the request receipt records the exact bytes sent, their sha256 and length, and the authorization header only as redacted', async () => {
    const bundle = makeBundle('b04-request-receipt');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const receipts: ProtectedReceipt[] = [];
      const wire = oracleFetch();
      const result = await createIntelligenceCore(depsFor(gatewayOver(wire.fetchImpl, receipts), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const requests = receipts.filter((receipt) => receipt.kind === 'REQUEST');
      assert.equal(requests.length, wire.bodies.length);
      requests.forEach((receipt, index) => {
        assert.equal(receipt.kind, 'REQUEST');
        if (receipt.kind !== 'REQUEST') return;
        const sent = wire.bodies[index];
        assert.equal(receipt.bodyBytes, sent, 'the exact bytes sent');
        assert.equal(receipt.bodySha256, sha256Hex(sent ?? ''));
        assert.equal(receipt.bodyLength, Buffer.byteLength(sent ?? '', 'utf8'));
        assert.equal(canonicalJson(JSON.parse(sent ?? '')), sent, 'the sent bytes are canonical');
        assert.equal(receipt.headers['authorization'], `Bearer <redacted, ${String(Buffer.byteLength(TOKEN))} bytes>`);
        assert.ok(!JSON.stringify(receipt).includes(TOKEN));
        assert.equal(receipt.method, 'POST');
        assert.match(receipt.url, /^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/kauro-sim-project\/locations\/us\/publishers\/anthropic\/models\/claude-sonnet-5-5:rawPredict$/u);
        assert.ok(receipt.idempotencyRef !== null && receipt.runId !== null);
      });
      // The response receipt: status, allowlisted headers, id, served model, stop reason, usage, latency and digest.
      const answers = receipts.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
      assert.equal(answers.length, 1);
      const [answer] = answers;
      assert.ok(answer !== undefined);
      assert.equal(answer.status, 200);
      assert.equal(answer.servedModel, SONNET_5_5_US.modelId);
      assert.equal(answer.stopReason, 'end_turn');
      assert.match(String(answer.providerMessageId), /^msg_oracle_\d+$/u);
      assert.ok(answer.usage !== null && answer.usage !== 'USAGE_UNKNOWN' && answer.usage.inputTokens > 0 && answer.usage.cacheReadInputTokens === 0);
      assert.match(answer.headers['x-goog-request-id'] ?? '', /^simulated-goog-/u, 'x-goog headers verbatim');
      assert.equal(answer.bodyDigest, sha256Hex(answer.bodyText));
      assert.equal(assessResponse(SONNET_5_5_US, answer).verdict, 'OK');
    } finally {
      bundle.dispose();
    }
  });

  it('a response whose served model differs from the profile, or that reports cache tokens, is a terminal failure that breaks the run subject', async () => {
    const answeredBy = async (name: string): Promise<{ readonly kind: string; readonly reason?: string; readonly broken: boolean; readonly causes: readonly string[]; readonly receipt: ResponseReceipt }> => {
      const recording = loadRecording(name);
      const receipts: ProtectedReceipt[] = [];
      const wire = replay(recording);
      const gateway = gatewayOver(wire.fetchImpl, receipts);
      const result = await gateway.analyze(await gatewayRequest());
      const receipt = receipts.find((entry): entry is ResponseReceipt => entry.kind === 'RESPONSE');
      assert.ok(receipt !== undefined);
      return { kind: result.kind, ...('reason' in result ? { reason: result.reason } : {}), broken: gateway.subject.broken, causes: gateway.subject.causes, receipt };
    };
    const wrongModel = await answeredBy('messages-200-wrong-model');
    assert.equal(wrongModel.kind, 'TERMINAL_FAILURE');
    assert.equal(wrongModel.broken, true);
    assert.deepEqual(wrongModel.causes, ['WRONG_MODEL']);
    assert.deepEqual(assessResponse(SONNET_5_5_US, wrongModel.receipt), { verdict: 'WRONG_MODEL', subjectBroken: true });
    const cached = await answeredBy('messages-200-cache');
    assert.equal(cached.kind, 'TERMINAL_FAILURE');
    assert.match(cached.reason ?? '', /^CACHE_TOKENS/u);
    assert.equal(cached.broken, true);
    assert.deepEqual(cached.causes, ['CACHE_TOKENS']);
    // A clean answer breaks nothing.
    const clean = await answeredBy('messages-200');
    assert.equal(clean.broken, false);
    assert.deepEqual(assessResponse(SONNET_5_5_US, clean.receipt), { verdict: 'OK', subjectBroken: false });
  });

  it('a 200 with no usage is USAGE_UNKNOWN on the receipt and in the result, so the reservation is billed at its maximum; the public projection carries digests only and no sentinel', async () => {
    const bundle = makeBundle('b04-usage-unknown');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const receipts: ProtectedReceipt[] = [];
      const oracle = oracleFetch();
      // The oracle's answer with its usage member removed: the documented 200 shape of recordings/messages-200-no-usage.json.
      const noUsage: VertexFetch = async (url, init) => {
        const answered = await oracle.fetchImpl(url, init);
        const body = JSON.parse(await new Response(answered.body as ReadableStream<Uint8Array>).text()) as Record<string, unknown>;
        delete body['usage'];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const result = await createIntelligenceCore(depsFor(gatewayOver(noUsage, receipts), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.equal(result.state, 'PROPOSAL_READY', JSON.stringify(result.unresolvedItems));
      const answer = receipts.find((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
      assert.ok(answer !== undefined);
      assert.equal(answer.usage, 'USAGE_UNKNOWN');
      assert.ok(JSON.stringify(result.runLedger).includes('usage unknown; reservation billed at full size'));
      // The public projection: digests only. The prompt's own text and the answer's text appear nowhere in it.
      const publicText = JSON.stringify(receipts.map(publicProjection));
      assert.match(publicText, /"usage":"USAGE_UNKNOWN"/u);
      assert.match(publicText, /"bodySha256":"[0-9a-f]{64}"/u);
      const sentinels: string[] = [];
      const request = receipts.find((receipt) => receipt.kind === 'REQUEST');
      assert.ok(request !== undefined && request.kind === 'REQUEST');
      sentinels.push(request.bodyBytes.slice(request.bodyBytes.indexOf('"content"') + 11, request.bodyBytes.indexOf('"content"') + 60), answer.bodyText.slice(40, 90));
      for (const sentinel of sentinels) for (const form of forms(sentinel)) assert.ok(!publicText.includes(form), `no ${JSON.stringify(sentinel)} in the public projection`);
    } finally {
      bundle.dispose();
    }
  });
});

/** A gateway request built from the real core's own builder inputs: a one-task envelope is not needed, only the pins the transport gateway checks. */
async function gatewayRequest(): Promise<GatewayRequest> {
  const bundle = makeBundle('b04-gateway-request');
  try {
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const input = inputFor('CLEAN_ONLY', profiled, null);
    const seen: GatewayRequest[] = [];
    const clock = new VirtualClock();
    const capture = { name: 'capture', evidenceClass: 'SIMULATED' as const, async analyze(request: GatewayRequest) { seen.push(request); return { kind: 'AMBIGUOUS' as const, reason: 'captured' }; } };
    await createIntelligenceCore(depsFor(capture, realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT).catch(() => undefined);
    const first = seen[0];
    assert.ok(first !== undefined, 'the core made a gateway request');
    return first;
  } finally {
    bundle.dispose();
  }
}

const BEDROCK_CREDENTIALS = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0038', expiresAt: '2999-01-01T00:00:00.000Z' });

type Scripted = { status: number; headers: Record<string, string>; body: unknown };

/** A Bedrock fetch answered by the offline oracle, with the token-count headers of its usage. `answer(n)` replaces the answer of call n; `lose(n)` drops it after the body was written. */
function bedrockOracleFetch(options: { readonly lose?: (call: number) => boolean; readonly answer?: (call: number) => Scripted | null } = {}): { readonly fetchImpl: BedrockFetch; calls(): number } {
  const oracle = oracleTransport();
  let calls = 0;
  const fetchImpl: BedrockFetch = async (_url, init) => {
    calls += 1;
    const text = Buffer.from(await drain(init.body)).toString('utf8');
    if (options.lose?.(calls) === true) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const scripted = options.answer?.(calls) ?? null;
    if (scripted !== null) return new Response(JSON.stringify(scripted.body), { status: scripted.status, headers: scripted.headers });
    const { anthropic_version: _version, ...rest } = JSON.parse(text) as Record<string, unknown>;
    const answered = await oracle({ model: SONNET_5_5_US.modelId, ...rest } as never, '2999-01-01T00:00:00.000Z');
    const body: Record<string, unknown> = { ...(answered.body as Record<string, unknown>), id: `msg_bdrk_01SIMULATED${String(calls).padStart(4, '0')}` };
    const usage = body['usage'] as { input_tokens: number; output_tokens: number } | undefined;
    const counts: Record<string, string> = usage === undefined ? {} : { 'x-amzn-bedrock-input-token-count': String(usage.input_tokens), 'x-amzn-bedrock-output-token-count': String(usage.output_tokens) };
    return new Response(JSON.stringify(body), { status: answered.status, headers: { 'content-type': 'application/json', 'x-amzn-requestid': `5e1f0c3a-0000-4000-8000-${String(calls).padStart(12, '0')}`, ...counts } });
  };
  return { fetchImpl, calls: () => calls };
}

const bedrockOver = (fetchImpl: BedrockFetch, receipts: ProtectedReceipt[]): ReturnType<typeof bedrockGateway> => bedrockGateway({ region: 'us-east-1', profile: SONNET_5_5_US, credentialProvider: BEDROCK_CREDENTIALS, fetchImpl, sink: (receipt) => { receipts.push(receipt); }, now: () => 0 });

describe('B04-RECEIPTS: request and response receipts through the Bedrock gateway (SIMULATED, no network)', () => {
  it('S038 Bedrock: an AFTER_SEND loss is AMBIGUOUS with the hold kept and reconciles by the msg_bdrk id and x-amzn-requestid', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b04-s038-bdrk');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const clock = new VirtualClock();
      const receipts: ProtectedReceipt[] = [];
      const wire = bedrockOracleFetch({ lose: (call) => call === 1 });
      const lostRun = await createIntelligenceCore(depsFor(bedrockOver(wire.fetchImpl, receipts), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, CONTEXT);
      assert.equal(wire.calls(), 1, 'one fetch: the adapter never retries');
      const ambiguous = ofKind(lostRun.runLedger, 'AMBIGUOUS');
      assert.equal(ambiguous.length, 1);
      assert.match(String(ambiguous[0]?.['reason']), /AFTER_SEND/u);
      assert.equal(ambiguousCount(lostRun), 1, 'the reservation is held at its maximum charge');
      const requests = receipts.filter((receipt) => receipt.kind === 'REQUEST');
      assert.equal(requests.length, 1);
      const reserved = ofKind(lostRun.runLedger, 'RESERVED').find((fact) => (fact['reservation'] as { reservationId: string }).reservationId === ambiguous[0]?.['reservationId']);
      const ref = (reserved?.['reservation'] as { requestKey: string } | undefined)?.requestKey ?? '';
      assert.equal(requests[0]?.idempotencyRef, ref, 'journal reservation and request receipt share the idempotency ref');
      assert.deepEqual(reconcileBedrock(receipts, ref), { idempotencyRef: ref, requests: 1, responses: 0, providerMessageId: null, awsRequestId: null }, 'nothing answered yet');
      const recording = loadBedrockRecording('messages-200');
      const later = responseReceipt({ status: 200, headers: recording.headers, bodyText: JSON.stringify(recording.body), bodyLength: JSON.stringify(recording.body).length, truncated: false, latencyMs: 0, idempotencyRef: ref, runId: requests[0]?.runId ?? null });
      const reconciled = reconcileBedrock([...receipts, later], ref);
      assert.equal(reconciled.providerMessageId, 'msg_bdrk_01SIMULATED0001');
      assert.equal(reconciled.awsRequestId, recording.headers['x-amzn-requestid']);
      assert.equal(reconcileBedrock([...receipts, later], 'idem-of-another-request').providerMessageId, null, 'another ref does not reconcile');
      assert.equal(wire.calls(), 1, 'reconciliation is a lookup, not a send');
      // The control: the same run with nothing lost drafts, every answer carries a msg_bdrk id and an AWS request id.
      const clean: ProtectedReceipt[] = [];
      const ok = await createIntelligenceCore(depsFor(bedrockOver(bedrockOracleFetch().fetchImpl, clean), realValidationPort(bundle, profiled.profile, null, { clock }), clock)).run(input, { ...CONTEXT, auditAttemptId: 'attempt-b04-s038-bdrk-clean' });
      assert.equal(ok.state, 'PROPOSAL_READY', JSON.stringify(ok.unresolvedItems));
      assert.equal(ambiguousCount(ok), 0, 'confirmed usage settles; nothing is held');
      for (const answer of clean.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE')) assert.match(String(reconcileBedrock(clean, answer.idempotencyRef ?? '').awsRequestId), /^5e1f0c3a-/u);
    } finally {
      bundle.dispose();
    }
  });

  it('G23 RACE (crash before SETTLE): a 429 receipt lets reconciliation release the AMBIGUOUS hold; a 503, another 429 class, a 429 naming usage or a missing answer keeps it held', { timeout: 120_000 }, async () => {
    const bundle = makeBundle('b04-g23');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const throttled = (type: string, extra: Record<string, string> = {}, body: unknown = { message: 'Too many requests, please wait before trying again.' }) => (): Scripted => ({ status: 429, headers: { 'content-type': 'application/json', 'x-amzn-requestid': '5e1f0c3a-0000-4000-8000-0000000000aa', 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`, ...extra }, body });
      const cases: { name: string; answer: (call: number) => Scripted | null; decision: 'RELEASE' | 'KEEP_AMBIGUOUS' }[] = [
        { name: 'documented throttling', answer: throttled('ThrottlingException'), decision: 'RELEASE' },
        { name: 'service unavailable', answer: () => ({ status: 503, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ServiceUnavailableException:x' }, body: { message: 'unavailable' } }), decision: 'KEEP_AMBIGUOUS' },
        { name: 'another 429 class', answer: throttled('ServiceQuotaExceededException'), decision: 'KEEP_AMBIGUOUS' },
        { name: 'a 429 naming usage', answer: throttled('ThrottlingException', {}, { message: 'x', usage: { input_tokens: 10, output_tokens: 0 } }), decision: 'KEEP_AMBIGUOUS' },
        { name: 'a 429 with token counts', answer: throttled('ThrottlingException', { 'x-amzn-bedrock-input-token-count': '10', 'x-amzn-bedrock-output-token-count': '0' }), decision: 'KEEP_AMBIGUOUS' },
      ];
      for (const [index, one] of cases.entries()) {
        const clock = new VirtualClock();
        const store = new InterleavingLedgerStore();
        const receipts: ProtectedReceipt[] = [];
        const inner = bedrockOver(bedrockOracleFetch({ answer: one.answer }).fetchImpl, receipts);
        // The process dies after the provider answered and before the kernel settles the reservation.
        const gateway: ModelGateway = { name: 'dying', evidenceClass: inner.evidenceClass, async analyze(request) { const answer = await inner.analyze(request); store.schedule(() => { throw new ProcessDied(); }); return answer; } };
        const context = { ...CONTEXT, auditAttemptId: `attempt-b04-g23-${String(index)}` };
        await assert.rejects(createIntelligenceCore({ ...depsFor(gateway, realValidationPort(bundle, profiled.profile, null, { clock }), clock), ledgerStore: store }).run(input, context), (error: unknown) => error instanceof ProcessDied);
        const events = store.read(runIdOf(context));
        assert.equal(ofKind(events, 'SEND_STARTED').length, 1, `${one.name}: sent once`);
        for (const settled of ['RELEASED', 'COMMITTED', 'AMBIGUOUS']) assert.equal(ofKind(events, settled).length, 0, `${one.name}: nothing settled before the crash (${settled})`);
        const reserved = ofKind(events, 'RESERVED')[0];
        const ref = (reserved?.['reservation'] as { requestKey: string } | undefined)?.requestKey ?? '';
        const decided = reconcileAmbiguousHold(receipts, ref);
        assert.equal(decided.decision, one.decision, `${one.name}: ${JSON.stringify(decided)}`);
        if (decided.decision === 'RELEASE') {
          assert.equal(decided.reason, 'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors');
          assert.equal(decided.awsRequestId, '5e1f0c3a-0000-4000-8000-0000000000aa');
        }
        assert.equal(reconcileAmbiguousHold(receipts, 'idem-of-another-request').decision, 'KEEP_AMBIGUOUS', `${one.name}: no receipt under the ref proves nothing`);
        const truncated = receipts.map((receipt) => (receipt.kind === 'RESPONSE' ? { ...receipt, truncated: true } : receipt));
        assert.equal(reconcileAmbiguousHold(truncated, ref).decision, 'KEEP_AMBIGUOUS', `${one.name}: a body not read whole proves nothing`);
        const resent = [...receipts, ...receipts.filter((receipt) => receipt.kind === 'REQUEST')];
        assert.equal(reconcileAmbiguousHold(resent, ref).decision, 'KEEP_AMBIGUOUS', `${one.name}: two requests under one ref prove nothing`);
      }
    } finally {
      bundle.dispose();
    }
  });
});
