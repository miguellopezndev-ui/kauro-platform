/**
 * The Vertex AI rawPredict wire for the Anthropic partner models (B04
 * D4-WIRE-1..3). Pure and offline: it maps the B03 ProviderRequest to the
 * body Vertex accepts, builds the one URL this core ever sends to, checks the
 * body against a closed member set and closed value domains, and serializes
 * canonically once. Every refusal is a TransportError BEFORE_SEND: nothing
 * was written, so the request is free. No network and no SDK here.
 */
import { canonicalJson } from '../contracts/canonical.js';
import { PROMPT_BUNDLE_V1 } from '../gateway/model-gateway.js';
import { TransportError } from '../gateway/transport-gateway.js';
import type { ProviderRequest } from '../gateway/transport-gateway.js';

export const VERTEX_ANTHROPIC_VERSION = 'vertex-2023-10-16' as const;
/** The US multi-region host and the one location this core builds; no other host or location exists in this module. */
export const VERTEX_HOST = 'aiplatform.us.rep.googleapis.com' as const;
export const VERTEX_LOCATION = 'us' as const;

export interface VertexBody {
  readonly anthropic_version: typeof VERTEX_ANTHROPIC_VERSION;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
  readonly output_config: ProviderRequest['output_config'];
  readonly tools: readonly never[];
}

const refuse = (message: string): never => {
  throw new TransportError('BEFORE_SEND', `vertex preflight: ${message}`, { code: 'VERTEX_PREFLIGHT' });
};

/** The members a B03 ProviderRequest has; any other member is refused here, never dropped (Codex B04-R6). */
const REQUEST_MEMBERS: readonly string[] = Object.freeze(['model', 'max_tokens', 'system', 'messages', 'output_config', 'tools']);

/**
 * The model goes in the URL; the Vertex version member takes its place. A request member outside the closed set is refused
 * BEFORE_SEND: copying only the known members would silently drop it before the body preflight could see it. The nested members
 * are handed over as they are, so the preflight's closed sets judge them.
 */
export function toVertexBody(request: ProviderRequest): VertexBody {
  if (!isRecord(request)) return refuse('the request is not an object');
  for (const key of Object.keys(request)) if (!REQUEST_MEMBERS.includes(key)) refuse(`the request has the member ${key}, which is outside the closed set`);
  return {
    anthropic_version: VERTEX_ANTHROPIC_VERSION,
    max_tokens: request.max_tokens,
    system: request.system,
    messages: request.messages,
    output_config: request.output_config,
    tools: request.tools,
  };
}

const PROJECT = /^[a-z](?:[a-z0-9-]{0,28}[a-z0-9])?$/u;
const MODEL = /^[a-z][a-z0-9.-]{0,63}$/u;

/** The only URL builder: literal US multi-region host, literal location, a project and a model of closed spelling. */
export function vertexUrl(project: string, model: string): string {
  if (!PROJECT.test(project)) refuse('the project id is not a Google Cloud project id');
  if (!MODEL.test(model)) refuse('the model id is not a plain model id');
  return `https://${VERTEX_HOST}/v1/projects/${project}/locations/${VERTEX_LOCATION}/publishers/anthropic/models/${model}:rawPredict`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function closed(value: unknown, members: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(value)) return refuse(`${where} is not an object`);
  for (const key of Object.keys(value)) if (!members.includes(key)) refuse(`${where} has the member ${key}, which is outside the closed set`);
  for (const key of members) if (!(key in value)) refuse(`${where} lacks the member ${key}`);
  return value;
}

/** Closed members and closed value domains; any other body never leaves the process. */
export function preflightVertexBody(body: unknown): asserts body is VertexBody {
  const record = closed(body, ['anthropic_version', 'max_tokens', 'system', 'messages', 'output_config', 'tools'], 'the body');
  if (record['anthropic_version'] !== VERTEX_ANTHROPIC_VERSION) refuse('anthropic_version is not vertex-2023-10-16');
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
export function dispatchVertex(project: string, model: string, body: unknown, write: (url: string, bytes: string) => void): { readonly url: string; readonly bytes: string } {
  preflightVertexBody(body);
  const url = vertexUrl(project, model);
  const bytes = canonicalJson(body);
  write(url, bytes);
  return { url, bytes };
}
