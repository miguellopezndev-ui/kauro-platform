import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import * as harness from '../src/benchmark/harness.js';
import * as surface from '../src/index.js';

/**
 * The runner surface (BT-R2-04): an IC-2 benchmark runner consumes the packed
 * tarball, whose only entry is the index. What it needs to capture at the
 * transport, to test a body or a wire form, to name a report mode, to size
 * the qualification universe and to pin a report digest must be on the index
 * and be the same object the harness exports — not a re-implementation. The
 * names are read as strings so that a missing export is an assertion failure
 * at runtime, the way a consumer would meet it, not a compile error here.
 */
const RUNNER_SURFACE = ['capturingTransport', 'isTransportBody', 'wireForms', 'observeEgress', 'scoreFixture', 'sealExpectedTruth', 'benchmarkReport', 'qualifyThreeRuns', 'reportDigestOf', 'corpusShortfall'] as const;
const RUNNER_CONSTANTS = ['REPORT_MODES', 'QUALIFICATION_CORPUS', 'QUALITY_THRESHOLDS', 'HARD_GATES', 'FIXTURE_FAMILIES', 'BENCHMARK_FIXTURE_FORMAT_VERSION', 'SCORER_FAILURES'] as const;
const HARNESS_NAME: Readonly<Record<string, string>> = { benchmarkReport: 'report' };

describe('benchmark runner surface: everything an IC-2 runner needs is on the index, identical to the harness', () => {
  const index: Readonly<Record<string, unknown>> = surface;
  const inner: Readonly<Record<string, unknown>> = harness;

  it('positive: the runner functions and constants are exported from the index and are the harness objects', () => {
    for (const name of RUNNER_SURFACE) {
      assert.ok(name in index, `${name} is not exported from the index`);
      assert.equal(typeof index[name], 'function', name);
      assert.equal(index[name], inner[HARNESS_NAME[name] ?? name], `${name} on the index is not the harness function`);
    }
    for (const name of RUNNER_CONSTANTS) {
      assert.ok(name in index, `${name} is not exported from the index`);
      assert.equal(index[name], inner[name], `${name} on the index is not the harness value`);
    }
  });

  it('the exported values are the pinned ones: two report modes, the 600-fixture universe with its family minimums, a shortfall that names what is short', async () => {
    // Read by name, typed by the harness: the way a consumer meets the index, and a missing export fails here rather than at compile time.
    const fromIndex = <T>(name: string): T => {
      assert.ok(name in index, `${name} is not exported from the index`);
      return index[name] as T;
    };
    const REPORT_MODES = fromIndex<typeof harness.REPORT_MODES>('REPORT_MODES');
    const QUALIFICATION_CORPUS = fromIndex<typeof harness.QUALIFICATION_CORPUS>('QUALIFICATION_CORPUS');
    const corpusShortfall = fromIndex<typeof harness.corpusShortfall>('corpusShortfall');
    const isTransportBody = fromIndex<typeof harness.isTransportBody>('isTransportBody');
    const wireForms = fromIndex<typeof harness.wireForms>('wireForms');
    const capturingTransport = fromIndex<typeof harness.capturingTransport>('capturingTransport');
    assert.deepEqual(REPORT_MODES, ['TEST_ONLY', 'QUALIFICATION']);
    assert.ok(Object.isFrozen(REPORT_MODES));
    assert.equal(QUALIFICATION_CORPUS.fixtures, 600);
    assert.deepEqual(QUALIFICATION_CORPUS.families, { SUPPORTED: 200, AMBIGUOUS_ABSTENTION: 100, SAFETY: 100, ADVERSARIAL: 100, UGLY_MULTILINGUAL_STALE: 100 });
    assert.ok(Object.isFrozen(QUALIFICATION_CORPUS) && Object.isFrozen(QUALIFICATION_CORPUS.families));
    assert.deepEqual(corpusShortfall(600, QUALIFICATION_CORPUS.families), []);
    assert.deepEqual(corpusShortfall(599, { ...QUALIFICATION_CORPUS.families, SAFETY: 99 }), ['fixtures=599<600', 'SAFETY=99<100']);
    // The body test and the wire forms as a runner would call them from the index.
    assert.equal(isTransportBody(JSON.stringify({ model: 'm', messages: [], output_config: {} })), true);
    assert.equal(isTransportBody(JSON.stringify({ envelope: {} })), false);
    assert.deepEqual(wireForms('a"b'), ['a"b', 'a\\"b', 'a\\\\\\"b']);
    // The capture from the index is the capture: it records the bytes and forwards all three arguments.
    const calls: unknown[][] = [];
    const captured = capturingTransport(async (...args) => {
      calls.push(args);
      return { status: 200, body: {} };
    });
    const request = { model: 'm', max_tokens: 1, system: '', messages: [], output_config: { format: { type: 'json_schema', schema: {} }, effort: 'high' }, tools: [] } as unknown as surface.ProviderRequest;
    await captured.transport(request, '2026-09-11T00:00:00.000Z', { idempotencyRef: 'e'.repeat(64), runId: 'run_surface' });
    assert.deepEqual(captured.bodies, [JSON.stringify(request)]);
    assert.deepEqual(calls[0]?.[2], { idempotencyRef: 'e'.repeat(64), runId: 'run_surface' });
  });
});
