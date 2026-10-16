/**
 * Request and response receipts of the Vertex transport (B04 D4-RCPT-1..4).
 * A receipt has two forms. The protected form is what the host store keeps:
 * the exact request bytes, the provider's body text, the headers. The public
 * form is a projection that carries digests, counts and closed words only:
 * never a byte of a prompt, never a byte of a provider body, never a token.
 * Pure and offline.
 */
import { sha256Hex } from '../contracts/canonical.js';

/** The closed class of a non-success status; the public form names this and the digest, never the body (R2-028). */
export type ErrorClass = 'BAD_REQUEST' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'OTHER_STATUS';

export function errorClassOf(status: number): ErrorClass | null {
  if (status >= 200 && status < 300) return null;
  if (status === 400) return 'BAD_REQUEST';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status < 600) return 'SERVER_ERROR';
  return 'OTHER_STATUS';
}

/** The token is never recorded: the receipt says how many bytes it had. */
export function redactedAuthorization(token: string): string {
  return `Bearer <redacted, ${String(Buffer.byteLength(token, 'utf8'))} bytes>`;
}

export interface ReceiptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/** Protected: the exact bytes that were sent, and where. */
export interface RequestReceipt {
  readonly kind: 'REQUEST';
  readonly url: string;
  readonly method: 'POST';
  /** Header names and non-secret values; authorization appears only as redacted. */
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBytes: string;
  readonly bodySha256: string;
  readonly bodyLength: number;
  readonly idempotencyRef: string | null;
  readonly runId: string | null;
}

/** Protected: what came back. `bodyText` is the provider's own text and stays here. */
export interface ResponseReceipt {
  readonly kind: 'RESPONSE';
  readonly status: number;
  readonly errorClass: ErrorClass | null;
  /** The allowlisted response headers, verbatim. */
  readonly headers: Readonly<Record<string, string>>;
  readonly providerMessageId: string | null;
  readonly servedModel: string | null;
  readonly stopReason: string | null;
  /** On a 200: the valid counts, or USAGE_UNKNOWN. Null on any other status. */
  readonly usage: ReceiptUsage | 'USAGE_UNKNOWN' | null;
  readonly latencyMs: number;
  readonly bodyText: string;
  readonly bodyDigest: string;
  readonly bodyLength: number;
  /** True when the body stream failed before its end. */
  readonly truncated: boolean;
  readonly idempotencyRef: string | null;
  readonly runId: string | null;
}

export type ProtectedReceipt = RequestReceipt | ResponseReceipt;
/** The host's protected store. Called with protected bytes; the transport never writes them anywhere else. */
export type ReceiptSink = (receipt: ProtectedReceipt) => void;

const HEADER_ALLOW = /^(?:content-type|content-length|retry-after|date|request-id|x-request-id|x-goog-[a-z0-9-]+)$/u;

/** The response headers the receipt keeps: a short allowlist, any x-goog-* and request-id verbatim; cookies and the rest are dropped. */
export function allowedHeaders(headers: { forEach(callback: (value: string, key: string) => void): void }): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HEADER_ALLOW.test(name)) out[name] = value;
  });
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Provider ids as the journal keeps them: a short token of an id alphabet (the same rule the core's record applies). */
export const PROVIDER_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MODEL_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal']);

export function requestReceipt(input: { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly bodyBytes: string; readonly idempotencyRef: string | null; readonly runId: string | null }): RequestReceipt {
  return { kind: 'REQUEST', url: input.url, method: 'POST', headers: input.headers, bodyBytes: input.bodyBytes, bodySha256: sha256Hex(input.bodyBytes), bodyLength: Buffer.byteLength(input.bodyBytes, 'utf8'), idempotencyRef: input.idempotencyRef, runId: input.runId };
}

export function responseReceipt(input: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly bodyText: string; readonly bodyLength: number; readonly truncated: boolean; readonly latencyMs: number; readonly idempotencyRef: string | null; readonly runId: string | null }): ResponseReceipt {
  let parsed: unknown = null;
  if (input.status === 200 && !input.truncated) {
    try {
      parsed = JSON.parse(input.bodyText);
    } catch {
      parsed = null;
    }
  }
  const body = isRecord(parsed) ? parsed : null;
  let usage: ResponseReceipt['usage'] = null;
  if (input.status === 200) {
    usage = 'USAGE_UNKNOWN';
    const raw = body !== null && isRecord(body['usage']) ? body['usage'] : null;
    const inputTokens = raw === null ? null : count(raw['input_tokens']);
    const outputTokens = raw === null ? null : count(raw['output_tokens']);
    const creation = raw === null ? null : raw['cache_creation_input_tokens'] === undefined || raw['cache_creation_input_tokens'] === null ? 0 : count(raw['cache_creation_input_tokens']);
    const read = raw === null ? null : raw['cache_read_input_tokens'] === undefined || raw['cache_read_input_tokens'] === null ? 0 : count(raw['cache_read_input_tokens']);
    if (inputTokens !== null && outputTokens !== null && creation !== null && read !== null) usage = { inputTokens, outputTokens, cacheCreationInputTokens: creation, cacheReadInputTokens: read };
  }
  const id = body === null ? null : body['id'];
  const model = body === null ? null : body['model'];
  const stop = body === null ? null : body['stop_reason'];
  return {
    kind: 'RESPONSE',
    status: input.status,
    errorClass: errorClassOf(input.status),
    headers: input.headers,
    providerMessageId: typeof id === 'string' ? id : null,
    servedModel: typeof model === 'string' ? model : null,
    stopReason: typeof stop === 'string' ? stop : null,
    usage,
    latencyMs: input.latencyMs,
    bodyText: input.bodyText,
    bodyDigest: sha256Hex(input.bodyText),
    bodyLength: input.bodyLength,
    truncated: input.truncated,
    idempotencyRef: input.idempotencyRef,
    runId: input.runId,
  };
}

