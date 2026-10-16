/**
 * B04 retry and rate-limit settlement (lane L1, S8 + S11; tier 1: money).
 *
 * S8 (G30): a RETRYABLE_FAILURE waits 2 s, then 8 s, each plus a jitter of
 * 0..25 % drawn from the request's idempotency digest; a larger Retry-After
 * wins up to 60 s; a wait the semantic deadline cannot hold is refused with
 * no send; a known status other than 429/503/529 is not retried; AMBIGUOUS is
 * never retried (manual 06 l.104).
 *
 * S11 (G22, G24): a 429 without usage whose provider error type is the
 * documented throttling class (Bedrock ThrottlingException, Vertex
 * RESOURCE_EXHAUSTED) is RELEASED as PROVIDER_DOCUMENTED_NON_ACCEPTANCE (manual
 * 06 l.182); a 429 with usage commits; 503/529/408 and a 429 of no documented
 * class without usage stay AMBIGUOUS with the full hold. More than five
 * released 429s in a row stop the run RATE_LIMITED, with the grant untouched.
 *
 * Every wait is on the virtual clock through deps.sleep (SIMULATED).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import type { IntelligenceResult } from '../src/api/intelligence-core.js';
import { oracleGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest, GatewayResult, ModelGateway } from '../src/gateway/model-gateway.js';
import { transportGateway } from '../src/gateway/transport-gateway.js';
import type { ProviderResponse } from '../src/gateway/transport-gateway.js';
import type { IntelligenceInput } from '../src/ports/ports.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';

const TIMEOUT = { timeout: 120_000 };
type Responder = (request: GatewayRequest, oracle: ModelGateway) => Promise<GatewayResult> | GatewayResult;

/** Answers each call from the script in order, then from the oracle; counts every call. */
function sequenceGateway(script: readonly Responder[]): ModelGateway & { calls: number } {
  const oracle = oracleGateway();
  const gateway = {
    name: 'sequence',
    evidenceClass: 'SIMULATED' as const,
    calls: 0,
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      const responder = script[gateway.calls];
      gateway.calls += 1;
      return responder === undefined ? oracle.analyze(request) : responder(request, oracle);
    },
  };
  return gateway;
}

/** A transport gateway whose transport answers the scripted provider responses in order, then the oracle's answer as a 200. */
function scriptedTransport(script: readonly ProviderResponse[]): ModelGateway & { calls: number } {
  const oracle = oracleGateway();
  let calls = 0;
  const inner = transportGateway(async () => {
    const scripted = script[calls];
    calls += 1;
    if (scripted !== undefined) return scripted;
    throw new Error('unreachable: the oracle answers past the script');
  });
  const gateway = {
    name: 'scripted-transport',
    evidenceClass: 'SIMULATED' as const,
    get calls(): number {
      return calls;
    },
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      if (calls >= script.length) {
        calls += 1;
        return oracle.analyze(request);
      }
      return inner.analyze(request);
    },
  };
  return gateway;
}

interface Ran {
  readonly result: IntelligenceResult;
  readonly waits: readonly number[];
  readonly heldMicros: number;
  readonly chargedMicros: number;
}

async function run(name: string, gateway: ModelGateway, extra: Partial<IntelligenceInput> = {}, bundleOptions: Parameters<typeof makeBundle>[1] = {}): Promise<Ran> {
  const bundle = makeBundle(name, bundleOptions);
  try {
    const profiled = profileBundle(bundle, 'CLEAN_ONLY');
    const deps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null));
    const waits: number[] = [];
    const sleep = deps.sleep;
    const result = await createIntelligenceCore({ ...deps, sleep: async (ms: number) => { waits.push(ms); await sleep?.(ms); } }).run(inputFor('CLEAN_ONLY', profiled, null, extra), { ...CONTEXT, auditAttemptId: `attempt-${name}` });
    const balance = deps.dispatchAdmission.view();
    return { result, waits, heldMicros: balance.heldMicros, chargedMicros: balance.chargedMicros };
  } finally {
    bundle.dispose();
  }
}

const released = (result: IntelligenceResult): { reason: string }[] => result.runLedger.filter((event) => event.kind === 'RELEASED') as unknown as { reason: string }[];
const status = (code: number, extra: Partial<ProviderResponse> = {}): ProviderResponse => ({ status: code, body: null, retryAfterMs: null, ...extra });
const THROTTLED_BEDROCK = status(429, { errorType: 'ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/' } as Partial<ProviderResponse>);
const THROTTLED_VERTEX = status(429, { body: { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } } });

