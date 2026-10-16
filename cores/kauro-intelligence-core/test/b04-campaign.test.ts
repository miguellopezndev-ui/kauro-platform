/**
 * B04-CAMPAIGN — the runner, clean consumption and the live suite.
 *
 * The runner (`tools/campaign/run.mjs`) refuses a funded stage without a grant, without the scorer-validity record for the
 * current scorer and corpus, and without the read-back of request-response logging; it packs the core and installs the tarball in
 * a clean directory; the token comes from Application Default Credentials with service-account impersonation (no JSON key).
 * The live suites run only with B04_LIVE=1 and the output directory of a funded stage (B04_LIVE_OUT); otherwise each prints
 * SKIPPED_NEEDS_LIVE with its reason. No test here makes a network call or spends anything: every transport is injected.
 * The rehearsal runs the whole campaign over the 660 sealed fixtures with the recorded SIMULATED transport (B04_REHEARSAL_LIMIT
 * shrinks it for development only).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import type { CorpusFixture } from '../src/benchmark/corpus.js';
import type { FixtureScore } from '../src/benchmark/scorer.js';
import type { RunRecord } from '../src/benchmark/qualification.js';
import type { ProtectedReceipt } from '../src/provider/vertex-receipts.js';
import { requestReceipt, responseReceipt } from '../src/provider/vertex-receipts.js';
import { ACCOUNT, probeFetch } from './support/bedrock-probes.js';

const root = join(import.meta.dirname, '..', '..');
const toolUrl = (name: string): string => pathToFileURL(join(root, 'tools', 'campaign', name)).href;

interface Refusal { readonly code: string; readonly detail: string }
interface Preflight { readonly ok: boolean; readonly refusals: readonly Refusal[]; readonly loggingReadBack: { readonly requestResponseLogging: string } | null }
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

const preflightModule = (await import(toolUrl('preflight.mjs'))) as {
  preflight: (options: Record<string, unknown>) => Promise<Preflight>;
};
const adcModule = (await import(toolUrl('adc.mjs'))) as {
  adcTokenProvider: (options: Record<string, unknown>) => () => Promise<{ token: string; expiresAt: string }>;
};
const auditModule = (await import(toolUrl('live-audit.mjs'))) as {
  LIVE_SUITES: Record<string, unknown>;
  auditLiveSuite: (suite: string, input: { evidence: string; corpusFixtures: readonly CorpusFixture[]; scores: readonly FixtureScore[]; receipts: readonly ProtectedReceipt[] }) => { suite: string; fixtures: number; problems: readonly string[] };
};
const runModule = (await import(toolUrl('run.mjs'))) as {
  runCampaign: (options: Record<string, unknown>) => Promise<{ stage: string; ok: boolean; refusals: readonly Refusal[]; outDir: string | null; summary: Record<string, unknown> | null }>;
};

const NOW = Date.parse('2026-10-10T00:00:00Z');
const work = mkdtempSync(join(tmpdir(), 'b04-campaign-test-'));
after(() => { rmSync(work, { recursive: true, force: true }); });

const corpusDir = join(root, 'corpus');
const scorerDigest = ((await import(toolUrl('validity-run.mjs'))) as { currentScorerDigest: () => string }).currentScorerDigest();
const corpusDigest = (JSON.parse(readFileSync(join(corpusDir, 'MANIFEST.json'), 'utf8')) as { corpusDigest: string }).corpusDigest;
const goodGrant = { grantId: 'grant-A', stages: ['SMOKE', 'PILOT'], capMicros: 55_000_000, expiresAt: '2026-11-01T00:00:00Z', approvalRef: 'owner-2026-10-08', candidates: ['SONNET_5_5_US', 'OPUS_5_5_US'], maxRuns: null };
const writeJson = (name: string, value: unknown): string => { const path = join(work, name); writeFileSync(path, JSON.stringify(value)); return path; };
const validityPath = join(corpusDir, 'scorer-validity.json');

/** A fetch that records every call and answers the logging read-back as given. */
const fakeFetch = (reply: { status: number; body: unknown }): { fetchImpl: Fetch; calls: string[] } => {
  const calls: string[] = [];
  return { calls, fetchImpl: async (url) => { calls.push(url); return { status: reply.status, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) }; } };
};
/** SIMULATED temporary AWS credentials (owner decision A9: Amazon Bedrock); the session token is no secret. */
const credentialProvider = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-CAMPAIGN', expiresAt: '2026-10-10T01:00:00Z' });
const retentionEvidencePath = writeJson('retention.json', { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html', retrievedAt: '2026-10-09T00:00:00Z', sha256: 'a'.repeat(64) });
/** The validity v4 rerun is not what these tests judge (test/b04-scorer-validity.test.ts runs it for real): a stand-in that reports the committed record unchanged, marked INJECTED_TEST_STAND_IN in preflight.json. */
const VALIDITY_RERUN_STAND_IN = ({ record }: { record: unknown }): { stale: boolean; refusals: never[]; binding: null; fresh: unknown } => ({ stale: false, refusals: [], binding: null, fresh: record });
const base = (extra: Record<string, unknown>): Record<string, unknown> => ({ stage: 'smoke', region: 'us-east-1', location: 'us', candidate: 'SONNET_5_5_US', awsAccountId: ACCOUNT, grantPath: writeJson('grant-good.json', goodGrant), validityPath, corpusDir, credentialProvider, retentionEvidencePath, validityRerun: VALIDITY_RERUN_STAND_IN, now: () => NOW, ...extra });

describe('B04-CAMPAIGN: the runner refuses before it spends', () => {
  it('the runner refuses a funded stage without a grant, with an invalid, expired or wrong-stage grant, and never reaches the network', async () => {
    const net = fakeFetch({ status: 200, body: {} });
    const cases: [string, Record<string, unknown>, string][] = [
      ['no grant', { grantPath: null }, 'NO_GRANT'],
      ['missing file', { grantPath: join(work, 'absent.json') }, 'NO_GRANT'],
      ['not a grant', { grantPath: writeJson('grant-bad.json', { grantId: '' }) }, 'GRANT_INVALID'],
      ['expired', { grantPath: writeJson('grant-old.json', { ...goodGrant, expiresAt: '2026-10-09T00:00:00Z' }) }, 'GRANT_EXPIRED'],
      ['wrong stage', { stage: 'qualify', grantPath: writeJson('grant-a2.json', goodGrant) }, 'GRANT_DOES_NOT_FUND_STAGE'],
    ];
    for (const [label, extra, code] of cases) {
      const result = await preflightModule.preflight(base({ ...extra, fetchImpl: net.fetchImpl }));
      assert.equal(result.ok, false, label);
      assert.ok(result.refusals.some((refusal) => refusal.code === code), `${label}: ${JSON.stringify(result.refusals)}`);
    }
    assert.deepEqual(net.calls, [], 'a refused stage never asks the network');
  });

  it('the runner refuses without the scorer-validity record, and with one for another scorer or corpus', async () => {
    const net = fakeFetch({ status: 200, body: {} });
    const missing = await preflightModule.preflight(base({ validityPath: join(work, 'no-record.json'), fetchImpl: net.fetchImpl }));
    assert.ok(missing.refusals.some((refusal) => refusal.code === 'NO_VALIDITY_RECORD'), JSON.stringify(missing.refusals));
    const record = JSON.parse(readFileSync(validityPath, 'utf8')) as Record<string, unknown>;
    assert.equal(record['scorerDigest'], scorerDigest, 'the committed record is for the current scorer');
    const stale = await preflightModule.preflight(base({ validityPath: writeJson('validity-stale.json', { ...record, scorerDigest: 'f'.repeat(64) }), fetchImpl: net.fetchImpl }));
    assert.ok(stale.refusals.some((refusal) => refusal.code === 'VALIDITY_RECORD_REFUSED'), JSON.stringify(stale.refusals));
    const otherCorpus = await preflightModule.preflight(base({ validityPath: writeJson('validity-corpus.json', { ...record, corpusDigest: 'e'.repeat(64) }), fetchImpl: net.fetchImpl }));
    assert.ok(otherCorpus.refusals.some((refusal) => refusal.code === 'VALIDITY_RECORD_REFUSED'), JSON.stringify(otherCorpus.refusals));
    assert.deepEqual(net.calls, [], 'the read-back is asked only once grant and record stand');
    assert.equal(record['corpusDigest'], corpusDigest);
  });

  it('the runner refuses without the read-back of request-response logging: unreadable, malformed or on', async () => {
    // Amazon Bedrock (A9): the read-back is probe P4, GetModelInvocationLoggingConfiguration of the source region.
    const unreadable = probeFetch({ P4: { status: 403, body: { message: 'denied' } } });
    const a = await preflightModule.preflight(base({ fetchImpl: unreadable.fetchImpl }));
    assert.ok(a.refusals.some((refusal) => refusal.code === 'LOGGING_NOT_READ_BACK'), JSON.stringify(a.refusals));
    const malformed = probeFetch({ P4: { status: 200, body: 'not json' } });
    const b = await preflightModule.preflight(base({ fetchImpl: malformed.fetchImpl }));
    assert.ok(b.refusals.some((refusal) => refusal.code === 'LOGGING_NOT_READ_BACK'), JSON.stringify(b.refusals));
    const on = probeFetch({ P4: { status: 200, body: { loggingConfig: { s3Config: { bucketName: 'logs', keyPrefix: 'bedrock' }, textDataDeliveryEnabled: true } } } });
    const c = await preflightModule.preflight(base({ fetchImpl: on.fetchImpl }));
    assert.ok(c.refusals.some((refusal) => refusal.code === 'LOGGING_NOT_OFF'), JSON.stringify(c.refusals));
    const reads = [...unreadable.calls, ...on.calls].filter((call) => call.probe === 'P4');
    assert.equal(reads.length, 2);
    for (const call of reads) {
      assert.equal(call.url, 'https://bedrock.us-east-1.amazonaws.com/logging/modelinvocations', 'the read-back is a GET of the model invocation logging configuration of the source region');
      assert.equal(call.method, 'GET');
    }
  });

  it('the runner goes on when grant, record and a logging-off read-back stand, and keeps the read-back as EXECUTED_PROVIDER evidence', async () => {
    const off = probeFetch();
    const result = await preflightModule.preflight(base({ fetchImpl: off.fetchImpl }));
    assert.deepEqual(result.refusals, []);
    assert.equal(result.ok, true);
    assert.equal(result.loggingReadBack?.requestResponseLogging, 'OFF');
    assert.equal(off.calls.filter((call) => call.probe === 'P4').length, 1, 'one read-back of the logging configuration');
    assert.deepEqual([...new Set(off.calls.map((call) => call.probe))].sort(), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], 'and the other free probes, nothing else');
  });

  it('S091 read-back: only an explicitly recognised OFF configuration is OFF; an empty, unrelated, malformed or unknown logging configuration is UNKNOWN and the funded stage is refused', async () => {
    // Codex B04-R5 on Bedrock: OFF is only the documented 200 with no loggingConfig; a null, empty, flag-only or extended loggingConfig, an unrelated member or a non-record is UNKNOWN.
    const unknown: unknown[] = [{ loggingConfig: null }, { loggingConfig: {} }, { loggingConfig: { textDataDeliveryEnabled: false } }, { loggingConfig: { textDataDeliveryEnabled: false, futureMember: 1 } }, { unrelated: true }, { loggingConfig: 'off' }, [], 0];
    for (const body of unknown) {
      const result = await preflightModule.preflight(base({ fetchImpl: probeFetch({ P4: { status: 200, body } }).fetchImpl }));
      assert.equal(result.ok, false, JSON.stringify(body));
      assert.ok(result.refusals.some((refusal) => refusal.code === 'LOGGING_UNKNOWN'), `${JSON.stringify(body)}: ${JSON.stringify(result.refusals)}`);
      assert.equal(result.loggingReadBack?.requestResponseLogging, 'UNKNOWN', JSON.stringify(body));
    }
    // The control: the recognised OFF shape; and ON for any S3 or CloudWatch delivery, whatever its flags say.
    const off = await preflightModule.preflight(base({ fetchImpl: probeFetch({ P4: { status: 200, body: {} } }).fetchImpl }));
    assert.equal(off.ok, true, JSON.stringify(off.refusals));
    assert.equal(off.loggingReadBack?.requestResponseLogging, 'OFF');
    for (const loggingConfig of [{ s3Config: { bucketName: 'b' } }, { cloudWatchConfig: { logGroupName: 'g', roleArn: 'r' }, textDataDeliveryEnabled: false }]) {
      const on = await preflightModule.preflight(base({ fetchImpl: probeFetch({ P4: { status: 200, body: { loggingConfig } } }).fetchImpl }));
      assert.ok(on.refusals.some((refusal) => refusal.code === 'LOGGING_NOT_OFF'), JSON.stringify(loggingConfig));
    }
    // And the candidate is never admitted on an UNKNOWN record.
    const { admitCandidate, SONNET_5_5_US } = await import('../src/gateway/candidates.js');
    const record = SONNET_5_5_US.eligibility;
    assert.ok(record !== null);
    assert.equal(admitCandidate({ ...SONNET_5_5_US, eligibility: { ...record, requestResponseLogging: 'UNKNOWN' as 'OFF' } }).admitted, false);
  });

  it('the command line refuses a funded stage without a grant before anything is installed or called', () => {
    const run = spawnSync(process.execPath, [join(root, 'tools', 'campaign', 'run.mjs'), '--stage', 'qualify', '--project', 'kauro-nonprod', '--location', 'us', '--candidate', 'SONNET_5_5_US', '--run', '1', '--out', join(work, 'cli-out')], { encoding: 'utf8', cwd: root, timeout: 120_000 });
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}${run.stderr}`, /REFUSED[^\n]*NO_GRANT/u);
    assert.equal(existsSync(join(work, 'cli-out')), false, 'nothing is written for a refused stage');
  });

  it('the runner API refuses a funded stage in the same way and names the refusals', async () => {
    const result = await runModule.runCampaign({ stage: 'pilot', project: 'kauro-nonprod', location: 'us', grantPath: null, validityPath, corpusDir, outRoot: join(work, 'api-out'), candidate: 'SONNET_5_5_US' });
    assert.equal(result.ok, false);
    assert.ok(result.refusals.some((refusal) => refusal.code === 'NO_GRANT'));
    assert.equal(result.outDir, null);
  });
});

describe('B04-CAMPAIGN: the token comes from ADC with impersonation, never a JSON key', () => {
  const SA = 'ic-qualification@kauro-nonprod.iam.gserviceaccount.com';
  const user = { type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' };
  const exchange = (): { fetchImpl: Fetch; calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] } => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.startsWith('https://oauth2.googleapis.com/token')) return { status: 200, text: async () => JSON.stringify({ access_token: 'user-access', expires_in: 3599 }) };
        if (url.includes('iamcredentials.googleapis.com') && url.endsWith(`serviceAccounts/${SA}:generateAccessToken`)) return { status: 200, text: async () => JSON.stringify({ accessToken: 'sa-access', expireTime: '2026-10-10T01:00:00Z' }) };
        return { status: 404, text: async () => '{}' };
      },
    };
  };

  it('an authorized-user ADC file and a service account to impersonate yield the service account token through two exchanges, cached until near expiry', async () => {
    const net = exchange();
    const provider = adcModule.adcTokenProvider({ serviceAccount: SA, env: { GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' }, readText: () => JSON.stringify(user), fetchImpl: net.fetchImpl, now: () => NOW });
    const first = await provider();
    assert.deepEqual(first, { token: 'sa-access', expiresAt: '2026-10-10T01:00:00Z' });
    assert.equal(net.calls.length, 2);
    assert.equal(net.calls[1]?.init.headers['authorization'], 'Bearer user-access', 'the impersonation call carries the user access token');
    await provider();
    assert.equal(net.calls.length, 2, 'a token far from expiry is reused');
  });

  it('the file written by gcloud --impersonate-service-account (impersonated_service_account) is accepted the same way', async () => {
    const net = exchange();
    const file = { type: 'impersonated_service_account', service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`, source_credentials: user };
    const provider = adcModule.adcTokenProvider({ env: { GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' }, readText: () => JSON.stringify(file), fetchImpl: net.fetchImpl, now: () => NOW });
    assert.equal((await provider()).token, 'sa-access');
  });

  it('a service-account JSON key, user credentials with nothing to impersonate and an unreadable file are refused, and no error text carries a secret', async () => {
    const net = exchange();
    const key = { type: 'service_account', private_key: '-----BEGIN PRIVATE KEY-----SECRETKEYMATERIAL', client_email: SA };
    const refusals: unknown[] = [];
    for (const [file, serviceAccount] of [[key, SA], [user, undefined], ['{ not json', SA]] as const) {
      const provider = adcModule.adcTokenProvider({ ...(serviceAccount === undefined ? {} : { serviceAccount }), env: { GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' }, readText: () => (typeof file === 'string' ? file : JSON.stringify(file)), fetchImpl: net.fetchImpl, now: () => NOW });
      await assert.rejects(provider(), (error: Error) => { refusals.push(error.message); return !/SECRETKEYMATERIAL|csecret|rtoken|user-access/u.test(error.message); });
    }
    assert.match(String(refusals[0]), /JSON key/u);
    assert.match(String(refusals[1]), /impersonat/u);
    assert.deepEqual(net.calls, [], 'a refused file reaches no endpoint');
  });

  it('a failed exchange is an error that names the step and the status, not the response body', async () => {
    const fetchImpl: Fetch = async () => ({ status: 401, text: async () => JSON.stringify({ error: 'invalid_grant', hint: 'LEAKY-BODY-TEXT' }) });
    const provider = adcModule.adcTokenProvider({ serviceAccount: SA, env: { GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' }, readText: () => JSON.stringify(user), fetchImpl, now: () => NOW });
    await assert.rejects(provider(), (error: Error) => /refresh/u.test(error.message) && /401/u.test(error.message) && !/LEAKY-BODY-TEXT/u.test(error.message));
  });
});

describe('B04-CAMPAIGN: the live audit reads the recorded Vertex bytes, headers and receipts', () => {
  const sentinelFixture = (id: string, tags: string[], canary: string): CorpusFixture => ({
    partition: 'FINAL', fileName: `${id}.json`, canaries: [canary],
    fixture: { fixtureId: id, family: 'ADVERSARIAL', gates: { identityUnproven: false, injectionSentinels: [], foreignRefs: [], secretSentinels: [`SENTINEL-${id}`], safetyCritical: false } },
    structure: { tags },
  } as unknown as CorpusFixture);
  const score = (fixtureId: string, runId: string, over: Partial<FixtureScore> = {}): FixtureScore => ({ fixtureId, family: 'ADVERSARIAL', weight: 1, expectedTruthDigest: 'x', runId, correct: true, candidateFailure: false, checks: [], hardGateViolations: [], gateChecksExecuted: { secret_or_forbidden_data_egress: 3 }, scorerFailure: null, ...over } as unknown as FixtureScore);
  const receipts = (runId: string, requestText: string): ProtectedReceipt[] => [
    requestReceipt({ url: 'https://aiplatform.us.rep.googleapis.com/x', headers: { 'content-type': 'application/json', authorization: 'Bearer [redacted]' }, bodyBytes: requestText, idempotencyRef: `${runId}:1`, runId }),
    responseReceipt({ status: 200, headers: {}, bodyText: JSON.stringify({ id: `msg_${runId}`, model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), bodyLength: 90, truncated: false, latencyMs: 5, idempotencyRef: `${runId}:1`, runId }),
  ];
  const set = [sentinelFixture('fx-a', ['channel:target-option'], 'kc_aaaa'), sentinelFixture('fx-b', ['channel:value', 'egress:request-bytes'], 'kc_bbbb'), sentinelFixture('fx-c', ['safety:api-secret'], 'kc_cccc')];

  it('names the three suites and selects fixtures by what they plant', () => {
    assert.deepEqual(Object.keys(auditModule.LIVE_SUITES).sort(), ['IC-05', 'R2-027', 'S036']);
    const every = { corpusFixtures: set, scores: ['fx-a', 'fx-b', 'fx-c'].map((id) => score(id, `run-${id}`)), receipts: ['fx-a', 'fx-b', 'fx-c'].flatMap((id) => receipts(`run-${id}`, '{"clean":true}')) };
    for (const [suite, expected] of [['IC-05', 1], ['S036', 2], ['R2-027', 1]] as const) {
      const found = auditModule.auditLiveSuite(suite, { evidence: 'EXECUTED_PROVIDER', ...every });
      assert.deepEqual(found.problems, [], `${suite}: ${found.problems.join('; ')}`);
      assert.equal(found.fixtures, expected, suite);
    }
  });

  it('finds a sentinel or a canary in the request bytes, in the JSON-escaped wire form, or in a header; a gate violation; a missing run; a suite with nothing to audit', () => {
    const run = 'run-fx-a';
    const leak = (text: string, extra: Partial<FixtureScore> = {}): readonly string[] => auditModule.auditLiveSuite('IC-05', { evidence: 'EXECUTED_PROVIDER', corpusFixtures: set, scores: [score('fx-a', run, extra)], receipts: receipts(run, text) }).problems;
    assert.ok(leak('prefix SENTINEL-fx-a suffix').some((p) => /SENTINEL-fx-a/u.test(p) || /sentinel/iu.test(p)));
    assert.ok(leak('{"x":"kc_aaaa"}').length > 0, 'a canary');
    assert.ok(leak('{"x":"\\"SENTINEL-fx-a\\""}').length > 0, 'an escaped form still contains the sentinel');
    const withHeader = [requestReceipt({ url: 'u', headers: { 'x-trace': 'kc_aaaa' }, bodyBytes: '{}', idempotencyRef: null, runId: run })];
    assert.ok(auditModule.auditLiveSuite('IC-05', { evidence: 'EXECUTED_PROVIDER', corpusFixtures: set, scores: [score('fx-a', run)], receipts: withHeader }).problems.length > 0, 'a header');
    assert.ok(leak('{}', { hardGateViolations: ['secret_or_forbidden_data_egress'] }).length > 0, 'a gate violation');
    assert.ok(leak('{}', { gateChecksExecuted: { secret_or_forbidden_data_egress: 0 } as unknown as FixtureScore['gateChecksExecuted'] }).length > 0, 'a gate nobody checked');
    assert.ok(auditModule.auditLiveSuite('IC-05', { evidence: 'EXECUTED_PROVIDER', corpusFixtures: set, scores: [], receipts: receipts(run, '{}') }).problems.length > 0, 'a fixture with no score');
    assert.ok(auditModule.auditLiveSuite('S036', { evidence: 'EXECUTED_PROVIDER', corpusFixtures: [set[0] as CorpusFixture], scores: [], receipts: [] }).problems.length > 0, 'nothing selected');
  });

  it('S036 asks that the run still drafts: a candidate failure is a problem, an abstention is not', () => {
    const run = 'run-fx-b';
    const failed = auditModule.auditLiveSuite('S036', { evidence: 'EXECUTED_PROVIDER', corpusFixtures: set, scores: [score('fx-b', run, { candidateFailure: true, correct: false })], receipts: receipts(run, '{}') });
    assert.ok(failed.problems.some((p) => /draft|candidate/iu.test(p)), failed.problems.join('; '));
  });
});

describe('B04-CAMPAIGN: the funded path over a stand-in Bedrock endpoint (no network, no spend; the stand-in answers every candidate with an abstention)', () => {
  const STUB = `
export default function seam({ alwaysAbstainAnswer, parseProviderRequestPayload }) {
  let n = 0;
  const calls = [];
  const fetch = async (url, init) => {
    const chunks = [];
    for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const { anthropic_version, ...rest } = JSON.parse(text);
    const payload = parseProviderRequestPayload(JSON.stringify({ model: 'claude-sonnet-5-5', ...rest }));
    n += 1;
    const answer = JSON.stringify(alwaysAbstainAnswer(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash }));
    const usage = { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(answer.length / 4) };
    const body = Buffer.from(JSON.stringify({ id: 'msg_bdrk_stub_' + String(n), type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: answer }], usage }));
    calls.push(url);
    const headers = { 'content-type': 'application/json', 'x-amzn-requestid': 'stub-request-' + String(n), 'x-amzn-bedrock-input-token-count': String(usage.input_tokens), 'x-amzn-bedrock-output-token-count': String(usage.output_tokens) };
    return { status: 200, headers: { get: (name) => headers[name.toLowerCase()] ?? null, forEach: (callback) => { for (const [key, value] of Object.entries(headers)) callback(value, key); } }, body: (async function* () { yield body; })() };
  };
  // A stand-in Bedrock endpoint (A9) with SIMULATED temporary credentials: the session token is no secret.
  return { fetch, credentialProvider: async () => ({ accessKeyId: 'ASIASTUBEXAMPLEKEY01', secretAccessKey: 'stub-secret-not-real', sessionToken: 'stub-session-not-real', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), calls };
}
`;

  it('a smoke over the stand-in stops at its request cap, records receipts without the token, charges inside the grant, scans every request before it leaves, and is labelled SIMULATED, which the live audits refuse as live evidence while finding no leak', { timeout: 600_000 }, async () => {
    const stubPath = join(work, 'stub-seam.mjs');
    writeFileSync(stubPath, STUB);
    const off = probeFetch();
    const result = await runModule.runCampaign({ ...base({ fetchImpl: off.fetchImpl, grantPath: writeJson('grant-smoke.json', goodGrant) }), latchPath: join(work, 'smoke-latch.json'), outRoot: join(work, 'smoke-out'), candidate: 'SONNET_5_5_US', seamModule: stubPath });
    assert.deepEqual(result.refusals, []);
    assert.ok(result.outDir !== null && result.summary !== null);
    const summary = result.summary as { evidence: string; complete: boolean; stopped: string | null; fixtures: number; contamination: { scannedRequests: number; hits: number }; measured: { requests: number; chargedMicros: number; heldMicros: number; liabilityMicros: number; servedModels: string[] } };
    // Codex B04-R8: a stand-in endpoint is no provider; its output is SIMULATED and never live evidence.
    assert.equal(summary.evidence, 'SIMULATED');
    assert.deepEqual(summary.contamination, { scannedRequests: summary.measured.requests, hits: 0 }, 'every physical request was scanned before it was sent');
    assert.equal(summary.complete, true, JSON.stringify(summary));
    assert.equal(summary.stopped, null);
    assert.ok(summary.fixtures >= 5, 'the smoke ran the privacy-planting fixtures');
    assert.ok(summary.measured.requests > 0 && summary.measured.requests <= 46, `requests ${String(summary.measured.requests)}`);
    assert.ok(summary.measured.chargedMicros > 0 && summary.measured.chargedMicros < goodGrant.capMicros);
    assert.equal(summary.measured.liabilityMicros, 0);
    assert.deepEqual(summary.measured.servedModels, ['claude-sonnet-5-5']);
    const receiptsText = readFileSync(join(result.outDir, 'receipts.jsonl'), 'utf8');
    for (const secret of ['stub-session-not-real', 'stub-secret-not-real']) assert.ok(!receiptsText.includes(secret), 'no credential is in any receipt');
    const receipts = receiptsText.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as ProtectedReceipt);
    const scores = JSON.parse(readFileSync(join(result.outDir, 'scores.json'), 'utf8')) as FixtureScore[];
    const selection = JSON.parse(readFileSync(join(result.outDir, 'selection.json'), 'utf8')) as CorpusFixture[];
    assert.equal(scores.length, summary.fixtures);
    const run = JSON.parse(readFileSync(join(result.outDir, 'run.json'), 'utf8')) as { evidence: string; loggingReadBack: { requestResponseLogging: string } };
    assert.equal(run.evidence, 'SIMULATED');
    for (const id of ['IC-05', 'S036', 'R2-027']) {
      const audit = auditModule.auditLiveSuite(id, { evidence: run.evidence, corpusFixtures: selection, scores, receipts });
      assert.ok(audit.problems.some((problem) => /not EXECUTED_PROVIDER/u.test(problem)), `${id}: a SIMULATED run is refused as live evidence`);
      assert.deepEqual(audit.problems.filter((problem) => !/no fixture of the run plants|not EXECUTED_PROVIDER/u.test(problem)), [], id);
      const asLive = auditModule.auditLiveSuite(id, { evidence: 'EXECUTED_PROVIDER', corpusFixtures: selection, scores, receipts });
      assert.ok(!asLive.problems.some((problem) => /not EXECUTED_PROVIDER/u.test(problem)), `${id}: the control: only the label is refused`);
    }
    for (const evidence of ['REPLAY', '', 'executed_provider']) assert.ok(auditModule.auditLiveSuite('S036', { evidence, corpusFixtures: selection, scores, receipts }).problems.some((problem) => /not EXECUTED_PROVIDER/u.test(problem)), `${evidence}: only EXECUTED_PROVIDER is live evidence`);
    assert.equal(run.loggingReadBack.requestResponseLogging, 'OFF');
  });

  it('IC-11 runner: a stage spends the durable ledger beside its grant file, starting from what earlier invocations charged and held; a held ledger lock, a stopped grant or a ledger of another grant refuses the stage before anything is installed', { timeout: 600_000 }, async () => {
    const stubPath = join(work, 'stub-seam-ledger.mjs');
    writeFileSync(stubPath, STUB);
    const ledgerLib = (await import(toolUrl('grant-ledger.mjs'))) as { ledgerPathOf: (path: string) => string; grantDigestOf: (grant: unknown) => string };
    const grant = { ...goodGrant, grantId: 'grant-ledger' };
    const grantPath = writeJson('grant-ledger.json', grant);
    const ledger = ledgerLib.ledgerPathOf(grantPath);
    // An earlier invocation committed 1,000,000 micros and left a 2,000,000 hold in flight when it ended.
    const earlier = [
      { kind: 'GRANT', grantId: grant.grantId, grantDigest: ledgerLib.grantDigestOf(grant) },
      { kind: 'HOLD', runId: 'earlier', reservationId: 'a', maxChargeMicros: 1_500_000 },
      { kind: 'SETTLE', runId: 'earlier', reservationId: 'a', state: 'COMMITTED', chargeMicros: 1_000_000 },
      { kind: 'HOLD', runId: 'earlier', reservationId: 'b', maxChargeMicros: 2_000_000 },
    ];
    writeFileSync(ledger, earlier.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const off = probeFetch();
    const options = { ...base({ fetchImpl: off.fetchImpl, grantPath }), latchPath: join(work, 'ledger-latch.json'), outRoot: join(work, 'ledger-out'), candidate: 'SONNET_5_5_US', seamModule: stubPath };
    const result = await runModule.runCampaign(options);
    assert.deepEqual(result.refusals, []);
    const summary = result.summary as { complete: boolean; measured: { chargedMicros: number }; grantChargedMicros: number; grantHeldMicros: number };
    assert.equal(summary.complete, true, JSON.stringify(summary));
    assert.ok(summary.measured.chargedMicros > 0);
    assert.equal(summary.grantChargedMicros, 1_000_000 + summary.measured.chargedMicros, 'the grant carries the earlier charge and this one');
    assert.equal(summary.grantHeldMicros, 2_000_000, 'the hold the earlier invocation left in flight is still spent');
    const lines = readFileSync(ledger, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { kind: string });
    assert.ok(lines.length > earlier.length && lines.slice(earlier.length).some((line) => line.kind === 'SETTLE'), 'this invocation appended its own holds and settlements');
    assert.equal(existsSync(`${ledger}.lock`), false, 'the lock is released when the stage ends');

    writeFileSync(`${ledger}.lock`, '{}');
    const locked = await runModule.runCampaign({ ...options, outRoot: join(work, 'ledger-locked-out') });
    assert.ok(locked.refusals.some((refusal) => refusal.code === 'GRANT_LEDGER_LOCKED'), JSON.stringify(locked.refusals));
    assert.equal(locked.outDir, null);
    rmSync(`${ledger}.lock`);
    writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}${JSON.stringify({ kind: 'STOP', reason: 'CANARY_HIT' })}\n`);
    const stopped = await runModule.runCampaign({ ...options, outRoot: join(work, 'ledger-stopped-out') });
    assert.ok(stopped.refusals.some((refusal) => refusal.code === 'GRANT_STOPPED'), JSON.stringify(stopped.refusals));
    const raised = await runModule.runCampaign({ ...options, grantPath: writeJson('grant-ledger.json', { ...grant, capMicros: grant.capMicros * 2 }), outRoot: join(work, 'ledger-raised-out') });
    assert.ok(raised.refusals.some((refusal) => refusal.code === 'GRANT_LEDGER_MISMATCH'), JSON.stringify(raised.refusals));
  });

  it('a qualification run of a candidate the pinned policy does not name is refused, and one without the pilot measurement is refused', async () => {
    const off = probeFetch();
    const grantQ = writeJson('grant-Q.json', { ...goodGrant, grantId: 'grant-Q', stages: ['QUALIFICATION'], capMicros: 285_000_000 });
    const opus = await runModule.runCampaign({ ...base({ fetchImpl: off.fetchImpl, stage: 'qualify', grantPath: grantQ }), outRoot: join(work, 'refused-out'), candidate: 'OPUS_5_5_US', runNo: 1 });
    assert.ok(opus.refusals.some((refusal) => refusal.code === 'CANDIDATE_NOT_THE_PINNED_POLICY'), JSON.stringify(opus.refusals));
    const grantB = writeJson('grant-B.json', { ...goodGrant, grantId: 'grant-B', stages: ['QUALIFICATION'], capMicros: 285_000_000 });
    const noPilot = await runModule.runCampaign({ ...base({ fetchImpl: off.fetchImpl, stage: 'qualify', grantPath: grantB }), outRoot: join(work, 'refused-out'), candidate: 'SONNET_5_5_US', runNo: 1 });
    assert.ok(noPilot.refusals.some((refusal) => refusal.code === 'NO_PILOT_MEASUREMENT'), JSON.stringify(noPilot.refusals));
    assert.equal(noPilot.outDir, null);
  });
});

describe('B04-CAMPAIGN: the funded path runs the sealed partitions and guards the corpus on every physical request (SIMULATED, no network)', () => {
  const manifest = JSON.parse(readFileSync(join(corpusDir, 'MANIFEST.json'), 'utf8')) as { corpusDigest: string; fixtures: { fixtureId: string; fileName: string; partition: string; canaries: string[] }[] };

  it('S042 partitions: the pilot runs exactly the 60 sealed PILOT fixtures and qualification exactly the 600 FINAL fixtures; neither runs a fixture of the other partition', async () => {
    const selection = (await import(toolUrl('selection.mjs'))) as { selectionOf: (fixtures: readonly CorpusFixture[], stage: string, limit: number | null) => CorpusFixture[] };
    const { loadCorpus } = (await import(toolUrl('validity-run.mjs'))) as { loadCorpus: (dir: string) => { fixtures: CorpusFixture[] } };
    const fixtures = loadCorpus(corpusDir).fixtures;
    const ids = (entries: readonly CorpusFixture[]): string[] => entries.map((entry) => entry.fixture.fixtureId).sort();
    const sealed = (partition: string): string[] => manifest.fixtures.filter((entry) => entry.partition === partition).map((entry) => entry.fixtureId).sort();
    // Codex B04-R7: every eleventh fixture of all 660 gave a pilot of 54 FINAL and 6 PILOT fixtures, and qualification ran all 660.
    const pilot = selection.selectionOf(fixtures, 'pilot', null);
    assert.deepEqual(ids(pilot), sealed('PILOT'));
    assert.equal(pilot.length, 60);
    const qualify = selection.selectionOf(fixtures, 'qualify', null);
    assert.deepEqual(ids(qualify), sealed('FINAL'));
    assert.equal(qualify.length, 600);
    assert.ok(selection.selectionOf(fixtures, 'pilot', 4).every((entry) => entry.partition === 'PILOT'), 'a development limit stays inside the partition');
    const limited = selection.selectionOf(fixtures, 'qualify', 10);
    assert.equal(limited.length, 10);
    assert.ok(limited.every((entry) => entry.partition === 'FINAL'));
    assert.throws(() => selection.selectionOf(fixtures.filter((entry) => entry.fixture.fixtureId !== pilot[0]?.fixture.fixtureId), 'pilot', null), /60/u, 'a partition short of its sealed size is refused, never topped up');
  });

  it('R2-040 funded path: each physical request is scanned before it is sent for every canary and file name of the manifest; a hit sends nothing, stops the campaign, refuses every later request and latches the corpus, and the latch refuses a new invocation until the corpus is resealed', async () => {
    const contamination = (await import(toolUrl('contamination.mjs'))) as {
      fundedContaminationGuard: (options: { manifest: unknown; latchPath: string; onHit: (reason: string) => void }) => { beforeSend: (fixtureId: string, bytes: string) => void; readonly scanned: number; readonly hits: number };
      latchedCorpus: (latchPath: string, corpusDigest: string) => { code: string; detail: string } | null;
    };
    const { bedrockTransport } = await import('../src/provider/bedrock-transport.js');
    const { SONNET_5_5_US } = await import('../src/gateway/candidates.js');
    const { TransportError } = await import('../src/gateway/transport-gateway.js');
    const current = manifest.fixtures[0];
    const other = manifest.fixtures[5];
    const named = manifest.fixtures[9];
    assert.ok(current !== undefined && other !== undefined && named !== undefined);
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    const request = (content: string): Parameters<ReturnType<typeof bedrockTransport>>[0] => ({ model: SONNET_5_5_US.modelId, max_tokens: 8192, system: 'system', messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'high' }, tools: [] });
    const cases: [string, string][] = [['a canary of another fixture of the manifest', other.canaries[0] ?? ''], ['a corpus file name', named.fileName], ['a canary of the fixture itself', current.canaries[0] ?? '']];
    for (const [label, token] of cases) {
      const latchPath = join(work, `latch-${String(cases.findIndex(([one]) => one === label))}.json`);
      const stops: string[] = [];
      const guard = contamination.fundedContaminationGuard({ manifest, latchPath, onHit: (reason) => { stops.push(reason); } });
      let fetched = 0;
      const receipts: ProtectedReceipt[] = [];
      const transport = bedrockTransport({
        region: 'us-east-1', profile: SONNET_5_5_US, now: () => now, sink: (receipt) => { receipts.push(receipt); },
        credentialProvider: async () => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0009', expiresAt: '2026-10-01T13:00:00.000Z' }),
        fetchImpl: async () => { fetched += 1; return { status: 200, headers: { get: () => null, forEach: () => undefined }, body: null }; },
        beforeSend: (bytes) => { guard.beforeSend(current.fixtureId, bytes); },
      });
      const send = (content: string, n: number): Promise<unknown> => transport(request(content), '2026-10-01T12:05:00.000Z', { idempotencyRef: `idem-${String(n)}`, runId: 'run-guard' });
      await send('<request>\n{}\n</request>', 1);
      assert.equal(fetched, 1, `${label}: the clean first request of the fixture goes out`);
      await assert.rejects(send(`<request>\n{"note":"${token}"}\n</request>`, 2), (error: unknown) => error instanceof TransportError && error.stage === 'BEFORE_SEND', label);
      assert.equal(fetched, 1, `${label}: the contaminated request was never written`);
      assert.equal(receipts.filter((receipt) => receipt.kind === 'REQUEST').length, 1, `${label}: no request receipt for bytes that never left`);
      await assert.rejects(send('<request>\n{}\n</request>', 3), (error: unknown) => error instanceof TransportError && error.stage === 'BEFORE_SEND', `${label}: a clean request after the hit is refused too`);
      assert.equal(fetched, 1);
      assert.deepEqual(stops, ['CANARY_HIT'], `${label}: the campaign is stopped`);
      assert.deepEqual([guard.scanned, guard.hits], [2, 1]);
      assert.ok(existsSync(latchPath), `${label}: the latch is on disk`);
      assert.ok(!readFileSync(latchPath, 'utf8').includes(token), 'the latch names fixtures and digests, never the token');
      assert.equal(contamination.latchedCorpus(latchPath, manifest.corpusDigest)?.code, 'CORPUS_CONTAMINATED', `${label}: a new invocation over the same corpus is refused`);
      assert.equal(contamination.latchedCorpus(latchPath, 'f'.repeat(64)), null, `${label}: a resealed corpus (another digest) lifts the latch`);
      const restarted = contamination.fundedContaminationGuard({ manifest, latchPath, onHit: () => undefined });
      assert.throws(() => { restarted.beforeSend(current.fixtureId, '{}'); }, /contamina|reseal/iu, `${label}: a guard opened over the latch refuses even a clean request`);
    }
    // The preflight reads the latch before the network: a contaminated corpus is not funded again.
    const net = probeFetch();
    const refused = await preflightModule.preflight(base({ fetchImpl: net.fetchImpl, latchPath: join(work, 'latch-0.json') }));
    assert.ok(refused.refusals.some((refusal) => refusal.code === 'CORPUS_CONTAMINATED'), JSON.stringify(refused.refusals));
    assert.deepEqual(net.calls, []);
    assert.equal((await preflightModule.preflight(base({ fetchImpl: net.fetchImpl, latchPath: join(work, 'no-latch.json') }))).ok, true, 'the control: no latch, the stage goes on');
  });
});

describe('B04-CAMPAIGN: the stop survives a crash and the pilot measures Sonnet first (S12, D4-CAMP-11; SIMULATED stand-in, no network)', () => {
  /** A stand-in Bedrock endpoint that answers with an abstention, records the model of each call beside the stage output, and can die (exit 137, as a kill -9) at a given call or report a hard gate for a candidate. */
  const seamSource = (options: { readonly dieAtCall?: number; readonly gateFor?: string }): string => `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export default function seam({ alwaysAbstainAnswer, parseProviderRequestPayload, outDir }) {
  let n = 0;
  const fetch = async (url, init) => {
    const chunks = [];
    for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    n += 1;
    if (n === ${String(options.dieAtCall ?? -1)}) process.exit(137);
    const model = /claude-opus-5-5/u.test(decodeURIComponent(url)) ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
    appendFileSync(join(outDir, 'seam-calls.txt'), model + '\\n');
    const { anthropic_version, ...rest } = JSON.parse(text);
    const payload = parseProviderRequestPayload(JSON.stringify({ model, ...rest }));
    const answer = JSON.stringify(alwaysAbstainAnswer(payload.envelope, { runId: payload.runId, taskId: payload.taskId, envelopeHash: payload.envelopeHash }));
    const usage = { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(answer.length / 4) };
    const body = Buffer.from(JSON.stringify({ id: 'msg_bdrk_seam_' + String(n), type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: answer }], usage }));
    const headers = { 'content-type': 'application/json', 'x-amzn-requestid': 'seam-' + String(n), 'x-amzn-bedrock-input-token-count': String(usage.input_tokens), 'x-amzn-bedrock-output-token-count': String(usage.output_tokens) };
    return { status: 200, headers: { get: (name) => headers[name.toLowerCase()] ?? null, forEach: (callback) => { for (const [key, value] of Object.entries(headers)) callback(value, key); } }, body: (async function* () { yield body; })() };
  };
  // The stand-in's own judgement of a candidate (test seam only, never on the provider path): a hard gate on its first scored fixture.
  let gated = false;
  const scoreOverride = (score, { candidate }) => (${JSON.stringify(options.gateFor ?? null)} === candidate && !gated ? (gated = true, { ...score, hardGateViolations: ['secret_or_forbidden_data_egress'] }) : score);
  return { fetch, scoreOverride, credentialProvider: async () => ({ accessKeyId: 'ASIASTUBEXAMPLEKEY01', secretAccessKey: 'stub-secret-not-real', sessionToken: 'stub-session-not-real', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) };
}
`;
  type Line = { kind: string; [member: string]: unknown };
  const ledgerLines = (path: string): Line[] => readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Line);

  it('RACE (crash before STOP): a violation in scores.jsonl stops the restart before any hold', { timeout: 900_000 }, async () => {
    const ledgerLib = (await import(toolUrl('grant-ledger.mjs'))) as { ledgerPathOf: (path: string) => string };
    const grantPath = writeJson('grant-g50.json', { ...goodGrant, grantId: 'grant-g50' });
    const ledger = ledgerLib.ledgerPathOf(grantPath);
    const outRoot = join(work, 'g50-out');
    const dying = join(work, 'seam-g50-die.mjs');
    writeFileSync(dying, seamSource({ dieAtCall: 9 }));
    // (1) The stage is killed at its ninth request: every fixture scored before the kill is already on disk, one fsync'd line each.
    const crashed = await runModule.runCampaign({ ...base({ fetchImpl: probeFetch().fetchImpl, grantPath }), latchPath: join(work, 'g50-latch.json'), outRoot, candidate: 'SONNET_5_5_US', seamModule: dying });
    assert.equal(crashed.ok, false);
    assert.ok(crashed.outDir !== null);
    const journal = join(crashed.outDir, 'scores.jsonl');
    const scored = readFileSync(journal, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { grantId: string; candidate: string; fixtureId: string; hardGateViolations: string[] });
    assert.ok(scored.length >= 1, 'the fixtures finished before the kill are in scores.jsonl');
    assert.ok(scored.every((line) => line.grantId === 'grant-g50' && line.candidate === 'SONNET_5_5_US' && typeof line.fixtureId === 'string' && Array.isArray(line.hardGateViolations)));
    assert.equal(ledgerLines(ledger).filter((line) => line.kind === 'STOP').length, 0, 'no stop was recorded');
    // (2) The kill fell between the fsync of a violating score and its STOP: the line is on disk, the ledger has no STOP.
    const last = scored[scored.length - 1];
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}${JSON.stringify({ ...last, fixtureId: 'fx-violating', hardGateViolations: ['secret_or_forbidden_data_egress'] })}\n`);
    assert.equal(existsSync(`${ledger}.lock`), true, 'the killed stage left its lock: the restart recovers it by proof of death (S10), nobody deletes it');
    const before = ledgerLines(ledger).length;
    const plain = join(work, 'seam-g50.mjs');
    writeFileSync(plain, seamSource({}));
    const restarted = await runModule.runCampaign({ ...base({ fetchImpl: probeFetch().fetchImpl, grantPath }), latchPath: join(work, 'g50-latch.json'), outRoot, candidate: 'SONNET_5_5_US', seamModule: plain });
    assert.equal(restarted.ok, false);
    assert.ok(restarted.refusals.some((refusal) => refusal.code === 'GRANT_STOPPED' && /scores\.jsonl/u.test(refusal.detail)), JSON.stringify(restarted.refusals));
    const after = ledgerLines(ledger).slice(before);
    assert.deepEqual(after.map((line) => line.kind), ['LOCK_RECOVERED', 'STOP'], 'the dead lock is recovered, the pending STOP is rebuilt and nothing is held');
    assert.equal(after[0]?.['provedBy'], 'PID_GONE');
    assert.equal(after[1]?.['reason'], 'HARD_GATE_VIOLATION');
    assert.equal(existsSync(join(restarted.outDir ?? '', 'seam-calls.txt')), false, 'no request was sent');
    // The control: a third invocation is refused by the preflight, from the ledger, before anything is installed.
    const third = await runModule.runCampaign({ ...base({ fetchImpl: probeFetch().fetchImpl, grantPath }), latchPath: join(work, 'g50-latch.json'), outRoot, candidate: 'SONNET_5_5_US', seamModule: plain });
    assert.ok(third.refusals.some((refusal) => refusal.code === 'GRANT_STOPPED'), JSON.stringify(third.refusals));
    assert.equal(third.outDir, null);
  });

  it('D4-CHAOS-1 (G50): a scores.jsonl line whose only violation is outside HARD_GATES rebuilds no STOP on restart', { timeout: 900_000 }, async () => {
    const ledgerLib = (await import(toolUrl('grant-ledger.mjs'))) as { ledgerPathOf: (path: string) => string };
    const grantPath = writeJson('grant-g50-other.json', { ...goodGrant, grantId: 'grant-g50-other' });
    const ledger = ledgerLib.ledgerPathOf(grantPath);
    const outRoot = join(work, 'g50-other-out');
    const dying = join(work, 'seam-g50-other-die.mjs');
    writeFileSync(dying, seamSource({ dieAtCall: 9 }));
    const crashed = await runModule.runCampaign({ ...base({ fetchImpl: probeFetch().fetchImpl, grantPath }), latchPath: join(work, 'g50-other-latch.json'), outRoot, candidate: 'SONNET_5_5_US', seamModule: dying });
    assert.equal(crashed.ok, false);
    assert.ok(crashed.outDir !== null);
    const journal = join(crashed.outDir, 'scores.jsonl');
    const scored = readFileSync(journal, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(scored.length >= 1);
    const last = scored[scored.length - 1];
    writeFileSync(journal, `${readFileSync(journal, 'utf8')}${JSON.stringify({ ...last, fixtureId: 'fx-over-ceiling', hardGateViolations: ['budget_ceiling_exceeded'] })}\n`);
    const before = ledgerLines(ledger).length;
    const plain = join(work, 'seam-g50-other.mjs');
    writeFileSync(plain, seamSource({}));
    const restarted = await runModule.runCampaign({ ...base({ fetchImpl: probeFetch().fetchImpl, grantPath }), latchPath: join(work, 'g50-other-latch.json'), outRoot, candidate: 'SONNET_5_5_US', seamModule: plain });
    assert.ok(!restarted.refusals.some((refusal) => refusal.code === 'GRANT_STOPPED'), JSON.stringify(restarted.refusals));
    const after = ledgerLines(ledger).slice(before);
    assert.equal(after[0]?.kind, 'LOCK_RECOVERED');
    assert.deepEqual(after.filter((line) => line.kind === 'STOP'), [], 'a violation outside HARD_GATES is no pending STOP');
  });

  it('OK: pilot measures Sonnet before Opus; an Opus hard gate stops the stage and keeps Sonnet\'s measured pass', { timeout: 900_000 }, async () => {
    const seamPath = join(work, 'seam-g51.mjs');
    writeFileSync(seamPath, seamSource({ gateFor: 'OPUS_5_5_US' }));
    const grantPath = writeJson('grant-g51.json', { ...goodGrant, grantId: 'grant-g51' });
    const result = await runModule.runCampaign({ ...base({ stage: 'pilot', fetchImpl: probeFetch().fetchImpl, grantPath }), candidate: undefined, candidates: ['OPUS_5_5_US', 'SONNET_5_5_US'], limit: 2, latchPath: join(work, 'g51-latch.json'), outRoot: join(work, 'g51-out'), seamModule: seamPath });
    assert.deepEqual(result.refusals, []);
    assert.ok(result.outDir !== null && result.summary !== null);
    const order = readFileSync(join(result.outDir, 'seam-calls.txt'), 'utf8').split('\n').filter((line) => line !== '');
    const firstOpus = order.indexOf('claude-opus-5-5');
    assert.ok(firstOpus > 0, 'Opus was measured after Sonnet, though named first');
    assert.ok(order.slice(0, firstOpus).every((model) => model === 'claude-sonnet-5-5') && order.slice(firstOpus).every((model) => model === 'claude-opus-5-5'), 'every Sonnet request precedes every Opus request');
    const summary = result.summary as { stopped: string | null; candidates: Record<string, { complete: boolean; stopped: string | null; runs?: unknown[]; measured: { requests: number } | null }> };
    assert.equal(summary.stopped, 'HARD_GATE_VIOLATION');
    const sonnet = summary.candidates['SONNET_5_5_US'];
    const opus = summary.candidates['OPUS_5_5_US'];
    assert.equal(sonnet?.complete, true, 'Sonnet\'s two passes completed before Opus ran');
    assert.equal(sonnet?.runs?.length, 2);
    assert.ok((sonnet?.measured?.requests ?? 0) > 0, 'and its measurement is kept');
    assert.equal(opus?.complete, false);
    assert.equal(opus?.stopped, 'HARD_GATE_VIOLATION');
    assert.ok(existsSync(join(result.outDir, 'SONNET_5_5_US', 'pass-2', 'report.json')), 'Sonnet\'s measured pass is on disk');
  });
});

describe('B04-CAMPAIGN: offline runs are proven by replay (SIMULATED, no network)', () => {
  it('R2-039 offline replay: a sealed fixture is offline only if the core decides it with zero requests behind a send-refusing transport; the qualification path replays every fixture the records name and refuses a declared offline fixture that would send', { timeout: 600_000 }, async () => {
    const replayModule = (await import(toolUrl('offline-replay.mjs'))) as {
      replayOffline: (fixtures: readonly CorpusFixture[]) => Promise<{ replayed: string[]; offline: string[] }>;
      qualifyCampaignRuns: (options: { runDirs: readonly string[]; corpusDir: string }) => Promise<{ qualification: { qualified: boolean; reasons: string[] }; replay: { replayed: string[]; offline: string[] } }>;
    };
    const { loadCorpus } = (await import(toolUrl('validity-run.mjs'))) as { loadCorpus: (dir: string) => { fixtures: CorpusFixture[] } };
    const fixtures = loadCorpus(corpusDir).fixtures;
    // A small sealed subset: one fixture the deterministic core decides alone, one that asks the model.
    const subset = fixtures.filter((entry) => ['fx-adv-005-k05-clean-only', 'fx-adv-000-k00-clean-only'].includes(entry.fixture.fixtureId));
    assert.equal(subset.length, 2);
    assert.deepEqual(await replayModule.replayOffline(subset), { replayed: ['fx-adv-000-k00-clean-only', 'fx-adv-005-k05-clean-only'], offline: ['fx-adv-005-k05-clean-only'] });

    // The qualification path over the three runs of a short rehearsal: the records bind every run to its fixture and the runner's
    // offline runs are exactly the replay's (the rehearsal is SIMULATED and never qualifies for that reason, not for offline-ness).
    const rehearsal = await runModule.runCampaign({ stage: 'rehearse', corpusDir, outRoot: join(work, 'offline-rehearsal'), limit: 12 });
    assert.ok(rehearsal.outDir !== null);
    const runDirs = [1, 2, 3].map((n) => join(rehearsal.outDir as string, `run-${String(n)}`));
    const checked = await replayModule.qualifyCampaignRuns({ runDirs, corpusDir });
    assert.equal(checked.replay.replayed.length, 12, 'every fixture the records name was replayed from the sealed corpus');
    assert.ok(!checked.qualification.reasons.some((reason) => /OFFLINE|RUN_FIXTURES_NOT_BOUND/u.test(reason)), checked.qualification.reasons.join('; '));
    const record = JSON.parse(readFileSync(join(runDirs[1] as string, 'run-record.json'), 'utf8')) as { offline: { runId: string; fixtureId: string }[]; runFixtures: { runId: string; fixtureId: string }[] };
    assert.deepEqual(record.offline.map((one) => one.fixtureId).sort(), checked.replay.offline, 'the runner declared offline exactly what the replay proves');
    // Declare a fixture offline that the replay sees send: refused, even though the record's digest is intact.
    const { bindRun } = (await import('../src/benchmark/qualification.js'));
    const sender = record.runFixtures.find((one) => !checked.replay.offline.includes(one.fixtureId));
    assert.ok(sender !== undefined);
    const full = JSON.parse(readFileSync(join(runDirs[1] as string, 'run-record.json'), 'utf8')) as RunRecord;
    const receipts = readFileSync(join(runDirs[1] as string, 'receipts.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as ProtectedReceipt).filter((receipt) => receipt.runId !== sender.runId);
    const forged = bindRun(full.report, { subject: full.subject, evidence: full.evidence, receipts, offline: [...record.offline, sender], runFixtures: record.runFixtures });
    writeFileSync(join(runDirs[1] as string, 'run-record.json'), JSON.stringify(forged));
    writeFileSync(join(runDirs[1] as string, 'receipts.jsonl'), receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(''));
    const refused = await replayModule.qualifyCampaignRuns({ runDirs, corpusDir });
    assert.ok(refused.qualification.reasons.some((reason) => reason.startsWith('RUN_2_DECLARED_OFFLINE_WOULD_SEND')), refused.qualification.reasons.join('; '));
  });
});

describe('B04-CAMPAIGN: live suites (run only with B04_LIVE=1 and the output of a funded stage)', () => {
  const live = process.env['B04_LIVE'] === '1';
  const outDir = process.env['B04_LIVE_OUT'] ?? '';
  const skip = (suite: string): string | false => (live ? false : `SKIPPED_NEEDS_LIVE: ${suite} reads the recorded Vertex bytes of a funded stage (B04_LIVE=1, a campaign grant and B04_LIVE_OUT=<stage output>); none is available offline`);
  const corpusFixtures = (): CorpusFixture[] => JSON.parse(readFileSync(join(outDir, 'selection.json'), 'utf8')) as CorpusFixture[];
  const need = (): void => { assert.ok(outDir !== '' && existsSync(join(outDir, 'receipts.jsonl')), 'B04_LIVE=1 needs B04_LIVE_OUT to name a funded stage output (receipts.jsonl, scores.json, selection.json)'); };
  const load = (): { scores: FixtureScore[]; receipts: ProtectedReceipt[]; run: { evidence: string } } => ({
    scores: JSON.parse(readFileSync(join(outDir, 'scores.json'), 'utf8')) as FixtureScore[],
    receipts: readFileSync(join(outDir, 'receipts.jsonl'), 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as ProtectedReceipt),
    run: JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8')) as { evidence: string },
  });
  const suite = (id: string): void => {
    need();
    const found = load();
    assert.equal(found.run.evidence, 'EXECUTED_PROVIDER', 'a live suite reads a run of the provider, never a rehearsal');
    const audit = auditModule.auditLiveSuite(id, { evidence: found.run.evidence, corpusFixtures: corpusFixtures(), scores: found.scores, receipts: found.receipts });
    assert.ok(audit.fixtures > 0, `${id} audited no fixture`);
    assert.deepEqual(audit.problems, []);
  };

  it('IC-05 live suite: target options with employee names never reach the recorded Bedrock request bytes, headers or receipts in any mode', { skip: skip('IC-05') }, () => { suite('IC-05'); });
  it('S036 live suite: sentinels on every channel stay off the recorded Bedrock bytes, headers, receipts and logs, and the run still drafts', { skip: skip('S036') }, () => { suite('S036'); });
  it('R2-027 live suite: credentials as target options and values never appear in the recorded Bedrock bytes', { skip: skip('R2-027') }, () => { suite('R2-027'); });
  it('IC-10 live: every fixture of each qualification run is scored on the whole result and its own receipts', { skip: skip('IC-10') }, () => {
    need();
    const found = load();
    assert.equal(found.run.evidence, 'EXECUTED_PROVIDER');
    const byRun = new Set(found.receipts.filter((receipt) => receipt.kind === 'REQUEST').map((receipt) => receipt.runId));
    for (const score of found.scores) {
      assert.equal(score.scorerFailure, null, `${score.fixtureId} was not judged`);
      assert.ok(score.runId !== null && byRun.has(score.runId), `${score.fixtureId} has no receipts of its own run`);
    }
  });
});

describe('B04-CAMPAIGN: the rehearsal', () => {
  let outRoot = '';
  before(() => { outRoot = join(work, 'rehearsal-out'); });

  it('rehearsal: the whole campaign runs over the packed tarball with the recorded transport, writes three SIMULATED reports and refuses to label them QUALIFICATION evidence', { timeout: 3_600_000 }, async () => {
    const limit = process.env['B04_REHEARSAL_LIMIT'] === undefined ? null : Number(process.env['B04_REHEARSAL_LIMIT']);
    const result = await runModule.runCampaign({ stage: 'rehearse', corpusDir, outRoot, ...(limit === null ? {} : { limit }) });
    assert.deepEqual(result.refusals, []);
    assert.equal(result.ok, true);
    assert.ok(result.outDir !== null && result.summary !== null);
    const summary = result.summary as {
      evidence: string; fixtures: number; consumedFrom: { tarballSha256: string; importedPublicIndex: boolean; version: string };
      runs: { evidence: string; reportMode: string; fixtures: number; correct: number; hardGateViolations: number; scorerFailures: number; passing: boolean; receipts: number }[];
      qualification: { qualified: boolean; reasons: string[] }; labelledQualification: boolean; contamination: { scannedRequests: number; hits: number };
    };
    const expected = limit ?? 660;
    assert.equal(summary.evidence, 'SIMULATED');
    assert.equal(summary.fixtures, expected);
    assert.equal(summary.consumedFrom.importedPublicIndex, true, 'the packed tarball was installed in a clean directory and its public index imported');
    assert.match(summary.consumedFrom.tarballSha256, /^[0-9a-f]{64}$/u);
    assert.equal(summary.runs.length, 3);
    for (const run of summary.runs) {
      assert.equal(run.evidence, 'SIMULATED');
      assert.equal(run.reportMode, 'TEST_ONLY', 'a rehearsal report is never in QUALIFICATION mode');
      assert.equal(run.fixtures, expected);
      assert.equal(run.scorerFailures, 0);
      assert.equal(run.hardGateViolations, 0);
      assert.equal(run.correct, expected, 'the truth-following recorded transport reaches every sealed truth');
      assert.ok(run.receipts > 0);
    }
    assert.equal(summary.labelledQualification, false);
    // The funded runner's whole-manifest scan finds nothing in the clean requests of the sealed corpus (no false stop).
    assert.ok(summary.contamination.scannedRequests > 0);
    assert.equal(summary.contamination.hits, 0);
    assert.equal(summary.qualification.qualified, false, 'SIMULATED runs never qualify');
    assert.ok(summary.qualification.reasons.some((reason) => /NOT_EXECUTED_PROVIDER_EVIDENCE/u.test(reason)), summary.qualification.reasons.join('; '));
    process.stdout.write(`REHEARSAL ${JSON.stringify({ fixtures: summary.fixtures, correctPerRun: summary.runs.map((run) => run.correct), qualified: summary.qualification.qualified })}\n`);
  });
});
