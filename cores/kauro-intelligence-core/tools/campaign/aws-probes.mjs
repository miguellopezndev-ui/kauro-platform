// The free probes a funded Bedrock stage needs before its first paid byte (B04 mandate §4.2, owner decision A9). Every probe is
// a control-plane or documentation read: no InvokeModel, no write, no spend. Each request is signed with the temporary
// credentials (in-house SigV4) and each answer is kept as a digest with the time it was read. Live clauses stay PARTIAL until
// the AWS account exists (A9 §5); the answer shapes below are the documented ones and are confirmed on the account's first day.
//   P1 sts:GetCallerIdentity          the caller is the account the grant names
//   P2 bedrock:GetInferenceProfile    the us. profile is ACTIVE and every member region is a US region, the source region among them
//   P3 bedrock:GetFoundationModel     the member model is ACTIVE and served through an inference profile; the served-model echo is G15
//   P4 bedrock:GetModelInvocationLoggingConfiguration   OFF = 200 with no loggingConfig in the source region; any delivery refuses
//   P5 pricing:GetProducts            the AWS Price List input/output price of the model's cross-region (geo) class equals the tariff
//   P6 servicequotas:ListServiceQuotas  the cross-region RPM and TPM quotas of the model are at least the plan
//   P7 bedrock:CountTokens            skipped: not documented as free
//   P8 retention                      the AWS Bedrock data-protection page, its retrieval date and sha256, recorded by the operator
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BEDROCK_PROFILE, BEDROCK_REGIONS, OPUS_5_5_US, SONNET_5_5_US, amzDateOf, signV4 } from 'kauro-intelligence-core/benchmark';

export const PROBES = Object.freeze([
  { id: 'P1', action: 'sts:GetCallerIdentity', readOnly: true, refuses: ['ACCOUNT_NOT_READ', 'ACCOUNT_MISMATCH'] },
  { id: 'P2', action: 'bedrock:GetInferenceProfile', readOnly: true, refuses: ['PROFILE_NOT_READ', 'PROFILE_NOT_US', 'PROFILE_MISMATCH', 'PROFILE_NOT_ACTIVE'] },
  { id: 'P3', action: 'bedrock:GetFoundationModel', readOnly: true, refuses: ['MODEL_NOT_READ', 'MODEL_NOT_ACTIVE'] },
  { id: 'P4', action: 'bedrock:GetModelInvocationLoggingConfiguration', readOnly: true, refuses: ['LOGGING_NOT_READ_BACK', 'LOGGING_UNKNOWN', 'LOGGING_NOT_OFF'] },
  { id: 'P5', action: 'pricing:GetProducts', readOnly: true, refuses: ['PRICE_NOT_READ', 'PRICE_DRIFT'] },
  { id: 'P6', action: 'servicequotas:ListServiceQuotas', readOnly: true, refuses: ['QUOTA_NOT_READ', 'QUOTA_BELOW_PLAN'] },
  { id: 'P7', action: 'bedrock:CountTokens', readOnly: true, refuses: [], skipped: 'not documented as free; the smoke measures tokens instead' },
  { id: 'P8', action: 'none: the AWS Bedrock data-protection page, recorded with date and sha256', readOnly: true, refuses: ['RETENTION_NOT_RECORDED'] },
]);

