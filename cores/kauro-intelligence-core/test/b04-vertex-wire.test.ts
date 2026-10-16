import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SONNET_5_5_US } from '../src/gateway/candidates.js';
import { TransportError, parseProviderResponse } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest } from '../src/gateway/transport-gateway.js';
import { VERTEX_ANTHROPIC_VERSION, dispatchVertex, preflightVertexBody, toVertexBody, vertexUrl } from '../src/provider/vertex-wire.js';
import { vertexTransport } from '../src/provider/vertex-transport.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import { MODES, runVector } from './support/egress-harness.js';
import type { Vector } from './support/egress-harness.js';

const VECTOR: Vector = { id: 'wire-status', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] };

/** Every ProviderRequest the real core path (privacy layer included) hands the transport, in every target mode, through the repair path as well; SIMULATED answers. */
async function b03Requests(): Promise<readonly ProviderRequest[]> {
  const out: ProviderRequest[] = [];
  for (const mode of MODES) {
    const observed = await runVector(mode, VECTOR);
    for (const bytes of observed.requests) out.push(JSON.parse(bytes) as ProviderRequest);
  }
  return out;
}

const official = (): ProviderRequest => ({
  model: SONNET_5_5_US.modelId,
  max_tokens: 8192,
  system: 'system',
  messages: [{ role: 'user', content: '<request>\n{}\n</request>' }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' },
  tools: [],
});

const refusal = (run: () => unknown): TransportError => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TransportError, 'a TransportError');
    assert.equal(error.stage, 'BEFORE_SEND');
    return error;
  }
  assert.fail('expected a refusal');
};