describe('B04 S8: transport retry backoff (G30)', () => {
  it('S8: backoff 2 s then 8 s plus jitter; a larger Retry-After wins up to 60 s; a wait past the deadline fails the task without a send', TIMEOUT, async () => {
    const unavailable: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'provider status 503', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: null, status: 503 } as GatewayResult);
    const first = await run('s8-backoff', sequenceGateway([unavailable, unavailable]));
    const again = await run('s8-backoff', sequenceGateway([unavailable, unavailable]));
    assert.equal(first.waits.length, 2, JSON.stringify(first.waits));
    const [w1, w2] = first.waits as [number, number];
    assert.ok(w1 >= 2_000 && w1 <= 2_500, `first wait 2 s + 0..25 %: ${String(w1)}`);
    assert.ok(w2 >= 8_000 && w2 <= 10_000, `second wait 8 s + 0..25 %: ${String(w2)}`);
    assert.deepEqual(again.waits, first.waits, 'the jitter is drawn from the idempotency digest, so a replay waits the same');

    // A larger Retry-After wins, exactly.
    const asked: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'provider status 429', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: 30_000, status: 429 } as GatewayResult);
    const honoured = await run('s8-retry-after', sequenceGateway([asked]));
    assert.deepEqual(honoured.waits, [30_000]);

    // Past 60 s: no wait, no second send.
    const tooLong: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'provider status 429', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: 61_000, status: 429 } as GatewayResult);
    const refusedGateway = sequenceGateway([tooLong]);
    const refused = await run('s8-retry-after-max', refusedGateway);
    assert.deepEqual(refused.waits, []);
    assert.ok(refused.result.runLedger.some((event) => event.kind === 'NOTE' && event.note.startsWith('transport retry refused')));

    // The backoff itself past the semantic deadline: no wait, the task fails, nothing more is sent.
    const lateGateway = sequenceGateway([unavailable]);
    const late = await run('s8-deadline', lateGateway, { resourceProfile: { wallClockMs: 2_000 } });
    assert.deepEqual(late.waits, []);
    assert.equal(lateGateway.calls, 1, 'no send after a refused wait');
    assert.ok(late.result.tasks.some((task) => task.outcome === 'PROVIDER_RETRYABLE_FAILURE'));
  });

  it('S8: a known status other than 429/503/529 is not retried, and AMBIGUOUS is never retried', TIMEOUT, async () => {
    const internal: Responder = () => ({ kind: 'RETRYABLE_FAILURE', reason: 'provider status 500', usage: { inputTokens: 1, outputTokens: 0 }, retryAfterMs: null, status: 500 } as GatewayResult);
    const internalGateway = sequenceGateway([internal]);
    const ran = await run('s8-500', internalGateway);
    assert.deepEqual(ran.waits, []);
    assert.ok(ran.result.tasks.some((task) => task.outcome === 'PROVIDER_RETRYABLE_FAILURE'));
    const lost: Responder = () => ({ kind: 'AMBIGUOUS', reason: 'AFTER_SEND: connection reset' });
    const lostGateway = sequenceGateway([lost]);
    const ambiguous = await run('s8-ambiguous', lostGateway);
    assert.deepEqual(ambiguous.waits, [], 'an ambiguous send is never retried');
    assert.equal(ambiguous.result.resourceEvidence.ambiguousReservations, 1);
  });
});

describe('B04 S11: a documented 429 releases, everything else unproven holds (G22, G24)', () => {
  it('S11: a 429 ThrottlingException without usage is RELEASED with the documented reason; with usage it commits; 503/529/408 without usage stay AMBIGUOUS', TIMEOUT, async () => {
    for (const [name, throttled] of [['bedrock', THROTTLED_BEDROCK], ['vertex', THROTTLED_VERTEX]] as const) {
      const ran = await run(`s11-${name}`, scriptedTransport([throttled]));
      const releases = released(ran.result);
      assert.equal(releases.length, 1, `${name}: ${JSON.stringify(releases)}`);
      assert.match(releases[0]?.reason ?? '', /^PROVIDER_DOCUMENTED_NON_ACCEPTANCE:https:\/\//u, name);
      assert.equal(ran.result.resourceEvidence.ambiguousReservations, 0, name);
    }
    // With usage the 429 was billed: it commits.
    const billed = await run('s11-usage', scriptedTransport([status(429, { errorType: 'ThrottlingException', body: { usage: { input_tokens: 10, output_tokens: 0 } } } as Partial<ProviderResponse>)]));
    assert.equal(released(billed.result).length, 0);
    assert.ok(billed.result.runLedger.filter((event) => event.kind === 'COMMITTED').length >= 2, 'the billed 429 and the answer commit');
    // No documented class, or another status, without usage: the hold stays.
    for (const [name, response] of [['429-undocumented', status(429)], ['503', status(503)], ['529', status(529)], ['408', status(408)]] as const) {
      const ran = await run(`s11-${name}`, scriptedTransport([response]));
      assert.equal(released(ran.result).length, 0, name);
      assert.equal(ran.result.resourceEvidence.ambiguousReservations, 1, name);
    }
  });

  it('DENY: six released 429 in a row stop the run RATE_LIMITED', TIMEOUT, async () => {
    const gateway = scriptedTransport(Array.from({ length: 12 }, () => THROTTLED_BEDROCK));
    const ran = await run('s11-rate-limited', gateway, {}, { extraColumns: 4 });
    assert.equal(gateway.calls, 6, 'the sixth released 429 stops the run; no seventh request');
    assert.equal(released(ran.result).length, 6);
    assert.equal(ran.result.state, 'FAILED_PROVIDER');
    assert.ok(ran.result.tasks.some((task) => task.codes.includes('RATE_LIMITED')), JSON.stringify(ran.result.tasks));
    // Not a hard gate on the grant: nothing held, nothing charged.
    assert.equal(ran.heldMicros, 0);
    assert.equal(ran.chargedMicros, 0);
  });
});
