/**
 * B04-CAMPAIGN corrections (B04-design D4-CAMP-1, D4-CAMP-5, D4-POL-1).
 *
 * A. The pilot compares the ADMITTED candidates: it runs every one of them under one grant and one stop rule and ends in a
 *    selection record (lexicographic: eligibility, zero critical, thresholds, cost per accepted plan, latency). Qualification
 *    runs only the selected candidate, and the pinned policy changes only by the release that follows the selection.
 * B. The runner consumes the packed package through a declared entry point (`kauro-intelligence-core/benchmark`) by package
 *    name, from the clean install; no deep path, no junction to the package's dist.
 * No test here makes a network call or spends anything.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { createIntelligenceCore } from '../src/api/intelligence-core.js';
import { selectFromPilot } from '../src/benchmark/pilot-selection.js';
import type { PilotCandidateResult } from '../src/benchmark/pilot-selection.js';
import { digestOf } from '../src/contracts/canonical.js';
import { OPUS_5_5_US, SONNET_5_5_US } from '../src/gateway/candidates.js';
import { scriptedGateway } from '../src/gateway/fake-gateway.js';
import type { GatewayRequest } from '../src/gateway/model-gateway.js';
import { MODEL_POLICY_V1, candidatePolicyOf, isShippedCandidatePolicy } from '../src/gateway/model-gateway.js';
import { buildProviderRequest, parseProviderRequestPayload } from '../src/gateway/transport-gateway.js';
import type { ProviderRequest } from '../src/gateway/transport-gateway.js';
import { ACCOUNT, probeFetch } from './support/bedrock-probes.js';
import { MODES, runVector } from './support/egress-harness.js';
import { depsFor } from './support/fixtures.js';

const root = join(import.meta.dirname, '..', '..');
const toolUrl = (name: string): string => pathToFileURL(join(root, 'tools', 'campaign', name)).href;
// By name, through the package's declared entry; held in variables so the compiler does not resolve the built output it is producing.
const BENCHMARK: string = 'kauro-intelligence-core/benchmark';
const DEEP: string = 'kauro-intelligence-core/dist/src/benchmark/scorer.js';
const work = mkdtempSync(join(tmpdir(), 'b04-compare-test-'));
after(() => { rmSync(work, { recursive: true, force: true }); });

const result = (extra: Partial<PilotCandidateResult> & { profileId: string }): PilotCandidateResult => ({
  modelId: extra.profileId === 'OPUS_5_5_US' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', admitted: true, complete: true, stopped: null, hardGateViolations: 0, scorerFailures: 0,
  supportedPass: true, abstentionPass: true, accepted: 100, chargedMicros: 10_000_000, p50LatencyMs: 4000, ...extra,
});

/** A request the real core path hands the transport, rebuilt as the gateway's request. */
async function sampleRequest(): Promise<GatewayRequest> {
  const observed = await runVector(MODES[0] as (typeof MODES)[number], { id: 'cmp-status', label: 'Segment', options: ['Active', 'Inactive'], safe: true, denied: [] });
  const wire = JSON.parse(observed.requests[0] as string) as ProviderRequest;
  const payload = parseProviderRequestPayload(wire);
  return {
    modelPolicy: MODEL_POLICY_V1, promptBundleRef: payload.promptRef, envelope: payload.envelope, envelopeHash: payload.envelopeHash, runId: payload.runId,
    outputSchema: wire.output_config.format.schema, deadlineAt: '2099-01-01T00:00:00.000Z', idempotencyRef: 'k', maxOutputTokens: 8192,
  } as unknown as GatewayRequest;
}

