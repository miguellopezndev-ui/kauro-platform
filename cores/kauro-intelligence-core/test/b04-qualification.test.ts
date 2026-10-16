import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { HARD_GATES, QUALIFICATION_CORPUS, report, sealExpectedTruth } from '../src/benchmark/harness.js';
import type { BenchmarkFixture, BenchmarkReport, FixtureFamily, FixtureScore, HardGate, ScoreCheck } from '../src/benchmark/harness.js';
import { SUBJECT_FIELDS, bindRun, qualifyThreeRuns, subjectProblems, summarizeReceipts } from '../src/benchmark/qualification.js';
import type { QualificationSubject, RunEvidence, RunRecord } from '../src/benchmark/qualification.js';
import { OPUS_5_5_US, SONNET_5_5_US } from '../src/gateway/candidates.js';
import { oracleTransport } from '../src/gateway/fake-gateway.js';
import { MemoryDispatchAdmission } from '../src/kernel/admission.js';
import { CampaignAdmission, campaignGrantProblems, envelopeOf, projectedRunMicros, tariffForProfile } from '../src/provider/campaign-grant.js';
import type { CampaignGrant, CampaignJournal, CampaignLedgerEvent } from '../src/provider/campaign-grant.js';
import { vertexGateway } from '../src/provider/vertex-gateway.js';
import { requestReceipt, responseReceipt } from '../src/provider/vertex-receipts.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import type { VertexFetch } from '../src/provider/vertex-transport.js';
import { CONTEXT, depsFor, inputFor, makeBundle, profileBundle, realValidationPort } from './support/fixtures.js';
import { drain } from './support/vertex-replay.js';
import { canonicalJson } from '../src/contracts/canonical.js';
import { parseProviderRequestPayload } from '../src/gateway/transport-gateway.js';
import { bedrockUrl, toBedrockBody } from '../src/provider/bedrock-wire.js';
import { toVertexBody } from '../src/provider/vertex-wire.js';
import { runVector } from './support/egress-harness.js';

/**
 * B04-QUALIFY (SIMULATED, no network, no paid inference). Reports are built over a synthetic 600-fixture universe whose scores
 * are shaped like the scorer shapes them; receipts are synthetic Bedrock receipts built by the real receipt constructors. A run
 * here is arithmetic over those: nothing in this file is qualification evidence for the product.
 */
const HASHES = { profileHash: 'a'.repeat(64), candidateSetHash: 'b'.repeat(64), targetContractHash: null, projectRevisionHash: 'c'.repeat(64) };
const hex = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One real provider request of the B03 core path (SIMULATED answers): the template every synthetic exchange re-addresses to its own run. */
const TEMPLATE = (await runVector('CLEAN_ONLY', { id: 'qualify', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] })).requests[0] ?? '';
const TEMPLATE_PAYLOAD = parseProviderRequestPayload(TEMPLATE);
/** The Bedrock InvokeModel bytes (bedrock-2023-05-31) of the template request under another run id: the run id stands once, in the request block. */
const providerBytesFor = (runId: string, template = TEMPLATE): string => canonicalJson(toBedrockBody(JSON.parse(template.split(TEMPLATE_PAYLOAD.runId).join(runId)) as Parameters<typeof toBedrockBody>[0]))
/** The retired Vertex rawPredict bytes: qualification no longer accepts them (A9). */
const retiredVertexBytesFor = (runId: string): string => canonicalJson(toVertexBody(JSON.parse(TEMPLATE.split(TEMPLATE_PAYLOAD.runId).join(runId)) as Parameters<typeof toVertexBody>[0]));

const SUBJECT: QualificationSubject = {
  servedModel: 'claude-sonnet-5-5', location: 'us', modelPolicyHash: TEMPLATE_PAYLOAD.policyRef.modelPolicyHash, promptBundleHash: TEMPLATE_PAYLOAD.promptRef.promptBundleHash, compilerContractVersion: '1.0.0',
  migrationCoreVersion: '2.0.3', icPackageDigest: hex('3'), scorerDigest: hex('4'), corpusDigest: hex('5'),
};

function fixture(id: string, family: FixtureFamily): BenchmarkFixture {
  return sealExpectedTruth({ fixtureFormatVersion: '1.1.0', fixtureId: id, family, weight: 1, expectedInputHashes: HASHES, expectedOutcomeClass: family === 'AMBIGUOUS_ABSTENTION' ? 'ABSTAINED' : 'PROPOSED', allowedAlternatives: [], expectedCandidates: [], forbiddenDestinationFields: [], requiredEvidenceRefs: [], expectedCompilerResult: 'ANY', expectedPreserved: ['Record ID'], expectedTaskTypes: [], dataLevelCeiling: 'L0', budgetCeiling: { maxCalls: 1, maxInvocations: 1, maxBilledInputTokens: 1000, maxBilledOutputTokens: 100 }, gates: { identityUnproven: true, injectionSentinels: ['sentinel-1'], foreignRefs: ['foreign-1'], secretSentinels: ['secret-1'], safetyCritical: true } });
}

/** The OPUS-Q1 universe exactly: 600 fixtures, 200/100/100/100/100. */
function universe(): BenchmarkFixture[] {
  const out: BenchmarkFixture[] = [];
  for (const family of Object.keys(QUALIFICATION_CORPUS.families) as FixtureFamily[]) for (let index = 0; index < QUALIFICATION_CORPUS.families[family]; index += 1) out.push(fixture(`${family}-${String(index)}`, family));
  return out;
}
const CORPUS = universe();

function scoreOf(entry: BenchmarkFixture, tag: string): FixtureScore {
  const checks: ScoreCheck[] = HARD_GATES.map((gate) => ({ check: `gate:${gate}`, gate, expected: 'nothing', observed: `nothing:${tag}`, pass: true }));
  checks.push({ check: 'outcome_class', gate: null, expected: entry.expectedOutcomeClass, observed: entry.expectedOutcomeClass, pass: true });
  return { fixtureId: entry.fixtureId, family: entry.family, weight: entry.weight, expectedTruthDigest: entry.expectedTruthDigest, runId: `run_${tag}_${entry.fixtureId}`, correct: true, candidateFailure: false, checks, hardGateViolations: [], gateChecksExecuted: Object.fromEntries(HARD_GATES.map((gate) => [gate, 1])) as Record<HardGate, number>, scorerFailure: null };
}

const reportFor = (tag: string): BenchmarkReport => report(CORPUS, CORPUS.map((entry) => scoreOf(entry, tag)), `campaign-${tag}`, 'QUALIFICATION');

/** The InvokeModel URL of the subject's us. inference profile in a US source region (A9, D4-BR-1). */
const SUBJECT_URL = bedrockUrl('us-east-1', SONNET_5_5_US.inferenceProfileId);
const RETIRED_VERTEX_URL = `https://aiplatform.us.rep.googleapis.com/v1/projects/kauro-sim-project/locations/${SUBJECT.location}/publishers/anthropic/models/${SUBJECT.servedModel}:rawPredict`;