describe('B04-WIRE: Vertex body, URL and preflight (SIMULATED, no network)', () => {
  it('IC-13: a body with temperature, top_p, metadata, stream, cache_control, a model member or an unknown member is refused BEFORE_SEND with no byte written; the official rawPredict body with anthropic_version vertex-2023-10-16 passes', async () => {
    // Through the adapter the core actually calls (Codex B04-R6): vertexTransport over a ProviderRequest, with a fetch that counts.
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    let fetched = 0;
    const receipts: ProtectedReceipt[] = [];
    const transport = vertexTransport({
      project: 'kauro-sim-project', profile: SONNET_5_5_US, now: () => now, sink: (receipt) => { receipts.push(receipt); },
      tokenProvider: async () => ({ token: 'ya29.SIMULATED-TOKEN-NOT-A-SECRET-0013', expiresAt: '2026-10-01T13:00:00.000Z' }),
      fetchImpl: async () => { fetched += 1; return { status: 200, headers: { get: () => null, forEach: () => undefined }, body: null }; },
    });
    const send = (request: unknown): Promise<unknown> => transport(request as ProviderRequest, '2026-10-01T12:05:00.000Z', { idempotencyRef: 'idem-ic13', runId: 'run-ic13' });
    const topLevel: Record<string, unknown> = { temperature: 0.5, top_p: 1, top_k: 1, metadata: { unexpected: true }, stream: false, cache_control: { type: 'ephemeral' }, thinking: { type: 'disabled' }, tool_choice: { type: 'none' }, anthropic_version: 'vertex-2023-10-16', unknown_member: 1 };
    for (const [name, value] of Object.entries(topLevel)) {
      await assert.rejects(send({ ...official(), [name]: value }), (error: unknown) => error instanceof TransportError && error.stage === 'BEFORE_SEND', `${name}: refused before sending`);
    }
    for (const nested of [{ ...official(), messages: [{ role: 'user', content: 'x', cache_control: { type: 'ephemeral' } }] }, { ...official(), output_config: { ...official().output_config, temperature: 0 } }, { ...official(), tools: [{ name: 't' }] }]) {
      await assert.rejects(send(nested), (error: unknown) => error instanceof TransportError && error.stage === 'BEFORE_SEND', JSON.stringify(nested).slice(0, 80));
    }
    assert.equal(fetched, 0, 'no refused request reached fetch');
    assert.deepEqual(receipts, [], 'no request receipt: nothing was written');
    await send(official());
    assert.equal(fetched, 1, 'the control: the official request through the same transport is sent');

    const good = toVertexBody(official());
    assert.equal(good.anthropic_version, 'vertex-2023-10-16');
    assert.equal(VERTEX_ANTHROPIC_VERSION, 'vertex-2023-10-16');
    assert.ok(!('model' in good));
    preflightVertexBody(good);
    const extras: Record<string, unknown> = { temperature: 0, top_p: 1, top_k: 1, metadata: { user_id: 'u' }, stream: false, cache_control: { type: 'ephemeral' }, model: 'claude-sonnet-5-5', thinking: { type: 'disabled' }, tool_choice: { type: 'none' }, unknown_member: 1 };
    for (const [name, value] of Object.entries(extras)) {
      let written = 0;
      refusal(() => dispatchVertex('p', SONNET_5_5_US.modelId, { ...good, [name]: value }, () => { written += 1; }));
      assert.equal(written, 0, `${name}: no byte written`);
    }
    for (const bad of [{ ...good, anthropic_version: 'vertex-2024-01-01' }, { ...good, max_tokens: 0 }, { ...good, max_tokens: 99999 }, { ...good, tools: [{ name: 't' }] }, { ...good, output_config: { ...good.output_config, effort: 'medium' } }, { ...good, output_config: { ...good.output_config, effort: 'max' } }, { ...good, messages: [{ role: 'assistant', content: 'x' }] }, { ...good, messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] }, { ...good, output_config: { ...good.output_config, format: { type: 'text', schema: {} } } }]) refusal(() => preflightVertexBody(bad));
    let sent: { url: string; bytes: string } | null = null;
    dispatchVertex('proj-1', SONNET_5_5_US.modelId, good, (url, bytes) => { sent = { url, bytes }; });
    assert.ok(sent !== null);
    const dispatched = sent as { url: string; bytes: string };
    assert.deepEqual(JSON.parse(dispatched.bytes), good);
    assert.equal(dispatched.bytes, dispatched.bytes.trim(), 'serialized once, canonical');
  });

  it('S037: every Vertex body carries tools [] and no tool_choice, and a recorded response with a tool_use block is a terminal failure', async () => {
    const requests = await b03Requests();
    assert.ok(requests.length >= 3, 'the real path produced requests');
    for (const request of requests) {
      const body = toVertexBody(request);
      assert.deepEqual(body.tools, []);
      assert.ok(!('tool_choice' in body));
      preflightVertexBody(body);
    }
    const toolUse = parseProviderResponse({ status: 200, body: { model: SONNET_5_5_US.modelId, stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } } }, SONNET_5_5_US.modelId);
    assert.equal(toolUse.kind, 'TERMINAL_FAILURE');
  });

  it('a body built from every B03 fixture request passes preflight', async () => {
    const requests = await b03Requests();
    for (const request of requests) {
      const body = toVertexBody(request);
      preflightVertexBody(body);
      assert.equal(body.max_tokens, request.max_tokens);
    }
  });

  it('the rawPredict URL is https://aiplatform.us.rep.googleapis.com/v1/projects/{p}/locations/us/publishers/anthropic/models/{m}:rawPredict and no other host or location can be built', () => {
    assert.equal(vertexUrl('my-proj-1', 'claude-sonnet-5-5'), 'https://aiplatform.us.rep.googleapis.com/v1/projects/my-proj-1/locations/us/publishers/anthropic/models/claude-sonnet-5-5:rawPredict');
    for (const [project, model] of [['p/../x', 'm'], ['p', 'm/../x'], ['p@evil.test', 'm'], ['p', 'm:streamRawPredict'], ['', 'm'], ['p', ''], ['p?x=1', 'm'], ['p#', 'm'], ['P', 'm'], ['p', 'm\n']] as const) refusal(() => vertexUrl(project, model));
    assert.ok(vertexUrl('p1234', 'm').startsWith('https://aiplatform.us.rep.googleapis.com/'));
    assert.ok(!vertexUrl('p1234', 'm').includes('global') && !vertexUrl('p1234', 'm').includes('europe'));
  });
});
