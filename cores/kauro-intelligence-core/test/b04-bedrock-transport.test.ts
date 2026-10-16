import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { SONNET_5_5_US } from '../src/gateway/candidates.js';
import { RAW_BODY_REASONS, TransportError, parseProviderResponse, readRawBody } from '../src/gateway/transport-gateway.js';
import type { GatewayResult } from '../src/gateway/model-gateway.js';
import type { ProviderRequest, ProviderResponse } from '../src/gateway/transport-gateway.js';
import { publicProjection } from '../src/provider/vertex-receipts.js';
import type { ProtectedReceipt, ResponseReceipt } from '../src/provider/vertex-receipts.js';
import { bedrockAssessment } from '../src/provider/bedrock-gateway.js';
import { headerUsage } from '../src/provider/bedrock-receipts.js';
import { amzDateOf, canonicalUri, signV4 } from '../src/provider/bedrock-sigv4.js';
import { bedrockTransport } from '../src/provider/bedrock-transport.js';
import type { BedrockFetch } from '../src/provider/bedrock-transport.js';
import { forms } from './support/egress-harness.js';
import { drain, loadBedrockRecording, replayBedrock } from './support/bedrock-replay.js';

const SENTINEL = 'SENTINEL-Ñandú-7741';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const DEADLINE = '2026-10-01T12:05:00.000Z';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const SESSION = 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0001';
const credentialProvider = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: SECRET, sessionToken: SESSION, expiresAt: '2026-10-01T13:00:00.000Z' });
const correlation = { idempotencyRef: 'idem-bdrk-0001', runId: 'run-bdrk-0001' };

const request = (content = `<request>\n{}\n</request>\n${SENTINEL}`): ProviderRequest => ({
  model: SONNET_5_5_US.modelId,
  max_tokens: 8192,
  system: 'system',
  messages: [{ role: 'user', content }],
  output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' },
  tools: [],
});

