/**
 * The request builder and response parser for the Anthropic Messages shape
 * the managed partner endpoint speaks, behind an injected transport.
 *
 * IC-1 never calls a provider. The transport is a function the host injects;
 * in this repository it is only ever a fake in a test, and what the tests
 * prove is the offline shape: the request is self-contained — run, task,
 * envelope hash, policy and prompt pins travel inside the bytes, so a model
 * (or a fake that sees only those bytes) can name them back and the compiler
 * can compare them; it carries no tools, no cache, no memory, no sampling
 * parameter and no metadata (the pinned model takes only its default
 * temperature, and the Messages metadata object defines only user_id, which
 * this core has no reason to send), the pinned model, an explicit effort and
 * the structured-output schema under output_config, with the data block
 * separated from the instructions; every
 * sentence, tag and parameter around the envelope is read from
 * PROMPT_BUNDLE_V1, so the bundle hash covers the bytes a model reads and the
 * payload parser can refuse a request whose text is not the bundle's; and a
 * malformed, truncated, refused, empty, tool-calling or wrong-model response
 * is classified, never guessed at, with usage taken only when it is a valid
 * count and unknown otherwise. This is not a qualification of acceptance by
 * Google, IAM, residency, retention, parameter validity or model quality;
 * those are IC-2 evidence.
 */
import { canonicalJson, digestOf } from '../contracts/canonical.js';
import type { IntelligenceEnvelopeV1 } from '../contracts/envelope.js';
import { DEFAULT_LIMITS, parseJsonBounded, strictJsonProblems } from '../contracts/schema.js';
import { PROPOSAL_SCHEMA_VERSION } from '../contracts/versions.js';
import type { GatewayEvidenceClass, GatewayRequest, GatewayResult, GatewayUsage, ModelGateway, ProviderRequestHeaderMember } from './model-gateway.js';
import { MODEL_POLICY_V1, PROMPT_BUNDLE_HASH, PROMPT_BUNDLE_V1, candidatePolicyOfModel, isShippedCandidatePolicy } from './model-gateway.js';

/**
 * The provider object, exactly what goes on the wire. It carries no
 * `temperature` (the pinned model accepts only its default; a sampling
 * parameter would be rejected or silently ignored, and either is a request
 * nobody recorded) and no `metadata` (the Messages API defines only
 * `metadata.user_id`, an opaque end-user id for abuse detection; this core
 * sends no end user and has no reason to name one). The ledger correlation
 * travels beside the request, in TransportCorrelation, never inside it.
 */
export interface ProviderRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system: string;
  readonly messages: readonly { readonly role: 'user'; readonly content: string }[];
  /** Structured output and effort, both explicit: the pin is proven by the bytes, not by a provider default. */
  readonly output_config: { readonly format: { readonly type: 'json_schema'; readonly schema: Record<string, unknown> }; readonly effort: 'high' };
  /** Always absent: the request has no tool, cache, memory, web or file feature. Present as a literal so a test can see it. */
  readonly tools: readonly never[];
}

/**
 * What the gateway knows about a request and the provider must not: the
 * ledger correlation. It is NOT a provider idempotency or deduplication
 * guarantee — the endpoint documents none, and the only dedup this core has
 * is its own stored-response check — so it is handed to the transport for
 * its own log and never serialised into the provider object.
 */
export interface TransportCorrelation {
  readonly idempotencyRef: string;
  readonly runId: string;
}

/**
 * What a transport hands back. The body comes one of two ways: `body`, a
 * value a fake has already built, or `bodyChunks`, the raw bytes as they
 * arrived (D3-PARSE-2) — the way a provider adapter hands them over, which
 * the gateway decodes with a fatal streaming UTF-8 decoder under the byte
 * bound and reads with the strict reader. Never both.
 */
export interface ProviderResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly bodyChunks?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  /** The provider's error class where its protocol names one outside the body (Bedrock `x-amzn-ErrorType`); the body's `error.status` (Vertex) is read when this is absent. */
  readonly errorType?: string | null;
}

