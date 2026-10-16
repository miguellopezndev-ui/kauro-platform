/**
 * B04-BEDROCK-PREFLIGHT: the free control-plane probes P1-P8 a funded stage needs before its first paid byte (mandate §4.2,
 * owner decision A9). Every answer is a hand-written SIMULATED shape (test/support/bedrock-probes.ts); the live clause stays
 * PARTIAL until the AWS account exists (A9 §5). No network, no spend.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { digestOf } from '../src/contracts/canonical.js';
import { ACCOUNT, goodReplies, probeFetch } from './support/bedrock-probes.js';
import type { ProbeCall } from './support/bedrock-probes.js';

const root = join(import.meta.dirname, '..', '..');
const toolUrl = (name: string): string => pathToFileURL(join(root, 'tools', 'campaign', name)).href;

interface Refusal { readonly code: string; readonly detail: string }
interface Preflight { readonly ok: boolean; readonly refusals: readonly Refusal[]; readonly loggingReadBack: { readonly requestResponseLogging: string; readonly evidenceClass: string } | null; readonly probes: Record<string, { readonly status: string; readonly readAt?: string; readonly bodyDigest?: string }> | null }
const preflightModule = (await import(toolUrl('preflight.mjs'))) as { preflight: (options: Record<string, unknown>) => Promise<Preflight> };
const probesModule = (await import(toolUrl('aws-probes.mjs'))) as { PROBES: readonly { id: string; action: string; readOnly: boolean }[]; LEAST_PRIVILEGE_POLICY: { Statement: { Action: string[] }[] } };
const credentialsModule = (await import(toolUrl('aws-credentials.mjs'))) as { awsCredentialProvider: (options: Record<string, unknown>) => () => Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> };

const NOW = Date.parse('2026-10-12T09:00:00Z');
const work = mkdtempSync(join(tmpdir(), 'b04-bedrock-preflight-'));
after(() => { rmSync(work, { recursive: true, force: true }); });
const writeJson = (name: string, value: unknown): string => { const path = join(work, name); writeFileSync(path, JSON.stringify(value)); return path; };
const corpusDir = join(root, 'corpus');
/**
 * The probes are judged here, not the validity record (L2/L5 regenerate it on the resealed corpus): a stand-in record for the
 * current scorer and corpus that opens the funded stage, re-digested so validityRecordProblems accepts it. Test-only, in tmp.
 */
