import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { OPUS_5_5_US, SONNET_5_5_US } from '../src/gateway/candidates.js';
import { TransportError, parseProviderResponse, readRawBody } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest } from '../src/gateway/transport-gateway.js';
import { BEDROCK_ANTHROPIC_VERSION, bedrockUrl, dispatchBedrock, preflightBedrockBody, toBedrockBody } from '../src/provider/bedrock-wire.js';
import { bedrockTransport } from '../src/provider/bedrock-transport.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import { MODES, runVector } from './support/egress-harness.js';
import type { Vector } from './support/egress-harness.js';
import { loadBedrockRecording, replayBedrock } from './support/bedrock-replay.js';

const VECTOR: Vector = { id: 'bedrock-wire-status', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] };
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DEADLINE = '2026-10-01T12:05:00.000Z';
/** SIMULATED temporary credentials: the AWS documentation's example key pair and a session token that is no secret. */
const credentialProvider = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0013', expiresAt: '2026-10-01T13:00:00.000Z' });

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
    assert.ok(error instanceof TransportError, `a TransportError, got ${String(error)}`);
    assert.equal(error.stage, 'BEFORE_SEND');
    return error;
  }
  return assert.fail('expected a refusal');
};

describe('B04-BEDROCK-WIRE: InvokeModel body, URL and preflight (SIMULATED, no network)', () => {
  it('IC-13 Bedrock: a body with temperature, top_p, metadata, stream, anthropic_beta, a model member or an unknown member is refused BEFORE_SEND with no byte written; the InvokeModel body with anthropic_version bedrock-2023-05-31 passes', async () => {
    let fetched = 0;
    const receipts: ProtectedReceipt[] = [];
    const transport = bedrockTransport({
      region: 'us-east-1', profile: SONNET_5_5_US, now: () => NOW, sink: (receipt) => { receipts.push(receipt); }, credentialProvider,
      fetchImpl: async () => { fetched += 1; return { status: 200, headers: { get: () => null, forEach: () => undefined }, body: null }; },
    });
    const send = (request: unknown): Promise<unknown> => transport(request as ProviderRequest, DEADLINE, { idempotencyRef: 'idem-ic13-bdrk', runId: 'run-ic13-bdrk' });
    const topLevel: Record<string, unknown> = { temperature: 0.5, top_p: 1, top_k: 1, metadata: { user_id: 'u' }, stream: false, anthropic_beta: ['output-128k-2025-02-19'], stop_sequences: ['x'], cache_control: { type: 'ephemeral' }, thinking: { type: 'disabled' }, tool_choice: { type: 'none' }, anthropic_version: BEDROCK_ANTHROPIC_VERSION, unknown_member: 1 };
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

    const good = toBedrockBody(official());
    assert.equal(BEDROCK_ANTHROPIC_VERSION, 'bedrock-2023-05-31');
    assert.equal(good.anthropic_version, 'bedrock-2023-05-31');
    assert.ok(!('model' in good), 'the model travels in the URL as the inference profile, never in the body');
    preflightBedrockBody(good);
    const extras: Record<string, unknown> = { temperature: 0, top_p: 1, top_k: 1, metadata: { user_id: 'u' }, stream: false, anthropic_beta: ['context-1m-2025-08-07'], cache_control: { type: 'ephemeral' }, model: 'claude-sonnet-5-5', thinking: { type: 'disabled' }, tool_choice: { type: 'none' }, unknown_member: 1 };
    for (const [name, value] of Object.entries(extras)) {
      let written = 0;
      refusal(() => dispatchBedrock('us-east-1', SONNET_5_5_US.inferenceProfileId, { ...good, [name]: value }, () => { written += 1; }));
      assert.equal(written, 0, `${name}: no byte written`);
    }
    for (const bad of [{ ...good, anthropic_version: 'vertex-2023-10-16' }, { ...good, anthropic_version: 'bedrock-2024-01-01' }, { ...good, max_tokens: 0 }, { ...good, max_tokens: 99999 }, { ...good, tools: [{ name: 't' }] }, { ...good, output_config: { ...good.output_config, effort: 'medium' } }, { ...good, messages: [{ role: 'assistant', content: 'x' }] }, { ...good, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, { ...good, output_config: { ...good.output_config, format: { type: 'text', schema: {} } } }]) refusal(() => preflightBedrockBody(bad));
    let sent: { url: string; bytes: string } | null = null;
    dispatchBedrock('us-east-1', SONNET_5_5_US.inferenceProfileId, good, (url, bytes) => { sent = { url, bytes }; });
    assert.ok(sent !== null);
    const dispatched = sent as { url: string; bytes: string };
    assert.deepEqual(JSON.parse(dispatched.bytes), good);
    assert.equal(dispatched.url, `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(SONNET_5_5_US.inferenceProfileId)}/invoke`);
  });

  it('S037 Bedrock: every body carries tools [] and no tool_choice; a tool_use block in a recorded response is a terminal failure', async () => {
    const requests = await b03Requests();
    assert.ok(requests.length >= 3, 'the real path produced requests');
    for (const request of requests) {
      const body = toBedrockBody(request);
      assert.deepEqual(body.tools, []);
      assert.ok(!('tool_choice' in body));
      assert.equal(body.anthropic_version, BEDROCK_ANTHROPIC_VERSION);
      preflightBedrockBody(body);
    }
    const { fetchImpl, writes } = replayBedrock(loadBedrockRecording('messages-200-tool-use'));
    const transport = bedrockTransport({ region: 'us-east-1', profile: SONNET_5_5_US, now: () => NOW, credentialProvider, fetchImpl });
    const response = await transport(official(), DEADLINE, { idempotencyRef: 'idem-s037', runId: 'run-s037' });
    assert.equal(writes.length, 1);
    const written = JSON.parse(writes[0]?.text ?? '{}') as Record<string, unknown>;
    assert.deepEqual(written['tools'], [], 'the written bytes carry tools []');
    assert.ok(!('tool_choice' in written));
    assert.ok(response.bodyChunks !== undefined);
    const raw = await readRawBody(response.bodyChunks);
    assert.equal(raw.kind, 'BODY');
    const parsed = parseProviderResponse({ ...response, body: raw.kind === 'BODY' ? raw.body : null }, SONNET_5_5_US.modelId);
    assert.equal(parsed.kind, 'TERMINAL_FAILURE');
    assert.match(parsed.kind === 'TERMINAL_FAILURE' ? parsed.reason : '', /tool call/u);
  });

  it('D4-BR-1: the InvokeModel URL is https://bedrock-runtime.<us region>.amazonaws.com/model/<us. inference profile>/invoke; a global., eu., apac. or bare in-region model id, another region or a path trick is never built', () => {
    for (const profile of [SONNET_5_5_US, OPUS_5_5_US]) {
      assert.match(profile.inferenceProfileId, /^us\.anthropic\./u);
      assert.equal(profile.provider, 'AWS_BEDROCK');
    }
    assert.equal(bedrockUrl('us-east-1', 'us.anthropic.claude-sonnet-5-5-v1:0'), 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke');
    assert.ok(bedrockUrl('us-west-2', 'us.anthropic.claude-opus-5-5').startsWith('https://bedrock-runtime.us-west-2.amazonaws.com/model/'));
    for (const [region, profile] of [['us-east-1', 'global.anthropic.claude-sonnet-5-5'], ['us-east-1', 'eu.anthropic.claude-sonnet-5-5'], ['us-east-1', 'apac.anthropic.claude-sonnet-5-5'], ['us-east-1', 'anthropic.claude-sonnet-5-5'], ['us-east-1', 'us.meta.llama'], ['eu-west-1', 'us.anthropic.claude-sonnet-5-5'], ['us-gov-west-1', 'us.anthropic.claude-sonnet-5-5'], ['us-east-1', 'us.anthropic.x/../converse'], ['us-east-1', 'us.anthropic.x?y=1'], ['us-east-1', 'us.anthropic.X'], ['us-east-1', ''], ['us-east-1', 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-5-5'], ['', 'us.anthropic.claude-sonnet-5-5']] as const) refusal(() => bedrockUrl(region, profile));
  });
});