/** The most bytes a provider body may carry: the document bound of the strict reader. An answer under the pinned output ceiling is far below it. */
export const RESPONSE_BODY_MAX_BYTES = DEFAULT_LIMITS.maxBytes;

/**
 * The gateway's fixed words for a raw body it could not read, one per cause
 * (D3-PARSE-2). An invalid sequence, a body past the bound, a document the
 * strict reader refuses and a transport that broke its own contract are
 * billed terminal failures; a body that ended before it was complete — the
 * stream failed, the bytes stopped inside a character or inside the
 * document — is ambiguous: the provider may have billed an answer nobody
 * received.
 */
export const RAW_BODY_REASONS = Object.freeze({
  INVALID_UTF8: 'the provider body is not valid UTF-8',
  EARLY_END: 'the provider body ended before it was complete; billing is unknown',
  TOO_LARGE: 'the provider body is larger than the response byte bound',
  DUPLICATE_KEY: 'the provider body repeats a member name',
  NOT_JSON: 'the provider body is not a JSON document the strict reader accepts',
  NOT_BYTES: 'the transport handed a body chunk that is not bytes',
  TWO_BODIES: 'the transport handed both a built body and raw body chunks',
} as const);

type RawBody = { readonly kind: 'BODY'; readonly body: unknown } | { readonly kind: 'FAILED'; readonly result: GatewayResult };

/**
 * The raw body, decoded and read. The decoder is fatal and streaming: a
 * character split across two chunks is carried to the next one and decodes
 * whole, an invalid sequence throws where it stands, and no replacement
 * character is ever produced; a BOM is kept, so the strict reader refuses
 * it. The byte bound is counted as the chunks arrive.
 */
export async function readRawBody(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>, maxBytes = RESPONSE_BODY_MAX_BYTES): Promise<RawBody> {
  const failed = (kind: 'TERMINAL_FAILURE' | 'AMBIGUOUS', reason: string): RawBody => ({ kind: 'FAILED', result: kind === 'AMBIGUOUS' ? { kind, reason } : { kind, reason, usage: null } });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  let bytes = 0;
  try {
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) return failed('TERMINAL_FAILURE', RAW_BODY_REASONS.NOT_BYTES);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) return failed('TERMINAL_FAILURE', RAW_BODY_REASONS.TOO_LARGE);
      try {
        text += decoder.decode(chunk, { stream: true });
      } catch {
        return failed('TERMINAL_FAILURE', RAW_BODY_REASONS.INVALID_UTF8);
      }
    }
  } catch {
    // The stream itself failed: the rest of the body never arrived.
    return failed('AMBIGUOUS', RAW_BODY_REASONS.EARLY_END);
  }
  try {
    text += decoder.decode();
  } catch {
    // The bytes stopped inside a character.
    return failed('AMBIGUOUS', RAW_BODY_REASONS.EARLY_END);
  }
  const problems = strictJsonProblems(text);
  if (problems.some((problem) => problem.code === 'TRUNCATED')) return failed('AMBIGUOUS', RAW_BODY_REASONS.EARLY_END);
  if (problems.some((problem) => problem.code === 'DUPLICATE_KEY')) return failed('TERMINAL_FAILURE', RAW_BODY_REASONS.DUPLICATE_KEY);
  if (problems.length > 0) return failed('TERMINAL_FAILURE', RAW_BODY_REASONS.NOT_JSON);
  return { kind: 'BODY', body: JSON.parse(text) as unknown };
}

export type Transport = (request: ProviderRequest, deadlineAt: string, correlation?: TransportCorrelation) => Promise<ProviderResponse>;

/**
 * Where a transport failure happened. Only a failure the transport can vouch
 * happened before any byte left is free and retryable; after sending, or
 * when the transport cannot say, the provider may have billed the request.
 */
export type TransportStage = 'BEFORE_SEND' | 'AFTER_SEND' | 'UNKNOWN';