const scorerDigest = ((await import(toolUrl('validity-run.mjs'))) as { currentScorerDigest: () => string }).currentScorerDigest();
const validityPath = ((): string => {
  const { recordDigest: _old, ...committed } = JSON.parse(readFileSync(join(corpusDir, 'scorer-validity.json'), 'utf8')) as Record<string, unknown>;
  const corpusDigest = (JSON.parse(readFileSync(join(corpusDir, 'MANIFEST.json'), 'utf8')) as { corpusDigest: string }).corpusDigest;
  const body = { ...committed, scorerDigest, corpusDigest, scorerValid: true, problems: [], blockers: [], opensFundedStage: true };
  const path = join(work, 'validity-stand-in.json');
  writeFileSync(path, JSON.stringify({ ...body, recordDigest: digestOf(body) }));
  return path;
})();
const grantA = { grantId: 'B04-A', stages: ['SMOKE', 'PILOT', 'SELECTION'], capMicros: 40_000_000, expiresAt: '2026-10-19T23:59:00Z', approvalRef: 'grants.md B04-A 2026-10-05', candidates: ['SONNET_5_5_US', 'OPUS_5_5_US'], maxRuns: null };
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const credentialProvider = async (): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiresAt: string }> => ({ accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: SECRET, sessionToken: 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0091', expiresAt: '2026-10-12T10:00:00Z' });
const retention = { url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html', retrievedAt: '2026-10-12T08:00:00Z', sha256: 'a'.repeat(64) };
const base = (extra: Record<string, unknown>): Record<string, unknown> => ({ stage: 'smoke', region: 'us-east-1', candidate: 'SONNET_5_5_US', awsAccountId: ACCOUNT, grantPath: writeJson('grant-a.json', grantA), validityPath, corpusDir, latchPath: join(work, 'no-latch.json'), credentialProvider, retentionEvidencePath: writeJson('retention.json', retention), now: () => NOW, ...extra });
const codes = (result: Preflight): string[] => result.refusals.map((refusal) => refusal.code);

describe('B04-BEDROCK-PREFLIGHT: free probes before any paid call (SIMULATED shapes; live PARTIAL until the AWS account, A9 §5)', () => {
  it('S091 Bedrock: invocation logging is OFF only on a 200 read-back with no loggingConfig; any S3 or CloudWatch delivery, a failed read, a global or non-US profile, or a quota below plan refuses the stage', async () => {
    const good = probeFetch();
    const ok = await preflightModule.preflight(base({ fetchImpl: good.fetchImpl }));
    assert.deepEqual(ok.refusals, []);
    assert.equal(ok.ok, true);
    assert.equal(ok.loggingReadBack?.requestResponseLogging, 'OFF');
    assert.equal(ok.loggingReadBack?.evidenceClass, 'EXECUTED_PROVIDER');
    for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8']) assert.equal(ok.probes?.[id]?.status, 'PASS', `${id}: ${JSON.stringify(ok.probes?.[id])}`);
    assert.equal(ok.probes?.['P7']?.status, 'SKIPPED', 'CountTokens is not documented as free: skipped');
    assert.match(ok.probes?.['P4']?.bodyDigest ?? '', /^[0-9a-f]{64}$/u, 'the read-back body is kept as a digest');
    const p4 = good.calls.find((call) => call.probe === 'P4');
    assert.ok(p4 !== undefined);
    assert.equal(p4.url, 'https://bedrock.us-east-1.amazonaws.com/logging/modelinvocations', 'the logging configuration of the source region');
    assert.equal(p4.method, 'GET');
    assert.match(p4.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 Credential=ASIASIMULATEDEXAMPLE\/20261012\/us-east-1\/bedrock\/aws4_request, /u);

    const refusedBy = async (override: Partial<Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6', { status: number; body: unknown }>>): Promise<Preflight> => preflightModule.preflight(base({ fetchImpl: probeFetch(override).fetchImpl }));
    const on: unknown[] = [
      { loggingConfig: { s3Config: { bucketName: 'logs', keyPrefix: 'b' }, textDataDeliveryEnabled: true } },
      { loggingConfig: { cloudWatchConfig: { logGroupName: 'g', roleArn: 'arn:aws:iam::111122223333:role/r' }, textDataDeliveryEnabled: true } },
      { loggingConfig: { cloudWatchConfig: { logGroupName: 'g', roleArn: 'r' }, textDataDeliveryEnabled: false, imageDataDeliveryEnabled: false, embeddingDataDeliveryEnabled: false } },
    ];
    for (const body of on) {
      const result = await refusedBy({ P4: { status: 200, body } });
      assert.ok(codes(result).includes('LOGGING_NOT_OFF'), `${JSON.stringify(body)}: ${JSON.stringify(result.refusals)}`);
      assert.equal(result.ok, false);
    }
    for (const body of [{ loggingConfig: null }, { loggingConfig: {} }, { loggingConfig: { textDataDeliveryEnabled: false } }, { unrelated: true }, [], 'not json']) {
      const result = await refusedBy({ P4: { status: 200, body } });
      assert.ok(codes(result).includes('LOGGING_UNKNOWN') || codes(result).includes('LOGGING_NOT_READ_BACK'), `${JSON.stringify(body)}: ${JSON.stringify(result.refusals)}`);
      assert.equal(result.ok, false);
    }
    for (const status of [403, 404, 500]) assert.ok(codes(await refusedBy({ P4: { status, body: { message: 'denied' } } })).includes('LOGGING_NOT_READ_BACK'), String(status));
    const global = goodReplies('global.anthropic.claude-sonnet-5-5');
    assert.ok(codes(await refusedBy({ P2: global.P2 })).includes('PROFILE_NOT_US'), 'a global profile');
    const lowQuota = await refusedBy({ P6: { status: 200, body: { Quotas: [{ QuotaName: 'Cross-region model inference requests per minute for Anthropic Claude Sonnet 5.5', Value: 2 }, { QuotaName: 'Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5', Value: 2_000_000 }] } } });
    assert.ok(codes(lowQuota).includes('QUOTA_BELOW_PLAN'), JSON.stringify(lowQuota.refusals));
  });

  it('G73 DENY: a global or non-US member region profile or a quota below plan refuses', async () => {
    const replies = goodReplies();
    const p2 = replies.P2.body as { models: { modelArn: string }[] };
    const cases: [string, Record<string, { status: number; body: unknown }>, string][] = [
      ['an eu member region', { P2: { status: 200, body: { ...p2, models: [...p2.models, { modelArn: 'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-5-5' }] } } }, 'PROFILE_NOT_US'],
      ['no member region', { P2: { status: 200, body: { ...p2, models: [] } } }, 'PROFILE_NOT_US'],
      ['another profile id', { P2: { status: 200, body: { ...p2, inferenceProfileId: 'us.anthropic.claude-haiku-5-5' } } }, 'PROFILE_MISMATCH'],
      ['an inactive profile', { P2: { status: 200, body: { ...p2, status: 'LEGACY' } } }, 'PROFILE_NOT_ACTIVE'],
      ['a source region not among the members', { P2: { status: 200, body: { ...p2, models: [{ modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5-5' }] } } }, 'PROFILE_NOT_US'],
      ['a model not active', { P3: { status: 200, body: { modelDetails: { modelId: 'anthropic.claude-sonnet-5-5', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'LEGACY' } } } } }, 'MODEL_NOT_ACTIVE'],
      ['no inference profile use', { P3: { status: 200, body: { modelDetails: { modelId: 'anthropic.claude-sonnet-5-5', inferenceTypesSupported: ['PROVISIONED'], modelLifecycle: { status: 'ACTIVE' } } } } }, 'MODEL_NOT_ACTIVE'],
      ['a tokens quota below plan', { P6: { status: 200, body: { Quotas: [{ QuotaName: 'Cross-region model inference requests per minute for Anthropic Claude Sonnet 5.5', Value: 200 }, { QuotaName: 'Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5', Value: 1_000 }] } } }, 'QUOTA_BELOW_PLAN'],
      ['no quota of the model', { P6: { status: 200, body: { Quotas: [] } } }, 'QUOTA_NOT_READ'],
      ['quotas unreadable', { P6: { status: 403, body: { message: 'denied' } } }, 'QUOTA_NOT_READ'],
      ['another account', { P1: { status: 200, body: { GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: '999999999999', Arn: 'arn:aws:iam::999999999999:user/x' } } } } }, 'ACCOUNT_MISMATCH'],
    ];
    for (const [label, override, code] of cases) {
      const result = await preflightModule.preflight(base({ fetchImpl: probeFetch(override).fetchImpl }));
      assert.equal(result.ok, false, label);
      assert.ok(codes(result).includes(code), `${label}: ${JSON.stringify(result.refusals)}`);
    }
    const noAccount = await preflightModule.preflight(base({ awsAccountId: undefined, fetchImpl: probeFetch().fetchImpl }));
    assert.ok(codes(noAccount).includes('NO_AWS_ACCOUNT'), 'the account the grant names is required');
    const notUs = await preflightModule.preflight(base({ region: 'eu-west-1', fetchImpl: probeFetch().fetchImpl }));
    assert.ok(codes(notUs).includes('REGION_NOT_US'));
    const opus = await preflightModule.preflight(base({ candidate: 'OPUS_5_5_US', fetchImpl: probeFetch({}, goodReplies('us.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', ['0.0044', '0.022'])).fetchImpl }));
    assert.deepEqual(opus.refusals, [], 'the control: Opus with its own profile, prices and quotas');
  });

  it('G71 DENY: a price read older than the stage start or differing from the tariff refuses PRICE_DRIFT', async () => {
    for (const prices of [['0.0021', '0.011'], ['0.0022', '0.0115'], ['0.003', '0.015']] as const) {
      const result = await preflightModule.preflight(base({ fetchImpl: probeFetch({ P5: goodReplies('us.anthropic.claude-sonnet-5-5', 'anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', prices).P5 }).fetchImpl }));
      assert.ok(codes(result).includes('PRICE_DRIFT'), `${prices.join('/')}: ${JSON.stringify(result.refusals)}`);
    }
    const perMillion = goodReplies().P5.body as { PriceList: string[] };
    const asMillion = perMillion.PriceList.map((text) => text.replace('"unit":"1K tokens","pricePerUnit":{"USD":"0.0022"}', '"unit":"1M tokens","pricePerUnit":{"USD":"2.2"}'));
    assert.deepEqual((await preflightModule.preflight(base({ fetchImpl: probeFetch({ P5: { status: 200, body: { ...perMillion, PriceList: asMillion } } }).fetchImpl }))).refusals, [], 'the same price per million tokens is the same price');
    for (const body of [{ PriceList: [] }, { PriceList: ['not json'] }, { PriceList: [...perMillion.PriceList, perMillion.PriceList[0]] }]) {
      const result = await preflightModule.preflight(base({ fetchImpl: probeFetch({ P5: { status: 200, body } }).fetchImpl }));
      assert.ok(codes(result).includes('PRICE_NOT_READ'), `${JSON.stringify(body).slice(0, 60)}: ${JSON.stringify(result.refusals)}`);
    }
    // A price read is stamped with the preflight's own clock, at or after the stage start; an older read is never carried over.
    const fresh = await preflightModule.preflight(base({ fetchImpl: probeFetch().fetchImpl }));
    assert.equal(fresh.probes?.['P5']?.readAt, new Date(NOW).toISOString());
    const stale = await preflightModule.preflight(base({ stageStartedAt: NOW + 1, fetchImpl: probeFetch().fetchImpl }));
    assert.ok(codes(stale).includes('PRICE_DRIFT'), `a read older than the stage start: ${JSON.stringify(stale.refusals)}`);
  });

  it('P1-P8 are control-plane reads only (no InvokeModel, no write), each signed with the temporary credentials; P8 needs the dated, hashed retention page; the least-privilege policy grants exactly these reads plus InvokeModel on the us. profiles', async () => {
    const net = probeFetch();
    await preflightModule.preflight(base({ fetchImpl: net.fetchImpl }));
    const seen = new Set(net.calls.map((call: ProbeCall) => call.probe));
    assert.deepEqual([...seen].sort(), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    for (const call of net.calls) {
      assert.ok(!/bedrock-runtime|\/invoke|converse/u.test(call.url), `${call.url}: no inference call`);
      assert.equal(call.headers['x-amz-security-token'], 'SIMULATED-SESSION-TOKEN-NOT-A-SECRET-0091');
      assert.match(call.headers['authorization'] ?? '', /^AWS4-HMAC-SHA256 /u);
    }
    assert.equal(net.calls.find((call) => call.probe === 'P2')?.url, 'https://bedrock.us-east-1.amazonaws.com/inference-profiles/us.anthropic.claude-sonnet-5-5');
    assert.equal(net.calls.find((call) => call.probe === 'P3')?.url, 'https://bedrock.us-east-1.amazonaws.com/foundation-models/anthropic.claude-sonnet-5-5');
    for (const probe of probesModule.PROBES) assert.equal(probe.readOnly, true, probe.id);
    assert.deepEqual(probesModule.PROBES.map((probe) => probe.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    const actions = probesModule.LEAST_PRIVILEGE_POLICY.Statement.flatMap((statement) => statement.Action).sort();
    assert.deepEqual(actions, ['bedrock:GetFoundationModel', 'bedrock:GetInferenceProfile', 'bedrock:GetModelInvocationLoggingConfiguration', 'bedrock:InvokeModel', 'pricing:GetProducts', 'servicequotas:ListServiceQuotas'].sort());
    assert.ok(!JSON.stringify(probesModule.LEAST_PRIVILEGE_POLICY).includes('global.'), 'no global profile in the policy');
    for (const [label, evidence, code] of [
      ['no file', null, 'RETENTION_NOT_RECORDED'],
      ['another host', { ...retention, url: 'https://example.com/bedrock' }, 'RETENTION_NOT_RECORDED'],
      ['no digest', { ...retention, sha256: 'abc' }, 'RETENTION_NOT_RECORDED'],
      ['in the future', { ...retention, retrievedAt: '2026-10-13T00:00:00Z' }, 'RETENTION_NOT_RECORDED'],
      ['older than 30 days', { ...retention, retrievedAt: '2026-09-01T00:00:00Z' }, 'RETENTION_NOT_RECORDED'],
    ] as const) {
      const result = await preflightModule.preflight(base({ retentionEvidencePath: evidence === null ? join(work, 'absent.json') : writeJson(`retention-${label.replaceAll(' ', '-')}.json`, evidence), fetchImpl: probeFetch().fetchImpl }));
      assert.ok(codes(result).includes(code), `${label}: ${JSON.stringify(result.refusals)}`);
    }
    const unsigned = await preflightModule.preflight(base({ credentialProvider: async () => { throw new Error(`no session ${SECRET}`); }, fetchImpl: net.fetchImpl }));
    assert.ok(codes(unsigned).includes('NO_CREDENTIAL'));
    assert.ok(!JSON.stringify(unsigned.refusals).includes(SECRET), 'no secret in a refusal');
  });

  it('AWS credentials: temporary only, from the environment or `aws configure export-credentials`; long-term keys refused, nothing written, no secret in an error', async () => {
    const env = { AWS_ACCESS_KEY_ID: 'ASIASIMULATEDEXAMPLE', AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: 'SIMULATED-SESSION', AWS_CREDENTIAL_EXPIRATION: '2026-10-12T10:00:00Z' };
    const fromEnv = await credentialsModule.awsCredentialProvider({ env, now: () => NOW, exec: () => { throw new Error('not called'); } })();
    assert.deepEqual(fromEnv, { accessKeyId: 'ASIASIMULATEDEXAMPLE', secretAccessKey: SECRET, sessionToken: 'SIMULATED-SESSION', expiresAt: '2026-10-12T10:00:00.000Z' });
    let execs = 0;
    const exported = JSON.stringify({ Version: 1, AccessKeyId: 'ASIAEXPORTEDEXAMPLE', SecretAccessKey: SECRET, SessionToken: 'SIMULATED-EXPORTED', Expiration: '2026-10-12T10:00:00+00:00' });
    const fromCli = credentialsModule.awsCredentialProvider({ env: {}, profile: 'kauro-campaign', now: () => NOW, exec: (command: string, args: string[]) => { execs += 1; assert.equal(command, 'aws'); assert.deepEqual(args, ['configure', 'export-credentials', '--format', 'process', '--profile', 'kauro-campaign']); return exported; } });
    assert.equal((await fromCli()).accessKeyId, 'ASIAEXPORTEDEXAMPLE');
    await fromCli();
    assert.equal(execs, 1, 'cached until near expiry');
    const refusals: string[] = [];
    for (const [label, options] of [
      ['long-term env keys', { env: { AWS_ACCESS_KEY_ID: 'AKIALONGTERMEXAMPLE', AWS_SECRET_ACCESS_KEY: SECRET } }],
      ['expired env', { env: { ...env, AWS_CREDENTIAL_EXPIRATION: '2026-10-12T08:00:00Z' } }],
      ['env without expiry', { env: { AWS_ACCESS_KEY_ID: 'ASIASIMULATEDEXAMPLE', AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: 'S' } }],
      ['cli long-term', { env: {}, exec: () => JSON.stringify({ Version: 1, AccessKeyId: 'AKIALONGTERM', SecretAccessKey: SECRET }) }],
      ['cli failure', { env: {}, exec: () => { throw new Error(`aws failed ${SECRET}`); } }],
      ['cli not json', { env: {}, exec: () => `garbage ${SECRET}` }],
    ] as const) {
      await assert.rejects(credentialsModule.awsCredentialProvider({ now: () => NOW, exec: () => { throw new Error('unset'); }, ...options })(), (error: Error) => { refusals.push(`${label}: ${error.message}`); return !error.message.includes(SECRET); }, label);
    }
    assert.equal(refusals.length, 6);
    const source = readFileSync(join(root, 'tools', 'campaign', 'aws-credentials.mjs'), 'utf8');
    assert.ok(!/writeFile|appendFile|createWriteStream/u.test(source), 'the credential source writes nothing');
  });
});
