/**
 * The Bedrock deployment contract against this core (Order 26A; A9 §4, D4-BR-1).
 *
 * The infrastructure states, in one document (the platform's `deploy/aws/bedrock/bedrock-contract.json`), how Bedrock will be
 * reached: Region, geography, models per capability, retention, quotas, backoff and the budget. This core already enforces each
 * of those on the wire (candidate admission, the transport's retries, the campaign grant). The check below refuses a deployment
 * document that disagrees with what the core will actually do, so the infrastructure cannot promise one thing while the core does
 * another: a profile the core does not admit, a model the owner has not granted, logging on, a wait the transport does not use, a
 * budget above the grants. Pure and offline; it makes no call and reads no clock.
 */
import { OPUS_5_5_US, SONNET_5_5_US, admitCandidate } from '../gateway/candidates.js';
import { BEDROCK_REGIONS } from './bedrock-wire.js';
import { TransportError } from '../gateway/transport-gateway.js';
import type { ProviderRequest, Transport } from '../gateway/transport-gateway.js';

export const BEDROCK_DEPLOYMENT_CONTRACT_VERSION = '1.0.0';

/** The transport's retry waits (S8) and the statuses it retries, as `api/intelligence-core.ts` uses them. */
export const BEDROCK_RETRY_WAITS_MS: readonly number[] = Object.freeze([2_000, 8_000]);
export const BEDROCK_RETRYABLE_STATUSES: readonly number[] = Object.freeze([429, 503, 529]);

/** The owner's grants (A9 §4), whole USD: B04-A for the smoke and the pilot, B04-B for the four qualification runs, Sonnet only. */
export const BEDROCK_GRANT_CAPS_USD: Readonly<Record<string, number>> = Object.freeze({ 'B04-A': 40, 'B04-B': 120 });

const US_REGION = /^us-(east|west)-[12]$/u;
const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

