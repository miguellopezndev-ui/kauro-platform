/**
 * The campaign entry point of the package: `kauro-intelligence-core/benchmark` (package.json `exports`, B04-design D4-CAMP-5).
 *
 * The campaign runner installs the packed tarball in a clean directory and imports the package by name, through the public index
 * and through this entry, and nothing else: no path into dist. This entry carries what a campaign needs and the public index
 * does not (the sealed-corpus check, the truth-following stand-ins, the scorer, the report and qualification, the campaign grant
 * and admission, the Bedrock gateway (A9) and the retired Vertex one with their receipts, the SigV4 signer of the preflight probes, the candidate profiles and the pilot selection). It is declared surface:
 * a name is added here, with its test in test/b04-campaign-compare.test.ts, or it is not part of the campaign.
 */
export { createContaminationGuard, verifyCorpus } from './corpus.js';
export type { CorpusFixture, CorpusManifest } from './corpus.js';
export { alwaysAbstainAnswer, sealedObject, truthFollowingAnswer } from './truth-answer.js';
export { capturingTransport, observeEgress, scoreFixture, wireForms } from './scorer.js';
// D4-CHAOS-1: the one list of registered hard gates; the campaign stops a stage durably only on a member of it.
export { HARD_GATES } from './fixture.js';
export { report as benchmarkReport } from './report.js';
export { bindRun, qualifyThreeRuns, summarizeReceipts } from './qualification.js';
export { buildValidityRecord, scorerDigestOf, validityRecordProblems } from './validity.js';
export type { ReleaseBinding, ValidityRecord } from './validity.js';
export { selectFromPilot } from './pilot-selection.js';
export type { PilotCandidateResult, PilotRankRow, PilotRankStatus, PilotSelection } from './pilot-selection.js';
export { CampaignAdmission, campaignGrantProblems, envelopeOf, projectedRunMicros, tariffForProfile } from '../provider/campaign-grant.js';
export type { CampaignGrant, CampaignJournal, CampaignLedgerEvent } from '../provider/campaign-grant.js';
export { vertexGateway } from '../provider/vertex-gateway.js';
export { bedrockGateway } from '../provider/bedrock-gateway.js';
export { reconcileAmbiguousHold, reconcileBedrock } from '../provider/bedrock-receipts.js';
export { amzDateOf, signV4 } from '../provider/bedrock-sigv4.js';
export { BEDROCK_DEFAULT_REGION, BEDROCK_PROFILE, BEDROCK_REGIONS, bedrockUrl, toBedrockBody } from '../provider/bedrock-wire.js';
export { publicProjection, requestReceipt, responseReceipt } from '../provider/vertex-receipts.js';
export type { ProtectedReceipt } from '../provider/vertex-receipts.js';
export { VERTEX_HOST, VERTEX_LOCATION, toVertexBody } from '../provider/vertex-wire.js';
export { OPUS_5_5_US, SONNET_5_5_US, admitCandidate } from '../gateway/candidates.js';
export type { CandidateProfile } from '../gateway/candidates.js';
export { MODEL_POLICY_HASH, MODEL_POLICY_V1, PROMPT_BUNDLE_HASH, candidatePolicyOf } from '../gateway/model-gateway.js';
export { vendorTargetRefFor } from '../adapter/contract-adapter.js';
export { toMigrationConfig } from '../adapter/migration-config.js';
export { effectsFromMigrationRun } from '../adapter/migration-effects.js';
export { createIntelligenceCore } from '../api/intelligence-core.js';
export { digestOf } from '../contracts/canonical.js';
export { cleanOnlyTargetRef } from '../contracts/envelope.js';
export { MODEL_POLICY_VERSION, PROMPT_BUNDLE_VERSION } from '../contracts/versions.js';
export { MemoryDispatchAdmission } from '../kernel/admission.js';
export { MemoryLedgerStore, SystemClock, VirtualClock } from '../kernel/ledger.js';
export { parseProviderRequestPayload, transportGateway } from '../gateway/transport-gateway.js';