/** The typed failure a transport throws. A plain Error carries no stage and is treated as UNKNOWN whatever its message says. */
export class TransportError extends Error {
  readonly stage: TransportStage;
  readonly code: string | null;
  constructor(stage: TransportStage, message: string, options: { code?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TransportError';
    this.stage = stage;
    this.code = options.code ?? null;
  }
}

/** The header the model reads back: everything a proposal must name and the compiler compares, plus the pins the answer was produced under. Its members are exactly the ones the bundle's request template names. */
export type ProviderRequestHeader = { readonly [Member in ProviderRequestHeaderMember]: string };

/** What a fake may know: the header and the envelope, both recovered from the serialised request and nothing else. */
export interface ProviderRequestPayload {
  readonly runId: string;
  readonly taskId: string;
  readonly envelopeHash: string;
  readonly envelope: IntelligenceEnvelopeV1;
  readonly policyRef: { readonly modelPolicyVersion: string; readonly modelPolicyHash: string };
  readonly promptRef: { readonly promptBundleVersion: string; readonly promptBundleHash: string };
  readonly proposalSchemaVersion: string;
  readonly model: string;
}

/** The top-level members of a provider request, closed: a member outside this list — temperature, metadata, thinking, tool_choice, cache_control, stream — is not a request this build makes. */
const WIRE_MEMBERS: readonly string[] = Object.freeze(['model', 'max_tokens', 'system', 'messages', 'output_config', 'tools']);

/** The system message for a task. Every sentence comes from the bundle — role, delimitation, task, constraints, pins, identity — joined by the bundle's separator; nothing here is text of the builder's own. */
function systemFor(taskType: IntelligenceEnvelopeV1['taskType']): string {
  const bundle = PROMPT_BUNDLE_V1;
  const template = bundle.requestTemplate.system;
  return [bundle.role, bundle.delimitation, `${template.taskPrefix}${bundle.taskDefinitions[taskType]}`, `${template.constraintsPrefix}${bundle.security.join(template.constraintsSeparator)}${template.constraintsSuffix}`, template.pins, template.identity].join(template.separator);
}

/** Whether a set of member names is exactly the identity block the bundle describes: no member missing, none the template does not know. */
function isHeaderMemberSet(keys: readonly string[]): boolean {
  const members: readonly string[] = PROMPT_BUNDLE_V1.requestTemplate.requestBlock.members;
  return keys.length === members.length && members.every((member) => keys.includes(member));
}

/** A request that does not match this build's pins is refused before a byte is built: the answer would be produced under a policy nobody recorded. */
function assertPinned(request: GatewayRequest): void {
  const bundle = PROMPT_BUNDLE_V1;
  if (request.promptBundleRef.promptBundleVersion !== bundle.promptBundleVersion) throw new Error('the request names a prompt bundle this build does not carry');
  if (request.promptBundleRef.promptBundleHash !== PROMPT_BUNDLE_HASH) throw new Error('the request names a prompt bundle hash this build does not carry');
  if (request.modelPolicy.modelPolicyVersion !== MODEL_POLICY_V1.modelPolicyVersion) throw new Error('the request names a model policy this build does not carry');
  if (!isShippedCandidatePolicy(request.modelPolicy)) throw new Error('the request carries a model policy that differs from the pinned one and from every shipped candidate policy');
  if (digestOf(request.outputSchema) !== digestOf(bundle.outputSchema)) throw new Error('the request carries an output schema that is not the prompt bundle schema');
  if (request.envelopeHash !== digestOf(request.envelope)) throw new Error('the request names an envelope hash that is not the hash of its envelope');
  if (request.runId === '' || request.envelope.taskId === '') throw new Error('the request has no run or task identity');
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) throw new Error('the request has no positive output ceiling');
}

/**
 * The provider request, built from the bundle and the request and nothing
 * else: every sentence, tag and parameter on the wire is a member of
 * PROMPT_BUNDLE_V1 (and so under PROMPT_BUNDLE_HASH); the request contributes
 * only the identity values, the envelope and a ceiling the bundle's own
 * ceiling caps. The correlation ref is not on the wire: see
 * TransportCorrelation.
 */
