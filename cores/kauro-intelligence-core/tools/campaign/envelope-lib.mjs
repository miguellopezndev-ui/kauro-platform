// The measuring half of envelope.mjs: first-attempt Bedrock body bytes per fixture (owner decision A9), and the stage envelopes from them.
import { envelopeOf, projectedRunMicros, toBedrockBody } from 'kauro-intelligence-core/benchmark';
import { materialise, runThroughPublicCore } from './validity-run.mjs';

/** The planning parameters of B04-campaign-envelope §1 and §3: replaced by the smoke's and the pilot's measurements before any spend. */
export const PLANNING = Object.freeze({ hiddenInputTokensPerRequest: 500, plannedOutputTokensPerRequest: 1_500, outputCeilingTokens: 8_192, bytesPerToken: 3, repairShare: 0.142, repairBytes: 16_015 });

/** Per fixture, the byte length of every request body the core sends for it, serialised as the Bedrock transport serialises it. */
export async function requestBytesOfFixtures(corpusFixtures, { truthFollowingAnswer, sealedObject, onProgress }) {
  const out = [];
  for (const corpusFixture of corpusFixtures) {
    const fixture = corpusFixture.fixture;
    const declaredObject = corpusFixture.structure.project !== undefined ? corpusFixture.structure.project.object : fixture.expectedTaskTypes.includes('OBJECT_MAPPING') ? null : sealedObject(fixture);
    const bundle = materialise(corpusFixture, { declaredObject });
    try {
      const requests = [];
      await runThroughPublicCore(bundle, (envelope, identity) => truthFollowingAnswer(fixture, envelope, identity, bundle.targets), `attempt-envelope-${fixture.fixtureId}`, (request) => { requests.push(Buffer.byteLength(JSON.stringify(toBedrockBody(request)), 'utf8')); });
      out.push({ fixtureId: fixture.fixtureId, requests });
    } finally {
      bundle.dispose();
      if (onProgress !== undefined) onProgress(out.length, corpusFixtures.length);
    }
  }
  return out;
}

/** The envelope of each candidate over the measured fixtures, with the grant a qualification run of 600 would need. */
export function campaignEnvelopes(perFixture, profiles) {
  return { planning: PLANNING, candidates: Object.fromEntries(profiles.map((profile) => { const envelope = envelopeOf(perFixture, profile, PLANNING); return [profile.profileId, { ...envelope, projectedRunMicrosFor600: projectedRunMicros(envelope.perFixtureMicros, 600) }]; })) };
}
