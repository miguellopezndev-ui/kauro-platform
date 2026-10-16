import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { HARD_GATES, QUALIFICATION_CORPUS, report, sealExpectedTruth } from '../src/benchmark/harness.js';
import type { BenchmarkFixture, FixtureFamily, FixtureScore, HardGate, ScoreCheck } from '../src/benchmark/harness.js';
import { bindRun, qualifyThreeRuns } from '../src/benchmark/qualification.js';
import type { QualificationSubject } from '../src/benchmark/qualification.js';
import { canonicalJson } from '../src/contracts/canonical.js';
import { OPUS_5_5_US, SONNET_5_5_US } from '../src/gateway/candidates.js';
import { parseProviderRequestPayload } from '../src/gateway/transport-gateway.js';
import { bedrockUrl, toBedrockBody } from '../src/provider/bedrock-wire.js';
import { requestReceipt, responseReceipt } from '../src/provider/vertex-receipts.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import { toVertexBody } from '../src/provider/vertex-wire.js';
import { runVector } from './support/egress-harness.js';

/**
 * B04-QUALIFY on Amazon Bedrock (owner decision A9; SIMULATED, no network). The same synthetic 600-fixture universe as
 * b04-qualification, with receipts at the Bedrock InvokeModel endpoint carrying bedrock-2023-05-31 bodies. Arithmetic only:
 * nothing here is qualification evidence for the product.
 */
const HASHES = { profileHash: 'a'.repeat(64), candidateSetHash: 'b'.repeat(64), targetContractHash: null, projectRevisionHash: 'c'.repeat(64) };
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);
const TEMPLATE = (await runVector('CLEAN_ONLY', { id: 'qualify-bdrk', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] })).requests[0] ?? '';
const TEMPLATE_PAYLOAD = parseProviderRequestPayload(TEMPLATE);
const requestFor = (runId: string): Parameters<typeof toBedrockBody>[0] => JSON.parse(TEMPLATE.split(TEMPLATE_PAYLOAD.runId).join(runId)) as Parameters<typeof toBedrockBody>[0];

const SUBJECT: QualificationSubject = {
  servedModel: 'claude-sonnet-5-5', location: 'us', modelPolicyHash: TEMPLATE_PAYLOAD.policyRef.modelPolicyHash, promptBundleHash: TEMPLATE_PAYLOAD.promptRef.promptBundleHash, compilerContractVersion: '1.0.0',
  migrationCoreVersion: '3.0.0', icPackageDigest: hex('3'), scorerDigest: hex('4'), corpusDigest: hex('5'),
};

function fixture(id: string, family: FixtureFamily): BenchmarkFixture {
  return sealExpectedTruth({ fixtureFormatVersion: '1.1.0', fixtureId: id, family, weight: 1, expectedInputHashes: HASHES, expectedOutcomeClass: family === 'AMBIGUOUS_ABSTENTION' ? 'ABSTAINED' : 'PROPOSED', allowedAlternatives: [], expectedCandidates: [], forbiddenDestinationFields: [], requiredEvidenceRefs: [], expectedCompilerResult: 'ANY', expectedPreserved: ['Record ID'], expectedTaskTypes: [], dataLevelCeiling: 'L0', budgetCeiling: { maxCalls: 1, maxInvocations: 1, maxBilledInputTokens: 1000, maxBilledOutputTokens: 100 }, gates: { identityUnproven: true, injectionSentinels: ['sentinel-1'], foreignRefs: ['foreign-1'], secretSentinels: ['secret-1'], safetyCritical: true } });
}
const CORPUS: BenchmarkFixture[] = (Object.keys(QUALIFICATION_CORPUS.families) as FixtureFamily[]).flatMap((family) => Array.from({ length: QUALIFICATION_CORPUS.families[family] }, (_unused, index) => fixture(`${family}-${String(index)}`, family)));

function scoreOf(entry: BenchmarkFixture, tag: string): FixtureScore {
  const checks: ScoreCheck[] = HARD_GATES.map((gate) => ({ check: `gate:${gate}`, gate, expected: 'nothing', observed: `nothing:${tag}`, pass: true }));
  checks.push({ check: 'outcome_class', gate: null, expected: entry.expectedOutcomeClass, observed: entry.expectedOutcomeClass, pass: true });
  return { fixtureId: entry.fixtureId, family: entry.family, weight: entry.weight, expectedTruthDigest: entry.expectedTruthDigest, runId: `run_${tag}_${entry.fixtureId}`, correct: true, candidateFailure: false, checks, hardGateViolations: [], gateChecksExecuted: Object.fromEntries(HARD_GATES.map((gate) => [gate, 1])) as Record<HardGate, number>, scorerFailure: null };
}