export function buildProviderRequest(request: GatewayRequest): ProviderRequest {
  assertPinned(request);
  const bundle = PROMPT_BUNDLE_V1;
  const template = bundle.requestTemplate;
  const parameters = bundle.providerParameters;
  const header: ProviderRequestHeader = {
    runId: request.runId,
    taskId: request.envelope.taskId,
    envelopeHash: request.envelopeHash,
    modelPolicyVersion: request.modelPolicy.modelPolicyVersion,
    modelPolicyHash: digestOf(request.modelPolicy),
    promptBundleVersion: bundle.promptBundleVersion,
    promptBundleHash: PROMPT_BUNDLE_HASH,
    proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
  };
  // The identity block carries exactly the members the bundle names: a member the template does not describe is not sent under a hash that does not cover it.
  if (!isHeaderMemberSet(Object.keys(header))) throw new Error('the request block does not carry the members the prompt bundle names');
  const content = `${template.requestBlock.open}${canonicalJson(header)}${template.requestBlock.close}${template.dataBlock.open}${canonicalJson(request.envelope)}${template.dataBlock.close}${template.closing}`;
  return {
    model: request.modelPolicy.primaryModel,
    max_tokens: Math.min(request.maxOutputTokens, parameters.maxOutputTokens),
    system: systemFor(request.envelope.taskType),
    messages: [{ role: 'user', content }],
    output_config: { format: { type: parameters.outputConfig.format, schema: request.outputSchema }, effort: parameters.outputConfig.effort },
    tools: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringMember(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error(`the provider request payload has no ${key}`);
  return value;
}

function blockBetween(content: string, open: string, close: string, name: string): { readonly text: string; readonly rest: string } {
  if (!content.startsWith(open)) throw new Error(`the provider request payload does not open with a ${name} block`);
  const end = content.indexOf(close, open.length);
  if (end < 0) throw new Error(`the provider request payload has no closed ${name} block`);
  return { text: content.slice(open.length, end), rest: content.slice(end + close.length) };
}

/** A text of the request read by the strict reader (D3-PARSE-1): a repeated member name, a truncated or malformed document is refused by its closed code before any member is read. */
function strictly(text: string, what: string): unknown {
  const read = parseJsonBounded(text);
  if (read.problems.length > 0) throw new Error(`the provider request ${what} is not a document the strict reader accepts (${[...new Set(read.problems.map((problem) => problem.code ?? 'SCHEMA'))].join(', ')})`);
  return read.value;
}

/** Whether a member named `key` appears anywhere in a parsed value — at any depth, under any parent. The data block is a string at this level, so nothing inside the envelope counts. */
function hasMemberNamed(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasMemberNamed(entry, key));
  if (!isRecord(value)) return false;
  return Object.keys(value).some((member) => member === key || hasMemberNamed(value[member], key));
}

/**
 * The payload as the provider would see it, recovered from the serialised
 * request and nothing else. This is what every fake answers from: it cannot
 * see the GatewayRequest, a closure or the kernel, only these bytes. It fails
 * closed, member by member against the bundle: a header whose pins are not
 * this build's, a hash that is not the hash of the envelope it travels with,
 * a system prompt or closing instruction that is not the bundle's, an output
 * schema or ceiling outside the bundle, a missing effort, a tool, a
 * temperature, a metadata, a cache_control, a thinking or any other member
 * outside the pinned shape, or a model other than the pinned one is refused
 * rather than answered.
 */
export function parseProviderRequestPayload(request: ProviderRequest | string): ProviderRequestPayload {
  const bundle = PROMPT_BUNDLE_V1;
  const template = bundle.requestTemplate;
  const parameters = bundle.providerParameters;
  const wire: unknown = strictly(typeof request === 'string' ? request : JSON.stringify(request), 'body');
  if (!isRecord(wire)) throw new Error('the provider request is not an object');
  const model = stringMember(wire, 'model');
  const candidate = candidatePolicyOfModel(model);
  if (candidate === null) throw new Error(`the provider request names model ${model}, not the pinned ${MODEL_POLICY_V1.primaryModel} or a shipped candidate`);
  if (!Array.isArray(wire['tools']) || wire['tools'].length !== 0) throw new Error('the provider request carries tools');
  const foreign = Object.keys(wire).filter((key) => !WIRE_MEMBERS.includes(key));
  if (foreign.length > 0) throw new Error(`the provider request carries a member outside the pinned shape: ${foreign.sort().join(', ')}`);
  if (hasMemberNamed(wire, 'cache_control')) throw new Error('the provider request carries a cache_control member; the prompt cache is off');
  const ceiling = wire['max_tokens'];
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling <= 0 || ceiling > parameters.maxOutputTokens) throw new Error(`the provider request carries an output ceiling outside the bundle (1..${String(parameters.maxOutputTokens)})`);
  const output = wire['output_config'];
  if (!isRecord(output) || output['effort'] !== parameters.outputConfig.effort) throw new Error('the provider request does not pin effort under output_config');
  const format = output['format'];
  if (!isRecord(format) || format['type'] !== parameters.outputConfig.format || !isRecord(format['schema'])) throw new Error(`the provider request does not carry a ${parameters.outputConfig.format} output format`);
  if (Object.keys(output).length !== 2 || Object.keys(format).length !== 2) throw new Error('the provider request carries an output_config member outside the pinned shape');
  if (digestOf(format['schema']) !== digestOf(bundle.outputSchema)) throw new Error('the provider request carries an output schema that is not the prompt bundle schema');
  const messages = wire['messages'];
  if (!Array.isArray(messages) || messages.length !== 1 || !isRecord(messages[0]) || messages[0]['role'] !== 'user' || typeof messages[0]['content'] !== 'string' || Object.keys(messages[0]).length !== 2) throw new Error('the provider request does not carry exactly one user message');
  const requestBlock = blockBetween(messages[0]['content'], template.requestBlock.open, template.requestBlock.close, 'request');
  const dataBlock = blockBetween(requestBlock.rest, template.dataBlock.open, template.dataBlock.close, 'data');
  if (dataBlock.rest !== template.closing) throw new Error('the provider request does not close with the prompt bundle instruction');
  const header: unknown = strictly(requestBlock.text, 'request block');
  if (!isRecord(header)) throw new Error('the request block is not an object');
  const envelope: unknown = strictly(dataBlock.text, 'data block');
  if (!isRecord(envelope)) throw new Error('the data block is not an object');
  const runId = stringMember(header, 'runId');
  const taskId = stringMember(header, 'taskId');
  const envelopeHash = stringMember(header, 'envelopeHash');
  const policyRef = { modelPolicyVersion: stringMember(header, 'modelPolicyVersion'), modelPolicyHash: stringMember(header, 'modelPolicyHash') };
  const promptRef = { promptBundleVersion: stringMember(header, 'promptBundleVersion'), promptBundleHash: stringMember(header, 'promptBundleHash') };
  const proposalSchemaVersion = stringMember(header, 'proposalSchemaVersion');
  if (!isHeaderMemberSet(Object.keys(header))) throw new Error('the request block carries a member the prompt bundle does not name');
  if (policyRef.modelPolicyVersion !== MODEL_POLICY_V1.modelPolicyVersion || policyRef.modelPolicyHash !== digestOf(candidate)) throw new Error('the request block names a model policy this build does not carry');
  if (promptRef.promptBundleVersion !== PROMPT_BUNDLE_V1.promptBundleVersion || promptRef.promptBundleHash !== PROMPT_BUNDLE_HASH) throw new Error('the request block names a prompt bundle this build does not carry');
  if (proposalSchemaVersion !== PROPOSAL_SCHEMA_VERSION) throw new Error('the request block names a proposal schema this build does not carry');
  if (digestOf(envelope) !== envelopeHash) throw new Error('the request block names an envelope hash that is not the hash of the data block');
  if (envelope['taskId'] !== taskId) throw new Error('the request block names a task that is not the task of the data block');
  const taskType = envelope['taskType'];
  if (typeof taskType !== 'string' || !Object.hasOwn(bundle.taskDefinitions, taskType)) throw new Error('the data block names a task type the prompt bundle does not define');
  if (wire['system'] !== systemFor(taskType as IntelligenceEnvelopeV1['taskType'])) throw new Error('the provider request carries a system prompt that is not the prompt bundle system for its task');
  return { runId, taskId, envelopeHash, envelope: envelope as unknown as IntelligenceEnvelopeV1, policyRef, promptRef, proposalSchemaVersion, model };
}

