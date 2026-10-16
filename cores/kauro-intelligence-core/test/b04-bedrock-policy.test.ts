import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { OPUS_5_5_US, SONNET_5_5_US, admitCandidate } from '../src/gateway/candidates.js';
import type { CandidateProfile } from '../src/gateway/candidates.js';
import { MODEL_POLICY_VERSION } from '../src/contracts/versions.js';
import { MODEL_POLICY_V1, candidatePolicyOf } from '../src/gateway/model-gateway.js';
import { BEDROCK_PROFILE } from '../src/provider/bedrock-wire.js';
import { VERTEX_HOST } from '../src/provider/vertex-wire.js';

describe('B04-BEDROCK-POLICY: owner decision A9 (Amazon Bedrock, Claude Sonnet 5.5 / Opus 5.5)', () => {
  it('A9 policy version: the platform changed from Vertex to Bedrock, so the policy is version 2.0.0 and every shipped policy carries it', () => {
    assert.equal(MODEL_POLICY_VERSION, '2.0.0');
    assert.equal(MODEL_POLICY_V1.modelPolicyVersion, '2.0.0');
    for (const profile of [SONNET_5_5_US, OPUS_5_5_US]) assert.equal(candidatePolicyOf(profile).modelPolicyVersion, '2.0.0');
  });

  it('A9 policy: the pinned policy is AWS_BEDROCK_MANAGED_MODEL in US_MULTI_REGION (the us. geography profile, D4-BR-1) with no failover and no second model; a Vertex profile is refused PROVIDER_RETIRED_A9 while the Vertex modules stay in the tree', () => {
    assert.equal(MODEL_POLICY_V1.platform, 'AWS_BEDROCK_MANAGED_MODEL');
    assert.equal(MODEL_POLICY_V1.location, 'US_MULTI_REGION');
    assert.equal(MODEL_POLICY_V1.automaticFailover, 'OFF');
    assert.equal(MODEL_POLICY_V1.secondaryModel, 'NONE');
    assert.equal(MODEL_POLICY_V1.requestResponseLogging, 'OFF');
    for (const profile of [SONNET_5_5_US, OPUS_5_5_US]) {
      assert.equal(candidatePolicyOf(profile).platform, 'AWS_BEDROCK_MANAGED_MODEL');
      assert.equal(candidatePolicyOf(profile).primaryModel, profile.modelId, 'the policy names the model; the profile constant in the package bytes names its us. route');
      assert.ok(BEDROCK_PROFILE.test(profile.inferenceProfileId));
      assert.equal(admitCandidate(profile).admitted, true);
    }
    const vertex: CandidateProfile = { ...SONNET_5_5_US, provider: 'GOOGLE_VERTEX' };
    const refused = admitCandidate(vertex);
    assert.equal(refused.admitted, false);
    assert.match(refused.admitted ? '' : refused.reason, /PROVIDER_RETIRED_A9/u);
    const global: CandidateProfile = { ...SONNET_5_5_US, inferenceProfileId: 'global.anthropic.claude-sonnet-5-5' };
    assert.match(admitCandidate(global).admitted ? '' : (admitCandidate(global) as { reason: string }).reason, /us\. geography/u, 'a global profile is not admitted');
    assert.equal(VERTEX_HOST, 'aiplatform.us.rep.googleapis.com', 'the Vertex wire stays (A9 §2), not admitted');
  });

  it('A9 tariffs: the planning tariffs are the first-party list price + 10 % geo premium and stay UNVERIFIED until probe P5 reads the AWS Price List', () => {
    assert.deepEqual([SONNET_5_5_US.inputMicroUsdPerToken, SONNET_5_5_US.outputMicroUsdPerToken], [2.2, 11]);
    assert.deepEqual([OPUS_5_5_US.inputMicroUsdPerToken, OPUS_5_5_US.outputMicroUsdPerToken], [4.4, 22]);
    for (const profile of [SONNET_5_5_US, OPUS_5_5_US]) assert.equal(profile.tariffEvidence, 'UNVERIFIED_PLANNING');
  });
});
