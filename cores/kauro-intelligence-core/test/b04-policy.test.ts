import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { GEMINI_UNVERIFIED, OPUS_5_5_US, SONNET_5_5_US, admitCandidate, selectCandidate } from '../src/gateway/candidates.js';
import type { CandidateProfile } from '../src/gateway/candidates.js';
import { MODEL_POLICY_V1 } from '../src/gateway/model-gateway.js';

describe('B04-POLICY: candidate profiles, eligibility before cost (SIMULATED records)', () => {
  it('S091: a candidate without a read-back privacy and retention record, Gemini among them, is refused by admission before any request; Sonnet 5.5 and Opus 5.5 with their records are admitted', () => {
    assert.equal(admitCandidate(GEMINI_UNVERIFIED).admitted, false);
    const noRecord: CandidateProfile = { ...SONNET_5_5_US, eligibility: null };
    const refused = admitCandidate(noRecord);
    assert.equal(refused.admitted, false);
    assert.match(refused.admitted ? '' : refused.reason, /read-back/u);
    const loggingOn: CandidateProfile = { ...SONNET_5_5_US, eligibility: { ...SONNET_5_5_US.eligibility!, requestResponseLogging: 'ON' as never } };
    assert.equal(admitCandidate(loggingOn).admitted, false);
    for (const profile of [SONNET_5_5_US, OPUS_5_5_US]) {
      const admitted = admitCandidate(profile);
      assert.equal(admitted.admitted, true);
      assert.equal(profile.location, 'us');
      assert.equal(profile.effort, 'high');
      assert.equal(profile.retentionClass, 'NO_PROVIDER_MINIMUM');
    }
    assert.equal(SONNET_5_5_US.modelId, 'claude-sonnet-5-5');
    assert.equal(OPUS_5_5_US.modelId, 'claude-opus-5-5');
    assert.equal(SONNET_5_5_US.inputMicroUsdPerToken, 2.2);
    assert.equal(SONNET_5_5_US.outputMicroUsdPerToken, 11);
    assert.equal(OPUS_5_5_US.inputMicroUsdPerToken, 4.4);
    assert.equal(OPUS_5_5_US.outputMicroUsdPerToken, 22);
  });

  it('R2-041: a cheaper candidate with a provider-minimum retention class fails eligibility before any cost comparison and is never selected', () => {
    const cheap: CandidateProfile = { ...SONNET_5_5_US, profileId: 'CHEAP_MINIMUM', modelId: 'cheap-model', inputMicroUsdPerToken: 0.1, outputMicroUsdPerToken: 0.1, retentionClass: 'PROVIDER_MINIMUM_RETENTION' };
    const costed: string[] = [];
    const cost = (profile: CandidateProfile): number => {
      costed.push(profile.profileId);
      return profile.inputMicroUsdPerToken + profile.outputMicroUsdPerToken;
    };
    assert.equal(admitCandidate(cheap).admitted, false);
    const selection = selectCandidate([cheap, GEMINI_UNVERIFIED, OPUS_5_5_US, SONNET_5_5_US], cost);
    assert.equal(selection.selected?.profileId, SONNET_5_5_US.profileId);
    assert.deepEqual(selection.refused.map((entry) => entry.profileId).sort(), ['CHEAP_MINIMUM', GEMINI_UNVERIFIED.profileId].sort());
    assert.ok(!costed.includes('CHEAP_MINIMUM') && !costed.includes(GEMINI_UNVERIFIED.profileId), 'cost is never computed for a refused candidate');
    assert.equal(selectCandidate([cheap], cost).selected, null);
  });

  it('the pinned model policy is a candidate profile, not a hard-coded model', () => {
    assert.equal(MODEL_POLICY_V1.primaryModel, SONNET_5_5_US.modelId);
    assert.equal(MODEL_POLICY_V1.profileId, SONNET_5_5_US.profileId);
  });
});