function transportOver(fetchImpl: BedrockFetch, receipts: ProtectedReceipt[] = [], provider = credentialProvider): ReturnType<typeof bedrockTransport> {
  return bedrockTransport({ region: 'us-east-1', profile: SONNET_5_5_US, credentialProvider: provider, fetchImpl, sink: (receipt) => { receipts.push(receipt); }, now: () => NOW });
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

describe('B04-BEDROCK-TRANSPORT: the Bedrock InvokeModel transport (SIMULATED recordings, no network)', () => {
  it('R2-028 Bedrock: recorded 400, 403, 404, 408, 424, 429, 500 and 503 bodies with x-amzn-ErrorType stay in the protected record; result, telemetry and receipts carry status, class and digest', async () => {
    const expectedClass: Record<number, string> = { 400: 'BAD_REQUEST', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 408: 'OTHER_STATUS', 424: 'OTHER_STATUS', 429: 'RATE_LIMITED', 500: 'SERVER_ERROR', 503: 'SERVER_ERROR' };
    const expectedKind: Record<number, GatewayResult['kind']> = { 400: 'TERMINAL_FAILURE', 403: 'TERMINAL_FAILURE', 404: 'TERMINAL_FAILURE', 408: 'AMBIGUOUS', 424: 'TERMINAL_FAILURE', 429: 'RETRYABLE_FAILURE', 500: 'RETRYABLE_FAILURE', 503: 'RETRYABLE_FAILURE' };
    const expectedType: Record<number, string> = { 429: 'ThrottlingException', 500: 'InternalServerException', 503: 'ServiceUnavailableException' };
    for (const status of [400, 403, 404, 408, 424, 429, 500, 503]) {
      const recording = loadBedrockRecording(`error-${String(status)}`);
      const receipts: ProtectedReceipt[] = [];
      const { fetchImpl, writes } = replayBedrock(recording);
      const response = await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
      assert.equal(writes.length, 1, `${String(status)}: one fetch, no retry`);
      assert.equal(response.status, status);
      assert.equal(response.body, undefined, 'no provider text on the response');
      assert.equal(response.bodyChunks, undefined);
      assert.equal(response.errorType, recording.headers['x-amzn-errortype'], `${String(status)}: the error type is the x-amzn-ErrorType header, as sent`);
      assert.equal(response.requestId, recording.headers['x-amzn-requestid'], `${String(status)}: the AWS request id`);
      const result = parseProviderResponse(response, SONNET_5_5_US.modelId);
      assert.equal(result.kind, expectedKind[status], `${String(status)}: ${JSON.stringify(result)}`);
      if (result.kind === 'RETRYABLE_FAILURE') assert.equal(result.providerErrorType, expectedType[status], `${String(status)}: the documented class, cut at its first ':'`);
      const protectedResponse = receipts.find((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
      assert.ok(protectedResponse !== undefined);
      assert.ok(protectedResponse.bodyText.includes(SENTINEL), 'the echoed prompt is in the protected record');
      assert.equal(protectedResponse.errorClass, expectedClass[status]);
      assert.equal(protectedResponse.headers['x-amzn-errortype'], recording.headers['x-amzn-errortype'], 'the error type header is kept in the protected record');
      const publicText = JSON.stringify(receipts.map(publicProjection));
      const outbound = `${publicText}${JSON.stringify(response)}${JSON.stringify(result)}`;
      for (const form of forms(SENTINEL)) assert.ok(!outbound.includes(form), `${String(status)}: no sentinel in ${form}`);
      assert.ok(!outbound.includes('Ñandú'), 'not even a fragment');
      assert.match(publicText, new RegExp(`"status":${String(status)},"errorClass":"${expectedClass[status] ?? ''}"`, 'u'));
      assert.match(publicText, /"bodyDigest":"[0-9a-f]{64}"/u);
      for (const secret of [SECRET, SESSION]) assert.ok(!JSON.stringify(receipts).includes(secret), `${String(status)}: no credential in any receipt`);
    }
  });

  it('S040 Bedrock: the transport hands the raw InvokeModel chunks to the decoder; a UTF-8 character split across chunks drafts the same as unsplit, and a truncated body is a typed failure', async () => {
    const recording = loadBedrockRecording('messages-200');
    const decode = async (chunkSize: number | undefined): Promise<{ response: ProviderResponse; body: unknown }> => {
      const { fetchImpl } = replayBedrock(recording, chunkSize === undefined ? {} : { chunkSize });
      const response = await transportOver(fetchImpl)(request(), DEADLINE, correlation);
      assert.equal(response.status, 200);
      assert.equal(response.body, undefined, 'raw chunks, not a built body');
      assert.ok(response.bodyChunks !== undefined);
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
    assert.equal(parsed.kind === 'RESPONSE' ? parsed.content : '', 'Ñandú € 😀 listo');
    for (const cut of [(bytes: Uint8Array) => bytes.subarray(0, bytes.indexOf(0xc3) + 1), (bytes: Uint8Array) => bytes.subarray(0, Math.floor(bytes.length / 2))]) {
      const { fetchImpl } = replayBedrock(recording, { transform: cut, chunkSize: 5 });
      const response = await transportOver(fetchImpl)(request(), DEADLINE, correlation);
      assert.ok(response.bodyChunks !== undefined);
      const raw = await readRawBody(response.bodyChunks);
      assert.deepEqual(raw.kind === 'FAILED' ? raw.result : null, { kind: 'AMBIGUOUS', reason: RAW_BODY_REASONS.EARLY_END });
    }
    const receipts: ProtectedReceipt[] = [];
    const { fetchImpl } = replayBedrock(recording, { chunkSize: 40, failAfterBody: new Error('socket closed') });
    const response = await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
    assert.ok(response.bodyChunks !== undefined);
    const raw = await readRawBody(response.bodyChunks);
    assert.equal(raw.kind === 'FAILED' ? raw.result.kind : null, 'AMBIGUOUS');
    const answer = receipts.find((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
    assert.equal(answer?.truncated, true, 'the receipt says the body broke');
  });

  it('D4-WIRE-1 SigV4: the in-house signer reproduces the AWS documented example, double-encodes the inference profile path for bedrock, and the receipt redacts the authorization and the session token', async () => {
    // The AWS General Reference SigV4 example (IAM ListUsers, 2015-08-30), the documentation's own example key.
    const signed = signV4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, sessionToken: null }, region: 'us-east-1', service: 'iam', amzDate: '20150830T123600Z' });
    assert.equal(signed.canonicalRequestSha256, 'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    assert.equal(signed.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    assert.equal(signed.headers['authorization'], 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    assert.equal(amzDateOf(Date.parse('2015-08-30T12:36:00.000Z')), '20150830T123600Z');
    assert.equal(canonicalUri('/model/us.anthropic.claude-sonnet-5-5-v1%3A0/invoke'), '/model/us.anthropic.claude-sonnet-5-5-v1%253A0/invoke', 'non-S3 services sign the path encoded twice');

    const receipts: ProtectedReceipt[] = [];
    const { fetchImpl, writes } = replayBedrock(loadBedrockRecording('messages-200'));
    await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
    const sent = writes[0];
    assert.ok(sent !== undefined);
    assert.match(sent.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=ASIASIMULATEDEXAMPLE\/20261001\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[a-z;-]*host[a-z;-]*x-amz-security-token, Signature=[0-9a-f]{64}$/u);
    assert.equal(sent.headers['x-amz-date'], '20261001T120000Z');
    assert.equal(sent.headers['x-amz-security-token'], SESSION, 'the session token is sent');
    const requestReceipt = receipts.find((receipt) => receipt.kind === 'REQUEST');
    assert.ok(requestReceipt !== undefined && requestReceipt.kind === 'REQUEST');
    assert.equal(requestReceipt.bodyBytes, sent.text, 'the receipt carries the exact bytes written');
    const recorded = JSON.stringify(receipts);
    for (const secret of [SECRET, SESSION, (sent.headers['authorization'] ?? '').slice(-64)]) assert.ok(!recorded.includes(secret), 'no credential, session token or signature in a receipt');
    assert.match(requestReceipt.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 <redacted, \d+ bytes>$/u);
    assert.match(requestReceipt.headers['x-amz-security-token'] ?? '', /^<redacted, \d+ bytes>$/u);
  });

  it('G11/G14: long-term keys, an expired or failing credential and a refused signature write nothing and are BEFORE_SEND; a thrown fetch after the body started is AFTER_SEND', async () => {
    let fetched = 0;
    const counting: BedrockFetch = async () => { fetched += 1; return { status: 200, headers: { get: () => null, forEach: () => undefined }, body: null }; };
    const receipts: ProtectedReceipt[] = [];
    const providers = [
      async () => ({ accessKeyId: 'AKIALONGTERMEXAMPLE', secretAccessKey: SECRET, sessionToken: '', expiresAt: '2026-10-01T13:00:00.000Z' }),
      async () => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: SECRET, sessionToken: SESSION, expiresAt: '2026-10-01T11:59:59.000Z' }),
      async () => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: SECRET, sessionToken: SESSION, expiresAt: 'not a date' }),
      async () => ({ accessKeyId: 'ASIA bad key', secretAccessKey: SECRET, sessionToken: SESSION, expiresAt: '2026-10-01T13:00:00.000Z' }),
      async () => { throw new Error(`refresh failed ${SECRET}`); },
    ];
    for (const provider of providers) {
      const failure = await failureOf(() => transportOver(counting, receipts, provider as typeof credentialProvider)(request(), DEADLINE, correlation));
      assert.equal(failure.stage, 'BEFORE_SEND');
      assert.ok(!failure.message.includes(SECRET), 'no secret in the message');
    }
    assert.equal(fetched, 0);
    assert.deepEqual(receipts, [], 'no receipt: nothing was written');
    const afterStart: BedrockFetch = async (_url, init) => { await drain(init.body); throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
    assert.equal((await failureOf(() => transportOver(afterStart)(request(), DEADLINE, correlation))).stage, 'AFTER_SEND');
  });

  it('D4-BR-2 usage: the body usage is cross-checked against x-amzn-bedrock-input/output-token-count; a mismatch counts as usage unknown and holds the full reservation; a served model that is not the profile breaks the subject', async () => {
    const receiptOf = async (name: string): Promise<ResponseReceipt> => {
      const receipts: ProtectedReceipt[] = [];
      const { fetchImpl } = replayBedrock(loadBedrockRecording(name));
      const response = await transportOver(fetchImpl, receipts)(request(), DEADLINE, correlation);
      if (response.bodyChunks !== undefined) await readRawBody(response.bodyChunks);
      const found = receipts.find((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE');
      assert.ok(found !== undefined);
      return found;
    };
    const good = await receiptOf('messages-200');
    assert.deepEqual(headerUsage(good.headers), { inputTokens: 12, outputTokens: 5 });
    const usage = { inputTokens: 12, outputTokens: 5, cacheCreationInputTokens: null, cacheReadInputTokens: null };
    const answered: GatewayResult = { kind: 'RESPONSE', content: 'x', usage, stopReason: 'end_turn', providerMeta: { modelId: SONNET_5_5_US.modelId, requestId: 'msg_bdrk_01SIMULATED0001' } };
    assert.deepEqual(bedrockAssessment(SONNET_5_5_US, answered, good), { result: answered, verdict: 'OK', subjectBroken: false });
    const mismatch = bedrockAssessment(SONNET_5_5_US, answered, await receiptOf('messages-200-usage-mismatch'));
    assert.equal(mismatch.verdict, 'USAGE_MISMATCH');
    assert.equal(mismatch.result.kind === 'RESPONSE' ? mismatch.result.usage : 'x', null, 'unknown, never the smaller witness');
    const noHeaders: ResponseReceipt = { ...good, headers: { 'content-type': 'application/json' } };
    assert.equal(bedrockAssessment(SONNET_5_5_US, answered, noHeaders).verdict, 'USAGE_MISMATCH', 'a missing witness is no agreement');
    const wrong = bedrockAssessment(SONNET_5_5_US, answered, await receiptOf('messages-200-wrong-model'));
    assert.deepEqual([wrong.verdict, wrong.subjectBroken], ['WRONG_MODEL', true]);
  });
});