export function bedrockDeploymentProblems(document: unknown): readonly string[] {
  const contract = record(document);
  if (contract === null) return ['the deployment contract is not a record'];
  const problems: string[] = [];
  const need = (ok: boolean, text: string): void => {
    if (!ok) problems.push(text);
  };
  need(contract['contractVersion'] === BEDROCK_DEPLOYMENT_CONTRACT_VERSION, `contractVersion is not ${BEDROCK_DEPLOYMENT_CONTRACT_VERSION}`);
  const activation = contract['activationReference'];
  need(contract['enabled'] === false || (contract['enabled'] === true && typeof activation === 'string' && activation.trim().length >= 8), 'enabled without the owner\'s activation reference');
  need(typeof contract['sourceRegion'] === 'string' && BEDROCK_REGIONS.includes(contract['sourceRegion']), `source Region ${String(contract['sourceRegion'])} is not one the wire calls (${BEDROCK_REGIONS.join(', ')})`);
  need(contract['geography'] === 'us', 'the geography is not us (D4-BR-1)');
  const destinations = list(contract['destinationRegions']);
  need(destinations.length > 0 && destinations.every((region) => typeof region === 'string' && US_REGION.test(region)), 'a destination Region outside the US');

  const invocation = record(contract['invocation']);
  need(invocation?.['operation'] === 'InvokeModel' && invocation['streaming'] === false && invocation['wire'] === 'bedrock-2023-05-31', 'the invocation is not the core\'s non-streaming InvokeModel on bedrock-2023-05-31');

  const retention = record(contract['retention']);
  need(retention?.['invocationLogging'] === 'OFF', 'invocation logging is not OFF');
  need(retention?.['providerStoresPromptsOrOutputs'] === false, 'the provider may store prompts or outputs');

  const models = list(contract['models']).map(record);
  need(models.length > 0 && models.every((model) => model !== null), 'models is not a list of records');
  const granted = models.filter((model) => model?.['status'] === 'GRANTED');
  need(granted.length > 0, 'no granted model');
  for (const model of granted) {
    const profileId = model?.['inferenceProfileId'];
    need(model?.['candidate'] === SONNET_5_5_US.profileId && profileId === SONNET_5_5_US.inferenceProfileId, `${String(model?.['capability'])}: only ${SONNET_5_5_US.profileId} (${SONNET_5_5_US.inferenceProfileId}) is granted (A9 §4)`);
    need(admitCandidate(SONNET_5_5_US).admitted, `${SONNET_5_5_US.profileId} is not admitted by this core`);
    const grants = list(model?.['grants']);
    need(grants.length > 0 && grants.every((grant) => typeof grant === 'string' && Object.hasOwn(BEDROCK_GRANT_CAPS_USD, grant)), `${String(model?.['capability'])}: names no owner grant`);
  }
  for (const model of models.filter((m) => m?.['inferenceProfileId'] === OPUS_5_5_US.inferenceProfileId || m?.['candidate'] === OPUS_5_5_US.profileId)) {
    need(model?.['status'] === 'BLOCKED_OWNER' && list(model?.['grants']).length === 0, `${OPUS_5_5_US.profileId} is not BLOCKED_OWNER (A9 §4: Opus needs a new approval)`);
  }

  const quotas = record(contract['quotas']);
  const positive = (value: unknown, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
  need(quotas?.['maxConcurrency'] === 1, 'more than one request in flight (the campaign grant runs one at a time)');
  need(positive(quotas?.['maxRequestsPerMinute'], 60), 'requests per minute unbounded, or above 60');
  need(positive(quotas?.['maxTokensPerMinute'], 1_000_000), 'tokens per minute unbounded, or above 1,000,000');

  const backoff = record(contract['backoff']);
  const waits = list(backoff?.['waitsMs']);
  need(JSON.stringify(waits) === JSON.stringify(BEDROCK_RETRY_WAITS_MS), `the waits ${JSON.stringify(waits)} are not the transport's ${JSON.stringify(BEDROCK_RETRY_WAITS_MS)}`);
  need(backoff?.['maxAttempts'] === BEDROCK_RETRY_WAITS_MS.length + 1, `maxAttempts is not ${String(BEDROCK_RETRY_WAITS_MS.length + 1)}`);
  const statuses = list(backoff?.['retryableStatuses']);
  need(statuses.length > 0 && statuses.every((status) => typeof status === 'number' && BEDROCK_RETRYABLE_STATUSES.includes(status)), 'a retry on a status the transport does not retry');

  const budget = record(contract['budget']);
  let total = 0;
  for (const grant of list(budget?.['grants']).map(record)) {
    const id = grant?.['grantId'];
    const cap = grant?.['capUsd'];
    const known = typeof id === 'string' && Object.hasOwn(BEDROCK_GRANT_CAPS_USD, id);
    need(known && typeof cap === 'number' && cap > 0 && cap <= (BEDROCK_GRANT_CAPS_USD[id as string] ?? 0), `grant ${String(id)} is unknown or above the owner's cap`);
    need(list(grant?.['candidates']).every((candidate) => candidate === SONNET_5_5_US.profileId), `grant ${String(id)} funds a candidate other than ${SONNET_5_5_US.profileId}`);
    total += typeof cap === 'number' ? cap : 0;
  }
  const ceiling = budget?.['awsBudgetCeilingUsd'];
  need(typeof ceiling === 'number' && ceiling > 0 && ceiling <= total, 'the AWS budget ceiling is above the sum of the grants');
  return problems;
}

/**
 * Whether a host may build a live Bedrock gateway from this document. OFF unless the document is enabled, carries the owner's
 * activation reference and has no problem: the default answer, and the answer for anything malformed, is no. Nothing in this core
 * calls it on its own; the host asks before it constructs `bedrockGateway`, and a refusal names why.
 */
export function bedrockActivation(document: unknown): { readonly on: true } | { readonly on: false; readonly reasons: readonly string[] } {
  const contract = record(document);
  const problems = bedrockDeploymentProblems(document);
  if (problems.length > 0) return { on: false, reasons: problems };
  if (contract?.['enabled'] !== true) return { on: false, reasons: ['the deployment is switched off (enabled: false)'] };
  return { on: true };
}

export interface BedrockQuotas {
  readonly maxConcurrency: number;
  readonly maxRequestsPerMinute: number;
  readonly maxTokensPerMinute: number;
}

const QUOTA_WINDOW_MS = 60_000;

/** The most tokens a request can count against a per-minute quota: its text at three characters a token, rounded up, plus its output ceiling. */
export function worstCaseTokens(request: ProviderRequest): number {
  const characters = request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(characters / 3) + request.max_tokens;
}

/**
 * A transport that refuses, before a byte leaves, a send the deployment's quotas do not admit: more requests in flight than
 * `maxConcurrency`, or more requests or worst-case tokens in the last minute (by the injected clock) than the per-minute quotas.
 * The refusal is a `TransportError` at BEFORE_SEND with code `QUOTA_WINDOW`, so the gateway releases the reservation as never sent
 * and the core's bounded retry (two waits, then the task fails) decides what follows; it never queues, sleeps or sends on its own.
 */
export function quotaLimitedTransport(inner: Transport, quotas: BedrockQuotas, now: () => number): Transport {
  for (const [name, value] of Object.entries(quotas)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`quota ${name} is not a positive whole number`);
  }
  const sent: { at: number; tokens: number }[] = [];
  let inFlight = 0;
  return async (request, deadlineAt, correlation) => {
    const at = now();
    while (sent.length > 0 && (sent[0] as { at: number }).at <= at - QUOTA_WINDOW_MS) sent.shift();
    const tokens = worstCaseTokens(request);
    const used = sent.reduce((sum, entry) => sum + entry.tokens, 0);
    const refuse = (why: string): never => {
      throw new TransportError('BEFORE_SEND', `quota: ${why}`, { code: 'QUOTA_WINDOW' });
    };
    if (inFlight >= quotas.maxConcurrency) refuse(`${String(inFlight)} request(s) already in flight, at most ${String(quotas.maxConcurrency)}`);
    if (sent.length >= quotas.maxRequestsPerMinute) refuse(`${String(sent.length)} request(s) in the last minute, at most ${String(quotas.maxRequestsPerMinute)}`);
    if (used + tokens > quotas.maxTokensPerMinute) refuse(`${String(used + tokens)} worst-case tokens in the last minute, at most ${String(quotas.maxTokensPerMinute)}`);
    sent.push({ at, tokens });
    inFlight += 1;
    try {
      return await inner(request, deadlineAt, correlation);
    } finally {
      inFlight -= 1;
    }
  };
}