describe('B04-CAMPAIGN correction A: the candidate policy and the pilot selection', () => {
  it('the pinned policy stays Sonnet 5.5; each shipped candidate has a policy that differs only in its profile and model, and no other policy is shipped', () => {
    assert.equal(MODEL_POLICY_V1.primaryModel, 'claude-sonnet-5-5');
    assert.equal(candidatePolicyOf(SONNET_5_5_US), MODEL_POLICY_V1, 'the Sonnet policy is the pinned one, the same object');
    const opus = candidatePolicyOf(OPUS_5_5_US);
    assert.equal(opus.primaryModel, 'claude-opus-5-5');
    assert.equal(opus.profileId, 'OPUS_5_5_US');
    assert.deepEqual({ ...opus, profileId: '', primaryModel: '' }, { ...MODEL_POLICY_V1, profileId: '', primaryModel: '' });
    assert.notEqual(digestOf(opus), digestOf(MODEL_POLICY_V1));
    assert.equal(isShippedCandidatePolicy(opus), true);
    assert.equal(isShippedCandidatePolicy(MODEL_POLICY_V1), true);
    assert.equal(isShippedCandidatePolicy({ ...opus, primaryModel: 'claude-opus-5' }), false);
    assert.equal(isShippedCandidatePolicy({ ...opus, secondaryModel: 'claude-sonnet-5-5' } as never), false);
    assert.throws(() => candidatePolicyOf({ ...OPUS_5_5_US, profileId: 'GEMINI_UNVERIFIED', modelId: 'gemini-unverified' }), /no candidate policy/u);
  });

  it('a request under the Opus candidate policy builds for claude-opus-5-5 and parses back; one under a policy that is not shipped is refused before a byte is built', async () => {
    const request = await sampleRequest();
    const asked = (modelPolicy: GatewayRequest['modelPolicy']): GatewayRequest => ({ ...request, modelPolicy });
    const built = buildProviderRequest(asked(candidatePolicyOf(OPUS_5_5_US)));
    assert.equal(built.model, 'claude-opus-5-5');
    const payload = parseProviderRequestPayload(JSON.stringify(built));
    assert.equal(payload.policyRef.modelPolicyHash, digestOf(candidatePolicyOf(OPUS_5_5_US)));
    assert.equal(buildProviderRequest(asked(MODEL_POLICY_V1)).model, 'claude-sonnet-5-5');
    assert.throws(() => buildProviderRequest(asked({ ...candidatePolicyOf(OPUS_5_5_US), primaryModel: 'claude-opus-5' } as never)), /differs from|does not carry/u);
    // the wire model and the policy hash in the request block must belong together
    assert.throws(() => parseProviderRequestPayload(JSON.stringify({ ...built, model: 'claude-sonnet-5-5' })), /policy|model/u);
    assert.throws(() => parseProviderRequestPayload(JSON.stringify({ ...built, model: 'claude-opus-5' })), /model/u);
  });

  it('a core is built under the pinned policy unless the host names a shipped candidate policy; any other policy is refused at construction', () => {
    const deps = depsFor(scriptedGateway({}), { validate: async () => { throw new Error('not reached'); } } as never);
    assert.doesNotThrow(() => createIntelligenceCore(deps));
    assert.doesNotThrow(() => createIntelligenceCore({ ...deps, candidatePolicy: candidatePolicyOf(OPUS_5_5_US) }));
    assert.throws(() => createIntelligenceCore({ ...deps, candidatePolicy: { ...MODEL_POLICY_V1, primaryModel: 'claude-opus-5' } as never }), /candidate policy/u);
  });

  it('selection is lexicographic: eligibility, then zero critical, then thresholds, then cost per accepted plan, then latency; every elimination is recorded with its reason', () => {
    const sonnet = result({ profileId: 'SONNET_5_5_US' });
    const opus = result({ profileId: 'OPUS_5_5_US', chargedMicros: 20_000_000 });
    const byCost = selectFromPilot([opus, sonnet], 'claude-sonnet-5-5');
    assert.equal(byCost.selected, 'SONNET_5_5_US');
    assert.equal(byCost.requiresPolicyBump, false);
    assert.deepEqual(byCost.ranking.map((row) => [row.profileId, row.status]), [['SONNET_5_5_US', 'SELECTED'], ['OPUS_5_5_US', 'RANKED_LOWER']]);

    const critical = selectFromPilot([result({ profileId: 'SONNET_5_5_US', hardGateViolations: 1, chargedMicros: 1 }), opus], 'claude-sonnet-5-5');
    assert.equal(critical.selected, 'OPUS_5_5_US', 'a cheaper candidate with a critical violation never wins');
    assert.equal(critical.requiresPolicyBump, true, 'the selection of a model the policy does not name needs the release to bump the policy');
    assert.equal(critical.ranking.find((row) => row.profileId === 'SONNET_5_5_US')?.status, 'ELIMINATED_CRITICAL');

    const stopped = selectFromPilot([result({ profileId: 'SONNET_5_5_US', complete: false, stopped: 'CANARY_HIT' }), opus], 'claude-sonnet-5-5');
    assert.equal(stopped.selected, 'OPUS_5_5_US');
    assert.equal(stopped.ranking.find((row) => row.profileId === 'SONNET_5_5_US')?.status, 'ELIMINATED_CRITICAL');

    const below = selectFromPilot([result({ profileId: 'SONNET_5_5_US', supportedPass: false }), opus], 'claude-sonnet-5-5');
    assert.equal(below.selected, 'OPUS_5_5_US');
    assert.equal(below.ranking.find((row) => row.profileId === 'SONNET_5_5_US')?.status, 'ELIMINATED_THRESHOLDS');

    const ineligible = selectFromPilot([result({ profileId: 'SONNET_5_5_US', admitted: false, chargedMicros: 1 }), opus], 'claude-sonnet-5-5');
    assert.equal(ineligible.selected, 'OPUS_5_5_US');
    assert.equal(ineligible.ranking.find((row) => row.profileId === 'SONNET_5_5_US')?.status, 'ELIMINATED_INELIGIBLE');

    const latency = selectFromPilot([result({ profileId: 'OPUS_5_5_US', p50LatencyMs: 1000 }), result({ profileId: 'SONNET_5_5_US', p50LatencyMs: 2000 })], 'claude-sonnet-5-5');
    assert.equal(latency.selected, 'OPUS_5_5_US', 'equal cost per accepted plan: the faster one');

    const none = selectFromPilot([result({ profileId: 'SONNET_5_5_US', supportedPass: false }), result({ profileId: 'OPUS_5_5_US', abstentionPass: false })], 'claude-sonnet-5-5');
    assert.equal(none.selected, null);
    assert.equal(none.requiresPolicyBump, false);
    const nothingAccepted = selectFromPilot([result({ profileId: 'SONNET_5_5_US', accepted: 0 })], 'claude-sonnet-5-5');
    assert.equal(nothingAccepted.selected, null, 'a cost per accepted plan needs an accepted plan');
  });
});

