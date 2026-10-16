import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SONNET_5_5_US } from '../src/gateway/candidates.js';
import { RAW_BODY_REASONS, TransportError, parseProviderResponse, readRawBody } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest, ProviderResponse } from '../src/gateway/transport-gateway.js';
import { publicProjection } from '../src/provider/vertex-receipts.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import { toVertexBody, vertexUrl } from '../src/provider/vertex-wire.js';
import { vertexTransport } from '../src/provider/vertex-transport.js';
import type { VertexFetch } from '../src/provider/vertex-transport.js';
import { canonicalJson } from '../src/contracts/canonical.js';
import { forms } from './support/egress-harness.js';
import { drain, loadRecording, replay } from './support/vertex-replay.js';

const SENTINEL = 'SENTINEL-Ñandú-7731';
const TOKEN = 'ya29.SIMULATED-TOKEN-NOT-A-SECRET-0001';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DEADLINE = '2026-10-01T12:05:00.000Z';

const request = (content = `<request>\n{}\n</request>\n${SENTINEL}`): ProviderRequest => ({
  model: SONNET_5_5_US.modelId,
  max_tokens: 8192,
  system: 'system',
  messages: [{ role: 'user', content }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' },
  tools: [],
});

const tokenProvider = async (): Promise<{ token: string; expiresAt: string }> => ({ token: TOKEN, expiresAt: '2026-10-01T13:00:00.000Z' });
const correlation = { idempotencyRef: 'idem-0001', runId: 'run-0001' };

function transportOver(fetchImpl: VertexFetch, receipts: ProtectedReceipt[] = []): ReturnType<typeof vertexTransport> {
  return vertexTransport({ project: 'kauro-sim-project', profile: SONNET_5_5_US, tokenProvider, fetchImpl, sink: (receipt) => { receipts.push(receipt); }, now: () => NOW });
}

async function failureOf(run: () => Promise<unknown>): Promise<TransportError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof TransportError, `a TransportError, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected a TransportError');
}

describe('B04-TRANSPORT: the Vertex fetch transport (SIMULATED recordings, no network)', () => {
  it('S040: the Vertex transport hands the raw response chunks to the decoder; a UTF-8 character split across chunks drafts the same as unsplit, and a truncated body is a typed failure', async () => {
    const recording = loadRecording('messages-200');
    const decode = async (chunkSize: number | undefined): Promise<{ response: ProviderResponse; body: unknown }> => {
      const { fetchImpl } = replay(recording, chunkSize === undefined ? {} : { chunkSize });
      const response = await transportOver(fetchImpl)(request(), DEADLINE, correlation);
      assert.equal(response.status, 200);
      assert.equal(response.body, undefined, 'raw chunks, not a built body');
      assert.ok(response.bodyChunks !== undefined, 'the chunks are handed over');
      const raw = await readRawBody(response.bodyChunks);
      assert.equal(raw.kind, 'BODY');
      return { response, body: raw.kind === 'BODY' ? raw.body : null };
    };
    const whole = await decode(undefined);
    const bytewise = await decode(1);
    const threes = await decode(3);
    assert.deepEqual(bytewise.body, whole.body, 'a character split across chunks decodes whole');
    assert.deepEqual(threes.body, whole.body);
    const parsed = parseProviderResponse({ ...whole.response, body: whole.body }, SONNET_5_5_US.modelId);
    assert.equal(parsed.kind, 'RESPONSE');
    assert.equal(parsed.kind === 'RESPONSE' ? parsed.content : '', 'Ñandú € 😀 listo', 'no replacement character, no loss');
    // A body that stops inside a character, and one that stops inside the document, are typed failures; the provider may have billed them.
    for (const cut of [(bytes: Uint8Array) => bytes.subarray(0, bytes.indexOf(0xc3) + 1), (bytes: Uint8Array) => bytes.subarray(0, Math.floor(bytes.length / 2))]) {
      const { fetchImpl } = replay(recording, { transform: cut, chunkSize: 5 });
      const response = await transportOver(fetchImpl)(request(), DEADLINE, correlation);
      assert.ok(response.bodyChunks !== undefined);
      const raw = await readRawBody(response.bodyChunks);
      assert.equal(raw.kind, 'FAILED');
      assert.deepEqual(raw.kind === 'FAILED' ? raw.result : null, { kind: 'AMBIGUOUS', reason: RAW_BODY_REASONS.EARLY_END });
    }
    // A stream that fails mid-body is the same typed failure.
    const { fetchImpl } = replay(recording, { chunkSize: 40, failAfterBody: new Error('socket closed') });
    const response = await transportOver(fetchImpl)(request(), DEADLINE, correlation);
    assert.ok(response.bodyChunks !== undefined);
    const raw = await readRawBody(response.bodyChunks);
    assert.equal(raw.kind === 'FAILED' ? raw.result.kind : null, 'AMBIGUOUS');
  });

  it('R2-028: recorded Vertex 400, 403, 404, 429 and 500 bodies echoing the prompt are kept only in the protected record; the result, telemetry and receipts carry status, class and digest', async () => {
    const expected: Record<number, string> = { 400: 'BAD_REQUEST', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RATE_LIMITED', 500: 'SERVER_ERROR' };
    for (const status of [400, 403, 404, 429, 500]) {
      const recording = loadRecording(`error-${String(status)}`);
      const receipts: ProtectedReceipt[] = [];
      const { fetchImpl, writes } = replay(recording);
      const response = await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
      assert.equal(writes.length, 1, `${String(status)}: one fetch, no retry`);
      assert.equal(response.status, status);
      assert.equal(response.body, undefined, 'no provider text on the response');
      assert.equal(response.bodyChunks, undefined);
      if (status === 429) assert.equal(response.retryAfterMs, 7000, 'retry-after in milliseconds');
      const result = parseProviderResponse(response, SONNET_5_5_US.modelId);
      assert.match(JSON.stringify(result), new RegExp(`provider status ${String(status)}`, 'u'));
      assert.deepEqual(result.kind, status === 429 || status === 500 ? 'RETRYABLE_FAILURE' : 'TERMINAL_FAILURE');
      const protectedResponse = receipts.find((receipt) => receipt.kind === 'RESPONSE');
      assert.ok(protectedResponse !== undefined && protectedResponse.kind === 'RESPONSE');
      assert.ok(protectedResponse.bodyText.includes(SENTINEL), 'the echoed prompt is in the protected record');
      assert.equal(protectedResponse.errorClass, expected[status]);
      const publicText = JSON.stringify(receipts.map(publicProjection));
      const outbound = `${publicText}${JSON.stringify(response)}${JSON.stringify(result)}`;
      for (const form of forms(SENTINEL)) assert.ok(!outbound.includes(form), `${String(status)}: no sentinel in ${form}`);
      assert.ok(!outbound.includes('Ñandú'), 'not even a fragment');
      assert.match(publicText, new RegExp(`"errorClass":"${expected[status] ?? ''}"`, 'u'));
      assert.match(publicText, /"bodyDigest":"[0-9a-f]{64}"/u);
    }
  });

  it('a thrown fetch after the body stream started is AFTER_SEND; before it, a connect failure is BEFORE_SEND and anything else is UNKNOWN; the transport never retries', async () => {
    let calls = 0;
    const afterStart: VertexFetch = async (_url, init) => {
      calls += 1;
      await drain(init.body);
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    };
    assert.equal((await failureOf(() => transportOver(afterStart)(request(), DEADLINE, correlation))).stage, 'AFTER_SEND');
    assert.equal(calls, 1, 'one fetch');
    const connect: VertexFetch = async () => {
      calls += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    assert.equal((await failureOf(() => transportOver(connect)(request(), DEADLINE, correlation))).stage, 'BEFORE_SEND');
    const unknown: VertexFetch = async () => {
      calls += 1;
      throw new Error('boom');
    };
    assert.equal((await failureOf(() => transportOver(unknown)(request(), DEADLINE, correlation))).stage, 'UNKNOWN');
    assert.equal(calls, 3, 'each attempt is one fetch');
  });

  it('what is written is the preflighted canonical buffer at the one URL; a refused body, a model that is not the profile, a failing token provider or a passed deadline write nothing', async () => {
    const recording = loadRecording('messages-200');
    const { fetchImpl, writes } = replay(recording);
    const receipts: ProtectedReceipt[] = [];
    await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
    assert.equal(writes.length, 1);
    const written = writes[0];
    assert.ok(written !== undefined);
    assert.equal(written.text, canonicalJson(toVertexBody(request())), 'the canonical bytes, once');
    assert.equal(written.url, vertexUrl('kauro-sim-project', SONNET_5_5_US.modelId));
    assert.equal(written.headers['authorization'], `Bearer ${TOKEN}`);
    assert.equal(written.headers['content-type'], 'application/json');
    assert.ok(!Object.keys(written.headers).some((name) => /^anthropic-beta$/iu.test(name)));
    const sent = receipts.find((receipt) => receipt.kind === 'REQUEST');
    assert.ok(sent !== undefined && sent.kind === 'REQUEST');
    assert.equal(sent.bodyBytes, written.text);
    assert.ok(!JSON.stringify(receipts).includes(TOKEN), 'the token is in no receipt');
    const none = replay(recording);
    const refuse = async (run: () => Promise<unknown>): Promise<void> => {
      assert.equal((await failureOf(run)).stage, 'BEFORE_SEND');
    };
    await refuse(() => transportOver(none.fetchImpl)({ ...request(), max_tokens: 0 }, DEADLINE, correlation));
    await refuse(() => transportOver(none.fetchImpl)({ ...request(), model: 'claude-opus-5-5' }, DEADLINE, correlation));
    await refuse(() => transportOver(none.fetchImpl)(request(), '2026-10-01T11:00:00.000Z', correlation));
    await refuse(() => vertexTransport({ project: 'kauro-sim-project', profile: SONNET_5_5_US, tokenProvider: async () => { throw new Error('no credentials'); }, fetchImpl: none.fetchImpl, now: () => NOW })(request(), DEADLINE, correlation));
    await refuse(() => vertexTransport({ project: 'kauro-sim-project', profile: SONNET_5_5_US, tokenProvider: async () => ({ token: TOKEN, expiresAt: '2026-10-01T11:59:00.000Z' }), fetchImpl: none.fetchImpl, now: () => NOW })(request(), DEADLINE, correlation));
    await refuse(() => vertexTransport({ project: 'Not A Project', profile: SONNET_5_5_US, tokenProvider, fetchImpl: none.fetchImpl, now: () => NOW })(request(), DEADLINE, correlation));
    assert.equal(none.writes.length, 0, 'nothing was written');
  });
});
