/**
 * The Amazon Bedrock InvokeModel wire for the Anthropic models (B04 §4.1,
 * owner decision A9). Pure and offline: it maps the B03 ProviderRequest to the
 * body Bedrock accepts, builds the one URL this core ever sends to (a US
 * region, a `us.` geography inference profile: decision D4-BR-1), checks the
 * body against the same closed member set and value domains as the Vertex
 * wire, and serializes canonically once. Every refusal is a TransportError
 * BEFORE_SEND: nothing was written, so the request is free. No SDK here.
 */
import { canonicalJson } from '../contracts/canonical.js';
import { PROMPT_BUNDLE_V1 } from '../gateway/model-gateway.js';
import { TransportError } from '../gateway/transport-gateway.js';
import type { ProviderRequest } from '../gateway/transport-gateway.js';

export const BEDROCK_ANTHROPIC_VERSION = 'bedrock-2023-05-31' as const;
/**
 * The source regions a `us.` profile may be called from. us-east-1 is the default; us-west-2 only when probe P2 shows the
 * profile's source region requires it. No other region exists in this module.
 */
export const BEDROCK_REGIONS: readonly string[] = Object.freeze(['us-east-1', 'us-west-2']);
export const BEDROCK_DEFAULT_REGION = 'us-east-1' as const;
/** The US geography cross-region inference profile of an Anthropic model; never `global.`, `eu.`, `apac.` or a bare in-region id (D4-BR-1). */
export const BEDROCK_PROFILE = /^us\.anthropic\.[a-z0-9](?:[a-z0-9.-]{0,94}[a-z0-9])?(?::[0-9]{1,3})?$/u;

export interface BedrockBody {
  readonly anthropic_version: typeof BEDROCK_ANTHROPIC_VERSION;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
  readonly output_config: ProviderRequest['output_config'];
  readonly tools: readonly never[];
}

const refuse = (message: string): never => {
  throw new TransportError('BEFORE_SEND', `bedrock preflight: ${message}`, { code: 'BEDROCK_PREFLIGHT' });
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The members a B03 ProviderRequest has; any other member is refused here, never dropped (Codex B04-R6). */
const REQUEST_MEMBERS: readonly string[] = Object.freeze(['model', 'max_tokens', 'system', 'messages', 'output_config', 'tools']);

/** The model goes in the URL as the inference profile; the Bedrock version member takes its place. */
export function toBedrockBody(request: ProviderRequest): BedrockBody {
  if (!isRecord(request)) return refuse('the request is not an object');
  for (const key of Object.keys(request)) if (!REQUEST_MEMBERS.includes(key)) refuse(`the request has the member ${key}, which is outside the closed set`);
  return {
    anthropic_version: BEDROCK_ANTHROPIC_VERSION,
    max_tokens: request.max_tokens,
    system: request.system,
    messages: request.messages,
    output_config: request.output_config,
    tools: request.tools,
  };
}

export function bedrockHost(region: string): string {
  if (!BEDROCK_REGIONS.includes(region)) refuse(`the region ${JSON.stringify(region)} is not a US source region of the profile`);
  return `bedrock-runtime.${region}.amazonaws.com`;
}

/** The only URL builder: a literal US region host and a `us.anthropic.` inference profile id of closed spelling. */
export function bedrockUrl(region: string, profileId: string): string {
  const host = bedrockHost(region);
  if (!BEDROCK_PROFILE.test(profileId)) refuse('the model is not a us. geography inference profile of an Anthropic model');
  return `https://${host}/model/${encodeURIComponent(profileId)}/invoke`;
}

function closed(value: unknown, members: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(value)) return refuse(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!members.includes(key)) refuse(`${where} has the member ${key}, which is outside the closed set`);
  for (const key of members) if (!(key in value)) refuse(`${where} lacks the member ${key}`);
  return value;
}

/** Closed members and closed value domains; any other body never leaves the process. */
export function preflightBedrockBody(body: unknown): asserts body is BedrockBody {
  const record = closed(body, ['anthropic_version', 'max_tokens', 'system', 'messages', 'output_config', 'tools'], 'the body');
  if (record['anthropic_version'] !== BEDROCK_ANTHROPIC_VERSION) refuse('anthropic_version is not bedrock-2023-05-31');
  const maxTokens = record['max_tokens'];
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > PROMPT_BUNDLE_V1.providerParameters.maxOutputTokens) refuse('max_tokens is outside 1..the bundle ceiling');
  if (typeof record['system'] !== 'string' || record['system'] === '') refuse('system is not a non-empty string');
  const messages = record['messages'];
  if (!Array.isArray(messages) || messages.length !== 1) refuse('messages is not exactly one message');
  const message = closed((messages as unknown[])[0], ['role', 'content'], 'the message');
  if (message['role'] !== 'user') refuse('the message role is not user');
  if (typeof message['content'] !== 'string' || message['content'] === '') refuse('the message content is not a plain string');
  const config = closed(record['output_config'], ['format', 'effort'], 'output_config');
  if (config['effort'] !== PROMPT_BUNDLE_V1.providerParameters.outputConfig.effort) refuse('effort is not the pinned value');
  const format = closed(config['format'], ['type', 'schema'], 'output_config.format');
  if (format['type'] !== 'json_schema' || !isRecord(format['schema'])) refuse('output_config.format is not a json_schema');
  if (!Array.isArray(record['tools']) || record['tools'].length !== 0) refuse('tools is not the empty list');
}

/** Preflight, build the URL, serialize canonically once, and hand exactly those bytes to the writer. Returns what was written. */
export function dispatchBedrock(region: string, profileId: string, body: unknown, write: (url: string, bytes: string) => void): { readonly url: string; readonly bytes: string } {
  preflightBedrockBody(body);
  const url = bedrockUrl(region, profileId);
  const bytes = canonicalJson(body);
  write(url, bytes);
  return { url, bytes };
}