/** Synthetic Bedrock receipts of one report: for every evaluated run, a real provider request carrying that run id and the subject's bundle and policy, and its 200 answer, built by the real constructors. */
function receiptsOf(tag: string, servedModel = SUBJECT.servedModel, count = CORPUS.length): ProtectedReceipt[] {
  const out: ProtectedReceipt[] = [];
  for (let index = 0; index < count; index += 1) {
    const runId = `run_${tag}_${CORPUS[index]?.fixtureId ?? ''}`;
    const body = providerBytesFor(runId);
    out.push(requestReceipt({ url: SUBJECT_URL, headers: { 'content-type': 'application/json' }, bodyBytes: body, idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
    const text = JSON.stringify({ id: `msg_bdrk_${tag}_${String(index)}`, type: 'message', model: servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } });
    out.push(responseReceipt({ status: 200, headers: {}, bodyText: text, bodyLength: text.length, truncated: false, latencyMs: 1, idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
  }
  return out;
}

interface Built { readonly run: RunRecord; readonly receipts: ProtectedReceipt[] }
/** Which fixture each run of a report evaluated, as the scores say: bound in the run record under the report's digest. */
const runFixturesOf = (tag: string): { runId: string; fixtureId: string }[] => CORPUS.map((entry) => ({ runId: `run_${tag}_${entry.fixtureId}`, fixtureId: entry.fixtureId }));
function runOf(tag: string, options: { subject?: QualificationSubject; evidence?: RunEvidence; servedModel?: string } = {}): Built {
  const receipts = receiptsOf(tag, options.servedModel);
  return { run: bindRun(reportFor(tag), { subject: options.subject ?? SUBJECT, evidence: options.evidence ?? 'EXECUTED_PROVIDER', receipts, runFixtures: runFixturesOf(tag) }), receipts };
}
type Replay = NonNullable<Parameters<typeof qualifyThreeRuns>[2]>;
/** Runs of the first three fixtures sent nothing; the replay over every fixture proves exactly those three offline. */
const offlineOf = (tag: string): { runId: string; fixtureId: string }[] => CORPUS.slice(0, 3).map((entry) => ({ runId: `run_${tag}_${entry.fixtureId}`, fixtureId: entry.fixtureId }));
const PROVEN_FIRST3: Replay = { replayed: CORPUS.map((entry) => entry.fixtureId), offline: CORPUS.slice(0, 3).map((entry) => entry.fixtureId) };
function offlineRun(tag: string, offline = offlineOf(tag)): Built {
  const declared = new Set(offline.map((one) => one.runId));
  const receipts = receiptsOf(tag).filter((receipt) => !declared.has(receipt.runId ?? ''));
  return { run: bindRun(reportFor(tag), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts, offline, runFixtures: runFixturesOf(tag) }), receipts };
}
const qualify = (builts: readonly Built[], replay?: Replay): ReturnType<typeof qualifyThreeRuns> => qualifyThreeRuns(builts.map((built) => built.run), builts.map((built) => built.receipts), replay);

describe('B04-QUALIFY: subject, independence and the campaign grant (SIMULATED)', () => {
  it('IC-11: one report submitted three times, or three reports sharing a provider message id or request digest, is RUNS_NOT_INDEPENDENT; three reports with disjoint receipts qualify', () => {
    const one = runOf('a');
    const thrice = qualify([one, one, one]);
    assert.equal(thrice.qualified, false);
    assert.ok(thrice.reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:') && reason.includes('provider message ids shared') && reason.includes('request digests shared')), thrice.reasons.join('; '));

    // Three reports of their own campaigns and run ids that share one provider message id: not independent, by that id alone.
    const [b, c, d] = [runOf('b'), runOf('c'), runOf('d')] as [Built, Built, Built];
    const sharedId = (b.receipts.find((receipt) => receipt.kind === 'RESPONSE') as { providerMessageId: string }).providerMessageId;
    const withSharedId = receiptsOf('c');
    const reused = JSON.stringify({ id: sharedId, type: 'message', model: SUBJECT.servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } });
    withSharedId[1] = responseReceipt({ status: 200, headers: {}, bodyText: reused, bodyLength: reused.length, truncated: false, latencyMs: 1, idempotencyRef: 'idem-c-0', runId: withSharedId[0]?.runId ?? null });
    const cSharing: Built = { run: bindRun(reportFor('c'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: withSharedId }), receipts: withSharedId };
    const sharingId = qualify([b, cSharing, d]);
    assert.equal(sharingId.qualified, false);
    assert.ok(sharingId.reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:') && reason.includes('provider message ids shared') && reason.includes(sharedId)), sharingId.reasons.join('; '));
    assert.ok(!sharingId.reasons.some((reason) => reason.includes('request digests shared')), 'the request bodies differ; only the id is shared');

    // One request body shared: by digest alone.
    const withSharedBody = receiptsOf('d');
    const original = b.receipts[0];
    assert.ok(original !== undefined && original.kind === 'REQUEST');
    withSharedBody[0] = requestReceipt({ url: original.url, headers: original.headers, bodyBytes: original.bodyBytes, idempotencyRef: 'idem-d-0', runId: withSharedBody[0]?.runId ?? null });
    const dSharing: Built = { run: bindRun(reportFor('d'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: withSharedBody }), receipts: withSharedBody };
    const sharingBody = qualify([b, c, dSharing]);
    assert.equal(sharingBody.qualified, false);
    assert.ok(sharingBody.reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:') && reason.includes('request digests shared') && !reason.includes('provider message ids shared')), sharingBody.reasons.join('; '));

    // The control: three reports of one subject with pairwise disjoint receipts qualify, and the receipts on disk are what their digests say.
    const qualified = qualify([b, c, d]);
    assert.deepEqual(qualified.reasons, []);
    assert.equal(qualified.qualified, true);
    assert.equal(qualified.meanSupportedCorrectness, 1);
    // A receipt set that is not the one the report bound is refused; so is a qualification with no receipts presented.
    const swapped = qualifyThreeRuns([b.run, c.run, d.run], [b.receipts, c.receipts, receiptsOf('e')]);
    assert.ok(swapped.reasons.some((reason) => reason.startsWith('RUN_3_RECEIPTS_DO_NOT_MATCH_DIGEST')), swapped.reasons.join('; '));
    assert.ok(qualifyThreeRuns([b.run, c.run, d.run]).reasons.includes('RECEIPTS_NOT_PRESENTED'));
  });

  it('IC-11: a campaign whose next request does not fit the remaining grant stops before sending, and a run whose projected cost does not fit does not start', async () => {
    const grant: CampaignGrant = { grantId: 'grant-A', stages: ['SMOKE', 'PILOT'], capMicros: 1_000, expiresAt: '2999-01-01T00:00:00.000Z', approvalRef: 'owner-approval-SIMULATED', candidates: ['SONNET_5_5_US'], maxRuns: null };
    assert.deepEqual(campaignGrantProblems(grant), []);
    assert.ok(campaignGrantProblems({ ...grant, capMicros: -1 }).length > 0);
    assert.ok(campaignGrantProblems({ ...grant, approvalRef: '' }).length > 0);
    const inner = new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000 });
    const campaign = new CampaignAdmission({ grant, stage: 'PILOT', inner, now: () => Date.parse('2026-10-08T00:00:00.000Z') });

    // Request level: the worst-case charge must fit what is left after the holds; the inner admission is not asked for one that does not.
    assert.equal(await campaign.admit({ runId: 'r1', reservationId: 'q1', maxChargeMicros: 600 }), 'ADMITTED');
    assert.equal(await campaign.admit({ runId: 'r1', reservationId: 'q2', maxChargeMicros: 401 }), 'NO_FUNDED_GRANT', '600 held, 400 left: 401 is not sent');
    assert.equal(inner.admissions.length, 1, 'the refused request never reached the dispatch admission');
    assert.equal(await campaign.admit({ runId: 'r1', reservationId: 'q3', maxChargeMicros: 400 }), 'ADMITTED', 'exactly what is left fits');
    await campaign.settle({ runId: 'r1', reservationId: 'q1', state: 'COMMITTED', chargeMicros: 100, usageKnown: true });
    await campaign.settle({ runId: 'r1', reservationId: 'q3', state: 'RELEASED', chargeMicros: 0, usageKnown: true });
    assert.equal(campaign.balance().remainingMicros, 900, 'a released hold is returned; a commit consumes its charge, not its reservation');
    // An unknown usage holds its whole reservation (AMBIGUOUS), and the cap is never exceeded by what is held.
    assert.equal(await campaign.admit({ runId: 'r1', reservationId: 'q4', maxChargeMicros: 900 }), 'ADMITTED');
    await campaign.settle({ runId: 'r1', reservationId: 'q4', state: 'AMBIGUOUS', chargeMicros: 900, usageKnown: false });
    assert.equal(campaign.balance().heldMicros, 900);
    assert.equal(await campaign.admit({ runId: 'r1', reservationId: 'q5', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT');

    // A grant for another stage, an expired grant and a liability each refuse before anything is asked of the dispatch admission.
    const asked = new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000 });
    assert.equal(await new CampaignAdmission({ grant, stage: 'QUALIFICATION', inner: asked, now: () => 0 }).admit({ runId: 'r', reservationId: 'x', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT');
    assert.equal(await new CampaignAdmission({ grant, stage: 'PILOT', inner: asked, now: () => Date.parse('3000-01-01T00:00:00.000Z') }).admit({ runId: 'r', reservationId: 'x', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT');
    const liable = new CampaignAdmission({ grant, stage: 'PILOT', inner: asked, now: () => 0 });
    assert.equal(await liable.admit({ runId: 'r', reservationId: 'y', maxChargeMicros: 10 }), 'ADMITTED');
    await liable.settle({ runId: 'r', reservationId: 'y', state: 'COMMITTED', chargeMicros: 11, usageKnown: true });
    assert.equal(liable.halted(), 'LIABILITY_ABOVE_RESERVATION');
    assert.equal(await liable.admit({ runId: 'r', reservationId: 'z', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT', 'a liability stops the campaign');
    assert.equal(asked.admissions.length, 1);

    // Run level: a run starts only if its projected full cost (per fixture x fixtures x 1.15, rounded up) fits what is left.
    assert.equal(projectedRunMicros(1_000, 600), 690_000);
    const qualification = (capMicros: number): CampaignAdmission => new CampaignAdmission({ grant: { ...grant, stages: ['QUALIFICATION'], capMicros }, stage: 'QUALIFICATION', inner: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000 }), now: () => 0 });
    const funded = qualification(690_000);
    assert.deepEqual(funded.beginRun({ runId: 'run-1', candidate: 'SONNET_5_5_US', fixtures: 600, perFixtureMicros: 1_000 }), { started: true, projectedMicros: 690_000, reason: null });
    assert.equal(funded.beginRun({ runId: 'run-2', candidate: 'SONNET_5_5_US', fixtures: 600, perFixtureMicros: 1_000 }).reason, 'RUN_IN_PROGRESS');
    funded.endRun('run-1');
    assert.deepEqual(qualification(689_999).beginRun({ runId: 'run-1', candidate: 'SONNET_5_5_US', fixtures: 600, perFixtureMicros: 1_000 }), { started: false, projectedMicros: 690_000, reason: 'PROJECTED_COST_DOES_NOT_FIT' });
    // Every 50 fixtures: committed + held over the projection by 25 % stops the campaign; so does any named stop event.
    const watched = qualification(10_000_000);
    watched.beginRun({ runId: 'w', candidate: 'SONNET_5_5_US', fixtures: 100, perFixtureMicros: 1_000 });
    assert.equal(await watched.admit({ runId: 'w', reservationId: 'a', maxChargeMicros: 143_750 }), 'ADMITTED');
    assert.equal(watched.checkpoint(50), 'CONTINUE', '143,750 is exactly 125 % of the 115,000 projection');
    assert.equal(await watched.admit({ runId: 'w', reservationId: 'b', maxChargeMicros: 1 }), 'ADMITTED');
    assert.equal(watched.checkpoint(100), 'STOP');
    assert.equal(watched.halted(), 'RUN_PROJECTION_EXCEEDED_BY_25_PERCENT');
    for (const event of ['HARD_GATE_VIOLATION', 'CANARY_HIT', 'SERVED_MODEL_CHANGE'] as const) {
      const stopped = qualification(10_000_000);
      stopped.stopFor(event);
      assert.equal(await stopped.admit({ runId: 'r', reservationId: 'k', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT', event);
      assert.equal(stopped.halted(), event);
    }

    // Through the public core: a grant that cannot hold the worst-case charge of the first request means no byte is sent.
    const bundle = makeBundle('b04-qualify-grant');
    try {
      const profiled = profileBundle(bundle, 'CLEAN_ONLY');
      const input = inputFor('CLEAN_ONLY', profiled, null);
      const oracle = oracleTransport();
      let sent = 0;
      const fetchImpl: VertexFetch = async (_url, init) => {
        sent += 1;
        const text = Buffer.from(await drain(init.body)).toString('utf8');
        const { anthropic_version: _version, ...rest } = JSON.parse(text) as Record<string, unknown>;
        const answered = await oracle({ model: SONNET_5_5_US.modelId, ...rest } as never, '2999-01-01T00:00:00.000Z');
        return new Response(JSON.stringify(answered.body), { status: answered.status, headers: { 'content-type': 'application/json' } });
      };
      const gateway = vertexGateway({ project: 'kauro-sim-project', profile: SONNET_5_5_US, tokenProvider: async () => ({ token: 'ya29.SIMULATED-TOKEN-NOT-A-SECRET-0003', expiresAt: '2999-01-01T00:00:00.000Z' }), fetchImpl, sink: () => undefined, now: () => 0 });
      const deps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null, {}));
      const tight = new CampaignAdmission({ grant: { ...grant, capMicros: 1 }, stage: 'PILOT', inner: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }), now: () => 0 });
      await createIntelligenceCore({ ...deps, tariff: tariffForProfile(SONNET_5_5_US, 1_000), dispatchAdmission: tight }).run(input, CONTEXT);
      assert.equal(sent, 0, 'the request was not sent: its worst-case charge does not fit one micro');
      assert.equal(tight.balance().chargedMicros, 0);
      assert.ok(tight.refusals.length > 0 && tight.refusals.every((refusal) => refusal.reason === 'REQUEST_DOES_NOT_FIT_REMAINING_GRANT'));
      // The control: the same run under a grant that holds the worst case does send.
      const controlGrant = { ...grant, capMicros: 100_000_000_000 };
      const funded = new CampaignAdmission({ grant: controlGrant, stage: 'PILOT', inner: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }), now: () => 0 });
      const fundedDeps = depsFor(gateway, realValidationPort(bundle, profiled.profile, null, {}));
      await createIntelligenceCore({ ...fundedDeps, tariff: tariffForProfile(SONNET_5_5_US, 1_000), dispatchAdmission: funded }).run(input, { ...CONTEXT, auditAttemptId: 'attempt-funded' });
      assert.ok(sent > 0, 'with the funds the request goes out; the zero above is the grant, not the harness');
    } finally {
      bundle.dispose();
    }
  });

  it('IC-11 grant: a settled reservation asked again is refused without touching the campaign, its charge stays spent, and the cap holds even over a larger host grant', async () => {
    const grant: CampaignGrant = { grantId: 'grant-R2', stages: ['PILOT'], capMicros: 100, expiresAt: '2999-01-01T00:00:00.000Z', approvalRef: 'owner-approval-SIMULATED', candidates: ['SONNET_5_5_US'], maxRuns: null };
    const host = new MemoryDispatchAdmission({ fundedMicros: 1_000 });
    const campaign = new CampaignAdmission({ grant, stage: 'PILOT', inner: host, now: () => 0 });
    assert.equal(await campaign.admit({ runId: 'r', reservationId: 'x', maxChargeMicros: 50 }), 'ADMITTED');
    await campaign.settle({ runId: 'r', reservationId: 'x', state: 'COMMITTED', chargeMicros: 50, usageKnown: true });
    // Codex B04-R2: admitting x again overwrote the commit with a hold, and the inner refusal then deleted the entry.
    await assert.rejects(campaign.admit({ runId: 'r', reservationId: 'x', maxChargeMicros: 50 }), /already|settled/iu);
    assert.equal(campaign.balance().chargedMicros, 50, 'the committed charge is still spent');
    assert.equal(campaign.balance().remainingMicros, 50);
    assert.equal(await campaign.admit({ runId: 'r', reservationId: 'y', maxChargeMicros: 100 }), 'NO_FUNDED_GRANT', '100 does not fit the 50 left');
    assert.equal(host.admissions.filter((one) => one.outcome === 'ADMITTED').length, 1, 'the host grant was never asked to hold beyond the campaign cap');
    // A held reservation asked again at another maximum is refused and keeps its hold; an ambiguous one stays held.
    assert.equal(await campaign.admit({ runId: 'r', reservationId: 'h', maxChargeMicros: 20 }), 'ADMITTED');
    await assert.rejects(campaign.admit({ runId: 'r', reservationId: 'h', maxChargeMicros: 30 }), /already|HELD/iu);
    assert.equal(campaign.balance().heldMicros, 20);
    await campaign.settle({ runId: 'r', reservationId: 'h', state: 'AMBIGUOUS', chargeMicros: 20, usageKnown: false });
    await assert.rejects(campaign.admit({ runId: 'r', reservationId: 'h', maxChargeMicros: 20 }), /already|AMBIGUOUS/iu);
    assert.equal(campaign.balance().heldMicros, 20, 'the ambiguous hold is still counted as spent');
    // The control: the same reservation asked again while it is HELD at the same maximum is the same admission.
    assert.equal(await campaign.admit({ runId: 'r', reservationId: 'z', maxChargeMicros: 10 }), 'ADMITTED');
    assert.equal(await campaign.admit({ runId: 'r', reservationId: 'z', maxChargeMicros: 10 }), 'ADMITTED');
    assert.equal(campaign.balance().heldMicros, 30);
  });

  it('IC-11 grant ledger: invocations over one grant share its durable ledger, so the cap is spent once; a second open while one holds the lock, a ledger of another grant and a torn ledger are refused; ambiguous holds and stops survive a restart', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const lib = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'grant-ledger.mjs')).href)) as {
      ledgerPathOf: (grantPath: string) => string;
      openGrantLedger: (path: string, grant: CampaignGrant) => { events: readonly unknown[]; append: (event: unknown) => void; close: () => void };
    };
    const { appendFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'b04-ledger-'));
    const codeOf = (run: () => unknown): string => { try { run(); } catch (error) { return String((error as { code?: unknown }).code); } return 'OPENED'; };
    try {
      const grant: CampaignGrant = { grantId: 'grant-R1', stages: ['SMOKE', 'PILOT'], capMicros: 100, expiresAt: '2999-01-01T00:00:00.000Z', approvalRef: 'owner-approval-SIMULATED', candidates: ['SONNET_5_5_US'], maxRuns: null };
      const admissionOver = (journal: CampaignJournal, stage: 'SMOKE' | 'PILOT' = 'PILOT'): CampaignAdmission => new CampaignAdmission({ grant, stage, inner: new MemoryDispatchAdmission({ fundedMicros: grant.capMicros }), now: () => 0, journal });
      // Codex B04-R1: three invocations each built a fresh admission at the full cap and spent 300 micros of a 100-micro grant.
      const path = lib.ledgerPathOf(join(dir, 'grant.json'));
      assert.equal(path, join(dir, 'grant.json.ledger.jsonl'), 'the ledger sits beside the grant file');
      const outcomes: string[] = [];
      for (const [n, stage] of [[1, 'SMOKE'], [2, 'PILOT'], [3, 'PILOT']] as const) {
        const ledger = lib.openGrantLedger(path, grant);
        try {
          const admission = admissionOver(ledger as CampaignJournal, stage);
          const outcome = await admission.admit({ runId: `invocation-${String(n)}`, reservationId: 'q', maxChargeMicros: 100 });
          if (outcome === 'ADMITTED') await admission.settle({ runId: `invocation-${String(n)}`, reservationId: 'q', state: 'COMMITTED', chargeMicros: 100, usageKnown: true });
          outcomes.push(outcome);
        } finally { ledger.close(); }
      }
      assert.deepEqual(outcomes, ['ADMITTED', 'NO_FUNDED_GRANT', 'NO_FUNDED_GRANT'], 'the grant is spent once across invocations');

      // Concurrent invocations: the ledger is exclusively locked while one is open.
      const lockedPath = lib.ledgerPathOf(join(dir, 'grant-lock.json'));
      const holder = lib.openGrantLedger(lockedPath, grant);
      assert.equal(codeOf(() => lib.openGrantLedger(lockedPath, grant)), 'GRANT_LEDGER_LOCKED');
      holder.close();
      lib.openGrantLedger(lockedPath, grant).close();

      // An ambiguous hold, and a hold left in flight when the process ended, are spent after a restart until reconciled.
      const crashPath = lib.ledgerPathOf(join(dir, 'grant-crash.json'));
      const first = lib.openGrantLedger(crashPath, grant);
      const before = admissionOver(first as CampaignJournal);
      assert.equal(await before.admit({ runId: 'r', reservationId: 'a', maxChargeMicros: 30 }), 'ADMITTED');
      await before.settle({ runId: 'r', reservationId: 'a', state: 'AMBIGUOUS', chargeMicros: 30, usageKnown: false });
      assert.equal(await before.admit({ runId: 'r', reservationId: 'b', maxChargeMicros: 20 }), 'ADMITTED');
      first.close();
      const second = lib.openGrantLedger(crashPath, grant);
      const after = admissionOver(second as CampaignJournal);
      assert.equal(after.balance().heldMicros, 50, 'both holds come back held');
      assert.equal(after.balance().remainingMicros, 50);
      assert.equal(await after.admit({ runId: 'r2', reservationId: 'c', maxChargeMicros: 51 }), 'NO_FUNDED_GRANT');
      await after.settle({ runId: 'r', reservationId: 'b', state: 'COMMITTED', chargeMicros: 5, usageKnown: true });
      assert.deepEqual([after.balance().heldMicros, after.balance().chargedMicros], [30, 5], 'reconciled by a later settlement');
      after.stopFor('CANARY_HIT');
      second.close();
      const third = lib.openGrantLedger(crashPath, grant);
      const stopped = admissionOver(third as CampaignJournal);
      assert.equal(stopped.halted(), 'CANARY_HIT', 'a stop survives the restart');
      assert.equal(await stopped.admit({ runId: 'r3', reservationId: 'd', maxChargeMicros: 1 }), 'NO_FUNDED_GRANT');
      third.close();

      // A ledger is bound to its grant: the same file under a raised cap is refused; a torn ledger is refused, not repaired.
      assert.equal(codeOf(() => lib.openGrantLedger(crashPath, { ...grant, capMicros: 1_000 })), 'GRANT_LEDGER_MISMATCH');
      appendFileSync(crashPath, '{"kind":"HOLD","runId":"r4"');
      assert.equal(codeOf(() => lib.openGrantLedger(crashPath, grant)), 'GRANT_LEDGER_CORRUPT');

      // A ledger that cannot be written stops the change: nothing is held and the host is never asked.
      const host = new MemoryDispatchAdmission({ fundedMicros: 100 });
      const unwritable = new CampaignAdmission({ grant, stage: 'PILOT', inner: host, now: () => 0, journal: { events: [], append: () => { throw new Error('disk full'); } } });
      await assert.rejects(unwritable.admit({ runId: 'r', reservationId: 'e', maxChargeMicros: 1 }), /disk full/u);
      assert.equal(host.admissions.length, 0);
      assert.equal(unwritable.balance().heldMicros, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const memoryJournal = (events: CampaignLedgerEvent[] = []): CampaignJournal & { readonly events: CampaignLedgerEvent[] } => ({ events, append: (event) => { events.push(event); } });
  const scopedGrant = (over: Partial<CampaignGrant> = {}): CampaignGrant => ({ grantId: 'grant-B', stages: ['QUALIFICATION'], capMicros: 1_000_000_000, expiresAt: '2999-01-01T00:00:00.000Z', approvalRef: 'owner-approval-SIMULATED', candidates: ['SONNET_5_5_US'], maxRuns: 4, ...over });
  const admissionFor = (grant: CampaignGrant, journal: CampaignJournal, stage: 'QUALIFICATION' | 'PILOT' = 'QUALIFICATION'): CampaignAdmission => new CampaignAdmission({ grant, stage, inner: new MemoryDispatchAdmission({ fundedMicros: 1_000_000_000_000 }), now: () => 0, journal });

  it('IC-11 grant scope: a grant names its candidates and run count; Opus under grant B, a fifth run, or a reused run number is refused before any hold, and a crashed run still counts', async () => {
    const grant = scopedGrant();
    assert.deepEqual(campaignGrantProblems(grant), []);
    assert.deepEqual(campaignGrantProblems({ ...grant, maxRuns: null }), []);
    const { candidates: _candidates, ...withoutCandidates } = grant;
    const { maxRuns: _maxRuns, ...withoutMaxRuns } = grant;
    for (const [name, bad] of [['no candidates member', withoutCandidates], ['an empty candidate list', { ...grant, candidates: [] }], ['a candidate that is not a label', { ...grant, candidates: [''] }], ['a candidate that is not a string', { ...grant, candidates: [7] }], ['no maxRuns member', withoutMaxRuns], ['a negative maxRuns', { ...grant, maxRuns: -1 }], ['a fractional maxRuns', { ...grant, maxRuns: 1.5 }], ['a zero maxRuns', { ...grant, maxRuns: 0 }]] as const) {
      assert.ok(campaignGrantProblems(bad).length > 0, name);
      assert.throws(() => new CampaignAdmission({ grant: bad as unknown as CampaignGrant, stage: 'QUALIFICATION', inner: new MemoryDispatchAdmission({ fundedMicros: 1 }), now: () => 0 }), /not a campaign grant/u, name);
    }
    const run = (runId: string, candidate: string, runNo: number | null): Parameters<CampaignAdmission['beginRun']>[0] => ({ runId, candidate, runNo, fixtures: 600, perFixtureMicros: 1 });

    // Opus under grant B: refused at the run start, before any hold, and nothing is written.
    const journal = memoryJournal();
    const admission = admissionFor(grant, journal);
    assert.deepEqual(admission.beginRun(run('opus-1', 'OPUS_5_5_US', 1)), { started: false, projectedMicros: 690, reason: 'CANDIDATE_NOT_GRANTED' });
    assert.equal(journal.events.length, 0, 'a refused run writes nothing and holds nothing');
    assert.equal(admission.balance().heldMicros, 0);

    // The four runs the grant names start, each written to the ledger before it takes effect; a fifth is refused.
    for (const runNo of [1, 2, 3, 4]) {
      assert.equal(admission.beginRun(run(`sonnet-${String(runNo)}`, 'SONNET_5_5_US', runNo)).started, true, `run ${String(runNo)}`);
      admission.endRun(`sonnet-${String(runNo)}`);
    }
    assert.deepEqual(journal.events.map((event) => event.kind), ['RUN', 'RUN', 'RUN', 'RUN']);
    assert.deepEqual(journal.events[0], { kind: 'RUN', runId: 'sonnet-1', stage: 'QUALIFICATION', runNo: 1, candidate: 'SONNET_5_5_US' });
    assert.equal(admission.beginRun(run('sonnet-5', 'SONNET_5_5_US', 5)).reason, 'MAX_RUNS_REACHED');
    assert.equal(journal.events.length, 4, 'the fifth run is not written');

    // A run number already used is refused, even with runs to spare.
    const roomy = admissionFor(scopedGrant({ maxRuns: 10 }), memoryJournal());
    assert.equal(roomy.beginRun(run('a', 'SONNET_5_5_US', 2)).started, true);
    roomy.endRun('a');
    assert.equal(roomy.beginRun(run('b', 'SONNET_5_5_US', 2)).reason, 'RUN_NO_ALREADY_USED');
    assert.equal(roomy.beginRun(run('c', 'SONNET_5_5_US', 3)).started, true, 'another number is a new run');
    roomy.endRun('c');

    // A crashed run still counts: the process ended with the run open (no endRun); the restart reads its RUN line.
    const crashed = memoryJournal();
    const dying = admissionFor(scopedGrant({ maxRuns: 2 }), crashed);
    assert.equal(dying.beginRun(run('x1', 'SONNET_5_5_US', 1)).started, true);
    assert.equal(dying.beginRun(run('x2', 'SONNET_5_5_US', 2)).reason, 'RUN_IN_PROGRESS');
    const restarted = admissionFor(scopedGrant({ maxRuns: 2 }), memoryJournal([...crashed.events]));
    assert.equal(restarted.beginRun(run('x1-again', 'SONNET_5_5_US', 1)).reason, 'RUN_NO_ALREADY_USED', 'the crashed run used its number');
    assert.equal(restarted.beginRun(run('x2', 'SONNET_5_5_US', 2)).started, true, 'one run of two is left');
    restarted.endRun('x2');
    assert.equal(restarted.beginRun(run('x3', 'SONNET_5_5_US', 3)).reason, 'MAX_RUNS_REACHED', 'the crashed run and this one are the two');
    // A pilot run carries no number: only the candidate and the count apply, and a run without a number never collides.
    const pilot = admissionFor(scopedGrant({ stages: ['PILOT'], candidates: ['SONNET_5_5_US', 'OPUS_5_5_US'], maxRuns: null }), memoryJournal(), 'PILOT');
    for (const candidate of ['SONNET_5_5_US', 'OPUS_5_5_US'] as const) { assert.equal(pilot.beginRun(run(`p-${candidate}`, candidate, null)).started, true, candidate); pilot.endRun(`p-${candidate}`); }
    // An expired grant starts no run (G60).
    const expired = new CampaignAdmission({ grant: scopedGrant({ expiresAt: '2026-10-01T00:00:00.000Z' }), stage: 'QUALIFICATION', inner: new MemoryDispatchAdmission({ fundedMicros: 1 }), now: () => Date.parse('2026-10-06T00:00:00.000Z') });
    assert.equal(expired.beginRun(run('late', 'SONNET_5_5_US', 1)).reason, 'GRANT_EXPIRED');
  });

  it('G23 grant: a hold carries its request key; only a reconciliation releases an AMBIGUOUS hold, once, and a restart keeps it released', async () => {
    const grant = scopedGrant({ stages: ['PILOT'], capMicros: 1_000 });
    const journal = memoryJournal();
    const admission = admissionFor(grant, journal, 'PILOT');
    assert.equal(await admission.admit({ runId: 'r', reservationId: 'a', maxChargeMicros: 300, requestKey: 'rk-a' }), 'ADMITTED');
    assert.equal(await admission.admit({ runId: 'r', reservationId: 'b', maxChargeMicros: 200, requestKey: 'rk-b' }), 'ADMITTED');
    assert.deepEqual(journal.events.filter((event) => event.kind === 'HOLD').map((event) => (event as { requestKey?: string }).requestKey), ['rk-a', 'rk-b'], 'the request key is on the HOLD line');
    await admission.settle({ runId: 'r', reservationId: 'a', state: 'AMBIGUOUS', chargeMicros: 300, usageKnown: false });
    // An ordinary RELEASED settlement of an AMBIGUOUS hold is not a proof: the hold stays spent.
    await assert.rejects(admission.settle({ runId: 'r', reservationId: 'a', state: 'RELEASED', chargeMicros: 0, usageKnown: true }), /cannot be settled RELEASED/u);
    assert.equal(admission.balance().heldMicros, 500);
    // A hold still in flight is not reconciled by this process (its sender may be alive): only an AMBIGUOUS hold is.
    assert.deepEqual(admission.releaseAmbiguous({ requestKey: 'rk-b', reason: 'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:doc' }), { released: false, why: 'HOLD_IS_HELD' });
    assert.deepEqual(admission.releaseAmbiguous({ requestKey: 'rk-unknown', reason: 'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:doc' }), { released: false, why: 'NO_HOLD_FOR_REQUEST_KEY' });
    assert.throws(() => admission.releaseAmbiguous({ requestKey: 'rk-a', reason: '' }), /reason/u);
    assert.equal(admission.balance().heldMicros, 500, 'nothing changed by the refusals');

    const reason = 'PROVIDER_DOCUMENTED_NON_ACCEPTANCE:https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html#API_runtime_InvokeModel_Errors';
    assert.deepEqual(admission.releaseAmbiguous({ requestKey: 'rk-a', reason }), { released: true, why: null });
    assert.deepEqual([admission.balance().heldMicros, admission.balance().remainingMicros], [200, 800], 'the released hold is returned to the grant');
    const settles = journal.events.filter((event) => event.kind === 'SETTLE');
    assert.deepEqual(settles[settles.length - 1], { kind: 'SETTLE', runId: 'r', reservationId: 'a', state: 'RELEASED', chargeMicros: 0, requestKey: 'rk-a', reason, reconciled: true });
    assert.deepEqual(admission.releaseAmbiguous({ requestKey: 'rk-a', reason }), { released: false, why: 'HOLD_IS_RELEASED' }, 'a second reconciliation changes nothing');
    assert.equal(journal.events.filter((event) => event.kind === 'SETTLE' && (event as { reconciled?: boolean }).reconciled === true).length, 1);

    // The restart: the in-flight hold b comes back AMBIGUOUS; a stays released; b can be reconciled by its key.
    const restarted = admissionFor(grant, memoryJournal([...journal.events]), 'PILOT');
    assert.deepEqual([restarted.balance().heldMicros, restarted.balance().remainingMicros], [200, 800], 'the reconciled release survives the restart');
    assert.deepEqual(restarted.releaseAmbiguous({ requestKey: 'rk-b', reason }), { released: true, why: null }, 'a hold in flight when the process died is AMBIGUOUS and reconciles');
    assert.equal(restarted.balance().heldMicros, 0);
    // A committed hold is never released by a reconciliation.
    assert.equal(await restarted.admit({ runId: 'r2', reservationId: 'c', maxChargeMicros: 100, requestKey: 'rk-c' }), 'ADMITTED');
    await restarted.settle({ runId: 'r2', reservationId: 'c', state: 'COMMITTED', chargeMicros: 40, usageKnown: true });
    assert.deepEqual(restarted.releaseAmbiguous({ requestKey: 'rk-c', reason }), { released: false, why: 'HOLD_IS_COMMITTED' });
    assert.equal(restarted.balance().chargedMicros, 40);
  });

  it('R2-040 Vertex retired: receipts at the retired Vertex rawPredict endpoint with vertex-2023-10-16 bodies no longer qualify, whatever else is sound (A9)', () => {
    const retiredRun = (tag: string): Built => {
      const receipts: ProtectedReceipt[] = [];
      CORPUS.forEach((entry, index) => {
        const runId = `run_${tag}_${entry.fixtureId}`;
        receipts.push(requestReceipt({ url: RETIRED_VERTEX_URL, headers: { 'content-type': 'application/json' }, bodyBytes: retiredVertexBytesFor(runId), idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
        const text = JSON.stringify({ id: `msg_${tag}_${String(index)}`, type: 'message', model: SUBJECT.servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } });
        receipts.push(responseReceipt({ status: 200, headers: {}, bodyText: text, bodyLength: text.length, truncated: false, latencyMs: 1, idempotencyRef: `idem-${tag}-${String(index)}`, runId }));
      });
      return { run: bindRun(reportFor(tag), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts, runFixtures: runFixturesOf(tag) }), receipts };
    };
    assert.deepEqual(qualify([runOf('rv1'), runOf('rv2'), runOf('rv3')]).reasons, [], 'the control: Bedrock receipts of the subject qualify');
    const result = qualify([retiredRun('rv4'), runOf('rv5'), runOf('rv6')]);
    assert.equal(result.qualified, false);
    assert.ok(result.reasons.some((one) => one.startsWith('RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT')), result.reasons.join('; '));
  });

  it('S044: reports whose subjects differ in served model, prompt bundle, policy, core, package, scorer or corpus are not aggregated, and a run whose receipts show a served-model change is invalid', () => {
    assert.deepEqual(subjectProblems(SUBJECT), []);
    const differing: Record<string, string> = { servedModel: 'claude-opus-5-5', location: 'europe', modelPolicyHash: hex('a'), promptBundleHash: hex('b'), compilerContractVersion: '1.0.1', migrationCoreVersion: '2.0.4', icPackageDigest: hex('c'), scorerDigest: hex('d'), corpusDigest: hex('e') };
    assert.deepEqual([...SUBJECT_FIELDS].sort(), Object.keys(differing).sort(), 'the subject has exactly the nine fields of D4-CAMP-2');
    for (const field of SUBJECT_FIELDS) {
      const odd = runOf('s2', { subject: { ...SUBJECT, [field]: differing[field] } });
      const refused = qualify([runOf('s1'), odd, runOf('s3')]);
      assert.equal(refused.qualified, false, field);
      assert.ok(refused.reasons.some((reason) => reason.startsWith('SUBJECTS_DIFFER:') && reason.split(':')[1]?.split(',').includes(field)), `${field}: ${refused.reasons.join('; ')}`);
      assert.equal(refused.meanSupportedCorrectness, null, `${field}: reports of different subjects are not averaged`);
    }
    // A subject that is not a subject is refused on its own: a missing field, a hash that is not a digest, a field nobody declared.
    assert.ok(subjectProblems({ ...SUBJECT, servedModel: '' }).length > 0);
    assert.ok(subjectProblems({ ...SUBJECT, icPackageDigest: 'not-a-digest' }).length > 0);
    assert.ok(subjectProblems({ ...SUBJECT, extra: 'x' } as unknown as QualificationSubject).length > 0);
    // A report that carries no subject is not a qualification run.
    const unbound = qualifyThreeRuns([{ report: reportFor('u1') }, { report: reportFor('u2') }, { report: reportFor('u3') }] as unknown as readonly RunRecord[]);
    assert.equal(unbound.qualified, false);

    // The served model is read from every response: one answer from another model mid-run makes that run invalid, not averaged.
    const switched = runOf('m2', { servedModel: 'claude-opus-5-5' });
    assert.ok(switched.run.receipts.servedModels.includes('claude-opus-5-5'));
    const refused = qualify([runOf('m1'), switched, runOf('m3')]);
    assert.equal(refused.qualified, false);
    assert.ok(refused.reasons.some((reason) => reason.startsWith('RUN_2_SERVED_MODEL_CHANGED_MID_RUN:') && reason.includes('claude-opus-5-5')), refused.reasons.join('; '));
    assert.equal(refused.meanSupportedCorrectness, null);
    // The receipts are what is read, whatever the report says: one answer of another model among the subject's is the same change.
    const mixed = receiptsOf('m4');
    mixed.push(...receiptsOf('m4b', 'claude-opus-5-5', 1));
    assert.equal(summarizeReceipts(mixed).servedModels.length, 2);
    // The control: all three on one model qualify.
    assert.equal(qualify([runOf('m5'), runOf('m6'), runOf('m7')]).qualified, true);
  });

  it('R2-039: a copied run or a replay of stored responses is refused as a run by subject and receipt identity; the replay may re-score and is labelled REPLAY', () => {
    const original = runOf('r1');
    // A copy: another campaign id and another set of run ids over the very same stored receipts.
    const copyReport = report(CORPUS, CORPUS.map((entry) => scoreOf(entry, 'copy')), 'campaign-copy', 'QUALIFICATION');
    const copy: Built = { run: bindRun(copyReport, { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: original.receipts }), receipts: original.receipts };
    assert.equal(copy.run.receipts.receiptSetDigest, original.run.receipts.receiptSetDigest, 'the same receipts have the same identity whatever report sits on them');
    const copied = qualify([original, copy, runOf('r2')]);
    assert.equal(copied.qualified, false);
    assert.ok(copied.reasons.some((reason) => reason.startsWith('RUNS_NOT_INDEPENDENT:') && reason.includes('provider message ids shared') && reason.includes('request digests shared')), copied.reasons.join('; '));

    // A replay: stored responses re-scored. It is a report, it can pass, it is labelled REPLAY, and it is never one of the three runs.
    const replayed = bindRun(report(CORPUS, CORPUS.map((entry) => scoreOf(entry, 'replay')), 'campaign-replay', 'QUALIFICATION'), { subject: SUBJECT, evidence: 'REPLAY', receipts: original.receipts });
    assert.equal(replayed.evidence, 'REPLAY');
    assert.equal(replayed.report.passing, true, 'a replay may re-score');
    const refused = qualifyThreeRuns([original.run, replayed, runOf('r3').run], [original.receipts, original.receipts, receiptsOf('r3')]);
    assert.equal(refused.qualified, false);
    assert.ok(refused.reasons.includes('RUN_2_REPLAY_IS_NOT_A_RUN'), refused.reasons.join('; '));
    // Even with receipts nobody else holds, a replay does not become a run, and simulated evidence is never qualification evidence.
    const fresh = receiptsOf('r4');
    const alone = bindRun(report(CORPUS, CORPUS.map((entry) => scoreOf(entry, 'r4')), 'campaign-r4', 'QUALIFICATION'), { subject: SUBJECT, evidence: 'REPLAY', receipts: fresh });
    assert.ok(qualifyThreeRuns([original.run, alone, runOf('r5').run], [original.receipts, fresh, receiptsOf('r5')]).reasons.includes('RUN_2_REPLAY_IS_NOT_A_RUN'));
    const simulated = bindRun(reportFor('r6'), { subject: SUBJECT, evidence: 'SIMULATED', receipts: receiptsOf('r6') });
    assert.ok(qualifyThreeRuns([original.run, simulated, runOf('r7').run], [original.receipts, receiptsOf('r6'), receiptsOf('r7')]).reasons.includes('RUN_2_NOT_EXECUTED_PROVIDER_EVIDENCE:SIMULATED'));
    // An edited run record no longer matches its own digest.
    const edited = { ...original.run, subject: { ...SUBJECT, corpusDigest: hex('f') } };
    assert.ok(qualifyThreeRuns([edited, runOf('r8').run, runOf('r9').run]).reasons.some((reason) => reason.startsWith('RUN_1_RECORD_DIGEST_MISMATCH')));
  });

  it('R2-039 provenance: a run is backed only by successful exchanges of its own report runs at the subject endpoint; failure-only, unrelated, unpaired, id-less, edited or body-less receipts are refused, never passed vacuously', () => {
    // Codex B04-R3: three passing reports, each bound to one request of its own body under an unrelated run id and URL and one 403
    // with no provider message id, qualified with meanSupportedCorrectness 1.
    const unrelated = (tag: string): ProtectedReceipt[] => [
      requestReceipt({ url: 'https://example.invalid/elsewhere', headers: { 'content-type': 'application/json' }, bodyBytes: tag, idempotencyRef: `idem-${tag}`, runId: `unrelated-${tag}` }),
      responseReceipt({ status: 403, headers: {}, bodyText: '{"error":{"code":403}}', bodyLength: 22, truncated: false, latencyMs: 1, idempotencyRef: `idem-${tag}`, runId: `unrelated-${tag}` }),
    ];
    const forged = ['a', 'b', 'c'].map((tag) => { const receipts = unrelated(tag); return { run: bindRun(reportFor(`p${tag}`), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts }), receipts }; });
    const refused = qualify(forged);
    assert.equal(refused.qualified, false);
    assert.equal(refused.meanSupportedCorrectness, null);
    for (const reason of ['RUN_1_NO_SUCCESSFUL_EXCHANGE', 'RUN_1_RECEIPTS_NOT_OF_REPORT_RUNS', 'RUN_1_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT']) assert.ok(refused.reasons.some((one) => one.startsWith(reason)), `${reason}: ${refused.reasons.join('; ')}`);

    // One defect at a time over otherwise sound runs: each is refused for its own reason.
    const sound = (): [Built, Built, Built] => [runOf('v1'), runOf('v2'), runOf('v3')];
    const withSecond = (receipts: ProtectedReceipt[]): Built[] => { const [a, , c] = sound(); return [a, { run: bindRun(reportFor('v2'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts }), receipts }, c]; };
    const reasonsOf = (builts: readonly Built[]): string[] => { const result = qualify(builts); assert.equal(result.qualified, false); return [...result.reasons]; };
    const base = receiptsOf('v2');
    const failureOnly = base.map((receipt) => (receipt.kind === 'RESPONSE' ? responseReceipt({ status: 500, headers: {}, bodyText: '{"error":{"code":500}}', bodyLength: 22, truncated: false, latencyMs: 1, idempotencyRef: receipt.idempotencyRef, runId: receipt.runId }) : receipt));
    assert.ok(reasonsOf(withSecond(failureOnly)).some((one) => one.startsWith('RUN_2_NO_SUCCESSFUL_EXCHANGE')), 'only failures');
    const unpaired = base.map((receipt) => (receipt.kind === 'REQUEST' ? requestReceipt({ url: receipt.url, headers: receipt.headers, bodyBytes: receipt.bodyBytes, idempotencyRef: `other-${String(receipt.idempotencyRef)}`, runId: receipt.runId }) : receipt));
    assert.ok(reasonsOf(withSecond(unpaired)).some((one) => one.startsWith('RUN_2_UNPAIRED_EXCHANGE')), 'answers no request of theirs asked for');
    const noId = base.map((receipt) => { if (receipt.kind !== 'RESPONSE') return receipt; const text = JSON.stringify({ type: 'message', model: SUBJECT.servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } }); return responseReceipt({ status: 200, headers: {}, bodyText: text, bodyLength: text.length, truncated: false, latencyMs: 1, idempotencyRef: receipt.idempotencyRef, runId: receipt.runId }); });
    assert.ok(reasonsOf(withSecond(noId)).some((one) => one.startsWith('RUN_2_ANSWER_WITHOUT_PROVIDER_MESSAGE_ID')), 'a 200 without a provider message id');
    const otherModelUrl = base.map((receipt) => (receipt.kind === 'REQUEST' ? requestReceipt({ url: bedrockUrl('us-east-1', OPUS_5_5_US.inferenceProfileId), headers: receipt.headers, bodyBytes: receipt.bodyBytes, idempotencyRef: receipt.idempotencyRef, runId: receipt.runId }) : receipt));
    assert.ok(reasonsOf(withSecond(otherModelUrl)).some((one) => one.startsWith('RUN_2_RECEIPTS_NOT_FOR_SUBJECT_ENDPOINT')), 'requests sent to another model');
    const editedBody = base.map((receipt) => (receipt.kind === 'REQUEST' ? { ...receipt, bodyBytes: `${receipt.bodyBytes} ` } : receipt));
    assert.ok(reasonsOf(withSecond(editedBody)).some((one) => one.startsWith('RUN_2_RECEIPT_NOT_ITS_BODY')), 'request bytes that are not the digest');
    const claimedId = base.map((receipt) => (receipt.kind === 'RESPONSE' ? { ...receipt, providerMessageId: `claimed-${String(receipt.providerMessageId)}` } : receipt));
    assert.ok(reasonsOf(withSecond(claimedId)).some((one) => one.startsWith('RUN_2_RECEIPT_NOT_ITS_BODY')), 'a provider message id the body does not carry');
    const bodiless = base.map((receipt) => (receipt.kind === 'REQUEST' ? { ...receipt, bodyBytes: '' } : { ...receipt, bodyText: '' }));
    assert.ok(reasonsOf(withSecond(bodiless)).some((one) => one.startsWith('RUN_2_RECEIPT_BODIES_NOT_PRESENTED')), 'light receipts prove nothing');
    // A record whose receipt summary has no provider message id and no served model fails on its own, without the receipts on disk.
    const empty = bindRun(reportFor('v4'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: failureOnly });
    assert.ok(qualifyThreeRuns([runOf('v5').run, empty, runOf('v6').run]).reasons.some((one) => one.startsWith('RUN_2_NO_SUCCESSFUL_EXCHANGE')));
    // The control: the same three sound runs qualify.
    assert.deepEqual(qualify(sound()).reasons, []);
  });

  it('R2-039 every run: each evaluated run of a report is backed by its own paired successful exchange whose request parses to that run, the subject bundle and policy; one exchange for 600 runs, unparsable or foreign requests and an exchange counted twice are refused', () => {
    // Codex re-check of B04-R3: three passing 600-run reports, each with ONE request/200 pair under its first run id, bodies 'a', 'b', 'c', qualified.
    const onePair = (tag: string, body: string): Built => {
      const runId = reportFor(tag).runIds[0] ?? '';
      const text = JSON.stringify({ id: `msg_bdrk_one_${tag}`, type: 'message', model: SUBJECT.servedModel, stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } });
      const receipts = [
        requestReceipt({ url: SUBJECT_URL, headers: { 'content-type': 'application/json' }, bodyBytes: body, idempotencyRef: `idem-one-${tag}`, runId }),
        responseReceipt({ status: 200, headers: {}, bodyText: text, bodyLength: text.length, truncated: false, latencyMs: 1, idempotencyRef: `idem-one-${tag}`, runId }),
      ];
      return { run: bindRun(reportFor(tag), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts }), receipts };
    };
    const probe = qualify([onePair('o1', 'a'), onePair('o2', 'b'), onePair('o3', 'c')]);
    assert.equal(probe.qualified, false);
    assert.equal(probe.meanSupportedCorrectness, null);
    assert.ok(probe.reasons.some((one) => one.startsWith('RUN_1_REQUEST_NOT_A_PROVIDER_REQUEST')), probe.reasons.join('; '));
    assert.ok(probe.reasons.some((one) => one.startsWith('RUN_1_RUNS_NOT_SUBSTANTIATED:600')), probe.reasons.join('; '));
    // A real request for the first run only: the other 599 runs have no exchange of their own.
    const firstOnly = qualify([onePair('f1', providerBytesFor(reportFor('f1').runIds[0] ?? '')), onePair('f2', providerBytesFor(reportFor('f2').runIds[0] ?? '')), onePair('f3', providerBytesFor(reportFor('f3').runIds[0] ?? ''))]);
    assert.ok(firstOnly.reasons.some((one) => one.startsWith('RUN_1_RUNS_NOT_SUBSTANTIATED:599')), firstOnly.reasons.join('; '));
    assert.ok(!firstOnly.reasons.some((one) => one.startsWith('RUN_1_REQUEST_NOT_A_PROVIDER_REQUEST')));

    const withSecond = (receipts: ProtectedReceipt[], offline: readonly { runId: string; fixtureId: string }[] = []): Built[] => [runOf('w1'), { run: bindRun(reportFor('w2'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts, offline, runFixtures: runFixturesOf('w2') }), receipts }, runOf('w3')];
    const reasonsOf = (builts: readonly Built[]): string[] => { const result = qualify(builts); assert.equal(result.qualified, false); return [...result.reasons]; };
    const base = receiptsOf('w2');
    // A request whose embedded run id is another run's than the receipt says.
    const swappedRun = base.map((receipt, index) => (receipt.kind === 'REQUEST' && index === 0 ? requestReceipt({ url: receipt.url, headers: receipt.headers, bodyBytes: providerBytesFor(base[2]?.runId ?? ''), idempotencyRef: receipt.idempotencyRef, runId: receipt.runId }) : receipt));
    assert.ok(reasonsOf(withSecond(swappedRun)).some((one) => one.startsWith('RUN_2_REQUEST_NOT_OF_ITS_RUN')), 'a request of another run');
    // A request under another prompt bundle or policy than the subject declares.
    const otherBundle = TEMPLATE.split(TEMPLATE_PAYLOAD.promptRef.promptBundleHash).join(hex('9'));
    const foreignBundle = base.map((receipt, index) => (receipt.kind === 'REQUEST' && index === 0 ? requestReceipt({ url: receipt.url, headers: receipt.headers, bodyBytes: providerBytesFor(receipt.runId ?? '', otherBundle), idempotencyRef: receipt.idempotencyRef, runId: receipt.runId }) : receipt));
    assert.ok(reasonsOf(withSecond(foreignBundle)).some((one) => one.startsWith('RUN_2_REQUEST_NOT_A_PROVIDER_REQUEST') || one.startsWith('RUN_2_REQUEST_NOT_OF_THE_SUBJECT')), 'another prompt bundle');
    // One exchange counted for two runs: the same provider answer presented under two runs.
    const twice = [...base];
    const firstAnswer = base[1];
    const secondAnswer = base[3];
    assert.ok(firstAnswer?.kind === 'RESPONSE' && secondAnswer?.kind === 'RESPONSE');
    twice[3] = responseReceipt({ status: 200, headers: {}, bodyText: firstAnswer.bodyText, bodyLength: firstAnswer.bodyLength, truncated: false, latencyMs: 1, idempotencyRef: secondAnswer.idempotencyRef, runId: secondAnswer.runId });
    assert.ok(reasonsOf(withSecond(twice)).some((one) => one.startsWith('RUN_2_EXCHANGE_COUNTED_TWICE')), 'one answer for two runs');
    // A run the record declares offline (the core sent nothing for it) carries no exchange; one with receipts, or an offline set that differs between the runs, is refused.
    const reasonsWith = (builts: readonly Built[]): string[] => { const result = qualify(builts, PROVEN_FIRST3); assert.equal(result.qualified, false); return [...result.reasons]; };
    assert.deepEqual(qualify([offlineRun('d1'), offlineRun('d2'), offlineRun('d3')], PROVEN_FIRST3).reasons, [], 'the same three fixtures offline in every run, proven by the replay, every other run backed: qualified');
    assert.ok(reasonsWith([offlineRun('e1'), offlineRun('e2', offlineOf('e2').slice(0, 2)), offlineRun('e3')]).some((one) => one.startsWith('OFFLINE_FIXTURES_DIFFER')), 'a deterministic run is offline in every run or in none');
    const claimedButSent = { run: bindRun(reportFor('e5'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: receiptsOf('e5'), offline: offlineOf('e5'), runFixtures: runFixturesOf('e5') }), receipts: receiptsOf('e5') };
    assert.ok(reasonsWith([offlineRun('e4'), claimedButSent, offlineRun('e6')]).some((one) => one.startsWith('RUN_2_OFFLINE_RUN_WITH_EXCHANGES')), 'a run declared offline that sent requests');
    const notOfReport = offlineRun('e8', [{ runId: 'run_unknown', fixtureId: CORPUS[0]?.fixtureId ?? '' }, ...offlineOf('e8').slice(1)]);
    assert.ok(reasonsWith([offlineRun('e7'), notOfReport, offlineRun('e9')]).some((one) => one.startsWith('RUN_2_OFFLINE_RUN_NOT_OF_REPORT')));
    // The control: every run of every report substantiated by its own exchange.
    assert.deepEqual(qualify([runOf('w4'), runOf('w5'), runOf('w6')]).reasons, []);
  });

  it('R2-039 offline proven: a run counts as offline only when the record binds every run to its fixture and the replay of that fixture through the core with a send-refusing transport decides it with zero requests; a declared offline fixture that would send, an unproven one, and a replay-offline fixture carrying exchanges are refused', () => {
    // Declared but not proven: without the replay nothing declared offline is believed.
    assert.ok(qualify([offlineRun('n1'), offlineRun('n2'), offlineRun('n3')]).reasons.some((one) => one.startsWith('RUN_1_OFFLINE_NOT_PROVEN')));
    // The replay covered the fixtures and decided only two of the three without a request: the third would send.
    const two = { replayed: CORPUS.map((entry) => entry.fixtureId), offline: CORPUS.slice(0, 2).map((entry) => entry.fixtureId) };
    assert.ok(qualify([offlineRun('n4'), offlineRun('n5'), offlineRun('n6')], two).reasons.some((one) => one.startsWith('RUN_1_DECLARED_OFFLINE_WOULD_SEND')));
    // The replay did not cover a declared fixture: not proven.
    const partial = { replayed: CORPUS.slice(1).map((entry) => entry.fixtureId), offline: CORPUS.slice(1, 3).map((entry) => entry.fixtureId) };
    assert.ok(qualify([offlineRun('n7'), offlineRun('n8'), offlineRun('n9')], partial).reasons.some((one) => one.startsWith('RUN_1_OFFLINE_NOT_PROVEN')));
    // The replay decides a fourth fixture without a request, but the runs present exchanges for it: refused.
    const four = { replayed: CORPUS.map((entry) => entry.fixtureId), offline: CORPUS.slice(0, 4).map((entry) => entry.fixtureId) };
    assert.ok(qualify([offlineRun('m1'), offlineRun('m2'), offlineRun('m3')], four).reasons.some((one) => one.startsWith('RUN_1_REPLAY_OFFLINE_FIXTURE_WITH_EXCHANGES')));
    // Every run names its fixture under the record's digest: a record without the mapping, or with a run the report does not have, is refused.
    const unmapped = receiptsOf('u4');
    const noMap = { run: bindRun(reportFor('u4'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: unmapped }), receipts: unmapped };
    assert.ok(qualify([runOf('u5'), noMap, runOf('u6')]).reasons.some((one) => one.startsWith('RUN_2_RUN_FIXTURES_NOT_BOUND')));
    const wrongMap = { run: bindRun(reportFor('u7'), { subject: SUBJECT, evidence: 'EXECUTED_PROVIDER', receipts: receiptsOf('u7'), runFixtures: [...runFixturesOf('u7').slice(1), { runId: 'run_other', fixtureId: CORPUS[0]?.fixtureId ?? '' }] }), receipts: receiptsOf('u7') };
    assert.ok(qualify([runOf('u8'), wrongMap, runOf('u9')]).reasons.some((one) => one.startsWith('RUN_2_RUN_FIXTURES_NOT_BOUND')));
    const edited = { ...offlineRun('u1').run, runFixtures: runFixturesOf('u2') };
    assert.ok(qualifyThreeRuns([offlineRun('u0').run, edited, offlineRun('u3').run], undefined, PROVEN_FIRST3).reasons.some((one) => one.startsWith('RUN_2_RECORD_DIGEST_MISMATCH')), 'the mapping is under the record digest');
    // The control: proven offline, bound mapping, every other run backed.
    assert.deepEqual(qualify([offlineRun('k1'), offlineRun('k2'), offlineRun('k3')], PROVEN_FIRST3).reasons, []);
  });

  it('B04-QUALIFY envelope: the reservation is the exact first-attempt bytes of the sealed corpus at the tariff, with repairs and output the only estimates', () => {
    const tariff = tariffForProfile(SONNET_5_5_US, 0);
    assert.equal(tariff.inputMicrosPerToken, 2.2);
    assert.equal(tariff.outputMicrosPerToken, 11);
    const bytes = [{ fixtureId: 'f1', requests: [10_000, 20_000] }, { fixtureId: 'f2', requests: [30_000] }];
    const envelope = envelopeOf(bytes, SONNET_5_5_US, { hiddenInputTokensPerRequest: 500, plannedOutputTokensPerRequest: 1_500, outputCeilingTokens: 8_192, bytesPerToken: 3, repairShare: 0, repairBytes: 0 });
    assert.equal(envelope.requests, 3);
    assert.equal(envelope.requestBytes, 60_000);
    assert.equal(envelope.inputUpperBoundTokens, 60_000 + 1_500);
    assert.equal(envelope.upperBoundMicros, Math.ceil(61_500 * 2.2 + 3 * 8_192 * 11));
    assert.equal(envelope.planningMicros, Math.ceil((60_000 / 3 + 1_500) * 2.2 + 3 * 1_500 * 11));
    assert.equal(envelope.perFixtureMicros, Math.ceil(envelope.planningMicros / 2));
    assert.equal(envelope.exactFirstAttemptBytes, true);
  });
  it('B04-QUALIFY envelope tool: the first-attempt Bedrock body bytes of sealed fixtures are measured through the public core, deterministically, and priced at both tariffs', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const lib = (await import(pathToFileURL(join(root, 'tools', 'campaign', 'envelope-lib.mjs')).href)) as { requestBytesOfFixtures: (fixtures: unknown[], hooks: unknown) => Promise<{ fixtureId: string; requests: number[] }[]>; campaignEnvelopes: (perFixture: unknown[], profiles: unknown[]) => { candidates: Record<string, { requests: number; requestBytes: number; planningMicros: number; upperBoundMicros: number; perFixtureMicros: number; projectedRunMicrosFor600: number }> } };
    const truth = await import('../src/benchmark/truth-answer.js');
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(root, 'corpus', 'fixtures')).filter((name) => name.endsWith('.json')).sort();
    const picked = files.filter((name) => name.includes('seed')).slice(0, 3).map((name) => JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', name), 'utf8')) as unknown);
    assert.ok(picked.length > 0, 'the sealed corpus holds the seed fixtures');
    const hooks = { truthFollowingAnswer: truth.truthFollowingAnswer, sealedObject: truth.sealedObject };
    const first = await lib.requestBytesOfFixtures(picked, hooks);
    const second = await lib.requestBytesOfFixtures(picked, hooks);
    assert.deepEqual(first, second, 'first-attempt bytes are deterministic per fixture');
    assert.ok(first.every((entry) => entry.requests.length > 0 && entry.requests.every((bytes) => bytes > 1_000)));
    const envelopes = lib.campaignEnvelopes(first, [SONNET_5_5_US, { ...SONNET_5_5_US, profileId: 'OPUS_5_5_US', inputMicroUsdPerToken: 4.4, outputMicroUsdPerToken: 22 }]);
    const sonnet = envelopes.candidates['SONNET_5_5_US'];
    const opus = envelopes.candidates['OPUS_5_5_US'];
    assert.ok(sonnet !== undefined && opus !== undefined);
    assert.equal(sonnet.requests, first.reduce((sum, entry) => sum + entry.requests.length, 0));
    assert.ok(Math.abs(opus.planningMicros - sonnet.planningMicros * 2) <= 1, 'Opus is priced at twice Sonnet, to the micro');
    assert.ok(sonnet.upperBoundMicros > sonnet.planningMicros);
    assert.equal(sonnet.projectedRunMicrosFor600, Math.ceil((sonnet.perFixtureMicros * 600 * 115) / 100));
  });
});