/** A billable count, or null: NaN, Infinity, a fraction, a negative, a non-number or an integer past MAX_SAFE_INTEGER (1e21 is not a count a ledger can add) is not a count and is never rounded into one. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Usage is either wholly valid or unknown. A record missing input or output, or carrying any malformed category, is unknown; unknown is never zero. */
function usageOf(body: Record<string, unknown>): GatewayUsage | null {
  const usage = body['usage'];
  if (!isRecord(usage)) return null;
  const input = countOf(usage['input_tokens']);
  const output = countOf(usage['output_tokens']);
  if (input === null || output === null) return null;
  const cacheCreation = usage['cache_creation_input_tokens'] === undefined || usage['cache_creation_input_tokens'] === null ? null : countOf(usage['cache_creation_input_tokens']);
  const cacheRead = usage['cache_read_input_tokens'] === undefined || usage['cache_read_input_tokens'] === null ? null : countOf(usage['cache_read_input_tokens']);
  if ((usage['cache_creation_input_tokens'] !== undefined && usage['cache_creation_input_tokens'] !== null && cacheCreation === null) || (usage['cache_read_input_tokens'] !== undefined && usage['cache_read_input_tokens'] !== null && cacheRead === null)) return null;
  return { inputTokens: input, outputTokens: output, cacheCreationInputTokens: cacheCreation, cacheReadInputTokens: cacheRead };
}

