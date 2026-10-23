import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  BEDROCK_DEPLOYMENT_CONTRACT_VERSION,
  BEDROCK_GRANT_CAPS_USD,
  BEDROCK_RETRY_WAITS_MS,
  bedrockDeploymentProblems,
} from '../src/provider/bedrock-deployment.js';
import { OPUS_5_5_US, SONNET_5_5_US } from '../src/gateway/candidates.js';

/** The deployment document as the platform writes it (deploy/aws/bedrock/bedrock-contract.json), inline so the core stands alone. */
function prepared(): Record<string, unknown> {
  return {
    contractVersion: BEDROCK_DEPLOYMENT_CONTRACT_VERSION,
    enabled: false,
    activationReference: null,
    sourceRegion: 'us-east-1',
    geography: 'us',
    destinationRegions: ['us-east-1', 'us-east-2', 'us-west-2'],
    invocation: { operation: 'InvokeModel', wire: 'bedrock-2023-05-31', streaming: false, maxOutputTokens: 4096, timeoutMs: 120000 },
    models: [
      { capability: 'IC_ANALYSIS', candidate: SONNET_5_5_US.profileId, inferenceProfileId: SONNET_5_5_US.inferenceProfileId, status: 'GRANTED', grants: ['B04-A', 'B04-B'] },
      { capability: 'IC_PILOT_COMPARISON', candidate: OPUS_5_5_US.profileId, inferenceProfileId: OPUS_5_5_US.inferenceProfileId, status: 'BLOCKED_OWNER', grants: [] },
    ],
    retention: { invocationLogging: 'OFF', providerStoresPromptsOrOutputs: false },
    quotas: { maxConcurrency: 1, maxRequestsPerMinute: 20, maxTokensPerMinute: 200000 },
    backoff: { retryableStatuses: [429, 503, 529], waitsMs: [2000, 8000], maxAttempts: 3 },
    budget: {
      grants: [
        { grantId: 'B04-A', capUsd: 40, stages: ['SMOKE', 'PILOT'], candidates: ['SONNET_5_5_US'], maxRuns: null },
        { grantId: 'B04-B', capUsd: 120, stages: ['QUALIFICATION'], candidates: ['SONNET_5_5_US'], maxRuns: 4 },
      ],
      awsBudgetCeilingUsd: 160,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON document edited by hand in each case
type Editable = any;

/** A deep copy with one change made by `edit`. */
function altered(edit: (contract: Editable) => void): Record<string, unknown> {
  const contract = JSON.parse(JSON.stringify(prepared())) as Editable;
  edit(contract);
  return contract;
}

describe('O26A Bedrock deployment contract against the core (A9 §4, D4-BR-1)', () => {
  it('the prepared document is what the core does: no problem', () => {
    assert.deepEqual(bedrockDeploymentProblems(prepared()), []);
  });

  it('the grants are the owner\'s: B04-A USD 40, B04-B USD 120; the waits are the transport\'s', () => {
    assert.deepEqual(BEDROCK_GRANT_CAPS_USD, { 'B04-A': 40, 'B04-B': 120 });
    assert.deepEqual(BEDROCK_RETRY_WAITS_MS, [2000, 8000]);
  });

  const refusals: [string, (c: Editable) => void, RegExp][] = [
    ['enabled without an activation reference', (c) => { c.enabled = true; }, /activation reference/u],
    ['a source Region the wire does not call', (c) => { c.sourceRegion = 'eu-west-1'; }, /source Region/u],
    ['a destination outside the US', (c) => { c.destinationRegions.push('eu-central-1'); }, /outside the US/u],
    ['another geography', (c) => { c.geography = 'global'; }, /geography/u],
    ['streaming', (c) => { c.invocation.streaming = true; }, /non-streaming InvokeModel/u],
    ['Converse instead of InvokeModel', (c) => { c.invocation.operation = 'Converse'; }, /non-streaming InvokeModel/u],
    ['invocation logging on', (c) => { c.retention.invocationLogging = 'S3'; }, /logging is not OFF/u],
    ['the provider may store prompts', (c) => { c.retention.providerStoresPromptsOrOutputs = true; }, /store prompts/u],
    ['Opus granted without a new approval', (c) => { c.models[1].status = 'GRANTED'; c.models[1].grants = ['B04-B']; }, /only SONNET_5_5_US|Opus needs a new approval/u],
    ['a global profile for the analysis', (c) => { c.models[0].inferenceProfileId = 'global.anthropic.claude-sonnet-5-5'; }, /only SONNET_5_5_US/u],
    ['a granted model with no grant', (c) => { c.models[0].grants = []; }, /names no owner grant/u],
    ['no granted model', (c) => { c.models[0].status = 'BLOCKED_OWNER'; }, /no granted model/u],
    ['two requests in flight', (c) => { c.quotas.maxConcurrency = 2; }, /in flight/u],
    ['unbounded requests per minute', (c) => { delete c.quotas.maxRequestsPerMinute; }, /requests per minute/u],
    ['a wait the transport does not use', (c) => { c.backoff.waitsMs = [1000, 1000]; }, /not the transport's/u],
    ['an unbounded number of attempts', (c) => { c.backoff.maxAttempts = 10; }, /maxAttempts/u],
    ['a retry on 500', (c) => { c.backoff.retryableStatuses.push(500); }, /does not retry/u],
    ['a grant above the owner\'s cap', (c) => { c.budget.grants[1].capUsd = 121; }, /above the owner's cap/u],
    ['an invented grant', (c) => { c.budget.grants.push({ grantId: 'B04-C', capUsd: 10, candidates: ['SONNET_5_5_US'] }); }, /unknown/u],
    ['a grant that funds Opus', (c) => { c.budget.grants[0].candidates.push('OPUS_5_5_US'); }, /other than SONNET_5_5_US/u],
    ['an AWS budget above the grants', (c) => { c.budget.awsBudgetCeilingUsd = 161; }, /above the sum of the grants/u],
    ['another contract version', (c) => { c.contractVersion = '2.0.0'; }, /contractVersion/u],
  ];
  for (const [name, edit, expected] of refusals) {
    it(`refuses ${name}`, () => {
      const problems = bedrockDeploymentProblems(altered(edit));
      assert.ok(problems.some((problem) => expected.test(problem)), `${name}: ${JSON.stringify(problems)}`);
    });
  }

  it('an enabled document with the owner\'s reference passes, and nothing else is required to switch it on', () => {
    assert.deepEqual(bedrockDeploymentProblems(altered((c) => { c.enabled = true; c.activationReference = 'owner-approval-B04-A-2026'; })), []);
  });

  it('refuses what is not a record', () => {
    for (const value of [null, [], 'contract', 7]) assert.deepEqual(bedrockDeploymentProblems(value), ['the deployment contract is not a record']);
  });
});
