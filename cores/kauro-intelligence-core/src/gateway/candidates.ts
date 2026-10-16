/**
 * Candidate model profiles (B04 D4-POL-1..3). The pinned policy of a release
 * is the selected profile; eligibility precedes cost: a profile with no
 * read-back privacy and retention record, or whose retention class is not
 * NO_PROVIDER_MINIMUM, is refused before any cost is computed.
 *
 * The shipped read-back records are labelled SIMULATED: they state what the
 * campaign's live read-back must confirm (S091, R2-041); they are not that
 * read-back.
 */
export type RetentionClass = 'NO_PROVIDER_MINIMUM' | 'PROVIDER_MINIMUM_RETENTION' | 'UNKNOWN';

/** What the privacy and retention read-back of the project's configuration recorded. */
export interface EligibilityRecord {
  readonly evidenceClass: 'SIMULATED' | 'EXECUTED_PROVIDER';
  readonly termsAccepted: true;
  readonly requestResponseLogging: 'OFF';
  readonly promptCacheSent: false;
  readonly batch: false;
  readonly tools: false;
  readonly fallback: false;
}

/** The provider a profile is served through. Amazon Bedrock is the only admitted one (owner decision A9, 2026-10-05); Vertex stays in the tree, not admitted. */
export type ProviderPlatform = 'AWS_BEDROCK' | 'GOOGLE_VERTEX';

export interface CandidateProfile {
  readonly profileId: string;
  /** The Anthropic model name: what the ProviderRequest names and what the provider echoes as the served model. */
  readonly modelId: string;
  readonly provider: ProviderPlatform;
  /**
   * The Bedrock US geography cross-region inference profile the request is sent to (D4-BR-1: `us.` only, the analogue of Vertex
   * `us`; never `global.`). UNVERIFIED spelling until probe P2 reads it back from GetInferenceProfile.
   */
  readonly inferenceProfileId: string;
  /** Where the tariff came from: planning values until probe P5 reads the AWS Price List (a difference refuses PRICE_DRIFT). */
  readonly tariffEvidence: 'UNVERIFIED_PLANNING' | 'AWS_PRICE_LIST';
  readonly location: 'us';
  readonly effort: 'high';
  /** Micro-USD per token, US geography profile, at most 200K input tokens: first-party list price + 10 % geo premium (B04-campaign-envelope §4, mandate §4.1). */
  readonly inputMicroUsdPerToken: number;
  readonly outputMicroUsdPerToken: number;
  readonly retentionClass: RetentionClass;
  readonly eligibility: EligibilityRecord | null;
}

const SIMULATED_RECORD: EligibilityRecord = Object.freeze({
  evidenceClass: 'SIMULATED',
  termsAccepted: true,
  requestResponseLogging: 'OFF',
  promptCacheSent: false,
  batch: false,
  tools: false,
  fallback: false,
});

export const SONNET_5_5_US: CandidateProfile = Object.freeze({
  profileId: 'SONNET_5_5_US',
  modelId: 'claude-sonnet-5-5',
  provider: 'AWS_BEDROCK',
  inferenceProfileId: 'us.anthropic.claude-sonnet-5-5',
  tariffEvidence: 'UNVERIFIED_PLANNING',
  location: 'us',
  effort: 'high',
  inputMicroUsdPerToken: 2.2,
  outputMicroUsdPerToken: 11,
  retentionClass: 'NO_PROVIDER_MINIMUM',
  eligibility: SIMULATED_RECORD,
});

export const OPUS_5_5_US: CandidateProfile = Object.freeze({
  profileId: 'OPUS_5_5_US',
  modelId: 'claude-opus-5-5',
  provider: 'AWS_BEDROCK',
  inferenceProfileId: 'us.anthropic.claude-opus-5-5',
  tariffEvidence: 'UNVERIFIED_PLANNING',
  location: 'us',
  effort: 'high',
  inputMicroUsdPerToken: 4.4,
  outputMicroUsdPerToken: 22,
  retentionClass: 'NO_PROVIDER_MINIMUM',
  eligibility: SIMULATED_RECORD,
});

/** Negative control: no adapter and no read-back exist for it, so admission refuses it. */
export const GEMINI_UNVERIFIED: CandidateProfile = Object.freeze({
  profileId: 'GEMINI_UNVERIFIED',
  modelId: 'gemini-unverified',
  provider: 'GOOGLE_VERTEX',
  inferenceProfileId: '',
  tariffEvidence: 'UNVERIFIED_PLANNING',
  location: 'us',
  effort: 'high',
  inputMicroUsdPerToken: 0,
  outputMicroUsdPerToken: 0,
  retentionClass: 'UNKNOWN',
  eligibility: null,
});

export type Admission = { readonly admitted: true; readonly profile: CandidateProfile } | { readonly admitted: false; readonly reason: string };

/** A US geography cross-region inference profile of an Anthropic model (D4-BR-1); the wire checks the full spelling. */
const US_GEOGRAPHY_PROFILE = /^us\.anthropic\.[a-z0-9]/u;

/** Eligibility, evaluated before any cost comparison. */
export function admitCandidate(profile: CandidateProfile): Admission {
  if (profile.provider !== 'AWS_BEDROCK') return { admitted: false, reason: `PROVIDER_RETIRED_A9: ${profile.profileId} is served through ${String(profile.provider)}; Amazon Bedrock is the only admitted provider (owner decision A9, 2026-10-05)` };
  if (!US_GEOGRAPHY_PROFILE.test(profile.inferenceProfileId)) return { admitted: false, reason: `${profile.profileId} inference profile ${profile.inferenceProfileId} is not a us. geography profile (D4-BR-1)` };
  const record = profile.eligibility;
  if (record === null) return { admitted: false, reason: `${profile.profileId} has no read-back privacy and retention record` };
  if (profile.retentionClass !== 'NO_PROVIDER_MINIMUM') return { admitted: false, reason: `${profile.profileId} retention class ${profile.retentionClass} is not NO_PROVIDER_MINIMUM` };
  if (record.termsAccepted !== true || record.requestResponseLogging !== 'OFF' || record.promptCacheSent !== false || record.batch !== false || record.tools !== false || record.fallback !== false) {
    return { admitted: false, reason: `${profile.profileId} read-back record does not show logging off, no cache, no batch, no tools and no fallback` };
  }
  if (profile.location !== 'us' || profile.effort !== 'high') return { admitted: false, reason: `${profile.profileId} is not pinned to location us and effort high` };
  return { admitted: true, profile };
}

export interface CandidateSelection {
  readonly selected: CandidateProfile | null;
  readonly refused: readonly { readonly profileId: string; readonly reason: string }[];
}

/** Lexicographic: admission first, cost only among the admitted; ties keep the earlier profile. */
export function selectCandidate(profiles: readonly CandidateProfile[], cost: (profile: CandidateProfile) => number): CandidateSelection {
  const refused: { profileId: string; reason: string }[] = [];
  let selected: CandidateProfile | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const profile of profiles) {
    const admission = admitCandidate(profile);
    if (!admission.admitted) {
      refused.push({ profileId: profile.profileId, reason: admission.reason });
      continue;
    }
    const price = cost(profile);
    if (price < best) {
      best = price;
      selected = profile;
    }
  }
  return { selected, refused };
}