const TOOL_BLOCKS = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);

/** The provider's error class of a failed answer: the transport's (Bedrock `x-amzn-ErrorType`, cut at its first ':'), else the body's `error.status` (Vertex), else null. */
function providerErrorTypeOf(response: ProviderResponse): string | null {
  if (typeof response.errorType === 'string' && response.errorType !== '') return response.errorType.split(':')[0] ?? null;
  const error = isRecord(response.body) ? response.body['error'] : undefined;
  return isRecord(error) && typeof error['status'] === 'string' && error['status'] !== '' ? error['status'] : null;
}

/**
 * Classify a provider response. Refusals and truncations are billed
 * responses with unusable content; they are never free. Only text blocks
 * are read: a thinking block is neither content nor evidence (canon §60)
 * and is never carried past this function; a tool block is a violation of
 * a request that offered no tools.
 */
export function parseProviderResponse(response: ProviderResponse, modelId: string): GatewayResult {
  if (response.status === 429) {
    // A 429 that reports usage was billed; one whose usage member is there but unreadable names no error class, so two contradicting witnesses release nothing (S11).
    const body = isRecord(response.body) ? response.body : null;
    const usage = body === null ? null : usageOf(body);
    const usageClaimed = body !== null && body['usage'] !== undefined && body['usage'] !== null;
    return { kind: 'RETRYABLE_FAILURE', reason: 'provider status 429', usage, retryAfterMs: response.retryAfterMs ?? null, status: 429, providerErrorType: usageClaimed && usage === null ? null : providerErrorTypeOf(response) };
  }
  if (response.status === 503 || response.status === 529) return { kind: 'RETRYABLE_FAILURE', reason: `provider status ${String(response.status)}`, usage: null, retryAfterMs: response.retryAfterMs ?? null, status: response.status, providerErrorType: providerErrorTypeOf(response) };
  if (response.status >= 500) return { kind: 'RETRYABLE_FAILURE', reason: `provider status ${String(response.status)}`, usage: null, retryAfterMs: null, status: response.status, providerErrorType: providerErrorTypeOf(response) };
  if (response.status === 408) return { kind: 'AMBIGUOUS', reason: 'the provider timed out after the request was sent; billing is unknown' };
  if (response.status !== 200) return { kind: 'TERMINAL_FAILURE', reason: `provider status ${String(response.status)}`, usage: null };
  if (!isRecord(response.body)) return { kind: 'TERMINAL_FAILURE', reason: 'the provider answered 200 with no object body', usage: null };
  const body = response.body;
  const usage = usageOf(body);
  const requestId = response.requestId ?? (typeof body['id'] === 'string' && body['id'] !== '' ? body['id'] : null);
  if (body['model'] !== modelId) return { kind: 'TERMINAL_FAILURE', reason: `the provider answered with model ${body['model'] === undefined ? 'unnamed' : String(body['model'])}, not the pinned ${modelId}`, usage };
  const stop = body['stop_reason'];
  if (typeof stop !== 'string') return { kind: 'TERMINAL_FAILURE', reason: 'the provider answered with no stop_reason', usage };
  const content = body['content'];
  if (!Array.isArray(content)) return { kind: 'TERMINAL_FAILURE', reason: 'the provider answered with no content list', usage };
  const blocks = content.filter(isRecord);
  if (stop === 'tool_use' || blocks.some((block) => typeof block['type'] === 'string' && TOOL_BLOCKS.has(block['type']))) return { kind: 'TERMINAL_FAILURE', reason: 'the provider answered with a tool call to a request that offered no tools', usage };
  if (stop === 'pause_turn') return { kind: 'TERMINAL_FAILURE', reason: 'the provider paused the turn; a continuation would need provider conversation state, which no request carries', usage };
  const text = blocks.filter((block) => block['type'] === 'text' && typeof block['text'] === 'string').map((block) => block['text'] as string).join('');
  const meta = { modelId, requestId };
  if (stop === 'refusal') return { kind: 'RESPONSE', content: text, usage, stopReason: 'refusal', providerMeta: meta };
  if (stop === 'max_tokens') return { kind: 'RESPONSE', content: text, usage, stopReason: 'max_tokens', providerMeta: meta };
  if (text === '') return { kind: 'TERMINAL_FAILURE', reason: 'the provider answered with no text content', usage };
  return { kind: 'RESPONSE', content: text, usage, stopReason: stop === 'end_turn' ? 'end_turn' : 'other', providerMeta: meta };
}