export const US_REGIONS = Object.freeze(['us-east-1', 'us-east-2', 'us-west-1', 'us-west-2']);
export const PROFILES = Object.freeze({ SONNET_5_5_US, OPUS_5_5_US });
/** The display names the Price List and Service Quotas use for the models. UNVERIFIED until P5/P6 run on the account. */
export const DISPLAY_NAMES = Object.freeze({ SONNET_5_5_US: 'Claude Sonnet 5.5', OPUS_5_5_US: 'Claude Opus 5.5' });
/** The planned rate: sequential fixtures, about 4 requests a minute (mandate §4.2), each well under 25 000 tokens. */
export const PLAN = Object.freeze({ requestsPerMinute: 4, tokensPerMinute: 100_000 });
const RETENTION_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** The builder's least-privilege policy (IaC text for the owner): the five reads above and InvokeModel on the us. profiles only. */
export const LEAST_PRIVILEGE_POLICY = Object.freeze({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'KauroCampaignProbesReadOnly', Effect: 'Allow', Action: ['bedrock:GetFoundationModel', 'bedrock:GetInferenceProfile', 'bedrock:GetModelInvocationLoggingConfiguration', 'pricing:GetProducts', 'servicequotas:ListServiceQuotas'], Resource: '*' },
    {
      Sid: 'KauroCampaignInvokeUsGeographyProfiles', Effect: 'Allow', Action: ['bedrock:InvokeModel'],
      Resource: [SONNET_5_5_US, OPUS_5_5_US].flatMap((profile) => [`arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:inference-profile/${profile.inferenceProfileId}`, `arn:aws:bedrock:us-west-2:<ACCOUNT_ID>:inference-profile/${profile.inferenceProfileId}`, ...US_REGIONS.map((region) => `arn:aws:bedrock:${region}::foundation-model/${profile.inferenceProfileId.replace(/^us\./u, '')}`)]),
    },
  ],
});