type Shape = { readonly url: (index: number) => string; readonly body: (runId: string) => string };
const BEDROCK: Shape = { url: () => bedrockUrl('us-east-1', SONNET_5_5_US.inferenceProfileId), body: (runId) => canonicalJson(toBedrockBody(requestFor(runId))) };

function runOf(tag: string, shape: Shape = BEDROCK): { run: ReturnType<typeof bindRun>; receipts: ProtectedReceipt[] } {
  const receipts: ProtectedReceipt[] = [];
  CORPUS.forEach((entry, index) => {
    const runId = `run_${tag}_${entry.fixtureId}`;
    receipts.push(requestReceipt({ url: shape.url(index), headers: { 'content-type': 'application/json' }, bodyBytes: shape.body(runId), idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
    const text = JSON.stringify({ id: `msg_bdrk_${tag}_${String(index)}`, type: 'message', model: SUBJECT.servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } });
    receipts.push(responseReceipt({ status: 200, headers: { 'x-amzn-requestid': `req-${tag}-${String(index)}`, 'x-amzn-bedrock-input-token-count': '10', 'x-amzn-bedrock-output-token-count': '5' }, bodyText: text, bodyLength: text.length, truncated: false, latencyMs: 1, idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
  });
  const runFixtures = CORPUS.map((entry) => ({ runId: `run_${tag}_${entry.fixtureId}`, fixtureId: entry.fixtureId }));
  return { run: bindRun(report(CORPUS, CORPUS.map((entry) => scoreOf(entry, tag)), `campaign-${tag}`, 'QUALIFICATION'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts, runFixtures }), receipts };
}

describe('B04-BEDROCK-QUALIFY: receipts bind at the subject\'s Bedrock endpoint (SIMULATED, A9)', () => {
  it('R2-040/R2-039 Bedrock: three runs whose receipts are at the served model\'s us. profile in a US source region with bedrock-2023-05-31 bodies qualify; another profile, a global profile, another region or a Vertex body under the Bedrock URL is refused', () => {
    const [a, b, c] = [runOf('a'), runOf('b'), runOf('c')];
    const good = qualifyThreeRuns([a.run, b.run, c.run], [a.receipts, b.receipts, c.receipts]);
    assert.deepEqual(good.reasons, [], 'the control: Bedrock receipts of the subject qualify');
    assert.equal(good.qualified, true);
    const west = runOf('w', { ...BEDROCK, url: () => bedrockUrl('us-west-2', SONNET_5_5_US.inferenceProfileId) });
    assert.deepEqual(qualifyThreeRuns([west.run, b.run, c.run], [west.receipts, b.receipts, c.receipts]).reasons, [], 'us-west-2 is a source region of the us. profile');
    const refusedBy = (shape: Shape, tag: string, pattern: RegExp, label: string): void => {
      const bad = runOf(tag, shape);
      const result = qualifyThreeRuns([bad.run, b.run, c.run], [bad.receipts, b.receipts, c.receipts]);
      assert.equal(result.qualified, false, label);
      assert.ok(result.reasons.some((reason) => pattern.test(reason)), `${label}: ${result.reasons.join('; ')}`);
    };
    refusedBy({ ...BEDROCK, url: () => bedrockUrl('us-east-1', OPUS_5_5_US.inferenceProfileId) }, 'o', /RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT/u, 'the other candidate\'s profile');
    refusedBy({ ...BEDROCK, url: () => 'https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke' }, 'g', /RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT/u, 'a global profile');
    refusedBy({ ...BEDROCK, url: () => `https://bedrock-runtime.eu-west-1.amazonaws.com/model/${encodeURIComponent(SONNET_5_5_US.inferenceProfileId)}/invoke` }, 'e', /RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT/u, 'another region');
    refusedBy({ ...BEDROCK, url: () => `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(SONNET_5_5_US.inferenceProfileId)}/converse` }, 'v', /RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT/u, 'another operation');
    refusedBy({ ...BEDROCK, body: (runId) => canonicalJson(toVertexBody(requestFor(runId))) }, 'x', /RUN_1_REQUEST_NOT_A_PROVIDER_REQUEST/u, 'a Vertex body under the Bedrock URL');
  });
});