/**
 * A gateway over an injected transport. The only place a provider request
 * shape exists. Its evidence class is the injector's to declare: a fake or
 * capturing transport is SIMULATED, which is also what an undeclared one is,
 * so nothing is ever presented as live by default; the provider adapter of
 * B04 declares EXECUTED_PROVIDER for the real endpoint (D3-EVC-1).
 */
export function transportGateway(transport: Transport, options: { readonly evidenceClass?: GatewayEvidenceClass } = {}): ModelGateway {
  return {
    name: 'transport',
    evidenceClass: options.evidenceClass ?? 'SIMULATED',
    async analyze(request: GatewayRequest): Promise<GatewayResult> {
      const provider = buildProviderRequest(request);
      let response: ProviderResponse;
      try {
        response = await transport(provider, request.deadlineAt, { idempotencyRef: request.idempotencyRef, runId: request.runId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only a typed failure the transport places before sending is free and retryable.
        // Anything else — after sending, stage unknown, or a plain Error whatever its
        // message says — may have been billed and stays ambiguous.
        if (error instanceof TransportError && error.stage === 'BEFORE_SEND') return { kind: 'RETRYABLE_FAILURE', reason: message, usage: null, retryAfterMs: null, neverSent: true };
        const stage = error instanceof TransportError ? error.stage : 'UNKNOWN';
        return { kind: 'AMBIGUOUS', reason: `${stage}: ${message}` };
      }
      // Raw bytes are decoded and read here (D3-PARSE-2); a status that is not 200 is classified by its status, whatever its body.
      if (response.bodyChunks !== undefined && response.status === 200) {
        if (response.body !== undefined) return { kind: 'TERMINAL_FAILURE', reason: RAW_BODY_REASONS.TWO_BODIES, usage: null };
        const raw = await readRawBody(response.bodyChunks);
        if (raw.kind === 'FAILED') return raw.result;
        return parseProviderResponse({ ...response, body: raw.body }, request.modelPolicy.primaryModel);
      }
      return parseProviderResponse(response, request.modelPolicy.primaryModel);
    },
  };
}