describe('B04-CAMPAIGN correction B: clean consumption through a declared entry point', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string> };

  it('package.json declares ./benchmark beside the index, and the entry carries what the campaign needs and is the same object the public modules export', async () => {
    assert.equal(pkg.exports['.'], './dist/src/index.js');
    assert.equal(pkg.exports['./benchmark'], './dist/src/benchmark/campaign-surface.js');
    const surface = (await import(BENCHMARK)) as Record<string, unknown>;
    const needed = ['verifyCorpus', 'createContaminationGuard', 'alwaysAbstainAnswer', 'sealedObject', 'truthFollowingAnswer', 'observeEgress', 'scoreFixture', 'capturingTransport', 'wireForms', 'benchmarkReport', 'bindRun', 'qualifyThreeRuns', 'summarizeReceipts', 'scorerDigestOf', 'buildValidityRecord', 'validityRecordProblems', 'CampaignAdmission', 'projectedRunMicros', 'tariffForProfile', 'campaignGrantProblems', 'envelopeOf', 'vertexGateway', 'requestReceipt', 'responseReceipt', 'publicProjection', 'toVertexBody', 'VERTEX_HOST', 'VERTEX_LOCATION', 'OPUS_5_5_US', 'SONNET_5_5_US', 'admitCandidate', 'candidatePolicyOf', 'selectFromPilot', 'vendorTargetRefFor', 'toMigrationConfig', 'effectsFromMigrationRun', 'createIntelligenceCore', 'digestOf', 'MODEL_POLICY_V1', 'transportGateway', 'parseProviderRequestPayload', 'MemoryDispatchAdmission', 'MemoryLedgerStore', 'VirtualClock', 'SystemClock', 'cleanOnlyTargetRef', 'MODEL_POLICY_VERSION', 'PROMPT_BUNDLE_VERSION'];
    for (const name of needed) assert.ok(name in surface, `${name} is not on kauro-intelligence-core/benchmark`);
    assert.equal(surface['SONNET_5_5_US'], SONNET_5_5_US);
    assert.equal(surface['selectFromPilot'], selectFromPilot);
  });

  it('a deep path into the package is not importable: only the index and ./benchmark are declared', async () => {
    await assert.rejects(import(DEEP), (error: NodeJS.ErrnoException) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './benchmark']);
  });

  it('no campaign tool reaches into dist by path: every package import is by package name', () => {
    const offenders: string[] = [];
    const files = [...readdirSync(join(root, 'tools', 'campaign')).map((name) => join(root, 'tools', 'campaign', name)), join(root, 'tools', 'corpus', 'bind.mjs')].filter((path) => path.endsWith('.mjs') && statSync(path).isFile());
    for (const file of files) if (/(?:from|import\()\s*['"][^'"]*dist\/src/u.test(readFileSync(file, 'utf8'))) offenders.push(file.slice(root.length + 1));
    assert.deepEqual(offenders, []);
  });

  it('the clean install the runner builds has the package and the vendored core in node_modules, no dist beside it, and the stage code imports by package name there', { timeout: 300_000 }, async () => {
    const run = (await import(toolUrl('run.mjs'))) as { packAndInstall: (options: { work: string }) => { project: string; tarballSha256: string } };
    const packDir = join(work, 'pack');
    mkdirSync(packDir, { recursive: true });
    const clean = run.packAndInstall({ work: packDir });
    assert.equal(existsSync(join(clean.project, 'dist')), false, 'no junction to the package dist');
    const probe = join(clean.project, 'tools', 'campaign', 'probe.mjs');
    writeFileSync(probe, "const b = await import('kauro-intelligence-core/benchmark'); const deep = await import('kauro-intelligence-core/dist/src/benchmark/scorer.js').then(() => 'IMPORTED', (e) => e.code); process.stdout.write(JSON.stringify({ names: typeof b.CampaignAdmission + typeof b.selectFromPilot, deep }));");
    const ran = spawnSync(process.execPath, [probe], { cwd: clean.project, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), { names: 'functionfunction', deep: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    for (const name of readdirSync(join(clean.project, 'tools', 'campaign'))) if (name.endsWith('.mjs') && name !== 'probe.mjs') assert.doesNotMatch(readFileSync(join(clean.project, 'tools', 'campaign', name), 'utf8'), /(?:from|import\()\s*['"][^'"]*dist\/src/u, name);
    for (const name of readdirSync(join(clean.project, 'tools', 'corpus'))) if (name.endsWith('.mjs')) assert.doesNotMatch(readFileSync(join(clean.project, 'tools', 'corpus', name), 'utf8'), /(?:from|import\()\s*['"][^'"]*dist\/src/u, name);
  });
});

describe('B04-CAMPAIGN correction A: the runner compares admitted candidates in the pilot and qualifies only the selected one', () => {
  const corpusDir = join(root, 'corpus');
  const validityPath = join(corpusDir, 'scorer-validity.json');
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const grantA = { grantId: 'grant-A', stages: ['SMOKE', 'PILOT'], capMicros: 55_000_000, expiresAt: '2026-11-01T00:00:00Z', approvalRef: 'owner-2026-10-08', candidates: ['SONNET_5_5_US', 'OPUS_5_5_US'], maxRuns: null };
  const writeJson = (name: string, value: unknown): string => { const path = join(work, name); writeFileSync(path, JSON.stringify(value)); return path; };
  // Amazon Bedrock (A9): the free reads of the preflight (probes P1-P6) are answered by hand-written SIMULATED replies, and the stage's credential is a SIMULATED temporary one.
  const credentialProvider = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-CAMPAIGN', expiresAt: '2026-10-10T01:00:00Z' });
  const retentionEvidencePath = writeJson('retention.json', { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html', retrievedAt: '2026-10-09T00:00:00Z', sha256: 'a'.repeat(64) });
/** The validity v4 rerun is not what these tests judge (test/b04-scorer-validity.test.ts runs it for real): a stand-in that reports the committed record unchanged, marked INJECTED_TEST_STAND_IN in preflight.json. */
const VALIDITY_RERUN_STAND_IN = ({ record }: { record: unknown }): { stale: boolean; refusals: never[]; binding: null; fresh: unknown } => ({ stale: false, refusals: [], binding: null, fresh: record });
  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({ stage: 'pilot', region: 'us-east-1', location: 'us', awsAccountId: ACCOUNT, grantPath: writeJson('grant-A.json', grantA), validityPath, corpusDir, now: () => NOW, credentialProvider, retentionEvidencePath, validityRerun: VALIDITY_RERUN_STAND_IN, ...extra });
  // The stand-in endpoint answers every candidate with an abstention and echoes the model the URL names.
  const STUB = `
export default function seam({ alwaysAbstainAnswer, parseProviderRequestPayload }) {
  let n = 0;
  const fetch = async (url, init) => {
    const model = /\\/model\\/us\\.anthropic\\.([^/]+)\\/invoke$/u.exec(decodeURIComponent(url))[1];
    const chunks = [];
    for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
    const { anthropic_version, ...rest } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const payload = parseProviderRequestPayload(JSON.stringify({ model, ...rest }));
    n += 1;
    const answer = JSON.stringify(alwaysAbstainAnswer(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash }));
    const usage = { input_tokens: 1000, output_tokens: 100 };
    const body = Buffer.from(JSON.stringify({ id: 'msg_bdrk_stub_' + String(n), type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: answer }], usage }));
    const headers = { 'content-type': 'application/json', 'x-amzn-requestid': 'stub-' + String(n), 'x-amzn-bedrock-input-token-count': '1000', 'x-amzn-bedrock-output-token-count': '100' };
    return { status: 200, headers: { get: (name) => headers[name.toLowerCase()] ?? null, forEach: (callback) => { for (const [key, value] of Object.entries(headers)) callback(value, key); } }, body: (async function* () { yield body; })() };
  };
  return { fetch, credentialProvider: async () => ({ accessKeyId: 'ASIASTUBEXAMPLEKEY01', secretAccessKey: 'stub-secret-not-real', sessionToken: 'stub-session-not-real', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) };
}
`;
  type Ran = { ok: boolean; refusals: readonly { code: string; detail: string }[]; outDir: string | null; summary: Record<string, any> | null };
  const runner = async (): Promise<{ runCampaign: (options: Record<string, unknown>) => Promise<Ran> }> => (await import(toolUrl('run.mjs'))) as { runCampaign: (options: Record<string, unknown>) => Promise<Ran> };

  it('the pilot with no candidate named runs every admitted candidate under the one grant, reads logging back for each model, and writes the comparison and selection record', { timeout: 900_000 }, async () => {
    const stubPath = join(work, 'stub-pilot-seam.mjs');
    writeFileSync(stubPath, STUB);
    const net = probeFetch();
    const ran = await (await runner()).runCampaign({ ...base({ fetchImpl: net.fetchImpl }), outRoot: join(work, 'pilot-out'), seamModule: stubPath, limit: 4 });
    assert.deepEqual(ran.refusals, []);
    assert.ok(ran.outDir !== null && ran.summary !== null);
    assert.equal(net.calls.filter((call) => call.probe === 'P4').length, 2, 'one logging read-back (probe P4) per candidate model');
    const asked = net.calls.filter((call) => call.probe === 'P2').map((call) => decodeURIComponent(call.url));
    assert.ok(asked.some((url) => url.includes('claude-sonnet-5-5')) && asked.some((url) => url.includes('claude-opus-5-5')), "each candidate's own inference profile was read");
    const summary = ran.summary;
    assert.deepEqual(Object.keys(summary['candidates']).sort(), ['OPUS_5_5_US', 'SONNET_5_5_US']);
    for (const id of ['SONNET_5_5_US', 'OPUS_5_5_US']) {
      const one = summary['candidates'][id];
      assert.equal(one.evidence, 'SIMULATED', 'a stand-in endpoint is no provider (Codex B04-R8)');
      assert.equal(one.complete, true, JSON.stringify(one));
      assert.deepEqual(one.measured.servedModels, [id === 'OPUS_5_5_US' ? 'claude-opus-5-5' : 'claude-sonnet-5-5'], 'each candidate was served by its own model');
      assert.ok(existsSync(join(ran.outDir, id, 'receipts.jsonl')), `${id} keeps its own receipts`);
    }
    const selection = summary['selection'];
    assert.equal(selection.selected, null, 'an abstaining stand-in clears no threshold, so nothing is selected');
    assert.deepEqual(selection.ranking.map((row: { profileId: string }) => row.profileId).sort(), ['OPUS_5_5_US', 'SONNET_5_5_US']);
    assert.ok(selection.ranking.every((row: { status: string }) => row.status === 'ELIMINATED_THRESHOLDS'), JSON.stringify(selection.ranking));
    assert.equal(selection.pinnedModel, 'claude-sonnet-5-5');
    assert.ok(existsSync(join(ran.outDir, 'selection.json')));
    const charged = (Object.values(summary['candidates']) as { measured: { chargedMicros: number } }[]).reduce((sum, one) => sum + one.measured.chargedMicros, 0);
    assert.ok(charged > 0 && charged < grantA.capMicros, 'both candidates were charged against the one grant');
    assert.equal(summary['grantChargedMicros'], charged);
  });

  it('qualification refuses a candidate the pinned policy does not name, refuses a candidate the pilot did not select, and a pilot summary that selected nothing', async () => {
    const run = await runner();
    const grantB = writeJson('grant-B.json', { ...grantA, grantId: 'grant-B', stages: ['QUALIFICATION'], capMicros: 285_000_000 });
    const net = probeFetch();
    const pilot = (selected: string | null): string => writeJson(`pilot-${String(selected)}.json`, { stage: 'pilot', evidence: 'EXECUTED_PROVIDER', selection: { selected }, candidates: { SONNET_5_5_US: { measured: { perFixtureMicros: 1_000_000 } }, OPUS_5_5_US: { measured: { perFixtureMicros: 2_000_000 } } } });
    const opus = await run.runCampaign({ ...base({ stage: 'qualify', grantPath: grantB, fetchImpl: net.fetchImpl }), outRoot: join(work, 'q-out'), candidate: 'OPUS_5_5_US', runNo: 1, pilotSummaryPath: pilot('OPUS_5_5_US') });
    assert.ok(opus.refusals.some((refusal) => refusal.code === 'CANDIDATE_NOT_THE_PINNED_POLICY'), JSON.stringify(opus.refusals));
    const notSelected = await run.runCampaign({ ...base({ stage: 'qualify', grantPath: grantB, fetchImpl: net.fetchImpl }), outRoot: join(work, 'q-out'), candidate: 'SONNET_5_5_US', runNo: 1, pilotSummaryPath: pilot('OPUS_5_5_US') });
    assert.ok(notSelected.refusals.some((refusal) => refusal.code === 'CANDIDATE_NOT_SELECTED'), JSON.stringify(notSelected.refusals));
    const nothing = await run.runCampaign({ ...base({ stage: 'qualify', grantPath: grantB, fetchImpl: net.fetchImpl }), outRoot: join(work, 'q-out'), candidate: 'SONNET_5_5_US', runNo: 1, pilotSummaryPath: pilot(null) });
    assert.ok(nothing.refusals.some((refusal) => refusal.code === 'CANDIDATE_NOT_SELECTED'), JSON.stringify(nothing.refusals));
    assert.equal(opus.outDir, null);
    assert.equal(notSelected.outDir, null);
  });
});