/** What a public reader sees of a request: digests and counts. */
export interface PublicRequestReceipt {
  readonly kind: 'REQUEST';
  readonly method: 'POST';
  readonly endpointDigest: string;
  readonly headerNames: readonly string[];
  readonly bodySha256: string;
  readonly bodyLength: number;
  readonly idempotencyRef: string | null;
  readonly runId: string | null;
}

/** What a public reader sees of a response: the status, the closed class, the digest, and only ids and words of closed spelling. */
export interface PublicResponseReceipt {
  readonly kind: 'RESPONSE';
  readonly status: number;
  readonly errorClass: ErrorClass | null;
  readonly headerNames: readonly string[];
  readonly providerMessageId: string | null;
  readonly servedModel: string | null;
  readonly stopReason: string | null;
  readonly usage: ReceiptUsage | 'USAGE_UNKNOWN' | null;
  readonly latencyMs: number;
  readonly bodyDigest: string;
  readonly bodyLength: number;
  readonly truncated: boolean;
  readonly idempotencyRef: string | null;
  readonly runId: string | null;
}

export type PublicReceipt = PublicRequestReceipt | PublicResponseReceipt;

/** The public form: nothing a provider or a prompt wrote, except ids and model names that match their closed spelling. */
export function publicProjection(receipt: ProtectedReceipt): PublicReceipt {
  if (receipt.kind === 'REQUEST') {
    return { kind: 'REQUEST', method: receipt.method, endpointDigest: sha256Hex(receipt.url), headerNames: Object.keys(receipt.headers).sort(), bodySha256: receipt.bodySha256, bodyLength: receipt.bodyLength, idempotencyRef: receipt.idempotencyRef, runId: receipt.runId };
  }
  return {
    kind: 'RESPONSE',
    status: receipt.status,
    errorClass: receipt.errorClass,
    headerNames: Object.keys(receipt.headers).sort(),
    providerMessageId: receipt.providerMessageId !== null && PROVIDER_MESSAGE_ID.test(receipt.providerMessageId) ? receipt.providerMessageId : null,
    servedModel: receipt.servedModel !== null && MODEL_ID.test(receipt.servedModel) ? receipt.servedModel : null,
    stopReason: receipt.stopReason !== null && STOP_REASONS.has(receipt.stopReason) ? receipt.stopReason : null,
    usage: receipt.usage,
    latencyMs: receipt.latencyMs,
    bodyDigest: receipt.bodyDigest,
    bodyLength: receipt.bodyLength,
    truncated: receipt.truncated,
    idempotencyRef: receipt.idempotencyRef,
    runId: receipt.runId,
  };
}

/** What the response says about the run's subject (D4-RCPT-2, S044). */
export type ResponseVerdict = 'OK' | 'WRONG_MODEL' | 'CACHE_TOKENS';

export interface Assessment {
  readonly verdict: ResponseVerdict;
  /** A wrong served model or a cache token breaks the subject the run was evaluated on. */
  readonly subjectBroken: boolean;
}

/** Served model against the profile's, and cache tokens against a request that sent no cache control. Only a 200 is assessed. */
export function assessResponse(profile: { readonly modelId: string }, receipt: ResponseReceipt): Assessment {
  if (receipt.status !== 200) return { verdict: 'OK', subjectBroken: false };
  if (receipt.servedModel !== profile.modelId) return { verdict: 'WRONG_MODEL', subjectBroken: true };
  if (receipt.usage !== null && receipt.usage !== 'USAGE_UNKNOWN' && receipt.usage.cacheCreationInputTokens + receipt.usage.cacheReadInputTokens > 0) return { verdict: 'CACHE_TOKENS', subjectBroken: true };
  return { verdict: 'OK', subjectBroken: false };
}

export interface Reconciliation {
  readonly idempotencyRef: string;
  readonly requests: number;
  readonly responses: number;
  /** The provider message id of the answer that arrived under this ref, or null when none did. */
  readonly providerMessageId: string | null;
}

/** Matches receipts to a journal entry by its idempotency ref (D4-RCPT-4). Vertex documents no idempotency key; this is the core's own ref, not an exactly-once claim. */
export function reconcileByIdempotencyRef(receipts: readonly ProtectedReceipt[], idempotencyRef: string): Reconciliation {
  const mine = receipts.filter((receipt) => receipt.idempotencyRef === idempotencyRef);
  const answers = mine.filter((receipt): receipt is ResponseReceipt => receipt.kind === 'RESPONSE' && receipt.status === 200 && receipt.providerMessageId !== null && PROVIDER_MESSAGE_ID.test(receipt.providerMessageId));
  return { idempotencyRef, requests: mine.filter((receipt) => receipt.kind === 'REQUEST').length, responses: mine.filter((receipt) => receipt.kind === 'RESPONSE').length, providerMessageId: answers[answers.length - 1]?.providerMessageId ?? null };
}