/** Defence in depth only (the ledger is the cap, mandate §4.3): AWS Budgets alarms at the two grants. */
export const BUDGET_ALARMS = Object.freeze([
  { BudgetName: 'kauro-b04-a', BudgetLimit: { Amount: '40', Unit: 'USD' }, BudgetType: 'COST', TimeUnit: 'MONTHLY', CostFilters: { Service: ['Amazon Bedrock'] }, Notification: { ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE', NotificationType: 'ACTUAL' } },
  { BudgetName: 'kauro-b04-b', BudgetLimit: { Amount: '120', Unit: 'USD' }, BudgetType: 'COST', TimeUnit: 'MONTHLY', CostFilters: { Service: ['Amazon Bedrock'] }, Notification: { ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE', NotificationType: 'ACTUAL' } },
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

/** One signed control-plane request. The answer is read whole and kept only as its digest beside the parsed value. */
async function signedCall({ fetchImpl, credentials, now, region, service, method, url, headers = {}, body = '' }) {
  const signed = signV4({ method, url, headers, body, credentials, region, service, amzDate: amzDateOf(now()) });
  const { host: _host, ...send } = signed.headers;
  let response;
  try { response = await fetchImpl(url, method === 'GET' ? { method, headers: send } : { method, headers: send, body }); } catch (error) { return { status: null, text: '', value: undefined, digest: null, readAt: new Date(now()).toISOString(), failure: error instanceof Error ? error.name : 'error' }; }
  const text = await response.text();
  return { status: response.status, text, value: parse(text), digest: sha256(text), readAt: new Date(now()).toISOString(), failure: null };
}

/**
 * OFF only on the one documented shape: a record with no loggingConfig member. ON when a loggingConfig names an S3 or CloudWatch
 * destination, whatever its delivery flags say. Anything else (null, an empty or flag-only loggingConfig, an unknown member) is
 * UNKNOWN, and a stage is never admitted on UNKNOWN (D4-POL-3, Codex B04-R5).
 */
export function loggingStateOf(body) {
  const unknown = (why) => ({ state: 'UNKNOWN', reason: `the logging configuration is not a recognised shape: ${why}` });
  if (!isRecord(body)) return unknown('the answer is not a record');
  const extra = Object.keys(body).filter((key) => key !== 'loggingConfig');
  if (extra.length > 0) return unknown(`unknown member ${extra.sort().join(',')}`);
  if (!('loggingConfig' in body)) return { state: 'OFF', reason: null };
  const config = body.loggingConfig;
  if (!isRecord(config)) return unknown('loggingConfig is not a record');
  const known = ['cloudWatchConfig', 's3Config', 'textDataDeliveryEnabled', 'imageDataDeliveryEnabled', 'embeddingDataDeliveryEnabled', 'videoDataDeliveryEnabled'];
  if (isRecord(config.s3Config) || isRecord(config.cloudWatchConfig)) return { state: 'ON', reason: `delivery to ${[isRecord(config.s3Config) ? 'S3' : null, isRecord(config.cloudWatchConfig) ? 'CloudWatch' : null].filter((one) => one !== null).join(' and ')}` };
  const strange = Object.keys(config).filter((key) => !known.includes(key));
  return unknown(strange.length > 0 ? `unknown loggingConfig member ${strange.sort().join(',')}` : 'a loggingConfig with no destination');
}

const UNIT = (unit) => (/^1K tokens$/iu.test(String(unit)) ? 1_000 : /^1M tokens$/iu.test(String(unit)) ? 1_000_000 : null);
const GEO = (attributes) => Object.entries(attributes).some(([key, value]) => /cross.?region|geo/iu.test(`${key} ${String(value)}`) && /cross.?region|geo|us/iu.test(String(value)) && !/^(?:none|no|false|)$/iu.test(String(value).trim()));

/** The micro-USD per token of the model's cross-region class in the source region, from Price List products; null with the reason when not exactly one input and one output price. */
export function pricesOf(priceList, displayName, region) {
  if (!Array.isArray(priceList)) return { prices: null, reason: 'no PriceList' };
  const found = { input: [], output: [] };
  for (const text of priceList) {
    const product = typeof text === 'string' ? parse(text) : undefined;
    if (!isRecord(product) || !isRecord(product.product) || !isRecord(product.product.attributes) || !isRecord(product.terms)) return { prices: null, reason: 'a PriceList entry is not a product document' };
    const attributes = product.product.attributes;
    if (attributes.regionCode !== region) continue;
    if (!Object.values(attributes).some((value) => String(value).toLowerCase() === displayName.toLowerCase())) continue;
    const kind = `${String(attributes.inferenceType ?? '')} ${String(attributes.usagetype ?? '')}`;
    if (/batch|cache|provisioned/iu.test(kind) || !GEO(attributes)) continue;
    const direction = /input/iu.test(kind) ? 'input' : /output/iu.test(kind) ? 'output' : null;
    if (direction === null) continue;
    const dimensions = Object.values(isRecord(product.terms.OnDemand) ? product.terms.OnDemand : {}).flatMap((term) => Object.values(isRecord(term?.priceDimensions) ? term.priceDimensions : {}));
    for (const dimension of dimensions) {
      const per = UNIT(dimension?.unit);
      const usd = Number(dimension?.pricePerUnit?.USD);
      if (per === null || !Number.isFinite(usd) || usd < 0) return { prices: null, reason: `a price dimension of ${displayName} has no USD price per 1K or 1M tokens` };
      found[direction].push((usd * 1_000_000) / per);
    }
  }
  if (found.input.length !== 1 || found.output.length !== 1) return { prices: null, reason: `${String(found.input.length)} input and ${String(found.output.length)} output prices of ${displayName} (cross-region, ${region}); exactly one of each is read` };
  return { prices: { inputMicroUsdPerToken: found.input[0], outputMicroUsdPerToken: found.output[0] }, reason: null };
}

const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/**
 * Runs P1-P8 for one candidate in one source region. Returns the refusals, a record per probe ({ status: PASS | REFUSED |
 * SKIPPED | NOT_RUN, readAt, bodyDigest, ... }) and the logging read-back the stage carries as EXECUTED_PROVIDER evidence.
 * @param {{ region: string, candidate: string, awsAccountId: string, credentials: { accessKeyId: string, secretAccessKey: string, sessionToken: string }, fetchImpl: Function, now: () => number, plan?: { requestsPerMinute: number, tokensPerMinute: number }, retentionEvidence: unknown, stageStartedAt?: number }} options
 */
export async function runProbes(options) {
  const refusals = [];
  const probes = {};
  const refuse = (id, code, detail) => { refusals.push({ code, detail: `${id}: ${detail}` }); probes[id] = { ...(probes[id] ?? {}), status: 'REFUSED', code }; };
  const pass = (id, extra) => { probes[id] = { status: 'PASS', ...extra }; };
  const { region, now } = options;
  const profile = PROFILES[options.candidate];
  const display = DISPLAY_NAMES[options.candidate];
  const plan = options.plan ?? PLAN;
  const call = (args) => signedCall({ fetchImpl: options.fetchImpl, credentials: options.credentials, now, ...args });
  const read = (id, answer) => ({ readAt: answer.readAt, bodyDigest: answer.digest, httpStatus: answer.status });

  // P1: who is calling.
  const p1 = await call({ region, service: 'sts', method: 'POST', url: `https://sts.${region}.amazonaws.com/`, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' }, body: 'Action=GetCallerIdentity&Version=2011-06-15' });
  const account = p1.value?.GetCallerIdentityResponse?.GetCallerIdentityResult?.Account;
  probes.P1 = read('P1', p1);
  if (p1.status !== 200 || typeof account !== 'string') refuse('P1', 'ACCOUNT_NOT_READ', `GetCallerIdentity answered ${String(p1.status ?? p1.failure)}`);
  else if (account !== options.awsAccountId) refuse('P1', 'ACCOUNT_MISMATCH', `the caller is account ${account}, not the grant's ${options.awsAccountId}`);
  else pass('P1', { ...probes.P1, account });

  // P2: the us. geography profile and its member regions.
  const p2 = await call({ region, service: 'bedrock', method: 'GET', url: `https://bedrock.${region}.amazonaws.com/inference-profiles/${encodeURIComponent(profile.inferenceProfileId)}`, headers: { accept: 'application/json' } });
  probes.P2 = read('P2', p2);
  let foundation = null;
  if (p2.status !== 200 || !isRecord(p2.value)) refuse('P2', 'PROFILE_NOT_READ', `GetInferenceProfile answered ${String(p2.status ?? p2.failure)}`);
  else {
    const body = p2.value;
    const members = Array.isArray(body.models) ? body.models.map((model) => /^arn:aws:bedrock:([a-z0-9-]+)::foundation-model\/([A-Za-z0-9.:-]+)$/u.exec(String(model?.modelArn))) : [];
    const regions = members.map((match) => match?.[1] ?? null);
    const models = new Set(members.map((match) => match?.[2] ?? null));
    if (typeof body.inferenceProfileId !== 'string' || !BEDROCK_PROFILE.test(body.inferenceProfileId)) refuse('P2', 'PROFILE_NOT_US', `the profile ${String(body.inferenceProfileId)} is not a us. geography profile (D4-BR-1)`);
    else if (body.inferenceProfileId !== profile.inferenceProfileId) refuse('P2', 'PROFILE_MISMATCH', `the profile read back is ${body.inferenceProfileId}, not ${profile.inferenceProfileId}`);
    else if (body.status !== 'ACTIVE') refuse('P2', 'PROFILE_NOT_ACTIVE', `the profile is ${String(body.status)}`);
    else if (regions.length === 0 || regions.some((one) => one === null || !US_REGIONS.includes(one)) || !regions.includes(region) || models.size !== 1 || models.has(null)) refuse('P2', 'PROFILE_NOT_US', `member regions ${regions.map(String).join(',') || 'none'}: every one must be a US region, the source region ${region} among them, one model`);
    else {
      foundation = [...models][0];
      pass('P2', { ...probes.P2, memberRegions: regions, foundationModel: foundation, inferenceProfileArn: typeof body.inferenceProfileArn === 'string' ? body.inferenceProfileArn : null });
    }
  }

  // P3: the member model (only once P2 named it).
  if (foundation === null) probes.P3 = { status: 'NOT_RUN', reason: 'P2 named no member model' };
  else {
    const p3 = await call({ region, service: 'bedrock', method: 'GET', url: `https://bedrock.${region}.amazonaws.com/foundation-models/${encodeURIComponent(foundation)}`, headers: { accept: 'application/json' } });
    probes.P3 = read('P3', p3);
    const details = p3.value?.modelDetails;
    if (p3.status !== 200 || !isRecord(details)) refuse('P3', 'MODEL_NOT_READ', `GetFoundationModel answered ${String(p3.status ?? p3.failure)}`);
    else if (details.modelLifecycle?.status !== 'ACTIVE' || !Array.isArray(details.inferenceTypesSupported) || !details.inferenceTypesSupported.includes('INFERENCE_PROFILE')) refuse('P3', 'MODEL_NOT_ACTIVE', `the model is ${String(details.modelLifecycle?.status)} with inference types ${JSON.stringify(details.inferenceTypesSupported ?? null)}`);
    // G15: whether InvokeModel echoes the served model in the body is a documentation fact the first paid smoke request confirms; until then the gateway stops on any answer whose model is not the profile's.
    else pass('P3', { ...probes.P3, servedModelEcho: 'UNVERIFIED_G15' });
  }

  // P4: model invocation logging of the source region.
  const loggingUrl = `https://bedrock.${region}.amazonaws.com/logging/modelinvocations`;
  const p4 = await call({ region, service: 'bedrock', method: 'GET', url: loggingUrl, headers: { accept: 'application/json' } });
  probes.P4 = read('P4', p4);
  let loggingReadBack = null;
  if (p4.status !== 200 || p4.value === undefined) refuse('P4', 'LOGGING_NOT_READ_BACK', `GetModelInvocationLoggingConfiguration answered ${String(p4.status ?? p4.failure)}${p4.status === 200 ? ' with no JSON' : ''}`);
  else {
    const logging = loggingStateOf(p4.value);
    loggingReadBack = { evidenceClass: 'EXECUTED_PROVIDER', url: loggingUrl, region, candidate: options.candidate, requestResponseLogging: logging.state, bodyDigest: p4.digest, readAt: p4.readAt };
    if (logging.state === 'UNKNOWN') refuse('P4', 'LOGGING_UNKNOWN', String(logging.reason));
    else if (logging.state !== 'OFF') refuse('P4', 'LOGGING_NOT_OFF', `model invocation logging is ON (${String(logging.reason)})`);
    else pass('P4', { ...probes.P4, requestResponseLogging: 'OFF' });
  }

  // P5: the Price List against the tariff the package carries.
  const priceList = [];
  let p5 = null;
  for (let page = 0, next = null; page < 20; page += 1) {
    p5 = await call({ region: 'us-east-1', service: 'pricing', method: 'POST', url: 'https://api.pricing.us-east-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSPriceListService.GetProducts' }, body: JSON.stringify({ ServiceCode: 'AmazonBedrock', FormatVersion: 'aws_v1', MaxResults: 100, Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: region }], ...(next === null ? {} : { NextToken: next }) }) });
    if (p5.status !== 200 || !isRecord(p5.value)) break;
    if (Array.isArray(p5.value.PriceList)) priceList.push(...p5.value.PriceList);
    next = typeof p5.value.NextToken === 'string' && p5.value.NextToken !== '' ? p5.value.NextToken : null;
    if (next === null) break;
  }
  probes.P5 = read('P5', p5);
  if (p5.status !== 200 || !isRecord(p5.value)) refuse('P5', 'PRICE_NOT_READ', `GetProducts answered ${String(p5.status ?? p5.failure)}`);
  else {
    const read5 = pricesOf(priceList, display, region);
    if (read5.prices === null) refuse('P5', 'PRICE_NOT_READ', String(read5.reason));
    else if (options.stageStartedAt !== undefined && Date.parse(p5.readAt) < options.stageStartedAt) refuse('P5', 'PRICE_DRIFT', `the price was read at ${p5.readAt}, before the stage started`);
    else if (!same(read5.prices.inputMicroUsdPerToken, profile.inputMicroUsdPerToken) || !same(read5.prices.outputMicroUsdPerToken, profile.outputMicroUsdPerToken)) refuse('P5', 'PRICE_DRIFT', `the Price List says ${String(read5.prices.inputMicroUsdPerToken)}/${String(read5.prices.outputMicroUsdPerToken)} micro-USD per token, the package's tariff ${String(profile.inputMicroUsdPerToken)}/${String(profile.outputMicroUsdPerToken)}: update the constant (a new package, a new validity record) before any funded stage`);
    else pass('P5', { ...probes.P5, ...read5.prices });
  }

  // P6: the cross-region quotas of the model against the plan.
  const quotas = [];
  let p6 = null;
  for (let page = 0, next = null; page < 20; page += 1) {
    p6 = await call({ region, service: 'servicequotas', method: 'POST', url: `https://servicequotas.${region}.amazonaws.com/`, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'ServiceQuotasV20190624.ListServiceQuotas' }, body: JSON.stringify({ ServiceCode: 'bedrock', MaxResults: 100, ...(next === null ? {} : { NextToken: next }) }) });
    if (p6.status !== 200 || !isRecord(p6.value)) break;
    if (Array.isArray(p6.value.Quotas)) quotas.push(...p6.value.Quotas);
    next = typeof p6.value.NextToken === 'string' && p6.value.NextToken !== '' ? p6.value.NextToken : null;
    if (next === null) break;
  }
  probes.P6 = read('P6', p6);
  if (p6.status !== 200 || !isRecord(p6.value)) refuse('P6', 'QUOTA_NOT_READ', `ListServiceQuotas answered ${String(p6.status ?? p6.failure)}`);
  else {
    const named = (what) => quotas.filter((quota) => isRecord(quota) && String(quota.QuotaName).toLowerCase() === `cross-region model inference ${what} per minute for anthropic ${display}`.toLowerCase());
    const rpm = named('requests');
    const tpm = named('tokens');
    if (rpm.length !== 1 || tpm.length !== 1 || typeof rpm[0].Value !== 'number' || typeof tpm[0].Value !== 'number') refuse('P6', 'QUOTA_NOT_READ', `no single cross-region requests and tokens per minute quota of ${display}`);
    else if (rpm[0].Value < plan.requestsPerMinute || tpm[0].Value < plan.tokensPerMinute) refuse('P6', 'QUOTA_BELOW_PLAN', `quotas ${String(rpm[0].Value)} RPM / ${String(tpm[0].Value)} TPM below the plan ${String(plan.requestsPerMinute)} / ${String(plan.tokensPerMinute)}`);
    else pass('P6', { ...probes.P6, requestsPerMinute: rpm[0].Value, tokensPerMinute: tpm[0].Value });
  }

  probes.P7 = { status: 'SKIPPED', reason: 'CountTokens is not documented as free; the smoke measures tokens' };

  // P8: the retention statement, as the operator recorded it.
  const evidence = options.retentionEvidence;
  const retrieved = isRecord(evidence) && typeof evidence.retrievedAt === 'string' ? Date.parse(evidence.retrievedAt) : Number.NaN;
  if (!isRecord(evidence) || typeof evidence.url !== 'string' || !evidence.url.startsWith('https://docs.aws.amazon.com/bedrock/') || typeof evidence.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(evidence.sha256) || Number.isNaN(retrieved) || retrieved > now() || now() - retrieved > RETENTION_MAX_AGE_MS) refuse('P8', 'RETENTION_NOT_RECORDED', 'the AWS Bedrock data-protection page (docs.aws.amazon.com/bedrock/...), its retrieval date within 30 days and its sha256 must be recorded (R2-041)');
  else pass('P8', { url: evidence.url, retrievedAt: new Date(retrieved).toISOString(), sha256: evidence.sha256 });

  return { refusals, probes, loggingReadBack };
}

/** The retention evidence file, or null when it cannot be read. */
export function readRetentionEvidence(path) {
  if (typeof path !== 'string' || path === '') return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export { BEDROCK_REGIONS };
