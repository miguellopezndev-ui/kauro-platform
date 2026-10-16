/**
 * Hand-written answers of the AWS control-plane reads the campaign preflight
 * makes (probes P1-P6), keyed by what each request asks. SIMULATED: written
 * from the documented API shapes (STS GetCallerIdentity, Bedrock
 * GetInferenceProfile / GetFoundationModel / GetModelInvocationLoggingConfiguration,
 * Price List GetProducts, Service Quotas ListServiceQuotas); the live shapes
 * are confirmed on the account's first day. No network.
 */
export type ProbeId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

export interface ProbeReply {
  readonly status: number;
  readonly body: unknown;
}

export interface ProbeCall {
  readonly probe: ProbeId | 'OTHER';
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type ProbeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

export const ACCOUNT = '111122223333';

const priceProduct = (model: string, direction: 'input' | 'output', usd: string, unit = '1K tokens', geo = 'Cross-region (US)'): string => JSON.stringify({
  product: { productFamily: 'Amazon Bedrock', attributes: { servicecode: 'AmazonBedrock', regionCode: 'us-east-1', model, inferenceType: direction === 'input' ? 'Input tokens' : 'Output tokens', usagetype: `USE1-${model.replaceAll(' ', '')}-${direction}-tokens`, crossRegionInference: geo } },
  terms: { OnDemand: { 'SIMULATED.TERM': { priceDimensions: { 'SIMULATED.TERM.DIM': { unit, pricePerUnit: { USD: usd }, description: `SIMULATED ${model} ${direction}` } } } } },
});

/** The answers of a healthy account: Sonnet and Opus 5.5 behind us. profiles of US member regions, logging off, list prices equal to the planning tariffs, quotas above plan. */
export function goodReplies(profileId = 'us.anthropic.claude-sonnet-5-5', foundation = 'anthropic.claude-sonnet-5-5', display = 'Claude Sonnet 5.5', prices: readonly [string, string] = ['0.0022', '0.011']): Record<ProbeId, ProbeReply> {
  return {
    P1: { status: 200, body: { GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_KauroCampaign/builder`, UserId: 'AROASIMULATED:builder' }, ResponseMetadata: { RequestId: 'simulated-sts' } } } },
    P2: { status: 200, body: { inferenceProfileId: profileId, inferenceProfileName: `US ${display}`, inferenceProfileArn: `arn:aws:bedrock:us-east-1:${ACCOUNT}:inference-profile/${profileId}`, status: 'ACTIVE', type: 'SYSTEM_DEFINED', models: ['us-east-1', 'us-east-2', 'us-west-2'].map((region) => ({ modelArn: `arn:aws:bedrock:${region}::foundation-model/${foundation}` })) } },
    P3: { status: 200, body: { modelDetails: { modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${foundation}`, modelId: foundation, modelName: display, providerName: 'Anthropic', inferenceTypesSupported: ['INFERENCE_PROFILE'], modelLifecycle: { status: 'ACTIVE' } } } },
    P4: { status: 200, body: {} },
    P5: { status: 200, body: { FormatVersion: 'aws_v1', PriceList: [priceProduct(display, 'input', prices[0]), priceProduct(display, 'output', prices[1]), priceProduct(display, 'input', '0.0011', '1K tokens', 'None'), priceProduct('Claude Haiku 5.5', 'input', '0.0001')] } },
    P6: { status: 200, body: { Quotas: [
      { ServiceCode: 'bedrock', QuotaCode: 'L-SIM00001', QuotaName: `Cross-region model inference requests per minute for Anthropic ${display}`, Value: 200, Unit: 'None', Adjustable: true },
      { ServiceCode: 'bedrock', QuotaCode: 'L-SIM00002', QuotaName: `Cross-region model inference tokens per minute for Anthropic ${display}`, Value: 2_000_000, Unit: 'None', Adjustable: true },
      { ServiceCode: 'bedrock', QuotaCode: 'L-SIM00003', QuotaName: 'On-demand model inference requests per minute for Anthropic Claude Haiku 5.5', Value: 1, Unit: 'None', Adjustable: true },
    ] } },
  };
}

/** Which probe a request is, from its host, path and X-Amz-Target. */
export function probeOf(url: string, headers: Readonly<Record<string, string>>): ProbeId | 'OTHER' {
  const target = headers['x-amz-target'] ?? '';
  if (/^https:\/\/sts\.[a-z0-9-]+\.amazonaws\.com\/$/u.test(url)) return 'P1';
  if (/^https:\/\/bedrock\.[a-z0-9-]+\.amazonaws\.com\/inference-profiles\//u.test(url)) return 'P2';
  if (/^https:\/\/bedrock\.[a-z0-9-]+\.amazonaws\.com\/foundation-models\//u.test(url)) return 'P3';
  if (/^https:\/\/bedrock\.[a-z0-9-]+\.amazonaws\.com\/logging\/modelinvocations$/u.test(url)) return 'P4';
  if (url === 'https://api.pricing.us-east-1.amazonaws.com/' && target === 'AWSPriceListService.GetProducts') return 'P5';
  if (/^https:\/\/servicequotas\.[a-z0-9-]+\.amazonaws\.com\/$/u.test(url) && target === 'ServiceQuotasV20190624.ListServiceQuotas') return 'P6';
  return 'OTHER';
}

const SONNET = goodReplies();
const OPUS = goodReplies('us.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5', 'Claude Opus 5.5', ['0.0044', '0.022']);
/** A healthy account serving both candidates: each profile and model answered for itself, prices and quotas listing both. */
function bothModels(url: string, probe: ProbeId): ProbeReply {
  const opus = /opus/u.test(url);
  if (probe === 'P2' || probe === 'P3') return (opus ? OPUS : SONNET)[probe];
  if (probe === 'P5') return { status: 200, body: { ...(SONNET.P5.body as object), PriceList: [...(SONNET.P5.body as { PriceList: string[] }).PriceList, ...(OPUS.P5.body as { PriceList: string[] }).PriceList.slice(0, 2)] } };
  if (probe === 'P6') return { status: 200, body: { Quotas: [...(SONNET.P6.body as { Quotas: unknown[] }).Quotas, ...(OPUS.P6.body as { Quotas: unknown[] }).Quotas.slice(0, 2)] } };
  return SONNET[probe];
}

/** A fetch that answers each probe from `base` (a healthy account serving both candidates unless given) with `overrides` on top, and records every call. */
export function probeFetch(overrides: Partial<Record<ProbeId, ProbeReply>> = {}, base: Record<ProbeId, ProbeReply> | null = null): { readonly fetchImpl: ProbeFetch; readonly calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const fetchImpl: ProbeFetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
    const probe = probeOf(url, headers);
    calls.push({ probe, url, method: init.method, headers, body: init.body ?? '' });
    const reply = probe === 'OTHER' ? { status: 404, body: { message: 'SIMULATED: not a probe' } } : overrides[probe] ?? (base === null ? bothModels(url, probe) : base[probe]);
    return { status: reply.status, text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)) };
  };
  return { fetchImpl, calls };
}
